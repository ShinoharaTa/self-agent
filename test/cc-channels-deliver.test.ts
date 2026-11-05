// Claude Code のチャンネル（docs/plan/claude-code-channels.md §3.1・§3.3。CC11）: 関わったら作る・チャンネルの発言を届ける・写し・印。
// 本物の CcChannels・CcSender・CcPaneResolver・createTmux（偽の execFile）・偽 Gateway・一時 SQLite
import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import {
  CC_ATTACHMENT_REPLY,
  CC_DIALOG_REPLY,
  CC_GAVE_UP_REPLY,
  CC_MARK_DELIVERED,
  CC_MARK_FAILED,
  CC_MARK_UNCONFIRMED,
  CC_MARK_WAITING,
  CC_QUEUE_FULL_REPLY,
  CC_CHANNEL_REOPENED_TEXT,
  CC_CHANNEL_CLOSED_TEXT,
  CC_CHANNEL_ENDED_TEXT,
  CC_CHANNEL_REVIVED_TEXT,
  CC_RESUME_PROMPT_TEXT,
  CC_RESUMING_REPLY,
  CC_UNCONFIRMED_REPLY,
  CcChannels,
  ccFailedReply,
  ccMirrorTexts,
} from "../src/cc/channels.ts";
import { CcPaneResolver } from "../src/cc/panes.ts";
import type { CcSessionView, CcSnapshot } from "../src/cc/registry.ts";
import { CC_CHANNEL_QUEUE_MAX, CcSender } from "../src/cc/sender.ts";
import type { IncomingMessage, OutgoingMessage } from "../src/discord/gateway.ts";
import { CcChannelStore } from "../src/store/cc-channels.ts";
import { CcSendStore } from "../src/store/cc-sends.ts";
import { CcSessionStore } from "../src/store/cc-sessions.ts";
import { GuildSettingsStore } from "../src/store/guild-settings.ts";
import { HistoryStore } from "../src/store/history.ts";
import { createTmux, type RunCommand } from "../src/tmux/tmux.ts";
import { tempDb } from "./helpers/db.ts";
import { FakeGateway } from "./helpers/gateway.ts";
import { RecordingChannelOps, RecordingQueue } from "./helpers/recording.ts";

const BASE = Date.parse("2026-11-05T00:00:00.000Z");
const S1 = "11111111-1111-4111-8111-111111111111";
const S2 = "22222222-2222-4222-8222-222222222222";
const TMUX = "/usr/bin/tmux";
const OWNER = "owner-1";
const SECRET_TEXT = "secret-body";

// 画面（cc-sender.test.ts と同じ形）
const RULE = "─".repeat(80);
const PROMPT = "❯ ";
const FOOTER = ["  ⏵⏵ auto mode on (shift+tab to cycle)"];
const BUSY_FOOTER = ["  ⏵⏵ auto mode on (shift+tab to cycle) · esc to interrupt"];
function screen(input: string[], footer = FOOTER): string {
  return ["● 返答の本文（置き換え）", "", RULE, ...input, RULE, ...footer, "", ""].join("\n");
}
const EMPTY = screen([PROMPT]);
const BUSY = screen([PROMPT], BUSY_FOOTER);
const DIALOG = [
  RULE,
  " Do you want to proceed?",
  " ❯ 1. Yes",
  "   2. No",
  "",
  " Esc to cancel · Tab to amend",
  "",
].join("\n");
/** 貼った文字が入力欄に見える画面 */
function shown(text: string): string {
  const [first, ...rest] = text.split("\n");
  return screen([`${PROMPT}${first}`, ...rest.map((line) => `  ${line}`)]);
}

function paneLine(paneId: string, panePid: number): string {
  return ["work", "0", paneId.slice(1), paneId, "1", "1", "/w/a", "claude", "0", "0", String(panePid)].join("\t");
}

function view(sessionId: string, pid: number, name: string): CcSessionView {
  return { sessionId, pid, name, cwd: `/w/${name}`, tmux: undefined, state: "idle" } as CcSessionView;
}

type Phase = "before" | "pasted" | "entered";

function setup(t: TestContext, options: { setUp?: boolean; history?: boolean } = {}) {
  const db = tempDb(t);
  const clock = { now: BASE };
  const now = (): Date => new Date(clock.now);
  const store = new CcChannelStore(db, now);
  const sends = new CcSendStore(db, now);
  const sessions = new CcSessionStore(db, now);
  const guildSettings = new GuildSettingsStore(db, now);
  const history = new HistoryStore(db, now);
  const gateway = new FakeGateway({
    allow: ["sendMessage", "channelExists", "countChannelsIn"],
    record: ["createTextChannel", "addReaction", "removeOwnReaction"],
    channelIdPrefix: "chan-",
    messageIdPrefix: "msg-",
  });
  guildSettings.setChannel("guild-1", "homeCategoryId", "home-1");
  if (options.setUp !== false) {
    guildSettings.setCcCategory("guild-1", "cat-cc");
    gateway.alive.add("cat-cc");
  }
  const env = {
    phase: "before" as Phase,
    screens: { before: EMPTY, pasted: EMPTY, entered: BUSY } as Record<Phase, string>,
  };
  const commands: string[][] = [];
  const run: RunCommand = async (_file, args) => {
    commands.push([...args]);
    switch (args[0]) {
      case "list-panes":
        return { code: 0, stdout: [paneLine("%1", 400), paneLine("%2", 410)].join("\n"), stderr: "" };
      case "capture-pane":
        return { code: 0, stdout: env.screens[env.phase], stderr: "" };
      case "paste-buffer":
        env.phase = "pasted";
        return { code: 0, stdout: "", stderr: "" };
      case "send-keys":
        env.phase = "entered";
        return { code: 0, stdout: "", stderr: "" };
      default:
        return { code: 0, stdout: "", stderr: "" };
    }
  };
  const tmux = createTmux({ tmuxPath: TMUX, run });
  const parents: Record<number, number> = { 500: 400, 600: 410, 400: 1, 410: 1 };
  const panes = new CcPaneResolver({ tmux, parentOf: (pid) => parents[pid] });
  const snapshot: CcSnapshot = { sessions: [view(S1, 500, "alpha"), view(S2, 600, "beta")], stale: false, unreadable: false, fetchedAt: BASE };
  const registry = { snapshot: () => snapshot };
  const notices: Array<{ guildId: string; message: OutgoingMessage }> = [];
  const logs: string[] = [];
  let channels: CcChannels | undefined;
  const sender = new CcSender({
    cfg: { ccSendWaitMin: 120, allowedGuildIds: ["guild-1"] },
    registry,
    panes,
    tmux,
    sends,
    sessions,
    channels: {
      announce: async (row, guildId) => channels?.announce(row, guildId),
      settled: (row) => channels?.settled(row),
      dialog: (row) => channels?.dialog(row),
    },
    now,
    sleep: async () => undefined,
    timers: { after: () => () => undefined },
    log: (message) => logs.push(message),
  });
  channels = new CcChannels({
    cfg: { allowedGuildIds: ["guild-1", "guild-2"], workspaceDir: "/w", ownerUserId: OWNER },
    store,
    sends,
    sender: () => sender,
    guildOf: (channelId) => (channelId === "inbox-1" ? "guild-1" : undefined),
    guildSettings,
    registry,
    panes,
    gateway,
    queue: new RecordingQueue(1),
    channelOps: new RecordingChannelOps(),
    notify: async (guildId, message) => {
      notices.push({ guildId, message });
      return "notice-1";
    },
    home: "/home/owner",
    // Web の会話の記録（CC14）
    ...(options.history === true ? { history } : {}),
    now,
    log: (message) => logs.push(message),
  });
  // S1 にはチャンネルがある
  store.create({ channelId: "cc-1", guildId: "guild-1", sessionId: S1, name: "cc-alpha", cwd: "/w/alpha", origin: "web" });
  let nextMessage = 1;
  /** オーナーの発言 */
  const message = (content: string, overrides: Partial<IncomingMessage> = {}): IncomingMessage => ({
    id: `m-${nextMessage++}`,
    channelId: "cc-1",
    guildId: "guild-1",
    authorId: OWNER,
    authorIsBot: false,
    isWebhook: false,
    content,
    createdAt: new Date(clock.now),
    ...overrides,
  });
  /** 届けるまで待つ（印の操作も） */
  const settle = async (): Promise<void> => {
    await sender.idle();
    await channels!.idle();
  };
  const actions = () => commands.filter((args) => ["load-buffer", "paste-buffer", "send-keys"].includes(args[0]!)).map((args) => args[0]);
  return { db, clock, store, sends, guildSettings, history, gateway, env, snapshot, sender, channels, notices, logs, message, settle, actions, commands };
}

/** log にチャンネル ID・本文を出していない */
function assertQuietLogs(logs: readonly string[]): void {
  for (const line of logs) assert.doesNotMatch(line, /cc-1|chan-\d|inbox-1|secret|1111|2222/, line);
}

test("発言: origin discord・channel_id・message_id で queued を積んで ⏳、入力待ちなら貼って Enter → delivered で ⏳ を外して ✅", async (t) => {
  const s = setup(t);
  s.env.screens.pasted = shown(SECRET_TEXT);
  const msg = s.message(`${SECRET_TEXT}\n`);
  assert.equal(await s.channels.handleMessage(msg), true);
  const row = s.sends.get(1)!;
  assert.deepEqual([row.origin, row.sessionId, row.channelId, row.messageId, row.text], ["discord", S1, "cc-1", msg.id, SECRET_TEXT]);
  await s.settle();
  assert.equal(s.sends.get(1)!.state, "delivered");
  assert.deepEqual(s.actions(), ["load-buffer", "paste-buffer", "send-keys"]);
  assert.deepEqual(s.gateway.reactionsOn("cc-1", msg.id), [CC_MARK_DELIVERED]);
  // ⏳ を付けてから外した（返信は無い）
  assert.deepEqual(
    s.gateway.callsOf("addReaction", "removeOwnReaction").map((call) => [call.method, "emoji" in call ? call.emoji : ""]),
    [
      ["addReaction", CC_MARK_WAITING],
      ["removeOwnReaction", CC_MARK_WAITING],
      ["addReaction", CC_MARK_DELIVERED],
    ],
  );
  assert.equal(s.gateway.posts.length, 0);
  assert.equal(s.store.get("cc-1")?.state, "open");
  assert.ok(s.logs.some((line) => line.includes("チャンネルの発言を積みました（#1）")));
  assertQuietLogs(s.logs);
});

test("発言: 作業中なら ⏳ のまま積み、同じセッションに 5 件まで。6 件目は返信で断る。Web からの同じセッションへの送信は already_queued", async (t) => {
  const s = setup(t);
  s.env.screens.before = BUSY;
  for (let i = 1; i <= CC_CHANNEL_QUEUE_MAX; i++) await s.channels.handleMessage(s.message(`本文 ${i}`));
  await s.settle();
  assert.equal(s.sends.countQueuedDiscord(S1), CC_CHANNEL_QUEUE_MAX);
  for (let i = 1; i <= CC_CHANNEL_QUEUE_MAX; i++) assert.deepEqual(s.gateway.reactionsOn("cc-1", `m-${i}`), [CC_MARK_WAITING]);
  const sixth = s.message("本文 6");
  assert.equal(await s.channels.handleMessage(sixth), true);
  await s.settle();
  assert.equal(s.sends.countQueuedDiscord(S1), CC_CHANNEL_QUEUE_MAX);
  assert.deepEqual(
    s.gateway.posts.map((post) => [post.channelId, post.message.text, post.message.replyToId]),
    [["cc-1", CC_QUEUE_FULL_REPLY, sixth.id]],
  );
  assert.deepEqual(await s.sender.submit({ sessionId: S1, text: "Web から", origin: "web" }), { ok: false, reason: "already_queued" });
  assert.deepEqual(s.actions(), []);
});

test("発言: 2 件続けて積んで偽 tmux が idle のままでも、1 pass で届けるのは 1 件だけ（次の pass で 2 件目）", async (t) => {
  const s = setup(t);
  s.env.screens.pasted = shown("一つ目");
  // 届けた後も入力待ちに見える
  s.env.screens.entered = EMPTY;
  // 一覧が古い間は試さないので、2 件とも積んでから 1 回だけ回す
  s.snapshot.stale = true;
  await s.channels.handleMessage(s.message("一つ目"));
  await s.channels.handleMessage(s.message("二つ目"));
  await s.settle();
  assert.deepEqual(s.actions(), []);
  s.snapshot.stale = false;
  await s.sender.kick();
  await s.settle();
  assert.equal(s.sends.get(1)!.state, "delivered");
  assert.equal(s.sends.get(2)!.state, "queued");
  assert.equal(s.commands.filter((args) => args[0] === "load-buffer").length, 1);
  // 次の pass（Stop か 30 秒後）で 2 件目を試す
  s.env.screens.pasted = shown("二つ目");
  s.env.phase = "before";
  await s.sender.kick();
  await s.settle();
  assert.equal(s.sends.get(2)!.state, "delivered");
});

test("発言: 制御文字・長すぎる・添付だけは返信で断って積まない。本文も添付も無ければ何もしない", async (t) => {
  const s = setup(t);
  const control = s.message("a\u001bb");
  const long = s.message("字".repeat(4001));
  const image = s.message("", { images: [{ url: "u", proxyUrl: "p", contentType: "image/png", size: 1, width: null, height: null }] });
  const file = s.message("  ", { skippedAttachments: { unsupported: 1, overLimit: 0 } });
  const empty = s.message("");
  for (const msg of [control, long, image, file, empty]) assert.equal(await s.channels.handleMessage(msg), true);
  await s.settle();
  assert.equal(s.sends.get(1), undefined);
  assert.deepEqual(
    s.gateway.posts.map((post) => [post.message.text, post.message.replyToId]),
    [
      ["改行のほかの制御文字は送れません", control.id],
      ["長すぎます（4,000 字まで）", long.id],
      [CC_ATTACHMENT_REPLY, image.id],
      [CC_ATTACHMENT_REPLY, file.id],
    ],
  );
});

test("発言: 足した人格の Bot で受けた・Bot・Webhook・オーナー以外・許可外のサーバーは黙って捨て、cc のチャンネルでなければ false（handler へ）", async (t) => {
  const s = setup(t);
  const dropped = [
    s.message("x", { persona: "alt" }),
    s.message("x", { authorIsBot: true }),
    s.message("x", { isWebhook: true }),
    s.message("x", { authorId: "someone" }),
    s.message("x", { guildId: "guild-9" }),
    s.message("x", { guildId: null }),
  ];
  for (const msg of dropped) assert.equal(await s.channels.handleMessage(msg), true);
  assert.equal(await s.channels.handleMessage(s.message("x", { channelId: "inbox-1" })), false);
  await s.settle();
  assert.equal(s.sends.get(1), undefined);
  assert.equal(s.gateway.posts.length, 0);
  // 既定の人格（default）と書いたものは受ける
  await s.channels.handleMessage(s.message("y", { persona: "default" }));
  assert.equal(s.sends.get(1)?.origin, "discord");
});

test("発言: resuming の間は「起動中です」で断り、ended のチャンネル（CC13）は一覧に無ければ積まずに [起動して続ける]、一覧にあれば開き直して積む", async (t) => {
  const s = setup(t);
  assert.equal(s.store.setState("cc-1", "resuming"), true);
  const resuming = s.message("x");
  await s.channels.handleMessage(resuming);
  s.store.setState("cc-1", "ended");
  // 一覧に無い
  const listed = s.snapshot.sessions;
  s.snapshot.sessions = listed.filter((view) => view.sessionId !== S1);
  await s.channels.handleMessage(s.message("x"));
  await s.settle();
  assert.equal(s.sends.get(1), undefined);
  // 一覧にある（/cc close で閉じただけ）: 開き直して積む
  s.snapshot.sessions = listed;
  await s.channels.handleMessage(s.message("y"));
  await s.settle();
  assert.equal(s.store.get("cc-1")?.state, "open");
  assert.equal(s.sends.get(1)?.text, "y");
  assert.deepEqual(
    s.gateway.posts.slice(0, 3).map((post) => [post.message.text, post.message.replyToId]),
    [
      [CC_RESUMING_REPLY, resuming.id],
      [CC_RESUME_PROMPT_TEXT, "m-2"],
      [CC_CHANNEL_REOPENED_TEXT, undefined],
    ],
  );
});

test("印: 確かめられなければ ⚠️ と返信、送り先が消えたら ❌ と理由、待ちの上限なら ❌ と諦めた返信、/cc cancel で ⏳ を外す、ダイアログで待つ間は 1 回だけ返信", async (t) => {
  const s = setup(t);
  // 貼っても入力欄に出ない → unconfirmed
  const unconfirmed = s.message("届いたか分からない");
  await s.channels.handleMessage(unconfirmed);
  await s.settle();
  assert.equal(s.sends.get(1)!.state, "unconfirmed");
  assert.deepEqual(s.gateway.reactionsOn("cc-1", unconfirmed.id), [CC_MARK_UNCONFIRMED]);
  // ダイアログ → 積んだまま 1 回だけ返信
  s.env.phase = "before";
  s.env.screens.before = DIALOG;
  const dialog = s.message("ダイアログ");
  await s.channels.handleMessage(dialog);
  await s.sender.kick();
  await s.settle();
  assert.equal(s.sends.get(2)!.state, "queued");
  // 待ちの上限（120 分）を過ぎた → gave_up
  s.clock.now += 121 * 60_000;
  await s.sender.kick();
  await s.settle();
  assert.equal(s.sends.get(2)!.state, "gave_up");
  assert.deepEqual(s.gateway.reactionsOn("cc-1", dialog.id), [CC_MARK_FAILED]);
  // 送り先が一覧から消えた → failed（gone）
  s.env.screens.before = BUSY;
  const gone = s.message("消える");
  await s.channels.handleMessage(gone);
  await s.settle();
  s.snapshot.sessions = [s.snapshot.sessions[1]!];
  await s.sender.kick();
  await s.settle();
  assert.equal(s.sends.get(3)!.state, "failed");
  assert.deepEqual(s.gateway.reactionsOn("cc-1", gone.id), [CC_MARK_FAILED]);
  s.snapshot.sessions = [view(S1, 500, "alpha"), view(S2, 600, "beta")];
  // /cc cancel: queued を全部取り消して ⏳ を外す（返信は無い）
  const a = s.message("取り消す 1");
  const b = s.message("取り消す 2");
  await s.channels.handleMessage(a);
  await s.channels.handleMessage(b);
  await s.settle();
  assert.deepEqual(s.gateway.reactionsOn("cc-1", a.id), [CC_MARK_WAITING]);
  assert.equal(s.channels.cancelQueued("cc-1"), 2);
  assert.equal(s.channels.cancelQueued("cc-1"), 0);
  assert.equal(s.channels.cancelQueued("inbox-1"), undefined);
  await s.settle();
  assert.deepEqual([s.sends.get(4)!.state, s.sends.get(5)!.state], ["cancelled", "cancelled"]);
  assert.deepEqual(s.gateway.reactionsOn("cc-1", a.id), []);
  assert.deepEqual(s.gateway.reactionsOn("cc-1", b.id), []);
  assert.deepEqual(
    s.gateway.posts.map((post) => [post.message.text, post.message.replyToId]),
    [
      [CC_UNCONFIRMED_REPLY, unconfirmed.id],
      [CC_DIALOG_REPLY, dialog.id],
      [CC_GAVE_UP_REPLY, dialog.id],
      [ccFailedReply("gone"), gone.id],
    ],
  );
  assert.equal(ccFailedReply("gone"), "送れませんでした（セッションが一覧にありません）");
  assertQuietLogs(s.logs);
});

test("きっかけ（Web から送った）: queued の直後に web_send のチャンネルを作り、最初の投稿と「（Web から）」の写しを出して message_id を写しに。2 回目は作らない", async (t) => {
  const s = setup(t);
  s.env.screens.pasted = shown(SECRET_TEXT);
  const result = await s.sender.submit({ sessionId: S2, text: SECRET_TEXT, origin: "web" });
  assert.equal(result.ok, true);
  assert.equal(result.ok && result.channelId, "chan-1");
  const channel = s.store.openFor(S2)!;
  assert.deepEqual([channel.channelId, channel.origin, channel.guildId], ["chan-1", "web_send", "guild-1"]);
  assert.match(s.gateway.posts[0]!.message.text, /Web からの送信 で作りました）。ここに書くとこのセッションに届きます。返事と許可の要求はここに出ます/);
  assert.doesNotMatch(s.gateway.posts[0]!.message.text, /届きません/);
  assert.deepEqual([s.gateway.posts[1]!.channelId, s.gateway.posts[1]!.message.text], ["chan-1", `（Web から）\n${SECRET_TEXT}`]);
  assert.equal(s.gateway.posts[1]!.message.suppressEmbeds, true);
  // 写し → 積む の順（写しを返信先にしてから貼る）
  const row = s.sends.get(1)!;
  assert.deepEqual([row.origin, row.channelId, row.messageId], ["web", "chan-1", s.gateway.posts[1]!.messageId]);
  await s.settle();
  assert.equal(s.sends.get(1)!.state, "delivered");
  assert.deepEqual(s.gateway.reactionsOn("chan-1", s.gateway.posts[1]!.messageId), [CC_MARK_DELIVERED]);
  // 2 回目: チャンネルは作らず写しだけ
  s.env.phase = "before";
  s.env.screens.pasted = shown("2 回目");
  await s.sender.submit({ sessionId: S2, text: "2 回目", origin: "web" });
  await s.settle();
  assert.equal(s.gateway.callsOf("createTextChannel").length, 1);
  assert.equal(s.gateway.posts[2]!.message.text, "（Web から）\n2 回目");
  assertQuietLogs(s.logs);
});

test("きっかけ: カテゴリが無ければ作らず写さないが送信は積んで届け、#system に 1 行（同じ理由は 1 時間に 1 回）", async (t) => {
  const s = setup(t, { setUp: false });
  s.env.screens.pasted = shown("x");
  const first = await s.sender.submit({ sessionId: S2, text: "x", origin: "web" });
  assert.equal(first.ok && first.channelId, undefined);
  await s.settle();
  assert.equal(s.sends.get(1)!.state, "delivered");
  assert.equal(s.sends.get(1)!.channelId, null);
  assert.equal(s.gateway.posts.length, 0);
  assert.equal(s.gateway.callsOf("createTextChannel").length, 0);
  s.env.phase = "before";
  s.env.screens.pasted = shown("y");
  await s.sender.submit({ sessionId: S2, text: "y", origin: "web" });
  await s.settle();
  assert.equal(s.notices.length, 1);
  assert.equal(s.notices[0]!.guildId, "guild-1");
  assert.match(s.notices[0]!.message.text, /\/setup/);
});

test("きっかけ（cc_send の [送る]）: tool_send で頼んだチャンネルのサーバーに作り、「（<#…> から）」の写しを返信先に。確認だけでは作らない", async (t) => {
  const s = setup(t);
  s.env.screens.before = BUSY;
  const proposed = await s.sender.propose({ sessionId: S2, text: "頼んだ本文", channelId: "inbox-1" });
  assert.equal(proposed.ok, true);
  assert.equal(s.gateway.callsOf("createTextChannel").length, 0);
  assert.equal(s.sender.confirm(1), "queued");
  assert.equal(await s.sender.announce(1), "chan-1");
  await s.settle();
  assert.equal(s.store.openFor(S2)?.origin, "tool_send");
  const mirror = s.gateway.posts[1]!;
  assert.equal(mirror.message.text, "（<#inbox-1> から）\n頼んだ本文");
  assert.deepEqual([s.sends.get(1)!.channelId, s.sends.get(1)!.messageId], ["chan-1", mirror.messageId]);
  assert.deepEqual(s.gateway.reactionsOn("chan-1", mirror.messageId), [CC_MARK_WAITING]);
});

test("きっかけ（[対応]・起動）: github は github で作って「（#github の [対応]）」、起動を結びつけたら web_start で作って最初の指示を写す（届いた後なら返信先にしない）", async (t) => {
  const s = setup(t);
  s.env.screens.before = BUSY;
  await s.sender.submit({ sessionId: S2, text: "対応依頼", origin: "github", notificationId: 3 });
  await s.settle();
  assert.equal(s.store.openFor(S2)?.origin, "github");
  assert.equal(s.gateway.posts[1]!.message.text, "（#github の [対応]）\n対応依頼");

  const t2 = setup(t);
  // 届けた後の最初の指示
  const delivered = t2.sends.add({ sessionId: S2, paneId: "%2", text: "最初の指示", origin: "start", state: "queued" });
  t2.sends.transition(delivered.id, ["queued"], "delivering");
  t2.sends.transition(delivered.id, ["delivering"], "delivered");
  await t2.channels.started({ sessionId: S2, startedBy: "web", sendId: delivered.id });
  await t2.settle();
  assert.equal(t2.store.openFor(S2)?.origin, "web_start");
  assert.equal(t2.gateway.posts[1]!.message.text, "（起動の最初の指示）\n最初の指示");
  assert.equal(t2.sends.get(delivered.id)!.messageId, null);
  // cc_start の起動は頼んだチャンネルのサーバーに tool_start で。既にあれば作らない
  await t2.channels.started({ sessionId: S2, startedBy: "tool", channelId: "inbox-1" });
  assert.equal(t2.gateway.callsOf("createTextChannel").length, 1);
});

test("作らない: 一覧の候補を見る・オーナーの発言（既にある）・チャンネルの無いセッションの発言は作らない", async (t) => {
  const s = setup(t);
  s.channels.pickItems();
  s.env.screens.before = BUSY;
  await s.channels.handleMessage(s.message("x"));
  await s.settle();
  assert.equal(s.gateway.callsOf("createTextChannel").length, 0);
  assert.equal(s.store.openFor(S2), undefined);
});

test("ccMirrorTexts: 見出し + 改行 + 本文で、2,000 字を超える分は 2 通目以降に（字を落とさない）", () => {
  const body = "字".repeat(4000);
  const texts = ccMirrorTexts("（Web から）", body);
  assert.equal(texts.length, 3);
  assert.ok(texts.every((text) => [...text].length <= 2000));
  assert.equal(texts.join("").replace("（Web から）\n", ""), body);
});

test("再起動: delivering のまま残った発言は unconfirmed にし、Discord につないだ後（start）に ⚠️ と返信を付け直す", async (t) => {
  const s = setup(t);
  const row = s.sends.add({ sessionId: S1, text: "貼っていた", origin: "discord", state: "queued", channelId: "cc-1", messageId: "m-old" });
  s.sends.transition(row.id, ["queued"], "delivering");
  s.sender.recover();
  assert.equal(s.sends.get(row.id)!.state, "unconfirmed");
  await s.settle();
  assert.deepEqual(s.gateway.reactionsOn("cc-1", "m-old"), []);
  s.sender.start();
  s.sender.stop();
  await s.settle();
  assert.deepEqual(s.gateway.reactionsOn("cc-1", "m-old"), [CC_MARK_UNCONFIRMED]);
  assert.deepEqual(s.gateway.posts.map((post) => [post.message.text, post.message.replyToId]), [[CC_UNCONFIRMED_REPLY, "m-old"]]);
});

test("[対応]・[起動して送る]（Discord）: 押したサーバー（guildId）に作る。DB の channel_id には入れない。許可外のサーバーなら既定のサーバー", async (t) => {
  const s = setup(t);
  s.guildSettings.setChannel("guild-2", "homeCategoryId", "home-2");
  s.guildSettings.setCcCategory("guild-2", "cat-cc-2");
  s.gateway.alive.add("cat-cc-2");
  s.env.screens.before = BUSY;
  await s.sender.submit({ sessionId: S2, text: "対応依頼", origin: "github", notificationId: 3, guildId: "guild-2" });
  await s.settle();
  assert.deepEqual([s.store.openFor(S2)?.guildId, s.store.openFor(S2)?.origin], ["guild-2", "github"]);
  // 写しの後の channel_id は cc のチャンネル（#github ではない）
  assert.equal(s.sends.get(1)!.channelId, "chan-1");

  const t2 = setup(t);
  await t2.channels.started({ sessionId: S2, startedBy: "github", guildId: "guild-9" });
  assert.equal(t2.store.openFor(S2)?.guildId, "guild-1");
});

test("再起動: 待ちの上限を過ぎた queued の発言は recover で gave_up にし、start で ❌ と返信を付ける", async (t) => {
  const s = setup(t);
  const row = s.sends.add({ sessionId: S1, text: "古い", origin: "discord", state: "queued", channelId: "cc-1", messageId: "m-old" });
  s.clock.now += 121 * 60_000;
  s.sender.recover();
  assert.equal(s.sends.get(row.id)!.state, "gave_up");
  await s.settle();
  assert.deepEqual(s.gateway.reactionsOn("cc-1", "m-old"), []);
  s.sender.start();
  s.sender.stop();
  await s.settle();
  assert.deepEqual(s.gateway.reactionsOn("cc-1", "m-old"), [CC_MARK_FAILED]);
  assert.deepEqual(s.gateway.posts.map((post) => [post.message.text, post.message.replyToId]), [[CC_GAVE_UP_REPLY, "m-old"]]);
});

test("発言: 5 秒以内に同じ本文を 2 回書いたら 2 通目は積まず、前の行の印（⏳）を付け、届いたら 2 通目も ✅ にする（返信は 1 通目だけ）", async (t) => {
  const s = setup(t);
  s.env.screens.before = BUSY;
  const first = s.message("同じ");
  const second = s.message("同じ");
  await s.channels.handleMessage(first);
  await s.channels.handleMessage(second);
  await s.settle();
  assert.equal(s.sends.get(2), undefined);
  assert.deepEqual(s.gateway.reactionsOn("cc-1", second.id), [CC_MARK_WAITING]);
  s.env.screens.before = EMPTY;
  s.env.screens.pasted = shown("同じ");
  await s.sender.kick();
  await s.settle();
  assert.equal(s.sends.get(1)!.state, "delivered");
  assert.deepEqual(s.gateway.reactionsOn("cc-1", first.id), [CC_MARK_DELIVERED]);
  assert.deepEqual(s.gateway.reactionsOn("cc-1", second.id), [CC_MARK_DELIVERED]);
  // 終わった後の同じ本文（5 秒以内）には、終わりの印をすぐ付ける
  const third = s.message("同じ");
  await s.channels.handleMessage(third);
  await s.settle();
  assert.deepEqual(s.gateway.reactionsOn("cc-1", third.id), [CC_MARK_DELIVERED]);
  assert.equal(s.gateway.posts.length, 0);
});

// ===== Web の会話（CC14。docs/plan/claude-code-channels.md §5.2） =====
/** そのチャンネルの history の行（種類・出所・本文・message_id） */
function rowsOf(s: ReturnType<typeof setup>, channelId: string) {
  return s.history.list(channelId, { limit: 50 }).map((row) => [row.kind, row.source, row.text, row.messageId, row.guildId, row.persona]);
}

test("Web の会話（CC14）: オーナーの発言は owner（discord・message_id）、届かなかった・ダイアログは notice。history を渡さなければ書かない", async (t) => {
  const s = setup(t, { history: true });
  s.env.screens.pasted = shown(SECRET_TEXT);
  const msg = s.message(SECRET_TEXT);
  await s.channels.handleMessage(msg);
  await s.settle();
  // 2 回目: 貼っても入力欄に出ない → unconfirmed
  s.env.phase = "before";
  s.env.screens.pasted = EMPTY;
  const second = s.message("届いたか分からない");
  await s.channels.handleMessage(second);
  await s.settle();
  assert.equal(s.sends.get(2)!.state, "unconfirmed");
  assert.deepEqual(rowsOf(s, "cc-1"), [
    ["owner", "discord", SECRET_TEXT, msg.id, "guild-1", "default"],
    ["owner", "discord", "届いたか分からない", second.id, "guild-1", "default"],
    ["notice", "system", CC_UNCONFIRMED_REPLY, null, "guild-1", "default"],
  ]);
  // 二重送信の規則で積まなかった発言は書かない
  await s.channels.handleMessage(s.message("届いたか分からない"));
  assert.equal(s.history.list("cc-1", { limit: 50 }).length, 3);

  const quiet = setup(t);
  await quiet.channels.handleMessage(quiet.message("x"));
  await quiet.settle();
  assert.equal(quiet.history.list("cc-1", { limit: 50 }).length, 0);
});

test("Web の会話（CC14）: submitWeb は /send と同じ origin web で積み、写し「（Web から）」・owner（web・message_id は写し）・cc_sends の channel_id と message_id が写し", async (t) => {
  const s = setup(t, { history: true });
  s.env.screens.pasted = shown(SECRET_TEXT);
  const result = await s.channels.submitWeb("cc-1", `${SECRET_TEXT}\n`);
  assert.equal(result.ok, true);
  const mirror = s.gateway.posts[0]!;
  assert.deepEqual([mirror.channelId, mirror.message.text], ["cc-1", `（Web から）\n${SECRET_TEXT}`]);
  assert.deepEqual(result, { ok: true, sendId: 1, channelId: "cc-1", messageId: mirror.messageId });
  const row = s.sends.get(1)!;
  assert.deepEqual([row.origin, row.sessionId, row.channelId, row.messageId, row.text], ["web", S1, "cc-1", mirror.messageId, SECRET_TEXT]);
  assert.deepEqual(rowsOf(s, "cc-1"), [["owner", "web", SECRET_TEXT, mirror.messageId, "guild-1", "default"]]);
  await s.settle();
  assert.equal(s.sends.get(1)!.state, "delivered");
  // 届け待ちがあれば already_queued（/send と同じ）
  s.env.phase = "before";
  s.env.screens.before = BUSY;
  await s.channels.submitWeb("cc-1", "1");
  assert.deepEqual(await s.channels.submitWeb("cc-1", "2"), { ok: false, reason: "already_queued" });
  // 形の違う本文・cc でない・終わった・起動中は積まない
  assert.deepEqual(await s.channels.submitWeb("cc-1", "a\tb"), { ok: false, reason: "invalid_text" });
  assert.deepEqual(await s.channels.submitWeb("inbox-1", "x"), { ok: false, reason: "not_channel" });
  s.store.setState("cc-1", "ended");
  assert.deepEqual(await s.channels.submitWeb("cc-1", "x"), { ok: false, reason: "ended" });
  s.store.setState("cc-1", "resuming");
  assert.deepEqual(await s.channels.submitWeb("cc-1", "x"), { ok: false, reason: "resuming" });
  assertQuietLogs(s.logs);
});

test("Web の会話（CC14）: ツール・GitHub の写しは owner（system・見出し付き）、終わった・戻った・閉じたは notice、[起動して続ける] の前の発言は owner と notice", async (t) => {
  const s = setup(t, { history: true });
  s.env.screens.before = BUSY;
  await s.sender.submit({ sessionId: S1, text: "ツールから", origin: "tool", channelId: "inbox-1" });
  await s.settle();
  assert.equal(s.channels.ended({ sessionId: S1 }), true);
  assert.equal(s.channels.revived({ sessionId: S1 }), true);
  // Web から閉じた: チャンネルにも閉じた文を出す
  const closed = s.channels.close("cc-1", { fromWeb: true });
  assert.equal(closed.result, "closed");
  s.channels.postClosed("cc-1", CC_CHANNEL_CLOSED_TEXT);
  // 一覧に無いセッションの終わったチャンネルへの発言
  s.snapshot.sessions = s.snapshot.sessions.filter((view) => view.sessionId !== S1);
  const late = s.message("続けたい");
  await s.channels.handleMessage(late);
  await s.settle();
  const rows = rowsOf(s, "cc-1").map(([kind, source, text, messageId]) => [kind, source, text, messageId === null ? null : "id"]);
  assert.deepEqual(rows, [
    ["owner", "system", "（cc_send から）\nツールから", "id"],
    ["notice", "system", CC_CHANNEL_ENDED_TEXT, null],
    ["notice", "system", CC_CHANNEL_REVIVED_TEXT, null],
    ["notice", "system", CC_CHANNEL_CLOSED_TEXT, null],
    ["owner", "discord", "続けたい", "id"],
    ["notice", "system", CC_RESUME_PROMPT_TEXT, null],
  ]);
  assert.ok(s.gateway.posts.some((post) => post.channelId === "cc-1" && post.message.text === CC_CHANNEL_CLOSED_TEXT));
  assert.ok(s.logs.some((line) => line.includes("Web からチャンネルを閉じました")));
  assertQuietLogs(s.logs);
});
