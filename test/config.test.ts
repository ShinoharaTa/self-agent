import { test } from "node:test";
import assert from "node:assert/strict";
import { loadConfig, loadDataConfig, missingForStart } from "../src/config.ts";

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
    effort: undefined,
    channelOpGapMs: 2000,
    shutdownGraceSec: 30,
    idleHours: 12,
    autoSessionPerDay: 3,
    deleteAfterDays: 30,
    inboxRotateAt: { hour: 4, minute: 0 },
    inboxMaxInputTokens: 150000,
    servePort: undefined,
    publicBaseUrl: undefined,
    serveAllowedLogin: undefined,
    sessionMaxTurns: 40,
    sessionTurnTimeoutSec: 900,
    devMode: false,
    devLogDays: 30,
    shell: false,
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
    SELF_AGENT_CHANNEL_OP_GAP_MS: "500",
    SELF_AGENT_SHUTDOWN_GRACE_SEC: "10",
    SELF_AGENT_IDLE_HOURS: "24",
    SELF_AGENT_AUTO_SESSION_PER_DAY: "5",
    SELF_AGENT_DELETE_AFTER_DAYS: "7",
    SELF_AGENT_INBOX_ROTATE_AT: "23:59",
    SELF_AGENT_INBOX_MAX_INPUT_TOKENS: "80000",
    SELF_AGENT_SERVE_PORT: "8790",
    SELF_AGENT_PUBLIC_BASE_URL: "https://example.ts.net:9443/",
    SELF_AGENT_SERVE_ALLOWED_LOGIN: "owner@example.com",
    SELF_AGENT_SESSION_MAX_TURNS: "60",
    SELF_AGENT_SESSION_TURN_TIMEOUT_SEC: "1200",
    SELF_AGENT_DEV_MODE: "1",
    SELF_AGENT_DEV_LOG_DAYS: "7",
    SELF_AGENT_SHELL: "1",
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
  assert.equal(config.channelOpGapMs, 500);
  assert.equal(config.shutdownGraceSec, 10);
  assert.equal(config.idleHours, 24);
  assert.equal(config.autoSessionPerDay, 5);
  assert.equal(config.deleteAfterDays, 7);
  assert.deepEqual(config.inboxRotateAt, { hour: 23, minute: 59 });
  assert.equal(config.inboxMaxInputTokens, 80000);
  assert.equal(config.servePort, 8790);
  assert.equal(config.publicBaseUrl, "https://example.ts.net:9443");
  assert.equal(config.serveAllowedLogin, "owner@example.com");
  assert.equal(config.sessionMaxTurns, 60);
  assert.equal(config.sessionTurnTimeoutSec, 1200);
  assert.equal(config.devMode, true);
  assert.equal(config.devLogDays, 7);
  assert.equal(config.shell, true);
});

test("CLAUDE_CODE_OAUTH_TOKEN・DISCORD_TOKEN は有無だけを返し、値は含めない", () => {
  for (const { name, key } of [
    { name: "CLAUDE_CODE_OAUTH_TOKEN", key: "oauthTokenPresent" },
    { name: "DISCORD_TOKEN", key: "discordTokenPresent" },
  ] as const) {
    const secret = `dummy-${name}-value`;
    const config = loadConfig({ HOME: "/home/tester", [name]: secret });
    assert.equal(config[key], true, name);
    assert.ok(!JSON.stringify(config).includes(secret), name);
    assert.equal(loadConfig({ HOME: "/home/tester", [name]: "" })[key], false, name);
    assert.equal(loadConfig({ HOME: "/home/tester" })[key], false, name);
  }
});

test("正の整数の設定は、正の整数でなければ変数名を出してエラー。空なら既定値", () => {
  const cases = [
    { name: "SELF_AGENT_MAX_CONCURRENT", key: "maxConcurrentTurns", fallback: 2 },
    { name: "SELF_AGENT_TURN_TIMEOUT_SEC", key: "turnTimeoutSec", fallback: 300 },
    { name: "SELF_AGENT_CHANNEL_OP_GAP_MS", key: "channelOpGapMs", fallback: 2000 },
    { name: "SELF_AGENT_SHUTDOWN_GRACE_SEC", key: "shutdownGraceSec", fallback: 30 },
    { name: "SELF_AGENT_IDLE_HOURS", key: "idleHours", fallback: 12 },
    { name: "SELF_AGENT_AUTO_SESSION_PER_DAY", key: "autoSessionPerDay", fallback: 3 },
    { name: "SELF_AGENT_DELETE_AFTER_DAYS", key: "deleteAfterDays", fallback: 30 },
    { name: "SELF_AGENT_INBOX_MAX_INPUT_TOKENS", key: "inboxMaxInputTokens", fallback: 150000 },
    { name: "SELF_AGENT_SESSION_MAX_TURNS", key: "sessionMaxTurns", fallback: 40 },
    { name: "SELF_AGENT_SESSION_TURN_TIMEOUT_SEC", key: "sessionTurnTimeoutSec", fallback: 900 },
    { name: "SELF_AGENT_DEV_LOG_DAYS", key: "devLogDays", fallback: 30 },
  ] as const;
  for (const { name, key, fallback } of cases) {
    for (const value of ["0", "-1", "1.5", "abc", " 2", "150k"]) {
      assert.throws(() => loadConfig({ HOME: "/home/tester", [name]: value }), new RegExp(name), `${name}=${value}`);
    }
    assert.equal(loadConfig({ HOME: "/home/tester", [name]: "" })[key], fallback, name);
  }
});

test("SELF_AGENT_INBOX_ROTATE_AT は HH:MM（00:00〜23:59）だけを受け付け、それ以外はエラー", () => {
  for (const [value, expected] of [
    ["00:00", { hour: 0, minute: 0 }],
    ["04:30", { hour: 4, minute: 30 }],
    ["19:05", { hour: 19, minute: 5 }],
    ["23:59", { hour: 23, minute: 59 }],
  ] as const) {
    assert.deepEqual(loadConfig({ HOME: "/home/tester", SELF_AGENT_INBOX_ROTATE_AT: value }).inboxRotateAt, expected, value);
  }
  for (const value of ["4:00", "24:00", "12:60", "12:0", "1200", "12:00:00", " 04:00", "04:00 ", "abc", "-1:00"]) {
    assert.throws(
      () => loadConfig({ HOME: "/home/tester", SELF_AGENT_INBOX_ROTATE_AT: value }),
      /SELF_AGENT_INBOX_ROTATE_AT/,
      value,
    );
  }
  assert.deepEqual(loadConfig({ HOME: "/home/tester", SELF_AGENT_INBOX_ROTATE_AT: "" }).inboxRotateAt, { hour: 4, minute: 0 });
});

test("SELF_AGENT_SERVE_PORT は 1〜65535 の整数だけを受け付け、それ以外はエラー", () => {
  assert.equal(loadConfig({ HOME: "/home/tester", SELF_AGENT_SERVE_PORT: "1" }).servePort, 1);
  assert.equal(loadConfig({ HOME: "/home/tester", SELF_AGENT_SERVE_PORT: "65535" }).servePort, 65535);
  for (const value of ["0", "65536", "-1", "1.5", "abc", " 8790"]) {
    assert.throws(
      () => loadConfig({ HOME: "/home/tester", SELF_AGENT_SERVE_PORT: value }),
      /SELF_AGENT_SERVE_PORT/,
      value,
    );
  }
  assert.equal(loadConfig({ HOME: "/home/tester", SELF_AGENT_SERVE_PORT: "" }).servePort, undefined);
});

test("SELF_AGENT_PUBLIC_BASE_URL は http:// か https:// で始まるものだけを受け付け、末尾の / を除く", () => {
  for (const [value, expected] of [
    ["https://example.ts.net:9443", "https://example.ts.net:9443"],
    ["https://example.ts.net:9443/", "https://example.ts.net:9443"],
    ["https://example.ts.net:9443//", "https://example.ts.net:9443"],
    ["http://127.0.0.1:8790/", "http://127.0.0.1:8790"],
  ] as const) {
    assert.equal(loadConfig({ HOME: "/home/tester", SELF_AGENT_PUBLIC_BASE_URL: value }).publicBaseUrl, expected, value);
  }
  for (const value of [
    "example.ts.net",
    "ftp://example.ts.net",
    "https:/example.ts.net",
    "//example.ts.net",
    "https://",
    " https://example.ts.net",
  ]) {
    assert.throws(
      () => loadConfig({ HOME: "/home/tester", SELF_AGENT_PUBLIC_BASE_URL: value }),
      /SELF_AGENT_PUBLIC_BASE_URL/,
      value,
    );
  }
  assert.equal(loadConfig({ HOME: "/home/tester", SELF_AGENT_PUBLIC_BASE_URL: "" }).publicBaseUrl, undefined);
});

test("SELF_AGENT_SERVE_ALLOWED_LOGIN は空なら未設定", () => {
  assert.equal(loadConfig({ HOME: "/home/tester", SELF_AGENT_SERVE_ALLOWED_LOGIN: "" }).serveAllowedLogin, undefined);
});

test("SELF_AGENT_DEV_MODE は 1 で有効、未設定・空・0 で無効。それ以外の値はエラー", () => {
  assert.equal(loadConfig({ HOME: "/home/tester", SELF_AGENT_DEV_MODE: "1" }).devMode, true);
  assert.equal(loadConfig({ HOME: "/home/tester", SELF_AGENT_DEV_MODE: "0" }).devMode, false);
  assert.equal(loadConfig({ HOME: "/home/tester", SELF_AGENT_DEV_MODE: "" }).devMode, false);
  for (const value of ["true", "yes", "2", " 1", "on"]) {
    assert.throws(() => loadConfig({ HOME: "/home/tester", SELF_AGENT_DEV_MODE: value }), /SELF_AGENT_DEV_MODE/, value);
  }
});

test("SELF_AGENT_SHELL は 1 で有効、未設定・空・0 で無効。それ以外の値はエラー", () => {
  for (const { value, expected } of [
    { value: undefined, expected: false },
    { value: "", expected: false },
    { value: "0", expected: false },
    { value: "1", expected: true },
  ]) {
    assert.equal(loadConfig({ HOME: "/home/tester", SELF_AGENT_SHELL: value }).shell, expected, String(value));
  }
  for (const value of ["true", "yes", "2", " 1", "on"]) {
    assert.throws(() => loadConfig({ HOME: "/home/tester", SELF_AGENT_SHELL: value }), /SELF_AGENT_SHELL/, value);
  }
});

test("loadDataConfig は SELF_AGENT_DATA_DIR と SELF_AGENT_TZ だけを読み、既定値は loadConfig と同じ。他の変数の不正値は見ない", () => {
  const env = { HOME: "/home/tester" };
  const config = loadConfig(env);
  assert.deepEqual(loadDataConfig(env), { dataDir: config.dataDir, timeZone: config.timeZone });
  assert.deepEqual(
    loadDataConfig({ SELF_AGENT_DATA_DIR: "/srv/data", SELF_AGENT_TZ: "UTC", SELF_AGENT_DEV_MODE: "yes", SELF_AGENT_EFFORT: "fast" }),
    { dataDir: "/srv/data", timeZone: "UTC" },
  );
  assert.throws(() => loadDataConfig({}), /HOME/);
});

test("HOME が無く既定のディレクトリが必要ならエラー。ディレクトリがすべて指定されていれば HOME は不要", () => {
  assert.throws(() => loadConfig({}), /HOME/);
  assert.throws(() => loadConfig({ CLAUDE_CONFIG_DIR: "/srv/claude" }), /HOME/);
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
  ]);

  // SELF_AGENT_INBOX_CHANNEL_ID は /setup 前の fallback なので必須ではない
  const full = loadConfig({
    HOME: "/home/tester",
    CLAUDE_CODE_OAUTH_TOKEN: "dummy",
    DISCORD_TOKEN: "dummy",
    SELF_AGENT_OWNER_ID: "100",
    SELF_AGENT_ALLOWED_GUILD_IDS: "200",
  });
  assert.equal(full.inboxChannelId, undefined);
  assert.deepEqual(missingForStart(full), []);
  assert.deepEqual(missingForStart({ ...full, inboxChannelId: "300" }), []);
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

test("SELF_AGENT_EFFORT は決められた値だけを受け付ける", () => {
  assert.equal(loadConfig({ HOME: "/home/tester", SELF_AGENT_EFFORT: "low" }).effort, "low");
  assert.equal(loadConfig({ HOME: "/home/tester", SELF_AGENT_EFFORT: "" }).effort, undefined);
  assert.throws(() => loadConfig({ HOME: "/home/tester", SELF_AGENT_EFFORT: "fast" }), /SELF_AGENT_EFFORT/);
});
