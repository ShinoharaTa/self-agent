import { test } from "node:test";
import assert from "node:assert/strict";
import { loadConfig } from "../src/config.ts";

test("未設定ならデフォルト値を使う", () => {
  const config = loadConfig({ HOME: "/home/tester" });
  assert.deepEqual(config, {
    oauthTokenPresent: false,
    claudeConfigDir: "/home/tester/.local/share/self-agent/claude",
    workDir: "/home/tester/.local/share/self-agent/work",
    model: "claude-opus-5",
  });
});

test("環境変数で上書きできる", () => {
  const config = loadConfig({
    HOME: "/home/tester",
    CLAUDE_CONFIG_DIR: "/srv/claude",
    SELF_AGENT_WORKDIR: "/srv/work",
    SELF_AGENT_MODEL: "claude-sonnet-5",
  });
  assert.equal(config.claudeConfigDir, "/srv/claude");
  assert.equal(config.workDir, "/srv/work");
  assert.equal(config.model, "claude-sonnet-5");
});

test("token は有無だけを返し、値は含めない", () => {
  const secret = "dummy-token-value";
  const config = loadConfig({ HOME: "/home/tester", CLAUDE_CODE_OAUTH_TOKEN: secret });
  assert.equal(config.oauthTokenPresent, true);
  assert.ok(!JSON.stringify(config).includes(secret));

  assert.equal(loadConfig({ HOME: "/home/tester", CLAUDE_CODE_OAUTH_TOKEN: "" }).oauthTokenPresent, false);
  assert.equal(loadConfig({ HOME: "/home/tester" }).oauthTokenPresent, false);
});

test("HOME が無く既定のディレクトリが必要ならエラー", () => {
  assert.throws(() => loadConfig({}), /HOME/);
  assert.throws(() => loadConfig({ CLAUDE_CONFIG_DIR: "/srv/claude" }), /HOME/);
});

test("ディレクトリが両方指定されていれば HOME は不要", () => {
  const config = loadConfig({ CLAUDE_CONFIG_DIR: "/srv/claude", SELF_AGENT_WORKDIR: "/srv/work" });
  assert.equal(config.claudeConfigDir, "/srv/claude");
  assert.equal(config.workDir, "/srv/work");
});
