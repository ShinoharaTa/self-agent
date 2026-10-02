// 結合テスト: 実際に Agent SDK を動かす（利用枠を消費する）。CLAUDE_CODE_OAUTH_TOKEN が無ければ skip
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SdkAgentRunner } from "../../src/agent/sdk-runner.ts";
import { createTaskMcpServer } from "../../src/agent/tools.ts";
import { buildTurnPrompt } from "../../src/app/prompt.ts";
import { loadConfig } from "../../src/config.ts";
import { openDb } from "../../src/store/db.ts";
import { TaskStore } from "../../src/store/tasks.ts";
import { TopicSessionStore } from "../../src/store/topic-sessions.ts";

const tokenPresent = (process.env.CLAUDE_CODE_OAUTH_TOKEN ?? "") !== "";

test(
  "SdkAgentRunner: タスクを登録し、2 ターン目の resume でキャッシュを読む",
  { skip: tokenPresent ? false : "CLAUDE_CODE_OAUTH_TOKEN が無いので skip", timeout: 300_000 },
  async (t) => {
    const dir = mkdtempSync(join(tmpdir(), "self-agent-integration-"));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const cfg = loadConfig({
      ...process.env,
      CLAUDE_CONFIG_DIR: join(dir, "claude"),
      SELF_AGENT_WORKDIR: join(dir, "work"),
      SELF_AGENT_DATA_DIR: join(dir, "data"),
    });
    mkdirSync(cfg.claudeConfigDir, { recursive: true });
    mkdirSync(cfg.workDir, { recursive: true });
    const db = openDb(join(cfg.dataDir, "self-agent.db"));
    t.after(() => db.close());
    const tasks = new TaskStore(db);
    const logs: string[] = [];
    const runner = new SdkAgentRunner(
      cfg,
      // session_open はここでは使わない
      (context) => createTaskMcpServer(tasks, new TopicSessionStore(db), async () => ({ result: "not_available" }), context),
      (line) => logs.push(line),
    );

    const first = await runner.run({ prompt: buildTurnPrompt("明日買い物に行く", new Date(), cfg.timeZone) });
    assert.ok(first.ok, first.ok ? "" : first.errorMessage);
    assert.equal(tasks.list({ status: "open", limit: 50 }).length, 1);
    // task_add の呼び出しを PostToolUse の hook で数えている
    assert.ok(first.toolCalls >= 1, `toolCalls=${first.toolCalls}`);
    assert.ok(logs.some((line) => line.startsWith("ツールを呼び出しました: mcp__selfagent__task_add")), logs.join("\n"));

    const second = await runner.run({
      prompt: buildTurnPrompt("ありがとう", new Date(), cfg.timeZone),
      sessionId: first.sessionId,
    });
    assert.ok(second.ok, second.ok ? "" : second.errorMessage);
    assert.ok(second.usage.cacheReadInputTokens > 0, `cacheReadInputTokens=${second.usage.cacheReadInputTokens}`);
  },
);
