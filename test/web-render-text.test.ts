import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

// 返事の最小限の Markdown（src/web/static/ui.js の parseBlocks・parseInline。docs/plan/web-ui-polish.md の UI-11）。DOM は使わず構造だけを見る
type Inline = { type: string; text: string };
type Ui = { parseBlocks: (text: string) => unknown[]; parseInline: (text: string) => Inline[] };

function loadUi(): Ui {
  const context = { window: {} as Record<string, unknown>, document: {}, Intl, Date, Number };
  vm.runInNewContext(readFileSync(fileURLToPath(new URL("../src/web/static/ui.js", import.meta.url)), "utf8"), context);
  return (context.window as { SA: { ui: Ui } }).SA.ui;
}

const ui = loadUi();
// vm の中で作った配列・オブジェクトは別の realm なので、JSON で通してから比べる
const blocks = (text: string): unknown => JSON.parse(JSON.stringify(ui.parseBlocks(text)));
const inline = (text: string): unknown => JSON.parse(JSON.stringify(ui.parseInline(text)));

test("renderText: プレーンな段落は空行で分け、段落の中の改行は残す", () => {
  assert.deepEqual(blocks("一行目\n二行目\n\n次の段落"), [
    { type: "paragraph", text: "一行目\n二行目" },
    { type: "paragraph", text: "次の段落" },
  ]);
  assert.deepEqual(blocks(""), []);
});

test("renderText: 見出しは # 〜 ### だけ。#### と # の後に空白の無いものは文字のまま", () => {
  assert.deepEqual(blocks("# 大\n## 中\n### 小\n#### 4 段\n#タグ"), [
    { type: "heading", text: "大" },
    { type: "heading", text: "中" },
    { type: "heading", text: "小" },
    { type: "paragraph", text: "#### 4 段\n#タグ" },
  ]);
});

test("renderText: 箇条書き（- * と番号）。入れ子は 1 段までで、それより深いものも同じ段", () => {
  assert.deepEqual(blocks("- a\n* b\n  - b1\n      - b2\n\n3. x\n4. y\n- z"), [
    {
      type: "list",
      ordered: false,
      start: 1,
      items: [
        { text: "a", children: null },
        { text: "b", children: { ordered: false, start: 1, items: [{ text: "b1" }, { text: "b2" }] } },
      ],
    },
    { type: "list", ordered: true, start: 3, items: [{ text: "x", children: null }, { text: "y", children: null }] },
    { type: "list", ordered: false, start: 1, items: [{ text: "z", children: null }] },
  ]);
  // 区切り線・太字の行は箇条書きにしない
  assert.deepEqual(blocks("---\n**太字**"), [{ type: "paragraph", text: "---\n**太字**" }]);
});

test("renderText: フェンスは中身をそのまま code に（情報文字列は使わない）", () => {
  assert.deepEqual(blocks("前\n```ts\nconst a = 1;\n  **b**\n```\n後"), [
    { type: "paragraph", text: "前" },
    { type: "code", text: "const a = 1;\n  **b**" },
    { type: "paragraph", text: "後" },
  ]);
});

test("renderText: 閉じないフェンスは末尾までコード（後ろの - や # を箇条書き・見出しにしない）", () => {
  assert.deepEqual(blocks("前\n```\nconst a = 1;\n- item\n# comment"), [
    { type: "paragraph", text: "前" },
    { type: "code", text: "const a = 1;\n- item\n# comment" },
  ]);
});

test("renderText: フェンスの中の - # 1. はそのまま", () => {
  assert.deepEqual(blocks("```\n- a\n# b\n1. c\n```"), [{ type: "code", text: "- a\n# b\n1. c" }]);
});

test("renderText: CRLF は LF として読む", () => {
  assert.deepEqual(blocks("# 題\r\n- a\r\n```\r\nx\r\n```\r\n本文"), [
    { type: "heading", text: "題" },
    { type: "list", ordered: false, start: 1, items: [{ text: "a", children: null }] },
    { type: "code", text: "x" },
    { type: "paragraph", text: "本文" },
  ]);
});

test("renderText: 「- 」だけ・「# 」だけの行は文字のまま", () => {
  assert.deepEqual(blocks("- \n# "), [{ type: "paragraph", text: "- \n# " }]);
});

test("renderText: 入れ子の番号は最初の項目の番号から始まる", () => {
  assert.deepEqual(blocks("1. a\n   3. b"), [
    { type: "list", ordered: true, start: 1, items: [{ text: "a", children: { ordered: true, start: 3, items: [{ text: "b" }] } }] },
  ]);
});

test("renderText: 全角の ＊＊ と全角の空白で字下げした - は文字のまま", () => {
  assert.deepEqual(blocks("＊＊太＊＊\n　- a"), [{ type: "paragraph", text: "＊＊太＊＊\n　- a" }]);
  assert.deepEqual(inline("＊＊太＊＊"), [{ type: "text", text: "＊＊太＊＊" }]);
});

test("renderText: 表・引用はそのまま文字", () => {
  assert.deepEqual(blocks("| a | b |\n|---|---|\n> 引用"), [{ type: "paragraph", text: "| a | b |\n|---|---|\n> 引用" }]);
});

test("renderText: 太字とインラインコード。閉じない ** は文字のまま", () => {
  assert.deepEqual(inline("前 **太** と `x` 後"), [
    { type: "text", text: "前 " },
    { type: "strong", text: "太" },
    { type: "text", text: " と " },
    { type: "code", text: "x" },
    { type: "text", text: " 後" },
  ]);
  assert.deepEqual(inline("閉じない **太字"), [{ type: "text", text: "閉じない **太字" }]);
  assert.deepEqual(inline("****"), [{ type: "text", text: "****" }]);
  // コードの中の ** は太字にしない
  assert.deepEqual(inline("`**a**`"), [{ type: "code", text: "**a**" }]);
});

test("renderText: 太字が 2 つ並ぶ", () => {
  assert.deepEqual(inline("**a** **b**"), [
    { type: "strong", text: "a" },
    { type: "text", text: " " },
    { type: "strong", text: "b" },
  ]);
});

test("renderText: URL の中の ** や ` で URL は切れない。太字の中の URL は太字のまま", () => {
  assert.deepEqual(inline("見て https://a.example/**x**`y` 終"), [
    { type: "text", text: "見て " },
    { type: "link", text: "https://a.example/**x**`y`" },
    { type: "text", text: " 終" },
  ]);
  assert.deepEqual(inline("**https://a.example/x**"), [{ type: "strong", text: "https://a.example/x" }]);
});
