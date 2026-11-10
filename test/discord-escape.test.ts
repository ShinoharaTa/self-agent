import { test } from "node:test";
import assert from "node:assert/strict";
import { escapeDiscordText } from "../src/discord/escape.ts";

test("escapeDiscordText: Markdown・メンション・リンクの文字の前に \\ を 1 つ置く", () => {
  for (const char of ["\\", "*", "_", "~", "`", "|", ">", "#", "[", "]", "(", ")", "<", ":", "@", "-"]) {
    assert.equal(escapeDiscordText(char), `\\${char}`, char);
  }
});

test("escapeDiscordText: それ以外の文字（英数字・日本語・空白・改行・. / ! など）は変えない", () => {
  const plain = "abc XYZ 123 日本語の題名 . / ! ? = + & % $ ' \" , ; {}\n2 行目";
  assert.equal(escapeDiscordText(plain), plain);
  assert.equal(escapeDiscordText(""), "");
});

test("escapeDiscordText: メンション・強調・masked link・コード・見出しを文字のままにする", () => {
  assert.equal(escapeDiscordText("@everyone"), "\\@everyone");
  assert.equal(escapeDiscordText("<@123>"), "\\<\\@123\\>");
  assert.equal(escapeDiscordText("**太字** __下線__ ~~消し~~ ||伏せ||"), "\\*\\*太字\\*\\* \\_\\_下線\\_\\_ \\~\\~消し\\~\\~ \\|\\|伏せ\\|\\|");
  assert.equal(escapeDiscordText("[click](https://example.com)"), "\\[click\\]\\(https\\://example.com\\)");
  assert.equal(escapeDiscordText("`code`"), "\\`code\\`");
  assert.equal(escapeDiscordText("# 見出し\n> 引用\n- 箇条"), "\\# 見出し\n\\> 引用\n\\- 箇条");
});

test("escapeDiscordText: 既にある \\ も無効にする（エスケープを外させない）", () => {
  assert.equal(escapeDiscordText("\\*"), "\\\\\\*");
  assert.equal(escapeDiscordText("a\\b"), "a\\\\b");
});
