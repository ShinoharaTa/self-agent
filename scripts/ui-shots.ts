// Web UI の画面写し（npm run ui-shots -- --out <dir> [--only <名前の一部>]。#386）。
// scripts/ui-shots-fixture.ts の作り物のデータで本物の Web サーバーを立て、playwright-core のヘッドレス Chromium で
// 決まった画面を <dir>/<幅>-<テーマ>-<状態>.png に撮る。console の error・warning・pageerror・4xx/5xx・失敗した要求は <dir>/console.log に。
// <dir> はリポジトリの外だけ（画像を repo に書かない）。Chromium は playwright-core の既定の探し方（PLAYWRIGHT_BROWSERS_PATH も効く）。
// 成功しても失敗しても（SIGINT・SIGTERM・SIGHUP でも。終了コードは 130・143・129）ブラウザとサーバーを閉じ、一時ディレクトリを消す。env ファイルは読まない
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { basename, dirname, join, relative, resolve, isAbsolute, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import type { Browser, BrowserContext, Page } from "playwright-core";
import { type FixtureServer, startFixtureServer } from "./ui-shots-fixture.ts";

const USAGE = "使い方: npm run ui-shots -- --out <dir> [--only <名前の一部>]（<dir> はリポジトリの外）";
const INSTALL_HINT = "Chromium が見つからない。`npx playwright-core@1.58.2 install chromium-headless-shell` で入れる";
const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));

type Viewport = "phone" | "pc" | "tablet";
/** /api/topics の応答のうち、検査で書き換える所 */
type TopicsJson = { topics: Array<{ id?: unknown; state?: unknown; mark?: unknown; turn?: unknown; title?: unknown }>; turns: number; turnIds: unknown[] };
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

/** 根の下（根そのものを含む）か。`..shots` のような名前は中に数える */
function isUnder(root: string, path: string): boolean {
  const rel = relative(root, path);
  if (isAbsolute(rel)) return false;
  return !(rel === ".." || rel.startsWith(".." + sep));
}

/** worktree から走らせたときの本体の checkout（git の common dir の親）。git が無い・失敗したら undefined */
function mainCheckout(): string | undefined {
  const result = spawnSync("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], { cwd: REPO_ROOT, encoding: "utf8" });
  const commonDir = result.status === 0 ? result.stdout.trim() : "";
  if (commonDir === "" || !existsSync(commonDir)) return undefined;
  return realpathSync(dirname(commonDir));
}

function insideRepo(path: string): boolean {
  const target = realPathLoose(path);
  const roots = [realpathSync(REPO_ROOT), mainCheckout()].filter((root) => root !== undefined);
  return roots.some((root) => isUnder(root, target));
}

/** シグナルの慣例の終了コード（128 + 番号） */
const SIGNAL_EXIT: Record<"SIGINT" | "SIGTERM" | "SIGHUP", number> = { SIGINT: 130, SIGTERM: 143, SIGHUP: 129 };

const wait = (ms: number): Promise<void> => new Promise((done) => setTimeout(done, ms));

/** 新しい殻を撮る組（full でなければ一覧と会話の 3 枚だけ）。古い殻はダークのスマホと PC */
const NEW_SHELLS: ReadonlyArray<{ vp: Viewport; theme: Theme; full: boolean }> = [
  { vp: "phone", theme: "dark", full: true },
  { vp: "phone", theme: "light", full: true },
  { vp: "pc", theme: "dark", full: true },
  { vp: "pc", theme: "light", full: false },
  { vp: "tablet", theme: "dark", full: false },
];
const OLD_SHELLS: ReadonlyArray<Viewport> = ["phone", "pc"];

function newShellNames(vp: Viewport, theme: Theme, full: boolean): string[] {
  return [
    "a-list",
    // 幅の検査で等幅の字を当てたままの一覧（ダークのスマホ・タブレット）
    ...(theme === "dark" && vp !== "pc" ? ["a-list-mono"] : []),
    "b-chat-top",
    "b-chat-middle",
    "b-chat-bottom",
    ...(full
      ? ["b-chat-permission", "b-chat-question", "d-composer-3lines", vp === "phone" ? "c-hand-over" : "c-hand-column", ...(vp === "phone" ? [] : ["c-hand-with-chat"]), "e-start-dialog", "f-settings", "f-knowledge-list", "f-knowledge-detail"]
      : []),
  ].map((n) => `${vp}-${theme}-${n}`);
}

const oldShellNames = (vp: Viewport): string[] => [`old-${vp}-dark-list`, `old-${vp}-dark-chat`];

/** 部品の見本のページ（/static/gallery.html。K1・K2）を撮る組 */
const GALLERY_SHOTS: ReadonlyArray<{ vp: Viewport; theme: Theme }> = [
  { vp: "phone", theme: "dark" },
  { vp: "phone", theme: "light" },
  { vp: "pc", theme: "dark" },
  { vp: "pc", theme: "light" },
];
/** 見本の絵の種類（g-gallery はページ全体、g-list・g-bottom はその節の要素の絵（K3）、ほかは押して開いた所） */
const GALLERY_KINDS = ["g-gallery", "g-list", "g-bottom", "g-sheet", "g-confirm", "g-toast"] as const;
type GalleryKind = (typeof GALLERY_KINDS)[number];
const galleryName = (vp: Viewport, theme: Theme, kind: GalleryKind): string => `${vp}-${theme}-${kind}`;

/** 押せる物の当たりの下限（px。指の端末 44・PC 36。docs/plan/web-ui-components.md §9 の K2） */
const HIT_MIN: Record<Viewport, number> = { phone: 44, tablet: 44, pc: 36 };

/**
 * 当たりの測り方（ブラウザの中で動く。page.evaluate に渡すので外の変数を使わない）。scopes の中の targets の見えている物を、
 * 見える所へ送ってから箱の中心から (±d, ±d) の 4 点で elementFromPoint がその要素（か子孫）を返すかで見る（d = 下限 / 2 - 1）。
 * toast なら、知らせ（position: fixed）の下に隠れた点は数えない。足りない物の文を返す
 */
function hitProblems({ min, scopes, targets, toast }: { min: number; scopes: string; targets: string; toast: boolean }): string[] {
  const lines: string[] = [];
  const els = new Set<Element>();
  for (const scope of document.querySelectorAll(scopes)) {
    for (const el of scope.querySelectorAll(targets)) if (el.getClientRects().length > 0) els.add(el);
  }
  const d = min / 2 - 1;
  for (const el of els) {
    el.scrollIntoView({ block: "center", inline: "center" });
    const r = el.getBoundingClientRect();
    const cx = r.left + r.width / 2;
    const cy = r.top + r.height / 2;
    const points = [
      [cx - d, cy - d],
      [cx + d, cy - d],
      [cx - d, cy + d],
      [cx + d, cy + d],
    ];
    const inToast = el.closest(".c-toast") !== null;
    const ok = points.every(([x, y]) => {
      const hit = document.elementFromPoint(x ?? 0, y ?? 0);
      return hit !== null && (hit === el || el.contains(hit) || (toast && !inToast && hit.closest(".c-toast-item") !== null));
    });
    if (!ok) lines.push(`当たりが足りない: ${el.tagName.toLowerCase()}.${el.classList[0] ?? ""} ${Math.round(r.width)}x${Math.round(r.height)}`);
  }
  return lines;
}

/** 古い CSS が一覧に漏れていないかを比べる要素と性質 */
// 題は同じ状態（印の無い行）の物で比べる（未読の行の題は太い）
const LEAK_SELECTORS = ['.c-row[data-mark="none"]', '.c-row[data-mark="none"] .c-row-title', ".c-group-name", ".c-group-head", ".c-group-head > .c-iconbtn", ".c-list-label", ".c-fold-head"];
const LEAK_SELECTORS_PHONE = [".c-turn", ".c-turn-title", ".c-turn-sub"];
const LEAK_SELECTORS_PC = [".c-turns-jump"];
const LEAK_PROPS = [
  "font-size", "font-weight", "line-height", "letter-spacing", "color", "background-color", "text-align",
  "padding-top", "padding-right", "padding-bottom", "padding-left", "margin-top", "margin-right", "margin-bottom", "margin-left",
  "border-top-width", "border-bottom-width", "min-height", "box-sizing", "font-family",
];
/** 幅の検査で当てる字（仮名が全角の等幅。リポジトリの CSS は変えず、この検査の間だけ） */
const MONO_CSS = '*, *::before, *::after { font-family: "IPAGothic", "Osaka-Mono", "MS Gothic", monospace !important; }';

/** 撮る PNG の名前（拡張子なし）の全部。--only はこの中から絞る */
const ALL_SHOT_NAMES: readonly string[] = [
  ...NEW_SHELLS.flatMap(({ vp, theme, full }) => newShellNames(vp, theme, full)),
  ...OLD_SHELLS.flatMap(oldShellNames),
  ...GALLERY_SHOTS.flatMap(({ vp, theme }) => GALLERY_KINDS.map((kind) => galleryName(vp, theme, kind))),
];

async function shoot(browser: Browser, fixture: FixtureServer, out: string, only: string | undefined, logLines: string[]): Promise<{ count: number; failed: number }> {
  const base = fixture.url;
  const { open, perm, q } = fixture.topics;
  let count = 0;
  let failed = 0;
  const wanted = (name: string): boolean => only === undefined || name.includes(only);

  /** auth が false なら Tailscale-User-Login を付けない（認証の前に配られる物を撮る） */
  async function contextFor(vp: Viewport, theme: Theme, label: string, auth = true): Promise<{ ctx: BrowserContext; page: Page }> {
    const ctx = await browser.newContext({
      ...VIEWPORTS[vp],
      ...(auth ? { extraHTTPHeaders: { "Tailscale-User-Login": fixture.login } } : {}),
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

  async function shot(page: Page, name: string, fullPage = false): Promise<void> {
    if (!wanted(name)) return;
    await wait(400);
    await page.screenshot({ path: join(out, `${name}.png`), fullPage });
    count++;
  }

  /** 要素 1 つの絵（見本の節など） */
  async function shotOf(page: Page, name: string, selector: string): Promise<void> {
    if (!wanted(name)) return;
    await wait(400);
    await page.locator(selector).screenshot({ path: join(out, `${name}.png`) });
    count++;
  }

  /** names のどれも --only に合わなければ飛ばす。失敗は console.log に書いて次へ */
  async function step(label: string, names: string[], fn: () => Promise<void>): Promise<void> {
    if (!names.some(wanted)) return;
    try {
      await fn();
    } catch (error) {
      failed++;
      logLines.push(`[shoot] ${label} に失敗: ${(error instanceof Error ? error.message : String(error)).split("\n")[0]}`);
    }
  }

  async function load(page: Page, path: string): Promise<void> {
    // hash だけ違う URL は同じ文書の移動になり、開いたダイアログが残るので毎回読み直す
    await page.goto("about:blank");
    await page.goto(base + path, { waitUntil: "load" });
    // スマホで会話・設定を開いているときは一覧が隠れているので、在るまでを待つ
    await page.waitForSelector("#c-list-root section[data-kind]", { state: "attached", timeout: 8000 });
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

  /** 本番の部品の当たり（hitProblems。範囲の中の button だけ）。測った後は一覧の位置を先頭に戻す */
  async function checkParts(page: Page, vp: Viewport, selectors: string[]): Promise<string[]> {
    const lines = await page.evaluate(hitProblems, { min: HIT_MIN[vp], scopes: selectors.join(", "), targets: "button", toast: false });
    await page.evaluate(() => {
      for (const el of document.querySelectorAll(".c-list")) el.scrollTop = 0;
      window.scrollTo(0, 0);
    });
    return lines;
  }

  /** /api/topics の応答を edit で書き換えている間に一覧を読み直す（SA.topics.load の終わりまで待つ）。終わったら書き換えを外す */
  async function loadEdited(page: Page, edit: (json: TopicsJson) => void): Promise<void> {
    const pattern = "**/api/topics*";
    await page.route(pattern, async (route) => {
      const response = await route.fetch();
      const json = (await response.json()) as TopicsJson;
      edit(json);
      await route.fulfill({ response, json });
    });
    try {
      await page.evaluate(() => (window as unknown as { SA: { topics: { load: () => Promise<void> } } }).SA.topics.load());
      await wait(300);
    } finally {
      await page.unroute(pattern);
    }
  }

  /** 群の中の行（data-mark の付いた button[data-topic]）とフォーカスの今 */
  const focusState = (page: Page): Promise<{ topic: string | null; mark: boolean; index: number; top: number }> =>
    page.evaluate(() => {
      const rows = [...document.querySelectorAll("#c-list-root button[data-topic]")];
      const a = document.activeElement;
      const list = document.querySelector(".c-list");
      return {
        topic: a instanceof HTMLElement && a.matches("button[data-topic]") ? (a.dataset.topic ?? null) : null,
        mark: a instanceof HTMLElement && a.hasAttribute("data-mark"),
        index: a === null ? -1 : rows.indexOf(a),
        top: list === null ? -1 : list.scrollTop,
      };
    });

  /**
   * 新しい殻の一覧の検査（ダークの組だけ）: [+] の隣・id・左端・使い回し・フォーカスと位置・鍵。
   * 当たりは checkParts。応答を書き換えた検査の後は読み直す
   */
  async function checkList(page: Page, vp: Viewport): Promise<string[]> {
    const lines: string[] = [];
    const phone = vp === "phone";
    if (vp === "pc") {
      // [+] の広げた当たりが上下の行にかぶっていない（箱の 2px 上・下の点が [+] に当たらない）
      lines.push(
        ...(await page.evaluate(() => {
          const out: string[] = [];
          for (const add of document.querySelectorAll('#c-list-root section[data-kind] button[title$="で話題を始める"]')) {
            add.scrollIntoView({ block: "center" });
            const r = add.getBoundingClientRect();
            const cx = r.left + r.width / 2;
            for (const y of [r.top - 2, r.bottom + 2]) {
              const hit = document.elementFromPoint(cx, y);
              if (hit !== null && (hit === add || add.contains(hit))) out.push(`[+] の当たりが隣にかぶっている: ${add.getAttribute("title")} y=${Math.round(y - r.top)}`);
            }
          }
          for (const el of document.querySelectorAll(".c-list")) el.scrollTop = 0;
          return out;
        })),
      );
    }
    if (vp !== "tablet") {
      lines.push(
        ...(await page.evaluate((isPhone: boolean) => {
          const out: string[] = [];
          const list = document.querySelector(".c-list");
          if (list === null) return ["一覧の根（.c-list）が無い"];
          const ids = list.querySelectorAll("[id]").length + (list.id ? 1 : 0);
          if (ids > 0) out.push(`一覧の中に id の要素が ${ids} 個`);
          // 左端: 見出し・ラベル・群の名前・あなたの番の印は列の左から 16、群の中の行の印は 28
          const left = list.getBoundingClientRect().left;
          const edge = (selectors: string[], want: number): void => {
            for (const sel of selectors) {
              const els = [...list.querySelectorAll(sel)].filter((el) => el.getClientRects().length > 0);
              if (els.length === 0) out.push(`左端: ${sel} が無い`);
              for (const el of els) {
                // 印は箱の左（作業中の輪は枠を持つ）、文字の物は中身の左
                const cs = getComputedStyle(el);
                const inner = el.matches(".c-mark") ? 0 : parseFloat(cs.borderLeftWidth) + parseFloat(cs.paddingLeft);
                const x = el.getBoundingClientRect().left + inner - left;
                if (Math.abs(x - want) > 0.5) out.push(`左端: ${sel} が ${x.toFixed(1)}（${want} のはず）`);
              }
            }
          };
          edge(isPhone ? [".c-turns-head", ".c-turn > .c-mark", ".c-list-label", ".c-group-name"] : [".c-list-label", ".c-group-name"], 16);
          edge([".c-row > .c-mark"], 28);
          return out;
        }, phone)),
      );
    }
    if (vp === "pc") {
      // 使い回し: 行に印を付け、話題を 1 つ足した応答で読み直す。元の行の要素が残り、行が 1 つ増える
      const before = await page.evaluate(() => {
        const rows = [...document.querySelectorAll("#c-list-root button[data-topic]")];
        (window as unknown as { __rows: Element[] }).__rows = rows;
        return rows.length;
      });
      await loadEdited(page, (json) => {
        const base = json.topics.find((t) => t.state !== "done" && typeof t.id === "string" && t.id.startsWith("ch:"));
        if (base) json.topics.push({ ...base, id: "ch:999999", title: "足した話題", mark: null, turn: null });
      });
      const reuse = await page.evaluate(() => {
        const rows = (window as unknown as { __rows: Element[] }).__rows;
        return { kept: rows.filter((row) => row.isConnected).length, all: rows.length, now: document.querySelectorAll("#c-list-root button[data-topic]").length };
      });
      if (reuse.kept !== reuse.all) lines.push(`使い回し: 元の行 ${reuse.all} のうち残ったのは ${reuse.kept}`);
      if (reuse.now !== before + 1) lines.push(`使い回し: 行が ${before} → ${reuse.now}（1 つ増えるはず）`);
      await load(page, "/static/v3.html");

      // フォーカスと位置 (1): 一覧が送れる高さにして、行にフォーカス・100 送ってから、順を入れ替えた応答で読み直す
      await page.setViewportSize({ width: 1440, height: 500 });
      await wait(300);
      const picked = await page.evaluate(() => {
        const rows = [...document.querySelectorAll<HTMLElement>("#c-list-root button[data-topic][data-mark]")];
        const row = rows[2] ?? rows[0];
        if (!row) return null;
        row.focus();
        const list = document.querySelector(".c-list");
        if (list) list.scrollTop = 100;
        return { topic: row.dataset.topic ?? "", top: list ? list.scrollTop : -1 };
      });
      if (picked === null) lines.push("フォーカスと位置: 行が無い");
      else if (picked.top !== 100) lines.push(`フォーカスと位置: 一覧を 100 送れない（${picked.top}）`);
      else {
        await loadEdited(page, (json) => json.topics.reverse());
        const now = await focusState(page);
        if (now.topic !== picked.topic || !now.mark) lines.push(`フォーカスと位置 (1): フォーカスが ${now.topic ?? "（行の外）"}（${picked.topic} の群の中の行のはず）`);
        if (now.top !== 100) lines.push(`フォーカスと位置 (1): 一覧の位置が ${now.top}（100 のはず）`);
      }
      await page.setViewportSize(VIEWPORTS.pc.viewport);
      await load(page, "/static/v3.html");

      // 鍵: ↓・End・Home・先頭の ↑。修飾キー付きは動かさない
      const rowCount = await page.evaluate(() => {
        const rows = [...document.querySelectorAll<HTMLElement>("#c-list-root button[data-topic]")];
        rows[0]?.focus();
        return rows.length;
      });
      const expectKey = async (key: string, want: number): Promise<void> => {
        await page.keyboard.press(key);
        const { index } = await focusState(page);
        if (index !== want) lines.push(`鍵: ${key} の後のフォーカスが ${index} 番目（${want} 番目のはず）`);
      };
      if (rowCount < 3) lines.push(`鍵: 行が ${rowCount} つしか無い`);
      else {
        await expectKey("ArrowDown", 1);
        await expectKey("End", rowCount - 1);
        await expectKey("Home", 0);
        await expectKey("ArrowUp", 0);
        for (const key of ["Shift+ArrowDown", "Alt+ArrowDown", "Control+End"]) await expectKey(key, 0);
      }
      await load(page, "/static/v3.html");
    }
    if (phone) {
      // フォーカスと位置 (3): focusRow は群の中の行に当てる
      const turn = await page.evaluate(() => {
        for (const b of document.querySelectorAll<HTMLElement>("#c-list-root button[data-topic]:not([data-mark])")) {
          const id = b.dataset.topic ?? "";
          if ([...document.querySelectorAll<HTMLElement>("#c-list-root button[data-topic][data-mark]")].some((r) => r.dataset.topic === id)) return id;
        }
        return null;
      });
      if (turn === null) lines.push("フォーカスと位置: 群の中にも在る「あなたの番」の話題が無い");
      else {
        const hit = await page.evaluate((id: string) => (window as unknown as { SA: { list: { focusRow: (id: string) => boolean } } }).SA.list.focusRow(id), turn);
        const now = await focusState(page);
        if (!hit || now.topic !== turn || !now.mark) lines.push(`フォーカスと位置 (3): focusRow の後のフォーカスが ${now.topic ?? "（行の外）"}・群の中の行 ${now.mark}`);
        // (2): 「あなたの番」の行にフォーカスを当て、あなたの番 0 件の応答で読み直す。同じ話題の群の中の行へ移る
        await page.evaluate((id: string) => {
          for (const b of document.querySelectorAll<HTMLElement>("#c-list-root button[data-topic]:not([data-mark])")) if (b.dataset.topic === id) b.focus();
        }, turn);
        await loadEdited(page, (json) => {
          json.turns = 0;
          json.turnIds = [];
          for (const t of json.topics) if (t.id === turn) Object.assign(t, { mark: null, turn: null });
        });
        const after = await focusState(page);
        if (after.topic !== turn || !after.mark) lines.push(`フォーカスと位置 (2): 「あなたの番」が消えた後のフォーカスが ${after.topic ?? "（行の外）"}・群の中の行 ${after.mark}`);
      }
      await load(page, "/static/v3.html");
    }
    return lines;
  }

  /** 古い CSS の漏れ: 本番の一覧と見本（[data-demo="list-full"]）で、決めた要素の computed style が同じ。見本を開くので、後で読み直す */
  async function checkLeaks(page: Page, vp: Viewport): Promise<string[]> {
    const selectors = [...LEAK_SELECTORS, ...(vp === "phone" ? LEAK_SELECTORS_PHONE : LEAK_SELECTORS_PC)];
    const styles = ({ root, sels, props }: { root: string; sels: string[]; props: string[] }): Record<string, Record<string, string> | null> => {
      const out: Record<string, Record<string, string> | null> = {};
      const scope = document.querySelector(root);
      for (const sel of sels) {
        const el = scope === null ? null : scope.querySelector(sel);
        if (el === null) {
          out[sel] = null;
          continue;
        }
        const cs = getComputedStyle(el);
        out[sel] = Object.fromEntries(props.map((prop) => [prop, cs.getPropertyValue(prop)]));
      }
      return out;
    };
    const real = await page.evaluate(styles, { root: "#c-list-root", sels: selectors, props: LEAK_PROPS });
    await page.goto("about:blank");
    await page.goto(base + "/static/gallery.html", { waitUntil: "load" });
    await page.waitForSelector('[data-demo="list-full"] .c-list', { timeout: 5000 });
    const demo = await page.evaluate(styles, { root: '[data-demo="list-full"]', sels: selectors, props: LEAK_PROPS });
    const lines: string[] = [];
    for (const sel of selectors) {
      const a = real[sel];
      const b = demo[sel];
      if (!a || !b) {
        lines.push(`漏れ: ${sel} が${!a ? "本番" : "見本"}に無い`);
        continue;
      }
      // 群の名前の右の余白は auto（右の物を右端へ押す）で、幅によって値が違う
      for (const prop of LEAK_PROPS) if (!(sel === ".c-group-name" && prop === "margin-right") && a[prop] !== b[prop]) lines.push(`漏れ: ${sel} の ${prop} が 本番 ${a[prop]} / 見本 ${b[prop]}`);
    }
    await load(page, "/static/v3.html");
    return lines;
  }

  /** 幅の決まり（R1 はみ出ない・R2 右の語と時刻が省かれない・R3 題が全角 5 字残る。等幅の字を当てた後に測る）。足りない物の文 */
  const measureWidths = (page: Page, at: string): Promise<string[]> =>
    page.evaluate((label: string) => {
      const out: string[] = [];
      const shown = (sel: string): HTMLElement[] => [...document.querySelectorAll<HTMLElement>(`#c-list-root ${sel}`)].filter((el) => el.getClientRects().length > 0);
      const name = (el: HTMLElement): string => (el.textContent ?? "").trim().slice(0, 20);
      // R1 はみ出ない
      for (const sel of [".c-list", ".c-row", ".c-turn", ".c-group-head"]) {
        for (const el of [...document.querySelectorAll<HTMLElement>(sel)].filter((e) => e.getClientRects().length > 0)) {
          if (el.scrollWidth > el.clientWidth) out.push(`${label} R1: ${sel}「${name(el)}」がはみ出る 幅 ${el.clientWidth} 要る幅 ${el.scrollWidth}`);
        }
      }
      // R2 省かれない字（右端は親の button か見出しの中）
      for (const sel of [".c-row-state", ".c-row-time", ".c-turn-meta", ".c-group-note", ".c-turns-jump-label"]) {
        for (const el of shown(sel)) {
          if (el.scrollWidth > el.clientWidth) out.push(`${label} R2: ${sel}「${name(el)}」が省かれる 幅 ${el.clientWidth} 要る幅 ${el.scrollWidth}`);
          const box = el.closest("button, .c-group-head");
          if (box !== null) {
            const over = el.getBoundingClientRect().right - box.getBoundingClientRect().right;
            if (over > 0.5) out.push(`${label} R2: ${sel}「${name(el)}」の右端が枠を ${over.toFixed(1)} 越える`);
          }
        }
      }
      // R3 題が残る（省かれているなら全角 5 字以上）
      for (const sel of [".c-row-title", ".c-turn-title", ".c-group-name"]) {
        for (const el of shown(sel)) {
          const size = parseFloat(getComputedStyle(el).fontSize);
          if (el.scrollWidth > el.clientWidth && el.clientWidth < size * 5) out.push(`${label} R3: ${sel}「${name(el)}」が 幅 ${el.clientWidth} しか残らない 要る幅 ${Math.ceil(size * 5)}`);
        }
      }
      return out;
    }, at);

  /**
   * 幅の検査（そのページの最後の段）: 仮名が全角の等幅の字を当て、当たった事を確かめてから R1〜R3 を測る。
   * スマホは 390 と 375。字は CSSOM の adoptedStyleSheets で当てる（CSP で <style> を足せない）。終わったら外す
   */
  async function checkWidths(page: Page, vp: Viewport, mono: string | null): Promise<string[]> {
    await page.evaluate((css: string) => {
      const sheet = new CSSStyleSheet();
      sheet.replaceSync(css);
      document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet];
      (window as unknown as { __mono: CSSStyleSheet }).__mono = sheet;
    }, MONO_CSS);
    try {
      await page.evaluate(() => document.fonts.ready.then(() => undefined));
      await wait(300);
      const glyph = await page.evaluate(() => {
        const span = document.createElement("span");
        span.style.position = "absolute";
        span.style.whiteSpace = "nowrap";
        span.style.fontSize = "100px";
        document.body.append(span);
        span.textContent = "あ";
        const kana = span.getBoundingClientRect().width;
        span.textContent = "0";
        const digit = span.getBoundingClientRect().width;
        span.remove();
        return { kana, digit };
      });
      if (!(glyph.kana >= 99 && glyph.kana <= 101 && glyph.digit >= 49 && glyph.digit <= 51)) {
        return [`幅: 仮名が全角の等幅の字が当たっていない（「あ」${glyph.kana.toFixed(1)}・「0」${glyph.digit.toFixed(1)}）。IPAGothic を入れる`];
      }
      const lines = await measureWidths(page, `幅 ${VIEWPORTS[vp].viewport.width}`);
      if (vp === "phone") {
        await page.setViewportSize({ width: 375, height: 812 });
        await wait(300);
        lines.push(...(await measureWidths(page, "幅 375")));
        await page.setViewportSize(VIEWPORTS.phone.viewport);
        await wait(300);
      }
      if (mono !== null) await shot(page, mono);
      return lines;
    } finally {
      await page.evaluate(() => {
        const sheet = (window as unknown as { __mono?: CSSStyleSheet }).__mono;
        document.adoptedStyleSheets = document.adoptedStyleSheets.filter((s) => s !== sheet);
      });
    }
  }

  async function newShell(vp: Viewport, theme: Theme, full: boolean): Promise<void> {
    const p = `${vp}-${theme}`;
    if (!newShellNames(vp, theme, full).some(wanted)) return;
    const { ctx, page } = await contextFor(vp, theme, `v3-${p}`);
    try {
      const mono = theme === "dark" && vp !== "pc" ? `${p}-a-list-mono` : null;
      await step(`${p} a`, [`${p}-a-list`, ...(mono ? [mono] : [])], async () => {
        await load(page, "/static/v3.html");
        await shot(page, `${p}-a-list`);
        // 一覧の検査（ダークの組だけ）。全部を測ってから、1 つでもあれば段を失敗にする
        if (theme !== "dark") return;
        const problems = [...(await checkParts(page, vp, [".c-list"])), ...(await checkList(page, vp))];
        if (vp !== "tablet") problems.push(...(await checkLeaks(page, vp)));
        problems.push(...(await checkWidths(page, vp, mono)));
        for (const line of problems) logLines.push(`[v3-${p}] ${line}`);
        if (problems.length > 0) throw new Error(`一覧の検査で ${problems.length} 件`);
      });
      await step(`${p} b`, [`${p}-b-chat-top`, `${p}-b-chat-middle`, `${p}-b-chat-bottom`], async () => {
        await load(page, `/static/v3.html#/ch/${open}`);
        await page.waitForSelector("#ed textarea", { timeout: 5000 });
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
        await page.waitForSelector("#ed .cc-permission", { timeout: 5000 });
        await wait(800);
        await scrollBottom(page);
        await shot(page, `${p}-b-chat-permission`);
        await load(page, `/static/v3.html#/ch/${q}`);
        await page.waitForSelector("#ed .cc-question-card", { timeout: 5000 });
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
          await page.click('#c-bottom-root [data-act="hand"]');
        } else {
          const expanded = await page.getAttribute("#v3-hand-show", "aria-expanded");
          if (expanded !== "true") await page.click("#v3-hand-show");
        }
        await wait(1000);
        await shot(page, handName);
        if (vp !== "phone") {
          await load(page, `/static/v3.html#/ch/${open}`);
          await page.waitForSelector("#ed .msg-agent", { timeout: 5000 });
          await wait(800);
          await shot(page, `${p}-c-hand-with-chat`);
        }
      });
      await step(`${p} e`, [`${p}-e-start-dialog`], async () => {
        await load(page, "/static/v3.html");
        await page.locator("#c-list-root .c-group-head > .c-iconbtn").first().click();
        await wait(600);
        await shot(page, `${p}-e-start-dialog`);
      });
      await step(`${p} f`, [`${p}-f-settings`, `${p}-f-knowledge-list`, `${p}-f-knowledge-detail`], async () => {
        await load(page, "/static/v3.html#/settings");
        await page.waitForSelector("#ed .ed-section", { timeout: 5000 });
        await wait(800);
        await shot(page, `${p}-f-settings`);
        await load(page, "/static/v3.html#/knowledge");
        await page.waitForSelector("#ed .master-item", { timeout: 5000 });
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
    if (!oldShellNames(vp).some(wanted)) return;
    const { ctx, page } = await contextFor(vp, "dark", label);
    try {
      await step(`${label} list`, [`${label}-list`], async () => {
        await page.goto(base + "/", { waitUntil: "load" });
        // スマホでは一覧が引き出しの中で隠れているので、在るまでを待つ
        await page.waitForSelector("#sidebar .sb-row", { state: "attached", timeout: 8000 });
        await wait(2000);
        await shot(page, `${label}-list`);
      });
      await step(`${label} chat`, [`${label}-chat`], async () => {
        await page.goto("about:blank");
        await page.goto(base + `/#/ch/${open}`, { waitUntil: "load" });
        await page.waitForSelector("#ed .msg-agent", { timeout: 8000 });
        await wait(2000);
        await shot(page, `${label}-chat`);
      });
    } finally {
      await ctx.close();
    }
  }

  /**
   * 見本の当たり（hitProblems）と切り替えの折り返しを測る。id の重なりも見る。
   * 足りない物は 1 行ずつ console.log に書き、1 つでもあれば投げて段を失敗にする
   */
  async function checkGallery(page: Page, vp: Viewport, label: string): Promise<void> {
    // 開いた dialog があればその中、無ければ見本と知らせの中（知らせの下に隠れた見本の物は数えない。隠れていない g-gallery で測っている）
    const dialogOpen = await page.evaluate(() => document.querySelector("dialog[open]") !== null);
    const hits = await page.evaluate(hitProblems, {
      min: HIT_MIN[vp],
      scopes: dialogOpen ? "dialog[open]" : ".c-gallery, .c-toast",
      targets: 'button, a[href], input, select, textarea, [role="radio"]',
      toast: true,
    });
    const rest = await page.evaluate(
      ({ phone }: { phone: boolean }) => {
        const lines: string[] = [];
        for (const seg of document.querySelectorAll(".c-seg")) {
          const tops = new Set([...seg.children].map((child) => Math.round(child.getBoundingClientRect().top)));
          if (tops.size > 1) lines.push(`切り替えが折り返している: ${seg.children.length} 項目`);
        }
        // 文書の中の id の重なり（label の for・aria-describedby・aria-labelledby が別の物を指さない）
        const ids = new Map<string, number>();
        for (const el of document.querySelectorAll("[id]")) ids.set(el.id, (ids.get(el.id) ?? 0) + 1);
        for (const [id, n] of ids) if (n > 1) lines.push(`id が重なっている: ${id}（${n} 個）`);
        if (phone) {
          const six = document.querySelector('[data-demo="seg-6"] .c-seg');
          if (six === null || !(six.scrollWidth > six.clientWidth)) lines.push("6 項目の切り替えが横に送れていない");
        }
        return lines;
      },
      { phone: vp === "phone" },
    );
    const problems = [...hits, ...rest];
    for (const line of problems) logLines.push(`[${label}] ${line}`);
    if (problems.length > 0) throw new Error(`当たり・折り返し・id の検査で ${problems.length} 件`);
  }

  /** 部品の見本のページ（認証の前に配られる事を確かめるため Tailscale-User-Login なしで開く。一覧は待たない）。絵ごとに読み直す */
  async function gallery(vp: Viewport, theme: Theme): Promise<void> {
    const names = GALLERY_KINDS.map((kind) => galleryName(vp, theme, kind));
    if (!names.some(wanted)) return;
    const label = `gallery-${vp}-${theme}`;
    const { ctx, page } = await contextFor(vp, theme, label, false);
    const loadGallery = async (): Promise<void> => {
      await page.goto("about:blank");
      await page.goto(base + "/static/gallery.html", { waitUntil: "load" });
      await page.waitForSelector(".c-gallery-title", { timeout: 5000 });
    };
    try {
      const full = galleryName(vp, theme, "g-gallery");
      // 一覧と下のバーの節の絵は、ページ全体と同じ読み込みで検査と位置の戻しの後に撮る
      const parts = [
        { name: galleryName(vp, theme, "g-list"), selector: '[data-section="list"]' },
        { name: galleryName(vp, theme, "g-bottom"), selector: '[data-section="bottom"]' },
      ];
      await step(full, [full, ...parts.map((part) => part.name)], async () => {
        await loadGallery();
        await checkGallery(page, vp, label);
        // 検査で動かした位置（ページと横に送る入れ物）を先頭に戻す
        await page.evaluate(() => {
          for (const el of document.querySelectorAll("*")) if (el.scrollLeft !== 0) el.scrollLeft = 0;
          window.scrollTo(0, 0);
        });
        await shot(page, full, true);
        for (const part of parts) await shotOf(page, part.name, part.selector);
      });
      /** 押す物（data-demo）を順に押し、開いた物を待って当たりを測ってから撮る */
      const opened: ReadonlyArray<{ kind: GalleryKind; demos: string[]; ready: string }> = [
        { kind: "g-sheet", demos: ["sheet"], ready: "dialog.c-sheet[open]" },
        { kind: "g-confirm", demos: ["confirm-danger"], ready: "dialog.c-sheet[open]" },
        { kind: "g-toast", demos: ["toast", "toast-error"], ready: ".c-toast-item" },
      ];
      for (const { kind, demos, ready } of opened) {
        const name = galleryName(vp, theme, kind);
        await step(name, [name], async () => {
          await loadGallery();
          for (const demo of demos) await page.click(`[data-demo="${demo}"] button`);
          await page.waitForSelector(ready, { timeout: 5000 });
          await wait(400);
          await checkGallery(page, vp, label);
          await shot(page, name);
        });
      }
    } finally {
      await ctx.close();
    }
  }

  for (const { vp, theme, full } of NEW_SHELLS) await newShell(vp, theme, full);
  for (const vp of OLD_SHELLS) await oldShell(vp);
  for (const { vp, theme } of GALLERY_SHOTS) await gallery(vp, theme);
  return { count, failed };
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
  // 合う名前が無ければ Chromium を起動せずに返す
  if (only !== undefined && !ALL_SHOT_NAMES.some((name) => name.includes(only))) {
    console.error(`--only ${only} に合う画面が無い（例: ${["phone-dark-a-list", "pc-dark-b-chat-top", "phone-light-b-chat-permission", "tablet-dark-a-list", "old-pc-dark-list", "pc-dark-g-gallery", "phone-dark-g-sheet"].join("・")}）`);
    return 1;
  }

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
  /** 2 回目のシグナルでも即死せず、同じ後片付けの終わりを待って止める */
  const onSignal = (signal: keyof typeof SIGNAL_EXIT): void => {
    console.error(`${signal} を受けた。ブラウザとサーバーを閉じて止める`);
    void cleanup().finally(() => process.exit(SIGNAL_EXIT[signal]));
  };
  for (const signal of Object.keys(SIGNAL_EXIT) as Array<keyof typeof SIGNAL_EXIT>) process.on(signal, onSignal);
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
    const { count, failed } = await shoot(browser, fixture, out, only, logLines);
    console.log(`${count} 枚を撮った: ${out}`);
    if (count === 0) {
      console.error("1 枚も撮れなかった（名前の一覧と撮る側がずれている）");
      return 1;
    }
    if (failed > 0) {
      console.error(`${failed} 段が失敗した。${join(out, "console.log")} を見る`);
      return 1;
    }
    return 0;
  } finally {
    await cleanup();
    for (const signal of Object.keys(SIGNAL_EXIT) as Array<keyof typeof SIGNAL_EXIT>) process.off(signal, onSignal);
  }
}

process.exitCode = await main(process.argv.slice(2));
