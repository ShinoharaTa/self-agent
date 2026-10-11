import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { WEB_TEMPLATE_DIR } from "../src/agent/scaffold.ts";

const read = (file: string): string => readFileSync(join(WEB_TEMPLATE_DIR, file), "utf8");

const ICON_SYMBOL_ATTRIBUTES =
  'viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"';

/** DESIGN.md の `.class` のうち、クラスでない拡張子 */
const FILE_EXTENSIONS = new Set(["css", "md", "svg", "html", "js", "json"]);

function stripComments(css: string): string {
  return css.replace(/\/\*[\s\S]*?\*\//g, "");
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

test("base.css: prefers-color-scheme: dark で色の変数（ライトの値が #rrggbb のもの）をすべて差し替える", () => {
  const { light, dark } = rootBlocks(stripComments(read("site/base.css")));
  const lightValues = declarations(light);
  const darkValues = declarations(dark);
  const colors = [...lightValues].filter(([, value]) => /^#[0-9a-f]{6}$/i.test(value)).map(([name]) => name);

  assert.match(light, /color-scheme: light dark;/);
  assert.ok(colors.length > 0);
  for (const name of colors) {
    assert.ok(darkValues.has(name), name);
    assert.notEqual(darkValues.get(name), lightValues.get(name), name);
  }
  // 差し替えるのはライトにある変数だけ
  for (const name of darkValues.keys()) assert.ok(lightValues.has(name), name);
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

test("DESIGN.md: 100 行以内で「使い勝手」の節があり、出てくる変数と .class（拡張子を除く）はすべて base.css にある", () => {
  const design = read("DESIGN.md");
  const lines = design.split("\n").length - (design.endsWith("\n") ? 1 : 0);
  assert.ok(lines <= 100, `${lines} 行`);

  assert.match(design, /\n## 使い勝手\n/);

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

  assert.ok(names.length > 0);
  assert.deepEqual([...ids].sort(), [...names].sort());
  for (const [tag] of sprite.matchAll(/<symbol [^>]*>/g)) assert.ok(tag.endsWith(` ${ICON_SYMBOL_ATTRIBUTES}>`), tag);
  // XML のコメントの中に -- は書けない（書くと sprite 全体が読めなくなる）
  const comment = sprite.match(/^<!--([\s\S]*?)-->/);
  assert.ok(comment !== null, "先頭のコメントが無い");
  assert.ok(!comment[1].includes("--"));
  assert.ok(comment[1].includes("lucide"));
  assert.ok(comment[1].includes("ISC License"));
});
