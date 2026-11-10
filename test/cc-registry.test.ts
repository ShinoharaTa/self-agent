import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import type { AgentEntry, AgentsResult } from "../src/cc/agents.ts";
import type { SessionFileInfo } from "../src/cc/claude-dirs.ts";
import { parseHookEvent, type CcHookEvent } from "../src/cc/hook-server.ts";
import {
  CC_EVENT_REFRESH_MS,
  CC_IDLE_POLL_MS,
  CC_PENDING_MAX,
  CC_PENDING_MS,
  CC_STALE_LIMIT,
  CcRegistry,
  type CcTimers,
  lastActivity,
  rankSessions,
  type RankInput,
} from "../src/cc/registry.ts";
import { CcSessionStore } from "../src/store/cc-sessions.ts";
import { tempDb } from "./helpers/db.ts";

const BASE = Date.parse("2026-11-01T00:00:00.000Z");
const S1 = "11111111-1111-4111-8111-111111111111";
const S2 = "22222222-2222-4222-8222-222222222222";
const S3 = "33333333-3333-4333-8333-333333333333";
const S4 = "44444444-4444-4444-8444-444444444444";
const SECRET_NAME = "secret-project-name";
const SECRET_CWD = "/home/owner/workspace/secret-dir";

function agent(sessionId: string, overrides: Partial<AgentEntry> = {}): AgentEntry {
  return {
    pid: 100,
    sessionId,
    cwd: SECRET_CWD,
    name: SECRET_NAME,
    kind: "interactive",
    startedAt: BASE - 3_600_000,
    status: "idle",
    waitingFor: undefined,
    ...overrides,
  };
}

function setup(t: TestContext, pollSec = 10, busy?: () => boolean) {
  const db = tempDb(t);
  const clock = { now: BASE };
  const now = (): Date => new Date(clock.now);
  const store = new CcSessionStore(db, now);
  const results: AgentsResult[] = [];
  let lastResult: AgentsResult = { ok: true, agents: [], dropped: 0 };
  let listCalls = 0;
  /** 一覧の読み取りを止めておく（wait が終わるまで list が返らない） */
  const listGate: { wait: Promise<void> | undefined } = { wait: undefined };
  const agents = {
    list: async (): Promise<AgentsResult> => {
      listCalls++;
      if (listGate.wait !== undefined) await listGate.wait;
      lastResult = results.shift() ?? lastResult;
      return lastResult;
    },
  };
  const files = new Map<string, SessionFileInfo>();
  const mtimes = new Map<string, number>();
  const dirs = {
    sessionFile: (_pid: number, sessionId: string) => files.get(sessionId),
    transcriptMtime: (_cwd: string, sessionId: string) => mtimes.get(sessionId),
  };
  const delays: number[] = [];
  const scheduled: Array<() => void> = [];
  const timers: CcTimers = {
    after: (fn, ms) => {
      delays.push(ms);
      scheduled.push(fn);
      return () => {
        const index = scheduled.indexOf(fn);
        if (index !== -1) scheduled.splice(index, 1);
      };
    },
  };
  const logs: string[] = [];
  const registry = new CcRegistry({
    cfg: { ccPollSec: pollSec },
    agents,
    dirs,
    store,
    now,
    timers,
    ...(busy === undefined ? {} : { busy }),
    log: (line) => logs.push(line),
  });
  /** 次の一覧 */
  const willList = (...list: AgentEntry[]) => results.push({ ok: true, agents: list, dropped: 0 });
  const willFail = () => results.push({ ok: false, reason: "json" });
  /** 予約したタイマーを 1 つ動かし、読み取りが終わるのを待つ */
  const fire = async () => {
    const fn = scheduled.shift();
    assert.ok(fn, "予約したタイマーが無い");
    fn();
    await registry.idle();
    await new Promise((resolve) => setImmediate(resolve));
  };
  /** hook の本文から事象を作って渡す */
  const hook = (body: Record<string, unknown>) => {
    const event = parseHookEvent(body, new Date(clock.now));
    assert.ok(event);
    registry.receive(event);
    return event;
  };
  return { db, clock, store, registry, willList, willFail, fire, hook, files, mtimes, delays, scheduled, logs, listGate, calls: () => listCalls };
}

function states(registry: CcRegistry): Array<[string, string]> {
  return registry.snapshot().sessions.map((session) => [session.sessionId, session.state]);
}

test("CcRegistry: 読めなければ前回の一覧を stale で残し、CC_STALE_LIMIT 回続けば空にする。読めたら戻る", async (t) => {
  const s = setup(t);
  s.willList(agent(S1), agent(S2));
  await s.registry.tick();
  assert.equal(s.registry.snapshot().stale, false);
  for (let i = 1; i < CC_STALE_LIMIT; i++) {
    s.willFail();
    await s.registry.tick();
    const snapshot = s.registry.snapshot();
    assert.equal(snapshot.stale, true, `${i}`);
    assert.equal(snapshot.unreadable, false, `${i}`);
    assert.deepEqual(snapshot.sessions.map((session) => session.sessionId), [S1, S2].sort(), `${i}`);
  }
  s.willFail();
  await s.registry.tick();
  assert.deepEqual(s.registry.snapshot().sessions, []);
  assert.equal(s.registry.snapshot().unreadable, true);
  // 失敗の間は gone にしない
  assert.equal(s.store.get(S1)?.goneAt, null);
  s.willList(agent(S1));
  await s.registry.tick();
  const snapshot = s.registry.snapshot();
  assert.equal(snapshot.stale, false);
  assert.equal(snapshot.unreadable, false);
  assert.deepEqual(snapshot.sessions.map((session) => session.sessionId), [S1]);
  assert.notEqual(s.store.get(S2)?.goneAt, null);
});

test("CcRegistry: UserPromptSubmit で最後の指示が進み、本文は先頭 200 字", async (t) => {
  const s = setup(t);
  s.willList(agent(S1));
  await s.registry.tick();
  s.clock.now = BASE + 5000;
  s.hook({ hook_event_name: "UserPromptSubmit", session_id: S1, prompt: "x".repeat(300), permission_mode: "auto", cwd: SECRET_CWD });
  const view = s.registry.snapshot().sessions[0]!;
  assert.equal(view.lastPromptAt, BASE + 5000);
  assert.equal(view.lastPromptText, "x".repeat(200));
  assert.equal(view.permissionMode, "auto");
  assert.equal(s.store.get(S1)?.lastPromptText, "x".repeat(200));
  // 最後の活動（#288）: Stop で進み、その約 60 秒後の Notification（idle_prompt）では進まない（last_event も Stop のまま）
  s.clock.now = BASE + 8000;
  s.hook({ hook_event_name: "Stop", session_id: S1 });
  assert.equal(s.registry.snapshot().sessions[0]!.lastActivityAt, BASE + 8000);
  s.clock.now = BASE + 70_000;
  s.hook({ hook_event_name: "Notification", session_id: S1, notification_type: "idle_prompt" });
  assert.equal(s.store.get(S1)?.lastEvent, "Stop");
  assert.equal(s.registry.snapshot().sessions[0]!.lastActivityAt, BASE + 8000);
});

test("CcRegistry: 長い貼り付けの prompt は pasted_content のタグを外した中身の先頭 200 字", async (t) => {
  const s = setup(t);
  s.willList(agent(S1));
  await s.registry.tick();
  const pasted = `<pasted_content id="p1">${"y".repeat(250)}</pasted_content id="p1">`;
  s.hook({ hook_event_name: "UserPromptSubmit", session_id: S1, prompt: `見て: ${pasted}` });
  assert.equal(s.store.get(S1)?.lastPromptText, `見て: ${"y".repeat(196)}`);
  s.hook({ hook_event_name: "UserPromptSubmit", session_id: S1, prompt: '<pasted_content id="a" lines="3">1\n2\n3</pasted_content>' });
  assert.equal(s.store.get(S1)?.lastPromptText, "1\n2\n3");
});

test("CcRegistry: permission_mode の無い事象（Notification）は行の permission_mode を消さない", async (t) => {
  const s = setup(t);
  s.willList(agent(S1));
  await s.registry.tick();
  s.hook({ hook_event_name: "UserPromptSubmit", session_id: S1, prompt: "a", permission_mode: "auto" });
  s.hook({ hook_event_name: "Notification", session_id: S1, notification_type: "permission_prompt" });
  s.hook({ hook_event_name: "Notification", session_id: S1, notification_type: "idle_prompt" });
  assert.equal(s.store.get(S1)?.permissionMode, "auto");
  assert.equal(s.registry.snapshot().sessions[0]!.permissionMode, "auto");
  s.hook({ hook_event_name: "Stop", session_id: S1 });
  assert.equal(s.store.get(S1)?.permissionMode, "auto");
});

test("CcRegistry: permission_prompt で判断待ち、Stop で解消。idle_prompt は判断待ちにしない。その後の status が busy か 2 回続けて idle でも解消（#290）", async (t) => {
  const s = setup(t);
  s.willList(agent(S1));
  await s.registry.tick();
  s.hook({ hook_event_name: "Notification", session_id: S1, notification_type: "idle_prompt" });
  assert.deepEqual(states(s.registry), [[S1, "idle"]]);
  s.hook({ hook_event_name: "Notification", session_id: S1, notification_type: "permission_prompt" });
  assert.deepEqual(states(s.registry), [[S1, "needs_input"]]);
  // その後に読んだ status が busy なら解消（ダイアログに答えて Claude が働いている。#290）
  s.willList(agent(S1, { status: "busy" }));
  await s.registry.tick();
  assert.deepEqual(states(s.registry), [[S1, "running"]]);
  assert.equal(s.store.get(S1)?.waitingKind, null);
  s.willList(agent(S1, { status: "idle" }));
  await s.registry.tick();
  assert.deepEqual(states(s.registry), [[S1, "idle"]]);
  // Esc の中断では Stop が来ない: idle を 1 回読んだだけでは判断待ちのまま、2 回続けて idle で解消（#290）
  s.hook({ hook_event_name: "Notification", session_id: S1, notification_type: "permission_prompt" });
  assert.deepEqual(states(s.registry), [[S1, "needs_input"]]);
  s.willList(agent(S1, { status: "idle" }));
  await s.registry.tick();
  assert.deepEqual(states(s.registry), [[S1, "needs_input"]]);
  // 間に新しい判断待ちの Notification が来れば数え直す
  s.hook({ hook_event_name: "Notification", session_id: S1, notification_type: "agent_needs_input" });
  s.willList(agent(S1, { status: "idle" }));
  await s.registry.tick();
  assert.deepEqual(states(s.registry), [[S1, "needs_input"]]);
  s.willList(agent(S1, { status: "idle" }));
  await s.registry.tick();
  assert.deepEqual(states(s.registry), [[S1, "idle"]]);
  assert.equal(s.store.get(S1)?.waitingKind, null);
  // Stop でも解消（今までどおり）
  s.hook({ hook_event_name: "Notification", session_id: S1, notification_type: "permission_prompt" });
  assert.deepEqual(states(s.registry), [[S1, "needs_input"]]);
  s.hook({ hook_event_name: "Stop", session_id: S1 });
  assert.deepEqual(states(s.registry), [[S1, "idle"]]);
  // idle 1 回 → 読めない回（数は残る）→ idle で解消。idle 1 回 → waiting → idle は数え直し
  s.hook({ hook_event_name: "Notification", session_id: S1, notification_type: "permission_prompt" });
  s.willList(agent(S1, { status: "idle" }));
  await s.registry.tick();
  s.willFail();
  await s.registry.tick();
  assert.deepEqual(states(s.registry), [[S1, "needs_input"]]);
  s.willList(agent(S1, { status: "idle" }));
  await s.registry.tick();
  assert.deepEqual(states(s.registry), [[S1, "idle"]]);
  s.hook({ hook_event_name: "Notification", session_id: S1, notification_type: "permission_prompt" });
  s.willList(agent(S1, { status: "idle" }));
  await s.registry.tick();
  s.willList(agent(S1, { status: "waiting" }));
  await s.registry.tick();
  s.willList(agent(S1, { status: "idle" }));
  await s.registry.tick();
  assert.deepEqual(states(s.registry), [[S1, "needs_input"]]);
  s.willList(agent(S1, { status: "idle" }));
  await s.registry.tick();
  assert.deepEqual(states(s.registry), [[S1, "idle"]]);
  // 知らない notification_type は other で、判断待ちにしない
  s.hook({ hook_event_name: "Notification", session_id: S1, notification_type: "something_new" });
  assert.deepEqual(states(s.registry), [[S1, "idle"]]);
  for (const type of ["elicitation_dialog", "elicitation_url_dialog", "agent_needs_input"]) {
    s.hook({ hook_event_name: "Notification", session_id: S1, notification_type: type });
    assert.deepEqual(states(s.registry), [[S1, "needs_input"]], type);
    s.hook({ hook_event_name: "UserPromptSubmit", session_id: S1, prompt: "続けて" });
    assert.deepEqual(states(s.registry), [[S1, "idle"]], type);
  }
});

test("CcRegistry: 判断待ちの Notification より前に読み始めた一覧の status は数えない。一覧に無いセッションの保留した事象は、現れた読み取りでは数えない（#290）", async (t) => {
  const s = setup(t);
  s.willList(agent(S1));
  await s.registry.tick();
  // 読み始めてから（ダイアログの前の busy）、読み終わる前に Notification が来る → その busy では外さない
  let release = (): void => undefined;
  s.listGate.wait = new Promise<void>((resolve) => {
    release = resolve;
  });
  s.willList(agent(S1, { status: "busy" }));
  const reading = s.registry.tick();
  s.clock.now = BASE + 1000;
  s.hook({ hook_event_name: "Notification", session_id: S1, notification_type: "permission_prompt" });
  release();
  await reading;
  s.listGate.wait = undefined;
  assert.equal(s.store.get(S1)?.waitingKind, "permission_prompt");
  // busy の間は実行中に見えるが、idle に戻れば判断待ちのまま（1 回目）
  s.willList(agent(S1, { status: "idle" }));
  await s.registry.tick();
  assert.deepEqual(states(s.registry), [[S1, "needs_input"]]);
  // その後に読み始めた busy で外す
  s.clock.now = BASE + 2000;
  s.willList(agent(S1, { status: "busy" }));
  await s.registry.tick();
  assert.deepEqual(states(s.registry), [[S1, "running"]]);
  assert.equal(s.store.get(S1)?.waitingKind, null);
  // 一覧に無い S2 の Notification は保留され、現れた読み取りで反映される（その読み取りの idle は数えず、次の 2 回で解消）
  s.hook({ hook_event_name: "Notification", session_id: S2, notification_type: "agent_needs_input" });
  s.willList(agent(S1), agent(S2, { status: "idle" }));
  await s.registry.tick();
  assert.deepEqual(states(s.registry), [[S2, "needs_input"], [S1, "idle"]]);
  s.willList(agent(S1), agent(S2, { status: "idle" }));
  await s.registry.tick();
  assert.deepEqual(states(s.registry), [[S2, "needs_input"], [S1, "idle"]]);
  s.willList(agent(S1), agent(S2, { status: "idle" }));
  await s.registry.tick();
  // どちらも待機（最後の事象が新しい S2 が先）
  assert.deepEqual(states(s.registry), [[S2, "idle"], [S1, "idle"]]);
});

test("CcRegistry: status: waiting は hook が無くても判断待ち（待ち始めは最初に見た時刻）", async (t) => {
  const s = setup(t);
  s.willList(agent(S1, { status: "waiting", waitingFor: "permission prompt" }), agent(S2));
  await s.registry.tick();
  s.clock.now = BASE + 20_000;
  s.willList(agent(S1, { status: "waiting", waitingFor: "permission prompt" }), agent(S2, { status: "waiting" }));
  await s.registry.tick();
  const sessions = s.registry.snapshot().sessions;
  assert.deepEqual(
    sessions.map((session) => [session.sessionId, session.state, session.waitingSince]),
    [
      [S1, "needs_input", BASE],
      [S2, "needs_input", BASE + 20_000],
    ],
  );
  assert.equal(sessions[0]!.waitingFor, "permission prompt");
  // waitingFor は cc_sessions にも残り（v29）、waiting でなくなれば消える
  assert.equal(s.store.get(S1)!.waitingFor, "permission prompt");
  assert.equal(s.store.get(S2)!.waitingFor, null);
  s.willList(agent(S1), agent(S2));
  await s.registry.tick();
  assert.equal(s.store.get(S1)!.waitingFor, null);
});

test("lastActivity: 最後の指示・最後の事象・記録の mtime のいちばん新しいもの。どれも無ければ起動の時刻（#288）", () => {
  assert.equal(lastActivity({ lastPromptAt: 100, lastEventAt: undefined, transcriptMtime: 900, startedAt: 1 }), 900);
  assert.equal(lastActivity({ lastPromptAt: 100, lastEventAt: 350, transcriptMtime: 200, startedAt: 1 }), 350);
  assert.equal(lastActivity({ lastPromptAt: 700, lastEventAt: 350, transcriptMtime: undefined, startedAt: 1 }), 700);
  assert.equal(lastActivity({ lastPromptAt: undefined, lastEventAt: undefined, transcriptMtime: undefined, startedAt: 500 }), 500);
  assert.equal(lastActivity({ lastPromptAt: undefined, lastEventAt: undefined, transcriptMtime: undefined, startedAt: undefined }), undefined);
});

test("rankSessions: 判断待ち（待ち始めの古い順）→ 実行中 → 待機（どちらも最後の活動（最後の指示・最後の事象・記録の mtime のいちばん新しいもの → 起動）の新しい順）", () => {
  const base: RankInput = {
    sessionId: "",
    status: "idle",
    pendingPermission: false,
    waitingKind: null,
    waitingSince: undefined,
    lastPromptAt: undefined,
    lastEventAt: undefined,
    transcriptMtime: undefined,
    startedAt: undefined,
  };
  const items: RankInput[] = [
    { ...base, sessionId: "idle-started", startedAt: 500 },
    { ...base, sessionId: "idle-old-prompt", lastPromptAt: 100, transcriptMtime: 900 },
    { ...base, sessionId: "idle-mtime", transcriptMtime: 600 },
    { ...base, sessionId: "idle-none" },
    { ...base, sessionId: "running-old", status: "busy", lastPromptAt: 200 },
    { ...base, sessionId: "running-new", status: "busy", lastPromptAt: 300 },
    { ...base, sessionId: "wait-new", status: "waiting", waitingSince: 50 },
    { ...base, sessionId: "wait-old", waitingKind: "permission_prompt", waitingSince: 10 },
    { ...base, sessionId: "wait-busy", status: "busy", waitingKind: "permission_prompt", waitingSince: 1, lastPromptAt: 250 },
    { ...base, sessionId: "wait-held", status: "busy", pendingPermission: true, waitingSince: 30 },
    { ...base, sessionId: "idle-prompt", lastPromptAt: 700 },
  ];
  assert.deepEqual(
    rankSessions(items).map((item) => [item.sessionId, item.state]),
    [
      ["wait-old", "needs_input"],
      ["wait-held", "needs_input"],
      ["wait-new", "needs_input"],
      ["running-new", "running"],
      ["wait-busy", "running"],
      ["running-old", "running"],
      ["idle-old-prompt", "idle"],
      ["idle-prompt", "idle"],
      ["idle-mtime", "idle"],
      ["idle-started", "idle"],
      ["idle-none", "idle"],
    ],
  );
});

test("CcRegistry: 一覧に無い session_id の Stop・UserPromptSubmit は 30 秒保留し、現れなければ捨てる（DB に残らない）", async (t) => {
  const s = setup(t);
  s.willList(agent(S1));
  await s.registry.tick();
  s.hook({ hook_event_name: "UserPromptSubmit", session_id: S2, prompt: "偽の指示" });
  s.hook({ hook_event_name: "Stop", session_id: S2 });
  assert.equal(s.registry.pendingCount(), 2);
  await s.registry.tick();
  assert.equal(s.registry.pendingCount(), 2);
  s.clock.now = BASE + CC_PENDING_MS;
  await s.registry.tick();
  assert.equal(s.registry.pendingCount(), 0);
  // 後から同じ session_id が一覧に現れても、捨てた事象は反映されない
  s.willList(agent(S1), agent(S2));
  await s.registry.tick();
  assert.equal(s.store.get(S2)?.lastPromptAt, null);
  assert.equal(s.store.get(S2)?.lastPromptText, null);
  assert.equal(s.store.get(S2)?.lastEvent, null);
  assert.equal(
    s.db.prepare("SELECT COUNT(*) AS n FROM cc_sessions WHERE last_prompt_text IS NOT NULL OR last_event IS NOT NULL").get()?.n,
    0,
  );
});

test("CcRegistry: 一覧に無い session_id の事象は、30 秒以内の一覧に現れれば受けた時刻で反映する。PermissionRequest は保留しない", async (t) => {
  const s = setup(t);
  await s.registry.tick();
  s.hook({ hook_event_name: "UserPromptSubmit", session_id: S1, prompt: "はじめ" });
  s.hook({ hook_event_name: "PermissionRequest", session_id: S1, tool_name: "Bash", tool_input: { command: "ls" } });
  assert.equal(s.registry.pendingCount(), 1);
  s.clock.now = BASE + 10_000;
  s.willList(agent(S1));
  await s.registry.tick();
  assert.equal(s.registry.pendingCount(), 0);
  const view = s.registry.snapshot().sessions[0]!;
  assert.equal(view.lastPromptAt, BASE);
  assert.equal(view.lastPromptText, "はじめ");
  assert.equal(view.permission, undefined);
});

test("CcRegistry: PermissionRequest は §3.4 の要約とハッシュだけを持ち、tool_input の全体は DB にも一覧にも残らない", async (t) => {
  const s = setup(t);
  s.willList(agent(S1));
  await s.registry.tick();
  const content = "FULL-CONTENT-".repeat(100);
  s.hook({
    hook_event_name: "PermissionRequest",
    session_id: S1,
    cwd: "/w/app",
    tool_name: "Write",
    tool_input: { file_path: "/w/app/src/x.ts", content },
    permission_mode: "default",
  });
  const view = s.registry.snapshot().sessions[0]!;
  assert.equal(view.permission?.toolName, "Write");
  assert.equal(view.permission?.summary, "src/x.ts");
  assert.match(view.permission?.requestHash ?? "", /^[0-9a-f]{64}$/);
  assert.ok(!JSON.stringify(s.registry.snapshot()).includes("FULL-CONTENT"));
  const rows = s.db.prepare("SELECT * FROM cc_sessions").all();
  assert.ok(!JSON.stringify(rows).includes("FULL-CONTENT"));
  // その後の UserPromptSubmit で消える
  s.hook({ hook_event_name: "UserPromptSubmit", session_id: S1, prompt: "次" });
  assert.equal(s.registry.snapshot().sessions[0]!.permission, undefined);
});

test("CcRegistry: 周期は見ていなければ 60 秒、touch から 30 秒は設定の秒数。hook の事象が来たら 2 秒後に 1 回（続けて来ても 1 回）", async (t) => {
  const s = setup(t, 10);
  s.willList(agent(S1));
  s.registry.start();
  await s.registry.idle();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(s.calls(), 1);
  assert.deepEqual(s.delays, [CC_IDLE_POLL_MS]);
  s.registry.touch();
  await s.fire();
  assert.equal(s.calls(), 2);
  assert.deepEqual(s.delays.slice(1), [10_000]);
  // 事象が続けて来ても予約は 1 つ（2 秒後）
  s.hook({ hook_event_name: "Stop", session_id: S1 });
  s.hook({ hook_event_name: "Stop", session_id: S1 });
  s.hook({ hook_event_name: "UserPromptSubmit", session_id: S1, prompt: "a" });
  assert.deepEqual(s.delays.slice(2), [CC_EVENT_REFRESH_MS]);
  assert.equal(s.scheduled.length, 1);
  s.clock.now = BASE + 40_000;
  await s.fire();
  assert.equal(s.calls(), 3);
  // touch から 30 秒を過ぎたので 60 秒
  assert.deepEqual(s.delays.slice(3), [CC_IDLE_POLL_MS]);
  s.registry.stop();
  assert.equal(s.scheduled.length, 0);
  s.hook({ hook_event_name: "Stop", session_id: S1 });
  assert.equal(s.scheduled.length, 0);
});

test("CcRegistry: 見ていなかった状態で touch されたら、最後に読み始めてから設定の秒数経っていれば 60 秒の予約を取り消してすぐ読む", async (t) => {
  // start の前は何もしない
  const before = setup(t, 10);
  before.registry.touch();
  assert.equal(before.scheduled.length, 0);

  const s = setup(t, 10);
  s.willList(agent(S1));
  s.registry.start();
  await s.registry.idle();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(s.delays, [CC_IDLE_POLL_MS]);

  // 最後に読み始めてから 15 秒（10 秒以上）: すぐ読む予約に変わる
  s.clock.now = BASE + 15_000;
  s.registry.touch();
  assert.deepEqual(s.delays.slice(1), [0]);
  assert.equal(s.scheduled.length, 1);
  await s.fire();
  assert.equal(s.calls(), 2);
  // 読み終わった後の予約は今どおり（見ているので設定の秒数）
  assert.deepEqual(s.delays.slice(2), [10_000]);
  // 見ている間の touch は予約を変えない
  s.registry.touch();
  assert.deepEqual(s.delays.slice(3), []);

  // 見なくなってから（touch から 30 秒超）、読み始めて 10 秒未満なら予約を変えない（読めなかった読み取りも数える）
  s.clock.now = BASE + 60_000;
  s.willFail();
  await s.fire();
  assert.equal(s.calls(), 3);
  assert.deepEqual(s.delays.slice(3), [CC_IDLE_POLL_MS]);
  s.clock.now = BASE + 65_000;
  s.registry.touch();
  assert.deepEqual(s.delays.slice(4), []);

  // 事象の早い読み取りを予約している間は変えない
  s.clock.now = BASE + 200_000;
  s.hook({ hook_event_name: "Stop", session_id: S1 });
  assert.deepEqual(s.delays.slice(4), [CC_EVENT_REFRESH_MS]);
  s.registry.touch();
  assert.deepEqual(s.delays.slice(5), []);

  // 停止の後は何もしない
  s.registry.stop();
  s.clock.now = BASE + 400_000;
  s.registry.touch();
  assert.equal(s.scheduled.length, 0);
});

test("CcRegistry: 読んでいる途中の touch は予約を変えない", async (t) => {
  const db = tempDb(t);
  const clock = { now: BASE };
  const now = (): Date => new Date(clock.now);
  let release: (() => void) | undefined;
  const delays: number[] = [];
  const registry = new CcRegistry({
    cfg: { ccPollSec: 10 },
    agents: {
      list: () =>
        new Promise<AgentsResult>((resolve) => {
          release = () => resolve({ ok: true, agents: [agent(S1)], dropped: 0 });
        }),
    },
    dirs: { sessionFile: () => undefined, transcriptMtime: () => undefined },
    store: new CcSessionStore(db, now),
    now,
    timers: {
      after: (_fn, ms) => {
        delays.push(ms);
        return () => undefined;
      },
    },
    log: () => undefined,
  });
  registry.start();
  clock.now = BASE + 20_000;
  registry.touch();
  assert.deepEqual(delays, []);
  release?.();
  await registry.idle();
  await new Promise((resolve) => setImmediate(resolve));
  // 読み終わった後は見ているので設定の秒数
  assert.deepEqual(delays, [10_000]);
  registry.stop();
});

test("CcRegistry: 送信の待ち行列が空でない（busy）間は、見ていなくても設定の周期で読む", async (t) => {
  let busy = true;
  const s = setup(t, 10, () => busy);
  s.willList(agent(S1));
  s.registry.start();
  await s.registry.idle();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(s.delays, [10_000]);
  busy = false;
  await s.fire();
  assert.deepEqual(s.delays.slice(1), [CC_IDLE_POLL_MS]);
  s.registry.stop();
});

test("CcRegistry: log は件数と種類だけで、名前・cwd・sessionId・本文を出さない", async (t) => {
  const s = setup(t);
  s.files.set(S1, { bridgeSessionId: "session_secretbridge", tmux: "secret-tmux:0.%3" });
  s.willList(agent(S1, { status: "busy" }), agent(S2), agent(S3, { status: "waiting" }), agent(S4));
  await s.registry.tick();
  s.hook({ hook_event_name: "UserPromptSubmit", session_id: S2, prompt: "secret prompt text" });
  s.hook({ hook_event_name: "PermissionRequest", session_id: S2, tool_name: "Bash", tool_input: { command: "secret-command" } });
  s.willFail();
  await s.registry.tick();
  s.willList(agent(S1));
  await s.registry.tick();
  assert.ok(s.logs.length > 0);
  assert.ok(s.logs.includes("Claude Code: 一覧 4 件（判断待ち 1・実行中 1）"), s.logs.join("\n"));
  assert.ok(s.logs.includes("Claude Code: 一覧を読めませんでした（json）"), s.logs.join("\n"));
  const text = s.logs.join("\n");
  for (const secret of [SECRET_NAME, SECRET_CWD, "secret-dir", S1, S2, S3, S4, "secret prompt", "secret-command", "secretbridge", "secret-tmux"]) {
    assert.ok(!text.includes(secret), secret);
  }
});

test("parseHookEvent: 固定の集合に無い事象・UUID でない session_id は読まない", () => {
  const at = new Date(BASE);
  assert.equal(parseHookEvent({ hook_event_name: "PreToolUse", session_id: S1 }, at), undefined);
  assert.equal(parseHookEvent({ hook_event_name: "Stop", session_id: "abc" }, at), undefined);
  assert.equal(parseHookEvent({ hook_event_name: "Stop" }, at), undefined);
  const event: CcHookEvent | undefined = parseHookEvent(
    { hook_event_name: "Stop", session_id: S1, permission_mode: "bad mode!", transcript_path: "/x", last_assistant_message: "hi" },
    at,
  );
  // last_assistant_message は Stop の返事として読む（CC8）
  assert.deepEqual(event, { event: "Stop", sessionId: S1, receivedAt: at, lastAssistantMessage: "hi" });
});

test("CcRegistry: 保留できる事象は CC_PENDING_MAX 件までで、超えた分は捨てる（後で一覧に現れても反映しない）", async (t) => {
  const s = setup(t);
  await s.registry.tick();
  for (let i = 0; i < CC_PENDING_MAX; i++) s.hook({ hook_event_name: "Stop", session_id: S1 });
  assert.equal(s.registry.pendingCount(), CC_PENDING_MAX);
  // 101 件目は捨てる
  s.hook({ hook_event_name: "UserPromptSubmit", session_id: S1, prompt: "101 件目" });
  assert.equal(s.registry.pendingCount(), CC_PENDING_MAX);
  s.willList(agent(S1));
  await s.registry.tick();
  assert.equal(s.registry.pendingCount(), 0);
  assert.equal(s.store.get(S1)?.lastEvent, "Stop");
  assert.equal(s.store.get(S1)?.lastPromptText, null);
});

test("CcRegistry: 一覧から消えたセッションは ended、同じ session_id が戻ったら gone_at を外す前の行で revived（1 回だけ。投げても一覧は進む）", async (t) => {
  const db = tempDb(t);
  const clock = { now: BASE };
  const now = (): Date => new Date(clock.now);
  const results: AgentEntry[][] = [[agent(S1), agent(S2)], [agent(S2)], [agent(S1), agent(S2)], [agent(S1), agent(S2)]];
  const ended: string[] = [];
  const revived: Array<{ sessionId: string; goneAt: string | null }> = [];
  const logs: string[] = [];
  const store = new CcSessionStore(db, now);
  const registry = new CcRegistry({
    cfg: { ccPollSec: 10 },
    agents: { list: async () => ({ ok: true, agents: results.shift() ?? [], dropped: 0 }) },
    dirs: { sessionFile: () => undefined, transcriptMtime: () => undefined },
    store,
    now,
    ended: (row) => ended.push(row.sessionId),
    revived: (row) => {
      revived.push({ sessionId: row.sessionId, goneAt: row.goneAt });
      throw new Error("boom");
    },
    log: (line) => logs.push(line),
  });
  await registry.tick();
  assert.deepEqual(revived, []);
  clock.now = BASE + 1000;
  await registry.tick();
  assert.deepEqual(ended, [S1]);
  clock.now = BASE + 2000;
  await registry.tick();
  assert.deepEqual(revived, [{ sessionId: S1, goneAt: new Date(BASE + 1000).toISOString() }]);
  assert.equal(store.get(S1)?.goneAt, null);
  assert.ok(logs.includes("Claude Code: 戻ったセッションの処理に失敗しました（Error）"));
  // 生きたままなら呼ばない
  await registry.tick();
  assert.equal(revived.length, 1);
});
