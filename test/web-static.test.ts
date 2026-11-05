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
    "app.css",
    "ui.js",
    "api.js",
    "chat.js",
    "views.js",
    "sidebar.js",
    "workbench.js",
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
  assert.deepEqual(links, ["/static/base.css", "/static/app.css"]);
  const scripts = [...html.matchAll(/<script src="([^"]+)" defer><\/script>/g)].map((m) => m[1]);
  assert.deepEqual(scripts, [
    "/static/ui.js",
    "/static/api.js",
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
  remove(): void {
    if (this.parent) this.parent.children = this.parent.children.filter((c) => c !== this);
    this.parent = null;
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
  SA.store = { load: { ccSession: () => undefined, cc: () => undefined } };
  SA.app = { refresh: () => undefined };
  SA.api = {
    post: (path: string) => {
      posts.push(path);
      return Promise.resolve({});
    },
  };
  vm.runInNewContext(read("views.js"), context);
  const views = SA.views as { ccPermissionCard: (sessionId: string, p: unknown, rc: string | null) => FakeNode | null };
  return { views, posts };
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
      channels: [channel("c1", "inbox", "inbox"), channel("c2", "session", "調べもの", "active"), ...(opts.ccChannels ?? []).map((id) => channel(id, "cc", "cc-" + id))],
    },
    cc: opts.cc,
    ccAt: opts.cc ? Date.now() : 0,
    ccFailed: false,
    running: [],
    ccEnabled: () => opts.ccEnabled,
    ccNeedsInputCount: () => (opts.cc ? opts.cc.sessions.filter((s) => s.state === "needs_input").length : 0),
    unreadCount: () => opts.unread ?? 1,
    runningOf: () => null,
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
  SA.views = {
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
  return { sidebar, container, groups, titleOf, countOf, ccGroup, calls };
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
  texts.push(["index.html", read("index.html").replace(/<!doctype[^>]*>/i, "")]);
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
  assert.match(css, /\n\.steps > summary > \[data-run-progress\] \{\n {2}color: var\(--text\);\n {2}font-variant-numeric: tabular-nums;/);
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
  assert.match(phone, /\n {2}\.msg-agent > \.avatar \{\n {4}display: none;/);
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
