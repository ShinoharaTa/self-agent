// 単体テストの DB の準備。一時ディレクトリの SQLite と、本体と同じストア

import { mkdtempSync, rmSync } from "node:fs";
import type { DatabaseSync } from "node:sqlite";
import type { TestContext } from "node:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AttachmentStore } from "../../src/store/attachments.ts";
import { ChannelSeedStore } from "../../src/store/channel-seeds.ts";
import { openDb } from "../../src/store/db.ts";
import { GuildSettingsStore } from "../../src/store/guild-settings.ts";
import { InboxSummaryStore } from "../../src/store/inbox-summaries.ts";
import { KnowledgeStore } from "../../src/store/knowledge.ts";
import { MemoryStore } from "../../src/store/memories.ts";
import { ProjectStore } from "../../src/store/projects.ts";
import { ReminderStore } from "../../src/store/reminders.ts";
import { RoutineRecordStore } from "../../src/store/routine-records.ts";
import { RoutineStore } from "../../src/store/routines.ts";
import { SdkSessionStore } from "../../src/store/sdk-sessions.ts";
import { TaskStore } from "../../src/store/tasks.ts";
import { TopicSessionStore } from "../../src/store/topic-sessions.ts";
import { UsageStore } from "../../src/store/usage.ts";

/** 一時ディレクトリを作り、テストの終わりに消す */
export function tempDir(t: TestContext): string {
  const dir = mkdtempSync(join(tmpdir(), "self-agent-test-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** 一時ディレクトリに DB を開き、テストの終わりに閉じて（テストで閉じていなければ）消す */
export function tempDb(t: TestContext): DatabaseSync {
  const dir = mkdtempSync(join(tmpdir(), "self-agent-test-"));
  const db = openDb(join(dir, "self-agent.db"));
  t.after(() => {
    if (db.isOpen) db.close();
    rmSync(dir, { recursive: true, force: true });
  });
  return db;
}

/** 本体と同じストアを同じ時計で作る。別の時計が要るストアは、テスト側でそれだけ作り直す */
export function createStores(db: DatabaseSync, now: () => Date) {
  return {
    tasks: new TaskStore(db, now),
    sessions: new SdkSessionStore(db, now),
    usage: new UsageStore(db, now),
    guildSettings: new GuildSettingsStore(db, now),
    topicSessions: new TopicSessionStore(db, now),
    seeds: new ChannelSeedStore(db, now),
    inboxSummaries: new InboxSummaryStore(db, now),
    knowledge: new KnowledgeStore(db, now),
    memories: new MemoryStore(db, now),
    projects: new ProjectStore(db, now),
    reminders: new ReminderStore(db, now),
    routines: new RoutineStore(db, now),
    routineRecords: new RoutineRecordStore(db, now),
    attachments: new AttachmentStore(db, now),
  };
}
