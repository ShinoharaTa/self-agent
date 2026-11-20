// session_open のツール（tools.ts の createTopicToolHandlers）とツール定義の固定。session_open の処理そのもの（app/right-hand.ts）は test/right-hand.test.ts
import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import type { DatabaseSync } from "node:sqlite";
import * as z from "zod";
import type { RunContext } from "../src/agent/runner.ts";
import {
  CC_NOT_AVAILABLE_MESSAGE,
  createTaskTools,
  SESSION_OPEN_ONE_PER_TURN,
  type CcToolDeps,
  type KbMemoryToolDeps,
  type OpenTopic,
  type ProjectToolDeps,
  type ReminderToolDeps,
  type TextToolResult,
  type TopicOpenArgs,
  type TopicOpenResult,
  type TopicToolDeps,
} from "../src/agent/tools.ts";
import { createStores, tempDb } from "./helpers/db.ts";

/** 2026-10-02(金) 09:12 JST */
const NOW = new Date("2026-10-02T00:12:00Z");

const INBOX: RunContext = { guildId: "guild-1", channelId: "inbox-1", kind: "inbox" };
const ARGS: TopicOpenArgs = { title: "旅行の計画", context: "京都に 2 泊したい。宿と移動を決める" };
const CREATED: TopicOpenResult = { result: "created", channelId: "ch-1", place: "alpha-project", turn: "started", note: "後で場所を変えられます" };

/** ナレッジベースと記憶のツールのストア（ここでは確認・知らせの投稿は使わない） */
function kbMemory(db: DatabaseSync): KbMemoryToolDeps {
  const { knowledge, memories } = createStores(db, () => NOW);
  return {
    knowledge,
    memories,
    confirmKbDelete: async () => assert.fail("想定外の呼び出し"),
    notifyMemoryChange: async () => assert.fail("想定外の呼び出し"),
    timeZone: "Asia/Tokyo",
  };
}

/** project_open のストアと配信の設定（ここでは配信は無効） */
function projectTools(db: DatabaseSync): ProjectToolDeps {
  const { projects } = createStores(db, () => NOW);
  return {
    projects,
    projectsDir: "/srv/work/projects",
    publicBaseUrl: undefined,
    serving: () => false,
    log: () => {},
  };
}

/** リマインドのツールのストア（ここではツール定義だけを見る） */
function reminderTools(db: DatabaseSync): ReminderToolDeps {
  const { reminders } = createStores(db, () => NOW);
  return { reminders, log: () => {} };
}

/** 偽の openTopic（呼ばれた引数を残し、結果は results の先頭から。尽きたら created） */
function fakeOpen(results: TopicOpenResult[] = []): { open: OpenTopic; calls: Array<[TopicOpenArgs, RunContext | undefined]> } {
  const calls: Array<[TopicOpenArgs, RunContext | undefined]> = [];
  return {
    calls,
    open: async (args, context) => {
      calls.push([args, context]);
      return results.shift() ?? CREATED;
    },
  };
}

/** 偽の topics（ここでは呼ばれない） */
const TOPICS: TopicToolDeps = {
  list: () => assert.fail("想定外の呼び出し: list"),
  move: async () => assert.fail("想定外の呼び出し: move"),
};

/** 偽の cc（ここでは呼ばれない） */
const CC: CcToolDeps = {
  list: async () => assert.fail("想定外の呼び出し"),
  send: async () => assert.fail("想定外の呼び出し"),
  start: async () => assert.fail("想定外の呼び出し"),
} as never;

function tools(t: TestContext, open: OpenTopic, context: RunContext | undefined, extra: { cc?: CcToolDeps; topics?: TopicToolDeps } = {}) {
  const db = tempDb(t);
  const { tasks, topicSessions } = createStores(db, () => NOW);
  return createTaskTools(tasks, topicSessions, open, kbMemory(db), projectTools(db), reminderTools(db), context, extra.cc, extra.topics);
}

/** session_open を呼ぶ関数（同じ createTaskTools の中で何度でも呼べる。1 回の run と同じ） */
function sessionOpen(t: TestContext, open: OpenTopic, context: RunContext | undefined) {
  const definition = tools(t, open, context).find((candidate) => candidate.name === "session_open");
  assert.ok(definition !== undefined);
  return async (args: TopicOpenArgs = ARGS): Promise<unknown> => {
    // 定義の配列は全ツールの入力の型の合併なので、引数の型は確かめない
    const result = (await definition.handler(args as never, {})) as TextToolResult;
    return JSON.parse(result.content[0].text);
  };
}

function definitionsOf(t: TestContext, context: RunContext | undefined, extra: { cc?: CcToolDeps; topics?: TopicToolDeps } = {}) {
  return tools(t, fakeOpen().open, context, extra).map((definition) => ({
    name: definition.name,
    description: definition.description,
    inputSchema: z.toJSONSchema(z.object(definition.inputSchema)),
    annotations: definition.annotations,
    meta: definition._meta,
  }));
}

test("ツール定義: 名前は 22 個で、今までの 20 個の並びの後ろに topic_list・topic_move が付く", (t) => {
  // ツール集合は全セッション共通で固定する（変わるとキャッシュが全セッションで外れる）。並びも含めて意図しない変更を検出する
  assert.deepEqual(
    definitionsOf(t, INBOX).map((definition) => definition.name),
    [
      "task_add",
      "task_list",
      "task_complete",
      "task_update",
      "session_report",
      "session_open",
      "kb_save",
      "kb_search",
      "kb_get",
      "kb_delete",
      "memory_save",
      "memory_forget",
      "project_open",
      "project_files",
      "reminder_set",
      "reminder_list",
      "reminder_cancel",
      "cc_list",
      "cc_send",
      "cc_start",
      "topic_list",
      "topic_move",
    ],
  );
});

test("ツール定義: どのチャンネルの run でも（#inbox・#tasks・セッション・プロジェクトのセッション・予約した依頼・context なし・topics なし・cc なし）名前・説明・入力の形は同じ", (t) => {
  const base = definitionsOf(t, INBOX, { cc: CC, topics: TOPICS });
  const cases: Array<[RunContext | undefined, { cc?: CcToolDeps; topics?: TopicToolDeps }]> = [
    [{ guildId: "guild-1", channelId: "tasks-1", kind: "tasks" }, { cc: CC, topics: TOPICS }],
    [{ guildId: "guild-1", channelId: "topic-1", kind: "session" }, { cc: CC, topics: TOPICS }],
    [{ guildId: "guild-1", channelId: "topic-2", kind: "session", projectDir: "/srv/work/alpha-project" }, { cc: CC, topics: TOPICS }],
    [{ ...INBOX, scheduled: true }, { cc: CC, topics: TOPICS }],
    [undefined, { cc: CC, topics: TOPICS }],
    [INBOX, { cc: CC }],
    [INBOX, { topics: TOPICS }],
    [{ guildId: "guild-2", channelId: "inbox-2", kind: "inbox" }, {}],
  ];
  for (const [context, extra] of cases) assert.deepEqual(definitionsOf(t, context, extra), base, JSON.stringify(context));
});

test("ツール定義: 説明と describe に可変値（数字の ID・日付・場所の名前・1 日の上限の数）が入らない", (t) => {
  const contexts: RunContext[] = [INBOX, { guildId: "123456789012345678", channelId: "987654321098765432", kind: "session", projectDir: "/srv/work/alpha-project" }];
  for (const context of contexts) {
    // 説明と、入力の形の中の describe の文だけを見る（入力の形の数の範囲・日付の pattern は可変値ではない）
    const texts: string[] = [];
    const collect = (value: unknown): void => {
      if (Array.isArray(value)) value.forEach(collect);
      else if (value !== null && typeof value === "object") {
        for (const [key, inner] of Object.entries(value)) {
          if (key === "description" && typeof inner === "string") texts.push(inner);
          else collect(inner);
        }
      }
    };
    collect(definitionsOf(t, context, { cc: CC, topics: TOPICS }));
    assert.ok(texts.length > 22);
    const serialized = texts.join("\n");
    for (const value of ["guild-1", "inbox-1", "alpha-project", "123456789012345678", "987654321098765432", "autoSessionPerDay"]) {
      assert.ok(!serialized.includes(value), value);
    }
    assert.doesNotMatch(serialized, /\d{5,}/);
    assert.doesNotMatch(serialized, /\d{4}-\d{2}-\d{2}/);
    // 1 日の上限の数（「1 日に N」「今日は N」の形）を書かない
    assert.doesNotMatch(serialized, /1 日(?:に|の上限は?) ?\d/);
  }
});

test("ツール定義: session_open の題名は前後の空白を除いて 1〜100 字、context は 1〜400 字", (t) => {
  const definition = tools(t, fakeOpen().open, undefined).find((candidate) => candidate.name === "session_open");
  assert.ok(definition !== undefined);
  const schema = z.object(definition.inputSchema);

  assert.deepEqual(schema.parse({ title: "  旅行の計画  ", context: "c" }), { title: "旅行の計画", context: "c" });
  assert.equal(schema.safeParse({ title: " 　 ", context: "c" }).success, false);
  assert.equal(schema.safeParse({ title: "あ".repeat(100), context: "c".repeat(400) }).success, true);
  assert.equal(schema.safeParse({ title: "あ".repeat(101), context: "c" }).success, false);
  assert.equal(schema.safeParse({ title: "a", context: "" }).success, false);
  assert.equal(schema.safeParse({ title: "a", context: "c".repeat(401) }).success, false);
});

test("ツール定義: session_open の project は 64 字まで、text は 1,900 字まで（超えると入力の検査で落ちる）で、どちらも省ける", (t) => {
  const definition = tools(t, fakeOpen().open, undefined).find((candidate) => candidate.name === "session_open");
  assert.ok(definition !== undefined);
  const schema = z.object(definition.inputSchema);

  assert.deepEqual(schema.parse({ title: "a", context: "c" }), { title: "a", context: "c" });
  assert.equal(schema.safeParse({ title: "a", context: "c", project: "p".repeat(64), text: "x".repeat(1900) }).success, true);
  assert.equal(schema.safeParse({ title: "a", context: "c", project: "p".repeat(65) }).success, false);
  assert.equal(schema.safeParse({ title: "a", context: "c", text: "x".repeat(1901) }).success, false);
  assert.equal(schema.safeParse({ title: "a", context: "c", project: " " }).success, false);
  assert.equal(schema.safeParse({ title: "a", context: "c", text: "" }).success, false);
  assert.deepEqual(schema.parse({ title: "a", context: "c", project: " alpha ", text: " 見て " }), { title: "a", context: "c", project: "alpha", text: "見て" });
});

test("ツール定義: session_open の model は前後の空白を除いて 1〜32 字で省け、describe の文は決まった文", (t) => {
  const definition = tools(t, fakeOpen().open, undefined).find((candidate) => candidate.name === "session_open");
  assert.ok(definition !== undefined);
  const schema = z.object(definition.inputSchema);

  assert.equal("model" in schema.parse({ title: "a", context: "c" }), false);
  assert.deepEqual(schema.parse({ title: "a", context: "c", model: " sonnet " }), { title: "a", context: "c", model: "sonnet" });
  assert.equal(schema.safeParse({ title: "a", context: "c", model: "m".repeat(32) }).success, true);
  assert.equal(schema.safeParse({ title: "a", context: "c", model: "m".repeat(33) }).success, false);
  assert.equal(schema.safeParse({ title: "a", context: "c", model: " 　 " }).success, false);
  const json = z.toJSONSchema(schema) as { properties: Record<string, { description?: string }> };
  assert.equal(
    json.properties.model?.description,
    "使うモデルの名前（オーナーが名前で指定したときだけ、言われた名前のまま渡す）。使えない名前なら話題は作られず、使える名前の一覧が返るので、オーナーに伝えて選び直してもらう（自分で別の名前を選んで呼び直さない）。省略すると場所の既定のモデルで始まる",
  );
});

test("session_open: model を渡すと（trim されて）openTopic に届き、渡さなければ args に model の鍵が無い", async (t) => {
  const definition = tools(t, fakeOpen().open, undefined).find((candidate) => candidate.name === "session_open");
  assert.ok(definition !== undefined);
  const schema = z.object(definition.inputSchema);
  const fake = fakeOpen();
  // 1 回の run で 1 回しか作れないので、run ごとに作り直す
  await sessionOpen(t, fake.open, INBOX)(schema.parse({ ...ARGS, model: "  haiku " }) as unknown as TopicOpenArgs);
  await sessionOpen(t, fake.open, INBOX)(schema.parse({ ...ARGS, title: "別件" }) as unknown as TopicOpenArgs);
  assert.equal(fake.calls.length, 2);
  assert.equal(fake.calls[0]![0].model, "haiku");
  assert.equal("model" in fake.calls[1]![0], false);
});

test("session_open: 1 回の run で 2 回呼ぶと、2 回目は limit で openTopic を呼ばない", async (t) => {
  const fake = fakeOpen();
  const call = sessionOpen(t, fake.open, INBOX);
  assert.deepEqual(await call(), CREATED);
  assert.deepEqual(await call({ ...ARGS, title: "別の話" }), { result: "limit", message: SESSION_OPEN_ONE_PER_TURN });
  assert.equal(fake.calls.length, 1);
});

test("session_open: 並べて 2 回呼んでも openTopic は 1 回だけ", async (t) => {
  const fake = fakeOpen();
  const call = sessionOpen(t, fake.open, INBOX);
  const [first, second] = await Promise.all([call(), call({ ...ARGS, title: "別の話" })]);
  assert.deepEqual(first, CREATED);
  assert.deepEqual(second, { result: "limit", message: SESSION_OPEN_ONE_PER_TURN });
  assert.equal(fake.calls.length, 1);
});

test("session_open: 1 回目が existing・limit・not_available なら、2 回目は openTopic を呼ぶ（数えるのは created だけ）", async (t) => {
  const firsts: TopicOpenResult[] = [
    { result: "existing", channelId: "ch-9", message: "既にあります" },
    { result: "limit", message: "今日はこれ以上" },
    { result: "not_available" },
  ];
  for (const first of firsts) {
    const fake = fakeOpen([first]);
    const call = sessionOpen(t, fake.open, INBOX);
    assert.deepEqual(await call(), first);
    assert.deepEqual(await call(), CREATED);
    assert.equal(fake.calls.length, 2, first.result);
  }
});

test("session_open: 別の run（createTaskTools を作り直す）ではまた呼べる", async (t) => {
  const fake = fakeOpen();
  assert.deepEqual(await sessionOpen(t, fake.open, INBOX)(), CREATED);
  assert.deepEqual(await sessionOpen(t, fake.open, INBOX)(), CREATED);
  assert.equal(fake.calls.length, 2);
});

test("session_open: 予約した依頼のターンでは not_available で、openTopic を呼ばない", async (t) => {
  const fake = fakeOpen();
  assert.deepEqual(await sessionOpen(t, fake.open, { ...INBOX, scheduled: true })(), {
    result: "not_available",
    message: "予約した依頼のターンでは使えません",
  });
  assert.equal(fake.calls.length, 0);
});

test("session_open: close・renew のターンと context の無いターンでは not_available で、openTopic を呼ばない", async (t) => {
  const fake = fakeOpen();
  const contexts: Array<RunContext | undefined> = [
    { guildId: "guild-1", channelId: "topic-1", kind: "session", purpose: "close" },
    { guildId: "guild-1", channelId: "topic-1", kind: "session", purpose: "renew" },
    undefined,
  ];
  for (const context of contexts) {
    assert.deepEqual(await sessionOpen(t, fake.open, context)(), { result: "not_available", message: CC_NOT_AVAILABLE_MESSAGE });
  }
  assert.equal(fake.calls.length, 0);
});

test("session_open: 結果（channelId・place・turn・note）がそのままツールの結果の JSON に入り、引数と context はそのまま openTopic に渡る", async (t) => {
  const fake = fakeOpen();
  const args: TopicOpenArgs = { ...ARGS, project: "alpha-project", text: "ログインの不具合を見て" };
  assert.deepEqual(await sessionOpen(t, fake.open, INBOX)(args), CREATED);
  assert.deepEqual(fake.calls, [[args, INBOX]]);
});
