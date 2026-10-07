// 結合テスト: 実際に Agent SDK を動かし、中断したターンの SDK セッションを次のターンで resume できるか確かめる（利用枠を消費する）。
// CLAUDE_CODE_OAUTH_TOKEN が無ければ skip
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { query } from "@anthropic-ai/claude-agent-sdk";
import type { AgentRunner, RunInput, RunResult } from "../../src/agent/runner.ts";
import { SdkAgentRunner, type QueryFn } from "../../src/agent/sdk-runner.ts";
import { createTaskMcpServer } from "../../src/agent/tools.ts";
import { buildTurnPrompt } from "../../src/app/prompt.ts";
import { runChannelTurn, type TurnDeps } from "../../src/app/turn.ts";
import { loadConfig } from "../../src/config.ts";
import { ChannelSeedStore } from "../../src/store/channel-seeds.ts";
import { openDb } from "../../src/store/db.ts";
import { InboxSummaryStore } from "../../src/store/inbox-summaries.ts";
import { KnowledgeStore } from "../../src/store/knowledge.ts";
import { MemoryStore } from "../../src/store/memories.ts";
import { ProjectStore } from "../../src/store/projects.ts";
import { SdkSessionStore } from "../../src/store/sdk-sessions.ts";
import { TaskStore } from "../../src/store/tasks.ts";
import { TopicSessionStore } from "../../src/store/topic-sessions.ts";
import { UsageStore } from "../../src/store/usage.ts";

const tokenPresent = (process.env.CLAUDE_CODE_OAUTH_TOKEN ?? "") !== "";

test(
  "中断したターン: 受け取った session_id を保存し、次のターンでその会話を resume できる",
  { skip: tokenPresent ? false : "CLAUDE_CODE_OAUTH_TOKEN が無いので skip", timeout: 600_000 },
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

    // session_open・kb_delete の確認・記憶の知らせ・プロジェクトはここでは使わない（配信は無効）
    const kbMemory = {
      knowledge: new KnowledgeStore(db),
      memories: new MemoryStore(db),
      confirmKbDelete: async () => {},
      notifyMemoryChange: async () => {},
      timeZone: cfg.timeZone,
    };
    const projects = new ProjectStore(db);
    const projectsDir = join(realpathSync(cfg.workDir), "projects");
    const projectTools = { projects, projectsDir, publicBaseUrl: undefined, serving: () => false };

    // 1 ターン目だけ、最初の assistant メッセージ（本文かツール呼び出し）を受け取った時点で中断する
    const controller = new AbortController();
    let abortOnAssistant = true;
    const queryFn: QueryFn = (params) =>
      (async function* () {
        for await (const message of query(params)) {
          yield message;
          if (abortOnAssistant && message.type === "assistant" && message.parent_tool_use_id === null) {
            abortOnAssistant = false;
            controller.abort();
          }
        }
      })();
    const sdkRunner = new SdkAgentRunner(
      cfg,
      (context) =>
        createTaskMcpServer(
          new TaskStore(db),
          new TopicSessionStore(db),
          async () => ({ result: "not_available" }),
          kbMemory,
          projectTools,
          context,
        ),
      { projects, projectsDir },
      () => {},
      queryFn,
    );
    // run の入力の sessionId と結果を記録する（resume 失敗の復旧で 2 回走っていないか確かめる）
    const runs: Array<{ sessionId: string | undefined; result: RunResult }> = [];
    const runner: AgentRunner = {
      run: async (input: RunInput) => {
        const result = await sdkRunner.run(input);
        runs.push({ sessionId: input.sessionId, result });
        return result;
      },
    };
    const sessions = new SdkSessionStore(db);
    const deps: TurnDeps = {
      runner,
      sessions,
      seeds: new ChannelSeedStore(db),
      topicSessions: new TopicSessionStore(db),
      inboxSummaries: new InboxSummaryStore(db),
      memories: new MemoryStore(db),
      usage: new UsageStore(db),
      log: () => {},
    };
    const turn = { guildId: "guild-1", channelId: "topic-1", kind: "session" as const, allowedUrls: [] };

    const first = await runChannelTurn(deps, {
      ...turn,
      prompt: buildTurnPrompt("ぶどうの品種を 5 つ挙げて、それぞれの特徴を詳しく説明してください。", new Date(), cfg.timeZone, "テスト"),
      signal: controller.signal,
    });
    assert.ok(!first.ok, "1 ターン目が中断されずに終わった");
    assert.equal(first.errorMessage, "aborted");
    assert.ok(first.sessionId !== undefined, "中断したターンで session_id を受け取れなかった");
    assert.equal(sessions.get("topic-1"), first.sessionId);

    const second = await runChannelTurn(deps, {
      ...turn,
      prompt: buildTurnPrompt("さっき何を頼みましたか", new Date(), cfg.timeZone, "テスト"),
    });
    // resume 失敗の復旧（sessionId 無しのやり直し）が起きていれば、2 回目の run は 2 つになる
    t.diagnostic(
      `2 ターン目の run: ${runs
        .slice(1)
        .map((run) => `${run.sessionId === first.sessionId ? "resume" : "new"} → ${run.result.ok ? "ok" : run.result.errorMessage}`)
        .join(" / ")}`,
    );
    assert.equal(runs.length, 2, "2 ターン目で resume に失敗し、新しいセッションでやり直した");
    assert.equal(runs[1]!.sessionId, first.sessionId);
    assert.ok(second.ok, second.ok ? "" : second.errorMessage);
    assert.ok(second.text.includes("ぶどう"), `2 ターン目の返答に 1 ターン目の依頼（ぶどう）が含まれていない: ${second.text}`);
  },
);
