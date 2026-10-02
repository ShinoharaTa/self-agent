import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as z from "zod";
import type { AgentRunner, RunInput, RunResult } from "../src/agent/runner.ts";
import { SYSTEM_PROMPT } from "../src/agent/system-prompt.ts";
import { createTaskTools, type SessionOpenResult, type TextToolResult } from "../src/agent/tools.ts";
import { createChannelResolver } from "../src/app/access.ts";
import { createTopicSession, toChannelName } from "../src/app/commands/new.ts";
import { KeyedSerialQueue } from "../src/app/queue.ts";
import {
  AUTO_SESSION_COOLDOWN_MESSAGE,
  AUTO_SESSION_COOLDOWN_MS,
  AUTO_SESSION_LIMIT_MESSAGE,
  createOpenSession,
  inboxSeed,
  inboxWelcomeText,
} from "../src/app/session-open.ts";
import { runChannelTurn } from "../src/app/turn.ts";
import type { Gateway, TextChannelOptions } from "../src/discord/gateway.ts";
import { ChannelSeedStore } from "../src/store/channel-seeds.ts";
import { openDb } from "../src/store/db.ts";
import { GuildSettingsStore } from "../src/store/guild-settings.ts";
import { SdkSessionStore } from "../src/store/sdk-sessions.ts";
import { TaskStore } from "../src/store/tasks.ts";
import { TopicSessionStore } from "../src/store/topic-sessions.ts";
import { UsageStore } from "../src/store/usage.ts";

/** 2026-10-02(金) 09:12 JST */
const NOW = new Date("2026-10-02T00:12:00Z");

type GatewayCall =
  | { method: "createCategory"; guildId: string; name: string }
  | { method: "createTextChannel"; guildId: string; options: TextChannelOptions }
  | { method: "channelExists"; channelId: string }
  | { method: "countChannelsIn"; categoryId: string }
  | { method: "send"; channelId: string; text: string };

/** /new の作成処理が使う分だけの偽 Gateway。作ったチャンネルは ch-1 から振る */
class FakeGateway
  implements Pick<Gateway, "createCategory" | "createTextChannel" | "channelExists" | "countChannelsIn" | "send">
{
  calls: GatewayCall[] = [];
  readonly alive = new Set<string>(["active-1"]);
  /** send の直前に呼ばれる。投げればその送信は失敗する */
  beforeSend: (channelId: string) => void = () => {};
  private nextId = 1;

  async createCategory(guildId: string, name: string): Promise<string> {
    this.calls.push({ method: "createCategory", guildId, name });
    return this.newId();
  }
  async createTextChannel(guildId: string, options: TextChannelOptions): Promise<string> {
    this.calls.push({ method: "createTextChannel", guildId, options });
    return this.newId();
  }
  async channelExists(channelId: string): Promise<boolean> {
    this.calls.push({ method: "channelExists", channelId });
    return this.alive.has(channelId);
  }
  async countChannelsIn(categoryId: string): Promise<number> {
    this.calls.push({ method: "countChannelsIn", categoryId });
    return 0;
  }
  async send(channelId: string, text: string): Promise<void> {
    this.beforeSend(channelId);
    this.calls.push({ method: "send", channelId, text });
  }

  reset(): void {
    this.calls = [];
  }

  private newId(): string {
    const id = `ch-${this.nextId++}`;
    this.alive.add(id);
    return id;
  }
}

/** 受け取った key を記録する（/new と同じ key を使うかを見る） */
class RecordingQueue extends KeyedSerialQueue {
  keys: string[] = [];

  run<T>(key: string, fn: () => Promise<T>): Promise<T> {
    this.keys.push(key);
    return super.run(key, fn);
  }
}

const INBOX = { guildId: "guild-1", channelId: "inbox-1" };
const ARGS = { title: "旅行の計画", context: "京都に 2 泊したい。宿と移動を決める" };

type Options = {
  /** /setup 済み（#inbox は inbox-1、進行中は active-1）にするか。既定 true */
  setUp?: boolean;
  /** /setup 前のサーバーで #inbox とみなすチャンネル（env の SELF_AGENT_INBOX_CHANNEL_ID） */
  envInbox?: string;
  perDay?: number;
};

function setup(t: TestContext, options: Options = {}) {
  const dir = mkdtempSync(join(tmpdir(), "self-agent-test-"));
  const db = openDb(join(dir, "self-agent.db"));
  t.after(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });
  let current = NOW;
  const now = (): Date => current;
  const gateway = new FakeGateway();
  const guildSettings = new GuildSettingsStore(db, now);
  const topicSessions = new TopicSessionStore(db, now);
  const seeds = new ChannelSeedStore(db, now);
  const queue = new RecordingQueue(2);
  const logs: string[] = [];
  const log = (line: string): void => {
    logs.push(line);
  };
  if (options.setUp ?? true) {
    guildSettings.setChannel("guild-1", "inboxChannelId", "inbox-1");
    guildSettings.setStateCategory("guild-1", "active", 1, "active-1");
  }
  const openSession = createOpenSession({
    cfg: { timeZone: "Asia/Tokyo", autoSessionPerDay: options.perDay ?? 3 },
    resolveChannel: createChannelResolver({ inboxChannelId: options.envInbox }, guildSettings, topicSessions),
    gateway,
    guildSettings,
    topicSessions,
    seeds,
    queue,
    now,
    log,
  });
  /** 時計を at にして #inbox から session_open を呼ぶ */
  const openAt = (at: string, title: string = ARGS.title): Promise<SessionOpenResult> => {
    current = new Date(at);
    return openSession({ title, context: ARGS.context }, INBOX);
  };
  const sessionCount = (): number => Number(db.prepare("SELECT COUNT(*) AS n FROM sessions").get()?.n);
  return {
    db,
    gateway,
    guildSettings,
    topicSessions,
    seeds,
    queue,
    logs,
    log,
    openSession,
    openAt,
    sessionCount,
    setNow: (at: string) => {
      current = new Date(at);
    },
  };
}

function parse(result: TextToolResult): unknown {
  assert.equal(result.content.length, 1);
  assert.equal(result.content[0].type, "text");
  return JSON.parse(result.content[0].text);
}

test("session_open: 成功したら /new と同じ作成処理でチャンネルを作り、seed を入れ、最初の投稿をして created を返す", async (t) => {
  const { gateway, topicSessions, seeds, queue, logs, openSession } = setup(t);
  // 最初の投稿の時点で sessions と seed は保存済み
  gateway.beforeSend = (channelId) => {
    assert.equal(topicSessions.get(channelId)?.state, "active");
    assert.equal(seeds.get(channelId), inboxSeed(ARGS.context));
  };

  const result = await openSession({ title: "旅行の計画 Vol.2", context: ARGS.context }, INBOX);

  assert.deepEqual(result, { result: "created", channelId: "ch-1" });
  assert.deepEqual(gateway.calls, [
    { method: "channelExists", channelId: "active-1" },
    { method: "countChannelsIn", categoryId: "active-1" },
    {
      method: "createTextChannel",
      guildId: "guild-1",
      options: { name: "旅行の計画-vol2", parentId: "active-1", topic: "旅行の計画 Vol.2" },
    },
    { method: "send", channelId: "ch-1", text: "セッション「旅行の計画 Vol.2」を始めました。#inbox の話の続きです。" },
  ]);
  assert.deepEqual(topicSessions.get("ch-1"), {
    channelId: "ch-1",
    guildId: "guild-1",
    title: "旅行の計画 Vol.2",
    state: "active",
    categoryId: "active-1",
    createdAt: NOW.toISOString(),
    lastActivityAt: NOW.toISOString(),
    waitingSince: null,
    closedAt: null,
    summary: null,
    origin: "inbox",
    deletePromptMessageId: null,
    deletedAt: null,
  });
  assert.equal(seeds.get("ch-1"), `#inbox からの続き:\n${ARGS.context}`);
  // /setup・/new と同じキューの同じ key で作る
  assert.deepEqual(queue.keys, ["layout:guild-1"]);
  assert.deepEqual(logs, ["#inbox からセッションを作りました（guild=guild-1）"]);
  assert.equal(inboxWelcomeText("x"), "セッション「x」を始めました。#inbox の話の続きです。");
});

test("session_open: 作ったチャンネルの最初のターンの prompt の先頭に #inbox の文脈が付き、成功したら seed を消す", async (t) => {
  const { db, topicSessions, seeds, log, openSession } = setup(t);
  const created = await openSession(ARGS, INBOX);
  assert.ok(created.result === "created");

  const inputs: RunInput[] = [];
  const runner: AgentRunner = {
    async run(input: RunInput): Promise<RunResult> {
      inputs.push(input);
      return {
        ok: true,
        text: "続けましょう",
        sessionId: "session-1",
        usage: { inputTokens: 1, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 },
        durationMs: 1,
        toolCalls: 0,
        contextTokens: 1,
      };
    },
  };
  const turnDeps = {
    runner,
    sessions: new SdkSessionStore(db, () => NOW),
    seeds,
    topicSessions,
    usage: new UsageStore(db, () => NOW),
    log,
  };

  await runChannelTurn(turnDeps, { guildId: "guild-1", channelId: created.channelId, prompt: "[header]\nどこから決める？" });
  await runChannelTurn(turnDeps, { guildId: "guild-1", channelId: created.channelId, prompt: "[header]\n次" });

  assert.deepEqual(
    inputs.map((input) => [input.prompt, input.sessionId]),
    [
      [`#inbox からの続き:\n${ARGS.context}\n\n[header]\nどこから決める？`, undefined],
      ["[header]\n次", "session-1"],
    ],
  );
  assert.equal(seeds.get(created.channelId), undefined);
});

test("session_open: 最初の投稿に失敗しても log に出して created を返す", async (t) => {
  const { gateway, topicSessions, logs, openSession } = setup(t);
  gateway.beforeSend = () => {
    throw new Error("Missing Access");
  };

  assert.deepEqual(await openSession(ARGS, INBOX), { result: "created", channelId: "ch-1" });
  assert.equal(topicSessions.get("ch-1")?.origin, "inbox");
  assert.deepEqual(logs, [
    "#inbox からセッションを作りました（guild=guild-1）",
    "セッションの最初の投稿に失敗しました: Missing Access",
  ]);
});

test("session_open: #inbox 以外（セッション・受け付け対象外・別サーバー・context 無し）では not_available を返し、何も作らない", async (t) => {
  const { gateway, topicSessions, seeds, queue, openSession, sessionCount } = setup(t);
  topicSessions.create({ channelId: "topic-1", guildId: "guild-1", title: "別の話", categoryId: "active-1" });

  const contexts = [
    { guildId: "guild-1", channelId: "topic-1" },
    { guildId: "guild-1", channelId: "other-1" },
    // 別サーバーの同じ ID のチャンネル
    { guildId: "guild-2", channelId: "inbox-1" },
    undefined,
  ];
  for (const context of contexts) {
    assert.deepEqual(await openSession(ARGS, context), { result: "not_available" }, JSON.stringify(context));
  }
  assert.deepEqual(gateway.calls, []);
  assert.deepEqual(queue.keys, []);
  assert.equal(sessionCount(), 1);
  assert.equal(seeds.get("topic-1"), undefined);
});

test("session_open: 同じ正規化題名の進行中・待ちのセッションがそのサーバーにあれば、作らずに existing を返す", async (t) => {
  const { db, gateway, topicSessions, openSession, sessionCount } = setup(t);
  topicSessions.create({ channelId: "topic-1", guildId: "guild-1", title: "Trip Plan!", categoryId: "active-1" });
  assert.equal(toChannelName("trip  plan"), toChannelName("Trip Plan!"));

  assert.deepEqual(await openSession({ ...ARGS, title: "trip  plan" }, INBOX), {
    result: "existing",
    channelId: "topic-1",
  });

  db.prepare("UPDATE sessions SET state = 'waiting' WHERE channel_id = 'topic-1'").run();
  assert.deepEqual(await openSession({ ...ARGS, title: "Trip-Plan" }, INBOX), {
    result: "existing",
    channelId: "topic-1",
  });

  assert.deepEqual(gateway.calls, []);
  assert.equal(sessionCount(), 1);
});

test("session_open: 完了・削除済み・別サーバーの同じ題名は existing にせず新しく作る", async (t) => {
  const { db, topicSessions, openSession } = setup(t);
  topicSessions.create({ channelId: "topic-1", guildId: "guild-1", title: ARGS.title, categoryId: "done-1" });
  topicSessions.create({ channelId: "topic-2", guildId: "guild-1", title: ARGS.title, categoryId: "done-1" });
  topicSessions.create({ channelId: "topic-3", guildId: "guild-2", title: ARGS.title, categoryId: "active-2" });
  db.prepare("UPDATE sessions SET state = 'done' WHERE channel_id = 'topic-1'").run();
  db.prepare("UPDATE sessions SET state = 'deleted' WHERE channel_id = 'topic-2'").run();

  assert.deepEqual(await openSession(ARGS, INBOX), { result: "created", channelId: "ch-1" });
});

test("session_open: 上限は timeZone の日付で数える。前日の分は数えず、日付が変われば また作れる", async (t) => {
  const { gateway, openAt } = setup(t, { perDay: 2 });

  // 10-01 23:40 JST（前日）
  assert.equal((await openAt("2026-10-01T14:40:00.000Z", "a")).result, "created");
  // 10-02 00:00 JST ちょうどから 10-02 の分。前日の 1 件は数えない
  assert.equal((await openAt("2026-10-01T15:00:00.000Z", "b")).result, "created");
  assert.equal((await openAt("2026-10-01T15:15:00.000Z", "c")).result, "created");
  // 10-02 は 2 件作ったので上限
  assert.deepEqual(await openAt("2026-10-01T15:30:00.000Z", "d"), {
    result: "limit",
    message: "今日はこれ以上自動で作れません。/new で作ってください",
  });
  assert.deepEqual(await openAt("2026-10-02T14:59:59.999Z", "d"), {
    result: "limit",
    message: AUTO_SESSION_LIMIT_MESSAGE,
  });
  // 10-03 00:00 JST
  assert.equal((await openAt("2026-10-02T15:00:00.000Z", "d")).result, "created");
  assert.equal(gateway.calls.filter((call) => call.method === "createTextChannel").length, 4);
});

test("session_open: 上限と間隔の両方に当たるときは limit を返す", async (t) => {
  const { openAt } = setup(t, { perDay: 1 });

  assert.equal((await openAt("2026-10-02T00:00:00.000Z", "a")).result, "created");
  assert.deepEqual(await openAt("2026-10-02T00:01:00.000Z", "b"), {
    result: "limit",
    message: AUTO_SESSION_LIMIT_MESSAGE,
  });
});

test("session_open: 前回の自動作成から 15 分未満なら cooldown。15 分ちょうどからは作れる", async (t) => {
  const { gateway, openAt, sessionCount } = setup(t);
  assert.equal(AUTO_SESSION_COOLDOWN_MS, 15 * 60 * 1000);

  assert.equal((await openAt("2026-10-02T00:00:00.000Z", "a")).result, "created");
  gateway.reset();
  assert.deepEqual(await openAt("2026-10-02T00:14:59.999Z", "b"), {
    result: "cooldown",
    message: "少し時間をおいてください。急ぐなら /new で作れます",
  });
  assert.deepEqual(gateway.calls, []);
  assert.equal(sessionCount(), 1);

  assert.equal((await openAt("2026-10-02T00:15:00.000Z", "b")).result, "created");
  assert.equal(AUTO_SESSION_COOLDOWN_MESSAGE, "少し時間をおいてください。急ぐなら /new で作れます");
});

test("session_open: 同じ題名なら上限・間隔より先に existing を返す", async (t) => {
  const { openAt } = setup(t, { perDay: 1 });

  const first = await openAt("2026-10-02T00:00:00.000Z", "a");
  assert.ok(first.result === "created");
  assert.deepEqual(await openAt("2026-10-02T00:01:00.000Z", "A"), { result: "existing", channelId: first.channelId });
});

test("session_open: /new で作ったセッションは上限にも間隔にも数えない", async (t) => {
  const { gateway, guildSettings, topicSessions, log, openAt, setNow } = setup(t, { perDay: 1 });
  setNow("2026-10-02T00:00:00.000Z");
  const deps = { gateway, guildSettings, topicSessions, log };
  for (const title of ["x", "y", "z"]) {
    assert.equal((await createTopicSession("guild-1", title, deps)).result, "created");
  }
  assert.deepEqual(
    ["ch-1", "ch-2", "ch-3"].map((id) => topicSessions.get(id)?.origin),
    ["command", "command", "command"],
  );

  // /new の 1 分後でも作れる
  assert.equal((await openAt("2026-10-02T00:01:00.000Z", "a")).result, "created");
  assert.equal(topicSessions.get("ch-4")?.origin, "inbox");
});

test("session_open: 同じターンで並べて呼ばれても、確認と作成を 1 つずつ実行するので二重に作らない", async (t) => {
  const { gateway, openSession, sessionCount } = setup(t);

  const [first, second, third] = await Promise.all([
    openSession({ ...ARGS, title: "a" }, INBOX),
    openSession({ ...ARGS, title: "a" }, INBOX),
    openSession({ ...ARGS, title: "b" }, INBOX),
  ]);

  assert.deepEqual(first, { result: "created", channelId: "ch-1" });
  assert.deepEqual(second, { result: "existing", channelId: "ch-1" });
  assert.equal(third.result, "cooldown");
  assert.equal(gateway.calls.filter((call) => call.method === "createTextChannel").length, 1);
  assert.equal(sessionCount(), 1);
});

test("session_open: /setup 前（env の #inbox で受け付けているサーバー、進行中カテゴリが無いサーバー）なら not_set_up を返し、何も作らない", async (t) => {
  const { gateway, guildSettings, seeds, openSession, sessionCount } = setup(t, { setUp: false, envInbox: "env-inbox" });

  assert.deepEqual(await openSession(ARGS, { guildId: "guild-1", channelId: "env-inbox" }), { result: "not_set_up" });

  // /setup が途中で止まり、#inbox はあるが進行中カテゴリがまだ無い
  guildSettings.setChannel("guild-1", "inboxChannelId", "inbox-1");
  assert.deepEqual(await openSession(ARGS, INBOX), { result: "not_set_up" });

  assert.deepEqual(gateway.calls, []);
  assert.equal(sessionCount(), 0);
  assert.equal(seeds.get("ch-1"), undefined);
});

test("ツール定義: どのチャンネルの run でも名前・説明・入力の形は同じで、説明に可変値を入れない", (t) => {
  const { db, topicSessions } = setup(t);
  const tasks = new TaskStore(db, () => NOW);
  const openSession = async (): Promise<SessionOpenResult> => ({ result: "not_available" });
  const contexts = [
    { guildId: "guild-1", channelId: "inbox-1" },
    { guildId: "guild-1", channelId: "topic-1" },
    { guildId: "guild-2", channelId: "inbox-2" },
    undefined,
  ];

  const definitions = contexts.map((context) =>
    createTaskTools(tasks, topicSessions, openSession, context).map((definition) => ({
      name: definition.name,
      description: definition.description,
      inputSchema: z.toJSONSchema(z.object(definition.inputSchema)),
      annotations: definition.annotations,
      meta: definition._meta,
    })),
  );

  for (const other of definitions.slice(1)) assert.deepEqual(other, definitions[0]);
  assert.deepEqual(
    definitions[0]!.map((definition) => definition.name),
    ["task_add", "task_list", "task_complete", "session_report", "session_open"],
  );
  const serialized = JSON.stringify(definitions[0]);
  for (const id of ["guild-1", "guild-2", "inbox-1", "inbox-2", "topic-1"]) assert.ok(!serialized.includes(id), id);
  const sessionOpen = definitions[0]!.find((definition) => definition.name === "session_open");
  assert.equal(
    sessionOpen?.description,
    "#inbox での相談が 3 往復以上続きそう、または設計・調べもの・計画など腰を据えた話題になりそうなときに、" +
      "その話題専用のセッション（チャンネル）を作る。単発のタスク登録や短い質問では使わない。" +
      "作ったら返事にチャンネルのリンク（<#チャンネルID>）を書く。",
  );
  // 使いどころはツールの説明に書き、システムプロンプトは変えない
  assert.ok(!SYSTEM_PROMPT.includes("session_open"));
});

test("ツール定義: session_open の題名は前後の空白を除いて 1〜100 字、context は 1〜400 字", (t) => {
  const { db, topicSessions } = setup(t);
  const tasks = new TaskStore(db, () => NOW);
  const definition = createTaskTools(tasks, topicSessions, async () => ({ result: "not_available" })).find(
    (candidate) => candidate.name === "session_open",
  );
  assert.ok(definition !== undefined);
  const schema = z.object(definition.inputSchema);

  assert.deepEqual(schema.parse({ title: "  旅行の計画  ", context: "c" }), { title: "旅行の計画", context: "c" });
  assert.equal(schema.safeParse({ title: " 　 ", context: "c" }).success, false);
  assert.equal(schema.safeParse({ title: "あ".repeat(100), context: "c".repeat(400) }).success, true);
  assert.equal(schema.safeParse({ title: "あ".repeat(101), context: "c" }).success, false);
  assert.equal(schema.safeParse({ title: "a", context: "" }).success, false);
  assert.equal(schema.safeParse({ title: "a", context: "c".repeat(401) }).success, false);
});

test("ツール: session_open のハンドラはこの run の context を渡し、結果を JSON で返す", async (t) => {
  const { db, topicSessions } = setup(t);
  const tasks = new TaskStore(db, () => NOW);
  const received: unknown[] = [];
  const openSession = async (args: unknown, context: unknown): Promise<SessionOpenResult> => {
    received.push([args, context]);
    return { result: "existing", channelId: "topic-1" };
  };
  const definition = createTaskTools(tasks, topicSessions, openSession, INBOX).find(
    (candidate) => candidate.name === "session_open",
  );
  assert.ok(definition !== undefined);

  // find の結果は全ツールの union なので、session_open の引数の形に絞って呼ぶ
  const handler = definition.handler as (args: typeof ARGS, extra: unknown) => Promise<TextToolResult>;
  const result = await handler(ARGS, {});

  assert.deepEqual(parse(result), { result: "existing", channelId: "topic-1" });
  assert.deepEqual(received, [[ARGS, INBOX]]);
});
