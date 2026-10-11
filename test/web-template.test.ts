import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { WEB_TEMPLATE_DIR } from "../src/agent/scaffold.ts";

const read = (file: string): string => readFileSync(join(WEB_TEMPLATE_DIR, file), "utf8");

/** 色の変数（ダークモードで差し替える） */
const COLOR_VARIABLES = [
  "--bg",
  "--surface",
  "--muted",
  "--border",
  "--text",
  "--text-muted",
  "--primary",
  "--primary-text",
  "--accent",
  "--danger",
  "--success",
  "--warning",
];
/** 値まで決めている変数 */
const FIXED_VARIABLES: Record<string, string> = {
  "--space-1": "4px",
  "--space-2": "8px",
  "--space-3": "12px",
  "--space-4": "16px",
  "--space-5": "20px",
  "--space-6": "24px",
  "--space-7": "32px",
  "--space-8": "48px",
  "--font-family": 'system-ui, "Hiragino Sans", "Noto Sans JP", sans-serif',
  "--font-xs": "12px",
  "--font-sm": "14px",
  "--font-base": "16px",
  "--font-lg": "18px",
  "--font-xl": "20px",
  "--font-2xl": "24px",
  "--leading-normal": "1.5",
  "--leading-tight": "1.25",
  "--weight-normal": "400",
  "--weight-medium": "500",
  "--weight-semibold": "600",
  "--radius-sm": "6px",
  "--radius-md": "8px",
  "--radius-lg": "12px",
  "--radius-full": "9999px",
  "--tap": "44px",
  "--icon-size": "20px",
  "--container-max": "640px",
};
/** base.css の部品のクラス（DESIGN.md の「部品」） */
const CLASSES = [
  "container",
  "stack",
  "row",
  "card",
  "btn",
  "btn-primary",
  "btn-secondary",
  "btn-ghost",
  "btn-danger",
  "input",
  "select",
  "textarea",
  "check",
  "chip",
  "badge",
  "list",
  "list-item",
  "segmented",
  "empty",
  "toast",
  "bottom-bar",
  "icon",
];
const ICON_SYMBOL_ATTRIBUTES =
  'viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"';

/** DESIGN.md の `.class` のうち、クラスでない拡張子 */
const FILE_EXTENSIONS = new Set(["css", "md", "svg", "html", "js", "json"]);

function stripComments(css: string): string {
  return css.replace(/\/\*[\s\S]*?\*\//g, "");
}

/** 中に { を含まないブロック（@media の中の規則を含む）を、セレクタの一覧と宣言にする */
function rules(css: string): Array<{ selectors: string[]; declarations: Map<string, string> }> {
  return [...stripComments(css).matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((match) => ({
    selectors: match[1].split(",").map((selector) => selector.trim().replace(/\s+/g, " ")),
    declarations: new Map(
      [...match[2].matchAll(/([\w-]+):\s*([^;]+);/g)].map((declaration) => [declaration[1], declaration[2].trim()]),
    ),
  }));
}

/** selector にそのまま当たる規則のうち、最後に property を決めている値 */
function lastValue(css: string, selector: string, property: string): string | undefined {
  let value: string | undefined;
  for (const rule of rules(css)) {
    if (rule.selectors.includes(selector) && rule.declarations.has(property)) value = rule.declarations.get(property);
  }
  return value;
}

/** `#rrggbb` の相対輝度（WCAG 2） */
function luminance(hex: string): number {
  const match = hex.match(/^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i);
  assert.ok(match !== null, hex);
  const [r, g, b] = match.slice(1).map((part) => {
    const channel = Number.parseInt(part, 16) / 255;
    return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrast(a: string, b: string): number {
  const [light, dark] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (light + 0.05) / (dark + 0.05);
}

/** `--name: value;` の宣言を名前 → 値にする */
function declarations(block: string): Map<string, string> {
  return new Map([...block.matchAll(/(--[\w-]+):\s*([^;]+);/g)].map((match) => [match[1], match[2].trim()]));
}

/** 最初の `:root {` のブロックと、`@media (prefers-color-scheme: dark)` の中の `:root {` のブロック */
function rootBlocks(css: string): { light: string; dark: string } {
  const light = css.match(/^:root \{([\s\S]*?)^\}/m);
  const dark = css.match(/^@media \(prefers-color-scheme: dark\) \{\s*:root \{([\s\S]*?)^ {2}\}/m);
  assert.ok(light !== null, ":root のブロックが無い");
  assert.ok(dark !== null, "prefers-color-scheme: dark の差し替えが無い");
  return { light: light[1], dark: dark[1] };
}

test("base.css: 決めた変数がすべて :root にあり、余白・文字・角丸などは決めた値", () => {
  const { light } = rootBlocks(stripComments(read("site/base.css")));
  const defined = declarations(light);

  for (const name of [...COLOR_VARIABLES, "--shadow-sm"]) assert.ok(defined.has(name), name);
  for (const [name, value] of Object.entries(FIXED_VARIABLES)) assert.equal(defined.get(name), value, name);
  assert.match(light, /color-scheme: light dark;/);
});

test("base.css: prefers-color-scheme: dark で色の変数をすべて差し替える", () => {
  const { light, dark } = rootBlocks(stripComments(read("site/base.css")));
  const lightValues = declarations(light);
  const darkValues = declarations(dark);

  for (const name of COLOR_VARIABLES) {
    assert.ok(darkValues.has(name), name);
    assert.notEqual(darkValues.get(name), lightValues.get(name), name);
  }
  // 差し替えるのは色と影だけ
  for (const name of darkValues.keys()) assert.ok(lightValues.has(name), name);
});

test("base.css: 部品のクラスと <dialog> がすべてある", () => {
  const css = stripComments(read("site/base.css"));

  for (const name of CLASSES) assert.match(css, new RegExp(`\\.${name}(?![\\w-])`), name);
  assert.match(css, /^dialog \{/m);
  assert.match(css, /^dialog::backdrop \{/m);
});

test("base.css: 押せる部品は min-height: var(--tap)、入力欄の文字は var(--font-base)", () => {
  const css = read("site/base.css");

  for (const selector of [".btn", ".input", ".select", ".textarea", ".chip", ".check", ".segmented > button", ".list-item"]) {
    assert.equal(lastValue(css, selector, "min-height"), "var(--tap)", selector);
  }
  for (const selector of [".input", ".select", ".textarea"]) {
    assert.equal(lastValue(css, selector, "font-size"), "var(--font-base)", selector);
  }
});

test("base.css: ライトの --danger・--success・--warning は --bg と --surface に対してコントラスト比 4.5 以上", () => {
  const values = declarations(rootBlocks(stripComments(read("site/base.css"))).light);

  for (const name of ["--danger", "--success", "--warning"]) {
    for (const background of ["--bg", "--surface"]) {
      const ratio = contrast(values.get(name)!, values.get(background)!);
      assert.ok(ratio >= 4.5, `${name} / ${background}: ${ratio.toFixed(2)}`);
    }
  }
});

test("base.css: 色と px の値は変数の定義の中だけ。.icon は currentColor の線で、動きを減らす設定なら transition を切る", () => {
  const css = stripComments(read("site/base.css"));
  const outsideDefinitions = css.replace(/--[\w-]+:\s*[^;]+;/g, "");

  assert.doesNotMatch(outsideDefinitions, /\d(\.\d+)?px/);
  assert.doesNotMatch(outsideDefinitions, /#[0-9a-f]{3,8}\b/i);
  assert.doesNotMatch(outsideDefinitions, /\b(rgba?|hsla?|oklch|hwb|lab|lch)\(/);
  assert.match(css, /\.icon \{[^}]*stroke: currentColor;[^}]*fill: none;[^}]*\}/);
  assert.match(css, /@media \(prefers-reduced-motion: reduce\) \{[^@]*transition: none !important;/);
});

test("DESIGN.md: 100 行以内で、出てくる変数と .class（拡張子を除く）はすべて base.css にある", () => {
  const design = read("DESIGN.md");
  const lines = design.split("\n").length - (design.endsWith("\n") ? 1 : 0);
  assert.ok(lines <= 100, `${lines} 行`);

  assert.match(design, /\n## 使い勝手\n/);
  for (const word of ["取り消し優先", "autofocus", "空状態", "位置の把握", "色の役割", "失敗の表示", "ダイアログ:", "一覧の行"]) assert.ok(design.includes(word), word);

  const css = stripComments(read("site/base.css"));
  const defined = declarations(css);
  for (const [name] of design.matchAll(/--[a-z0-9-]*[a-z0-9]/g)) assert.ok(defined.has(name), name);
  const classes = [...design.matchAll(/\.([a-z][a-z0-9-]*)/g)].map((match) => match[1]).filter((name) => !FILE_EXTENSIONS.has(name));
  assert.ok(classes.length > 0);
  for (const name of new Set(classes)) assert.match(css, new RegExp(`\\.${name}(?![\\w-])`), name);
});

test("icons.svg: DESIGN.md に列挙したアイコン名と symbol の id が一致し、symbol は Lucide と同じ線の属性。先頭のコメントに出典と ISC ライセンス", () => {
  const design = read("DESIGN.md");
  const sprite = read("site/icons.svg");
  const listed = design.match(/^- 入っている名前: (.+)$/m);
  assert.ok(listed !== null, "DESIGN.md にアイコン名の一覧が無い");
  const names = listed[1].split(", ");
  const ids = [...sprite.matchAll(/<symbol id="([^"]+)"/g)].map((match) => match[1]);

  assert.equal(names.length, 20);
  assert.deepEqual([...ids].sort(), [...names].sort());
  for (const [tag] of sprite.matchAll(/<symbol [^>]*>/g)) assert.ok(tag.endsWith(` ${ICON_SYMBOL_ATTRIBUTES}>`), tag);
  // XML のコメントの中に -- は書けない（書くと sprite 全体が読めなくなる）
  const comment = sprite.match(/^<!--([\s\S]*?)-->/);
  assert.ok(comment !== null, "先頭のコメントが無い");
  assert.ok(!comment[1].includes("--"));
  assert.ok(comment[1].includes("lucide-static 1.55.0"));
  assert.ok(comment[1].includes("ISC License"));
});

test("index.html: viewport・color-scheme と、base.css → app.css の順の link、空の main.container.stack", () => {
  const html = read("site/index.html");

  assert.ok(html.startsWith("<!doctype html>\n<html lang=\"ja\">"));
  assert.ok(html.includes('<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">'));
  assert.ok(html.includes('<meta name="color-scheme" content="light dark">'));
  const base = html.indexOf('<link rel="stylesheet" href="base.css">');
  const app = html.indexOf('<link rel="stylesheet" href="app.css">');
  assert.ok(base !== -1 && app !== -1 && base < app);
  assert.ok(html.includes('<main class="container stack"></main>'));
});
