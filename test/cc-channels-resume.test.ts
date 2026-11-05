// Claude Code のチャンネルの CC13（docs/plan/claude-code-channels.md §3.6・§3.8）: 終わったチャンネルでの [起動して続ける]・/cc close・削除の確認。
// 本物の CcChannels と CcChannelStore・偽の starter・偽 Gateway・一時 SQLite
import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { CC_START_RETRY_NOTE, ccStartedTexts } from "../src/app/commands/cc-confirm.ts";
import { ccClosedCancelledText, closeReply, createCcCommand, createCcComponent } from "../src/app/commands/cc.ts";
import { ALREADY_HANDLED_TEXT, STALE_TEXT } from "../src/app/commands/delete.ts";
import { STALE_TURN_REPLY } from "../src/app/commands/turn-controls.ts";
import {
  CC_ATTACHMENT_REPLY,
  CC_CHANNEL_CLOSED_TEXT,
  CC_CHANNEL_ENDED_TEXT,
  CC_CHANNEL_REOPENED_TEXT,
  CC_CHANNEL_REVIVED_TEXT,
  CC_MARK_WAITING,
  CC_RESUME_BAD_PLACE_TEXT,
  CC_RESUME_GAVE_UP_TEXT,
  CC_RESUME_KEPT_TEXT,
  CC_RESUME_PROMPT_TEXT,
  CC_RESUME_STALE_TEXT,
  CC_RESUMING_REPLY,
  CcChannels,
  type CcResumeResult,
  ccDeletedText,
  ccKeptText,
  ccResumeButtons,
  ccResumedText,
  ccChannelTopic,
  resumeProject,
} from "../src/cc/channels.ts";
import type { CcSessionView } from "../src/cc/registry.ts";
import type { CcStartInput, CcStartResult } from "../src/cc/starter.ts";
import type { IncomingMessage, Interaction } from "../src/discord/gateway.ts";
import { CcChannelStore } from "../src/store/cc-channels.ts";
import { CcSendStore } from "../src/store/cc-sends.ts";
import { CcSessionStore } from "../src/store/cc-sessions.ts";
import { GuildSettingsStore } from "../src/store/guild-settings.ts";
import { tempDb } from "./helpers/db.ts";
import { FakeGateway } from "./helpers/gateway.ts";
import { RecordingChannelOps, RecordingQueue } from "./helpers/recording.ts";
import { FakeResponder } from "./helpers/responder.ts";

const BASE = Date.parse("2026-11-05T00:00:00.000Z");
const OLD = "11111111-1111-4111-8111-111111111111";
const NEW = "22222222-2222-4222-8222-222222222222";
const LIVE = "33333333-3333-4333-8333-333333333333";
const WORKSPACE = "/home/owner/workspace";
const OWNER = "owner-1";
const CHANNEL = "900000000000000001";
const SECRET_TEXT = "secret-body";

function setup(t: TestContext) {
  const db = tempDb(t);
  const clock = { now: BASE };
  const now = (): Date => new Date(clock.now);
  const store = new CcChannelStore(db, now);
  const sends = new CcSendStore(db, now);
  const ccSessions = new CcSessionStore(db, now);
  const guildSettings = new GuildSettingsStore(db, now);
  guildSettings.setChannel("guild-1", "homeCategoryId", "home-1");
  guildSettings.setCcCategory("guild-1", "cat-cc");
  const gateway = new FakeGateway({
    allow: ["sendMessage", "editMessage", "channelExists", "countChannelsIn"],
    record: ["createTextChannel", "addReaction", "removeOwnReaction", "setChannelTopic"],
    messageIdPrefix: "msg-",
  });
  const sessions: CcSessionView[] = [];
  const launches: CcStartInput[] = [];
  // 偽の sender（積む・取り消す。印は channels の announce・settled で）
  let channelsRef: CcChannels | undefined;
  const submitted: string[] = [];
  const sender = {
    submit: async (input: { sessionId: string; text: string; origin: "discord"; channelId: string; messageId: string }) => {
      submitted.push(input.text);
      const send = sends.add({ sessionId: input.sessionId, text: input.text, origin: input.origin, state: "queued", channelId: input.channelId, messageId: input.messageId });
      await channelsRef?.announce(send);
      return { ok: true as const, send, duplicate: false };
    },
    cancel: (id: number) => {
      if (!sends.transition(id, ["queued"], "cancelled")) return "stale" as const;
      channelsRef?.settled(sends.get(id)!);
      return "cancelled" as const;
    },
  };
  const starterState = {
    result: { ok: true, tmuxSession: "alpha", paneId: "%9", sendId: undefined } as CcStartResult,
    available: true,
    throws: false,
  };
  const starter = {
    launch: async (input: CcStartInput): Promise<CcStartResult> => {
      launches.push(input);
      if (starterState.throws) throw new Error("boom");
      const result = starterState.result;
      // 起動の最初の指示（starter が積む形）
      if (result.ok && typeof input.text === "string") {
        const send = sends.add({ sessionId: null, paneId: "%9", startDir: `${WORKSPACE}/alpha`, text: input.text, state: "queued", origin: "start", channelId: input.channelId });
        return { ...result, sendId: send.id };
      }
      return result;
    },
  };
  const channelOps = new RecordingChannelOps();
  const logs: string[] = [];
  const channels = new CcChannels({
    cfg: { allowedGuildIds: ["guild-1"], workspaceDir: WORKSPACE, ownerUserId: OWNER },
    store,
    sends,
    sender: () => sender,
    starter: () => (starterState.available ? starter : undefined),
    sessions: ccSessions,
    guildSettings,
    registry: { snapshot: () => ({ sessions, stale: false, unreadable: false, fetchedAt: BASE }) },
    panes: { lookup: async () => ({ ok: false, reason: "no_server" }) as never },
    gateway,
    queue: new RecordingQueue(1),
    channelOps,
    notify: async () => "notice-1",
    home: "/home/owner",
    now,
    log: (line) => logs.push(line),
  });
  channelsRef = channels;
  // 終わったセッション（名前 alpha・~/workspace/alpha）のチャンネル
  // cwd は cc_sessions のものを使う（cc_channels の cwd は無くてよい）
  ccSessions.upsertSeen([{ sessionId: OLD, pid: 100, cwd: `${WORKSPACE}/alpha`, name: "alpha" }]);
  store.create({ channelId: CHANNEL, guildId: "guild-1", sessionId: OLD, name: "cc-alpha", cwd: null, origin: "web" });
  store.setState(CHANNEL, "ended");
  let nextMessage = 1;
  const message = (content: string, overrides: Partial<IncomingMessage> = {}): IncomingMessage => ({
    id: `80000000000000000${nextMessage++}`,
    channelId: CHANNEL,
    guildId: "guild-1",
    authorId: OWNER,
    authorIsBot: false,
    isWebhook: false,
    content,
    createdAt: new Date(clock.now),
    ...overrides,
  });
  return { db, clock, store, sends, ccSessions, gateway, sessions, launches, starterState, channelOps, logs, channels, message, submitted };
}

/** 起動できなかった結果（stale・expired と成功は undefined） */
function failure(result: CcResumeResult): Extract<CcResumeResult, { message: unknown; ok: false }> | undefined {
  return !result.ok && "message" in result ? result : undefined;
}

/** log にチャンネル ID・本文・名前・sessionId を出していない */
function assertQuietLogs(logs: readonly string[]): void {
  for (const line of logs) assert.doesNotMatch(line, /9000|8000|secret|alpha|1111|2222|3333/, line);
}

test("resumeProject: cwd の親が SELF_AGENT_WORKSPACE_DIR のときだけ最後の名前", () => {
  assert.equal(resumeProject(`${WORKSPACE}/alpha`, WORKSPACE), "alpha");
  assert.equal(resumeProject(`${WORKSPACE}/alpha`, `${WORKSPACE}/`), "alpha");
  // cwd の末尾の / は落とす
  assert.equal(resumeProject(`${WORKSPACE}/alpha/`, WORKSPACE), "alpha");
  assert.equal(resumeProject(`${WORKSPACE}/`, WORKSPACE), undefined);
  assert.equal(resumeProject(`${WORKSPACE}/alpha/sub`, WORKSPACE), undefined);
  assert.equal(resumeProject("/tmp/alpha", WORKSPACE), undefined);
  assert.equal(resumeProject(null, WORKSPACE), undefined);
});

test("終了の 1 行は §3.6 の文（ここに書くと起動して続けられる）", () => {
  assert.equal(CC_CHANNEL_ENDED_TEXT, "セッションが終わりました。ここに書くと、同じディレクトリで起動して続けられます");
});

test("続ける: 終わったチャンネルの発言は積まずに [起動して続ける][やめる] を返信する。送れない形・添付だけは断る", async (t) => {
  const s = setup(t);
  const msg = s.message(SECRET_TEXT);
  assert.equal(await s.channels.handleMessage(msg), true);
  await s.channels.idle();
  assert.equal(s.sends.get(1), undefined);
  assert.equal(s.launches.length, 0);
  assert.deepEqual(s.gateway.posts.at(-1)?.message, {
    text: CC_RESUME_PROMPT_TEXT,
    replyToId: msg.id,
    suppressEmbeds: true,
    components: ccResumeButtons(CHANNEL, msg.id),
  });
  const buttons = ccResumeButtons(CHANNEL, msg.id)[0]!;
  assert.deepEqual(buttons.kind === "buttons" ? buttons.buttons.map((button) => button.customId) : [], [
    `cc:resume:${CHANNEL}:${msg.id}`,
    `cc:resume:keep:${CHANNEL}:${msg.id}`,
  ]);
  // 添付だけ
  await s.channels.handleMessage(s.message("", { images: [{ url: "x" } as never] }));
  assert.equal(s.gateway.posts.at(-1)?.message.text, CC_ATTACHMENT_REPLY);
  assertQuietLogs(s.logs);
});

test("[起動して続ける]: resuming に compare-and-set し（2 回目は古い・その間の発言は「起動中です」）、cwd・題名・本文・tool で launch。最初の指示はその発言に ⏳", async (t) => {
  const s = setup(t);
  const msg = s.message(SECRET_TEXT);
  await s.channels.handleMessage(msg);
  const result = await s.channels.resume(CHANNEL, msg.id, "guild-1");
  assert.deepEqual(result, { ok: true, message: { text: ccStartedTexts("alpha", false)[0], components: [] } });
  assert.equal(s.store.get(CHANNEL)?.state, "resuming");
  assert.equal(s.launches.length, 1);
  const input = s.launches[0]!;
  assert.deepEqual(
    [input.project, input.title, input.text, input.startedBy, input.channelId, input.guildId, input.resumeChannelId],
    ["alpha", "alpha", SECRET_TEXT, "tool", CHANNEL, "guild-1", CHANNEL],
  );
  // 最初の指示の返信先はその発言
  const send = s.sends.get(1)!;
  assert.deepEqual([send.channelId, send.messageId], [CHANNEL, msg.id]);
  await s.channels.idle();
  assert.deepEqual(s.gateway.reactionsOn(CHANNEL, msg.id), [CC_MARK_WAITING]);
  // 2 回目の押下は古い（二重起動しない）
  assert.deepEqual(await s.channels.resume(CHANNEL, msg.id, "guild-1"), { ok: false, reason: "stale" });
  assert.equal(s.launches.length, 1);
  // resuming の間の発言は断る
  const during = s.message("まだ");
  await s.channels.handleMessage(during);
  assert.deepEqual([s.gateway.posts.at(-1)?.message.text, s.gateway.posts.at(-1)?.message.replyToId], [CC_RESUMING_REPLY, during.id]);
  // 保留していない発言のボタン（再起動で消えた）は expired
  assert.deepEqual(await s.channels.resume(CHANNEL, "800000000000000099", "guild-1"), { ok: false, reason: "expired" });
  // trust の確認待ちは確認の投稿の書き換え
  input.onTrustPending?.();
  await s.channels.idle();
  assert.deepEqual(s.gateway.edits.at(-1)?.message, { text: ccStartedTexts("alpha", true)[0], components: [] });
  assertQuietLogs(s.logs);
});

test("[起動して続ける]: 結びついたら session_id を付け替え（previous_session_id に前の id）、open・topic・カテゴリ「Claude Code」へ。新しいチャンネルは作らない", async (t) => {
  const s = setup(t);
  const msg = s.message(SECRET_TEXT);
  await s.channels.handleMessage(msg);
  await s.channels.resume(CHANNEL, msg.id, "guild-1");
  s.sessions.push({ sessionId: NEW, pid: 200, name: "alpha", cwd: `${WORKSPACE}/alpha`, tmux: undefined, state: "idle" } as CcSessionView);
  await s.channels.started({ sessionId: NEW, startedBy: "tool", channelId: CHANNEL, sendId: 1, guildId: "guild-1", resumeChannelId: CHANNEL });
  await s.channels.idle();
  const row = s.store.get(CHANNEL)!;
  assert.deepEqual([row.state, row.sessionId, row.previousSessionId, row.endedAt], ["open", NEW, OLD, null]);
  assert.equal(s.store.anyFor(OLD), undefined);
  assert.deepEqual(
    s.gateway.calls.filter((call) => call.method === "createTextChannel"),
    [],
  );
  assert.deepEqual(
    s.gateway.calls.filter((call) => call.method === "setChannelTopic"),
    [{ method: "setChannelTopic", channelId: CHANNEL, topic: ccChannelTopic("alpha", "alpha") }],
  );
  assert.deepEqual(s.channelOps.moves.at(-1), { channelId: CHANNEL, target: { kind: "category", categoryId: "cat-cc" } });
  assert.equal(s.gateway.posts.at(-1)?.message.text, ccResumedText("alpha"));
  // 前の id が一覧に戻っても開き直さない（付け替え済み）
  assert.equal(s.channels.revived({ sessionId: OLD }), false);
  // 付け替えた後のボタンは古い（保留を捨てている）
  assert.deepEqual(await s.channels.resume(CHANNEL, msg.id, "guild-1"), { ok: false, reason: "expired" });
  assertQuietLogs(s.logs);
});

test("[起動して続ける]: 直下でない cwd は断って ended に戻す。起動の失敗も ended に戻してボタンを残し、もう一度押せる。結びつけられなければ ended に戻す", async (t) => {
  const s = setup(t);
  // 直下でない
  s.store.create({ channelId: "900000000000000002", guildId: "guild-1", sessionId: LIVE, name: "cc-deep", cwd: `${WORKSPACE}/a/b`, origin: "web" });
  s.store.setState("900000000000000002", "ended");
  const deep = s.message("x", { channelId: "900000000000000002" });
  await s.channels.handleMessage(deep);
  assert.deepEqual(await s.channels.resume("900000000000000002", deep.id, "guild-1"), {
    ok: false,
    reason: "bad_place",
    message: { text: CC_RESUME_BAD_PLACE_TEXT, components: [] },
  });
  assert.equal(s.store.get("900000000000000002")?.state, "ended");
  assert.equal(s.launches.length, 0);

  // 起動の失敗（1 分の間隔）
  const msg = s.message(SECRET_TEXT);
  await s.channels.handleMessage(msg);
  s.starterState.result = { ok: false, reason: "too_soon" } as CcStartResult;
  const failed = failure(await s.channels.resume(CHANNEL, msg.id, "guild-1"));
  assert.equal(failed?.reason, "too_soon");
  assert.ok(failed?.message.text.endsWith(CC_START_RETRY_NOTE));
  assert.deepEqual(failed?.message.components, ccResumeButtons(CHANNEL, msg.id));
  assert.equal(s.store.get(CHANNEL)?.state, "ended");
  // もう一度押せる
  s.starterState.result = { ok: true, tmuxSession: "alpha", paneId: "%9", sendId: undefined };
  assert.equal((await s.channels.resume(CHANNEL, msg.id, "guild-1")).ok, true);
  // 結びつけられなかった（starter の onGaveUp）→ ended に戻してボタン付きに書き換える
  s.launches.at(-1)?.onGaveUp?.();
  await s.channels.idle();
  assert.equal(s.store.get(CHANNEL)?.state, "ended");
  assert.deepEqual(s.gateway.edits.at(-1)?.message, { text: `${CC_RESUME_GAVE_UP_TEXT}${CC_START_RETRY_NOTE}`, components: ccResumeButtons(CHANNEL, msg.id) });
  // 連携が止まっていれば停止中で ended のまま
  s.starterState.available = false;
  assert.equal(failure(await s.channels.resume(CHANNEL, msg.id, "guild-1"))?.reason, "stopped");
  assert.equal(s.store.get(CHANNEL)?.state, "ended");
  assertQuietLogs(s.logs);
});

test("[やめる]: 保留を捨てる（2 回目・その後の [起動して続ける] は古い）", async (t) => {
  const s = setup(t);
  const msg = s.message(SECRET_TEXT);
  await s.channels.handleMessage(msg);
  assert.equal(s.channels.keepEnded(CHANNEL, msg.id), true);
  assert.equal(s.channels.keepEnded(CHANNEL, msg.id), false);
  assert.deepEqual(await s.channels.resume(CHANNEL, msg.id, "guild-1"), { ok: false, reason: "expired" });
  assert.equal(s.store.get(CHANNEL)?.state, "ended");
});

test("/cc close: open のチャンネルを ended にして完了へ移し、届け待ちをやめる（⏳ を外す。セッションが生きていても）。次に関われば「開き直しました」", async (t) => {
  const s = setup(t);
  const LIVE_CHANNEL = "900000000000000003";
  s.sessions.push({ sessionId: LIVE, pid: 300, name: "live", cwd: `${WORKSPACE}/live`, tmux: undefined, state: "idle" } as CcSessionView);
  s.store.create({ channelId: LIVE_CHANNEL, guildId: "guild-1", sessionId: LIVE, name: "cc-live", cwd: `${WORKSPACE}/live`, origin: "web" });
  const queued = s.message(SECRET_TEXT, { channelId: LIVE_CHANNEL });
  await s.channels.handleMessage(queued);
  await s.channels.idle();
  assert.deepEqual(s.gateway.reactionsOn(LIVE_CHANNEL, queued.id), [CC_MARK_WAITING]);
  const closed = s.channels.close(LIVE_CHANNEL);
  assert.deepEqual(closed, { result: "closed", cancelled: 1 });
  await s.channels.idle();
  assert.equal(s.sends.get(1)?.state, "cancelled");
  assert.deepEqual(s.gateway.reactionsOn(LIVE_CHANNEL, queued.id), []);
  assert.equal(s.store.get(LIVE_CHANNEL)?.state, "ended");
  assert.deepEqual(s.channelOps.moves.at(-1), { channelId: LIVE_CHANNEL, target: { kind: "state", guildId: "guild-1", state: "done" } });
  assert.deepEqual(s.channels.close(LIVE_CHANNEL), { result: "ended" });
  assert.deepEqual(s.channels.close("123"), { result: "not_channel" });
  assert.deepEqual(closeReply({ result: "closed", cancelled: 0 }), { text: CC_CHANNEL_CLOSED_TEXT, ephemeral: false });
  assert.deepEqual(closeReply(closed), { text: `${CC_CHANNEL_CLOSED_TEXT}\n${ccClosedCancelledText(1)}`, ephemeral: false });
  assert.equal(closeReply({ result: "not_channel" }).ephemeral, true);
  // 関わったら（ensureFor）開き直す（戻ったときとは別の文）
  const result = await s.channels.ensureFor(LIVE, "permission");
  assert.equal(result.ok, false);
  await s.channels.idle();
  assert.equal(s.store.get(LIVE_CHANNEL)?.state, "open");
  assert.equal(s.gateway.posts.at(-1)?.message.text, CC_CHANNEL_REOPENED_TEXT);
  // 一覧に戻った（registry の revived）ときは「セッションが戻りました。」
  s.store.setState(LIVE_CHANNEL, "ended");
  assert.equal(s.channels.revived({ sessionId: LIVE }), true);
  await s.channels.idle();
  assert.equal(s.gateway.posts.at(-1)?.message.text, CC_CHANNEL_REVIVED_TEXT);
  assertQuietLogs(s.logs);
});

test("閉じただけのチャンネル: セッションが一覧にあれば、発言で開き直してそのまま積む（[起動して続ける] は出さない）。resume() でも起動せずに開き直して積む", async (t) => {
  const s = setup(t);
  const LIVE_CHANNEL = "900000000000000006";
  s.store.create({ channelId: LIVE_CHANNEL, guildId: "guild-1", sessionId: LIVE, name: "cc-live", cwd: `${WORKSPACE}/live`, origin: "web" });
  s.store.setState(LIVE_CHANNEL, "ended");
  // 一覧に無い間の発言は [起動して続ける]
  const before = s.message("前", { channelId: LIVE_CHANNEL });
  await s.channels.handleMessage(before);
  assert.equal(s.gateway.posts.at(-1)?.message.text, CC_RESUME_PROMPT_TEXT);
  assert.deepEqual(s.submitted, []);
  // 一覧に出た（/cc close で閉じただけ）
  s.sessions.push({ sessionId: LIVE, pid: 300, name: "live", cwd: `${WORKSPACE}/live`, tmux: undefined, state: "idle" } as CcSessionView);
  const posted = s.gateway.posts.length;
  const msg = s.message(SECRET_TEXT, { channelId: LIVE_CHANNEL });
  await s.channels.handleMessage(msg);
  await s.channels.idle();
  assert.equal(s.store.get(LIVE_CHANNEL)?.state, "open");
  assert.deepEqual(s.submitted, [SECRET_TEXT]);
  assert.deepEqual(s.gateway.posts.slice(posted).map((post) => post.message.text), [CC_CHANNEL_REOPENED_TEXT]);
  // 前に出した [起動して続ける] を押しても起動せず、開き直してその発言を積む
  s.store.setState(LIVE_CHANNEL, "ended");
  const result = await s.channels.resume(LIVE_CHANNEL, before.id, "guild-1");
  assert.deepEqual(result, { ok: true, message: { text: CC_CHANNEL_REOPENED_TEXT, components: [] } });
  assert.equal(s.launches.length, 0);
  assert.deepEqual(s.submitted, [SECRET_TEXT, "前"]);
  assert.equal(s.store.get(LIVE_CHANNEL)?.state, "open");
  assertQuietLogs(s.logs);
});

test("[起動して続ける]: launch が投げたら ended に戻して押し直せる結果。押したサーバーが違えば stale で起動しない", async (t) => {
  const s = setup(t);
  const msg = s.message(SECRET_TEXT);
  await s.channels.handleMessage(msg);
  assert.deepEqual(await s.channels.resume(CHANNEL, msg.id, "guild-2"), { ok: false, reason: "stale" });
  assert.equal(s.launches.length, 0);
  assert.equal(s.store.get(CHANNEL)?.state, "ended");
  s.starterState.throws = true;
  const thrown = failure(await s.channels.resume(CHANNEL, msg.id, "guild-1"));
  assert.equal(thrown?.reason, "failed");
  assert.deepEqual(thrown?.message.components, ccResumeButtons(CHANNEL, msg.id));
  assert.equal(s.store.get(CHANNEL)?.state, "ended");
  s.starterState.throws = false;
  assert.equal((await s.channels.resume(CHANNEL, msg.id, "guild-1")).ok, true);
  assertQuietLogs(s.logs);
});

test("CcChannelStore.setState: open に戻すと削除の確認を外し、また終わったら listDeleteDue に出る（rebind 経由も同じ）", (t) => {
  const s = setup(t);
  const cutoff = new Date(BASE + 1);
  assert.equal(s.store.listDeleteDue("guild-1", cutoff, 5).length, 1);
  s.store.setDeletePrompt(CHANNEL, "prompt-1");
  assert.equal(s.store.listDeleteDue("guild-1", cutoff, 5).length, 0);
  s.store.setState(CHANNEL, "open", ["ended"]);
  assert.equal(s.store.get(CHANNEL)?.deletePromptMessageId, null);
  s.store.setState(CHANNEL, "ended");
  assert.deepEqual(s.store.listDeleteDue("guild-1", cutoff, 5).map((row) => row.channelId), [CHANNEL]);
  // [起動して続ける] の付け替え（resuming → rebind → open）でも外れる
  s.store.setDeletePrompt(CHANNEL, "prompt-2");
  s.store.setState(CHANNEL, "resuming", ["ended"]);
  s.store.rebind(CHANNEL, NEW);
  s.store.setState(CHANNEL, "open", ["resuming"]);
  assert.equal(s.store.get(CHANNEL)?.deletePromptMessageId, null);
});

test("再起動: resuming のまま残った行は ended に戻す", (t) => {
  const s = setup(t);
  assert.equal(s.store.setState(CHANNEL, "resuming", ["ended"]), true);
  assert.equal(s.store.resetResuming(), 1);
  assert.equal(s.store.get(CHANNEL)?.state, "ended");
  assert.notEqual(s.store.get(CHANNEL)?.endedAt, null);
  assert.equal(s.store.resetResuming(), 0);
});

const NOW = new Date(BASE);
function button(customId: string, messageId = "prompt-1", guildId: string | null = "guild-1"): Extract<Interaction, { kind: "button" }> {
  return { kind: "button", customId, guildId, channelId: CHANNEL, userId: OWNER, messageId, messageText: "", createdAt: NOW } as Extract<Interaction, { kind: "button" }>;
}

test("cc:resume: 保留してから resume し、結果で確認を書き換える。古ければ本人にだけ。[やめる] はボタンを外す", async (t) => {
  const s = setup(t);
  const component = createCcComponent({ ccChannels: () => s.channels, gateway: s.gateway, log: () => {} });
  const msg = s.message(SECRET_TEXT);
  await s.channels.handleMessage(msg);
  const responder = new FakeResponder();
  await component.handle(button(`cc:resume:${CHANNEL}:${msg.id}`), responder);
  assert.deepEqual(responder.calls, [
    { method: "deferUpdate" },
    { method: "update", message: { text: ccStartedTexts("alpha", false)[0], components: [], suppressEmbeds: true } },
  ]);
  const again = new FakeResponder();
  await component.handle(button(`cc:resume:${CHANNEL}:${msg.id}`), again);
  assert.deepEqual(again.replies, [{ text: STALE_TURN_REPLY, ephemeral: true }]);
  // [やめる]
  s.store.setState(CHANNEL, "ended");
  const other = s.message("y");
  await s.channels.handleMessage(other);
  const keep = new FakeResponder();
  await component.handle(button(`cc:resume:keep:${CHANNEL}:${other.id}`), keep);
  assert.deepEqual(keep.calls, [{ method: "update", message: { text: CC_RESUME_KEPT_TEXT, components: [], suppressEmbeds: true } }]);
  // 保留の無い（[やめる] の後・再起動で消えた）ボタンはボタンを外して古いと書き換える
  const keepAgain = new FakeResponder();
  await component.handle(button(`cc:resume:keep:${CHANNEL}:${other.id}`), keepAgain);
  assert.deepEqual(keepAgain.calls, [{ method: "update", message: { text: CC_RESUME_STALE_TEXT, components: [], suppressEmbeds: true } }]);
  const restarted = new FakeResponder();
  await component.handle(button(`cc:resume:${CHANNEL}:800000000000000099`), restarted);
  assert.deepEqual(restarted.calls, [{ method: "deferUpdate" }, { method: "update", message: { text: CC_RESUME_STALE_TEXT, components: [], suppressEmbeds: true } }]);
  // 押したサーバーが行と違えば本人にだけ古い
  const otherMsg = s.message("z");
  await s.channels.handleMessage(otherMsg);
  const wrongGuild = new FakeResponder();
  await component.handle(button(`cc:resume:${CHANNEL}:${otherMsg.id}`, "prompt-1", "guild-2"), wrongGuild);
  assert.deepEqual(wrongGuild.replies, [{ text: STALE_TURN_REPLY, ephemeral: true }]);
  // 形の違う custom_id は例外
  await assert.rejects(component.handle(button("cc:resume:abc:def"), new FakeResponder()));
});

test("/cc close: チャンネルの中で閉じて結果をチャンネルに出す。チャンネルの外は本人にだけ断る", async (t) => {
  const s = setup(t);
  s.store.create({ channelId: "900000000000000004", guildId: "guild-1", sessionId: LIVE, name: "cc-live", cwd: null, origin: "web" });
  const command = createCcCommand({ ccChannels: () => s.channels, guildSettings: { ccCategoryId: () => "cat-cc" }, log: () => {} });
  const close = (channelId: string): Extract<Interaction, { kind: "command" }> => ({
    kind: "command",
    name: "cc",
    subcommand: "close",
    options: {},
    guildId: "guild-1",
    channelId,
    userId: OWNER,
    createdAt: NOW,
  });
  const responder = new FakeResponder();
  await command.handle(close("900000000000000004"), responder);
  assert.deepEqual(responder.replies, [{ text: CC_CHANNEL_CLOSED_TEXT, ephemeral: false, suppressEmbeds: true }]);
  const outside = new FakeResponder();
  await command.handle(close("channel-1"), outside);
  assert.equal(outside.replies[0]?.ephemeral, true);
});

test("cc:del: 記録した今の確認で ended のときだけ。[削除する] で deleteChannel → channelOps.cancel → deleted、[残す] で ended_at を今に。それ以外は DB を変えない", async (t) => {
  const s = setup(t);
  const gateway = new FakeGateway({ allow: ["deleteChannel"] });
  const channelOps = new RecordingChannelOps();
  const logs: string[] = [];
  const component = createCcComponent({
    ccDelete: { deleteAfterDays: 30, store: s.store, gateway, channelOps },
    gateway: s.gateway,
    log: (line) => logs.push(line),
  });
  s.store.setDeletePrompt(CHANNEL, "prompt-1");
  // 記録と違う確認は古い
  const stale = new FakeResponder();
  await component.handle(button(`cc:del:${CHANNEL}`, "prompt-0"), stale);
  assert.deepEqual(stale.calls, [{ method: "update", message: { text: STALE_TEXT, components: [] } }]);
  // 別のサーバーは処理済み
  const otherGuild = new FakeResponder();
  await component.handle(button(`cc:del:${CHANNEL}`, "prompt-1", "guild-2"), otherGuild);
  assert.deepEqual(otherGuild.calls, [{ method: "update", message: { text: ALREADY_HANDLED_TEXT, components: [] } }]);
  // [残す]
  s.clock.now = BASE + 1000;
  const keep = new FakeResponder();
  await component.handle(button(`cc:del:keep:${CHANNEL}`, "prompt-1"), keep);
  assert.deepEqual(keep.calls, [{ method: "update", message: { text: ccKeptText("cc-alpha", 30), components: [] } }]);
  assert.deepEqual([s.store.get(CHANNEL)?.endedAt, s.store.get(CHANNEL)?.deletePromptMessageId], [new Date(BASE + 1000).toISOString(), null]);
  assert.deepEqual(gateway.deleted, []);
  // [削除する]
  s.store.setDeletePrompt(CHANNEL, "prompt-2");
  const yes = new FakeResponder();
  await component.handle(button(`cc:del:${CHANNEL}`, "prompt-2"), yes);
  assert.deepEqual(yes.calls, [{ method: "deferUpdate" }, { method: "update", message: { text: ccDeletedText("cc-alpha"), components: [] } }]);
  assert.deepEqual(gateway.deleted, [CHANNEL]);
  assert.deepEqual(channelOps.cancelled, [CHANNEL]);
  assert.equal(s.store.get(CHANNEL)?.state, "deleted");
  // 戻った・続けた（open）チャンネルの確認は古い
  s.store.create({ channelId: "900000000000000005", guildId: "guild-1", sessionId: LIVE, name: "cc-live", cwd: null, origin: "web" });
  s.store.setDeletePrompt("900000000000000005", "prompt-3");
  const open = new FakeResponder();
  await component.handle(button("cc:del:900000000000000005", "prompt-3"), open);
  assert.deepEqual(open.calls, [{ method: "update", message: { text: STALE_TEXT, components: [] } }]);
  assert.equal(s.store.get("900000000000000005")?.state, "open");
  assertQuietLogs(logs);
});
