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
  "top-full-min", "top-place-min", "talk-max", "bubble-pad-y", "bubble-pad-x", "card-max", "check", "deck-band-h", "deck-col-max", "deck-line",
].map((n) => `--c-${n}`);

/** c-*.css が var() で使ってよい --c-* 以外の変数（base.css の目盛り・tokens.css の色・動き・重なり・字） */
const ALLOWED_VARS: ReadonlySet<string> = new Set([
  ...[1, 2, 3, 4, 5, 6, 7, 8].map((n) => `space-${n}`),
  "font-xs", "font-sm", "font-base", "leading-normal", "leading-tight", "weight-normal", "weight-medium", "weight-semibold",
  "radius-sm", "radius-md", "radius-lg", "radius-full", "border-width", "ring-width", "dialog-max", "container-max",
  "bg", "surface", "muted", "border", "text", "text-secondary", "text-muted", "primary", "primary-text", "accent", "danger", "success", "warning", "backdrop", "shadow-sm",
  "dur-micro", "dur-short", "dur-long", "ease-out", "z-toast", "font-mono", "bubble-owner", "bubble-agent", "bubble-inset", "turn-surface", "bench",
].map((n) => `--${n}`));

/** ファイルごとのセレクタの頭（c-gallery.css は test/web-vendor.test.ts がもっと狭く見ている） */
const SELECTOR_HEAD: Record<string, RegExp> = {
  "c-atoms.css": /^\.c-(?:icon|btn|iconbtn|badge|mark|seg|field|input|empty|loading)(?![a-z])/,
  "c-sheet.css": /^\.c-(?:sheet|confirm|toast)(?![a-z])/,
  "c-list.css": /^\.c-(?:list|turns|turn|group|rows|row|fold)(?![a-z])/,
  "c-shell.css": /^\.c-(?:bottom|top)(?![a-z])/,
  "c-talk.css": /^\.c-(?:talk|msg|bubble|md|steps|run|notice|divider|refs|ref)(?![a-z])/,
  "c-composer.css": /^\.c-composer(?![a-z])/,
  "c-cards.css": /^\.c-(?:cards|card|note|status)(?![a-z])/,
  "c-hand.css": /^\.c-hand(?![a-z])/,
  "c-term.css": /^\.c-term(?![a-z])/,
  "c-deck.css": /^\.c-(?:deck|col|item|band)(?![a-z])/,
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
  for (const name of ["c-atoms.css", "c-sheet.css", "c-list.css", "c-shell.css", "c-talk.css", "c-composer.css", "c-cards.css", "c-hand.css", "c-term.css", "c-deck.css", "c-gallery.css"]) assert.ok(CSS_FILES.includes(name), name);
  for (const name of ["c-atoms.js", "c-sheet.js", "c-list.js", "c-shell.js", "c-talk.js", "c-composer.js", "c-cards.js", "c-hand.js", "c-term.js", "c-deck.js", "c-gallery.js", "c-lib.js", "c-app.js"]) assert.ok(JS_FILES.includes(name), name);
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

/** WCAG の相対輝度（#rrggbb） */
function luminance(hex: string): number {
  const ch = (i: number): number => {
    const c = parseInt(hex.slice(1 + i * 2, 3 + i * 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * ch(0) + 0.7152 * ch(1) + 0.0722 * ch(2);
}

const contrast = (a: string, b: string): number => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
};

test("web components: --turn-surface は tokens.css の色の 4 つの塊に在り、ダーク・ライトで値が揃い、その上の字は 4.5 以上・--warning と --accent は 3 以上", () => {
  const blocks = parseCss(read("tokens.css")).filter((r) => r.body.includes("--turn-surface:"));
  assert.equal(blocks.length, 4);
  const valuesOf = (r: CssRule): Map<string, string> => new Map([...r.body.matchAll(/(--[a-z0-9-]+):\s*(#[0-9a-f]{6})\b/g)].map((m) => [m[1] ?? "", m[2] ?? ""]));
  const dark = blocks.filter((r) => r.selectors.includes(':root[data-theme="dark"]') || r.at.some((at) => at.includes("prefers-color-scheme: dark")));
  const light = blocks.filter((r) => !dark.includes(r));
  assert.equal(dark.length, 2);
  assert.equal(light.length, 2);
  for (const [group, want] of [[dark, "#2c2721"], [light, "#f4ebe1"]] as const) {
    for (const block of group) {
      const v = valuesOf(block);
      const surface = v.get("--turn-surface");
      assert.equal(surface, want, block.selectors.join(","));
      for (const name of ["--text", "--text-secondary", "--text-muted", "--danger"]) assert.ok(contrast(v.get(name)!, want) >= 4.5, `${name} ${contrast(v.get(name)!, want)}`);
      for (const name of ["--warning", "--accent"]) assert.ok(contrast(v.get(name)!, want) >= 3, `${name} ${contrast(v.get(name)!, want)}`);
    }
  }
  // 計算の見本（GUIDELINES §2.2 の白と黒）
  assert.equal(Math.round(contrast("#ffffff", "#000000")), 21);
});

test("web components: --bench（台）は tokens.css の色の 4 つの塊に在り、ダーク・ライトで値が揃い、--text・--text-muted を載せて 4.5 以上、板（--surface）との比はダーク 1.09・ライト 1.15 以上", () => {
  const blocks = parseCss(read("tokens.css")).filter((r) => r.body.includes("--bench:"));
  assert.equal(blocks.length, 4);
  const valuesOf = (r: CssRule): Map<string, string> => new Map([...r.body.matchAll(/(--[a-z0-9-]+):\s*(#[0-9a-f]{6})\b/g)].map((m) => [m[1] ?? "", m[2] ?? ""]));
  const dark = blocks.filter((r) => r.selectors.includes(':root[data-theme="dark"]') || r.at.some((at) => at.includes("prefers-color-scheme: dark")));
  const light = blocks.filter((r) => !dark.includes(r));
  assert.equal(dark.length, 2);
  assert.equal(light.length, 2);
  for (const [group, want, apart] of [[dark, "#05060a", 1.09], [light, "#e9edf2", 1.15]] as const) {
    for (const block of group) {
      const v = valuesOf(block);
      const bench = v.get("--bench");
      assert.equal(bench, want, block.selectors.join(","));
      for (const name of ["--text", "--text-muted"]) assert.ok(contrast(v.get(name)!, want) >= 4.5, `${name} ${contrast(v.get(name)!, want)}`);
      assert.ok(contrast(v.get("--surface")!, want) >= apart, `--surface ${contrast(v.get("--surface")!, want)}`);
    }
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

test("web components: import の先（c-atoms は c-lib だけ、c-sheet・c-list・c-shell は c-lib と c-atoms だけ、c-talk・c-composer・c-cards・c-hand・c-term は c-lib と c-atoms だけ、c-deck は c-lib・c-atoms・c-list だけ、c-app は c-lib・c-list・c-shell・c-talk・c-composer・c-cards・c-sheet・c-hand・c-term・c-deck だけ。c-atoms・c-list・c-shell・c-talk・c-composer・c-cards・c-hand・c-term・c-deck・c-app は hook なし）・動的な import と createPortal が無い", () => {
  const allowed: Record<string, string[]> = {
    "c-atoms.js": ["./c-lib.js"],
    "c-sheet.js": ["./c-lib.js", "./c-atoms.js"],
    "c-list.js": ["./c-lib.js", "./c-atoms.js"],
    "c-shell.js": ["./c-lib.js", "./c-atoms.js"],
    "c-talk.js": ["./c-lib.js", "./c-atoms.js"],
    "c-composer.js": ["./c-lib.js", "./c-atoms.js"],
    "c-cards.js": ["./c-lib.js", "./c-atoms.js"],
    "c-hand.js": ["./c-lib.js", "./c-atoms.js"],
    "c-term.js": ["./c-lib.js", "./c-atoms.js"],
    "c-deck.js": ["./c-lib.js", "./c-atoms.js", "./c-list.js"],
    "c-app.js": ["./c-lib.js", "./c-list.js", "./c-shell.js", "./c-talk.js", "./c-composer.js", "./c-cards.js", "./c-sheet.js", "./c-hand.js", "./c-term.js", "./c-deck.js"],
  };
  for (const [name, targets] of Object.entries(allowed)) {
    if (!JS_FILES.includes(name)) continue;
    const { from, dynamic } = importsOf(read(name));
    for (const target of from) assert.ok(targets.includes(target), `${name}: ${target}`);
    assert.equal(dynamic, false, `${name}: 動的な import`);
  }
  for (const name of ["c-atoms.js", "c-list.js", "c-shell.js", "c-talk.js", "c-composer.js", "c-cards.js", "c-hand.js", "c-term.js", "c-deck.js", "c-app.js"]) if (JS_FILES.includes(name)) assert.doesNotMatch(read(name), /import\s*\{[^}]*\buse[A-Z]/, name);
  for (const name of JS_FILES) assert.doesNotMatch(read(name), /createPortal/, name);
});

test("web components: 一覧と下のバー（c-list・c-shell）と会話（c-talk）と入力欄（c-composer）とカード（c-cards）と右腕（c-hand）と札（c-term）と流れの列（c-deck）は id を出さず、K2 の部品のクラスを書くのは決めた 3 つのセレクタだけ。一覧と下のバーと入力欄とカードと右腕と札と流れの列は動きを付けず、会話は実行中の輪だけ。下のバーと右腕と札は position の fixed・absolute を書かない", () => {
  // 部品は id を出さない（モデルのキー id: や data-topic=${id} は当たらない）
  for (const name of ["c-list.js", "c-shell.js", "c-talk.js", "c-composer.js", "c-cards.js", "c-hand.js", "c-term.js", "c-deck.js"]) if (JS_FILES.includes(name)) assert.doesNotMatch(stripJsComments(read(name)), /(?<![\w-])id=/, name);
  // 部品の色・高さ・字を外から変えない（印の位置・PC の [+] の当たりを戻す・下のバーの並べ方だけ）
  const ALLOWED_OUTSIDE = new Set([".c-turn > .c-mark", '.c-group-head > .c-iconbtn[data-size="sm"]::after', '.c-bottom > .c-btn[data-size="sm"]']);
  // K2 の部品のクラス（c-atoms.css・c-sheet.css のセレクタに出る全部。その下のクラスも）は外から宛てない
  const atomClasses = new Set(["c-atoms.css", "c-sheet.css"].flatMap((file) => parseCss(read(file)).filter((r) => !r.keyframe).flatMap((r) => r.selectors.flatMap(classesInSelector))));
  for (const cls of ["c-btn", "c-iconbtn", "c-badge", "c-mark", "c-icon", "c-empty", "c-empty-text", "c-loading", "c-seg", "c-field", "c-input", "c-sheet", "c-toast"]) assert.ok(atomClasses.has(cls), cls);
  // 会話（c-talk.css）と入力欄（c-composer.css）は K2 の部品のクラスに 1 つも宛てない
  const talkRules = parseCss(read("c-talk.css"));
  for (const name of ["c-talk.css", "c-composer.css"]) {
    for (const rule of parseCss(read(name))) for (const selector of rule.selectors) assert.ok(!classesInSelector(selector).some((cls) => atomClasses.has(cls)), `${name}: ${selector}`);
  }
  // 会話の動きは実行中の輪（.c-run-spin）だけ
  for (const rule of talkRules) {
    if (/(?:^|; ?)(?:animation|transition)(?:-[a-z-]+)?\s*:/.test(rule.body)) assert.deepEqual(rule.selectors, [".c-run-spin"], `c-talk.css: ${rule.selectors.join(",")}`);
  }
  assert.equal((stripCssComments(read("c-talk.css")).match(/@keyframes\b/g) ?? []).length, 1, "c-talk.css: @keyframes は 1 つ");
  for (const name of ["c-list.css", "c-shell.css", "c-composer.css", "c-cards.css", "c-hand.css", "c-term.css", "c-deck.css"]) {
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
  if (CSS_FILES.includes("c-hand.css")) assert.doesNotMatch(stripCssComments(read("c-hand.css")), /position:\s*(?:fixed|absolute)/, "c-hand.css");
  if (CSS_FILES.includes("c-term.css")) assert.doesNotMatch(stripCssComments(read("c-term.css")), /position:\s*(?:fixed|absolute)/, "c-term.css");
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
  // 部品のテンプレートに出るタグ（c-composer.js は入れない: app.css の裸の textarea の規則（入力の位置の線の色）が当たる。同じ値を c-composer.css が書く。c-cards.js も入れない: app.css の裸の input, textarea が当たる。欄の線の色は c-cards.css が書く）
  const partTags = new Set<string>();
  for (const name of ["c-list.js", "c-shell.js", "c-atoms.js", "c-talk.js"]) for (const m of read(name).matchAll(/<([a-z][a-z0-9]*)[\s>/]/g)) partTags.add(m[1] ?? "");
  for (const tag of ["button", "ul", "li", "h1", "h2", "section", "span", "p", "div", "svg", "use", "header", "article", "pre", "code", "ol", "strong", "a"]) assert.ok(partTags.has(tag), tag);
  // base.css の reset（button・h2・p の字と余白を外す・継ぐ）は見本のページ（gallery.html）にも当たるので、見本との差にならない。
  // h1（見出しの題）は base.css の字と余白を .c-top-title が全部書き直す。
  // a（base.css の色と下線の位置）は見本にも本番にも当たるので差にならない。色は c-talk.css の .c-md-link が書く
  const BASE_OK = new Set(["button", "h1", "h2", "p", "a"]);
  assert.ok(parseCss(read("c-talk.css")).some((r) => r.at.length === 0 && r.selectors.includes(".c-md-link") && /(?:^|;)\s*color\s*:/.test(r.body)));
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
  assert.ok(cssProblems("c-talk.css", ".c-turnline{margin:0}").some((p) => p.includes("このファイルの頭")));
  assert.deepEqual(cssProblems("c-talk.css", ".c-bubble{background:var(--bubble-agent)}"), []);
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

test("web components: Button は押せるときだけ onPress に事象を渡して呼び、押せないときは aria-disabled と preventDefault。name が空でない文字列のときだけ aria-label（見える文は label のまま）", () => {
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
  assert.equal(on.props["aria-label"], undefined);
  assert.equal(textOf(find(on, "c-btn-label")), "始める");
  const named = one(html`<${atoms.Button} label="開く" name="話題 1 を開く" />`);
  assert.deepEqual([named.props["aria-label"], textOf(find(named, "c-btn-label"))], ["話題 1 を開く", "開く"]);
  for (const name of ["", 3, null]) assert.equal(one(html`<${atoms.Button} label="開く" name=${name} />`).props["aria-label"], undefined);
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

test("web components: toastSplit と Toast（失敗だけ alert、空でも 2 つの入れ物、× で onDismiss(id)。止める・消える途中）", () => {
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
  // 入れ物は足した知らせだけを読ませる
  assert.deepEqual(lists.map((l) => l.props["aria-atomic"]), ["false", "false"]);
  // 消える途中の行だけ data-leaving。onHold・onLeft は無くても呼べる
  const held: unknown[][] = [];
  const left: string[] = [];
  const leaving = [{ id: "a", text: "a" }, { id: "b", text: "b", leaving: true }];
  const rows = find(one(html`<${sheet.Toast} items=${leaving} onDismiss=${() => undefined} onHold=${(...a: unknown[]) => void held.push(a)} onLeft=${(id: string) => void left.push(id)} />`), "c-toast-item");
  assert.deepEqual(rows.map((r) => r.props["data-leaving"]), [undefined, "true"]);
  const [still, going] = rows as [El, El];
  const on = (row: El, name: string, event: unknown) => (row.props[name] as (e: unknown) => void)(event);
  // マウスのときだけ hover
  on(still, "onpointerenter", { pointerType: "touch" });
  on(still, "onpointerenter", { pointerType: "mouse" });
  on(still, "onpointerleave", { pointerType: "mouse" });
  // 中の別のボタンへ移るだけなら focus を外さない
  const inner = {};
  const self = { contains: (n: unknown) => n === inner };
  on(still, "onfocusin", {});
  on(still, "onfocusout", { relatedTarget: inner, currentTarget: self });
  on(still, "onfocusout", { relatedTarget: null, currentTarget: self });
  assert.deepEqual(held, [["a", "hover", true], ["a", "hover", false], ["a", "focus", true], ["a", "focus", false]]);
  // 消える途中の行そのものの transitionend だけ onLeft(id)
  on(still, "ontransitionend", { target: self, currentTarget: self });
  on(going, "ontransitionend", { target: inner, currentTarget: self });
  on(going, "ontransitionend", { target: self, currentTarget: self });
  assert.deepEqual(left, ["b"]);
  const bare = find(one(html`<${sheet.Toast} items=${leaving} onDismiss=${() => undefined} />`), "c-toast-item") as [El, El];
  on(bare[0], "onpointerenter", { pointerType: "mouse" });
  on(bare[1], "ontransitionend", { target: self, currentTarget: self });
});

// ===== 一覧（c-list.js。docs/plan/web-ui-components.md §6 の K3） =====
type Obj = Record<string, unknown>;
const listUrl = new URL("../src/web/static/c-list.js", import.meta.url).href;
const list = (await import(listUrl)) as Record<string, Fn> & {
  TURN_LABEL: Readonly<Record<string, string>>;
  DONE_MAX: number;
  STOPPED_LABEL: Readonly<Record<string, { text: string; tone: string }>>;
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

test("web components: STOPPED_LABEL は凍結した終わり方の語の表", () => {
  assert.deepEqual(JSON.parse(JSON.stringify(list.STOPPED_LABEL)), {
    max_turns: { text: "上限で停止", tone: "warning" },
    failed: { text: "失敗", tone: "warning" },
    aborted: { text: "中断", tone: "muted" },
  });
  assert.ok(Object.isFrozen(list.STOPPED_LABEL));
});

test("web components: rowModel は順番待ちを「順番待ち」、止まったを終わり方の語にし、時刻は出さない", () => {
  const ctx = { isUnread: () => false, time: (iso: string) => "t:" + iso, current: null };
  const queued = list.rowModel(topicOf({ queued: true }), ctx);
  assert.deepEqual(queued.state, { text: "順番待ち", tone: "muted" });
  assert.equal(queued.time, null);
  const stopped = (ended: unknown): unknown => {
    const r = list.rowModel(topicOf({ stopped: true, ended }), ctx);
    assert.equal(r.time, null);
    return r.state;
  };
  assert.deepEqual(stopped("max_turns"), { text: "上限で停止", tone: "warning" });
  assert.deepEqual(stopped("failed"), { text: "失敗", tone: "warning" });
  assert.deepEqual(stopped("aborted"), { text: "中断", tone: "muted" });
  assert.deepEqual(stopped("other"), { text: "停止", tone: "muted" });
  assert.deepEqual(stopped(null), { text: "停止", tone: "muted" });
  assert.deepEqual(stopped("toString"), { text: "停止", tone: "muted" });
  // false は今までどおり時刻
  const off = list.rowModel(topicOf({ queued: false, stopped: false, ended: "failed" }), ctx);
  assert.deepEqual([off.state, off.time], [null, "t:2026-01-01T00:00:00Z"]);
});

test("web components: rowModel の語の順は あなたの番 > 作業中 > 順番待ち > 止まった", () => {
  const ctx = { isUnread: () => false, time: () => "12:34", current: null };
  assert.deepEqual(list.rowModel(topicOf({ mark: "turn", turn: turnOf("question"), stopped: true, ended: "failed" }), ctx).state, { text: "質問", tone: "warning" });
  assert.deepEqual(list.rowModel(topicOf({ mark: "running", queued: true }), ctx).state, { text: "作業中", tone: "accent" });
  assert.deepEqual(list.rowModel(topicOf({ mark: "running", stopped: true, ended: "failed" }), ctx).state, { text: "作業中", tone: "accent" });
  assert.deepEqual(list.rowModel(topicOf({ queued: true, stopped: true, ended: "max_turns" }), ctx).state, { text: "順番待ち", tone: "muted" });
  // true のときだけ（ほかの値は語にしない）
  assert.equal(list.rowModel(topicOf({ queued: 1 }), ctx).state, null);
  assert.equal(list.rowModel(topicOf({ stopped: "yes", ended: "failed" }), ctx).state, null);
});

test("web components: rowModel は queued・stopped の無い話題を今までどおり時刻にし、未読の止まった話題は印が未読で語は表のとおり", () => {
  const ctx = { isUnread: () => true, time: () => "12:34", current: null };
  const old = topicOf({ id: "cc:1" });
  assert.equal("queued" in old || "stopped" in old, false);
  const plain = list.rowModel(old, ctx);
  assert.deepEqual([plain.state, plain.time], [null, "12:34"]);
  const unread = list.rowModel(topicOf({ id: "ch:5", stopped: true, ended: "max_turns" }), ctx);
  assert.equal(unread.mark, "unread");
  assert.deepEqual(unread.state, { text: "上限で停止", tone: "warning" });
  assert.equal(unread.time, null);
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
    mode: null,
    views: null,
    menu: true,
    hand: { name: shell.handLabel("turn"), mark: "turn" },
    close: false,
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
    mode: null,
    views: null,
    menu: true,
    hand: null,
    close: false,
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
    variant: "phone", view: "other", title: "設定", back: true, compact: false, status: null, rest: "", place: null, mode: null, views: null, menu: false, hand: { name: shell.handLabel("turn"), mark: "turn" }, close: false,
  });
  assert.deepEqual(shell.topModel({ ...props, variant: "wide" }), {
    variant: "wide", view: "other", title: "設定", back: false, compact: false, status: null, rest: "", place: null, mode: null, views: null, menu: false, hand: null, close: false,
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

// ===== 会話の行（c-talk.js。docs/plan/web-ui-components.md §6 の K4） =====
const talkUrl = new URL("../src/web/static/c-talk.js", import.meta.url).href;
const talk = (await import(talkUrl)) as Record<string, Fn> & {
  splitLinks: (text: string) => { type: string; text: string }[];
  parseBlocks: (text: string) => Obj[];
  footOf: (turn: Obj, open: unknown, end: string) => Obj | null;
  talkModel: (state: Obj, parse: (text: string) => unknown) => Obj;
  refsOf: (list: unknown) => Obj[];
};

test("web components: splitLinks は太字の中の URL を分け、空の文字の項を作らない", () => {
  assert.deepEqual(talk.splitLinks("URL なし"), [{ type: "text", text: "URL なし" }]);
  assert.deepEqual(talk.splitLinks("https://a.example/x 後"), [
    { type: "link", text: "https://a.example/x" },
    { type: "text", text: " 後" },
  ]);
  assert.deepEqual(talk.splitLinks("前 http://a.example/y"), [
    { type: "text", text: "前 " },
    { type: "link", text: "http://a.example/y" },
  ]);
  assert.deepEqual(talk.splitLinks("https://a.example/1 と https://a.example/2"), [
    { type: "link", text: "https://a.example/1" },
    { type: "text", text: " と " },
    { type: "link", text: "https://a.example/2" },
  ]);
  assert.deepEqual(talk.splitLinks("https://a.example/1https://b"), [{ type: "link", text: "https://a.example/1https://b" }]);
  assert.deepEqual(talk.splitLinks(""), []);
});

/** 見本と同じ形の fmt（行に持たせた欄を返すだけ）。呼ばれた名前と引数を calls に積む */
function talkFmt(): { calls: unknown[][]; fmt: Record<string, (...a: unknown[]) => unknown> } {
  const calls: unknown[][] = [];
  const rec = (name: string, fn: (...a: unknown[]) => unknown) => (...a: unknown[]): unknown => {
    calls.push([name, ...a]);
    return fn(...a);
  };
  const f = (turn: unknown): Obj => turn as Obj;
  return {
    calls,
    fmt: {
      time: rec("time", (t) => f(t).time ?? ""),
      label: rec("label", (t) => (f(t).kind === "owner" ? "オーナー" : (f(t).name ?? "エージェント"))),
      name: rec("name", (t, prev) => (f(t).name && !(prev && f(prev).name === f(t).name) ? f(t).name : null)),
      end: rec("end", (t) => f(t).end ?? ""),
      progress: rec("progress", (r) => f(r).text),
      waiting: rec("waiting", (r) => f(r).waiting ?? null),
      allLabel: rec("allLabel", (r) => "すべての手順（" + (f(r).steps as unknown[]).length + "）"),
      runName: rec("runName", () => null),
    },
  };
}

const talkState = (o: Obj = {}): Obj => ({
  channelId: "c",
  turns: [],
  hasMore: false,
  running: null,
  stopping: false,
  openSteps: new Set(),
  runStepsOpen: false,
  fmt: talkFmt().fmt,
  on: {},
  ...o,
});

const talkRec = (): { calls: unknown[][]; on: Record<string, (...a: unknown[]) => void> } => {
  const calls: unknown[][] = [];
  const rec = (name: string) => (...a: unknown[]): void => void calls.push([name, ...a]);
  return { calls, on: { older: rec("older"), toggleSteps: rec("toggleSteps"), toggleRunSteps: rec("toggleRunSteps"), stop: rec("stop"), continue: rec("continue") } };
};

test("web components: footOf の結果ごとの文・色・手順（完了で手順 0 は無し、手順 0 は押せない文）", () => {
  const steps = ["Read a", "Bash b"];
  const foot = (outcome: unknown, st: unknown, open = true): Obj | null => talk.footOf({ outcome, steps: st }, open, "文");
  assert.equal(foot(undefined, steps), null);
  assert.equal(foot(null, steps), null);
  assert.equal(foot("done", []), null);
  assert.deepEqual(foot("done", steps), { text: "文", tone: "muted", steps, open: true });
  assert.deepEqual(foot("done", steps, false), { text: "文", tone: "muted", steps, open: false });
  assert.deepEqual(foot("max_turns", []), { text: "文", tone: "warning", steps: null, open: false });
  assert.deepEqual(foot("max_turns", steps), { text: "文", tone: "warning", steps, open: true });
  assert.deepEqual(foot("failed", []), { text: "文", tone: "danger", steps: null, open: false });
  assert.deepEqual(foot("failed", steps), { text: "文", tone: "danger", steps, open: true });
  assert.deepEqual(foot("aborted", []), { text: "文", tone: "muted", steps: null, open: false });
  assert.deepEqual(foot("aborted", steps), { text: "文", tone: "muted", steps, open: true });
  assert.deepEqual(foot("x", steps), { text: "文", tone: "muted", steps, open: true });
  // 手順が配列でなければ 0 件と同じ
  assert.equal(foot("done", "Read a"), null);
  assert.deepEqual(foot("failed", { length: 2 }), { text: "文", tone: "danger", steps: null, open: false });
});

test("web components: talkModel の 4 つの kind（知らない kind は agent の吹き出し、文字列でない text は空）", () => {
  const parse = (text: string): unknown => [{ type: "paragraph", text: "P:" + text }];
  const turns = [
    { id: 1, kind: "divider", text: "区切り" },
    { id: 2, kind: "notice", text: "知らせ", time: "12:30" },
    { id: 3, kind: "owner", text: "**そのまま**", time: "12:31" },
    { id: 4, kind: "agent", text: "返事", time: "12:32", name: "A" },
    { id: 5, kind: "x", text: 7, time: "12:33" },
    { id: 6, kind: "divider", text: null },
  ];
  const m = talk.talkModel(talkState({ turns }), parse);
  assert.deepEqual(m.items, [
    { kind: "divider", key: "1", text: "区切り" },
    { kind: "notice", key: "2", text: "知らせ", time: "12:30" },
    { kind: "bubble", key: "3", who: "owner", label: "オーナー", name: null, blocks: [{ type: "plain", text: "**そのまま**" }], time: "12:31", state: null, foot: null },
    { kind: "bubble", key: "4", who: "agent", label: "A", name: "A", blocks: [{ type: "paragraph", text: "P:返事" }], time: "12:32", state: null, foot: null },
    { kind: "bubble", key: "5", who: "agent", label: "エージェント", name: null, blocks: [{ type: "paragraph", text: "P:" }], time: "12:33", state: null, foot: null },
    { kind: "divider", key: "6", text: "" },
  ]);
  assert.deepEqual([m.older, m.running], [false, null]);
  // turns が配列でなければ空
  assert.deepEqual(talk.talkModel(talkState({ turns: null }), parse).items, []);
});

test("web components: talkModel は name に 1 つ前の行を渡し、先頭は null", () => {
  const { calls, fmt } = talkFmt();
  const turns = [
    { id: "a", kind: "agent", text: "1", name: "Claude Code" },
    { id: "b", kind: "agent", text: "2", name: "Claude Code" },
    { id: "c", kind: "owner", text: "3" },
    { id: "d", kind: "agent", text: "4", name: "Claude Code" },
  ];
  const m = talk.talkModel(talkState({ turns, fmt }), talk.parseBlocks);
  assert.deepEqual(calls.filter((c) => c[0] === "name"), [
    ["name", turns[0], null],
    ["name", turns[1], turns[0]],
    ["name", turns[3], turns[2]],
  ]);
  assert.deepEqual((m.items as Obj[]).map((i) => i.name), ["Claude Code", null, null, "Claude Code"]);
});

test("web components: talkModel の送っている途中・older、parse は agent にだけ、fmt.end は outcome の在る行にだけ", () => {
  const { calls, fmt } = talkFmt();
  const parsed: string[] = [];
  const parse = (text: string): unknown => {
    parsed.push(text);
    return talk.parseBlocks(text);
  };
  const turns = [
    { id: 1, kind: "owner", text: "送る", optimistic: true },
    { id: 2, kind: "owner", text: "送った", optimistic: "yes" },
    { id: 3, kind: "agent", text: "古い返事" },
    { id: 4, kind: "agent", text: "完了", outcome: "done", steps: ["Read a"], end: "完了（1 秒）" },
    { id: 5, kind: "agent", text: "失敗", outcome: "failed", steps: [], end: "止まりました" },
  ];
  const m = talk.talkModel(talkState({ turns, fmt, hasMore: true, openSteps: new Set(["4"]) }), parse);
  const items = m.items as Obj[];
  assert.deepEqual(items.map((i) => i.state), ["sending", null, null, null, null]);
  assert.equal(m.older, true);
  assert.equal(talk.talkModel(talkState({ hasMore: "true" }), parse).older, false);
  assert.deepEqual(parsed, ["古い返事", "完了", "失敗"]);
  assert.deepEqual(calls.filter((c) => c[0] === "end").map((c) => (c[1] as Obj).id), [4, 5]);
  assert.deepEqual(items.map((i) => i.foot), [
    null,
    null,
    null,
    { text: "完了（1 秒）", tone: "muted", steps: ["Read a"], open: true },
    { text: "止まりました", tone: "danger", steps: null, open: false },
  ]);
});

test("web components: talkModel の running（後ろ 3 つ・0 件の文・4 件から all・stop は abortable のときだけ・runName に最後の行）", () => {
  const { calls, fmt } = talkFmt();
  const turns = [
    { id: 1, kind: "owner", text: "a" },
    { id: 2, kind: "agent", text: "b" },
  ];
  const run = (steps: unknown, o: Obj = {}): Obj => ({ steps, abortable: true, text: "作業中…", waiting: null, ...o });
  const m = talk.talkModel(talkState({ turns, fmt, running: run(["s1", "s2", "s3", "s4"]), stopping: true, runStepsOpen: true }), talk.parseBlocks);
  assert.deepEqual(m.running, {
    name: null,
    text: "作業中…",
    waiting: null,
    recent: [
      { text: "s2", current: false },
      { text: "s3", current: false },
      { text: "s4", current: true },
    ],
    all: { label: "すべての手順（4）", open: true, steps: ["s1", "s2", "s3", "s4"] },
    stop: { busy: true },
  });
  assert.deepEqual(calls.filter((c) => c[0] === "runName"), [["runName", turns[1]]]);
  // 3 件は all なし。stopping でなければ busy は false
  const three = talk.talkModel(talkState({ running: run(["s1", "s2", "s3"], { waiting: "許可を待っています" }) }), talk.parseBlocks).running as Obj;
  assert.deepEqual([three.all, three.stop, three.waiting, (three.recent as Obj[]).map((r) => r.current)], [null, { busy: false }, "許可を待っています", [false, false, true]]);
  // 0 件・配列でない・abortable でない
  for (const steps of [[], undefined, "s"]) {
    const r = talk.talkModel(talkState({ running: run(steps, { abortable: false }) }), talk.parseBlocks).running as Obj;
    assert.deepEqual([r.recent, r.all, r.stop], [[{ text: "まだ手順はありません", current: false }], null, null], String(steps));
  }
  // 行が無ければ runName に null
  const { calls: c2, fmt: f2 } = talkFmt();
  talk.talkModel(talkState({ fmt: f2, running: run([]) }), talk.parseBlocks);
  assert.deepEqual(c2.filter((c) => c[0] === "runName"), [["runName", null]]);
});

test("web components: 開いている手順は key（数値の id を文字列にした物）の Set で引く。toggleSteps が受けた key を入れて描き直すと開く", () => {
  const { calls, on } = talkRec();
  const turns = [{ id: 4, kind: "agent", text: "直しました。", outcome: "done", steps: ["Read a", "Bash b"], end: "完了" }];
  const closed = one(html`<${talk.TalkTimeline} model=${talk.talkModel(talkState({ turns }), talk.parseBlocks)} on=${on} />`);
  const toggle = find(closed, "c-steps-toggle")[0] as El;
  assert.equal(toggle.props["aria-expanded"], "false");
  (toggle.props.onClick as (e: unknown) => void)(fakeEvent());
  assert.deepEqual(calls, [["toggleSteps", "4"]]);
  const opened = one(html`<${talk.TalkTimeline} model=${talk.talkModel(talkState({ turns, openSteps: new Set([calls[0]?.[1]]) }), talk.parseBlocks)} on=${on} />`);
  assert.equal((find(opened, "c-steps-toggle")[0] as El).props["aria-expanded"], "true");
  assert.equal(find(opened, "c-steps-list").length, 1);
  // 元の型（数値）の Set では開かない
  const raw = one(html`<${talk.TalkTimeline} model=${talk.talkModel(talkState({ turns, openSteps: new Set([4]) }), talk.parseBlocks)} on=${on} />`);
  assert.equal((find(raw, "c-steps-toggle")[0] as El).props["aria-expanded"], "false");
});

test("web components: Blocks（段落・見出し・code・箇条書き・番号の start・入れ子・plain・知らない type）", () => {
  const md = one(html`<${talk.Blocks} blocks=${talk.parseBlocks("前 **太**\n\n# 見出し\n\n```\n**a** <b>\n```\n\n- a\n  - a1\n- b\n\n3. x\n4. y")} />`);
  assert.deepEqual([md.type, md.props.class], ["div", "c-md"]);
  const kids = md.children as El[];
  assert.deepEqual(kids.map((k) => [k.type, k.props.class]), [
    ["p", "c-md-p"],
    ["p", "c-md-h"],
    ["pre", "c-md-pre"],
    ["ul", "c-md-list"],
    ["ol", "c-md-list"],
  ]);
  assert.deepEqual(kids.map(textOf), ["前 太", "見出し", "**a** <b>", "aa1b", "xy"]);
  // コードの段は文字だけ（中に code のタグを作らない）
  assert.deepEqual(kids[2]?.children, ["**a** <b>"]);
  // 箇条書きの start は番号付きだけ。入れ子
  assert.equal("start" in (kids[3] as El).props, false);
  assert.equal(kids[4]?.props.start, 3);
  const first = (kids[3] as El).children[0] as El;
  assert.equal(first.type, "li");
  const nested = find(first, "c-md-list")[0] as El;
  assert.deepEqual([nested.type, nested.children.map(textOf)], ["ul", ["a1"]]);
  assert.equal(one(html`<${talk.Blocks} blocks=${talk.parseBlocks("1. a")} />`).children.map((k) => (k as El).props.start)[0], 1);
  // plain は解析しない（** がそのまま）
  const plain = one(html`<${talk.Blocks} blocks=${[{ type: "plain", text: "**そのまま** https://a.example" }]} />`).children[0] as El;
  assert.deepEqual([plain.type, plain.props.class, plain.props["data-plain"], plain.children], ["p", "c-md-p", "true", ["**そのまま** https://a.example"]]);
  // 知らない type は段落として text（文字列でなければ空）
  const unknown = one(html`<${talk.Blocks} blocks=${[{ type: "table", text: "| a |" }, { type: "quote", text: 3 }]} />`).children as El[];
  assert.deepEqual(unknown.map((k) => [k.type, k.props.class, textOf(k)]), [["p", "c-md-p", "| a |"], ["p", "c-md-p", ""]]);
});

test("web components: 危ない入力を Blocks に通しても、リンクは http(s) だけで、決まったタグと属性しか出ず、HTML は文字のまま", () => {
  const inputs = [
    "[x](javascript:alert(1))",
    "[x](data:text/html,<b>x</b>)",
    "javascript:alert(1)",
    "<script>alert(1)</script>",
    "<img src=x onerror=alert(1)>",
    "HTTPS://EXAMPLE.COM/a",
    "//evil.example/a",
    "[x](file:///etc/passwd)",
  ];
  // 今の実装が出すタグ（Blocks と Inline）
  const TAGS = new Set(["div", "p", "pre", "ul", "ol", "li", "strong", "code", "a"]);
  const all = (t: Tree): El[] => (typeof t === "string" ? [] : [t, ...t.children.flatMap(all)]);
  let links = 0;
  for (const text of inputs) {
    // 後ろに http(s) の URL を足した形も通す（a の検査が空振りしない）
    const variants = [talk.parseBlocks(text), [{ type: "plain", text }], talk.parseBlocks("**" + text + "**"), talk.parseBlocks("- " + text), talk.parseBlocks(text + " https://a.example/ok")];
    for (const blocks of variants) {
      const tree = one(html`<${talk.Blocks} blocks=${blocks} />`);
      const els = all(tree);
      for (const el of els) {
        assert.ok(TAGS.has(el.type), `${text}: タグ ${el.type}`);
        for (const prop of Object.keys(el.props)) {
          assert.ok(!/^on/i.test(prop) && !["style", "src", "dangerouslySetInnerHTML"].includes(prop), `${text}: ${el.type} の ${prop}`);
        }
        if (el.type === "a") {
          links++;
          assert.match(String(el.props.href), /^https?:\/\//i, text);
          assert.equal(el.props.target, "_blank", text);
          const rel = String(el.props.rel).split(/\s+/);
          assert.ok(rel.includes("noreferrer") && rel.includes("noopener"), `${text}: rel ${el.props.rel}`);
        }
      }
      // HTML は文字のまま出る
      if (text.includes("<")) assert.ok(textOf(tree).includes(text), `${text}: ${textOf(tree)}`);
    }
  }
  assert.ok(links >= inputs.length, `a の数 ${links}`);
});

test("web components: Inline（リンクの href・target・rel、太字の中のリンク、code）", () => {
  const tree = expand(html`<${talk.Inline} text=${"見て https://a.example/x と **太 https://b.example/y** と `c`"} />`);
  const links = tree.flatMap((t) => find(t, "c-md-link"));
  assert.deepEqual(links.map((a) => [a.type, a.props.href, a.props.target, a.props.rel, textOf(a)]), [
    ["a", "https://a.example/x", "_blank", "noreferrer noopener", "https://a.example/x"],
    ["a", "https://b.example/y", "_blank", "noreferrer noopener", "https://b.example/y"],
  ]);
  const strong = tree.find((t) => typeof t !== "string" && t.type === "strong") as El;
  assert.equal(textOf(strong), "太 https://b.example/y");
  assert.equal(find(strong, "c-md-link").length, 1);
  const code = tree.flatMap((t) => find(t, "c-md-code"));
  assert.deepEqual(code.map((c) => [c.type, textOf(c)]), [["code", "c"]]);
  assert.equal(textOf(tree), "見て https://a.example/x と 太 https://b.example/y と c");
});

test("web components: talkModel: fmt.notice は知らせ（notice）の行の本文だけを差し替える。関数でない・文字列でない物を返せば元の本文（#457 の L2）", () => {
  const parse = (text: string): unknown => [{ type: "paragraph", text: "P:" + text }];
  const base = talkFmt().fmt;
  const asked: unknown[] = [];
  const turns = [
    { id: 1, kind: "notice", text: "終わりました: <#1>" },
    { id: 2, kind: "agent", text: "返事" },
    { id: 3, kind: "divider", text: "区切り" },
  ];
  const notice = (text: unknown) => {
    asked.push(text);
    return "N:" + String(text);
  };
  const items = talk.talkModel(talkState({ turns, fmt: { ...base, notice } }), parse).items as Obj[];
  assert.deepEqual(asked, ["終わりました: <#1>"]);
  assert.equal(items[0]!.text, "N:終わりました: <#1>");
  assert.deepEqual(items[1]!.blocks, [{ type: "paragraph", text: "P:返事" }]);
  assert.equal(items[2]!.text, "区切り");
  for (const odd of [null, "x", () => 7]) {
    const kept = talk.talkModel(talkState({ turns: [turns[0]], fmt: { ...base, notice: odd } }), parse).items as Obj[];
    assert.equal(kept[0]!.text, "終わりました: <#1>");
  }
});

test("web components: 右腕の枠（shell.js の HAND_FRAME）だけが noticeText に handNoticeText を持ち、chat.js の部品の道が fmt.notice に渡す。.c-notice は改行をそのまま出す（#457 の L2）", () => {
  const shell = stripJsComments(read("shell.js"));
  const hand = /const HAND_FRAME = \{[^\n]*\};/.exec(shell)?.[0];
  assert.ok(hand, "shell.js から HAND_FRAME の 1 行を抜き出せない（書き方が変わった）");
  assert.ok(hand.includes("noticeText: handNoticeText"));
  // 話題の会話の枠には足さない（noticeText は HAND_FRAME の 1 か所だけ）
  assert.equal((shell.match(/noticeText/g) ?? []).length, 1);
  assert.match(read("chat.js"), /notice: frame && frame\.noticeText \? frame\.noticeText : null,/);
  const rule = parseCss(read("c-talk.css")).find((r) => r.at.length === 0 && r.selectors.length === 1 && r.selectors[0] === ".c-notice");
  assert.ok(rule);
  assert.match(rule.body, /(?:^|;)\s*white-space\s*:\s*pre-line/);
});

test("web components: talkModel: fmt.reply は Bot の返事の本文だけを差し替え、fmt.refs の札は返事のすぐ後ろの行（kind refs）。関数でない・空・id か題の無い物では行を足さない。reply が文字列でない物を返せば元の本文、同じ id の札は 1 つ", () => {
  const parse = (text: string): unknown => [{ type: "paragraph", text: "P:" + text }];
  const base = talkFmt().fmt;
  const replied: unknown[] = [];
  const refsAsked: unknown[] = [];
  const fmt = {
    ...base,
    reply: (text: unknown) => {
      replied.push(text);
      return "R:" + String(text);
    },
    refs: (text: unknown) => {
      refsAsked.push(text);
      if (text === "札 2") return [{ id: "t1", title: "話題 1", meta: "3 分" }, { id: "t2", title: "話題 2" }];
      if (text === "札 壊れ") return [{ id: "", title: "空" }, { id: "t3", title: "" }, { id: 4, title: "数" }, null, "x"];
      if (text === "札 並びでない") return { id: "t1", title: "話題 1" };
      return [];
    },
  };
  const turns = [
    { id: 1, kind: "divider", text: "区切り" },
    { id: 2, kind: "notice", text: "知らせ" },
    { id: 3, kind: "owner", text: "札 2" },
    { id: 4, kind: "agent", text: "札 2" },
    { id: 5, kind: "agent", text: "札 壊れ" },
    { id: 6, kind: "agent", text: "札 並びでない" },
    { id: 7, kind: "agent", text: "札なし" },
  ];
  const m = talk.talkModel(talkState({ turns, fmt }), parse);
  const items = m.items as Obj[];
  assert.deepEqual(items.map((i) => i.key), ["1", "2", "3", "4", "4:refs", "5", "6", "7"]);
  assert.deepEqual(items[4], { kind: "refs", key: "4:refs", refs: [{ id: "t1", title: "話題 1", meta: "3 分" }, { id: "t2", title: "話題 2", meta: "" }] });
  // 差し替えは返事の本文だけ。札に渡すのは差し替える前の本文
  assert.deepEqual(replied, ["札 2", "札 壊れ", "札 並びでない", "札なし"]);
  assert.deepEqual(refsAsked, ["札 2", "札 壊れ", "札 並びでない", "札なし"]);
  assert.deepEqual(items[3]!.blocks, [{ type: "paragraph", text: "P:R:札 2" }]);
  assert.deepEqual(items[2]!.blocks, [{ type: "plain", text: "札 2" }]);
  assert.deepEqual([items[0]!.text, items[1]!.text], ["区切り", "知らせ"]);
  // reply が文字列でない物を返せば元の本文のまま（空の文字列は空のまま）。reply・refs が関数でなければ今までどおり
  const odd = talk.talkModel(talkState({ turns: [{ id: 1, kind: "agent", text: "a" }], fmt: { ...base, reply: () => 7, refs: "x" } }), parse);
  assert.deepEqual((odd.items as Obj[]).map((i) => [i.key, i.blocks]), [["1", [{ type: "paragraph", text: "P:a" }]]]);
  const blank = talk.talkModel(talkState({ turns: [{ id: 1, kind: "agent", text: "a" }], fmt: { ...base, reply: () => "" } }), parse);
  assert.deepEqual((blank.items as Obj[]).map((i) => [i.key, i.blocks]), [["1", [{ type: "paragraph", text: "P:" }]]]);
  const plain = talk.talkModel(talkState({ turns: [{ id: 1, kind: "agent", text: "a" }], fmt: { ...base, reply: null, refs: null } }), parse);
  assert.deepEqual((plain.items as Obj[]).map((i) => [i.key, i.blocks]), [["1", [{ type: "paragraph", text: "P:a" }]]]);
  // refsOf
  assert.deepEqual(talk.refsOf(null), []);
  assert.deepEqual(talk.refsOf([{ id: "a", title: "A", meta: 3 }, { id: "b", title: "B", meta: "m" }]), [{ id: "a", title: "A", meta: "" }, { id: "b", title: "B", meta: "m" }]);
  // 同じ id は先の 1 つだけ（札の key が重ならない）
  assert.deepEqual(talk.refsOf([{ id: "a", title: "A" }, { id: "a", title: "A2" }, { id: "b", title: "B" }]), [{ id: "a", title: "A", meta: "" }, { id: "b", title: "B", meta: "" }]);
});

test("web components: Refs と HandHead は Node で呼べる: 札は role も名前も持たず（題を 2 回読ませない）・meta が空なら span を作らない・［開く］の名前は「<題> を開く」で onOpen(id)（TalkRows の札の行は on.ref(id)。無ければ何もしない）。見出しは h2 と data-act（menu は menu のときだけ）・［畳む］の名前は「<題>を畳む」で on.close()", async () => {
  // press は後ろ（カードの節）で宣言されるので、ここでは自前で押す
  const tap = (b: El | undefined): void => (b?.props.onClick as (e: unknown) => void)(fakeEvent());
  const opened: unknown[] = [];
  const root = one(html`<${talk.Refs} refs=${[{ id: "t1", title: "話題 1", meta: "3 分" }, { id: "t2", title: "話題 2", meta: "" }]} onOpen=${(id: unknown) => opened.push(id)} />`);
  assert.deepEqual([root.type, root.props.class], ["div", "c-refs"]);
  const refs = root.children as El[];
  assert.deepEqual(refs.map((r) => [r.type, r.props.class, r.props.role, r.props["aria-label"]]), [["div", "c-ref", undefined, undefined], ["div", "c-ref", undefined, undefined]]);
  assert.deepEqual(refs.map((r) => r.children.map((c) => (c as El).props.class)), [["c-ref-title", "c-ref-meta", "c-btn"], ["c-ref-title", "c-btn"]]);
  assert.deepEqual([textOf(find(refs[0]!, "c-ref-title")), textOf(find(refs[0]!, "c-ref-meta"))], ["話題 1", "3 分"]);
  const buttons = find(root, "c-btn");
  assert.deepEqual(buttons.map((b) => [b.props["data-kind"], b.props["data-size"], textOf(b), b.props["aria-label"]]), [["ghost", "sm", "開く", "話題 1 を開く"], ["ghost", "sm", "開く", "話題 2 を開く"]]);
  tap(buttons[1]);
  tap(buttons[0]);
  assert.deepEqual(opened, ["t2", "t1"]);
  const v = talk.Refs({ refs: [{ id: "a", title: "A", meta: "" }, { id: "b", title: "B", meta: "" }], onOpen: () => undefined }) as VNode;
  assert.deepEqual(keysOf(v.props.children), ["a", "b"]);
  // TalkRows の札の行
  const items = [{ kind: "refs", key: "4:refs", refs: [{ id: "t9", title: "話題 9", meta: "" }] }];
  assert.deepEqual(keysOf(talk.TalkRows({ older: false, items, on: {} })), ["4:refs"]);
  const got: unknown[] = [];
  tap(find(expand(talk.TalkRows({ older: false, items, on: { ref: (id: unknown) => got.push(id) } })), "c-btn")[0]);
  assert.deepEqual(got, ["t9"]);
  tap(find(expand(talk.TalkRows({ older: false, items, on: {} })), "c-btn")[0]);
  // 右腕の見出し（c-hand.js）
  const hand = (await import(new URL("../src/web/static/c-hand.js", import.meta.url).href)) as Record<string, Fn>;
  const handCalls: unknown[][] = [];
  const handOn = { menu: (opener: unknown) => void handCalls.push(["menu", opener]), close: (...a: unknown[]) => void handCalls.push(["close", ...a]) };
  const head = one(html`<${hand.HandHead} title="右腕" menu=${true} on=${handOn} />`);
  assert.deepEqual([head.type, head.props.class], ["header", "c-hand-head"]);
  assert.deepEqual(head.children.map((c) => [(c as El).type, (c as El).props.class, (c as El).props["data-act"]]), [["h2", "c-hand-title", undefined], ["span", "c-hand-act", "menu"], ["span", "c-hand-act", "close"]]);
  assert.equal(textOf(find(head, "c-hand-title")), "右腕");
  const menuBtn = find(head, "c-iconbtn")[0] as El;
  assert.equal(menuBtn.props["aria-label"], "ほかの操作");
  const ev = fakeEvent();
  (menuBtn.props.onClick as (e: unknown) => void)(ev);
  const close = find(head, "c-btn")[0] as El;
  assert.deepEqual([close.props["data-kind"], close.props["data-size"], textOf(close), close.props["aria-label"]], ["ghost", "sm", "畳む", "右腕を畳む"]);
  tap(close);
  assert.deepEqual(handCalls, [["menu", ev.currentTarget], ["close"]]);
  const v2 = hand.HandHead({ title: "右腕", menu: true, on: handOn }) as VNode;
  assert.deepEqual(keysOf(v2.props.children), ["title", "menu", "close"]);
  for (const menu of [false, undefined]) {
    const bare = one(html`<${hand.HandHead} title="右腕" menu=${menu} on=${handOn} />`);
    assert.deepEqual(bare.children.map((c) => (c as El).props["data-act"]), [undefined, "close"]);
    assert.equal(find(bare, "c-iconbtn").length, 0);
  }
});

const bubbleOf = (o: Obj = {}): Obj => ({
  who: "agent",
  label: "エージェント",
  name: null,
  blocks: [{ type: "paragraph", text: "返事" }],
  time: "12:30",
  state: null,
  foot: null,
  onToggle: () => undefined,
  ...o,
});

test("web components: Bubble は owner・agent の data-who と aria-label を持ち、吹き出しの中に結果の文を入れない", () => {
  const owner = one(html`<${talk.Bubble} ...${bubbleOf({ who: "owner", label: "オーナー", blocks: [{ type: "plain", text: "**a**" }] })} />`);
  assert.deepEqual([owner.type, owner.props.class, owner.props["data-who"], owner.props["aria-label"]], ["article", "c-msg", "owner", "オーナー"]);
  assert.equal(textOf(find(owner, "c-bubble")), "**a**");
  const foot = { text: "完了（1 分）", tone: "muted", steps: ["Read a"], open: false };
  const agent = one(html`<${talk.Bubble} ...${bubbleOf({ foot })} />`);
  assert.deepEqual([agent.props["data-who"], agent.props["aria-label"]], ["agent", "エージェント"]);
  assert.equal(textOf(find(agent, "c-bubble")), "返事");
  assert.ok(!textOf(find(agent, "c-bubble")).includes("完了"));
  assert.ok(textOf(find(agent, "c-msg-foot")).includes("完了（1 分）"));
});

test("web components: Bubble の foot なし・送っている途中・名前の有り無し", () => {
  const plain = one(html`<${talk.Bubble} ...${bubbleOf()} />`);
  const foot = find(plain, "c-msg-foot")[0] as El;
  assert.deepEqual(foot.children.map((c) => (c as El).props.class), ["c-msg-time"]);
  assert.equal(textOf(foot), "12:30");
  assert.equal(plain.props["data-state"], undefined);
  assert.equal(find(plain, "c-msg-name").length, 0);
  const sending = one(html`<${talk.Bubble} ...${bubbleOf({ who: "owner", state: "sending" })} />`);
  assert.equal(sending.props["data-state"], "sending");
  assert.equal(textOf(find(sending, "c-msg-time")), "送っています…");
  const named = one(html`<${talk.Bubble} ...${bubbleOf({ name: "Claude Code" })} />`);
  const name = find(named, "c-msg-name")[0] as El;
  assert.deepEqual([name.type, textOf(name), named.children[0]], ["span", "Claude Code", name]);
});

test("web components: Steps は toggles で文かボタン。aria-expanded・アイコン・data-tone、押すと onToggle", () => {
  const text = one(html`<${talk.Steps} text="止まりました" tone="danger" toggles=${false} open=${false} onToggle=${() => undefined} />`);
  assert.deepEqual([text.type, text.props.class, text.props["data-tone"], textOf(text)], ["span", "c-steps-text", "danger", "止まりました"]);
  let n = 0;
  for (const open of [false, true]) {
    const btn = one(html`<${talk.Steps} text="完了" tone="warning" toggles=${true} open=${open} onToggle=${() => void n++} />`);
    assert.deepEqual([btn.type, btn.props.class, btn.props.type, btn.props["data-tone"], btn.props["aria-expanded"]], ["button", "c-steps-toggle", "button", "warning", open ? "true" : "false"]);
    assert.equal("aria-controls" in btn.props, false);
    const icon = find(btn, "c-icon")[0] as El;
    assert.deepEqual([icon.props["data-size"], String((icon.children[0] as El).props.href).endsWith(open ? "#chevron-down" : "#chevron-right")], ["sm", true]);
    assert.equal(textOf(find(btn, "c-steps-label")), "完了");
    (btn.props.onClick as (e: unknown) => void)(fakeEvent());
  }
  assert.equal(n, 2);
});

test("web components: Bubble は手順を開いているときだけ ol.c-steps-list（項目の数と文）", () => {
  const steps = ["Read src/app.ts", "Bash npm test"];
  const closed = one(html`<${talk.Bubble} ...${bubbleOf({ foot: { text: "完了", tone: "muted", steps, open: false } })} />`);
  assert.equal(find(closed, "c-steps-list").length, 0);
  assert.equal(find(closed, "c-steps-toggle").length, 1);
  const open = one(html`<${talk.Bubble} ...${bubbleOf({ foot: { text: "完了", tone: "muted", steps, open: true } })} />`);
  const list = find(open, "c-steps-list")[0] as El;
  assert.equal(list.type, "ol");
  assert.deepEqual(list.children.map((li) => [(li as El).type, textOf(li)]), [["li", "Read src/app.ts"], ["li", "Bash npm test"]]);
  // 一覧は .c-msg の直下で、foot の後ろ
  assert.equal(open.children.at(-1), list);
  // 手順が null（押せない文）なら一覧は無い
  const none = one(html`<${talk.Bubble} ...${bubbleOf({ foot: { text: "止まりました", tone: "danger", steps: null, open: false } })} />`);
  assert.deepEqual([find(none, "c-steps-list").length, find(none, "c-steps-toggle").length, find(none, "c-steps-text").length], [0, 0, 1]);
});

test("web components: talkModel（continueKey の返事の行だけに act。busy は continueBusy。null・無い・オーナーや知らせの key のときはどの行にも act の欄が無い）", () => {
  const turns = [
    { id: 1, kind: "notice", text: "知らせ" },
    { id: 2, kind: "owner", text: "a" },
    { id: 3, kind: "agent", text: "b", outcome: "max_turns", steps: ["Read a"], end: "手順の上限で止まりました" },
    { id: 4, kind: "agent", text: "c", outcome: "max_turns", steps: ["Read a"], end: "手順の上限で止まりました" },
  ];
  const acts = (o: Obj): unknown[] => (talk.talkModel(talkState({ turns, ...o }), talk.parseBlocks).items as Obj[]).map((item) => (Object.hasOwn(item, "act") ? item.act : "-"));
  assert.deepEqual(acts({ continueKey: "4" }), ["-", "-", "-", { busy: false }]);
  assert.deepEqual(acts({ continueKey: "4", continueBusy: true }), ["-", "-", "-", { busy: true }]);
  assert.deepEqual(acts({ continueKey: "3", continueBusy: false }), ["-", "-", { busy: false }, "-"]);
  // busy は true のときだけ
  assert.deepEqual(acts({ continueKey: "4", continueBusy: "yes" }), ["-", "-", "-", { busy: false }]);
  for (const o of [{ continueKey: null }, {}, { continueKey: "2" }, { continueKey: "1" }, { continueKey: "9", continueBusy: true }, { continueKey: 4 }]) {
    assert.deepEqual(acts(o), ["-", "-", "-", "-"], JSON.stringify(o));
  }
});

test("web components: Bubble（act が在れば .c-msg の最後に .c-msg-act > ［続ける］。開いた手順の一覧より後ろ。busy は aria-busy で押しても呼ばない。act が無ければ .c-msg-act が無い）", () => {
  let n = 0;
  const steps = ["Read a", "Bash b"];
  const foot = (open: boolean): Obj => ({ text: "手順の上限で止まりました", tone: "warning", steps, open });
  const closed = one(html`<${talk.Bubble} ...${bubbleOf({ foot: foot(false), act: { busy: false }, onAct: () => void n++ })} />`);
  const act = find(closed, "c-msg-act")[0] as El;
  assert.deepEqual([act.type, closed.children.at(-1)], ["div", act]);
  const btn = find(act, "c-btn") as El[];
  assert.equal(btn.length, 1);
  assert.deepEqual([btn[0]!.type, btn[0]!.props["data-kind"], btn[0]!.props["data-size"], textOf(find(btn[0]!, "c-btn-label")), btn[0]!.props["aria-busy"]], ["button", "secondary", "sm", "続ける", undefined]);
  assert.ok(String((find(btn[0]!, "c-icon")[0]?.children[0] as El).props.href).endsWith("#play"));
  (btn[0]!.props.onClick as (e: unknown) => void)(fakeEvent());
  assert.equal(n, 1);
  // 開いた手順の一覧の後ろ
  const open = one(html`<${talk.Bubble} ...${bubbleOf({ foot: foot(true), act: { busy: false }, onAct: () => void n++ })} />`);
  const kids = (open.children as El[]).map((c) => c.props.class);
  assert.deepEqual(kids.slice(-3), ["c-msg-foot", "c-steps-list", "c-msg-act"]);
  // 待ちの形は aria-busy で、押しても呼ばない
  const busy = one(html`<${talk.Bubble} ...${bubbleOf({ foot: foot(false), act: { busy: true }, onAct: () => void n++ })} />`);
  const busyBtn = find(find(busy, "c-msg-act"), "c-btn")[0] as El;
  assert.deepEqual([busyBtn.props["aria-busy"], busyBtn.props["aria-disabled"], find(busyBtn, "c-btn-spin").length], ["true", "true", 1]);
  (busyBtn.props.onClick as (e: unknown) => void)(fakeEvent());
  assert.equal(n, 1);
  // act が無ければ出さない
  for (const o of [{ foot: foot(true) }, { foot: foot(false) }, {}]) assert.equal(find(one(html`<${talk.Bubble} ...${bubbleOf(o)} />`), "c-msg-act").length, 0);
});

test("web components: TalkRows（［続ける］を押すと on.continue にその行の key）", () => {
  const { calls, on } = talkRec();
  const turns = [
    { id: 7, kind: "agent", text: "a", outcome: "done", steps: ["Read a"], end: "完了" },
    { id: 8, kind: "agent", text: "b", outcome: "max_turns", steps: ["Read a"], end: "手順の上限で止まりました" },
  ];
  const model = talk.talkModel(talkState({ turns, continueKey: "8" }), talk.parseBlocks);
  const root = one(html`<${talk.TalkTimeline} model=${model} on=${on} />`);
  const acts = find(root, "c-msg-act");
  assert.equal(acts.length, 1);
  (find(acts, "c-btn")[0]!.props.onClick as (e: unknown) => void)(fakeEvent());
  assert.deepEqual(calls, [["continue", "8"]]);
});

test("web components: RunLine（aria-busy・aria-live と role=status が無い・recent の data-current・waiting・all・［中断］の busy と on）", () => {
  const { calls, on } = talkRec();
  const runOf = (o: Obj = {}): Obj => ({
    name: null,
    text: "作業中…（12 秒）",
    waiting: null,
    recent: [
      { text: "s1", current: false },
      { text: "s2", current: true },
    ],
    all: null,
    stop: null,
    ...o,
  });
  const bare = one(html`<${talk.RunLine} run=${runOf()} on=${on} />`);
  assert.deepEqual([bare.type, bare.props.class, bare.props.role, bare.props["aria-label"], bare.props["aria-busy"]], ["div", "c-run", "group", "作業中", "true"]);
  const all = (t: Tree): El[] => (typeof t === "string" ? [] : [t, ...t.children.flatMap(all)]);
  for (const el of all(bare)) assert.ok(!("aria-live" in el.props) && el.props.role !== "status");
  assert.equal(textOf(find(bare, "c-run-text")), "作業中…（12 秒）");
  assert.equal((find(bare, "c-run-spin")[0] as El).props["aria-hidden"], "true");
  const lis = (find(bare, "c-run-recent")[0] as El).children as El[];
  assert.deepEqual(lis.map((li) => [li.type, li.props["data-current"], textOf(li)]), [["li", undefined, "s1"], ["li", "true", "s2"]]);
  assert.deepEqual([find(bare, "c-run-waiting").length, find(bare, "c-steps-toggle").length, find(bare, "c-run-actions").length, find(bare, "c-msg-name").length], [0, 0, 0, 0]);
  const full = one(html`<${talk.RunLine} run=${runOf({ name: "Claude Code", waiting: "許可を待っています", all: { label: "すべての手順（5）", open: true, steps: ["a", "b"] }, stop: { busy: true } })} on=${on} />`);
  assert.equal(textOf(find(full, "c-msg-name")), "Claude Code");
  assert.deepEqual([(find(full, "c-run-waiting")[0] as El).type, textOf(find(full, "c-run-waiting"))], ["p", "許可を待っています"]);
  const toggle = find(full, "c-steps-toggle")[0] as El;
  assert.deepEqual([toggle.props["data-tone"], toggle.props["aria-expanded"], textOf(find(toggle, "c-steps-label"))], ["muted", "true", "すべての手順（5）"]);
  assert.deepEqual(find(full, "c-steps-list").map((l) => l.children.map(textOf)), [["a", "b"]]);
  const stop = find(find(full, "c-run-actions"), "c-btn")[0] as El;
  assert.deepEqual([stop.props["aria-busy"], stop.props["aria-disabled"], textOf(find(stop, "c-btn-label"))], ["true", "true", "中断"]);
  (toggle.props.onClick as (e: unknown) => void)(fakeEvent());
  // busy の間は押しても呼ばない
  (stop.props.onClick as (e: unknown) => void)(fakeEvent());
  const idle = one(html`<${talk.RunLine} run=${runOf({ all: { label: "x", open: false, steps: ["a"] }, stop: { busy: false } })} on=${on} />`);
  assert.equal(find(idle, "c-steps-list").length, 0);
  const idleStop = find(idle, "c-btn")[0] as El;
  assert.equal(idleStop.props["aria-busy"], undefined);
  assert.ok(String((find(idleStop, "c-icon")[0]?.children[0] as El).props.href).endsWith("#square"));
  (idleStop.props.onClick as (e: unknown) => void)(fakeEvent());
  assert.deepEqual(calls, [["toggleRunSteps"], ["stop"]]);
});

test("web components: Notice（時刻の有り無し）・Divider（role=separator・子は文字だけ）", () => {
  const n = one(html`<${talk.Notice} text="開きました" time="12:30" />`);
  assert.deepEqual([n.type, n.props.class, n.children[0]], ["div", "c-notice", "開きました"]);
  assert.deepEqual(find(n, "c-notice-time").map((t) => [t.type, textOf(t)]), [["span", "12:30"]]);
  for (const time of ["", undefined]) assert.deepEqual(one(html`<${talk.Notice} text="開きました" time=${time} />`).children, ["開きました"]);
  const d = one(html`<${talk.Divider} text="ここから" />`);
  assert.deepEqual([d.type, d.props.class, d.props.role, d.children], ["div", "c-divider", "separator", ["ここから"]]);
});

test("web components: TalkTimeline の根・older のボタン・items の順と key・toggleSteps(key)・running の有り無し", () => {
  const { calls, on } = talkRec();
  const turns = [
    { id: 1, kind: "divider", text: "区切り" },
    { id: 2, kind: "notice", text: "知らせ" },
    { id: 3, kind: "owner", text: "a" },
    { id: 4, kind: "agent", text: "b", outcome: "done", steps: ["Read a"], end: "完了" },
  ];
  const model = talk.talkModel(talkState({ turns, hasMore: true, running: { steps: [], abortable: false, text: "作業中…" } }), talk.parseBlocks);
  const v = talk.TalkTimeline({ model, on }) as VNode;
  assert.deepEqual(keysOf(v.props.children), ["rows", "run"]);
  assert.deepEqual(keysOf(talk.TalkRows({ older: model.older, items: model.items, on })), ["older", "1", "2", "3", "4"]);
  const root = one(v);
  assert.deepEqual([root.type, root.props.class], ["div", "c-talk"]);
  assert.deepEqual((root.children as El[]).map((c) => c.props.class), ["c-talk-older", "c-divider", "c-notice", "c-msg", "c-msg", "c-run"]);
  const older = find(root, "c-btn")[0] as El;
  assert.deepEqual([older.props["data-kind"], older.props["data-size"], textOf(older), find(older, "c-icon").length], ["ghost", "sm", "前の会話を読む", 0]);
  (older.props.onClick as (e: unknown) => void)(fakeEvent());
  (find(root, "c-steps-toggle")[0]?.props.onClick as (e: unknown) => void)(fakeEvent());
  assert.deepEqual(calls, [["older"], ["toggleSteps", "4"]]);
  // older・running が無ければ出さない
  const bare = one(html`<${talk.TalkTimeline} model=${talk.talkModel(talkState({ turns }), talk.parseBlocks)} on=${on} />`);
  assert.deepEqual([find(bare, "c-talk-older").length, find(bare, "c-run").length], [0, 0]);
  assert.deepEqual(expand(html`<${talk.TalkTimeline} model=${{ older: false, items: [], running: null }} on=${on} />`).map((t) => (t as El).children.length), [0]);
});

test("web components: 会話の根（.c-talk）は自分の字と色を持つ（置かれた先からの継承を当てにしない）", () => {
  const own = parseCss(read("c-talk.css")).filter((r) => r.at.length === 0 && r.selectors.length === 1 && r.selectors[0] === ".c-talk");
  assert.ok(own.length > 0);
  for (const decl of ["font-size: var(--c-font-body)", "line-height: var(--leading-normal)", "color: var(--text)"]) {
    assert.ok(own.some((r) => r.body.split(";").map((d) => d.trim()).includes(decl)), decl);
  }
});

test("web components: TalkTimeline に rows を渡すと、直下の 1 つ目はその物そのもので model.items を見ない", () => {
  const { on } = talkRec();
  const rows = html`<${talk.TalkRows} key="rows" older=${false} items=${[{ kind: "divider", key: "9", text: "渡した行" }]} on=${on} />`;
  const v = talk.TalkTimeline({ model: { older: true, items: [], running: null }, on, rows }) as VNode;
  const children = (v.props.children as unknown[]).flat(Infinity).filter((c) => c && typeof c === "object");
  assert.equal(children[0], rows);
  const root = one(v);
  assert.deepEqual((root.children as El[]).map((c) => c.props.class), ["c-divider"]);
  assert.equal(textOf(root), "渡した行");
});

test("web components: rows を渡さない TalkTimeline の展開した DOM は、行を直に並べた形と同じ", () => {
  const { on } = talkRec();
  const turns = [
    { id: 1, kind: "divider", text: "区切り" },
    { id: 2, kind: "notice", text: "知らせ", time: "12:00" },
    { id: 3, kind: "owner", text: "a", time: "12:01" },
    { id: 4, kind: "agent", text: "**b** `c` https://a.example/x", outcome: "max_turns", steps: ["Read a"], end: "上限", time: "12:02" },
  ];
  const model = talk.talkModel(talkState({ turns, hasMore: true, running: { steps: ["a", "b", "c", "d"], abortable: true, text: "作業中…" } }), talk.parseBlocks);
  const shape = (t: Tree | Tree[]): unknown =>
    Array.isArray(t) ? t.map(shape) : typeof t === "string" ? t : [t.type, t.props.class ?? null, t.props["data-who"] ?? null, shape(t.children)];
  const got = one(html`<${talk.TalkTimeline} model=${model} on=${on} />`);
  // 行を直に並べた形（TalkRows を挟まない b1 の形）
  const flat = expand(talk.TalkRows({ older: model.older, items: model.items, on }));
  const run = expand(html`<${talk.RunLine} run=${model.running} on=${on} />`);
  assert.deepEqual(shape(got.children), shape([...flat, ...run]));
  assert.deepEqual([got.type, got.props.class], ["div", "c-talk"]);
  assert.deepEqual((got.children as El[]).map((c) => c.props.class), ["c-talk-older", "c-divider", "c-notice", "c-msg", "c-msg", "c-run"]);
});

type Mouth = { draw: (root: unknown, state: Obj) => void; tick: (root: unknown, state: Obj) => void; drop: (root: unknown) => void };
/** 偽の render（呼ばれた vnode と根を積むだけ。throws が true なら投げる） */
function fakeMouth(): { mouth: Mouth; calls: { vnode: VNode | null; root: unknown }[]; fail: (v: boolean) => void } {
  const calls: { vnode: VNode | null; root: unknown }[] = [];
  let throws = false;
  const render = (vnode: VNode | null, root: unknown): void => {
    calls.push({ vnode, root });
    if (throws) throw new Error("render");
  };
  const mouth = (talk.talkMouth as unknown as (r: typeof render) => Mouth)(render);
  return { mouth, calls, fail: (v) => void (throws = v) };
}
const mouthTurns = [
  { id: 1, kind: "owner", text: "a" },
  { id: 2, kind: "agent", text: "**b** の返事", outcome: "done", steps: [] },
];
const mouthState = (text = "作業中 1 秒"): Obj => talkState({ turns: mouthTurns, running: { steps: [], abortable: true, text }, on: talkRec().on });
const rowsOfCall = (call: { vnode: VNode | null } | undefined): VNode => (call?.vnode?.props.rows as VNode);
const runOfCall = (call: { vnode: VNode | null } | undefined): Obj => ((call?.vnode?.props.model as Obj).running as Obj);

test("web components: talkMouth の draw は render を 1 回呼び、rows は key が rows の TalkRows、根は渡した物", () => {
  const { mouth, calls } = fakeMouth();
  const root = { name: "root" };
  mouth.draw(root, mouthState());
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.root, root);
  assert.equal(calls[0]?.vnode?.type, talk.TalkTimeline);
  const rows = rowsOfCall(calls[0]);
  assert.equal(rows.type, talk.TalkRows);
  assert.equal((rows as unknown as { key: unknown }).key, "rows");
});

test("web components: talkMouth の tick は draw と同じ rows を渡し、実行中の文は新しい state の物。draw をもう 1 回すると rows は新しい物", () => {
  const { mouth, calls } = fakeMouth();
  const root = {};
  mouth.draw(root, mouthState("1 秒"));
  mouth.tick(root, mouthState("2 秒"));
  assert.equal(calls.length, 2);
  assert.equal(rowsOfCall(calls[1]), rowsOfCall(calls[0]));
  assert.equal(runOfCall(calls[1]).text, "2 秒");
  mouth.draw(root, mouthState("3 秒"));
  assert.notEqual(rowsOfCall(calls[2]), rowsOfCall(calls[0]));
  mouth.tick(root, mouthState("4 秒"));
  assert.equal(rowsOfCall(calls[3]), rowsOfCall(calls[2]));
});

test("web components: talkMouth の tick は、draw していない根では全部を描き、その後の tick で同じ rows。根ごとに別の行を覚える", () => {
  const { mouth, calls } = fakeMouth();
  const a = { name: "a" };
  const b = { name: "b" };
  mouth.tick(a, mouthState());
  assert.equal(rowsOfCall(calls[0]).type, talk.TalkRows);
  mouth.tick(a, mouthState());
  assert.equal(rowsOfCall(calls[1]), rowsOfCall(calls[0]));
  mouth.draw(a, mouthState());
  mouth.tick(b, mouthState());
  assert.equal(calls[3]?.root, b);
  assert.notEqual(rowsOfCall(calls[3]), rowsOfCall(calls[2]));
  mouth.tick(a, mouthState());
  assert.equal(rowsOfCall(calls[4]), rowsOfCall(calls[2]));
});

test("web components: talkMouth の drop は render(null, root) を呼び、その後の tick は全部を描く", () => {
  const { mouth, calls } = fakeMouth();
  const root = {};
  mouth.draw(root, mouthState());
  mouth.drop(root);
  assert.deepEqual([calls[1]?.vnode, calls[1]?.root], [null, root]);
  mouth.tick(root, mouthState());
  assert.notEqual(rowsOfCall(calls[2]), rowsOfCall(calls[0]));
  assert.equal(rowsOfCall(calls[2]).type, talk.TalkRows);
});

test("web components: talkMouth は同じ文の解析の結果を使い回す", () => {
  const { mouth, calls } = fakeMouth();
  const root = {};
  mouth.draw(root, mouthState());
  mouth.draw(root, mouthState());
  const blocksOf = (call: { vnode: VNode | null } | undefined): unknown => ((rowsOfCall(call).props.items as Obj[])[1] as Obj).blocks;
  assert.ok(Array.isArray(blocksOf(calls[0])));
  assert.equal(blocksOf(calls[1]), blocksOf(calls[0]));
});

test("web components: talkMouth の render が投げたら draw も投げ、その後の tick は全部を描く（壊れた行を覚えない）", () => {
  const { mouth, calls, fail } = fakeMouth();
  const root = {};
  fail(true);
  assert.throws(() => mouth.draw(root, mouthState()), /render/);
  fail(false);
  mouth.tick(root, mouthState());
  assert.notEqual(rowsOfCall(calls[1]), rowsOfCall(calls[0]));
  mouth.tick(root, mouthState());
  assert.equal(rowsOfCall(calls[2]), rowsOfCall(calls[1]));
});

test("web components: talkMouth の tick は行ごとの文の関数（time・label・name・end）を呼ばず、行の文を読まない（解析しない）。実行中の行の関数だけを呼ぶ", () => {
  const { mouth } = fakeMouth();
  const root = {};
  // 行の文（text）を読んだ回数を数える（行のモデルを作るときだけ読まれ、解析もそこで呼ばれる）
  let reads = 0;
  const row = (id: number, kind: string, text: string, o: Obj = {}): Obj =>
    Object.defineProperty({ id, kind, ...o }, "text", {
      enumerable: true,
      get: () => {
        reads++;
        return text;
      },
    });
  const turns = Array.from({ length: 300 }, (_v, i) => (i % 2 === 0 ? row(i + 1, "owner", `q${i}`) : row(i + 1, "agent", `**返事** ${i}`, { outcome: "done", steps: ["a"] })));
  const { calls, fmt } = talkFmt();
  const state = (text: string): Obj => talkState({ turns, running: { steps: ["a", "b", "c", "d"], abortable: true, text }, fmt, on: talkRec().on });
  mouth.draw(root, state("1 秒"));
  const names = (from: number): string[] => [...new Set(calls.slice(from).map((c) => String(c[0])))].sort();
  assert.ok(names(0).includes("time") && names(0).includes("end") && names(0).includes("label") && names(0).includes("name"));
  assert.ok(reads >= 300);
  const [from, before] = [calls.length, reads];
  mouth.tick(root, state("2 秒"));
  assert.deepEqual(names(from), ["allLabel", "progress", "runName", "waiting"]);
  assert.equal(reads, before);
});

// ===== 会話の入力欄（c-composer.js。docs/plan/web-ui-components.md §6 の K5） =====
const composerUrl = new URL("../src/web/static/c-composer.js", import.meta.url).href;
const composer = (await import(composerUrl)) as Record<string, Fn> & {
  COMPOSER_NEAR: number;
  COMPOSER_HARD_MAX: number;
  composerModel: (state: Obj) => Obj;
  sendKey: (event: Obj, touch: boolean) => boolean;
};
type RawNode = { type: unknown; props: Record<string, unknown>; key?: unknown; ref?: unknown };
/** 関数の vnode を開かずに、要素の vnode を木の順で（ref と key を見るため） */
function rawEls(node: unknown): RawNode[] {
  if (node === null || node === undefined || typeof node !== "object") return [];
  if (Array.isArray(node)) return node.flatMap(rawEls);
  const v = node as RawNode;
  return [v, ...rawEls(v.props.children)];
}
const rawOf = (node: unknown, cls: string): RawNode[] => rawEls(node).filter((v) => String(v.props.class ?? "").split(" ").includes(cls));
const composerState = (o: Obj = {}): Obj => ({ text: "", count: 0, max: 1900, sending: false, touch: false, label: "話題 A に送る", placeholder: "この話題に送る", note: "説明の文", ...o });
function composerRec(): { on: { input: (v: string) => void; send: () => void }; inputs: string[]; sends: () => number } {
  const inputs: string[] = [];
  let sends = 0;
  return { on: { input: (v) => void inputs.push(v), send: () => void sends++ }, inputs, sends: () => sends };
}
const composerTree = (state: Obj, on = composerRec().on, inputRef: unknown = () => undefined): unknown =>
  composer.Composer({ model: composer.composerModel(state), on, inputRef });

test("web components: c-composer.js は htm の属性で value・defaultValue を渡さず、.value の代入は口の 2 か所だけ", () => {
  const js = stripJsComments(read("c-composer.js"));
  assert.doesNotMatch(js, /(?<![\w.-])(?:value|defaultValue)\s*=\s*\$\{/);
  assert.doesNotMatch(js, /(?<![\w.-])(?:value|defaultValue)\s*=\s*["']/);
  assert.equal((js.match(/\.value\s*=(?!=)/g) ?? []).length, 2);
});

test("web components: composerModel の空・空白だけ・1 字（字数は出さず、空は押せない）", () => {
  for (const text of ["", "  \n "]) {
    const m = composer.composerModel(composerState({ text, count: 0 }));
    assert.deepEqual([m.empty, m.showCount, m.countText, m.over, m.sendDisabled, m.sendBusy, m.sendReason], [true, false, "", false, true, false, "本文を入れると送れます"], JSON.stringify(text));
  }
  const m = composer.composerModel(composerState({ text: "あ", count: 1 }));
  assert.deepEqual([m.empty, m.showCount, m.countText, m.sendDisabled, m.sendReason], [false, false, "", false, undefined]);
  assert.deepEqual([m.label, m.placeholder, m.note, m.touch, m.enterHint], ["話題 A に送る", "この話題に送る", "説明の文", false, "send"]);
});

test("web components: composerModel の字数（1,700 字は出さず、1,701 字から「1,701 / 1,900」、1,901 字は over でも押せる）", () => {
  assert.equal(composer.COMPOSER_NEAR, 200);
  assert.equal(composer.COMPOSER_HARD_MAX, 4000);
  const at = (count: number): Obj => composer.composerModel(composerState({ text: "x".repeat(count), count }));
  assert.deepEqual([at(1700).showCount, at(1700).countText], [false, ""]);
  assert.deepEqual([at(1701).showCount, at(1701).countText, at(1701).over], [true, "1,701 / 1,900", false]);
  assert.deepEqual([at(1900).countText, at(1900).over, at(1900).sendDisabled], ["1,900 / 1,900", false, false]);
  assert.deepEqual([at(1901).countText, at(1901).over, at(1901).sendDisabled, at(1901).sendReason], ["1,901 / 1,900", true, false, undefined]);
});

test("web components: composerModel の送っている間・touch・写し・string でない値", () => {
  const sending = composer.composerModel(composerState({ text: "a", count: 1, sending: true }));
  assert.deepEqual([sending.sendBusy, sending.sendDisabled, sending.sendReason], [true, false, "送っています"]);
  // 空で送っている間は「送っています」を先に言う
  assert.equal(composer.composerModel(composerState({ sending: true })).sendReason, "送っています");
  const touch = composer.composerModel(composerState({ touch: true }));
  assert.deepEqual([touch.touch, touch.enterHint], [true, "enter"]);
  assert.equal(composer.composerModel(composerState({ text: "a\n" })).mirror, "a\n ");
  assert.equal(composer.composerModel(composerState({ text: "" })).mirror, " ");
  const bad = composer.composerModel(composerState({ text: 12, label: null, placeholder: 3, note: undefined }));
  assert.deepEqual([bad.mirror, bad.empty, bad.label, bad.placeholder, bad.note], [" ", true, "", "", ""]);
});

test("web components: sendKey は bindSendKeys と同じ決まり（変換の途中は送らない・タッチが主は Enter が改行）", () => {
  const rows: Array<[string, boolean, number, boolean, boolean, boolean, boolean, boolean]> = [
    ["Enter", false, 13, false, false, false, false, true],
    ["Enter", false, 13, false, false, true, false, false],
    ["Enter", false, 13, false, false, false, true, false],
    ["Enter", false, 13, true, false, false, true, true],
    ["Enter", false, 13, false, true, false, true, true],
    ["Enter", false, 13, true, false, true, false, true],
    ["Enter", true, 13, false, false, false, false, false],
    ["Enter", false, 229, false, false, false, false, false],
    ["Enter", true, 229, true, false, false, false, false],
    ["a", false, 65, true, false, false, false, false],
    ["Enter", false, 13, false, true, false, false, true],
    ["Enter", false, 13, false, false, true, true, false],
  ];
  rows.forEach(([key, isComposing, keyCode, ctrlKey, metaKey, shiftKey, touch, want], i) => {
    assert.equal(composer.sendKey({ key, isComposing, keyCode, ctrlKey, metaKey, shiftKey }, touch), want, `${i + 1} 行目`);
  });
});

test("web components: Composer の根・直下の子の key・textarea の props（value と defaultValue が無い）・升の最初の子・写し", () => {
  const ref = (): void => undefined;
  const v = composerTree(composerState({ text: "あい", count: 2 }), composerRec().on, ref) as RawNode;
  assert.deepEqual([v.type, v.props.class], ["div", "c-composer"]);
  const kids = rawEls(v.props.children).filter((c) => (v.props.children as unknown[]).flat(Infinity).includes(c));
  assert.deepEqual(kids.map((c) => [c.props.class, c.key]), [["c-composer-sent", "sent"], ["c-composer-row", "row"], ["c-composer-count", "count"]]);
  const [ta] = rawEls(v).filter((c) => c.type === "textarea");
  assert.ok(ta);
  assert.equal(ta.ref, ref);
  assert.deepEqual(
    [ta.props.class, ta.props.rows, ta.props.maxlength, ta.props["aria-label"], ta.props.placeholder, ta.props.title, ta.props.enterkeyhint],
    ["c-composer-input", "1", 4000, "話題 A に送る", "この話題に送る", "説明の文", "send"],
  );
  for (const name of ["value", "defaultValue"]) assert.ok(!(name in ta.props), name);
  const [field] = rawOf(v, "c-composer-field");
  assert.ok(field);
  const fieldKids = [field.props.children].flat(Infinity).filter((c) => c && typeof c === "object") as RawNode[];
  assert.equal(fieldKids[0], ta);
  assert.deepEqual(fieldKids.map((c) => c.props.class), ["c-composer-input", "c-composer-mirror"]);
  const root = one(v);
  const [mirror] = find(root, "c-composer-mirror");
  assert.deepEqual([mirror?.props["aria-hidden"], textOf(mirror as El)], ["true", "あい "]);
  // ［送る］は accent・md・字だけ
  const [btn] = find(root, "c-btn");
  assert.deepEqual([btn?.props["data-kind"], btn?.props["data-size"], textOf(btn as El), find(btn as El, "c-icon").length], ["accent", "md", "送る", 0]);
  // touch で enterkeyhint が enter
  const [taTouch] = rawEls(composerTree(composerState({ touch: true }))).filter((c) => c.type === "textarea");
  assert.equal(taTouch?.props.enterkeyhint, "enter");
});

test("web components: composerModel の sent（無い・文が空・文字列でない → null。tone は done・warning のほかは空。cancel・busy は真偽に）", () => {
  for (const sent of [undefined, null, "x", 3, { id: 1, text: "" }, { id: 1, text: 5 }, { id: 1 }]) assert.equal(composer.composerModel(composerState({ sent })).sent, null, JSON.stringify(sent));
  const m = (o: Obj): unknown => JSON.parse(JSON.stringify(composer.composerModel(composerState({ sent: { id: 12, text: "本文 #12: 届けました", ...o } })).sent));
  assert.deepEqual(m({ tone: "done" }), { id: 12, text: "本文 #12: 届けました", tone: "done", cancel: false, busy: false });
  assert.equal((m({ tone: "warning" }) as Obj).tone, "warning");
  for (const tone of [undefined, "", "danger", 1]) assert.equal((m({ tone }) as Obj).tone, "", String(tone));
  assert.deepEqual([(m({ cancel: 1, busy: "y" }) as Obj).cancel, (m({ cancel: 1, busy: "y" }) as Obj).busy], [true, true]);
});

test("web components: composerModel の sent の cancel は id が数のときだけ true（id が無い・文字列では［やめる］を出さない）", () => {
  const cancelOf = (sent: Obj): unknown => (composer.composerModel(composerState({ sent: { text: "本文 #1: 届け待ち", cancel: true, ...sent } })).sent as Obj).cancel;
  assert.equal(cancelOf({ id: 1 }), true);
  for (const id of [undefined, null, "1"]) assert.equal(cancelOf({ id }), false, String(id));
});

test("web components: Composer の帯はいつも最初の子（key=sent・aria-live=polite）で、無いときは子が 0。在れば文と data-tone、cancel なら［やめる］（ghost・sm・理由なし）で on.cancel(id)、busy では呼ばない", () => {
  const sentOf = (sent: unknown, on: Obj = composerRec().on): { v: RawNode; box: El } => {
    const v = composerTree(composerState({ text: "下書き", count: 3, sent }), on as never) as RawNode;
    const first = [v.props.children].flat(Infinity).filter((c) => c && typeof c === "object")[0] as RawNode;
    assert.deepEqual([first.props.class, first.key, first.props["aria-live"]], ["c-composer-sent", "sent", "polite"]);
    const [box] = find(one(v), "c-composer-sent");
    return { v, box: box as El };
  };
  const none = sentOf(null).box;
  assert.deepEqual(none.children, [], "中身が無ければ子が 0（余白を持たず高さ 0）");
  assert.ok(!("data-tone" in none.props) || none.props["data-tone"] === undefined);
  const done = sentOf({ id: 12, text: "本文 #12: 届けました・返事が来ました", tone: "done" }).box;
  assert.deepEqual([done.props["data-tone"], textOf(find(done, "c-composer-sent-text")), find(done, "c-btn").length], ["done", "本文 #12: 届けました・返事が来ました", 0]);
  const plain = sentOf({ id: 15, text: "本文 #15: 送るのをやめました", tone: "" }).box;
  assert.ok(!("data-tone" in plain.props) || plain.props["data-tone"] === undefined, "tone が空なら属性なし");
  assert.equal(sentOf({ id: 13, text: "本文 #13: 届けました", tone: "warning" }).box.props["data-tone"], "warning");
  const cancels: unknown[] = [];
  const on = { ...composerRec().on, cancel: (id: unknown) => void cancels.push(id) };
  const idle = sentOf({ id: 14, text: "本文 #14: 届け待ち。入力待ちになったら届けます", tone: "", cancel: true }, on).box;
  const [b] = find(idle, "c-btn");
  assert.deepEqual([b?.props["data-kind"], b?.props["data-size"], textOf(b as El)], ["ghost", "sm", "やめる"]);
  for (const name of ["aria-disabled", "aria-busy", "title"]) assert.ok(!(name in (b as El).props) || (b as El).props[name] === undefined, name);
  (b?.props.onClick as (e: unknown) => void)(fakeEvent());
  assert.deepEqual(cancels, [14]);
  const busy = sentOf({ id: 14, text: "本文 #14: 届け待ち。入力待ちになったら届けます", tone: "", cancel: true, busy: true }, on).box;
  const [bb] = find(busy, "c-btn");
  assert.deepEqual([bb?.props["aria-disabled"], bb?.props["aria-busy"]], ["true", "true"]);
  (bb?.props.onClick as (e: unknown) => void)(fakeEvent());
  assert.deepEqual(cancels, [14], "busy の間は呼ばない");
});

test("web components: Composer の帯の有り無しで、行と textarea の位置・key・ref は同じ（帯の出入りで欄を作り直さない）", () => {
  const ref = (): void => undefined;
  const shape = (sent: unknown): unknown => {
    const v = composerTree(composerState({ text: "a", count: 1, sent }), composerRec().on, ref) as RawNode;
    const kids = [v.props.children].flat(Infinity).filter((c) => c && typeof c === "object") as RawNode[];
    const index = kids.findIndex((c) => c.props.class === "c-composer-row");
    const [ta] = rawEls(kids[index]).filter((c) => c.type === "textarea");
    return [kids.map((c) => c.key), index, ta?.ref === ref, ta?.key];
  };
  const without = shape(null);
  assert.deepEqual(without, [["sent", "row", "count"], 1, true, undefined]);
  for (const sent of [{ id: 1, text: "本文 #1: 届けました", tone: "done" }, { id: 2, text: "本文 #2: 届け待ち。入力待ちになったら届けます", cancel: true }]) assert.deepEqual(shape(sent), without);
});

test("web components: Composer の字数の入れ物はいつも在り aria-live=polite、文は出るときだけで data-over", () => {
  const countOf = (count: number): El => {
    const [box] = find(one(composerTree(composerState({ text: "x", count }))), "c-composer-count");
    assert.ok(box);
    assert.equal(box.props["aria-live"], "polite");
    return box;
  };
  assert.deepEqual(countOf(1).children, []);
  const near = find(countOf(1701), "c-composer-count-text");
  assert.deepEqual([near.length, textOf(near), near[0]?.props["data-over"]], [1, "1,701 / 1,900", undefined]);
  const over = find(countOf(1901), "c-composer-count-text");
  assert.deepEqual([textOf(over), over[0]?.props["data-over"]], ["1,901 / 1,900", "true"]);
});

test("web components: Composer の onKeyDown は送るキーで preventDefault と on.send を 1 回ずつ、変換の途中は 0 回。onInput は欄の値を on.input に。［送る］と Enter は空・送っている途中で送らない", () => {
  const rec = composerRec();
  const v = composerTree(composerState({ text: "a", count: 1 }), rec.on);
  const [ta] = rawEls(v).filter((c) => c.type === "textarea");
  const keyDown = ta?.props.onKeyDown as (e: Obj) => void;
  const ev = (o: Obj): Obj & { count: () => number } => {
    let n = 0;
    return { key: "Enter", isComposing: false, keyCode: 13, ctrlKey: false, metaKey: false, shiftKey: false, ...o, preventDefault: () => void n++, count: () => n };
  };
  const first = ev({});
  keyDown(first);
  assert.deepEqual([first.count(), rec.sends()], [1, 1]);
  const composing = ev({ isComposing: true });
  keyDown(composing);
  assert.deepEqual([composing.count(), rec.sends()], [0, 1]);
  (ta?.props.onInput as (e: Obj) => void)({ currentTarget: { value: "あいう" } });
  assert.deepEqual(rec.inputs, ["あいう"]);
  // ［送る］は押せるときだけ on.send
  const [btn] = find(one(v), "c-btn");
  (btn?.props.onClick as (e: Obj) => void)(fakeEvent());
  assert.equal(rec.sends(), 2);
  const emptyRec = composerRec();
  const [emptyBtn] = find(one(composerTree(composerState(), emptyRec.on)), "c-btn");
  assert.deepEqual([emptyBtn?.props["aria-disabled"], emptyBtn?.props.title], ["true", "本文を入れると送れます"]);
  (emptyBtn?.props.onClick as (e: Obj) => void)(fakeEvent());
  assert.equal(emptyRec.sends(), 0);
  // Enter も同じ: 空・送っている途中は on.send を呼ばず、改行も入れない
  for (const state of [composerState(), composerState({ text: "a", count: 1, sending: true })]) {
    const r = composerRec();
    const [t] = rawEls(composerTree(state, r.on)).filter((c) => c.type === "textarea");
    const e = ev({});
    (t?.props.onKeyDown as (e: Obj) => void)(e);
    assert.deepEqual([e.count(), r.sends()], [1, 0]);
  }
});

type ComposerMouth = { draw: (root: unknown, state: Obj) => void; set: (root: unknown, text: string) => boolean; focus: (root: unknown) => boolean; drop: (root: unknown) => void };
type FakeInput = { value: string; focus: (o?: unknown) => void; focused: unknown[] };
const fakeInput = (): FakeInput => {
  const el: FakeInput = { value: "", focused: [], focus: (o) => void el.focused.push(o) };
  return el;
};
/** 偽の render（描くたびに vnode の inputRef に今の要素を渡す。同じ要素でも渡し直す（口が同じ要素に書かない事を見るため）。要素か ref が替わったら前の ref に null を先に渡す。null の vnode では null を渡す） */
function fakeComposerMouth(): { mouth: ComposerMouth; calls: { vnode: VNode | null; root: unknown }[]; swap: (el: FakeInput) => void; fail: (v: boolean) => void } {
  const calls: { vnode: VNode | null; root: unknown }[] = [];
  let el = fakeInput();
  let given: FakeInput | null = null;
  let lastRef: ((n: unknown) => void) | null = null;
  let throws = false;
  const render = (vnode: VNode | null, root: unknown): void => {
    calls.push({ vnode, root });
    if (throws) throw new Error("render");
    if (vnode === null) {
      if (lastRef && given) lastRef(null);
      given = null;
      lastRef = null;
      return;
    }
    const ref = vnode.props.inputRef as (n: unknown) => void;
    if ((given !== el || ref !== lastRef) && lastRef && given) lastRef(null);
    ref(el);
    given = el;
    lastRef = ref;
  };
  const mouth = (composer.composerMouth as unknown as (r: typeof render) => ComposerMouth)(render);
  return { mouth, calls, swap: (next) => void (el = next), fail: (v) => void (throws = v) };
}

test("web components: composerMouth の draw は最初の要素に本文を入れ、同じ要素には二度と書かない。ref は根ごとに同じ関数", () => {
  const { mouth, calls, swap } = fakeComposerMouth();
  const root = {};
  const el = fakeInput();
  swap(el);
  mouth.draw(root, composerState({ text: "あ" }));
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.vnode?.type, composer.Composer);
  assert.equal(calls[0]?.root, root);
  assert.equal(el.value, "あ");
  // 打鍵のつもり
  el.value = "あい";
  mouth.draw(root, composerState({ text: "zzz" }));
  assert.equal(el.value, "あい");
  assert.equal(calls[1]?.vnode?.props.inputRef, calls[0]?.vnode?.props.inputRef);
  // 根ごとに別の ref
  mouth.draw({}, composerState({ text: "b" }));
  assert.notEqual(calls[2]?.vnode?.props.inputRef, calls[0]?.vnode?.props.inputRef);
});

test("web components: composerMouth の ref(null) の後に別の要素が来たら、その時の本文を入れる", () => {
  const { mouth, calls } = fakeComposerMouth();
  const root = {};
  mouth.draw(root, composerState({ text: "一" }));
  const ref = calls[0]?.vnode?.props.inputRef as (n: unknown) => void;
  ref(null);
  // 欄が外れた後は、前の要素に触れない
  assert.equal(mouth.set(root, "x"), false);
  assert.equal(mouth.focus(root), false);
  mouth.draw(root, composerState({ text: "二" }));
  const next = fakeInput();
  ref(next);
  assert.equal(next.value, "二");
  assert.equal(mouth.focus(root), true);
  assert.equal(next.focused.length, 1);
});

test("web components: composerMouth の set・focus は要素が在れば true、無い根では false。focus は preventScroll", () => {
  const { mouth, swap } = fakeComposerMouth();
  const root = {};
  assert.equal(mouth.set(root, "x"), false);
  assert.equal(mouth.focus(root), false);
  const el = fakeInput();
  swap(el);
  mouth.draw(root, composerState({ text: "書きかけ" }));
  assert.equal(el.value, "書きかけ");
  assert.equal(mouth.set(root, ""), true);
  assert.equal(el.value, "");
  assert.equal(mouth.focus(root), true);
  assert.deepEqual(el.focused, [{ preventScroll: true }]);
  assert.equal(mouth.set({}, ""), false);
  assert.equal(mouth.focus({}), false);
});

test("web components: composerMouth の drop は render(null, root) を呼び、その後の draw は最初と同じに動く。render が投げたら draw も投げる", () => {
  const { mouth, calls, swap, fail } = fakeComposerMouth();
  const root = {};
  mouth.draw(root, composerState({ text: "a" }));
  mouth.drop(root);
  assert.deepEqual([calls[1]?.vnode, calls[1]?.root], [null, root]);
  assert.equal(mouth.focus(root), false);
  const el = fakeInput();
  swap(el);
  mouth.draw(root, composerState({ text: "b" }));
  assert.equal(el.value, "b");
  assert.notEqual(calls[2]?.vnode?.props.inputRef, calls[0]?.vnode?.props.inputRef);
  fail(true);
  assert.throws(() => mouth.draw(root, composerState({ text: "c" })), /render/);
});

test("web components: 入力欄の欄は入力の位置の線の色（caret-color: var(--accent)）を自分で持つ", () => {
  const rules = parseCss(read("c-composer.css"));
  const own = rules.filter((r) => r.at.length === 0 && r.selectors.length === 1 && r.selectors[0] === ".c-composer-input");
  assert.ok(own.some((r) => r.body.split(";").map((d) => d.trim()).includes("caret-color: var(--accent)")));
});

test("web components: 入力欄の欄と写しは 1 つの規則で余白・枠・高さ・折り返しを同じにし、欄は resize: none。根は自分の字と色を持ち、動きが無い", () => {
  const rules = parseCss(read("c-composer.css"));
  const decls = (r: CssRule): string[] => r.body.split(";").map((d) => d.trim()).filter((d) => d !== "");
  const props = (r: CssRule): string[] => decls(r).map((d) => d.split(":")[0]?.trim() ?? "");
  const both = rules.filter((r) => r.at.length === 0 && r.selectors.includes(".c-composer-input") && r.selectors.includes(".c-composer-mirror"));
  assert.equal(both.length, 1);
  for (const name of ["padding", "border", "min-height", "max-height", "white-space", "overflow-wrap", "box-sizing", "grid-area", "border-radius"]) assert.ok(props(both[0] as CssRule).includes(name), name);
  // 欄だけ・写しだけの規則は、字・余白・枠の太さ・高さを変えない（写しの枠は色だけ）
  for (const r of rules.filter((x) => x !== both[0] && x.selectors.some((s) => /^\.c-composer-(?:input|mirror)$/.test(s)))) {
    for (const name of props(r)) assert.ok(!/^(?:padding|border(?!-color)|min-height|max-height|font|line-height|white-space|overflow-wrap|box-sizing|letter-spacing)/.test(name), `${r.selectors.join(",")}: ${name}`);
  }
  assert.ok(rules.some((r) => r.at.length === 0 && r.selectors.length === 1 && r.selectors[0] === ".c-composer-input" && decls(r).includes("resize: none")));
  const own = rules.filter((r) => r.at.length === 0 && r.selectors.length === 1 && r.selectors[0] === ".c-composer");
  assert.ok(own.length > 0);
  for (const decl of ["font-size: var(--c-font-body)", "line-height: var(--leading-normal)", "color: var(--text)"]) assert.ok(own.some((r) => decls(r).includes(decl)), decl);
  // 帯の地は書かない
  for (const r of own) assert.ok(!props(r).some((p) => p.startsWith("background")), "c-composer の地");
  const src = stripCssComments(read("c-composer.css"));
  assert.doesNotMatch(src, /\b(?:animation|transition)(?:-[a-z-]+)?\s*:|@keyframes/);
});

// ===== カード（c-cards.js。docs/plan/web-ui-components.md §6 の K5） =====
const cardsUrl = new URL("../src/web/static/c-cards.js", import.meta.url).href;
const cards = (await import(cardsUrl)) as Record<string, Fn> & { PERMISSION_NOTE: string; SESSION_PERMISSION_NOTE: string; SESSION_QUESTION_NOTE: string };
/** on の名前を全部持つ記録（呼ばれた順に [名前, ...引数]） */
function cardRec(): { calls: unknown[][]; on: Record<string, (...a: unknown[]) => void> } {
  const calls: unknown[][] = [];
  const rec = (name: string) => (...a: unknown[]): void => void calls.push([name, ...a]);
  const names = ["permit", "always", "task", "close", "move", "pick", "pickOther", "other", "answer", "dismiss"];
  return { calls, on: Object.fromEntries(names.map((n) => [n, rec(n)])) };
}
const permItem = (o: Obj = {}): Obj => ({ kind: "permission", id: 7, tool: "Bash", mode: "default（使うたびに確認）", summary: "npm test", rule: "", ruleNote: "", always: false, left: "残り 4 分 12 秒", urgent: false, busy: false, ...o });
const closeItem = (o: Obj = {}): Obj => ({ kind: "close", id: "c1", summary: "段落 1\n\n段落 2", tasks: ["1. 題 A", "2. 題 B（期限 11/20）", "3. 題 C"], picked: [], busy: false, ...o });
const moveItem = (o: Obj = {}): Obj => ({ kind: "move", id: "m1", from: "self-agent", to: "見本のプロジェクト", busy: false, ...o });
const cardOf = (item: Obj, on = cardRec().on): El => {
  const name = item.kind === "permission" ? "PermissionCard" : item.kind === "close" ? "CloseCard" : "MoveCard";
  return one(html`<${cards[name]} item=${item} on=${on} />`);
};
/** 直下の子の要素（文字は落とす） */
const kidsOf = (el: El): El[] => el.children.filter((c): c is El => typeof c !== "string");
/** ボタンの [kind, 字] と、押せない印・理由 */
const btnsOf = (el: El): unknown[][] => find(el, "c-btn").map((b) => [b.props["data-kind"], textOf(b)]);
const press = (b: El | undefined): void => (b?.props.onClick as (e: unknown) => void)(fakeEvent());

test("web components: Cards は並びでない・空で null、根は div.c-cards、子の key は kind:id、知らない kind は出さない", () => {
  for (const items of [undefined, null, "x", {}, []]) assert.equal(cards.Cards({ items, on: cardRec().on }), null, JSON.stringify(items));
  const items = [{ kind: "note", id: "n1", text: "待ち…", busy: true }, closeItem(), moveItem(), permItem(), { kind: "nope", id: 1 }, null];
  const v = cards.Cards({ items, on: cardRec().on }) as RawNode;
  assert.deepEqual([v.type, v.props.class], ["div", "c-cards"]);
  assert.deepEqual(keysOf(v.props.children), ["note:n1", "close:c1", "move:m1", "permission:7"]);
  const root = one(v);
  assert.deepEqual(kidsOf(root).map((k) => [k.type, k.props["data-kind"] ?? k.props.class]), [["p", "c-note"], ["section", "close"], ["section", "move"], ["section", "permission"]]);
});

test("web components: Card の aria-label・data-kind、直下の子の key（head・子・note）、meta・note が空なら出さず、data-urgent は true・false・属性なし", () => {
  const raw = (o: Obj): RawNode => cards.Card({ kind: "x", label: "名前", title: "題", children: [html`<p key="a">中</p>`], ...o }) as RawNode;
  const v = raw({ meta: "右", note: "下", urgent: true });
  assert.deepEqual([v.type, v.props.class, v.props["aria-label"], v.props["data-kind"]], ["section", "c-card", "名前", "x"]);
  assert.deepEqual(keysOf(v.props.children), ["head", "a", "note"]);
  const el = one(v);
  assert.deepEqual(kidsOf(el).map((k) => k.props.class), ["c-card-head", undefined, "c-card-note"]);
  const [title] = find(el, "c-card-title");
  assert.deepEqual([title?.type, textOf(title as El)], ["h2", "題"]);
  assert.equal(find(el, "c-card-meta")[0]?.props["data-urgent"], "true");
  assert.equal(find(one(raw({ meta: "右", urgent: false })), "c-card-meta")[0]?.props["data-urgent"], "false");
  const plain = find(one(raw({ meta: "右" })), "c-card-meta")[0];
  assert.ok(plain && !("data-urgent" in plain.props && plain.props["data-urgent"] !== undefined));
  const bare = one(raw({ meta: "", note: "" }));
  assert.deepEqual([find(bare, "c-card-meta").length, find(bare, "c-card-note").length], [0, 0]);
  assert.deepEqual(keysOf((raw({}) as RawNode).props.children), ["head", "a"]);
});

test("web components: 許可のカードの木と言葉（見出し・facts・pre・常に許可の有り無し・ボタン・説明の文。残り時間の印と section の title は無い）", () => {
  const el = cardOf(permItem());
  assert.deepEqual([el.props["aria-label"], textOf(find(el, "c-card-title"))], ["許可の要求", "あなたの番: 許可"]);
  assert.ok(!("title" in el.props) || el.props.title === undefined);
  assert.equal(textOf(find(el, "c-card-facts")), "Bash ・ default（使うたびに確認）");
  assert.equal(textOf(find(el, "c-card-mono")), "Bash");
  assert.equal(textOf(cardOf(permItem({ mode: "" }))).includes(" ・ "), false);
  assert.equal(textOf(find(cardOf(permItem({ mode: "" })), "c-card-facts")), "Bash");
  const [pre] = find(el, "c-card-code");
  assert.deepEqual([pre?.type, textOf(pre as El)], ["pre", "npm test"]);
  assert.equal(find(el, "c-card-always").length, 0);
  assert.deepEqual([textOf(find(el, "c-card-meta")), find(el, "c-card-meta")[0]?.props["data-urgent"]], ["残り 4 分 12 秒", "false"]);
  for (const always of [true, false]) {
    const r = cardOf(permItem({ rule: "Bash(npm run test:*)", ruleNote: "添え書き", always }));
    const [box] = find(r, "c-card-always");
    assert.ok(box);
    const [input] = find(box, "c-card-check-input");
    assert.deepEqual([input?.type, input?.props.type, input?.props.checked, input?.props.disabled], ["input", "checkbox", always, false]);
    assert.equal(textOf(find(box, "c-card-check-text")), "このセッションでは常に許可");
    assert.equal(textOf(find(box, "c-card-rule-code")), "Bash(npm run test:*)");
    assert.equal(textOf(find(box, "c-card-rule")), "Bash(npm run test:*)（添え書き）");
  }
  const noNote = cardOf(permItem({ rule: "Bash(ls)", ruleNote: "" }));
  assert.equal(textOf(find(noNote, "c-card-rule")), "Bash(ls)");
  assert.equal(find(noNote, "c-card-rule-note").length, 0);
  assert.deepEqual(btnsOf(el), [["secondary", "許可"], ["ghost", "拒否"]]);
  for (const b of find(el, "c-btn")) assert.deepEqual([b.props["data-size"], find(b, "c-icon").length, b.props["aria-disabled"]], ["md", 0, undefined]);
  assert.equal(find(el, "c-card-actions")[0]?.props["data-count"], "2");
  const last = kidsOf(el).at(-1);
  assert.deepEqual([last?.props.class, textOf(last as El)], ["c-card-note", cards.PERMISSION_NOTE]);
  assert.equal(cards.PERMISSION_NOTE, "端末や RC のダイアログでも答えられます。先に答えた方が効きます。");
  const all = JSON.stringify(expand(html`<${cards.PermissionCard} item=${permItem({ rule: "r", urgent: true })} on=${cardRec().on} />`), (k, v) => (typeof v === "function" ? undefined : v));
  assert.doesNotMatch(all, /data-permission-left/);
  assert.equal(find(cardOf(permItem({ urgent: true })), "c-card-meta")[0]?.props["data-urgent"], "true");
});

test("web components: 閉じる前の確認のボタンは key で見分ける（候補が無い形から在る形へ替わっても ［登録しない］ が別のボタンにならない）", () => {
  const actionKeys = (item: Obj): unknown[] => {
    const v = cards.CloseCard({ item, on: cardRec().on }) as RawNode;
    const actions = (Array.isArray(v.props.children) ? v.props.children.flat(Infinity) : [v.props.children]).find((c) => (c as RawNode | null)?.key === "actions") as RawNode;
    return keysOf(actions.props.children);
  };
  assert.deepEqual(actionKeys(closeItem({ tasks: [] })), ["none"]);
  assert.deepEqual(actionKeys(closeItem()), ["all", "picked", "none"]);
});

test("web components: 許可のカードの呼び出し（許可は always か allow、拒否は deny、チェックは always(id, checked)。busy は押しても呼ばない）", () => {
  const go = (o: Obj): unknown[][] => {
    const rec = cardRec();
    const [allow, deny] = find(cardOf(permItem(o), rec.on), "c-btn");
    press(allow);
    press(deny);
    return rec.calls;
  };
  assert.deepEqual(go({}), [["permit", 7, "allow"], ["permit", 7, "deny"]]);
  assert.deepEqual(go({ rule: "Bash(ls)", always: true }), [["permit", 7, "always"], ["permit", 7, "deny"]]);
  assert.deepEqual(go({ rule: "Bash(ls)", always: false }), [["permit", 7, "allow"], ["permit", 7, "deny"]]);
  assert.deepEqual(go({ always: true }), [["permit", 7, "allow"], ["permit", 7, "deny"]]);
  const rec = cardRec();
  const el = cardOf(permItem({ rule: "Bash(ls)" }), rec.on);
  const [input] = find(el, "c-card-check-input");
  for (const checked of [true, false]) (input?.props.onChange as (e: unknown) => void)({ currentTarget: { checked } });
  assert.deepEqual(rec.calls, [["always", 7, true], ["always", 7, false]]);
  assert.equal(find(el, "c-card-check")[0]?.props.title, undefined);
  // busy
  const busyRec = cardRec();
  const busy = cardOf(permItem({ rule: "Bash(ls)", always: true, busy: true }), busyRec.on);
  for (const b of find(busy, "c-btn")) {
    assert.deepEqual([b.props["aria-disabled"], b.props.title, b.props["aria-busy"]], ["true", "答えを送っています", undefined]);
    press(b);
  }
  assert.deepEqual(busyRec.calls, []);
  assert.equal(find(busy, "c-card-check-input")[0]?.props.disabled, true);
  assert.equal(find(busy, "c-card-check")[0]?.props.title, "答えを送っています");
});

test("web components: 閉じる前の確認の木と言葉（見出し・右の文・dt・候補の行と checked・候補なし・ボタン）", () => {
  const el = cardOf(closeItem({ picked: [1] }));
  assert.deepEqual([el.props["aria-label"], textOf(find(el, "c-card-title"))], ["閉じる前の確認", "あなたの番: 閉じる前の確認"]);
  const [meta] = find(el, "c-card-meta");
  assert.deepEqual([textOf(meta as El), meta?.props["data-urgent"]], ["Discord でも選べます", undefined]);
  assert.deepEqual(find(el, "c-card-dt").map((d) => [d.type, textOf(d)]), [["dt", "要約"], ["dt", "タスクにする候補"]]);
  assert.equal(textOf(find(el, "c-card-text")), "段落 1\n\n段落 2");
  const rows = find(el, "c-card-check");
  assert.deepEqual(rows.map((r) => [r.type, textOf(r), find(r, "c-card-check-input")[0]?.props.checked]), [
    ["label", "1. 題 A", false],
    ["label", "2. 題 B（期限 11/20）", true],
    ["label", "3. 題 C", false],
  ]);
  assert.equal(find(el, "c-card-none").length, 0);
  assert.deepEqual(btnsOf(el), [["primary", "全部登録"], ["secondary", "選んだものを登録"], ["secondary", "登録しない"]]);
  assert.equal(find(el, "c-card-actions")[0]?.props["data-count"], "3");
  assert.equal(find(el, "c-card-note").length, 0);
  const none = cardOf(closeItem({ tasks: [] }));
  assert.equal(textOf(find(none, "c-card-none")), "やることの候補はありません。");
  assert.equal(find(none, "c-card-check").length, 0);
  assert.deepEqual(btnsOf(none), [["secondary", "登録しない"]]);
  assert.equal(find(none, "c-card-actions")[0]?.props["data-count"], "1");
});

test("web components: 閉じる前の確認の呼び出し（close の 3 つ・task(id, 番号, checked)。選んでいない間の理由・busy）", () => {
  const rec = cardRec();
  const el = cardOf(closeItem({ picked: [0] }), rec.on);
  for (const b of find(el, "c-btn")) press(b);
  const inputs = find(el, "c-card-check-input");
  (inputs[2]?.props.onChange as (e: unknown) => void)({ currentTarget: { checked: true } });
  (inputs[0]?.props.onChange as (e: unknown) => void)({ currentTarget: { checked: false } });
  assert.deepEqual(rec.calls, [["close", "c1", "all"], ["close", "c1", "picked"], ["close", "c1", "none"], ["task", "c1", 2, true], ["task", "c1", 0, false]]);
  const emptyRec = cardRec();
  const empty = cardOf(closeItem(), emptyRec.on);
  const [all, picked, none] = find(empty, "c-btn");
  assert.deepEqual([all?.props["aria-disabled"], picked?.props["aria-disabled"], picked?.props.title, none?.props["aria-disabled"]], [undefined, "true", "候補を選ぶと押せます", undefined]);
  press(picked);
  assert.deepEqual(emptyRec.calls, []);
  const busyRec = cardRec();
  const busy = cardOf(closeItem({ busy: true }), busyRec.on);
  for (const b of find(busy, "c-btn")) {
    assert.deepEqual([b.props["aria-disabled"], b.props.title], ["true", "答えを送っています"]);
    press(b);
  }
  for (const input of find(busy, "c-card-check-input")) assert.equal(input.props.disabled, true);
  assert.deepEqual(busyRec.calls, []);
  const busyNone = find(cardOf(closeItem({ tasks: [], busy: true })), "c-btn");
  assert.deepEqual(busyNone.map((b) => b.props.title), ["答えを送っています"]);
});

test("web components: 場所を変える確認の木・言葉・呼び出し・busy", () => {
  const rec = cardRec();
  const el = cardOf(moveItem(), rec.on);
  assert.deepEqual([el.props["aria-label"], textOf(find(el, "c-card-title")), textOf(find(el, "c-card-meta"))], ["場所を変える確認", "あなたの番: 場所を変える確認", "Discord でも選べます"]);
  assert.deepEqual(find(el, "c-card-dt").map(textOf), ["今の場所", "変える先"]);
  assert.deepEqual(find(el, "c-card-dd").map(textOf), ["self-agent", "見本のプロジェクト"]);
  assert.deepEqual(find(el, "c-card-text").map((t) => [t.type, textOf(t)]), [["p", "会話は新しくなり、担当には要点を引き継ぎます。記録はこのまま残ります。ファイルは動かしません。"]]);
  assert.deepEqual(btnsOf(el), [["primary", "変える"], ["secondary", "このまま"]]);
  assert.equal(find(el, "c-card-actions")[0]?.props["data-count"], "2");
  for (const b of find(el, "c-btn")) press(b);
  assert.deepEqual(rec.calls, [["move", "m1", "accept"], ["move", "m1", "keep"]]);
  const busyRec = cardRec();
  for (const b of find(cardOf(moveItem({ busy: true }), busyRec.on), "c-btn")) {
    assert.deepEqual([b.props["aria-disabled"], b.props.title], ["true", "答えを送っています"]);
    press(b);
  }
  assert.deepEqual(busyRec.calls, []);
});

test("web components: Note は busy のときだけ role=status・data-busy（aria-busy は付けない: 読み上げが待たされる）", () => {
  const busy = one(cards.Note({ text: "閉じる前の要約をしています…", busy: true }));
  assert.deepEqual([busy.type, busy.props.class, busy.props.role, busy.props["data-busy"], textOf(busy)], ["p", "c-note", "status", "true", "閉じる前の要約をしています…"]);
  assert.ok(!("aria-busy" in busy.props) || busy.props["aria-busy"] === undefined, "待ちの行に aria-busy は無い");
  const plain = one(cards.Note({ text: "まだ会話はありません。" }));
  for (const name of ["role", "aria-busy", "data-busy"]) assert.ok(!(name in plain.props) || plain.props[name] === undefined, name);
});

test("web components: StatusRow の木（div.c-status の中の p.c-note[role=status][data-busy=true]。aria-busy は付けない）と子の key、cancel が無い・オブジェクトでなければボタンが無い", () => {
  const raw = (cancel: unknown): RawNode => cards.StatusRow({ item: { kind: "status", id: "cc", text: "作業中…", cancel }, on: {} }) as RawNode;
  for (const cancel of [null, undefined, true, 3, "x"]) {
    const v = raw(cancel);
    assert.deepEqual([v.type, v.props.class], ["div", "c-status"], String(cancel));
    assert.deepEqual(keysOf(v.props.children), ["text"], String(cancel));
    const el = one(v);
    assert.equal(find(el, "c-btn").length, 0, String(cancel));
    const [p] = kidsOf(el);
    assert.deepEqual([p?.type, p?.props.class, p?.props.role, p?.props["data-busy"], textOf(p as El)], ["p", "c-note", "status", "true", "作業中…"]);
    assert.ok(!("aria-busy" in (p as El).props) || (p as El).props["aria-busy"] === undefined, "状態の行に aria-busy は無い");
  }
  assert.equal(textOf(one(cards.StatusRow({ item: { kind: "status", id: "cc", text: 5, cancel: null }, on: {} }))), "", "文字列でない文は空");
  assert.deepEqual(keysOf((raw({ id: 4, busy: false }) as RawNode).props.children), ["text", "cancel"]);
});

test("web components: StatusRow の［やめる］は ghost・sm・押せない理由なしで、押すと on.cancel(取り消す物の id) を 1 回。busy では輪を出して呼ばない", () => {
  const calls: unknown[][] = [];
  const on = { cancel: (...a: unknown[]): void => void calls.push(["cancel", ...a]) };
  const row = (busy: boolean): El => one(cards.StatusRow({ item: { kind: "status", id: "cc", text: "届け待ちです。入力待ちになったら届けます", cancel: { id: 14, busy } }, on }));
  const idle = row(false);
  assert.deepEqual(btnsOf(idle), [["ghost", "やめる"]]);
  const [b] = find(idle, "c-btn");
  assert.equal(b?.props["data-size"], "sm");
  for (const name of ["aria-disabled", "aria-busy", "title"]) assert.ok(!(name in (b as El).props) || (b as El).props[name] === undefined, name);
  press(b);
  assert.deepEqual(calls, [["cancel", 14]]);
  const busy = row(true);
  const [bb] = find(busy, "c-btn");
  assert.deepEqual([bb?.props["aria-disabled"], bb?.props["aria-busy"], bb?.props.title], ["true", "true", undefined]);
  assert.equal(find(busy, "c-btn-spin").length, 1);
  press(bb);
  assert.deepEqual(calls, [["cancel", 14]], "busy の間は呼ばない");
});

test("web components: Cards は status を status:<id> の key で出し、on を StatusRow へ渡す", () => {
  const calls: unknown[][] = [];
  const on = { ...cardRec().on, cancel: (...a: unknown[]): void => void calls.push(["cancel", ...a]) };
  const items = [{ kind: "status", id: "cc", text: "作業中です。終わったら届けます", cancel: { id: 9, busy: false } }, permItem(), { kind: "note", id: "ended", text: "終わり" }];
  const v = cards.Cards({ items, on }) as RawNode;
  assert.deepEqual(keysOf(v.props.children), ["status:cc", "permission:7", "note:ended"]);
  const root = one(v);
  assert.deepEqual(kidsOf(root).map((k) => k.props.class), ["c-status", "c-card", "c-note"]);
  press(find(kidsOf(root)[0] as El, "c-btn")[0]);
  assert.deepEqual(calls, [["cancel", 9]]);
});

test("web components: カードの言葉は今の画面に在る物（新しいのは「あなたの番: 」の見出しだけ）。カードの CSS の枠・見出し・行・要約の高さ・動きなし。htm の属性で value を渡さない", () => {
  const old = read("chat.js") + read("views.js");
  const words = [
    "このセッションでは常に許可", "答えを送っています", "候補を選ぶと押せます", "Discord でも選べます", "要約", "タスクにする候補", "やることの候補はありません。", "今の場所", "変える先",
    "会話は新しくなり、担当には要点を引き継ぎます。記録はこのまま残ります。ファイルは動かしません。", cards.PERMISSION_NOTE,
    "許可", "拒否", "全部登録", "選んだものを登録", "登録しない", "変える", "このまま", "許可の要求", "閉じる前の確認", "場所を変える確認",
  ];
  for (const w of words) assert.ok(old.includes(w), w);
  const js = stripJsComments(read("c-cards.js"));
  const strings = [...js.matchAll(/"([^"\n]*[^\x00-\x7f][^"\n]*)"/g)].map((m) => m[1] ?? "");
  for (const s of strings) if (!s.startsWith("あなたの番: ")) assert.ok(old.includes(s), s);
  assert.deepEqual(strings.filter((s) => s.startsWith("あなたの番: ")).sort(), ["あなたの番: 場所を変える確認", "あなたの番: 許可", "あなたの番: 閉じる前の確認", "あなたの番: 質問"].sort());
  // CSS
  const rules = parseCss(read("c-cards.css"));
  const decls = (sel: string, inFine = false): string[] =>
    rules.filter((r) => r.selectors.includes(sel) && (inFine ? r.at.some((a) => a.includes(FINE)) : r.at.length === 0)).flatMap((r) => r.body.split(";").map((d) => d.trim()).filter((d) => d !== ""));
  for (const d of ["border: var(--border-width) solid var(--warning)", "border-radius: var(--c-card-r)", "background: var(--surface)", "max-width: var(--c-card-max)"]) assert.ok(decls(".c-card").includes(d), d);
  for (const prop of ["margin", "font-weight", "line-height", "font-size"]) assert.ok(decls(".c-card-title").some((d) => d.startsWith(prop + ":")), prop);
  assert.ok(decls(".c-card-check").includes("min-height: var(--c-tap)"));
  for (const d of ["width: var(--c-check)", "height: var(--c-check)", "accent-color: var(--accent)"]) assert.ok(decls(".c-card-check-input").includes(d), d);
  assert.ok(!decls(".c-card-code").some((d) => d.startsWith("max-height")));
  assert.ok(decls(".c-card-code", true).some((d) => d.startsWith("max-height")));
  for (const r of rules) if (r.body.includes("max-height")) assert.ok(r.at.some((a) => a.includes(FINE)), r.selectors.join(","));
  assert.doesNotMatch(stripCssComments(read("c-cards.css")), /\b(?:animation|transition)(?:-[a-z-]+)?\s*:|@keyframes/);
  assert.doesNotMatch(js, /(?<![\w.-])(?:value|defaultValue)\s*=\s*\$\{/);
  assert.doesNotMatch(js, /(?<![\w.-])(?:value|defaultValue)\s*=\s*["']/);
  assert.doesNotMatch(js, /defaultValue/);
});

// ----- 質問のカードと口 -----
const qCards = (await import(cardsUrl)) as Record<string, Fn> & { OTHER_MAX: number; cardsMouth: unknown; SESSION_QUESTION_NOTE: string };
const qOf = (o: Obj = {}): Obj => ({ legend: "色", text: "どれにしますか", multi: false, options: [{ label: "赤", description: "暖かい" }, { label: "青", description: "" }], picked: [], other: false, otherText: "", ...o });
const qItem = (o: Obj = {}): Obj => ({ kind: "question", id: 9, who: "見本 ・ default（使うたびに確認）", left: "残り 4 分 12 秒", urgent: false, busy: false, ready: false, questions: [qOf()], ...o });
const qCard = (item: Obj, on = cardRec().on, otherRef?: unknown): El => one(html`<${qCards.QuestionCard} item=${item} on=${on} otherRef=${otherRef} />`);
const fieldsetsOf = (item: Obj, otherRef?: unknown): RawNode[] => rawEls(qCards.QuestionCard({ item, on: cardRec().on, otherRef })).filter((v) => v.type === "fieldset");
const kids = (el: El, tag: string): El[] => {
  const all: El[] = [];
  const walk = (t: Tree): void => {
    if (typeof t === "string") return;
    if (t.type === tag) all.push(t);
    t.children.forEach(walk);
  };
  walk(el);
  return all;
};

test("web components: 質問のカードの木と言葉（見出し・who・問ごとの fieldset と key・legend・ヒント・input の type と name・checked・その他の欄・ボタン・説明の文。id 属性が無い）", () => {
  const two = qItem({ questions: [qOf({ picked: ["青"] }), qOf({ legend: "問 2", text: "いくつ", multi: true, options: [{ label: "甲" }, { label: "乙", description: "説明" }], picked: ["甲", "乙"] })] });
  const el = qCard(two);
  assert.deepEqual([el.props["aria-label"], el.props["data-kind"], textOf(find(el, "c-card-title"))], ["質問", "question", "あなたの番: 質問"]);
  assert.equal(textOf(find(el, "c-card-facts")), "見本 ・ default（使うたびに確認）");
  assert.equal(find(qCard(qItem({ who: "" })), "c-card-facts").length, 0);
  // fieldset は問の数だけで key は q0・q1。直下の子の key は全部在って重ならない
  const sets = fieldsetsOf(two);
  assert.deepEqual(sets.map((v) => v.key), ["q0", "q1"]);
  assert.deepEqual(keysOf(sets[0]?.props.children), ["legend", "text", "o0", "o1", "other", "field"]);
  assert.deepEqual(keysOf(sets[1]?.props.children), ["legend", "text", "hint", "o0", "o1", "other", "field"]);
  const fs = kids(el, "fieldset");
  assert.deepEqual(fs.map((f) => f.props.class), ["c-card-q", "c-card-q"]);
  assert.deepEqual(fs.map((f) => [textOf(find(f, "c-card-q-legend")), find(f, "c-card-q-legend")[0]?.type, textOf(find(f, "c-card-q-text"))]), [["色", "legend", "どれにしますか"], ["問 2", "legend", "いくつ"]]);
  assert.deepEqual(fs.map((f) => find(f, "c-card-q-hint").map(textOf)), [[], ["いくつでも選べます"]]);
  // input の type・name・checked
  const inputsOf = (f: El): unknown[][] => find(f, "c-card-check-input").map((i) => [i.props.type, i.props.name, i.props.checked, i.props.disabled]);
  assert.deepEqual(inputsOf(fs[0] as El), [["radio", "ccq-9-0", false, false], ["radio", "ccq-9-0", true, false], ["radio", "ccq-9-0", false, false]]);
  assert.deepEqual(inputsOf(fs[1] as El), [["checkbox", "ccq-9-1", true, false], ["checkbox", "ccq-9-1", true, false], ["checkbox", "ccq-9-1", false, false]]);
  // 選択肢の行の字（名前と説明。説明が空なら span が無い）と「その他」の行
  const rows = find(fs[0] as El, "c-card-check");
  assert.deepEqual(rows.map((r) => [find(r, "c-card-check-label").map(textOf), find(r, "c-card-check-desc").map(textOf)]), [[["赤"], ["暖かい"]], [["青"], []], [["その他"], []]]);
  assert.equal(find(rows[0] as El, "c-card-check-label")[0]?.type, "strong");
  // その他の欄
  const [field] = find(fs[0] as El, "c-card-other");
  assert.deepEqual([field?.type, field?.props.rows, field?.props.maxlength, field?.props["aria-label"], field?.props.hidden, field?.props.disabled], ["textarea", "2", 1000, "その他の答え（色）", true, false]);
  assert.equal(qCards.OTHER_MAX, 1000);
  assert.ok(!("value" in (field as El).props) && !("defaultValue" in (field as El).props));
  // other のときは選択肢が全部 false で「その他」が true、欄は見える
  const other = kids(qCard(qItem({ questions: [qOf({ picked: ["赤"], other: true })] })), "fieldset")[0] as El;
  assert.deepEqual(find(other, "c-card-check-input").map((i) => i.props.checked), [false, false, true]);
  assert.equal(find(other, "c-card-other")[0]?.props.hidden, false);
  // busy は欄も input も disabled
  const busy = kids(qCard(qItem({ busy: true })), "fieldset")[0] as El;
  assert.deepEqual([...find(busy, "c-card-check-input").map((i) => i.props.disabled), find(busy, "c-card-other")[0]?.props.disabled], [true, true, true, true]);
  // ボタンと説明の文
  assert.deepEqual(btnsOf(el), [["primary", "答える"], ["ghost", "やめる"]]);
  for (const b of find(el, "c-btn")) assert.deepEqual([b.props["data-size"], find(b, "c-icon").length], ["md", 0]);
  assert.equal(find(el, "c-card-actions")[0]?.props["data-count"], "2");
  const last = kidsOf(el).at(-1);
  assert.deepEqual([last?.props.class, textOf(last as El)], ["c-card-note", qCards.PERMISSION_NOTE]);
  assert.deepEqual([textOf(find(el, "c-card-meta")), find(el, "c-card-meta")[0]?.props["data-urgent"]], ["残り 4 分 12 秒", "false"]);
  assert.equal(find(qCard(qItem({ urgent: true })), "c-card-meta")[0]?.props["data-urgent"], "true");
  // ボタンの key
  const v = qCards.QuestionCard({ item: two, on: cardRec().on }) as RawNode;
  const actions = rawEls(v).find((n) => n.key === "actions") as RawNode;
  assert.deepEqual(keysOf(actions.props.children), ["answer", "cancel"]);
  // id 属性が無い
  const all = JSON.stringify(expand(v), (k, val) => (typeof val === "function" ? undefined : val));
  assert.doesNotMatch(all, /"id":/);
  // Cards からも出る（key は question:id）
  const list = qCards.Cards({ items: [qItem()], on: cardRec().on }) as RawNode;
  assert.deepEqual(keysOf(list.props.children), ["question:9"]);
});

test("web components: QuestionCard: terminal false の注記は SESSION_QUESTION_NOTE。未指定は PERMISSION_NOTE のまま", () => {
  const noteOf = (el: El): string => textOf(kidsOf(el).at(-1) as El);
  assert.equal(qCards.SESSION_QUESTION_NOTE, "時間切れになったら、答えを発言で送ってください。");
  assert.equal(noteOf(qCard(qItem({ terminal: false }))), qCards.SESSION_QUESTION_NOTE);
  assert.equal(noteOf(qCard(qItem())), qCards.PERMISSION_NOTE);
  assert.equal(noteOf(qCard(qItem({ terminal: true }))), qCards.PERMISSION_NOTE);
});

test("web components: PermissionCard: terminal false の注記は SESSION_PERMISSION_NOTE。未指定は PERMISSION_NOTE のまま", () => {
  const noteOf = (el: El): string => textOf(kidsOf(el).at(-1) as El);
  assert.equal(cards.SESSION_PERMISSION_NOTE, "時間が過ぎると拒否になります。");
  assert.equal(noteOf(cardOf(permItem({ terminal: false }))), cards.SESSION_PERMISSION_NOTE);
  assert.equal(noteOf(cardOf(permItem())), cards.PERMISSION_NOTE);
  assert.equal(noteOf(cardOf(permItem({ terminal: true }))), cards.PERMISSION_NOTE);
});

test("web components: 質問のカードの押せない理由（busy は 2 つとも「答えを送っています」、ready でない間は［答える］だけ「すべての問に答えると押せます」。押せない間は呼ばない）", () => {
  const states = (item: Obj): unknown[][] => {
    const rec = cardRec();
    const btns = find(qCard(item, rec.on), "c-btn");
    for (const b of btns) press(b);
    return [...btns.map((b) => [b.props["aria-disabled"], b.props.title]), rec.calls];
  };
  assert.deepEqual(states(qItem({ ready: true })), [[undefined, undefined], [undefined, undefined], [["answer", 9], ["dismiss", 9]]]);
  assert.deepEqual(states(qItem({ ready: false })), [["true", "すべての問に答えると押せます"], [undefined, undefined], [["dismiss", 9]]]);
  assert.deepEqual(states(qItem({ ready: true, busy: true })), [["true", "答えを送っています"], ["true", "答えを送っています"], []]);
  assert.deepEqual(states(qItem({ ready: false, busy: true })), [["true", "答えを送っています"], ["true", "答えを送っています"], []]);
  const busy = kids(qCard(qItem({ busy: true })), "fieldset")[0] as El;
  for (const row of find(busy, "c-card-check")) assert.equal(row.props.title, "答えを送っています");
});

test("web components: 質問のカードの呼び出し（pick(id, 番号, ラベル, checked)・pickOther(id, 番号, checked, byPointer)・other(id, 番号, 値)。印は「その他」の行の pointerdown で付き、問の中のキーと change の後で外れる。選択肢の行には pointerdown が無い）", () => {
  const rec = cardRec();
  const el = qCard(qItem({ questions: [qOf(), qOf({ multi: true })] }), rec.on);
  const [, second] = kids(el, "fieldset") as El[];
  const rows = find(second as El, "c-card-check");
  const inputs = find(second as El, "c-card-check-input");
  // 偽の要素: 問（fieldset）と、その中の行・印（closest で問を返す）
  const set = {};
  const inside = (o: Obj = {}): Obj => ({ closest: (sel: string) => (sel === "fieldset" ? set : null), ...o });
  const change = (i: El | undefined, checked: boolean): void => (i?.props.onChange as (e: unknown) => void)({ currentTarget: inside({ checked }) });
  const down = (r: El): void => (r.props.onPointerDown as (e: unknown) => void)({ currentTarget: inside() });
  const key = (): void => ((second as El).props.onKeyDown as (e: unknown) => void)({ currentTarget: set });
  change(inputs[0], true);
  change(inputs[1], false);
  for (const r of rows) assert.equal(r.props.onKeyDown, undefined);
  for (const r of rows.slice(0, 2)) assert.equal(r.props.onPointerDown, undefined);
  const otherRow = rows[2] as El;
  const otherInput = inputs[2];
  down(otherRow);
  change(otherInput, true);
  change(otherInput, false);
  down(otherRow);
  key();
  change(otherInput, true);
  (find(second as El, "c-card-other")[0]?.props.onInput as (e: unknown) => void)({ currentTarget: { value: "別の案" } });
  assert.deepEqual(rec.calls, [
    ["pick", 9, 1, "赤", true],
    ["pick", 9, 1, "青", false],
    ["pickOther", 9, 1, true, true],
    ["pickOther", 9, 1, false, false],
    ["pickOther", 9, 1, true, false],
    ["other", 9, 1, "別の案"],
  ]);
});

test("web components: 「その他」を指で押した印は、押し始めと change の間に描き直しても残る（問の要素に付けて覚える。別の問には移らない）", () => {
  const rec = cardRec();
  const item = qItem({ questions: [qOf(), qOf()] });
  const draw = (): El[] => kids(qCard(item, rec.on), "fieldset");
  const sets = [{}, {}];
  const inside = (n: number, o: Obj = {}): Obj => ({ closest: () => sets[n], ...o });
  const otherRow = (els: El[], n: number): El => find(els[n] as El, "c-card-check")[2] as El;
  const otherInput = (els: El[], n: number): El => find(els[n] as El, "c-card-check-input")[2] as El;
  (otherRow(draw(), 0).props.onPointerDown as (e: unknown) => void)({ currentTarget: inside(0) });
  // 描き直した後の木の change に届く
  const again = draw();
  (otherInput(again, 1).props.onChange as (e: unknown) => void)({ currentTarget: inside(1, { checked: true }) });
  (otherInput(again, 0).props.onChange as (e: unknown) => void)({ currentTarget: inside(0, { checked: true }) });
  assert.deepEqual(rec.calls, [
    ["pickOther", 9, 1, true, false],
    ["pickOther", 9, 0, true, true],
  ]);
});

test("web components: otherRef は Cards → 質問のカード → 「その他」の欄の ref へ (id, 問の番号) で届く。無ければ ref を付けない", () => {
  const seen: unknown[][] = [];
  const refs = new Map<string, () => void>();
  const otherRef = (id: unknown, index: number): (() => void) => {
    seen.push([id, index]);
    const k = id + ":" + index;
    if (!refs.has(k)) refs.set(k, () => {});
    return refs.get(k) as () => void;
  };
  const item = qItem({ questions: [qOf(), qOf()] });
  // Cards から 1 段ずつ開く（html の木は ref を props に残さないので、生の vnode で見る）
  const cardsNode = qCards.Cards({ items: [item], on: cardRec().on, otherRef }) as RawNode;
  const cardNode = rawEls(cardsNode).find((v) => v.type === qCards.QuestionCard) as RawNode;
  assert.equal(cardNode.props.otherRef, otherRef);
  const fields = (ref?: unknown): RawNode[] => rawEls(qCards.QuestionCard({ item, on: cardRec().on, otherRef: ref })).filter((v) => v.type === "textarea");
  assert.deepEqual(fields(otherRef).map((f) => f.ref ?? f.props.ref), [refs.get("9:0"), refs.get("9:1")]);
  assert.deepEqual(seen, [[9, 0], [9, 1]]);
  assert.deepEqual(fields().map((f) => f.ref ?? f.props.ref), [undefined, undefined]);
});

type CardsMouth = { draw: (root: unknown, state: Obj) => void; focus: (root: unknown, id: unknown, index: number) => boolean; drop: (root: unknown) => void };
type FakeField = { value: string; hidden: boolean; focused: number; focus: () => void };
const fakeField = (hidden = false): FakeField => {
  const el: FakeField = { value: "", hidden, focused: 0, focus: () => void el.focused++ };
  return el;
};
/**
 * 偽の render（描くたびに、質問の項目の問ごとに otherRef(id, 番号) の ref に今の要素を渡す。同じ要素でも渡し直す（口が同じ要素に書かない事を見るため）。
 * 要素か ref が替わった・鍵が消えたら前の ref に null を先に渡す。null の vnode では全部に null を渡す）
 */
function fakeCardsMouth(): { mouth: CardsMouth; calls: { vnode: VNode | null; root: unknown }[]; els: Map<string, FakeField>; fail: (v: boolean) => void } {
  const calls: { vnode: VNode | null; root: unknown }[] = [];
  const els = new Map<string, FakeField>();
  const given = new Map<string, { el: FakeField; ref: (n: unknown) => void }>();
  let throws = false;
  const render = (vnode: VNode | null, root: unknown): void => {
    calls.push({ vnode, root });
    if (throws) throw new Error("render");
    const seen = new Set<string>();
    if (vnode !== null) {
      const otherRef = vnode.props.otherRef as (id: unknown, i: number) => (n: unknown) => void;
      for (const item of vnode.props.items as Obj[]) {
        if (item.kind !== "question") continue;
        (item.questions as Obj[]).forEach((_, i) => {
          const key = String(item.id) + ":" + i;
          seen.add(key);
          let el = els.get(key);
          if (el === undefined) els.set(key, (el = fakeField()));
          const ref = otherRef(item.id, i);
          const was = given.get(key);
          if (was && (was.el !== el || was.ref !== ref)) was.ref(null);
          ref(el);
          given.set(key, { el, ref });
        });
      }
    }
    for (const [key, was] of [...given]) {
      if (seen.has(key)) continue;
      was.ref(null);
      given.delete(key);
    }
  };
  const mouth = (qCards.cardsMouth as (r: typeof render) => CardsMouth)(render);
  return { mouth, calls, els, fail: (v) => void (throws = v) };
}
const refOf = (call: { vnode: VNode | null } | undefined, id: unknown, i: number): unknown => (call?.vnode?.props.otherRef as (id: unknown, i: number) => unknown)(id, i);

test("web components: cardsMouth の draw は Cards に items・on を渡し、新しい要素にだけ otherText を 1 回入れ、同じ要素には書かない。ref は鍵ごとに同じ関数", () => {
  const { mouth, calls, els } = fakeCardsMouth();
  const root = {};
  const on = cardRec().on;
  const items = [qItem({ questions: [qOf({ otherText: "一" }), qOf({ otherText: "二" })] })];
  mouth.draw(root, { items, on });
  assert.equal(calls.length, 1);
  assert.deepEqual([calls[0]?.vnode?.type, calls[0]?.vnode?.props.items, calls[0]?.vnode?.props.on, calls[0]?.root], [qCards.Cards, items, on, root]);
  assert.deepEqual([els.get("9:0")?.value, els.get("9:1")?.value], ["一", "二"]);
  // 打鍵のつもり
  (els.get("9:0") as FakeField).value = "一と";
  mouth.draw(root, { items: [qItem({ questions: [qOf({ otherText: "zzz" }), qOf({ otherText: "二" })] })], on });
  assert.equal(els.get("9:0")?.value, "一と");
  assert.equal(refOf(calls[1], 9, 0), refOf(calls[0], 9, 0));
  assert.notEqual(refOf(calls[0], 9, 0), refOf(calls[0], 9, 1));
  // 要素が替わればその時の otherText
  els.set("9:0", fakeField());
  mouth.draw(root, { items: [qItem({ questions: [qOf({ otherText: "三" }), qOf()] })], on });
  assert.equal(els.get("9:0")?.value, "三");
  // 項目が消えて戻れば新しい関数
  const before = refOf(calls[2], 9, 0);
  mouth.draw(root, { items: [], on });
  els.delete("9:0");
  mouth.draw(root, { items: [qItem({ questions: [qOf({ otherText: "四" })] })], on });
  assert.notEqual(refOf(calls[4], 9, 0), before);
  assert.equal(els.get("9:0")?.value, "四");
  // 根ごとに別の覚え
  mouth.draw({}, { items: [qItem()], on });
  assert.notEqual(refOf(calls[5], 9, 0), refOf(calls[4], 9, 0));
});

test("web components: cardsMouth の focus は鍵が無い・要素が無い・hidden で false、見えていれば focus を 1 回呼んで true。drop は render(null, root) で、その後の focus は false。render の例外はそのまま出る", () => {
  const { mouth, calls, els, fail } = fakeCardsMouth();
  const root = {};
  const on = cardRec().on;
  assert.equal(mouth.focus(root, 9, 0), false);
  els.set("9:0", fakeField(true));
  mouth.draw(root, { items: [qItem()], on });
  assert.equal(mouth.focus(root, 9, 1), false);
  assert.equal(mouth.focus(root, 9, 0), false);
  (els.get("9:0") as FakeField).hidden = false;
  assert.equal(mouth.focus(root, 9, 0), true);
  assert.equal(els.get("9:0")?.focused, 1);
  // 要素が外れた後は false
  (refOf(calls[0], 9, 0) as (n: unknown) => void)(null);
  assert.equal(mouth.focus(root, 9, 0), false);
  mouth.draw(root, { items: [qItem()], on });
  assert.equal(mouth.focus(root, 9, 0), true);
  mouth.drop(root);
  assert.deepEqual([calls.at(-1)?.vnode, calls.at(-1)?.root], [null, root]);
  assert.equal(mouth.focus(root, 9, 0), false);
  fail(true);
  assert.throws(() => mouth.draw(root, { items: [qItem()], on }), /render/);
});

test("web components: c-cards.js の .value の代入は口の 1 か所だけで、htm の属性で value・defaultValue を渡さない。「その他」の欄は線の色と字の大きさを自分で持ち、fieldset の既定の枠と余白を外す", () => {
  const js = stripJsComments(read("c-cards.js"));
  assert.equal((js.match(/\.value\s*=(?!=)/g) ?? []).length, 1);
  assert.doesNotMatch(js, /(?<![\w.-])(?:value|defaultValue)\s*=\s*\$\{/);
  assert.doesNotMatch(js, /(?<![\w.-])(?:value|defaultValue)\s*=\s*["']/);
  assert.doesNotMatch(js, /defaultValue/);
  const rules = parseCss(read("c-cards.css"));
  const decls = (sel: string): string[] =>
    rules.filter((r) => r.at.length === 0 && r.selectors.length === 1 && r.selectors[0] === sel).flatMap((r) => r.body.split(";").map((d) => d.trim()).filter((d) => d !== ""));
  for (const d of ["caret-color: var(--accent)", "font-size: var(--c-font-body)"]) assert.ok(decls(".c-card-other").includes(d), d);
  for (const d of ["border: 0", "padding: 0", "margin: 0", "min-width: 0"]) assert.ok(decls(".c-card-q").includes(d), d);
});

// ===== 許可のモード（プロジェクトのセッション。見出しの帯のボタン） =====

const MODE_BUSY_TEXT = "担当が作業中です。終わってから変えてください";

test("web components: topModel: 広い幅は mode を返し、スマホ・compact・view other は null", () => {
  const mode = { value: "plan", disabled: false, reason: null };
  assert.deepEqual(shell.topModel(topProps({ variant: "wide", mode }))?.mode, { text: "plan", label: "許可のモード: plan", disabled: false, reason: null });
  for (const value of ["default", "acceptEdits"]) {
    assert.deepEqual(shell.topModel(topProps({ variant: "wide", mode: { value } }))?.mode, { text: value, label: "許可のモード: " + value, disabled: false, reason: null }, value);
  }
  // 押せないときだけ reason（空なら null）。押せるときは reason を出さない
  assert.deepEqual(shell.topModel(topProps({ variant: "wide", mode: { value: "default", disabled: true, reason: MODE_BUSY_TEXT } }))?.mode, {
    text: "default",
    label: "許可のモード: default",
    disabled: true,
    reason: MODE_BUSY_TEXT,
  });
  assert.equal((shell.topModel(topProps({ variant: "wide", mode: { value: "default", disabled: true, reason: "" } }))?.mode as Obj).reason, null);
  assert.equal((shell.topModel(topProps({ variant: "wide", mode: { value: "default", disabled: false, reason: MODE_BUSY_TEXT } }))?.mode as Obj).reason, null);
  // true のときだけ押せない
  assert.equal((shell.topModel(topProps({ variant: "wide", mode: { value: "plan", disabled: "true" } }))?.mode as Obj).disabled, false);
  // スマホ・compact・other は帯にも補足にも出さない
  assert.equal(shell.topModel(topProps({ mode }))?.mode, null);
  assert.equal(shell.topModel(topProps({ mode }))?.rest, "場所: General");
  assert.equal(shell.topModel(topProps({ variant: "wide", compact: true, mode }))?.mode, null);
  assert.equal(shell.topModel(topProps({ variant: "wide", compact: true, mode }))?.rest, "場所: General");
  assert.equal(shell.topModel(topProps({ variant: "wide", view: "other", mode }))?.mode, null);
  assert.equal(shell.topModel(topProps({ variant: "wide", mode: null }))?.mode, null);
  assert.equal(shell.topModel(topProps({ variant: "wide" }))?.mode, null);
});

test("web components: ★ topModel: 3 つ以外の value は null", () => {
  for (const value of ["bypassPermissions", "dontAsk", "auto", "PLAN", "", null, undefined, 3]) {
    assert.equal(shell.topModel(topProps({ variant: "wide", mode: { value, disabled: false } }))?.mode, null, String(value));
  }
  for (const mode of ["plan", {}, 1]) assert.equal(shell.topModel(topProps({ variant: "wide", mode }))?.mode, null, JSON.stringify(mode));
});

test("web components: TopBar: 押せない mode は aria-disabled と title に理由", () => {
  const calls: unknown[][] = [];
  const on = { ...topRec().on, mode: (...a: unknown[]) => void calls.push(["mode", ...a]) };
  const props = topProps({ variant: "wide", mode: { value: "default", disabled: true, reason: MODE_BUSY_TEXT } });
  const v = shell.TopBar({ ...props, on }) as VNode;
  // 場所のボタンのすぐ後ろ、gap の前
  assert.deepEqual(keysOf(v.props.children), ["text", "status", "place", "mode", "gap", "menu"]);
  const bar = one(v);
  const btn = find(bar, "c-top-mode")[0] as El;
  assert.deepEqual(
    [btn.type, btn.props.type, btn.props["data-act"], btn.props["aria-haspopup"], "disabled" in btn.props, btn.props.title, btn.props["aria-disabled"], btn.props["aria-label"]],
    ["button", "button", "mode", "dialog", false, MODE_BUSY_TEXT, "true", "許可のモード: default"],
  );
  assert.equal(textOf(find(btn, "c-top-mode-text")), "default");
  const chevron = find(btn, "c-icon")[0] as El;
  assert.deepEqual([chevron.props["data-size"], String((chevron.children[0] as El).props.href).endsWith("#chevron-down")], ["sm", true]);
  // 押せないときは押しても on.mode を呼ばない
  const pe = fakeEvent();
  (btn.props.onClick as (e: unknown) => void)(pe);
  assert.equal(pe.count(), 1);
  assert.deepEqual(calls, []);
  // 押せるときは aria-disabled なし・title は「許可のモードを変える」・押すと opener を渡す
  const ok = find(one(html`<${shell.TopBar} ...${topProps({ variant: "wide", mode: { value: "plan" } })} on=${on} />`), "c-top-mode")[0] as El;
  assert.deepEqual([ok.props["aria-disabled"], ok.props.title, ok.props["aria-label"]], [undefined, "許可のモードを変える", "許可のモード: plan"]);
  const x = { scrollIntoView: () => undefined };
  (ok.props.onClick as (e: unknown) => void)({ currentTarget: x });
  assert.deepEqual(calls, [["mode", x]]);
  // スマホには出さない
  assert.equal(find(one(html`<${shell.TopBar} ...${topProps({ mode: { value: "plan" } })} on=${on} />`), "c-top-mode").length, 0);
});

test("web components: ★ MODE_LABELS（サーバー）と views.js の PERMISSION_MODES と shell.js の MODE_ROWS の 3 つの文が同じ", async () => {
  const { MODE_LABELS } = await import("../src/app/session-mode.ts");
  const server = Object.entries(MODE_LABELS);
  assert.deepEqual(server.map(([id]) => id), ["default", "acceptEdits", "plan"]);
  // views.js の PERMISSION_MODES（ほかのモードの文も持つ。3 つは同じ字）
  const views = readFileSync(join(STATIC_DIR, "views.js"), "utf8");
  const block = views.match(/const PERMISSION_MODES = \{([\s\S]*?)\};/)?.[1];
  assert.ok(block !== undefined);
  const viewTexts = Object.fromEntries([...block.matchAll(/(\w+): "([^"]*)"/g)].map((m) => [m[1], m[2]]));
  // shell.js の MODE_ROWS（順も同じ）
  const shellJs = readFileSync(join(STATIC_DIR, "shell.js"), "utf8");
  const rows = shellJs.match(/const MODE_ROWS = \[([\s\S]*?)\n {2}\];/)?.[1];
  assert.ok(rows !== undefined);
  const shellRows = [...rows.matchAll(/\["(\w+)", "([^"]*)"\]/g)].map((m) => [m[1], m[2]]);
  assert.deepEqual(shellRows, server);
  for (const [id, text] of server) assert.equal(viewTexts[id], text, id);
});

// 端末のセッションの札（c-term.js）
const termUrl = new URL("../src/web/static/c-term.js", import.meta.url).href;
const term = (await import(termUrl)) as Record<string, Fn> & { TERM_TEXT: Record<string, string>; termView: (raw: Obj) => Obj };
const TERM_READY = { takeable: true, state: "idle", reason: null, text: null, rcUrl: "https://claude.ai/code/demo" };
const termRaw = (o: Obj = {}): Obj => ({
  title: "ログインの直し",
  place: "self-agent",
  rowState: "idle",
  activity: "11/20(金) 14:05",
  pane: true,
  check: null,
  checking: false,
  failed: false,
  phase: "idle",
  error: null,
  ...o,
});
function termRec(): { calls: string[]; on: { take: () => void; pane: () => void; recheck: () => void } } {
  const calls: string[] = [];
  return { calls, on: { take: () => void calls.push("take"), pane: () => void calls.push("pane"), recheck: () => void calls.push("recheck") } };
}
const termCard = (raw: Obj, on = termRec().on): El => one(html`<${term.TermCard} ...${term.termView(raw)} on=${on} />`);
const termBtns = (el: El): unknown[][] => find(el, "c-btn").map((b) => [b.props["data-kind"], b.props["data-size"], textOf(b)]);

test("web components: TermCard は section.c-term に題・事実の行・説明・状態の文・ボタンを決めた順で出す", () => {
  const el = termCard(termRaw({ check: TERM_READY, error: "取り込めませんでした: 書きかけ" }));
  assert.deepEqual([el.type, el.props.class, el.props["aria-label"], el.props["data-kind"]], ["section", "c-term", "端末のセッション", "ready"]);
  assert.deepEqual(kidsOf(el).map((k) => [k.type, k.props.class]), [["h2", "c-term-title"], ["dl", "c-term-dl"], ["p", "c-term-lead"], ["p", "c-term-note"], ["div", "c-term-actions"]]);
  assert.equal(textOf(find(el, "c-term-title")), "ログインの直し");
  const rows = find(el, "c-term-row");
  assert.deepEqual(rows.map((r) => [r.type, ...kidsOf(r).map((k) => `${k.type}.${String(k.props.class)}`)]), [["div", "dt.c-term-dt", "dd.c-term-dd"], ["div", "dt.c-term-dt", "dd.c-term-dd"], ["div", "dt.c-term-dt", "dd.c-term-dd"]]);
  assert.deepEqual(rows.map((r) => [textOf(find(r, "c-term-dt")), textOf(find(r, "c-term-dd"))]), [["場所", "self-agent"], ["状態", "待機"], ["最後の活動", "11/20(金) 14:05"]]);
  assert.deepEqual(rows.map((r) => find(r, "c-term-dd")[0]?.props["data-tone"]), [undefined, "muted", undefined]);
  assert.equal(textOf(find(el, "c-term-lead")), "取り込むと、端末の Claude Code を終わらせて、続きを新しい話題で引き継ぎます。");
  assert.equal(textOf(find(el, "c-term-note")), "取り込めませんでした: 書きかけ");
  const actions = find(el, "c-term-actions")[0] as El;
  assert.deepEqual(kidsOf(actions).map((k) => [k.type, k.props.class]), [["button", "c-btn"], ["button", "c-btn"], ["a", "c-term-link"]]);
  assert.deepEqual(termBtns(el), [["primary", "md", "取り込む"], ["ghost", "md", "端末を見る"]]);
  const link = find(el, "c-term-link")[0] as El;
  assert.deepEqual([link.props.href, link.props.target, link.props.rel, textOf(link)], ["https://claude.ai/code/demo", "_blank", "noreferrer noopener", "RC で開く"]);
  // 場所が無ければ「不明」
  assert.equal(textOf(find(termCard(termRaw({ place: null, check: TERM_READY })), "c-term-dd")[0] as El), "不明");
  // 押すと on の物を呼ぶ
  const { calls, on } = termRec();
  const blocked = termCard(termRaw({ check: { takeable: false, state: "idle", reason: "not_in_tmux", text: "外", rcUrl: null } }), on);
  assert.deepEqual(termBtns(blocked), [["primary", "md", "取り込む"], ["secondary", "md", "確かめ直す"], ["ghost", "md", "端末を見る"]]);
  for (const b of find(blocked, "c-btn")) press(b);
  press(find(termCard(termRaw({ check: TERM_READY }), on), "c-btn")[0]);
  assert.deepEqual(calls, ["recheck", "pane", "take"]);
});

test("web components: termView は取り込める（待機・終わった）・実行中・判断待ち・理由つきの 4 つを kind と文に分ける", () => {
  const view = (o: Obj): Obj => term.termView(termRaw(o));
  const ready = view({ check: TERM_READY });
  assert.deepEqual([ready.kind, ready.state, ready.lead, ready.note, ready.take, ready.recheck, ready.rcUrl], [
    "ready", { text: "待機", tone: "muted" }, "取り込むと、端末の Claude Code を終わらせて、続きを新しい話題で引き継ぎます。", null, { disabled: false, busy: false, reason: null }, false, "https://claude.ai/code/demo",
  ]);
  assert.deepEqual(ready.when, { label: "最後の活動", text: "11/20(金) 14:05" });
  const ended = view({ rowState: null, pane: false, activity: "11/20(金) 13:40", check: { takeable: true, state: "ended", reason: null, text: null, rcUrl: null } });
  assert.deepEqual([ended.kind, ended.state, ended.when, ended.lead, ended.pane, ended.rcUrl], [
    "ready", { text: "終わりました", tone: "muted" }, { label: "終わった時刻", text: "11/20(金) 13:40" }, "端末の Claude Code は終わっています。取り込むと、続きを新しい話題で引き継ぎます。", null, null,
  ]);
  const busy = view({ rowState: "running", check: { takeable: false, state: "running", reason: "busy", text: "実行中です。終わると取り込めます", rcUrl: null } });
  assert.deepEqual([busy.kind, busy.state, busy.lead, busy.note, busy.take, busy.recheck], [
    "busy", { text: "実行中", tone: "accent" }, null, { text: "実行中です。終わると取り込めます", tone: "plain", busy: false }, { disabled: true, busy: false, reason: "実行中です。終わると取り込めます" }, false,
  ]);
  const waiting = view({ rowState: "waiting", check: { takeable: false, state: "waiting", reason: "waiting", text: "判断待ちです。端末か RC で答えると取り込めます", rcUrl: null } });
  assert.deepEqual([waiting.kind, waiting.state, waiting.note, waiting.recheck], ["waiting", { text: "判断待ち", tone: "warning" }, { text: "判断待ちです。端末か RC で答えると取り込めます", tone: "plain", busy: false }, false]);
  const blocked = view({ check: { takeable: false, state: "idle", reason: "not_in_tmux", text: "このセッションは外から終わらせません。終わらせてから取り込めます", rcUrl: null } });
  assert.deepEqual([blocked.kind, blocked.note, blocked.take, blocked.recheck], [
    "blocked", { text: "このセッションは外から終わらせません。終わらせてから取り込めます", tone: "plain", busy: false }, { disabled: true, busy: false, reason: "このセッションは外から終わらせません。終わらせてから取り込めます" }, true,
  ]);
  // 理由の文が無ければ「今は取り込めません」。状態が知らない物は「不明」
  const bare = view({ rowState: null, check: { takeable: false, state: "unknown", reason: "gone", text: null, rcUrl: null } });
  assert.deepEqual([bare.kind, bare.state, bare.note], ["blocked", { text: "不明", tone: "muted" }, { text: "今は取り込めません", tone: "plain", busy: false }]);
  // 読めなかった（failed）は blocked・確かめ直す
  const failed = view({ failed: true });
  assert.deepEqual([failed.kind, failed.note, failed.recheck, failed.rcUrl], ["blocked", { text: "取り込めるか確かめられませんでした。", tone: "error", busy: false }, true, null]);
});

test("web components: termView は確かめている間・取り込みの途中・結果が分からない間は［取り込む］を押せなくする", () => {
  const view = (o: Obj): Obj => term.termView(termRaw(o));
  const first = view({});
  assert.deepEqual([first.kind, first.note, first.take, first.lead], ["checking", { text: "取り込めるか確かめています…", tone: "plain", busy: true }, { disabled: true, busy: false, reason: "取り込めるか確かめています…" }, null]);
  const again = view({ check: TERM_READY, checking: true });
  assert.deepEqual([again.kind, again.take], ["checking", { disabled: true, busy: false, reason: "取り込めるか確かめています…" }]);
  const proposing = view({ check: TERM_READY, phase: "proposing" });
  assert.deepEqual([proposing.kind, proposing.take], ["ready", { disabled: true, busy: true, reason: null }]);
  const asking = view({ check: TERM_READY, phase: "asking" });
  assert.deepEqual([asking.kind, asking.take], ["ready", { disabled: true, busy: false, reason: null }]);
  const taking = view({ check: TERM_READY, phase: "taking" });
  assert.deepEqual([taking.kind, taking.note, taking.take, taking.pane, taking.lead, taking.recheck], [
    "taking", { text: "取り込んでいます…", tone: "plain", busy: true }, { disabled: true, busy: true, reason: "取り込んでいます…" }, { disabled: true, reason: "取り込んでいます…" }, null, false,
  ]);
  const lost = view({ check: TERM_READY, phase: "lost" });
  assert.deepEqual([lost.kind, lost.note, lost.take, lost.pane, lost.recheck], [
    "lost", { text: "結果を確かめられませんでした。取り込みは続いているかもしれません。", tone: "error", busy: false }, { disabled: true, busy: false, reason: "結果を確かめられませんでした。取り込みは続いているかもしれません。" }, { disabled: false, reason: null }, true,
  ]);
  // 途中の形は失敗の文より先
  assert.equal((view({ check: TERM_READY, phase: "taking", error: "失敗" }).note as Obj).text, "取り込んでいます…");
  assert.equal((view({ check: TERM_READY, phase: "lost", error: "失敗" }).note as Obj).text, "結果を確かめられませんでした。取り込みは続いているかもしれません。");
});

test("web components: termView は確かめ直している間、状態を一覧の行から出す", () => {
  const view = (o: Obj): Obj => term.termView(termRaw(o));
  assert.deepEqual(view({ rowState: "running", check: TERM_READY, checking: true }).state, { text: "実行中", tone: "accent" });
  assert.deepEqual(view({ rowState: "running", check: TERM_READY }).state, { text: "待機", tone: "muted" });
  // 行が無ければ前の判定の状態、それも無ければ不明
  assert.deepEqual(view({ rowState: null, check: { ...TERM_READY, state: "ended" }, checking: true }).state, { text: "終わりました", tone: "muted" });
  assert.deepEqual(view({ rowState: null, checking: true }).state, { text: "不明", tone: "muted" });
  // 時刻の見出しも出す状態に合わせる
  assert.deepEqual(view({ rowState: "idle", check: { ...TERM_READY, state: "ended" }, checking: true }).when, { label: "最後の活動", text: "11/20(金) 14:05" });
});

test("web components: termView の失敗の文は理由の文・確かめている文より先に出る", () => {
  const view = (o: Obj): Obj => term.termView(termRaw(o));
  const err = "取り込めませんでした: 端末の画面が待機の状態ではありません（書きかけ・ダイアログ・操作の直後）";
  const ready = view({ check: TERM_READY, error: err });
  assert.deepEqual([ready.kind, ready.note, ready.take], ["ready", { text: err, tone: "error", busy: false }, { disabled: false, busy: false, reason: null }]);
  const busy = view({ check: { takeable: false, state: "running", reason: "busy", text: "実行中です。終わると取り込めます", rcUrl: null }, error: err });
  // 下の文は直前の失敗の文、［取り込む］の理由は今の理由
  assert.deepEqual([busy.note, busy.take], [{ text: err, tone: "error", busy: false }, { disabled: true, busy: false, reason: "実行中です。終わると取り込めます" }]);
  const checking = view({ checking: true, error: err });
  assert.deepEqual([checking.note, checking.take], [{ text: err, tone: "error", busy: false }, { disabled: true, busy: false, reason: "取り込めるか確かめています…" }]);
  const failed = view({ failed: true, error: err });
  assert.deepEqual([failed.note, failed.take], [{ text: err, tone: "error", busy: false }, { disabled: true, busy: false, reason: "取り込めるか確かめられませんでした。" }]);
  const blocked = view({ check: { takeable: false, state: "idle", reason: "not_in_tmux", text: null, rcUrl: null }, error: err });
  assert.deepEqual([blocked.note, blocked.take], [{ text: err, tone: "error", busy: false }, { disabled: true, busy: false, reason: "今は取り込めません" }]);
  const waiting = view({ check: { takeable: false, state: "waiting", reason: "waiting", text: "判断待ちです", rcUrl: null }, error: err });
  assert.deepEqual([waiting.note, waiting.take], [{ text: err, tone: "error", busy: false }, { disabled: true, busy: false, reason: "判断待ちです" }]);
  // lost・taking は失敗の文より途中の形が先で、理由も途中の形
  assert.equal((view({ check: TERM_READY, phase: "lost", error: err }).take as Obj).reason, "結果を確かめられませんでした。取り込みは続いているかもしれません。");
  assert.equal((view({ check: TERM_READY, phase: "taking", error: err }).take as Obj).reason, "取り込んでいます…");
});

test("web components: TermCard は押せない［取り込む］に理由を付け、押しても on.take を呼ばない", () => {
  const cases: [Obj, string, string | undefined][] = [
    [{}, "取り込めるか確かめています…", undefined],
    [{ check: { takeable: false, state: "running", reason: "busy", text: "実行中です。終わると取り込めます", rcUrl: null } }, "実行中です。終わると取り込めます", undefined],
    [{ check: TERM_READY, phase: "taking" }, "取り込んでいます…", "true"],
    [{ check: TERM_READY, phase: "lost" }, "結果を確かめられませんでした。取り込みは続いているかもしれません。", undefined],
  ];
  for (const [o, reason, busy] of cases) {
    const { calls, on } = termRec();
    const take = find(termCard(termRaw(o), on), "c-btn")[0] as El;
    assert.deepEqual([textOf(take), take.props["aria-disabled"], take.props.title, take.props["aria-busy"]], ["取り込む", "true", reason, busy], JSON.stringify(o));
    const ev = fakeEvent();
    (take.props.onClick as (e: unknown) => void)(ev);
    assert.deepEqual([calls, ev.count()], [[], 1], JSON.stringify(o));
  }
  // 確認を作っている間・訊いている間は理由なしで押せない
  for (const phase of ["proposing", "asking"]) {
    const { calls, on } = termRec();
    const take = find(termCard(termRaw({ check: TERM_READY, phase }), on), "c-btn")[0] as El;
    assert.deepEqual([take.props["aria-disabled"], take.props.title], ["true", undefined], phase);
    press(take);
    assert.deepEqual(calls, [], phase);
  }
  // 取り込みの途中は［端末を見る］も押せない
  const { calls, on } = termRec();
  const pane = find(termCard(termRaw({ check: TERM_READY, phase: "taking" }), on), "c-btn")[1] as El;
  assert.deepEqual([textOf(pane), pane.props["aria-disabled"], pane.props.title], ["端末を見る", "true", "取り込んでいます…"]);
  press(pane);
  assert.deepEqual(calls, []);
});

test("web components: TermCard は rcUrl が無ければリンクを出さず、pane が無ければ［端末を見る］を出さず、時刻が無ければその行を出さない", () => {
  const el = termCard(termRaw({ pane: false, activity: null, check: { ...TERM_READY, rcUrl: null } }));
  assert.equal(find(el, "c-term-link").length, 0);
  assert.deepEqual(termBtns(el), [["primary", "md", "取り込む"]]);
  assert.deepEqual(find(el, "c-term-dt").map(textOf), ["場所", "状態"]);
  const v = term.termView(termRaw({ activity: null }));
  assert.equal(v.when, null);
  // 説明の文・下の文が無ければ p を出さない
  const quiet = termCard(termRaw({ check: TERM_READY }));
  assert.deepEqual([find(quiet, "c-term-lead").length, find(quiet, "c-term-note").length], [1, 0]);
  const busy = termCard(termRaw({ check: { takeable: false, state: "running", reason: "busy", text: "実行中です。終わると取り込めます", rcUrl: null } }));
  assert.deepEqual([find(busy, "c-term-lead").length, find(busy, "c-term-note").length], [0, 1]);
});

test("web components: TermCard の失敗の文は role alert、ほかの文は role status", () => {
  const noteOf = (o: Obj): El => find(termCard(termRaw(o)), "c-term-note")[0] as El;
  const attrs = (el: El): unknown[] => [el.props.role, el.props["data-tone"], el.props["data-busy"]];
  assert.deepEqual(attrs(noteOf({ check: TERM_READY, error: "取り込めませんでした: x" })), ["alert", "error", undefined]);
  assert.deepEqual(attrs(noteOf({ failed: true })), ["alert", "error", undefined]);
  assert.deepEqual(attrs(noteOf({ check: TERM_READY, phase: "lost" })), ["alert", "error", undefined]);
  assert.deepEqual(attrs(noteOf({})), ["status", "plain", "true"]);
  assert.deepEqual(attrs(noteOf({ check: TERM_READY, phase: "taking" })), ["status", "plain", "true"]);
  assert.deepEqual(attrs(noteOf({ check: { takeable: false, state: "waiting", reason: "waiting", text: "判断待ちです", rcUrl: null } })), ["status", "plain", undefined]);
});

test("web components: 札の決めた文（TERM_TEXT）", () => {
  assert.deepEqual(term.TERM_TEXT, {
    label: "端末のセッション",
    place: "場所",
    state: "状態",
    activity: "最後の活動",
    endedAt: "終わった時刻",
    noPlace: "不明",
    idle: "待機",
    running: "実行中",
    waiting: "判断待ち",
    ended: "終わりました",
    unknown: "不明",
    lead: "取り込むと、端末の Claude Code を終わらせて、続きを新しい話題で引き継ぎます。",
    leadEnded: "端末の Claude Code は終わっています。取り込むと、続きを新しい話題で引き継ぎます。",
    checking: "取り込めるか確かめています…",
    checkFailed: "取り込めるか確かめられませんでした。",
    taking: "取り込んでいます…",
    lost: "結果を確かめられませんでした。取り込みは続いているかもしれません。",
    blocked: "今は取り込めません",
    take: "取り込む",
    recheck: "確かめ直す",
    pane: "端末を見る",
    rc: "RC で開く",
  });
  assert.equal(Object.keys(term.TERM_TEXT).length, 22);
  assert.ok(Object.isFrozen(term.TERM_TEXT));
});

test("web components: termView の状態は idle・running・waiting・ended・unknown だけで、needs_input は判断待ち、ほかの値は不明", () => {
  const view = (o: Obj): Obj => term.termView(termRaw(o));
  assert.deepEqual(view({ rowState: "needs_input", checking: true }).state, { text: "判断待ち", tone: "warning" });
  assert.deepEqual(view({ check: { ...TERM_READY, state: "needs_input" } }).state, { text: "判断待ち", tone: "warning" });
  for (const state of [undefined, "take", "label", "lead", "constructor", "toString", 3, null]) {
    assert.deepEqual(view({ check: { ...TERM_READY, state } }).state, { text: "不明", tone: "muted" }, String(state));
    assert.deepEqual(view({ rowState: state, checking: true }).state, { text: "不明", tone: "muted" }, String(state));
  }
  for (const state of ["idle", "running", "waiting", "ended"]) assert.equal((view({ check: { ...TERM_READY, state } }).state as Obj).text, term.TERM_TEXT[state], state);
});

test("web components: termView は failed のとき check を見ず、読めなかった形（［取り込む］は押せず、［確かめ直す］）にする", () => {
  const v = term.termView(termRaw({ failed: true, check: TERM_READY }));
  assert.deepEqual([v.kind, v.note, v.take, v.recheck, v.rcUrl, v.lead], [
    "blocked", { text: "取り込めるか確かめられませんでした。", tone: "error", busy: false }, { disabled: true, busy: false, reason: "取り込めるか確かめられませんでした。" }, true, null, null,
  ]);
  assert.deepEqual(v.pane, { disabled: false, reason: null });
  const el = termCard(termRaw({ failed: true, check: TERM_READY }));
  assert.equal(find(el, "c-term-link").length, 0);
  assert.deepEqual(termBtns(el), [["primary", "md", "取り込む"], ["secondary", "md", "確かめ直す"], ["ghost", "md", "端末を見る"]]);
  assert.equal((find(el, "c-btn")[0] as El).props["aria-disabled"], "true");
});

test("web components: termView は error・activity・rcUrl・check の契約の外の値を丸める（文は空でない文字だけ、リンクは claude.ai/code の https だけ）", () => {
  for (const error of [undefined, "", 0, {}, false]) {
    const el = termCard(termRaw({ check: TERM_READY, error }));
    assert.equal(find(el, "c-term-note").length, 0, String(error));
    assert.equal(term.termView(termRaw({ check: TERM_READY, error })).note, null, String(error));
  }
  for (const activity of [undefined, "", 12]) {
    assert.equal(term.termView(termRaw({ check: TERM_READY, activity })).when, null, String(activity));
    assert.deepEqual(find(termCard(termRaw({ check: TERM_READY, activity })), "c-term-dt").map(textOf), ["場所", "状態"], String(activity));
  }
  for (const rcUrl of ["javascript:alert(1)", undefined, "", "http://claude.ai/code/x", "https://claude.ai/codex", "https://example.com/https://claude.ai/code/", 1]) {
    assert.equal(term.termView(termRaw({ check: { ...TERM_READY, rcUrl } })).rcUrl, null, String(rcUrl));
    assert.equal(find(termCard(termRaw({ check: { ...TERM_READY, rcUrl } })), "c-term-link").length, 0, String(rcUrl));
  }
  assert.equal(term.termView(termRaw({ check: TERM_READY })).rcUrl, "https://claude.ai/code/demo");
  // check が undefined でも落ちず、確かめている形
  const v = term.termView(termRaw({ check: undefined }));
  assert.deepEqual([v.kind, v.rcUrl, (v.note as Obj).text], ["checking", null, "取り込めるか確かめています…"]);
  assert.equal(term.termView(termRaw({ check: undefined, failed: true })).kind, "blocked");
  // check.text が空・文字でなければ「今は取り込めません」
  for (const text of ["", undefined, 5]) assert.equal((term.termView(termRaw({ check: { takeable: false, state: "idle", reason: "x", text, rcUrl: null } })).note as Obj).text, "今は取り込めません", String(text));
});

test("web components: termMouth の draw は根に札を 1 つ描き、同じ根にもう一度描くと差し替わり、drop で空にし、その後も描ける。render の例外はそのまま出る", () => {
  const calls: { vnode: VNode | null; root: unknown }[] = [];
  let fail = false;
  const render = (vnode: VNode | null, root: unknown): void => {
    if (fail) throw new Error("render");
    calls.push({ vnode, root });
  };
  const mouth = (term.termMouth as unknown as (r: typeof render) => { draw: (root: unknown, raw: Obj) => void; drop: (root: unknown) => void })(render);
  const root = {};
  const { calls: pressed, on } = termRec();
  mouth.draw(root, termRaw({ check: TERM_READY, on }));
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.root, root);
  const first = one(calls[0]?.vnode);
  assert.deepEqual([first.props.class, first.props["data-kind"]], ["c-term", "ready"]);
  assert.equal(expand(calls[0]?.vnode).length, 1);
  press(find(first, "c-btn")[0]);
  assert.deepEqual(pressed, ["take"]);
  mouth.draw(root, termRaw({ check: { takeable: false, state: "running", reason: "busy", text: "実行中", rcUrl: null }, on }));
  assert.deepEqual([calls.length, calls[1]?.root, one(calls[1]?.vnode).props["data-kind"]], [2, root, "busy"]);
  mouth.drop(root);
  assert.deepEqual([calls.length, calls[2]?.vnode, calls[2]?.root], [3, null, root]);
  mouth.draw(root, termRaw({ on }));
  assert.equal(one(calls[3]?.vnode).props["data-kind"], "checking");
  fail = true;
  assert.throws(() => mouth.draw(root, termRaw({ on })), /render/);
  assert.throws(() => mouth.drop(root), /render/);
});

// ===== 流れの列（c-deck.js。docs/plan/web-ui-deck.md の D1） =====
type FlowItem = { key: string; kind: string; word: string; place: string; time: string; at: string | null; title: string; summary: string; mark: string; turn: boolean; target: string | null; href: string | null; ops: FlowOp[]; opsRow: boolean; current: boolean };
type FlowOp = { id: string; label: string; name: string | null; kind?: string; disabled: boolean; busy: boolean; reason: string | null };
type FlowColumn = { id: string; name: string; count: number | null; tone: string; phase: string; empty: string; sections: Array<{ label: string | null; items: FlowItem[] }> };
const deckUrl = new URL("../src/web/static/c-deck.js", import.meta.url).href;
const deck = (await import(deckUrl)) as Record<string, Fn> & {
  DECK: Readonly<Record<string, number>>;
  FEED_MAX: number;
  ACT_REASON: Readonly<Record<string, string>>;
  focusAfter: (before: string[], after: string[], key: string) => string | null;
  pressableKeys: (entries: Array<{ key: string; pressable: boolean; kind?: string }>, kind?: string) => string[];
  deckFit: (width: unknown, seatOpen: boolean) => { cols: number; side: boolean; seat: number; colW: number };
  itemWord: (kind: unknown, src: unknown, state: Obj) => string;
  turnItems: (state: Obj) => FlowItem[];
  runningItems: (state: Obj) => FlowItem[];
  taskItems: (state: Obj) => FlowItem[];
  reminderItems: (state: Obj) => FlowItem[];
  feedItems: (state: Obj) => FlowItem[];
  deckModel: (state: Obj) => { cols: number; paged: boolean; columns: FlowColumn[] };
};

/** 流れの列の state（既定は全部空で読めている） */
function flowOf(o: Obj = {}): Obj {
  return {
    cols: 3, current: null, topics: { turnIds: [], groups: [], topics: [], rightHands: [] }, tasks: [], reminders: [], github: null, handoff: false, notices: [], today: "2026-01-02",
    isUnread: () => false, time: (at: string) => "t:" + at, ago: (at: string) => "ago:" + at, day: (d: string) => "day:" + d, oneLine: (t: string) => String(t).replace(/\s*[\r\n]+\s*/g, " "),
    parts: (url: string) => {
      const m = /^https:\/\/github\.com\/([^/]+)\/([^/]+)\/(?:pull|issues)\/(\d+)/.exec(url);
      return m ? { repo: m[1] + "/" + m[2], number: m[3] } : null;
    },
    ...o,
  };
}

test("web components: deckFit は設計書の幅の計算（列・席・並ぶか畳むか）で、数でない幅は既定", () => {
  assert.deepEqual({ ...deck.DECK }, { COL_MIN: 300, COL_MAX: 420, SIDE_MIN: 1340, SIDE_REST: 900, SIDE_MAX: 720, FOLD_RATE: 0.48, FOLD_MIN: 440, FOLD_MAX: 600 });
  assert.ok(Object.isFrozen(deck.DECK));
  const fit = (w: number, open: boolean) => deck.deckFit(w, open);
  assert.deepEqual(fit(1440, true), { cols: 3, side: true, seat: 540, colW: 300 });
  assert.deepEqual(fit(1440, false), { cols: 3, side: true, seat: 0, colW: 420 });
  assert.deepEqual(fit(1180, false), { cols: 3, side: false, seat: 0, colW: 393 });
  assert.deepEqual(fit(1180, true), { cols: 2, side: false, seat: 566, colW: 307 });
  assert.deepEqual(fit(820, false), { cols: 2, side: false, seat: 0, colW: 410 });
  assert.deepEqual(fit(820, true), { cols: 1, side: false, seat: 440, colW: 380 });
  assert.deepEqual(fit(1340, true), { cols: 3, side: true, seat: 440, colW: 300 });
  assert.deepEqual(fit(1339, true), { cols: 2, side: false, seat: 600, colW: 369 });
  assert.deepEqual(fit(640, true), { cols: 0, side: false, seat: 440, colW: 0 });
  assert.deepEqual(fit(640, false), { cols: 2, side: false, seat: 0, colW: 320 });
  // 席が閉じていれば 1 列は出す
  assert.equal(fit(200, false).cols, 1);
  for (const w of [Number.NaN, 0, -5, "1440", null, undefined, Number.POSITIVE_INFINITY]) assert.deepEqual(deck.deckFit(w, true), { cols: 1, side: false, seat: 0, colW: 0 }, String(w));
});

test("web components: turnItems は turnIds の順に話題と右腕（題「右腕」）を引き、引けない id・番の無い物を捨て、開いている物に current", () => {
  const topics = {
    turnIds: ["hand:1", "ch:1", "ch:missing", "ch:2", "ch:1"],
    groups: [{ key: "p:a", name: "A" }],
    topics: [
      { id: "ch:1", title: "家計", group: "p:a", mark: "turn", turn: { kind: "permission", summary: "コマンド", since: "S1" } },
      { id: "ch:2", title: "番の無い話題", group: "p:a", mark: null, turn: null },
    ],
    rightHands: [{ id: "hand:1", title: "x", turn: { kind: "question", summary: "", since: "S2" } }],
  };
  const items = deck.turnItems(flowOf({ topics, current: "ch:1" }));
  assert.deepEqual(items.map((i) => [i.key, i.kind, i.word, i.place, i.time, i.title, i.summary, i.mark, i.turn, i.target, i.current]), [
    ["turn:hand:1", "question", "質問", "", "ago:S2", "右腕", "", "turn", true, "hand:1", false],
    ["turn:ch:1", "permission", "許可", "A", "ago:S1", "家計", "コマンド", "turn", true, "ch:1", true],
  ]);
  assert.ok(items.every((i) => i.ops.length === 0 && i.href === null));
  assert.deepEqual(deck.turnItems(flowOf({ topics: null })), []);
});

test("web components: runningItems は番の無い作業中の話題だけを新しい順に", () => {
  const topics = {
    turnIds: [],
    groups: [{ key: "p:a", name: "A" }],
    topics: [
      { id: "cc:1", title: "古い", group: "p:a", mark: "running", turn: null, activityAt: "2026-01-01T00:00:00Z" },
      { id: "ch:2", title: "番", group: "p:a", mark: "running", turn: { kind: "permission", since: "x" }, activityAt: "2026-01-03T00:00:00Z" },
      { id: "ch:3", title: "新しい", group: "p:a", mark: "running", turn: null, activityAt: "2026-01-02T00:00:00Z" },
      { id: "ch:4", title: "静か", group: "p:a", mark: null, turn: null, activityAt: "2026-01-04T00:00:00Z" },
    ],
    rightHands: [],
  };
  const items = deck.runningItems(flowOf({ topics }));
  assert.deepEqual(items.map((i) => [i.key, i.word, i.place, i.mark, i.target, i.turn]), [
    ["run:ch:3", "動いている", "A", "running", "ch:3", false],
    ["run:cc:1", "動いている", "A", "running", "cc:1", false],
  ]);
});

test("web components: taskItems は 期限切れ → 今日 → 期限の昇順 → 期限なし（同じ期限は元の順）、reminderItems は nextAt の昇順で無い物は最後", () => {
  const tasks = [
    { id: 1, title: "なし 1", due: null },
    { id: 2, title: "先 b", due: "2026-01-05" },
    { id: 3, title: "今日", due: "2026-01-02" },
    { id: 4, title: "切れ 2", due: "2026-01-01" },
    { id: 5, title: "先 a", due: "2026-01-03" },
    { id: 6, title: "切れ 1", due: "2025-12-01" },
    { id: 7, title: "なし 2", due: null },
    { id: 8, title: "先 a2", due: "2026-01-03" },
  ];
  const items = deck.taskItems(flowOf({ tasks }));
  assert.deepEqual(items.map((i) => i.title), ["切れ 1", "切れ 2", "今日", "先 a", "先 a2", "先 b", "なし 1", "なし 2"]);
  assert.deepEqual(items.map((i) => i.word), ["期限切れ", "期限切れ", "今日", "タスク", "タスク", "タスク", "タスク", "タスク"]);
  assert.deepEqual(items.slice(0, 3).map((i) => [i.key, i.time, i.target, i.mark]), [["task:6", "day:2025-12-01", null, "none"], ["task:4", "day:2026-01-01", null, "none"], ["task:3", "day:2026-01-02", null, "none"]]);
  assert.equal(items[6]?.time, "");
  assert.deepEqual(deck.taskItems(flowOf({ tasks: null })), []);
  const reminders = [
    { id: 1, text: "なし", nextAt: null },
    { id: 2, text: "遅い", nextAt: "2026-01-03T00:00:00Z" },
    { id: 3, text: "早い\n2 行", nextAt: "2026-01-02T00:00:00Z" },
  ];
  const rem = deck.reminderItems(flowOf({ reminders }));
  assert.deepEqual(rem.map((i) => [i.key, i.word, i.title, i.time]), [
    ["rem:3", "リマインド", "早い 2 行", "t:2026-01-02T00:00:00Z"],
    ["rem:2", "リマインド", "遅い", "t:2026-01-03T00:00:00Z"],
    ["rem:1", "リマインド", "なし", ""],
  ]);
});

test("web components: feedItems は GitHub・知らせ・未読の話題を時刻の新しい順に混ぜ（同じ時刻は GitHub → 知らせ → 話題、時刻の無い物は最後）、50 件で切る", () => {
  const T = (h: number) => `2026-01-01T0${h}:00:00Z`;
  const topics = {
    turnIds: [],
    groups: [{ key: "p:a", name: "A" }],
    topics: [
      { id: "ch:1", title: "未読", group: "p:a", mark: null, turn: null, activityAt: T(3), last: { id: 9 } },
      { id: "ch:2", title: "読んだ", group: "p:a", mark: null, turn: null, activityAt: T(4), last: null },
      { id: "cc:3", title: "端末", group: "p:a", mark: null, turn: null, activityAt: T(5), last: null },
      { id: "ch:4", title: "作業中", group: "p:a", mark: "running", turn: null, activityAt: T(6), last: null },
      { id: "ch:5", title: "同じ時刻", group: "p:a", mark: null, turn: null, activityAt: T(2), last: null },
    ],
    rightHands: [],
  };
  const github = [
    { id: 11, url: "https://github.com/o/r/pull/12", title: "直し", label: "レビュー依頼", updatedAt: T(2) },
    { id: 12, url: "https://github.com/o/r/issues/7", title: "", label: "", updatedAt: T(1) },
    { id: 13, url: "https://github.com/o/r", title: "ほか", label: "", updatedAt: null },
  ];
  const notices = [
    { at: T(2), text: "知らせ A", link: "https://discord.com/channels/1/2/3" },
    { at: T(4), text: "知らせ B", link: "https://example.com/x" },
  ];
  const state = flowOf({ topics, github, notices, isUnread: (ch: string) => ch === "1" || ch === "3" || ch === "4" || ch === "5" });
  const items = deck.feedItems(state);
  assert.deepEqual(items.map((i) => i.key), ["notice:" + T(4) + ":1", "topic:ch:1", "gh:11", "notice:" + T(2) + ":0", "topic:ch:5", "gh:12", "gh:13"]);
  const by = (key: string) => items.find((i) => i.key === key)!;
  assert.deepEqual([by("gh:11").kind, by("gh:11").word, by("gh:11").title, by("gh:11").place, by("gh:11").href, by("gh:11").target], ["pr", "PR", "レビュー依頼: 直し #12", "o/r", "https://github.com/o/r/pull/12", null]);
  assert.deepEqual([by("gh:12").kind, by("gh:12").word, by("gh:12").title], ["issue", "Issue", "（題名なし） #7"]);
  assert.deepEqual([by("gh:13").kind, by("gh:13").word, by("gh:13").title, by("gh:13").place, by("gh:13").time], ["github", "GitHub", "ほか", "", ""]);
  assert.equal(by("notice:" + T(2) + ":0").href, "https://discord.com/channels/1/2/3");
  assert.equal(by("notice:" + T(4) + ":1").href, null);
  assert.deepEqual([by("topic:ch:1").kind, by("topic:ch:1").word, by("topic:ch:1").mark, by("topic:ch:1").target, by("topic:ch:1").place], ["reply", "返事", "unread", "ch:1", "A"]);
  // isUnread にはチャンネル ID と last を渡す
  const asked: unknown[][] = [];
  deck.feedItems(flowOf({ topics, isUnread: (ch: string, last: unknown) => void asked.push([ch, last]) }));
  assert.deepEqual(asked[0], ["1", { id: 9 }]);
  // GitHub が null でも知らせと話題は出る
  assert.deepEqual(deck.feedItems(flowOf({ topics, notices, github: null, isUnread: (ch: string) => ch === "1" })).map((i) => i.kind), ["notice", "reply", "notice"]);
  // 50 件で切る
  const many = Array.from({ length: 60 }, (_, i) => ({ at: new Date(Date.UTC(2026, 0, 1, 0, i)).toISOString(), text: "n" + i, link: null }));
  const cut = deck.feedItems(flowOf({ notices: many }));
  assert.equal(deck.FEED_MAX, 50);
  assert.equal(cut.length, 50);
  assert.equal(cut[0]?.title, "n59");
});

test("web components: itemWord は全部の種類の語（期限の 4 通り（先の日は「タスク」）・知らない種類は あなたの番）", () => {
  const st = flowOf();
  const words = ["permission", "question", "waiting", "confirm", "running", "reminder", "pr", "issue", "github", "notice", "reply"].map((k) => deck.itemWord(k, {}, st));
  assert.deepEqual(words, ["許可", "質問", "判断待ち", "確認", "動いている", "リマインド", "PR", "Issue", "GitHub", "知らせ", "返事"]);
  assert.equal(deck.itemWord("task", { due: "2026-01-01" }, st), "期限切れ");
  assert.equal(deck.itemWord("task", { due: "2026-01-02" }, st), "今日");
  // 先の日は語にせず、日付は右の時刻の所にだけ
  assert.equal(deck.itemWord("task", { due: "2026-01-09" }, st), "タスク");
  assert.equal(deck.itemWord("task", { due: null }, st), "タスク");
  assert.equal(deck.itemWord("x", {}, st), "あなたの番");
});

test("web components: deckModel の 3 つの列（名前・数・tone・phase・空の文・空の節を出さない・ops は空）", () => {
  const empty = deck.deckModel(flowOf());
  assert.equal(empty.cols, 3);
  assert.deepEqual(empty.columns.map((c) => [c.id, c.name, c.count, c.tone, c.phase, c.empty, c.sections.length]), [
    ["turn", "あなたの番", 0, "warning", "ready", "今は待たせている事がありません", 0],
    ["tasks", "タスク", 0, "none", "ready", "タスクとリマインドはありません", 0],
    ["feed", "通知", null, "none", "ready", "通知はありません", 0],
  ]);
  const loading = deck.deckModel(flowOf({ topics: null, tasks: null, reminders: null, notices: null }));
  assert.deepEqual(loading.columns.map((c) => c.phase), ["loading", "loading", "loading"]);
  // タスクかリマインドの片方が読めていれば読み込み中にしない。GitHub が無くても通知は読めている
  assert.equal(deck.deckModel(flowOf({ tasks: null })).columns[1]?.phase, "ready");
  const topics = {
    turnIds: ["ch:1"],
    groups: [],
    topics: [
      { id: "ch:1", title: "番", mark: "turn", turn: { kind: "permission", since: "s" } },
      { id: "ch:2", title: "動", mark: "running", turn: null, activityAt: "2026-01-01T00:00:00Z" },
    ],
    rightHands: [],
  };
  const full = deck.deckModel(flowOf({ topics, tasks: [{ id: 1, title: "t", due: null }], reminders: [], notices: [{ at: "2026-01-01T00:00:00Z", text: "n" }], ops: false }));
  const [turn, tasks, feed] = full.columns as [FlowColumn, FlowColumn, FlowColumn];
  assert.deepEqual(turn.sections.map((s) => [s.label, s.items.length]), [[null, 1], ["動いている", 1]]);
  assert.equal(turn.count, 1);
  assert.deepEqual(tasks.sections.map((s) => [s.label, s.items.length]), [[null, 1]]);
  assert.equal(tasks.count, 1);
  assert.deepEqual(feed.sections.map((s) => [s.label, s.items.length]), [[null, 1]]);
  assert.ok(full.columns.every((c) => c.sections.every((s) => s.items.every((i) => i.ops.length === 0))));
  // リマインドだけなら見出しの無い節は出さない
  const rem = deck.deckModel(flowOf({ reminders: [{ id: 1, text: "r", nextAt: null }] })).columns[1]!;
  assert.deepEqual(rem.sections.map((s) => s.label), ["リマインド"]);
  // cols は 0〜3 に丸め、数でなければ 3
  assert.deepEqual([5, -1, 1.7, "x"].map((c) => deck.deckModel(flowOf({ cols: c })).cols), [3, 0, 1, 3]);
});

test("web components: Deck は 3 つの section.c-col を常に出し、項目の data-*・aria-current、席に開けない物は div、外へのリンクは新しいタブ。押すと on.open(item, key)", () => {
  const calls: unknown[][] = [];
  const on = { open: (...a: unknown[]) => void calls.push(a) };
  const topics = { turnIds: ["ch:1"], groups: [], topics: [{ id: "ch:1", title: "番", mark: "turn", turn: { kind: "permission", summary: "要約", since: "s" } }], rightHands: [] };
  const github = [{ id: 1, url: "https://github.com/o/r/pull/2", title: "PR の題", label: "", updatedAt: "2026-01-01T00:00:00Z" }];
  const model = deck.deckModel(flowOf({ topics, current: "ch:1", cols: 2, tasks: [{ id: 3, title: "t", due: null }], github }));
  const root = one(html`<${deck.Deck} model=${model} on=${on} />`);
  assert.deepEqual([root.type, root.props.class, root.props["data-cols"]], ["div", "c-deck", "2"]);
  const cols = find(root, "c-col");
  assert.deepEqual(cols.map((c) => [c.type, c.props["data-col"], c.props["aria-label"]]), [["section", "turn", "あなたの番 1 件"], ["section", "tasks", "タスク 1 件"], ["section", "feed", "通知"]]);
  assert.equal(textOf(find(cols[0]!, "c-badge")), "1");
  assert.equal(textOf(find(cols[1]!, "c-col-count")), "1");
  assert.equal(find(cols[2]!, "c-col-count").length + find(cols[2]!, "c-badge").length, 0);
  assert.ok(cols.every((c) => find(c, "c-col-body")[0]?.props.role === "list"));
  const items = find(root, "c-item");
  assert.deepEqual(items.map((i) => [i.props.role, i.props["data-key"], i.props["data-kind"], i.props["data-turn"], i.props["data-current"]]), [
    ["listitem", "turn:ch:1", "permission", "true", "true"],
    ["listitem", "task:3", "task", undefined, undefined],
    ["listitem", "gh:1", "pr", undefined, undefined],
  ]);
  const [turnItem, taskItem, ghItem] = items as [El, El, El];
  const main = find(turnItem, "c-item-main")[0]!;
  assert.deepEqual([main.type, main.props.type, main.props["aria-current"]], ["button", "button", "true"]);
  assert.equal(textOf(find(main, "c-item-word")), "許可");
  assert.equal(textOf(find(main, "c-item-time")), "ago:s");
  assert.equal(textOf(find(main, "c-item-title")), "番");
  assert.equal(textOf(find(main, "c-item-sum")), "要約");
  assert.deepEqual([find(main, "c-mark")[0]?.props["data-state"], find(main, "c-mark")[0]?.props["aria-label"]], ["turn", "あなたの番"]);
  (main.props.onClick as () => void)();
  assert.deepEqual(calls, [[model.columns[0]!.sections[0]!.items[0], "turn:ch:1"]]);
  // 席に開けない物は div（押せない）、時刻・要約が無ければ出さない
  const taskMain = find(taskItem, "c-item-main")[0]!;
  assert.equal(taskMain.type, "div");
  assert.equal(find(taskMain, "c-item-time").length + find(taskMain, "c-item-sum").length + find(taskItem, "c-item-link").length, 0);
  assert.equal(find(taskMain, "c-mark")[0]?.props["aria-hidden"], "true");
  // 外へのリンクだけの物は項目ごとリンク（押した所が狭くならない）
  const link = find(ghItem, "c-item-link")[0]!;
  assert.deepEqual([link.type, link.props.href, link.props.target, link.props.rel], ["a", "https://github.com/o/r/pull/2", "_blank", "noreferrer noopener"]);
  assert.equal(find(ghItem, "c-item-main").length, 0);
  assert.equal(textOf(find(link, "c-item-title")), "PR の題 #2");
  assert.equal(textOf(find(link, "c-item-word")), "PR・o/r");
  // 読み込み中・空
  const loading = one(html`<${deck.Deck} model=${deck.deckModel(flowOf({ topics: null, tasks: null, reminders: null, notices: null }))} on=${on} />`);
  assert.equal(find(loading, "c-col").length, 3);
  assert.equal(find(loading, "c-loading").length, 3);
  const empty = one(html`<${deck.Deck} model=${deck.deckModel(flowOf())} on=${on} />`);
  assert.deepEqual(find(empty, "c-empty-text").map(textOf), ["今は待たせている事がありません", "タスクとリマインドはありません", "通知はありません"]);
  // 節の見出し
  const running = deck.deckModel(flowOf({ topics: { turnIds: [], groups: [], topics: [{ id: "ch:9", title: "動", mark: "running", turn: null }], rightHands: [] } }));
  assert.deepEqual(find(one(html`<${deck.Deck} model=${running} on=${on} />`), "c-col-label").map(textOf), ["動いている"]);
});

test("web components: ops が true のときだけ、タスクは［完了］（頭の印の場所の IconButton）・GitHub の通知は［対応］（.c-item-ops の Button sm。押せない理由は views.js の 2 文）・リマインドは［止める］など（別の検査）。知らせ・話題には付けない。busy の項目は押せない", () => {
  const calls: unknown[][] = [];
  const on = { open: (...a: unknown[]) => void calls.push(["open", ...a]), op: (...a: unknown[]) => void calls.push(["op", ...a]) };
  const topics = {
    turnIds: ["ch:1"],
    groups: [],
    topics: [
      { id: "ch:1", title: "番", mark: "turn", turn: { kind: "permission", since: "s" } },
      { id: "ch:2", title: "未読", mark: null, turn: null, activityAt: "2026-01-01T00:00:00Z", last: { id: 1 } },
    ],
    rightHands: [],
  };
  const github = [
    { id: 1, url: "https://github.com/o/r/pull/2", title: "押せる", label: "", updatedAt: "2026-01-01T03:00:00Z", handoff: true },
    { id: 2, url: "https://github.com/o/r/issues/3", title: "押せない", label: "", updatedAt: "2026-01-01T02:00:00Z", handoff: false },
  ];
  const base = { topics, tasks: [{ id: 5, title: "買い物", due: null }], reminders: [{ id: 1, text: "r", nextAt: null }], github, notices: [{ at: "2026-01-01T01:00:00Z", text: "n" }], isUnread: () => true };
  const all = (m: Obj) => (m.columns as FlowColumn[]).flatMap((c) => c.sections.flatMap((s) => s.items));
  // ops が true でなければ付けない（今までどおり）
  for (const ops of [false, undefined, "true"]) assert.ok(all(deck.deckModel(flowOf({ ...base, ops }))).every((i) => i.ops.length === 0), String(ops));
  const model = deck.deckModel(flowOf({ ...base, ops: true, handoff: true }));
  const items = all(model);
  const opsOf = (key: string) => items.find((i) => i.key === key)!.ops;
  assert.deepEqual(opsOf("task:5"), [{ id: "complete", label: "完了", name: "「買い物」を完了にする", disabled: false, busy: false, reason: null }]);
  assert.deepEqual(opsOf("gh:1"), [{ id: "act", label: "対応", name: null, disabled: false, busy: false, reason: null }]);
  assert.deepEqual(opsOf("gh:2"), [{ id: "act", label: "対応", name: null, disabled: true, busy: false, reason: "この通知は対応できません。この機械に無いリポジトリか、[対応] を足す前の通知です" }]);
  for (const key of ["turn:ch:1", "notice:2026-01-01T01:00:00Z:0", "topic:ch:2"]) assert.deepEqual(opsOf(key), [], key);
  // 1 回だけのリマインドは［止める］だけ（繰り返しの形は別の検査）
  assert.deepEqual(opsOf("rem:1").map((o) => o.id), ["cancel"]);
  // 連携が無効なら理由は連携の文。2 つの文は views.js の githubActButton と同じ字
  const off = all(deck.deckModel(flowOf({ ...base, ops: true, handoff: false })));
  assert.equal(off.find((i) => i.key === "gh:1")!.ops[0]?.reason, null);
  assert.equal(off.find((i) => i.key === "gh:2")!.ops[0]?.reason, "Claude Code の連携が無効です（設定で有効にできます）");
  const views = read("views.js");
  for (const text of Object.values(deck.ACT_REASON)) assert.ok(views.includes('"' + text + '"'), text);
  // busy の項目は押せない（応答まで）
  const busy = all(deck.deckModel(flowOf({ ...base, ops: true, handoff: true, busy: ["task:5", "gh:1"] })));
  assert.deepEqual(busy.find((i) => i.key === "task:5")!.ops[0], { id: "complete", label: "完了", name: "「買い物」を完了にする", disabled: true, busy: true, reason: null });
  assert.deepEqual([busy.find((i) => i.key === "gh:1")!.ops[0]?.disabled, busy.find((i) => i.key === "gh:1")!.ops[0]?.busy], [true, true]);
  // 描く: 完了は押せない項目（div）の頭の IconButton（印の代わり）。ボタンの中にボタンを入れない
  const root = one(html`<${deck.Deck} model=${model} on=${on} />`);
  const byKey = (key: string) => find(root, "c-item").find((i) => i.props["data-key"] === key)!;
  const task = byKey("task:5");
  const taskMain = find(task, "c-item-main")[0]!;
  assert.equal(taskMain.type, "div");
  const meta = find(taskMain, "c-item-meta")[0]!;
  const done = find(meta, "c-iconbtn");
  assert.equal(done.length, 1);
  assert.deepEqual([done[0]!.props["aria-label"], done[0]!.props["data-size"], done[0]!.props["aria-disabled"]], ["「買い物」を完了にする", "sm", undefined]);
  assert.equal(find(meta, "c-mark").length, 0);
  assert.equal(find(task, "c-item-ops").length, 0);
  const ev = fakeEvent();
  (done[0]!.props.onClick as (e: unknown) => void)(ev);
  const taskModel = items.find((i) => i.key === "task:5");
  assert.deepEqual(calls, [["op", taskModel, "complete"]]);
  // 対応は開くリンクの兄弟の .c-item-ops（リンクの中に入れない）
  const gh = byKey("gh:1");
  const link = find(gh, "c-item-link")[0]!;
  assert.equal(find(link, "c-btn").length + find(link, "c-iconbtn").length, 0);
  const opsBox = gh.children.filter((c): c is El => typeof c !== "string" && c.props.class === "c-item-ops");
  assert.equal(opsBox.length, 1);
  const act = find(opsBox[0]!, "c-btn")[0]!;
  assert.deepEqual([textOf(find(act, "c-btn-label")), act.props["data-size"], act.props["data-kind"], act.props["aria-disabled"], act.props.title], ["対応", "sm", "secondary", undefined, undefined]);
  (act.props.onClick as (e: unknown) => void)(ev);
  assert.deepEqual(calls[1], ["op", items.find((i) => i.key === "gh:1"), "act"]);
  // 押せない［対応］は aria-disabled と title の理由（今の一覧と同じ出し方）で、押しても on.op を呼ばない
  const offAct = find(byKey("gh:2"), "c-btn")[0]!;
  assert.deepEqual([offAct.props["aria-disabled"], offAct.props.title], ["true", "この通知は対応できません。この機械に無いリポジトリか、[対応] を足す前の通知です"]);
  (offAct.props.onClick as (e: unknown) => void)(fakeEvent());
  assert.equal(calls.length, 2);
  // 操作の無い項目は .c-item-ops を出さず、印のまま
  for (const key of ["turn:ch:1", "topic:ch:2"]) {
    assert.equal(find(byKey(key), "c-item-ops").length + find(byKey(key), "c-iconbtn").length + find(byKey(key), "c-btn").length, 0, key);
    assert.equal(find(byKey(key), "c-mark").length, 1, key);
  }
  // busy の描き直し: 完了は aria-disabled、対応は aria-busy。押しても on.op を呼ばない
  const busyRoot = one(html`<${deck.Deck} model=${deck.deckModel(flowOf({ ...base, ops: true, handoff: true, busy: ["task:5", "gh:1"] }))} on=${on} />`);
  const bKey = (key: string) => find(busyRoot, "c-item").find((i) => i.props["data-key"] === key)!;
  const bDone = find(bKey("task:5"), "c-iconbtn")[0]!;
  const bAct = find(bKey("gh:1"), "c-btn")[0]!;
  assert.deepEqual([bDone.props["aria-disabled"], bAct.props["aria-disabled"], bAct.props["aria-busy"]], ["true", "true", "true"]);
  (bDone.props.onClick as (e: unknown) => void)(fakeEvent());
  (bAct.props.onClick as (e: unknown) => void)(fakeEvent());
  assert.equal(calls.length, 2);
});

test("web components: focusAfter は完了で消えた項目の焦点の行き先（同じ列の同じ並びの位置に来た項目、無ければ列の最後、空なら null。残っていればその key）", () => {
  const abc = ["task:1", "task:2", "task:3"];
  // 真ん中を完了 → 元の 3 つ目（今の 2 つ目）
  assert.equal(deck.focusAfter(abc, ["task:1", "task:3"], "task:2"), "task:3");
  // 最後を完了 → 1 つ前
  assert.equal(deck.focusAfter(abc, ["task:1", "task:2"], "task:3"), "task:2");
  // 最初を完了 → 次
  assert.equal(deck.focusAfter(abc, ["task:2", "task:3"], "task:1"), "task:2");
  // 1 つだけを完了 → 列が空（入口が帯の［探す］へ）
  assert.equal(deck.focusAfter(["task:1"], [], "task:1"), null);
  // 残っていればその key（並びが変わっても）
  assert.equal(deck.focusAfter(abc, ["task:3", "task:1", "task:2"], "task:1"), "task:1");
  // 前の並びに無い key は列の頭
  assert.equal(deck.focusAfter([], ["task:2"], "task:9"), "task:2");
});

test("web components: 焦点の行き先は押せる項目（ボタン・リンクを持つ）だけで数え、種類を渡せばその種類だけ。リマインドが押せても、最後のタスクを完了 → 1 つ前のタスク", () => {
  // リマインドも押せる（［止める］）。種類は key の頭から
  const entries = (keys: string[], pressable = (key: string) => key.startsWith("task:") || key.startsWith("rem:")) =>
    keys.map((key) => ({ key, pressable: pressable(key), kind: key.startsWith("task:") ? "task" : "reminder" }));
  const before = deck.pressableKeys(entries(["task:1", "task:2", "rem:1"]), "task");
  const after = deck.pressableKeys(entries(["task:1", "rem:1"]), "task");
  assert.deepEqual([before, after], [["task:1", "task:2"], ["task:1"]]);
  assert.equal(deck.focusAfter(before, after, "task:2"), "task:1");
  // タスクが無くなりリマインドだけ → 同じ種類の押せる項目が無い（入口が帯の［探す］へ）。［止める］に乗せない
  assert.equal(deck.focusAfter(["task:1"], deck.pressableKeys(entries(["rem:1"]), "task"), "task:1"), null);
  // リマインドを止めた → 次のリマインド（タスクは数えない）
  const remBefore = deck.pressableKeys(entries(["task:1", "rem:1", "rem:2"]), "reminder");
  const remAfter = deck.pressableKeys(entries(["task:1", "rem:2"]), "reminder");
  assert.deepEqual([remBefore, remAfter], [["rem:1", "rem:2"], ["rem:2"]]);
  assert.equal(deck.focusAfter(remBefore, remAfter, "rem:1"), "rem:2");
  // 第 2 引数なしは今のまま（種類を見ず、押せる物だけ）
  assert.deepEqual(deck.pressableKeys(entries(["task:1", "rem:1", "gh:1"])), ["task:1", "rem:1"]);
  assert.deepEqual(deck.pressableKeys(entries(["task:1", "rem:1"], (key) => key.startsWith("task:"))), ["task:1"]);
  // 種類の無い項目は種類を渡すと数えない
  assert.deepEqual(deck.pressableKeys([{ key: "x", pressable: true }], "task"), []);
});

test("web components: リマインドの項目は、語（依頼か）・場所の所の繰り返しの文（無ければ「1 回だけ」・ruleText が無ければ rule）・opsRow、ops は繰り返しだけ［次を飛ばす］と常に［止める］（ghost）", () => {
  const reminders = [
    { id: 1, text: "毎朝の\n薬", nextAt: "2026-01-02T00:00:00Z", kind: "notify", rule: "daily@09:00", ruleText: "毎日 9:00" },
    { id: 2, text: "1 回", nextAt: "2026-01-03T00:00:00Z", kind: "notify", rule: null, ruleText: null },
    { id: 3, text: "依頼", nextAt: "2026-01-04T00:00:00Z", kind: "prompt", rule: "weekdays@12:00", ruleText: null },
    { id: 4, text: "空の rule", nextAt: "2026-01-05T00:00:00Z", kind: "notify", rule: "", ruleText: "" },
  ];
  const items = deck.reminderItems(flowOf({ reminders, ops: true }));
  assert.deepEqual(items.map((i) => [i.key, i.word, i.place, i.opsRow]), [
    ["rem:1", "リマインド", "毎日 9:00", true],
    ["rem:2", "リマインド", "1 回だけ", true],
    ["rem:3", "依頼", "weekdays@12:00", true],
    ["rem:4", "リマインド", "1 回だけ", true],
  ]);
  assert.deepEqual(items[0]!.ops, [
    { id: "skip", label: "次を飛ばす", name: "「毎朝の 薬」の次を飛ばす", kind: "ghost", disabled: false, busy: false, reason: null },
    { id: "cancel", label: "止める", name: "「毎朝の 薬」を止める", kind: "ghost", disabled: false, busy: false, reason: null },
  ]);
  assert.deepEqual(items.map((i) => i.ops.map((o) => o.id)), [["skip", "cancel"], ["cancel"], ["skip", "cancel"], ["cancel"]]);
  // ops が true でなければ付けない（opsRow は残る）
  for (const ops of [false, undefined, "true"]) assert.ok(deck.reminderItems(flowOf({ reminders, ops })).every((i) => i.ops.length === 0 && i.opsRow), String(ops));
  // opsRow はリマインドだけ
  const github = [{ id: 1, url: "https://github.com/o/r/pull/2", title: "p", label: "", updatedAt: "2026-01-01T00:00:00Z", handoff: true }];
  const all = deck.deckModel(flowOf({ reminders, tasks: [{ id: 5, title: "t", due: null }], github, ops: true, handoff: true })).columns.flatMap((c) => c.sections.flatMap((s) => s.items));
  assert.deepEqual(all.filter((i) => i.opsRow).map((i) => i.kind), ["reminder", "reminder", "reminder", "reminder"]);
  assert.ok(all.filter((i) => !i.opsRow).every((i) => i.ops.every((o) => o.kind === undefined)));
  // 応答待ち: 2 つとも押せず、回る印は押した方だけ。busyOp が無ければ回らない
  const busy = deck.reminderItems(flowOf({ reminders, ops: true, busy: ["rem:1"], busyOp: { "rem:1": "cancel" } }));
  assert.deepEqual(busy[0]!.ops.map((o) => [o.id, o.disabled, o.busy]), [["skip", true, false], ["cancel", true, true]]);
  assert.deepEqual(busy[1]!.ops.map((o) => [o.id, o.disabled, o.busy]), [["cancel", false, false]]);
  const noOp = deck.reminderItems(flowOf({ reminders, ops: true, busy: ["rem:1"] }));
  assert.deepEqual(noOp[0]!.ops.map((o) => [o.disabled, o.busy]), [[true, false], [true, false]]);
  // busyOp だけ（busy に無い）なら押せる
  const stale = deck.reminderItems(flowOf({ reminders, ops: true, busyOp: { "rem:1": "skip" } }));
  assert.deepEqual(stale[0]!.ops.map((o) => [o.disabled, o.busy]), [[false, false], [false, false]]);
});

test("web components: リマインドの項目は data-ops=\"row\" で、.c-item-ops は題の下に［次を飛ばす］［止める］の順の ghost の Button sm（aria-label・aria-disabled。disabled 属性は無い）。押すと on.op", () => {
  const calls: unknown[][] = [];
  const on = { open: () => undefined, op: (...a: unknown[]) => void calls.push(a) };
  const reminders = [
    { id: 1, text: "毎朝", nextAt: "2026-01-02T00:00:00Z", kind: "notify", rule: "daily@09:00", ruleText: "毎日 9:00" },
    { id: 2, text: "1 回", nextAt: "2026-01-03T00:00:00Z", kind: "notify", rule: null, ruleText: null },
  ];
  const github = [{ id: 1, url: "https://github.com/o/r/pull/2", title: "p", label: "", updatedAt: "2026-01-01T00:00:00Z", handoff: true }];
  const state = { reminders, tasks: [{ id: 5, title: "t", due: null }], github, ops: true, handoff: true };
  const model = deck.deckModel(flowOf(state));
  const root = one(html`<${deck.Deck} model=${model} on=${on} />`);
  const items = find(root, "c-item");
  assert.deepEqual(items.filter((i) => i.props["data-ops"] !== undefined).map((i) => [i.props["data-key"], i.props["data-ops"]]), [["rem:1", "row"], ["rem:2", "row"]]);
  const byKey = (r: El, key: string) => find(r, "c-item").find((i) => i.props["data-key"] === key)!;
  const rem = byKey(root, "rem:1");
  // 題の下: 中身（印・語・時刻・題）の後に操作の行
  const kids = rem.children.filter((c): c is El => typeof c !== "string");
  assert.deepEqual(kids.map((c) => c.props.class), ["c-item-main", "c-item-ops"]);
  assert.equal(textOf(find(kids[0]!, "c-item-word")), "リマインド・毎日 9:00");
  assert.equal(find(kids[0]!, "c-mark").length, 1);
  const btns = find(kids[1]!, "c-btn");
  assert.deepEqual(btns.map((b) => [textOf(find(b, "c-btn-label")), b.props["aria-label"], b.props["data-kind"], b.props["data-size"], b.props["aria-disabled"], b.props.disabled]), [
    ["次を飛ばす", "「毎朝」の次を飛ばす", "ghost", "sm", undefined, undefined],
    ["止める", "「毎朝」を止める", "ghost", "sm", undefined, undefined],
  ]);
  assert.equal(typeof rem.props.onKeyDown, "function");
  (btns[1]!.props.onClick as (e: unknown) => void)(fakeEvent());
  (btns[0]!.props.onClick as (e: unknown) => void)(fakeEvent());
  const remModel = model.columns[1]!.sections[1]!.items[0];
  assert.deepEqual(calls, [[remModel, "cancel"], [remModel, "skip"]]);
  assert.deepEqual(find(byKey(root, "rem:2"), "c-btn").map((b) => textOf(find(b, "c-btn-label"))), ["止める"]);
  // ［対応］は今の secondary のまま
  assert.equal(find(byKey(root, "gh:1"), "c-btn")[0]?.props["data-kind"], "secondary");
  // 応答待ち: 2 つとも aria-disabled（disabled 属性は無い・焦点は残る）、回るのは押した方だけ。押しても on.op を呼ばない
  const busyRoot = one(html`<${deck.Deck} model=${deck.deckModel(flowOf({ ...state, busy: ["rem:1"], busyOp: { "rem:1": "skip" } }))} on=${on} />`);
  const bBtns = find(byKey(busyRoot, "rem:1"), "c-btn");
  assert.deepEqual(bBtns.map((b) => [b.props["aria-disabled"], b.props["aria-busy"], b.props.disabled]), [["true", "true", undefined], ["true", undefined, undefined]]);
  for (const b of bBtns) (b.props.onClick as (e: unknown) => void)(fakeEvent());
  assert.equal(calls.length, 2);
  // ops が無ければ操作の行は出ない（data-ops は付く）
  const plain = one(html`<${deck.Deck} model=${deck.deckModel(flowOf({ reminders }))} on=${on} />`);
  assert.equal(find(byKey(plain, "rem:1"), "c-item-ops").length, 0);
});

test("web components: 項目の入れ物は、操作のボタン（［完了］・［対応］）から来た繰り返しの Enter・Space だけを押さない（開くボタン・リンク・繰り返しでない keydown はそのまま）", () => {
  const topics = { turnIds: ["ch:1"], groups: [], topics: [{ id: "ch:1", title: "番", mark: "turn", turn: { kind: "permission", since: "s" } }], rightHands: [] };
  const github = [{ id: 1, url: "https://github.com/o/r/pull/2", title: "押せる", label: "", updatedAt: "2026-01-01T03:00:00Z", handoff: true }];
  const model = deck.deckModel(flowOf({ topics, tasks: [{ id: 5, title: "買い物", due: null }], github, ops: true, handoff: true }));
  const root = one(html`<${deck.Deck} model=${model} on=${{ open: () => undefined, op: () => undefined }} />`);
  const byKey = (key: string) => find(root, "c-item").find((i) => i.props["data-key"] === key)!;
  const keydown = (key: string, onto: string, from: string, repeat: boolean) => {
    let prevented = false;
    const event = { key: onto, repeat, target: { closest: (sel: string) => (sel.split(", ").some((s) => s.endsWith(from)) ? {} : null) }, preventDefault: () => void (prevented = true) };
    const handler = byKey(key).props.onKeyDown as ((e: unknown) => void) | undefined;
    if (handler) handler(event);
    return prevented;
  };
  // ［完了］・［対応］の繰り返しの Enter・Space は押さない
  assert.equal(keydown("task:5", "Enter", ".c-iconbtn", true), true);
  assert.equal(keydown("task:5", " ", ".c-iconbtn", true), true);
  assert.equal(keydown("gh:1", "Enter", ".c-btn", true), true);
  // 繰り返しでない・ほかの鍵はそのまま
  assert.equal(keydown("task:5", "Enter", ".c-iconbtn", false), false);
  assert.equal(keydown("task:5", "Tab", ".c-iconbtn", true), false);
  // 開くリンク・開くボタンは繰り返しでもそのまま
  assert.equal(keydown("gh:1", "Enter", ".c-item-link", true), false);
  assert.equal(keydown("turn:ch:1", "Enter", ".c-item-main", true), false);
});

test("web components: DeckBand は点・名前・探す・右腕・始める・ほかの順で、右腕は aria-controls と aria-expanded、押すと on の 5 つ", () => {
  const calls: unknown[][] = [];
  const on = {
    status: () => void calls.push(["status"]),
    find: (o: unknown) => void calls.push(["find", o]),
    hand: (o: unknown) => void calls.push(["hand", o]),
    start: (o: unknown) => void calls.push(["start", o]),
    more: (o: unknown) => void calls.push(["more", o]),
  };
  const band = one(html`<${deck.DeckBand} conn=${{ tone: "ok", label: "見本の Bot: 接続中" }} hand=${{ mark: "turn", open: true }} controls="v3-hand" on=${on} />`);
  assert.deepEqual([band.type, band.props.class], ["header", "c-band"]);
  const acts = (t: El): unknown[] => {
    const out: unknown[] = [];
    const walk = (n: Tree) => {
      if (typeof n === "string") return;
      if (n.props["data-act"] !== undefined) out.push(n.props["data-act"]);
      n.children.forEach(walk);
    };
    walk(t);
    return out;
  };
  assert.deepEqual(acts(band), ["status", "find", "hand", "start", "more"]);
  const conn = find(band, "c-band-conn")[0]!;
  assert.deepEqual([conn.props["aria-label"], conn.props.title, find(conn, "c-band-dot")[0]?.props["data-tone"]], ["見本の Bot: 接続中", "見本の Bot: 接続中", "ok"]);
  assert.equal(textOf(find(band, "c-band-name")), "self-agent");
  const hand = find(band, "c-band-hand")[0]!;
  assert.deepEqual([hand.props["aria-controls"], hand.props["aria-expanded"], hand.props["aria-label"], find(hand, "c-band-hand-mark")[0]?.props["data-state"]], ["v3-hand", "true", "右腕（あなたの番）", "turn"]);
  assert.deepEqual(find(band, "c-btn-label").map(textOf), ["探す", "始める"]);
  assert.equal(find(band, "c-iconbtn")[0]?.props["aria-label"], "ほか");
  const ev = fakeEvent();
  (conn.props.onClick as () => void)();
  (hand.props.onClick as (e: unknown) => void)(ev);
  for (const b of [...find(band, "c-btn"), ...find(band, "c-iconbtn")]) (b.props.onClick as (e: unknown) => void)(ev);
  assert.deepEqual(calls.map((c) => c[0]), ["status", "hand", "find", "start", "more"]);
  assert.equal(calls[1]?.[1], ev.currentTarget);
  // 状態をまだ読めていなければ点を出さない。印が無ければ名前は見える字のまま、閉じていれば aria-expanded=false
  const quiet = one(html`<${deck.DeckBand} conn=${null} hand=${{ mark: null, open: false }} on=${on} />`);
  assert.equal(find(quiet, "c-band-conn").length, 0);
  const qh = find(quiet, "c-band-hand")[0]!;
  assert.deepEqual([qh.props["aria-label"], qh.props["aria-expanded"], qh.props["aria-controls"], find(qh, "c-band-hand-mark").length], [undefined, "false", undefined, 0]);
  assert.equal(find(one(html`<${deck.DeckBand} conn=${{ tone: "bad", label: "x" }} hand=${null} on=${on} />`), "c-band-dot")[0]?.props["data-tone"], "bad");
});

test("web components: c-deck.css は区切りの線（左の線と 0 の外し・角丸のほかの border）・gradient・半透明・影・動きを書かない", () => {
  const rules = parseCss(read("c-deck.css"));
  assert.ok(rules.length > 0);
  for (const rule of rules) {
    for (const decl of rule.body.split(";").map((d) => d.trim()).filter((d) => d !== "")) {
      const prop = decl.slice(0, decl.indexOf(":")).trim();
      if (prop.startsWith("border")) assert.ok(["border-left", "border-left-color", "border-radius"].includes(prop) || decl === "border: 0", `${rule.selectors.join(",")}: ${decl}`);
      assert.doesNotMatch(decl, /gradient|rgba\(|^opacity\s*:|^box-shadow\s*:|^animation|^transition/, `${rule.selectors.join(",")}: ${decl}`);
    }
  }
  assert.doesNotMatch(stripCssComments(read("c-deck.css")), /@keyframes|@media \(min-width|1340/);
});

test("web components: TopBar の close（true で帯の右端に data-act=close の［閉じる］が 1 つ。false・無しは今と同じ出力、view none は出さない）", () => {
  const calls: unknown[][] = [];
  const on = { ...topRec().on, close: () => void calls.push(["close"]) };
  for (const variant of ["wide", "phone"]) {
    const v = shell.TopBar({ ...topProps({ variant }), close: true, on }) as VNode;
    const keys = keysOf(v.props.children).filter((k) => k !== undefined);
    assert.equal(keys.at(-1), "close", variant);
    const bar = one(v);
    const closes = bar.children.filter((c): c is El => typeof c !== "string" && c.props["data-act"] === "close");
    assert.equal(closes.length, 1);
    const btn = find(closes[0]!, "c-iconbtn")[0]!;
    assert.equal(btn.props["aria-label"], "閉じる");
    (btn.props.onClick as (e: unknown) => void)(fakeEvent());
  }
  assert.deepEqual(calls, [["close"], ["close"]]);
  for (const close of [false, undefined, "true"]) {
    const without = shell.TopBar({ ...topProps({ variant: "wide" }), close, on }) as VNode;
    const plain = shell.TopBar({ ...topProps({ variant: "wide" }), on }) as VNode;
    assert.deepEqual(keysOf(without.props.children), keysOf(plain.props.children), String(close));
    assert.equal(textOf(one(without)), textOf(one(plain)));
    assert.equal(one(without).children.length, one(plain).children.length);
    assert.equal(shell.topModel({ ...topProps(), close })?.close, false);
  }
  assert.equal(shell.TopBar({ ...topProps({ view: "none" }), close: true, on }), null);
  assert.equal(shell.topModel({ ...topProps({ view: "other" }), close: true })?.close, true);
});

// ===== スマホの 3 列の横送り（D2 の PR-1。docs/plan/web-ui-deck.md §4.1 のスマホ 390 と §6.1 の D2）: 部品だけ =====

test("web components: deckModel の paged は true のときだけ true。Deck は paged のときだけ data-paged=true で、列は 3 つのまま", () => {
  assert.equal(deck.deckModel(flowOf({ cols: 1, paged: true })).paged, true);
  for (const paged of [undefined, false, "true", 1]) assert.equal(deck.deckModel(flowOf({ cols: 1, paged })).paged, false, String(paged));
  const paged = one(html`<${deck.Deck} model=${deck.deckModel(flowOf({ cols: 1, paged: true }))} on=${{ open: () => undefined, op: () => undefined }} />`);
  assert.deepEqual([paged.props.class, paged.props["data-cols"], paged.props["data-paged"]], ["c-deck", "1", "true"]);
  assert.deepEqual(find(paged, "c-col").map((c) => c.props["data-col"]), ["turn", "tasks", "feed"]);
  const plain = one(html`<${deck.Deck} model=${deck.deckModel(flowOf({ cols: 1 }))} on=${{ open: () => undefined, op: () => undefined }} />`);
  assert.equal(plain.props["data-paged"], undefined);
  assert.equal(find(plain, "c-col").length, 3);
});

test("web components: DeckBand の phone は点・探す・始める・ほかの順で右腕を出さず、［始める］は名前「始める」の IconButton。variant なし・wide は今と同じ出力", () => {
  const calls: unknown[][] = [];
  const rec = (name: string) => (o?: unknown): void => void calls.push([name, o]);
  const on = { status: rec("status"), find: rec("find"), hand: rec("hand"), start: rec("start"), more: rec("more") };
  const acts = (t: El): unknown[] => {
    const out: unknown[] = [];
    const walk = (n: Tree) => {
      if (typeof n === "string") return;
      if (n.props["data-act"] !== undefined) out.push(n.props["data-act"]);
      n.children.forEach(walk);
    };
    walk(t);
    return out;
  };
  const props = { conn: { tone: "ok", label: "見本の Bot: 接続中" }, hand: { mark: "turn", open: false }, controls: "v3-hand", on };
  const band = one(html`<${deck.DeckBand} variant="phone" ...${props} />`);
  assert.deepEqual(acts(band), ["status", "find", "start", "more"]);
  assert.equal(find(band, "c-band-hand").length, 0);
  assert.equal(textOf(find(band, "c-band-name")), "self-agent");
  assert.deepEqual(find(band, "c-btn-label").map(textOf), ["探す"]);
  const start = band.children.flatMap((c) => (typeof c === "string" ? [] : find(c, "c-band-act"))).find((s) => s.props["data-act"] === "start")!;
  const startBtn = find(start, "c-iconbtn")[0]!;
  assert.equal(startBtn.props["aria-label"], "始める");
  assert.match(String(((find(startBtn, "c-icon")[0] as El).children[0] as El).props.href), /#plus$/);
  assert.deepEqual(find(band, "c-iconbtn").map((b) => b.props["aria-label"]), ["始める", "ほか"]);
  const ev = fakeEvent();
  (startBtn.props.onClick as (e: unknown) => void)(ev);
  assert.deepEqual(calls, [["start", ev.currentTarget]]);
  // variant なし・wide・知らない値は今の形（右腕あり・［始める］は字つき）
  const now = one(html`<${deck.DeckBand} ...${props} />`);
  for (const variant of ["wide", "tablet", null]) {
    const other = one(html`<${deck.DeckBand} variant=${variant} ...${props} />`);
    assert.deepEqual(acts(other), acts(now), String(variant));
    assert.equal(textOf(other), textOf(now), String(variant));
    assert.deepEqual(find(other, "c-btn-label").map(textOf), ["探す", "始める"], String(variant));
  }
  assert.deepEqual(acts(now), ["status", "find", "hand", "start", "more"]);
});

test("web components: DeckBand の title（phone で name が空でないときだけ h2 data-kind=page に列の名前と数。warning は Badge・ほかは c-band-count・0 と null は数なし。ほかは「self-agent」）", () => {
  const on = { status: () => undefined, find: () => undefined, hand: () => undefined, start: () => undefined, more: () => undefined };
  const props = { conn: { tone: "ok", label: "見本の Bot: 接続中" }, hand: { mark: "turn", open: false }, controls: "v3-hand", on };
  const nameOf = (title: unknown, variant: unknown = "phone"): El => {
    const names = find(one(html`<${deck.DeckBand} variant=${variant} title=${title} ...${props} />`), "c-band-name");
    assert.equal(names.length, 1);
    return names[0]!;
  };
  const turn = nameOf({ name: "あなたの番", count: 2, tone: "warning" });
  assert.deepEqual([turn.type, turn.props["data-kind"], turn.props["aria-label"]], ["h2", "page", "あなたの番 2 件"]);
  assert.equal(textOf(find(turn, "c-band-title")), "あなたの番");
  assert.deepEqual(find(turn, "c-badge").map((b) => [textOf(b), b.props["data-tone"]]), [["2", "warning"]]);
  assert.equal(find(turn, "c-band-count").length, 0);
  const tasks = nameOf({ name: "タスク", count: 3 });
  assert.deepEqual([tasks.type, tasks.props["data-kind"], tasks.props["aria-label"]], ["h2", "page", "タスク 3 件"]);
  assert.deepEqual(find(tasks, "c-band-count").map(textOf), ["3"]);
  assert.equal(find(tasks, "c-badge").length, 0);
  for (const count of [0, null, undefined, "3", -1]) {
    const quiet = nameOf({ name: "通知", count, tone: "warning" });
    assert.deepEqual([quiet.type, quiet.props["aria-label"], textOf(quiet)], ["h2", "通知", "通知"], String(count));
    assert.equal(find(quiet, "c-badge").length + find(quiet, "c-band-count").length, 0, String(count));
  }
  // phone で title が無い・name が空や文字列でない → 今の span「self-agent」
  for (const title of [null, undefined, { name: "", count: 2 }, { name: null, count: 2 }, { count: 2 }]) {
    const plain = nameOf(title);
    assert.deepEqual([plain.type, plain.props["data-kind"], textOf(plain)], ["span", undefined, "self-agent"], JSON.stringify(title));
  }
  // phone でなければ title を渡しても「self-agent」
  for (const variant of ["wide", null, "tablet"]) {
    const wide = nameOf({ name: "タスク", count: 3 }, variant);
    assert.deepEqual([wide.type, wide.props["data-kind"], textOf(wide)], ["span", undefined, "self-agent"], String(variant));
  }
});

test("web components: c-deck.css のスマホの帯の題（名前と数を横に並べ、名前は省き数は縮めない）と、paged の列の見出しを出さない", () => {
  const rules = parseCss(read("c-deck.css"));
  const body = (sel: string): string => rules.filter((r) => r.at.length === 0 && r.selectors.includes(sel)).map((r) => r.body).join(" ");
  const page = body('.c-band-name[data-kind="page"]');
  for (const decl of ["display: flex", "align-items: center", "gap: var(--space-2)", "margin: 0", "font-size: inherit"]) assert.ok(page.includes(decl), decl);
  assert.ok(body(".c-col-head").includes("gap: var(--space-2)"));
  const title = body(".c-band-title");
  for (const decl of ["min-width: 0", "overflow: hidden", "text-overflow: ellipsis", "white-space: nowrap"]) assert.ok(title.includes(decl), decl);
  assert.ok(body('.c-band-name[data-kind="page"] > :not(.c-band-title)').includes("flex: none"));
  // 数は列の見出しの数と同じ宣言
  assert.equal(body(".c-band-count"), body(".c-col-count"));
  assert.ok(body(".c-band-count").includes("color: var(--text-secondary)"));
  // 帯の数は h2 の中でも太くしない
  assert.ok(body(".c-band-count").includes("font-weight: var(--weight-normal)"));
  assert.ok(body('.c-deck[data-paged="true"] .c-col-head').includes("display: none"));
});

test("web components: c-deck.css の横送り（paged の 4 つと列の 2 つ、列の本体の縦の overscroll）。scroll-behavior・幅の段を書かない", () => {
  const rules = parseCss(read("c-deck.css"));
  const body = (sel: string): string => rules.filter((r) => r.at.length === 0 && r.selectors.includes(sel)).map((r) => r.body).join(" ");
  const paged = body('.c-deck[data-paged="true"]');
  for (const decl of ["grid-auto-columns: 100%", "scroll-snap-type: x mandatory", "overscroll-behavior-x: contain", "scrollbar-width: none"]) assert.ok(paged.includes(decl), decl);
  const col = body('.c-deck[data-paged="true"] > .c-col');
  for (const decl of ["scroll-snap-align: start", "scroll-snap-stop: always"]) assert.ok(col.includes(decl), decl);
  assert.ok(body(".c-col-body").includes("overscroll-behavior-y: contain"));
  const src = stripCssComments(read("c-deck.css"));
  assert.doesNotMatch(src, /(?<![-\w])(?:scroll-behavior|transition|animation)\s*:|@media \((?:min|max)-width/);
});

const DECK_PAGES = [
  { id: "turn", label: "あなたの番", count: 2 },
  { id: "tasks", label: "タスク", count: null },
  { id: "feed", label: "通知", count: null },
];

test("web components: bottomModel の deck は列 3 つと右腕の 4 つ。今の列は 1 つだけ（知らない page は先頭）、pages が配列でなければ右腕だけ。phone・wide は今と同じ", () => {
  assert.deepEqual(shell.bottomModel({ variant: "deck", pages: DECK_PAGES, page: "tasks", hand: "turn" }), {
    variant: "deck",
    items: [
      { act: "page", id: "turn", label: "あなたの番", name: "あなたの番（2 件）", count: 2, current: false },
      { act: "page", id: "tasks", label: "タスク", name: "タスク", count: 0, current: true },
      { act: "page", id: "feed", label: "通知", name: "通知", count: 0, current: false },
      { act: "hand", label: "右腕", name: shell.handLabel("turn"), mark: "turn" },
    ],
  });
  for (const page of ["x", undefined, null]) {
    const m = shell.bottomModel({ variant: "deck", pages: DECK_PAGES, page, hand: null });
    assert.deepEqual(m.items.filter((i) => i.current === true).map((i) => i.id), ["turn"], String(page));
  }
  const zero = shell.bottomModel({ variant: "deck", pages: [{ id: "turn", label: "あなたの番", count: 0 }, { id: "feed", label: "通知", count: 120 }], page: "feed", hand: "unread" });
  assert.deepEqual(zero.items.map((i) => i.name), ["あなたの番", "通知（99+ 件）", shell.handLabel("unread")]);
  for (const pages of [null, undefined, "x", { id: "turn" }]) {
    assert.deepEqual(shell.bottomModel({ variant: "deck", pages, page: "turn", hand: null }).items, [{ act: "hand", label: "右腕", name: shell.handLabel(null), mark: null }], String(pages));
  }
  // null・id の無い物は捨てる
  assert.deepEqual(shell.bottomModel({ variant: "deck", pages: [null, { label: "x" }, { id: "", label: "y" }, DECK_PAGES[2]], page: "turn" }).items.map((i) => [i.act, i.id, i.current]), [["page", "feed", true], ["hand", undefined, undefined]]);
  // phone・wide は deck の引数を渡しても今と同じ
  assert.deepEqual(shell.bottomModel({ variant: "phone", turns: 2, hand: "turn", pages: DECK_PAGES, page: "feed" }), shell.bottomModel({ variant: "phone", turns: 2, hand: "turn" }));
  assert.deepEqual(shell.bottomModel({ variant: "wide", tabs: [{ id: "tasks", title: "タスク" }], pages: DECK_PAGES }), shell.bottomModel({ variant: "wide", tabs: [{ id: "tasks", title: "タスク" }] }));
});

test("web components: BottomBar の deck（role・名前・data-variant、列のボタンの data-act・data-page・aria-current・aria-label、Badge は数のある列だけ、押すと on.page(id)、右腕は字「右腕」と on.hand）", () => {
  const calls: unknown[][] = [];
  const rec = (name: string) => (...a: unknown[]): void => void calls.push([name, ...a]);
  const on = { page: rec("page"), hand: rec("hand"), list: rec("list"), tab: rec("tab"), more: rec("more") };
  const v = shell.BottomBar({ variant: "deck", pages: [{ ...DECK_PAGES[0], count: 120 }, DECK_PAGES[1], DECK_PAGES[2]], page: "turn", hand: "turn", controls: "v3-hand", on }) as VNode;
  assert.deepEqual(keysOf(v.props.children), ["turn", "tasks", "feed", "hand"]);
  const bar = one(v);
  assert.deepEqual([bar.props.role, bar.props["aria-label"], bar.props["data-variant"]], ["group", "移動", "deck"]);
  const pages = find(bar, "c-bottom-page");
  assert.deepEqual(
    pages.map((b) => [b.type, b.props.type, b.props["data-act"], b.props["data-page"], b.props["aria-current"], b.props["aria-pressed"], b.props["aria-label"]]),
    [
      ["button", "button", "page", "turn", "true", undefined, "あなたの番（99+ 件）"],
      ["button", "button", "page", "tasks", undefined, undefined, "タスク"],
      ["button", "button", "page", "feed", undefined, undefined, "通知"],
    ],
  );
  // 直下は見える地の .c-bottom-page-in 1 つ（label と Badge はその中）
  for (const b of pages) assert.deepEqual(b.children.map((c) => (typeof c === "string" ? c : c.props.class)), ["c-bottom-page-in"]);
  assert.deepEqual(pages.map((b) => textOf(find(b, "c-bottom-page-label"))), ["あなたの番", "タスク", "通知"]);
  assert.deepEqual(pages.map((b) => find(b, "c-badge").map(textOf)), [["99+"], [], []]);
  assert.equal(find(bar, "c-bottom-btn").length + find(bar, "c-btn").length, 0);
  const hand = find(bar, "c-bottom-hand")[0] as El;
  assert.deepEqual([hand.props["data-act"], hand.props["aria-label"], hand.props["aria-controls"], hand.props["aria-expanded"]], ["hand", shell.handLabel("turn"), "v3-hand", undefined]);
  assert.equal(textOf(find(hand, "c-bottom-hand-label")), "右腕");
  assert.match(String(((find(hand, "c-icon")[0] as El).children[0] as El).props.href), /#bot$/);
  assert.equal(find(hand, "c-bottom-hand-mark")[0]?.props["data-state"], "turn");
  const y = { scrollIntoView: () => undefined };
  for (const b of pages) (b.props.onClick as (e: unknown) => void)(fakeEvent());
  (hand.props.onClick as (e: unknown) => void)({ currentTarget: y });
  assert.deepEqual(calls, [["page", "turn"], ["page", "tasks"], ["page", "feed"], ["hand", y]]);
  // 数なし・今の列が通知・印なし
  const quiet = one(html`<${shell.BottomBar} variant="deck" pages=${DECK_PAGES.map((p) => ({ ...p, count: null }))} page="feed" hand=${null} on=${on} />`);
  assert.equal(find(quiet, "c-badge").length, 0);
  assert.deepEqual(find(quiet, "c-bottom-page").map((b) => b.props["aria-current"]), [undefined, undefined, "true"]);
  assert.equal(find(quiet, "c-bottom-hand-mark").length, 0);
  assert.equal(find(quiet, "c-bottom-hand")[0]?.props["aria-controls"], undefined);
});

test("web components: TopBar の backLabel（無ければ「一覧へ」、空でない文字列ならその字。モデルの形は変えない）", () => {
  const { on } = topRec();
  const backOf = (o: Obj): unknown => find(one(html`<${shell.TopBar} ...${topProps(o)} on=${on} />`), "c-iconbtn")[0]?.props["aria-label"];
  assert.equal(backOf({}), "一覧へ");
  assert.equal(backOf({ backLabel: "戻る" }), "戻る");
  for (const backLabel of ["", null, 3]) assert.equal(backOf({ backLabel }), "一覧へ", String(backLabel));
  assert.deepEqual(shell.topModel(topProps({ backLabel: "戻る" })), shell.topModel(topProps()));
});

test("web components: c-shell.css の列のボタン（.c-bottom-page）は当たりの下限が --c-tap、今の列は太さと --muted の地。deck の右腕は中身の幅", () => {
  const rules = parseCss(read("c-shell.css"));
  const body = (sel: string): string => rules.filter((r) => r.at.length === 0 && r.selectors.includes(sel)).map((r) => r.body).join(" ");
  const page = body(".c-bottom-page");
  for (const decl of ["min-width: var(--c-tap)", "min-height: var(--c-tap)", "flex: 1 1 auto", "color: var(--text-secondary)"]) assert.ok(page.includes(decl), decl);
  // 当たりの箱（ボタン）は角丸なし・地なし。見える地と角丸は中の .c-bottom-page-in
  assert.doesNotMatch(page, /border-radius|background: var/);
  const inner = body(".c-bottom-page-in");
  for (const decl of ["min-height: var(--c-tap)", "border-radius: var(--radius-md)", "padding: 0 var(--space-2)", "box-sizing: border-box"]) assert.ok(inner.includes(decl), decl);
  const current = body('.c-bottom-page[aria-current="true"]');
  for (const decl of ["color: var(--text)", "font-weight: var(--weight-semibold)"]) assert.ok(current.includes(decl), decl);
  assert.ok(body('.c-bottom-page[aria-current="true"] .c-bottom-page-in').includes("background: var(--muted)"));
  assert.ok(body('.c-bottom[data-variant="deck"] .c-bottom-hand').includes("flex: 0 0 auto"));
  // deck のバーの間だけ狭く、ほかの variant の間は今のまま
  assert.ok(body('.c-bottom[data-variant="deck"]').includes("gap: var(--space-1)"));
  assert.ok(body(".c-bottom").includes("gap: var(--space-2)"));
  // :hover は細かい指の media の中だけ（cssProblems が見る）、線・影・::after は足さない
  assert.doesNotMatch(page + inner + current, /border:(?! 0)|box-shadow|transition|position/);
  assert.ok(!rules.some((r) => r.selectors.some((sel) => sel.includes("c-bottom-page") && sel.includes("::after"))));
});

test("web components: deck の列のボタンの焦点の輪は、四角い当たりの箱でなく中の .c-bottom-page-in に内側で出る（base.css の輪と同じ線）", () => {
  const rules = parseCss(read("c-shell.css"));
  const body = (sel: string): string => rules.filter((r) => r.at.length === 0 && r.selectors.includes(sel)).map((r) => r.body).join(" ");
  assert.equal(body(".c-bottom-page:focus-visible"), "outline: none;");
  const ring = body(".c-bottom-page:focus-visible .c-bottom-page-in");
  assert.ok(ring.includes("outline: var(--ring-width) solid var(--accent)"), ring);
  assert.ok(ring.includes("outline-offset: calc(-1 * var(--ring-width))"), ring);
  // 線は base.css の :focus-visible と同じ
  assert.match(readFileSync(join(ROOT, "templates/web/site/base.css"), "utf8"), /:focus-visible \{\s*outline: var\(--ring-width\) solid var\(--accent\);/);
});

test("web components: 入口の下のバーの 3 つの口（drawBar・page・focusBar）は #c-foot-root が在るときだけ SA.deck に足し、横送りの読み取りは scroll を capture・passive で 1 つ", () => {
  const app = stripJsComments(read("c-app.js"));
  assert.match(app, /const footRoot = document\.getElementById\("c-foot-root"\);/);
  const at = app.indexOf("Object.assign(window.SA.deck, { drawBar, page, focusBar });");
  assert.ok(at > 0, "3 つの口を足す行が無い");
  const guard = app.lastIndexOf("if (footRoot) {", at);
  assert.ok(guard > 0 && app.slice(guard, at).split("{").length === app.slice(guard, at).split("}").length + 1, "口を足すのが if (footRoot) の中でない");
  assert.equal([...app.matchAll(/window\.SA\.deck = /g)].length, 1);
  assert.match(app, /window\.SA\.deck = \{ draw: drawDeck, drawBand, fit: deckFit, focusItem, focusBand \};/);
  assert.equal([...app.matchAll(/addEventListener\("scroll"/g)].length, 1);
  assert.match(app.slice(guard, at), /deckRoot\.addEventListener\("scroll", onScroll, \{ capture: true, passive: true \}\);/);
  // 下のバーは deck の形で、列の名前は列のモデルから（入口に列の名前を書かない）
  assert.match(app, /<\$\{BottomBar\} variant="deck" pages=\$\{barPages\(\)\}/);
  assert.doesNotMatch(app, /"あなたの番"|"タスク"|"通知"/);
  // 送るのは scrollLeft を書くだけ（動かさない）
  assert.doesNotMatch(app, /scrollTo\(|scrollBy\(|scrollIntoView\(|behavior/);
});

test("web components: 入口の流れの列の焦点は、タスクの列だけ消えた項目と同じ種類（data-kind）で数え、行き先がリマインドなら操作の行の最後のボタン（［止める］）", () => {
  const app = stripJsComments(read("c-app.js"));
  // 種類を渡すのはタスクの列だけ（描く前と後の両方で同じ kind）
  assert.match(app, /const kind = col === "tasks" && holder \? holder\.dataset\.kind : undefined;/);
  assert.match(app, /const keysBefore = colKeys\(col, kind\);/);
  assert.match(app, /const keysAfter = colKeys\(col, kind\);/);
  assert.equal([...app.matchAll(/colKeys\(col\)/g)].length, 0);
  // 項目の種類を entries に入れて pressableKeys の第 2 引数へ
  assert.match(app, /key: n\.dataset\.key, kind: n\.dataset\.kind, pressable:/);
  assert.match(app, /^\s*kind,\n\s*\);/m);
  // リマインドは .c-item-ops の最後のボタン、ほかは今のまま最初の押せる物
  assert.match(app, /item\.dataset\.kind === "reminder" \? item\.querySelector\("\.c-item-ops button:last-child"\) : item\.querySelector\("button, a\[href\]"\)/);
  // 焦点のあった物が残っているのに焦点だけ外れたら（並び替えで節が動いた。moveBefore の無いブラウザ）、同じ物へ戻す（消えた物の道の else）
  assert.match(app, /if \(!moved\) focusBand\("find"\);\n\s*\} else if \(inside && document\.activeElement !== before\) \{\n(?:\s*\/\/.*\n)*\s*before\.focus\(\);\n\s*\}/);
});
