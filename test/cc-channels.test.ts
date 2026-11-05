import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { layoutQueueKey } from "../src/app/commands/setup.ts";
import {
  CC_CATEGORY_CHANNEL_LIMIT,
  CC_CHANNEL_ENDED_TEXT,
  CC_CHANNEL_FAILURE_NOTICE_MS,
  CC_CHANNEL_REVIVED_TEXT,
  ccChannelName,
  ccChannelTopic,
  CcChannels,
  ccEndedHandler,
  routeCcChannelMessages,
  ccPermissionAnsweredHandler,
} from "../src/cc/channels.ts";
import { NotCategoryError } from "../src/discord/gateway.ts";
import type { IncomingMessage } from "../src/discord/gateway.ts";
import type { CcSessionRow } from "../src/store/cc-sessions.ts";
import type { PaneLookup } from "../src/cc/panes.ts";
import type { CcSessionView } from "../src/cc/registry.ts";
import type { OutgoingMessage } from "../src/discord/gateway.ts";
import { CcChannelStore } from "../src/store/cc-channels.ts";
import { CcSendStore } from "../src/store/cc-sends.ts";
import { GuildSettingsStore } from "../src/store/guild-settings.ts";
import { tempDb } from "./helpers/db.ts";
import { FakeGateway } from "./helpers/gateway.ts";
import { RecordingChannelOps, RecordingQueue } from "./helpers/recording.ts";

const BASE = Date.parse("2026-11-05T00:00:00.000Z");
const S1 = "11111111-1111-4111-8111-111111111111";
const S2 = "22222222-2222-4222-8222-222222222222";
const S3 = "33333333-3333-4333-8333-333333333333";
const WORKSPACE = "/home/owner/workspace";
const SECRET_NAME = "secret-name";

/** 一覧の 1 行（channels.ts が読む項目だけ） */
function view(sessionId: string, pid: number, overrides: Partial<CcSessionView> = {}): CcSessionView {
  return {
    sessionId,
    pid,
    name: SECRET_NAME,
    cwd: `${WORKSPACE}/alpha`,
    tmux: undefined,
    state: "idle",
    ...overrides,
  } as CcSessionView;
}

function setup(t: TestContext, options: { setUp?: boolean } = {}) {
  const db = tempDb(t);
  const clock = { now: BASE };
  const now = (): Date => new Date(clock.now);
  const store = new CcChannelStore(db, now);
  const guildSettings = new GuildSettingsStore(db, now);
  const gateway = new FakeGateway({
    allow: ["sendMessage", "channelExists", "countChannelsIn"],
    record: ["createTextChannel"],
    channelIdPrefix: "chan-",
    messageIdPrefix: "msg-",
  });
  if (options.setUp !== false) {
    guildSettings.setChannel("guild-1", "homeCategoryId", "home-1");
    guildSettings.setCcCategory("guild-1", "cat-cc");
    gateway.alive.add("cat-cc");
  }
  const sessions: CcSessionView[] = [view(S1, 100), view(S2, 200, { name: undefined, cwd: `${WORKSPACE}/beta` }), view(S3, 300)];
  // pid 300 は tmux の外
  const inTmux = new Set([100, 200]);
  const lookup: PaneLookup = {
    ok: true,
    find: () => undefined,
    sendable: (target) =>
      inTmux.has(target.pid)
        ? { ok: true, pane: { paneId: "%1" } as never }
        : { ok: false, reason: "not_in_tmux" },
    pane: () => undefined,
  };
  const queue = new RecordingQueue(1);
  const channelOps = new RecordingChannelOps();
  const notices: Array<{ guildId: string; message: OutgoingMessage; level: string }> = [];
  const logs: string[] = [];
  const channels = new CcChannels({
    cfg: { allowedGuildIds: ["guild-1", "guild-2"], workspaceDir: WORKSPACE, ownerUserId: "owner-1" },
    store,
    sends: new CcSendStore(db, now),
    sender: () => undefined,
    guildSettings,
    registry: { snapshot: () => ({ sessions, stale: false, unreadable: false, fetchedAt: BASE }) },
    panes: { lookup: async () => lookup },
    gateway,
    queue,
    channelOps,
    notify: async (guildId, message, opts) => {
      notices.push({ guildId, message, level: opts.level });
      return "notice-1";
    },
    home: "/home/owner",
    now,
    log: (line) => logs.push(line),
  });
  return { db, clock, store, guildSettings, gateway, sessions, inTmux, queue, channelOps, notices, logs, channels };
}

/** log にチャンネル ID・名前・sessionId・ディレクトリを出していない */
function assertQuietLogs(logs: readonly string[]): void {
  for (const line of logs) {
    assert.doesNotMatch(line, /chan-\d|cat-cc|secret|alpha|beta|1111|2222|3333/, line);
  }
}

test("ccChannelName・ccChannelTopic: cc-<名前>（無ければディレクトリの最後の名前）、100 字で切り、同じ名前は -2・-3", () => {
  assert.equal(ccChannelName("My Session!", "/w/alpha", new Set()), "cc-my-session");
  assert.equal(ccChannelName(null, "/w/Beta Dir", new Set()), "cc-beta-dir");
  assert.equal(ccChannelName("", null, new Set()), "cc-session");
  assert.equal(ccChannelName("alpha", null, new Set(["cc-alpha"])), "cc-alpha-2");
  assert.equal(ccChannelName("alpha", null, new Set(["cc-alpha", "cc-alpha-2"])), "cc-alpha-3");
  const long = ccChannelName("x".repeat(150), null, new Set());
  assert.equal(long.length, 100);
  const longDup = ccChannelName("x".repeat(150), null, new Set([long]));
  assert.equal(longDup.length, 100);
  assert.ok(longDup.endsWith("-2"));
  assert.equal(ccChannelTopic("alpha", "alpha"), "Claude Code: alpha（alpha）");
  assert.equal(ccChannelTopic("a\nb", null), "Claude Code: a b");
});

test("openChannel: layoutQueueKey のキューで cc-<名前> をカテゴリ「Claude Code」に作り、行と最初の投稿（エスケープ済み）を残す。2 つ目は exists", async (t) => {
  const s = setup(t);
  s.sessions[0] = view(S1, 100, { name: "a_b *c*" });
  const result = await s.channels.openChannel("guild-1", S1, "web");
  assert.deepEqual(result, { ok: true, channelId: "chan-1", guildId: "guild-1" });
  assert.deepEqual(s.queue.keys, [layoutQueueKey("guild-1")]);
  const created = s.gateway.callsOf("createTextChannel");
  assert.equal(created.length, 1);
  assert.ok(created[0]!.method === "createTextChannel");
  assert.deepEqual(created[0]!.options, { name: "cc-a_b-c", parentId: "cat-cc", topic: "Claude Code: a_b *c*（alpha）" });
  const row = s.store.get("chan-1");
  assert.equal(row?.sessionId, S1);
  assert.equal(row?.guildId, "guild-1");
  assert.equal(row?.origin, "web");
  assert.equal(row?.state, "open");
  assert.equal(row?.cwd, `${WORKSPACE}/alpha`);
  assert.equal(s.gateway.posts.length, 1);
  assert.equal(s.gateway.posts[0]!.channelId, "chan-1");
  assert.match(s.gateway.posts[0]!.message.text, /「a\\_b \\\*c\\\*」（alpha）のチャンネルです（Web の \[Discord のチャンネルを作る\] で作りました）/);
  assert.equal(s.gateway.posts[0]!.message.suppressEmbeds, true);

  const again = await s.channels.openChannel("guild-1", S1, "command");
  assert.deepEqual(again, { ok: false, reason: "exists", channelId: "chan-1", guildId: "guild-1" });
  // 別のサーバーでも 1 セッション 1 つ
  assert.deepEqual(await s.channels.openChannel("guild-2", S1, "command"), { ok: false, reason: "exists", channelId: "chan-1", guildId: "guild-1" });
  assert.equal(s.gateway.callsOf("createTextChannel").length, 1);
  assert.ok(s.logs.some((line) => line === "Claude Code: チャンネルを作りました（guild=guild-1、web）"));
  assertQuietLogs(s.logs);
});

test("openChannel: 一覧に無いと not_found、tmux の外は not_in_tmux、カテゴリが無い・消えていれば not_set_up、50 なら full（どれも作らない）", async (t) => {
  const s = setup(t);
  assert.deepEqual(await s.channels.openChannel("guild-1", "44444444-4444-4444-8444-444444444444", "web"), { ok: false, reason: "not_found" });
  assert.deepEqual(await s.channels.openChannel("guild-1", S3, "web"), { ok: false, reason: "not_in_tmux" });
  // /setup 前（カテゴリの記録が無い）
  assert.deepEqual(await s.channels.openChannel("guild-2", S1, "web"), { ok: false, reason: "not_set_up" });
  // 記録はあるが Discord 上で消えた
  s.gateway.alive.delete("cat-cc");
  assert.deepEqual(await s.channels.openChannel("guild-1", S1, "web"), { ok: false, reason: "not_set_up" });
  s.gateway.alive.add("cat-cc");
  s.gateway.manual.set("cat-cc", CC_CATEGORY_CHANNEL_LIMIT);
  assert.deepEqual(await s.channels.openChannel("guild-1", S1, "web"), { ok: false, reason: "full" });
  s.gateway.manual.set("cat-cc", CC_CATEGORY_CHANNEL_LIMIT - 1);
  assert.equal((await s.channels.openChannel("guild-1", S1, "web")).ok, true);
  assert.equal(s.gateway.callsOf("createTextChannel").length, 1);
});

test("openChannel: 同じ名前のチャンネルが開いていれば -2 を付ける", async (t) => {
  const s = setup(t);
  s.sessions[1] = view(S2, 200, { name: SECRET_NAME });
  await s.channels.openChannel("guild-1", S1, "web");
  await s.channels.openChannel("guild-1", S2, "web");
  const names = s.gateway.callsOf("createTextChannel").map((call) => (call.method === "createTextChannel" ? call.options.name : ""));
  assert.deepEqual(names, ["cc-secret-name", "cc-secret-name-2"]);
});

test("openChannel: Discord の作成に失敗しても投げずに failed。記録に失敗したら作ったチャンネルの ID だけ log に出す。最初の投稿の失敗は log だけ", async (t) => {
  const s = setup(t);
  s.gateway.beforeCreate = () => {
    throw new Error("Missing Permissions chan-x");
  };
  assert.deepEqual(await s.channels.openChannel("guild-1", S1, "web"), { ok: false, reason: "failed" });
  assert.equal(s.store.anyFor(S1), undefined);
  assert.ok(s.logs.includes("Claude Code: チャンネルを作れませんでした（failed・Error）"));

  s.gateway.beforeCreate = () => {};
  s.gateway.beforeSendMessage = () => {
    throw new Error("send failed");
  };
  const before = s.logs.length;
  // 記録の失敗を、次に作られるチャンネルの ID（chan-1）と同じ channel_id の行を先に置いて起こす
  s.store.create({ channelId: "chan-1", guildId: "guild-1", sessionId: S3, name: "cc-y", cwd: null, origin: "web" });
  assert.deepEqual(await s.channels.openChannel("guild-1", S1, "web"), { ok: false, reason: "failed" });
  const added = s.logs.slice(before);
  assert.ok(added.some((line) => /記録に失敗しました（guild=guild-1、channel=chan-1）/.test(line)), added.join("\n"));
  // 最初の投稿の失敗
  const ok = await s.channels.openChannel("guild-1", S1, "web");
  assert.equal(ok.ok, true);
  assert.ok(s.logs.includes("Claude Code: チャンネルの最初の投稿に失敗しました（Error）"));
});

test("ensureFor: 既にあれば何もしない。作れなければ投げず、log と、not_set_up・full・failed は #system に 1 行（同じ理由は 1 時間に 1 回）", async (t) => {
  const s = setup(t);
  // カテゴリ「Claude Code」のあるサーバーが無ければ not_set_up（#system は /setup 済みのサーバーへ）
  s.guildSettings.setCcCategory("guild-1", "cat-cc");
  s.gateway.alive.delete("cat-cc");
  assert.deepEqual(await s.channels.ensureFor(S1, "web_send"), { ok: false, reason: "not_set_up" });
  await s.channels.idle();
  assert.equal(s.notices.length, 1);
  assert.equal(s.notices[0]!.guildId, "guild-1");
  assert.equal(s.notices[0]!.level, "warning");
  assert.match(s.notices[0]!.message.text, /\/setup/);
  // 同じ理由の 2 回目は 1 時間出さない
  s.clock.now = BASE + CC_CHANNEL_FAILURE_NOTICE_MS - 1;
  await s.channels.ensureFor(S1, "web_send");
  await s.channels.idle();
  assert.equal(s.notices.length, 1);
  // 別の理由は出す
  s.gateway.alive.add("cat-cc");
  s.gateway.manual.set("cat-cc", CC_CATEGORY_CHANNEL_LIMIT);
  assert.deepEqual(await s.channels.ensureFor(S1, "permission"), { ok: false, reason: "full" });
  await s.channels.idle();
  assert.equal(s.notices.length, 2);
  // 1 時間経てばまた出す
  s.gateway.alive.delete("cat-cc");
  s.clock.now = BASE + CC_CHANNEL_FAILURE_NOTICE_MS;
  await s.channels.ensureFor(S1, "web_send");
  await s.channels.idle();
  assert.equal(s.notices.length, 3);
  // tmux の外は log だけ
  s.gateway.alive.add("cat-cc");
  s.gateway.manual.delete("cat-cc");
  assert.deepEqual(await s.channels.ensureFor(S3, "web_send"), { ok: false, reason: "not_in_tmux" });
  await s.channels.idle();
  assert.equal(s.notices.length, 3);
  assert.ok(s.logs.includes("Claude Code: チャンネルを作れませんでした（not_in_tmux）"));
  // 作れたら、2 回目は何もしない（作成もキューも通らない）
  assert.equal((await s.channels.ensureFor(S1, "tool_send")).ok, true);
  const keys = s.queue.keys.length;
  const again = await s.channels.ensureFor(S1, "github");
  assert.equal(again.ok, false);
  assert.equal(s.queue.keys.length, keys);
  assert.equal(s.store.anyFor(S1)?.origin, "tool_send");
  assertQuietLogs(s.logs);
});

test("ensureFor: どのサーバーもカテゴリ「Claude Code」が無ければ not_set_up で、#system は最初の /setup 済みのサーバー", async (t) => {
  const s = setup(t, { setUp: false });
  s.guildSettings.setChannel("guild-2", "homeCategoryId", "home-2");
  assert.deepEqual(await s.channels.ensureFor(S1, "web_send"), { ok: false, reason: "not_set_up" });
  await s.channels.idle();
  assert.deepEqual(
    s.notices.map((notice) => notice.guildId),
    ["guild-2"],
  );
  assert.equal(s.gateway.callsOf("createTextChannel").length, 0);
});

test("ended: open のチャンネルを ended にして 1 行を出し、完了カテゴリへ移す。チャンネルの無いセッションは何もしない", async (t) => {
  const s = setup(t);
  await s.channels.openChannel("guild-1", S1, "web");
  s.clock.now = BASE + 1000;
  assert.equal(s.channels.ended({ sessionId: S1 }), true);
  await s.channels.idle();
  const row = s.store.get("chan-1");
  assert.equal(row?.state, "ended");
  assert.equal(row?.endedAt, new Date(BASE + 1000).toISOString());
  assert.deepEqual(s.channelOps.moves, [{ channelId: "chan-1", target: { kind: "state", guildId: "guild-1", state: "done" } }]);
  assert.equal(s.gateway.posts.at(-1)?.channelId, "chan-1");
  assert.equal(s.gateway.posts.at(-1)?.message.text, CC_CHANNEL_ENDED_TEXT);
  // 2 回目・チャンネルの無いセッション
  assert.equal(s.channels.ended({ sessionId: S1 }), false);
  assert.equal(s.channels.ended({ sessionId: S2 }), false);
  assert.equal(s.channelOps.moves.length, 1);
  // #system には出さない（notify を呼ばない）
  assert.equal(s.notices.length, 0);
  assertQuietLogs(s.logs);
});

test("revived: 同じ session_id の ended のチャンネルを open に戻して 1 行を出し、カテゴリ「Claude Code」へ戻す。付け替えの前の id では開き直さない", async (t) => {
  const s = setup(t);
  await s.channels.openChannel("guild-1", S1, "web");
  s.channels.ended({ sessionId: S1 });
  assert.equal(s.channels.revived({ sessionId: S1 }), true);
  await s.channels.idle();
  assert.equal(s.store.get("chan-1")?.state, "open");
  assert.equal(s.store.get("chan-1")?.endedAt, null);
  assert.deepEqual(s.channelOps.moves.at(-1), { channelId: "chan-1", target: { kind: "category", categoryId: "cat-cc" } });
  assert.equal(s.gateway.posts.at(-1)?.message.text, CC_CHANNEL_REVIVED_TEXT);
  // open のまま戻っても何もしない
  assert.equal(s.channels.revived({ sessionId: S1 }), false);

  // 付け替えた（S1 → S2）チャンネルは、前の id（S1）が戻っても開き直さない
  s.channels.ended({ sessionId: S1 });
  s.store.rebind("chan-1", S2);
  const moves = s.channelOps.moves.length;
  assert.equal(s.channels.revived({ sessionId: S1 }), false);
  assert.equal(s.store.get("chan-1")?.state, "ended");
  assert.equal(s.channelOps.moves.length, moves);
});

test("openChannel: 終わったチャンネルのセッションが一覧に居れば exists で開き直す", async (t) => {
  const s = setup(t);
  await s.channels.openChannel("guild-1", S1, "web");
  s.channels.ended({ sessionId: S1 });
  const result = await s.channels.openChannel("guild-1", S1, "command");
  assert.deepEqual(result, { ok: false, reason: "exists", channelId: "chan-1", guildId: "guild-1" });
  assert.equal(s.store.get("chan-1")?.state, "open");
});

test("reconcile: Discord 上に無い行は削除済みに（未実行の移動を捨てる）、open で外にあるものは Claude Code へ、ended で完了の外のものは完了へ（上限まで）。一覧の後に作った行は消さない", async (t) => {
  const s = setup(t);
  s.guildSettings.setStateCategory("guild-1", "done", 1, "cat-done");
  const make = (channelId: string, sessionId: string, state: "open" | "ended") => {
    s.store.create({ channelId, guildId: "guild-1", sessionId, name: `cc-${channelId}`, cwd: null, origin: "web" });
    if (state === "ended") s.store.setState(channelId, "ended");
  };
  make("gone", S1, "open");
  make("open-out", S2, "open");
  make("open-in", S3, "open");
  make("ended-out", "44444444-4444-4444-8444-444444444444", "ended");
  make("ended-in", "55555555-5555-4555-8555-555555555555", "ended");
  s.clock.now = BASE + 1000;
  make("fresh", "66666666-6666-4666-8666-666666666666", "open");
  const parents = new Map<string, string | null>([
    ["cat-cc", null],
    ["cat-done", null],
    ["open-out", "elsewhere"],
    ["open-in", "cat-cc"],
    ["ended-out", "cat-cc"],
    ["ended-in", "cat-done"],
  ]);
  const moved = s.channels.reconcile("guild-1", parents, new Date(BASE + 1000), 5);
  assert.equal(moved, 2);
  assert.equal(s.store.get("gone")?.state, "deleted");
  assert.deepEqual(s.channelOps.cancelled, ["gone"]);
  assert.equal(s.store.get("fresh")?.state, "open");
  // 作った順（同じ時刻ならチャンネル ID の順）
  assert.deepEqual(s.channelOps.moves, [
    { channelId: "ended-out", target: { kind: "state", guildId: "guild-1", state: "done" } },
    { channelId: "open-out", target: { kind: "category", categoryId: "cat-cc" } },
  ]);
  // 上限
  s.channelOps.moves = [];
  assert.equal(s.channels.reconcile("guild-1", parents, new Date(BASE + 1000), 1), 1);
  assert.deepEqual(s.channelOps.moves.map((move) => move.channelId), ["ended-out"]);
  // カテゴリ自体が Discord 上に無ければ移さない
  s.channelOps.moves = [];
  const noCategories = new Map(parents);
  noCategories.delete("cat-cc");
  noCategories.delete("cat-done");
  assert.equal(s.channels.reconcile("guild-1", noCategories, new Date(BASE + 1000), 5), 0);
  assert.equal(s.logs.filter((line) => line.includes("削除済み")).length, 1);
  assertQuietLogs(s.logs);
});

test("pickItems: 一覧の順に 25 件まで、ディレクトリの表示とチャンネルの有無を付ける", async (t) => {
  const s = setup(t);
  for (let i = 0; i < 30; i++) s.sessions.push(view(`${String(i).padStart(8, "0")}-0000-4000-8000-000000000000`, 1000 + i));
  await s.channels.openChannel("guild-1", S1, "web");
  const items = s.channels.pickItems();
  assert.equal(items.length, 25);
  assert.deepEqual(items[0], { sessionId: S1, label: SECRET_NAME, state: "idle", dir: "alpha", hasChannel: true });
  // 名前が無ければディレクトリ
  assert.deepEqual(items[1], { sessionId: S2, label: "beta", state: "idle", dir: "beta", hasChannel: false });
});

test("openChannel: 記録したカテゴリの ID がカテゴリでなければ（NotCategoryError）not_set_up。それ以外の失敗は failed", async (t) => {
  const s = setup(t);
  s.gateway.beforeCount = () => {
    throw new NotCategoryError();
  };
  assert.deepEqual(await s.channels.openChannel("guild-1", S1, "web"), { ok: false, reason: "not_set_up" });
  s.gateway.beforeCount = () => {
    throw new Error("network");
  };
  assert.deepEqual(await s.channels.openChannel("guild-1", S1, "web"), { ok: false, reason: "failed" });
  assert.equal(s.gateway.callsOf("createTextChannel").length, 0);
});

test("ccEndedHandler: チャンネルがあれば #system の終了の知らせを出さない（追いかけは止める）。どちらも無いときだけ #system", () => {
  const calls: string[] = [];
  const session = { sessionId: S1 } as CcSessionRow;
  const handler = (inChannel: boolean, followed: boolean) =>
    ccEndedHandler({
      channels: () => ({ ended: () => (calls.push("channel"), inChannel) }),
      replier: () => ({ ended: () => (calls.push("replier"), followed) }),
      notifier: () => ({ ended: () => void calls.push("notifier") }),
    });
  handler(true, false)(session);
  assert.deepEqual(calls.splice(0), ["channel", "replier"]);
  handler(true, true)(session);
  assert.deepEqual(calls.splice(0), ["channel", "replier"]);
  handler(false, true)(session);
  assert.deepEqual(calls.splice(0), ["channel", "replier"]);
  handler(false, false)(session);
  assert.deepEqual(calls.splice(0), ["channel", "replier", "notifier"]);
  // 連携が動いていない（どれも無い）なら何もしない
  ccEndedHandler({ channels: () => undefined, replier: () => undefined, notifier: () => undefined })(session);
});

test("routeCcChannelMessages: 削除されていない cc のチャンネルへの発言は channels に渡し（連携が無ければ捨てる）、それ以外（削除済み・ほかのチャンネル）は handler に渡す", async (t) => {
  const s = setup(t);
  s.store.create({ channelId: "cc-open", guildId: "guild-1", sessionId: S1, name: "cc-a", cwd: null, origin: "web" });
  s.store.create({ channelId: "cc-ended", guildId: "guild-1", sessionId: S2, name: "cc-b", cwd: null, origin: "web" });
  s.store.setState("cc-ended", "ended");
  s.store.create({ channelId: "cc-gone", guildId: "guild-1", sessionId: S3, name: "cc-c", cwd: null, origin: "web" });
  s.store.markDeleted("cc-gone");
  const handled: string[] = [];
  const delivered: string[] = [];
  const message = (channelId: string) => ({ id: "m", channelId, guildId: "guild-1", content: "x" }) as IncomingMessage;
  const channels = { handleMessage: async (m: IncomingMessage) => (delivered.push(m.channelId), true) };
  const handle = routeCcChannelMessages(s.store, () => channels, async (m: IncomingMessage) => void handled.push(m.channelId));
  for (const channelId of ["cc-open", "cc-ended", "cc-gone", "inbox-1"]) await handle(message(channelId));
  assert.deepEqual(handled, ["cc-gone", "inbox-1"]);
  assert.deepEqual(delivered, ["cc-open", "cc-ended"]);
  // 連携が動いていなければ黙って捨てる
  const dropped = routeCcChannelMessages(s.store, () => undefined, async (m: IncomingMessage) => void handled.push(m.channelId));
  await dropped(message("cc-open"));
  assert.deepEqual(handled, ["cc-gone", "inbox-1"]);
});

test("ccPermissionAnsweredHandler: 答えた要求のセッションで ensureFor（permission・押したサーバー）を呼ぶ。行が無い・連携が無ければ呼ばない。失敗は log だけ", async () => {
  const calls: Array<[string, string, string | undefined]> = [];
  const logs: string[] = [];
  let fail = false;
  const channels = {
    ensureFor: async (sessionId: string, origin: string, guildId?: string) => {
      calls.push([sessionId, origin, guildId]);
      if (fail) throw new Error("boom");
      return { ok: false as const, reason: "not_set_up" as const };
    },
  };
  let current: typeof channels | undefined = channels;
  const handler = ccPermissionAnsweredHandler({
    permissions: { get: (id: number) => (id === 7 ? ({ sessionId: S1 } as never) : undefined) },
    channels: () => current,
    log: (line) => logs.push(line),
  });
  handler(7, "guild-1");
  handler(7, undefined);
  handler(8, "guild-1");
  current = undefined;
  handler(7, "guild-1");
  assert.deepEqual(calls, [
    [S1, "permission", "guild-1"],
    [S1, "permission", undefined],
  ]);
  current = channels;
  fail = true;
  handler(7, "guild-1");
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(logs.length, 1);
  assertQuietLogs(logs);
});
