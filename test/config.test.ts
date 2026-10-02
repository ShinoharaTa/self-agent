import { test } from "node:test";
import assert from "node:assert/strict";
import { loadConfig, missingForStart } from "../src/config.ts";

test("未設定ならデフォルト値を使う", () => {
  const config = loadConfig({ HOME: "/home/tester" });
  assert.deepEqual(config, {
    oauthTokenPresent: false,
    discordTokenPresent: false,
    claudeConfigDir: "/home/tester/.local/share/self-agent/claude",
    workDir: "/home/tester/.local/share/self-agent/work",
    model: "claude-opus-5",
    ownerUserId: undefined,
    allowedGuildIds: [],
    inboxChannelId: undefined,
    dataDir: "/home/tester/.local/share/self-agent/data",
    timeZone: "Asia/Tokyo",
    maxConcurrentTurns: 2,
    turnTimeoutSec: 300,
  });
});

test("環境変数で上書きできる", () => {
  const config = loadConfig({
    HOME: "/home/tester",
    CLAUDE_CONFIG_DIR: "/srv/claude",
    SELF_AGENT_WORKDIR: "/srv/work",
    SELF_AGENT_MODEL: "claude-sonnet-5",
    SELF_AGENT_OWNER_ID: "100",
    SELF_AGENT_ALLOWED_GUILD_IDS: "200, 201,,200",
    SELF_AGENT_INBOX_CHANNEL_ID: "300",
    SELF_AGENT_DATA_DIR: "/srv/data",
    SELF_AGENT_TZ: "UTC",
    SELF_AGENT_MAX_CONCURRENT: "4",
    SELF_AGENT_TURN_TIMEOUT_SEC: "60",
  });
  assert.equal(config.claudeConfigDir, "/srv/claude");
  assert.equal(config.workDir, "/srv/work");
  assert.equal(config.model, "claude-sonnet-5");
  assert.equal(config.ownerUserId, "100");
  assert.deepEqual(config.allowedGuildIds, ["200", "201"]);
  assert.equal(config.inboxChannelId, "300");
  assert.equal(config.dataDir, "/srv/data");
  assert.equal(config.timeZone, "UTC");
  assert.equal(config.maxConcurrentTurns, 4);
  assert.equal(config.turnTimeoutSec, 60);
});

test("token は有無だけを返し、値は含めない", () => {
  const secret = "dummy-token-value";
  const config = loadConfig({ HOME: "/home/tester", CLAUDE_CODE_OAUTH_TOKEN: secret });
  assert.equal(config.oauthTokenPresent, true);
  assert.ok(!JSON.stringify(config).includes(secret));

  assert.equal(loadConfig({ HOME: "/home/tester", CLAUDE_CODE_OAUTH_TOKEN: "" }).oauthTokenPresent, false);
  assert.equal(loadConfig({ HOME: "/home/tester" }).oauthTokenPresent, false);
});

test("DISCORD_TOKEN も有無だけを返し、値は含めない", () => {
  const secret = "dummy-discord-token";
  const config = loadConfig({ HOME: "/home/tester", DISCORD_TOKEN: secret });
  assert.equal(config.discordTokenPresent, true);
  assert.ok(!JSON.stringify(config).includes(secret));

  assert.equal(loadConfig({ HOME: "/home/tester", DISCORD_TOKEN: "" }).discordTokenPresent, false);
});

test("SELF_AGENT_MAX_CONCURRENT が正の整数でなければエラー", () => {
  for (const value of ["0", "-1", "1.5", "abc", " 2"]) {
    assert.throws(
      () => loadConfig({ HOME: "/home/tester", SELF_AGENT_MAX_CONCURRENT: value }),
      /SELF_AGENT_MAX_CONCURRENT/,
      value,
    );
  }
  assert.equal(loadConfig({ HOME: "/home/tester", SELF_AGENT_MAX_CONCURRENT: "" }).maxConcurrentTurns, 2);
});

test("SELF_AGENT_TURN_TIMEOUT_SEC が正の整数でなければエラー", () => {
  for (const value of ["0", "-1", "1.5", "abc"]) {
    assert.throws(
      () => loadConfig({ HOME: "/home/tester", SELF_AGENT_TURN_TIMEOUT_SEC: value }),
      /SELF_AGENT_TURN_TIMEOUT_SEC/,
      value,
    );
  }
  assert.equal(loadConfig({ HOME: "/home/tester", SELF_AGENT_TURN_TIMEOUT_SEC: "" }).turnTimeoutSec, 300);
});

test("HOME が無く既定のディレクトリが必要ならエラー", () => {
  assert.throws(() => loadConfig({}), /HOME/);
  assert.throws(() => loadConfig({ CLAUDE_CONFIG_DIR: "/srv/claude" }), /HOME/);
});

test("ディレクトリがすべて指定されていれば HOME は不要", () => {
  const config = loadConfig({
    CLAUDE_CONFIG_DIR: "/srv/claude",
    SELF_AGENT_WORKDIR: "/srv/work",
    SELF_AGENT_DATA_DIR: "/srv/data",
  });
  assert.equal(config.claudeConfigDir, "/srv/claude");
  assert.equal(config.workDir, "/srv/work");
  assert.equal(config.dataDir, "/srv/data");
});

test("missingForStart は欠けている必須変数の名前だけを返す", () => {
  assert.deepEqual(missingForStart(loadConfig({ HOME: "/home/tester" })), [
    "CLAUDE_CODE_OAUTH_TOKEN",
    "DISCORD_TOKEN",
    "SELF_AGENT_OWNER_ID",
    "SELF_AGENT_ALLOWED_GUILD_IDS",
    "SELF_AGENT_INBOX_CHANNEL_ID",
  ]);

  const full = loadConfig({
    HOME: "/home/tester",
    CLAUDE_CODE_OAUTH_TOKEN: "dummy",
    DISCORD_TOKEN: "dummy",
    SELF_AGENT_OWNER_ID: "100",
    SELF_AGENT_ALLOWED_GUILD_IDS: "200",
    SELF_AGENT_INBOX_CHANNEL_ID: "300",
  });
  assert.deepEqual(missingForStart(full), []);
  assert.deepEqual(missingForStart({ ...full, discordTokenPresent: false, allowedGuildIds: [] }), [
    "DISCORD_TOKEN",
    "SELF_AGENT_ALLOWED_GUILD_IDS",
  ]);
});

test("許可サーバーの ID に数字以外が混ざっていたらエラー", () => {
  assert.throws(
    () => loadConfig({ HOME: "/home/tester", SELF_AGENT_ALLOWED_GUILD_IDS: "200,abc" }),
    /SELF_AGENT_ALLOWED_GUILD_IDS/,
  );
});
