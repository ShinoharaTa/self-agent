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
  "icon", "icon-sm", "mark", "mark-ring", "badge-h", "badge-pad", "seg-h", "seg-pad", "toast-w", "spin", "font-body", "row-indent", "list-gap",
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
  "c-list.css": /^\.c-(?:list|turns|turn|group|rows|row|fold)(?![a-z])/,
  "c-shell.css": /^\.c-bottom(?![a-z])/,
  "c-gallery.css": /^\.c-gallery(?![a-z])/,
};

const FINE = "(hover: hover) and (pointer: fine)";

type CssRule = { at: string[]; selectors: string[]; body: string; keyframe: boolean };

const stripCssComments = (text: string): string => text.replace(/\/\*[\s\S]*?\*\//g, "");
const squash = (text: string): string => text.replace(/\s+/g, " ").trim();

/** 入れ子の規則のセレクタ（& を親に置き換える。& が無ければ親の子孫） */
const nestSelectors = (parents: string[], own: string[]): string[] =>
  parents.length === 0 ? own : parents.flatMap((p) => own.map((o) => (o.includes("&") ? o.replaceAll("&", p) : `${p} ${o}`)));

/**
 * コメントを消し、波括弧をたどって規則を返す。at は外側の at-rule の並び、body はその規則の宣言だけ（入れ子の規則は別の項目）。
 * 入れ子の規則（&:hover など）のセレクタは親と組み合わせる。@keyframes の中の規則は keyframe: true（セレクタの決まりは見ない）
 */
function parseCss(text: string): CssRule[] {
  const src = stripCssComments(text);
  const rules: CssRule[] = [];
  type Frame = { at?: string; selectors?: string[]; keyframe: boolean; body: string };
  const stack: Frame[] = [];
  const top = (): Frame | undefined => stack[stack.length - 1];
  let start = 0;
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (ch === "{") {
      const prelude = squash(src.slice(start, i));
      start = i + 1;
      const inKeyframes = stack.some((f) => f.keyframe);
      if (prelude.startsWith("@")) {
        stack.push({ at: prelude, keyframe: inKeyframes || prelude.startsWith("@keyframes"), body: "" });
      } else {
        const own = prelude.split(",").map((sel) => sel.trim());
        const parent = [...stack].reverse().find((f) => f.selectors !== undefined);
        stack.push({ selectors: nestSelectors(parent?.selectors ?? [], own), keyframe: inKeyframes, body: "" });
      }
    } else if (ch === ";") {
      const frame = top();
      if (frame?.selectors !== undefined) frame.body += src.slice(start, i + 1);
      start = i + 1;
    } else if (ch === "}") {
      const frame = stack.pop();
      if (frame?.selectors !== undefined) {
        frame.body += src.slice(start, i);
        rules.push({ at: stack.flatMap((f) => (f.at === undefined ? [] : [f.at])), selectors: frame.selectors, body: squash(frame.body), keyframe: frame.keyframe });
      }
      start = i + 1;
    }
  }
  if (stack.length > 0) throw new Error("閉じていない波括弧");
  return rules;
}

/** var(--x) の名前 */
const varsIn = (text: string): string[] => [...text.matchAll(/var\(\s*(--[a-z0-9-]+)/g)].map((m) => m[1] ?? "");

/** セレクタに出るクラスの名前（全部） */
const classesInSelector = (selector: string): string[] => [...selector.matchAll(/\.(-?[A-Za-z_][\w-]*)/g)].map((m) => m[1] ?? "");

const COLOR_VALUE = /#[0-9a-f]{3,8}\b|\b(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch|color|color-mix|light-dark)\(|(?<![-\w])(?:white|black)(?![-\w])/i;
/** 単位付きの数（負の数・大文字の単位も） */
const UNIT_NUMBER = /(?<![\w.])-?(\d*\.?\d+)(px|rem|em|ms|s)\b/gi;

/** 1 つの c-*.css の決まり（§8.1 の 2〜5・7）。破った所の文を返す */
function cssProblems(name: string, text: string): string[] {
  const problems: string[] = [];
  const src = stripCssComments(text);
  const head = SELECTOR_HEAD[name];
  for (const m of src.matchAll(/@([a-z-]+)/g)) {
    if (!["media", "keyframes", "starting-style", "supports"].includes(m[1] ?? "")) problems.push(`${name}: at-rule @${m[1]}`);
  }
  for (const rule of parseCss(text)) {
    if (!rule.keyframe) {
      for (const selector of rule.selectors) {
        if (selector === ":root") continue;
        if (!selector.startsWith(".c-")) problems.push(`${name}: .c- 始まりでないセレクタ ${selector}`);
        else if (head !== undefined && !head.test(selector)) problems.push(`${name}: このファイルの頭でないセレクタ ${selector}`);
        for (const cls of classesInSelector(selector)) if (!cls.startsWith("c-")) problems.push(`${name}: c- 始まりでないクラス .${cls}（${selector}）`);
        if (selector.includes(":hover") && !rule.at.some((at) => at.includes(FINE))) problems.push(`${name}: ${FINE} の外の :hover ${selector}`);
      }
    }
    if (COLOR_VALUE.test(rule.body)) problems.push(`${name}: 色の値 ${rule.selectors.join(",")} { ${rule.body} }`);
    for (const v of varsIn(rule.body)) {
      if (!v.startsWith("--c-") && !ALLOWED_VARS.has(v)) problems.push(`${name}: 許可リストに無い変数 ${v}`);
    }
    for (const m of rule.body.matchAll(UNIT_NUMBER)) {
      if (!((m[2] ?? "").toLowerCase() === "px" && Number(m[1]) === 0)) problems.push(`${name}: 単位付きの数 ${m[0]}（${rule.selectors.join(",")}）`);
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

/** JS のコメントを消す（文字列の中の // と htm の閉じ <//> は残す。部品の JS の書き方に合わせた最小のもの） */
const stripJsComments = (text: string): string => text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'\\<])\/\/.*$/gm, "$1");

/** JS が書くクラスの名前（class="…"・class='…'・class = "…" と class: "…"） */
const classesInJs = (text: string): string[] =>
  [...text.matchAll(/\bclass\s*[=:]\s*(["'])(.*?)\1/g)].flatMap((m) => (m[2] ?? "").split(/\s+/).filter((s) => s !== ""));

/** import の先（二重・単引用符）と動的な import の有無 */
const importsOf = (text: string): { from: string[]; dynamic: boolean } => ({
  from: [...text.matchAll(/\bfrom\s*(["'])([^"']+)\1/g)].map((m) => m[2] ?? ""),
  dynamic: /\bimport\s*\(/.test(stripJsComments(text)),
});

/** 部品（入口・c-lib.js 以外の c-*.js）が触ってはいけない物（§8.1 の 9） */
function partProblems(name: string, text: string): string[] {
  const js = stripJsComments(text);
  const problems: string[] = [];
  for (const m of js.matchAll(/\b(document|window|SA|fetch|globalThis|location|localStorage|sessionStorage|navigator|matchMedia|setTimeout|setInterval)\b/g)) problems.push(`${name}: ${m[1]}`);
  for (const m of js.matchAll(/ownerDocument|getRootNode|activeElement/g)) problems.push(`${name}: ${m[0]}`);
  if (/\bstyle\b/.test(js)) problems.push(`${name}: style`);
  return problems;
}

test("web components: c-*.css・c-*.js がそろっている", () => {
  for (const name of ["c-atoms.css", "c-sheet.css", "c-gallery.css"]) assert.ok(CSS_FILES.includes(name), name);
  for (const name of ["c-atoms.js", "c-sheet.js", "c-gallery.js", "c-lib.js"]) assert.ok(JS_FILES.includes(name), name);
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
    // 背景の出入り（base.css の reduced-motion は ::backdrop に届かないので、ここで止める）
    const rules = parseCss(sheet);
    assert.ok(rules.some((r) => r.selectors.includes(".c-sheet::backdrop") && r.at.length === 0 && /transition-property: opacity/.test(r.body)));
    assert.ok(rules.some((r) => r.selectors.includes(".c-sheet::backdrop") && r.at.some((at) => at.includes("prefers-reduced-motion: reduce")) && /transition: none/.test(r.body)));
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

test("web components: 部品（入口以外の c-*.js）は document・window・location・タイマーなどに触らず、style の語を書かない", () => {
  // 入口（見本の c-gallery.js。K3 から c-app.js も）と c-lib.js は対象外
  for (const name of JS_FILES.filter((n) => !["c-lib.js", "c-gallery.js"].includes(n))) assert.deepEqual(partProblems(name, read(name)), [], name);
});

test("web components: import の先（c-atoms は c-lib だけ、c-sheet・c-list・c-shell は c-lib と c-atoms だけ。c-atoms・c-list・c-shell は hook なし）・動的な import と createPortal が無い", () => {
  const allowed: Record<string, string[]> = {
    "c-atoms.js": ["./c-lib.js"],
    "c-sheet.js": ["./c-lib.js", "./c-atoms.js"],
    "c-list.js": ["./c-lib.js", "./c-atoms.js"],
    "c-shell.js": ["./c-lib.js", "./c-atoms.js"],
  };
  for (const [name, targets] of Object.entries(allowed)) {
    if (!JS_FILES.includes(name)) continue;
    const { from, dynamic } = importsOf(read(name));
    for (const target of from) assert.ok(targets.includes(target), `${name}: ${target}`);
    assert.equal(dynamic, false, `${name}: 動的な import`);
  }
  for (const name of ["c-atoms.js", "c-list.js", "c-shell.js"]) if (JS_FILES.includes(name)) assert.doesNotMatch(read(name), /import\s*\{[^}]*\buse[A-Z]/, name);
  for (const name of JS_FILES) assert.doesNotMatch(read(name), /createPortal/, name);
});

test("web components: 一覧と下のバー（c-list・c-shell）は id を出さず、K2 の部品のクラスを書くのは決めた 3 つのセレクタだけ。動きを付けない", () => {
  // 部品は id を出さない（モデルのキー id: や data-topic=${id} は当たらない）
  for (const name of ["c-list.js", "c-shell.js"]) if (JS_FILES.includes(name)) assert.doesNotMatch(stripJsComments(read(name)), /(?<![\w-])id=/, name);
  // 部品の色・高さ・字を外から変えない（印の位置・PC の [+] の当たりを戻す・下のバーの並べ方だけ）
  const ALLOWED_OUTSIDE = new Set([".c-turn > .c-mark", '.c-group-head > .c-iconbtn[data-size="sm"]::after', '.c-bottom > .c-btn[data-size="sm"]']);
  const ATOM = /\.c-(?:btn|iconbtn|badge|mark|icon)(?![a-z-])/;
  for (const name of ["c-list.css", "c-shell.css"]) {
    if (!CSS_FILES.includes(name)) continue;
    const rules = parseCss(read(name));
    for (const rule of rules) for (const selector of rule.selectors) if (ATOM.test(selector)) assert.ok(ALLOWED_OUTSIDE.has(selector), `${name}: ${selector}`);
    for (const rule of rules) assert.doesNotMatch(rule.body, /(?:^|; ?)(?:animation|transition)(?:-[a-z-]+)?\s*:/, `${name}: ${rule.selectors.join(",")}`);
    assert.equal(rules.some((r) => r.keyframe), false, `${name}: @keyframes`);
  }
  // 作業中の輪を回さない
  for (const rule of parseCss(read("c-atoms.css"))) if (rule.selectors.some((s) => /^\.c-mark(?![a-z-])/.test(s))) assert.doesNotMatch(rule.body, /animation/, rule.selectors.join(","));
  if (CSS_FILES.includes("c-shell.css")) {
    const shell = stripCssComments(read("c-shell.css"));
    assert.match(shell, /env\(safe-area-inset-bottom/);
    assert.doesNotMatch(shell, /position:\s*(?:fixed|absolute)/);
  }
});

test("web components: c-*.css のセレクタのクラスと、c-*.js（と gallery.html）が書くクラスが同じ集まり", () => {
  const inCss = new Set(CSS_FILES.flatMap((name) => parseCss(read(name)).filter((r) => !r.keyframe).flatMap((r) => r.selectors.flatMap(classesInSelector))));
  // 見本の根（c-gallery）は gallery.html に在る
  const inJs = new Set([...JS_FILES.filter((n) => n !== "c-lib.js").flatMap((name) => classesInJs(read(name))), ...classesInJs(read("gallery.html"))]);
  assert.deepEqual([...inCss].filter((c) => !inJs.has(c)).sort(), [], "CSS にだけ在るクラス");
  assert.deepEqual([...inJs].filter((c) => !inCss.has(c)).sort(), [], "JS にだけ在るクラス");
});

test("web components: 見張りの関数は悪い見本を落とす", () => {
  const bad = (text: string): string[] => cssProblems("c-atoms.css", text);
  const hit = (text: string, part: string): void => assert.ok(bad(text).some((p) => p.includes(part)), `${text} → ${bad(text).join(" / ")}`);
  hit("button{}", ".c- 始まりでない");
  hit(".c-btn{color:#fff}", "色の値");
  hit(".c-btn{color:rgb(0 0 0)}", "色の値");
  hit(".c-btn{color:white}", "色の値");
  for (const fn of ["color-mix(in srgb, red, blue)", "hwb(0 0% 0%)", "lab(50% 0 0)", "lch(50% 0 0)", "oklab(0.5 0 0)", "oklch(0.5 0 0)", "light-dark(a, b)"]) hit(`.c-btn{color:${fn}}`, "色の値");
  assert.deepEqual(bad(".c-btn{white-space:nowrap}"), []);
  hit(".c-btn{height:36px}", "単位付き");
  hit(".c-btn{transition:opacity 200ms}", "単位付き");
  // 負の長さ・大文字の単位
  hit(".c-btn{margin:-5px}", "-5px");
  hit(".c-btn{inset:-8px}", "-8px");
  hit(".c-btn{top:calc(-4px)}", "-4px");
  hit(".c-btn{height:36PX}", "36PX");
  assert.deepEqual(bad(".c-btn{margin:0px;transform:scale(0.97);inset:calc(-1 * var(--border-width))}"), []);
  hit(".c-btn{height:var(--row)}", "--row");
  hit(".c-btn{height:var(--tap)}", "--tap");
  hit(".c-btn:hover{color:var(--text)}", ":hover");
  hit("@media (hover:hover){.c-btn:hover{color:var(--text)}}", ":hover");
  assert.deepEqual(bad(`@media ${FINE}{.c-btn:hover{color:var(--text)}}`), []);
  // 入れ子の最初の規則も :hover の検査に掛ける
  hit(".c-btn{color:var(--text); &:hover{color:var(--muted)}}", ":hover");
  assert.deepEqual(bad(`@media ${FINE}{.c-btn{&:hover{color:var(--muted)}}}`), []);
  // セレクタの中の全部のクラス
  hit(".c-btn .wb{color:var(--text)}", ".wb");
  hit(".c-btn.is-on{color:var(--text)}", ".is-on");
  hit(".c-sheet{color:var(--text)}", "このファイルの頭");
  assert.ok(cssProblems("c-shell.css", ".c-row{color:var(--text)}").some((p) => p.includes("このファイルの頭")));
  assert.ok(cssProblems("c-list.css", ".c-bottom{color:var(--text)}").some((p) => p.includes("このファイルの頭")));
  assert.deepEqual(cssProblems("c-list.css", ".c-rows{margin:0}"), []);
  hit("@import url(x.css);", "@import");
  assert.deepEqual(bad("@keyframes c-spin{to{transform:rotate(360deg)}}"), []);
  // @keyframes の中も色と単位を見る
  hit("@keyframes c-x{from{color:#000}}", "色の値");
  hit("@keyframes c-x{50%{transform:translateY(4px)}}", "4px");
  assert.deepEqual(parseCss("@media (x){@starting-style{.c-a{b:c}}} .c-d,.c-e{f:g; &:hover{h:i}} @keyframes k{to{j:k}}"), [
    { at: ["@media (x)", "@starting-style"], selectors: [".c-a"], body: "b:c", keyframe: false },
    { at: [], selectors: [".c-d:hover", ".c-e:hover"], body: "h:i", keyframe: false },
    { at: [], selectors: [".c-d", ".c-e"], body: "f:g;", keyframe: false },
    { at: ["@keyframes k"], selectors: ["to"], body: "j:k", keyframe: true },
  ]);

  // JS の拾い方
  assert.deepEqual(classesInJs(`html\`<p class='wb'></p><p class = "c-a c-b"></p>\`; const o = { class: "c-c" };`), ["wb", "c-a", "c-b", "c-c"]);
  assert.deepEqual(importsOf(`import { a } from './x.js';\nimport b from "./y.js";`), { from: ["./x.js", "./y.js"], dynamic: false });
  assert.equal(importsOf(`const m = await import("./z.js");`).dynamic, true);
  // htm の閉じ <//> はコメントではない
  assert.deepEqual(partProblems("x.js", "html`<${A}>a<//> ${document.title}`"), ["x.js: document"]);
  assert.deepEqual(partProblems("x.js", "// document と window はコメントの中\nconst a = 1;"), []);
  for (const word of ["location", "localStorage", "sessionStorage", "navigator", "matchMedia", "setTimeout", "setInterval"]) {
    assert.deepEqual(partProblems("x.js", `const v = ${word};`), [`x.js: ${word}`], word);
  }
  assert.deepEqual(partProblems("x.js", "el.style.color = 1;"), ["x.js: style"]);
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
  badgeText: (count: unknown, max?: number) => string;
  MARK_STATES: readonly string[];
  markState: (state: unknown) => string;
  segmentedTabStop: (items: unknown[], value: unknown) => unknown;
  segmentedKey: (items: unknown[], current: unknown, key: string, modified?: boolean) => unknown;
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

test("web components: Button は押せるときだけ onPress に事象を渡して呼び、押せないときは aria-disabled と preventDefault", () => {
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
  assert.deepEqual(calls, [[e1]]);
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
  // 札の字は 9 を超えたら 9+、読み上げの名前は 99 まで
  const many = one(html`<${atoms.IconButton} icon="bell" label="知らせ" badge=${12} />`);
  assert.equal(textOf(find(many, "c-badge")), "9+");
  assert.equal(many.props["aria-label"], "知らせ（12 件）");
  assert.equal(textOf(find(one(html`<${atoms.IconButton} icon="bell" label="知らせ" badge=${9} />`), "c-badge")), "9");
  const pressed: unknown[][] = [];
  const onBtn = one(html`<${atoms.IconButton} icon="plus" label="足す" reason="今は足せません" onPress=${(...a: unknown[]) => void pressed.push(a)} />`);
  assert.equal(onBtn.props.title, "足す");
  const ev = fakeEvent();
  (onBtn.props.onClick as (e: unknown) => void)(ev);
  assert.deepEqual(pressed, [[ev]]);
  const plain = one(html`<${atoms.IconButton} icon="x" label="閉じる" size="sm" />`);
  assert.equal(find(plain, "c-badge").length, 0);
  assert.equal(plain.props["data-size"], "sm");
  assert.equal(plain.props["aria-disabled"], undefined);
  const calls: unknown[][] = [];
  const off = one(html`<${atoms.IconButton} icon="settings" label="設定" disabled=${true} reason="今は開けません" onPress=${(...a: unknown[]) => void calls.push(a)} />`);
  assert.equal(off.props["aria-disabled"], "true");
  assert.equal(off.props.title, "今は開けません");
  assert.equal(off.props["aria-label"], "設定");
  assert.equal(one(html`<${atoms.IconButton} icon="settings" label="設定" disabled=${true} />`).props.title, "設定");
  const e = fakeEvent();
  (off.props.onClick as (e: unknown) => void)(e);
  assert.equal(calls.length, 0);
  assert.equal(e.count(), 1);
  assert.throws(() => expand(html`<${atoms.IconButton} icon="x" />`), TypeError);
});

test("web components: badgeText と Badge（1 未満・数でない物は出さない、99+）", () => {
  for (const v of [0, -1, Number.NaN, "3", undefined]) assert.equal(atoms.badgeText(v), "", String(v));
  assert.deepEqual([1, 99, 99.9].map((n) => atoms.badgeText(n)), ["1", "99", "99"]);
  assert.deepEqual([100, Infinity].map((n) => atoms.badgeText(n)), ["99+", "99+"]);
  assert.deepEqual([9, 9.5, 10, 120].map((n) => atoms.badgeText(n, 9)), ["9", "9", "9+", "9+"]);
  assert.equal(textOf(one(html`<${atoms.Badge} count=${120} max=${9} />`)), "9+");
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
  // 修飾キー付きは動かない（素通し）
  assert.equal(atoms.segmentedKey(SEG, "a", "ArrowRight", true), null);
  assert.equal(atoms.segmentedKey(SEG, "a", "Home", true), null);
  // 値が数でも String() で揃えて比べ（data-value は文字列）、items の元の値を返す
  const NUM = [{ value: 1, label: "一" }, { value: 2, label: "二" }, { value: 3, label: "三" }];
  assert.equal(atoms.segmentedKey(NUM, "1", "ArrowRight"), 2);
  assert.equal(atoms.segmentedKey(NUM, 3, "ArrowRight"), 1);
  assert.equal(atoms.segmentedKey(NUM, "2", "End"), 3);
  assert.equal(atoms.segmentedTabStop(NUM, 2), 2);
  assert.equal(atoms.segmentedTabStop(NUM, "2"), 2);
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
  // 数の値: 選択中・Tab の入口・data-value を String() で揃え、onChange には元の数を渡す
  const got: unknown[] = [];
  const num = one(html`<${atoms.Segmented} items=${[{ value: 1, label: "一" }, { value: 2, label: "二" }]} value=${1} label="数" onChange=${(v: unknown) => void got.push(v)} />`);
  const numItems = find(num, "c-seg-item");
  assert.deepEqual(numItems.map((i) => [i.props["data-value"], i.props["aria-checked"], i.props.tabindex]), [["1", "true", 0], ["2", "false", -1]]);
  (numItems[0]?.props.onClick as (e: unknown) => void)(fakeEvent());
  (numItems[1]?.props.onClick as (e: unknown) => void)(fakeEvent());
  assert.deepEqual(got, [2]);
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

const sheetUrl = new URL("../src/web/static/c-sheet.js", import.meta.url).href;
const sheet = (await import(sheetUrl)) as Record<string, Fn> & {
  isOutside: (rect: Record<string, number>, x: number, y: number) => boolean;
  confirmTarget: (target: unknown) => string;
  confirmButtons: (o: Record<string, unknown>) => { cancel: Record<string, unknown>; ok: Record<string, unknown> };
  toastSplit: (items: Array<Record<string, unknown>>) => { status: Array<Record<string, unknown>>; alert: Array<Record<string, unknown>> };
};

test("web components: isOutside は箱の外だけ true（辺の上は中）", () => {
  const rect = { left: 10, right: 110, top: 20, bottom: 70 };
  assert.equal(sheet.isOutside(rect, 50, 40), false);
  for (const [x, y] of [[9, 40], [111, 40], [50, 19], [50, 71]] as const) assert.equal(sheet.isOutside(rect, x, y), true, `${x},${y}`);
  for (const [x, y] of [[10, 40], [110, 40], [50, 20], [50, 70]] as const) assert.equal(sheet.isOutside(rect, x, y), false, `${x},${y}`);
});

test("web components: confirmTarget は空白を畳み、80 字（絵文字・結合文字も 1 字ずつ）を超えたら省いて「」で囲む", () => {
  assert.equal(sheet.confirmTarget("  家計簿の\n\t 話題  "), "「家計簿の 話題」");
  const a80 = "あ".repeat(80);
  assert.equal(sheet.confirmTarget(a80), `「${a80}」`);
  assert.equal(sheet.confirmTarget(a80 + "い"), `「${a80}…」`);
  const emoji = "😀".repeat(80);
  assert.equal(sheet.confirmTarget(emoji), `「${emoji}」`);
  assert.equal(sheet.confirmTarget(emoji + "😀"), `「${emoji}…」`);
});

test("web components: confirmButtons は danger で実行を danger にし最初のフォーカスを [やめる] に、既定の文", () => {
  assert.deepEqual(sheet.confirmButtons({}), {
    cancel: { kind: "secondary", label: "やめる", autofocus: false },
    ok: { kind: "primary", label: "実行する", autofocus: true },
  });
  assert.deepEqual(sheet.confirmButtons({ danger: true, okLabel: "消す", cancelLabel: "残す" }), {
    cancel: { kind: "secondary", label: "残す", autofocus: true },
    ok: { kind: "danger", label: "消す", autofocus: false },
  });
});

test("web components: Confirm は Node で呼べて Sheet を返し、× を出さず、閉じたら onCancel。footer は [やめる]・実行の順", () => {
  const onOk = (): void => undefined;
  const onCancel = (): void => undefined;
  const v = sheet.Confirm({ open: true, id: "c", title: "消しますか", target: "題", body: "元に戻せません。", okLabel: "消す", danger: true, onOk, onCancel }) as VNode;
  assert.equal(v.type, sheet.Sheet);
  assert.equal(v.props.closeButton, false);
  assert.equal(v.props.onClose, onCancel);
  assert.equal(v.props.title, "消しますか");
  const buttons = expand(v.props.footer).filter((t): t is El => typeof t !== "string");
  assert.deepEqual(buttons.map((b) => [b.props["data-kind"], textOf(b), b.props.autofocus]), [
    ["secondary", "やめる", true],
    ["danger", "消す", undefined],
  ]);
  const body = expand(v.props.children);
  assert.equal(textOf(find(body, "c-confirm-target")), "「題」");
  assert.equal(textOf(find(body, "c-confirm-body")), "元に戻せません。");
  const plain = sheet.Confirm({ open: false, id: "c", title: "始めますか", onOk, onCancel }) as VNode;
  assert.deepEqual(expand(plain.props.children), []);
  const busy = expand((sheet.Confirm({ open: true, id: "c", title: "t", busy: true, onOk, onCancel }) as VNode).props.footer) as El[];
  assert.deepEqual(busy.map((b) => b.props["aria-busy"]), [undefined, "true"]);
  // [やめる]・実行は onCancel・onOk を引数なしで呼ぶ（押した事象を渡さない）
  const args: unknown[][] = [];
  const v2 = sheet.Confirm({ open: true, id: "c", title: "t", onOk: (...a: unknown[]) => void args.push(["ok", ...a]), onCancel: (...a: unknown[]) => void args.push(["cancel", ...a]) }) as VNode;
  for (const b of expand(v2.props.footer) as El[]) (b.props.onClick as (e: unknown) => void)(fakeEvent());
  assert.deepEqual(args, [["cancel"], ["ok"]]);
});

test("web components: toastSplit と Toast（失敗だけ alert、空でも 2 つの入れ物、× で onDismiss(id)）", () => {
  const items = [
    { id: "1", text: "a" },
    { id: "2", text: "b", level: "error", actionLabel: "もう一度", onAction: () => undefined },
    { id: "3", text: "c", level: "info" },
  ];
  const split = sheet.toastSplit(items);
  assert.deepEqual(split.status.map((i) => i.id), ["1", "3"]);
  assert.deepEqual(split.alert.map((i) => i.id), ["2"]);
  const empty = one(html`<${sheet.Toast} items=${[]} onDismiss=${() => undefined} />`);
  const lists = find(empty, "c-toast-list");
  assert.deepEqual(lists.map((l) => [l.props.role, l.props["aria-live"]]), [
    ["status", "polite"],
    ["alert", "assertive"],
  ]);
  assert.equal(find(empty, "c-toast-item").length, 0);
  const dismissed: string[] = [];
  const t = one(html`<${sheet.Toast} items=${items} onDismiss=${(id: string) => void dismissed.push(id)} />`);
  const [status, alert] = find(t, "c-toast-list");
  assert.deepEqual(find(status as El, "c-toast-item").map((i) => i.props["data-level"]), ["info", "info"]);
  const failed = find(alert as El, "c-toast-item");
  assert.equal(failed[0]?.props["data-level"], "error");
  assert.equal(textOf(find(failed, "c-btn-label")), "もう一度");
  assert.equal(find(status as El, "c-btn").length, 0);
  const close = find(failed, "c-iconbtn")[0];
  assert.equal(close?.props["aria-label"], "閉じる");
  (close?.props.onClick as (e: unknown) => void)(fakeEvent());
  assert.deepEqual(dismissed, ["2"]);
});
