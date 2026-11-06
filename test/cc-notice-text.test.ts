// 許可の要求・判断待ちの知らせ（CC5c の文面と押したときの流れ。docs/plan/claude-code-sessions.md §5.2）。Q4 から #system ではなくそのセッションの
// Claude Code のチャンネルに出す（cc/channel-posts.ts。文面は cc/notice-text.ts の純関数。docs/plan/claude-code-questions.md §5）
import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { createCcComponent, type CcPermissionButtons } from "../src/app/commands/cc.ts";
import { createInteractionHandler, OWNER_ONLY_REPLY } from "../src/app/interactions.ts";
import type { AgentEntry, AgentsResult } from "../src/cc/agents.ts";
import { CcChannelPosts } from "../src/cc/channel-posts.ts";
import type { CcOpenResult } from "../src/cc/channels.ts";
import {
  CC_WAIT_CHECK_MS,
  CC_WAIT_NOTIFY_LIMIT,
  CC_WAIT_NOTIFY_MS,
  CcWaitBudget,
  permissionNotice,
  permissionResultLine,
} from "../src/cc/notice-text.ts";
import { type CcHookEvent, parseHookEvent } from "../src/cc/hook-server.ts";
import { CC_PERMISSION_DENY_MESSAGE, CC_PERMISSION_RATE_LIMIT, CcPermissionHold, decisionBody } from "../src/cc/permission-hold.ts";
import { CcRegistry, type CcTimers } from "../src/cc/registry.ts";
import type { Interaction, OutgoingMessage } from "../src/discord/gateway.ts";
import { type CcChannelOrigin, CcChannelStore } from "../src/store/cc-channels.ts";
import { CcPermissionStore } from "../src/store/cc-permissions.ts";
import { CcSendStore } from "../src/store/cc-sends.ts";
import { CcSessionStore } from "../src/store/cc-sessions.ts";
import { MIGRATIONS } from "../src/store/db.ts";
import { tempDb } from "./helpers/db.ts";
import { FakeGateway } from "./helpers/gateway.ts";
import { FakeResponder } from "./helpers/responder.ts";

const BASE = Date.parse("2026-11-01T00:00:00.000Z");
const GUILD = "guild-1";
/** S1・S2 の Claude Code のチャンネル */
const CHANNEL = "cc-channel-1";
const CHANNEL2 = "cc-channel-2";
const OWNER = "owner-1";
const S1 = "11111111-1111-4111-8111-111111111111";
const S2 = "22222222-2222-4222-8222-222222222222";
const HOME = "/home/owner";
const WORKSPACE = "/home/owner/workspace";
const SECRET_NAME = "secret-name";
const SECRET_CWD = "/home/owner/workspace/secret-dir";
const SECRET_COMMAND = "rm -rf secret-dir";
const BRIDGE = "session_01ABCDEF";
/** [RC で開く] の行（S1 は RC の id が分かる） */
const RC_ROW = [{ kind: "links", links: [{ label: "RC で開く", url: `https://claude.ai/code/${BRIDGE}` }] }];
const NPM_TEST_SUGGESTION = [
  { type: "addRules", rules: [{ toolName: "Bash", ruleContent: "npm test *" }], behavior: "allow", destination: "localSettings" },
];

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

/** 偽のタイマー（fire で ms の一致する予約を動かす） */
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

/**
 * main と同じ配線（許可の要求の受け手は cc/channel-posts.ts）。S1・S2 にはチャンネルがある（channels: false で無し）。チャンネルの無いセッションの
 * 知らせは偽の ensureFor（cc-made-<n> を作る。ensure.fails で not_set_up）で作る。notify: false は SELF_AGENT_CC_NOTIFY=0
 */
async function setup(t: TestContext, opts: { holdSec?: number; agents?: AgentEntry[]; notify?: boolean; channels?: boolean } = {}) {
  const db = tempDb(t);
  const clock = { now: BASE };
  const now = (): Date => new Date(clock.now);
  const sessions = new CcSessionStore(db, now);
  const store = new CcPermissionStore(db, now);
  const channels = new CcChannelStore(db, now);
  if (opts.channels !== false) {
    channels.create({ channelId: CHANNEL, guildId: GUILD, sessionId: S1, name: "cc-a", cwd: SECRET_CWD, origin: "web" });
    channels.create({ channelId: CHANNEL2, guildId: GUILD, sessionId: S2, name: "cc-b", cwd: SECRET_CWD, origin: "web" });
  }
  const logs: string[] = [];
  const log = (line: string): void => {
    logs.push(line);
  };
  let next: AgentsResult = { ok: true, agents: opts.agents ?? [agent(S1), agent(S2)], dropped: 0 };
  const holdTimers = fakeTimers();
  let registry!: CcRegistry;
  const hold = new CcPermissionHold({
    cfg: { ccPermissionHoldSec: opts.holdSec ?? 300, ccQuestionHoldSec: 900 },
    store,
    known: (sessionId) => registry.knows(sessionId),
    now,
    timers: holdTimers,
    log,
  });
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
    log,
  });
  await registry.tick();
  const gateway = new FakeGateway({ allow: ["sendMessage", "editMessage"] });
  const postsTimers = fakeTimers();
  const ensure = { calls: [] as Array<{ sessionId: string; origin: CcChannelOrigin }>, fails: false, made: 0 };
  const posts = new CcChannelPosts({
    cfg: { ownerUserId: OWNER, workspaceDir: WORKSPACE, timeZone: "Asia/Tokyo", ccPermissionHoldSec: opts.holdSec ?? 300, ccQuestionHoldSec: 900, ccNotify: opts.notify !== false },
    channels,
    ensureChannel: () => ({
      ensureFor: async (sessionId: string, origin: CcChannelOrigin): Promise<CcOpenResult> => {
        ensure.calls.push({ sessionId, origin });
        if (ensure.fails) return { ok: false, reason: "not_set_up" };
        const channelId = `cc-made-${++ensure.made}`;
        channels.create({ channelId, guildId: GUILD, sessionId, name: channelId, cwd: null, origin });
        return { ok: true, channelId, guildId: GUILD };
      },
    }),
    gateway,
    permissions: store,
    sessions,
    sends: new CcSendStore(db, now),
    registry,
    waitBudget: new CcWaitBudget(),
    home: HOME,
    now,
    timers: postsTimers,
    log,
  });
  hold.listen(posts);
  posts.start();
  const buttons: CcPermissionButtons = {
    answer: (id, decision) => hold.answer(id, decision, "discord"),
    resolvedMessage: (id) => posts.resolvedMessage(id),
  };
  const component = createCcComponent({ ccPermissionButtons: () => buttons, gateway, log });

  /** 許可の要求を受けて保留する（本文の Promise と行の id）。投稿が終わるまで待つ */
  const ask = async (sessionId: string, command = SECRET_COMMAND, suggestions: unknown[] = []) => {
    const event = parseHookEvent(
      {
        hook_event_name: "PermissionRequest",
        session_id: sessionId,
        cwd: SECRET_CWD,
        permission_mode: "default",
        tool_name: "Bash",
        tool_input: { command, description: "x" },
        permission_suggestions: suggestions,
      },
      now(),
      { workspaceDir: WORKSPACE, home: HOME },
    )!;
    registry.receive(event);
    const closed = new AbortController();
    const reply = hold.request(event, closed.signal);
    await posts.idle();
    const row = store.pendingFor(sessionId);
    return { reply, closed, id: row?.id ?? store.get(Number(db.prepare("SELECT MAX(id) AS id FROM cc_permissions").get()?.id))!.id };
  };
  /** hook の事象（Notification・Stop など）を受ける */
  const hook = (sessionId: string, event: CcHookEvent["event"], extra: Partial<CcHookEvent> = {}): void => {
    const parsed: CcHookEvent = { event, sessionId, receivedAt: now(), ...extra };
    registry.receive(parsed);
    hold.observe(parsed);
  };
  /** ボタンを押す */
  const press = async (customId: string, responder = new FakeResponder()): Promise<FakeResponder> => {
    const interaction: Interaction = { kind: "button", customId, guildId: GUILD, channelId: CHANNEL, userId: OWNER, messageId: "message-1" } as Interaction;
    await component.handle(interaction as Extract<Interaction, { kind: "button" }>, responder);
    return responder;
  };
  /** 判断待ちを確かめる周期を 1 回動かす */
  const tickWaiting = async (): Promise<void> => {
    const entry = postsTimers.entries.filter((candidate) => !candidate.cancelled && candidate.ms === CC_WAIT_CHECK_MS).at(-1);
    assert.ok(entry, "判断待ちの確認の予約が無い");
    entry.cancelled = true;
    entry.fn();
    await posts.idle();
  };
  return {
    db,
    clock,
    store,
    sessions,
    hold,
    registry,
    gateway,
    posts,
    ensure,
    component,
    buttons,
    logs,
    holdTimers,
    ask,
    hook,
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

test("CC5c・Q4: 許可の要求でチャンネルに 1 通（オーナーをメンション・ボタン 2 行）。要約はコードブロック、名前は Markdown を無効に", async (t) => {
  const s = await setup(t);
  const asked = await s.ask(S1, "npm test", NPM_TEST_SUGGESTION);
  assert.equal(s.gateway.posts.length, 1);
  const post = s.gateway.posts[0]!;
  assert.equal(post.channelId, CHANNEL);
  assert.equal(post.message.mentionUserId, OWNER);
  assert.deepEqual(buttonIds(post.message), [
    [`cc:perm:allow:${asked.id}`, `cc:perm:always:${asked.id}`, `cc:perm:deny:${asked.id}`],
    [`https://claude.ai/code/${BRIDGE}`],
  ]);
  const text = post.message.text;
  assert.ok(text.startsWith("Claude Code が許可を待っています: secret\\-name（secret\\-dir・default）"), text);
  assert.ok(text.includes("Bash:\n```\nnpm test\n```"), text);
  assert.ok(text.includes("常に許可にすると:\n```\nBash(npm test *)\n```\n「npm test」で始まるコマンド"), text);
  assert.ok(text.includes("端末や RC のダイアログでも答えられます（ボタンは 5 分効きます）"), text);
  // 書き換えのために記録する
  const row = s.store.get(asked.id)!;
  assert.equal(row.messageId, post.messageId);
  assert.equal(row.messageChannelId, CHANNEL);
  // log に名前・パス・コマンドが無い
  for (const line of s.logs) {
    assert.ok(!line.includes(SECRET_NAME) && !line.includes("secret-dir") && !line.includes("npm test"), line);
  }
});

test("CC5c: 提案が無ければ [このセッションでは常に許可] を出さず説明を添える。RC の id が無ければリンクの行も無い", async (t) => {
  const s = await setup(t);
  const asked = await s.ask(S2, "touch x", [{ type: "addDirectories", directories: ["/x"], destination: "session" }]);
  const post = s.gateway.posts[0]!;
  assert.deepEqual(buttonIds(post.message), [[`cc:perm:allow:${asked.id}`, `cc:perm:deny:${asked.id}`]]);
  assert.ok(post.message.text.includes("[このセッションでは常に許可] は Claude Code が規則を提案したときだけ出ます"));
});

test("Q1: 質問（AskUserQuestion）の 1 通の「ボタンは n 分効きます」は質問の保留の長さ（15 分）", async (t) => {
  const s = await setup(t);
  const event = parseHookEvent(
    { hook_event_name: "PermissionRequest", session_id: S1, cwd: SECRET_CWD, permission_mode: "default", tool_name: "AskUserQuestion", tool_input: { questions: [{ question: "色は？", options: [{ label: "red" }, { label: "blue" }] }] } },
    new Date(s.clock.now),
  )!;
  s.registry.receive(event);
  const reply = s.hold.request(event, new AbortController().signal);
  await s.posts.idle();
  assert.equal(s.gateway.posts.length, 1);
  assert.ok(s.gateway.posts[0]!.message.text.includes("（ボタンは 15 分効きます）"), s.gateway.posts[0]!.message.text);
  s.hold.stop();
  await reply;
});

test("CC5c: 要約の ``` とメンションは閉じられず、鳴らない", () => {
  const message = permissionNotice(
    {
      id: 7,
      sessionId: S1,
      requestHash: "h",
      toolName: "Bash",
      summary: "echo ```\n@everyone <@123>",
      permissionMode: "default",
      alwaysRules: null,
      state: "pending",
      via: null,
      createdAt: new Date(BASE).toISOString(),
      resolvedAt: null,
      messageId: null,
      messageChannelId: null,
      questionInput: null,
      answers: null,
      origin: "hook",
    },
    { name: "@everyone **x**", cwd: null },
    { workspaceDir: WORKSPACE, home: HOME, holdSec: 90 },
  );
  // 本文の ``` は開きと閉じの 2 つだけ
  assert.equal(message.text.split("```").length - 1, 2);
  assert.ok(message.text.includes("\\@everyone \\*\\*x\\*\\*"));
  assert.ok(message.text.includes("（ボタンは 90 秒効きます）"));
  assert.equal(message.mentionUserId, undefined);
});

test("CC5c: Discord の [許可] は Web と同じ応答（behavior: allow だけ）で、1 通を書き換えてボタンを外す。2 回目は古い", async (t) => {
  const s = await setup(t);
  const asked = await s.ask(S1);
  const responder = await s.press(`cc:perm:allow:${asked.id}`);
  assert.equal(await asked.reply, decisionBody("allow"));
  const row = s.store.get(asked.id)!;
  assert.equal(row.state, "allowed");
  assert.equal(row.via, "discord");
  const update = responder.calls.find((call) => call.method === "update");
  assert.ok(update !== undefined && update.method === "update");
  // 押すボタンは外し、[RC で開く] は残す
  assert.deepEqual(update.message.components, RC_ROW);
  assert.ok(update.message.text.endsWith("\n許可（Discord）"), update.message.text);
  assert.ok(update.message.text.startsWith("Claude Code が許可を待っています: "));
  // Discord で押したものはここでは書き換えない（応答で書き換えた）
  assert.equal(s.gateway.edits.length, 0);
  // もう 1 回押すと古い（本人にだけ）
  const again = await s.press(`cc:perm:deny:${asked.id}`);
  assert.deepEqual(again.replies, [{ text: "この操作は古くなっています", ephemeral: true }]);
  assert.equal(s.store.get(asked.id)?.state, "allowed");
});

test("CC5c: Discord の [拒否] は deny + message（interrupt なし）", async (t) => {
  const s = await setup(t);
  const asked = await s.ask(S1);
  const responder = await s.press(`cc:perm:deny:${asked.id}`);
  const body = JSON.parse((await asked.reply)!);
  assert.deepEqual(body, {
    hookSpecificOutput: { hookEventName: "PermissionRequest", decision: { behavior: "deny", message: CC_PERMISSION_DENY_MESSAGE } },
  });
  const update = responder.calls.find((call) => call.method === "update");
  assert.ok(update?.method === "update" && update.message.text.endsWith("\n拒否（Discord）"));
});

test("CC5c: Discord の [このセッションでは常に許可] は CC5b と同じ応答（destination: session）。提案が無ければ古い", async (t) => {
  const s = await setup(t);
  const asked = await s.ask(S1, "npm test", NPM_TEST_SUGGESTION);
  const responder = await s.press(`cc:perm:always:${asked.id}`);
  const body = JSON.parse((await asked.reply)!);
  assert.deepEqual(body.hookSpecificOutput.decision, {
    behavior: "allow",
    updatedPermissions: [{ type: "addRules", rules: [{ toolName: "Bash", ruleContent: "npm test *" }], behavior: "allow", destination: "session" }],
  });
  assert.equal(s.store.get(asked.id)?.state, "allowed_always");
  const update = responder.calls.find((call) => call.method === "update");
  assert.ok(update?.method === "update" && update.message.text.endsWith("\n常に許可（`Bash(npm test *)`）（Discord）"), JSON.stringify(update));

  // 提案の無い要求に always は古い（保留は続く）
  const other = await s.ask(S2, "touch x");
  const stale = await s.press(`cc:perm:always:${other.id}`);
  assert.deepEqual(stale.replies, [{ text: "この操作は古くなっています", ephemeral: true }]);
  assert.equal(s.store.get(other.id)?.state, "pending");
});

test("CC5c: Web で先に押されていれば Discord は「古くなっています」。1 通は「許可（Web）」に書き換わりボタンが外れる", async (t) => {
  const s = await setup(t);
  const asked = await s.ask(S1);
  assert.deepEqual(s.hold.answer(asked.id, "allow", "web"), { ok: true, state: "allowed" });
  await s.posts.idle();
  assert.equal(s.gateway.edits.length, 1);
  const edit = s.gateway.edits[0]!;
  assert.equal(edit.channelId, CHANNEL);
  assert.equal(edit.messageId, s.gateway.posts[0]!.messageId);
  assert.deepEqual(edit.message.components, RC_ROW);
  assert.ok(edit.message.text.endsWith("\n許可（Web）"), edit.message.text);
  const responder = await s.press(`cc:perm:deny:${asked.id}`);
  assert.deepEqual(responder.replies, [{ text: "この操作は古くなっています", ephemeral: true }]);
  assert.equal(await asked.reply, decisionBody("allow"));
});

test("CC5c: 他で答えられたら（Stop・次の要求）1 通が「端末か RC で答えられました」に書き換わりボタンが外れる", async (t) => {
  const s = await setup(t);
  const first = await s.ask(S1);
  s.hook(S1, "Stop");
  await s.posts.idle();
  assert.equal(await first.reply, undefined);
  assert.equal(s.store.get(first.id)?.state, "answered_elsewhere");
  assert.equal(s.gateway.edits.length, 1);
  assert.ok(s.gateway.edits[0]!.message.text.endsWith("\n端末か RC で答えられました"));
  assert.deepEqual(s.gateway.edits[0]!.message.components, RC_ROW);
  // 次の要求で前のものが閉じたときも同じ
  const second = await s.ask(S1, "ls");
  await s.ask(S1, "pwd");
  assert.equal(s.store.get(second.id)?.state, "answered_elsewhere");
  assert.ok(s.gateway.edits.at(-1)!.message.text.endsWith("\n端末か RC で答えられました"));
  // 押しても古い
  const responder = await s.press(`cc:perm:allow:${second.id}`);
  assert.deepEqual(responder.replies, [{ text: "この操作は古くなっています", ephemeral: true }]);
});

test("CC5c: 時間切れは「時間切れ。端末か RC で答えてください <リンク>」。停止の released も書き換える", async (t) => {
  const s = await setup(t);
  const asked = await s.ask(S1);
  s.holdTimers.entries.at(-1)!.fn();
  await s.posts.idle();
  assert.equal(await asked.reply, undefined);
  assert.ok(s.gateway.edits[0]!.message.text.endsWith(`\n時間切れ。端末か RC で答えてください <https://claude.ai/code/${BRIDGE}>`));

  const other = await s.ask(S2);
  s.hold.stop();
  s.posts.stop();
  await s.posts.idle();
  assert.equal(s.store.get(other.id)?.state, "released");
  assert.ok(s.gateway.edits.at(-1)!.message.text.endsWith("\nself-agent が止まるため受け付けをやめました。端末か RC で答えてください"));
  // RC のリンクが分からないセッション（S2）はボタンの行を全部外す
  assert.deepEqual(s.gateway.edits.at(-1)!.message.components, []);
});

test("CC5c: 投稿の途中で終わった要求は、投稿の後に書き換える", async (t) => {
  const s = await setup(t);
  let release: (() => void) | undefined;
  s.gateway.beforeSendMessage = () =>
    new Promise<void>((resolve) => {
      release = resolve;
    });
  const event = parseHookEvent(
    { hook_event_name: "PermissionRequest", session_id: S1, cwd: SECRET_CWD, tool_name: "Bash", tool_input: { command: "ls" } },
    new Date(BASE),
  )!;
  const reply = s.hold.request(event, new AbortController().signal);
  const id = s.store.pendingFor(S1)!.id;
  assert.deepEqual(s.hold.answer(id, "deny", "web"), { ok: true, state: "denied" });
  assert.equal(s.gateway.edits.length, 0);
  // チャンネルを引いてから投稿するので、投稿に入るまで待つ
  while (release === undefined) await new Promise((resolve) => setImmediate(resolve));
  release();
  await s.posts.idle();
  await reply;
  assert.equal(s.gateway.posts.length, 1);
  assert.equal(s.gateway.edits.length, 1);
  assert.ok(s.gateway.edits[0]!.message.text.endsWith("\n拒否（Web）"));
});

test("CC5c: 保留中に来た permission_prompt の Notification では判断待ちの知らせが出ない（解決の後 60 秒も）", async (t) => {
  // S2 は動いている（判断待ちでない）
  const s = await setup(t, { agents: [agent(S1), agent(S2, { status: "busy", waitingFor: undefined })] });
  const asked = await s.ask(S1);
  // 6 秒で permission_prompt
  s.clock.now += 6_000;
  s.hook(S1, "Notification", { notificationType: "permission_prompt" });
  s.clock.now += CC_WAIT_NOTIFY_MS + 10_000;
  await s.tickWaiting();
  assert.equal(s.gateway.posts.length, 1, "許可の要求の 1 通だけ");
  // Web で答えた後も、直近 60 秒に解決した行があるので出ない
  s.hold.answer(asked.id, "allow", "web");
  await s.posts.idle();
  s.clock.now += 30_000;
  await s.tickWaiting();
  assert.equal(s.gateway.posts.length, 1);
});

test("CC5c: permission_prompt だけの判断待ち（PermissionRequest なし）は 60 秒で 1 回。59 秒で解消したものは知らせない", async (t) => {
  const s = await setup(t, { agents: [agent(S1, { status: "busy", waitingFor: undefined }), agent(S2, { status: "busy", waitingFor: undefined })] });
  // S1: 6 秒の permission_prompt（sandbox のネットの許可など）→ 60 秒で知らせる
  s.hook(S1, "Notification", { notificationType: "permission_prompt" });
  await s.setAgents([agent(S1, { status: "waiting" }), agent(S2, { status: "busy", waitingFor: undefined })]);
  s.clock.now += CC_WAIT_NOTIFY_MS - 1_000;
  await s.tickWaiting();
  assert.equal(s.gateway.posts.length, 0);
  s.clock.now += 1_000;
  await s.tickWaiting();
  assert.equal(s.gateway.posts.length, 1);
  const post = s.gateway.posts[0]!;
  assert.equal(post.message.mentionUserId, OWNER);
  assert.ok(post.message.text.startsWith("Claude Code が判断を待っています（1 分以上）: secret\\-name（secret\\-dir）"), post.message.text);
  assert.ok(post.message.text.endsWith("\npermission prompt"));
  assert.deepEqual(buttonIds(post.message), [[`https://claude.ai/code/${BRIDGE}`]]);
  // 同じ待ちには 2 回目を出さない
  s.clock.now += 120_000;
  await s.tickWaiting();
  assert.equal(s.gateway.posts.length, 1);

  // S2: elicitation が 59 秒で Stop により解消 → 知らせない
  s.hook(S2, "Notification", { notificationType: "elicitation_dialog" });
  await s.setAgents([agent(S1, { status: "waiting" }), agent(S2, { status: "idle", waitingFor: undefined })]);
  s.clock.now += 59_000;
  s.hook(S2, "Stop");
  s.clock.now += 2_000;
  await s.tickWaiting();
  assert.equal(s.gateway.posts.length, 1);
  // 新しい待ちはまた 1 回
  s.hook(S2, "Notification", { notificationType: "elicitation_dialog" });
  s.clock.now += CC_WAIT_NOTIFY_MS;
  await s.tickWaiting();
  assert.equal(s.gateway.posts.length, 2);
  assert.ok(s.gateway.posts[1]!.message.text.endsWith("\n質問のダイアログ"));
});

test("CC5c: 1 分 20 件の上限で保留しなかった要求（released）は判断待ちの知らせを止めない", async (t) => {
  // S2 は動いている（判断待ちでない）
  const s = await setup(t, { agents: [agent(S1), agent(S2, { status: "busy", waitingFor: undefined })] });
  let last = await s.ask(S1);
  for (let i = 1; i < CC_PERMISSION_RATE_LIMIT; i++) last = await s.ask(S1, `echo ${i}`);
  // 保留していた最後の要求は Web で答える（ここで解決した行は 61 秒後には窓の外）
  assert.deepEqual(s.hold.answer(last.id, "allow", "web"), { ok: true, state: "allowed" });
  await s.posts.idle();
  const posted = s.gateway.posts.length;
  assert.equal(posted, CC_PERMISSION_RATE_LIMIT);
  // 59 秒後の要求は上限で保留しない（released・limit）。チャンネルにも出さない
  s.clock.now += 59_000;
  const released = await s.ask(S1, "echo over");
  assert.equal(s.store.get(released.id)?.state, "released");
  assert.equal(s.store.get(released.id)?.via, "limit");
  assert.equal(s.gateway.posts.length, posted);
  // 2 秒後: 直近 60 秒に解決したのは released だけなので、ダイアログが出ている判断待ちとして知らせる
  s.clock.now += 2_000;
  await s.tickWaiting();
  assert.equal(s.gateway.posts.length, posted + 1);
  assert.ok(s.gateway.posts.at(-1)!.message.text.startsWith("Claude Code が判断を待っています"));
});

test("CC5c・Q4: 判断待ちの知らせは 1 時間に 10 件（チャンネルを作って出す）。11 件目からは出さず、そのためにチャンネルも作らない", async (t) => {
  const ids = Array.from({ length: CC_WAIT_NOTIFY_LIMIT + 2 }, (_, i) => `${String(i + 10).padStart(8, "0")}-1111-4111-8111-111111111111`);
  const s = await setup(t, { agents: ids.map((sessionId) => agent(sessionId, { status: "idle", waitingFor: undefined })) });
  for (const sessionId of ids) {
    s.hook(sessionId, "Notification", { notificationType: "agent_needs_input" });
    s.clock.now += CC_WAIT_NOTIFY_MS;
    await s.tickWaiting();
  }
  const texts = s.gateway.posts.map((post) => post.message.text);
  assert.equal(texts.length, CC_WAIT_NOTIFY_LIMIT);
  assert.ok(texts.every((text) => text.startsWith("Claude Code が判断を待っています")));
  assert.equal(s.ensure.calls.length, CC_WAIT_NOTIFY_LIMIT);
  assert.ok(s.ensure.calls.every((call) => call.origin === "waiting"));
  assert.equal(s.gateway.edits.length, 0);
});

test("CC5c: 再起動の前に保留していた要求の 1 通は、recover の後に「時間切れ」に書き換える", async (t) => {
  const s = await setup(t);
  const asked = await s.ask(S1);
  const postedId = s.gateway.posts[0]!.messageId;
  // 次のプロセスの保留（同じ DB）
  const next = new CcPermissionHold({ cfg: { ccPermissionHoldSec: 300, ccQuestionHoldSec: 900 }, store: s.store, known: () => true, now: () => new Date(s.clock.now), log: () => {} });
  const rows = next.recover();
  assert.deepEqual(rows.map((row) => [row.id, row.state]), [[asked.id, "expired"]]);
  assert.equal(s.gateway.edits.length, 0);
  s.posts.rewriteRecovered(rows);
  await s.posts.idle();
  assert.equal(s.gateway.edits.length, 1);
  const edit = s.gateway.edits[0]!;
  assert.equal(edit.messageId, postedId);
  assert.ok(edit.message.text.endsWith(`\n時間切れ。端末か RC で答えてください <https://claude.ai/code/${BRIDGE}>`), edit.message.text);
  assert.deepEqual(edit.message.components, RC_ROW);
  // 投稿していない行（チャンネルを作れなかった・NOTIFY=0）は書き換えない
  s.posts.rewriteRecovered([{ ...rows[0]!, messageId: null, messageChannelId: null }]);
  await s.posts.idle();
  assert.equal(s.gateway.edits.length, 1);
});

test("CC5c: Discord のボタンの後に応答（update）が失敗したら、1 通を gateway で書き換えて代える", async (t) => {
  const s = await setup(t);
  const asked = await s.ask(S1);
  const responder = new FakeResponder();
  responder.beforeUpdate = () => {
    throw new Error("Unknown interaction");
  };
  await s.press(`cc:perm:allow:${asked.id}`, responder);
  assert.equal(await asked.reply, decisionBody("allow"));
  assert.equal(s.gateway.edits.length, 1);
  const edit = s.gateway.edits[0]!;
  assert.equal(edit.channelId, CHANNEL);
  assert.equal(edit.messageId, s.gateway.posts[0]!.messageId);
  assert.ok(edit.message.text.endsWith("\n許可（Discord）"));
  assert.deepEqual(edit.message.components, RC_ROW);
  assert.ok(s.logs.some((line) => line.startsWith(`Claude Code: 許可の要求（#${asked.id}）への応答に失敗したため`)));
});

test("CC5c: オーナー以外・許可外のサーバーの cc:perm は振り分けで止まり、要求は保留のまま", async (t) => {
  const s = await setup(t);
  const asked = await s.ask(S1);
  const logs: string[] = [];
  const handle = createInteractionHandler({
    cfg: { allowedGuildIds: [GUILD], ownerUserId: OWNER },
    commands: [],
    components: [s.component],
    log: (line) => logs.push(line),
  });
  const customId = `cc:perm:allow:${asked.id}`;
  const stranger = new FakeResponder();
  await handle({ kind: "button", customId, guildId: GUILD, channelId: CHANNEL, userId: "someone-else", messageId: "message-1" } as Interaction, stranger);
  assert.deepEqual(stranger.replies, [{ text: OWNER_ONLY_REPLY, ephemeral: true }]);
  const outside = new FakeResponder();
  await handle({ kind: "button", customId, guildId: "guild-other", channelId: CHANNEL, userId: OWNER, messageId: "message-1" } as Interaction, outside);
  assert.deepEqual(outside.calls, []);
  assert.equal(s.store.get(asked.id)?.state, "pending");
  // オーナーが許可したサーバーで押せば通る
  const owner = new FakeResponder();
  await handle({ kind: "button", customId, guildId: GUILD, channelId: CHANNEL, userId: OWNER, messageId: "message-1" } as Interaction, owner);
  assert.equal(s.store.get(asked.id)?.state, "allowed");
});

test("Q4: SELF_AGENT_CC_NOTIFY=0 でチャンネルが無ければ作らず投稿も無く、保留は 5 分のまま。Web で答えられる", async (t) => {
  const s = await setup(t, { notify: false, channels: false });
  const asked = await s.ask(S1);
  assert.equal(s.gateway.posts.length, 0);
  assert.deepEqual(s.ensure.calls, []);
  assert.equal(s.holdTimers.entries.at(-1)!.ms, 300_000);
  assert.equal(s.store.get(asked.id)?.state, "pending");
  assert.deepEqual(s.hold.answer(asked.id, "allow", "web"), { ok: true, state: "allowed" });
  assert.equal(await asked.reply, decisionBody("allow"));
});

test("Q4: チャンネルを作れなければ（/setup 前など）投稿しない（保留は続く）", async (t) => {
  const s = await setup(t, { channels: false });
  s.ensure.fails = true;
  const asked = await s.ask(S1);
  assert.deepEqual(s.ensure.calls, [{ sessionId: S1, origin: "permission" }]);
  assert.equal(s.gateway.posts.length, 0);
  assert.equal(s.store.get(asked.id)?.state, "pending");
  assert.equal(s.store.get(asked.id)?.messageId, null);
});

test("CC5c: cc:perm の custom_id の形が違えば投げる（不明な操作）", async (t) => {
  const s = await setup(t);
  await assert.rejects(s.press("cc:perm:allow:x"));
  await assert.rejects(s.press("cc:perm:ok:1"));
  await assert.rejects(s.press("cc:perm:allow:1:2"));
  await assert.rejects(s.press("cc:other:1"));
});

test("permissionResultLine: 状態ごとの結果の行", () => {
  const base = { alwaysRules: null };
  assert.equal(permissionResultLine({ ...base, state: "pending", via: null }, undefined), undefined);
  assert.equal(permissionResultLine({ ...base, state: "allowed", via: "web" }, undefined), "許可（Web）");
  assert.equal(permissionResultLine({ ...base, state: "denied", via: "discord" }, undefined), "拒否（Discord）");
  assert.equal(permissionResultLine({ ...base, state: "answered_elsewhere", via: "status" }, "https://x"), "端末か RC で答えられました");
  assert.equal(permissionResultLine({ ...base, state: "expired", via: null }, undefined), "時間切れ。端末か RC で答えてください");
});

test("v32: cc_permissions に message_id・message_channel_id、cc_sessions に notified_at", (t) => {
  const db = tempDb(t);
  assert.ok(MIGRATIONS.length >= 32);
  const permissionColumns = db.prepare("PRAGMA table_info(cc_permissions)").all().map((row) => String(row.name));
  assert.ok(permissionColumns.includes("message_id") && permissionColumns.includes("message_channel_id"));
  const sessionColumns = db.prepare("PRAGMA table_info(cc_sessions)").all().map((row) => String(row.name));
  assert.ok(sessionColumns.includes("notified_at"));
});
