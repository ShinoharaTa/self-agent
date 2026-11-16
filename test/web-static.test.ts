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
    "manifest-v3.webmanifest",
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
  // 同梱の vendor-*.js だけは .innerHTML を見ない（Preact の dangerouslySetInnerHTML の分岐。部品は使わない（test/web-vendor.test.ts））
  for (const name of files.filter((n) => n.endsWith(".js"))) {
    const text = read(name);
    const forbidden = name.startsWith("vendor-")
      ? /setAttribute\(\s*"style"|\.outerHTML|insertAdjacentHTML|DOMParser|document\.write|\beval\(|new Function\(/
      : /setAttribute\(\s*"style"|\.innerHTML|\.outerHTML|insertAdjacentHTML|DOMParser|document\.write|\beval\(|new Function\(/;
    assert.doesNotMatch(text, forbidden, name);
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
    return {
      add: (c: string) => this.classes.add(c),
      contains: (c: string) => this.classes.has(c),
      toggle: (c: string, on?: boolean) => {
        const want = on ?? !this.classes.has(c);
        if (want) this.classes.add(c);
        else this.classes.delete(c);
        return want;
      },
    };
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
  removeEventListener(type: string, fn: (event: unknown) => void): void {
    this.listeners.set(type, (this.listeners.get(type) ?? []).filter((f) => f !== fn));
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
  get parentNode(): FakeNode | null {
    return this.parent;
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
  /** 「tag」「tag.class」「.class」だけを見る（tag は大文字・小文字を区別しない） */
  querySelectorAll(selector: string): FakeNode[] {
    const [tag, ...classes] = selector.split(".");
    return descendants(this).filter((n) => (!tag || n.tagName.toLowerCase() === tag.toLowerCase()) && classes.every((c) => n.classes.has(c)));
  }
  querySelector(selector: string): FakeNode | null {
    return this.querySelectorAll(selector)[0] ?? null;
  }
  /** focus() を呼んだ要素と引数（全部の偽の DOM で共通。確かめる前に空にする） */
  static focusLog: Array<{ node: FakeNode; opts: unknown }> = [];
  focus(opts?: unknown): void {
    FakeNode.focusLog.push({ node: this, opts });
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

function loadViews(opts: { v3?: boolean } = {}) {
  // v3 なら新しい殻の根（#v3）があるとして描く（views.js の isV3Shell）
  const v3Root = opts.v3 ? new FakeNode("div") : null;
  const document = {
    getElementById: (id: string) => (id === "v3" ? v3Root : null),
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
  return { SA, views, posts, bodies, toasts, setReply: (fn: (path: string) => Promise<unknown>) => (reply = fn) };
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
    activeElement: null as FakeNode | null,
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
  return { sidebar, container, groups, titleOf, countOf, ccGroup, calls, store: SA.store as Record<string, unknown>, document: document as { activeElement: FakeNode | null } };
}

/** api.js の store.sessionAsking と store.sessionAskingCount */
function sessionAskingSource(): string {
  const js = read("api.js");
  const asking = /store\.sessionAsking = \(ch\) => \{[\s\S]*?\n {2}\};/.exec(js)?.[0];
  const count = /store\.sessionAskingCount = [^\n]*;/.exec(js)?.[0];
  assert.ok(asking, "api.js から store.sessionAsking = (ch) => { … }; を抜き出せない（書き方が変わった）");
  assert.ok(count, "api.js から store.sessionAskingCount = …; の 1 行を抜き出せない（書き方が変わった）");
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
});

test("web static: 会話・Claude Code の行に焦点があれば、一覧を描き直した後に同じ data-tab の新しい行へ焦点を戻す（スクロールさせない）", () => {
  const { sidebar, container, document } = loadSidebar({ ccEnabled: false, cc: null, sessions: [{ id: "p1", title: "調べもの 2" }] });
  const rowOf = (tab: string) => container.querySelectorAll("button.sb-row").find((n) => n.getAttribute("data-tab") === tab);
  const before = rowOf("ch:p1")!;
  assert.ok(before);
  // 本物の DOM の tagName は大文字
  before.tagName = "BUTTON";
  document.activeElement = before;
  FakeNode.focusLog = [];
  sidebar.render(container, "chat");
  const after = rowOf("ch:p1")!;
  assert.notEqual(after, before, "行は作り直している");
  assert.equal(FakeNode.focusLog.length, 1);
  assert.equal(FakeNode.focusLog[0]!.node, after);
  // opts は vm の中で作ったもの（別の realm）なので値だけを見る
  assert.equal((FakeNode.focusLog[0]!.opts as { preventScroll?: boolean }).preventScroll, true);
  // 行のボタンでなければ（見出しの操作など）戻さない
  const other = new FakeNode("BUTTON");
  container.append(other);
  document.activeElement = other;
  FakeNode.focusLog = [];
  sidebar.render(container, "chat");
  assert.deepEqual(FakeNode.focusLog, []);
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
  // 数の位置の規則（.act-btn.is-running .act-spin）より後ろにも置く。勝つのは has-count の分だけ詳細度が高いからで、順には頼らない
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
  assert.match(chat, /store\.ccPendingOf\(info\.sessionId, session \? session\.pending : info\.pending\)/);
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

// ===== Claude Code のチャンネルの会話のタブ（chat.js。CC14）を偽の DOM で描く =====
function loadChatM0() {
  const document = {
    activeElement: null as FakeNode | null,
    visibilityState: "visible",
    getElementById: () => null,
    createElement: (tag: string) => new FakeNode(tag),
    createElementNS: (_ns: string, tag: string) => new FakeNode(tag),
    createTextNode: (text: string) => Object.assign(new FakeNode("#text"), { text }),
    querySelectorAll: () => [],
  };
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
  const posts: string[] = [];
  const store = {
    turns: {} as Record<string, unknown>,
    channels: { guilds: [], personas: [{ id: "default", name: "既定の人格", isDefault: true }], channels: [] as Array<Record<string, unknown>> },
    ccSessions: {} as Record<string, unknown>,
    running: [],
    runningOf: () => null,
    markSeen: () => false,
    ccPendingOf: (_id: string, server: unknown) => server,
    load: { turns: () => undefined, ccSession: () => undefined, cc: () => undefined },
  };
  SA.store = store;
  SA.app = {
    shownChannelIds: () => ["k1"],
    readingChannelIds: () => ["k1"],
    activeTabId: () => "ch:k1",
    draft: () => "",
    setDraft: () => undefined,
    refresh: () => undefined,
    refreshSidebar: () => undefined,
    refreshStatus: () => undefined,
    refreshTabs: () => undefined,
  };
  SA.poll = { kickCc: () => undefined, running: () => undefined };
  SA.api = {
    post: (path: string) => {
      posts.push(path);
      return new Promise(() => undefined);
    },
  };
  vm.runInNewContext(read("views.js"), context);
  vm.runInNewContext(read("chat.js"), context);
  const chat = SA.chat as { info: (channelId: string) => { render: (container: FakeNode) => void } };
  const container = new FakeNode("div");
  /** チャンネル k1（kind cc・セッション s1）の今を pending と state にして描く */
  const draw = (state: string, pending: Record<string, unknown> | null) => {
    store.turns.k1 = {
      channel: { id: "k1", kind: "cc", name: "cc-web", title: "cc-web", persona: "default", cc: { sessionId: "s1", state }, link: null },
      turns: [{ id: 1, at: new Date().toISOString(), kind: "owner", source: "web", text: "やって", outcome: null }],
      hasMore: false,
      loaded: true,
      missing: false,
    };
    store.ccSessions.s1 = { session: { sessionId: "s1", state, pending, permission: null, inTmux: true, rcUrl: null }, missing: false };
    chat.info("k1").render(container);
  };
  const statusRow = () => descendants(container).find((n) => n.classes.has("cc-status")) ?? null;
  const pendingBar = () => descendants(container).find((n) => n.classes.has("cc-send-state")) ?? null;
  return { draw, statusRow, pendingBar, posts };
}

test("web static: Claude Code のチャンネルは届け待ち・届けた後は状態の行だけを出し、入力欄の上の帯を出さない（ほかの状態では帯）", () => {
  const { draw, statusRow, pendingBar } = loadChatM0();
  const p = (state: string, extra: Record<string, unknown> = {}) => ({ id: 3, state, lastPaneState: null, replyState: null, ...extra });
  draw("idle", p("queued"));
  assert.equal(statusRow()!.getAttribute("data-cc-status"), "queued");
  assert.equal(pendingBar(), null);
  draw("idle", p("delivered", { replyState: "waiting" }));
  assert.equal(statusRow()!.getAttribute("data-cc-status"), "delivered");
  assert.equal(pendingBar(), null);
  // 作業中の行（届けた後の作業中）は送信の状態ではないので、帯を出す
  draw("running", p("delivered", { replyState: "waiting" }));
  assert.equal(statusRow()!.getAttribute("data-cc-status"), "running");
  assert.ok(pendingBar());
  // 行が無い（返事を戻した後）なら帯
  draw("idle", p("delivered", { replyState: "sent" }));
  assert.equal(statusRow(), null);
  assert.ok(pendingBar());
});

test("web static: 状態の行は種類と pending の id が同じなら同じ要素を使い回し（押した直後の disabled も残る）、変われば作り直す", () => {
  const { draw, statusRow, posts } = loadChatM0();
  const p = (id: number, state: string, extra: Record<string, unknown> = {}) => ({ id, state, lastPaneState: null, replyState: null, ...extra });
  draw("idle", p(3, "queued"));
  const first = statusRow()!;
  const cancel = first.buttons().find((b) => b.textContent === "やめる")! as FakeNode & { disabled?: boolean };
  cancel.dispatch("click");
  assert.deepEqual(posts, ["/api/cc/sends/3/cancel"]);
  assert.equal(cancel.disabled, true);
  // 同じ種類・同じ id（文だけ変わる）: 同じ要素で、文は今のもの
  draw("running", p(3, "queued"));
  assert.equal(statusRow(), first);
  assert.equal(cancel.disabled, true, "押した直後の disabled が消えない");
  assert.match(first.textContent, /作業中です。終わったら届けます/);
  // 種類が変わる（届けた → 作業中）・id が変わると別の要素
  draw("running", p(3, "delivered", { replyState: "waiting" }));
  const running = statusRow()!;
  assert.notEqual(running, first);
  assert.equal(running.getAttribute("data-cc-status"), "running");
  draw("idle", p(4, "queued"));
  const next = statusRow()!;
  assert.notEqual(next, running);
  draw("idle", p(5, "queued"));
  assert.notEqual(statusRow(), next, "id が変われば作り直す");
  // 行が消えた後に同じ状態に戻っても、前の要素は使わない
  const before = statusRow();
  draw("idle", null);
  assert.equal(statusRow(), null);
  draw("idle", p(5, "queued"));
  assert.notEqual(statusRow(), before);
});

test("web static: 状態の行を使い回すときは前の会話の .tl を残し、その中で行を動かさない（焦点が外れない）", () => {
  const { draw, statusRow } = loadChatM0();
  const p = { id: 3, state: "queued", lastPaneState: null, replyState: null };
  draw("idle", p);
  const row = statusRow()!;
  const tl = row.parent!;
  let removed = 0;
  const remove = row.remove.bind(row);
  row.remove = () => {
    removed++;
    remove();
  };
  draw("idle", p);
  assert.equal(statusRow(), row);
  assert.equal(row.parent, tl, "同じ .tl のまま");
  assert.equal(removed, 0, "一度も外さない");
});

// ===== 会話の行の読み込み（api.js の store.load.turns）を偽の fetch で動かす =====
function loadApiM0() {
  const context = {
    window: { addEventListener: () => undefined, localStorage: { getItem: () => null, setItem: () => undefined } } as Record<string, unknown>,
    document: { visibilityState: "visible", addEventListener: () => undefined },
    setTimeout: () => 0,
    clearTimeout: () => undefined,
    Intl,
    Date,
    Number,
    JSON,
  };
  vm.runInNewContext(read("api.js"), context);
  const SA = (context.window as { SA: Record<string, unknown> }).SA;
  SA.app = { refresh: () => undefined, refreshSidebar: () => undefined, refreshTabs: () => undefined, addOutput: () => undefined, activeTabId: () => null };
  SA.chat = { channelsChanged: () => undefined, current: () => null, channelTitle: () => "会話", endText: () => "" };
  const gets: string[] = [];
  /** /turns の応答の行（after のとき）。ccSession は空の 1 件 */
  let next: Array<Record<string, unknown>> = [];
  const channels: Record<string, Record<string, unknown>> = {
    k1: { id: "k1", kind: "cc", cc: { sessionId: "s1", state: "running" } },
    c2: { id: "c2", kind: "session", state: "active" },
  };
  (SA.api as { get: unknown }).get = (path: string) => {
    gets.push(path);
    if (path.startsWith("/api/cc/sessions/")) return Promise.resolve({ sessionId: "s1", state: "idle" });
    const channelId = /\/api\/channels\/([^/]+)\/turns/.exec(path)![1]!;
    const turns = path.includes("after=") ? next : [{ id: 1, kind: "owner", text: "やって", outcome: null }];
    return Promise.resolve({ turns, channel: channels[channelId] });
  };
  const store = SA.store as { load: { turns: (channelId: string) => Promise<unknown> } };
  const ccReads = () => gets.filter((g) => g.startsWith("/api/cc/sessions/")).length;
  return { store, gets, ccReads, setNext: (rows: Array<Record<string, unknown>>) => (next = rows) };
}

test("web static: Claude Code のチャンネルで会話の行が増えたら、そのセッションの今を 1 回読み直す（増えなければ読まない・cc でなければ読まない）", async () => {
  const { store, gets, ccReads, setNext } = loadApiM0();
  // 開いたとき（最初の 50 件）は読み直さない（開くときに chat.js が読む）
  await store.load.turns("k1");
  assert.equal(ccReads(), 0);
  // 増えない
  setNext([]);
  await store.load.turns("k1");
  assert.equal(ccReads(), 0);
  // 増えた: 1 回
  setNext([{ id: 2, kind: "agent", text: "できました", outcome: null }]);
  await store.load.turns("k1");
  assert.equal(ccReads(), 1);
  assert.ok(gets.includes("/api/cc/sessions/s1"));
  // cc でないチャンネルは行が増えても読まない
  setNext([]);
  await store.load.turns("c2");
  setNext([{ id: 3, kind: "agent", text: "x", outcome: null }]);
  await store.load.turns("c2");
  assert.equal(ccReads(), 1);
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

test("web static: 試し用の manifest（v3.html だけが指す）は名前・id・start_url だけが違い、ほかは manifest.webmanifest と同じ", () => {
  const trial = JSON.parse(read("manifest-v3.webmanifest")) as Record<string, unknown>;
  assert.equal(trial.name, "self-agent v3");
  assert.equal(trial.short_name, "self-agent v3");
  assert.equal(trial.id, "/static/v3.html");
  assert.equal(trial.start_url, "/static/v3.html");
  const rest = (m: Record<string, unknown>) => Object.fromEntries(Object.entries(m).filter(([k]) => !["name", "short_name", "id", "start_url"].includes(k)));
  assert.deepEqual(rest(trial), rest(JSON.parse(read("manifest.webmanifest")) as Record<string, unknown>));
  assert.doesNotMatch(read("index.html"), /manifest-v3/);
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
  // 会話の見出し・Claude Code の見出し・枠の見出し（frameHeader。#357）
  assert.equal((chat.match(/SA\.app\.sheet\(/g) ?? []).length, 3);
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

test("web static: v3.html の読み込みの順（base → tokens → app → shell → c-atoms → c-list → c-shell、ui → api → sound → chat → views → topics → c-app（module）→ shell）と、sidebar.js・workbench.js を読まないこと", () => {
  const html = read("v3.html");
  assert.match(html, /<html lang="ja" data-theme="dark">/);
  const links = [...html.matchAll(/<link rel="stylesheet" href="([^"]+)">/g)].map((m) => m[1]);
  assert.deepEqual(links, ["/static/base.css", "/static/tokens.css", "/static/app.css", "/static/shell.css", "/static/c-atoms.css", "/static/c-list.css", "/static/c-shell.css"]);
  // module は元から後回し（defer を書かない）。文書の順で topics.js の後・shell.js の前に動く
  const scripts = [...html.matchAll(/<script (?:type="module" )?src="([^"]+)"( defer)?><\/script>/g)].map((m) => [m[1], m[0].includes('type="module"') ? "module" : m[2] ? "defer" : "none"]);
  assert.deepEqual(scripts, [
    ...["ui", "api", "sound", "chat", "views", "topics"].map((n) => [`/static/${n}.js`, "defer"]),
    ["/static/c-app.js", "module"],
    ["/static/shell.js", "defer"],
  ]);
  assert.equal([...html.matchAll(/<script\b/g)].length, scripts.length);
  assert.doesNotMatch(html, /sidebar\.js|workbench\.js/);
  // head は、試し用の manifest とホーム画面の名前の 2 行のほかは index.html と同じ
  const headOf = (h: string) => h.slice(0, h.indexOf('<link rel="stylesheet"'));
  const title = '<meta name="apple-mobile-web-app-title" content="self-agent v3">';
  const manifest = '<link rel="manifest" href="/static/manifest-v3.webmanifest">';
  assert.ok(headOf(html).includes(title), title);
  assert.ok(headOf(html).includes(manifest), manifest);
  const asIndex = headOf(html).replace(title, '<meta name="apple-mobile-web-app-title" content="self-agent">').replace(manifest, '<link rel="manifest" href="/static/manifest.webmanifest">');
  assert.equal(asIndex, headOf(read("index.html")));
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

test("web static: v3.html に今の画面の作る口が無い", () => {
  const html = read("v3.html");
  for (const word of ["dlg-new", "dlg-cc-start", "palette"]) assert.equal(html.includes(word), false, word);
});

test("web static: 新しい殻の SA.app は今の殻と同じ名前を全部持つ", () => {
  const now = appKeys(read("workbench.js"));
  assert.ok(now.length >= 20);
  assert.deepEqual(appKeys(read("shell.js")), now);
});

test("web static: 新しい殻の幅の段は 639 だけ", () => {
  const css = read("shell.css");
  const medias = [...css.matchAll(/@media ([^{]+)\{/g)].map((m) => m[1]!.trim());
  assert.ok(medias.includes("(max-width: 639px)"));
  // 幅の段のほかは、指・hover・動きを減らすの条件だけ
  for (const m of medias) assert.ok(["(max-width: 639px)", "(pointer: coarse)", "(prefers-reduced-motion: reduce)", "(hover: hover) and (pointer: fine)", "(display-mode: standalone)", "(prefers-color-scheme: light)"].includes(m), m);
  assert.doesNotMatch(css, /767|1023|1024|768/);
  assert.match(read("shell.js"), /window\.matchMedia\("\(max-width: 639px\)"\)/);
  // セレクタは .v3 で始まるものだけ（:root の変数 2 つ（一覧と右腕の幅）を除く）
  const selectors = [...css.replace(/\/\*[\s\S]*?\*\//g, "").matchAll(/^\s*([^@\s{}][^{}]*)\{/gm)].map((m) => m[1]!.trim());
  for (const sel of selectors) {
    if (sel === ":root") continue;
    for (const part of sel.split(",")) assert.match(part.trim(), /^\.v3/, sel);
  }
  assert.equal(css.match(/^\s*--[a-z0-9-]+:/gm)?.length, 2);
});

test("web static: 新しい殻の ≤639px のナレッジは一覧と中身を縦に並べ、見出しの検索も出す（app.css の古い殻の規則は残す。M8-0）", () => {
  const css = read("shell.css");
  const phoneCss = css.slice(css.indexOf("@media (max-width: 639px)"));
  const phoneEnd = phoneCss.indexOf("\n}");
  const rule = (sel: string) => {
    const at = phoneCss.indexOf("\n  " + sel + " {");
    assert.ok(at >= 0 && at < phoneEnd, sel + " は ≤639px の中");
    return phoneCss.slice(phoneCss.indexOf("{", at) + 1, phoneCss.indexOf("}", at)).trim();
  };
  assert.equal(rule(".v3 .master-detail-phone"), "grid-template-rows: minmax(0, 2fr) minmax(0, 3fr);");
  assert.equal(rule(".v3 .master-detail-phone > .master"), "display: block;");
  assert.equal(rule(".v3 .ed-toolbar-kb .ed-actions"), "display: flex;");
  // 値は app.css の元の値と同じ
  const app = read("app.css");
  assert.match(app, /\n {2}\.master-detail \{\n {4}grid-template-columns: minmax\(0, 1fr\);\n {4}grid-template-rows: minmax\(0, 2fr\) minmax\(0, 3fr\);\n/);
  assert.match(app, /\n\.ed-actions \{\n {2}display: flex;\n/);
  // 古い殻の規則（一覧と検索を隠す）は残っている
  assert.match(app, /\n {2}\.master-detail-phone > \.master,\n {2}\.ed-toolbar-kb \.ed-actions \{\n {4}display: none;\n {2}\}/);
  // DOM は変えない（同じ class のまま）
  const views = read("views.js");
  assert.match(views, /class: "master-detail master-detail-phone"/);
  assert.match(views, /"ed-toolbar-kb"\)/);
});

test("web static: 新しい殻は上の安全域を .v3 の 1 か所で持ち、重ねた右腕はその下から始める", () => {
  const css = read("shell.css").replace(/\/\*[\s\S]*?\*\//g, "");
  const phoneAt = css.indexOf("@media (max-width: 639px)");
  const phoneCss = css.slice(phoneAt);
  const phoneEnd = phoneCss.indexOf("\n}");
  const topRule = (sel: string) => {
    const at = css.indexOf("\n" + sel + " {");
    assert.ok(at >= 0 && at < phoneAt, sel + " は media の外");
    return css.slice(css.indexOf("{", at) + 1, css.indexOf("}", at));
  };
  const phoneRule = (sel: string) => {
    const at = phoneCss.indexOf("\n  " + sel + " {");
    assert.ok(at >= 0 && at < phoneEnd, sel + " は ≤639px の中");
    return phoneCss.slice(phoneCss.indexOf("{", at) + 1, phoneCss.indexOf("}", at));
  };
  const v3 = topRule(".v3");
  assert.ok(v3.includes("padding-top: env(safe-area-inset-top, 0px);"));
  assert.ok(v3.includes("height: var(--vvh, 100dvh);"));
  const hand = '.v3[data-hand-mode="over"][data-hand="open"] .v3-hand';
  const over = topRule(hand);
  assert.ok(over.includes("top: env(safe-area-inset-top, 0px);"));
  assert.ok(!over.includes("top: 0;"));
  assert.ok(phoneRule(hand).includes("top: calc(var(--space-8) + env(safe-area-inset-top, 0px));"));
  assert.equal(css.match(/safe-area-inset-top/g)?.length, 5);
});

test("web static: 新しい殻のライトのステータスバーの帯は古い殻と同じ決定（standalone のときだけ --primary）", () => {
  const css = read("shell.css").replace(/\/\*[\s\S]*?\*\//g, "");
  const band = "linear-gradient(var(--primary), var(--primary)) top / 100% env(safe-area-inset-top, 0px) no-repeat,";
  const at = css.indexOf("@media (display-mode: standalone)");
  assert.ok(at >= 0);
  const block = css.slice(at, css.indexOf("\n}", at) + 2);
  const flat = block.replace(/\s+/g, " ");
  assert.ok(flat.includes(`.v3:is(:root[data-theme="light"] *) { background: ${band} var(--bg); }`), flat);
  assert.ok(flat.includes(`@media (prefers-color-scheme: light) { .v3:is(:root:not([data-theme]) *) { background: ${band} var(--bg); } }`), flat);
  assert.ok(at < css.indexOf("@media (max-width: 639px)"));
  assert.ok(!block.includes("dark"));
  // 古い殻（app.css の .wb-titlebar）と同じ値
  assert.equal(read("app.css").split(band).length - 1, 2);
});

test("web static: 新しい殻のスマホの会話の列は下の安全域を持ち、キーボードの間は足さない", () => {
  const css = read("shell.css").replace(/\/\*[\s\S]*?\*\//g, "");
  const phoneCss = css.slice(css.indexOf("@media (max-width: 639px)"));
  const phoneEnd = phoneCss.indexOf("\n}");
  const rule = (sel: string) => {
    const at = phoneCss.indexOf("\n  " + sel + " {");
    assert.ok(at >= 0 && at < phoneEnd, sel + " は ≤639px の中");
    return phoneCss.slice(phoneCss.indexOf("{", at) + 1, phoneCss.indexOf("}", at)).trim();
  };
  assert.equal(rule(".v3-main"), "padding-bottom: env(safe-area-inset-bottom, 0px);");
  assert.equal(rule(".v3.is-keyboard .v3-main"), "padding-bottom: 0;");
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
  // api.js の polls には足さない（M7b から api.js に出る /api/topics は、既読の POST のパス（/read で終わる物）だけ）
  const api = read("api.js");
  const topicLines = api.split("\n").filter((line) => line.includes("/api/topics"));
  assert.ok(topicLines.length >= 1);
  for (const line of topicLines) assert.match(line, /SA\.api\.post\("\/api\/topics\/ch:" \+ channelId \+ "\/read", /, line);
  const pollsStart = api.indexOf("\n  const polls = {\n");
  assert.ok(pollsStart >= 0);
  const pollsBody = api.slice(pollsStart, api.indexOf("\n  };\n", pollsStart));
  assert.doesNotMatch(pollsBody, /^ {4}topics:/m);
  assert.doesNotMatch(pollsBody, /\/api\/topics|SA\.topics/);
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
      toggle: (c: string, on?: boolean) => {
        const want = on ?? !this.classes.has(c);
        if (want) this.classes.add(c);
        else this.classes.delete(c);
        return want;
      },
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
    const m = /^([a-z0-9]+)?((?:\.[\w-]+)*)(?:\[([\w-]+)="([^"]*)"\])?(?::not\(\[([\w-]+)\]\))?$/.exec(selector);
    assert.ok(m, selector);
    const classes = (m[2] ?? "").split(".").filter(Boolean);
    return descendants(this).filter(
      (n): n is DomNode =>
        n instanceof DomNode &&
        (!m[1] || n.tagName === m[1]) &&
        classes.every((c) => n.classes.has(c)) &&
        (!m[3] || n.getAttribute(m[3]) === m[4]) &&
        (!m[5] || n.getAttribute(m[5]) === null),
    );
  }
  querySelector(selector: string): DomNode | null {
    return this.querySelectorAll(selector)[0] ?? null;
  }
  closest(): null {
    return null;
  }
  get parentElement(): DomNode | null {
    return this.parent instanceof DomNode ? this.parent : null;
  }
  /** details の開閉（toggle は自分で dispatch する） */
  get open(): boolean {
    return this.attrs.has("open");
  }
  set open(v: boolean) {
    if (v) this.attrs.set("open", "");
    else this.attrs.delete("open");
  }
  replaceWith(other: DomNode): void {
    const parent = this.parent!;
    parent.insertBefore(other, this);
    this.remove();
  }
}

type ShellApp = {
  open: (tab: string) => void;
  palette: (prefix?: string) => void;
  refreshNotices: () => void;
  refreshTabs: () => void;
  refresh: (tab: string) => void;
  activeTabId: () => string | null;
  closeDrawer: () => void;
  refreshStatus: () => void;
  refreshSidebar: () => void;
};
type Topics = { load: () => Promise<void>; schedule: () => void; render: () => void; counts: () => { turns: number; running: number } };
type HandFrame = { title: string; placeholder: string; ops?: () => DomNode[]; outgoing?: (text: string) => string; replyText?: (text: string) => string; replyExtras?: (text: string) => DomNode[] };

// 一覧のモデル（c-list.js）。素の JS で型が無いので、URL を変数にして型の解決を避ける（test/web-components.test.ts と同じ）
type ListRow = { id: string; title: string; mark: string; state: { text: string; tone: string } | null; time: string | null; tag: string | null; done: boolean; current: boolean };
type ListGroup = {
  type: "group";
  key: string;
  kind: string;
  name: string;
  note: { text: string; tone: string } | null;
  canAdd: boolean;
  addLabel: string;
  rows: ListRow[];
  done: { label: string; open: boolean; loading: boolean; rows: ListRow[]; more: string } | null;
};
type ListOthers = { type: "others"; label: string; open: boolean; forced: boolean; groups: ListGroup[] };
type ListBlock = ListGroup | ListOthers | { type: "label"; text: string };
type ListTurn = { id: string; title: string; meta: string; sub: string; current: boolean };
type ListModel = { phase: string; note: string; turns: { count: number; nextId: string | null; items: ListTurn[] } | null; blocks: ListBlock[]; hitCount: number };
type ListOn = { open: (id: string, done: boolean) => unknown; add: (key: string, opener: unknown) => unknown; toggleDone: (key: string) => unknown; toggleOthers: () => unknown; retry: () => unknown };
type ListState = Record<string, unknown> & { on: ListOn; isUnread: (channelId: string, last: unknown) => boolean };
const listUrl = new URL("../src/web/static/c-list.js", import.meta.url).href;
const { listModel } = (await import(listUrl)) as { listModel: (state: unknown) => ListModel };
type BottomItem = { act: string; id?: string; label: string; name?: string; count?: number; mark?: string | null };
type BottomModel = { variant: string; items: BottomItem[] };
type BarOn = { list: () => unknown; hand: (opener: unknown) => unknown; tab: (id: string) => unknown; more: (opener: unknown) => unknown };
type BarState = { turns: number; hand: string | null; tabs: Array<{ id: string; title: string }>; on: BarOn };
const shellUrl = new URL("../src/web/static/c-shell.js", import.meta.url).href;
const { bottomModel } = (await import(shellUrl)) as { bottomModel: (o: { variant: string; turns: unknown; hand: unknown; tabs: unknown }) => BottomModel };
/** モデルの中の群（「ほかのプロジェクト」の中も） */
const modelGroups = (m: ListModel): ListGroup[] => m.blocks.flatMap((b) => (b.type === "group" ? [b] : b.type === "others" ? b.groups : []));

const v3Topic = (id: string, o: Record<string, unknown> = {}) => ({ id, title: id, origin: "session", persona: null, activityAt: null, state: "active", last: null, mark: null, turn: null, group: "g", place: null, ...o });
const v3Result = (topics: unknown[], o: Record<string, unknown> = {}) => ({ groups: [{ key: "g", name: "General", turns: 0, running: 0 }], topics, turns: 0, turnIds: [], rightHands: [], ...o });

/**
 * v3.html の骨組みを DomNode で組み、ui.js・topics.js・shell.js を読み込む。views.info は known のタブだけを返し、
 * ch: のタブは data-stick="bottom" の .ed-scroll（高さは heights。既定 1,000・見える高さ 200）と見出しの [‹] を描く
 */
function loadShell(
  opts: {
    phone?: boolean;
    hash?: string;
    known?: (tab: string) => boolean;
    status?: unknown;
    width?: number;
    storage?: Record<string, string>;
    initState?: unknown;
    asyncBack?: boolean;
    focusRow?: boolean;
    noList?: boolean;
    draw?: (st: ListState) => boolean;
    drawBar?: (bar: BarState) => boolean;
    focusHand?: boolean;
  } = {},
) {
  // width は .v3 の幅（右腕の形を決める。既定 1,400 = 列。一覧は 280px）
  // initState は最初の entry の state（再読み込みで残った物）。asyncBack なら back() の移動と popstate は runHistory() まで待つ（ブラウザと同じく非同期）
  const state = { phone: opts.phone ?? false, now: 1_000_000, width: opts.width ?? 1400 };
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
  const headOps = node("span", "v3-head-ops");
  const searchBox = node("div", "v3-search-box");
  searchBox.hidden = true;
  const views = node("div", "v3-views");
  views.hidden = true;
  // 一覧の入れ物（中は部品が描く。fake DOM では描かない）
  const listRoot = node("div", "c-list-root", "v3-slot");
  const list = node("nav", "v3-list", "v3-list");
  // 下のバーの入れ物（中は部品が描く。fake DOM では右腕と「ほか」の代わりのボタンだけ）
  const bottomRoot = node("div", "c-bottom-root", "v3-slot");
  const bottomHand = node("button");
  bottomHand.setAttribute("data-act", "hand");
  const bottomMore = node("button");
  if (!opts.noList) bottomRoot.append(bottomHand, bottomMore);
  list.append(headOps, searchBox, listRoot, bottomRoot);
  Object.defineProperty(list, "offsetWidth", { value: 280 });
  Object.defineProperty(v3, "clientWidth", { get: () => state.width });
  const main = node("main", "v3-main", "v3-main");
  const bar = node("div", "v3-bar");
  const handOpen = node("button", "v3-hand-open", "btn btn-ghost btn-sm v3-hand-open");
  const place = node("button", "v3-place", "btn btn-ghost btn-sm v3-place");
  place.hidden = true;
  bar.append(place, views, handOpen);
  const ed = node("div", "ed", "ed");
  main.append(bar, ed);
  const hand = node("aside", "v3-hand", "v3-hand");
  const handShow = node("button", "v3-hand-show", "btn btn-ghost btn-sm btn-icon-sm v3-hand-show");
  const handEd = node("div", "v3-hand-ed", "ed v3-hand-ed");
  hand.append(handShow, handEd);
  const backdrop = node("div", "v3-hand-backdrop", "v3-hand-backdrop");
  backdrop.hidden = true;
  v3.append(list, main, hand, backdrop);
  const body = node("body");
  body.append(v3, node("dialog", "v3-sheet"));
  // 始めるダイアログ（M4b）: showModal・close は open の属性を書き、close は "close" を出す（ブラウザの <dialog> と同じく、開いていなければ出さない）
  const start = node("dialog", "v3-start", "v3-start");
  Object.assign(start, {
    showModal: () => start.setAttribute("open", ""),
    close: () => {
      if (start.getAttribute("open") === null) return;
      start.removeAttribute("open");
      start.dispatch("close");
    },
  });
  const startForm = node("form", "v3-start-form", "stack");
  startForm.append(
    node("select", "v3-start-place", "select"),
    node("textarea", "v3-start-text", "textarea"),
    node("input", "v3-start-name", "input"),
    Object.assign(node("p", "v3-start-error", "alert"), { hidden: true }),
    node("p", "v3-start-hint", "meta"),
    node("button", "v3-start-cancel", "btn btn-secondary btn-sm"),
    node("button", "v3-start-ok", "btn btn-primary btn-sm"),
  );
  start.append(startForm);
  body.append(start);
  // 確認（ui.js の SA.ui.confirm が引く。M5c）: close は開いていれば "close" を出す
  const confirm = node("dialog", "dlg-confirm");
  Object.assign(confirm, {
    showModal: () => confirm.setAttribute("open", ""),
    close: () => {
      if (confirm.getAttribute("open") === null) return;
      confirm.removeAttribute("open");
      confirm.dispatch("close");
    },
  });
  const confirmTarget = node("p", "dlg-confirm-target", "dlg-target");
  confirmTarget.hidden = true;
  confirm.append(
    node("h2", "dlg-confirm-title", "dlg-title"),
    confirmTarget,
    node("p", "dlg-confirm-body", "meta"),
    node("button", "dlg-confirm-cancel", "btn btn-secondary btn-sm"),
    node("button", "dlg-confirm-ok", "btn btn-primary btn-sm"),
  );
  body.append(confirm);
  const ids = new Map<string, DomNode>();
  for (const n of descendants(body)) if (n instanceof DomNode && n.getAttribute("id")) ids.set(n.getAttribute("id")!, n);
  // ≤639px の一覧の間は .v3-main が display: none（shell.css）。hidden の要素も出ない
  // 畳んだ右腕の中身も display: none
  DomNode.hides = (n) => n.hidden || (n === main && state.phone && v3.getAttribute("data-view") === "list") || (n === handEd && v3.getAttribute("data-hand") === "closed");
  DomNode.focused = null;

  const docListeners = new Map<string, Array<(e: unknown) => void>>();
  const winListeners = new Map<string, Array<(e: unknown) => void>>();
  const on = (map: typeof docListeners) => (type: string, fn: (e: unknown) => void) => map.set(type, [...(map.get(type) ?? []), fn]);
  const fire = (type: string, e: unknown = {}) => {
    for (const fn of winListeners.get(type) ?? []) fn(e);
  };
  const fireDoc = (type: string, e: unknown = {}) => {
    for (const fn of docListeners.get(type) ?? []) fn(e);
  };
  const document = {
    readyState: "complete",
    visibilityState: "visible",
    title: "",
    documentElement: { dataset: {} as Record<string, string>, style: { setProperty() {}, removeProperty() {} } },
    body,
    get activeElement() {
      return DomNode.focused && body.contains(DomNode.focused) ? DomNode.focused : body;
    },
    contains: (n: unknown) => body.contains(n),
    // 後から作った要素（絞り込み欄など）も id で引ける
    getElementById: (id: string) => ids.get(id) ?? (descendants(body).find((n) => n.getAttribute("id") === id) as DomNode | undefined) ?? null,
    createElement: (tag: string) => new DomNode(tag),
    createElementNS: (_ns: string, tag: string) => new DomNode(tag),
    createTextNode: (text: string) => Object.assign(new DomNode("#text"), { text }),
    querySelector: () => null,
    querySelectorAll: () => [],
    addEventListener: on(docListeners),
  };
  const location = {
    reload() {
      calls.reload++;
    },
    hash: opts.hash ?? "",
    pathname: "/static/v3.html",
    search: "",
    get href() {
      return "https://host" + this.pathname + this.search + this.hash;
    },
  };
  const hashOfUrl = (url: string) => (url.includes("#") ? url.slice(url.indexOf("#")) : "");
  const entries: Array<{ state: unknown; hash: string }> = [{ state: opts.initState ?? null, hash: location.hash }];
  let index = 0;
  const calls = { push: 0, back: 0, reload: 0 };
  const pendingHistory: Array<() => void> = [];
  const runHistory = () => {
    for (const fn of pendingHistory.splice(0)) fn();
  };
  const traverse = (to: number) => {
    if (to < 0 || to > entries.length - 1 || to === index) return;
    index = to;
    location.hash = entries[index]!.hash;
    fire("popstate", { state: entries[index]!.state });
  };
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
      calls.back++;
      if (opts.asyncBack) pendingHistory.push(() => traverse(index - 1));
      else traverse(index - 1);
    },
    go(n: number) {
      traverse(index + n);
    },
    forward() {
      if (index === entries.length - 1) return;
      index++;
      location.hash = entries[index]!.hash;
      fire("popstate", { state: entries[index]!.state });
    },
  };
  const mqListeners: Array<() => void> = [];
  const mq = {
    get matches() {
      return state.phone;
    },
    addEventListener: (_type: string, fn: () => void) => void mqListeners.push(fn),
  };
  /** 幅を変えて (max-width: 639px) の change と resize を出す */
  const setPhone = (phone: boolean, width: number) => {
    state.width = width;
    if (state.phone !== phone) {
      state.phone = phone;
      for (const fn of mqListeners) fn();
    }
    fire("resize");
  };
  const storage = new Map<string, string>(Object.entries(opts.storage ?? {}));
  const localStorage = { getItem: (k: string) => storage.get(k) ?? null, setItem: (k: string, v: string) => void storage.set(k, String(v)) };
  const window = { matchMedia: () => mq, addEventListener: on(winListeners), innerHeight: 800, scrollY: 0, localStorage } as Record<string, unknown>;
  class FakeDate extends Date {
    static override now(): number {
      return state.now;
    }
  }
  // console.error は覚える（ほかはそのまま）
  const errors: string[] = [];
  const fakeConsole = Object.assign(Object.create(console) as Console, { error: (...a: unknown[]) => void errors.push(a.join(" ")) });
  const context = {
    window,
    document,
    history,
    location,
    console: fakeConsole,
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
  const opens: string[] = [];
  const known = opts.known ?? ((tab: string) => tab.startsWith("ch:") || tab.startsWith("cc:") || tab === "tasks");
  SA.views = {
    info: (tab: string) =>
      known(tab)
        ? {
            title: "題:" + tab,
            icon: "i-" + tab,
            render: (container: DomNode) => {
              rendered.push({ tab, view: v3.getAttribute("data-view") });
              const scroll = ui.el("div", { class: "ed-scroll", "data-stick": tab.startsWith("ch:") ? "bottom" : undefined });
              scroll.scrollHeight = heights[tab] ?? 1000;
              scroll.clientHeight = 200;
              container.replaceChildren(ui.el("header", { class: "ed-toolbar" }, [ui.backButton()]), scroll);
            },
            onClose: () => closes.push(tab),
            onOpen: () => opens.push(tab),
          }
        : null,
    ago: () => "1 分前",
    loading: () => ui.el("p", { class: "loading", text: "読み込み中…" }),
  };
  const loads = { channels: 0, turns: [] as string[] };
  // 既読（M7）: topics.js の syncReads の引数と、shell.js の markSeenShown の回数・呼ばれた時点の readingChannelIds の写し（SA.app がまだ無ければ null）
  const syncs: Array<{ reads: unknown; ids: string[] }> = [];
  const marks = { seenShown: 0, reading: [] as Array<string[] | null> };
  SA.store = {
    status: opts.status === undefined ? {} : opts.status,
    notices: null,
    isUnread: (_c: { id: string; last: unknown }) => false,
    syncReads: (reads: unknown, ids: string[]) => {
      syncs.push({ reads: JSON.parse(JSON.stringify(reads ?? null)), ids: JSON.parse(JSON.stringify(ids)) });
      return true;
    },
    load: {
      channels() {
        loads.channels++;
        return Promise.resolve(null);
      },
      turns(id: string) {
        loads.turns.push(id);
        return Promise.resolve(null);
      },
      usageDays() {},
      usage() {},
    },
  };
  // 右腕の描画（chat.js の render の代わり）: 見出しに題と frame.ops()、下端に寄せる .ed-scroll（高さは heights.hand）、入力欄は作り直さない
  const handRenders: Array<{ id: string; frame: HandFrame }> = [];
  const chatChannels: Record<string, unknown> = {};
  // 右腕の Bot の返事の本文（描くたびに replyText・replyExtras を通して .ed-scroll に入れる）
  const handReplies: string[] = [];
  SA.chat = {
    markSeenShown: () => {
      marks.seenShown++;
      let ids: string[] | null = null;
      try {
        const app = SA.app as { readingChannelIds?: () => string[] } | undefined;
        if (app && typeof app.readingChannelIds === "function") ids = JSON.parse(JSON.stringify(app.readingChannelIds())) as string[];
      } catch {
        ids = null;
      }
      marks.reading.push(ids);
    },
    channelById: (id: string) => chatChannels[id] ?? {},
    channelTitle: (ch: { title?: string }) => ch.title ?? "セッション",
    STATE_LABEL: { active: "進行中", waiting: "待ち", done: "完了" },
    render: (container: DomNode, id: string, frame: HandFrame) => {
      handRenders.push({ id, frame });
      const kept = (container.children as DomNode[]).find((c) => c.classes.has("composer-wrap"));
      const scroll = ui.el("div", { class: "ed-scroll", "data-stick": "bottom" });
      scroll.scrollHeight = heights.hand ?? 1000;
      scroll.clientHeight = 200;
      for (const text of handReplies) {
        scroll.append(ui.el("div", { class: "msg" }, [ui.el("p", { class: "msg-text", text: frame.replyText ? frame.replyText(text) : text }), ...(frame.replyExtras ? frame.replyExtras(text) : [])]));
      }
      const head = ui.el("header", { class: "ed-toolbar" }, [ui.el("h1", { text: frame.title }), ...(frame.ops ? frame.ops() : [])]);
      container.replaceChildren(head, scroll, kept ?? ui.el("div", { class: "composer-wrap" }, [ui.el("textarea", { class: "composer-input" })]));
    },
  };
  SA.poll = { start() {}, stopped: () => false };
  const api = {
    calls: 0,
    paths: [] as string[],
    reply: (): Promise<unknown> => Promise.resolve(v3Result([])),
    // POST（M4b）: 呼ばれた引数を覚え、postReply の結果で resolve・reject する
    posts: [] as Array<{ path: string; body: unknown; opts: unknown }>,
    postReply: (): Promise<unknown> => Promise.resolve({}),
  };
  SA.api = {
    get: (path: string) => {
      api.calls++;
      api.paths.push(path);
      return api.reply();
    },
    post: (path: string, body: unknown, opts: unknown) => {
      api.posts.push({ path, body: JSON.parse(JSON.stringify(body)), opts: JSON.parse(JSON.stringify(opts ?? null)) });
      return api.postReply();
    },
  };
  // 部品の入口（c-app.js の SA.list）の代わり: draw は state とモデルを覚え（作るときに例外なら false）、ほかは呼ばれた事を覚える
  const listSeen = {
    states: [] as ListState[],
    models: [] as ListModel[],
    focusRows: [] as string[],
    focusLists: 0,
    top: 0,
    bottoms: [] as BarState[],
    bottomModels: [] as BottomModel[],
    focusHands: 0,
  };
  // noList なら入れない（c-app.js の module が読めなかった）。opts.draw はモデルを作った後の答えを決める
  if (!opts.noList) SA.list = {
    draw(st: ListState) {
      listSeen.states.push(st);
      try {
        listSeen.models.push(listModel(st));
      } catch {
        return false;
      }
      return opts.draw ? opts.draw(st) : true;
    },
    focusRow(id: string) {
      listSeen.focusRows.push(id);
      return opts.focusRow ?? true;
    },
    focusList() {
      listSeen.focusLists++;
    },
    scrollTop: () => listSeen.top,
    setScrollTop(n: number) {
      listSeen.top = n;
    },
    // 下のバー: bar とモデルを覚え（作るときに例外なら false）、opts.drawBar が答えを決める
    drawBar(bar: BarState) {
      listSeen.bottoms.push(bar);
      try {
        listSeen.bottomModels.push(bottomModel({ variant: state.phone ? "phone" : "wide", turns: bar.turns, hand: bar.hand, tabs: bar.tabs }));
      } catch {
        return false;
      }
      return opts.drawBar ? opts.drawBar(bar) : true;
    },
    focusHand() {
      listSeen.focusHands++;
      if (opts.focusHand === false) return false;
      bottomHand.focus();
      return true;
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
  /** 最後に draw へ渡したモデル・state */
  const model = (): ListModel => {
    const m = listSeen.models[listSeen.models.length - 1];
    assert.ok(m, "SA.list.draw が呼ばれていない");
    return m;
  };
  const lastState = (): ListState => {
    const st = listSeen.states[listSeen.states.length - 1];
    assert.ok(st, "SA.list.draw が呼ばれていない");
    return st;
  };
  /** モデルの中の群の行（完了・「ほかのプロジェクト」の中も）。無ければ null */
  const rowOf = (id: string): ListRow | null => {
    for (const g of modelGroups(model())) {
      const found = [...g.rows, ...(g.done ? g.done.rows : [])].find((r) => r.id === id);
      if (found) return found;
    }
    return null;
  };
  const turnOf = (id: string): ListTurn | null => model().turns?.items.find((t) => t.id === id) ?? null;
  const groupOf = (key: string): ListGroup | null => modelGroups(model()).find((g) => g.key === key) ?? null;
  /** 最後に drawBar へ渡したモデル・bar */
  const bottom = (): BottomModel => {
    const m = listSeen.bottomModels[listSeen.bottomModels.length - 1];
    assert.ok(m, "SA.list.drawBar が呼ばれていない");
    return m;
  };
  const bottomState = (): BarState => {
    const b = listSeen.bottoms[listSeen.bottoms.length - 1];
    assert.ok(b, "SA.list.drawBar が呼ばれていない");
    return b;
  };
  /** 最後の state.on を呼ぶ（部品のボタンを押した代わり） */
  const press = {
    open: (id: string, done = false) => lastState().on.open(id, done),
    add: (key: string, opener: unknown) => lastState().on.add(key, opener),
    toggleDone: (key: string) => lastState().on.toggleDone(key),
    toggleOthers: () => lastState().on.toggleOthers(),
    retry: () => lastState().on.retry(),
    // 下のバーの list・hand・more（opener を省くと hand は bottomHand、more は bottomMore）と tab
    bottom: (act: "list" | "hand" | "more", opener?: unknown) => {
      const on = bottomState().on;
      if (act === "list") return on.list();
      if (act === "hand") return on.hand(opener ?? bottomHand);
      return on.more(opener ?? bottomMore);
    },
    tab: (id: string) => bottomState().on.tab(id),
  };
  return {
    errors,
    list: listSeen,
    model,
    listState: lastState,
    bottom,
    bottomState,
    rowOf,
    turnOf,
    groupOf,
    press,
    app: SA.app as ShellApp,
    topics: SA.topics as Topics,
    nodes: { v3, ed, listRoot, headOps, searchBox, views, sheet: ids.get("v3-sheet")!, list, main, bar, hand, handEd, handShow, handOpen, backdrop, bottomRoot, bottomHand, bottomMore },
    handRenders,
    chatChannels,
    handReplies,
    state,
    api,
    heights,
    rendered,
    closes,
    opens,
    loads,
    syncs,
    marks,
    storage,
    fireDoc,
    ui: SA.ui as Record<string, unknown>,
    history,
    location,
    calls,
    runHistory,
    setPhone,
    timers,
    advance,
    flush,
    fire,
    scroll,
    store: SA.store as { status: unknown; notices: unknown; load: Record<string, unknown>; isUnread: (c: { id: string; last: unknown }) => boolean },
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

test("web static: v3 の一覧の入口: render は SA.list.draw に決まった鍵の state を渡し、on・isUnread は毎回同じ物。isUnread は (channelId, last) を store.isUnread({ id, last }) に包む", async () => {
  const h = loadShell();
  const asked: unknown[] = [];
  h.store.isUnread = (c) => {
    asked.push(JSON.parse(JSON.stringify(c)));
    return c.id === "u1";
  };
  h.api.reply = () => Promise.resolve(v3Result([v3Topic("ch:a")]));
  await h.flush();
  await h.topics.load();
  const first = h.listState();
  assert.deepEqual(Object.keys(first).sort(), ["ago", "current", "data", "dataDone", "doneGroup", "failed", "filter", "isUnread", "on", "othersOpen", "time", "turnFrom"]);
  h.topics.render();
  const second = h.listState();
  assert.notEqual(first, second, "state は描くたびに作る");
  assert.equal(second.on, first.on);
  assert.equal(second.isUnread, first.isUnread);
  assert.deepEqual(Object.keys(second.on).sort(), ["add", "open", "retry", "toggleDone", "toggleOthers"]);
  asked.length = 0;
  assert.equal(second.isUnread("u1", "L1"), true);
  assert.equal(second.isUnread("u2", null), false);
  assert.deepEqual(asked, [{ id: "u1", last: "L1" }, { id: "u2", last: null }]);
  assert.equal(h.model().phase, "ready");
});

test("web static: v3 の load・schedule: 読み込み中に頼まれた分は並行にせず後で 1 回、形の合わない応答・描けない応答は失敗の表示で次の予約が掛かる", async () => {
  // 入口が描けなかった（false）ときを作れる
  let drawOk = true;
  const h = loadShell({ draw: () => drawOk });
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
  assert.equal(h.model().note, "更新できませんでした。前の一覧を出しています");
  assert.equal(polls(), 1);
  // 描けない（入口が false）: data の無い失敗の表示（[もう一度読む]）で描き直し、次の予約も掛かる
  h.api.reply = () => Promise.resolve(v3Result([v3Topic("ch:a")]));
  drawOk = false;
  await h.topics.load();
  assert.equal(h.model().phase, "failed");
  assert.equal(polls(), 1);
  // 直ればもとに戻る
  drawOk = true;
  await h.topics.load();
  assert.equal(h.model().note, "");
});

test("web static: v3 の init は最初の応答の前に 1 回描き、そのモデルは読み込み中", async () => {
  const h = loadShell();
  h.api.reply = () => new Promise(() => undefined);
  // loadShell の init は同期で走り、最初の応答はまだ返っていない
  assert.equal(h.list.states.length, 1);
  assert.equal(h.list.states[0]!.data, null);
  assert.equal(listModel(h.list.states[0]).phase, "loading");
});

test("web static: v3 の下のバーの入口: 最初の応答の前に描き、件数・印・引ける画面を渡し、描けなければ静かな形で 1 回だけ描き直す", async () => {
  const both = (tab: string) => tab.startsWith("ch:") || tab === "tasks" || tab === "reminders";
  const h = loadShell({ known: both });
  h.api.reply = () => new Promise(() => undefined);
  // init は同期で描く（回数は見ない。右腕の口を描くたびにも描く）
  assert.ok(h.list.bottoms.length >= 1);
  const first = h.list.bottoms[0]!;
  assert.deepEqual(Object.keys(first).sort(), ["hand", "on", "tabs", "turns"]);
  assert.equal(first.turns, 0);
  assert.equal(first.hand, null);
  assert.deepEqual(JSON.parse(JSON.stringify(first.tabs)), [
    { id: "tasks", title: "題:tasks" },
    { id: "reminders", title: "題:reminders" },
  ]);
  // 引けない画面は渡さない
  const t = loadShell({ known: (tab) => tab === "tasks" });
  assert.deepEqual(JSON.parse(JSON.stringify(t.bottomState().tabs)), [{ id: "tasks", title: "題:tasks" }]);
  // 読んだ後の件数。on は毎回同じ物
  const r = loadShell({ known: both });
  await r.flush();
  r.api.reply = () => Promise.resolve(v3Result([v3Topic("ch:1", { turn: { kind: "permission", since: "2026-11-14T00:00:00Z", summary: null } })], { turns: 3, turnIds: ["ch:1"] }));
  await r.topics.load();
  assert.equal(r.bottomState().turns, 3);
  assert.equal(r.list.bottoms[0]!.on, r.bottomState().on);
  // 「一覧」は一覧の先頭へ
  r.list.top = 50;
  r.press.bottom("list");
  assert.equal(r.list.top, 0);
  // 描けなければ、件数・印・タブの無い形で 1 回だけ描き直す（落ちない）
  const f = loadShell({ known: both, drawBar: () => false });
  await f.flush();
  const pairs = () => {
    assert.equal(f.list.bottoms.length % 2, 0);
    for (let i = 0; i < f.list.bottoms.length; i += 2) {
      const quiet = f.list.bottoms[i + 1]!;
      assert.deepEqual(JSON.parse(JSON.stringify({ turns: quiet.turns, hand: quiet.hand, tabs: quiet.tabs })), { turns: 0, hand: null, tabs: [] });
      assert.equal(quiet.on, f.list.bottoms[i]!.on);
    }
  };
  pairs();
  const before = f.list.bottoms.length;
  f.api.reply = () =>
    Promise.resolve(v3Result([], { rightHands: [{ id: "ch:900", guildId: "g1", title: "右腕", turn: { kind: "confirm", since: "2026-11-14T00:00:00.000Z", summary: null }, last: null, link: "https://discord.com/channels/1/900" }] }));
  await f.topics.load();
  assert.ok(f.list.bottoms.length > before);
  pairs();
  assert.equal(f.list.bottoms.at(-2)!.hand, "turn");
});

test("web static: 話題に null が混ざった応答でも counts は投げず、右腕の口と下のバーを描く道も止まらない", async () => {
  const h = loadShell();
  await h.flush();
  h.api.reply = () => Promise.resolve(v3Result([null, v3Topic("ch:a", { mark: "running" })], { turns: 1 }));
  await h.topics.load();
  assert.deepEqual(JSON.parse(JSON.stringify(h.topics.counts())), { turns: 1, running: 1 });
  const before = h.list.bottoms.length;
  assert.doesNotThrow(() => h.app.refreshSidebar());
  assert.ok(h.list.bottoms.length > before);
  assert.equal(h.bottomState().turns, 1);
});

test("web static: v3 の入口（SA.list）が無いとき、init は落ちず一覧の場所に 1 文と読み直すボタンを出し、下のバーは出さず、ほかは動く", async () => {
  const h = loadShell({ noList: true });
  await h.flush();
  const kidsOf = h.nodes.listRoot.children as DomNode[];
  assert.equal(kidsOf.length, 1);
  const box = kidsOf[0]!;
  assert.equal(box.tagName, "div");
  assert.ok(box.classes.has("v3-empty") && box.classes.has("v3-entry-missing"));
  const inner = box.children as DomNode[];
  assert.equal(inner.length, 2);
  assert.equal(inner[0]!.tagName, "p");
  assert.ok(inner[0]!.classes.has("meta"));
  assert.equal(inner[0]!.textContent, "一覧を表示できませんでした");
  const again = inner[1]!;
  assert.equal(again.tagName, "button");
  assert.ok(again.classes.has("btn") && again.classes.has("btn-secondary"));
  assert.equal(again.getAttribute("type"), "button");
  assert.equal(again.textContent, "ページを読み直す");
  again.dispatch("click");
  assert.equal(h.calls.reload, 1);
  // 下のバーの代わりは作らない
  assert.equal(h.nodes.bottomRoot.children.length, 0);
  assert.deepEqual(h.errors, ["[web] list entry missing"]);
  // 読み取り・描き直し・開くは止まらない。件数は題に出す
  h.api.reply = () => Promise.resolve(v3Result([v3Topic("ch:a")], { turns: 1 }));
  await h.topics.load();
  assert.equal(h.document.title, "(1) self-agent");
  h.topics.render();
  h.app.open("ch:a");
  assert.equal(h.app.activeTabId(), "ch:a");
  // 1 文とボタンを縦に並べる
  const css = read("shell.css");
  const at = css.indexOf("\n.v3-entry-missing {");
  assert.ok(at >= 0);
  const rule = css.slice(css.indexOf("{", at) + 1, css.indexOf("}", at));
  assert.match(rule, /flex-direction: column;/);
  assert.match(rule, /gap: var\(--space-3\);/);
});

test("web static: v3 の render は入口の draw が false なら failed にして、data の無い失敗の表示で 1 回だけ描き直し（data は残す）、もう失敗なら描き直さない", async () => {
  let drawOk = true;
  const h = loadShell({ draw: () => drawOk });
  h.api.reply = () => Promise.resolve(v3Result([v3Topic("ch:a")]));
  await h.flush();
  await h.topics.load();
  const n = h.list.states.length;
  drawOk = false;
  h.topics.render();
  assert.equal(h.list.states.length, n + 2);
  assert.equal(h.list.states[n]!.failed, false);
  const second = h.list.states[n + 1]!;
  assert.equal(second.failed, true);
  assert.equal(second.data, null);
  // 投げずに失敗のモデル（[もう一度読む] の出る phase）を作れる
  assert.equal(listModel(second).phase, "failed");
  assert.equal(h.model().phase, "failed");
  // data 自体は消さない（次の 1 回目の draw には前の data が渡る）
  h.topics.render();
  assert.notEqual(h.list.states[n + 2]!.data, null);
  assert.equal(h.list.states.length, n + 3, "もう失敗なら 1 回だけ");
});

test("web static: v3 の load: turnIds が配列でない応答は data に入れず、失敗の表示で前の data が残る", async () => {
  const h = loadShell();
  await h.flush();
  h.api.reply = () => Promise.resolve(v3Result([v3Topic("ch:a")]));
  await h.topics.load();
  const before = h.listState().data;
  assert.equal(h.model().phase, "ready");
  for (const turnIds of [null, "ch:a", { 0: "ch:a" }]) {
    h.api.reply = () => Promise.resolve({ ...v3Result([v3Topic("ch:b")]), turnIds });
    await h.topics.load();
    assert.equal(h.listState().data, before, JSON.stringify(turnIds));
    assert.equal(h.listState().failed, true);
    assert.equal(h.model().phase, "ready");
    assert.equal(h.model().note, "更新できませんでした。前の一覧を出しています");
    assert.deepEqual(h.groupOf("g")!.rows.map((r) => r.id), ["ch:a"]);
  }
});

test("web static: v3 の「あなたの番」が 0 に戻ると turns が null になり、一覧へ戻ると開いていた話題の行に焦点を頼む", async () => {
  const h = loadShell({ phone: true });
  const turn = { kind: "permission", since: "2026-11-14T00:00:00Z", summary: null };
  h.api.reply = () => Promise.resolve(v3Result([v3Topic("ch:a", { mark: "turn", turn })], { turns: 1, turnIds: ["ch:a"] }));
  await h.flush();
  await h.topics.load();
  assert.deepEqual(h.model().turns?.items.map((t) => t.id), ["ch:a"]);
  h.app.open("ch:a");
  // 群の中の行を先に探すのは入口（c-app.js の focusRow）
  h.history.back();
  assert.deepEqual(h.list.focusRows, ["ch:a"]);
  h.app.open("ch:a");
  h.api.reply = () => Promise.resolve(v3Result([v3Topic("ch:a")]));
  await h.topics.load();
  assert.equal(h.model().turns, null);
  h.history.back();
  assert.deepEqual(h.list.focusRows, ["ch:a", "ch:a"]);
});

test("web static: v3 の群は見出しの「話題なし」⇄ 行の一覧を入れ替える", async () => {
  const h = loadShell();
  const groups = [v3Group("g", { name: "General" })];
  h.api.reply = () => Promise.resolve(v3Result([], { groups }));
  await h.flush();
  await h.topics.load();
  const g = () => h.groupOf("g")!;
  assert.deepEqual(g().rows, []);
  assert.deepEqual(g().note, { text: "話題なし", tone: "muted" });
  h.api.reply = () => Promise.resolve(v3Result([v3Topic("ch:a")], { groups }));
  await h.topics.load();
  assert.deepEqual(g().rows.map((r) => r.id), ["ch:a"]);
  assert.equal(g().note, null);
  h.api.reply = () => Promise.resolve(v3Result([v3Topic("ch:a", { state: "done" })], { groups }));
  await h.topics.load();
  assert.deepEqual(g().rows, []);
  assert.deepEqual(g().note, { text: "話題なし", tone: "muted" });
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

// ===== 新しい殻の残りの口（M2b） =====
const v3Group = (key: string, o: Record<string, unknown> = {}) => ({ key, kind: "general", name: key, turns: 0, running: 0, open: 1, done: 0, ...o });
const textOf = (n: FakeNode) => n.textContent;
const keyEvent = (key: string, target: unknown, o: Record<string, unknown> = {}) => {
  const e = { key, target, prevented: false, preventDefault: () => (e.prevented = true), ...o };
  return e;
};
const kids = (n: FakeNode) => n.children as DomNode[];

test("web static: 新しい殻の下のバー（広い幅）は タスク・リマインド・ほか の 3 つで、「ほか」は引ける画面だけを決めた順で出す", async () => {
  const all = ["tasks", "reminders", "knowledge", "memories", "github", "usage", "devlog", "notices", "status", "settings"];
  const h = loadShell({ known: (tab) => tab.startsWith("ch:") || (all.includes(tab) && tab !== "github" && tab !== "devlog") });
  await h.flush();
  assert.deepEqual(h.bottom(), {
    variant: "wide",
    items: [
      { act: "tab", id: "tasks", label: "題:tasks" },
      { act: "tab", id: "reminders", label: "題:reminders" },
      { act: "more", label: "ほか" },
    ],
  });
  h.press.tab("tasks");
  assert.equal(h.app.activeTabId(), "tasks");
  h.press.tab("reminders");
  assert.equal(h.app.activeTabId(), "reminders");
  // 「ほか」: GitHub・会話ログは引けないので出さない。見出しに ×
  h.press.bottom("more");
  const sheet = h.nodes.sheet;
  assert.equal(sheet.getAttribute("open"), "");
  assert.equal(sheet.getAttribute("aria-label"), "ほか");
  const rows = sheet.querySelectorAll("button.more-row");
  assert.deepEqual(rows.map(textOf), ["題:knowledge", "題:memories", "題:usage", "題:notices", "題:status", "題:settings"]);
  const close = sheet.querySelector("button.sheet-close")!;
  assert.equal(close.getAttribute("aria-label"), "閉じる");
  assert.equal(textOf(sheet.querySelector("span.sheet-title")!), "ほか");
  close.dispatch("click");
  assert.equal(sheet.getAttribute("open"), null);
  h.press.bottom("more");
  sheet.querySelectorAll("button.more-row").at(-1)!.dispatch("click");
  assert.equal(h.app.activeTabId(), "settings");
  assert.equal(sheet.getAttribute("open"), null);
  // 話題でない画面の間は帯を出さない
  assert.equal(h.document.getElementById("v3-bar")!.hidden, true);

  // GitHub が有効・dev のときは決めた順の中に入る
  const w = loadShell({ known: (tab) => all.includes(tab) });
  await w.flush();
  w.press.bottom("more");
  assert.deepEqual(w.nodes.sheet.querySelectorAll("button.more-row").map(textOf), ["knowledge", "memories", "github", "usage", "devlog", "notices", "status", "settings"].map((id) => "題:" + id));
});

test("web static: スマホの「ほか」の板はタスク・リマインドを先頭に、その後ろに決めた順で出す", async () => {
  const all = ["tasks", "reminders", "knowledge", "memories", "github", "usage", "devlog", "notices", "status", "settings"];
  const h = loadShell({ phone: true, known: (tab) => tab.startsWith("ch:") || all.includes(tab) });
  await h.flush();
  h.press.bottom("more");
  assert.equal(h.nodes.sheet.getAttribute("open"), "");
  assert.deepEqual(h.nodes.sheet.querySelectorAll("button.more-row").map(textOf), all.map((id) => "題:" + id));
});

test("web static: 絞り込みは題名・群・人格の語を全部含むものだけを残し、当たらない群・行はモデルに入れない。「あなたの番」は絞り込まない", async () => {
  const h = loadShell();
  const turn = { kind: "permission", since: "2026-11-14T00:00:00Z", summary: null };
  h.api.reply = () =>
    Promise.resolve(
      v3Result(
        [
          v3Topic("ch:a", { title: "買い物 リスト", group: "g1" }),
          v3Topic("ch:b", { title: "Trip 計画", group: "g1", persona: "Bob" }),
          v3Topic("ch:c", { title: "設計", group: "g2", mark: "turn", turn }),
        ],
        { groups: [v3Group("g1", { name: "General" }), v3Group("g2", { name: "Proj" })], turns: 1, turnIds: ["ch:c"] },
      ),
    );
  await h.flush();
  await h.topics.load();
  h.list.top = 120;
  // 絞り込みのボタンは見出しの先頭
  const toggle = kids(h.nodes.headOps)[0]!;
  assert.equal(toggle.getAttribute("id"), "v3-search-toggle");
  assert.equal(toggle.getAttribute("aria-label"), "話題を絞り込む");
  toggle.dispatch("click");
  assert.equal(h.nodes.searchBox.hidden, false);
  assert.equal(toggle.getAttribute("aria-expanded"), "true");
  const input = h.document.getElementById("v3-search")!;
  assert.equal(h.document.activeElement, input);
  for (const [k, v] of [["type", "search"], ["placeholder", "題名で絞り込む"], ["aria-label", "話題を絞り込む"], ["autocomplete", "off"], ["enterkeyhint", "search"]]) assert.equal(input.getAttribute(k!), v, k);
  const type = (v: string) => {
    (input as unknown as { value: string }).value = v;
    input.dispatch("input");
  };
  const shown = () => ["ch:a", "ch:b", "ch:c"].filter((id) => h.rowOf(id) !== null);
  const groups = () => modelGroups(h.model()).map((g) => g.key);
  // 群の名前と題名の語を両方（大文字・小文字を問わない）
  type("general 買い");
  assert.deepEqual(shown(), ["ch:a"]);
  assert.deepEqual(groups(), ["g1"]);
  // 人格の名前
  type("bob");
  assert.deepEqual(shown(), ["ch:b"]);
  // 「あなたの番」は絞り込まない
  assert.deepEqual(h.model().turns?.items.map((t) => t.id), ["ch:c"]);
  type("proj");
  assert.deepEqual(shown(), ["ch:c"]);
  assert.deepEqual(groups(), ["g2"]);
  assert.equal(h.model().note, "");
  type("zzz");
  assert.deepEqual(groups(), []);
  assert.equal(h.model().note, "当たる話題がありません");
  assert.deepEqual(h.model().turns?.items.map((t) => t.id), ["ch:c"]);
  // 読み直しても絞り込んだまま
  await h.topics.load();
  assert.equal(h.model().note, "当たる話題がありません");
  h.list.top = 0;
  // Escape で閉じると値を空にして全部戻り、位置も戻る・焦点はボタンへ
  h.fireDoc("keydown", keyEvent("Escape", input));
  assert.equal((input as unknown as { value: string }).value, "");
  assert.equal(h.nodes.searchBox.hidden, true);
  assert.equal(toggle.getAttribute("aria-expanded"), "false");
  assert.equal(h.document.activeElement, toggle);
  assert.deepEqual(shown(), ["ch:a", "ch:b", "ch:c"]);
  assert.deepEqual(groups(), ["g1", "g2"]);
  assert.equal(h.model().note, "");
  assert.equal(h.list.top, 120);
  // もう一度押すと開き、もう一度押すと閉じる（入力欄は 1 度だけ作る）
  toggle.dispatch("click");
  toggle.dispatch("click");
  assert.equal(h.nodes.searchBox.hidden, true);
  assert.equal(h.nodes.searchBox.children.length, 1);
});

test("web static: Ctrl+K と SA.app.palette は絞り込み欄に焦点を置く", async () => {
  for (const mod of [{ ctrlKey: true }, { metaKey: true }]) {
    const h = loadShell();
    await h.flush();
    const e = keyEvent("k", h.document.activeElement, mod);
    h.fireDoc("keydown", e);
    assert.equal(e.prevented, true);
    assert.equal(h.nodes.searchBox.hidden, false);
    assert.equal(h.document.activeElement, h.document.getElementById("v3-search"));
    // 入力欄に焦点があっても効く（閉じない）
    h.fireDoc("keydown", keyEvent("k", h.document.activeElement, mod));
    assert.equal(h.nodes.searchBox.hidden, false);
  }
  const h = loadShell();
  await h.flush();
  h.app.palette(">");
  assert.equal(h.nodes.searchBox.hidden, false);
  assert.equal(h.document.activeElement, h.document.getElementById("v3-search"));
  assert.equal((h.document.getElementById("v3-search") as unknown as { value: string }).value ?? "", "", "prefix は捨てる");
  // 修飾なしの k は何もしない
  const p = loadShell();
  await p.flush();
  p.fireDoc("keydown", keyEvent("k", p.document.activeElement));
  assert.equal(p.nodes.searchBox.hidden, true);
});

test("web static: 完了は開いたときだけ ?done=<群> で読み、開いておけるのは 1 つ", async () => {
  const h = loadShell();
  const groups = [v3Group("g1", { name: "A", done: 60 }), v3Group("g2", { name: "B", done: 2 }), v3Group("g3", { name: "C", done: 0 })];
  const doneOf = (key: string) => (key === "g1" ? [v3Topic("ch:d1", { group: "g1", state: "done" })] : [v3Topic("ch:d2", { group: "g2", state: "done" })]);
  h.api.reply = () => {
    const path = h.api.paths.at(-1)!;
    const m = /\?done=(\w+)/.exec(path);
    return Promise.resolve(v3Result([v3Topic("ch:a", { group: "g1" }), ...(m ? doneOf(m[1]!) : [])], { groups }));
  };
  await h.flush();
  await h.topics.load();
  assert.equal(h.api.paths.at(-1), "/api/topics");
  const done = (key: string) => h.groupOf(key)!.done;
  assert.equal(done("g3"), null, "完了の無い群には出さない");
  assert.deepEqual(done("g1"), { label: "完了（60）", open: false, loading: false, rows: [], more: "" });
  // 開く: 読み込み中 → ?done=g1 → 行（done）と「新しい 50 件」
  h.press.toggleDone("g1");
  assert.equal(done("g1")!.open, true);
  assert.equal(done("g1")!.loading, true);
  await h.flush();
  assert.equal(h.api.paths.at(-1), "/api/topics?done=g1");
  assert.equal(done("g1")!.loading, false);
  assert.deepEqual(done("g1")!.rows.map((r) => [r.id, r.done]), [["ch:d1", true]]);
  assert.equal(h.rowOf("ch:a")!.done, false);
  assert.equal(done("g1")!.more, "新しい 50 件を出しています");
  // もう 1 つを開くと前のは閉じ、?done= は後の群
  h.press.toggleDone("g2");
  assert.equal(done("g1")!.open, false);
  await h.flush();
  h.advance(2000);
  await h.flush();
  assert.equal(h.api.paths.at(-1), "/api/topics?done=g2");
  assert.deepEqual(done("g1")!.rows, [], "閉じた完了の行は外す");
  assert.equal(done("g2")!.rows.length, 1);
  assert.equal(done("g2")!.more, "", "50 件以下");
  // 閉じたら読み直さない。次の読み取りは ?done= なし
  const calls = h.api.calls;
  h.press.toggleDone("g2");
  await h.flush();
  assert.equal(h.api.calls, calls);
  assert.equal(done("g2")!.open, false);
  await h.topics.load();
  assert.equal(h.api.paths.at(-1), "/api/topics");
  assert.deepEqual(done("g2")!.rows, []);
});

test("web static: 完了の行が /api/channels に無くて引けなければ、一覧を 1 回読んでから引き直し、それでも無ければ知らせる", async () => {
  let ready = false;
  const h = loadShell({ known: (tab) => tab !== "ch:d1" || ready });
  const toasts: string[] = [];
  h.ui.toast = (text: string) => toasts.push(text);
  const groups = [v3Group("g1", { done: 1 })];
  h.api.reply = () => Promise.resolve(v3Result([v3Topic("ch:d1", { group: "g1", state: "done" })], { groups }));
  await h.flush();
  await h.topics.load();
  h.press.toggleDone("g1");
  await h.flush();
  assert.equal(h.rowOf("ch:d1")!.done, true);
  h.press.open("ch:d1", true);
  await h.flush();
  assert.equal(h.loads.channels, 1);
  assert.deepEqual(toasts, ["この話題はここからは開けません"]);
  assert.equal(h.app.activeTabId(), null);
  // 読んだ後に引ければ開く
  h.store.load = { ...h.store.load, channels: () => ((ready = true), Promise.resolve(null)) };
  h.press.open("ch:d1", true);
  await h.flush();
  assert.equal(h.app.activeTabId(), "ch:d1");
  assert.equal(toasts.length, 1);
});

test("web static: 話題の無いプロジェクトは「ほかのプロジェクト（n）」に畳み、開閉を localStorage に持つ。絞り込み中は閉じられない", async () => {
  const h = loadShell();
  const groups = [
    v3Group("p:a", { kind: "project", name: "a", open: 1 }),
    v3Group("p:b", { kind: "project", name: "b", open: 0 }),
    v3Group("p:c", { kind: "project", name: "c", open: 0, done: 2 }),
    v3Group("general", { name: "General", open: 0 }),
  ];
  // p:c の完了を開いたときだけ、その完了の話題（「ccc」）が届く
  h.api.reply = () => {
    const doneC = (h.api.paths.at(-1) ?? "").includes("?done=p%3Ac") ? [v3Topic("ch:c1", { group: "p:c", title: "ccc", state: "done" })] : [];
    return Promise.resolve(v3Result([v3Topic("ch:a", { group: "p:a", title: "aaa" }), ...doneC], { groups }));
  };
  await h.flush();
  await h.topics.load();
  const outer = () => h.model().blocks.filter((b) => b.type !== "label").map((b) => (b.type === "group" ? b.key : b.type));
  const othersOf = () => h.model().blocks.find((b): b is ListOthers => b.type === "others") ?? null;
  assert.deepEqual(outer(), ["p:a", "others", "general"]);
  assert.equal(othersOf()!.label, "ほかのプロジェクト（2）");
  assert.equal(othersOf()!.open, false, "既定は閉じる");
  assert.equal(othersOf()!.forced, false);
  assert.deepEqual(othersOf()!.groups.map((g) => g.key), ["p:b", "p:c"]);
  // 中の群は見出しと完了だけ（行と「話題なし」は出さない）
  assert.deepEqual(othersOf()!.groups.map((g) => [g.rows.length, g.note, g.done && g.done.label]), [[0, null, null], [0, null, "完了（2）"]]);
  // General は話題が無くても畳まない
  assert.deepEqual(h.groupOf("general")!.note, { text: "話題なし", tone: "muted" });
  // 開閉を保存
  h.press.toggleOthers();
  assert.equal(h.storage.get("self-agent-web:v3-others"), "1");
  assert.equal(othersOf()!.open, true);
  h.press.toggleOthers();
  assert.equal(h.storage.get("self-agent-web:v3-others"), "0");
  assert.equal(othersOf()!.open, false);
  // 絞り込み中は開いた形で閉じられない（保存は変えない）、当たる群が無ければ出さない
  h.press.toggleDone("p:c");
  await h.flush();
  assert.equal(h.api.paths.at(-1), "/api/topics?done=p%3Ac");
  kids(h.nodes.headOps)[0]!.dispatch("click");
  const input = h.document.getElementById("v3-search")!;
  (input as unknown as { value: string }).value = "ccc";
  input.dispatch("input");
  assert.equal(othersOf()!.open, true);
  assert.equal(othersOf()!.forced, true);
  assert.deepEqual(othersOf()!.groups.map((g) => g.key), ["p:c"]);
  h.press.toggleOthers();
  assert.equal(h.storage.get("self-agent-web:v3-others"), "0");
  assert.equal(othersOf()!.open, true, "絞り込み中は閉じられない");
  (input as unknown as { value: string }).value = "aaa";
  input.dispatch("input");
  assert.equal(othersOf(), null);
  (input as unknown as { value: string }).value = "";
  input.dispatch("input");
  assert.equal(othersOf()!.open, false, "保存した開閉に戻す");
  assert.equal(othersOf()!.forced, false);
  // 保存が開なら、次の殻は開いて出す
  const w = loadShell();
  w.storage.set("self-agent-web:v3-others", "1");
  w.api.reply = h.api.reply;
  await w.flush();
  await w.topics.load();
  assert.equal(w.model().blocks.find((b): b is ListOthers => b.type === "others")!.open, true);
  // 畳む群が無ければ出さない
  h.api.reply = () => Promise.resolve(v3Result([v3Topic("ch:a", { group: "p:a" })], { groups: [groups[0], groups[3]] }));
  await h.topics.load();
  assert.deepEqual(outer(), ["p:a", "general"]);
});

test("web static: [会話][端末] はチャンネルのある生きた Claude Code の話題だけに出て、「端末」の間 activeTabId は cc:<sessionId>", async () => {
  const h = loadShell();
  const topics = [
    v3Topic("ch:a", { origin: "cc", sessionId: "s1" }),
    v3Topic("ch:b", { origin: "cc", sessionId: null }),
    v3Topic("cc:x", { origin: "cc", sessionId: "x" }),
    v3Topic("ch:c", { origin: "session", sessionId: null }),
  ];
  h.api.reply = () => Promise.resolve(v3Result(topics));
  await h.flush();
  await h.topics.load();
  h.app.open("ch:a");
  assert.equal(h.nodes.views.hidden, false);
  const [talk, pane] = kids(h.nodes.views);
  assert.deepEqual([textOf(talk!), textOf(pane!)], ["会話", "端末"]);
  assert.equal(talk!.getAttribute("type"), "button");
  assert.deepEqual([talk!.getAttribute("aria-pressed"), pane!.getAttribute("aria-pressed")], ["true", "false"]);
  h.scroll().scrollTop = 100;
  pane!.dispatch("click");
  assert.equal(h.app.activeTabId(), "cc:s1");
  assert.deepEqual(h.rendered.at(-1)!.tab, "cc:s1");
  assert.ok(h.opens.includes("cc:s1"), "画面の写しを読み直す");
  assert.deepEqual([talk!.getAttribute("aria-pressed"), pane!.getAttribute("aria-pressed")], ["false", "true"]);
  // hash と一覧の選んでいる行は話題のまま
  assert.equal(h.location.hash, "#/ch/a");
  assert.equal(h.rowOf("ch:a")!.current, true);
  // refresh は出している物にだけ当たる
  let before = h.rendered.length;
  h.app.refresh("ch:a");
  assert.equal(h.rendered.length, before);
  h.app.refresh("cc:s1");
  assert.equal(h.rendered.length, before + 1);
  // 会話に戻すと別のタブとして下端
  talk!.dispatch("click");
  assert.equal(h.app.activeTabId(), "ch:a");
  assert.equal(h.scroll().scrollTop, 800);
  assert.deepEqual(h.closes, [], "切り替えでは閉じない");
  // 話題を開き直すと会話に戻る
  pane!.dispatch("click");
  h.app.open("ch:a");
  assert.equal(h.app.activeTabId(), "ch:a");
  assert.equal(h.rendered.at(-1)!.tab, "ch:a");
  // セッションが一覧から外れたら端末をやめて会話を描く
  pane!.dispatch("click");
  topics[0] = v3Topic("ch:a", { origin: "cc", sessionId: null });
  await h.topics.load();
  assert.equal(h.nodes.views.hidden, true);
  assert.equal(h.app.activeTabId(), "ch:a");
  assert.equal(h.rendered.at(-1)!.tab, "ch:a");
  // チャンネルの無い・Claude Code でない・一覧に居ない話題には出さない
  for (const id of ["ch:b", "cc:x", "ch:c"]) {
    h.app.open(id);
    assert.equal(h.nodes.views.hidden, true, id);
    assert.equal(h.app.activeTabId(), id);
  }
});

test("web static: スマホで会話の列が隠れている間の [端末] の refresh も、出している物で見る", async () => {
  const h = loadShell({ phone: true });
  h.api.reply = () => Promise.resolve(v3Result([v3Topic("ch:a", { origin: "cc", sessionId: "s1" })]));
  await h.flush();
  await h.topics.load();
  h.app.open("ch:a");
  kids(h.nodes.views)[1]!.dispatch("click");
  h.history.back();
  const before = h.rendered.length;
  h.app.refresh("ch:a");
  assert.equal(h.rendered.length, before);
  h.app.refresh("cc:s1");
  assert.equal(h.rendered.length, before + 1);
});

test("web static: 接続の点と鈴は今の殻と同じラベルで、押すと状態・知らせを開く", async () => {
  const h = loadShell({ known: (tab) => tab === "status" || tab === "notices" });
  await h.flush();
  const conn = () => kids(kids(h.nodes.headOps)[1]!);
  assert.deepEqual(conn(), [], "届く前は出さない");
  h.store.status = { bots: [{ name: "A", connected: true }] };
  h.store.notices = { recent24h: 3 };
  h.app.refreshStatus();
  h.app.refreshNotices();
  const [dot, bell] = conn();
  assert.equal(kids(h.nodes.headOps)[0]!.getAttribute("id"), "v3-search-toggle", "絞り込みのボタンが先頭");
  assert.equal(dot!.getAttribute("aria-label"), "A の Bot: 接続中");
  assert.equal(dot!.getAttribute("title"), "A の Bot: 接続中");
  assert.ok(dot!.classes.has("btn-icon-sm"));
  assert.ok(dot!.querySelector("span.dot.dot-ok"));
  assert.equal(bell!.getAttribute("aria-label"), "知らせ（直近 24 時間 3 件）");
  assert.ok(bell!.classes.has("title-bell"));
  assert.equal(textOf(bell!.querySelector("span.title-bell-count")!), "3");
  dot!.dispatch("click");
  assert.equal(h.app.activeTabId(), "status");
  bell!.dispatch("click");
  assert.equal(h.app.activeTabId(), "notices");
  // 変わらなければ作り直さない
  h.app.refreshStatus();
  assert.equal(conn()[0], dot);
  h.store.status = { bots: [{ name: "A", connected: false }] };
  h.store.notices = { recent24h: 0 };
  h.app.refreshStatus();
  const [dot2, bell2] = conn();
  assert.equal(dot2!.getAttribute("aria-label"), "A の Bot: 接続できません");
  assert.ok(dot2!.querySelector("span.dot.dot-bad"));
  assert.equal(bell2!.getAttribute("aria-label"), "知らせ（直近 24 時間 0 件）");
  assert.equal(bell2!.querySelector("span.title-bell-count"), null);
});

test("web static: v3 の一覧の注意は 更新の失敗 > Claude Code の一覧が読めない > 当たらない の 1 つだけ", async () => {
  const h = loadShell();
  const cc = { enabled: true, stale: false, unreadable: true };
  h.api.reply = () => Promise.resolve(v3Result([v3Topic("ch:a")], { cc }));
  await h.flush();
  await h.topics.load();
  assert.equal(h.model().note, "Claude Code の一覧を読めません。作業中の話題が欠けて見えることがあります");
  h.app.palette();
  const input = h.document.getElementById("v3-search")!;
  (input as unknown as { value: string }).value = "zzz";
  input.dispatch("input");
  assert.equal(h.model().note, "Claude Code の一覧を読めません。作業中の話題が欠けて見えることがあります");
  h.api.reply = () => Promise.resolve(null);
  await h.topics.load();
  assert.equal(h.model().note, "更新できませんでした。前の一覧を出しています");
  // 無効・古いだけなら出さない
  for (const c of [{ enabled: false, stale: false, unreadable: true }, { enabled: true, stale: true, unreadable: false }]) {
    const w = loadShell();
    w.api.reply = () => Promise.resolve(v3Result([v3Topic("ch:a")], { cc: c }));
    await w.flush();
    await w.topics.load();
    assert.equal(w.model().note, "");
  }
});

test("web static: /api/status が届く前に押した cc: の行は、届いたら開く", async () => {
  let ready = false;
  const h = loadShell({ status: null, known: (tab) => tab.startsWith("ch:") || (tab === "cc:x" && ready) });
  h.api.reply = () => Promise.resolve(v3Result([v3Topic("ch:a"), v3Topic("cc:x", { origin: "cc", sessionId: "x" })]));
  await h.flush();
  await h.topics.load();
  h.app.open("ch:a");
  h.press.open("cc:x");
  await h.flush();
  assert.equal(h.app.activeTabId(), "ch:a");
  ready = true;
  h.store.status = {};
  h.app.refreshStatus();
  assert.equal(h.app.activeTabId(), "cc:x");
  // 待っている間にほかを開いたら、待つのをやめる
  let ready2 = false;
  const w = loadShell({ status: null, known: (tab) => tab.startsWith("ch:") || (tab === "cc:x" && ready2) });
  w.api.reply = h.api.reply;
  await w.flush();
  await w.topics.load();
  w.press.open("cc:x");
  await w.flush();
  w.app.open("ch:a");
  ready2 = true;
  w.store.status = {};
  w.app.refreshStatus();
  assert.equal(w.app.activeTabId(), "ch:a");
});

test("web static: v3 のシートは幅によらず .more-row の見た目を .v3-sheet の下に持ち、PC は 360px まで・スマホは全幅", () => {
  const css = read("shell.css");
  const app = read("app.css");
  const block = (src: string, sel: string) => {
    const at = src.indexOf(sel + " {");
    assert.ok(at >= 0, sel);
    return src.slice(src.indexOf("{", at) + 1, src.indexOf("}", at)).trim();
  };
  for (const sel of [".more-list", ".more-row", ".more-row:active", "a.more-row", ".more-row:disabled", ".more-row .icon", ".more-row .sb-meta", ".sheet-head", ".sheet-title"]) {
    assert.equal(block(css, "\n.v3-sheet " + sel).replace(/\s+/g, " "), block(app, "\n  " + sel).replace(/\s+/g, " "), sel);
  }
  assert.match(block(css, "\n.v3-sheet"), /width: min\(360px, 100vw - 32px\);/);
  const phoneCss = css.slice(css.indexOf("@media (max-width: 639px)"));
  assert.match(block(phoneCss, "  .v3-sheet"), /width: 100%;/);
});

// ===== 会話を 1 画面に 2 つ描く（chat.js・api.js の「見えている会話」。#357 の M3a） =====
type Frame = {
  title: string;
  placeholder: string;
  ops?: () => DomNode[];
  outgoing?: (text: string) => string;
  replyText?: (text: string) => string;
  replyExtras?: (text: string) => DomNode[];
};
type ChatApi = {
  render: (container: DomNode, channelId: string, frame?: Frame) => void;
  markSeenShown: () => void;
};

const chatTurn = (id: number, kind: string, text: string, o: Record<string, unknown> = {}) => ({ id, kind, text, at: "2026-11-14T00:00:00.000Z", ...o });
const chatChannel = (id: string, o: Record<string, unknown> = {}) => ({ id, kind: "inbox", name: "inbox-" + id, persona: "default", link: null, ...o });

/**
 * ui.js → chat.js → views.js を DomNode の偽の document で読む。会話は store.turns に置き、見えている会話は shown（SA.app.shownChannelIds）。
 * 入れ物は body の下に足す（document.querySelector が body から引く）
 */
function loadChat() {
  const body = new DomNode("body");
  // reading は SA.app.readingChannelIds（null なら shown と同じ）
  const state = { visibility: "visible", shown: [] as string[], reading: null as string[] | null, active: null as string | null };
  const document = {
    get visibilityState() {
      return state.visibility;
    },
    getElementById: (id: string) => (descendants(body).find((n) => n.getAttribute("id") === id) as DomNode | undefined) ?? null,
    createElement: (tag: string) => new DomNode(tag),
    createElementNS: (_ns: string, tag: string) => new DomNode(tag),
    createTextNode: (text: string) => Object.assign(new DomNode("#text"), { text }),
    createDocumentFragment: () => new DomNode("#fragment"),
    querySelector: (sel: string) => body.querySelector(sel),
    querySelectorAll: (sel: string) => body.querySelectorAll(sel),
    addEventListener: () => undefined,
  };
  const touchListeners: Array<() => void> = [];
  const touch = { matches: false, addEventListener: (_t: string, fn: () => void) => touchListeners.push(fn) };
  const context = {
    window: { matchMedia: () => touch } as Record<string, unknown>,
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
  const toasts: string[] = [];
  (SA.ui as { toast: unknown }).toast = (text: string) => toasts.push(text);
  const seen: Array<[string, number]> = [];
  const optimistic: Array<[string, unknown, string]> = [];
  const loads: string[] = [];
  const posts: Array<{ path: string; body: unknown }> = [];
  const refreshes: string[] = [];
  const sheets: Array<{ title: string; items: Array<{ label: string }> }> = [];
  const drafts: Record<string, string> = {};
  const turns: Record<string, { loaded: boolean; missing?: boolean; hasMore: boolean; turns: unknown[]; channel: unknown }> = {};
  const loadResult: Record<string, unknown> = {};
  const store = {
    turns,
    channels: { channels: [] as unknown[], personas: [{ id: "default", name: "既定", isDefault: true }] },
    status: {},
    running: [],
    runningOf: () => null,
    markSeen: (id: string, last: number) => {
      seen.push([id, last]);
      return true;
    },
    addOptimisticTurn: (id: string, turnId: unknown, text: string) => optimistic.push([id, turnId, text]),
    load: {
      turns: (id: string) => {
        loads.push(id);
        return Promise.resolve(loadResult[id] ?? null);
      },
      olderTurns: (id: string) => {
        loads.push("older:" + id);
        return Promise.resolve(null);
      },
      ccSession: () => Promise.resolve(null),
      running: () => Promise.resolve(null),
      // 操作の後の読み直し（reloadAfterOp）
      channels: () => {
        loads.push("channels");
        return Promise.resolve(null);
      },
    },
  };
  SA.store = store;
  SA.app = {
    shownChannelIds: () => state.shown,
    readingChannelIds: () => state.reading ?? state.shown,
    activeTabId: () => state.active,
    refresh: (tab: string) => refreshes.push(tab),
    refreshSidebar: () => undefined,
    refreshStatus: () => undefined,
    draft: (id: string) => drafts[id] ?? "",
    setDraft: (id: string, text: string) => {
      drafts[id] = text;
    },
    sheet: (title: string, items: Array<{ label: string }>) => sheets.push({ title, items }),
  };
  SA.api = {
    post: (path: string, b: unknown) => {
      posts.push({ path, body: b });
      return Promise.resolve({ turnId: 9 });
    },
  };
  SA.events = { emit: () => undefined, on: () => undefined };
  SA.poll = { running: () => undefined, kickCc: () => undefined };
  vm.runInNewContext(read("chat.js"), context);
  vm.runInNewContext(read("views.js"), context);
  const box = () => {
    const n = new DomNode("div");
    n.setAttribute("class", "ed");
    body.append(n);
    return n;
  };
  const put = (id: string, list: unknown[], ch: Record<string, unknown> = {}) => {
    turns[id] = { loaded: true, hasMore: false, turns: list, channel: chatChannel(id, ch) };
  };
  const flush = async () => {
    for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r));
  };
  return {
    chat: SA.chat as ChatApi,
    ui: SA.ui as { el: (tag: string, props?: Record<string, unknown>, children?: unknown[]) => DomNode },
    context,
    store,
    state,
    seen,
    optimistic,
    loads,
    loadResult,
    posts,
    refreshes,
    sheets,
    drafts,
    toasts,
    touch,
    touchListeners,
    box,
    put,
    flush,
  };
}

const inputOf = (box: DomNode) => box.querySelector("textarea.composer-input") as DomNode & { value: string; placeholder?: string };
const formOf = (box: DomNode) => box.querySelector("form.composer")!;
const counterOf = (box: DomNode) => box.querySelector("span.counter")!;
const sendOf = (box: DomNode) => formOf(box).buttons().find((b) => b.textContent === "送る") as DomNode & { disabled: boolean };
const typeIn = (box: DomNode, text: string) => {
  const ta = inputOf(box);
  ta.value = text;
  ta.dispatch("input");
};

test("web static: SA.app.shownChannelIds は 2 つの殻にあり、前に出ている会話のタブのチャンネルだけを返す（会話でないタブ・[端末] の間は空）", () => {
  // 今の殻（workbench.js）: S.active で決まる
  const wb = read("workbench.js");
  const run = (active: string | null) => {
    const ctx: Record<string, unknown> = { S: { active } };
    vm.runInNewContext(fnSource(wb, "shownChannelIds") + "\nresult = shownChannelIds();", ctx);
    return JSON.parse(JSON.stringify(ctx.result)) as string[];
  };
  assert.deepEqual(run("ch:111"), ["111"]);
  assert.deepEqual(run("tasks"), []);
  assert.deepEqual(run("cc:s1"), []);
  assert.deepEqual(run(null), []);
  assert.ok(appKeys(wb).includes("shownChannelIds"));
  // 新しい殻（shell.js）: 列 2 に出しているタブ。[端末] の間は cc: なので空
  const w = loadShell();
  const app = w.app as ShellApp & { shownChannelIds: () => string[] };
  const ids = () => JSON.parse(JSON.stringify(app.shownChannelIds())) as string[];
  assert.deepEqual(ids(), []);
  app.open("ch:222");
  assert.deepEqual(ids(), ["222"]);
  app.open("tasks");
  assert.deepEqual(ids(), []);
  const sh = read("shell.js");
  const ctx: Record<string, unknown> = { S: { view2: "pane", active: "ch:333" }, paneSession: () => "s1", handVisible: () => false, handChannelId: () => null };
  vm.runInNewContext(fnSource(sh, "shownTabId") + fnSource(sh, "shownChannelIds") + "\nresult = shownChannelIds();", ctx);
  assert.deepEqual(JSON.parse(JSON.stringify(ctx.result)), []);
  (ctx.S as { view2: string }).view2 = "talk";
  vm.runInNewContext("result = shownChannelIds();", ctx);
  assert.deepEqual(JSON.parse(JSON.stringify(ctx.result)), ["333"]);
});

test("web static: 既読は読んでいる会話（readingChannelIds）の全部に付け、入っていない会話・隠れた画面では付けない", () => {
  const c = loadChat();
  c.put("1", [chatTurn(10, "owner", "a"), chatTurn(11, "agent", "b")]);
  c.put("2", [chatTurn(20, "agent", "c")]);
  c.put("3", [chatTurn(30, "agent", "d")]);
  c.state.shown = ["1", "2", "3"];
  c.state.reading = ["1", "2"];
  c.chat.markSeenShown();
  assert.deepEqual(c.seen, [["1", 11], ["2", 20]]);
  // 描いた会話でも、見えていなければ付けない
  c.seen.length = 0;
  c.chat.render(c.box(), "3");
  assert.deepEqual(c.seen, []);
  c.chat.render(c.box(), "2");
  assert.deepEqual(c.seen, [["2", 20]]);
  // 画面が隠れていれば、見えている会話にも付けない
  c.seen.length = 0;
  c.state.visibility = "hidden";
  c.chat.markSeenShown();
  c.chat.render(c.box(), "1");
  assert.deepEqual(c.seen, []);
  assert.equal("markSeenActive" in c.chat, false);
});

test("web static: shownChannelIds に入っていても readingChannelIds に無い会話には、render でも markSeenShown でも既読を付けない（M7b）", () => {
  const c = loadChat();
  c.put("1", [chatTurn(10, "agent", "a")]);
  c.put("900", [chatTurn(90, "agent", "b")]);
  // スマホで一覧を出している間・重ねた右腕の下: 列 2 の会話は見えている扱い（polling・音）だが、読んでいない
  c.state.shown = ["1", "900"];
  c.state.reading = ["900"];
  c.chat.render(c.box(), "1");
  c.chat.markSeenShown();
  assert.deepEqual(c.seen, [["900", 90]]);
  // 読む側に入ったら付く
  c.seen.length = 0;
  c.state.reading = ["1", "900"];
  c.chat.markSeenShown();
  assert.deepEqual(c.seen, [["1", 10], ["900", 90]]);
  const chat = read("chat.js");
  assert.match(fnSource(chat, "markSeen"), /SA\.app\.readingChannelIds\(\)\.includes\(channelId\)/);
  assert.doesNotMatch(fnSource(chat, "markSeen") + fnSource(chat, "markSeenShown"), /shownChannelIds/);
});

test("web static: 会話を 2 つの入れ物に描いても混ざらない", async () => {
  const c = loadChat();
  c.put("1", [chatTurn(10, "agent", "一つ目の返事")]);
  c.put("2", [chatTurn(20, "agent", "二つ目の返事")]);
  c.state.shown = ["1", "2"];
  const a = c.box();
  const b = c.box();
  c.chat.render(a, "1");
  c.chat.render(b, "2", { title: "右腕", placeholder: "右腕に頼む・訊く" });
  assert.match(a.textContent, /一つ目の返事/);
  assert.doesNotMatch(a.textContent, /二つ目/);
  assert.match(b.textContent, /二つ目の返事/);
  assert.doesNotMatch(b.textContent, /一つ目/);
  // 書きかけはチャンネルごと
  typeIn(a, "Aへ");
  typeIn(b, "Bへ");
  assert.deepEqual({ ...c.drafts }, { "1": "Aへ", "2": "Bへ" });
  // 片方を描き直しても、もう片方の入力欄は同じ要素のまま（自分の入力欄も作り直さない）
  const taA = inputOf(a);
  const taB = inputOf(b);
  c.store.turns["2"]!.turns.push(chatTurn(21, "agent", "続き"));
  c.chat.render(b, "2", { title: "右腕", placeholder: "右腕に頼む・訊く" });
  assert.equal(inputOf(a), taA);
  assert.equal(inputOf(b), taB);
  assert.equal(taA.value, "Aへ");
  // それぞれの入力欄は自分のチャンネルに送る
  formOf(a).dispatch("submit", { preventDefault() {} });
  formOf(b).dispatch("submit", { preventDefault() {} });
  await c.flush();
  assert.deepEqual(
    c.posts.map((p) => [p.path, (p.body as { text: string }).text]),
    [
      ["/api/channels/1/messages", "Aへ"],
      ["/api/channels/2/messages", "Bへ"],
    ],
  );
  assert.deepEqual(c.optimistic.map((o) => [o[0], o[2]]), [
    ["1", "Aへ"],
    ["2", "Bへ"],
  ]);
  assert.deepEqual({ ...c.drafts }, { "1": "", "2": "" });
});

test("web static: frame の無い描画は今と同じ見出しと入力欄で、frame のある描画は題・placeholder・足したボタンを使い [‹] を出さない", () => {
  const c = loadChat();
  c.put("1", [chatTurn(10, "agent", "x")], { link: "https://discord.com/channels/1/1" });
  const plain = c.box();
  c.chat.render(plain, "1");
  const head = plain.querySelector("header.ed-toolbar")!;
  assert.ok(head.querySelector("button.ed-back"), "frame が無ければ [‹]");
  assert.equal(head.querySelector("h1")!.textContent, "inbox-1");
  assert.ok(head.querySelector("a.btn"), "Discord のリンクのボタン");
  const ta = inputOf(plain);
  assert.equal(ta.getAttribute("placeholder"), "#inbox-1 に送る");
  assert.equal(ta.getAttribute("aria-label"), "#inbox-1 に送る");
  assert.equal(ta.getAttribute("data-placeholder"), null);
  // frame のある描画
  let opsCalls = 0;
  const frame: Frame = {
    title: "右腕",
    placeholder: "右腕に頼む・訊く",
    ops: () => {
      opsCalls++;
      return [c.ui.el("button", { class: "btn btn-ghost btn-sm", id: "fold", type: "button", text: "畳む" })];
    },
  };
  const framed = c.box();
  c.chat.render(framed, "1", frame);
  const fh = framed.querySelector("header.ed-toolbar")!;
  assert.equal(fh.getAttribute("data-channel"), "1");
  assert.equal(fh.querySelector("button.ed-back"), null, "[‹] を出さない");
  assert.equal(fh.querySelector("a"), null, "リンクのボタンを出さない");
  assert.equal(fh.querySelector("span.badge"), null, "バッジを出さない");
  assert.equal(fh.querySelector("div.ed-title")!.children.length, 1, "題の欄は h1 だけ（アイコンを置かない）");
  assert.equal(fh.querySelector("h1")!.textContent, "右腕");
  const ops = fh.querySelector("div.ed-ops")!;
  const more = ops.querySelector("button.ed-ops-more")!;
  assert.equal(more.getAttribute("aria-label"), "ほかの操作");
  // 足したボタンは .ed-ops の外
  const fold = fh.buttons().find((b) => b.getAttribute("id") === "fold");
  assert.ok(fold);
  assert.equal(ops.contains(fold), false);
  assert.equal(opsCalls, 1);
  more.dispatch("click");
  assert.equal(c.sheets.length, 1);
  assert.equal(c.sheets[0]!.title, "右腕 の操作");
  assert.deepEqual(JSON.parse(JSON.stringify(c.sheets[0]!.items.map((i) => i.label))), ["会話を新しくする", "Discord で開く"]);
  const fta = inputOf(framed);
  assert.equal(fta.getAttribute("placeholder"), "右腕に頼む・訊く");
  assert.equal(fta.getAttribute("aria-label"), "右腕に頼む・訊く");
  assert.equal(fta.getAttribute("data-placeholder"), "右腕に頼む・訊く");
  // 外付けのキーボードの付け外し: frame の placeholder は保ち、frame の無い入力欄は「<題名> に送る」
  fta.placeholder = "x";
  ta.placeholder = "x";
  for (const fn of c.touchListeners) fn();
  assert.equal(fta.placeholder, "右腕に頼む・訊く");
  assert.equal(ta.placeholder, "#inbox-1 に送る");
  // Discord のリンクが無ければシートは「会話を新しくする」だけ
  c.put("2", [chatTurn(20, "agent", "y")]);
  const nolink = c.box();
  c.chat.render(nolink, "2", frame);
  nolink.querySelector("button.ed-ops-more")!.dispatch("click");
  assert.deepEqual(JSON.parse(JSON.stringify(c.sheets[1]!.items.map((i) => i.label))), ["会話を新しくする"]);
  // 一覧がまだ（読み込み中でチャンネルが引けない）なら h1 と足したボタンだけ
  const loading = c.box();
  c.chat.render(loading, "3", frame);
  const lh = loading.querySelector("header.ed-toolbar")!;
  assert.equal(lh.querySelector("h1")!.textContent, "右腕");
  assert.equal(lh.querySelector("button.ed-ops-more"), null);
  assert.deepEqual(lh.buttons().map((b) => b.getAttribute("id")), ["fold"]);
  assert.equal(lh.querySelector("button.ed-back"), null);
});

type ChatHead = { title: string; status: { text: string; tone: string } | null; note: string | null; menu: Array<{ label: string; run?: (() => void) | null; why?: string; href?: string }> };
const chatHead = (c: ReturnType<typeof loadChat>, id: string) => (c.chat as unknown as { head: (id: string) => ChatHead | null }).head(id);
const plainHead = (h: ChatHead | null) => JSON.parse(JSON.stringify(h && { title: h.title, status: h.status, note: h.note })) as unknown;

test("web static: SA.chat.head は見出しの題・状態・札の文を返す（セッションは待ち・完了だけ、Claude Code は 4 つの状態、引けなければ null）", () => {
  const c = loadChat();
  c.put("1", [], { kind: "session", title: "調べ物", state: "active" });
  assert.deepEqual(plainHead(chatHead(c, "1")), { title: "調べ物", status: null, note: null });
  c.put("2", [], { kind: "session", title: "待つ物", state: "waiting" });
  assert.deepEqual(plainHead(chatHead(c, "2")), { title: "待つ物", status: { text: "待ち", tone: "muted" }, note: null });
  c.put("3", [], { kind: "session", title: "", state: "done" });
  assert.deepEqual(plainHead(chatHead(c, "3")), { title: "セッション", status: { text: "完了", tone: "muted" }, note: null });
  const tones: Array<[string, string, string]> = [
    ["needs_input", "判断待ち", "warning"],
    ["running", "実行中", "accent"],
    ["idle", "待機", "muted"],
    ["ended", "終わりました", "muted"],
  ];
  for (const [state, text, tone] of tones) {
    c.put("cc-" + state, [], { kind: "cc", name: "work", cc: { state } });
    assert.deepEqual(plainHead(chatHead(c, "cc-" + state)), { title: "work", status: { text, tone }, note: null }, state);
  }
  c.put("cc-none", [], { kind: "cc", name: "", cc: {} });
  assert.deepEqual(plainHead(chatHead(c, "cc-none")), { title: "Claude Code", status: null, note: null });
  c.put("4", []);
  assert.deepEqual(plainHead(chatHead(c, "4")), { title: "#inbox-4", status: null, note: null });
  // 人格が 2 つ以上のときだけ札の文（Claude Code のチャンネルには出さない）
  c.store.channels.personas.push({ id: "p2", name: "二号", isDefault: false });
  assert.equal(chatHead(c, "4")!.note, "既定");
  c.put("5", [], { persona: "p2" });
  assert.equal(chatHead(c, "5")!.note, "二号（人格）");
  assert.equal(chatHead(c, "cc-idle")!.note, null);
  assert.equal(chatHead(c, "nothing"), null);
});

test("web static: SA.chat.head の menu は見出しの […] の板と同じ行で、Claude Code は「画面を見る」⇄「画面を閉じる」が Discord の前に入る", () => {
  const c = loadChat();
  c.put("1", [chatTurn(10, "agent", "x")], { kind: "session", title: "調べ物", state: "active", link: "https://discord.com/channels/1/1", project: { slug: "p", url: "https://example.com/p" } });
  const box = c.box();
  c.chat.render(box, "1");
  box.querySelector("button.ed-ops-more")!.dispatch("click");
  const items = (list: unknown) => JSON.parse(JSON.stringify(list)) as unknown;
  assert.deepEqual(items(chatHead(c, "1")!.menu), items(c.sheets[0]!.items));
  assert.deepEqual(items(chatHead(c, "1")!.menu.map((i) => i.label)), ["待ちにする", "閉じる", "会話を新しくする", "ページを開く", "Discord で開く"]);
  // Claude Code: 見出しの […] は画面の行を入れない。head の menu は入れる
  c.put("9", [], { kind: "cc", name: "work", cc: { state: "idle" }, link: "https://discord.com/channels/1/9" });
  const cc = c.box();
  c.chat.render(cc, "9");
  cc.querySelector("button.ed-ops-more")!.dispatch("click");
  assert.deepEqual(items(c.sheets[1]!.items.map((i) => i.label)), ["Discord で開く", "閉じる"]);
  const menu = chatHead(c, "9")!.menu;
  assert.deepEqual(items(menu.map((i) => i.label)), ["画面を見る", "Discord で開く", "閉じる"]);
  menu[0]!.run!();
  assert.deepEqual(items(c.refreshes), ["ch:9"]);
  assert.deepEqual(items(chatHead(c, "9")!.menu.map((i) => i.label)), ["画面を閉じる", "Discord で開く", "閉じる"]);
  chatHead(c, "9")!.menu[0]!.run!();
  assert.equal(chatHead(c, "9")!.menu[0]!.label, "画面を見る");
  // 終わったチャンネルの「閉じる」は押せない
  c.put("8", [], { kind: "cc", name: "old", cc: { state: "ended" } });
  const close = chatHead(c, "8")!.menu.find((i) => i.label === "閉じる")!;
  assert.equal(close.run, null);
  assert.equal(close.why, "閉じています");
});

test("web static: frame の outgoing は送る本文・字数・仮の行に効き、入力欄が空なら 0 字のまま", async () => {
  const c = loadChat();
  c.put("1", []);
  const prefix = "（いま見ている話題: 話）\n";
  const frame: Frame = { title: "右腕", placeholder: "右腕に頼む・訊く", outgoing: (t) => prefix + t };
  const b = c.box();
  c.chat.render(b, "1", frame);
  assert.equal(counterOf(b).textContent, "0 / 1,900");
  assert.equal(sendOf(b).disabled, true);
  typeIn(b, "  ");
  assert.equal(counterOf(b).textContent, "0 / 1,900", "空白だけなら 0 字");
  assert.equal(sendOf(b).disabled, true);
  typeIn(b, " 頼む ");
  assert.equal(counterOf(b).textContent, (prefix.length + 2).toLocaleString("en-US") + " / 1,900");
  assert.equal(sendOf(b).disabled, false);
  formOf(b).dispatch("submit", { preventDefault() {} });
  await c.flush();
  assert.deepEqual(JSON.parse(JSON.stringify(c.posts.map((p) => p.body))), [{ text: prefix + "頼む" }]);
  assert.deepEqual(c.optimistic.map((o) => o[2]), [prefix + "頼む"]);
  assert.equal(inputOf(b).value, "", "送れたら入力欄を空にする（比べるのは差し替える前の本文）");
  // 差し替えた後で 1,900 字を超えれば送らない
  typeIn(b, "あ".repeat(1900 - prefix.length + 1));
  assert.ok(counterOf(b).classes.has("is-over"));
  formOf(b).dispatch("submit", { preventDefault() {} });
  await c.flush();
  assert.equal(c.posts.length, 1);
  assert.deepEqual(c.toasts, ["1,900 字までです"]);
  // frame が無ければ入力欄のまま
  const p = c.box();
  c.put("2", []);
  c.chat.render(p, "2");
  typeIn(p, " そのまま ");
  assert.equal(counterOf(p).textContent, "4 / 1,900");
  formOf(p).dispatch("submit", { preventDefault() {} });
  await c.flush();
  assert.deepEqual(JSON.parse(JSON.stringify(c.posts[1]!.body)), { text: "そのまま" });
});

test("web static: frame の replyText・replyExtras は Bot の返事だけに効く（オーナーの行・知らせ・区切りには効かない）", () => {
  const c = loadChat();
  const rows = [
    chatTurn(1, "owner", "オーナーの<#1>"),
    chatTurn(2, "notice", "知らせの<#1>"),
    chatTurn(3, "divider", "区切りの<#1>"),
    chatTurn(4, "agent", "返事の<#1>", { persona: "default", outcome: "done", durationMs: 1000, toolCalls: 0, steps: [] }),
  ];
  c.put("1", rows);
  const seenTexts: string[] = [];
  const frame: Frame = {
    title: "右腕",
    placeholder: "右腕に頼む・訊く",
    replyText: (t) => t.replace("<#1>", "「題」"),
    replyExtras: (t) => {
      seenTexts.push(t);
      return [c.ui.el("div", { class: "v3-card", text: "札" })];
    },
  };
  const b = c.box();
  c.chat.render(b, "1", frame);
  const owner = b.querySelector("article.msg-owner")!;
  const agent = b.querySelector("article.msg-agent")!;
  assert.match(owner.textContent, /オーナーの<#1>/);
  assert.match(b.querySelector("div.tl-notice")!.textContent, /知らせの<#1>/);
  assert.match(b.querySelector("div.tl-divider")!.textContent, /区切りの<#1>/);
  assert.match(agent.textContent, /返事の「題」/);
  assert.doesNotMatch(agent.textContent, /<#1>/);
  // 足す要素は返事の吹き出しの下（元の本文を渡す）。ほかの行には付かない
  assert.deepEqual(seenTexts, ["返事の<#1>"]);
  assert.equal(b.querySelectorAll("div.v3-card").length, 1);
  assert.equal(agent.children[agent.children.length - 1]!.classes.has("v3-card"), true);
  // 元の行は書き換えない
  assert.equal((c.store.turns["1"]!.turns[3] as { text: string }).text, "返事の<#1>");
  // frame が無ければ本文のまま・足す要素も無い
  const p = c.box();
  c.chat.render(p, "1");
  assert.match(p.querySelector("article.msg-agent")!.textContent, /返事の<#1>/);
  assert.equal(p.querySelectorAll("div.v3-card").length, 0);
});

test("web static: 前の会話を読んだ後の位置は data-channel で引いた入れ物で保つ（#ed に寄らない）", async () => {
  const c = loadChat();
  c.put("1", [chatTurn(10, "agent", "a")]);
  c.put("2", [chatTurn(20, "agent", "b")]);
  c.store.turns["2"]!.hasMore = true;
  c.state.shown = ["1", "2"];
  // 前に出ているタブ（#ed）は 1 の会話。2 の会話は id の無い別の入れ物
  const ed = c.box();
  ed.setAttribute("id", "ed");
  c.state.active = "ch:1";
  c.chat.render(ed, "1");
  const other = c.box();
  c.chat.render(other, "2");
  const s1 = ed.querySelector(".ed-scroll")!;
  const s2 = other.querySelector(".ed-scroll")!;
  s1.scrollHeight = 1000;
  s1.clientHeight = 200;
  s1.scrollTop = 500;
  s2.scrollHeight = 1000;
  s2.clientHeight = 200;
  s2.scrollTop = 10;
  // 読んだ後に前の行の分だけ高くなる（描き直しは SA.app.refresh の担当なので、ここでは高さだけ変える）
  (c.store.load as { olderTurns: (id: string) => Promise<null> }).olderTurns = (id: string) => {
    c.loads.push("older:" + id);
    s2.scrollHeight = 1600;
    return Promise.resolve(null);
  };
  s2.dispatch("scroll");
  await c.flush();
  assert.deepEqual(c.loads, ["older:2"]);
  assert.deepEqual(c.refreshes, ["ch:2"]);
  assert.equal(s2.scrollTop, 610, "2 の会話の位置を前の行の分だけ下げる");
  assert.equal(s1.scrollTop, 500, "#ed の会話は動かさない");
});

test("web static: /turns の polling は見えている会話を全部読み、どれかが許可を保留していれば 3 秒", async () => {
  const js = read("api.js");
  assert.doesNotMatch(js, /markSeenActive|activeTurns/);
  assert.match(js, /turns: \{ base: \(\) => \(activePermissionPending\(\) \? CC_PERMISSION_INTERVAL_MS : TURNS_INTERVAL_MS\), run: shownTurns,/);
  const shown = { ids: [] as string[] };
  const loads: string[] = [];
  const results: Record<string, unknown> = {};
  const store = {
    turns: {} as Record<string, unknown>,
    load: {
      turns: (id: string, opts: unknown) => {
        loads.push(id + ":" + JSON.stringify(opts));
        return Promise.resolve(results[id] ?? null);
      },
    },
  };
  const ctx: Record<string, unknown> = { SA: { app: { shownChannelIds: () => shown.ids } }, store, Promise };
  vm.runInNewContext(fnSource(js, "activePermissionPending") + fnSource(js, "shownTurns") + "\nthis.pending = activePermissionPending; this.turns = shownTurns;", ctx);
  const pending = ctx.pending as () => boolean;
  const turns = ctx.turns as (opts: unknown) => Promise<unknown>;
  // 見えている会話が無ければ読まない
  assert.equal(await turns({ quiet: true }), null);
  assert.deepEqual(loads, []);
  assert.equal(pending(), false);
  // 見えている全部を読み、全部成功なら null・どれかが失敗ならその最初の error
  shown.ids = ["1", "2", "3"];
  assert.equal(await turns({ quiet: true }), null);
  assert.deepEqual(loads, ['1:{"quiet":true}', '2:{"quiet":true}', '3:{"quiet":true}']);
  const e2 = { toast: "2" };
  results["2"] = e2;
  results["3"] = { toast: "3" };
  assert.equal(await turns({ quiet: true }), e2);
  // 許可の保留は見えているどれか
  store.turns["1"] = { channel: { permission: null } };
  store.turns["3"] = { channel: { permission: { state: "pending" } } };
  assert.equal(pending(), true);
  shown.ids = ["1", "2"];
  assert.equal(pending(), false);
  store.turns["2"] = { channel: { permission: { state: "allowed" } } };
  assert.equal(pending(), false);
});

/** api.js をまるごと偽の window・document で読む。SA.api.get は get（呼ばれた path を渡す）、timer は動かさない */
function loadApi(get: (path: string) => Promise<unknown>) {
  const calls = { refreshes: [] as string[], markSeenShown: 0 };
  const listeners: Record<string, () => void> = {};
  const state = { visibility: "visible" };
  const SA: Record<string, unknown> = {
    app: {
      shownChannelIds: () => ["1", "2"],
      activeTabId: () => "ch:1",
      refresh: (tab: string) => calls.refreshes.push(tab),
      refreshStatus: () => undefined,
      refreshSidebar: () => undefined,
      refreshActivity: () => undefined,
    },
    chat: {
      markSeenShown: () => {
        calls.markSeenShown++;
      },
    },
    ui: { toast: () => undefined },
  };
  const ctx: Record<string, unknown> = {
    window: { SA, localStorage: { getItem: () => null, setItem: () => undefined }, addEventListener: () => undefined },
    document: {
      get visibilityState() {
        return state.visibility;
      },
      addEventListener: (type: string, fn: () => void) => {
        listeners[type] = fn;
      },
    },
    setTimeout: () => 0,
    clearTimeout: () => undefined,
    Promise,
  };
  vm.runInNewContext(read("api.js"), ctx);
  (SA.api as { get: (path: string) => Promise<unknown> }).get = get;
  return { SA, calls, state, listeners };
}

test("web static: /api/status でタイムゾーンが変わったら、前に出ているタブでない見えている会話も描き直す（変わらなければ描き直さない）", async () => {
  const zone = { value: "Asia/Tokyo" };
  const h = loadApi(() => Promise.resolve({ timeZone: zone.value }));
  const load = (h.SA.store as { load: { status: () => Promise<unknown> } }).load;
  const convs = () => h.calls.refreshes.filter((t) => t.startsWith("ch:"));
  // 1 回目（まだ読んでいない → 来た）
  assert.equal(await load.status(), null);
  assert.deepEqual(convs(), ["ch:1", "ch:2"]);
  // 同じ zone なら会話は描き直さない
  h.calls.refreshes.length = 0;
  assert.equal(await load.status(), null);
  assert.deepEqual(convs(), []);
  // 変わったら ch:1（前のタブ）と ch:2（見えている会話）に 1 回ずつ
  zone.value = "UTC";
  assert.equal(await load.status(), null);
  assert.deepEqual(convs(), ["ch:1", "ch:2"]);
});

test("web static: schedule（polling の始め・見えるようになったとき）は見えている会話を既読にし、隠れたときはしない", () => {
  const h = loadApi(() => new Promise(() => undefined));
  (h.SA.poll as { start: () => void }).start();
  assert.equal(h.calls.markSeenShown, 1);
  h.state.visibility = "hidden";
  h.listeners.visibilitychange!();
  assert.equal(h.calls.markSeenShown, 1);
  h.state.visibility = "visible";
  h.listeners.visibilitychange!();
  assert.equal(h.calls.markSeenShown, 2);
});

// ===== M2b のレビューの直し =====
test("web static: v3 のシートを開くと、最初の押せる行に焦点がある（× でも押せない行でもない）", async () => {
  const h = loadShell();
  await h.flush();
  const sheet = (h.app as unknown as { sheet: (label: string, items: unknown[], opener?: unknown) => void }).sheet;
  sheet("操作", [{ label: "押せない", why: "理由" }, { label: "押せる", run: () => {} }, { label: "次", run: () => {} }]);
  const rows = h.nodes.sheet.querySelectorAll("button.more-row");
  assert.equal(rows[0]!.getAttribute("disabled"), "");
  assert.equal(h.document.activeElement, rows[1]);
  // 先頭が押せれば先頭
  sheet("操作", [{ label: "一", run: () => {} }, { label: "二", run: () => {} }]);
  assert.equal(h.document.activeElement, h.nodes.sheet.querySelectorAll("button.more-row")[0]);
});

test("web static: 絞り込み欄で IME の変換中の Escape は絞り込みを閉じない（変換中でなければ閉じる）", async () => {
  const h = loadShell();
  await h.flush();
  kids(h.nodes.headOps)[0]!.dispatch("click");
  const input = h.document.getElementById("v3-search")!;
  (input as unknown as { value: string }).value = "かい";
  input.dispatch("input");
  for (const o of [{ isComposing: true }, { keyCode: 229 }]) {
    h.fireDoc("keydown", keyEvent("Escape", input, o));
    assert.equal(h.nodes.searchBox.hidden, false, JSON.stringify(o));
    assert.equal((input as unknown as { value: string }).value, "かい");
    assert.equal(h.document.activeElement, input);
  }
  h.fireDoc("keydown", keyEvent("Escape", input));
  assert.equal(h.nodes.searchBox.hidden, true);
  assert.equal((input as unknown as { value: string }).value, "");
});

test("web static: [端末] → [会話] に戻すと会話の onOpen（turns の読み直し）を 1 回呼ぶ。押し直しでは呼ばない", async () => {
  const h = loadShell();
  h.api.reply = () => Promise.resolve(v3Result([v3Topic("ch:a", { origin: "cc", sessionId: "s1" })]));
  await h.flush();
  await h.topics.load();
  h.app.open("ch:a");
  const [talk, pane] = kids(h.nodes.views);
  const count = (tab: string) => h.opens.filter((t) => t === tab).length;
  talk!.dispatch("click");
  assert.equal(count("ch:a"), 1, "同じ view の押し直しでは呼ばない");
  pane!.dispatch("click");
  assert.equal(count("cc:s1"), 1);
  assert.equal(count("ch:a"), 1);
  talk!.dispatch("click");
  assert.equal(count("ch:a"), 2);
  assert.equal(count("cc:s1"), 1);
  assert.deepEqual(h.closes, []);
});

test("web static: スマホで一覧に戻っている間に [端末] が出せなくなったら、次に会話の列を出したとき下端", async () => {
  const h = loadShell({ phone: true });
  const topics = [v3Topic("ch:a", { origin: "cc", sessionId: "s1" })];
  h.api.reply = () => Promise.resolve(v3Result(topics));
  await h.flush();
  await h.topics.load();
  h.app.open("ch:a");
  kids(h.nodes.views)[1]!.dispatch("click");
  assert.equal(h.app.activeTabId(), "cc:s1");
  h.scroll().scrollTop = 100;
  h.history.back();
  assert.equal(h.nodes.v3.getAttribute("data-view"), "list");
  topics[0] = v3Topic("ch:a", { origin: "cc", sessionId: null });
  await h.topics.load();
  assert.equal(h.app.activeTabId(), "ch:a");
  h.history.forward();
  assert.equal(h.nodes.v3.getAttribute("data-view"), "body");
  assert.equal(h.scroll().scrollTop, 800);
});

test("web static: v3 のシートの余白は .more-sheet と同じで、スマホは下の安全域を足す。PC は行に hover", () => {
  const css = read("shell.css");
  const app = read("app.css");
  const block = (src: string, sel: string) => {
    const at = src.indexOf(sel + " {");
    assert.ok(at >= 0, sel);
    return src.slice(src.indexOf("{", at) + 1, src.indexOf("}", at));
  };
  const padding = (b: string) => /\n\s*padding: ([^;]+);/.exec(b)?.[1];
  assert.equal(padding(block(css, "\n.v3-sheet")), padding(block(app, "\n  .more-sheet")));
  assert.equal(padding(block(css, "\n.v3-sheet")), "var(--space-2) 0");
  const phoneCss = css.slice(css.indexOf("@media (max-width: 639px)"));
  assert.match(block(phoneCss, "  .v3-sheet"), /padding-bottom: calc\(var\(--space-2\) \+ env\(safe-area-inset-bottom, 0px\)\);/);
  const hover = css.slice(css.indexOf("@media (hover: hover) and (pointer: fine)"));
  assert.match(block(hover, "  .v3-sheet .more-row:not(:disabled):hover"), /background: var\(--muted\);/);
  assert.ok(hover.indexOf(".v3-sheet .more-row:not(:disabled):hover") < hover.indexOf("\n}"), "hover の media の中");
});

// ===== 右腕の枠（M3b。#357） =====
const v3Hand = (o: Record<string, unknown> = {}) => ({ id: "ch:900", guildId: "g1", title: "右腕", turn: null, last: null, link: "https://discord.com/channels/1/900", ...o });
type HandShell = ReturnType<typeof loadShell> & { app: ShellApp & { shownChannelIds: () => string[] } };

/** 右腕（ch:900）のある一覧を読ませた殻 */
async function loadHand(opts: Parameters<typeof loadShell>[0] = {}, topics: unknown[] = [], o: Record<string, unknown> = {}): Promise<HandShell> {
  const h = loadShell(opts) as HandShell;
  await h.flush();
  h.api.reply = () => Promise.resolve(v3Result(topics, { rightHands: [v3Hand(), v3Hand({ id: "ch:901", guildId: "g2" })], ...o }));
  await h.topics.load();
  return h;
}
const handClose = (h: HandShell) => h.document.getElementById("v3-hand-close") as DomNode;
const shownIds = (h: HandShell) => JSON.parse(JSON.stringify(h.app.shownChannelIds())) as string[];
const handOf = (h: HandShell) => h.nodes.v3.getAttribute("data-hand");

test("web static: 「あなたの番」の先頭が右腕でも、次の話題のボタン（nextId）を押すたびに先へ進む", async () => {
  const h = loadShell();
  const turn = { kind: "permission", since: "2026-11-14T00:00:00Z", summary: null };
  h.api.reply = () =>
    Promise.resolve(
      v3Result([v3Topic("ch:a", { mark: "turn", turn }), v3Topic("ch:b", { mark: "turn", turn })], {
        rightHands: [v3Hand({ turn })],
        turnIds: ["ch:900", "ch:a", "ch:b"],
        turns: 3,
      }),
    );
  await h.flush();
  await h.topics.load();
  const pressed: string[] = [];
  for (let i = 0; i < 3; i++) {
    const id = h.model().turns!.nextId!;
    pressed.push(id);
    h.press.open(id, false);
    await h.flush();
  }
  assert.deepEqual(pressed, ["ch:900", "ch:a", "ch:b"]);
  assert.equal(h.listState().turnFrom, "ch:b");
});

test("web static: 右腕は rightHands の先頭の #inbox で、列 2 には同じチャンネルを開かない（「あなたの番」の右腕の行・hash で開いても右腕が開く）", async () => {
  // hash で開いた右腕のチャンネルは、一覧が読めた時点で列 2 から右腕へ移る
  const h = loadShell({ hash: "#/ch/900" }) as HandShell;
  await h.flush();
  assert.equal(h.app.activeTabId(), "ch:900", "一覧の前は列 2 に開く");
  h.store.load.turns = (id: string) => {
    h.loads.turns.push(id);
    return Promise.resolve(null);
  };
  const turn = { kind: "confirm", since: "2026-11-14T00:00:00.000Z", summary: null };
  h.api.reply = () => Promise.resolve(v3Result([], { rightHands: [v3Hand({ turn }), v3Hand({ id: "ch:901" })], turnIds: ["ch:900"], turns: 1 }));
  await h.topics.load();
  assert.equal(h.app.activeTabId(), null);
  assert.equal(h.location.hash, "");
  assert.match(h.nodes.ed.textContent, /左の一覧から話題を選んでください/);
  assert.equal(handOf(h), "open");
  assert.equal(h.handRenders.at(-1)!.id, "900", "先頭の 1 つ");
  assert.deepEqual(h.loads.turns, ["900"], "最初の 1 回だけ読む");
  assert.equal(h.document.activeElement, handClose(h));
  // 「あなたの番」の右腕の行を押しても列 2 には開かない（一覧の選んでいる印も付けない）
  h.app.open("ch:a");
  assert.equal(h.turnOf("ch:900")!.title, "右腕");
  const before = h.rendered.length;
  h.press.open("ch:900");
  h.topics.render();
  assert.equal(h.app.activeTabId(), "ch:a");
  assert.equal(h.rendered.length, before);
  assert.equal(h.turnOf("ch:900")!.current, false);
  assert.equal(h.document.activeElement, handClose(h));
  // 右腕が無ければ（/setup の前）列 3 に案内の文
  const none = loadShell() as HandShell;
  await none.flush();
  assert.match(none.nodes.handEd.textContent, /右腕はまだありません。Discord で \/setup を実行すると、ここで頼めます。/);
  assert.equal(none.handRenders.length, 0);
  assert.deepEqual(shownIds(none), []);
});

test("web static: 新しい殻の shownChannelIds は列 2 の会話と見えている右腕で、畳む・閉じると右腕を外す", async () => {
  const h = await loadHand();
  h.app.open("ch:1");
  assert.deepEqual(shownIds(h), ["1", "900"]);
  handClose(h).dispatch("click");
  assert.equal(handOf(h), "closed");
  assert.deepEqual(shownIds(h), ["1"]);
  h.nodes.handShow.dispatch("click");
  assert.deepEqual(shownIds(h), ["1", "900"]);
  // 重ねる形は閉じた状態から
  const o = await loadHand({ width: 900 });
  o.app.open("ch:1");
  assert.deepEqual(shownIds(o), ["1"]);
  o.nodes.handShow.dispatch("click");
  assert.deepEqual(shownIds(o), ["1", "900"]);
  o.nodes.backdrop.dispatch("click");
  assert.deepEqual(shownIds(o), ["1"]);
});

test("web static: SA.app.refresh は右腕のチャンネルなら右腕の入れ物を、ほかは列 2 だけを描き直す（見えていない右腕は描かない）", async () => {
  const h = await loadHand();
  h.app.open("ch:1");
  const hands = h.handRenders.length;
  const mains = h.rendered.length;
  h.app.refresh("ch:900");
  assert.equal(h.handRenders.length, hands + 1);
  assert.equal(h.rendered.length, mains);
  h.app.refresh("ch:1");
  assert.equal(h.handRenders.length, hands + 1);
  assert.equal(h.rendered.length, mains + 1);
  handClose(h).dispatch("click");
  const folded = h.handRenders.length;
  h.app.refresh("ch:900");
  assert.equal(h.handRenders.length, folded);
  assert.equal(h.rendered.length, mains + 1);
});

test("web static: 列 2 が 360px を切る幅とスマホでは右腕を重ねる形にする", async () => {
  const ctx: Record<string, unknown> = {};
  vm.runInNewContext("const HAND_MAIN_MIN = 360;\n" + fnSource(read("shell.js"), "handModeOf") + "\nf = handModeOf;", ctx);
  const f = ctx.f as (p: boolean, t: number, l: number, hw: number) => string;
  assert.equal(f(false, 1000, 280, 360), "column", "ちょうど 360 は列");
  assert.equal(f(false, 999, 280, 360), "over", "359 は重ねる");
  assert.equal(f(true, 2000, 280, 360), "over", "スマホは幅によらず重ねる");
  // 幅が変わったら形を変え、重ねて開いていた状態は閉じる。列は保存した開閉に従う
  const h = await loadHand({ width: 999 });
  assert.equal(h.nodes.v3.getAttribute("data-hand-mode"), "over");
  assert.equal(handOf(h), "closed");
  h.nodes.handShow.dispatch("click");
  assert.equal(handOf(h), "open");
  h.state.width = 1000;
  h.fire("resize");
  assert.equal(h.nodes.v3.getAttribute("data-hand-mode"), "column");
  assert.equal(handOf(h), "open", "列の既定は開く");
  assert.equal(h.nodes.backdrop.hidden, true);
  h.state.width = 999;
  h.fire("resize");
  assert.equal(handOf(h), "closed");
  assert.equal(h.nodes.handShow.getAttribute("aria-expanded"), "false");
});

test("web static: 重ねた右腕が開いている間だけ backdrop を出し、一覧と列 2 を inert にする", async () => {
  const h = await loadHand({ width: 900 });
  const inert = () => [(h.nodes.list as unknown as { inert?: boolean }).inert, (h.nodes.main as unknown as { inert?: boolean }).inert];
  assert.equal(h.nodes.backdrop.hidden, true);
  assert.deepEqual(inert(), [false, false]);
  h.nodes.handShow.dispatch("click");
  assert.equal(h.nodes.backdrop.hidden, false);
  assert.deepEqual(inert(), [true, true]);
  assert.equal(h.nodes.hand.getAttribute("role"), "dialog");
  assert.equal(h.nodes.handShow.getAttribute("aria-expanded"), "true");
  assert.equal(h.document.activeElement, handClose(h));
  h.nodes.backdrop.dispatch("click");
  assert.equal(h.nodes.backdrop.hidden, true);
  assert.deepEqual(inert(), [false, false]);
  assert.equal(h.nodes.hand.getAttribute("role"), null);
  assert.equal(h.document.activeElement, h.nodes.handShow, "開いたボタンに戻る");
  // 列の右腕は backdrop も inert も無い
  const c = await loadHand();
  assert.equal(handOf(c), "open");
  assert.equal(c.nodes.backdrop.hidden, true);
  assert.equal(c.nodes.hand.getAttribute("role"), null);
  assert.equal((c.nodes.main as unknown as { inert?: boolean }).inert, false);
});

test("web static: 右腕の開閉を保存するのは列のときだけ（重ねる形は保存しない・毎回閉じた状態から）", async () => {
  const KEY = "self-agent-web:v3-hand";
  const h = await loadHand();
  handClose(h).dispatch("click");
  assert.equal(h.storage.get(KEY), "0");
  assert.equal(h.document.activeElement, h.nodes.handShow);
  h.nodes.handShow.dispatch("click");
  assert.equal(h.storage.get(KEY), "1");
  // 読み直しても畳んだまま
  const folded = await loadHand({ storage: { [KEY]: "0" } });
  assert.equal(handOf(folded), "closed");
  assert.deepEqual(shownIds(folded), []);
  // 重ねる形は保存した値によらず閉じた状態から、開閉しても書かない
  const o = await loadHand({ width: 900, storage: { [KEY]: "1" } });
  assert.equal(handOf(o), "closed");
  o.nodes.handShow.dispatch("click");
  handClose(o).dispatch("click");
  assert.equal(o.storage.get(KEY), "1");
  const p = await loadHand({ phone: true });
  assert.equal(handOf(p), "closed");
  p.press.bottom("hand");
  assert.equal(p.storage.has(KEY), false);
});

test("web static: スマホで開いた右腕は履歴の 1 つで、戻ると閉じ、開いたまま話題を開くとその entry を話題に置き換える", async () => {
  const h = await loadHand({ phone: true });
  const stateOf = (x: HandShell) => JSON.parse(JSON.stringify(x.history.state)) as unknown;
  // 一覧の下の口: 開いて入力欄に焦点。entry を 1 つ積む
  h.press.bottom("hand");
  assert.equal(handOf(h), "open");
  assert.equal(h.calls.push, 1);
  assert.deepEqual(stateOf(h), { v3Body: false, v3Hand: true, v3Depth: 0 });
  assert.equal(h.document.activeElement, h.nodes.handEd.querySelector("textarea.composer-input"));
  // 戻ると閉じ、口に焦点
  h.history.back();
  assert.equal(handOf(h), "closed");
  assert.equal(h.nodes.v3.getAttribute("data-view"), "list");
  assert.equal(h.document.activeElement, h.nodes.bottomHand);
  // 会話の上の [右腕] から開いて [畳む] → 戻る（会話のまま）で閉じる
  h.app.open("ch:1");
  assert.equal(h.calls.push, 2);
  h.nodes.handOpen.dispatch("click");
  assert.equal(h.calls.push, 3);
  assert.deepEqual(stateOf(h), { v3Body: true, v3Hand: true, v3Depth: 1 });
  handClose(h).dispatch("click");
  assert.equal(handOf(h), "closed");
  assert.equal(h.nodes.v3.getAttribute("data-view"), "body");
  assert.deepEqual(stateOf(h), { v3Body: true });
  assert.equal(h.document.activeElement, h.nodes.handOpen);
  // 開いたまま話題を開くと、右腕は閉じて右腕の entry が話題の entry になる（積み増さない）
  h.nodes.handOpen.dispatch("click");
  const pushes = h.calls.push;
  h.app.open("ch:2");
  assert.equal(handOf(h), "closed");
  assert.equal(h.calls.push, pushes);
  assert.deepEqual(stateOf(h), { v3Body: true, v3Depth: 2 });
  assert.equal(h.location.hash, "#/ch/2");
  assert.equal(h.nodes.backdrop.hidden, true);
  h.history.back();
  assert.equal(h.nodes.v3.getAttribute("data-view"), "body", "前の entry は ch:1 の会話");
  assert.equal(handOf(h), "closed");
  // 640px 以上の重ねる形は entry を積まない
  const pc = await loadHand({ width: 900 });
  pc.nodes.handShow.dispatch("click");
  assert.equal(pc.calls.push, 0);
});

test("web static: Escape は重ねた右腕を先に畳み、列の右腕は畳まない", async () => {
  const o = await loadHand({ width: 900 });
  o.nodes.handShow.dispatch("click");
  const ta = o.nodes.handEd.querySelector("textarea.composer-input")!;
  ta.focus();
  // IME の変換中は取らない
  o.fireDoc("keydown", keyEvent("Escape", ta, { isComposing: true }));
  assert.equal(handOf(o), "open");
  // 入力欄に焦点があっても畳む
  o.fireDoc("keydown", keyEvent("Escape", ta));
  assert.equal(handOf(o), "closed");
  assert.equal(o.document.activeElement, o.nodes.handShow);
  const c = await loadHand();
  handClose(c).focus();
  c.fireDoc("keydown", keyEvent("Escape", handClose(c)));
  assert.equal(handOf(c), "open");
  // スマホの重ねた右腕は、会話の上でも一覧に戻らず右腕だけを畳む
  const p = await loadHand({ phone: true });
  p.app.open("ch:1");
  p.nodes.handOpen.dispatch("click");
  p.fireDoc("keydown", keyEvent("Escape", handClose(p)));
  assert.equal(handOf(p), "closed");
  assert.equal(p.nodes.v3.getAttribute("data-view"), "body");
});

test("web static: 右腕への発言は、列 2 に話題が出ているときだけ先頭に「（いま見ている話題: <題名>）」を 1 行添える（スマホは会話の上に出したときだけ・題名は 80 字まで）", async () => {
  const long = "あ".repeat(81);
  const topics = [v3Topic("ch:1", { title: "題名の\n  二行目" }), v3Topic("ch:2", { title: long })];
  const h = await loadHand({}, topics);
  const out = (s: HandShell) => s.handRenders.at(-1)!.frame.outgoing!("頼みごと");
  assert.equal(out(h), "頼みごと", "何も開いていない");
  h.app.open("ch:1");
  assert.equal(out(h), "（いま見ている話題: 題名の 二行目）\n頼みごと");
  h.app.open("ch:2");
  assert.equal(out(h), "（いま見ている話題: " + "あ".repeat(80) + "…）\n頼みごと");
  h.app.open("tasks");
  assert.equal(out(h), "頼みごと", "話題でない画面");
  h.app.open("ch:zzz");
  assert.equal(out(h), "頼みごと", "一覧で引けないチャンネル");
  // スマホ: 一覧から出したときは添えず、会話の上に出したときだけ
  const p = await loadHand({ phone: true }, topics);
  p.app.open("ch:1");
  p.history.back();
  p.press.bottom("hand");
  assert.equal(out(p), "頼みごと");
  p.history.back();
  p.app.open("ch:1");
  p.nodes.handOpen.dispatch("click");
  assert.equal(out(p), "（いま見ている話題: 題名の 二行目）\n頼みごと");
});

test("web static: 右腕の口の印は あなたの番 > 未読 で 1 つ、見えている間は未読を出さない", async () => {
  const last = { id: 5, at: "2026-11-14T00:00:00.000Z", kind: "agent" };
  const turn = { kind: "confirm", since: "2026-11-14T00:00:00.000Z", summary: null };
  const dots = (n: DomNode) => n.querySelectorAll("span.dot").map((d) => [d.getAttribute("class"), d.getAttribute("aria-label")]);
  // あなたの番（未読でも 1 つ）
  const t = loadShell({ width: 900 }) as HandShell;
  await t.flush();
  t.store.isUnread = () => true;
  t.api.reply = () => Promise.resolve(v3Result([], { rightHands: [v3Hand({ turn, last })] }));
  await t.topics.load();
  assert.deepEqual(dots(t.nodes.handShow), [["dot dot-warn", null]]);
  assert.equal(t.nodes.handShow.getAttribute("aria-label"), "右腕を開く（あなたの番）");
  assert.equal(t.bottomState().hand, "turn");
  assert.deepEqual(dots(t.nodes.handOpen), [["dot dot-warn", "あなたの番"]]);
  assert.match(t.nodes.handOpen.textContent, /右腕/);
  // 未読（右腕のチャンネルと rightHands の last で引く）。開くと消え、畳むと出る
  const u = loadShell({ width: 900 }) as HandShell;
  await u.flush();
  const asked: unknown[] = [];
  u.store.isUnread = (c) => {
    asked.push(c);
    return true;
  };
  u.api.reply = () => Promise.resolve(v3Result([], { rightHands: [v3Hand({ last })] }));
  await u.topics.load();
  assert.deepEqual(JSON.parse(JSON.stringify(asked.at(-1))), { id: "900", last });
  assert.equal(u.nodes.handShow.getAttribute("aria-label"), "右腕を開く（未読）");
  assert.equal(u.bottomState().hand, "unread");
  u.nodes.handShow.dispatch("click");
  assert.equal(u.bottomState().hand, null);
  assert.equal(u.nodes.handShow.getAttribute("aria-label"), "右腕を開く");
  u.nodes.backdrop.dispatch("click");
  assert.equal(u.bottomState().hand, "unread");
  // 印が変わらなければ口の中身を作り直さない
  const icon = u.nodes.handShow.children[0];
  u.app.refreshTabs();
  assert.equal(u.nodes.handShow.children[0], icon);
  // 右腕が無くても口は出す（印は無い）
  const none = loadShell() as HandShell;
  await none.flush();
  assert.equal(none.nodes.handShow.getAttribute("aria-label"), "右腕を開く");
  // スマホの下のバーの右腕のボタンは、名前に印を語で足す
  const p = loadShell({ phone: true }) as HandShell;
  await p.flush();
  p.api.reply = () => Promise.resolve(v3Result([], { rightHands: [v3Hand({ turn, last })] }));
  await p.topics.load();
  assert.deepEqual(p.bottom().items[1], { act: "hand", label: "右腕に頼む・訊く", name: "右腕に頼む・訊く（あなたの番）", mark: "turn" });
});

test("web static: スマホの一覧で右腕を閉じた後、開いたボタンが文書に無ければ下のバーの右腕のボタンへ焦点を戻す", async () => {
  // (a) 開いたボタンが消えた: SA.list.focusHand で下のバーの右腕のボタン
  const h = await loadHand({ phone: true });
  h.press.bottom("hand", new DomNode("button"));
  h.history.back();
  assert.equal(h.list.focusHands, 1);
  assert.equal(h.document.activeElement, h.nodes.bottomHand);
  // (b) focusHand が当てられなくても落ちない
  const f = await loadHand({ phone: true, focusHand: false });
  f.press.bottom("hand", new DomNode("button"));
  f.history.back();
  assert.equal(f.list.focusHands, 1);
  // (c) 会話の上の [右腕] から開いて閉じたときは、そのボタンへ戻す（focusHand は呼ばない）
  const c = await loadHand({ phone: true });
  c.app.open("ch:1");
  c.nodes.handOpen.dispatch("click");
  c.history.back();
  assert.equal(c.list.focusHands, 0);
});

test("web static: 右腕を描き直しても [畳む] の焦点を保つ", async () => {
  const h = await loadHand();
  const first = handClose(h);
  first.focus();
  h.app.refresh("ch:900");
  assert.notEqual(handClose(h), first, "見出しは作り直される");
  assert.equal(h.document.activeElement, handClose(h));
  // 焦点がほかにあれば動かさない
  const ta = h.nodes.handEd.querySelector("textarea.composer-input")!;
  ta.focus();
  h.app.refresh("ch:900");
  assert.equal(h.document.activeElement, ta);
});

test("web static: 右腕のスクロールは描き直しで位置を保ち（下端に居れば下端）、畳んで開き直すと下端から", async () => {
  const h = await loadHand();
  const scroll = () => h.nodes.handEd.querySelector(".ed-scroll")!;
  assert.equal(scroll().scrollTop, 800);
  scroll().scrollTop = 100;
  h.app.refresh("ch:900");
  assert.equal(scroll().scrollTop, 100);
  scroll().scrollTop = 800;
  h.heights.hand = 1500;
  h.app.refresh("ch:900");
  assert.equal(scroll().scrollTop, 1300);
  scroll().scrollTop = 100;
  handClose(h).dispatch("click");
  h.nodes.handShow.dispatch("click");
  assert.equal(scroll().scrollTop, 1300);
});

test("web static: v3.html に右腕の枠と 2 つの口と下のバーの入れ物があり、右腕のための <dialog> は無い", () => {
  const html = read("v3.html");
  assert.match(html, /<div class="v3" id="v3" data-view="list" data-hand="closed" data-hand-mode="over">/);
  assert.match(html, /<\/main>\s*<aside class="v3-hand" id="v3-hand" aria-label="右腕">\s*<button class="btn btn-ghost btn-sm btn-icon-sm v3-hand-show" id="v3-hand-show" type="button" aria-controls="v3-hand-ed" aria-expanded="false"><\/button>\s*<div class="ed v3-hand-ed" id="v3-hand-ed"><\/div>\s*<\/aside>\s*<div class="v3-hand-backdrop" id="v3-hand-backdrop" hidden><\/div>\s*<\/div>/);
  assert.match(html, /id="c-list-root"><\/div>\s*<div class="v3-slot" id="c-bottom-root"><\/div>\s*<\/nav>/);
  assert.doesNotMatch(html, /v3-hand-ask|v3-hand-entry|v3-list-foot/);
  assert.match(html, /id="v3-views"[^>]*><\/div>\s*<button class="btn btn-ghost btn-sm v3-hand-open" id="v3-hand-open" type="button" aria-controls="v3-hand"><\/button>\s*<\/div>/);
  const dialogs = [...html.matchAll(/<dialog id="([^"]+)"/g)].map((m) => m[1]);
  // 始めるダイアログ（M4b）は右腕のためでない
  assert.deepEqual(dialogs, ["v3-sheet", "v3-start", "dlg-confirm"]);
  // CSS: 列 3 の変数・重ねる形・スマホの口（動きは付けない）
  const css = read("shell.css");
  assert.match(css, /--v3-hand-w: 360px;/);
  assert.match(css, /grid-template-columns: var\(--v3-list-w\) minmax\(0, 1fr\) auto;/);
  assert.match(css, /\.v3\[data-hand-mode="over"\]\[data-hand="open"\] \.v3-hand \{[^}]*position: absolute;[^}]*z-index: var\(--z-drawer\);/);
  assert.match(css, /\.v3-hand-backdrop \{[^}]*z-index: var\(--z-drawer-backdrop\);[^}]*background: var\(--backdrop\);/);
  const phone = css.slice(css.indexOf("@media (max-width: 639px)"));
  assert.match(phone, /\.v3\[data-hand-mode="over"\]\[data-hand="open"\] \.v3-hand \{[^}]*top: calc\(var\(--space-8\) \+ env\(safe-area-inset-top, 0px\)\);[^}]*padding-bottom: env\(safe-area-inset-bottom, 0px\);/);
});

// ===== 右腕の枠のレビューの直し（M3b。#357） =====
test("web static: 再読み込みで残った右腕の印（v3Hand）は起動で外し、次に開いた右腕は [畳む] 1 回で閉じる", async () => {
  const h = await loadHand({ phone: true, initState: { v3Body: false, v3Hand: true } });
  const stateOf = () => JSON.parse(JSON.stringify(h.history.state)) as unknown;
  assert.equal(handOf(h), "closed");
  assert.deepEqual(stateOf(), { v3Body: false });
  h.press.bottom("hand");
  assert.equal(handOf(h), "open");
  handClose(h).dispatch("click");
  assert.equal(handOf(h), "closed", "1 回目で閉じる");
  assert.deepEqual(stateOf(), { v3Body: false });
  assert.equal(h.document.activeElement, h.nodes.bottomHand);
});

test("web static: スマホ ⇄ PC の切り替え（(max-width: 639px) の change）で右腕の形・帯を直し、印を外すので戻った後の右腕も [畳む] 1 回で閉じる", async () => {
  const h = await loadHand({ phone: true });
  const stateOf = () => JSON.parse(JSON.stringify(h.history.state)) as unknown;
  h.app.open("tasks");
  assert.equal(h.nodes.bar.hidden, false, "スマホは話題でない画面でも帯を出す");
  h.nodes.handOpen.dispatch("click");
  assert.deepEqual(stateOf(), { v3Body: true, v3Hand: true, v3Depth: 1 });
  // 広げると列の右腕（保存した既定は開く）。entry の印は外す
  h.setPhone(false, 1400);
  assert.equal(h.nodes.v3.getAttribute("data-hand-mode"), "column");
  assert.equal(handOf(h), "open");
  assert.deepEqual(stateOf(), { v3Body: true, v3Depth: 2 });
  assert.equal(h.nodes.bar.hidden, true, "PC は話題でない画面の帯を隠す");
  // 狭めると重ねる形で閉じ、右腕の中にあった焦点は帯の [右腕] へ
  h.setPhone(true, 390);
  assert.equal(h.nodes.v3.getAttribute("data-hand-mode"), "over");
  assert.equal(handOf(h), "closed");
  assert.equal(h.nodes.bar.hidden, false);
  assert.equal(h.document.activeElement, h.nodes.handOpen);
  h.nodes.handOpen.dispatch("click");
  handClose(h).dispatch("click");
  assert.equal(handOf(h), "closed", "1 回目で閉じる");
  assert.equal(h.nodes.v3.getAttribute("data-view"), "body");
  assert.deepEqual(stateOf(), { v3Body: true, v3Depth: 2 });
});

test("web static: 畳んだ右腕を開き直すと /turns を 1 回読み直し、開いている間の開き直しでは読まない", async () => {
  const h = await loadHand();
  assert.deepEqual(h.loads.turns, ["900"]);
  handClose(h).dispatch("click");
  h.nodes.handShow.dispatch("click");
  assert.deepEqual(h.loads.turns, ["900", "900"]);
  h.app.open("ch:900");
  assert.deepEqual(h.loads.turns, ["900", "900"], "見えたままなら読まない");
  const o = await loadHand({ width: 900 });
  o.nodes.handShow.dispatch("click");
  assert.deepEqual(o.loads.turns, ["900"], "初めて描くときは renderHand の 1 回だけ");
  o.nodes.backdrop.dispatch("click");
  o.nodes.handShow.dispatch("click");
  assert.deepEqual(o.loads.turns, ["900", "900"]);
});

test("web static: 右腕を閉じた後の焦点は、開いた物が body なら既定の口へ。進むで開いたら [畳む] へ", async () => {
  // 焦点の無いまま右腕のチャンネルを開いた（開いた物は body）
  const h = await loadHand({ width: 900 });
  assert.equal(h.document.activeElement, h.document.body);
  h.app.open("ch:900");
  assert.equal(handOf(h), "open");
  h.nodes.backdrop.dispatch("click");
  assert.equal(h.document.activeElement, h.nodes.handShow);
  // スマホ: 戻るで閉じ、進むで開くと [畳む]
  const p = await loadHand({ phone: true });
  p.press.bottom("hand");
  p.history.back();
  assert.equal(handOf(p), "closed");
  p.history.forward();
  assert.equal(handOf(p), "open");
  assert.equal(p.document.activeElement, handClose(p));
});

test("web static: 重ねた右腕の [畳む]・backdrop を popstate の前に続けて押しても、戻るのは 1 回", async () => {
  const h = await loadHand({ phone: true, asyncBack: true });
  h.press.bottom("hand");
  handClose(h).dispatch("click");
  handClose(h).dispatch("click");
  h.nodes.backdrop.dispatch("click");
  h.fireDoc("keydown", keyEvent("Escape", handClose(h)));
  assert.equal(h.calls.back, 1);
  h.runHistory();
  assert.equal(handOf(h), "closed");
  assert.equal(h.nodes.v3.getAttribute("data-view"), "list");
  // 次に開いた右腕はまた [畳む] で戻れる
  h.press.bottom("hand");
  handClose(h).dispatch("click");
  assert.equal(h.calls.back, 2);
  h.runHistory();
  assert.equal(handOf(h), "closed");
});

test("web static: 重ねた右腕が開いている間の Ctrl+K は取らない（絞り込み欄は inert の中）", async () => {
  const h = await loadHand({ width: 900 });
  h.nodes.handShow.dispatch("click");
  const e = keyEvent("k", handClose(h), { ctrlKey: true });
  h.fireDoc("keydown", e);
  assert.equal(e.prevented, false);
  assert.equal(h.nodes.searchBox.hidden, true);
  assert.equal(h.document.activeElement, handClose(h));
  // 列の右腕なら効く
  const c = await loadHand();
  const f = keyEvent("k", handClose(c), { metaKey: true });
  c.fireDoc("keydown", f);
  assert.equal(f.prevented, true);
  assert.equal(c.nodes.searchBox.hidden, false);
});

test("web static: 「いま見ている話題」の題名は前後の空白を落とし、80 字は code point で数える（絵文字を割らない）", async () => {
  const title = "  " + "a".repeat(79) + "😀b  ";
  const h = await loadHand({}, [v3Topic("ch:1", { title }), v3Topic("ch:2", { title: " \n 短い題 \t" })]);
  const out = () => h.handRenders.at(-1)!.frame.outgoing!("頼みごと");
  h.app.open("ch:1");
  assert.equal(out(), "（いま見ている話題: " + "a".repeat(79) + "😀…）\n頼みごと");
  h.app.open("ch:2");
  assert.equal(out(), "（いま見ている話題: 短い題）\n頼みごと");
});

test("web static: 640〜999px の重ねた右腕を開いたまま話題が開かれたら右腕を畳み、焦点は列 2 の側（開いた行）", async () => {
  const h = await loadHand({ width: 800 }, [v3Topic("ch:1")]);
  const inert = () => [(h.nodes.list as unknown as { inert?: boolean }).inert, (h.nodes.main as unknown as { inert?: boolean }).inert];
  h.nodes.handShow.dispatch("click");
  assert.equal(h.document.activeElement, handClose(h));
  h.app.open("ch:1");
  assert.equal(h.app.activeTabId(), "ch:1");
  assert.equal(handOf(h), "closed");
  assert.deepEqual(inert(), [false, false]);
  assert.equal(h.nodes.backdrop.hidden, true);
  assert.equal(h.calls.push, 0, "entry は積まない");
  assert.deepEqual(h.list.focusRows.at(-1), "ch:1", "開いた行に焦点を頼む");
});

test("web static: 右腕の枠（shell.js が渡す frame）を本物の chat.js に通すと、送る本文に「（いま見ている話題: …）」が付き、見出しに [畳む]", async () => {
  const h = await loadHand({}, [v3Topic("ch:1", { title: "話の題" })]);
  h.app.open("ch:1");
  const frame = h.handRenders.at(-1)!.frame;
  const c = loadChat();
  c.put("900", []);
  const b = c.box();
  c.chat.render(b, "900", frame as Frame);
  assert.equal(inputOf(b).getAttribute("placeholder"), "右腕に頼む・訊く");
  assert.ok(b.buttons().some((x) => x.getAttribute("id") === "v3-hand-close"));
  typeIn(b, " 頼む ");
  formOf(b).dispatch("submit", { preventDefault() {} });
  await c.flush();
  assert.deepEqual(JSON.parse(JSON.stringify(c.posts.map((p) => p.body))), [{ text: "（いま見ている話題: 話の題）\n頼む" }]);
});

test("web static: 札は返事の <#ID> を話題の行で引いて 題名・場所・状態・[開く] を出す（5 つまで・同じ ID は 1 つ・引けない ID は出さず本文もそのまま）", async () => {
  const topics = [
    v3Topic("ch:11", { title: "領収書", mark: "running", place: { dir: "~/w/x" } }),
    v3Topic("ch:12", { title: "B", group: "other", cwdLabel: "~/a", state: "waiting" }),
    v3Topic("ch:14", { title: "D" }),
    v3Topic("ch:15", { title: "E" }),
  ];
  const h = await loadHand({}, topics);
  // 一覧から外れた（完了した）セッションは /api/channels の値で
  h.chatChannels["13"] = { kind: "session", title: "C", state: "done" };
  h.chatChannels["98"] = { kind: "inbox", name: "inbox" };
  h.handReplies.push("<#11> と <#12>、また <#11>。<#13> <#99> <#98> <#14> <#15>");
  h.app.refresh("ch:900");
  const cards = h.nodes.handEd.querySelectorAll("div.v3-card");
  assert.deepEqual(
    cards.map((c) => [c.getAttribute("data-topic"), c.querySelector("span.v3-card-title")!.textContent, c.querySelector("span.v3-card-meta")!.textContent]),
    [
      ["ch:11", "領収書", "~/w/x・作業中"],
      ["ch:12", "B", "ほかの場所（~/a）・待ち"],
      ["ch:13", "C", "完了"],
    ],
    "11・12・13・99・98 の 5 つまで。引けない 99・98（セッションでない）は出さない",
  );
  const open = cards[0]!.buttons()[0]!;
  assert.equal(open.textContent, "開く");
  assert.equal(open.getAttribute("aria-label"), "領収書 を開く");
  assert.equal(
    h.nodes.handEd.querySelector("p.msg-text")!.textContent,
    "「領収書」 と 「B」、また 「領収書」。「C」 <#99> <#98> 「D」 「E」",
    "本文は引けたものを「題名」に、引けないものはそのまま（5 つの上限は札だけ）",
  );
  // [開く] で列 2 にその話題が開く
  open.dispatch("click");
  assert.equal(h.app.activeTabId(), "ch:11");
  // 一覧を読んで札の中身が変わったら描き直し、変わらなければ描き直さない
  let renders = h.handRenders.length;
  await h.topics.load();
  assert.equal(h.handRenders.length, renders);
  topics[0] = v3Topic("ch:11", { title: "領収書", mark: "turn", place: { dir: "~/w/x" } });
  await h.topics.load();
  assert.equal(h.handRenders.length, renders + 1);
  assert.equal(h.nodes.handEd.querySelector("span.v3-card-meta")!.textContent, "~/w/x・あなたの番");
  // 引けなかった ID が引けるようになっても描き直す
  renders = h.handRenders.length;
  topics.push(v3Topic("ch:99", { title: "新しい話題" }));
  await h.topics.load();
  assert.equal(h.handRenders.length, renders + 1);
  assert.match(h.nodes.handEd.querySelector("p.msg-text")!.textContent, /「新しい話題」/);
  // 純関数: 出た順・同じものは 1 つ・先頭 5 つ
  const ctx: Record<string, unknown> = {};
  vm.runInNewContext(fnSource(read("shell.js"), "cardIds") + "\nf = cardIds;", ctx);
  const ids = (t: string) => JSON.parse(JSON.stringify((ctx.f as (t: string) => string[])(t))) as string[];
  assert.deepEqual(ids("<#3><#1><#3><#2><#4><#5><#6>"), ["3", "1", "2", "4", "5"]);
  assert.deepEqual(ids("<#a> #1 <@2>"), []);
  // 札の CSS は地を付けない
  const css = read("shell.css");
  const card = css.slice(css.indexOf("\n.v3-card {"), css.indexOf("}", css.indexOf("\n.v3-card {")));
  assert.doesNotMatch(card, /background/);
  assert.match(card, /border: var\(--border-width\) solid var\(--border\);/);
});

// ===== 札のレビューの直し（M3c。#357） =====
test("web static: スマホで札の [開く] で開いた話題の [‹] は 1 回で一覧へ戻る（履歴の v3Depth。ブラウザの戻るは前の話題）", async () => {
  const topics = [v3Topic("ch:1", { title: "X" }), v3Topic("ch:2", { title: "Y" }), v3Topic("ch:3", { title: "Z" })];
  const cardOpen = (h: HandShell, id: string) => h.nodes.handEd.querySelector(`div.v3-card[data-topic="${id}"]`)!.buttons()[0]!.dispatch("click");
  const back = (h: HandShell) => h.nodes.ed.querySelector("button.ed-back")!.dispatch("click");
  const stateOf = (h: HandShell) => JSON.parse(JSON.stringify(h.history.state)) as unknown;
  // X → [右腕] → 札 Y → [‹]
  const h = await loadHand({ phone: true }, topics);
  h.handReplies.push("<#2> と <#3>");
  h.app.open("ch:1");
  h.nodes.handOpen.dispatch("click");
  assert.deepEqual(stateOf(h), { v3Body: true, v3Hand: true, v3Depth: 1 });
  cardOpen(h, "ch:2");
  assert.equal(h.app.activeTabId(), "ch:2");
  assert.deepEqual(stateOf(h), { v3Body: true, v3Depth: 2 });
  back(h);
  assert.equal(h.nodes.v3.getAttribute("data-view"), "list");
  assert.equal(h.location.hash, "");
  assert.equal(h.history.state, null);
  // X → [右腕] → 札 Y → [右腕] → 札 Z → [‹]
  const z = await loadHand({ phone: true }, topics);
  z.handReplies.push("<#2> と <#3>");
  z.app.open("ch:1");
  z.nodes.handOpen.dispatch("click");
  cardOpen(z, "ch:2");
  z.nodes.handOpen.dispatch("click");
  cardOpen(z, "ch:3");
  assert.deepEqual(stateOf(z), { v3Body: true, v3Depth: 3 });
  back(z);
  assert.equal(z.nodes.v3.getAttribute("data-view"), "list");
  assert.equal(z.location.hash, "");
  // 一覧 → [右腕] → 札 Y → [‹] は今までどおり back 1 回
  const l = await loadHand({ phone: true }, topics);
  l.handReplies.push("<#2>");
  l.press.bottom("hand");
  assert.deepEqual(stateOf(l), { v3Body: false, v3Hand: true, v3Depth: 0 });
  cardOpen(l, "ch:2");
  assert.deepEqual(stateOf(l), { v3Body: true, v3Depth: 1 });
  back(l);
  assert.equal(l.calls.back, 1);
  assert.equal(l.nodes.v3.getAttribute("data-view"), "list");
  assert.equal(l.location.hash, "");
  // ブラウザの戻るは前の話題（X）の entry
  const b = await loadHand({ phone: true }, topics);
  b.handReplies.push("<#2>");
  b.app.open("ch:1");
  b.nodes.handOpen.dispatch("click");
  cardOpen(b, "ch:2");
  b.history.back();
  assert.equal(b.nodes.v3.getAttribute("data-view"), "body");
  assert.equal(b.location.hash, "#/ch/1");
});

test("web static: 先頭が 0 の <#00012> は ID として扱わず、札も出さず本文もそのまま。6 つ目以降は本文だけ題名に替える", async () => {
  const topics = [1, 2, 3, 4, 5, 6, 12].map((n) => v3Topic("ch:" + n, { title: "T" + n }));
  const h = await loadHand({}, topics);
  h.handReplies.push("<#00012> <#0> <#1> <#2> <#3> <#4> <#5> <#6> <#12>");
  h.app.refresh("ch:900");
  const cards = h.nodes.handEd.querySelectorAll("div.v3-card").map((c) => c.getAttribute("data-topic"));
  assert.deepEqual(cards, ["ch:1", "ch:2", "ch:3", "ch:4", "ch:5"]);
  assert.equal(h.nodes.handEd.querySelector("p.msg-text")!.textContent, "<#00012> <#0> 「T1」 「T2」 「T3」 「T4」 「T5」 「T6」 「T12」");
});

test("web static: 場所も状態も引けない札は .v3-card-meta の span を作らない", async () => {
  const h = await loadHand();
  h.chatChannels["13"] = { kind: "session", title: "C", state: "unknown" };
  h.handReplies.push("<#13>");
  h.app.refresh("ch:900");
  const card = h.nodes.handEd.querySelector("div.v3-card")!;
  assert.equal(card.querySelector("span.v3-card-title")!.textContent, "C");
  assert.equal(card.querySelector("span.v3-card-meta"), null);
  assert.equal(card.buttons().length, 1);
});

test("web static: 幅の往復・再読み込みで右腕の印を外した会話の entry からも、[‹] 1 回で一覧へ戻る", async () => {
  const back = (h: HandShell) => h.nodes.ed.querySelector("button.ed-back")!.dispatch("click");
  const h = await loadHand({ phone: true }, [v3Topic("ch:1")]);
  h.app.open("ch:1");
  h.nodes.handOpen.dispatch("click");
  h.setPhone(false, 1400);
  h.setPhone(true, 390);
  assert.equal(handOf(h), "closed");
  assert.deepEqual(JSON.parse(JSON.stringify(h.history.state)), { v3Body: true, v3Depth: 2 });
  back(h);
  assert.equal(h.nodes.v3.getAttribute("data-view"), "list");
  assert.equal(h.location.hash, "");
  // 再読み込みで残った v3Depth の無い会話の右腕の entry は、下を 1 と見て 2
  const r = await loadHand({ phone: true, hash: "#/ch/1", initState: { v3Body: true, v3Hand: true } }, [v3Topic("ch:1")]);
  assert.deepEqual(JSON.parse(JSON.stringify(r.history.state)), { v3Body: true, v3Depth: 2 });
});

// ===== 話題を始める口（M4b。#360）: 群の見出しの [+]・始めるダイアログ #v3-start・「場所: なし」 =====
const startGroups = () => [
  v3Group("p:alpha", { kind: "project", name: "alpha" }),
  v3Group("general", { name: "General" }),
  v3Group("p:beta", { kind: "project", name: "beta", open: 0 }),
  v3Group("other", { kind: "other", name: "ほかの場所" }),
];
const startTopics = () => [
  v3Topic("ch:1", { group: "general", title: "一般", place: { dir: "General" } }),
  v3Topic("ch:2", { group: "general", title: "軽い", place: { dir: null } }),
  v3Topic("ch:3", { group: "p:alpha", title: "作業", place: { dir: "alpha" } }),
  v3Topic("ch:4", { group: "other", title: "外", cwdLabel: "~/x" }),
];
type StartShell = ReturnType<typeof loadShell> & { toasts: string[]; start: DomNode & { close: () => void }; app: ShellApp & { newSession: (place?: string, opener?: unknown) => void; draft: (id: string) => string } };

async function loadStart(opts: Parameters<typeof loadShell>[0] = {}, o: Record<string, unknown> = {}): Promise<StartShell> {
  const h = loadShell(opts) as StartShell;
  await h.flush();
  h.api.reply = () => Promise.resolve(v3Result(startTopics(), { groups: startGroups(), ...o }));
  await h.topics.load();
  h.toasts = [];
  h.ui.toast = (text: string) => void h.toasts.push(text);
  h.start = h.document.getElementById("v3-start") as StartShell["start"];
  return h;
}
const startEl = (h: StartShell, id: string) => h.document.getElementById("v3-start-" + id) as DomNode & { value: string; disabled: boolean };
/** 群の [+] を押した代わり（state.on.add に、一覧の列の中に置いた偽の [+] を opener として渡す。群ごとに同じ要素） */
const openers = new WeakMap<object, Map<string, DomNode>>();
const pressAdd = (h: StartShell, key: string): DomNode => {
  const byKey = openers.get(h) ?? new Map<string, DomNode>();
  openers.set(h, byKey);
  let opener = byKey.get(key);
  if (!opener) {
    opener = new DomNode("button");
    h.nodes.list.append(opener);
    byKey.set(key, opener);
  }
  h.press.add(key, opener);
  return opener;
};
const submitStart = (h: StartShell) => {
  const e = { prevented: false, preventDefault: () => (e.prevented = true) };
  startEl(h, "form").dispatch("submit", e);
  return e;
};
const created = (o: Record<string, unknown> = {}) => ({ id: "ch:77", channelId: "77", link: "https://discord.com/channels/1/77", title: "始めた", place: { dir: "General" }, mode: "project", turn: "started", ...o });
const apiError = (status: number, code: string | null, data: Record<string, unknown> | null = null) =>
  Object.assign(new Error(status + ": " + code), { status, code, data: data ?? (code ? { error: code } : null) });

test("web static: v3.html の始めるダイアログは aria-labelledby・label の for・role=alert を持ち、inline の script・style が無い", () => {
  const html = read("v3.html");
  const at = html.indexOf('<dialog id="v3-start"');
  assert.ok(at > html.indexOf('<dialog id="v3-sheet"'), "#v3-sheet の後ろ");
  const dialog = html.slice(at, html.indexOf("</dialog>", at));
  assert.match(dialog, /^<dialog id="v3-start" class="v3-start" aria-labelledby="v3-start-title">/);
  assert.match(dialog, /<h2 id="v3-start-title" class="dlg-title">話題を始める<\/h2>/);
  // 欄の順は 場所 → 最初の一言 → 題名 → やめる → 始める
  const fields = [...dialog.matchAll(/<label for="([^"]+)">/g)].map((m) => m[1]);
  assert.deepEqual(fields, ["v3-start-place", "v3-start-text", "v3-start-name"]);
  for (const id of fields) assert.match(dialog, new RegExp(`<(select|textarea|input) [^>]*id="${id}"`), id);
  assert.ok(dialog.indexOf('id="v3-start-cancel"') < dialog.indexOf('id="v3-start-ok"'));
  assert.match(dialog, /<p class="alert" id="v3-start-error" role="alert" hidden><\/p>/);
  assert.match(dialog, /<textarea [^>]*maxlength="1900"/);
  assert.match(dialog, /<input [^>]*maxlength="100"/);
  assert.match(dialog, /<button class="btn btn-primary btn-sm" id="v3-start-ok" type="submit">始める<\/button>/);
  assert.doesNotMatch(dialog, /\sstyle=|\son[a-z]+=|<script|<style/i);
  // [+] は topics.js が作る（v3.html の「あなたの番」の見出しには無い）
  assert.equal(html.includes("v3-add"), false);
});

test("web static: v3 の始める口: General とプロジェクトの群の見出しに [+] があり、名前は「<群の名前> で話題を始める」。ほかの場所には無い。畳んだプロジェクトの見出しにもある", async () => {
  const h = await loadStart({}, { turns: 1, turnIds: ["ch:1"] });
  for (const [key, name] of [
    ["general", "General"],
    ["p:alpha", "alpha"],
    ["p:beta", "beta"],
  ]) {
    const g = h.groupOf(key!)!;
    assert.equal(g.canAdd, true, key);
    assert.equal(g.addLabel, name + " で話題を始める");
  }
  const others = h.model().blocks.find((b): b is ListOthers => b.type === "others")!;
  assert.deepEqual(others.groups.map((g) => [g.key, g.canAdd]), [["p:beta", true]], "畳んだ群");
  assert.equal(h.groupOf("other")!.canAdd, false);
});

test("web static: v3 の始める口: [+] を押すと始めるダイアログが開き、場所は押した群・候補は General が先頭でプロジェクトが続く・フォーカスは最初の一言", async () => {
  const h = await loadStart();
  pressAdd(h, "p:alpha");
  assert.equal(h.start.getAttribute("open"), "");
  const select = startEl(h, "place");
  assert.deepEqual(
    kids(select).map((o) => [o.getAttribute("value"), textOf(o)]),
    [
      ["general", "General"],
      ["p:alpha", "alpha"],
      ["p:beta", "beta"],
    ],
  );
  assert.equal(select.value, "p:alpha");
  assert.equal(h.document.activeElement, startEl(h, "text"));
  assert.equal(startEl(h, "error").hidden, true);
  // 開き直すと欄は空・場所は押した群（知らない場所は General）
  startEl(h, "text").value = "前の";
  startEl(h, "name").value = "前の題";
  h.start.close();
  h.app.newSession("p:nope");
  assert.equal(select.value, "general");
  assert.equal(startEl(h, "text").value, "");
  assert.equal(startEl(h, "name").value, "");
  h.start.close();
  // 一覧をまだ読めていなければ General だけ
  const fresh = loadShell() as StartShell;
  fresh.app.newSession();
  assert.deepEqual(kids(fresh.document.getElementById("v3-start-place") as DomNode).map((o) => o.getAttribute("value")), ["general"]);
});

test("web static: v3 の始める口: 題名も一言も空なら送らずに「最初の一言か題名を入れてください」", async () => {
  const h = await loadStart();
  pressAdd(h, "general");
  startEl(h, "text").value = "  \n ";
  startEl(h, "name").value = " ";
  const e = submitStart(h);
  assert.equal(e.prevented, true);
  assert.equal(h.api.posts.length, 0);
  assert.equal(startEl(h, "error").hidden, false);
  assert.equal(textOf(startEl(h, "error")), "最初の一言か題名を入れてください");
  assert.equal(startEl(h, "text").getAttribute("aria-invalid"), "true");
  assert.equal(h.start.getAttribute("open"), "");
});

test("web static: v3 の始める口: 始めるは POST /api/topics に place・text・title（空の欄は送らない）を 1 回だけ送り、送っている間は [始める] が無効", async () => {
  const h = await loadStart();
  let resolve: (v: unknown) => void = () => undefined;
  h.api.postReply = () => new Promise((r) => (resolve = r));
  pressAdd(h, "p:alpha");
  startEl(h, "text").value = "  最初の一言  ";
  submitStart(h);
  assert.deepEqual(h.api.posts, [{ path: "/api/topics", body: { place: "p:alpha", text: "最初の一言" }, opts: { quiet: true } }]);
  assert.equal(startEl(h, "ok").disabled, true);
  // 送っている間の 2 回目（[始める]・Ctrl+Enter）は送らない
  submitStart(h);
  startEl(h, "text").dispatch("keydown", keyEvent("Enter", startEl(h, "text"), { ctrlKey: true }));
  assert.equal(h.api.posts.length, 1);
  resolve(created());
  await h.flush();
  assert.equal(startEl(h, "ok").disabled, false);
  // 題名だけ（一言は送らない）
  h.app.newSession("general");
  startEl(h, "name").value = " 題だけ ";
  submitStart(h);
  assert.deepEqual(h.api.posts[1]!.body, { place: "general", title: "題だけ" });
});

test("web static: v3 の始める口: 始めたらダイアログを閉じ、一覧を読み直し、その話題を開く（スマホは会話の画面）", async () => {
  const h = await loadStart();
  h.api.postReply = () => Promise.resolve(created({ title: "旅行の計画" }));
  pressAdd(h, "general");
  startEl(h, "text").value = "旅行の計画を立てたい";
  const reads = h.api.paths.length;
  submitStart(h);
  await h.flush();
  assert.equal(h.start.getAttribute("open"), null);
  assert.equal(h.api.paths.slice(reads).filter((p) => p === "/api/topics").length, 1, "一覧を読み直す");
  assert.equal(h.app.activeTabId(), "ch:77");
  assert.deepEqual(h.toasts, ["話題「旅行の計画」を始めました"]);
  // スマホ: 会話の画面になり、開いていた右腕も閉じる
  const p = await loadStart({ phone: true, width: 390 }, { rightHands: [v3Hand()] });
  p.api.postReply = () => Promise.resolve(created());
  p.press.bottom("hand");
  assert.equal(p.nodes.v3.getAttribute("data-hand"), "open");
  p.app.newSession("general");
  startEl(p, "text").value = "やあ";
  submitStart(p);
  await p.flush();
  assert.equal(p.nodes.v3.getAttribute("data-hand"), "closed");
  assert.equal(p.nodes.v3.getAttribute("data-view"), "body");
  assert.equal(p.app.activeTabId(), "ch:77");
  assert.equal(p.location.hash, "#/ch/77");
});

test("web static: v3 の始める口: turn が failed なら一言を書きかけに戻して開く", async () => {
  const h = await loadStart();
  h.api.postReply = () => Promise.resolve(created({ turn: "failed", title: "題" }));
  pressAdd(h, "general");
  startEl(h, "text").value = "送れなかった一言\n2 行目";
  submitStart(h);
  await h.flush();
  assert.equal(h.app.draft("77"), "送れなかった一言\n2 行目");
  assert.equal(h.app.activeTabId(), "ch:77");
  assert.deepEqual(h.toasts, ["話題「題」を始めました。最初の一言は送れなかったので、入力欄に戻しました"]);
});

test("web static: v3 の始める口: 失敗はダイアログを開いたまま、error の値ごとの文を role=alert の欄に出し、[始める] を有効に戻す。HTTP の番号・error の値は画面に出ない", async () => {
  const cases: Array<[Error, string]> = [
    [apiError(400, "too_long", { error: "too_long", field: "title" }), "題名は 100 字までです"],
    [apiError(400, "too_long", { error: "too_long", field: "text" }), "最初の一言は 1,900 字までです"],
    [apiError(400, "empty"), "最初の一言か題名を入れてください"],
    [apiError(400, "invalid_project"), "そのプロジェクトは使えません"],
    [apiError(409, "cc_disabled"), "プロジェクトで始めるには Claude Code の連携が要ります"],
    [apiError(503, "unify_not_ready"), "設定が済んでいません。端末で npm run unify-setup -- --print の行を実行して再起動してください"],
    [apiError(409, "not_set_up"), "先に Discord で /setup を実行してください"],
    [apiError(503, "bot_disconnected"), "Discord につながっていません。少し待ってからもう一度試してください"],
    [apiError(0, null), "サーバーにつながりません"],
    [apiError(500, "internal"), "始められませんでした。もう一度試してください"],
    [apiError(400, "bad_request"), "始められませんでした。もう一度試してください"],
  ];
  const h = await loadStart();
  pressAdd(h, "p:alpha");
  for (const [err, text] of cases) {
    h.api.postReply = () => Promise.reject(err);
    startEl(h, "text").value = "一言";
    startEl(h, "name").value = "題";
    submitStart(h);
    await h.flush();
    const box = startEl(h, "error");
    assert.equal(box.hidden, false, text);
    assert.equal(textOf(box), text);
    const { status, code } = err as Error & { status: number; code: string | null };
    if (status !== 0) assert.equal(textOf(box).includes(String(status)), false, "HTTP の番号");
    if (code) assert.equal(textOf(box).includes(code), false, "error の値");
    assert.equal(h.start.getAttribute("open"), "", "開いたまま");
    assert.equal(startEl(h, "ok").disabled, false);
    assert.equal(startEl(h, "text").value, "一言", "入力は残す");
  }
  assert.deepEqual(h.toasts, []);
  assert.equal(startEl(h, "name").getAttribute("aria-invalid"), null);
  // 次に送るとエラーの欄を隠す
  let resolve: (v: unknown) => void = () => undefined;
  h.api.postReply = () => new Promise((r) => (resolve = r));
  submitStart(h);
  assert.equal(startEl(h, "error").hidden, true);
  resolve(created());
  await h.flush();
});

test("web static: v3 の始める口: 連携が無効・link が無いときのヒントの文（General は場所なしで始める・プロジェクトは連携が要る）。場所を変えるとヒントも変わる", async () => {
  const hint = (h: StartShell, place: string) => {
    startEl(h, "place").value = place;
    startEl(h, "place").dispatch("change");
    return textOf(startEl(h, "hint"));
  };
  const h = await loadStart({ status: {} });
  h.app.newSession("general");
  assert.equal(textOf(startEl(h, "hint")), "Discord にチャンネルができます。");
  assert.equal(hint(h, "p:alpha"), "Discord にチャンネルができます。alpha の中で作業します。", "状態が分からなければ有効と同じ");
  h.store.status = { cc: { enabled: true, unifyReady: true } };
  assert.equal(hint(h, "general"), "Discord にチャンネルができます。");
  assert.equal(hint(h, "p:beta"), "Discord にチャンネルができます。beta の中で作業します。");
  h.store.status = { cc: { enabled: false, unifyReady: false } };
  assert.equal(hint(h, "general"), "Discord にチャンネルができます。Claude Code の連携が使えないので、場所なしの話題として始めます。");
  assert.equal(hint(h, "p:alpha"), "プロジェクトで始めるには Claude Code の連携が要ります。");
  h.store.status = { cc: { enabled: true, unifyReady: false } };
  assert.equal(hint(h, "general"), "Discord にチャンネルができます。Claude Code の連携が使えないので、場所なしの話題として始めます。");
  assert.equal(hint(h, "p:alpha"), "設定が済んでいません。端末で npm run unify-setup -- --print の行を実行して再起動してください");
  // ヒントが何でも [始める] は押せる（判定はサーバー）
  assert.equal(startEl(h, "ok").disabled, false);
});

test("web static: v3 の始める口: 最初の一言の Ctrl+Enter・⌘+Enter で送る。変換中は送らない。ただの Enter では送らない", async () => {
  const h = await loadStart();
  h.api.postReply = () => Promise.reject(apiError(500, "internal"));
  pressAdd(h, "general");
  const text = startEl(h, "text");
  text.value = "一言";
  const plain = keyEvent("Enter", text);
  text.dispatch("keydown", plain);
  assert.equal(plain.prevented, false, "ただの Enter は改行");
  const composing = keyEvent("Enter", text, { ctrlKey: true, isComposing: true });
  text.dispatch("keydown", composing);
  assert.equal(composing.prevented, false);
  assert.equal(h.api.posts.length, 0);
  const ctrl = keyEvent("Enter", text, { ctrlKey: true });
  text.dispatch("keydown", ctrl);
  assert.equal(ctrl.prevented, true);
  assert.equal(h.api.posts.length, 1);
  await h.flush();
  text.dispatch("keydown", keyEvent("Enter", text, { metaKey: true }));
  assert.equal(h.api.posts.length, 2);
  await h.flush();
  // ほかのキーとの組み合わせは送らない
  text.dispatch("keydown", keyEvent("k", text, { ctrlKey: true }));
  assert.equal(h.api.posts.length, 2);
});

test("web static: v3 の始める口: やめる・Escape で閉じたら押した [+] にフォーカスが戻る。話題を開いたときは戻さない", async () => {
  const h = await loadStart();
  const add = pressAdd(h, "p:alpha");
  startEl(h, "cancel").dispatch("click");
  assert.equal(h.start.getAttribute("open"), null);
  assert.equal(h.document.activeElement, add);
  // Escape（<dialog> の素の動きで close）
  pressAdd(h, "p:alpha");
  assert.equal(h.document.activeElement, startEl(h, "text"));
  h.start.close();
  assert.equal(h.document.activeElement, add);
  // 始めて話題を開いたときは戻さない
  h.api.postReply = () => Promise.resolve(created());
  pressAdd(h, "p:alpha");
  startEl(h, "text").value = "一言";
  submitStart(h);
  await h.flush();
  assert.equal(h.app.activeTabId(), "ch:77");
  assert.notEqual(h.document.activeElement, add);
});

test("web static: v3 の始める口: 場所の表示は、General の話題は「場所: General」、place.dir が null の話題は「場所: なし」、プロジェクトは名前", async () => {
  const h = await loadStart();
  const place = () => textOf((h.document.getElementById("v3-place") as DomNode).querySelector("span.v3-place-text")!);
  h.app.open("ch:1");
  assert.equal(place(), "場所: General");
  h.app.open("ch:2");
  assert.equal(place(), "場所: なし");
  h.app.open("ch:3");
  assert.equal(place(), "場所: alpha");
  h.app.open("ch:4");
  assert.equal(place(), "場所: ほかの場所（~/x）");
  // 札も同じ決め方
  const ctx: Record<string, unknown> = {};
  vm.runInNewContext(fnSource(read("shell.js"), "placeText") + "\nf = placeText;", ctx);
  const f = ctx.f as (t: unknown) => string;
  assert.equal(f({ group: "general", place: { dir: null } }), "なし");
  assert.equal(f({ group: "general", place: null }), "なし");
  assert.equal(f({ group: "general", place: { dir: "Gen" } }), "General", "ディレクトリの名前を変えていても General");
  assert.equal(f({ group: "p:x", place: { dir: "x" } }), "x");
});

test("web static: v3 の始める口の CSS: 一言の欄は縦にだけ伸ばせる", () => {
  const css = read("shell.css");
  const block = (src: string, sel: string) => src.slice(src.indexOf(sel + " {"), src.indexOf("}", src.indexOf(sel + " {")));
  assert.match(block(css, "\n.v3-start .textarea"), /resize: vertical;/);
});

// 送っている間に閉じた・開き直した後の応答（#367 のレビュー）: 送った開きのままでなければダイアログに触らず、toast で知らせる。話題へは移らない
type StartPending = { res: (v: unknown) => void; rej: (e: unknown) => void };
async function loadStartPending(): Promise<{ h: StartShell; pending: StartPending[]; hash: string }> {
  const h = await loadStart();
  h.app.open("ch:1");
  const pending: StartPending[] = [];
  h.api.postReply = () => new Promise((res, rej) => void pending.push({ res, rej }));
  return { h, pending, hash: h.location.hash };
}
const topicReads = (h: StartShell, from: number) => h.api.paths.slice(from).filter((p) => p === "/api/topics").length;

test("web static: v3 の始める口: 送っている間に閉じて開き直し、前の応答が成功で返っても、今のダイアログ・欄・[始める] に触らず、話題へ移らず、toast と一覧の読み直し", async () => {
  const { h, pending, hash } = await loadStartPending();
  pressAdd(h, "general");
  startEl(h, "text").value = "A";
  submitStart(h);
  h.start.close();
  pressAdd(h, "general");
  assert.equal(startEl(h, "ok").disabled, false, "開き直したら [始める] は押せる");
  startEl(h, "text").value = "B";
  const reads = h.api.paths.length;
  pending[0]!.res(created({ title: "A の話" }));
  await h.flush();
  assert.equal(h.start.getAttribute("open"), "", "開いたまま");
  assert.equal(startEl(h, "text").value, "B");
  assert.equal(startEl(h, "ok").disabled, false);
  assert.equal(startEl(h, "error").hidden, true);
  assert.equal(h.app.activeTabId(), "ch:1");
  assert.equal(h.location.hash, hash);
  assert.deepEqual(h.toasts, ["話題「A の話」を始めました"]);
  assert.equal(topicReads(h, reads), 1);
});

test("web static: v3 の始める口: 開き直した後に前の応答が失敗で返ったら、今の欄にエラーも aria-invalid も付けず、失敗の文を toast に出す", async () => {
  const { h, pending } = await loadStartPending();
  pressAdd(h, "general");
  startEl(h, "text").value = "A";
  submitStart(h);
  h.start.close();
  pressAdd(h, "general");
  startEl(h, "text").value = "B";
  pending[0]!.rej(apiError(400, "too_long", { error: "too_long", field: "text" }));
  await h.flush();
  assert.equal(h.start.getAttribute("open"), "");
  assert.equal(startEl(h, "text").value, "B");
  assert.equal(startEl(h, "error").hidden, true);
  assert.equal(textOf(startEl(h, "error")), "");
  assert.equal(startEl(h, "text").getAttribute("aria-invalid"), null);
  assert.equal(startEl(h, "name").getAttribute("aria-invalid"), null);
  assert.equal(startEl(h, "ok").disabled, false);
  assert.deepEqual(h.toasts, ["最初の一言は 1,900 字までです"]);
});

test("web static: v3 の始める口: 閉じたまま失敗したら toast に失敗の文。次に開くと欄は空・エラーなし", async () => {
  const { h, pending } = await loadStartPending();
  pressAdd(h, "general");
  startEl(h, "text").value = "A";
  submitStart(h);
  h.start.close();
  pending[0]!.rej(apiError(503, "bot_disconnected"));
  await h.flush();
  assert.deepEqual(h.toasts, ["Discord につながっていません。少し待ってからもう一度試してください"]);
  pressAdd(h, "general");
  assert.equal(startEl(h, "text").value, "");
  assert.equal(startEl(h, "error").hidden, true);
  assert.equal(startEl(h, "text").getAttribute("aria-invalid"), null);
  assert.equal(startEl(h, "ok").disabled, false);
});

test("web static: v3 の始める口: 閉じたまま成功したら話題へ移らず、toast と一覧の読み直し。turn が failed なら書きかけに戻し、toast は失敗の 1 つだけ", async () => {
  const { h, pending, hash } = await loadStartPending();
  pressAdd(h, "general");
  startEl(h, "text").value = "A";
  submitStart(h);
  h.start.close();
  let reads = h.api.paths.length;
  pending[0]!.res(created());
  await h.flush();
  assert.equal(h.start.getAttribute("open"), null);
  assert.equal(h.app.activeTabId(), "ch:1");
  assert.equal(h.location.hash, hash);
  assert.deepEqual(h.toasts, ["話題「始めた」を始めました"]);
  assert.equal(topicReads(h, reads), 1);
  // turn が failed
  h.toasts = [];
  pressAdd(h, "general");
  startEl(h, "text").value = "送れなかった一言";
  submitStart(h);
  h.start.close();
  reads = h.api.paths.length;
  pending[1]!.res(created({ id: "ch:78", channelId: "78", title: "題", turn: "failed" }));
  await h.flush();
  assert.equal(h.app.draft("78"), "送れなかった一言");
  assert.equal(h.app.activeTabId(), "ch:1");
  assert.deepEqual(h.toasts, ["話題「題」を始めました。最初の一言は送れなかったので、入力欄に戻しました"]);
  assert.equal(topicReads(h, reads), 1);
});

for (const order of ["A が先に返る", "B が先に返る"] as const) {
  test(`web static: v3 の始める口: 開き直して B を送れ、B の応答はダイアログを閉じて話題を開く。先に送った A の応答は B の結果を壊さない（${order}）`, async () => {
    const { h, pending } = await loadStartPending();
    pressAdd(h, "general");
    startEl(h, "text").value = "A";
    submitStart(h);
    h.start.close();
    pressAdd(h, "general");
    startEl(h, "text").value = "B";
    submitStart(h);
    assert.equal(h.api.posts.length, 2, "2 回目の POST");
    assert.deepEqual(h.api.posts[1]!.body, { place: "general", text: "B" });
    assert.equal(startEl(h, "ok").disabled, true);
    // 同じ開きの中の 2 回目は送らない
    submitStart(h);
    assert.equal(h.api.posts.length, 2);
    const a = () => pending[0]!.res(created({ id: "ch:77", channelId: "77", title: "A の話" }));
    const b = () => pending[1]!.res(created({ id: "ch:78", channelId: "78", title: "B の話" }));
    if (order === "A が先に返る") {
      a();
      await h.flush();
      assert.equal(h.start.getAttribute("open"), "", "B を送っている間は開いたまま");
      assert.equal(startEl(h, "ok").disabled, true, "B を送っている間は無効のまま");
      assert.equal(h.app.activeTabId(), "ch:1");
      b();
      await h.flush();
      assert.deepEqual(h.toasts, ["話題「A の話」を始めました", "話題「B の話」を始めました"]);
    } else {
      b();
      await h.flush();
      assert.equal(h.app.activeTabId(), "ch:78");
      a();
      await h.flush();
      assert.deepEqual(h.toasts, ["話題「B の話」を始めました", "話題「A の話」を始めました"]);
    }
    assert.equal(h.start.getAttribute("open"), null);
    assert.equal(h.app.activeTabId(), "ch:78");
    assert.equal(h.location.hash, "#/ch/78");
  });
}

// ===== 場所を変える（M5c。#364）: 列 2 の帯の「場所 ∨」・シート「場所を変える」・確認・POST /api/topics/ch:<id>/place =====
const placeTopics = () => [
  ...startTopics().map((t) => ({ ...t, movable: t.group === "other" ? { reason: "端末のセッションは場所を変えられません" } : true })),
  v3Topic("ch:5", { group: "general", title: "済んだ", place: { dir: null }, state: "done", movable: { reason: "完了した話題は場所を変えられません" } }),
];
type PlaceShell = StartShell & { errors: string[]; topicList: Array<Record<string, unknown>>; confirm: DomNode & { close: () => void } };

async function loadPlace(opts: Parameters<typeof loadShell>[0] = {}): Promise<PlaceShell> {
  const h = loadShell(opts) as PlaceShell;
  await h.flush();
  h.topicList = placeTopics();
  h.api.reply = () => Promise.resolve(v3Result(h.topicList, { groups: startGroups() }));
  await h.topics.load();
  h.toasts = [];
  h.errors = [];
  h.ui.toast = (text: string, _action: unknown, o?: { level?: string }) => void (o && o.level === "error" ? h.errors : h.toasts).push(text);
  h.confirm = h.document.getElementById("dlg-confirm") as PlaceShell["confirm"];
  return h;
}
const placeBtn = (h: PlaceShell) => h.document.getElementById("v3-place") as DomNode & { disabled: boolean };
const placeLabel = (h: PlaceShell) => placeBtn(h).querySelector("span.v3-place-text")!;
const sheetRows = (h: PlaceShell) =>
  h.nodes.sheet.querySelectorAll("button.more-row").map((r) => ({
    label: textOf(r.querySelector("span.sb-label")!),
    why: r.querySelector("span.sb-meta") ? textOf(r.querySelector("span.sb-meta")!) : null,
    disabled: r.getAttribute("disabled") !== null,
    icon: r.querySelector("svg.icon")!.querySelector("use")!.getAttribute("href")!.replace(/^.*#/, ""),
  }));
const pickPlace = (h: PlaceShell, label: string) =>
  h.nodes.sheet
    .querySelectorAll("button.more-row")
    .find((r) => textOf(r.querySelector("span.sb-label")!) === label)!
    .dispatch("click");
const confirmText = (h: PlaceShell, part: string) => textOf(h.document.getElementById("dlg-confirm-" + part)!);
/** 話題を開いて、場所のボタン → 候補 → [変える] まで */
const movePlace = (h: PlaceShell, id: string, label: string) => {
  h.app.open(id);
  placeBtn(h).dispatch("click");
  pickPlace(h, label);
  h.document.getElementById("dlg-confirm-ok")!.dispatch("click");
};

test("web static: v3.html の場所は button で、type=button・aria-haspopup=dialog。dialog の数は M4b の後と同じ", () => {
  const html = read("v3.html");
  assert.match(html, /<div class="v3-bar" id="v3-bar" hidden>\s*<button class="btn btn-ghost btn-sm v3-place" id="v3-place" type="button" aria-haspopup="dialog" hidden><\/button>/);
  assert.equal(html.includes('<span class="v3-place'), false);
  assert.doesNotMatch(html.slice(html.indexOf('id="v3-place"') - 80, html.indexOf('id="v3-place"') + 80), /aria-label/);
  assert.equal(html.match(/<dialog\b/g)?.length, 3);
  for (const id of ["v3-sheet", "v3-start", "dlg-confirm"]) assert.match(html, new RegExp(`<dialog id="${id}"`), id);
});

test("web static: v3 の場所: movable が true の話題では押せる。理由があれば disabled で、title がその理由", async () => {
  const h = await loadPlace();
  h.app.open("ch:3");
  assert.equal(placeBtn(h).hidden, false);
  assert.equal(placeBtn(h).disabled, false);
  assert.equal(placeBtn(h).getAttribute("title"), null);
  assert.equal(textOf(placeLabel(h)), "場所: alpha");
  // 中は文字と矢印（飾り）。名前は見えている文字で、aria-label は付けない
  const [text, arrow] = kids(placeBtn(h));
  assert.equal(text, placeLabel(h));
  assert.equal(arrow!.getAttribute("aria-hidden"), "true");
  assert.match(arrow!.querySelector("use")!.getAttribute("href")!, /#chevron-down$/);
  assert.equal(placeBtn(h).getAttribute("aria-label"), null);
  for (const [id, reason] of [
    ["ch:4", "端末のセッションは場所を変えられません"],
    ["ch:5", "完了した話題は場所を変えられません"],
  ] as const) {
    h.app.open(id);
    assert.equal(placeBtn(h).disabled, true, id);
    assert.equal(placeBtn(h).getAttribute("title"), reason);
    // 押しても（ブラウザは disabled の click を出さないが）シートは開かない
    placeBtn(h).dispatch("click");
    assert.equal(h.nodes.sheet.getAttribute("open"), null);
  }
  // サーバーの理由をそのまま出す（画面に理由の文を持たない）
  h.topicList = h.topicList.map((t) => (t.id === "ch:5" ? { ...t, movable: { reason: "設定が済んでいません。端末で npm run unify-setup -- --print の行を実行して再起動してください" } } : t));
  await h.topics.load();
  assert.equal(placeBtn(h).getAttribute("title"), "設定が済んでいません。端末で npm run unify-setup -- --print の行を実行して再起動してください");
  // 押せる話題に戻ると title を外す
  h.app.open("ch:1");
  assert.equal(placeBtn(h).disabled, false);
  assert.equal(placeBtn(h).getAttribute("title"), null);
});

test("web static: v3 の場所: 一覧を読み直しても、ボタンと中の要素は同じ要素のまま。文字が同じなら書き換えない", async () => {
  const h = await loadPlace();
  h.app.open("ch:2");
  const button = placeBtn(h);
  const label = placeLabel(h);
  const arrow = kids(button)[1];
  let writes = 0;
  Object.defineProperty(label, "textContent", {
    get: () => label.text,
    set: (v: string) => {
      writes++;
      label.text = v;
    },
  });
  await h.topics.load();
  assert.equal(writes, 0);
  assert.equal(placeBtn(h), button);
  assert.deepEqual(kids(button), [label, arrow]);
  // 付け替えの途中: movable が理由つきになり押せない
  h.topicList = h.topicList.map((t) => (t.id === "ch:2" ? { ...t, movable: { reason: "場所を変えています" } } : t));
  await h.topics.load();
  assert.equal(writes, 0);
  assert.equal(button.disabled, true);
  assert.equal(button.getAttribute("title"), "場所を変えています");
  // 終わって place が変わったら帯の文字が新しい場所に変わる
  h.topicList = h.topicList.map((t) => (t.id === "ch:2" ? { ...t, group: "p:alpha", place: { dir: "alpha" }, movable: true } : t));
  await h.topics.load();
  assert.equal(writes, 1);
  assert.equal(textOf(label), "場所: alpha");
  assert.equal(button.disabled, false);
  assert.equal(button.getAttribute("title"), null);
  assert.deepEqual(kids(button), [label, arrow]);
});

test("web static: v3 の場所: 話題でない画面ではボタンを隠す", async () => {
  const h = await loadPlace();
  assert.equal(placeBtn(h).hidden, true, "起動の直後（何も開いていない）");
  h.app.open("ch:1");
  assert.equal(placeBtn(h).hidden, false);
  h.app.open("tasks");
  assert.equal(placeBtn(h).hidden, true);
  // スマホは話題でない画面でも帯を残す（[右腕] のため）が、場所は隠す
  const p = await loadPlace({ phone: true });
  p.app.open("tasks");
  assert.equal(p.nodes.bar.hidden, false);
  assert.equal(placeBtn(p).hidden, true);
  p.app.open("ch:3");
  assert.equal(placeBtn(p).hidden, false);
});

test("web static: v3 の場所: 押すとシート「場所を変える」が開き、候補は General が先頭でプロジェクトが続く。今の場所は押せない行で右に「今の場所」", async () => {
  const h = await loadPlace();
  h.app.open("ch:3");
  placeBtn(h).dispatch("click");
  assert.equal(h.nodes.sheet.getAttribute("open"), "");
  assert.equal(h.nodes.sheet.getAttribute("aria-label"), "場所を変える");
  assert.equal(textOf(h.nodes.sheet.querySelector("span.sheet-title")!), "場所を変える");
  assert.deepEqual(sheetRows(h), [
    { label: "General", why: null, disabled: false, icon: "circle" },
    { label: "alpha", why: "今の場所", disabled: true, icon: "check" },
    { label: "beta", why: null, disabled: false, icon: "circle" },
  ]);
  // 焦点は押せる最初の行
  assert.equal(h.document.activeElement, h.nodes.sheet.querySelectorAll("button.more-row")[0]);
  // General の話題は General が今の場所
  h.nodes.sheet.removeAttribute("open");
  h.app.open("ch:1");
  placeBtn(h).dispatch("click");
  assert.deepEqual(
    sheetRows(h).map((r) => [r.label, r.disabled, r.why]),
    [
      ["General", true, "今の場所"],
      ["alpha", false, null],
      ["beta", false, null],
    ],
  );
});

test("web static: v3 の場所: 場所なしの話題では、押せない行が無く General も選べる", async () => {
  const h = await loadPlace();
  h.app.open("ch:2");
  placeBtn(h).dispatch("click");
  assert.deepEqual(
    sheetRows(h).map((r) => [r.label, r.disabled, r.why]),
    [
      ["General", false, null],
      ["alpha", false, null],
      ["beta", false, null],
    ],
  );
});

test("web static: v3 の場所: 候補を選ぶと確認が出る。題は「場所を変えますか」・対象は題名・ボタンは「変える」・本文に前と新しい場所の名前", async () => {
  const h = await loadPlace();
  h.app.open("ch:3");
  placeBtn(h).dispatch("click");
  pickPlace(h, "beta");
  assert.equal(h.nodes.sheet.getAttribute("open"), null, "シートは閉じる");
  assert.equal(h.confirm.getAttribute("open"), "");
  assert.equal(confirmText(h, "title"), "場所を変えますか");
  assert.equal(confirmText(h, "target"), "「作業」");
  assert.equal(confirmText(h, "ok"), "変える");
  assert.match(confirmText(h, "body"), /^場所を alpha から beta に変えます。/);
  assert.equal(h.document.activeElement, h.document.getElementById("dlg-confirm-ok"));
  assert.equal(h.api.posts.length, 0, "確認の前には送らない");
});

test("web static: v3 の場所: 場所なしの話題の確認は「場所なしには戻せません」、ほかは「あとで戻せます」", async () => {
  const h = await loadPlace();
  h.app.open("ch:2");
  placeBtn(h).dispatch("click");
  pickPlace(h, "General");
  assert.equal(confirmText(h, "body"), "場所を なし から General に変えます。会話の記録はこのまま残り、担当には要点を引き継ぎます。場所なしには戻せません");
  h.document.getElementById("dlg-confirm-cancel")!.dispatch("click");
  h.app.open("ch:1");
  placeBtn(h).dispatch("click");
  pickPlace(h, "alpha");
  assert.equal(confirmText(h, "body"), "場所を General から alpha に変えます。ファイルは動かしません。会話の記録はこのまま残り、担当には要点を引き継ぎます。あとで戻せます");
  h.document.getElementById("dlg-confirm-cancel")!.dispatch("click");
  assert.equal(h.api.posts.length, 0, "[やめる] は送らない");
});

test("web static: v3 の場所: [変える] は POST /api/topics/ch:<id>/place に { place } を 1 回だけ送る。パスの : を % にしない", async () => {
  const h = await loadPlace();
  h.api.postReply = () => Promise.resolve({ accepted: true });
  movePlace(h, "ch:3", "General");
  assert.deepEqual(h.api.posts, [{ path: "/api/topics/ch:3/place", body: { place: "general" }, opts: { quiet: true } }]);
  assert.equal(h.api.posts[0]!.path.includes("%"), false);
  assert.equal(h.confirm.getAttribute("open"), null);
  await h.flush();
  movePlace(h, "ch:2", "beta");
  assert.deepEqual(h.api.posts[1], { path: "/api/topics/ch:2/place", body: { place: "p:beta" }, opts: { quiet: true } });
  assert.equal(h.api.posts.length, 2);
});

test("web static: v3 の場所: 受け付けたら toast を出し、一覧を読み直す", async () => {
  const h = await loadPlace();
  h.api.postReply = () => Promise.resolve({ accepted: true });
  const reads = h.api.paths.length;
  movePlace(h, "ch:2", "alpha");
  await h.flush();
  assert.deepEqual(h.toasts, ["場所を alpha に変えています。要点をまとめるので少しかかります"]);
  assert.deepEqual(h.errors, []);
  assert.equal(topicReads(h, reads), 1);
});

test("web static: v3 の場所: 失敗は error の値ごとの文を toast に出す。HTTP の番号・error の値は画面に出ない", async () => {
  const cases: Array<[Error, string]> = [
    [apiError(409, "busy"), "担当が作業中です。終わってから変えてください"],
    [apiError(409, "closing"), "閉じる途中です。終わってから変えてください"],
    [apiError(409, "moving"), "場所を変えています。終わるまで待ってください"],
    [apiError(409, "closed"), "完了した話題は場所を変えられません"],
    [apiError(409, "persona"), "足した人格の話題は場所を変えられません"],
    [apiError(409, "cc_disabled"), "場所を変えるには Claude Code の連携が要ります"],
    [apiError(503, "unify_not_ready"), "設定が済んでいません。端末で npm run unify-setup -- --print の行を実行して再起動してください"],
    [apiError(400, "invalid_project"), "その場所は使えません"],
    [apiError(400, "bad_request"), "その場所は使えません"],
    [apiError(409, "same_place"), "もうその場所です"],
    [apiError(404, "not_found"), "この話題は場所を変えられません"],
    [apiError(0, null), "サーバーにつながりません"],
    [apiError(500, "internal"), "場所を変えられませんでした。もう一度試してください"],
  ];
  const h = await loadPlace();
  for (const [err, text] of cases) {
    h.errors = [];
    h.api.postReply = () => Promise.reject(err);
    const reads = h.api.paths.length;
    movePlace(h, "ch:3", "beta");
    await h.flush();
    assert.deepEqual(h.errors, [text]);
    const { status, code } = err as Error & { status: number; code: string | null };
    if (status !== 0) assert.equal(text.includes(String(status)), false, "HTTP の番号");
    if (code) assert.equal(text.includes(code), false, "error の値");
    assert.equal(topicReads(h, reads), 0, "失敗では読み直さない");
  }
  assert.deepEqual(h.toasts, []);
  assert.equal(h.api.posts.length, cases.length, "失敗の後はまた送れる");
});

test("web static: v3 の場所: 送っている間は 2 回送らない", async () => {
  const h = await loadPlace();
  const pending: Array<(v: unknown) => void> = [];
  h.api.postReply = () => new Promise((r) => void pending.push(r));
  movePlace(h, "ch:3", "beta");
  movePlace(h, "ch:3", "General");
  assert.equal(h.api.posts.length, 1, "同じ話題の 2 回目は送らない");
  // 別の話題は送れる
  movePlace(h, "ch:1", "alpha");
  assert.deepEqual(
    h.api.posts.map((p) => p.path),
    ["/api/topics/ch:3/place", "/api/topics/ch:1/place"],
  );
  pending[0]!({ accepted: true });
  await h.flush();
  // 返った後は同じ話題にまた送れる
  movePlace(h, "ch:3", "General");
  assert.equal(h.api.posts.length, 3);
  pending[1]!({ accepted: true });
  pending[2]!({ accepted: true });
  await h.flush();
  assert.equal(h.toasts.length, 3);
});

test("web static: v3 の場所: 送っている間に別の話題を開いてから応答が返っても、今の話題の帯・シート・確認に触らない", async () => {
  const h = await loadPlace();
  const pending: Array<{ res: (v: unknown) => void; rej: (e: unknown) => void }> = [];
  h.api.postReply = () => new Promise((res, rej) => void pending.push({ res, rej }));
  movePlace(h, "ch:3", "beta");
  movePlace(h, "ch:2", "alpha");
  // 別の話題を開いて、シートを開いておく
  h.app.open("ch:1");
  placeBtn(h).dispatch("click");
  const rows = sheetRows(h);
  pending[0]!.res({ accepted: true });
  pending[1]!.rej(apiError(409, "busy"));
  await h.flush();
  assert.equal(h.app.activeTabId(), "ch:1");
  assert.equal(textOf(placeLabel(h)), "場所: General");
  assert.equal(placeBtn(h).disabled, false);
  assert.equal(h.nodes.sheet.getAttribute("open"), "", "シートは開いたまま");
  assert.deepEqual(sheetRows(h), rows);
  assert.equal(h.confirm.getAttribute("open"), null);
  assert.deepEqual(h.toasts, ["場所を beta に変えています。要点をまとめるので少しかかります"]);
  assert.deepEqual(h.errors, ["担当が作業中です。終わってから変えてください"]);
});

test("web static: v3 の場所: 確認が閉じたら場所のボタンに焦点が戻る", async () => {
  const h = await loadPlace();
  h.api.postReply = () => Promise.resolve({ accepted: true });
  h.app.open("ch:3");
  const open = () => {
    placeBtn(h).dispatch("click");
    pickPlace(h, "beta");
    assert.equal(h.confirm.getAttribute("open"), "");
    assert.notEqual(h.document.activeElement, placeBtn(h));
  };
  // [やめる]
  open();
  h.document.getElementById("dlg-confirm-cancel")!.dispatch("click");
  assert.equal(h.confirm.getAttribute("open"), null);
  assert.equal(h.document.activeElement, placeBtn(h));
  // Escape（<dialog> の素の動きで close）
  open();
  h.confirm.close();
  assert.equal(h.document.activeElement, placeBtn(h));
  // [変える]
  open();
  h.document.getElementById("dlg-confirm-ok")!.dispatch("click");
  assert.equal(h.document.activeElement, placeBtn(h));
  await h.flush();
  // 1 回の確認ごとに付けた listener は閉じたら外す（後の close で焦点を動かさない）
  assert.equal((h.confirm.listeners.get("close") ?? []).length, 0);
  const other = h.nodes.handOpen;
  other.focus();
  h.confirm.setAttribute("open", "");
  h.confirm.close();
  assert.equal(h.document.activeElement, other);
});

test("web static: v3 の場所の CSS: 文字だけを 1 行で省略し、押せないときは薄くせず矢印を出さない。スマホは --tap の高さ", () => {
  const css = read("shell.css");
  const block = (src: string, sel: string) => src.slice(src.indexOf(sel + " {"), src.indexOf("}", src.indexOf(sel + " {")));
  assert.match(block(css, "\n.v3-place"), /min-width: 0;/);
  assert.match(block(css, "\n.v3-place"), /color: var\(--text-secondary\);/);
  assert.doesNotMatch(block(css, "\n.v3-place"), /overflow|ellipsis/);
  assert.match(block(css, "\n.v3-place-text"), /overflow: hidden;\s*text-overflow: ellipsis;\s*white-space: nowrap;/);
  assert.match(block(css, "\n.v3-place:disabled"), /opacity: 1;\s*cursor: default;/);
  assert.match(block(css, "\n.v3-place:disabled .icon"), /display: none;/);
  const phone = css.slice(css.indexOf("@media (max-width: 639px)"));
  assert.match(block(phone, "  .v3-place"), /min-height: var\(--tap\);/);
});

const closeListeners = (h: PlaceShell) => (h.confirm.listeners.get("close") ?? []).length;

test("web static: v3 の場所: 確認の間に場所のボタンが押せなくなった・隠れたら、閉じても焦点を戻さない", async () => {
  // 押せなくなった（一覧の読み直しで movable が理由に変わった）
  const h = await loadPlace();
  h.app.open("ch:3");
  placeBtn(h).focus();
  placeBtn(h).dispatch("click");
  pickPlace(h, "beta");
  h.topicList = h.topicList.map((t) => (t.id === "ch:3" ? { ...t, movable: { reason: "場所を変えています" } } : t));
  await h.topics.load();
  assert.equal(placeBtn(h).disabled, true);
  assert.notEqual(h.document.activeElement, placeBtn(h));
  h.document.getElementById("dlg-confirm-cancel")!.dispatch("click");
  assert.equal(h.confirm.getAttribute("open"), null);
  assert.notEqual(h.document.activeElement, placeBtn(h));
  assert.equal(closeListeners(h), 0);
  // 隠れた（話題でない画面に移った）
  const g = await loadPlace();
  g.app.open("ch:3");
  placeBtn(g).focus();
  placeBtn(g).dispatch("click");
  pickPlace(g, "beta");
  g.app.open("tasks");
  assert.equal(placeBtn(g).hidden, true);
  assert.notEqual(g.document.activeElement, placeBtn(g));
  g.document.getElementById("dlg-confirm-cancel")!.dispatch("click");
  assert.equal(g.confirm.getAttribute("open"), null);
  assert.notEqual(g.document.activeElement, placeBtn(g));
  assert.equal(closeListeners(g), 0);
});

test("web static: v3 の場所: シートを開いた後に話題が一覧から消えたら、行を押しても確認を開かない", async () => {
  const h = await loadPlace();
  h.api.postReply = () => Promise.resolve({ accepted: true });
  h.app.open("ch:3");
  placeBtn(h).dispatch("click");
  h.topicList = h.topicList.filter((t) => t.id !== "ch:3");
  await h.topics.load();
  pickPlace(h, "beta");
  await h.flush();
  assert.equal(h.confirm.getAttribute("open"), null);
  assert.equal(h.api.posts.length, 0);
  assert.equal(closeListeners(h), 0);
});

test("web static: v3 の場所: close が後から届いても（本物の <dialog> の順）、[変える] は送り、届いたら焦点を戻して listener を外す", async () => {
  const h = await loadPlace();
  h.api.postReply = () => Promise.resolve({ accepted: true });
  // このテストだけ: close() は open を外し、close の event は積むだけ（後で流す）
  const later: Array<() => void> = [];
  h.confirm.close = () => {
    if (h.confirm.getAttribute("open") === null) return;
    h.confirm.removeAttribute("open");
    later.push(() => h.confirm.dispatch("close"));
  };
  h.app.open("ch:3");
  placeBtn(h).dispatch("click");
  pickPlace(h, "beta");
  h.document.getElementById("dlg-confirm-ok")!.dispatch("click");
  assert.equal(h.confirm.getAttribute("open"), null);
  assert.equal(h.api.posts.length, 1, "close の event を待たずに送る");
  assert.equal(closeListeners(h), 1, "焦点を戻す listener は event まで残る");
  assert.equal(later.length, 1);
  for (const fn of later.splice(0)) fn();
  assert.equal(h.document.activeElement, placeBtn(h));
  assert.equal(closeListeners(h), 0);
  await h.flush();
  assert.deepEqual(h.toasts, ["場所を beta に変えています。要点をまとめるので少しかかります"]);
});

// ===== 右腕の場所を変える確認のカード（M6g。chat.js の moveCard） =====

const MOVE_PROPOSAL = { id: 7, from: "なし", to: "beta", expiresAt: "2026-11-14T00:10:00.000Z" };

/** 確認のある話題（200）を描き、カードを返す（会話のタブは 2 つの殻とも views.info("ch:<id>") の render で描く） */
function renderMoveCard(proposal: unknown = MOVE_PROPOSAL) {
  const c = loadChat();
  c.put("200", [chatTurn(10, "notice", "場所を なし から beta に変える確認を出しました")], { kind: "session", state: "active", title: "家計簿", moveProposal: proposal });
  const box = c.box();
  const views = (c.context.window as { SA: { views: { info: (tab: string) => { render: (container: DomNode) => void } | null } } }).SA.views;
  views.info("ch:200")!.render(box);
  const card = box.querySelector('section[aria-label="場所を変える確認"]');
  const button = (label: string) => card!.buttons().find((b) => b.textContent === label) as (DomNode & { disabled?: boolean }) | undefined;
  return { c, box, card, button };
}

test("web static: 場所を変える確認のカードは、今の画面（index.html）と新しい殻（v3.html）の両方が読む chat.js・views.js にある", () => {
  for (const html of ["index.html", "v3.html"]) {
    const text = read(html);
    for (const js of ["chat.js", "views.js"]) assert.match(text, new RegExp(`<script src="/static/${js.replace(".", "\\.")}" defer></script>`), `${html}: ${js}`);
  }
  // 2 つの殻はどちらも会話のタブを views.info の render で描き、views.info("ch:<id>") は chat.js の info
  assert.match(read("workbench.js"), /SA\.views\.info\(/);
  assert.match(read("shell.js"), /SA\.views\.info\(/);
  assert.match(read("views.js"), /SA\.chat\.info\(channelId\)/);
});

test("web static: moveProposal があると確認のカードが出て、今の場所・変える先・[変える][このまま] がある", () => {
  const { card, button } = renderMoveCard();
  assert.ok(card, "カードが出る");
  assert.ok(card.classes.has("card") && card.classes.has("card-sm"));
  assert.equal(card.querySelector("h2")!.textContent, "場所を変える確認");
  assert.equal(card.querySelector("span.meta")!.textContent, "Discord でも選べます");
  const facts = card.querySelector("dl.card-facts")!;
  assert.deepEqual(facts.querySelectorAll("dt").map((n) => n.textContent), ["今の場所", "変える先"]);
  assert.deepEqual(facts.querySelectorAll("dd").map((n) => n.textContent), ["なし", "beta"]);
  assert.match(card.textContent, /会話は新しくなり、担当には要点を引き継ぎます。記録はこのまま残ります。ファイルは動かしません。/);
  assert.ok(card.querySelector("div.msg-actions"));
  assert.ok(button("変える")!.classes.has("btn-primary"));
  assert.ok(button("このまま")!.classes.has("btn-secondary"));
});

test("web static: moveProposal が null ならカードは出ない", () => {
  const { card } = renderMoveCard(null);
  assert.equal(card, null);
});

test("web static: [変える] を押すと /api/topics/moves/<id>/accept に POST し、ボタンが disabled になる。成功のトーストと読み直し", async () => {
  const { c, button } = renderMoveCard();
  const ok = button("変える")!;
  const keep = button("このまま")!;
  ok.dispatch("click");
  assert.equal(ok.disabled, true);
  assert.equal(keep.disabled, true);
  await c.flush();
  assert.deepEqual(JSON.parse(JSON.stringify(c.posts)), [{ path: "/api/topics/moves/7/accept", body: {} }]);
  assert.deepEqual(c.toasts, ["場所を変えています"]);
  assert.deepEqual(c.loads, ["200", "channels"]);
});

test("web static: [このまま] を押すと /api/topics/moves/<id>/keep に POST する", async () => {
  const { c, button } = renderMoveCard();
  button("このまま")!.dispatch("click");
  await c.flush();
  assert.deepEqual(JSON.parse(JSON.stringify(c.posts)), [{ path: "/api/topics/moves/7/keep", body: {} }]);
  assert.deepEqual(c.toasts, ["場所はこのままにしました"]);
  assert.deepEqual(c.loads, ["200", "channels"]);
});

test("web static: 409（stale）のとき「この確認はもう使えません」を出し、読み直す。ほかの断りは応答の message", async () => {
  const { c, button } = renderMoveCard();
  const api = (c.context.window as { SA: { api: { post: unknown } } }).SA.api;
  api.post = () => Promise.reject(Object.assign(new Error("409: stale"), { status: 409, code: "stale", data: { error: "stale" }, toast: "操作に失敗しました。もう一度試してください" }));
  button("変える")!.dispatch("click");
  await c.flush();
  assert.deepEqual(c.toasts, ["この確認はもう使えません"]);
  assert.deepEqual(c.loads, ["200", "channels"]);

  const other = renderMoveCard();
  const otherApi = (other.c.context.window as { SA: { api: { post: unknown } } }).SA.api;
  otherApi.post = () =>
    Promise.reject(Object.assign(new Error("409: busy"), { status: 409, code: "busy", data: { error: "busy", message: "作業中です" }, toast: "操作に失敗しました。もう一度試してください" }));
  other.button("変える")!.dispatch("click");
  await other.c.flush();
  assert.deepEqual(other.c.toasts, ["作業中です"]);
  assert.deepEqual(other.c.loads, ["200", "channels"]);
});

test("web static: 確認のカードの文は文字のまま出す（from・to にタグの形の文字を入れても要素にならない）", () => {
  const { card } = renderMoveCard({ id: 7, from: "<b>x</b>", to: "<img src=x onerror=alert(1)>", expiresAt: "2026-11-14T00:10:00.000Z" });
  const dd = card!.querySelectorAll("dd");
  assert.deepEqual(dd.map((n) => n.textContent), ["<b>x</b>", "<img src=x onerror=alert(1)>"]);
  assert.equal(card!.querySelectorAll("b").length, 0);
  assert.equal(card!.querySelectorAll("img").length, 0);
  assert.doesNotMatch(fnSource(read("chat.js"), "moveCard"), /innerHTML|insertAdjacentHTML/);
});

test("web static: api.js の updateChannel は moveProposal を一覧に持ち続けない", async () => {
  const h = loadApi(() =>
    Promise.resolve({
      channel: { id: "1", kind: "session", state: "active", last: null, closeDraft: null, moveProposal: MOVE_PROPOSAL },
      turns: [],
    }),
  );
  (h.SA.chat as Record<string, unknown>).channelsChanged = () => undefined;
  const store = h.SA.store as { channels: { channels: Array<Record<string, unknown>> }; turns: Record<string, { channel: Record<string, unknown> }>; load: { turns: (id: string) => Promise<unknown> } };
  store.channels = { channels: [{ id: "1", kind: "session", state: "active", last: null }] };
  assert.equal(await store.load.turns("1"), null);
  // 会話の channel には残り（カードを描く）、一覧の 1 件には入れない
  assert.deepEqual(store.turns["1"]!.channel.moveProposal, MOVE_PROPOSAL);
  assert.equal("moveProposal" in store.channels.channels[0]!, false);
  assert.equal("closeDraft" in store.channels.channels[0]!, false);
});

// ===== 周期の読み直しで場所を変える確認が変わったら描き直す（M6g。api.js の store.load.turns） =====

/** loadApiM0 と同じ作りで、/turns の channel の moveProposal を差し替えられ、SA.app.refresh の呼び出しを数える（行は増やさない） */
function loadApiMove() {
  const context = {
    window: { addEventListener: () => undefined, localStorage: { getItem: () => null, setItem: () => undefined } } as Record<string, unknown>,
    document: { visibilityState: "visible", addEventListener: () => undefined },
    setTimeout: () => 0,
    clearTimeout: () => undefined,
    Intl,
    Date,
    Number,
    JSON,
  };
  vm.runInNewContext(read("api.js"), context);
  const SA = (context.window as { SA: Record<string, unknown> }).SA;
  const refreshes: string[] = [];
  SA.app = { refresh: (tab: string) => refreshes.push(tab), refreshSidebar: () => undefined, refreshTabs: () => undefined, addOutput: () => undefined, activeTabId: () => null };
  SA.chat = { channelsChanged: () => undefined, current: () => null, channelTitle: () => "会話", endText: () => "" };
  let moveProposal: unknown = null;
  (SA.api as { get: unknown }).get = (path: string) => {
    const turns = path.includes("after=") ? [] : [{ id: 1, kind: "owner", text: "やって", outcome: null }];
    // 毎回新しい channel の物（サーバーの応答と同じ）
    return Promise.resolve({ turns, channel: { id: "200", kind: "session", state: "active", title: "家計簿", permission: null, closeDraft: null, moveProposal: JSON.parse(JSON.stringify(moveProposal)) } });
  };
  const store = SA.store as { load: { turns: (channelId: string) => Promise<unknown> } };
  return { store, refreshes, setMove: (value: unknown) => (moveProposal = value) };
}

test("web static: 行が増えずに moveProposal が あり → null になったら会話を描き直す", async () => {
  const h = loadApiMove();
  h.setMove(MOVE_PROPOSAL);
  await h.store.load.turns("200");
  h.refreshes.length = 0;
  h.setMove(null);
  await h.store.load.turns("200");
  assert.deepEqual(h.refreshes, ["ch:200"]);
});

test("web static: 行が増えずに moveProposal が null → あり になっても会話を描き直す", async () => {
  const h = loadApiMove();
  await h.store.load.turns("200");
  h.refreshes.length = 0;
  h.setMove(MOVE_PROPOSAL);
  await h.store.load.turns("200");
  assert.deepEqual(h.refreshes, ["ch:200"]);
});

test("web static: moveProposal が同じ中身のままなら、それだけでは描き直さない", async () => {
  const h = loadApiMove();
  h.setMove(MOVE_PROPOSAL);
  await h.store.load.turns("200");
  h.refreshes.length = 0;
  await h.store.load.turns("200");
  assert.deepEqual(h.refreshes, []);
});

// ===== 既読をサーバーに（M7b。#378。api.js の store.seen・markSeen・syncReads、shell.js の readingChannelIds、topics.js の syncReads） =====

type ReadPost = { path: string; body: { lastId: number }; opts: unknown; resolve: (v: unknown) => void; reject: (e: unknown) => void };

/** api.js をまるごと読む。localStorage は Map（setItem・removeItem の鍵を覚える）、SA.api.post は呼ばれた順に覚えて手で返す、GET /api/channels は channels の値を返す */
function loadApiReads(opts: { storage?: Record<string, string> } = {}) {
  const storage = new Map<string, string>(Object.entries(opts.storage ?? {}));
  const writes: string[] = [];
  const removes: string[] = [];
  const localStorage = {
    getItem: (k: string) => storage.get(k) ?? null,
    setItem: (k: string, v: string) => {
      writes.push(k);
      storage.set(k, String(v));
    },
    removeItem: (k: string) => {
      removes.push(k);
      storage.delete(k);
    },
  };
  const winListeners: string[] = [];
  // sidebarSeen: refreshSidebar が呼ばれた時点の store.seen の写し
  const calls = { sidebar: 0, status: 0, sidebarSeen: [] as Array<Record<string, number>> };
  const SA: Record<string, unknown> = {
    app: {
      shownChannelIds: () => [],
      readingChannelIds: () => [],
      activeTabId: () => null,
      refresh: () => undefined,
      refreshStatus: () => {
        calls.status++;
      },
      refreshSidebar: () => {
        calls.sidebar++;
        const st = SA.store as { seen?: Record<string, number> } | undefined;
        calls.sidebarSeen.push(JSON.parse(JSON.stringify((st && st.seen) ?? {})));
      },
      refreshActivity: () => undefined,
      pruneDrafts: () => undefined,
    },
    chat: { markSeenShown: () => undefined, channelsChanged: () => undefined },
    ui: { toast: () => undefined },
  };
  const ctx: Record<string, unknown> = {
    window: { SA, localStorage, addEventListener: (type: string) => winListeners.push(type) },
    document: { visibilityState: "visible", addEventListener: () => undefined },
    setTimeout: () => 0,
    clearTimeout: () => undefined,
    Promise,
    JSON,
  };
  vm.runInNewContext(read("api.js"), ctx);
  const posts: ReadPost[] = [];
  let channels: unknown = { guilds: [], personas: [], channels: [] };
  const api = SA.api as { get: unknown; post: unknown };
  api.get = () => Promise.resolve(JSON.parse(JSON.stringify(channels)));
  api.post = (path: string, body: { lastId: number }, o: unknown) =>
    new Promise((resolve, reject) => posts.push({ path, body: JSON.parse(JSON.stringify(body)), opts: JSON.parse(JSON.stringify(o ?? null)), resolve, reject }));
  const store = SA.store as {
    seen: Record<string, number>;
    markSeen: (id: string, last: number) => boolean;
    syncReads: (reads: unknown, ids: string[]) => boolean;
    isUnread: (c: unknown) => boolean;
    load: { channels: (o?: unknown) => Promise<unknown> };
  };
  const flush = async () => {
    for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r));
  };
  const seen = () => JSON.parse(JSON.stringify(store.seen)) as Record<string, number>;
  const sent = () => posts.map((p) => [p.path, p.body.lastId]);
  const fail = (status: number) => Object.assign(new Error(String(status)), { status });
  return { store, posts, sent, seen, storage, writes, removes, winListeners, calls, flush, fail, setChannels: (v: unknown) => (channels = v) };
}

const OLD_SEEN = "self-agent-web:seen";
const SEEN_SENT = "self-agent-web:seen-sent";
const readPath = (id: string) => "/api/topics/ch:" + id + "/read";

test("web static: 既読の始めは、旗が無ければ古い鍵の値（数でない値は落とす）、旗が \"1\" なら古い鍵があっても空", () => {
  const h = loadApiReads({ storage: { [OLD_SEEN]: JSON.stringify({ "1": 10, "2": "x", "3": 0 }) } });
  assert.deepEqual(h.seen(), { "1": 10 });
  const sent = loadApiReads({ storage: { [OLD_SEEN]: JSON.stringify({ "1": 10 }), [SEEN_SENT]: "1" } });
  assert.deepEqual(sent.seen(), {});
  assert.deepEqual(loadApiReads({ storage: { [OLD_SEEN]: "{壊れた" } }).seen(), {});
  assert.deepEqual(loadApiReads().seen(), {});
});

test("web static: markSeen は進めば POST /api/topics/ch:<id>/read に { lastId } を quiet で送って true、進まなければ送らず false、数字でない ID は送らない", () => {
  const h = loadApiReads();
  assert.equal(h.store.markSeen("100", 5), true);
  assert.deepEqual(
    h.posts.map((p) => ({ path: p.path, body: p.body, opts: p.opts })),
    [{ path: "/api/topics/ch:100/read", body: { lastId: 5 }, opts: { quiet: true } }],
  );
  assert.equal(h.store.markSeen("100", 5), false);
  assert.equal(h.store.markSeen("100", 4), false);
  assert.equal(h.posts.length, 1);
  // 数字でない ID はメモリだけ進め、送らない（: を % にしないこともパスで見ている）
  assert.equal(h.store.markSeen("abc", 3), true);
  assert.equal(h.store.markSeen("1/../x", 3), true);
  assert.equal(h.posts.length, 1);
  assert.equal(h.seen().abc, 3);
});

test("web static: 送っている間にもう 1 度進んでも同時には送らず、返った後に新しい値で 1 回送る", async () => {
  const h = loadApiReads();
  h.store.markSeen("100", 5);
  h.store.markSeen("100", 7);
  h.store.markSeen("100", 8);
  assert.deepEqual(h.sent(), [[readPath("100"), 5]]);
  h.posts[0]!.resolve({ lastReadId: 5 });
  await h.flush();
  assert.deepEqual(h.sent(), [[readPath("100"), 5], [readPath("100"), 8]]);
  h.posts[1]!.resolve({ lastReadId: 8 });
  await h.flush();
  assert.equal(h.posts.length, 2, "追いついたら送らない");
  // ほかの会話は別に送る
  h.store.markSeen("200", 1);
  assert.equal(h.posts.length, 3);
});

test("web static: 送れなかった既読は次の syncReads で送り直し、400・404 の後は同じページでは送らない", async () => {
  const h = loadApiReads();
  h.store.markSeen("100", 5);
  h.posts[0]!.reject(h.fail(0));
  await h.flush();
  assert.equal(h.posts.length, 1, "すぐには送り直さない");
  assert.equal(h.seen()["100"], 5, "メモリには残る");
  assert.equal(h.store.syncReads({}, ["100"]), false);
  assert.deepEqual(h.sent().at(-1), [readPath("100"), 5]);
  h.posts[1]!.resolve({ lastReadId: 5 });
  await h.flush();
  // 200 が返った値は、サーバーの reads にまだ無くても送り直さない
  assert.equal(h.store.syncReads({}, ["100"]), true);
  assert.equal(h.posts.length, 2);
  // 404 の後は、進めても syncReads でも送らない
  h.store.markSeen("300", 2);
  h.posts[2]!.reject(h.fail(404));
  await h.flush();
  assert.equal(h.store.markSeen("300", 3), true);
  h.store.syncReads({}, ["300"]);
  assert.equal(h.posts.length, 3);
  // 400 も同じ
  h.store.markSeen("400", 2);
  h.posts[3]!.reject(h.fail(400));
  await h.flush();
  h.store.markSeen("400", 3);
  assert.equal(h.posts.length, 4);
});

test("web static: 応答の lastReadId がこちらより大きければ store.seen を上げて描き直す（小さければ下げない）", async () => {
  const h = loadApiReads();
  h.store.markSeen("100", 5);
  const before = h.calls.sidebar;
  h.posts[0]!.resolve({ lastReadId: 9 });
  await h.flush();
  assert.equal(h.seen()["100"], 9);
  assert.equal(h.calls.sidebar, before + 1);
  assert.equal(h.posts.length, 1, "サーバーの方が進んでいれば送らない");
  h.store.markSeen("200", 5);
  h.posts[1]!.resolve({ lastReadId: 3 });
  await h.flush();
  assert.equal(h.seen()["200"], 5);
  assert.equal(h.posts.length, 2);
});

test("web static: syncReads は reads の大きい値を取り込み（下げない）、自分の方が大きい ids の会話だけを送り、残りの有無を返す", () => {
  const h = loadApiReads({ storage: { [OLD_SEEN]: JSON.stringify({ "1": 10, "2": 20, "3": 30, "9": 90 }) } });
  // reads が無い（古いサーバー）・形が違う: 何もせず false
  assert.equal(h.store.syncReads(undefined, ["1"]), false);
  assert.equal(h.store.syncReads(null, ["1"]), false);
  assert.equal(h.store.syncReads([1], ["1"]), false);
  assert.equal(h.posts.length, 0);
  assert.deepEqual(h.seen(), { "1": 10, "2": 20, "3": 30, "9": 90 });
  // 1 は上がる・2 は下げない（送る）・3 はサーバーに無い（送る）・4 は新しく入る・9 は ids に無いので送らない
  assert.equal(h.store.syncReads({ "1": 15, "2": 5, "4": 40 }, ["1", "2", "3", "4"]), false);
  assert.deepEqual(h.seen(), { "1": 15, "2": 20, "3": 30, "4": 40, "9": 90 });
  assert.deepEqual(h.sent(), [[readPath("2"), 20], [readPath("3"), 30]]);
  // 残りが無ければ true（送らない）
  const done = loadApiReads();
  assert.equal(done.store.syncReads({ "1": 3 }, ["1", "2"]), true);
  assert.equal(done.posts.length, 0);
  assert.equal(done.seen()["1"], 3);
});

test("web static: load.channels は reads を取り込み、残りが無くなった回に旗を書く。reads の無い応答では書かない。古い鍵には書かない・消さない", async () => {
  const h = loadApiReads({ storage: { [OLD_SEEN]: JSON.stringify({ "1": 10, "2": 20, "77": 70 }) } });
  // reads の無い応答（M7a の前のサーバー）
  h.setChannels({ guilds: [], personas: [], channels: [{ id: "1" }, { id: "2" }] });
  await h.store.load.channels();
  assert.equal(h.storage.has(SEEN_SENT), false);
  assert.equal(h.posts.length, 0);
  // 2 だけサーバーより進んでいる: 送るが、まだ旗は書かない（一覧に無い 77 は送らない）
  h.setChannels({ guilds: [], personas: [], channels: [{ id: "1" }, { id: "2" }], reads: { "1": 12, "2": 5 } });
  await h.store.load.channels();
  assert.deepEqual(h.sent(), [[readPath("2"), 20]]);
  assert.equal(h.storage.has(SEEN_SENT), false);
  assert.equal(h.seen()["1"], 12);
  // 返らないうちは残りのまま（送っている最中は送り直さない）
  await h.store.load.channels();
  assert.equal(h.posts.length, 1);
  assert.equal(h.storage.has(SEEN_SENT), false);
  h.posts[0]!.resolve({ lastReadId: 20 });
  await h.flush();
  await h.store.load.channels();
  assert.equal(h.storage.get(SEEN_SENT), "1");
  // 次の回は書き直さない
  const writes = h.writes.length;
  h.setChannels({ guilds: [], personas: [], channels: [{ id: "1" }, { id: "2" }], reads: { "1": 12, "2": 20 } });
  await h.store.load.channels();
  assert.equal(h.writes.length, writes);
  // 既読を進めても localStorage には書かない
  h.store.markSeen("1", 99);
  assert.equal(h.writes.includes(OLD_SEEN), false);
  assert.equal(h.removes.includes(OLD_SEEN), false);
  assert.equal(h.storage.get(OLD_SEEN), JSON.stringify({ "1": 10, "2": 20, "77": 70 }));
  // 一覧の応答が reads 込みで最初から揃っていれば、1 回目で旗
  const fresh = loadApiReads({ storage: { [OLD_SEEN]: JSON.stringify({ "1": 10 }) } });
  fresh.setChannels({ guilds: [], personas: [], channels: [{ id: "1" }], reads: { "1": 10 } });
  await fresh.store.load.channels();
  assert.equal(fresh.storage.get(SEEN_SENT), "1");
  assert.equal(fresh.posts.length, 0);
});

test("web static: load.channels は refreshSidebar より前に reads を store.seen に取り込む", async () => {
  const h = loadApiReads({ storage: { [OLD_SEEN]: JSON.stringify({ "1": 10 }), [SEEN_SENT]: "1" } });
  assert.deepEqual(h.seen(), {});
  h.setChannels({ guilds: [], personas: [], channels: [{ id: "1" }, { id: "2" }], reads: { "1": 12, "2": 4 } });
  await h.store.load.channels();
  assert.ok(h.calls.sidebarSeen.length >= 1);
  assert.deepEqual(h.calls.sidebarSeen[0], { "1": 12, "2": 4 });
});

test("web static: 空の一覧（channels: []・reads: {}）では旗を書かない", async () => {
  const h = loadApiReads({ storage: { [OLD_SEEN]: JSON.stringify({ "1": 10 }) } });
  h.setChannels({ guilds: [], personas: [], channels: [], reads: {} });
  await h.store.load.channels();
  assert.equal(h.storage.has(SEEN_SENT), false);
  assert.equal(h.writes.includes(SEEN_SENT), false);
  assert.equal(h.posts.length, 0);
  assert.equal(h.seen()["1"], 10, "古い既読はメモリに残る");
});

test("web static: isUnread は最後の行が返事（agent）で store.seen より新しいときだけ（notice・divider・owner は未読にしない）", () => {
  const h = loadApiReads({ storage: { [OLD_SEEN]: JSON.stringify({ "1": 10 }) } });
  const ch = (kind: string, id: number) => ({ id: "1", last: { kind, id } });
  assert.equal(h.store.isUnread(ch("agent", 11)), true);
  assert.equal(h.store.isUnread(ch("agent", 10)), false);
  for (const kind of ["notice", "divider", "owner"]) assert.equal(h.store.isUnread(ch(kind, 11)), false, kind);
  assert.equal(h.store.isUnread({ id: "2", last: null }), false);
  h.store.syncReads({ "1": 11 }, []);
  assert.equal(h.store.isUnread(ch("agent", 11)), false, "サーバーの既読で消える");
});

test("web static: api.js は storage イベントを受けず、古い鍵に書かない", () => {
  const js = read("api.js");
  assert.doesNotMatch(js, /addEventListener\("storage"/);
  assert.doesNotMatch(js, /setItem\(SEEN_KEY|removeItem\(/);
  assert.equal(loadApiReads().winListeners.includes("storage"), false);
});

// ----- shell.js の readingChannelIds と、列が見えたときの付け直し -----
const readingIds = (h: HandShell) => JSON.parse(JSON.stringify((h.app as unknown as { readingChannelIds: () => string[] }).readingChannelIds())) as string[];

test("web static: 広い幅の readingChannelIds は列 2 の会話と見えている右腕（shownChannelIds と同じ）", async () => {
  const h = await loadHand();
  h.app.open("ch:1");
  assert.deepEqual(readingIds(h), ["1", "900"]);
  assert.deepEqual(readingIds(h), shownIds(h));
  handClose(h).dispatch("click");
  assert.deepEqual(readingIds(h), ["1"]);
  h.app.open("tasks");
  assert.deepEqual(readingIds(h), []);
});

test("web static: スマホで一覧を出している間、shownChannelIds は会話を返し（今のまま）、readingChannelIds は返さない", async () => {
  const h = await loadHand({ phone: true });
  h.app.open("ch:1");
  assert.equal(h.nodes.v3.getAttribute("data-view"), "body");
  assert.deepEqual(readingIds(h), ["1"]);
  h.history.back();
  assert.equal(h.nodes.v3.getAttribute("data-view"), "list");
  assert.deepEqual(shownIds(h), ["1"]);
  assert.deepEqual(readingIds(h), []);
});

test("web static: 重ねた右腕を開いている間、readingChannelIds は右腕だけ（下の会話は入れない）", async () => {
  const h = await loadHand({ width: 900 });
  h.app.open("ch:1");
  h.nodes.handShow.dispatch("click");
  assert.equal(handOf(h), "open");
  assert.deepEqual(shownIds(h), ["1", "900"]);
  assert.deepEqual(readingIds(h), ["900"]);
  h.nodes.backdrop.dispatch("click");
  assert.deepEqual(readingIds(h), ["1"]);
  // スマホでも同じ
  const p = await loadHand({ phone: true });
  p.app.open("ch:1");
  p.nodes.handOpen.dispatch("click");
  assert.equal(handOf(p), "open");
  assert.deepEqual(readingIds(p), ["900"]);
});

test("web static: 一覧 → 会話（open と popstate の両方）と、重ねた右腕を畳んだときに markSeenShown を呼ぶ", async () => {
  const h = await loadHand({ phone: true });
  // 呼ばれた時点で見えた会話が readingChannelIds に入っている（状態が切り替わってから呼ぶ）
  const readAt = (from: number) => h.marks.reading.slice(from).some((ids) => ids !== null && ids.includes("1"));
  let n = h.marks.seenShown;
  h.app.open("ch:1");
  assert.ok(h.marks.seenShown > n, "open");
  assert.ok(readAt(n), "open の時点で 1 を読んでいる");
  h.history.back();
  n = h.marks.seenShown;
  h.history.forward();
  assert.equal(h.nodes.v3.getAttribute("data-view"), "body");
  assert.ok(h.marks.seenShown > n, "popstate");
  assert.ok(readAt(n), "popstate の時点で 1 を読んでいる");
  h.nodes.handOpen.dispatch("click");
  n = h.marks.seenShown;
  h.nodes.backdrop.dispatch("click");
  assert.equal(handOf(h), "closed");
  assert.ok(h.marks.seenShown > n, "重ねた右腕を畳む");
  assert.ok(readAt(n), "畳んだ時点で下の 1 を読んでいる");
  const sh = read("shell.js");
  assert.match(fnSource(sh, "setView"), /stickOnShow = false;\n\s*\/\/[^\n]*\n\s*SA\.chat\.markSeenShown\(\);\n {2}\}$/);
  assert.match(fnSource(sh, "applyHand"), /SA\.chat\.markSeenShown\(\);\n {2}\}$/);
});

test("web static: スマホで会話を開いて一覧に戻した後に幅が広くなると、markSeenShown を呼び、その時点でその会話を読んでいる", async () => {
  const h = await loadHand({ phone: true });
  h.app.open("ch:1");
  h.history.back();
  assert.equal(h.nodes.v3.getAttribute("data-view"), "list");
  assert.deepEqual(readingIds(h), []);
  const n = h.marks.seenShown;
  h.setPhone(false, 900);
  assert.ok(h.marks.seenShown > n, "幅の切り替えで呼ぶ");
  assert.deepEqual(h.marks.reading.at(-1), ["1"]);
  assert.deepEqual(readingIds(h), ["1"]);
});

test("web static: スマホで [一覧]・[会話]・[右腕] から 2 つ一度に戻っても、隠れる会話を読んでいる扱いにしない（M8-0）", async () => {
  const h = await loadHand({ phone: true });
  h.app.open("ch:1");
  h.nodes.handOpen.dispatch("click");
  assert.equal(handOf(h), "open");
  assert.equal(h.nodes.v3.getAttribute("data-view"), "body");
  const readsA = (from: number) => h.marks.reading.slice(from).filter((ids) => ids !== null && ids.includes("1"));
  let n = h.marks.reading.length;
  h.history.go(-2);
  assert.ok(h.marks.reading.length > n, "markSeenShown を呼ぶ");
  assert.deepEqual(readsA(n), [], "戻る間に 1 を読んでいる扱いにしない");
  assert.equal(h.nodes.v3.getAttribute("data-view"), "list");
  assert.equal(handOf(h), "closed");
  // 進むで [右腕] へ: 右腕が下の会話を覆うので、1 は読んでいない
  n = h.marks.reading.length;
  h.history.go(2);
  assert.ok(h.marks.reading.length > n, "markSeenShown を呼ぶ");
  assert.deepEqual(readsA(n), [], "進む間も 1 を読んでいる扱いにしない");
  assert.equal(h.nodes.v3.getAttribute("data-view"), "body");
  assert.equal(handOf(h), "open");
});

// ----- 設定のキーの表（M8-0。views.js の KEYS_COMMON・KEYS_CLASSIC・KEYS_V3） -----
function settingsKeys(v3: boolean): Array<[string, string]> {
  const { SA, views } = loadViews({ v3 });
  (SA.app as Record<string, unknown>).theme = () => "system";
  const container = new FakeNode("div");
  (views as unknown as { info: (id: string) => { render: (c: FakeNode) => void } }).info("settings").render(container);
  const keyboard = descendants(container).find((n) => n.classes.has("hide-sm"))!;
  assert.match(keyboard.textContent, /キーボード/);
  return descendants(keyboard)
    .filter((n) => n.tagName === "kbd")
    .map((k) => [k.textContent, k.parent!.parent!.textContent.slice(k.textContent.length)] as [string, string]);
}

test("web static: 古い殻の設定のキーの表は今までどおりの 9 行（M8-0）", () => {
  // 並び・キー・説明の組の全文一致（main 09387b6 の KEYS と同じ文）
  assert.deepEqual(settingsKeys(false), [
    ["Enter / Shift+Enter", "送る / 改行（タッチの端末では Enter で改行）"],
    ["Ctrl+Enter / ⌘+Enter", "送る"],
    ["Ctrl+K / Ctrl+P", "移動（画面）"],
    ["Ctrl+Shift+P", "コマンド"],
    ["Ctrl+B", "サイドバーの表示"],
    ["Ctrl+J", "パネルの表示"],
    ["Alt+W", "タブを閉じる"],
    ["Alt+数字", "その番号のタブ（1 から 9）"],
    ["Esc", "パレット・ドロワーを閉じる"],
  ]);
});

test("web static: 新しい殻の設定のキーの表は共通の 2 行と新しい殻の 3 行で、古い殻だけのキーを載せない（M8-0）", () => {
  // 並び・キー・説明の組の全文一致（古い殻だけのキー Ctrl+B・Ctrl+J・Alt+W・Alt+数字・Ctrl+Shift+P・Ctrl+P は載らない）
  assert.deepEqual(settingsKeys(true), [
    ["Enter / Shift+Enter", "送る / 改行（タッチの端末では Enter で改行）"],
    ["Ctrl+Enter / ⌘+Enter", "送る"],
    ["Ctrl+K / ⌘+K", "話題を絞り込む"],
    ["↑ / ↓ / Home / End", "一覧の行を移る"],
    ["Esc", "絞り込み・重ねた右腕を閉じる"],
  ]);
  // 殻は描くときに見分ける（読み込みのときに 1 度だけ決めない）
  const views = read("views.js");
  assert.match(fnSource(views, "isV3Shell"), /return document\.getElementById\("v3"\) !== null;/);
  assert.match(fnSource(views, "renderSettings"), /KEYS_COMMON\.concat\(isV3Shell\(\) \? KEYS_V3 : KEYS_CLASSIC\)/);
});

test("web static: 新しい殻のキーの表は shell.js の処理と合っている（M8-0）", () => {
  const sh = read("shell.js");
  assert.match(sh, /\(e\.ctrlKey \|\| e\.metaKey\) && !e\.altKey && !e\.shiftKey && \(e\.key === "k" \|\| e\.key === "K"\)/);
  assert.match(sh, /e\.key !== "Escape"/);
  // 一覧の ↑↓・Home・End は部品の入口（c-app.js）が listKey（c-list.js）で動かす
  assert.match(read("c-app.js"), /listKey\(event\.key, /);
  const listJs = read("c-list.js");
  assert.match(listJs, /\["Home", "End", "ArrowDown", "ArrowUp"\]\.includes\(key\)/);
  assert.match(listJs, /key === "Home"/);
  assert.match(listJs, /key === "End"/);
});

test("web static: 今の殻の readingChannelIds は shownChannelIds と同じ関数", () => {
  assert.match(read("workbench.js"), /\n {4}readingChannelIds: shownChannelIds,\n/);
  assert.ok(appKeys(read("shell.js")).includes("readingChannelIds"));
});

// ----- topics.js の syncReads -----
test("web static: topics.js の load は render の前に syncReads(reads, ids) を呼び、ids は ch: を外した話題と右腕", async () => {
  const h = loadShell();
  await h.flush();
  h.syncs.length = 0;
  h.api.reply = () =>
    Promise.resolve(v3Result([v3Topic("ch:5"), v3Topic("cc:abc", { origin: "cc" }), v3Topic("ch:6")], { rightHands: [v3Hand()], reads: { "5": 3, "900": 7 } }));
  await h.topics.load();
  assert.deepEqual(h.syncs, [{ reads: { "5": 3, "900": 7 }, ids: ["5", "6", "900"] }]);
  assert.equal(h.rowOf("ch:5")!.mark, "none", "一覧を描く");
  const load = fnSource(read("topics.js"), "load");
  assert.ok(load.indexOf("store.syncReads(next.reads, ids);") < load.indexOf("render();"));
});

test("web static: reads の無い応答でも topics.js は一覧を描く", async () => {
  const h = loadShell();
  await h.flush();
  h.syncs.length = 0;
  h.api.reply = () => Promise.resolve(v3Result([v3Topic("ch:5")]));
  await h.topics.load();
  assert.deepEqual(h.syncs, [{ reads: null, ids: ["5"] }]);
  assert.equal(h.rowOf("ch:5")!.mark, "none");
});
