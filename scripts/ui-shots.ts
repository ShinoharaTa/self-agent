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
import type { Browser, BrowserContext, Page, Request as PageRequest, Route } from "playwright-core";
import { type FixtureServer, startFixtureServer } from "./ui-shots-fixture.ts";

const USAGE = "使い方: npm run ui-shots -- --out <dir> [--only <名前の一部>]（<dir> はリポジトリの外）";
const INSTALL_HINT = "Chromium が見つからない。`npx playwright-core@1.58.2 install chromium-headless-shell` で入れる";
const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));

type Viewport = "phone" | "pc" | "tablet";
/** /api/topics の応答のうち、検査で書き換える所 */
/** /api/channels/<id>/turns の応答（段 r が channel を書き換える） */
type TurnsJson = { turns: unknown[]; channel: Record<string, unknown> | null };
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

/** settled の静けさの窓（ms。DOM の変更がこれだけ続けて無ければ落ち着いた）と上限（ms） */
const SETTLE_QUIET_MS = 100;
const SETTLE_LIMIT_MS = 5000;

/** page ごとの飛んでいる要求（contextFor で 1 回だけ仕掛ける） */
const inflight = new WeakMap<Page, Set<PageRequest>>();

function trackRequests(page: Page): void {
  const pending = new Set<PageRequest>();
  inflight.set(page, pending);
  page.on("request", (r) => pending.add(r));
  page.on("requestfinished", (r) => pending.delete(r));
  page.on("requestfailed", (r) => pending.delete(r));
}

/**
 * 上限まで待っても終わらなかった要求を忘れ、その名前（メソッドとパス）を返す。
 * finished も failed も来ない要求を残すと、以後の settled が毎回上限まで待つ（1 回の実行が何倍にも延びる）
 */
function forgetStuck(page: Page): string[] {
  const pending = inflight.get(page);
  if (pending === undefined) return [];
  const names = [...pending].map((r) => `${r.method()} ${new URL(r.url()).pathname}`);
  pending.clear();
  return names;
}

/**
 * 落ち着くまで待つ: 飛んでいる要求が 0・DOM の変更が SETTLE_QUIET_MS 続けて無い・終わりの在る動きが走っていない。
 * 落ち着いたら ""。上限に達したら、待っていた物（"要求" か "画面"）を返す（呼ぶ側が失敗として記録する）。
 * 無限の animation は除く。1 秒刻みの書き換えは窓の間に取れる
 */
async function settledWithin(page: Page, limit: number): Promise<"" | "要求" | "画面"> {
  const until = Date.now() + limit;
  const pending = inflight.get(page);
  for (;;) {
    while ((pending?.size ?? 0) > 0) {
      if (Date.now() >= until) return "要求";
      await wait(20);
    }
    const left = until - Date.now();
    if (left <= 0) return "要求";
    const quiet = await page.evaluate(
      ({ quietMs, leftMs }: { quietMs: number; leftMs: number }) =>
        new Promise<boolean>((done) => {
          const end = Date.now() + leftMs;
          let last = Date.now();
          const obs = new MutationObserver(() => {
            last = Date.now();
          });
          obs.observe(document.documentElement, { subtree: true, childList: true, attributes: true, characterData: true });
          const moving = (): boolean =>
            document.getAnimations().some((a) => a.playState === "running" && Number.isFinite(Number(a.effect?.getComputedTiming().endTime)));
          const tick = (): void => {
            const now = Date.now();
            if (now > end) {
              obs.disconnect();
              done(false);
            } else if (now - last >= quietMs && !moving()) {
              obs.disconnect();
              done(true);
            } else setTimeout(tick, 20);
          };
          setTimeout(tick, quietMs);
        }),
      { quietMs: SETTLE_QUIET_MS, leftMs: left },
    );
    if (!quiet) return "画面";
    if ((pending?.size ?? 0) === 0) return "";
  }
}

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
    // 流れの列（D1。640px 以上の 3 組）: 帯と 3 列の所と、項目から席を開いた所
    ...(vp !== "phone" ? ["a-deck", "a-deck-seat"] : []),
    "b-chat-top",
    "b-chat-middle",
    "b-chat-bottom",
    // 本番の見出し（段 t。ダークの 3 組。PC は幅 1100 で右腕を列で開いた所も）
    ...(theme === "dark" ? ["b-top-long", "b-top-menu", "b-top-place", ...(vp === "pc" ? ["b-top-hand-col"] : [])] : []),
    // 本番の会話の行（段 k。ダークの 3 組。スマホは幅 375・等幅の字も）
    ...(theme === "dark" ? ["b-talk-rows", "b-talk-steps-open", "b-talk-run", "b-talk-long", ...(vp === "phone" ? ["b-talk-long-open", "b-talk-mono375"] : [])] : []),
    // 本番の入力欄（段 n。ダークの 3 組。字数の絵はスマホだけ）
    ...(theme === "dark" ? ["b-composer-empty", "b-composer-6lines", ...(vp === "phone" ? ["b-composer-count"] : [])] : []),
    // 本番のカード（段 r。ダークの 3 組）
    ...(theme === "dark" ? ["b-cards-close", "b-cards-move", "b-cards-other", "b-cards-sending"] : []),
    // 知らせと確認（段 u。ダークのスマホと PC）
    ...(theme === "dark" && vp !== "tablet" ? ["u-notice", "u-notice-error", "u-confirm"] : []),
    ...(full
      ? ["b-chat-permission", "b-chat-question", "d-composer-3lines", vp === "phone" ? "c-hand-over" : "c-hand-column", ...(vp === "phone" ? [] : ["c-hand-with-chat"]), "e-start-dialog", "f-settings", "f-knowledge-list", "f-knowledge-detail"]
      : []),
  ].map((n) => `${vp}-${theme}-${n}`);
}

const oldShellNames = (vp: Viewport): string[] => [`old-${vp}-dark-list`, `old-${vp}-dark-chat`];

/** Claude Code のチャンネルの段 cc（2 つ目のサーバー。ダークの 3 組）。今のサーバーに足すとほかの絵が変わるので分ける */
const CC_SHELLS: ReadonlyArray<Viewport> = ["phone", "pc", "tablet"];
const ccShellNames = (vp: Viewport): string[] =>
  ["b-cc-status", "b-cc-sent", "b-cc-permission", "b-cc-ended", "b-cc-ended-screen", "b-cc-term", "b-cc-term-confirm"].map((n) => `${vp}-dark-${n}`);

/** 部品の見本のページ（/static/gallery.html。K1・K2）を撮る組 */
const GALLERY_SHOTS: ReadonlyArray<{ vp: Viewport; theme: Theme }> = [
  { vp: "phone", theme: "dark" },
  { vp: "phone", theme: "light" },
  { vp: "pc", theme: "dark" },
  { vp: "pc", theme: "light" },
];
/** 見本の絵の種類（g-gallery はページ全体、g-list・g-top・g-bottom・g-talk・g-composer・g-cards・g-hand・g-term・g-deck はその節の要素の絵（K3〜K6 と端末のセッションの札と流れの列）、ほかは押して開いた所） */
const GALLERY_KINDS = ["g-gallery", "g-list", "g-top", "g-bottom", "g-talk", "g-composer", "g-cards", "g-hand", "g-term", "g-deck", "g-sheet", "g-confirm", "g-toast"] as const;
type GalleryKind = (typeof GALLERY_KINDS)[number];
const galleryName = (vp: Viewport, theme: Theme, kind: GalleryKind): string => `${vp}-${theme}-${kind}`;

/** 押せる物の当たりの下限（px。指の端末 44・PC 36。docs/plan/web-ui-components.md §9 の K2） */
const HIT_MIN: Record<Viewport, number> = { phone: 44, tablet: 44, pc: 36 };

/**
 * 当たりの測り方（ブラウザの中で動く。page.evaluate に渡すので外の変数を使わない）。scopes の中の targets の見えている物を、
 * 見える所へ送ってから箱の中心から (±d, ±d) の 4 点で elementFromPoint がその要素（か子孫）を返すかで見る（d = 下限 / 2 - 1）。
 * toast なら、知らせ（position: fixed）の下に隠れた点は数えない。label が包むチェック・ラジオは label の箱で測る。足りない物の文を返す
 */
function hitProblems({ min, scopes, targets, toast }: { min: number; scopes: string; targets: string; toast: boolean }): string[] {
  const lines: string[] = [];
  const els = new Set<Element>();
  for (const scope of document.querySelectorAll(scopes)) {
    for (const el of scope.querySelectorAll(targets)) if (el.getClientRects().length > 0) els.add(el);
  }
  const d = min / 2 - 1;
  for (const el of els) {
    // label が包むチェック・ラジオは、押せる所が label の箱なので label で測る
    const box = el instanceof HTMLInputElement && (el.type === "checkbox" || el.type === "radio") ? (el.closest("label") ?? el) : el;
    box.scrollIntoView({ block: "center", inline: "center" });
    const r = box.getBoundingClientRect();
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
      return hit !== null && (hit === box || box.contains(hit) || (toast && !inToast && hit.closest(".c-toast-item") !== null));
    });
    if (!ok) lines.push(`当たりが足りない: ${el.tagName.toLowerCase()}.${el.classList[0] ?? ""} ${Math.round(r.width)}x${Math.round(r.height)}`);
  }
  return lines;
}

/**
 * 知らせの文。role は status（知らせ）か alert（失敗）。ブラウザの中で動く。
 * 部品の #c-notice-root と、口が描けなかったときの古い入れ物（#toast・#toast-alert）の両方を読む（「知らせが出ない」の検査が古い道で空振りしない）
 */
function noticeText(role: "status" | "alert"): string {
  const part = document.querySelector(`#c-notice-root .c-toast-list[role="${role}"]`)?.textContent ?? "";
  const old = document.querySelector(role === "alert" ? "#toast-alert" : "#toast")?.textContent ?? "";
  return (part + old).trim();
}

/** 知らせの文に text が在るか（text が空なら何か在るか）。waitForFunction に渡す */
function noticeHas({ role, text }: { role: "status" | "alert"; text: string }): boolean {
  const now = (document.querySelector(`#c-notice-root .c-toast-list[role="${role}"]`)?.textContent ?? "").trim();
  return text === "" ? now !== "" : now.includes(text);
}

/** 見本の入力欄の data-demo（ページの順） */
const COMPOSER_DEMOS = ["empty", "one", "three", "eight", "long-line", "near", "over", "sending", "narrow", "sent-done", "sent-warning", "sent-cancel"];

/**
 * 見本の入力欄の測り方（ブラウザの中で動く。page.evaluate に渡すので外の変数を使わない）。行の高さは欄の line-height から計算する。
 * 見本の名前・1 行の高さ（--c-tap）・3 行と 8 行の高さ（8 行は 6 行で止まり中で送る）・写しが見えず欄と同じ箱・［送る］の大きさと下端・
 * 字数（near・over だけ。ほかは入れ物の高さ 0。over は --danger）・横にはみ出さない・スマホの字・
 * 送った本文の帯（sent-* だけ中身が在り、欄の行の上・色は tone のとおり・sent-cancel だけ［やめる］。ほかは高さ 0）。足りない物の文を返す
 */
function composerProblems({ demos, phone, label }: { demos: string[]; phone: boolean; label: string }): string[] {
  const lines: string[] = [];
  const say = (text: string): void => void lines.push(`入力欄（${label}）: ${text}`);
  const near = (a: number, b: number, d: number): boolean => Math.abs(a - b) <= d;
  const section = document.querySelector('[data-section="composer"]');
  if (section === null) return [`入力欄（${label}）: 節が無い`];
  const names = [...section.querySelectorAll("[data-demo]")].map((el) => el.getAttribute("data-demo") ?? "?");
  for (const name of demos) if (!names.includes(name)) say(`見本が無い: ${name}`);
  for (const name of names) if (!demos.includes(name)) say(`知らない見本: ${name}`);
  const tap = parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--c-tap"));
  if (!(tap > 0)) say("--c-tap が読めない");
  const probe = document.createElement("span");
  probe.style.color = "var(--danger)";
  section.append(probe);
  const danger = getComputedStyle(probe).color;
  probe.style.color = "var(--success)";
  const success = getComputedStyle(probe).color;
  probe.style.color = "var(--warning)";
  const warning = getComputedStyle(probe).color;
  probe.style.color = "var(--text-muted)";
  const muted = getComputedStyle(probe).color;
  probe.remove();
  const sectionRight = section.getBoundingClientRect().right;
  for (const demo of names) {
    const box = section.querySelector(`[data-demo="${demo}"]`);
    const ta = box?.querySelector("textarea.c-composer-input");
    const mirror = box?.querySelector(".c-composer-mirror");
    const send = box?.querySelector(".c-composer-row > .c-btn");
    const count = box?.querySelector(".c-composer-count");
    const root = box?.querySelector(".c-composer");
    if (!(ta instanceof HTMLTextAreaElement) || mirror == null || send == null || count == null || root == null) {
      say(`${demo} の欄・写し・［送る］・字数の入れ物のどれかが無い`);
      continue;
    }
    const cs = getComputedStyle(ta);
    const lh = parseFloat(cs.lineHeight);
    const r = ta.getBoundingClientRect();
    // 1〜3. 高さ
    const want = demo === "three" ? tap + lh * 2 : demo === "eight" ? tap + lh * 5 : demo === "long-line" ? null : tap;
    if (want !== null && !near(r.height, want, demo === "three" || demo === "eight" ? 1 : 0.5)) say(`${demo} の欄の高さ ${r.height.toFixed(1)}。${want.toFixed(1)} のはず（行の高さ ${lh}）`);
    if (demo === "eight" && !(ta.scrollHeight > ta.clientHeight)) say(`eight の欄が中で送れない（${ta.scrollHeight} <= ${ta.clientHeight}）`);
    if (demo !== "eight" && demo !== "long-line" && ta.scrollHeight > ta.clientHeight + 1) say(`${demo} の欄が中で送れる（${ta.scrollHeight} > ${ta.clientHeight}）`);
    // 4. 写し
    const m = mirror.getBoundingClientRect();
    const ms = getComputedStyle(mirror);
    if (ms.visibility !== "hidden") say(`${demo} の写しが見えている`);
    // 箱は升に引き伸ばされて同じになるので、中の字の置き場（余白・枠の太さ・字・折り返し）も比べる
    for (const prop of ["paddingTop", "paddingRight", "paddingBottom", "paddingLeft", "borderTopWidth", "borderRightWidth", "borderBottomWidth", "borderLeftWidth", "fontFamily", "fontSize", "lineHeight", "whiteSpace", "overflowWrap", "boxSizing"] as const) {
      if (ms[prop] !== cs[prop]) say(`${demo} の写しの ${prop} ${ms[prop]} が欄の ${cs[prop]} と違う`);
    }
    if (![["left", m.left, r.left], ["top", m.top, r.top], ["width", m.width, r.width], ["height", m.height, r.height]].every(([, a, b]) => near(Number(a), Number(b), 0.5))) {
      say(`${demo} の写しの箱 ${m.left.toFixed(1)},${m.top.toFixed(1)} ${m.width.toFixed(1)}x${m.height.toFixed(1)} が欄 ${r.left.toFixed(1)},${r.top.toFixed(1)} ${r.width.toFixed(1)}x${r.height.toFixed(1)} と違う`);
    }
    // 5. ［送る］
    const b = send.getBoundingClientRect();
    if (b.width < 44 || b.height < 44) say(`${demo} の［送る］が ${b.width.toFixed(1)}x${b.height.toFixed(1)}。44 以上のはず`);
    if (!near(b.bottom, r.bottom, 0.5)) say(`${demo} の［送る］の下端 ${b.bottom.toFixed(1)} が欄の下端 ${r.bottom.toFixed(1)} と揃っていない`);
    // 6. 字数
    const text = box?.querySelector(".c-composer-count-text") ?? null;
    if (demo === "near" || demo === "over") {
      if (text === null || (text.textContent ?? "") === "") say(`${demo} に字数が無い`);
      else if (demo === "over" && getComputedStyle(text).color !== danger) say(`over の字数の色 ${getComputedStyle(text).color}。--danger（${danger}）のはず`);
      else if (demo === "near" && getComputedStyle(text).color === danger) say("near の字数が --danger の色");
    } else {
      if (text !== null) say(`${demo} に字数が出ている`);
      if (count.getBoundingClientRect().height !== 0) say(`${demo} の字数の入れ物の高さ ${count.getBoundingClientRect().height}。0 のはず`);
    }
    // 7. はみ出し
    if (ta.scrollWidth > ta.clientWidth) say(`${demo} の欄が横にはみ出している（${ta.scrollWidth} > ${ta.clientWidth}）`);
    if (root.scrollWidth > root.clientWidth) say(`${demo} の入力欄が横にはみ出している（${root.scrollWidth} > ${root.clientWidth}）`);
    if (root.getBoundingClientRect().right > sectionRight + 0.5) say(`${demo} の入力欄が節の幅を超えている`);
    // 8. スマホの字
    if (phone && parseFloat(cs.fontSize) < 16) say(`${demo} の欄の字 ${cs.fontSize}。16px 以上のはず`);
    // 9. 送った本文の帯（いつも根の最初の子。sent-* でなければ空で高さ 0）
    const sent = root.firstElementChild;
    if (sent === null || !sent.classList.contains("c-composer-sent")) {
      say(`${demo} の根の最初の子が送った本文の帯でない`);
      continue;
    }
    const sr = sent.getBoundingClientRect();
    const cancels = sent.querySelectorAll(".c-btn");
    if (!demo.startsWith("sent-")) {
      if (sent.childElementCount !== 0 || sr.height !== 0) say(`${demo} の送った本文の帯が空でない（子 ${sent.childElementCount}・高さ ${sr.height}）`);
      continue;
    }
    if ((sent.querySelector(".c-composer-sent-text")?.textContent ?? "") === "") say(`${demo} の送った本文の帯に文が無い`);
    if (!(sr.height > 0) || sr.bottom > r.top + 0.5) say(`${demo} の送った本文の帯が欄の行の上に無い（帯の下端 ${sr.bottom.toFixed(1)}・欄の上端 ${r.top.toFixed(1)}）`);
    const tone = getComputedStyle(sent).color;
    const toneWant = demo === "sent-done" ? success : demo === "sent-warning" ? warning : muted;
    if (tone !== toneWant) say(`${demo} の送った本文の帯の色 ${tone}。${toneWant} のはず`);
    if (cancels.length !== (demo === "sent-cancel" ? 1 : 0)) say(`${demo} の送った本文の帯の［やめる］の数 ${cancels.length}`);
  }
  // narrow の入れ物（枠を含めて 320）が狭すぎず広すぎない（検査が空振りしない）
  const narrow = section.querySelector('[data-demo="narrow"] > *');
  if (narrow === null || !near(narrow.getBoundingClientRect().width, 320, 0.5)) say(`narrow の入れ物の幅 ${narrow?.getBoundingClientRect().width.toFixed(1) ?? "?"}。320 のはず`);
  const doc = document.documentElement;
  if (doc.scrollWidth > doc.clientWidth) say(`ページが横に動く（${doc.scrollWidth} > ${doc.clientWidth}）`);
  return lines;
}

/** 見本のカードの data-demo（ページの順） */
const CARD_DEMOS = ["card-perm", "card-perm-rule", "card-perm-urgent", "card-perm-busy", "card-perm-long", "card-q-one", "card-q-two", "card-q-other", "card-q-busy", "card-q-session", "card-close", "card-close-picked", "card-close-none", "card-move", "card-note", "card-status", "card-narrow"];

/** 見本の札の data-demo（ページの順）と、［取り込む］を押せる物 */
const TERM_DEMOS = ["ready", "ended", "busy", "waiting", "blocked", "checking", "taking", "lost", "error", "long"];
const TERM_TAKEABLE = ["ready", "ended"];
/** ［取り込む］を押せず、下の文が在るはずの物 */
const TERM_BLOCKED = ["busy", "waiting", "blocked", "checking", "taking", "lost"];
/** 見本 error の下の文（c-gallery.js の見本と同じ文） */
const TERM_ERROR = "取り込めませんでした: 端末の画面が待機の状態ではありません（書きかけ・ダイアログ・操作の直後）";

/**
 * 見本の札の測り方（ブラウザの中で動く。page.evaluate に渡すので外の変数を使わない）。見本の名前と順・札が 1 つずつ・［取り込む］の押せる・押せないと下の文・
 * error の失敗の文（role=alert）と long の文なし・long の札と題と場所が横にはみ出さない・ボタンの並び（スマホは縦で幅がそろう、PC は横 1 行。幅 320 の long は折り返してよい）・
 * RC のリンクの高さ（スマホも PC も 44 以上）。足りない物の文を返す
 */
function termProblems({ demos, takeable, blocked, error, phone, label }: { demos: string[]; takeable: string[]; blocked: string[]; error: string; phone: boolean; label: string }): string[] {
  const lines: string[] = [];
  const say = (text: string): void => void lines.push(`札（${label}）: ${text}`);
  const section = document.querySelector('[data-section="term"]');
  if (section === null) return [`札（${label}）: 節が無い`];
  const names = [...section.querySelectorAll("[data-demo]")].map((el) => el.getAttribute("data-demo") ?? "?");
  if (names.join(",") !== demos.join(",")) say(`見本の並び ${names.join(",")}（${demos.join(",")} のはず）`);
  const takeOf = (demo: string): Element | null => section.querySelector(`[data-demo="${demo}"] .c-term .c-term-actions > button.c-btn`);
  for (const demo of demos) {
    const count = section.querySelectorAll(`[data-demo="${demo}"] .c-term`).length;
    if (count !== 1) say(`${demo} の札が ${count}（1 のはず）`);
  }
  for (const demo of takeable) {
    const take = takeOf(demo);
    if (take === null) say(`${demo} に［取り込む］が無い`);
    else if (take.hasAttribute("aria-disabled")) say(`${demo} の［取り込む］に aria-disabled が在る`);
  }
  for (const demo of blocked) {
    const take = takeOf(demo);
    if (take === null) say(`${demo} に［取り込む］が無い`);
    else if (take.getAttribute("aria-disabled") !== "true") say(`${demo} の［取り込む］の aria-disabled が ${JSON.stringify(take.getAttribute("aria-disabled"))}（"true" のはず）`);
    const note = (section.querySelector(`[data-demo="${demo}"] .c-term-note`)?.textContent ?? "").trim();
    if (note === "") say(`${demo} の下の文が空`);
  }
  // error は押せて、下の文が見本の失敗の文で role=alert。long は押せて、下の文なし
  for (const demo of ["error", "long"]) {
    const take = takeOf(demo);
    if (take === null) say(`${demo} に［取り込む］が無い`);
    else if (take.hasAttribute("aria-disabled")) say(`${demo} の［取り込む］に aria-disabled が在る`);
  }
  const errorNote = section.querySelector('[data-demo="error"] .c-term-note');
  if (errorNote === null) say("error の下の文が無い");
  else {
    if ((errorNote.textContent ?? "").trim() !== error) say(`error の下の文が ${JSON.stringify(errorNote.textContent)}（見本の失敗の文のはず）`);
    if (errorNote.getAttribute("role") !== "alert") say(`error の下の文の role が ${JSON.stringify(errorNote.getAttribute("role"))}（alert のはず）`);
  }
  if (section.querySelector('[data-demo="long"] .c-term-note') !== null) say("long に下の文が在る");
  // long の札・題・場所の値が横にはみ出さない
  const long = section.querySelector('[data-demo="long"] .c-term');
  if (long === null) say("long の札が無い");
  else {
    const box = long.getBoundingClientRect();
    for (const el of [long, ...long.querySelectorAll(".c-term-title, .c-term-dd")]) {
      const r = el.getBoundingClientRect();
      if (el.scrollWidth > el.clientWidth || r.right > box.right + 0.5) say(`long の ${el.className} が横にはみ出している（${el.scrollWidth} > ${el.clientWidth}）`);
    }
  }
  // ボタンの並び
  for (const actions of section.querySelectorAll(".c-term-actions")) {
    const demo = actions.closest("[data-demo]")?.getAttribute("data-demo") ?? "?";
    const rects = [...actions.children].map((b) => b.getBoundingClientRect());
    const tops = new Set(rects.map((b) => Math.round(b.top)));
    if (phone) {
      if (tops.size !== rects.length) say(`${demo} のボタン（${rects.length}）が縦に並んでいない`);
      if (new Set(rects.map((b) => b.width.toFixed(1))).size !== 1) say(`${demo} のボタンの幅がそろっていない`);
    } else if (tops.size !== 1 && demo !== "long") say(`${demo} のボタン（${rects.length}）が 1 行に並んでいない`);
  }
  // RC のリンクの高さ（スマホも PC も）
  const links = section.querySelectorAll(".c-term-link");
  if (links.length === 0) say("RC のリンクが 1 つも無い");
  for (const link of links) {
    const h = link.getBoundingClientRect().height;
    if (h < 44) say(`${link.closest("[data-demo]")?.getAttribute("data-demo") ?? "?"} の RC のリンクの高さ ${h.toFixed(1)}。44 以上のはず`);
  }
  return lines;
}

/**
 * 見本のカードの測り方（ブラウザの中で動く。page.evaluate に渡すので外の変数を使わない）。見本の名前・枠の線と角と地と幅・見出しの字・
 * ボタンの高さと並び（スマホは 2 つが 2 等分・3 つが縦、PC は左から 1 行）・チェックの行と印の大きさ・要約の高さ（PC は 8 行で止まる）・
 * 残り時間の色・待ちの行の role・動いている物（状態の行の送っている間の輪のほかは無い）・narrow の幅・横にはみ出さない・質問の「その他」の欄（見える物と値・スマホの字）と問の間の線と［答える］の押せない印・
 * 状態の行（role=status が 3 つで aria-busy なし・［やめる］が 2 つ・3 行の高さが同じ）。足りない物の文を返す
 */
function cardProblems({ demos, pc, label }: { demos: string[]; pc: boolean; label: string }): string[] {
  const lines: string[] = [];
  const say = (text: string): void => void lines.push(`カード（${label}）: ${text}`);
  const near = (a: number, b: number, d: number): boolean => Math.abs(a - b) <= d;
  const section = document.querySelector('[data-section="cards"]');
  if (section === null) return [`カード（${label}）: 節が無い`];
  const names = [...section.querySelectorAll("[data-demo]")].map((el) => el.getAttribute("data-demo") ?? "?");
  for (const name of demos) if (!names.includes(name)) say(`見本が無い: ${name}`);
  for (const name of names) if (!demos.includes(name)) say(`知らない見本: ${name}`);
  const colorOf = (v: string): string => {
    const probe = document.createElement("span");
    probe.style.color = v;
    section.append(probe);
    const c = getComputedStyle(probe).color;
    probe.remove();
    return c;
  };
  const warning = colorOf("var(--warning)");
  const surface = colorOf("var(--surface)");
  const root = getComputedStyle(document.documentElement);
  const radius = parseFloat(root.getPropertyValue("--c-card-r"));
  const max = parseFloat(root.getPropertyValue("--c-card-max"));
  if (!(radius > 0) || !(max > 0)) say("--c-card-r・--c-card-max が読めない");
  const sectionRight = section.getBoundingClientRect().right;
  // 2. 枠
  for (const card of section.querySelectorAll(".c-card")) {
    const demo = card.closest("[data-demo]")?.getAttribute("data-demo") ?? "?";
    const cs = getComputedStyle(card);
    for (const side of ["Top", "Right", "Bottom", "Left"] as const) {
      if (cs[`border${side}Color`] !== warning) say(`${demo} の枠の ${side} の色 ${cs[`border${side}Color`]}。--warning（${warning}）のはず`);
      if (cs[`border${side}Width`] !== "1px") say(`${demo} の枠の ${side} の太さ ${cs[`border${side}Width`]}。1px のはず`);
    }
    if (parseFloat(cs.borderTopLeftRadius) !== radius) say(`${demo} の角 ${cs.borderTopLeftRadius}。${radius}px のはず`);
    if (cs.backgroundColor !== surface) say(`${demo} の地 ${cs.backgroundColor}。--surface（${surface}）のはず`);
    const r = card.getBoundingClientRect();
    if (r.width > max + 0.5) say(`${demo} の幅 ${r.width.toFixed(1)}。${max} 以下のはず`);
    if (card.scrollWidth > card.clientWidth) say(`${demo} のカードが横にはみ出している（${card.scrollWidth} > ${card.clientWidth}）`);
    if (r.right > sectionRight + 0.5) say(`${demo} のカードが節の幅を超えている`);
  }
  // 3. 見出し
  for (const title of section.querySelectorAll(".c-card-title")) {
    const cs = getComputedStyle(title);
    if (cs.fontSize !== "12px") say(`見出しの字 ${cs.fontSize}。12px のはず`);
    if (cs.color !== warning) say(`見出しの色 ${cs.color}。--warning のはず`);
  }
  // 4. ボタンの並び
  for (const actions of section.querySelectorAll(".c-card-actions")) {
    const demo = actions.closest("[data-demo]")?.getAttribute("data-demo") ?? "?";
    const count = actions.getAttribute("data-count");
    const rects = [...actions.children].map((b) => b.getBoundingClientRect());
    for (const b of rects) if (b.height < 44) say(`${demo} のボタンの高さ ${b.height.toFixed(1)}。44 以上のはず`);
    // 字が省かれていない（幅が足りないと「全…」になる。折り返してよい narrow もここで見る）
    for (const label of actions.querySelectorAll(".c-btn-label")) if (label.scrollWidth > label.clientWidth) say(`${demo} のボタンの字「${label.textContent}」が省かれている（${label.scrollWidth} > ${label.clientWidth}）`);
    const tops = new Set(rects.map((b) => Math.round(b.top)));
    if (pc) {
      // 幅 320 の narrow は折り返してよい（flex-wrap）。左端だけ見る
      if (tops.size !== 1 && demo !== "card-narrow") say(`${demo} のボタン（${count}）が 1 行に並んでいない`);
      if (rects[0] !== undefined && !near(rects[0].left, actions.getBoundingClientRect().left, 0.5)) say(`${demo} の最初のボタンが並びの左端に無い`);
    } else if (count === "2") {
      const [a, b] = rects;
      if (tops.size !== 1) say(`${demo} の 2 つのボタンが同じ行に無い`);
      if (a === undefined || b === undefined || !near(a.width, b.width, 0.5)) say(`${demo} の 2 つのボタンの幅が違う（${a?.width.toFixed(1)}・${b?.width.toFixed(1)}）`);
    } else if (count === "3") {
      if (tops.size !== 3) say(`${demo} の 3 つのボタンが 3 行に無い`);
      if (new Set(rects.map((b) => b.left.toFixed(1))).size !== 1 || new Set(rects.map((b) => b.width.toFixed(1))).size !== 1) say(`${demo} の 3 つのボタンの左端か幅が違う`);
    }
  }
  // 5. チェックの行と印
  for (const row of section.querySelectorAll("label.c-card-check")) {
    const demo = row.closest("[data-demo]")?.getAttribute("data-demo") ?? "?";
    const r = row.getBoundingClientRect();
    if (r.height < 44) say(`${demo} のチェックの行の高さ ${r.height.toFixed(1)}。44 以上のはず`);
    const input = row.querySelector("input")?.getBoundingClientRect();
    if (input === undefined || !near(input.width, 24, 0.5) || !near(input.height, 24, 0.5)) say(`${demo} のチェックの印 ${input?.width.toFixed(1)}x${input?.height.toFixed(1)}。24x24 のはず`);
  }
  // 6. 要約の高さ
  const pre = section.querySelector('[data-demo="card-perm-long"] .c-card-code');
  if (!(pre instanceof HTMLElement)) say("card-perm-long の要約が無い");
  else if (pc) {
    const cs = getComputedStyle(pre);
    const want = parseFloat(cs.lineHeight) * 8 + parseFloat(cs.paddingTop) + parseFloat(cs.paddingBottom);
    const h = pre.getBoundingClientRect().height;
    if (!(pre.scrollHeight > pre.clientHeight)) say(`card-perm-long の要約が中で送れない（${pre.scrollHeight} <= ${pre.clientHeight}）`);
    if (!near(h, want, 1)) say(`card-perm-long の要約の高さ ${h.toFixed(1)}。${want.toFixed(1)} のはず`);
  } else if (pre.scrollHeight > pre.clientHeight + 1) say(`card-perm-long の要約が切れている（${pre.scrollHeight} > ${pre.clientHeight}）`);
  // 7. 残り時間の色・待ちの行・動き・narrow・横
  const metaColor = (demo: string): string | null => {
    const meta = section.querySelector(`[data-demo="${demo}"] .c-card-meta`);
    return meta === null ? null : getComputedStyle(meta).color;
  };
  if (metaColor("card-perm-urgent") !== warning) say(`card-perm-urgent の残り時間の色 ${metaColor("card-perm-urgent")}。--warning のはず`);
  if (metaColor("card-perm") === null || metaColor("card-perm") === warning) say("card-perm の残り時間が無いか --warning の色");
  if (section.querySelector('[data-demo="card-note"] .c-note')?.getAttribute("role") !== "status") say("card-note の待ちの行に role=status が無い");
  // 動いてよいのは、状態の行の送っている間の［やめる］の輪だけ
  const spin = (a: Animation): boolean => {
    const target = a.effect instanceof KeyframeEffect ? a.effect.target : null;
    return target !== null && target.matches('[data-demo="card-status"] .c-status .c-btn[aria-busy="true"] .c-btn-spin');
  };
  const moving = section.getAnimations({ subtree: true }).filter((a) => !spin(a)).length;
  if (moving > 0) say(`節の中で ${moving} 個が動いている`);
  // 状態の行
  const statusRows = [...section.querySelectorAll('[data-demo="card-status"] .c-status')];
  const statusTexts = section.querySelectorAll('[data-demo="card-status"] p[role="status"]');
  if (statusRows.length !== 3 || statusTexts.length !== 3) say(`card-status の行 ${statusRows.length}・role=status ${statusTexts.length}。3 つずつのはず`);
  if (section.querySelector('[data-demo="card-status"] [aria-busy]:not(.c-btn)') !== null) say("card-status のボタンのほかに aria-busy が在る");
  const statusButtons = section.querySelectorAll('[data-demo="card-status"] .c-status > .c-btn');
  if (statusButtons.length !== 2) say(`card-status の［やめる］の数 ${statusButtons.length}。2 のはず`);
  const statusHeights = new Set(statusRows.map((row) => row.getBoundingClientRect().height.toFixed(1)));
  if (statusHeights.size !== 1) say(`card-status の 3 行の高さが違う（${[...statusHeights].join("・")}）`);
  // 8. 「その他」の欄（card-q-other だけ見える）
  for (const demo of ["card-q-one", "card-q-two", "card-q-other", "card-q-busy", "card-q-session"]) {
    const fields = [...section.querySelectorAll(`[data-demo="${demo}"] textarea.c-card-other`)];
    if (fields.length === 0) say(`${demo} に「その他」の欄が無い`);
    for (const field of fields) {
      if (!(field instanceof HTMLTextAreaElement)) continue;
      const shown = field.getClientRects().length > 0;
      if (demo !== "card-q-other") {
        if (shown) say(`${demo} の「その他」の欄が見えている`);
        continue;
      }
      if (!shown) say("card-q-other の「その他」の欄が見えない");
      if (field.value !== "別の案を書きます") say(`card-q-other の「その他」の欄の値「${field.value}」。「別の案を書きます」のはず`);
      if (!pc && parseFloat(getComputedStyle(field).fontSize) < 16) say(`card-q-other の「その他」の欄の字 ${getComputedStyle(field).fontSize}。16px 以上のはず`);
    }
  }
  // 9. 問の間の線（2 問目の上だけ）
  const sets = [...section.querySelectorAll('[data-demo="card-q-two"] fieldset.c-card-q')];
  if (sets.length !== 2) say(`card-q-two の問の数 ${sets.length}。2 のはず`);
  else {
    const [first, second] = sets.map((f) => getComputedStyle(f).borderTopWidth);
    if (first !== "0px") say(`card-q-two の 1 問目の上の線 ${first}。0px のはず`);
    if (second !== "1px") say(`card-q-two の 2 問目の上の線 ${second}。1px のはず`);
    // 見出しは線の下に在る（線に乗ると、字の右にだけ線が出る）
    const legend = sets[1].querySelector("legend");
    if (legend && legend.getBoundingClientRect().top < sets[1].getBoundingClientRect().top + 1) say("card-q-two の 2 問目の見出しが上の線に乗っている");
  }
  // 10. ［答える］の押せない印
  const answer = (demo: string): string | null => section.querySelector(`[data-demo="${demo}"] .c-card-actions > :first-child`)?.getAttribute("aria-disabled") ?? null;
  if (answer("card-q-one") !== "true") say("card-q-one の［答える］が押せる形");
  if (answer("card-q-two") === "true") say("card-q-two の［答える］が押せない形");
  const narrow = section.querySelector('[data-demo="card-narrow"] > *');
  if (narrow === null || !near(narrow.getBoundingClientRect().width, 320, 0.5)) say(`card-narrow の入れ物の幅 ${narrow?.getBoundingClientRect().width.toFixed(1) ?? "?"}。320 のはず`);
  const doc = document.documentElement;
  if (doc.scrollWidth > doc.clientWidth) say(`ページが横に動く（${doc.scrollWidth} > ${doc.clientWidth}）`);
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
  "top-wide-talk", "top-wide-cc", "top-wide-long", "top-wide-short", "top-wide-mode", "top-wide-mode-busy", "top-wide-other",
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
const TALK_DEMOS = ["talk-basic", "talk-steps", "talk-stopped", "talk-stopped-open", "talk-stopped-busy", "talk-md", "talk-run", "talk-run-empty", "talk-edge"];
/** 会話の行の幅の上限（.c-talk の中の幅に対する割合。agent と実行中の行・owner） */
const TALK_MAX: Record<Viewport, { agent: number; owner: number }> = { phone: { agent: 0.86, owner: 0.8 }, tablet: { agent: 0.78, owner: 0.72 }, pc: { agent: 0.78, owner: 0.72 } };
/** 会話の根の字の大きさ（px。--c-font-body） */
const TALK_FONT: Record<Viewport, number> = { phone: 16, tablet: 16, pc: 14 };

/**
 * 見本の会話の測り方（ブラウザの中で動く。page.evaluate に渡すので外の変数を使わない）。
 * 見本の名前・吹き出しの中に結果の文が無い・1 行の吹き出しの高さ・幅の上限・角・はみ出し・長いコードを横に送れる・手順の行・実行中の行の読み上げ・根の字。
 * demos が null なら本番の会話（見本の名前を前提にした 0・2・3 の talk-edge・6 を飛ばす）。足りない物の文を返す
 */
function talkProblems({ demos, max, fontSize, label }: { demos: string[] | null; max: { agent: number; owner: number }; fontSize: number; label: string }): string[] {
  const lines: string[] = [];
  const say = (text: string): void => void lines.push(`会話（${label}）: ${text}`);
  const near = (a: number, b: number, d: number): boolean => Math.abs(a - b) <= d;
  const nameOf = (el: Element): string => el.closest("[data-demo]")?.getAttribute("data-demo") ?? "?";
  // 0. 見本の名前
  if (demos !== null) {
    const names = [...document.querySelectorAll('[data-section="talk"] [data-demo]')].map((el) => el.getAttribute("data-demo") ?? "?");
    for (const name of demos) if (!names.includes(name)) say(`見本が無い: ${name}`);
    for (const name of names) if (!demos.includes(name)) say(`知らない見本: ${name}`);
  }
  // 1. 結果の文は吹き出しの外
  for (const bubble of document.querySelectorAll(".c-bubble")) {
    const text = bubble.textContent ?? "";
    for (const word of ["完了（", "止まりました", "中断しました"]) if (text.includes(word)) say(`${nameOf(bubble)} の吹き出しの中に「${word}」が在る`);
  }
  // 2. 1 行の返事の吹き出しの高さ
  const basic = demos === null ? null : document.querySelector('[data-demo="talk-basic"] .c-msg[data-who="agent"]');
  const basicP = basic?.querySelector(".c-bubble p") ?? null;
  const basicB = basic?.querySelector(".c-bubble") ?? null;
  if (demos === null) {
    // 本番は段 k で話題の 1 文の返事を測る
  } else if (basicP === null || basicB === null) say("talk-basic に agent の吹き出しが無い");
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
  if (demos === null) {
    // 本番には talk-edge が無い
  } else if (edge === undefined || edgeTalk === null) say("talk-edge に owner の吹き出しが無い");
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
  const pre = demos === null ? null : document.querySelector('[data-demo="talk-md"] .c-md-pre');
  if (demos === null) {
    // 本番は段 k で話題のコードの段を測る
  } else if (pre === null) say("talk-md にコードの段が無い");
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
  // 7. 手順の行（手順を開いた行は結果の文を折り返すので 24 以上・省かない）
  for (const foot of document.querySelectorAll(".c-msg-foot")) {
    const msg = foot.closest(".c-msg");
    const r = foot.getBoundingClientRect();
    if (foot.querySelector(':scope > .c-steps-toggle[aria-expanded="true"]') !== null) {
      if (r.height < 23.5) say(`${nameOf(foot)} の開いた手順の行の高さ ${r.height.toFixed(1)}。24 以上のはず`);
    } else if (!near(r.height, 24, 0.5)) say(`${nameOf(foot)} の手順の行の高さ ${r.height.toFixed(1)}。24 のはず`);
    if (msg !== null) {
      const m = msg.getBoundingClientRect();
      if (r.left < m.left - 0.5 || r.right > m.right + 0.5) say(`${nameOf(foot)} の手順の行が行の外に出ている`);
    }
  }
  for (const time of document.querySelectorAll(".c-msg-time")) {
    if (time.scrollWidth > time.clientWidth) say(`${nameOf(time)} の時刻が切れている（${time.scrollWidth} > ${time.clientWidth}）`);
  }
  for (const el of document.querySelectorAll(".c-steps-label, .c-steps-text")) {
    if (el.matches('.c-msg-foot > .c-steps-toggle[aria-expanded="true"] .c-steps-label')) {
      if (el.scrollWidth > el.clientWidth) say(`${nameOf(el)} の開いた結果の文が省かれている（${el.scrollWidth} > ${el.clientWidth}）`);
      continue;
    }
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
  // 10. 行の一番下の［続ける］（返事の行の最後の子・ボタン 1 つ・高さ 36・左端が吹き出しと同じ・上の物との間 16）
  const acts = [...document.querySelectorAll(".c-msg-act")];
  for (const act of acts) {
    const msg = act.parentElement;
    if (msg === null || !msg.matches('.c-msg[data-who="agent"]')) {
      say(`${nameOf(act)} の［続ける］の親が返事の行でない`);
      continue;
    }
    if (msg.lastElementChild !== act) say(`${nameOf(act)} の［続ける］が行の最後の子でない`);
    const btns = act.querySelectorAll("button.c-btn");
    const btn = btns[0];
    if (btns.length !== 1 || btn === undefined) {
      say(`${nameOf(act)} の［続ける］のボタンが ${btns.length} 個（1 つのはず）`);
      continue;
    }
    if ((btn.textContent ?? "").trim() !== "続ける") say(`${nameOf(act)} のボタンの文が「${(btn.textContent ?? "").trim()}」（続ける のはず）`);
    const b = btn.getBoundingClientRect();
    if (!near(b.height, 36, 0.5)) say(`${nameOf(act)} の［続ける］の高さ ${b.height.toFixed(1)}。36 のはず`);
    const bubble = msg.querySelector(":scope > .c-bubble");
    if (bubble === null || !near(b.left, bubble.getBoundingClientRect().left, 0.5)) say(`${nameOf(act)} の［続ける］の左端が吹き出しとずれる（${b.left.toFixed(1)} / ${bubble === null ? "なし" : bubble.getBoundingClientRect().left.toFixed(1)}）`);
    const before = act.previousElementSibling;
    const gap = before === null ? null : b.top - before.getBoundingClientRect().bottom;
    if (gap === null || !near(gap, 16, 0.5)) say(`${nameOf(act)} の［続ける］と上の物の間 ${gap === null ? "なし" : gap.toFixed(1)}。16 のはず`);
  }
  if (demos !== null) {
    const want = ["talk-stopped", "talk-stopped-open", "talk-stopped-busy"];
    for (const demo of demos) {
      const n = document.querySelectorAll(`[data-demo="${demo}"] .c-msg-act`).length;
      if (n !== (want.includes(demo) ? 1 : 0)) say(`${demo} の［続ける］が ${n} 個（${want.includes(demo) ? 1 : 0} のはず）`);
    }
    for (const act of acts) {
      const busy = act.querySelector('button[aria-busy="true"]') !== null && act.querySelector(".c-btn-spin") !== null;
      if (busy !== (nameOf(act) === "talk-stopped-busy")) say(`${nameOf(act)} の［続ける］の待ちの形が ${busy ? "在る" : "無い"}`);
    }
    const open = document.querySelector('[data-demo="talk-stopped-open"] .c-msg-act');
    if (open !== null && open.previousElementSibling?.matches(".c-steps-list") !== true) say("talk-stopped-open の［続ける］が手順の一覧の後ろでない");
  }
  return lines;
}

/**
 * 本番の会話の行の形（ブラウザの中で動く。page.evaluate に渡すので外の変数を使わない）。#ed に .c-talk が 1 つで古い描き方の行が無い・
 * .ed-scroll が横に動かない・カードの根と .tl が見えているとき、その中身の左端が .c-talk の中身の左端と同じで、最初の子が .c-talk の下端からすぐ。足りない物の文を返す
 */
function liveTalkProblems({ label }: { label: string }): string[] {
  const lines: string[] = [];
  const say = (text: string): void => void lines.push(`本番の会話（${label}）: ${text}`);
  const talks = document.querySelectorAll("#ed .c-talk");
  if (talks.length !== 1) say(`#ed の .c-talk が ${talks.length} 個（1 つのはず）`);
  for (const sel of ["#ed .msg", "#ed details.steps-plain", "#ed .tl-divider", "#ed [data-run-progress]"]) {
    const n = document.querySelectorAll(sel).length;
    if (n > 0) say(`${sel} が ${n} 個（古い描き方）`);
  }
  const scroll = document.querySelector("#ed .ed-scroll");
  if (scroll === null) say("#ed に .ed-scroll が無い");
  else if (scroll.scrollWidth > scroll.clientWidth) say(`.ed-scroll が横に動く（${scroll.scrollWidth} > ${scroll.clientWidth}）`);
  const talk = talks[0];
  const inner = (el: Element): number => el.getBoundingClientRect().left + parseFloat(getComputedStyle(el).paddingLeft);
  // カードの根（会話の根のすぐ次）
  const cards = document.querySelector("#ed .ed-scroll > [data-talk] + [data-cards]");
  if (talk !== undefined && cards !== null && cards.getClientRects().length > 0) {
    if (Math.abs(inner(cards) - inner(talk)) > 0.5) say(`カードの根の中身の左端 ${inner(cards).toFixed(1)} が .c-talk の中身の左端 ${inner(talk).toFixed(1)} でない`);
    const first = cards.firstElementChild;
    if (first !== null) {
      const gap = first.getBoundingClientRect().top - parseFloat(getComputedStyle(first).marginTop) - talk.getBoundingClientRect().bottom;
      if (Math.abs(gap) > 0.5) say(`カードの根の最初の子の上に .c-talk の下の余白のほかに ${gap.toFixed(1)} の間が在る`);
    }
  }
  const tl = document.querySelector("#ed .ed-scroll > [data-cards] + .tl");
  if (talk !== undefined && tl !== null && tl.getClientRects().length > 0) {
    if (Math.abs(inner(tl) - inner(talk)) > 0.5) say(`.tl の中身の左端 ${inner(tl).toFixed(1)} が .c-talk の中身の左端 ${inner(talk).toFixed(1)} でない`);
    // 上の余白を重ねない（.tl の最初の子は .c-talk の下端からすぐ。間は .c-talk の下の余白だけ）
    const first = tl.firstElementChild;
    if (first !== null) {
      const gap = first.getBoundingClientRect().top - parseFloat(getComputedStyle(first).marginTop) - talk.getBoundingClientRect().bottom;
      if (Math.abs(gap) > 0.5) say(`.tl の最初の子の上に .c-talk の下の余白のほかに ${gap.toFixed(1)} の間が在る`);
    }
  }
  return lines;
}

/** 本番の会話の行で古い CSS の漏れを比べる要素（見本の会話の節の、同じ形の物と） */
const LEAK_TALK = [
  '.c-msg[data-who="agent"] .c-bubble',
  '.c-msg[data-who="agent"] .c-md-p',
  ".c-md-pre",
  ".c-md-code",
  ".c-md-link",
  '.c-msg[data-who="agent"] .c-msg-time',
  '.c-steps-toggle[data-tone="muted"]',
  ".c-notice",
  ".c-divider",
];

/** 描き直しの重さの受け入れ（tick の中央値の上限 ms と、draw の中央値に対する割合の上限） */
const TALK_TICK_MAX_MS = 4;
const TALK_TICK_RATIO = 0.25;

/**
 * 描き直しの重さを測る（ブラウザの中で動く。page.evaluate に渡すので外の変数を使わない）。作り物の 300 行の state を、body に足した
 * 一時の入れ物（幅 390px。data-talk を付けないので本番の刻みは触らない）に SA.talk.draw で描き、draw と tick を 5 回捨ててから 20 回ずつ、
 * 直後の layout の読みまでを測る。終わったら drop して入れ物を外す
 */
function talkWeight(): { draw: number[]; tick: number[]; same: boolean; changed: boolean; ok: boolean } {
  type Talk = { draw: (root: Element, state: unknown) => boolean; tick: (root: Element, state: unknown) => boolean; drop: (root: Element) => void };
  const sa = (window as unknown as { SA: { talk: Talk; ui: { shortTime: (at: string) => string } } }).SA;
  const talk = sa.talk;
  const box = document.createElement("div");
  box.style.width = "390px";
  document.body.append(box);
  // 行ごとに違う文と時刻（解析の覚え・時刻の文を行ごとに作らせる）
  const agentText = (n: number): string =>
    `${n} 番目の段落の文です。**太字**と \`code${n}\` と https://example.com/a/${n} を含みます。\n\n- ${n} の 1 つ目の項目\n- ${n} の 2 つ目の項目\n\n終わりの段落です（${n}）。`;
  const base = Date.now() - 300 * 60_000;
  const turns = Array.from({ length: 300 }, (_v, i) => {
    const at = new Date(base + i * 60_000).toISOString();
    return i % 2 === 0
      ? { id: i + 1, kind: "owner", text: `${i + 1} 番目の質問です。`, at }
      : { id: i + 1, kind: "agent", text: agentText(i + 1), at, outcome: "done", steps: ["Read a", "Edit b", "Bash c"], toolCalls: 3, durationMs: 9000 };
  });
  const noop = (): void => undefined;
  const fmt = {
    // 本番と同じ時刻の文（chat.js の fmt.time と同じ SA.ui.shortTime）
    time: (t: { at: string }) => sa.ui.shortTime(t.at),
    label: (t: { kind: string }) => (t.kind === "owner" ? "オーナー" : "既定"),
    name: () => null,
    end: () => "完了（9 秒・ツール 3 回）",
    progress: (r: { n: number }) => `作業中…（${r.n} 秒・ツール 5 回）`,
    waiting: () => null,
    allLabel: () => "すべての手順（5）",
    runName: () => null,
  };
  const on = { older: noop, toggleSteps: noop, toggleRunSteps: noop, stop: noop };
  let n = 0;
  const state = (): unknown => {
    n++;
    return {
      channelId: "w",
      turns,
      hasMore: false,
      running: { n, turnSeq: 1, toolCalls: 5, steps: ["a", "b", "c", "d", "e"], abortable: true },
      stopping: false,
      openSteps: new Set(),
      runStepsOpen: false,
      fmt,
      on,
    };
  };
  let ok = true;
  const measure = (fn: (root: Element, st: unknown) => boolean): number[] => {
    const out: number[] = [];
    for (let i = 0; i < 25; i++) {
      const st = state();
      const t0 = performance.now();
      if (!fn(box, st)) ok = false;
      void box.offsetHeight;
      const t1 = performance.now();
      if (i >= 5) out.push(t1 - t0);
    }
    return out;
  };
  try {
    const draw = measure((root, st) => talk.draw(root, st));
    const first = box.querySelector(".c-bubble");
    const text = box.querySelector(".c-run-text")?.textContent ?? "";
    const tick = measure((root, st) => talk.tick(root, st));
    const same = first !== null && box.querySelector(".c-bubble") === first && first.isConnected;
    const changed = (box.querySelector(".c-run-text")?.textContent ?? "") !== text;
    return { draw, tick, same, changed, ok };
  } finally {
    talk.drop(box);
    box.remove();
  }
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
/** 本番の入力欄で古い CSS の漏れを比べる要素（見本の入力欄の near と）。extra は LEAK_PROPS に足して比べる性質 */
const LEAK_COMPOSER: Array<{ sel: string; extra: string[] }> = [
  { sel: ".c-composer", extra: [] },
  { sel: ".c-composer-input", extra: ["caret-color"] },
  { sel: ".c-composer-count-text", extra: [] },
  { sel: ".c-composer-row > .c-btn", extra: [] },
];
/** 本番のカードで古い CSS の漏れを比べる要素（見本の同じ形のカードと。許可はルール付き・質問は 1 問・文は待ちでない物） */
const LEAK_CARDS: Record<string, { demo: string; sels: string[] }> = {
  perm: { demo: "card-perm-rule", sels: [".c-card", ".c-card-title", ".c-card-meta", ".c-card-facts", ".c-card-code", ".c-card-check", ".c-card-check-input", ".c-card-actions > .c-btn", ".c-card-note"] },
  question: { demo: "card-q-one", sels: [".c-card", ".c-card-title", ".c-card-meta", ".c-card-q-legend", ".c-card-check", ".c-card-check-input", ".c-card-other", ".c-card-actions > .c-btn:last-child", ".c-card-note"] },
  close: { demo: "card-close", sels: [".c-card", ".c-card-title", ".c-card-meta", ".c-card-text", ".c-card-check", ".c-card-check-input", ".c-card-actions > .c-btn"] },
  move: { demo: "card-move", sels: [".c-card", ".c-card-title", ".c-card-meta", ".c-card-dd", ".c-card-text", ".c-card-actions > .c-btn"] },
  note: { demo: "card-note", sels: [".c-note:not([data-busy])"] },
};
/** 入力欄の 1 字ごとの input の処理の重さの受け入れ（ms。中央値と最大。スマホ・CPU 4 倍） */
const COMPOSER_INPUT_MED_MS = 4;
const COMPOSER_INPUT_MAX_MS = 16;
/** 幅の検査で当てる字（仮名が全角の等幅。リポジトリの CSS は変えず、この検査の間だけ） */
const MONO_CSS = '*, *::before, *::after { font-family: "IPAGothic", "Osaka-Mono", "MS Gothic", monospace !important; }';

/** 撮る PNG の名前（拡張子なし）の全部。--only はこの中から絞る */
const ALL_SHOT_NAMES: readonly string[] = [
  ...NEW_SHELLS.flatMap(({ vp, theme, full }) => newShellNames(vp, theme, full)),
  ...OLD_SHELLS.flatMap(oldShellNames),
  ...GALLERY_SHOTS.flatMap(({ vp, theme }) => GALLERY_KINDS.map((kind) => galleryName(vp, theme, kind))),
  ...CC_SHELLS.flatMap(ccShellNames),
];

/** part は撮る部（main: 今のサーバーの全部、cc: 2 つ目のサーバーの段 cc だけ） */
async function shoot(browser: Browser, fixture: FixtureServer, out: string, only: string | undefined, logLines: string[], part: "main" | "cc" = "main"): Promise<{ count: number; failed: number }> {
  const base = fixture.url;
  const { open, perm, q, talk, long, run } = fixture.topics;
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
    trackRequests(page);
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

  /**
   * 落ち着くまで待つ（settledWithin）。上限に達したら console.log に 1 行と段の失敗を 1 つ足す（例外にはしない）。
   * 要求を待って上限に達したら、終わらなかった要求の名前を行に足して忘れる（同じ要求で次からも上限まで待たない）
   */
  async function settled(page: Page, limit = SETTLE_LIMIT_MS): Promise<void> {
    const stuck = await settledWithin(page, limit);
    if (stuck === "") return;
    const url = new URL(page.url());
    failed++;
    const names = stuck === "要求" ? forgetStuck(page) : [];
    logLines.push(`[ui-shots] settled timeout（${stuck}） ${url.pathname}${url.hash}${names.length > 0 ? `（終わらない要求: ${names.join("、")}）` : ""}`);
  }

  /** held は、わざと止めた要求が在る間の絵（落ち着きを待つと止めた要求を待ってしまうので、決まった時間だけ待つ） */
  async function shot(page: Page, name: string, fullPage = false, held = false): Promise<void> {
    if (!wanted(name)) return;
    if (held) await wait(400);
    else await settled(page);
    await page.screenshot({ path: join(out, `${name}.png`), fullPage });
    count++;
  }

  /** 要素 1 つの絵（見本の節など） */
  async function shotOf(page: Page, name: string, selector: string): Promise<void> {
    if (!wanted(name)) return;
    await settled(page);
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
   * 使うのは描けない bar・入口が読めないとき・入力欄の送りの失敗・一覧に無い Claude Code のセッションの読み（404）の 4 か所だけ（外す語を増やさない）
   */
  function dropExpected(from: number, needles: string[]): string[] {
    const removed: string[] = [];
    const kept = logLines.slice(0, from);
    // settled timeout の行は外さない（終わらない要求の名前が外す語と重なっても、失敗の理由を console.log に残す）
    for (const line of logLines.slice(from)) (!line.startsWith("[ui-shots] settled timeout") && needles.some((n) => line.includes(n)) ? removed : kept).push(line);
    logLines.splice(0, logLines.length, ...kept);
    return removed;
  }

  async function load(page: Page, path: string): Promise<void> {
    // hash だけ違う URL は同じ文書の移動になり、開いたダイアログが残るので毎回読み直す
    await page.goto("about:blank");
    await page.goto(base + path, { waitUntil: "load" });
    // スマホで会話・設定を開いているときは一覧が隠れているので、在るまでを待つ
    await page.waitForSelector("#c-list-root section[data-kind]", { state: "attached", timeout: 8000 });
    await settled(page);
  }

  async function scrollBottom(page: Page): Promise<void> {
    await page.evaluate(() => {
      for (const el of document.querySelectorAll("#ed *, #ed")) {
        if (el.scrollHeight > el.clientHeight + 4 && getComputedStyle(el).overflowY !== "visible") el.scrollTop = el.scrollHeight;
      }
    });
    await settled(page);
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
      await settled(page);
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
      await load(page, "/");

      // フォーカスと位置 (1): 一覧が送れる高さにして、行にフォーカス・100 送ってから、順を入れ替えた応答で読み直す
      await page.setViewportSize({ width: 1440, height: 500 });
      await settled(page);
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
      await load(page, "/");

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
      await load(page, "/");
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
      await load(page, "/");
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
    await load(page, "/");
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
      await settled(page);
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
        await settled(page);
        lines.push(...(await measureWidths(page, "幅 375")));
        await page.setViewportSize(VIEWPORTS.phone.viewport);
        await settled(page);
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
      await settled(page);
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
      await settled(page);
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
        await settled(page);
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
        await settled(page);
        const wide = await formAt();
        if (wide.variant !== "wide" || JSON.stringify(wide.texts) !== JSON.stringify(["タスク", "リマインド", "ほか"])) lines.push(`バー: 800 で広い幅の形にならない（${String(wide.variant)}・${wide.texts.join("・")}）`);
      } finally {
        await page.setViewportSize(VIEWPORTS.phone.viewport);
        await settled(page);
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
        await settled(page);
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
    await settled(page);
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
      await settled(page);
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
      await page.goto(base + "/", { waitUntil: "load" });
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
    await settled(page);
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
      await settled(page);
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
      await settled(page);
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
      // 焦点の輪が付くまでの短い待ち（落ち着きは待たない。順番のため）
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
  /** 右腕の見出しの［畳む］（入口 c-app.js の HandHead） */
  const HAND_CLOSE = '#c-hand-root [data-act="close"] button';
  const TOP_PLACE = "#c-top-root button.c-top-place";

  /** 板を Esc で閉じ、閉じるまで待つ */
  async function escSheet(page: Page): Promise<void> {
    await page.keyboard.press("Escape");
    await page.waitForSelector("#v3-sheet:not([open])", { state: "attached", timeout: 5000 });
    await settled(page);
  }

  /** 板の行の字 */
  const sheetRows = (page: Page): Promise<string[]> => page.evaluate(() => [...document.querySelectorAll("#v3-sheet .more-row .sb-label")].map((el) => (el.textContent ?? "").trim()));

  /**
   * 段 c: 開いた右腕の中が部品（見出し・会話・札・入力欄）で描かれている。phone ならスマホで下のバーから開いた後（畳んで開き直し、焦点が入力欄に在るかも見る）。
   * 絵を撮った後に呼ぶ。最後に札の［開く］を押すので、呼んだ後は列 2 にその話題が開いている。足りない物の文を返す
   */
  async function handPartsLines(page: Page, vp: Viewport, phone: boolean): Promise<string[]> {
    const lines: string[] = [];
    // 6. スマホで下のバーから開いた直後の焦点。初めて開いたときは読み込み中で入力欄が無いので、読み込んだ後に畳んで開き直してから見る
    if (phone) {
      await page.click(HAND_CLOSE);
      await page.waitForSelector('#v3[data-hand="closed"]', { timeout: 5000 });
      await settled(page);
      await page.click('#c-bottom-root [data-act="hand"]');
      await settled(page);
      if (!(await activeIs(page, "#v3-hand-ed textarea.c-composer-input"))) {
        const at = await page.evaluate(() => {
          const a = document.activeElement;
          return a === null ? "null" : `${a.tagName.toLowerCase()}.${a.classList[0] ?? ""}`;
        });
        lines.push(`右腕: 読み込んだ後に下のバーから開き直した直後の焦点が入力欄に無い（${at}）`);
      }
    }
    lines.push(
      ...(await page.evaluate(() => {
        const out: string[] = [];
        const count = (sel: string): number => document.querySelectorAll(sel).length;
        // 1. 古い道の物が無く、部品が 1 つずつ
        for (const sel of ["#v3-hand-ed .msg", "#v3-hand-ed .composer-wrap", "#v3-hand-ed header.ed-toolbar", "#v3-hand-ed .v3-card"]) if (count(sel) !== 0) out.push(`右腕: ${sel} が ${count(sel)} 個（0 のはず）`);
        for (const sel of ["#v3-hand-ed .c-talk", "#v3-hand-ed > [data-composer] .c-composer"]) if (count(sel) !== 1) out.push(`右腕: ${sel} が ${count(sel)} 個（1 のはず）`);
        // 2. 見出しは 1 つで h2「右腕」。ページの h1 は 1 つ以下
        const titles = [...document.querySelectorAll("#c-hand-root .c-hand-head h2")].map((el) => (el.textContent ?? "").trim());
        if (count("#c-hand-root .c-hand-head") !== 1 || titles.join() !== "右腕") out.push(`右腕: 見出し ${count("#c-hand-root .c-hand-head")} 個・題 ${JSON.stringify(titles)}（1 つで「右腕」のはず）`);
        if (count("h1") > 1) out.push(`右腕: ページの h1 が ${count("h1")} 個`);
        // 3. 札は作り物のデータの 2 つ。返事の本文に <# が残らない
        if (count("#v3-hand-ed .c-ref") !== 2) out.push(`右腕: 札が ${count("#v3-hand-ed .c-ref")} 個（2 のはず）`);
        if ([...document.querySelectorAll("#v3-hand-ed .c-bubble")].some((el) => (el.textContent ?? "").includes("<#"))) out.push("右腕: 返事の本文に <# が残っている");
        // 5. 横にはみ出さない（札の右端が列の中）
        const scroll = document.querySelector("#v3-hand-ed .ed-scroll");
        if (scroll === null) out.push("右腕: .ed-scroll が無い");
        else {
          if (scroll.scrollWidth > scroll.clientWidth) out.push(`右腕: .ed-scroll が横にはみ出している（${scroll.scrollWidth} > ${scroll.clientWidth}）`);
          const right = scroll.getBoundingClientRect().right;
          for (const el of scroll.querySelectorAll(".c-ref, .c-bubble")) {
            const r = el.getBoundingClientRect().right;
            if (r > right + 0.5) out.push(`右腕: ${el.className} の右端 ${r.toFixed(1)} が列の右端 ${right.toFixed(1)} の外`);
          }
        }
        // 6. 入力欄の placeholder と、空のときの字数
        const input = document.querySelector<HTMLTextAreaElement>("#v3-hand-ed > [data-composer] textarea.c-composer-input");
        if (input === null || input.placeholder !== "右腕に頼む・訊く") out.push(`右腕: 入力欄の placeholder が ${JSON.stringify(input?.placeholder ?? null)}`);
        if (count("#v3-hand-ed > [data-composer] .c-composer-count-text") !== 0) out.push("右腕: 空の入力欄に字数が出ている");
        return out;
      })),
    );
    // 4. 当たり
    lines.push(...(await page.evaluate(hitProblems, { min: HIT_MIN[vp], scopes: "#c-hand-root, #v3-hand-ed", targets: "button, textarea", toast: false })).map((l) => `右腕: ${l}`));
    // 7. 「…」の板の題と、閉じた後の焦点
    const MENU = '#c-hand-root [data-act="menu"] button';
    if ((await page.locator(MENU).count()) !== 1) lines.push("右腕: 「…」が無い");
    else {
      await page.click(MENU);
      await page.waitForSelector("#v3-sheet[open]", { timeout: 5000 });
      const title = await page.getAttribute("#v3-sheet", "aria-label");
      if (title !== "右腕 の操作") lines.push(`右腕: 「…」の板の題が ${JSON.stringify(title)}（「右腕 の操作」のはず）`);
      await escSheet(page);
      if (!(await activeIs(page, MENU))) lines.push("右腕: 「…」の板を閉じた後の焦点が「…」に無い");
    }
    // 8. 札の［開く］で、列 2 にその話題が開く（スマホは右腕が閉じる）
    const ref = await page.evaluate(() => (document.querySelector("#v3-hand-ed .c-ref .c-ref-title")?.textContent ?? "").trim());
    if (ref !== "") {
      await page.locator("#v3-hand-ed .c-ref > button.c-btn").first().click();
      await page.waitForFunction((t: string) => (document.querySelector("#c-top-root .c-top-title")?.textContent ?? "").trim() === t, ref, { timeout: 5000 }).catch(() => undefined);
      await settled(page);
      const now = await page.evaluate(() => (document.querySelector("#c-top-root .c-top-title")?.textContent ?? "").trim());
      if (now !== ref) lines.push(`右腕: 札の［開く］の後の列 2 の題が「${now}」（「${ref}」のはず）`);
      if (vp === "phone" && (await page.getAttribute("#v3", "data-hand")) !== "closed") lines.push("右腕: スマホで札の［開く］の後も右腕が開いている");
    }
    return lines;
  }

  /** 右腕の見出し（#c-hand-root の部品）は h2「右腕」で、#v3-hand-ed に h1 が無い。字の大きさは --font-base・1 行 */
  async function checkHandHeading(page: Page, label: string): Promise<string[]> {
    const h = await page.evaluate(() => {
      const h2 = document.querySelector("#c-hand-root h2.c-hand-title");
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
    const chat = `/#/ch/${open}`;
    const phone = vp === "phone";
    // 会話を開く（スマホは一覧の行から。焦点は「一覧へ」・押すと一覧へ）
    if (phone) {
      await load(page, "/");
      await page.locator(`#c-list-root button[data-topic="ch:${open}"]`).last().click();
      await page.waitForSelector("#ed textarea", { timeout: 5000 });
      await settled(page);
      if (!(await activeIs(page, TOP_BACK))) lines.push("本番の見出し: 一覧から話題を開いた後の焦点が「一覧へ」に無い");
      lines.push(...(await checkTop(page, vp, "会話", { ed: true })));
      await page.click(TOP_BACK);
      await page.waitForSelector('#v3[data-view="list"]', { timeout: 5000 });
    }
    await load(page, chat);
    await page.waitForSelector("#ed textarea", { timeout: 5000 });
    await settled(page);
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
      await settled(page);
      const width = await page.evaluate((id: string | null) => (id === null ? 0 : (document.getElementById(id)?.getBoundingClientRect().width ?? 0)), controls.a);
      if (!(width > 0)) lines.push("本番の見出し: aria-controls の先が開いた右腕の入れ物でない（幅 0）");
      lines.push(...(await checkHandHeading(page, "右腕")), ...(await checkH1(page, "右腕")));
      await page.click(HAND_CLOSE);
      await page.waitForSelector('#v3[data-hand="closed"]', { timeout: 5000 });
      await settled(page);
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
        await settled(page);
        const over = await topForm(page);
        if (over.mode !== "over") lines.push(`本番の見出し: タブレットの右腕が重ねる形でない（${String(over.mode)}）`);
        if (!(over.width >= over.min)) lines.push(`本番の見出し: 前提が崩れた。重ねて開いた間の列 2 の幅 ${over.width} がしきい値 ${over.min} 以上でない`);
        if (!over.compact) lines.push("本番の見出し: 重ねた右腕の後ろで見出しが compact でなくなった");
        lines.push(...(await checkHandHeading(page, "右腕")), ...(await checkH1(page, "右腕")));
        await page.click(HAND_CLOSE);
        await page.waitForSelector('#v3[data-hand="closed"]', { timeout: 5000 });
        await settled(page);
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
      await load(page, "/#/" + long.replace(":", "/"));
      await page.waitForSelector("#ed textarea", { timeout: 5000 });
      await settled(page);
      lines.push(...(await checkTop(page, vp, "長い題", { ed: phone })), ...(await longTitleLines(page, vp, "長い題")));
      if (vp !== "phone") lines.push(...(await checkRule(page, tag, "長い題")));
      lines.push(...(await withMono(page, () => longTitleLines(page, vp, "長い題・等幅の字"))));
      if (phone) {
        await page.setViewportSize({ width: 375, height: 812 });
        await settled(page);
        lines.push(...(await checkTop(page, vp, "長い題・幅 375", { hits: false })));
        lines.push(...(await withMono(page, () => longTitleLines(page, vp, "長い題・幅 375・等幅の字"))));
        await page.setViewportSize(VIEWPORTS.phone.viewport);
        await settled(page);
      }
      await shot(page, `${p}-b-top-long`);
    }
    // ほかの画面: 設定（題・#ed に h1 が無い）と状態（例外が出ない）
    await load(page, "/#/settings");
    await page.waitForSelector("#ed .ed-section", { timeout: 5000 });
    const settings = await page.evaluate(() => ({ title: document.querySelector("#c-top-root .c-top-title")?.textContent ?? null, h1: document.querySelectorAll("#ed h1").length }));
    if (settings.title !== "設定" || settings.h1 !== 0) lines.push(`本番の見出し: 設定の題が「${String(settings.title)}」・#ed の h1 が ${settings.h1} 個`);
    lines.push(...(await checkTop(page, vp, "設定", { hits: false })));
    const errorsBefore = logLines.filter((line) => line.includes("pageerror")).length;
    await page.evaluate(() => (window as unknown as { SA: { app: { open: (id: string) => void } } }).SA.app.open("status"));
    await settled(page);
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
    await page.click(HAND_CLOSE);
    await page.waitForSelector('#v3[data-hand="closed"]', { timeout: 5000 });
    await settled(page);
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
    await settled(page);
    await page.click("#v3-hand-show");
    await page.waitForSelector('#v3[data-hand="open"]', { timeout: 5000 });
    await settled(page);
    return lines;
  }

  /** PC の幅を変える検査（右腕の列で替わる・幅をまたいで戻る・またいだときの焦点）。終わったら幅を戻す */
  async function pcWidthLines(page: Page, tag: string): Promise<string[]> {
    const lines: string[] = [];
    const size = async (width: number): Promise<void> => {
      await page.setViewportSize({ width, height: VIEWPORTS.pc.viewport.height });
      await settled(page);
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
        await page.click(HAND_CLOSE);
        await page.waitForSelector('#v3[data-hand="closed"]', { timeout: 5000 });
        await settled(page);
      }
      await at("幅 1100・右腕を畳んだ形", false);
      await page.click("#v3-hand-show");
      await page.waitForSelector('#v3[data-hand="open"][data-hand-mode="column"]', { timeout: 5000 });
      await settled(page);
      await at("幅 1100・右腕を列で開いた形", true);
      await shot(page, "pc-dark-b-top-hand-col");
      await page.click(HAND_CLOSE);
      await page.waitForSelector('#v3[data-hand="closed"]', { timeout: 5000 });
      await settled(page);
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
      await settled(page);
    }
    return lines;
  }

  /** 本番の会話の行の形（liveTalkProblems）と、見本と同じ決まり（talkProblems の本番の分） */
  async function liveTalkLines(page: Page, vp: Viewport, label: string): Promise<string[]> {
    return [
      ...(await page.evaluate(liveTalkProblems, { label })),
      ...(await page.evaluate(talkProblems, { demos: null, max: TALK_MAX[vp], fontSize: TALK_FONT[vp], label: `本番・${label}` })),
    ];
  }

  /** 会話の .ed-scroll を下端へ（stick）・先頭へ・dy だけ上へ */
  const edScroll = (page: Page, to: "bottom" | "top" | number): Promise<void> =>
    page.evaluate((where: "bottom" | "top" | number) => {
      const el = document.querySelector("#ed .ed-scroll");
      if (el === null) return;
      if (where === "bottom") el.scrollTop = el.scrollHeight;
      else if (where === "top") el.scrollTop = 0;
      else el.scrollTop = el.scrollTop - where;
    }, to);

  /** 列 2 を描き直す（全部の描き直し。SA.app.refresh） */
  const refreshCh = (page: Page, id: string): Promise<void> =>
    page.evaluate((tab: string) => (window as unknown as { SA: { app: { refresh: (t: string) => void } } }).SA.app.refresh(tab), `ch:${id}`);

  /** /turns の after の応答に 1 行足して会話を読み直す（loadEdited と同じく、読み終わったら書き換えを外す） */
  async function addTurn(page: Page, id: string, turn: Record<string, unknown>): Promise<void> {
    const pattern = `**/api/channels/${id}/turns?after=*`;
    await page.route(pattern, async (route) => {
      // 定期の読み直しと重なって、外した後に終わる事がある（その応答は捨てる）
      try {
        const response = await route.fetch();
        const json = (await response.json()) as { turns: unknown[] };
        json.turns = [...json.turns, turn];
        await route.fulfill({ response, json });
      } catch {
        // 何もしない
      }
    });
    try {
      await page.evaluate((ch: string) => (window as unknown as { SA: { store: { load: { turns: (c: string) => Promise<void> } } } }).SA.store.load.turns(ch), id);
      await settled(page);
    } finally {
      await page.unroute(pattern);
    }
  }

  /**
   * 段 k（本番の会話の行。ダークの 3 組）: 吹き出しの確かめ → 実行中の話題 → 長い会話 →（PC）列の幅 →（スマホ）等幅の字 → 漏れ。
   * 足りない物の文（全部を測ってから、1 つでもあれば段を失敗にする）
   */
  async function talkStage(page: Page, vp: Viewport, p: string): Promise<string[]> {
    const lines: string[] = [];
    const say = (text: string): void => void lines.push(`段 k: ${text}`);
    const fontSize = TALK_FONT[vp];

    // ----- 吹き出しの確かめ -----
    await load(page, `/#/ch/${talk}`);
    await page.waitForSelector('#ed .c-talk .c-msg[data-who="agent"]', { timeout: 5000 });
    await settled(page);
    lines.push(...(await liveTalkLines(page, vp, "吹き出しの確かめ")));
    // 4. 1 文の返事（2 行目）の吹き出しは 1 行ぶん + 余白で、手順の行（結果の文）が無い
    const one = await page.evaluate(() => {
      const row = document.querySelectorAll("#ed .c-talk > .c-msg")[1];
      const bubble = row?.querySelector(".c-bubble");
      return row === undefined || bubble === undefined || bubble === null
        ? null
        : { who: row.getAttribute("data-who"), h: bubble.getBoundingClientRect().height, steps: row.querySelectorAll(".c-steps-toggle, .c-steps-text").length };
    });
    if (one === null || one.who !== "agent") say("2 行目が返事の吹き出しでない");
    else {
      if (Math.abs(one.h - (fontSize * 1.5 + 20)) > 1) say(`1 文の返事の吹き出しの高さ ${one.h.toFixed(1)}。${fontSize * 1.5 + 20} のはず`);
      if (one.steps !== 0) say("1 文の返事（完了・手順なし）に結果の文が在る");
    }
    // 5. 長い URL ははみ出さず、コードの段は横に送れる
    const wide = await page.evaluate(() => {
      const link = [...document.querySelectorAll("#ed .c-md-link")].find((a) => (a.textContent ?? "").length >= 300);
      const bubble = link?.closest(".c-bubble") ?? null;
      const talkEl = document.querySelector("#ed .c-talk");
      const scroll = document.querySelector("#ed .ed-scroll");
      const pre = bubble?.querySelector(".c-md-pre") ?? null;
      const over = (el: Element | null): boolean | null => (el === null ? null : el.scrollWidth > el.clientWidth);
      let moved = 0;
      if (pre !== null) {
        pre.scrollLeft = 50;
        moved = pre.scrollLeft;
        pre.scrollLeft = 0;
      }
      return { link: link !== undefined, bubble: over(bubble), talk: over(talkEl), scroll: over(scroll), pre: over(pre), moved };
    });
    if (!wide.link) say("400 字の URL のリンクが無い");
    for (const [name, over] of [
      ["吹き出し", wide.bubble],
      [".c-talk", wide.talk],
      [".ed-scroll", wide.scroll],
    ] as const) {
      if (over !== false) say(`長い URL で ${name} が横にはみ出している（${String(over)}）`);
    }
    if (wide.pre !== true) say(`コードの段が横に長くない（${String(wide.pre)}）`);
    if (!(wide.moved > 0)) say("コードの段を横に送れない");
    // 9. .tl が空なら高さ 0
    const tlH = await page.evaluate(() => document.querySelector("#ed .ed-scroll > [data-cards] + .tl")?.getBoundingClientRect().height ?? -1);
    if (tlH !== 0) say(`空の .tl の高さ ${tlH}（0 のはず）`);
    // 16. PC は列が 840 で真ん中（右腕を列で開いていると列 2 が 840 より狭いので、測る間だけ畳む）
    if (vp === "pc") {
      const handOpen = (await page.getAttribute("#v3", "data-hand")) === "open";
      if (handOpen) {
        await page.click(HAND_CLOSE);
        await page.waitForSelector('#v3[data-hand="closed"]', { timeout: 5000 });
        await settled(page);
      }
      const col = await page.evaluate(() => {
        const t = document.querySelector("#ed .c-talk");
        const sc = document.querySelector("#ed .ed-scroll");
        if (t === null || sc === null) return null;
        const a = t.getBoundingClientRect();
        const b = sc.getBoundingClientRect();
        const left = a.left - (b.left + sc.clientLeft);
        const right = b.left + sc.clientLeft + sc.clientWidth - a.right;
        return { w: a.width, left, right };
      });
      if (col === null) say("PC の列を測れない");
      else {
        if (Math.abs(col.w - 840) > 0.5) say(`PC の .c-talk の幅 ${col.w.toFixed(1)}（840 のはず）`);
        if (Math.abs(col.left - col.right) > 1) say(`PC の .c-talk が真ん中でない（左 ${col.left.toFixed(1)}・右 ${col.right.toFixed(1)}）`);
      }
      if (handOpen) {
        await page.click("#v3-hand-show");
        await page.waitForSelector('#v3[data-hand="open"]', { timeout: 5000 });
        await settled(page);
      }
    }
    await edScroll(page, "top");
    await settled(page);
    await shot(page, `${p}-b-talk-rows`);
    // 6. 最後の返事の手順を開く。全部の描き直しをまたいでも開いたまま
    await edScroll(page, "bottom");
    await settled(page);
    await page.locator('#ed .c-talk > .c-msg[data-who="agent"]').last().locator(".c-steps-toggle").click();
    await settled(page);
    const opened = async (): Promise<{ expanded: string | null; items: number }> =>
      page.evaluate(() => {
        const last = [...document.querySelectorAll('#ed .c-talk > .c-msg[data-who="agent"]')].at(-1);
        return { expanded: last?.querySelector(".c-steps-toggle")?.getAttribute("aria-expanded") ?? null, items: last?.querySelectorAll("ol.c-steps-list > li").length ?? 0 };
      });
    const o1 = await opened();
    if (o1.expanded !== "true" || o1.items !== 4) say(`最後の返事の手順を開けない（aria-expanded ${String(o1.expanded)}・項目 ${o1.items}）`);
    await edScroll(page, "bottom");
    await shot(page, `${p}-b-talk-steps-open`);
    await refreshCh(page, talk);
    await settled(page);
    const o2 = await opened();
    if (o2.expanded !== "true" || o2.items !== 4) say(`描き直しで開いた手順が閉じた（aria-expanded ${String(o2.expanded)}・項目 ${o2.items}）`);
    // 18. 当たり（開いた手順の後）
    lines.push(...(await page.evaluate(hitProblems, { min: HIT_MIN[vp], scopes: "#ed .c-talk", targets: "button, a[href]:not(.c-md-link), input, select, textarea", toast: false })).map((l) => `段 k: 吹き出しの確かめ: ${l}`));
    // 7・8. 下端に居るときは新着で下へ。上を読んでいるときは動かさない。行が足されても同じ要素で、選んだ文が残る
    await edScroll(page, "bottom");
    await settled(page);
    await page.evaluate(() => {
      const w = window as unknown as { __k: { scroll: Element | null; bubble: Element | null } };
      w.__k = { scroll: document.querySelector("#ed .ed-scroll"), bubble: document.querySelector("#ed .c-bubble") };
      const p0 = document.querySelector("#ed .c-bubble .c-md-p");
      const sel = getSelection();
      if (p0 !== null && sel !== null) {
        const range = document.createRange();
        range.selectNodeContents(p0);
        sel.removeAllRanges();
        sel.addRange(range);
      }
    });
    const rows0 = await page.evaluate(() => document.querySelectorAll("#ed .c-talk > .c-msg").length);
    const lastId = await page.evaluate((ch: string) => {
      const t = (window as unknown as { SA: { store: { turns: Record<string, { turns: Array<{ id: number }> }> } } }).SA.store.turns[ch];
      return t ? Math.max(...t.turns.map((x) => x.id)) : 0;
    }, talk);
    const added = (n: number): Record<string, unknown> => ({
      id: lastId + n,
      kind: "agent",
      source: "system",
      persona: "default",
      text: `足した返事 ${n} です。`,
      at: new Date().toISOString(),
      outcome: "done",
      steps: [],
      toolCalls: 0,
      durationMs: 1000,
      link: null,
      messageId: null,
    });
    await addTurn(page, talk, added(1));
    const after1 = await page.evaluate(() => {
      const w = window as unknown as { __k: { scroll: Element | null; bubble: Element | null } };
      const sc = document.querySelector("#ed .ed-scroll");
      return {
        rows: document.querySelectorAll("#ed .c-talk > .c-msg").length,
        gap: sc === null ? -1 : sc.scrollHeight - sc.scrollTop - sc.clientHeight,
        sameScroll: sc !== null && sc === w.__k.scroll,
        sameBubble: w.__k.bubble !== null && w.__k.bubble.isConnected && document.querySelector("#ed .c-bubble") === w.__k.bubble,
        selection: (getSelection()?.toString() ?? "").length,
      };
    });
    if (after1.rows !== rows0 + 1) say(`行を足した後の吹き出しが ${after1.rows}（${rows0 + 1} のはず）`);
    if (!(after1.gap >= 0 && after1.gap < 2)) say(`下端に居たのに新着で下へ送らない（残り ${after1.gap}）`);
    if (!after1.sameScroll) say("行を足した描き直しで .ed-scroll が別の要素になった");
    if (!after1.sameBubble) say("行を足した描き直しで最初の吹き出しが別の要素になった");
    if (after1.selection === 0) say("行を足した描き直しで選んだ文が外れた");
    await page.evaluate(() => getSelection()?.removeAllRanges());
    await edScroll(page, 300);
    await settled(page);
    const top1 = await page.evaluate(() => document.querySelector("#ed .ed-scroll")?.scrollTop ?? -1);
    await addTurn(page, talk, added(2));
    const top2 = await page.evaluate(() => document.querySelector("#ed .ed-scroll")?.scrollTop ?? -1);
    if (Math.abs(top2 - top1) > 1) say(`上を読んでいるのに新着で動いた（${top1} → ${top2}）`);

    // ----- 実行中の話題 -----
    await load(page, `/#/ch/${run}`);
    await page.waitForSelector('#ed .c-run[aria-busy="true"]', { timeout: 5000 });
    await settled(page);
    lines.push(...(await liveTalkLines(page, vp, "実行中")));
    // 11. 刻みは同じ要素のまま経過の文だけを変える。開いたすべての手順も閉じない
    const runBefore = await page.evaluate(() => {
      const w = window as unknown as { __r: { text: Element | null; bubble: Element | null } };
      w.__r = { text: document.querySelector("#ed .c-run-text"), bubble: document.querySelector("#ed .c-bubble") };
      // 入力欄の字数（古い入力欄の counter）は数えない
      return { live: document.querySelectorAll("#ed .c-talk[aria-live], #ed .c-talk [aria-live]").length, text: w.__r.text?.textContent ?? "" };
    });
    if (runBefore.live !== 0) say(`#ed の会話の行に aria-live が ${runBefore.live} 個`);
    await wait(2200);
    const runAfter = await page.evaluate(() => {
      const w = window as unknown as { __r: { text: Element | null; bubble: Element | null } };
      const text = document.querySelector("#ed .c-run-text");
      return {
        sameText: text !== null && text === w.__r.text,
        sameBubble: w.__r.bubble !== null && document.querySelector("#ed .c-bubble") === w.__r.bubble,
        text: text?.textContent ?? "",
      };
    });
    if (!runAfter.sameText) say("刻みで経過の文の要素が別の物になった");
    if (!runAfter.sameBubble) say("刻みで最初の吹き出しが別の要素になった");
    if (runAfter.text === runBefore.text) say(`刻みで経過の文が変わらない（${runAfter.text}）`);
    await page.locator("#ed .c-run .c-steps-toggle").click();
    await settled(page);
    await wait(2200);
    const runOpen = await page.evaluate(() => ({
      expanded: document.querySelector("#ed .c-run .c-steps-toggle")?.getAttribute("aria-expanded") ?? null,
      items: document.querySelectorAll("#ed .c-run ol.c-steps-list > li").length,
    }));
    if (runOpen.expanded !== "true" || runOpen.items !== 5) say(`刻みですべての手順が閉じた（aria-expanded ${String(runOpen.expanded)}・項目 ${runOpen.items}）`);
    lines.push(...(await page.evaluate(hitProblems, { min: HIT_MIN[vp], scopes: "#ed .c-talk", targets: "button, a[href]:not(.c-md-link), input, select, textarea", toast: false })).map((l) => `段 k: 実行中: ${l}`));
    await edScroll(page, "bottom");
    await shot(page, `${p}-b-talk-run`);
    // 12. 入力欄のフォーカス・書きかけ・選択の位置が、刻みと全部の描き直しをまたいで残る
    const ta = page.locator("#ed textarea").first();
    await ta.click();
    await ta.fill("あいうえお");
    await page.evaluate(() => {
      const el = document.querySelector("#ed textarea");
      if (el instanceof HTMLTextAreaElement) {
        el.focus();
        el.setSelectionRange(1, 3);
      }
    });
    await wait(2200);
    await refreshCh(page, run);
    await settled(page);
    const kept = await page.evaluate(() => {
      const el = document.querySelector("#ed textarea");
      return el instanceof HTMLTextAreaElement ? { focus: document.activeElement === el, value: el.value, a: el.selectionStart, b: el.selectionEnd } : null;
    });
    if (kept === null || !kept.focus || kept.value !== "あいうえお" || kept.a !== 1 || kept.b !== 3) say(`入力欄が残らない（${JSON.stringify(kept)}）`);
    // 13. 変換の途中の字が、刻みと全部の描き直しをまたいで切れない
    await ta.fill("");
    await page.evaluate(() => {
      const el = document.querySelector("#ed textarea");
      const w = window as unknown as { __ime: { start: number; end: number; blur: number } };
      w.__ime = { start: 0, end: 0, blur: 0 };
      if (el === null) return;
      el.addEventListener("compositionstart", () => void w.__ime.start++);
      el.addEventListener("compositionend", () => void w.__ime.end++);
      el.addEventListener("blur", () => void w.__ime.blur++);
      (el as HTMLTextAreaElement).focus();
    });
    const cdp = await page.context().newCDPSession(page);
    try {
      await cdp.send("Input.imeSetComposition", { text: "へんかん", selectionStart: 4, selectionEnd: 4 });
      await settled(page);
      const started = await page.evaluate(() => (window as unknown as { __ime: { start: number } }).__ime.start);
      if (started === 0) say("変換の途中を作れない（compositionstart が来ない）");
      await wait(2200);
      await refreshCh(page, run);
      await settled(page);
      const ime = await page.evaluate(() => {
        const el = document.querySelector("#ed textarea");
        return { ...(window as unknown as { __ime: { start: number; end: number; blur: number } }).__ime, value: el instanceof HTMLTextAreaElement ? el.value : null };
      });
      if (ime.end !== 0 || ime.blur !== 0 || ime.value !== "へんかん") say(`描き直しで変換の途中が切れた（${JSON.stringify(ime)}）`);
      await cdp.send("Input.insertText", { text: "変換" });
    } finally {
      await cdp.detach();
    }
    await ta.fill("");
    // 重さの受け入れ（ダークのスマホだけ。CPU 4 倍絞り）
    if (vp === "phone") {
      const throttle = await page.context().newCDPSession(page);
      let weight: Awaited<ReturnType<typeof talkWeight>> | null = null;
      try {
        await throttle.send("Emulation.setCPUThrottlingRate", { rate: 4 });
        weight = await page.evaluate(talkWeight);
      } finally {
        await throttle.send("Emulation.setCPUThrottlingRate", { rate: 1 });
        await throttle.detach();
      }
      const med = (xs: number[]): number => {
        const a = [...xs].sort((x, y) => x - y);
        return a.length % 2 === 1 ? a[(a.length - 1) / 2]! : (a[a.length / 2 - 1]! + a[a.length / 2]!) / 2;
      };
      const nums = { drawMed: med(weight.draw), drawMax: Math.max(...weight.draw), tickMed: med(weight.tick), tickMax: Math.max(...weight.tick) };
      const text = `draw 中央値 ${nums.drawMed.toFixed(1)}・最大 ${nums.drawMax.toFixed(1)} / tick 中央値 ${nums.tickMed.toFixed(1)}・最大 ${nums.tickMax.toFixed(1)}（ms。300 行・CPU 4 倍）`;
      const passed = nums.tickMed <= TALK_TICK_MAX_MS && nums.tickMed <= nums.drawMed * TALK_TICK_RATIO;
      if (!passed) say(`描き直しの重さが条件を満たさない: ${text}`);
      else console.log(`[v3-${p}] 描き直しの重さ: ${text}`);
      if (!weight.ok) say("重さの測りで SA.talk が描けなかった");
      if (!weight.same) say("重さの測りの tick の後、最初の吹き出しが別の要素");
      if (!weight.changed) say("重さの測りの tick で経過の文が変わらない");
    }

    // ----- 長い会話 -----
    await load(page, `/#/ch/${long}`);
    await page.waitForSelector('#ed .c-talk .c-msg[data-who="agent"]', { timeout: 5000 });
    await settled(page);
    await edScroll(page, "bottom");
    await settled(page);
    lines.push(...(await liveTalkLines(page, vp, "長い会話")));
    // 14. 「前の会話を読む」が在る・[続ける] は .tl に無く最後の返事の行の一番下で見えている・結果の文は 1 行で省かれる・時刻は切れない
    const longLook = await page.evaluate(() => {
      const tl = document.querySelector("#ed .ed-scroll > [data-cards] + .tl");
      const acts = document.querySelectorAll("#ed .c-talk .c-msg-act");
      const act = acts[0] ?? null;
      const btn = act?.querySelector("button") ?? null;
      const scroll = document.querySelector("#ed .ed-scroll");
      const last = [...document.querySelectorAll('#ed .c-talk > .c-msg[data-who="agent"]')].at(-1);
      const label = last?.querySelector(".c-steps-label") ?? null;
      const time = last?.querySelector(".c-msg-time") ?? null;
      return {
        older: document.querySelector("#ed .c-talk-older button") !== null,
        tlCont: tl === null ? null : [...tl.querySelectorAll("button")].filter((b) => (b.textContent ?? "").trim() === "続ける").length,
        tlKids: tl === null ? null : tl.children.length,
        tlH: tl === null ? null : tl.getBoundingClientRect().height,
        acts: acts.length,
        actLast: act !== null && last !== undefined && act.parentElement === last && last.lastElementChild === act,
        busy: btn === null ? null : btn.getAttribute("aria-busy"),
        below: btn === null || scroll === null ? null : btn.getBoundingClientRect().bottom - scroll.getBoundingClientRect().bottom,
        labelText: label?.textContent ?? null,
        labelH: label === null ? null : label.getBoundingClientRect().height,
        labelLh: label === null ? null : parseFloat(getComputedStyle(label).lineHeight),
        cut: label === null ? null : label.scrollWidth > label.clientWidth,
        timeCut: time === null ? null : time.scrollWidth > time.clientWidth,
      };
    });
    if (!longLook.older) say("長い会話に「前の会話を読む」が無い");
    if (longLook.tlCont !== 0) say(`.tl に [続ける] が在る（${String(longLook.tlCont)}）`);
    if (longLook.tlKids !== 0 || longLook.tlH === null || longLook.tlH > 0.5) say(`長い会話の .tl が空でない（子 ${String(longLook.tlKids)}・高さ ${String(longLook.tlH)}）`);
    if (longLook.acts !== 1 || !longLook.actLast) say(`[続ける] が最後の返事の行の最後の子に 1 つでない（${longLook.acts} 個・最後の子 ${String(longLook.actLast)}）`);
    if (longLook.busy === "true") say("[続ける] が押す前から待ちの形");
    if (longLook.below === null || longLook.below > 0.5) say(`下端へ送っても [続ける] が見えていない（下端との差 ${String(longLook.below)}）`);
    if (longLook.labelText === null || !longLook.labelText.startsWith("手順の上限で止まりました")) say(`最後の返事の結果の文が手順の上限でない（${String(longLook.labelText)}）`);
    else {
      if (longLook.labelH === null || longLook.labelLh === null || longLook.labelH > longLook.labelLh * 1.5) say(`結果の文が 1 行でない（高さ ${String(longLook.labelH)}）`);
      // スマホは入りきらずに末尾を省く。タブレット・PC は列が広く、全部が 1 行に入る
      if (vp === "phone" && longLook.cut !== true) say("結果の文の末尾が省かれていない（スマホ）");
      if (vp !== "phone" && longLook.cut !== false) say(`結果の文が広い幅で省かれている（${vp}）`);
    }
    if (longLook.timeCut !== false) say(`最後の返事の時刻が切れている（${String(longLook.timeCut)}）`);
    await shot(page, `${p}-b-talk-long`);
    lines.push(...(await page.evaluate(hitProblems, { min: HIT_MIN[vp], scopes: "#ed .c-talk > article.c-msg:last-of-type", targets: "button", toast: false })).map((l) => `段 k の 14 当たり: ${l}`));
    await edScroll(page, "bottom");
    await settled(page);
    // 20. 最後の返事の手順を開くと結果の文を省かずに折り返す（スマホは 2 行以上・広い幅は 1 行）。行の幅は変わらず、閉じると元に戻る
    const footLook = (): Promise<{ rowW: number; footH: number; labelH: number; lh: number; cut: boolean; tail: boolean; timeCut: boolean; list: boolean; actLast: boolean } | null> =>
      page.evaluate(() => {
        const last = [...document.querySelectorAll('#ed .c-talk > .c-msg[data-who="agent"]')].at(-1);
        const foot = last?.querySelector(":scope > .c-msg-foot") ?? null;
        const label = foot?.querySelector(".c-steps-label") ?? null;
        const time = foot?.querySelector(".c-msg-time") ?? null;
        if (last === undefined || foot === null || label === null || time === null) return null;
        const lb = label.getBoundingClientRect();
        const range = document.createRange();
        const text = label.firstChild;
        let tail = false;
        if (text !== null && text.nodeType === Node.TEXT_NODE && (text.textContent ?? "").length > 0) {
          const len = (text.textContent ?? "").length;
          range.setStart(text, len - 1);
          range.setEnd(text, len);
          const rects = [...range.getClientRects()];
          const r = rects.at(-1);
          tail = r !== undefined && r.right <= lb.right + 0.5 && r.bottom <= lb.bottom + 0.5;
        }
        const act = last.querySelector(":scope > .c-msg-act");
        return {
          rowW: last.getBoundingClientRect().width,
          footH: foot.getBoundingClientRect().height,
          labelH: lb.height,
          lh: parseFloat(getComputedStyle(label).lineHeight),
          cut: label.scrollWidth > label.clientWidth,
          tail,
          timeCut: time.scrollWidth > time.clientWidth,
          list: last.querySelector(":scope > .c-steps-list") !== null,
          actLast: act !== null && last.lastElementChild === act,
        };
      });
    const toggleLast = (): Promise<void> => page.locator('#ed .c-talk > .c-msg[data-who="agent"]:last-of-type > .c-msg-foot .c-steps-toggle').click();
    const closed = await footLook();
    if (closed === null) say("20. 最後の返事に結果の文のボタンが無い");
    else {
      await toggleLast();
      await settled(page);
      await edScroll(page, "bottom");
      await settled(page);
      const opened = await footLook();
      if (opened === null) say("20. 開いた後に結果の文が無い");
      else {
        if (opened.cut) say("20. 開いた結果の文が省かれている");
        if (!opened.tail) say("20. 開いた結果の文の最後の字が文の箱の外");
        if (Math.abs(opened.rowW - closed.rowW) > 0.5) say(`20. 開くと行の幅が変わった（${closed.rowW.toFixed(1)} → ${opened.rowW.toFixed(1)}）`);
        if (opened.timeCut) say("20. 開いた行の時刻が切れている");
        if (!opened.list || !opened.actLast) say(`20. 開いた行の手順の一覧 ${String(opened.list)}・[続ける] が最後の子 ${String(opened.actLast)}`);
        if (vp === "phone") {
          if (!(opened.labelH > opened.lh * 1.5)) say(`20. スマホで開いた結果の文が 2 行でない（高さ ${opened.labelH.toFixed(1)}）`);
          if (!(opened.footH > 25)) say(`20. スマホで開いた足の行の高さ ${opened.footH.toFixed(1)}（25 より高いはず）`);
        } else {
          if (opened.labelH > opened.lh * 1.5) say(`20. 広い幅で開いた結果の文が 1 行でない（高さ ${opened.labelH.toFixed(1)}）`);
          if (Math.abs(opened.footH - 24) > 0.5) say(`20. 広い幅で開いた足の行の高さ ${opened.footH.toFixed(1)}（24 のはず）`);
        }
      }
      lines.push(...(await liveTalkLines(page, vp, "長い会話・手順を開いた所")));
      lines.push(...(await page.evaluate(hitProblems, { min: HIT_MIN[vp], scopes: "#ed .c-talk > article.c-msg:last-of-type", targets: "button", toast: false })).map((l) => `段 k の 20 当たり: ${l}`));
      if (vp === "phone") {
        await edScroll(page, "bottom");
        await settled(page);
        await shot(page, `${p}-b-talk-long-open`);
      }
      await toggleLast();
      await settled(page);
      const again = await footLook();
      if (again === null || Math.abs(again.footH - 24) > 0.5) say(`20. 閉じた後の足の行の高さ ${again === null ? "なし" : again.footH.toFixed(1)}（24 のはず）`);
      if (vp === "phone" && again !== null && !again.cut) say("20. 閉じた後にスマホで結果の文が省かれていない");
      await edScroll(page, "bottom");
      await settled(page);
    }
    // 15. 先頭へ送ると前の行を読み、見ていた吹き出しの位置が動かない
    const mark = await page.evaluate(() => {
      const sc = document.querySelector("#ed .ed-scroll");
      if (sc === null) return null;
      sc.scrollTop = 0;
      const msgs = [...document.querySelectorAll("#ed .c-talk > .c-msg")];
      const box = sc.getBoundingClientRect();
      const seen = msgs.find((m) => m.getBoundingClientRect().bottom > box.top) ?? null;
      (window as unknown as { __m: Element | null }).__m = seen;
      return seen === null ? null : seen.getBoundingClientRect().top;
    });
    await page.waitForFunction(() => document.querySelectorAll("#ed .c-talk > .c-msg").length >= 60, undefined, { timeout: 5000 }).catch(() => undefined);
    await settled(page);
    const after = await page.evaluate(() => {
      const m = (window as unknown as { __m: Element | null }).__m;
      return { rows: document.querySelectorAll("#ed .c-talk > .c-msg").length, top: m !== null && m.isConnected ? m.getBoundingClientRect().top : null };
    });
    if (after.rows !== 60) say(`前の会話を読んだ後の行が ${after.rows}（60 のはず）`);
    if (mark === null || after.top === null || Math.abs(after.top - mark) > 2) say(`前の会話を読んだら見ていた吹き出しが動いた（${String(mark)} → ${String(after.top)}）`);

    // 19. [続ける] を押す（作り物の受け付けは 202）: 待ちの形を 1 回は見て、消える。送りは 1 回・入力欄と .ed-scroll は同じ要素・知らせは出ない・行の数は同じ
    await edScroll(page, "bottom");
    await settled(page);
    const continues: string[] = [];
    const onContinue = (r: { method: () => string; url: () => string }): void => {
      if (r.method() === "POST" && r.url().includes(`/api/channels/${long}/continue`)) continues.push(r.url());
    };
    page.on("request", onContinue);
    try {
      const from = logLines.length;
      const rowsBefore = await page.evaluate(() => {
        const w = window as unknown as { __busy: number; __obs?: MutationObserver; __ta: Element | null; __sc: Element | null };
        w.__busy = 0;
        w.__ta = document.querySelector("#ed > [data-composer] textarea");
        w.__sc = document.querySelector("#ed .ed-scroll");
        const root = document.querySelector("#ed .c-talk");
        if (root !== null) {
          w.__obs = new MutationObserver(() => {
            if (root.querySelector('.c-msg-act .c-btn[aria-busy="true"]') !== null) w.__busy++;
          });
          w.__obs.observe(root, { subtree: true, attributes: true, childList: true });
        }
        return document.querySelectorAll("#ed .c-talk > .c-msg").length;
      });
      await page.locator("#ed .c-talk .c-msg-act .c-btn").click();
      await page.waitForFunction(() => document.querySelector("#ed .c-msg-act") === null, undefined, { timeout: 5000 }).catch(() => undefined);
      await settled(page);
      const pressed = await page.evaluate(() => {
        const w = window as unknown as { __busy: number; __obs?: MutationObserver; __ta: Element | null; __sc: Element | null };
        w.__obs?.disconnect();
        const tl = document.querySelector("#ed .ed-scroll > [data-cards] + .tl");
        return {
          busy: w.__busy,
          act: document.querySelector("#ed .c-msg-act") !== null,
          tlCont: tl === null ? 0 : [...tl.querySelectorAll("button")].filter((b) => (b.textContent ?? "").trim() === "続ける").length,
          sameTa: w.__ta !== null && w.__ta === document.querySelector("#ed > [data-composer] textarea"),
          sameSc: w.__sc !== null && w.__sc === document.querySelector("#ed .ed-scroll"),
          rows: document.querySelectorAll("#ed .c-talk > .c-msg").length,
        };
      });
      const pressedToast = await page.evaluate(noticeText, "alert" as const);
      if (continues.length !== 1) say(`19. [続ける] を押した送りが ${continues.length} 回（1 回のはず）`);
      if (pressed.busy === 0) say("19. [続ける] の待ちの形を見なかった");
      if (pressed.act || pressed.tlCont !== 0) say(`19. 押した後も [続ける] が在る（行 ${String(pressed.act)}・.tl ${pressed.tlCont}）`);
      if (!pressed.sameTa || !pressed.sameSc) say(`19. 押した後に入力欄か .ed-scroll が替わった（入力欄 ${String(pressed.sameTa)}・.ed-scroll ${String(pressed.sameSc)}）`);
      if (pressedToast !== "") say(`19. 押した後に知らせ「${pressedToast}」`);
      if (pressed.rows !== rowsBefore) say(`19. 押した後の行が ${pressed.rows}（${rowsBefore} のはず）`);
      if (logLines.length !== from) say(`19. 押した間に console.log の行が ${logLines.length - from} 増えた`);
    } finally {
      page.off("request", onContinue);
    }

    // 17. 等幅の字（スマホ。幅 390 と 375）
    if (vp === "phone") {
      await load(page, `/#/ch/${talk}`);
      await page.waitForSelector('#ed .c-talk .c-msg[data-who="agent"]', { timeout: 5000 });
      await settled(page);
      lines.push(...(await withMono(page, () => liveTalkLines(page, vp, "等幅の字・幅 390"), "本番の会話")));
      try {
        await page.setViewportSize({ width: 375, height: 812 });
        await settled(page);
        lines.push(
          ...(await withMono(
            page,
            async () => {
              const got = await liveTalkLines(page, vp, "等幅の字・幅 375");
              await edScroll(page, "top");
              await shot(page, `${p}-b-talk-mono375`);
              return got;
            },
            "本番の会話",
          )),
        );
      } finally {
        await page.setViewportSize(VIEWPORTS.phone.viewport);
        await settled(page);
      }
    }

    // 10. 古い CSS の漏れ（本番の会話と見本の会話の節。タブレットは除く）
    if (vp !== "tablet") {
      await load(page, `/#/ch/${talk}`);
      await page.waitForSelector('#ed .c-talk .c-msg[data-who="agent"]', { timeout: 5000 });
      await settled(page);
      const styles = ({ root, sels, props }: { root: string; sels: string[]; props: string[] }): Record<string, Record<string, string> | null> => {
        const out: Record<string, Record<string, string> | null> = {};
        const scope = document.querySelector(root);
        for (const sel of sels) {
          const el = scope === null ? null : scope.querySelector(sel);
          out[sel] = el === null ? null : Object.fromEntries(props.map((prop) => [prop, getComputedStyle(el).getPropertyValue(prop)]));
        }
        return out;
      };
      const real = await page.evaluate(styles, { root: "#ed .c-talk", sels: LEAK_TALK, props: LEAK_PROPS });
      await page.goto("about:blank");
      await page.goto(base + "/static/gallery.html", { waitUntil: "load" });
      await page.waitForSelector('[data-section="talk"] .c-talk', { timeout: 5000 });
      const demo = await page.evaluate(styles, { root: '[data-section="talk"]', sels: LEAK_TALK, props: LEAK_PROPS });
      for (const sel of LEAK_TALK) {
        const a = real[sel];
        const b = demo[sel];
        if (!a || !b) {
          say(`漏れ: ${sel} が${!a ? "本番" : "見本"}に無い`);
          continue;
        }
        for (const prop of LEAK_PROPS) if (a[prop] !== b[prop]) say(`漏れ: ${sel} の ${prop} が 本番 ${a[prop]} / 見本 ${b[prop]}`);
      }
    }
    return lines;
  }

  /**
   * 段 n（本番の入力欄。ダークの 3 組）: 吹き出しの確かめを開いて 0〜10・12、スマホは長い会話で 11（重さ）。
   * 打鍵は page.keyboard と CDP（値を直に書き換えるのは 5 の fill だけ）。足りない物の文（全部を測ってから、1 つでもあれば段を失敗にする）。0 で口に渡っていなければそこで止める
   */
  async function composerStage(page: Page, vp: Viewport, p: string): Promise<string[]> {
    const lines: string[] = [];
    const say = (n: number, name: string, text: string): void => void lines.push(`段 n の ${n} ${name}: ${text}`);
    const TA = "#ed > [data-composer] textarea.c-composer-input";
    const ta = page.locator(TA);
    /** 欄の高さ・行の高さ・値・選択・焦点・印 */
    const field = (): Promise<{ h: number; lh: number; value: string; a: number; b: number; focus: boolean; mark: boolean; scroll: boolean } | null> =>
      page.evaluate((sel: string) => {
        const el = document.querySelector(sel);
        if (!(el instanceof HTMLTextAreaElement)) return null;
        return {
          h: el.getBoundingClientRect().height,
          lh: parseFloat(getComputedStyle(el).lineHeight),
          value: el.value,
          a: el.selectionStart,
          b: el.selectionEnd,
          focus: document.activeElement === el,
          mark: (el as unknown as { __n?: number }).__n === 1,
          scroll: el.scrollHeight > el.clientHeight,
        };
      }, TA);
    const clear = async (): Promise<void> => {
      await ta.focus();
      await page.keyboard.press("Control+A");
      await page.keyboard.press("Backspace");
      await settled(page);
    };
    const near = (a: number, b: number, d: number): boolean => Math.abs(a - b) <= d;

    await load(page, `/#/ch/${talk}`);
    await page.waitForSelector('#ed .c-talk .c-msg[data-who="agent"]', { timeout: 5000 });
    await settled(page);
    // 0. 口に渡ったか（渡っていなければ、ほかを測らずに止める）
    const mouth = await page.evaluate(() => ({ parts: document.querySelectorAll("#ed > [data-composer] .c-composer").length, old: document.querySelectorAll("#ed .composer-wrap").length }));
    if (mouth.parts !== 1 || mouth.old !== 0) throw new Error(`段 n の 0: 入力欄が部品でない（.c-composer ${mouth.parts} 個・.composer-wrap ${mouth.old} 個）`);

    // 1. 空の形
    const empty = await page.evaluate((sel: string) => {
      const el = document.querySelector(sel);
      if (!(el instanceof HTMLTextAreaElement)) return null;
      const cs = getComputedStyle(el);
      // placeholder と同じ字で 1 行に並べた幅が、欄の中の幅に入るか（scrollWidth <= clientWidth と同じ見方）
      const probe = document.createElement("span");
      probe.textContent = el.placeholder;
      probe.style.cssText = `position:absolute;visibility:hidden;white-space:nowrap;font:${cs.font};letter-spacing:${cs.letterSpacing}`;
      document.body.append(probe);
      const textW = probe.getBoundingClientRect().width;
      probe.remove();
      const inner = el.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
      const root = el.closest("[data-composer]");
      return {
        h: el.getBoundingClientRect().height,
        placeholder: el.placeholder,
        fits: textW <= inner,
        textW,
        inner,
        count: root?.querySelector(".c-composer-count")?.getBoundingClientRect().height ?? -1,
        send: root?.querySelector(".c-composer-row > .c-btn")?.getAttribute("aria-disabled") ?? null,
      };
    }, TA);
    if (empty === null) say(1, "空の形", "欄が無い");
    else {
      if (!near(empty.h, 44, 0.5)) say(1, "空の形", `欄の高さ ${empty.h.toFixed(1)}。44 のはず`);
      if (empty.placeholder !== "この話題に送る") say(1, "空の形", `placeholder「${empty.placeholder}」`);
      if (!empty.fits) say(1, "空の形", `placeholder が 1 行に入らない（${empty.textW.toFixed(1)} > ${empty.inner.toFixed(1)}）`);
      if (empty.count !== 0) say(1, "空の形", `字数の入れ物の高さ ${empty.count}。0 のはず`);
      if (empty.send !== "true") say(1, "空の形", `［送る］の aria-disabled が ${String(empty.send)}`);
    }
    await edScroll(page, "bottom");
    await shot(page, `${p}-b-composer-empty`);

    // 2. 打鍵で同じ要素のまま（打つ途中で会話の描き直しを 1 回またぐ）
    await ta.click();
    await page.evaluate((sel: string) => {
      const el = document.querySelector(sel);
      if (el !== null) (el as unknown as { __n?: number }).__n = 1;
    }, TA);
    const typed = "abcdefghij".repeat(3);
    await page.keyboard.type(typed.slice(0, 15));
    await refreshCh(page, talk);
    await page.keyboard.type(typed.slice(15));
    await settled(page);
    const f2 = await field();
    if (f2 === null || !f2.mark || !f2.focus || f2.value !== typed) say(2, "打鍵で同じ要素のまま", JSON.stringify(f2 && { mark: f2.mark, focus: f2.focus, value: f2.value.length }));

    // 3. 選択が残る（会話の描き直し・1 秒の刻み 2 回・3 秒の読み直し 1 回）
    await page.evaluate((sel: string) => (document.querySelector(sel) as HTMLTextAreaElement | null)?.setSelectionRange(3, 7), TA);
    await refreshCh(page, talk);
    await wait(2200);
    await wait(3200);
    const f3 = await field();
    if (f3 === null || !f3.mark || !f3.focus || f3.value !== typed || f3.a !== 3 || f3.b !== 7) say(3, "選択が残る", JSON.stringify(f3 && { mark: f3.mark, focus: f3.focus, value: f3.value.length, a: f3.a, b: f3.b }));

    // 4. 変換の途中が切れない
    await clear();
    await page.evaluate((sel: string) => {
      const el = document.querySelector(sel);
      const w = window as unknown as { __ime: { start: number; end: number; blur: number } };
      w.__ime = { start: 0, end: 0, blur: 0 };
      if (!(el instanceof HTMLTextAreaElement)) return;
      el.addEventListener("compositionstart", () => void w.__ime.start++);
      el.addEventListener("compositionend", () => void w.__ime.end++);
      el.addEventListener("blur", () => void w.__ime.blur++);
      el.focus();
    }, TA);
    const ime = await page.context().newCDPSession(page);
    try {
      await ime.send("Input.imeSetComposition", { text: "へんかん", selectionStart: 4, selectionEnd: 4 });
      await settled(page);
      const started = await page.evaluate(() => (window as unknown as { __ime: { start: number } }).__ime.start);
      if (started === 0) say(4, "IME", "変換の途中を作れない（compositionstart が来ない）");
      await refreshCh(page, talk);
      await wait(2200);
      const mid = await page.evaluate((sel: string) => {
        const el = document.querySelector(sel);
        return { ...(window as unknown as { __ime: { start: number; end: number; blur: number } }).__ime, value: el instanceof HTMLTextAreaElement ? el.value : null };
      }, TA);
      if (mid.end !== 0 || mid.blur !== 0 || mid.value === null || !mid.value.includes("へんかん")) say(4, "IME", `描き直しで変換の途中が切れた（${JSON.stringify(mid)}）`);
      await ime.send("Input.insertText", { text: "変換" });
      await settled(page);
      const done = await page.evaluate((sel: string) => {
        const el = document.querySelector(sel);
        return { end: (window as unknown as { __ime: { end: number } }).__ime.end, value: el instanceof HTMLTextAreaElement ? el.value : null };
      }, TA);
      if (done.value !== "変換" || done.end !== 1) say(4, "IME", `確定の後 ${JSON.stringify(done)}（値「変換」・compositionend 1 のはず）`);
    } finally {
      await ime.detach();
    }

    // 5. 伸びる（2・6・10 行）。一番下を見ていたら、6 行でも最後の吹き出しの時刻が入力欄の上に見える。消すと 1 行に戻る
    await clear();
    await edScroll(page, "bottom");
    await settled(page);
    const rowsOf = (n: number): string => Array.from({ length: n }, (_v, i) => `${i + 1} 行目`).join("\n");
    for (const n of [2, 6, 10]) {
      await ta.fill(rowsOf(n));
      await settled(page);
      const f = await field();
      const want = f === null ? 0 : 44 + f.lh * Math.min(n - 1, 5);
      if (f === null || !near(f.h, want, 1)) say(5, "伸びる", `${n} 行の欄の高さ ${f?.h.toFixed(1) ?? "?"}。${want.toFixed(1)} のはず`);
      if (n === 10 && !(f && f.scroll)) say(5, "伸びる", "10 行の欄が中で送れない");
      if (n !== 10 && f && f.scroll) say(5, "伸びる", `${n} 行の欄が中で送れる`);
      if (n === 6) {
        const seen = await page.evaluate(() => {
          const last = [...document.querySelectorAll("#ed .c-talk > .c-msg")].at(-1);
          const time = last?.querySelector(".c-msg-time") ?? null;
          const root = document.querySelector("#ed > [data-composer]");
          return time === null || root === null ? null : { time: time.getBoundingClientRect().bottom, root: root.getBoundingClientRect().top };
        });
        if (seen === null || seen.time > seen.root + 0.5) say(5, "伸びる", `6 行のとき最後の吹き出しの時刻の下端 ${seen?.time.toFixed(1) ?? "?"} が入力欄の上端 ${seen?.root.toFixed(1) ?? "?"} より下`);
        await shot(page, `${p}-b-composer-6lines`);
      }
    }
    await clear();
    const f5 = await field();
    if (f5 === null || !near(f5.h, 44, 0.5) || f5.value !== "") say(5, "伸びる", `書きかけを消した後の欄の高さ ${f5?.h.toFixed(1) ?? "?"}（44 のはず）・値 ${JSON.stringify(f5?.value)}`);

    // 6. 上を読んでいる途中は、欄が伸びても動かさない
    await edScroll(page, "bottom");
    await edScroll(page, 300);
    await settled(page);
    const top0 = await page.evaluate(() => document.querySelector("#ed .ed-scroll")?.scrollTop ?? -1);
    await ta.focus();
    await page.keyboard.press("Shift+Enter");
    await page.keyboard.type("x");
    // この間に位置が動かない事を見るので、落ち着きではなく実時間で待つ
    await wait(150);
    const top1 = await page.evaluate(() => document.querySelector("#ed .ed-scroll")?.scrollTop ?? -1);
    const f6 = await field();
    if (!(top0 > 0) || !near(top0, top1, 1)) say(6, "上を読んでいる途中", `scrollTop ${top0} → ${top1}`);
    if (f6 === null || !(f6.h > 44 + 1)) say(6, "上を読んでいる途中", `改行で欄が伸びていない（${f6?.h.toFixed(1) ?? "?"}）`);
    await clear();

    // 7. 字数（1,700 字は出ない・1,701 字で出る・1,901 字で上限を超えた色。［送る］は押せる形のまま）
    const insert = await page.context().newCDPSession(page);
    const countLook = (): Promise<{ text: string | null; over: string | null; color: string | null; danger: string; send: string | null }> =>
      page.evaluate(() => {
        const root = document.querySelector("#ed > [data-composer]");
        const text = root?.querySelector(".c-composer-count-text") ?? null;
        const probe = document.createElement("span");
        probe.style.color = "var(--danger)";
        document.body.append(probe);
        const danger = getComputedStyle(probe).color;
        probe.remove();
        return {
          text: text === null ? null : (text.textContent ?? ""),
          over: text === null ? null : text.getAttribute("data-over"),
          color: text === null ? null : getComputedStyle(text).color,
          danger,
          send: root?.querySelector(".c-composer-row > .c-btn")?.getAttribute("aria-disabled") ?? null,
        };
      });
    try {
      await ta.focus();
      await insert.send("Input.insertText", { text: "あ".repeat(1700) });
      await settled(page);
      const c0 = await countLook();
      if (c0.text !== null) say(7, "字数", `1,700 字で字数が出ている（${c0.text}）`);
      await insert.send("Input.insertText", { text: "い" });
      await settled(page);
      const c1 = await countLook();
      if (c1.text !== "1,701 / 1,900") say(7, "字数", `1,701 字の字数「${String(c1.text)}」`);
      if (c1.over !== null || c1.color === c1.danger) say(7, "字数", "1,701 字が上限を超えた形");
      if (c1.send !== null) say(7, "字数", `1,701 字で［送る］の aria-disabled が ${c1.send}`);
      if (vp === "phone") {
        await edScroll(page, "bottom");
        await shot(page, `${p}-b-composer-count`);
      }
      // 10. 古い CSS の漏れ（字数の出た形で、見本の near と比べる。タブレットは除く）
      if (vp !== "tablet") lines.push(...(await composerLeaks(page)));
      await ta.focus();
      await page.keyboard.press("Control+End");
      await insert.send("Input.insertText", { text: "う".repeat(200) });
      await settled(page);
      const c2 = await countLook();
      if (c2.text !== "1,901 / 1,900" || c2.over !== "true" || c2.color !== c2.danger) say(7, "字数", `1,901 字 ${JSON.stringify(c2)}`);
      if (c2.send !== null) say(7, "字数", `1,901 字で［送る］の aria-disabled が ${c2.send}`);
    } finally {
      await insert.detach();
    }
    await clear();

    // 8. 書きかけが残る（別の話題へ行って戻る・ページを読み直す）
    await ta.focus();
    await page.keyboard.type("draft");
    // 打った字が下書きに渡るまでの短い待ち（今と同じ間で別の話題へ移る）
    await wait(100);
    const app = (tab: string): Promise<void> => page.evaluate((t: string) => (window as unknown as { SA: { app: { open: (t: string) => void } } }).SA.app.open(t), tab);
    await app(`ch:${open}`);
    await settled(page);
    await app(`ch:${talk}`);
    await page.waitForSelector(TA, { timeout: 5000 });
    await settled(page);
    const f8 = await field();
    if (f8 === null || f8.value !== "draft" || !near(f8.h, 44, 0.5)) say(8, "書きかけが残る", `戻った後 ${JSON.stringify(f8 && { value: f8.value, h: f8.h })}`);
    await load(page, `/#/ch/${talk}`);
    await page.waitForSelector(TA, { timeout: 5000 });
    const f8b = await field();
    if (f8b === null || f8b.value !== "draft") say(8, "書きかけが残る", `読み直した後の値 ${JSON.stringify(f8b?.value)}`);

    // 9. 当たり（スマホ・タブレットは 44。PC も［送る］と欄は 44 の高さ）
    lines.push(...(await page.evaluate(hitProblems, { min: HIT_MIN[vp], scopes: "#ed > [data-composer]", targets: "button, textarea", toast: false })).map((l) => `段 n の 9 当たり: ${l}`));
    const sizes = await page.evaluate(() => {
      const root = document.querySelector("#ed > [data-composer]");
      const b = root?.querySelector(".c-composer-row > .c-btn")?.getBoundingClientRect();
      return b === undefined ? null : { w: b.width, h: b.height };
    });
    if (sizes === null || sizes.w < 44 || sizes.h < 44) say(9, "当たり", `［送る］が ${sizes === null ? "無い" : `${sizes.w.toFixed(1)}x${sizes.h.toFixed(1)}`}（44x44 以上のはず）`);

    // 12. 送る（作り物の送りは受け付けないので失敗の道）: 待ちの形になって戻る・本文が残る・知らせが出る。PC は Enter も。Shift+Enter は改行
    const posts: string[] = [];
    const onRequest = (r: { method: () => string; url: () => string }): void => {
      if (r.method() === "POST" && r.url().includes(`/api/channels/${talk}/messages`)) posts.push(r.url());
    };
    page.on("request", onRequest);
    try {
      await page.evaluate(() => {
        const w = window as unknown as { __busy: number; __obs?: MutationObserver };
        w.__busy = 0;
        const root = document.querySelector("#ed > [data-composer]");
        if (root === null) return;
        w.__obs = new MutationObserver(() => {
          if (root.querySelector('.c-composer-row > .c-btn[aria-busy="true"]') !== null) w.__busy++;
        });
        w.__obs.observe(root, { subtree: true, attributes: true, childList: true });
      });
      const failedOnce = async (how: string, press: () => Promise<void>): Promise<void> => {
        const before = posts.length;
        await page.evaluate(() => {
          (window as unknown as { __busy: number }).__busy = 0;
          // 前の失敗は × を押して消す（部品の DOM を外から外さない）
          for (const b of document.querySelectorAll<HTMLButtonElement>('#c-notice-root .c-toast-list[role="alert"] .c-toast-item button[aria-label="閉じる"]')) b.click();
        });
        // 前の失敗が残ると、後の「知らせの文」の検査が古い知らせで通ってしまうので、消えなければ知らせる
        const cleared = await page
          .waitForFunction(() => document.querySelector('#c-notice-root .c-toast-list[role="alert"] .c-toast-item') === null, undefined, { timeout: 5000 })
          .then(() => true, () => false);
        if (!cleared) say(12, "送る", `${how}: 前の失敗の知らせが × で消えない`);
        const from = logLines.length;
        await press();
        await page.waitForFunction(noticeHas, { role: "alert" as const, text: "" }, { timeout: 5000 }).catch(() => undefined);
        await settled(page);
        // わざと起こした失敗（送りの 404 とその console.error）の 2 行だけを console.log から外す。数が違えば残して知らせる
        const removed = dropExpected(from, [`POST /api/channels/${talk}/messages`, "Failed to load resource"]);
        if (removed.length !== 2) {
          logLines.push(...removed);
          say(12, "送る", `${how}: 失敗の行が ${removed.length} 行（2 行のはず）`);
        }
        const after = await page.evaluate(() => ({
          busy: (window as unknown as { __busy: number }).__busy,
          now: document.querySelector('#ed > [data-composer] .c-composer-row > .c-btn[aria-busy="true"]') !== null,
        }));
        const afterToast = await page.evaluate(noticeText, "alert" as const);
        const f = await field();
        if (posts.length !== before + 1) say(12, "送る", `${how}: POST が ${posts.length - before} 回`);
        if (after.busy === 0 || after.now) say(12, "送る", `${how}: 待ちの形になって戻らない（${JSON.stringify(after)}）`);
        if (f === null || f.value !== "draft") say(12, "送る", `${how}: 本文が残らない（${JSON.stringify(f?.value)}）`);
        if (!afterToast.includes("このチャンネルには送れません")) say(12, "送る", `${how}: 知らせ「${afterToast}」`);
      };
      await failedOnce("［送る］", () => page.locator("#ed > [data-composer] .c-composer-row > .c-btn").click());
      if (vp === "pc") {
        await failedOnce("Enter", async () => {
          await ta.focus();
          await page.keyboard.press("End");
          await page.keyboard.press("Enter");
        });
      }
      const before = posts.length;
      await ta.focus();
      await page.keyboard.press("Control+End");
      await page.keyboard.press("Shift+Enter");
      // 実時間: この間に POST が起きない事を見る
      await wait(300);
      const f12 = await field();
      if (posts.length !== before || f12 === null || f12.value !== "draft\n") say(12, "送る", `Shift+Enter: POST ${posts.length - before} 回・値 ${JSON.stringify(f12?.value)}`);
      // 受け付けた形（応答だけを作る）: 書きかけが消えて 1 行に戻る
      const route = `**/api/channels/${talk}/messages`;
      await page.route(route, (r) => (r.request().method() === "POST" ? r.fulfill({ status: 202, contentType: "application/json", body: JSON.stringify({ turnId: 990001 }) }) : r.fallback()));
      try {
        await page.keyboard.type("2 行目");
        await page.locator("#ed > [data-composer] .c-composer-row > .c-btn").click();
        await page.waitForFunction((sel: string) => (document.querySelector(sel) as HTMLTextAreaElement | null)?.value === "", TA, { timeout: 5000 }).catch(() => undefined);
        await settled(page);
        const sent = await field();
        if (sent === null || sent.value !== "" || !near(sent.h, 44, 0.5)) say(12, "送る", `受け付けた後 ${JSON.stringify(sent && { value: sent.value, h: sent.h })}（空・44 のはず）`);
        const draft = await page.evaluate((ch: string) => (window as unknown as { SA: { app: { draft: (c: string) => string } } }).SA.app.draft(ch), talk);
        if (draft !== "") say(12, "送る", `受け付けた後の書きかけ ${JSON.stringify(draft)}`);
      } finally {
        await page.unroute(route);
      }
      await page.evaluate(() => (window as unknown as { __obs?: MutationObserver }).__obs?.disconnect());
    } finally {
      page.off("request", onRequest);
    }

    // 11. 重さ（ダークのスマホ・長い会話・CPU 4 倍）: 本番の欄に 1 字ずつ違う字を 100 字打ち、input の処理（本番の on.input）を測る。その間の SA.talk.draw を数える
    if (vp === "phone") {
      await load(page, `/#/ch/${long}`);
      await page.waitForSelector(TA, { timeout: 5000 });
      await settled(page);
      await edScroll(page, "bottom");
      await ta.focus();
      await page.evaluate((sel: string) => {
        const el = document.querySelector(sel);
        const root = el?.closest("[data-composer]") ?? null;
        const sa = (window as unknown as { SA: { talk: { draw: (...a: unknown[]) => unknown } } }).SA;
        const w = window as unknown as { __w: { times: number[]; talks: number; other: number; inside: boolean; t0: number } };
        w.__w = { times: [], talks: 0, other: 0, inside: false, t0: 0 };
        const draw = sa.talk.draw;
        // input の処理の中の描き直しと、その外（定期の読み直しなど）を分けて数える
        sa.talk.draw = (...a: unknown[]) => {
          if (w.__w.inside) w.__w.talks++;
          else w.__w.other++;
          return draw(...a);
        };
        if (root === null) return;
        // 欄の上の根で、捕まえる段（欄の受け手より前）と泡の段（欄の受け手の後）の間を測る。間に描き直しと、その後の layout の読みまで
        root.addEventListener("input", () => {
          w.__w.inside = true;
          w.__w.t0 = performance.now();
        }, true);
        root.addEventListener("input", () => {
          void (root as HTMLElement).offsetHeight;
          w.__w.times.push(performance.now() - w.__w.t0);
          w.__w.inside = false;
        });
      }, TA);
      const cdp = await page.context().newCDPSession(page);
      let got: { times: number[]; talks: number; other: number; value: number } | null = null;
      try {
        await cdp.send("Emulation.setCPUThrottlingRate", { rate: 4 });
        // 1 字ずつ違う字（CJK の続き 100 字）
        for (let i = 0; i < 100; i++) await cdp.send("Input.insertText", { text: String.fromCharCode(0x4e00 + i) });
        got = await page.evaluate((sel: string) => {
          const w = window as unknown as { __w: { times: number[]; talks: number; other: number } };
          return { times: w.__w.times, talks: w.__w.talks, other: w.__w.other, value: (document.querySelector(sel) as HTMLTextAreaElement | null)?.value.length ?? -1 };
        }, TA);
      } finally {
        await cdp.send("Emulation.setCPUThrottlingRate", { rate: 1 });
        await cdp.detach();
      }
      const sorted = [...got.times].sort((x, y) => x - y);
      const med = sorted.length === 0 ? NaN : sorted.length % 2 === 1 ? sorted[(sorted.length - 1) / 2]! : (sorted[sorted.length / 2 - 1]! + sorted[sorted.length / 2]!) / 2;
      const max = sorted.length === 0 ? NaN : sorted[sorted.length - 1]!;
      const text = `input 中央値 ${med.toFixed(2)}・最大 ${max.toFixed(2)}（ms。100 字・長い会話・CPU 4 倍）・input の処理の中の SA.talk.draw ${got.talks} 回（外 ${got.other} 回）`;
      if (got.times.length !== 100 || got.value !== 100) say(11, "重さ", `測れた input が ${got.times.length} 回・値 ${got.value} 字（100 のはず）`);
      if (!(med <= COMPOSER_INPUT_MED_MS) || !(max <= COMPOSER_INPUT_MAX_MS) || got.talks !== 0) say(11, "重さ", `条件を満たさない: ${text}`);
      else console.log(`[v3-${p}] 段 n の 11 重さ: ${text}`);
      await clear();
    }
    // 次の段に書きかけを残さない
    for (const ch of [talk, long]) await page.evaluate((c: string) => (window as unknown as { SA: { app: { setDraft: (c: string, t: string) => void } } }).SA.app.setDraft(c, ""), ch);
    return lines;
  }

  /** 段 n の 10: 本番の入力欄（字数の出た形）と見本の near の計算済みの値（LEAK_COMPOSER）を比べる。見本を開くので、呼んだ後は path を読み直す */
  async function composerLeaks(page: Page): Promise<string[]> {
    const lines: string[] = [];
    const styles = ({ root, sels, props }: { root: string; sels: Array<{ sel: string; extra: string[] }>; props: string[] }): Record<string, Record<string, string> | null> => {
      const out: Record<string, Record<string, string> | null> = {};
      const scope = document.querySelector(root);
      for (const { sel, extra } of sels) {
        const el = scope === null ? null : scope.querySelector(sel);
        out[sel] = el === null ? null : Object.fromEntries([...props, ...extra].map((prop) => [prop, getComputedStyle(el).getPropertyValue(prop)]));
      }
      return out;
    };
    const real = await page.evaluate(styles, { root: "#ed > [data-composer]", sels: LEAK_COMPOSER, props: LEAK_PROPS });
    const back = page.url();
    await page.goto("about:blank");
    await page.goto(base + "/static/gallery.html", { waitUntil: "load" });
    await page.waitForSelector('[data-section="composer"] [data-demo="near"] .c-composer', { timeout: 5000 });
    const demo = await page.evaluate(styles, { root: '[data-section="composer"] [data-demo="near"]', sels: LEAK_COMPOSER, props: LEAK_PROPS });
    for (const { sel, extra } of LEAK_COMPOSER) {
      const a = real[sel];
      const b = demo[sel];
      if (!a || !b) {
        lines.push(`段 n の 10 漏れ: ${sel} が${!a ? "本番" : "見本"}に無い`);
        continue;
      }
      for (const prop of [...LEAK_PROPS, ...extra]) if (a[prop] !== b[prop]) lines.push(`段 n の 10 漏れ: ${sel} の ${prop} が 本番 ${a[prop]} / 見本 ${b[prop]}`);
    }
    await page.goto("about:blank");
    await page.goto(back, { waitUntil: "load" });
    await page.waitForSelector("#ed > [data-composer] textarea.c-composer-input", { timeout: 8000 });
    await settled(page);
    return lines;
  }

  /**
   * /turns の応答（limit= の最初の読みも after= も）を edit で書き換え始める。ページを開く前に付ける。戻り値は外す関数。
   * 外した後に終わる応答は捨てる（addTurn と同じ）
   */
  async function editTurns(page: Page, id: string, edit: (json: TurnsJson) => void | Promise<void>): Promise<() => Promise<void>> {
    const pattern = `**/api/channels/${id}/turns?*`;
    const handler = async (route: Route): Promise<void> => {
      try {
        const response = await route.fetch();
        const json = (await response.json()) as TurnsJson;
        await edit(json);
        await route.fulfill({ response, json });
      } catch {
        // 何もしない
      }
    };
    await page.route(pattern, handler);
    return () => page.unroute(pattern, handler);
  }

  /** POST の受け口（fixture に無い道・DB に無い作り物の下書き）。受けた道と body を got に積み、before の後に 200 と reply を返す。戻り値は外す関数 */
  async function postSink(page: Page, pattern: string, got: Array<{ path: string; body: unknown }>, before: () => Promise<void>, reply: unknown = {}): Promise<() => Promise<void>> {
    const handler = async (route: Route): Promise<void> => {
      const req = route.request();
      if (req.method() !== "POST") {
        await route.fallback();
        return;
      }
      got.push({ path: new URL(req.url()).pathname, body: req.postDataJSON() as unknown });
      await before();
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(reply) });
    };
    await page.route(pattern, handler);
    return () => page.unroute(pattern, handler);
  }

  /**
   * 段 r（本番のカード。ダークの 3 組）: 許可（0〜4）・置き方の無い話題（1）・空の文（13）・質問（7・5・6・8・9・10）・閉じる前の確認（11）・場所を変える確認（12）・
   * 当たり（14）・重さ（16。スマホ）・見本との漏れ（15。タブレットを除く。見本を開くので最後）。/turns は editTurns で書き換え、POST は受け口で受ける。
   * 足りない物の文（全部を測ってから、1 つでもあれば段を失敗にする）。0 で口に渡っていなければそこで止める
   */
  async function cardsStage(page: Page, vp: Viewport, p: string): Promise<string[]> {
    const lines: string[] = [];
    const say = (n: number, name: string, text: string): void => void lines.push(`段 r の ${n} ${name}: ${text}`);
    const C = "#ed .ed-scroll > [data-cards]";
    const offs: Array<() => Promise<void>> = [];
    /** 見本と比べる本番の計算済みの値（種類 → 要素 → 性質） */
    const real: Record<string, Record<string, Record<string, string> | null>> = {};
    const styles = ({ root, sels, props }: { root: string; sels: string[]; props: string[] }): Record<string, Record<string, string> | null> => {
      const out: Record<string, Record<string, string> | null> = {};
      const scope = document.querySelector(root);
      for (const sel of sels) {
        const el = scope === null ? null : scope.querySelector(sel);
        out[sel] = el === null ? null : Object.fromEntries(props.map((prop) => [prop, getComputedStyle(el).getPropertyValue(prop)]));
      }
      return out;
    };
    const hits = async (name: string): Promise<void> => {
      for (const l of await page.evaluate(hitProblems, { min: 44, scopes: C, targets: "button, input", toast: false })) say(14, "当たり", `${name}: ${l}`);
    };
    /** カードの根の中の物（ボタンは label の文で引く） */
    const look = (): Promise<{
      cards: number;
      kinds: string[];
      height: number;
      buttons: Array<{ label: string; disabled: boolean; title: string | null }>;
      checks: Array<{ text: string; checked: boolean; disabled: boolean }>;
      field: { shown: boolean; value: string; focus: boolean; at: number; mark: boolean } | null;
      notes: Array<{ text: string; busy: boolean }>;
      meta: string | null;
      urgent: string | null;
    }> =>
      page.evaluate((sel: string) => {
        const root = document.querySelector(sel);
        const field = root?.querySelector("textarea.c-card-other") ?? null;
        return {
          cards: root === null ? -1 : root.querySelectorAll(".c-card").length,
          kinds: root === null ? [] : [...root.querySelectorAll(".c-card")].map((c) => c.getAttribute("data-kind") ?? ""),
          height: root === null ? -1 : root.getBoundingClientRect().height,
          buttons: root === null ? [] : [...root.querySelectorAll(".c-card-actions > .c-btn")].map((b) => ({ label: (b.textContent ?? "").trim(), disabled: b.getAttribute("aria-disabled") === "true", title: b.getAttribute("title") })),
          checks: root === null ? [] : [...root.querySelectorAll("label.c-card-check")].map((l) => {
            const input = l.querySelector("input");
            return { text: (l.textContent ?? "").trim(), checked: input instanceof HTMLInputElement && input.checked, disabled: input instanceof HTMLInputElement && input.disabled };
          }),
          field: field instanceof HTMLTextAreaElement
            ? { shown: !field.hidden && field.getClientRects().length > 0, value: field.value, focus: document.activeElement === field, at: field.selectionStart, mark: (field as unknown as { __m?: number }).__m === 1 }
            : null,
          notes: root === null ? [] : [...root.querySelectorAll(".c-note")].map((n) => ({ text: (n.textContent ?? "").trim(), busy: n.hasAttribute("data-busy") })),
          meta: root?.querySelector(".c-card-meta")?.textContent ?? null,
          urgent: root?.querySelector(".c-card-meta")?.getAttribute("data-urgent") ?? null,
        };
      }, C);
    const reloadTurns = async (id: string): Promise<void> => {
      await page.evaluate((ch: string) => (window as unknown as { SA: { store: { load: { turns: (c: string) => Promise<void> } } } }).SA.store.load.turns(ch), id);
      await settled(page);
    };
    /** label の行を押す（スマホ・タブレットは tap、PC は click） */
    const press = async (selector: string): Promise<void> => {
      if (vp === "pc") await page.locator(selector).click();
      else await page.locator(selector).tap();
    };
    const gone = (): Promise<boolean> =>
      page
        .waitForFunction((sel: string) => document.querySelector(sel + " .c-card") === null, C, { timeout: 5000 })
        .then(() => true)
        .catch(() => false);
    const PERM_ROUTE = "**/api/cc/permissions/*/*";

    try {
      // ----- 許可（話題 perm。常に許可のルールを足した形） -----
      const perm1 = { soon: false, gone: false, delay: 0 };
      offs.push(
        await editTurns(page, perm, async (json) => {
          if (perm1.delay > 0) await wait(perm1.delay);
          const ch = json.channel;
          if (ch === null || typeof ch !== "object") return;
          if (perm1.gone) {
            ch.permission = null;
            return;
          }
          const pr = ch.permission as Record<string, unknown> | null | undefined;
          if (pr && typeof pr === "object") {
            pr.alwaysRule = "Bash(npm install:*)";
            pr.alwaysNote = "npm install で始まるコマンド";
            if (perm1.soon) pr.expiresAt = new Date(Date.now() + 50_000).toISOString();
          }
        }),
      );
      // 2 の残り時間は実行中のターンが無くても進むはずなので、許可の間は /api/running を空にする（作り物のデータには実行中の話題が在る）
      const RUNNING = "**/api/running";
      const noRun = async (route: Route): Promise<void> => {
        try {
          const response = await route.fetch();
          await route.fulfill({ response, json: { turns: [] } });
        } catch {
          // 何もしない
        }
      };
      await page.route(RUNNING, noRun);
      offs.push(() => page.unroute(RUNNING, noRun));
      await load(page, `/#/ch/${perm}`);
      await page.waitForSelector(`${C} .c-card[data-kind="permission"]`, { timeout: 5000 }).catch(() => undefined);
      await settled(page);
      // 0. 口に渡ったか（渡っていなければ、ほかを測らずに止める）
      const mouth = await page.evaluate(() => {
        const scroll = document.querySelector("#ed .ed-scroll");
        const kids = scroll === null ? [] : [...scroll.children];
        return {
          order: kids.map((k) => (k.hasAttribute("data-talk") ? "talk" : k.hasAttribute("data-cards") ? "cards" : k.classList.contains("tl") ? "tl" : k.tagName.toLowerCase())).join(","),
          perm: document.querySelectorAll('#ed .ed-scroll > [data-cards] .c-card[data-kind="permission"]').length,
          old: ["#ed .cc-permission", "#ed .cc-question-card", "#ed section.card", "#ed .tl-hint", "#ed .tl-notice"].map((s) => document.querySelectorAll(s).length).reduce((a, b) => a + b, 0),
        };
      });
      if (mouth.order !== "talk,cards,tl" || mouth.perm !== 1 || mouth.old !== 0) throw new Error(`段 r の 0: カードが部品でない（${JSON.stringify(mouth)}）`);

      // 1. 置き方
      const place = await page.evaluate((sel: string) => {
        const scroll = document.querySelector("#ed .ed-scroll");
        const talk = document.querySelector("#ed .c-talk");
        const root = document.querySelector(sel);
        const card = root?.querySelector(".c-card") ?? null;
        const tl = root?.nextElementSibling ?? null;
        if (scroll === null || talk === null || card === null || tl === null) return null;
        const inner = (el: Element): number => el.getBoundingClientRect().left + parseFloat(getComputedStyle(el).paddingLeft);
        const r = card.getBoundingClientRect();
        return {
          tl: tl.getBoundingClientRect().height,
          left: r.left - inner(talk),
          width: r.width,
          top: r.top - talk.getBoundingClientRect().bottom,
          bottom: scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight,
          side: scroll.scrollWidth > scroll.clientWidth,
        };
      }, C);
      if (place === null) say(1, "置き方", "カード・.c-talk・.tl のどれかが無い");
      else {
        if (place.tl !== 0) say(1, "置き方", `.tl の高さ ${place.tl}（0 のはず）`);
        if (Math.abs(place.left) > 0.5) say(1, "置き方", `カードの左端が .c-talk の中身の左端から ${place.left.toFixed(1)} ずれる`);
        if (vp === "phone" ? Math.abs(place.width - 358) > 0.5 : place.width > 520.5) say(1, "置き方", `カードの幅 ${place.width.toFixed(1)}（${vp === "phone" ? "358" : "520 以下"} のはず）`);
        if (Math.abs(place.top) > 0.5) say(1, "置き方", `カードの上端が .c-talk の下端から ${place.top.toFixed(1)} 離れる`);
        if (!(place.bottom < 1)) say(1, "置き方", `開いた直後に一番下でない（残り ${place.bottom.toFixed(1)}）`);
        if (place.side) say(1, "置き方", ".ed-scroll が横に動く");
      }
      lines.push(...(await liveTalkLines(page, vp, "段 r の許可")));
      real.perm = await page.evaluate(styles, { root: C, sels: LEAK_CARDS.perm.sels, props: LEAK_PROPS });

      // 2. 残り時間（1 秒ごとに進み、同じ要素のまま）。期限が 60 秒を切った読みの後は data-urgent
      await page.evaluate((sel: string) => {
        for (const el of [document.querySelector(sel + " .c-card"), document.querySelector(sel + " .c-card-meta")]) if (el !== null) (el as unknown as { __m?: number }).__m = 1;
      }, C);
      const running = await page.evaluate(() => (window as unknown as { SA: { store: { running: unknown[] | null } } }).SA.store.running?.length ?? -1);
      if (running !== 0) say(2, "残り時間", `実行中のターンを空にできない（${running} 件）`);
      const t0 = await look();
      await wait(2200);
      const t1 = await look();
      const same = await page.evaluate((sel: string) => [sel + " .c-card", sel + " .c-card-meta"].every((s) => (document.querySelector(s) as unknown as { __m?: number } | null)?.__m === 1), C);
      if (t0.meta === null || !t0.meta.startsWith("残り ")) say(2, "残り時間", `右の文「${String(t0.meta)}」`);
      if (t0.meta === t1.meta) say(2, "残り時間", `2.2 秒で変わらない（「${String(t1.meta)}」）`);
      if (!same) say(2, "残り時間", "描き直しでカードか右の文が別の要素になった");
      if (t1.urgent !== "false") say(2, "残り時間", `data-urgent が ${String(t1.urgent)}（false のはず）`);
      perm1.soon = true;
      await reloadTurns(perm);
      await settled(page);
      const t2 = await look();
      if (t2.urgent !== "true") say(2, "残り時間", `期限 50 秒の読みの後の data-urgent が ${String(t2.urgent)}（true のはず）`);
      perm1.soon = false;
      await reloadTurns(perm);
      await settled(page);

      // 14. 当たり（許可。ルール付き）
      await hits("許可");
      await edScroll(page, "bottom");

      // 3. 常に許可のチェックが刻みと描き直しで残る
      await page.locator(`${C} .c-card-always label.c-card-check`).click();
      // 実時間: 1 秒の刻みを 1 回またぐ
      await wait(1200);
      await refreshCh(page, perm);
      await settled(page);
      const always = (await look()).checks[0];
      if (!always || !always.checked) say(3, "常に許可", `刻みと描き直しの後にチェックが外れた（${JSON.stringify(always)}）`);

      // 4. 許可を押す: 送っている間と、通った後に読み直すまで待ちの形
      const got: Array<{ path: string; body: unknown }> = [];
      let answeredAt = 0;
      // 止めるのは 600 ms と、待ちの形の絵を撮り終えるまでの長い方（絵が送っている間の形になるように）
      let shotTaken: () => void = () => undefined;
      const shotDone = new Promise<void>((done) => (shotTaken = done));
      const offPost = await postSink(page, PERM_ROUTE, got, async () => {
        await Promise.all([wait(600), shotDone]);
        // 通った後の読みは 500 ms 遅らせ、許可を消す
        perm1.delay = 500;
        perm1.gone = true;
        answeredAt = Date.now();
      });
      offs.push(offPost);
      await page.locator(`${C} .c-card-actions > .c-btn`).first().click();
      // 送っている間の形を見る（POST はわざと止めているので落ち着きは待たない）
      await wait(150);
      const sending = await look();
      const busyButtons = sending.buttons.filter((b) => b.disabled && b.title === "答えを送っています").length;
      if (busyButtons !== 2 || !sending.checks[0]?.disabled) say(4, "許可を押す", `送っている間の形が違う（${JSON.stringify({ buttons: sending.buttons, check: sending.checks[0] })}）`);
      await shot(page, `${p}-b-cards-sending`, false, true);
      shotTaken();
      const until = Date.now() + 3000;
      while (answeredAt === 0 && Date.now() < until) await wait(50);
      if (answeredAt === 0) say(4, "許可を押す", "POST が来ない");
      else {
        await wait(Math.max(0, answeredAt + 200 - Date.now()));
        const after = await look();
        if (after.cards !== 1 || after.buttons.some((b) => !b.disabled)) say(4, "許可を押す", `通った後の読み直しの前に押せる形に戻った（${JSON.stringify(after.buttons)}）`);
      }
      if (got.length !== 1 || !got[0]!.path.endsWith("/always") || JSON.stringify(got[0]!.body) !== JSON.stringify({ requestHash: "h1" })) say(4, "許可を押す", `受けた送り ${JSON.stringify(got)}`);
      if (!(await gone())) say(4, "許可を押す", "許可の無い /turns の後もカードが残る");
      const emptied = await look();
      if (emptied.height !== 0) say(4, "許可を押す", `カードが無くなった根の高さ ${emptied.height}`);
      perm1.delay = 0;

      // 1（続き）. カードの無い話題では根を出さない
      await load(page, `/#/ch/${talk}`);
      await page.waitForSelector('#ed .c-talk .c-msg[data-who="agent"]', { timeout: 5000 });
      const none = await page.evaluate((sel: string) => {
        const root = document.querySelector(sel);
        return root === null ? null : { display: getComputedStyle(root).display, height: root.getBoundingClientRect().height, kids: root.childNodes.length };
      }, C);
      if (none === null || none.display !== "none" || none.height !== 0) say(1, "置き方", `カードの無い話題の根 ${JSON.stringify(none)}（display: none・高さ 0 のはず）`);

      // 13. 空の文
      offs.push(
        await editTurns(page, talk, (json) => {
          json.turns = [];
        }),
      );
      await load(page, `/#/ch/${talk}`);
      await page.waitForSelector(`${C} .c-note`, { timeout: 5000 }).catch(() => undefined);
      const empty = await look();
      const hint = await page.evaluate(() => document.querySelectorAll("#ed .tl-hint").length);
      if (empty.notes.length !== 1 || empty.notes[0]!.text !== "まだ会話はありません。下の欄か Discord で送ると始まります。" || empty.notes[0]!.busy || hint !== 0) say(13, "空の文", JSON.stringify({ notes: empty.notes, hint }));
      real.note = await page.evaluate(styles, { root: C, sels: LEAK_CARDS.note.sels, props: LEAK_PROPS });
      await offs.pop()!();

      // ----- 質問（話題 q。1 つ選ぶ形・選択肢 2 つ） -----
      const q1 = { gone: false };
      offs.push(
        await editTurns(page, q, (json) => {
          if (q1.gone && json.channel !== null && typeof json.channel === "object") json.channel.permission = null;
        }),
      );
      const RADIO = `${C} .c-card-q input.c-card-check-input`;
      const ROW = `${C} .c-card-q label.c-card-check`;
      const openQ = async (): Promise<void> => {
        await load(page, `/#/ch/${q}`);
        await page.waitForSelector(`${C} .c-card[data-kind="question"]`, { timeout: 5000 });
        await settled(page);
      };
      // 7. 矢印キーで「その他」を選んでも欄へは移らない（PC。済んだら読み直して選んだ状態を消す）
      if (vp === "pc") {
        await openQ();
        await page.locator(RADIO).first().focus();
        for (let i = 0; i < 4; i++) {
          if ((await look()).field?.shown) break;
          await page.keyboard.press("ArrowDown");
          await settled(page);
        }
        const keyed = await look();
        const onRadio = await page.evaluate(() => document.activeElement instanceof HTMLInputElement && document.activeElement.type === "radio");
        if (!keyed.field?.shown || keyed.field.focus || !onRadio) say(7, "矢印キー", `欄が見えて焦点はラジオのはず（${JSON.stringify({ field: keyed.field, onRadio })}）`);
      }
      await openQ();
      // 5. 選び方
      const q0 = await look();
      const answer0 = q0.buttons.find((b) => b.label === "答える");
      if (!answer0 || !answer0.disabled || answer0.title !== "すべての問に答えると押せます") say(5, "選び方", `［答える］の初め ${JSON.stringify(answer0)}`);
      await page.locator(ROW).first().click();
      await settled(page);
      const q5 = await look();
      if (q5.buttons.find((b) => b.label === "答える")?.disabled !== false || !q5.checks[0]?.checked) say(5, "選び方", `選択肢を選んだ後 ${JSON.stringify({ buttons: q5.buttons, checks: q5.checks })}`);
      // 6. 指で「その他」の行を押すと欄に焦点（押し始めが起きたかも見る。起きなければ確かめる手が作れない）
      await page.evaluate((sel: string) => {
        const w = window as unknown as { __pd: number };
        w.__pd = 0;
        const rows = document.querySelectorAll(sel);
        rows[rows.length - 1]?.addEventListener("pointerdown", () => void w.__pd++);
      }, ROW);
      await press(`${ROW} >> nth=-1`);
      await settled(page);
      const downs = await page.evaluate(() => (window as unknown as { __pd: number }).__pd);
      if (downs === 0) throw new Error(`段 r の 6: 「その他」の行を ${vp === "pc" ? "click" : "tap"} しても pointerdown が起きない（確かめる手が作れない）`);
      const q6 = await look();
      if (q6.checks[0]?.checked || q6.buttons.find((b) => b.label === "答える")?.disabled !== true || !q6.field?.shown) say(5, "選び方", `「その他」を選んだ後 ${JSON.stringify({ checks: q6.checks, buttons: q6.buttons, field: q6.field })}`);
      if (!q6.field?.focus) say(6, "指で「その他」", `焦点が欄に無い（${JSON.stringify(q6.field)}）`);
      // 8. 打った字が描き直し・刻み・読み直しで残る
      await page.evaluate((sel: string) => {
        const el = document.querySelector(sel + " textarea.c-card-other");
        if (el !== null) (el as unknown as { __m?: number }).__m = 1;
      }, C);
      await page.keyboard.type("abc");
      await refreshCh(page, q);
      await wait(3500);
      const q8 = await look();
      if (!q8.field || q8.field.value !== "abc" || !q8.field.mark || !q8.field.focus || q8.field.at !== 3) say(8, "打った字", JSON.stringify(q8.field));
      if (q8.buttons.find((b) => b.label === "答える")?.disabled !== false) say(8, "打った字", "［答える］が押せない");
      await shot(page, `${p}-b-cards-other`);
      real.question = await page.evaluate(styles, { root: C, sels: LEAK_CARDS.question.sels, props: LEAK_PROPS });
      // 14. 当たり（質問。「その他」を選んだ形）
      await hits("質問");
      await page.locator(`${C} textarea.c-card-other`).focus();
      await page.evaluate((sel: string) => {
        const el = document.querySelector(sel + " textarea.c-card-other");
        if (el instanceof HTMLTextAreaElement) el.setSelectionRange(el.value.length, el.value.length);
      }, C);
      // 9. 変換の途中が切れない
      const ime = await page.context().newCDPSession(page);
      try {
        await page.evaluate((sel: string) => {
          const w = window as unknown as { __ime: { start: number; end: number; blur: number } };
          w.__ime = { start: 0, end: 0, blur: 0 };
          const el = document.querySelector(sel + " textarea.c-card-other");
          el?.addEventListener("compositionstart", () => void w.__ime.start++);
          el?.addEventListener("compositionend", () => void w.__ime.end++);
          el?.addEventListener("blur", () => void w.__ime.blur++);
        }, C);
        await ime.send("Input.imeSetComposition", { text: "へんかん", selectionStart: 4, selectionEnd: 4 });
        await settled(page);
        const started = await page.evaluate(() => (window as unknown as { __ime: { start: number } }).__ime.start);
        if (started === 0) throw new Error("段 r の 9: 変換の途中を作れない（compositionstart が来ない）");
        await refreshCh(page, q);
        // 実時間: 描き直しの後に 1 秒の刻みを 1 回またぐ
        await wait(1200);
        const mid = await look();
        const imeMid = await page.evaluate(() => (window as unknown as { __ime: { end: number; blur: number } }).__ime);
        if (!mid.field || !mid.field.value.includes("へんかん") || !mid.field.mark || !mid.field.focus || imeMid.end !== 0 || imeMid.blur !== 0) say(9, "変換の途中", JSON.stringify({ field: mid.field, ime: imeMid }));
        await ime.send("Input.insertText", { text: "変換" });
        await settled(page);
        const doneIme = await look();
        if (doneIme.field?.value !== "abc変換") say(9, "変換の途中", `確定の後の値 ${JSON.stringify(doneIme.field?.value)}（abc変換 のはず）`);
      } finally {
        await ime.detach();
      }
      // 10. 答える（/answer）と、読み直してやめる（/deny）
      const qGot: Array<{ path: string; body: unknown }> = [];
      offs.push(
        await postSink(page, PERM_ROUTE, qGot, async () => {
          q1.gone = true;
        }),
      );
      await page.locator(`${C} .c-card-actions > .c-btn`).first().click();
      if (!(await gone())) say(10, "答える", "許可の無い /turns の後もカードが残る");
      const a = qGot[0];
      if (!a || !a.path.endsWith("/answer") || JSON.stringify(a.body) !== JSON.stringify({ requestHash: "h2", answers: [{ other: "abc変換" }] })) say(10, "答える", `受けた送り ${JSON.stringify(qGot)}`);
      q1.gone = false;
      await openQ();
      await page.locator(ROW).first().click();
      await settled(page);
      await page.locator(`${C} .c-card-actions > .c-btn`).last().click();
      if (!(await gone())) say(10, "答える", "［やめる］の後もカードが残る");
      if (qGot.length !== 2 || !qGot[1]!.path.endsWith("/deny") || JSON.stringify(qGot[1]!.body) !== JSON.stringify({ requestHash: "h2" })) say(10, "答える", `［やめる］の送り ${JSON.stringify(qGot.slice(1))}`);
      q1.gone = false;

      // ----- 閉じる前の確認・場所を変える確認（話題 open） -----
      const op = { mode: "close" as "close" | "done" | "move" | "moved" };
      offs.push(
        await editTurns(page, open, (json) => {
          const ch = json.channel;
          if (ch === null || typeof ch !== "object") return;
          if (op.mode === "close") ch.closeDraft = { summary: "集計の関数の月末の扱いを直した。\nテストを 2 つ足した。", tasks: [{ title: "明細の取り込みを見直す" }, { title: "11 月の合計を確かめる", due: "2026-11-20" }, { title: "README を直す" }] };
          if (op.mode === "done") {
            ch.state = "done";
            ch.closeDraft = null;
          }
          if (op.mode === "move") ch.moveProposal = { id: 77, from: "kakeibo-app", to: "General", expiresAt: new Date(Date.now() + 600_000).toISOString() };
        }),
      );
      // 11. 閉じる前の確認
      await load(page, `/#/ch/${open}`);
      await page.waitForSelector(`${C} .c-card[data-kind="close"]`, { timeout: 5000 }).catch(() => undefined);
      await settled(page);
      const c0 = await look();
      const picked0 = c0.buttons.find((b) => b.label === "選んだものを登録");
      if (c0.cards !== 1 || c0.kinds[0] !== "close") say(11, "閉じる前の確認", `カード ${JSON.stringify(c0.kinds)}`);
      if (JSON.stringify(c0.checks.map((c) => c.text)) !== JSON.stringify(["1. 明細の取り込みを見直す", "2. 11 月の合計を確かめる（期限 2026-11-20）", "3. README を直す"])) say(11, "閉じる前の確認", `候補の行 ${JSON.stringify(c0.checks.map((c) => c.text))}`);
      if (!picked0 || !picked0.disabled || picked0.title !== "候補を選ぶと押せます") say(11, "閉じる前の確認", `［選んだものを登録］の初め ${JSON.stringify(picked0)}`);
      real.close = await page.evaluate(styles, { root: C, sels: LEAK_CARDS.close.sels, props: LEAK_PROPS });
      // 14. 当たり（閉じる。候補 3）
      await hits("閉じる");
      await edScroll(page, "bottom");
      await page.locator(`${C} label.c-card-check >> nth=2`).click();
      await page.locator(`${C} label.c-card-check >> nth=0`).click();
      await settled(page);
      await shot(page, `${p}-b-cards-close`);
      const cGot: Array<{ path: string; body: unknown }> = [];
      offs.push(
        await postSink(
          page,
          `**/api/sessions/${open}/close/confirm`,
          cGot,
          async () => {
            op.mode = "done";
          },
          { registered: 2 },
        ),
      );
      await page.locator(`${C} .c-card-actions > .c-btn`, { hasText: "選んだものを登録" }).click();
      if (!(await gone())) say(11, "閉じる前の確認", "閉じた /turns の後もカードが残る");
      if (cGot.length !== 1 || JSON.stringify(cGot[0]!.body) !== JSON.stringify({ selected: [0, 2] })) say(11, "閉じる前の確認", `受けた送り ${JSON.stringify(cGot)}`);
      await page.waitForFunction((sel: string) => document.querySelectorAll(sel + " .c-note").length === 1, C, { timeout: 5000 }).catch(() => undefined);
      const c1 = await look();
      if (c1.notes.length !== 1 || c1.notes[0]!.text !== "完了したセッションです。発言すると進行中に戻ります。") say(11, "閉じる前の確認", `閉じた後の文 ${JSON.stringify(c1.notes)}`);
      // 12. 場所を変える確認
      op.mode = "move";
      await load(page, `/#/ch/${open}`);
      await page.waitForSelector(`${C} .c-card[data-kind="move"]`, { timeout: 5000 }).catch(() => undefined);
      await settled(page);
      const m0 = await page.evaluate((sel: string) => [...document.querySelectorAll(sel + " .c-card dd")].map((d) => (d.textContent ?? "").trim()), C);
      const mk = await look();
      if (mk.cards !== 1 || mk.kinds[0] !== "move" || JSON.stringify(m0) !== JSON.stringify(["kakeibo-app", "General"])) say(12, "場所を変える確認", JSON.stringify({ kinds: mk.kinds, dd: m0 }));
      real.move = await page.evaluate(styles, { root: C, sels: LEAK_CARDS.move.sels, props: LEAK_PROPS });
      await edScroll(page, "bottom");
      await shot(page, `${p}-b-cards-move`);
      const mGot: Array<{ path: string; body: unknown }> = [];
      offs.push(
        await postSink(page, "**/api/topics/moves/*/*", mGot, async () => {
          op.mode = "moved";
        }),
      );
      await page.locator(`${C} .c-card-actions > .c-btn`, { hasText: "このまま" }).click();
      if (!(await gone())) say(12, "場所を変える確認", "確認の無い /turns の後もカードが残る");
      if (mGot.length !== 1 || mGot[0]!.path !== "/api/topics/moves/77/keep") say(12, "場所を変える確認", `受けた送り ${JSON.stringify(mGot)}`);

      // 16. 重さ（ダークのスマホ・CPU 4 倍）: 「その他」に 1 字ずつ 50 字と 1 秒の刻み 3 回の間の SA.cards.draw。その間の SA.talk.draw は 0 回
      if (vp === "phone") {
        await openQ();
        await press(`${ROW} >> nth=-1`);
        await settled(page);
        await page.locator(`${C} textarea.c-card-other`).focus();
        await page.evaluate(() => {
          const sa = (window as unknown as { SA: { cards: { draw: (...a: unknown[]) => unknown }; talk: { draw: (...a: unknown[]) => unknown } } }).SA;
          const w = window as unknown as { __w: { times: number[]; talks: number } };
          w.__w = { times: [], talks: 0 };
          const draw = sa.cards.draw;
          sa.cards.draw = (...a: unknown[]) => {
            const t = performance.now();
            const out = draw(...a);
            w.__w.times.push(performance.now() - t);
            return out;
          };
          const talkDraw = sa.talk.draw;
          sa.talk.draw = (...a: unknown[]) => {
            w.__w.talks++;
            return talkDraw(...a);
          };
        });
        const cdp = await page.context().newCDPSession(page);
        let got16: { times: number[]; talks: number; value: number } | null = null;
        try {
          await cdp.send("Emulation.setCPUThrottlingRate", { rate: 4 });
          for (let i = 0; i < 50; i++) await cdp.send("Input.insertText", { text: String.fromCharCode(0x4e00 + i) });
          await wait(3200);
          got16 = await page.evaluate((sel: string) => {
            const w = window as unknown as { __w: { times: number[]; talks: number } };
            return { times: w.__w.times, talks: w.__w.talks, value: (document.querySelector(sel + " textarea.c-card-other") as HTMLTextAreaElement | null)?.value.length ?? -1 };
          }, C);
        } finally {
          await cdp.send("Emulation.setCPUThrottlingRate", { rate: 1 });
          await cdp.detach();
        }
        const sorted = [...got16.times].sort((x, y) => x - y);
        const med = sorted.length === 0 ? NaN : sorted.length % 2 === 1 ? sorted[(sorted.length - 1) / 2]! : (sorted[sorted.length / 2 - 1]! + sorted[sorted.length / 2]!) / 2;
        const max = sorted.length === 0 ? NaN : sorted[sorted.length - 1]!;
        const text = `SA.cards.draw 中央値 ${med.toFixed(2)}・最大 ${max.toFixed(2)}（ms。${sorted.length} 回。50 字と刻み 3 回・CPU 4 倍）・その間の SA.talk.draw ${got16.talks} 回`;
        if (got16.value !== 50 || sorted.length < 50) say(16, "重さ", `値 ${got16.value} 字・描いた回数 ${sorted.length}（50 字・50 回以上のはず）`);
        if (!(med <= COMPOSER_INPUT_MED_MS) || !(max <= COMPOSER_INPUT_MAX_MS) || got16.talks !== 0) say(16, "重さ", `条件を満たさない: ${text}`);
        else console.log(`[v3-${p}] 段 r の 16 重さ: ${text}`);
      }

      // 15. 見本との漏れ（タブレットを除く。見本を開くので最後）
      if (vp !== "tablet") {
        await page.goto("about:blank");
        await page.goto(base + "/static/gallery.html", { waitUntil: "load" });
        await page.waitForSelector('[data-section="cards"] [data-demo="card-note"] .c-note', { timeout: 5000 });
        for (const [kind, { demo, sels }] of Object.entries(LEAK_CARDS)) {
          const shown = await page.evaluate(styles, { root: `[data-section="cards"] [data-demo="${demo}"]`, sels, props: LEAK_PROPS });
          const mine = real[kind] ?? {};
          for (const sel of sels) {
            const x = mine[sel];
            const y = shown[sel];
            if (!x || !y) {
              say(15, "見本との漏れ", `${kind} の ${sel} が${!x ? "本番" : "見本"}に無い`);
              continue;
            }
            for (const prop of LEAK_PROPS) if (x[prop] !== y[prop]) say(15, "見本との漏れ", `${kind} の ${sel} の ${prop} が 本番 ${x[prop]} / 見本 ${y[prop]}`);
          }
        }
      }
    } finally {
      for (const off of offs.splice(0).reverse()) await off().catch(() => undefined);
      // 選んだ状態と書きかけはこのタブのメモリだけ（読み直せば消える）
      await page.goto("about:blank");
    }
    return lines;
  }

  /**
   * 段 u: 知らせと確認（ui.js の toast・confirm が部品の口 SA.notice・SA.ask へ描く）。話題を 1 つ開いた画面で、ページの中から呼ぶ（データは変えない。文は chat.js に在る物）。
   * 知らせは 4 秒で消えるので、出してから測り終えて撮るまでを NOTICE_BUDGET_MS の内に収め、過ぎたら失敗にする（settled は消えるタイマーを待たない）
   */
  async function noticeStage(page: Page, vp: Viewport, p: string): Promise<string[]> {
    const lines: string[] = [];
    const say = (n: number, name: string, text: string): void => void lines.push(`段 u の ${n} ${name}: ${text}`);
    const NOTICE_BUDGET_MS = 3500;
    const ITEM = "#c-notice-root .c-toast-item";
    await load(page, `/#/ch/${open}`);
    await page.waitForSelector("#ed > [data-composer] textarea", { timeout: 5000 });
    await settled(page);
    /** 出ている知らせを × で全部消し、無くなるのを待つ */
    const clear = async (): Promise<void> => {
      await page.evaluate((sel: string) => {
        for (const b of document.querySelectorAll<HTMLButtonElement>(sel + ' button[aria-label="閉じる"]')) b.click();
      }, ITEM);
      await page.waitForFunction((sel: string) => document.querySelector(sel) === null, ITEM, { timeout: 5000 }).catch(() => undefined);
    };

    // 1. 知らせ: 部品の status の側に 1 つ・同じ文。古い入れ物は空
    const TEXT = "送るのをやめました";
    const shownAt = Date.now();
    await page.evaluate((text: string) => (window as unknown as { SA: { ui: { toast: (t: string) => void } } }).SA.ui.toast(text), TEXT);
    await page.waitForSelector(ITEM, { timeout: 5000 }).catch(() => undefined);
    const first = await page.evaluate(() => ({
      status: [...document.querySelectorAll('#c-notice-root .c-toast-list[role="status"] .c-toast-item')].map((i) => (i.textContent ?? "").trim()),
      alert: document.querySelectorAll('#c-notice-root .c-toast-list[role="alert"] .c-toast-item').length,
      old: document.querySelectorAll("#toast > *, #toast-alert > *").length,
    }));
    if (first.status.length !== 1 || first.status[0] !== TEXT || first.alert !== 0) say(1, "知らせ", `status ${JSON.stringify(first.status)}・alert ${first.alert}`);
    if (first.old !== 0) say(1, "知らせ", `古い #toast・#toast-alert に ${first.old} 個`);
    // 2. 場所: スマホは見出しの下・画面の中・入力欄と重ならない。PC は画面の右下の中
    const place = await page.evaluate((sel: string) => {
      const box = (q: string) => {
        const r = document.querySelector(q)?.getBoundingClientRect();
        return r ? { top: r.top, bottom: r.bottom, left: r.left, right: r.right } : null;
      };
      const wrap = document.querySelector("#c-notice-root .c-toast");
      return {
        item: box(sel),
        top: box("#c-top-root .c-top"),
        composer: box("#ed > [data-composer]"),
        // 右腕が開いていれば、右腕の入力欄の帯も
        hand: document.querySelector("#v3")?.getAttribute("data-hand") === "open" ? box("#v3-hand-ed > [data-composer]") : null,
        handOpen: document.querySelector("#v3")?.getAttribute("data-hand") === "open",
        // 入れ物が画面に留まっているか（c-sheet.css が読めないと文書の末尾に流れる）
        fixed: wrap === null ? null : getComputedStyle(wrap).position,
        w: innerWidth,
        h: innerHeight,
      };
    }, ITEM);
    const it = place.item;
    if (place.fixed !== "fixed") say(2, "場所", `入れ物の position が ${String(place.fixed)}（fixed のはず）`);
    if (it === null) say(2, "場所", "知らせが無い");
    else if (vp === "phone") {
      if (place.top === null || it.top < place.top.bottom - 0.5) say(2, "場所", `上端 ${it.top} が見出しの下端 ${String(place.top?.bottom)} より上`);
      if (it.left < 0 || it.right > place.w || it.bottom > place.h) say(2, "場所", `${JSON.stringify(it)} が画面（${place.w}x${place.h}）の外`);
    } else {
      if (it.left < 0 || it.top < 0 || it.right > place.w || it.bottom > place.h) say(2, "場所", `画面の外 ${JSON.stringify(it)}`);
      if (it.left < place.w / 2 || it.top < place.h / 2) say(2, "場所", `右下に無い ${JSON.stringify(it)}`);
    }
    // どの幅でも、入力欄の帯（［送る］）と縦に重ならない（重なると、知らせが出ている間［送る］を押せない）。右腕が開いていれば右腕の入力欄とも
    if (it !== null) {
      const c = place.composer;
      if (c === null || !(it.bottom <= c.top || it.top >= c.bottom)) say(2, "場所", `入力欄 ${JSON.stringify(c)} と重なる（${JSON.stringify(it)}）`);
      const hc = place.hand;
      if (place.handOpen && (hc === null || !(it.bottom <= hc.top || it.top >= hc.bottom))) say(2, "場所", `右腕の入力欄 ${JSON.stringify(hc)} と重なる（${JSON.stringify(it)}）`);
    }
    await shot(page, `${p}-u-notice`);
    if (Date.now() - shownAt > NOTICE_BUDGET_MS) say(1, "知らせ", `出してから撮るまで ${Date.now() - shownAt} ms（消える前に撮れていない恐れ）`);
    await clear();

    // 3. 止める（スマホだけ）: × にフォーカスが在る間は消えず、外すと 4 秒で消える。時間そのものを見るので決まった時間だけ待つ
    if (vp === "phone") {
      await page.evaluate((text: string) => (window as unknown as { SA: { ui: { toast: (t: string) => void } } }).SA.ui.toast(text), TEXT);
      await page.waitForSelector(ITEM, { timeout: 5000 }).catch(() => undefined);
      await page.focus(ITEM + ' button[aria-label="閉じる"]').catch(() => undefined);
      await wait(4300);
      const held = await page.evaluate((sel: string) => [...document.querySelectorAll(sel)].map((i) => i.getAttribute("data-leaving")), ITEM);
      if (held.length !== 1 || held[0] !== null) say(3, "止める", `フォーカスの間に消えかけた（${JSON.stringify(held)}）`);
      await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
      await wait(4600);
      const left = await page.evaluate((sel: string) => document.querySelectorAll(sel).length, ITEM);
      if (left !== 0) say(3, "止める", `外してから 4.6 秒後も ${left} 個残る`);
      await clear();
    }

    // 4. 失敗: alert の側に [もう一度]・×。自動では消えない
    const ERROR = "このチャンネルには送れません";
    await page.evaluate((text: string) => (window as unknown as { SA: { ui: { toast: (t: string, a: null, o: unknown) => void } } }).SA.ui.toast(text, null, { level: "error", retry: () => undefined }), ERROR);
    await page.waitForFunction(noticeHas, { role: "alert" as const, text: ERROR }, { timeout: 5000 }).catch(() => undefined);
    const failed = await page.evaluate(() => {
      const items = [...document.querySelectorAll('#c-notice-root .c-toast-list[role="alert"] .c-toast-item')];
      return { count: items.length, buttons: items.flatMap((i) => [...i.querySelectorAll("button")].map((b) => b.getAttribute("aria-label") ?? (b.textContent ?? "").trim())) };
    });
    if (failed.count !== 1 || JSON.stringify(failed.buttons) !== JSON.stringify(["もう一度", "閉じる"])) say(4, "失敗", JSON.stringify(failed));
    for (const l of await page.evaluate(hitProblems, { min: HIT_MIN[vp], scopes: "#c-notice-root", targets: "button", toast: true })) say(4, "当たり", l);
    await shot(page, `${p}-u-notice-error`);
    await clear();

    // 5. 確認: 部品の板が 1 つ開き、古い #dlg-confirm は開かない。フォーカスは実行のボタン。Esc で閉じて開く前の要素へ戻る
    await page.evaluate(() => {
      const ta = document.querySelector<HTMLTextAreaElement>("#ed > [data-composer] textarea");
      ta?.focus();
      const title = (document.querySelector("#c-top-root .c-top-title")?.textContent ?? "").trim();
      (window as unknown as { SA: { ui: { confirm: (o: unknown) => void } } }).SA.ui.confirm({
        title: "閉じますか",
        target: title,
        body: "会話を要約してから完了に移します。やることの候補があれば、ここか Discord で選んでから閉じます。",
        ok: "閉じる",
        run: () => undefined,
      });
    });
    await page.waitForSelector("dialog.c-sheet[open]", { timeout: 5000 }).catch(() => undefined);
    const asked = await page.evaluate(() => {
      const open = [...document.querySelectorAll("dialog.c-sheet[open]")];
      const a = document.activeElement;
      return {
        open: open.length,
        old: document.querySelector("#dlg-confirm")?.hasAttribute("open") ?? null,
        focus: a instanceof HTMLElement && open[0]?.contains(a) ? (a.textContent ?? "").trim() : a?.tagName ?? null,
      };
    });
    if (asked.open !== 1 || asked.old !== false) say(5, "確認", `部品の板 ${asked.open}・古い確認の open ${String(asked.old)}`);
    if (asked.focus !== "閉じる") say(5, "確認", `最初のフォーカスが「${String(asked.focus)}」（実行のボタンのはず）`);
    await shot(page, `${p}-u-confirm`);
    await page.keyboard.press("Escape");
    await settled(page);
    const closed = await page.evaluate(() => ({
      open: document.querySelectorAll("dialog[open]").length,
      back: document.activeElement === document.querySelector("#ed > [data-composer] textarea"),
      tag: document.activeElement?.tagName ?? null,
    }));
    if (closed.open !== 0) say(5, "確認", `Esc の後も ${closed.open} 個開いている`);
    if (!closed.back) say(5, "確認", `Esc の後のフォーカスが ${String(closed.tag)}（開く前の入力欄のはず）`);
    return lines;
  }

  /**
   * 流れの列の検査（D1）: 見える列の数が data-deck と c-deck.js の deckFit と合う・列の幅は 420 以下・席の幅は deckFit と同じ・
   * 列と項目と帯で字が横にはみ出ない・番の項目の地は --turn-surface で左の線は --warning・帯のボタンは 4 つ（data-act）。足りない物の文
   */
  async function deckLines(page: Page, vp: Viewport, label: string): Promise<string[]> {
    return page.evaluate(
      ({ label, width }: { label: string; width: number }) => {
        const out: string[] = [];
        const say = (text: string): void => void out.push(`流れの列（${label}・幅 ${width}）: ${text}`);
        const v3 = document.querySelector<HTMLElement>("#v3");
        const deck = document.querySelector<HTMLElement>("#c-deck-root .c-deck");
        if (v3 === null || deck === null) return [`流れの列（${label}）: #v3 か .c-deck が無い`];
        const want = Number(v3.getAttribute("data-deck"));
        const seatOpen = v3.getAttribute("data-view") === "body";
        const box = deck.getBoundingClientRect();
        const cols = [...deck.querySelectorAll<HTMLElement>(":scope > .c-col")];
        if (cols.length !== 3) say(`列が ${cols.length} 本（3 本のはず）`);
        const shown = cols.filter((c) => {
          const r = c.getBoundingClientRect();
          return r.width > 0 && r.left >= box.left - 0.5 && r.right <= box.right + 0.5;
        });
        if (want > 0 && shown.length !== want) say(`見える列が ${shown.length} 本（data-deck ${want}）`);
        if (deck.getAttribute("data-cols") !== String(want)) say(`.c-deck の data-cols が ${deck.getAttribute("data-cols")}（${want} のはず）`);
        for (const c of shown) if (c.getBoundingClientRect().width > 420.5) say(`列 ${c.dataset.col} の幅 ${c.getBoundingClientRect().width.toFixed(1)}（420 以下のはず）`);
        const main = document.querySelector<HTMLElement>("#v3-main");
        const seat = main === null || !seatOpen ? 0 : main.getBoundingClientRect().width;
        const fit = (window as unknown as { SA: { deck: { fit: (w: number, open: boolean) => { cols: number; seat: number } } } }).SA.deck.fit(v3.clientWidth, seatOpen);
        if (fit.cols !== want) say(`deckFit の列 ${fit.cols}・data-deck ${want}`);
        if (Math.abs(seat - fit.seat) > 1) say(`席の幅 ${seat.toFixed(1)}（deckFit では ${fit.seat}）`);
        // はみ出る字（列・項目・帯）
        for (const sel of [".c-deck", ".c-col", ".c-col-head", ".c-item", ".c-item-main", ".c-band", ".c-band-ops"]) {
          for (const el of document.querySelectorAll<HTMLElement>(`:is(#c-deck-root, #c-band-root) ${sel}`)) {
            if (el.getClientRects().length === 0 || el.matches(".c-deck")) continue;
            if (el.scrollWidth > el.clientWidth + 0.5) say(`${sel}「${(el.textContent ?? "").trim().slice(0, 20)}」がはみ出る 幅 ${el.clientWidth} 要る幅 ${el.scrollWidth}`);
          }
        }
        // 番の項目の面と線（変数の値を色に直して比べる）
        const probe = document.createElement("span");
        document.body.append(probe);
        const colorOf = (v: string): string => {
          probe.style.color = `var(${v})`;
          return getComputedStyle(probe).color;
        };
        const turnSurface = colorOf("--turn-surface");
        const warning = colorOf("--warning");
        probe.remove();
        const turns = [...deck.querySelectorAll<HTMLElement>('.c-item[data-turn="true"]')].filter((el) => el.dataset.current !== "true");
        if (turns.length === 0) say("番の項目が無い");
        for (const el of turns) {
          const cs = getComputedStyle(el);
          if (cs.backgroundColor !== turnSurface) say(`番の項目の地 ${cs.backgroundColor}（--turn-surface ${turnSurface} のはず）`);
          if (cs.borderLeftColor !== warning || cs.borderLeftWidth !== "3px") say(`番の項目の左の線 ${cs.borderLeftWidth} ${cs.borderLeftColor}（3px ${warning} のはず）`);
        }
        // 帯のボタン
        const acts = [...document.querySelectorAll("#c-band-root .c-band-ops [data-act]")].map((el) => el.getAttribute("data-act"));
        if (JSON.stringify(acts) !== JSON.stringify(["find", "hand", "start", "more"])) say(`帯のボタンが ${acts.join("・")}（探す・右腕・始める・ほか のはず）`);
        return out;
      },
      { label, width: VIEWPORTS[vp].viewport.width },
    );
  }

  async function newShell(vp: Viewport, theme: Theme, full: boolean): Promise<void> {
    const p = `${vp}-${theme}`;
    if (!newShellNames(vp, theme, full).some(wanted)) return;
    const { ctx, page } = await contextFor(vp, theme, `v3-${p}`);
    try {
      const mono = theme === "dark" && vp !== "pc" ? `${p}-a-list-mono` : null;
      const end = theme === "dark" && vp !== "pc" ? `${p}-a-list-end` : null;
      await step(`${p} a`, [`${p}-a-list`, ...(mono ? [mono] : []), ...(end ? [end] : [])], async () => {
        await load(page, "/");
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
          await settled(page);
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
            await page.goto(base + "/", { waitUntil: "load" });
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
            await settled(page);
          } finally {
            await page.unroute(entry);
          }
          const removed = dropExpected(from, ["c-app.js", "[web] list entry missing", "Failed to load resource"]);
          if (!removed.some((line) => line.includes("[web] list entry missing"))) problems.push("入口: 「[web] list entry missing」が console に出ていない");
          for (const line of problems) logLines.push(`[v3-${p}] ${line}`);
          if (problems.length > 0) throw new Error(`入口の検査で ${problems.length} 件`);
        });
      }
      // 流れの列（D1。640px 以上）: 列の数と幅・はみ出し・番の項目の面と線・帯のボタン。項目から席を開いて、列と席の幅・開いた項目の印
      if (vp !== "phone") {
        await step(`${p} deck`, [`${p}-a-deck`, `${p}-a-deck-seat`], async () => {
          await load(page, "/");
          await page.waitForSelector("#v3[data-deck] #c-deck-root .c-deck .c-col", { timeout: 5000 });
          await settled(page);
          const problems: string[] = [...(await deckLines(page, vp, "列"))];
          await shot(page, `${p}-a-deck`);
          await page.locator('#c-deck-root .c-col[data-col="turn"] .c-item[data-turn="true"] button.c-item-main').first().click();
          await page.waitForSelector('#v3[data-view="body"] #ed textarea', { timeout: 5000 });
          await settled(page);
          problems.push(...(await deckLines(page, vp, "席")));
          const current = await page.evaluate(() => document.querySelectorAll('#c-deck-root .c-item[data-current="true"] > button.c-item-main[aria-current="true"]').length);
          if (current !== 1) problems.push(`流れの列（席）: 開いた項目の印（aria-current）が ${current} 個（1 個のはず）`);
          await shot(page, `${p}-a-deck-seat`);
          for (const line of problems) logLines.push(`[v3-${p}] ${line}`);
          if (problems.length > 0) throw new Error(`流れの列の検査で ${problems.length} 件`);
        });
      }
      await step(`${p} b`, [`${p}-b-chat-top`, `${p}-b-chat-middle`, `${p}-b-chat-bottom`], async () => {
        await load(page, `/#/ch/${open}`);
        await page.waitForSelector("#ed textarea", { timeout: 5000 });
        await settled(page);
        await page.evaluate(() => {
          for (const el of document.querySelectorAll("#ed *")) if (el.scrollHeight > el.clientHeight + 4) el.scrollTop = 0;
        });
        await shot(page, `${p}-b-chat-top`);
        // 本番の見出し（軽い分。ライトはここで見る）と、会話の行（部品が描く）
        const problems = [...(await checkTop(page, vp, "会話")), ...(await liveTalkLines(page, vp, "会話"))];
        for (const line of problems) logLines.push(`[v3-${p}] ${line}`);
        if (problems.length > 0) throw new Error(`見出しと会話の行の検査で ${problems.length} 件`);
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
        // 本番の会話の行の段
        const talks = [`${p}-b-talk-rows`, `${p}-b-talk-steps-open`, `${p}-b-talk-run`, `${p}-b-talk-long`, ...(vp === "phone" ? [`${p}-b-talk-long-open`, `${p}-b-talk-mono375`] : [])];
        await step(`${p} k`, talks, async () => {
          const started = Date.now();
          const problems = await talkStage(page, vp, p);
          console.log(`[v3-${p}] 段 k: ${((Date.now() - started) / 1000).toFixed(1)} 秒`);
          for (const line of problems) logLines.push(`[v3-${p}] ${line}`);
          if (problems.length > 0) throw new Error(`会話の行の段の検査で ${problems.length} 件`);
        });
        // 本番の入力欄の段
        const composers = [`${p}-b-composer-empty`, `${p}-b-composer-6lines`, ...(vp === "phone" ? [`${p}-b-composer-count`] : [])];
        await step(`${p} n`, composers, async () => {
          const started = Date.now();
          const problems = await composerStage(page, vp, p);
          console.log(`[v3-${p}] 段 n: ${((Date.now() - started) / 1000).toFixed(1)} 秒`);
          for (const line of problems) logLines.push(`[v3-${p}] ${line}`);
          if (problems.length > 0) throw new Error(`入力欄の段の検査で ${problems.length} 件`);
        });
        // 本番のカードの段
        const cardShots = ["close", "move", "other", "sending"].map((n) => `${p}-b-cards-${n}`);
        await step(`${p} r`, cardShots, async () => {
          const started = Date.now();
          const problems = await cardsStage(page, vp, p);
          console.log(`[v3-${p}] 段 r: ${((Date.now() - started) / 1000).toFixed(1)} 秒`);
          for (const line of problems) logLines.push(`[v3-${p}] ${line}`);
          if (problems.length > 0) throw new Error(`カードの段の検査で ${problems.length} 件`);
        });
        // 知らせと確認の段（スマホと PC）
        if (vp !== "tablet") {
          await step(`${p} u`, ["notice", "notice-error", "confirm"].map((n) => `${p}-u-${n}`), async () => {
            const problems = await noticeStage(page, vp, p);
            for (const line of problems) logLines.push(`[v3-${p}] ${line}`);
            if (problems.length > 0) throw new Error(`知らせと確認の段の検査で ${problems.length} 件`);
          });
        }
      }
      if (!full) return;
      await step(`${p} b2`, [`${p}-b-chat-permission`, `${p}-b-chat-question`], async () => {
        await load(page, `/#/ch/${perm}`);
        await page.waitForSelector('#ed [data-cards] .c-card[data-kind="permission"]', { timeout: 5000 });
        await settled(page);
        await scrollBottom(page);
        await shot(page, `${p}-b-chat-permission`);
        await load(page, `/#/ch/${q}`);
        await page.waitForSelector('#ed [data-cards] .c-card[data-kind="question"]', { timeout: 5000 });
        await settled(page);
        await scrollBottom(page);
        await shot(page, `${p}-b-chat-question`);
      });
      await step(`${p} d`, [`${p}-d-composer-3lines`], async () => {
        await load(page, `/#/ch/${open}`);
        await settled(page);
        const textarea = page.locator("#ed textarea").first();
        await textarea.click();
        await textarea.fill("README の手順を見直して\n古い写真は消して\nテストも走らせて");
        await shot(page, `${p}-d-composer-3lines`);
      });
      const handName = `${p}-c-hand${vp === "phone" ? "-over" : "-column"}`;
      await step(`${p} c`, vp === "phone" ? [handName] : [handName, `${p}-c-hand-with-chat`], async () => {
        await load(page, "/");
        if (vp === "phone") {
          await page.click('#c-bottom-root [data-act="hand"]');
        } else {
          const expanded = await page.getAttribute("#v3-hand-show", "aria-expanded");
          if (expanded !== "true") await page.click("#v3-hand-show");
        }
        await settled(page);
        await shot(page, handName);
        // 開いた右腕の中は部品（最後に札の［開く］を押す）
        const problems = await handPartsLines(page, vp, vp === "phone");
        for (const line of problems) logLines.push(`[v3-${p}] ${line}`);
        if (problems.length > 0) throw new Error(`右腕の段の検査で ${problems.length} 件`);
        if (vp !== "phone") {
          await load(page, `/#/ch/${open}`);
          await page.waitForSelector('#ed .c-msg[data-who="agent"]', { timeout: 5000 });
          await settled(page);
          await shot(page, `${p}-c-hand-with-chat`);
        }
      });
      await step(`${p} e`, [`${p}-e-start-dialog`], async () => {
        await load(page, "/");
        await page.locator("#c-list-root .c-group-head > .c-iconbtn").first().click();
        await settled(page);
        await shot(page, `${p}-e-start-dialog`);
      });
      await step(`${p} f`, [`${p}-f-settings`, `${p}-f-knowledge-list`, `${p}-f-knowledge-detail`], async () => {
        await load(page, "/#/settings");
        await page.waitForSelector("#ed .ed-section", { timeout: 5000 });
        await settled(page);
        await shot(page, `${p}-f-settings`);
        const problems = await checkTop(page, vp, "設定", { hits: false });
        for (const line of problems) logLines.push(`[v3-${p}] ${line}`);
        if (problems.length > 0) throw new Error(`見出しの検査で ${problems.length} 件`);
        await load(page, "/#/knowledge");
        await page.waitForSelector("#ed .master-item", { timeout: 5000 });
        await settled(page);
        await shot(page, `${p}-f-knowledge-list`);
        await page.locator("#ed").getByText("CSS の container queries").first().click();
        await settled(page);
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
        await page.goto(base + "/static/classic.html", { waitUntil: "load" });
        // スマホでは一覧が引き出しの中で隠れているので、在るまでを待つ
        await page.waitForSelector("#sidebar .sb-row", { state: "attached", timeout: 8000 });
        await settled(page);
        await shot(page, `${label}-list`);
      });
      await step(`${label} chat`, [`${label}-chat`], async () => {
        await page.goto("about:blank");
        await page.goto(base + `/static/classic.html#/ch/${open}`, { waitUntil: "load" });
        await page.waitForSelector("#ed .msg-agent", { timeout: 8000 });
        await settled(page);
        await shot(page, `${label}-chat`);
        // 古い殻に部品（c-*）と見出しの入口は無く、今の見出しが在る
        const old = await page.evaluate(() => ({
          parts: document.querySelectorAll('[class^="c-"], [class*=" c-"]').length,
          toolbar: document.querySelector("#ed .ed-toolbar") !== null,
          top: (window as unknown as { SA?: { top?: unknown } }).SA?.top === undefined,
          talk: (window as unknown as { SA?: { talk?: unknown } }).SA?.talk === undefined,
          cards: (window as unknown as { SA?: { cards?: unknown } }).SA?.cards === undefined,
          roots: document.querySelectorAll("[data-talk]").length,
          cardRoots: document.querySelectorAll("[data-cards]").length,
          msgs: document.querySelectorAll("#ed .msg-agent").length,
        }));
        const problems = [
          ...(old.parts !== 0 ? [`古い殻に c- のクラスの要素が ${old.parts} 個`] : []),
          ...(!old.toolbar ? ["古い殻の #ed に .ed-toolbar が無い"] : []),
          ...(!old.top ? ["古い殻に window.SA.top が在る"] : []),
          ...(!old.talk ? ["古い殻に window.SA.talk が在る"] : []),
          ...(old.roots !== 0 ? [`古い殻に [data-talk] が ${old.roots} 個`] : []),
          ...(!old.cards ? ["古い殻に window.SA.cards が在る"] : []),
          ...(old.cardRoots !== 0 ? [`古い殻に [data-cards] が ${old.cardRoots} 個`] : []),
          ...(old.msgs === 0 ? ["古い殻の #ed に .msg-agent が無い"] : []),
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
      await settled(page);
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
      await settled(page);
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
        await settled(page);
        lines.push(...(await withMono(page, () => page.evaluate(talkProblems, { ...args, label: "幅 375・等幅の字" }), "見本の会話")));
      } finally {
        await page.setViewportSize(VIEWPORTS.phone.viewport);
        await settled(page);
      }
    }
    for (const line of lines) logLines.push(`[${label}] ${line}`);
    if (lines.length > 0) throw new Error(`会話の見本の検査で ${lines.length} 件`);
  }

  /** 見本の入力欄（composerProblems）を測る。足りない物は 1 行ずつ console.log に書き、1 つでもあれば投げて段を失敗にする */
  async function checkComposers(page: Page, vp: Viewport, label: string): Promise<void> {
    const lines = await page.evaluate(composerProblems, { demos: COMPOSER_DEMOS, phone: vp === "phone", label: "今の字" });
    // ［送る］は PC でも欄と同じ 44 の当たり
    lines.push(...(await page.evaluate(hitProblems, { min: 44, scopes: '[data-section="composer"]', targets: "button", toast: false })).map((line) => `入力欄: ${line}`));
    for (const line of lines) logLines.push(`[${label}] ${line}`);
    if (lines.length > 0) throw new Error(`入力欄の見本の検査で ${lines.length} 件`);
  }

  /** 見本のカード（cardProblems）と当たり（PC でも 44）を測る。足りない物は 1 行ずつ console.log に書き、1 つでもあれば投げて段を失敗にする */
  async function checkCards(page: Page, vp: Viewport, label: string): Promise<void> {
    const lines = await page.evaluate(cardProblems, { demos: CARD_DEMOS, pc: vp === "pc", label: "今の字" });
    lines.push(...(await page.evaluate(hitProblems, { min: 44, scopes: '[data-section="cards"]', targets: "button, input, textarea", toast: false })).map((line) => `カード: ${line}`));
    for (const line of lines) logLines.push(`[${label}] ${line}`);
    if (lines.length > 0) throw new Error(`カードの見本の検査で ${lines.length} 件`);
  }

  /** 見本の右腕（360px の箱）: 見出しと札の形、横にはみ出さない事、当たり（PC でも 44）。足りない物は 1 行ずつ console.log に書き、1 つでもあれば投げて段を失敗にする */
  async function checkHands(page: Page, label: string): Promise<void> {
    const lines = await page.evaluate(() => {
      const out: string[] = [];
      const box = document.querySelector('[data-section="hand"] .c-gallery-hand');
      if (box === null) return ["右腕: 見本の箱が無い"];
      const titles = [...box.querySelectorAll(".c-hand-head h2.c-hand-title")].map((el) => el.textContent);
      if (titles.length !== 1 || titles[0] !== "右腕") out.push(`右腕: 見出しの題 ${JSON.stringify(titles)}（「右腕」が 1 つのはず）`);
      const acts = [...box.querySelectorAll(".c-hand-head [data-act]")].map((el) => el.getAttribute("data-act"));
      if (acts.join(",") !== "menu,close") out.push(`右腕: 見出しのボタン ${acts.join(",")}（menu,close のはず）`);
      const refs = box.querySelectorAll(".c-refs .c-ref");
      if (refs.length !== 2) out.push(`右腕: 札が ${refs.length}（2 のはず）`);
      if (box.querySelectorAll(".c-ref .c-ref-meta").length !== 1) out.push("右腕: 札の meta が 1 つでない");
      // 押せる物の数（「…」・［畳む］・［開く］2 つ）。数を見ないと、ボタンが消えても当たりとはみ出しの検査が 0 件で通る
      const opens = box.querySelectorAll(".c-ref > button.c-btn").length;
      const heads = box.querySelectorAll(".c-hand-head [data-act] > button").length;
      if (opens !== 2 || heads !== 2) out.push(`右腕: ボタンが 見出し ${heads}・札 ${opens}（2・2 のはず）`);
      // 読み上げの名前は古い右腕と同じ文（［開く］は「<題> を開く」・［畳む］は「右腕を畳む」）。札そのものは名前を持たない
      for (const ref of refs) {
        const title = (ref.querySelector(".c-ref-title")?.textContent ?? "").trim();
        const name = ref.querySelector(":scope > button.c-btn")?.getAttribute("aria-label");
        if (name !== `${title} を開く`) out.push(`右腕: 札の［開く］の名前が ${JSON.stringify(name)}（「${title} を開く」のはず）`);
        if (ref.hasAttribute("role") || ref.hasAttribute("aria-label")) out.push("右腕: 札に role か aria-label が在る");
      }
      const closeName = box.querySelector('.c-hand-head [data-act="close"] > button')?.getAttribute("aria-label");
      if (closeName !== "右腕を畳む") out.push(`右腕: ［畳む］の名前が ${JSON.stringify(closeName)}（「右腕を畳む」のはず）`);
      const bubbles = box.querySelectorAll(".c-bubble").length;
      if (bubbles !== 2) out.push(`右腕: 吹き出しが ${bubbles}（2 のはず）`);
      if ([...box.querySelectorAll(".c-bubble")].some((el) => (el.textContent ?? "").includes("<#"))) out.push("右腕: 返事の本文に <# が残っている");
      if (box.scrollWidth > box.clientWidth) out.push(`右腕: 箱が横にはみ出している（${box.scrollWidth} > ${box.clientWidth}）`);
      const b = box.getBoundingClientRect();
      for (const el of box.querySelectorAll(".c-hand-head, .c-hand-act, .c-msg, .c-bubble, .c-refs, .c-ref, .c-ref-title, .c-ref .c-btn")) {
        const r = el.getBoundingClientRect();
        if (r.left < b.left - 0.5 || r.right > b.right + 0.5) out.push(`右腕: ${el.className} が箱の外（${r.left.toFixed(1)}〜${r.right.toFixed(1)}、箱 ${b.left.toFixed(1)}〜${b.right.toFixed(1)}）`);
      }
      for (const el of box.querySelectorAll(".c-ref-title, .c-hand-title")) if (el.scrollWidth > el.clientWidth + 1 && getComputedStyle(el).textOverflow !== "ellipsis") out.push(`右腕: ${el.className} が省かれずにはみ出している`);
      return out;
    });
    lines.push(...(await page.evaluate(hitProblems, { min: 44, scopes: '[data-section="hand"]', targets: "button", toast: false })).map((line) => `右腕: ${line}`));
    for (const line of lines) logLines.push(`[${label}] ${line}`);
    if (lines.length > 0) throw new Error(`右腕の見本の検査で ${lines.length} 件`);
  }

  /** 見本の札（termProblems）と当たり（PC でも 44）を測る。足りない物は 1 行ずつ console.log に書き、1 つでもあれば投げて段を失敗にする */
  async function checkTerms(page: Page, vp: Viewport, label: string): Promise<void> {
    const lines = await page.evaluate(termProblems, { demos: TERM_DEMOS, takeable: TERM_TAKEABLE, blocked: TERM_BLOCKED, error: TERM_ERROR, phone: vp === "phone", label: "今の字" });
    lines.push(...(await page.evaluate(hitProblems, { min: 44, scopes: '[data-section="term"]', targets: "button, a[href]", toast: false })).map((line) => `札: ${line}`));
    for (const line of lines) logLines.push(`[${label}] ${line}`);
    if (lines.length > 0) throw new Error(`札の見本の検査で ${lines.length} 件`);
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
        { name: galleryName(vp, theme, "g-composer"), selector: '[data-section="composer"]' },
        { name: galleryName(vp, theme, "g-cards"), selector: '[data-section="cards"]' },
        { name: galleryName(vp, theme, "g-hand"), selector: '[data-section="hand"]' },
        { name: galleryName(vp, theme, "g-term"), selector: '[data-section="term"]' },
        { name: galleryName(vp, theme, "g-deck"), selector: '[data-section="deck"]' },
      ];
      await step(full, [full, ...parts.map((part) => part.name)], async () => {
        await loadGallery();
        await checkGallery(page, vp, label);
        await checkTalks(page, vp, label);
        await checkComposers(page, vp, label);
        await checkCards(page, vp, label);
        await checkHands(page, label);
        await checkTerms(page, vp, label);
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
          await settled(page);
          await checkGallery(page, vp, label);
          await shot(page, name);
        });
      }
    } finally {
      await ctx.close();
    }
  }

  /**
   * 段 cc（Claude Code のチャンネル。2 つ目のサーバー（cc: true）で、ダークの 3 組）: 届け待ち（0〜4）・許可（5〜8）・終わった（9）・［端末］⇄［会話］（10）・記録（11）。
   * 足りない物の文（全部を測ってから、1 つでもあれば段を失敗にする）。0 で口に渡っていなければそこで止める
   */
  async function ccStage(page: Page, vp: Viewport, p: string): Promise<string[]> {
    const cc = fixture.cc;
    if (cc === undefined) throw new Error("段 cc: Claude Code の作り物が無い（cc: true で立てたサーバーでない）");
    const lines: string[] = [];
    const say = (n: number, name: string, text: string): void => void lines.push(`段 cc の ${n} ${name}: ${text}`);
    const C = "#ed .ed-scroll > [data-cards]";
    const K = "#ed > [data-composer]";
    const CANCEL = `${C} .c-status .c-btn`;
    const offs: Array<() => Promise<void>> = [];
    cc.reset();
    const from = logLines.length;
    /** 焦点の要素の短い書き方（記録に出す） */
    const focusOf = (): Promise<string> =>
      page.evaluate(() => {
        const el = document.activeElement;
        if (el === null) return "null";
        const cls = el.getAttribute("class");
        return el.tagName.toLowerCase() + (cls ? "." + cls.split(/\s+/).join(".") : "");
      });
    /** 「…」の板から label の行を押す */
    const menuRow = async (label: string): Promise<boolean> => {
      await page.click(TOP_MENU);
      await page.waitForSelector("#v3-sheet[open]", { timeout: 5000 });
      const rows = await sheetRows(page);
      if (!rows.includes(label)) {
        await escSheet(page);
        return false;
      }
      await page.locator("#v3-sheet .more-row").filter({ hasText: label }).first().click();
      await settled(page);
      return true;
    };
    /** 画面の節（.tl の中）と、その .tl の前がカードの根か */
    const screenOf = (id: string): Promise<{ inTl: boolean; afterCards: boolean } | null> =>
      page.evaluate((sid: string) => {
        const sec = document.getElementById(sid);
        if (sec === null) return null;
        const tl = sec.parentElement;
        return { inTl: tl !== null && tl.classList.contains("tl"), afterCards: tl !== null && tl.previousElementSibling !== null && tl.previousElementSibling.hasAttribute("data-cards") };
      }, `cc-screen-${id}`);
    let endedSession: string | null = null;

    try {
      // ----- 届け待ち（セッションは作業中） -----
      await load(page, `/#/ch/${cc.queue}`);
      await page.waitForSelector(`${C} .c-status`, { timeout: 5000 }).catch(() => undefined);
      await settled(page);
      // 0. 口に渡ったか（渡っていなければ、ほかを測らずに止める）
      const mouth = await page.evaluate(({ c, k }: { c: string; k: string }) => {
        const root = document.querySelector(c);
        const rows = root === null ? [] : [...root.querySelectorAll(".c-status")];
        const sent = document.querySelector(k + " .c-composer-sent");
        return {
          cards: root !== null,
          rows: rows.length,
          text: rows[0]?.querySelector("p")?.textContent?.trim() ?? null,
          cancels: rows[0] === undefined ? 0 : rows[0].querySelectorAll(".c-btn").length,
          old: ["#ed .tl .cc-status", "#ed .tl section.card", "#ed .tl .tl-hint", "#ed .tl .tl-notice", "#ed .cc-send-state"].map((s) => document.querySelectorAll(s).length).reduce((a, b) => a + b, 0),
          sent: sent === null ? null : { kids: sent.children.length, text: sent.textContent ?? "" },
        };
      }, { c: C, k: K });
      if (!mouth.cards || mouth.rows !== 1 || mouth.text !== "作業中です。終わったら届けます" || mouth.cancels !== 1 || mouth.old !== 0 || mouth.sent === null || mouth.sent.kids !== 0 || mouth.sent.text !== "") {
        throw new Error(`段 cc の 0: 状態の行が部品でない（${JSON.stringify(mouth)}）`);
      }
      await shot(page, `${p}-b-cc-status`);

      // 1. 当たり（カードの根と入力欄の中の button。PC も 44）
      for (const l of await page.evaluate(hitProblems, { min: 44, scopes: `${C}, ${K}`, targets: "button", toast: false })) say(1, "当たり", `届け待ち: ${l}`);
      await edScroll(page, "bottom");

      // 2. 状態の行の p と textarea に印を付け、下書きを打つ
      await page.evaluate(({ c, k }: { c: string; k: string }) => {
        for (const el of [document.querySelector(c + " .c-status p"), document.querySelector(k + " textarea")]) if (el !== null) (el as unknown as { __m?: number }).__m = 1;
      }, { c: C, k: K });
      const DRAFT = "下書きの続き";
      await page.locator(`${K} textarea`).fill(DRAFT);
      const h0 = await page.evaluate((c: string) => document.querySelector(c + " .c-status")?.getBoundingClientRect().height ?? -1, C);

      // 3. ［やめる］を 2 回押す（POST は 600 ms 遅らせる）: 待つ間は待ちの形で、POST は 1 回
      const ROUTE = "**/api/cc/sends/*/cancel";
      let cancels = 0;
      const slow = async (route: Route): Promise<void> => {
        if (route.request().method() === "POST") {
          cancels++;
          await wait(600);
        }
        await route.continue().catch(() => undefined);
      };
      await page.route(ROUTE, slow);
      offs.push(() => page.unroute(ROUTE, slow));
      await page.locator(CANCEL).click();
      // POST はわざと遅らせている（その間に 2 回目を押す）ので落ち着きは待たない
      await wait(100);
      await page.evaluate((sel: string) => (document.querySelector(sel) as HTMLElement | null)?.click(), CANCEL);
      await wait(100);
      const during = await page.evaluate((sel: string) => {
        const b = document.querySelector(sel);
        return b === null ? null : { disabled: b.getAttribute("aria-disabled"), busy: b.getAttribute("aria-busy") };
      }, CANCEL);
      if (during === null || during.disabled !== "true" || during.busy !== "true") say(3, "やめる", `待つ間の形 ${JSON.stringify(during)}（aria-disabled・aria-busy が true のはず）`);

      // 4. 通った後: 知らせ・同じ p で「作業中…」・［やめる］が無い・帯に「送るのをやめました」・下書きが残る・行の高さが同じ
      const done = await page
        .waitForFunction((sel: string) => document.querySelector(sel) === null, CANCEL, { timeout: 5000 })
        .then(() => true)
        .catch(() => false);
      if (!done) say(4, "やめた後", "5 秒たっても［やめる］が消えない");
      await page.waitForFunction(noticeHas, { role: "status" as const, text: "送るのをやめました" }, { timeout: 5000 }).catch(() => undefined);
      await page.waitForFunction((k: string) => (document.querySelector(k + " .c-composer-sent-text")?.textContent ?? "") !== "", K, { timeout: 5000 }).catch(() => undefined);
      await settled(page);
      console.log(`[v3-${p}] 段 cc: 状態の行の［やめる］が消えた後の焦点 ${await focusOf()}`);
      const after = await page.evaluate(({ c, k }: { c: string; k: string }) => {
        const pEl = document.querySelector(c + " .c-status p");
        const ta = document.querySelector(k + " textarea");
        return {
          text: pEl?.textContent?.trim() ?? null,
          sameP: (pEl as unknown as { __m?: number } | null)?.__m === 1,
          cancels: document.querySelectorAll(c + " .c-btn").length,
          sent: (document.querySelector(k + " .c-composer-sent-text")?.textContent ?? "").trim(),
          sameTa: (ta as unknown as { __m?: number } | null)?.__m === 1,
          draft: ta instanceof HTMLTextAreaElement ? ta.value : null,
          height: document.querySelector(c + " .c-status")?.getBoundingClientRect().height ?? -1,
          bar: document.querySelectorAll("#ed .cc-send-state").length,
        };
      }, { c: C, k: K });
      const afterToast = await page.evaluate(noticeText, "status" as const);
      if (!afterToast.includes("送るのをやめました")) say(4, "やめた後", `知らせ「${afterToast}」`);
      if (after.text !== "作業中…" || !after.sameP) say(4, "やめた後", `状態の行「${String(after.text)}」・同じ p ${after.sameP}`);
      if (after.cancels !== 0) say(4, "やめた後", `［やめる］が ${after.cancels} 個残る`);
      if (!after.sent.startsWith("本文 #") || !after.sent.endsWith("送るのをやめました")) say(4, "やめた後", `帯の文「${after.sent}」`);
      if (!after.sameTa || after.draft !== DRAFT) say(4, "やめた後", `入力欄が作り直された・下書きが消えた（同じ要素 ${after.sameTa}・${JSON.stringify(after.draft)}）`);
      if (Math.abs(after.height - h0) > 0.5) say(4, "やめた後", `状態の行の高さ ${h0} → ${after.height}`);
      if (after.bar !== 0) say(4, "やめた後", `古い帯が ${after.bar} 個`);
      if (cancels !== 1) say(3, "やめる", `POST が ${cancels} 回（1 回のはず）`);
      await shot(page, `${p}-b-cc-sent`);
      await offs.pop()!();
      await page.locator(`${K} textarea`).fill("");

      // ----- 許可（セッションは判断待ち） -----
      await load(page, `/#/ch/${cc.ask}`);
      await page.waitForSelector(`${C} .c-card[data-kind="permission"]`, { timeout: 5000 }).catch(() => undefined);
      await settled(page);
      // 5. 許可のカードは部品で、見出しは話題と同じ
      const card = await page.evaluate((c: string) => ({
        cards: document.querySelectorAll(c + ' .c-card[data-kind="permission"]').length,
        title: (document.querySelector(c + " .c-card-title")?.textContent ?? "").trim(),
        old: ["#ed .tl section.card", "#ed .tl .cc-status", "#ed .cc-permission"].map((s) => document.querySelectorAll(s).length).reduce((a, b) => a + b, 0),
      }), C);
      if (card.cards !== 1 || card.title !== "あなたの番: 許可" || card.old !== 0) say(5, "許可", JSON.stringify(card));
      await edScroll(page, "bottom");
      await shot(page, `${p}-b-cc-permission`);
      for (const l of await page.evaluate(hitProblems, { min: 44, scopes: `${C}, ${K}`, targets: "button, input", toast: false })) say(1, "当たり", `許可: ${l}`);

      // 6. 残り時間が 1 秒ごとに進む
      const meta = (): Promise<string | null> => page.evaluate((c: string) => document.querySelector(c + " .c-card-meta")?.textContent ?? null, C);
      const m0 = await meta();
      await wait(2200);
      const m1 = await meta();
      if (m0 === null || !m0.startsWith("残り ") || m0 === m1) say(6, "残り時間", `「${String(m0)}」→「${String(m1)}」`);

      // 7. ［許可］を押す（本物の POST を 300 ms 遅らせる）: 待ちの形 → 5 秒以内にカードが消える。POST は 1 回
      const PERM = "**/api/cc/permissions/*/*";
      let answers = 0;
      const hold = async (route: Route): Promise<void> => {
        if (route.request().method() === "POST") {
          answers++;
          await wait(300);
        }
        await route.continue().catch(() => undefined);
      };
      await page.route(PERM, hold);
      offs.push(() => page.unroute(PERM, hold));
      await edScroll(page, "bottom");
      await page.locator(`${C} .c-card-actions > .c-btn`).filter({ hasText: /^許可$/ }).click();
      // POST はわざと遅らせている（送っている間の形を見る）ので落ち着きは待たない
      await wait(100);
      const waiting = await page.evaluate((c: string) => [...document.querySelectorAll(c + " .c-card-actions > .c-btn")].map((b) => b.getAttribute("aria-disabled")), C);
      if (waiting.length === 0 || waiting.some((d) => d !== "true")) say(7, "許可を押す", `送っている間の形 ${JSON.stringify(waiting)}`);
      const goneAt = Date.now();
      const gone = await page
        .waitForFunction((c: string) => document.querySelector(c + " .c-card") === null, C, { timeout: 5000 })
        .then(() => true)
        .catch(() => false);
      if (!gone) say(7, "許可を押す", "5 秒たってもカードが消えない");
      else console.log(`[v3-${p}] 段 cc: 許可を押してからカードが消えるまで ${Date.now() - goneAt} ms・その後の焦点 ${await focusOf()}`);
      await page.waitForFunction(noticeHas, { role: "status" as const, text: "許可しました" }, { timeout: 5000 }).catch(() => undefined);
      const toast = await page.evaluate(noticeText, "status" as const);
      if (!toast.includes("許可しました")) say(7, "許可を押す", `知らせ「${toast}」`);
      if (answers !== 1) say(7, "許可を押す", `POST が ${answers} 回（1 回のはず）`);
      await offs.pop()!();

      // 8. 「…」の板から画面を開く: .tl（カードの根の次）に節。もう一度で閉じる
      if (!(await menuRow("画面を見る"))) say(8, "画面", "「…」の板に「画面を見る」が無い");
      else {
        await page.waitForSelector(`#cc-screen-${cc.ask}`, { timeout: 5000 }).catch(() => undefined);
        const sc = await screenOf(cc.ask);
        if (sc === null || !sc.inTl || !sc.afterCards) say(8, "画面", `節の場所 ${JSON.stringify(sc)}（.tl の中・カードの根の次のはず）`);
        if (!(await menuRow("画面を閉じる"))) say(8, "画面", "「…」の板に「画面を閉じる」が無い");
        else if ((await screenOf(cc.ask)) !== null) say(8, "画面", "閉じても節が残る");
      }

      // 10. 見出しの［端末］へ切り替えて［会話］へ戻る（切り替えが出る幅だけ）: カードの根がもう一度在り、古いカードが .tl に無い
      const views = await page.evaluate(() => document.querySelector("#c-top-root .c-top-views") !== null);
      console.log(`[v3-${p}] 段 cc の 10: 見出しの切り替えが${views ? "在る" : "無い（確かめない）"}`);
      if (views) {
        await page.locator('#c-top-root .c-seg-item[data-value="pane"]').click();
        await settled(page);
        await page.locator('#c-top-root .c-seg-item[data-value="talk"]').click();
        await page.waitForSelector(C, { state: "attached", timeout: 5000 }).catch(() => undefined);
        await settled(page);
        const back = await page.evaluate((c: string) => ({
          cards: document.querySelectorAll(c).length,
          old: ["#ed .tl section.card", "#ed .tl .cc-status", "#ed .cc-permission"].map((s) => document.querySelectorAll(s).length).reduce((a, b) => a + b, 0),
        }), C);
        if (back.cards !== 1 || back.old !== 0) say(10, "端末と会話", JSON.stringify(back));
      }

      // ----- 終わった（一覧に居ないセッション）。開くのは群の「完了」を開いた行から（一覧に在る話題にだけ「…」が出る） -----
      await load(page, "/");
      await page.locator('#c-list-root section.c-group[aria-label="blog-site"] .c-fold-head').first().click();
      await page.waitForSelector(`#c-list-root button[data-topic="ch:${cc.ended}"]`, { timeout: 5000 });
      await page.locator(`#c-list-root button[data-topic="ch:${cc.ended}"]`).last().click();
      await page.waitForSelector(`${C} .c-note`, { timeout: 5000 }).catch(() => undefined);
      await settled(page);
      endedSession = await page.evaluate((id: string) => {
        const ch = (window as unknown as { SA: { chat: { channelById: (c: string) => { cc?: { sessionId?: unknown } } | null } } }).SA.chat.channelById(id);
        return ch && ch.cc && typeof ch.cc.sessionId === "string" ? ch.cc.sessionId : null;
      }, cc.ended);
      // 9. 終わった文は部品の文で、状態の行は無い。入力欄は今と同じ形
      const end = await page.evaluate(({ c, k }: { c: string; k: string }) => ({
        notes: [...document.querySelectorAll(c + " .c-note")].map((n) => (n.textContent ?? "").trim()),
        status: document.querySelectorAll(c + " .c-status").length,
        old: ["#ed .tl .tl-hint", "#ed .tl .cc-status", "#ed .cc-send-state"].map((s) => document.querySelectorAll(s).length).reduce((a, b) => a + b, 0),
        textarea: document.querySelectorAll(k + " textarea").length,
      }), { c: C, k: K });
      const ENDED = "このセッションは終わっています。Discord のチャンネルに書くと、同じディレクトリで起動して続けられます。";
      if (end.notes.length !== 1 || end.notes[0] !== ENDED || end.status !== 0 || end.old !== 0 || end.textarea !== 1) say(9, "終わった", JSON.stringify(end));
      await edScroll(page, "bottom");
      await shot(page, `${p}-b-cc-ended`);
      if (!(await menuRow("画面を見る"))) say(9, "終わった", "「…」の板に「画面を見る」が無い");
      else {
        await page.waitForSelector(`#cc-screen-${cc.ended}`, { timeout: 5000 }).catch(() => undefined);
        const order = await page.evaluate(({ c, id }: { c: string; id: string }) => {
          const note = document.querySelector(c + " .c-note");
          const sec = document.getElementById(id);
          return note === null || sec === null ? null : { note: note.getBoundingClientRect().top, screen: sec.getBoundingClientRect().top, text: (sec.textContent ?? "").trim() };
        }, { c: C, id: `cc-screen-${cc.ended}` });
        if (order === null || !(order.note < order.screen)) say(9, "終わった", `終わった文が画面の節より上に無い（${JSON.stringify(order)}）`);
        await edScroll(page, "bottom");
        await shot(page, `${p}-b-cc-ended-screen`);
        await menuRow("画面を閉じる");
      }

      // ----- 端末のセッションの札（チャンネルの無い待機のセッション。一覧の cc: の行） -----
      // 12. 行を押すと札（取り込める形）。列 2 に画面の写しが無く、画面の写しの API（/takeover の付かない /api/cc/sessions/<id>）を読まない
      await load(page, "/");
      const TERM = '#ed .ed-scroll > [data-term] .c-term[data-kind="ready"]';
      const screenReads: string[] = [];
      const onRequest = (req: { url: () => string }): void => {
        const path = new URL(req.url()).pathname;
        if (path === `/api/cc/sessions/${cc.term}`) screenReads.push(path);
      };
      page.on("request", onRequest);
      offs.push(async () => void page.off("request", onRequest));
      await page.locator(`#c-list-root button[data-topic="cc:${cc.term}"]`).first().click();
      const ready = await page
        .waitForSelector(TERM, { timeout: 5000 })
        .then(() => true)
        .catch(() => false);
      await settled(page);
      if (!ready) say(12, "札", "5 秒たっても取り込める形の札が出ない");
      const termState = await page.evaluate(() => ({
        screens: document.querySelectorAll("#ed .cc-screen").length,
        tab: (window as unknown as { SA: { app: { activeTabId: () => string | null } } }).SA.app.activeTabId(),
        hash: location.hash,
      }));
      if (termState.screens !== 0) say(12, "札", `列 2 に画面の写しが ${termState.screens} 個`);
      if (termState.tab !== `term:${cc.term}` || termState.hash !== `#/cc/${cc.term}`) say(12, "札", `タブ ${String(termState.tab)}・hash ${termState.hash}`);
      const readsAtCard = screenReads.length;
      if (readsAtCard !== 0) say(12, "札", `画面の写しの API を ${readsAtCard} 回読んだ`);
      await shot(page, `${p}-b-cc-term`);

      // 13. ［取り込む］で確認（本文はサーバーの文・最初の焦点は［やめる］）。［やめる］で閉じて札に戻る
      if (ready) {
        await page.locator(`${TERM} .c-term-actions .c-btn`).filter({ hasText: /^取り込む$/ }).click();
        const asked = await page
          .waitForSelector("dialog.c-sheet[open] .c-confirm-body", { timeout: 5000 })
          .then(() => true)
          .catch(() => false);
        await settled(page);
        const confirm = await page.evaluate(() => {
          const open = document.querySelector("dialog.c-sheet[open]");
          const a = document.activeElement;
          return {
            body: (open?.querySelector(".c-confirm-body")?.textContent ?? "").trim(),
            focus: a instanceof HTMLElement && open !== null && open.contains(a) ? (a.textContent ?? "").trim() : (a?.tagName ?? null),
          };
        });
        if (!asked || !confirm.body.includes("を取り込みます。")) say(13, "確認", `本文「${confirm.body}」`);
        if (confirm.focus !== "やめる") say(13, "確認", `最初の焦点が「${String(confirm.focus)}」（［やめる］のはず）`);
        await shot(page, `${p}-b-cc-term-confirm`);
        await page.locator("dialog.c-sheet[open] .c-btn").filter({ hasText: /^やめる$/ }).click();
        const back = await page
          .waitForFunction((sel: string) => document.querySelector("dialog.c-sheet[open]") === null && document.querySelector(sel) !== null, TERM, { timeout: 5000 })
          .then(() => true)
          .catch(() => false);
        await settled(page);
        if (!back) say(13, "確認", "［やめる］の後に確認が閉じて取り込める形の札に戻らない");
      }
      if (screenReads.length !== readsAtCard) say(13, "確認", `確認の間に画面の写しの API を ${screenReads.length - readsAtCard} 回読んだ`);
    } finally {
      for (const off of offs.reverse()) await off();
    }

    // 11. 記録: 段の間に増えた行は、終わったチャンネルのセッションの 404（とその console の行）だけ
    const added = logLines.slice(from);
    const http404 = endedSession === null ? 0 : added.filter((l) => l.includes(`HTTP 404 GET /api/cc/sessions/${endedSession}`)).length;
    const res404 = added.filter((l) => l.includes("Failed to load resource") && l.includes("404")).length;
    if (endedSession !== null && http404 > 0 && res404 === http404 && added.length === http404 * 2) dropExpected(from, [`/api/cc/sessions/${endedSession}`, "Failed to load resource"]);
    else say(11, "記録", `段の間の行 ${added.length}（終わったセッションの 404 ${http404}・console ${res404}）`);
    return lines;
  }

  /** 段 cc の組（2 つ目のサーバー。ダークだけ） */
  async function ccShell(vp: Viewport): Promise<void> {
    const p = `${vp}-dark`;
    const names = ccShellNames(vp);
    if (!names.some(wanted)) return;
    const { ctx, page } = await contextFor(vp, "dark", `v3-${p}-cc`);
    try {
      await step(`${p} cc`, names, async () => {
        const started = Date.now();
        const problems = await ccStage(page, vp, p);
        console.log(`[v3-${p}] 段 cc: ${((Date.now() - started) / 1000).toFixed(1)} 秒`);
        for (const line of problems) logLines.push(`[v3-${p}] ${line}`);
        if (problems.length > 0) throw new Error(`Claude Code のチャンネルの段の検査で ${problems.length} 件`);
      });
    } finally {
      await ctx.close();
    }
  }

  // 2 つ目のサーバー（Claude Code のチャンネル）の部は、段 cc だけを回して返す
  if (part === "cc") {
    for (const vp of CC_SHELLS) await ccShell(vp);
    return { count, failed };
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
  let ccFixture: FixtureServer | undefined;
  let cleaning: Promise<void> | undefined;
  /** ブラウザとサーバーを閉じ、<dir> があれば console.log を書く（何度呼んでも 1 回） */
  const cleanup = (): Promise<void> =>
    (cleaning ??= (async () => {
      await browser?.close().catch(() => undefined);
      await fixture?.close().catch(() => undefined);
      await ccFixture?.close().catch(() => undefined);
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
    const first = await shoot(browser, fixture, out, only, logLines);
    let count = first.count;
    let failed = first.failed;
    // 段 cc は 2 つ目のサーバー（Claude Code のチャンネル入り）。合う名前が無ければ立てない
    if (CC_SHELLS.flatMap(ccShellNames).some((name) => only === undefined || name.includes(only))) {
      ccFixture = await startFixtureServer({ cc: true, log: (line) => logLines.push(`[server-cc] ${line}`) });
      const cc = await shoot(browser, ccFixture, out, only, logLines, "cc");
      count += cc.count;
      failed += cc.failed;
    }
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
