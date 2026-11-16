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
  for (const name of ["c-gallery.css"]) assert.ok(CSS_FILES.includes(name), name);
  for (const name of ["c-gallery.js", "c-lib.js"]) assert.ok(JS_FILES.includes(name), name);
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
