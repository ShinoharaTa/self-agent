// 結合テスト: 実際に Agent SDK を動かし、画像付きのターン（prompt を AsyncIterable で渡す）で返事が返り、
// 次の文字だけのターンで同じ SDK セッションを resume できるか確かめる（利用枠を消費する）。CLAUDE_CODE_OAUTH_TOKEN が無ければ skip
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { crc32, deflateSync } from "node:zlib";
import type { AgentRunner, RunInput, RunResult } from "../../src/agent/runner.ts";
import { DiskQuota } from "../../src/agent/disk.ts";
import { SdkAgentRunner } from "../../src/agent/sdk-runner.ts";
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
import { ReminderStore } from "../../src/store/reminders.ts";
import { SdkSessionStore } from "../../src/store/sdk-sessions.ts";
import { TaskStore } from "../../src/store/tasks.ts";
import { TopicSessionStore } from "../../src/store/topic-sessions.ts";
import { UsageStore } from "../../src/store/usage.ts";

const tokenPresent = (process.env.CLAUDE_CODE_OAUTH_TOKEN ?? "") !== "";

/** 1 色で塗った width × height の PNG（8 ビットの RGB） */
function solidPng(width: number, height: number, rgb: [number, number, number]): Buffer {
  const chunk = (type: string, data: Buffer): Buffer => {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body));
    return Buffer.concat([length, body, crc]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header.set([8, 2, 0, 0, 0], 8);
  // 行ごとにフィルタの種類（0）+ 画素
  const row = Buffer.concat([Buffer.from([0]), Buffer.alloc(width * 3).map((_, index) => rgb[index % 3]!)]);
  const raw = Buffer.concat(Array.from({ length: height }, () => row));
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

test(
  "画像付きのターン: 返事が返り、次の文字だけのターンで同じ SDK セッションを resume できる",
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
    const projectTools = { projects, projectsDir, publicBaseUrl: undefined, serving: () => false, log: () => {} };
    const sdkRunner = new SdkAgentRunner(
      cfg,
      (context) =>
        createTaskMcpServer(
          new TaskStore(db),
          new TopicSessionStore(db),
          async () => ({ result: "not_available" }),
          kbMemory,
          projectTools,
          { reminders: new ReminderStore(db), log: () => {} },
          context,
        ),
      { projects, projectsDir, disk: new DiskQuota({ workDir: cfg.workDir, projectsDir, now: () => new Date() }) },
      () => {},
    );
    // run の入力の sessionId・画像の有無と結果を記録する（resume 失敗の復旧で 2 回走っていないか確かめる）
    const runs: Array<{ sessionId: string | undefined; images: number; result: RunResult }> = [];
    const runner: AgentRunner = {
      run: async (input: RunInput) => {
        const result = await sdkRunner.run(input);
        runs.push({ sessionId: input.sessionId, images: input.images?.length ?? 0, result });
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
    const turn = { guildId: "guild-1", channelId: "inbox-1", kind: "inbox" as const, allowedUrls: [] };
    const png = solidPng(64, 64, [220, 20, 20]);

    const first = await runChannelTurn(deps, {
      ...turn,
      prompt: buildTurnPrompt("この画像は何色ですか。色の名前だけを答えてください。", new Date(), cfg.timeZone),
      images: [{ mediaType: "image/png", data: png.toString("base64") }],
    });
    assert.ok(first.ok, first.ok ? "" : first.errorMessage);
    t.diagnostic(`1 ターン目の返答: ${first.text}`);
    assert.equal(sessions.get("inbox-1"), first.sessionId);

    const second = await runChannelTurn(deps, {
      ...turn,
      prompt: buildTurnPrompt("さっきの画像の色をもう一度教えてください。", new Date(), cfg.timeZone),
    });
    t.diagnostic(
      `run: ${runs
        .map((run) => `${run.sessionId === undefined ? "new" : "resume"}・画像 ${run.images} → ${run.result.ok ? "ok" : run.result.errorMessage}`)
        .join(" / ")}`,
    );
    assert.equal(runs.length, 2, "2 ターン目で resume に失敗し、新しいセッションでやり直した");
    assert.equal(runs[0]!.images, 1);
    assert.equal(runs[1]!.images, 0);
    assert.equal(runs[1]!.sessionId, first.sessionId);
    assert.ok(second.ok, second.ok ? "" : second.errorMessage);
    assert.equal(second.sessionId, first.sessionId);
    t.diagnostic(`2 ターン目の返答: ${second.text}`);
  },
);
