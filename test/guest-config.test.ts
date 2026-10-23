import { test } from "node:test";
import assert from "node:assert/strict";
import { loadConfig } from "../src/config.ts";

const TOKEN = "dummy-guest-token-value";
const API_KEY = "dummy-guest-api-key-value";

/** ゲストの 3 つが揃った env */
const GUEST_ENV = {
  HOME: "/home/tester",
  SELF_AGENT_ALLOWED_GUILD_IDS: "100",
  DISCORD_TOKEN: "dummy-default-token",
  SELF_AGENT_GUEST_DISCORD_TOKEN: TOKEN,
  SELF_AGENT_GUEST_GUILD_IDS: "200, 201,,200",
  SELF_AGENT_GUEST_API_KEY: API_KEY,
};

test("ゲスト: 3 つ揃えば有効になり、任意の変数は既定値。トークン・API キーの値は持たない", () => {
  const config = loadConfig(GUEST_ENV);
  assert.equal(config.guest, true);
  assert.equal(config.guestTokenEnv, "SELF_AGENT_GUEST_DISCORD_TOKEN");
  assert.deepEqual(config.guestGuildIds, ["200", "201"]);
  assert.equal(config.guestApiKeyPresent, true);
  assert.equal(config.guestModel, "claude-opus-5-5");
  assert.equal(config.guestEffort, "low");
  assert.equal(config.guestTurnsPerDay, 300);
  assert.equal(config.guestUserTurnsPerDay, 50);
  assert.equal(config.guestMaxConcurrent, 1);
  assert.equal(config.guestTurnTimeoutSec, 120);
  assert.equal(config.guestSessionMaxTurns, 30);
  assert.equal(config.guestSessionMaxInputTokens, 60000);
  const json = JSON.stringify(config);
  assert.ok(!json.includes(TOKEN));
  assert.ok(!json.includes(API_KEY));
});

test("ゲスト: 任意の変数で上書きできる", () => {
  const config = loadConfig({
    ...GUEST_ENV,
    SELF_AGENT_GUEST_MODEL: "claude-sonnet-5",
    SELF_AGENT_GUEST_EFFORT: "medium",
    SELF_AGENT_GUEST_TURNS_PER_DAY: "10",
    SELF_AGENT_GUEST_USER_TURNS_PER_DAY: "3",
    SELF_AGENT_GUEST_MAX_CONCURRENT: "2",
    SELF_AGENT_GUEST_TURN_TIMEOUT_SEC: "60",
    SELF_AGENT_GUEST_SESSION_MAX_TURNS: "5",
    SELF_AGENT_GUEST_SESSION_MAX_INPUT_TOKENS: "1000",
  });
  assert.equal(config.guestModel, "claude-sonnet-5");
  assert.equal(config.guestEffort, "medium");
  assert.equal(config.guestTurnsPerDay, 10);
  assert.equal(config.guestUserTurnsPerDay, 3);
  assert.equal(config.guestMaxConcurrent, 2);
  assert.equal(config.guestTurnTimeoutSec, 60);
  assert.equal(config.guestSessionMaxTurns, 5);
  assert.equal(config.guestSessionMaxInputTokens, 1000);
});

test("ゲスト: 1 つか 2 つだけなら、足りない変数名を出して設定エラー。値は出さない", () => {
  const names = ["SELF_AGENT_GUEST_DISCORD_TOKEN", "SELF_AGENT_GUEST_GUILD_IDS", "SELF_AGENT_GUEST_API_KEY"] as const;
  for (const omitted of [[0], [1], [2], [0, 1], [0, 2], [1, 2]]) {
    const env: NodeJS.ProcessEnv = { ...GUEST_ENV };
    for (const index of omitted) delete env[names[index]!];
    assert.throws(
      () => loadConfig(env),
      (error: Error) =>
        omitted.every((index) => error.message.includes(names[index]!)) &&
        names.every((name, index) => omitted.includes(index) || !error.message.includes(name)) &&
        !error.message.includes(TOKEN) &&
        !error.message.includes(API_KEY),
      omitted.join(","),
    );
  }
  // 空・空白だけは無いものとする
  assert.throws(() => loadConfig({ ...GUEST_ENV, SELF_AGENT_GUEST_API_KEY: " " }), /SELF_AGENT_GUEST_API_KEY/);
});

test("ゲスト: 3 つとも無ければ無効で、任意の変数は読まない（形が違っても設定エラーにしない）", () => {
  const config = loadConfig({
    HOME: "/home/tester",
    SELF_AGENT_GUEST_EFFORT: "turbo",
    SELF_AGENT_GUEST_TURNS_PER_DAY: "0",
  });
  assert.equal(config.guest, false);
  assert.deepEqual(config.guestGuildIds, []);
  assert.equal(config.guestEffort, "low");
  assert.equal(config.guestTurnsPerDay, 300);
});

test("ゲスト: サーバー ID の形が違う・SELF_AGENT_ALLOWED_GUILD_IDS と重なるなら設定エラー", () => {
  assert.throws(() => loadConfig({ ...GUEST_ENV, SELF_AGENT_GUEST_GUILD_IDS: "20a" }), /SELF_AGENT_GUEST_GUILD_IDS/);
  assert.throws(() => loadConfig({ ...GUEST_ENV, SELF_AGENT_GUEST_GUILD_IDS: "," }), /SELF_AGENT_GUEST_GUILD_IDS/);
  assert.throws(
    () => loadConfig({ ...GUEST_ENV, SELF_AGENT_GUEST_GUILD_IDS: "200,100" }),
    /SELF_AGENT_GUEST_GUILD_IDS と SELF_AGENT_ALLOWED_GUILD_IDS/,
  );
});

test("ゲスト: トークンが DISCORD_TOKEN・人格のトークンと同じなら、変数名を出して設定エラー（値は出さない）", () => {
  assert.throws(
    () => loadConfig({ ...GUEST_ENV, DISCORD_TOKEN: ` ${TOKEN} ` }),
    (error: Error) => /SELF_AGENT_GUEST_DISCORD_TOKEN と DISCORD_TOKEN/.test(error.message) && !error.message.includes(TOKEN),
  );
  assert.throws(
    () =>
      loadConfig({
        ...GUEST_ENV,
        SELF_AGENT_PERSONAS: "alice",
        SELF_AGENT_PERSONA_ALICE_DISCORD_TOKEN: TOKEN,
      }),
    (error: Error) =>
      /SELF_AGENT_GUEST_DISCORD_TOKEN と SELF_AGENT_PERSONA_ALICE_DISCORD_TOKEN/.test(error.message) &&
      !error.message.includes(TOKEN),
  );
  // 違うトークンなら通る
  const config = loadConfig({ ...GUEST_ENV, SELF_AGENT_PERSONAS: "alice", SELF_AGENT_PERSONA_ALICE_DISCORD_TOKEN: "other" });
  assert.equal(config.guest, true);
});

test("ゲスト: SELF_AGENT_PERSONAS に guest は使えない（ゲストが無効でも）", () => {
  assert.throws(
    () => loadConfig({ HOME: "/home/tester", SELF_AGENT_PERSONAS: "guest", SELF_AGENT_PERSONA_GUEST_DISCORD_TOKEN: "x" }),
    /SELF_AGENT_PERSONAS に guest は使えません/,
  );
});

test("ゲスト: SELF_AGENT_GUEST_EFFORT・正の整数の変数は形が違えば変数名を出して設定エラー", () => {
  assert.throws(() => loadConfig({ ...GUEST_ENV, SELF_AGENT_GUEST_EFFORT: "turbo" }), /SELF_AGENT_GUEST_EFFORT/);
  for (const name of [
    "SELF_AGENT_GUEST_TURNS_PER_DAY",
    "SELF_AGENT_GUEST_USER_TURNS_PER_DAY",
    "SELF_AGENT_GUEST_MAX_CONCURRENT",
    "SELF_AGENT_GUEST_TURN_TIMEOUT_SEC",
    "SELF_AGENT_GUEST_SESSION_MAX_TURNS",
    "SELF_AGENT_GUEST_SESSION_MAX_INPUT_TOKENS",
  ]) {
    for (const value of ["0", "-1", "1.5", "abc"]) {
      assert.throws(() => loadConfig({ ...GUEST_ENV, [name]: value }), new RegExp(name), `${name}=${value}`);
    }
  }
});
