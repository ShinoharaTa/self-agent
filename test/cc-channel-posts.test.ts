// CC12: Claude Code のチャンネルへの許可の要求・判断待ち・端末の指示の写し（docs/plan/claude-code-channels.md §3.5）
import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { createCcComponent, type CcPermissionButtons } from "../src/app/commands/cc.ts";
import { createSystemNotifier } from "../src/app/system-notice.ts";
import type { AgentEntry, AgentsResult } from "../src/cc/agents.ts";
import { CC_PROMPT_MIRROR_LABEL, CC_PROMPT_MIRROR_WINDOW_MS, CcChannelPosts, ccPromptMirrorTexts, promptKey } from "../src/cc/channel-posts.ts";
import { ccEndedHandler } from "../src/cc/channels.ts";
import { CC_WAIT_CHECK_MS, CC_WAIT_NOTIFY_LIMIT, CC_WAIT_NOTIFY_MS, CcDiscordNotifier, CcWaitBudget } from "../src/cc/discord-notice.ts";
import { type CcHookEvent, parseHookEvent } from "../src/cc/hook-server.ts";
import { CcPermissionHold, type CcPermissionListener, decisionBody } from "../src/cc/permission-hold.ts";
import { CcRegistry, type CcTimers } from "../src/cc/registry.ts";
import type { Interaction, OutgoingMessage } from "../src/discord/gateway.ts";
import { CcChannelStore } from "../src/store/cc-channels.ts";
import { CcPermissionStore, type CcPermissionRow } from "../src/store/cc-permissions.ts";
import { CcSendStore } from "../src/store/cc-sends.ts";
import { CcSessionStore } from "../src/store/cc-sessions.ts";
import { GuildSettingsStore } from "../src/store/guild-settings.ts";
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
 * main と同じ配線: 許可の要求の受け手は channelPosts → notifier（NOTIFY=1 のときだけ）、判断待ちの上限は共有、ボタンは notifier によらず channelPosts から。
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
    cfg: { ccPermissionHoldSec: 300 },
    store,
    known: (sessionId) => registry.knows(sessionId),
    now,
    timers: holdTimers,
    log,
  });
  let notifier: CcDiscordNotifier | undefined;
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
    ended: ccEndedHandler({ channels: () => undefined, replier: () => undefined, notifier: () => notifier }),
    onEvent: (event) => posts.onEvent(event),
    log,
  });
  await registry.tick();
  const gateway = new FakeGateway({ allow: ["sendMessage", "editMessage"] });
  const waitBudget = new CcWaitBudget();
  const postsTimers = fakeTimers();
  posts = new CcChannelPosts({
    cfg: { ownerUserId: OWNER, workspaceDir: WORKSPACE, ccPermissionHoldSec: 300 },
    channels,
    gateway,
    permissions: store,
    sessions,
    sends,
    registry,
    waitBudget,
    home: HOME,
    now,
    timers: postsTimers,
    log,
  });
  hold.listen(posts);
  const notifierTimers = fakeTimers();
  if (opts.notify !== false) {
    notifier = new CcDiscordNotifier({
      cfg: { allowedGuildIds: [GUILD], ownerUserId: OWNER, workspaceDir: WORKSPACE, ccPermissionHoldSec: 300 },
      guildSettings,
      notify: createSystemNotifier({ guildSettings, gateway, log }),
      gateway,
      permissions: store,
      sessions,
      registry,
      hasChannel: (sessionId) => channels.openFor(sessionId) !== undefined,
      waitBudget,
      home: HOME,
      now,
      timers: notifierTimers,
      log,
    });
    hold.listen(notifier);
    notifier.start();
  }
  posts.start();
  const answered: Array<{ id: number; guildId: string | null }> = [];
  const buttons: CcPermissionButtons = {
    answer: (id, decision) => hold.answer(id, decision, "discord"),
    resolvedMessage: (id) => posts.resolvedMessage(id),
    answered: (id, guildId) => {
      answered.push({ id, guildId });
    },
  };
  const component = createCcComponent({ ccPermissionButtons: () => buttons, gateway, log });
  const idle = async (): Promise<void> => {
    await posts.idle();
    await notifier?.idle();
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
    if (notifier !== undefined) fire(notifierTimers, CC_WAIT_CHECK_MS);
    await idle();
  };
  return {
    db,
    clock,
    store,
    sessions,
    channels,
    sends,
    hold,
    registry,
    gateway,
    posts,
    notifier,
    waitBudget,
    logs,
    holdTimers,
    answered,
    idle,
    ask,
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
  s.notifier?.stop();
  await s.idle();
  assert.equal(s.store.get(released.id)?.state, "released");
  assert.ok(s.gateway.edits.at(-1)!.message.text.includes("self-agent が止まるため受け付けをやめました"));
  assert.ok([...s.gateway.posts, ...s.gateway.edits].every((p) => p.channelId === CHANNEL));
  assert.equal(s.gateway.edits.length, 4);
});

test("CC12: チャンネルの無いセッションは #system のまま。答えてチャンネルができたら、次の要求からチャンネル", async (t) => {
  const s = await setup(t, { channel: false });
  const first = await s.ask(S1);
  assert.equal(s.gateway.posts.length, 1);
  assert.equal(s.gateway.posts[0]!.channelId, SYSTEM);
  assert.equal(s.store.get(first.id)?.messageChannelId, SYSTEM);
  // [許可]（#system のボタン）→ 答えた（関わった）ので main はチャンネルを作る
  const responder = await s.press(`cc:perm:allow:${first.id}`, SYSTEM);
  assert.ok(responder.calls.some((call) => call.method === "update"));
  assert.deepEqual(s.answered, [{ id: first.id, guildId: GUILD }]);
  s.channels.create({ channelId: CHANNEL, guildId: GUILD, sessionId: S1, name: "cc-secret-name", cwd: SECRET_CWD, origin: "permission" });
  const second = await s.ask(S1, "ls");
  assert.equal(s.gateway.posts.length, 2);
  assert.equal(s.gateway.posts[1]!.channelId, CHANNEL);
  assert.equal(s.store.get(second.id)?.messageChannelId, CHANNEL);
  // 他のセッション（チャンネルなし）は #system
  await s.ask(S2);
  assert.equal(s.gateway.posts[2]!.channelId, SYSTEM);
});

test("CC12: SELF_AGENT_CC_NOTIFY=0 でもチャンネルには出て、ボタンが効く（#system には何も出ない）", async (t) => {
  const s = await setup(t, { notify: false });
  const asked = await s.ask(S1);
  assert.equal(s.gateway.posts.length, 1);
  assert.equal(s.gateway.posts[0]!.channelId, CHANNEL);
  const responder = await s.press(`cc:perm:deny:${asked.id}`);
  assert.ok(responder.calls.some((call) => call.method === "update"));
  assert.equal(s.store.get(asked.id)?.state, "denied");
  // チャンネルの無いセッションの要求はどこにも出ない（#system は止まっている）
  await s.ask(S2);
  assert.equal(s.gateway.posts.length, 1);
  // 判断待ち・写しもチャンネルには出る
  await s.hook(S1, "UserPromptSubmit", { prompt: "端末から", promptChars: 4 });
  assert.equal(s.gateway.posts.length, 2);
  assert.equal(s.gateway.posts[1]!.message.text, `${CC_PROMPT_MIRROR_LABEL}\n端末から`);
});

test("CC12: permission-hold は複数の受け手を持ち、claims した最初の 1 つだけが held・resolved を受ける", async (t) => {
  const db = tempDb(t);
  const store = new CcPermissionStore(db, () => new Date(BASE));
  const hold = new CcPermissionHold({ cfg: { ccPermissionHoldSec: 300 }, store, known: () => true, now: () => new Date(BASE), timers: fakeTimers(), log: () => {} });
  const calls: string[] = [];
  const listener = (name: string, claims?: (row: CcPermissionRow) => boolean): CcPermissionListener => ({
    ...(claims === undefined ? {} : { claims }),
    held: (row) => calls.push(`${name}:held:${row.id}`),
    resolved: (row) => calls.push(`${name}:resolved:${row.id}`),
  });
  hold.listen(listener("channel", (row) => row.sessionId === S1));
  hold.listen(listener("system"));
  const ask = (sessionId: string) => {
    const event = parseHookEvent({ hook_event_name: "PermissionRequest", session_id: sessionId, tool_name: "Bash", tool_input: { command: "ls" } }, new Date(BASE))!;
    void hold.request(event, new AbortController().signal);
    return store.pendingFor(sessionId)!.id;
  };
  const a = ask(S1);
  const b = ask(S2);
  hold.answer(a, "allow", "web");
  hold.answer(b, "deny", "web");
  assert.deepEqual(calls, [`channel:held:${a}`, `system:held:${b}`, `channel:resolved:${a}`, `system:resolved:${b}`]);
});

test("CC12: 判断待ちはチャンネルがあればチャンネル、無ければ #system（1 件は 1 か所）", async (t) => {
  const busy = { status: "busy", waitingFor: undefined } as const;
  const s = await setup(t, { agents: [agent(S1, busy), agent(S2, busy)] });
  await s.hook(S1, "Notification", { notificationType: "agent_needs_input" });
  await s.hook(S2, "Notification", { notificationType: "agent_needs_input" });
  await s.setAgents([agent(S1, { status: "waiting" }), agent(S2, { status: "waiting" })]);
  s.clock.now += CC_WAIT_NOTIFY_MS;
  await s.tickWaiting();
  assert.deepEqual(
    s.gateway.posts.map((post) => post.channelId).sort(),
    [CHANNEL, SYSTEM].sort(),
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

test("CC12: 判断待ちの上限は #system とチャンネルで 1 つ（共有の CcWaitBudget）", () => {
  const budget = new CcWaitBudget();
  for (let i = 0; i < CC_WAIT_NOTIFY_LIMIT; i++) assert.equal(budget.take(BASE + i), true);
  assert.equal(budget.take(BASE + 100), false);
  // 1 時間たてば戻る
  assert.equal(budget.take(BASE + 60 * 60_000 + 1), true);
});

test("CC12: 判断待ちの上限を #system で使い切っていれば、チャンネルには出さない（log だけ）", async (t) => {
  const s = await setup(t, { agents: [agent(S1, { status: "busy", waitingFor: undefined })] });
  // #system 側で使い切った（同じ budget）
  for (let i = 0; i < CC_WAIT_NOTIFY_LIMIT; i++) s.waitBudget.take(BASE);
  await s.hook(S1, "Notification", { notificationType: "agent_needs_input" });
  await s.setAgents([agent(S1, { status: "waiting" })]);
  s.clock.now += CC_WAIT_NOTIFY_MS;
  await s.tickWaiting();
  assert.equal(s.gateway.posts.length, 0);
  assert.ok(s.logs.some((line) => line.includes("上限のためチャンネルに出しませんでした（1 件）")));
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

test("CC12: 再起動の前に保留していた要求は、チャンネルに出したものはチャンネルを、#system のものは #system を書き換える", async (t) => {
  const s = await setup(t);
  const inChannel = await s.ask(S1);
  const inSystem = await s.ask(S2);
  const next = new CcPermissionHold({ cfg: { ccPermissionHoldSec: 300 }, store: s.store, known: () => true, now: () => new Date(s.clock.now), log: () => {} });
  const rows = next.recover();
  assert.equal(rows.length, 2);
  // main と同じ振り分け
  s.posts.rewriteRecovered(rows);
  s.notifier!.rewriteRecovered(rows.filter((row) => !s.posts.owns(row)));
  await s.idle();
  assert.equal(s.gateway.edits.length, 2);
  const byId = new Map(s.gateway.edits.map((edit) => [edit.messageId, edit.channelId]));
  assert.equal(byId.get(s.store.get(inChannel.id)!.messageId!), CHANNEL);
  assert.equal(byId.get(s.store.get(inSystem.id)!.messageId!), SYSTEM);
});

test("CC12: チャンネルのあるセッションが終わったら #system の終了の知らせは出さない（チャンネルの 1 行は cc/channels.ts）", async (t) => {
  const s = await setup(t);
  const ended: string[] = [];
  const handler = ccEndedHandler({
    channels: () => ({ ended: (session) => s.channels.openFor(session.sessionId) !== undefined && ended.push(session.sessionId) > 0 }),
    replier: () => undefined,
    notifier: () => s.notifier,
  });
  s.sessions.recordStart(S1, { startedBy: "web", tmuxSession: "t", tmuxSessionId: "$1", paneId: "%1", trustPendingAt: null });
  handler(s.sessions.get(S1)!);
  await s.idle();
  assert.deepEqual(ended, [S1]);
  assert.equal(s.gateway.posts.length, 0);
});
