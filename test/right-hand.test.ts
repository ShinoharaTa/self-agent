// 右腕の始める・一覧（app/right-hand.ts。docs/plan/web-ui-v3.md §4 の M6b）。偽 Gateway・一時 SQLite・偽の submitText で確かめる
import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { modelKeys } from "../src/agent/models.ts";
import type { RunContext } from "../src/agent/runner.ts";
import type { TopicOpenArgs } from "../src/agent/tools.ts";
import { createTopicSession } from "../src/app/commands/new.ts";
import type { Handler, SubmitTextResult } from "../src/app/handler.ts";
import { KeyedSerialQueue } from "../src/app/queue.ts";
import {
  createRightHand,
  FIRST_TURN_FAILED_NOTE,
  NO_PROJECT_SESSIONS_NOTE,
  PERSONA_MODEL_NOTE,
  PERSONA_PLACE_NOTE,
  PLACE_FALLBACK_NOTE,
  SESSION_OPEN_BAD_MODEL_MESSAGE,
  SESSION_OPEN_EXISTING_MESSAGE,
  TOPIC_LIST_DISABLED_MESSAGE,
  TOPIC_LIST_NOTICE,
  TOPIC_MOVE_ALREADY,
  TOPIC_MOVE_BAD_PLACE,
  TOPIC_MOVE_BAD_TOPIC,
  TOPIC_MOVE_NEEDS_TOPIC,
  TOPIC_MOVE_NOT_AVAILABLE,
  TOPIC_MOVE_OWN_ONLY,
  TOPIC_MOVE_POST_FAILED,
  TOPIC_MOVE_PROPOSED,
} from "../src/app/right-hand.ts";
import { AUTO_SESSION_LIMIT_MESSAGE } from "../src/app/session-open.ts";
import type { ProjectSessionGate } from "../src/app/session-ops.ts";
import { moveRefusalText } from "../src/app/topic-move.ts";
import type { ProposeResult, TopicProposals } from "../src/app/topic-proposals.ts";
import { buildTopics, type TopicsInput, type TopicSeed } from "../src/app/topics.ts";
import type { PersonaConfig } from "../src/config.ts";
import { PlaceSettingStore } from "../src/store/place-settings.ts";
import { createStores, tempDb, tempDir } from "./helpers/db.ts";
import { FakeGateway } from "./helpers/gateway.ts";

/** 2026-10-02(金) 09:12 JST */
const NOW = new Date("2026-10-02T00:12:00Z");
const GUILD = "guild-1";
const INBOX: RunContext = { guildId: GUILD, channelId: "inbox-1", kind: "inbox" };
const LUNA_INBOX: RunContext = { guildId: GUILD, channelId: "luna-inbox", kind: "inbox" };
const LUNA: PersonaConfig = {
  id: "luna",
  name: "LUNA",
  discordTokenEnv: "SELF_AGENT_PERSONA_LUNA_DISCORD_TOKEN",
  promptFile: "/dev/null",
  model: undefined,
  engine: "claude",
  effort: undefined,
};
const ARGS: TopicOpenArgs = { title: "旅行の計画", context: "京都に 2 泊したい" };

type Options = {
  /** プロジェクトのセッションを使えるか（既定 true）。false なら projectSessions を渡さない */
  cc?: boolean;
  setUp?: boolean;
  perDay?: number;
  collect?: (at: number, done: string | null) => TopicsInput;
  /** ワークスペースを作った直後に呼ぶ（ファイル・ディレクトリを足す） */
  prepare?: (workspace: string) => void;
  /** places の generalDir（既定 "General"） */
  generalDir?: string;
  /** places の protectedDirs（既定は空） */
  protectedDirs?: (workspace: string) => string[];
  /** 場所を変える確認（topic_move）。false なら渡さない（既定は偽の propose。結果は proposeNext、無ければ proposed） */
  proposals?: boolean;
};

function setup(t: TestContext, options: Options = {}) {
  const db = tempDb(t);
  let current = NOW;
  const now = (): Date => current;
  const gateway = new FakeGateway({ record: ["createCategory", "createTextChannel", "channelExists", "countChannelsIn", "send"] });
  gateway.alive.add("active-1");
  const { guildSettings, topicSessions, seeds, history } = createStores(db, now);
  const placeSettings = new PlaceSettingStore(db, now);
  if (options.setUp ?? true) {
    guildSettings.setChannel(GUILD, "inboxChannelId", "inbox-1");
    guildSettings.setStateCategory(GUILD, "active", 1, "active-1");
  }
  const workspace = realpathSync(tempDir(t));
  for (const name of ["alpha", "Beta", "beta"]) mkdirSync(join(workspace, name));
  options.prepare?.(workspace);
  /** queue が残っていれば ready() はその先頭を 1 つずつ返し、尽きたら value */
  const ready: { value: boolean; queue: boolean[] } = { value: true, queue: [] };
  const gate: ProjectSessionGate = {
    places: { workspaceDir: workspace, protectedDirs: options.protectedDirs?.(workspace) ?? [], generalDir: options.generalDir ?? "General" },
    ready: () => ready.queue.shift() ?? ready.value,
  };
  const logs: string[] = [];
  const log = (line: string): void => void logs.push(line);
  const submits: Array<Parameters<Handler["submitText"]>[0]> = [];
  const next: SubmitTextResult[] = [];
  const submitText = async (input: Parameters<Handler["submitText"]>[0]): Promise<SubmitTextResult> => {
    submits.push(input);
    return next.shift() ?? { result: "accepted", turnId: 1, messageId: "m-1" };
  };
  const projectSessions = options.cc === false ? {} : { projectSessions: gate };
  const queue = new KeyedSerialQueue(2);
  const proposeCalls: Array<Parameters<TopicProposals["propose"]>[0]> = [];
  const proposeNext: Array<ProposeResult | Error> = [];
  const proposals: Pick<TopicProposals, "propose"> = {
    propose: async (input) => {
      proposeCalls.push(input);
      const next = proposeNext.shift();
      if (next instanceof Error) throw next;
      return next ?? { result: "proposed", id: 1, channelId: input.channelId, from: "なし", to: input.place.kind === "general" ? "General" : input.place.name };
    },
  };
  const rightHand = createRightHand({
    cfg: { timeZone: "Asia/Tokyo", autoSessionPerDay: options.perDay ?? 3, personas: [LUNA] },
    resolveChannel: (_guildId, channelId) => (channelId === "inbox-1" || channelId === "luna-inbox" ? "inbox" : channelId === "tasks-1" ? "tasks" : "session"),
    personas: { ownerOf: (channelId) => (channelId === "luna-inbox" ? "luna" : "default") },
    topicSessions,
    start: { gateway, guildSettings, topicSessions, queue, log, history, submitText, seeds, placeSettings, ...projectSessions },
    ...(options.collect === undefined ? {} : { collect: options.collect }),
    ...(options.proposals === false ? {} : { proposals }),
    now,
    log,
  });
  const sessionCount = (): number => Number(db.prepare("SELECT COUNT(*) AS n FROM sessions").get()?.n);
  return {
    rightHand,
    gateway,
    guildSettings,
    topicSessions,
    placeSettings,
    seeds,
    history,
    workspace,
    ready,
    logs,
    log,
    submits,
    next,
    proposeCalls,
    proposeNext,
    sessionCount,
    setNow: (at: string) => {
      current = new Date(at);
    },
  };
}

test("right hand open: #inbox・人格の入口以外（セッション・#tasks・context 無し）は not_available で、何も作らない", async (t) => {
  const s = setup(t);
  for (const context of [undefined, { ...INBOX, channelId: "ch-9", kind: "session" as const }, { ...INBOX, channelId: "tasks-1", kind: "tasks" as const }]) {
    assert.deepEqual(await s.rightHand.open({ ...ARGS, text: "一言" }, context), { result: "not_available" });
  }
  assert.equal(s.sessionCount(), 0);
  assert.deepEqual(s.gateway.calls, []);
  assert.equal(s.submits.length, 0);
});

test("right hand open: project が一覧にあればそのプロジェクトの話題（origin inbox・project_dir）で、place がその名前", async (t) => {
  const s = setup(t);
  const result = await s.rightHand.open({ ...ARGS, project: "alpha" }, INBOX);
  assert.deepEqual(result, { result: "created", channelId: "ch-1", place: "alpha", turn: "none" });
  assert.equal(s.topicSessions.projectDirOf("ch-1")?.projectDir, "alpha");
  assert.equal(s.topicSessions.get("ch-1")?.origin, "inbox");
  assert.deepEqual(s.history.list("ch-1", { limit: 10 }).map((row) => row.text), ["右腕が alpha で始めました"]);
});

test("right hand open: project を省くと General で始まり、place が General", async (t) => {
  const s = setup(t);
  const result = await s.rightHand.open(ARGS, INBOX);
  assert.deepEqual(result, { result: "created", channelId: "ch-1", place: "General", turn: "none" });
  assert.equal(s.topicSessions.projectDirOf("ch-1")?.projectDir, "General");
});

test("right hand open: 一覧に無い project は General で始まり、note に一覧に無かった旨", async (t) => {
  const s = setup(t);
  const result = await s.rightHand.open({ ...ARGS, project: "gamma" }, INBOX);
  assert.deepEqual(result, { result: "created", channelId: "ch-1", place: "General", turn: "none", note: PLACE_FALLBACK_NOTE });
  assert.ok(PLACE_FALLBACK_NOTE.includes("一覧に無かった"));
});

test("right hand open: 大文字小文字だけが違う名前は 1 つに決まればそのプロジェクト、2 つ当たれば General", async (t) => {
  const s = setup(t);
  const one = await s.rightHand.open({ ...ARGS, title: "a", project: "ALPHA" }, INBOX);
  assert.deepEqual(one, { result: "created", channelId: "ch-1", place: "alpha", turn: "none" });
  // Beta と beta の 2 つに当たる
  const two = await s.rightHand.open({ ...ARGS, title: "b", project: "BETA" }, INBOX);
  assert.deepEqual(two, { result: "created", channelId: "ch-2", place: "General", turn: "none", note: PLACE_FALLBACK_NOTE });
  // ちょうど同じ名前ならそれ
  const exact = await s.rightHand.open({ ...ARGS, title: "c", project: "Beta" }, INBOX);
  assert.deepEqual(exact, { result: "created", channelId: "ch-3", place: "Beta", turn: "none" });
});

test("right hand open: プロジェクトのセッションを使えないときは軽いセッションで、place は「なし」。project を渡すと note", async (t) => {
  const off = setup(t, { cc: false });
  assert.deepEqual(await off.rightHand.open(ARGS, INBOX), { result: "created", channelId: "ch-1", place: "なし", turn: "none" });
  assert.equal(off.topicSessions.projectDirOf("ch-1"), undefined);
  assert.deepEqual(await off.rightHand.open({ ...ARGS, title: "b", project: "alpha" }, INBOX), {
    result: "created",
    channelId: "ch-2",
    place: "なし",
    turn: "none",
    note: NO_PROJECT_SESSIONS_NOTE,
  });

  // link が済んでいない（ready false）も同じ
  const notReady = setup(t);
  notReady.ready.value = false;
  const result = await notReady.rightHand.open({ ...ARGS, project: "alpha" }, INBOX);
  assert.deepEqual(result, { result: "created", channelId: "ch-1", place: "なし", turn: "none", note: NO_PROJECT_SESSIONS_NOTE });
});

test("right hand open: text を渡すと submitText が 1 回（via right_hand）で turn started。渡さなければ呼ばれず none", async (t) => {
  const s = setup(t);
  const started = await s.rightHand.open({ ...ARGS, text: "宿を探して" }, INBOX);
  assert.ok(started.result === "created");
  assert.equal(started.turn, "started");
  assert.deepEqual(s.submits, [{ guildId: GUILD, channelId: "ch-1", content: "宿を探して", at: NOW, source: "web", via: "right_hand" }]);
  const none = await s.rightHand.open({ ...ARGS, title: "別件" }, INBOX);
  assert.ok(none.result === "created");
  assert.equal(none.turn, "none");
  assert.equal(s.submits.length, 1);
});

test("right hand open: submitText が受け付けなかったら turn failed で note に送れなかった旨、話題は残る", async (t) => {
  const s = setup(t);
  s.next.push({ result: "bot_disconnected" });
  const result = await s.rightHand.open({ ...ARGS, text: "一言" }, INBOX);
  assert.deepEqual(result, { result: "created", channelId: "ch-1", place: "General", turn: "failed", note: FIRST_TURN_FAILED_NOTE });
  assert.equal(s.topicSessions.get("ch-1")?.state, "active");

  // 落とした note と並ぶときは半角の空白でつなぐ
  s.next.push({ result: "not_accepted" });
  const both = await s.rightHand.open({ ...ARGS, title: "b", project: "gamma", text: "一言" }, INBOX);
  assert.ok(both.result === "created");
  assert.equal(both.note, `${PLACE_FALLBACK_NOTE} ${FIRST_TURN_FAILED_NOTE}`);
});

test("right hand open: model の key（前後の空白・大文字も可）で作られ、sessions.model が完全な ID・結果の model が一覧の字・note は無い", async (t) => {
  const s = setup(t);
  const result = await s.rightHand.open({ ...ARGS, project: "alpha", text: "宿を探して", model: " Sonnet " }, INBOX);
  assert.deepEqual(result, { result: "created", channelId: "ch-1", place: "alpha", turn: "started", model: "Sonnet 5.5" });
  assert.equal(s.topicSessions.modelOf("ch-1"), "claude-sonnet-5-5");
  assert.equal(s.topicSessions.projectDirOf("ch-1")?.projectDir, "alpha");
  assert.deepEqual(s.submits, [{ guildId: GUILD, channelId: "ch-1", content: "宿を探して", at: NOW, source: "web", via: "right_hand" }]);
  // 最初の投稿のモデルの行は「話の続き」の前
  const sent = s.gateway.calls.find((call) => call.method === "send");
  const welcome = sent?.method === "send" ? sent.text : "";
  assert.ok(welcome.endsWith("\nモデル: Sonnet 5.5\n#inbox の話の続きです。"), welcome);
});

test("right hand open: model は一覧の字（Sonnet 5.5）でも作られ、sessions.model が完全な ID・結果の model が一覧の字", async (t) => {
  const s = setup(t);
  const result = await s.rightHand.open({ ...ARGS, model: "Sonnet 5.5" }, INBOX);
  assert.deepEqual(result, { result: "created", channelId: "ch-1", place: "General", turn: "none", model: "Sonnet 5.5" });
  assert.equal(s.topicSessions.modelOf("ch-1"), "claude-sonnet-5-5");
});

test("right hand open: 使えない model の名前は bad_model で、チャンネル・行・送信も無く、上限も数えない", async (t) => {
  const s = setup(t, { perDay: 1 });
  for (const model of ["xxx", "Opus 5", "sonnet 4"]) {
    assert.deepEqual(await s.rightHand.open({ ...ARGS, text: "一言", model }, INBOX), {
      result: "bad_model",
      models: modelKeys(),
      message: SESSION_OPEN_BAD_MODEL_MESSAGE,
    });
  }
  assert.equal(s.sessionCount(), 0);
  assert.deepEqual(s.gateway.calls, []);
  assert.equal(s.submits.length, 0);
  // 続けて呼ぶと作れる（上限 1 を消費していない）
  const result = await s.rightHand.open(ARGS, INBOX);
  assert.equal(result.result, "created");
  // #inbox 以外は not_available が先
  assert.deepEqual(await s.rightHand.open({ ...ARGS, model: "xxx" }, { ...INBOX, channelId: "tasks-1", kind: "tasks" }), { result: "not_available" });
});

test("right hand open: model を省くと場所の既定が付き結果に model、既定が無ければ結果に model の欄は無い", async (t) => {
  const s = setup(t);
  const none = await s.rightHand.open({ ...ARGS, title: "a" }, INBOX);
  assert.deepEqual(none, { result: "created", channelId: "ch-1", place: "General", turn: "none" });
  assert.equal(s.topicSessions.modelOf("ch-1"), undefined);
  s.placeSettings.set("p:alpha", { label: null, model: "haiku" });
  const placed = await s.rightHand.open({ ...ARGS, title: "b", project: "alpha" }, INBOX);
  assert.deepEqual(placed, { result: "created", channelId: "ch-2", place: "alpha", turn: "none", model: "Haiku 4.5" });
  assert.equal(s.topicSessions.modelOf("ch-2"), "claude-haiku-4-5");
});

test("right hand open: 一覧に無い project で General に落ちたとき、付くのは general の既定（頼まれた project の既定ではない）", async (t) => {
  const s = setup(t);
  s.placeSettings.set("general", { label: null, model: "opus" });
  s.placeSettings.set("p:gamma", { label: null, model: "haiku" });
  const result = await s.rightHand.open({ ...ARGS, project: "gamma" }, INBOX);
  assert.deepEqual(result, { result: "created", channelId: "ch-1", place: "General", turn: "none", note: PLACE_FALLBACK_NOTE, model: "Opus 5.5" });
  assert.equal(s.topicSessions.modelOf("ch-1"), "claude-opus-5-5");
  // 明示の model と場所の fallback の note が並んでも、note は場所のものだけ
  const explicit = await s.rightHand.open({ ...ARGS, title: "b", project: "gamma", model: "sonnet" }, INBOX);
  assert.deepEqual(explicit, { result: "created", channelId: "ch-2", place: "General", turn: "none", note: PLACE_FALLBACK_NOTE, model: "Sonnet 5.5" });
});

test("right hand open: #<NAME> から model を渡すと作られてモデルは付かず note に人格のモデルの旨。使えない名前は bad_model", async (t) => {
  const s = setup(t);
  s.placeSettings.set("general", { label: null, model: "opus" });
  const result = await s.rightHand.open({ ...ARGS, model: "sonnet" }, LUNA_INBOX);
  assert.ok(result.result === "created");
  assert.equal(result.note, PERSONA_MODEL_NOTE);
  assert.equal(result.model, undefined);
  assert.equal(s.topicSessions.modelOf(result.channelId), undefined);
  assert.equal((await s.rightHand.open({ ...ARGS, title: "b", model: "xxx" }, LUNA_INBOX)).result, "bad_model");
});

test("right hand open: seed に「#inbox からの続き:」と context が入る", async (t) => {
  const s = setup(t);
  const result = await s.rightHand.open(ARGS, INBOX);
  assert.ok(result.result === "created");
  assert.equal(s.seeds.get(result.channelId), `#inbox からの続き:\n${ARGS.context}`);
});

test("right hand open: 同じ題名の進行中の話題があれば existing で、作らず text も送らない", async (t) => {
  const s = setup(t);
  assert.equal((await s.rightHand.open(ARGS, INBOX)).result, "created");
  s.gateway.reset();
  const again = await s.rightHand.open({ ...ARGS, title: " 旅行の計画 ", text: "続き" }, INBOX);
  assert.deepEqual(again, { result: "existing", channelId: "ch-1", message: SESSION_OPEN_EXISTING_MESSAGE });
  assert.equal(s.sessionCount(), 1);
  assert.deepEqual(s.gateway.calls, []);
  assert.equal(s.submits.length, 0);
});

test("right hand open: 今日 autoSessionPerDay 件作っていれば limit で作らない。timeZone の 0 時を過ぎればまた作れる", async (t) => {
  const s = setup(t, { perDay: 2 });
  // 10-01 23:40 JST（前日）は数えない
  s.setNow("2026-10-01T14:40:00.000Z");
  assert.equal((await s.rightHand.open({ ...ARGS, title: "a" }, INBOX)).result, "created");
  s.setNow("2026-10-01T15:00:00.000Z");
  assert.equal((await s.rightHand.open({ ...ARGS, title: "b" }, INBOX)).result, "created");
  assert.equal((await s.rightHand.open({ ...ARGS, title: "c" }, INBOX)).result, "created");
  s.setNow("2026-10-02T14:59:59.999Z");
  assert.deepEqual(await s.rightHand.open({ ...ARGS, title: "d" }, INBOX), { result: "limit", message: AUTO_SESSION_LIMIT_MESSAGE });
  assert.equal(s.sessionCount(), 3);
  // 10-03 00:00 JST
  s.setNow("2026-10-02T15:00:00.000Z");
  assert.equal((await s.rightHand.open({ ...ARGS, title: "d" }, INBOX)).result, "created");
});

test("right hand open: /new で作った話題（origin command）は 1 日の上限に数えない", async (t) => {
  const s = setup(t, { perDay: 1 });
  for (const title of ["x", "y"]) {
    assert.equal((await createTopicSession(GUILD, title, { gateway: s.gateway, guildSettings: s.guildSettings, topicSessions: s.topicSessions, log: s.log })).result, "created");
  }
  assert.equal((await s.rightHand.open(ARGS, INBOX)).result, "created");
});

test("right hand open: 続けて 2 回呼んでも（間隔 0 秒）上限の中なら 2 つとも作れる（cooldown が無い）", async (t) => {
  const s = setup(t);
  assert.equal((await s.rightHand.open({ ...ARGS, title: "a" }, INBOX)).result, "created");
  assert.equal((await s.rightHand.open({ ...ARGS, title: "b" }, INBOX)).result, "created");
  assert.equal(s.sessionCount(), 2);
});

test("right hand open: 上限が 1 のとき並べて 2 回呼ぶと、1 つだけ作れてもう 1 つは limit", async (t) => {
  const s = setup(t, { perDay: 1 });
  const results = await Promise.all([s.rightHand.open({ ...ARGS, title: "a" }, INBOX), s.rightHand.open({ ...ARGS, title: "b" }, INBOX)]);
  assert.deepEqual(results.map((result) => result.result).sort(), ["created", "limit"]);
  assert.equal(s.sessionCount(), 1);
  // 終わった後は途中の数が戻り、DB の 1 件で上限
  assert.equal((await s.rightHand.open({ ...ARGS, title: "c" }, INBOX)).result, "limit");
});

test("right hand open: 足した人格の入口からはその人格の軽いセッションで、project を渡すと note。text は送る", async (t) => {
  const s = setup(t);
  const result = await s.rightHand.open({ ...ARGS, project: "alpha", text: "一言" }, LUNA_INBOX);
  assert.deepEqual(result, { result: "created", channelId: "ch-1", place: "なし", turn: "started", note: PERSONA_PLACE_NOTE });
  assert.equal(s.topicSessions.personaOf("ch-1"), "luna");
  assert.equal(s.topicSessions.projectDirOf("ch-1"), undefined);
  assert.equal(s.submits.length, 1);
  // 最初の投稿は #luna の話の続き
  assert.ok(s.gateway.sent.some((sent) => sent.text.includes("#luna の話の続きです。")));
  // 同じ題名でも人格が違えば existing にしない
  assert.equal((await s.rightHand.open(ARGS, INBOX)).result, "created");
});

test("right hand open: /setup の前は not_set_up で、何も作らない", async (t) => {
  const s = setup(t, { setUp: false });
  assert.deepEqual(await s.rightHand.open({ ...ARGS, text: "一言" }, INBOX), { result: "not_set_up" });
  assert.equal(s.sessionCount(), 0);
  assert.equal(s.submits.length, 0);
});

test("right hand open: log に題名・場所の名前・チャンネルの ID・本文が出ない", async (t) => {
  const s = setup(t);
  await s.rightHand.open({ title: "秘密の題名", context: "秘密の文脈", project: "alpha", text: "秘密の本文" }, INBOX);
  await s.rightHand.open({ title: "別の秘密", context: "秘密の文脈", project: "gamma" }, INBOX);
  assert.ok(s.logs.some((line) => line.includes("右腕から話題を始めました（guild=guild-1、場所あり、最初の依頼あり）")));
  for (const line of s.logs) {
    for (const secret of ["秘密", "alpha", "gamma", "ch-1", "ch-2", "inbox-1"]) assert.equal(line.includes(secret), false, line);
  }
});

test("right hand open: General がファイルで使えないとき、一覧に無い project・General の名指しは場所なしで note はプロジェクトのセッションを使えない旨", async (t) => {
  const s = setup(t, { prepare: (workspace) => writeFileSync(join(workspace, "General"), "x") });
  const result = await s.rightHand.open({ ...ARGS, project: "gamma" }, INBOX);
  assert.deepEqual(result, { result: "created", channelId: "ch-1", place: "なし", turn: "none", note: NO_PROJECT_SESSIONS_NOTE });
  assert.equal(s.topicSessions.projectDirOf("ch-1"), undefined);
  const named = await s.rightHand.open({ ...ARGS, title: "b", project: "General" }, INBOX);
  assert.deepEqual(named, { result: "created", channelId: "ch-2", place: "なし", turn: "none", note: NO_PROJECT_SESSIONS_NOTE });
  for (const sent of [result, named]) assert.ok(sent.result === "created" && !(sent.note ?? "").includes(PLACE_FALLBACK_NOTE));
});

test("right hand open: project に General（大文字小文字を問わない）を渡すと General で始まり note なし。General のディレクトリがまだ無い初回も", async (t) => {
  const s = setup(t);
  const results = [];
  for (const [i, project] of ["General", "general", "GENERAL"].entries()) {
    results.push(await s.rightHand.open({ ...ARGS, title: `t${i}`, project }, INBOX));
  }
  assert.deepEqual(results, [
    { result: "created", channelId: "ch-1", place: "General", turn: "none" },
    { result: "created", channelId: "ch-2", place: "General", turn: "none" },
    { result: "created", channelId: "ch-3", place: "General", turn: "none" },
  ]);
  for (const channelId of ["ch-1", "ch-2", "ch-3"]) {
    assert.equal(s.topicSessions.projectDirOf(channelId)?.projectDir, "General");
    assert.deepEqual(s.history.list(channelId, { limit: 10 }).map((row) => row.text), ["右腕が General で始めました"]);
  }
});

test("right hand open: generalDir が _general のとき project の _general は General で、仕切り・place に実名が出ない", async (t) => {
  const s = setup(t, { generalDir: "_general" });
  for (const [i, project] of ["_general", "_GENERAL"].entries()) {
    const channelId = `ch-${i + 1}`;
    assert.deepEqual(await s.rightHand.open({ ...ARGS, title: `t${i}`, project }, INBOX), { result: "created", channelId, place: "General", turn: "none" });
    assert.equal(s.topicSessions.projectDirOf(channelId)?.projectDir, "_general");
    const texts = s.history.list(channelId, { limit: 10 }).map((row) => row.text);
    assert.deepEqual(texts, ["右腕が General で始めました"]);
  }
});

test("right hand open: startTopic が場所の断りを返したら General で 1 回だけやり直し、話題は 1 つで note が付く", async (t) => {
  // resolvePlace の中の 2 回（門と checkSessionProject）だけ true、startTopic の中では false（unify_not_ready → General も使えず場所なし）
  const s = setup(t);
  s.ready.value = false;
  s.ready.queue.push(true, true);
  const result = await s.rightHand.open({ ...ARGS, project: "alpha" }, INBOX);
  assert.deepEqual(result, { result: "created", channelId: "ch-1", place: "なし", turn: "none", note: NO_PROJECT_SESSIONS_NOTE });
  assert.equal(s.sessionCount(), 1);
  assert.equal(s.gateway.calls.filter((call) => call.method === "createTextChannel").length, 1);

  // やり直しで General を使えたときは、最後の結果の場所で General に落とした note
  const general = setup(t);
  general.ready.queue.push(true, true, false);
  const fell = await general.rightHand.open({ ...ARGS, project: "alpha" }, INBOX);
  assert.deepEqual(fell, { result: "created", channelId: "ch-1", place: "General", turn: "none", note: PLACE_FALLBACK_NOTE });
  assert.equal(general.sessionCount(), 1);
});

test("right hand open: startTopic が投げた後は始めている途中の数が戻り、上限 1 でももう 1 度始められる", async (t) => {
  const s = setup(t, { perDay: 1 });
  const original = s.gateway.createTextChannel.bind(s.gateway);
  let fail = true;
  s.gateway.createTextChannel = async (...args: Parameters<typeof original>) => {
    if (fail) {
      fail = false;
      throw new Error("boom");
    }
    return original(...args);
  };
  await assert.rejects(s.rightHand.open(ARGS, INBOX));
  assert.equal(s.sessionCount(), 0);
  assert.equal((await s.rightHand.open(ARGS, INBOX)).result, "created");
});

test("right hand open: 上限 2 で並べて呼んでも 3 件目は作られない（行ができた後は DB と途中の数の両方で数えるので、2 件目が limit になることもある）", async (t) => {
  const s = setup(t, { perDay: 2 });
  const results = await Promise.all(["a", "b", "c"].map((title) => s.rightHand.open({ ...ARGS, title }, INBOX)));
  const created = results.filter((result) => result.result === "created").length;
  assert.ok(created >= 1 && created <= 2, String(created));
  assert.equal(s.sessionCount(), created);
  // 後から足しても 2 件を超えない
  for (const title of ["d", "e"]) await s.rightHand.open({ ...ARGS, title }, INBOX);
  assert.equal(s.sessionCount(), 2);
});

test("right hand open: 大文字小文字の照合で守る場所・symlink・.. を通さず、General で note", async (t) => {
  const s = setup(t, {
    perDay: 10,
    prepare: (workspace) => {
      mkdirSync(join(workspace, "prot"));
      symlinkSync(join(workspace, "alpha"), join(workspace, "link"));
    },
    protectedDirs: (workspace) => [join(workspace, "prot")],
  });
  for (const [i, project] of ["PROT", "LINK", "../alpha", "alpha/.."].entries()) {
    const channelId = `ch-${i + 1}`;
    const result = await s.rightHand.open({ ...ARGS, title: `t${i}`, project }, INBOX);
    assert.deepEqual(result, { result: "created", channelId, place: "General", turn: "none", note: PLACE_FALLBACK_NOTE }, project);
    assert.equal(s.topicSessions.projectDirOf(channelId)?.projectDir, "General", project);
  }
});

test("right hand open: 前後に空白のある名前・空の名前は General で note（今の動き。ツールの zod が先に止める前提）", async (t) => {
  const s = setup(t);
  for (const [i, project] of [" alpha ", ""].entries()) {
    const result = await s.rightHand.open({ ...ARGS, title: `t${i}`, project }, INBOX);
    assert.deepEqual(result, { result: "created", channelId: `ch-${i + 1}`, place: "General", turn: "none", note: PLACE_FALLBACK_NOTE }, JSON.stringify(project));
  }
});

// ---- 一覧（list） ----

function listSeed(id: string, overrides: Partial<TopicSeed> = {}): TopicSeed {
  return {
    id,
    title: id,
    origin: "session",
    dir: null,
    outside: false,
    pinned: false,
    persona: null,
    sessionId: null,
    cwdLabel: null,
    state: "active",
    activityAt: NOW.toISOString(),
    last: null,
    link: null,
    running: false,
    turns: [],
    movable: true,
    ...overrides,
  };
}

test("right hand list: collect が無ければ disabled", (t) => {
  const s = setup(t);
  assert.deepEqual(s.rightHand.list(INBOX), { result: "disabled", message: TOPIC_LIST_DISABLED_MESSAGE });
});

test("right hand list: counts が buildTopics の「あなたの番」「作業中」の数と同じで、注意の文と places（先頭が General）が付く", (t) => {
  const calls: Array<[number, string | null]> = [];
  const input: TopicsInput = {
    seeds: [
      listSeed("ch:1", { turns: [{ kind: "permission", summary: "Bash: ls", since: NOW.toISOString(), expiresAt: null }] }),
      listSeed("ch:2", { running: true }),
      listSeed("ch:3", { running: true, dir: "General", origin: "project" }),
      listSeed("ch:4", { state: "waiting" }),
    ],
    projects: ["alpha"],
    rightHands: [],
    done: null,
    cc: { enabled: false, stale: false, unreadable: false },
    generalDir: "General",
  };
  const s = setup(t, {
    collect: (at, done) => {
      calls.push([at, done]);
      return input;
    },
  });
  const result = s.rightHand.list(INBOX);
  assert.ok(result.result === "ok");
  assert.deepEqual(calls, [[NOW.getTime(), null]]);
  const built = buildTopics(input);
  assert.equal(result.counts.your_turn, built.turns);
  assert.equal(result.counts.running, built.groups.reduce((sum, group) => sum + group.running, 0));
  assert.equal(result.counts.total, 4);
  assert.equal(result.注意, TOPIC_LIST_NOTICE);
  assert.deepEqual(result.places, ["General", "Beta", "alpha", "beta"]);
  assert.equal(result.topics.find((row) => row.channel_id === "3")?.place, "General");

  // プロジェクトのセッションを使えないときは空
  const off = setup(t, { cc: false, collect: () => input });
  const without = off.rightHand.list(INBOX);
  assert.ok(without.result === "ok");
  assert.deepEqual(without.places, []);
  const notReady = setup(t, { collect: () => input });
  notReady.ready.value = false;
  const notReadyResult = notReady.rightHand.list(INBOX);
  assert.ok(notReadyResult.result === "ok");
  assert.deepEqual(notReadyResult.places, []);
});

// ---- 場所を変える確認（topic_move。M6e） ----

/** 既定の人格の話題を 1 つ作る（channelId の進行中のセッション） */
function addTopic(s: ReturnType<typeof setup>, channelId: string, guildId = GUILD): void {
  s.topicSessions.create({ channelId, guildId, title: "旅行の計画", categoryId: "active-1" });
}
const SESSION: RunContext = { guildId: GUILD, channelId: "700", kind: "session" };

test("right hand move: #inbox から topic を渡すと、その話題に propose し、proposed と確認を出した旨を返す", async (t) => {
  const s = setup(t);
  addTopic(s, "700");
  const result = await s.rightHand.move({ topic: "700", place: "alpha" }, INBOX);
  assert.deepEqual(result, { result: "proposed", channelId: "700", from: "なし", to: "alpha", message: TOPIC_MOVE_PROPOSED });
  assert.deepEqual(s.proposeCalls, [{ guildId: GUILD, channelId: "700", place: { kind: "project", name: "alpha" } }]);
  // 人格の入口からも同じ
  const persona = await s.rightHand.move({ topic: "700", place: "alpha" }, LUNA_INBOX);
  assert.equal(persona.result, "proposed");
});

test("right hand move: #inbox から topic を省くと invalid_topic で、propose しない", async (t) => {
  const s = setup(t);
  addTopic(s, "700");
  assert.deepEqual(await s.rightHand.move({ place: "alpha" }, INBOX), { result: "invalid_topic", message: TOPIC_MOVE_NEEDS_TOPIC });
  // 読めない形も invalid_topic
  for (const topic of ["abc", "#700", "ch-700", "<@700>", ""]) {
    assert.deepEqual(await s.rightHand.move({ topic, place: "alpha" }, INBOX), { result: "invalid_topic", message: TOPIC_MOVE_BAD_TOPIC }, topic);
  }
  assert.equal(s.proposeCalls.length, 0);
});

test("right hand move: topic は数字・<#数字>・ch:数字 のどれでも同じ話題になる", async (t) => {
  const s = setup(t);
  addTopic(s, "700");
  for (const topic of ["700", "<#700>", "ch:700"]) {
    assert.equal((await s.rightHand.move({ topic, place: "General" }, INBOX)).result, "proposed", topic);
  }
  assert.deepEqual(
    s.proposeCalls.map((call) => call.channelId),
    ["700", "700", "700"],
  );
});

test("right hand move: topic の前後の空白は除いて読む（#inbox から \" 700 \" は 700 と同じ話題）", async (t) => {
  const s = setup(t);
  addTopic(s, "700");
  assert.equal((await s.rightHand.move({ topic: " 700 ", place: "alpha" }, INBOX)).result, "proposed");
  assert.deepEqual(s.proposeCalls, [{ guildId: GUILD, channelId: "700", place: { kind: "project", name: "alpha" } }]);
});

test("right hand move: セッションのチャンネルから topic を省く（自分の ID を渡す）と、自分の話題に propose する", async (t) => {
  const s = setup(t);
  addTopic(s, "700");
  assert.equal((await s.rightHand.move({ place: "alpha" }, SESSION)).result, "proposed");
  assert.equal((await s.rightHand.move({ topic: "<#700>", place: "alpha" }, SESSION)).result, "proposed");
  assert.deepEqual(
    s.proposeCalls.map((call) => call.channelId),
    ["700", "700"],
  );
});

test("right hand move: セッションのチャンネルから読めない形の topic を渡すと invalid_topic で、propose しない", async (t) => {
  const s = setup(t);
  addTopic(s, "700");
  assert.deepEqual(await s.rightHand.move({ topic: "abc", place: "alpha" }, SESSION), { result: "invalid_topic", message: TOPIC_MOVE_BAD_TOPIC });
  assert.equal(s.proposeCalls.length, 0);
});

test("right hand move: セッションのチャンネルからほかの話題を指すと not_available で、propose しない", async (t) => {
  const s = setup(t);
  addTopic(s, "700");
  addTopic(s, "701");
  assert.deepEqual(await s.rightHand.move({ topic: "701", place: "alpha" }, SESSION), { result: "not_available", message: TOPIC_MOVE_OWN_ONLY });
  assert.equal(s.proposeCalls.length, 0);
});

test("right hand move: #tasks・話題でないチャンネルから呼ぶと not_available。proposals が無ければどこからでも not_available", async (t) => {
  const s = setup(t);
  addTopic(s, "700");
  const tasks: RunContext = { guildId: GUILD, channelId: "tasks-1", kind: "tasks" };
  assert.deepEqual(await s.rightHand.move({ topic: "700", place: "alpha" }, tasks), { result: "not_available", message: TOPIC_MOVE_NOT_AVAILABLE });
  const other: RunContext = { guildId: GUILD, channelId: "999", kind: "session" };
  assert.deepEqual(await s.rightHand.move({ place: "alpha" }, other), { result: "not_available", message: TOPIC_MOVE_NOT_AVAILABLE });
  assert.equal(s.proposeCalls.length, 0);

  const off = setup(t, { proposals: false });
  addTopic(off, "700");
  assert.deepEqual(await off.rightHand.move({ topic: "700", place: "alpha" }, INBOX), { result: "not_available", message: TOPIC_MOVE_NOT_AVAILABLE });
});

test("right hand move: place が General（大文字小文字を問わない）なら general。プロジェクトの名前は大文字小文字が違っても 1 つに決まればその名前", async (t) => {
  const s = setup(t);
  addTopic(s, "700");
  for (const place of ["General", "general", "GENERAL"]) await s.rightHand.move({ topic: "700", place }, INBOX);
  await s.rightHand.move({ topic: "700", place: "ALPHA" }, INBOX);
  await s.rightHand.move({ topic: "700", place: "Beta" }, INBOX);
  assert.deepEqual(
    s.proposeCalls.map((call) => call.place),
    [{ kind: "general" }, { kind: "general" }, { kind: "general" }, { kind: "project", name: "alpha" }, { kind: "project", name: "Beta" }],
  );
});

test("right hand move: place の前後の空白は除いて読む（\" alpha \" は alpha と同じ場所）", async (t) => {
  const s = setup(t);
  addTopic(s, "700");
  assert.equal((await s.rightHand.move({ topic: "700", place: " alpha " }, INBOX)).result, "proposed");
  assert.deepEqual(s.proposeCalls, [{ guildId: GUILD, channelId: "700", place: { kind: "project", name: "alpha" } }]);
});

test("right hand move: place が一覧に無い名前・2 つに当たる名前・プロジェクトのセッションを使えないときは invalid_place で、General に落とさない", async (t) => {
  const s = setup(t);
  addTopic(s, "700");
  for (const place of ["gamma", "BETA", "../alpha", "General の外"]) {
    assert.deepEqual(await s.rightHand.move({ topic: "700", place }, INBOX), { result: "invalid_place", message: TOPIC_MOVE_BAD_PLACE }, place);
  }
  s.ready.value = false;
  assert.deepEqual(await s.rightHand.move({ topic: "700", place: "alpha" }, INBOX), { result: "invalid_place", message: TOPIC_MOVE_BAD_PLACE });
  const off = setup(t, { cc: false });
  addTopic(off, "700");
  assert.deepEqual(await off.rightHand.move({ topic: "700", place: "alpha" }, INBOX), { result: "invalid_place", message: TOPIC_MOVE_BAD_PLACE });
  assert.equal(s.proposeCalls.length, 0);
  assert.equal(off.proposeCalls.length, 0);
});

test("right hand move: 別のサーバーの話題・無い ID は refused（not_session）で、propose しない", async (t) => {
  const s = setup(t);
  addTopic(s, "800", "guild-2");
  for (const topic of ["800", "12345"]) {
    assert.deepEqual(
      await s.rightHand.move({ topic, place: "alpha" }, INBOX),
      { result: "refused", reason: "not_session", message: moveRefusalText("not_session") },
      topic,
    );
  }
  assert.equal(s.proposeCalls.length, 0);
});

test("right hand move: propose の already_proposed・refused はそのまま文を付けて返す", async (t) => {
  const s = setup(t);
  addTopic(s, "700");
  s.proposeNext.push({ result: "already_proposed", channelId: "700" }, { result: "refused", reason: "same_place" });
  assert.deepEqual(await s.rightHand.move({ topic: "700", place: "alpha" }, INBOX), {
    result: "already_proposed",
    channelId: "700",
    message: TOPIC_MOVE_ALREADY,
  });
  assert.deepEqual(await s.rightHand.move({ topic: "700", place: "alpha" }, INBOX), {
    result: "refused",
    reason: "same_place",
    message: moveRefusalText("same_place"),
  });
});

test("right hand move: propose が例外を出すと not_available で、log に ID・場所の名前が出ない", async (t) => {
  const s = setup(t);
  addTopic(s, "700");
  s.proposeNext.push(new TypeError("sendMessage failed 700 alpha"));
  assert.deepEqual(await s.rightHand.move({ topic: "700", place: "alpha" }, INBOX), { result: "not_available", message: TOPIC_MOVE_POST_FAILED });
  assert.ok(s.logs.length > 0);
  for (const line of s.logs) {
    assert.equal(line.includes("700"), false, line);
    assert.equal(line.includes("alpha"), false, line);
    assert.equal(line.includes("inbox-1"), false, line);
  }
});
