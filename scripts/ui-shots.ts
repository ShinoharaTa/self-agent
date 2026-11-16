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
type TopicsJson = { topics: Array<{ id?: unknown; state?: unknown; mark?: unknown; turn?: unknown; title?: unknown }>; turns: number; turnIds: unknown[]; rightHands: Array<{ turn?: unknown }> };
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
    // 一覧を末尾まで送った所（ダークのスマホ・タブレット）と、入口が読めないとき（ダークのスマホ）
    ...(theme === "dark" && vp !== "pc" ? ["a-list-end"] : []),
    ...(theme === "dark" && vp === "phone" ? ["a-entry-missing"] : []),
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
/** 見本の絵の種類（g-gallery はページ全体、g-list・g-top・g-bottom はその節の要素の絵（K3・K4）、ほかは押して開いた所） */
const GALLERY_KINDS = ["g-gallery", "g-list", "g-top", "g-bottom", "g-sheet", "g-confirm", "g-toast"] as const;
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

/** 見出し（.c-top）の高さ（px。--c-bar-h。指の端末 56・PC 52） */
const TOP_H: Record<Viewport, number> = { phone: 56, tablet: 56, pc: 52 };
/** 長い題の見本で題に残る幅の下限（px。CSS の下限ではなく、入口が compact に替える幅の算数の見張り）と場所のボタンの幅の下限（--c-top-place-min） */
const TOP_TITLE_MIN = 80;
const TOP_PLACE_MIN = 96;
/** 見本の見出しの入れ物の幅（px。広い幅で全部を出せる下限 --c-top-full-min と、一覧の列 --c-list-w） */
const TOP_BOX: Record<string, number> = { "c-gallery-top-full": 520, "c-gallery-top-list": 280 };

/**
 * 見本の見出しの測り方（ブラウザの中で動く。page.evaluate に渡すので外の変数を使わない）。
 * 高さ（--c-bar-h の値と箱の高さ）・1 段（直下の子が上下の中で左から右へ重ならずに並ぶ）・はみ出し・長い題の省き・場所のボタンの幅・
 * 幅を決めた入れ物の幅（広すぎて検査が空振りしない）・ページが横に動かない・広い幅の縮む順（補足 → 場所 → 題）・広い幅の題と状態の間。足りない物の文を返す
 */
function topProblems({ height, titleMin, placeMin, boxes, label }: { height: number; titleMin: number; placeMin: number; boxes: Record<string, number>; label: string }): string[] {
  const lines: string[] = [];
  const doc = document.documentElement;
  if (doc.scrollWidth > doc.clientWidth) lines.push(`見出し: ページが横に動く（${doc.scrollWidth} > ${doc.clientWidth}。${label}）`);
  // 題が省かれているか（小数で。中身の幅が箱の幅より 0.05 を超えて大きい。整数の scrollWidth では 1px 未満の切れが見えない）
  const cut = (el: Element): boolean => {
    const range = document.createRange();
    range.selectNodeContents(el);
    return range.getBoundingClientRect().width > el.getBoundingClientRect().width + 0.05;
  };
  const tops = [...document.querySelectorAll(".c-top")];
  if (tops.length !== 10) lines.push(`見出し: .c-top が ${tops.length} 個。見本は 10 のはず（${label}）`);
  for (const top of tops) {
    const demo = top.closest("[data-demo]")?.getAttribute("data-demo") ?? "?";
    const r = top.getBoundingClientRect();
    const css = getComputedStyle(top);
    const token = getComputedStyle(document.documentElement).getPropertyValue("--c-bar-h").trim();
    if (token !== `${height}px` || css.height !== `${height}px` || Math.abs(r.height - height) > 0.5) {
      lines.push(`見出し: ${demo} の高さ ${r.height.toFixed(1)}（${css.height}・--c-bar-h ${token}）。${height} のはず（${label}）`);
    }
    let prevRight = -Infinity;
    for (const child of top.children) {
      const c = child.getBoundingClientRect();
      if (c.top < r.top - 0.5 || c.bottom > r.bottom + 0.5) lines.push(`見出し: ${demo} の ${child.classList[0] ?? child.tagName} が上下にはみ出している（${label}）`);
      if (c.left < prevRight - 0.5) lines.push(`見出し: ${demo} の ${child.classList[0] ?? child.tagName} が前の子に重なっている（${label}）`);
      prevRight = Math.max(prevRight, c.right);
    }
    // 題・補足・状態・場所の語は 1 行（帯の高さの中で 2 行に折れても、上の検査には掛からない）
    for (const el of top.querySelectorAll(".c-top-title, .c-top-sub, .c-top > .c-top-status, .c-top > .c-top-rest, .c-top-place-text, .c-top-hand-label")) {
      const lh = parseFloat(getComputedStyle(el).lineHeight);
      const h = el.getBoundingClientRect().height;
      if (!(lh > 0) || h > lh * 1.5) lines.push(`見出し: ${demo} の ${el.classList[0] ?? el.tagName} が 1 行でない（高さ ${h.toFixed(1)}・行 ${getComputedStyle(el).lineHeight}。${label}）`);
    }
    if (top.scrollWidth > top.clientWidth) lines.push(`見出し: ${demo} が横にはみ出している（${top.scrollWidth} > ${top.clientWidth}。${label}）`);
    const box = top.parentElement;
    const want = box === null ? undefined : Object.entries(boxes).find(([cls]) => box.classList.contains(cls))?.[1];
    if (box !== null && want !== undefined) {
      const bs = getComputedStyle(box);
      const inner = want - parseFloat(bs.borderLeftWidth) - parseFloat(bs.borderRightWidth);
      if (Math.abs(r.width - inner) > 1) lines.push(`見出し: ${demo} の幅 ${r.width.toFixed(1)}。入れ物 ${want} から枠を引いた ${inner} のはず（${label}）`);
    }
    for (const place of top.querySelectorAll(".c-top-place")) {
      const w = place.getBoundingClientRect().width;
      if (w < placeMin - 0.5) lines.push(`見出し: ${demo} の場所のボタンの幅 ${w.toFixed(1)}。${placeMin} 以上のはず（${label}）`);
    }
    // 広い幅は 補足 → 場所 → 題 の順に縮む: 題が省かれているなら、補足は残っておらず、場所は下限の幅
    const wideTitle = top.getAttribute("data-variant") === "wide" ? top.querySelector(".c-top-title") : null;
    if (wideTitle !== null && cut(wideTitle)) {
      const rest = top.querySelector(":scope > .c-top-rest");
      if (rest !== null && rest.getBoundingClientRect().width >= 1) lines.push(`見出し: ${demo} の題が省かれているのに補足が ${rest.getBoundingClientRect().width.toFixed(1)} 残っている（${label}）`);
      const place = top.querySelector(".c-top-place");
      if (place !== null && Math.abs(place.getBoundingClientRect().width - placeMin) > 1) lines.push(`見出し: ${demo} の題が省かれているのに場所のボタンが ${place.getBoundingClientRect().width.toFixed(1)}。${placeMin} まで縮むはず（${label}）`);
    }
    // 題が省かれていなければ、題の字の右端と状態の間は帯の間（column-gap）だけ（題の箱が字より広がらない。箱どうしの間では見えない）
    const wideStatus = wideTitle === null ? null : top.querySelector(":scope > .c-top-status");
    if (wideTitle !== null && wideStatus !== null && !cut(wideTitle)) {
      const range = document.createRange();
      range.selectNodeContents(wideTitle);
      const space = wideStatus.getBoundingClientRect().left - range.getBoundingClientRect().right;
      const gap = parseFloat(css.columnGap);
      if (Math.abs(space - gap) > 1) lines.push(`見出し: ${demo} の題と状態の間 ${space.toFixed(1)}。帯の間 ${gap} のはず（${label}）`);
    }
    // 520px の Claude Code の形は、場所が縮めば題が全部入る
    if (demo === "top-wide-cc" && wideTitle !== null && cut(wideTitle)) {
      const range = document.createRange();
      range.selectNodeContents(wideTitle);
      lines.push(`見出し: ${demo} の題が省かれている（中身 ${range.getBoundingClientRect().width.toFixed(2)}・箱 ${wideTitle.getBoundingClientRect().width.toFixed(2)}。${label}）`);
    }
    if (/-long$/.test(demo)) {
      const title = top.querySelector(".c-top-title");
      if (title === null) lines.push(`見出し: ${demo} に題が無い（${label}）`);
      else {
        if (!cut(title)) lines.push(`見出し: ${demo} の長い題が省かれていない（${label}）`);
        if (title.clientWidth < titleMin) lines.push(`見出し: ${demo} の題の幅 ${title.clientWidth}。${titleMin} 以上のはず（${label}）`);
      }
    }
  }
  return lines;
}

/** 古い CSS が一覧に漏れていないかを比べる要素と性質 */
// 題は同じ状態（印の無い行）の物で比べる（未読の行の題は太い）
const LEAK_SELECTORS = ['.c-row[data-mark="none"]', '.c-row[data-mark="none"] .c-row-title', ".c-group-name", ".c-group-head", ".c-group-head > .c-iconbtn", ".c-list-label", ".c-fold-head"];
const LEAK_SELECTORS_PHONE = [".c-turn", ".c-turn-title", ".c-turn-sub"];
const LEAK_SELECTORS_PC = [".c-turns-jump"];
/** 下のバーで比べる要素（スマホの形・広い幅の形） */
const LEAK_BOTTOM_PHONE = [".c-bottom", ".c-bottom-btn", ".c-bottom-btn-label", ".c-bottom-hand", ".c-bottom-hand-label", ".c-bottom > .c-btn"];
const LEAK_BOTTOM_WIDE = [".c-bottom", ".c-bottom > .c-btn", ".c-bottom > .c-btn .c-btn-label"];
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

  /**
   * わざと起こした失敗の行を console.log に残さない: logLines の from 番目から後ろで、needles のどれかを含む行を外して返す。
   * 使うのは描けない bar と入口が読めないときの 2 か所だけ（外す語を増やさない）
   */
  function dropExpected(from: number, needles: string[]): string[] {
    const removed: string[] = [];
    const kept = logLines.slice(0, from);
    for (const line of logLines.slice(from)) (needles.some((n) => line.includes(n)) ? removed : kept).push(line);
    logLines.splice(0, logLines.length, ...kept);
    return removed;
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

  /**
   * 古い CSS の漏れ: 本番の一覧と見本（[data-demo="list-full"]）、本番の下のバーと見本（スマホは bottom-phone、PC は bottom-wide）で、
   * 決めた要素の computed style が同じ。見本を開くので、後で読み直す
   */
  async function checkLeaks(page: Page, vp: Viewport): Promise<string[]> {
    const pairs = [
      { real: "#c-list-root", demo: '[data-demo="list-full"]', sels: [...LEAK_SELECTORS, ...(vp === "phone" ? LEAK_SELECTORS_PHONE : LEAK_SELECTORS_PC)] },
      { real: "#c-bottom-root", demo: vp === "phone" ? '[data-demo="bottom-phone"]' : '[data-demo="bottom-wide"]', sels: vp === "phone" ? LEAK_BOTTOM_PHONE : LEAK_BOTTOM_WIDE },
    ];
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
    const real = [];
    for (const pair of pairs) real.push(await page.evaluate(styles, { root: pair.real, sels: pair.sels, props: LEAK_PROPS }));
    await page.goto("about:blank");
    await page.goto(base + "/static/gallery.html", { waitUntil: "load" });
    await page.waitForSelector('[data-demo="list-full"] .c-list', { timeout: 5000 });
    await page.waitForSelector(`${pairs[1]!.demo} .c-bottom`, { timeout: 5000 });
    const lines: string[] = [];
    for (const [i, pair] of pairs.entries()) {
      const demo = await page.evaluate(styles, { root: pair.demo, sels: pair.sels, props: LEAK_PROPS });
      for (const sel of pair.sels) {
        const a = real[i]![sel];
        const b = demo[sel];
        if (!a || !b) {
          lines.push(`漏れ: ${sel} が${!a ? "本番" : "見本"}に無い`);
          continue;
        }
        // 群の名前の右の余白は auto（右の物を右端へ押す）で、幅によって値が違う
        for (const prop of LEAK_PROPS) if (!(sel === ".c-group-name" && prop === "margin-right") && a[prop] !== b[prop]) lines.push(`漏れ: ${sel} の ${prop} が 本番 ${a[prop]} / 見本 ${b[prop]}`);
      }
    }
    await load(page, "/static/v3.html");
    return lines;
  }

  /**
   * 幅の決まり（R1 はみ出ない・R2 右の語と時刻が省かれない・R3 題が全角 5 字残る。等幅の字を当てた後に測る）。足りない物の文。
   * 下のバーは一番きつい形（件数「99+」・右腕に印・タブ 2 つ）を、測る evaluate の先頭で描く（描くのは同期なので周期の読み直しが間に入らない）
   */
  const measureWidths = (page: Page, at: string): Promise<string[]> =>
    page.evaluate((label: string) => {
      const out: string[] = [];
      const list = (window as unknown as { SA: { list: { drawBar: (bar: unknown) => boolean } } }).SA.list;
      const noop = (): void => undefined;
      const drawn = list.drawBar({
        turns: 120,
        hand: "turn",
        tabs: [
          { id: "tasks", title: "タスク" },
          { id: "reminders", title: "リマインド" },
        ],
        on: { list: noop, hand: noop, tab: noop, more: noop },
      });
      if (!drawn) out.push(`${label}: バーを一番きつい形に描けない`);
      const shown = (sel: string): HTMLElement[] => [...document.querySelectorAll<HTMLElement>(`:is(#c-list-root, #c-bottom-root) ${sel}`)].filter((el) => el.getClientRects().length > 0);
      const name = (el: HTMLElement): string => (el.textContent ?? "").trim().slice(0, 20);
      // R1 はみ出ない
      for (const sel of [".c-list", ".c-bottom", ".c-row", ".c-turn", ".c-group-head"]) {
        for (const el of [...document.querySelectorAll<HTMLElement>(sel)].filter((e) => e.getClientRects().length > 0)) {
          if (el.scrollWidth > el.clientWidth) out.push(`${label} R1: ${sel}「${name(el)}」がはみ出る 幅 ${el.clientWidth} 要る幅 ${el.scrollWidth}`);
        }
      }
      // R2 省かれない字（右端は親の button か見出しの中）
      for (const sel of [".c-row-state", ".c-row-time", ".c-turn-meta", ".c-group-note", ".c-turns-jump-label", ".c-bottom-btn-label", ".c-bottom-hand-label", ".c-bottom .c-btn-label"]) {
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
      if (mono !== null) {
        // 幅を戻すと右腕の口が描き直され、バーも今の状態に戻るので、絵の前にもう 1 回一番きつい形を描く
        await page.evaluate(() => {
          const noop = (): void => undefined;
          (window as unknown as { SA: { list: { drawBar: (bar: unknown) => boolean } } }).SA.list.drawBar({
            turns: 120,
            hand: "turn",
            tabs: [
              { id: "tasks", title: "タスク" },
              { id: "reminders", title: "リマインド" },
            ],
            on: { list: noop, hand: noop, tab: noop, more: noop },
          });
        });
        await shot(page, mono);
      }
      return lines;
    } finally {
      await page.evaluate(() => {
        const sheet = (window as unknown as { __mono?: CSSStyleSheet }).__mono;
        document.adoptedStyleSheets = document.adoptedStyleSheets.filter((s) => s !== sheet);
      });
    }
  }

  /**
   * 新しい殻の下のバーの検査（ダークの組だけ）: 形・末尾・「一覧」・同じ要素・フォーカスの戻り・「ほか」の板・描けなかったとき・最初の 1 回。
   * 応答を書き換える・わざと失敗させるので、最後は最初の 1 回の検査の読み直しで終える。足りない物の文（頭は「バー: 」）
   */
  async function checkBar(page: Page, vp: Viewport, p: string): Promise<string[]> {
    const lines: string[] = [];
    const phone = vp === "phone";
    // 形
    const form = await page.evaluate(() => {
      const root = document.querySelector("#c-bottom-root");
      const bar = root === null ? null : root.firstElementChild;
      const buttons = bar === null ? [] : [...bar.querySelectorAll("button")];
      return {
        kids: root === null ? -1 : root.children.length,
        isBar: bar !== null && bar.matches(".c-bottom"),
        variant: bar === null ? null : bar.getAttribute("data-variant"),
        ids: root === null ? 0 : root.querySelectorAll("[id]").length,
        acts: buttons.map((b) => b.getAttribute("data-act")),
        texts: buttons.map((b) => (b.textContent ?? "").trim()),
      };
    });
    if (form.kids !== 1 || !form.isBar) lines.push(`バー: #c-bottom-root の子が .c-bottom 1 つでない（子 ${form.kids}）`);
    if (form.variant !== (phone ? "phone" : "wide")) lines.push(`バー: data-variant が ${String(form.variant)}`);
    if (form.ids !== 0) lines.push(`バー: 中に id の付いた要素が ${form.ids} 個`);
    if (phone) {
      if (form.acts.length !== 3 || form.acts[0] !== "list" || form.acts[1] !== "hand" || form.texts[2] !== "ほか") lines.push(`バー: スマホのボタンが 一覧・右腕・ほか でない（${form.texts.join("・")}）`);
    } else if (JSON.stringify(form.texts) !== JSON.stringify(["タスク", "リマインド", "ほか"])) {
      lines.push(`バー: 広い幅のボタンが タスク・リマインド・ほか でない（${form.texts.join("・")}）`);
    }
    // 末尾: 最後の行がバーに隠れない・バーが画面の下端まで・高さ
    if (vp !== "pc") {
      await page.evaluate(() => {
        const list = document.querySelector(".c-list");
        if (list !== null) list.scrollTop = list.scrollHeight;
      });
      await wait(300);
      const end = await page.evaluate(() => {
        const bar = document.querySelector(".c-bottom");
        const buttons = [...document.querySelectorAll("#c-list-root button")].filter((b) => b.getClientRects().length > 0);
        const last = buttons[buttons.length - 1];
        const r = bar === null ? null : bar.getBoundingClientRect();
        return { lastBottom: last === undefined ? null : last.getBoundingClientRect().bottom, top: r === null ? null : r.top, bottom: r === null ? null : r.bottom, height: r === null ? null : r.height, inner: window.innerHeight };
      });
      const want = phone ? 64 : 44;
      if (end.top === null || end.bottom === null || end.height === null) lines.push("バー: .c-bottom が無い");
      else {
        if (end.lastBottom === null || end.lastBottom > end.top + 0.5) lines.push(`バー: 最後の行の下端 ${String(end.lastBottom)} がバーの上端 ${end.top} より下`);
        if (Math.abs(end.bottom - end.inner) > 0.5) lines.push(`バー: 下端 ${end.bottom} が画面の下端 ${end.inner} と合わない`);
        if (Math.abs(end.height - want) > 0.5) lines.push(`バー: 高さ ${end.height}（${want} のはず）`);
      }
      await shot(page, `${p}-a-list-end`);
      await page.evaluate(() => {
        const list = document.querySelector(".c-list");
        if (list !== null) list.scrollTop = 0;
      });
    }
    if (phone) {
      // 「一覧」: 一覧の先頭へ
      await page.evaluate(() => {
        const list = document.querySelector(".c-list");
        if (list !== null) list.scrollTop = 100;
      });
      await page.click('#c-bottom-root [data-act="list"]');
      await wait(200);
      const top = await page.evaluate(() => document.querySelector(".c-list")?.scrollTop ?? -1);
      if (top !== 0) lines.push(`バー: 「一覧」を押しても先頭に戻らない（${top}）`);
      // 同じ要素: 右腕のボタンと「ほか」に印を付け、右腕を「あなたの番」にして描き直させる
      await page.evaluate(() => {
        const hand = document.querySelector('#c-bottom-root [data-act="hand"]');
        const buttons = document.querySelectorAll(".c-bottom button");
        if (hand !== null) (hand as unknown as { __k: number }).__k = 1;
        const more = buttons[buttons.length - 1];
        if (more !== undefined) (more as unknown as { __k: number }).__k = 2;
      });
      let hands = true;
      await loadEdited(page, (json) => {
        const hand = json.rightHands[0];
        if (hand === undefined) hands = false;
        else hand.turn = { kind: "confirm", since: "2026-01-01T00:00:00.000Z", summary: null };
      });
      if (!hands) lines.push("バー: 作り物のデータに右腕が無い");
      else {
        const same = await page.evaluate(() => {
          const hand = document.querySelector('#c-bottom-root [data-act="hand"]');
          const buttons = document.querySelectorAll(".c-bottom button");
          const more = buttons[buttons.length - 1];
          return {
            hand: hand !== null && (hand as unknown as { __k?: number }).__k === 1,
            turn: hand !== null && hand.querySelector('[data-state="turn"]') !== null,
            label: hand === null ? null : hand.getAttribute("aria-label"),
            more: more !== undefined && (more as unknown as { __k?: number }).__k === 2,
          };
        });
        if (!same.hand) lines.push("バー: 描き直した後の右腕のボタンが同じ要素でない");
        if (!same.turn) lines.push("バー: 右腕のボタンに「あなたの番」の印が無い");
        if (same.label !== "右腕に頼む・訊く（あなたの番）") lines.push(`バー: 右腕のボタンの名前が ${String(same.label)}`);
        if (!same.more) lines.push("バー: 描き直した後の「ほか」が同じ要素でない");
        // フォーカスの戻り: 開いている間に描き直されても、閉じたら右腕のボタンへ
        await page.click('#c-bottom-root [data-act="hand"]');
        await page.waitForSelector('#v3[data-hand="open"]', { timeout: 5000 });
        await loadEdited(page, () => undefined);
        await page.evaluate(() => history.back());
        await page.waitForSelector('#v3[data-hand="closed"]', { timeout: 5000 });
        await wait(200);
        const back = await page.evaluate(() => (document.activeElement as unknown as { __k?: number } | null)?.__k === 1);
        if (!back) lines.push("バー: 右腕を閉じた後の焦点が右腕のボタンに戻らない");
      }
      // 幅をまたぐ: 640 を越えると広い幅の形、戻すとスマホの形に描き直す
      const formAt = (): Promise<{ variant: string | null; acts: Array<string | null>; texts: string[] }> =>
        page.evaluate(() => {
          const bar = document.querySelector("#c-bottom-root > .c-bottom");
          const buttons = bar === null ? [] : [...bar.querySelectorAll("button")];
          return { variant: bar === null ? null : bar.getAttribute("data-variant"), acts: buttons.map((b) => b.getAttribute("data-act")), texts: buttons.map((b) => (b.textContent ?? "").trim()) };
        });
      try {
        await page.setViewportSize({ width: 800, height: VIEWPORTS.phone.viewport.height });
        await wait(300);
        const wide = await formAt();
        if (wide.variant !== "wide" || JSON.stringify(wide.texts) !== JSON.stringify(["タスク", "リマインド", "ほか"])) lines.push(`バー: 800 で広い幅の形にならない（${String(wide.variant)}・${wide.texts.join("・")}）`);
      } finally {
        await page.setViewportSize(VIEWPORTS.phone.viewport);
        await wait(300);
      }
      const narrow = await formAt();
      if (narrow.variant !== "phone" || narrow.acts[0] !== "list" || narrow.acts[1] !== "hand" || narrow.texts[2] !== "ほか") lines.push(`バー: 390 に戻してもスマホの形にならない（${String(narrow.variant)}・${narrow.texts.join("・")}）`);
      // 開いたボタンの無い戻り: 焦点の無いまま右腕のチャンネルを開き（SA.app.open は右腕を開く）、閉じたら下のバーの右腕のボタンへ
      const opened = await page.evaluate(() => {
        const sa = (window as unknown as { SA: { topics: { data: () => { rightHands: Array<{ id: string }> } | null }; app: { open: (id: string) => void } } }).SA;
        const hand = sa.topics.data()?.rightHands[0];
        if (hand === undefined) return false;
        if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
        sa.app.open(hand.id);
        return true;
      });
      if (!opened) lines.push("バー: 作り物のデータに右腕が無い（開いたボタンの無い戻り）");
      else {
        await page.waitForSelector('#v3[data-hand="open"]', { timeout: 5000 });
        await page.evaluate(() => history.back());
        await page.waitForSelector('#v3[data-hand="closed"]', { timeout: 5000 });
        await wait(200);
        const focused = await page.evaluate(() => {
          const a = document.activeElement;
          return a !== null && a.matches('#c-bottom-root button[data-act="hand"]');
        });
        if (!focused) lines.push("バー: 開いたボタンの無い右腕を閉じた後の焦点が下のバーの右腕のボタンに無い");
      }
    }
    // 「ほか」の板: スマホは先頭にタスク・リマインド、広い幅は無い。閉じたら「ほか」へ
    await page.locator(".c-bottom button").last().click();
    await page.waitForSelector("#v3-sheet[open]", { timeout: 5000 });
    const rows = await page.evaluate(() => [...document.querySelectorAll("#v3-sheet button.more-row")].map((b) => (b.textContent ?? "").trim()));
    if (phone) {
      if (!(rows[0] ?? "").includes("タスク") || !(rows[1] ?? "").includes("リマインド")) lines.push(`バー: スマホの「ほか」の板の先頭が タスク・リマインド でない（${rows.slice(0, 2).join("・")}）`);
    } else if ((rows[0] ?? "").includes("タスク")) lines.push("バー: 広い幅の「ほか」の板にタスクが在る");
    await page.click("#v3-sheet button.sheet-close");
    await page.waitForSelector("#v3-sheet:not([open])", { state: "attached", timeout: 5000 });
    await wait(200);
    const moreFocus = await page.evaluate((isPhone: boolean) => {
      const buttons = document.querySelectorAll(".c-bottom button");
      const more = buttons[buttons.length - 1];
      const a = document.activeElement;
      return a !== null && a === more && (!isPhone || (a as unknown as { __k?: number }).__k === 2);
    }, phone);
    if (!moreFocus) lines.push("バー: 「ほか」の板を閉じた後の焦点が「ほか」に戻らない");
    if (phone) {
      // 描けなかったとき: 入口は false を返し、次の静かな形は描ける
      const from = logLines.length;
      const drawn = await page.evaluate(() => {
        const list = (window as unknown as { SA: { list: { drawBar: (bar: unknown) => boolean } } }).SA.list;
        const noop = (): void => undefined;
        const on = { list: noop, hand: noop, tab: noop, more: noop };
        const first = list.drawBar({
          turns: 1,
          hand: null,
          get tabs(): unknown {
            throw new Error("x");
          },
          on,
        });
        const second = list.drawBar({ turns: 0, hand: null, tabs: [], on });
        return { first, second, hand: document.querySelector('#c-bottom-root [data-act="hand"]') !== null };
      });
      await wait(300);
      if (drawn.first !== false || drawn.second !== true || !drawn.hand) lines.push(`バー: 描けなかったときの形が違う（1 回目 ${drawn.first}・2 回目 ${drawn.second}・右腕 ${drawn.hand}）`);
      const removed = dropExpected(from, ["[web] bar draw failed"]);
      if (removed.length !== 1) lines.push(removed.length === 0 ? "バー: 失敗が console に出ていない" : `バー: 失敗の行が ${removed.length} 行`);
    }
    // 最初の 1 回: 最初の応答の前から、件数・印の無いバーが出ている（これが次の検査のための読み直しも兼ねる）
    const pattern = "**/api/topics*";
    let release: () => void = () => undefined;
    const gate = new Promise<void>((done) => {
      release = done;
    });
    await page.route(pattern, async (route) => {
      await gate;
      // 外した後に届いた物は Playwright が先へ流している
      await route.continue().catch(() => undefined);
    });
    try {
      await page.goto("about:blank");
      await page.goto(base + "/static/v3.html", { waitUntil: "load" });
      await page.waitForSelector("#c-bottom-root .c-bottom", { timeout: 5000 });
      const first = await page.evaluate(() => ({
        loading: document.querySelector('.c-list[data-phase="loading"]') !== null,
        buttons: document.querySelectorAll("#c-bottom-root button").length,
        listText: document.querySelector('#c-bottom-root [data-act="list"]')?.textContent ?? "",
        states: document.querySelectorAll("#c-bottom-root [data-state]").length,
      }));
      if (!first.loading) lines.push("バー: 最初の応答の前に一覧が読み込み中でない");
      if (first.buttons !== 3) lines.push(`バー: 最初の応答の前のボタンが ${first.buttons} 個`);
      if (phone && (/\d/.test(first.listText) || first.states !== 0)) lines.push("バー: 最初の応答の前に件数か印が出ている");
    } finally {
      release();
      await wait(100);
      await page.unroute(pattern);
    }
    await page.waitForSelector("#c-list-root section[data-kind]", { state: "attached", timeout: 8000 });
    await wait(1200);
    return lines;
  }

  async function newShell(vp: Viewport, theme: Theme, full: boolean): Promise<void> {
    const p = `${vp}-${theme}`;
    if (!newShellNames(vp, theme, full).some(wanted)) return;
    const { ctx, page } = await contextFor(vp, theme, `v3-${p}`);
    try {
      const mono = theme === "dark" && vp !== "pc" ? `${p}-a-list-mono` : null;
      const end = theme === "dark" && vp !== "pc" ? `${p}-a-list-end` : null;
      await step(`${p} a`, [`${p}-a-list`, ...(mono ? [mono] : []), ...(end ? [end] : [])], async () => {
        await load(page, "/static/v3.html");
        await shot(page, `${p}-a-list`);
        // 一覧の列の検査（ダークの組だけ）。全部を測ってから、1 つでもあれば段を失敗にする
        if (theme !== "dark") return;
        const problems = [...(await checkParts(page, vp, [".c-list", ".c-bottom"])), ...(await checkList(page, vp)), ...(await checkBar(page, vp, p))];
        if (vp !== "tablet") problems.push(...(await checkLeaks(page, vp)));
        problems.push(...(await checkWidths(page, vp, mono)));
        for (const line of problems) logLines.push(`[v3-${p}] ${line}`);
        if (problems.length > 0) throw new Error(`一覧の列の検査で ${problems.length} 件`);
      });
      // 入口（c-app.js）が読めないとき（ダークのスマホだけ）: 1 文と [ページを読み直す]。下のバーは出ない
      if (theme === "dark" && vp === "phone") {
        await step(`${p} a2`, [`${p}-a-entry-missing`], async () => {
          const problems: string[] = [];
          const from = logLines.length;
          const entry = "**/static/c-app.js";
          await page.route(entry, (route) => route.abort());
          try {
            await page.goto("about:blank");
            await page.goto(base + "/static/v3.html", { waitUntil: "load" });
            await page.waitForSelector("#c-list-root .v3-entry-missing", { timeout: 5000 });
            await shot(page, `${p}-a-entry-missing`);
            const box = await page.evaluate(() => {
              const el = document.querySelector("#c-list-root .v3-entry-missing");
              const kids = el === null ? [] : [...el.children].map((c) => c.tagName.toLowerCase());
              return {
                kids,
                padding: el === null ? 0 : parseFloat(getComputedStyle(el).paddingLeft),
                bottom: document.querySelector("#c-bottom-root")?.children.length ?? -1,
              };
            });
            if (JSON.stringify(box.kids) !== JSON.stringify(["p", "button"])) problems.push(`入口: 中が p と button でない（${box.kids.join(",")}）`);
            problems.push(...(await page.evaluate(hitProblems, { min: 44, scopes: "#c-list-root", targets: "button", toast: false })).map((line) => `入口: ${line}`));
            if (box.padding < 16) problems.push(`入口: 左の余白が ${box.padding}px`);
            if (box.bottom !== 0) problems.push(`入口: #c-bottom-root の子が ${box.bottom} 個`);
            // 読み直す
            await page.evaluate(() => {
              (window as unknown as { __before?: number }).__before = 1;
            });
            await page.click("#c-list-root .v3-entry-missing button");
            await page.waitForFunction(() => (window as unknown as { __before?: number }).__before === undefined, undefined, { timeout: 5000 });
            await page.waitForSelector("#c-list-root .v3-entry-missing", { timeout: 5000 });
            await wait(300);
          } finally {
            await page.unroute(entry);
          }
          const removed = dropExpected(from, ["c-app.js", "[web] list entry missing", "Failed to load resource"]);
          if (!removed.some((line) => line.includes("[web] list entry missing"))) problems.push("入口: 「[web] list entry missing」が console に出ていない");
          for (const line of problems) logLines.push(`[v3-${p}] ${line}`);
          if (problems.length > 0) throw new Error(`入口の検査で ${problems.length} 件`);
        });
      }
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
    const problems = [...hits, ...rest, ...(await checkTops(page, vp))];
    for (const line of problems) logLines.push(`[${label}] ${line}`);
    if (problems.length > 0) throw new Error(`当たり・折り返し・id の検査で ${problems.length} 件`);
  }

  /** 見本の見出し（topProblems）を、今の字と、仮名が全角の等幅の字（MONO_CSS。終わったら外す）の 2 回測る */
  async function checkTops(page: Page, vp: Viewport): Promise<string[]> {
    const args = { height: TOP_H[vp], titleMin: TOP_TITLE_MIN, placeMin: TOP_PLACE_MIN, boxes: TOP_BOX };
    const lines = await page.evaluate(topProblems, { ...args, label: "今の字" });
    await page.evaluate((css: string) => {
      const sheet = new CSSStyleSheet();
      sheet.replaceSync(css);
      document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet];
      (window as unknown as { __topMono: CSSStyleSheet }).__topMono = sheet;
    }, MONO_CSS);
    try {
      await page.evaluate(() => document.fonts.ready.then(() => undefined));
      await wait(300);
      const kana = await page.evaluate(() => {
        const span = document.createElement("span");
        span.style.position = "absolute";
        span.style.whiteSpace = "nowrap";
        span.style.fontSize = "100px";
        span.textContent = "あ";
        document.body.append(span);
        const w = span.getBoundingClientRect().width;
        span.remove();
        return w;
      });
      if (!(kana >= 99 && kana <= 101)) lines.push(`見出し: 仮名が全角の等幅の字が当たっていない（「あ」${kana.toFixed(1)}）。IPAGothic を入れる`);
      else lines.push(...(await page.evaluate(topProblems, { ...args, label: "等幅の字" })));
    } finally {
      await page.evaluate(() => {
        const sheet = (window as unknown as { __topMono?: CSSStyleSheet }).__topMono;
        document.adoptedStyleSheets = document.adoptedStyleSheets.filter((s) => s !== sheet);
      });
      await wait(300);
    }
    return lines;
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
      // 一覧・見出し・下のバーの節の絵は、ページ全体と同じ読み込みで検査と位置の戻しの後に撮る
      const parts = [
        { name: galleryName(vp, theme, "g-list"), selector: '[data-section="list"]' },
        { name: galleryName(vp, theme, "g-top"), selector: '[data-section="top"]' },
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
