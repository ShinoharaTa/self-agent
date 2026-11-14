import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import vm from "node:vm";
import { crc32, inflateSync } from "node:zlib";
import { staticFileFor } from "../src/web/static.ts";

// Web UI の画面（src/web/static）。DOM が無いので、構文と CSP（default-src 'self'）で動く書き方かだけを確かめる
const STATIC_DIR = fileURLToPath(new URL("../src/web/static/", import.meta.url));
const files = readdirSync(STATIC_DIR);
const read = (name: string): string => readFileSync(join(STATIC_DIR, name), "utf8");
/** scripts/make-icons.ts が書くもの（docs/plan/web-ui.md §11.5） */
const ICON_FILES = ["app-icon.svg", "apple-touch-icon.png", "icon-192.png", "icon-512.png", "icon-512-maskable.png"];

test("web static: 決めたファイルがそろっていて、base.css・icons.svg は置かない（templates/web/site のものを配る）", () => {
  for (const name of [
    "index.html",
    "tokens.css",
    "app.css",
    "ui.js",
    "api.js",
    "sound.js",
    "chat.js",
    "views.js",
    "sidebar.js",
    "workbench.js",
    "v3.html",
    "shell.css",
    "shell.js",
    "topics.js",
    "icons-app.svg",
    "manifest.webmanifest",
    ...ICON_FILES,
  ]) {
    assert.ok(files.includes(name), name);
  }
  assert.equal(files.includes("base.css"), false);
  assert.equal(files.includes("icons.svg"), false);
});

test("web static: ファイル名はサーバーが配る形（/static/<name>）だけ", () => {
  for (const name of files) assert.match(name, /^[A-Za-z0-9_-]+\.(html|css|js|svg|png|webmanifest)$/, name);
});

test("web static: staticFileFor は png・webmanifest を Content-Type 付きで返し、表に無い拡張子・2 要素・名前の無いものは返さない", () => {
  const dirs = { staticDir: "/s", templateSiteDir: "/t" };
  assert.deepEqual(staticFileFor("/static/icon-192.png", dirs), { file: "/s/icon-192.png", contentType: "image/png" });
  assert.deepEqual(staticFileFor("/static/manifest.webmanifest", dirs), {
    file: "/s/manifest.webmanifest",
    contentType: "application/manifest+json; charset=utf-8",
  });
  for (const path of ["/static/x.json", "/static/a/b.png", "/static/.png", "/static/../icon-192.png", "/static/icon.png.txt"]) {
    assert.equal(staticFileFor(path, dirs), undefined, path);
  }
});

test("web static: JS はすべて node --check を通る", () => {
  const scripts = files.filter((name) => name.endsWith(".js"));
  assert.ok(scripts.length > 0);
  for (const name of scripts) {
    const result = spawnSync(process.execPath, ["--check", join(STATIC_DIR, name)], { encoding: "utf8" });
    assert.equal(result.status, 0, `${name}: ${result.stderr}`);
  }
});

test("web static: HTML に inline の script・style・style 属性・on* 属性が無い", () => {
  for (const name of files.filter((n) => n.endsWith(".html"))) {
    const html = read(name);
    for (const m of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)) {
      assert.match(m[1] ?? "", /\bsrc="\/static\/[A-Za-z0-9_-]+\.js"/, `${name}: src の無い script`);
      assert.equal((m[2] ?? "").trim(), "", `${name}: script の中身`);
    }
    assert.doesNotMatch(html, /<style\b/i, name);
    assert.doesNotMatch(html, /\sstyle=/i, name);
    assert.doesNotMatch(html, /\son[a-z]+=/i, name);
    // 外のオリジンを読まない
    assert.doesNotMatch(html, /(src|href)="(https?:)?\/\//i, name);
  }
});

test("web static: index.html の読み込みの順と既定のテーマ", () => {
  const html = read("index.html");
  assert.match(html, /<html lang="ja" data-theme="dark">/);
  const links = [...html.matchAll(/<link rel="stylesheet" href="([^"]+)">/g)].map((m) => m[1]);
  assert.deepEqual(links, ["/static/base.css", "/static/tokens.css", "/static/app.css"]);
  const scripts = [...html.matchAll(/<script src="([^"]+)" defer><\/script>/g)].map((m) => m[1]);
  assert.deepEqual(scripts, [
    "/static/ui.js",
    "/static/api.js",
    "/static/sound.js",
    "/static/chat.js",
    "/static/views.js",
    "/static/sidebar.js",
    "/static/workbench.js",
  ]);
});

test("web static: モックの「提案」「モック」・分割・ダミーのデータが残っていない", () => {
  assert.doesNotMatch(read("app.css"), /data-proposal|mock/i);
  for (const name of files.filter((n) => n.endsWith(".js") || n.endsWith(".html") || n.endsWith(".css"))) {
    const text = read(name);
    for (const word of ["data-proposal", "proposal", "only-current", "setProposals", "モック", "is-split", "moveTab", "closeGroup", "splitSash", "wb-sash-group", "draggable", "dragstart", "SA.data", "data.js", "sa-mock"]) {
      assert.equal(text.includes(word), false, `${name}: ${word}`);
    }
  }
});

test("web static: JS は style 属性・innerHTML を書かない（CSP の style-src 'self'。CSS の変数は setProperty）", () => {
  for (const name of files.filter((n) => n.endsWith(".js"))) {
    const text = read(name);
    assert.doesNotMatch(text, /setAttribute\(\s*"style"|\.innerHTML|\.outerHTML|insertAdjacentHTML|DOMParser|document\.write|\beval\(|new Function\(/, name);
  }
});

// ===== トースト（ui.js）を小さな偽の DOM と偽のタイマーで動かす =====
class FakeNode {
  tagName: string;
  attrs = new Map<string, string>();
  children: FakeNode[] = [];
  parent: FakeNode | null = null;
  listeners = new Map<string, Array<(event: unknown) => void>>();
  hidden = false;
  text = "";
  classes = new Set<string>();
  constructor(tagName: string) {
    this.tagName = tagName;
  }
  setAttribute(name: string, value: string): void {
    this.attrs.set(name, value);
    if (name === "class") this.classes = new Set(value.split(/\s+/).filter(Boolean));
  }
  getAttribute(name: string): string | null {
    return this.attrs.get(name) ?? null;
  }
  removeAttribute(name: string): void {
    this.attrs.delete(name);
  }
  get classList() {
    return { add: (c: string) => this.classes.add(c), contains: (c: string) => this.classes.has(c) };
  }
  set textContent(value: string) {
    this.text = value;
  }
  get textContent(): string {
    return this.text + this.children.map((c) => c.textContent).join("");
  }
  addEventListener(type: string, fn: (event: unknown) => void): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), fn]);
  }
  dispatch(type: string, event: unknown = {}): void {
    for (const fn of this.listeners.get(type) ?? []) fn(event);
  }
  append(...nodes: Array<FakeNode | string>): void {
    for (const n of nodes) {
      const node = typeof n === "string" ? Object.assign(new FakeNode("#text"), { text: n }) : n;
      node.parent = this;
      this.children.push(node);
    }
  }
  replaceChildren(...nodes: Array<FakeNode | string>): void {
    for (const c of this.children) c.parent = null;
    this.children = [];
    this.append(...nodes);
  }
  /** remove・insertBefore を呼んだ数（一覧の差し替えのテストが 0 に戻して数える） */
  static calls = { remove: 0, insertBefore: 0 };
  remove(): void {
    FakeNode.calls.remove++;
    if (this.parent) this.parent.children = this.parent.children.filter((c) => c !== this);
    this.parent = null;
  }
  get firstElementChild(): FakeNode | null {
    return this.children[0] ?? null;
  }
  get nextElementSibling(): FakeNode | null {
    if (!this.parent) return null;
    return this.parent.children[this.parent.children.indexOf(this) + 1] ?? null;
  }
  insertBefore(node: FakeNode, ref: FakeNode | null): void {
    FakeNode.calls.insertBefore++;
    node.remove();
    // 動かすために外したのは remove の数に入れない
    FakeNode.calls.remove--;
    node.parent = this;
    const at = ref ? this.children.indexOf(ref) : -1;
    if (at < 0) this.children.push(node);
    else this.children.splice(at, 0, node);
  }
  contains(other: unknown): boolean {
    return other === this || this.children.some((c) => c.contains(other));
  }
  get childElementCount(): number {
    return this.children.length;
  }
  buttons(): FakeNode[] {
    return this.children.flatMap((c) => (c.tagName === "button" ? [c] : c.buttons()));
  }
}

function loadToast(opts: { phone?: boolean } = {}) {
  const boxes = { toast: new FakeNode("div"), "toast-alert": new FakeNode("div") };
  boxes.toast.hidden = true;
  boxes["toast-alert"].hidden = true;
  let now = 0;
  let seq = 0;
  const timers = new Map<number, { at: number; fn: () => void }>();
  const document = {
    getElementById: (id: string) => (boxes as Record<string, FakeNode>)[id] ?? null,
    createElement: (tag: string) => new FakeNode(tag),
    createElementNS: (_ns: string, tag: string) => new FakeNode(tag),
    createTextNode: (text: string) => Object.assign(new FakeNode("#text"), { text }),
  };
  const context = {
    window: (opts.phone ? { matchMedia: () => ({ matches: true }) } : {}) as Record<string, unknown>,
    document,
    setTimeout: (fn: () => void, ms: number) => {
      timers.set(++seq, { at: now + ms, fn });
      return seq;
    },
    clearTimeout: (id: number) => timers.delete(id),
    Intl,
    Date,
    Number,
  };
  vm.runInNewContext(read("ui.js"), context);
  const advance = (ms: number) => {
    now += ms;
    for (const [id, t] of [...timers].sort((a, b) => a[1].at - b[1].at)) {
      if (t.at <= now && timers.has(id)) {
        timers.delete(id);
        t.fn();
      }
    }
  };
  const ui = (context.window as { SA: { ui: { toast: (text: string, action?: unknown, opts?: unknown) => void } } }).SA.ui;
  return { ui, boxes, advance };
}

test("web static: 知らせのトーストは 4 秒で消え、マウスが乗っている間・focus の間は消えない（指のタップでは止めない）", () => {
  const { ui, boxes, advance } = loadToast();
  ui.toast("保存しました");
  assert.equal(boxes.toast.hidden, false);
  const node = boxes.toast.children[0]!;
  node.dispatch("pointerenter", { pointerType: "mouse" });
  advance(10000);
  assert.equal(boxes.toast.children.length, 1, "hover の間は残る");
  node.dispatch("pointerleave", { pointerType: "mouse" });
  node.dispatch("focusin");
  advance(10000);
  assert.equal(boxes.toast.children.length, 1, "focus の間は残る");
  // 中の別のボタンへ焦点が移るだけなら止めたまま
  node.dispatch("focusout", { relatedTarget: node.buttons()[0] });
  advance(10000);
  assert.equal(boxes.toast.children.length, 1);
  node.dispatch("focusout", { relatedTarget: null });
  advance(3999);
  assert.equal(boxes.toast.children.length, 1);
  advance(1);
  assert.ok(node.classList.contains("is-leaving"), "消える動きの印");
  // 中のボタンの transitionend では外さず、トーストそのものの transitionend で外す
  node.dispatch("transitionend", { target: node.buttons()[0] });
  assert.equal(boxes.toast.children.length, 1);
  node.dispatch("transitionend", { target: node });
  assert.equal(boxes.toast.children.length, 0);
  assert.equal(boxes.toast.hidden, true);
  // 指のタップ（pointerType が touch）では止めない。transitionend が来なくても保険の時間で外す
  ui.toast("もう 1 つ");
  const touched = boxes.toast.children[0]!;
  touched.dispatch("pointerenter", { pointerType: "touch" });
  advance(4000);
  assert.ok(touched.classList.contains("is-leaving"));
  advance(400);
  assert.equal(boxes.toast.children.length, 0);
});

test("web static: 旧い呼び出し toast(text, action) は action 付きなら自動で消えず、次の知らせでも消されない", () => {
  const { ui, boxes, advance } = loadToast();
  let undone = 0;
  ui.toast("完了にしました", { label: "取り消す", run: () => undone++ });
  advance(60000);
  assert.equal(boxes.toast.children.length, 1, "自動では消えない");
  ui.toast("別の知らせ");
  advance(400);
  assert.deepEqual(boxes.toast.children.map((c) => c.children[0]!.textContent), ["完了にしました", "別の知らせ"]);
  assert.equal(boxes["toast-alert"].children.length, 0, "失敗の容れ物には入れない");
  const undo = boxes.toast.children[0]!.buttons().find((b) => b.textContent === "取り消す");
  assert.ok(undo);
  undo.dispatch("click");
  assert.equal(undone, 1);
});

test("web static: 失敗のトーストは #toast-alert に出て自動で消えず、[もう一度] で retry を呼ぶ", () => {
  const { ui, boxes, advance } = loadToast();
  let retried = 0;
  ui.toast("操作に失敗しました", null, { level: "error", retry: () => retried++ });
  assert.equal(boxes.toast.children.length, 0);
  assert.equal(boxes["toast-alert"].hidden, false);
  const node = boxes["toast-alert"].children[0]!;
  assert.ok(node.classList.contains("toast-alert"));
  advance(60000);
  assert.equal(boxes["toast-alert"].children.length, 1, "自動では消えない");
  // 知らせのトーストが来ても失敗は残る
  ui.toast("別の知らせ");
  ui.toast("さらに別の知らせ");
  assert.equal(boxes["toast-alert"].children.length, 1);
  const again = node.buttons().find((b) => b.textContent === "もう一度");
  assert.ok(again);
  again.dispatch("click");
  assert.equal(retried, 1);
  advance(400);
  assert.equal(boxes["toast-alert"].children.length, 0);
  assert.equal(boxes["toast-alert"].hidden, true);
  // retry が無ければ [もう一度] は出ない。多くて 2 つ
  ui.toast("a", null, { level: "error" });
  ui.toast("b", null, { level: "error" });
  ui.toast("c", null, { level: "error" });
  advance(400);
  assert.deepEqual(boxes["toast-alert"].children.map((c) => c.children[0]!.textContent), ["b", "c"]);
  assert.equal(boxes["toast-alert"].children[0]!.buttons().some((b) => b.textContent === "もう一度"), false);
});

test("web static: index.html に失敗のトーストの容れ物（role=alert）がある", () => {
  const html = read("index.html");
  assert.match(html, /<div class="toast-stack" id="toast" role="status"[^>]*hidden><\/div>/);
  assert.match(html, /<div class="toast-stack" id="toast-alert" role="alert"[^>]*hidden><\/div>/);
});

// ===== 許可のカード（views.js。GUIDELINES §5 許可のカード）を偽の DOM で描く =====
/** 子孫の要素を順に（深さ優先） */
function descendants(node: FakeNode): FakeNode[] {
  return node.children.flatMap((c) => [c, ...descendants(c)]);
}

function loadViews() {
  const document = {
    getElementById: () => null,
    createElement: (tag: string) => new FakeNode(tag),
    createElementNS: (_ns: string, tag: string) => new FakeNode(tag),
    createTextNode: (text: string) => Object.assign(new FakeNode("#text"), { text }),
    querySelectorAll: () => [],
  };
  const posts: string[] = [];
  const bodies: unknown[] = [];
  const toasts: string[] = [];
  let reply: (path: string) => Promise<unknown> = () => Promise.resolve({});
  const context = {
    window: {} as Record<string, unknown>,
    document,
    setTimeout: () => 0,
    clearTimeout: () => undefined,
    setInterval: () => 0,
    Intl,
    Date,
    Number,
  };
  vm.runInNewContext(read("ui.js"), context);
  const SA = (context.window as { SA: Record<string, unknown> }).SA;
  SA.store = { load: { ccSession: () => undefined, cc: () => undefined }, ccSessions: {}, cc: { sessions: [{ sessionId: "s1", name: "web-ui" }] } };
  SA.app = { refresh: () => undefined };
  SA.api = {
    post: (path: string, body: unknown) => {
      posts.push(path);
      bodies.push(body);
      return reply(path);
    },
  };
  // トーストは記録だけ（views.js は読み込みのときに SA.ui.toast を受け取る）
  (SA.ui as { toast: unknown }).toast = (text: string) => toasts.push(text);
  vm.runInNewContext(read("views.js"), context);
  const views = SA.views as {
    ccPermissionCard: (sessionId: string, p: unknown, rc: string | null) => FakeNode | null;
    ccQuestionPicks: (questions: unknown, drafts: unknown) => unknown;
    ccQuestionForget: (id: number) => void;
    placeChildren: (container: FakeNode, nodes: Array<FakeNode | null>) => void;
  };
  return { views, posts, bodies, toasts, setReply: (fn: (path: string) => Promise<unknown>) => (reply = fn) };
}

test("web static: 許可のカードは [許可][拒否] の 2 つ（許可 secondary・拒否 ghost）と常に許可のチェックで、チェックで [許可] の送り先が always に変わる", async () => {
  const { views, posts } = loadViews();
  const p = { id: 7, state: "pending", toolName: "Bash", summary: "ls", expiresAt: new Date(Date.now() + 60000).toISOString(), requestHash: "h", alwaysRule: "Bash(ls:*)" };
  const card = views.ccPermissionCard("s1", p, null)!;
  const buttons = card.buttons();
  assert.deepEqual(buttons.map((b) => b.textContent), ["許可", "拒否"]);
  assert.ok(buttons[0]!.classes.has("btn-secondary"), "許可は secondary");
  assert.ok(buttons[1]!.classes.has("btn-ghost"), "拒否は ghost");
  assert.equal(descendants(card).filter((n) => n.classes.has("btn-primary")).length, 0, "primary は無い");
  assert.ok(descendants(card).some((n) => n.tagName === "h2"), "見出しは h2");
  const label = descendants(card).find((n) => n.tagName === "label")!;
  assert.ok(label.classes.has("check"));
  assert.match(label.textContent, /このセッションでは常に許可/);
  const rule = descendants(card).find((n) => n.tagName === "code")!;
  assert.equal(rule.textContent, "Bash(ls:*)", "ルールは次の行の <code>");
  // チェックなし → allow
  buttons[0]!.dispatch("click");
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(posts, ["/api/cc/permissions/7/allow"]);
  // チェックを入れると描き直しても残り、[許可] は always
  const again = views.ccPermissionCard("s1", { ...p, id: 8 }, null)!;
  const box = descendants(again).find((n) => n.tagName === "input")!;
  assert.equal(box.getAttribute("type"), "checkbox");
  (box as unknown as { checked: boolean }).checked = true;
  box.dispatch("change");
  const redrawn = views.ccPermissionCard("s1", { ...p, id: 8 }, null)!;
  const box2 = descendants(redrawn).find((n) => n.tagName === "input")! as unknown as { checked: boolean };
  assert.equal(box2.checked, true, "描き直しでもチェックが残る");
  redrawn.buttons()[0]!.dispatch("click");
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(posts.slice(1), ["/api/cc/permissions/8/always"]);
  // [拒否] は deny。ルールが無ければチェックは出ない
  const noRule = views.ccPermissionCard("s1", { ...p, id: 9, alwaysRule: null }, null)!;
  assert.equal(descendants(noRule).some((n) => n.tagName === "input"), false);
  noRule.buttons()[1]!.dispatch("click");
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(posts.slice(2), ["/api/cc/permissions/9/deny"]);
});

test("web static: 本文へのスキップリンク・入力の必須とエラーの属性・z-index の変数（GUIDELINES §4・§5・§8）", () => {
  const html = read("index.html");
  // body の最初の要素がスキップリンクで、飛び先は焦点を受けられる
  assert.match(html, /<body>\s*<a class="skip-link" href="#editors">本文へ<\/a>/);
  assert.match(html, /id="editors" tabindex="-1"/);
  for (const [id, error] of [
    ["new-title", "new-error"],
    ["cc-start-title", "cc-start-error"],
  ]) {
    const input = new RegExp(`<input[^>]*id="${id}"[^>]*>`).exec(html)?.[0] ?? "";
    assert.match(input, /\brequired\b/, id);
    assert.match(input, /aria-required="true"/, id);
    assert.match(input, new RegExp(`aria-describedby="${error}"`), id);
    assert.match(html, new RegExp(`<div class="alert-slot"><p class="alert" id="${error}" role="alert"`), error);
  }
  // z-index は変数だけ（数字を直接書くのは :root の段の定義の中だけ）
  const css = read("app.css");
  const raw = [...css.matchAll(/z-index:\s*([^;]+);/g)].map((m) => m[1]!.trim());
  assert.ok(raw.length > 0);
  for (const value of raw) assert.match(value, /^var\(--z-[a-z-]+\)$/, value);
  // 見出しの段を飛ばさない（h1 の下に h3 を書かない）
  for (const name of files.filter((n) => n.endsWith(".js"))) assert.doesNotMatch(read(name), /el\("h3"/, name);
});

test("web static: スマホの下タブは固定 4（会話・タスク・リマインド・その他）で、「その他」のシートと backdrop の容れ物がある（docs/plan/web-ui-polish.md の NAV）", () => {
  const html = read("index.html");
  const sheet = /<div[^>]*id="more-sheet"[^>]*>/.exec(html)?.[0] ?? "";
  assert.match(sheet, /role="dialog"/);
  assert.match(sheet, /aria-modal="true"/);
  assert.match(sheet, /aria-label="その他の画面"/);
  assert.match(html, /<div class="drawer-backdrop" id="more-backdrop" hidden><\/div>/);
  // 下タブの主要の 3 つと、「その他」に入るもの（順は ACTIVITIES のまま）
  const js = read("sidebar.js");
  const phoneOf = (id: string): string | undefined => new RegExp(`\\{ id: "${id}",[^\\n]*?phone: "(primary|more)"`).exec(js)?.[1];
  for (const id of ["chat", "tasks", "reminders"]) assert.equal(phoneOf(id), "primary", id);
  for (const id of ["knowledge", "projects", "jobs", "github", "usage", "devlog", "status", "settings"]) assert.equal(phoneOf(id), "more", id);
  assert.match(read("workbench.js"), /"aria-controls": "more-sheet"/);
  // シートの動きは transform と visibility だけ（height・all を動かさない）
  const css = read("app.css");
  const rule = /\n {2}\.more-sheet \{([^}]*)\}/.exec(css)?.[1] ?? "";
  const transition = /transition:([^;]*);/.exec(rule)?.[1] ?? "";
  assert.ok(transition.length > 0);
  assert.match(transition, /\btransform\b/);
  assert.match(transition, /\bvisibility\b/);
  assert.doesNotMatch(transition, /\b(height|all)\b/);
  // シートと backdrop は 639px 以下だけ出す（既定は display: none）
  assert.match(css, /\n\.more-sheet,\n#more-backdrop \{\n {2}display: none;\n\}/);
});

// ===== 会話の一覧の群「Claude Code」（sidebar.js。docs/plan/claude-code-channels.md §2）を偽の DOM で描く =====
type CcFake = { sessions: Array<Record<string, unknown>>; starting: Array<Record<string, unknown>>; stale: boolean; unreadable: boolean; fetchedAt: string | null };

function loadSidebar(opts: {
  ccEnabled: boolean;
  cc: CcFake | null;
  setUp?: boolean;
  shows?: boolean;
  channels?: boolean;
  unread?: number;
  /** 会話の一覧に足す Claude Code のチャンネル（kind cc。CC14）と、未読にするチャンネル */
  ccChannels?: string[];
  unreadIds?: string[];
  /** 会話の一覧に足すプロジェクトのセッション（kind session）と、実行中のターン（/api/running の行） */
  sessions?: Array<Record<string, unknown>>;
  running?: Array<Record<string, unknown>>;
}) {
  const document = {
    activeElement: null,
    getElementById: () => null,
    createElement: (tag: string) => new FakeNode(tag),
    createElementNS: (_ns: string, tag: string) => new FakeNode(tag),
    createTextNode: (text: string) => Object.assign(new FakeNode("#text"), { text }),
  };
  const context = { window: {} as Record<string, unknown>, document, setTimeout: () => 0, clearTimeout: () => undefined, Intl, Date, Number };
  vm.runInNewContext(read("ui.js"), context);
  const SA = (context.window as { SA: Record<string, unknown> }).SA;
  const calls = { kickCc: 0, loadCc: 0, opened: [] as string[] };
  const channel = (id: string, kind: string, name: string, state?: string) => ({ id, kind, name, title: name, state, persona: "default", last: null });
  SA.store = {
    status: { cc: { enabled: opts.ccEnabled } },
    channels: opts.channels === false ? null : {
      guilds: [{ id: "g", setUp: opts.setUp !== false }],
      personas: [{ id: "default", name: "既定の人格", isDefault: true }],
      channels: [
        channel("c1", "inbox", "inbox"),
        channel("c2", "session", "調べもの", "active"),
        ...(opts.ccChannels ?? []).map((id) => channel(id, "cc", "cc-" + id)),
        ...(opts.sessions ?? []).map((extra) => ({ ...channel(String(extra.id), "session", String(extra.title), "active"), ...extra })),
      ],
    },
    cc: opts.cc,
    ccAt: opts.cc ? Date.now() : 0,
    ccFailed: false,
    running: opts.running ?? [],
    ccEnabled: () => opts.ccEnabled,
    ccNeedsInputCount: () => (opts.cc ? opts.cc.sessions.filter((s) => s.state === "needs_input").length : 0),
    unreadCount: () => opts.unread ?? 1,
    runningOf: (id: string) => (opts.running ?? []).find((r) => r.channelId === id) ?? null,
    runningWaitingText: (run: { waitingPermission?: { toolName: string } } | null) => (run && run.waitingPermission ? "許可を待っています: " + run.waitingPermission.toolName : null),
    isUnread: (ch: { id: string }) => (opts.unreadIds ?? []).includes(ch.id),
    load: {
      cc: () => {
        calls.loadCc++;
      },
      channels: () => undefined,
    },
  };
  SA.app = {
    activeTabId: () => null,
    sidebarShows: (id: string) => id === "chat" && opts.shows !== false,
    open: (tab: string) => calls.opened.push(tab),
    closeDrawer: () => undefined,
  };
  SA.poll = {
    kickCc: () => {
      calls.kickCc++;
    },
  };
  // 許可待ちの判定と数は api.js のものをそのまま使う
  vm.runInNewContext(sessionAskingSource(), { store: SA.store });
  SA.views = {
    oneLine: (text: string) => text.replace(/\s+/g, " "),
    ccName: (s: { name?: string; cwdLabel?: string }) => s.name || s.cwdLabel || "（名前なし）",
    ago: () => "1 分前",
    secondsAgo: () => "3 秒前",
  };
  vm.runInNewContext(read("sidebar.js"), context);
  const sidebar = SA.sidebar as { ACTIVITIES: Array<{ id: string; count?: () => number; countLabel?: () => string }>; render: (container: FakeNode, id: string) => void };
  const container = new FakeNode("div");
  sidebar.render(container, "chat");
  const groups = descendants(container).filter((n) => n.tagName === "details");
  const titleOf = (g: FakeNode) => g.children[0]!.children[1]!.text;
  const countOf = (g: FakeNode) => g.children[0]!.children[2]!.text;
  const ccGroup = groups.find((g) => titleOf(g) === "Claude Code");
  return { sidebar, container, groups, titleOf, countOf, ccGroup, calls, store: SA.store as Record<string, unknown> };
}

/** api.js の store.sessionAsking と store.sessionAskingCount */
function sessionAskingSource(): string {
  const js = read("api.js");
  const asking = /store\.sessionAsking = \(ch\) => \{[\s\S]*?\n {2}\};/.exec(js)?.[0];
  const count = /store\.sessionAskingCount = [^\n]*;/.exec(js)?.[0];
  assert.ok(asking && count);
  return asking + "\n" + count;
}

const ccSession = (sessionId: string, name: string, state: string, extra: Record<string, unknown> = {}) => ({ sessionId, name, state, inTmux: true, cwdLabel: "~/w/" + name, ...extra });

test("web static: ACTIVITIES に Claude Code（cc）は無く、会話の数は未読 + 判断待ち", () => {
  const { sidebar } = loadSidebar({
    ccEnabled: true,
    cc: { sessions: [ccSession("a", "x", "needs_input"), ccSession("b", "y", "needs_input"), ccSession("c", "z", "idle")], starting: [], stale: false, unreadable: false, fetchedAt: null },
  });
  assert.equal(sidebar.ACTIVITIES.some((a) => a.id === "cc"), false);
  const chat = sidebar.ACTIVITIES.find((a) => a.id === "chat")!;
  // 未読 1 + 判断待ち 2
  assert.equal(chat.count!(), 3);
  assert.equal(chat.countLabel!(), "未読・判断待ち ");
  assert.doesNotMatch(read("sidebar.js"), /\{ id: "cc",/);
  // 語は未読だけ・判断待ちだけ・両方で分ける
  const needsOnly = loadSidebar({ ccEnabled: true, unread: 0, cc: { sessions: [ccSession("a", "x", "needs_input")], starting: [], stale: false, unreadable: false, fetchedAt: null } });
  assert.equal(needsOnly.sidebar.ACTIVITIES.find((a) => a.id === "chat")!.countLabel!(), "判断待ち ");
  const unreadOnly = loadSidebar({ ccEnabled: true, unread: 2, cc: { sessions: [ccSession("a", "x", "idle")], starting: [], stale: false, unreadable: false, fetchedAt: null } });
  assert.equal(unreadOnly.sidebar.ACTIVITIES.find((a) => a.id === "chat")!.countLabel!(), "未読 ");
  // workbench は関数の countLabel を呼ぶ
  assert.match(read("workbench.js"), /typeof a\.countLabel === "function" \? a\.countLabel\(\)/);
});

test("web static: store.ccNeedsInputCount（api.js）は連携が有効で一覧があるときだけ needs_input の数", () => {
  const src = /store\.ccNeedsInputCount = [^\n]*;/.exec(read("api.js"))?.[0];
  assert.ok(src);
  const run = (store: Record<string, unknown>) => {
    vm.runInNewContext(src, { store });
    return (store.ccNeedsInputCount as () => number)();
  };
  const sessions = [ccSession("a", "x", "needs_input"), ccSession("b", "y", "running"), ccSession("c", "z", "needs_input")];
  assert.equal(run({ ccEnabled: () => true, cc: { sessions } }), 2);
  assert.equal(run({ ccEnabled: () => false, cc: { sessions } }), 0);
  assert.equal(run({ ccEnabled: () => true, cc: null }), 0);
});

test("web static: 一覧を描き直しても .sb-body のスクロール位置を保つ（同じアクティビティのときだけ）", () => {
  const { sidebar, container, store } = loadSidebar({ ccEnabled: false, cc: null });
  const bodyOf = () => container.children.find((c) => c.classes.has("sb-body")) as (FakeNode & { scrollTop?: number }) | undefined;
  assert.equal(container.getAttribute("data-activity"), "chat");
  bodyOf()!.scrollTop = 120;
  sidebar.render(container, "chat");
  assert.equal(bodyOf()!.scrollTop, 120);
  assert.equal(container.getAttribute("data-activity"), "chat");
  // 別のアクティビティへ切り替えたら先頭から（戻ってきても先頭から）
  store.openTasks = [];
  bodyOf()!.scrollTop = 80;
  sidebar.render(container, "tasks");
  assert.equal(bodyOf()!.scrollTop ?? 0, 0);
  assert.equal(container.getAttribute("data-activity"), "tasks");
  sidebar.render(container, "chat");
  assert.equal(bodyOf()!.scrollTop ?? 0, 0);
  // 出さないアクティビティは空にして印を外す
  sidebar.render(container, "status");
  assert.equal(container.children.length, 0);
  assert.equal(container.getAttribute("data-activity"), null);
  // 行のボタンは開くタブを data-tab に持つ（描き直した後のフォーカスの戻し先）
  sidebar.render(container, "chat");
  const rowBtn = descendants(container).find((n) => n.tagName === "button" && n.classes.has("sb-row"))!;
  assert.equal(rowBtn.getAttribute("data-tab"), "ch:c1");
  const js = read("sidebar.js");
  assert.match(js, /btn\.focus\(\{ preventScroll: true \}\)/);
  assert.match(js, /focusedTab\.startsWith\("ch:"\) \|\| focusedTab\.startsWith\("cc:"\)/);
});

test("web static: store.sessionAsking（api.js）は実行中のターンの waitingPermission を優先し、まだ読んでいなければ channel の permission", () => {
  const make = (running: Array<Record<string, unknown>> | null, channels: Array<Record<string, unknown>> | null) => {
    const store: Record<string, unknown> = {
      running,
      channels: channels === null ? null : { channels },
      runningOf: (id: string) => (running ? running.find((r) => r.channelId === id) ?? null : null),
    };
    vm.runInNewContext(sessionAskingSource(), { store });
    return store as { sessionAsking: (ch: unknown) => boolean; sessionAskingCount: () => number };
  };
  const pendingCh = { id: "s1", kind: "session", permission: { id: 1, state: "pending", toolName: "Bash" } };
  const plainCh = { id: "s2", kind: "session", permission: null };
  // まだ読んでいない（null）: channel の permission
  assert.equal(make(null, null).sessionAsking(pendingCh), true);
  assert.equal(make(null, null).sessionAsking(plainCh), false);
  // 読んでいて空: 許可待ちではない（新しい方を信じる）
  assert.equal(make([], null).sessionAsking(pendingCh), false);
  // waitingPermission のある行・無い行
  const waiting = [{ channelId: "s2", waitingPermission: { toolName: "Bash", since: "t" } }];
  assert.equal(make(waiting, null).sessionAsking(plainCh), true);
  assert.equal(make([{ channelId: "s1" }], null).sessionAsking(pendingCh), false);
  // session でない行・無い行
  assert.equal(make(null, null).sessionAsking({ id: "c1", kind: "inbox", permission: { state: "pending" } }), false);
  assert.equal(make(waiting, null).sessionAsking({ id: "s2", kind: "cc" }), false);
  assert.equal(make(null, null).sessionAsking(null), false);
  // 数は一覧が無ければ 0
  assert.equal(make(null, null).sessionAskingCount(), 0);
  assert.equal(make(null, [pendingCh, plainCh]).sessionAskingCount(), 1);
  assert.equal(make(waiting, [pendingCh, plainCh]).sessionAskingCount(), 1);
});

test("web static: プロジェクトのセッションの許可待ちの行はバッジ「許可待ち」（質問なら「質問」）と dot-warn で、スピナーを出さない。会話の数に入る", () => {
  const permission = (extra: Record<string, unknown> = {}) => ({ id: 7, sessionId: "x", state: "pending", toolName: "Bash", summary: "npm  test", ...extra });
  const { sidebar, groups, titleOf } = loadSidebar({
    ccEnabled: false,
    cc: null,
    unread: 0,
    sessions: [
      { id: "p1", title: "許可のセッション", permission: permission() },
      { id: "p2", title: "質問のセッション", permission: permission({ question: { questions: [{ question: "どれ" }] } }) },
      { id: "p3", title: "動いているセッション" },
    ],
    running: [
      { channelId: "p1", waitingPermission: { toolName: "Bash", since: "t" } },
      { channelId: "p2", waitingPermission: { toolName: "AskUserQuestion", since: "t" } },
      { channelId: "p3" },
    ],
  });
  const active = groups.find((g) => titleOf(g) === "進行中")!;
  const list = active.children.find((c) => c.tagName === "ul")!;
  const rowNamed = (title: string) => list.children.find((li) => descendants(li).some((n) => n.classes.has("sb-label") && n.text === title))!;
  const ask = rowNamed("許可のセッション");
  const badgeText = (li: FakeNode) => descendants(li).filter((n) => n.classes.has("badge-accent")).map((n) => n.text);
  assert.deepEqual(badgeText(ask), ["許可待ち"]);
  assert.ok(descendants(ask).some((n) => n.classes.has("badge-accent") && n.classes.has("hide-sm")));
  const dot = descendants(ask).find((n) => n.classes.has("dot-warn"))!;
  assert.equal(dot.getAttribute("aria-label"), "許可待ち");
  assert.equal(descendants(ask).some((n) => n.classes.has("spinner")), false);
  assert.equal(ask.children[0]!.getAttribute("title"), "Bash: npm test");
  const question = rowNamed("質問のセッション");
  assert.deepEqual(badgeText(question), ["質問"]);
  assert.equal(descendants(question).find((n) => n.classes.has("dot-warn"))!.getAttribute("aria-label"), "質問");
  // 許可を待っていない実行中の行は今のまま（スピナー）
  const run = rowNamed("動いているセッション");
  assert.ok(descendants(run).some((n) => n.classes.has("spinner")));
  assert.deepEqual(badgeText(run), []);
  // 会話の数（未読 0 + 判断待ち 0 + 許可待ち 2）と語
  const chat = sidebar.ACTIVITIES.find((a) => a.id === "chat")!;
  assert.equal(chat.count!(), 2);
  assert.equal(chat.countLabel!(), "判断待ち ");
});

test("web static: 下タブの数は実行中も隠さず、数があるときのスピナーはアイコンの左（has-count）", () => {
  const css = read("app.css");
  assert.doesNotMatch(css, /\.act-btn\.is-running \.act-count \{\s*display: none;/);
  assert.match(css, /\.act-btn\.is-running\.has-count \.act-spin \{\s*left: auto;\s*right: calc\(50% \+ var\(--space-1\)\);\s*\}/);
  // 数の位置の規則より後ろ（同じ詳細度なので後ろが勝つ）
  assert.ok(css.indexOf(".act-btn.is-running.has-count .act-spin") > css.indexOf("left: calc(50% + var(--space-1));"));
  const workbench = read("workbench.js");
  assert.match(workbench, /btn\.classList\.add\("has-count"\)/);
  assert.match(workbench, /parts\.join\("・"\)/);
  assert.match(workbench, /el\("span", \{ class: "spinner spinner-sm act-spin", "aria-hidden": "true" \}\)/);
});

test("web static: ccStatusOf（chat.js）は 届け待ち > 作業中 > 届けた の順で 1 つだけ返す", () => {
  const src = /function ccStatusOf\(live\) \{[\s\S]*?\n  \}/.exec(read("chat.js"))?.[0];
  assert.ok(src);
  const context: Record<string, unknown> = {};
  vm.runInNewContext(src + "\nresult = ccStatusOf;", context);
  const ccStatusOf = context.result as (live: unknown) => { kind: string; text: string; cancel: boolean } | null;
  const p = (state: string, extra: Record<string, unknown> = {}) => ({ id: 3, state, lastPaneState: null, replyState: null, ...extra });
  const plain = (v: unknown) => (v === null ? null : JSON.parse(JSON.stringify(v)));
  const cases: Array<[unknown, unknown]> = [
    [{ state: "ended", pending: p("queued") }, null],
    [{ state: "idle", pending: p("delivering") }, { kind: "queued", text: "届けています…", cancel: false }],
    [{ state: "running", pending: p("queued", { lastPaneState: "dialog" }) }, { kind: "queued", text: "ダイアログが出ているため待っています（端末か RC で答えてください）", cancel: true }],
    [{ state: "running", pending: p("queued") }, { kind: "queued", text: "作業中です。終わったら届けます", cancel: true }],
    [{ state: "idle", pending: p("queued") }, { kind: "queued", text: "届け待ちです。入力待ちになったら届けます", cancel: true }],
    [{ state: "running", pending: p("delivered", { replyState: "waiting" }) }, { kind: "running", text: "作業中…", cancel: false }],
    [{ state: "idle", pending: p("delivered", { replyState: "waiting" }) }, { kind: "delivered", text: "届けました。返事を待っています", cancel: false }],
    [{ state: "needs_input", pending: p("delivered", { replyState: "waiting" }) }, null],
    [{ state: "idle", pending: p("delivered", { replyState: "sent" }) }, null],
    [{ state: "idle", pending: p("cancelled") }, null],
    [{ state: "idle", pending: null }, null],
    // id が数でない pending は無いものとして、作業中だけを見る
    [{ state: "running", pending: { id: "x", state: "queued" } }, { kind: "running", text: "作業中…", cancel: false }],
    [{ state: "idle", pending: { id: "x", state: "queued" } }, null],
  ];
  for (const [live, want] of cases) assert.deepEqual(plain(ccStatusOf(live)), want, JSON.stringify(live));
});

test("web static: Claude Code のチャンネルは送った直後に仮の届け待ちを出し、行が同じ送信を出している間は帯を出さない", () => {
  const chat = read("chat.js");
  assert.match(chat, /if \(data && typeof data\.sendId === "number"\) store\.setCcOptimisticSend\(live\.sessionId, data\.sendId\);/);
  assert.match(chat, /const CC_SEND_RECHECK_MS = \[1000, 3000, 6000\];/);
  assert.match(chat, /for \(const ms of CC_SEND_RECHECK_MS\) setTimeout\(\(\) => store\.load\.ccSession\(live\.sessionId, \{ quiet: true \}\), ms\);/);
  assert.match(chat, /const status = ccStatusRow\(live\);\n {6}if \(status\) timeline\.append\(status\);/);
  assert.match(chat, /ccPending = live\.sessionId && !\(statusKind === "queued" \|\| statusKind === "delivered"\) \? SA\.views\.ccPendingBar\(live\.sessionId, live\.pending\) : null;/);
  assert.match(chat, /store\.ccPendingOf\(info\.sessionId, session \? session\.pending : info\.pending\)/);
  assert.match(chat, /SA\.views\.cancelCcSend\(live\.pending\.id, live\.sessionId, cancel\)/);
  assert.match(read("app.css"), /\n\.cc-status \.btn \{\s*margin-left: var\(--space-2\);\s*\}/);
  // views.js の export
  assert.match(/SA\.views = \{[\s\S]*?\n {2}\};/.exec(read("views.js"))?.[0] ?? "", /\n {4}cancelCcSend,\n/);
  // api.js の store.ccPendingOf
  const api = read("api.js");
  const src = /const CC_OPTIMISTIC_MS = [\s\S]*?store\.ccPendingOf = [\s\S]*?\n {2}\};/.exec(api)?.[0];
  assert.ok(src);
  assert.match(api, /if \(err && err\.status === 404\) \{\n {10}store\.ccSessions\[sessionId\] = \{ session: null, missing: true \};\n {10}delete store\.ccOptimistic\[sessionId\];/);
  const run = () => {
    const store: Record<string, unknown> = {};
    vm.runInNewContext(src, { store, Date });
    return store as {
      ccOptimistic: Record<string, { id: number; state: string; updatedAt: string }>;
      setCcOptimisticSend: (sessionId: string, sendId: number) => void;
      ccPendingOf: (sessionId: string, server: unknown) => unknown;
    };
  };
  // 仮だけ
  const a = run();
  assert.equal(a.ccPendingOf("s", null), null);
  a.setCcOptimisticSend("s", 5);
  assert.equal((a.ccPendingOf("s", null) as { id: number; state: string }).state, "queued");
  // サーバーの id が同じ・大きい: サーバーのもので、仮は消す
  for (const id of [5, 6]) {
    const b = run();
    b.setCcOptimisticSend("s", 5);
    const server = { id, state: "delivered" };
    assert.equal(b.ccPendingOf("s", server), server);
    assert.equal(b.ccOptimistic.s, undefined);
  }
  // サーバーの id が小さい（前の送信）: 仮のもの
  const c = run();
  c.setCcOptimisticSend("s", 5);
  assert.equal((c.ccPendingOf("s", { id: 4, state: "delivered" }) as { id: number }).id, 5);
  // 30 秒より古い: サーバーのもので、仮は消す
  const d = run();
  d.setCcOptimisticSend("s", 5);
  d.ccOptimistic.s!.updatedAt = new Date(Date.now() - 31000).toISOString();
  const old = { id: 4, state: "delivered" };
  assert.equal(d.ccPendingOf("s", old), old);
  assert.equal(d.ccOptimistic.s, undefined);
});

test("web static: 届け待ちの間は前面の Claude Code のセッションを 3 秒ごとに読む", () => {
  const api = read("api.js");
  assert.match(api, /ccSendBusy\(\) \? CC_PERMISSION_INTERVAL_MS : ccScreenIdle\(\) \? CC_LIST_INTERVAL_MS : CC_SCREEN_INTERVAL_MS/);
  assert.match(api, /return !!\(p && \(p\.state === "queued" \|\| p\.state === "delivering"\)\);/);
});

test("web static: 会話の一覧は 入口 → Claude Code → 進行中 → 待ち → 完了 で、Claude Code の群は起動中 → 一覧の順（サーバーの並び）・見出しの数は判断待ち・行は cc:<id> を開く", () => {
  const { groups, titleOf, countOf, ccGroup, calls } = loadSidebar({
    ccEnabled: true,
    cc: {
      sessions: [ccSession("s-need", "need", "needs_input"), ccSession("s-run", "run", "running"), ccSession("s-idle", "idle", "idle", { channel: { channelId: "x" } })],
      starting: [{ title: "new-one", project: "p" }],
      stale: true,
      unreadable: false,
      fetchedAt: new Date().toISOString(),
    },
  });
  assert.deepEqual(groups.map(titleOf), ["入口", "Claude Code", "進行中", "待ち", "完了"]);
  assert.ok(ccGroup);
  assert.equal(countOf(ccGroup), "1");
  const list = ccGroup.children.find((c) => c.tagName === "ul")!;
  const labels = list.children.map((li) => descendants(li).find((n) => n.classes.has("sb-label"))!.text);
  assert.deepEqual(labels, ["new-one", "need", "run", "idle"]);
  // 判断待ちは点、実行中はスピナー、チャンネルのあるものは #（無いものは空の箱）
  const rowOf = (i: number) => list.children[i]!;
  assert.ok(descendants(rowOf(1)).some((n) => n.classes.has("dot-warn")));
  assert.ok(descendants(rowOf(2)).some((n) => n.classes.has("spinner")));
  const iconHref = (li: FakeNode) => descendants(li).find((n) => n.tagName === "use")?.getAttribute("href") ?? null;
  assert.match(iconHref(rowOf(3)) ?? "", /#hash$/);
  assert.ok(descendants(rowOf(1)).some((n) => n.classes.has("icon-blank")));
  // 読めなかった注記は群の中、最後に読めた時刻は見出しの title。[Claude Code を起動] は群の外（新しいセッションと同じ形）
  assert.match(ccGroup.textContent, /前に読めた一覧です/);
  assert.doesNotMatch(ccGroup.textContent, /一覧は/);
  assert.equal(ccGroup.children[0]!.getAttribute("title"), "一覧は 3 秒前のもの");
  assert.equal(ccGroup.buttons().some((b) => b.textContent === "Claude Code を起動"), false);
  const next = ccGroup.parent!.children[ccGroup.parent!.children.indexOf(ccGroup) + 1]!;
  assert.ok(next.classes.has("sb-new-row"));
  assert.ok(next.buttons().some((b) => b.textContent === "Claude Code を起動"));
  rowOf(1).buttons()[0]!.dispatch("click");
  assert.deepEqual(calls.opened, ["cc:s-need"]);
  // 会話の一覧を出したら Claude Code の polling を始め直す
  assert.equal(calls.kickCc, 1);
});

test("web static: Claude Code のチャンネルのある行は # で会話のタブ（ch:<id>）を開き、未読の点は会話と同じ。cc のチャンネルは入口に出ない（CC14）", () => {
  const { groups, titleOf, ccGroup, calls } = loadSidebar({
    ccEnabled: true,
    cc: {
      sessions: [
        ccSession("s-ch", "with-channel", "idle", { channel: { channelId: "c9", state: "open" } }),
        ccSession("s-gone", "deleted-channel", "idle", { channel: { channelId: "c8", state: "deleted" } }),
        ccSession("s-none", "no-channel", "idle"),
      ],
      starting: [],
      stale: false,
      unreadable: false,
      fetchedAt: null,
    },
    ccChannels: ["c9"],
    unreadIds: ["c9"],
  });
  const entrances = groups.find((g) => titleOf(g) === "入口")!;
  assert.doesNotMatch(entrances.textContent, /cc-c9/);
  assert.ok(ccGroup);
  const list = ccGroup.children.find((c) => c.tagName === "ul")!;
  const rowOf = (i: number) => list.children[i]!;
  assert.ok(descendants(rowOf(0)).some((n) => n.classes.has("dot-unread")));
  assert.equal(descendants(rowOf(1)).some((n) => n.classes.has("dot-unread")), false);
  for (let i = 0; i < 3; i++) rowOf(i).buttons()[0]!.dispatch("click");
  assert.deepEqual(calls.opened, ["ch:c9", "cc:s-gone", "cc:s-none"]);
});

test("web static: Claude Code の群の見出しの数は、判断待ちが 0 なら全体（起動中を含む）の数", () => {
  const { ccGroup, countOf } = loadSidebar({
    ccEnabled: true,
    cc: { sessions: [ccSession("a", "x", "running"), ccSession("b", "y", "idle")], starting: [{ title: "n", project: "p" }], stale: false, unreadable: false, fetchedAt: null },
  });
  assert.ok(ccGroup);
  assert.equal(countOf(ccGroup), "3");
  assert.equal(ccGroup.children[0]!.getAttribute("title"), null);
});

test("web static: load.cc（api.js）は中身が前と同じなら描き直さず、描き直すときはアクティビティだけを更新する", () => {
  const js = read("api.js");
  const body = /store\.load\.cc = \(opts\) =>[\s\S]*?\n {4}\}\);/.exec(js)?.[0] ?? "";
  assert.match(body, /sameCcList\(before, store\.cc\)\) return;/);
  assert.match(body, /SA\.app\.refreshActivity\(\)/);
  assert.doesNotMatch(body, /refreshStatus/);
  assert.match(js, /JSON\.stringify\(\[c\.sessions, c\.starting, c\.stale, c\.unreadable\]\)/);
});

test("web static: Claude Code の連携が無効なら群を出さず polling もしない。一覧をまだ読んでいなければ読み込み中の群", () => {
  const off = loadSidebar({ ccEnabled: false, cc: null });
  assert.equal(off.ccGroup, undefined);
  assert.equal(off.calls.kickCc, 0);
  assert.equal(off.calls.loadCc, 0);
  const loading = loadSidebar({ ccEnabled: true, cc: null });
  assert.ok(loading.ccGroup);
  assert.match(loading.ccGroup.textContent, /読み込んでいます…/);
  assert.equal(loading.calls.loadCc, 1);
  // 会話の一覧を出していなければ読まない
  const hidden = loadSidebar({ ccEnabled: true, cc: null, shows: false });
  assert.equal(hidden.calls.kickCc, 0);
  assert.equal(hidden.calls.loadCc, 0);
  // チャンネルの一覧をまだ読んでいなくても Claude Code の群は出す
  const noChannels = loadSidebar({ ccEnabled: true, cc: { sessions: [ccSession("a", "x", "idle")], starting: [], stale: false, unreadable: false, fetchedAt: null }, channels: false });
  assert.ok(noChannels.ccGroup);
  // /setup 前でも Claude Code の群は出す
  const notSetUp = loadSidebar({ ccEnabled: true, cc: { sessions: [ccSession("a", "x", "idle")], starting: [], stale: false, unreadable: false, fetchedAt: null }, setUp: false });
  assert.ok(notSetUp.ccGroup);
});

// ===== 画面の言葉（docs/design/WEB-UI-GUIDELINES.md §7・§10） =====
/** JS の "…" の文字列（コメントを除いてから拾う。https:// の // はコメントとみなさない） */
function stringLiterals(js: string): string[] {
  const code = js.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'\\])\/\/.*$/gm, "$1");
  return [...code.matchAll(/"((?:[^"\\\n]|\\.)*)"/g)].map((m) => m[1] ?? "");
}

test("web static: 画面の言葉に「！」・ツール名・HTTP の番号が主役の文・語彙の表で使わない語が無い", () => {
  const TOOL_NAME = /\b[a-z]+_(add|list|complete|update|report|open|save|search|get|delete|forget|files|set|cancel)\b/;
  const HTTP_STATUS = /^[1-5]\d\d\s*[:：]|[（(][1-5]\d\d[）)]|\bHTTP\b/;
  const AVOID = /送信|キャンセル|クローズ|\bOK\b|--json|SELF_AGENT_|settings\.json/;
  const texts: Array<[string, string]> = [];
  for (const name of files.filter((n) => n.endsWith(".js"))) {
    const js = read(name);
    for (const s of stringLiterals(js)) texts.push([name, s]);
    // 応答の status をそのままトーストの文にしない
    assert.doesNotMatch(js, /toast\s*=\s*res\.status|toast\([^;]*\.status\s*\+/, name);
  }
  for (const name of ["index.html", "v3.html"]) texts.push([name, read(name).replace(/<!doctype[^>]*>/i, "")]);
  for (const [name, text] of texts) {
    assert.doesNotMatch(text, /[！!]/, `${name}: ${text}`);
    assert.doesNotMatch(text, TOOL_NAME, `${name}: ${text}`);
    assert.doesNotMatch(text, HTTP_STATUS, `${name}: ${text}`);
    assert.doesNotMatch(text, AVOID, `${name}: ${text}`);
  }
});

// ===== ホーム画面（PWA。docs/plan/web-ui.md §11） =====
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** PNG を読む（フィルタ 0 の行だけ。make-icons.ts の書き方に合わせた最小のもの） */
function decodePng(buf: Buffer): { width: number; height: number; colorType: number; pixels: Buffer } {
  assert.ok(buf.subarray(0, 8).equals(PNG_SIGNATURE), "PNG のシグネチャ");
  let offset = 8;
  let width = 0;
  let height = 0;
  let colorType = -1;
  const idat: Buffer[] = [];
  const types: string[] = [];
  while (offset < buf.length) {
    const length = buf.readUInt32BE(offset);
    const type = buf.toString("ascii", offset + 4, offset + 8);
    const body = buf.subarray(offset + 8, offset + 8 + length);
    assert.equal(buf.readUInt32BE(offset + 8 + length), crc32(buf.subarray(offset + 4, offset + 8 + length)), `${type} の CRC`);
    types.push(type);
    if (type === "IHDR") {
      width = body.readUInt32BE(0);
      height = body.readUInt32BE(4);
      assert.equal(body[8], 8, "ビット深度");
      colorType = body[9]!;
      assert.deepEqual([body[10], body[11], body[12]], [0, 0, 0], "compression・filter・interlace");
    } else if (type === "IDAT") idat.push(body);
    offset += 12 + length;
  }
  assert.equal(types[0], "IHDR");
  assert.equal(types.at(-1), "IEND");
  const channels = colorType === 6 ? 4 : 3;
  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * channels;
  assert.equal(raw.length, (stride + 1) * height);
  const pixels = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y++) {
    assert.equal(raw[y * (stride + 1)], 0, "フィルタ 0");
    raw.copy(pixels, y * stride, y * (stride + 1) + 1, (y + 1) * (stride + 1));
  }
  return { width, height, colorType, pixels };
}

test("web static: index.html に manifest・favicon・theme-color 2 つ・apple の meta とアイコンがある", () => {
  const html = read("index.html");
  assert.match(html, /<link rel="manifest" href="\/static\/manifest\.webmanifest">/);
  assert.match(html, /<link rel="icon" href="\/static\/app-icon\.svg" type="image\/svg\+xml">/);
  assert.match(html, /<link rel="apple-touch-icon" href="\/static\/apple-touch-icon\.png">/);
  assert.equal([...html.matchAll(/<meta name="theme-color" /g)].length, 2);
  assert.match(html, /<meta name="apple-mobile-web-app-capable" content="yes">/);
  assert.match(html, /<meta name="mobile-web-app-capable" content="yes">/);
  assert.match(html, /<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">/);
  assert.match(html, /<meta name="apple-mobile-web-app-title" content="self-agent">/);
  // service worker は置かない（§11.3）
  assert.doesNotMatch(html, /serviceWorker/);
  for (const name of files.filter((n) => n.endsWith(".js"))) assert.doesNotMatch(read(name), /serviceWorker/, name);
});

test("web static: manifest は §11.1 の値で、アイコンは配るファイルを指す", () => {
  const manifest = JSON.parse(read("manifest.webmanifest")) as Record<string, unknown>;
  assert.equal(manifest.name, "self-agent");
  assert.equal(manifest.short_name, "self-agent");
  assert.equal(manifest.id, "/");
  assert.equal(manifest.start_url, "/");
  assert.equal(manifest.scope, "/");
  assert.equal(manifest.display, "standalone");
  assert.equal(manifest.background_color, "#0b0d14");
  assert.equal(manifest.theme_color, "#11141c");
  assert.equal(manifest.lang, "ja");
  assert.equal("orientation" in manifest, false);
  assert.deepEqual(manifest.icons, [
    { src: "/static/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
    { src: "/static/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
    { src: "/static/icon-512-maskable.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
  ]);
  for (const icon of manifest.icons as Array<{ src: string }>) assert.ok(files.includes(icon.src.replace("/static/", "")), icon.src);
});

test("web static: PNG のシグネチャと IHDR の大きさ。apple-touch-icon と maskable は透過なし", () => {
  const sizes: Record<string, [number, number]> = {
    "apple-touch-icon.png": [180, 2],
    "icon-192.png": [192, 6],
    "icon-512.png": [512, 6],
    "icon-512-maskable.png": [512, 2],
  };
  for (const [name, [size, colorType]] of Object.entries(sizes)) {
    const png = decodePng(readFileSync(join(STATIC_DIR, name)));
    assert.equal(png.width, size, name);
    assert.equal(png.height, size, name);
    assert.equal(png.colorType, colorType, name);
  }
});

test("web static: maskable は中央 80% の円の外側が地の色（#11141c）だけ", () => {
  const { width, pixels } = decodePng(readFileSync(join(STATIC_DIR, "icon-512-maskable.png")));
  const c = width / 2;
  const r = width * 0.4;
  let outside = 0;
  for (let y = 0; y < width; y++) {
    for (let x = 0; x < width; x++) {
      const dx = x + 0.5 - c;
      const dy = y + 0.5 - c;
      if (dx * dx + dy * dy <= r * r) continue;
      outside++;
      const i = (y * width + x) * 3;
      assert.deepEqual([pixels[i], pixels[i + 1], pixels[i + 2]], [0x11, 0x14, 0x1c], `${x},${y}`);
    }
  }
  assert.ok(outside > 0);
});

test("web static: scripts/make-icons.ts の出力が commit したものと一致する（SVG は全体、PNG は IHDR とピクセル）", (t) => {
  const out = mkdtempSync(join(tmpdir(), "make-icons-"));
  t.after(() => rmSync(out, { recursive: true, force: true }));
  const script = fileURLToPath(new URL("../scripts/make-icons.ts", import.meta.url));
  const result = spawnSync(process.execPath, [script, "--out", out], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(readdirSync(out).sort(), [...ICON_FILES].sort());
  // --out の値が無ければ使い方を出して 2
  const bad = spawnSync(process.execPath, [script, "--out"], { encoding: "utf8" });
  assert.equal(bad.status, 2);
  assert.match(bad.stderr, /使い方/);
  for (const name of ICON_FILES) {
    const made = readFileSync(join(out, name));
    const committed = readFileSync(join(STATIC_DIR, name));
    if (name.endsWith(".svg")) {
      assert.equal(made.toString("utf8"), committed.toString("utf8"), name);
      continue;
    }
    // deflate の出力は zlib の版で変わりうるので、比べるのは中身
    const a = decodePng(made);
    const b = decodePng(committed);
    assert.deepEqual([a.width, a.height, a.colorType], [b.width, b.height, b.colorType], name);
    assert.ok(a.pixels.equals(b.pixels), `${name}: npm run make-icons で作り直す`);
  }
});

test("web static: 会話のタブは Claude Code のチャンネル（kind cc）で許可のカードを共用し、閉じるは /api/cc/channels/<id>/close。/renew はパレットで出さない（CC14）", () => {
  const chat = read("chat.js");
  assert.match(chat, /SA\.views\.ccPermissionCard\(live\.sessionId, p, live\.rc, "ch:" \+ channelId\)/);
  assert.match(chat, /"\/api\/cc\/channels\/" \+ encodeURIComponent\(channelId\) \+ "\/close"/);
  assert.match(chat, /SA\.views\.ccPendingBar\(/);
  // ターンが無いので実行中の行は出さない
  assert.match(chat, /const run = isCc \? null : store\.runningOf\(channelId\)/);
  assert.match(read("workbench.js"), /ch\.kind !== "cc" && !busy \? \(\) => SA\.chat\.renew\(ch\.id\)/);
  // 画面の写しは cc のチャンネルの会話のタブでも読む（閉じていれば一覧と同じ間隔）
  assert.match(read("api.js"), /ccScreenIdle\(\) \? CC_LIST_INTERVAL_MS : CC_SCREEN_INTERVAL_MS/);
});

test("web static: ≤639px でも Claude Code のチャンネルを閉じられる（見出しの […] とパレットの「このチャンネルを閉じる」。#249）", () => {
  const chat = read("chat.js");
  const ccHeader = /function ccHeader\(ch, channelId\) \{([\s\S]*?)\n  \}\n/.exec(chat)?.[1] ?? "";
  assert.ok(ccHeader.length > 0);
  // [閉じる] と同じ .ed-ops に […] がある（≤639px で [閉じる] を隠しても口が残る）
  assert.match(ccHeader, /ed-ops-more/);
  assert.match(ccHeader, /el\("div", \{ class: "ed-ops" \}, \[close, more\]\)/);
  // [画面] 以外のリンクは ≤639px で隠す
  assert.equal((ccHeader.match(/btn btn-ghost btn-sm hide-sm/g) ?? []).length, 2);
  // […] はこのチャンネルの操作だけのシートを開く（UI-7。fix の段ではパレットのコマンドだった）
  assert.match(ccHeader, /more\.addEventListener\("click", \(\) =>\n {6}SA\.app\.sheet\(/);
  const wb = read("workbench.js");
  // cc のタブでは /close・/wait の代わりに「このチャンネルを閉じる」などを並べる（無効の /close を先に出さない）
  assert.match(wb, /\.\.\.\(ch && ch\.kind === "cc"\n {8}\? ccCommands\(ch\)\n {8}: \[\n {12}\{ label: "今のセッションを閉じる"/);
  const ccCommands = /function ccCommands\(ch\) \{([\s\S]*?)\n  \}\n/.exec(wb)?.[1] ?? "";
  assert.match(ccCommands, /const state = SA\.chat\.ccCommandState\(ch\.id\);/);
  // 閉じるは終わったチャンネルでは無効（run が null で why「閉じています」）
  assert.match(ccCommands, /label: "このチャンネルを閉じる"[\s\S]{0,200}run: state\.closable \? \(\) => SA\.chat\.closeCcChannel\(ch\.id\) : null,\n {8}why: "閉じています"/);
  assert.match(ccCommands, /if \(rc\) items\.push\(\{ label: "RC で開く"/);
  assert.match(ccCommands, /if \(discord\) items\.push\(\{ label: "Discord で開く"/);
  assert.match(chat, /\n {4}closeCcChannel,\n {4}ccCommandState,\n/);
  assert.match(chat, /return \{ closable: live\.state !== "ended", rc: live\.rc, discord: discordUrl\(ch\.link\) \};/);
});

/** app.css の ≤639px のブロック（ファイルの最後の @media (max-width: 639px)） */
function phoneCss(): string {
  const css = read("app.css");
  const at = css.lastIndexOf("@media (max-width: 639px) {");
  assert.ok(at >= 0);
  return css.slice(at);
}

test("web static: スマホの殻（UI-7。#250）: ≤639px はタブの帯・パネル・切り替えを隠し、見出しの [‹] と下タブで一覧 ⇄ 本文を行き来する", () => {
  const phone = phoneCss();
  assert.match(phone, /\n {2}\.tabbar,\n {2}#panel-toggle,\n {2}#theme-toggle,\n {2}#sidebar-toggle,\n {2}\.wb-panel,\n {2}\.wb-sash-panel \{\n {4}display: none;\n {2}\}/);
  assert.match(phone, /\n {2}\.ed-back \{\n {4}display: inline-flex;/);
  assert.match(phone, /\.palette-item kbd \{\n {4}display: none;/);
  // ≥640px では [‹]・今の画面の名前を出さない
  const css = read("app.css");
  assert.match(css, /\n\.ed-ops-more,\n\.ed-back \{\n {2}display: none;\n\}/);
  assert.match(css, /\n\.wb-brand-status,\n\.wb-title-current \{\n {2}display: none;\n\}/);
  assert.match(read("index.html"), /<span class="wb-title-current" id="title-current"><\/span>/);
  // [‹] は ui.js の 1 つの部品で、会話の見出し（3 つ）と views.js の toolbar が使う
  assert.match(read("ui.js"), /class: "btn btn-ghost btn-sm btn-icon-sm ed-back"[^\n]*"aria-label": "一覧へ"/);
  assert.match(read("ui.js"), /addEventListener\("click", \(\) => SA\.app\.openDrawer\(\)\)/);
  assert.equal((read("chat.js").match(/SA\.ui\.backButton\(\)/g) ?? []).length, 3);
  assert.match(read("views.js"), /el\("div", \{ class: "ed-title" \}, \[SA\.ui\.backButton\(\), icon\(iconName\)/);
  // 下タブ: タスク・リマインドはタブを直接開き、会話は押すたびに一覧を開く（トグルしない）
  const sidebar = read("sidebar.js");
  for (const id of ["tasks", "reminders"]) assert.match(sidebar, new RegExp(`\\{ id: "${id}",[^\\n]*phoneTab: true`), id);
  assert.doesNotMatch(sidebar, /\{ id: "chat",[^\n]*phoneTab/);
  const wb = read("workbench.js");
  assert.match(wb, /if \(phone\(\) && a\.phoneTab\) \{\n {6}open\(a\.id\);\n {6}closeDrawer\(\);/);
  // 一覧 → 本文は履歴に積み、戻る（popstate）で一覧へ
  assert.match(wb, /history\.replaceState\(\{ saList: true \}, ""\);\n {8}history\.pushState\(\{ saBody: true \}/);
  // popstate は印のある entry だけ: 一覧の entry（saList）で一覧を開き、本文の entry（saBody。「進む」）では積まずに閉じるだけ
  assert.match(wb, /window\.addEventListener\("popstate", \(e\) => \{/);
  assert.match(wb, /if \(st && st\.saList && !S\.drawerOpen\) \{/);
  assert.match(wb, /\} else if \(st && st\.saBody && S\.drawerOpen\) \{\n {8}hideDrawer\(\);/);
  // history.back() で開かなければ保険で開く・指の端末では絞り込みの欄に焦点を当てない
  assert.match(wb, /setTimeout\(\(\) => \{\n {10}if \(!S\.drawerOpen\) showDrawer\(\);\n {8}\}, BACK_FALLBACK_MS\);/);
  assert.match(wb, /mqCoarse\.matches \? refs\.sidebar\.querySelector\("button"\) \|\| refs\.sidebar/);
  assert.match(wb, /history\.replaceState\(history\.state,/);
  // パレットはスマホで PC の部品（サイドバー・パネル・タブを閉じる・テーマ）を出さない
  assert.equal((wb.match(/pcOnly: true \}/g) ?? []).length, 4);
  assert.match(wb, /\.filter\(\(it\) => !\(it\.pcOnly && phone\(\)\)\)/);
  // 鈴はスマホでは知らせのタブ
  assert.match(wb, /if \(phone\(\)\) \{\n {10}open\("notices"\);/);
  assert.match(read("views.js"), /notices: \{ title: "知らせ", icon: "bell", render: renderNotices/);
});

test("web static: 会話・Claude Code の見出しの […] はそのチャンネルの操作だけのシートで、パレットを開かない（UI-7 の K1）", () => {
  const chat = read("chat.js");
  assert.doesNotMatch(chat, /SA\.app\.palette\(/);
  assert.equal((chat.match(/SA\.app\.sheet\(/g) ?? []).length, 2);
  for (const label of ["待ちにする", "閉じる", "会話を新しくする", "ページを開く", "Discord で開く", "RC で開く"]) assert.match(chat, new RegExp(`label: "${label}"`), label);
  const wb = read("workbench.js");
  assert.match(wb, /function openSheet\(label, items, opener\)/);
  assert.match(wb, /sheet: openSheet,/);
  // 「その他」の aria-expanded は「その他」のシートのときだけ
  assert.match(wb, /"aria-expanded": String\(S\.moreOpen && S\.sheetKind === "more"\)/);
});

test("web static: スマホ（≤639px）のトーストはそれぞれ 1 つまでで、[取り消す] 付きも 4 秒で消える（UI-8。#251）", () => {
  const { ui, boxes, advance } = loadToast({ phone: true });
  ui.toast("完了にしました", { label: "取り消す", run: () => undefined });
  ui.toast("別の知らせ");
  advance(400);
  assert.deepEqual(boxes.toast.children.map((c) => c.children[0]!.textContent), ["別の知らせ"], "新しいもので置き換える");
  ui.toast("完了にしました", { label: "取り消す", run: () => undefined });
  advance(4000);
  advance(400);
  assert.equal(boxes.toast.children.length, 0, "[取り消す] 付きも消える");
  ui.toast("送れませんでした", null, { level: "error" });
  ui.toast("読めませんでした", null, { level: "error" });
  advance(400);
  assert.deepEqual(boxes["toast-alert"].children.map((c) => c.children[0]!.textContent), ["読めませんでした"]);
  advance(60000);
  assert.equal(boxes["toast-alert"].children.length, 1, "失敗は自動で消えない");
});

test("web static: ≤639px のダイアログは下からのシート・トーストは上・キーボードの間は下タブを隠す（UI-8。#251）", () => {
  const phone = phoneCss();
  const dialog = /\n {2}dialog \{([^}]*)\}/.exec(phone)?.[1] ?? "";
  assert.match(dialog, /width: 100%;/);
  assert.match(dialog, /max-width: none;/);
  assert.match(dialog, /margin: auto 0 var\(--kb, 0px\);/);
  assert.match(dialog, /padding-bottom: calc\(var\(--space-6\) \+ env\(safe-area-inset-bottom, 0px\)\);/);
  assert.match(dialog, /border-radius: var\(--radius-lg\) var\(--radius-lg\) 0 0;/);
  assert.match(dialog, /transform: translateY\(100%\);/);
  assert.match(phone, /@starting-style \{\n {4}dialog\[open\] \{\n {6}opacity: 1;\n {6}transform: translateY\(100%\);/);
  assert.match(phone, /\n {2}\.dialog-actions \{\n {4}display: grid;\n {4}grid-template-columns: 1fr 1fr;/);
  const toast = /\n {2}\.toast-region \{([^}]*)\}/.exec(phone)?.[1] ?? "";
  assert.match(toast, /top: calc\(var\(--titlebar-h\) \+ env\(safe-area-inset-top, 0px\)/);
  assert.match(toast, /bottom: auto;/);
  assert.match(phone, /\.toast-stack \.toast\.is-leaving \{\n {4}transform: translateY\(-8px\);/);
  assert.match(phone, /\.wb\.is-keyboard \.wb-activity \{\n {4}display: none;/);
  assert.match(phone, /\.more-row \.icon \{\n {4}width: var\(--icon-sm\);/);
  assert.match(read("app.css"), /\n\.wb \{\n {2}display: grid;\n {2}height: var\(--vvh, 100dvh\);/);
  assert.match(read("index.html"), /<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover, interactive-widget=resizes-content">/);
  assert.match(read("index.html"), /<p id="dlg-confirm-target" class="dlg-target" hidden><\/p>/);
  const wb = read("workbench.js");
  assert.match(wb, /vv\.addEventListener\("resize", fitViewport\)/);
  assert.match(wb, /root\.style\.setProperty\("--vvh", /);
  assert.match(wb, /sheetHead\("その他"\)/);
  // backdrop（箱の外）の click で閉じる
  assert.match(read("ui.js"), /if \(close\) closeDialog\(dialog\);/);
  // 確認の見出しは動詞だけ（対象は target）
  for (const name of ["chat.js", "views.js"]) assert.doesNotMatch(read(name), /title: "「" \+/, name);
  assert.match(read("chat.js"), /title: "閉じますか",\n {6}target: ch\.title,/);
  assert.match(read("views.js"), /title: "止めますか",\n {10}target: r\.text,/);
});

test("web static: UI-8 のレビュー: キーボードは幅ごとの最大の高さで判定・backdrop は押し始めも外・確認の説明・起動の詳しい設定", () => {
  const wb = read("workbench.js");
  assert.match(wb, /const keyboard = vv\.height < full - KEYBOARD_MIN_PX;/);
  assert.match(wb, /root\.style\.setProperty\("--vvt", /);
  assert.match(wb, /pinchTimer = setTimeout\(fitViewport, PINCH_RECHECK_MS\);/);
  const ui = read("ui.js");
  assert.match(ui, /dialog\.addEventListener\("pointerdown"/);
  assert.match(ui, /const close = downOutside && outside\(event\);/);
  assert.match(ui, /opts\.target\.trim\(\) !== ""/);
  const html = read("index.html");
  assert.match(html, /<dialog id="dlg-confirm" aria-labelledby="dlg-confirm-title" aria-describedby="dlg-confirm-target dlg-confirm-body">/);
  assert.match(html, /<textarea class="textarea" id="cc-start-text" rows="3"/);
  assert.match(html, /<details class="dlg-more" id="cc-start-more">\s*<summary>詳しい設定<\/summary>\s*<div class="field">\s*<label for="cc-start-mode">/);
  const phone = phoneCss();
  assert.match(phone, /\.wb\.is-keyboard \.wb-sidebar \{\n {4}bottom: var\(--kb, 0px\);/);
  assert.match(phone, /top: var\(--vvt, 0px\);/);
});

test("web static: 視認性（UI-9。#252）: 刻む数字は本文の色と tabular-nums、≤639px の一覧の題 16・群 14、バッジは無地、長押しのプレビューを出さない", () => {
  const css = read("app.css");
  // 実行中の行・許可の残り時間（PC も同じ）
  assert.match(css, /\n\.run-line > \[data-run-progress\] \{\n {2}color: var\(--text\);\n {2}font-variant-numeric: tabular-nums;/);
  assert.match(css, /\n\.cc-permission \[data-permission-left\] \{\n {2}color: var\(--text\);\n {2}font-variant-numeric: tabular-nums;/);
  assert.match(css, /\[data-permission-left\]\.is-urgent \{\n {2}color: var\(--warning\);/);
  // .badge は無地（塗りのピルは .act-count だけ）
  assert.match(css, /\n\.badge \{\n {2}padding: 0;\n {2}background: transparent;/);
  // 長押しのプレビュー
  assert.match(css, /\n\.btn,\n\.act-btn,\n\.tab,\n\.sb-row,\n\.more-row \{\n {2}-webkit-touch-callout: none;/);
  const phone = phoneCss();
  assert.match(phone, /\n {2}\.sb-title \{\n {4}font-size: var\(--font-base\);/);
  assert.match(phone, /\n {2}\.sb-group > summary,\n[^{]*\{\n {4}font-size: var\(--font-sm\);/);
  assert.match(phone, /\n {2}\.sb-row \{\n {4}padding-left: var\(--space-4\);/);
  assert.match(phone, /\n {2}\.segmented-sm > button \{\n {4}min-height: var\(--row\);\n {4}border-radius: var\(--radius-md\);\n {4}font-size: var\(--font-sm\);/);
  assert.match(phone, /\n {2}\.sb-text \{\n {4}line-height: var\(--leading-tight\);/);
  assert.match(phone, /\n {2}\.msg-bubble \{\n {4}max-width: 85%;/);
  assert.match(phone, /:root\[data-theme="dark"\] \.composer \{\n {4}background: var\(--muted\);/);
  assert.match(phone, /\n {2}\.cc-permission \.card-head h2 \{\n {4}font-size: var\(--font-base\);/);
  assert.match(phone, /\n {2}\.cc-permission \.msg-actions \{\n {4}display: grid;\n {4}grid-template-columns: 1fr 1fr;/);
  // 人格のバッジは人格が 2 体以上のときだけ。Claude Code の行は 2 行目に場所、スマホはバッジの代わりに点
  assert.match(read("chat.js"), /store\.channels\.personas\.length > 1 \? el\("span", \{ class: "badge"/);
  const sidebar = read("sidebar.js");
  assert.match(sidebar, /sub: s\.cwdLabel \|\| null,/);
  assert.match(sidebar, /class: "sb-sub show-sm"/);
  assert.match(sidebar, /class: "badge hide-sm "/);
});

// ===== 質問のカード（AskUserQuestion。docs/plan/claude-code-questions.md §4。Q3） =====
const QUESTIONS = [
  {
    question: "どの色にしますか",
    header: "色",
    multiSelect: false,
    options: [
      { label: "赤", description: "目立つ" },
      { label: "青", description: "" },
    ],
  },
  {
    question: "どれを入れますか",
    header: "",
    multiSelect: true,
    options: [
      { label: "A", description: "" },
      { label: "B", description: "" },
      { label: "C", description: "" },
    ],
  },
];

function questionPermission(id: number, extra: Record<string, unknown> = {}) {
  return {
    id,
    state: "pending",
    toolName: "AskUserQuestion",
    summary: "質問 2 問: どの色にしますか",
    expiresAt: new Date(Date.now() + 600000).toISOString(),
    requestHash: "qh",
    question: { questions: QUESTIONS, answers: null },
    ...extra,
  };
}

/** 選択肢の input（label の文で探す） */
function optionInput(card: FakeNode, text: string): FakeNode & { checked: boolean } {
  const label = descendants(card).find((n) => n.tagName === "label" && n.textContent.startsWith(text))!;
  return descendants(label).find((n) => n.tagName === "input")! as FakeNode & { checked: boolean };
}

function pick(input: FakeNode & { checked: boolean }, checked = true): void {
  input.checked = checked;
  input.dispatch("change");
}

test("web static: 質問のカードは問ごとに見出し・問の文・選択肢（単一はラジオ・複数はチェック）と「その他」を出し、ツール名は出さない", () => {
  const { views } = loadViews();
  const card = views.ccPermissionCard("s1", questionPermission(20), null)!;
  assert.equal(descendants(card).find((n) => n.tagName === "h2")!.textContent, "質問を待っています");
  assert.ok(descendants(card).some((n) => n.getAttribute("data-permission-left")), "残り時間は許可と同じ刻み");
  assert.doesNotMatch(card.textContent, /AskUserQuestion/);
  assert.match(card.textContent, /web-ui/, "名前（セッション）は出す");
  const fieldsets = descendants(card).filter((n) => n.tagName === "fieldset");
  assert.equal(fieldsets.length, 2);
  assert.equal(descendants(fieldsets[0]!).find((n) => n.tagName === "legend")!.textContent, "色");
  assert.equal(descendants(fieldsets[1]!).find((n) => n.tagName === "legend")!.textContent, "問 2", "header が無ければ「問 n」（問の文と重ねない）");
  assert.match(fieldsets[0]!.textContent, /どの色にしますか/);
  const types = (f: FakeNode) => descendants(f).filter((n) => n.tagName === "input").map((n) => n.getAttribute("type"));
  assert.deepEqual(types(fieldsets[0]!), ["radio", "radio", "radio"], "選択肢 2 つ + その他");
  assert.deepEqual(types(fieldsets[1]!), ["checkbox", "checkbox", "checkbox", "checkbox"]);
  // label は太く、説明はその下（二次の色）
  const red = descendants(fieldsets[0]!).find((n) => n.tagName === "label")!;
  assert.ok(red.classes.has("check"), "当たりは .check（44px）");
  assert.equal(descendants(red).find((n) => n.tagName === "strong")!.textContent, "赤");
  assert.equal(descendants(red).find((n) => n.classes.has("cc-question-desc"))!.textContent, "目立つ");
  assert.ok(descendants(fieldsets[0]!).some((n) => n.tagName === "strong" && n.textContent === "その他"));
  // 「その他」の textarea は選ぶまで隠す
  const other = descendants(fieldsets[0]!).find((n) => n.tagName === "textarea")!;
  assert.equal(other.hidden, true);
  assert.equal(other.getAttribute("maxlength"), "1000");
  // [答える]（primary）[やめる]（ghost）
  const buttons = card.buttons();
  assert.deepEqual(buttons.map((b) => b.textContent), ["答える", "やめる"]);
  assert.ok(buttons[0]!.classes.has("btn-primary"));
  assert.ok(buttons[1]!.classes.has("btn-ghost"));
});

test("web static: 質問のカードは全部の問に答えるまで [答える] が無効で、answers は問の順に labels（選択肢の順）か other", async () => {
  const { views, posts, bodies } = loadViews();
  const card = views.ccPermissionCard("s1", questionPermission(21), null)!;
  const answer = card.buttons()[0]! as FakeNode & { disabled: boolean; title: string };
  assert.equal(answer.disabled, true);
  assert.match(answer.title, /すべての問に答えると押せます/);
  pick(optionInput(card, "青"));
  assert.equal(answer.disabled, true, "1 問だけでは押せない");
  pick(optionInput(card, "C"));
  pick(optionInput(card, "A"));
  assert.equal(answer.disabled, false);
  assert.equal(answer.getAttribute("title"), null);
  // 押せない状態で押しても送らない・押せば /answer
  answer.dispatch("click");
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(posts, ["/api/cc/permissions/21/answer"]);
  assert.deepEqual(JSON.parse(JSON.stringify(bodies[0])), { requestHash: "qh", answers: [{ labels: ["青"] }, { labels: ["A", "C"] }] });

  // 「その他」: 選ぶと textarea が出て、空なら押せない。選択肢と同時には選べない
  const p22 = questionPermission(22);
  const card2 = views.ccPermissionCard("s1", p22, null)!;
  const answer2 = card2.buttons()[0]! as FakeNode & { disabled: boolean };
  pick(optionInput(card2, "赤"));
  const fieldsets = descendants(card2).filter((n) => n.tagName === "fieldset");
  const otherBox = descendants(fieldsets[1]!).filter((n) => n.tagName === "input").at(-1)! as FakeNode & { checked: boolean };
  pick(optionInput(card2, "B"));
  pick(otherBox);
  assert.equal(optionInput(card2, "B").checked, false, "その他を選ぶと選択肢は外れる");
  const text = descendants(fieldsets[1]!).find((n) => n.tagName === "textarea")! as FakeNode & { value: string };
  assert.equal(text.hidden, false);
  assert.equal(answer2.disabled, true, "その他が空なら押せない");
  text.value = "  D を入れる  ";
  text.dispatch("input");
  assert.equal(answer2.disabled, false);
  // 描き直しても選んだ状態が残る（同じ要素）
  const again = views.ccPermissionCard("s1", { ...p22 }, null)!;
  assert.equal(again, card2, "中身が変わらなければ同じ要素");
  answer2.dispatch("click");
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(JSON.parse(JSON.stringify(bodies[1])), { requestHash: "qh", answers: [{ labels: ["赤"] }, { other: "D を入れる" }] });
  // 純関数: 答えていない問があれば null
  assert.equal(views.ccQuestionPicks(QUESTIONS, [{ labels: ["赤"], other: false, text: "" }, { labels: [], other: false, text: "" }]), null);
});

test("web static: 質問のカードの [やめる] は確認なしで /deny、409 は古い・400 は形が合わない", async () => {
  const { views, posts, bodies, toasts, setReply } = loadViews();
  const card = views.ccPermissionCard("s1", questionPermission(23), null)!;
  card.buttons()[1]!.dispatch("click");
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(posts, ["/api/cc/permissions/23/deny"]);
  assert.deepEqual(JSON.parse(JSON.stringify(bodies[0])), { requestHash: "qh" });
  setReply(() => Promise.reject(Object.assign(new Error("x"), { status: 409 })));
  views.ccPermissionCard("s1", questionPermission(24), null)!.buttons()[1]!.dispatch("click");
  await new Promise((r) => setImmediate(r));
  assert.match(toasts.at(-1)!, /この操作は古くなっています/);
  setReply(() => Promise.reject(Object.assign(new Error("x"), { status: 400 })));
  views.ccPermissionCard("s1", questionPermission(25), null)!.buttons()[1]!.dispatch("click");
  await new Promise((r) => setImmediate(r));
  assert.equal(toasts.at(-1), "答えの形が合いません");
});

test("web static: 質問のカードは cc: と ch: のタブで選んだ状態を共有し、同じタブでは同じ要素を返す。終わった・古い要求の選んだ状態は捨てる", async () => {
  const { views, setReply } = loadViews();
  const p = questionPermission(40);
  const inCc = views.ccPermissionCard("s1", p, null)!;
  const inCh = (views.ccPermissionCard as (s: string, p: unknown, rc: null, tab: string) => FakeNode)("s1", p, null, "ch:c1");
  assert.notEqual(inCc, inCh, "タブごとに別の要素");
  pick(optionInput(inCh, "赤"));
  // cc: のタブを描き直すと、ch: で選んだものが写る（[答える] も更新される）
  assert.equal(views.ccPermissionCard("s1", p, null), inCc);
  assert.equal(optionInput(inCc, "赤").checked, true);
  pick(optionInput(inCc, "A"));
  assert.equal((inCc.buttons()[0] as FakeNode & { disabled: boolean }).disabled, false);
  // ccQuestionForget で選んだ状態とカードを捨てる（次は新しい要素・空）
  views.ccQuestionForget(40);
  const fresh = views.ccPermissionCard("s1", p, null)!;
  assert.notEqual(fresh, inCc);
  assert.equal(optionInput(fresh, "赤").checked, false);
  // 409 で捨てる
  pick(optionInput(fresh, "青"));
  setReply(() => Promise.reject(Object.assign(new Error("x"), { status: 409 })));
  fresh.buttons()[1]!.dispatch("click");
  await new Promise((r) => setImmediate(r));
  assert.equal(optionInput(views.ccPermissionCard("s1", p, null)!, "青").checked, false);
});

test("web static: placeChildren は中に残る要素を動かさず（外さず）、ほかを前後に差し込む", () => {
  const { views } = loadViews();
  const box = new FakeNode("div");
  const [a, b, kept, c, composer] = ["a", "b", "kept", "c", "composer"].map((t) => Object.assign(new FakeNode("div"), { text: t }));
  box.append(a!, kept!, composer!);
  let removed = 0;
  const remove = kept!.remove.bind(kept);
  kept!.remove = () => {
    removed++;
    remove();
  };
  views.placeChildren(box, [b!, kept!, null, c!, composer!]);
  assert.deepEqual(box.children.map((n) => n.text), ["b", "kept", "c", "composer"]);
  assert.equal(removed, 0, "残る要素は一度も外さない");
});

test("web static: 終わった質問のカードは answers から「1. <見出し>: <答え>」、答えなかった・端末で答えた・時間切れの文", () => {
  const { views } = loadViews();
  const answered = views.ccPermissionCard(
    "s1",
    questionPermission(30, { state: "allowed", via: "web", resolvedAt: new Date().toISOString(), question: { questions: QUESTIONS, answers: { "どの色にしますか": "青", "どれを入れますか": "A, C" } } }),
    null,
  )!;
  assert.equal(answered.buttons().length, 0);
  assert.equal(descendants(answered).some((n) => n.tagName === "fieldset"), false);
  assert.match(answered.textContent, /答えました（Web）/);
  assert.match(answered.textContent, /1\. 色: 青/);
  assert.match(answered.textContent, /2\. どれを入れますか: A, C/);
  const discord = views.ccPermissionCard("s1", questionPermission(31, { state: "allowed", via: "discord", question: { questions: QUESTIONS, answers: {} } }), null)!;
  assert.match(discord.textContent, /答えました（Discord）/);
  assert.match(views.ccPermissionCard("s1", questionPermission(32, { state: "denied", via: "web" }), null)!.textContent, /答えませんでした（Web）/);
  assert.match(views.ccPermissionCard("s1", questionPermission(33, { state: "answered_elsewhere" }), null)!.textContent, /端末か RC で答えられました/);
  assert.match(views.ccPermissionCard("s1", questionPermission(34, { state: "expired" }), null)!.textContent, /時間切れ/);
});

test("web static: 質問のカードは innerHTML を使わず、サイドバーの印は「質問」（title に最初の問）", () => {
  const views = read("views.js");
  const start = views.indexOf("function ccQuestionCard");
  assert.ok(start > 0);
  assert.doesNotMatch(views, /innerHTML/);
  const sidebar = read("sidebar.js");
  assert.match(sidebar, /questions \? "質問" : "許可待ち"/);
  assert.match(sidebar, /"質問: " \+ SA\.views\.oneLine\(String\(questions\[0\]\.question/);
});

test("web static: 許可のカードの説明はスマホで常設、残り 60 秒を切ったら is-urgent（UI-9）", () => {
  const { views } = loadViews();
  const soon = { id: 1, state: "pending", toolName: "Bash", summary: "ls", expiresAt: new Date(Date.now() + 30000).toISOString(), requestHash: "h" };
  const card = views.ccPermissionCard("s1", soon, null)!;
  const left = descendants(card).find((n) => n.getAttribute("data-permission-left"))!;
  assert.ok(left.classes.has("is-urgent"));
  const note = descendants(card).find((n) => n.classes.has("cc-permission-note"))!;
  assert.ok(note.classes.has("show-sm"));
  assert.match(note.textContent, /端末や RC のダイアログでも答えられます/);
  const later = views.ccPermissionCard("s1", { ...soon, id: 2, expiresAt: new Date(Date.now() + 120000).toISOString() }, null)!;
  assert.equal(descendants(later).find((n) => n.getAttribute("data-permission-left"))!.classes.has("is-urgent"), false);
});

test("web static: ≤639px はタスク・リマインド・使用量の表を行の積みにし（tr を grid・th を隠す・data-label なし）、ナレッジは中身だけ・環境変数は縦（UI-10）", () => {
  const views = read("views.js");
  // table() の stack と、それを使う 4 つの表（タスク・リマインド・使用量の人格とターン）
  assert.match(views, /function table\(headers, rows, cls, opts\)/);
  assert.match(views, /"table-wrap" \+ \(stack \? " table-wrap-stack" : ""\)/);
  for (const cls of ["table-tasks", "table-reminders", "table-num table-personas", "table-num table-turns"]) {
    assert.match(views, new RegExp(`"${cls}",?\\s*\\{ stack: true \\}`), cls);
  }
  assert.doesNotMatch(views, /data-label/);
  assert.doesNotMatch(views, /td-more/);
  // 末尾の常設の説明文を消し、止めたトーストは 1 行に
  assert.doesNotMatch(views, /タスクは #inbox か #tasks の会話で頼むと増え、変わります。/);
  assert.doesNotMatch(views, /Discord にだけあります。/);
  assert.doesNotMatch(views, /#github に出したもの/);
  assert.match(views, /toast\("「" \+ oneLine\(r\.text\) \+ "」を止めました"\)/);
  assert.match(views, /master-detail master-detail-phone/);
  assert.match(views, /kv-list kv-grid kv-env/);
  assert.match(views, /section\("スマホの操作"/);
  // grid-area で置く td の class は views.js と 639px 以下の app.css の両方にある
  const phoneCss = read("app.css").slice(read("app.css").lastIndexOf("@media (max-width: 639px) {"));
  for (const cls of ["td-check", "td-main", "td-due", "td-remind", "td-next", "td-kind", "td-place", "td-actions", "td-turns", "td-input", "td-output", "td-rate", "td-time", "td-kind-name", "td-result", "td-turn-rate"]) {
    assert.match(views, new RegExp(`"(?:[^"]* )?${cls}(?: [^"]*)?"`), cls);
    assert.match(phoneCss, new RegExp(`\\.${cls}\\b[^{]*\\{[^}]*grid-area:`), cls);
  }
  assert.match(views, /"ed-toolbar-kb"/);
  // 会話の数のピルは桁区切り
  assert.match(read("workbench.js"), /class: "act-count", text: count\(n\)/);

  // 積みの規則は 639px 以下のブロックの中だけ（PC は変えない）
  const css = read("app.css");
  const at = css.lastIndexOf("@media (max-width: 639px) {");
  assert.ok(at > 0);
  const before = css.slice(0, at);
  const phone = css.slice(at);
  assert.doesNotMatch(before, /table-stack|master-detail-phone|kv-env/);
  const rule = (sel: string): string => new RegExp(`\\n {2}${sel.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} \\{([^}]*)\\}`).exec(phone)?.[1] ?? "";
  assert.match(rule(".table-stack thead"), /display: none;/);
  assert.match(rule(".table-stack tr"), /display: grid;/);
  assert.match(rule(".table-wrap-stack"), /overflow-x: visible;/);
  for (const t of ["tasks", "reminders", "personas", "turns"]) assert.match(rule(`.table-${t} tr`), /grid-template-areas:/, t);
  assert.match(rule(".table-num.table-stack .td-rate"), /font-size: var\(--font-xl\);/);
  assert.match(rule(".table-tasks .td-check .check"), /width: 48px;/);
  assert.match(rule(".table-reminders .td-apart > :last-child"), /margin-left: auto;/);
  assert.match(phone, /\.master-detail-phone > \.master,/);
  assert.match(rule(".kv-env > .kv"), /flex-direction: column;/);
  assert.doesNotMatch(css, /data-label|td-more/);
});

test("web static: 会話の行は吹き出し（#263）: オーナーは右・Bot は左、地の色は 4 つの色のブロックにあり、アバターは無い", () => {
  const css = read("app.css");
  const rule = (sel: string): string => {
    const at = css.indexOf("\n" + sel + " {");
    assert.ok(at >= 0, sel);
    return css.slice(at, css.indexOf("}", at));
  };
  assert.match(rule(".msg"), /align-items: flex-start;/);
  assert.match(rule(".msg-owner"), /align-items: flex-end;/);
  assert.match(rule(".msg-owner > .msg-bubble"), /background: var\(--bubble-owner\);/);
  assert.match(rule(".msg-agent > .msg-bubble"), /background: var\(--bubble-agent\);/);
  assert.match(rule(".msg-bubble"), /max-width: 75%;/);
  assert.match(rule(".msg-text"), /user-select: text;/);
  assert.match(rule(".tl"), /gap: var\(--space-3\);/);
  // 色の 4 ブロック（dark・light・data-theme なし・その dark）のそれぞれに吹き出しの地
  const blocks = [
    /:root\[data-theme="dark"\] \{[^}]*--bubble-owner: #[0-9a-f]{6};[^}]*\}/,
    /:root\[data-theme="light"\] \{[^}]*--bubble-owner: #[0-9a-f]{6};[^}]*\}/,
    /\n:root:not\(\[data-theme\]\) \{[^}]*--bubble-owner: #[0-9a-f]{6};[^}]*\}/,
    /@media \(prefers-color-scheme: dark\) \{\n {2}:root:not\(\[data-theme\]\) \{[^}]*--bubble-owner: #[0-9a-f]{6};[^}]*\}/,
  ];
  // 変数の定義は tokens.css、使う規則は app.css
  const tokens = read("tokens.css");
  for (const re of blocks) assert.match(tokens, re);
  assert.equal(tokens.match(/--bubble-owner: #/g)?.length, 4);
  assert.equal(tokens.match(/--bubble-agent: #/g)?.length, 4);
  assert.doesNotMatch(css, /avatar/);
  const chat = read("chat.js");
  assert.doesNotMatch(chat, /avatar/);
  // 読み上げの話者（article の aria-label）
  assert.match(chat, /bubbleRow\("owner", "オーナー", null,/);
  assert.match(chat, /bubbleRow\("agent", "作業中", name,/);
  assert.match(chat, /"aria-label": label/);
  // 同じ話者の Bot が続くときは名前を出さない
  assert.match(chat, /renderTurn\(turn, channelId, ch, prev\)/);
  assert.match(chat, /renderRunning\(ch, run, prev\)/);
  // ライトの Bot の吹き出しは地より一段暗く、中のコードは白
  assert.equal(tokens.match(/--bubble-agent: #e4e8ef;/g)?.length, 2);
  assert.equal(tokens.match(/--bubble-inset: #ffffff;/g)?.length, 2);
  // 指の端末では時刻のリンクの当たりを広げる
  assert.match(css, /@media \(pointer: coarse\) \{\n {2}a\.tl-time \{\n {4}position: relative;\n {2}\}\n\n {2}a\.tl-time::before \{\n {4}content: "";\n {4}position: absolute;\n {4}inset: -8px;/);
  // Bot の名前は人格が 2 体以上か Claude Code のチャンネルのときだけ
  assert.match(chat, /function showsAgentName\(ch\) \{\n {4}return !!\(ch && ch\.kind === "cc"\) \|\| !!\(store\.channels && store\.channels\.personas\.length > 1\);/);
  assert.match(css, /\n\.tl-notice \{(?![^}]*padding-left)[^}]*\}/);
});

test("web static: 実行中の行は 1 行 + 直近 3 つの手順の二次の文字、すべての手順は押して開く（Q5・#118）", () => {
  const chat = read("chat.js");
  // 1 行目はスピナー + 刻む数字の「作業中…」
  assert.match(chat, /el\("div", \{ class: "run-line" \}, \[el\("span", \{ class: "spinner", "aria-hidden": "true" \}\), el\("span", \{ "data-run-progress": run\.channelId, text: progressText\(run\) \}\)\]\)/);
  // 直近の 3 つ（最後が今の手順）
  assert.match(chat, /const RECENT_STEPS = 3;/);
  assert.match(chat, /el\("ol", \{ class: "run-recent" \}\)/);
  assert.match(chat, /run\.steps\.slice\(-RECENT_STEPS\)/);
  assert.match(chat, /i === last\.length - 1 \? "is-current" : null/);
  // 3 つを超えたときだけ「すべての手順（n）」。既定は閉じ、開いたチャンネルを覚える
  assert.match(chat, /if \(run\.steps\.length > RECENT_STEPS\) \{/);
  assert.match(chat, /el\("details", \{ class: "steps-plain", open: stepsOpened\.has\(run\.channelId\) \}/);
  assert.match(chat, /el\("span", \{ text: allStepsLabel\(run\) \}\)/);
  assert.match(chat, /\(run\.toolCalls > run\.steps\.length \? "直近の手順（" : "すべての手順（"\) \+ run\.steps\.length \+ "）"/);
  // タブを閉じたら開いた印を消す
  assert.match(chat, /delete openSteps\[channelId\];\n {8}stepsOpened\.delete\(channelId\);/);
  assert.doesNotMatch(chat, /stepsClosed/);
  // 終わった返事の手順も枠の無い details
  assert.match(chat, /el\("details", \{ class: "steps-plain", open: opened\.has\(turn\.id\) \}/);
  assert.doesNotMatch(chat, /class: "steps"/);
  const css = read("app.css");
  // 枠・地のカード（.steps）は無い
  assert.doesNotMatch(css, /(^|\n)\.steps \{/);
  assert.doesNotMatch(css, /\.msg-bubble \.steps/);
  assert.doesNotMatch(css, /\.steps > /);
  // --text-muted は Bot の吹き出しの上に置かない（ライトで 4.4:1。GUIDELINES §2.2）
  assert.match(css, /\n\.run-recent \{[^}]*color: var\(--text-secondary\);[^}]*font-size: var\(--font-sm\);[^}]*list-style: none;[^}]*overflow-wrap: anywhere;/);
  assert.match(css, /\n\.run-recent > li\.is-current \{\n {2}color: var\(--text\);/);
  assert.match(css, /\n\.steps-plain > summary \{[^}]*color: var\(--text-secondary\);/);
  assert.doesNotMatch(css, /\n\.(run-recent|steps-plain|steps-list)[^{]*\{[^}]*--text-muted/);
  assert.match(css, /\n\.steps-plain \{\n {2}font-size: var\(--font-sm\);\n\}/);
  assert.doesNotMatch(css, /\.steps-plain \{[^}]*(border|background)/);
});

test("web static: 許可を待っている間は実行中の行に「許可を待っています: …」の 1 行（U1b）。変わったら描き直す", () => {
  const chat = read("chat.js");
  const api = read("api.js");
  assert.match(chat, /const waiting = store\.runningWaitingText\(run\);\n {4}if \(waiting\) body\.push\(el\("div", \{ class: "run-waiting", text: waiting \}\)\);/);
  assert.match(api, /"許可を待っています: " \+ \(typeof w\.displayName === "string" && w\.displayName !== "" \? w\.displayName : w\.toolName\)/);
  assert.match(api, /waitingText\(prev\) !== waitingText\(turn\)/);
  const css = read("app.css");
  assert.match(css, /\n\.run-waiting \{[^}]*color: var\(--text\);/);
});

test("web static: 新しいセッションのダイアログのプロジェクト（U1b）は /api/projects/workspace から「（なし）」を先頭に、選んだら projectDir。サイドバーの行にプロジェクトの印", () => {
  const html = read("index.html");
  assert.match(html, /<div class="field" id="new-project-field" hidden>/);
  const workbench = read("workbench.js");
  assert.match(workbench, /SA\.api\.get\("\/api\/projects\/workspace", \{ quiet: true \}\)/);
  assert.match(workbench, /el\("option", \{ value: "", text: "（なし）" \}\)/);
  assert.match(workbench, /body\.projectDir = \$\("new-project"\)\.value;/);
  assert.match(workbench, /err\.code === "not_set_up" && err\.status === 503/);
  // 共有の link が済んでいなければセレクトを無効にし、説明に unify-setup の行の案内（textContent）
  assert.match(workbench, /if \(status\.cc\.unifyReady === false\) \{\n {6}\$\("new-project"\)\.disabled = true;/);
  assert.match(workbench, /\$\("new-project-hint"\)\.textContent = NEW_PROJECT_NOT_READY_HINT;/);
  assert.match(workbench, /const NEW_PROJECT_NOT_READY_HINT = "設定が済んでいません。端末で npm run unify-setup -- --print の行を実行してから再起動してください";/);
  // index.html の説明と同じ文
  assert.ok(html.includes('<p class="meta" id="new-project-hint">選ぶと Claude Code と同じ装備（CLAUDE.md・skills・Bash）で動き、許可はボタンで答えます。人格は既定だけです</p>'));
  const sidebar = read("sidebar.js");
  assert.match(sidebar, /class: "badge badge-project", title: "プロジェクトのセッション", text: ch\.projectDir\.dir/);
});

// ===== 色・寸法・動き・重なりの変数（tokens.css） =====
test("web static: tokens.css は変数だけで、app.css に :root の色のブロックが残っていない", () => {
  const tokens = read("tokens.css");
  for (const open of [':root[data-theme="dark"] {', ':root[data-theme="light"] {', "\n:root:not([data-theme]) {", "@media (prefers-color-scheme: dark) {"]) {
    assert.ok(tokens.includes(open), open);
  }
  // 一番外の規則のセレクタは :root・:root[data-theme=…]・:root:not([data-theme])・@media … だけ
  const outer = [...tokens.replace(/\/\*[\s\S]*?\*\//g, "").matchAll(/^([^\s}][^{}]*)\{/gm)].map((m) => m[1]!.trim());
  assert.ok(outer.length >= 6);
  for (const sel of outer) assert.match(sel, /^(:root|:root\[data-theme="(dark|light)"\]|:root:not\(\[data-theme\]\)|@media .+)$/, sel);
  // @media の中も :root の規則だけ
  for (const m of tokens.matchAll(/^ {2}([^\s}][^{}]*)\{/gm)) assert.match(m[1]!.trim(), /^:root/, m[1]);
  const app = read("app.css");
  assert.doesNotMatch(app, /:root\[data-theme="dark"\] \{/);
  assert.doesNotMatch(app, /^:root \{/m);
  assert.match(app, /^ \*\/\n\n::selection \{/m);
});

// ===== 新しい殻（v3.html・shell.js・topics.js・shell.css・tokens.css。docs/plan/web-ui-v3.md の M2a） =====
/** IIFE の直下（2 字下げ）の function の本体を切り出す */
function fnSource(js: string, name: string): string {
  const start = js.indexOf(`\n  function ${name}(`);
  assert.ok(start >= 0, name);
  const end = js.indexOf("\n  }\n", start);
  assert.ok(end > start, name);
  return js.slice(start, end + 4);
}

/** `SA.app = { … }` の鍵（4 字下げの行の頭の名前） */
function appKeys(js: string): string[] {
  const start = js.indexOf("\n  SA.app = {\n");
  assert.ok(start >= 0);
  const end = js.indexOf("\n  };\n", start);
  return [...js.slice(start, end).matchAll(/^ {4}([A-Za-z]+)\b/gm)].map((m) => m[1]!).sort();
}

test("web static: v3.html の読み込みの順（base → tokens → app → shell、ui → api → sound → chat → views → topics → shell）と、sidebar.js・workbench.js を読まないこと", () => {
  const html = read("v3.html");
  assert.match(html, /<html lang="ja" data-theme="dark">/);
  const links = [...html.matchAll(/<link rel="stylesheet" href="([^"]+)">/g)].map((m) => m[1]);
  assert.deepEqual(links, ["/static/base.css", "/static/tokens.css", "/static/app.css", "/static/shell.css"]);
  const scripts = [...html.matchAll(/<script src="([^"]+)" defer><\/script>/g)].map((m) => m[1]);
  assert.deepEqual(scripts, ["/static/ui.js", "/static/api.js", "/static/sound.js", "/static/chat.js", "/static/views.js", "/static/topics.js", "/static/shell.js"]);
  assert.doesNotMatch(html, /sidebar\.js|workbench\.js/);
  // head の meta・title・manifest・icon は index.html と同じ
  const headOf = (h: string) => h.slice(0, h.indexOf('<link rel="stylesheet"'));
  assert.equal(headOf(html), headOf(read("index.html")));
});

test("web static: v3.html に inline の script・style・style 属性が無く、ui.js が引く id（dlg-confirm と中の 5 つ・toast・toast-alert・ed）がある", () => {
  const html = read("v3.html");
  assert.doesNotMatch(html, /<style\b/i);
  assert.doesNotMatch(html, /\sstyle=/i);
  assert.doesNotMatch(html, /\son[a-z]+=/i);
  for (const m of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)) assert.equal((m[2] ?? "").trim(), "");
  for (const id of ["dlg-confirm", "dlg-confirm-title", "dlg-confirm-target", "dlg-confirm-body", "dlg-confirm-cancel", "dlg-confirm-ok", "toast", "toast-alert", "ed"]) {
    assert.match(html, new RegExp(`\\sid="${id}"`), id);
  }
  assert.match(html, /<body>\s*<a class="skip-link" href="#ed">本文へ<\/a>/);
  assert.match(html, /<div class="toast-stack" id="toast-alert" role="alert"[^>]*hidden><\/div>/);
});

test("web static: v3.html に [+]・「場所」のボタン・右腕の口が無い", () => {
  const html = read("v3.html");
  for (const word of ["v3-add", "v3-right", "dlg-new", "dlg-cc-start", "palette"]) assert.equal(html.includes(word), false, word);
  const shell = read("shell.js");
  for (const word of ["v3-add", "v3-right"]) assert.equal(shell.includes(word), false, word);
  const bar = fnSource(shell, "renderBar");
  assert.doesNotMatch(bar, /"button"/);
  assert.match(bar, /place\.textContent = text/);
});

test("web static: 新しい殻の SA.app は今の殻と同じ名前を全部持つ", () => {
  const now = appKeys(read("workbench.js"));
  assert.ok(now.length >= 20);
  assert.deepEqual(appKeys(read("shell.js")), now);
});

test("web static: 一覧の差し替えは同じ key の要素を使い回し、順が同じなら insertBefore・remove を呼ばない", () => {
  const ctx: Record<string, unknown> = {};
  vm.runInNewContext(fnSource(read("topics.js"), "reconcile"), ctx);
  const reconcile = ctx.reconcile as (parent: FakeNode, items: string[], keyOf: (x: string) => string, create: (x: string) => FakeNode, update: (n: FakeNode, x: string) => void) => void;
  const parent = new FakeNode("ul");
  let created = 0;
  const run = (items: string[]) =>
    reconcile(
      parent,
      items,
      (x) => x,
      () => {
        created++;
        return new FakeNode("li");
      },
      (node, x) => {
        node.text = x;
      },
    );
  const reset = () => {
    FakeNode.calls.remove = 0;
    FakeNode.calls.insertBefore = 0;
    created = 0;
  };
  const texts = () => parent.children.map((c) => c.text);
  run(["a", "b", "c"]);
  const [a, b, c] = parent.children;
  assert.deepEqual(texts(), ["a", "b", "c"]);
  // 同じ並びをもう一度: 挿入 0・削除 0・要素は同じ
  reset();
  run(["a", "b", "c"]);
  assert.deepEqual([FakeNode.calls.insertBefore, FakeNode.calls.remove, created], [0, 0, 0]);
  assert.deepEqual(parent.children, [a, b, c]);
  // 1 つ増える: 挿入 1
  reset();
  run(["a", "b", "x", "c"]);
  assert.deepEqual([FakeNode.calls.insertBefore, FakeNode.calls.remove, created], [1, 0, 1]);
  assert.deepEqual(texts(), ["a", "b", "x", "c"]);
  assert.equal(parent.children[0], a);
  assert.equal(parent.children[3], c);
  // 1 つ消える: 削除 1（ほかは動かさない）
  reset();
  run(["a", "x", "c"]);
  assert.deepEqual([FakeNode.calls.insertBefore, FakeNode.calls.remove, created], [0, 1, 0]);
  assert.equal(b!.parent, null);
  assert.deepEqual(texts(), ["a", "x", "c"]);
  // 順が入れ替わる: 要素は同じまま
  const x = parent.children[1];
  reset();
  run(["c", "x", "a"]);
  assert.deepEqual(parent.children, [c, x, a]);
  // [a, x, c] → c を先頭へ（1）、x を a の前へ（2）。a は動かさない
  assert.deepEqual([FakeNode.calls.insertBefore, FakeNode.calls.remove, created], [2, 0, 0]);
});

test("web static: topics.js は一覧の入れ物を作り直さない", () => {
  const js = read("topics.js");
  const receivers = [...js.matchAll(/(\w+)\.replaceChildren\(/g)].map((m) => m[1]);
  assert.deepEqual([...new Set(receivers)].sort(), ["button", "head"]);
  assert.match(fnSource(js, "fillRow"), /button\.replaceChildren\(/);
  assert.match(fnSource(js, "updateGroup"), /head\.replaceChildren\(/);
  for (const name of ["body", "groups", "list"]) {
    assert.doesNotMatch(js, new RegExp(`\\b${name}\\.(replaceChildren\\(|innerHTML|textContent = "")`), name);
  }
  // 群・行・「あなたの番」の行は同じ reconcile で
  assert.match(js, /reconcile\(groups, data\.groups,/);
  assert.match(js, /reconcile\(list, members\.map\(rowParts\),/);
  assert.match(js, /const turnKey = \(p\) => "turn:" \+ p\.id;/);
  assert.match(js, /reconcile\(\$\("v3-turns-rows"\), parts, turnKey,/);
});

test("web static: 行の印は あなたの番 > 作業中 > 未読 で 1 つだけ、作業中の輪は回さない", () => {
  const ctx: Record<string, unknown> = {
    store: { isUnread: (ch: { id: string; last: unknown }) => ch.id === "1" && ch.last !== null },
    SA: {
      ui: {
        shortTime: (v: unknown) => {
          assert.equal(typeof v, "string", "activityAt が null なら shortTime を呼ばない");
          return "12:00";
        },
      },
      app: { activeTabId: () => "ch:2" },
    },
  };
  vm.runInNewContext(fnSource(read("topics.js"), "rowParts"), ctx);
  const rowParts = ctx.rowParts as (t: unknown) => { mark: string; kind: string | null; current: boolean; done: boolean; turnKind: string | null; time: string | null };
  const topic = (o: Record<string, unknown>) => ({ id: "ch:1", title: "t", origin: "session", persona: null, activityAt: "2026-11-14T00:00:00Z", state: "active", last: { id: 2, at: "", kind: "agent" }, mark: null, turn: null, ...o });
  assert.equal(rowParts(topic({ mark: "turn", turn: { kind: "permission" } })).mark, "turn");
  assert.equal(rowParts(topic({ mark: "turn", turn: { kind: "permission" } })).turnKind, "permission");
  assert.equal(rowParts(topic({ mark: "running" })).mark, "running");
  assert.equal(rowParts(topic({})).mark, "unread");
  assert.equal(rowParts(topic({ id: "ch:2" })).mark, "none");
  assert.equal(rowParts(topic({ id: "ch:2" })).current, true);
  // チャンネルの無い Claude Code の話題に未読の点は出さない・「端末」を添える
  const cc = rowParts(topic({ id: "cc:1", origin: "cc" }));
  assert.equal(cc.mark, "none");
  assert.equal(cc.kind, "端末");
  assert.equal(rowParts(topic({ state: "done" })).done, true);
  // 履歴の無い行（activityAt が null）は時刻を出さない
  assert.equal(rowParts(topic({})).time, "12:00");
  assert.equal(rowParts(topic({ activityAt: null })).time, null);
  assert.match(fnSource(read("topics.js"), "fillRow"), /if \(p\.time !== null\) meta\.push\(el\("span", \{ class: "v3-row-time", text: p\.time \}\)\);/);
  const css = read("shell.css");
  const ring = css.slice(css.indexOf("\n.v3-ring {"), css.indexOf("}", css.indexOf("\n.v3-ring {")));
  assert.match(ring, /border: 2px solid var\(--accent\);/);
  assert.doesNotMatch(ring, /animation/);
  assert.doesNotMatch(css, /@keyframes|animation|transition/);
  // 作業中の印は spinner でなく輪
  assert.doesNotMatch(read("topics.js"), /spinner/);
});

test("web static: 行の署名が同じなら中身を書き換えない", () => {
  let fills = 0;
  const ctx: Record<string, unknown> = { fillRow: () => fills++ };
  vm.runInNewContext(fnSource(read("topics.js"), "updateRow"), ctx);
  const updateRow = ctx.updateRow as (li: FakeNode, p: Record<string, unknown>) => void;
  const li = new FakeNode("li");
  const button = new FakeNode("button");
  li.append(button);
  const p = { id: "ch:1", title: "t", mark: "none", current: true };
  updateRow(li, p);
  updateRow(li, { ...p });
  assert.equal(fills, 1);
  assert.equal(button.getAttribute("aria-current"), "true");
  assert.equal(button.getAttribute("data-topic"), "ch:1");
  updateRow(li, { ...p, current: false });
  assert.equal(fills, 2);
  assert.equal(button.getAttribute("aria-current"), null);
});

test("web static: 新しい殻の幅の段は 639 だけ", () => {
  const css = read("shell.css");
  const medias = [...css.matchAll(/@media ([^{]+)\{/g)].map((m) => m[1]!.trim());
  assert.ok(medias.includes("(max-width: 639px)"));
  // 幅の段のほかは、指・hover・動きを減らすの条件だけ
  for (const m of medias) assert.ok(["(max-width: 639px)", "(pointer: coarse)", "(prefers-reduced-motion: reduce)", "(hover: hover) and (pointer: fine)"].includes(m), m);
  assert.doesNotMatch(css, /767|1023|1024|768/);
  assert.match(read("shell.js"), /window\.matchMedia\("\(max-width: 639px\)"\)/);
  // セレクタは .v3 で始まるものだけ（:root の変数 1 つを除く）
  const selectors = [...css.replace(/\/\*[\s\S]*?\*\//g, "").matchAll(/^\s*([^@\s{}][^{}]*)\{/gm)].map((m) => m[1]!.trim());
  for (const sel of selectors) {
    if (sel === ":root") continue;
    for (const part of sel.split(",")) assert.match(part.trim(), /^\.v3/, sel);
  }
  assert.equal(css.match(/^\s*--[a-z0-9-]+:/gm)?.length, 1);
});

test("web static: shell.css に色の値が無い", () => {
  const css = read("shell.css");
  assert.doesNotMatch(css, /#[0-9a-fA-F]{3,8}\b/);
  assert.doesNotMatch(css, /rgba?\(|hsla?\(/);
});

test("web static: 話題の polling は あなたの番か作業中があれば 10 秒、無ければ 60 秒、隠れている間は予約しない", () => {
  const js = read("topics.js");
  assert.match(js, /const BUSY_MS = 10000;/);
  assert.match(js, /const IDLE_MS = 60000;/);
  const arm = fnSource(js, "arm");
  assert.match(arm, /clearTimeout\(timer\);/);
  assert.match(arm, /if \(document\.visibilityState === "visible" && !SA\.poll\.stopped\(\)\) \{\n\s*timer = setTimeout\(load, counts\(\)\.turns > 0 \|\| counts\(\)\.running > 0 \? BUSY_MS : IDLE_MS\);/);
  assert.match(fnSource(js, "load"), /arm\(\);/);
  // 見えたら読み直し、隠れたら予約を消す
  assert.match(js, /document\.addEventListener\("visibilitychange", \(\) => \{\n\s*if \(document\.visibilityState === "visible"\) schedule\(\);\n\s*else \{\n\s*clearTimeout\(timer\);/);
  // api.js の polls には足さない
  assert.doesNotMatch(read("api.js"), /\/api\/topics/);
  // schedule は 2 秒に 1 回まで
  assert.match(js, /const MIN_GAP_MS = 2000;/);
  assert.match(fnSource(js, "schedule"), /if \(pending !== null\) return;/);
});

// ===== 新しい殻を偽の DOM で動かす（shell.js・topics.js。M2a のレビュー） =====
/** FakeNode にスクロール・焦点・querySelector を足したもの。hides が true を返す祖先の下では display: none（スクロールの読み書きが効かない） */
class DomNode extends FakeNode {
  static hides: (n: DomNode) => boolean = () => false;
  static focused: DomNode | null = null;
  scrollHeight = 0;
  clientHeight = 0;
  private top = 0;
  get rendered(): boolean {
    for (let n: FakeNode | null = this; n; n = n.parent) if (n instanceof DomNode && DomNode.hides(n)) return false;
    return true;
  }
  get scrollTop(): number {
    return this.rendered ? this.top : 0;
  }
  set scrollTop(v: number) {
    if (this.rendered) this.top = Math.max(0, Math.min(v, Math.max(0, this.scrollHeight - this.clientHeight)));
  }
  get dataset(): Record<string, string> {
    const out: Record<string, string> = {};
    for (const [k, v] of this.attrs) if (k.startsWith("data-")) out[k.slice(5).replace(/-([a-z])/g, (_m, c: string) => c.toUpperCase())] = v;
    return out;
  }
  override get classList() {
    return {
      add: (c: string) => this.classes.add(c),
      contains: (c: string) => this.classes.has(c),
      remove: (c: string) => this.classes.delete(c),
      toggle: (c: string, on?: boolean) => ((on ?? !this.classes.has(c)) ? this.classes.add(c) : this.classes.delete(c)),
    };
  }
  focus(): void {
    DomNode.focused = this;
  }
  /** 焦点のある要素を外すと（動かすための外しも）焦点が外れる */
  override remove(): void {
    if (DomNode.focused && this.contains(DomNode.focused)) DomNode.focused = null;
    super.remove();
  }
  querySelectorAll(selector: string): DomNode[] {
    const m = /^([a-z0-9]+)?((?:\.[\w-]+)*)(?:\[([\w-]+)="([^"]*)"\])?$/.exec(selector);
    assert.ok(m, selector);
    const classes = (m[2] ?? "").split(".").filter(Boolean);
    return descendants(this).filter(
      (n): n is DomNode =>
        n instanceof DomNode && (!m[1] || n.tagName === m[1]) && classes.every((c) => n.classes.has(c)) && (!m[3] || n.getAttribute(m[3]) === m[4]),
    );
  }
  querySelector(selector: string): DomNode | null {
    return this.querySelectorAll(selector)[0] ?? null;
  }
  closest(): null {
    return null;
  }
  replaceWith(other: DomNode): void {
    const parent = this.parent!;
    parent.insertBefore(other, this);
    this.remove();
  }
}

type ShellApp = {
  open: (tab: string) => void;
  refresh: (tab: string) => void;
  activeTabId: () => string | null;
  closeDrawer: () => void;
  refreshStatus: () => void;
};
type Topics = { load: () => Promise<void>; schedule: () => void; render: () => void };

const v3Topic = (id: string, o: Record<string, unknown> = {}) => ({ id, title: id, origin: "session", persona: null, activityAt: null, state: "active", last: null, mark: null, turn: null, group: "g", place: null, ...o });
const v3Result = (topics: unknown[], o: Record<string, unknown> = {}) => ({ groups: [{ key: "g", name: "General", turns: 0, running: 0 }], topics, turns: 0, turnIds: [], rightHands: [], ...o });

/**
 * v3.html の骨組みを DomNode で組み、ui.js・topics.js・shell.js を読み込む。views.info は known のタブだけを返し、
 * ch: のタブは data-stick="bottom" の .ed-scroll（高さは heights。既定 1,000・見える高さ 200）と見出しの [‹] を描く
 */
function loadShell(opts: { phone?: boolean; hash?: string; known?: (tab: string) => boolean; status?: unknown } = {}) {
  const state = { phone: opts.phone ?? false, now: 1_000_000 };
  let seq = 0;
  const timers = new Map<number, { at: number; ms: number; fn: () => void }>();
  const node = (tag: string, id?: string, cls?: string) => {
    const n = new DomNode(tag);
    if (id) n.setAttribute("id", id);
    if (cls) n.setAttribute("class", cls);
    return n;
  };
  const v3 = node("div", "v3", "v3");
  v3.setAttribute("data-view", "list");
  const listBody = node("div", "v3-list-body", "v3-list-body");
  listBody.scrollHeight = 2000;
  listBody.clientHeight = 400;
  const note = node("p", "v3-list-note");
  const turns = node("section", "v3-turns");
  turns.hidden = true;
  const turnsHead = node("h2");
  turnsHead.append(node("span", "v3-turns-count"));
  const turnsRows = node("ul", "v3-turns-rows", "v3-rows");
  turns.append(turnsHead, turnsRows);
  const groups = node("div", "v3-groups");
  listBody.append(note, turns, groups);
  const list = node("nav", "v3-list", "v3-list");
  list.append(listBody);
  const main = node("main", "v3-main", "v3-main");
  const bar = node("div", "v3-bar");
  bar.append(node("span", "v3-place"));
  const ed = node("div", "ed", "ed");
  main.append(bar, ed);
  v3.append(list, main);
  const body = node("body");
  body.append(v3, node("dialog", "v3-sheet"));
  const ids = new Map<string, DomNode>();
  for (const n of descendants(body)) if (n instanceof DomNode && n.getAttribute("id")) ids.set(n.getAttribute("id")!, n);
  // ≤639px の一覧の間は .v3-main が display: none（shell.css）。hidden の要素も出ない
  DomNode.hides = (n) => n.hidden || (n === main && state.phone && v3.getAttribute("data-view") === "list");
  DomNode.focused = null;

  const docListeners = new Map<string, Array<(e: unknown) => void>>();
  const winListeners = new Map<string, Array<(e: unknown) => void>>();
  const on = (map: typeof docListeners) => (type: string, fn: (e: unknown) => void) => map.set(type, [...(map.get(type) ?? []), fn]);
  const fire = (type: string, e: unknown = {}) => {
    for (const fn of winListeners.get(type) ?? []) fn(e);
  };
  const document = {
    readyState: "complete",
    visibilityState: "visible",
    title: "",
    documentElement: { dataset: {} as Record<string, string>, style: { setProperty() {}, removeProperty() {} } },
    get activeElement() {
      return DomNode.focused && body.contains(DomNode.focused) ? DomNode.focused : body;
    },
    contains: (n: unknown) => body.contains(n),
    getElementById: (id: string) => ids.get(id) ?? null,
    createElement: (tag: string) => new DomNode(tag),
    createElementNS: (_ns: string, tag: string) => new DomNode(tag),
    createTextNode: (text: string) => Object.assign(new DomNode("#text"), { text }),
    querySelector: () => null,
    querySelectorAll: () => [],
    addEventListener: on(docListeners),
  };
  const location = { hash: opts.hash ?? "", pathname: "/static/v3.html", search: "" };
  const hashOfUrl = (url: string) => (url.includes("#") ? url.slice(url.indexOf("#")) : "");
  const entries: Array<{ state: unknown; hash: string }> = [{ state: null, hash: location.hash }];
  let index = 0;
  const calls = { push: 0 };
  const history = {
    get state() {
      return entries[index]!.state;
    },
    pushState(st: unknown, _t: string, url: string) {
      calls.push++;
      entries.splice(index + 1);
      location.hash = hashOfUrl(url);
      entries.push({ state: st, hash: location.hash });
      index++;
    },
    replaceState(st: unknown, _t: string, url: string) {
      location.hash = hashOfUrl(url);
      entries[index] = { state: st, hash: location.hash };
    },
    back() {
      if (index === 0) return;
      index--;
      location.hash = entries[index]!.hash;
      fire("popstate", { state: entries[index]!.state });
    },
    forward() {
      if (index === entries.length - 1) return;
      index++;
      location.hash = entries[index]!.hash;
      fire("popstate", { state: entries[index]!.state });
    },
  };
  const mq = {
    get matches() {
      return state.phone;
    },
    addEventListener() {},
  };
  const window = { matchMedia: () => mq, addEventListener: on(winListeners), innerHeight: 800, scrollY: 0 } as Record<string, unknown>;
  class FakeDate extends Date {
    static override now(): number {
      return state.now;
    }
  }
  const context = {
    window,
    document,
    history,
    location,
    CSS: { escape: (v: string) => v },
    setTimeout: (fn: () => void, ms: number) => {
      timers.set(++seq, { at: state.now + ms, ms, fn });
      return seq;
    },
    clearTimeout: (id: number) => timers.delete(id),
    setInterval: () => 0,
    Intl,
    Date: FakeDate,
    Number,
  };
  vm.runInNewContext(read("ui.js"), context);
  const SA = (window as { SA: Record<string, unknown> }).SA;
  const ui = SA.ui as { el: (tag: string, props?: Record<string, unknown>, children?: unknown[]) => DomNode; backButton: () => DomNode };
  const heights: Record<string, number> = {};
  const rendered: Array<{ tab: string; view: string | null }> = [];
  const closes: string[] = [];
  const known = opts.known ?? ((tab: string) => tab.startsWith("ch:") || tab.startsWith("cc:") || tab === "tasks");
  SA.views = {
    info: (tab: string) =>
      known(tab)
        ? {
            render: (container: DomNode) => {
              rendered.push({ tab, view: v3.getAttribute("data-view") });
              const scroll = ui.el("div", { class: "ed-scroll", "data-stick": tab.startsWith("ch:") ? "bottom" : undefined });
              scroll.scrollHeight = heights[tab] ?? 1000;
              scroll.clientHeight = 200;
              container.replaceChildren(ui.el("header", { class: "ed-toolbar" }, [ui.backButton()]), scroll);
            },
            onClose: () => closes.push(tab),
          }
        : null,
    ago: () => "1 分前",
  };
  SA.store = { status: opts.status === undefined ? {} : opts.status, isUnread: () => false, load: { channels() {}, usageDays() {}, usage() {} } };
  SA.chat = { channelById: () => ({}) };
  SA.poll = { start() {}, stopped: () => false };
  const api = { calls: 0, reply: (): Promise<unknown> => Promise.resolve(v3Result([])) };
  SA.api = {
    get: () => {
      api.calls++;
      return api.reply();
    },
  };
  vm.runInNewContext(read("topics.js"), context);
  vm.runInNewContext(read("shell.js"), context);
  const advance = (ms: number) => {
    state.now += ms;
    for (const [id, t] of [...timers].sort((a, b) => a[1].at - b[1].at)) {
      if (t.at <= state.now && timers.has(id)) {
        timers.delete(id);
        t.fn();
      }
    }
  };
  const flush = async () => {
    for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r));
  };
  const scroll = () => ed.querySelector(".ed-scroll")!;
  const row = (container: DomNode, id: string) => container.querySelector(`button.v3-row[data-topic="${id}"]`);
  return {
    app: SA.app as ShellApp,
    topics: SA.topics as Topics,
    nodes: { v3, ed, groups, turns, turnsRows, note, listBody },
    state,
    api,
    heights,
    rendered,
    closes,
    history,
    location,
    calls,
    timers,
    advance,
    flush,
    fire,
    scroll,
    row,
    store: SA.store as { status: unknown },
    document,
  };
}

test("web static: v3 の会話のスクロール: 別の話題に切り替えると下端、同じ話題の refresh は位置を保つ（下端に居れば下端）", async () => {
  const h = loadShell();
  await h.flush();
  h.app.open("ch:a");
  assert.equal(h.scroll().scrollTop, 800);
  // 同じ話題の描き直しは位置を保つ
  h.scroll().scrollTop = 100;
  h.app.refresh("ch:a");
  assert.equal(h.scroll().scrollTop, 100);
  // 下端に居れば伸びても下端
  h.scroll().scrollTop = 800;
  h.heights["ch:a"] = 1500;
  h.app.refresh("ch:a");
  assert.equal(h.scroll().scrollTop, 1300);
  // 前の話題の位置（100）を引き継がない
  h.scroll().scrollTop = 100;
  h.app.open("ch:b");
  assert.equal(h.scroll().scrollTop, 800);
  // 下端に寄せない画面は先頭から
  h.heights.tasks = 1000;
  h.app.open("tasks");
  assert.equal(h.scroll().scrollTop, 0);
  // 出ていないタブの refresh は何もしない
  const before = h.rendered.length;
  h.app.refresh("ch:a");
  assert.equal(h.rendered.length, before);
});

test("web static: v3 のスマホ: 会話の列が隠れている間の refresh は、表示したときに下端（下端に居なかったら元の位置）", async () => {
  const h = loadShell({ phone: true });
  await h.flush();
  h.app.open("ch:a");
  assert.equal(h.nodes.v3.getAttribute("data-view"), "body");
  assert.equal(h.scroll().scrollTop, 800);
  // 下端に居たまま一覧へ戻り、隠れている間に伸びる → [会話] で出したら下端（showBody）
  h.history.back();
  assert.equal(h.nodes.v3.getAttribute("data-view"), "list");
  h.heights["ch:a"] = 1500;
  h.app.refresh("ch:a");
  assert.equal(h.scroll().scrollTop, 0, "隠れている間は読めない");
  h.app.closeDrawer();
  assert.equal(h.nodes.v3.getAttribute("data-view"), "body");
  assert.equal(h.scroll().scrollTop, 1300);
  // 途中に居たまま一覧へ戻り、隠れている間に描き直す → 進むで戻ったら元の位置（popstate）
  h.scroll().scrollTop = 300;
  h.history.back();
  h.heights["ch:a"] = 1800;
  h.app.refresh("ch:a");
  h.history.forward();
  assert.equal(h.nodes.v3.getAttribute("data-view"), "body");
  assert.equal(h.scroll().scrollTop, 300);
});

test("web static: v3 のスマホの open は描く前に会話の列を出し、pushState は 1 回、焦点は [‹]。popstate で一覧 ⇄ 会話", async () => {
  const h = loadShell({ phone: true });
  await h.flush();
  h.app.open("ch:a");
  assert.deepEqual(h.rendered.at(-1), { tab: "ch:a", view: "body" });
  assert.equal(h.calls.push, 1);
  assert.equal(h.location.hash, "#/ch/a");
  assert.ok((h.document.activeElement as DomNode).classes.has("ed-back"));
  // 会話を出したまま別の話題: 積み増さない
  h.app.open("ch:b");
  assert.equal(h.calls.push, 1);
  assert.equal(h.location.hash, "#/ch/b");
  h.history.back();
  assert.equal(h.nodes.v3.getAttribute("data-view"), "list");
  h.history.forward();
  assert.equal(h.nodes.v3.getAttribute("data-view"), "body");
  // PC では [‹] に焦点を移さない
  const pc = loadShell();
  await pc.flush();
  pc.app.open("ch:a");
  assert.equal(pc.calls.push, 0);
  assert.equal(pc.document.activeElement.tagName, "body");
});

test("web static: v3 の open: ch: から切り替えても onClose を呼ばず、cc: からは呼ぶ。同じ話題・引けないタブでは何もしない", async () => {
  const h = loadShell();
  await h.flush();
  h.app.open("ch:a");
  h.app.open("cc:x");
  assert.deepEqual(h.closes, []);
  h.app.open("ch:b");
  assert.deepEqual(h.closes, ["cc:x"]);
  h.app.open("ch:b");
  assert.deepEqual(h.closes, ["cc:x"]);
  const before = h.rendered.length;
  h.app.open("nope");
  assert.equal(h.app.activeTabId(), "ch:b");
  assert.equal(h.rendered.length, before);
  assert.deepEqual(h.closes, ["cc:x"]);
});

test("web static: v3 の load・schedule: 読み込み中に頼まれた分は並行にせず後で 1 回、形の合わない応答・描けない応答は失敗の表示で次の予約が掛かる", async () => {
  const h = loadShell();
  let resolve: (v: unknown) => void = () => undefined;
  h.api.reply = () => new Promise((r) => (resolve = r));
  await h.topics.load();
  // 起動の 1 回で返った既定の一覧の後
  assert.equal(h.api.calls, 1);
  const pending = h.topics.load();
  void h.topics.load();
  h.topics.schedule();
  assert.equal(h.api.calls, 2);
  resolve(v3Result([v3Topic("ch:a")]));
  await pending;
  await h.flush();
  assert.equal(h.api.calls, 2, "すぐには読まない（2 秒に 1 回まで）");
  h.api.reply = () => Promise.resolve(v3Result([v3Topic("ch:a")]));
  h.advance(2000);
  await h.flush();
  assert.equal(h.api.calls, 3);
  h.advance(2000);
  await h.flush();
  assert.equal(h.api.calls, 3, "後の 1 回だけ");
  const polls = () => [...h.timers.values()].filter((t) => t.ms === 60000).length;
  assert.equal(polls(), 1);
  // turnIds が配列でない
  h.api.reply = () => Promise.resolve({ ...v3Result([]), turnIds: null });
  await h.topics.load();
  assert.equal(h.nodes.note.hidden, false);
  assert.equal(h.nodes.note.text, "更新できませんでした。前の一覧を出しています");
  assert.equal(polls(), 1);
  // 描けない（id の無い話題）: 投げても失敗の表示と次の予約
  h.api.reply = () => Promise.resolve(v3Result([{ group: "g", state: "active" }]));
  await h.topics.load();
  assert.equal(h.nodes.note.text, "更新できませんでした。前の一覧を出しています");
  assert.equal(polls(), 1);
  // 直ればもとに戻る
  h.api.reply = () => Promise.resolve(v3Result([v3Topic("ch:a")]));
  await h.topics.load();
  assert.equal(h.nodes.note.hidden, true);
});

test("web static: v3 の一覧: 焦点のある行が先頭へ動いても焦点と一覧の位置が残る", async () => {
  const h = loadShell();
  h.api.reply = () => Promise.resolve(v3Result([v3Topic("ch:a"), v3Topic("ch:b")]));
  await h.flush();
  await h.topics.load();
  const b = h.row(h.nodes.groups, "ch:b")!;
  b.focus();
  h.nodes.listBody.scrollTop = 150;
  h.api.reply = () => Promise.resolve(v3Result([v3Topic("ch:b"), v3Topic("ch:a")]));
  await h.topics.load();
  assert.equal(h.nodes.groups.querySelectorAll("button.v3-row")[0], b, "使い回して先頭へ");
  assert.equal(h.document.activeElement, b);
  assert.equal(h.nodes.listBody.scrollTop, 150);
});

test("web static: v3 の「あなたの番」が 0 に戻ると行が空になり、一覧へ戻った焦点は群の中の行に当たる", async () => {
  const h = loadShell({ phone: true });
  const turn = { kind: "permission", since: "2026-11-14T00:00:00Z", summary: null };
  h.api.reply = () => Promise.resolve(v3Result([v3Topic("ch:a", { mark: "turn", turn })], { turns: 1, turnIds: ["ch:a"] }));
  await h.flush();
  await h.topics.load();
  assert.equal(h.nodes.turns.hidden, false);
  assert.equal(h.nodes.turnsRows.children.length, 1);
  h.app.open("ch:a");
  // 番があっても群の中の行を先に
  h.history.back();
  assert.equal(h.document.activeElement, h.row(h.nodes.groups, "ch:a"));
  h.app.open("ch:a");
  h.api.reply = () => Promise.resolve(v3Result([v3Topic("ch:a")]));
  await h.topics.load();
  assert.equal(h.nodes.turns.hidden, true);
  assert.equal(h.nodes.turnsRows.children.length, 0);
  h.history.back();
  assert.equal(h.document.activeElement, h.row(h.nodes.groups, "ch:a"));
});

test("web static: v3 の群は「話題はありません」⇄ 行の一覧を入れ替える", async () => {
  const h = loadShell();
  await h.flush();
  const section = () => h.nodes.groups.children[0]!;
  assert.equal(section().children.length, 2);
  assert.ok(section().children[1]!.classes.has("v3-group-empty"));
  assert.equal(section().children[1]!.text, "話題はありません");
  h.api.reply = () => Promise.resolve(v3Result([v3Topic("ch:a")]));
  await h.topics.load();
  assert.equal(section().children.length, 2);
  assert.ok(section().children[1]!.classes.has("v3-rows"));
  assert.ok(h.row(h.nodes.groups, "ch:a"));
  h.api.reply = () => Promise.resolve(v3Result([v3Topic("ch:a", { state: "done" })]));
  await h.topics.load();
  assert.equal(section().children.length, 2);
  assert.ok(section().children[1]!.classes.has("v3-group-empty"));
});

test("web static: v3 の hash: tabFromHash と hashOf は往復し、hashchange で開き、起動の hash を待っている間は消さない", async () => {
  const ctx: Record<string, unknown> = {};
  const js = read("shell.js");
  vm.runInNewContext(fnSource(js, "hashOf") + fnSource(js, "tabFromHash"), ctx);
  const hashOf = ctx.hashOf as (tab: string) => string;
  const tabFromHash = ctx.tabFromHash as (hash: string) => string | null;
  for (const tab of ["ch:123", "cc:abc-def", "tasks"]) assert.equal(tabFromHash(hashOf(tab)), tab);
  assert.equal(hashOf("ch:1"), "#/ch/1");
  assert.equal(tabFromHash(""), null);
  assert.equal(tabFromHash("#/"), null);

  const h = loadShell();
  await h.flush();
  h.location.hash = "#/ch/b";
  h.fire("hashchange");
  assert.equal(h.app.activeTabId(), "ch:b");
  const before = h.rendered.length;
  h.fire("hashchange");
  assert.equal(h.rendered.length, before, "今の話題なら開き直さない");

  // 状態がまだ届いていない間は cc: を開けず、hash を残して待つ → 開けるようになったら開く
  let ready = false;
  const w = loadShell({ hash: "#/cc/x", status: null, known: (tab) => tab !== "cc:x" || ready });
  await w.flush();
  assert.equal(w.app.activeTabId(), null);
  assert.equal(w.location.hash, "#/cc/x");
  ready = true;
  w.store.status = {};
  w.app.refreshStatus();
  assert.equal(w.app.activeTabId(), "cc:x");
  assert.equal(w.location.hash, "#/cc/x");
  // 状態と最初の一覧の両方が届いても開けなければ、待つのをやめて hash を消す
  const g = loadShell({ hash: "#/cc/x", status: null, known: (tab) => tab !== "cc:x" });
  await g.flush();
  assert.equal(g.location.hash, "#/cc/x");
  g.store.status = {};
  g.app.refreshStatus();
  assert.equal(g.app.activeTabId(), null);
  assert.equal(g.location.hash, "");
});

test("web static: .v3 の文字は --font-sm で、スクロールバーは app.css の .wb と同じ細いもの", () => {
  const css = read("shell.css");
  const block = css.slice(css.indexOf("\n.v3 {"), css.indexOf("}", css.indexOf("\n.v3 {")));
  assert.match(block, /font-size: var\(--font-sm\);/);
  assert.match(block, /scrollbar-width: thin;/);
  assert.match(block, /scrollbar-color: var\(--border\) transparent;/);
});
