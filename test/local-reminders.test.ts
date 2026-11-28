import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import type { RunContext, RunResult } from "../src/agent/runner.ts";
import { createReminderToolHandlers, REMINDER_LOCAL_PLACE_NOTE, type TextToolResult } from "../src/agent/tools.ts";
import { createChannelResolver } from "../src/app/access.ts";
import { createRemindersComponent } from "../src/app/commands/reminders.ts";
import { PersonaRouter } from "../src/app/personas.ts";
import { createPlaceRefs, type PlaceRefs } from "../src/app/place-refs.ts";
import {
  LOCAL_GAVE_UP_NOTE,
  LOCAL_POSTED_NOTE,
  localPlaceNote,
  MOVED_NOTE,
  OWNER_UNREACHABLE_NOTE,
  REMINDER_MAX_ATTEMPTS,
  reminderFireButtons,
  ReminderScheduler,
} from "../src/app/reminders.ts";
import type { PersonaConfig } from "../src/config.ts";
import type { Gateway, Interaction, OutgoingMessage } from "../src/discord/gateway.ts";
import { LocalGateway } from "../src/discord/local-gateway.ts";
import { LocalIdStore } from "../src/store/local-places.ts";
import type { NewReminder, ReminderStore } from "../src/store/reminders.ts";
import { createStores, tempDb } from "./helpers/db.ts";
import { FakeGateway } from "./helpers/gateway.ts";
import { RecordingQueue } from "./helpers/recording.ts";
import { FakeResponder } from "./helpers/responder.ts";
import { FakeRunner, turnUsage } from "./helpers/runner.ts";

// ローカルの場所（place = 'local'。#530 の WP4 の 3 つ目。docs/plan/personas-web-antigravity.md §3.2）で頼んだリマインド。
// 知らせの型は頼んだ場所に出さず、既定の人格の Bot で #tasks（無ければ #inbox）に注記つきで出し、頼んだ場所の履歴に 1 行書く。
// 予約した依頼はその入口で動く。今在る Discord の場所のリマインドは places を渡しても同じ

/** 2026-11-28(土) 9:00 JST */
const NOW = new Date("2026-11-28T00:00:00.000Z");
const DAY_MS = 24 * 60 * 60 * 1000;
const GUILD = "900";
const TASKS = "400";
const INBOX = "500";
/** 既定の人格の Discord の話題 */
const DEFAULT_TOPIC = "222";
/** 足した人格 mika の Discord の話題 */
const DISCORD_TOPIC = "111";
/** ローカルの話題（mika）。番号は LocalIdStore と同じ形 */
const LOCAL_TOPIC = "100000000000000000001";
/** ローカルの入口（mika の #<NAME>） */
const LOCAL_ENTRY = "100000000000000000002";
const MIKA: PersonaConfig = {
  id: "mika",
  name: "ミカ",
  discordTokenEnv: "SELF_AGENT_PERSONA_MIKA_DISCORD_TOKEN",
  promptFile: "mika.md",
  model: undefined,
  engine: "claude",
  effort: undefined,
};

/** ローカルの Gateway の呼び出し（メソッドと引数） */
type LocalCall = { method: string; args: unknown[] };

/** 本物の LocalGateway に、呼び出しを全部記録する包みを被せる */
function recordingLocalGateway(local: LocalGateway): { gateway: Gateway; calls: LocalCall[] } {
  const calls: LocalCall[] = [];
  const gateway = new Proxy(local, {
    get(target, property, receiver) {
      const value: unknown = Reflect.get(target, property, receiver);
      if (typeof value !== "function") return value;
      return (...args: unknown[]) => {
        calls.push({ method: String(property), args });
        return (value as (...a: unknown[]) => unknown).apply(target, args);
      };
    },
  });
  return { gateway, calls };
}

/** reminders.moveChannel の呼び出しを数える包み（ほかはそのまま） */
function trackMoves(store: ReminderStore): { store: ReminderStore; moves: Array<[number, string]> } {
  const moves: Array<[number, string]> = [];
  const proxy = new Proxy(store, {
    get(target, property, receiver) {
      const value: unknown = Reflect.get(target, property, receiver);
      if (typeof value !== "function") return value;
      if (property === "moveChannel") {
        return (id: number, channelId: string) => {
          moves.push([id, channelId]);
          return target.moveChannel(id, channelId);
        };
      }
      return (value as (...a: unknown[]) => unknown).bind(target);
    },
  });
  return { store: proxy, moves };
}

function okResult(text: string): RunResult {
  return { ok: true, text, sessionId: "session-1", usage: turnUsage(10, 2000, 300), durationMs: 4200, toolCalls: 1, contextTokens: 900 };
}

type SetupOptions = {
  /** places に渡す物。true は本物の placeRefs、false は渡さない（既定 true） */
  places?: boolean | Pick<PlaceRefs, "isLocal" | "refOf">;
  /** mika を設定に入れるか（既定 true） */
  mikaInConfig?: boolean;
  /** #tasks を /setup で作ってあるか（既定 true） */
  tasks?: boolean;
  /** 予約した依頼のターンの結果 */
  steps?: RunResult[];
};

/**
 * 既定の人格（#tasks 400・#inbox 500・Discord の話題 222）と mika（Discord の話題 111・ローカルの話題・ローカルの入口）。
 * 振り分けは本物の PersonaRouter。scheduler の配線は main.ts と同じ（ownerPosts・既定の Bot の channelExists・personas・places・history）
 */
function setup(t: TestContext, options: SetupOptions = {}) {
  const db = tempDb(t);
  const clock = { now: NOW };
  const stores = createStores(db, () => clock.now);
  const { guildSettings, topicSessions } = stores;
  if (options.tasks !== false) guildSettings.setChannel(GUILD, "tasksChannelId", TASKS);
  guildSettings.setChannel(GUILD, "inboxChannelId", INBOX);
  guildSettings.setPersonaInbox(GUILD, "mika", LOCAL_ENTRY, "local");
  topicSessions.create({ channelId: DEFAULT_TOPIC, guildId: GUILD, title: "既定の話題", categoryId: "category-1" });
  topicSessions.create({ channelId: DISCORD_TOPIC, guildId: GUILD, title: "Discord の話題", categoryId: "category-1", persona: "mika" });
  topicSessions.create({ channelId: LOCAL_TOPIC, guildId: GUILD, title: "ローカルの話題", categoryId: "local", persona: "mika", place: "local" });
  const defaultGateway = new FakeGateway({
    allow: ["send", "sendMessage", "editMessage", "startTyping"],
    record: ["send", "sendMessage", "channelExists"],
  });
  for (const channelId of [TASKS, INBOX, DEFAULT_TOPIC, DISCORD_TOPIC]) defaultGateway.alive.add(channelId);
  // 無いチャンネルへの投稿は投げる（Unknown Channel）
  defaultGateway.beforeSendMessage = (channelId) => {
    if (!defaultGateway.alive.has(channelId)) throw new Error("Unknown Channel");
  };
  const mikaGateway = new FakeGateway({
    allow: ["send", "sendMessage", "editMessage", "startTyping"],
    record: ["send", "sendMessage"],
    messageIdPrefix: "mika-",
  });
  const local = recordingLocalGateway(new LocalGateway(new LocalIdStore(db)));
  const connection = { mika: true };
  const runner = new FakeRunner(options.steps ?? []);
  const personas = new PersonaRouter({
    personas: [
      { id: "default", name: "default", engine: "claude", runner, gateway: defaultGateway, connected: () => true },
      ...(options.mikaInConfig === false
        ? []
        : [{ id: "mika", name: "ミカ", engine: "claude" as const, runner, gateway: mikaGateway, connected: () => connection.mika }]),
    ],
    guildSettings,
    topicSessions,
    localGateway: local.gateway,
  });
  const placeRefs = createPlaceRefs({ guildSettings, topicSessions, personaName: (id) => (id === "mika" ? "ミカ" : undefined) });
  const places = options.places === undefined || options.places === true ? placeRefs : options.places === false ? undefined : options.places;
  /** ownerConnected を訊かれたチャンネル */
  const asked: string[] = [];
  const tracked = trackMoves(stores.reminders);
  const logs: string[] = [];
  const log = (line: string): void => void logs.push(line);
  const turnQueue = new RecordingQueue(2);
  const scheduler = new ReminderScheduler({
    cfg: { ownerUserId: "owner-1", timeZone: "Asia/Tokyo" },
    reminders: tracked.store,
    tasks: stores.tasks,
    guildSettings,
    topicSessions,
    gateway: { ...personas.ownerPosts(), channelExists: (channelId) => defaultGateway.channelExists(channelId) },
    personas: {
      ownerOf: (channelId) => personas.ownerOf(channelId),
      ownerConnected: (channelId) => {
        asked.push(channelId);
        return personas.ownerConnected(channelId);
      },
    },
    ...(places === undefined ? {} : { places }),
    resolveChannel: createChannelResolver({ inboxChannelId: undefined, personas: [MIKA] }, guildSettings, topicSessions),
    turnQueue,
    turn: { ...stores, runner, personas, log },
    history: stores.history,
    now: () => clock.now,
    timers: { after: () => () => {} },
    log,
  });
  const add = (channelId: string, overrides: Partial<NewReminder> = {}) =>
    stores.reminders.add({ guildId: GUILD, channelId, kind: "notify", text: "薬を飲む", nextAt: NOW, ...overrides });
  /** その Bot の送れた投稿の [チャンネル, 本文] */
  const posted = (gateway: FakeGateway): Array<[string, string]> => gateway.posts.map(({ channelId, message }) => [channelId, message.text]);
  /** そのチャンネルの履歴の [kind, source, persona, text]（古い順） */
  const rows = (channelId: string): Array<[string, string, string, string]> =>
    stores.history
      .list(channelId, { limit: 50 })
      .map((row) => [row.kind, row.source, row.persona, row.text]);
  /** mika の Bot とローカルの Gateway に何も来ていない（記録が空） */
  const assertMikaAndLocalUntouched = (label: string): void => {
    assert.deepEqual(mikaGateway.calls, [], `${label}: mika`);
    assert.deepEqual(mikaGateway.edits, [], `${label}: mika`);
    assert.equal(mikaGateway.typingStarted, 0, `${label}: mika`);
    assert.deepEqual(local.calls, [], `${label}: ローカル`);
  };
  return {
    ...stores,
    clock,
    defaultGateway,
    mikaGateway,
    local,
    connection,
    personas,
    placeRefs,
    asked,
    moves: tracked.moves,
    logs,
    turnQueue,
    scheduler,
    add,
    posted,
    rows,
    assertMikaAndLocalUntouched,
  };
}

const TOPIC_NOTE = localPlaceNote("「ローカルの話題」（Web）");
const ENTRY_NOTE = localPlaceNote("「ミカ」（Web）");

// ---- 発火の枝（T20〜T22） ----

test("リマインド（T20）: ローカルの話題の知らせは既定の人格の Bot で #tasks に注記つきで 1 回（ボタン・メンションは今と同じ）。ローカル・mika は 0 回で、channel_id は変えない", async (t) => {
  const env = setup(t);
  const added = env.add(LOCAL_TOPIC);
  await env.scheduler.tick();

  assert.deepEqual(
    env.defaultGateway.posts.map(({ channelId, message }) => [channelId, message]),
    [
      [
        TASKS,
        {
          text: `リマインド: 薬を飲む\n${TOPIC_NOTE}`,
          components: [{ kind: "buttons", buttons: reminderFireButtons(added, 1) }],
          mentionUserId: "owner-1",
        } satisfies OutgoingMessage,
      ],
    ],
  );
  assert.equal(TOPIC_NOTE, "頼んだ場所: 「ローカルの話題」（Web）");
  assert.ok(!env.defaultGateway.posts[0]!.message.text.includes("<#"));
  env.assertMikaAndLocalUntouched("ローカルの話題");
  assert.deepEqual(env.moves, []);
  const after = env.reminders.get(added.id)!;
  assert.deepEqual(
    [after.channelId, after.status, after.lastMessageId, after.lastMessageChannelId],
    [LOCAL_TOPIC, "fired", env.defaultGateway.posts[0]!.messageId, TASKS],
  );
  // #tasks は在るので確かめない。頼んだ場所の持ち主の接続も訊かない
  assert.deepEqual(env.defaultGateway.callsOf("channelExists"), []);
  assert.ok(!env.asked.includes(LOCAL_TOPIC));
  for (const line of env.logs) assert.ok(!line.includes(LOCAL_TOPIC) && !line.includes(TASKS) && !line.includes("薬"), line);
});

test("リマインド（T21）: #tasks が無ければ #inbox に同じ注記で出す。入口で頼んだ物は注記が人格の表示名", async (t) => {
  const noTasks = setup(t, { tasks: false });
  const added = noTasks.add(LOCAL_TOPIC);
  await noTasks.scheduler.tick();
  assert.deepEqual(noTasks.posted(noTasks.defaultGateway), [[INBOX, `リマインド: 薬を飲む\n${TOPIC_NOTE}`]]);
  assert.deepEqual([noTasks.reminders.get(added.id)?.channelId, noTasks.reminders.get(added.id)?.lastMessageChannelId], [LOCAL_TOPIC, INBOX]);
  noTasks.assertMikaAndLocalUntouched("#tasks 無し");

  const entry = setup(t);
  const fromEntry = entry.add(LOCAL_ENTRY);
  await entry.scheduler.tick();
  assert.equal(ENTRY_NOTE, "頼んだ場所: 「ミカ」（Web）");
  assert.deepEqual(entry.posted(entry.defaultGateway), [[TASKS, `リマインド: 薬を飲む\n${ENTRY_NOTE}`]]);
  assert.equal(entry.reminders.get(fromEntry.id)?.channelId, LOCAL_ENTRY);
  entry.assertMikaAndLocalUntouched("ローカルの入口");
});

test("リマインド（T22）: ownerConnected が真・偽、持ち主が設定に在る・無いで、出る先・文・行が同じ（頼んだ場所の接続は訊かない）", async (t) => {
  const outcomes: unknown[] = [];
  for (const connected of [true, false]) {
    for (const mikaInConfig of [true, false]) {
      const label = `connected=${connected} inConfig=${mikaInConfig}`;
      const env = setup(t, { mikaInConfig });
      env.connection.mika = connected;
      const added = env.add(LOCAL_TOPIC);
      await env.scheduler.tick();
      env.assertMikaAndLocalUntouched(label);
      assert.ok(!env.asked.includes(LOCAL_TOPIC), label);
      assert.deepEqual(env.moves, [], label);
      const after = env.reminders.get(added.id)!;
      outcomes.push({
        posts: env.defaultGateway.posts,
        row: [after.channelId, after.status, after.lastMessageChannelId],
        history: env.rows(LOCAL_TOPIC).map(([kind, source, , text]) => [kind, source, text]),
      });
    }
  }
  for (const outcome of outcomes) assert.deepEqual(outcome, outcomes[0]);
  assert.deepEqual((outcomes[0] as { row: unknown }).row, [LOCAL_TOPIC, "fired", TASKS]);
});

// ---- 繰り返し・スヌーズ（T23） ----

test("リマインド（T23）: 繰り返しの 2 回目は前の回の通のボタンを #tasks 宛の editMessage で外し、2 通目も #tasks。スヌーズの回も #tasks", async (t) => {
  const env = setup(t);
  const added = env.add(LOCAL_TOPIC, { rule: "daily@09:00" });
  await env.scheduler.tick();
  env.clock.now = new Date(NOW.getTime() + DAY_MS);
  await env.scheduler.tick();
  assert.deepEqual(env.posted(env.defaultGateway), [
    [TASKS, `リマインド: 薬を飲む\n（毎日 9:00）\n${TOPIC_NOTE}`],
    [TASKS, `リマインド: 薬を飲む\n（毎日 9:00）\n${TOPIC_NOTE}`],
  ]);
  assert.deepEqual(
    env.defaultGateway.edits.map(({ channelId, messageId, message }) => [channelId, messageId, message]),
    [[TASKS, env.defaultGateway.posts[0]!.messageId, { text: "リマインド: 薬を飲む\n（毎日 9:00）", components: [] }]],
  );

  // スヌーズの回
  const snoozeAt = new Date(env.clock.now.getTime() + 10 * 60 * 1000);
  assert.ok(env.reminders.snooze(added.id, snoozeAt));
  env.clock.now = snoozeAt;
  await env.scheduler.tick();
  assert.deepEqual(env.posted(env.defaultGateway).at(-1), [TASKS, `リマインド: 薬を飲む\n（毎日 9:00）\n（もう一度）\n${TOPIC_NOTE}`]);
  assert.deepEqual(env.defaultGateway.edits.at(-1)?.channelId, TASKS);
  env.assertMikaAndLocalUntouched("繰り返し");
  assert.deepEqual(env.moves, []);
  assert.equal(env.reminders.get(added.id)?.channelId, LOCAL_TOPIC);
});

// ---- 頼んだ場所の履歴（T24・T25） ----

test("リマインド（T24）: 出せたら頼んだ場所に notice が 1 行（DB から作り直した本文 +（Discord に知らせました）、persona は持ち主）。#tasks には書かない", async (t) => {
  const env = setup(t);
  env.add(LOCAL_TOPIC);
  const entry = env.add(LOCAL_ENTRY, { text: "買い物" });
  await env.scheduler.tick();
  assert.equal(LOCAL_POSTED_NOTE, "（Discord に知らせました）");
  assert.deepEqual(env.rows(LOCAL_TOPIC), [["notice", "system", "mika", `リマインド: 薬を飲む\n${LOCAL_POSTED_NOTE}`]]);
  assert.deepEqual(env.rows(LOCAL_ENTRY), [["notice", "system", "mika", `リマインド: 買い物\n${LOCAL_POSTED_NOTE}`]]);
  assert.deepEqual(env.rows(TASKS), []);
  assert.equal(env.reminders.get(entry.id)?.status, "fired");
  // 行のサーバーは頼んだリマインドの物
  for (const channelId of [LOCAL_TOPIC, LOCAL_ENTRY]) {
    assert.deepEqual(env.history.list(channelId, { limit: 50 }).map((row) => [row.guildId, row.messageId]), [[GUILD, null]], channelId);
  }
});

test("リマインド（T24）: 投稿が reject の回と、投稿の間に止められた回は履歴に書かない", async (t) => {
  const rejected = setup(t);
  rejected.defaultGateway.beforeSendMessage = () => {
    throw new Error("Missing Access");
  };
  const failing = rejected.add(LOCAL_TOPIC);
  await rejected.scheduler.tick();
  assert.deepEqual(rejected.rows(LOCAL_TOPIC), []);
  assert.equal(rejected.reminders.get(failing.id)?.status, "active");

  const stopped = setup(t);
  const added = stopped.add(LOCAL_TOPIC);
  stopped.defaultGateway.beforeSendMessage = () => {
    stopped.reminders.cancel(added.id);
  };
  await stopped.scheduler.tick();
  assert.deepEqual(stopped.rows(LOCAL_TOPIC), []);
  // いま出した通のボタンは #tasks で外す
  assert.deepEqual(stopped.defaultGateway.edits.map(({ channelId }) => channelId), [TASKS]);
});

test("リマインド（T25）: #tasks が在るのに落ちれば次の tick でやり直し、30 回目で諦めて履歴に「知らせられませんでした」の 1 行。1 回だけの物は完了", async (t) => {
  const env = setup(t);
  env.defaultGateway.beforeSendMessage = () => {
    throw new Error("Missing Access");
  };
  const added = env.add(LOCAL_TOPIC);
  for (let attempt = 1; attempt < REMINDER_MAX_ATTEMPTS; attempt++) await env.scheduler.tick();
  assert.deepEqual(env.rows(LOCAL_TOPIC), []);
  assert.equal(env.reminders.get(added.id)?.status, "active");
  await env.scheduler.tick();
  assert.equal(LOCAL_GAVE_UP_NOTE, "（Discord に知らせられませんでした）");
  assert.deepEqual(env.rows(LOCAL_TOPIC), [["notice", "system", "mika", `リマインド: 薬を飲む\n${LOCAL_GAVE_UP_NOTE}`]]);
  assert.equal(env.reminders.get(added.id)?.status, "done");
  env.assertMikaAndLocalUntouched("30 回");
});

test("リマインド（T25）: #tasks も #inbox も無ければ Discord 0 回で、履歴に「知らせられませんでした」の 1 行。1 回だけの物は完了", async (t) => {
  const env = setup(t, { tasks: false });
  env.defaultGateway.alive.delete(INBOX);
  const added = env.add(LOCAL_TOPIC);
  await env.scheduler.tick();
  assert.deepEqual(env.defaultGateway.posts, []);
  assert.deepEqual(env.rows(LOCAL_TOPIC), [["notice", "system", "mika", `リマインド: 薬を飲む\n${LOCAL_GAVE_UP_NOTE}`]]);
  assert.deepEqual(env.history.list(LOCAL_TOPIC, { limit: 50 }).map((row) => row.guildId), [GUILD]);
  assert.equal(env.reminders.get(added.id)?.status, "done");
  env.assertMikaAndLocalUntouched("行き先なし");
});

// ---- 削除済み（T26） ----

test("リマインド（T26）: 削除済みのローカルの話題は今までどおり MOVED_NOTE で #tasks に出して付け替える（削除済みを先に見る）。履歴は書かない", async (t) => {
  const env = setup(t);
  env.topicSessions.markDeleted(LOCAL_TOPIC);
  const added = env.add(LOCAL_TOPIC);
  await env.scheduler.tick();
  assert.deepEqual(env.posted(env.defaultGateway), [[TASKS, `リマインド: 薬を飲む\n${MOVED_NOTE}`]]);
  assert.deepEqual(env.moves, [[added.id, TASKS]]);
  assert.equal(env.reminders.get(added.id)?.channelId, TASKS);
  assert.deepEqual(env.rows(LOCAL_TOPIC), []);
  env.assertMikaAndLocalUntouched("削除済み");
});

// ---- ボタン（T27） ----

test("リマインド（T27）: #tasks の通の［完了］［10 分後］［止める］で、channel_id がローカルの行が done・スヌーズ・取り消しになり、押した通が書き換わる", async (t) => {
  const cases: Array<{ label: string; rule?: string; button: string; status: string; snoozed: boolean }> = [
    { label: "［完了］", button: "完了", status: "done", snoozed: false },
    { label: "［10 分後］", button: "10 分後", status: "active", snoozed: true },
    { label: "［止める］", rule: "daily@09:00", button: "止める", status: "cancelled", snoozed: false },
  ];
  for (const { label, rule, button, status, snoozed } of cases) {
    const env = setup(t);
    const added = env.add(LOCAL_TOPIC, rule === undefined ? {} : { rule });
    await env.scheduler.tick();
    const post = env.defaultGateway.posts[0]!;
    const buttons = (post.message.components ?? []).flatMap((row) => (row.kind === "buttons" ? row.buttons : []));
    const customId = buttons.find((candidate) => candidate.label === button)?.customId;
    assert.ok(customId !== undefined, label);
    const component = createRemindersComponent({
      reminders: env.reminders,
      tasks: env.tasks,
      cfg: { timeZone: "Asia/Tokyo" },
      refOf: env.placeRefs.refOf,
      log: () => {},
    });
    const responder = new FakeResponder();
    const interaction: Interaction = {
      kind: "button",
      guildId: GUILD,
      channelId: TASKS,
      userId: "owner-1",
      createdAt: env.clock.now,
      customId,
      messageId: post.messageId,
    };
    await component.handle(interaction, responder);
    assert.equal(responder.calls.length, 1, label);
    assert.equal(responder.calls[0]?.method, "update", label);
    const after = env.reminders.get(added.id)!;
    assert.deepEqual([after.channelId, after.status, after.snoozeAt !== null], [LOCAL_TOPIC, status, snoozed], label);
  }
});

// ---- reminder_set（T28） ----

function parse(result: TextToolResult): Record<string, unknown> {
  return JSON.parse(result.content[0].text) as Record<string, unknown>;
}

test("reminder_set（T28）: ローカルの場所の知らせの型は created と note。依頼の型・Discord の場所・places 無しの結果には note の鍵が無い", (t) => {
  const env = setup(t);
  const logs: string[] = [];
  const deps = { reminders: env.reminders, log: (line: string) => void logs.push(line), now: () => NOW, places: env.placeRefs };
  const handlers = (channelId: string, kind: RunContext["kind"], withPlaces = true) =>
    createReminderToolHandlers(withPlaces ? deps : { ...deps, places: undefined }, env.tasks, "Asia/Tokyo", { guildId: GUILD, channelId, kind });

  const topic = parse(handlers(LOCAL_TOPIC, "session").reminderSet({ text: "話題で", at: "2026-11-29 09:00" }));
  assert.deepEqual([topic.result, topic.note], ["created", REMINDER_LOCAL_PLACE_NOTE]);
  assert.equal(REMINDER_LOCAL_PLACE_NOTE, "この場所は Web だけなので、時刻になったら右腕の #tasks（無ければ #inbox）に知らせます");
  const entry = parse(handlers(LOCAL_ENTRY, "inbox").reminderSet({ text: "入口で", repeat: "daily", time: "08:00" }));
  assert.deepEqual([entry.result, entry.note], ["created", REMINDER_LOCAL_PLACE_NOTE]);

  for (const [label, result] of [
    ["ローカルの入口の依頼の型", handlers(LOCAL_ENTRY, "inbox").reminderSet({ text: "依頼", kind: "prompt", repeat: "daily", time: "08:00" })],
    ["Discord の話題", handlers(DISCORD_TOPIC, "session").reminderSet({ text: "Discord で", at: "2026-11-29 09:00" })],
    ["#inbox", handlers(INBOX, "inbox").reminderSet({ text: "#inbox で", at: "2026-11-29 09:00" })],
    ["places 無し", handlers(LOCAL_TOPIC, "session", false).reminderSet({ text: "places 無しで", at: "2026-11-29 09:00" })],
  ] as const) {
    const parsed = parse(result);
    assert.equal(parsed.result, "created", label);
    assert.ok(!("note" in parsed), label);
    assert.deepEqual(Object.keys(parsed), ["result", "id", "kind", "text", "next", "repeat", "task"], label);
  }
  assert.ok(logs.every((line) => line.startsWith("reminder_set: created（#")), logs.join("\n"));
});

test("reminder_set（T28）: 場所を引く所が投げても作った物は返し（note 無し）、log を 1 行出す", (t) => {
  const env = setup(t);
  const logs: string[] = [];
  const places = {
    isLocal: (): boolean => {
      throw new Error("database is locked");
    },
  };
  const handlers = createReminderToolHandlers({ reminders: env.reminders, log: (line) => void logs.push(line), now: () => NOW, places }, env.tasks, "Asia/Tokyo", {
    guildId: GUILD,
    channelId: LOCAL_TOPIC,
    kind: "session",
  });
  const parsed = parse(handlers.reminderSet({ text: "話題で", at: "2026-11-29 09:00" }));
  assert.equal(parsed.result, "created");
  assert.ok(!("note" in parsed));
  assert.equal(env.reminders.get(parsed.id as number)?.channelId, LOCAL_TOPIC);
  assert.deepEqual(logs, [`reminder_set: created（#${String(parsed.id)}、notify）`, `reminder_set: 場所を引けませんでした（#${String(parsed.id)}）: database is locked`]);
});

// ---- 予約した依頼（T29） ----

test("リマインド（T29）: ローカルの入口の予約した依頼は、その入口で動いて履歴に owner と agent の行。既定の人格の Bot 0 回・#tasks に回らない", async (t) => {
  const env = setup(t, { steps: [okResult("今日のタスクは 3 件です")] });
  const added = env.add(LOCAL_ENTRY, { kind: "prompt", text: "今日のタスクを出して" });
  await env.scheduler.tick();
  await env.scheduler.idle();
  assert.deepEqual(env.turnQueue.keys, [LOCAL_ENTRY]);
  assert.deepEqual(
    env.rows(LOCAL_ENTRY).map(([kind, source, persona, text]) => [kind, source, persona, text]),
    [
      ["owner", "system", "mika", `予約した依頼（#${added.id}・1 回だけ）:\n今日のタスクを出して`],
      ["agent", "system", "mika", `今日のタスクは 3 件です\n（予約した依頼 #${added.id}）`],
    ],
  );
  assert.deepEqual(env.rows(TASKS), []);
  assert.deepEqual(env.defaultGateway.calls, []);
  assert.deepEqual(env.defaultGateway.edits, []);
  assert.equal(env.defaultGateway.typingStarted, 0);
  assert.deepEqual(env.mikaGateway.calls, []);
  assert.equal(env.reminders.get(added.id)?.status, "done");
});

// ---- 今在るリマインドが変わらない（T30）・場所を引く所の失敗 ----

/** 頼んだ場所に出した投稿・注記・付け替え・確かめ・log・履歴（比べる物） */
async function fireOnce(t: TestContext, options: SetupOptions, channelId: string, prepare: (env: ReturnType<typeof setup>) => void = () => {}) {
  const env = setup(t, options);
  prepare(env);
  const added = env.add(channelId);
  await env.scheduler.tick();
  const after = env.reminders.get(added.id)!;
  return {
    env,
    seen: {
      defaultPosts: env.defaultGateway.posts,
      defaultCalls: env.defaultGateway.calls,
      mikaPosts: env.mikaGateway.posts,
      local: env.local.calls,
      moves: env.moves,
      row: [after.channelId, after.status, after.lastMessageId, after.lastMessageChannelId],
      history: [channelId, TASKS, INBOX].map((id) => env.rows(id)),
    },
  };
}

test("リマインド（T30）: places を渡しても場所が全部 Discord なら、places 無しと同じ呼び出し（注記なし・OWNER_UNREACHABLE_NOTE で付け替えなし・MOVED_NOTE で付け替え）", async (t) => {
  const cases: Array<{ label: string; channelId: string; prepare: (env: ReturnType<typeof setup>) => void; expected: Array<[string, string]>; row: string }> = [
    { label: "頼んだ場所に出す", channelId: DEFAULT_TOPIC, prepare: () => {}, expected: [[DEFAULT_TOPIC, "リマインド: 薬を飲む"]], row: DEFAULT_TOPIC },
    {
      label: "持ち主の Bot に接続していない",
      channelId: DISCORD_TOPIC,
      prepare: (env) => {
        env.connection.mika = false;
      },
      expected: [[TASKS, `リマインド: 薬を飲む\n${OWNER_UNREACHABLE_NOTE}`]],
      row: DISCORD_TOPIC,
    },
    {
      label: "頼んだ場所が無い",
      channelId: DEFAULT_TOPIC,
      prepare: (env) => {
        env.defaultGateway.alive.delete(DEFAULT_TOPIC);
      },
      expected: [[TASKS, `リマインド: 薬を飲む\n${MOVED_NOTE}`]],
      row: TASKS,
    },
    {
      label: "削除済みの Discord の話題",
      channelId: DEFAULT_TOPIC,
      prepare: (env) => {
        env.topicSessions.markDeleted(DEFAULT_TOPIC);
      },
      expected: [[TASKS, `リマインド: 薬を飲む\n${MOVED_NOTE}`]],
      row: TASKS,
    },
  ];
  for (const { label, channelId, prepare, expected, row } of cases) {
    const withPlaces = await fireOnce(t, { places: true }, channelId, prepare);
    const without = await fireOnce(t, { places: false }, channelId, prepare);
    assert.deepEqual(withPlaces.seen, without.seen, label);
    assert.deepEqual(withPlaces.env.logs, without.env.logs, label);
    assert.deepEqual(withPlaces.env.posted(withPlaces.env.defaultGateway), expected, label);
    assert.equal(withPlaces.seen.row[0], row, label);
    assert.deepEqual(withPlaces.seen.history, [[], [], []], label);
  }
});

/** 呼ぶたびに投げるかを切り替えられる places（本物の placeRefs を包む） */
function flakyPlaces(real: PlaceRefs, where: "isLocal" | "refOf"): { places: Pick<PlaceRefs, "isLocal" | "refOf">; failing: { on: boolean } } {
  const failing = { on: true };
  return {
    failing,
    places: {
      isLocal: (channelId) => {
        if (failing.on && where === "isLocal") throw new Error("database is locked");
        return real.isLocal(channelId);
      },
      refOf: (channelId) => {
        if (failing.on && where === "refOf") throw new Error("database is locked");
        return real.refOf(channelId);
      },
    },
  };
}

test("リマインド: 場所を引く所（isLocal・refOf）が投げた回は投稿の失敗と同じ（出さず・DB を変えず・log 1 行）。次の tick で引ければ #tasks に出して履歴に 1 行", async (t) => {
  for (const where of ["isLocal", "refOf"] as const) {
    let flaky: ReturnType<typeof flakyPlaces> | undefined;
    const env = setup(t, {
      places: {
        isLocal: (channelId) => flaky!.places.isLocal(channelId),
        refOf: (channelId) => flaky!.places.refOf(channelId),
      },
    });
    flaky = flakyPlaces(env.placeRefs, where);
    const added = env.add(LOCAL_TOPIC);
    await env.scheduler.tick();
    assert.deepEqual(env.defaultGateway.calls, [], where);
    assert.deepEqual(env.defaultGateway.posts, [], where);
    env.assertMikaAndLocalUntouched(where);
    assert.deepEqual(env.rows(LOCAL_TOPIC), [], where);
    const pending = env.reminders.get(added.id)!;
    assert.deepEqual([pending.status, pending.fireSeq, pending.channelId], ["active", 0, LOCAL_TOPIC], where);
    assert.deepEqual(env.logs, [`リマインドの場所を引けなかったため、次の回にやり直します（#${added.id}）: database is locked`], where);

    flaky.failing.on = false;
    await env.scheduler.tick();
    assert.deepEqual(env.posted(env.defaultGateway), [[TASKS, `リマインド: 薬を飲む\n${TOPIC_NOTE}`]], where);
    env.assertMikaAndLocalUntouched(where);
    assert.deepEqual(env.rows(LOCAL_TOPIC), [["notice", "system", "mika", `リマインド: 薬を飲む\n${LOCAL_POSTED_NOTE}`]], where);
    assert.equal(env.reminders.get(added.id)?.status, "fired", where);
  }
});

test("リマインド: Discord の場所で場所を引く所が 1 回投げた回も出さず、次の tick で今までどおりの文で頼んだ場所に出す", async (t) => {
  let flaky: ReturnType<typeof flakyPlaces> | undefined;
  const env = setup(t, {
    places: {
      isLocal: (channelId) => flaky!.places.isLocal(channelId),
      refOf: (channelId) => flaky!.places.refOf(channelId),
    },
  });
  flaky = flakyPlaces(env.placeRefs, "isLocal");
  const added = env.add(DEFAULT_TOPIC);
  await env.scheduler.tick();
  assert.deepEqual(env.defaultGateway.calls, [], "投げた回");
  assert.equal(env.reminders.get(added.id)?.status, "active");
  flaky.failing.on = false;
  await env.scheduler.tick();
  assert.deepEqual(env.posted(env.defaultGateway), [[DEFAULT_TOPIC, "リマインド: 薬を飲む"]]);
  assert.deepEqual([env.reminders.get(added.id)?.channelId, env.reminders.get(added.id)?.status], [DEFAULT_TOPIC, "fired"]);
  assert.deepEqual(env.rows(DEFAULT_TOPIC), []);
  env.assertMikaAndLocalUntouched("Discord の場所");
});

test("リマインド: 場所を 30 回引けなければ今在る失敗の数え方で諦め（1 回だけの物は完了）、ローカルかが分からないので履歴に書かない", async (t) => {
  const env = setup(t, {
    places: {
      isLocal: () => {
        throw new Error("database is locked");
      },
      refOf: () => {
        throw new Error("database is locked");
      },
    },
  });
  const added = env.add(LOCAL_TOPIC);
  for (let attempt = 1; attempt < REMINDER_MAX_ATTEMPTS; attempt++) await env.scheduler.tick();
  assert.equal(env.reminders.get(added.id)?.status, "active");
  await env.scheduler.tick();
  assert.equal(env.reminders.get(added.id)?.status, "done");
  assert.deepEqual(env.defaultGateway.calls, []);
  env.assertMikaAndLocalUntouched("30 回");
  assert.deepEqual(env.rows(LOCAL_TOPIC), []);
  assert.equal(env.logs.length, REMINDER_MAX_ATTEMPTS);
  assert.match(env.logs.at(-1)!, new RegExp(`^リマインドの投稿に ${REMINDER_MAX_ATTEMPTS} 回失敗したため、この回を諦めました（#${added.id}、guild=${GUILD}）: database is locked$`));
});

// ---- 配線の見張り ----

test("見張り: main.ts はリマインドの発火（ReminderScheduler）と reminder_set のツールに、まとめと同じ placeRefs を渡す", () => {
  const source = readFileSync(new URL("../src/main.ts", import.meta.url), "utf8");
  assert.match(source, /\nconst reminderTools = \{ reminders, log, now, places: placeRefs \};\n/);
  const scheduler = source.match(/\nconst reminderScheduler = new ReminderScheduler\(\{\n[\s\S]*?\n\}\);/)?.[0];
  assert.ok(scheduler !== undefined);
  assert.match(scheduler, /\n {2}places: placeRefs,\n/);
  assert.match(scheduler, /\n {2}\.\.\.history,\n/);
  // placeRefs は reminderTools より前に 1 つだけ作る
  assert.equal(source.match(/createPlaceRefs\(/g)?.length, 1);
  const made = source.indexOf("const placeRefs = createPlaceRefs({");
  assert.ok(made >= 0 && made < source.indexOf("const reminderTools = {") && made < source.indexOf("const reminderScheduler = new ReminderScheduler({"));
});
