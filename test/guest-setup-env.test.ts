import { test } from "node:test";
import assert from "node:assert/strict";
import {
  extractDiscordBotId,
  GUEST_DEPRECATED_ENV_KEYS,
  GUEST_ENV_KEYS,
  removeEnvLines,
  upsertEnvLines,
  validateApiKey,
  validateDiscordToken,
} from "../src/guest/setup-env.ts";

// 明らかな偽物の値だけを使う
const TOKEN = "aaa.bbb.ccc";
const API_KEY = "sk-ant-dummy-key-for-tests";
const GUILD_A = "10000000000000000";
// upsertEnvLines は変数の名前によらないので、3 つの変数で試す
const ENTRIES = [
  ["SELF_AGENT_GUEST_DISCORD_TOKEN", "aaa.bbb.ccc"],
  ["SELF_AGENT_GUEST_GUILD_IDS", GUILD_A],
  ["SELF_AGENT_GUEST_API_KEY", API_KEY],
] as const;
const ENTRY_KEYS = ENTRIES.map(([key]) => key);
const COMMENT = "# guest mode (npm run guest-setup)";

test("GUEST_ENV_KEYS: 2 つの変数の順（サーバー ID は訊かない）。廃止した変数は SELF_AGENT_GUEST_GUILD_IDS", () => {
  assert.deepEqual(GUEST_ENV_KEYS, ["SELF_AGENT_GUEST_DISCORD_TOKEN", "SELF_AGENT_GUEST_API_KEY"]);
  assert.deepEqual(GUEST_DEPRECATED_ENV_KEYS, ["SELF_AGENT_GUEST_GUILD_IDS"]);
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

test("validateDiscordToken・validateApiKey: 間に Unicode の空白（U+00A0・U+3000）を含む値は理由を返す", () => {
  for (const space of ["\u00a0", "\u3000"]) {
    assert.equal(typeof validateDiscordToken(`aaa.b${space}b.ccc`), "string", JSON.stringify(space));
    assert.equal(typeof validateApiKey(`sk-ant-dummy${space}key-for-tests`), "string", JSON.stringify(space));
  }
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
  assert.deepEqual(result.appended, ENTRY_KEYS);
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
  assert.deepEqual(result.replaced, ENTRY_KEYS);
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
  assert.deepEqual(result.appended, ENTRY_KEYS);
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

test("upsertEnvLines: CRLF の対象の行は行ごと LF の KEY=value に置き換え、ほかの CRLF の行は変えない", () => {
  const text = "A=1\r\nSELF_AGENT_GUEST_DISCORD_TOKEN=old.old.old\r\nSELF_AGENT_GUEST_GUILD_IDS=1\r\nB=2\r\n";
  const result = upsertEnvLines(text, ENTRIES);
  assert.equal(
    result.text,
    `A=1\r\nSELF_AGENT_GUEST_DISCORD_TOKEN=aaa.bbb.ccc\nSELF_AGENT_GUEST_GUILD_IDS=${GUILD_A}\nB=2\r\n` +
      `${COMMENT}\nSELF_AGENT_GUEST_API_KEY=${API_KEY}\n`,
  );
  assert.deepEqual(result.replaced, ["SELF_AGENT_GUEST_DISCORD_TOKEN", "SELF_AGENT_GUEST_GUILD_IDS"]);
});

test("upsertEnvLines: = の前に空白・タブがある行と、export の後がタブの行も同じ変数として置き換える", () => {
  const text = [
    "SELF_AGENT_GUEST_DISCORD_TOKEN =old.old.old",
    "export\tSELF_AGENT_GUEST_GUILD_IDS=1",
    "export SELF_AGENT_GUEST_API_KEY\t=old",
    "SELF_AGENT_GUEST_DISCORD_TOKEN \t =older.older.older",
    "",
  ].join("\n");
  const result = upsertEnvLines(text, ENTRIES);
  assert.equal(
    result.text,
    [
      "SELF_AGENT_GUEST_DISCORD_TOKEN=aaa.bbb.ccc",
      `SELF_AGENT_GUEST_GUILD_IDS=${GUILD_A}`,
      `SELF_AGENT_GUEST_API_KEY=${API_KEY}`,
      "",
    ].join("\n"),
  );
  assert.deepEqual(result.replaced, ENTRY_KEYS);
  assert.deepEqual(result.appended, []);
});

test("removeEnvLines: 廃止した変数の行（export 付き・先頭の空白・= の前の空白・タブ・空の値・CRLF）をすべて消し、ほかの行は変えない", () => {
  const text = [
    "# my env",
    "SELF_AGENT_GUEST_GUILD_IDS=1",
    "DISCORD_TOKEN=x",
    "export SELF_AGENT_GUEST_GUILD_IDS = 2",
    "  export\tSELF_AGENT_GUEST_GUILD_IDS\t=3",
    "SELF_AGENT_GUEST_GUILD_IDS=",
    "SELF_AGENT_GUEST_GUILD_IDS=4\r",
    "A=1\r",
    "# SELF_AGENT_GUEST_GUILD_IDS=commented",
    "SELF_AGENT_GUEST_GUILD_IDS_OLD=1",
    "XSELF_AGENT_GUEST_GUILD_IDS=1",
    "",
  ].join("\n");
  const result = removeEnvLines(text, GUEST_DEPRECATED_ENV_KEYS);
  assert.equal(
    result.text,
    [
      "# my env",
      "DISCORD_TOKEN=x",
      "A=1\r",
      "# SELF_AGENT_GUEST_GUILD_IDS=commented",
      "SELF_AGENT_GUEST_GUILD_IDS_OLD=1",
      "XSELF_AGENT_GUEST_GUILD_IDS=1",
      "",
    ].join("\n"),
  );
  assert.deepEqual(result.removed, ["SELF_AGENT_GUEST_GUILD_IDS"]);
});

test("removeEnvLines: 行が無ければ中身を変えず removed は空。空のファイルは空のまま", () => {
  const text = "DISCORD_TOKEN=x\nSELF_AGENT_GUEST_API_KEY=y";
  assert.deepEqual(removeEnvLines(text, GUEST_DEPRECATED_ENV_KEYS), { text, removed: [] });
  assert.deepEqual(removeEnvLines("", GUEST_DEPRECATED_ENV_KEYS), { text: "", removed: [] });
  // 消した後に upsertEnvLines で 2 つを書ける（guest-setup の順）
  const removed = removeEnvLines(`${text}\nSELF_AGENT_GUEST_GUILD_IDS=1\n`, GUEST_DEPRECATED_ENV_KEYS);
  const update = upsertEnvLines(removed.text, [
    ["SELF_AGENT_GUEST_DISCORD_TOKEN", TOKEN],
    ["SELF_AGENT_GUEST_API_KEY", API_KEY],
  ]);
  assert.equal(
    update.text,
    `DISCORD_TOKEN=x\nSELF_AGENT_GUEST_API_KEY=${API_KEY}\n${COMMENT}\nSELF_AGENT_GUEST_DISCORD_TOKEN=${TOKEN}\n`,
  );
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
