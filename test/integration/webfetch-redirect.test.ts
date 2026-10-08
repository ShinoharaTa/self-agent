// 結合テスト: 実際に Agent SDK を動かし、貼った URL の転送先を WebFetch で読めるか確かめる（利用枠を消費する）。CLAUDE_CODE_OAUTH_TOKEN が無ければ skip
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
import { KnowledgeStore } from "../../src/store/knowledge.ts";
import { MemoryStore } from "../../src/store/memories.ts";
import { ProjectStore } from "../../src/store/projects.ts";
import { TaskStore } from "../../src/store/tasks.ts";
import { TopicSessionStore } from "../../src/store/topic-sessions.ts";

const tokenPresent = (process.env.CLAUDE_CODE_OAUTH_TOKEN ?? "") !== "";

/** 別のホストへ転送する URL（golang.org → go.dev）。CLI の WebFetch は別のホストへの転送を自動では追わず、転送先を結果で返す */
const REDIRECTING_URL = "https://golang.org/";

test(
  "WebFetch のガード: 貼った URL が別のホストへ転送されても、転送先を拒否せずに読める",
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
    // session_open・kb_delete の確認・記憶の知らせはここでは使わない
    const kbMemory = {
      knowledge: new KnowledgeStore(db),
      memories: new MemoryStore(db),
      confirmKbDelete: async () => {},
      notifyMemoryChange: async () => {},
      timeZone: cfg.timeZone,
    };
    // プロジェクトもここでは使わない（配信は無効）
    const projects = new ProjectStore(db);
    const projectsDir = join(cfg.workDir, "projects");
    const projectTools = { projects, projectsDir, publicBaseUrl: undefined, serving: () => false };
    const logs: string[] = [];
    const runner = new SdkAgentRunner(
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
      (line) => logs.push(line),
    );

    const request = `${REDIRECTING_URL} このページを読んで、ページの題名を答えてください。`;
    const result = await runner.run({
      prompt: buildTurnPrompt(request, new Date(), cfg.timeZone),
      allowedUrls: [REDIRECTING_URL],
    });

    // 回数だけを出す（URL・本文は出さない）
    const denials = logs.filter((line) => line.startsWith("WebFetch を拒否しました"));
    const redirects = logs.filter((line) => line === "WebFetch の転送先を許可しました");
    t.diagnostic(
      `ツール呼び出し ${result.toolCalls} 回、WebFetch の拒否 ${denials.length} 回、転送先の許可 ${redirects.length} 回`,
    );
    assert.ok(result.ok, result.ok ? "" : result.errorMessage);
    assert.equal(denials.length, 0, "WebFetch がガードに拒否された");
    // 転送の結果（tool_response）から転送先を読めた
    assert.ok(redirects.length >= 1, "転送先を許可に加えていない（WebFetch を呼ばなかったか、結果を読めなかった）");
  },
);
