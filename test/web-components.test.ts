import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

// 部品（c-*.css・c-*.js）の見張り（docs/plan/web-ui-components.md §7.3）。K2 の寸法のトークンは tokens.css の --c-*
const ROOT = fileURLToPath(new URL("../", import.meta.url));
const STATIC_DIR = join(ROOT, "src/web/static");
const read = (name: string): string => readFileSync(join(STATIC_DIR, name), "utf8");
const CSS_FILES = readdirSync(STATIC_DIR).filter((n) => /^c-.*\.css$/.test(n)).sort();
const JS_FILES = readdirSync(STATIC_DIR).filter((n) => /^c-.*\.js$/.test(n)).sort();

/** §7.2 の寸法のトークンの名前（tokens.css の末尾） */
const C_TOKENS = [
  "tap", "bar-h", "bottom-h", "row-h", "gutter", "list-w", "hand-w", "bubble-r", "bubble-tail", "card-r", "btn-sm-h", "round-r",
  "icon", "icon-sm", "mark", "mark-ring", "badge-h", "badge-pad", "seg-h", "seg-pad", "toast-w", "spin", "font-body",
].map((n) => `--c-${n}`);

/** c-*.css が var() で使ってよい --c-* 以外の変数（base.css の目盛り・tokens.css の色・動き・重なり・字） */
const ALLOWED_VARS: ReadonlySet<string> = new Set([
  ...[1, 2, 3, 4, 5, 6, 7, 8].map((n) => `space-${n}`),
  "font-xs", "font-sm", "font-base", "leading-normal", "leading-tight", "weight-normal", "weight-medium", "weight-semibold",
  "radius-sm", "radius-md", "radius-lg", "radius-full", "border-width", "ring-width", "dialog-max", "container-max",
  "bg", "surface", "muted", "border", "text", "text-secondary", "text-muted", "primary", "primary-text", "accent", "danger", "success", "warning", "backdrop", "shadow-sm",
  "dur-micro", "dur-short", "dur-long", "ease-out", "z-toast", "font-mono",
].map((n) => `--${n}`));

/** ファイルごとのセレクタの頭（c-gallery.css は test/web-vendor.test.ts がもっと狭く見ている） */
const SELECTOR_HEAD: Record<string, RegExp> = {
  "c-atoms.css": /^\.c-(?:icon|btn|iconbtn|badge|mark|seg|field|input|empty|loading)(?![a-z])/,
  "c-sheet.css": /^\.c-(?:sheet|confirm|toast)(?![a-z])/,
  "c-gallery.css": /^\.c-gallery(?![a-z])/,
};

const FINE = "(hover: hover) and (pointer: fine)";

type CssRule = { at: string[]; selectors: string[]; body: string };

const stripCssComments = (text: string): string => text.replace(/\/\*[\s\S]*?\*\//g, "");
const squash = (text: string): string => text.replace(/\s+/g, " ").trim();

/** コメントを消し、波括弧をたどって規則を返す（at は外側の at-rule の並び。@keyframes の中は返さない） */
function parseCss(text: string): CssRule[] {
  const src = stripCssComments(text);
  const rules: CssRule[] = [];
  const stack: Array<{ at: string | undefined; keyframes: boolean }> = [];
  let start = 0;
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (ch === "{") {
      const prelude = squash(src.slice(start, i));
      start = i + 1;
      if (prelude.startsWith("@")) {
        stack.push({ at: prelude, keyframes: prelude.startsWith("@keyframes") });
        continue;
      }
      const end = src.indexOf("}", i);
      if (end < 0) throw new Error(`閉じていない規則: ${prelude}`);
      const inKeyframes = stack.some((s) => s.keyframes);
      if (!inKeyframes) {
        rules.push({
          at: stack.map((s) => s.at ?? ""),
          selectors: prelude.split(",").map((s) => s.trim()),
          body: squash(src.slice(i + 1, end)),
        });
      }
      i = end;
      start = end + 1;
    } else if (ch === "}") {
      stack.pop();
      start = i + 1;
    } else if (ch === ";") {
      start = i + 1;
    }
  }
  return rules;
}

/** var(--x) の名前 */
const varsIn = (text: string): string[] => [...text.matchAll(/var\(\s*(--[a-z0-9-]+)/g)].map((m) => m[1] ?? "");

/** セレクタに出るクラスの名前 */
const classesInSelector = (selector: string): string[] => [...selector.matchAll(/\.([a-z][a-z0-9-]*)/g)].map((m) => m[1] ?? "");

/** 1 つの c-*.css の決まり（§8.1 の 2〜5・7）。破った所の文を返す */
function cssProblems(name: string, text: string): string[] {
  const problems: string[] = [];
  const src = stripCssComments(text);
  const head = SELECTOR_HEAD[name];
  for (const m of src.matchAll(/@([a-z-]+)/g)) {
    if (!["media", "keyframes", "starting-style", "supports"].includes(m[1] ?? "")) problems.push(`${name}: at-rule @${m[1]}`);
  }
  for (const rule of parseCss(text)) {
    for (const selector of rule.selectors) {
      if (selector === ":root") continue;
      if (!selector.startsWith(".c-")) problems.push(`${name}: .c- 始まりでないセレクタ ${selector}`);
      else if (head !== undefined && !head.test(selector)) problems.push(`${name}: このファイルの頭でないセレクタ ${selector}`);
      if (selector.includes(":hover") && !rule.at.some((at) => at.includes(FINE))) problems.push(`${name}: ${FINE} の外の :hover ${selector}`);
    }
    if (/#[0-9a-f]{3,8}\b|\b(?:rgba?|hsla?|oklch|oklab|color)\(|(?<![-\w])(?:white|black)(?![-\w])/i.test(rule.body)) {
      problems.push(`${name}: 色の値 ${rule.selectors.join(",")} { ${rule.body} }`);
    }
    for (const v of varsIn(rule.body)) {
      if (!v.startsWith("--c-") && !ALLOWED_VARS.has(v)) problems.push(`${name}: 許可リストに無い変数 ${v}`);
    }
    for (const m of rule.body.matchAll(/(?<![\w.-])(\d*\.?\d+)(px|rem|em|ms|s)\b/g)) {
      if (!(m[2] === "px" && Number(m[1]) === 0)) problems.push(`${name}: 単位付きの数 ${m[0]}（${rule.selectors.join(",")}）`);
    }
  }
  return problems;
}

/** tokens.css の --c-* の定義（:root の既定と、@media の中） */
function tokenDefs(): { base: Set<string>; media: Set<string> } {
  const base = new Set<string>();
  const media = new Set<string>();
  for (const rule of parseCss(read("tokens.css"))) {
    if (!rule.selectors.includes(":root")) continue;
    for (const m of rule.body.matchAll(/(--c-[a-z0-9-]+)\s*:/g)) (rule.at.length === 0 ? base : media).add(m[1] ?? "");
  }
  return { base, media };
}

/** JS のコメントを消す（文字列の中の // は残す。部品の JS の書き方に合わせた最小のもの） */
const stripJsComments = (text: string): string => text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'\\])\/\/.*$/gm, "$1");

/** JS が書くクラスの名前（class="…" と class: "…"） */
const classesInJs = (text: string): string[] =>
  [...text.matchAll(/\bclass(?:=|:\s*)"([^"]*)"/g)].flatMap((m) => (m[1] ?? "").split(/\s+/).filter((s) => s !== ""));

test("web components: c-*.css・c-*.js がそろっている", () => {
  for (const name of ["c-atoms.css", "c-gallery.css"]) assert.ok(CSS_FILES.includes(name), name);
  for (const name of ["c-atoms.js", "c-gallery.js", "c-lib.js"]) assert.ok(JS_FILES.includes(name), name);
});

test("web components: c-*.css のセレクタ・at-rule・色・変数・単位・:hover の決まり", () => {
  for (const name of CSS_FILES) assert.deepEqual(cssProblems(name, read(name)), [], name);
});

test("web components: c-*.css が使う --c-* は tokens.css に在り、PC の上書きは既定にも在る。§7.2 の名前が全部在る", () => {
  const { base, media } = tokenDefs();
  for (const name of C_TOKENS) assert.ok(base.has(name), `tokens.css に ${name} が無い`);
  for (const name of media) assert.ok(base.has(name), `${name}: @media の中だけに在る`);
  assert.match(squash(stripCssComments(read("tokens.css"))), /@media \(min-width: 640px\) and \(hover: hover\) and \(pointer: fine\) \{ :root \{/);
  for (const file of CSS_FILES) {
    for (const v of varsIn(stripCssComments(read(file)))) if (v.startsWith("--c-")) assert.ok(base.has(v), `${file}: ${v} が tokens.css に無い`);
  }
});

test("web components: animation を書いた c-*.css は reduced-motion で止め、c-sheet.css は下の余白とスマホの幅を持つ", () => {
  for (const name of CSS_FILES) {
    const rules = parseCss(read(name));
    if (rules.some((r) => /(?:^|; ?)animation\s*:/.test(r.body) && !/animation:\s*none/.test(r.body))) {
      assert.ok(
        rules.some((r) => r.at.some((at) => at.includes("prefers-reduced-motion: reduce")) && /animation:\s*none/.test(r.body)),
        `${name}: prefers-reduced-motion の animation: none`,
      );
    }
  }
  if (CSS_FILES.includes("c-sheet.css")) {
    const sheet = read("c-sheet.css");
    assert.match(sheet, /env\(safe-area-inset-bottom/);
    assert.match(sheet, /@media \(max-width: 639px\)/);
  }
});

test("web components: c-*.js のクラスは c- の固定の文字列だけで、c-gallery.js は c-gallery だけ。defaultProps が無い", () => {
  for (const name of JS_FILES.filter((n) => n !== "c-lib.js")) {
    const js = read(name);
    for (const cls of classesInJs(js)) {
      assert.match(cls, /^c-[a-z0-9-]+$/, `${name}: ${cls}`);
      if (name === "c-gallery.js") assert.match(cls, /^c-gallery(?:-|$)/, `${name}: ${cls}`);
    }
    assert.doesNotMatch(js, /class=\$\{|className|classList/, name);
    assert.doesNotMatch(js, /defaultProps/, name);
  }
});

test("web components: 部品（入口以外の c-*.js）は document・window などに触らず、style の語を書かない", () => {
  // 入口（見本の c-gallery.js。K3 から c-app.js も）と c-lib.js は対象外
  for (const name of JS_FILES.filter((n) => !["c-lib.js", "c-gallery.js"].includes(n))) {
    const js = stripJsComments(read(name));
    assert.doesNotMatch(js, /\b(?:document|window|SA|fetch|globalThis)\b/, name);
    assert.doesNotMatch(js, /ownerDocument|getRootNode|activeElement/, name);
    assert.doesNotMatch(js, /\bstyle\b/, name);
  }
});

test("web components: import の先（c-atoms は c-lib だけで hook なし、c-sheet は c-lib と c-atoms だけ）と createPortal が無い", () => {
  const from = (js: string): string[] => [...js.matchAll(/\bfrom\s+"([^"]+)"/g)].map((m) => m[1] ?? "");
  const allowed: Record<string, string[]> = { "c-atoms.js": ["./c-lib.js"], "c-sheet.js": ["./c-lib.js", "./c-atoms.js"] };
  for (const [name, targets] of Object.entries(allowed)) {
    if (!JS_FILES.includes(name)) continue;
    const js = read(name);
    for (const target of from(js)) assert.ok(targets.includes(target), `${name}: ${target}`);
  }
  if (JS_FILES.includes("c-atoms.js")) assert.doesNotMatch(read("c-atoms.js"), /import\s*\{[^}]*\buse[A-Z]/);
  for (const name of JS_FILES) assert.doesNotMatch(read(name), /createPortal/, name);
});

test("web components: c-*.css のセレクタのクラスと、c-*.js（と gallery.html）が書くクラスが同じ集まり", () => {
  const inCss = new Set(CSS_FILES.flatMap((name) => parseCss(read(name)).flatMap((r) => r.selectors.flatMap(classesInSelector))));
  // 見本の根（c-gallery）は gallery.html に在る
  const inJs = new Set([...JS_FILES.filter((n) => n !== "c-lib.js").flatMap((name) => classesInJs(read(name))), ...classesInJs(read("gallery.html"))]);
  assert.deepEqual([...inCss].filter((c) => !inJs.has(c)).sort(), [], "CSS にだけ在るクラス");
  assert.deepEqual([...inJs].filter((c) => !inCss.has(c)).sort(), [], "JS にだけ在るクラス");
});

test("web components: 見張りの関数は悪い見本を落とす", () => {
  const bad = (text: string): string[] => cssProblems("c-atoms.css", text);
  assert.ok(bad("button{}").some((p) => p.includes(".c- 始まりでない")));
  assert.ok(bad(".c-btn{color:#fff}").some((p) => p.includes("色の値")));
  assert.ok(bad(".c-btn{color:rgb(0 0 0)}").some((p) => p.includes("色の値")));
  assert.ok(bad(".c-btn{color:white}").some((p) => p.includes("色の値")));
  assert.deepEqual(bad(".c-btn{white-space:nowrap}"), []);
  assert.ok(bad(".c-btn{height:36px}").some((p) => p.includes("単位付き")));
  assert.ok(bad(".c-btn{transition:opacity 200ms}").some((p) => p.includes("単位付き")));
  assert.deepEqual(bad(".c-btn{margin:0px;transform:scale(0.97)}"), []);
  assert.ok(bad(".c-btn{height:var(--row)}").some((p) => p.includes("--row")));
  assert.ok(bad(".c-btn{height:var(--tap)}").some((p) => p.includes("--tap")));
  assert.ok(bad(".c-btn:hover{color:var(--text)}").some((p) => p.includes(":hover")));
  assert.ok(bad("@media (hover:hover){.c-btn:hover{color:var(--text)}}").some((p) => p.includes(":hover")));
  assert.deepEqual(bad(`@media ${FINE}{.c-btn:hover{color:var(--text)}}`), []);
  assert.ok(bad(".c-sheet{color:var(--text)}").some((p) => p.includes("このファイルの頭")));
  assert.ok(bad("@import url(x.css);").some((p) => p.includes("@import")));
  assert.deepEqual(bad("@keyframes c-spin{to{transform:rotate(360deg)}}"), []);
  assert.deepEqual(parseCss("@media (x){@starting-style{.c-a{b:c}}} .c-d,.c-e{f:g}"), [
    { at: ["@media (x)", "@starting-style"], selectors: [".c-a"], body: "b:c" },
    { at: [], selectors: [".c-d", ".c-e"], body: "f:g" },
  ]);
});

// ===== モデルと出す形（§8.2。部品を import して呼ぶ。hook の無い部品だけ） =====
type VNode = { type: unknown; props: Record<string, unknown> };
type El = { type: string; props: Record<string, unknown>; children: Tree[] };
type Tree = El | string;
type Fn = (props: Record<string, unknown>) => unknown;
// 素の JS で型が無いので、URL を変数にして型の解決を避ける（test/web-vendor.test.ts と同じ）
const atomsUrl = new URL("../src/web/static/c-atoms.js", import.meta.url).href;
const atoms = (await import(atomsUrl)) as Record<string, Fn> & {
  ICONS_BASE: readonly string[];
  iconHref: (name: string) => string;
  buttonState: (s: Record<string, unknown>) => Record<string, unknown>;
  iconButtonLabel: (label: unknown, badge: unknown) => string;
  badgeText: (count: unknown) => string;
  MARK_STATES: readonly string[];
  markState: (state: unknown) => string;
  segmentedTabStop: (items: unknown[], value: unknown) => string | null;
  segmentedKey: (items: unknown[], current: unknown, key: string) => string | null;
  fieldControl: (id: string, o?: Record<string, unknown>) => Record<string, unknown>;
};
const libUrl = new URL("../src/web/static/c-lib.js", import.meta.url).href;
const { html } = (await import(libUrl)) as { html: (s: TemplateStringsArray, ...v: unknown[]) => unknown };

/** 関数の vnode をその関数で開き、要素の木にする（null・false・undefined は落とす） */
function expand(node: unknown): Tree[] {
  if (node === null || node === undefined || node === false || node === true) return [];
  if (Array.isArray(node)) return node.flatMap(expand);
  if (typeof node === "string" || typeof node === "number") return [String(node)];
  const v = node as VNode;
  if (typeof v.type === "function") return expand((v.type as Fn)(v.props));
  return [{ type: v.type as string, props: v.props, children: expand(v.props.children) }];
}

const one = (node: unknown): El => {
  const tree = expand(node);
  assert.equal(tree.length, 1);
  return tree[0] as El;
};

/** class が cls の要素を全部（木の順） */
function find(tree: Tree | Tree[], cls: string): El[] {
  const list = Array.isArray(tree) ? tree : [tree];
  return list.flatMap((t) => (typeof t === "string" ? [] : [...(String(t.props.class ?? "").split(" ").includes(cls) ? [t] : []), ...find(t.children, cls)]));
}

const textOf = (t: Tree | Tree[]): string => (Array.isArray(t) ? t.map(textOf).join("") : typeof t === "string" ? t : textOf(t.children));

/** onClick に渡す偽の event（preventDefault の回数を数える） */
function fakeEvent(): { preventDefault: () => void; count: () => number; currentTarget: { scrollIntoView: () => void } } {
  let n = 0;
  return { preventDefault: () => void n++, count: () => n, currentTarget: { scrollIntoView: () => undefined } };
}

test("web components: iconHref は base の sprite と app の sprite を分け、ICONS_BASE は icons.svg の symbol と同じ", () => {
  assert.equal(atoms.iconHref("x"), "/static/icons.svg#x");
  assert.equal(atoms.iconHref("send"), "/static/icons-app.svg#send");
  const ids = (file: string): string[] => [...readFileSync(file, "utf8").matchAll(/<symbol id="([^"]+)"/g)].map((m) => m[1] ?? "");
  const base = ids(join(ROOT, "templates/web/site/icons.svg"));
  assert.deepEqual([...atoms.ICONS_BASE].sort(), [...base].sort());
  // 見本で使う名前は 2 つの sprite のどちらかに在る
  const all = new Set([...base, ...ids(join(STATIC_DIR, "icons-app.svg"))]);
  for (const m of read("c-gallery.js").matchAll(/\bicon="([^"]+)"/g)) assert.ok(all.has(m[1] ?? ""), m[1]);
  const icon = one(html`<${atoms.Icon} name="x" />`);
  assert.equal(icon.props["data-size"], "md");
  assert.equal(icon.props["aria-hidden"], "true");
  assert.equal((icon.children[0] as El).props.href, "/static/icons.svg#x");
});

test("web components: buttonState は kind・size を丸め、disabled・busy で押せなくする", () => {
  assert.deepEqual(atoms.buttonState({}), { kind: "secondary", size: "md", inert: false, ariaDisabled: undefined, ariaBusy: undefined });
  assert.deepEqual(atoms.buttonState({ kind: "accent", size: "sm" }), { kind: "accent", size: "sm", inert: false, ariaDisabled: undefined, ariaBusy: undefined });
  assert.equal(atoms.buttonState({ kind: "warning", size: "lg" }).kind, "secondary");
  assert.equal(atoms.buttonState({ kind: "warning", size: "lg" }).size, "md");
  assert.deepEqual(atoms.buttonState({ kind: "danger", disabled: true }), { kind: "danger", size: "md", inert: true, ariaDisabled: "true", ariaBusy: undefined });
  assert.deepEqual(atoms.buttonState({ kind: "primary", busy: true }), { kind: "primary", size: "md", inert: true, ariaDisabled: "true", ariaBusy: "true" });
  assert.deepEqual(atoms.buttonState({ disabled: true, busy: true }).ariaBusy, "true");
});

test("web components: Button は押せるときだけ onPress を引数なしで呼び、押せないときは aria-disabled と preventDefault", () => {
  const calls: unknown[][] = [];
  const onPress = (...args: unknown[]): void => void calls.push(args);
  const on = one(html`<${atoms.Button} kind="primary" label="始める" onPress=${onPress} reason="今は送れません" />`);
  assert.equal(on.type, "button");
  assert.equal(on.props.type, "button");
  assert.equal(on.props["aria-disabled"], undefined);
  assert.equal(on.props["aria-busy"], undefined);
  assert.equal(on.props.title, undefined);
  assert.equal(on.props.autofocus, undefined);
  assert.equal("disabled" in on.props, false);
  assert.equal(textOf(find(on, "c-btn-label")), "始める");
  const e1 = fakeEvent();
  (on.props.onClick as (e: unknown) => void)(e1);
  assert.deepEqual(calls, [[]]);
  assert.equal(e1.count(), 0);

  const off = one(html`<${atoms.Button} label="開く" disabled=${true} reason="今は送れません" onPress=${onPress} />`);
  assert.equal(off.props["aria-disabled"], "true");
  assert.equal(off.props.title, "今は送れません");
  assert.equal("disabled" in off.props, false);
  const e2 = fakeEvent();
  (off.props.onClick as (e: unknown) => void)(e2);
  assert.equal(calls.length, 1);
  assert.equal(e2.count(), 1);

  const busy = one(html`<${atoms.Button} label="送っています…" icon="send" busy=${true} onPress=${onPress} />`);
  assert.equal(busy.props["aria-busy"], "true");
  assert.equal(busy.props["aria-disabled"], "true");
  assert.equal(find(busy, "c-btn-spin").length, 1);
  assert.equal(find(busy, "c-icon").length, 0);
  (busy.props.onClick as (e: unknown) => void)(fakeEvent());
  assert.equal(calls.length, 1);

  const icon = one(html`<${atoms.Button} label="送る" icon="send" autofocus=${true} />`);
  assert.equal(find(icon, "c-icon").length, 1);
  assert.equal(find(icon, "c-icon")[0]?.props["data-size"], "sm");
  assert.equal(icon.props.autofocus, true);
});

test("web components: iconButtonLabel と IconButton は名前を必須にし、件数を名前に足す", () => {
  assert.throws(() => atoms.iconButtonLabel("", 0), TypeError);
  assert.throws(() => atoms.iconButtonLabel(undefined, 0), TypeError);
  assert.equal(atoms.iconButtonLabel("知らせ", 0), "知らせ");
  assert.equal(atoms.iconButtonLabel("知らせ", 3), "知らせ（3 件）");
  assert.equal(atoms.iconButtonLabel("知らせ", 120), "知らせ（99+ 件）");
  const b = one(html`<${atoms.IconButton} icon="bell" label="知らせ" badge=${3} />`);
  assert.equal(b.props["aria-label"], "知らせ（3 件）");
  assert.equal(b.props.title, "知らせ");
  assert.equal(b.props["data-size"], "md");
  assert.equal(textOf(find(b, "c-badge")), "3");
  const plain = one(html`<${atoms.IconButton} icon="x" label="閉じる" size="sm" />`);
  assert.equal(find(plain, "c-badge").length, 0);
  assert.equal(plain.props["data-size"], "sm");
  assert.equal(plain.props["aria-disabled"], undefined);
  const calls: unknown[][] = [];
  const off = one(html`<${atoms.IconButton} icon="settings" label="設定" disabled=${true} onPress=${(...a: unknown[]) => void calls.push(a)} />`);
  assert.equal(off.props["aria-disabled"], "true");
  const e = fakeEvent();
  (off.props.onClick as (e: unknown) => void)(e);
  assert.equal(calls.length, 0);
  assert.equal(e.count(), 1);
  assert.throws(() => expand(html`<${atoms.IconButton} icon="x" />`), TypeError);
});

test("web components: badgeText と Badge（1 未満・数でない物は出さない、99+）", () => {
  for (const v of [0, -1, Number.NaN, "3", undefined]) assert.equal(atoms.badgeText(v), "", String(v));
  assert.deepEqual([1, 99, 99.9].map(atoms.badgeText), ["1", "99", "99"]);
  assert.deepEqual([100, Infinity].map(atoms.badgeText), ["99+", "99+"]);
  assert.equal(atoms.Badge({ count: 0 }), null);
  const b = one(html`<${atoms.Badge} count=${12} tone="accent" />`);
  assert.equal(b.props["data-tone"], "accent");
  assert.equal(textOf(b), "12");
  assert.equal(one(html`<${atoms.Badge} count=${1} tone="loud" />`).props["data-tone"], "warning");
});

test("web components: markState と Mark（知らない値は none、label が在れば img、無ければ読み上げない）", () => {
  assert.deepEqual([...atoms.MARK_STATES], ["turn", "running", "unread", "none"]);
  for (const s of atoms.MARK_STATES) assert.equal(atoms.markState(s), s);
  assert.equal(atoms.markState("busy"), "none");
  assert.equal(atoms.markState(undefined), "none");
  const hidden = one(html`<${atoms.Mark} state="turn" />`);
  assert.equal(hidden.props["data-state"], "turn");
  assert.equal(hidden.props["aria-hidden"], "true");
  assert.equal(hidden.props.role, undefined);
  const named = one(html`<${atoms.Mark} state="unread" label="未読" />`);
  assert.equal(named.props.role, "img");
  assert.equal(named.props["aria-label"], "未読");
  assert.equal(named.props["aria-hidden"], undefined);
});

const SEG = [
  { value: "a", label: "A" },
  { value: "b", label: "B", disabled: true },
  { value: "c", label: "C" },
  { value: "d", label: "D" },
];

test("web components: segmentedTabStop は選択中か最初の押せる項目、無ければ null", () => {
  assert.equal(atoms.segmentedTabStop(SEG, "c"), "c");
  assert.equal(atoms.segmentedTabStop(SEG, "b"), "a");
  assert.equal(atoms.segmentedTabStop(SEG, "z"), "a");
  assert.equal(atoms.segmentedTabStop([{ value: "a", label: "A", disabled: true }], "a"), null);
});

test("web components: segmentedKey は押せない項目を飛ばして端で折り返し、Home・End、ほかのキーは null", () => {
  assert.equal(atoms.segmentedKey(SEG, "a", "ArrowRight"), "c");
  assert.equal(atoms.segmentedKey(SEG, "a", "ArrowDown"), "c");
  assert.equal(atoms.segmentedKey(SEG, "c", "ArrowLeft"), "a");
  assert.equal(atoms.segmentedKey(SEG, "c", "ArrowUp"), "a");
  assert.equal(atoms.segmentedKey(SEG, "d", "ArrowRight"), "a");
  assert.equal(atoms.segmentedKey(SEG, "a", "ArrowLeft"), "d");
  assert.equal(atoms.segmentedKey(SEG, "c", "Home"), "a");
  assert.equal(atoms.segmentedKey(SEG, "a", "End"), "d");
  assert.equal(atoms.segmentedKey(SEG, "a", "Home"), null);
  assert.equal(atoms.segmentedKey(SEG, "a", "Enter"), null);
  assert.equal(atoms.segmentedKey([{ value: "a", label: "A" }], "a", "ArrowRight"), null);
  assert.equal(atoms.segmentedKey([{ value: "a", label: "A", disabled: true }], "a", "ArrowRight"), null);
});

test("web components: Segmented は radiogroup で、選択中と Tab の入口は 1 つだけ。選択中・押せない項目では onChange を呼ばない", () => {
  const changes: string[] = [];
  const g = one(html`<${atoms.Segmented} items=${SEG} value="c" label="画面" onChange=${(v: string) => void changes.push(v)} />`);
  assert.equal(g.props.role, "radiogroup");
  assert.equal(g.props["aria-label"], "画面");
  const items = find(g, "c-seg-item");
  assert.equal(items.length, 4);
  assert.deepEqual(items.map((i) => i.props["aria-checked"]), ["false", "false", "true", "false"]);
  assert.deepEqual(items.map((i) => i.props.tabindex), [-1, -1, 0, -1]);
  assert.deepEqual(items.map((i) => i.props["aria-disabled"]), [undefined, "true", undefined, undefined]);
  assert.ok(items.every((i) => i.props.role === "radio" && i.props.type === "button"));
  const click = (i: number): void => (items[i]?.props.onClick as (e: unknown) => void)(fakeEvent());
  click(2);
  click(1);
  assert.deepEqual(changes, []);
  click(3);
  assert.deepEqual(changes, ["d"]);
  const six = one(html`<${atoms.Segmented} items=${["1", "2", "3", "4", "5", "6"].map((v) => ({ value: v, label: v }))} value="1" label="タブ" onChange=${() => undefined} />`);
  assert.equal(find(six, "c-seg-item").length, 6);
});

test("web components: fieldControl と Field（説明・誤りの結び付き、label の for、誤りの入れ物は常に在る）", () => {
  assert.deepEqual(atoms.fieldControl("f"), { id: "f", class: "c-input", "aria-describedby": undefined, "aria-invalid": undefined });
  assert.equal(atoms.fieldControl("f", { hint: "h" })["aria-describedby"], "f-hint");
  assert.equal(atoms.fieldControl("f", { error: "e" })["aria-describedby"], "f-error");
  assert.equal(atoms.fieldControl("f", { hint: "h", error: "e" })["aria-describedby"], "f-hint f-error");
  assert.equal(atoms.fieldControl("f", { error: "e" })["aria-invalid"], "true");
  const f = one(html`<${atoms.Field} id="g-title" label="題名" hint="省けます">${(c: Record<string, unknown>) => html`<input ...${c} type="text" />`}<//>`);
  const label = find(f, "c-field-label")[0];
  const input = find(f, "c-input")[0];
  assert.equal(label?.type, "label");
  assert.equal(label?.props.for, "g-title");
  assert.equal(input?.props.id, "g-title");
  assert.equal(input?.props["aria-describedby"], "g-title-hint");
  assert.equal(find(f, "c-field-hint")[0]?.props.id, "g-title-hint");
  const err = find(f, "c-field-error")[0];
  assert.equal(err?.props.id, "g-title-error");
  assert.equal(err?.props.role, "alert");
  assert.equal(textOf(err as El), "");
  const bad = one(html`<${atoms.Field} id="g-x" label="題名" error="題名を入れてください">${(c: Record<string, unknown>) => html`<input ...${c} />`}<//>`);
  assert.equal(find(bad, "c-field-hint").length, 0);
  assert.equal(find(bad, "c-input")[0]?.props["aria-invalid"], "true");
  assert.equal(textOf(find(bad, "c-field-error")), "題名を入れてください");
});

test("web components: Empty・Loading（action の有り無し、Loading の既定の文と role=status）", () => {
  const e = one(html`<${atoms.Empty} text="まだありません" />`);
  assert.equal(textOf(find(e, "c-empty-text")), "まだありません");
  assert.equal(e.children.length, 1);
  const withAction = one(html`<${atoms.Empty} text="まだありません" action=${html`<${atoms.Button} label="始める" />`} />`);
  assert.equal(find(withAction, "c-btn").length, 1);
  const l = one(html`<${atoms.Loading} />`);
  assert.equal(l.props.role, "status");
  assert.equal(l.props["aria-busy"], undefined);
  assert.equal(textOf(find(l, "c-loading-text")), "読み込んでいます…");
  assert.equal(l.children.length, 1);
});
