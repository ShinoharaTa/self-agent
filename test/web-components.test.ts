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
  "top-full-min", "top-place-min",
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
  "c-shell.css": /^\.c-(?:bottom|top)(?![a-z])/,
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

/** 部品が触ってはいけない語（§8.1 の 9）。WORDS は語の単位で、SUBSTRINGS は語の途中にも当てる。入口（c-app.js）は ENTRY_OK を使ってよい */
const FORBIDDEN_WORDS = ["document", "window", "SA", "fetch", "globalThis", "location", "localStorage", "sessionStorage", "navigator", "matchMedia", "setTimeout", "setInterval"];
const FORBIDDEN_SUBSTRINGS = ["ownerDocument", "getRootNode", "activeElement"];
const ENTRY_OK: ReadonlySet<string> = new Set(["document", "window", "SA", "matchMedia", "activeElement"]);
const forEntry = (words: string[]): string[] => words.filter((w) => !ENTRY_OK.has(w));
const PART_WORDS = new RegExp(`\\b(${FORBIDDEN_WORDS.join("|")})\\b`, "g");
const PART_PARTS = new RegExp(FORBIDDEN_SUBSTRINGS.join("|"), "g");
const ENTRY_WORDS = new RegExp(`\\b(${forEntry(FORBIDDEN_WORDS).join("|")})\\b`, "g");
const ENTRY_PARTS = new RegExp(forEntry(FORBIDDEN_SUBSTRINGS).join("|"), "g");

function forbidden(name: string, text: string, words: RegExp, parts: RegExp): string[] {
  const js = stripJsComments(text);
  const problems: string[] = [];
  for (const m of js.matchAll(words)) problems.push(`${name}: ${m[1]}`);
  for (const m of js.matchAll(parts)) problems.push(`${name}: ${m[0]}`);
  if (/\bstyle\b/.test(js)) problems.push(`${name}: style`);
  return problems;
}

/** 部品（入口・c-lib.js 以外の c-*.js）が触ってはいけない物（§8.1 の 9） */
const partProblems = (name: string, text: string): string[] => forbidden(name, text, PART_WORDS, PART_PARTS);
/** 入口（c-app.js）が触ってはいけない物（部品の語から document・window・SA・matchMedia・activeElement を除いた残り） */
const entryProblems = (name: string, text: string): string[] => forbidden(name, text, ENTRY_WORDS, ENTRY_PARTS);

test("web components: c-*.css・c-*.js がそろっている", () => {
  for (const name of ["c-atoms.css", "c-sheet.css", "c-list.css", "c-shell.css", "c-gallery.css"]) assert.ok(CSS_FILES.includes(name), name);
  for (const name of ["c-atoms.js", "c-sheet.js", "c-list.js", "c-shell.js", "c-gallery.js", "c-lib.js", "c-app.js"]) assert.ok(JS_FILES.includes(name), name);
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
  // 入口（見本の c-gallery.js と、K3 から c-app.js）と c-lib.js は対象外
  for (const name of JS_FILES.filter((n) => !["c-lib.js", "c-gallery.js", "c-app.js"].includes(n))) assert.deepEqual(partProblems(name, read(name)), [], name);
});

test("web components: 入口（c-app.js）は document・window・SA・matchMedia・activeElement のほかに触らず、クラスを書かず、hook を読まない。ほかの c-*.js は入口を読まない", () => {
  const app = read("c-app.js");
  assert.deepEqual(entryProblems("c-app.js", app), []);
  assert.deepEqual(classesInJs(app), []);
  for (const name of JS_FILES.filter((n) => n !== "c-app.js")) assert.ok(!importsOf(read(name)).from.some((f) => /c-app\.js$/.test(f)), name);
});

test("web components: 入口の TOP_FULL_MIN は tokens.css の --c-top-full-min と同じ数で、トークンは <数>px の形（入口が parseFloat で読む）", () => {
  const app = read("c-app.js");
  const fromApp = /\bconst TOP_FULL_MIN = (\d+);/.exec(app)?.[1];
  assert.ok(fromApp, "c-app.js に TOP_FULL_MIN が無い");
  const fromTokens = /--c-top-full-min:\s*([^;]+);/.exec(read("tokens.css"))?.[1]?.trim();
  assert.ok(fromTokens, "tokens.css に --c-top-full-min が無い");
  assert.match(fromTokens, /^\d+px$/);
  assert.equal(fromTokens, fromApp + "px");
  // 測るのは根の親（根は display: contents）。殻の id を書かない
  assert.match(app, /topRoot \? topRoot\.parentElement : null/);
  assert.doesNotMatch(app, /v3-main/);
});

test("web components: import の先（c-atoms は c-lib だけ、c-sheet・c-list・c-shell は c-lib と c-atoms だけ、c-app は c-lib・c-list・c-shell だけ。c-atoms・c-list・c-shell・c-app は hook なし）・動的な import と createPortal が無い", () => {
  const allowed: Record<string, string[]> = {
    "c-atoms.js": ["./c-lib.js"],
    "c-sheet.js": ["./c-lib.js", "./c-atoms.js"],
    "c-list.js": ["./c-lib.js", "./c-atoms.js"],
    "c-shell.js": ["./c-lib.js", "./c-atoms.js"],
    "c-app.js": ["./c-lib.js", "./c-list.js", "./c-shell.js"],
  };
  for (const [name, targets] of Object.entries(allowed)) {
    if (!JS_FILES.includes(name)) continue;
    const { from, dynamic } = importsOf(read(name));
    for (const target of from) assert.ok(targets.includes(target), `${name}: ${target}`);
    assert.equal(dynamic, false, `${name}: 動的な import`);
  }
  for (const name of ["c-atoms.js", "c-list.js", "c-shell.js", "c-app.js"]) if (JS_FILES.includes(name)) assert.doesNotMatch(read(name), /import\s*\{[^}]*\buse[A-Z]/, name);
  for (const name of JS_FILES) assert.doesNotMatch(read(name), /createPortal/, name);
});

test("web components: 一覧と下のバー（c-list・c-shell）は id を出さず、K2 の部品のクラスを書くのは決めた 3 つのセレクタだけ。動きを付けない", () => {
  // 部品は id を出さない（モデルのキー id: や data-topic=${id} は当たらない）
  for (const name of ["c-list.js", "c-shell.js"]) if (JS_FILES.includes(name)) assert.doesNotMatch(stripJsComments(read(name)), /(?<![\w-])id=/, name);
  // 部品の色・高さ・字を外から変えない（印の位置・PC の [+] の当たりを戻す・下のバーの並べ方だけ）
  const ALLOWED_OUTSIDE = new Set([".c-turn > .c-mark", '.c-group-head > .c-iconbtn[data-size="sm"]::after', '.c-bottom > .c-btn[data-size="sm"]']);
  // K2 の部品のクラス（c-atoms.css・c-sheet.css のセレクタに出る全部。その下のクラスも）は外から宛てない
  const atomClasses = new Set(["c-atoms.css", "c-sheet.css"].flatMap((file) => parseCss(read(file)).filter((r) => !r.keyframe).flatMap((r) => r.selectors.flatMap(classesInSelector))));
  for (const cls of ["c-btn", "c-iconbtn", "c-badge", "c-mark", "c-icon", "c-empty", "c-empty-text", "c-loading", "c-seg", "c-field", "c-input", "c-sheet", "c-toast"]) assert.ok(atomClasses.has(cls), cls);
  for (const name of ["c-list.css", "c-shell.css"]) {
    if (!CSS_FILES.includes(name)) continue;
    const rules = parseCss(read(name));
    for (const rule of rules) {
      for (const selector of rule.selectors) if (classesInSelector(selector).some((cls) => atomClasses.has(cls))) assert.ok(ALLOWED_OUTSIDE.has(selector), `${name}: ${selector}`);
    }
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

test("web components: 下のバーの自前のボタンは当たりの下限を持つ", () => {
  const rules = parseCss(read("c-shell.css"));
  for (const selector of [".c-bottom-btn", ".c-bottom-hand"]) {
    const own = rules.filter((r) => r.at.length === 0 && r.selectors.includes(selector));
    assert.ok(own.length > 0, selector);
    assert.ok(own.some((r) => /(?:^|;)\s*min-height:\s*var\(--c-tap\)\s*(?:;|$)/.test(r.body)), selector);
  }
});

test("web components: 下のバーの上の線は高さを食わない（枠でなく内側の影）", () => {
  const own = parseCss(read("c-shell.css")).filter((r) => r.at.length === 0 && r.selectors.includes(".c-bottom"));
  assert.ok(own.length > 0);
  for (const rule of own) assert.doesNotMatch(rule.body, /(?:^|;)\s*border-top(?:-[a-z]+)?\s*:/);
  assert.ok(own.some((r) => /(?:^|;)\s*box-shadow:\s*inset\b/.test(r.body)));
});

test("web components: c-*.css のセレクタのクラスと、c-*.js（と gallery.html）が書くクラスが同じ集まり", () => {
  const inCss = new Set(CSS_FILES.flatMap((name) => parseCss(read(name)).filter((r) => !r.keyframe).flatMap((r) => r.selectors.flatMap(classesInSelector))));
  // 見本の根（c-gallery）は gallery.html に在る
  const inJs = new Set([...JS_FILES.filter((n) => n !== "c-lib.js").flatMap((name) => classesInJs(read(name))), ...classesInJs(read("gallery.html"))]);
  assert.deepEqual([...inCss].filter((c) => !inJs.has(c)).sort(), [], "CSS にだけ在るクラス");
  assert.deepEqual([...inJs].filter((c) => !inCss.has(c)).sort(), [], "JS にだけ在るクラス");
});

/**
 * 古い CSS の規則のうち、クラス・id・属性で絞らない物（:not(…) の中は絞りに数えない）の、当たる要素（最後の複合セレクタ）の頭のタグ。
 * * だけの物・擬似要素だけの物は stars・pseudo に分ける。祖先をクラスで絞った規則（.wb button など）は、部品の中には当たらないので数えない
 */
function bareTags(text: string): { tags: Map<string, string[]>; stars: string[]; pseudo: string[] } {
  const tags = new Map<string, string[]>();
  const stars: string[] = [];
  const pseudo: string[] = [];
  for (const rule of parseCss(text)) {
    if (rule.keyframe) continue;
    for (const selector of rule.selectors) {
      if (/[.#[]/.test(selector.replace(/:not\([^()]*\)/g, ""))) continue;
      const last = selector.split(/\s*[>+~]\s*|\s+/).at(-1) ?? "";
      const tag = /^[a-z][a-z0-9-]*/.exec(last)?.[0];
      if (tag !== undefined) tags.set(tag, [...(tags.get(tag) ?? []), selector]);
      else if (last.startsWith("*")) stars.push(selector);
      else if (last.startsWith("::")) pseudo.push(selector);
    }
  }
  return { tags, stars, pseudo };
}

/** base.css の h1 に当たる宣言のうち、.c-top-title の規則（@media の外）に無い物の名前 */
function h1Problems(text: string): string[] {
  const own = parseCss(text).filter((r) => r.at.length === 0 && r.selectors.includes(".c-top-title"));
  return ["margin", "font-weight", "line-height", "font-size"].filter((prop) => !own.some((r) => new RegExp(`(?:^|;)\\s*${prop}\\s*:`).test(r.body)));
}

test("web components: 完了・「ほかのプロジェクト」の見出し（.c-fold-head）は行と同じ --c-row-h の高さ", () => {
  const rule = parseCss(read("c-list.css")).find((r) => r.at.length === 0 && r.selectors.length === 1 && r.selectors[0] === ".c-fold-head");
  assert.ok(rule);
  assert.match(rule.body, /min-height: var\(--c-row-h\);/);
});

test("web components: 古い CSS（app・shell・base・tokens）の裸のタグの規則が、一覧・下のバー・小さい部品のタグに当たらない（base.css の reset だけは許す）", () => {
  // 部品のテンプレートに出るタグ
  const partTags = new Set<string>();
  for (const name of ["c-list.js", "c-shell.js", "c-atoms.js"]) for (const m of read(name).matchAll(/<([a-z][a-z0-9]*)[\s>/]/g)) partTags.add(m[1] ?? "");
  for (const tag of ["button", "ul", "li", "h1", "h2", "section", "span", "p", "div", "svg", "use", "header"]) assert.ok(partTags.has(tag), tag);
  // base.css の reset（button・h2・p の字と余白を外す・継ぐ）は見本のページ（gallery.html）にも当たるので、見本との差にならない。
  // h1（見出しの題）は base.css の字と余白を .c-top-title が全部書き直す
  const BASE_OK = new Set(["button", "h1", "h2", "p"]);
  assert.deepEqual(h1Problems(read("c-shell.css")), []);
  const base = readFileSync(join(ROOT, "templates/web/site/base.css"), "utf8");
  for (const [file, text] of [["app.css", read("app.css")], ["shell.css", read("shell.css")], ["tokens.css", read("tokens.css")], ["base.css", base]] as const) {
    const { tags } = bareTags(text);
    for (const [tag, selectors] of tags) {
      if (!partTags.has(tag)) continue;
      assert.ok(file === "base.css" && BASE_OK.has(tag), `${file}: ${selectors.join(", ")}`);
    }
  }
  // 見張りの拾い方
  const sample = bareTags("button{} .wb button{} button:not(.x){} li > span{} *{} ::selection{} a[href]{} @keyframes k{to{}}");
  assert.deepEqual([...sample.tags.keys()], ["button", "span"]);
  assert.deepEqual(sample.tags.get("button"), ["button", "button:not(.x)"]);
  assert.deepEqual([sample.stars, sample.pseudo], [["*"], ["::selection"]]);
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
  assert.ok(cssProblems("c-shell.css", ".c-topbar{color:var(--text)}").some((p) => p.includes("このファイルの頭")));
  assert.deepEqual(cssProblems("c-shell.css", ".c-top-title{margin:0}"), []);
  // 見出しの題が base.css の h1 の宣言を書き直していない見本
  assert.deepEqual(h1Problems(".c-top-title{margin:0;font-size:var(--font-base)} @media (x){.c-top-title{line-height:1}}"), ["font-weight", "line-height"]);
  assert.deepEqual(h1Problems(".c-top-title{margin:0;font-weight:1;line-height:1;font-size:1}"), []);
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
  // 入口は document・window・SA・matchMedia・activeElement を使ってよいが、保存・タイマーなどは落とす
  assert.deepEqual(entryProblems("x.js", "document.activeElement; window.SA; window.matchMedia(q);"), []);
  assert.deepEqual(entryProblems("x.js", "window.localStorage.getItem(k); setTimeout(f, 1);"), ["x.js: localStorage", "x.js: setTimeout"]);
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

// ===== 一覧（c-list.js。docs/plan/web-ui-components.md §6 の K3） =====
type Obj = Record<string, unknown>;
const listUrl = new URL("../src/web/static/c-list.js", import.meta.url).href;
const list = (await import(listUrl)) as Record<string, Fn> & {
  TURN_LABEL: Readonly<Record<string, string>>;
  DONE_MAX: number;
  filterWords: (filter: unknown) => string[];
  topicHits: (topic: Obj, groupName: string, words: string[]) => boolean;
  rowMark: (topic: Obj, isUnread: (channel: string, last: unknown) => boolean) => string;
  rowModel: (topic: Obj, ctx: Obj) => Obj;
  groupNote: (group: Obj, memberCount: number, folded: boolean) => Obj | null;
  turnItem: (id: string, state: Obj) => Obj | null;
  nextTurnId: (ids: string[], current: string | null) => string | null;
  listNote: (o: Obj) => string;
  listKey: (key: string, count: number, at: number) => number | null | undefined;
  turnWord: (kind: unknown) => string;
  listModel: (state: Obj) => { phase: string; note: string; turns: null | { count: number; nextId: string | null; items: Obj[] }; blocks: Obj[]; hitCount: number };
};

const topicOf = (o: Obj): Obj => ({
  id: "ch:1", title: "題", group: "p:a", origin: "session", persona: null, mark: null, turn: null, state: "active", activityAt: "2026-01-01T00:00:00Z", last: null,
  ...o,
});
const groupOf = (o: Obj): Obj => ({ key: "p:a", kind: "project", name: "A", turns: 0, running: 0, open: 1, done: 0, hasTopics: true, ...o });
const turnOf = (kind: string, summary = ""): Obj => ({ kind, summary, since: "2026-01-01T00:00:00Z", expiresAt: null });

function stateOf(data: Obj | null, o: Obj = {}): Obj {
  return {
    data, failed: false, filter: "", current: null, doneGroup: null, dataDone: null, othersOpen: false,
    isUnread: () => false, time: () => "12:00", ago: () => "1 分前",
    ...o,
  };
}

/** 群 A（プロジェクト・話題あり）・B（話題なしで畳む）・C（話題なしで畳む）・General・ほかの場所 */
function sampleData(): Obj {
  return {
    turns: 2,
    turnIds: ["ch:1", "hand:1", "ch:missing"],
    groups: [
      groupOf({ key: "p:a", name: "A", turns: 1, running: 1, open: 3, done: 60 }),
      groupOf({ key: "p:b", name: "B", open: 0, done: 2, hasTopics: true }),
      groupOf({ key: "p:c", name: "C", open: 0, done: 0, hasTopics: false }),
      groupOf({ key: "general", kind: "general", name: "General", open: 0 }),
      groupOf({ key: "other", kind: "other", name: "ほかの場所", open: 1 }),
    ],
    topics: [
      topicOf({ id: "ch:1", title: "家計の話", mark: "turn", turn: turnOf("permission", "コマンドを実行してよいか") }),
      topicOf({ id: "cc:2", title: "作業の話", mark: "running", origin: "cc" }),
      topicOf({ id: "ch:3", title: "読んだ話", persona: "見本の人格" }),
      topicOf({ id: "ch:4", title: "古い話", state: "done" }),
      topicOf({ id: "ch:5", title: "Bの終わった話", group: "p:b", state: "done" }),
      topicOf({ id: "ch:6", title: "外の話", group: "other" }),
    ],
    rightHands: [{ id: "hand:1", guildId: "g", title: "右腕", turn: turnOf("question"), last: null, link: "x" }],
    cc: { enabled: true, stale: false, unreadable: false },
  };
}

test("web components: c-list の TURN_LABEL・DONE_MAX・filterWords・topicHits", () => {
  assert.deepEqual({ ...list.TURN_LABEL }, { permission: "許可", question: "質問", waiting: "判断待ち", confirm: "確認" });
  assert.ok(Object.isFrozen(list.TURN_LABEL));
  assert.equal(list.DONE_MAX, 50);
  assert.deepEqual(list.filterWords("  Foo  bar "), ["foo", "bar"]);
  assert.deepEqual(list.filterWords(""), []);
  const t = topicOf({ title: "Report 下書き", persona: "Helper" });
  assert.equal(list.topicHits(t, "Alpha", ["report"]), true);
  assert.equal(list.topicHits(t, "Alpha", ["report", "alpha"]), true);
  assert.equal(list.topicHits(t, "Alpha", ["helper"]), true);
  assert.equal(list.topicHits(t, "Alpha", ["report", "beta"]), false);
  assert.equal(list.topicHits(t, "Alpha", []), true);
});

test("web components: rowMark は あなたの番 > 作業中 > 未読 で、未読は印の無い ch: だけ isUnread に訊く", () => {
  const asked: unknown[][] = [];
  const unread = (...a: unknown[]): boolean => (asked.push(a), true);
  assert.equal(list.rowMark(topicOf({ mark: "turn" }), unread), "turn");
  assert.equal(list.rowMark(topicOf({ mark: "running" }), unread), "running");
  assert.equal(asked.length, 0);
  const last = { id: 3, at: "x", kind: "agent" };
  assert.equal(list.rowMark(topicOf({ id: "ch:9", last }), unread), "unread");
  assert.deepEqual(asked, [["9", last]]);
  assert.equal(list.rowMark(topicOf({ id: "cc:9" }), unread), "none");
  assert.equal(asked.length, 1);
  assert.equal(list.rowMark(topicOf({ id: "ch:9" }), () => false), "none");
});

test("web components: rowModel は右に状態の語か時刻の 1 つ、付記は「端末」か人格", () => {
  const ctx = { isUnread: () => false, time: (iso: string) => "t:" + iso, current: "ch:1" };
  const turn = list.rowModel(topicOf({ mark: "turn", turn: turnOf("waiting") }), ctx);
  assert.deepEqual(turn.state, { text: "判断待ち", tone: "warning" });
  assert.equal(turn.time, null);
  assert.equal(turn.current, true);
  const running = list.rowModel(topicOf({ id: "cc:2", mark: "running", origin: "cc" }), ctx);
  assert.deepEqual(running.state, { text: "作業中", tone: "accent" });
  assert.equal(running.time, null);
  assert.equal(running.tag, "端末");
  assert.equal(running.current, false);
  const plain = list.rowModel(topicOf({ id: "ch:3", persona: "見本の人格", state: "done" }), ctx);
  assert.deepEqual(plain, { id: "ch:3", title: "題", mark: "none", state: null, time: "t:2026-01-01T00:00:00Z", tag: "見本の人格", done: true, current: false });
  assert.equal(list.rowModel(topicOf({ activityAt: null }), ctx).time, null);
  assert.equal(list.rowModel(topicOf({}), ctx).tag, null);
});

test("web components: groupNote の 4 つの場合と、畳んだ群は「話題なし」を出さない", () => {
  assert.deepEqual(list.groupNote(groupOf({ turns: 2, running: 1 }), 3, false), { text: "あなたの番 2", tone: "warning" });
  assert.deepEqual(list.groupNote(groupOf({ running: 1 }), 1, false), { text: "作業中 1", tone: "accent" });
  assert.deepEqual(list.groupNote(groupOf({}), 0, false), { text: "話題なし", tone: "muted" });
  assert.equal(list.groupNote(groupOf({}), 2, false), null);
  assert.equal(list.groupNote(groupOf({ done: 1 }), 0, false), null);
  assert.equal(list.groupNote(groupOf({}), 0, true), null);
});

test("web components: turnItem は話題・右腕を引き、引けなければ null。meta は種類と時間、sub は場所と要約", () => {
  const st = stateOf(sampleData(), { current: "hand:1" });
  assert.deepEqual(list.turnItem("ch:1", st), { id: "ch:1", title: "家計の話", meta: "許可・1 分前", sub: "A・コマンドを実行してよいか", current: false });
  assert.deepEqual(list.turnItem("hand:1", st), { id: "hand:1", title: "右腕", meta: "質問・1 分前", sub: "", current: true });
  assert.equal(list.turnItem("ch:missing", st), null);
  // 番の無い話題は引かない
  assert.equal(list.turnItem("ch:3", st), null);
  const d = sampleData();
  (d.topics as Obj[])[0] = topicOf({ id: "ch:1", group: "nowhere", mark: "turn", turn: turnOf("confirm") });
  assert.equal(list.turnItem("ch:1", stateOf(d))?.sub, "");
});

test("web components: nextTurnId は次・最後から先頭・current が無ければ先頭・空は null", () => {
  assert.equal(list.nextTurnId(["a", "b", "c"], "a"), "b");
  assert.equal(list.nextTurnId(["a", "b", "c"], "c"), "a");
  assert.equal(list.nextTurnId(["a", "b"], null), "a");
  assert.equal(list.nextTurnId(["a", "b"], "z"), "a");
  assert.equal(list.nextTurnId([], "a"), null);
});

test("web components: listNote は 更新の失敗 > Claude Code > 当たらない の 1 つで、data が無いときは空", () => {
  const base = { failed: false, hasData: true, ccUnreadable: false, filtering: false, hitCount: 0 };
  assert.equal(list.listNote(base), "");
  assert.equal(list.listNote({ ...base, failed: true, ccUnreadable: true, filtering: true }), "更新できませんでした。前の一覧を出しています");
  assert.equal(list.listNote({ ...base, ccUnreadable: true, filtering: true }), "Claude Code の一覧を読めません。作業中の話題が欠けて見えることがあります");
  assert.equal(list.listNote({ ...base, filtering: true }), "当たる話題がありません");
  assert.equal(list.listNote({ ...base, filtering: true, hitCount: 1 }), "");
  assert.equal(list.listNote({ ...base, hasData: false, failed: true }), "");
});

test("web components: listKey は Home・End・↑↓（端は null）、at < 0 の矢印と 0 件は null、ほかのキーは undefined", () => {
  assert.equal(list.listKey("Home", 5, 3), 0);
  assert.equal(list.listKey("End", 5, 0), 4);
  assert.equal(list.listKey("ArrowDown", 5, 1), 2);
  assert.equal(list.listKey("ArrowDown", 5, 4), null);
  assert.equal(list.listKey("ArrowUp", 5, 1), 0);
  assert.equal(list.listKey("ArrowUp", 5, 0), null);
  assert.equal(list.listKey("ArrowDown", 5, -1), null);
  assert.equal(list.listKey("ArrowUp", 5, -1), null);
  assert.equal(list.listKey("Home", 5, -1), 0);
  assert.equal(list.listKey("Home", 0, -1), null);
  assert.equal(list.listKey("ArrowDown", 0, 0), null);
  assert.equal(list.listKey("Enter", 5, 1), undefined);
  assert.equal(list.listKey("PageDown", 0, 0), undefined);
});

const groupBlocks = (blocks: Obj[]): Obj[] => blocks.filter((b) => b.type === "group");

test("web components: listModel の phase（loading・failed・ready）", () => {
  assert.deepEqual(list.listModel(stateOf(null)), { phase: "loading", note: "", turns: null, blocks: [], hitCount: 0 });
  assert.equal(list.listModel(stateOf(null, { failed: true })).phase, "failed");
  const ready = list.listModel(stateOf(sampleData()));
  assert.equal(ready.phase, "ready");
  assert.equal(ready.note, "");
  assert.equal(list.listModel(stateOf(sampleData(), { failed: true })).note, "更新できませんでした。前の一覧を出しています");
  const cc = sampleData();
  cc.cc = { enabled: true, stale: false, unreadable: true };
  assert.equal(list.listModel(stateOf(cc)).note, "Claude Code の一覧を読めません。作業中の話題が欠けて見えることがあります");
  cc.cc = { enabled: false, stale: false, unreadable: true };
  assert.equal(list.listModel(stateOf(cc)).note, "");
});

test("web components: listModel のあなたの番（0 件で null・turnIds の順・絞り込まない・群の中は印だけ）", () => {
  const m = list.listModel(stateOf(sampleData(), { current: "ch:1" }));
  assert.equal(m.turns?.count, 2);
  assert.deepEqual(m.turns?.items.map((t) => t.id), ["ch:1", "hand:1"]);
  assert.equal(m.turns?.nextId, "hand:1");
  const filtered = list.listModel(stateOf(sampleData(), { filter: "読んだ" }));
  assert.deepEqual(filtered.turns?.items.map((t) => t.id), ["ch:1", "hand:1"]);
  // 群の中にも同じ話題の行が在り、印は turn で副次の値を持たない
  const row = (groupBlocks(m.blocks)[0]?.rows as Obj[]).find((r) => r.id === "ch:1");
  assert.equal(row?.mark, "turn");
  assert.deepEqual(Object.keys(row ?? {}).sort(), ["current", "done", "id", "mark", "state", "tag", "time", "title"]);
  const zero = sampleData();
  zero.turns = 0;
  assert.equal(list.listModel(stateOf(zero)).turns, null);
  const unknown = sampleData();
  unknown.turnIds = ["ch:missing"];
  assert.equal(list.listModel(stateOf(unknown)).turns, null);
});

test("web components: listModel の「あなたの番」の次の起点は、turnFrom が turnIds に在ればそれ・無ければ current・無指定は current", () => {
  const next = (o: Obj): unknown => list.listModel(stateOf(sampleData(), o)).turns?.nextId;
  // 右腕（hand:1）は current にならないので、turnFrom が先へ進める
  assert.equal(next({ current: null, turnFrom: "hand:1" }), "ch:1");
  assert.equal(next({ current: "ch:1", turnFrom: "hand:1" }), "ch:1");
  assert.equal(next({ current: "ch:1", turnFrom: "ch:3" }), "hand:1", "ids に無い turnFrom は使わない");
  assert.equal(next({ current: "ch:1", turnFrom: null }), "hand:1");
  assert.equal(next({ current: "ch:1" }), "hand:1", "無指定は今と同じ");
  assert.equal(next({}), "ch:1");
});

test("web components: listModel の群（サーバーの順・ラベルの位置・話題の無いプロジェクトは「ほか」へ・General は畳まない）", () => {
  const m = list.listModel(stateOf(sampleData()));
  assert.deepEqual(
    m.blocks.map((b) => (b.type === "group" ? b.key : b.type)),
    ["label", "p:a", "others", "general", "other"],
  );
  assert.deepEqual(m.blocks[0], { type: "label", text: "プロジェクト" });
  const a = m.blocks[1] as Obj;
  assert.deepEqual(a.note, { text: "あなたの番 1", tone: "warning" });
  assert.equal(a.canAdd, true);
  assert.equal(a.addLabel, "A で話題を始める");
  assert.equal(a.hint, "");
  assert.deepEqual((a.rows as Obj[]).map((r) => r.id), ["ch:1", "cc:2", "ch:3"]);
  const others = m.blocks[2] as Obj;
  assert.equal(others.label, "ほかのプロジェクト（2）");
  assert.equal(others.open, false);
  assert.equal(others.forced, false);
  assert.deepEqual((others.groups as Obj[]).map((g) => [g.key, (g.rows as Obj[]).length, g.note]), [["p:b", 0, null], ["p:c", 0, null]]);
  assert.equal(list.listModel(stateOf(sampleData(), { othersOpen: true })).blocks[2]?.open, true);
  const general = m.blocks[3] as Obj;
  assert.equal(general.hint, "場所を決めていない話題");
  assert.deepEqual(general.note, { text: "話題なし", tone: "muted" });
  assert.equal(general.canAdd, true);
  const other = m.blocks[4] as Obj;
  assert.equal(other.canAdd, false);
  assert.equal(other.hint, "");
  // プロジェクトが「ほか」だけなら、ラベルはその直前
  const d = sampleData();
  d.groups = (d.groups as Obj[]).filter((g) => g.key !== "p:a");
  d.topics = (d.topics as Obj[]).filter((t) => t.group !== "p:a");
  assert.deepEqual(list.listModel(stateOf(d)).blocks.map((b) => (b.type === "group" ? b.key : b.type)), ["label", "others", "general", "other"]);
  // プロジェクトが無ければラベルは出さない
  d.groups = (d.groups as Obj[]).filter((g) => g.kind !== "project");
  assert.deepEqual(list.listModel(stateOf(d)).blocks.map((b) => b.type), ["group", "group"]);
});

test("web components: listModel の絞り込み（当たらない行・群・「ほか」を外す・forced・hitCount）", () => {
  const m = list.listModel(stateOf(sampleData(), { filter: "読んだ" }));
  assert.deepEqual(m.blocks.map((b) => (b.type === "group" ? b.key : b.type)), ["label", "p:a"]);
  assert.deepEqual((m.blocks[1]?.rows as Obj[]).map((r) => r.id), ["ch:3"]);
  assert.equal(m.hitCount, 1);
  assert.equal(m.note, "");
  // 群の名前でも当たる
  assert.equal(list.listModel(stateOf(sampleData(), { filter: "ほかの場所" })).hitCount, 1);
  // 「ほか」の中の完了に当たれば「ほか」は開いた形で残り、当たる群だけが入る
  const done = list.listModel(stateOf(sampleData(), { filter: "Bの終わった", doneGroup: "p:b", dataDone: "p:b" }));
  const others = done.blocks.find((b) => b.type === "others") as Obj;
  assert.equal(others.open, true);
  assert.equal(others.forced, true);
  assert.deepEqual((others.groups as Obj[]).map((g) => g.key), ["p:b"]);
  assert.equal(done.hitCount, 1);
  const none = list.listModel(stateOf(sampleData(), { filter: "当たらない語" }));
  assert.deepEqual(none.blocks, []);
  assert.equal(none.hitCount, 0);
  assert.equal(none.note, "当たる話題がありません");
});

test("web components: listModel の完了（閉・開いて読み込み中・開いて行・50 件を超えた文。開けるのは doneGroup の 1 つ）", () => {
  const closed = groupBlocks(list.listModel(stateOf(sampleData())).blocks)[0]?.done as Obj;
  assert.deepEqual(closed, { label: "完了（60）", open: false, loading: false, rows: [], more: "" });
  const loading = groupBlocks(list.listModel(stateOf(sampleData(), { doneGroup: "p:a", dataDone: null })).blocks)[0]?.done as Obj;
  assert.deepEqual(loading, { label: "完了（60）", open: true, loading: true, rows: [], more: "" });
  const open = groupBlocks(list.listModel(stateOf(sampleData(), { doneGroup: "p:a", dataDone: "p:a" })).blocks)[0]?.done as Obj;
  assert.equal(open.open, true);
  assert.equal(open.loading, false);
  assert.deepEqual((open.rows as Obj[]).map((r) => [r.id, r.done]), [["ch:4", true]]);
  assert.equal(open.more, "新しい 50 件を出しています");
  // ほかの群の完了は閉じたまま
  const m = list.listModel(stateOf(sampleData(), { doneGroup: "p:b", dataDone: "p:b" }));
  assert.equal((groupBlocks(m.blocks)[0]?.done as Obj).open, false);
  const b = (m.blocks.find((x) => x.type === "others")?.groups as Obj[])[0]?.done as Obj;
  assert.deepEqual([b.open, (b.rows as Obj[]).length, b.more], [true, 1, ""]);
  // 完了の無い群は null
  assert.equal(groupBlocks(m.blocks).find((g) => g.key === "general")?.done, null);
});

const ON = (): { calls: unknown[][]; on: Record<string, (...a: unknown[]) => void> } => {
  const calls: unknown[][] = [];
  const rec = (name: string) => (...a: unknown[]): void => void calls.push([name, ...a]);
  return { calls, on: { open: rec("open"), add: rec("add"), toggleDone: rec("toggleDone"), toggleOthers: rec("toggleOthers"), retry: rec("retry") } };
};

/** 子の vnode の key（関数の vnode を開く前） */
const keysOf = (children: unknown): unknown[] =>
  (Array.isArray(children) ? children.flat(Infinity) : [children]).filter((c) => c && typeof c === "object").map((c) => (c as { key?: unknown }).key);

test("web components: TopicList は phase ごとの子を出し、根はどの phase でも div.c-list[tabindex=-1]。子の key", () => {
  const { calls, on } = ON();
  const root = (state: Obj, compact = false): El => one(html`<${list.TopicList} model=${list.listModel(state)} compact=${compact} on=${on} />`);
  for (const [st, phase] of [[stateOf(null), "loading"], [stateOf(null, { failed: true }), "failed"], [stateOf(sampleData()), "ready"]] as const) {
    const r = root(st);
    assert.equal(r.type, "div");
    assert.equal(r.props.class, "c-list");
    assert.equal(r.props.tabindex, "-1");
    assert.equal(r.props["data-phase"], phase);
    const note = find(r, "c-list-note")[0];
    assert.equal(note?.props.role, "status");
  }
  assert.equal(find(root(stateOf(null)), "c-loading").length, 1);
  const failed = root(stateOf(null, { failed: true }));
  assert.equal(textOf(find(failed, "c-empty-text")), "読み込めませんでした");
  const retry = find(failed, "c-btn")[0];
  assert.deepEqual([retry?.props["data-kind"], retry?.props["data-size"], textOf(retry as El)], ["secondary", "sm", "もう一度読む"]);
  (retry?.props.onClick as (e: unknown) => void)(fakeEvent());
  assert.deepEqual(calls, [["retry"]]);
  // 子の key: あなたの番・ラベル・群・ほか
  const v = list.TopicList({ model: list.listModel(stateOf(sampleData())), compact: false, on }) as VNode;
  const inner = (v.props.children as unknown[]).flat(Infinity);
  assert.deepEqual(keysOf(inner).filter((k) => k !== undefined), ["turns", "label", "p:a", "others", "general", "other"]);
  const ready = root(stateOf(sampleData()));
  assert.equal(textOf(find(ready, "c-list-note")), "");
  assert.equal(find(ready, "c-turns").length, 1);
  assert.equal(find(ready, "c-group").length, 3);
  // 行の li は話題の id、あなたの番の li は turn: + id
  const rowsV = (list.Group({ group: groupBlocks(list.listModel(stateOf(sampleData())).blocks)[0], compact: false, on }) as VNode);
  const ul = expand(rowsV);
  const lis = find(ul, "c-rows")[0]?.children as El[];
  assert.equal(lis.length, 3);
  const turnsV = list.YourTurn({ turns: list.listModel(stateOf(sampleData())).turns, compact: false, onOpen: on.open }) as VNode;
  const turnsTree = one(turnsV);
  assert.deepEqual(keysOf((find(turnsTree, "c-turns-list")[0] as El).props.children), ["turn:ch:1", "turn:hand:1"]);
});

test("web components: YourTurn は compact で件数のボタン 1 つ、ほかは見出しと 2 行の項目。押すと onOpen(id, false)", () => {
  const { calls, on } = ON();
  const turns = list.listModel(stateOf(sampleData(), { current: "ch:1" })).turns;
  const wide = one(html`<${list.YourTurn} turns=${turns} compact=${false} onOpen=${on.open} />`);
  assert.equal(wide.type, "section");
  assert.equal(wide.props["aria-label"], "あなたの番");
  assert.equal(textOf(find(wide, "c-turns-head")), "あなたの番2");
  const items = find(wide, "c-turn");
  assert.deepEqual(items.map((b) => [b.props["data-topic"], b.props["aria-current"], b.props.title]), [["ch:1", "true", "家計の話"], ["hand:1", undefined, "右腕"]]);
  assert.ok(items.every((b) => b.props["data-mark"] === undefined));
  assert.equal(find(items[0] as El, "c-mark")[0]?.props["data-state"], "turn");
  assert.equal(find(items[0] as El, "c-mark")[0]?.props["aria-hidden"], "true");
  assert.equal(textOf(find(items[0] as El, "c-turn-meta")), "許可・1 分前");
  assert.equal(textOf(find(items[0] as El, "c-turn-sub")), "A・コマンドを実行してよいか");
  assert.equal(find(items[1] as El, "c-turn-sub").length, 0);
  (items[1]?.props.onClick as () => void)();
  assert.deepEqual(calls, [["open", "hand:1", false]]);
  const pc = one(html`<${list.YourTurn} turns=${turns} compact=${true} onOpen=${on.open} />`);
  assert.equal(pc.props["data-compact"], "true");
  const jump = find(pc, "c-turns-jump")[0] as El;
  assert.equal(jump.props["aria-label"], "あなたの番 2 件。次の話題を開く");
  assert.equal(textOf(find(jump, "c-badge")), "2");
  assert.equal(find(pc, "c-turn").length, 0);
  (jump.props.onClick as () => void)();
  assert.deepEqual(calls[1], ["open", "hand:1", false]);
  assert.equal(list.YourTurn({ turns: null, compact: false, onOpen: on.open }), null);
});

test("web components: Group・TopicRow・Fold の属性と押したとき（[+] は canAdd のときだけの IconButton）", () => {
  const { calls, on } = ON();
  const blocks = list.listModel(stateOf(sampleData(), { current: "ch:3", isUnread: (c: string) => c === "3", doneGroup: "p:a", dataDone: "p:a" })).blocks;
  const a = groupBlocks(blocks)[0];
  const g = one(html`<${list.Group} group=${a} compact=${false} on=${on} />`);
  assert.deepEqual([g.type, g.props["data-kind"], g.props["aria-label"]], ["section", "project", "A"]);
  const head = find(g, "c-group-head")[0] as El;
  assert.equal(head.props["data-add"], "true");
  assert.equal(find(head, "c-group-name")[0]?.type, "h2");
  assert.equal(find(find(head, "c-group-name")[0] as El, "c-iconbtn").length, 0);
  assert.equal(find(head, "c-group-hint").length, 0);
  assert.equal(find(head, "c-group-note")[0]?.props["data-tone"], "warning");
  const add = find(head, "c-iconbtn")[0] as El;
  assert.deepEqual([add.props["aria-label"], add.props.title, add.props["data-size"]], ["A で話題を始める", "A で話題を始める", "md"]);
  assert.match(String(((add.children[0] as El).children[0] as El).props.href), /#plus$/);
  const opener = { scrollIntoView: () => undefined };
  (add.props.onClick as (e: unknown) => void)({ preventDefault: () => undefined, currentTarget: opener });
  assert.deepEqual(calls, [["add", "p:a", opener]]);
  const small = one(html`<${list.Group} group=${a} compact=${true} on=${on} />`);
  assert.equal(find(small, "c-iconbtn")[0]?.props["data-size"], "sm");
  // 行: 全部 data-mark を持つ
  const rows = find(g, "c-row");
  assert.deepEqual(rows.map((r) => [r.props["data-topic"], r.props["data-mark"], r.props["aria-current"], r.props["data-done"]]), [
    ["ch:1", "turn", undefined, undefined],
    ["cc:2", "running", undefined, undefined],
    ["ch:3", "unread", "true", undefined],
    ["ch:4", "none", undefined, "true"],
  ]);
  assert.equal(find(rows[2] as El, "c-mark")[0]?.props["aria-label"], "未読");
  assert.equal(find(rows[0] as El, "c-mark")[0]?.props["aria-label"], undefined);
  assert.deepEqual([textOf(find(rows[0] as El, "c-row-state")), find(rows[0] as El, "c-row-time").length], ["許可", 0]);
  assert.equal(find(rows[1] as El, "c-row-state")[0]?.props["data-tone"], "accent");
  assert.equal(textOf(find(rows[1] as El, "c-row-tag")), "端末");
  assert.deepEqual([textOf(find(rows[2] as El, "c-row-time")), find(rows[2] as El, "c-row-state").length], ["12:00", 0]);
  (rows[3]?.props.onClick as () => void)();
  assert.deepEqual(calls[1], ["open", "ch:4", true]);
  // 完了の Fold
  const fold = find(g, "c-fold")[0] as El;
  assert.equal(fold.props["data-level"], "row");
  const fhead = find(fold, "c-fold-head")[0] as El;
  assert.deepEqual([fhead.props["aria-expanded"], fhead.props["aria-disabled"], textOf(find(fhead, "c-fold-label"))], ["true", undefined, "完了（60）"]);
  assert.equal(textOf(find(fold, "c-fold-note")), "新しい 50 件を出しています");
  (fhead.props.onClick as () => void)();
  assert.deepEqual(calls[2], ["toggleDone", "p:a"]);
  // 読み込み中
  const loadingGroup = groupBlocks(list.listModel(stateOf(sampleData(), { doneGroup: "p:a" })).blocks)[0];
  const lf = find(one(html`<${list.Group} group=${loadingGroup} compact=${false} on=${on} />`), "c-fold")[0] as El;
  assert.equal(textOf(find(lf, "c-fold-note")), "読み込んでいます…");
  // [+] の無い群・行の無い群
  const other = one(html`<${list.Group} group=${groupBlocks(blocks).find((x) => x.key === "other")} compact=${false} on=${on} />`);
  assert.equal(find(other, "c-group-head")[0]?.props["data-add"], "false");
  assert.equal(find(other, "c-iconbtn").length, 0);
  const general = one(html`<${list.Group} group=${groupBlocks(blocks).find((x) => x.key === "general")} compact=${false} on=${on} />`);
  assert.equal(find(general, "c-rows").length, 0);
  assert.equal(textOf(find(general, "c-group-hint")), "場所を決めていない話題");
  // 閉じた Fold は中身を出さない。disabled は onToggle を呼ばない
  const toggles: number[] = [];
  const closed = one(html`<${list.Fold} level="group" label="x" open=${false} onToggle=${() => void toggles.push(1)}>${html`<p class="c-fold-note">中</p>`}<//>`);
  assert.equal(closed.props["data-level"], "group");
  assert.equal(find(closed, "c-fold-body").length, 0);
  assert.equal(find(closed, "c-fold-head")[0]?.props["aria-expanded"], "false");
  const off = one(html`<${list.Fold} level="group" label="x" open=${true} disabled=${true} onToggle=${() => void toggles.push(2)}>${html`<p class="c-fold-note">中</p>`}<//>`);
  const offHead = find(off, "c-fold-head")[0] as El;
  assert.equal(offHead.props["aria-disabled"], "true");
  (offHead.props.onClick as () => void)();
  (find(closed, "c-fold-head")[0]?.props.onClick as () => void)();
  assert.deepEqual(toggles, [1]);
  assert.equal(textOf(find(off, "c-fold-body")), "中");
  // Others は forced で押しても toggleOthers を呼ばない
  const filtered = list.listModel(stateOf(sampleData(), { filter: "Bの終わった", doneGroup: "p:b", dataDone: "p:b" })).blocks.find((b) => b.type === "others");
  const o = one(html`<${list.Others} others=${filtered} compact=${false} on=${on} />`);
  assert.equal(find(o, "c-group").length, 1);
  (find(o, "c-fold-head")[0]?.props.onClick as () => void)();
  assert.equal(calls.filter((c) => c[0] === "toggleOthers").length, 0);
  const plain = one(html`<${list.Others} others=${list.listModel(stateOf(sampleData())).blocks.find((b) => b.type === "others")} compact=${false} on=${on} />`);
  (find(plain, "c-fold-head")[0]?.props.onClick as () => void)();
  assert.equal(calls.filter((c) => c[0] === "toggleOthers").length, 1);
});

// ===== 下のバー（c-shell.js。docs/plan/web-ui-components.md §6 の K3） =====
const shellUrl = new URL("../src/web/static/c-shell.js", import.meta.url).href;
const shell = (await import(shellUrl)) as Record<string, Fn> & {
  handLabel: (mark: unknown) => string;
  listLabel: (turns: unknown) => string;
  bottomModel: (o: Obj) => { variant: string; items: Obj[] };
  topModel: (o: Obj) => Obj | null;
};

test("web components: handLabel・listLabel（0 件は数を言わない・99+）", () => {
  assert.equal(shell.handLabel(null), "右腕に頼む・訊く");
  assert.equal(shell.handLabel("turn"), "右腕に頼む・訊く（あなたの番）");
  assert.equal(shell.handLabel("unread"), "右腕に頼む・訊く（未読）");
  assert.equal(shell.listLabel(0), "一覧");
  assert.equal(shell.listLabel(2), "一覧（あなたの番 2 件）");
  assert.equal(shell.listLabel(120), "一覧（あなたの番 99+ 件）");
});

test("web components: bottomModel は phone で 一覧・右腕・ほか、wide で tabs の順と「ほか」。知らない値を丸める", () => {
  assert.deepEqual(shell.bottomModel({ variant: "phone", turns: 2, hand: "turn" }), {
    variant: "phone",
    items: [
      { act: "list", label: "一覧", name: "一覧（あなたの番 2 件）", count: 2 },
      { act: "hand", label: "右腕に頼む・訊く", name: "右腕に頼む・訊く（あなたの番）", mark: "turn" },
      { act: "more", label: "ほか" },
    ],
  });
  const quiet = shell.bottomModel({ variant: "tablet", turns: "3", hand: null });
  assert.equal(quiet.variant, "phone");
  assert.deepEqual([quiet.items[0]?.count, quiet.items[0]?.name, quiet.items[1]?.mark], [0, "一覧", null]);
  assert.deepEqual(shell.bottomModel({ variant: "wide", tabs: [{ id: "tasks", title: "タスク" }, { id: "reminders", title: "リマインド" }] }), {
    variant: "wide",
    items: [
      { act: "tab", id: "tasks", label: "タスク" },
      { act: "tab", id: "reminders", label: "リマインド" },
      { act: "more", label: "ほか" },
    ],
  });
  assert.deepEqual(shell.bottomModel({ variant: "wide", tabs: null }).items, [{ act: "more", label: "ほか" }]);
});

test("web components: BottomBar の形と押したとき（ほか・tab は K2 の Button、一覧・右腕は自前）", () => {
  const calls: unknown[][] = [];
  const rec = (name: string) => (...a: unknown[]): void => void calls.push([name, ...a]);
  const on = { list: rec("list"), hand: rec("hand"), tab: rec("tab"), more: rec("more") };
  const bar = one(html`<${shell.BottomBar} variant="phone" turns=${120} hand="unread" on=${on} />`);
  assert.deepEqual([bar.props.role, bar.props["aria-label"], bar.props["data-variant"]], ["group", "移動", "phone"]);
  const v = shell.BottomBar({ variant: "phone", turns: 2, hand: null, on }) as VNode;
  assert.deepEqual(keysOf(v.props.children), ["list", "hand", "more"]);
  const listBtn = find(bar, "c-bottom-btn")[0] as El;
  assert.deepEqual([listBtn.type, listBtn.props["data-act"], listBtn.props["aria-current"], listBtn.props["aria-label"]], ["button", "list", "page", "一覧（あなたの番 99+ 件）"]);
  assert.equal(textOf(find(listBtn, "c-bottom-btn-label")), "一覧");
  assert.equal(textOf(find(listBtn, "c-badge")), "99+");
  const hand = find(bar, "c-bottom-hand")[0] as El;
  assert.deepEqual([hand.props["data-act"], hand.props["aria-label"]], ["hand", "右腕に頼む・訊く（未読）"]);
  assert.match(String(((find(hand, "c-icon")[0] as El).children[0] as El).props.href), /#bot$/);
  const mark = find(hand, "c-bottom-hand-mark")[0] as El;
  assert.deepEqual([mark.props["data-state"], mark.props["aria-hidden"]], ["unread", "true"]);
  const more = find(bar, "c-btn")[0] as El;
  assert.deepEqual([more.props["data-kind"], more.props["data-size"], textOf(more)], ["ghost", "sm", "ほか"]);
  const x = { scrollIntoView: () => undefined };
  const y = { scrollIntoView: () => undefined };
  (listBtn.props.onClick as (e: unknown) => void)({ currentTarget: x });
  (hand.props.onClick as (e: unknown) => void)({ currentTarget: y });
  (more.props.onClick as (e: unknown) => void)({ preventDefault: () => undefined, currentTarget: x });
  assert.deepEqual(calls, [["list"], ["hand", y], ["more", x]]);
  // 0 件・印なし
  const quiet = one(html`<${shell.BottomBar} variant="phone" turns=${0} hand=${null} on=${on} />`);
  assert.equal(find(quiet, "c-badge").length, 0);
  assert.equal(find(quiet, "c-bottom-hand-mark").length, 0);
  assert.equal(find(quiet, "c-bottom-btn")[0]?.props["aria-label"], "一覧");
  // wide: 文字のボタン 3 つ、key は tab: + id
  const wideV = shell.BottomBar({ variant: "wide", tabs: [{ id: "tasks", title: "タスク" }, { id: "reminders", title: "リマインド" }], on }) as VNode;
  assert.deepEqual(keysOf(wideV.props.children), ["tab:tasks", "tab:reminders", "more"]);
  const wide = one(wideV);
  assert.equal(wide.props["data-variant"], "wide");
  const btns = find(wide, "c-btn");
  assert.deepEqual(btns.map((b) => [b.props["data-kind"], b.props["data-size"], textOf(b)]), [["ghost", "sm", "タスク"], ["ghost", "sm", "リマインド"], ["ghost", "sm", "ほか"]]);
  assert.equal(find(wide, "c-bottom-btn").length + find(wide, "c-bottom-hand").length, 0);
  calls.length = 0;
  (btns[1]?.props.onClick as (e: unknown) => void)(fakeEvent());
  (btns[2]?.props.onClick as (e: unknown) => void)({ preventDefault: () => undefined, currentTarget: y });
  assert.deepEqual(calls, [["tab", "reminders"], ["more", y]]);
});

test("web components: BottomBar の右腕のボタンは controls を渡したときだけ aria-controls を持ち、aria-expanded は付けない", () => {
  const on = { list: () => undefined, hand: () => undefined, tab: () => undefined, more: () => undefined };
  const handOf = (bar: unknown): El => find(one(bar), "c-bottom-hand")[0] as El;
  const withControls = handOf(html`<${shell.BottomBar} variant="phone" turns=${0} hand=${null} controls="v3-hand" on=${on} />`);
  assert.deepEqual([withControls.props["aria-controls"], withControls.props["aria-expanded"]], ["v3-hand", undefined]);
  assert.equal(handOf(html`<${shell.BottomBar} variant="phone" turns=${0} hand=${null} on=${on} />`).props["aria-controls"], undefined);
  assert.equal(handOf(html`<${shell.BottomBar} variant="phone" turns=${0} hand=${null} controls="" on=${on} />`).props["aria-controls"], undefined);
  assert.equal(handOf(html`<${shell.BottomBar} variant="phone" turns=${0} hand=${null} controls=${3} on=${on} />`).props["aria-controls"], undefined);
});

test("web components: 知らない turn の kind は「あなたの番」の語（行の状態の語と、あなたの番の meta）", () => {
  assert.equal(list.turnWord("permission"), "許可");
  for (const k of ["later", undefined, null, "constructor", "toString"]) assert.equal(list.turnWord(k), "あなたの番", String(k));
  const ctx = { isUnread: () => false, time: () => "12:00", current: null };
  assert.deepEqual(list.rowModel(topicOf({ mark: "turn", turn: turnOf("later") }), ctx).state, { text: "あなたの番", tone: "warning" });
  assert.deepEqual(list.rowModel(topicOf({ mark: "turn", turn: null }), ctx).state, { text: "あなたの番", tone: "warning" });
  const d = sampleData();
  (d.topics as Obj[])[0] = topicOf({ id: "ch:1", mark: "turn", turn: turnOf("later", "要約") });
  assert.equal(list.turnItem("ch:1", stateOf(d))?.meta, "あなたの番・1 分前");
  const row = find(one(html`<${list.TopicRow} row=${list.rowModel((d.topics as Obj[])[0] as Obj, ctx)} onOpen=${() => undefined} />`), "c-row-state")[0] as El;
  assert.equal(textOf(row), "あなたの番");
});

test("web components: listModel は配列でない turnIds を空とし、同じ id は最初の 1 つだけ。bottomModel は tabs の null・id の無い物を捨てる", () => {
  for (const turnIds of [undefined, null, "ch:1", { 0: "ch:1" }]) {
    const d = sampleData();
    d.turnIds = turnIds;
    assert.equal(list.listModel(stateOf(d)).turns, null, String(turnIds));
  }
  const dup = sampleData();
  dup.turnIds = ["ch:1", "hand:1", "ch:1", "hand:1"];
  const m = list.listModel(stateOf(dup, { current: "hand:1" }));
  assert.deepEqual(m.turns?.items.map((t) => t.id), ["ch:1", "hand:1"]);
  assert.equal(m.turns?.nextId, "ch:1");
  const tabs = [null, { title: "名前だけ" }, { id: "", title: "空" }, { id: "tasks", title: "タスク" }, undefined, "x", { id: null, title: "n" }];
  assert.deepEqual(shell.bottomModel({ variant: "wide", tabs }).items, [{ act: "tab", id: "tasks", label: "タスク" }, { act: "more", label: "ほか" }]);
});

// ===== 会話の見出し（TopBar。c-shell.js。docs/plan/web-ui-components.md §6 の K4） =====
const topProps = (o: Obj = {}): Obj => ({
  variant: "phone",
  view: "talk",
  title: "日程の取得が遅い",
  status: { text: "あなたの番", tone: "warning" },
  note: null,
  place: { text: "General", movable: true, reason: null },
  views: null,
  hand: "turn",
  menu: true,
  ...o,
});
const topRec = (): { calls: unknown[][]; on: Record<string, (...a: unknown[]) => void> } => {
  const calls: unknown[][] = [];
  const rec = (name: string) => (...a: unknown[]): void => void calls.push([name, ...a]);
  return { calls, on: { back: rec("back"), place: rec("place"), view: rec("view"), menu: rec("menu"), hand: rec("hand") } };
};

test("web components: topModel は view が talk・other でなければ null", () => {
  for (const view of ["none", "list", "", undefined, null]) assert.equal(shell.topModel(topProps({ view })), null, String(view));
  assert.equal(shell.topModel({}), null);
});

test("web components: topModel の phone・talk（戻る・右腕、場所と切り替えは出さず、rest は場所と補足）", () => {
  const m = shell.topModel(topProps({ views: { value: "pane" } })) as Obj;
  assert.deepEqual(m, {
    variant: "phone",
    view: "talk",
    title: "日程の取得が遅い",
    back: true,
    compact: false,
    status: { text: "あなたの番", tone: "warning" },
    rest: "場所: General",
    place: null,
    views: null,
    menu: true,
    hand: { name: shell.handLabel("turn"), mark: "turn" },
  });
  assert.equal((shell.topModel(topProps({ variant: "tablet" })) as Obj).variant, "phone");
  assert.equal(shell.topModel(topProps({ note: "調べ物" }))?.rest, "場所: General ・ 調べ物");
  assert.equal(shell.topModel(topProps({ place: null, note: "調べ物" }))?.rest, "調べ物");
  assert.equal(shell.topModel(topProps({ place: null, note: "" }))?.rest, "");
  for (const [hand, mark] of [["unread", "unread"], [null, null], ["x", null]] as const) {
    assert.deepEqual(shell.topModel(topProps({ hand }))?.hand, { name: shell.handLabel(mark), mark }, String(hand));
  }
  assert.equal(shell.topModel(topProps({ title: 3 }))?.title, "");
});

test("web components: topModel の wide・talk（戻る・右腕なし、場所の押せる・押せない、切り替え、rest は補足だけ）", () => {
  const m = shell.topModel(topProps({ variant: "wide", note: "調べ物", views: { value: "pane" } })) as Obj;
  assert.deepEqual([m.variant, m.back, m.hand, m.rest, m.menu], ["wide", false, null, "調べ物", true]);
  assert.deepEqual(m.place, { text: "General", label: "場所: General", disabled: false, reason: null });
  assert.deepEqual(m.views, { value: "pane", items: [{ value: "talk", label: "会話" }, { value: "pane", label: "端末" }] });
  assert.equal((shell.topModel(topProps({ variant: "wide", views: { value: "x" } })) as Obj & { views: Obj }).views.value, "talk");
  assert.equal(shell.topModel(topProps({ variant: "wide" }))?.views, null);
  assert.equal(shell.topModel(topProps({ variant: "wide" }))?.rest, "");
  const reason = "Claude Code のセッションは場所を変えられません";
  assert.deepEqual(shell.topModel(topProps({ variant: "wide", place: { text: "self-agent", movable: { reason }, reason } }))?.place, { text: "self-agent", label: "場所: self-agent", disabled: true, reason });
  assert.deepEqual(shell.topModel(topProps({ variant: "wide", place: { text: "a", movable: false, reason: "" } }))?.place, { text: "a", label: "場所: a", disabled: true, reason: null });
  // 押せるときは reason を出さない
  assert.deepEqual(shell.topModel(topProps({ variant: "wide", place: { text: "a", movable: true, reason } }))?.place, { text: "a", label: "場所: a", disabled: false, reason: null });
  assert.equal(shell.topModel(topProps({ variant: "wide", place: null }))?.place, null);
  // text が空でない文字列でなければ場所なし（帯のボタンも、補足の「場所: 」も出さない）
  for (const place of [{}, { text: "" }, { text: null }, { text: 3, movable: true }, "General"]) {
    assert.equal(shell.topModel(topProps({ variant: "wide", place }))?.place, null, JSON.stringify(place));
    assert.equal(shell.topModel(topProps({ place, note: "調べ物" }))?.rest, "調べ物", JSON.stringify(place));
    assert.equal(shell.topModel(topProps({ variant: "wide", compact: true, place }))?.rest, "", JSON.stringify(place));
  }
});

test("web components: topModel の wide・compact（場所・切り替えは null、rest は場所と補足。phone は compact を渡しても変わらない）", () => {
  const props = topProps({ variant: "wide", compact: true, note: "調べ物", views: { value: "pane" } });
  assert.deepEqual(shell.topModel(props), {
    variant: "wide",
    view: "talk",
    title: "日程の取得が遅い",
    back: false,
    compact: true,
    status: { text: "あなたの番", tone: "warning" },
    rest: "場所: General ・ 調べ物",
    place: null,
    views: null,
    menu: true,
    hand: null,
  });
  assert.equal(shell.topModel({ ...props, note: null })?.rest, "場所: General");
  assert.equal(shell.topModel({ ...props, place: null })?.rest, "調べ物");
  assert.equal(shell.topModel({ ...props, place: null, note: null })?.rest, "");
  // true のときだけ効く
  for (const compact of [false, "true", 1, undefined]) assert.equal(shell.topModel({ ...props, compact })?.compact, false, String(compact));
  assert.notEqual(shell.topModel({ ...props, compact: "true" })?.place, null);
  // phone は無視する
  const phone = topProps({ note: "調べ物" });
  assert.deepEqual(shell.topModel({ ...phone, compact: true }), shell.topModel(phone));
  // other は compact でも題だけ
  assert.deepEqual(shell.topModel({ ...props, view: "other" })?.rest, "");
});

test("web components: topModel の other（状態・補足・場所・切り替え・「…」なし。phone は戻ると右腕だけ残る）", () => {
  const props = topProps({ view: "other", title: "設定", note: "調べ物", views: { value: "talk" } });
  assert.deepEqual(shell.topModel(props), {
    variant: "phone", view: "other", title: "設定", back: true, compact: false, status: null, rest: "", place: null, views: null, menu: false, hand: { name: shell.handLabel("turn"), mark: "turn" },
  });
  assert.deepEqual(shell.topModel({ ...props, variant: "wide" }), {
    variant: "wide", view: "other", title: "設定", back: false, compact: false, status: null, rest: "", place: null, views: null, menu: false, hand: null,
  });
});

test("web components: topModel の状態（空の文は null、知らない tone は muted）", () => {
  assert.equal(shell.topModel(topProps({ status: { text: "", tone: "warning" } }))?.status, null);
  assert.equal(shell.topModel(topProps({ status: { tone: "warning" } }))?.status, null);
  assert.equal(shell.topModel(topProps({ status: null }))?.status, null);
  assert.deepEqual(shell.topModel(topProps({ status: { text: "作業中", tone: "danger" } }))?.status, { text: "作業中", tone: "muted" });
  assert.deepEqual(shell.topModel(topProps({ status: { text: "作業中", tone: "accent" } }))?.status, { text: "作業中", tone: "accent" });
});

test("web components: TopBar の phone（戻る・題・「…」・右腕の順、sub の文、押したとき、aria-controls）", () => {
  const { calls, on } = topRec();
  const v = shell.TopBar({ ...topProps(), on }) as VNode;
  assert.deepEqual(keysOf(v.props.children), ["back", "text", "menu", "hand"]);
  const bar = one(v);
  assert.deepEqual([bar.type, bar.props.class, bar.props["data-variant"], bar.props["data-view"]], ["header", "c-top", "phone", "talk"]);
  assert.deepEqual(bar.children.map((c) => (c as El).props.class), ["c-top-act", "c-top-text", "c-top-act", "c-top-hand"]);
  assert.deepEqual(bar.children.map((c) => (c as El).props["data-act"]), ["back", undefined, "menu", "hand"]);
  const title = find(bar, "c-top-title")[0] as El;
  assert.deepEqual([title.type, textOf(title)], ["h1", "日程の取得が遅い"]);
  const sub = find(bar, "c-top-sub")[0] as El;
  assert.equal(sub.type, "p");
  assert.equal(textOf(sub), "あなたの番 ・ 場所: General");
  assert.equal((find(sub, "c-top-status")[0] as El).props["data-tone"], "warning");
  assert.equal(find(bar, "c-top-place").length + find(bar, "c-top-views").length + find(bar, "c-top-gap").length, 0);
  const [back, menu] = find(bar, "c-iconbtn") as [El, El];
  assert.deepEqual([back.props["aria-label"], menu.props["aria-label"]], ["一覧へ", "ほかの操作"]);
  assert.match(String(((find(back, "c-icon")[0] as El).children[0] as El).props.href), /#chevron-left$/);
  assert.match(String(((find(menu, "c-icon")[0] as El).children[0] as El).props.href), /#ellipsis$/);
  const hand = find(bar, "c-top-hand")[0] as El;
  assert.deepEqual([hand.type, hand.props.type, hand.props["aria-label"], hand.props["aria-controls"], hand.props["aria-expanded"]], ["button", "button", shell.handLabel("turn"), undefined, undefined]);
  assert.match(String(((find(hand, "c-icon")[0] as El).children[0] as El).props.href), /#bot$/);
  assert.equal(textOf(find(hand, "c-top-hand-label")), "右腕");
  const mark = find(hand, "c-top-hand-mark")[0] as El;
  assert.deepEqual([mark.props["data-state"], mark.props["aria-hidden"]], ["turn", "true"]);
  const x = { scrollIntoView: () => undefined };
  const y = { scrollIntoView: () => undefined };
  (back.props.onClick as (e: unknown) => void)({ preventDefault: () => undefined, currentTarget: x });
  (menu.props.onClick as (e: unknown) => void)({ preventDefault: () => undefined, currentTarget: x });
  (hand.props.onClick as (e: unknown) => void)({ currentTarget: y });
  assert.deepEqual(calls, [["back"], ["menu", x], ["hand", y]]);
  // controls を渡したときだけ。印が無ければ点を出さない
  const withControls = one(html`<${shell.TopBar} ...${topProps({ hand: null })} controls="v3-hand" on=${on} />`);
  assert.equal((find(withControls, "c-top-hand")[0] as El).props["aria-controls"], "v3-hand");
  assert.equal(find(withControls, "c-top-hand-mark").length, 0);
  assert.equal((find(one(html`<${shell.TopBar} ...${topProps()} controls="" on=${on} />`), "c-top-hand")[0] as El).props["aria-controls"], undefined);
  // 状態だけ・補足だけ・どちらも無い（sub を出さない）
  assert.equal(textOf(find(one(html`<${shell.TopBar} ...${topProps({ place: null })} on=${on} />`), "c-top-sub")), "あなたの番");
  assert.equal(textOf(find(one(html`<${shell.TopBar} ...${topProps({ status: null })} on=${on} />`), "c-top-sub")), "場所: General");
  assert.equal(find(one(html`<${shell.TopBar} ...${topProps({ status: null, place: null })} on=${on} />`), "c-top-sub").length, 0);
  // 「…」なし
  assert.deepEqual(keysOf((shell.TopBar({ ...topProps({ menu: false }), on }) as VNode).props.children), ["back", "text", "hand"]);
});

test("web components: TopBar の wide（題・状態・場所・gap・切り替え・「…」の順、戻る・右腕なし、場所の title、切り替え）", () => {
  const { calls, on } = topRec();
  const reason = "Claude Code のセッションは場所を変えられません";
  const props = topProps({ variant: "wide", status: { text: "判断待ち", tone: "warning" }, place: { text: "self-agent", movable: false, reason }, views: { value: "talk" } });
  const v = shell.TopBar({ ...props, on }) as VNode;
  assert.deepEqual(keysOf(v.props.children), ["text", "status", "place", "gap", "views", "menu"]);
  const bar = one(v);
  assert.equal(bar.props["data-variant"], "wide");
  assert.deepEqual(bar.children.map((c) => (c as El).props.class), ["c-top-text", "c-top-status", "c-top-place", "c-top-gap", "c-top-views", "c-top-act"]);
  assert.equal(find(bar, "c-top-sub").length, 0);
  assert.equal(find(bar, "c-top-hand").length, 0);
  assert.deepEqual(find(bar, "c-iconbtn").map((b) => b.props["aria-label"]), ["ほかの操作"]);
  assert.deepEqual([textOf(bar.children[1] as El), (bar.children[1] as El).props["data-tone"]], ["判断待ち", "warning"]);
  const place = bar.children[2] as El;
  assert.deepEqual(
    [place.type, place.props.type, place.props["data-act"], place.props["aria-haspopup"], "disabled" in place.props, place.props.title, place.props["aria-disabled"], place.props["aria-label"]],
    ["button", "button", "place", "dialog", false, reason, "true", "場所: self-agent"],
  );
  // 帯に見せる字は名前だけ
  assert.equal(textOf(find(place, "c-top-place-text")), "self-agent");
  // 動かせないときは押しても on.place を呼ばない
  const pe = fakeEvent();
  (place.props.onClick as (e: unknown) => void)(pe);
  assert.equal(pe.count(), 1);
  // 理由が無ければ title も無い
  const noReason = find(one(html`<${shell.TopBar} ...${{ ...props, place: { text: "self-agent", movable: false } }} on=${on} />`), "c-top-place")[0] as El;
  assert.deepEqual([noReason.props["aria-disabled"], noReason.props.title], ["true", undefined]);
  const chevron = find(place, "c-icon")[0] as El;
  assert.deepEqual([chevron.props["data-size"], String((chevron.children[0] as El).props.href).endsWith("#chevron-down")], ["sm", true]);
  const seg = find(bar, "c-seg")[0] as El;
  assert.deepEqual([seg.props.role, seg.props["aria-label"]], ["radiogroup", "見る物"]);
  const items = find(seg, "c-seg-item");
  assert.deepEqual(items.map((i) => [textOf(i), i.props["aria-checked"]]), [["会話", "true"], ["端末", "false"]]);
  (items[1]?.props.onClick as (e: unknown) => void)(fakeEvent());
  // 押せる場所は aria-disabled なし・title は「場所を変える」・押すと opener を渡す
  const movable = one(html`<${shell.TopBar} ...${topProps({ variant: "wide", note: "調べ物" })} on=${on} />`);
  const p2 = find(movable, "c-top-place")[0] as El;
  assert.deepEqual(["disabled" in p2.props, p2.props["aria-disabled"], p2.props.title, p2.props["aria-label"], textOf(find(p2, "c-top-place-text"))], [false, undefined, "場所を変える", "場所: General", "General"]);
  const x = { scrollIntoView: () => undefined };
  (p2.props.onClick as (e: unknown) => void)({ currentTarget: x });
  assert.deepEqual(calls, [["view", "pane"], ["place", x]]);
  assert.deepEqual(keysOf((shell.TopBar({ ...topProps({ variant: "wide", note: "調べ物" }), on }) as VNode).props.children), ["text", "status", "rest", "place", "gap", "menu"]);
  assert.equal(textOf(find(movable, "c-top-rest")), "調べ物");
  // other: 題と gap だけ
  assert.deepEqual(keysOf((shell.TopBar({ ...topProps({ variant: "wide", view: "other", title: "ナレッジ" }), on }) as VNode).props.children), ["text", "gap"]);
});

test("web components: TopBar の wide・compact（題・状態・補足・gap・「…」の順、data-compact、場所と切り替えが無い）", () => {
  const { on } = topRec();
  const props = topProps({ variant: "wide", compact: true, note: "調べ物", place: { text: "self-agent", movable: false, reason: "x" }, views: { value: "talk" } });
  const v = shell.TopBar({ ...props, on }) as VNode;
  assert.deepEqual(keysOf(v.props.children), ["text", "status", "rest", "gap", "menu"]);
  const bar = one(v);
  assert.deepEqual([bar.props["data-variant"], bar.props["data-compact"]], ["wide", "true"]);
  assert.equal(textOf(find(bar, "c-top-rest")), "場所: self-agent ・ 調べ物");
  assert.equal(find(bar, "c-top-place").length + find(bar, "c-seg").length + find(bar, "c-top-hand").length + find(bar, "c-top-sub").length, 0);
  // compact でない wide・phone には data-compact が無い
  assert.equal(one(html`<${shell.TopBar} ...${{ ...props, compact: false }} on=${on} />`).props["data-compact"], undefined);
  assert.equal(one(html`<${shell.TopBar} ...${topProps({ variant: "wide" })} on=${on} />`).props["data-compact"], undefined);
  assert.equal(one(html`<${shell.TopBar} ...${topProps({ compact: true })} on=${on} />`).props["data-compact"], undefined);
});

test("web components: TopBar は view が none・知らない値で null。c-shell.js（TopBar を含む）は id の見張りの対象", () => {
  const { on } = topRec();
  for (const view of ["none", "x", undefined]) assert.equal(shell.TopBar({ ...topProps({ view }), on }), null, String(view));
  assert.deepEqual(expand(html`<${shell.TopBar} ...${topProps({ view: "none" })} on=${on} />`), []);
  const src = stripJsComments(read("c-shell.js"));
  assert.match(src, /export function TopBar\(/);
  assert.doesNotMatch(src, /(?<![\w-])id=/);
  // 描いた木にも id が無い
  const ids = (t: Tree): string[] => (typeof t === "string" ? [] : [...(t.props.id === undefined ? [] : [String(t.props.id)]), ...t.children.flatMap(ids)]);
  for (const props of [topProps({ controls: "v3-hand" }), topProps({ variant: "wide", views: { value: "pane" } })]) assert.deepEqual(ids(one(html`<${shell.TopBar} ...${props} on=${on} />`)), []);
});
