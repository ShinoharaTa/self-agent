// 取り込みの本体（src/cc/takeover.ts。docs/plan/takeover.md §6 の H1b）。registry・ペイン・kill・/proc・sleep・チャンネルの作成は偽物で、
// 実際のプロセスには何も送らない。DB は一時 SQLite、記録は一時ディレクトリ（~/.claude と CLAUDE_CONFIG_DIR の代わり）
import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { appendFileSync, existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { join } from "node:path";
import { createCcCommand, createCcComponent } from "../src/app/commands/cc.ts";
import { CC_TAKE_POSTED_REPLY, CC_TAKE_STALE_REPLY, type CcTakeRuntime } from "../src/app/commands/cc-take.ts";
import { layoutQueueKey } from "../src/app/commands/setup.ts";
import type { NewTopicChannelResult } from "../src/app/session-ops.ts";
import { projectDirName } from "../src/cc/claude-dirs.ts";
import type { PaneLookup } from "../src/cc/panes.ts";
import type { CcSessionView } from "../src/cc/registry.ts";
import {
  CcTakeover,
  type CcTakeoverDeps,
  CcTakeoverExpirer,
  TAKEOVER_CONFIRM_TTL_MS,
  TAKEOVER_DROPPED_TEXT,
  TAKEOVER_EXPIRED_TEXT,
  takeoverConfirmText,
  takeoverDoneText,
  takeoverLinkText,
  takeoverMovedText,
} from "../src/cc/takeover.ts";
import { prepareTarget } from "../src/cc/takeover-files.ts";
import { TAKEOVER_AFTER_TERM_TEXT, TAKEOVER_CHANNEL_TIMEOUT_MS, TAKEOVER_MAYBE_TERM_TEXT, takeoverFailureText } from "../src/cc/takeover-rules.ts";
import type { Interaction } from "../src/discord/gateway.ts";
import type { PaneState } from "../src/tmux/pane-state.ts";
import { CcChannelStore } from "../src/store/cc-channels.ts";
import { CcPermissionStore } from "../src/store/cc-permissions.ts";
import { CcSendStore } from "../src/store/cc-sends.ts";
import { CcSessionStore } from "../src/store/cc-sessions.ts";
import { CcTakeoverStore } from "../src/store/cc-takeovers.ts";
import { HistoryStore } from "../src/store/history.ts";
import { SdkSessionStore } from "../src/store/sdk-sessions.ts";
import { TopicSessionStore } from "../src/store/topic-sessions.ts";
import { GuildSettingsStore } from "../src/store/guild-settings.ts";
import { ccTakeoverRoutes, TAKEOVER_WEB_STALE_TEXT } from "../src/web/routes/cc-takeover.ts";
import { createWebServer, type WebServer } from "../src/web/server.ts";
import { tempDb, tempDir } from "./helpers/db.ts";
import { FakeGateway } from "./helpers/gateway.ts";
import { RecordingChannelOps, RecordingQueue } from "./helpers/recording.ts";
import { FakeResponder } from "./helpers/responder.ts";

const BASE = Date.parse("2026-11-13T00:00:00.000Z");
const S1 = "11111111-1111-4111-8111-111111111111";
const S2 = "22222222-2222-4222-8222-222222222222";
const S3 = "33333333-3333-4333-8333-333333333333";
const SECRET_NAME = "secret-name";
/** 端末の claude・その親（シェル）・自分 */
const PID = 4242;
const SHELL_PID = 4000;
const OWN_PID = 5000;
/** 起動の時刻（秒）と、端末の claude の starttime（clock tick。1 秒） */
const BTIME = Math.floor(BASE / 1000) - 3600;
const START_TICKS = 100;
const PROC_START_MS = BTIME * 1000 + START_TICKS * 10;
/** 偽の createChannel が最初に作るチャンネル */
const DEST = "dest-1";

type Proc = { comm: string; state: string; ppid: number; startTime: number };

/** /proc/<pid>/stat の形（comm の後ろの 1・2・20 番目が state・ppid・starttime） */
function statLine(pid: number, proc: Proc): string {
  const rest = [proc.state, String(proc.ppid), ...Array.from({ length: 17 }, () => "0"), String(proc.startTime), "0", "0"];
  return `${pid} (${proc.comm}) ${rest.join(" ")}`;
}

type Options = {
  /** 終わったセッション（一覧に無く、cc_sessions は gone） */
  ended?: boolean;
  /** cc のチャンネル（chan-1）の状態。none なら作らない（既定 open。ended のセッションは ended） */
  ccChannel?: "open" | "ended" | "resuming" | "none";
  /** プロジェクト（cwd のディレクトリ名。既定 alpha） */
  project?: string;
};

function setup(t: TestContext, options: Options = {}) {
  const db = tempDb(t);
  const root = realpathSync(tempDir(t));
  const home = join(root, "home");
  const configDir = join(root, "config");
  const workspace = join(root, "workspace");
  const cwd = join(workspace, options.project ?? "alpha");
  mkdirSync(cwd, { recursive: true });
  mkdirSync(join(configDir, "projects"), { recursive: true });
  const srcDir = join(home, ".claude", "projects", projectDirName(cwd));
  mkdirSync(srcDir, { recursive: true });
  const src = join(srcDir, `${S1}.jsonl`);
  writeFileSync(src, `${JSON.stringify({ type: "user", text: "前の会話" })}\n${JSON.stringify({ type: "assistant", text: "返事" })}\n`);
  const dst = join(configDir, "projects", projectDirName(cwd), `${S1}.jsonl`);

  const clock = { now: BASE };
  const now = (): Date => new Date(clock.now);
  const takeovers = new CcTakeoverStore(db, now);
  const ccChannels = new CcChannelStore(db, now);
  const ccSessions = new CcSessionStore(db, now);
  const ccSends = new CcSendStore(db, now);
  const ccPermissions = new CcPermissionStore(db, now);
  const topicSessions = new TopicSessionStore(db, now);
  const sdkSessions = new SdkSessionStore(db, now);
  const history = new HistoryStore(db, now);

  ccSessions.upsertSeen([{ sessionId: S1, cwd, name: SECRET_NAME, pid: PID }]);
  const view: CcSessionView = {
    sessionId: S1,
    pid: PID,
    name: SECRET_NAME,
    cwd,
    kind: "interactive",
    status: "idle",
    state: "idle",
    tmux: undefined,
    pendingPermission: false,
    trustPending: false,
    permissionMode: "plan",
    startedAt: PROC_START_MS + 1500,
  } as CcSessionView;
  const list = { sessions: options.ended === true ? [] : [view], stale: false, unreadable: false, fetchedAt: undefined as number | undefined };
  if (options.ended === true) ccSessions.markGone([]);
  const ccChannel = options.ccChannel ?? (options.ended === true ? "ended" : "open");
  if (ccChannel !== "none") {
    ccChannels.create({ channelId: "chan-1", guildId: "guild-1", sessionId: S1, name: `cc-${SECRET_NAME}`, cwd, origin: "web" });
    if (ccChannel !== "open") ccChannels.setState("chan-1", ccChannel, ["open"]);
  }

  const procs = new Map<number, Proc>([
    [PID, { comm: "claude", state: "S", ppid: SHELL_PID, startTime: START_TICKS }],
    [SHELL_PID, { comm: "bash", state: "S", ppid: 1, startTime: 50 }],
    [OWN_PID, { comm: "node", state: "S", ppid: 1, startTime: 10 }],
  ]);
  const env = {
    /** 一覧の読み取り（tick）で fetchedAt を進めるか（false なら古い一覧のまま） */
    advance: true,
    /** kill の後にプロセスが消えるか */
    exits: true,
    /** sessions/<pid>.json が返るか */
    sessionFile: true,
    /** ペインの状態（撮るたびに 1 つ取り出し、無くなれば idle） */
    probes: [] as PaneState[],
    /** sleep の度に呼ぶ（2 秒おく間の変化） */
    onSleep: (_ms: number): void => {},
    /** 新しいチャンネルの作成: ok = 作れる、not_set_up = /setup 前、throws = 例外、hangs = 期限の後に返る（late で返す） */
    channel: "ok" as "ok" | "not_set_up" | "throws" | "hangs",
    /** チャンネルの期限の待ち（sleep）が投げる */
    timeoutRejects: false,
    /** この長さの sleep が投げる（終了を待つ間の失敗など） */
    rejectSleep: undefined as number | undefined,
    /** 次の tick で、終わったセッションが一覧に戻る（端末で resume した） */
    reviveOnTick: false,
  };
  /** チャンネルの作成と kill の呼ばれた順 */
  const events: string[] = [];
  const kills: Array<{ pid: number; signal: string }> = [];
  const channelCalls: Array<{ guildId: string; title: string; projectDir: string }> = [];
  /** env.channel が hangs のとき、遅れて作成を返す */
  const late = { resolve: undefined as (() => void) | undefined };
  let exited = false;
  const gateway = new FakeGateway({ allow: ["sendMessage", "editMessage", "deleteChannel"], messageIdPrefix: "msg-" });
  const channelOps = new RecordingChannelOps();
  const queue = new RecordingQueue(1);
  const logs: string[] = [];
  const log = (line: string): void => {
    logs.push(line);
  };
  const lookup: PaneLookup = {
    ok: true,
    find: () => undefined,
    sendable: (target) => (target.pid === PID ? { ok: true, pane: { paneId: "%1" } as never } : { ok: false, reason: "not_in_tmux" }),
    pane: () => undefined,
  };
  const registry = {
    ticks: 0,
    async tick(): Promise<void> {
      this.ticks++;
      if (env.advance) list.fetchedAt = clock.now;
      if (env.reviveOnTick && !list.sessions.some((candidate) => candidate.sessionId === S1)) list.sessions = [view];
      // registry と同じく、消えたセッションは gone_at を書く
      if (exited && list.sessions.length > 0) {
        list.sessions = [];
        ccSessions.markGone([]);
      }
    },
    snapshot: () => ({ ...list }),
  };
  const createChannel = async (guildId: string, title: string, projectDir: string): Promise<NewTopicChannelResult> => {
    channelCalls.push({ guildId, title, projectDir });
    events.push("channel");
    if (env.channel === "throws") throw new Error("/secret/path");
    if (env.channel === "not_set_up") return { result: "not_set_up" };
    const channelId = `dest-${channelCalls.length}`;
    const created = { result: "created" as const, channelId, categoryId: "cat-active" };
    if (env.channel === "hangs") return new Promise((resolve) => (late.resolve = () => resolve(created)));
    return created;
  };
  const deps: CcTakeoverDeps = {
    db,
    cfg: { workspaceDir: workspace },
    home,
    claudeConfigDir: configDir,
    registry,
    panes: { lookup: async () => lookup },
    probePane: async () => ({ ok: true, state: env.probes.shift() ?? "idle" }),
    dirs: { sessionFile: (pid, sessionId) => (env.sessionFile && pid === PID && sessionId === S1 ? { bridgeSessionId: undefined, tmux: undefined, procStart: String(START_TICKS) } : undefined) },
    takeovers,
    ccChannels,
    ccSessions,
    ccSends,
    ccPermissions,
    topicSessions,
    sdkSessions,
    ready: () => true,
    checkSessionProject: (name) => ({ ok: true, projectDir: name }),
    verifiedProjectDir: (name) => join(workspace, name),
    createChannel,
    queue,
    channelOps,
    gateway,
    history,
    kill: (pid, signal) => {
      kills.push({ pid, signal });
      events.push("kill");
      if (env.exits) {
        procs.delete(pid);
        exited = true;
      }
    },
    readProc: (pid) => {
      const proc = procs.get(pid);
      return proc === undefined ? undefined : statLine(pid, proc);
    },
    readBtime: () => BTIME,
    sleep: (ms) => {
      // チャンネルの期限の待ちは、期限切れを試すときだけ終わる（ほかは作成の方が先）
      if (ms === TAKEOVER_CHANNEL_TIMEOUT_MS) {
        if (env.timeoutRejects) return Promise.reject(new Error("/secret/path"));
        return env.channel === "hangs" ? Promise.resolve() : new Promise<void>(() => {});
      }
      if (ms === env.rejectSleep) return Promise.reject(new Error("/secret/path"));
      clock.now += ms;
      env.onSleep(ms);
      return Promise.resolve();
    },
    now,
    ownPid: OWN_PID,
    note: "（前置き）",
    log,
  };
  let takeover: CcTakeover;
  const make = (overrides: Partial<CcTakeoverDeps> = {}): CcTakeover => {
    takeover = new CcTakeover({ ...deps, ...overrides });
    return takeover;
  };
  takeover = make();
  /** 確認を作り（Discord なら確認のメッセージも記録して）[取り込む] を押す */
  const proposeAndConfirm = async (t2: CcTakeover = takeover, entry: "discord" | "web" = "discord", sessionId = S1) => {
    const proposed = await t2.propose({
      sessionId,
      entry,
      guildId: "guild-1",
      ...(entry === "discord" ? { confirmChannelId: "confirm-1" } : {}),
    });
    assert.equal(proposed.ok, true, proposed.ok ? "" : proposed.reason);
    if (!proposed.ok) throw new Error("propose");
    if (entry === "discord") takeovers.setConfirmMessage(proposed.id, "msg-confirm");
    return { id: proposed.id, result: await t2.confirm(proposed.id) };
  };
  return {
    db,
    clock,
    home,
    cwd,
    src,
    dst,
    workspace,
    takeovers,
    ccChannels,
    ccSessions,
    ccSends,
    ccPermissions,
    topicSessions,
    sdkSessions,
    history,
    list,
    view,
    procs,
    env,
    events,
    kills,
    channelCalls,
    late,
    gateway,
    channelOps,
    queue,
    logs,
    registry,
    deps,
    make,
    get takeover() {
      return takeover;
    },
    proposeAndConfirm,
  };
}

type Setup = ReturnType<typeof setup>;

/** log に session_id・pid・cwd・名前・チャンネル ID を出していない（except に合う行は見ない） */
function assertQuietLogs(s: Setup, except?: RegExp): void {
  for (const line of s.logs) {
    if (except?.test(line) === true) continue;
    assert.doesNotMatch(line, /1111|2222|3333|4242|4000|secret|alpha|chan-|dest-|confirm-|workspace|home|\/tmp/, line);
  }
}

/** 取り込んでいない（sessions と channel_sessions の行は無い・記録は写していない・cc の行はそのまま） */
function assertUntouched(s: Setup, ccState: "open" | "ended" = "open"): void {
  assert.equal(s.ccChannels.get("chan-1")?.state, ccState);
  for (let n = 1; n <= s.channelCalls.length; n++) assert.equal(s.topicSessions.get(`dest-${n}`), undefined);
  assert.equal(s.sdkSessions.hasSessionId(S1), false);
  assert.equal(existsSync(s.dst), false);
}

/** チャンネルを作った後の失敗: そのチャンネルに deleteChannel が 1 回、target_channel_id が空、sessions の行は無い */
function assertDropped(s: Setup, id: number): void {
  assert.deepEqual(s.gateway.deleted, [DEST]);
  assert.equal(s.takeovers.get(id)?.targetChannelId, null);
  assert.equal(s.topicSessions.get(DEST), undefined);
}

/** チャンネルを作る前の失敗: 作成も削除も無い */
function assertNoChannel(s: Setup, id: number): void {
  assert.deepEqual(s.channelCalls, []);
  assert.deepEqual(s.gateway.deleted, []);
  assert.equal(s.takeovers.get(id)?.targetChannelId, null);
}

const tick = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

test("待機のセッション: 新しいチャンネルを作った後で SIGTERM をその pid に 1 回だけ送り、記録を写して新しいチャンネルをプロジェクトのセッションにする", async (t) => {
  const s = setup(t);
  const proposed = await s.takeover.propose({ sessionId: S1, entry: "discord", guildId: "guild-1", confirmChannelId: "confirm-1" });
  assert.ok(proposed.ok);
  assert.equal(proposed.message.text, takeoverConfirmText({ title: SECRET_NAME, project: "alpha", source: "alive", terminalMode: "plan" }));
  assert.match(proposed.message.text, /端末の Claude Code は終了し、続きは新しいチャンネルで self-agent が引き継ぎます。許可のモードは default になります（端末: plan）/);
  assert.deepEqual(
    proposed.message.components?.[0]?.kind === "buttons" ? proposed.message.components[0].buttons.map((button) => button.customId) : [],
    [`cc:take:go:${proposed.id}`, `cc:take:no:${proposed.id}`],
  );
  // 確認の間は行き先を作らない
  assert.deepEqual(s.channelCalls, []);
  s.takeovers.setConfirmMessage(proposed.id, "msg-confirm");
  const result = await s.takeover.confirm(proposed.id);
  assert.deepEqual(result, { ok: true, channelId: DEST, text: takeoverLinkText(DEST), plainText: takeoverDoneText("alpha", false, false), edited: true });
  // チャンネルの作成が kill より前。/new と同じキューの中で作る
  assert.deepEqual(s.events, ["channel", "kill"]);
  assert.deepEqual(s.channelCalls, [{ guildId: "guild-1", title: SECRET_NAME, projectDir: "alpha" }]);
  assert.deepEqual(s.queue.keys, [layoutQueueKey("guild-1")]);
  assert.deepEqual(s.kills, [{ pid: PID, signal: "SIGTERM" }]);
  const session = s.topicSessions.get(DEST);
  assert.deepEqual(s.topicSessions.projectDirOf(DEST), { projectDir: "alpha", permissionMode: "default" });
  assert.equal(session?.state, "active");
  assert.equal(session?.title, SECRET_NAME);
  assert.equal(session?.categoryId, "cat-active");
  assert.equal(session?.origin, "command");
  assert.equal(s.sdkSessions.get(DEST), S1);
  const row = s.takeovers.get(proposed.id);
  assert.equal(row?.state, "done");
  assert.equal(row?.notePending, true);
  assert.equal(row?.targetChannelId, DEST);
  assert.notEqual(row?.effectsAt, null);
  assert.equal(readFileSync(s.dst, "utf8"), readFileSync(s.src, "utf8"));
  // 後始末: 行き先に完了の文・確認の文を「取り込みました → <#…>」に（ボタンを外す）・Web の会話の区切りと知らせ・cc のチャンネルに案内
  assert.deepEqual(
    s.gateway.posts.map((post) => [post.channelId, post.message.text]),
    [
      [DEST, takeoverDoneText("alpha", false)],
      ["chan-1", takeoverMovedText(DEST)],
    ],
  );
  assert.deepEqual(s.gateway.edits, [{ channelId: "confirm-1", messageId: "msg-confirm", message: { text: takeoverLinkText(DEST), components: [] } }]);
  assert.deepEqual(
    s.history.list(DEST, { limit: 10 }).map((entry) => [entry.kind, entry.text]),
    [
      ["divider", "端末の Claude Code から取り込みました（alpha）"],
      ["notice", takeoverDoneText("alpha", false, false)],
    ],
  );
  assert.equal(s.ccChannels.get("chan-1")?.state, "deleted");
  assert.deepEqual(s.channelOps.moves, [{ channelId: "chan-1", target: { kind: "state", guildId: "guild-1", state: "done" } }]);
  assert.deepEqual(s.gateway.deleted, []);
  assertQuietLogs(s);
});

test("終わったセッション（gone）: kill なしで同じ結果", async (t) => {
  const s = setup(t, { ended: true });
  const proposed = await s.takeover.propose({ sessionId: S1, entry: "discord", guildId: "guild-1", confirmChannelId: "confirm-1" });
  assert.ok(proposed.ok);
  assert.match(proposed.message.text, /端末の Claude Code はすでに終わっています。続きは新しいチャンネルで/);
  const result = await s.takeover.confirm(proposed.id);
  assert.equal(result.ok, true);
  assert.deepEqual(s.kills, []);
  assert.deepEqual(s.events, ["channel"]);
  assert.deepEqual(s.topicSessions.projectDirOf(DEST), { projectDir: "alpha", permissionMode: "default" });
  assert.equal(s.sdkSessions.get(DEST), S1);
  assert.equal(s.takeovers.get(proposed.id)?.state, "done");
  assert.equal(s.takeovers.get(proposed.id)?.notePending, true);
  assert.equal(s.takeovers.get(proposed.id)?.targetChannelId, DEST);
  assert.equal(existsSync(s.dst), true);
  assert.ok(s.gateway.posts.some((post) => post.channelId === DEST && post.message.text === takeoverDoneText("alpha", false)));
  assertQuietLogs(s);
});

for (const [name, broken] of [
  ["stale", (s: Setup) => (s.list.stale = true)],
  ["unreadable", (s: Setup) => (s.list.unreadable = true)],
  ["古い（読む前の時刻より前）", (s: Setup) => (s.env.advance = false)],
] as const) {
  for (const ended of [false, true]) {
    test(`一覧が ${name}（${ended ? "終わった" : "待機の"}セッション）: list_failed で kill しない`, async (t) => {
      const s = setup(t, { ended });
      if (name.startsWith("古い")) s.list.fetchedAt = BASE - 1000;
      broken(s);
      const proposed = await s.takeover.propose({ sessionId: S1, entry: "discord", guildId: "guild-1", confirmChannelId: "confirm-1" });
      assert.deepEqual(proposed, { ok: false, reason: "list_failed", text: takeoverFailureText("list_failed", false) });
      assert.deepEqual(s.kills, []);
      assert.deepEqual(s.channelCalls, []);
      assertUntouched(s, ended ? "ended" : "open");
      assertQuietLogs(s);
    });
  }
}

test("確認の後に一覧が読めなくなった: [取り込む] は list_failed で、チャンネルを作らずに確認の文を書き換える", async (t) => {
  const s = setup(t);
  const proposed = await s.takeover.propose({ sessionId: S1, entry: "discord", guildId: "guild-1", confirmChannelId: "confirm-1" });
  assert.ok(proposed.ok);
  s.takeovers.setConfirmMessage(proposed.id, "msg-confirm");
  s.list.stale = true;
  const result = await s.takeover.confirm(proposed.id);
  assert.deepEqual(result, { ok: false, reason: "list_failed", text: takeoverFailureText("list_failed", false), plainText: takeoverFailureText("list_failed", false), edited: true });
  assert.equal(s.takeovers.get(proposed.id)?.state, "failed");
  assert.equal(s.takeovers.get(proposed.id)?.failure, "list_failed");
  assert.deepEqual(s.gateway.edits, [{ channelId: "confirm-1", messageId: "msg-confirm", message: { text: takeoverFailureText("list_failed", false), components: [] } }]);
  assert.deepEqual(s.kills, []);
  assertNoChannel(s, proposed.id);
  assertUntouched(s);
});

test("確かめ直しで busy: kill しない。作ったチャンネルは消す", async (t) => {
  const s = setup(t);
  // propose・check は idle、2 秒後の確かめ直しで一覧が busy
  s.env.onSleep = (ms) => {
    if (ms === 2000) s.list.sessions[0] = { ...s.view, status: "busy", state: "running" };
  };
  const { id, result } = await s.proposeAndConfirm();
  assert.equal(!result.ok && result.reason, "busy");
  assert.deepEqual(s.kills, []);
  assertDropped(s, id);
  assertUntouched(s);
  assertQuietLogs(s);
});

test("確かめ直しでペインが待機でない: pane で kill しない。作ったチャンネルは消す", async (t) => {
  const s = setup(t);
  // propose・check は idle、2 秒後の確かめ直しでペインが書きかけ
  s.env.probes = ["idle", "idle", "draft"];
  const { id, result } = await s.proposeAndConfirm();
  assert.equal(!result.ok && result.reason, "pane");
  assert.deepEqual(s.kills, []);
  assertDropped(s, id);
  assertUntouched(s);
});

test("確かめ直しで記録に user の行が増えた: changed で kill しない。作ったチャンネルは消す", async (t) => {
  const s = setup(t);
  s.env.onSleep = () => appendFileSync(s.src, `${JSON.stringify({ type: "user", text: "新しい指示" })}\n`);
  const { id, result } = await s.proposeAndConfirm();
  assert.equal(!result.ok && result.reason, "changed");
  assert.deepEqual(s.kills, []);
  assertDropped(s, id);
  assertUntouched(s);
});

test("確かめ直しで増えた行が user・assistant でなければ進む", async (t) => {
  const s = setup(t);
  s.env.onSleep = (ms) => {
    if (ms === 2000) appendFileSync(s.src, `${JSON.stringify({ type: "last-prompt" })}\n`);
  };
  const { result } = await s.proposeAndConfirm();
  assert.equal(result.ok, true);
  assert.equal(s.kills.length, 1);
});

for (const [name, breakIt] of [
  ["comm が claude でない", (s: Setup) => (s.procs.get(PID)!.comm = "node")],
  ["starttime が最初と違う", (s: Setup) => (s.procs.get(PID)!.startTime = START_TICKS + 1)],
  ["開始が startedAt + 2 秒より後", (s: Setup) => (s.list.sessions[0] = { ...s.view, startedAt: PROC_START_MS - 2001 })],
  ["自分が相手の子孫（相手の祖先に自分）", (s: Setup) => (s.procs.get(SHELL_PID)!.ppid = OWN_PID)],
  ["自分の祖先が相手", (s: Setup) => (s.procs.get(OWN_PID)!.ppid = PID)],
  ["sessions/<pid>.json がその session_id でない", (s: Setup) => (s.env.sessionFile = false)],
] as const) {
  test(`相手の確かめ（${name}）: identity で kill しない。作ったチャンネルは消す`, async (t) => {
    const s = setup(t);
    // 最初の確かめの後（2 秒おく間）に変わる
    s.env.onSleep = (ms) => {
      if (ms === 2000) breakIt(s);
    };
    const { id, result } = await s.proposeAndConfirm();
    assert.deepEqual(result, { ok: false, reason: "identity", text: takeoverFailureText("identity", false), plainText: takeoverFailureText("identity", false), edited: true });
    assert.equal(s.takeovers.get(id)?.failure, "identity");
    assert.deepEqual(s.kills, []);
    assertDropped(s, id);
    assertUntouched(s);
    assertQuietLogs(s);
  });
}

test("端末の cwd が runner の cwd と違う: outside_workspace で kill しない", async (t) => {
  const s = setup(t);
  const takeover = s.make({ verifiedProjectDir: (name) => join(s.workspace, "elsewhere", name) });
  const proposed = await takeover.propose({ sessionId: S1, entry: "discord", guildId: "guild-1", confirmChannelId: "confirm-1" });
  assert.equal(!proposed.ok && proposed.reason, "outside_workspace");
  assert.deepEqual(s.kills, []);
  assert.deepEqual(s.channelCalls, []);
  assertUntouched(s);
});

test("propose: 一覧にも cc_sessions にも無い session_id は identity で断る（outside_workspace と言わない）。チャンネルも kill も無い", async (t) => {
  const s = setup(t);
  const proposed = await s.takeover.propose({ sessionId: S2, entry: "discord", guildId: "guild-1", confirmChannelId: "confirm-1" });
  assert.equal(!proposed.ok && proposed.reason, "identity");
  assert.equal(!proposed.ok && proposed.text, takeoverFailureText("identity", false));
  assert.deepEqual(s.kills, []);
  assert.deepEqual(s.channelCalls, []);
  assertUntouched(s);
  assertQuietLogs(s);
});

test("propose: cc_sessions に行が在って cwd が無いセッションは今までどおり outside_workspace", async (t) => {
  const s = setup(t, { ended: true });
  s.db.prepare("UPDATE cc_sessions SET cwd = NULL WHERE session_id = ?").run(S1);
  const proposed = await s.takeover.propose({ sessionId: S1, entry: "discord", guildId: "guild-1", confirmChannelId: "confirm-1" });
  assert.equal(!proposed.ok && proposed.reason, "outside_workspace");
  assert.deepEqual(s.kills, []);
  assert.deepEqual(s.channelCalls, []);
});

for (const [name, mode] of [
  ["/setup 前（not_set_up）", "not_set_up"],
  ["作成が投げる", "throws"],
] as const) {
  test(`新しいチャンネルを作れない（${name}）: no_channel で kill しない（layoutQueueKey のキューの中で呼ぶ）`, async (t) => {
    const s = setup(t);
    s.env.channel = mode;
    const { id, result } = await s.proposeAndConfirm();
    assert.deepEqual(result, { ok: false, reason: "no_channel", text: takeoverFailureText("no_channel", false), plainText: takeoverFailureText("no_channel", false), edited: true });
    assert.deepEqual(s.queue.keys, [layoutQueueKey("guild-1")]);
    assert.deepEqual(s.kills, []);
    assert.deepEqual(s.gateway.deleted, []);
    assert.equal(s.takeovers.get(id)?.targetChannelId, null);
    assert.equal(s.takeovers.get(id)?.step, "channel");
    assertUntouched(s);
    assertQuietLogs(s);
  });
}

test("新しいチャンネルの作成が期限（15 秒）を過ぎた: no_channel で kill しない。後から返ったチャンネルは消す（DB に残らない）", async (t) => {
  const s = setup(t);
  s.env.channel = "hangs";
  const { id, result } = await s.proposeAndConfirm();
  assert.deepEqual(result, { ok: false, reason: "no_channel", text: takeoverFailureText("no_channel", false), plainText: takeoverFailureText("no_channel", false), edited: true });
  assert.deepEqual(s.kills, []);
  assert.deepEqual(s.gateway.deleted, []);
  s.late.resolve!();
  await tick();
  await tick();
  assert.deepEqual(s.gateway.deleted, [DEST]);
  assert.equal(s.takeovers.get(id)?.targetChannelId, null);
  assert.equal(s.topicSessions.get(DEST), undefined);
  assertUntouched(s);
  assertQuietLogs(s);
});

test("期限の後に返ったチャンネルを消せない: log に手で消せるようチャンネル ID を出す（ほかの log には出さない）", async (t) => {
  const s = setup(t);
  s.env.channel = "hangs";
  s.gateway.beforeDelete = () => {
    throw new Error("missing permissions");
  };
  await s.proposeAndConfirm();
  s.late.resolve!();
  await tick();
  await tick();
  assert.deepEqual(s.gateway.deleted, [DEST]);
  assert.equal(s.logs.filter((line) => line.includes(DEST)).length, 1);
  assertQuietLogs(s, /手で消してください/);
});

test("setTarget が false: 作ったチャンネルを消して internal。kill しない", async (t) => {
  const s = setup(t);
  const store = Object.create(s.takeovers) as typeof s.takeovers;
  store.setTarget = () => false;
  const { id, result } = await s.proposeAndConfirm(s.make({ takeovers: store }));
  assert.deepEqual(result, { ok: false, reason: "internal", text: takeoverFailureText("internal", false), plainText: takeoverFailureText("internal", false), edited: true });
  assert.deepEqual(s.kills, []);
  assert.deepEqual(s.gateway.deleted, [DEST]);
  assert.equal(s.takeovers.get(id)?.state, "failed");
  assert.equal(s.takeovers.get(id)?.targetChannelId, null);
  assertUntouched(s);
  assertQuietLogs(s);
});

test("setTarget が投げる（同じ行き先が別の行に在るかもしれない）: 消さずに log に手で消せるようチャンネル ID を出して internal。kill しない", async (t) => {
  const s = setup(t);
  const store = Object.create(s.takeovers) as typeof s.takeovers;
  store.setTarget = () => {
    throw new Error("UNIQUE constraint failed: /secret/path");
  };
  const { id, result } = await s.proposeAndConfirm(s.make({ takeovers: store }));
  assert.deepEqual(result, { ok: false, reason: "internal", text: takeoverFailureText("internal", false), plainText: takeoverFailureText("internal", false), edited: true });
  assert.deepEqual(s.kills, []);
  assert.deepEqual(s.gateway.deleted, []);
  assert.equal(s.takeovers.get(id)?.state, "failed");
  assert.equal(s.takeovers.get(id)?.targetChannelId, null);
  assert.equal(s.logs.filter((line) => line.includes(DEST)).length, 1);
  assert.ok(s.logs.some((line) => line.includes(DEST) && line.includes("手で消してください")));
  assertUntouched(s);
  assertQuietLogs(s, /手で消してください/);
});

test("チャンネルの期限の待ちが投げる: no_channel で kill しない。その後に作成が返ったら、そのチャンネルは消す", async (t) => {
  const s = setup(t);
  s.env.channel = "hangs";
  s.env.timeoutRejects = true;
  const { id, result } = await s.proposeAndConfirm();
  assert.deepEqual(result, { ok: false, reason: "no_channel", text: takeoverFailureText("no_channel", false), plainText: takeoverFailureText("no_channel", false), edited: true });
  assert.deepEqual(s.kills, []);
  assert.deepEqual(s.gateway.deleted, []);
  s.late.resolve!();
  await tick();
  await tick();
  assert.deepEqual(s.gateway.deleted, [DEST]);
  assert.equal(s.takeovers.get(id)?.targetChannelId, null);
  assertUntouched(s);
  assertQuietLogs(s);
});

test("SIGTERM の後・終了を見届けた後の例外: copy_failed で続け方（終了しています）の文。作ったチャンネルは消す", async (t) => {
  const s = setup(t);
  const store = Object.create(s.takeovers) as typeof s.takeovers;
  store.setStep = (stepId, step) => {
    if (step === "copy") throw new Error("/secret/path");
    return s.takeovers.setStep(stepId, step);
  };
  const { id, result } = await s.proposeAndConfirm(s.make({ takeovers: store }));
  assert.deepEqual(result, { ok: false, reason: "copy_failed", text: takeoverFailureText("copy_failed", true), plainText: takeoverFailureText("copy_failed", true), edited: true });
  assert.match(!result.ok && "text" in result ? result.text : "", new RegExp(TAKEOVER_AFTER_TERM_TEXT));
  assert.deepEqual(s.kills, [{ pid: PID, signal: "SIGTERM" }]);
  assertDropped(s, id);
  assertQuietLogs(s);
});

test("SIGTERM の後・終了を見届ける前の例外（終了を待つ sleep が投げる）: copy_failed で「終了しているかもしれません」の文。作ったチャンネルは消す", async (t) => {
  const s = setup(t);
  s.env.rejectSleep = 250;
  const { id, result } = await s.proposeAndConfirm();
  const text = `${takeoverFailureText("copy_failed", false)}\n${TAKEOVER_MAYBE_TERM_TEXT}`;
  assert.deepEqual(result, { ok: false, reason: "copy_failed", text, plainText: text, edited: true });
  assert.doesNotMatch(text, /終了しています/);
  assert.deepEqual(s.kills, [{ pid: PID, signal: "SIGTERM" }]);
  assertDropped(s, id);
  assertQuietLogs(s);
});

test("終わったセッションの取り込み: チャンネルの作成の間に一覧へ戻った（読み直した一覧に現れる）なら changed で写さない。作ったチャンネルは消す", async (t) => {
  const s = setup(t, { ended: true });
  const takeover = s.make({
    createChannel: async (guildId, title, projectDir) => {
      const created = await s.deps.createChannel(guildId, title, projectDir);
      s.env.reviveOnTick = true;
      return created;
    },
  });
  const { id, result } = await s.proposeAndConfirm(takeover);
  assert.equal(!result.ok && result.reason, "changed");
  assert.deepEqual(s.kills, []);
  assert.equal(existsSync(s.dst), false);
  assertDropped(s, id);
  assertUntouched(s, "ended");
});

test("確かめ直しで記録が読めない・短くなった（readAppended が undefined）: changed で kill しない。作ったチャンネルは消す", async (t) => {
  const s = setup(t);
  const { id, result } = await s.proposeAndConfirm(s.make({ files: { readAppended: () => undefined } }));
  assert.equal(!result.ok && result.reason, "changed");
  assert.deepEqual(s.kills, []);
  assertDropped(s, id);
  assertUntouched(s);
});

test("確かめ直しで生きていない（2 秒の間に終わった）: identity でなく changed で kill しない。作ったチャンネルは消す", async (t) => {
  const s = setup(t);
  s.env.onSleep = (ms) => {
    if (ms !== 2000) return;
    s.list.sessions = [];
    s.ccSessions.markGone([]);
  };
  const { id, result } = await s.proposeAndConfirm();
  assert.equal(!result.ok && result.reason, "changed");
  assert.deepEqual(s.kills, []);
  assertDropped(s, id);
});

test("kill の後に pid が消えない: not_exited（後ろの文は足さない）。作ったチャンネルは消す", async (t) => {
  const s = setup(t);
  s.env.exits = false;
  const { id, result } = await s.proposeAndConfirm();
  assert.deepEqual(result, { ok: false, reason: "not_exited", text: takeoverFailureText("not_exited", true), plainText: takeoverFailureText("not_exited", true), edited: true });
  assert.doesNotMatch(!result.ok && "text" in result ? result.text : "", new RegExp(TAKEOVER_AFTER_TERM_TEXT));
  assert.deepEqual(s.kills, [{ pid: PID, signal: "SIGTERM" }]);
  assert.equal(s.takeovers.get(id)?.state, "failed");
  assertDropped(s, id);
  assertUntouched(s);
});

test("写しの失敗: copy_failed（SIGTERM の後なので続け方を足す）。作ったチャンネルは消し、cc のチャンネルには触らない", async (t) => {
  const s = setup(t);
  const takeover = s.make({
    files: {
      copyTranscript: () => {
        throw new Error("写せない");
      },
    },
  });
  const { id, result } = await s.proposeAndConfirm(takeover);
  assert.deepEqual(result, { ok: false, reason: "copy_failed", text: takeoverFailureText("copy_failed", true), plainText: takeoverFailureText("copy_failed", true), edited: true });
  assertDropped(s, id);
  assert.equal(s.ccChannels.get("chan-1")?.state, "open");
  assert.deepEqual(s.channelOps.moves, []);
  assertQuietLogs(s);
});

test("recoverRunning（前段）だけで running は failed（restart）になり holds は false。確認の文の書き換えは recoverEffects（後段）で 1 回（宛ては confirm_channel_id）", async (t) => {
  const s = setup(t);
  const proposed = await s.takeover.propose({ sessionId: S1, entry: "discord", guildId: "guild-1", confirmChannelId: "confirm-1" });
  assert.ok(proposed.ok);
  s.takeovers.setConfirmMessage(proposed.id, "msg-confirm");
  s.takeovers.start(proposed.id);
  assert.equal(s.takeover.holds(S1), true);
  s.takeover.recoverRunning();
  assert.equal(s.takeover.holds(S1), false);
  assert.equal(s.takeovers.get(proposed.id)?.failure, "restart");
  await tick();
  assert.deepEqual(s.gateway.edits, []);
  await s.takeover.recoverEffects();
  await tick();
  assert.deepEqual(s.gateway.edits, [{ channelId: "confirm-1", messageId: "msg-confirm", message: { text: takeoverFailureText("restart", false), components: [] } }]);
  await s.takeover.recoverEffects();
  await tick();
  assert.equal(s.gateway.edits.length, 1);
  assertQuietLogs(s);
});

/** 取り込みの行を直接作る（discord なら確認のチャンネル付き） */
function addRow(s: Setup, sessionId: string, source: "alive" | "ended" = "alive", entry: "discord" | "web" = "discord") {
  return s.takeovers.propose({
    sessionId,
    source,
    project: "alpha",
    guildId: "guild-1",
    entry,
    ...(entry === "discord" ? { confirmChannelId: `confirm-${sessionId.slice(0, 1)}` } : {}),
    permissionMode: "default",
  })!;
}

test("recover: restart にした行の確認の文を書き換える（check・channel は 1 行、term・copy・commit は 2 行、確認の文が無ければ何もしない）", async (t) => {
  const s = setup(t);
  const add = (sessionId: string, step: "check" | "channel" | "term" | "copy" | "commit", messageId?: string) => {
    const row = addRow(s, sessionId);
    s.takeovers.start(row.id);
    s.takeovers.setStep(row.id, step);
    if (messageId !== undefined) s.takeovers.setConfirmMessage(row.id, messageId);
    return row;
  };
  add(S1, "channel", "msg-a");
  add(S2, "term", "msg-b");
  add(S3, "commit");
  await s.takeover.recover();
  await tick();
  const restart = takeoverFailureText("restart", false);
  assert.deepEqual(s.gateway.edits, [
    { channelId: "confirm-1", messageId: "msg-a", message: { text: restart, components: [] } },
    { channelId: "confirm-2", messageId: "msg-b", message: { text: `${restart}\n${TAKEOVER_MAYBE_TERM_TEXT}`, components: [] } },
  ]);
  assert.doesNotMatch(s.gateway.edits[1]!.message.text, new RegExp(TAKEOVER_AFTER_TERM_TEXT));
  assertQuietLogs(s);
});

test("recover: 確認の文の書き換えに失敗しても投げず、log だけ", async (t) => {
  const s = setup(t);
  const row = addRow(s, S1);
  s.takeovers.start(row.id);
  s.takeovers.setStep(row.id, "copy");
  s.takeovers.setConfirmMessage(row.id, "msg-a");
  s.gateway.beforeEdit = () => {
    throw new Error("/secret/path/11111111");
  };
  await s.takeover.recover();
  await tick();
  assert.equal(s.takeovers.get(row.id)?.failure, "restart");
  assert.ok(s.logs.some((line) => line.includes("確認の文を書き換えられませんでした")));
  assertQuietLogs(s);
});

test("recover: 終わったセッション（source ended）の行には「終了しているかもしれません」を足さない", async (t) => {
  const s = setup(t);
  const row = addRow(s, S1, "ended");
  s.takeovers.start(row.id);
  s.takeovers.setStep(row.id, "copy");
  s.takeovers.setConfirmMessage(row.id, "msg-a");
  await s.takeover.recover();
  await tick();
  assert.deepEqual(s.gateway.edits, [{ channelId: "confirm-1", messageId: "msg-a", message: { text: takeoverFailureText("restart", false), components: [] } }]);
});

test("recover: 行き先を作った後に再起動した行は、restart にしてから行き先を消す", async (t) => {
  const s = setup(t);
  const row = addRow(s, S1);
  s.takeovers.start(row.id);
  s.takeovers.setStep(row.id, "channel");
  s.takeovers.setTarget(row.id, DEST);
  await s.takeover.recover();
  assert.equal(s.takeovers.get(row.id)?.failure, "restart");
  assert.deepEqual(s.gateway.deleted, [DEST]);
  assert.equal(s.takeovers.get(row.id)?.targetChannelId, null);
  assertQuietLogs(s);
});

test("holds は running の行だけを見る", async (t) => {
  const s = setup(t);
  const proposed = await s.takeover.propose({ sessionId: S1, entry: "web", guildId: "guild-1" });
  assert.ok(proposed.ok);
  assert.equal(s.takeover.holds(S1), false);
  s.takeovers.start(proposed.id);
  assert.equal(s.takeover.holds(S1), true);
  assert.equal(s.takeover.holds(S2), false);
  s.takeovers.fail(proposed.id, "restart");
  assert.equal(s.takeover.holds(S1), false);
});

test("propose: 確認待ちがあれば in_progress、届け待ちがあれば queued", async (t) => {
  const s = setup(t);
  const first = await s.takeover.propose({ sessionId: S1, entry: "discord", guildId: "guild-1", confirmChannelId: "confirm-1" });
  assert.ok(first.ok);
  const again = await s.takeover.propose({ sessionId: S1, entry: "discord", guildId: "guild-1", confirmChannelId: "confirm-1" });
  assert.equal(!again.ok && again.reason, "in_progress");
  s.takeover.cancel(first.id);
  s.ccSends.add({ sessionId: S1, text: "x", origin: "web", state: "queued" });
  const queued = await s.takeover.propose({ sessionId: S1, entry: "discord", guildId: "guild-1", confirmChannelId: "confirm-1" });
  assert.equal(!queued.ok && queued.reason, "queued");
  assertQuietLogs(s);
});

test("idle(): 実行中の confirm が終わるまで返らない。何も無ければすぐ返る。confirm が失敗で終わっても返る", async (t) => {
  for (const fails of [false, true]) {
    const s = setup(t, { ended: true });
    // 何も無ければすぐ返る
    await s.takeover.idle();
    let release = (): void => {};
    const gate = new Promise<void>((resolve) => (release = resolve));
    const takeover = s.make({
      createChannel: async () => {
        await gate;
        if (fails) throw new Error("/secret/path");
        return { result: "created", channelId: DEST, categoryId: "cat-active" };
      },
    });
    const proposed = await takeover.propose({ sessionId: S1, entry: "web", guildId: "guild-1" });
    assert.ok(proposed.ok);
    const confirming = takeover.confirm(proposed.id);
    let idled = false;
    const idle = takeover.idle().then(() => {
      idled = true;
    });
    for (let n = 0; n < 5; n++) await tick();
    assert.equal(idled, false, String(fails));
    release();
    const result = await confirming;
    await idle;
    assert.equal(idled, true, String(fails));
    assert.equal(result.ok, !fails, String(fails));
    await takeover.idle();
  }
});

test("propose: 許可の保留があれば queued、取り込み済み（channel_sessions にある）なら already_taken", async (t) => {
  const s = setup(t);
  const permission = s.ccPermissions.add({ sessionId: S1, requestHash: "h", toolName: "Bash", summary: "x", permissionMode: null, state: "pending" });
  const waiting = await s.takeover.propose({ sessionId: S1, entry: "web", guildId: "guild-1" });
  assert.equal(!waiting.ok && waiting.reason, "queued");
  s.ccPermissions.resolve(permission.id, "denied", "web");
  s.sdkSessions.set("other-channel", S1);
  const taken = await s.takeover.propose({ sessionId: S1, entry: "web", guildId: "guild-1" });
  assert.equal(!taken.ok && taken.reason, "already_taken");
  assert.deepEqual(s.kills, []);
});

test("[取り込む] の前に届け待ちが積まれた: start の後に確かめて queued で kill しない（チャンネルも作らない）", async (t) => {
  const s = setup(t);
  const proposed = await s.takeover.propose({ sessionId: S1, entry: "web", guildId: "guild-1" });
  assert.ok(proposed.ok);
  s.ccSends.add({ sessionId: S1, text: "x", origin: "web", state: "queued" });
  const result = await s.takeover.confirm(proposed.id);
  assert.equal(!result.ok && result.reason, "queued");
  assert.deepEqual(s.kills, []);
  assertNoChannel(s, proposed.id);
});

test("confirm: 10 分を過ぎた確認は expired（取り消して書き換える）、cancel の後は stale。expire は期限切れを書き換える", async (t) => {
  const s = setup(t);
  const proposed = await s.takeover.propose({ sessionId: S1, entry: "discord", guildId: "guild-1", confirmChannelId: "confirm-1" });
  assert.ok(proposed.ok);
  s.takeovers.setConfirmMessage(proposed.id, "msg-confirm");
  s.clock.now += TAKEOVER_CONFIRM_TTL_MS;
  assert.deepEqual(await s.takeover.confirm(proposed.id), { ok: false, reason: "expired", text: TAKEOVER_EXPIRED_TEXT, plainText: TAKEOVER_EXPIRED_TEXT, edited: true });
  assert.equal(s.takeovers.get(proposed.id)?.state, "cancelled");
  assert.deepEqual(s.gateway.edits.at(-1), { channelId: "confirm-1", messageId: "msg-confirm", message: { text: TAKEOVER_EXPIRED_TEXT, components: [] } });
  assert.deepEqual(await s.takeover.confirm(proposed.id), { ok: false, reason: "stale" });
  assert.deepEqual(s.kills, []);
  assert.deepEqual(s.channelCalls, []);

  const second = await s.takeover.propose({ sessionId: S1, entry: "discord", guildId: "guild-1", confirmChannelId: "confirm-1" });
  assert.ok(second.ok);
  s.takeovers.setConfirmMessage(second.id, "msg-confirm-2");
  assert.equal(await s.takeover.expire(), 0);
  s.clock.now += TAKEOVER_CONFIRM_TTL_MS;
  assert.equal(await s.takeover.expire(), 1);
  assert.deepEqual(s.gateway.edits.at(-1), { channelId: "confirm-1", messageId: "msg-confirm-2", message: { text: TAKEOVER_EXPIRED_TEXT, components: [] } });

  const third = await s.takeover.propose({ sessionId: S1, entry: "discord", guildId: "guild-1", confirmChannelId: "confirm-1" });
  assert.ok(third.ok);
  assert.equal(s.takeover.cancel(third.id), true);
  assert.equal(s.takeover.cancel(third.id), false);
  assert.deepEqual(await s.takeover.confirm(third.id), { ok: false, reason: "stale" });
});

test("CcTakeoverExpirer: expire が投げても sweep は reject せず log だけ。stop の後は start しない", async () => {
  const logs: string[] = [];
  const expirer = new CcTakeoverExpirer({
    takeover: { expire: async () => Promise.reject(new TypeError("chan-1 の行を読めない")) },
    log: (line) => void logs.push(line),
    timers: { after: () => () => {} },
  });
  await expirer.sweep();
  assert.deepEqual(logs, ["Claude Code: 取り込みの確認の失効を確かめられませんでした（TypeError）"]);
  let calls = 0;
  const stopped = new CcTakeoverExpirer({
    takeover: {
      expire: async () => {
        calls++;
        return 0;
      },
    },
    log: () => {},
  });
  stopped.stop();
  stopped.start();
  await stopped.idle();
  assert.equal(calls, 0);
});

test("noteFor・noteDone・resumeDropped（§3.6.1・§3.6.3）は行き先のチャンネルで引く", async (t) => {
  const s = setup(t, { ended: true });
  assert.equal(s.takeover.noteFor(DEST, S1, {}), undefined);
  const { result } = await s.proposeAndConfirm();
  assert.equal(result.ok, true);
  assert.equal(s.takeover.noteFor(DEST, S1, {}), "（前置き）");
  // cc のチャンネル（取り込む前の場所）・session_id が違う・/close の要約・予約では付けない
  assert.equal(s.takeover.noteFor("chan-1", S1, {}), undefined);
  assert.equal(s.takeover.noteFor(DEST, S2, {}), undefined);
  assert.equal(s.takeover.noteFor(DEST, S1, { purpose: "close" }), undefined);
  assert.equal(s.takeover.noteFor(DEST, S1, { scheduled: true }), undefined);
  // 前置きが無い設定なら何も返さない
  assert.equal(s.make({ note: undefined }).noteFor(DEST, S1, {}), undefined);
  s.make();
  // resumeDropped が違う session_id なら、知らせも前置きの取り消しも無い
  const postsBeforeOther = s.gateway.posts.length;
  s.takeover.resumeDropped(DEST, S2);
  await tick();
  assert.equal(s.gateway.posts.length, postsBeforeOther);
  assert.equal(s.takeovers.takenFor(DEST)?.notePending, true);
  assert.equal(s.takeover.noteFor(DEST, S1, {}), "（前置き）");
  s.takeover.noteDone(DEST);
  assert.equal(s.takeover.noteFor(DEST, S1, {}), undefined);

  // resumeDropped: 取り込んだ session_id のときだけ、行き先に 1 回だけ知らせる
  const before = s.gateway.posts.length;
  s.takeover.resumeDropped(DEST, S2);
  s.takeover.resumeDropped(DEST, S1);
  s.takeover.resumeDropped(DEST, S1);
  await tick();
  const dropped = s.gateway.posts.slice(before);
  assert.deepEqual(dropped.map((post) => [post.channelId, post.message.text]), [[DEST, TAKEOVER_DROPPED_TEXT]]);
  assert.ok(s.history.list(DEST, { limit: 10 }).some((entry) => entry.kind === "notice" && entry.text === TAKEOVER_DROPPED_TEXT));
  assertQuietLogs(s);
});

test("commit の途中の例外（sessions の INSERT が投げる）: 全部巻き戻り、行き先は消える", async (t) => {
  const s = setup(t);
  const takeover = s.make({
    topicSessions: {
      create: () => {
        throw new Error("/secret/path");
      },
      get: (channelId) => s.topicSessions.get(channelId),
    },
  });
  const { id, result } = await s.proposeAndConfirm(takeover);
  assert.deepEqual(result, { ok: false, reason: "copy_failed", text: takeoverFailureText("copy_failed", true), plainText: takeoverFailureText("copy_failed", true), edited: true });
  assert.equal(s.kills.length, 1);
  assert.equal(s.takeovers.get(id)?.state, "failed");
  assert.equal(s.takeovers.get(id)?.notePending, false);
  assert.equal(s.sdkSessions.get(DEST), undefined);
  assert.equal(s.db.isTransaction, false);
  assertDropped(s, id);
  // cc のチャンネルは普段どおり（後始末まで進んでいない）
  assert.equal(s.ccChannels.get("chan-1")?.state, "open");
  assertQuietLogs(s);
});

test("commit の途中の例外（finish が false）: 巻き戻って sessions の行は残らず、行き先は消える", async (t) => {
  const s = setup(t);
  const store = Object.create(s.takeovers) as typeof s.takeovers;
  store.finish = () => false;
  const { id, result } = await s.proposeAndConfirm(s.make({ takeovers: store }));
  assert.equal(!result.ok && result.reason, "copy_failed");
  assert.equal(s.db.isTransaction, false);
  assert.equal(s.sdkSessions.get(DEST), undefined);
  assertDropped(s, id);
});

test("failed() の中の fail が投げても confirm は reject せず、確認の文の書き換えを試みる", async (t) => {
  const s = setup(t);
  s.env.channel = "throws";
  const store = Object.create(s.takeovers) as typeof s.takeovers;
  store.fail = () => {
    throw new Error("/secret/path");
  };
  const takeover = s.make({ takeovers: store });
  const { id, result } = await s.proposeAndConfirm(takeover);
  assert.deepEqual(result, { ok: false, reason: "no_channel", text: takeoverFailureText("no_channel", false), plainText: takeoverFailureText("no_channel", false), edited: true });
  assert.deepEqual(s.gateway.edits, [{ channelId: "confirm-1", messageId: "msg-confirm", message: { text: takeoverFailureText("no_channel", false), components: [] } }]);
  // running のまま残り、次の recover が restart にする
  assert.equal(s.takeovers.get(id)?.state, "running");
  await s.make().recover();
  assert.equal(s.takeovers.get(id)?.failure, "restart");
  assertQuietLogs(s);
});

test("終わったセッションの取り込み: 写す直前に一覧へ戻っていたら changed（kill は無い）。作ったチャンネルは消す", async (t) => {
  const s = setup(t, { ended: true });
  const takeover = s.make({
    createChannel: async (guildId, title, projectDir) => {
      const created = await s.deps.createChannel(guildId, title, projectDir);
      s.list.sessions = [s.view];
      return created;
    },
  });
  const { id, result } = await s.proposeAndConfirm(takeover);
  assert.equal(!result.ok && result.reason, "changed");
  assert.deepEqual(s.kills, []);
  assertDropped(s, id);
  assertUntouched(s, "ended");
});

test("写し先の用意（prepareTarget）はチャンネルの作成より前", async (t) => {
  const s = setup(t, { ended: true });
  const order: string[] = [];
  const takeover = s.make({
    files: {
      prepareTarget: (dir, root, srcDir) => {
        order.push("prepare");
        return prepareTarget(dir, root, srcDir);
      },
    },
    createChannel: async (guildId, title, projectDir) => {
      order.push("channel");
      return s.deps.createChannel(guildId, title, projectDir);
    },
  });
  const { result } = await s.proposeAndConfirm(takeover);
  assert.equal(result.ok, true);
  assert.deepEqual(order, ["prepare", "channel"]);
});

test("写し先が使えない（target_invalid）: チャンネルを作らない", async (t) => {
  const s = setup(t);
  const { id, result } = await s.proposeAndConfirm(s.make({ files: { prepareTarget: () => "invalid" } }));
  assert.equal(!result.ok && result.reason, "target_invalid");
  assert.deepEqual(s.kills, []);
  assertNoChannel(s, id);
});

test("kill が ESRCH（直前に自分で終わった）なら changed、ほかの例外は identity。どちらも作ったチャンネルは消す", async (t) => {
  for (const [code, expected] of [
    ["ESRCH", "changed"],
    ["EPERM", "identity"],
  ] as const) {
    await t.test(code, async (t2) => {
      const s = setup(t2);
      const takeover = s.make({
        kill: () => {
          throw Object.assign(new Error("kill"), { code });
        },
      });
      const { id, result } = await s.proposeAndConfirm(takeover);
      assert.deepEqual(result, { ok: false, reason: expected, text: takeoverFailureText(expected, false), plainText: takeoverFailureText(expected, false), edited: true });
      assertDropped(s, id);
      assertUntouched(s);
    });
  }
});

test("SIGTERM より前の例外は internal（端末はそのまま）", async (t) => {
  const s = setup(t);
  const takeover = s.make({
    files: {
      inspectSource: () => {
        throw new Error("/secret/path");
      },
    },
  });
  const { id, result } = await s.proposeAndConfirm(takeover);
  assert.deepEqual(result, { ok: false, reason: "internal", text: takeoverFailureText("internal", false), plainText: takeoverFailureText("internal", false), edited: true });
  assert.equal(s.takeovers.get(id)?.failure, "internal");
  assert.deepEqual(s.kills, []);
  assertNoChannel(s, id);
  assertQuietLogs(s);
});

test("チャンネルを作った後の例外（SIGTERM より前）: internal で、作ったチャンネルは消す", async (t) => {
  const s = setup(t);
  const takeover = s.make({
    files: {
      readAppended: () => {
        throw new Error("/secret/path");
      },
    },
  });
  const { id, result } = await s.proposeAndConfirm(takeover);
  assert.equal(!result.ok && result.reason, "internal");
  assert.deepEqual(s.kills, []);
  assertDropped(s, id);
});

test("deleteChannel が失敗: failed のまま行き先が残り（log にチャンネル ID）、recoverEffects がもう一度消す。2 回目の recoverEffects は何もしない", async (t) => {
  const s = setup(t);
  s.env.exits = false;
  let deleteFails = true;
  s.gateway.beforeDelete = () => {
    if (deleteFails) throw new Error("missing permissions");
  };
  const { id, result } = await s.proposeAndConfirm();
  assert.equal(!result.ok && result.reason, "not_exited");
  assert.equal(s.takeovers.get(id)?.state, "failed");
  assert.equal(s.takeovers.get(id)?.targetChannelId, DEST);
  assert.deepEqual(s.gateway.deleted, [DEST]);
  assert.equal(s.logs.filter((line) => line.includes(DEST)).length, 1);
  assertQuietLogs(s, /次の起動でもう一度/);

  // 次の起動でも消せなければ残る（log だけ）
  await s.make().recoverEffects();
  assert.deepEqual(s.gateway.deleted, [DEST, DEST]);
  assert.equal(s.takeovers.get(id)?.targetChannelId, DEST);

  deleteFails = false;
  await s.make().recoverEffects();
  assert.deepEqual(s.gateway.deleted, [DEST, DEST, DEST]);
  assert.equal(s.takeovers.get(id)?.targetChannelId, null);
  await s.make().recoverEffects();
  assert.equal(s.gateway.deleted.length, 3);
});

test("sessions に行のある行き先には deleteChannel を呼ばない（failed の行に行き先が残っていても）", async (t) => {
  const s = setup(t);
  const row = addRow(s, S1);
  s.takeovers.start(row.id);
  s.takeovers.setTarget(row.id, DEST);
  s.takeovers.fail(row.id, "copy_failed");
  s.topicSessions.create({ channelId: DEST, guildId: "guild-1", title: "別の話題", categoryId: "cat-active" });
  await s.takeover.recoverEffects();
  assert.deepEqual(s.gateway.deleted, []);
  assert.equal(s.takeovers.get(row.id)?.targetChannelId, DEST);
  assert.equal(s.topicSessions.get(DEST)?.title, "別の話題");
  assertQuietLogs(s);
});

test("recoverEffects: done で effects_at が空の行は後始末を 1 回（完了の文・cc の案内・確認の文）。2 回目は何もしない。行き先の話題が無い行は済みにするだけ", async (t) => {
  const s = setup(t);
  const done = addRow(s, S1);
  s.takeovers.start(done.id);
  s.takeovers.setTarget(done.id, DEST);
  s.takeovers.setConfirmMessage(done.id, "msg-a");
  s.takeovers.finish(done.id);
  s.topicSessions.create({ channelId: DEST, guildId: "guild-1", title: SECRET_NAME, categoryId: "cat-active", projectDir: "alpha", permissionMode: "default" });
  const gone = addRow(s, S2, "ended", "web");
  s.takeovers.start(gone.id);
  s.takeovers.setTarget(gone.id, "dest-2");
  s.takeovers.finish(gone.id);

  await s.takeover.recoverEffects();
  assert.deepEqual(
    s.gateway.posts.map((post) => [post.channelId, post.message.text]),
    [
      [DEST, takeoverDoneText("alpha", false)],
      ["chan-1", takeoverMovedText(DEST)],
    ],
  );
  assert.deepEqual(s.gateway.edits, [{ channelId: "confirm-1", messageId: "msg-a", message: { text: takeoverLinkText(DEST), components: [] } }]);
  assert.notEqual(s.takeovers.get(done.id)?.effectsAt, null);
  assert.notEqual(s.takeovers.get(gone.id)?.effectsAt, null);
  assert.deepEqual(s.history.list("dest-2", { limit: 10 }), []);
  await s.takeover.recoverEffects();
  assert.equal(s.gateway.posts.length, 2);
  assert.equal(s.gateway.edits.length, 1);
  assert.equal(s.channelOps.moves.length, 1);
  assertQuietLogs(s);
});

for (const state of ["open", "ended"] as const) {
  test(`cc のチャンネルが ${state} のセッション: 行が deleted、そのチャンネルに案内 1 通、完了への移動が 1 回積まれる`, async (t) => {
    const s = setup(t, { ccChannel: state, ended: state === "ended" });
    const { result } = await s.proposeAndConfirm();
    assert.equal(result.ok, true);
    assert.equal(s.ccChannels.get("chan-1")?.state, "deleted");
    assert.deepEqual(
      s.gateway.posts.filter((post) => post.channelId === "chan-1").map((post) => post.message.text),
      [takeoverMovedText(DEST)],
    );
    assert.deepEqual(s.channelOps.moves, [{ channelId: "chan-1", target: { kind: "state", guildId: "guild-1", state: "done" } }]);
  });
}

test("cc のチャンネルが resuming のセッション: 行は変わらず案内も無い。cc のチャンネルの無いセッションは何も出ない", async (t) => {
  for (const ccChannel of ["resuming", "none"] as const) {
    await t.test(ccChannel, async (t2) => {
      const s = setup(t2, { ccChannel, ended: true });
      const { result } = await s.proposeAndConfirm();
      assert.equal(result.ok, true);
      assert.equal(s.ccChannels.get("chan-1")?.state, ccChannel === "none" ? undefined : "resuming");
      assert.deepEqual(s.gateway.posts.map((post) => post.channelId), [DEST]);
      assert.deepEqual(s.channelOps.moves, []);
    });
  }
});

test("ccChannels・ccSends・ccPermissions・panes・probePane を渡さない: 生きている物は not_in_tmux、終わった物は取り込める", async (t) => {
  const bare = (s: Setup) =>
    s.make({ ccChannels: undefined, ccSends: undefined, ccPermissions: undefined, panes: undefined, probePane: undefined });
  const alive = setup(t);
  const refused = await bare(alive).propose({ sessionId: S1, entry: "web", guildId: "guild-1" });
  assert.equal(!refused.ok && refused.reason, "not_in_tmux");

  const ended = setup(t, { ended: true });
  const { result } = await ended.proposeAndConfirm(bare(ended));
  assert.equal(result.ok, true);
  assert.equal(ended.sdkSessions.get(DEST), S1);
  // cc のチャンネルには触らない
  assert.equal(ended.ccChannels.get("chan-1")?.state, "ended");
  assert.deepEqual(ended.channelOps.moves, []);
});

test("ペインを引く口が no_server なら not_in_tmux、ほかの失敗は tmux_failed", async (t) => {
  for (const [reason, expected] of [
    ["no_server", "not_in_tmux"],
    ["failed", "tmux_failed"],
    ["not_found", "tmux_failed"],
  ] as const) {
    const s = setup(t);
    const proposed = await s.make({ panes: { lookup: async () => ({ ok: false, reason }) } }).propose({ sessionId: S1, entry: "web", guildId: "guild-1" });
    assert.equal(!proposed.ok && proposed.reason, expected, reason);
  }
});

test("Web の入口（confirmChannelId 無し）: 確認の文の書き換えは無く、結果の channelId が行き先", async (t) => {
  const s = setup(t, { ended: true });
  const { id, result } = await s.proposeAndConfirm(s.takeover, "web");
  assert.deepEqual(result, { ok: true, channelId: DEST, text: takeoverLinkText(DEST), plainText: takeoverDoneText("alpha", false, false), edited: false });
  assert.equal(s.takeovers.get(id)?.confirmChannelId, null);
  assert.deepEqual(s.gateway.edits, []);
});

test("題名: 名前が空・制御文字だけならプロジェクトの名前。制御文字は空白にし、100 字で切る", async (t) => {
  for (const [name, expected] of [
    ["", "alpha"],
    ["\u0001\n\t", "alpha"],
    ["a\nb", "a b"],
    ["あ".repeat(120), "あ".repeat(100)],
  ] as const) {
    const s = setup(t, { ended: true });
    s.db.prepare("UPDATE cc_sessions SET name = ? WHERE session_id = ?").run(name, S1);
    const { result } = await s.proposeAndConfirm();
    assert.equal(result.ok, true);
    assert.equal(s.channelCalls[0]?.title, expected);
    assert.equal(s.topicSessions.get(DEST)?.title, expected);
  }
});

test("takeable(): 一覧を 1 回だけ読み、待機（最後の活動の新しい順）→ 終わった物（終わった時刻の新しい順）。at は待機なら最後の活動、終わった物なら終わった時刻。実行中・取り込み済み・確認待ちは入らない", async (t) => {
  const s = setup(t);
  const older = { ...s.view, sessionId: S2, lastActivityAt: BASE - 60_000 } as CcSessionView;
  const newer = { ...s.view, lastActivityAt: BASE } as CcSessionView;
  s.list.sessions = [older, newer];
  s.ccSessions.upsertSeen([
    { sessionId: S1, cwd: s.cwd, name: SECRET_NAME, pid: PID },
    { sessionId: S2, cwd: s.cwd, name: "two", pid: PID },
  ]);
  // 終わった物 2 つ（S3 が後に終わった）
  const E1 = "44444444-4444-4444-8444-444444444444";
  s.ccSessions.upsertSeen([{ sessionId: E1, cwd: s.cwd, name: "e1", pid: 7 }]);
  s.ccSessions.markGone([S1, S2, S3]);
  s.clock.now += 1000;
  s.ccSessions.upsertSeen([{ sessionId: S3, cwd: s.cwd, name: "three", pid: 8 }]);
  s.ccSessions.markGone([S1, S2]);
  const ticks = s.registry.ticks;
  const rows = await s.takeover.takeable();
  assert.equal(s.registry.ticks, ticks + 1);
  assert.deepEqual(
    rows.map((row) => [row.sessionId, row.title, row.project, row.alive, row.at]),
    [
      [S1, SECRET_NAME, "alpha", true, BASE],
      [S2, "two", "alpha", true, BASE - 60_000],
      [S3, "three", "alpha", false, BASE + 1000],
      [E1, "e1", "alpha", false, BASE],
    ],
  );
  // 時刻が読めなければ undefined（最後の活動が無い待機・終わった時刻が読めない物）
  s.list.sessions = [{ ...older, lastActivityAt: undefined } as CcSessionView, newer];
  s.db.prepare("UPDATE cc_sessions SET gone_at = ? WHERE session_id = ?").run("not-a-time", E1);
  const unknown = await s.takeover.takeable();
  assert.equal(unknown.find((row) => row.sessionId === S2)?.at, undefined);
  assert.equal(unknown.find((row) => row.sessionId === E1)?.at, undefined);
  assert.equal(unknown.find((row) => row.sessionId === S1)?.at, BASE);
  s.list.sessions = [older, newer];
  // 実行中・取り込み済み・確認待ちは外す
  s.list.sessions = [{ ...older, status: "busy", state: "running" } as CcSessionView, newer];
  s.sdkSessions.set("other-channel", S3);
  const proposed = await s.takeover.propose({ sessionId: E1, entry: "web", guildId: "guild-1" });
  assert.ok(proposed.ok);
  assert.deepEqual((await s.takeover.takeable()).map((row) => row.sessionId), [S1]);
  assertQuietLogs(s);
});

test("takeable(): ペインを撮る前に、撮らなくても断られるもの（実行中など）を外す。結果は変わらない", async (t) => {
  const s = setup(t);
  const busy = { ...s.view, sessionId: S2, status: "busy", state: "running" } as CcSessionView;
  s.list.sessions = [s.view, busy];
  s.ccSessions.upsertSeen([{ sessionId: S2, cwd: s.cwd, name: "two", pid: PID }]);
  let probes = 0;
  const takeover = s.make({
    probePane: async () => {
      probes++;
      return { ok: true, state: "idle" };
    },
  });
  assert.deepEqual((await takeover.takeable()).map((row) => row.sessionId), [S1]);
  assert.equal(probes, 1);
});

test("propose・takeable: 準備ができていなければ一覧を読まずに not_ready・空", async (t) => {
  const s = setup(t, { ended: true });
  const takeover = s.make({ ready: () => false });
  const ticks = s.registry.ticks;
  const proposed = await takeover.propose({ sessionId: S1, entry: "web", guildId: "guild-1" });
  assert.equal(!proposed.ok && proposed.reason, "not_ready");
  assert.deepEqual(await takeover.takeable(), []);
  assert.equal(s.registry.ticks, ticks);
});

test("見張り: 本体は cc/channels.ts・sender.ts・replies.ts・starter.ts・app/commands/cc-confirm.ts を import しない", () => {
  const source = readFileSync(new URL("../src/cc/takeover.ts", import.meta.url), "utf8");
  const specifiers = [...source.matchAll(/(?:\bfrom|\bimport)\s*\(?\s*["']([^"']+)["']/g)].map((match) => match[1]!);
  assert.ok(specifiers.includes("./takeover-rules.ts"));
  for (const forbidden of ["./channels.ts", "./sender.ts", "./replies.ts", "./starter.ts", "../app/commands/cc-confirm.ts"]) {
    assert.ok(!specifiers.includes(forbidden), forbidden);
  }
  assert.ok(!specifiers.some((specifier) => specifier.endsWith("/cc-confirm.ts")));
});

test("見張り: main.ts は turn に takeover を入れ、createHandler には turn を広げて渡す（別々に書くと前置きが黙って付かない）", () => {
  const source = readFileSync(new URL("../src/main.ts", import.meta.url), "utf8");
  assert.match(source, /const turn = \{[\s\S]*?takeover: turnTakeover[\s\S]*?\n\};/);
  // createHandler({ … }) の呼び出しを閉じる所まで（後ろの別の呼び出しに跨がない）
  const call = source.match(/createHandler\(\{[\s\S]*?\n\}\);/)?.[0];
  assert.ok(call !== undefined);
  assert.match(call, /\n {2}\.\.\.turn,\n/);
  assert.doesNotMatch(call, /takeover:/);
});

test("見張り: main.ts は取り込みの sleep に timers/promises を使わない（reject しない・unref の takeoverSleep）", () => {
  const source = readFileSync(new URL("../src/main.ts", import.meta.url), "utf8");
  const start = source.indexOf("const takeoverSleep");
  const end = source.indexOf("const takeover = new CcTakeover(", start);
  assert.ok(start >= 0 && end > start);
  // 定義の中に unref が在り、timers/promises の名前を使わない
  const definition = source.slice(start, end);
  assert.match(definition, /setTimeout\(resolve, ms\)\.unref\(\)/);
  const sleepLine = source.match(/\n\s*sleep: [^\n]*/g)?.find((line) => line.includes("takeoverSleep"));
  assert.equal(sleepLine?.trim(), "sleep: takeoverSleep,");
  for (const text of [definition, sleepLine]) assert.doesNotMatch(text, /timers\/promises|setTimeoutPromise|scheduler\.wait|delay\(/);
});

test("見張り: main.ts は取り込みを送信の守り・起動時の片付け 2 段・失効・停止に繋ぐ（順も）", () => {
  const source = readFileSync(new URL("../src/main.ts", import.meta.url), "utf8");
  // 取り込みの途中のセッションには積まない・届けない
  const sender = source.match(/new CcSender\(\{[\s\S]*?\n {2}\}\);/)?.[0];
  assert.ok(sender !== undefined);
  assert.match(sender, /holds: \(sessionId\) => ccTakeover\?\.holds\(sessionId\)/);
  // 前段（DB だけ）は一覧の最初の読み取りより前、後段は gateway の start の後で一覧の周期の start より前
  const at = (needle: string): number => {
    const index = source.indexOf(needle);
    assert.ok(index >= 0, needle);
    return index;
  };
  assert.ok(at("takeover.recoverRunning();") < at("await ccRegistry?.tick();"));
  assert.ok(at("await gateway.start(") < at("await ccTakeover.recoverEffects();"));
  assert.ok(at("await ccTakeover.recoverEffects();") < at("ccRegistry?.start();"));
  assert.ok(at("ccTakeoverExpirer?.start();") > at("await gateway.start("));
  // 停止は失効と取り込みの途中の 1 件を待つ
  const shutdown = source.match(/createShutdown\(\n {2}\{[\s\S]*?\n {2}\},\n/)?.[0];
  assert.ok(shutdown !== undefined);
  assert.match(shutdown, /\.\.\.\(ccTakeoverExpirer === undefined \? \{\} : \{ ccTakeoverExpirer \}\),/);
  assert.match(shutdown, /\.\.\.\(ccTakeover === undefined \? \{\} : \{ ccTakeover \}\),/);
});

/** 入口（/cc take・cc:takepick・cc:take:go|no）を本物の CcTakeover の前に置く。確認は confirm-1 で打つ */
function entrance(s: Setup) {
  const runtime: CcTakeRuntime = {
    // make() で差し替えた後もその本体を使う
    get takeover() {
      return s.takeover;
    },
    takeovers: s.takeovers,
    gateway: s.gateway,
    ready: () => true,
    counts: () => ({
      running: s.list.sessions.filter((view) => view.state === "running").length,
      waiting: s.list.sessions.filter((view) => view.state === "needs_input").length,
    }),
    rcUrl: () => undefined,
    timeZone: "Asia/Tokyo",
  };
  const log = s.deps.log;
  const command = createCcCommand({ ccChannels: () => undefined, guildSettings: { ccCategoryId: () => null }, ccTakeover: () => runtime, log });
  const component = createCcComponent({ ccTakeover: () => runtime, gateway: s.gateway, log });
  const base = { guildId: "guild-1", channelId: "confirm-1", userId: "owner-1", createdAt: new Date(BASE) };
  /** /cc take を打ってセレクトの値を返す */
  const take = async (): Promise<string[]> => {
    const responder = new FakeResponder();
    await command.handle({ ...base, kind: "command", name: "cc", subcommand: "take", options: {} }, responder);
    const row = responder.replies[0]?.components?.[0];
    return row?.kind === "select" ? row.select.options.map((option) => option.value) : [];
  };
  /** セレクトで選ぶ（本人への応答を返す） */
  const pick = async (sessionId: string): Promise<FakeResponder> => {
    const responder = new FakeResponder();
    await component.handle({ ...base, kind: "select", customId: "cc:takepick", values: [sessionId] }, responder);
    return responder;
  };
  /** 確認のボタンを押す */
  const press = async (customId: string): Promise<FakeResponder> => {
    const responder = new FakeResponder();
    await component.handle({ ...base, kind: "button", customId } as Extract<Interaction, { kind: "button" }>, responder);
    return responder;
  };
  /** 出した確認の文のボタン（[取り込む]・[やめる]） */
  const buttons = (): string[] => {
    const post = s.gateway.posts.find((candidate) => candidate.channelId === "confirm-1");
    const row = post?.message.components?.[0];
    return row?.kind === "buttons" ? row.buttons.map((button) => button.customId) : [];
  };
  return { take, pick, press, buttons };
}

test("/cc take → 選ぶ → ［取り込む］（H2 の受け入れ）: 新しいチャンネルができ、sessions に project_dir と元の session_id が入り、確認の文が『取り込みました → <#…>』になる", async (t) => {
  const s = setup(t);
  const e = entrance(s);
  assert.deepEqual(await e.take(), [S1]);
  const picked = await e.pick(S1);
  assert.deepEqual(picked.replies, [{ text: CC_TAKE_POSTED_REPLY, ephemeral: true }]);
  // 確認は打ったチャンネルに出し、まだ行き先は作らない
  assert.deepEqual(s.gateway.posts.map((post) => [post.channelId, post.messageId]), [["confirm-1", "msg-1"]]);
  assert.equal(s.gateway.posts[0]!.message.text, takeoverConfirmText({ title: SECRET_NAME, project: "alpha", source: "alive", terminalMode: "plan" }));
  assert.deepEqual(s.channelCalls, []);
  const [go] = e.buttons();
  assert.match(go ?? "", /^cc:take:go:\d+$/);
  const pressed = await e.press(go!);
  assert.deepEqual(pressed.calls, [{ method: "deferUpdate" }]);
  assert.deepEqual(s.kills, [{ pid: PID, signal: "SIGTERM" }]);
  assert.deepEqual(s.topicSessions.projectDirOf(DEST), { projectDir: "alpha", permissionMode: "default" });
  assert.equal(s.sdkSessions.get(DEST), S1);
  assert.deepEqual(s.gateway.edits, [{ channelId: "confirm-1", messageId: "msg-1", message: { text: takeoverLinkText(DEST), components: [] } }]);
  assertQuietLogs(s);
});

test("候補を出した後に実行中・判断待ち・tmux の外・直下でない になったセッションを選ぶと、それぞれの文で断り、確認もチャンネルも kill も無い", async (t) => {
  for (const [code, change] of [
    ["busy", (s: Setup) => Object.assign(s.view, { status: "busy", state: "running" })],
    ["waiting", (s: Setup) => Object.assign(s.view, { state: "needs_input" })],
    ["not_in_tmux", (s: Setup) => s.make({ panes: undefined })],
    ["outside_workspace", (s: Setup) => Object.assign(s.view, { cwd: join(s.cwd, "sub") })],
  ] as const) {
    await t.test(code, async (t2) => {
      const s = setup(t2);
      const e = entrance(s);
      assert.deepEqual(await e.take(), [S1]);
      change(s);
      const picked = await e.pick(S1);
      assert.deepEqual(picked.replies, [{ text: takeoverFailureText(code, false), ephemeral: true, suppressEmbeds: true }]);
      assert.deepEqual(s.gateway.posts, []);
      assert.deepEqual(s.channelCalls, []);
      assert.deepEqual(s.kills, []);
      assertUntouched(s);
      // 断りの log は符号とサーバー ID だけ（符号の outside_workspace は「workspace」を含む）
      assertQuietLogs(s, /^Claude Code: 取り込みを断りました（outside_workspace、guild=guild-1）$/);
    });
  }
});

test("既に cc-… のチャンネルが在るセッションを入口から取り込む: 案内が 1 通で、cc_channels の行は deleted、完了へ移す", async (t) => {
  const s = setup(t);
  const e = entrance(s);
  await e.take();
  await e.pick(S1);
  await e.press(e.buttons()[0]!);
  assert.equal(s.ccChannels.get("chan-1")?.state, "deleted");
  assert.deepEqual(
    s.gateway.posts.filter((post) => post.channelId === "chan-1").map((post) => post.message.text),
    [takeoverMovedText(DEST)],
  );
  assert.deepEqual(s.channelOps.moves, [{ channelId: "chan-1", target: { kind: "state", guildId: "guild-1", state: "done" } }]);
});

test("10 分後の ［取り込む］ は期限切れに書き換えて kill しない。失効の後・［やめる］ の後は本人にだけ断る", async (t) => {
  const s = setup(t);
  const e = entrance(s);
  await e.take();
  await e.pick(S1);
  const [go] = e.buttons();
  s.clock.now += TAKEOVER_CONFIRM_TTL_MS;
  const late = await e.press(go!);
  assert.deepEqual(late.calls, [{ method: "deferUpdate" }]);
  assert.deepEqual(s.gateway.edits, [{ channelId: "confirm-1", messageId: "msg-1", message: { text: TAKEOVER_EXPIRED_TEXT, components: [] } }]);
  assert.deepEqual(s.kills, []);
  assert.deepEqual(s.channelCalls, []);
  const again = await e.press(go!);
  assert.deepEqual(again.calls, [{ method: "reply", message: { text: CC_TAKE_STALE_REPLY, ephemeral: true } }]);

  // 失効（1 分ごとの expire）の後
  s.gateway.posts.length = 0;
  await e.pick(S1);
  const [go2] = e.buttons();
  s.clock.now += TAKEOVER_CONFIRM_TTL_MS;
  assert.equal(await s.takeover.expire(), 1);
  const expired = await e.press(go2!);
  assert.deepEqual(expired.calls, [{ method: "reply", message: { text: CC_TAKE_STALE_REPLY, ephemeral: true } }]);

  // [やめる] の後
  s.gateway.posts.length = 0;
  await e.pick(S1);
  const [go3, no3] = e.buttons();
  const cancelled = await e.press(no3!);
  assert.deepEqual(cancelled.calls, [{ method: "update", message: { text: "取り込みをやめました。", components: [] } }]);
  const afterCancel = await e.press(go3!);
  assert.deepEqual(afterCancel.calls, [{ method: "reply", message: { text: CC_TAKE_STALE_REPLY, ephemeral: true } }]);
  assert.deepEqual(s.kills, []);
  assert.deepEqual(s.channelCalls, []);
  assertQuietLogs(s);
});

test("［取り込む］ の同時の二度押し: kill は 1 回、2 つ目は本人にだけ『この確認はもう使えません。』", async (t) => {
  const s = setup(t);
  const e = entrance(s);
  await e.take();
  await e.pick(S1);
  const [go] = e.buttons();
  const [first, second] = await Promise.all([e.press(go!), e.press(go!)]);
  assert.deepEqual(s.kills, [{ pid: PID, signal: "SIGTERM" }]);
  const staleReply = { method: "reply", message: { text: CC_TAKE_STALE_REPLY, ephemeral: true } };
  const results = [first!.calls, second!.calls];
  assert.equal(results.filter((calls) => calls.some((call) => JSON.stringify(call) === JSON.stringify(staleReply))).length, 1);
  assert.ok(results.some((calls) => JSON.stringify(calls) === JSON.stringify([{ method: "deferUpdate" }])));
  assert.equal(s.sdkSessions.get(DEST), S1);
});

test("見張り: commands/cc-take.ts は cc/channels.ts・sender.ts・replies.ts・starter.ts・commands/cc-confirm.ts・commands/cc.ts を import しない", () => {
  const source = readFileSync(new URL("../src/app/commands/cc-take.ts", import.meta.url), "utf8");
  const specifiers = [...source.matchAll(/(?:\bfrom|\bimport)\s*\(?\s*["']([^"']+)["']/g)].map((match) => match[1]!);
  assert.ok(specifiers.includes("../../cc/takeover.ts"));
  for (const forbidden of ["channels.ts", "sender.ts", "replies.ts", "starter.ts", "cc-confirm.ts", "cc.ts"]) {
    assert.ok(!specifiers.some((specifier) => specifier.endsWith(`/${forbidden}`)), forbidden);
  }
});

test("見張り: main.ts は /cc take の deps に入口を遅く読む getter（ccTakeEntry）で渡し、本体を作った直後に入口を作る", () => {
  const source = readFileSync(new URL("../src/main.ts", import.meta.url), "utf8");
  const commands = source.match(/createCommands\(\{[\s\S]*?\n\}\);/)?.[0];
  assert.ok(commands !== undefined);
  assert.match(commands, /\.\.\.\(config\.cc \? \{ ccChannels: \(\) => ccChannels, ccTakeover: \(\) => ccTakeEntry \} : \{\}\),/);
  const components = source.match(/createComponents\(\{[\s\S]*?\n {2}\}\)/)?.[0];
  assert.ok(components !== undefined);
  assert.match(components, /\n {4}ccTakeover: \(\) => ccTakeEntry,\n/);
  // 入口は本体と同じ物を使い、本体を作った直後に作る
  const made = source.indexOf("ccTakeover = takeover;");
  const entry = source.indexOf("ccTakeEntry = {", made);
  assert.ok(made >= 0 && entry > made);
  assert.match(source.slice(entry, source.indexOf("\n  };", entry)), /\n {4}takeover,\n {4}takeovers: ccTakeovers,\n/);
});

test("check: 待機のセッションは takeable で state は idle、行を作らず log も出さない", async (t) => {
  const s = setup(t);
  s.view.lastActivityAt = BASE - 5_000;
  const ticks = s.registry.ticks;
  const checked = await s.takeover.check(S1);
  assert.deepEqual(checked, {
    takeable: true,
    reason: undefined,
    state: "idle",
    title: SECRET_NAME,
    project: "alpha",
    at: BASE - 5_000,
    bridgeSessionId: undefined,
    last: undefined,
  });
  // 一覧は読む（propose と同じ判定）。行は作らず、log も出さない
  assert.equal(s.registry.ticks, ticks + 1);
  assert.equal(s.takeovers.lastFor(S1), undefined);
  assert.deepEqual(s.logs, []);
  assert.deepEqual(s.kills, []);
  assert.deepEqual(s.channelCalls, []);
});

test("check: 実行中は busy で state は running、判断待ちは waiting で state は waiting", async (t) => {
  for (const [state, status, reason, expected] of [
    ["running", "busy", "busy", "running"],
    ["needs_input", "waiting", "waiting", "waiting"],
  ] as const) {
    const s = setup(t);
    s.view.state = state;
    s.view.status = status;
    s.view.bridgeSessionId = "bridge-1";
    const checked = await s.takeover.check(S1);
    assert.equal(checked.takeable, false, state);
    assert.equal(checked.reason, reason, state);
    assert.equal(checked.state, expected, state);
    // 判定が通らなければ場所は出さず、題の空の代わりは「Claude Code」
    assert.equal(checked.project, undefined, state);
    assert.equal(checked.title, SECRET_NAME, state);
    assert.equal(checked.bridgeSessionId, "bridge-1", state);
    assert.deepEqual(s.logs, [], state);
  }
});

test("check: 一覧に無く cc_sessions が gone なら state は ended で takeable、at は終わった時刻", async (t) => {
  const s = setup(t, { ended: true });
  const checked = await s.takeover.check(S1);
  assert.equal(checked.takeable, true);
  assert.equal(checked.state, "ended");
  assert.equal(checked.project, "alpha");
  assert.equal(checked.at, Date.parse(s.ccSessions.get(S1)!.goneAt!));
  assert.equal(checked.at, BASE);
  assert.equal(checked.bridgeSessionId, undefined);
});

test("check: 一覧にも cc_sessions にも無い session_id は identity で state は unknown", async (t) => {
  const s = setup(t);
  const checked = await s.takeover.check(S2);
  assert.deepEqual(checked, {
    takeable: false,
    reason: "identity",
    state: "unknown",
    title: "Claude Code",
    project: undefined,
    at: undefined,
    bridgeSessionId: undefined,
    last: undefined,
  });
  assert.deepEqual(s.logs, []);
});

test("check: Discord の確認待ち・実行中の取り込みがあれば in_progress", async (t) => {
  const s = setup(t);
  const discord = await s.takeover.propose({ sessionId: S1, entry: "discord", guildId: "guild-1", confirmChannelId: "confirm-1" });
  assert.ok(discord.ok);
  const awaiting = await s.takeover.check(S1);
  assert.equal(awaiting.takeable, false);
  assert.equal(awaiting.reason, "in_progress");
  assert.equal(awaiting.state, "idle");
  assert.equal(s.takeovers.get(discord.id)?.state, "awaiting_confirm");
  s.takeover.cancel(discord.id);
  // Web の行でも実行中なら in_progress
  const web = await s.takeover.propose({ sessionId: S1, entry: "web", guildId: "guild-1" });
  assert.ok(web.ok);
  assert.ok(s.takeovers.start(web.id));
  const running = await s.takeover.check(S1);
  assert.equal(running.reason, "in_progress");
  assert.equal(s.takeovers.get(web.id)?.state, "running");
});

test("check: Web の確認待ちだけなら takeable のまま（その行は取り消さない）", async (t) => {
  const s = setup(t);
  const web = await s.takeover.propose({ sessionId: S1, entry: "web", guildId: "guild-1" });
  assert.ok(web.ok);
  const logs = s.logs.length;
  const checked = await s.takeover.check(S1);
  assert.equal(checked.takeable, true);
  assert.equal(checked.reason, undefined);
  assert.equal(checked.project, "alpha");
  assert.deepEqual(checked.last, { id: web.id, state: "awaiting_confirm", targetChannelId: null });
  assert.equal(s.takeovers.get(web.id)?.state, "awaiting_confirm");
  assert.equal(s.logs.length, logs);
});

test("check: 断りの符号は propose と同じ（not_ready・outside_workspace・not_in_tmux・pane・queued・already_taken）", async (t) => {
  const cases: Array<[string, (s: Setup) => CcTakeover]> = [
    ["not_ready", (s) => s.make({ ready: () => false })],
    ["outside_workspace", (s) => s.make({ verifiedProjectDir: (name) => join(s.workspace, "elsewhere", name) })],
    ["not_in_tmux", (s) => s.make({ panes: undefined })],
    [
      "pane",
      (s) => {
        s.env.probes = ["draft", "draft"];
        return s.takeover;
      },
    ],
    [
      "queued",
      (s) => {
        s.ccSends.add({ sessionId: S1, text: "x", origin: "web", state: "queued" });
        return s.takeover;
      },
    ],
    [
      "already_taken",
      (s) => {
        s.sdkSessions.set("other-channel", S1);
        return s.takeover;
      },
    ],
  ];
  const rows: Array<[string, string | undefined, string | false]> = [];
  for (const [code, prepare] of cases) {
    const s = setup(t);
    const takeover = prepare(s);
    const checked = await takeover.check(S1);
    const proposed = await takeover.propose({ sessionId: S1, entry: "web", guildId: "guild-1" });
    rows.push([code, checked.reason, !proposed.ok && proposed.reason]);
  }
  assert.deepEqual(
    rows,
    cases.map(([code]) => [code, code, code]),
  );
});

test("check: last は一番新しい行の番号・状態・行き先（無ければ undefined）", async (t) => {
  const s = setup(t, { ended: true });
  assert.equal((await s.takeover.check(S1)).last, undefined);
  const first = await s.takeover.propose({ sessionId: S1, entry: "web", guildId: "guild-1" });
  assert.ok(first.ok);
  s.takeover.cancel(first.id);
  assert.deepEqual((await s.takeover.check(S1)).last, { id: first.id, state: "cancelled", targetChannelId: null });
  const { id, result } = await s.proposeAndConfirm(s.takeover, "web");
  assert.equal(result.ok, true);
  assert.ok(id > first.id);
  const checked = await s.takeover.check(S1);
  assert.deepEqual(checked.last, { id, state: "done", targetChannelId: DEST });
  // 取り込み済みなので、もう取り込めない
  assert.equal(checked.reason, "already_taken");
});

const WEB_LOGIN = "owner@example.com";

/** 取り込みの 4 ルートだけを載せた Web サーバー（127.0.0.1 の空きポート） */
async function serveTakeover(t: TestContext, s: Setup): Promise<WebServer> {
  const guildSettings = new GuildSettingsStore(s.db, () => new Date(s.clock.now));
  guildSettings.setChannel("guild-1", "homeCategoryId", "home-1");
  const routes = ccTakeoverRoutes({
    takeover: () => s.takeover,
    takeovers: s.takeovers,
    cfg: { allowedGuildIds: ["guild-1"] },
    guildSettings,
  });
  const server = createWebServer({
    host: "127.0.0.1",
    port: 0,
    allowedLogin: WEB_LOGIN,
    staticDir: tempDir(t),
    templateSiteDir: tempDir(t),
    routes,
    stopping: () => false,
    now: () => new Date(s.clock.now),
    log: () => undefined,
  });
  await server.start();
  t.after(() => server.close());
  return server;
}

function callJson(server: WebServer, method: "GET" | "POST", path: string): Promise<{ status: number; json: Record<string, unknown> }> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = { "tailscale-user-login": WEB_LOGIN };
    if (method === "POST") Object.assign(headers, { "sec-fetch-site": "same-origin", "x-self-agent": "1", "content-type": "application/json" });
    const req = request({ host: "127.0.0.1", port: server.address()!.port, method, path, headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (chunk: Buffer) => chunks.push(chunk));
      res.on("end", () => resolve({ status: res.statusCode!, json: JSON.parse(Buffer.concat(chunks).toString("utf8")) }));
      res.on("error", reject);
    });
    req.on("error", reject);
    req.end(method === "POST" ? "{}" : undefined);
  });
}

test("Web の入口の端から端: GET → POST /takeover → POST /confirm で kill は 1 回、応答の id は新しいチャンネル", async (t) => {
  const s = setup(t);
  const server = await serveTakeover(t, s);
  const read = await callJson(server, "GET", `/api/cc/sessions/${S1}/takeover`);
  assert.equal(read.status, 200);
  assert.equal(read.json.takeable, true);
  assert.equal(read.json.state, "idle");
  assert.deepEqual(s.kills, []);
  const proposed = await callJson(server, "POST", `/api/cc/sessions/${S1}/takeover`);
  assert.equal(proposed.status, 201);
  const id = proposed.json.id as number;
  assert.equal(s.takeovers.get(id)?.entry, "web");
  assert.equal(s.takeovers.get(id)?.confirmChannelId, null);
  const confirmed = await callJson(server, "POST", `/api/cc/takeovers/${id}/confirm`);
  assert.equal(confirmed.status, 200);
  assert.deepEqual(confirmed.json, { ok: true, id: `ch:${DEST}`, text: takeoverDoneText("alpha", false, false) });
  assert.deepEqual(s.kills, [{ pid: PID, signal: "SIGTERM" }]);
  assert.equal(s.sdkSessions.get(DEST), S1);
  // 済んだ後の GET は last に行き先を出す
  const after = await callJson(server, "GET", `/api/cc/sessions/${S1}/takeover`);
  assert.deepEqual(after.json.last, { takeover: id, state: "done", id: `ch:${DEST}` });
  assertQuietLogs(s);
});

test("Web の入口: 同時の 2 つの /confirm は kill 1 回で、片方は 409 stale", async (t) => {
  const s = setup(t);
  const server = await serveTakeover(t, s);
  const proposed = await callJson(server, "POST", `/api/cc/sessions/${S1}/takeover`);
  const id = proposed.json.id as number;
  const both = await Promise.all([
    callJson(server, "POST", `/api/cc/takeovers/${id}/confirm`),
    callJson(server, "POST", `/api/cc/takeovers/${id}/confirm`),
  ]);
  assert.deepEqual(s.kills, [{ pid: PID, signal: "SIGTERM" }]);
  assert.deepEqual(both.map((response) => response.status).sort(), [200, 409]);
  const stale = both.find((response) => response.status === 409)!;
  assert.deepEqual(stale.json, { error: "stale", text: TAKEOVER_WEB_STALE_TEXT });
});

test("Web の入口: 記号入りの名前でも応答の文はエスケープ前", async (t) => {
  const s = setup(t, { project: "al_pha" });
  const name = "a*b_c~<@1>";
  s.ccSessions.upsertSeen([{ sessionId: S1, cwd: s.cwd, name, pid: PID }]);
  const server = await serveTakeover(t, s);
  const read = await callJson(server, "GET", `/api/cc/sessions/${S1}/takeover`);
  assert.equal(read.json.title, name);
  assert.equal(read.json.project, "al_pha");
  const proposed = await callJson(server, "POST", `/api/cc/sessions/${S1}/takeover`);
  assert.equal(proposed.status, 201);
  assert.equal(proposed.json.text, takeoverConfirmText({ title: name, project: "al_pha", source: "alive", terminalMode: "plan" }, false));
  assert.ok((proposed.json.text as string).includes(`「${name}」（al_pha）`));
  const confirmed = await callJson(server, "POST", `/api/cc/takeovers/${proposed.json.id as number}/confirm`);
  assert.equal(confirmed.status, 200);
  assert.equal(confirmed.json.text, takeoverDoneText("al_pha", false, false));
  assert.ok((confirmed.json.text as string).includes("（al_pha・"));
});
