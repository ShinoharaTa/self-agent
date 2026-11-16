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
type TopicsJson = { topics: Array<{ id?: unknown; state?: unknown; mark?: unknown; turn?: unknown; title?: unknown; movable?: unknown }>; turns: number; turnIds: unknown[]; rightHands: Array<{ turn?: unknown }> };
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
    // 本番の見出し（段 t。ダークの 3 組。PC は幅 1100 で右腕を列で開いた所も）
    ...(theme === "dark" ? ["b-top-long", "b-top-menu", "b-top-place", ...(vp === "pc" ? ["b-top-hand-col"] : [])] : []),
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
/** 見本の絵の種類（g-gallery はページ全体、g-list・g-top・g-bottom・g-talk はその節の要素の絵（K3・K4）、ほかは押して開いた所） */
const GALLERY_KINDS = ["g-gallery", "g-list", "g-top", "g-bottom", "g-talk", "g-sheet", "g-confirm", "g-toast"] as const;
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
/** 見本の見出しの data-demo（ページの順） */
const TOP_DEMOS = [
  "top-phone-talk", "top-phone-long", "top-phone-other",
  "top-wide-talk", "top-wide-cc", "top-wide-long", "top-wide-short", "top-wide-other",
  "top-compact-cc", "top-compact-long",
];

/**
 * 見本の見出しの測り方（ブラウザの中で動く。page.evaluate に渡すので外の変数を使わない）。
 * 高さ（--c-bar-h の値と箱の高さ）・1 段（直下の子が上下の中で左から右へ重ならずに並ぶ）・はみ出し・長い題の省き・場所のボタンの幅・
 * 幅を決めた入れ物の幅（広すぎて検査が空振りしない）・ページが横に動かない・広い幅の縮む順（補足 → 場所 → 題）・広い幅の題と状態の間。足りない物の文を返す
 */
function topProblems({ height, titleMin, placeMin, boxes, demos, label }: { height: number; titleMin: number; placeMin: number; boxes: Record<string, number>; demos: string[]; label: string }): string[] {
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
  const names = tops.map((top) => top.closest("[data-demo]")?.getAttribute("data-demo") ?? "?");
  const missing = demos.filter((name) => !names.includes(name));
  const extra = names.filter((name) => !demos.includes(name));
  if (missing.length > 0) lines.push(`見出し: 見本が無い: ${missing.join("・")}（${label}）`);
  if (extra.length > 0) lines.push(`見出し: 知らない見本: ${extra.join("・")}（${label}）`);
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

/** 見本の会話の data-demo（ページの順） */
const TALK_DEMOS = ["talk-basic", "talk-steps", "talk-md", "talk-run", "talk-run-empty", "talk-edge"];
/** 会話の行の幅の上限（.c-talk の中の幅に対する割合。agent と実行中の行・owner） */
const TALK_MAX: Record<Viewport, { agent: number; owner: number }> = { phone: { agent: 0.86, owner: 0.8 }, tablet: { agent: 0.78, owner: 0.72 }, pc: { agent: 0.78, owner: 0.72 } };
/** 会話の根の字の大きさ（px。--c-font-body） */
const TALK_FONT: Record<Viewport, number> = { phone: 16, tablet: 16, pc: 14 };

/**
 * 見本の会話の測り方（ブラウザの中で動く。page.evaluate に渡すので外の変数を使わない）。
 * 見本の名前・吹き出しの中に結果の文が無い・1 行の吹き出しの高さ・幅の上限・角・はみ出し・長いコードを横に送れる・手順の行・実行中の行の読み上げ・根の字。
 * 足りない物の文を返す
 */
function talkProblems({ demos, max, fontSize, label }: { demos: string[]; max: { agent: number; owner: number }; fontSize: number; label: string }): string[] {
  const lines: string[] = [];
  const say = (text: string): void => void lines.push(`会話（${label}）: ${text}`);
  const near = (a: number, b: number, d: number): boolean => Math.abs(a - b) <= d;
  const nameOf = (el: Element): string => el.closest("[data-demo]")?.getAttribute("data-demo") ?? "?";
  // 0. 見本の名前
  const names = [...document.querySelectorAll('[data-section="talk"] [data-demo]')].map((el) => el.getAttribute("data-demo") ?? "?");
  for (const name of demos) if (!names.includes(name)) say(`見本が無い: ${name}`);
  for (const name of names) if (!demos.includes(name)) say(`知らない見本: ${name}`);
  // 1. 結果の文は吹き出しの外
  for (const bubble of document.querySelectorAll(".c-bubble")) {
    const text = bubble.textContent ?? "";
    for (const word of ["完了（", "止まりました", "中断しました"]) if (text.includes(word)) say(`${nameOf(bubble)} の吹き出しの中に「${word}」が在る`);
  }
  // 2. 1 行の返事の吹き出しの高さ
  const basic = document.querySelector('[data-demo="talk-basic"] .c-msg[data-who="agent"]');
  const basicP = basic?.querySelector(".c-bubble p") ?? null;
  const basicB = basic?.querySelector(".c-bubble") ?? null;
  if (basicP === null || basicB === null) say("talk-basic に agent の吹き出しが無い");
  else {
    const ph = basicP.getBoundingClientRect().height;
    const bh = basicB.getBoundingClientRect().height;
    if (!near(ph, fontSize * 1.5, 1)) say(`talk-basic の本文の高さ ${ph.toFixed(1)}。${fontSize * 1.5} のはず（1 行）`);
    if (!near(bh, ph + 20, 1)) say(`talk-basic の吹き出しの高さ ${bh.toFixed(1)}。本文 + 20 = ${(ph + 20).toFixed(1)} のはず`);
  }
  // 3. 幅の上限
  for (const row of document.querySelectorAll(".c-talk > .c-msg, .c-talk > .c-run")) {
    const talk = row.closest(".c-talk");
    if (talk === null) continue;
    const ts = getComputedStyle(talk);
    const inner = talk.clientWidth - parseFloat(ts.paddingLeft) - parseFloat(ts.paddingRight);
    const owner = row.getAttribute("data-who") === "owner";
    const limit = owner ? max.owner : max.agent;
    const ratio = row.getBoundingClientRect().width / inner;
    if (ratio > limit + 0.001) say(`${nameOf(row)} の ${owner ? "owner" : row.classList[0]} の幅 ${ratio.toFixed(3)}。${limit} 以下のはず`);
  }
  const edge = [...document.querySelectorAll('[data-demo="talk-edge"] .c-msg[data-who="owner"]')].at(-1);
  const edgeTalk = edge?.closest(".c-talk") ?? null;
  if (edge === undefined || edgeTalk === null) say("talk-edge に owner の吹き出しが無い");
  else {
    const ts = getComputedStyle(edgeTalk);
    const ratio = edge.getBoundingClientRect().width / (edgeTalk.clientWidth - parseFloat(ts.paddingLeft) - parseFloat(ts.paddingRight));
    if (ratio < max.owner - 0.01) say(`talk-edge の長い発言の幅 ${ratio.toFixed(3)}。上限 ${max.owner} に届いていない`);
  }
  // 4. 角（左上・右上・右下・左下）
  for (const bubble of document.querySelectorAll(".c-msg > .c-bubble")) {
    const cs = getComputedStyle(bubble);
    const got = [cs.borderTopLeftRadius, cs.borderTopRightRadius, cs.borderBottomRightRadius, cs.borderBottomLeftRadius].map((v) => parseFloat(v));
    const owner = bubble.parentElement?.getAttribute("data-who") === "owner";
    const want = owner ? [14, 14, 4, 14] : [14, 14, 14, 4];
    if (got.some((v, i) => !near(v, want[i] ?? 0, 0.5))) say(`${nameOf(bubble)} の ${owner ? "owner" : "agent"} の角 ${got.join("・")}。${want.join("・")} のはず`);
  }
  // 5. はみ出し
  for (const el of document.querySelectorAll(".c-talk, .c-bubble")) {
    if (el.scrollWidth > el.clientWidth) say(`${nameOf(el)} の ${el.classList[0] ?? ""} が横にはみ出している（${el.scrollWidth} > ${el.clientWidth}）`);
  }
  // 6. 長いコードは吹き出しの中で横に送れる
  const pre = document.querySelector('[data-demo="talk-md"] .c-md-pre');
  if (pre === null) say("talk-md にコードの段が無い");
  else {
    if (!(pre.scrollWidth > pre.clientWidth)) say(`talk-md のコードの段が横に長くない（${pre.scrollWidth} ≦ ${pre.clientWidth}）`);
    pre.scrollLeft = 50;
    const moved = pre.scrollLeft;
    pre.scrollLeft = 0;
    if (!(moved > 0)) say("talk-md のコードの段を横に送れない");
    const msg = pre.closest(".c-msg");
    const bubble = pre.closest(".c-bubble");
    if (msg !== null && bubble !== null && bubble.getBoundingClientRect().right > msg.getBoundingClientRect().right + 0.5) say("talk-md の吹き出しの右端が行の右端を超えている");
  }
  // 7. 手順の行
  for (const foot of document.querySelectorAll(".c-msg-foot")) {
    const msg = foot.closest(".c-msg");
    const r = foot.getBoundingClientRect();
    if (!near(r.height, 24, 0.5)) say(`${nameOf(foot)} の手順の行の高さ ${r.height.toFixed(1)}。24 のはず`);
    if (msg !== null) {
      const m = msg.getBoundingClientRect();
      if (r.left < m.left - 0.5 || r.right > m.right + 0.5) say(`${nameOf(foot)} の手順の行が行の外に出ている`);
    }
  }
  for (const time of document.querySelectorAll(".c-msg-time")) {
    if (time.scrollWidth > time.clientWidth) say(`${nameOf(time)} の時刻が切れている（${time.scrollWidth} > ${time.clientWidth}）`);
  }
  for (const el of document.querySelectorAll(".c-steps-label, .c-steps-text")) {
    if (!(el.scrollWidth > el.clientWidth)) continue;
    const cs = getComputedStyle(el);
    if (cs.textOverflow !== "ellipsis" || cs.overflowX !== "hidden") say(`${nameOf(el)} の結果の文が入りきらないのに省かれていない（text-overflow ${cs.textOverflow}・overflow-x ${cs.overflowX}）`);
    if (el.clientWidth < 96) say(`${nameOf(el)} の省いた結果の文の幅 ${el.clientWidth}。96 以上のはず`);
  }
  for (const li of document.querySelectorAll(".c-run-recent > li")) {
    const h = li.getBoundingClientRect().height;
    if (h > 19) say(`${nameOf(li)} の実行中の手順が 1 行でない（高さ ${h.toFixed(1)}）`);
  }
  // 8. 実行中の行は読み上げ続けない
  for (const run of document.querySelectorAll(".c-run")) {
    if (run.matches("[aria-live], [role=\"status\"]") || run.querySelector("[aria-live], [role=\"status\"]") !== null) say(`${nameOf(run)} の実行中の行に aria-live か role=status が在る`);
  }
  // 9. 根の字
  for (const talk of document.querySelectorAll(".c-talk")) {
    const size = getComputedStyle(talk).fontSize;
    if (size !== `${fontSize}px`) say(`${nameOf(talk)} の根の字 ${size}。${fontSize}px のはず`);
  }
  return lines;
}

/**
 * 本番の見出し（#c-top-root）の測り方（ブラウザの中で動く。page.evaluate に渡すので外の変数を使わない）。
 * 1 つだけ・#ed に古い見出し（h1・[‹]）が無い・高さ・1 段（直下の子が上下の中で左から右へ重ならずに並ぶ・はみ出さない・語が 1 行）・ページが横に動かない・
 * ページの h1 は見出しの題の 1 つ。ed なら #ed（と .ed-scroll）の上端が見出しの下端で、それが画面の上から height。足りない物の文を返す
 */
function liveTopProblems({ height, label, ed }: { height: number; label: string; ed: boolean }): string[] {
  const lines: string[] = [];
  const root = document.querySelector("#c-top-root");
  const top = root !== null && root.children.length === 1 && root.children[0]!.matches(".c-top") ? root.children[0]! : null;
  if (top === null) return [`本番の見出し: #c-top-root の子が .c-top 1 つでない（子 ${root === null ? -1 : root.children.length}。${label}）`];
  for (const h of document.querySelectorAll("#ed header.ed-toolbar:not([hidden]) h1")) lines.push(`本番の見出し: #ed に古い見出しの h1「${(h.textContent ?? "").slice(0, 20)}」が在る（${label}）`);
  if (document.querySelector("#ed .ed-back") !== null) lines.push(`本番の見出し: #ed に古い見出しの [‹] が在る（${label}）`);
  const r = top.getBoundingClientRect();
  if (Math.abs(r.height - height) > 0.5) lines.push(`本番の見出し: 高さ ${r.height.toFixed(1)}。${height} のはず（${label}）`);
  let prevRight = -Infinity;
  for (const child of top.children) {
    const c = child.getBoundingClientRect();
    if (c.width === 0 && c.height === 0) continue;
    if (c.top < r.top - 0.5 || c.bottom > r.bottom + 0.5) lines.push(`本番の見出し: ${child.classList[0] ?? child.tagName} が上下にはみ出している（${label}）`);
    if (c.left < prevRight - 0.5) lines.push(`本番の見出し: ${child.classList[0] ?? child.tagName} が前の子に重なっている（${label}）`);
    prevRight = Math.max(prevRight, c.right);
  }
  for (const el of top.querySelectorAll(".c-top-title, .c-top-sub, .c-top > .c-top-status, .c-top > .c-top-rest, .c-top-place-text, .c-top-hand-label")) {
    const lh = parseFloat(getComputedStyle(el).lineHeight);
    const h = el.getBoundingClientRect().height;
    if (!(lh > 0) || h > lh * 1.5) lines.push(`本番の見出し: ${el.classList[0] ?? el.tagName} が 1 行でない（高さ ${h.toFixed(1)}。${label}）`);
  }
  if (top.scrollWidth > top.clientWidth) lines.push(`本番の見出し: 横にはみ出している（${top.scrollWidth} > ${top.clientWidth}。${label}）`);
  const doc = document.documentElement;
  if (doc.scrollWidth > doc.clientWidth) lines.push(`本番の見出し: ページが横に動く（${doc.scrollWidth} > ${doc.clientWidth}。${label}）`);
  const h1s = [...document.querySelectorAll("h1")];
  if (h1s.length !== 1 || !h1s[0]!.matches("#c-top-root .c-top-title")) lines.push(`本番の見出し: ページの h1 が ${h1s.length} 個（見出しの題の 1 つのはず。${label}）`);
  if (ed) {
    const box = document.querySelector("#ed");
    const e = box === null ? null : box.getBoundingClientRect();
    if (e === null || Math.abs(e.top - r.bottom) > 0.5) lines.push(`本番の見出し: #ed の上端 ${e === null ? "（無い）" : e.top.toFixed(1)} が見出しの下端 ${r.bottom.toFixed(1)} でない（${label}）`);
    if (Math.abs(r.bottom - height) > 0.5) lines.push(`本番の見出し: 見出しの下端 ${r.bottom.toFixed(1)} が画面の上から ${height} でない（${label}）`);
    const scroll = document.querySelector("#ed .ed-scroll");
    if (scroll !== null && Math.abs(scroll.getBoundingClientRect().top - r.bottom) > 0.5) lines.push(`本番の見出し: .ed-scroll の上端 ${scroll.getBoundingClientRect().top.toFixed(1)} が見出しの下端でない（${label}）`);
  }
  return lines;
}

/** 本番の見出しで古い CSS の漏れを比べる要素（見本の同じ形の物と。スマホ・PC は会話の形、タブレットは compact） */
const LEAK_TOP: Record<Viewport, { demo: string; sels: string[] }> = {
  phone: { demo: "top-phone-talk", sels: [".c-top", ".c-top-title", ".c-top-sub", ".c-top-hand", ".c-top-act > .c-iconbtn"] },
  pc: { demo: "top-wide-talk", sels: [".c-top", ".c-top-title", ".c-top-place", ".c-top-act > .c-iconbtn"] },
  tablet: { demo: "top-compact-cc", sels: [".c-top", ".c-top-title", ".c-top-rest"] },
};

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

  /** 本番の見出しの検査（liveTopProblems と、hits なら当たり）。足りない物の文 */
  async function checkTop(page: Page, vp: Viewport, label: string, { hits = true, ed = false }: { hits?: boolean; ed?: boolean } = {}): Promise<string[]> {
    const lines = await page.evaluate(liveTopProblems, { height: TOP_H[vp], label, ed });
    if (hits) lines.push(...(await page.evaluate(hitProblems, { min: HIT_MIN[vp], scopes: "#c-top-root", targets: "button", toast: false })).map((line) => `本番の見出し: ${line}（${label}）`));
    return lines;
  }

  /** ページの h1 が 1 つで、見出しの題か（右腕・板を開いた所でも） */
  async function checkH1(page: Page, label: string): Promise<string[]> {
    const h1 = await page.evaluate(() => {
      const all = [...document.querySelectorAll("h1")];
      return { count: all.length, top: all.length === 1 && all[0]!.matches("#c-top-root .c-top-title") };
    });
    return h1.count === 1 && h1.top ? [] : [`本番の見出し: ページの h1 が ${h1.count} 個（見出しの題の 1 つのはず。${label}）`];
  }

  /** 見出しの形と列 2 の幅（しきい値はページの中で --c-top-full-min を読む） */
  const topForm = (page: Page): Promise<{ width: number; min: number; compact: boolean; place: boolean; views: boolean; menu: boolean; rest: string | null; mode: string | null; hand: string | null; dialog: boolean }> =>
    page.evaluate(() => {
      const top = document.querySelector("#c-top-root > .c-top");
      const v3 = document.querySelector("#v3");
      return {
        width: document.querySelector("#v3-main")?.clientWidth ?? -1,
        min: parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--c-top-full-min")),
        compact: top !== null && top.getAttribute("data-compact") === "true",
        place: top !== null && top.querySelector(".c-top-place") !== null,
        views: top !== null && top.querySelector(".c-top-views") !== null,
        menu: top !== null && top.querySelector('[data-act="menu"] button') !== null,
        rest: top === null ? null : (top.querySelector(".c-top-rest")?.textContent ?? null),
        mode: v3 === null ? null : v3.getAttribute("data-hand-mode"),
        hand: v3 === null ? null : v3.getAttribute("data-hand"),
        dialog: document.querySelector("dialog[open]") !== null,
      };
    });

  /** 決まり: 重ねた右腕も板も開いていない所で、compact ⇔ 列 2 の幅 < しきい値。測った幅を記録に出す */
  async function checkRule(page: Page, tag: string, label: string): Promise<string[]> {
    const f = await topForm(page);
    logLines.push(`[${tag}] 列 2 の幅 ${f.width}・しきい値 ${f.min}・compact ${f.compact}（${label}）`);
    if (!(f.min > 0)) return [`本番の見出し: --c-top-full-min を読めない（${label}）`];
    if (f.dialog || (f.mode === "over" && f.hand === "open")) return [`本番の見出し: 決まりを見る所で板か重ねた右腕が開いている（${label}）`];
    return f.compact === f.width < f.min ? [] : [`本番の見出し: compact ${f.compact} なのに列 2 の幅 ${f.width}（しきい値 ${f.min}。${label}）`];
  }

  /** 見出しの題・「…」・場所のボタンの寸法（長い題の検査） */
  const topSizes = (page: Page): Promise<{ cut: boolean; title: number; menuIn: boolean | null; placeIn: boolean | null; placeW: number | null }> =>
    page.evaluate(() => {
      const top = document.querySelector("#c-top-root > .c-top");
      const t = top === null ? null : top.querySelector(".c-top-title");
      if (top === null || t === null) return { cut: false, title: -1, menuIn: null, placeIn: null, placeW: null };
      const r = top.getBoundingClientRect();
      const range = document.createRange();
      range.selectNodeContents(t);
      const inside = (el: Element | null): boolean | null => {
        if (el === null) return null;
        const b = el.getBoundingClientRect();
        return b.left >= r.left - 0.5 && b.right <= r.right + 0.5 && b.top >= r.top - 0.5 && b.bottom <= r.bottom + 0.5;
      };
      const place = top.querySelector(".c-top-place");
      return {
        cut: range.getBoundingClientRect().width > t.getBoundingClientRect().width + 0.05,
        title: t.clientWidth,
        menuIn: inside(top.querySelector('[data-act="menu"] button')),
        placeIn: inside(place),
        placeW: place === null ? null : place.getBoundingClientRect().width,
      };
    });

  /** 仮名が全角の等幅の字を当てて fn を呼ぶ（終わったら外す）。当たらなければ fn を呼ばずに 1 行（頭は who） */
  async function withMono(page: Page, fn: () => Promise<string[]>, who = "本番の見出し"): Promise<string[]> {
    await page.evaluate((css: string) => {
      const sheet = new CSSStyleSheet();
      sheet.replaceSync(css);
      document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet];
      (window as unknown as { __liveMono: CSSStyleSheet }).__liveMono = sheet;
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
      if (!(kana >= 99 && kana <= 101)) return [`${who}: 仮名が全角の等幅の字が当たっていない（「あ」${kana.toFixed(1)}）。IPAGothic を入れる`];
      return await fn();
    } finally {
      await page.evaluate(() => {
        const sheet = (window as unknown as { __liveMono?: CSSStyleSheet }).__liveMono;
        document.adoptedStyleSheets = document.adoptedStyleSheets.filter((x) => x !== sheet);
      });
      await wait(300);
    }
  }

  /** 長い題の寸法の決まり（スマホは題が省かれて 80 残る。タブレット・PC は「…」が箱の中・題が 80 残る・PC は場所のボタンが箱の中で 96 以上） */
  async function longTitleLines(page: Page, vp: Viewport, label: string): Promise<string[]> {
    const z = await topSizes(page);
    const lines: string[] = [];
    if (vp === "phone" && !z.cut) lines.push(`本番の見出し: 長い題が省かれていない（${label}）`);
    if (z.title < TOP_TITLE_MIN) lines.push(`本番の見出し: 長い題の幅 ${z.title}。${TOP_TITLE_MIN} 以上のはず（${label}）`);
    if (vp !== "phone" && z.menuIn !== true) lines.push(`本番の見出し: 「…」が見出しの箱の中に無い（${label}）`);
    if (vp === "pc") {
      if (z.placeIn !== true) lines.push(`本番の見出し: 場所のボタンが見出しの箱の中に無い（${label}）`);
      if (z.placeW === null || z.placeW < TOP_PLACE_MIN - 0.5) lines.push(`本番の見出し: 場所のボタンの幅 ${String(z.placeW)}。${TOP_PLACE_MIN} 以上のはず（${label}）`);
    }
    return lines;
  }

  /** 古い CSS の漏れ: 本番の見出しと見本の同じ形（LEAK_TOP）。見本を開くので、後で path を読み直す */
  async function checkTopLeaks(page: Page, vp: Viewport, path: string): Promise<string[]> {
    const { demo, sels } = LEAK_TOP[vp];
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
    const real = await page.evaluate(styles, { root: "#c-top-root", sels, props: LEAK_PROPS });
    await page.goto("about:blank");
    await page.goto(base + "/static/gallery.html", { waitUntil: "load" });
    await page.waitForSelector(`[data-demo="${demo}"] .c-top`, { timeout: 5000 });
    const shown = await page.evaluate(styles, { root: `[data-demo="${demo}"]`, sels, props: LEAK_PROPS });
    const lines: string[] = [];
    for (const sel of sels) {
      const a = real[sel];
      const b = shown[sel];
      if (!a || !b) {
        lines.push(`見出しの漏れ: ${sel} が${!a ? "本番" : "見本"}に無い`);
        continue;
      }
      for (const prop of LEAK_PROPS) if (a[prop] !== b[prop]) lines.push(`見出しの漏れ: ${sel} の ${prop} が 本番 ${a[prop]} / 見本 ${b[prop]}`);
    }
    await load(page, path);
    return lines;
  }

  /** キーボードで入った形にして（focus → Shift+Tab → Tab）、見出しのどのボタンの輪も帯で切れない */
  async function checkRings(page: Page, label: string): Promise<string[]> {
    const lines: string[] = [];
    const count = await page.evaluate(() => document.querySelectorAll("#c-top-root button").length);
    if (count === 0) return [`輪: 見出しにボタンが無い（${label}）`];
    for (let i = 0; i < count; i++) {
      await page.evaluate((n: number) => (document.querySelectorAll("#c-top-root button")[n] as HTMLElement | undefined)?.focus(), i);
      await page.keyboard.press("Shift+Tab");
      await page.keyboard.press("Tab");
      await wait(50);
      const ring = await page.evaluate((n: number) => {
        const b = document.querySelectorAll("#c-top-root button")[n];
        const top = b === undefined ? null : b.closest(".c-top");
        if (b === undefined || top === null) return null;
        const cs = getComputedStyle(b);
        const e = (parseFloat(cs.outlineWidth) || 0) + Math.max(0, parseFloat(cs.outlineOffset) || 0);
        const r = b.getBoundingClientRect();
        const t = top.getBoundingClientRect();
        return {
          name: b.getAttribute("aria-label") ?? (b.textContent ?? "").trim().slice(0, 12),
          active: document.activeElement === b,
          visible: b.matches(":focus-visible"),
          inside: r.left - e >= t.left - 0.5 && r.right + e <= t.right + 0.5 && r.top - e >= t.top - 0.5 && r.bottom + e <= t.bottom + 0.5,
          e,
        };
      }, i);
      if (ring === null) lines.push(`輪: ${i} 番目のボタンが無い（${label}）`);
      else if (!ring.active || !ring.visible) lines.push(`輪: 前提が崩れた。「${ring.name}」にキーボードで入れない（焦点 ${ring.active}・:focus-visible ${ring.visible}。${label}）`);
      else if (!ring.inside) lines.push(`輪: 「${ring.name}」の輪（${ring.e}px）が帯で切れる（${label}）`);
    }
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
    return lines;
  }

  /** 焦点が見出しの data-act のボタンか */
  const activeIs = (page: Page, selector: string): Promise<boolean> => page.evaluate((sel: string) => document.activeElement !== null && document.activeElement.matches(sel), selector);
  const TOP_MENU = '#c-top-root [data-act="menu"] button';
  const TOP_BACK = '#c-top-root [data-act="back"] button';
  const TOP_HAND = '#c-top-root button[data-act="hand"]';
  const TOP_PLACE = "#c-top-root button.c-top-place";

  /** 板を Esc で閉じ、閉じるまで待つ */
  async function escSheet(page: Page): Promise<void> {
    await page.keyboard.press("Escape");
    await page.waitForSelector("#v3-sheet:not([open])", { state: "attached", timeout: 5000 });
    await wait(200);
  }

  /** 板の行の字 */
  const sheetRows = (page: Page): Promise<string[]> => page.evaluate(() => [...document.querySelectorAll("#v3-sheet .more-row .sb-label")].map((el) => (el.textContent ?? "").trim()));

  /** 右腕の見出しは h2「右腕」で、#v3-hand-ed に h1 が無い。字の大きさは --font-base・1 行 */
  async function checkHandHeading(page: Page, label: string): Promise<string[]> {
    const h = await page.evaluate(() => {
      const h2 = document.querySelector("#v3-hand-ed .ed-title h2");
      const probe = document.createElement("span");
      probe.style.fontSize = "var(--font-base)";
      document.body.append(probe);
      const base = getComputedStyle(probe).fontSize;
      probe.remove();
      return {
        text: h2 === null ? null : (h2.textContent ?? "").trim(),
        h1: document.querySelectorAll("#v3-hand-ed h1").length,
        size: h2 === null ? null : getComputedStyle(h2).fontSize,
        base,
        space: h2 === null ? null : getComputedStyle(h2).whiteSpace,
      };
    });
    const lines: string[] = [];
    if (h.text !== "右腕") lines.push(`右腕の見出し: h2 が「${String(h.text)}」（${label}）`);
    if (h.h1 !== 0) lines.push(`右腕の見出し: #v3-hand-ed に h1 が ${h.h1} 個（${label}）`);
    if (h.size !== h.base) lines.push(`右腕の見出し: 字の大きさ ${String(h.size)}。--font-base の ${h.base} のはず（${label}）`);
    if (h.space !== "nowrap") lines.push(`右腕の見出し: white-space が ${String(h.space)}（${label}）`);
    return lines;
  }

  /**
   * 段 t（本番の見出し。ダークの 3 組）: 会話 → 長い題の話題 → 「…」の板 → 場所 → 右腕 → 設定・状態。PC は幅を 1100・800 に変えて戻す。
   * 足りない物の文（全部を測ってから、1 つでもあれば段を失敗にする）
   */
  async function topStage(page: Page, vp: Viewport, p: string): Promise<string[]> {
    const tag = `v3-${p}`;
    const lines: string[] = [];
    const chat = `/static/v3.html#/ch/${open}`;
    const phone = vp === "phone";
    // 会話を開く（スマホは一覧の行から。焦点は「一覧へ」・押すと一覧へ）
    if (phone) {
      await load(page, "/static/v3.html");
      await page.locator(`#c-list-root button[data-topic="ch:${open}"]`).last().click();
      await page.waitForSelector("#ed textarea", { timeout: 5000 });
      await wait(500);
      if (!(await activeIs(page, TOP_BACK))) lines.push("本番の見出し: 一覧から話題を開いた後の焦点が「一覧へ」に無い");
      lines.push(...(await checkTop(page, vp, "会話", { ed: true })));
      await page.click(TOP_BACK);
      await page.waitForSelector('#v3[data-view="list"]', { timeout: 5000 });
    }
    await load(page, chat);
    await page.waitForSelector("#ed textarea", { timeout: 5000 });
    await wait(500);
    if (!phone) lines.push(...(await checkTop(page, vp, "会話")), ...(await checkRule(page, tag, "会話")));
    const form = await topForm(page);
    if (vp === "tablet") {
      if (!form.compact || form.place || form.views || !form.menu || !(form.rest ?? "").startsWith("場所: ")) {
        lines.push(`本番の見出し: タブレットが compact の形でない（compact ${form.compact}・場所 ${form.place}・切り替え ${form.views}・「…」${form.menu}・補足 ${String(form.rest)}）`);
      }
      if (!(form.width < form.min)) lines.push(`本番の見出し: タブレットの列 2 の幅 ${form.width} がしきい値 ${form.min} 未満でない`);
    }
    if (vp === "pc") lines.push(...(await pcPlaceLines(page, tag, "右腕を列で開いた形")));
    lines.push(...(await checkTopLeaks(page, vp, chat)));
    await page.waitForSelector("#ed textarea", { timeout: 5000 });
    // 輪（キーボードで入った形）
    lines.push(...(await checkRings(page, "会話")));
    // 「…」の板: 先頭（スマホ・タブレットは「場所を変える」、PC は無い）・チャンネルの操作・Esc で「…」へ
    await page.click(TOP_MENU);
    await page.waitForSelector("#v3-sheet[open]", { timeout: 5000 });
    const rows = await sheetRows(page);
    for (const want of ["待ちにする", "閉じる", "会話を新しくする"]) if (!rows.includes(want)) lines.push(`本番の見出し: 「…」の板に「${want}」が無い（${rows.join("・")}）`);
    if (vp === "pc" ? rows.includes("場所を変える") : rows[0] !== "場所を変える") lines.push(`本番の見出し: 「…」の板の「場所を変える」の在り方が違う（${rows.join("・")}）`);
    lines.push(...(await checkH1(page, "「…」の板")));
    await shot(page, `${p}-b-top-menu`);
    await escSheet(page);
    if (!(await activeIs(page, TOP_MENU))) lines.push("本番の見出し: 「…」の板を閉じた後の焦点が「…」に無い");
    // 場所の板: スマホ・タブレットは「…」から（閉じたら「…」へ）、PC は場所のボタンから（閉じたら場所のボタンへ）
    if (vp === "pc") {
      await page.click(TOP_PLACE);
    } else {
      await page.click(TOP_MENU);
      await page.waitForSelector("#v3-sheet[open]", { timeout: 5000 });
      await page.locator("#v3-sheet .more-row").first().click();
    }
    await page.waitForSelector('#v3-sheet[open][aria-label="場所を変える"]', { timeout: 5000 });
    lines.push(...(await checkH1(page, "場所の板")));
    await shot(page, `${p}-b-top-place`);
    await escSheet(page);
    if (!(await activeIs(page, vp === "pc" ? TOP_PLACE : TOP_MENU))) lines.push(`本番の見出し: 場所の板を閉じた後の焦点が${vp === "pc" ? "場所のボタン" : "「…」"}に無い`);
    // 右腕（aria-controls の先・見出しの h2・閉じた後の焦点。タブレットは重ねて開いている間も compact のまま）
    if (phone) {
      const controls = await page.evaluate(() => {
        const top = document.querySelector('#c-top-root button[data-act="hand"]');
        const bottom = document.querySelector('#c-bottom-root button[data-act="hand"]');
        const a = top === null ? null : top.getAttribute("aria-controls");
        const b = bottom === null ? null : bottom.getAttribute("aria-controls");
        return { a, b, exists: a !== null && document.getElementById(a) !== null };
      });
      if (controls.a === null || controls.a !== controls.b || !controls.exists) lines.push(`本番の見出し: 右腕のボタンの aria-controls が合わない（見出し ${String(controls.a)}・下のバー ${String(controls.b)}・先 ${controls.exists}）`);
      await page.click(TOP_HAND);
      await page.waitForSelector('#v3[data-hand="open"]', { timeout: 5000 });
      await wait(500);
      const width = await page.evaluate((id: string | null) => (id === null ? 0 : (document.getElementById(id)?.getBoundingClientRect().width ?? 0)), controls.a);
      if (!(width > 0)) lines.push("本番の見出し: aria-controls の先が開いた右腕の入れ物でない（幅 0）");
      lines.push(...(await checkHandHeading(page, "右腕")), ...(await checkH1(page, "右腕")));
      await page.click("#v3-hand-close");
      await page.waitForSelector('#v3[data-hand="closed"]', { timeout: 5000 });
      await wait(300);
      if (!(await activeIs(page, TOP_HAND))) lines.push("本番の見出し: 右腕を畳んだ後の焦点が見出しの [右腕] に無い");
    } else {
      const show = await page.evaluate(() => {
        const id = document.querySelector("#v3-hand-show")?.getAttribute("aria-controls") ?? null;
        return id !== null && document.getElementById(id) !== null;
      });
      if (!show) lines.push("本番の見出し: #v3-hand-show の aria-controls の先が無い");
      if (vp === "tablet") {
        await page.click("#v3-hand-show");
        await page.waitForSelector('#v3[data-hand="open"]', { timeout: 5000 });
        await wait(500);
        const over = await topForm(page);
        if (over.mode !== "over") lines.push(`本番の見出し: タブレットの右腕が重ねる形でない（${String(over.mode)}）`);
        if (!(over.width >= over.min)) lines.push(`本番の見出し: 前提が崩れた。重ねて開いた間の列 2 の幅 ${over.width} がしきい値 ${over.min} 以上でない`);
        if (!over.compact) lines.push("本番の見出し: 重ねた右腕の後ろで見出しが compact でなくなった");
        lines.push(...(await checkHandHeading(page, "右腕")), ...(await checkH1(page, "右腕")));
        await page.click("#v3-hand-close");
        await page.waitForSelector('#v3[data-hand="closed"]', { timeout: 5000 });
        await wait(300);
        if (!(await topForm(page)).compact) lines.push("本番の見出し: 重ねた右腕を畳んだ後に compact でない");
        lines.push(...(await checkRule(page, tag, "右腕を畳んだ後")));
      } else {
        lines.push(...(await checkHandHeading(page, "右腕")), ...(await checkH1(page, "右腕")));
        lines.push(...(await pcWidthLines(page, tag)));
      }
    }
    // 長い題の話題
    const long = await page.evaluate(() => {
      const data = (window as unknown as { SA: { topics: { data: () => { topics: Array<{ id: string; title: string }> } | null } } }).SA.topics.data();
      return data?.topics.find((t) => t.title.startsWith("ファームウェア"))?.id ?? null;
    });
    if (long === null) lines.push("本番の見出し: 作り物のデータに長い題の話題が無い");
    else {
      await load(page, "/static/v3.html#/" + long.replace(":", "/"));
      await page.waitForSelector("#ed textarea", { timeout: 5000 });
      await wait(500);
      lines.push(...(await checkTop(page, vp, "長い題", { ed: phone })), ...(await longTitleLines(page, vp, "長い題")));
      if (vp !== "phone") lines.push(...(await checkRule(page, tag, "長い題")));
      lines.push(...(await withMono(page, () => longTitleLines(page, vp, "長い題・等幅の字"))));
      if (phone) {
        await page.setViewportSize({ width: 375, height: 812 });
        await wait(300);
        lines.push(...(await checkTop(page, vp, "長い題・幅 375", { hits: false })));
        lines.push(...(await withMono(page, () => longTitleLines(page, vp, "長い題・幅 375・等幅の字"))));
        await page.setViewportSize(VIEWPORTS.phone.viewport);
        await wait(300);
      }
      await shot(page, `${p}-b-top-long`);
    }
    // ほかの画面: 設定（題・#ed に h1 が無い）と状態（例外が出ない）
    await load(page, "/static/v3.html#/settings");
    await page.waitForSelector("#ed .ed-section", { timeout: 5000 });
    const settings = await page.evaluate(() => ({ title: document.querySelector("#c-top-root .c-top-title")?.textContent ?? null, h1: document.querySelectorAll("#ed h1").length }));
    if (settings.title !== "設定" || settings.h1 !== 0) lines.push(`本番の見出し: 設定の題が「${String(settings.title)}」・#ed の h1 が ${settings.h1} 個`);
    lines.push(...(await checkTop(page, vp, "設定", { hits: false })));
    const errorsBefore = logLines.filter((line) => line.includes("pageerror")).length;
    await page.evaluate(() => (window as unknown as { SA: { app: { open: (id: string) => void } } }).SA.app.open("status"));
    await wait(800);
    const status = await page.evaluate(() => document.querySelector("#c-top-root .c-top-title")?.textContent ?? null);
    if (status !== "状態") lines.push(`本番の見出し: 状態の題が「${String(status)}」`);
    if (logLines.filter((line) => line.includes("pageerror")).length !== errorsBefore) lines.push("本番の見出し: 状態を開くと pageerror が出る");
    lines.push(...(await checkTop(page, vp, "状態", { hits: false })));
    return lines;
  }

  /** PC の場所のボタン（右腕を畳んだ形と列で開いた形）: compact でない・字は名前だけ・読み上げは「場所: 」付き・動かせない話題は aria-disabled（native の disabled なし） */
  async function pcPlaceLines(page: Page, tag: string, label: string): Promise<string[]> {
    const lines: string[] = [];
    const check = async (at: string): Promise<void> => {
      const f = await topForm(page);
      if (f.compact || !f.place) lines.push(`本番の見出し: PC が compact の形（compact ${f.compact}・場所 ${f.place}。${at}）`);
      if (!(f.width >= f.min)) lines.push(`本番の見出し: PC の列 2 の幅 ${f.width} がしきい値 ${f.min} 以上でない（${at}）`);
      lines.push(...(await checkRule(page, tag, at)));
      const b = await page.evaluate(() => {
        const el = document.querySelector("#c-top-root button.c-top-place");
        return el === null ? null : { text: (el.textContent ?? "").trim(), label: el.getAttribute("aria-label") };
      });
      if (b === null) return;
      if (b.text.startsWith("場所: ") || b.label !== "場所: " + b.text) lines.push(`本番の見出し: 場所のボタンの字「${b.text}」・名前「${String(b.label)}」（${at}）`);
    };
    await check(label);
    // 右腕を畳んだ形
    await page.click("#v3-hand-close");
    await page.waitForSelector('#v3[data-hand="closed"]', { timeout: 5000 });
    await wait(300);
    await check("右腕を畳んだ形");
    // 動かせない話題
    await loadEdited(page, (json) => {
      for (const t of json.topics) if (t.id === `ch:${open}`) t.movable = { reason: "場所を変えています" };
    });
    const locked = await page.evaluate(() => {
      const el = document.querySelector("#c-top-root button.c-top-place");
      return el === null ? null : { aria: el.getAttribute("aria-disabled"), native: el.hasAttribute("disabled") };
    });
    if (locked === null || locked.aria !== "true" || locked.native) lines.push(`本番の見出し: 動かせない話題の場所のボタンが aria-disabled でない（${JSON.stringify(locked)}）`);
    await page.evaluate(() => (window as unknown as { SA: { topics: { load: () => Promise<void> } } }).SA.topics.load());
    await wait(300);
    await page.click("#v3-hand-show");
    await page.waitForSelector('#v3[data-hand="open"]', { timeout: 5000 });
    await wait(300);
    return lines;
  }

  /** PC の幅を変える検査（右腕の列で替わる・幅をまたいで戻る・またいだときの焦点）。終わったら幅を戻す */
  async function pcWidthLines(page: Page, tag: string): Promise<string[]> {
    const lines: string[] = [];
    const size = async (width: number): Promise<void> => {
      await page.setViewportSize({ width, height: VIEWPORTS.pc.viewport.height });
      await wait(400);
    };
    const at = async (label: string, want: boolean): Promise<void> => {
      const f = await topForm(page);
      if (f.compact !== want) lines.push(`本番の見出し: ${label} で compact ${f.compact}（${want} のはず）`);
      lines.push(...(await checkTop(page, "pc", label, { hits: false })), ...(await checkRule(page, tag, label)));
    };
    try {
      // 右腕の列で替わる（幅 1100）
      await size(1100);
      if ((await topForm(page)).hand === "open") {
        await page.click("#v3-hand-close");
        await page.waitForSelector('#v3[data-hand="closed"]', { timeout: 5000 });
        await wait(300);
      }
      await at("幅 1100・右腕を畳んだ形", false);
      await page.click("#v3-hand-show");
      await page.waitForSelector('#v3[data-hand="open"][data-hand-mode="column"]', { timeout: 5000 });
      await wait(300);
      await at("幅 1100・右腕を列で開いた形", true);
      await shot(page, "pc-dark-b-top-hand-col");
      await page.click("#v3-hand-close");
      await page.waitForSelector('#v3[data-hand="closed"]', { timeout: 5000 });
      await wait(300);
      await at("幅 1100・畳み直した形", false);
      // 幅をまたいで戻る（1440 → 800 → 1440）
      await size(1440);
      await at("幅 1440", false);
      await size(800);
      const narrow = await topForm(page);
      if (narrow.mode !== "over") lines.push(`本番の見出し: 幅 800 の右腕が重ねる形でない（${String(narrow.mode)}）`);
      await at("幅 800", true);
      await size(1440);
      await at("幅 1440 に戻した所", false);
      if (!(await topForm(page)).place) lines.push("本番の見出し: 幅 1440 に戻しても場所のボタンが無い");
      // またいだときの焦点: 場所のボタン → 800 で「…」、戻しても「…」。「…」は往復しても「…」
      await page.focus(TOP_PLACE);
      await size(800);
      if (!(await activeIs(page, TOP_MENU))) lines.push("本番の見出し: 場所のボタンに焦点があるまま compact に替わった後の焦点が「…」に無い");
      await size(1440);
      if (!(await activeIs(page, TOP_MENU))) lines.push("本番の見出し: compact から戻った後の焦点が「…」に無い");
      await page.focus(TOP_MENU);
      for (const width of [800, 1440]) {
        await size(width);
        if (!(await activeIs(page, TOP_MENU))) lines.push(`本番の見出し: 「…」に焦点があるまま幅 ${width} にした後の焦点が「…」に無い`);
      }
    } finally {
      await page.setViewportSize(VIEWPORTS.pc.viewport);
      await wait(300);
    }
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
        // 絞り込み欄の箱の左端は一覧の列の左から 16（スマホ・PC）
        if (vp !== "tablet") {
          await page.click("#v3-search-toggle");
          await page.waitForSelector("#v3-search", { timeout: 5000 });
          const left = await page.evaluate(() => {
            const input = document.querySelector("#v3-search");
            const list = document.querySelector("#v3-list");
            return input === null || list === null ? null : input.getBoundingClientRect().left - list.getBoundingClientRect().left;
          });
          if (left === null || Math.abs(left - 16) > 0.5) problems.push(`絞り込み欄の左端が ${String(left)}（16 のはず）`);
          await page.click("#v3-search-toggle");
          await wait(200);
        }
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
        // 本番の見出し（軽い分。ライトはここで見る）
        const problems = await checkTop(page, vp, "会話");
        for (const line of problems) logLines.push(`[v3-${p}] ${line}`);
        if (problems.length > 0) throw new Error(`見出しの検査で ${problems.length} 件`);
        await page.evaluate(() => {
          for (const el of document.querySelectorAll("#ed *")) {
            if (el.scrollHeight > el.clientHeight + 4 && getComputedStyle(el).overflowY !== "visible") el.scrollTop = Math.round((el.scrollHeight - el.clientHeight) * 0.45);
          }
        });
        await shot(page, `${p}-b-chat-middle`);
        await scrollBottom(page);
        await shot(page, `${p}-b-chat-bottom`);
      });
      // 本番の見出しの段（ダークの 3 組）
      if (theme === "dark") {
        const tops = [`${p}-b-top-long`, `${p}-b-top-menu`, `${p}-b-top-place`, ...(vp === "pc" ? [`${p}-b-top-hand-col`] : [])];
        await step(`${p} t`, tops, async () => {
          const problems = await topStage(page, vp, p);
          for (const line of problems) logLines.push(`[v3-${p}] ${line}`);
          if (problems.length > 0) throw new Error(`見出しの段の検査で ${problems.length} 件`);
        });
      }
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
          await page.waitForSelector('#ed .c-msg[data-who="agent"]', { timeout: 5000 });
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
        const problems = await checkTop(page, vp, "設定", { hits: false });
        for (const line of problems) logLines.push(`[v3-${p}] ${line}`);
        if (problems.length > 0) throw new Error(`見出しの検査で ${problems.length} 件`);
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
        // 古い殻に部品（c-*）と見出しの入口は無く、今の見出しが在る
        const old = await page.evaluate(() => ({
          parts: document.querySelectorAll('[class^="c-"], [class*=" c-"]').length,
          toolbar: document.querySelector("#ed .ed-toolbar") !== null,
          top: (window as unknown as { SA?: { top?: unknown } }).SA?.top === undefined,
        }));
        const problems = [
          ...(old.parts !== 0 ? [`古い殻に c- のクラスの要素が ${old.parts} 個`] : []),
          ...(!old.toolbar ? ["古い殻の #ed に .ed-toolbar が無い"] : []),
          ...(!old.top ? ["古い殻に window.SA.top が在る"] : []),
        ];
        for (const line of problems) logLines.push(`[${label}] ${line}`);
        if (problems.length > 0) throw new Error(`古い殻の検査で ${problems.length} 件`);
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
      targets: 'button, a[href]:not(.c-md-link), input, select, textarea, [role="radio"]',
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
    const args = { height: TOP_H[vp], titleMin: TOP_TITLE_MIN, placeMin: TOP_PLACE_MIN, boxes: TOP_BOX, demos: TOP_DEMOS };
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

  /**
   * 見本の会話（talkProblems）を、今の字・等幅の字・（スマホは）幅 375 の等幅の字で測る。
   * 足りない物は 1 行ずつ console.log に書き、1 つでもあれば投げて段を失敗にする
   */
  async function checkTalks(page: Page, vp: Viewport, label: string): Promise<void> {
    const args = { demos: TALK_DEMOS, max: TALK_MAX[vp], fontSize: TALK_FONT[vp] };
    const lines = await page.evaluate(talkProblems, { ...args, label: "今の字" });
    lines.push(...(await withMono(page, () => page.evaluate(talkProblems, { ...args, label: "等幅の字" }), "見本の会話")));
    if (vp === "phone") {
      try {
        await page.setViewportSize({ width: 375, height: 812 });
        await wait(300);
        lines.push(...(await withMono(page, () => page.evaluate(talkProblems, { ...args, label: "幅 375・等幅の字" }), "見本の会話")));
      } finally {
        await page.setViewportSize(VIEWPORTS.phone.viewport);
        await wait(300);
      }
    }
    for (const line of lines) logLines.push(`[${label}] ${line}`);
    if (lines.length > 0) throw new Error(`会話の見本の検査で ${lines.length} 件`);
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
      // 一覧・見出し・下のバー・会話の節の絵は、ページ全体と同じ読み込みで検査と位置の戻しの後に撮る
      const parts = [
        { name: galleryName(vp, theme, "g-list"), selector: '[data-section="list"]' },
        { name: galleryName(vp, theme, "g-top"), selector: '[data-section="top"]' },
        { name: galleryName(vp, theme, "g-bottom"), selector: '[data-section="bottom"]' },
        { name: galleryName(vp, theme, "g-talk"), selector: '[data-section="talk"]' },
      ];
      await step(full, [full, ...parts.map((part) => part.name)], async () => {
        await loadGallery();
        await checkGallery(page, vp, label);
        await checkTalks(page, vp, label);
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
