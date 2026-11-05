// CC12: Claude Code のチャンネルへの許可の要求・判断待ち・端末の指示の写し（docs/plan/claude-code-channels.md §3.5）。
// Q4: チャンネルが無ければ知らせのために作り（ensureFor）、#system には出さない（docs/plan/claude-code-questions.md §5）
import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { createCcComponent, type CcPermissionButtons } from "../src/app/commands/cc.ts";
import type { AgentEntry, AgentsResult } from "../src/cc/agents.ts";
import {
  CC_CHANNEL_WAIT_OVERFLOW_TEXT,
  CC_PROMPT_MIRROR_LABEL,
  CC_PROMPT_MIRROR_WINDOW_MS,
  CcChannelPosts,
  ccPromptMirrorTexts,
  promptKey,
} from "../src/cc/channel-posts.ts";
import { ccEndedHandler, type CcOpenResult } from "../src/cc/channels.ts";
import { CC_WAIT_CHECK_MS, CC_WAIT_NOTIFY_LIMIT, CC_WAIT_NOTIFY_MS, CcWaitBudget } from "../src/cc/notice-text.ts";
import { type CcHookEvent, parseHookEvent } from "../src/cc/hook-server.ts";
import { CcPermissionHold, decisionBody } from "../src/cc/permission-hold.ts";
import { CcQuestionFlow } from "../src/cc/question-flow.ts";
import { CcRegistry, type CcTimers } from "../src/cc/registry.ts";
import type { Interaction, OutgoingMessage } from "../src/discord/gateway.ts";
import { type CcChannelOrigin, CcChannelStore } from "../src/store/cc-channels.ts";
import { CcPermissionStore } from "../src/store/cc-permissions.ts";
import { CcSendStore } from "../src/store/cc-sends.ts";
import { CcSessionStore } from "../src/store/cc-sessions.ts";
import { GuildSettingsStore } from "../src/store/guild-settings.ts";
import { HistoryStore } from "../src/store/history.ts";
import { tempDb } from "./helpers/db.ts";
import { FakeGateway } from "./helpers/gateway.ts";
import { FakeResponder } from "./helpers/responder.ts";

const BASE = Date.parse("2026-11-01T00:00:00.000Z");
const GUILD = "guild-1";
const SYSTEM = "system-1";
const CHANNEL = "cc-channel-1";
const OWNER = "owner-1";
const S1 = "11111111-1111-4111-8111-111111111111";
const S2 = "22222222-2222-4222-8222-222222222222";
const HOME = "/home/owner";
const WORKSPACE = "/home/owner/workspace";
const SECRET_NAME = "secret-name";
const SECRET_CWD = "/home/owner/workspace/secret-dir";
const SECRET_COMMAND = "rm -rf secret-dir";
const SECRET_PROMPT = "secret-prompt";
const BRIDGE = "session_01ABCDEF";
const RC_ROW = [{ kind: "links", links: [{ label: "RC で開く", url: `https://claude.ai/code/${BRIDGE}` }] }];

function agent(sessionId: string, overrides: Partial<AgentEntry> = {}): AgentEntry {
  return {
    pid: sessionId === S1 ? 101 : 102,
    sessionId,
    cwd: SECRET_CWD,
    name: SECRET_NAME,
    kind: "interactive",
    startedAt: BASE - 3_600_000,
    status: "waiting",
    waitingFor: "permission prompt",
    ...overrides,
  };
}

function fakeTimers(): CcTimers & { entries: Array<{ fn: () => void; ms: number; cancelled: boolean }> } {
  const entries: Array<{ fn: () => void; ms: number; cancelled: boolean }> = [];
  return {
    entries,
    after: (fn, ms) => {
      const entry = { fn, ms, cancelled: false };
      entries.push(entry);
      return () => {
        entry.cancelled = true;
      };
    },
  };
}

/** 保留中の偽の予約を動かす */
function fire(timers: ReturnType<typeof fakeTimers>, ms: number): void {
  const entry = timers.entries.filter((candidate) => !candidate.cancelled && candidate.ms === ms).at(-1);
  assert.ok(entry, "予約が無い");
  entry.cancelled = true;
  entry.fn();
}

/**
 * main と同じ配線: 許可の要求の受け手は channelPosts、ボタンも channelPosts から。チャンネルの無いセッションの知らせは ensureChannel（偽。
 * cc_channels に cc-made-<n> を作る。ensure.fails で not_set_up）で作る（notify: false は SELF_AGENT_CC_NOTIFY=0 で作らない）。
 * S1 にはチャンネル（CHANNEL）がある（channel: false で無し）
 */
async function setup(t: TestContext, opts: { agents?: AgentEntry[]; notify?: boolean; channel?: boolean } = {}) {
  const db = tempDb(t);
  const clock = { now: BASE };
  const now = (): Date => new Date(clock.now);
  const sessions = new CcSessionStore(db, now);
  const store = new CcPermissionStore(db, now);
  const channels = new CcChannelStore(db, now);
  const sends = new CcSendStore(db, now);
  const guildSettings = new GuildSettingsStore(db, now);
  const history = new HistoryStore(db, now);
  guildSettings.setChannel(GUILD, "systemChannelId", SYSTEM);
  if (opts.channel !== false) channels.create({ channelId: CHANNEL, guildId: GUILD, sessionId: S1, name: "cc-secret-name", cwd: SECRET_CWD, origin: "web" });
  const logs: string[] = [];
  const log = (line: string): void => {
    logs.push(line);
  };
  let next: AgentsResult = { ok: true, agents: opts.agents ?? [agent(S1), agent(S2)], dropped: 0 };
  const holdTimers = fakeTimers();
  let registry!: CcRegistry;
  const hold = new CcPermissionHold({
    cfg: { ccPermissionHoldSec: 300, ccQuestionHoldSec: 900 },
    store,
    known: (sessionId) => registry.knows(sessionId),
    now,
    timers: holdTimers,
    log,
  });
  let posts!: CcChannelPosts;
  registry = new CcRegistry({
    cfg: { ccPollSec: 10 },
    agents: { list: async () => next },
    dirs: {
      sessionFile: (_pid, sessionId) => (sessionId === S1 ? { bridgeSessionId: BRIDGE, tmux: undefined } : undefined),
      transcriptMtime: () => undefined,
    },
    store: sessions,
    now,
    timers: fakeTimers(),
    permissions: hold,
    ended: ccEndedHandler({ channels: () => undefined, replier: () => undefined }),
    onEvent: (event) => posts.onEvent(event),
    log,
  });
  await registry.tick();
  const gateway = new FakeGateway({ allow: ["sendMessage", "editMessage"] });
  const waitBudget = new CcWaitBudget();
  const postsTimers = fakeTimers();
  /** 知らせのためのチャンネルの作成（cc/channels.ts の ensureFor の代わり） */
  const ensure = { calls: [] as Array<{ sessionId: string; origin: CcChannelOrigin }>, fails: false, made: 0 };
  posts = new CcChannelPosts({
    cfg: { ownerUserId: OWNER, workspaceDir: WORKSPACE, ccPermissionHoldSec: 300, ccQuestionHoldSec: 900, ccNotify: opts.notify !== false },
    channels,
    ensureChannel: () => ({
      ensureFor: async (sessionId: string, origin: CcChannelOrigin): Promise<CcOpenResult> => {
        ensure.calls.push({ sessionId, origin });
        if (ensure.fails) return { ok: false, reason: "not_set_up" };
        const existing = channels.anyFor(sessionId);
        if (existing !== undefined) return { ok: false, reason: "exists", channelId: existing.channelId, guildId: existing.guildId };
        const channelId = `cc-made-${++ensure.made}`;
        channels.create({ channelId, guildId: GUILD, sessionId, name: channelId, cwd: SECRET_CWD, origin });
        return { ok: true, channelId, guildId: GUILD };
      },
    }),
    gateway,
    permissions: store,
    sessions,
    sends,
    registry,
    waitBudget,
    home: HOME,
    history,
    now,
    timers: postsTimers,
    log,
  });
  hold.listen(posts);
  posts.start();
  const answered: Array<{ id: number; guildId: string | null }> = [];
  const buttons: CcPermissionButtons = {
    answer: (id, decision) => hold.answer(id, decision, "discord"),
    resolvedMessage: (id) => posts.resolvedMessage(id),
    answered: (id, guildId) => {
      answered.push({ id, guildId });
    },
    questions: {
      flow: new CcQuestionFlow(),
      pendingQuestion: (id) => posts.pendingQuestion(id),
      answerQuestion: (id, requestHash, picks) => hold.answerQuestion(id, requestHash, picks, "discord"),
      stepMessage: (id, picks) => posts.questionStepMessage(id, picks),
    },
  };
  const component = createCcComponent({ ccPermissionButtons: () => buttons, gateway, log });
  const idle = async (): Promise<void> => {
    await posts.idle();
  };

  const ask = async (sessionId: string, command = SECRET_COMMAND) => {
    const event = parseHookEvent(
      { hook_event_name: "PermissionRequest", session_id: sessionId, cwd: SECRET_CWD, permission_mode: "default", tool_name: "Bash", tool_input: { command } },
      now(),
      { workspaceDir: WORKSPACE, home: HOME },
    )!;
    registry.receive(event);
    const reply = hold.request(event, new AbortController().signal);
    await idle();
    return { reply, id: store.pendingFor(sessionId)?.id ?? Number(db.prepare("SELECT MAX(id) AS id FROM cc_permissions").get()?.id) };
  };
  /** AskUserQuestion の PermissionRequest（受け口と同じく読む） */
  const askQuestion = async (sessionId: string, toolInput: Record<string, unknown>) => {
    const event = parseHookEvent(
      { hook_event_name: "PermissionRequest", session_id: sessionId, cwd: SECRET_CWD, permission_mode: "default", tool_name: "AskUserQuestion", tool_input: toolInput },
      now(),
      { workspaceDir: WORKSPACE, home: HOME },
    )!;
    registry.receive(event);
    const reply = hold.request(event, new AbortController().signal);
    await idle();
    return { reply, id: store.pendingFor(sessionId)?.id ?? Number(db.prepare("SELECT MAX(id) AS id FROM cc_permissions").get()?.id) };
  };
  /** ボタン・セレクト・モーダルの操作（押されたメッセージは message-1） */
  const interact = async (
    interaction:
      | { kind: "button"; customId: string }
      | { kind: "select"; customId: string; values: string[] }
      | { kind: "modal"; customId: string; fields: Record<string, string> },
    channelId = CHANNEL,
  ): Promise<FakeResponder> => {
    const responder = new FakeResponder();
    const full = { ...interaction, guildId: GUILD, channelId, userId: OWNER, createdAt: now(), messageId: "message-1" } as Interaction;
    await component.handle(full as Exclude<Interaction, { kind: "command" }>, responder);
    return responder;
  };
  /** hook の本文を受け口と同じく読んで registry と保留に渡す */
  const hookBody = async (body: Record<string, unknown>): Promise<void> => {
    const event = parseHookEvent(body, now())!;
    registry.receive(event);
    hold.observe(event);
    await idle();
  };
  const hook = async (sessionId: string, event: CcHookEvent["event"], extra: Partial<CcHookEvent> = {}): Promise<void> => {
    const parsed: CcHookEvent = { event, sessionId, receivedAt: now(), ...extra };
    registry.receive(parsed);
    hold.observe(parsed);
    await idle();
  };
  const press = async (customId: string, channelId = CHANNEL): Promise<FakeResponder> => {
    const responder = new FakeResponder();
    const interaction = { kind: "button", customId, guildId: GUILD, channelId, userId: OWNER, messageId: "message-1" } as Interaction;
    await component.handle(interaction as Extract<Interaction, { kind: "button" }>, responder);
    return responder;
  };
  const tickWaiting = async (): Promise<void> => {
    fire(postsTimers, CC_WAIT_CHECK_MS);
    await idle();
  };
  return {
    db,
    clock,
    history,
    store,
    sessions,
    channels,
    sends,
    hold,
    registry,
    gateway,
    posts,
    ensure,
    waitBudget,
    logs,
    holdTimers,
    answered,
    idle,
    ask,
    askQuestion,
    interact,
    hook,
    hookBody,
    press,
    tickWaiting,
    setAgents: async (agents: AgentEntry[]) => {
      next = { ok: true, agents, dropped: 0 };
      await registry.tick();
    },
  };
}

function buttonIds(message: OutgoingMessage): string[][] {
  return (message.components ?? []).map((row) =>
    row.kind === "buttons" ? row.buttons.map((button) => button.customId) : row.kind === "links" ? row.links.map((link) => link.url) : [],
  );
}

function assertNoSecrets(logs: readonly string[]): void {
  for (const line of logs) {
    for (const secret of [SECRET_NAME, "secret-dir", SECRET_COMMAND, SECRET_PROMPT, CHANNEL, S1, S2]) assert.ok(!line.includes(secret), line);
  }
}

test("CC12: チャンネルのあるセッションの許可の要求はチャンネルに 1 通（#system には出ない）。message_channel_id はチャンネル", async (t) => {
  const s = await setup(t);
  const asked = await s.ask(S1);
  assert.equal(s.gateway.posts.length, 1);
  const post = s.gateway.posts[0]!;
  assert.equal(post.channelId, CHANNEL);
  assert.equal(post.message.mentionUserId, OWNER);
  assert.equal(post.message.suppressEmbeds, true);
  assert.deepEqual(buttonIds(post.message), [[`cc:perm:allow:${asked.id}`, `cc:perm:deny:${asked.id}`], [`https://claude.ai/code/${BRIDGE}`]]);
  assert.ok(post.message.text.startsWith("Claude Code が許可を待っています: secret\\-name（secret\\-dir・default）"), post.message.text);
  const row = s.store.get(asked.id)!;
  assert.equal(row.messageChannelId, CHANNEL);
  assert.equal(row.messageId, post.messageId);
  assert.ok(s.gateway.posts.every((p) => p.channelId !== SYSTEM));
  assertNoSecrets(s.logs);
});

test("CC12: チャンネルの [許可] は CC5c と同じ応答と書き換え。2 回目は古い。押した後に answered が呼ばれる", async (t) => {
  const s = await setup(t);
  const asked = await s.ask(S1);
  const responder = await s.press(`cc:perm:allow:${asked.id}`);
  assert.equal(await asked.reply, decisionBody("allow"));
  assert.equal(s.store.get(asked.id)?.via, "discord");
  const update = responder.calls.find((call) => call.method === "update");
  assert.ok(update?.method === "update");
  assert.deepEqual(update.message.components, RC_ROW);
  assert.ok(update.message.text.endsWith("\n許可（Discord）"), update.message.text);
  await s.idle();
  // Discord で押したものは応答で書き換えたので、ここでは書き換えない
  assert.equal(s.gateway.edits.length, 0);
  assert.deepEqual(s.answered, [{ id: asked.id, guildId: GUILD }]);
  const again = await s.press(`cc:perm:deny:${asked.id}`);
  assert.deepEqual(again.replies, [{ text: "この操作は古くなっています", ephemeral: true }]);
});

test("CC12: Web で押された・他で答えられた・時間切れ・停止は、チャンネルの 1 通を書き換える（#system には出ない）", async (t) => {
  const s = await setup(t);
  const web = await s.ask(S1);
  s.hold.answer(web.id, "allow", "web");
  await s.idle();
  assert.equal(s.gateway.edits.at(-1)?.channelId, CHANNEL);
  assert.ok(s.gateway.edits.at(-1)!.message.text.endsWith("\n許可（Web）"));

  const elsewhere = await s.ask(S1, "ls");
  await s.hook(S1, "Stop");
  assert.equal(s.store.get(elsewhere.id)?.state, "answered_elsewhere");
  assert.ok(s.gateway.edits.at(-1)!.message.text.endsWith("\n端末か RC で答えられました"));

  const expired = await s.ask(S1, "pwd");
  s.holdTimers.entries.at(-1)!.fn();
  await s.idle();
  assert.equal(await expired.reply, undefined);
  assert.ok(s.gateway.edits.at(-1)!.message.text.endsWith(`\n時間切れ。端末か RC で答えてください <https://claude.ai/code/${BRIDGE}>`));

  const released = await s.ask(S1, "whoami");
  s.hold.stop();
  s.posts.stop();
  await s.idle();
  assert.equal(s.store.get(released.id)?.state, "released");
  assert.ok(s.gateway.edits.at(-1)!.message.text.includes("self-agent が止まるため受け付けをやめました"));
  assert.ok([...s.gateway.posts, ...s.gateway.edits].every((p) => p.channelId === CHANNEL));
  assert.equal(s.gateway.edits.length, 4);
});

test("Q4: チャンネルの無いセッションの許可の要求は ensureFor（origin permission）で作ってそこに 1 通（#system には出ない）。終わったらそこを書き換える", async (t) => {
  const s = await setup(t, { channel: false });
  const first = await s.ask(S1);
  assert.deepEqual(s.ensure.calls, [{ sessionId: S1, origin: "permission" }]);
  assert.equal(s.gateway.posts.length, 1);
  assert.equal(s.gateway.posts[0]!.channelId, "cc-made-1");
  assert.equal(s.gateway.posts[0]!.message.mentionUserId, OWNER);
  assert.deepEqual(buttonIds(s.gateway.posts[0]!.message)[0], [`cc:perm:allow:${first.id}`, `cc:perm:deny:${first.id}`]);
  assert.equal(s.store.get(first.id)?.messageChannelId, "cc-made-1");
  s.hold.answer(first.id, "allow", "web");
  await s.idle();
  assert.equal(s.gateway.edits.at(-1)?.channelId, "cc-made-1");
  // 次の要求はできたチャンネルにそのまま（作り直さない）
  await s.ask(S1, "ls");
  assert.equal(s.ensure.calls.length, 1);
  assert.equal(s.gateway.posts[1]!.channelId, "cc-made-1");
  // 他のセッションも同じく作る
  await s.ask(S2);
  assert.deepEqual(s.ensure.calls.at(-1), { sessionId: S2, origin: "permission" });
  assert.equal(s.gateway.posts[2]!.channelId, "cc-made-2");
  assert.ok([...s.gateway.posts, ...s.gateway.edits].every((p) => p.channelId !== SYSTEM));
  assertNoSecrets(s.logs);
});

test("Q4: チャンネルを作れなければ log だけ（#system に出ない）。保留は続き、Web で答えられる", async (t) => {
  const s = await setup(t, { channel: false });
  s.ensure.fails = true;
  const asked = await s.ask(S1);
  assert.equal(s.gateway.posts.length, 0);
  assert.equal(s.store.get(asked.id)?.state, "pending");
  assert.ok(s.logs.includes(`Claude Code: 許可の要求（#${asked.id}）を出すチャンネルがありません`));
  assert.deepEqual(s.hold.answer(asked.id, "allow", "web"), { ok: true, state: "allowed" });
  await s.idle();
  assert.equal(s.gateway.edits.length, 0);
  assertNoSecrets(s.logs);
});

test("CC12・Q4: SELF_AGENT_CC_NOTIFY=0 ではチャンネルを作らないが、あるチャンネルには出て、ボタンが効く（#system には何も出ない）", async (t) => {
  const s = await setup(t, { notify: false });
  const asked = await s.ask(S1);
  assert.equal(s.gateway.posts.length, 1);
  assert.equal(s.gateway.posts[0]!.channelId, CHANNEL);
  const responder = await s.press(`cc:perm:deny:${asked.id}`);
  assert.ok(responder.calls.some((call) => call.method === "update"));
  assert.equal(s.store.get(asked.id)?.state, "denied");
  // チャンネルの無いセッションの要求は作らず、どこにも出ない
  await s.ask(S2);
  assert.equal(s.gateway.posts.length, 1);
  assert.deepEqual(s.ensure.calls, []);
  // 判断待ち・写しもチャンネルには出る
  await s.hook(S1, "UserPromptSubmit", { prompt: "端末から", promptChars: 4 });
  assert.equal(s.gateway.posts.length, 2);
  assert.equal(s.gateway.posts[1]!.message.text, `${CC_PROMPT_MIRROR_LABEL}\n端末から`);
});

test("Q4: permission-hold は足した受け手の全部に held・resolved を渡す。受け手が投げても保留は続く（log だけ）", async (t) => {
  const db = tempDb(t);
  const store = new CcPermissionStore(db, () => new Date(BASE));
  const logs: string[] = [];
  const hold = new CcPermissionHold({
    cfg: { ccPermissionHoldSec: 300, ccQuestionHoldSec: 900 },
    store,
    known: () => true,
    now: () => new Date(BASE),
    timers: fakeTimers(),
    log: (line) => logs.push(line),
  });
  const calls: string[] = [];
  hold.listen({
    held: () => {
      throw new Error("broken");
    },
    resolved: (row) => calls.push(`broken:resolved:${row.id}`),
  });
  hold.listen({ held: (row) => calls.push(`posts:held:${row.id}`), resolved: (row) => calls.push(`posts:resolved:${row.id}`) });
  const event = parseHookEvent({ hook_event_name: "PermissionRequest", session_id: S1, tool_name: "Bash", tool_input: { command: "ls" } }, new Date(BASE))!;
  void hold.request(event, new AbortController().signal);
  const id = store.pendingFor(S1)!.id;
  assert.equal(store.get(id)?.state, "pending");
  hold.answer(id, "allow", "web");
  assert.deepEqual(calls, [`posts:held:${id}`, `broken:resolved:${id}`, `posts:resolved:${id}`]);
  assert.ok(logs.some((line) => line.startsWith("Claude Code: 許可の要求の知らせに失敗しました（Error）")));
});

test("CC12・Q4: 判断待ちはチャンネルがあればそこ、無ければ ensureFor（origin waiting）で作ってそこ（#system には出ない）", async (t) => {
  const busy = { status: "busy", waitingFor: undefined } as const;
  const s = await setup(t, { agents: [agent(S1, busy), agent(S2, busy)] });
  await s.hook(S1, "Notification", { notificationType: "agent_needs_input" });
  await s.hook(S2, "Notification", { notificationType: "agent_needs_input" });
  await s.setAgents([agent(S1, { status: "waiting" }), agent(S2, { status: "waiting" })]);
  s.clock.now += CC_WAIT_NOTIFY_MS;
  await s.tickWaiting();
  assert.deepEqual(s.ensure.calls, [{ sessionId: S2, origin: "waiting" }]);
  assert.deepEqual(
    s.gateway.posts.map((post) => post.channelId).sort(),
    [CHANNEL, "cc-made-1"].sort(),
  );
  const inChannel = s.gateway.posts.find((post) => post.channelId === CHANNEL)!;
  assert.ok(inChannel.message.text.startsWith("Claude Code が判断を待っています（1 分以上）: secret\\-name（secret\\-dir）"), inChannel.message.text);
  assert.equal(inChannel.message.mentionUserId, OWNER);
  // 同じ待ちには 2 回目を出さない
  s.clock.now += 60_000;
  await s.tickWaiting();
  assert.equal(s.gateway.posts.length, 2);
  assertNoSecrets(s.logs);
});

test("Q4: SELF_AGENT_CC_NOTIFY=0 では判断待ちのためにチャンネルを作らない（あるチャンネルには出す）", async (t) => {
  const busy = { status: "busy", waitingFor: undefined } as const;
  const s = await setup(t, { agents: [agent(S1, busy), agent(S2, busy)], notify: false });
  await s.hook(S1, "Notification", { notificationType: "agent_needs_input" });
  await s.hook(S2, "Notification", { notificationType: "agent_needs_input" });
  await s.setAgents([agent(S1, { status: "waiting" }), agent(S2, { status: "waiting" })]);
  s.clock.now += CC_WAIT_NOTIFY_MS;
  await s.tickWaiting();
  assert.deepEqual(s.ensure.calls, []);
  assert.deepEqual(s.gateway.posts.map((post) => post.channelId), [CHANNEL]);
});

test("CC12: 判断待ちの上限は 1 時間に CC_WAIT_NOTIFY_LIMIT 件（CcWaitBudget）", () => {
  const budget = new CcWaitBudget();
  for (let i = 0; i < CC_WAIT_NOTIFY_LIMIT; i++) assert.equal(budget.take(BASE + i), true);
  assert.equal(budget.take(BASE + 100), false);
  // 1 時間たてば戻る
  assert.equal(budget.take(BASE + 60 * 60_000 + 1), true);
});

test("CC12: 判断待ちの上限を使い切っていれば、チャンネルには出さない（log だけ）。チャンネルの無いセッションのためには作らない", async (t) => {
  const busy = { status: "busy", waitingFor: undefined } as const;
  const s = await setup(t, { agents: [agent(S1, busy), agent(S2, busy)] });
  // ほかの判断待ちで使い切った（同じ budget）
  for (let i = 0; i < CC_WAIT_NOTIFY_LIMIT; i++) s.waitBudget.take(BASE);
  await s.hook(S1, "Notification", { notificationType: "agent_needs_input" });
  await s.hook(S2, "Notification", { notificationType: "agent_needs_input" });
  await s.setAgents([agent(S1, { status: "waiting" }), agent(S2, { status: "waiting" })]);
  s.clock.now += CC_WAIT_NOTIFY_MS;
  await s.tickWaiting();
  assert.deepEqual(s.ensure.calls, []);
  // 判断待ちの 1 通は出さず、鳴らさない短い 1 行だけ
  assert.equal(s.gateway.posts.length, 1);
  assert.equal(s.gateway.posts[0]!.channelId, CHANNEL);
  assert.equal(s.gateway.posts[0]!.message.text, CC_CHANNEL_WAIT_OVERFLOW_TEXT);
  assert.equal(s.gateway.posts[0]!.message.mentionUserId, undefined);
  assert.ok(s.logs.some((line) => line.includes("上限のためチャンネルに出しませんでした（2 件）")));
  // 次の待ちも上限の内なら、1 時間はその 1 行を出し直さない
  await s.hook(S1, "Stop");
  await s.hook(S1, "Notification", { notificationType: "agent_needs_input" });
  s.clock.now += CC_WAIT_NOTIFY_MS;
  await s.tickWaiting();
  assert.equal(s.gateway.posts.length, 1);
});

test("Q4: チャンネルへの許可の 1 通の投稿に失敗したら log だけ（#system に回さない）。保留は続き、Web で答えられる", async (t) => {
  const s = await setup(t);
  s.gateway.beforeSendMessage = () => {
    throw new Error("discord down");
  };
  const asked = await s.ask(S1);
  assert.equal(s.gateway.posts.length, 0);
  assert.equal(s.store.get(asked.id)?.messageChannelId, null);
  assert.ok(s.logs.some((line) => line.startsWith(`Claude Code: 許可の要求（#${asked.id}）をチャンネルに出せませんでした`)));
  assert.equal(s.store.get(asked.id)?.state, "pending");
  assert.deepEqual(s.hold.answer(asked.id, "allow", "web"), { ok: true, state: "allowed" });
  assertNoSecrets(s.logs);
});

test("CC12: 端末・RC からの UserPromptSubmit は「（端末か RC から）」で写す。Markdown・メンションは無効、DB は 200 字", async (t) => {
  const s = await setup(t);
  await s.hookBody({ hook_event_name: "UserPromptSubmit", session_id: S1, prompt: `@everyone **${SECRET_PROMPT}** [x](https://e.example)\n2 行目` });
  assert.equal(s.gateway.posts.length, 1);
  const post = s.gateway.posts[0]!;
  assert.equal(post.channelId, CHANNEL);
  assert.equal(post.message.text, `${CC_PROMPT_MIRROR_LABEL}\n\\@everyone \\*\\*secret\\-prompt\\*\\* \\[x\\]\\(https\\://e.example\\)\n2 行目`);
  assert.equal(post.message.mentionUserId, undefined);
  assert.equal(post.message.suppressEmbeds, true);
  assert.equal(post.message.replyToId, undefined);
  assert.ok(s.logs.includes("Claude Code: 写しを出しました（端末か RC から）"));
  assertNoSecrets(s.logs);
  // 1,001 字は先頭 1,000 字と「（ほか 1 字）」。DB に残すのは 200 字
  await s.hookBody({ hook_event_name: "UserPromptSubmit", session_id: S1, prompt: "あ".repeat(1001) });
  const texts = s.gateway.posts.slice(1).map((p) => p.message.text);
  assert.equal(texts.length, 1);
  assert.equal(texts[0], `${CC_PROMPT_MIRROR_LABEL}\n${"あ".repeat(1000)}\n（ほか 1 字）`);
  assert.equal(s.sessions.get(S1)?.lastPromptText, "あ".repeat(200));
});

test("CC12: self-agent が 30 秒以内に届けた本文（改行を空白にした形・空白の違い）は写さない。31 秒後・違う本文は写す", async (t) => {
  const s = await setup(t);
  const send = s.sends.add({ sessionId: S1, text: "1 行目\n  2 行目", origin: "web", state: "queued" });
  s.sends.transition(send.id, ["queued"], "delivering");
  // 貼っている途中（delivering）に来た UserPromptSubmit（singleLine で改行が空白になった形）
  await s.hookBody({ hook_event_name: "UserPromptSubmit", session_id: S1, prompt: "1 行目   2 行目" });
  assert.equal(s.gateway.posts.length, 0);
  s.sends.transition(send.id, ["delivering"], "delivered");
  // 届けた後でも 30 秒以内は同じ（包みを外した本文の前後の空白・改行の違いも同じ）
  s.clock.now += CC_PROMPT_MIRROR_WINDOW_MS;
  await s.hookBody({ hook_event_name: "UserPromptSubmit", session_id: S1, prompt: '\n<pasted_content id="1">1 行目\n  2 行目</pasted_content id="1">\n' });
  assert.equal(s.gateway.posts.length, 0);
  // 違う本文は写す
  await s.hookBody({ hook_event_name: "UserPromptSubmit", session_id: S1, prompt: "別の指示" });
  assert.equal(s.gateway.posts.length, 1);
  // 31 秒後は写す
  s.clock.now += 1_000;
  await s.hookBody({ hook_event_name: "UserPromptSubmit", session_id: S1, prompt: "1 行目 2 行目" });
  assert.equal(s.gateway.posts.length, 2);
  assert.equal(s.gateway.posts[1]!.message.text, `${CC_PROMPT_MIRROR_LABEL}\n1 行目 2 行目`);
});

test("CC12: 先頭 200 字が同じなら届けたものとみなす（201 字目から違っても写さない）", async (t) => {
  const s = await setup(t);
  const head = "x".repeat(200);
  const send = s.sends.add({ sessionId: S1, text: `${head}送った`, origin: "discord", state: "queued", channelId: CHANNEL, messageId: "m1" });
  s.sends.transition(send.id, ["queued"], "delivering");
  s.sends.transition(send.id, ["delivering"], "delivered");
  await s.hookBody({ hook_event_name: "UserPromptSubmit", session_id: S1, prompt: `${head}違う` });
  assert.equal(s.gateway.posts.length, 0);
  // 比べる形: 空白（改行を含む）の連なりを 1 つにして前後を除く
  assert.equal(promptKey(" a\n\n b "), "a b");
  // 別のセッション（S2）に同じ本文が来ても、S2 にはチャンネルが無いので写さない
  await s.hookBody({ hook_event_name: "UserPromptSubmit", session_id: S2, prompt: `${head}送った` });
  assert.equal(s.gateway.posts.length, 0);
});

test("CC12: 届いたか確かめられなかった（unconfirmed）送信の本文も、30 秒以内なら写さない", async (t) => {
  const s = await setup(t);
  const send = s.sends.add({ sessionId: S1, text: "確かめられなかった", origin: "web", state: "queued" });
  s.sends.transition(send.id, ["queued"], "delivering");
  s.sends.transition(send.id, ["delivering"], "unconfirmed");
  s.clock.now += 10_000;
  await s.hookBody({ hook_event_name: "UserPromptSubmit", session_id: S1, prompt: "確かめられなかった" });
  assert.equal(s.gateway.posts.length, 0);
});

test("CC12: チャンネルの無いセッションの指示は写さない（写しだけではチャンネルを作らない）", async (t) => {
  const s = await setup(t, { channel: false });
  await s.hookBody({ hook_event_name: "UserPromptSubmit", session_id: S1, prompt: "端末から" });
  await s.hookBody({ hook_event_name: "UserPromptSubmit", session_id: S2, prompt: "端末から" });
  assert.equal(s.gateway.posts.length, 0);
  assert.equal(s.channels.anyFor(S1), undefined);
});

test("ccPromptMirrorTexts: 2,000 字を超えたら字の境目で 2 通目に（エスケープを切らない）。「ほか n 字」が入らなければ次の通", () => {
  const texts = ccPromptMirrorTexts("*".repeat(1000), 1005);
  assert.ok(texts.every((text) => [...text].length <= 2000));
  assert.equal(texts.length, 2);
  assert.ok(!texts[0]!.endsWith("\\") || texts[0]!.endsWith("\\*"));
  assert.equal(texts.join("").replaceAll("\\*", "").replace(`${CC_PROMPT_MIRROR_LABEL}\n`, "").replace("\n（ほか 5 字）", ""), "");
  assert.ok(texts.at(-1)!.endsWith("（ほか 5 字）"));
  // 改行以外の制御文字は空白
  assert.equal(ccPromptMirrorTexts("a\u0007b\nc", 5)[0], `${CC_PROMPT_MIRROR_LABEL}\na b\nc`);
});

test("CC12・Q4: 再起動の前に保留していた要求の 1 通を書き換える（Q4 より前に #system に出したものも）。Web の会話はチャンネルのものだけ", async (t) => {
  const s = await setup(t);
  const inChannel = await s.ask(S1);
  const inSystem = await s.ask(S2);
  // Q4 より前に #system に出した 1 通
  s.store.setMessage(inSystem.id, SYSTEM, "system-message-1");
  const next = new CcPermissionHold({ cfg: { ccPermissionHoldSec: 300, ccQuestionHoldSec: 900 }, store: s.store, known: () => true, now: () => new Date(s.clock.now), log: () => {} });
  const rows = next.recover();
  assert.equal(rows.length, 2);
  s.posts.rewriteRecovered(rows);
  await s.idle();
  assert.equal(s.gateway.edits.length, 2);
  const byId = new Map(s.gateway.edits.map((edit) => [edit.messageId, edit.channelId]));
  assert.equal(byId.get(s.store.get(inChannel.id)!.messageId!), CHANNEL);
  assert.equal(byId.get("system-message-1"), SYSTEM);
  // Web の会話にも結果（時間切れ）を書く（CC14。チャンネルに出したものだけ・1 回）
  s.posts.rewriteRecovered(rows);
  await s.idle();
  assert.deepEqual(
    s.history.list(CHANNEL, { limit: 10 }).map((row) => row.text),
    [`許可を待っています: Bash\n${SECRET_COMMAND}`, "許可の要求（Bash）: 時間切れ。端末か RC で答えてください"],
  );
  assert.equal(s.history.list(SYSTEM, { limit: 10 }).length, 0);
});

test("Q4: セッションが終わっても、チャンネルが無ければ何も出さない（#system の終了の知らせは無い）", async (t) => {
  const s = await setup(t, { channel: false });
  const handler = ccEndedHandler({ channels: () => ({ ended: () => false }), replier: () => undefined });
  s.sessions.recordStart(S1, { startedBy: "web", tmuxSession: "t", tmuxSessionId: "$1", paneId: "%1", trustPendingAt: null });
  handler(s.sessions.get(S1)!);
  await s.idle();
  assert.equal(s.gateway.posts.length, 0);
  assert.deepEqual(s.ensure.calls, []);
});

test("Web の会話（CC14）: チャンネルに出した許可の要求とその結果・判断待ちは notice、端末の指示の写しは owner（system）。文字のまま（エスケープしない）", async (t) => {
  const busy = { status: "busy", waitingFor: undefined } as const;
  const s = await setup(t, { agents: [agent(S1, busy), agent(S2, busy)] });
  await s.hook(S1, "Notification", { notificationType: "agent_needs_input" });
  await s.setAgents([agent(S1, { status: "waiting", waitingFor: "input" }), agent(S2, busy)]);
  s.clock.now += CC_WAIT_NOTIFY_MS;
  await s.tickWaiting();
  await s.setAgents([agent(S1, busy), agent(S2, busy)]);
  const asked = await s.ask(S1);
  s.hold.answer(asked.id, "deny", "web");
  await s.idle();
  // Discord で押したもの（resolved は応答で書き換える）も結果を書く
  const second = await s.ask(S1, "ls");
  await s.press(`cc:perm:allow:${second.id}`);
  await s.idle();
  await s.hookBody({ hook_event_name: "UserPromptSubmit", session_id: S1, prompt: "**太字** のまま" });
  const rows = s.history.list(CHANNEL, { limit: 20 });
  assert.deepEqual(
    rows.map((row) => [row.kind, row.source, row.text, row.guildId, row.persona]),
    [
      ["notice", "system", "判断を待っています: input", GUILD, "default"],
      ["notice", "system", `許可を待っています: Bash\n${SECRET_COMMAND}`, GUILD, "default"],
      ["notice", "system", "許可の要求（Bash）: 拒否（Web）", GUILD, "default"],
      ["notice", "system", "許可を待っています: Bash\nls", GUILD, "default"],
      ["notice", "system", "許可の要求（Bash）: 許可（Discord）", GUILD, "default"],
      ["owner", "system", `${CC_PROMPT_MIRROR_LABEL}\n**太字** のまま`, GUILD, "default"],
    ],
  );
  // ほかのセッションの要求（作ったチャンネル）は、そのチャンネルの会話に書く
  await s.ask(S2);
  assert.equal(s.history.list(CHANNEL, { limit: 20 }).length, rows.length);
  assert.equal(s.history.list("cc-made-1", { limit: 20 }).length, 1);
});

test("Web の会話（CC14）: 判断待ちはチャンネルに出せたときだけ history に書く", async (t) => {
  const busy = { status: "busy", waitingFor: undefined } as const;
  const s = await setup(t, { agents: [agent(S1, busy), agent(S2, busy)] });
  await s.hook(S1, "Notification", { notificationType: "agent_needs_input" });
  await s.setAgents([agent(S1, { status: "waiting", waitingFor: "input" }), agent(S2, busy)]);
  s.clock.now += CC_WAIT_NOTIFY_MS;
  s.gateway.beforeSendMessage = (channelId) => {
    if (channelId === CHANNEL) throw new Error("Missing Access");
  };
  await s.tickWaiting();
  assert.ok(s.logs.some((line) => line.includes("判断待ちをチャンネルに知らせられませんでした")));
  assert.equal(s.history.list(CHANNEL, { limit: 10 }).length, 0);
});

// ---- Q2: 質問（AskUserQuestion）に Discord の選択肢で答える（docs/plan/claude-code-questions.md §3） ----

const Q_COLOR = { question: "色は？", header: "Color", options: [{ label: "red", description: "赤" }, { label: "blue" }], multiSelect: false };
const Q_TAGS = {
  question: "どれを付けますか？",
  header: "Tags",
  options: [{ label: "a" }, { label: "b" }, { label: "c" }],
  multiSelect: true,
};

function decisionOf(body: string | undefined): Record<string, unknown> {
  assert.ok(body !== undefined);
  return (JSON.parse(body) as { hookSpecificOutput: { decision: Record<string, unknown> } }).hookSpecificOutput.decision;
}

function updateOf(responder: FakeResponder): OutgoingMessage {
  const update = responder.calls.find((call) => call.method === "update");
  assert.ok(update?.method === "update", JSON.stringify(responder.calls));
  return update.message;
}

test("Q2: 1 問・1 つ選ぶ質問はチャンネルに選択肢のボタンの 1 通。押すとすぐ答えが返り、答えの行に書き換える", async (t) => {
  const s = await setup(t);
  const asked = await s.askQuestion(S1, { questions: [Q_COLOR] });
  assert.equal(s.gateway.posts.length, 1);
  const post = s.gateway.posts[0]!;
  assert.equal(post.channelId, CHANNEL);
  assert.equal(post.message.mentionUserId, OWNER);
  assert.deepEqual(buttonIds(post.message), [
    [`cc:q:pick:${asked.id}:0:0`, `cc:q:pick:${asked.id}:0:1`, `cc:q:other:${asked.id}:0`],
    [`cc:q:drop:${asked.id}`],
    [`https://claude.ai/code/${BRIDGE}`],
  ]);
  assert.ok(post.message.text.startsWith("Claude Code が質問しています（1 問）: secret\\-name（secret\\-dir・default）\n質問 1/1「Color」\n色は？\n1. red — 赤\n2. blue\n"), post.message.text);
  assert.ok(post.message.text.endsWith("（ボタンは 15 分効きます）"), post.message.text);

  const responder = await s.interact({ kind: "button", customId: `cc:q:pick:${asked.id}:0:1` });
  const decision = decisionOf(await asked.reply);
  assert.equal(decision.behavior, "allow");
  assert.deepEqual((decision.updatedInput as { answers: unknown }).answers, { "色は？": "blue" });
  const row = s.store.get(asked.id)!;
  assert.equal(row.state, "allowed");
  assert.equal(row.via, "discord");
  const message = updateOf(responder);
  assert.ok(message.text.endsWith("\n答えました（Discord）:\n1. 「Color」blue"), message.text);
  assert.deepEqual(message.components, RC_ROW);
  await s.idle();
  assert.equal(s.gateway.edits.length, 0);
  assert.deepEqual(s.answered, [{ id: asked.id, guildId: GUILD }]);
  assert.ok(s.logs.includes(`Claude Code: 質問（#${asked.id}）→ allowed（discord）`));
  // 2 回目は古い
  const again = await s.interact({ kind: "button", customId: `cc:q:pick:${asked.id}:0:0` });
  assert.deepEqual(again.replies, [{ text: "この操作は古くなっています", ephemeral: true }]);
  assertNoSecrets(s.logs);
});

test("Q2: 2 問は 1 通目 → 次の問に書き換え → 複数選択はセレクト + [決める]。選ばずに [決める] は本人にだけ", async (t) => {
  const s = await setup(t);
  const asked = await s.askQuestion(S1, { questions: [Q_COLOR, Q_TAGS] });
  const first = await s.interact({ kind: "button", customId: `cc:q:pick:${asked.id}:0:0` });
  const step = updateOf(first);
  assert.ok(step.text.includes("\n答え済み:\n1. 「Color」red\n質問 2/2「Tags」\nどれを付けますか？\n"), step.text);
  assert.ok(step.text.includes("（いくつでも選べます。選んでから [決める] を押してください）"));
  assert.equal(step.mentionUserId, undefined);
  const select = step.components?.[0];
  assert.ok(select?.kind === "select");
  assert.equal(select.select.customId, `cc:q:sel:${asked.id}:1`);
  assert.equal(select.select.maxValues, 3);
  assert.deepEqual(buttonIds(step).slice(1), [[`cc:q:ok:${asked.id}:1`, `cc:q:other:${asked.id}:1`, `cc:q:drop:${asked.id}`], [`https://claude.ai/code/${BRIDGE}`]]);
  assert.equal(s.store.get(asked.id)?.state, "pending");
  // 前の問のボタン（古い 1 通）は古い
  const old = await s.interact({ kind: "button", customId: `cc:q:pick:${asked.id}:0:1` });
  assert.deepEqual(old.replies, [{ text: "この操作は古くなっています", ephemeral: true }]);

  const empty = await s.interact({ kind: "button", customId: `cc:q:ok:${asked.id}:1` });
  assert.deepEqual(empty.replies, [{ text: "選んでから [決める] を押してください", ephemeral: true }]);
  const selected = await s.interact({ kind: "select", customId: `cc:q:sel:${asked.id}:1`, values: ["2", "0"] });
  assert.deepEqual(selected.calls, [{ method: "deferUpdate" }]);
  assert.equal(s.store.get(asked.id)?.state, "pending");
  const ok = await s.interact({ kind: "button", customId: `cc:q:ok:${asked.id}:1` });
  const decision = decisionOf(await asked.reply);
  assert.deepEqual((decision.updatedInput as { answers: unknown }).answers, { "色は？": "red", "どれを付けますか？": "a, c" });
  assert.ok(updateOf(ok).text.endsWith("\n答えました（Discord）:\n1. 「Color」red\n2. 「Tags」a, c"));
});

test("Q2: [その他] はモーダルを開き、送った文字列が答えになる。空は本人にだけ断る", async (t) => {
  const s = await setup(t);
  const asked = await s.askQuestion(S1, { questions: [Q_COLOR] });
  const other = await s.interact({ kind: "button", customId: `cc:q:other:${asked.id}:0` });
  assert.equal(other.calls.length, 1);
  const call = other.calls[0]!;
  assert.ok(call.method === "showModal");
  assert.equal(call.modal.customId, `cc:q:text:${asked.id}:0`);
  assert.equal(call.modal.title, "その他（Color）");
  assert.deepEqual(
    call.modal.fields.map((field) => [field.customId, field.style, field.maxLength, field.required]),
    [["text", "paragraph", 1000, true]],
  );
  const blank = await s.interact({ kind: "modal", customId: `cc:q:text:${asked.id}:0`, fields: { text: "   " } });
  assert.deepEqual(blank.replies, [{ text: "「その他」は 1〜1,000 字で書いてください", ephemeral: true }]);
  assert.equal(s.store.get(asked.id)?.state, "pending");
  const sent = await s.interact({ kind: "modal", customId: `cc:q:text:${asked.id}:0`, fields: { text: "  緑\tがいい  " } });
  const decision = decisionOf(await asked.reply);
  assert.deepEqual((decision.updatedInput as { answers: unknown }).answers, { "色は？": "緑 がいい" });
  assert.ok(updateOf(sent).text.endsWith("\n答えました（Discord）:\n1. 「Color」緑 がいい"));
  // ログに答えは出さない
  assert.ok(s.logs.every((line) => !line.includes("緑")));
});

test("Q2: [やめる] は deny（message は「断りました」）で「答えませんでした（Discord）」。途中の答えは捨てる", async (t) => {
  const s = await setup(t);
  const asked = await s.askQuestion(S1, { questions: [Q_COLOR, Q_TAGS] });
  await s.interact({ kind: "button", customId: `cc:q:pick:${asked.id}:0:0` });
  const responder = await s.interact({ kind: "button", customId: `cc:q:drop:${asked.id}` });
  assert.equal(await asked.reply, decisionBody("deny", { question: true }));
  assert.equal(s.store.get(asked.id)?.state, "denied");
  const message = updateOf(responder);
  assert.ok(message.text.endsWith("\n答えませんでした（Discord）"), message.text);
  assert.deepEqual(message.components, RC_ROW);
  assert.deepEqual(s.answered, [{ id: asked.id, guildId: GUILD }]);
  const again = await s.interact({ kind: "button", customId: `cc:q:drop:${asked.id}` });
  assert.deepEqual(again.replies, [{ text: "この操作は古くなっています", ephemeral: true }]);
});

test("Q2: Web で先に答えられた・時間切れは 1 通を書き換え、その後のボタンは古い。Web の会話に質問と答えを書く", async (t) => {
  const s = await setup(t);
  const asked = await s.askQuestion(S1, { questions: [Q_COLOR] });
  const hash = s.store.get(asked.id)!.requestHash;
  assert.deepEqual(s.hold.answerQuestion(asked.id, hash, [{ labels: ["red"] }], "web"), { ok: true, state: "allowed" });
  await s.idle();
  assert.equal(s.gateway.edits.length, 1);
  assert.ok(s.gateway.edits[0]!.message.text.endsWith("\n答えました（Web）:\n1. 「Color」red"));
  assert.deepEqual(s.gateway.edits[0]!.message.components, RC_ROW);
  const late = await s.interact({ kind: "button", customId: `cc:q:pick:${asked.id}:0:1` });
  assert.deepEqual(late.replies, [{ text: "この操作は古くなっています", ephemeral: true }]);

  const expired = await s.askQuestion(S1, { questions: [{ ...Q_COLOR, question: "形は？", header: "" }] });
  // 質問の保留は 900 秒
  const timer = s.holdTimers.entries.at(-1)!;
  assert.equal(timer.ms, 900_000);
  timer.fn();
  await s.idle();
  assert.equal(await expired.reply, undefined);
  assert.ok(s.gateway.edits.at(-1)!.message.text.endsWith(`\n時間切れ。端末か RC で答えてください <https://claude.ai/code/${BRIDGE}>`));
  assert.deepEqual(
    s.history.list(CHANNEL, { limit: 10 }).map((row) => row.text),
    ["質問: 「Color」色は？（1 問）", "質問の答え: 答えました（Web）:\n1. 「Color」red", "質問: 形は？（1 問）", "質問の答え: 時間切れ。端末か RC で答えてください"],
  );
});

test("Q2・Q4: チャンネルの無いセッションの質問は ensureFor（origin question）で作ってそこに 1 通。読めない形の AskUserQuestion は許可の 1 通に注記", async (t) => {
  const s = await setup(t, { channel: false });
  const asked = await s.askQuestion(S1, { questions: [Q_COLOR] });
  assert.deepEqual(s.ensure.calls, [{ sessionId: S1, origin: "question" }]);
  const post = s.gateway.posts.at(-1)!;
  assert.equal(post.channelId, "cc-made-1");
  assert.equal(buttonIds(post.message)[0]![0], `cc:q:pick:${asked.id}:0:0`);
  const responder = await s.interact({ kind: "button", customId: `cc:q:pick:${asked.id}:0:0` }, "cc-made-1");
  assert.ok(updateOf(responder).text.endsWith("\n答えました（Discord）:\n1. 「Color」red"));

  const unreadable = await s.askQuestion(S2, { questions: [{ question: "x", options: [{ label: "only" }] }] });
  const plainPost = s.gateway.posts.at(-1)!;
  assert.equal(s.store.get(unreadable.id)?.questionInput, null);
  assert.deepEqual(buttonIds(plainPost.message)[0], [`cc:perm:allow:${unreadable.id}`, `cc:perm:deny:${unreadable.id}`]);
  assert.ok(plainPost.message.text.includes("\n質問の形を読めませんでした。端末か RC で答えてください\n"), plainPost.message.text);
});

test("Q2: SELF_AGENT_CC が無効（ボタンの口が無い）・質問でない行・形の違う custom_id", async (t) => {
  const s = await setup(t);
  const permission = await s.ask(S1);
  const notQuestion = await s.interact({ kind: "button", customId: `cc:q:pick:${permission.id}:0:0` });
  assert.deepEqual(notQuestion.replies, [{ text: "この操作は古くなっています", ephemeral: true }]);
  const asked = await s.askQuestion(S2, { questions: [Q_COLOR] });
  await assert.rejects(s.interact({ kind: "button", customId: `cc:q:pick:${asked.id}:0` }));
  await assert.rejects(s.interact({ kind: "select", customId: `cc:q:pick:${asked.id}:0:0`, values: ["0"] }));
  await assert.rejects(s.interact({ kind: "button", customId: `cc:q:pick:${asked.id}:x:0` }));
  await assert.rejects(s.interact({ kind: "button", customId: `cc:q:nope:${asked.id}:0` }));
  // 選択肢の添字が範囲外は古い
  const outOfRange = await s.interact({ kind: "button", customId: `cc:q:pick:${asked.id}:0:5` });
  assert.deepEqual(outOfRange.replies, [{ text: "この操作は古くなっています", ephemeral: true }]);
  // 1 つ選ぶ問のセレクトに 2 つは例外
  await assert.rejects(s.interact({ kind: "select", customId: `cc:q:sel:${asked.id}:0`, values: ["0", "1"] }));
  // 範囲外のセレクトの値も例外
  await assert.rejects(s.interact({ kind: "select", customId: `cc:q:sel:${asked.id}:0`, values: ["9"] }));
  // 質問の行に [許可] は効かない（Q1）
  const allow = await s.press(`cc:perm:allow:${asked.id}`);
  assert.deepEqual(allow.replies, [{ text: "この操作は古くなっています", ephemeral: true }]);

  const off = createCcComponent({ gateway: s.gateway, log: () => {} });
  const responder = new FakeResponder();
  await off.handle(
    { kind: "button", customId: `cc:q:pick:${asked.id}:0:0`, guildId: GUILD, channelId: CHANNEL, userId: OWNER, createdAt: new Date(BASE) },
    responder,
  );
  assert.deepEqual(responder.replies, [{ text: "この操作は古くなっています", ephemeral: true }]);
  assert.equal(s.store.get(asked.id)?.state, "pending");
});
