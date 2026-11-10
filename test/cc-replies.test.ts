import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createCcComponent } from "../src/app/commands/cc.ts";
import { STALE_TURN_REPLY } from "../src/app/commands/turn-controls.ts";
import type { AgentEntry } from "../src/cc/agents.ts";
import { parseHookEvent, type CcHookEvent } from "../src/cc/hook-server.ts";
import { CcRegistry } from "../src/cc/registry.ts";
import {
  CC_CHANNEL_REPLY_DAILY_LIMIT,
  CC_FOLLOW_IDLE_DAYS,
  CC_REPLY_DAILY_LIMIT,
  CC_REPLY_DUPLICATE_MS,
  CC_REPLY_HOLD_MS,
  CC_REPLY_PAGE_CHARS,
  CC_REPLY_WAIT_MS,
  CC_UNFOLLOW_NOTE,
  CcReplier,
  breakMaskedLinks,
  replyLimitText,
  replyTexts,
  splitReplyBody,
  unfollowedText,
} from "../src/cc/replies.ts";
import { SUPPRESS_EMBEDS_FLAG, toPayload } from "../src/discord/convert.ts";
import type { Interaction, OutgoingMessage } from "../src/discord/gateway.ts";
import { CcReplyStore } from "../src/store/cc-replies.ts";
import { CcSendStore } from "../src/store/cc-sends.ts";
import { CcSessionStore } from "../src/store/cc-sessions.ts";
import { CcStartStore } from "../src/store/cc-starts.ts";
import { MIGRATIONS, openDb } from "../src/store/db.ts";
import { HistoryStore } from "../src/store/history.ts";
import { tempDb, tempDir } from "./helpers/db.ts";
import { FakeResponder } from "./helpers/responder.ts";

// 2026-11-01 09:00（Asia/Tokyo）
const BASE = Date.parse("2026-11-01T00:00:00.000Z");
const DAY = 24 * 60 * 60_000;
const S1 = "11111111-1111-4111-8111-111111111111";
const S2 = "22222222-2222-4222-8222-222222222222";
const INBOX = "channel-inbox";
const SESSION_CHANNEL = "channel-session";
const SECRET_NAME = "secret-session-name";
const SECRET_BODY = "返事の本文（ログに出さない）";
const RC = "https://claude.ai/code/session_abc";

/** 一時 SQLite の本物のストアと偽の Bot（投稿を記録。failNext で次の投稿に失敗する）で CcReplier を作る */
function setup(t: TestContext) {
  const db = tempDb(t);
  const clock = { now: BASE };
  const now = (): Date => new Date(clock.now);
  const sessions = new CcSessionStore(db, now);
  const sends = new CcSendStore(db, now);
  const replies = new CcReplyStore(db, now);
  const history = new HistoryStore(db, now);
  sessions.upsertSeen([
    { sessionId: S1, cwd: "/w/alpha", name: SECRET_NAME, pid: 500 },
    { sessionId: S2, cwd: "/w/beta", name: "beta", pid: 600 },
  ]);
  const posted: Array<{ channelId: string; messageId: string; message: OutgoingMessage }> = [];
  const bot = {
    failNext: 0,
    async sendMessage(channelId: string, message: OutgoingMessage): Promise<string> {
      if (this.failNext > 0) {
        this.failNext--;
        throw new Error("Missing Access");
      }
      const messageId = `m-${posted.length + 1}`;
      posted.push({ channelId, messageId, message });
      return messageId;
    },
  };
  const logs: string[] = [];
  /** セッション → 開いている Claude Code のチャンネル（CC11） */
  const ccChannels = new Map<string, string>();
  const replier = new CcReplier({
    cfg: { timeZone: "Asia/Tokyo" },
    channelFor: (sessionId) => ccChannels.get(sessionId),
    isCcChannel: (channelId) => channelId.startsWith("cc-"),
    sessions,
    sends,
    replies,
    posts: bot,
    rcUrl: (sessionId) => (sessionId === S1 ? RC : undefined),
    history,
    // Claude Code のチャンネル（cc-…）も Web で開ける（CC14）
    guildOf: (channelId) => (channelId === INBOX || channelId === SESSION_CHANNEL || channelId.startsWith("cc-") ? "guild-1" : undefined),
    personaOf: () => "default",
    now,
    timers: { after: () => () => undefined },
    log: (message) => logs.push(message),
  });

  /** Discord から頼んだ送信（cc_send の確認を投稿した）が届いた */
  const deliver = (sessionId: string, channelId: string | undefined, confirmId = "confirm-1", origin: "tool" | "web" = "tool") => {
    const send = sends.add({ sessionId, text: "頼んだ本文", origin, state: "queued", ...(channelId === undefined ? {} : { channelId }) });
    if (channelId !== undefined) sends.setMessageId(send.id, confirmId);
    assert.ok(sends.transition(send.id, ["queued"], "delivering"));
    assert.ok(sends.transition(send.id, ["delivering"], "delivered"));
    replier.onSendFinished(sends.get(send.id)!);
    return send.id;
  };
  /** Stop を受けて、投稿が終わるまで待つ */
  const stop = async (sessionId: string, message: string | undefined) => {
    const event: CcHookEvent = { event: "Stop", sessionId, receivedAt: now(), ...(message === undefined ? {} : { lastAssistantMessage: message }) };
    replier.onEvent(event);
    await replier.idle();
  };
  const component = createCcComponent({
    cfg: { workspaceDir: "/w" },
    ccSends: sends,
    ccStarts: new CcStartStore(db, now),
    ccSessions: sessions,
    ccFollow: { replies, sessions },
    ccRuntime: () => undefined,
    ccPosts: { editMessage: async () => undefined },
    gateway: { editMessage: async () => undefined },
    now,
    log: (message) => logs.push(message),
  });
  /** メッセージのボタンを押す（messageText はそのメッセージの本文） */
  const press = async (message: OutgoingMessage) => {
    const row = message.components?.[0];
    assert.ok(row?.kind === "buttons");
    const interaction: Interaction = {
      kind: "button",
      customId: row.buttons[0]!.customId,
      guildId: "guild-1",
      channelId: INBOX,
      userId: "owner-1",
      createdAt: now(),
      messageId: "m-x",
      messageText: message.text,
    };
    const responder = new FakeResponder();
    await component.handle(interaction, responder);
    return responder.calls;
  };
  return { db, clock, now, sessions, sends, replies, history, bot, posted, logs, replier, deliver, stop, press, ccChannels };
}

/** 本文・名前・チャンネル ID・sessionId が log に無い */
function assertQuietLogs(logs: string[]): void {
  for (const secret of [SECRET_NAME, SECRET_BODY, INBOX, SESSION_CHANNEL, S1, S2, "confirm-1"]) {
    assert.ok(logs.every((line) => !line.includes(secret)), secret);
  }
}

test("openDb: CC8 の移行で cc_sessions の follow の列・cc_sends の reply_state・cc_replies ができる。reply_state・state は決まった語だけ", (t) => {
  const path = join(tempDir(t), "self-agent.db");
  // CC8 の 1 つ前の版から上げる（版の番号には依らない）
  const before = new DatabaseSync(path);
  for (const migration of MIGRATIONS.slice(0, -1)) before.exec(migration);
  before.exec(`PRAGMA user_version = ${MIGRATIONS.length - 1}`);
  before.exec(
    "INSERT INTO cc_sessions (session_id, first_seen_at, last_seen_at) VALUES ('11111111-1111-4111-8111-111111111111', 'x', 'x')",
  );
  before.close();
  const db = openDb(path);
  t.after(() => db.close());
  assert.equal(db.prepare("PRAGMA user_version").get()?.user_version, MIGRATIONS.length);
  const columns = (table: string) => db.prepare(`PRAGMA table_info(${table})`).all().map((row) => String(row.name));
  for (const name of ["follow", "follow_channel_id", "follow_since", "follow_last_stop_at", "reply_count_day", "reply_count"]) {
    assert.ok(columns("cc_sessions").includes(name), name);
  }
  assert.ok(columns("cc_sends").includes("reply_state") && columns("cc_sends").includes("reply_posted_at"));
  for (const name of ["session_id", "received_at", "text_hash", "text_length", "send_id", "channel_id", "message_id", "state", "created_at"]) {
    assert.ok(columns("cc_replies").includes(name), name);
  }
  // 既存の行は追いかけていない
  const row = db.prepare("SELECT follow, reply_count FROM cc_sessions").get();
  assert.deepEqual([row?.follow, row?.reply_count], [0, 0]);
  const reply = (state: string) =>
    db
      .prepare("INSERT INTO cc_replies (session_id, received_at, text_hash, text_length, channel_id, state, created_at) VALUES ('s', 'x', 'h', 0, 'c', ?, 'x')")
      .run(state);
  assert.throws(() => reply("waiting"));
  reply("skipped");
  const send = (replyState: string) =>
    db
      .prepare("INSERT INTO cc_sends (session_id, text, origin, state, reply_state, created_at, updated_at) VALUES ('s', 't', 'web', 'delivered', ?, 'x', 'x')")
      .run(replyState);
  assert.throws(() => send("done"));
  send("timed_out");
});

test("delivered で follow = 1 になり、以後の Stop は全部（RC・端末から打ったターンも）頼んだチャンネルに出る。最初は確認の投稿への返信、以後は返信先なし", async (t) => {
  const { sessions, sends, replies, posted, logs, deliver, stop, history } = setup(t);
  const sendId = deliver(S1, INBOX);
  const row = sessions.get(S1)!;
  assert.deepEqual([row.follow, row.followChannelId, row.followSince], [true, INBOX, new Date(BASE).toISOString()]);
  assert.equal(sends.get(sendId)?.replyState, "waiting");

  await stop(S1, SECRET_BODY);
  // RC から打ったターンの返事（送信に当たらない）も出す
  await stop(S1, "RC から頼んだことへの返事");
  assert.equal(posted.length, 2);
  assert.deepEqual(posted.map((post) => post.channelId), [INBOX, INBOX]);
  assert.equal(posted[0]!.message.replyToId, "confirm-1");
  assert.equal(posted[1]!.message.replyToId, undefined);
  assert.equal(posted[0]!.message.text, `Claude Code（${SECRET_NAME.replace(/-/g, "\\-")}）の返事（hook）:\n${SECRET_BODY}`);
  assert.equal(posted[0]!.message.suppressEmbeds, true);
  // 返事の印: 届けた後の最初の Stop で posted
  assert.equal(sends.get(sendId)?.replyState, "posted");
  // 記録は sha256 と長さだけ（本文は持たない）
  const first = replies.get(1)!;
  assert.deepEqual([first.sendId, first.state, first.messageId, first.textLength], [sendId, "posted", "m-1", [...SECRET_BODY].length]);
  assert.match(first.textHash, /^[0-9a-f]{64}$/);
  assert.equal(replies.get(2)?.sendId, null);
  // Web の会話には notice（system）で出す。ターンの prompt には入れない（SDK のエージェントは読まない）
  const rows = history.list(INBOX, { limit: 10 });
  assert.deepEqual(rows.map((r) => [r.kind, r.source]), [["notice", "system"], ["notice", "system"]]);
  assert.ok(rows[0]!.text.includes(SECRET_BODY) && rows[0]!.text.startsWith("Claude Code（"));
  assert.ok(logs.some((line) => line === `Claude Code: 返事を戻しました（#${sendId}、返事 #1、1 通）`));
  assertQuietLogs(logs);
});

test("追いかけでないセッションの Stop は投稿しない（Web だけから送った指示の返事も）。返事の印は付ける", async (t) => {
  const { sessions, sends, posted, deliver, stop } = setup(t);
  await stop(S2, "頼んでいないセッションの返事");
  // Web から送った（channel_id が無い）ものは追いかけにならない
  const sendId = deliver(S2, undefined, "confirm-1", "web");
  await stop(S2, "Web から送った指示の返事");
  assert.equal(posted.length, 0);
  assert.equal(sessions.get(S2)?.follow, false);
  assert.equal(sends.get(sendId)?.replyState, "posted");
});

test("同じ Stop が 10 秒以内に二重に来たら skipped で出さない。10 秒を過ぎた同じ本文は出す", async (t) => {
  const { clock, replies, posted, deliver, stop } = setup(t);
  deliver(S1, INBOX);
  await stop(S1, "同じ返事");
  clock.now += CC_REPLY_DUPLICATE_MS - 1;
  await stop(S1, "同じ返事");
  assert.equal(posted.length, 1);
  assert.equal(replies.get(2)?.state, "skipped");
  clock.now += 1;
  await stop(S1, "同じ返事");
  // 10 秒以内の最新が skipped の行でも、それは前の行から 10 秒以内の扱い
  assert.equal(replies.get(3)?.state, "skipped");
  clock.now += CC_REPLY_DUPLICATE_MS + 1;
  await stop(S1, "同じ返事");
  assert.equal(posted.length, 2);
  assert.equal(replies.get(4)?.state, "posted");
});

test("last_assistant_message が無ければ「読めませんでした」だけを出し、送信の印は unreadable", async (t) => {
  const { sends, posted, deliver, stop } = setup(t);
  const sendId = deliver(S1, INBOX);
  // 受け口は空白だけ・文字列でない last_assistant_message を読まない
  for (const value of [undefined, "", "  \n", 42]) {
    const event = parseHookEvent({ hook_event_name: "Stop", session_id: S1, last_assistant_message: value }, new Date(BASE));
    assert.equal(event?.lastAssistantMessage, undefined);
  }
  await stop(S1, undefined);
  assert.equal(posted.length, 1);
  assert.match(posted[0]!.message.text, /終わりました（返事を読めませんでした）$/);
  assert.equal(posted[0]!.message.replyToId, "confirm-1");
  assert.equal(sends.get(sendId)?.replyState, "unreadable");
});

test("5,401 字の返事は 1,800 字 × 3 通 +「ほか 1 字。RC で読む <リンク>」。[追いかけをやめる] は最後の通だけ。@everyone・メンションは鳴らさず、URL の埋め込みも出さない", async (t) => {
  const { posted, deliver, stop } = setup(t);
  deliver(S1, INBOX);
  const body = `@everyone <@123> https://example.com/x ${"字".repeat(5401 - 39)}`;
  assert.equal([...body].length, 5401);
  await stop(S1, body);
  assert.equal(posted.length, 3);
  const texts = posted.map((post) => post.message.text);
  assert.ok(texts[0]!.endsWith([...body].slice(0, CC_REPLY_PAGE_CHARS).join("")));
  assert.match(texts[0]!, /の返事（hook）（1\/3）:\n@everyone/);
  assert.match(texts[1]!, /の返事の続き（2\/3）:\n/);
  assert.ok(texts[2]!.endsWith(`\n（ほか 1 字。RC で読む <${RC}>）`));
  assert.ok(texts.every((text) => [...text].length <= 2000));
  assert.deepEqual(
    posted.map((post) => post.message.components?.length ?? 0),
    [0, 0, 1],
  );
  assert.deepEqual(posted.map((post) => post.message.replyToId), ["confirm-1", undefined, undefined]);
  for (const post of posted) {
    const payload = toPayload(post.message);
    assert.deepEqual(payload.allowedMentions, { parse: [], repliedUser: true });
    assert.equal(payload.flags, SUPPRESS_EMBEDS_FLAG);
  }
  // RC のリンクが分からなければ「RC で読んでください」
  const split = splitReplyBody("字".repeat(5400));
  assert.deepEqual([split.pages.length, split.rest], [3, 0]);
});

test("splitReplyBody: コードブロックが通の途中で切れたら閉じ、次の通で同じ開きの行から開き直す", () => {
  const code = Array.from({ length: 250 }, (_, i) => `line ${String(i).padStart(3, "0")}`).join("\n");
  const body = `説明\n\`\`\`ts\n${code}\n\`\`\`\n後ろ`;
  const { pages, rest } = splitReplyBody(body);
  assert.equal(rest, 0);
  assert.equal(pages.length, 2);
  assert.ok(pages[0]!.endsWith("\n```"));
  assert.ok(pages[1]!.startsWith("```ts\n"));
  // 開き直した後に元の閉じがあるので、2 通目の終わりは閉じている
  assert.ok(pages[1]!.endsWith("```\n後ろ"));
});

test("[追いかけをやめる] で follow = 0 にし、本文を残して「追いかけをやめました」を足してボタンを外す。以後は出ず、もう一度押す・前の追いかけのボタンは古い", async (t) => {
  const { clock, sessions, posted, deliver, stop, press, logs } = setup(t);
  deliver(S1, INBOX);
  await stop(S1, SECRET_BODY);
  const message = posted[0]!.message;
  assert.equal(message.components?.[0]?.kind === "buttons" && message.components[0].buttons[0]!.customId, "cc:unfollow:1");
  const calls = await press(message);
  assert.deepEqual(calls, [{ method: "update", message: { text: `${message.text}\n${CC_UNFOLLOW_NOTE}`, components: [], suppressEmbeds: true } }]);
  assert.equal(sessions.get(S1)?.follow, false);
  await stop(S1, "やめた後の返事");
  assert.equal(posted.length, 1);
  // もう一度押す
  assert.deepEqual(await press(message), [{ method: "reply", message: { text: STALE_TURN_REPLY, ephemeral: true } }]);
  // もう一度 Discord から頼めば追いかけが戻る。前の追いかけの返事のボタンは古い
  clock.now += 60_000;
  deliver(S1, INBOX, "confirm-2");
  assert.equal(sessions.get(S1)?.follow, true);
  assert.deepEqual(await press(message), [{ method: "reply", message: { text: STALE_TURN_REPLY, ephemeral: true } }]);
  assert.equal(sessions.get(S1)?.follow, true);
  await stop(S1, "また頼んだことへの返事");
  assert.equal(posted.length, 2);
  assert.equal(posted[1]!.message.replyToId, "confirm-2");
  // 無い id も古い
  const ghost = { text: "x", components: [{ kind: "buttons" as const, buttons: [{ customId: "cc:unfollow:999", label: "x" }] }] };
  assert.deepEqual(await press(ghost), [{ method: "reply", message: { text: STALE_TURN_REPLY, ephemeral: true } }]);
  assert.ok(logs.includes("Claude Code: [追いかけをやめる] で追いかけをやめました（返事 #1）"));
  // 2,000 字に収まらない本文は切って一言を足す
  assert.equal([...unfollowedText("字".repeat(2000))].length, 2000);
  assert.ok(unfollowedText("字".repeat(2000)).endsWith(`…\n${CC_UNFOLLOW_NOTE}`));
});

test("一覧から消えたら（registry の ended）追いかけ中なら「終わりました」を 1 行出して follow = 0 にし true（#system の終了の知らせは出さない）。SessionEnd の hook では止めない", async (t) => {
  const { sessions, posted, deliver, replier, history } = setup(t);
  deliver(S1, INBOX);
  // SessionEnd は根拠にしない（偽の hook で止められない）
  replier.onEvent({ event: "SessionEnd", sessionId: S1, receivedAt: new Date(BASE) });
  await replier.idle();
  assert.equal(sessions.get(S1)?.follow, true);
  assert.equal(posted.length, 0);

  assert.equal(replier.ended(sessions.get(S1)!), true);
  assert.equal(replier.ended(sessions.get(S1)!), false);
  await replier.idle();
  assert.equal(posted.length, 1);
  assert.match(posted[0]!.message.text, /のセッションが終わりました。追いかけをやめます$/);
  assert.equal(sessions.get(S1)?.follow, false);
  assert.equal(history.list(INBOX, { limit: 10 }).length, 1);
  // 追いかけていなければ false（#system の終了の知らせに任せる）
  assert.equal(replier.ended(sessions.get(S2)!), false);

  // ended を経ずに一覧から消えた行（停止の間など）も、tick で同じ 1 行を出す
  deliver(S2, SESSION_CHANNEL);
  assert.equal(sessions.markGone([S1]), 1);
  await replier.sweep();
  await replier.idle();
  assert.equal(posted.length, 2);
  assert.equal(posted[1]!.channelId, SESSION_CHANNEL);
  assert.equal(sessions.get(S2)?.follow, false);
  await replier.sweep();
  await replier.idle();
  assert.equal(posted.length, 2);
});

test("最後の Stop から 3 日 Stop が無ければ、黙って follow = 0。Stop があれば数え直す", async (t) => {
  const { clock, sessions, posted, deliver, stop, replier } = setup(t);
  deliver(S1, INBOX);
  clock.now += 2 * DAY;
  await stop(S1, "2 日後の返事");
  clock.now += CC_FOLLOW_IDLE_DAYS * DAY - 1;
  await replier.sweep();
  assert.equal(sessions.get(S1)?.follow, true);
  clock.now += 1;
  await replier.sweep();
  await replier.idle();
  assert.equal(sessions.get(S1)?.follow, false);
  // 知らせは出さない
  assert.equal(posted.length, 1);
});

test("1 日 50 通: 51 通目は上限の 1 行（RC のリンク付き）で 52 通目は出ない。翌日（SELF_AGENT_TZ の日付）はまた出る。follow は保つ", async (t) => {
  const { clock, sessions, replies, posted, deliver, stop } = setup(t);
  deliver(S1, INBOX);
  for (let i = 1; i <= CC_REPLY_DAILY_LIMIT; i++) await stop(S1, `返事 ${i}`);
  assert.equal(posted.length, CC_REPLY_DAILY_LIMIT);
  await stop(S1, "51 通目");
  assert.equal(posted.length, CC_REPLY_DAILY_LIMIT + 1);
  assert.equal(posted.at(-1)!.message.text, replyLimitText(SECRET_NAME.replace(/-/g, "\\-"), RC));
  assert.match(posted.at(-1)!.message.text, /今日はここまで（上限 50）。RC で読む </);
  assert.equal(replies.get(CC_REPLY_DAILY_LIMIT + 1)?.state, "skipped");
  await stop(S1, "52 通目");
  assert.equal(posted.length, CC_REPLY_DAILY_LIMIT + 1);
  assert.equal(sessions.get(S1)?.follow, true);
  // 2026-11-02 0:00（Asia/Tokyo）は UTC の 11-01 15:00
  clock.now = Date.parse("2026-11-01T15:00:00.000Z");
  await stop(S1, "翌日の返事");
  assert.equal(posted.length, CC_REPLY_DAILY_LIMIT + 2);
  assert.match(posted.at(-1)!.message.text, /翌日の返事$/);
});

test("別のチャンネルから頼んで届けば、返事を出すチャンネルが移る（追いかけを始めた時刻は変えない）", async (t) => {
  const { clock, sessions, posted, deliver, stop } = setup(t);
  deliver(S1, INBOX);
  await stop(S1, "1 つ目");
  clock.now += 60_000;
  deliver(S1, SESSION_CHANNEL, "confirm-2");
  assert.deepEqual([sessions.get(S1)?.followChannelId, sessions.get(S1)?.followSince], [SESSION_CHANNEL, new Date(BASE).toISOString()]);
  await stop(S1, "2 つ目");
  assert.deepEqual(posted.map((post) => post.channelId), [INBOX, SESSION_CHANNEL]);
  assert.equal(posted[1]!.message.replyToId, "confirm-2");
});

test("Stop の無い中断（Esc）では返事の印が 24 時間で timed_out。次の送信の返事が来たら前の返事待ちは timed_out", async (t) => {
  const { clock, sends, deliver, stop, replier, logs } = setup(t);
  const first = deliver(S1, INBOX);
  clock.now += CC_REPLY_WAIT_MS - 1;
  await replier.sweep();
  assert.equal(sends.get(first)?.replyState, "waiting");
  clock.now += 1;
  // 24 時間ちょうどはまだ（delivered_at より前のものだけ）
  await replier.sweep();
  clock.now += 1;
  await replier.sweep();
  assert.equal(sends.get(first)?.replyState, "timed_out");
  assert.ok(logs.includes("Claude Code: 返事の来なかった送信 1 件を時間切れにしました"));

  const a = deliver(S2, SESSION_CHANNEL, "c-a", "web");
  const b = deliver(S2, SESSION_CHANNEL, "c-b", "web");
  await stop(S2, "b の返事");
  assert.deepEqual([sends.get(a)?.replyState, sends.get(b)?.replyState], ["timed_out", "posted"]);
});

test("貼っている途中（delivering）に来た Stop は送信が終わるまで待ち、届いたらその送信の返事（確認への返信）として出す。終わらなければ 30 秒で扱う", async (t) => {
  const { clock, sends, posted, replier, now } = setup(t);
  const send = sends.add({ sessionId: S1, text: "x", origin: "tool", state: "queued", channelId: INBOX });
  sends.setMessageId(send.id, "confirm-1");
  assert.ok(sends.transition(send.id, ["queued"], "delivering"));
  replier.onEvent({ event: "Stop", sessionId: S1, receivedAt: now(), lastAssistantMessage: "すぐ答えた" });
  await replier.idle();
  assert.equal(posted.length, 0);
  assert.ok(sends.transition(send.id, ["delivering"], "delivered"));
  replier.onSendFinished(sends.get(send.id)!);
  await replier.idle();
  assert.equal(posted.length, 1);
  assert.equal(posted[0]!.message.replyToId, "confirm-1");
  assert.equal(sends.get(send.id)?.replyState, "posted");

  // 終わらないまま 30 秒経てば待たずに扱う（S2 は追いかけていないので出ない。印も無い）
  const stuck = sends.add({ sessionId: S2, text: "y", origin: "web", state: "queued" });
  assert.ok(sends.transition(stuck.id, ["queued"], "delivering"));
  replier.onEvent({ event: "Stop", sessionId: S2, receivedAt: now(), lastAssistantMessage: "z" });
  clock.now += CC_REPLY_HOLD_MS;
  await replier.sweep();
  await replier.idle();
  assert.equal(posted.length, 1);
});

test("投稿に失敗したら failed にして log だけ、次の tick で 1 回だけ（出せなかった通から）やり直す", async (t) => {
  const { bot, replies, posted, deliver, stop, replier, logs } = setup(t);
  deliver(S1, INBOX);
  bot.failNext = 1;
  await stop(S1, SECRET_BODY);
  assert.equal(replies.get(1)?.state, "failed");
  assert.equal(posted.length, 0);
  await replier.sweep();
  assert.equal(posted.length, 1);
  // 最初の通のやり直しは返信先を保つ
  assert.equal(posted[0]!.message.replyToId, "confirm-1");
  assert.deepEqual([replies.get(1)?.state, replies.get(1)?.messageId], ["posted", "m-1"]);
  // やり直しても出せなければそれきり
  bot.failNext = 2;
  await stop(S1, "2 つ目");
  await replier.sweep();
  await replier.sweep();
  assert.equal(replies.get(2)?.state, "failed");
  assert.equal(posted.length, 1);
  assert.ok(logs.some((line) => line.startsWith("Claude Code: 返事をやり直しても出せませんでした（返事 #2、")));
  assertQuietLogs(logs);
});

test("CcRegistry: 一覧に居るセッションの hook の事象だけを onEvent に渡す（偽の session_id の Stop は返事にならない）", async (t) => {
  const db = tempDb(t);
  const now = (): Date => new Date(BASE);
  const store = new CcSessionStore(db, now);
  const entry: AgentEntry = { pid: 1, sessionId: S1, cwd: "/w", name: "a", kind: "interactive", startedAt: BASE, status: "idle", waitingFor: undefined };
  const seen: CcHookEvent[] = [];
  const registry = new CcRegistry({
    cfg: { ccPollSec: 10 },
    agents: { list: async () => ({ ok: true, agents: [entry], dropped: 0 }) },
    dirs: { sessionFile: () => undefined, transcriptLastAt: () => undefined },
    store,
    now,
    timers: { after: () => () => undefined },
    onEvent: (event) => {
      seen.push(event);
      throw new Error("投げても一覧の処理は止めない");
    },
    log: () => undefined,
  });
  await registry.tick();
  registry.receive(parseHookEvent({ hook_event_name: "Stop", session_id: S2, last_assistant_message: "偽物" }, now())!);
  registry.receive(parseHookEvent({ hook_event_name: "Stop", session_id: S1, last_assistant_message: "本物" }, now())!);
  assert.deepEqual(seen.map((event) => [event.sessionId, event.lastAssistantMessage]), [[S1, "本物"]]);
  assert.equal(store.get(S1)?.lastEvent, "Stop");
  // 保留した S2 は一覧に現れずに捨てられる
  await registry.tick();
  assert.equal(seen.length, 1);
});

test("replyTexts: 開き直しの行は fence と情報文字列の先頭 20 字まで。どの通も 2,000 字に収まり、溢れた分は次の通・「ほか n 字」に回る", () => {
  const info = "x".repeat(500);
  // 1 通目の終わりでコードブロックが開いたまま。長い情報文字列が 2・3 通目の先頭に付いても溢れない
  const body = `\`\`\`${info}\n${"a".repeat(5401)}`;
  const texts = replyTexts("名前", body, RC);
  assert.equal(texts.length, 3);
  assert.ok(texts.every((text) => [...text].length <= 2000), texts.map((text) => [...text].length).join(","));
  assert.ok(texts[1]!.includes(`\n\`\`\`${"x".repeat(20)}\n`));
  assert.ok(!texts[1]!.includes("x".repeat(21)));
  // 収めるために減らした分も「ほか n 字」に数える
  const shown = texts.reduce((sum, text) => sum + [...text.replace(/^[^\n]*\n/, "").replace(/\n（ほか .*$/, "")].filter((c) => c === "a").length, 0);
  const rest = Number(/ほか ([\d,]+) 字/.exec(texts[2]!)![1]!.replace(/,/g, ""));
  assert.equal(shown + rest, 5401);
  // 長い名前・RC のリンクでも溢れない
  const many = replyTexts("名".repeat(30), "字".repeat(9000), `${RC}${"z".repeat(200)}`);
  assert.ok(many.every((text) => [...text].length <= 2000));
});

test("breakMaskedLinks: コードブロックの外の `](` だけを `]\\(` に崩す", () => {
  assert.equal(breakMaskedLinks("[押す](https://evil.example)\n```\n[a](b)\n```\n[c](d)"), "[押す]\\(https://evil.example)\n```\n[a](b)\n```\n[c]\\(d)");
  const texts = replyTexts("名前", "[押す](https://evil.example)", undefined);
  assert.ok(texts[0]!.endsWith("[押す]\\(https://evil.example)"));
});

test("出せなかった返事のやり直しは、その時に追いかけ中のときだけ。[追いかけをやめる] の後は出さない", async (t) => {
  const { bot, sessions, replies, posted, deliver, stop, replier, logs } = setup(t);
  deliver(S1, INBOX);
  bot.failNext = 1;
  await stop(S1, "出せなかった返事");
  assert.equal(replies.get(1)?.state, "failed");
  assert.ok(sessions.stopFollow(S1));
  await replier.sweep();
  assert.equal(posted.length, 0);
  assert.equal(replies.get(1)?.state, "failed");
  assert.ok(logs.includes("Claude Code: 追いかけをやめたため返事をやり直しません（返事 #1）"));
  assert.ok(logs.some((line) => line.startsWith("Claude Code: 返事を出せませんでした（返事 #1、0/1 通まで出しました、")));
});

test("一覧から消えたセッションの返事待ちは、次の sweep で timed_out（24 時間待たない）", async (t) => {
  const { sessions, sends, deliver, replier } = setup(t);
  const sendId = deliver(S2, undefined, "c", "web");
  await replier.sweep();
  assert.equal(sends.get(sendId)?.replyState, "waiting");
  assert.equal(sessions.markGone([S1]), 1);
  await replier.sweep();
  assert.equal(sends.get(sendId)?.replyState, "timed_out");
});

test("チャンネル（CC11）: 開いているチャンネルがあれば follow によらず常にそこへ。最初の 1 通はオーナーの発言への返信、名前は省き、[追いかけをやめる] は無い", async (t) => {
  const { sends, sessions, posted, replier, stop, ccChannels, logs } = setup(t);
  ccChannels.set(S1, "cc-chan");
  const send = sends.add({ sessionId: S1, text: "発言", origin: "discord", state: "queued", channelId: "cc-chan", messageId: "owner-msg" });
  sends.transition(send.id, ["queued"], "delivering");
  sends.transition(send.id, ["delivering"], "delivered");
  replier.onSendFinished(sends.get(send.id)!);
  // チャンネルのあるセッションでは追いかけを立てない
  assert.equal(sessions.get(S1)?.follow, false);
  await stop(S1, SECRET_BODY);
  await stop(S1, "2 つ目の返事");
  assert.deepEqual(
    posted.map((post) => [post.channelId, post.message.text, post.message.replyToId, post.message.components]),
    [
      ["cc-chan", `Claude Code の返事（hook）:\n${SECRET_BODY}`, "owner-msg", undefined],
      ["cc-chan", "Claude Code の返事（hook）:\n2 つ目の返事", undefined, undefined],
    ],
  );
  assert.ok(posted.every((post) => post.message.suppressEmbeds === true));
  // 端末・RC から打ったターンの返事（返事待ちの送信が無い）も出す
  await stop(S1, "端末のターン");
  assert.equal(posted.length, 3);
  assertQuietLogs(logs);
});

test("チャンネル（CC e2e）: 送信が unconfirmed でも、最初の返事はその送信の message_id への返信", async (t) => {
  const { sends, posted, replier, stop, ccChannels } = setup(t);
  ccChannels.set(S1, "cc-chan");
  const send = sends.add({ sessionId: S1, text: "発言", origin: "discord", state: "queued", channelId: "cc-chan", messageId: "owner-msg" });
  assert.ok(sends.transition(send.id, ["queued"], "delivering"));
  assert.ok(sends.transition(send.id, ["delivering"], "unconfirmed", { lastPaneState: "enter_unconfirmed" }));
  replier.onSendFinished(sends.get(send.id)!);
  await stop(S1, "返事");
  await stop(S1, "次の返事");
  assert.deepEqual(
    posted.map((post) => post.message.replyToId),
    ["owner-msg", undefined],
  );
  assert.equal(sends.get(send.id)?.replyState, "posted");
});

test("チャンネル（CC e2e）: 同じセッションに次の発言が積まれていても、貼っている途中に来た Stop は送信が終わるまで待ち、その発言への返信で出す", async (t) => {
  const { sends, posted, replier, now, ccChannels } = setup(t);
  ccChannels.set(S1, "cc-chan");
  const first = sends.add({ sessionId: S1, text: "1 つ目", origin: "discord", state: "queued", channelId: "cc-chan", messageId: "msg-1" });
  sends.add({ sessionId: S1, text: "2 つ目", origin: "discord", state: "queued", channelId: "cc-chan", messageId: "msg-2" });
  assert.ok(sends.transition(first.id, ["queued"], "delivering"));
  // Enter の後の確かめを待っている間に答え終わった
  replier.onEvent({ event: "Stop", sessionId: S1, receivedAt: now(), lastAssistantMessage: "すぐ答えた" });
  await replier.idle();
  assert.equal(posted.length, 0);
  assert.ok(sends.transition(first.id, ["delivering"], "delivered"));
  replier.onSendFinished(sends.get(first.id)!);
  await replier.idle();
  assert.deepEqual(
    posted.map((post) => [post.channelId, post.message.replyToId]),
    [["cc-chan", "msg-1"]],
  );
});

test("チャンネル（CC11）: #inbox から cc_send で頼んでも追いかけは立てず返事はチャンネルへ（確認の投稿への返信にはしない）。チャンネルが閉じたら CC8 のまま", async (t) => {
  const { sessions, posted, deliver, stop, ccChannels } = setup(t);
  ccChannels.set(S1, "cc-chan");
  deliver(S1, INBOX);
  assert.equal(sessions.get(S1)?.follow, false);
  await stop(S1, "返事");
  assert.deepEqual([posted[0]!.channelId, posted[0]!.message.replyToId], ["cc-chan", undefined]);
  // チャンネルを閉じた（ended）後は、追いかけの規則（follow が無ければ出さない）
  ccChannels.delete(S1);
  await stop(S1, "閉じた後");
  assert.equal(posted.length, 1);
  deliver(S1, INBOX);
  assert.equal(sessions.get(S1)?.follow, true);
  await stop(S1, "追いかけ");
  assert.equal(posted.at(-1)!.channelId, INBOX);
  assert.equal(posted.at(-1)!.message.components?.[0]?.kind, "buttons");
});

test("チャンネル（CC11）: 1 日 200 通。201 通目は上限の 1 行（上限 200・ボタンなし）で 202 通目は出ない", async (t) => {
  const { posted, stop, ccChannels } = setup(t);
  ccChannels.set(S1, "cc-chan");
  for (let i = 1; i <= CC_CHANNEL_REPLY_DAILY_LIMIT; i++) await stop(S1, `返事 ${i}`);
  assert.equal(posted.length, CC_CHANNEL_REPLY_DAILY_LIMIT);
  await stop(S1, "201 通目");
  assert.equal(posted.length, CC_CHANNEL_REPLY_DAILY_LIMIT + 1);
  assert.equal(posted.at(-1)!.message.text, replyLimitText(null, RC, CC_CHANNEL_REPLY_DAILY_LIMIT));
  assert.match(posted.at(-1)!.message.text, /^Claude Code: 今日はここまで（上限 200）。RC で読む </);
  assert.equal(posted.at(-1)!.message.components, undefined);
  await stop(S1, "202 通目");
  assert.equal(posted.length, CC_CHANNEL_REPLY_DAILY_LIMIT + 1);
});

test("チャンネル（CC11）: 送信の channel_id が cc のチャンネルなら、そのチャンネルが閉じた後に届いても追いかけを立てない", async (t) => {
  const { sends, sessions, replier } = setup(t);
  const send = sends.add({ sessionId: S1, text: "発言", origin: "discord", state: "queued", channelId: "cc-chan", messageId: "owner-msg" });
  sends.transition(send.id, ["queued"], "delivering");
  sends.transition(send.id, ["delivering"], "delivered");
  replier.onSendFinished(sends.get(send.id)!);
  assert.equal(sessions.get(S1)?.follow, false);
});

test("Web の会話（CC14）: チャンネルに出した返事は history の agent（本文・outcome done・手順なし）。読めなかったものは notice", async (t) => {
  const { history, stop, ccChannels } = setup(t);
  ccChannels.set(S1, "cc-chan");
  await stop(S1, SECRET_BODY);
  await stop(S1, undefined);
  const rows = history.list("cc-chan", { limit: 10 });
  assert.deepEqual(
    rows.map((row) => [row.kind, row.source, row.outcome, row.steps, row.toolCalls, row.durationMs, row.guildId]),
    [
      ["agent", "system", "done", null, null, null, "guild-1"],
      ["notice", "system", null, null, null, null, "guild-1"],
    ],
  );
  assert.equal(rows[0]!.text, SECRET_BODY);
});
