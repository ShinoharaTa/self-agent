// 認証コードの読み取り（docs/plan/guest-mode.md §3.2.2）。純関数
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { stripBotMention } from "../src/guest/handler.ts";
import { generateInviteCode, parseInviteCode } from "../src/guest/invite-code.ts";

const CODE = "guest-0123-4567-89ab-cdef-ghjk-mnpq";

test("parseInviteCode: 正しい形のコードはそのまま返し、生成したコードも読める", () => {
  assert.equal(parseInviteCode(CODE), CODE);
  for (let index = 0; index < 20; index++) {
    const code = generateInviteCode(randomBytes);
    assert.equal(parseInviteCode(code), code);
  }
});

test("parseInviteCode: 前後の空白・改行と、両端の 1 組のバッククォートを除く", () => {
  assert.equal(parseInviteCode(`  ${CODE}\n`), CODE);
  assert.equal(parseInviteCode(`\`${CODE}\``), CODE);
  assert.equal(parseInviteCode(` \`${CODE}\` `), CODE);
  // 片側だけ・2 組は合わない
  assert.equal(parseInviteCode(`\`${CODE}`), undefined);
  assert.equal(parseInviteCode(`\`\`${CODE}\`\``), undefined);
});

test("parseInviteCode: 大文字小文字を区別しない（小文字にして返す）", () => {
  assert.equal(parseInviteCode(CODE.toUpperCase()), CODE);
  assert.equal(parseInviteCode("Guest-0123-4567-89AB-cdef-GHJK-mnpq"), CODE);
});

test("parseInviteCode: メンションは呼び出し側が stripBotMention で除いた前提で、除いた後なら読める（除かなければ合わない）", () => {
  assert.equal(parseInviteCode(`<@bot-1> ${CODE}`), undefined);
  assert.equal(parseInviteCode(stripBotMention(`<@bot-1> ${CODE}`, "bot-1")), CODE);
  assert.equal(parseInviteCode(stripBotMention(`<@!bot-1> ${CODE}`, "bot-1")), CODE);
  // 別の人へのメンションは除かれないので合わない
  assert.equal(parseInviteCode(stripBotMention(`<@user-2> ${CODE}`, "bot-1")), undefined);
});

test("parseInviteCode: 余計な文字・使わない字・区切りの違い・長さの違い・空は undefined", () => {
  for (const text of [
    "",
    "   ",
    `コードです ${CODE}`,
    `${CODE} です`,
    `${CODE}.`,
    // i l o u は使わない
    "guest-0123-4567-89ab-cdef-ghjk-mnpi",
    "guest-0123-4567-89ab-cdef-ghjk-mnpl",
    "guest-0123-4567-89ab-cdef-ghjk-mnpo",
    "guest-0123-4567-89ab-cdef-ghjk-mnpu",
    "guest-0123-4567-89ab-cdef-ghjk",
    "guest-0123-4567-89ab-cdef-ghjk-mnpq-rstv",
    "guest-01234567-89ab-cdef-ghjk-mnpq",
    "guest_0123-4567-89ab-cdef-ghjk-mnpq",
    "0123-4567-89ab-cdef-ghjk-mnpq",
    `${CODE}\n${CODE}`,
    "guest-0123-4567-89ab-cdef-ghjk-mnp q",
  ]) {
    assert.equal(parseInviteCode(text), undefined, text);
  }
});
