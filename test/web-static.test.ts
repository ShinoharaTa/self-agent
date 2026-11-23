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
/** `/` が配る新しい殻と、M8b まで残す古い殻（/static/classic.html。docs/plan/web-ui-v3.md の M8） */
const SHELL_HTML = "index.html";
const CLASSIC_HTML = "classic.html";
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
    "classic.html",
    "shell.css",
    "shell.js",
    "topics.js",
    "takeover.js",
    "c-term.js",
    "c-term.css",
    "flows.js",
    "c-deck.js",
    "c-deck.css",
    "icons-app.svg",
    "manifest.webmanifest",
    ...ICON_FILES,
  ]) {
    assert.ok(files.includes(name), name);
  }
  assert.equal(files.includes("base.css"), false);
  assert.equal(files.includes("icons.svg"), false);
  // 新しい殻は M8 で index.html に移した（前の名前の v3 の html と試し用の manifest は置かない。/static/ のその名前は 404）
  assert.deepEqual(files.filter((n) => /(^|-)v3\./.test(n)), []);
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

test("web static: 古い殻（classic.html）の読み込みの順と既定のテーマ", () => {
  const html = read(CLASSIC_HTML);
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

/** 部品の口（SA.notice・SA.ask）の代わり。draw の state を覚え、答えは ok で決める */
type FakeMouth = { states: Array<Record<string, any>>; ok: boolean; draw: (state: Record<string, any>) => boolean };
const fakeMouth = (): FakeMouth => {
  const m: FakeMouth = { states: [], ok: true, draw: (state) => (m.states.push(state), m.ok) };
  return m;
};

function loadToast(opts: { phone?: boolean; notice?: FakeMouth; ask?: FakeMouth } = {}) {
  const boxes = { toast: new FakeNode("div"), "toast-alert": new FakeNode("div") };
  boxes.toast.hidden = true;
  boxes["toast-alert"].hidden = true;
  // 古い確認（#dlg-confirm と中の 5 つ）
  const dialog: Record<string, FakeNode> = {};
  for (const id of ["dlg-confirm", "dlg-confirm-title", "dlg-confirm-target", "dlg-confirm-body", "dlg-confirm-ok", "dlg-confirm-cancel"]) dialog[id] = new FakeNode(id === "dlg-confirm" ? "dialog" : "p");
  let now = 0;
  let seq = 0;
  const timers = new Map<number, { at: number; fn: () => void }>();
  const document = {
    getElementById: (id: string) => (boxes as Record<string, FakeNode>)[id] ?? dialog[id] ?? null,
    createElement: (tag: string) => new FakeNode(tag),
    createElementNS: (_ns: string, tag: string) => new FakeNode(tag),
    createTextNode: (text: string) => Object.assign(new FakeNode("#text"), { text }),
  };
  const context = {
    window: {
      ...(opts.phone ? { matchMedia: () => ({ matches: true }) } : {}),
      ...(opts.notice || opts.ask ? { SA: { ...(opts.notice ? { notice: opts.notice } : {}), ...(opts.ask ? { ask: opts.ask } : {}) } } : {}),
    } as Record<string, unknown>,
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
  const ui = (context.window as { SA: { ui: { toast: (text: string, action?: unknown, opts?: unknown) => void; confirm: (opts: Record<string, unknown>) => void } } }).SA.ui;
  return { ui, boxes, dialog, advance };
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

test("web static: ui.js の toast は SA.notice が在れば口へ描き、置き換え・上限・自動で消す・止める・消える途中・[取り消す]・[もう一度] は今と同じ決まり", () => {
  const notice = fakeMouth();
  const { ui, boxes, advance } = loadToast({ notice });
  // 偽の口が受けた並びは ui.js の側（別の realm）で作られるので、こちらの配列に写す
  const items = () => [...(notice.states.at(-1)?.items ?? [])] as Array<Record<string, any>>;
  const shown = () => items().map((i) => [i.text, i.level, i.leaving]);
  const on = () => notice.states.at(-1)!.on as { dismiss: (id: string) => void; hold: (id: string, kind: string, on: boolean) => void; left: (id: string) => void };
  ui.toast("a");
  assert.deepEqual(shown(), [["a", "info", false]]);
  // action の無い知らせは次の知らせで消える途中に。動きの事象が来なくても保険の時間で外す
  ui.toast("b");
  assert.deepEqual(shown(), [["a", "info", true], ["b", "info", false]]);
  advance(400);
  assert.deepEqual(shown(), [["b", "info", false]]);
  // left(id) で、すぐ外す
  ui.toast("c");
  on().left(items()[0]!.id);
  assert.deepEqual(shown(), [["c", "info", false]]);
  // 4 秒で消える途中に
  advance(3999);
  assert.deepEqual(shown(), [["c", "info", false]]);
  advance(1);
  assert.deepEqual(shown(), [["c", "info", true]]);
  advance(400);
  assert.deepEqual(shown(), []);
  // マウスが乗っている間・focus の間は止め、離れたら 4 秒から数え直す
  ui.toast("d");
  const d = items()[0]!.id;
  on().hold(d, "hover", true);
  advance(10000);
  on().hold(d, "hover", false);
  on().hold(d, "focus", true);
  advance(10000);
  assert.deepEqual(shown(), [["d", "info", false]]);
  on().hold(d, "focus", false);
  advance(3999);
  assert.deepEqual(shown(), [["d", "info", false]]);
  advance(1);
  assert.deepEqual(shown(), [["d", "info", true]]);
  advance(400);
  // [取り消す] 付きは自動で消えず、次の知らせでも消えない。押すと消える途中を描いてから run
  const log: string[] = [];
  ui.toast("完了にしました", { label: "取り消す", run: () => log.push("run:" + String(items()[0]!.leaving)) });
  advance(60000);
  ui.toast("別の知らせ");
  assert.deepEqual(shown(), [["完了にしました", "info", false], ["別の知らせ", "info", false]]);
  assert.equal(items()[0]!.actionLabel, "取り消す");
  // 上限は 2 つ（古い順に消える途中）
  ui.toast("3 つ目");
  assert.deepEqual(shown(), [["完了にしました", "info", false], ["別の知らせ", "info", true], ["3 つ目", "info", false]]);
  items()[0]!.onAction();
  assert.deepEqual(log, ["run:true"]);
  advance(4400);
  // 失敗は alert の側で自動で消えず、[もう一度] で retry。知らせが来ても残る
  let retried = 0;
  ui.toast("操作に失敗しました", null, { level: "error", retry: () => retried++ });
  advance(60000);
  ui.toast("x");
  assert.deepEqual(shown(), [["操作に失敗しました", "error", false], ["x", "info", false]]);
  const failed = items()[0]!;
  assert.equal(failed.actionLabel, "もう一度");
  failed.onAction();
  assert.equal(retried, 1);
  assert.equal(items()[0]!.leaving, true);
  // × は消える途中に
  on().dismiss(items()[1]!.id);
  assert.equal(items()[1]!.leaving, true);
  // retry が無ければボタンは無い
  advance(400);
  ui.toast("y", null, { level: "error" });
  assert.equal(items().find((i) => i.text === "y")!.actionLabel, null);
  // 古い入れ物には出さない
  assert.equal(boxes.toast.children.length, 0);
  assert.equal(boxes["toast-alert"].children.length, 0);
  // スマホはそれぞれ 1 つまでで、[取り消す] 付きも 4 秒で消える
  const phoneNotice = fakeMouth();
  const p = loadToast({ phone: true, notice: phoneNotice });
  const phoneShown = () => ([...(phoneNotice.states.at(-1)?.items ?? [])] as Array<Record<string, any>>).map((i) => [i.text, i.leaving]);
  p.ui.toast("完了にしました", { label: "取り消す", run: () => undefined });
  p.ui.toast("別の知らせ");
  assert.deepEqual(phoneShown(), [["完了にしました", true], ["別の知らせ", false]]);
  p.advance(400);
  p.ui.toast("戻せます", { label: "取り消す", run: () => undefined });
  p.advance(4000);
  assert.deepEqual(phoneShown(), [["戻せます", true]]);
});

test("web static: SA.notice の draw が false なら、その知らせから古い #toast・#toast-alert に出し、以後は口を呼ばない。action と retry の両方も古い道", () => {
  const notice = fakeMouth();
  const { ui, boxes, advance } = loadToast({ notice });
  ui.toast("a");
  assert.equal(notice.states.length, 1);
  notice.ok = false;
  ui.toast("b");
  assert.equal(notice.states.length, 2);
  assert.deepEqual(boxes.toast.children.map((c) => c.children[0]!.textContent), ["b"]);
  // 出ていた物のタイマーは止めた（口を呼ばない）
  advance(10000);
  ui.toast("c", null, { level: "error" });
  assert.equal(notice.states.length, 2);
  assert.deepEqual(boxes["toast-alert"].children.map((c) => c.children[0]!.textContent), ["c"]);
  // action と retry の両方を渡す形は、口が在っても古い道（口を呼ばない）
  const both = fakeMouth();
  const h = loadToast({ notice: both });
  h.ui.toast("d", { label: "取り消す", run: () => undefined }, { level: "error", retry: () => undefined });
  assert.equal(both.states.length, 0);
  assert.deepEqual(h.boxes["toast-alert"].buttons().map((b) => b.textContent), ["取り消す", "もう一度", ""]);
  // 次の知らせは口へ
  h.ui.toast("e");
  assert.equal(both.states.length, 1);
});

test("web static: ui.js の confirm は SA.ask が在れば口へ描き、実行は 閉じる → closed → run の順、やめるは closed だけ。開いている間の 2 つ目は前をやめにする。draw が false なら古い #dlg-confirm", () => {
  const ask = fakeMouth();
  const log: string[] = [];
  const orig = ask.draw;
  ask.draw = (state) => (log.push("draw:" + String(state.open)), orig(state));
  const { ui, dialog } = loadToast({ ask });
  const opts = (name: string, o: Record<string, unknown> = {}) => ({ title: "閉じますか", run: () => log.push("run:" + name), closed: () => log.push("closed:" + name), ...o });
  const long = "あ".repeat(100);
  ui.confirm(opts("a", { target: long, body: "元に戻せません", ok: "閉じる", danger: true }));
  const first = ask.states.at(-1)!;
  assert.deepEqual({ ...first, on: undefined }, { open: true, title: "閉じますか", target: long, body: "元に戻せません", okLabel: "閉じる", danger: true, on: undefined });
  first.on.ok();
  first.on.ok();
  first.on.cancel();
  assert.deepEqual(log, ["draw:true", "draw:false", "closed:a", "run:a"]);
  assert.equal(ask.states.at(-1)!.open, false);
  // 既定の文・空白だけの target・やめる
  log.length = 0;
  ui.confirm(opts("b", { target: "  " }));
  const second = ask.states.at(-1)!;
  assert.deepEqual([second.target, second.body, second.okLabel, second.danger], ["", "", "実行する", false]);
  second.on.cancel();
  assert.deepEqual(log, ["draw:true", "draw:false", "closed:b"]);
  // 開いている間の 2 つ目は前をやめにしてから開く
  log.length = 0;
  ui.confirm(opts("c"));
  const c = ask.states.at(-1)!;
  ui.confirm(opts("d"));
  c.on.ok();
  assert.deepEqual(log, ["draw:true", "draw:false", "closed:c", "draw:true"]);
  ask.states.at(-1)!.on.ok();
  assert.deepEqual(log.slice(-3), ["draw:false", "closed:d", "run:d"]);
  assert.equal(dialog["dlg-confirm"]!.getAttribute("open"), null, "古い確認は開かない");
  // draw が false なら古い #dlg-confirm（以後は口を呼ばない）。古い道も 閉じる → closed → run
  ask.ok = false;
  log.length = 0;
  ui.confirm(opts("e"));
  assert.equal(dialog["dlg-confirm"]!.getAttribute("open"), "");
  assert.equal(dialog["dlg-confirm-title"]!.textContent, "閉じますか");
  dialog["dlg-confirm-ok"]!.dispatch("click");
  assert.equal(dialog["dlg-confirm"]!.getAttribute("open"), null);
  assert.deepEqual(log, ["draw:true", "closed:e", "run:e"]);
  ui.confirm(opts("f"));
  assert.deepEqual(log.slice(-1), ["run:e"], "口を呼ばない");
  dialog["dlg-confirm-cancel"]!.dispatch("click");
  assert.deepEqual(log.slice(-1), ["closed:f"]);
});

test("web static: 古い殻（classic.html）に失敗のトーストの容れ物（role=alert）がある", () => {
  const html = read(CLASSIC_HTML);
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
  const toastOpts: unknown[] = [];
  const toastActions: unknown[] = [];
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
  (SA.ui as { toast: unknown }).toast = (text: string, action: unknown, opts: unknown) => {
    toasts.push(text);
    toastOpts.push(opts ?? null);
    toastActions.push(action ?? null);
  };
  vm.runInNewContext(read("views.js"), context);
  const views = SA.views as {
    ccPermissionCard: (sessionId: string, p: unknown, rc: string | null) => FakeNode | null;
    ccQuestionPicks: (questions: unknown, drafts: unknown) => unknown;
    ccQuestionForget: (id: number) => void;
    placeChildren: (container: FakeNode, nodes: Array<FakeNode | null>) => void;
  };
  return { SA, views, posts, bodies, toasts, toastOpts, toastActions, setReply: (fn: (path: string) => Promise<unknown>) => (reply = fn) };
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
  const html = read(CLASSIC_HTML);
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
  const html = read(CLASSIC_HTML);
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

test("web static: store.isUnread（api.js）は最後の行が返事か統括のまとめ（last.lead === true）で、既読より後のときだけ真（#457 の L2）", () => {
  const src = /store\.isUnread = [^\n]*;/.exec(read("api.js"))?.[0];
  assert.ok(src, "api.js から store.isUnread = …; の 1 行を抜き出せない（書き方が変わった）");
  assert.ok(src.includes("last.lead === true"));
  const store: Record<string, unknown> = { seen: { "ch:100": 5 } };
  vm.runInNewContext(src, { store });
  const isUnread = store.isUnread as (channel: unknown) => boolean;
  assert.equal(isUnread({ id: "ch:100", last: { id: 6, kind: "notice", lead: true } }), true);
  assert.equal(isUnread({ id: "ch:100", last: { id: 5, kind: "notice", lead: true } }), false);
  assert.equal(isUnread({ id: "ch:100", last: { id: 6, kind: "notice" } }), false);
  assert.equal(isUnread({ id: "ch:100", last: { id: 6, kind: "agent" } }), true);
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
    [{ state: "running", pending: p("queued", { lastPaneState: "no_prompt" }) }, { kind: "queued", text: "入力欄が見つからないため待っています（端末の画面を確かめてください）", cancel: true }],
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
  for (const name of [CLASSIC_HTML, SHELL_HTML]) texts.push([name, read(name).replace(/<!doctype[^>]*>/i, "")]);
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

test("web static: 2 つの殻（index.html・classic.html）に manifest・favicon・theme-color 2 つ・apple の meta とアイコンがある", () => {
  for (const name of [SHELL_HTML, CLASSIC_HTML]) {
    const html = read(name);
    assert.match(html, /<link rel="manifest" href="\/static\/manifest\.webmanifest">/, name);
    assert.match(html, /<link rel="icon" href="\/static\/app-icon\.svg" type="image\/svg\+xml">/, name);
    assert.match(html, /<link rel="apple-touch-icon" href="\/static\/apple-touch-icon\.png">/, name);
    assert.equal([...html.matchAll(/<meta name="theme-color" /g)].length, 2, name);
    assert.match(html, /<meta name="apple-mobile-web-app-capable" content="yes">/, name);
    assert.match(html, /<meta name="mobile-web-app-capable" content="yes">/, name);
    assert.match(html, /<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">/, name);
    assert.match(html, /<meta name="apple-mobile-web-app-title" content="self-agent">/, name);
    // service worker は置かない（§11.3）
    assert.doesNotMatch(html, /serviceWorker/, name);
  }
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
  assert.equal(manifest.background_color, "#05060a");
  // 起動画面の地は殻の地（tokens.css のダークの --bg）と同じ値（離れないように）
  const darkTokens = read("tokens.css").match(/:root\[data-theme="dark"\] \{[^}]*?--bg: (#[0-9a-f]{6});/);
  assert.ok(darkTokens, "tokens.css の :root[data-theme=\"dark\"] の --bg");
  assert.equal(manifest.background_color, darkTokens[1]);
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
  assert.match(read(CLASSIC_HTML), /<span class="wb-title-current" id="title-current"><\/span>/);
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
  assert.match(read(CLASSIC_HTML), /<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover, interactive-widget=resizes-content">/);
  assert.match(read(CLASSIC_HTML), /<p id="dlg-confirm-target" class="dlg-target" hidden><\/p>/);
  const wb = read("workbench.js");
  assert.match(wb, /vv\.addEventListener\("resize", fitViewport\)/);
  assert.match(wb, /root\.style\.setProperty\("--vvh", /);
  assert.match(wb, /sheetHead\("その他"\)/);
  // backdrop（箱の外）の click で閉じる
  assert.match(read("ui.js"), /if \(close\) closeDialog\(dialog\);/);
  // 確認の見出しは動詞だけ（対象は target）
  for (const name of ["chat.js", "views.js"]) assert.doesNotMatch(read(name), /title: "「" \+/, name);
  assert.match(read("chat.js"), /title: "閉じますか",\n {6}target: ch\.title,/);
  assert.match(read("views.js"), /title: "止めますか",\n {6}target: r\.text,/);
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
  const html = read(CLASSIC_HTML);
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

test("web static: 古い殻: プロジェクトのセッションの許可・質問のカードの注記は端末の無い文（terminal false）。未指定は今の文のまま", () => {
  const { views } = loadViews();
  const card = views.ccPermissionCard as (s: string, p: unknown, rc: null, tab?: string, terminal?: boolean) => FakeNode;
  const notesOf = (node: FakeNode): unknown[] => [node.getAttribute("title"), descendants(node).filter((n) => n.classes.has("cc-permission-note")).map((n) => n.textContent)];
  const OLD = "端末や RC のダイアログでも答えられます。先に答えた方が効きます。";
  const PERM = "時間が過ぎると拒否になります。";
  const QUESTION = "時間切れになったら、答えを発言で送ってください。";
  assert.deepEqual(notesOf(card("s1", permissionRequest(80), null, "ch:p1", false)), [PERM, [PERM]]);
  assert.deepEqual(notesOf(card("s1", permissionRequest(81), null, "ch:p2")), [OLD, [OLD]]);
  assert.deepEqual(notesOf(card("s1", questionPermission(82), null, "ch:q1", false)), [QUESTION, [QUESTION]]);
  assert.deepEqual(notesOf(card("s1", questionPermission(83), null, "ch:q2")), [OLD, [OLD]]);
});

test("web static: 古い殻: 会話のタブはプロジェクトのセッションの許可のカードに terminal false を渡す", () => {
  const c = loadChat();
  const views = (c.context.window as { SA: { views: Record<string, unknown> } }).SA.views;
  const real = views.ccPermissionCard as (...a: unknown[]) => unknown;
  const calls: unknown[][] = [];
  views.ccPermissionCard = (...a: unknown[]) => {
    calls.push(a);
    return real(...a);
  };
  c.put("1", [chatTurn(10, "owner", "a")], { kind: "session", title: "t", state: "active", permission: permissionRequest(84, { sessionId: "sx" }) });
  c.chat.render(c.box(), "1");
  assert.ok(calls.length > 0);
  for (const a of calls) assert.deepEqual([a[0], a[2], a[3], a[4]], ["sx", null, "ch:1", false]);
});

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

test("web static: 質問のカードで「その他」を選んだ後に選択肢を選ぶと、「その他」は外れて欄が隠れる（1 つ選ぶ形も複数選ぶ形も）", () => {
  const { views } = loadViews();
  const card = views.ccPermissionCard("s1", questionPermission(26), null)!;
  const fieldsets = descendants(card).filter((n) => n.tagName === "fieldset");
  for (const [i, label] of [[0, "赤"], [1, "B"]] as const) {
    const otherBox = descendants(fieldsets[i]!).filter((n) => n.tagName === "input").at(-1)! as FakeNode & { checked: boolean };
    const text = descendants(fieldsets[i]!).find((n) => n.tagName === "textarea")!;
    pick(otherBox);
    assert.equal(text.hidden, false);
    pick(optionInput(card, label));
    assert.equal(otherBox.checked, false, "選択肢を選ぶと「その他」は外れる");
    assert.equal(optionInput(card, label).checked, true);
    assert.equal(text.hidden, true, "「その他」の欄は隠れる");
  }
  // 複数選ぶ形は、選択肢も「その他」も外せる（change の受け手が input の checked を渡している）
  const multiOther = descendants(fieldsets[1]!).filter((n) => n.tagName === "input").at(-1)! as FakeNode & { checked: boolean };
  const multiText = descendants(fieldsets[1]!).find((n) => n.tagName === "textarea")!;
  pick(optionInput(card, "B"), false);
  assert.equal(optionInput(card, "B").checked, false, "選択肢を外せる");
  pick(multiOther);
  assert.equal(multiText.hidden, false);
  pick(multiOther, false);
  assert.equal(multiOther.checked, false, "「その他」を外せる");
  assert.equal(multiText.hidden, true);
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

// ===== 新しい殻のカードの出口（views.js の SA.views.ccAsk。DOM を作らない） =====
type AskItem = Record<string, unknown> & { questions?: Array<Record<string, unknown>> };
type CcAsk = {
  item: (sessionId: string, p: unknown) => AskItem | null;
  always: (id: number, checked: boolean) => void;
  pick: (p: unknown, index: number, label: string, checked: boolean) => void;
  pickOther: (p: unknown, index: number, checked: boolean) => void;
  other: (p: unknown, index: number, value: string) => void;
  permit: (sessionId: string, p: unknown, decision: string, tabId?: string) => Promise<boolean>;
  answer: (sessionId: string, p: unknown, tabId?: string) => Promise<boolean>;
  dismiss: (sessionId: string, p: unknown, tabId?: string) => Promise<boolean>;
};

function askOf(views: unknown): CcAsk {
  return (views as { ccAsk: CcAsk }).ccAsk;
}

function permissionRequest(id: number, extra: Record<string, unknown> = {}) {
  return {
    id,
    state: "pending",
    toolName: "Bash",
    summary: "ls -la",
    permissionMode: "acceptEdits",
    expiresAt: new Date(Date.now() + 600000).toISOString(),
    requestHash: "h" + id,
    alwaysRule: "Bash(ls:*)",
    alwaysNote: "ls で始まるコマンド",
    ...extra,
  };
}

test("web static: ccAsk.item は保留中の許可から許可の項目を作る（ルールが無ければ空・残り 60 秒未満で urgent）", () => {
  const { views } = loadViews();
  const ask = askOf(views);
  const item = ask.item("s1", permissionRequest(50))!;
  assert.deepEqual(Object.keys(item).sort(), ["always", "busy", "id", "kind", "left", "mode", "rule", "ruleNote", "summary", "tool", "urgent"]);
  assert.equal(item.kind, "permission");
  assert.equal(item.id, 50);
  assert.equal(item.tool, "Bash");
  assert.match(String(item.mode), /^acceptEdits/);
  assert.equal(item.summary, "ls -la");
  assert.equal(item.rule, "Bash(ls:*)");
  assert.equal(item.ruleNote, "ls で始まるコマンド");
  assert.match(String(item.left), /^残り /);
  assert.equal(item.urgent, false);
  assert.equal(item.always, false);
  assert.equal(item.busy, false);
  const bare = ask.item("s1", permissionRequest(51, { alwaysRule: null, alwaysNote: undefined, permissionMode: null, summary: null, expiresAt: new Date(Date.now() + 30000).toISOString() }))!;
  assert.equal(bare.rule, "");
  assert.equal(bare.ruleNote, "");
  assert.equal(bare.mode, "");
  assert.equal(bare.summary, "");
  assert.equal(bare.urgent, true, "残り 60 秒未満");
  assert.match(String(bare.left), /^残り /);
});

test("web static: ccAsk.item は保留中の質問から質問の項目を作り、一覧に無いセッションでは who が空", () => {
  const { views } = loadViews();
  const ask = askOf(views);
  const item = ask.item("s1", questionPermission(60, { permissionMode: "default" }))!;
  assert.equal(item.kind, "question");
  assert.equal(item.id, 60);
  assert.match(String(item.who), /^web-ui ・ /, "一覧に在ればセッションの名前とモード");
  assert.match(String(item.left), /^残り /);
  assert.equal(item.urgent, false);
  assert.equal(item.busy, false);
  assert.equal(item.ready, false);
  assert.equal("tool" in item, false, "ツール名は出さない");
  assert.deepEqual(JSON.parse(JSON.stringify(item.questions)), [
    {
      legend: "色",
      text: "どの色にしますか",
      multi: false,
      options: [{ label: "赤", description: "目立つ" }, { label: "青", description: "" }],
      picked: [],
      other: false,
      otherText: "",
    },
    {
      legend: "問 2",
      text: "どれを入れますか",
      multi: true,
      options: [{ label: "A", description: "" }, { label: "B", description: "" }, { label: "C", description: "" }],
      picked: [],
      other: false,
      otherText: "",
    },
  ]);
  assert.equal(ask.item("s9", questionPermission(61))!.who, "", "一覧に無いセッション（プロジェクトのセッション）");
});

test("web static: ccAsk.item は保留中でない・id が数でない・要求が無いと null", () => {
  const ask = askOf(loadViews().views);
  assert.equal(ask.item("s1", null), null);
  assert.equal(ask.item("s1", undefined), null);
  assert.equal(ask.item("s1", permissionRequest(52, { state: "allowed" })), null);
  assert.equal(ask.item("s1", questionPermission(62, { state: "denied" })), null);
  assert.equal(ask.item("s1", permissionRequest(52, { id: "52" })), null);
});

test("web static: ccAsk.always で入れると次の item の always が true、外すと false", () => {
  const ask = askOf(loadViews().views);
  const p = permissionRequest(53);
  ask.always(53, true);
  assert.equal(ask.item("s1", p)!.always, true);
  ask.always(53, false);
  assert.equal(ask.item("s1", p)!.always, false);
});

test("web static: ccAsk の選び方（1 つ選ぶ形は入れ替え、「その他」と選択肢は同時に選べない。複数は足し引き）", () => {
  const ask = askOf(loadViews().views);
  const p = questionPermission(63);
  const q = (i: number) => JSON.parse(JSON.stringify(ask.item("s1", p)!.questions![i]!));
  // 1 つ選ぶ形
  ask.pick(p, 0, "赤", true);
  assert.deepEqual(q(0).picked, ["赤"]);
  ask.pick(p, 0, "青", true);
  assert.deepEqual(q(0).picked, ["青"], "入れ替わる");
  ask.pickOther(p, 0, true);
  assert.deepEqual(q(0).picked, []);
  assert.equal(q(0).other, true);
  ask.pick(p, 0, "赤", true);
  assert.equal(q(0).other, false, "選択肢を選ぶと「その他」は外れる");
  assert.deepEqual(q(0).picked, ["赤"]);
  // 複数選ぶ形
  ask.pick(p, 1, "C", true);
  ask.pick(p, 1, "A", true);
  assert.deepEqual(q(1).picked, ["C", "A"]);
  ask.pick(p, 1, "C", false);
  assert.deepEqual(q(1).picked, ["A"]);
  ask.pickOther(p, 1, true);
  assert.deepEqual(q(1).picked, []);
  assert.equal(q(1).other, true);
  ask.pickOther(p, 1, false);
  assert.equal(q(1).other, false, "複数選ぶ形の「その他」は外せる");
  // 範囲の外は何もしない
  ask.pick(p, 2, "赤", true);
  ask.pickOther(p, -1, true);
  ask.other(p, 5, "x");
  assert.deepEqual(q(0).picked, ["赤"]);
  assert.equal(ask.item("s1", p)!.questions!.length, 2);
});

test("web static: ccAsk.other の文は otherText に入り、1 字以上で ready、空白だけ・1,001 字では ready でない", () => {
  const ask = askOf(loadViews().views);
  const p = questionPermission(64, { question: { questions: [QUESTIONS[0]], answers: null } });
  ask.pickOther(p, 0, true);
  assert.equal(ask.item("s1", p)!.ready, false, "空では答えられない");
  ask.other(p, 0, "x");
  assert.equal(ask.item("s1", p)!.questions![0]!.otherText, "x");
  assert.equal(ask.item("s1", p)!.ready, true);
  ask.other(p, 0, "   ");
  assert.equal(ask.item("s1", p)!.questions![0]!.otherText, "   ");
  assert.equal(ask.item("s1", p)!.ready, false);
  ask.other(p, 0, "あ".repeat(1001));
  assert.equal(ask.item("s1", p)!.ready, false);
  ask.other(p, 0, "あ".repeat(1000));
  assert.equal(ask.item("s1", p)!.ready, true);
});

test("web static: ccAsk.permit は decision の道へ requestHash を送り、通ったかに resolve する。送っている間は busy で、2 回目は送らず false", async () => {
  const { views, posts, bodies, setReply } = loadViews();
  const ask = askOf(views);
  for (const [id, decision] of [[54, "allow"], [55, "always"], [56, "deny"]] as const) {
    assert.equal(await ask.permit("s1", permissionRequest(id), decision), true);
    assert.equal(posts.at(-1), "/api/cc/permissions/" + id + "/" + decision);
    assert.deepEqual(JSON.parse(JSON.stringify(bodies.at(-1))), { requestHash: "h" + id });
  }
  for (const status of [409, 404, 500]) {
    setReply(() => Promise.reject(Object.assign(new Error("x"), { status })));
    assert.equal(await ask.permit("s1", permissionRequest(57), "allow"), false, String(status));
  }
  // 送っている間
  let release: (v: unknown) => void = () => undefined;
  setReply(() => new Promise((r) => (release = r)));
  const p = permissionRequest(58);
  const first = ask.permit("s1", p, "allow");
  assert.equal(ask.item("s1", p)!.busy, true);
  const sent = posts.length;
  assert.equal(await ask.permit("s1", p, "deny"), false, "既に送っている間は false");
  assert.equal(posts.length, sent, "2 回目は送らない");
  release({});
  assert.equal(await first, true);
  assert.equal(ask.item("s1", p)!.busy, false);
});

test("web static: ccAsk.answer は答えていない問が在れば送らず false、在れば /answer に問の順の answers。dismiss は /deny", async () => {
  const { views, posts, bodies, setReply } = loadViews();
  const ask = askOf(views);
  const p = questionPermission(65);
  ask.pick(p, 0, "青", true);
  assert.equal(await ask.answer("s1", p), false);
  assert.equal(posts.length, 0, "送らない");
  ask.pick(p, 1, "C", true);
  ask.pick(p, 1, "A", true);
  assert.equal(await ask.answer("s1", p), true);
  assert.deepEqual(posts, ["/api/cc/permissions/65/answer"]);
  assert.deepEqual(JSON.parse(JSON.stringify(bodies[0])), { requestHash: "qh", answers: [{ labels: ["青"] }, { labels: ["A", "C"] }] });
  // 「その他」は前後の空白を除く
  const p2 = questionPermission(66);
  ask.pickOther(p2, 0, true);
  ask.other(p2, 0, "  紫  ");
  ask.pick(p2, 1, "B", true);
  assert.equal(await ask.answer("s1", p2), true);
  assert.deepEqual(JSON.parse(JSON.stringify(bodies[1])), { requestHash: "qh", answers: [{ other: "紫" }, { labels: ["B"] }] });
  assert.equal(await ask.dismiss("s1", questionPermission(67)), true);
  assert.equal(posts.at(-1), "/api/cc/permissions/67/deny");
  assert.deepEqual(JSON.parse(JSON.stringify(bodies.at(-1))), { requestHash: "qh" });
  // 質問でない要求（許可）には答えない（投げない・送らない）
  const sent = posts.length;
  assert.equal(await ask.answer("s1", { id: 70, state: "pending", toolName: "Bash", requestHash: "h" } as never), false);
  assert.equal(posts.length, sent);
  setReply(() => Promise.reject(Object.assign(new Error("x"), { status: 409 })));
  assert.equal(await ask.dismiss("s1", questionPermission(68)), false);
});

test("web static: ccAsk の permit・answer・dismiss は話題の会話のタブ（ch:<id>）から送っても通ったかに resolve し、/turns を読み直す", async () => {
  const { SA, views, posts, setReply } = loadViews();
  const ask = askOf(views);
  const turnLoads: string[] = [];
  const ccLoads: string[] = [];
  const refreshes: string[] = [];
  SA.chat = { channelById: (id: string) => ({ id, kind: "session" }) };
  const load = (SA.store as { load: Record<string, unknown> }).load;
  load.turns = (id: string) => turnLoads.push(id);
  // 話題の会話のタブからは Claude Code の一覧もセッションも読まない
  load.ccSession = (id: string) => ccLoads.push("ccSession:" + id);
  load.cc = () => ccLoads.push("cc");
  SA.app = { refresh: (tab: string) => refreshes.push(tab) };
  assert.equal(await ask.permit("s9", permissionRequest(80), "allow", "ch:5"), true);
  assert.equal(posts.at(-1), "/api/cc/permissions/80/allow");
  const p = questionPermission(81);
  ask.pick(p, 0, "赤", true);
  ask.pick(p, 1, "A", true);
  assert.equal(await ask.answer("s9", p, "ch:5"), true);
  assert.equal(await ask.dismiss("s9", questionPermission(82), "ch:5"), true);
  assert.deepEqual(turnLoads, ["5", "5", "5"], "許可・答える・やめるのどれも会話を読み直す");
  // 1 回の送りにつき、送り始めと、読み直しの後の 2 回描き直す
  assert.deepEqual(refreshes, Array(6).fill("ch:5"));
  setReply(() => Promise.reject(Object.assign(new Error("x"), { status: 409 })));
  assert.equal(await ask.permit("s9", permissionRequest(83), "deny", "ch:5"), false);
  const p2 = questionPermission(84);
  ask.pick(p2, 0, "赤", true);
  ask.pick(p2, 1, "A", true);
  assert.equal(await ask.answer("s9", p2, "ch:5"), false);
  assert.equal(await ask.dismiss("s9", questionPermission(85), "ch:5"), false);
  assert.deepEqual(turnLoads, ["5", "5", "5", "5", "5", "5"], "失敗しても読み直す");
  assert.deepEqual(refreshes, Array(12).fill("ch:5"), "失敗しても、押せる形へ戻すために描き直す");
  assert.deepEqual(ccLoads, []);
  // 終わりの描き直しは、読み直しが返ってから（先に描くと、通った直後に答える前の形のカードが一度出る）
  setReply(() => Promise.resolve({}));
  let loaded: () => void = () => undefined;
  load.turns = () => new Promise<null>((resolve) => (loaded = () => resolve(null)));
  for (const send of [() => ask.permit("s9", permissionRequest(86), "allow", "ch:5"), () => ask.dismiss("s9", questionPermission(87), "ch:5")]) {
    refreshes.length = 0;
    assert.equal(await send(), true);
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(refreshes, ["ch:5"], "読み直しが返るまでは送り始めの 1 回だけ");
    loaded();
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(refreshes, ["ch:5", "ch:5"]);
  }
});

test("web static: ccAsk の answer・dismiss は Claude Code のチャンネルの会話のタブ（kind cc の ch:<id>）・cc:<id> のタブ・tabId なしからは、今までどおりセッションと一覧を読み直す", async () => {
  const { SA, views } = loadViews();
  const ask = askOf(views);
  const loads: string[] = [];
  SA.chat = { channelById: (id: string) => ({ id, kind: "cc" }) };
  const load = (SA.store as { load: Record<string, unknown> }).load;
  load.turns = (id: string) => loads.push("turns:" + id);
  load.ccSession = (id: string) => loads.push("ccSession:" + id);
  load.cc = () => loads.push("cc");
  const answered = (id: number) => {
    const p = questionPermission(id);
    ask.pick(p, 0, "赤", true);
    ask.pick(p, 1, "A", true);
    return p;
  };
  for (const tabId of ["ch:7", "cc:s9", undefined]) {
    loads.length = 0;
    assert.equal(await ask.answer("s9", answered(90), tabId), true, String(tabId));
    assert.equal(await ask.dismiss("s9", questionPermission(91), tabId), true, String(tabId));
    assert.deepEqual(loads, ["ccSession:s9", "cc", "ccSession:s9", "cc"], String(tabId));
  }
});

test("web static: ccAsk の answer・dismiss は送っている間の 2 回目を送らず false", async () => {
  const { views, posts, setReply } = loadViews();
  const ask = askOf(views);
  let release: (v: unknown) => void = () => undefined;
  setReply(() => new Promise((r) => (release = r)));
  const p = questionPermission(86);
  ask.pick(p, 0, "赤", true);
  ask.pick(p, 1, "A", true);
  const first = ask.answer("s1", p);
  assert.equal(ask.item("s1", p)!.busy, true);
  const sent = posts.length;
  assert.equal(await ask.answer("s1", p), false, "既に送っている間は false");
  assert.equal(await ask.dismiss("s1", p), false, "既に送っている間は false");
  assert.equal(posts.length, sent, "2 回目は送らない");
  release({});
  assert.equal(await first, true);
  assert.equal(ask.item("s1", p)!.busy, false);
});

test("web static: ccAsk と古い質問のカードは同じ覚え（片方で選んだものがもう片方に出る）", () => {
  const { views } = loadViews();
  const ask = askOf(views);
  const p = questionPermission(69);
  ask.pick(p, 0, "青", true);
  const card = views.ccPermissionCard("s1", p, null)!;
  assert.equal(optionInput(card, "青").checked, true, "ccAsk で選んだものが古いカードに出る");
  pick(optionInput(card, "B"));
  assert.deepEqual(JSON.parse(JSON.stringify(ask.item("s1", p)!.questions![1]!.picked)), ["B"], "古いカードで選んだものが item に出る");
  ask.always(70, true);
  const permCard = views.ccPermissionCard("s1", permissionRequest(70), null)!;
  const box = descendants(permCard).find((n) => n.tagName === "input")! as FakeNode & { checked: boolean };
  assert.equal(box.checked, true, "常に許可のチェックも同じ覚え");
});

type CcSendNote = { id: number; text: string; tone: string; cancel: boolean };
function ccSendOf(views: unknown) {
  return (views as { ccSend: { note: (pending: unknown) => CcSendNote | null; cancel: (sendId: number, sessionId: string | null) => Promise<boolean> } }).ccSend;
}

test("web static: ccSend.note は送った本文の文・色の種類・[やめる] を返し、文は古い帯（ccPendingBar）と同じ", () => {
  const { views } = loadViews();
  const ccSend = ccSendOf(views);
  const bar = (views as unknown as { ccPendingBar: (sessionId: string, pending: unknown) => FakeNode | null }).ccPendingBar;
  const plain = (v: unknown) => (v === null ? null : JSON.parse(JSON.stringify(v)));
  assert.equal(ccSend.note(null), null);
  assert.equal(ccSend.note({ id: "3", state: "queued" }), null, "id が数でない");
  const p = (state: string, extra: Record<string, unknown> = {}) => ({ id: 3, state, lastPaneState: null, replyState: null, ...extra });
  const cases: Array<[Record<string, unknown>, string, string, boolean]> = [
    [p("awaiting_confirm"), "本文 #3: Discord の確認を待っています", "", false],
    [p("queued"), "本文 #3: 届け待ち。入力待ちになったら届けます", "", true],
    [p("delivering"), "本文 #3: 届けています…", "", false],
    [p("delivered"), "本文 #3: 届けました", "done", false],
    [p("unconfirmed"), "本文 #3: 届いたかを確かめられませんでした。画面で確かめてください。やり直しはしません", "warning", false],
    [p("failed"), "本文 #3: 送れませんでした。セッションが終わったか、別の Claude Code に変わっています", "warning", false],
    [p("gave_up"), "本文 #3: 入力待ちにならなかったため、届けるのをやめました", "warning", false],
    [p("cancelled"), "本文 #3: 送るのをやめました", "", false],
    // ダイアログが出ている間の届け待ち
    [p("queued", { lastPaneState: "dialog" }), "本文 #3: ダイアログが出ているため待っています（端末か RC で答えてください）", "", true],
    // 届けた後の返事の状態は「・」でつなぐ（届けていなければ付けない）
    [p("delivered", { replyState: "posted" }), "本文 #3: 届けました・返事が来ました", "done", false],
    [p("delivered", { replyState: "timed_out" }), "本文 #3: 届けました・返事が来ませんでした（中断されたか、24 時間経ちました）", "done", false],
    [p("cancelled", { replyState: "posted" }), "本文 #3: 送るのをやめました", "", false],
  ];
  for (const [pending, text, tone, cancel] of cases) {
    const label = JSON.stringify(pending);
    assert.deepEqual(plain(ccSend.note(pending)), { id: 3, text, tone, cancel }, label);
    // 古い帯と同じ字・同じ色・[やめる] の有無が同じ
    const node = bar("s1", pending)!;
    const span = node.children.find((n) => n.tagName === "span" && !n.classes.has("spinner"))!;
    assert.equal(span.textContent, text, label);
    assert.equal(node.classes.has("is-done"), tone === "done", label);
    assert.equal(node.classes.has("is-warning"), tone === "warning", label);
    assert.equal(node.buttons().length, cancel ? 1 : 0, label);
  }
});

test("web static: ccSend.cancel は通ったかに resolve し（reject しない）、トーストを出して、sessionId があればそのセッションを読み直す", async () => {
  const { SA, views, posts, toasts, toastOpts, setReply } = loadViews();
  const ccSend = ccSendOf(views);
  const loads: string[] = [];
  (SA.store as { load: Record<string, unknown> }).load.ccSession = (id: string) => loads.push(id);
  // 通る
  assert.equal(await ccSend.cancel(3, "s1"), true);
  assert.deepEqual(posts, ["/api/cc/sends/3/cancel"]);
  assert.deepEqual(toasts, ["送るのをやめました"]);
  assert.deepEqual(loads, ["s1"]);
  // 409（届けている途中か、終わっている）
  setReply(() => Promise.reject(Object.assign(new Error("x"), { status: 409 })));
  assert.equal(await ccSend.cancel(4, "s1"), false);
  assert.equal(toasts.at(-1), "この操作は古くなっています（届けている途中か、終わっています）");
  assert.equal(toastOpts.at(-1), null, "409 はエラーのトーストでない");
  assert.deepEqual(loads, ["s1", "s1"], "失敗しても読み直す");
  // ほかの失敗は [もう一度] つきのエラー。[もう一度] は同じ道へもう一度送る
  setReply(() => Promise.reject(Object.assign(new Error("x"), { status: 500 })));
  assert.equal(await ccSend.cancel(5, "s1"), false);
  assert.equal(toasts.at(-1), "送るのをやめられませんでした");
  const opts = toastOpts.at(-1) as { level: string; retry: () => Promise<boolean> };
  assert.equal(opts.level, "error");
  setReply(() => Promise.resolve({}));
  assert.equal(await opts.retry(), true);
  assert.deepEqual(posts.slice(-2), ["/api/cc/sends/5/cancel", "/api/cc/sends/5/cancel"]);
  assert.equal(toasts.at(-1), "送るのをやめました");
  // sessionId が無ければ読まない
  loads.length = 0;
  assert.equal(await ccSend.cancel(6, null), true);
  setReply(() => Promise.reject(Object.assign(new Error("x"), { status: 500 })));
  assert.equal(await ccSend.cancel(7, null), false);
  assert.deepEqual(loads, []);
});

test("web static: 古い帯（ccPendingBar）の [やめる] は押すと押せなくなり、通ればそのまま、409・ほかの失敗では押せる形に戻る", async () => {
  const { views, posts, setReply } = loadViews();
  const bar = (views as unknown as { ccPendingBar: (sessionId: string, pending: unknown) => FakeNode | null }).ccPendingBar;
  const press = async (id: number): Promise<{ now: boolean | undefined; after: boolean | undefined }> => {
    const button = bar("s1", { id, state: "queued", lastPaneState: null, replyState: null })!.buttons().find((b) => b.textContent === "やめる")! as FakeNode & { disabled?: boolean };
    button.dispatch("click");
    const now = button.disabled;
    for (let i = 0; i < 10; i += 1) await Promise.resolve();
    return { now, after: button.disabled };
  };
  assert.deepEqual(await press(3), { now: true, after: true }, "通った");
  setReply(() => Promise.reject(Object.assign(new Error("x"), { status: 409 })));
  assert.deepEqual(await press(4), { now: true, after: false }, "409");
  setReply(() => Promise.reject(Object.assign(new Error("x"), { status: 500 })));
  assert.deepEqual(await press(5), { now: true, after: false }, "500");
  assert.deepEqual(posts, ["/api/cc/sends/3/cancel", "/api/cc/sends/4/cancel", "/api/cc/sends/5/cancel"]);
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
  // 質問（AskUserQuestion）は「質問の答えを待っています」（progress.ts の permissionWaitingLine と同じ）
  assert.match(api, /if \(w\.toolName === "AskUserQuestion"\) return "質問の答えを待っています";\n {4}return "許可を待っています: "/);
  const css = read("app.css");
  assert.match(css, /\n\.run-waiting \{[^}]*color: var\(--text\);/);
});

test("web static: 新しいセッションのダイアログのプロジェクト（U1b）は /api/projects/workspace から「（なし）」を先頭に、選んだら projectDir。サイドバーの行にプロジェクトの印", () => {
  const html = read(CLASSIC_HTML);
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
  // 古い殻（classic.html）の説明と同じ文
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

// ===== 新しい殻（index.html・shell.js・topics.js・shell.css・tokens.css。docs/plan/web-ui-v3.md の M2a） =====
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

test("web static: 新しい殻（index.html）の読み込みの順（base → tokens → app → shell → c-atoms → c-sheet → c-list → c-shell → c-talk → c-composer → c-cards → c-hand → c-term → c-deck、ui → api → sound → chat → views → topics → takeover → flows → c-app（module）→ shell）と、sidebar.js・workbench.js を読まないこと", () => {
  const html = read(SHELL_HTML);
  assert.match(html, /<html lang="ja" data-theme="dark">/);
  const links = [...html.matchAll(/<link rel="stylesheet" href="([^"]+)">/g)].map((m) => m[1]);
  assert.deepEqual(links, ["/static/base.css", "/static/tokens.css", "/static/app.css", "/static/shell.css", "/static/c-atoms.css", "/static/c-sheet.css", "/static/c-list.css", "/static/c-shell.css", "/static/c-talk.css", "/static/c-composer.css", "/static/c-cards.css", "/static/c-hand.css", "/static/c-term.css", "/static/c-deck.css"]);
  // module は元から後回し（defer を書かない）。文書の順で topics.js の後・shell.js の前に動く
  const scripts = [...html.matchAll(/<script (?:type="module" )?src="([^"]+)"( defer)?><\/script>/g)].map((m) => [m[1], m[0].includes('type="module"') ? "module" : m[2] ? "defer" : "none"]);
  assert.deepEqual(scripts, [
    ...["ui", "api", "sound", "chat", "views", "topics", "takeover", "flows"].map((n) => [`/static/${n}.js`, "defer"]),
    ["/static/c-app.js", "module"],
    ["/static/shell.js", "defer"],
  ]);
  assert.equal([...html.matchAll(/<script\b/g)].length, scripts.length);
  assert.doesNotMatch(html, /sidebar\.js|workbench\.js/);
  // head の meta・title・manifest・icon は古い殻（classic.html）と同じ
  const headOf = (h: string) => h.slice(0, h.indexOf('<link rel="stylesheet"'));
  assert.equal(headOf(html), headOf(read(CLASSIC_HTML)));
});

test("web static: 新しい殻（index.html）に inline の script・style・style 属性が無く、ui.js が引く id（dlg-confirm と中の 5 つ・toast・toast-alert・ed）と、知らせ・確認の部品の根（#v3 の外）がある", () => {
  const html = read(SHELL_HTML);
  assert.doesNotMatch(html, /<style\b/i);
  assert.doesNotMatch(html, /\sstyle=/i);
  assert.doesNotMatch(html, /\son[a-z]+=/i);
  for (const m of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)) assert.equal((m[2] ?? "").trim(), "");
  for (const id of ["dlg-confirm", "dlg-confirm-title", "dlg-confirm-target", "dlg-confirm-body", "dlg-confirm-cancel", "dlg-confirm-ok", "toast", "toast-alert", "ed"]) {
    assert.match(html, new RegExp(`\\sid="${id}"`), id);
  }
  assert.match(html, /<body>\s*<a class="skip-link" href="#ed">本文へ<\/a>/);
  assert.match(html, /<div class="toast-stack" id="toast-alert" role="alert"[^>]*hidden><\/div>/);
  // 知らせ・確認の部品の根は body の直下（#v3 の inert・重なりの外）
  const shell = html.slice(html.indexOf('<div class="v3" id="v3"'), html.indexOf('<dialog id="v3-sheet"'));
  for (const id of ["c-notice-root", "c-ask-root"]) {
    assert.match(html, new RegExp(`<div class="v3-slot" id="${id}"></div>`), id);
    assert.equal(shell.includes(id), false, id);
  }
});

test("web static: 新しい殻（index.html）に古い殻の作る口が無い", () => {
  const html = read(SHELL_HTML);
  for (const word of ["dlg-new", "dlg-cc-start", "palette"]) assert.equal(html.includes(word), false, word);
});

test("web static: 新しい殻の SA.app は古い殻と同じ名前を全部持つ", () => {
  const now = appKeys(read("workbench.js"));
  assert.ok(now.length >= 20);
  assert.deepEqual(appKeys(read("shell.js")), now);
});

test("web static: 新しい殻の CSS の幅の段は 639 だけ。流れの列の 1340 は JS（c-deck.js の deckFit）が測る", () => {
  const css = read("shell.css");
  // 流れの列（D1）: CSS に 1340 と min-width の幅の段を書かず、席の幅の式の数は c-deck.js の DECK と同じ
  const deckCss = read("c-deck.css");
  for (const text of [css, deckCss]) {
    assert.doesNotMatch(text, /1340/);
    assert.doesNotMatch(text, /@media[^{]*min-width/);
  }
  assert.match(read("c-deck.js"), /SIDE_MIN: 1340,/);
  assert.equal(DECK.SIDE_MIN, 1340);
  assert.ok(css.includes(`grid-template-columns: minmax(0, 1fr) min(${DECK.SIDE_MAX}px, calc(100% - ${DECK.SIDE_REST}px));`));
  assert.ok(css.includes(`grid-template-columns: minmax(0, 1fr) clamp(${DECK.FOLD_MIN}px, ${DECK.FOLD_RATE! * 100}%, ${DECK.FOLD_MAX}px);`));
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
  // 流れの列の形（data-deck）の台は地（--bg）と同じ色なので、data-deck の版を置かない
  assert.ok(!block.includes("[data-deck]"), flat);
  assert.ok(
    flat.includes(`@media (prefers-color-scheme: light) { .v3:is(:root:not([data-theme]) *) { background: ${band} var(--bg); } }`),
    flat,
  );
  // 地（background）を書く .v3 の規則は 3 つで、どれも値が --bg で終わる
  const rules = [...css.matchAll(/([^{}@]+)\{([^{}]*)\}/g)].map((m) => ({ sel: m[1]!.trim().replace(/\s+/g, " "), body: m[2]! }));
  const grounds = rules.filter((r) => /^\.v3(?::is\(.*\))?$/.test(r.sel) && /(?:^|;)\s*background\s*:/.test(r.body));
  assert.equal(grounds.length, 3);
  for (const r of grounds) assert.match(r.body, /(?:^|;)\s*background\s*:[^;]*\bvar\(--bg\);/, r.sel);
  // 殻そのものに当たる規則（.v3 に属性・クラス・:is(...) が付いた物。子孫に宛てた物は別）は、上の 3 つのほか background・background-color・background-image を
  // 書かない（書くと、その条件でだけ台が地と別の色になる。data-deck・data-seat・data-view・テーマの :is のどれでも）
  const flatSel = (sel: string): string => {
    let out = sel;
    for (let prev = ""; prev !== out; ) {
      prev = out;
      out = out.replace(/\([^()]*\)/g, "");
    }
    return out;
  };
  const isShell = (part: string): boolean => /^\.v3(?![-\w])[^\s>+~]*$/.test(flatSel(part.trim()));
  const partsOf = (sel: string): string[] => sel.split(/,(?![^()]*\))/);
  const shells = rules.filter((r) => partsOf(r.sel).some(isShell));
  assert.ok(shells.some((r) => r.sel === ".v3[data-deck]"));
  assert.ok(shells.some((r) => r.sel.startsWith(".v3[data-deck][data-seat=")));
  const paints = shells.filter((r) => /(?:^|;)\s*background(?:-color|-image)?\s*:/.test(r.body));
  assert.deepEqual(paints.map((r) => r.sel).sort(), grounds.map((r) => r.sel).sort());
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

test("web static: 話題の polling は 待っている番か作業中があれば 10 秒、無ければ 60 秒（上限・失敗で止まった番は急がない）、隠れている間は予約しない", () => {
  const js = read("topics.js");
  assert.match(js, /const BUSY_MS = 10000;/);
  assert.match(js, /const IDLE_MS = 60000;/);
  const arm = fnSource(js, "arm");
  assert.match(arm, /clearTimeout\(timer\);/);
  assert.match(arm, /if \(document\.visibilityState === "visible" && !SA\.poll\.stopped\(\)\) \{\n\s*timer = setTimeout\(load, counts\(\)\.turns > stoppedTurns\(\) \|\| counts\(\)\.running > 0 \? BUSY_MS : IDLE_MS\);/);
  // 上限・失敗で止まった番（オーナーが動くまで変わらない）は急ぐ数から引く
  const stoppedTurns = fnSource(js, "stoppedTurns");
  assert.match(stoppedTurns, /t\.mark === "turn" && !!t\.turn && \(t\.turn\.kind === "max_turns" \|\| t\.turn\.kind === "failed"\)/);
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
    // [attr="値"] と、値なしの [attr]（その属性を持つ）
    const m = /^([a-z0-9]+)?((?:\.[\w-]+)*)(?:\[([\w-]+)(?:="([^"]*)")?\])?(?::not\(\[([\w-]+)\]\))?$/.exec(selector);
    assert.ok(m, selector);
    const classes = (m[2] ?? "").split(".").filter(Boolean);
    return descendants(this).filter(
      (n): n is DomNode =>
        n instanceof DomNode &&
        (!m[1] || n.tagName === m[1]) &&
        classes.every((c) => n.classes.has(c)) &&
        (!m[3] || (m[4] === undefined ? n.getAttribute(m[3]) !== null : n.getAttribute(m[3]) === m[4])) &&
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
  draft: (channelId: string) => string;
  setDraft: (channelId: string, value: string) => void;
  pruneDrafts: (channelIds: unknown[]) => void;
};
type Topics = { load: () => Promise<void>; schedule: () => void; render: () => void; counts: () => { turns: number; running: number } };
type HandFrame = {
  title: string;
  placeholder: string;
  ops?: () => DomNode[];
  outgoing?: (text: string) => string;
  replyText?: (text: string) => string;
  noticeText?: ((text: string) => string) | null;
  replyExtras?: (text: string) => DomNode[];
  head?: false;
  replyRefs?: (text: string) => Array<{ id: string; title: string; meta: string }>;
  onRef?: (id: string) => void;
};
type TermCtx = { row: { id: string } | null; place: string | null; pane: () => void };
type HandHeadState = { title: string; menu: boolean; on: { menu: (opener: unknown) => unknown; close: () => unknown } };

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
type BarState = { turns: number; hand: string | null; tabs: Array<{ id: string; title: string }>; controls?: string; on: BarOn };
type TopOn = { back: () => unknown; place: (opener: unknown) => unknown; view: (value: string) => unknown; menu: (opener: unknown) => unknown; hand: (opener: unknown) => unknown; mode: (opener: unknown) => unknown; close?: () => unknown };
type TopState = {
  view: string;
  title: string;
  status: { text: string; tone: string } | null;
  note: string | null;
  place: { text: string; movable: boolean; reason: string | null } | null;
  views: { value: string } | null;
  hand: string | null;
  compact?: boolean;
  menu: boolean;
  mode?: { value: string; disabled: boolean; reason: string | null } | null;
  close?: boolean;
  backLabel?: string;
  controls: string;
  on: TopOn;
};
const deckUrl = new URL("../src/web/static/c-deck.js", import.meta.url).href;
const { deckFit, DECK } = (await import(deckUrl)) as { deckFit: (width: number, seatOpen: boolean) => { cols: number; side: boolean; seat: number; colW: number }; DECK: Record<string, number> };
type BandState = { variant?: string; page?: string; conn: { tone: string; label: string } | null; hand: { mark: string | null; open: boolean }; controls: string; on: Record<string, (opener?: unknown) => unknown> };
/** スマホの流れの列の下のバー（SA.deck.drawBar の bar。D2） */
type DeckBarState = { page: string; hand: string | null; controls: string; on: { page: (id: string) => unknown; paged: (id: string) => unknown; hand: (opener: unknown) => unknown } };
const shellUrl = new URL("../src/web/static/c-shell.js", import.meta.url).href;
const { bottomModel } = (await import(shellUrl)) as { bottomModel: (o: { variant: string; turns: unknown; hand: unknown; tabs: unknown }) => BottomModel };
/** モデルの中の群（「ほかのプロジェクト」の中も） */
const modelGroups = (m: ListModel): ListGroup[] => m.blocks.flatMap((b) => (b.type === "group" ? [b] : b.type === "others" ? b.groups : []));

const v3Topic = (id: string, o: Record<string, unknown> = {}) => ({ id, title: id, origin: "session", persona: null, activityAt: null, state: "active", last: null, mark: null, turn: null, group: "g", place: null, ...o });
const v3Result = (topics: unknown[], o: Record<string, unknown> = {}) => ({ groups: [{ key: "g", name: "General", turns: 0, running: 0 }], topics, turns: 0, turnIds: [], rightHands: [], ...o });

/**
 * 新しい殻（index.html）の骨組みを DomNode で組み、ui.js・topics.js・shell.js を読み込む。views.info は known のタブだけを返し、
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
    noTop?: boolean;
    topDraw?: (st: TopState) => boolean;
    narrow?: boolean | null;
    /** 入力欄の口（SA.composer）の focus。在れば会話（ch:）の列 2 に [data-composer] の根を置く */
    composer?: (root: DomNode) => boolean;
    /** 右腕の見出しの口（SA.hand）。draw は答え（既定 true）、focus が false なら焦点を断る */
    hand?: { draw?: (st: HandHeadState | null) => boolean; focus?: boolean };
    /** 右腕の描画（chat.js の render の代わり）で、入力欄を古い .composer-wrap でなく [data-composer] の根にする */
    handComposer?: boolean;
    /**
     * 端末のセッションの札（作り物の SA.takeover と SA.term）。render・open・close を覚える。draw は render の答え（既定 true）、
     * noEntry なら SA.takeover を、noMouth なら SA.term を置かない。既定（渡さない）はどちらも無い
     */
    takeover?: { draw?: () => boolean; noEntry?: boolean; noMouth?: boolean };
    /**
     * 流れの列（D1）の作り物の入口 SA.deck・SA.flows と、#v3-band・#v3-deck・#v3-find-backdrop・見出しの［閉じる］を置く。
     * fit は本物の deckFit。focusItem は items に在る key だけ true。既定（渡さない）は今までどおり何も置かない。
     * スマホの下のバーの口（drawBar・page・focusBar）と #v3-foot も置く（noFoot なら置かない = スマホは落ち先）。deckBar は drawBar の答え（既定 true）
     */
    deck?: boolean;
    noFoot?: boolean;
    deckBar?: (bar: DeckBarState | null) => boolean;
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
  // 見出しの入れ物（中は部品が描く。fake DOM では data-act の付いた代わりのボタンだけ。SA.top.focus(act) がそこに焦点を置く）
  const topRoot = node("div", "c-top-root", "v3-slot");
  const topButtons: Record<string, DomNode> = {};
  for (const act of opts.deck ? ["back", "place", "menu", "hand", "close"] : ["back", "place", "menu", "hand"]) {
    const b = node("button");
    b.setAttribute("data-act", act);
    topButtons[act] = b;
    topRoot.append(b);
  }
  const ed = node("div", "ed", "ed");
  main.append(topRoot, ed);
  const hand = node("aside", "v3-hand", "v3-hand");
  const handShow = node("button", "v3-hand-show", "btn btn-ghost btn-sm btn-icon-sm v3-hand-show");
  const handEd = node("div", "v3-hand-ed", "ed v3-hand-ed");
  // 右腕の見出しの入れ物（opts.hand のときだけ。中は部品が描く。fake DOM では焦点の代わりのボタンだけ置く）
  const handRoot = node("div", "c-hand-root", "v3-slot");
  const handButtons: Record<string, DomNode> = {};
  for (const act of ["menu", "close"]) {
    const b = node("button");
    b.setAttribute("data-act", act);
    handButtons[act] = b;
    handRoot.append(b);
  }
  if (opts.hand) hand.append(handShow, handRoot, handEd);
  else hand.append(handShow, handEd);
  const backdrop = node("div", "v3-hand-backdrop", "v3-hand-backdrop");
  backdrop.hidden = true;
  // 流れの列（opts.deck のときだけ）: 帯の入れ物（中は代わりのボタン）・列の入れ物（中は代わりの項目のボタン 1 つ）・探すの板の幕
  const band = node("div", "v3-band", "v3-band");
  const bandRoot = node("div", "c-band-root", "v3-slot");
  const bandButtons: Record<string, DomNode> = {};
  for (const act of ["status", "find", "hand", "start", "more"]) {
    const b = node("button");
    b.setAttribute("data-act", act);
    bandButtons[act] = b;
    bandRoot.append(b);
  }
  band.append(bandRoot);
  const deckBox = node("div", "v3-deck", "v3-deck");
  const deckRoot = node("div", "c-deck-root", "v3-slot");
  const itemButton = node("button");
  deckRoot.append(itemButton);
  deckBox.append(deckRoot);
  const findBackdrop = node("div", "v3-find-backdrop", "v3-find-backdrop");
  findBackdrop.hidden = true;
  // スマホの流れの列の下のバーの入れ物（noFoot でなければ。中は代わりのボタン: 列 3 つと右腕）
  const foot = node("div", "v3-foot", "v3-foot");
  const footRoot = node("div", "c-foot-root", "v3-slot");
  const footButtons: Record<string, DomNode> = {};
  for (const act of ["turn", "tasks", "feed", "hand"]) {
    const b = node("button");
    b.setAttribute("data-act", act === "hand" ? "hand" : "page");
    footButtons[act] = b;
    footRoot.append(b);
  }
  foot.append(footRoot);
  if (opts.deck && !opts.noFoot) v3.append(band, list, deckBox, foot, main, hand, backdrop, findBackdrop);
  else if (opts.deck) v3.append(band, list, deckBox, main, hand, backdrop, findBackdrop);
  else v3.append(list, main, hand, backdrop);
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
  // 流れの列で席を閉じている間も .v3-main は display: none
  DomNode.hides = (n) =>
    n.hidden ||
    (n === main && (state.phone || v3.getAttribute("data-deck") !== null) && v3.getAttribute("data-view") === "list") ||
    (n === handEd && v3.getAttribute("data-hand") === "closed");
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
    pathname: "/",
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
  const warns: string[] = [];
  const fakeConsole = Object.assign(Object.create(console) as Console, { error: (...a: unknown[]) => void errors.push(a.join(" ")), warn: (...a: unknown[]) => void warns.push(a.join(" ")) });
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
              const comp = opts.composer && tab.startsWith("ch:") ? [ui.el("div", { "data-composer": tab.slice(3) })] : [];
              container.replaceChildren(ui.el("header", { class: "ed-toolbar" }, [ui.backButton()]), scroll, ...comp);
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
  // 右腕の描画（chat.js の render の代わり）: 見出しに題と frame.ops()、下端に寄せる .ed-scroll（高さは heights.hand）、入力欄は作り直さない。
  // head: false の枠は見出しを作らず、札は replyRefs のデータを div.fake-ref（data-topic・「題|meta」）にする（部品の道の代わり）
  const handRenders: Array<{ id: string; frame: HandFrame }> = [];
  const chatChannels: Record<string, unknown> = {};
  const chatHeads: Record<string, unknown> = {};
  // 右腕の Bot の返事の本文（描くたびに replyText・replyExtras を通して .ed-scroll に入れる）
  const handReplies: string[] = [];
  // 右腕の知らせ（notice）の本文（返事の後ろに、描くたびに noticeText を通して p.fake-notice で入れる）
  const handNotices: string[] = [];
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
    // 見出しの中身（chat.js の head。入れていないチャンネルは null）
    head: (id: string) => chatHeads[id] ?? null,
    channelTitle: (ch: { title?: string }) => ch.title ?? "セッション",
    STATE_LABEL: { active: "進行中", waiting: "待ち", done: "完了" },
    render: (container: DomNode, id: string, frame: HandFrame) => {
      handRenders.push({ id, frame });
      const kept = (container.children as DomNode[]).find((c) => c.classes.has("composer-wrap"));
      const scroll = ui.el("div", { class: "ed-scroll", "data-stick": "bottom" });
      scroll.scrollHeight = heights.hand ?? 1000;
      scroll.clientHeight = 200;
      const bare = frame.head === false;
      for (const text of handReplies) {
        const extras = bare
          ? (frame.replyRefs ? frame.replyRefs(text) : []).map((r) => ui.el("div", { class: "fake-ref", "data-topic": r.id, text: r.title + "|" + r.meta }))
          : frame.replyExtras
            ? frame.replyExtras(text)
            : [];
        scroll.append(ui.el("div", { class: "msg" }, [ui.el("p", { class: "msg-text", text: frame.replyText ? frame.replyText(text) : text }), ...extras]));
      }
      for (const text of handNotices) {
        scroll.append(ui.el("p", { class: "fake-notice", text: frame.noticeText ? frame.noticeText(text) : text }));
      }
      const head = bare ? null : ui.el("header", { class: "ed-toolbar" }, [ui.el("h2", { text: frame.title }), ...(frame.ops ? frame.ops() : [])]);
      const keptRoot = (container.children as DomNode[]).find((c) => c.getAttribute("data-composer") !== null);
      const input = opts.handComposer ? (keptRoot ?? ui.el("div", { "data-composer": id })) : (kept ?? ui.el("div", { class: "composer-wrap" }, [ui.el("textarea", { class: "composer-input" })]));
      container.replaceChildren(...[head, scroll, input].filter((n): n is DomNode => n !== null));
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
  // 見出しの入口（c-app.js の SA.top）の代わり: draw は state を覚え、focus は act を覚えて代わりのボタンに焦点、compact は測った回数を数えて narrow を返す
  const top = {
    draws: [] as TopState[],
    focuses: [] as string[],
    measures: 0,
    narrow: (opts.narrow === undefined ? false : opts.narrow) as boolean | null,
    // focus が false を返す act（ボタンが無い・押せない入口の代わり）
    refuse: new Set<string>(),
    draw(st: TopState) {
      top.draws.push(st);
      return opts.topDraw ? opts.topDraw(st) : true;
    },
    focus(act: string) {
      top.focuses.push(act);
      if (top.refuse.has(act)) return false;
      topButtons[act]?.focus();
      return true;
    },
    compact() {
      top.measures += 1;
      return top.narrow;
    },
  };
  if (!opts.noTop) SA.top = top;
  if (opts.composer) SA.composer = { focus: opts.composer, draw: () => true, set: () => true, drop: () => undefined };
  // 札の作り物: render は列 2 に .ed-scroll > [data-term] を置き、渡された ctx を覚える
  const term = { renders: [] as Array<{ sessionId: string; ctx: TermCtx }>, opens: [] as string[], closes: [] as string[] };
  const takeoverOpts = opts.takeover;
  if (takeoverOpts && !takeoverOpts.noEntry)
    SA.takeover = {
      render: (container: DomNode, sessionId: string, ctx: TermCtx) => {
        term.renders.push({ sessionId, ctx });
        if (takeoverOpts.draw && !takeoverOpts.draw()) return false;
        container.replaceChildren(ui.el("div", { class: "ed-scroll" }, [ui.el("div", { "data-term": "" })]));
        return true;
      },
      open: (sessionId: string) => void term.opens.push(sessionId),
      close: (sessionId: string) => void term.closes.push(sessionId),
    };
  if (takeoverOpts && !takeoverOpts.noMouth) SA.term = { draw: () => true, drop: () => undefined };
  // 右腕の見出しの入口（c-app.js の SA.hand）の代わり: draw は state を覚え、focus は what を覚えて代わりのボタンに焦点
  const handHead = { draws: [] as Array<HandHeadState | null>, focuses: [] as string[] };
  const handOpts = opts.hand;
  if (handOpts)
    SA.hand = {
      draw(st: HandHeadState | null) {
        handHead.draws.push(st);
        return handOpts.draw ? handOpts.draw(st) : true;
      },
      focus(what: string) {
        handHead.focuses.push(what);
        if (handOpts.focus === false) return false;
        handButtons[what]?.focus();
        return true;
      },
    };
  /** 最後に描いた見出しの state */
  const lastTop = (): TopState => {
    const st = top.draws[top.draws.length - 1];
    assert.ok(st, "SA.top.draw が呼ばれていない");
    return st;
  };
  // 流れの列の入口の代わり: draw・drawBand は state を覚え、focusItem は items に在る key のとき代わりの項目のボタンに焦点、focusBand は帯の代わりのボタンに焦点
  // スマホの下のバーの口: drawBar は bar を覚え、page は id を覚え、focusBar は代わりのボタンに焦点
  const deckSeen = {
    draws: [] as unknown[],
    bands: [] as BandState[],
    focusItems: [] as string[],
    focusBands: [] as string[],
    items: new Set<string>(),
    bars: [] as Array<DeckBarState | null>,
    pages: [] as string[],
    focusBars: [] as string[],
  };
  // views は cols・current だけ（D1 の検査の形）、passed は渡された物そのまま（paged も。D2）
  const flowSeen = {
    inits: 0,
    statuses: 0,
    views: [] as Array<{ cols: number; current: string | null }>,
    passed: [] as Array<{ cols: number; current: string | null; paged?: boolean }>,
    renders: 0,
    key: null as string | null,
  };
  if (opts.deck) {
    SA.deck = {
      draw(st: unknown) {
        deckSeen.draws.push(st);
        return true;
      },
      drawBand(st: BandState) {
        deckSeen.bands.push(st);
        return true;
      },
      fit: deckFit,
      focusItem(key: string) {
        deckSeen.focusItems.push(key);
        if (!deckSeen.items.has(key)) return false;
        itemButton.focus();
        return true;
      },
      focusBand(act: string) {
        deckSeen.focusBands.push(act);
        const b = bandButtons[act];
        if (!b) return false;
        b.focus();
        return true;
      },
    };
    if (!opts.noFoot) {
      const deckBar = opts.deckBar;
      Object.assign(SA.deck as Record<string, unknown>, {
        drawBar(bar: DeckBarState | null) {
          deckSeen.bars.push(bar);
          return deckBar ? deckBar(bar) : true;
        },
        page(id: string) {
          deckSeen.pages.push(id);
          return true;
        },
        focusBar(act: string) {
          deckSeen.focusBars.push(act);
          const b = footButtons[act];
          if (!b) return false;
          b.focus();
          return true;
        },
      });
    }
    // flows.js の代わり: 呼ばれた事を覚える。lastKey は key を 1 回だけ返す（項目を押した代わりに key を置いてから open）
    SA.flows = {
      init: () => void flowSeen.inits++,
      status: () => void flowSeen.statuses++,
      setView: (v: { cols: number; current: string | null; paged?: boolean }) => {
        flowSeen.views.push({ cols: v.cols, current: v.current });
        flowSeen.passed.push({ ...v });
      },
      render: () => void flowSeen.renders++,
      lastKey: () => {
        const k = flowSeen.key;
        flowSeen.key = null;
        return k;
      },
    };
  }
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
    warns,
    handHead,
    handButtons,
    term,
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
    nodes: { v3, ed, listRoot, headOps, searchBox, sheet: ids.get("v3-sheet")!, list, main, topRoot, topButtons, hand, handEd, handShow, backdrop, bottomRoot, bottomHand, bottomMore, band, bandButtons, deckBox, itemButton, findBackdrop, foot, footButtons },
    deck: deckSeen,
    flows: flowSeen,
    top,
    lastTop,
    handRenders,
    chatChannels,
    chatHeads,
    handReplies,
    handNotices,
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

test("web static: v3 の書きかけ: 一覧に無いチャンネルの分は消すが、列 2 に開いている会話の分は残す", async () => {
  const h = loadShell();
  await h.flush();
  h.app.open("ch:a");
  h.app.setDraft("a", "開いている会話の書きかけ");
  h.app.setDraft("b", "一覧に在る");
  h.app.setDraft("gone", "一覧に無い");
  h.app.pruneDrafts(["b"]);
  assert.deepEqual([h.app.draft("a"), h.app.draft("b"), h.app.draft("gone")], ["開いている会話の書きかけ", "一覧に在る", ""]);
  // 別の話題へ移った後は、一覧に無ければ消す
  h.app.open("ch:b");
  h.app.pruneDrafts(["b"]);
  assert.deepEqual([h.app.draft("a"), h.app.draft("b")], ["", "一覧に在る"]);
});

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
  // 今のスマホの殻と、流れの列（D2。H11）で同じ期待
  for (const deck of [false, true]) {
    const h = loadShell({ phone: true, deck });
    await h.flush();
    h.app.open("ch:a");
    assert.deepEqual(h.rendered.at(-1), { tab: "ch:a", view: "body" });
    assert.equal(h.calls.push, 1);
    assert.equal(h.location.hash, "#/ch/a");
    // 焦点は見出しの部品の「一覧へ」（SA.top.focus("back")）
    assert.equal(h.top.focuses.at(-1), "back");
    assert.equal(h.document.activeElement, h.nodes.topButtons.back);
    // 会話を出したまま別の話題: 積み増さない
    h.app.open("ch:b");
    assert.equal(h.calls.push, 1);
    assert.equal(h.location.hash, "#/ch/b");
    h.history.back();
    assert.equal(h.nodes.v3.getAttribute("data-view"), "list");
    h.history.forward();
    assert.equal(h.nodes.v3.getAttribute("data-view"), "body");
  }
  // PC では [‹] に焦点を移さない
  const pc = loadShell();
  await pc.flush();
  pc.app.open("ch:a");
  assert.equal(pc.calls.push, 0);
  assert.equal(pc.document.activeElement.tagName, "body");
  assert.deepEqual(pc.top.focuses, []);
  // 入口（SA.top）が無ければ、今の見出しの [‹] に焦点。見出しの描き直しは投げない
  const old = loadShell({ phone: true, noTop: true });
  await old.flush();
  old.app.open("ch:a");
  assert.ok((old.document.activeElement as DomNode).classes.has("ed-back"));
  old.app.refresh("ch:a");
  old.app.refreshTabs();
});

const topPlain = (st: TopState) => JSON.parse(JSON.stringify({ ...st, on: undefined })) as Record<string, unknown>;

test("web static: 見出しの state（topState）: 何も開いていなければ none、話題でない画面は other、話題は talk。題は話題の題が先で、空なら画面の題", async () => {
  const h = loadShell({ known: (tab) => tab.startsWith("ch:") || tab === "settings" });
  h.api.reply = () => Promise.resolve(v3Result([v3Topic("ch:a", { title: "話題 A", group: "general", place: { dir: null } }), v3Topic("ch:b", { title: "" })]));
  await h.flush();
  await h.topics.load();
  assert.deepEqual(topPlain(h.lastTop()), { view: "none", title: "", status: null, note: null, place: null, views: null, hand: null, compact: false, menu: false, mode: null, close: false, controls: "v3-hand" });
  h.app.open("settings");
  assert.deepEqual(topPlain(h.lastTop()), { view: "other", title: "題:settings", status: null, note: null, place: null, views: null, hand: null, compact: false, menu: false, mode: null, close: false, controls: "v3-hand" });
  h.app.open("ch:a");
  assert.deepEqual(topPlain(h.lastTop()), {
    view: "talk",
    title: "話題 A",
    status: null,
    note: null,
    place: { text: "なし", movable: false, reason: null },
    views: null,
    hand: null,
    compact: false,
    menu: false,
    mode: null,
    close: false,
    controls: "v3-hand",
  });
  h.app.open("ch:b");
  assert.equal(h.lastTop().title, "題:ch:b");
  // 一覧に居ないチャンネル（話題でない）は other
  h.app.open("ch:zzz");
  assert.equal(h.lastTop().view, "other");
  assert.equal(h.lastTop().title, "題:ch:zzz");
  // on は毎回同じ物
  assert.equal(h.top.draws[0]!.on, h.lastTop().on);
});

test("web static: 見出しの状態の語は あなたの番 > 作業中 > head.status、note は head の物。menu は広い幅では head.menu があるときだけ、スマホは話題なら出す", async () => {
  const topics = [v3Topic("ch:1", { mark: "turn" }), v3Topic("ch:2", { mark: "running" }), v3Topic("ch:3")];
  const h = loadShell();
  h.api.reply = () => Promise.resolve(v3Result(topics));
  await h.flush();
  await h.topics.load();
  const head = { title: "x", status: { text: "待ち", tone: "muted" }, note: "既定", menu: [] as unknown[] };
  for (const id of ["1", "2", "3"]) h.chatHeads[id] = head;
  h.app.open("ch:1");
  assert.deepEqual(topPlain(h.lastTop()).status, { text: "あなたの番", tone: "warning" });
  assert.equal(h.lastTop().note, "既定");
  h.app.open("ch:2");
  assert.deepEqual(topPlain(h.lastTop()).status, { text: "作業中", tone: "accent" });
  h.app.open("ch:3");
  assert.deepEqual(topPlain(h.lastTop()).status, { text: "待ち", tone: "muted" });
  assert.equal(h.lastTop().menu, false, "広い幅で head.menu が空");
  head.menu = [{ label: "会話を新しくする" }];
  h.app.refresh("ch:3");
  assert.equal(h.lastTop().menu, true);
  // head が無ければ status・note は null
  delete h.chatHeads["3"];
  h.app.refresh("ch:3");
  assert.equal(h.lastTop().status, null);
  assert.equal(h.lastTop().note, null);
  assert.equal(h.lastTop().menu, false);
  const p = loadShell({ phone: true });
  p.api.reply = () => Promise.resolve(v3Result(topics));
  await p.flush();
  await p.topics.load();
  p.app.open("ch:3");
  assert.equal(p.lastTop().menu, true, "スマホは場所を変えるが「…」の中");
});

test("web static: 見出しを描けなければ、題だけの state で 1 回だけ描き直す（それも描けなければそれきり）", async () => {
  const ok: boolean[] = [];
  const h = loadShell({ topDraw: () => ok.shift() ?? true });
  h.api.reply = () => Promise.resolve(v3Result([v3Topic("ch:a", { title: "A", mark: "turn" })]));
  await h.flush();
  await h.topics.load();
  const n = h.top.draws.length;
  ok.push(false);
  h.app.open("ch:a");
  const [full, quiet] = h.top.draws.slice(n);
  assert.equal(full!.status!.text, "あなたの番");
  assert.deepEqual(topPlain(quiet!), { view: "talk", title: "A", status: null, note: null, place: null, views: null, hand: null, compact: false, menu: false, mode: null, close: false, controls: "v3-hand" });
  // 最小の state にも今の compact が入る
  h.top.narrow = true;
  h.fire("resize");
  const k = h.top.draws.length;
  ok.push(false);
  h.app.refresh("ch:a");
  assert.equal(h.top.draws[k + 1]!.compact, true);
  assert.equal(quiet!.on, full!.on);
  // 2 回とも描けなければ 2 回で止まる
  const m = h.top.draws.length;
  ok.push(false, false);
  h.app.refresh("ch:a");
  assert.equal(h.top.draws.length - m, 2);
});

test("web static: 見出しの「…」の板: スマホは「場所を変える」（動かせなければ押せず理由）と、Claude Code の話題の「端末を見る」⇄「会話に戻る」を先頭に、後ろに head.menu。広い幅は head.menu だけ", async () => {
  const topics = [
    v3Topic("ch:1", { title: "動かせる", movable: true }),
    v3Topic("ch:2", { title: "動かせない", movable: { reason: "完了した話題は場所を変えられません" } }),
    v3Topic("ch:3", { title: "端末", origin: "cc", sessionId: "s1" }),
  ];
  const rowsOf = (x: ReturnType<typeof loadShell>) =>
    x.nodes.sheet.querySelectorAll("button.more-row").map((r) => [textOf(r.querySelector("span.sb-label")!), r.getAttribute("disabled") !== null, r.querySelector("span.sb-meta") ? textOf(r.querySelector("span.sb-meta")!) : null]);
  const menu = (x: ReturnType<typeof loadShell>) => x.lastTop().on.menu(x.nodes.topButtons.menu);
  const runs: string[] = [];
  const headMenu = [{ icon: "rotate-ccw", label: "会話を新しくする", run: () => runs.push("renew") }];
  const p = loadShell({ phone: true });
  p.api.reply = () => Promise.resolve(v3Result(topics, { groups: startGroups() }));
  await p.flush();
  await p.topics.load();
  for (const id of ["1", "2", "3"]) p.chatHeads[id] = { title: "x", status: null, note: null, menu: headMenu };
  p.app.open("ch:1");
  menu(p);
  assert.equal(p.nodes.sheet.getAttribute("aria-label"), "動かせる の操作");
  assert.deepEqual(rowsOf(p), [
    ["場所を変える", false, null],
    ["会話を新しくする", false, null],
  ]);
  // 「場所を変える」は場所の板（opener は「…」）
  p.nodes.sheet.querySelectorAll("button.more-row")[0]!.dispatch("click");
  assert.equal(p.nodes.sheet.getAttribute("aria-label"), "場所を変える");
  p.nodes.sheet.removeAttribute("open");
  p.app.open("ch:2");
  menu(p);
  assert.deepEqual(rowsOf(p)[0], ["場所を変える", true, "完了した話題は場所を変えられません"]);
  p.nodes.sheet.querySelectorAll("button.more-row")[1]!.dispatch("click");
  assert.deepEqual(runs, ["renew"]);
  p.app.open("ch:3");
  menu(p);
  assert.deepEqual(rowsOf(p).map((r) => r[0]), ["場所を変える", "端末を見る", "会話を新しくする"]);
  p.nodes.sheet.querySelectorAll("button.more-row")[1]!.dispatch("click");
  assert.equal(p.app.activeTabId(), "cc:s1");
  menu(p);
  assert.deepEqual(rowsOf(p).map((r) => r[0]), ["場所を変える", "会話に戻る", "会話を新しくする"]);
  p.nodes.sheet.querySelectorAll("button.more-row")[1]!.dispatch("click");
  assert.equal(p.app.activeTabId(), "ch:3");
  // 広い幅は head.menu だけ。head も無ければ開かない
  const w = loadShell();
  w.api.reply = p.api.reply;
  await w.flush();
  await w.topics.load();
  w.chatHeads["3"] = { title: "x", status: null, note: null, menu: headMenu };
  w.app.open("ch:3");
  menu(w);
  assert.deepEqual(rowsOf(w).map((r) => r[0]), ["会話を新しくする"]);
  w.nodes.sheet.removeAttribute("open");
  w.app.open("ch:1");
  menu(w);
  assert.equal(w.nodes.sheet.getAttribute("open"), null);
});

test("web static: 板の close が、板が開いている間に届いても opener を消さない（閉じてすぐ開き直したとき）", async () => {
  const h = loadShell();
  h.api.reply = () => Promise.resolve(v3Result([v3Topic("ch:1", { movable: true })], { groups: startGroups() }));
  await h.flush();
  await h.topics.load();
  h.chatHeads["1"] = { title: "x", status: null, note: null, menu: [{ icon: "x", label: "何か", run: () => undefined }] };
  h.app.open("ch:1");
  const sheet = h.nodes.sheet as DomNode & { open?: boolean };
  h.lastTop().on.menu(h.nodes.topButtons.menu);
  // 開き直した後に、前の close が届く
  sheet.open = true;
  sheet.dispatch("close");
  assert.notEqual(h.document.activeElement, h.nodes.topButtons.menu, "開いている間は焦点を動かさない");
  // 閉じた後の close で opener へ
  sheet.open = false;
  sheet.dispatch("close");
  assert.equal(h.document.activeElement, h.nodes.topButtons.menu);
});

test("web static: refresh は列 2 に出ているタブなら見出しも描き、出ていないタブでは描かない", async () => {
  const h = loadShell();
  h.api.reply = () => Promise.resolve(v3Result([v3Topic("ch:1"), v3Topic("ch:2")]));
  await h.flush();
  await h.topics.load();
  h.app.open("ch:1");
  const n = h.top.draws.length;
  h.app.refresh("ch:2");
  assert.equal(h.top.draws.length, n);
  h.app.refresh("ch:1");
  assert.equal(h.top.draws.length, n + 1);
});

test("web static: fitTop: resize で列 2 を測らせ、compact が替わったときだけ描く。null（測れない）は compact", async () => {
  const h = loadShell();
  h.api.reply = () => Promise.resolve(v3Result([v3Topic("ch:1", { movable: true })], { groups: startGroups() }));
  await h.flush();
  await h.topics.load();
  h.app.open("ch:1");
  assert.equal(h.lastTop().compact, false);
  assert.equal(h.lastTop().menu, false, "広い幅で head.menu が無い");
  h.top.narrow = true;
  h.fire("resize");
  assert.equal(h.lastTop().compact, true);
  assert.equal(h.lastTop().menu, true, "compact は場所が「…」の中");
  const n = h.top.draws.length;
  h.fire("resize");
  assert.equal(h.top.draws.length, n, "同じ値なら描かない");
  h.top.narrow = false;
  h.fire("resize");
  assert.equal(h.top.draws.length, n + 1);
  assert.equal(h.lastTop().compact, false);
  // 測れない（null）は compact。もう 1 回でも描かない
  h.top.narrow = null;
  h.fire("resize");
  assert.equal(h.lastTop().compact, true);
  const m = h.top.draws.length;
  h.fire("resize");
  assert.equal(h.top.draws.length, m);
});

test("web static: fitTop: 右腕の開閉（applyHand）で測り直し、重ねた右腕・板が開いている間は測らない（閉じた所で測る）", async () => {
  // 列の右腕
  const c = await loadHand();
  let before = c.top.measures;
  c.top.narrow = true;
  handClose(c).dispatch("click");
  assert.ok(c.top.measures > before, "畳む");
  assert.equal(c.lastTop().compact, true);
  before = c.top.measures;
  c.top.narrow = false;
  c.nodes.handShow.dispatch("click");
  assert.ok(c.top.measures > before, "開く");
  assert.equal(c.lastTop().compact, false);
  // 重ねた右腕: 開いている間の resize は測らない。畳むと測る
  const o = await loadHand({ width: 900 });
  o.nodes.handShow.dispatch("click");
  assert.equal(o.nodes.v3.getAttribute("data-hand-mode"), "over");
  before = o.top.measures;
  o.top.narrow = true;
  o.fire("resize");
  assert.equal(o.top.measures, before);
  o.nodes.backdrop.dispatch("click");
  assert.ok(o.top.measures > before);
  assert.equal(o.lastTop().compact, true);
  // 板: 開いている間の resize は測らず、close で opener に戻してから測る
  const s = await loadHand({}, [v3Topic("ch:1")]);
  s.app.open("ch:1");
  const sheet = s.nodes.sheet as DomNode & { open?: boolean };
  s.chatHeads["1"] = { title: "x", status: null, note: null, menu: [{ icon: "x", label: "何か", run: () => undefined }] };
  s.top.narrow = true;
  s.fire("resize");
  s.top.narrow = false;
  s.fire("resize");
  s.lastTop().on.menu(s.nodes.topButtons.menu);
  assert.equal(sheet.getAttribute("open"), "");
  sheet.open = true;
  before = s.top.measures;
  s.top.narrow = true;
  s.fire("resize");
  assert.equal(s.top.measures, before, "板が開いている間は測らない");
  // close の受け手: opener へ焦点 → 測る の順
  let focusedAt = -1;
  const menuBtn = s.nodes.topButtons.menu as DomNode & { focus: () => void };
  const focus = menuBtn.focus.bind(menuBtn);
  menuBtn.focus = () => {
    focusedAt = s.top.measures;
    focus();
  };
  sheet.open = false;
  sheet.removeAttribute("open");
  sheet.dispatch("close");
  assert.equal(focusedAt, before, "測る前に opener へ");
  assert.equal(s.top.measures, before + 1);
  assert.equal(s.lastTop().compact, true);
});

test("web static: compact の「…」の板は広い幅でも「場所を変える」（動かせなければ理由）と「端末を見る」⇄「会話に戻る」を先頭に、後ろに head.menu", async () => {
  const topics = [
    v3Topic("ch:1", { title: "動かせない", movable: { reason: "完了した話題は場所を変えられません" } }),
    v3Topic("ch:3", { title: "端末", origin: "cc", sessionId: "s1", movable: true }),
  ];
  const w = loadShell({ narrow: true });
  w.api.reply = () => Promise.resolve(v3Result(topics, { groups: startGroups() }));
  await w.flush();
  await w.topics.load();
  const headMenu = [{ icon: "rotate-ccw", label: "会話を新しくする", run: () => undefined }];
  w.chatHeads["1"] = { title: "x", status: null, note: null, menu: headMenu };
  w.chatHeads["3"] = { title: "x", status: null, note: null, menu: headMenu };
  const rows = () => w.nodes.sheet.querySelectorAll("button.more-row").map((r) => [textOf(r.querySelector("span.sb-label")!), r.getAttribute("disabled") !== null, r.querySelector("span.sb-meta") ? textOf(r.querySelector("span.sb-meta")!) : null]);
  w.app.open("ch:1");
  assert.equal(w.lastTop().compact, true);
  w.lastTop().on.menu(w.nodes.topButtons.menu);
  assert.deepEqual(rows(), [
    ["場所を変える", true, "完了した話題は場所を変えられません"],
    ["会話を新しくする", false, null],
  ]);
  w.nodes.sheet.removeAttribute("open");
  w.app.open("ch:3");
  w.lastTop().on.menu(w.nodes.topButtons.menu);
  assert.deepEqual(rows().map((r) => r[0]), ["場所を変える", "端末を見る", "会話を新しくする"]);
  w.nodes.sheet.querySelectorAll("button.more-row")[1]!.dispatch("click");
  assert.equal(w.app.activeTabId(), "cc:s1");
  w.lastTop().on.menu(w.nodes.topButtons.menu);
  assert.deepEqual(rows().map((r) => r[0]), ["場所を変える", "会話に戻る", "会話を新しくする"]);
  w.nodes.sheet.querySelectorAll("button.more-row")[1]!.dispatch("click");
  assert.equal(w.app.activeTabId(), "ch:3");
  // 「場所を変える」は場所の板へ
  w.lastTop().on.menu(w.nodes.topButtons.menu);
  w.nodes.sheet.querySelectorAll("button.more-row")[0]!.dispatch("click");
  assert.equal(w.nodes.sheet.getAttribute("aria-label"), "場所を変える");
});

test("web static: SA.top が無いとき、resize・右腕の開閉・板の close で投げない。スマホの境をまたぐと測る", async () => {
  const h = loadShell({ noTop: true });
  await h.flush();
  h.fire("resize");
  h.nodes.handShow.dispatch("click");
  h.nodes.sheet.dispatch("close");
  h.setPhone(true, 390);
  h.setPhone(false, 1400);
  const t = loadShell();
  await t.flush();
  const before = t.top.measures;
  // setPhone は change と resize を出すので、change の受け手だけでも 1 回は増える
  t.setPhone(true, 390);
  assert.ok(t.top.measures >= before + 1);
});

test("web static: 測れるまでは compact（S.topCompact の初めは true）。測れれば広い幅は compact でない", async () => {
  const h = loadShell({ narrow: null });
  h.api.reply = () => Promise.resolve(v3Result([v3Topic("ch:1", { movable: true })], { groups: startGroups() }));
  await h.flush();
  await h.topics.load();
  h.app.open("ch:1");
  assert.equal(h.lastTop().compact, true);
  assert.equal(h.lastTop().menu, true);
  h.lastTop().on.menu(h.nodes.topButtons.menu);
  assert.equal(textOf(h.nodes.sheet.querySelectorAll("button.more-row")[0]!.querySelector("span.sb-label")!), "場所を変える");
  // 既定（測れて false）なら広い形
  const w = loadShell();
  w.api.reply = h.api.reply;
  await w.flush();
  await w.topics.load();
  w.app.open("ch:1");
  assert.equal(w.lastTop().compact, false);
  assert.match(fnSource(read("shell.js"), "fitTop"), /const next = SA\.top\.compact\(\) === false \? false : true;/);
  assert.match(read("shell.js"), /\n {4}topCompact: true,\n/);
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
  assert.deepEqual(Object.keys(first).sort(), ["controls", "hand", "on", "tabs", "turns"]);
  // 右腕のボタンの aria-controls の先（見出しの [右腕] と同じ）
  assert.equal(first.controls, "v3-hand");
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
      assert.equal(quiet.controls, "v3-hand");
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
  // 話題でない画面の見出しは other（場所・「…」を出さない）
  assert.equal(h.lastTop().view, "other");
  assert.equal(h.lastTop().title, "題:settings");
  assert.equal(h.lastTop().place, null);
  assert.equal(h.lastTop().menu, false);

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
  // 見出しの state の views（描くのは部品の Segmented）
  assert.deepEqual(JSON.parse(JSON.stringify(h.lastTop().views)), { value: "talk" });
  const view = (value: string) => h.lastTop().on.view(value);
  h.scroll().scrollTop = 100;
  view("pane");
  assert.equal(h.app.activeTabId(), "cc:s1");
  assert.deepEqual(h.rendered.at(-1)!.tab, "cc:s1");
  assert.ok(h.opens.includes("cc:s1"), "画面の写しを読み直す");
  assert.deepEqual(JSON.parse(JSON.stringify(h.lastTop().views)), { value: "pane" });
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
  view("talk");
  assert.equal(h.app.activeTabId(), "ch:a");
  assert.equal(h.scroll().scrollTop, 800);
  assert.deepEqual(h.closes, [], "切り替えでは閉じない");
  // 話題を開き直すと会話に戻る
  view("pane");
  h.app.open("ch:a");
  assert.equal(h.app.activeTabId(), "ch:a");
  assert.equal(h.rendered.at(-1)!.tab, "ch:a");
  // セッションが一覧から外れたら端末をやめて会話を描く
  view("pane");
  topics[0] = v3Topic("ch:a", { origin: "cc", sessionId: null });
  await h.topics.load();
  assert.equal(h.lastTop().views, null);
  assert.equal(h.app.activeTabId(), "ch:a");
  assert.equal(h.rendered.at(-1)!.tab, "ch:a");
  // チャンネルの無い・Claude Code でない・一覧に居ない話題には出さない
  for (const id of ["ch:b", "cc:x", "ch:c"]) {
    h.app.open(id);
    assert.equal(h.lastTop().views, null, id);
    assert.equal(h.app.activeTabId(), id);
  }
});

test("web static: スマホで会話の列が隠れている間の [端末] の refresh も、出している物で見る", async () => {
  const h = loadShell({ phone: true });
  h.api.reply = () => Promise.resolve(v3Result([v3Topic("ch:a", { origin: "cc", sessionId: "s1" })]));
  await h.flush();
  await h.topics.load();
  h.app.open("ch:a");
  h.lastTop().on.view("pane");
  h.history.back();
  const before = h.rendered.length;
  h.app.refresh("ch:a");
  assert.equal(h.rendered.length, before);
  h.app.refresh("cc:s1");
  assert.equal(h.rendered.length, before + 1);
});

test("web static: 接続の点と鈴は古い殻と同じラベルで、押すと状態・知らせを開く", async () => {
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
  head?: false;
  replyRefs?: (text: string) => Array<{ id: string; title: string; meta: string }>;
  onRef?: (id: string) => void;
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
  /** setInterval に渡された受け手（1 秒の刻みを手で回す） */
  const intervals: Array<() => void> = [];
  const touchListeners: Array<() => void> = [];
  const touch = { matches: false, addEventListener: (_t: string, fn: () => void) => touchListeners.push(fn) };
  const context = {
    window: { matchMedia: () => touch } as Record<string, unknown>,
    document,
    setTimeout: () => 0,
    clearTimeout: () => undefined,
    setInterval: (fn: () => void) => {
      intervals.push(fn);
      return 0;
    },
    Intl,
    Date,
    Number,
  };
  vm.runInNewContext(read("ui.js"), context);
  const SA = (context.window as { SA: Record<string, unknown> }).SA;
  const toasts: string[] = [];
  /** toast の 3 つ目の引数（[もう一度] の retry など） */
  const toastOpts: unknown[] = [];
  (SA.ui as { toast: unknown }).toast = (text: string, _a?: unknown, o?: unknown) => {
    toasts.push(text);
    toastOpts.push(o);
  };
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
    toastOpts,
    touch,
    touchListeners,
    box,
    put,
    flush,
    intervals,
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
  // 古い殻（workbench.js）: S.active で決まる
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
  vm.runInNewContext(fnSource(sh, "termSession") + fnSource(sh, "shownTabId") + fnSource(sh, "shownChannelIds") + "\nresult = shownChannelIds();", ctx);
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
  assert.equal(fh.querySelector("div.ed-title")!.children.length, 1, "題の欄は h2 だけ（アイコンを置かない）");
  assert.equal(fh.querySelector("h2")!.textContent, "右腕");
  assert.equal(fh.querySelector("h1"), null, "ページの h1 は列 2 の見出しの 1 つ");
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
  // 一覧がまだ（読み込み中でチャンネルが引けない）なら h2 と足したボタンだけ
  const loading = c.box();
  c.chat.render(loading, "3", frame);
  const lh = loading.querySelector("header.ed-toolbar")!;
  assert.equal(lh.querySelector("h2")!.textContent, "右腕");
  assert.equal(lh.querySelector("h1"), null);
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

test("web static: SA.top があると chat.js の render は列 2 の見出し（header.ed-toolbar）を作らず、右腕の枠（frame）は今の見出しのまま。head: false の枠は見出しを作らない", () => {
  const c = loadChat();
  const SA = (c.context.window as { SA: Record<string, unknown> }).SA;
  SA.top = { draw: () => true, focus: () => true, compact: () => false };
  c.put("1", [chatTurn(10, "agent", "x")], { link: "https://discord.com/channels/1/1" });
  // 本体・読み込み中・開けないチャンネルの 3 つ
  const body = c.box();
  c.chat.render(body, "1");
  assert.equal(body.querySelector("header.ed-toolbar"), null);
  assert.ok(body.querySelector("div.ed-scroll"));
  assert.ok(body.querySelector("textarea.composer-input"));
  const loading = c.box();
  c.chat.render(loading, "2");
  assert.equal(loading.querySelector("header.ed-toolbar"), null);
  assert.ok(loading.querySelector("div.ed-scroll"));
  (c.store.turns as Record<string, unknown>)["3"] = { loaded: true, missing: true, hasMore: false, turns: [], channel: null };
  const missing = c.box();
  c.chat.render(missing, "3");
  assert.equal(missing.querySelector("header.ed-toolbar"), null);
  assert.ok(missing.querySelector("div.empty"));
  // 描き直しても見出しは増えない
  c.chat.render(body, "1");
  assert.equal(body.querySelector("header.ed-toolbar"), null);
  // 右腕の枠
  const framed = c.box();
  c.chat.render(framed, "1", { title: "右腕", placeholder: "右腕に頼む・訊く" });
  assert.ok(framed.querySelector("header.ed-toolbar"));
  // head: false の枠は見出しを作らない（本体・読み込み中・開けないチャンネル）
  for (const id of ["1", "2", "3"]) {
    const headless = c.box();
    c.chat.render(headless, id, { title: "右腕", placeholder: "右腕に頼む・訊く", head: false });
    assert.equal(headless.querySelector("header.ed-toolbar"), null, id);
  }
  // SA.top が無ければ今のまま
  delete SA.top;
  const plain = c.box();
  c.chat.render(plain, "1");
  assert.ok(plain.querySelector("header.ed-toolbar")!.querySelector("button.ed-back"));
});

// ===== 古い描き方の [続ける]（古い殻と右腕。SA.talk が無い・frame のとき） =====
/** 文が「続ける」の button を全部 */
const continueButtons = (n: DomNode): DomNode[] => descendants(n).filter((d): d is DomNode => d instanceof DomNode && d.tagName === "button" && d.textContent === "続ける");
/** 最後の article.msg の末尾の子 */
const lastMsgTail = (box: DomNode): DomNode | undefined => {
  const msgs = box.querySelectorAll("article.msg");
  return msgs[msgs.length - 1]?.children.at(-1) as DomNode | undefined;
};
const stoppedTurns = () => [chatTurn(10, "owner", "a"), chatTurn(11, "agent", "x", { outcome: "max_turns", steps: ["a"] })];
const sessionOf = { kind: "session", title: "t", state: "active" };

test("web static: 古い描き方（SA.talk が無い）の [続ける] は最後の返事の .msg の末尾。セッションでない・実行中・最後の行でない・手順の上限でないなら出さない", () => {
  const c = loadChat();
  c.put("1", stoppedTurns(), sessionOf);
  const box = c.box();
  c.chat.render(box, "1");
  const tail = lastMsgTail(box)!;
  assert.ok(tail.classes.has("msg-actions"));
  assert.deepEqual(
    tail.buttons().map((b) => b.textContent),
    ["続ける"],
  );
  assert.equal(continueButtons(box).length, 1);
  const tl = box.querySelector("div.tl")!;
  assert.equal((tl.children as DomNode[]).filter((n) => n.classes.has("msg-actions")).length, 0);
  // 入口のチャンネル
  c.put("2", stoppedTurns());
  const inbox = c.box();
  c.chat.render(inbox, "2");
  assert.equal(continueButtons(inbox).length, 0);
  // 後ろにオーナーの行
  c.put("3", [...stoppedTurns(), chatTurn(12, "owner", "b")], sessionOf);
  const after = c.box();
  c.chat.render(after, "3");
  assert.equal(continueButtons(after).length, 0);
  // 手順の上限でない
  c.put("4", [chatTurn(10, "owner", "a"), chatTurn(11, "agent", "x", { outcome: "done", steps: ["a"] })], sessionOf);
  const done = c.box();
  c.chat.render(done, "4");
  assert.equal(continueButtons(done).length, 0);
  // 実行中
  setRunning(c, [{ channelId: "1", turnSeq: 1, toolCalls: 1, steps: [], abortable: true }]);
  c.chat.render(box, "1");
  assert.equal(continueButtons(box).length, 0);
});

test("web static: 古い [続ける] を押すと /continue を 1 回送り、待つ間は disabled。受け付けたら refresh して次の描きで消え、409・404・ほかの失敗は文を出して押せる形に戻す", async () => {
  const c = loadChat();
  const SA = (c.context.window as { SA: Record<string, unknown> }).SA;
  const posts: Array<{ path: string; body: unknown }> = [];
  let settle: { res: (v: unknown) => void; rej: (e: unknown) => void } | null = null;
  SA.api = {
    post: (path: string, b: unknown) => {
      posts.push({ path, body: b });
      return new Promise((res, rej) => (settle = { res, rej }));
    },
  };
  const press = () => {
    const b = continueButtons(box)[0]!;
    b.dispatch("click");
    return b as DomNode & { disabled?: boolean };
  };
  // 失敗の 4 つ: 文を出し、押せる形に戻り、描き直してもボタンは在る
  const failures: Array<[unknown, string]> = [
    [{ status: 409, code: "running" }, "実行中のターンがあります"],
    [{ status: 409 }, "この操作は古くなっています"],
    [{ status: 404 }, "この操作は古くなっています"],
    [{ status: 500, toast: "x" }, "x"],
  ];
  c.put("1", stoppedTurns(), sessionOf);
  const box = c.box();
  c.chat.render(box, "1");
  for (const [err, text] of failures) {
    const b = press();
    assert.equal(b.disabled, true);
    const shown = c.toasts.length;
    settle!.rej(err);
    await c.flush();
    // 文は 1 回ずつ出る（前の失敗の同じ文が残っているだけ、を通さない）
    assert.equal(c.toasts.length, shown + 1);
    assert.equal(c.toasts.at(-1), text);
    assert.equal(b.disabled, false);
    c.chat.render(box, "1");
    assert.equal(continueButtons(box).length, 1);
  }
  assert.equal(posts.length, 4);
  assert.ok(posts.every((p) => p.path === "/api/channels/1/continue" && JSON.stringify(p.body) === "{}"));
  assert.deepEqual(c.refreshes, []);
  // ほかの失敗の [もう一度] はもう 1 回送る
  const retry = (c.toastOpts.at(-1) as { retry: () => void }).retry;
  retry();
  assert.equal(posts.length, 5);
  settle!.rej({ status: 404 });
  await c.flush();
  // 受け付けた
  const b = press();
  assert.equal(b.disabled, true);
  assert.equal(posts.length, 6);
  settle!.res({ accepted: true });
  await c.flush();
  assert.deepEqual(c.refreshes, ["ch:1"]);
  c.chat.render(box, "1");
  assert.equal(continueButtons(box).length, 0);
});

// ===== 新しい殻の会話の行（chat.js が SA.talk に根と state を渡す。K4） =====
type TalkFn = (...a: unknown[]) => unknown;
type TalkState = {
  channelId: string;
  turns: unknown[];
  hasMore: boolean;
  running: unknown;
  stopping: boolean;
  continueKey: string | null;
  continueBusy: boolean;
  openSteps: Set<string>;
  runStepsOpen: boolean;
  fmt: Record<string, TalkFn>;
  on: Record<string, TalkFn>;
};
type TalkCall = { root: DomNode; state: TalkState };

/** 偽の会話の口（SA.talk）。呼ばれた根と state を積み、ok を返す */
function withTalk(c: ReturnType<typeof loadChat>) {
  const SA = (c.context.window as { SA: Record<string, unknown> }).SA;
  const draws: TalkCall[] = [];
  const ticks: TalkCall[] = [];
  const drops: DomNode[] = [];
  const talk = {
    draws,
    ticks,
    drops,
    ok: true,
    draw(root: DomNode, state: TalkState) {
      draws.push({ root, state });
      return talk.ok;
    },
    tick(root: DomNode, state: TalkState) {
      ticks.push({ root, state });
      return talk.ok;
    },
    drop(root: DomNode) {
      drops.push(root);
    },
  };
  SA.talk = talk;
  return { SA, talk };
}

/** store の実行中を差し替える（loadChat の store は null を返す関数で型が付いている） */
function setRunning(c: ReturnType<typeof loadChat>, runs: Array<Record<string, unknown>>) {
  const store = c.store as unknown as Record<string, unknown>;
  store.running = runs;
  store.runningOf = (id: string) => runs.find((r) => r.channelId === id) ?? null;
  store.runningElapsed = () => 95_000;
  store.runningWaitingText = () => null;
}

const lastDraw = (talk: { draws: TalkCall[] }): TalkCall => talk.draws[talk.draws.length - 1]!;
const talkScroll = (box: DomNode): DomNode => box.querySelector("div.ed-scroll")!;
const talkKids = (box: DomNode): DomNode[] => talkScroll(box).children as DomNode[];

test("web static: SA.talk があると chat.js は .msg・手順の details・「前の会話を読む」を作らず、.ed-scroll > [data-talk] + .tl に置いてから draw を 1 回呼ぶ", () => {
  const c = loadChat();
  const { talk } = withTalk(c);
  c.put("1", [chatTurn(10, "owner", "a"), chatTurn(11, "agent", "b", { outcome: "done", steps: ["Read a"] })], { kind: "session", title: "t", state: "active" });
  c.store.turns["1"]!.hasMore = true;
  const box = c.box();
  c.chat.render(box, "1");
  assert.equal(box.querySelectorAll("article.msg").length, 0);
  assert.equal(box.querySelectorAll("details.steps-plain").length, 0);
  assert.equal(box.querySelectorAll("div.tl-hint").length, 0);
  assert.equal(descendants(box).filter((n) => n.tagName === "button" && n.textContent === "前の会話を読む").length, 0);
  const kids = talkKids(box);
  assert.deepEqual([kids.length, kids[0]!.getAttribute("data-talk"), kids[1]!.classes.has("tl")], [2, "1", true]);
  assert.equal(talk.draws.length, 1);
  assert.equal(talk.draws[0]!.root, kids[0]);
  assert.ok(box.contains(talk.draws[0]!.root), "置かれた後の根");
  assert.equal(talk.draws[0]!.state.turns, c.store.turns["1"]!.turns);
  assert.equal(talk.draws[0]!.state.hasMore, true);
});

test("web static: SA.talk で同じチャンネルを描き直すと .ed-scroll・根・.tl・入力欄が同じ要素のままで drop しない", () => {
  const c = loadChat();
  const { talk } = withTalk(c);
  c.put("1", [chatTurn(10, "owner", "a")]);
  const box = c.box();
  c.chat.render(box, "1");
  const [scroll, root, tl, input] = [talkScroll(box), talkKids(box)[0], talkKids(box)[1], inputOf(box)];
  c.chat.render(box, "1");
  assert.equal(talkScroll(box), scroll);
  assert.equal(talkKids(box)[0], root);
  assert.equal(talkKids(box)[1], tl);
  assert.equal(inputOf(box), input);
  assert.deepEqual([talk.draws.length, talk.drops.length], [2, 0]);
  assert.equal(talk.draws[1]!.root, root);
});

test("web static: SA.talk で別のチャンネルに替えると新しい根になり、前の根を drop", () => {
  const c = loadChat();
  const { talk } = withTalk(c);
  c.put("1", [chatTurn(10, "owner", "a")]);
  c.put("2", [chatTurn(20, "owner", "b")]);
  const box = c.box();
  c.chat.render(box, "1");
  const root = talkKids(box)[0];
  c.chat.render(box, "2");
  assert.notEqual(talkKids(box)[0], root);
  assert.equal(talkKids(box)[0]!.getAttribute("data-talk"), "2");
  assert.deepEqual(talk.drops, [root]);
  assert.equal(lastDraw(talk).root, talkKids(box)[0]);
});

test("web static: SA.talk で読み込み中・開けないチャンネルを描くと draw を呼ばず、在った根を drop", () => {
  const c = loadChat();
  const { talk } = withTalk(c);
  c.put("1", [chatTurn(10, "owner", "a")]);
  const box = c.box();
  c.chat.render(box, "1");
  const root = talkKids(box)[0]!;
  c.chat.render(box, "2");
  assert.deepEqual([talk.draws.length, talk.drops.length], [1, 1]);
  assert.equal(talk.drops[0], root);
  c.chat.render(box, "1");
  const again = talkKids(box)[0]!;
  (c.store.turns as Record<string, unknown>)["3"] = { loaded: true, missing: true, hasMore: false, turns: [], channel: null };
  c.chat.render(box, "3");
  assert.deepEqual([talk.draws.length, talk.drops.length], [2, 2]);
  assert.equal(talk.drops[1], again);
  assert.ok(box.querySelector("div.empty"));
});

test("web static: SA.talk の fmt.name・fmt.label（人格 1 つは名前なし、2 つは続く返事で名前なし、Claude Code）", () => {
  const c = loadChat();
  const { talk } = withTalk(c);
  const owner = chatTurn(10, "owner", "q");
  const a1 = chatTurn(11, "agent", "x", { persona: "default" });
  const a2 = chatTurn(12, "agent", "y", { persona: "default" });
  const b1 = chatTurn(13, "agent", "z", { persona: "p2" });
  c.put("1", [owner, a1, a2, b1]);
  const box = c.box();
  c.chat.render(box, "1");
  let fmt = lastDraw(talk).state.fmt;
  assert.deepEqual([fmt.label!(owner), fmt.label!(a1), fmt.name!(a1, owner), fmt.name!(a2, a1)], ["オーナー", "既定", null, null]);
  c.store.channels.personas.push({ id: "p2", name: "二号", isDefault: false });
  c.chat.render(box, "1");
  fmt = lastDraw(talk).state.fmt;
  assert.deepEqual([fmt.name!(a1, owner), fmt.name!(a2, a1), fmt.name!(b1, a2), fmt.label!(b1), fmt.name!(a1, null)], ["既定", null, "二号", "二号", "既定"]);
  c.put("9", [owner, a1, a2], { kind: "cc", name: "work", cc: { state: "idle" } });
  const cc = c.box();
  c.chat.render(cc, "9");
  fmt = lastDraw(talk).state.fmt;
  assert.deepEqual([fmt.label!(owner), fmt.label!(a1), fmt.name!(a1, owner), fmt.name!(a2, a1)], ["オーナー", "Claude Code", "Claude Code", null]);
});

test("web static: SA.talk の fmt.end・time・progress・allLabel・runName・waiting は今の関数と同じ文", () => {
  const c = loadChat();
  const { talk } = withTalk(c);
  const ui = c.ui as unknown as { shortTime: (v: string) => string; elapsed: (ms: number) => string };
  const chat = c.chat as unknown as { endText: (t: unknown) => string };
  const owner = chatTurn(10, "owner", "q");
  const done = chatTurn(11, "agent", "x", { outcome: "max_turns", durationMs: 720_000, toolCalls: 40, steps: ["a"] });
  const run = { channelId: "1", turnSeq: 1, toolCalls: 40, steps: ["a", "b", "c", "d", "e"], abortable: true };
  setRunning(c, [run]);
  (c.store as unknown as Record<string, unknown>).runningWaitingText = () => "許可を待っています";
  c.put("1", [owner, done]);
  const box = c.box();
  c.chat.render(box, "1");
  let fmt = lastDraw(talk).state.fmt;
  assert.equal(fmt.end!(done), chat.endText(done));
  assert.match(String(fmt.end!(done)), /^手順の上限で止まりました（.+・ツール 40 回）$/);
  assert.equal(fmt.time!(done), ui.shortTime(done.at));
  assert.equal(fmt.progress!(run), "作業中…（" + ui.elapsed(95_000) + "・ツール 40 回）");
  assert.equal(fmt.allLabel!(run), "直近の手順（5）");
  assert.equal(fmt.allLabel!({ ...run, toolCalls: 5 }), "すべての手順（5）");
  assert.equal(fmt.waiting!(run), "許可を待っています");
  assert.equal(fmt.runName!(owner), null);
  c.store.channels.personas.push({ id: "p2", name: "二号", isDefault: false });
  c.chat.render(box, "1");
  fmt = lastDraw(talk).state.fmt;
  assert.deepEqual([fmt.runName!(owner), fmt.runName!(done), fmt.runName!(null)], ["既定", null, "既定"]);
  assert.equal(lastDraw(talk).state.running, run);
});

test("web static: SA.talk の on.toggleSteps は文字列の key を出し入れして全部を描き直し（refresh しない）、古い details の開いた手順は変わらない", () => {
  const c = loadChat();
  const { SA, talk } = withTalk(c);
  c.put("1", [chatTurn(12, "agent", "x", { outcome: "done", steps: ["Read a"] })]);
  const box = c.box();
  c.chat.render(box, "1");
  const on = talk.draws[0]!.state.on;
  on.toggleSteps!("12");
  assert.equal(talk.draws.length, 2);
  assert.ok(lastDraw(talk).state.openSteps.has("12"));
  assert.equal(lastDraw(talk).root, talkKids(box)[0]);
  on.toggleSteps!("12");
  assert.equal(talk.draws.length, 3);
  assert.equal(lastDraw(talk).state.openSteps.has("12"), false);
  on.toggleSteps!("12");
  assert.deepEqual(c.refreshes, []);
  // 古い道（SA.talk が無い）の details は閉じたまま
  delete SA.talk;
  const plain = c.box();
  c.chat.render(plain, "1");
  const details = plain.querySelector("details.steps-plain")!;
  assert.equal(details.getAttribute("open"), null);
});

test("web static: SA.talk の on.toggleRunSteps は runStepsOpen を入れ替えて全部を描き直す", () => {
  const c = loadChat();
  const { talk } = withTalk(c);
  setRunning(c, [{ channelId: "1", turnSeq: 1, toolCalls: 5, steps: ["a", "b", "c", "d", "e"], abortable: false }]);
  c.put("1", [chatTurn(10, "owner", "a")]);
  const box = c.box();
  c.chat.render(box, "1");
  const on = talk.draws[0]!.state.on;
  assert.equal(talk.draws[0]!.state.runStepsOpen, false);
  on.toggleRunSteps!();
  assert.deepEqual([talk.draws.length, lastDraw(talk).state.runStepsOpen], [2, true]);
  on.toggleRunSteps!();
  assert.deepEqual([talk.draws.length, lastDraw(talk).state.runStepsOpen], [3, false]);
});

test("web static: SA.talk の on.older は前の行を読む（store.load.olderTurns）", () => {
  const c = loadChat();
  const { talk } = withTalk(c);
  c.put("1", [chatTurn(10, "owner", "a")]);
  c.store.turns["1"]!.hasMore = true;
  const box = c.box();
  c.chat.render(box, "1");
  talk.draws[0]!.state.on.older!();
  assert.deepEqual(c.loads.filter((l) => l.startsWith("older:")), ["older:1"]);
});

test("web static: SA.talk の on.stop は中断を 1 回だけ送り、待つ間と成功の後は stopping、失敗・実行が消えた・turnSeq が替わったら stopping でない", async () => {
  const c = loadChat();
  const { SA, talk } = withTalk(c);
  const runs: Array<Record<string, unknown>> = [{ channelId: "1", turnSeq: 3, toolCalls: 1, steps: [], abortable: true }];
  setRunning(c, runs);
  const posts: string[] = [];
  let settle: { res: (v: unknown) => void; rej: (e: unknown) => void } | null = null;
  SA.api = {
    post: (path: string) => {
      posts.push(path);
      return new Promise((res, rej) => (settle = { res, rej }));
    },
  };
  c.put("1", [chatTurn(10, "owner", "a")]);
  const box = c.box();
  c.chat.render(box, "1");
  const on = talk.draws[0]!.state.on;
  assert.equal(talk.draws[0]!.state.stopping, false);
  const first = on.stop!() as Promise<void>;
  void on.stop!();
  assert.deepEqual(posts, ["/api/channels/1/turns/3/abort"]);
  assert.equal(lastDraw(talk).state.stopping, true);
  settle!.res({});
  await first;
  c.chat.render(box, "1");
  assert.equal(lastDraw(talk).state.stopping, true);
  // 実行が消えた
  runs.length = 0;
  c.chat.render(box, "1");
  assert.equal(lastDraw(talk).state.stopping, false);
  // turnSeq が替わった
  runs.push({ channelId: "1", turnSeq: 4, toolCalls: 1, steps: [], abortable: true });
  const second = on.stop!() as Promise<void>;
  assert.deepEqual(posts.at(-1), "/api/channels/1/turns/4/abort");
  settle!.res({});
  await second;
  runs[0] = { ...runs[0], turnSeq: 5 };
  c.chat.render(box, "1");
  assert.equal(lastDraw(talk).state.stopping, false);
  // 失敗
  const third = on.stop!() as Promise<void>;
  assert.equal(lastDraw(talk).state.stopping, true);
  settle!.rej({ status: 500 });
  await third;
  assert.equal(lastDraw(talk).state.stopping, false);
  assert.equal(posts.length, 3);
  // 待つ間に turnSeq が替わり、新しい実行で押した後に、前の失敗が返っても新しい印は消さない
  const fourth = on.stop!() as Promise<void>;
  const firstSettle = settle!;
  runs[0] = { ...runs[0], turnSeq: 6 };
  c.chat.render(box, "1");
  assert.equal(lastDraw(talk).state.stopping, false);
  const fifth = on.stop!() as Promise<void>;
  assert.deepEqual([posts.length, posts.at(-1)], [5, "/api/channels/1/turns/6/abort"]);
  assert.equal(lastDraw(talk).state.stopping, true);
  firstSettle.rej({ status: 500 });
  await fourth;
  c.chat.render(box, "1");
  assert.equal(lastDraw(talk).state.stopping, true);
  settle!.res({});
  await fifth;
});

test("web static: SA.talk のとき [続ける] は .tl に無く、state.continueKey が最後の返事の key（手順の上限・セッション・実行なし・押していない）。カード・空の文・完了の文は .tl", async () => {
  const c = loadChat();
  const { talk } = withTalk(c);
  const last = chatTurn(11, "agent", "x", { outcome: "max_turns", steps: ["a"] });
  const moveProposal = { id: 1, from: "General", to: "kakeibo-app", expiresAt: new Date(Date.now() + 60_000).toISOString() };
  c.put("1", [chatTurn(10, "owner", "a"), last], { kind: "session", title: "t", state: "active", moveProposal });
  const box = c.box();
  c.chat.render(box, "1");
  const tl = () => talkKids(box)[1]!;
  assert.equal(tl().buttons().filter((b) => b.textContent === "続ける").length, 0);
  assert.deepEqual([lastDraw(talk).state.continueKey, lastDraw(talk).state.continueBusy], ["11", false]);
  assert.ok(tl().querySelector("section.card"));
  // セッションでない・実行中・手順の上限でない・後ろにオーナーの行なら null
  c.put("2", [last]);
  const inbox = c.box();
  c.chat.render(inbox, "2");
  assert.equal(lastDraw(talk).state.continueKey, null);
  c.put("4", [chatTurn(10, "owner", "a"), chatTurn(11, "agent", "x", { outcome: "done", steps: ["a"] })], { kind: "session", title: "t", state: "active" });
  c.chat.render(c.box(), "4");
  assert.equal(lastDraw(talk).state.continueKey, null);
  c.put("5", [chatTurn(10, "owner", "a"), last, chatTurn(12, "owner", "b")], { kind: "session", title: "t", state: "active" });
  c.chat.render(c.box(), "5");
  assert.equal(lastDraw(talk).state.continueKey, null);
  setRunning(c, [{ channelId: "1", turnSeq: 1, toolCalls: 1, steps: [], abortable: true }]);
  c.chat.render(box, "1");
  assert.equal(lastDraw(talk).state.continueKey, null);
  // 押して受け付けられた後は null
  setRunning(c, []);
  c.chat.render(box, "1");
  assert.equal(lastDraw(talk).state.continueKey, "11");
  void lastDraw(talk).state.on.continue!("11");
  await c.flush();
  c.chat.render(box, "1");
  assert.equal(lastDraw(talk).state.continueKey, null);
  assert.equal(tl().buttons().filter((b) => b.textContent === "続ける").length, 0);
  // 空の文と完了の文
  c.put("3", [], { kind: "session", title: "t", state: "done" });
  const empty = c.box();
  c.chat.render(empty, "3");
  const texts = (talkKids(empty)[1]!.children as DomNode[]).map((n) => n.textContent);
  assert.ok(texts.some((t) => t.startsWith("まだ会話はありません")), JSON.stringify(texts));
  assert.ok(texts.some((t) => t.startsWith("完了したセッションです")), JSON.stringify(texts));
});

test("web static: SA.talk の on.continue は /continue を 1 回だけ送り、待つ間は continueBusy、だめなら文を出して戻す。key が違う・実行中は送らない", async () => {
  const c = loadChat();
  const { SA, talk } = withTalk(c);
  const posts: Array<{ path: string; body: unknown }> = [];
  let settle: { res: (v: unknown) => void; rej: (e: unknown) => void } | null = null;
  SA.api = {
    post: (path: string, b: unknown) => {
      posts.push({ path, body: b });
      return new Promise((res, rej) => (settle = { res, rej }));
    },
  };
  c.put("1", [chatTurn(10, "owner", "a"), chatTurn(11, "agent", "x", { outcome: "max_turns", steps: ["a"] })], { kind: "session", title: "t", state: "active" });
  const box = c.box();
  c.chat.render(box, "1");
  // 最初の draw の on を持ち続けて呼ぶ（押されたときの状態を読む）
  const on = talk.draws[0]!.state.on;
  // key が違う・実行中は送らず、draw も増えない
  const draws0 = talk.draws.length;
  await on.continue!("99");
  setRunning(c, [{ channelId: "1", turnSeq: 1, toolCalls: 1, steps: [], abortable: true }]);
  await on.continue!("11");
  setRunning(c, []);
  assert.deepEqual([posts.length, talk.draws.length], [0, draws0]);
  // 失敗の 4 つ: 文を出し、待ちの形を戻し、もう 1 回押せる
  const failures: Array<[unknown, string]> = [
    [{ status: 409, code: "running" }, "実行中のターンがあります"],
    [{ status: 409 }, "この操作は古くなっています"],
    [{ status: 404 }, "この操作は古くなっています"],
    [{ status: 500, toast: "x" }, "x"],
  ];
  for (const [err, text] of failures) {
    const before = posts.length;
    const refreshes = c.refreshes.length;
    const first = on.continue!("11") as Promise<void>;
    void on.continue!("11");
    assert.equal(posts.length, before + 1);
    assert.equal(JSON.stringify(posts.at(-1)), JSON.stringify({ path: "/api/channels/1/continue", body: {} }));
    assert.equal(lastDraw(talk).state.continueBusy, true);
    assert.equal(c.refreshes.length, refreshes);
    const shown = c.toasts.length;
    settle!.rej(err);
    await first;
    assert.equal(c.toasts.length, shown + 1);
    assert.equal(c.toasts.at(-1), text);
    assert.deepEqual([lastDraw(talk).state.continueKey, lastDraw(talk).state.continueBusy], ["11", false]);
  }
  assert.equal(typeof (c.toastOpts.at(-1) as { retry: unknown }).retry, "function");
  assert.deepEqual(c.refreshes, []);
  // 受け付けた
  const ok = on.continue!("11") as Promise<void>;
  assert.equal(lastDraw(talk).state.continueBusy, true);
  settle!.res({ accepted: true });
  await ok;
  assert.deepEqual(c.refreshes, ["ch:1"]);
  assert.equal(posts.length, failures.length + 1);
  c.chat.render(box, "1");
  assert.deepEqual([lastDraw(talk).state.continueKey, lastDraw(talk).state.continueBusy], [null, false]);
  await on.continue!("11");
  assert.equal(posts.length, failures.length + 1);
});

test("web static: SA.talk の draw が false なら根を drop して古い描き方（.msg）になり、その後は draw も tick も呼ばない", () => {
  const c = loadChat();
  const { talk } = withTalk(c);
  setRunning(c, [{ channelId: "1", turnSeq: 1, toolCalls: 1, steps: [], abortable: true }]);
  c.put("1", [chatTurn(10, "owner", "a")]);
  talk.ok = false;
  const box = c.box();
  c.chat.render(box, "1");
  assert.equal(talk.draws.length, 1);
  assert.deepEqual(talk.drops, [talk.draws[0]!.root]);
  assert.ok(box.querySelector("article.msg"));
  talk.ok = true;
  c.chat.render(box, "1");
  c.intervals[0]!();
  assert.deepEqual([talk.draws.length, talk.ticks.length], [1, 0]);
  assert.ok(box.querySelector("article.msg"));
});

test("web static: 1 秒の刻みは実行中のチャンネルの根にだけ tick（draw は増えない）。実行が無い・見えていないときは呼ばず、[data-run-progress] の書き換えは今のまま", () => {
  const c = loadChat();
  const { talk } = withTalk(c);
  const store = c.store as unknown as Record<string, unknown>;
  setRunning(c, [{ channelId: "1", turnSeq: 1, toolCalls: 2, steps: [], abortable: true }]);
  c.put("1", [chatTurn(10, "owner", "a")]);
  c.put("2", [chatTurn(20, "owner", "b")]);
  const box = c.box();
  c.chat.render(box, "1");
  const other = c.box();
  c.chat.render(other, "2");
  // 古い道（会話の口が無いときに描いた物）の経過の文。右腕の枠も口で描くので、口を外して描く
  const SA = (c.context.window as { SA: Record<string, unknown> }).SA;
  delete SA.talk;
  const framed = c.box();
  c.chat.render(framed, "1", { title: "右腕", placeholder: "右腕に頼む・訊く" });
  SA.talk = talk;
  const progress = framed.querySelector('span[data-run-progress="1"]')!;
  store.runningElapsed = () => 125_000;
  const tick = c.intervals[0]!;
  tick();
  assert.equal(talk.ticks.length, 1);
  assert.equal(talk.ticks[0]!.root, talkKids(box)[0]);
  assert.equal(talk.ticks[0]!.state.running, (store.runningOf as (id: string) => unknown)("1"));
  assert.equal(talk.draws.length, 2);
  const ui = c.ui as unknown as { elapsed: (ms: number) => string };
  assert.equal(progress.textContent, "作業中…（" + ui.elapsed(125_000) + "・ツール 2 回）");
  c.state.visibility = "hidden";
  tick();
  assert.equal(talk.ticks.length, 1);
  c.state.visibility = "visible";
  setRunning(c, []);
  tick();
  assert.equal(talk.ticks.length, 1);
});

test("web static: 刻みの tick が false なら SA.app.refresh を 1 回呼び、その後は tick を呼ばない", () => {
  const c = loadChat();
  const { talk } = withTalk(c);
  setRunning(c, [{ channelId: "1", turnSeq: 1, toolCalls: 2, steps: [], abortable: true }]);
  c.put("1", [chatTurn(10, "owner", "a")]);
  const box = c.box();
  c.chat.render(box, "1");
  talk.ok = false;
  c.intervals[0]!();
  assert.deepEqual([talk.ticks.length, c.refreshes], [1, ["ch:1"]]);
  c.intervals[0]!();
  assert.deepEqual([talk.ticks.length, c.refreshes], [1, ["ch:1"]]);
});

test("web static: 右腕の枠（frame）も SA.talk が在れば口で描き、state に fmt.reply・fmt.refs・on.ref が載る。口が無い・描けなければ古い .msg と札の DOM", () => {
  const c = loadChat();
  const { SA, talk } = withTalk(c);
  c.put("1", [chatTurn(10, "owner", "a"), chatTurn(11, "agent", "b <#5>")]);
  c.put("2", [chatTurn(20, "agent", "c")]);
  const opened: string[] = [];
  const frame: Frame = {
    title: "右腕",
    placeholder: "右腕に頼む・訊く",
    replyText: (t) => t.replace("<#5>", "「五」"),
    replyRefs: () => [{ id: "ch:5", title: "五", meta: "" }],
    replyExtras: () => [c.ui.el("div", { class: "v3-card", text: "札" })],
    onRef: (id) => void opened.push(id),
  };
  const framed = c.box();
  c.chat.render(framed, "1", frame);
  assert.equal(talk.draws.length, 1);
  assert.equal(framed.querySelectorAll("article.msg").length, 0);
  assert.equal(framed.querySelectorAll("div.v3-card").length, 0, "札の DOM（replyExtras）は古い描き方のときだけ");
  assert.equal(framed.querySelectorAll("[data-talk]").length, 1);
  const st = talk.draws[0]!.state;
  assert.equal(st.fmt.reply, frame.replyText);
  assert.equal(st.fmt.refs, frame.replyRefs);
  st.on.ref!("ch:5");
  assert.deepEqual(opened, ["ch:5"]);
  // 枠なしは差し替えも札も無く、on.ref は何もしない
  c.chat.render(c.box(), "2");
  const plain = talk.draws.at(-1)!.state;
  assert.deepEqual([plain.fmt.reply, plain.fmt.refs], [null, null]);
  plain.on.ref!("ch:5");
  assert.deepEqual(opened, ["ch:5"]);
  // 枠で描いたチャンネルを枠なしで描き直すと、枠を忘れる
  c.chat.render(c.box(), "1");
  const again = talk.draws.at(-1)!.state;
  assert.deepEqual([again.fmt.reply, again.fmt.refs], [null, null]);
  again.on.ref!("ch:5");
  assert.deepEqual(opened, ["ch:5"]);
  // 描けなければ古い .msg と札の DOM
  talk.ok = false;
  const broken = c.box();
  c.chat.render(broken, "1", frame);
  assert.equal(broken.querySelectorAll("article.msg").length, 2);
  assert.equal(broken.querySelectorAll("div.v3-card").length, 1);
  assert.match(broken.querySelector("article.msg-agent")!.textContent, /b 「五」/);
  // 口が無くても同じ
  const d = loadChat();
  d.put("1", [chatTurn(10, "owner", "a"), chatTurn(11, "agent", "b <#5>")]);
  const bare = d.box();
  d.chat.render(bare, "1", frame);
  assert.equal(bare.querySelectorAll("article.msg").length, 2);
  assert.equal(bare.querySelectorAll("[data-talk]").length, 0);
  assert.ok(SA.talk);
});

test("web static: SA.talk の Claude Code のチャンネルは running が null で、状態の行と許可のカードは .tl", () => {
  const c = loadChat();
  const { talk } = withTalk(c);
  const store = c.store as unknown as Record<string, unknown>;
  store.ccSessions = {};
  store.ccPendingOf = (_id: string, p: unknown) => p;
  setRunning(c, [{ channelId: "9", turnSeq: 1, toolCalls: 1, steps: [], abortable: true }]);
  const permission = { id: 7, state: "pending", toolName: "Bash", summary: "ls", expiresAt: new Date(Date.now() + 60_000).toISOString(), requestHash: "h", alwaysRule: null };
  c.put("9", [chatTurn(10, "owner", "a")], { kind: "cc", name: "work", cc: { sessionId: "s1", state: "running", permission } });
  const box = c.box();
  c.chat.render(box, "9");
  assert.equal(lastDraw(talk).state.running, null);
  const tl = talkKids(box)[1]!;
  assert.equal(tl.querySelectorAll("[data-cc-status]").length, 1);
  assert.equal(tl.querySelectorAll("section.card").length, 1);
});

// ===== 新しい殻の入力欄（chat.js が SA.composer に根と state を渡す。K5） =====
type ComposerState = {
  text: string;
  count: number;
  max: number;
  sending: boolean;
  touch: boolean;
  label: string;
  placeholder: string;
  note: string;
  on: { input: (text: string) => void; send: () => Promise<void> | void };
};
type ComposerCall = { root: DomNode; state: ComposerState };

/** 偽の入力欄の口（SA.composer）。呼ばれた根と state を積み、ok を返す。onDraw は描くたびに呼ぶ（欄が伸びた形を作る） */
function withComposer(c: ReturnType<typeof loadChat>) {
  const SA = (c.context.window as { SA: Record<string, unknown> }).SA;
  const draws: ComposerCall[] = [];
  const sets: Array<[DomNode, string]> = [];
  const focuses: DomNode[] = [];
  const drops: DomNode[] = [];
  const comp = {
    draws,
    sets,
    focuses,
    drops,
    ok: true,
    onDraw: null as ((call: ComposerCall) => void) | null,
    draw(root: DomNode, state: ComposerState) {
      const call = { root, state };
      draws.push(call);
      if (comp.onDraw) comp.onDraw(call);
      return comp.ok;
    },
    set(root: DomNode, text: string) {
      sets.push([root, text]);
      return true;
    },
    focus(root: DomNode) {
      focuses.push(root);
      return true;
    },
    drop(root: DomNode) {
      drops.push(root);
    },
  };
  SA.composer = comp;
  return { SA, comp };
}

const lastComp = (comp: { draws: ComposerCall[] }): ComposerCall => comp.draws[comp.draws.length - 1]!;
/** 偽の api の post を差し替える（応答を手で返す） */
function holdPost(c: ReturnType<typeof loadChat>) {
  const SA = (c.context.window as { SA: Record<string, unknown> }).SA;
  const held: Array<{ path: string; body: unknown; resolve: (v: unknown) => void; reject: (e: unknown) => void }> = [];
  SA.api = {
    post: (path: string, body: unknown) =>
      new Promise((resolve, reject) => {
        held.push({ path, body, resolve, reject });
      }),
  };
  return held;
}

test("web static: SA.composer があると chat.js は .composer-wrap・.composer-input・.counter を作らず、[data-composer] の根を容器の最後の子に置いて draw を 1 回呼ぶ", () => {
  const c = loadChat();
  const { comp } = withComposer(c);
  c.drafts["1"] = "  書きかけ ";
  c.put("1", [chatTurn(10, "owner", "a")], { kind: "session", title: "題の話", state: "active" });
  const box = c.box();
  c.chat.render(box, "1");
  for (const sel of ["div.composer-wrap", "textarea.composer-input", "span.counter", "form.composer"]) assert.equal(box.querySelectorAll(sel).length, 0, sel);
  const root = box.children[box.children.length - 1] as DomNode;
  assert.equal(root.getAttribute("data-composer"), "1");
  assert.equal(root.getAttribute("class"), null);
  assert.equal(root.children.length, 0);
  assert.equal(comp.draws.length, 1);
  assert.equal(comp.draws[0]!.root, root);
  const st = comp.draws[0]!.state;
  assert.deepEqual(
    [st.text, st.count, st.max, st.sending, st.touch, st.label, st.placeholder, st.note],
    ["  書きかけ ", 4, 1900, false, false, "題の話 に送る", "この話題に送る", "Discord で発言したのと同じ経路で 1 ターン動きます。返事はここと Discord の両方に出ます"],
  );
  assert.deepEqual(Object.keys(st.on).sort(), ["input", "send"]);
  // タッチが主の端末
  c.touch.matches = true;
  c.chat.render(box, "1");
  assert.equal(lastComp(comp).state.touch, true);
});

test("web static: SA.composer の placeholder は話題・Claude Code・ほかで決まった 3 つの文（題名を入れない）。label は「<題名> に送る」", () => {
  const c = loadChat();
  const { comp } = withComposer(c);
  const store = c.store as unknown as Record<string, unknown>;
  store.ccSessions = {};
  store.ccPendingOf = (_id: string, p: unknown) => p;
  c.put("1", [], { kind: "session", title: "長い長い題", state: "active" });
  c.put("2", [], { kind: "cc", name: "work", cc: { sessionId: "s1", state: "idle" } });
  c.put("3", [], { kind: "inbox", name: "inbox" });
  const got: Array<[string, string, string]> = [];
  for (const id of ["1", "2", "3"]) {
    c.chat.render(c.box(), id);
    const st = lastComp(comp).state;
    got.push([st.placeholder, st.label, st.note]);
  }
  assert.deepEqual(got, [
    ["この話題に送る", "長い長い題 に送る", "Discord で発言したのと同じ経路で 1 ターン動きます。返事はここと Discord の両方に出ます"],
    ["このセッションに送る", "work に送る", "このセッションに届けます（入力待ちのときに貼ります）。返事はここと Discord の両方に出ます"],
    ["ここに送る", "#inbox に送る", "Discord で発言したのと同じ経路で 1 ターン動きます。返事はここと Discord の両方に出ます"],
  ]);
});

test("web static: SA.composer で同じチャンネルを描き直すと根が同じ要素で drop しない。別のチャンネルに替えると前の根を drop して外す。読み込み中・開けないチャンネルでも drop", () => {
  const c = loadChat();
  const { comp } = withComposer(c);
  c.put("1", [chatTurn(10, "owner", "a")]);
  c.put("2", [chatTurn(20, "owner", "b")]);
  const box = c.box();
  c.chat.render(box, "1");
  const root = comp.draws[0]!.root;
  c.chat.render(box, "1");
  assert.equal(lastComp(comp).root, root);
  assert.deepEqual([comp.draws.length, comp.drops.length], [2, 0]);
  assert.equal(box.querySelectorAll("[data-composer]").length, 1);
  c.chat.render(box, "2");
  assert.deepEqual(comp.drops, [root]);
  assert.equal(box.contains(root), false);
  const now = lastComp(comp).root;
  assert.equal(now.getAttribute("data-composer"), "2");
  assert.equal(box.querySelectorAll("[data-composer]").length, 1);
  // 読み込み中のチャンネル
  c.chat.render(box, "5");
  assert.deepEqual(comp.drops, [root, now]);
  assert.equal(box.querySelectorAll("[data-composer]").length, 0);
});

test("web static: SA.composer の on.input は書きかけを覚えて入力欄だけを描き直し（SA.talk.draw・refresh は呼ばない）、一番下を見ていたら一番下のまま、上を読んでいたら動かさない", () => {
  const c = loadChat();
  const { comp } = withComposer(c);
  const { talk } = withTalk(c);
  c.put("1", [chatTurn(10, "owner", "a")], { kind: "session", title: "t", state: "active" });
  const box = c.box();
  c.chat.render(box, "1");
  const scroll = box.querySelector('div.ed-scroll[data-channel="1"]')!;
  scroll.scrollHeight = 1000;
  scroll.clientHeight = 200;
  scroll.scrollTop = 800;
  // 欄が伸びると .ed-scroll の中身が見える高さが減る（ここでは scrollHeight が増えた形で作る）
  comp.onDraw = () => {
    scroll.scrollHeight += 40;
  };
  const [draws, talks] = [comp.draws.length, talk.draws.length];
  lastComp(comp).state.on.input("あい");
  assert.equal(c.drafts["1"], "あい");
  assert.equal(comp.draws.length, draws + 1);
  assert.equal(lastComp(comp).state.text, "あい");
  assert.equal(lastComp(comp).state.count, 2);
  assert.equal(talk.draws.length, talks);
  assert.deepEqual(c.refreshes, []);
  assert.equal(scroll.scrollTop, 840);
  // 上を読んでいる途中
  scroll.scrollTop = 300;
  lastComp(comp).state.on.input("あいう");
  assert.equal(scroll.scrollTop, 300);
  assert.equal(talk.draws.length, talks);
  // 描けなければ古い入力欄に戻す
  comp.ok = false;
  lastComp(comp).state.on.input("あいうえ");
  assert.deepEqual(c.refreshes, ["ch:1"]);
  assert.deepEqual(comp.drops, [lastComp(comp).root]);
});

test("web static: SA.composer の on.send は空・送っている間は送らず、1,901 字はトーストで送らない。受け付けたら書きかけを消して set の後に描き、仮の行と読み直し。送っている間に打ち足していたら消さない", async () => {
  const c = loadChat();
  const { comp } = withComposer(c);
  const held = holdPost(c);
  c.put("1", [chatTurn(10, "owner", "a")], { kind: "session", title: "t", state: "active" });
  const box = c.box();
  c.chat.render(box, "1");
  const root = lastComp(comp).root;
  const on = () => lastComp(comp).state.on;
  c.drafts["1"] = "   ";
  await on().send();
  assert.equal(held.length, 0);
  c.drafts["1"] = "x".repeat(1901);
  await on().send();
  assert.equal(held.length, 0);
  assert.deepEqual(c.toasts, ["1,900 字までです"]);
  // 送る
  c.drafts["1"] = " 送る本文 ";
  const before = comp.draws.length;
  const sending = on().send();
  assert.equal(held.length, 1);
  assert.deepEqual(JSON.parse(JSON.stringify([held[0]!.path, held[0]!.body])), ["/api/channels/1/messages", { text: "送る本文" }]);
  assert.equal(comp.draws.length, before + 1);
  assert.equal(lastComp(comp).state.sending, true);
  // 送っている間は送らない
  await on().send();
  assert.equal(held.length, 1);
  held[0]!.resolve({ turnId: 9 });
  await sending;
  assert.equal(c.drafts["1"], "");
  assert.deepEqual(comp.sets, [[root, ""]]);
  // set の直後の draw は空の本文で、送っている途中のまま。finally の draw で sending が外れる
  const after = comp.draws.slice(before + 1);
  assert.deepEqual(after.map((d) => [d.state.text, d.state.sending]), [["", true], ["", false]]);
  assert.deepEqual(c.optimistic, [["1", 9, "送る本文"]]);
  assert.ok(c.loads.includes("1"));
  // 送っている間に打ち足した
  c.drafts["1"] = "一つ目";
  const second = on().send();
  c.drafts["1"] = "一つ目と二つ目";
  held[1]!.resolve({ turnId: 10 });
  await second;
  assert.equal(c.drafts["1"], "一つ目と二つ目");
  assert.equal(comp.sets.length, 1);
  assert.equal(lastComp(comp).state.sending, false);
  assert.equal(lastComp(comp).state.text, "一つ目と二つ目");
});

test("web static: SA.composer の on.send が失敗したら書きかけを残してトーストを出し、[もう一度] で送り直す", async () => {
  const c = loadChat();
  const { comp } = withComposer(c);
  const held = holdPost(c);
  c.put("1", [chatTurn(10, "owner", "a")], { kind: "session", title: "t", state: "active" });
  c.chat.render(c.box(), "1");
  c.drafts["1"] = "残る本文";
  const sending = lastComp(comp).state.on.send();
  held[0]!.reject(Object.assign(new Error("x"), { code: "not_accepted", toast: "送れませんでした" }));
  await sending;
  assert.equal(c.drafts["1"], "残る本文");
  assert.deepEqual(comp.sets, []);
  assert.equal(c.toasts.length, 1);
  assert.equal(lastComp(comp).state.sending, false);
  const retry = (c.toastOpts[0] as { level: string; retry: () => Promise<void> });
  assert.equal(retry.level, "error");
  const again = retry.retry();
  assert.equal(held.length, 2);
  assert.deepEqual(JSON.parse(JSON.stringify(held[1]!.body)), { text: "残る本文" });
  held[1]!.resolve({ turnId: 3 });
  await again;
  assert.equal(c.drafts["1"], "");
});

test("web static: SA.composer の Claude Code のチャンネルの on.send は、古い入力欄と同じく仮の届け待ちと読み直し", async () => {
  const run = async (withMouth: boolean) => {
    const c = loadChat();
    const comp = withMouth ? withComposer(c).comp : null;
    const store = c.store as unknown as Record<string, unknown>;
    const marks: unknown[] = [];
    store.ccSessions = {};
    store.ccPendingOf = (_id: string, p: unknown) => p;
    store.setCcOptimisticSend = (sessionId: string, sendId: number) => marks.push(["optimistic", sessionId, sendId]);
    (store.load as Record<string, unknown>).ccSession = (id: string) => {
      marks.push(["ccSession", id]);
      return Promise.resolve(null);
    };
    const SA = (c.context.window as { SA: Record<string, unknown> }).SA;
    SA.api = { post: (path: string, body: unknown) => (marks.push(["post", path, body]), Promise.resolve({ sendId: 4 })) };
    c.put("9", [], { kind: "cc", name: "work", cc: { sessionId: "s1", state: "idle" } });
    const box = c.box();
    c.chat.render(box, "9");
    c.drafts["9"] = "届けて";
    marks.length = 0;
    c.loads.length = 0;
    c.refreshes.length = 0;
    if (comp) await lastComp(comp).state.on.send();
    else {
      inputOf(box).value = "届けて";
      formOf(box).dispatch("submit", { preventDefault() {} });
      await c.flush();
    }
    return { marks: JSON.parse(JSON.stringify(marks)) as unknown[], loads: [...c.loads], refreshes: [...c.refreshes], optimistic: c.optimistic.length, draft: c.drafts["9"] };
  };
  const got = await run(true);
  assert.deepEqual(got, await run(false));
  assert.deepEqual(got.marks, [["post", "/api/channels/9/messages", { text: "届けて" }], ["optimistic", "s1", 4], ["ccSession", "s1"]]);
  assert.deepEqual([got.loads, got.refreshes, got.optimistic, got.draft], [["9"], ["ch:9"], 0, ""]);
});

test("web static: SA.composer の draw が false なら根を drop して古い入力欄（書きかけ入り）になり、その後は口を呼ばない", () => {
  const c = loadChat();
  const { comp } = withComposer(c);
  c.drafts["1"] = "書きかけ";
  c.put("1", [chatTurn(10, "owner", "a")]);
  comp.ok = false;
  const box = c.box();
  c.chat.render(box, "1");
  assert.equal(comp.draws.length, 1);
  assert.deepEqual(comp.drops, [comp.draws[0]!.root]);
  assert.equal(box.querySelectorAll("[data-composer]").length, 0);
  assert.equal(inputOf(box).value, "書きかけ");
  assert.ok(box.querySelector("div.composer-wrap"));
  comp.ok = true;
  c.chat.render(box, "1");
  c.touchListeners.forEach((fn) => fn());
  assert.equal(comp.draws.length, 1);
});

test("web static: 右腕の枠も SA.composer が在れば口で描き、placeholder・label は枠の文、字数・上限の判定・送る本文・仮の行は outgoing を通した物（空なら 0 字）。タッチの判定が変わると部品の根を全部描き直す", async () => {
  const c = loadChat();
  const { comp } = withComposer(c);
  const held = holdPost(c);
  const prefix = "（いま見ている話題: 話）\n";
  const frame: Frame = { title: "右腕", placeholder: "右腕に頼む・訊く", outgoing: (t) => prefix + t };
  c.put("1", [chatTurn(10, "owner", "a")]);
  c.put("2", [chatTurn(20, "owner", "b")]);
  const framed = c.box();
  c.chat.render(framed, "1", frame);
  assert.equal(comp.draws.length, 1);
  assert.equal(inputOf(framed), null);
  assert.equal(framed.querySelectorAll("[data-composer]").length, 1);
  const st = () => comp.draws.filter((d) => d.root.getAttribute("data-composer") === "1").at(-1)!.state;
  assert.deepEqual([st().placeholder, st().label, st().count], ["右腕に頼む・訊く", "右腕に頼む・訊く", 0]);
  st().on.input("  ");
  assert.equal(st().count, 0, "空白だけなら 0 字");
  st().on.input(" 頼む ");
  assert.equal(st().count, prefix.length + 2);
  // 差し替えた後で 1,900 字を超えれば送らない
  st().on.input("あ".repeat(1900 - prefix.length + 1));
  await st().on.send();
  assert.equal(held.length, 0);
  assert.deepEqual(c.toasts, ["1,900 字までです"]);
  st().on.input(" 頼む ");
  const sending = st().on.send();
  assert.deepEqual(JSON.parse(JSON.stringify(held.map((x) => x.body))), [{ text: prefix + "頼む" }]);
  held[0]!.resolve({ turnId: 9 });
  await sending;
  assert.deepEqual(c.optimistic, [["1", 9, prefix + "頼む"]]);
  assert.equal(c.drafts["1"], "", "送れたら書きかけを消す（比べるのは差し替える前の本文）");
  // 枠なしは今の文と字数
  c.chat.render(c.box(), "2");
  assert.equal(lastComp(comp).state.placeholder, "ここに送る");
  assert.equal(lastComp(comp).state.label, "#inbox-2 に送る");
  const before = comp.draws.length;
  c.touch.matches = true;
  c.touchListeners.forEach((fn) => fn());
  assert.equal(comp.draws.length, before + 2);
  assert.equal(lastComp(comp).state.touch, true);
});

test("web static: views.js の toolbar は SA.top があると題・戻る・印を作らず添え物と操作の段だけで、どちらも空なら隠す。状態の画面は h1 が無くても描ける", () => {
  const c = loadChat();
  const SA = (c.context.window as { SA: Record<string, unknown> }).SA;
  const ctx: Record<string, unknown> = { SA, el: c.ui.el, icon: (SA.ui as { icon: unknown }).icon };
  vm.runInNewContext(fnSource(read("views.js"), "toolbar") + "\nf = toolbar;", ctx);
  const toolbar = ctx.f as (iconName: string, title: string, extras?: unknown[], actions?: unknown[], cls?: string) => DomNode;
  const old = toolbar("activity", "状態");
  assert.equal(old.querySelector("h1")!.textContent, "状態");
  assert.ok(old.querySelector("button.ed-back"));
  SA.top = { draw: () => true, focus: () => true, compact: () => false };
  const empty = toolbar("activity", "状態", [null], []);
  assert.equal(empty.querySelector("h1"), null);
  assert.equal(empty.querySelector("button.ed-back"), null);
  assert.equal(empty.querySelector("svg.icon"), null);
  assert.equal(empty.getAttribute("hidden"), "");
  const btn = c.ui.el("button", { type: "button", text: "足す" });
  const withOps = toolbar("check", "タスク", [], [btn], "ed-toolbar-kb");
  assert.equal(withOps.getAttribute("hidden"), null);
  assert.equal(withOps.getAttribute("class"), "ed-toolbar ed-toolbar-kb");
  assert.equal(withOps.querySelector("div.ed-actions")!.contains(btn), true);
  assert.ok(withOps.querySelector("div.ed-title"));
  // 状態の画面（renderStatus）: SA.top があっても投げずに描ける。無ければ h1 に更新の間隔の title
  const views = SA.views as { info: (tab: string) => { render: (box: DomNode) => void } };
  (c.store as { status: unknown }).status = null;
  const box = c.box();
  views.info("status").render(box);
  assert.equal(box.querySelector("h1"), null);
  delete SA.top;
  const oldBox = c.box();
  views.info("status").render(oldBox);
  assert.equal((oldBox.querySelector("h1") as DomNode & { title?: string }).title, "10 秒ごとに更新");
});

test("web static: 右腕が無い・読み込み中の見出しは h2「右腕」で、#v3-hand-ed に h1 が無い", async () => {
  const none = loadShell() as HandShell;
  await none.flush();
  const nh = none.nodes.handEd.querySelector("header.ed-toolbar")!;
  assert.equal(nh.querySelector("h2")!.textContent, "右腕");
  assert.equal(none.nodes.handEd.querySelector("h1"), null);
  const loading = loadShell() as HandShell;
  loading.api.reply = () => new Promise(() => undefined);
  assert.equal(loading.nodes.handEd.querySelector("h2")!.textContent, "右腕");
  assert.equal(loading.nodes.handEd.querySelector("h1"), null);
});

test("web static: shell.css の .v3-hand .ed-title h2 は app.css の .ed-title h1 と同じ 4 つの宣言", () => {
  const decls = (css: string, sel: string) => {
    const at = css.indexOf("\n" + sel + " {");
    assert.ok(at >= 0, sel);
    const body = css.slice(css.indexOf("{", at) + 1, css.indexOf("}", at));
    return body.split(";").map((d) => d.trim()).filter((d) => d !== "");
  };
  const own = decls(read("shell.css"), ".v3-hand .ed-title h2");
  assert.equal(own.length, 4);
  assert.deepEqual(own, decls(read("app.css"), ".ed-title h1"));
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

// ===== 新しい殻のカード（chat.js が SA.cards に根と state を渡す。K5） =====
type CardItem = Record<string, unknown> & { kind: string; id: unknown };
type CardsFn = (...a: unknown[]) => unknown;
type CardsState = { items: CardItem[]; on: Record<string, CardsFn> };
type CardsCall = { root: DomNode; state: CardsState };

/** 偽のカードの口（SA.cards）。呼ばれた根と state を積み、ok を返す。onDraw は描くたびに呼ぶ */
function withCards(c: ReturnType<typeof loadChat>) {
  const SA = (c.context.window as { SA: Record<string, unknown> }).SA;
  const draws: CardsCall[] = [];
  const focuses: Array<{ root: DomNode; id: unknown; index: number }> = [];
  const drops: DomNode[] = [];
  const cards = {
    draws,
    focuses,
    drops,
    ok: true,
    onDraw: null as ((root: DomNode, state: CardsState) => void) | null,
    draw(root: DomNode, state: CardsState) {
      draws.push({ root, state });
      if (cards.onDraw) cards.onDraw(root, state);
      return cards.ok;
    },
    focus(root: DomNode, id: unknown, index: number) {
      focuses.push({ root, id, index });
      return true;
    },
    drop(root: DomNode) {
      drops.push(root);
    },
  };
  SA.cards = cards;
  return { SA, cards };
}

const lastCards = (cards: { draws: CardsCall[] }): CardsCall => cards.draws[cards.draws.length - 1]!;
const cardsPlain = (cards: { draws: CardsCall[] }) => JSON.parse(JSON.stringify(lastCards(cards).state.items)) as CardItem[];
const cardsOn = (cards: { draws: CardsCall[] }) => lastCards(cards).state.on;

const CLOSE_DRAFT = { summary: "要約の 1 行\n2 行目", tasks: [{ title: "買い物" }, { title: "提出", due: "2026-11-20" }, { title: "掃除" }] };

/** 会話・入力欄・カードの口を置き、話題（1）を描く。話題のカードは Claude Code の一覧を読まないので、load.cc は呼ばれたら落ちる */
function cardsChat(ch: Record<string, unknown> = {}, list: unknown[] = [chatTurn(10, "owner", "a")]) {
  const c = loadChat();
  const { comp } = withComposer(c);
  const { talk } = withTalk(c);
  const { SA, cards } = withCards(c);
  (c.store.load as Record<string, unknown>).cc = () => {
    throw new Error("話題のカードから load.cc を呼ばない");
  };
  c.put("1", list, { kind: "session", title: "t", state: "active", ...ch });
  const box = c.box();
  c.chat.render(box, "1");
  return { c, SA, comp, talk, cards, box };
}

/** /turns の読みを手で返す（返すまで待たせる） */
function holdTurns(c: ReturnType<typeof loadChat>) {
  const held: Array<() => void> = [];
  (c.store.load as Record<string, unknown>).turns = (id: string) => {
    c.loads.push(id);
    return new Promise((r) => held.push(() => r(null)));
  };
  return held;
}

/** 確認のダイアログの要素を置く（ui.js の confirm が引く id）。[ok] を返す */
function confirmNodes(c: ReturnType<typeof loadChat>): DomNode {
  const host = c.box();
  const nodes: Record<string, DomNode> = {};
  for (const id of ["dlg-confirm", "dlg-confirm-title", "dlg-confirm-target", "dlg-confirm-body", "dlg-confirm-ok", "dlg-confirm-cancel"]) {
    nodes[id] = new DomNode(id === "dlg-confirm" ? "dialog" : "button");
    nodes[id]!.setAttribute("id", id);
    host.append(nodes[id]!);
  }
  return nodes["dlg-confirm-ok"]!;
}

test("web static: SA.cards があると .ed-scroll の直下は 会話の根・カードの根（属性は data-cards だけ）・.tl の順で、draw は 入力欄 → 会話 → カード の順に根が付いた後", () => {
  const c = loadChat();
  const { comp } = withComposer(c);
  const { talk } = withTalk(c);
  const { cards } = withCards(c);
  const order: string[] = [];
  const attached: boolean[] = [];
  const box = c.box();
  comp.onDraw = () => order.push("composer");
  const talkDraw = talk.draw;
  talk.draw = (root, state) => {
    order.push("talk");
    return talkDraw.call(talk, root, state);
  };
  cards.onDraw = (root) => {
    order.push("cards");
    attached.push(box.contains(root));
  };
  c.put("1", [chatTurn(10, "owner", "a")], { kind: "session", title: "t", state: "active" });
  c.chat.render(box, "1");
  const kids = talkKids(box);
  assert.equal(kids.length, 3);
  assert.equal(kids[0]!.getAttribute("data-talk"), "1");
  assert.deepEqual([...kids[1]!.attrs.keys()], ["data-cards"]);
  assert.equal(kids[1]!.getAttribute("data-cards"), "1");
  assert.ok(kids[2]!.classes.has("tl"));
  assert.deepEqual(order, ["composer", "talk", "cards"]);
  assert.deepEqual(attached, [true]);
  assert.equal(cards.draws[0]!.root, kids[1]);
});

test("web static: SA.cards があると .tl は空で、古いカード・待ちの行・空の文・完了の文を作らず、ccPermissionCard を呼ばない", async () => {
  const c = loadChat();
  withComposer(c);
  withTalk(c);
  const { SA, cards } = withCards(c);
  const views = SA.views as Record<string, unknown>;
  let old = 0;
  const card = views.ccPermissionCard as CardsFn;
  views.ccPermissionCard = (...a: unknown[]) => {
    old++;
    return card(...a);
  };
  const box = c.box();
  const ok = confirmNodes(c);
  c.put("1", [], { kind: "session", title: "t", state: "active", closeDraft: CLOSE_DRAFT, moveProposal: { id: 3, from: "a", to: "b" }, permission: permissionRequest(40, { sessionId: "sx" }) });
  c.chat.render(box, "1");
  (c.chat as unknown as { renew: (id: string) => void }).renew("1");
  ok.dispatch("click");
  await c.flush();
  c.chat.render(box, "1");
  assert.equal(cardsPlain(cards)[0]!.id, "wait");
  c.put("2", [], { kind: "session", title: "t", state: "done" });
  const done = c.box();
  c.chat.render(done, "2");
  for (const b of [box, done]) {
    const tl = talkKids(b)[2]!;
    assert.equal(tl.children.length, 0);
    for (const sel of ["section.card", "section.cc-permission", "p.tl-hint", "div.tl-notice", "div.tl-hint"]) assert.equal(b.querySelectorAll(sel).length, 0, sel);
  }
  assert.equal(old, 0);
  assert.ok(cards.draws.length >= 3);
});

test("web static: カードの items は 待ちの行 → 閉じる → 移す → 許可 → 空の文 → 完了の文 の順で、文は古い描き方と同じ", async () => {
  const { c, cards, box } = cardsChat({ closeDraft: CLOSE_DRAFT, moveProposal: { id: 3, from: "General", to: "beta" }, permission: permissionRequest(41, { sessionId: "sx" }) }, []);
  let items = cardsPlain(cards);
  assert.deepEqual(items.map((i) => i.kind + ":" + i.id), ["close:1", "move:3", "permission:41", "note:empty"]);
  assert.deepEqual(items[0], {
    kind: "close",
    id: "1",
    summary: "要約の 1 行\n2 行目",
    tasks: ["1. 買い物", "2. 提出（期限 2026-11-20）", "3. 掃除"],
    picked: [],
    busy: false,
  });
  assert.deepEqual(items[1], { kind: "move", id: 3, from: "General", to: "beta", busy: false });
  assert.equal(items[2]!.tool, "Bash");
  assert.equal(items[2]!.busy, false);
  assert.equal(items[2]!.terminal, false, "プロジェクトのセッションには端末が無い");
  assert.deepEqual(items[3], { kind: "note", id: "empty", text: "まだ会話はありません。下の欄か Discord で送ると始まります。" });
  // 選んだ候補は昇順
  cardsOn(cards).task!("1", 2, true);
  cardsOn(cards).task!("1", 0, true);
  assert.deepEqual(cardsPlain(cards)[0]!.picked, [0, 2]);
  // 会話を新しくしている間は待ちの行が先頭（busy）
  const ok = confirmNodes(c);
  (c.chat as unknown as { renew: (id: string) => void }).renew("1");
  ok.dispatch("click");
  await c.flush();
  c.chat.render(box, "1");
  items = cardsPlain(cards);
  assert.deepEqual(items[0], { kind: "note", id: "wait", busy: true, text: "会話を新しくしています…" });
  // 質問・完了: 完了した話題に閉じるカードは出さず、完了の文が最後
  c.put("2", [chatTurn(10, "owner", "a")], { kind: "session", title: "t", state: "done", closeDraft: CLOSE_DRAFT, permission: questionPermission(42, { sessionId: "sx" }) });
  c.chat.render(c.box(), "2");
  items = cardsPlain(cards);
  assert.deepEqual(items.map((i) => i.kind + ":" + i.id), ["question:42", "note:done"]);
  assert.equal(items[0]!.terminal, false, "質問にも端末の無い印");
  assert.deepEqual(items[1], { kind: "note", id: "done", text: "完了したセッションです。発言すると進行中に戻ります。" });
  assert.equal(items[0]!.who, "");
  // 実行中は空の文を出さない。終わった許可は出さない
  setRunning(c, [{ channelId: "3", turnSeq: 1, toolCalls: 0, steps: [], abortable: true }]);
  c.put("3", [], { kind: "session", title: "t", state: "active", permission: permissionRequest(43, { state: "allowed" }) });
  c.chat.render(c.box(), "3");
  assert.deepEqual(cardsPlain(cards), []);
});

test("web static: 閉じるのを待っている間は閉じるカードを出さず、待ちの行は「閉じる前の要約をしています…」", async () => {
  const { c, cards, box } = cardsChat({ closeDraft: CLOSE_DRAFT });
  const ok = confirmNodes(c);
  (c.chat as unknown as { closeSession: (id: string) => void }).closeSession("1");
  ok.dispatch("click");
  await c.flush();
  c.chat.render(box, "1");
  assert.deepEqual(cardsPlain(cards), [{ kind: "note", id: "wait", busy: true, text: "閉じる前の要約をしています…" }]);
});

test("web static: 終わった質問はカードに出さず、選んだ状態を捨てる（ccQuestionForget）", () => {
  const { c, SA, cards, box } = cardsChat({ permission: questionPermission(44, { sessionId: "sx" }) });
  const ask = (SA.views as { ccAsk: CcAsk }).ccAsk;
  cardsOn(cards).pick!(44, 0, "赤", true);
  assert.deepEqual((cardsPlain(cards)[0]!.questions as Array<{ picked: string[] }>)[0]!.picked, ["赤"]);
  c.put("1", [chatTurn(10, "owner", "a")], { kind: "session", title: "t", state: "active", permission: questionPermission(44, { state: "allowed" }) });
  c.chat.render(box, "1");
  assert.deepEqual(cardsPlain(cards), []);
  assert.deepEqual(JSON.parse(JSON.stringify(ask.item("sx", questionPermission(44))!.questions![0]!.picked)), [], "選んだ状態は捨てた");
});

test("web static: 同じ話題の描き直しは 3 つの根と .ed-scroll が同じ要素。別の話題・読み込み中・開けないではカードの根を drop する", () => {
  const { c, cards, box } = cardsChat();
  const before = talkKids(box).slice();
  const scroll = talkScroll(box);
  c.chat.render(box, "1");
  assert.equal(talkScroll(box), scroll);
  assert.deepEqual(talkKids(box), before);
  assert.equal(lastCards(cards).root, before[1]);
  assert.equal(cards.drops.length, 0);
  c.put("2", [chatTurn(10, "owner", "a")], { kind: "session", title: "u", state: "active" });
  c.chat.render(box, "2");
  assert.deepEqual(cards.drops, [before[1]]);
  assert.equal(talkKids(box)[1]!.getAttribute("data-cards"), "2");
  const second = talkKids(box)[1]!;
  c.store.turns["2"]!.loaded = false;
  c.chat.render(box, "2");
  assert.deepEqual(cards.drops, [before[1], second]);
  c.put("3", [], {});
  c.chat.render(box, "3");
  const third = talkKids(box)[1]!;
  c.store.turns["3"]!.missing = true;
  c.chat.render(box, "3");
  assert.deepEqual(cards.drops, [before[1], second, third]);
});

test("web static: カードの on.always・task・pick・other は状態を変え、その呼び出しの中でカードだけを描く（会話・入力欄・refresh は呼ばない）", () => {
  const { c, cards, comp, talk } = cardsChat({ permission: permissionRequest(45, { sessionId: "sx" }) });
  const counts = () => [comp.draws.length, talk.draws.length, c.refreshes.length];
  const base = counts();
  /** fn の中でカードが 1 回だけ描かれる */
  const once = (fn: () => void) => {
    const n = cards.draws.length;
    fn();
    assert.equal(cards.draws.length, n + 1);
  };
  once(() => cardsOn(cards).always!(45, true));
  assert.equal(cardsPlain(cards)[0]!.always, true);
  once(() => cardsOn(cards).always!(45, false));
  assert.equal(cardsPlain(cards)[0]!.always, false);
  // 閉じる前の確認の候補と質問
  c.put("1", [chatTurn(10, "owner", "a")], { kind: "session", title: "t", state: "active", closeDraft: CLOSE_DRAFT, permission: questionPermission(46, { sessionId: "sx" }) });
  once(() => cardsOn(cards).task!("1", 1, true));
  assert.deepEqual(cardsPlain(cards)[0]!.picked, [1]);
  once(() => cardsOn(cards).task!("1", 1, false));
  assert.deepEqual(cardsPlain(cards)[0]!.picked, []);
  const q = () => cardsPlain(cards)[1]!.questions as Array<{ picked: string[]; other: boolean; otherText: string }>;
  once(() => cardsOn(cards).pick!(46, 0, "青", true));
  assert.deepEqual(q()[0]!.picked, ["青"]);
  once(() => cardsOn(cards).pickOther!(46, 0, true, false));
  assert.equal(q()[0]!.other, true);
  assert.deepEqual(q()[0]!.picked, []);
  once(() => cardsOn(cards).other!(46, 0, "紫"));
  assert.equal(q()[0]!.otherText, "紫");
  assert.equal(cardsPlain(cards)[1]!.ready, false, "2 問目が残っている");
  assert.deepEqual(counts(), base);
});

test("web static: カードの on.pickOther は byPointer で選んだときだけ、描いた後に「その他」の欄へ focus を頼む", () => {
  const { cards } = cardsChat({ permission: questionPermission(47, { sessionId: "sx" }) });
  const root = lastCards(cards).root;
  let drawsAtFocus = -1;
  const focus = cards.focus;
  cards.focus = (r, id, index) => {
    drawsAtFocus = cards.draws.length;
    return focus.call(cards, r, id, index);
  };
  const n = cards.draws.length;
  cardsOn(cards).pickOther!(47, 0, true, true);
  assert.deepEqual(cards.focuses.map((f) => [f.root, f.id, f.index]), [[root, 47, 0]]);
  assert.equal(drawsAtFocus, n + 1, "描いた後");
  cardsOn(cards).pickOther!(47, 1, true, false);
  cardsOn(cards).pickOther!(47, 1, false, true);
  assert.equal(cards.focuses.length, 1);
  // 描けなかったら頼まない
  cards.ok = false;
  cardsOn(cards).pickOther!(47, 0, true, true);
  assert.equal(cards.focuses.length, 1);
});

test("web static: カードの on.permit は decision の道へ requestHash を送り、送っている間と通った後 /turns を 2 回読み直すまで busy。2 回押しても送るのは 1 回", async () => {
  const { c, cards, box } = cardsChat({ permission: permissionRequest(48, { sessionId: "sx" }) });
  const held = holdPost(c);
  const turns = holdTurns(c);
  void cardsOn(cards).permit!(48, "always");
  void cardsOn(cards).permit!(48, "allow");
  assert.deepEqual(held.map((h) => [h.path, JSON.parse(JSON.stringify(h.body))]), [["/api/cc/permissions/48/always", { requestHash: "h48" }]]);
  assert.equal(cardsPlain(cards)[0]!.busy, true, "送っている間");
  held[0]!.resolve({});
  await c.flush();
  c.chat.render(box, "1");
  assert.equal(cardsPlain(cards)[0]!.busy, true, "1 回目の読み直しの前");
  for (const r of turns.splice(0)) r();
  await c.flush();
  c.chat.render(box, "1");
  assert.equal(cardsPlain(cards)[0]!.busy, true, "2 回目の読み直しの前");
  assert.equal(turns.length, 1);
  for (const r of turns.splice(0)) r();
  await c.flush();
  c.chat.render(box, "1");
  assert.equal(cardsPlain(cards)[0]!.busy, false, "読み直した後（項目が残っていれば押せる）");
  assert.equal(held.length, 1);
  assert.ok(c.refreshes.includes("ch:1"));
  // 失敗はすぐ外れる
  void cardsOn(cards).permit!(48, "deny");
  assert.equal(held[1]!.path, "/api/cc/permissions/48/deny");
  held[1]!.reject(Object.assign(new Error("x"), { status: 409 }));
  await c.flush();
  c.chat.render(box, "1");
  assert.equal(cardsPlain(cards)[0]!.busy, false);
  assert.equal(turns.length, 1, "失敗では cardOp は読み直さない（許可の送りの読み直しだけ）");
});

test("web static: カードの on.answer・on.dismiss は /answer・/deny へ送り、通った後 /turns を読み直す", async () => {
  const { c, cards } = cardsChat({ permission: questionPermission(49, { sessionId: "sx" }) });
  cardsOn(cards).pick!(49, 0, "赤", true);
  cardsOn(cards).pick!(49, 1, "B", true);
  const loads = c.loads.length;
  cardsOn(cards).answer!(49);
  await c.flush();
  assert.deepEqual(c.posts.map((p) => [p.path, JSON.parse(JSON.stringify(p.body))]), [["/api/cc/permissions/49/answer", { requestHash: "qh", answers: [{ labels: ["赤"] }, { labels: ["B"] }] }]]);
  assert.deepEqual(c.loads.slice(loads), ["1", "1", "1"], "送りの終わりの 1 回と cardOp の 2 回");
  c.put("1", [chatTurn(10, "owner", "a")], { kind: "session", title: "t", state: "active", permission: questionPermission(50, { sessionId: "sx" }) });
  c.chat.render(c.box(), "1");
  cardsOn(cards).dismiss!(50);
  await c.flush();
  assert.deepEqual(JSON.parse(JSON.stringify(c.posts[1])), { path: "/api/cc/permissions/50/deny", body: { requestHash: "qh" } });
  assert.deepEqual(c.loads.slice(loads), ["1", "1", "1", "1", "1", "1"]);
});

test("web static: カードの on.close は all・none はそのまま、picked は昇順（何も選んでいなければ送らない）で、送っている間は busy。on.move は accept・keep の道", async () => {
  const { c, cards, box } = cardsChat({ closeDraft: CLOSE_DRAFT });
  const held = holdPost(c);
  cardsOn(cards).close!("1", "picked");
  assert.equal(held.length, 0, "選んでいなければ送らない");
  cardsOn(cards).task!("1", 2, true);
  cardsOn(cards).task!("1", 0, true);
  void cardsOn(cards).close!("1", "picked");
  assert.deepEqual(held.map((h) => [h.path, JSON.parse(JSON.stringify(h.body))]), [["/api/sessions/1/close/confirm", { selected: [0, 2] }]]);
  assert.equal(cardsPlain(cards)[0]!.busy, true);
  void cardsOn(cards).close!("1", "all");
  assert.equal(held.length, 1, "送っている間は重ねない");
  c.refreshes.length = 0;
  held[0]!.reject(Object.assign(new Error("x"), { status: 500 }));
  await c.flush();
  // 失敗した後にカードを押せる形へ戻すのは、送りの終わりの描き直しだけ（閉じる・移すは 1 秒の刻みでは描き直さない）
  assert.deepEqual(c.refreshes, ["ch:1"], "失敗の後に会話のタブを描き直す");
  c.chat.render(box, "1");
  assert.equal(cardsPlain(cards)[0]!.busy, false);
  for (const which of ["all", "none"]) {
    void cardsOn(cards).close!("1", which);
    assert.deepEqual(JSON.parse(JSON.stringify(held.at(-1)!.body)), { selected: which });
    held.at(-1)!.reject(Object.assign(new Error("x"), { status: 500 }));
    await c.flush();
  }
  c.put("1", [chatTurn(10, "owner", "a")], { kind: "session", title: "t", state: "active", moveProposal: { id: 9, from: "a", to: "b" } });
  c.chat.render(box, "1");
  for (const action of ["accept", "keep"]) {
    void cardsOn(cards).move!(9, action);
    assert.equal(cardsPlain(cards)[0]!.busy, true);
    assert.equal(held.at(-1)!.path, "/api/topics/moves/9/" + action);
    c.refreshes.length = 0;
    held.at(-1)!.reject(Object.assign(new Error("x"), { status: 500 }));
    await c.flush();
    assert.deepEqual(c.refreshes, ["ch:1"], "失敗の後に会話のタブを描き直す（" + action + "）");
    c.chat.render(box, "1");
  }
});

test("web static: 古い画面からの押し（今の要求と id が違う）と、要求の種類が合わない押しは何も送らず、ccAsk を呼ばない", async () => {
  const { c, SA, cards } = cardsChat({ permission: permissionRequest(51, { sessionId: "sx" }) });
  const ask = (SA.views as { ccAsk: Record<string, CardsFn> }).ccAsk;
  const called: string[] = [];
  for (const name of ["pick", "pickOther", "other", "permit", "answer", "dismiss"]) {
    const fn = ask[name]!;
    ask[name] = (...a: unknown[]) => {
      called.push(name);
      return fn(...a);
    };
  }
  const on = cardsOn(cards);
  const n = cards.draws.length;
  // id が違う
  on.permit!(50, "allow");
  on.pick!(50, 0, "赤", true);
  // 許可に質問の押し
  on.pick!(51, 0, "赤", true);
  on.pickOther!(51, 0, true, true);
  on.other!(51, 0, "x");
  on.answer!(51);
  on.dismiss!(51);
  // 要求が無い
  c.put("1", [chatTurn(10, "owner", "a")], { kind: "session", title: "t", state: "active", permission: null });
  on.permit!(51, "allow");
  // 質問に許可の押し
  c.put("1", [chatTurn(10, "owner", "a")], { kind: "session", title: "t", state: "active", permission: questionPermission(52, { sessionId: "sx" }) });
  on.permit!(52, "allow");
  await c.flush();
  assert.deepEqual(c.posts, []);
  assert.deepEqual(called, []);
  assert.equal(cards.draws.length, n);
});

test("web static: カードだけの描き直しは、一番下を見ていたら一番下のまま、上を読んでいたら動かさない", () => {
  const { cards, box } = cardsChat({ closeDraft: CLOSE_DRAFT });
  const scroll = talkScroll(box);
  scroll.scrollHeight = 1000;
  scroll.clientHeight = 200;
  scroll.scrollTop = 800;
  cards.onDraw = () => {
    scroll.scrollHeight += 40;
  };
  cardsOn(cards).task!("1", 0, true);
  assert.equal(scroll.scrollTop, 840);
  scroll.scrollTop = 300;
  cardsOn(cards).task!("1", 1, true);
  assert.equal(scroll.scrollTop, 300);
});

test("web static: カードの draw が false なら drop して根を外し、同じ render の中で古いカードを .tl に出す。以後そのタブでは口を呼ばず、選んだ状態は古いカードに出る", () => {
  const { c, cards, talk, box } = cardsChat({ closeDraft: CLOSE_DRAFT });
  cardsOn(cards).task!("1", 1, true);
  const scroll = talkScroll(box);
  const talkRoot = talkKids(box)[0]!;
  const root = talkKids(box)[1]!;
  cards.ok = false;
  const n = cards.draws.length;
  c.chat.render(box, "1");
  assert.equal(cards.draws.length, n + 1);
  assert.deepEqual(cards.drops, [root]);
  assert.equal(talkScroll(box), scroll);
  const kids = talkKids(box);
  assert.equal(kids.length, 2);
  assert.equal(kids[0], talkRoot);
  assert.ok(kids[1]!.classes.has("tl"));
  const card = kids[1]!.querySelector("section.card")!;
  assert.ok(card, "古いカード");
  const boxes = card.querySelectorAll("input") as Array<DomNode & { checked?: boolean }>;
  assert.deepEqual(boxes.map((b) => !!b.checked || b.getAttribute("checked") !== null), [false, true, false]);
  assert.ok(talk.draws.length > 0);
  cards.ok = true;
  c.chat.render(box, "1");
  c.chat.render(c.box(), "1");
  assert.equal(cards.draws.length, n + 1, "以後は呼ばない");
  assert.equal(box.querySelectorAll("[data-cards]").length, 0);
});

test("web static: 会話の口が無ければカードの口を呼ばず [data-cards] を作らない。右腕の枠は会話の口が在ればカードの根も作る", () => {
  // 会話の口が無い（カードの口だけ）
  const a = loadChat();
  const { cards: onlyCards } = withCards(a);
  a.put("1", [], { kind: "session", title: "t", state: "active", closeDraft: CLOSE_DRAFT });
  const boxA = a.box();
  a.chat.render(boxA, "1");
  assert.equal(onlyCards.draws.length, 0);
  assert.equal(boxA.querySelectorAll("[data-cards]").length, 0);
  assert.ok(boxA.querySelector("section.card"));
  // 右腕の枠
  const b = loadChat();
  withTalk(b);
  withComposer(b);
  const { cards } = withCards(b);
  b.put("3", [], { kind: "inbox" });
  const boxC = b.box();
  b.chat.render(boxC, "3", { title: "右腕", placeholder: "右腕に送る" });
  assert.equal(cards.draws.length, 1);
  assert.equal(boxC.querySelectorAll("[data-cards]").length, 1);
});

test("web static: 1 秒の刻みは pending の許可・質問が出ている話題のカードだけを描き、実行中のターンが無くても描く。隠れている間・許可の無い話題・SA.cards が無ければ描かない", () => {
  const { c, SA, cards, talk } = cardsChat({ permission: permissionRequest(60, { sessionId: "sx" }) });
  c.put("2", [chatTurn(10, "owner", "a")], { kind: "session", title: "u", state: "active" });
  const other = c.box();
  c.chat.render(other, "2");
  c.put("3", [chatTurn(10, "owner", "a")], { kind: "session", title: "v", state: "active", permission: questionPermission(61, { sessionId: "sx" }) });
  const third = c.box();
  c.chat.render(third, "3");
  // setInterval は chat.js（先に読む）と views.js の古い刻みの 2 つだけ（カードのために増やさない）
  assert.equal(c.intervals.length, 2);
  const tick = c.intervals[0]!;
  const talks = talk.draws.length;
  let n = cards.draws.length;
  tick();
  const drawn = cards.draws.slice(n).map((d) => d.root.getAttribute("data-cards"));
  assert.deepEqual(drawn, ["1", "3"]);
  assert.equal(talk.draws.length, talks, "会話は描かない");
  // 隠れている間
  n = cards.draws.length;
  c.state.visibility = "hidden";
  tick();
  assert.equal(cards.draws.length, n);
  c.state.visibility = "visible";
  // 終わった許可は描かない
  c.put("1", [chatTurn(10, "owner", "a")], { kind: "session", title: "t", state: "active", permission: permissionRequest(60, { state: "allowed" }) });
  tick();
  assert.deepEqual(cards.draws.slice(n).map((d) => d.root.getAttribute("data-cards")), ["3"]);
  // SA.cards が無ければ何もしない
  n = cards.draws.length;
  delete SA.cards;
  tick();
  assert.equal(cards.draws.length, n);
});

// ===== Claude Code のチャンネルのカード（chat.js が kind cc の状態の行・許可・質問・文を SA.cards に渡す。K5） =====
/** 送りの状態（ccStatusOf・ccSend.note の材料） */
const ccPend = (id: number, state: string, extra: Record<string, unknown> = {}) => ({ id, state, lastPaneState: null, replyState: null, ...extra });
/** Claude Code のセッションの保留中の許可（sessionId は持たない。送り先はチャンネルのセッション） */
const ccPermissionOf = (id: number, extra: Record<string, unknown> = {}) => ({
  id,
  state: "pending",
  toolName: "Bash",
  summary: "ls",
  expiresAt: new Date(Date.now() + 600000).toISOString(),
  requestHash: "h" + id,
  alwaysRule: null,
  ...extra,
});

/**
 * 会話・入力欄・カードの口を置き、Claude Code のチャンネル（9。セッション s1）を描く。セッションは読んだ形（中身なし）にして描くたびの読みを止め、
 * セッションの今の読みを ccLoads に積む（quiet の読みは "quiet:" 付き）。ctl.hold なら quiet の読みを手で返し、ctl.fail なら quiet の読みが reject する
 */
function ccCardsChat(cc: Record<string, unknown> = {}, list: unknown[] = [chatTurn(10, "owner", "a")]) {
  const c = loadChat();
  const { comp } = withComposer(c);
  const { talk } = withTalk(c);
  const { SA, cards } = withCards(c);
  const store = c.store as unknown as Record<string, unknown>;
  store.ccSessions = { s1: { session: null, missing: false } };
  store.ccPendingOf = (_id: string, p: unknown) => p;
  const ccLoads: string[] = [];
  const ctl = { hold: false, fail: false, held: [] as Array<() => void> };
  const load = c.store.load as Record<string, unknown>;
  load.ccSession = (id: string, opts?: { quiet?: boolean }) => {
    const quiet = !!(opts && opts.quiet);
    ccLoads.push((quiet ? "quiet:" : "") + id);
    if (quiet && ctl.fail) return Promise.reject(new Error("x"));
    if (quiet && ctl.hold) return new Promise((r) => ctl.held.push(() => r(null)));
    return Promise.resolve(null);
  };
  load.cc = () => {
    ccLoads.push("list");
    return Promise.resolve(null);
  };
  const put = (o: Record<string, unknown> = {}, l: unknown[] = list) => c.put("9", l, { kind: "cc", name: "cc-x", cc: { sessionId: "s1", state: "idle", ...o } });
  put(cc);
  const box = c.box();
  c.chat.render(box, "9");
  /** チャンネルの今を替えて描き直す */
  const draw = (o: Record<string, unknown> = {}, l: unknown[] = list) => {
    put(o, l);
    c.chat.render(box, "9");
  };
  /** 手で返す quiet の読みを全部返す */
  const release = async () => {
    for (const r of ctl.held.splice(0)) r();
    await c.flush();
  };
  return { c, SA, comp, talk, cards, box, ccLoads, ctl, draw, release };
}

const cardKeys = (cards: { draws: CardsCall[] }) => cardsPlain(cards).map((i) => i.kind + ":" + i.id);

test("web static: SA.cards があると Claude Code のチャンネルも [data-cards] に描き、.tl に状態の行・古いカード・文を作らず、ccPermissionCard を呼ばない", () => {
  const c = loadChat();
  withComposer(c);
  withTalk(c);
  const { SA, cards } = withCards(c);
  const views = SA.views as Record<string, unknown>;
  let old = 0;
  const card = views.ccPermissionCard as CardsFn;
  views.ccPermissionCard = (...a: unknown[]) => {
    old++;
    return card(...a);
  };
  const store = c.store as unknown as Record<string, unknown>;
  store.ccSessions = { s1: { session: null, missing: false } };
  store.ccPendingOf = (_id: string, p: unknown) => p;
  c.put("9", [], { kind: "cc", name: "cc-x", cc: { sessionId: "s1", state: "idle", pending: ccPend(3, "queued"), permission: ccPermissionOf(7) } });
  const box = c.box();
  c.chat.render(box, "9");
  c.put("8", [], { kind: "cc", name: "cc-y", cc: { sessionId: "s1", state: "ended" } });
  const ended = c.box();
  c.chat.render(ended, "8");
  for (const b of [box, ended]) {
    const kids = talkKids(b);
    assert.equal(kids.length, 3);
    assert.ok(kids[1]!.getAttribute("data-cards"));
    assert.equal(kids[2]!.children.length, 0);
    for (const sel of ["[data-cc-status]", "div.cc-status", "section.card", "section.cc-permission", "p.tl-hint"]) assert.equal(b.querySelectorAll(sel).length, 0, sel);
  }
  assert.equal(old, 0);
  assert.equal(cards.draws.length, 2);
  const ccItems = JSON.parse(JSON.stringify(cards.draws[0]!.state.items)) as CardItem[];
  assert.deepEqual(ccItems.map((i: CardItem) => i.kind + ":" + i.id), ["status:cc", "permission:7", "note:empty"]);
  assert.equal("terminal" in ccItems[1]!, false, "Claude Code のチャンネル（端末あり）には付けない");
  assert.deepEqual(cardsPlain(cards), [
    { kind: "note", id: "ended", text: "このセッションは終わっています。Discord のチャンネルに書くと、同じディレクトリで起動して続けられます。" },
    { kind: "note", id: "empty", text: "まだ会話はありません。下の欄か Discord で送ると、このセッションに届きます。" },
  ]);
});

test("web static: Claude Code のチャンネルの状態の行は ccStatusOf の 7 つの文で、［やめる］は届け待ち（届けている途中でない）だけ。終わったセッションには出さない", () => {
  const h = ccCardsChat();
  const cases: Array<[Record<string, unknown>, string, unknown]> = [
    [{ pending: ccPend(3, "delivering") }, "届けています…", null],
    [{ pending: ccPend(3, "queued", { lastPaneState: "dialog" }) }, "ダイアログが出ているため待っています（端末か RC で答えてください）", { id: 3, busy: false }],
    [{ pending: ccPend(3, "queued", { lastPaneState: "no_prompt" }) }, "入力欄が見つからないため待っています（端末の画面を確かめてください）", { id: 3, busy: false }],
    [{ state: "running", pending: ccPend(3, "queued") }, "作業中です。終わったら届けます", { id: 3, busy: false }],
    [{ pending: ccPend(3, "queued") }, "届け待ちです。入力待ちになったら届けます", { id: 3, busy: false }],
    [{ state: "running" }, "作業中…", null],
    [{ pending: ccPend(3, "delivered", { replyState: "waiting" }) }, "届けました。返事を待っています", null],
  ];
  for (const [cc, text, cancel] of cases) {
    h.draw(cc);
    assert.deepEqual(cardsPlain(h.cards)[0], { kind: "status", id: "cc", text, cancel }, text);
  }
  // 状態の行が無い（返事を戻した後・終わった）
  h.draw({ pending: ccPend(3, "delivered", { replyState: "sent" }) });
  assert.deepEqual(cardKeys(h.cards), []);
  h.draw({ state: "ended", pending: ccPend(3, "queued") });
  assert.deepEqual(cardKeys(h.cards), ["note:ended"]);
});

test("web static: Claude Code のチャンネルのカードの項目は 状態の行 → 許可・質問 → 終わった文 → 空の文 の順", () => {
  const h = ccCardsChat({ state: "running", pending: ccPend(3, "queued"), permission: ccPermissionOf(7) }, []);
  assert.deepEqual(cardKeys(h.cards), ["status:cc", "permission:7", "note:empty"]);
  const item = cardsPlain(h.cards)[1]!;
  assert.equal(item.tool, "Bash");
  assert.equal(item.busy, false);
  // 終わったセッションには状態の行が出ないので、終わった文は要求の次
  h.draw({ state: "ended", permission: questionPermission(8) }, []);
  assert.deepEqual(cardKeys(h.cards), ["question:8", "note:ended", "note:empty"]);
  // 会話が在れば空の文は無い
  h.draw({ state: "ended" }, [chatTurn(10, "owner", "a")]);
  assert.deepEqual(cardKeys(h.cards), ["note:ended"]);
});

test("web static: Claude Code のチャンネルの質問のカードの who は、チャンネルのセッションの名前とモード（項目にチャンネルのセッションの id を渡す）", () => {
  const h = ccCardsChat({ permission: questionPermission(8, { permissionMode: "default" }) });
  assert.equal(cardsPlain(h.cards)[0]!.who, "", "一覧に無い間は空");
  (h.c.store as unknown as Record<string, unknown>).cc = { sessions: [{ sessionId: "s1", name: "web-ui" }, { sessionId: "s2", name: "ほか" }] };
  h.draw({ permission: questionPermission(8, { permissionMode: "default" }) });
  assert.match(String(cardsPlain(h.cards)[0]!.who), /^web-ui ・ /);
});

test("web static: Claude Code のチャンネルの保留中でない要求はカードに出さず、選んだ状態を 1 回捨てる（ccQuestionForget）", () => {
  const h = ccCardsChat({ permission: questionPermission(44) });
  const views = h.SA.views as Record<string, unknown>;
  const ask = views.ccAsk as CcAsk;
  cardsOn(h.cards).pick!(44, 0, "赤", true);
  assert.deepEqual((cardsPlain(h.cards)[0]!.questions as Array<{ picked: string[] }>)[0]!.picked, ["赤"]);
  const forget = views.ccQuestionForget as CardsFn;
  const forgot: unknown[] = [];
  views.ccQuestionForget = (id: unknown) => {
    forgot.push(id);
    return forget(id);
  };
  h.draw({ permission: questionPermission(44, { state: "allowed" }) });
  assert.deepEqual(cardKeys(h.cards), []);
  assert.deepEqual(forgot, [44]);
  assert.deepEqual(JSON.parse(JSON.stringify(ask.item("s1", questionPermission(44))!.questions![0]!.picked)), [], "選んだ状態は捨てた");
});

test("web static: 状態の行の on.cancel は今の届け待ちの id だけを 1 回送り、送っている間と通った後セッションを 2 回読み直すまで busy。失敗はすぐ外れ、終わりに会話のタブを描き直す", async () => {
  const h = ccCardsChat({ pending: ccPend(3, "queued") });
  const held = holdPost(h.c);
  h.ctl.hold = true;
  h.c.refreshes.length = 0;
  const comps = h.comp.draws.length;
  cardsOn(h.cards).cancel!(3);
  assert.equal(h.comp.draws.length, comps + 1, "呼んだすぐ後に入力欄も描く");
  cardsOn(h.cards).cancel!(3);
  assert.deepEqual(held.map((x) => x.path), ["/api/cc/sends/3/cancel"]);
  assert.deepEqual(cardsPlain(h.cards)[0]!.cancel, { id: 3, busy: true }, "送っている間");
  held[0]!.resolve({});
  await h.c.flush();
  h.draw({ pending: ccPend(3, "queued") });
  assert.deepEqual(cardsPlain(h.cards)[0]!.cancel, { id: 3, busy: true }, "1 回目の読み直しの前");
  await h.release();
  h.draw({ pending: ccPend(3, "queued") });
  assert.deepEqual(cardsPlain(h.cards)[0]!.cancel, { id: 3, busy: true }, "2 回目の読み直しの前");
  assert.equal(h.ctl.held.length, 1);
  await h.release();
  h.draw({ pending: ccPend(3, "queued") });
  assert.deepEqual(cardsPlain(h.cards)[0]!.cancel, { id: 3, busy: false });
  assert.deepEqual(h.ccLoads, ["s1", "quiet:s1", "quiet:s1"], "ccSend.cancel の 1 回と cardOp の 2 回");
  assert.ok(h.c.refreshes.includes("ch:9"));
  assert.equal(h.c.loads.filter((id) => id === "9").length, 0, "/turns は読まない");
  assert.deepEqual(h.c.toasts, ["送るのをやめました"]);
  // 失敗はすぐ外れる（cardOp は読み直さない）
  cardsOn(h.cards).cancel!(3);
  held[1]!.reject(Object.assign(new Error("x"), { status: 500 }));
  await h.c.flush();
  h.draw({ pending: ccPend(3, "queued") });
  assert.deepEqual(cardsPlain(h.cards)[0]!.cancel, { id: 3, busy: false });
  assert.deepEqual(h.ccLoads, ["s1", "quiet:s1", "quiet:s1", "s1"]);
  // id が違う・届け待ちでない・Claude Code のチャンネルでない → 送らない
  cardsOn(h.cards).cancel!(4);
  h.draw({ pending: ccPend(3, "delivering") });
  cardsOn(h.cards).cancel!(3);
  h.draw({});
  cardsOn(h.cards).cancel!(3);
  await h.c.flush();
  assert.equal(held.length, 2);
  const s = cardsChat();
  const sHeld = holdPost(s.c);
  cardsOn(s.cards).cancel!(3);
  await s.c.flush();
  assert.equal(sHeld.length, 0);
});

test("web static: Claude Code のチャンネルのカードの on.permit・answer・dismiss はチャンネルのセッションへ送り、読み直しはセッションの今（/turns を読まない）", async () => {
  const h = ccCardsChat({ permission: ccPermissionOf(7) });
  const held = holdPost(h.c);
  h.ctl.hold = true;
  cardsOn(h.cards).permit!(7, "allow");
  cardsOn(h.cards).permit!(7, "deny");
  assert.deepEqual(held.map((x) => [x.path, JSON.parse(JSON.stringify(x.body))]), [["/api/cc/permissions/7/allow", { requestHash: "h7" }]]);
  assert.equal(cardsPlain(h.cards)[0]!.busy, true);
  held[0]!.resolve({});
  await h.c.flush();
  h.draw({ permission: ccPermissionOf(7) });
  assert.equal(cardsPlain(h.cards)[0]!.busy, true, "読み直しの前");
  await h.release();
  await h.release();
  h.draw({ permission: ccPermissionOf(7) });
  assert.equal(cardsPlain(h.cards)[0]!.busy, false);
  // 送りの終わりの読み（セッションと一覧）と cardOp の 2 回
  assert.deepEqual(h.ccLoads, ["s1", "list", "quiet:s1", "quiet:s1"]);
  assert.ok(h.c.refreshes.includes("ch:9"));
  // 質問の答えと、答えない
  h.ctl.hold = false;
  h.draw({ permission: questionPermission(8) });
  cardsOn(h.cards).pick!(8, 0, "赤", true);
  cardsOn(h.cards).pick!(8, 1, "B", true);
  cardsOn(h.cards).answer!(8);
  held[1]!.resolve({});
  await h.c.flush();
  h.draw({ permission: questionPermission(9) });
  cardsOn(h.cards).dismiss!(9);
  held[2]!.resolve({});
  await h.c.flush();
  assert.deepEqual(held.slice(1).map((x) => [x.path, JSON.parse(JSON.stringify(x.body))]), [
    ["/api/cc/permissions/8/answer", { requestHash: "qh", answers: [{ labels: ["赤"] }, { labels: ["B"] }] }],
    ["/api/cc/permissions/9/deny", { requestHash: "qh" }],
  ]);
  assert.deepEqual(h.ccLoads.slice(4), ["s1", "list", "quiet:s1", "quiet:s1", "s1", "list", "quiet:s1", "quiet:s1"]);
  assert.equal(h.c.loads.filter((id) => id === "9").length, 0, "/turns は読まない");
});

test("web static: Claude Code のチャンネルのカードの読み直しが reject しても待ちの形は外れ、捕まえ手の無い reject にならない", async (t) => {
  const unhandled: unknown[] = [];
  const onUnhandled = (reason: unknown): void => {
    unhandled.push(reason);
  };
  process.on("unhandledRejection", onUnhandled);
  t.after(() => {
    process.off("unhandledRejection", onUnhandled);
  });
  const h = ccCardsChat({ permission: ccPermissionOf(7), pending: ccPend(3, "queued") });
  h.ctl.fail = true;
  cardsOn(h.cards).permit!(7, "allow");
  cardsOn(h.cards).cancel!(3);
  await h.c.flush();
  await new Promise((r) => setImmediate(r));
  h.draw({ permission: ccPermissionOf(7), pending: ccPend(3, "queued") });
  const items = cardsPlain(h.cards);
  assert.deepEqual(items[0]!.cancel, { id: 3, busy: false });
  assert.equal(items[1]!.busy, false);
  assert.ok(h.ccLoads.filter((x) => x === "quiet:s1").length >= 2, "読み直しを試した");
  assert.deepEqual(unhandled, []);
});

test("web static: 1 秒の刻みは Claude Code のチャンネルの保留中の要求でもカードを描き、要求が無ければ描かない", () => {
  const h = ccCardsChat({ permission: ccPermissionOf(7) });
  const tick = h.c.intervals[0]!;
  let n = h.cards.draws.length;
  tick();
  assert.deepEqual(h.cards.draws.slice(n).map((d) => d.root.getAttribute("data-cards")), ["9"]);
  h.draw({ pending: ccPend(3, "queued") });
  n = h.cards.draws.length;
  tick();
  assert.equal(h.cards.draws.length, n);
});

test("web static: Claude Code のチャンネルでカードの口が描けなければ、状態の行と許可のカードは古い .tl に出る", () => {
  const h = ccCardsChat({ pending: ccPend(3, "queued"), permission: ccPermissionOf(7) });
  h.cards.ok = false;
  h.draw({ pending: ccPend(3, "queued"), permission: ccPermissionOf(7) });
  assert.equal(h.box.querySelectorAll("[data-cards]").length, 0);
  const tl = talkKids(h.box)[1]!;
  assert.ok(tl.classes.has("tl"));
  assert.equal(tl.querySelectorAll("[data-cc-status]").length, 1);
  assert.equal(tl.querySelectorAll("section.card").length, 1);
});

test("web static: Claude Code のチャンネルの画面の写しは、開いていれば .tl（カードの根の次）に在る", () => {
  const h = ccCardsChat({ state: "ended" });
  assert.equal(h.box.querySelectorAll("section.card").length, 0);
  chatHead(h.c, "9")!.menu.find((i) => i.label === "画面を見る")!.run!();
  h.draw({ state: "ended" });
  const kids = talkKids(h.box);
  assert.equal(kids[1]!.getAttribute("data-cards"), "9");
  assert.ok(kids[2]!.classes.has("tl"));
  const screen = kids[2]!.querySelector("section.card")!;
  assert.equal(screen.getAttribute("id"), "cc-screen-9");
  assert.deepEqual(cardKeys(h.cards), ["note:ended"]);
});

type CompSent = { id: number; text: string; tone: string; cancel: boolean; busy: boolean } | null;
const compSent = (comp: { draws: ComposerCall[] }): CompSent => JSON.parse(JSON.stringify((lastComp(comp).state as unknown as { sent: CompSent }).sent ?? null)) as CompSent;

test("web static: 入力欄の部品の道では古い帯（.cc-send-state）を作らず、Claude Code のチャンネルの入力欄の state に sent と on.cancel が在る（話題には無い）", () => {
  const h = ccCardsChat({ pending: ccPend(3, "delivered", { replyState: "posted" }) });
  assert.equal(h.box.querySelectorAll(".cc-send-state").length, 0);
  const st = lastComp(h.comp).state as unknown as { sent: CompSent; on: Record<string, unknown> };
  assert.deepEqual(Object.keys(st.on).sort(), ["cancel", "input", "send"]);
  assert.deepEqual(compSent(h.comp), { id: 3, text: "本文 #3: 届けました・返事が来ました", tone: "done", cancel: false, busy: false });
  const s = cardsChat();
  const sst = lastComp(s.comp).state as unknown as Record<string, unknown>;
  assert.equal("sent" in sst, false);
  assert.deepEqual(Object.keys(sst.on as object).sort(), ["input", "send"]);
});

test("web static: 入力欄の sent は状態の行が届け待ち・届けたを出している間は null で、ほかは ccSend.note の文と色（終わったセッションの届け待ちは［やめる］）", () => {
  const h = ccCardsChat();
  const note = (h.SA.views as { ccSend: { note: (p: unknown) => Record<string, unknown> | null } }).ccSend.note;
  for (const cc of [
    { pending: ccPend(3, "queued") },
    { pending: ccPend(3, "delivering") },
    { state: "running", pending: ccPend(3, "queued") },
    { pending: ccPend(3, "delivered", { replyState: "waiting" }) },
    {},
  ]) {
    h.draw(cc);
    assert.equal(compSent(h.comp), null, JSON.stringify(cc));
  }
  const cases: Array<[Record<string, unknown>, string, string, boolean]> = [
    [{ pending: ccPend(3, "cancelled") }, "本文 #3: 送るのをやめました", "", false],
    [{ pending: ccPend(3, "delivered", { replyState: "posted" }) }, "本文 #3: 届けました・返事が来ました", "done", false],
    [{ state: "running", pending: ccPend(3, "delivered", { replyState: "waiting" }) }, "本文 #3: 届けました・返事を待っています", "done", false],
    [{ pending: ccPend(3, "gave_up") }, "本文 #3: 入力待ちにならなかったため、届けるのをやめました", "warning", false],
    [{ state: "ended", pending: ccPend(3, "queued") }, "本文 #3: 届け待ち。入力待ちになったら届けます", "", true],
  ];
  for (const [cc, text, tone, cancel] of cases) {
    h.draw(cc);
    assert.deepEqual(compSent(h.comp), { id: 3, text, tone, cancel, busy: false }, text);
    assert.deepEqual(JSON.parse(JSON.stringify(note(cc.pending))), { id: 3, text, tone, cancel }, "ccSend.note と同じ");
  }
  // セッションが無いチャンネルには出さない
  h.draw({ sessionId: undefined, pending: ccPend(3, "cancelled") });
  assert.equal(compSent(h.comp), null);
});

test("web static: 入力欄の帯の on.cancel は状態の行と同じ道で送り、送っている間と読み直すまで busy。押した時は入力欄だけを描き直す", async () => {
  const h = ccCardsChat({ state: "ended", pending: ccPend(3, "queued") });
  const held = holdPost(h.c);
  h.ctl.hold = true;
  const counts = [h.comp.draws.length, h.talk.draws.length, h.cards.draws.length];
  const on = lastComp(h.comp).state.on as unknown as { cancel: (id: number) => void };
  on.cancel(3);
  on.cancel(3);
  assert.deepEqual(held.map((x) => x.path), ["/api/cc/sends/3/cancel"]);
  assert.equal(h.comp.draws.length, counts[0]! + 2, "2 回とも入力欄を描く");
  assert.equal(h.talk.draws.length, counts[1], "会話は描かない");
  assert.equal(compSent(h.comp)!.busy, true);
  held[0]!.resolve({});
  await h.c.flush();
  await h.release();
  h.draw({ state: "ended", pending: ccPend(3, "queued") });
  assert.equal(compSent(h.comp)!.busy, true, "2 回目の読み直しの前");
  await h.release();
  h.draw({ state: "ended", pending: ccPend(3, "queued") });
  assert.equal(compSent(h.comp)!.busy, false);
  assert.deepEqual(h.ccLoads, ["s1", "quiet:s1", "quiet:s1"]);
  // id が違えば送らない
  on.cancel(4);
  await h.c.flush();
  assert.equal(held.length, 1);
});

test("web static: Claude Code のチャンネルで入力欄の口が描けなければ古い帯（.cc-send-state）を今の条件で出し、状態の行と要求は部品のまま", () => {
  const h = ccCardsChat({ pending: ccPend(3, "cancelled"), permission: ccPermissionOf(7) });
  h.comp.ok = false;
  h.draw({ pending: ccPend(3, "cancelled"), permission: ccPermissionOf(7) });
  assert.equal(h.box.querySelectorAll("div.cc-send-state").length, 1);
  assert.deepEqual(cardKeys(h.cards), ["permission:7"]);
  // 状態の行が届け待ちを出している間は古い帯も出さない
  h.draw({ pending: ccPend(3, "queued") });
  assert.equal(h.box.querySelectorAll("div.cc-send-state").length, 0);
  assert.deepEqual(cardKeys(h.cards), ["status:cc"]);
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
  const view = (value: string) => h.lastTop().on.view(value);
  const count = (tab: string) => h.opens.filter((t) => t === tab).length;
  view("talk");
  assert.equal(count("ch:a"), 1, "同じ view の押し直しでは呼ばない");
  view("pane");
  assert.equal(count("cc:s1"), 1);
  assert.equal(count("ch:a"), 1);
  view("talk");
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
  h.lastTop().on.view("pane");
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
/** スマホの下のバーの右腕を押す（deck なら流れの列の下のバー（D2）、でなければ一覧の下のバー）。H11 で同じ流れを両方の形で回す */
function phoneBarHand(h: ReturnType<typeof loadShell>, deck: boolean) {
  if (!deck) return h.press.bottom("hand");
  const bar = h.deck.bars.at(-1);
  assert.ok(bar, "SA.deck.drawBar が呼ばれていない（か null）");
  return bar.on.hand(h.nodes.footButtons.hand);
}
/** そのボタン（閉じた後の焦点の戻り先） */
function phoneBarHandButton(h: ReturnType<typeof loadShell>, deck: boolean) {
  return deck ? h.nodes.footButtons.hand : h.nodes.bottomHand;
}
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
  // 今のスマホの殻と、流れの列（D2。H11）で同じ期待（下のバーの右腕は deck なら列の下のバー）
  for (const deck of [false, true]) {
    const h = await loadHand({ phone: true, deck });
    const stateOf = (x: HandShell) => JSON.parse(JSON.stringify(x.history.state)) as unknown;
    // 一覧の下の口: 開いて入力欄に焦点。entry を 1 つ積む
    phoneBarHand(h, deck);
    assert.equal(handOf(h), "open");
    assert.equal(h.calls.push, 1);
    assert.deepEqual(stateOf(h), { v3Body: false, v3Hand: true, v3Depth: 0 });
    assert.equal(h.document.activeElement, h.nodes.handEd.querySelector("textarea.composer-input"));
    // 戻ると閉じ、口に焦点
    h.history.back();
    assert.equal(handOf(h), "closed");
    assert.equal(h.nodes.v3.getAttribute("data-view"), "list");
    assert.equal(h.document.activeElement, phoneBarHandButton(h, deck));
    // 会話の上の [右腕] から開いて [畳む] → 戻る（会話のまま）で閉じる
    h.app.open("ch:1");
    assert.equal(h.calls.push, 2);
    h.lastTop().on.hand(h.nodes.topButtons.hand);
    assert.equal(h.calls.push, 3);
    assert.deepEqual(stateOf(h), { v3Body: true, v3Hand: true, v3Depth: 1 });
    handClose(h).dispatch("click");
    assert.equal(handOf(h), "closed");
    assert.equal(h.nodes.v3.getAttribute("data-view"), "body");
    assert.deepEqual(stateOf(h), { v3Body: true });
    assert.equal(h.document.activeElement, h.nodes.topButtons.hand);
    // 開いたまま話題を開くと、右腕は閉じて右腕の entry が話題の entry になる（積み増さない）
    h.lastTop().on.hand(h.nodes.topButtons.hand);
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
  }
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
  p.lastTop().on.hand(p.nodes.topButtons.hand);
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
  p.lastTop().on.hand(p.nodes.topButtons.hand);
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
  // 見出しの [右腕] の印（描くのは部品。何かを開いている間の state の hand が下のバーと同じ）
  t.app.open("tasks");
  assert.equal(t.lastTop().hand, "turn");
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
  u.app.open("tasks");
  assert.deepEqual(JSON.parse(JSON.stringify(asked.at(-1))), { id: "900", last });
  assert.equal(u.nodes.handShow.getAttribute("aria-label"), "右腕を開く（未読）");
  assert.equal(u.bottomState().hand, "unread");
  assert.equal(u.lastTop().hand, "unread");
  u.nodes.handShow.dispatch("click");
  assert.equal(u.bottomState().hand, null);
  assert.equal(u.lastTop().hand, null);
  assert.equal(u.nodes.handShow.getAttribute("aria-label"), "右腕を開く");
  u.nodes.backdrop.dispatch("click");
  assert.equal(u.bottomState().hand, "unread");
  assert.equal(u.lastTop().hand, "unread");
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
  c.lastTop().on.hand(c.nodes.topButtons.hand);
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

test("web static: 新しい殻（index.html）に右腕の枠と 2 つの口と見出しの入れ物と下のバーの入れ物があり、右腕のための <dialog> は無い", () => {
  const html = read(SHELL_HTML);
  assert.match(html, /<div class="v3" id="v3" data-view="list" data-hand="closed" data-hand-mode="over">/);
  assert.match(html, /<\/main>\s*<aside class="v3-hand" id="v3-hand" aria-label="右腕">\s*<button class="btn btn-ghost btn-sm btn-icon-sm v3-hand-show" id="v3-hand-show" type="button" aria-controls="v3-hand-ed" aria-expanded="false"><\/button>\s*<div class="v3-slot" id="c-hand-root"><\/div>\s*<div class="ed v3-hand-ed" id="v3-hand-ed"><\/div>\s*<\/aside>\s*<div class="v3-hand-backdrop" id="v3-hand-backdrop" hidden><\/div>\s*<div class="v3-find-backdrop" id="v3-find-backdrop" hidden><\/div>\s*<\/div>/);
  assert.match(html, /id="c-list-root"><\/div>\s*<div class="v3-slot" id="c-bottom-root"><\/div>\s*<\/nav>/);
  // 流れの列（D1）: 上の帯は根の最初の子、列は一覧と列 2 の間。どちらも中は部品が描く
  assert.match(html, /<div class="v3" id="v3"[^>]*>\s*<div class="v3-band" id="v3-band"><div class="v3-slot" id="c-band-root"><\/div><\/div>\s*<nav class="v3-list"/);
  // スマホの流れの列の下のバー（D2）は列の次・列 2 の前（Tab の順は 帯 → 列 → 下のバー）
  assert.match(html, /<\/nav>\s*<div class="v3-deck" id="v3-deck"><div class="v3-slot" id="c-deck-root"><\/div><\/div>\s*<div class="v3-foot" id="v3-foot"><div class="v3-slot" id="c-foot-root"><\/div><\/div>\s*<main class="v3-main"/);
  assert.doesNotMatch(html, /v3-hand-ask|v3-hand-entry|v3-list-foot/);
  // 見出しの [右腕] は部品（入口 c-app.js の TopBar）。aria-controls の先の右腕の枠（id="v3-hand"）はここ
  assert.match(html, /<main class="v3-main" id="v3-main">\s*<div class="v3-slot" id="c-top-root"><\/div>\s*<div class="ed" id="ed"><\/div>\s*<\/main>/);
  assert.match(html, /<aside class="v3-hand" id="v3-hand"/);
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
  // 話題でない画面も見出しを描く（スマホは部品が [右腕] を出す）
  assert.equal(h.lastTop().view, "other");
  h.lastTop().on.hand(h.nodes.topButtons.hand);
  assert.deepEqual(stateOf(), { v3Body: true, v3Hand: true, v3Depth: 1 });
  // 広げると列の右腕（保存した既定は開く）。entry の印は外す
  h.setPhone(false, 1400);
  assert.equal(h.nodes.v3.getAttribute("data-hand-mode"), "column");
  assert.equal(handOf(h), "open");
  assert.deepEqual(stateOf(), { v3Body: true, v3Depth: 2 });
  assert.equal(h.lastTop().view, "other");
  // 狭めると重ねる形で閉じ、右腕の中にあった焦点は見出しの [右腕] へ
  h.setPhone(true, 390);
  assert.equal(h.nodes.v3.getAttribute("data-hand-mode"), "over");
  assert.equal(handOf(h), "closed");
  assert.equal(h.document.activeElement, h.nodes.topButtons.hand);
  h.lastTop().on.hand(h.nodes.topButtons.hand);
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

test("web static: 重ねた右腕を畳んで話題を開いたとき、入力欄が部品なら焦点は口の focus(根)。false なら今の道（一覧の開いた行）", async () => {
  for (const ok of [true, false]) {
    const roots: DomNode[] = [];
    const h = await loadHand(
      {
        width: 800,
        composer: (root) => {
          roots.push(root);
          return ok;
        },
      },
      [v3Topic("ch:1")],
    );
    h.nodes.handShow.dispatch("click");
    assert.equal(h.document.activeElement, handClose(h));
    const rows = h.list.focusRows.length;
    h.app.open("ch:1");
    assert.equal(handOf(h), "closed");
    assert.equal(roots.length, 1, String(ok));
    assert.equal(roots[0]!.getAttribute("data-composer"), "1");
    assert.equal(roots[0]!.parent, h.nodes.ed);
    if (ok) assert.equal(h.list.focusRows.length, rows, "行には頼まない");
    else assert.deepEqual(h.list.focusRows.at(-1), "ch:1", "開いた行に焦点を頼む");
  }
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
  // 今のスマホの殻と、流れの列（D2。H11）で同じ期待
  for (const deck of [false, true]) {
    const topics = [v3Topic("ch:1", { title: "X" }), v3Topic("ch:2", { title: "Y" }), v3Topic("ch:3", { title: "Z" })];
    const cardOpen = (h: HandShell, id: string) => h.nodes.handEd.querySelector(`div.v3-card[data-topic="${id}"]`)!.buttons()[0]!.dispatch("click");
    const back = (h: HandShell) => h.nodes.ed.querySelector("button.ed-back")!.dispatch("click");
    const stateOf = (h: HandShell) => JSON.parse(JSON.stringify(h.history.state)) as unknown;
    // X → [右腕] → 札 Y → [‹]
    const h = await loadHand({ phone: true, deck }, topics);
    h.handReplies.push("<#2> と <#3>");
    h.app.open("ch:1");
    h.lastTop().on.hand(h.nodes.topButtons.hand);
    assert.deepEqual(stateOf(h), { v3Body: true, v3Hand: true, v3Depth: 1 });
    cardOpen(h, "ch:2");
    assert.equal(h.app.activeTabId(), "ch:2");
    assert.deepEqual(stateOf(h), { v3Body: true, v3Depth: 2 });
    back(h);
    assert.equal(h.nodes.v3.getAttribute("data-view"), "list");
    assert.equal(h.location.hash, "");
    assert.equal(h.history.state, null);
    // X → [右腕] → 札 Y → [右腕] → 札 Z → [‹]
    const z = await loadHand({ phone: true, deck }, topics);
    z.handReplies.push("<#2> と <#3>");
    z.app.open("ch:1");
    z.lastTop().on.hand(z.nodes.topButtons.hand);
    cardOpen(z, "ch:2");
    z.lastTop().on.hand(z.nodes.topButtons.hand);
    cardOpen(z, "ch:3");
    assert.deepEqual(stateOf(z), { v3Body: true, v3Depth: 3 });
    back(z);
    assert.equal(z.nodes.v3.getAttribute("data-view"), "list");
    assert.equal(z.location.hash, "");
    // 一覧 → [右腕] → 札 Y → [‹] は今までどおり back 1 回
    const l = await loadHand({ phone: true, deck }, topics);
    l.handReplies.push("<#2>");
    phoneBarHand(l, deck);
    assert.deepEqual(stateOf(l), { v3Body: false, v3Hand: true, v3Depth: 0 });
    cardOpen(l, "ch:2");
    assert.deepEqual(stateOf(l), { v3Body: true, v3Depth: 1 });
    back(l);
    assert.equal(l.calls.back, 1);
    assert.equal(l.nodes.v3.getAttribute("data-view"), "list");
    assert.equal(l.location.hash, "");
    // ブラウザの戻るは前の話題（X）の entry
    const b = await loadHand({ phone: true, deck }, topics);
    b.handReplies.push("<#2>");
    b.app.open("ch:1");
    b.lastTop().on.hand(b.nodes.topButtons.hand);
    cardOpen(b, "ch:2");
    b.history.back();
    assert.equal(b.nodes.v3.getAttribute("data-view"), "body");
    assert.equal(b.location.hash, "#/ch/1");
  }
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

// ===== 統括のまとめの知らせ（#457 の L2） =====
test("web static: 右腕の知らせ（統括のまとめ）の <#ID> は引けたものを「題名」に、引けないものは <#…> のまま", async () => {
  const h = await loadHand({}, [v3Topic("ch:208", { title: "領収書の整理" })]);
  h.handNotices.push("終わりました: <#208>（4 分）\n終わりました: <#209>（1 分未満）");
  h.app.refresh("ch:900");
  const notice = h.nodes.handEd.querySelector("p.fake-notice")!.textContent;
  assert.match(notice, /「領収書の整理」/);
  assert.doesNotMatch(notice, /<#208>/);
  assert.match(notice, /<#209>/);
});

test("web static: 右腕を開いたまま、知らせ（統括のまとめ）に出た話題の題が変わると右腕を描き直す（返事にその ID が無くても）", async () => {
  const topics = [v3Topic("ch:208", { title: "領収書の整理" })];
  const h = await loadHand({}, topics);
  h.handReplies.push("わかりました");
  h.handNotices.push("終わりました: <#208>（4 分）");
  h.app.refresh("ch:900");
  assert.match(h.nodes.handEd.querySelector("p.fake-notice")!.textContent, /「領収書の整理」/);
  const renders = h.handRenders.length;
  topics[0] = v3Topic("ch:208", { title: "領収書の整理 2" });
  await h.topics.load();
  assert.equal(h.handRenders.length, renders + 1);
  assert.match(h.nodes.handEd.querySelector("p.fake-notice")!.textContent, /「領収書の整理 2」/);
});

// ===== 右腕の見出しと中身を部品へ（K6） =====
test("web static: 右腕の見出しは SA.hand が在れば口へ（開いている間だけ・menu は操作が在るとき）、chat.js へは head: false の枠。draw が false なら古い見出しに戻る。「…」は「右腕 の操作」の板、札のデータは題・meta・id で onRef がその話題を開く", async () => {
  const topics = [v3Topic("ch:11", { title: "領収書", mark: "running", place: { dir: "~/w/x" } }), v3Topic("ch:12", { title: "B" })];
  const h = await loadHand({ hand: {} }, topics);
  h.handReplies.push("<#11> と <#12>");
  h.app.refresh("ch:900");
  const last = () => h.handHead.draws.at(-1);
  assert.equal(handOf(h), "open");
  assert.deepEqual([last()!.title, last()!.menu], ["右腕", false], "chat.js の head が無ければ「…」を出さない");
  const frame = h.handRenders.at(-1)!.frame;
  assert.equal(frame.head, false);
  assert.equal(h.nodes.handEd.querySelector("header.ed-toolbar"), null);
  assert.equal(handClose(h), null);
  // 札のデータ（札の DOM は作らない）
  const refs = () => h.nodes.handEd.querySelectorAll("div.fake-ref").map((r) => [r.getAttribute("data-topic"), r.textContent]);
  assert.deepEqual(refs()[0], ["ch:11", "領収書|~/w/x・作業中"]);
  assert.deepEqual(refs().map((r) => r[0]), ["ch:11", "ch:12"]);
  assert.equal(h.nodes.handEd.querySelectorAll("div.v3-card").length, 0);
  frame.onRef!("ch:12");
  assert.equal(h.app.activeTabId(), "ch:12");
  // 話題の題が変わると右腕を描き直す（札の ID を覚えている）
  const renders = h.handRenders.length;
  topics[0] = v3Topic("ch:11", { title: "領収書 2", mark: "running", place: { dir: "~/w/x" } });
  await h.topics.load();
  assert.equal(h.handRenders.length, renders + 1);
  assert.deepEqual(refs()[0], ["ch:11", "領収書 2|~/w/x・作業中"]);
  // 「…」: chat.js の head の menu が在れば出し、押すと「右腕 の操作」の板
  h.chatHeads["900"] = { title: "inbox", status: null, note: null, menu: [{ icon: "rotate-ccw", label: "会話を新しくする", run: () => undefined }] };
  h.app.refresh("ch:900");
  assert.equal(last()!.menu, true);
  last()!.on.menu(h.handButtons.menu);
  assert.equal(h.nodes.sheet.getAttribute("aria-label"), "右腕 の操作");
  assert.deepEqual(h.nodes.sheet.querySelectorAll("button.more-row").map((r) => textOf(r.querySelector("span.sb-label")!)), ["会話を新しくする"]);
  h.nodes.sheet.removeAttribute("open");
  // 札を引くところで投げたら、その返事の札が出ないだけ（本文・ID はログに出さない）
  const topicsApi = h.topics as unknown as { find: (id: string) => unknown };
  const find = topicsApi.find;
  let once = true;
  topicsApi.find = (id: string) => {
    if (id === "ch:12" && once) {
      once = false;
      throw new Error("x");
    }
    return find(id);
  };
  h.app.refresh("ch:900");
  assert.deepEqual(h.warns, ["[web] hand refs failed"]);
  assert.equal(refs().length, 0);
  assert.equal(h.errors.length, 0);
  topicsApi.find = find;
  // [畳む]（on.close）で閉じると見出しを消す
  last()!.on.close();
  assert.equal(handOf(h), "closed");
  assert.equal(last(), null);
  // draw が false なら古い見出しに戻り、以後は口を呼ばない
  const g = await loadHand({ hand: { draw: (st) => st === null } }, topics);
  assert.equal(g.handHead.draws.at(-1), null);
  assert.equal(g.handRenders.at(-1)!.frame.head, undefined);
  assert.ok(handClose(g));
  assert.ok(g.nodes.handEd.querySelector("header.ed-toolbar"));
  const draws = g.handHead.draws.length;
  g.app.refresh("ch:900");
  assert.equal(g.handHead.draws.length, draws);
  assert.ok(handClose(g));
  // 一覧をまだ読んでいない・右腕が無いときは、部品の見出しの下に本文だけ
  const n = loadShell({ hand: {} });
  await n.flush();
  n.api.reply = () => Promise.resolve(v3Result([]));
  await n.topics.load();
  assert.equal(n.nodes.handEd.querySelector("header.ed-toolbar"), null);
  assert.ok(n.nodes.handEd.querySelector("div.v3-empty"));
  assert.deepEqual([n.handHead.draws.at(-1)!.title, n.handHead.draws.at(-1)!.menu], ["右腕", false]);
});

test("web static: 右腕を開いたときの焦点: 下のバーからは SA.composer.focus(根)、ほかは SA.hand.focus(\"close\")。口が無い・通らなければ今の要素（.composer-input・#v3-hand-close）", async () => {
  for (const ok of [true, false]) {
    const roots: DomNode[] = [];
    const p = await loadHand({
      phone: true,
      hand: {},
      handComposer: true,
      composer: (root) => {
        roots.push(root);
        return ok;
      },
    });
    p.press.bottom("hand");
    assert.equal(roots.length, 1, String(ok));
    assert.equal(roots[0]!.parent, p.nodes.handEd);
    // 通らなければ .composer-input も無いので [畳む]
    if (ok) assert.deepEqual(p.handHead.focuses, []);
    else {
      assert.deepEqual(p.handHead.focuses, ["close"]);
      assert.equal(p.document.activeElement, p.handButtons.close);
    }
  }
  // 入力欄の口が無ければ古い入力欄
  const q = await loadHand({ phone: true, hand: {} });
  q.press.bottom("hand");
  assert.equal(q.document.activeElement, q.nodes.handEd.querySelector("textarea.composer-input"));
  // 畳んだ帯から: 部品の [畳む]
  const w = await loadHand({ width: 800, hand: {} });
  w.nodes.handShow.dispatch("click");
  assert.deepEqual(w.handHead.focuses, ["close"]);
  assert.equal(w.document.activeElement, w.handButtons.close);
  // 口が焦点を断れば #v3-hand-close（部品の見出しでは無いので、焦点は動かさない）
  const r = await loadHand({ width: 800, hand: { focus: false } });
  const before = r.document.activeElement;
  r.nodes.handShow.dispatch("click");
  assert.deepEqual(r.handHead.focuses, ["close"]);
  assert.equal(r.document.activeElement, before);
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
  h.lastTop().on.hand(h.nodes.topButtons.hand);
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

test("web static: 新しい殻（index.html）の始めるダイアログは aria-labelledby・label の for・role=alert を持ち、inline の script・style が無い", () => {
  const html = read(SHELL_HTML);
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
  // [+] は topics.js が作る（index.html の「あなたの番」の見出しには無い）
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
  // 今のスマホの殻と、流れの列（D2。H11）で同じ期待
  for (const deck of [false, true]) {
    const p = await loadStart({ phone: true, width: 390, deck }, { rightHands: [v3Hand()] });
    p.api.postReply = () => Promise.resolve(created());
    phoneBarHand(p, deck);
    assert.equal(p.nodes.v3.getAttribute("data-hand"), "open");
    p.app.newSession("general");
    startEl(p, "text").value = "やあ";
    submitStart(p);
    await p.flush();
    assert.equal(p.nodes.v3.getAttribute("data-hand"), "closed");
    assert.equal(p.nodes.v3.getAttribute("data-view"), "body");
    assert.equal(p.app.activeTabId(), "ch:77");
    assert.equal(p.location.hash, "#/ch/77");
  }
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
  // 見出しの部品が「場所: 」を付けて出す名前
  const place = () => "場所: " + h.lastTop().place!.text;
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
/** 見出しの state の場所（描くのは部品の場所のボタン） */
const placeOf = (h: PlaceShell) => h.lastTop().place;
/** 部品が見せる場所の読み上げの名前（「場所: 」を付けるのは部品） */
const placeLabel = (h: PlaceShell) => "場所: " + placeOf(h)!.text;
/** 見出しの場所のボタン（opener。fake DOM の代わりのボタン。確認の後に SA.top.focus("place") がここへ） */
const placeBtn = (h: PlaceShell) => h.nodes.topButtons.place;
/** 場所のボタンを押した代わり（部品は押せない場所では on.place を呼ばないが、ここでは呼んで openPlace の守りも見る） */
const pressPlace = (h: PlaceShell) => h.lastTop().on.place(placeBtn(h));
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
  pressPlace(h);
  pickPlace(h, label);
  h.document.getElementById("dlg-confirm-ok")!.dispatch("click");
};

test("web static: 新しい殻（index.html）に場所の帯（v3-bar・v3-place・v3-views・v3-hand-open）が無く、見出しの入れ物 #c-top-root がある。dialog の数は M4b の後と同じ", () => {
  const html = read(SHELL_HTML);
  assert.match(html, /<div class="v3-slot" id="c-top-root"><\/div>/);
  for (const name of ["v3-bar", "v3-place", "v3-views", "v3-hand-open"]) {
    assert.equal(html.includes(name), false, SHELL_HTML + ": " + name);
    assert.equal(read("shell.css").includes(name), false, "shell.css: " + name);
    assert.equal(read("shell.js").includes(name), false, "shell.js: " + name);
  }
  assert.equal(html.match(/<dialog\b/g)?.length, 3);
  for (const id of ["v3-sheet", "v3-start", "dlg-confirm"]) assert.match(html, new RegExp(`<dialog id="${id}"`), id);
});
test("web static: v3 の場所: movable が true の話題では押せる。理由があれば押せず、reason がその理由", async () => {
  const h = await loadPlace();
  h.app.open("ch:3");
  assert.deepEqual(JSON.parse(JSON.stringify(placeOf(h))), { text: "alpha", movable: true, reason: null });
  assert.equal(placeLabel(h), "場所: alpha");
  for (const [id, reason] of [
    ["ch:4", "端末のセッションは場所を変えられません"],
    ["ch:5", "完了した話題は場所を変えられません"],
  ] as const) {
    h.app.open(id);
    assert.equal(placeOf(h)!.movable, false, id);
    assert.equal(placeOf(h)!.reason, reason);
    // 押しても（部品は押せない場所で on.place を呼ばないが）シートは開かない
    pressPlace(h);
    assert.equal(h.nodes.sheet.getAttribute("open"), null);
  }
  // サーバーの理由をそのまま出す（画面に理由の文を持たない）
  h.topicList = h.topicList.map((t) => (t.id === "ch:5" ? { ...t, movable: { reason: "設定が済んでいません。端末で npm run unify-setup -- --print の行を実行して再起動してください" } } : t));
  await h.topics.load();
  assert.equal(placeOf(h)!.reason, "設定が済んでいません。端末で npm run unify-setup -- --print の行を実行して再起動してください");
  // 押せる話題に戻ると理由を外す
  h.app.open("ch:1");
  assert.equal(placeOf(h)!.movable, true);
  assert.equal(placeOf(h)!.reason, null);
});
test("web static: v3 の場所: 一覧を読み直すと、見出しの state の場所（文字・押せるか・理由）が今の話題に合う", async () => {
  const h = await loadPlace();
  h.app.open("ch:2");
  const draws = h.top.draws.length;
  await h.topics.load();
  assert.ok(h.top.draws.length > draws, "読み直したら見出しも描く");
  assert.deepEqual(JSON.parse(JSON.stringify(placeOf(h))), { text: "なし", movable: true, reason: null });
  // 付け替えの途中: movable が理由つきになり押せない
  h.topicList = h.topicList.map((t) => (t.id === "ch:2" ? { ...t, movable: { reason: "場所を変えています" } } : t));
  await h.topics.load();
  assert.deepEqual(JSON.parse(JSON.stringify(placeOf(h))), { text: "なし", movable: false, reason: "場所を変えています" });
  // 終わって place が変わったら新しい場所
  h.topicList = h.topicList.map((t) => (t.id === "ch:2" ? { ...t, group: "p:alpha", place: { dir: "alpha" }, movable: true } : t));
  await h.topics.load();
  assert.equal(placeLabel(h), "場所: alpha");
  assert.equal(placeOf(h)!.movable, true);
  assert.equal(placeOf(h)!.reason, null);
  // on は毎回同じ物
  assert.equal(h.top.draws[0]!.on, h.lastTop().on);
});
test("web static: v3 の場所: 話題でない画面では場所を渡さない", async () => {
  const h = await loadPlace();
  assert.equal(h.lastTop().view, "none", "起動の直後（何も開いていない）");
  assert.equal(h.lastTop().place, null);
  h.app.open("ch:1");
  assert.notEqual(placeOf(h), null);
  h.app.open("tasks");
  assert.equal(h.lastTop().view, "other");
  assert.equal(placeOf(h), null);
  // スマホも話題でない画面は other（部品が [右腕] を出す）で、場所は無い
  const p = await loadPlace({ phone: true });
  p.app.open("tasks");
  assert.equal(p.lastTop().view, "other");
  assert.equal(placeOf(p), null);
  p.app.open("ch:3");
  assert.equal(placeOf(p)!.text, "alpha");
});
test("web static: v3 の場所: 押すとシート「場所を変える」が開き、候補は General が先頭でプロジェクトが続く。今の場所は押せない行で右に「今の場所」", async () => {
  const h = await loadPlace();
  h.app.open("ch:3");
  pressPlace(h);
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
  pressPlace(h);
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
  pressPlace(h);
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
  pressPlace(h);
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
  pressPlace(h);
  pickPlace(h, "General");
  assert.equal(confirmText(h, "body"), "場所を なし から General に変えます。会話の記録はこのまま残り、担当には要点を引き継ぎます。場所なしには戻せません");
  h.document.getElementById("dlg-confirm-cancel")!.dispatch("click");
  h.app.open("ch:1");
  pressPlace(h);
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
  pressPlace(h);
  const rows = sheetRows(h);
  pending[0]!.res({ accepted: true });
  pending[1]!.rej(apiError(409, "busy"));
  await h.flush();
  assert.equal(h.app.activeTabId(), "ch:1");
  assert.equal(placeLabel(h), "場所: General");
  assert.equal(placeOf(h)!.movable, true);
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
    pressPlace(h);
    pickPlace(h, "beta");
    assert.equal(h.confirm.getAttribute("open"), "");
    assert.notEqual(h.document.activeElement, placeBtn(h));
  };
  // [やめる]
  open();
  h.document.getElementById("dlg-confirm-cancel")!.dispatch("click");
  assert.equal(h.confirm.getAttribute("open"), null);
  assert.equal(h.top.focuses.at(-1), "place");
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
  const other = h.nodes.topButtons.hand;
  other.focus();
  h.confirm.setAttribute("open", "");
  h.confirm.close();
  assert.equal(h.document.activeElement, other);
});

test("web static: v3 の場所の CSS: 帯の「場所 ∨」の規則は消えている（場所のボタンは部品の c-shell.css）", () => {
  const css = read("shell.css");
  assert.doesNotMatch(css, /\.v3-place|\.v3-bar|\.v3-views|\.v3-hand-open/);
  assert.match(read("c-shell.css"), /\.c-top-place\b/);
});
const closeListeners = (h: PlaceShell) => (h.confirm.listeners.get("close") ?? []).length;

test("web static: v3 の場所: 確認が閉じたら SA.top.focus の place を頼み、通らなければ「…」（menu）。どちらも通らなければ動かさない", async () => {
  // スマホ・compact（場所のボタンが帯に無い）: 「…」へ
  const h = await loadPlace();
  h.app.open("ch:3");
  pressPlace(h);
  pickPlace(h, "beta");
  h.top.refuse.add("place");
  const before = h.top.focuses.length;
  h.document.getElementById("dlg-confirm-cancel")!.dispatch("click");
  assert.equal(h.confirm.getAttribute("open"), null);
  assert.deepEqual(h.top.focuses.slice(before), ["place", "menu"]);
  assert.equal(h.document.activeElement, h.nodes.topButtons.menu);
  assert.equal(closeListeners(h), 0);
  // 隠れた（話題でない画面に移った。場所も「…」も無い）: 動かさない
  const g = await loadPlace();
  g.app.open("ch:3");
  placeBtn(g).focus();
  pressPlace(g);
  pickPlace(g, "beta");
  g.app.open("tasks");
  g.top.refuse.add("place");
  g.top.refuse.add("menu");
  const was = g.document.activeElement;
  g.document.getElementById("dlg-confirm-cancel")!.dispatch("click");
  assert.equal(g.confirm.getAttribute("open"), null);
  assert.equal(g.document.activeElement, was);
  assert.equal(closeListeners(g), 0);
});
test("web static: v3 の場所: シートを開いた後に話題が一覧から消えたら、行を押しても確認を開かない", async () => {
  const h = await loadPlace();
  h.api.postReply = () => Promise.resolve({ accepted: true });
  h.app.open("ch:3");
  pressPlace(h);
  h.topicList = h.topicList.filter((t) => t.id !== "ch:3");
  await h.topics.load();
  pickPlace(h, "beta");
  await h.flush();
  assert.equal(h.confirm.getAttribute("open"), null);
  assert.equal(h.api.posts.length, 0);
  assert.equal(closeListeners(h), 0);
});

test("web static: v3 の場所: close が後から届いても（本物の <dialog> の順）、[変える] は送り、閉じた直後（closed）に焦点を戻し、後の close では動かさない", async () => {
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
  pressPlace(h);
  pickPlace(h, "beta");
  h.document.getElementById("dlg-confirm-ok")!.dispatch("click");
  assert.equal(h.confirm.getAttribute("open"), null);
  assert.equal(h.api.posts.length, 1, "close の event を待たずに送る");
  // 焦点は確認の closed（閉じた直後・run の前）で戻す。close の event は聞かない
  assert.equal(h.document.activeElement, placeBtn(h));
  assert.equal(closeListeners(h), 0);
  assert.equal(later.length, 1);
  const other = h.nodes.topButtons.hand;
  other.focus();
  for (const fn of later.splice(0)) fn();
  assert.equal(h.document.activeElement, other, "後から届いた close では焦点を動かさない");
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

test("web static: 場所を変える確認のカードは、古い殻（classic.html）と新しい殻（index.html）の両方が読む chat.js・views.js にある", () => {
  for (const html of [CLASSIC_HTML, SHELL_HTML]) {
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
  p.lastTop().on.hand(p.nodes.topButtons.hand);
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
  h.lastTop().on.hand(h.nodes.topButtons.hand);
  n = h.marks.seenShown;
  h.nodes.backdrop.dispatch("click");
  assert.equal(handOf(h), "closed");
  assert.ok(h.marks.seenShown > n, "重ねた右腕を畳む");
  assert.ok(readAt(n), "畳んだ時点で下の 1 を読んでいる");
  const sh = read("shell.js");
  assert.match(fnSource(sh, "setView"), /stickOnShow = false;\n\s*\/\/[^\n]*\n\s*SA\.chat\.markSeenShown\(\);\n {2}\}$/);
  // 状態を書いた後に呼ぶ（その後は列 2 の幅を測り直す fitTop だけ）
  assert.match(fnSource(sh, "applyHand"), /SA\.chat\.markSeenShown\(\);\n\s*\/\/[^\n]*\n\s*fitTop\(\);\n {2}\}$/);
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
  // 今のスマホの殻と、流れの列（D2。H11）で同じ期待
  for (const deck of [false, true]) {
    const h = await loadHand({ phone: true, deck });
    h.app.open("ch:1");
    h.lastTop().on.hand(h.nodes.topButtons.hand);
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
  }
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

// ----- 設定の殻を行き来するリンク（M8。views.js の shellLink） -----
function settingsShellLink(v3: boolean): FakeNode {
  const { SA, views } = loadViews({ v3 });
  (SA.app as Record<string, unknown>).theme = () => "system";
  const container = new FakeNode("div");
  (views as unknown as { info: (id: string) => { render: (c: FakeNode) => void } }).info("settings").render(container);
  const links = descendants(container).filter((n) => n.tagName === "a");
  assert.equal(links.length, 1);
  // 「この画面の表示」のテーマの次の行（kv("画面", …)）
  assert.match(links[0]!.parent!.parent!.textContent, /^画面/);
  return links[0]!;
}

test("web static: 新しい殻の設定に「前の画面を開く」（/static/classic.html）があり、同じ窓で開く（M8）", () => {
  const a = settingsShellLink(true);
  assert.equal(a.textContent, "前の画面を開く");
  assert.equal(a.getAttribute("href"), "/static/classic.html");
  assert.equal(a.getAttribute("target"), null);
  assert.equal(a.getAttribute("class"), "btn btn-ghost btn-sm");
});

test("web static: 古い殻の設定に「新しい画面を開く」（/）があり、同じ窓で開く（M8）", () => {
  const a = settingsShellLink(false);
  assert.equal(a.textContent, "新しい画面を開く");
  assert.equal(a.getAttribute("href"), "/");
  assert.equal(a.getAttribute("target"), null);
  assert.equal(a.getAttribute("class"), "btn btn-ghost btn-sm");
});

test("web static: 古い殻の readingChannelIds は shownChannelIds と同じ関数", () => {
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

test("web static: GitHub のタブの [対応] は起動の確認・/start・[やめる] を持たず、話題の channelId があれば [開く] で会話を開く", () => {
  const source = read("views.js");
  const start = source.indexOf("function githubHandoffDone(");
  const end = source.indexOf("function githubItem(", start);
  assert.ok(start >= 0 && end > start);
  const body = source.slice(start, end);
  for (const word of ["起動して送る", "no_session", "startable", "やめる", "cancelCcSend", "confirm("]) assert.equal(body.includes(word), false, word);
  assert.match(body, /label: "開く"/);
  assert.match(body, /SA\.app\.open\("ch:" \+ channelId\)/);
  // 開く前に会話の一覧を読み直す（新しい殻は話題、古い殻はチャンネル）
  assert.match(body, /if \(isV3Shell\(\) && SA\.topics\) SA\.topics\.load\(\);\s+else SA\.store\.load\.channels\(\);\s+SA\.app\.open\(/);
  assert.ok(source.includes("この通知の PR・Issue の話題を作り、対応依頼（リポジトリ、番号、URL の 1 行）を最初の一言として送ります"));
  assert.ok(source.includes("この通知は対応できません。この機械に無いリポジトリか、[対応] を足す前の通知です"));
  assert.equal(source.includes("起動して送る"), false);
});

// ===== 許可のモード（H4b。#428）: 列 2 の帯のモードのボタン・板「許可のモード」・POST /api/topics/ch:<id>/mode・スマホの「…」の行 =====
const MODE_BUSY_TEXT = "担当が作業中です。終わってから変えてください";
type ModeToast = { text: string; error: boolean; retry: (() => unknown) | null };

/** 場所の殻に、プロジェクトのセッション ch:3（今のモード mode）と軽い話題 ch:2 の head を足す。トーストは level と［もう一度］の有り無しも覚える */
async function loadMode(opts: Parameters<typeof loadShell>[0] = {}, mode = "plan") {
  const h = await loadPlace(opts);
  h.chatHeads["3"] = { title: "作業", status: null, note: null, menu: [], mode };
  h.chatHeads["2"] = { title: "軽い", status: null, note: null, menu: [], mode: null };
  const toasts: ModeToast[] = [];
  h.ui.toast = (text: string, _action: unknown, o?: { level?: string; retry?: () => unknown }) =>
    void toasts.push({ text, error: !!o && o.level === "error", retry: o && typeof o.retry === "function" ? o.retry : null });
  return { h, toasts };
}
/** 見出しの state の mode（殻の中で作った物なので JSON で写して比べる） */
const modeOf = (h: PlaceShell) => JSON.parse(JSON.stringify(h.lastTop().mode ?? null)) as unknown;
/** ch:3 を「あなたの番」（待ちの種類 kind）にして一覧を読み直す */
async function markTurn(h: PlaceShell, kind: string) {
  const turn = { kind, summary: "待ち", since: "2026-11-20T00:00:00.000Z", expiresAt: null };
  h.topicList = h.topicList.map((t) => (t.id === "ch:3" ? { ...t, mark: "turn", turn } : t));
  await h.topics.load();
  h.app.refresh("ch:3");
}
/** ch:3 を作業中にして一覧を読み直す */
async function markRunning(h: PlaceShell) {
  h.topicList = h.topicList.map((t) => (t.id === "ch:3" ? { ...t, mark: "running" } : t));
  await h.topics.load();
  h.app.refresh("ch:3");
}

test("web static: v3 の許可のモード: 見出しの state はプロジェクトのセッションだけ mode を持ち、作業中は押せず理由。押すと板「許可のモード」に 3 行（今のモードは押せない）", async () => {
  const { h } = await loadMode();
  h.app.open("ch:3");
  assert.deepEqual(modeOf(h), { value: "plan", disabled: false, reason: null });
  h.lastTop().on.mode(h.nodes.topButtons.menu);
  assert.equal(h.nodes.sheet.getAttribute("aria-label"), "許可のモード");
  assert.deepEqual(
    sheetRows(h).map((r) => [r.label, r.disabled, r.why, r.icon]),
    [
      ["default（使うたびに確認）", false, null, "circle"],
      ["acceptEdits（編集は確認なし）", false, null, "circle"],
      ["plan（計画だけ）", true, "今のモード", "check"],
    ],
  );
  h.nodes.sheet.removeAttribute("open");
  // プロジェクトでない話題は mode が無く、on.mode でも板を開かない
  h.app.open("ch:2");
  assert.equal(h.lastTop().mode, null);
  h.lastTop().on.mode(h.nodes.topButtons.menu);
  assert.equal(h.nodes.sheet.getAttribute("open"), null);
  // 作業中は押せず理由
  h.app.open("ch:3");
  await markRunning(h);
  assert.deepEqual(modeOf(h), { value: "plan", disabled: true, reason: MODE_BUSY_TEXT });
  // 許可の要求・質問の待ち（あなたの番。ターンは実行中）も押せない。判断待ち・確認は押せる
  for (const [kind, disabled] of [["permission", true], ["question", true], ["waiting", false], ["confirm", false]] as const) {
    await markTurn(h, kind);
    assert.deepEqual(modeOf(h), { value: "plan", disabled, reason: disabled ? MODE_BUSY_TEXT : null }, kind);
  }
});

test("web static: v3 の許可のモード: 行を押すと POST /api/topics/ch:<id>/mode に { mode } を 1 回（: を % にしない）。成功の後は話題と会話の一覧を読み直し、広い幅ではトーストを出さない", async () => {
  const { h, toasts } = await loadMode();
  h.api.postReply = () => Promise.resolve({ result: "changed", mode: "acceptEdits" });
  h.app.open("ch:3");
  h.lastTop().on.mode(h.nodes.topButtons.menu);
  const reads = h.api.paths.length;
  const channels = h.loads.channels;
  pickPlace(h, "acceptEdits（編集は確認なし）");
  await h.flush();
  assert.deepEqual(h.api.posts, [{ path: "/api/topics/ch:3/mode", body: { mode: "acceptEdits" }, opts: { quiet: true } }]);
  assert.equal(topicReads(h, reads), 1);
  assert.equal(h.loads.channels - channels, 1);
  assert.deepEqual(toasts, []);
});

test("web static: v3 の許可のモード: 409 busy は作業中の文、closed・not_project はそれぞれの文（どれも［もう一度］なし）。ほかの失敗は［もう一度］付きで、押すと同じ値を送り直す。失敗では読み直さない", async () => {
  const { h, toasts } = await loadMode();
  h.app.open("ch:3");
  const send = async (err: Error) => {
    h.api.postReply = () => Promise.reject(err);
    h.lastTop().on.mode(h.nodes.topButtons.menu);
    pickPlace(h, "default（使うたびに確認）");
    await h.flush();
  };
  const reads = h.api.paths.length;
  const channels = h.loads.channels;
  await send(apiError(409, "busy"));
  await send(apiError(409, "closed"));
  await send(apiError(409, "not_project"));
  assert.deepEqual(
    toasts.map((t) => [t.text, t.error, t.retry !== null]),
    [
      [MODE_BUSY_TEXT, true, false],
      ["閉じています", true, false],
      ["このセッションに許可のモードはありません。", true, false],
    ],
  );
  toasts.length = 0;
  await send(Object.assign(apiError(500, "internal"), { toast: "サーバーの処理に失敗しました" }));
  await send(apiError(0, null));
  assert.deepEqual(
    toasts.map((t) => [t.text, t.error, t.retry !== null]),
    [
      ["サーバーの処理に失敗しました", true, true],
      ["サーバーにつながりません", true, true],
    ],
  );
  assert.equal(topicReads(h, reads), 0);
  assert.equal(h.loads.channels, channels);
  // ［もう一度］は同じ話題に同じ値を送る
  h.api.postReply = () => Promise.resolve({ result: "changed", mode: "default" });
  const before = h.api.posts.length;
  toasts[0]!.retry!();
  await h.flush();
  assert.deepEqual(h.api.posts.slice(before), [{ path: "/api/topics/ch:3/mode", body: { mode: "default" }, opts: { quiet: true } }]);
});

test("web static: v3 の許可のモード: スマホの「…」の板に「許可のモードを変える」（作業中は押せず理由）。プロジェクトでない話題には無い。スマホで変えたらトースト", async () => {
  const { h, toasts } = await loadMode({ phone: true });
  const menu = () => h.lastTop().on.menu(h.nodes.topButtons.menu);
  h.app.open("ch:3");
  // スマホでも state の mode は在る（帯に出さないのは部品が決める）
  assert.deepEqual(modeOf(h), { value: "plan", disabled: false, reason: null });
  menu();
  const row = sheetRows(h).find((r) => r.label === "許可のモードを変える");
  assert.deepEqual(row, { label: "許可のモードを変える", why: null, disabled: false, icon: "settings" });
  // 押すと板「許可のモード」へ。変えたらトースト（帯に見えないため）
  pickPlace(h, "許可のモードを変える");
  assert.equal(h.nodes.sheet.getAttribute("aria-label"), "許可のモード");
  h.api.postReply = () => Promise.resolve({ result: "changed", mode: "default" });
  pickPlace(h, "default（使うたびに確認）");
  await h.flush();
  assert.deepEqual(toasts.map((t) => [t.text, t.error]), [["許可のモードを default にしました", false]]);
  h.nodes.sheet.removeAttribute("open");
  // 作業中は押せない行で理由
  await markRunning(h);
  menu();
  assert.deepEqual(sheetRows(h).find((r) => r.label === "許可のモードを変える"), { label: "許可のモードを変える", why: MODE_BUSY_TEXT, disabled: true, icon: "settings" });
  h.nodes.sheet.removeAttribute("open");
  // 許可の要求の待ちも押せない行
  await markTurn(h, "permission");
  menu();
  assert.equal(sheetRows(h).find((r) => r.label === "許可のモードを変える")?.disabled, true);
  h.nodes.sheet.removeAttribute("open");
  // プロジェクトでない話題には無い
  h.app.open("ch:2");
  menu();
  assert.equal(sheetRows(h).some((r) => r.label === "許可のモードを変える"), false);
});

// ===== 端末のセッションの札（docs/plan/terminal-handover.md の H3。shell.js の分岐と takeover.js のつなぎ） =====
const termTopic = (sessionId: string, o: Record<string, unknown> = {}) => v3Topic("cc:" + sessionId, { origin: "cc", sessionId, title: "端末の題", ...o });

async function loadTermShell(opts: Parameters<typeof loadShell>[0] = {}, topics: unknown[] = [termTopic("s1")]) {
  const h = loadShell({ takeover: {}, ...opts });
  h.api.reply = () => Promise.resolve(v3Result(topics));
  await h.flush();
  await h.topics.load();
  return h;
}

test("web static: 新しい殻は端末の行を開くと札を出し、列 2 のタブは term:<sessionId> になる", async () => {
  const h = await loadTermShell();
  h.app.open("cc:s1");
  assert.equal(h.app.activeTabId(), "term:s1");
  // cc: で始まらないので、画面の写しの polling（api.js の activeCcSession）は回らない
  assert.equal(h.app.activeTabId()!.startsWith("cc:"), false);
  assert.deepEqual(h.term.renders.map((r) => r.sessionId), ["s1"]);
  assert.ok(h.nodes.ed.querySelector("[data-term]"), "札の根");
  assert.equal(h.rendered.some((r) => r.tab === "cc:s1"), false, "［端末］のタブを描かない");
  // 一覧の選んでいる行は話題のまま
  assert.equal(h.rowOf("cc:s1")!.current, true);
});

test("web static: 新しい殻は札を出すとき画面の写しの読み込み（views.js の onOpen）を呼ばず、札の open を呼ぶ", async () => {
  const h = await loadTermShell();
  h.app.open("cc:s1");
  assert.deepEqual(h.opens, []);
  assert.deepEqual(h.term.opens, ["s1"]);
});

test("web static: 新しい殻の札の hash は #/cc/<id> のままで、その hash から開いても札", async () => {
  const h = await loadTermShell();
  h.app.open("cc:s1");
  assert.equal(h.location.hash, "#/cc/s1");
  const g = loadShell({ takeover: {}, hash: "#/cc/s1" });
  g.api.reply = () => Promise.resolve(v3Result([termTopic("s1")]));
  await g.flush();
  assert.equal(g.app.activeTabId(), "term:s1");
  assert.deepEqual(g.term.opens, ["s1"]);
  assert.deepEqual(g.opens, []);
});

test("web static: 新しい殻の札の『端末を見る』で今の［端末］のタブ（cc:<sessionId>）になり、onOpen を呼ぶ", async () => {
  const h = await loadTermShell();
  h.app.open("cc:s1");
  h.term.renders.at(-1)!.ctx.pane();
  assert.equal(h.app.activeTabId(), "cc:s1");
  assert.equal(h.rendered.at(-1)!.tab, "cc:s1");
  assert.deepEqual(h.opens, ["cc:s1"]);
  assert.deepEqual(h.term.closes, ["s1"]);
  assert.equal(h.location.hash, "#/cc/s1");
});

test("web static: 新しい殻で同じ行をもう一度開くと札に戻る", async () => {
  const h = await loadTermShell();
  h.app.open("cc:s1");
  h.term.renders.at(-1)!.ctx.pane();
  const before = h.term.renders.length;
  h.app.open("cc:s1");
  assert.equal(h.app.activeTabId(), "term:s1");
  assert.equal(h.term.renders.length, before + 1);
  assert.deepEqual(h.term.opens, ["s1", "s1"]);
  assert.ok(h.nodes.ed.querySelector("[data-term]"));
});

test("web static: 新しい殻はほかの話題へ移るとき札の close を呼ぶ", async () => {
  const h = await loadTermShell({}, [termTopic("s1"), v3Topic("ch:a")]);
  h.app.open("cc:s1");
  assert.deepEqual(h.term.closes, []);
  h.app.open("ch:a");
  assert.deepEqual(h.term.closes, ["s1"]);
  assert.equal(h.app.activeTabId(), "ch:a");
});

test("web static: 新しい殻は一覧を読み直すたびに、出ている札を新しい行で描き直す（ほかのタブは描き直さない）", async () => {
  const topics: unknown[] = [termTopic("s1"), v3Topic("ch:a")];
  const h = await loadTermShell({}, topics);
  h.app.open("cc:s1");
  const before = h.term.renders.length;
  topics[0] = termTopic("s1", { mark: "running" });
  await h.topics.load();
  assert.equal(h.term.renders.length, before + 1);
  assert.equal((h.term.renders.at(-1)!.ctx.row as { mark?: string }).mark, "running");
  // 会話のタブは一覧を読み直しても描き直さない
  h.app.open("ch:a");
  const rendered = h.rendered.length;
  const renders = h.term.renders.length;
  await h.topics.load();
  assert.equal(h.rendered.length, rendered);
  assert.equal(h.term.renders.length, renders);
});

test("web static: 新しい殻は札の入口か口が無ければ今の［端末］のタブを出す", async () => {
  for (const takeover of [undefined, { noEntry: true }, { noMouth: true }]) {
    const h = await loadTermShell({ takeover });
    h.app.open("cc:s1");
    const label = JSON.stringify(takeover ?? null);
    assert.equal(h.app.activeTabId(), "cc:s1", label);
    assert.equal(h.rendered.at(-1)!.tab, "cc:s1", label);
    assert.deepEqual(h.opens, ["cc:s1"], label);
    assert.deepEqual(h.term.renders, [], label);
    assert.deepEqual(h.term.opens, [], label);
  }
});

test("web static: 新しい殻は札を描けなければ今の［端末］のタブに戻し、次からも札を試さない", async () => {
  const h = await loadTermShell({ takeover: { draw: () => false } }, [termTopic("s1"), termTopic("s2")]);
  h.app.open("cc:s1");
  assert.equal(h.app.activeTabId(), "cc:s1");
  assert.equal(h.rendered.at(-1)!.tab, "cc:s1");
  assert.deepEqual(h.term.closes, ["s1"]);
  assert.deepEqual(h.opens, ["cc:s1"], "画面の写しを読む");
  assert.deepEqual(h.term.opens, []);
  // 見出しは戻したタブの名前で描き直す
  assert.equal(h.lastTop().title, "端末の題");
  // 次の端末の行も札を試さない
  h.app.open("cc:s2");
  assert.equal(h.term.renders.length, 1);
  assert.equal(h.app.activeTabId(), "cc:s2");
  assert.equal(h.rendered.at(-1)!.tab, "cc:s2");
});

test("web static: 新しい殻の札には、同じセッションの一覧の行（cc: の行、無ければ Claude Code のチャンネルの行）と場所の文字を渡す", async () => {
  const h = await loadTermShell({}, [
    termTopic("s1", { group: "p:proj", place: { dir: "proj" } }),
    v3Topic("ch:c", { origin: "cc", sessionId: "s2", title: "チャンネル", place: { dir: "other" } }),
  ]);
  h.app.open("cc:s1");
  let ctx = h.term.renders.at(-1)!.ctx;
  assert.equal(ctx.row!.id, "cc:s1");
  assert.equal(ctx.place, "proj");
  h.app.open("cc:s2");
  ctx = h.term.renders.at(-1)!.ctx;
  assert.equal(ctx.row!.id, "ch:c");
  assert.equal(ctx.place, "other");
  h.app.open("cc:s3");
  ctx = h.term.renders.at(-1)!.ctx;
  assert.equal(ctx.row, null);
  assert.equal(ctx.place, null);
});

type TermRaw = {
  title: string;
  place: string | null;
  rowState: string | null;
  activity: string | null;
  pane: boolean;
  check: { takeable: boolean; state: string; reason: unknown; text: unknown; rcUrl: string | null } | null;
  checking: boolean;
  failed: boolean;
  phase: string;
  error: string | null;
  on: { take: () => void; pane: () => void; recheck: () => void };
};
type ConfirmOpts = { title: string; target: string; body: string; ok: string; danger: boolean; run: () => void; closed: () => void };
type Deferred = { promise: Promise<unknown>; resolve: (v: unknown) => void; reject: (e: unknown) => void };
const deferred = (): Deferred => {
  let resolve!: (v: unknown) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<unknown>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
};
/** api.js の失敗の形（status・code・data・toast） */
const takeError = (status: number, data: Record<string, unknown> | null = null) =>
  Object.assign(new Error(String(status)), {
    status,
    code: data && typeof data.error === "string" ? data.error : null,
    data,
    toast: status === 0 ? "サーバーにつながりません" : "操作に失敗しました。もう一度試してください",
  });
const takeCheck = (o: Record<string, unknown> = {}) => ({
  takeable: true,
  state: "idle",
  reason: null,
  text: null,
  title: "判定の題",
  project: "proj",
  activityAt: "2026-11-20T01:00:00.000Z",
  rcUrl: null,
  last: null,
  ...o,
});

/**
 * takeover.js を作り物の SA（ui・api・app・topics・term）と作り物のタイマーで読む。app.refresh は、出している札（active）なら最後の ctx で描き直す（shell.js と同じ）。
 * get は gets に積んで getReply の答え、post は posts に積んで postReply の答え
 */
function loadTakeover() {
  const state = { now: 0, active: "term:s1" as string | null };
  let seq = 0;
  const timers = new Map<number, { at: number; fn: () => void }>();
  const draws: TermRaw[] = [];
  const confirms: ConfirmOpts[] = [];
  const toasts: Array<{ text: string; level: string | null }> = [];
  const refreshes: string[] = [];
  const opened: string[] = [];
  const gets: string[] = [];
  const posts: string[] = [];
  const counts = { topicLoads: 0, drops: 0 };
  const api = {
    getReply: (_path: string): Promise<unknown> => Promise.resolve(takeCheck()),
    postReply: (_path: string): Promise<unknown> => Promise.resolve({}),
  };
  const el = (tag: string, props: Record<string, string> = {}, children: DomNode[] = []) => {
    const n = new DomNode(tag);
    for (const [k, v] of Object.entries(props)) if (k === "class") n.setAttribute("class", v);
    else n.setAttribute(k, v);
    for (const c of children) n.append(c);
    return n;
  };
  const ed = new DomNode("div");
  let lastCtx: { sessionId: string; ctx: unknown } | null = null;
  const SA: Record<string, unknown> = {
    ui: {
      el,
      confirm: (o: ConfirmOpts) => void confirms.push(o),
      toast: (text: string, _action: unknown, opts?: { level?: string }) => void toasts.push({ text, level: opts?.level ?? null }),
      dateTime: (v: string) => "dt:" + v,
    },
    api: {
      get: (path: string) => {
        gets.push(path);
        return api.getReply(path);
      },
      post: (path: string) => {
        posts.push(path);
        return api.postReply(path);
      },
    },
    app: {
      refresh: (id: string) => {
        refreshes.push(id);
        if (lastCtx && id === state.active && id === "term:" + lastCtx.sessionId) takeover().render(ed, lastCtx.sessionId, lastCtx.ctx);
      },
      activeTabId: () => state.active,
      open: (id: string) => void opened.push(id),
    },
    topics: {
      load: () => {
        counts.topicLoads++;
      },
    },
    term: {
      draw: (_root: unknown, raw: TermRaw) => {
        draws.push(raw);
        return true;
      },
      drop: () => {
        counts.drops++;
      },
    },
  };
  const context = {
    window: { SA },
    console,
    queueMicrotask,
    setTimeout: (fn: () => void, ms: number) => {
      timers.set(++seq, { at: state.now + ms, fn });
      return seq;
    },
    clearTimeout: (id: number) => void timers.delete(id),
  };
  vm.runInNewContext(read("takeover.js"), context);
  const takeover = () => SA.takeover as { render: (ed: unknown, sessionId: string, ctx: unknown) => boolean; open: (sessionId: string) => void; close: (sessionId: string) => void };
  /** 札を描く（ctx は覚えて、refresh の描き直しに使う） */
  const render = (sessionId = "s1", ctx: Record<string, unknown> = { row: termTopic(sessionId), place: "proj", pane: () => undefined }) => {
    lastCtx = { sessionId, ctx };
    return takeover().render(ed, sessionId, ctx);
  };
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
  const raw = (): TermRaw => {
    const r = draws.at(-1);
    assert.ok(r, "SA.term.draw が呼ばれていない");
    return r;
  };
  /** 開いて最初の判定を読み終えた形にする */
  const opened1 = async (sessionId = "s1") => {
    render(sessionId);
    takeover().open(sessionId);
    await flush();
  };
  return { state, api, ed, draws, confirms, toasts, refreshes, opened, gets, posts, counts, timers, takeover, render, advance, flush, raw, opened1 };
}

test("web static: 取り込みの札は開いたら判定を 1 回読み、読んでいる間は確かめている形を渡す", async () => {
  const t = loadTakeover();
  const d = deferred();
  t.api.getReply = () => d.promise;
  assert.equal(t.render(), true);
  assert.ok(t.ed.querySelector(".ed-scroll"), "入れ物");
  assert.ok(t.ed.querySelector("[data-term]"), "札の根");
  t.takeover().open("s1");
  assert.deepEqual(t.gets, ["/api/cc/sessions/s1/takeover"]);
  assert.equal(t.raw().checking, true);
  assert.equal(t.raw().check, null);
  // 読んでいる間にもう一度開いても読まない
  t.takeover().open("s1");
  assert.equal(t.gets.length, 1);
  d.resolve(takeCheck());
  await t.flush();
  assert.equal(t.raw().checking, false);
  assert.deepEqual(JSON.parse(JSON.stringify(t.raw().check)), { takeable: true, state: "idle", reason: null, text: null, rcUrl: null });
  // 題は一覧の行、場所は ctx、時刻は一覧の行が無ければ判定の物
  assert.equal(t.raw().title, "端末の題");
  assert.equal(t.raw().place, "proj");
  assert.equal(t.raw().activity, "dt:2026-11-20T01:00:00.000Z");
  assert.equal(t.raw().rowState, "idle");
  assert.equal(t.raw().pane, true);
  assert.equal(t.gets.length, 1);
});

test("web static: 取り込みの札は一覧の行の状態が変わったら判定を読み直し、同じなら読まない", async () => {
  const t = loadTakeover();
  await t.opened1();
  assert.equal(t.gets.length, 1);
  t.render();
  t.render();
  assert.equal(t.gets.length, 1, "同じ状態では読まない");
  t.render("s1", { row: termTopic("s1", { mark: "running" }), place: null, pane: () => undefined });
  assert.equal(t.gets.length, 2);
  assert.equal(t.raw().checking, true, "読み直しの間は確かめている形");
  assert.equal(t.raw().rowState, "running");
  await t.flush();
  t.render("s1", { row: termTopic("s1", { mark: "running" }), place: null, pane: () => undefined });
  assert.equal(t.gets.length, 2);
  t.render("s1", { row: termTopic("s1", { mark: "turn" }), place: null, pane: () => undefined });
  assert.equal(t.gets.length, 3);
  assert.equal(t.raw().rowState, "waiting");
});

test("web static: 取り込みの札は時間では判定を読まない", async () => {
  const t = loadTakeover();
  await t.opened1();
  assert.equal(t.gets.length, 1);
  t.advance(60_000);
  await t.flush();
  t.advance(600_000);
  await t.flush();
  assert.equal(t.gets.length, 1);
  assert.equal(t.timers.size, 0);
});

test("web static: 取り込みの札は画面の写しの API を呼ばない", async () => {
  const t = loadTakeover();
  await t.opened1();
  t.api.postReply = (path) => Promise.resolve(path.endsWith("/confirm") ? { ok: true, id: "ch:9" } : { id: 7, text: "本文" });
  t.raw().on.take();
  await t.flush();
  t.confirms[0]!.closed();
  t.confirms[0]!.run();
  await t.flush();
  t.render();
  t.takeover().open("s1");
  t.raw().on.recheck();
  await t.flush();
  for (const path of [...t.gets, ...t.posts]) assert.match(path, /^\/api\/cc\/(sessions\/[^/]+\/takeover|takeovers\/\d+\/(confirm|cancel))$/, path);
  assert.equal([...t.gets, ...t.posts].some((p) => /^\/api\/cc\/sessions\/[^/]+$/.test(p)), false);
});

test("web static: 取り込みの札の［取り込む］は確認を作り、確認は danger で本文はサーバーの文・対象は題", async () => {
  const t = loadTakeover();
  await t.opened1();
  const d = deferred();
  t.api.postReply = () => d.promise;
  t.raw().on.take();
  assert.deepEqual(t.posts, ["/api/cc/sessions/s1/takeover"]);
  assert.equal(t.raw().phase, "proposing");
  d.resolve({ id: 7, text: "「端末の題」を取り込みます。" });
  await t.flush();
  assert.equal(t.raw().phase, "asking");
  assert.equal(t.confirms.length, 1);
  const c = t.confirms[0]!;
  assert.equal(c.title, "取り込みますか");
  assert.equal(c.ok, "取り込む");
  assert.equal(c.danger, true);
  assert.equal(c.body, "「端末の題」を取り込みます。");
  assert.equal(c.target, "端末の題");
});

test("web static: 取り込みの確認でやめたら /cancel だけを送る", async () => {
  const t = loadTakeover();
  await t.opened1();
  t.api.postReply = () => Promise.resolve({ id: 7, text: "本文" });
  t.raw().on.take();
  await t.flush();
  t.confirms[0]!.closed();
  await t.flush();
  assert.deepEqual(t.posts, ["/api/cc/sessions/s1/takeover", "/api/cc/takeovers/7/cancel"]);
  assert.equal(t.raw().phase, "idle");
  assert.deepEqual(t.toasts, []);
  // cancel が失敗しても知らせない
  t.api.postReply = (path) => (path.endsWith("/cancel") ? Promise.reject(takeError(500)) : Promise.resolve({ id: 8, text: "本文" }));
  t.raw().on.take();
  await t.flush();
  t.confirms[1]!.closed();
  await t.flush();
  assert.deepEqual(t.toasts, []);
  assert.equal(t.raw().error, null);
});

test("web static: 取り込みの確認で進めたら /confirm だけを送る（closed が run より先でも /cancel を送らない）", async () => {
  const t = loadTakeover();
  await t.opened1();
  const d = deferred();
  t.api.postReply = (path) => (path.endsWith("/confirm") ? d.promise : Promise.resolve({ id: 7, text: "本文" }));
  t.raw().on.take();
  await t.flush();
  // ui.js と同じく closed → run の順
  t.confirms[0]!.closed();
  t.confirms[0]!.run();
  await t.flush();
  assert.deepEqual(t.posts, ["/api/cc/sessions/s1/takeover", "/api/cc/takeovers/7/confirm"]);
  assert.equal(t.raw().phase, "taking");
});

test("web static: 取り込みの途中・確認の間は［取り込む］をもう一度押しても 2 つ目を送らない", async () => {
  const t = loadTakeover();
  await t.opened1();
  const propose = deferred();
  const confirm = deferred();
  t.api.postReply = (path) => (path.endsWith("/confirm") ? confirm.promise : propose.promise);
  t.raw().on.take();
  t.raw().on.take();
  assert.equal(t.posts.length, 1, "確認を作っている間");
  propose.resolve({ id: 7, text: "本文" });
  await t.flush();
  t.raw().on.take();
  assert.equal(t.posts.length, 1, "確認の間");
  assert.equal(t.confirms.length, 1);
  t.confirms[0]!.closed();
  t.confirms[0]!.run();
  await t.flush();
  t.raw().on.take();
  assert.deepEqual(t.posts, ["/api/cc/sessions/s1/takeover", "/api/cc/takeovers/7/confirm"], "進めている間");
});

test("web static: 取り込みが済んだら知らせを出し、一覧を読み直して新しい話題を開く", async () => {
  const t = loadTakeover();
  await t.opened1();
  t.api.postReply = (path) => Promise.resolve(path.endsWith("/confirm") ? { ok: true, id: "ch:9", text: "済" } : { id: 7, text: "本文" });
  t.raw().on.take();
  await t.flush();
  t.confirms[0]!.closed();
  t.confirms[0]!.run();
  await t.flush();
  assert.deepEqual(t.toasts, [{ text: "「端末の題」を取り込みました", level: null }]);
  assert.equal(t.counts.topicLoads, 1);
  assert.deepEqual(t.opened, ["ch:9"]);
  assert.equal(t.counts.drops, 1, "札の根を外す");
});

test("web static: 取り込みが済んだとき別の話題を見ていたら、知らせだけ出して移らない", async () => {
  const t = loadTakeover();
  await t.opened1();
  t.api.postReply = (path) => Promise.resolve(path.endsWith("/confirm") ? { ok: true, id: "ch:9" } : { id: 7, text: "本文" });
  t.raw().on.take();
  await t.flush();
  t.confirms[0]!.closed();
  t.confirms[0]!.run();
  t.state.active = "ch:other";
  await t.flush();
  assert.deepEqual(t.toasts.map((x) => x.text), ["「端末の題」を取り込みました"]);
  assert.equal(t.counts.topicLoads, 1);
  assert.deepEqual(t.opened, []);
});

test("web static: 取り込みを断られたら文を札に出して判定を読み直す（/setup 前は決めた文）", async () => {
  for (const [data, want] of [
    [{ error: "in_progress", text: "取り込みはもう進んでいます。" }, "取り込みはもう進んでいます。"],
    [{ error: "not_set_up" }, "先に Discord で /setup を実行してください"],
    [null, "操作に失敗しました。もう一度試してください"],
  ] as const) {
    const t = loadTakeover();
    await t.opened1();
    const check = deferred();
    t.api.getReply = () => check.promise;
    t.api.postReply = () => Promise.reject(takeError(data === null ? 500 : 409, data));
    t.raw().on.take();
    await t.flush();
    assert.equal(t.raw().phase, "idle", want);
    assert.equal(t.raw().error, want);
    assert.equal(t.gets.length, 2, "判定を読み直す");
    assert.equal(t.raw().checking, true);
    // 断られた直後の読み直しが読めても文は残す（すぐ消えると読めない）
    check.resolve(takeCheck());
    await t.flush();
    assert.equal(t.raw().checking, false);
    assert.equal(t.raw().error, want);
    // その次に判定が読めたら文は消す（部品の契約）
    t.api.getReply = () => Promise.resolve(takeCheck());
    t.raw().on.recheck();
    await t.flush();
    assert.equal(t.gets.length, 3);
    assert.equal(t.raw().error, null);
  }
  // 切れたときは読み直さず、例外の文
  const t = loadTakeover();
  await t.opened1();
  t.api.postReply = () => Promise.reject(takeError(0));
  t.raw().on.take();
  await t.flush();
  assert.equal(t.raw().error, "サーバーにつながりません");
  assert.equal(t.gets.length, 1);
  // 押し直したら文を消す
  t.api.postReply = () => new Promise(() => undefined);
  t.raw().on.take();
  assert.equal(t.raw().error, null);
});

test("web static: 使えない確認（stale）は知らせを出して判定を読み直す", async () => {
  const t = loadTakeover();
  await t.opened1();
  t.api.postReply = (path) => (path.endsWith("/confirm") ? Promise.reject(takeError(409, { error: "stale", text: "この確認はもう使えません。" })) : Promise.resolve({ id: 7, text: "本文" }));
  t.raw().on.take();
  await t.flush();
  t.confirms[0]!.closed();
  t.confirms[0]!.run();
  await t.flush();
  assert.deepEqual(t.toasts, [{ text: "この確認はもう使えません。", level: "error" }]);
  assert.equal(t.raw().phase, "idle");
  assert.equal(t.gets.length, 2);
  // ほかの 409 は札の文
  const u = loadTakeover();
  await u.opened1();
  const check = deferred();
  u.api.postReply = (path) => (path.endsWith("/confirm") ? Promise.reject(takeError(409, { error: "expired", text: "確認の時間が過ぎました。" })) : Promise.resolve({ id: 7, text: "本文" }));
  u.raw().on.take();
  await u.flush();
  u.api.getReply = () => check.promise;
  u.confirms[0]!.closed();
  u.confirms[0]!.run();
  await u.flush();
  assert.deepEqual(u.toasts, []);
  assert.equal(u.raw().error, "確認の時間が過ぎました。");
  assert.equal(u.raw().phase, "idle");
  assert.equal(u.gets.length, 2);
});

/** 確認で進めて、応答が切れた形にする */
async function lostTakeover() {
  const t = loadTakeover();
  await t.opened1();
  t.api.postReply = (path) => (path.endsWith("/confirm") ? Promise.reject(takeError(0)) : Promise.resolve({ id: 7, text: "本文" }));
  t.raw().on.take();
  await t.flush();
  t.confirms[0]!.closed();
  t.confirms[0]!.run();
  await t.flush();
  return t;
}

test("web static: 取り込みの応答が切れたら結果が分からない形にして、1.5 秒・5 秒・15 秒で読み直す", async () => {
  const t = await lostTakeover();
  assert.equal(t.raw().phase, "lost");
  assert.equal(t.gets.length, 1);
  t.api.getReply = () => Promise.resolve(takeCheck({ takeable: false, state: "running", last: { takeover: 7, state: "running", id: null } }));
  t.advance(1499);
  await t.flush();
  assert.equal(t.gets.length, 1);
  t.advance(1);
  await t.flush();
  assert.equal(t.gets.length, 2);
  t.advance(3500);
  await t.flush();
  assert.equal(t.gets.length, 3);
  t.advance(10_000);
  await t.flush();
  assert.equal(t.gets.length, 4);
  t.advance(600_000);
  await t.flush();
  assert.equal(t.gets.length, 4, "3 回の後は読まない");
  assert.equal(t.raw().phase, "lost");
  // 5xx も同じ
  const u = loadTakeover();
  await u.opened1();
  u.api.postReply = (path) => (path.endsWith("/confirm") ? Promise.reject(takeError(502)) : Promise.resolve({ id: 7, text: "本文" }));
  u.raw().on.take();
  await u.flush();
  u.confirms[0]!.closed();
  u.confirms[0]!.run();
  await u.flush();
  assert.equal(u.raw().phase, "lost");
  assert.equal(u.timers.size, 3);
});

test("web static: 読み直しで済んでいたら新しい話題を開き、失敗・始まっていないは決めた文、実行中は分からない形のまま", async () => {
  const cases: Array<[Record<string, unknown>, string, string | null]> = [
    [{ takeover: 7, state: "failed", id: null }, "idle", "取り込めませんでした。"],
    [{ takeover: 7, state: "awaiting_confirm", id: null }, "idle", "取り込みは始まっていません。もう一度試せます。"],
    [{ takeover: 7, state: "cancelled", id: null }, "idle", "取り込みは始まっていません。もう一度試せます。"],
    [{ takeover: 7, state: "running", id: null }, "lost", null],
  ];
  for (const [last, phase, error] of cases) {
    const t = await lostTakeover();
    t.api.getReply = () => Promise.resolve(takeCheck({ last }));
    t.raw().on.recheck();
    await t.flush();
    assert.equal(t.raw().phase, phase, String(last.state));
    assert.equal(t.raw().error, error, String(last.state));
    assert.equal(t.timers.size, phase === "lost" ? 3 : 0, String(last.state));
  }
  const t = await lostTakeover();
  t.api.getReply = () => Promise.resolve(takeCheck({ last: { takeover: 7, state: "done", id: "ch:9" } }));
  t.advance(1500);
  await t.flush();
  assert.deepEqual(t.opened, ["ch:9"]);
  assert.deepEqual(t.toasts.map((x) => x.text), ["「端末の題」を取り込みました"]);
  assert.equal(t.timers.size, 0);
});

test("web static: 読み直しの last の番号が違えば分からない形のまま", async () => {
  const t = await lostTakeover();
  for (const last of [{ takeover: 6, state: "done", id: "ch:9" }, { takeover: 6, state: "failed", id: null }, null]) {
    t.api.getReply = () => Promise.resolve(takeCheck({ last }));
    t.raw().on.recheck();
    await t.flush();
    assert.equal(t.raw().phase, "lost");
  }
  // 判定を読めなかったときも
  t.api.getReply = () => Promise.reject(takeError(500));
  t.raw().on.recheck();
  await t.flush();
  assert.equal(t.raw().phase, "lost");
  assert.deepEqual(t.opened, []);
});

test("web static: 取り込みの札は rcUrl が https://claude.ai/code/ で始まるときだけ渡す", async () => {
  for (const [rcUrl, want] of [
    ["https://claude.ai/code/session_x", "https://claude.ai/code/session_x"],
    ["http://claude.ai/code/session_x", null],
    ["https://example.com/https://claude.ai/code/", null],
    ["javascript:alert(1)", null],
    [null, null],
    [42, null],
  ] as const) {
    const t = loadTakeover();
    t.api.getReply = () => Promise.resolve(takeCheck({ rcUrl }));
    await t.opened1();
    assert.equal(t.raw().check!.rcUrl, want, String(rcUrl));
  }
});

test("web static: 取り込みの途中に札を閉じても応答を受け、済んだ知らせを出す", async () => {
  const t = loadTakeover();
  await t.opened1();
  const d = deferred();
  t.api.postReply = (path) => (path.endsWith("/confirm") ? d.promise : Promise.resolve({ id: 7, text: "本文" }));
  t.raw().on.take();
  await t.flush();
  t.confirms[0]!.closed();
  t.confirms[0]!.run();
  await t.flush();
  t.state.active = "ch:other";
  t.takeover().close("s1");
  assert.equal(t.counts.drops, 1);
  d.resolve({ ok: true, id: "ch:9" });
  await t.flush();
  assert.deepEqual(t.toasts.map((x) => x.text), ["「端末の題」を取り込みました"]);
  assert.equal(t.counts.topicLoads, 1);
  assert.deepEqual(t.opened, []);
});

test("web static: 取り込みの札は古い判定の応答を捨てる（後から読んだ方だけを使う）", async () => {
  // 結果が分からない間の 1.5 秒の読み直しが返らないうちに、5 秒の読み直しが始まって先に返る
  const t = await lostTakeover();
  const slow = deferred();
  const fast = deferred();
  t.api.getReply = () => slow.promise;
  t.advance(1500);
  t.api.getReply = () => fast.promise;
  t.advance(3500);
  assert.equal(t.gets.length, 3);
  fast.resolve(takeCheck({ takeable: false, state: "running", last: { takeover: 7, state: "running", id: null } }));
  await t.flush();
  assert.equal(t.raw().check!.state, "running");
  assert.equal(t.raw().checking, false);
  const drawn = t.draws.length;
  // 遅れて返った古い応答（済んだ、と言う）では描かない・書き換えない・話題を開かない
  slow.resolve(takeCheck({ takeable: false, state: "ended", last: { takeover: 7, state: "done", id: "ch:9" } }));
  await t.flush();
  assert.equal(t.draws.length, drawn);
  assert.equal(t.raw().phase, "lost");
  assert.deepEqual(t.opened, []);
  assert.deepEqual(t.toasts, []);
});

test("web static: 取り込みを進めた後に別の話題を見ている間に断られたら、知らせを出し、札に戻っても文が残る", async () => {
  const t = loadTakeover();
  await t.opened1();
  const d = deferred();
  t.api.postReply = (path) => (path.endsWith("/confirm") ? d.promise : Promise.resolve({ id: 7, text: "本文" }));
  t.raw().on.take();
  await t.flush();
  t.confirms[0]!.closed();
  t.confirms[0]!.run();
  await t.flush();
  t.state.active = "ch:other";
  t.takeover().close("s1");
  d.reject(takeError(409, { error: "not_exited", text: "端末の Claude Code が終わりませんでした。" }));
  await t.flush();
  assert.deepEqual(t.toasts, [{ text: "「端末の題」: 端末の Claude Code が終わりませんでした。", level: "error" }]);
  // 札に戻る: 開いたときの読み直しが読めても文は残る
  t.state.active = "term:s1";
  t.render();
  t.takeover().open("s1");
  await t.flush();
  assert.equal(t.raw().phase, "idle");
  assert.equal(t.raw().checking, false);
  assert.equal(t.raw().error, "端末の Claude Code が終わりませんでした。");
  // その次に判定が読めたら消す
  t.raw().on.recheck();
  await t.flush();
  assert.equal(t.raw().error, null);
  assert.equal(t.toasts.length, 1);
});

test("web static: 札を出している間に断られたときは知らせを出さない（文は札に出る）", async () => {
  const t = loadTakeover();
  await t.opened1();
  t.api.postReply = (path) => (path.endsWith("/confirm") ? Promise.reject(takeError(409, { error: "not_exited", text: "終わりませんでした。" })) : Promise.resolve({ id: 7, text: "本文" }));
  t.raw().on.take();
  await t.flush();
  t.confirms[0]!.closed();
  t.confirms[0]!.run();
  await t.flush();
  assert.deepEqual(t.toasts, []);
  assert.equal(t.raw().error, "終わりませんでした。");
});

test("web static: 札を閉じても結果が分からない間の読み直しは止めず、別の話題を見ている間に失敗が分かったら知らせを出す", async () => {
  for (const [state, want] of [
    ["failed", "「端末の題」: 取り込めませんでした。"],
    ["cancelled", "「端末の題」: 取り込みは始まっていません。もう一度試せます。"],
  ] as const) {
    const t = await lostTakeover();
    t.state.active = "ch:other";
    t.takeover().close("s1");
    assert.equal(t.timers.size, 3, "閉じてもタイマーは残す");
    t.api.getReply = () => Promise.resolve(takeCheck({ takeable: false, state: "ended", last: { takeover: 7, state, id: null } }));
    t.advance(1500);
    await t.flush();
    assert.equal(t.gets.length, 2);
    assert.deepEqual(t.toasts, [{ text: want, level: "error" }], state);
    assert.equal(t.timers.size, 0);
    // 札に戻ると文が残っている
    t.state.active = "term:s1";
    t.render();
    t.takeover().open("s1");
    await t.flush();
    assert.equal(t.raw().phase, "idle");
    assert.equal(t.raw().error, want.slice("「端末の題」: ".length), state);
  }
});

test("web static: 結果が分からない間に、後から別の取り込みが作られていたら分からない形を解く（文は出さない）", async () => {
  const t = await lostTakeover();
  t.api.getReply = () => Promise.resolve(takeCheck({ takeable: false, state: "idle", last: { takeover: 8, state: "awaiting_confirm", id: null } }));
  t.raw().on.recheck();
  await t.flush();
  assert.equal(t.raw().phase, "idle");
  assert.equal(t.raw().error, null);
  assert.equal(t.timers.size, 0);
  assert.deepEqual(t.toasts, []);
  assert.deepEqual(t.opened, []);
});

test("web static: 読み直しで済んでいたのに行き先が返らなければ、知らせと一覧の読み直しだけして分からない形を解く", async () => {
  const t = await lostTakeover();
  t.api.getReply = () => Promise.resolve(takeCheck({ takeable: false, state: "ended", last: { takeover: 7, state: "done", id: null } }));
  t.raw().on.recheck();
  await t.flush();
  assert.equal(t.raw().phase, "idle");
  assert.equal(t.raw().error, null);
  assert.equal(t.timers.size, 0);
  assert.deepEqual(t.toasts, [{ text: "「端末の題」を取り込みました", level: null }]);
  assert.equal(t.counts.topicLoads, 1);
  assert.deepEqual(t.opened, []);
});

test("web static: 何もしていない札を閉じたら忘れ、開き直すと判定を読み直す。途中の札は閉じても覚えている", async () => {
  const t = loadTakeover();
  await t.opened1();
  t.takeover().close("s1");
  const d = deferred();
  t.api.getReply = () => d.promise;
  t.render();
  t.takeover().open("s1");
  assert.equal(t.gets.length, 2);
  assert.equal(t.raw().check, null, "前の判定は持ち越さない");
  d.resolve(takeCheck());
  await t.flush();
  // 途中（結果が分からない）で閉じて開き直しても、分からない形のまま
  const u = await lostTakeover();
  u.takeover().close("s1");
  u.api.getReply = () => Promise.resolve(takeCheck({ last: { takeover: 7, state: "running", id: null } }));
  u.render();
  u.takeover().open("s1");
  await u.flush();
  assert.equal(u.raw().phase, "lost");
});

test("web static: takeover.js を読むのは新しい殻（index.html）だけ（古い殻の classic.html・workbench.js は読まない・名前を出さない）", () => {
  assert.match(read(SHELL_HTML), /<script src="\/static\/takeover\.js" defer><\/script>/);
  for (const name of [CLASSIC_HTML, "workbench.js"]) {
    assert.doesNotMatch(read(name), /takeover\.js|SA\.takeover/, name);
  }
});

test("web static: 新しい殻の Claude Code のチャンネルの『…』の板に『取り込む』が出て、押すと cc:<sessionId> の札を開く", async () => {
  const h = await loadTermShell({ phone: true }, [v3Topic("ch:3", { title: "端末", origin: "cc", sessionId: "s1", movable: true })]);
  h.chatHeads["3"] = { title: "x", status: null, note: null, menu: [{ icon: "rotate-ccw", label: "会話を新しくする", run: () => undefined }] };
  h.app.open("ch:3");
  h.lastTop().on.menu(h.nodes.topButtons.menu);
  const rows = h.nodes.sheet.querySelectorAll("button.more-row");
  assert.deepEqual(rows.map((r) => textOf(r.querySelector("span.sb-label")!)), ["場所を変える", "端末を見る", "取り込む", "会話を新しくする"]);
  rows[2]!.dispatch("click");
  assert.equal(h.app.activeTabId(), "term:s1");
  assert.equal(h.location.hash, "#/cc/s1");
  assert.deepEqual(h.term.opens, ["s1"]);
});

test("web static: 新しい殻は広い幅でも、取り込める Claude Code のチャンネルの見出しに『…』を出す", async () => {
  const h = await loadTermShell({}, [v3Topic("ch:3", { title: "端末", origin: "cc", sessionId: "s1" }), v3Topic("ch:4", { origin: "cc", sessionId: null })]);
  h.app.open("ch:3");
  assert.equal(h.lastTop().compact, false);
  assert.equal(h.lastTop().menu, true);
  h.lastTop().on.menu(h.nodes.topButtons.menu);
  assert.deepEqual(h.nodes.sheet.querySelectorAll("button.more-row").map((r) => textOf(r.querySelector("span.sb-label")!)), ["取り込む"]);
  // 一覧に居ないセッションのチャンネルには出さない
  h.nodes.sheet.removeAttribute("open");
  h.app.open("ch:4");
  assert.equal(h.lastTop().menu, false);
});

test("web static: 新しい殻は札の入口が無ければ『取り込む』を出さない", async () => {
  for (const takeover of [undefined, { noEntry: true }, { noMouth: true }]) {
    const h = await loadTermShell({ takeover }, [v3Topic("ch:3", { title: "端末", origin: "cc", sessionId: "s1" })]);
    h.app.open("ch:3");
    assert.equal(h.lastTop().menu, false, JSON.stringify(takeover ?? null));
  }
  // 札を描けなかった後も出さない
  const h = await loadTermShell({ takeover: { draw: () => false } }, [termTopic("s2"), v3Topic("ch:3", { title: "端末", origin: "cc", sessionId: "s1" })]);
  h.app.open("cc:s2");
  h.app.open("ch:3");
  assert.equal(h.lastTop().menu, false);
});

// ===== 流れの列（D1。docs/plan/web-ui-deck.md）: 上の帯・3 つの列・席・「探す」の板（shell.js。入口は作り物） =====
const deckAttrs = (h: ReturnType<typeof loadShell>) => ["data-deck", "data-seat", "data-find"].map((n) => h.nodes.v3.getAttribute(n));
const lastBand = (h: ReturnType<typeof loadShell>): BandState => {
  const b = h.deck.bands.at(-1);
  assert.ok(b, "SA.deck.drawBand が呼ばれていない");
  return b;
};

/** 流れの列の殻（話題 ch:1・ch:2 と右腕を読ませた後） */
async function loadDeck(opts: Parameters<typeof loadShell>[0] = {}) {
  const h = loadShell({ deck: true, ...opts });
  await h.flush();
  h.api.reply = () => Promise.resolve(v3Result([v3Topic("ch:1"), v3Topic("ch:2")], { rightHands: [v3Hand()] }));
  await h.topics.load();
  return h;
}

test("web static: 流れの列: 幅 1440・1180・820 で data-deck は 3・3・2、data-seat は side・fold・fold。スマホでは 1・full（1 列ずつの横送り）、戻すと 3・side", async () => {
  const h = await loadDeck({ width: 1440 });
  assert.deepEqual(deckAttrs(h), ["3", "side", "closed"]);
  h.setPhone(false, 1180);
  assert.deepEqual(deckAttrs(h), ["3", "fold", "closed"]);
  h.setPhone(false, 820);
  assert.deepEqual(deckAttrs(h), ["2", "fold", "closed"]);
  assert.deepEqual(h.flows.views.at(-1), { cols: 2, current: null });
  assert.deepEqual(h.flows.passed.at(-1), { cols: 2, current: null, paged: false });
  h.setPhone(true, 390);
  assert.deepEqual(deckAttrs(h), ["1", "full", "closed"]);
  assert.deepEqual(h.flows.passed.at(-1), { cols: 1, current: null, paged: true });
  h.setPhone(false, 1440);
  assert.deepEqual(deckAttrs(h), ["3", "side", "closed"]);
  assert.deepEqual(h.flows.passed.at(-1), { cols: 3, current: null, paged: false });
  h.setPhone(true, 390);
  assert.deepEqual(deckAttrs(h), ["1", "full", "closed"]);
  // スマホで起動しても同じ（席を開いても 1・full のまま）
  const p = await loadDeck({ phone: true, width: 390 });
  assert.deepEqual(deckAttrs(p), ["1", "full", "closed"]);
  assert.deepEqual(p.flows.passed.at(-1), { cols: 1, current: null, paged: true });
  p.app.open("ch:1");
  assert.deepEqual(deckAttrs(p), ["1", "full", "closed"]);
  assert.deepEqual(p.flows.passed.at(-1), { cols: 1, current: "ch:1", paged: true });
});

test("web static: 流れの列: 項目から開くと席（data-view body・hash・v3Body の entry 1 つ）。flows に開いた ID を渡し、820 では列は 1 本。2 つ目を開いても履歴は増えない", async () => {
  const h = await loadDeck({ width: 820 });
  h.flows.key = "turn:ch:1";
  h.app.open("ch:1");
  assert.equal(h.nodes.v3.getAttribute("data-view"), "body");
  assert.equal(h.location.hash, "#/ch/1");
  assert.equal(h.calls.push, 1);
  assert.equal((h.history.state as { v3Body?: boolean }).v3Body, true);
  assert.deepEqual(h.flows.views.at(-1), { cols: 1, current: "ch:1" });
  assert.deepEqual(deckAttrs(h), ["1", "fold", "closed"]);
  // 項目から開いたら焦点は項目のまま（席の［閉じる］へ移さない）
  assert.ok(!h.top.focuses.includes("close"));
  assert.equal(h.lastTop().close, true);
  h.app.open("ch:2");
  assert.equal(h.calls.push, 1);
  assert.equal(h.location.hash, "#/ch/2");
  assert.deepEqual(h.flows.views.at(-1), { cols: 1, current: "ch:2" });
  // 列の場所が足りない幅（640）では列を隠し、焦点は席の［閉じる］
  const narrow = await loadDeck({ width: 640 });
  narrow.app.open("ch:1");
  assert.deepEqual(deckAttrs(narrow), ["0", "fold", "closed"]);
  assert.equal(narrow.top.focuses.at(-1), "close");
});

test("web static: 流れの列: 席は［閉じる］・Esc・戻るの 3 通りで閉じ、開いた項目に焦点を返す。入力中の Esc では閉じない", async () => {
  const h = await loadDeck({ width: 1440 });
  h.deck.items.add("turn:ch:1");
  const openItem = () => {
    h.flows.key = "turn:ch:1";
    h.app.open("ch:1");
    assert.equal(h.nodes.v3.getAttribute("data-view"), "body");
  };
  const closed = (how: string) => {
    assert.equal(h.nodes.v3.getAttribute("data-view"), "list", how);
    assert.equal(h.deck.focusItems.at(-1), "turn:ch:1", how);
    assert.equal(h.document.activeElement, h.nodes.itemButton, how);
    assert.deepEqual(h.flows.views.at(-1), { cols: 3, current: null }, how);
  };
  openItem();
  h.lastTop().on.close!();
  closed("閉じる");
  openItem();
  h.nodes.itemButton.focus();
  h.fireDoc("keydown", keyEvent("Escape", h.nodes.itemButton));
  closed("Esc");
  openItem();
  h.history.back();
  closed("戻る");
  // 入力中（input の中）の Esc は閉じない
  openItem();
  const input = new DomNode("input");
  Object.assign(input, { closest: () => input });
  h.nodes.ed.append(input);
  input.focus();
  h.fireDoc("keydown", keyEvent("Escape", input));
  assert.equal(h.nodes.v3.getAttribute("data-view"), "body");
  // 開いた元の項目が無ければ、席の話題の項目 → 帯の［探す］
  h.deck.items.clear();
  h.lastTop().on.close!();
  assert.deepEqual(h.deck.focusItems.slice(-4), ["turn:ch:1", "turn:ch:1", "run:ch:1", "topic:ch:1"]);
  assert.equal(h.deck.focusBands.at(-1), "find");
  assert.equal(h.document.activeElement, h.nodes.bandButtons.find);
});

test("web static: 流れの列: 席を閉じている間は会話を読んでいる扱いにせず（readingChannelIds）、開くと読む。shownChannelIds は変わらない", async () => {
  const h = (await loadDeck({ width: 1440 })) as HandShell;
  h.app.open("ch:1");
  assert.deepEqual(readingIds(h), ["1"]);
  assert.deepEqual(shownIds(h), ["1"]);
  h.lastTop().on.close!();
  assert.deepEqual(readingIds(h), []);
  assert.deepEqual(shownIds(h), ["1"]);
  h.history.forward();
  assert.deepEqual(readingIds(h), ["1"]);
});

test("web static: 流れの列: ［探す］と Ctrl+K で一覧を板にして重ね（後ろは inert・絞り込み欄に焦点・履歴は積まない）、Esc・幕で閉じて開いたボタンへ。行を開くと閉じて席の［閉じる］へ", async () => {
  const h = await loadDeck({ width: 1440 });
  const pushes = h.calls.push;
  const findBtn = h.nodes.bandButtons.find!;
  const opened = () => {
    assert.deepEqual(deckAttrs(h)[2], "open");
    assert.equal(h.nodes.list.getAttribute("role"), "dialog");
    assert.equal(h.nodes.list.getAttribute("aria-modal"), "true");
    assert.equal(h.nodes.list.getAttribute("aria-label"), "話題を探す");
    for (const n of [h.nodes.band, h.nodes.deckBox, h.nodes.main]) assert.equal((n as unknown as { inert: boolean }).inert, true);
    assert.equal(h.nodes.findBackdrop.hidden, false);
    assert.equal(h.nodes.searchBox.hidden, false);
    assert.equal(h.document.activeElement, h.document.getElementById("v3-search"));
  };
  const shut = (focus: DomNode) => {
    assert.deepEqual(deckAttrs(h)[2], "closed");
    assert.equal(h.nodes.list.getAttribute("role"), null);
    assert.equal(h.nodes.list.getAttribute("aria-modal"), null);
    assert.equal(h.nodes.list.getAttribute("aria-label"), "話題");
    for (const n of [h.nodes.band, h.nodes.deckBox, h.nodes.main]) assert.equal((n as unknown as { inert: boolean }).inert, false);
    assert.equal(h.nodes.findBackdrop.hidden, true);
    assert.equal(h.nodes.searchBox.hidden, true);
    assert.equal(h.document.activeElement, focus);
  };
  findBtn.focus();
  lastBand(h).on.find!(findBtn);
  opened();
  // 絞り込んだ字は閉じると消える
  const input = h.document.getElementById("v3-search")!;
  (input as unknown as { value: string }).value = "ch:1";
  input.dispatch("input");
  h.fireDoc("keydown", keyEvent("Escape", input));
  shut(findBtn);
  assert.equal((input as unknown as { value: string }).value, "");
  // Ctrl+K（開いたボタンは今の焦点）と幕
  const k = keyEvent("k", findBtn, { ctrlKey: true });
  h.fireDoc("keydown", k);
  assert.equal(k.prevented, true);
  opened();
  h.nodes.findBackdrop.dispatch("click");
  shut(findBtn);
  // SA.app.palette も板
  h.app.palette();
  opened();
  // 行を開くと閉じて席。焦点は席の［閉じる］
  h.press.open("ch:2");
  assert.deepEqual(deckAttrs(h)[2], "closed");
  assert.equal(h.nodes.v3.getAttribute("data-view"), "body");
  assert.equal(h.top.focuses.at(-1), "close");
  assert.equal(h.calls.push, pushes + 1);
  // ダイアログ・重ねた右腕の間は開かない
  const doc = h.document as unknown as { querySelector: (sel: string) => unknown };
  doc.querySelector = (sel: string) => (sel === "dialog[open]" ? {} : null);
  lastBand(h).on.find!(findBtn);
  assert.deepEqual(deckAttrs(h)[2], "closed");
  doc.querySelector = () => null;
  lastBand(h).on.hand!(h.nodes.bandButtons.hand);
  assert.equal(h.nodes.v3.getAttribute("data-hand"), "open");
  lastBand(h).on.find!(findBtn);
  h.fireDoc("keydown", keyEvent("k", findBtn, { metaKey: true }));
  assert.deepEqual(deckAttrs(h)[2], "closed");
});

test("web static: 流れの列: 右腕は幅 1400 でも重ねる形で、帯の［右腕］で開き、閉じると帯のボタンへ。下のバーは描かない（drawBar(null)）", async () => {
  const h = await loadDeck({ width: 1400 });
  assert.equal(h.nodes.v3.getAttribute("data-hand-mode"), "over");
  assert.equal(h.list.bottoms.at(-1), null);
  const hand = h.nodes.bandButtons.hand!;
  lastBand(h).on.hand!(hand);
  assert.equal(h.nodes.v3.getAttribute("data-hand"), "open");
  assert.equal(lastBand(h).hand.open, true);
  assert.equal(lastBand(h).controls, "v3-hand");
  for (const n of [h.nodes.band, h.nodes.deckBox]) assert.equal((n as unknown as { inert: boolean }).inert, true);
  h.nodes.backdrop.dispatch("click");
  assert.equal(h.nodes.v3.getAttribute("data-hand"), "closed");
  assert.equal(lastBand(h).hand.open, false);
  assert.equal(h.document.activeElement, hand);
  for (const n of [h.nodes.band, h.nodes.deckBox]) assert.equal((n as unknown as { inert: boolean }).inert, false);
  // スマホに替えても一覧の下のバーは空のまま、列の下のバー（SA.deck.drawBar）に描く
  h.setPhone(true, 390);
  assert.equal(h.list.bottoms.at(-1), null);
  const bar = h.deck.bars.at(-1);
  assert.ok(bar);
  assert.equal(bar.page, "turn");
  assert.equal(bar.controls, "v3-hand");
});

test("web static: 流れの列: 帯の［＋ 始める］は General の始める板、歯車の板は 知識・メモリ・使用量・（dev なら会話ログ）・設定、点は状態の画面", async () => {
  const all = ["knowledge", "memories", "usage", "devlog", "settings", "status", "tasks", "reminders", "github", "notices"];
  for (const dev of [false, true]) {
    const h = await loadDeck({ width: 1440, known: (tab) => tab.startsWith("ch:") || (all.includes(tab) && (dev || tab !== "devlog")), status: { bots: [{ name: "見本", connected: true }] } });
    assert.deepEqual(JSON.parse(JSON.stringify(lastBand(h).conn)), { tone: "ok", label: "見本 の Bot: 接続中" });
    const more = h.nodes.bandButtons.more!;
    lastBand(h).on.more!(more);
    const sheet = h.nodes.sheet;
    assert.equal(sheet.getAttribute("aria-label"), "ほか");
    assert.deepEqual(sheet.querySelectorAll("button.more-row").map(textOf), ["題:knowledge", "題:memories", "題:usage", ...(dev ? ["題:devlog"] : []), "題:settings"]);
    sheet.querySelector("button.sheet-close")!.dispatch("click");
    lastBand(h).on.start!(h.nodes.bandButtons.start);
    assert.equal(h.document.getElementById("v3-start")!.getAttribute("open"), "");
    assert.equal((h.document.getElementById("v3-start-place") as unknown as { value: string }).value, "general");
    (h.document.getElementById("v3-start") as unknown as { close: () => void }).close();
    lastBand(h).on.status!();
    assert.equal(h.app.activeTabId(), "status");
    assert.equal(h.nodes.v3.getAttribute("data-view"), "body");
  }
  // 状態を読めていなければ点は出さない
  const quiet = await loadDeck({ width: 1440 });
  assert.equal(lastBand(quiet).conn, null);
});

test("web static: 流れの列: 初めて流れの列になったときに flows.init を 1 回（起動が広い幅なら polling の前）、状態・一覧・知らせ・タブの描き直しで flows.render、状態では flows.status も", async () => {
  const h = await loadDeck({ width: 1440 });
  assert.equal(h.flows.inits, 1);
  const before = { renders: h.flows.renders, statuses: h.flows.statuses };
  h.app.refreshStatus();
  assert.equal(h.flows.statuses, before.statuses + 1);
  h.app.refreshSidebar();
  h.app.refreshNotices();
  h.app.refreshTabs();
  assert.ok(h.flows.renders >= before.renders + 4);
  // スマホの間も描く（1 列ずつの横送り）
  h.setPhone(true, 390);
  const phoneRenders = h.flows.renders;
  h.app.refreshSidebar();
  assert.equal(h.flows.renders, phoneRenders + 1);
  const sh = read("shell.js");
  const init = fnSource(sh, "init");
  assert.doesNotMatch(init, /SA\.flows\.init\(\)/);
  assert.ok(init.indexOf("fitDeck();") >= 0 && init.indexOf("fitDeck();") < init.indexOf("SA.poll.start()"));
  assert.match(fnSource(sh, "fitDeck"), /if \(first && SA\.flows\) SA\.flows\.init\(\);/);
});

test("web static: 流れの列: スマホで起動しても flows.init を 1 回（列のタスク・リマインドを読む）、幅をまたいでも呼び直さない。下のバーの口が無ければ（noFoot）スマホは今の殻で init を呼ばない", async () => {
  const h = await loadDeck({ phone: true, width: 390 });
  assert.equal(h.flows.inits, 1);
  h.setPhone(false, 1000);
  h.setPhone(true, 390);
  assert.equal(h.flows.inits, 1);
  // 落ち先（drawBar の無い SA.deck）: 属性なし・init 0 回・古い下のバー（variant phone）。広げて初めて流れの列になったときに 1 回、スマホを挟んで戻るとまた呼ぶ（中は 1 回だけ）
  const f = await loadDeck({ phone: true, width: 390, noFoot: true });
  assert.deepEqual(deckAttrs(f), [null, null, null]);
  assert.equal(f.flows.inits, 0);
  assert.equal(f.bottom().variant, "phone");
  assert.equal(f.deck.bars.length, 0);
  f.setPhone(false, 1000);
  assert.equal(f.flows.inits, 1);
  f.setPhone(true, 390);
  assert.deepEqual(deckAttrs(f), [null, null, null]);
  assert.equal(f.bottom().variant, "phone");
  f.setPhone(false, 1000);
  assert.equal(f.flows.inits, 2);
});

test("web static: 流れの列: 「探す」の板の中から右腕を開くと板を閉じ（4 つとも inert）、畳むと 4 つとも inert でなく焦点は帯の［探す］。右腕を重ねている間は Ctrl+K で板を開かない", async () => {
  const h = await loadDeck({ width: 1440 });
  const inert = () => [h.nodes.list, h.nodes.band, h.nodes.deckBox, h.nodes.main].map((n) => (n as unknown as { inert?: boolean }).inert === true);
  const findBtn = h.nodes.bandButtons.find!;
  findBtn.focus();
  lastBand(h).on.find!(findBtn);
  assert.equal(h.nodes.v3.getAttribute("data-find"), "open");
  assert.deepEqual(inert(), [false, true, true, true]);
  // 板の中（絞り込み欄）に焦点があるまま、右腕のチャンネルを開く
  h.app.open("ch:900");
  assert.equal(h.nodes.v3.getAttribute("data-find"), "closed");
  assert.equal(h.nodes.v3.getAttribute("data-hand"), "open");
  assert.deepEqual(inert(), [true, true, true, true]);
  h.nodes.backdrop.dispatch("click");
  assert.equal(h.nodes.v3.getAttribute("data-hand"), "closed");
  assert.deepEqual(inert(), [false, false, false, false]);
  assert.equal(h.document.activeElement, findBtn);
  // 右腕を重ねている間は Ctrl+K・SA.app.palette で板を開かない
  lastBand(h).on.hand!(h.nodes.bandButtons.hand);
  assert.equal(h.nodes.v3.getAttribute("data-hand"), "open");
  h.fireDoc("keydown", keyEvent("k", h.nodes.bandButtons.hand, { ctrlKey: true }));
  h.app.palette();
  assert.equal(h.nodes.v3.getAttribute("data-find"), "closed");
  assert.deepEqual(inert(), [true, true, true, true]);
});

test("web static: 流れの列: 入口（SA.deck）が無ければ属性を書かず、右腕は列の形・下のバーは広い幅のまま（今の落ち先）。SA.app のキーは古い殻と同じ", async () => {
  const h = await loadHand({ width: 1400 });
  assert.deepEqual(deckAttrs(h), [null, null, null]);
  assert.equal(h.nodes.v3.getAttribute("data-hand-mode"), "column");
  assert.equal(h.bottom().variant, "wide");
  h.app.open("ch:1");
  assert.equal(h.calls.push, 0);
  assert.equal(h.lastTop().close, false);
  assert.deepEqual(appKeys(read("shell.js")), appKeys(read("workbench.js")));
});

test("web static: shell.css の流れの列の規則は .v3[data-deck] 始まりか、素の display: none の 1 つだけで、スマホの塊に流れの列の字が無い", () => {
  const css = read("shell.css");
  const start = css.indexOf("===== 流れの列（D1");
  const end = css.indexOf("/* ===== スマホ（639px 以下）");
  assert.ok(start > 0 && end > start);
  const block = css.slice(css.lastIndexOf("/*", start), end).replace(/\/\*[\s\S]*?\*\//g, "");
  const rules = [...block.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((m) => ({ sel: m[1]!.trim().replace(/\s+/g, " "), body: m[2]!.trim() }));
  assert.ok(rules.length >= 10);
  const bare = rules.filter((r) => !r.sel.split(",").every((p) => p.trim().startsWith(".v3[data-deck")));
  assert.deepEqual(bare, [{ sel: ".v3-band, .v3-deck, .v3-find-backdrop, .v3-foot", body: "display: none;" }]);
  const phone = css.slice(css.indexOf("@media (max-width: 639px)"));
  const phoneBlock = phone.slice(0, phone.indexOf("\n}\n") + 3);
  assert.doesNotMatch(phoneBlock, /data-deck|data-seat|data-find|v3-band|v3-deck|v3-find|v3-foot/);
  // 流れの列の規則は media の外（幅の段を足さない）
  assert.ok(end < css.indexOf("@media (max-width: 639px)"));
});

test("web static: 流れの列: 席が開くときの動きの印（#v3 の data-moves=\"on\"。D5 の PR-1）は最初の pointerdown か keydown の後だけ付き、外さない。操作の前に開いた席・読み込み（hash）で開いた席には付かない。書くのは shell.js の 1 か所で、2 つの受け口（capture・1 回）の中", async () => {
  const sh = read("shell.js");
  assert.equal((sh.match(/"data-moves"/g) ?? []).length, 1);
  assert.match(fnSource(sh, "movesOn"), /\(\) \{\n {4}refs\.v3\.setAttribute\("data-moves", "on"\);\n {2}\}/);
  assert.match(fnSource(sh, "init"), /\n {4}for \(const type of \["pointerdown", "keydown"\]\) document\.addEventListener\(type, movesOn, \{ capture: true, once: true \}\);\n/);
  assert.equal((sh.match(/\bmovesOn\b/g) ?? []).length, 2);
  const moves = (h: ReturnType<typeof loadShell>) => h.nodes.v3.getAttribute("data-moves");
  const fire = (h: ReturnType<typeof loadShell>, type: string) => h.fireDoc(type, type === "keydown" ? keyEvent("Shift", h.document.body) : { target: h.document.body });
  for (const [type, opts] of [["pointerdown", { width: 1440 }], ["keydown", { width: 1440 }], ["pointerdown", { phone: true, width: 390 }]] as const) {
    const h = await loadDeck(opts);
    const label = `${type}・${opts.width}`;
    assert.equal(moves(h), null, label);
    // 操作の前に開いた席には付かない
    h.app.open("ch:1");
    assert.equal(h.nodes.v3.getAttribute("data-view"), "body", label);
    assert.equal(moves(h), null, label);
    h.history.back();
    assert.equal(h.nodes.v3.getAttribute("data-view"), "list", label);
    fire(h, type);
    assert.equal(moves(h), "on", label);
    // 付けた後は開いても閉じても、もう一度操作しても外れない
    h.app.open("ch:2");
    assert.equal(h.nodes.v3.getAttribute("data-view"), "body", label);
    assert.equal(moves(h), "on", label);
    h.history.back();
    fire(h, type === "keydown" ? "pointerdown" : "keydown");
    assert.equal(moves(h), "on", label);
  }
  // 読み込み（hash）で開いた席には付かない
  const r = await loadDeck({ width: 1440, hash: "#/ch/1" });
  assert.equal(r.nodes.v3.getAttribute("data-view"), "body");
  assert.equal(moves(r), null);
});

test("web static: 下のバーの入れ物（.v3-foot。D2）は素の display: none の並びのほかは、スマホの流れの列（data-seat=\"full\"）とキーボードの間の規則だけで、広い幅・落ち先では場所を取らない", () => {
  const css = read("shell.css").replace(/\/\*[\s\S]*?\*\//g, "");
  const sels = [...css.matchAll(/([^{}]+)\{/g)].map((m) => m[1]!.trim().replace(/\s+/g, " ")).filter((sel) => sel.includes("v3-foot"));
  assert.deepEqual(sels, [
    ".v3-band, .v3-deck, .v3-find-backdrop, .v3-foot",
    ".v3[data-deck][data-seat=\"full\"] .v3-foot",
    ".v3[data-deck][data-seat=\"full\"][data-view=\"body\"] .v3-band, .v3[data-deck][data-seat=\"full\"][data-view=\"body\"] .v3-deck, .v3[data-deck][data-seat=\"full\"][data-view=\"body\"] .v3-foot",
    ".v3[data-deck].is-keyboard .v3-foot",
  ]);
  // 出すのは full の規則だけ（キーボードの間は隠す）
  assert.match(css, /\.v3\[data-deck\]\[data-seat="full"\] \.v3-foot \{\s*display: block;/);
  assert.match(css, /\.v3\[data-deck\]\.is-keyboard \.v3-foot \{\s*display: none;\s*\}/);
  assert.doesNotMatch(read("app.css"), /v3-foot|c-foot/);
});

test("web static: 流れの列の台は地と同じ色（.v3[data-deck] は background を書かず .v3 の --bg を継ぐ。shell.css に --bench は無い）、席（.v3[data-deck] .v3-main）とその中の .ed と右腕の枠（.v3[data-deck] .v3-hand）は板（--surface）。落ち先の .v3・.v3-hand は地（--bg）", () => {
  const css = read("shell.css").replace(/\/\*[\s\S]*?\*\//g, "");
  const bodies = (sel: string): string[] =>
    [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].filter((m) => m[1]!.trim().replace(/\s+/g, " ") === sel).map((m) => m[2]!.trim());
  assert.ok(bodies(".v3[data-deck]").length >= 1, ".v3[data-deck]");
  for (const b of bodies(".v3[data-deck]")) assert.doesNotMatch(b, /(?:^|;)\s*background(?:-color|-image)?\s*:/, ".v3[data-deck]");
  assert.ok(!read("shell.css").includes("--bench"), "shell.css に --bench が在る");
  assert.ok(bodies(".v3[data-deck] .v3-main").some((b) => /(?:^|;)\s*background: var\(--surface\);/.test(b)), ".v3[data-deck] .v3-main");
  assert.ok(bodies(".v3[data-deck] .ed").some((b) => /(?:^|;)\s*background: var\(--surface\);/.test(b)), ".v3[data-deck] .ed");
  assert.ok(bodies(".v3[data-deck] .v3-hand").some((b) => /(?:^|;)\s*background: var\(--surface\);/.test(b)), ".v3[data-deck] .v3-hand");
  // 落ち先（入口に流れの列が無い）の地は地（--bg）
  assert.ok(bodies(".v3").some((b) => /(?:^|;)\s*background: var\(--bg\);/.test(b)), ".v3");
  assert.ok(bodies(".v3-hand").some((b) => /(?:^|;)\s*background: var\(--bg\);/.test(b)), ".v3-hand");
});

test("web static: 新しい殻の板（歯車の板 .v3-sheet・始める板 .v3-start）は dialog の枠を外す（border: 0。幕で区切る）。ほかの規則で枠を書き戻さない", () => {
  const css = read("shell.css").replace(/\/\*[\s\S]*?\*\//g, "");
  const rules = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((m) => ({ sel: m[1]!.trim().replace(/\s+/g, " "), body: m[2]!.trim() }));
  for (const sel of [".v3-sheet", ".v3-start"]) {
    // 板そのものを宛てる規則（.v3-sheet[open]・.v3[data-deck] .v3-sheet の形も。.v3-sheet-head など中の物は別）
    const self = new RegExp(`(?:^|[\\s>+~])${sel.replace(".", "\\.")}(?:\\[[^\\]]*\\]|:[a-z-]+(?:\\([^)]*\\))?)*$`);
    const own = rules.filter((r) => r.sel.split(",").some((x) => self.test(x.trim())));
    assert.ok(own.some((r) => r.sel === sel && /(?:^|;)\s*border: 0;/.test(r.body)), sel);
    for (const r of own) {
      for (const decl of r.body.split(";").map((d) => d.trim()).filter((d) => d !== "")) {
        const prop = decl.slice(0, decl.indexOf(":")).trim();
        if (prop.startsWith("border") && prop !== "border-radius") assert.equal(decl, "border: 0", `${r.sel}: ${decl}`);
      }
    }
  }
});

// ===== スマホの流れの列（D2）: 上の帯・1 列ずつの横送り・下のバー（shell.js。入口は作り物） =====
const lastDeckBar = (h: ReturnType<typeof loadShell>): DeckBarState => {
  const b = h.deck.bars.at(-1);
  assert.ok(b, "SA.deck.drawBar が呼ばれていない（か null）");
  return b;
};

test("web static: スマホの流れの列: 下のバーは SA.list.drawBar(null) のまま SA.deck.drawBar に描き、列は SA.deck.page で送る（履歴・hash は変えない）。paged は描き直すだけで、同じ id は何もしない", async () => {
  const h = await loadDeck({ phone: true, width: 390 });
  assert.equal(h.list.bottoms.at(-1), null);
  const bar = lastDeckBar(h);
  assert.equal(bar.page, "turn");
  assert.equal(bar.hand, null);
  assert.equal(bar.controls, "v3-hand");
  // 起動では今の列（あなたの番）へ送る
  assert.equal(h.deck.pages.at(-1), "turn");
  const pushes = h.calls.push;
  const hash = h.location.hash;
  const st = h.history.state;
  const pages = h.deck.pages.length;
  bar.on.page("tasks");
  assert.deepEqual(h.deck.pages.slice(pages), ["tasks"]);
  assert.equal(lastDeckBar(h).page, "tasks");
  assert.equal(h.calls.push, pushes);
  assert.equal(h.location.hash, hash);
  assert.equal(h.history.state, st);
  // 指で送った列（paged）は描き直すが送らない。同じ id はもう一度来ても描き直さない
  const bars = h.deck.bars.length;
  lastDeckBar(h).on.paged("feed");
  assert.equal(h.deck.pages.length, pages + 1);
  assert.equal(h.deck.bars.length, bars + 1);
  assert.equal(lastDeckBar(h).page, "feed");
  lastDeckBar(h).on.paged("feed");
  assert.equal(h.deck.bars.length, bars + 1);
  assert.equal(h.calls.push, pushes);
  // 今の列をもう一度押しても同じ列へ送るだけ
  lastDeckBar(h).on.page("feed");
  assert.equal(h.deck.pages.at(-1), "feed");
  assert.equal(lastDeckBar(h).page, "feed");
  // 右腕: 開いて、印は下のバーの hand に出る
  lastDeckBar(h).on.hand(h.nodes.footButtons.hand);
  assert.equal(h.nodes.v3.getAttribute("data-hand"), "open");
  // 帯はスマホの形（［右腕］は下のバー）
  assert.equal(lastBand(h).variant, "phone");
  h.setPhone(false, 1440);
  assert.equal(lastBand(h).variant, "wide");
});

test("web static: スマホの流れの列: 帯の state の page は今の列（始め turn・バーの page・指の paged・古い行き先 #/tasks で描き直す。同じ id の paged は描き直さない）。広い幅は undefined", async () => {
  const h = await loadDeck({ phone: true, width: 390 });
  assert.equal(lastBand(h).page, "turn");
  const n = h.deck.bands.length;
  lastDeckBar(h).on.page("tasks");
  assert.equal(h.deck.bands.length, n + 1);
  assert.deepEqual([lastBand(h).variant, lastBand(h).page], ["phone", "tasks"]);
  lastDeckBar(h).on.paged("feed");
  assert.equal(h.deck.bands.length, n + 2);
  assert.equal(lastBand(h).page, "feed");
  // 同じ id の paged は帯を描き直さない
  lastDeckBar(h).on.paged("feed");
  assert.equal(h.deck.bands.length, n + 2);
  // 古い行き先（hashchange の #/tasks）は列 tasks
  h.location.hash = "#/tasks";
  h.fire("hashchange");
  assert.equal(lastBand(h).page, "tasks");
  // 広い幅へまたぐと page は undefined、戻すと今の列
  h.setPhone(false, 1440);
  assert.deepEqual([lastBand(h).variant, lastBand(h).page], ["wide", undefined]);
  h.setPhone(true, 390);
  assert.deepEqual([lastBand(h).variant, lastBand(h).page], ["phone", "tasks"]);
  // 広い幅で起動しても undefined（バーの列を選ぶ道は無い）
  const w = await loadDeck();
  assert.equal(lastBand(w).page, undefined);
  const wh = await loadDeck({ width: 1440, hash: "#/github", known: (tab) => tab.startsWith("ch:") || tab === "github" });
  assert.equal(lastBand(wh).page, undefined);
});

test("web static: スマホの流れの列: 下のバーを描けなければ hand: null で 1 回だけ描き直す。右腕の印は下のバーの hand", async () => {
  const seen: Array<DeckBarState | null> = [];
  const h = await loadDeck({ phone: true, width: 390, deckBar: (b) => (seen.push(b), b === null || b.hand === null) });
  h.api.reply = () => Promise.resolve(v3Result([v3Topic("ch:1")], { rightHands: [v3Hand({ turn: { at: 1 } })] }));
  await h.topics.load();
  const before = seen.length;
  lastDeckBar(h).on.page("tasks");
  assert.deepEqual(
    seen.slice(before).map((b) => b && { page: b.page, hand: b.hand }),
    [
      { page: "tasks", hand: "turn" },
      { page: "tasks", hand: null },
    ],
  );
  // 描けたら 1 回だけ
  const ok = await loadDeck({ phone: true, width: 390 });
  ok.api.reply = () => Promise.resolve(v3Result([v3Topic("ch:1")], { rightHands: [v3Hand({ turn: { at: 1 } })] }));
  await ok.topics.load();
  const n = ok.deck.bars.length;
  lastDeckBar(ok).on.page("feed");
  assert.equal(ok.deck.bars.length, n + 1);
  assert.equal(lastDeckBar(ok).hand, "turn");
});

test("web static: スマホの流れの列: 歯車の板は 知識・メモリ・使用量・（dev なら会話ログ）・設定、点は状態の画面をスレッドの場所に開く", async () => {
  const all = ["knowledge", "memories", "usage", "devlog", "settings", "status", "tasks", "reminders", "github", "notices"];
  for (const dev of [false, true]) {
    const h = await loadDeck({ phone: true, width: 390, known: (tab) => tab.startsWith("ch:") || (all.includes(tab) && (dev || tab !== "devlog")), status: { bots: [{ name: "見本", connected: true }] } });
    lastBand(h).on.more!(h.nodes.bandButtons.more);
    const sheet = h.nodes.sheet;
    assert.equal(sheet.getAttribute("aria-label"), "ほか");
    assert.deepEqual(sheet.querySelectorAll("button.more-row").map(textOf), ["題:knowledge", "題:memories", "題:usage", ...(dev ? ["題:devlog"] : []), "題:settings"]);
    sheet.querySelector("button.sheet-close")!.dispatch("click");
    const pushes = h.calls.push;
    lastBand(h).on.status!();
    assert.equal(h.app.activeTabId(), "status");
    assert.equal(h.nodes.v3.getAttribute("data-view"), "body");
    assert.equal(h.calls.push, pushes + 1);
    assert.deepEqual(deckAttrs(h), ["1", "full", "closed"]);
  }
});

test("web static: スマホの流れの列: 列 feed のまま 1440 にすると下のバーは空（drawBar(null)）、390 に戻すと page feed で描いて SA.deck.page(feed)。スレッドを開いたまままたいでも body のまま", async () => {
  const h = await loadDeck({ phone: true, width: 390 });
  lastDeckBar(h).on.page("feed");
  h.setPhone(false, 1440);
  assert.equal(h.deck.bars.at(-1), null);
  assert.equal(h.list.bottoms.at(-1), null);
  const pages = h.deck.pages.length;
  h.setPhone(true, 390);
  assert.equal(lastDeckBar(h).page, "feed");
  assert.ok(h.deck.pages.slice(pages).includes("feed"));
  assert.ok(h.deck.pages.slice(pages).every((id) => id === "feed"));
  h.app.open("ch:1");
  assert.equal(h.nodes.v3.getAttribute("data-view"), "body");
  h.setPhone(false, 1440);
  assert.equal(h.nodes.v3.getAttribute("data-view"), "body");
  assert.deepEqual(deckAttrs(h), ["3", "side", "closed"]);
  h.setPhone(true, 390);
  assert.equal(h.nodes.v3.getAttribute("data-view"), "body");
  assert.deepEqual(deckAttrs(h), ["1", "full", "closed"]);
  assert.equal(lastDeckBar(h).page, "feed");
});

test("web static: スマホの流れの列: 列が見えている間は開いていた会話を読んでいる扱いにせず（readingChannelIds）、スレッドを開くと読む。shownChannelIds は変わらない", async () => {
  const h = (await loadDeck({ phone: true, width: 390 })) as HandShell;
  h.app.open("ch:1");
  assert.deepEqual(readingIds(h), ["1"]);
  assert.deepEqual(shownIds(h), ["1"]);
  h.history.back();
  assert.equal(h.nodes.v3.getAttribute("data-view"), "list");
  assert.deepEqual(readingIds(h), []);
  assert.deepEqual(shownIds(h), ["1"]);
  h.history.forward();
  assert.deepEqual(readingIds(h), ["1"]);
});

test("web static: スマホの流れの列: 項目から開くとスレッド（body・v3Body の entry 1 つ・hash・焦点は［‹］・［閉じる］なし・名前は「戻る」）。2 つ目は置き換え。戻る・［‹］・Esc で列へ戻り、焦点は押した項目、列は元のまま", async () => {
  const h = await loadDeck({ phone: true, width: 390 });
  h.deck.items.add("rem:1");
  lastDeckBar(h).on.page("tasks");
  const openItem = () => {
    h.flows.key = "rem:1";
    h.app.open("ch:1");
    assert.equal(h.nodes.v3.getAttribute("data-view"), "body");
  };
  const closed = (how: string) => {
    assert.equal(h.nodes.v3.getAttribute("data-view"), "list", how);
    assert.equal(h.deck.focusItems.at(-1), "rem:1", how);
    assert.equal(h.document.activeElement, h.nodes.itemButton, how);
    assert.equal(lastDeckBar(h).page, "tasks", how);
    assert.ok(h.deck.pages.every((id, i) => i < pagesAt || id === "tasks"), how);
  };
  const pagesAt = h.deck.pages.length;
  openItem();
  assert.equal(h.calls.push, 1);
  assert.deepEqual(JSON.parse(JSON.stringify(h.history.state)), { v3Body: true });
  assert.equal(h.location.hash, "#/ch/1");
  assert.equal(h.top.focuses.at(-1), "back");
  assert.equal(h.document.activeElement, h.nodes.topButtons.back);
  assert.equal(h.lastTop().close, false);
  assert.equal(h.lastTop().backLabel, "戻る");
  h.app.open("ch:2");
  assert.equal(h.calls.push, 1);
  assert.equal(h.location.hash, "#/ch/2");
  h.history.back();
  assert.equal(h.nodes.v3.getAttribute("data-view"), "list");
  assert.equal(lastDeckBar(h).page, "tasks");
  openItem();
  h.history.back();
  closed("戻る");
  openItem();
  h.lastTop().on.back();
  closed("［‹］");
  openItem();
  h.fireDoc("keydown", keyEvent("Escape", h.nodes.topButtons.back));
  closed("Esc");
  // 入力中の Esc は戻らない
  openItem();
  const input = new DomNode("input");
  Object.assign(input, { closest: () => input });
  h.nodes.ed.append(input);
  input.focus();
  h.fireDoc("keydown", keyEvent("Escape", input));
  assert.equal(h.nodes.v3.getAttribute("data-view"), "body");
  // 落ち先（drawBar の無い入口）の［‹］は「一覧へ」のまま（backLabel を渡さない）
  const f = await loadDeck({ phone: true, width: 390, noFoot: true });
  f.app.open("ch:1");
  assert.equal(f.lastTop().backLabel, undefined);
  assert.equal(f.lastTop().close, false);
});

test("web static: スマホの流れの列: 帯の［探す］の板は entry を 1 つ積み、幕・Esc・戻るで閉じて焦点は帯の［探す］。板の行を開くと entry が話題に替わり（積み増さない）、戻ると列。広い幅は積まない", async () => {
  const h = await loadDeck({ phone: true, width: 390 });
  const findBtn = h.nodes.bandButtons.find!;
  const openFind = () => {
    findBtn.focus();
    lastBand(h).on.find!(findBtn);
    assert.equal(h.nodes.v3.getAttribute("data-find"), "open");
    for (const n of [h.nodes.band, h.nodes.deckBox, h.nodes.foot, h.nodes.main]) assert.equal((n as unknown as { inert: boolean }).inert, true);
  };
  const shut = (how: string, back: number) => {
    assert.equal(h.nodes.v3.getAttribute("data-find"), "closed", how);
    assert.equal(h.document.activeElement, findBtn, how);
    assert.equal(h.calls.back, back, how);
    assert.equal(h.history.state, null, how);
    for (const n of [h.nodes.band, h.nodes.deckBox, h.nodes.foot, h.nodes.main]) assert.equal((n as unknown as { inert: boolean }).inert, false, how);
  };
  openFind();
  assert.equal(h.calls.push, 1);
  assert.deepEqual(JSON.parse(JSON.stringify(h.history.state)), { v3Find: true });
  h.nodes.findBackdrop.dispatch("click");
  shut("幕", 1);
  openFind();
  h.fireDoc("keydown", keyEvent("Escape", h.document.getElementById("v3-search")));
  shut("Esc", 2);
  openFind();
  h.history.back();
  shut("戻る", 3);
  // 進むでは開き直さない
  h.history.forward();
  assert.equal(h.nodes.v3.getAttribute("data-find"), "closed");
  h.history.back();
  // 板の行を開く: 板を閉じ、entry は話題（push は増えない）。戻ると列
  openFind();
  const pushes = h.calls.push;
  h.press.open("ch:2");
  assert.equal(h.nodes.v3.getAttribute("data-find"), "closed");
  assert.equal(h.nodes.v3.getAttribute("data-view"), "body");
  assert.equal(h.calls.push, pushes);
  assert.deepEqual(JSON.parse(JSON.stringify(h.history.state)), { v3Body: true });
  assert.equal(h.location.hash, "#/ch/2");
  h.history.back();
  assert.equal(h.nodes.v3.getAttribute("data-view"), "list");
  assert.equal(h.history.state, null);
  // 閉じた後の焦点は板を開いた［探す］
  assert.equal(h.document.activeElement, findBtn);
  // 戻るが非同期でも、続けて 2 回閉じても戻るのは 1 回
  const a = await loadDeck({ phone: true, width: 390, asyncBack: true });
  const aFind = a.nodes.bandButtons.find!;
  aFind.focus();
  lastBand(a).on.find!(aFind);
  a.nodes.findBackdrop.dispatch("click");
  a.fireDoc("keydown", keyEvent("Escape", a.document.getElementById("v3-search")));
  a.runHistory();
  assert.equal(a.calls.back, 1);
  assert.equal(a.nodes.v3.getAttribute("data-find"), "closed");
  // 広い幅は今までどおり積まない
  const w = await loadDeck({ width: 1440 });
  lastBand(w).on.find!(w.nodes.bandButtons.find);
  assert.equal(w.calls.push, 0);
  w.nodes.findBackdrop.dispatch("click");
  assert.equal(w.calls.back, 0);
});

test("web static: スマホの流れの列: スレッドの上で Ctrl+K の板を開き、板の行を開いても、［‹］1 回で列へ戻る（下の話題の entry を越える。板を戻るで閉じればスレッドのまま）", async () => {
  const h = await loadDeck({ phone: true, width: 390 });
  h.app.open("ch:1");
  assert.deepEqual(JSON.parse(JSON.stringify(h.history.state)), { v3Body: true });
  const ctrlK = () => h.fireDoc("keydown", keyEvent("k", h.nodes.topButtons.back, { ctrlKey: true }));
  // 板を開く: entry を 1 つ積み、下の entry から列までの段数（1）を覚える
  ctrlK();
  assert.equal(h.nodes.v3.getAttribute("data-find"), "open");
  assert.equal(h.calls.push, 2);
  assert.deepEqual(JSON.parse(JSON.stringify(h.history.state)), { v3Find: true, v3Depth: 1 });
  // 戻るで閉じるとスレッドのまま
  h.history.back();
  assert.equal(h.nodes.v3.getAttribute("data-find"), "closed");
  assert.equal(h.nodes.v3.getAttribute("data-view"), "body");
  assert.deepEqual(JSON.parse(JSON.stringify(h.history.state)), { v3Body: true });
  // もう一度開いて板の行を開く: 板の entry が話題に替わり（積み増さない）、列までは 2 段
  ctrlK();
  const pushes = h.calls.push;
  h.press.open("ch:2");
  assert.equal(h.nodes.v3.getAttribute("data-find"), "closed");
  assert.equal(h.nodes.v3.getAttribute("data-view"), "body");
  assert.equal(h.calls.push, pushes);
  assert.deepEqual(JSON.parse(JSON.stringify(h.history.state)), { v3Body: true, v3Depth: 2 });
  assert.equal(h.location.hash, "#/ch/2");
  // ［‹］1 回で列（下の ch:1 の entry で止まらない）
  h.lastTop().on.back();
  assert.equal(h.nodes.v3.getAttribute("data-view"), "list");
  assert.equal(h.history.state, null);
});

test("web static: スマホの流れの列: スレッドの上の Ctrl+K の板から右腕を開き、右腕から別の話題を開いても、［‹］1 回で列へ戻る（板の下の段数を右腕の entry が引き継ぐ）", async () => {
  const h = (await loadDeck({ phone: true, width: 390 })) as HandShell;
  h.app.open("ch:1");
  h.fireDoc("keydown", keyEvent("k", h.nodes.topButtons.back, { ctrlKey: true }));
  assert.deepEqual(JSON.parse(JSON.stringify(h.history.state)), { v3Find: true, v3Depth: 1 });
  // 板の中の右腕の行: 板の entry を右腕の entry に置き換える（下のスレッドまでの段数 1 を持つ）
  const pushes = h.calls.push;
  h.app.open("ch:900");
  assert.equal(handOf(h), "open");
  assert.equal(h.calls.push, pushes);
  assert.deepEqual(JSON.parse(JSON.stringify(h.history.state)), { v3Body: true, v3Hand: true, v3Depth: 1 });
  // 右腕から別の話題: 右腕の entry が話題に替わり、列までは 2 段
  h.app.open("ch:2");
  assert.equal(handOf(h), "closed");
  assert.equal(h.calls.push, pushes);
  assert.deepEqual(JSON.parse(JSON.stringify(h.history.state)), { v3Body: true, v3Depth: 2 });
  // ［‹］1 回で列（下の ch:1 の entry で止まらない）
  h.lastTop().on.back();
  assert.equal(h.nodes.v3.getAttribute("data-view"), "list");
  assert.equal(h.history.state, null);
});

test("web static: スマホの流れの列: スレッドの上の板を戻るで閉じた後、進むで板の entry に入ってもスレッドのまま（板は開き直さない）。そこからの［‹］は 1 回で列へ戻る", async () => {
  const h = await loadDeck({ phone: true, width: 390 });
  h.app.open("ch:1");
  h.fireDoc("keydown", keyEvent("k", h.nodes.topButtons.back, { ctrlKey: true }));
  h.history.back();
  assert.equal(h.nodes.v3.getAttribute("data-view"), "body");
  h.history.forward();
  assert.deepEqual(JSON.parse(JSON.stringify(h.history.state)), { v3Find: true, v3Depth: 1 });
  assert.equal(h.nodes.v3.getAttribute("data-find"), "closed");
  assert.equal(h.nodes.v3.getAttribute("data-view"), "body");
  h.lastTop().on.back();
  assert.equal(h.nodes.v3.getAttribute("data-view"), "list");
  assert.equal(h.history.state, null);
  // 列の上で開いた板の entry（段数なし）へ進むで入ったときは列のまま
  const findBtn = h.nodes.bandButtons.find!;
  lastBand(h).on.find!(findBtn);
  h.history.back();
  h.history.forward();
  assert.deepEqual(JSON.parse(JSON.stringify(h.history.state)), { v3Find: true });
  assert.equal(h.nodes.v3.getAttribute("data-find"), "closed");
  assert.equal(h.nodes.v3.getAttribute("data-view"), "list");
});

test("web static: スマホの流れの列: 下のバーの右腕は entry を 1 つ積み、帯・列・下のバーが inert。戻ると畳み、焦点は下のバーの右腕。板の中から開くと板の entry を置き換える（戻る 1 回で列）", async () => {
  const h = (await loadDeck({ phone: true, width: 390 })) as HandShell;
  const inert = () => [h.nodes.band, h.nodes.deckBox, h.nodes.foot].map((n) => (n as unknown as { inert?: boolean }).inert === true);
  lastDeckBar(h).on.hand(h.nodes.footButtons.hand);
  assert.equal(handOf(h), "open");
  assert.equal(h.calls.push, 1);
  assert.deepEqual(inert(), [true, true, true]);
  h.history.back();
  assert.equal(handOf(h), "closed");
  assert.deepEqual(inert(), [false, false, false]);
  assert.equal(h.document.activeElement, h.nodes.footButtons.hand);
  // 開いたボタンが無い開き方（焦点の無いまま右腕のチャンネルを開く）: 閉じた後は SA.deck.focusBar("hand")
  DomNode.focused = null;
  h.app.open("ch:900");
  assert.equal(handOf(h), "open");
  h.history.back();
  assert.equal(h.deck.focusBars.at(-1), "hand");
  assert.equal(h.document.activeElement, h.nodes.footButtons.hand);
  // 板の中から開く: 板を閉じ、板の entry を右腕の entry に置き換える
  const findBtn = h.nodes.bandButtons.find!;
  findBtn.focus();
  lastBand(h).on.find!(findBtn);
  const pushes = h.calls.push;
  h.app.open("ch:900");
  assert.equal(h.nodes.v3.getAttribute("data-find"), "closed");
  assert.equal(handOf(h), "open");
  assert.equal(h.calls.push, pushes);
  assert.deepEqual(JSON.parse(JSON.stringify(h.history.state)), { v3Body: false, v3Hand: true, v3Depth: 0 });
  h.history.back();
  assert.equal(handOf(h), "closed");
  assert.equal(h.history.state, null);
  assert.equal(h.nodes.v3.getAttribute("data-view"), "list");
  assert.equal(h.document.activeElement, findBtn);
});

test("web static: 流れの列: 古い行き先（起動の hash・hashchange の #/tasks・#/reminders は列 tasks、#/github・#/notices は列 feed）は古い表を開かず、hash を消し、履歴を積まない。スレッドは閉じない。入口が無ければ今までどおり古い表", async () => {
  const known = (tab: string) => tab.startsWith("ch:") || ["tasks", "reminders", "github", "notices"].includes(tab);
  const cases: Array<[string, string]> = [
    ["#/tasks", "tasks"],
    ["#/reminders", "tasks"],
    ["#/github", "feed"],
    ["#/notices", "feed"],
  ];
  for (const [hash, page] of cases) {
    // スマホ: 起動の hash
    const h = await loadDeck({ phone: true, width: 390, hash, known });
    assert.equal(h.nodes.v3.getAttribute("data-view"), "list", hash);
    assert.equal(h.app.activeTabId(), null, hash);
    assert.equal(h.location.hash, "", hash);
    assert.equal(h.calls.push, 0, hash);
    assert.equal(lastDeckBar(h).page, page, hash);
    assert.equal(h.deck.pages.at(-1), page, hash);
    assert.ok(!h.rendered.some((r) => r.tab === hash.slice(2)), hash);
    // hashchange でも同じ（スレッドを開いたままでも閉じない。hash はスレッドの物に戻す）
    const c = await loadDeck({ phone: true, width: 390, known });
    c.app.open("ch:1");
    const pushes = c.calls.push;
    c.location.hash = hash;
    c.fire("hashchange");
    assert.equal(c.nodes.v3.getAttribute("data-view"), "body", hash);
    assert.equal(c.app.activeTabId(), "ch:1", hash);
    assert.equal(c.location.hash, "#/ch/1", hash);
    assert.equal(c.calls.push, pushes, hash);
    assert.equal(lastDeckBar(c).page, page, hash);
    // 広い幅でも古い表は開かない（席は開かない。全部の列が見えているので送らない）
    const w = await loadDeck({ width: 1440, hash, known });
    assert.equal(w.nodes.v3.getAttribute("data-view"), "list", hash);
    assert.equal(w.app.activeTabId(), null, hash);
    assert.equal(w.location.hash, "", hash);
    assert.equal(w.calls.push, 0, hash);
    assert.equal(w.deck.pages.length, 0, hash);
    // 入口が無い（広い幅の落ち先・スマホの落ち先）: 今までどおり古い表が開く
    for (const opts of [{ width: 1400 }, { phone: true, width: 390, deck: true, noFoot: true }]) {
      const o = loadShell({ ...opts, hash, known });
      await o.flush();
      assert.equal(o.app.activeTabId(), hash.slice(2), hash);
      assert.equal(o.location.hash, hash, hash);
    }
  }
});

test("web static: 流れの列の操作: ［完了］は POST /complete → 知らせ「…を完了にしました」→［取り消す］で /reopen、［対応］は POST /api/github/<id>/act。応答までの二度押しは送らず、失敗したら busy が外れてもう一度押せる", async () => {
  const { SA, posts, toasts, toastActions, setReply } = loadViews({ v3: true });
  const tick = async () => {
    for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r));
  };
  const store = SA.store as Record<string, unknown>;
  const reloads: string[] = [];
  store.reload = (key: string) => {
    reloads.push(key);
    return Promise.resolve();
  };
  store.openTasks = [{ id: 5, title: "買い物", due: null, status: "open" }];
  store.github = {
    notifications: [
      { id: 9, url: "https://github.com/o/r/pull/2", title: "押せる", handoff: true },
      { id: 10, url: "https://github.com/o/r/pull/3", title: "押せない", handoff: false },
    ],
    handoff: true,
  };
  SA.topics = { data: () => null };
  const draws: unknown[] = [];
  SA.deck = {
    draw: (st: { busy: unknown }) => {
      draws.push(st.busy);
      return true;
    },
  };
  vm.runInNewContext(read("flows.js"), { window: { SA } });
  const views = SA.views as Record<string, unknown>;
  assert.equal(typeof views.completeTask, "function");
  assert.equal(typeof views.githubHandoff, "function");
  const flows = SA.flows as { state: () => { busy: string[]; ops: boolean; on: { op: (item: unknown, opId: string) => void } } };
  const on = flows.state().on;
  // 応答が返る前の 2 回目は送らない（描き直しで busy）
  let answer: (v: unknown) => void = () => undefined;
  setReply(() => new Promise((r) => (answer = r)));
  on.op({ key: "task:5" }, "complete");
  on.op({ key: "task:5" }, "complete");
  assert.deepEqual(posts, ["/api/tasks/5/complete"]);
  assert.deepEqual([...flows.state().busy], ["task:5"]);
  assert.deepEqual([...(draws.at(-1) as string[])], ["task:5"]);
  answer({});
  await tick();
  assert.deepEqual(toasts, ["「買い物」を完了にしました"]);
  assert.deepEqual(reloads, ["tasks"]);
  assert.deepEqual([...flows.state().busy], []);
  assert.deepEqual([...(draws.at(-1) as string[])], []);
  // ［取り消す］で /reopen（一覧を読み直す）
  setReply(() => Promise.resolve({}));
  const undo = toastActions[0] as { label: string; run: () => void };
  assert.equal(undo.label, "取り消す");
  undo.run();
  await tick();
  assert.deepEqual(posts.slice(1), ["/api/tasks/5/reopen"]);
  assert.deepEqual(reloads, ["tasks", "tasks"]);
  // 失敗したら busy が外れて、もう一度押せる
  posts.length = 0;
  setReply(() => Promise.reject({ status: 500 }));
  on.op({ key: "task:5" }, "complete");
  await tick();
  assert.equal(toasts.at(-1), "操作に失敗しました。もう一度試してください");
  assert.deepEqual([...flows.state().busy], []);
  setReply(() => Promise.resolve({}));
  on.op({ key: "task:5" }, "complete");
  await tick();
  assert.deepEqual(posts, ["/api/tasks/5/complete", "/api/tasks/5/complete"]);
  // ［対応］も応答までは 1 回だけ
  posts.length = 0;
  setReply(() => new Promise((r) => (answer = r)));
  on.op({ key: "gh:9" }, "act");
  on.op({ key: "gh:9" }, "act");
  assert.deepEqual(posts, ["/api/github/9/act"]);
  assert.deepEqual([...flows.state().busy], ["gh:9"]);
  answer({ text: "話題を作りました" });
  await tick();
  assert.equal(toasts.at(-1), "話題を作りました");
  assert.deepEqual([...flows.state().busy], []);
  // 押せない通知・引けない項目・知らない操作は送らない
  on.op({ key: "gh:10" }, "act");
  on.op({ key: "task:99" }, "complete");
  on.op({ key: "rem:1" }, "skip");
  on.op(null, "complete");
  await tick();
  assert.deepEqual(posts, ["/api/github/9/act"]);
  assert.deepEqual([...flows.state().busy], []);
});

test("web static: 流れの列の操作: busy は応答と読み直しが終わるまで続き（間を置いた 2 回目も送らない）、終わると外れる。［対応］は応答まで", async () => {
  const { SA, posts, setReply } = loadViews({ v3: true });
  const tick = async () => {
    for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r));
  };
  const store = SA.store as Record<string, unknown>;
  let reloaded: (v?: unknown) => void = () => undefined;
  store.reload = () => new Promise((r) => (reloaded = r));
  store.openTasks = [{ id: 5, title: "買い物", due: null, status: "open" }];
  store.github = { notifications: [{ id: 9, url: "https://github.com/o/r/pull/2", title: "押せる", handoff: true }], handoff: true };
  SA.topics = { data: () => null };
  SA.deck = { draw: () => true };
  vm.runInNewContext(read("flows.js"), { window: { SA } });
  const flows = SA.flows as { state: () => { busy: string[]; on: { op: (item: unknown, opId: string) => void } } };
  const on = flows.state().on;
  let answer: (v: unknown) => void = () => undefined;
  setReply(() => new Promise((r) => (answer = r)));
  // 応答の前: 間を置いた 2 回目も送らない
  on.op({ key: "task:5" }, "complete");
  await tick();
  on.op({ key: "task:5" }, "complete");
  await tick();
  assert.deepEqual(posts, ["/api/tasks/5/complete"]);
  assert.deepEqual([...flows.state().busy], ["task:5"]);
  // 応答は返ったが読み直し中: busy のまま・送らない
  answer({});
  await tick();
  on.op({ key: "task:5" }, "complete");
  await tick();
  assert.deepEqual(posts, ["/api/tasks/5/complete"]);
  assert.deepEqual([...flows.state().busy], ["task:5"]);
  // 読み直しが終わると外れる
  reloaded();
  await tick();
  assert.deepEqual([...flows.state().busy], []);
  // ［対応］: 応答の前に間を置いた 2 回目は送らない。返ると外れる
  posts.length = 0;
  on.op({ key: "gh:9" }, "act");
  await tick();
  on.op({ key: "gh:9" }, "act");
  await tick();
  assert.deepEqual(posts, ["/api/github/9/act"]);
  assert.deepEqual([...flows.state().busy], ["gh:9"]);
  answer({ text: "話題を作りました" });
  await tick();
  assert.deepEqual([...flows.state().busy], []);
});

test("web static: 流れの列の操作: views.js の呼び出しが同期で投げても busy を残さず、もう一度押せる", async () => {
  const { SA } = loadViews({ v3: true });
  const store = SA.store as Record<string, unknown>;
  store.openTasks = [{ id: 5, title: "買い物", due: null, status: "open" }];
  SA.topics = { data: () => null };
  SA.deck = { draw: () => true };
  vm.runInNewContext(read("flows.js"), { window: { SA } });
  const views = SA.views as Record<string, unknown>;
  let calls = 0;
  views.completeTask = () => {
    calls += 1;
    throw new Error("x");
  };
  const flows = SA.flows as { state: () => { busy: string[]; on: { op: (item: unknown, opId: string) => void } } };
  flows.state().on.op({ key: "task:5" }, "complete");
  await new Promise((r) => setImmediate(r));
  assert.deepEqual([...flows.state().busy], []);
  flows.state().on.op({ key: "task:5" }, "complete");
  await new Promise((r) => setImmediate(r));
  assert.equal(calls, 2);
  assert.deepEqual([...flows.state().busy], []);
});

/** 流れの列の操作のリマインドの場: 繰り返し（id 7）と 1 回だけ（id 8）。確認は記録だけ（opts を返す） */
function remindFlows() {
  const loaded = loadViews({ v3: true });
  const { SA } = loaded;
  const store = SA.store as Record<string, unknown>;
  const reloads: string[] = [];
  store.reload = (key: string) => {
    reloads.push(key);
    return Promise.resolve();
  };
  store.reminders = [
    { id: 7, kind: "notify", text: "毎朝の\n薬", rule: "daily@09:00", ruleText: "毎日 9:00", nextAt: "2026-01-02T00:00:00Z" },
    { id: 8, kind: "notify", text: "1 回", rule: null, ruleText: null, nextAt: "2026-01-03T00:00:00Z" },
  ];
  SA.topics = { data: () => null };
  const draws: Array<{ busy: string[]; busyOp: Record<string, string> }> = [];
  SA.deck = {
    draw: (st: { busy: string[]; busyOp: Record<string, string> }) => {
      draws.push({ busy: [...st.busy], busyOp: { ...st.busyOp } });
      return true;
    },
  };
  const asks: Array<Record<string, unknown>> = [];
  (SA.ui as { confirm: unknown }).confirm = (opts: Record<string, unknown>) => void asks.push(opts);
  vm.runInNewContext(read("flows.js"), { window: { SA } });
  const flows = SA.flows as { state: () => { busy: string[]; busyOp: Record<string, string>; on: { op: (item: unknown, opId: string) => void } } };
  const tick = async () => {
    for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r));
  };
  // vm の中の配列・物は別の realm なので、比べる前に写す
  const st = () => JSON.parse(JSON.stringify({ busy: flows.state().busy, busyOp: flows.state().busyOp })) as { busy: string[]; busyOp: Record<string, string> };
  return { ...loaded, reloads, draws, asks, st, on: flows.state().on, tick };
}

test("web static: 流れの列の操作: リマインドの［次を飛ばす］は確認なしで POST /skip を 1 回（応答までの二度押しは送らない・busyOp は skip）→ 知らせ「次の回を飛ばしました。次は … です」。1 回だけのリマインドは送らない", async () => {
  const { SA, posts, toasts, setReply, reloads, draws, asks, st, on, tick } = remindFlows();
  const views = SA.views as Record<string, unknown>;
  for (const name of ["skipReminder", "stopReminder", "stopReminderAsk"]) assert.equal(typeof views[name], "function", name);
  let answer: (v: unknown) => void = () => undefined;
  setReply(() => new Promise((r) => (answer = r)));
  on.op({ key: "rem:7" }, "skip");
  on.op({ key: "rem:7" }, "skip");
  on.op({ key: "rem:7" }, "cancel");
  assert.deepEqual(posts, ["/api/reminders/7/skip"]);
  assert.equal(asks.length, 0);
  assert.deepEqual([st().busy, st().busyOp], [["rem:7"], { "rem:7": "skip" }]);
  assert.deepEqual(draws.at(-1), { busy: ["rem:7"], busyOp: { "rem:7": "skip" } });
  answer({ next: "2026-01-03T00:00:00Z" });
  await tick();
  const when = (SA.ui as { dateTime: (at: string) => string }).dateTime("2026-01-03T00:00:00Z");
  assert.deepEqual(toasts, ["次の回を飛ばしました。次は " + when + " です"]);
  assert.deepEqual(reloads, ["reminders"]);
  assert.deepEqual([st().busy, st().busyOp], [[], {}]);
  // 応答の後はもう一度押せる（もう 1 回飛ばす。確認は足さない）。next が無ければ「-」
  setReply(() => Promise.resolve({}));
  on.op({ key: "rem:7" }, "skip");
  await tick();
  assert.deepEqual(posts, ["/api/reminders/7/skip", "/api/reminders/7/skip"]);
  assert.equal(toasts.at(-1), "次の回を飛ばしました。次は - です");
  // 1 回だけのリマインド・引けないリマインドの skip は送らない
  on.op({ key: "rem:8" }, "skip");
  on.op({ key: "rem:99" }, "skip");
  on.op({ key: "rem:99" }, "cancel");
  await tick();
  assert.equal(posts.length, 2);
  assert.equal(asks.length, 0);
  assert.deepEqual(st().busy, []);
});

test("web static: 流れの列の操作: リマインドの［止める］は確認（古い表と同じ字）が開くまで POST も busy も無く、閉じただけなら送らない。OK の後に POST /cancel 1 回と知らせ。失敗で busy が外れる", async () => {
  const { posts, toasts, setReply, reloads, draws, asks, st, on, tick } = remindFlows();
  const drawn = draws.length;
  on.op({ key: "rem:7" }, "cancel");
  assert.equal(asks.length, 1);
  const ask = asks[0]!;
  assert.deepEqual(
    Object.fromEntries(Object.entries(ask).filter(([k]) => k !== "run")),
    { title: "止めますか", target: "毎朝の\n薬", body: "止めたリマインドは戻せません。", ok: "止める", danger: true },
  );
  assert.equal(typeof ask.run, "function");
  // 確認の間（閉じただけでも）: 送らず busy も無く、描き直さない
  await tick();
  assert.deepEqual([posts, st().busy, draws.length], [[], [], drawn]);
  // OK: busy は cancel・POST は 1 回
  let answer: (v: unknown) => void = () => undefined;
  setReply(() => new Promise((r) => (answer = r)));
  (ask.run as () => void)();
  (ask.run as () => void)();
  on.op({ key: "rem:7" }, "skip");
  assert.deepEqual(posts, ["/api/reminders/7/cancel"]);
  assert.deepEqual([st().busy, st().busyOp], [["rem:7"], { "rem:7": "cancel" }]);
  answer({});
  await tick();
  assert.deepEqual(toasts, ["「毎朝の 薬」を止めました"]);
  assert.deepEqual(reloads, ["reminders"]);
  assert.deepEqual(st().busy, []);
  // 1 回だけのリマインドも止められる。失敗したら busy が外れ、もう一度押せる
  posts.length = 0;
  setReply(() => Promise.reject({ status: 500 }));
  on.op({ key: "rem:8" }, "cancel");
  (asks.at(-1)!.run as () => void)();
  await tick();
  assert.deepEqual(posts, ["/api/reminders/8/cancel"]);
  assert.equal(toasts.at(-1), "操作に失敗しました。もう一度試してください");
  assert.deepEqual(st().busy, []);
  on.op({ key: "rem:8" }, "cancel");
  assert.equal(asks.length, 3);
});

test("web static: 古い表のリマインド（renderReminders）は流れの列と同じ skipReminder・stopReminder・stopReminderAsk を呼ぶ（文言の元は 1 つ）", () => {
  const views = read("views.js");
  const start = views.indexOf("function renderReminders(");
  const body = views.slice(start, views.indexOf("\n  }\n", start));
  assert.match(body, /skipReminder\(skip, r\)/);
  assert.match(body, /confirm\(Object\.assign\(stopReminderAsk\(r\), \{ run: \(\) => stopReminder\(stop, r\) \}\)\)/);
  assert.doesNotMatch(body, /\/api\/reminders\/|止めますか|次の回を飛ばしました/);
  for (const text of ["止めますか", "止めたリマインドは戻せません。", "次の回を飛ばしました。次は ", "」を止めました"]) assert.equal(views.split(text).length - 1, 1, text);
});

/** api.js と flows.js を同じ偽の window で読む（SA.api.get は get。topics・views・ui は作り物） */
function loadFlows(get: (path: string) => Promise<unknown>) {
  const SA: Record<string, unknown> = {
    app: { shownChannelIds: () => [], activeTabId: () => null, refresh: () => undefined, refreshStatus: () => undefined, refreshSidebar: () => undefined, refreshNotices: () => undefined, open: () => undefined },
    chat: { markSeenShown: () => undefined },
    ui: { toast: () => undefined, shortTime: () => "12:00" },
    topics: { data: () => null },
    views: { ago: () => "", dayLabel: (d: string) => d, oneLine: (t: string) => t, githubParts: () => null },
  };
  const ctx: Record<string, unknown> = {
    window: { SA, localStorage: { getItem: () => null, setItem: () => undefined }, addEventListener: () => undefined },
    document: { visibilityState: "visible", addEventListener: () => undefined },
    setTimeout: () => 0,
    clearTimeout: () => undefined,
    Promise,
  };
  vm.runInNewContext(read("api.js"), ctx);
  (SA.api as { get: (path: string) => Promise<unknown> }).get = get;
  vm.runInNewContext(read("flows.js"), ctx);
  return SA as Record<string, unknown> & {
    store: { status: unknown; want: (keys: string[]) => void; load: { lists: () => Promise<unknown> } };
    flows: { init: () => void; status: () => void; state: () => Record<string, unknown>; lastKey: () => string | null };
  };
}

test("web static: 流れの列の読み込み: init でタスク（open）とリマインドを読み、一度も読んでいなくても lists で読み直す。GitHub は有効と分かるまで読まず、分かった回に 1 回", async () => {
  const paths: string[] = [];
  const SA = loadFlows((path) => {
    paths.push(path);
    return Promise.resolve({});
  });
  // 何も足していなければ lists はタスク・リマインドを読まない。init の前の status は GitHub を読まない
  await SA.store.load.lists();
  SA.store.status = { github: { enabled: true } };
  SA.flows.status();
  assert.equal(paths.length, 0);
  SA.store.status = null;
  SA.flows.init();
  SA.flows.init();
  assert.deepEqual(paths, ["/api/tasks?status=open", "/api/reminders"]);
  await new Promise((r) => setImmediate(r));
  paths.length = 0;
  await SA.store.load.lists();
  assert.deepEqual(paths.sort(), ["/api/reminders", "/api/tasks?status=open"]);
  // GitHub
  paths.length = 0;
  SA.store.status = { github: { enabled: false } };
  SA.flows.status();
  await SA.store.load.lists();
  assert.ok(!paths.some((p) => p.startsWith("/api/github")));
  assert.equal(SA.flows.state().github, null);
  SA.store.status = { github: { enabled: true } };
  SA.flows.status();
  SA.flows.status();
  assert.equal(paths.filter((p) => p.startsWith("/api/github")).length, 1);
  await new Promise((r) => setImmediate(r));
  paths.length = 0;
  await SA.store.load.lists();
  assert.equal(paths.filter((p) => p.startsWith("/api/github")).length, 1);
  // store.want で足した物は読んでいなくても読む
  const other = loadFlows((path) => {
    paths.push(path);
    return Promise.resolve({});
  });
  paths.length = 0;
  other.store.want(["memories"]);
  await other.store.load.lists();
  assert.deepEqual(paths, ["/api/memories"]);
  // 押した項目の key は 1 回だけ
  const st = other.flows.state() as { on: { open: (item: unknown, key: string) => void }; ops: boolean; cols: number };
  assert.equal(st.ops, true);
  assert.equal(st.cols, 3);
  st.on.open({ target: "ch:1" }, "turn:ch:1");
  assert.equal(other.flows.lastKey(), "turn:ch:1");
  assert.equal(other.flows.lastKey(), null);
});
