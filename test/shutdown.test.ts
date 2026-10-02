import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setImmediate as flush } from "node:timers/promises";
import type { AgentRunner, RunInput, RunResult } from "../src/agent/runner.ts";
import { createChannelResolver } from "../src/app/access.ts";
import { createHandler } from "../src/app/handler.ts";
import { KeyedSerialQueue } from "../src/app/queue.ts";
import { Scheduler, TICK_INTERVAL_MS } from "../src/app/scheduler.ts";
import { createShutdown, RESTARTING_REPLY, type InnerHandlers, type ShutdownDeps } from "../src/app/shutdown.ts";
import type {
  Gateway,
  IncomingMessage,
  Interaction,
  InteractionResponder,
  ModalDef,
  OutgoingMessage,
} from "../src/discord/gateway.ts";
import { ChannelSeedStore } from "../src/store/channel-seeds.ts";
import { openDb } from "../src/store/db.ts";
import { GuildSettingsStore } from "../src/store/guild-settings.ts";
import { SdkSessionStore } from "../src/store/sdk-sessions.ts";
import { TopicSessionStore } from "../src/store/topic-sessions.ts";
import { UsageStore } from "../src/store/usage.ts";

const NOW = new Date("2026-10-02T00:12:00Z");
const cfg = {
  allowedGuildIds: ["guild-1"],
  inboxChannelId: "inbox-1",
  ownerUserId: "owner-1",
  timeZone: "Asia/Tokyo",
  shutdownGraceSec: 30,
};

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

/** send・stop と DB を閉じた順番を events に記録する */
class FakeGateway implements Gateway {
  readonly events: string[];
  stopError: Error | undefined;

  constructor(events: string[]) {
    this.events = events;
  }

  async start(): Promise<void> {}
  async send(_channelId: string, text: string): Promise<void> {
    this.events.push(`send ${text}`);
  }
  async sendMessage(_channelId: string, message: OutgoingMessage): Promise<void> {
    this.events.push(`sendMessage ${message.text}`);
  }
  startTyping(): () => void {
    return () => {};
  }
  isInGuild(): boolean {
    return true;
  }
  async registerGuildCommands(): Promise<void> {}
  async createCategory(): Promise<string> {
    throw new Error("想定外の呼び出し");
  }
  async createTextChannel(): Promise<string> {
    throw new Error("想定外の呼び出し");
  }
  async channelExists(): Promise<boolean> {
    throw new Error("想定外の呼び出し");
  }
  async countChannelsIn(): Promise<number> {
    throw new Error("想定外の呼び出し");
  }
  async moveChannel(): Promise<void> {
    throw new Error("想定外の呼び出し");
  }
  async getParentId(): Promise<string | null> {
    throw new Error("想定外の呼び出し");
  }
  async stop(): Promise<void> {
    this.events.push("stop");
    if (this.stopError !== undefined) throw this.stopError;
  }
}

class FakeResponder implements InteractionResponder {
  readonly replies: OutgoingMessage[] = [];
  readonly events: string[];

  constructor(events: string[] = []) {
    this.events = events;
  }

  async defer(): Promise<void> {}
  async deferUpdate(): Promise<void> {}
  async reply(message: OutgoingMessage): Promise<void> {
    this.replies.push(message);
    this.events.push(`reply ${message.text}`);
  }
  async update(): Promise<void> {}
  async showModal(_modal: ModalDef): Promise<void> {}
}

/** run を呼ばれたら gate が開くまで待ってから返す */
class GatedRunner implements AgentRunner {
  inputs: RunInput[] = [];
  readonly gate = deferred();

  async run(input: RunInput): Promise<RunResult> {
    this.inputs.push(input);
    await this.gate.promise;
    return {
      ok: true,
      text: `返答 ${this.inputs.length}`,
      sessionId: "session-1",
      usage: { inputTokens: 1, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 },
      durationMs: 10,
    };
  }
}

function message(id: string): IncomingMessage {
  return {
    id,
    channelId: "inbox-1",
    guildId: "guild-1",
    authorId: "owner-1",
    authorIsBot: false,
    isWebhook: false,
    content: "明日買い物に行く",
    createdAt: NOW,
  };
}

function interaction(guildId: string | null): Interaction {
  return { guildId, channelId: "channel-1", userId: "owner-1", createdAt: NOW, kind: "command", name: "help", options: {} };
}

/** 停止の部品。closeDb は events に記録する */
function deps(
  events: string[],
  overrides: Partial<Omit<ShutdownDeps, "gateway">> & { gateway?: FakeGateway } = {},
): ShutdownDeps & { gateway: FakeGateway; logs: string[] } {
  const logs: string[] = [];
  return {
    cfg,
    gateway: new FakeGateway(events),
    queues: [],
    scheduler: { stop: () => {}, idle: async () => {} },
    closeDb: () => {
      events.push("closeDb");
    },
    log: (line) => {
      logs.push(line);
    },
    ...overrides,
    logs,
  };
}

const noopInner: InnerHandlers = { handleMessage: async () => {}, handleInteraction: async () => {} };

test("停止前は発言・操作を中のハンドラにそのまま渡す", () => {
  const messages: string[] = [];
  const interactions: Interaction[] = [];
  const { handlers, stopping } = createShutdown(deps([]), {
    handleMessage: async (event) => {
      messages.push(event.id);
    },
    handleInteraction: async (event) => {
      interactions.push(event);
    },
  });

  handlers.onMessage(message("message-1"));
  handlers.onInteraction(interaction("guild-1"), new FakeResponder());

  assert.equal(stopping(), false);
  assert.deepEqual(messages, ["message-1"]);
  assert.deepEqual(interactions, [interaction("guild-1")]);
});

test("停止を始めたら新しい発言は何もせず、許可したサーバーの操作には「再起動中です」を ephemeral で返す。DM・許可外には応答しない", async () => {
  const events: string[] = [];
  let called = 0;
  const { handlers, shutdown, stopping } = createShutdown(deps(events), {
    handleMessage: async () => {
      called++;
    },
    handleInteraction: async () => {
      called++;
    },
  });

  const done = shutdown();
  assert.equal(stopping(), true);
  handlers.onMessage(message("message-1"));
  const allowed = new FakeResponder(events);
  const dm = new FakeResponder(events);
  const otherGuild = new FakeResponder(events);
  handlers.onInteraction(interaction("guild-1"), allowed);
  handlers.onInteraction(interaction(null), dm);
  handlers.onInteraction(interaction("guild-9"), otherGuild);
  await done;

  assert.equal(called, 0);
  assert.equal(RESTARTING_REPLY, "再起動中です");
  assert.deepEqual(allowed.replies, [{ text: RESTARTING_REPLY, ephemeral: true }]);
  assert.deepEqual(dm.replies, []);
  assert.deepEqual(otherGuild.replies, []);
  assert.deepEqual(events, [`reply ${RESTARTING_REPLY}`, "stop", "closeDb"]);
});

function handlerSetup(t: TestContext) {
  const dir = mkdtempSync(join(tmpdir(), "self-agent-test-"));
  const db = openDb(join(dir, "self-agent.db"));
  t.after(() => {
    if (db.isOpen) db.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const events: string[] = [];
  const gateway = new FakeGateway(events);
  const runner = new GatedRunner();
  const usage = new UsageStore(db, () => NOW);
  const topicSessions = new TopicSessionStore(db, () => NOW);
  const turnQueue = new KeyedSerialQueue(2);
  const handle = createHandler({
    cfg,
    resolveChannel: createChannelResolver(cfg, new GuildSettingsStore(db, () => NOW), topicSessions),
    gateway,
    runner,
    sessions: new SdkSessionStore(db, () => NOW),
    seeds: new ChannelSeedStore(db, () => NOW),
    topicSessions,
    channelOps: { enqueueMove: () => {} },
    usage,
    queue: turnQueue,
    log: () => {},
  });
  const shutdownDeps = deps(events, {
    gateway,
    queues: [turnQueue],
    closeDb: () => {
      // 閉じる時点で usage は記録済み
      events.push(`closeDb usage=${usage.recent(10).length}`);
      db.close();
    },
  });
  return { events, gateway, runner, turnQueue, handle, shutdownDeps };
}

test("受け付け済みのターンは返信を送り終えてから gateway を止めて DB を閉じる。停止中に来た発言は処理しない", async (t) => {
  const { events, runner, handle, shutdownDeps } = handlerSetup(t);
  const { handlers, shutdown } = createShutdown(shutdownDeps, { handleMessage: handle, handleInteraction: async () => {} });

  handlers.onMessage(message("message-1"));
  await flush();
  assert.equal(runner.inputs.length, 1);

  let finished = false;
  const done = shutdown().then(() => {
    finished = true;
  });
  handlers.onMessage(message("message-2"));
  await flush();
  assert.equal(finished, false);
  assert.deepEqual(events, []);

  runner.gate.resolve();
  await done;

  assert.equal(runner.inputs.length, 1);
  assert.deepEqual(events, ["send 返答 1", "stop", "closeDb usage=1"]);
});

test("キューの後で返信する操作（/close など）も、返信まで待ってから gateway を止める", async () => {
  const events: string[] = [];
  const turnQueue = new KeyedSerialQueue(1);
  const gate = deferred();
  const { handlers, shutdown } = createShutdown(deps(events, { queues: [turnQueue] }), {
    ...noopInner,
    handleInteraction: async (_event, responder) => {
      await turnQueue.run("topic-1", () => gate.promise);
      // キューを抜けた後の返信
      await flush();
      await responder.reply({ text: "閉じました" });
    },
  });

  handlers.onInteraction(interaction("guild-1"), new FakeResponder(events));
  const done = shutdown();
  gate.resolve();
  await done;

  assert.deepEqual(events, ["reply 閉じました", "stop", "closeDb"]);
});

test("ハンドラ以外から入れたキューのジョブも終わるまで待つ", async () => {
  const events: string[] = [];
  const layoutQueue = new KeyedSerialQueue(1);
  const gate = deferred();
  void layoutQueue.run("layout:guild-1", async () => {
    await gate.promise;
    events.push("job");
  });
  const { shutdown } = createShutdown(deps(events, { queues: [new KeyedSerialQueue(1), layoutQueue] }), noopInner);

  const done = shutdown();
  await flush();
  assert.deepEqual(events, []);
  gate.resolve();
  await done;

  assert.deepEqual(events, ["job", "stop", "closeDb"]);
});

test("上限の秒数を過ぎたら待たずに gateway を止めて DB を閉じ、log に出す", async () => {
  const events: string[] = [];
  const shutdownDeps = deps(events, { cfg: { ...cfg, shutdownGraceSec: 0.02 } });
  const { handlers, shutdown } = createShutdown(shutdownDeps, {
    ...noopInner,
    // 終わらない処理
    handleMessage: () => new Promise<void>(() => {}),
  });

  handlers.onMessage(message("message-1"));
  await shutdown();

  assert.deepEqual(events, ["stop", "closeDb"]);
  assert.deepEqual(shutdownDeps.logs, [
    "停止します（進行中の処理を最大 0.02 秒待ちます）",
    "進行中の処理が 0.02 秒で終わらなかったため、待たずに終了します",
  ]);
});

test("gateway の停止に失敗しても DB は閉じ、reject しない", async () => {
  const events: string[] = [];
  const shutdownDeps = deps(events);
  shutdownDeps.gateway.stopError = new Error("boom");
  const { shutdown } = createShutdown(shutdownDeps, noopInner);

  await shutdown();

  assert.deepEqual(events, ["stop", "closeDb"]);
  assert.ok(shutdownDeps.logs.includes("Discord との切断に失敗しました: boom"));
});

test("停止を始めたら scheduler を止め（以後 tick しない）、実行中の tick が終わってから gateway を止めて DB を閉じる", async () => {
  const events: string[] = [];
  const gateway = new FakeGateway(events);
  const gate = deferred();
  const sendMessage = gateway.sendMessage.bind(gateway);
  gateway.sendMessage = async (channelId, message) => {
    await gate.promise;
    await sendMessage(channelId, message);
  };
  const intervals: Array<{ fn: () => void; cancelled: boolean }> = [];
  let listed = 0;
  const scheduler = new Scheduler({
    cfg: { idleHours: 12 },
    topicSessions: {
      listIdle: () => {
        listed++;
        return listed === 1
          ? [
              {
                channelId: "topic-1",
                guildId: "guild-1",
                title: "旅行の計画",
                state: "active",
                categoryId: "active-1",
                createdAt: NOW.toISOString(),
                lastActivityAt: NOW.toISOString(),
                waitingSince: null,
                closedAt: null,
                summary: null,
              },
            ]
          : [];
      },
      setActive: () => undefined,
      setWaiting: () => {
        events.push("setWaiting");
        return undefined;
      },
    },
    channelOps: { enqueueMove: () => {} },
    gateway,
    now: () => NOW,
    timers: {
      every: (fn) => {
        const entry = { fn, cancelled: false };
        intervals.push(entry);
        return () => {
          entry.cancelled = true;
        };
      },
    },
    log: () => {},
  });
  // 起動直後の tick が知らせの投稿で止まっている
  scheduler.start(TICK_INTERVAL_MS);
  await flush();
  assert.deepEqual(events, ["setWaiting"]);

  const { shutdown } = createShutdown(deps(events, { gateway, scheduler }), noopInner);
  const done = shutdown();
  await flush();
  assert.equal(intervals[0]?.cancelled, true);
  assert.deepEqual(events, ["setWaiting"]);

  gate.resolve();
  await done;

  assert.deepEqual(events, ["setWaiting", "sendMessage 12 時間発言がないので待ちに移しました。", "stop", "closeDb"]);
  assert.equal(listed, 1);
});
