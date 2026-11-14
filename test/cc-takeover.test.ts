// 取り込みの本体（src/cc/takeover.ts。docs/plan/takeover.md §6 の T2）。registry・ペイン・kill・/proc・sleep は偽物で、実際のプロセスには何も送らない。
// DB は一時 SQLite、記録は一時ディレクトリ（~/.claude と CLAUDE_CONFIG_DIR の代わり）
import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { appendFileSync, existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CC_TAKE_POSTED_REPLY, CC_TAKE_STALE_REPLY, createCcCommand, createCcComponent } from "../src/app/commands/cc.ts";
import { CC_CHANNEL_ENDED_TEXT, CcChannels, ccEndedHandler, ccReplayEnded } from "../src/cc/channels.ts";
import { projectDirName } from "../src/cc/claude-dirs.ts";
import type { PaneLookup } from "../src/cc/panes.ts";
import type { CcSessionView } from "../src/cc/registry.ts";
import {
  CcTakeover,
  type CcTakeoverDeps,
  CcTakeoverExpirer,
  TAKEOVER_EXPIRE_SWEEP_MS,
  TAKEOVER_CONFIRM_TTL_MS,
  TAKEOVER_DELETE_PROMPT_TEXT,
  TAKEOVER_DROPPED_TEXT,
  TAKEOVER_EXPIRED_TEXT,
  TAKEOVER_NOT_CHANNEL_TEXT,
  takeoverConfirmText,
  takeoverDoneText,
} from "../src/cc/takeover.ts";
import { copyTranscript, prepareTarget } from "../src/cc/takeover-files.ts";
import { TAKEOVER_AFTER_TERM_TEXT, TAKEOVER_CATEGORY_TIMEOUT_MS, TAKEOVER_MAYBE_TERM_TEXT, takeoverFailureText } from "../src/cc/takeover-rules.ts";
import type { PaneState } from "../src/tmux/pane-state.ts";
import { CcChannelStore } from "../src/store/cc-channels.ts";
import { CcPermissionStore } from "../src/store/cc-permissions.ts";
import { CcSendStore } from "../src/store/cc-sends.ts";
import { CcSessionStore, type CcSessionRow } from "../src/store/cc-sessions.ts";
import { CcTakeoverStore } from "../src/store/cc-takeovers.ts";
import { GuildSettingsStore } from "../src/store/guild-settings.ts";
import { HistoryStore } from "../src/store/history.ts";
import { SdkSessionStore } from "../src/store/sdk-sessions.ts";
import { TopicSessionStore } from "../src/store/topic-sessions.ts";
import type { Interaction } from "../src/discord/gateway.ts";
import { tempDb, tempDir } from "./helpers/db.ts";
import { FakeResponder } from "./helpers/responder.ts";
import { FakeGateway } from "./helpers/gateway.ts";
import { RecordingChannelOps, RecordingQueue } from "./helpers/recording.ts";

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

type Proc = { comm: string; state: string; ppid: number; startTime: number };

/** /proc/<pid>/stat の形（comm の後ろの 1・2・20 番目が state・ppid・starttime） */
function statLine(pid: number, proc: Proc): string {
  const rest = [proc.state, String(proc.ppid), ...Array.from({ length: 17 }, () => "0"), String(proc.startTime), "0", "0"];
  return `${pid} (${proc.comm}) ${rest.join(" ")}`;
}

type Options = {
  /** 終わったセッション（一覧に無く、cc_sessions は gone） */
  ended?: boolean;
  /** cc のチャンネルの状態（既定 open。ended のセッションは ended） */
  channelState?: "open" | "ended";
};

function setup(t: TestContext, options: Options = {}) {
  const db = tempDb(t);
  const root = realpathSync(tempDir(t));
  const home = join(root, "home");
  const configDir = join(root, "config");
  const workspace = join(root, "workspace");
  const cwd = join(workspace, "alpha");
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
  const guildSettings = new GuildSettingsStore(db, now);
  const history = new HistoryStore(db, now);
  guildSettings.setChannel("guild-1", "systemChannelId", "sys-1");
  guildSettings.setCcCategory("guild-1", "cat-cc");

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
  ccChannels.create({ channelId: "chan-1", guildId: "guild-1", sessionId: S1, name: `cc-${SECRET_NAME}`, cwd, origin: "web" });
  const channelState = options.channelState ?? (options.ended === true ? "ended" : "open");
  if (channelState === "ended") ccChannels.setState("chan-1", "ended", ["open"]);

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
    categoryFails: false,
    /** 進行中のカテゴリの解決が返らない（期限の sleep だけが終わる） */
    categoryHangs: false,
    /** ended の流し直しの先（channels・replier）がもうあるか */
    targetsReady: true,
  };
  const kills: Array<{ pid: number; signal: string }> = [];
  let exited = false;
  const gateway = new FakeGateway({
    allow: ["sendMessage", "editMessage", "channelExists", "countChannelsIn"],
    record: ["setChannelTopic"],
    messageIdPrefix: "msg-",
  });
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
  // 本物の CcChannels（ended の流し直しと、done の後の ended で何も出ないことを見る）
  const channels = new CcChannels({
    cfg: { allowedGuildIds: ["guild-1"], workspaceDir: workspace, ownerUserId: "owner-1" },
    store: ccChannels,
    sends: ccSends,
    sender: () => undefined,
    guildSettings,
    registry: { snapshot: () => ({ ...list }) },
    panes: { lookup: async () => lookup },
    gateway,
    queue,
    channelOps,
    home,
    now,
    log,
  });
  const calls = { channels: 0, replier: 0 };
  const endedTargets = {
    channels: () =>
      !env.targetsReady
        ? undefined
        : {
            ended: (session: Pick<CcSessionRow, "sessionId">) => {
              calls.channels++;
              return channels.ended(session);
            },
          },
    replier: () =>
      !env.targetsReady
        ? undefined
        : {
            ended: () => {
              calls.replier++;
              return false;
            },
          },
  };
  let takeover: CcTakeover;
  const endedHandler = ccEndedHandler({ ...endedTargets, takeover: () => takeover });
  const registry = {
    ticks: 0,
    async tick(): Promise<void> {
      this.ticks++;
      if (env.advance) list.fetchedAt = clock.now;
      // registry と同じく、消えたセッションは gone_at を書いてから ended を知らせる
      if (exited && list.sessions.length > 0) {
        list.sessions = [];
        ccSessions.markGone([]);
        endedHandler(ccSessions.get(S1)!);
      }
    },
    snapshot: () => ({ ...list }),
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
    guildSettings,
    ready: () => true,
    checkSessionProject: (name) => ({ ok: true, projectDir: name }),
    verifiedProjectDir: (name) => join(workspace, name),
    findStateCategory: async () => {
      if (env.categoryFails) throw new Error("作れない");
      if (env.categoryHangs) return new Promise<string>(() => {});
      return "cat-active";
    },
    queue,
    channelOps,
    gateway,
    history,
    kill: (pid, signal) => {
      kills.push({ pid, signal });
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
      // カテゴリの期限の待ちは、期限切れを試すときだけ終わる（ほかは解決の方が先）
      if (ms === TAKEOVER_CATEGORY_TIMEOUT_MS) return env.categoryHangs ? Promise.resolve() : new Promise<void>(() => {});
      clock.now += ms;
      env.onSleep(ms);
      return Promise.resolve();
    },
    now,
    ownPid: OWN_PID,
    replayEnded: ccReplayEnded(endedTargets),
    note: "（前置き）",
    log,
  };
  const make = (overrides: Partial<CcTakeoverDeps> = {}): CcTakeover => {
    takeover = new CcTakeover({ ...deps, ...overrides });
    return takeover;
  };
  takeover = make();
  /** 確認を作り、確認のメッセージを記録して [取り込む] を押す */
  const proposeAndConfirm = async (t2: CcTakeover = takeover) => {
    const proposed = await t2.propose({ channelId: "chan-1", entry: "discord" });
    assert.equal(proposed.ok, true, proposed.ok ? "" : proposed.reason);
    if (!proposed.ok) throw new Error("propose");
    takeovers.setConfirmMessage(proposed.id, "msg-confirm");
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
    kills,
    gateway,
    channelOps,
    queue,
    logs,
    calls,
    endedHandler,
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

/** log に session_id・pid・cwd・名前・チャンネル ID を出していない */
function assertQuietLogs(s: Setup): void {
  for (const line of s.logs) {
    assert.doesNotMatch(line, /1111|2222|3333|4242|4000|secret|alpha|chan-|workspace|home|\/tmp/, line);
  }
}

/** 取り込んでいない（cc の行はそのまま・sessions と channel_sessions の行は無い） */
function assertUntouched(s: Setup, state: "open" | "ended" = "open"): void {
  assert.equal(s.ccChannels.get("chan-1")?.state, state);
  assert.equal(s.topicSessions.get("chan-1"), undefined);
  assert.equal(s.sdkSessions.get("chan-1"), undefined);
  assert.equal(existsSync(s.dst), false);
}

test("待機のセッション: SIGTERM をその pid に 1 回だけ送り、記録を写して cc のチャンネルをプロジェクトのセッションに変える", async (t) => {
  const s = setup(t);
  const proposed = await s.takeover.propose({ channelId: "chan-1", entry: "discord" });
  assert.ok(proposed.ok);
  assert.equal(
    proposed.message.text,
    takeoverConfirmText({ title: SECRET_NAME, project: "alpha", source: "alive", terminalMode: "plan" }),
  );
  assert.match(proposed.message.text, /端末の Claude Code は終了し、続きはこのチャンネルで self-agent が引き継ぎます。許可のモードは default になります（端末: plan）/);
  assert.deepEqual(
    proposed.message.components?.[0]?.kind === "buttons" ? proposed.message.components[0].buttons.map((button) => button.customId) : [],
    [`cc:take:go:${proposed.id}`, `cc:take:no:${proposed.id}`],
  );
  s.takeovers.setConfirmMessage(proposed.id, "msg-confirm");
  const result = await s.takeover.confirm(proposed.id);
  assert.deepEqual(result, { ok: true, text: takeoverDoneText("alpha", false) });
  assert.deepEqual(s.kills, [{ pid: PID, signal: "SIGTERM" }]);
  const session = s.topicSessions.get("chan-1");
  assert.deepEqual(s.topicSessions.projectDirOf("chan-1"), { projectDir: "alpha", permissionMode: "default" });
  assert.equal(session?.state, "active");
  assert.equal(session?.title, SECRET_NAME);
  assert.equal(s.sdkSessions.get("chan-1"), S1);
  assert.equal(s.ccChannels.get("chan-1")?.state, "deleted");
  const row = s.takeovers.get(proposed.id);
  assert.equal(row?.state, "done");
  assert.equal(row?.notePending, true);
  assert.equal(row?.endedHeld, false);
  assert.notEqual(row?.effectsAt, null);
  assert.equal(readFileSync(s.dst, "utf8"), readFileSync(s.src, "utf8"));
  // 一覧から消えた ended は差し止めたまま捨てる（チャンネルにも追いかけにも流さない）
  assert.deepEqual(s.calls, { channels: 0, replier: 0 });
  // 後始末: 進行中へ・topic・確認の文を完了の文に・Web の会話の区切り
  assert.deepEqual(s.channelOps.moves, [{ channelId: "chan-1", target: { kind: "state", guildId: "guild-1", state: "active" } }]);
  assert.deepEqual(s.gateway.callsOf("setChannelTopic"), [{ method: "setChannelTopic", channelId: "chan-1", topic: `${SECRET_NAME}（alpha）` }]);
  assert.deepEqual(s.gateway.edits, [{ channelId: "chan-1", messageId: "msg-confirm", message: { text: takeoverDoneText("alpha", false), components: [] } }]);
  assert.deepEqual(
    s.history.list("chan-1", { limit: 10 }).map((row) => [row.kind, row.text]),
    [["divider", "端末の Claude Code から取り込みました（alpha）"]],
  );
  assertQuietLogs(s);
});

test("終わったセッション（gone）: kill なしで同じ結果。削除の確認を「取り込まれました」に書き換える", async (t) => {
  const s = setup(t, { ended: true });
  s.ccChannels.setDeletePrompt("chan-1", "msg-del");
  const proposed = await s.takeover.propose({ channelId: "chan-1", entry: "discord" });
  assert.ok(proposed.ok);
  assert.match(proposed.message.text, /端末の Claude Code はすでに終わっています。続きはこのチャンネルで/);
  const result = await s.takeover.confirm(proposed.id);
  assert.equal(result.ok, true);
  assert.deepEqual(s.kills, []);
  assert.deepEqual(s.topicSessions.projectDirOf("chan-1"), { projectDir: "alpha", permissionMode: "default" });
  assert.equal(s.sdkSessions.get("chan-1"), S1);
  assert.equal(s.ccChannels.get("chan-1")?.state, "deleted");
  assert.equal(s.takeovers.get(proposed.id)?.state, "done");
  assert.equal(s.takeovers.get(proposed.id)?.notePending, true);
  assert.equal(existsSync(s.dst), true);
  // 確認のメッセージが無いので完了の文は投稿する
  assert.ok(s.gateway.posts.some((post) => post.channelId === "chan-1" && post.message.text === takeoverDoneText("alpha", false)));
  assert.deepEqual(s.gateway.edits, [{ channelId: "sys-1", messageId: "msg-del", message: { text: TAKEOVER_DELETE_PROMPT_TEXT, components: [] } }]);
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
      const proposed = await s.takeover.propose({ channelId: "chan-1", entry: "discord" });
      assert.deepEqual(proposed, { ok: false, reason: "list_failed", text: takeoverFailureText("list_failed", false) });
      assert.deepEqual(s.kills, []);
      assertUntouched(s, ended ? "ended" : "open");
      assertQuietLogs(s);
    });
  }
}

test("確認の後に一覧が読めなくなった: [取り込む] は list_failed で、確認の文を書き換える", async (t) => {
  const s = setup(t);
  const proposed = await s.takeover.propose({ channelId: "chan-1", entry: "discord" });
  assert.ok(proposed.ok);
  s.takeovers.setConfirmMessage(proposed.id, "msg-confirm");
  s.list.stale = true;
  const result = await s.takeover.confirm(proposed.id);
  assert.deepEqual(result, { ok: false, reason: "list_failed", text: takeoverFailureText("list_failed", false) });
  assert.equal(s.takeovers.get(proposed.id)?.state, "failed");
  assert.equal(s.takeovers.get(proposed.id)?.failure, "list_failed");
  assert.deepEqual(s.gateway.edits, [{ channelId: "chan-1", messageId: "msg-confirm", message: { text: takeoverFailureText("list_failed", false), components: [] } }]);
  assert.deepEqual(s.kills, []);
  assertUntouched(s);
});

test("確かめ直しで busy: kill しない", async (t) => {
  const s = setup(t);
  // propose・check は idle、2 秒後の確かめ直しで一覧が busy
  s.env.onSleep = (ms) => {
    if (ms === 2000) s.list.sessions[0] = { ...s.view, status: "busy", state: "running" };
  };
  const { result } = await s.proposeAndConfirm();
  assert.equal(result.ok, false);
  assert.equal(!result.ok && result.reason, "busy");
  assert.deepEqual(s.kills, []);
  assertUntouched(s);
});

test("確かめ直しでペインが待機でない: pane で kill しない", async (t) => {
  const s = setup(t);
  // propose・check は idle、2 秒後の確かめ直しでペインが書きかけ
  s.env.probes = ["idle", "idle", "draft"];
  const { result } = await s.proposeAndConfirm();
  assert.equal(!result.ok && result.reason, "pane");
  assert.deepEqual(s.kills, []);
  assertUntouched(s);
});

test("確かめ直しで記録に user の行が増えた: changed で kill しない", async (t) => {
  const s = setup(t);
  s.env.onSleep = () => appendFileSync(s.src, `${JSON.stringify({ type: "user", text: "新しい指示" })}\n`);
  const { result } = await s.proposeAndConfirm();
  assert.equal(!result.ok && result.reason, "changed");
  assert.deepEqual(s.kills, []);
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
  test(`相手の確かめ（${name}）: identity で kill しない`, async (t) => {
    const s = setup(t);
    // 最初の確かめの後（2 秒おく間）に変わる
    s.env.onSleep = (ms) => {
      if (ms === 2000) breakIt(s);
    };
    const { id, result } = await s.proposeAndConfirm();
    assert.deepEqual(result, { ok: false, reason: "identity", text: takeoverFailureText("identity", false) });
    assert.equal(s.takeovers.get(id)?.failure, "identity");
    assert.deepEqual(s.kills, []);
    assertUntouched(s);
    assertQuietLogs(s);
  });
}

test("端末の cwd が runner の cwd と違う: outside_workspace で kill しない", async (t) => {
  const s = setup(t);
  const takeover = s.make({ verifiedProjectDir: (name) => join(s.workspace, "elsewhere", name) });
  const proposed = await takeover.propose({ channelId: "chan-1", entry: "discord" });
  assert.equal(!proposed.ok && proposed.reason, "outside_workspace");
  assert.deepEqual(s.kills, []);
  assertUntouched(s);
});

test("進行中のカテゴリを用意できない: no_category で kill しない（layoutQueueKey のキューの中で呼ぶ）", async (t) => {
  const s = setup(t);
  s.env.categoryFails = true;
  const { result } = await s.proposeAndConfirm();
  assert.deepEqual(result, { ok: false, reason: "no_category", text: takeoverFailureText("no_category", false) });
  assert.deepEqual(s.queue.keys.length, 1);
  assert.deepEqual(s.kills, []);
  // ended が来る前の失敗では流し直さない
  assert.deepEqual(s.calls, { channels: 0, replier: 0 });
  assertUntouched(s);
});

test("kill の後に pid が消えない: not_exited（後ろの文は足さない）で、ほかの行は変わらない", async (t) => {
  const s = setup(t);
  s.env.exits = false;
  const { id, result } = await s.proposeAndConfirm();
  assert.deepEqual(result, { ok: false, reason: "not_exited", text: takeoverFailureText("not_exited", true) });
  assert.doesNotMatch(!result.ok && "text" in result ? result.text : "", new RegExp(TAKEOVER_AFTER_TERM_TEXT));
  assert.deepEqual(s.kills, [{ pid: PID, signal: "SIGTERM" }]);
  assert.equal(s.takeovers.get(id)?.state, "failed");
  assert.equal(s.takeovers.get(id)?.endedHeld, false);
  assert.deepEqual(s.calls, { channels: 0, replier: 0 });
  assertUntouched(s);
});

test("running の間の ended は差し止め（ended_held = 1）、写しに失敗したら 2 つを 1 回ずつ流し直す", async (t) => {
  const s = setup(t);
  let heldAtCopy: boolean | undefined;
  let callsAtCopy: unknown;
  const takeover = s.make({
    files: {
      copyTranscript: () => {
        heldAtCopy = s.takeovers.runningFor(S1)?.endedHeld;
        callsAtCopy = { ...s.calls };
        throw new Error("写せない");
      },
    },
  });
  const { id, result } = await s.proposeAndConfirm(takeover);
  assert.equal(heldAtCopy, true);
  assert.deepEqual(callsAtCopy, { channels: 0, replier: 0 });
  assert.equal(!result.ok && result.reason, "copy_failed");
  // SIGTERM を送った後の失敗なので、終わった会話から取り込める旨を足す
  assert.deepEqual(result, { ok: false, reason: "copy_failed", text: takeoverFailureText("copy_failed", true) });
  assert.deepEqual(s.calls, { channels: 1, replier: 1 });
  assert.equal(s.takeovers.get(id)?.endedHeld, false);
  // 普通の ended のチャンネルになる
  assert.equal(s.ccChannels.get("chan-1")?.state, "ended");
  assert.ok(s.gateway.posts.some((post) => post.channelId === "chan-1" && post.message.text === CC_CHANNEL_ENDED_TEXT));
  assert.equal(s.topicSessions.get("chan-1"), undefined);
  assertQuietLogs(s);
});

test("done の後に遅れて来た ended では、取り込んだチャンネルに何も出ない", async (t) => {
  const s = setup(t);
  const { result } = await s.proposeAndConfirm();
  assert.equal(result.ok, true);
  const posts = s.gateway.posts.length;
  s.endedHandler(s.ccSessions.get(S1)!);
  assert.equal(s.gateway.posts.length, posts);
  assert.equal(s.ccChannels.get("chan-1")?.state, "deleted");
  assert.equal(s.calls.channels, 1);
});

test("intercept: running の行が無ければ false（ended はそのまま流れる）", (t) => {
  const s = setup(t);
  assert.equal(s.takeover.intercept({ sessionId: S1 }), false);
  s.endedHandler(s.ccSessions.get(S1)!);
  assert.deepEqual(s.calls, { channels: 1, replier: 1 });
});

test("commit の直前に cc の行が resuming・別の session_id: channel_changed で sessions の行はできない", async (t) => {
  for (const change of ["resuming", "rebind"] as const) {
    await t.test(change, async (t2) => {
      const s = setup(t2);
      const takeover = s.make({
        files: {
          copyTranscript: (input) => {
            if (change === "resuming") s.ccChannels.setState("chan-1", "resuming", ["open"]);
            else s.ccChannels.rebind("chan-1", S2);
            return copyTranscript(input);
          },
        },
      });
      const { id, result } = await s.proposeAndConfirm(takeover);
      assert.equal(!result.ok && result.reason, "channel_changed");
      assert.equal(s.takeovers.get(id)?.state, "failed");
      assert.equal(s.topicSessions.get("chan-1"), undefined);
      assert.equal(s.sdkSessions.get("chan-1"), undefined);
      assert.notEqual(s.ccChannels.get("chan-1")?.state, "deleted");
      // 差し止めた ended は流し直す
      assert.deepEqual(s.calls, { channels: 1, replier: 1 });
    });
  }
});

test("recover: running・ended_held = 1 は failed（restart）で 2 つを 1 回ずつ、ended_held = 0 は流さない、done の後始末は移動と topic を 1 回ずつ。2 回目は何もしない", async (t) => {
  const s = setup(t);
  const add = (sessionId: string, channelId: string) =>
    s.takeovers.propose({ sessionId, source: "alive", project: "alpha", guildId: "guild-1", channelId, entry: "discord", permissionMode: "default" })!;
  s.ccSessions.upsertSeen([
    { sessionId: S2, cwd: s.cwd, name: "two", pid: 2 },
    { sessionId: S3, cwd: s.cwd, name: "three", pid: 3 },
  ]);
  const held = add(S1, "chan-1");
  s.takeovers.start(held.id);
  s.takeovers.hold(held.id);
  const plain = add(S2, "chan-2");
  s.takeovers.start(plain.id);
  const done = add(S3, "chan-3");
  s.takeovers.start(done.id);
  s.takeovers.finish(done.id);
  await s.takeover.recover();
  assert.equal(s.takeovers.get(held.id)?.state, "failed");
  assert.equal(s.takeovers.get(held.id)?.failure, "restart");
  assert.equal(s.takeovers.get(held.id)?.endedHeld, false);
  assert.equal(s.takeovers.get(plain.id)?.failure, "restart");
  assert.deepEqual(s.calls, { channels: 1, replier: 1 });
  // chan-1 は流し直した ended で完了へ
  assert.deepEqual(s.channelOps.moves, [
    { channelId: "chan-1", target: { kind: "state", guildId: "guild-1", state: "done" } },
    { channelId: "chan-3", target: { kind: "state", guildId: "guild-1", state: "active" } },
  ]);
  assert.deepEqual(s.gateway.callsOf("setChannelTopic"), [{ method: "setChannelTopic", channelId: "chan-3", topic: "three（alpha）" }]);
  assert.notEqual(s.takeovers.get(done.id)?.effectsAt, null);
  await s.takeover.recover();
  assert.deepEqual(s.calls, { channels: 1, replier: 1 });
  assert.equal(s.channelOps.moves.length, 2);
  assert.equal(s.gateway.callsOf("setChannelTopic").length, 1);
  assertQuietLogs(s);
});

test("holds・holdsChannel は running の行だけを見る", async (t) => {
  const s = setup(t);
  const proposed = await s.takeover.propose({ channelId: "chan-1", entry: "discord" });
  assert.ok(proposed.ok);
  assert.equal(s.takeover.holds(S1), false);
  assert.equal(s.takeover.holdsChannel("chan-1"), false);
  s.takeovers.start(proposed.id);
  assert.equal(s.takeover.holds(S1), true);
  assert.equal(s.takeover.holdsChannel("chan-1"), true);
  assert.equal(s.takeover.holds(S2), false);
  s.takeovers.fail(proposed.id, "restart");
  assert.equal(s.takeover.holds(S1), false);
});

test("propose: cc のチャンネルでなければ not_channel、確認待ちがあれば in_progress、届け待ち・許可の保留・取り込み済みは断る", async (t) => {
  const s = setup(t);
  assert.deepEqual(await s.takeover.propose({ channelId: "other", entry: "discord" }), {
    ok: false,
    reason: "not_channel",
    text: TAKEOVER_NOT_CHANNEL_TEXT,
  });
  const first = await s.takeover.propose({ channelId: "chan-1", entry: "discord" });
  assert.ok(first.ok);
  assert.equal((await s.takeover.propose({ channelId: "chan-1", entry: "discord" })).ok === false, true);
  s.takeover.cancel(first.id);
  s.ccSends.add({ sessionId: S1, text: "x", origin: "web", state: "queued" });
  const queued = await s.takeover.propose({ channelId: "chan-1", entry: "discord" });
  assert.equal(!queued.ok && queued.reason, "queued");
  assertQuietLogs(s);
});

test("propose: 許可の保留があれば waiting、取り込み済み（channel_sessions にある）なら already_taken", async (t) => {
  const s = setup(t);
  const permission = s.ccPermissions.add({ sessionId: S1, requestHash: "h", toolName: "Bash", summary: "x", permissionMode: null, state: "pending" });
  const waiting = await s.takeover.propose({ channelId: "chan-1", entry: "discord" });
  assert.equal(!waiting.ok && waiting.reason, "waiting");
  s.ccPermissions.resolve(permission.id, "denied", "web");
  s.sdkSessions.set("other-channel", S1);
  const taken = await s.takeover.propose({ channelId: "chan-1", entry: "discord" });
  assert.equal(!taken.ok && taken.reason, "already_taken");
  assert.deepEqual(s.kills, []);
});

test("[取り込む] の前に届け待ちが積まれた: start の後に確かめて queued で kill しない", async (t) => {
  const s = setup(t);
  const proposed = await s.takeover.propose({ channelId: "chan-1", entry: "discord" });
  assert.ok(proposed.ok);
  s.ccSends.add({ sessionId: S1, text: "x", origin: "web", state: "queued" });
  const result = await s.takeover.confirm(proposed.id);
  assert.equal(!result.ok && result.reason, "queued");
  assert.deepEqual(s.kills, []);
});

test("confirm: 10 分を過ぎた確認は expired（取り消して書き換える）、cancel の後は stale。expire は期限切れを書き換える", async (t) => {
  const s = setup(t);
  const proposed = await s.takeover.propose({ channelId: "chan-1", entry: "discord" });
  assert.ok(proposed.ok);
  s.takeovers.setConfirmMessage(proposed.id, "msg-confirm");
  s.clock.now += TAKEOVER_CONFIRM_TTL_MS;
  assert.deepEqual(await s.takeover.confirm(proposed.id), { ok: false, reason: "expired" });
  assert.equal(s.takeovers.get(proposed.id)?.state, "cancelled");
  assert.deepEqual(s.gateway.edits.at(-1), { channelId: "chan-1", messageId: "msg-confirm", message: { text: TAKEOVER_EXPIRED_TEXT, components: [] } });
  assert.deepEqual(await s.takeover.confirm(proposed.id), { ok: false, reason: "stale" });
  assert.deepEqual(s.kills, []);

  const second = await s.takeover.propose({ channelId: "chan-1", entry: "discord" });
  assert.ok(second.ok);
  s.takeovers.setConfirmMessage(second.id, "msg-confirm-2");
  assert.equal(await s.takeover.expire(), 0);
  s.clock.now += TAKEOVER_CONFIRM_TTL_MS;
  assert.equal(await s.takeover.expire(), 1);
  assert.deepEqual(s.gateway.edits.at(-1), { channelId: "chan-1", messageId: "msg-confirm-2", message: { text: TAKEOVER_EXPIRED_TEXT, components: [] } });

  const third = await s.takeover.propose({ channelId: "chan-1", entry: "discord" });
  assert.ok(third.ok);
  assert.equal(s.takeover.cancel(third.id), true);
  assert.equal(s.takeover.cancel(third.id), false);
  assert.deepEqual(await s.takeover.confirm(third.id), { ok: false, reason: "stale" });
});

/** /cc take と [取り込む][やめる]（commands/cc.ts）を本物の CcTakeover につなぐ（T3b） */
function entry(s: Setup) {
  const getter = () => ({ takeover: s.takeover, takeovers: s.takeovers, gateway: s.gateway, ownerUserId: "owner-1" });
  const command = createCcCommand({ ccChannels: () => undefined, guildSettings: { ccCategoryId: () => "cat-cc" }, ccTakeover: getter, log: () => {} });
  const component = createCcComponent({ ccTakeover: getter, gateway: s.gateway, log: () => {} });
  const base = { guildId: "guild-1", channelId: "chan-1", userId: "owner-1", createdAt: new Date(BASE) };
  const take = async (): Promise<FakeResponder> => {
    const responder = new FakeResponder();
    await command.handle({ ...base, kind: "command", name: "cc", subcommand: "take", options: {} }, responder);
    return responder;
  };
  const press = async (action: "go" | "no", id: number): Promise<FakeResponder> => {
    const responder = new FakeResponder();
    const interaction: Interaction = { ...base, kind: "button", customId: `cc:take:${action}:${id}` };
    await component.handle(interaction, responder);
    return responder;
  };
  return { take, press };
}

test("/cc take → [取り込む]（T3b）: 確認の文をチャンネルに出して記録し、押すと取り込んで確認の文を完了の文に書き換える", async (t) => {
  const s = setup(t);
  const { take, press } = entry(s);
  const taken = await take();
  assert.deepEqual(taken.replies, [{ text: CC_TAKE_POSTED_REPLY, ephemeral: true }]);
  const posted = s.gateway.posts.at(-1)!;
  assert.equal(posted.channelId, "chan-1");
  const row = s.takeovers.activeFor(S1)!;
  assert.equal(row.confirmMessageId, posted.messageId);
  assert.equal(row.entry, "discord");
  const go = await press("go", row.id);
  assert.deepEqual(go.calls, [{ method: "deferUpdate" }]);
  assert.equal(s.takeovers.get(row.id)?.state, "done");
  assert.deepEqual(s.kills, [{ pid: PID, signal: "SIGTERM" }]);
  assert.deepEqual(s.gateway.edits.find((edit) => edit.messageId === posted.messageId)?.message, { text: takeoverDoneText("alpha", false), components: [] });
  // 押し直しは何も起こさない
  const again = await press("go", row.id);
  assert.deepEqual(again.replies, [{ text: CC_TAKE_STALE_REPLY, ephemeral: true }]);
  assert.equal(s.kills.length, 1);
  assertQuietLogs(s);
});

test("10 分後の [取り込む] は使えない（T3b）: 押せば期限切れに書き換えて kill しない。失効の後・[やめる] の後は本人にだけ断る", async (t) => {
  const s = setup(t);
  const { take, press } = entry(s);
  await take();
  const first = s.takeovers.activeFor(S1)!;
  s.clock.now += TAKEOVER_CONFIRM_TTL_MS;
  const late = await press("go", first.id);
  assert.deepEqual(late.calls, [{ method: "deferUpdate" }]);
  assert.equal(s.takeovers.get(first.id)?.state, "cancelled");
  assert.deepEqual(s.gateway.edits.at(-1), { channelId: "chan-1", messageId: first.confirmMessageId, message: { text: TAKEOVER_EXPIRED_TEXT, components: [] } });
  assert.deepEqual(s.kills, []);

  // 1 分ごとの失効で取り消された後の [取り込む]・[やめる]
  await take();
  const second = s.takeovers.activeFor(S1)!;
  s.clock.now += TAKEOVER_CONFIRM_TTL_MS;
  let scheduled: Array<{ fn: () => void; ms: number }> = [];
  const expirer = new CcTakeoverExpirer({
    takeover: s.takeover,
    log: () => {},
    timers: {
      after: (fn, ms) => {
        scheduled.push({ fn, ms });
        return () => {
          scheduled = scheduled.filter((entry) => entry.fn !== fn);
        };
      },
    },
  });
  expirer.start();
  await expirer.idle();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(s.takeovers.get(second.id)?.state, "cancelled");
  assert.deepEqual(scheduled.map((entry) => entry.ms), [TAKEOVER_EXPIRE_SWEEP_MS]);
  expirer.stop();
  assert.deepEqual(scheduled, []);
  for (const action of ["go", "no"] as const) {
    const responder = await press(action, second.id);
    assert.deepEqual(responder.calls, [{ method: "reply", message: { text: CC_TAKE_STALE_REPLY, ephemeral: true } }], action);
  }
  assert.deepEqual(s.kills, []);
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

test("noteFor・noteDone・resumeDropped（§3.6.1・§3.6.3）", async (t) => {
  const s = setup(t, { ended: true });
  assert.equal(s.takeover.noteFor("chan-1", S1, {}), undefined);
  const { result } = await s.proposeAndConfirm();
  assert.equal(result.ok, true);
  assert.equal(s.takeover.noteFor("chan-1", S1, {}), "（前置き）");
  // session_id が違う・/close の要約・予約では付けない
  assert.equal(s.takeover.noteFor("chan-1", S2, {}), undefined);
  assert.equal(s.takeover.noteFor("chan-1", S1, { purpose: "close" }), undefined);
  assert.equal(s.takeover.noteFor("chan-1", S1, { scheduled: true }), undefined);
  // 前置きが無い設定なら何も返さない
  assert.equal(s.make({ note: undefined }).noteFor("chan-1", S1, {}), undefined);
  s.make();
  s.takeover.noteDone("chan-1");
  assert.equal(s.takeover.noteFor("chan-1", S1, {}), undefined);

  // resumeDropped: 取り込んだ session_id のときだけ、1 回だけ知らせる
  const before = s.gateway.posts.length;
  s.takeover.resumeDropped("chan-1", S2);
  s.takeover.resumeDropped("chan-1", S1);
  s.takeover.resumeDropped("chan-1", S1);
  await new Promise((resolve) => setImmediate(resolve));
  const dropped = s.gateway.posts.slice(before);
  assert.deepEqual(dropped.map((post) => post.message.text), [TAKEOVER_DROPPED_TEXT]);
  assertQuietLogs(s);
});

test("確認の後にチャンネルが別のセッションに付け替わった: check で channel_changed、SIGTERM は送らない", async (t) => {
  const s = setup(t);
  const proposed = await s.takeover.propose({ channelId: "chan-1", entry: "discord" });
  assert.ok(proposed.ok);
  s.ccChannels.rebind("chan-1", S2);
  const result = await s.takeover.confirm(proposed.id);
  assert.equal(!result.ok && result.reason, "channel_changed");
  assert.equal(s.takeovers.get(proposed.id)?.step, "check");
  assert.deepEqual(s.kills, []);
  assert.equal(s.topicSessions.get("chan-1"), undefined);
  assertQuietLogs(s);
});

test("recover: restart にした行の確認の文を書き換える（check は 1 行、term・copy・commit は 2 行、確認の文が無ければ何もしない、失敗しても投げない）", async (t) => {
  const s = setup(t);
  const add = (sessionId: string, channelId: string, step: "check" | "term" | "copy" | "commit" | undefined, messageId?: string) => {
    const row = s.takeovers.propose({ sessionId, source: "alive", project: "alpha", guildId: "guild-1", channelId, entry: "discord", permissionMode: "default" })!;
    s.takeovers.start(row.id);
    if (step !== undefined) s.takeovers.setStep(row.id, step);
    if (messageId !== undefined) s.takeovers.setConfirmMessage(row.id, messageId);
    return row;
  };
  add(S1, "chan-1", "check", "msg-a");
  add(S2, "chan-2", "term", "msg-b");
  add(S3, "chan-3", "commit", undefined);
  await s.takeover.recover();
  await new Promise((resolve) => setImmediate(resolve));
  const restart = takeoverFailureText("restart", false);
  assert.deepEqual(s.gateway.edits, [
    { channelId: "chan-1", messageId: "msg-a", message: { text: restart, components: [] } },
    { channelId: "chan-2", messageId: "msg-b", message: { text: `${restart}\n${TAKEOVER_MAYBE_TERM_TEXT}`, components: [] } },
  ]);
  assert.doesNotMatch(s.gateway.edits[1]!.message.text, new RegExp(TAKEOVER_AFTER_TERM_TEXT));
  assertQuietLogs(s);
});

test("recover: 確認の文の書き換えに失敗しても投げず、log だけ", async (t) => {
  const s = setup(t);
  const row = s.takeovers.propose({ sessionId: S1, source: "alive", project: "alpha", guildId: "guild-1", channelId: "chan-1", entry: "discord", permissionMode: "default" })!;
  s.takeovers.start(row.id);
  s.takeovers.setStep(row.id, "copy");
  s.takeovers.setConfirmMessage(row.id, "msg-a");
  s.gateway.beforeEdit = () => {
    throw new Error("/secret/path/11111111");
  };
  await s.takeover.recover();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(s.takeovers.get(row.id)?.failure, "restart");
  assert.ok(s.logs.some((line) => line.includes("確認の文を書き換えられませんでした")));
  assertQuietLogs(s);
});

test("commit の途中の例外（sessions の INSERT が投げる）: 全部巻き戻り、差し止めた ended が 1 回だけ流れる", async (t) => {
  const s = setup(t);
  const takeover = s.make({
    topicSessions: {
      create: () => {
        throw new Error("/secret/path");
      },
    },
  });
  const { id, result } = await s.proposeAndConfirm(takeover);
  assert.deepEqual(result, { ok: false, reason: "copy_failed", text: takeoverFailureText("copy_failed", true) });
  assert.equal(s.kills.length, 1);
  assert.equal(s.takeovers.get(id)?.state, "failed");
  assert.equal(s.takeovers.get(id)?.notePending, false);
  assert.equal(s.sdkSessions.get("chan-1"), undefined);
  assert.equal(s.topicSessions.get("chan-1"), undefined);
  // markTaken も巻き戻り、流し直した ended で普通の ended のチャンネルになる
  assert.equal(s.ccChannels.get("chan-1")?.state, "ended");
  assert.deepEqual(s.calls, { channels: 1, replier: 1 });
  assert.equal(s.db.isTransaction, false);
  assertQuietLogs(s);
});

test("failed() の中の fail が投げても confirm は reject せず、確認の文の書き換えを試みる", async (t) => {
  const s = setup(t);
  s.env.categoryFails = true;
  const store = Object.create(s.takeovers) as typeof s.takeovers;
  store.fail = () => {
    throw new Error("/secret/path");
  };
  const takeover = s.make({ takeovers: store });
  const { id, result } = await s.proposeAndConfirm(takeover);
  assert.deepEqual(result, { ok: false, reason: "no_category", text: takeoverFailureText("no_category", false) });
  assert.deepEqual(s.gateway.edits, [{ channelId: "chan-1", messageId: "msg-confirm", message: { text: takeoverFailureText("no_category", false), components: [] } }]);
  // running のまま残り、次の recover が restart にする
  assert.equal(s.takeovers.get(id)?.state, "running");
  await s.make().recover();
  assert.equal(s.takeovers.get(id)?.failure, "restart");
  assertQuietLogs(s);
});

test("intercept: DB を読めなければ false（ended はそのまま流れる）で投げない", (t) => {
  const s = setup(t);
  const store = Object.create(s.takeovers) as typeof s.takeovers;
  store.runningFor = () => {
    throw new Error("/secret/path");
  };
  const takeover = s.make({ takeovers: store });
  assert.equal(takeover.intercept({ sessionId: S1 }), false);
  s.endedHandler(s.ccSessions.get(S1)!);
  assert.deepEqual(s.calls, { channels: 1, replier: 1 });
  assertQuietLogs(s);
});

test("SIGTERM より前（check の段）に端末が自分で終わった: ended は差し止めてから changed で 1 回だけ流し直す", async (t) => {
  const s = setup(t);
  s.env.onSleep = (ms) => {
    if (ms !== 2000) return;
    s.list.sessions = [];
    s.ccSessions.markGone([]);
    s.endedHandler(s.ccSessions.get(S1)!);
    assert.deepEqual(s.calls, { channels: 0, replier: 0 });
  };
  const { result } = await s.proposeAndConfirm();
  assert.equal(!result.ok && result.reason, "changed");
  assert.deepEqual(s.kills, []);
  assert.deepEqual(s.calls, { channels: 1, replier: 1 });
  assert.equal(s.ccChannels.get("chan-1")?.state, "ended");
});

test("流し直しの先がまだ無い: 印を残し、次の recover で 1 回だけ流す", async (t) => {
  const s = setup(t);
  s.env.targetsReady = false;
  const takeover = s.make({
    files: {
      copyTranscript: () => {
        throw new Error("写せない");
      },
    },
  });
  const { id, result } = await s.proposeAndConfirm(takeover);
  assert.equal(!result.ok && result.reason, "copy_failed");
  assert.equal(s.takeovers.get(id)?.endedHeld, true);
  assert.deepEqual(s.calls, { channels: 0, replier: 0 });
  // まだ届け先が無い recover でも印は残る
  await s.make().recover();
  assert.equal(s.takeovers.get(id)?.endedHeld, true);
  s.env.targetsReady = true;
  await s.make().recover();
  assert.deepEqual(s.calls, { channels: 1, replier: 1 });
  assert.equal(s.takeovers.get(id)?.endedHeld, false);
  await s.make().recover();
  assert.deepEqual(s.calls, { channels: 1, replier: 1 });
  assertQuietLogs(s);
});

test("ccReplayEnded: channels・replier のどちらかが無ければどちらも呼ばずに false", () => {
  const calls: string[] = [];
  const channels = () => ({ ended: () => (calls.push("channels"), true) });
  const replier = () => ({ ended: () => (calls.push("replier"), true) });
  const session = { sessionId: S1 } as CcSessionRow;
  assert.equal(ccReplayEnded({ channels, replier: () => undefined })(session), false);
  assert.equal(ccReplayEnded({ channels: () => undefined, replier })(session), false);
  assert.deepEqual(calls, []);
  assert.equal(ccReplayEnded({ channels, replier })(session), true);
  assert.deepEqual(calls, ["channels", "replier"]);
});

test("終わったセッションの取り込み: 写す直前に一覧へ戻っていたら changed（kill は無い）", async (t) => {
  const s = setup(t, { ended: true });
  const takeover = s.make({
    files: {
      prepareTarget: (dir, root, srcDir) => {
        s.list.sessions = [s.view];
        return prepareTarget(dir, root, srcDir);
      },
    },
  });
  const { result } = await s.proposeAndConfirm(takeover);
  assert.equal(!result.ok && result.reason, "changed");
  assert.deepEqual(s.kills, []);
  assertUntouched(s, "ended");
});

test("kill が ESRCH（直前に自分で終わった）なら changed、ほかの例外は identity", async (t) => {
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
      const { result } = await s.proposeAndConfirm(takeover);
      assert.deepEqual(result, { ok: false, reason: expected, text: takeoverFailureText(expected, false) });
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
  assert.deepEqual(result, { ok: false, reason: "internal", text: takeoverFailureText("internal", false) });
  assert.equal(s.takeovers.get(id)?.failure, "internal");
  assert.deepEqual(s.kills, []);
  assertQuietLogs(s);
});

test("進行中のカテゴリの解決が期限（15 秒）を過ぎた: no_category で kill しない", async (t) => {
  const s = setup(t);
  s.env.categoryHangs = true;
  const { result } = await s.proposeAndConfirm();
  assert.deepEqual(result, { ok: false, reason: "no_category", text: takeoverFailureText("no_category", false) });
  assert.deepEqual(s.kills, []);
  assertUntouched(s);
});

test("recover: 終わったセッション（source ended）の行には「終了しているかもしれません」を足さない", async (t) => {
  const s = setup(t);
  const row = s.takeovers.propose({ sessionId: S1, source: "ended", project: "alpha", guildId: "guild-1", channelId: "chan-1", entry: "discord", permissionMode: "default" })!;
  s.takeovers.start(row.id);
  s.takeovers.setStep(row.id, "copy");
  s.takeovers.setConfirmMessage(row.id, "msg-a");
  await s.takeover.recover();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(s.gateway.edits, [{ channelId: "chan-1", messageId: "msg-a", message: { text: takeoverFailureText("restart", false), components: [] } }]);
});
