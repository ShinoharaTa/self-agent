import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import type { RunResult } from "../src/agent/runner.ts";
import { createSessionToolHandlers } from "../src/agent/tools.ts";
import { ensureGuildLayout } from "../src/app/commands/setup.ts";
import type { RotateNowResult } from "../src/app/inbox-rotate.ts";
import { KeyedSerialQueue } from "../src/app/queue.ts";
import {
  closeSession,
  confirmClose,
  CONTINUED_TEXT,
  continueSession,
  openTopicSession,
  renewChannel,
  WAITED_REPLY,
  waitSession,
  welcomeText,
} from "../src/app/session-ops.ts";
import type { SummaryChannelKind } from "../src/store/inbox-summaries.ts";
import { createStores, tempDb, tempDir } from "./helpers/db.ts";
import { FakeGateway } from "./helpers/gateway.ts";
import { RecordingChannelOps, RecordingQueue } from "./helpers/recording.ts";
import { FakeRunner, type FakeRunStep, turnUsage } from "./helpers/runner.ts";

const NOW = new Date("2026-10-02T00:12:00Z");
const TOPIC = { channelId: "topic-1", guildId: "guild-1", title: "旅行の計画", categoryId: "active-1" };

function ok(text: string): RunResult {
  return { ok: true, text, sessionId: "session-1", usage: turnUsage(10, 2000, 300), durationMs: 4200, toolCalls: 0, contextTokens: 2310 };
}

const FAILED: RunResult = {
  ok: false,
  errorMessage: "error_during_execution: boom",
  sessionId: "session-1",
  sessionRecorded: true,
  toolCalls: 0,
};

class FakeRotator {
  calls: SummaryChannelKind[] = [];
  async rotateNow(_guildId: string, kind: SummaryChannelKind): Promise<RotateNowResult> {
    this.calls.push(kind);
    return "rotated";
  }
}

function setup(t: TestContext, steps: FakeRunStep[] = []) {
  const db = tempDb(t);
  const stores = createStores(db, () => NOW);
  const { topicSessions, tasks, sessions, seeds, inboxSummaries, memories, usage, projects, history, guildSettings } = stores;
  const runner = new FakeRunner(steps);
  const channelOps = new RecordingChannelOps();
  const turnQueue = new RecordingQueue(2);
  const inboxRotator = new FakeRotator();
  const logs: string[] = [];
  const log = (line: string): number => logs.push(line);
  const deps = {
    topicSessions,
    tasks,
    channelOps,
    turnQueue,
    turn: { runner, sessions, seeds, topicSessions, inboxSummaries, memories, usage, log },
    projects,
    projectsDir: join(tempDir(t), "projects"),
    guildSettings,
    inboxRotator,
    history,
    log,
  };
  topicSessions.create(TOPIC);
  sessions.set("topic-1", "session-1");
  guildSettings.setChannel("guild-1", "inboxChannelId", "inbox-1");
  /** 受け付けた（onAccepted を呼んだ）回数 */
  const accepted = { count: 0 };
  const onAccepted = async (): Promise<void> => {
    accepted.count += 1;
  };
  return { deps, runner, history, inboxRotator, logs, accepted, onAccepted };
}

test("openTopicSession: 空の題名は empty_title（受け付けない）、/setup 前は not_set_up、作れたら created と最初の投稿", async (t) => {
  const db = tempDb(t);
  const gateway = new FakeGateway({
    allow: ["getParentId", "sendMessage", "pinMessage", "messageExists"],
    record: ["createCategory", "createTextChannel", "channelExists", "countChannelsIn", "moveChannel", "send"],
  });
  const { guildSettings, topicSessions } = createStores(db, () => NOW);
  const channelOps = { enqueueMove: () => assert.fail("想定外の移動") };
  const deps = { gateway, guildSettings, topicSessions, queue: new KeyedSerialQueue(1), channelOps, log: () => {} };
  let accepted = 0;
  const onAccepted = async (): Promise<void> => {
    accepted += 1;
  };

  assert.deepEqual(await openTopicSession("guild-1", "  ", undefined, deps, "/new で", onAccepted), { result: "empty_title" });
  assert.equal(accepted, 0);
  assert.deepEqual(await openTopicSession("guild-1", "旅行", undefined, deps, "/new で", onAccepted), { result: "not_set_up" });
  assert.equal(accepted, 1);

  assert.equal((await ensureGuildLayout("guild-1", deps)).failure, null);
  gateway.reset();
  const result = await openTopicSession("guild-1", " 旅行 ", undefined, deps, "/new で", onAccepted);
  assert.equal(result.result, "created");
  assert.ok(result.result === "created");
  assert.equal(topicSessions.get(result.channelId)?.title, "旅行");
  assert.deepEqual(
    gateway.sent.map((sent) => ({ channelId: sent.channelId, text: sent.text })),
    [{ channelId: result.channelId, text: welcomeText("旅行") }],
  );
});

test("waitSession・continueSession: 結果の種類と、変えたときだけ history の知らせ", (t) => {
  const env = setup(t);
  const notices = (): string[] => env.history.list("topic-1", { limit: 50 }).map((row) => `${row.kind}:${row.text}`);

  assert.equal(waitSession("guild-1", "unknown", env.deps), "not_session");
  assert.equal(waitSession("guild-2", "topic-1", env.deps), "not_session");
  assert.equal(continueSession("guild-1", "unknown", env.deps), "not_session");
  assert.equal(continueSession("guild-1", "topic-1", env.deps), "unchanged");
  assert.equal(waitSession("guild-1", "topic-1", env.deps), "waited");
  assert.equal(waitSession("guild-1", "topic-1", env.deps), "unchanged");
  assert.equal(continueSession("guild-1", "topic-1", env.deps), "continued");
  assert.deepEqual(notices(), [`notice:${WAITED_REPLY}`, `notice:${CONTINUED_TEXT}`]);

  env.deps.topicSessions.close("topic-1", "要約");
  assert.equal(waitSession("guild-1", "topic-1", env.deps), "closed");
  env.deps.topicSessions.markDeleted("topic-1");
  assert.equal(waitSession("guild-1", "topic-1", env.deps), "closed");
  assert.equal(continueSession("guild-1", "topic-1", env.deps), "deleted");
});

test("closeSession: セッションでない・閉じているなら受け付けない。失敗は failed、候補が無ければ finalized", async (t) => {
  const env = setup(t, [FAILED, ok("閉じました")]);

  assert.deepEqual(await closeSession("guild-1", "inbox-1", env.deps, env.onAccepted), { result: "not_session" });
  assert.equal(env.accepted.count, 0);

  const failed = await closeSession("guild-1", "topic-1", env.deps, env.onAccepted);
  assert.equal(failed.result, "failed");
  assert.equal(env.accepted.count, 1);

  const finalized = await closeSession("guild-1", "topic-1", env.deps, env.onAccepted);
  assert.deepEqual(finalized, { result: "finalized", summary: "閉じました" });
  assert.equal(env.deps.topicSessions.get("topic-1")?.state, "done");

  assert.deepEqual(await closeSession("guild-1", "topic-1", env.deps, env.onAccepted), { result: "closed" });
  assert.equal(env.accepted.count, 2);
});

test("closeSession → confirmClose: 候補があれば confirm、確定で closed と登録数、2 回目は no_draft", async (t) => {
  const draft = { summary: "京都に 2 泊する", tasks: [{ title: "宿を予約する" }, { title: "休みの申請" }] };
  const steps: FakeRunStep[] = [];
  const env = setup(t, steps);
  // session_report を呼んでから返答するターン（ツールのハンドラは run に渡された context で動く）
  steps.push((input) => {
    createSessionToolHandlers(env.deps.topicSessions, input.context).sessionReport(draft);
    return ok("閉じる準備ができました");
  });

  assert.deepEqual(confirmClose("guild-1", "topic-1", "all", env.deps), { result: "no_draft" });
  const outcome = await closeSession("guild-1", "topic-1", env.deps);
  assert.deepEqual(outcome, { result: "confirm", draft });

  assert.deepEqual(confirmClose("guild-1", "topic-1", [1], env.deps), { result: "closed", summary: draft.summary, registered: 1 });
  assert.equal(env.deps.topicSessions.get("topic-1")?.state, "done");
  assert.deepEqual(confirmClose("guild-1", "topic-1", "all", env.deps), { result: "no_draft" });
});

test("renewChannel: 受け付けないチャンネルは not_renewable、閉じたセッションは closed、#inbox・セッションは done と結果の文", async (t) => {
  const env = setup(t, [ok("- 要約")]);

  assert.deepEqual(await renewChannel("guild-1", "unknown", env.deps, env.onAccepted), { result: "not_renewable" });
  assert.equal(env.accepted.count, 0);

  const inbox = await renewChannel("guild-1", "inbox-1", env.deps, env.onAccepted);
  assert.equal(inbox.result, "done");
  assert.deepEqual(env.inboxRotator.calls, ["inbox"]);

  const session = await renewChannel("guild-1", "topic-1", env.deps, env.onAccepted);
  assert.equal(session.result, "done");
  assert.ok(session.result === "done" && session.text.includes("- 要約"));
  assert.equal(env.accepted.count, 2);

  env.deps.topicSessions.close("topic-1", "要約");
  assert.deepEqual(await renewChannel("guild-1", "topic-1", env.deps, env.onAccepted), { result: "closed" });
  assert.equal(env.accepted.count, 2);
});
