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

/**
 * main frame の document の移動（goto・reload。hash だけの移動は要求にならない）が始まったら、それより前の要求は前の document の物で、
 * finished も failed も来ない事が在る（読み込み中に移った /turns・/api/topics など）ので、そこで外す
 */
function trackRequests(page: Page): void {
  const pending = new Set<PageRequest>();
  inflight.set(page, pending);
  page.on("request", (r) => {
    if (r.isNavigationRequest() && r.frame() === page.mainFrame()) pending.clear();
    pending.add(r);
  });
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
    // 流れの列（D1。スマホは D2）: 帯と列の所と、項目から席（スマホはスレッド）を開いた所
    "a-deck",
    "a-deck-seat",
    // 席が開くときの動き（D5 の PR-1。ダークのスマホと PC）: 動きを止めた 0%・50%・100% のコマ
    ...(theme === "dark" && vp !== "tablet" ? ["a-deck-seat-0", "a-deck-seat-50", "a-deck-seat-100"] : []),
    // スマホの流れの列（D2。ダークだけ）: 下のバーでタスク・通知へ送った所と、歯車の板
    ...(vp === "phone" && theme === "dark" ? ["a-deck-tasks", "a-deck-feed", "a-deck-more"] : []),
    // あなたの番の列の節「ピン留め」（#507 の P2。ダークのスマホだけ）: 動いている話題と待機の話題を「…」から留めた所
    ...(vp === "phone" && theme === "dark" ? ["a-deck-pins"] : []),
    // 帯と会話の列（#507 の P4。ダークの PC だけ）: 2 つ留めた帯の左端と、右端まで送った所
    ...(vp === "pc" && theme === "dark" ? ["a-deck-pins-wide", "a-deck-pins-wide-end"] : []),
    // 列の中の操作（D1 の PR-2。ダークの PC と、D2 からダークのスマホ）: タスクを［完了］にした直後
    ...(vp !== "tablet" && theme === "dark" ? ["a-deck-done"] : []),
    // 列のリマインドの［次を飛ばす］［止める］（#472 の PR-1。ダークの PC だけ）: ［止める］の確認が出た所
    ...(vp === "pc" && theme === "dark" ? ["a-deck-rem"] : []),
    // 席だけの幅（幅 700 で席を開いた。D6。ダークの PC だけ）: 丸が無く、帯に［右腕］が出た所
    ...(vp === "pc" && theme === "dark" ? ["a-deck-solo"] : []),
    // ［広げる］で右腕の会話を席に開いた所（D6 の PR-6b。ダークの PC だけ。タブレットは検査だけ）
    ...(vp === "pc" && theme === "dark" ? ["c-hand-seat"] : []),
    "b-chat-top",
    "b-chat-middle",
    "b-chat-bottom",
    // 本番の見出し（段 t。ダークの 3 組。PC は幅 1340（席 440）で compact に替わった所も）
    ...(theme === "dark" ? ["b-top-long", "b-top-menu", "b-top-place", ...(vp === "pc" ? ["b-top-seat-narrow"] : [])] : []),
    // 本番の会話の行（段 k。ダークの 3 組。スマホは幅 375・等幅の字も）
    ...(theme === "dark" ? ["b-talk-rows", "b-talk-steps-open", "b-talk-run", "b-talk-long", ...(vp === "phone" ? ["b-talk-long-open", "b-talk-mono375"] : [])] : []),
    // 本番の入力欄（段 n。ダークの 3 組。字数の絵はスマホだけ）
    ...(theme === "dark" ? ["b-composer-empty", "b-composer-6lines", ...(vp === "phone" ? ["b-composer-count"] : [])] : []),
    // 本番のカード（段 r。ダークの 3 組）
    ...(theme === "dark" ? ["b-cards-close", "b-cards-move", "b-cards-other", "b-cards-sending"] : []),
    // 知らせと確認（段 u。ダークのスマホと PC）
    ...(theme === "dark" && vp !== "tablet" ? ["u-notice", "u-notice-error", "u-confirm"] : []),
    ...(full
      ? ["b-chat-permission", "b-chat-question", "d-composer-3lines", "c-hand-over", ...(vp === "phone" ? [] : ["c-hand-with-chat"]), "e-start-dialog", "f-settings", "f-knowledge-list", "f-knowledge-detail"]
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

/** スマホの上の帯の題（#c-band-root の .c-band-name）と、下のバーの今の列の section の aria-label・並びの崩れ（ブラウザの中で動く。page.evaluate に渡すので外の変数を使わない） */
function bandTitleState(): { kind: string | null; tag: string | null; title: string | null; badge: string | null; count: string | null; label: string | null; page: string | null; colLabel: string | null; layout: string[] } {
  const name = document.querySelector<HTMLElement>("#c-band-root .c-band-name");
  const page = document.querySelector('#c-foot-root [aria-current="true"]')?.getAttribute("data-page") ?? null;
  const col = page === null ? undefined : [...document.querySelectorAll<HTMLElement>("#c-deck-root .c-deck > .c-col")].find((c) => c.dataset.col === page);
  const text = (sel: string): string | null => {
    const el = name === null ? null : name.querySelector(sel);
    return el === null ? null : (el.textContent ?? "").trim();
  };
  const layout: string[] = [];
  const band = document.querySelector<HTMLElement>("#c-band-root .c-band");
  const ops = document.querySelector<HTMLElement>("#c-band-root .c-band-ops");
  if (name !== null && band !== null && ops !== null) {
    const r = name.getBoundingClientRect();
    const b = band.getBoundingClientRect();
    const o = ops.getBoundingClientRect();
    if (r.left < b.left - 0.5 || r.right > b.right + 0.5 || r.top < b.top - 0.5 || r.bottom > b.bottom + 0.5) layout.push(`帯の題の箱 ${r.left.toFixed(1)}〜${r.right.toFixed(1)}・${r.top.toFixed(1)}〜${r.bottom.toFixed(1)} が帯からはみ出る`);
    if (r.right > o.left + 0.5) layout.push(`帯の題の右端 ${r.right.toFixed(1)} が帯のボタンの左端 ${o.left.toFixed(1)} に重なる`);
    if (name.scrollWidth > name.clientWidth + 0.5) layout.push(`帯の題がはみ出る 幅 ${name.clientWidth} 要る幅 ${name.scrollWidth}`);
    for (const el of name.querySelectorAll<HTMLElement>(":scope > :not(.c-band-title)")) {
      const n = el.getBoundingClientRect();
      if (n.width <= 0 || n.right > r.right + 0.5) layout.push(`帯の題の数「${(el.textContent ?? "").trim()}」が縮むか題の箱からはみ出る`);
    }
  }
  return {
    kind: name === null ? null : name.getAttribute("data-kind"),
    tag: name === null ? null : name.tagName.toLowerCase(),
    title: text(".c-band-title"),
    badge: text(":scope > .c-badge"),
    count: text(":scope > .c-band-count"),
    label: name === null ? null : name.getAttribute("aria-label"),
    page,
    colLabel: col === undefined ? null : col.getAttribute("aria-label"),
    layout,
  };
}

/** 帯の題が今の列（section の aria-label「名前 N 件」か名前）と同じか。違う所の文（when は文の頭） */
function bandTitleProblems(s: ReturnType<typeof bandTitleState>, when: string): string[] {
  const out = s.layout.map((l) => `${when}: ${l}`);
  if (s.kind !== "page" || s.tag !== "h2") return [...out, `${when}: 帯の題が h2[data-kind="page"] でない（${String(s.tag)}・${String(s.kind)}）`];
  const m = s.colLabel === null ? null : /^(.*) (\d+) 件$/.exec(s.colLabel);
  const name = m === null ? s.colLabel : m[1]!;
  const count = m === null ? null : m[2]!;
  const shown = s.badge ?? s.count;
  if (s.title !== name || shown !== count || s.label !== s.colLabel) out.push(`${when}: 帯の題「${String(s.title)}」・数 ${String(shown)}・名前 ${String(s.label)}（今の列 ${String(s.page)} の「${String(s.colLabel)}」のはず）`);
  if (s.badge !== null && s.count !== null) out.push(`${when}: 帯の題に Badge と数の両方が在る`);
  return out;
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

/** accent の塗りの面積の上限（画面の割合）と、大きな塗り（44px 角以上）の数の上限（D3。docs/plan/web-ui-deck.md §4.5 の差し色） */
const ACCENT_AREA_MAX = 0.03;
const ACCENT_BIG_MAX = 1;

/**
 * accent の塗りの量（ブラウザの中で動く。page.evaluate に渡すので外の変数を使わない）。見えている要素（上に重なった物の下は除く）のうち、
 * 地（background-color）が --accent の物の画面の中の面積の和が areaMax 以下、44px 角以上の物が bigMax 以下。足りない物の文を返す。
 * 測り方の空振りの守り: 見えている未読の点・accent の数の印・下のバーの右腕・右腕の丸の accent の顔は塗りとして数えられている。min 個以上を数えている
 */
function accentProblems({ label, areaMax, bigMax, min = 0 }: { label: string; areaMax: number; bigMax: number; min?: number }): string[] {
  const out: string[] = [];
  const probe = document.createElement("span");
  probe.style.color = "var(--accent)";
  document.body.append(probe);
  const accent = getComputedStyle(probe).color;
  probe.remove();
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  let area = 0;
  const big: string[] = [];
  const counted = new Set<Element>();
  /** 画面の中に見えている分の幅と高さ（見えていなければ null） */
  const seen = (el: HTMLElement): { w: number; h: number } | null => {
    if (!el.checkVisibility({ opacityProperty: true, visibilityProperty: true })) return null;
    const r = el.getBoundingClientRect();
    const left = Math.max(r.left, 0);
    const top = Math.max(r.top, 0);
    const w = Math.max(0, Math.min(r.right, vw) - left);
    const h = Math.max(0, Math.min(r.bottom, vh) - top);
    if (w === 0 || h === 0) return null;
    // 真ん中で上に在る物が自分・子・親（pointer-events: none の印）でなければ、幕やスレッドの下で見えていない
    const hit = document.elementFromPoint(left + w / 2, top + h / 2);
    if (hit === null || !(hit === el || el.contains(hit) || hit.contains(el))) return null;
    return { w, h };
  };
  for (const el of document.querySelectorAll<HTMLElement>("body *")) {
    if (getComputedStyle(el).backgroundColor !== accent) continue;
    const box = seen(el);
    if (box === null) continue;
    const { w, h } = box;
    counted.add(el);
    area += w * h;
    if (w >= 44 && h >= 44) big.push(`${el.tagName.toLowerCase()}.${String(el.className).trim().split(/\s+/)[0] ?? ""}（${Math.round(w)}x${Math.round(h)}）`);
  }
  const share = area / (vw * vh);
  if (share > areaMax) out.push(`accent の塗り（${label}）: 面積が画面の ${(share * 100).toFixed(2)}%（${(areaMax * 100).toFixed(0)}% 以下のはず）`);
  if (big.length > bigMax) out.push(`accent の塗り（${label}）: 44px 角以上が ${big.length} 個（${bigMax} 個以下のはず）: ${big.join("・")}`);
  // 空振りの守り: accent で塗ると決まっている物が見えていれば、上の数え方で拾えている
  for (const el of document.querySelectorAll<HTMLElement>('.c-mark[data-state="unread"], .c-badge[data-tone="accent"], .c-bottom-hand, .c-orb[data-tone="accent"]')) {
    if (seen(el) !== null && !counted.has(el)) out.push(`accent の塗り（${label}）: ${el.tagName.toLowerCase()}.${String(el.className).trim().split(/\s+/)[0] ?? ""} が塗りとして数えられていない（地 ${getComputedStyle(el).backgroundColor}。--accent ${accent} のはず）`);
  }
  if (counted.size < min) out.push(`accent の塗り（${label}）: 数えた塗りが ${counted.size} 個（${min} 個以上のはず。測り方が空振りしている）`);
  return out;
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
 * 見本のカードの測り方（ブラウザの中で動く。page.evaluate に渡すので外の変数を使わない）。見本の名前・番の面と左の線と角と幅（D3。枠は無い）・見出しの字・カードの中に --warning の字が無い・
 * ボタンの高さと並び（スマホは 2 つが 2 等分・3 つが縦、PC は左から 1 行）・チェックの行と印の大きさ・要約の高さ（PC は 8 行で止まる）・
 * 残り時間の色と太さ（急ぎは太さで分ける）・待ちの行の role・動いている物（状態の行の送っている間の輪のほかは無い）・narrow の幅・横にはみ出さない・質問の「その他」の欄（見える物と値・スマホの字）と問の間（線でなく余白）と［答える］の押せない印・
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
  const turnSurface = colorOf("var(--turn-surface)");
  const text = colorOf("var(--text)");
  const root = getComputedStyle(document.documentElement);
  const radius = parseFloat(root.getPropertyValue("--c-card-r"));
  const max = parseFloat(root.getPropertyValue("--c-card-max"));
  if (!(radius > 0) || !(max > 0)) say("--c-card-r・--c-card-max が読めない");
  const sectionRight = section.getBoundingClientRect().right;
  // 2. 番の面と左の線（D3。上・右・下の線は無く、左の角は丸めない）
  for (const card of section.querySelectorAll(".c-card")) {
    const demo = card.closest("[data-demo]")?.getAttribute("data-demo") ?? "?";
    const cs = getComputedStyle(card);
    if (cs.borderLeftColor !== warning) say(`${demo} の左の線の色 ${cs.borderLeftColor}。--warning（${warning}）のはず`);
    if (cs.borderLeftWidth !== "3px") say(`${demo} の左の線の太さ ${cs.borderLeftWidth}。3px のはず`);
    for (const side of ["Top", "Right", "Bottom"] as const) if (cs[`border${side}Width`] !== "0px") say(`${demo} の ${side} の線の太さ ${cs[`border${side}Width`]}。0px のはず`);
    if (parseFloat(cs.borderTopRightRadius) !== radius) say(`${demo} の右上の角 ${cs.borderTopRightRadius}。${radius}px のはず`);
    if (parseFloat(cs.borderTopLeftRadius) !== 0) say(`${demo} の左上の角 ${cs.borderTopLeftRadius}。0 のはず`);
    if (parseFloat(cs.borderBottomRightRadius) !== radius) say(`${demo} の右下の角 ${cs.borderBottomRightRadius}。${radius}px のはず`);
    if (parseFloat(cs.borderBottomLeftRadius) !== 0) say(`${demo} の左下の角 ${cs.borderBottomLeftRadius}。0 のはず`);
    if (cs.backgroundColor !== turnSurface) say(`${demo} の地 ${cs.backgroundColor}。--turn-surface（${turnSurface}）のはず`);
    // カードの中に --warning の字を置かない（ライトの --warning は番の面の上で 4.5 を割る）
    for (const el of [card, ...card.querySelectorAll("*")]) {
      if (el.getClientRects().length === 0 || (el.textContent ?? "").trim() === "") continue;
      if (getComputedStyle(el).color === warning) say(`${demo} の中の ${el.tagName.toLowerCase()}.${el.className}「${(el.textContent ?? "").trim().slice(0, 12)}」の字が --warning`);
    }
    const r = card.getBoundingClientRect();
    if (r.width > max + 0.5) say(`${demo} の幅 ${r.width.toFixed(1)}。${max} 以下のはず`);
    if (card.scrollWidth > card.clientWidth) say(`${demo} のカードが横にはみ出している（${card.scrollWidth} > ${card.clientWidth}）`);
    if (r.right > sectionRight + 0.5) say(`${demo} のカードが節の幅を超えている`);
  }
  // 3. 見出し
  for (const title of section.querySelectorAll(".c-card-title")) {
    const cs = getComputedStyle(title);
    if (cs.fontSize !== "12px") say(`見出しの字 ${cs.fontSize}。12px のはず`);
    if (cs.color !== text) say(`見出しの色 ${cs.color}。--text（${text}）のはず`);
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
  const metaStyle = (demo: string): { color: string; weight: string } | null => {
    const meta = section.querySelector(`[data-demo="${demo}"] .c-card-meta`);
    return meta === null ? null : { color: getComputedStyle(meta).color, weight: getComputedStyle(meta).fontWeight };
  };
  // 急ぎは色でなく太さで分ける（どちらも --text）
  const urgent = metaStyle("card-perm-urgent");
  const calm = metaStyle("card-perm");
  if (urgent === null || urgent.color !== text || urgent.weight !== "600") say(`card-perm-urgent の残り時間 ${urgent?.color ?? "無い"}・太さ ${urgent?.weight ?? "?"}。--text（${text}）・600 のはず`);
  if (calm === null || calm.color !== text || calm.weight === "600") say(`card-perm の残り時間 ${calm?.color ?? "無い"}・太さ ${calm?.weight ?? "?"}。--text で 600 でないはず（急ぎと太さで分かれる）`);
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
  // 9. 問の間（D3。線でなく余白: 上の線はどちらも 0、2 問目の上の余白が 1 問目より大きい）
  const sets = [...section.querySelectorAll('[data-demo="card-q-two"] fieldset.c-card-q')];
  if (sets.length !== 2) say(`card-q-two の問の数 ${sets.length}。2 のはず`);
  else {
    const [first, second] = sets.map((f) => getComputedStyle(f));
    if (first.borderTopWidth !== "0px") say(`card-q-two の 1 問目の上の線 ${first.borderTopWidth}。0px のはず`);
    if (second.borderTopWidth !== "0px") say(`card-q-two の 2 問目の上の線 ${second.borderTopWidth}。0px のはず`);
    if (!(parseFloat(second.paddingTop) > parseFloat(first.paddingTop))) say(`card-q-two の 2 問目の上の余白 ${second.paddingTop}。1 問目（${first.paddingTop}）より大きいはず`);
    // 見出しは fieldset の上の端に乗らない（乗ると、枠の上の線の位置に字が出る）
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
  "top-phone-talk", "top-phone-running", "top-phone-long", "top-phone-other",
  "top-wide-talk", "top-wide-cc", "top-wide-long", "top-wide-short", "top-wide-mode", "top-wide-mode-busy", "top-wide-pin", "top-wide-pinned", "top-wide-pin-full", "top-wide-other",
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
/** 会話の行の幅の上限（.c-talk の中の幅に対する割合。agent と実行中の行・owner）。D4 から行は列いっぱいまで */
const TALK_MAX: Record<Viewport, { agent: number; owner: number }> = { phone: { agent: 1, owner: 1 }, tablet: { agent: 1, owner: 1 }, pc: { agent: 1, owner: 1 } };
/** 自分の発言の本文の箱の形（D4。寄せる側・角（左上・右上・右下・左下）・地の変数・上下の余白の和・左右の余白。返事の箱は地なし・余白 0・角 0） */
const TALK_OWNER = { side: "left", radius: [10, 10, 10, 10], ground: "var(--muted)", padY: 20, padX: 14 } as const;
/** talkProblems が数える物の最少（返事の行・自分の行・コードの段）。見る物が 0 個で通らないように、呼ぶ所ごとに書く */
type TalkNeed = { agent: number; owner: number; pre: number };
/** 会話の根の字の大きさ（px。--c-font-body） */
const TALK_FONT: Record<Viewport, number> = { phone: 16, tablet: 16, pc: 14 };

/**
 * 見本の会話の測り方（ブラウザの中で動く。page.evaluate に渡すので外の変数を使わない）。
 * 見本の名前・本文の中に結果の文が無い・1 行の本文の箱の高さ・幅の上限と左端・角・はみ出し・長いコードを横に送れる・手順の行・実行中の行の読み上げ・根の字・
 * 本文の箱の地と余白（返事は地なし・自分は owner の形）・コードの地と枠・数の最少（need）。
 * demos が null なら本番の会話（見本の名前を前提にした 0・2・3 の talk-basic と talk-edge・6 を飛ばす）。足りない物の文を返す
 */
function talkProblems({ demos, max, owner: ownerShape, need, fontSize, label }: { demos: string[] | null; max: { agent: number; owner: number }; owner: typeof TALK_OWNER; need: TalkNeed; fontSize: number; label: string }): string[] {
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
  // .c-talk の中身の幅と左端
  const innerOf = (talk: Element): { left: number; width: number } => {
    const ts = getComputedStyle(talk);
    return { left: talk.getBoundingClientRect().left + parseFloat(ts.paddingLeft), width: talk.clientWidth - parseFloat(ts.paddingLeft) - parseFloat(ts.paddingRight) };
  };
  // 1. 結果の文は本文の外
  for (const bubble of document.querySelectorAll(".c-bubble")) {
    const text = bubble.textContent ?? "";
    for (const word of ["完了（", "止まりました", "中断しました"]) if (text.includes(word)) say(`${nameOf(bubble)} の本文の中に「${word}」が在る`);
  }
  // 2. 1 行の本文の箱の高さ（返事は本文そのまま。自分の発言は 1 行 + 上下の余白）
  const basic = demos === null ? null : document.querySelector('[data-demo="talk-basic"] .c-msg[data-who="agent"]');
  const basicP = basic?.querySelector(".c-bubble p") ?? null;
  const basicB = basic?.querySelector(".c-bubble") ?? null;
  const basicO = demos === null ? null : document.querySelector('[data-demo="talk-basic"] .c-msg[data-who="owner"] > .c-bubble');
  if (demos === null) {
    // 本番は段 k で話題の 1 文の返事を測る
  } else if (basicP === null || basicB === null || basicO === null) say("talk-basic に agent か owner の本文が無い");
  else {
    const ph = basicP.getBoundingClientRect().height;
    const bh = basicB.getBoundingClientRect().height;
    const oh = basicO.getBoundingClientRect().height;
    if (!near(ph, fontSize * 1.5, 1)) say(`talk-basic の本文の高さ ${ph.toFixed(1)}。${fontSize * 1.5} のはず（1 行）`);
    if (!near(bh, ph, 1)) say(`talk-basic の返事の本文の箱の高さ ${bh.toFixed(1)}。本文 ${ph.toFixed(1)} のはず（余白なし）`);
    if (!near(oh, fontSize * 1.5 + ownerShape.padY, 1)) say(`talk-basic の自分の発言の箱の高さ ${oh.toFixed(1)}。1 行 + ${ownerShape.padY} = ${fontSize * 1.5 + ownerShape.padY} のはず`);
  }
  // 3. 幅の上限と左端（どの行も .c-talk の中身の左端から。右寄せの行が無い）
  for (const row of document.querySelectorAll(".c-talk > .c-msg, .c-talk > .c-run")) {
    const talk = row.closest(".c-talk");
    if (talk === null) continue;
    const inner = innerOf(talk);
    const owner = row.getAttribute("data-who") === "owner";
    const limit = owner ? max.owner : max.agent;
    const r = row.getBoundingClientRect();
    const ratio = r.width / inner.width;
    if (ratio > limit + 0.001) say(`${nameOf(row)} の ${owner ? "owner" : row.classList[0]} の幅 ${ratio.toFixed(3)}。${limit} 以下のはず`);
    if (ownerShape.side === "left" && !near(r.left, inner.left, 0.5)) say(`${nameOf(row)} の ${owner ? "owner" : row.classList[0]} の左端 ${r.left.toFixed(1)}。.c-talk の中身の左端 ${inner.left.toFixed(1)} のはず`);
  }
  // 短い自分の発言は文なり（列の半分に届かない）
  const short = basicO?.closest(".c-talk") ?? null;
  if (basicO !== null && short !== null) {
    const ratio = basicO.getBoundingClientRect().width / innerOf(short).width;
    if (!(ratio < 0.5)) say(`talk-basic の短い自分の発言の幅 ${ratio.toFixed(3)}。文なり（0.5 未満）のはず`);
  }
  const edge = [...document.querySelectorAll('[data-demo="talk-edge"] .c-msg[data-who="owner"]')].at(-1);
  const edgeTalk = edge?.closest(".c-talk") ?? null;
  const mdRow = document.querySelector('[data-demo="talk-md"] .c-msg[data-who="agent"]');
  const mdTalk = mdRow?.closest(".c-talk") ?? null;
  if (demos === null) {
    // 本番には talk-edge・talk-md が無い
  } else if (edge === undefined || edgeTalk === null) say("talk-edge に owner の本文が無い");
  else if (mdRow === null || mdTalk === null) say("talk-md に agent の本文が無い");
  else {
    const ratio = edge.getBoundingClientRect().width / innerOf(edgeTalk).width;
    if (ratio < max.owner - 0.01) say(`talk-edge の長い発言の幅 ${ratio.toFixed(3)}。上限 ${max.owner} に届いていない`);
    // 地なしの返事も列いっぱいまで使える
    const md = mdRow.getBoundingClientRect().width / innerOf(mdTalk).width;
    if (md < max.agent - 0.01) say(`talk-md の返事の幅 ${md.toFixed(3)}。上限 ${max.agent} に届いていない`);
  }
  // 4. 角（左上・右上・右下・左下）。返事は 0、自分の発言は owner の形
  for (const bubble of document.querySelectorAll(".c-msg > .c-bubble")) {
    const cs = getComputedStyle(bubble);
    const got = [cs.borderTopLeftRadius, cs.borderTopRightRadius, cs.borderBottomRightRadius, cs.borderBottomLeftRadius].map((v) => parseFloat(v));
    const owner = bubble.parentElement?.getAttribute("data-who") === "owner";
    const want = owner ? ownerShape.radius : [0, 0, 0, 0];
    if (got.some((v, i) => !near(v, want[i] ?? 0, 0.5))) say(`${nameOf(bubble)} の ${owner ? "owner" : "agent"} の角 ${got.join("・")}。${want.join("・")} のはず`);
  }
  // A・B. 本文の箱の地と余白（返事は地が透明・余白 0。自分の発言は owner の地・余白で、一番近い地つきの祖先と違う色）。C. コードの地と枠
  // 色の変数はその行の会話の中で読む（見本の節ごとの地や主題に合わせる）
  const colorOf = (el: Element, v: string): string => {
    const probe = document.createElement("span");
    probe.style.color = v;
    (el.closest(".c-talk") ?? document.body).append(probe);
    const c = getComputedStyle(probe).color;
    probe.remove();
    return c;
  };
  const clear = (c: string): boolean => c === "transparent" || /^rgba\(.*,\s*0\)$/.test(c);
  const pads = (cs: CSSStyleDeclaration): number[] => [cs.paddingTop, cs.paddingRight, cs.paddingBottom, cs.paddingLeft].map((v) => parseFloat(v));
  // 数えるのは検査している会話の中だけ（見本は会話の節の見本、本番は #ed の .c-talk。右腕やほかの節の行は数えない）
  const inRoot = (el: Element): boolean => el.closest(demos === null ? "#ed .c-talk" : '[data-section="talk"] [data-demo]') !== null;
  const counts = { agent: 0, owner: 0, pre: 0 };
  for (const bubble of document.querySelectorAll('.c-msg[data-who="agent"] > .c-bubble')) {
    if (inRoot(bubble)) counts.agent++;
    const cs = getComputedStyle(bubble);
    if (!clear(cs.backgroundColor)) say(`${nameOf(bubble)} の返事の本文の箱の地 ${cs.backgroundColor}。透明のはず`);
    if (pads(cs).some((v) => v !== 0)) say(`${nameOf(bubble)} の返事の本文の箱の余白 ${pads(cs).join("・")}。0 のはず`);
    const borders = [cs.borderTopWidth, cs.borderRightWidth, cs.borderBottomWidth, cs.borderLeftWidth];
    if (borders.some((v) => parseFloat(v) !== 0)) say(`${nameOf(bubble)} の返事の本文の箱の枠 ${borders.join("・")}。0 のはず`);
    if (cs.boxShadow !== "none") say(`${nameOf(bubble)} の返事の本文の箱の影 ${cs.boxShadow}。none のはず`);
  }
  for (const bubble of document.querySelectorAll('.c-msg[data-who="owner"] > .c-bubble')) {
    if (inRoot(bubble)) counts.owner++;
    const cs = getComputedStyle(bubble);
    const ground = colorOf(bubble, ownerShape.ground);
    if (cs.backgroundColor !== ground) say(`${nameOf(bubble)} の自分の発言の地 ${cs.backgroundColor}。${ownerShape.ground}（${ground}）のはず`);
    const want = [ownerShape.padY / 2, ownerShape.padX, ownerShape.padY / 2, ownerShape.padX];
    if (pads(cs).some((v, i) => !near(v, want[i] ?? 0, 0.5))) say(`${nameOf(bubble)} の自分の発言の余白 ${pads(cs).join("・")}。${want.join("・")} のはず`);
    let up = bubble.parentElement;
    while (up !== null && clear(getComputedStyle(up).backgroundColor)) up = up.parentElement;
    const under = up === null ? null : getComputedStyle(up).backgroundColor;
    if (under === null || under === cs.backgroundColor) say(`${nameOf(bubble)} の自分の発言の面が下の地（${String(under)}）と同じ色`);
  }
  for (const el of document.querySelectorAll(".c-md-pre, .c-md-code")) {
    const cs = getComputedStyle(el);
    const kind = el.classList.contains("c-md-pre") ? "コードの段" : "文中のコード";
    const muted = colorOf(el, "var(--muted)");
    if (cs.backgroundColor !== muted) say(`${nameOf(el)} の${kind}の地 ${cs.backgroundColor}。--muted（${muted}）のはず`);
    if (!el.classList.contains("c-md-pre")) continue;
    if (inRoot(el)) counts.pre++;
    for (const side of ["Top", "Right", "Bottom", "Left"] as const) {
      if (cs[`border${side}Width`] !== "0px") say(`${nameOf(el)} のコードの段の ${side} の枠 ${cs[`border${side}Width`]}。0px（線なし）のはず`);
    }
    // 枠の代わりの線（内側の影・outline）も持たない。区切りは面だけなので、下の地と同じ色なら見分けられない
    if (cs.boxShadow !== "none") say(`${nameOf(el)} のコードの段の影 ${cs.boxShadow}。none のはず`);
    if (cs.outlineStyle !== "none") say(`${nameOf(el)} のコードの段の outline ${cs.outlineStyle}。none のはず`);
    let up = el.parentElement;
    while (up !== null && clear(getComputedStyle(up).backgroundColor)) up = up.parentElement;
    const under = up === null ? null : getComputedStyle(up).backgroundColor;
    if (under === null || under === cs.backgroundColor) say(`${nameOf(el)} のコードの段の面が下の地（${String(under)}）と同じ色`);
  }
  // D. 空振りの守り（見る物が足りなければ落とす）
  for (const key of ["agent", "owner", "pre"] as const) if (counts[key] < need[key]) say(`${key} の本文（コードの段）が ${counts[key]} 個。${need[key]} 個以上のはず`);
  // 5. はみ出し
  for (const el of document.querySelectorAll(".c-talk, .c-bubble")) {
    if (el.scrollWidth > el.clientWidth) say(`${nameOf(el)} の ${el.classList[0] ?? ""} が横にはみ出している（${el.scrollWidth} > ${el.clientWidth}）`);
  }
  // 6. 長いコードは本文の箱の中で横に送れる
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
    if (msg !== null && bubble !== null && bubble.getBoundingClientRect().right > msg.getBoundingClientRect().right + 0.5) say("talk-md の本文の箱の右端が行の右端を超えている");
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
  // 10. 行の一番下の［続ける］（返事の行の最後の子・ボタン 1 つ・高さ 36・左端が本文の箱と .c-talk の中身と同じ・上の物との間 16）
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
    if (bubble === null || !near(b.left, bubble.getBoundingClientRect().left, 0.5)) say(`${nameOf(act)} の［続ける］の左端が本文の箱とずれる（${b.left.toFixed(1)} / ${bubble === null ? "なし" : bubble.getBoundingClientRect().left.toFixed(1)}）`);
    const actTalk = msg.closest(".c-talk");
    if (actTalk === null || !near(b.left, innerOf(actTalk).left, 0.5)) say(`${nameOf(act)} の［続ける］の左端が .c-talk の中身の左端とずれる（${b.left.toFixed(1)} / ${actTalk === null ? "なし" : innerOf(actTalk).left.toFixed(1)}）`);
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
  '.c-msg[data-who="owner"] .c-bubble',
  '.c-msg[data-who="agent"] .c-md-p',
  ".c-md-pre",
  ".c-md-code",
  ".c-md-link",
  '.c-msg[data-who="agent"] .c-msg-time',
  '.c-steps-toggle[data-tone="muted"]',
  ".c-notice",
  ".c-divider",
];
/** 会話の漏れで LEAK_PROPS に足して比べる性質（本文の箱とコードの角・左右の枠。D4 で地と角が変わった所） */
const LEAK_TALK_EXTRA = ["border-top-left-radius", "border-top-right-radius", "border-bottom-right-radius", "border-bottom-left-radius", "border-left-width", "border-right-width", "border-top-color"];

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
/** スマホの流れの列の下のバー（D2。#c-foot-root と見本 bottom-deck） */
const LEAK_BOTTOM_DECK = [".c-bottom", ".c-bottom-page", ".c-bottom-page-label", ".c-bottom-hand", ".c-bottom-hand-label"];
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

  /** 上の帯のボタン（find・start・more は Button を包む span、hand はボタンそのもの） */
  const bandButton = (act: "find" | "hand" | "start" | "more"): string => (act === "hand" ? '#c-band-root button[data-act="hand"]' : `#c-band-root [data-act="${act}"] button`);

  /** 流れの列が効いているか（640px 以上で入口が在る） */
  const deckOn = (page: Page): Promise<boolean> => page.evaluate(() => document.querySelector("#v3[data-deck]") !== null);

  /** 流れの列なら帯の［探す］で一覧の板を開く（開いていれば何もしない。スマホ・古い形では何もしない） */
  async function openFind(page: Page): Promise<void> {
    if (!(await deckOn(page))) return;
    if ((await page.$('#v3[data-find="open"]')) !== null) return;
    await page.click(bandButton("find"));
    await page.waitForSelector('#v3[data-find="open"]', { timeout: 5000 });
    await settled(page);
  }

  /** 板（幕が在る dialog）は枠を持たない（D3）。selector の要素の 4 辺の枠の太さが 0px でなければ文を返す */
  async function sheetFrame(page: Page, selector: string, what: string): Promise<string[]> {
    const widths = await page.evaluate((sel: string) => {
      const el = document.querySelector(sel);
      if (el === null) return null;
      const cs = getComputedStyle(el);
      return [cs.borderTopWidth, cs.borderRightWidth, cs.borderBottomWidth, cs.borderLeftWidth];
    }, selector);
    if (widths === null) return [`${what}が無い（${selector}）`];
    return widths.every((w) => w === "0px") ? [] : [`${what}の枠 ${widths.join(" ")}（上下左右とも 0px のはず。板は幕で区切る）`];
  }

  /** 一覧の行を押す（流れの列では先に「探す」の板を開く。本当の道） */
  async function clickRow(page: Page, selector: string, which: "first" | "last"): Promise<void> {
    await openFind(page);
    const rows = page.locator(selector);
    await (which === "first" ? rows.first() : rows.last()).click();
  }

  /** スマホの下のバーの右腕のボタン（流れの列は列の下のバー #c-foot-root。D2） */
  const BAR_HAND = '#c-foot-root button[data-act="hand"]';
  /** 広い幅の流れの列の右下の右腕の丸（D6） */
  const ORB = '#c-orb-root button.c-orb[data-act="hand"]';

  /** 右腕を開くボタン（スマホの流れの列は下のバーの右腕、広い幅の流れの列は右下の丸（席だけの幅で丸が無ければ帯の［右腕］。D6）、ほかは畳んだ帯の #v3-hand-show） */
  const handShow = async (page: Page): Promise<string> =>
    (await deckOn(page))
      ? (await page.$('#v3[data-seat="full"]')) !== null
        ? BAR_HAND
        : (await page.$(ORB)) !== null
          ? ORB
          : bandButton("hand")
      : "#v3-hand-show";

  /** 一覧を読み直し、流れの列なら「探す」の板を開いた形にする（一覧の検査は板の中で走らせる） */
  async function loadList(page: Page): Promise<void> {
    await load(page, "/");
    await openFind(page);
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
      await loadList(page);

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
      await loadList(page);

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
      await loadList(page);
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
      await loadList(page);
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
      // スマホの流れの列の下のバー（D2）と見本 bottom-deck
      ...(vp === "phone" ? [{ real: "#c-foot-root", demo: '[data-demo="bottom-deck"]', sels: LEAK_BOTTOM_DECK }] : []),
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
    // 流れの列は一覧の下のバーを描かないので、比べる間だけ一覧のバーを描かせる（形は幅で決まり、見本の bottom-wide・bottom-phone と同じ）
    if (await deckOn(page)) {
      await page.evaluate(() => {
        const noop = (): void => undefined;
        (window as unknown as { SA: { list: { drawBar: (bar: unknown) => boolean } } }).SA.list.drawBar({
          turns: 0,
          hand: null,
          tabs: [
            { id: "tasks", title: "タスク" },
            { id: "reminders", title: "リマインド" },
          ],
          on: { list: noop, hand: noop, tab: noop, more: noop },
        });
      });
    }
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
    await loadList(page);
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
      const shown = (sel: string): HTMLElement[] => [...document.querySelectorAll<HTMLElement>(`:is(#c-list-root, #c-bottom-root, #c-foot-root) ${sel}`)].filter((el) => el.getClientRects().length > 0);
      const name = (el: HTMLElement): string => (el.textContent ?? "").trim().slice(0, 20);
      // R1 はみ出ない
      for (const sel of [".c-list", ".c-bottom", ".c-row", ".c-turn", ".c-group-head"]) {
        for (const el of [...document.querySelectorAll<HTMLElement>(sel)].filter((e) => e.getClientRects().length > 0)) {
          if (el.scrollWidth > el.clientWidth) out.push(`${label} R1: ${sel}「${name(el)}」がはみ出る 幅 ${el.clientWidth} 要る幅 ${el.scrollWidth}`);
        }
      }
      // R2 省かれない字（右端は親の button か見出しの中）
      for (const sel of [".c-row-state", ".c-row-time", ".c-turn-meta", ".c-group-note", ".c-turns-jump-label", ".c-bottom-btn-label", ".c-bottom-hand-label", ".c-bottom-page-label", ".c-bottom .c-btn-label"]) {
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
    // 流れの列は一覧の下のバーを描かず、行き先は上の帯（スマホは列の下のバー #c-foot-root。D2）
    if (await deckOn(page)) return checkBarDeck(page, vp, p);
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
        // 800 は流れの列: 下のバーは描かず、上の帯のボタン 4 つが見える
        await page.setViewportSize({ width: 800, height: VIEWPORTS.phone.viewport.height });
        await settled(page);
        const wide = await page.evaluate(() => ({
          kids: document.querySelector("#c-bottom-root")?.children.length ?? -1,
          band: [...document.querySelectorAll<HTMLElement>("#c-band-root .c-band-ops [data-act]")].filter((el) => el.getClientRects().length > 0).map((el) => el.getAttribute("data-act")),
        }));
        if (wide.kids !== 0 || JSON.stringify(wide.band) !== JSON.stringify(["find", "hand", "start", "more"])) lines.push(`バー: 800 で下のバーが消えて上の帯のボタン 4 つが見える形にならない（子 ${wide.kids}・帯 ${wide.band.join("・")}）`);
      } finally {
        await page.setViewportSize(VIEWPORTS.phone.viewport);
        await settled(page);
      }
      const narrow = await formAt();
      if (narrow.variant !== "phone" || narrow.acts[0] !== "list" || narrow.acts[1] !== "hand" || narrow.texts[2] !== "ほか") lines.push(`バー: 390 に戻してもスマホの形にならない（${String(narrow.variant)}・${narrow.texts.join("・")}）`);
      // 800 の間はバーを描かないので、戻した後のバーは新しい要素。「ほか」の焦点の検査のために印を付け直す
      await page.evaluate(() => {
        const buttons = document.querySelectorAll(".c-bottom button");
        const more = buttons[buttons.length - 1];
        if (more !== undefined) (more as unknown as { __k: number }).__k = 2;
      });
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

  /**
   * スマホの流れの列の下のバー（#c-foot-root。D2）の検査（ダークのスマホ。checkBarDeck から）: 形・数は あなたの番 だけで列の見出しと同じ・高さと下端と最後の項目・
   * バーで送る（余分な描き直しが無く印が 1 回で移る・今の列をもう一度押しても変わらない・焦点はバーに残る）・scrollLeft を書くと印が付いてくる・
   * 右腕のボタンの同じ要素と印と名前と閉じた後の焦点・幅をまたぐ（広い幅で列を送っても下のバーが出ない）・開いたボタンの無い戻り。最後は あなたの番 の列に戻す
   */
  async function checkFootBar(page: Page): Promise<string[]> {
    const lines: string[] = [];
    const say = (text: string): void => void lines.push(`バー: ${text}`);
    const PAGE = (id: string): string => `#c-foot-root button[data-act="page"][data-page="${id}"]`;
    // 形（2）・数は あなたの番 だけ（入口の口の 6）
    const form = await page.evaluate(() => {
      const root = document.querySelector("#c-foot-root");
      const bar = root === null ? null : root.firstElementChild;
      const buttons = bar === null ? [] : [...bar.querySelectorAll("button")];
      return {
        kids: root === null ? -1 : root.children.length,
        isBar: bar !== null && bar.matches('.c-bottom[data-variant="deck"]'),
        ids: root === null ? 0 : root.querySelectorAll("[id]").length,
        texts: buttons.map((b) => (b.querySelector(".c-bottom-page-label, .c-bottom-hand-label")?.textContent ?? "").trim()),
        badges: buttons.map((b) => b.querySelector(".c-badge") !== null),
      };
    });
    if (form.kids !== 1 || !form.isBar) say(`#c-foot-root の子が .c-bottom[data-variant="deck"] 1 つでない（子 ${form.kids}）`);
    if (JSON.stringify(form.texts) !== JSON.stringify(["あなたの番", "タスク", "通知", "右腕"])) say(`下のバーが あなたの番・タスク・通知・右腕 でない（${form.texts.join("・")}）`);
    if (form.ids !== 0) say(`下のバーの中に id の付いた要素が ${form.ids} 個`);
    if (form.badges.slice(1).some(Boolean)) say("タスク・通知・右腕に数の印が在る（あなたの番 だけのはず）");
    // 数は上の帯の題と同じ（入口の口の 5。スマホは列の見出しを出さず、今の列の名前と数は帯の題。番の数を作り物で替える手段が無いので、右腕を番にした前後で帯と同じかを見る）
    const counts = (): Promise<{ head: string; bar: string; title: string }> =>
      page.evaluate(() => ({
        head: (document.querySelector('#c-band-root .c-band-name[data-kind="page"] > .c-badge')?.textContent ?? "").trim(),
        bar: (document.querySelector('#c-foot-root button[data-page="turn"] .c-badge')?.textContent ?? "").trim(),
        title: (document.querySelector('#c-band-root .c-band-name[data-kind="page"] .c-band-title')?.textContent ?? "").trim(),
      }));
    const c0 = await counts();
    if (c0.title !== "あなたの番") say(`始めの帯の題が「${c0.title}」（あなたの番 のはず）`);
    if (c0.head !== c0.bar) say(`あなたの番 の数が 帯の題「${c0.head}」・下のバー「${c0.bar}」`);
    for (const line of bandTitleProblems(await page.evaluate(bandTitleState), "始めの帯")) say(line);
    // 列の見出しは場所を取らない（名前と数は帯の題）
    const heads = await page.evaluate(() => [...document.querySelectorAll<HTMLElement>("#c-deck-root .c-col-head")].map((el) => el.getBoundingClientRect().height));
    if (heads.length !== 3 || heads.some((h) => h !== 0)) say(`列の見出しの高さが ${heads.join("・")}（3 つとも 0 のはず）`);
    // 高さ・下端（3）・最後の項目: 今の列を末尾まで送った最後の項目がバーに隠れない
    await page.evaluate(() => {
      const body = document.querySelector('#c-deck-root .c-col[data-col="turn"] .c-col-body');
      if (body !== null) body.scrollTop = body.scrollHeight;
    });
    await settled(page);
    const end = await page.evaluate(() => {
      const bar = document.querySelector("#c-foot-root .c-bottom");
      const items = [...document.querySelectorAll('#c-deck-root .c-col[data-col="turn"] .c-item')];
      const last = items[items.length - 1];
      const r = bar === null ? null : bar.getBoundingClientRect();
      return { lastBottom: last === undefined ? null : last.getBoundingClientRect().bottom, top: r?.top ?? null, bottom: r?.bottom ?? null, height: r?.height ?? null, inner: window.innerHeight };
    });
    if (end.top === null || end.bottom === null || end.height === null) say(".c-bottom が無い");
    else {
      if (end.lastBottom === null || end.lastBottom > end.top + 0.5) say(`列の最後の項目の下端 ${String(end.lastBottom)} がバーの上端 ${end.top} より下`);
      if (Math.abs(end.bottom - end.inner) > 0.5) say(`下端 ${end.bottom} が画面の下端 ${end.inner} と合わない`);
      if (Math.abs(end.height - 64) > 0.5) say(`高さ ${end.height}（64 のはず）`);
    }
    await page.evaluate(() => {
      const body = document.querySelector('#c-deck-root .c-col[data-col="turn"] .c-col-body');
      if (body !== null) body.scrollTop = 0;
    });
    // 印の移り（aria-current が付いた列）と、指で送った知らせ（on.paged）を記録する。drawBar に渡る on.paged を包む
    await page.evaluate(() => {
      const w = window as unknown as { __cur: string[]; __paged: string[]; SA: { deck: { drawBar: (bar: unknown) => boolean } } };
      w.__cur = [];
      w.__paged = [];
      new MutationObserver((records) => {
        for (const r of records) {
          const el = r.target as Element;
          if (el.getAttribute("aria-current") === "true") w.__cur.push(el.getAttribute("data-page") ?? "");
        }
      }).observe(document.querySelector("#c-foot-root")!, { subtree: true, attributes: true, attributeFilter: ["aria-current"] });
      const draw = w.SA.deck.drawBar;
      w.SA.deck.drawBar = (bar: unknown) => {
        if (bar === null || typeof bar !== "object") return draw(bar);
        const b = bar as { on: { paged: (id: string) => unknown } };
        return draw({ ...b, on: { ...b.on, paged: (id: string) => (w.__paged.push(id), b.on.paged(id)) } });
      };
    });
    const seen = (): Promise<{ cur: string[]; paged: string[]; left: number; at: Record<string, number>; current: string | null; focus: string | null }> =>
      page.evaluate(() => {
        const w = window as unknown as { __cur: string[]; __paged: string[] };
        const box = document.querySelector<HTMLElement>("#c-deck-root .c-deck");
        const at: Record<string, number> = {};
        for (const col of document.querySelectorAll<HTMLElement>("#c-deck-root .c-deck > .c-col")) {
          if (box !== null) at[col.dataset.col ?? ""] = box.scrollLeft + col.getBoundingClientRect().left - box.getBoundingClientRect().left;
        }
        const a = document.activeElement;
        return {
          cur: [...w.__cur],
          paged: [...w.__paged],
          left: box?.scrollLeft ?? -1,
          at,
          current: document.querySelector('#c-foot-root [aria-current="true"]')?.getAttribute("data-page") ?? null,
          focus: a !== null && a.matches("#c-foot-root button") ? (a.getAttribute("data-page") ?? a.getAttribute("data-act")) : null,
        };
      });
    // バーで送る（4・入口の口の 1）: 列の左端へ・印が 1 回で移る・paged 由来の描き直しが無い・焦点はバーに残る
    await page.click(PAGE("tasks"));
    await settled(page);
    let s1 = await seen();
    if (Math.abs(s1.left - (s1.at.tasks ?? -1)) > 1) say(`タスクを押した後の列の位置 ${s1.left}（タスクの列の左端 ${String(s1.at.tasks)} のはず）`);
    if (JSON.stringify(s1.cur) !== JSON.stringify(["tasks"])) say(`タスクを押した後の印の移り ${s1.cur.join("→")}（tasks の 1 回のはず）`);
    if (s1.paged.length !== 0) say(`バーで送った後に指の送りの知らせが来た（${s1.paged.join("・")}）`);
    if (s1.focus !== "tasks") say(`タスクを押した後の焦点が ${String(s1.focus)}（タスクのボタンのはず）`);
    const t1 = await page.evaluate(bandTitleState);
    if (t1.page !== "tasks" || t1.title !== "タスク") say(`タスクを押した後の帯の題が「${String(t1.title)}」（タスク のはず）`);
    for (const line of bandTitleProblems(t1, "タスクを押した後の帯")) say(line);
    // 今の列をもう一度押しても位置も印も変わらない（入口の口の 2）
    await page.click(PAGE("tasks"));
    await settled(page);
    const s2 = await seen();
    if (Math.abs(s2.left - s1.left) > 1 || s2.cur.length !== s1.cur.length || s2.current !== "tasks") say(`今の列をもう一度押すと位置か印が変わる（${s1.left}→${s2.left}・${s2.cur.join("→")}）`);
    // scrollLeft を通知の列に書くと印が付いてくる（指の代わり。入口の口の 4）
    await page.evaluate((x: number) => {
      const box = document.querySelector<HTMLElement>("#c-deck-root .c-deck");
      if (box !== null) box.scrollLeft = x;
    }, s2.at.feed ?? 0);
    const followed = await page
      .waitForFunction(() => document.querySelector('#c-foot-root [aria-current="true"]')?.getAttribute("data-page") === "feed", undefined, { timeout: 5000 })
      .then(() => true, () => false);
    await settled(page);
    s1 = await seen();
    if (!followed) say(`列の位置を通知に書いても印が通知に付かない（${String(s1.current)}）`);
    if (JSON.stringify(s1.paged) !== JSON.stringify(["feed"])) say(`列の位置を通知に書いた後の指の送りの知らせが ${s1.paged.join("・") || "無い"}（feed の 1 回のはず）`);
    // 帯の題も付いてくる
    const t2 = await page.evaluate(bandTitleState);
    if (t2.page !== "feed" || t2.title !== "通知") say(`列の位置を通知に書いた後の帯の題が「${String(t2.title)}」（通知 のはず）`);
    for (const line of bandTitleProblems(t2, "列の位置を通知に書いた後の帯")) say(line);
    // あなたの番 に戻す
    await page.click(PAGE("turn"));
    await settled(page);
    // 右腕のボタン（5）: 同じ要素・番の印・名前。右腕を あなたの番 にして描き直させる
    await page.evaluate(() => {
      const hand = document.querySelector('#c-foot-root [data-act="hand"]');
      if (hand !== null) (hand as unknown as { __k: number }).__k = 1;
    });
    let hands = true;
    await loadEdited(page, (json) => {
      const hand = json.rightHands[0];
      if (hand === undefined) hands = false;
      else hand.turn = { kind: "confirm", since: "2026-01-01T00:00:00.000Z", summary: null };
    });
    if (!hands) say("作り物のデータに右腕が無い");
    else {
      const same = await page.evaluate(() => {
        const hand = document.querySelector('#c-foot-root [data-act="hand"]');
        return {
          hand: hand !== null && (hand as unknown as { __k?: number }).__k === 1,
          turn: hand !== null && hand.querySelector('[data-state="turn"]') !== null,
          label: hand === null ? null : hand.getAttribute("aria-label"),
        };
      });
      if (!same.hand) say("描き直した後の右腕のボタンが同じ要素でない");
      if (!same.turn) say("右腕のボタンに「あなたの番」の印が無い");
      if (same.label !== "右腕に頼む・訊く（あなたの番）") say(`右腕のボタンの名前が ${String(same.label)}`);
      const c1 = await counts();
      if (c1.head !== c1.bar) say(`右腕を番にした後の あなたの番 の数が 帯の題「${c1.head}」・下のバー「${c1.bar}」`);
      // 閉じた後の焦点: 開いている間に描き直されても、閉じたら右腕のボタンへ
      await page.click(BAR_HAND);
      await page.waitForSelector('#v3[data-hand="open"]', { timeout: 5000 });
      await loadEdited(page, () => undefined);
      await page.evaluate(() => history.back());
      await page.waitForSelector('#v3[data-hand="closed"]', { timeout: 5000 });
      await settled(page);
      if (!(await page.evaluate(() => (document.activeElement as unknown as { __k?: number } | null)?.__k === 1))) say("右腕を閉じた後の焦点が右腕のボタンに戻らない");
    }
    // 幅をまたぐ（6）: 800 は広い幅の流れの列で下のバーは空・帯のボタン 3 つと右腕の丸（D6）。列を横に送っても下のバーは出ない（入口の口の 3）。390 に戻すと下のバー 4 つ・帯 3 つ
    const pagedBefore = (await seen()).paged.length;
    try {
      await page.setViewportSize({ width: 800, height: VIEWPORTS.phone.viewport.height });
      await settled(page);
      const band = (): Promise<Array<string | null>> =>
        page.evaluate(() => [...document.querySelectorAll<HTMLElement>("#c-band-root .c-band-ops [data-act]")].filter((el) => el.getClientRects().length > 0).map((el) => el.getAttribute("data-act")));
      const kids = (): Promise<number> => page.evaluate(() => document.querySelector("#c-foot-root")?.children.length ?? -1);
      const wideBand = await band();
      // 広い幅の口は右下の丸（D6）。帯は 探す・始める・ほか
      const wideOrbs = await page.evaluate((sel: string) => document.querySelectorAll(sel).length, ORB);
      if ((await kids()) !== 0 || JSON.stringify(wideBand) !== JSON.stringify(["find", "start", "more"]) || wideOrbs !== 1) {
        say(`800 で下のバーが空で帯のボタン 3 つ・右腕の丸 1 つの形にならない（子 ${await kids()}・帯 ${wideBand.join("・")}・丸 ${wideOrbs}）`);
      }
      // 広い幅の帯は「self-agent」のまま、列の見出しは見える
      const wideHead = await page.evaluate(() => {
        const name = document.querySelector("#c-band-root .c-band-name");
        const heads = [...document.querySelectorAll<HTMLElement>("#c-deck-root .c-col-head")].filter((el) => el.closest(".c-col")!.getBoundingClientRect().width > 0);
        return { tag: name?.tagName.toLowerCase() ?? null, text: (name?.textContent ?? "").trim(), heads: heads.map((el) => el.getBoundingClientRect().height) };
      });
      if (wideHead.tag !== "span" || wideHead.text !== "self-agent") say(`800 の帯の名前が ${String(wideHead.tag)}「${wideHead.text}」（span の self-agent のはず）`);
      if (wideHead.heads.length !== 3 || wideHead.heads.some((h) => h <= 0)) say(`800 の列の見出しの高さが ${wideHead.heads.join("・")}（3 つとも見えるはず）`);
      const scrolled = await page.evaluate(() => {
        const box = document.querySelector<HTMLElement>("#c-deck-root .c-deck");
        if (box === null) return { paged: true, moved: false };
        box.scrollLeft = 200;
        return { paged: box.hasAttribute("data-paged"), moved: box.scrollLeft > 0 };
      });
      await settled(page);
      if (scrolled.paged) say("800 の列に data-paged が付いている");
      if (!scrolled.moved) say("800 で列を横に送れない（送っても下のバーが出ないかを確かめられない）");
      if ((await kids()) !== 0 || (await seen()).paged.length !== pagedBefore) say("800 で列を横に送ると下のバーが出るか、指の送りの知らせが来る");
    } finally {
      await page.setViewportSize(VIEWPORTS.phone.viewport);
      await settled(page);
    }
    const narrow = await page.evaluate(() => ({
      foot: document.querySelectorAll("#c-foot-root button").length,
      band: [...document.querySelectorAll<HTMLElement>("#c-band-root .c-band-ops [data-act]")].filter((el) => el.getClientRects().length > 0).map((el) => el.getAttribute("data-act")),
      current: document.querySelector('#c-foot-root [aria-current="true"]')?.getAttribute("data-page") ?? null,
    }));
    if (narrow.foot !== 4 || JSON.stringify(narrow.band) !== JSON.stringify(["find", "start", "more"]) || narrow.current !== "turn") say(`390 に戻しても下のバー 4 つ・帯 3 つ・今の列 あなたの番 にならない（${narrow.foot}・${narrow.band.join("・")}・${String(narrow.current)}）`);
    for (const line of bandTitleProblems(await page.evaluate(bandTitleState), "390 に戻した後の帯")) say(line);
    // 開いたボタンの無い戻り（7）: 焦点の無いまま右腕のチャンネルを開き、閉じたら下のバーの右腕のボタンへ
    const opened = await page.evaluate(() => {
      const sa = (window as unknown as { SA: { topics: { data: () => { rightHands: Array<{ id: string }> } | null }; app: { open: (id: string) => void } } }).SA;
      const hand = sa.topics.data()?.rightHands[0];
      if (hand === undefined) return false;
      if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
      sa.app.open(hand.id);
      return true;
    });
    if (!opened) say("作り物のデータに右腕が無い（開いたボタンの無い戻り）");
    else {
      await page.waitForSelector('#v3[data-hand="open"]', { timeout: 5000 });
      await page.evaluate(() => history.back());
      await page.waitForSelector('#v3[data-hand="closed"]', { timeout: 5000 });
      await settled(page);
      if (!(await activeIs(page, BAR_HAND))) say("開いたボタンの無い右腕を閉じた後の焦点が下のバーの右腕のボタンに無い");
    }
    return lines;
  }

  /**
   * 流れの列のバーの検査（ダークの組。checkBar の代わり。スマホは列の下のバーの検査 checkFootBar も）: 下のバーの根の子が 0・上の帯のボタン 4 つと id なし・
   * タブレットは「探す」の板で一覧を末尾まで送って最後の行が板の中・歯車の「ほか」の板（タスクが無い。閉じたら歯車へ）・最初の 1 回（応答の前から帯）。
   * 最後は「探す」の板を開き直して終える（続く幅の検査は板の中で測る）
   */
  async function checkBarDeck(page: Page, vp: Viewport, p: string): Promise<string[]> {
    const lines: string[] = [];
    // スマホ（D2）の帯は［右腕］を出さない（口は下のバー）。広い幅も列だけの間は出さない（口は右下の丸。D6）
    const phone = vp === "phone";
    const bandActs = ["find", "start", "more"];
    const form = await page.evaluate((orbSel: string) => {
      const root = document.querySelector("#c-bottom-root");
      const band = document.querySelector("#c-band-root > .c-band");
      return {
        kids: root === null ? -1 : root.children.length,
        band: band !== null,
        ids: band === null ? 0 : band.querySelectorAll("[id]").length,
        acts: band === null ? [] : [...band.querySelectorAll(".c-band-ops [data-act]")].map((el) => el.getAttribute("data-act")),
        orbs: document.querySelectorAll(orbSel).length,
        orbIds: document.querySelectorAll("#c-orb-root [id]").length,
      };
    }, ORB);
    if (form.kids !== 0) lines.push(`バー: 流れの列で #c-bottom-root の子が ${form.kids}（0 のはず）`);
    if (!form.band) lines.push("バー: 上の帯（.c-band）が無い");
    if (form.ids !== 0) lines.push(`バー: 上の帯の中に id の付いた要素が ${form.ids} 個`);
    if (JSON.stringify(form.acts) !== JSON.stringify(bandActs)) lines.push(`バー: 上の帯のボタンが 探す・始める・ほか でない（${form.acts.join("・")}）`);
    // 右腕の丸はスマホに無く、広い幅に 1 つ（中に id を持たない）
    if (form.orbs !== (phone ? 0 : 1)) lines.push(`バー: 右腕の丸が ${form.orbs} 個（${phone ? 0 : 1} 個のはず）`);
    if (form.orbIds !== 0) lines.push(`バー: 右腕の丸の中に id の付いた要素が ${form.orbIds} 個`);
    // スマホの列の下のバー（板が開いていれば先に閉じる）
    if (phone) {
      if ((await page.$('#v3[data-find="open"]')) !== null) {
        await page.keyboard.press("Escape");
        await page.waitForSelector('#v3[data-find="closed"]', { timeout: 5000 });
        await settled(page);
      }
      lines.push(...(await checkFootBar(page)));
    }
    // 末尾（タブレット）: 板の中で一覧を末尾まで送ると、最後の行が板の中・板は画面の中
    if (vp !== "pc") {
      await openFind(page);
      await page.evaluate(() => {
        const list = document.querySelector(".c-list");
        if (list !== null) list.scrollTop = list.scrollHeight;
      });
      await settled(page);
      const end = await page.evaluate(() => {
        const panel = document.querySelector("#v3-list");
        const buttons = [...document.querySelectorAll("#c-list-root button")].filter((b) => b.getClientRects().length > 0);
        const last = buttons[buttons.length - 1];
        const r = panel === null ? null : panel.getBoundingClientRect();
        return { lastBottom: last === undefined ? null : last.getBoundingClientRect().bottom, bottom: r === null ? null : r.bottom, inner: window.innerHeight };
      });
      if (end.bottom === null) lines.push("バー: 「探す」の板が無い");
      else {
        if (end.lastBottom === null || end.lastBottom > end.bottom + 0.5) lines.push(`バー: 最後の行の下端 ${String(end.lastBottom)} が板の下端 ${end.bottom} より下`);
        if (end.bottom > end.inner + 0.5) lines.push(`バー: 板の下端 ${end.bottom} が画面の下端 ${end.inner} より下`);
      }
      await shot(page, `${p}-a-list-end`);
      await page.evaluate(() => {
        const list = document.querySelector(".c-list");
        if (list !== null) list.scrollTop = 0;
      });
    }
    // 「ほか」の板（帯の歯車）: タスク・リマインドは列に在るので出さない。閉じたら歯車へ。板が開いていれば先に閉じる
    if ((await page.$('#v3[data-find="open"]')) !== null) {
      await page.keyboard.press("Escape");
      await page.waitForSelector('#v3[data-find="closed"]', { timeout: 5000 });
    }
    await page.click(bandButton("more"));
    await page.waitForSelector("#v3-sheet[open]", { timeout: 5000 });
    const rows = await page.evaluate(() => [...document.querySelectorAll("#v3-sheet button.more-row")].map((b) => (b.textContent ?? "").trim()));
    if (rows.some((r) => r.includes("タスク") || r.includes("リマインド"))) lines.push(`バー: 帯の「ほか」の板にタスクかリマインドが在る（${rows.join("・")}）`);
    await page.click("#v3-sheet button.sheet-close");
    await page.waitForSelector("#v3-sheet:not([open])", { state: "attached", timeout: 5000 });
    await settled(page);
    if (!(await activeIs(page, bandButton("more")))) lines.push("バー: 「ほか」の板を閉じた後の焦点が帯の歯車に戻らない");
    // 最初の 1 回: 最初の応答の前から、帯が出ていて（ボタン 4 つ）、下のバーは無く、一覧は読み込み中
    const pattern = "**/api/topics*";
    let release: () => void = () => undefined;
    const gate = new Promise<void>((done) => {
      release = done;
    });
    await page.route(pattern, async (route) => {
      await gate;
      await route.continue().catch(() => undefined);
    });
    try {
      await page.goto("about:blank");
      await page.goto(base + "/", { waitUntil: "load" });
      await page.waitForSelector("#c-band-root .c-band", { timeout: 5000 });
      if (phone) await page.waitForSelector("#c-foot-root .c-bottom", { timeout: 5000 });
      const first = await page.evaluate(() => ({
        loading: document.querySelector('.c-list[data-phase="loading"]') !== null,
        buttons: document.querySelectorAll("#c-band-root .c-band-ops [data-act]").length,
        kids: document.querySelector("#c-bottom-root")?.children.length ?? -1,
        foot: document.querySelectorAll("#c-foot-root button").length,
        footMarks: document.querySelectorAll("#c-foot-root :is(.c-badge, [data-state])").length,
      }));
      if (!first.loading) lines.push("バー: 最初の応答の前に一覧が読み込み中でない");
      if (first.buttons !== bandActs.length) lines.push(`バー: 最初の応答の前の帯のボタンが ${first.buttons} 個`);
      if (first.kids !== 0) lines.push(`バー: 最初の応答の前に一覧の下のバーが在る（子 ${first.kids}）`);
      // スマホは列の下のバー 4 つが数・印なしで出ている。広い幅は無い
      if (phone ? first.foot !== 4 || first.footMarks !== 0 : first.foot !== 0) lines.push(`バー: 最初の応答の前の列の下のバーのボタンが ${first.foot} 個・数か印が ${first.footMarks} 個`);
    } finally {
      release();
      await wait(100);
      await page.unroute(pattern);
    }
    await page.waitForSelector("#c-list-root section[data-kind]", { state: "attached", timeout: 8000 });
    await settled(page);
    await openFind(page);
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
  /** 焦点の在る要素の短い名前（検査の文に添える。字・id は出さない） */
  const activeTag = (page: Page): Promise<string> =>
    page.evaluate(() => {
      const el = document.activeElement;
      return el === null ? "無し" : `${el.tagName.toLowerCase()}.${String(el.className).trim().split(/\s+/)[0] ?? ""}`;
    });
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
   * 段 c: 流れの列の形の開いた右腕の枠（D6 の PR-2）。広い幅は 上端 = 帯（#v3-band）の下端 + 8・幅 420・右端 = 画面の右端・左の線 0・帯と重ならない・
   * 右下の丸の中心を引くと丸でも丸の子でもない（枠の中か幕。orb が false なら丸の無い画面 = 席だけの幅 なので見ない）。スマホは上の線 0。
   * どちらも枠が開いていて幅が在る事を先に見る。枠を開いて settled の後に呼ぶ。落ち先の形では呼ばない。足りない物の文を返す
   */
  async function handFrameLines(page: Page, vp: Viewport, orb = true): Promise<string[]> {
    const got = await page.evaluate((orbSel: string) => {
      const hand = document.querySelector<HTMLElement>("#v3-hand");
      const band = document.querySelector<HTMLElement>("#v3-band");
      if (hand === null || band === null) return null;
      const h = hand.getBoundingClientRect();
      const b = band.getBoundingClientRect();
      const cs = getComputedStyle(hand);
      const orb = document.querySelector<HTMLElement>(orbSel);
      let orbHit: string | null = null;
      if (orb !== null) {
        const o = orb.getBoundingClientRect();
        const el = document.elementFromPoint(o.left + o.width / 2, o.top + o.height / 2);
        orbHit =
          el === null
            ? "null"
            : el.closest("#v3-orb") !== null
              ? "orb"
              : el.closest("#v3-hand") !== null || el.id === "v3-hand-backdrop"
                ? "ok"
                : `${el.tagName.toLowerCase()}${el.id === "" ? "" : "#" + el.id}.${el.classList[0] ?? ""}`;
      }
      return {
        open: document.querySelector('#v3[data-hand="open"]') !== null,
        top: h.top,
        right: h.right,
        width: h.width,
        bandTop: b.top,
        bandBottom: b.bottom,
        vw: document.documentElement.clientWidth,
        left: cs.borderLeftWidth,
        topLine: cs.borderTopWidth,
        orb: orb !== null,
        orbHit,
      };
    }, ORB);
    if (got === null) return ["右腕の枠: #v3-hand か帯（#v3-band）が無い"];
    if (!got.open || got.width <= 0) return [`右腕の枠: 枠が開いていない（data-hand が open でないか、幅 ${got.width.toFixed(1)}）`];
    const lines: string[] = [];
    if (vp === "phone") {
      if (got.topLine !== "0px") lines.push(`右腕の枠: スマホの枠の上の線が ${got.topLine}（0 のはず）`);
      return lines;
    }
    if (Math.abs(got.top - (got.bandBottom + 8)) > 0.5) lines.push(`右腕の枠: 枠の上端 ${got.top.toFixed(1)} が帯の下端 ${got.bandBottom.toFixed(1)} + 8 でない`);
    if (Math.abs(got.width - 420) > 0.5) lines.push(`右腕の枠: 枠の幅 ${got.width.toFixed(1)}（420 のはず）`);
    if (Math.abs(got.right - got.vw) > 0.5) lines.push(`右腕の枠: 枠の右端 ${got.right.toFixed(1)} が画面の右端 ${got.vw} でない`);
    if (got.left !== "0px") lines.push(`右腕の枠: 枠の左の線が ${got.left}（0 のはず）`);
    if (got.top < got.bandBottom - 0.5) lines.push(`右腕の枠: 帯（${got.bandTop.toFixed(1)}〜${got.bandBottom.toFixed(1)}）と枠（上端 ${got.top.toFixed(1)}）が重なる`);
    if (!orb) {
      if (got.orb) lines.push("右腕の枠: 丸の無いはずの画面に右腕の丸が在る");
    } else if (!got.orb) lines.push("右腕の枠: 右腕の丸が DOM に無い（丸の上の当たりを見られない）");
    else if (got.orbHit !== "ok") lines.push(`右腕の枠: 枠を開いた間に丸の中心で引いた要素が ${got.orbHit}（枠の中か幕のはず）`);
    return lines;
  }

  /** 作り物の右腕のまとめの知らせの <#ID> の話題の題（出た順。ui-shots-fixture.ts の tB1・tG3） */
  const LEAD_REF_TITLES = ["記事の下書き", "ファームウェアの更新手順を README に書く。古い手順は消して、写真も撮り直す前提で"];

  /**
   * 段 c: 開いた右腕の中が部品（見出し・会話・札・入力欄）で描かれている。phone ならスマホで下のバーから開いた後（畳んで開き直し、焦点が入力欄に在るかも見る）。
   * 絵を撮った後に呼ぶ。まとめの知らせの札の［開く］を押して右腕を開き直した後、最後に返事の札の［開く］を押すので、呼んだ後は列 2 にその話題が開いている。足りない物の文を返す
   */
  async function handPartsLines(page: Page, vp: Viewport, phone: boolean): Promise<string[]> {
    const lines: string[] = [];
    // 6. スマホで下のバーから開いた直後の焦点。初めて開いたときは読み込み中で入力欄が無いので、読み込んだ後に畳んで開き直してから見る
    if (phone) {
      await page.click(HAND_CLOSE);
      await page.waitForSelector('#v3[data-hand="closed"]', { timeout: 5000 });
      await settled(page);
      await page.click(BAR_HAND);
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
      ...(await page.evaluate((want: string[]) => {
        const out: string[] = [];
        const count = (sel: string): number => document.querySelectorAll(sel).length;
        // 1. 古い道の物が無く、部品が 1 つずつ
        for (const sel of ["#v3-hand-ed .msg", "#v3-hand-ed .composer-wrap", "#v3-hand-ed header.ed-toolbar", "#v3-hand-ed .v3-card"]) if (count(sel) !== 0) out.push(`右腕: ${sel} が ${count(sel)} 個（0 のはず）`);
        for (const sel of ["#v3-hand-ed .c-talk", "#v3-hand-ed > [data-composer] .c-composer"]) if (count(sel) !== 1) out.push(`右腕: ${sel} が ${count(sel)} 個（1 のはず）`);
        // 2. 見出しは 1 つで h2「右腕」。ページの h1 は 1 つ以下
        const titles = [...document.querySelectorAll("#c-hand-root .c-hand-head h2")].map((el) => (el.textContent ?? "").trim());
        if (count("#c-hand-root .c-hand-head") !== 1 || titles.join() !== "右腕") out.push(`右腕: 見出し ${count("#c-hand-root .c-hand-head")} 個・題 ${JSON.stringify(titles)}（1 つで「右腕」のはず）`);
        if (count("h1") > 1) out.push(`右腕: ページの h1 が ${count("h1")} 個`);
        // 3. 札は作り物のデータの 4 つ（まとめの知らせの下に 2 つ・最後の返事の下に 2 つ。D6 の PR-3）。返事の本文に <# が残らない
        if (count("#v3-hand-ed .c-ref") !== 4) out.push(`右腕: 札が ${count("#v3-hand-ed .c-ref")} 個（4 のはず）`);
        if (count("#v3-hand-ed .c-msg + .c-refs .c-ref") !== 2) out.push(`右腕: 返事の下の札が ${count("#v3-hand-ed .c-msg + .c-refs .c-ref")} 個（2 のはず）`);
        if ([...document.querySelectorAll("#v3-hand-ed .c-bubble")].some((el) => (el.textContent ?? "").includes("<#"))) out.push("右腕: 返事の本文に <# が残っている");
        // 3b. まとめの知らせ（「終わりました」）のすぐ次が札の入れ物で、札は作り物の 2 つの話題（知らせの <#ID> の順）。知らせの本文に <# が残らない
        {
          const notices = [...document.querySelectorAll("#v3-hand-ed .c-notice")].filter((el) => (el.textContent ?? "").includes("終わりました"));
          if (notices.length !== 1) out.push(`右腕: まとめの知らせが ${notices.length} 個（1 のはず）`);
          for (const el of notices) {
            if ((el.textContent ?? "").includes("<#")) out.push("右腕: まとめの知らせの本文に <# が残っている");
            const next = el.nextElementSibling;
            if (next === null || !next.classList.contains("c-refs")) out.push(`右腕: まとめの知らせのすぐ次が ${next === null ? "なし" : next.className}（.c-refs のはず）`);
            else {
              const titles = [...next.querySelectorAll(".c-ref .c-ref-title")].map((t) => (t.textContent ?? "").trim());
              if (JSON.stringify(titles) !== JSON.stringify(want)) out.push(`右腕: まとめの知らせの札の題が ${JSON.stringify(titles)}（${JSON.stringify(want)} のはず）`);
            }
          }
        }
        // 札の後: 右腕も席と同じ形（D4）: 自分の発言は 1 つ以上で左寄せの --muted の面（余白 10/14・下の地と違う色）、返事は 1 つ以上で地が透明・余白 0
        {
          const talkEl = document.querySelector("#v3-hand-ed .c-talk");
          const probe = document.createElement("span");
          probe.style.color = "var(--muted)";
          (talkEl ?? document.body).append(probe);
          const muted = getComputedStyle(probe).color;
          probe.remove();
          const clear = (c: string): boolean => c === "transparent" || /^rgba\(.*,\s*0\)$/.test(c);
          const pads = (cs: CSSStyleDeclaration): string => [cs.paddingTop, cs.paddingRight, cs.paddingBottom, cs.paddingLeft].join(" ");
          const ts = talkEl === null ? null : getComputedStyle(talkEl);
          const left = talkEl === null || ts === null ? 0 : talkEl.getBoundingClientRect().left + parseFloat(ts.paddingLeft);
          const owners = [...document.querySelectorAll('#v3-hand-ed .c-msg[data-who="owner"] > .c-bubble')];
          const agents = [...document.querySelectorAll('#v3-hand-ed .c-msg[data-who="agent"] > .c-bubble')];
          if (owners.length < 1 || agents.length < 1) out.push(`右腕: 自分の発言 ${owners.length}・返事 ${agents.length}（1 つずつ以上のはず）`);
          for (const el of owners) {
            const cs = getComputedStyle(el);
            if (cs.backgroundColor !== muted) out.push(`右腕: 自分の発言の地 ${cs.backgroundColor}（--muted ${muted} のはず）`);
            if (pads(cs) !== "10px 14px 10px 14px") out.push(`右腕: 自分の発言の余白 ${pads(cs)}（10px 14px 10px 14px のはず）`);
            const row = el.parentElement;
            if (row === null || Math.abs(row.getBoundingClientRect().left - left) > 0.5) out.push(`右腕: 自分の発言の左端 ${row?.getBoundingClientRect().left.toFixed(1) ?? "なし"}（会話の中身の左端 ${left.toFixed(1)} のはず）`);
            let up = el.parentElement;
            while (up !== null && clear(getComputedStyle(up).backgroundColor)) up = up.parentElement;
            const under = up === null ? null : getComputedStyle(up).backgroundColor;
            if (under === null || under === cs.backgroundColor) out.push(`右腕: 自分の発言の面が下の地（${String(under)}）と同じ色`);
          }
          for (const el of agents) {
            const cs = getComputedStyle(el);
            if (!clear(cs.backgroundColor)) out.push(`右腕: 返事の本文の箱の地 ${cs.backgroundColor}（透明のはず）`);
            if (pads(cs) !== "0px 0px 0px 0px") out.push(`右腕: 返事の本文の箱の余白 ${pads(cs)}（0 のはず）`);
          }
        }
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
      }, LEAD_REF_TITLES)),
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
    // 8a. まとめの知らせの札の［開く］で、列 2 にその話題が開き、流れの列の形（とスマホ）は右腕が閉じる（D6 の PR-3）。押した後は 8 の前に右腕を開き直す
    const NOTICE_REF = "#v3-hand-ed .c-notice + .c-refs .c-ref";
    const leadRef = await page.evaluate((sel: string) => (document.querySelector(`${sel} .c-ref-title`)?.textContent ?? "").trim(), NOTICE_REF);
    if (leadRef !== "") {
      await page.locator(`${NOTICE_REF} > button.c-btn`).first().click();
      await page.waitForFunction((t: string) => (document.querySelector("#c-top-root .c-top-title")?.textContent ?? "").trim() === t, leadRef, { timeout: 5000 }).catch(() => undefined);
      await settled(page);
      const now = await page.evaluate(() => (document.querySelector("#c-top-root .c-top-title")?.textContent ?? "").trim());
      if (now !== leadRef) lines.push(`右腕: まとめの知らせの札の［開く］の後の列 2 の題が「${now}」（「${leadRef}」のはず）`);
      if ((vp === "phone" || (await deckOn(page))) && (await page.getAttribute("#v3", "data-hand")) !== "closed") lines.push("右腕: まとめの知らせの札の［開く］の後も右腕が開いている");
      // 段 c の初めと同じ開き方で開き直す
      await load(page, "/");
      if (phone) await page.click(BAR_HAND);
      else {
        const show = await handShow(page);
        if ((await page.getAttribute(show, "aria-expanded")) !== "true") await page.click(show);
      }
      await page.waitForSelector("#v3-hand-ed .c-msg + .c-refs .c-ref", { timeout: 5000 }).catch(() => undefined);
      await settled(page);
    } else lines.push("右腕: まとめの知らせの札が無い（［開く］を押せない）");
    // 8. 返事の札の［開く］で、列 2 にその話題が開く（スマホは右腕が閉じる）
    const ref = await page.evaluate(() => (document.querySelector("#v3-hand-ed .c-msg + .c-refs .c-ref .c-ref-title")?.textContent ?? "").trim());
    if (ref !== "") {
      await page.locator("#v3-hand-ed .c-msg + .c-refs .c-ref > button.c-btn").first().click();
      await page.waitForFunction((t: string) => (document.querySelector("#c-top-root .c-top-title")?.textContent ?? "").trim() === t, ref, { timeout: 5000 }).catch(() => undefined);
      await settled(page);
      const now = await page.evaluate(() => (document.querySelector("#c-top-root .c-top-title")?.textContent ?? "").trim());
      if (now !== ref) lines.push(`右腕: 札の［開く］の後の列 2 の題が「${now}」（「${ref}」のはず）`);
      if (vp === "phone" && (await page.getAttribute("#v3", "data-hand")) !== "closed") lines.push("右腕: スマホで札の［開く］の後も右腕が開いている");
    } else lines.push("右腕: 返事の札が無い（まとめの知らせの札の後に開き直した右腕で［開く］を押せない）");
    return lines;
  }

  /** 右腕の見出しの［広げる］（入口 c-app.js の HandHead。D6 の PR-6b） */
  const HAND_SEAT = '#c-hand-root [data-act="seat"] button';

  /**
   * ［広げる］で右腕の会話を席に開く（D6 の PR-6b。広い幅の流れの列の、列が見える幅）: 丸で開いた枠の見出しに［広げる］が 1 つ（名前「広げる」）で、押すと枠は閉じ、
   * 席に右腕の会話が 1 つ（右腕の入れ物には 0）・席の題「右腕」・札 4 つ・入力欄の placeholder は枠と同じ・帯と丸と列は押せ・焦点は席の入力欄。
   * 丸を押しても枠は開かず、焦点は席の入力欄。席を閉じた後の丸は枠を開く（会話は枠の 1 つだけ）。shotName が在れば席の絵を撮る
   */
  async function handSeatLines(page: Page, shotName: string | null): Promise<string[]> {
    const lines: string[] = [];
    const say = (text: string): void => void lines.push(`［広げる］: ${text}`);
    const talks = (): Promise<{ seat: number; hand: number }> =>
      page.evaluate(() => ({ seat: document.querySelectorAll("#ed .c-talk").length, hand: document.querySelectorAll("#v3-hand-ed .c-talk").length }));
    await load(page, "/");
    await page.click(ORB);
    await page.waitForSelector('#v3[data-hand="open"]', { timeout: 5000 });
    await page.waitForSelector("#v3-hand-ed textarea", { timeout: 5000 });
    await settled(page);
    const button = await page.evaluate((sel: string) => {
      const found = [...document.querySelectorAll(sel)];
      return { count: found.length, name: found[0]?.getAttribute("aria-label") ?? null };
    }, HAND_SEAT);
    if (button.count !== 1 || button.name !== "広げる") {
      say(`枠の見出しの［広げる］が ${button.count} 個・名前 ${JSON.stringify(button.name)}（1 つで「広げる」のはず）`);
      return lines;
    }
    const placeholder = await page.getAttribute("#v3-hand-ed textarea", "placeholder");
    await page.click(HAND_SEAT);
    await page.waitForSelector('#v3[data-hand="closed"][data-view="body"]', { timeout: 5000 });
    await page.waitForSelector("#ed .c-talk", { timeout: 5000 });
    await page.waitForSelector("#ed textarea", { timeout: 5000 });
    await settled(page);
    const seat = await page.evaluate(() => {
      const count = (sel: string): number => document.querySelectorAll(sel).length;
      const inert = ["#v3-band", "#v3-orb", "#v3-deck", "#v3-main"].filter((sel) => (document.querySelector(sel) as HTMLElement | null)?.inert === true);
      return {
        titles: [...document.querySelectorAll("#c-top-root .c-top-title")].map((el) => (el.textContent ?? "").trim()),
        place: count("#c-top-root .c-top-place-text"),
        refs: count("#ed .c-ref"),
        head: count("#c-hand-root .c-hand-head"),
        placeholder: document.querySelector("#ed textarea")?.getAttribute("placeholder") ?? null,
        inert,
        orbs: count('#c-orb-root button.c-orb[data-act="hand"]'),
      };
    });
    const first = await talks();
    if (first.seat !== 1 || first.hand !== 0) say(`席の会話が ${first.seat} 個・右腕の入れ物の会話が ${first.hand} 個（1 と 0 のはず。同じチャンネルを 2 か所に描かない）`);
    if (seat.titles.join() !== "右腕") say(`席の題が ${JSON.stringify(seat.titles)}（「右腕」のはず）`);
    if (seat.place !== 0) say(`席の見出しに場所が ${seat.place} 個（0 のはず）`);
    if (seat.refs !== 4) say(`席の札が ${seat.refs} 個（4 のはず。枠と同じ）`);
    if (seat.head !== 0) say(`枠の見出しが残っている（${seat.head} 個）`);
    if (seat.placeholder !== placeholder) say(`席の入力欄の placeholder が ${JSON.stringify(seat.placeholder)}（枠と同じ ${JSON.stringify(placeholder)} のはず）`);
    if (seat.inert.length > 0) say(`押せない物が在る（${seat.inert.join("・")}）`);
    if (seat.orbs !== 1) say(`丸が ${seat.orbs} 個（1 のはず）`);
    if (!(await activeIs(page, "#ed textarea"))) say(`押した後の焦点が席の入力欄に無い（${await activeTag(page)}）`);
    lines.push(...(await page.evaluate(accentProblems, { label: "席の右腕", areaMax: ACCENT_AREA_MAX, bigMax: ACCENT_BIG_MAX })));
    if (shotName !== null) await shot(page, shotName);
    // 席に右腕が出ている間の丸: 枠は開かず、焦点は席の入力欄
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
    await page.click(ORB);
    await settled(page);
    if ((await page.getAttribute("#v3", "data-hand")) !== "closed") say("席に右腕が出ている間の丸で枠が開いた");
    if (!(await activeIs(page, "#ed textarea"))) say(`席に右腕が出ている間の丸の後の焦点が席の入力欄に無い（${await activeTag(page)}）`);
    // 席を閉じた後の丸は枠を開く（会話は枠の 1 つだけ）
    await page.evaluate(() => history.back());
    await page.waitForSelector('#v3[data-view="list"]', { timeout: 5000 });
    await settled(page);
    if ((await page.getAttribute("#v3", "data-hand")) !== "closed") say("席を閉じたら枠が開いた");
    await page.click(ORB);
    await page.waitForSelector('#v3[data-hand="open"]', { timeout: 5000 });
    await page.waitForSelector("#v3-hand-ed .c-talk", { timeout: 5000 });
    await settled(page);
    const after = await talks();
    if (after.seat !== 0 || after.hand !== 1) say(`席を閉じた後に開いた枠: 席の会話が ${after.seat} 個・枠の会話が ${after.hand} 個（0 と 1 のはず）`);
    await page.keyboard.press("Escape");
    await page.waitForSelector('#v3[data-hand="closed"]', { timeout: 5000 });
    await settled(page);
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
      // 流れの列（D2）は「探す」の板の行から
      await clickRow(page, `#c-list-root button[data-topic="ch:${open}"]`, "last");
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
    if (vp === "pc") {
      // 流れの列は右腕を重ねる形だけ。右下の丸で重ねて開いた形から見る（列の形は無い）
      if (await deckOn(page)) {
        await page.click(await handShow(page));
        await page.waitForSelector('#v3[data-hand="open"][data-hand-mode="over"]', { timeout: 5000 });
        await settled(page);
      }
      lines.push(...(await pcPlaceLines(page, tag, "右腕を重ねて開いた形")));
    }
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
    lines.push(...(await sheetFrame(page, "#v3-sheet[open]", "本番の見出し: 「…」の板")));
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
        const bottom = document.querySelector('#c-foot-root button[data-act="hand"]');
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
      const showSel = await handShow(page);
      const show = await page.evaluate((sel: string) => {
        const id = document.querySelector(sel)?.getAttribute("aria-controls") ?? null;
        return id !== null && document.getElementById(id) !== null;
      }, showSel);
      if (!show) lines.push(`本番の見出し: ${showSel} の aria-controls の先が無い`);
      if (vp === "tablet") {
        const deck = await deckOn(page);
        const before = await topForm(page);
        await page.click(showSel);
        await page.waitForSelector('#v3[data-hand="open"]', { timeout: 5000 });
        await settled(page);
        const over = await topForm(page);
        if (over.mode !== "over") lines.push(`本番の見出し: タブレットの右腕が重ねる形でない（${String(over.mode)}）`);
        // 流れの列では席は 440 でいつも compact。重ねて開く前と後で compact が同じ事を見る（列 2 が広いのに compact のまま、の前提は成り立たない）
        if (deck) {
          if (over.compact !== before.compact) lines.push(`本番の見出し: 右腕を重ねて開く前と後で compact が違う（前 ${before.compact}・後 ${over.compact}）`);
        } else if (!(over.width >= over.min)) lines.push(`本番の見出し: 前提が崩れた。重ねて開いた間の列 2 の幅 ${over.width} がしきい値 ${over.min} 以上でない`);
        if (!over.compact) lines.push("本番の見出し: 重ねた右腕の後ろで見出しが compact でなくなった");
        lines.push(...(await checkHandHeading(page, "右腕")), ...(await checkH1(page, "右腕")));
        await page.click(HAND_CLOSE);
        await page.waitForSelector('#v3[data-hand="closed"]', { timeout: 5000 });
        await settled(page);
        if (!(await topForm(page)).compact) lines.push("本番の見出し: 重ねた右腕を畳んだ後に compact でない");
        lines.push(...(await checkRule(page, tag, "右腕を畳んだ後")));
      } else {
        // 流れの列では pcPlaceLines の後は畳んでいるので、右下の丸で重ねて開いて見出しを見る
        const reopened = (await page.getAttribute("#v3", "data-hand")) !== "open";
        if (reopened) {
          await page.click(showSel);
          await page.waitForSelector('#v3[data-hand="open"]', { timeout: 5000 });
          await settled(page);
        }
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
      // 決まり（checkRule）は重ねた右腕の開いていない所でだけ見る（右腕を重ねて開いた形は、畳んだ形で見る）
      if (!(f.mode === "over" && f.hand === "open")) lines.push(...(await checkRule(page, tag, at)));
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
    // 元の形に戻す（列の右腕は開いた形。流れの列は畳んだ形のまま: 重ねた右腕は後ろの見出しを押せなくする）
    if (!(await deckOn(page))) {
      await page.click("#v3-hand-show");
      await page.waitForSelector('#v3[data-hand="open"]', { timeout: 5000 });
      await settled(page);
    }
    return lines;
  }

  /** PC の幅を変える検査（席の幅で替わる・幅をまたいで戻る・またいだときの焦点）。終わったら幅を戻す */
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
      // 席の幅で替わる: 1340（並ぶ席 440）で compact、1339（畳む席 600）と 1440（席 540）で compact でない。右腕は畳んで測る
      if ((await topForm(page)).hand === "open") {
        await page.click(HAND_CLOSE);
        await page.waitForSelector('#v3[data-hand="closed"]', { timeout: 5000 });
        await settled(page);
      }
      await at("幅 1440・席 540", false);
      await size(1340);
      await at("幅 1340・席 440", true);
      await shot(page, "pc-dark-b-top-seat-narrow");
      await size(1339);
      await at("幅 1339・畳む席 600", false);
      await size(1340);
      await at("幅 1340 に戻した所", true);
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
  async function liveTalkLines(page: Page, vp: Viewport, label: string, need: TalkNeed): Promise<string[]> {
    return [
      ...(await page.evaluate(liveTalkProblems, { label })),
      ...(await page.evaluate(talkProblems, { demos: null, max: TALK_MAX[vp], owner: TALK_OWNER, need, fontSize: TALK_FONT[vp], label: `本番・${label}` })),
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
    lines.push(...(await liveTalkLines(page, vp, "吹き出しの確かめ", { agent: 1, owner: 1, pre: 1 })));
    // 4. 1 文の返事（2 行目）の本文の箱は 1 行ぶん（余白なし）で、手順の行（結果の文）が無い
    const one = await page.evaluate(() => {
      const row = document.querySelectorAll("#ed .c-talk > .c-msg")[1];
      const bubble = row?.querySelector(".c-bubble");
      return row === undefined || bubble === undefined || bubble === null
        ? null
        : { who: row.getAttribute("data-who"), h: bubble.getBoundingClientRect().height, steps: row.querySelectorAll(".c-steps-toggle, .c-steps-text").length };
    });
    if (one === null || one.who !== "agent") say("2 行目が返事の本文でない");
    else {
      if (Math.abs(one.h - fontSize * 1.5) > 1) say(`1 文の返事の本文の箱の高さ ${one.h.toFixed(1)}。${fontSize * 1.5} のはず`);
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
      ["本文の箱", wide.bubble],
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
    // 16. PC の .c-talk の幅は min(840, 列 2（席）の .ed-scroll の中身の幅) で真ん中（右腕を開いていれば測る間だけ畳む）
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
        const cs = getComputedStyle(sc);
        const inner = sc.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
        return { w: a.width, left, right, inner };
      });
      if (col === null) say("PC の列を測れない");
      else {
        const want = Math.min(840, col.inner);
        if (Math.abs(col.w - want) > 0.5) say(`PC の .c-talk の幅 ${col.w.toFixed(1)}（min(840, 席の中身 ${col.inner.toFixed(1)}) = ${want.toFixed(1)} のはず）`);
        if (Math.abs(col.left - col.right) > 1) say(`PC の .c-talk が真ん中でない（左 ${col.left.toFixed(1)}・右 ${col.right.toFixed(1)}）`);
      }
      if (handOpen) {
        await page.click(await handShow(page));
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
    if (after1.rows !== rows0 + 1) say(`行を足した後の行が ${after1.rows}（${rows0 + 1} のはず）`);
    if (!(after1.gap >= 0 && after1.gap < 2)) say(`下端に居たのに新着で下へ送らない（残り ${after1.gap}）`);
    if (!after1.sameScroll) say("行を足した描き直しで .ed-scroll が別の要素になった");
    if (!after1.sameBubble) say("行を足した描き直しで最初の本文の箱が別の要素になった");
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
    lines.push(...(await liveTalkLines(page, vp, "実行中", { agent: 0, owner: 1, pre: 0 })));
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
    if (!runAfter.sameBubble) say("刻みで最初の本文の箱が別の要素になった");
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
      if (!weight.same) say("重さの測りの tick の後、最初の本文の箱が別の要素");
      if (!weight.changed) say("重さの測りの tick で経過の文が変わらない");
    }

    // ----- 長い会話 -----
    await load(page, `/#/ch/${long}`);
    await page.waitForSelector('#ed .c-talk .c-msg[data-who="agent"]', { timeout: 5000 });
    await settled(page);
    await edScroll(page, "bottom");
    await settled(page);
    lines.push(...(await liveTalkLines(page, vp, "長い会話", { agent: 1, owner: 1, pre: 0 })));
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
        talkW: document.querySelector("#ed .c-talk")?.getBoundingClientRect().width ?? null,
      };
    });
    // 結果の文が入るかは席の幅（440〜720）と時刻の字の長さ（日付が付く事が在る。#467）で変わるので、スマホのほかは閉じた形と開いた形のつじつまを見る
    logLines.push(`[v3-${p}] 段 k: 長い会話の .c-talk の幅 ${String(longLook.talkW)}`);
    if (!longLook.older) say("長い会話に「前の会話を読む」が無い");
    if (longLook.tlCont !== 0) say(`.tl に [続ける] が在る（${String(longLook.tlCont)}）`);
    if (longLook.tlKids !== 0 || longLook.tlH === null || longLook.tlH > 0.5) say(`長い会話の .tl が空でない（子 ${String(longLook.tlKids)}・高さ ${String(longLook.tlH)}）`);
    if (longLook.acts !== 1 || !longLook.actLast) say(`[続ける] が最後の返事の行の最後の子に 1 つでない（${longLook.acts} 個・最後の子 ${String(longLook.actLast)}）`);
    if (longLook.busy === "true") say("[続ける] が押す前から待ちの形");
    if (longLook.below === null || longLook.below > 0.5) say(`下端へ送っても [続ける] が見えていない（下端との差 ${String(longLook.below)}）`);
    if (longLook.labelText === null || !longLook.labelText.startsWith("手順の上限で止まりました")) say(`最後の返事の結果の文が手順の上限でない（${String(longLook.labelText)}）`);
    else {
      if (longLook.labelH === null || longLook.labelLh === null || longLook.labelH > longLook.labelLh * 1.5) say(`結果の文が 1 行でない（高さ ${String(longLook.labelH)}）`);
      // スマホは入りきらずに末尾を省く（席は下の 20 で開いた形とのつじつまを見る）
      // 作り物の結果の文（長い会話の最後の返事）は、スマホの幅で入り切らない長さにしてある（余りは 14px ほど）
      if (vp === "phone" && longLook.cut !== true) say("結果の文の末尾が省かれていない（スマホ）");
    }
    if (longLook.timeCut !== false) say(`最後の返事の時刻が切れている（${String(longLook.timeCut)}）`);
    await shot(page, `${p}-b-talk-long`);
    lines.push(...(await page.evaluate(hitProblems, { min: HIT_MIN[vp], scopes: "#ed .c-talk > article.c-msg:last-of-type", targets: "button", toast: false })).map((l) => `段 k の 14 当たり: ${l}`));
    await edScroll(page, "bottom");
    await settled(page);
    // 20. 最後の返事の手順を開くと結果の文を省かずに折り返す（スマホは 2 行以上・広い幅は 1 行）。行の幅は変わらず、閉じると元に戻る
    const footLook = (): Promise<{ rowW: number; limit: number; footH: number; labelH: number; lh: number; cut: boolean; tail: boolean; timeCut: boolean; list: boolean; actLast: boolean } | null> =>
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
        // 行の幅の上限: .c-talk の中身の幅 × .c-msg の max-width（c-talk.css。D4 から幅によらず 100%）
        const talk = last.parentElement;
        const tcs = talk === null ? null : getComputedStyle(talk);
        const inner = talk === null || tcs === null ? 0 : talk.clientWidth - parseFloat(tcs.paddingLeft) - parseFloat(tcs.paddingRight);
        return {
          rowW: last.getBoundingClientRect().width,
          limit: inner,
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
    /** 閉じた形で省かれているなら、その行の幅が上限に達している（行の箱が狭すぎて省く退行を見る） */
    const fullWhenCut = (look: { cut: boolean; rowW: number; limit: number }, at: string): void => {
      if (look.cut && look.rowW < look.limit - 1) say(`結果の文が、行の幅に余りが在るのに省かれている（${at}。行 ${look.rowW.toFixed(1)}・上限 ${look.limit.toFixed(1)}）`);
    };
    const closed = await footLook();
    if (closed === null) say("20. 最後の返事に結果の文のボタンが無い");
    else {
      fullWhenCut(closed, vp === "phone" ? "スマホ" : "席");
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
        // スマホ・閉じた形で省かれていた席は、開くと 2 行以上。省かれていなかった席は開いても 1 行
        const where = vp === "phone" ? "スマホ" : "席";
        if (vp === "phone" || closed.cut) {
          if (!(opened.labelH > opened.lh * 1.5)) say(`20. ${where}で開いた結果の文が 2 行でない（高さ ${opened.labelH.toFixed(1)}）`);
          if (!(opened.footH > 25)) say(`20. ${where}で開いた足の行の高さ ${opened.footH.toFixed(1)}（25 より高いはず）`);
        } else {
          if (opened.labelH > opened.lh * 1.5) say(`20. 席で開いた結果の文が 1 行でない（閉じて省かれていなかった。高さ ${opened.labelH.toFixed(1)}）`);
          if (Math.abs(opened.footH - 24) > 0.5) say(`20. 席で開いた足の行の高さ ${opened.footH.toFixed(1)}（閉じて省かれていなかった。24 のはず）`);
        }
      }
      lines.push(...(await liveTalkLines(page, vp, "長い会話・手順を開いた所", { agent: 1, owner: 1, pre: 0 })));
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
      if (again !== null && again.cut !== closed.cut) say(`20. 閉じた後の省く・省かないが開く前と違う（前 ${closed.cut}・後 ${again.cut}）`);
      if (again !== null) fullWhenCut(again, "閉じ直した所");
      await edScroll(page, "bottom");
      await settled(page);
    }
    // 席が広い（幅 1640・席 720）とき: 省かない・開いて 1 行・足 24・閉じて 24 を見て、1440 に戻す
    if (vp === "pc") {
      try {
        await page.setViewportSize({ width: 1640, height: VIEWPORTS.pc.viewport.height });
        await load(page, `/#/ch/${long}`);
        await page.waitForSelector('#ed .c-talk .c-msg[data-who="agent"]', { timeout: 5000 });
        await settled(page);
        await edScroll(page, "bottom");
        await settled(page);
        const w = await page.evaluate(() => ({
          talkW: document.querySelector("#ed .c-talk")?.getBoundingClientRect().width ?? null,
          cut: (() => {
            const label = [...document.querySelectorAll('#ed .c-talk > .c-msg[data-who="agent"]')].at(-1)?.querySelector(".c-steps-label") ?? null;
            return label === null ? null : label.scrollWidth > label.clientWidth;
          })(),
        }));
        logLines.push(`[v3-${p}] 段 k: 幅 1640 の .c-talk の幅 ${String(w.talkW)}`);
        const wideClosed = await footLook();
        if (wideClosed !== null) fullWhenCut(wideClosed, "幅 1640");
        {
          if (w.cut !== false) say(`結果の文が席が広い（幅 1640）ときに省かれている（.c-talk ${String(w.talkW)}）`);
          await toggleLast();
          await settled(page);
          await edScroll(page, "bottom");
          await settled(page);
          const wideOpen = await footLook();
          if (wideOpen === null) say("20. 幅 1640 で開いた後に結果の文が無い");
          else {
            if (wideOpen.labelH > wideOpen.lh * 1.5) say(`20. 席が広い（幅 1640）ときに開いた結果の文が 1 行でない（高さ ${wideOpen.labelH.toFixed(1)}）`);
            if (Math.abs(wideOpen.footH - 24) > 0.5) say(`20. 席が広い（幅 1640）ときに開いた足の行の高さ ${wideOpen.footH.toFixed(1)}（24 のはず）`);
          }
          await toggleLast();
          await settled(page);
          const wideAgain = await footLook();
          if (wideAgain === null || Math.abs(wideAgain.footH - 24) > 0.5) say(`20. 幅 1640 で閉じた後の足の行の高さ ${wideAgain === null ? "なし" : wideAgain.footH.toFixed(1)}（24 のはず）`);
        }
      } finally {
        await page.setViewportSize(VIEWPORTS.pc.viewport);
        await load(page, `/#/ch/${long}`);
        await page.waitForSelector('#ed .c-talk .c-msg[data-who="agent"]', { timeout: 5000 });
        await settled(page);
        await edScroll(page, "bottom");
        await settled(page);
      }
    }
    // 15. 先頭へ送ると前の行を読み、見ていた行の位置が動かない
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
    if (mark === null || after.top === null || Math.abs(after.top - mark) > 2) say(`前の会話を読んだら見ていた行が動いた（${String(mark)} → ${String(after.top)}）`);

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
      lines.push(...(await withMono(page, () => liveTalkLines(page, vp, "等幅の字・幅 390", { agent: 1, owner: 1, pre: 1 }), "本番の会話")));
      try {
        await page.setViewportSize({ width: 375, height: 812 });
        await settled(page);
        lines.push(
          ...(await withMono(
            page,
            async () => {
              const got = await liveTalkLines(page, vp, "等幅の字・幅 375", { agent: 1, owner: 1, pre: 1 });
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
      const real = await page.evaluate(styles, { root: "#ed .c-talk", sels: LEAK_TALK, props: [...LEAK_PROPS, ...LEAK_TALK_EXTRA] });
      await page.goto("about:blank");
      await page.goto(base + "/static/gallery.html", { waitUntil: "load" });
      await page.waitForSelector('[data-section="talk"] .c-talk', { timeout: 5000 });
      const demo = await page.evaluate(styles, { root: '[data-section="talk"]', sels: LEAK_TALK, props: [...LEAK_PROPS, ...LEAK_TALK_EXTRA] });
      for (const sel of LEAK_TALK) {
        const a = real[sel];
        const b = demo[sel];
        if (!a || !b) {
          say(`漏れ: ${sel} が${!a ? "本番" : "見本"}に無い`);
          continue;
        }
        for (const prop of [...LEAK_PROPS, ...LEAK_TALK_EXTRA]) if (a[prop] !== b[prop]) say(`漏れ: ${sel} の ${prop} が 本番 ${a[prop]} / 見本 ${b[prop]}`);
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

    // 5. 伸びる（2・6・10 行）。一番下を見ていたら、6 行でも最後の行の時刻が入力欄の上に見える。消すと 1 行に戻る
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
        if (seen === null || seen.time > seen.root + 0.5) say(5, "伸びる", `6 行のとき最後の行の時刻の下端 ${seen?.time.toFixed(1) ?? "?"} が入力欄の上端 ${seen?.root.toFixed(1) ?? "?"} より下`);
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
      lines.push(...(await liveTalkLines(page, vp, "段 r の許可", { agent: 1, owner: 1, pre: 0 })));
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
   * 列と項目と帯で字が横にはみ出ない・番の項目の地は --turn-surface で左の線は --warning・開いている番の項目（D3）の地は --turn-surface で左の線は --accent・
   * 右腕の丸（D6）の数・箱・場所・顔と席の入力欄に重ならない事・帯のボタン（丸が在れば 3 つ。data-act）。足りない物の文
   */
  /**
   * スマホの流れの列（D2。ダークのスマホの段 deck の続き。スレッドを開いた所から）: スレッドの間は帯・列・下のバーが見えない・戻ると列で焦点は押した項目（UI-7）・
   * 下のバーと帯の当たり 44・帯の題（今の列の名前と数）が省かれず今の列と同じで帯のボタンに重ならない・下のバーでタスク・通知へ送った所を撮る・通知の列を下へ送って項目を開き戻ると同じ列と縦の位置・
   * 歯車の板を撮る・#/tasks で読み込むとタスクの列・動きを減らす設定でもバーで切り替わる。足りない物の文
   */
  async function phoneDeck(page: Page, p: string): Promise<string[]> {
    const lines: string[] = [];
    const say = (text: string): void => void lines.push(`スマホの流れの列: ${text}`);
    const PAGE = (id: string): string => `#c-foot-root button[data-act="page"][data-page="${id}"]`;
    const current = (): Promise<{ page: string | null; left: number; at: number }> =>
      page.evaluate(() => {
        const box = document.querySelector<HTMLElement>("#c-deck-root .c-deck");
        const id = document.querySelector('#c-foot-root [aria-current="true"]')?.getAttribute("data-page") ?? null;
        const col = id === null ? null : [...document.querySelectorAll<HTMLElement>("#c-deck-root .c-deck > .c-col")].find((c) => c.dataset.col === id);
        return {
          page: id,
          left: box?.scrollLeft ?? -1,
          at: box === null || col === undefined || col === null ? -2 : box.scrollLeft + col.getBoundingClientRect().left - box.getBoundingClientRect().left,
        };
      });
    // スレッドの間は帯・列・下のバーが見えない（場所は残す）
    const hidden = await page.evaluate(() => ["#v3-band", "#v3-deck", "#v3-foot"].map((sel) => (document.querySelector(sel) === null ? "無い" : getComputedStyle(document.querySelector(sel)!).visibility)));
    if (hidden.some((v) => v !== "hidden")) say(`スレッドの間の帯・列・下のバーが ${hidden.join("・")}（hidden のはず）`);
    // 戻ると列。焦点は押した項目
    await page.evaluate(() => history.back());
    await page.waitForSelector('#v3[data-view="list"]', { timeout: 5000 });
    await settled(page);
    if (!(await activeIs(page, '#c-deck-root .c-col[data-col="turn"] .c-item[data-turn="true"] button.c-item-main'))) say("スレッドから戻った後の焦点が押した項目に無い");
    // 当たり 44・帯の名前
    for (const line of await page.evaluate(hitProblems, { min: 44, scopes: "#c-foot-root, #c-band-root", targets: "button", toast: false })) say(line);
    const name = await page.evaluate(() => {
      const el = document.querySelector<HTMLElement>("#c-band-root .c-band-name .c-band-title");
      return el === null ? null : { text: (el.textContent ?? "").trim(), cut: el.scrollWidth > el.clientWidth };
    });
    if (name === null || name.text !== "あなたの番" || name.cut) say(`帯の題「あなたの番」が省かれる・無い（${JSON.stringify(name)}）`);
    for (const line of bandTitleProblems(await page.evaluate(bandTitleState), "スレッドから戻った後の帯")) say(line);
    // 下のバーで送った所
    for (const id of ["tasks", "feed"] as const) {
      await page.click(PAGE(id));
      await settled(page);
      const c = await current();
      if (c.page !== id || Math.abs(c.left - c.at) > 1) say(`${id} を押した後の今の列 ${String(c.page)}・位置 ${c.left}（列の左端 ${c.at} のはず）`);
      const t = await page.evaluate(bandTitleState);
      if (t.page !== id) say(`${id} を押した後の帯の今の列が ${String(t.page)}`);
      for (const line of bandTitleProblems(t, `${id} を押した後の帯`)) say(line);
      await shot(page, `${p}-a-deck-${id}`);
    }
    // 通知の列を下へ送って項目を開き、戻ると同じ列・同じ縦の位置
    const FEED = '#c-deck-root .c-col[data-col="feed"]';
    const top = await page.evaluate((sel: string) => {
      const body = document.querySelector<HTMLElement>(`${sel} .c-col-body`);
      if (body === null) return -1;
      body.scrollTop = Math.min(120, body.scrollHeight - body.clientHeight);
      return body.scrollTop;
    }, FEED);
    const item = page.locator(`${FEED} .c-item button.c-item-main`).last();
    if ((await item.count()) === 0) say("通知の列に開ける項目が無い（戻った後の縦の位置を確かめられない）");
    else {
      await item.click();
      await page.waitForSelector('#v3[data-view="body"]', { timeout: 5000 });
      await settled(page);
      await page.evaluate(() => history.back());
      await page.waitForSelector('#v3[data-view="list"]', { timeout: 5000 });
      await settled(page);
      const c = await current();
      const after = await page.evaluate((sel: string) => document.querySelector<HTMLElement>(`${sel} .c-col-body`)?.scrollTop ?? -1, FEED);
      if (c.page !== "feed" || Math.abs(c.left - c.at) > 1) say(`通知の列から開いて戻った後の今の列 ${String(c.page)}・位置 ${c.left}`);
      if (Math.abs(after - top) > 1) say(`通知の列から開いて戻った後の縦の位置 ${after}（${top} のはず）`);
    }
    // 歯車の板
    await page.click(bandButton("more"));
    await page.waitForSelector("#v3-sheet[open]", { timeout: 5000 });
    await settled(page);
    await shot(page, `${p}-a-deck-more`);
    await page.click("#v3-sheet button.sheet-close");
    await page.waitForSelector("#v3-sheet:not([open])", { state: "attached", timeout: 5000 });
    await settled(page);
    // 古い hash: #/tasks で読み込むとタスクの列（hash は消える）
    await load(page, "/#/tasks");
    await page.waitForSelector("#c-foot-root .c-bottom", { timeout: 5000 });
    await settled(page);
    const old = { ...(await current()), hash: await page.evaluate(() => location.hash), view: await page.getAttribute("#v3", "data-view") };
    if (old.page !== "tasks" || Math.abs(old.left - old.at) > 1 || old.hash !== "" || old.view !== "list") say(`#/tasks で読み込んだ後が ${JSON.stringify(old)}（タスクの列・hash なし・列のはず）`);
    // 動きを減らす設定でもバーで切り替わる（絵なし）
    await page.emulateMedia({ reducedMotion: "reduce" });
    try {
      await page.click(PAGE("feed"));
      await settled(page);
      const c = await current();
      if (c.page !== "feed" || Math.abs(c.left - c.at) > 1) say(`動きを減らす設定で通知を押した後の今の列 ${String(c.page)}・位置 ${c.left}（列の左端 ${c.at} のはず）`);
    } finally {
      await page.emulateMedia({ reducedMotion: null });
    }
    return lines;
  }

  /**
   * 作り物のデータの印の無い・完了でない ch: の話題（#tasks（pinned）は除く）の題。activityAt の新しい順（#505）。
   * 始めは「RSS」「CSV の書き出し」（IDLE_UNREAD）が未読で通知の列にあり、前の段で開くと既読になって待機に移る（作り物のサーバーは組をまたいで 1 つ）
   */
  const IDLE_ALL = ["吹き出しの確かめ", "引っ越しの段取り", "週末の買い物", "RSS", "記事の下書き", "ファームウェアの更新手順を README に書く。古い手順は消して、写真も撮り直す前提で", "カテゴリの色", "CSV の書き出し", "月ごとの集計がずれる"];
  const IDLE_UNREAD = ["RSS", "CSV の書き出し"];
  /** 待機の節に出す数（c-deck.js の IDLE_MAX） */
  const IDLE_SHOWN = 8;

  /**
   * あなたの番の列の待機の節（#505。段 deck の a-deck を撮る前。絵に残る物は変えない）: 節の見出しが上から「動いている」「待機」・待機の項目の題が作り物のデータの既読の待機の話題と同じ並び・
   * ［ほか n 件］は 8 件を越えたときだけ・同じ題が通知の列に無い。足りない物の文
   */
  async function idleListLines(page: Page): Promise<string[]> {
    const lines: string[] = [];
    const say = (text: string): void => void lines.push(`流れの列（待機）: ${text}`);
    const seen = await page.evaluate(() => {
      const turn = document.querySelector('#c-deck-root .c-col[data-col="turn"]');
      const feed = document.querySelector('#c-deck-root .c-col[data-col="feed"]');
      const texts = (root: Element | null, sel: string): string[] => (root === null ? [] : [...root.querySelectorAll(sel)].map((el) => (el.textContent ?? "").trim()));
      return {
        labels: texts(turn, ".c-col-label"),
        idle: texts(turn, '.c-item[data-kind="idle"] .c-item-title'),
        more: texts(turn, "button.c-col-more"),
        feed: texts(feed, ".c-item .c-item-title"),
      };
    });
    if (JSON.stringify(seen.labels) !== JSON.stringify(["動いている", "待機"])) say(`あなたの番の列の節の見出しが「${seen.labels.join("・")}」（動いている・待機 のはず）`);
    // 既読の物（始めから既読の 7 つと、通知の列に無い IDLE_UNREAD）が新しい順に IDLE_SHOWN 件まで。残りは［ほか n 件］
    const want = IDLE_ALL.filter((t) => !IDLE_UNREAD.includes(t) || !seen.feed.includes(t));
    const shown = want.slice(0, IDLE_SHOWN);
    if (JSON.stringify(seen.idle) !== JSON.stringify(shown)) say(`待機の項目の題が「${seen.idle.join("・")}」（${shown.join("・")} のはず）`);
    const rest = want.length - shown.length;
    const moreWant = rest > 0 ? [`ほか ${rest} 件`] : [];
    if (JSON.stringify(seen.more) !== JSON.stringify(moreWant)) say(`［ほか n 件］が「${seen.more.join(",")}」（${rest > 0 ? moreWant[0] : "無い"} のはず）`);
    const both = seen.idle.filter((t) => seen.feed.includes(t));
    if (both.length > 0) say(`通知の列にも出ている題「${both.join("・")}」（1 つの話題は 1 か所のはず）`);
    return lines;
  }

  /** 待機の項目を 1 つ押すと席（スマホはスレッド）の見出しの題がその話題（#505。段 deck の最後。スマホは列に戻り、下のバーであなたの番の列へ送ってから）。足りない物の文 */
  async function idleOpenLines(page: Page, vp: Viewport): Promise<string[]> {
    const lines: string[] = [];
    const say = (text: string): void => void lines.push(`流れの列（待機を開く）: ${text}`);
    if (vp === "phone") {
      // スレッドを開いたまま（ライトのスマホ）なら列へ戻る
      if ((await page.getAttribute("#v3", "data-view")) !== "list") {
        await page.evaluate(() => history.back());
        await page.waitForSelector('#v3[data-view="list"]', { timeout: 5000 });
        await settled(page);
      }
      await page.click('#c-foot-root button[data-act="page"][data-page="turn"]');
      await settled(page);
    }
    const idle = page.locator('#c-deck-root .c-col[data-col="turn"] .c-item[data-kind="idle"] button.c-item-main').first();
    if ((await idle.count()) === 0) {
      say("待機の項目が無い");
      return lines;
    }
    const want = ((await idle.locator(".c-item-title").textContent()) ?? "").trim();
    await idle.click();
    await page.waitForSelector('#v3[data-view="body"] #ed textarea', { timeout: 5000 });
    await page.waitForFunction((t: string) => (document.querySelector("#c-top-root .c-top-title")?.textContent ?? "").trim() === t, want, { timeout: 5000 }).catch(() => undefined);
    await settled(page);
    const now = await page.evaluate(() => (document.querySelector("#c-top-root .c-top-title")?.textContent ?? "").trim());
    if (now !== want) say(`待機の「${want}」を押した後の見出しの題が「${now}」`);
    return lines;
  }

  /**
   * 広い幅の列だけの画面の右腕の丸（D6。段 deck の続き。a-deck を撮った後で、絵に残る物は変えない）: 右端の見える列を一番下まで送ると最後の項目の下端が丸の上端より上
   * （送りは元に戻す）・知らせを 1 つ出すと丸の箱と重ならない（消して戻す）。足りない物の文
   */
  async function orbListLines(page: Page): Promise<string[]> {
    const lines: string[] = [];
    const say = (text: string): void => void lines.push(`右腕の丸（列）: ${text}`);
    const tail = await page.evaluate((orbSel: string) => {
      const orb = document.querySelector(orbSel)?.getBoundingClientRect();
      const deck = document.querySelector("#c-deck-root .c-deck")?.getBoundingClientRect();
      if (orb === undefined || deck === undefined) return null;
      const shown = [...document.querySelectorAll<HTMLElement>("#c-deck-root .c-deck > .c-col")].filter((c) => {
        const r = c.getBoundingClientRect();
        return r.width > 0 && r.left >= deck.left - 0.5 && r.right <= deck.right + 0.5;
      });
      const col = shown.at(-1);
      const body = col?.querySelector<HTMLElement>(".c-col-body");
      if (col === undefined || body === undefined || body === null) return null;
      const before = body.scrollTop;
      // 作り物のデータは列があふれない（送れない）ので、この検査の間だけ最後の項目の写しを列の末尾に足してあふれさせる（測ったら消す。絵には残らない）
      const seed = [...body.querySelectorAll<HTMLElement>(".c-item")].at(-1);
      const added: HTMLElement[] = [];
      let last: number | null = null;
      let over = false;
      try {
        if (seed !== undefined) {
          while (body.scrollHeight <= body.clientHeight && added.length < 80) {
            const copy = seed.cloneNode(true) as HTMLElement;
            body.append(copy);
            added.push(copy);
          }
        }
        over = body.scrollHeight > body.clientHeight;
        body.scrollTop = body.scrollHeight;
        last = [...body.querySelectorAll<HTMLElement>(".c-item")].at(-1)?.getBoundingClientRect().bottom ?? null;
      } finally {
        for (const copy of added) copy.remove();
        body.scrollTop = before;
      }
      return { col: col.dataset.col ?? "", last, over, orbTop: orb.top };
    }, ORB);
    if (tail === null) say("丸か右端の列を測れない");
    else if (tail.last === null) say(`右端の列（${tail.col}）に項目が無い`);
    else if (!tail.over) say(`右端の列（${tail.col}）をあふれさせられない（最後の項目と丸の上下を確かめられない）`);
    else if (!(tail.last < tail.orbTop)) say(`右端の列（${tail.col}）を一番下まで送った最後の項目の下端 ${tail.last.toFixed(1)} が丸の上端 ${tail.orbTop.toFixed(1)} より上でない`);
    // 知らせ（トースト）と重ならない
    const ITEM = "#c-notice-root .c-toast-item";
    await page.evaluate((text: string) => (window as unknown as { SA: { ui: { toast: (t: string) => void } } }).SA.ui.toast(text), "送るのをやめました");
    await page.waitForSelector(ITEM, { timeout: 5000 }).catch(() => undefined);
    const overlap = await page.evaluate(
      ({ orbSel, item }: { orbSel: string; item: string }) => {
        const r = document.querySelector(orbSel)?.getBoundingClientRect();
        const toasts = [...document.querySelectorAll(item)].map((el) => el.getBoundingClientRect());
        if (r === undefined || toasts.length === 0) return null;
        return toasts.some((b) => r.left < b.right && b.left < r.right && r.top < b.bottom && b.top < r.bottom);
      },
      { orbSel: ORB, item: ITEM },
    );
    if (overlap === null) say("丸か知らせが無い");
    else if (overlap) say("知らせの箱が丸の箱と重なる");
    await page.evaluate((item: string) => {
      for (const b of document.querySelectorAll<HTMLButtonElement>(item + ' button[aria-label="閉じる"]')) b.click();
    }, ITEM);
    await page.waitForFunction((item: string) => document.querySelector(item) === null, ITEM, { timeout: 5000 }).catch(() => say("知らせが消えない"));
    await settled(page);
    return lines;
  }

  async function deckLines(page: Page, vp: Viewport, label: string): Promise<string[]> {
    return page.evaluate(
      ({ label, width, phone, orbSel }: { label: string; width: number; phone: boolean; orbSel: string }) => {
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
        if (phone) {
          // スマホ（D2）: 1 列ずつ全幅（420 の上限を当てない）。席（スレッド）は列の上に重ねるので deckFit を使わない。文書が横にはみ出さない
          if (want !== 1 || v3.getAttribute("data-seat") !== "full") say(`data-deck ${want}・data-seat ${String(v3.getAttribute("data-seat"))}（1・full のはず）`);
          if (deck.getAttribute("data-paged") !== "true") say(".c-deck に data-paged が無い");
          for (const c of shown) if (Math.abs(c.getBoundingClientRect().width - width) > 0.5) say(`列 ${c.dataset.col} の幅 ${c.getBoundingClientRect().width.toFixed(1)}（画面の幅 ${width} のはず）`);
          if (document.documentElement.scrollWidth > window.innerWidth) say(`文書が横にはみ出る（${document.documentElement.scrollWidth}）`);
        } else {
          for (const c of shown) if (c.getBoundingClientRect().width > 420.5) say(`列 ${c.dataset.col} の幅 ${c.getBoundingClientRect().width.toFixed(1)}（420 以下のはず）`);
          const main = document.querySelector<HTMLElement>("#v3-main");
          const seat = main === null || !seatOpen ? 0 : main.getBoundingClientRect().width;
          const fit = (window as unknown as { SA: { deck: { fit: (w: number, open: boolean) => { cols: number; seat: number } } } }).SA.deck.fit(v3.clientWidth, seatOpen);
          if (fit.cols !== want) say(`deckFit の列 ${fit.cols}・data-deck ${want}`);
          if (Math.abs(seat - fit.seat) > 1) say(`席の幅 ${seat.toFixed(1)}（deckFit では ${fit.seat}）`);
        }
        // はみ出る字（列・項目・帯）
        for (const sel of [".c-deck", ".c-col", ".c-col-head", ".c-item", ".c-item-main", ".c-band", ".c-band-ops"]) {
          for (const el of document.querySelectorAll<HTMLElement>(`:is(#c-deck-root, #c-band-root) ${sel}`)) {
            if (el.getClientRects().length === 0 || el.matches(".c-deck")) continue;
            if (el.scrollWidth > el.clientWidth + 0.5) say(`${sel}「${(el.textContent ?? "").trim().slice(0, 20)}」がはみ出る 幅 ${el.clientWidth} 要る幅 ${el.scrollWidth}`);
          }
        }
        // 列の見出し: スマホは場所を取らない（名前と数は帯の題）、640 以上は見える列の見出しが見える
        for (const c of phone ? cols : shown) {
          const h = c.querySelector<HTMLElement>(":scope > .c-col-head")?.getBoundingClientRect().height ?? -1;
          if (phone ? h !== 0 : h <= 0) say(`列 ${c.dataset.col} の見出しの高さ ${h}（${phone ? "0" : "0 より大きい"} のはず）`);
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
        const accent = colorOf("--accent");
        probe.remove();
        const turns = [...deck.querySelectorAll<HTMLElement>('.c-item[data-turn="true"]')].filter((el) => el.dataset.current !== "true");
        if (turns.length === 0) say("番の項目が無い");
        for (const el of turns) {
          const cs = getComputedStyle(el);
          if (cs.backgroundColor !== turnSurface) say(`番の項目の地 ${cs.backgroundColor}（--turn-surface ${turnSurface} のはず）`);
          if (cs.borderLeftColor !== warning || cs.borderLeftWidth !== "3px") say(`番の項目の左の線 ${cs.borderLeftWidth} ${cs.borderLeftColor}（3px ${warning} のはず）`);
        }
        // 開いている番の項目（D3）: 地は番の面のまま、線は開いている印の --accent。席を開いた所では 1 つ在る
        const openTurns = [...deck.querySelectorAll<HTMLElement>('.c-item[data-turn="true"][data-current="true"]')];
        if (seatOpen && openTurns.length !== 1) say(`開いている番の項目が ${openTurns.length} 個（1 個のはず）`);
        for (const el of openTurns) {
          const cs = getComputedStyle(el);
          if (cs.backgroundColor !== turnSurface) say(`開いている番の項目の地 ${cs.backgroundColor}（--turn-surface ${turnSurface} のはず）`);
          if (cs.borderLeftColor !== accent || cs.borderLeftWidth !== "3px") say(`開いている番の項目の左の線 ${cs.borderLeftWidth} ${cs.borderLeftColor}（3px ${accent} のはず）`);
        }
        // 右腕の丸（D6）: スマホと席だけの幅（data-deck 0）には無く、ほかは 1 つ。56 の円。列だけの間は画面の右下（右・下から 16）で accent の顔、
        // 席が開いている間は席のすぐ左の下（席の左端から 8 + 16・下から 16）で静かな顔、席の入力欄・［送る］と重ならない
        const orbs = [...document.querySelectorAll<HTMLElement>(orbSel)];
        const orbWant = phone || want === 0 ? 0 : 1;
        if (orbs.length !== orbWant) say(`右腕の丸が ${orbs.length} 個（${orbWant} 個のはず）`);
        const orb = orbs[0];
        if (orbWant === 1 && orb !== undefined) {
          const r = orb.getBoundingClientRect();
          const near = (a: number, b: number): boolean => Math.abs(a - b) <= 0.5;
          if (!near(r.width, 56) || !near(r.height, 56)) say(`右腕の丸の箱 ${r.width.toFixed(1)}x${r.height.toFixed(1)}（56x56 のはず）`);
          if (!near(window.innerHeight - r.bottom, 16)) say(`右腕の丸の下端から画面の下端まで ${(window.innerHeight - r.bottom).toFixed(1)}（16 のはず）`);
          const tone = orb.getAttribute("data-tone");
          if (tone !== (seatOpen ? "quiet" : "accent")) say(`右腕の丸の顔が ${String(tone)}（${seatOpen ? "quiet" : "accent"} のはず）`);
          if (!seatOpen) {
            if (!near(window.innerWidth - r.right, 16)) say(`右腕の丸の右端から画面の右端まで ${(window.innerWidth - r.right).toFixed(1)}（16 のはず）`);
          } else {
            const seatBox = document.querySelector("#v3-main")?.getBoundingClientRect();
            if (seatBox === undefined) say("席（#v3-main）が無い");
            else {
              if (!(r.right < seatBox.left)) say(`右腕の丸の右端 ${r.right.toFixed(1)} が席の左端 ${seatBox.left.toFixed(1)} より左でない`);
              if (!near(seatBox.left - r.right, 24)) say(`右腕の丸の右端から席の左端まで ${(seatBox.left - r.right).toFixed(1)}（8 + 16 のはず）`);
            }
            for (const sel of ["#v3-main .c-composer", "#v3-main .c-composer-input", "#v3-main .c-composer button"]) {
              for (const el of document.querySelectorAll(sel)) {
                const b = el.getBoundingClientRect();
                if (b.width === 0 || b.height === 0) continue;
                if (r.left < b.right && b.left < r.right && r.top < b.bottom && b.top < r.bottom) say(`右腕の丸の箱が ${sel} の箱と重なる`);
              }
            }
          }
        }
        // 帯のボタン（丸が在る間は［右腕］を出さない。スマホは丸が無くても出さない）
        const acts = [...document.querySelectorAll("#c-band-root .c-band-ops [data-act]")].map((el) => el.getAttribute("data-act"));
        const withHand = !phone && orbs.length === 0;
        const wantActs = withHand ? ["find", "hand", "start", "more"] : ["find", "start", "more"];
        if (JSON.stringify(acts) !== JSON.stringify(wantActs)) say(`帯のボタンが ${acts.join("・")}（${withHand ? "探す・右腕・始める・ほか" : "探す・始める・ほか"} のはず）`);
        return out;
      },
      { label, width: VIEWPORTS[vp].viewport.width, phone: vp === "phone", orbSel: ORB },
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
        // 流れの列（pc・tablet）は「探す」の板を開いた所
        await loadList(page);
        await shot(page, `${p}-a-list`);
        // 一覧の列の検査（ダークの組だけ）。全部を測ってから、1 つでもあれば段を失敗にする
        if (theme !== "dark") return;
        // 当たりは一覧と一覧の下のバー（#v3-list の中）。スマホの列の下のバー（#c-foot-root）は「探す」の板の幕の下なので、板を閉じた所で測る（checkFootBar・phoneDeck）
        const problems = [...(await checkParts(page, vp, [".c-list", "#v3-list .c-bottom"])), ...(await checkList(page, vp)), ...(await checkBar(page, vp, p))];
        if (vp !== "tablet") problems.push(...(await checkLeaks(page, vp)));
        problems.push(...(await checkWidths(page, vp, mono)));
        // 群・番の行の間は余白だけ（D3）: 上下の枠が 0px（「探す」の板の下端に次の群の上の線が覗かない）
        problems.push(
          ...(await page.evaluate(() =>
            [...document.querySelectorAll<HTMLElement>("#v3-list .c-group, #v3-list .c-turn")]
              .map((el) => ({ el, cs: getComputedStyle(el) }))
              .filter(({ cs }) => cs.borderTopWidth !== "0px" || cs.borderBottomWidth !== "0px")
              .map(({ el, cs }) => `一覧の ${el.className}「${(el.getAttribute("aria-label") ?? el.textContent ?? "").trim().slice(0, 12)}」の上下の線 ${cs.borderTopWidth} ${cs.borderBottomWidth}（0px のはず）`),
          )),
        );
        if (await page.evaluate(() => document.querySelectorAll("#v3-list .c-group").length === 0)) problems.push("一覧に群が無い（群の間の線を確かめられない）");
        // 番の行（.c-turn）を描くのはスマホの形（広い幅は件数のボタンだけ）。スマホで 0 個なら上の検査が空振りしている
        if (vp === "phone" && (await page.evaluate(() => document.querySelectorAll("#v3-list .c-turn").length === 0))) problems.push("一覧に番の行が無い（番の行の間の線を確かめられない）");
        // 絞り込み欄の箱の左端は一覧の列の左から 16（スマホ・PC。流れの列は「探す」の板を開くと絞り込み欄が出ている）
        if (vp !== "tablet") {
          const deck = await deckOn(page);
          if (deck) await openFind(page);
          else await page.click("#v3-search-toggle");
          await page.waitForSelector("#v3-search", { timeout: 5000 });
          const left = await page.evaluate(() => {
            const input = document.querySelector("#v3-search");
            const list = document.querySelector("#v3-list");
            return input === null || list === null ? null : input.getBoundingClientRect().left - list.getBoundingClientRect().left;
          });
          if (left === null || Math.abs(left - 16) > 0.5) problems.push(`絞り込み欄の左端が ${String(left)}（16 のはず）`);
          if (!deck) {
            await page.click("#v3-search-toggle");
            await settled(page);
          }
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
      // 流れの列（D1。スマホは D2）: 列の数と幅・はみ出し・番の項目の面と線・帯のボタン。項目から席（スマホはスレッド）を開いて、列と席の幅・開いた項目の印（D3 から開いている番の項目の地と線も）・席の面（D3。席と席の中（#ed）の地と台の色・見出しと入力欄の帯の線・欄の地）・列と席の accent の塗りの量（D3）。
      // ダークのスマホは続けて、スレッドの間の帯とバー・戻る・当たり・帯の名前・下のバーで送った列・通知の列の縦の位置・歯車の板・古い hash・動きを減らす設定（phoneDeck）
      {
        const deckShots = [`${p}-a-deck`, `${p}-a-deck-seat`, ...(vp === "phone" && theme === "dark" ? [`${p}-a-deck-tasks`, `${p}-a-deck-feed`, `${p}-a-deck-more`] : [])];
        await step(`${p} deck`, deckShots, async () => {
          await load(page, "/");
          await page.waitForSelector("#v3[data-deck] #c-deck-root .c-deck .c-col", { timeout: 5000 });
          await settled(page);
          const problems: string[] = [...(await deckLines(page, vp, "列"))];
          // スマホの列は下のバーの右腕、広い幅の列は右腕の丸（D6）が accent の塗り（1 つは数える）
          problems.push(...(await page.evaluate(accentProblems, { label: "列", areaMax: ACCENT_AREA_MAX, bigMax: ACCENT_BIG_MAX, min: 1 })));
          // スマホの帯の題は今の列（あなたの番）の名前と数で、帯のボタンに重ならない
          if (vp === "phone") problems.push(...bandTitleProblems(await page.evaluate(bandTitleState), `スマホの帯（${theme}）`).map((l) => `流れの列: ${l}`));
          // あなたの番の列の待機の節（#505）
          problems.push(...(await idleListLines(page)));
          await shot(page, `${p}-a-deck`);
          // 広い幅の右腕の丸（D6）: 列の最後の項目と知らせに重ならない
          if (vp !== "phone") problems.push(...(await orbListLines(page)));
          const opener = page.locator('#c-deck-root .c-col[data-col="turn"] .c-item[data-turn="true"] button.c-item-main').first();
          const openerBox = await opener.boundingBox();
          await opener.click();
          await page.waitForSelector('#v3[data-view="body"] #ed textarea', { timeout: 5000 });
          await settled(page);
          // 開いている番の項目の地（D3）は、押した後の指の hover（--muted）を外して測る。撮る前に指を押した所へ戻す（絵は今までと同じ状態）
          await page.mouse.move(0, 0);
          problems.push(...(await deckLines(page, vp, "席")));
          // 席は 1 枚の板（D3 の PR-1）: 席の地は --surface・台は地（--bg）・見出しの下と入力欄の帯の上に線が無い・欄の地は --muted
          problems.push(
            ...(await page.evaluate(() => {
              const out: string[] = [];
              const say = (text: string): void => void out.push(`流れの列（席の面）: ${text}`);
              const probe = document.createElement("span");
              document.body.append(probe);
              const colorOf = (v: string): string => {
                probe.style.color = `var(${v})`;
                return getComputedStyle(probe).color;
              };
              const want = { surface: colorOf("--surface"), ground: colorOf("--bg"), muted: colorOf("--muted") };
              probe.remove();
              const cs = (sel: string): CSSStyleDeclaration | null => {
                const el = document.querySelector(sel);
                return el === null ? null : getComputedStyle(el);
              };
              const main = cs("#v3-main");
              const shell = cs("#v3");
              const ed = cs("#ed");
              const top = cs("#v3-main .c-top");
              const composer = cs("#v3-main .c-composer");
              const input = cs("#v3-main .c-composer-input");
              if (main === null || ed === null || shell === null || top === null || composer === null || input === null) {
                say(`席・席の中・殻・見出し・入力欄の帯・欄のどれかが無い（${[main, ed, shell, top, composer, input].map((x) => (x === null ? "無" : "在")).join("・")}）`);
                return out;
              }
              if (main.backgroundColor !== want.surface) say(`席の地 ${main.backgroundColor}（--surface ${want.surface} のはず）`);
              if (ed.backgroundColor !== want.surface) say(`席の中（#ed）の地 ${ed.backgroundColor}（--surface ${want.surface} のはず）`);
              if (shell.backgroundColor !== want.ground) say(`台の地 ${shell.backgroundColor}（--bg ${want.ground} のはず）`);
              if (top.boxShadow !== "none") say(`見出しの影 ${top.boxShadow}（none のはず）`);
              if (composer.borderTopWidth !== "0px") say(`入力欄の帯の上の線 ${composer.borderTopWidth}（0px のはず）`);
              if (input.backgroundColor !== want.muted) say(`欄の地 ${input.backgroundColor}（--muted ${want.muted} のはず）`);
              return out;
            })),
          );
          const current = await page.evaluate(() => document.querySelectorAll('#c-deck-root .c-item[data-current="true"] > button.c-item-main[aria-current="true"]').length);
          if (current !== 1) problems.push(`流れの列（席）: 開いた項目の印（aria-current）が ${current} 個（1 個のはず）`);
          problems.push(...(await page.evaluate(accentProblems, { label: "席", areaMax: ACCENT_AREA_MAX, bigMax: ACCENT_BIG_MAX })));
          if (openerBox !== null) await page.mouse.move(openerBox.x + openerBox.width / 2, openerBox.y + openerBox.height / 2);
          await shot(page, `${p}-a-deck-seat`);
          if (vp === "phone" && theme === "dark") problems.push(...(await phoneDeck(page, p)));
          // 待機の項目から開く（#505。絵を撮った後）
          problems.push(...(await idleOpenLines(page, vp)));
          for (const line of problems) logLines.push(`[v3-${p}] ${line}`);
          if (problems.length > 0) throw new Error(`流れの列の検査で ${problems.length} 件`);
        });
      }
      // あなたの番の列の節「ピン留め」（#507 の P2。ダークのスマホだけ）: 動いている話題（番の無い物）と待機の話題を、それぞれ開いて「…」→「ピン留めする」で留め、列へ戻る。
      // 知らせ「ピン留めした」・節の見出しが上から「ピン留め」「動いている」「待機」（項目の残る物だけ）・節の項目が留めた 2 つで留めた順・同じ題が「動いている」「待機」に無い・
      // 下のバーの あなたの番 の数が留める前と同じ・節の項目を押すと全面でその話題が開く。撮った後に 2 つとも「ピン留めを外す」で外し、元の節に戻った事を見る（後の段に留めた物を残さない）
      if (vp === "phone" && theme === "dark") {
        await step(`${p} pins`, [`${p}-a-deck-pins`], async () => {
          const TURN = '#c-deck-root .c-col[data-col="turn"]';
          const problems: string[] = [];
          const say = (text: string): void => void problems.push(`節「ピン留め」: ${text}`);
          const seen = (): Promise<{ labels: string[]; pin: string[]; running: string[]; idle: string[]; bar: string }> =>
            page.evaluate((sel: string) => {
              const col = document.querySelector(sel);
              const texts = (q: string): string[] => (col === null ? [] : [...col.querySelectorAll(q)].map((el) => (el.textContent ?? "").trim()));
              return {
                labels: texts(".c-col-label"),
                pin: texts('.c-item[data-kind="pin"] .c-item-title'),
                running: texts('.c-item[data-kind="running"] .c-item-title'),
                idle: texts('.c-item[data-kind="idle"] .c-item-title'),
                bar: (document.querySelector('#c-foot-root button[data-page="turn"] .c-badge')?.textContent ?? "").trim(),
              };
            }, TURN);
          /** 列の項目（kind の最初の 1 つか、題が title の物）を押して全面で開き、見出しの題を返す */
          const openItem = async (kind: string, title?: string): Promise<string> => {
            const items = page.locator(`${TURN} .c-item[data-kind="${kind}"]`);
            const item = title === undefined ? items.first() : items.filter({ has: page.locator(".c-item-title", { hasText: title }) }).first();
            if ((await item.count()) === 0) throw new Error(`あなたの番の列に ${kind} の項目${title === undefined ? "" : "「" + title + "」"}が無い`);
            const want = ((await item.locator(".c-item-title").textContent()) ?? "").trim();
            await item.locator("button.c-item-main").click();
            await page.waitForSelector('#v3[data-view="body"] #ed textarea', { timeout: 5000 });
            await page.waitForFunction((t: string) => (document.querySelector("#c-top-root .c-top-title")?.textContent ?? "").trim() === t, want, { timeout: 5000 }).catch(() => undefined);
            await settled(page);
            const now = await page.evaluate(() => (document.querySelector("#c-top-root .c-top-title")?.textContent ?? "").trim());
            if (now !== want) say(`「${want}」を押した後の見出しの題が「${now}」`);
            return want;
          };
          /** 開いている話題の「…」→ label を押し、知らせ notice を待って、知らせを閉じて列へ戻る */
          const pinVia = async (label: string, notice: string): Promise<boolean> => {
            await page.click(TOP_MENU);
            await page.waitForSelector("#v3-sheet[open]", { timeout: 5000 });
            const rows = await sheetRows(page);
            if (!rows.includes(label)) {
              say(`「…」の板に「${label}」が無い（${rows.join("・")}）`);
              await escSheet(page);
            } else {
              await page.locator("#v3-sheet .more-row").filter({ hasText: label }).first().click();
              const told = await page.waitForFunction(noticeHas, { role: "status" as const, text: notice }, { timeout: 5000 }).then(() => true, () => false);
              if (!told) say(`「${label}」の後に知らせ「${notice}」が出ない（${await page.evaluate(noticeText, "status" as const)}）`);
              // 知らせは × で閉じる（撮る絵に残さない。部品の DOM を外から外さない）
              await page.evaluate(() => {
                for (const b of document.querySelectorAll<HTMLButtonElement>('#c-notice-root .c-toast-list[role="status"] .c-toast-item button[aria-label="閉じる"]')) b.click();
              });
              await settled(page);
            }
            await page.evaluate(() => history.back());
            await page.waitForSelector('#v3[data-view="list"]', { timeout: 5000 });
            await settled(page);
            return rows.includes(label);
          };
          await load(page, "/");
          await page.waitForSelector(`${TURN} .c-item`, { timeout: 5000 });
          await settled(page);
          const before = await seen();
          if (before.labels.includes("ピン留め") || before.pin.length > 0) throw new Error(`始めから節「ピン留め」が在る（${before.pin.join("・")}）`);
          const pinned: string[] = [];
          try {
            for (const kind of ["running", "idle"] as const) {
              const title = await openItem(kind);
              if (await pinVia("ピン留めする", "ピン留めした")) pinned.push(title);
            }
            const after = await seen();
            const want = ["ピン留め", ...(after.running.length > 0 ? ["動いている"] : []), ...(after.idle.length > 0 ? ["待機"] : [])];
            if (JSON.stringify(after.labels) !== JSON.stringify(want)) say(`節の見出しが「${after.labels.join("・")}」（${want.join("・")} のはず）`);
            if (JSON.stringify(after.pin) !== JSON.stringify(pinned)) say(`節「ピン留め」の項目の題が「${after.pin.join("・")}」（留めた順の ${pinned.join("・")} のはず）`);
            const twice = pinned.filter((t) => after.running.includes(t) || after.idle.includes(t));
            if (twice.length > 0) say(`留めた題「${twice.join("・")}」が「動いている」か「待機」にも出る（1 か所のはず）`);
            if (after.bar !== before.bar) say(`下のバーの あなたの番 の数が「${after.bar}」（留める前の「${before.bar}」のはず）`);
            await shot(page, `${p}-a-deck-pins`);
            // 節の項目を押すと全面でその話題（openItem が題を確かめる）
            if (pinned.length > 0) {
              await openItem("pin", pinned[0]);
              await page.evaluate(() => history.back());
              await page.waitForSelector('#v3[data-view="list"]', { timeout: 5000 });
              await settled(page);
            }
          } finally {
            // 片付け: 2 つとも節の項目から開いて「ピン留めを外す」
            let thrown: unknown = null;
            try {
              for (const title of [...pinned]) {
                await openItem("pin", title);
                if (await pinVia("ピン留めを外す", "ピン留めを外した")) pinned.splice(pinned.indexOf(title), 1);
              }
            } catch (error) {
              thrown = error;
            }
            // 掃除（画面から外せなかった時も、後の段に留めた物を残さない）: サーバーの pins を全部外す
            const swept = await page
              .evaluate(async () => {
                const headers = { "X-Self-Agent": "1", "Content-Type": "application/json" };
                const res = await fetch("/api/topics", { headers: { "X-Self-Agent": "1" }, credentials: "same-origin", cache: "no-store" });
                const body = (await res.json()) as { pins?: unknown };
                const ids = Array.isArray(body.pins) ? body.pins.filter((id): id is string => typeof id === "string") : [];
                for (const id of ids) await fetch("/api/topics/ch:" + id + "/pin", { method: "POST", headers, credentials: "same-origin", body: JSON.stringify({ on: false }) });
                return ids.length;
              })
              .catch(() => -1);
            if (swept !== 0 && thrown === null) say(swept < 0 ? "掃除の読み取り・外しに失敗" : `画面から外した後もサーバーに留めた物が ${swept} 個残っていた（掃除で外した）`);
            if (thrown !== null) throw thrown;
          }
          if (pinned.length > 0) throw new Error(`外せなかった話題が ${pinned.length} 個（後の段に残る）`);
          const end = await seen();
          if (end.labels.includes("ピン留め") || end.pin.length > 0) say(`外した後も節「ピン留め」が在る（${end.pin.join("・")}）`);
          if (JSON.stringify(end.running) !== JSON.stringify(before.running) || JSON.stringify(end.idle) !== JSON.stringify(before.idle))
            say(`外した後の「動いている」「待機」が「${end.running.join("・")}」「${end.idle.join("・")}」（留める前の「${before.running.join("・")}」「${before.idle.join("・")}」のはず）`);
          for (const line of problems) logLines.push(`[v3-${p}] ${line}`);
          if (problems.length > 0) throw new Error(`節「ピン留め」の検査で ${problems.length} 件`);
        });
      }
      // 帯と会話の列（#507 の P4。ダークの PC だけ）: 待機・動いている話題（番の無い・既読の物）の 2 つを、席の見出しのピンのボタンと「…」の「ピン留めする」で留め、帯の左端と右端まで送った所を撮る。
      // 絵にしない DOM の確かめ: 留めた数 0 の #v3 の属性と格子・列の数と幅（300・420）・帯の幅（stripFit の room と 1px 以内）と scrollWidth・丸が列に重ならない・送りを止めると列の左端（末尾は右端）で止まる・
      // 止まった後の shownChannelIds・readingChannelIds が見えている列と同じ（左端・右端・席を開いた時・右腕の枠を重ねた時）・見える列だけ既読を付けに行く・節の行を押した後の scrollLeft と焦点・
      // 会話の根（data-talk・data-composer・data-cards）が 1 チャンネルに 1 つ・列の見出しがはみ出さない（幅 820 で席を開いた狭い列も）・留める・外した後の焦点。終わりに 2 つとも外し、掃除で留めた物を残さない
      if (vp === "pc" && theme === "dark") {
        await step(`${p} pins-wide`, [`${p}-a-deck-pins-wide`, `${p}-a-deck-pins-wide-end`], async () => {
          const TURN = '#c-deck-root .c-col[data-col="turn"]';
          const problems: string[] = [];
          const say = (text: string): void => void problems.push(`帯と会話の列: ${text}`);
          type Win = Window & {
            SA: {
              topics: { data: () => { topics: Array<{ id: string; title: string; state: string; mark: string | null; turn: unknown; last: unknown }>; rightHands: Array<{ id: string }> } | null; pins: () => string[] };
              store: { isUnread: (c: { id: string; last: unknown }) => boolean; markSeen: (id: string, n: number) => boolean };
              app: { shownChannelIds: () => string[]; readingChannelIds: () => string[] };
              deck: { stripFit: (w: number, open: boolean) => { show: boolean; room: number; colW: number; convW: number } };
              pins: { seen: () => string[] };
            };
            __pinEnds?: number;
            __pinMarks?: string[];
            __pinNew?: Array<{ id: string; on: boolean; seen: string[] }>;
            __pinFrames?: Array<{ t: number; sl: number; col: number | null; nw: boolean | null; oth: number | null }>;
          };
          /** 今の帯と列の形（ブラウザの中で測る） */
          type Strip = {
            attr: string | null;
            view: string | null;
            pins: string[];
            geo: string[];
            seen: string[];
            shown: string[];
            reading: string[];
            seat: string | null;
            seatOpen: boolean;
            hand: string | null;
            over: boolean;
            find: boolean;
            left: number;
            max: number;
            client: number;
            scrollWidth: number;
            room: number;
            flowW: number[];
            convW: number[];
            snaps: number[];
            orbHits: string[];
            dupRoots: string[];
            headOver: string[];
            focus: string;
          };
          const strip = (): Promise<Strip> =>
            page.evaluate(() => {
              const w = window as unknown as Win;
              const v3 = document.querySelector<HTMLElement>("#v3")!;
              const band = document.querySelector<HTMLElement>("#v3-deck")!;
              const br = band.getBoundingClientRect();
              const cols = [...document.querySelectorAll<HTMLElement>("#v3-pins > section.v3-pin")];
              const inside = (r: DOMRect): boolean => r.left >= br.left - 1 && r.right <= br.left + band.clientWidth + 1;
              const seatOpen = v3.getAttribute("data-view") === "body";
              // 席の住人（席の中に描いた会話。閉じても残り、shownChannelIds は残った住人も返す）
              const hash = document.querySelector("#ed .ed-scroll[data-channel]")?.getAttribute("data-channel") ?? null;
              const orb = document.querySelector("#c-orb-root button.c-orb");
              const or = orb === null ? null : orb.getBoundingClientRect();
              const orbHits: string[] = [];
              if (or !== null) {
                for (const el of [...document.querySelectorAll<HTMLElement>("#c-deck-root .c-col"), ...cols]) {
                  const r = el.getBoundingClientRect();
                  // 帯の見える範囲で切った列の箱
                  const l = Math.max(r.left, br.left);
                  const rr = Math.min(r.right, br.left + band.clientWidth);
                  if (rr > l && rr > or.left && l < or.right && r.bottom > or.top && r.top < or.bottom) orbHits.push(el.getAttribute("data-pin") ?? el.getAttribute("data-col") ?? "?");
                }
              }
              const counts = new Map<string, number>();
              for (const attr of ["data-talk", "data-composer", "data-cards"]) {
                for (const el of document.querySelectorAll(`[${attr}]`)) {
                  const key = `${attr}=${el.getAttribute(attr)}`;
                  counts.set(key, (counts.get(key) ?? 0) + 1);
                }
              }
              const active = document.activeElement;
              const pinOf = active?.closest("section.v3-pin")?.getAttribute("data-pin") ?? null;
              const focus =
                pinOf === null
                  ? active === null
                    ? "無し"
                    : (active.closest("[data-act]")?.getAttribute("data-act") ?? active.tagName.toLowerCase())
                  : `${pinOf}:${active?.closest('[data-act="pin"]') ? "pin" : active?.closest("[data-composer]") || active?.matches("textarea") ? "composer" : "other"}`;
              const hand = w.SA.topics.data()?.rightHands[0]?.id ?? null;
              return {
                attr: v3.getAttribute("data-pins"),
                view: v3.getAttribute("data-view"),
                pins: cols.map((c) => c.getAttribute("data-pin") ?? ""),
                geo: cols.filter((c) => inside(c.getBoundingClientRect())).map((c) => c.getAttribute("data-pin") ?? ""),
                seen: w.SA.pins.seen(),
                shown: w.SA.app.shownChannelIds(),
                reading: w.SA.app.readingChannelIds(),
                seat: hash,
                seatOpen,
                hand: hand !== null && v3.getAttribute("data-hand") === "open" ? hand.slice(3) : null,
                over: v3.getAttribute("data-hand") === "open",
                find: v3.getAttribute("data-find") === "open",
                left: band.scrollLeft,
                max: band.scrollWidth - band.clientWidth,
                client: band.clientWidth,
                scrollWidth: band.scrollWidth,
                room: w.SA.deck.stripFit(v3.clientWidth, seatOpen).room,
                flowW: [...document.querySelectorAll<HTMLElement>("#c-deck-root .c-col")].map((c) => c.offsetWidth),
                convW: cols.map((c) => c.offsetWidth),
                snaps: [...document.querySelectorAll<HTMLElement>("#c-deck-root .c-col"), ...cols].map((c) => Math.min(c.offsetLeft, band.scrollWidth - band.clientWidth)),
                orbHits,
                dupRoots: [...counts].filter(([, n]) => n > 1).map(([k, n]) => `${k} が ${n} 個`),
                headOver: cols.flatMap((c) => {
                  const top = c.querySelector<HTMLElement>(".c-top");
                  return top === null ? [`${c.getAttribute("data-pin")} の見出しが無い`] : top.scrollWidth > top.clientWidth ? [`${c.getAttribute("data-pin")} の見出しが ${top.scrollWidth}/${top.clientWidth}px`] : [];
                }),
                focus,
              };
            });
          /** 帯の形の確かめ（どの状態でも成り立つ物）。where は文の頭 */
          const stripLines = (s: Strip, where: string, n: number): void => {
            if (s.attr !== "true") say(`${where}: #v3 の data-pins が ${String(s.attr)}（true のはず）`);
            if (s.pins.length !== n) say(`${where}: 会話の列が ${s.pins.length} 本（${n} 本のはず）`);
            if (Math.abs(s.client - s.room) > 1) say(`${where}: 帯の見える幅 ${s.client}px（stripFit の room ${s.room}px と 1px 以内のはず）`);
            const wantW = Math.min(300, s.room);
            const wantC = Math.min(420, s.room);
            if (s.flowW.length !== 3 || s.flowW.some((x) => Math.abs(x - wantW) > 1)) say(`${where}: 流れの列の幅が ${s.flowW.join("・")}（${wantW} が 3 本のはず）`);
            if (s.convW.some((x) => Math.abs(x - wantC) > 1)) say(`${where}: 会話の列の幅が ${s.convW.join("・")}（${wantC} のはず）`);
            // 中身が見える幅より狭ければ scrollWidth は見える幅
            const total = Math.max(3 * wantW + n * wantC + (2 + n) * 8, s.client);
            if (Math.abs(s.scrollWidth - total) > 1) say(`${where}: 帯の scrollWidth ${s.scrollWidth}px（${total}px のはず）`);
            if (s.orbHits.length > 0) say(`${where}: 右腕の丸が列 ${s.orbHits.join("・")} に重なる`);
            if (s.dupRoots.length > 0) say(`${where}: 会話の根が 2 つ以上（${s.dupRoots.join("・")}）`);
            if (s.headOver.length > 0) say(`${where}: 列の見出しがはみ出す（${s.headOver.join("・")}）`);
            // 止まった後: 見えている列（pins.js）= 端まで見えている列（測った箱）。読み直しは席・右腕・見えている列、既読は重なりの下を除く
            if (JSON.stringify(s.seen) !== JSON.stringify(s.geo)) say(`${where}: 見えている列が「${s.seen.join("・")}」（端まで見えている「${s.geo.join("・")}」のはず）`);
            const wantShown = [...new Set([...(s.seat ? [s.seat] : []), ...(s.hand ? [s.hand] : []), ...s.geo])];
            const wantReading = [...new Set([...(s.seat && s.seatOpen && !s.over ? [s.seat] : []), ...(s.hand ? [s.hand] : []), ...(s.over || s.find ? [] : s.geo)])];
            if (JSON.stringify(s.shown) !== JSON.stringify(wantShown)) say(`${where}: shownChannelIds が「${s.shown.join("・")}」（${wantShown.join("・")} のはず）`);
            if (JSON.stringify(s.reading) !== JSON.stringify(wantReading)) say(`${where}: readingChannelIds が「${s.reading.join("・")}」（${wantReading.join("・")} のはず）`);
          };
          /** 送りが止まるまで待つ（scrollend の数が増えるまで。送らなかったら増えないので、先に送れるかを見る） */
          const scrollBand = async (to: "end" | "start" | number): Promise<void> => {
            const before = await page.evaluate(() => {
              const w = window as unknown as Win;
              const band = document.querySelector<HTMLElement>("#v3-deck")!;
              if (w.__pinEnds === undefined) {
                w.__pinEnds = 0;
                band.addEventListener("scrollend", () => void (w.__pinEnds = (w.__pinEnds ?? 0) + 1));
              }
              return { ends: w.__pinEnds, left: band.scrollLeft, max: band.scrollWidth - band.clientWidth };
            });
            const target = to === "end" ? before.max : to === "start" ? 0 : to;
            if (Math.abs(target - before.left) < 1) return;
            const box = await page.locator("#v3-deck").boundingBox();
            if (box === null) throw new Error("帯の箱が無い");
            // 帯の中の空いた所（列の見出しの高さ）にポインタを置いて横に送る（トラックパッドの横の送りと同じ。JS で wheel を取っていないので、ブラウザの送りと止まり方）
            await page.mouse.move(box.x + box.width / 2, box.y + 12);
            await page.mouse.wheel(target - before.left, 0);
            await page.waitForFunction((n: number) => ((window as unknown as Win).__pinEnds ?? 0) > n, before.ends, { timeout: 5000 });
            await page.mouse.move(box.x + box.width + 40, box.y + 200);
            await settled(page);
          };
          /** 知らせを × で閉じる（撮る絵に残さない） */
          const closeNotices = async (): Promise<void> => {
            await page.evaluate(() => {
              for (const b of document.querySelectorAll<HTMLButtonElement>('#c-notice-root .c-toast-list[role="status"] .c-toast-item button[aria-label="閉じる"]')) b.click();
            });
            await settled(page);
          };
          /** 上の帯の「あなたの番 n」（#507 の P5）: ボタンの数と、番の列の見出しの数（無ければ null） */
          const bandTurn = (): Promise<{ button: string | null; col: string | null }> =>
            page.evaluate((sel: string) => {
              const b = document.querySelector('#c-band-root [data-act="turn"]');
              return {
                button: b === null ? null : (b.querySelector(".c-badge")?.textContent ?? ""),
                col: document.querySelector(`${sel} .c-col-head .c-badge, ${sel} .c-col-head .c-col-count`)?.textContent ?? null,
              };
            }, TURN);
          /** #v3 の属性（data-moves は最初の操作で付くので、操作の後に比べる）と格子 */
          const shellForm = (): Promise<string> =>
            page.evaluate(() => {
              const v3 = document.querySelector<HTMLElement>("#v3")!;
              const attrs = [...v3.attributes].map((a) => `${a.name}=${a.value}`).sort();
              const band = document.querySelector<HTMLElement>("#v3-deck")!.getBoundingClientRect();
              return JSON.stringify({ attrs, grid: getComputedStyle(v3).gridTemplateColumns, band: [band.left, band.width], pins: document.querySelector("#v3-pins")?.children.length ?? -1 });
            });

          await load(page, "/");
          await page.waitForSelector(`${TURN} .c-item`, { timeout: 5000 });
          // 最初の操作（何も起きない Shift）の後の、留めた数 0 の形
          await page.keyboard.press("Shift");
          await settled(page);
          const zero = await shellForm();
          // 留める 2 つ: あなたの番の列の「動いている」「待機」の項目のうち、未読でない話題（既読を付けに行っても後の段の未読が変わらない物）。右腕は留められない
          const picks = await page.evaluate((sel: string) => {
            const w = window as unknown as Win;
            const data = w.SA.topics.data();
            if (data === null) return [];
            const keys = [...document.querySelectorAll(`${sel} .c-item[data-kind="running"], ${sel} .c-item[data-kind="idle"]`)].map((el) => el.getAttribute("data-key") ?? "");
            return keys
              .map((key) => ({ key, t: data.topics.find((t) => key.endsWith(":" + t.id)) }))
              .filter(({ t }) => t !== undefined && t.id.startsWith("ch:") && t.state !== "done" && t.turn === null && !w.SA.store.isUnread({ id: t.id.slice(3), last: t.last }))
              .slice(0, 2)
              .map(({ key, t }) => ({ key, id: t!.id.slice(3), title: t!.title }));
          }, TURN);
          if (picks.length < 2) throw new Error(`留められる既読の話題が ${picks.length} 個（2 個要る）`);
          const [a, b] = picks as [{ key: string; id: string; title: string }, { key: string; id: string; title: string }];
          const pinned: string[] = [];
          // 列が出る動き（#507 の P5）: 留めた列の data-new が付いた・外れた時を覚える（外れた時の見えている列も。動きの間の数え直しは offsetLeft で、transform に動かされない）
          await page.evaluate(() => {
            const w = window as unknown as Win;
            w.__pinNew = [];
            const note = (el: HTMLElement): void => void w.__pinNew!.push({ id: el.getAttribute("data-pin") ?? "", on: el.hasAttribute("data-new"), seen: w.SA.pins.seen() });
            new MutationObserver((records) => {
              for (const r of records) {
                // 印は列を #v3-pins に入れる前に付くので、足された列は入った時の印を覚える
                if (r.type === "childList") {
                  for (const n of r.addedNodes) if (n instanceof HTMLElement && n.matches("section.v3-pin") && n.hasAttribute("data-new")) note(n);
                } else if (r.attributeName === "data-new" && (r.target as HTMLElement).matches("section.v3-pin")) note(r.target as HTMLElement);
              }
            }).observe(document.querySelector("#v3-pins")!, { childList: true, subtree: true, attributes: true, attributeFilter: ["data-new"] });
          });
          try {
            // 1 つ目: 列の項目から席に開き、席の見出しのピンのボタン
            const openSeat = async (key: string): Promise<void> => {
              await page.locator(`${TURN} .c-item[data-key="${key}"] button.c-item-main`).click();
              await page.waitForSelector('#v3[data-view="body"] #ed textarea', { timeout: 5000 });
              await settled(page);
            };
            await openSeat(a.key);
            const seatPin = page.locator('#c-top-root [data-act="pin"] button');
            if ((await seatPin.count()) !== 1) throw new Error("席の見出しにピンのボタンが無い");
            if ((await seatPin.getAttribute("aria-pressed")) !== "false") say(`席のピンのボタンの aria-pressed が ${String(await seatPin.getAttribute("aria-pressed"))}（false のはず）`);
            await seatPin.click();
            await page.waitForSelector(`#v3-pins > section.v3-pin[data-pin="${a.id}"]`, { timeout: 5000 });
            await settled(page);
            pinned.push(a.id);
            let s = await strip();
            // 新しく留めた列は data-new が付いて動きの後に外れ、外れた時の見えている列は止まった後と同じ
            const moves = await page.evaluate(() => ((window as unknown as Win).__pinNew ?? []).slice());
            const onAt = moves.findIndex((m) => m.id === a.id && m.on);
            const off = moves.find((m, i) => i > onAt && m.id === a.id && !m.on);
            if (onAt < 0) say("1 本目を留めた列に data-new が付かない（列が出る動き）");
            else if (off === undefined) say("1 本目を留めた列の data-new が外れない");
            else if (JSON.stringify(off.seen) !== JSON.stringify(s.seen)) say(`動きの終わりの見えている列が「${off.seen.join("・")}」（止まった後の「${s.seen.join("・")}」と同じはず）`);
            if (s.view !== "list") say(`席のピンのボタンの後の data-view が ${String(s.view)}（list のはず。席を閉じる）`);
            if (s.focus !== `${a.id}:pin`) say(`席のピンのボタンの後の焦点が ${s.focus}（留めた列のピンのボタンのはず）`);
            const pressed = await page.locator(`#v3-pins > section.v3-pin[data-pin="${a.id}"] [data-act="pin"] button`).getAttribute("aria-pressed");
            if (pressed !== "true") say(`列のピンのボタンの aria-pressed が ${String(pressed)}（true のはず）`);
            stripLines(s, "1 本留めた所", 1);
            // 2 つ目: 席に開いて「…」→「ピン留めする」
            await openSeat(b.key);
            await page.click(TOP_MENU);
            await page.waitForSelector("#v3-sheet[open]", { timeout: 5000 });
            const rows = await sheetRows(page);
            if (!rows.includes("ピン留めする")) throw new Error(`「…」の板に「ピン留めする」が無い（${rows.join("・")}）`);
            // 列が出る動き（#507 の P5）: 押す直前から 800ms、コマごとに帯の位置・新しい列の left と data-new・1 本目の列の left を覚える
            await page.evaluate(
              ({ id, other }: { id: string; other: string }) => {
                const w = window as unknown as Win;
                const frames: NonNullable<Win["__pinFrames"]> = [];
                w.__pinFrames = frames;
                const band = document.querySelector<HTMLElement>("#v3-deck")!;
                const t0 = performance.now();
                const tick = (): void => {
                  const t = performance.now() - t0;
                  const col = document.querySelector<HTMLElement>(`#v3-pins > section.v3-pin[data-pin="${id}"]`);
                  const oth = document.querySelector<HTMLElement>(`#v3-pins > section.v3-pin[data-pin="${other}"]`);
                  frames.push({
                    t,
                    sl: band.scrollLeft,
                    col: col === null ? null : Math.round(col.getBoundingClientRect().left * 10) / 10,
                    nw: col === null ? null : col.hasAttribute("data-new"),
                    oth: oth === null ? null : Math.round(oth.getBoundingClientRect().left * 10) / 10,
                  });
                  if (t < 800) requestAnimationFrame(tick);
                };
                requestAnimationFrame(tick);
              },
              { id: b.id, other: a.id },
            );
            await page.locator("#v3-sheet .more-row").filter({ hasText: "ピン留めする" }).first().click();
            await page.waitForSelector(`#v3-pins > section.v3-pin[data-pin="${b.id}"]`, { timeout: 5000 });
            await settled(page);
            pinned.push(b.id);
            s = await strip();
            await closeNotices();
            if (s.view !== "list") say(`「ピン留めする」の後の data-view が ${String(s.view)}（list のはず）`);
            if (JSON.stringify(s.pins) !== JSON.stringify([a.id, b.id])) say(`列の順が ${s.pins.join("・")}（留めた順のはず）`);
            if (s.focus !== `${b.id}:pin`) say(`「ピン留めする」の後の焦点が ${s.focus}（留めた列のピンのボタンのはず）`);
            if (Math.abs(s.left - s.max) > 1) say(`留めた直後の帯の位置 ${s.left}（末尾の列の右端 ${s.max} のはず）`);
            stripLines(s, "2 本留めた所", 2);
            // 列が出る間（帯の末尾へ送った後）: 帯の位置とほかの列（1 本目）は動かず、新しい列だけが右から寄り、data-new は付いて外れる
            await page.waitForFunction(() => ((window as unknown as Win).__pinFrames ?? []).some((f) => f.t >= 800), undefined, { timeout: 5000 });
            const frames = (await page.evaluate(() => (window as unknown as Win).__pinFrames ?? [])).filter((f) => f.col !== null);
            if (frames.length < 3) say(`2 本目の列が出てからのコマが ${frames.length} 個（3 個以上のはず）`);
            else {
              const sls = [...new Set(frames.map((f) => f.sl))];
              const oths = [...new Set(frames.map((f) => f.oth))];
              if (sls.length !== 1) say(`2 本目の列が出る間に帯の位置が動いた（${sls.join(" → ")}）`);
              if (oths.length !== 1) say(`2 本目の列が出る間に 1 本目の列が動いた（left ${oths.join(" → ")}）`);
              if (!frames.some((f) => f.nw === true)) say("2 本目を留めた列に data-new が付かない（列が出る動き）");
              if (frames.at(-1)!.nw !== false) say("2 本目を留めた列の data-new が外れない");
            }

            // 左端: 読み込み直すと帯は左端（位置は覚えない）
            await load(page, "/");
            await page.waitForSelector(`#v3-pins > section.v3-pin[data-pin="${b.id}"] .c-top`, { timeout: 5000 });
            await settled(page);
            s = await strip();
            if (s.left !== 0) say(`読み込んだ時の帯の位置 ${s.left}（0 のはず）`);
            stripLines(s, "左端", 2);
            if (s.geo.includes(b.id)) say("左端で 2 本目の列が端まで見えている（1440 では右の外のはず）");
            // 読み込みで出た列は動かさない
            if ((await page.locator("#v3-pins > section.v3-pin[data-new]").count()) > 0) say("読み込みで出た列に data-new が付いている");
            // 番の列が見えている間は上の帯に「あなたの番 n」を出さない
            if ((await bandTurn()).button !== null) say("左端（番の列が見えている）で上の帯に「あなたの番 n」が出ている");
            // 見えない列には既読を付けに行かない（描き直しても）・見えるようになった列には付けに行く（store.markSeen を呼んだチャンネルを覚える）
            await page.evaluate(() => {
              const w = window as unknown as Win;
              const orig = w.SA.store.markSeen;
              w.__pinMarks = [];
              w.SA.store.markSeen = (id: string, n: number) => {
                w.__pinMarks!.push(id);
                return orig(id, n);
              };
            });
            await page.evaluate((id: string) => (window as unknown as { SA: { app: { refresh: (tab: string) => void }; chat: { markSeenShown: () => void } } }).SA.app.refresh("ch:" + id), b.id);
            await page.evaluate(() => (window as unknown as { SA: { chat: { markSeenShown: () => void } } }).SA.chat.markSeenShown());
            const hidden = await page.evaluate(() => (window as unknown as Win).__pinMarks ?? []);
            if (hidden.includes(b.id)) say("見えていない列（左端の 2 本目）に既読を付けに行った");
            await page.mouse.move(1, 1);
            await shot(page, `${p}-a-deck-pins-wide`);

            // 右端まで送る（止まると末尾の列の右端）
            await scrollBand("end");
            s = await strip();
            if (Math.abs(s.left - s.max) > 1) say(`右端まで送った後の帯の位置 ${s.left}（${s.max} のはず）`);
            stripLines(s, "右端", 2);
            if (!s.geo.includes(b.id)) say("右端で 2 本目の列が端まで見えていない");
            const marked = await page.evaluate(() => (window as unknown as Win).__pinMarks ?? []);
            if (!marked.includes(b.id)) say("送って見えるようになった 2 本目の列に既読を付けに行かない");
            // 番の列が見えない間は上の帯に「あなたの番 n」（数は番の列の見出しと同じ）
            const turnEnd = await bandTurn();
            if (turnEnd.button === null) say("右端（番の列が見えない）で上の帯に「あなたの番 n」が無い");
            else if (turnEnd.button !== turnEnd.col) say(`上の帯の「あなたの番」の数 ${turnEnd.button}（番の列の見出しの ${String(turnEnd.col)} のはず）`);
            await page.mouse.move(1, 1);
            await shot(page, `${p}-a-deck-pins-wide-end`);

            // 「あなたの番 n」を押す: 帯はすぐ左端へ、焦点は番の列の中、ボタンは消える
            if (turnEnd.button !== null) {
              await page.locator('#c-band-root [data-act="turn"]').click();
              await settled(page);
              s = await strip();
              if (s.left !== 0) say(`「あなたの番 n」を押した後の帯の位置 ${s.left}（0 のはず）`);
              const inTurn = await page.evaluate((sel: string) => (document.activeElement?.closest(sel) ?? null) !== null, TURN);
              if (!inTurn) say(`「あなたの番 n」を押した後の焦点が ${s.focus}（番の列の中のはず）`);
              if ((await bandTurn()).button !== null) say("「あなたの番 n」を押した後も上の帯に残っている");
              stripLines(s, "「あなたの番 n」を押した後", 2);
            }

            // 途中まで送って止めると列の左端で止まる
            await scrollBand(s.max / 2);
            s = await strip();
            if (!s.snaps.some((x) => Math.abs(x - s.left) <= 1)) say(`途中で止めた帯の位置 ${s.left}（列の左端 ${s.snaps.join("・")} のどれかのはず）`);
            stripLines(s, "途中で止めた所", 2);
            await scrollBand("start");

            // 節「ピン留め」の行を押す（帯は左端。節が見えている）: 端まで見えている 1 本目は帯が動かず、2 本目は帯がその列へ（末尾は右端）。どちらも席は開かず、入力欄に焦点
            const pressPinRow = async (id: string): Promise<void> => {
              const row = page.locator(`${TURN} .c-item[data-key="pin:ch:${id}"] button.c-item-main`);
              if ((await row.count()) === 0) throw new Error(`節「ピン留め」に ch:${id} の行が無い`);
              await row.click();
              await settled(page);
            };
            await pressPinRow(a.id);
            s = await strip();
            if (s.left !== 0) say(`端まで見えている列の行を押した後の帯の位置 ${s.left}（動かない 0 のはず）`);
            if (s.focus !== `${a.id}:composer`) say(`節の行（1 本目）を押した後の焦点が ${s.focus}（その列の入力欄のはず）`);
            await pressPinRow(b.id);
            s = await strip();
            if (s.view !== "list") say(`節の行（2 本目）を押した後の data-view が ${String(s.view)}（list のはず。席を開かない）`);
            if (Math.abs(s.left - s.max) > 1) say(`節の行（2 本目）を押した後の帯の位置 ${s.left}（末尾の列の右端 ${s.max} のはず）`);
            if (s.focus !== `${b.id}:composer`) say(`節の行（2 本目）を押した後の焦点が ${s.focus}（その列の入力欄のはず）`);
            if ((await page.evaluate(() => location.hash)) !== "") say("節の行を押した後に住所（hash）が書かれた");
            stripLines(s, "節の行（2 本目）を押した後", 2);

            // 席を開いた時（留めていない番の話題）: 帯が狭まる。見えている列はその場の物だけ
            await scrollBand("start");
            await page.locator(`${TURN} .c-item[data-turn="true"] button.c-item-main`).first().click();
            await page.waitForSelector('#v3[data-view="body"] #ed textarea', { timeout: 5000 });
            await settled(page);
            s = await strip();
            if (!s.seatOpen || s.seat === null) say("番の項目を押しても席が開かない");
            stripLines(s, "席を開いた時", 2);
            // 右腕の枠を重ねた時: 下の席と列は既読から外れる
            await page.click(ORB);
            await page.waitForSelector('#v3[data-hand="open"]', { timeout: 5000 });
            await settled(page);
            stripLines(await strip(), "右腕の枠を重ねた時", 2);
            await page.keyboard.press("Escape");
            await page.waitForSelector('#v3[data-hand="closed"]', { timeout: 5000 });
            await settled(page);
            await page.click('#c-top-root [data-act="close"] button');
            await page.waitForSelector('#v3[data-view="list"]', { timeout: 5000 });
            await settled(page);

            // 幅 820 で席を開いた時: 列は 292 に縮み、列の見出しははみ出さない（絵は撮らない）
            await page.setViewportSize({ width: 820, height: VIEWPORTS.pc.viewport.height });
            await settled(page);
            await page.locator(`${TURN} .c-item[data-turn="true"] button.c-item-main`).first().click();
            await page.waitForSelector('#v3[data-view="body"] #ed textarea', { timeout: 5000 });
            await settled(page);
            stripLines(await strip(), "幅 820 で席を開いた時", 2);
            await page.click('#c-top-root [data-act="close"] button');
            await page.waitForSelector('#v3[data-view="list"]', { timeout: 5000 });
            await page.setViewportSize(VIEWPORTS.pc.viewport);
            await settled(page);

            // 外す: 1 本目は列のピンのボタン（焦点は右隣の列のピンのボタン）、2 本目は列の「…」→「ピン留めを外す」（焦点は上の帯の［探す］）
            await page.locator(`#v3-pins > section.v3-pin[data-pin="${a.id}"] [data-act="pin"] button`).click();
            await page.waitForSelector(`#v3-pins > section.v3-pin[data-pin="${a.id}"]`, { state: "detached", timeout: 5000 });
            await settled(page);
            pinned.splice(pinned.indexOf(a.id), 1);
            s = await strip();
            if (s.focus !== `${b.id}:pin`) say(`1 本目を外した後の焦点が ${s.focus}（右隣の列のピンのボタンのはず）`);
            stripLines(s, "1 本外した所", 1);
            await page.locator(`#v3-pins > section.v3-pin[data-pin="${b.id}"] [data-act="menu"] button`).click();
            await page.waitForSelector("#v3-sheet[open]", { timeout: 5000 });
            const colRows = await sheetRows(page);
            if (colRows[0] !== "ピン留めを外す" || colRows.some((r) => r === "場所を変える" || r === "許可のモードを変える" || r === "ピン留めする")) say(`列の「…」の板の行が「${colRows.join("・")}」（ピン留めを外す とチャンネルの操作だけのはず）`);
            await page.locator("#v3-sheet .more-row").filter({ hasText: "ピン留めを外す" }).first().click();
            await page.waitForSelector(`#v3-pins > section.v3-pin[data-pin="${b.id}"]`, { state: "detached", timeout: 5000 });
            await settled(page);
            pinned.splice(pinned.indexOf(b.id), 1);
            const focus = await page.evaluate(() => document.activeElement?.closest("[data-act]")?.getAttribute("data-act") ?? null);
            if (focus !== "find") say(`最後の 1 本を外した後の焦点が ${String(focus)}（上の帯の［探す］のはず）`);
            await closeNotices();
            const end = await shellForm();
            if (end !== zero) say(`外した後の #v3 の形が ${end}（留める前の ${zero} のはず）`);
          } finally {
            // 掃除（画面から外せなかった時も、後の段に留めた物を残さない）: サーバーの pins を全部外す（a-deck-pins の段と同じ）
            await page.setViewportSize(VIEWPORTS.pc.viewport);
            const swept = await page
              .evaluate(async () => {
                const headers = { "X-Self-Agent": "1", "Content-Type": "application/json" };
                const res = await fetch("/api/topics", { headers: { "X-Self-Agent": "1" }, credentials: "same-origin", cache: "no-store" });
                const body = (await res.json()) as { pins?: unknown };
                const ids = Array.isArray(body.pins) ? body.pins.filter((id): id is string => typeof id === "string") : [];
                for (const id of ids) await fetch("/api/topics/ch:" + id + "/pin", { method: "POST", headers, credentials: "same-origin", body: JSON.stringify({ on: false }) });
                return ids.length;
              })
              .catch(() => -1);
            if (swept !== 0 && pinned.length === 0) say(swept < 0 ? "掃除の読み取り・外しに失敗" : `画面から外した後もサーバーに留めた物が ${swept} 個残っていた（掃除で外した）`);
            if (pinned.length > 0) say(`外せなかった話題が ${pinned.length} 個（掃除で外した）`);
            // 途中で投げた時も、そこまでに見つけた物を残す
            for (const line of problems) logLines.push(`[v3-${p}] ${line}`);
          }
          if (problems.length > 0) throw new Error(`帯と会話の列の検査で ${problems.length} 件`);
        });
      }
      // 席が開くときの動き（D5 の PR-1。ダークのスマホと PC）: 読み込み（hash）で開いた席は動かず印（data-moves）が無い。最初の操作の後に項目を押すと、
      // 席（#v3-main）の動きは opacity と transform の 2 つで長さは 200（スマホの全面は 300）。止めて 0%（透明・右 16px）・50%・100%（止まった後と同じ箱）を撮る。動きを減らす設定では動かずに同じ箱（絵なし）
      if (vp !== "tablet" && theme === "dark") {
        const frames = [0, 50, 100] as const;
        await step(`${p} seat-motion`, frames.map((f) => `${p}-a-deck-seat-${f}`), async () => {
          const OPENER = '#c-deck-root .c-col[data-col="turn"] .c-item[data-turn="true"] button.c-item-main';
          const problems: string[] = [];
          const say = (text: string): void => void problems.push(`席の動き: ${text}`);
          type Box = { left: number; top: number; width: number; height: number; opacity: number };
          const boxOf = (): Promise<Box | null> =>
            page.evaluate(() => {
              const main = document.querySelector<HTMLElement>("#v3-main");
              if (main === null) return null;
              const r = main.getBoundingClientRect();
              return { left: r.left, top: r.top, width: r.width, height: r.height, opacity: Number(getComputedStyle(main).opacity) };
            });
          const want = vp === "phone" ? 300 : 200;
          // 押しても何も起きない所（あなたの番の列の左下。押せる物・項目の上でない）を押して離す。
          // 列が項目で埋まっている（待機の節。#505）ときは、同じ左の縦の線を下から上へ 1px ずつ見て、最初の項目でない所（項目の間・節の見出し）
          const pressBlank = async (): Promise<void> => {
            const at = await page.evaluate(() => {
              const col = document.querySelector<HTMLElement>('#c-deck-root .c-col[data-col="turn"]');
              if (col === null) return null;
              const r = col.getBoundingClientRect();
              const x = r.left + 8;
              for (let y = r.bottom - 8; y > r.top; y--) {
                const hit = document.elementFromPoint(x, y);
                if (hit !== null && col.contains(hit) && hit.closest("button, a, input, textarea, select, .c-item") === null) return { x, y };
              }
              return null;
            });
            if (at === null) throw new Error("押しても何も起きない所が見つからない");
            await page.mouse.click(at.x, at.y);
          };
          // 読み込み（hash）で開いた席: 印が無く、席に動きの規則が当たらない
          await load(page, `/#/ch/${open}`);
          await page.waitForSelector('#v3[data-view="body"] #ed textarea', { timeout: 5000 });
          await settled(page);
          const loaded = await page.evaluate(() => {
            const main = document.querySelector<HTMLElement>("#v3-main");
            return {
              moves: document.querySelector("#v3")?.getAttribute("data-moves") ?? null,
              running: main === null ? -1 : main.getAnimations().length,
              duration: main === null ? "" : getComputedStyle(main).transitionDuration,
            };
          });
          if (loaded.moves !== null || loaded.running !== 0 || loaded.duration !== "0s") say(`読み込みで開いた席が ${JSON.stringify(loaded)}（印なし・動き 0・transition-duration 0s のはず）`);
          // 最初の操作（あなたの番の列の下の空いた所を指で押す。何も起きない所）の後に項目を押し、席の動きを同じ処理の中で止める
          await load(page, "/");
          await page.waitForSelector(OPENER, { timeout: 5000 });
          await settled(page);
          await pressBlank();
          const moves = await page.getAttribute("#v3", "data-moves");
          if (moves !== "on") say(`最初の操作の後の data-moves が ${String(moves)}（on のはず）`);
          const started = await page.evaluate((sel: string) => {
            const opener = document.querySelector<HTMLElement>(sel);
            const main = document.querySelector<HTMLElement>("#v3-main");
            if (opener === null || main === null) return null;
            opener.click();
            const view = document.querySelector("#v3")?.getAttribute("data-view") ?? null;
            const anims = main.getAnimations();
            for (const a of anims) {
              a.pause();
              a.currentTime = 0;
            }
            return {
              view,
              props: anims.map((a) => (a as CSSTransition).transitionProperty ?? "").sort(),
              durations: anims.map((a) => Number(a.effect?.getTiming().duration)),
              easings: anims.map((a) => String(a.effect?.getTiming().easing ?? "")),
              ease: getComputedStyle(document.documentElement).getPropertyValue("--ease-out"),
            };
          }, OPENER);
          if (started === null) throw new Error("開く項目か #v3-main が無い");
          if (started.view !== "body") say(`押した直後の data-view が ${String(started.view)}（body のはず）`);
          if (started.props.length === 0) throw new Error("席の動きが 0 個");
          if (JSON.stringify(started.props) !== JSON.stringify(["opacity", "transform"])) say(`動いている物が ${started.props.join("・")}（opacity・transform のはず）`);
          if (started.durations.some((d) => d !== want)) say(`長さが ${started.durations.join("・")}（${want} のはず）`);
          const tight = (v: string): string => v.replace(/\s+/g, "");
          if (tight(started.ease) === "" || started.easings.some((e) => tight(e) !== tight(started.ease))) say(`曲線が ${started.easings.join("・")}（--ease-out の ${started.ease.trim()} のはず）`);
          const boxes: Box[] = [];
          for (const f of frames) {
            await page.evaluate((at: number) => {
              for (const a of document.querySelector<HTMLElement>("#v3-main")?.getAnimations() ?? []) a.currentTime = (Number(a.effect?.getTiming().duration) * at) / 100;
            }, f);
            const b = await boxOf();
            if (b === null) throw new Error("#v3-main が無い");
            boxes.push(b);
            await shot(page, `${p}-a-deck-seat-${f}`);
          }
          // 100% に置いた動きは終わって一覧から外れる。残っていれば終えて、止まった後の箱と比べる
          const left = await page.evaluate(() => {
            const anims = document.querySelector<HTMLElement>("#v3-main")?.getAnimations() ?? [];
            for (const a of anims) a.finish();
            return anims.length;
          });
          if (left !== 0) say(`100% に置いた後も席の動きが ${left} 個残る（0 個のはず）`);
          await settled(page);
          const end = await boxOf();
          if (end === null) throw new Error("#v3-main が無い");
          const [b0, b50, b100] = boxes as [Box, Box, Box];
          const near = (a: number, b: number): boolean => Math.abs(a - b) <= 0.5;
          const seatIn = await page.evaluate(() => {
            const probe = document.createElement("div");
            probe.style.width = "var(--c-deck-seat-in)";
            document.body.append(probe);
            const w = probe.getBoundingClientRect().width;
            probe.remove();
            return w;
          });
          if (seatIn !== 16) say(`--c-deck-seat-in が ${seatIn}px（16 のはず）`);
          if (b0.opacity > 0.01 || !near(b0.left - end.left, seatIn)) say(`0% が 透明度 ${b0.opacity}・右へ ${b0.left - end.left}px（0・${seatIn} のはず）`);
          if (!(b50.opacity > 0 && b50.opacity < 1) || !(b50.left - end.left > 0 && b50.left - end.left < seatIn)) say(`50% が 透明度 ${b50.opacity}・右へ ${b50.left - end.left}px（0 と 1・0 と ${seatIn} の間のはず）`);
          if (b100.opacity !== 1 || !near(b100.left, end.left) || !near(b100.top, end.top) || !near(b100.width, end.width) || !near(b100.height, end.height)) say(`100% の箱 ${JSON.stringify(b100)} が止まった後 ${JSON.stringify(end)} と違う`);
          for (const b of [b0, b50]) if (!near(b.top, end.top) || !near(b.width, end.width) || !near(b.height, end.height)) say(`途中の箱の縦・幅・高さ ${JSON.stringify(b)} が止まった後 ${JSON.stringify(end)} と違う（動くのは横だけ）`);
          // 動きを減らす設定: 押しても動きが 0 個で、同じ箱
          await page.emulateMedia({ reducedMotion: "reduce" });
          try {
            await load(page, "/");
            await page.waitForSelector(OPENER, { timeout: 5000 });
            await settled(page);
            await pressBlank();
            const reduced = await page.evaluate((sel: string) => {
              const opener = document.querySelector<HTMLElement>(sel);
              const main = document.querySelector<HTMLElement>("#v3-main");
              if (opener === null || main === null) return null;
              opener.click();
              return { moves: document.querySelector("#v3")?.getAttribute("data-moves") ?? null, view: document.querySelector("#v3")?.getAttribute("data-view") ?? null, running: main.getAnimations().length };
            }, OPENER);
            if (reduced === null || reduced.moves !== "on" || reduced.view !== "body" || reduced.running !== 0) say(`動きを減らす設定で押した直後が ${JSON.stringify(reduced)}（印 on・body・動き 0 のはず）`);
            await settled(page);
            const r = await boxOf();
            if (r === null || r.opacity !== 1 || !near(r.left, end.left) || !near(r.top, end.top) || !near(r.width, end.width) || !near(r.height, end.height)) say(`動きを減らす設定の席の箱 ${JSON.stringify(r)} が ${JSON.stringify(end)} と違う`);
          } finally {
            await page.emulateMedia({ reducedMotion: null });
          }
          // 右腕の枠と幕が出るときの動き（D6 の PR-4。同じ組）: 読み込み（右腕の hash）で開いた枠は動かない。最初の操作の後に口（PC は丸・スマホは下のバーの右腕）を押した直後、
          // 枠（#v3-hand）は opacity と transform・幕（#v3-hand-backdrop）は opacity だけで、長さは席と同じ。丸は動かず、押した直後も終わった後も画面が横にずれない・送りの棒が出ない。
          // 終わった後は不透明・ずれなしで PR-2 の形。Esc で閉じるのはすぐ。動きを減らす設定では動かない。終わりは枠を閉じた列だけの画面（後ろの段は読み直す）
          {
            const sayHand = (text: string): void => void problems.push(`右腕の枠の動き: ${text}`);
            const HAND_OPEN = vp === "phone" ? BAR_HAND : ORB;
            type HandStart = { moves: string | null; hand: string | null; frame: string[]; frameDur: number[]; frameEase: string[]; back: string[]; backDur: number[]; backEase: string[]; orb: number; shift: ShiftState; ease: string; from: { opacity: string; transform: string; backOpacity: string } };
            type ShiftState = { rootLeft: number; bodyLeft: number; v3Left: number; rootTop: number; bodyTop: number; v3Top: number; innerW: number; clientW: number; scrollW: number; innerH: number; clientH: number; scrollH: number };
            /** 画面が横にも縦にもずれていないか（ページ・body・#v3 の scrollLeft・scrollTop が 0、送りの棒が出ていない（innerWidth = clientWidth・innerHeight = clientHeight）。after では はみ出しも残らない） */
            const shiftLines = (st: ShiftState, when: string, after: boolean): string[] =>
              st.rootLeft !== 0 || st.bodyLeft !== 0 || st.v3Left !== 0 || st.rootTop !== 0 || st.bodyTop !== 0 || st.v3Top !== 0 || st.innerW !== st.clientW || st.innerH !== st.clientH || (after && (st.scrollW > st.clientW || st.scrollH > st.clientH))
                ? [`${when}のずれ・送りの棒が ${JSON.stringify(st)}（scrollLeft・scrollTop は全部 0・innerWidth = clientWidth・innerHeight = clientHeight${after ? "・scrollWidth ≦ clientWidth・scrollHeight ≦ clientHeight" : ""} のはず）`]
                : [];
            // いまのずれを読む式は、ページの中の 3 か所に同じ形で書く（ページの中の関数は外の物を使えない）
            const shiftNow = (): Promise<ShiftState> =>
              page.evaluate(() => {
                const root = document.documentElement;
                const v3 = document.querySelector("#v3");
                return { rootLeft: root.scrollLeft, bodyLeft: document.body.scrollLeft, v3Left: v3?.scrollLeft ?? -1, rootTop: root.scrollTop, bodyTop: document.body.scrollTop, v3Top: v3?.scrollTop ?? -1, innerW: window.innerWidth, clientW: root.clientWidth, scrollW: root.scrollWidth, innerH: window.innerHeight, clientH: root.clientHeight, scrollH: root.scrollHeight };
              });
            /** 出始めの枠のずれ（広い幅は右から・スマホは下から --c-deck-seat-in） */
            const FROM = vp === "phone" ? `matrix(1, 0, 0, 1, 0, ${seatIn})` : `matrix(1, 0, 0, 1, ${seatIn}, 0)`;
            /** 口を押し、同じ処理の中で枠・幕・丸の動きと横のずれを読む（止めない） */
            const pressHand = (): Promise<HandStart | null> =>
              page.evaluate((sel: string) => {
                const opener = document.querySelector<HTMLElement>(sel);
                const hand = document.querySelector<HTMLElement>("#v3-hand");
                const back = document.querySelector<HTMLElement>("#v3-hand-backdrop");
                if (opener === null || hand === null || back === null) return null;
                opener.click();
                const of = (el: HTMLElement | null) => {
                  const anims = el === null ? [] : el.getAnimations();
                  return {
                    props: anims.map((a) => (a as CSSTransition).transitionProperty ?? "").sort(),
                    durations: anims.map((a) => Number(a.effect?.getTiming().duration)),
                    easings: anims.map((a) => String(a.effect?.getTiming().easing ?? "")),
                  };
                };
                const f = of(hand);
                const b = of(back);
                const root = document.documentElement;
                const v3 = document.querySelector("#v3");
                return {
                  moves: document.querySelector("#v3")?.getAttribute("data-moves") ?? null,
                  hand: document.querySelector("#v3")?.getAttribute("data-hand") ?? null,
                  frame: f.props,
                  frameDur: f.durations,
                  frameEase: f.easings,
                  back: b.props,
                  backDur: b.durations,
                  backEase: b.easings,
                  orb: document.querySelector<HTMLElement>("#v3-orb")?.getAnimations({ subtree: true }).length ?? 0,
                  shift: { rootLeft: root.scrollLeft, bodyLeft: document.body.scrollLeft, v3Left: v3?.scrollLeft ?? -1, rootTop: root.scrollTop, bodyTop: document.body.scrollTop, v3Top: v3?.scrollTop ?? -1, innerW: window.innerWidth, clientW: root.clientWidth, scrollW: root.scrollWidth, innerH: window.innerHeight, clientH: root.clientHeight, scrollH: root.scrollHeight },
                  ease: getComputedStyle(root).getPropertyValue("--ease-out"),
                  from: { opacity: getComputedStyle(hand).opacity, transform: getComputedStyle(hand).transform, backOpacity: getComputedStyle(back).opacity },
                };
              }, HAND_OPEN);
            // 読み込み（右腕のチャンネルの hash）で開いた枠: 印が無く、枠と幕に動きの規則が当たらない
            await load(page, "/");
            await page.waitForSelector(HAND_OPEN, { timeout: 5000 });
            await settled(page);
            const handTab = await page.evaluate(() => (window as unknown as { SA: { topics: { data: () => { rightHands: Array<{ id: string }> } | null } } }).SA.topics.data()?.rightHands[0]?.id ?? null);
            if (handTab === null) throw new Error("右腕のチャンネルが一覧に無い");
            await load(page, `/#/${handTab.replace(":", "/")}`);
            await page.waitForSelector('#v3[data-hand="open"]', { timeout: 5000 });
            await settled(page);
            const loaded = await page.evaluate(() => {
              const hand = document.querySelector<HTMLElement>("#v3-hand");
              const back = document.querySelector<HTMLElement>("#v3-hand-backdrop");
              return {
                moves: document.querySelector("#v3")?.getAttribute("data-moves") ?? null,
                running: hand === null || back === null ? -1 : hand.getAnimations().length + back.getAnimations().length,
                duration: hand === null ? "" : getComputedStyle(hand).transitionDuration,
              };
            });
            if (loaded.moves !== null || loaded.running !== 0 || loaded.duration !== "0s") sayHand(`読み込みで開いた枠が ${JSON.stringify(loaded)}（印なし・動き 0・transition-duration 0s のはず）`);
            // 最初の操作の後に口を押す
            await load(page, "/");
            await page.waitForSelector(HAND_OPEN, { timeout: 5000 });
            await settled(page);
            await pressBlank();
            const started = await pressHand();
            if (started === null) throw new Error("右腕の口か #v3-hand・#v3-hand-backdrop が無い");
            if (started.moves !== "on" || started.hand !== "open") sayHand(`押した直後の data-moves・data-hand が ${String(started.moves)}・${String(started.hand)}（on・open のはず）`);
            if (started.frame.length === 0) throw new Error("右腕の枠の動きが 0 個");
            if (JSON.stringify(started.frame) !== JSON.stringify(["opacity", "transform"])) sayHand(`枠で動いている物が ${started.frame.join("・")}（opacity・transform のはず）`);
            if (JSON.stringify(started.back) !== JSON.stringify(["opacity"])) sayHand(`幕で動いている物が ${started.back.join("・") || "無し"}（opacity だけのはず）`);
            if ([...started.frameDur, ...started.backDur].some((d) => d !== want)) sayHand(`長さが 枠 ${started.frameDur.join("・")}・幕 ${started.backDur.join("・")}（${want} のはず）`);
            if (tight(started.ease) === "" || [...started.frameEase, ...started.backEase].some((e) => tight(e) !== tight(started.ease))) sayHand(`曲線が ${[...started.frameEase, ...started.backEase].join("・")}（--ease-out の ${started.ease.trim()} のはず）`);
            if (started.orb !== 0) sayHand(`開く間の丸の動きが ${started.orb} 個（0 のはず）`);
            // 出始めの向きと量（広い幅は右へ・スマホは下へ --c-deck-seat-in、透明。幕は透明）
            if (started.from.opacity !== "0" || started.from.transform !== FROM || started.from.backOpacity !== "0") sayHand(`出始めの枠・幕が ${JSON.stringify(started.from)}（透明・${FROM}・幕も透明のはず）`);
            for (const line of shiftLines(started.shift, "押した直後", false)) sayHand(line);
            await settled(page);
            const end = await page.evaluate(() => {
              const hand = document.querySelector<HTMLElement>("#v3-hand");
              if (hand === null) return null;
              const cs = getComputedStyle(hand);
              return { opacity: cs.opacity, transform: cs.transform, running: hand.getAnimations().length, orb: document.querySelector<HTMLElement>("#v3-orb")?.getAnimations({ subtree: true }).length ?? 0 };
            });
            if (end === null) throw new Error("#v3-hand が無い");
            if (end.opacity !== "1" || !(end.transform === "none" || end.transform === "matrix(1, 0, 0, 1, 0, 0)") || end.running !== 0) sayHand(`動きが終わった後の枠が ${JSON.stringify(end)}（不透明・transform なし・動き 0 のはず）`);
            if (end.orb !== 0) sayHand(`開いた後の丸の動きが ${end.orb} 個（0 のはず）`);
            for (const line of await handFrameLines(page, vp)) sayHand(line);
            for (const line of shiftLines(await shiftNow(), "動きが終わった後", true)) sayHand(line);
            // Esc で閉じるのはすぐ（スマホは履歴を戻して閉じるので、data-hand が closed になった所で同じ処理の中で読む）
            await page.keyboard.press("Escape");
            const closed = await page
              .waitForFunction(
                () => {
                  if (document.querySelector('#v3[data-hand="closed"]') === null) return false;
                  const hand = document.querySelector<HTMLElement>("#v3-hand");
                  const back = document.querySelector<HTMLElement>("#v3-hand-backdrop");
                  return {
                    display: hand === null ? "" : getComputedStyle(hand).display,
                    running: hand === null || back === null ? -1 : hand.getAnimations().length + back.getAnimations().length,
                  };
                },
                undefined,
                { timeout: 5000 },
              )
              .then((h) => h.jsonValue() as Promise<{ display: string; running: number }>, () => null);
            if (closed === null || closed.display !== "none" || closed.running !== 0) sayHand(`Esc で閉じた直後が ${JSON.stringify(closed)}（closed・display none・動き 0 のはず）`);
            await settled(page);
            // 入力欄でなく［畳む］に焦点が行く道（右腕のタブを開く。あなたの番 の右腕の項目・「探す」の行・hash と同じ）: 動きの間、［畳む］は画面の外へはみ出しているが、焦点で画面を送らない
            const byTab = await page.evaluate(
              (tab: string) => {
                (window as unknown as { SA: { app: { open: (id: string) => void } } }).SA.app.open(tab);
                const hand = document.querySelector<HTMLElement>("#v3-hand");
                const root = document.documentElement;
                const v3 = document.querySelector("#v3");
                const active = document.activeElement;
                return {
                  hand: document.querySelector("#v3")?.getAttribute("data-hand") ?? null,
                  running: hand === null ? 0 : hand.getAnimations().length,
                  close: active !== null && active.closest('#v3-hand [data-act="close"]') !== null,
                  shift: { rootLeft: root.scrollLeft, bodyLeft: document.body.scrollLeft, v3Left: v3?.scrollLeft ?? -1, rootTop: root.scrollTop, bodyTop: document.body.scrollTop, v3Top: v3?.scrollTop ?? -1, innerW: window.innerWidth, clientW: root.clientWidth, scrollW: root.scrollWidth, innerH: window.innerHeight, clientH: root.clientHeight, scrollH: root.scrollHeight },
                };
              },
              handTab,
            );
            if (byTab.hand !== "open" || byTab.running === 0 || !byTab.close) sayHand(`右腕のタブを開いた直後が ${JSON.stringify({ hand: byTab.hand, running: byTab.running, close: byTab.close })}（open・動きあり・焦点は［畳む］のはず）`);
            for (const line of shiftLines(byTab.shift, "右腕のタブを開いた直後（焦点は［畳む］）", false)) sayHand(line);
            await settled(page);
            for (const line of shiftLines(await shiftNow(), "右腕のタブを開いて動きが終わった後", true)) sayHand(line);
            await page.keyboard.press("Escape");
            await page.waitForSelector('#v3[data-hand="closed"]', { timeout: 5000 });
            await settled(page);
            // 動きを減らす設定: 押しても枠と幕の動きが 0 個
            await page.emulateMedia({ reducedMotion: "reduce" });
            try {
              await load(page, "/");
              await page.waitForSelector(HAND_OPEN, { timeout: 5000 });
              await settled(page);
              await pressBlank();
              const reduced = await pressHand();
              if (reduced === null || reduced.moves !== "on" || reduced.hand !== "open" || reduced.frame.length + reduced.back.length !== 0) sayHand(`動きを減らす設定で押した直後が ${JSON.stringify(reduced)}（印 on・open・動き 0 のはず）`);
              await settled(page);
              await page.keyboard.press("Escape");
              await page.waitForSelector('#v3[data-hand="closed"]', { timeout: 5000 });
              await settled(page);
            } finally {
              await page.emulateMedia({ reducedMotion: null });
            }
          }
          for (const line of problems) logLines.push(`[v3-${p}] ${line}`);
          if (problems.length > 0) throw new Error(`席・右腕の枠の動きの検査で ${problems.length} 件`);
        });
      }
      // 列の中の操作（D1 の PR-2。ダークの PC と、D2 からダークのスマホ）: ［完了］の当たり・列から 1 つ消える・知らせと［取り消す］（スマホは知らせが上）・焦点の行き先。
      // 撮った後に［取り消す］で戻す（戻せなければ段を失敗にする）。スマホは先に下のバーでタスクの列へ送る
      if (vp !== "tablet" && theme === "dark") {
        await step(`${p} done`, [`${p}-a-deck-done`], async () => {
          const TASK = '#c-deck-root .c-col[data-col="tasks"] .c-item[data-kind="task"]';
          const UNDO = "#c-notice-root .c-toast-item button";
          const problems: string[] = [];
          const say = (text: string): void => void problems.push(`列の中の操作: ${text}`);
          await load(page, "/");
          await page.waitForSelector(TASK, { timeout: 5000 });
          await settled(page);
          if (vp === "phone") {
            await page.click('#c-foot-root button[data-act="page"][data-page="tasks"]');
            await settled(page);
          }
          const keys = (): Promise<string[]> => page.evaluate((sel: string) => [...document.querySelectorAll(sel)].map((el) => el.getAttribute("data-key") ?? ""), TASK);
          const before = await keys();
          // スマホは帯の題がタスクの列の名前と数（［完了］で 1 減る）
          const bandShown = (t: ReturnType<typeof bandTitleState>): number | null => (t.badge ?? t.count) === null ? null : Number(t.badge ?? t.count);
          const bandBefore = vp === "phone" ? await page.evaluate(bandTitleState) : null;
          if (bandBefore !== null) for (const line of bandTitleProblems(bandBefore, "［完了］の前の帯")) say(line);
          for (const line of await page.evaluate(hitProblems, { min: 44, scopes: '#c-deck-root .c-col[data-col="tasks"]', targets: ".c-item-meta .c-iconbtn", toast: false })) say(line);
          await page.click(`${TASK} .c-item-meta .c-iconbtn`);
          const gone = await page
            .waitForFunction(([sel, n]: [string, number]) => document.querySelectorAll(sel).length === n, [TASK, before.length - 1] as [string, number], { timeout: 5000 })
            .then(() => true, () => false);
          if (!gone) say(`［完了］の後の列の項目が ${(await keys()).length} 個（${before.length - 1} 個のはず）`);
          else if ((await keys()).includes(before[0]!)) say(`押した項目 ${before[0]} が列に残る`);
          if (bandBefore !== null) {
            const was = bandShown(bandBefore);
            const want = was === null || was <= 1 ? null : was - 1;
            const now = await page
              .waitForFunction((n: number | null) => {
                const el = document.querySelector('#c-band-root .c-band-name[data-kind="page"] > :not(.c-band-title)');
                const shown = el === null ? null : Number((el.textContent ?? "").trim());
                return shown === n;
              }, want, { timeout: 5000 })
              .then(() => true, () => false);
            const after = await page.evaluate(bandTitleState);
            if (was === null || !now) say(`［完了］の後の帯の数が ${String(bandShown(after))}（${String(was)} から 1 減るはず）`);
            for (const line of bandTitleProblems(after, "［完了］の後の帯")) say(line);
          }
          const notice = await page
            .waitForSelector(`${UNDO} >> text=取り消す`, { timeout: 5000 })
            .then(() => page.evaluate(() => (document.querySelector('#c-notice-root .c-toast-list[role="status"]')?.textContent ?? "").trim()), () => null);
          if (notice === null) say("知らせに［取り消す］が無い");
          else if (!notice.includes("を完了にしました")) say(`知らせが「${notice.slice(0, 40)}」`);
          // スマホの知らせは上（下のバーと親指の所を塞がない。polish §5 の UI-8）
          if (vp === "phone" && notice !== null) {
            const top = await page.evaluate(() => document.querySelector('#c-notice-root .c-toast-list[role="status"]')?.getBoundingClientRect().top ?? -1);
            if (top < 0 || top > VIEWPORTS.phone.viewport.height / 2) say(`知らせの上端 ${top}（画面の上半分のはず）`);
          }
          await settled(page);
          // 押したボタンは項目ごと消える。焦点は c-app.js の drawDeck の決まりで、同じ列の次の項目（ここでは次のタスク）の［完了］へ
          const focus = await page.evaluate((sel: string) => {
            const a = document.activeElement;
            const item = a === null ? null : a.closest(sel);
            return { key: item === null ? null : item.getAttribute("data-key"), done: a !== null && a.matches(".c-item-meta .c-iconbtn") };
          }, TASK);
          if (focus.key !== before[1] || !focus.done) say(`［完了］の後の焦点が ${String(focus.key)}${focus.done ? " の［完了］" : ""}（${String(before[1])} の［完了］のはず）`);
          await shot(page, `${p}-a-deck-done`);
          // 元に戻す（一時 DB を後ろの段のために戻す）
          if (notice !== null) await page.click(`${UNDO} >> text=取り消す`);
          const back = await page
            .waitForFunction(([sel, n]: [string, number]) => document.querySelectorAll(sel).length === n, [TASK, before.length] as [string, number], { timeout: 5000 })
            .then(() => true, () => false);
          if (!back) throw new Error(`［取り消す］で列が戻らない（${(await keys()).length} 個。${before.length} 個のはず）`);
          await settled(page);
          // ［取り消す］で戻っても、列は焦点を奪わない
          if (await page.evaluate(() => document.querySelector("#c-deck-root")?.contains(document.activeElement) === true)) say("［取り消す］の後に焦点が列の中へ移る");
          for (const line of problems) logLines.push(`[v3-${p}] ${line}`);
          if (problems.length > 0) throw new Error(`列の中の操作の検査で ${problems.length} 件`);
        });
      }
      // 列のリマインドの操作（#472 の PR-1。ダークの PC だけ）: 操作の行（当たり・1 行・字の端の揃え）、［次を飛ばす］で並びが入れ替わり焦点が残る・知らせ、
      // ［止める］の確認 → OK で 1 つ減る・知らせ・焦点が次のリマインドの［止める］。撮った後にリマインドを入れ直す（後ろの段のため）
      if (vp === "pc" && theme === "dark") {
        await step(`${p} rem`, [`${p}-a-deck-rem`], async () => {
          const REM = '#c-deck-root .c-col[data-col="tasks"] .c-item[data-kind="reminder"]';
          const TOAST = '#c-notice-root .c-toast-list[role="status"]';
          const problems: string[] = [];
          const say = (text: string): void => void problems.push(`列のリマインド: ${text}`);
          try {
            await load(page, "/");
            await page.waitForFunction((sel: string) => document.querySelectorAll(sel).length === 2, REM, { timeout: 5000 });
            await settled(page);
            const keys = (): Promise<string[]> => page.evaluate((sel: string) => [...document.querySelectorAll(sel)].map((el) => el.getAttribute("data-key") ?? ""), REM);
            const toast = (): Promise<string> => page.evaluate((sel: string) => (document.querySelector(sel)?.textContent ?? "").trim(), TOAST);
            // 操作の行: 繰り返しは 2 つ・1 回だけは 1 つ、ボタンは 1 行で項目の中、［次を飛ばす］の字の左端は題の左端・［止める］の字の右端は時刻の右端
            const rows = await page.evaluate((sel: string) => {
              return [...document.querySelectorAll(sel)].map((item) => {
                const box = item.getBoundingClientRect();
                const btns = [...item.querySelectorAll(".c-item-ops .c-btn")];
                const label = (b: Element | undefined): DOMRect | null => b?.querySelector(".c-btn-label")?.getBoundingClientRect() ?? null;
                const title = item.querySelector(".c-item-title")?.getBoundingClientRect() ?? null;
                const time = item.querySelector(".c-item-time")?.getBoundingClientRect() ?? null;
                return {
                  key: item.getAttribute("data-key") ?? "",
                  row: item.getAttribute("data-ops"),
                  texts: btns.map((b) => (b.textContent ?? "").trim()),
                  tops: btns.map((b) => b.getBoundingClientRect().top),
                  outside: btns.some((b) => b.getBoundingClientRect().left < box.left - 0.5 || b.getBoundingClientRect().right > box.right + 0.5),
                  first: btns.length > 1 && title !== null ? (label(btns[0])?.left ?? 0) - title.left : 0,
                  last: time !== null ? (label(btns.at(-1))?.right ?? 0) - time.right : NaN,
                };
              });
            }, REM);
            for (const r of rows) {
              if (r.row !== "row") say(`${r.key} に data-ops="row" が無い`);
              if (new Set(r.tops.map((t) => Math.round(t))).size > 1) say(`${r.key} のボタンが 1 行に入らない`);
              if (r.outside) say(`${r.key} のボタンが項目の外`);
              if (Math.abs(r.first) > 1.5) say(`${r.key} の［次を飛ばす］の字の左端が題の左端から ${r.first.toFixed(1)}`);
              if (!(Math.abs(r.last) <= 1.5)) say(`${r.key} の［止める］の字の右端が時刻の右端から ${r.last.toFixed(1)}`);
            }
            if (JSON.stringify(rows.map((r) => r.texts)) !== JSON.stringify([["次を飛ばす", "止める"], ["止める"]])) say(`操作の字 ${JSON.stringify(rows.map((r) => r.texts))}`);
            for (const line of await page.evaluate(hitProblems, { min: 44, scopes: '#c-deck-root .c-col[data-col="tasks"]', targets: ".c-item-ops .c-btn", toast: false })) say(line);
            const before = await keys();
            // ［次を飛ばす］: 確認なし・知らせ・並びが入れ替わる（毎日の次の回が 1 回だけの後へ）・焦点は押したボタンに残る
            await page.locator(`${REM}[data-key="${before[0]}"] .c-item-ops .c-btn`).filter({ hasText: /^次を飛ばす$/ }).click();
            const swapped = await page
              .waitForFunction(([sel, first]: [string, string]) => document.querySelectorAll(sel)[1]?.getAttribute("data-key") === first, [REM, before[0]!] as [string, string], { timeout: 5000 })
              .then(() => true, () => false);
            if (!swapped) say(`［次を飛ばす］の後の並びが ${(await keys()).join(",")}（${before[1]},${before[0]} のはず）`);
            await page.waitForFunction((sel: string) => (document.querySelector(sel)?.textContent ?? "").includes("次の回を飛ばしました"), TOAST, { timeout: 5000 }).catch(() => undefined);
            if (!(await toast()).includes("次の回を飛ばしました。次は ")) say(`［次を飛ばす］の知らせが「${(await toast()).slice(0, 40)}」`);
            if (await page.evaluate(() => document.querySelector("dialog[open]") !== null)) say("［次を飛ばす］で確認が出た");
            await settled(page);
            const kept = await page.evaluate((sel: string) => {
              const a = document.activeElement;
              const item = a === null ? null : a.closest(sel);
              return { key: item === null ? null : item.getAttribute("data-key"), text: (a?.textContent ?? "").trim(), tag: a?.tagName ?? null };
            }, REM);
            if (kept.key !== before[0] || kept.text !== "次を飛ばす") say(`［次を飛ばす］の後の焦点が ${String(kept.key)}「${kept.text}」（${String(kept.tag)}。${before[0]} の［次を飛ばす］のはず）`);
            // ［止める］（先頭の 1 回だけ）: 確認が開くまで送らない・確認の字 → 撮る → OK で 1 つ減る・知らせ・焦点は次のリマインドの［止める］
            const order = await keys();
            await page.locator(`${REM}[data-key="${order[0]}"] .c-item-ops .c-btn`).filter({ hasText: /^止める$/ }).click();
            const asked = await page.waitForSelector("dialog.c-sheet[open] .c-confirm-body", { timeout: 5000 }).then(() => true, () => false);
            await settled(page);
            const ask = await page.evaluate(() => {
              const open = document.querySelector("dialog.c-sheet[open]");
              return {
                title: (open?.querySelector("h2")?.textContent ?? "").trim(),
                target: (open?.querySelector(".c-confirm-target")?.textContent ?? "").trim(),
                body: (open?.querySelector(".c-confirm-body")?.textContent ?? "").trim(),
                ok: [...(open?.querySelectorAll(".c-btn") ?? [])].map((b) => `${(b.textContent ?? "").trim()}:${b.getAttribute("data-kind")}`),
              };
            });
            if (!asked || ask.title !== "止めますか" || ask.target !== "「ゴミの分別表を冷蔵庫に貼る」" || ask.body !== "止めたリマインドは戻せません。") say(`確認が ${JSON.stringify(ask)}`);
            if (!ask.ok.includes("止める:danger")) say(`確認のボタンが ${ask.ok.join("・")}（［止める］は danger のはず）`);
            if ((await keys()).length !== 2) say("確認の間に項目が減った");
            await shot(page, `${p}-a-deck-rem`);
            await page.locator("dialog.c-sheet[open] .c-btn").filter({ hasText: /^止める$/ }).click();
            const gone = await page
              .waitForFunction(([sel, key]: [string, string]) => document.querySelectorAll(sel).length === 1 && document.querySelector(sel)?.getAttribute("data-key") !== key, [REM, order[0]!] as [string, string], { timeout: 5000 })
              .then(() => true, () => false);
            if (!gone) say(`［止める］の後の列が ${(await keys()).join(",")}（${order[1]} だけのはず）`);
            await page.waitForFunction((sel: string) => (document.querySelector(sel)?.textContent ?? "").includes("を止めました"), TOAST, { timeout: 5000 }).catch(() => undefined);
            if (!(await toast()).includes("「ゴミの分別表を冷蔵庫に貼る」を止めました")) say(`［止める］の知らせが「${(await toast()).slice(0, 40)}」`);
            await settled(page);
            const next = await page.evaluate((sel: string) => {
              const a = document.activeElement;
              const item = a === null ? null : a.closest(sel);
              return { key: item === null ? null : item.getAttribute("data-key"), text: (a?.textContent ?? "").trim(), tag: a?.tagName ?? null };
            }, REM);
            if (next.key !== order[1] || next.text !== "止める") say(`［止める］の後の焦点が ${String(next.key)}「${next.text}」（${String(next.tag)}。${order[1]} の［止める］のはず）`);
          } finally {
            // 後ろの段のためにリマインドを入れ直す
            fixture.resetReminders();
          }
          for (const line of problems) logLines.push(`[v3-${p}] ${line}`);
          if (problems.length > 0) throw new Error(`列のリマインドの検査で ${problems.length} 件`);
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
        const problems = [...(await checkTop(page, vp, "会話")), ...(await liveTalkLines(page, vp, "会話", { agent: 1, owner: 1, pre: 1 }))];
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
        // accent の塗りの量（D3）
        const accentLines = await page.evaluate(accentProblems, { label: "会話の下", areaMax: ACCENT_AREA_MAX, bigMax: ACCENT_BIG_MAX });
        for (const line of accentLines) logLines.push(`[v3-${p}] ${line}`);
        if (accentLines.length > 0) throw new Error(`accent の塗りの検査で ${accentLines.length} 件`);
      });
      // 本番の見出しの段（ダークの 3 組）
      if (theme === "dark") {
        const tops = [`${p}-b-top-long`, `${p}-b-top-menu`, `${p}-b-top-place`, ...(vp === "pc" ? [`${p}-b-top-seat-narrow`] : [])];
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
      // タブレット: ［広げる］で右腕の会話を席に開く検査だけ（絵は撮らない。D6 の PR-6b）。--only では席の絵（a-deck-seat）と一緒に回す。右腕を開くので、この組の最後の段
      if (vp === "tablet") {
        await step(`${p} seat-hand`, [`${p}-a-deck-seat`], async () => {
          const problems = await handSeatLines(page, null);
          for (const line of problems) logLines.push(`[v3-${p}] ${line}`);
          if (problems.length > 0) throw new Error(`［広げる］の検査で ${problems.length} 件`);
        });
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
      const handName = `${p}-c-hand-over`;
      await step(`${p} c`, vp === "phone" ? [handName] : [handName, `${p}-c-hand-with-chat`], async () => {
        await load(page, "/");
        const orbLines: string[] = [];
        if (vp === "phone") {
          await page.click(BAR_HAND);
        } else {
          const show = await handShow(page);
          // 広い幅の流れの列の口は右下の丸（D6）
          if ((await deckOn(page)) && show !== ORB) orbLines.push(`右腕の丸: 列だけの画面の右腕の口が ${show}（丸のはず）`);
          const expanded = await page.getAttribute(show, "aria-expanded");
          if (expanded !== "true") await page.click(show);
        }
        await settled(page);
        // 丸で開いた枠の焦点は枠の中（最初に開いた枠は中身を読み込む前なので、入力欄か［畳む］。openHand の今の決まり。読み込んだ後に開いた入力欄は下の 2 回目で見る）
        if (vp !== "phone" && (await deckOn(page)) && !(await activeIs(page, "#v3-hand *"))) orbLines.push(`右腕の丸: 丸で開いた枠の焦点が枠の中に無い（${await activeTag(page)}）`);
        // 枠の見出しの［広げる］は広い幅の流れの列だけ（D6 の PR-6b）。スマホには無い
        {
          const seats = await page.evaluate((sel: string) => document.querySelectorAll(sel).length, HAND_SEAT);
          const want = vp !== "phone" && (await deckOn(page)) ? 1 : 0;
          if (seats !== want) orbLines.push(`右腕の［広げる］が ${seats} 個（${want} のはず）`);
        }
        // 流れの列の形の枠は 帯の下から・幅 420・線なし（D6 の PR-2。落ち先の形は見ない）
        if (await deckOn(page)) orbLines.push(...(await handFrameLines(page, vp)));
        await shot(page, handName);
        // 開いた右腕の中は部品（最後に札の［開く］を押す）
        const problems = [...orbLines, ...(await handPartsLines(page, vp, vp === "phone"))];
        // 右腕の中（#v3-hand-ed）の地は、流れの列の形では板（--surface。D3 の PR-1）、落ち先の形では --bg
        problems.push(
          ...(await page.evaluate(() => {
            const probe = document.createElement("span");
            document.body.append(probe);
            const deck = document.querySelector("#v3")?.hasAttribute("data-deck") === true;
            probe.style.color = deck ? "var(--surface)" : "var(--bg)";
            const want = getComputedStyle(probe).color;
            probe.remove();
            const ed = document.querySelector("#v3-hand-ed");
            if (ed === null) return ["右腕の中（#v3-hand-ed）が無い"];
            const got = getComputedStyle(ed).backgroundColor;
            return got === want ? [] : [`右腕の中の地 ${got}（${deck ? "--surface" : "--bg"} ${want} のはず）`];
          })),
        );
        for (const line of problems) logLines.push(`[v3-${p}] ${line}`);
        if (problems.length > 0) throw new Error(`右腕の段の検査で ${problems.length} 件`);
        if (vp !== "phone") {
          await load(page, `/#/ch/${open}`);
          await page.waitForSelector('#ed .c-msg[data-who="agent"]', { timeout: 5000 });
          await settled(page);
          await shot(page, `${p}-c-hand-with-chat`);
          // 右腕の丸（D6）: 席が開いている間も丸で開き、Esc で閉じると焦点は丸に戻る。2 回目（中身を読み込んだ後）に開いた枠の焦点は入力欄
          if (await deckOn(page)) {
            const after: string[] = [];
            for (const round of [1, 2]) {
              await page.click(ORB);
              await page.waitForSelector('#v3[data-hand="open"]', { timeout: 5000 });
              await page.waitForSelector("#v3-hand-ed textarea", { timeout: 5000 });
              await settled(page);
              const inside = round === 1 ? "#v3-hand *" : "#v3-hand-ed textarea";
              if (!(await activeIs(page, inside))) after.push(`右腕の丸: 席が開いている間に丸で開いた枠（${round} 回目）の焦点が${round === 1 ? "枠の中" : "入力欄"}に無い（${await activeTag(page)}）`);
              if ((await page.getAttribute(ORB, "aria-expanded")) !== "true") after.push(`右腕の丸: 枠が開いているのに aria-expanded が true でない（${round} 回目）`);
              // 席が開いている間の枠も同じ形で、丸（枠の左）は幕の下
              if (round === 2) after.push(...(await handFrameLines(page, vp)));
              await page.keyboard.press("Escape");
              await page.waitForSelector('#v3[data-hand="closed"]', { timeout: 5000 });
              await settled(page);
              if (!(await activeIs(page, ORB))) after.push(`右腕の丸: Esc で枠を閉じた後の焦点が丸に無い（${round} 回目。${await activeTag(page)}）`);
            }
            for (const line of after) logLines.push(`[v3-${p}] ${line}`);
            if (after.length > 0) throw new Error(`右腕の丸の検査で ${after.length} 件`);
          }
        }
      });
      // 席だけの幅（幅 700 で席を開いた。D6。ダークの PC だけ）: 丸は無く帯に［右腕］が 1 つで、押すと枠（焦点は入力欄。Esc で帯の［右腕］へ）。
      // 席を閉じると丸が 1 つ・帯の［右腕］は 0。右腕を開くので、右腕を開く段 c の後に置く。幅は段の終わりで戻す
      if (vp === "pc" && theme === "dark") {
        await step(`${p} solo`, [`${p}-a-deck-solo`], async () => {
          const problems: string[] = [];
          const say = (text: string): void => void problems.push(`席だけの幅（700）: ${text}`);
          const count = (): Promise<{ orbs: number; hands: number; tone: string | null; deck: string | null }> =>
            page.evaluate(
              ({ orbSel, handSel }: { orbSel: string; handSel: string }) => ({
                orbs: document.querySelectorAll(orbSel).length,
                hands: document.querySelectorAll(handSel).length,
                tone: document.querySelector(orbSel)?.getAttribute("data-tone") ?? null,
                deck: document.querySelector("#v3")?.getAttribute("data-deck") ?? null,
              }),
              { orbSel: ORB, handSel: bandButton("hand") },
            );
          await page.setViewportSize({ width: 700, height: VIEWPORTS.pc.viewport.height });
          try {
            await load(page, "/");
            await page.waitForSelector("#v3[data-deck] #c-deck-root .c-deck .c-col", { timeout: 5000 });
            await settled(page);
            const list = await count();
            if (list.orbs !== 1 || list.hands !== 0 || list.tone !== "accent") say(`列だけの間の丸が ${list.orbs} 個（顔 ${String(list.tone)}）・帯の［右腕］が ${list.hands} 個（丸 1 つ accent・帯 0 のはず）`);
            await page.locator('#c-deck-root .c-col[data-col="turn"] .c-item[data-turn="true"] button.c-item-main').first().click();
            await page.waitForSelector('#v3[data-view="body"] #ed textarea', { timeout: 5000 });
            await settled(page);
            const seat = await count();
            if (seat.deck !== "0") say(`席を開いた data-deck が ${String(seat.deck)}（0 のはず）`);
            if (seat.orbs !== 0 || seat.hands !== 1) say(`席を開いた間の丸が ${seat.orbs} 個・帯の［右腕］が ${seat.hands} 個（丸 0・帯 1 のはず）`);
            problems.push(...(await page.evaluate(accentProblems, { label: "席だけの幅", areaMax: ACCENT_AREA_MAX, bigMax: ACCENT_BIG_MAX })));
            await shot(page, `${p}-a-deck-solo`);
            // 帯の［右腕］で枠が開き、Esc で閉じると焦点は帯の［右腕］
            await page.click(bandButton("hand"));
            await page.waitForSelector('#v3[data-hand="open"]', { timeout: 5000 });
            await settled(page);
            // 最初に開いた枠は中身を読み込む前なので、焦点は入力欄か［畳む］（openHand の今の決まり。読み込んだ後に開くと入力欄。段 c の 2 回目で見る）
            if (!(await activeIs(page, "#v3-hand *"))) say(`帯の［右腕］で開いた枠の焦点が枠の中に無い（${await activeTag(page)}）`);
            // 席だけの幅（data-seat は fold）でも枠は 帯の下から・幅 420・左の線なし。丸は無い
            for (const line of await handFrameLines(page, vp, false)) say(line);
            await page.keyboard.press("Escape");
            await page.waitForSelector('#v3[data-hand="closed"]', { timeout: 5000 });
            await settled(page);
            if (!(await activeIs(page, bandButton("hand")))) say(`枠を閉じた後の焦点が帯の［右腕］に無い（${await activeTag(page)}）`);
            // 席を閉じると丸に戻る
            await page.evaluate(() => history.back());
            await page.waitForSelector('#v3[data-view="list"]', { timeout: 5000 });
            await settled(page);
            const back = await count();
            if (back.orbs !== 1 || back.hands !== 0 || back.tone !== "accent") say(`席を閉じた後の丸が ${back.orbs} 個（顔 ${String(back.tone)}）・帯の［右腕］が ${back.hands} 個（丸 1 つ accent・帯 0 のはず）`);
            // ［広げる］で席に右腕を開くと席が全面（丸なし・帯の［右腕］1 つ）で、帯の［右腕］は枠を開かず席の入力欄へ（D6 の PR-6b）
            await page.click(ORB);
            await page.waitForSelector('#v3[data-hand="open"]', { timeout: 5000 });
            await page.waitForSelector("#v3-hand-ed textarea", { timeout: 5000 });
            await settled(page);
            await page.click(HAND_SEAT);
            await page.waitForSelector('#v3[data-hand="closed"][data-view="body"] #ed textarea', { timeout: 5000 });
            await settled(page);
            const seated = await count();
            if (seated.deck !== "0" || seated.orbs !== 0 || seated.hands !== 1) say(`［広げる］の後の data-deck が ${String(seated.deck)}・丸が ${seated.orbs} 個・帯の［右腕］が ${seated.hands} 個（0・0・1 のはず）`);
            await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
            await page.click(bandButton("hand"));
            await settled(page);
            if ((await page.getAttribute("#v3", "data-hand")) !== "closed") say("席に右腕が出ている間の帯の［右腕］で枠が開いた");
            if (!(await activeIs(page, "#ed textarea"))) say(`席に右腕が出ている間の帯の［右腕］の後の焦点が席の入力欄に無い（${await activeTag(page)}）`);
            await page.evaluate(() => history.back());
            await page.waitForSelector('#v3[data-view="list"]', { timeout: 5000 });
            await settled(page);
          } finally {
            await page.setViewportSize(VIEWPORTS.pc.viewport);
          }
          for (const line of problems) logLines.push(`[v3-${p}] ${line}`);
          if (problems.length > 0) throw new Error(`席だけの幅の検査で ${problems.length} 件`);
        });
        // ［広げる］で右腕の会話を席に開く（D6 の PR-6b）。右腕を開くので段 c の後に置く
        await step(`${p} seat-hand`, [`${p}-c-hand-seat`], async () => {
          const problems = await handSeatLines(page, `${p}-c-hand-seat`);
          for (const line of problems) logLines.push(`[v3-${p}] ${line}`);
          if (problems.length > 0) throw new Error(`［広げる］の検査で ${problems.length} 件`);
        });
      }
      await step(`${p} e`, [`${p}-e-start-dialog`], async () => {
        await load(page, "/");
        // 流れの列は帯の［＋ 始める］から、ほかは群の見出しの [+] から
        if (await deckOn(page)) await page.click(bandButton("start"));
        else await page.locator("#c-list-root .c-group-head > .c-iconbtn").first().click();
        await settled(page);
        await shot(page, `${p}-e-start-dialog`);
        const frame = await sheetFrame(page, "#v3-start[open]", "始める板");
        for (const line of frame) logLines.push(`[v3-${p}] ${line}`);
        if (frame.length > 0) throw new Error(`始める板の枠の検査で ${frame.length} 件`);
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
    const args = { demos: TALK_DEMOS, max: TALK_MAX[vp], owner: TALK_OWNER, need: { agent: 1, owner: 1, pre: 1 }, fontSize: TALK_FONT[vp] };
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

  /** 見本の右腕（--c-hand-w = 420px の箱）: 見出しと札の形、見出しの［広げる］の 2 つの見本、横にはみ出さない事、当たり（PC でも 44）。足りない物は 1 行ずつ console.log に書き、1 つでもあれば投げて段を失敗にする */
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
      if (bubbles !== 2) out.push(`右腕: 本文の箱が ${bubbles}（2 のはず）`);
      // 自分 1・返事 1。自分は左寄せで地 --muted、返事は地が透明（D4）
      {
        const owners = box.querySelectorAll('.c-msg[data-who="owner"] > .c-bubble');
        const agents = box.querySelectorAll('.c-msg[data-who="agent"] > .c-bubble');
        if (owners.length !== 1 || agents.length !== 1) out.push(`右腕: 自分の発言 ${owners.length}・返事 ${agents.length}（1・1 のはず）`);
        const talkEl = box.querySelector(".c-talk");
        const probe = document.createElement("span");
        probe.style.color = "var(--muted)";
        (talkEl ?? box).append(probe);
        const muted = getComputedStyle(probe).color;
        probe.remove();
        const ts = talkEl === null ? null : getComputedStyle(talkEl);
        const left = talkEl === null || ts === null ? 0 : talkEl.getBoundingClientRect().left + parseFloat(ts.paddingLeft);
        const pads = (el: Element): string => {
          const cs = getComputedStyle(el);
          return [cs.paddingTop, cs.paddingRight, cs.paddingBottom, cs.paddingLeft].join(" ");
        };
        for (const el of owners) {
          if (getComputedStyle(el).backgroundColor !== muted) out.push(`右腕: 自分の発言の地 ${getComputedStyle(el).backgroundColor}（--muted ${muted} のはず）`);
          if (pads(el) !== "10px 14px 10px 14px") out.push(`右腕: 自分の発言の余白 ${pads(el)}（10px 14px 10px 14px のはず）`);
          const row = el.parentElement;
          if (row === null || Math.abs(row.getBoundingClientRect().left - left) > 0.5) out.push(`右腕: 自分の発言の左端 ${row?.getBoundingClientRect().left.toFixed(1) ?? "なし"}（会話の中身の左端 ${left.toFixed(1)} のはず）`);
        }
        for (const el of agents) {
          const c = getComputedStyle(el).backgroundColor;
          if (!(c === "transparent" || /^rgba\(.*,\s*0\)$/.test(c))) out.push(`右腕: 返事の本文の箱の地 ${c}（透明のはず）`);
          if (pads(el) !== "0px 0px 0px 0px") out.push(`右腕: 返事の本文の箱の余白 ${pads(el)}（0 のはず）`);
        }
      }
      if ([...box.querySelectorAll(".c-bubble")].some((el) => (el.textContent ?? "").includes("<#"))) out.push("右腕: 返事の本文に <# が残っている");
      if (box.scrollWidth > box.clientWidth) out.push(`右腕: 箱が横にはみ出している（${box.scrollWidth} > ${box.clientWidth}）`);
      const b = box.getBoundingClientRect();
      for (const el of box.querySelectorAll(".c-hand-head, .c-hand-act, .c-msg, .c-bubble, .c-refs, .c-ref, .c-ref-title, .c-ref .c-btn")) {
        const r = el.getBoundingClientRect();
        if (r.left < b.left - 0.5 || r.right > b.right + 0.5) out.push(`右腕: ${el.className} が箱の外（${r.left.toFixed(1)}〜${r.right.toFixed(1)}、箱 ${b.left.toFixed(1)}〜${b.right.toFixed(1)}）`);
      }
      for (const el of box.querySelectorAll(".c-ref-title, .c-hand-title")) if (el.scrollWidth > el.clientWidth + 1 && getComputedStyle(el).textOverflow !== "ellipsis") out.push(`右腕: ${el.className} が省かれずにはみ出している`);
      // 見出しの［広げる］の見本（seat。#463 の D6）: 並びは 題・広げる・（…）・畳む、［広げる］はアイコンだけで名前「広げる」、題と次のボタンの間に在り、どれも箱の中、題は省かれない（当たりは下の hitProblems が節ごと測る）
      for (const [demo, want] of [["hand-seat", "seat,menu,close"], ["hand-seat-bare", "seat,close"]] as const) {
        const seatBox = document.querySelector(`[data-section="hand"] [data-demo="${demo}"] .c-gallery-hand`);
        if (seatBox === null) {
          out.push(`右腕: ${demo} の見本の箱が無い`);
          continue;
        }
        const seatActs = [...seatBox.querySelectorAll(".c-hand-head [data-act]")].map((el) => el.getAttribute("data-act"));
        if (seatActs.join(",") !== want) out.push(`右腕: ${demo} の見出しのボタン ${seatActs.join(",")}（${want} のはず）`);
        const buttons = seatBox.querySelectorAll(".c-hand-head [data-act] > button").length;
        if (buttons !== want.split(",").length) out.push(`右腕: ${demo} の見出しのボタンが ${buttons}（${want.split(",").length} のはず）`);
        const seatBtn = seatBox.querySelector('.c-hand-head [data-act="seat"] > button');
        const title = seatBox.querySelector(".c-hand-head h2.c-hand-title");
        const next = seatBox.querySelector('.c-hand-head [data-act="seat"] + [data-act]');
        if (seatBtn === null || title === null || next === null) {
          out.push(`右腕: ${demo} の［広げる］・題・次のボタンのどれかが無い`);
          continue;
        }
        if (seatBtn.getAttribute("aria-label") !== "広げる") out.push(`右腕: ${demo} の［広げる］の名前が ${JSON.stringify(seatBtn.getAttribute("aria-label"))}（「広げる」のはず）`);
        if ((seatBtn.textContent ?? "").trim() !== "" || seatBtn.querySelectorAll("svg").length !== 1) out.push(`右腕: ${demo} の［広げる］がアイコン 1 つだけでない`);
        const tr = title.getBoundingClientRect();
        const sr = seatBtn.getBoundingClientRect();
        const nr = next.getBoundingClientRect();
        if (sr.left < tr.right - 0.5 || sr.right > nr.left + 0.5) out.push(`右腕: ${demo} の［広げる］（${sr.left.toFixed(1)}〜${sr.right.toFixed(1)}）が題の右端 ${tr.right.toFixed(1)} と次のボタンの左端 ${nr.left.toFixed(1)} の間に無い`);
        if (title.scrollWidth > title.clientWidth + 1 || tr.width < 1) out.push(`右腕: ${demo} の題が押し出されている（${title.scrollWidth} > ${title.clientWidth}）`);
        if (seatBox.scrollWidth > seatBox.clientWidth) out.push(`右腕: ${demo} の箱が横にはみ出している（${seatBox.scrollWidth} > ${seatBox.clientWidth}）`);
        const sb = seatBox.getBoundingClientRect();
        for (const el of seatBox.querySelectorAll(".c-hand-head, .c-hand-act, .c-hand-title")) {
          const r = el.getBoundingClientRect();
          if (r.left < sb.left - 0.5 || r.right > sb.right + 0.5) out.push(`右腕: ${demo} の ${el.className} が箱の外（${r.left.toFixed(1)}〜${r.right.toFixed(1)}、箱 ${sb.left.toFixed(1)}〜${sb.right.toFixed(1)}）`);
        }
      }
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

  /**
   * 見本の右腕の丸（#463 の D6）: 8 つの見本（accent・静か × 印なし・番・未読・作業中）が 56×56 で角丸が半分以上、svg が 1 つ・字なし、
   * accent の顔の地が --accent で輪郭 0、静かな顔の地が --surface で輪郭 1px、名前（aria-label と title）、印の数と丸の箱の中に在る事。
   * 足りない物は 1 行ずつ console.log に書き、1 つでもあれば投げて段を失敗にする
   */
  async function checkOrbs(page: Page, label: string): Promise<void> {
    const lines = await page.evaluate(() => {
      const out: string[] = [];
      const NAME = "右腕に頼む・訊く";
      const demos: ReadonlyArray<[string, string, string]> = [
        ["orb-accent", "accent", ""],
        ["orb-accent-turn", "accent", "turn"],
        ["orb-accent-unread", "accent", "unread"],
        ["orb-accent-running", "accent", "running"],
        ["orb-quiet", "quiet", ""],
        ["orb-quiet-turn", "quiet", "turn"],
        ["orb-quiet-unread", "quiet", "unread"],
        ["orb-quiet-running", "quiet", "running"],
      ];
      const colorOf = (host: Element, value: string): string => {
        const probe = document.createElement("span");
        probe.style.backgroundColor = value;
        host.append(probe);
        const c = getComputedStyle(probe).backgroundColor;
        probe.remove();
        return c;
      };
      const all = document.querySelectorAll('[data-section="orb"] .c-orb').length;
      if (all !== demos.length) out.push(`丸: 見本の丸が ${all}（${demos.length} のはず）`);
      for (const [demo, tone, mark] of demos) {
        const orbs = document.querySelectorAll(`[data-section="orb"] [data-demo="${demo}"] > button.c-orb`);
        if (orbs.length !== 1) {
          out.push(`丸 ${demo}: 丸が ${orbs.length}（1 のはず）`);
          continue;
        }
        const orb = orbs[0] as HTMLElement;
        const r = orb.getBoundingClientRect();
        const cs = getComputedStyle(orb);
        if (Math.abs(r.width - 56) > 0.5 || Math.abs(r.height - 56) > 0.5) out.push(`丸 ${demo}: 箱が ${r.width.toFixed(1)}×${r.height.toFixed(1)}（56×56 のはず）`);
        if (parseFloat(cs.borderTopLeftRadius) < r.width / 2) out.push(`丸 ${demo}: 角丸が ${cs.borderTopLeftRadius}（${(r.width / 2).toFixed(1)}px 以上のはず）`);
        if (orb.getAttribute("data-tone") !== tone) out.push(`丸 ${demo}: data-tone が ${orb.getAttribute("data-tone")}（${tone} のはず）`);
        const svgs = orb.querySelectorAll("svg").length;
        if (svgs !== 1) out.push(`丸 ${demo}: svg が ${svgs}（1 のはず）`);
        if ((orb.textContent ?? "").trim() !== "") out.push(`丸 ${demo}: 字が在る ${JSON.stringify(orb.textContent)}`);
        const bg = cs.backgroundColor;
        const want = colorOf(orb.parentElement ?? orb, tone === "accent" ? "var(--accent)" : "var(--surface)");
        if (bg !== want) out.push(`丸 ${demo}: 地が ${bg}（${tone === "accent" ? "--accent" : "--surface"} ${want} のはず）`);
        const borders = [cs.borderTopWidth, cs.borderRightWidth, cs.borderBottomWidth, cs.borderLeftWidth];
        const wantBorder = tone === "accent" ? "0px" : "1px";
        if (borders.some((w) => w !== wantBorder)) out.push(`丸 ${demo}: 輪郭が ${borders.join(" ")}（${wantBorder} のはず）`);
        if (cs.boxShadow !== "none") out.push(`丸 ${demo}: 影が在る ${cs.boxShadow}`);
        const name = mark === "turn" ? `${NAME}（あなたの番）` : mark === "unread" ? `${NAME}（未読）` : mark === "running" ? `${NAME}（作業中）` : NAME;
        if (orb.getAttribute("aria-label") !== name || orb.getAttribute("title") !== name) out.push(`丸 ${demo}: 名前が ${JSON.stringify(orb.getAttribute("aria-label"))}・title ${JSON.stringify(orb.getAttribute("title"))}（「${name}」のはず）`);
        if (orb.hasAttribute("id")) out.push(`丸 ${demo}: id が在る`);
        // 印: accent の顔は自前の点、静かな顔は K2 の Mark。丸の箱の中に収まる
        const dots = orb.querySelectorAll(tone === "accent" ? ".c-orb-dot" : ".c-mark");
        const others = orb.querySelectorAll(tone === "accent" ? ".c-mark" : ".c-orb-dot").length;
        const wantDots = mark === "" ? 0 : 1;
        if (dots.length !== wantDots || others !== 0) out.push(`丸 ${demo}: 印が ${dots.length}・違う顔の印が ${others}（${wantDots}・0 のはず）`);
        for (const dot of dots) {
          if (dot.getAttribute("data-state") !== mark) out.push(`丸 ${demo}: 印の data-state が ${dot.getAttribute("data-state")}（${mark} のはず）`);
          const d = dot.getBoundingClientRect();
          if (d.width < 1 || d.height < 1) out.push(`丸 ${demo}: 印の大きさが ${d.width.toFixed(1)}×${d.height.toFixed(1)}`);
          if (d.left < r.left - 0.5 || d.right > r.right + 0.5 || d.top < r.top - 0.5 || d.bottom > r.bottom + 0.5) out.push(`丸 ${demo}: 印が丸の箱の外`);
          // 印の箱の 4 隅（輪の box-shadow が在ればその分だけ広げる）が円の中（中心から 箱の幅 / 2 以内）。外に出ると地が顔の色でなくなる
          const shadow = getComputedStyle(dot).boxShadow;
          const ring = shadow === "none" ? 0 : Math.max(0, ...[...shadow.matchAll(/(-?[\d.]+)px/g)].map((m) => parseFloat(m[1] ?? "0")));
          const cx = r.left + r.width / 2;
          const cy = r.top + r.height / 2;
          const far = Math.max(
            ...[
              [d.left - ring, d.top - ring],
              [d.right + ring, d.top - ring],
              [d.left - ring, d.bottom + ring],
              [d.right + ring, d.bottom + ring],
            ].map(([x, y]) => Math.hypot((x ?? 0) - cx, (y ?? 0) - cy)),
          );
          if (far > r.width / 2 + 0.5) out.push(`丸 ${demo}: 印（輪 ${ring}px を含む）の隅が円の外（中心から ${far.toFixed(1)}、半径 ${(r.width / 2).toFixed(1)}）`);
          // 印は右上（中心より右・上）
          if (d.left + d.width / 2 <= cx || d.top + d.height / 2 >= cy) out.push(`丸 ${demo}: 印が右上でない`);
        }
      }
      return out;
    });
    for (const line of lines) logLines.push(`[${label}] ${line}`);
    if (lines.length > 0) throw new Error(`右腕の丸の見本の検査で ${lines.length} 件`);
  }

  /**
   * 見本の右腕の口の作業中の印（#463 の D6 の PR-5）: 丸の 2 つの顔・下のバーの 2 つ（phone・deck）・スマホの見出し・帯の作業中の見本で、
   * 印が 1 つ（data-state=running）・地が透明（塗らない）・輪の太さが --c-mark-ring で実線・輪の色が口ごとの決まり（accent の地の上は --primary-text、ほかは --accent）・
   * 外寸が K2 の Mark の running と同じ（同じページの静かな丸の Mark と比べる。base.css の border-box で輪は箱の内側なので --c-mark）で、隣の番の見本の点と同じ、名前が「（作業中）」で終わる事。
   * 足りない物は 1 行ずつ console.log に書き、1 つでもあれば投げて段を失敗にする
   */
  async function checkHandRunning(page: Page, label: string): Promise<void> {
    const lines = await page.evaluate(() => {
      const out: string[] = [];
      const HAND = "右腕に頼む・訊く（作業中）";
      // [見本, 押す物, 印, 輪の色のトークン, 名前, 隣の番の見本]
      const demos: ReadonlyArray<[string, string, string, string, string, string]> = [
        ["orb-accent-running", "button.c-orb", ".c-orb-dot", "--primary-text", HAND, "orb-accent-turn"],
        ["orb-quiet-running", "button.c-orb", ".c-mark", "--accent", HAND, "orb-quiet-turn"],
        ["bottom-phone-running", ".c-bottom-hand", ".c-bottom-hand-mark", "--primary-text", HAND, "bottom-phone"],
        ["bottom-deck-running", ".c-bottom-hand", ".c-bottom-hand-mark", "--primary-text", HAND, "bottom-deck"],
        ["top-phone-running", ".c-top-hand", ".c-top-hand-mark", "--accent", HAND, "top-phone-talk"],
        ["band-running", ".c-band-hand", ".c-band-hand-mark", "--accent", "右腕（作業中）", "band"],
      ];
      const probeOf = (host: Element, css: Partial<CSSStyleDeclaration>): HTMLSpanElement => {
        const probe = document.createElement("span");
        Object.assign(probe.style, { display: "block", position: "absolute", visibility: "hidden" }, css);
        host.append(probe);
        return probe;
      };
      const colorOf = (host: Element, token: string): string => {
        const probe = probeOf(host, { backgroundColor: `var(${token})` });
        const c = getComputedStyle(probe).backgroundColor;
        probe.remove();
        return c;
      };
      const lengthOf = (host: Element, value: string): number => {
        const probe = probeOf(host, { width: value, height: "0" });
        const w = probe.getBoundingClientRect().width;
        probe.remove();
        return w;
      };
      const body = document.body;
      const ring = lengthOf(body, "var(--c-mark-ring)");
      const want = lengthOf(body, "var(--c-mark)");
      if (!(ring > 0) || !(want > ring * 2)) out.push(`作業中: トークンを測れない（輪 ${ring}・外寸 ${want}）`);
      // 同じページの K2 の Mark の running（静かな丸の中の物）
      const k2 = document.querySelector('[data-demo="orb-quiet-running"] .c-mark[data-state="running"]');
      const k2Box = k2 === null ? null : k2.getBoundingClientRect();
      if (k2Box === null) out.push("作業中: K2 の Mark の running が見本に無い");
      else if (Math.abs(k2Box.width - want) > 0.5 || Math.abs(k2Box.height - want) > 0.5) out.push(`作業中: K2 の Mark の running が ${k2Box.width.toFixed(1)}×${k2Box.height.toFixed(1)}（${want.toFixed(1)} のはず）`);
      for (const [demo, button, markSel, token, name, turnDemo] of demos) {
        const roots = document.querySelectorAll(`[data-demo="${demo}"]`);
        if (roots.length !== 1) {
          out.push(`作業中 ${demo}: 見本が ${roots.length}（1 のはず）`);
          continue;
        }
        const root = roots[0] as Element;
        const btns = root.querySelectorAll(button);
        if (btns.length !== 1) {
          out.push(`作業中 ${demo}: ${button} が ${btns.length}（1 のはず）`);
          continue;
        }
        const btn = btns[0] as HTMLElement;
        if (btn.getAttribute("aria-label") !== name) out.push(`作業中 ${demo}: 名前が ${JSON.stringify(btn.getAttribute("aria-label"))}（「${name}」のはず）`);
        if (button === "button.c-orb" && btn.getAttribute("title") !== name) out.push(`作業中 ${demo}: title が ${JSON.stringify(btn.getAttribute("title"))}（「${name}」のはず）`);
        const marks = btn.querySelectorAll(markSel);
        if (marks.length !== 1) {
          out.push(`作業中 ${demo}: 印 ${markSel} が ${marks.length}（1 のはず）`);
          continue;
        }
        const mark = marks[0] as HTMLElement;
        if (mark.getAttribute("data-state") !== "running") out.push(`作業中 ${demo}: 印の data-state が ${mark.getAttribute("data-state")}（running のはず）`);
        const cs = getComputedStyle(mark);
        if (cs.backgroundColor !== "rgba(0, 0, 0, 0)" || cs.backgroundImage !== "none") out.push(`作業中 ${demo}: 地が塗られている（${cs.backgroundColor} ${cs.backgroundImage}）`);
        if (cs.boxShadow !== "none") out.push(`作業中 ${demo}: 影が在る ${cs.boxShadow}`);
        const widths = [cs.borderTopWidth, cs.borderRightWidth, cs.borderBottomWidth, cs.borderLeftWidth].map((w) => parseFloat(w));
        if (widths.some((w) => Math.abs(w - ring) > 0.01)) out.push(`作業中 ${demo}: 輪の太さが ${widths.join(" ")}（${ring} のはず）`);
        const styles = [cs.borderTopStyle, cs.borderRightStyle, cs.borderBottomStyle, cs.borderLeftStyle];
        if (styles.some((st) => st !== "solid")) out.push(`作業中 ${demo}: 輪の線が ${styles.join(" ")}（solid のはず）`);
        const color = colorOf(btn, token);
        const colors = [cs.borderTopColor, cs.borderRightColor, cs.borderBottomColor, cs.borderLeftColor];
        if (colors.some((c) => c !== color)) out.push(`作業中 ${demo}: 輪の色が ${colors.join(" ")}（${token} ${color} のはず）`);
        const r = mark.getBoundingClientRect();
        if (Math.abs(r.width - want) > 0.5 || Math.abs(r.height - want) > 0.5) out.push(`作業中 ${demo}: 印の外寸が ${r.width.toFixed(1)}×${r.height.toFixed(1)}（K2 の Mark の running と同じ ${want.toFixed(1)} のはず）`);
        if (k2Box !== null && (Math.abs(r.width - k2Box.width) > 0.5 || Math.abs(r.height - k2Box.height) > 0.5)) out.push(`作業中 ${demo}: 印の外寸が K2 の Mark の running（${k2Box.width.toFixed(1)}）と違う`);
        const turn = document.querySelector(`[data-demo="${turnDemo}"] ${button} ${markSel}[data-state="turn"]`);
        const t = turn === null ? null : turn.getBoundingClientRect();
        if (t === null) out.push(`作業中 ${demo}: 隣の番の見本 ${turnDemo} に番の点が無い`);
        else if (Math.abs(r.width - t.width) > 0.5 || Math.abs(r.height - t.height) > 0.5) out.push(`作業中 ${demo}: 印の外寸 ${r.width.toFixed(1)} が隣の番の点（${turnDemo}）の ${t.width.toFixed(1)} と違う`);
        // 印は押す物の箱の中
        const b = btn.getBoundingClientRect();
        if (r.left < b.left - 0.5 || r.right > b.right + 0.5 || r.top < b.top - 0.5 || r.bottom > b.bottom + 0.5) out.push(`作業中 ${demo}: 印が押す物の箱の外`);
      }
      return out;
    });
    for (const line of lines) logLines.push(`[${label}] ${line}`);
    if (lines.length > 0) throw new Error(`右腕の作業中の印の見本の検査で ${lines.length} 件`);
  }

  /**
   * スマホの流れの列の見本（D2）: 下のバーの deck の 3 つ（外側 390 の枠・列 3 つと右腕・今の列は 1 つ・数の Badge は番の列だけ・4 つの字が省かれない・id なし）、
   * 帯の phone（点・探す・始める・ほかで右腕なし・「self-agent」が省かれない）、deck-paged（列 3 つが枠の幅で、1 列ずつ止まる横送り）、
   * deck-phone-ops（リマインドの操作の行が 1 行で項目の中）と当たり（PC でも 44）。
   * 足りない物は 1 行ずつ console.log に書き、1 つでもあれば投げて段を失敗にする
   */
  async function checkDeckPhone(page: Page, label: string): Promise<void> {
    const lines = await page.evaluate(() => {
      const out: string[] = [];
      const cut = (el: Element | null): boolean => el !== null && el.scrollWidth > el.clientWidth + 1;
      const bars: ReadonlyArray<[string, string, string]> = [
        ["bottom-deck", "turn", "12"],
        ["bottom-deck-running", "turn", "12"],
        ["bottom-deck-quiet", "feed", ""],
      ];
      for (const [demo, current, badge] of bars) {
        const bar = document.querySelector(`[data-demo="${demo}"] .c-bottom`);
        if (bar === null) {
          out.push(`${demo}: 下のバーが無い`);
          continue;
        }
        // 外側 390 の枠（スマホの幅）の中で、4 つの字がどれも省かれない
        const frame = bar.closest(".c-gallery-phone")?.getBoundingClientRect().width ?? 0;
        if (Math.abs(frame - 390) > 0.5) out.push(`${demo}: 枠の幅 ${frame.toFixed(1)}（390 のはず）`);
        if (bar.getAttribute("data-variant") !== "deck") out.push(`${demo}: data-variant が ${bar.getAttribute("data-variant")}（deck のはず）`);
        const texts = [...bar.querySelectorAll(":scope > button")].map((b) => (b.querySelector(".c-bottom-page-label, .c-bottom-hand-label")?.textContent ?? "").trim());
        if (texts.join(",") !== "あなたの番,タスク,通知,右腕") out.push(`${demo}: ボタンの字 ${texts.join(",")}（あなたの番,タスク,通知,右腕 のはず）`);
        const now = [...bar.querySelectorAll('[aria-current="true"]')].map((b) => b.getAttribute("data-page"));
        if (now.join(",") !== current) out.push(`${demo}: 今の列 ${now.join(",")}（${current} のはず）`);
        const badges = [...bar.querySelectorAll(".c-badge")].map((b) => `${b.closest("[data-page]")?.getAttribute("data-page") ?? "?"}:${(b.textContent ?? "").trim()}`);
        if (badges.join(",") !== (badge === "" ? "" : `turn:${badge}`)) out.push(`${demo}: 数の Badge ${badges.join(",") || "なし"}（${badge === "" ? "なし" : `turn:${badge}`} のはず）`);
        for (const el of bar.querySelectorAll(".c-bottom-page-label, .c-bottom-hand-label")) if (cut(el)) out.push(`${demo}: 「${el.textContent}」が省かれている`);
        if (bar.querySelector("[id]") !== null) out.push(`${demo}: id の付いた要素が在る`);
        if (cut(bar)) out.push(`${demo}: バーが横にはみ出している（${bar.scrollWidth} > ${bar.clientWidth}）`);
      }
      const band = document.querySelector('[data-demo="band-phone"] .c-band');
      if (band === null) out.push("band-phone: 帯が無い");
      else {
        const acts = [...band.querySelectorAll("[data-act]")].map((el) => el.getAttribute("data-act"));
        if (acts.join(",") !== "status,find,start,more") out.push(`band-phone: ボタン ${acts.join(",")}（status,find,start,more のはず）`);
        if (band.querySelector(".c-band-hand") !== null) out.push("band-phone: 右腕が在る");
        if (band.querySelector('[data-act="start"] .c-iconbtn')?.getAttribute("aria-label") !== "始める") out.push("band-phone: ［始める］が名前「始める」の IconButton でない");
        const name = band.querySelector(".c-band-name");
        if (name === null || (name.textContent ?? "") !== "self-agent" || cut(name)) out.push("band-phone: 「self-agent」が省かれているか無い");
      }
      // 丸を描けた広い幅の帯（D6）: ［右腕］が無く、探す・始める（字つき）・ほか
      const noHand = document.querySelector('[data-demo="band-no-hand"] .c-band');
      if (noHand === null) out.push("band-no-hand: 帯が無い");
      else {
        const acts = [...noHand.querySelectorAll("[data-act]")].map((el) => el.getAttribute("data-act"));
        if (acts.join(",") !== "status,find,start,more") out.push(`band-no-hand: ボタン ${acts.join(",")}（status,find,start,more のはず）`);
        if (noHand.querySelector(".c-band-hand") !== null) out.push("band-no-hand: 右腕が在る");
        const labels = [...noHand.querySelectorAll(".c-btn-label")].map((el) => (el.textContent ?? "").trim());
        if (labels.join(",") !== "探す,始める") out.push(`band-no-hand: 字つきのボタン ${labels.join(",")}（探す,始める のはず）`);
      }
      // 題つきのスマホの帯: 列の名前と数（あなたの番 は Badge・タスクは数・通知は 0 なので数なし）。題は省かれず、帯のボタンに重ならない
      const titled: ReadonlyArray<[string, string, string, string]> = [
        ["band-phone-turn", "あなたの番", "badge", "2"],
        ["band-phone-tasks", "タスク", "count", "3"],
        ["band-phone-feed", "通知", "none", ""],
      ];
      for (const [demo, title, kind, count] of titled) {
        const b = document.querySelector(`[data-demo="${demo}"] .c-band`);
        const name = b === null ? null : b.querySelector('h2.c-band-name[data-kind="page"]');
        const ops = b === null ? null : b.querySelector(".c-band-ops");
        if (b === null || name === null || ops === null) {
          out.push(`${demo}: 帯か題か帯のボタンが無い`);
          continue;
        }
        const t = name.querySelector(".c-band-title");
        if (t === null || (t.textContent ?? "").trim() !== title || cut(t)) out.push(`${demo}: 題「${t?.textContent ?? ""}」（省かれない ${title} のはず）`);
        const badge = name.querySelector(":scope > .c-badge");
        const num = name.querySelector(":scope > .c-band-count");
        const got = badge !== null && num === null ? "badge" : badge === null && num !== null ? "count" : badge === null && num === null ? "none" : "both";
        const text = ((badge ?? num)?.textContent ?? "").trim();
        if (got !== kind || text !== count) out.push(`${demo}: 数が ${got}「${text}」（${kind}「${count}」のはず）`);
        if (name.getBoundingClientRect().right > ops.getBoundingClientRect().left + 0.5) out.push(`${demo}: 題が帯のボタンに重なる`);
        if (cut(b)) out.push(`${demo}: 帯が横にはみ出している`);
      }
      // deck-idle（待機が 10 件。#505）: あなたの番の列に［ほか 2 件］が 1 つ・待機の項目が 8 個
      const idleCol = document.querySelector('[data-demo="deck-idle"] .c-col[data-col="turn"]');
      if (idleCol === null) out.push("deck-idle: あなたの番の列が無い");
      else {
        const more = [...idleCol.querySelectorAll("button.c-col-more")].map((el) => (el.textContent ?? "").trim());
        if (more.join(",") !== "ほか 2 件") out.push(`deck-idle: ［ほか n 件］が「${more.join(",")}」（「ほか 2 件」1 つのはず）`);
        const idle = idleCol.querySelectorAll('.c-item[data-kind="idle"]').length;
        if (idle !== 8) out.push(`deck-idle: 待機の項目が ${idle} 個（8 個のはず）`);
      }
      const box = document.querySelector('[data-demo="deck-paged"] .c-gallery-phone');
      const deck = box?.querySelector(".c-deck") ?? null;
      if (box === null || deck === null) out.push("deck-paged: 列が無い");
      else {
        if (deck.getAttribute("data-paged") !== "true") out.push("deck-paged: data-paged が無い");
        const outer = box.getBoundingClientRect().width;
        if (Math.abs(outer - 390) > 0.5) out.push(`deck-paged: 枠の幅 ${outer.toFixed(1)}（390 のはず）`);
        const cols = [...deck.querySelectorAll(":scope > .c-col")];
        if (cols.length !== 3) out.push(`deck-paged: 列が ${cols.length}（3 のはず）`);
        for (const col of cols) {
          const w = col.getBoundingClientRect().width;
          if (Math.abs(w - deck.clientWidth) > 0.5) out.push(`deck-paged: 列 ${col.getAttribute("data-col")} の幅 ${w.toFixed(1)}（枠の中の幅 ${deck.clientWidth} のはず）`);
        }
        const st = getComputedStyle(deck);
        if (st.scrollSnapType !== "x mandatory") out.push(`deck-paged: scroll-snap-type が ${st.scrollSnapType}`);
        if (!(deck.scrollWidth > deck.clientWidth)) out.push("deck-paged: 横に送れない");
        // 2 つ目の列の 7 割まで送ると、2 つ目の列の頭に止まる（1 列ずつ）
        const left = deck.getBoundingClientRect().left;
        deck.scrollLeft = deck.clientWidth * 0.7;
        const second = cols[1] === undefined ? NaN : cols[1].getBoundingClientRect().left - left;
        if (!(Math.abs(second) <= 1)) out.push(`deck-paged: 送った後に 2 つ目の列の頭で止まっていない（2 つ目の列の左 ${second.toFixed(1)}）`);
        deck.scrollLeft = 0;
      }
      // deck-phone-ops（タスクの列だけ・操作つき）: 枠 390 の中で、リマインドの操作の行が 1 行で項目からはみ出さない
      const opsBox = document.querySelector('[data-demo="deck-phone-ops"] .c-gallery-phone');
      const rems = opsBox === null ? [] : [...opsBox.querySelectorAll('.c-item[data-kind="reminder"]')];
      if (opsBox === null) out.push("deck-phone-ops: 枠が無い");
      else {
        const outer = opsBox.getBoundingClientRect().width;
        if (Math.abs(outer - 390) > 0.5) out.push(`deck-phone-ops: 枠の幅 ${outer.toFixed(1)}（390 のはず）`);
        if (rems.length === 0) out.push("deck-phone-ops: リマインドが無い");
        if (!rems.some((item) => item.querySelectorAll(".c-item-ops .c-btn").length === 2)) out.push("deck-phone-ops: ボタンが 2 つのリマインドが無い");
      }
      for (const item of rems) {
        const key = item.getAttribute("data-key");
        const box = item.getBoundingClientRect();
        const btns = [...item.querySelectorAll(".c-item-ops .c-btn")];
        if (btns.length === 0) out.push(`deck-phone-ops: ${key} に操作が無い`);
        if (new Set(btns.map((b) => Math.round(b.getBoundingClientRect().top))).size > 1) out.push(`deck-phone-ops: ${key} のボタンが 1 行に入らない`);
        for (const b of btns) {
          const r = b.getBoundingClientRect();
          if (r.left < box.left - 0.5 || r.right > box.right + 0.5) out.push(`deck-phone-ops: ${key} の「${(b.textContent ?? "").trim()}」が項目の外`);
          if (cut(b.querySelector(".c-btn-label"))) out.push(`deck-phone-ops: ${key} の「${(b.textContent ?? "").trim()}」が省かれている`);
        }
        if (cut(item)) out.push(`deck-phone-ops: ${key} が横にはみ出している`);
      }
      return out;
    });
    lines.push(
      ...(await page.evaluate(hitProblems, { min: 44, scopes: '[data-demo="bottom-deck"], [data-demo="bottom-deck-running"], [data-demo="bottom-deck-quiet"], [data-demo="band-phone"], [data-demo="deck-paged"], [data-demo="deck-phone-ops"]', targets: "button, a[href]", toast: false })).map(
        (line) => `スマホの流れの列: ${line}`,
      ),
    );
    for (const line of lines) logLines.push(`[${label}] ${line}`);
    if (lines.length > 0) throw new Error(`スマホの流れの列の見本の検査で ${lines.length} 件`);
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
        await checkDeckPhone(page, label);
        await checkOrbs(page, label);
        await checkHandRunning(page, label);
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
          // 見本の板・確認（c-sheet）は枠を持たない。知らせは枠のまま（幕が無い）
          if (kind !== "g-toast") {
            const frame = await sheetFrame(page, ready, `見本の ${kind} の板`);
            for (const line of frame) logLines.push(`[${label}] ${line}`);
            if (frame.length > 0) throw new Error(`板の枠の検査で ${frame.length} 件`);
          } else {
            const toast = await page.evaluate(() => [...document.querySelectorAll(".c-toast-item")].map((el) => getComputedStyle(el).borderTopWidth));
            if (toast.length === 0 || toast.some((w) => w === "0px")) {
              logLines.push(`[${label}] 知らせの枠 ${toast.join(" ")}（枠のままのはず）`);
              throw new Error("知らせの枠の検査で 1 件");
            }
          }
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
      await openFind(page);
      await page.locator('#c-list-root section.c-group[aria-label="blog-site"] .c-fold-head').first().click();
      await page.waitForSelector(`#c-list-root button[data-topic="ch:${cc.ended}"]`, { timeout: 5000 });
      await clickRow(page, `#c-list-root button[data-topic="ch:${cc.ended}"]`, "last");
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
      await clickRow(page, `#c-list-root button[data-topic="cc:${cc.term}"]`, "first");
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
