import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import type { AgentRunner, RunContext, RunInput, RunResult } from "../src/agent/runner.ts";
import { createKnowledgeToolHandlers, createMemoryToolHandlers, type TextToolResult } from "../src/agent/tools.ts";
import { createChannelResolver } from "../src/app/access.ts";
import { createConfirmKbDelete, KB_DELETE_LOCAL_MESSAGE, kbDeletePrompt } from "../src/app/commands/kb-delete.ts";
import { createNotifyMemoryChange, memoryNotice } from "../src/app/commands/memory-undo.ts";
import { createHandler, MAX_TURNS_REPLY, PROGRESS_DELAY_MS, type ProgressTimers } from "../src/app/handler.ts";
import { PersonaRouter } from "../src/app/personas.ts";
import { createPlaceRefs } from "../src/app/place-refs.ts";
import { KeyedSerialQueue } from "../src/app/queue.ts";
import type { Gateway, OutgoingMessage } from "../src/discord/gateway.ts";
import { LocalGateway } from "../src/discord/local-gateway.ts";
import type { HistoryRow } from "../src/store/history.ts";
import { LocalIdStore } from "../src/store/local-places.ts";
import type { Memory } from "../src/store/memories.ts";
import { createStores, tempDb } from "./helpers/db.ts";
import { FakeGateway } from "./helpers/gateway.ts";
import { RecordingChannelOps } from "./helpers/recording.ts";
import { FakeRunner, turnUsage } from "./helpers/runner.ts";

// ローカルの場所（place = 'local'。#530 の WP4 の 2 つ目。docs/plan/personas-web-antigravity.md §3.3 の 3・4・6）への送信。
// 記憶の知らせ・kb_delete の確認・1 ターンの間にローカルの Gateway に来た送信の一覧を固定する

const NOW = new Date("2026-11-28T00:00:00.000Z");
const GUILD = "900";
const INBOX = "500";
/** Discord の話題（足した人格 mika） */
const DISCORD_TOPIC = "111";
/** ローカルの話題（mika）。番号は LocalIdStore と同じ形 */
const LOCAL_TOPIC = "100000000000000000001";
/** ローカルの入口（mika の #<NAME>） */
const LOCAL_ENTRY = "100000000000000000002";

/** ローカルの Gateway の呼び出し（メソッド・引数・返した値） */
type LocalCall = { method: string; args: unknown[]; result?: unknown };

/** 本物の LocalGateway に、呼び出しを全部記録する包みを被せる */
function recordingLocalGateway(local: LocalGateway): { gateway: Gateway; calls: LocalCall[] } {
  const calls: LocalCall[] = [];
  const gateway = new Proxy(local, {
    get(target, property, receiver) {
      const value: unknown = Reflect.get(target, property, receiver);
      if (typeof value !== "function") return value;
      return (...args: unknown[]) => {
        const call: LocalCall = { method: String(property), args };
        calls.push(call);
        const out: unknown = value.apply(target, args);
        if (out instanceof Promise) {
          return out.then((resolved: unknown) => {
            call.result = resolved;
            return resolved;
          });
        }
        call.result = out;
        return out;
      };
    },
  });
  return { gateway, calls };
}

/** Discord の Bot の偽 Gateway（送る操作を全部記録する） */
function discordGateway(): FakeGateway {
  return new FakeGateway({ allow: ["send", "sendMessage", "editMessage", "startTyping"], record: ["send", "sendMessage"] });
}

/** その Bot に何も来ていない（記録が空） */
function assertUntouched(gateway: FakeGateway, label: string): void {
  assert.deepEqual(gateway.calls, [], label);
  assert.deepEqual(gateway.edits, [], label);
  assert.equal(gateway.typingStarted, 0, label);
}

/**
 * 既定の人格（#inbox 500）と mika（Discord の話題 111・ローカルの話題・ローカルの入口）。
 * 振り分けは本物の PersonaRouter で、ローカルの場所には記録の包みを被せた本物の LocalGateway を渡す
 */
function setup(t: TestContext, runner: AgentRunner = new FakeRunner([])) {
  const db = tempDb(t);
  const stores = createStores(db, () => NOW);
  const { guildSettings, topicSessions } = stores;
  guildSettings.setChannel(GUILD, "inboxChannelId", INBOX);
  guildSettings.setPersonaInbox(GUILD, "mika", LOCAL_ENTRY, "local");
  topicSessions.create({ channelId: DISCORD_TOPIC, guildId: GUILD, title: "Discord の話題", categoryId: "category-1", persona: "mika" });
  topicSessions.create({ channelId: LOCAL_TOPIC, guildId: GUILD, title: "ローカルの話題", categoryId: "local", persona: "mika", place: "local" });
  const defaultGateway = discordGateway();
  const mikaGateway = discordGateway();
  const local = recordingLocalGateway(new LocalGateway(new LocalIdStore(db)));
  const personas = new PersonaRouter({
    personas: [
      { id: "default", name: "default", engine: "claude", runner, gateway: defaultGateway, connected: () => true },
      { id: "mika", name: "ミカ", engine: "claude", runner, gateway: mikaGateway, connected: () => true },
    ],
    guildSettings,
    topicSessions,
    localGateway: local.gateway,
  });
  const placeRefs = createPlaceRefs({ guildSettings, topicSessions, personaName: (id) => (id === "mika" ? "ミカ" : undefined) });
  const logs: string[] = [];
  const log = (line: string): void => void logs.push(line);
  /** そのチャンネルの履歴の行 */
  const rows = (channelId: string): HistoryRow[] => stores.history.list(channelId, { limit: 50 });
  /** どの Bot・ローカルの Gateway にも何も来ていない */
  const assertNothingSent = (label: string): void => {
    assertUntouched(defaultGateway, `${label}: 既定の人格`);
    assertUntouched(mikaGateway, `${label}: mika`);
    assert.deepEqual(local.calls, [], `${label}: ローカル`);
  };
  return { db, ...stores, defaultGateway, mikaGateway, local, personas, placeRefs, logs, log, rows, assertNothingSent };
}

function context(channelId: string): RunContext {
  return { guildId: GUILD, channelId, kind: channelId === LOCAL_ENTRY ? "inbox" : "session" };
}

function parse(result: TextToolResult): Record<string, unknown> {
  return JSON.parse(result.content[0].text) as Record<string, unknown>;
}

// ---- 記憶の変更の知らせ（T11・T12） ----

test("記憶の知らせ（§8.4）: ローカルの場所で記憶した・置き換えた・忘れたら、送らずにその場所の履歴に notice が 1 行ずつ（文は memoryNotice、persona は持ち主、ボタン無し）", async (t) => {
  const env = setup(t);
  const notify = createNotifyMemoryChange({
    gateway: env.personas.ownerPosts(),
    places: env.placeRefs,
    history: env.history,
    personaOf: (channelId) => env.personas.ownerOf(channelId),
    log: env.log,
  });
  const tools = createMemoryToolHandlers({ memories: env.memories, notifyMemoryChange: notify }, context(LOCAL_TOPIC));

  assert.deepEqual(parse(await tools.memorySave({ text: "住んでいる地域: 東京都練馬区" })), { result: "saved", id: 1 });
  assert.deepEqual(parse(await tools.memorySave({ text: "住んでいる地域: 東京都杉並区", replace_id: 1 })), { result: "saved", id: 2 });
  assert.deepEqual(parse(await tools.memoryForget({ id: 2 })), { result: "forgotten" });

  // 文は Discord の知らせ（memoryNotice）と同じ
  const memory = (id: number, text: string): Memory => ({ id, text, channelId: LOCAL_TOPIC, createdAt: "", deletedAt: null });
  const [first, second] = [memory(1, "住んでいる地域: 東京都練馬区"), memory(2, "住んでいる地域: 東京都杉並区")];
  const expected = [
    memoryNotice({ kind: "saved", added: first }).text,
    memoryNotice({ kind: "saved", added: second, removed: first }).text,
    memoryNotice({ kind: "forgotten", removed: second }).text,
  ];
  assert.deepEqual(expected, ["（記憶しました: 住んでいる地域: 東京都練馬区）", "（記憶しました: 住んでいる地域: 東京都杉並区）", "（忘れました: 住んでいる地域: 東京都杉並区）"]);
  assert.deepEqual(
    env.rows(LOCAL_TOPIC).map(({ guildId, kind, source, persona, text, messageId }) => ({ guildId, kind, source, persona, text, messageId })),
    expected.map((text) => ({ guildId: GUILD, kind: "notice", source: "system", persona: "mika", text, messageId: null })),
  );
  // ローカルの入口でも同じ（persona は入口の持ち主）
  const entryTools = createMemoryToolHandlers({ memories: env.memories, notifyMemoryChange: notify }, context(LOCAL_ENTRY));
  await entryTools.memorySave({ text: "好きな色: 青" });
  assert.deepEqual(
    env.rows(LOCAL_ENTRY).map(({ kind, persona, text }) => ({ kind, persona, text })),
    [{ kind: "notice", persona: "mika", text: "（記憶しました: 好きな色: 青）" }],
  );
  env.assertNothingSent("ローカルの場所");
  assert.deepEqual(env.logs, []);
});

test("記憶の知らせ: Discord の場所は今と同じ 1 通（［取り消す］付き）を持ち主の Bot で送り、履歴は 0 行。places を渡さなくても同じ", async (t) => {
  for (const withPlaces of [true, false]) {
    const env = setup(t);
    const notify = createNotifyMemoryChange({
      gateway: env.personas.ownerPosts(),
      ...(withPlaces ? { places: env.placeRefs } : {}),
      history: env.history,
      personaOf: (channelId) => env.personas.ownerOf(channelId),
      log: env.log,
    });
    const tools = createMemoryToolHandlers({ memories: env.memories, notifyMemoryChange: notify }, context(DISCORD_TOPIC));
    await tools.memorySave({ text: "住んでいる地域: 東京都練馬区" });
    const added = env.memories.list()[0]!;
    assert.deepEqual(env.mikaGateway.calls, [{ method: "sendMessage", channelId: DISCORD_TOPIC, message: memoryNotice({ kind: "saved", added }) }]);
    const row = memoryNotice({ kind: "saved", added }).components?.[0];
    assert.ok(row?.kind === "buttons" && row.buttons[0]?.label === "取り消す");
    assertUntouched(env.defaultGateway, "既定の人格");
    assert.deepEqual(env.local.calls, []);
    assert.deepEqual(env.rows(DISCORD_TOPIC), []);
    assert.deepEqual(env.logs, []);
  }
});

// ---- kb_delete（T13） ----

test("kb_delete（§8.4）: ローカルの場所では確認を送らずに固定の文で投げ、項目は残る。Discord の場所は今と同じ confirm_posted と確認の 1 通", async (t) => {
  const env = setup(t);
  const confirmKbDelete = createConfirmKbDelete({ gateway: env.personas.ownerPosts(), places: env.placeRefs });
  const entry = env.knowledge.add({ title: "旅行の宿", summary: "候補 2 つ" });
  const deps = { knowledge: env.knowledge, confirmKbDelete, timeZone: "Asia/Tokyo" };

  for (const channelId of [LOCAL_TOPIC, LOCAL_ENTRY]) {
    await assert.rejects(createKnowledgeToolHandlers(deps, context(channelId)).kbDelete({ id: entry.id }), { message: KB_DELETE_LOCAL_MESSAGE });
  }
  assert.equal(KB_DELETE_LOCAL_MESSAGE, "Web だけの場所では削除の確認を出せません。右腕（#inbox）から頼んでください");
  assert.equal(env.knowledge.get(entry.id)?.title, "旅行の宿");
  env.assertNothingSent("ローカルの場所");

  assert.deepEqual(parse(await createKnowledgeToolHandlers(deps, context(DISCORD_TOPIC)).kbDelete({ id: entry.id })), {
    result: "confirm_posted",
    id: entry.id,
    title: "旅行の宿",
  });
  assert.deepEqual(env.mikaGateway.calls, [{ method: "sendMessage", channelId: DISCORD_TOPIC, message: kbDeletePrompt(entry) }]);
  assert.deepEqual(env.local.calls, []);
  assert.equal(env.knowledge.get(entry.id)?.title, "旅行の宿");
});

// ---- 1 ターンの一覧（T15・T16） ----

/** 偽のタイマー。advance で経過時間を進め、その間に来た after・every を時刻順に呼ぶ */
class FakeTimers implements ProgressTimers {
  elapsed = 0;
  private timers: Array<{ id: number; at: number; fn: () => void; interval?: number }> = [];
  private nextId = 1;

  after(fn: () => void, ms: number): () => void {
    const id = this.nextId++;
    this.timers.push({ id, at: this.elapsed + ms, fn });
    return () => this.remove(id);
  }
  every(fn: () => void, ms: number): () => void {
    const id = this.nextId++;
    this.timers.push({ id, at: this.elapsed + ms, fn, interval: ms });
    return () => this.remove(id);
  }

  async advance(ms: number): Promise<void> {
    const target = this.elapsed + ms;
    for (;;) {
      await settle();
      const due = this.timers.filter((timer) => timer.at <= target).sort((a, b) => a.at - b.at)[0];
      if (due === undefined) break;
      this.elapsed = due.at;
      if (due.interval === undefined) this.remove(due.id);
      else due.at += due.interval;
      due.fn();
    }
    this.elapsed = target;
    await settle();
  }

  private remove(id: number): void {
    this.timers = this.timers.filter((timer) => timer.id !== id);
  }
}

async function settle(): Promise<void> {
  for (let i = 0; i < 10; i++) await new Promise((resolve) => setImmediate(resolve));
}

/**
 * 履歴に対応の行が在るか。send は本文が同じ行、sendMessage は返した番号を messageId に持つ行か本文が同じ行。
 * それ以外（editMessage・startTyping など）は履歴に対応の行を持たない
 */
function inHistory(call: LocalCall, rows: readonly HistoryRow[]): boolean {
  if (call.method === "send") return rows.some((row) => row.text === call.args[1]);
  if (call.method === "sendMessage") {
    const message = call.args[1] as OutgoingMessage;
    return rows.some((row) => (row.messageId !== null && row.messageId === call.result) || row.text === message.text);
  }
  return false;
}

/** 一覧の 1 行（メソッドと、送った文のボタンの名前） */
function describeCall(call: LocalCall): { method: string; buttons?: string[] } {
  if (call.method !== "sendMessage") return { method: call.method };
  const message = call.args[1] as OutgoingMessage;
  const buttons = (message.components ?? []).flatMap((row) => (row.kind === "buttons" ? row.buttons.map((button) => button.label) : []));
  return { method: call.method, buttons };
}

/**
 * ローカルの話題に Web の発言を 1 つ。偽のタイマーで途中経過が出るまで待たせてから result を返す。
 * 履歴の行・ローカルの Gateway の呼び出しのうち履歴に対応の行が無い物・履歴に在る物を返す
 */
async function oneLocalTurn(t: TestContext, result: RunResult) {
  const runner = new FakeRunner([result]);
  const env = setup(t, runner);
  const timers = new FakeTimers();
  const queue = new KeyedSerialQueue(2);
  const cfg = { allowedGuildIds: [GUILD], inboxChannelId: undefined, ownerUserId: "700", timeZone: "Asia/Tokyo" };
  const handler = createHandler({
    cfg,
    resolveChannel: createChannelResolver(cfg, env.guildSettings, env.topicSessions),
    gateway: env.personas.ownerPosts(),
    runner,
    personas: env.personas,
    sessions: env.sessions,
    seeds: env.seeds,
    topicSessions: env.topicSessions,
    inboxSummaries: env.inboxSummaries,
    memories: env.memories,
    channelOps: new RecordingChannelOps(),
    usage: env.usage,
    queue,
    now: () => new Date(NOW.getTime() + timers.elapsed),
    timers,
    history: env.history,
    log: (line) => (line.startsWith("トークン（") ? undefined : env.logs.push(line)),
  });
  let release = (): void => {};
  const gate = new Promise<void>((resolve) => (release = resolve));
  runner.beforeResult = () => gate;

  const submitted = await handler.submitText({ guildId: GUILD, channelId: LOCAL_TOPIC, content: "宿を比べて", at: NOW, source: "web" });
  assert.equal(submitted.result, "accepted");
  await timers.advance(PROGRESS_DELAY_MS);
  release();
  await queue.idle();
  await settle();

  const rows = env.rows(LOCAL_TOPIC);
  const unmatched = env.local.calls.filter((call) => !inHistory(call, rows)).map(describeCall);
  const matched = env.local.calls.filter((call) => inHistory(call, rows)).map(describeCall);
  return { env, rows, unmatched, matched };
}

/** 履歴に対応の行が無い送信の、固定の一覧（§3.3 の 6）: 入力中・途中経過（［中断］付き）・途中経過の書き換え（終わり方） */
const UNRECORDED_SENDS = [{ method: "startTyping" }, { method: "sendMessage", buttons: ["中断"] }, { method: "editMessage" }];

test("1 ターンの一覧（§8.4）: ローカルの話題への Web の発言 1 つで、履歴は owner 1 行・agent 1 行。返事の <#123> は書き換わらない。履歴に対応の行が無い送信は固定の一覧だけで、Discord の Bot には 0 回", async (t) => {
  const reply = "比べました。詳しくは <#123> にまとめています";
  const { env, rows, unmatched, matched } = await oneLocalTurn(t, {
    ok: true,
    text: reply,
    sessionId: "session-1",
    usage: turnUsage(10, 2000, 300),
    durationMs: 4200,
    toolCalls: 0,
    contextTokens: 2310,
  });

  assert.deepEqual(
    rows.map(({ kind, source, persona, text }) => ({ kind, source, persona, text })),
    [
      { kind: "owner", source: "web", persona: "mika", text: "宿を比べて" },
      { kind: "agent", source: "web", persona: "mika", text: reply },
    ],
  );
  assert.deepEqual(unmatched, UNRECORDED_SENDS);
  // 履歴に在る側: 発言の写し（owner の行の messageId）と返事（agent の行の本文）
  assert.deepEqual(matched, [{ method: "sendMessage", buttons: [] }, { method: "send" }]);
  const sent = env.local.calls.find((call) => call.method === "send");
  assert.equal(sent?.args[1], reply);
  assertUntouched(env.defaultGateway, "既定の人格");
  assertUntouched(env.mikaGateway, "mika");
  assert.deepEqual(env.logs, []);
});

test("1 ターンの一覧: 手順の上限で止まると MAX_TURNS_REPLY が agent の行に在り、［続ける］付きの送信は履歴に在る側。対応の行が無い送信は同じ固定の一覧", async (t) => {
  const { env, rows, unmatched, matched } = await oneLocalTurn(t, {
    ok: false,
    errorMessage: "error_max_turns",
    sessionId: "session-1",
    sessionRecorded: true,
    toolCalls: 0,
  });

  assert.deepEqual(
    rows.map(({ kind, text, outcome }) => ({ kind, text, outcome })),
    [
      { kind: "owner", text: "宿を比べて", outcome: null },
      { kind: "agent", text: MAX_TURNS_REPLY, outcome: "max_turns" },
    ],
  );
  assert.deepEqual(unmatched, UNRECORDED_SENDS);
  assert.deepEqual(matched, [{ method: "sendMessage", buttons: [] }, { method: "sendMessage", buttons: ["続ける"] }]);
  assertUntouched(env.defaultGateway, "既定の人格");
  assertUntouched(env.mikaGateway, "mika");
  assert.deepEqual(env.logs, ["ターンが失敗しました: error_max_turns"]);
});

// ---- 配線の見張り ----

test("見張り: main.ts は記憶の知らせ・kb_delete の確認・cc のツールに、まとめと同じ placeRefs を渡す（記憶の知らせは履歴と持ち主も）", () => {
  const source = readFileSync(new URL("../src/main.ts", import.meta.url), "utf8");
  const kbMemory = source.match(/const kbMemory = \{\n[\s\S]*?\n\};/)?.[0];
  assert.ok(kbMemory !== undefined);
  assert.match(kbMemory, /\n {2}confirmKbDelete: createConfirmKbDelete\(\{ gateway: ownerPosts, places: placeRefs \}\),\n/);
  const notify = kbMemory.match(/\n {2}notifyMemoryChange: createNotifyMemoryChange\(\{\n[\s\S]*?\n {2}\}\),\n/)?.[0];
  assert.ok(notify !== undefined);
  assert.match(notify, /\n {4}places: placeRefs,\n/);
  assert.match(notify, /\n {4}\.\.\.history,\n/);
  assert.match(notify, /\n {4}personaOf: \(channelId\) => personas\.ownerOf\(channelId\),\n/);
  const ccTools = source.match(/\n {2}ccTools = createCcTools\(\{\n[\s\S]*?\n {2}\}\);/)?.[0];
  assert.ok(ccTools !== undefined);
  assert.match(ccTools, /\n {4}places: placeRefs,\n/);
  // placeRefs はどれより前に 1 つだけ作る
  assert.equal(source.match(/createPlaceRefs\(/g)?.length, 1);
  const made = source.indexOf("const placeRefs = createPlaceRefs({");
  assert.ok(made >= 0 && made < source.indexOf("const kbMemory = {") && made < source.indexOf("ccTools = createCcTools({"));
});
