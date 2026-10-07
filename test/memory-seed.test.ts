import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentRunner, RunInput, RunResult } from "../src/agent/runner.ts";
import {
  type ChannelTurn,
  MEMORY_BLOCK_HEADER,
  memoryBlock,
  RESUME_SEED_HEADER,
  runChannelTurn,
  type TurnDeps,
} from "../src/app/turn.ts";
import { ChannelSeedStore } from "../src/store/channel-seeds.ts";
import { openDb } from "../src/store/db.ts";
import { InboxSummaryStore } from "../src/store/inbox-summaries.ts";
import { MemoryStore } from "../src/store/memories.ts";
import { SdkSessionStore } from "../src/store/sdk-sessions.ts";
import { TopicSessionStore } from "../src/store/topic-sessions.ts";
import { UsageStore } from "../src/store/usage.ts";

const NOW = new Date("2026-10-07T00:00:00.000Z");
const PROMPT = "[2026-10-07(水) 09:00 JST #旅行の計画]\n明日の天気は？";
const TURN: ChannelTurn = { guildId: "guild-1", channelId: "topic-1", kind: "session", prompt: PROMPT, allowedUrls: [] };

class FakeRunner implements AgentRunner {
  inputs: RunInput[] = [];
  private readonly results: RunResult[];

  constructor(results: RunResult[]) {
    this.results = results;
  }

  async run(input: RunInput): Promise<RunResult> {
    this.inputs.push(input);
    const next = this.results.shift();
    if (next === undefined) throw new Error("想定外の呼び出し");
    return next;
  }
}

function ok(sessionId: string): RunResult {
  return {
    ok: true,
    text: "はい",
    sessionId,
    usage: { inputTokens: 1, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 },
    durationMs: 1,
    toolCalls: 0,
    contextTokens: 1,
  };
}

const RESUME_FAILURE: RunResult = {
  ok: false,
  errorMessage: "error_during_execution: No conversation found with session ID: session-old",
  sessionRecorded: false,
  toolCalls: 0,
};

const TIMEOUT: RunResult = { ok: false, errorMessage: "timeout", sessionRecorded: false, toolCalls: 0 };

function setup(t: TestContext, results: RunResult[]) {
  const dir = mkdtempSync(join(tmpdir(), "self-agent-test-"));
  const db = openDb(join(dir, "self-agent.db"));
  t.after(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const runner = new FakeRunner(results);
  const sessions = new SdkSessionStore(db, () => NOW);
  const seeds = new ChannelSeedStore(db, () => NOW);
  const topicSessions = new TopicSessionStore(db, () => NOW);
  const memories = new MemoryStore(db, () => NOW);
  const deps: TurnDeps = {
    runner,
    sessions,
    seeds,
    topicSessions,
    inboxSummaries: new InboxSummaryStore(db, () => NOW),
    memories,
    usage: new UsageStore(db, () => NOW),
    log: () => {},
  };
  topicSessions.create({ channelId: "topic-1", guildId: "guild-1", title: "旅行の計画", categoryId: "active-1" });
  return { runner, sessions, seeds, memories, deps, run: () => runChannelTurn(deps, TURN) };
}

/** 有効な記憶 #1・#3（#2 は消した） */
function remember(memories: MemoryStore): string {
  memories.add("住んでいる地域: 東京都練馬区");
  memories.add("消した記憶");
  memories.add("仕事: Web エンジニア");
  memories.softDelete(2);
  return `${MEMORY_BLOCK_HEADER}\n- [#1] 住んでいる地域: 東京都練馬区\n- [#3] 仕事: Web エンジニア`;
}

test("記憶のブロック: 見出しの後に有効な記憶を id 順に「- [#id] 本文」で並べる。0 件なら付けない", () => {
  assert.equal(MEMORY_BLOCK_HEADER, "オーナーについての記憶（アプリが保存したもの）:");
  assert.equal(
    memoryBlock([
      { id: 3, text: "住んでいる地域: 東京都練馬区" },
      { id: 7, text: "好み: 辛いものが苦手" },
    ]),
    "オーナーについての記憶（アプリが保存したもの）:\n- [#3] 住んでいる地域: 東京都練馬区\n- [#7] 好み: 辛いものが苦手",
  );
  assert.equal(memoryBlock([]), undefined);
});

test("新しいセッション（SDK セッション無し）: prompt の先頭に記憶のブロックを付ける。記憶は seed には保存しない", async (t) => {
  const { runner, seeds, memories, run } = setup(t, [ok("session-1")]);
  const block = remember(memories);

  await run();

  assert.deepEqual(runner.inputs, [
    {
      prompt: `${block}\n\n${PROMPT}`,
      sessionId: undefined,
      context: { guildId: "guild-1", channelId: "topic-1", kind: "session" },
      allowedUrls: [],
    },
  ]);
  assert.equal(seeds.get("topic-1"), undefined);
});

test("新しいセッション + seed（/new・session_open の最初・#inbox の切り替え後）: [記憶のブロック, seed, prompt] を空行でつなぎ、成功したら seed だけ消す", async (t) => {
  const { runner, seeds, memories, run } = setup(t, [ok("session-1")]);
  const block = remember(memories);
  seeds.set("topic-1", "#inbox からの続き:\n京都に 2 泊");

  await run();

  assert.equal(runner.inputs[0]?.prompt, `${block}\n\n#inbox からの続き:\n京都に 2 泊\n\n${PROMPT}`);
  assert.equal(runner.inputs[0]?.sessionId, undefined);
  assert.equal(seeds.get("topic-1"), undefined);
  assert.deepEqual(
    memories.list().map((memory) => memory.id),
    [1, 3],
  );
});

test("resume（SDK セッションあり）: 記憶のブロックは付けない", async (t) => {
  const { runner, sessions, memories, run } = setup(t, [ok("session-1")]);
  remember(memories);
  sessions.set("topic-1", "session-1");

  await run();

  assert.deepEqual(
    runner.inputs.map((input) => [input.prompt, input.sessionId]),
    [[PROMPT, "session-1"]],
  );
});

test("記憶が 0 件（すべて消した場合を含む）なら、ブロックも余分な空行も付けない", async (t) => {
  const { runner, seeds, memories, run } = setup(t, [TIMEOUT, ok("session-1")]);
  memories.add("消す");
  memories.softDelete(1);

  await run();
  seeds.set("topic-1", "seed");
  await run();

  assert.deepEqual(
    runner.inputs.map((input) => input.prompt),
    [PROMPT, `seed\n\n${PROMPT}`],
  );
});

test("resume の失敗からの復旧（sessionId 無しでやり直す）: [記憶のブロック, 復旧の seed, prompt] で 1 回だけやり直す", async (t) => {
  const { runner, sessions, seeds, memories, run } = setup(t, [RESUME_FAILURE, ok("session-new")]);
  const block = remember(memories);
  sessions.set("topic-1", "session-old");

  await run();

  const seed = `${RESUME_SEED_HEADER}\n題名: 旅行の計画`;
  assert.deepEqual(
    runner.inputs.map((input) => [input.prompt, input.sessionId]),
    [
      [PROMPT, "session-old"],
      [`${block}\n\n${seed}\n\n${PROMPT}`, undefined],
    ],
  );
  assert.equal(sessions.get("topic-1"), "session-new");
  assert.equal(seeds.get("topic-1"), undefined);
});

test("記憶のブロックは毎回 DB から作る（新しいセッションがまだできていなければ、次のターンで変更後の記憶を付ける）", async (t) => {
  const { runner, memories, run } = setup(t, [TIMEOUT, ok("session-1"), ok("session-1")]);
  memories.add("住んでいる地域: 東京都練馬区");

  await run();
  memories.add("仕事: Web エンジニア");
  await run();
  // セッションができた後の変更は、続いているセッションには付けない
  memories.add("好み: 辛いものが苦手");
  await run();

  assert.deepEqual(
    runner.inputs.map((input) => input.prompt),
    [
      `${MEMORY_BLOCK_HEADER}\n- [#1] 住んでいる地域: 東京都練馬区\n\n${PROMPT}`,
      `${MEMORY_BLOCK_HEADER}\n- [#1] 住んでいる地域: 東京都練馬区\n- [#2] 仕事: Web エンジニア\n\n${PROMPT}`,
      PROMPT,
    ],
  );
});
