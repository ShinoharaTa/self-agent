import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RunContext } from "../src/agent/runner.ts";
import { createSessionToolHandlers, type TextToolResult } from "../src/agent/tools.ts";
import { openDb } from "../src/store/db.ts";
import { TopicSessionStore } from "../src/store/topic-sessions.ts";

function setup(t: TestContext) {
  const dir = mkdtempSync(join(tmpdir(), "self-agent-test-"));
  const db = openDb(join(dir, "self-agent.db"));
  t.after(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const topicSessions = new TopicSessionStore(db, () => new Date("2026-10-02T00:12:00Z"));
  topicSessions.create({ channelId: "topic-1", guildId: "guild-1", title: "旅行の計画", categoryId: "active-1" });
  return { db, topicSessions };
}

function parse(result: TextToolResult): unknown {
  assert.equal(result.content.length, 1);
  assert.equal(result.content[0].type, "text");
  return JSON.parse(result.content[0].text);
}

const ARGS = {
  summary: "京都に 2 泊する",
  tasks: [{ title: "宿を予約する", due: "2026-10-05" }, { title: "休みの申請" }],
};

test("session_report: セッションのチャンネルなら close_draft に保存して { ok: true } を返す（前の下書きは置き換える）", (t) => {
  const { db, topicSessions } = setup(t);
  const handlers = createSessionToolHandlers(topicSessions, { guildId: "guild-1", channelId: "topic-1", kind: "session" });

  assert.deepEqual(parse(handlers.sessionReport({ summary: "古い" })), { ok: true });
  assert.deepEqual(parse(handlers.sessionReport(ARGS)), { ok: true });

  assert.deepEqual(topicSessions.getCloseDraft("topic-1"), ARGS);
  assert.equal(
    db.prepare("SELECT close_draft FROM sessions WHERE channel_id = 'topic-1'").get()?.close_draft,
    JSON.stringify(ARGS),
  );
  // 下書きを残すだけで、状態は変えない
  assert.equal(topicSessions.get("topic-1")?.state, "active");
  assert.equal(topicSessions.get("topic-1")?.summary, null);
});

test("session_report: tasks を省略したら空の配列で保存する。待ち・完了のセッションでも保存する", (t) => {
  const { db, topicSessions } = setup(t);
  const handlers = createSessionToolHandlers(topicSessions, { guildId: "guild-1", channelId: "topic-1", kind: "session" });

  for (const state of ["waiting", "done"]) {
    db.prepare("UPDATE sessions SET state = ? WHERE channel_id = 'topic-1'").run(state);
    assert.deepEqual(parse(handlers.sessionReport({ summary: state })), { ok: true });
    assert.deepEqual(topicSessions.getCloseDraft("topic-1"), { summary: state, tasks: [] });
  }
});

test("session_report: セッション以外（#inbox・削除済み・別サーバー・context 無し）では not_available を返し、何も保存しない", (t) => {
  const { db, topicSessions } = setup(t);
  topicSessions.create({ channelId: "topic-2", guildId: "guild-1", title: "削除済み", categoryId: "done-1" });
  db.prepare("UPDATE sessions SET state = 'deleted' WHERE channel_id = 'topic-2'").run();

  const contexts: Array<RunContext | undefined> = [
    { guildId: "guild-1", channelId: "inbox-1", kind: "inbox" },
    { guildId: "guild-1", channelId: "topic-2", kind: "session" },
    { guildId: "guild-9", channelId: "topic-1", kind: "session" },
    undefined,
  ];
  for (const context of contexts) {
    const result = createSessionToolHandlers(topicSessions, context).sessionReport(ARGS);
    assert.deepEqual(parse(result), { result: "not_available" }, JSON.stringify(context));
  }
  assert.equal(topicSessions.getCloseDraft("topic-1"), undefined);
  assert.equal(topicSessions.getCloseDraft("topic-2"), undefined);
});

test("session_report: #tasks では not_available を返し、何も保存しない", (t) => {
  const { topicSessions } = setup(t);

  const result = createSessionToolHandlers(topicSessions, { guildId: "guild-1", channelId: "tasks-1", kind: "tasks" }).sessionReport(
    ARGS,
  );

  assert.deepEqual(parse(result), { result: "not_available" });
  assert.equal(topicSessions.getCloseDraft("tasks-1"), undefined);
  assert.equal(topicSessions.getCloseDraft("topic-1"), undefined);
});
