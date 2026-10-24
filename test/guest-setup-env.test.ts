import { test } from "node:test";
import assert from "node:assert/strict";
import {
  extractDiscordBotId,
  GUEST_ENV_KEYS,
  upsertEnvLines,
  validateApiKey,
  validateDiscordToken,
  validateGuildIds,
} from "../src/guest/setup-env.ts";

// 明らかな偽物の値だけを使う
const TOKEN = "aaa.bbb.ccc";
const API_KEY = "sk-ant-dummy-key-for-tests";
const GUILD_A = "10000000000000000";
const GUILD_B = "20000000000000000";
const ENTRIES = [
  ["SELF_AGENT_GUEST_DISCORD_TOKEN", "aaa.bbb.ccc"],
  ["SELF_AGENT_GUEST_GUILD_IDS", GUILD_A],
  ["SELF_AGENT_GUEST_API_KEY", API_KEY],
] as const;
const COMMENT = "# guest mode (npm run guest-setup)";

test("GUEST_ENV_KEYS: 3 つの変数の順", () => {
  assert.deepEqual(GUEST_ENV_KEYS, [
    "SELF_AGENT_GUEST_DISCORD_TOKEN",
    "SELF_AGENT_GUEST_GUILD_IDS",
    "SELF_AGENT_GUEST_API_KEY",
  ]);
});

test("validateDiscordToken: . で 3 つに分かれた ASCII の値は通る（前後の空白は除いて見る）", () => {
  assert.equal(validateDiscordToken(TOKEN), undefined);
  assert.equal(validateDiscordToken("  a-b_c.d-e.f_g  "), undefined);
});

test("validateDiscordToken: 空・空白・#・引用符・\\・形の違い・ASCII 以外は理由を返す", () => {
  for (const value of [
    "",
    "   ",
    "aaa.b b.ccc",
    "aaa.b\tb.ccc",
    "aaa.b\nb.ccc",
    "aaa.bbb.ccc#x",
    'aaa."bbb".ccc',
    "aaa.'bbb'.ccc",
    "aaa.`bbb`.ccc",
    "aaa.b\\b.ccc",
    "aaabbbccc",
    "aaa.bbb",
    "aaa.bbb.ccc.ddd",
    "aaa..ccc",
    ".bbb.ccc",
    "aaa.bbb.",
    "aaa.bあb.ccc",
  ]) {
    assert.equal(typeof validateDiscordToken(value), "string", JSON.stringify(value));
  }
});

test("validateGuildIds: trim・空の要素を除き、重複は 1 つに", () => {
  assert.deepEqual(validateGuildIds(` ${GUILD_A} ,,${GUILD_B}, ${GUILD_A} `, []), {
    ok: true,
    ids: [GUILD_A, GUILD_B],
  });
  assert.deepEqual(validateGuildIds("12345678901234567890", []), { ok: true, ids: ["12345678901234567890"] });
});

test("validateGuildIds: 空・桁数・数字以外は通らない", () => {
  for (const value of ["", " , ,", "1234567890123456", "123456789012345678901", `${GUILD_A},abc`, `${GUILD_A}x`]) {
    const result = validateGuildIds(value, []);
    assert.equal(result.ok, false, JSON.stringify(value));
  }
});

test("validateGuildIds: SELF_AGENT_ALLOWED_GUILD_IDS と重なれば通らない", () => {
  const result = validateGuildIds(`${GUILD_A},${GUILD_B}`, [GUILD_B]);
  assert.equal(result.ok, false);
  assert.ok(!result.ok && result.reason.includes("SELF_AGENT_ALLOWED_GUILD_IDS と重なっています"));
  assert.ok(!result.ok && !result.reason.includes(GUILD_B));
});

test("validateApiKey: sk-ant- で始まる 20 字以上の ASCII は通る", () => {
  assert.equal(validateApiKey(API_KEY), undefined);
  assert.equal(validateApiKey(`  ${API_KEY}  `), undefined);
});

test("validateApiKey: 空・前置き・短さ・空白・#・引用符・\\・ASCII 以外は理由を返す", () => {
  for (const value of [
    "",
    "  ",
    "sk-dummy-key-for-tests-xx",
    "sk-ant-short",
    "sk-ant-dummy key-for-tests",
    "sk-ant-dummy-key-for-tests#",
    'sk-ant-dummy-key-"for"-tests',
    "sk-ant-dummy-key-'for'-tests",
    "sk-ant-dummy-key-for\\-tests",
    "sk-ant-dummy-key-for-testsあ",
  ]) {
    assert.equal(typeof validateApiKey(value), "string", JSON.stringify(value));
  }
});

test("upsertEnvLines: 空のファイルにはコメント 1 行と 3 つの変数を足し、改行で終える", () => {
  const result = upsertEnvLines("", ENTRIES);
  assert.equal(
    result.text,
    `${COMMENT}\nSELF_AGENT_GUEST_DISCORD_TOKEN=aaa.bbb.ccc\nSELF_AGENT_GUEST_GUILD_IDS=${GUILD_A}\nSELF_AGENT_GUEST_API_KEY=${API_KEY}\n`,
  );
  assert.deepEqual(result.replaced, []);
  assert.deepEqual(result.appended, [...GUEST_ENV_KEYS]);
});

test("upsertEnvLines: 末尾に改行が無いファイルには 1 つ補ってから足す", () => {
  const result = upsertEnvLines("DISCORD_TOKEN=x", ENTRIES);
  assert.ok(result.text.startsWith(`DISCORD_TOKEN=x\n${COMMENT}\n`));
  assert.ok(result.text.endsWith("\n"));
  const ended = upsertEnvLines("DISCORD_TOKEN=x\n", ENTRIES);
  assert.ok(ended.text.startsWith(`DISCORD_TOKEN=x\n${COMMENT}\n`));
});

test("upsertEnvLines: export 付き・先頭に空白の行を置き換え、2 行目以降の同じ変数の行は消す", () => {
  const text = [
    "# my env",
    "export SELF_AGENT_GUEST_DISCORD_TOKEN=old.old.old",
    "",
    "  SELF_AGENT_GUEST_GUILD_IDS=1",
    "DISCORD_TOKEN=x",
    "\tSELF_AGENT_GUEST_API_KEY=old",
    "SELF_AGENT_GUEST_DISCORD_TOKEN=older.older.older",
    "OTHER=1",
    "",
  ].join("\n");
  const result = upsertEnvLines(text, ENTRIES);
  assert.equal(
    result.text,
    [
      "# my env",
      "SELF_AGENT_GUEST_DISCORD_TOKEN=aaa.bbb.ccc",
      "",
      `SELF_AGENT_GUEST_GUILD_IDS=${GUILD_A}`,
      "DISCORD_TOKEN=x",
      `SELF_AGENT_GUEST_API_KEY=${API_KEY}`,
      "OTHER=1",
      "",
    ].join("\n"),
  );
  assert.deepEqual(result.replaced, [...GUEST_ENV_KEYS]);
  assert.deepEqual(result.appended, []);
  // 置き換えだけならコメントは足さない
  assert.ok(!result.text.includes(COMMENT));
});

test("upsertEnvLines: コメント行の中の KEY= は置き換えず、名前が前に一致するだけの変数も触らない", () => {
  const text = [
    "# SELF_AGENT_GUEST_API_KEY=commented",
    "  # export SELF_AGENT_GUEST_DISCORD_TOKEN=commented",
    "SELF_AGENT_GUEST_API_KEY_OLD=1",
    "XSELF_AGENT_GUEST_GUILD_IDS=1",
  ].join("\n");
  const result = upsertEnvLines(text, ENTRIES);
  assert.ok(result.text.startsWith(`${text}\n${COMMENT}\n`));
  assert.deepEqual(result.replaced, []);
  assert.deepEqual(result.appended, [...GUEST_ENV_KEYS]);
});

test("upsertEnvLines: ほかの行（空行・コメント・CR を含む行・順）は変えず、追加のときだけコメントを 1 回置く", () => {
  const text = "A=1\r\n\n# note\nSELF_AGENT_GUEST_GUILD_IDS=1\nB=\"quoted value\"\n";
  const result = upsertEnvLines(text, ENTRIES);
  assert.equal(
    result.text,
    `A=1\r\n\n# note\nSELF_AGENT_GUEST_GUILD_IDS=${GUILD_A}\nB="quoted value"\n` +
      `${COMMENT}\nSELF_AGENT_GUEST_DISCORD_TOKEN=aaa.bbb.ccc\nSELF_AGENT_GUEST_API_KEY=${API_KEY}\n`,
  );
  assert.deepEqual(result.replaced, ["SELF_AGENT_GUEST_GUILD_IDS"]);
  assert.deepEqual(result.appended, ["SELF_AGENT_GUEST_DISCORD_TOKEN", "SELF_AGENT_GUEST_API_KEY"]);
  assert.equal(result.text.split(COMMENT).length, 2);
});

test("extractDiscordBotId: 最初の部分の base64 が数字なら取れる", () => {
  const id = "123456789012345678";
  assert.equal(extractDiscordBotId(`${Buffer.from(id).toString("base64")}.bbb.ccc`), id);
  assert.equal(extractDiscordBotId(`${Buffer.from(id).toString("base64url")}.bbb.ccc`), id);
});

test("extractDiscordBotId: 数字でない・空・壊れたものは undefined で投げない", () => {
  assert.equal(extractDiscordBotId(TOKEN), undefined);
  assert.equal(extractDiscordBotId(""), undefined);
  assert.equal(extractDiscordBotId(".bbb.ccc"), undefined);
  assert.equal(extractDiscordBotId(`${Buffer.from("abc").toString("base64")}.bbb.ccc`), undefined);
  assert.equal(extractDiscordBotId("!!!@@@.bbb.ccc"), undefined);
});
