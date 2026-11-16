// Web UI の画面写し（npm run ui-shots -- --out <dir> [--only <名前の一部>]。#386）。
// scripts/ui-shots-fixture.ts の作り物のデータで本物の Web サーバーを立て、playwright-core のヘッドレス Chromium で
// 決まった画面を <dir>/<幅>-<テーマ>-<状態>.png に撮る。console の error・warning・pageerror・4xx/5xx・失敗した要求は <dir>/console.log に。
// <dir> はリポジトリの外だけ（画像を repo に書かない）。Chromium は playwright-core の既定の探し方（PLAYWRIGHT_BROWSERS_PATH も効く）。
// 成功しても失敗しても（SIGINT・SIGTERM でも）ブラウザとサーバーを閉じ、一時ディレクトリを消す。env ファイルは読まない
import { existsSync, mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { basename, dirname, join, relative, resolve, isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import type { Browser, BrowserContext, Page } from "playwright-core";
import { type FixtureServer, startFixtureServer } from "./ui-shots-fixture.ts";

const USAGE = "使い方: npm run ui-shots -- --out <dir> [--only <名前の一部>]（<dir> はリポジトリの外）";
const INSTALL_HINT = "Chromium が見つからない。`npx playwright-core@1.58.2 install chromium-headless-shell` で入れる";
const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));

type Viewport = "phone" | "pc" | "tablet";
type Theme = "dark" | "light";

const VIEWPORTS: Record<Viewport, { viewport: { width: number; height: number }; deviceScaleFactor: number; isMobile?: boolean; hasTouch?: boolean }> = {
  phone: { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true },
  pc: { viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 },
  tablet: { viewport: { width: 820, height: 1180 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true },
};

/** 実在する一番近い祖先を realpath にして、残りを付け直す（まだ無い <dir> も symlink を辿って比べる） */
function realPathLoose(path: string): string {
  let head = resolve(path);
  const rest: string[] = [];
  while (!existsSync(head)) {
    const parent = dirname(head);
    if (parent === head) break;
    rest.unshift(basename(head));
    head = parent;
  }
  return join(realpathSync(head), ...rest);
}

function insideRepo(path: string): boolean {
  const rel = relative(realpathSync(REPO_ROOT), realPathLoose(path));
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

const wait = (ms: number): Promise<void> => new Promise((done) => setTimeout(done, ms));

async function shoot(browser: Browser, fixture: FixtureServer, out: string, only: string | undefined, logLines: string[]): Promise<number> {
  const base = fixture.url;
  const { open, perm, q } = fixture.topics;
  let count = 0;
  const wanted = (name: string): boolean => only === undefined || name.includes(only);

  async function contextFor(vp: Viewport, theme: Theme, label: string): Promise<{ ctx: BrowserContext; page: Page }> {
    const ctx = await browser.newContext({
      ...VIEWPORTS[vp],
      extraHTTPHeaders: { "Tailscale-User-Login": fixture.login },
      colorScheme: theme,
      locale: "ja-JP",
      timezoneId: "Asia/Tokyo",
    });
    await ctx.addInitScript((t: string) => {
      try {
        localStorage.setItem("self-agent-web:theme", t);
      } catch {}
    }, theme);
    const page = await ctx.newPage();
    page.setDefaultTimeout(6000);
    page.on("console", (m) => {
      if (m.type() === "error" || m.type() === "warning") logLines.push(`[${label}] console.${m.type()}: ${m.text()}`);
    });
    page.on("pageerror", (e) => logLines.push(`[${label}] pageerror: ${e.message}`));
    page.on("response", (r) => {
      if (r.status() >= 400) logLines.push(`[${label}] HTTP ${r.status()} ${r.request().method()} ${r.url().replace(base, "")}`);
    });
    page.on("requestfailed", (r) => logLines.push(`[${label}] requestfailed ${r.url().replace(base, "")} ${r.failure()?.errorText ?? ""}`));
    return { ctx, page };
  }

  async function shot(page: Page, name: string): Promise<void> {
    if (!wanted(name)) return;
    await wait(400);
    await page.screenshot({ path: join(out, `${name}.png`) });
    count++;
  }

  /** names のどれも --only に合わなければ飛ばす。失敗は console.log に書いて次へ */
  async function step(label: string, names: string[], fn: () => Promise<void>): Promise<void> {
    if (!names.some(wanted)) return;
    try {
      await fn();
    } catch (error) {
      logLines.push(`[shoot] ${label} に失敗: ${(error instanceof Error ? error.message : String(error)).split("\n")[0]}`);
    }
  }

  async function load(page: Page, path: string): Promise<void> {
    // hash だけ違う URL は同じ文書の移動になり、開いたダイアログが残るので毎回読み直す
    await page.goto("about:blank");
    await page.goto(base + path, { waitUntil: "load" });
    await page.waitForSelector("#v3-groups .v3-group, .v3-group", { timeout: 8000 }).catch(() => undefined);
    await wait(1200);
  }

  async function scrollBottom(page: Page): Promise<void> {
    await page.evaluate(() => {
      for (const el of document.querySelectorAll("#ed *, #ed")) {
        if (el.scrollHeight > el.clientHeight + 4 && getComputedStyle(el).overflowY !== "visible") el.scrollTop = el.scrollHeight;
      }
    });
    await wait(300);
  }

  async function newShell(vp: Viewport, theme: Theme, full: boolean): Promise<void> {
    const p = `${vp}-${theme}`;
    const names = [
      "a-list",
      "b-chat-top",
      "b-chat-middle",
      "b-chat-bottom",
      ...(full ? ["b-chat-permission", "b-chat-question", "d-composer-3lines", vp === "phone" ? "c-hand-over" : "c-hand-column", "c-hand-with-chat", "e-start-dialog", "f-settings", "f-knowledge-list", "f-knowledge-detail"] : []),
    ].map((n) => `${p}-${n}`);
    if (!names.some(wanted)) return;
    const { ctx, page } = await contextFor(vp, theme, `v3-${p}`);
    try {
      await step(`${p} a`, [`${p}-a-list`], async () => {
        await load(page, "/static/v3.html");
        await shot(page, `${p}-a-list`);
      });
      await step(`${p} b`, [`${p}-b-chat-top`, `${p}-b-chat-middle`, `${p}-b-chat-bottom`], async () => {
        await load(page, `/static/v3.html#/ch/${open}`);
        await page.waitForSelector("#ed textarea", { timeout: 5000 }).catch(() => undefined);
        await wait(800);
        await page.evaluate(() => {
          for (const el of document.querySelectorAll("#ed *")) if (el.scrollHeight > el.clientHeight + 4) el.scrollTop = 0;
        });
        await shot(page, `${p}-b-chat-top`);
        await page.evaluate(() => {
          for (const el of document.querySelectorAll("#ed *")) {
            if (el.scrollHeight > el.clientHeight + 4 && getComputedStyle(el).overflowY !== "visible") el.scrollTop = Math.round((el.scrollHeight - el.clientHeight) * 0.45);
          }
        });
        await shot(page, `${p}-b-chat-middle`);
        await scrollBottom(page);
        await shot(page, `${p}-b-chat-bottom`);
      });
      if (!full) return;
      await step(`${p} b2`, [`${p}-b-chat-permission`, `${p}-b-chat-question`], async () => {
        await load(page, `/static/v3.html#/ch/${perm}`);
        await wait(800);
        await scrollBottom(page);
        await shot(page, `${p}-b-chat-permission`);
        await load(page, `/static/v3.html#/ch/${q}`);
        await wait(800);
        await scrollBottom(page);
        await shot(page, `${p}-b-chat-question`);
      });
      await step(`${p} d`, [`${p}-d-composer-3lines`], async () => {
        await load(page, `/static/v3.html#/ch/${open}`);
        await wait(800);
        const textarea = page.locator("#ed textarea").first();
        await textarea.click();
        await textarea.fill("README の手順を見直して\n古い写真は消して\nテストも走らせて");
        await shot(page, `${p}-d-composer-3lines`);
      });
      const handName = `${p}-c-hand${vp === "phone" ? "-over" : "-column"}`;
      await step(`${p} c`, vp === "phone" ? [handName] : [handName, `${p}-c-hand-with-chat`], async () => {
        await load(page, "/static/v3.html");
        if (vp === "phone") {
          await page.click("#v3-hand-ask");
        } else {
          const expanded = await page.getAttribute("#v3-hand-show", "aria-expanded").catch(() => null);
          if (expanded !== "true") await page.click("#v3-hand-show").catch(() => undefined);
        }
        await wait(1000);
        await shot(page, handName);
        if (vp !== "phone") {
          await load(page, `/static/v3.html#/ch/${open}`);
          await wait(800);
          await shot(page, `${p}-c-hand-with-chat`);
        }
      });
      await step(`${p} e`, [`${p}-e-start-dialog`], async () => {
        await load(page, "/static/v3.html");
        await page.locator(".v3-add").first().click();
        await wait(600);
        await shot(page, `${p}-e-start-dialog`);
      });
      await step(`${p} f`, [`${p}-f-settings`, `${p}-f-knowledge-list`, `${p}-f-knowledge-detail`], async () => {
        await load(page, "/static/v3.html#/settings");
        await wait(800);
        await shot(page, `${p}-f-settings`);
        await load(page, "/static/v3.html#/knowledge");
        await wait(800);
        await shot(page, `${p}-f-knowledge-list`);
        await page.locator("#ed").getByText("CSS の container queries").first().click();
        await wait(800);
        await shot(page, `${p}-f-knowledge-detail`);
      });
    } finally {
      await ctx.close();
    }
  }

  /** 比較用の古い殻（ダークだけ） */
  async function oldShell(vp: Viewport): Promise<void> {
    const label = `old-${vp}-dark`;
    if (![`${label}-list`, `${label}-chat`].some(wanted)) return;
    const { ctx, page } = await contextFor(vp, "dark", label);
    try {
      await step(`${label} list`, [`${label}-list`], async () => {
        await page.goto(base + "/", { waitUntil: "load" });
        await wait(2000);
        await shot(page, `${label}-list`);
      });
      await step(`${label} chat`, [`${label}-chat`], async () => {
        await page.goto("about:blank");
        await page.goto(base + `/#/ch/${open}`, { waitUntil: "load" });
        await wait(2000);
        await shot(page, `${label}-chat`);
      });
    } finally {
      await ctx.close();
    }
  }

  await newShell("phone", "dark", true);
  await newShell("phone", "light", true);
  await newShell("pc", "dark", true);
  await newShell("pc", "light", false);
  await newShell("tablet", "dark", false);
  await oldShell("phone");
  await oldShell("pc");
  return count;
}

async function main(argv: string[]): Promise<number> {
  let values: { out?: string; only?: string };
  try {
    ({ values } = parseArgs({ args: argv, options: { out: { type: "string" }, only: { type: "string" } }, strict: true, allowPositionals: false }));
  } catch {
    console.error(USAGE);
    return 2;
  }
  if (values.out === undefined || values.out === "") {
    console.error(USAGE);
    return 2;
  }
  const out = resolve(values.out);
  if (insideRepo(out)) {
    console.error(`--out がリポジトリの中にある（画像を repo に書かない）。リポジトリの外のディレクトリを指す\n${USAGE}`);
    return 2;
  }
  const only = values.only;

  const logLines: string[] = [];
  let browser: Browser | undefined;
  let fixture: FixtureServer | undefined;
  let cleaning: Promise<void> | undefined;
  /** ブラウザとサーバーを閉じ、<dir> があれば console.log を書く（何度呼んでも 1 回） */
  const cleanup = (): Promise<void> =>
    (cleaning ??= (async () => {
      await browser?.close().catch(() => undefined);
      await fixture?.close().catch(() => undefined);
      if (existsSync(out)) writeFileSync(join(out, "console.log"), logLines.length === 0 ? "" : logLines.join("\n") + "\n");
    })());
  const onSignal = (signal: NodeJS.Signals): void => {
    console.error(`${signal} を受けた。ブラウザとサーバーを閉じて止める`);
    void cleanup().finally(() => process.exit(130));
  };
  process.once("SIGINT", onSignal);
  process.once("SIGTERM", onSignal);
  try {
    const { chromium } = await import("playwright-core");
    try {
      browser = await chromium.launch({ handleSIGINT: false, handleSIGTERM: false, handleSIGHUP: false });
    } catch (error) {
      console.error(INSTALL_HINT);
      console.error((error instanceof Error ? error.message : String(error)).split("\n")[0]);
      return 1;
    }
    mkdirSync(out, { recursive: true });
    fixture = await startFixtureServer({ log: (line) => logLines.push(`[server] ${line}`) });
    const count = await shoot(browser, fixture, out, only, logLines);
    console.log(`${count} 枚を撮った: ${out}`);
    return 0;
  } finally {
    await cleanup();
    process.off("SIGINT", onSignal);
    process.off("SIGTERM", onSignal);
  }
}

process.exitCode = await main(process.argv.slice(2));
