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
    assert.doesNotMatch(text, /setAttribute\(\s*"style"|\.innerHTML|\.outerHTML|insertAdjacentHTML|document\.write|\beval\(|new Function\(/, name);
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

function loadToast() {
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
    window: {} as Record<string, unknown>,
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
  assert.match(html, /<meta name="apple-mobile-web-app-status-bar-style" content="default">/);
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
