import { test } from "node:test";
import assert from "node:assert/strict";
import { createSdkMcpServer } from "@anthropic-ai/claude-agent-sdk";
import { buildQueryOptions } from "../src/agent/query-options.ts";

const cfg = { model: "claude-opus-5", workDir: "/srv/work", claudeConfigDir: "/srv/claude", effort: undefined };
const mcpServer = createSdkMcpServer({ name: "selfagent", version: "0.1.0", tools: [] });

test("毎回同じ Options を返す（キャッシュのため）", () => {
  assert.deepEqual(buildQueryOptions(cfg, mcpServer), buildQueryOptions(cfg, mcpServer));
});

test("システムプロンプトに日付や年を含めない", () => {
  const { systemPrompt } = buildQueryOptions(cfg, mcpServer);
  assert.equal(typeof systemPrompt, "string");
  assert.doesNotMatch(String(systemPrompt), /\d{4}|\d{1,2}\s*[/\-月]\s*\d{1,2}/);
});

test("組み込みツールと設定ファイルを使わず、自前ツールだけを許可する", () => {
  const options = buildQueryOptions(cfg, mcpServer);
  assert.deepEqual(options.tools, []);
  assert.equal(options.permissionMode, "dontAsk");
  assert.deepEqual(options.settingSources, []);
  assert.deepEqual(options.allowedTools, ["mcp__selfagent__*"]);
  assert.equal(options.mcpServers?.selfagent, mcpServer);
  assert.equal(options.model, "claude-opus-5");
  assert.equal(options.cwd, "/srv/work");
  assert.equal(options.maxTurns, 8);
  assert.equal(options.resume, undefined);
});

test("env に設定ディレクトリと自動メモリ無効を入れる", () => {
  const { env } = buildQueryOptions(cfg, mcpServer);
  assert.equal(env?.CLAUDE_CONFIG_DIR, "/srv/claude");
  assert.equal(env?.CLAUDE_CODE_DISABLE_AUTO_MEMORY, "1");
});

test("env に DISCORD_TOKEN を渡さない", () => {
  const saved = process.env.DISCORD_TOKEN;
  process.env.DISCORD_TOKEN = "dummy-discord-token";
  try {
    const { env } = buildQueryOptions(cfg, mcpServer);
    assert.equal(env?.DISCORD_TOKEN, undefined);
    assert.ok(!JSON.stringify(env).includes("dummy-discord-token"));
  } finally {
    if (saved === undefined) delete process.env.DISCORD_TOKEN;
    else process.env.DISCORD_TOKEN = saved;
  }
});

test("effort は設定したときだけ Options に入る", () => {
  assert.equal("effort" in buildQueryOptions(cfg, mcpServer), false);
  assert.equal(buildQueryOptions({ ...cfg, effort: "medium" }, mcpServer).effort, "medium");
});
