import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { request, type ClientRequest } from "node:http";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { AgentEntry, AgentsResult } from "../src/cc/agents.ts";
import { createCcHookServer, summarizePermission } from "../src/cc/hook-server.ts";
import {
  CC_PERMISSION_DENY_MESSAGE,
  CC_QUESTION_DENY_MESSAGE,
  CC_PERMISSION_RATE_LIMIT,
  CC_PERMISSION_UNKNOWN_LOG_INTERVAL_MS,
  CcPermissionHold,
  decisionBody,
  permissionExpiresAt,
} from "../src/cc/permission-hold.ts";
import { CC_EVENT_REFRESH_MS, CC_IDLE_POLL_MS, CC_PERMISSION_POLL_MS, CcRegistry, type CcTimers } from "../src/cc/registry.ts";
import { CcPermissionStore } from "../src/store/cc-permissions.ts";
import { CcSessionStore } from "../src/store/cc-sessions.ts";
import { MIGRATIONS, openDb } from "../src/store/db.ts";
import { tempDb, tempDir } from "./helpers/db.ts";

const TOKEN = "hook-token-for-tests-0123456789abcdef";
const BASE = Date.parse("2026-11-01T00:00:00.000Z");
const S1 = "11111111-1111-4111-8111-111111111111";
const S2 = "22222222-2222-4222-8222-222222222222";
const S9 = "99999999-9999-4999-8999-999999999999";
const SECRET_COMMAND = "rm -rf secret-dir";
const SECRET_CWD = "/home/owner/workspace/secret-dir";

function agent(sessionId: string, overrides: Partial<AgentEntry> = {}): AgentEntry {
  return {
    pid: 100,
    sessionId,
    cwd: SECRET_CWD,
    name: "secret-name",
    kind: "interactive",
    startedAt: BASE - 3_600_000,
    status: "waiting",
    waitingFor: "permission prompt",
    ...overrides,
  };
}

type Reply = { status: number; body: string };

/** 待ち受けている受け口に 1 件送る。応答（保留が終わるまで来ない）と、途中で切るための req を返す */
function post(port: number, body: Record<string, unknown>): { reply: Promise<Reply>; req: ClientRequest } {
  let req!: ClientRequest;
  const reply = new Promise<Reply>((resolve, reject) => {
    req = request(
      { host: "127.0.0.1", port, path: "/hook", method: "POST", headers: { "X-Self-Agent-Hook": TOKEN, "Content-Type": "application/json" } },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () => resolve({ status: res.statusCode!, body: Buffer.concat(chunks).toString("utf8") }));
        res.on("error", reject);
      },
    );
    req.on("error", reject);
    req.end(JSON.stringify(body));
  });
  return { reply, req };
}

function permissionBody(sessionId: string, command = SECRET_COMMAND, suggestions: unknown[] = []): Record<string, unknown> {
  return {
    hook_event_name: "PermissionRequest",
    session_id: sessionId,
    cwd: SECRET_CWD,
    permission_mode: "default",
    tool_name: "Bash",
    tool_input: { command, description: "x" },
    permission_suggestions: suggestions,
  };
}

/** 条件が成り立つまで待つ（HTTP の往復のため） */
async function until(check: () => boolean, label: string): Promise<void> {
  for (let i = 0; i < 400; i++) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.fail(`待ちきれませんでした: ${label}`);
}

/**
 * 本物の受け口（127.0.0.1・空いているポート）・本物の CcRegistry（偽の claude agents --json）・本物の CcPermissionHold（偽のタイマー）と一時 SQLite
 */
async function setup(t: TestContext, opts: { holdSec?: number; questionHoldSec?: number; agents?: AgentEntry[] } = {}) {
  const db = tempDb(t);
  const clock = { now: BASE };
  const now = (): Date => new Date(clock.now);
  const sessions = new CcSessionStore(db, now);
  const store = new CcPermissionStore(db, now);
  const logs: string[] = [];
  const log = (line: string): void => {
    logs.push(line);
  };
  let next: AgentsResult = { ok: true, agents: opts.agents ?? [agent(S1), agent(S2)], dropped: 0 };
  // 保留の時間切れのタイマー（偽物。fireHold で動かす）
  const holdTimers: Array<{ fn: () => void; ms: number; cancelled: boolean }> = [];
  const timers: CcTimers = {
    after: (fn, ms) => {
      const entry = { fn, ms, cancelled: false };
      holdTimers.push(entry);
      return () => {
        entry.cancelled = true;
      };
    },
  };
  const registryDelays: number[] = [];
  const registryScheduled: Array<() => void> = [];
  let registry!: CcRegistry;
  const hold = new CcPermissionHold({
    cfg: { ccPermissionHoldSec: opts.holdSec ?? 300, ccQuestionHoldSec: opts.questionHoldSec ?? 900 },
    store,
    known: (sessionId) => registry.knows(sessionId),
    now,
    timers,
    log,
  });
  registry = new CcRegistry({
    cfg: { ccPollSec: 10 },
    agents: { list: async () => next },
    dirs: { sessionFile: () => undefined, transcriptLastAt: () => undefined },
    store: sessions,
    now,
    timers: {
      after: (fn, ms) => {
        registryDelays.push(ms);
        registryScheduled.push(fn);
        return () => {
          const index = registryScheduled.indexOf(fn);
          if (index !== -1) registryScheduled.splice(index, 1);
        };
      },
    },
    permissions: hold,
    log,
  });
  await registry.tick();
  const server = createCcHookServer({ host: "127.0.0.1", port: 0, token: TOKEN, receiver: registry, permissions: hold, now, log });
  await server.start();
  t.after(() => server.close());
  const port = server.address()!.port;
  /** 許可の要求を送り、pending の行ができるまで待つ */
  const ask = async (sessionId: string, command = SECRET_COMMAND, suggestions: unknown[] = []) => {
    const before = store.pendingFor(sessionId)?.id;
    const sent = post(port, permissionBody(sessionId, command, suggestions));
    await until(() => {
      const row = store.pendingFor(sessionId);
      return row !== undefined && row.id !== before;
    }, "pending の行");
    return { ...sent, id: store.pendingFor(sessionId)!.id };
  };
  return {
    db,
    clock,
    store,
    sessions,
    hold,
    registry,
    server,
    port,
    logs,
    ask,
    holdTimers,
    registryDelays,
    /** 一覧の予約を 1 つ動かし、読み終わるのを待つ */
    fireRegistry: async () => {
      const fn = registryScheduled.shift();
      assert.ok(fn, "予約が無い");
      fn();
      await registry.idle();
      await new Promise((resolve) => setImmediate(resolve));
    },
    setAgents: (agents: AgentEntry[]) => {
      next = { ok: true, agents, dropped: 0 };
    },
    /** 一覧を 1 回読む（読み始めの時刻は clock） */
    list: () => registry.tick(),
    send: (body: Record<string, unknown>) => post(port, body).reply,
  };
}

test("CC5a: 押さずに保留が切れたら、応答は空の本文（allow を含まない）で expired", async (t) => {
  const s = await setup(t, { holdSec: 300 });
  const asked = await s.ask(S1);
  assert.equal(s.store.get(asked.id)?.state, "pending");
  // 保留の長さは SELF_AGENT_CC_PERMISSION_HOLD_SEC
  const timer = s.holdTimers.at(-1)!;
  assert.equal(timer.ms, 300_000);
  timer.fn();
  const reply = await asked.reply;
  assert.equal(reply.status, 200);
  assert.equal(reply.body, "");
  const row = s.store.get(asked.id)!;
  assert.equal(row.state, "expired");
  assert.equal(row.via, null);
  assert.ok(row.resolvedAt !== null);
  assert.equal(s.hold.holding(), false);
  // 時間切れの後に押しても 409（古い）
  assert.deepEqual(s.hold.answer(asked.id, "allow", "web"), { ok: false, reason: "stale" });
});

test("CC5a: Claude Code が先に接続を閉じたら、応答を書かずに expired", async (t) => {
  const s = await setup(t);
  const asked = await s.ask(S1);
  asked.reply.catch(() => undefined);
  asked.req.destroy();
  await until(() => s.store.get(asked.id)?.state !== "pending", "expired");
  assert.equal(s.store.get(asked.id)?.state, "expired");
  assert.equal(s.hold.holding(), false);
  // 時間切れのタイマーは取り消されている
  assert.equal(s.holdTimers.at(-1)!.cancelled, true);
  assert.deepEqual(s.hold.answer(asked.id, "allow", "web"), { ok: false, reason: "stale" });
});

test("CC5a: [許可] は behavior: allow だけ（updatedPermissions・updatedInput なし）。2 回目の操作は stale", async (t) => {
  const s = await setup(t);
  const asked = await s.ask(S1);
  assert.deepEqual(s.hold.answer(asked.id, "allow", "web"), { ok: true, state: "allowed" });
  const reply = await asked.reply;
  assert.equal(reply.status, 200);
  assert.deepEqual(JSON.parse(reply.body), { hookSpecificOutput: { hookEventName: "PermissionRequest", decision: { behavior: "allow" } } });
  assert.ok(!reply.body.includes("updatedPermissions"));
  assert.ok(!reply.body.includes("updatedInput"));
  const row = s.store.get(asked.id)!;
  assert.equal(row.state, "allowed");
  assert.equal(row.via, "web");
  // 1 行に応答は 1 回
  assert.deepEqual(s.hold.answer(asked.id, "allow", "web"), { ok: false, reason: "stale" });
  assert.deepEqual(s.hold.answer(asked.id, "deny", "web"), { ok: false, reason: "stale" });
  assert.equal(s.store.get(asked.id)?.state, "allowed");
});

test("CC5a: [拒否] は deny + message で interrupt を付けない", async (t) => {
  const s = await setup(t);
  const asked = await s.ask(S1);
  assert.deepEqual(s.hold.answer(asked.id, "deny", "web"), { ok: true, state: "denied" });
  const reply = await asked.reply;
  const json = JSON.parse(reply.body);
  assert.deepEqual(json, {
    hookSpecificOutput: { hookEventName: "PermissionRequest", decision: { behavior: "deny", message: CC_PERMISSION_DENY_MESSAGE } },
  });
  assert.equal("interrupt" in json.hookSpecificOutput.decision, false);
  assert.equal(s.store.get(asked.id)?.via, "web");
});

test("decisionBody: allow と deny の形（自動の allow は無い）", () => {
  assert.equal(decisionBody("allow"), '{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"allow"}}}');
  assert.ok(decisionBody("deny").includes('"behavior":"deny"'));
});

test("CC5a: 同じセッションの次の PermissionRequest で前の要求は answered_elsewhere（hook）・空の本文。新しい方を保留する", async (t) => {
  const s = await setup(t);
  const first = await s.ask(S1);
  const second = await s.ask(S1, "npm test");
  const reply = await first.reply;
  assert.equal(reply.body, "");
  assert.equal(s.store.get(first.id)?.state, "answered_elsewhere");
  assert.equal(s.store.get(first.id)?.via, "hook");
  assert.equal(s.store.get(second.id)?.state, "pending");
  assert.ok(second.id > first.id);
  // 前の行を押しても古い
  assert.deepEqual(s.hold.answer(first.id, "allow", "web"), { ok: false, reason: "stale" });
  // 別のセッションの保留には触らない
  const other = await s.ask(S2);
  assert.equal(s.store.get(second.id)?.state, "pending");
  assert.equal(s.store.get(other.id)?.state, "pending");
  assert.deepEqual(s.hold.answer(second.id, "allow", "web"), { ok: true, state: "allowed" });
  assert.deepEqual(s.hold.answer(other.id, "deny", "web"), { ok: true, state: "denied" });
  await Promise.all([second.reply, other.reply]);
});

test("CC5a: そのセッションの Stop・UserPromptSubmit で保留は answered_elsewhere（hook）・空の本文。Notification では閉じない", async (t) => {
  const s = await setup(t);
  for (const event of ["Stop", "UserPromptSubmit"]) {
    const asked = await s.ask(S1);
    const other = await s.ask(S2);
    await s.send({ hook_event_name: "Notification", session_id: S1, notification_type: "permission_prompt" });
    assert.equal(s.store.get(asked.id)?.state, "pending", event);
    const response = await s.send({ hook_event_name: event, session_id: S1, prompt: "x" });
    assert.equal(response.body, "");
    assert.equal((await asked.reply).body, "", event);
    assert.equal(s.store.get(asked.id)?.state, "answered_elsewhere", event);
    assert.equal(s.store.get(asked.id)?.via, "hook", event);
    assert.equal(s.store.get(other.id)?.state, "pending", event);
    s.hold.answer(other.id, "deny", "web");
    await other.reply;
  }
});

test("CC5a: 受信 3 秒以後に読み始めた一覧の status が idle・busy なら answered_elsewhere（status）。3 秒未満の読み・waiting のままでは閉じない", async (t) => {
  const s = await setup(t);
  const first = await s.ask(S1);
  // 2.9 秒後に読み始めた一覧で idle でも閉じない
  s.setAgents([agent(S1, { status: "idle", waitingFor: undefined }), agent(S2)]);
  s.clock.now = BASE + 2_900;
  await s.list();
  assert.equal(s.store.get(first.id)?.state, "pending");
  // 3 秒後でも waiting のままなら閉じない
  s.setAgents([agent(S1), agent(S2)]);
  s.clock.now = BASE + 3_000;
  await s.list();
  assert.equal(s.store.get(first.id)?.state, "pending");
  // idle になった
  s.setAgents([agent(S1, { status: "idle", waitingFor: undefined }), agent(S2)]);
  s.clock.now = BASE + 8_000;
  await s.list();
  assert.equal((await first.reply).body, "");
  assert.equal(s.store.get(first.id)?.state, "answered_elsewhere");
  assert.equal(s.store.get(first.id)?.via, "status");
  // busy も同じ
  s.setAgents([agent(S1), agent(S2)]);
  await s.list();
  const second = await s.ask(S1);
  s.setAgents([agent(S1, { status: "busy", waitingFor: undefined }), agent(S2)]);
  s.clock.now = BASE + 11_000;
  await s.list();
  assert.equal((await second.reply).body, "");
  assert.equal(s.store.get(second.id)?.via, "status");
  // status の形が読めない（undefined）なら閉じない
  s.setAgents([agent(S1), agent(S2)]);
  await s.list();
  const third = await s.ask(S1);
  s.setAgents([agent(S1, { status: undefined, waitingFor: undefined }), agent(S2)]);
  s.clock.now = BASE + 20_000;
  await s.list();
  assert.equal(s.store.get(third.id)?.state, "pending");
  // 一覧から消えた（claude が終わった）なら expired（via null）
  s.setAgents([agent(S2)]);
  s.clock.now = BASE + 25_000;
  await s.list();
  assert.equal((await third.reply).body, "");
  assert.equal(s.store.get(third.id)?.state, "expired");
  assert.equal(s.store.get(third.id)?.via, null);
});

test("CC5a: 一覧に無い session_id の要求は記録も保留もせず、すぐ 200・空", async (t) => {
  const s = await setup(t);
  const reply = await s.send(permissionBody(S9));
  assert.equal(reply.status, 200);
  assert.equal(reply.body, "");
  assert.equal(s.store.listPending().length, 0);
  assert.equal(s.db.prepare("SELECT COUNT(*) AS n FROM cc_permissions").get()?.n, 0);
  // tool_name が読めない要求も保留しない
  const bad = await s.send({ ...permissionBody(S1), tool_name: "bad name!" });
  assert.equal(bad.body, "");
  assert.equal(s.store.listPending().length, 0);
});

test("CC5a: 停止で保留中の全部に空の本文を返して released（shutdown）。以後の要求は保留しない", async (t) => {
  const s = await setup(t);
  const a = await s.ask(S1);
  const b = await s.ask(S2);
  s.hold.stop();
  assert.equal((await a.reply).body, "");
  assert.equal((await b.reply).body, "");
  for (const id of [a.id, b.id]) {
    assert.equal(s.store.get(id)?.state, "released");
    assert.equal(s.store.get(id)?.via, "shutdown");
  }
  const after = await s.send(permissionBody(S1));
  assert.equal(after.body, "");
  assert.equal(s.store.listPending().length, 0);
  const last = s.db.prepare("SELECT state, via FROM cc_permissions ORDER BY id DESC LIMIT 1").get();
  assert.deepEqual({ ...last }, { state: "released", via: "shutdown" });
});

test("CC5a: 同じセッションから 1 分に 20 件を超えたら保留せず released（limit）。1 分経てばまた保留する", async (t) => {
  const s = await setup(t);
  let previous: Awaited<ReturnType<typeof s.ask>> | undefined;
  for (let i = 0; i < CC_PERMISSION_RATE_LIMIT; i++) {
    const asked = await s.ask(S1, `cmd ${i}`);
    if (previous !== undefined) await previous.reply;
    previous = asked;
  }
  // 21 件目: 前の保留は閉じ、新しいものは保留しない
  const over = await s.send(permissionBody(S1, "cmd 20"));
  assert.equal(over.body, "");
  assert.equal((await previous!.reply).body, "");
  assert.equal(s.store.listPending().length, 0);
  const last = s.db.prepare("SELECT state, via FROM cc_permissions ORDER BY id DESC LIMIT 1").get();
  assert.deepEqual({ ...last }, { state: "released", via: "limit" });
  // 別のセッションは数えない
  const other = await s.ask(S2);
  s.hold.answer(other.id, "deny", "web");
  await other.reply;
  // 1 分経てばまた保留する
  s.clock.now = BASE + 61_000;
  const again = await s.ask(S1);
  assert.equal(s.store.get(again.id)?.state, "pending");
  s.hold.answer(again.id, "deny", "web");
  await again.reply;
});

test("CC5a: request_hash が行と合わない操作は stale。無い id は not_found", async (t) => {
  const s = await setup(t);
  const asked = await s.ask(S1);
  const row = s.store.get(asked.id)!;
  assert.equal(row.requestHash, summarizePermission("Bash", { command: SECRET_COMMAND, description: "x" }, SECRET_CWD).requestHash);
  assert.deepEqual(s.hold.answer(asked.id, "allow", "web", "0".repeat(64)), { ok: false, reason: "stale" });
  assert.equal(s.store.get(asked.id)?.state, "pending");
  assert.deepEqual(s.hold.answer(asked.id + 100, "allow", "web"), { ok: false, reason: "not_found" });
  assert.deepEqual(s.hold.answer(asked.id, "allow", "web", row.requestHash), { ok: true, state: "allowed" });
  await asked.reply;
});

test("CC5a: pending か直近 60 秒に解決した行があるセッションの permission_prompt は判断待ちの元にならない（保留中は判断待ち）", async (t) => {
  const s = await setup(t, { agents: [agent(S1, { status: "idle", waitingFor: undefined }), agent(S2, { status: "idle", waitingFor: undefined })] });
  const stateOf = (id: string) => s.registry.snapshot().sessions.find((session) => session.sessionId === id)?.state;
  const asked = await s.ask(S1);
  // 保留中は（status が idle の読みでも）判断待ち
  assert.equal(stateOf(S1), "needs_input");
  await s.send({ hook_event_name: "Notification", session_id: S1, notification_type: "permission_prompt" });
  s.hold.answer(asked.id, "allow", "web");
  await asked.reply;
  // 解決した後、6 秒で来た permission_prompt は判断待ちの元にしない
  s.clock.now = BASE + 6_000;
  assert.equal(stateOf(S1), "idle");
  // 許可の要求の無いセッションの permission_prompt は判断待ち
  await s.send({ hook_event_name: "Notification", session_id: S2, notification_type: "permission_prompt" });
  assert.equal(stateOf(S2), "needs_input");
  // 60 秒を過ぎれば、残っている permission_prompt はまた判断待ちの元になる
  s.clock.now = BASE + 61_000;
  assert.equal(stateOf(S1), "needs_input");
});

test("CC5a: 保留中は一覧を 5 秒ごとに読む（それ以外は 60 秒）", async (t) => {
  const s = await setup(t);
  s.registry.start();
  await s.registry.idle();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(s.registryDelays.at(-1), CC_IDLE_POLL_MS);
  const asked = await s.ask(S1);
  // 受けたら 2 秒後に 1 回読み、その後は 5 秒ごと
  assert.equal(s.registryDelays.at(-1), CC_EVENT_REFRESH_MS);
  await s.fireRegistry();
  assert.equal(s.registryDelays.at(-1), CC_PERMISSION_POLL_MS);
  await s.fireRegistry();
  assert.equal(s.registryDelays.at(-1), CC_PERMISSION_POLL_MS);
  s.hold.answer(asked.id, "deny", "web");
  await asked.reply;
  await s.fireRegistry();
  assert.equal(s.registryDelays.at(-1), CC_IDLE_POLL_MS);
  s.registry.stop();
});

test("CC5a: 一覧に無いセッションの要求の log は 60 秒に 1 回まで", async (t) => {
  const s = await setup(t);
  const line = "Claude Code: 一覧に無いセッションの許可の要求は保留しませんでした";
  const count = () => s.logs.filter((l) => l === line).length;
  await s.send(permissionBody(S9));
  await s.send(permissionBody(S9));
  assert.equal(count(), 1);
  s.clock.now = BASE + CC_PERMISSION_UNKNOWN_LOG_INTERVAL_MS - 1;
  await s.send(permissionBody(S9));
  assert.equal(count(), 1);
  s.clock.now = BASE + CC_PERMISSION_UNKNOWN_LOG_INTERVAL_MS;
  await s.send(permissionBody(S9));
  assert.equal(count(), 2);
});

test("CC5a: 一覧への反映（receiver）が投げても、Stop で保留中の要求は閉じる", async (t) => {
  const db = tempDb(t);
  const now = (): Date => new Date(BASE);
  const store = new CcPermissionStore(db, now);
  const hold = new CcPermissionHold({ cfg: { ccPermissionHoldSec: 300, ccQuestionHoldSec: 900 }, store, known: () => true, now, timers: { after: () => () => undefined }, log: () => undefined });
  const server = createCcHookServer({
    host: "127.0.0.1",
    port: 0,
    token: TOKEN,
    receiver: {
      receive: (event) => {
        if (event.event === "Stop") throw new Error("boom");
      },
    },
    permissions: hold,
    now,
    log: () => undefined,
  });
  await server.start();
  t.after(() => server.close());
  const port = server.address()!.port;
  const asked = post(port, permissionBody(S1));
  await until(() => store.pendingFor(S1) !== undefined, "pending の行");
  const id = store.pendingFor(S1)!.id;
  const stop = await post(port, { hook_event_name: "Stop", session_id: S1 }).reply;
  assert.equal(stop.status, 200);
  assert.equal((await asked.reply).body, "");
  assert.equal(store.get(id)?.state, "answered_elsewhere");
});

test("CC5a: log は番号・状態・経路だけで、コマンド・cwd・セッションの ID を出さない", async (t) => {
  const s = await setup(t);
  const asked = await s.ask(S1);
  s.hold.answer(asked.id, "allow", "web");
  await asked.reply;
  await s.send(permissionBody(S9));
  const text = s.logs.join("\n");
  assert.ok(text.includes(`Claude Code: 許可の要求（#${asked.id}）→ allowed（web）`));
  for (const secret of [SECRET_COMMAND, SECRET_CWD, S1, S9, "secret-name"]) assert.ok(!text.includes(secret), secret);
});

test("CcPermissionHold.recover: 再起動の前に pending で残った行は expired", (t) => {
  const db = tempDb(t);
  const store = new CcPermissionStore(db, () => new Date(BASE));
  const row = store.add({ sessionId: S1, requestHash: "h", toolName: "Bash", summary: "x", permissionMode: null, state: "pending" });
  const logs: string[] = [];
  const hold = new CcPermissionHold({ cfg: { ccPermissionHoldSec: 300, ccQuestionHoldSec: 900 }, store, known: () => true, now: () => new Date(BASE), log: (l) => logs.push(l) });
  hold.recover();
  assert.equal(store.get(row.id)?.state, "expired");
  assert.equal(logs.length, 1);
});

test("CcPermissionStore: 1 セッションに pending は 1 件（部分一意索引）・compare-and-set・30 日の prune（pending は消さない）", (t) => {
  const db = tempDb(t);
  const clock = { now: BASE };
  const store = new CcPermissionStore(db, () => new Date(clock.now));
  const fields = { sessionId: S1, requestHash: "h", toolName: "Bash", summary: "x", permissionMode: "default" };
  const first = store.add({ ...fields, state: "pending" });
  assert.throws(() => store.add({ ...fields, state: "pending" }));
  // pending でない行は同じセッションに何件でも
  const released = store.add({ ...fields, state: "released", via: "limit" });
  assert.ok(released.resolvedAt !== null);
  store.add({ ...fields, sessionId: S2, state: "pending" });
  assert.equal(store.countPending(), 2);
  assert.equal(store.resolve(first.id, "allowed", "web"), true);
  assert.equal(store.resolve(first.id, "denied", "web"), false);
  assert.equal(store.get(first.id)?.state, "allowed");
  const second = store.add({ ...fields, state: "pending" });
  assert.equal(store.pendingFor(S1)?.id, second.id);
  assert.equal(store.countSince(S1, new Date(BASE)), 3);
  // CHECK
  assert.throws(() => db.prepare("UPDATE cc_permissions SET state = 'sent' WHERE id = ?").run(first.id));
  assert.throws(() => db.prepare("UPDATE cc_permissions SET via = 'rc' WHERE id = ?").run(first.id));
  // 30 日の prune: 終わった行だけ消す
  clock.now = BASE + 31 * 24 * 60 * 60 * 1000;
  const deleted = store.prune(new Date(clock.now - 30 * 24 * 60 * 60 * 1000));
  assert.equal(deleted, 2);
  assert.equal(store.listPending().length, 2);
});

test("openDb: v29 の DB を v30 に上げても cc_sends は残り、cc_permissions は空で作られる", (t) => {
  const dir = tempDir(t);
  const path = join(dir, "self-agent.db");
  const before = 29;
  const old = new DatabaseSync(path);
  for (const migration of MIGRATIONS.slice(0, before)) old.exec(migration);
  old.exec(`PRAGMA user_version = ${before}`);
  old.exec("INSERT INTO cc_sends (text, origin, state, created_at, updated_at) VALUES ('x', 'web', 'queued', 'a', 'a')");
  old.close();
  const db = openDb(path);
  t.after(() => db.close());
  assert.equal(db.prepare("PRAGMA user_version").get()?.user_version, MIGRATIONS.length);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM cc_sends").get()?.n, 1);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM cc_permissions").get()?.n, 0);
  assert.ok(MIGRATIONS.length >= 30);
});

// ----- CC5b: このセッションでは常に許可 -----

/** 実機の npm test の提案（addRules・destination localSettings）に、使わない提案（deny・ほかのツール・addDirectories・setMode）を混ぜたもの */
const NPM_TEST_SUGGESTIONS: unknown[] = [
  { type: "addRules", rules: [{ toolName: "Bash", ruleContent: "npm test *" }, { toolName: "Read", ruleContent: "src/**" }], behavior: "allow", destination: "localSettings" },
  { type: "addRules", rules: [{ toolName: "Bash", ruleContent: "npm run build *" }], behavior: "deny", destination: "userSettings" },
  { type: "addDirectories", directories: ["/tmp/x"], destination: "session" },
  { type: "setMode", mode: "acceptEdits", destination: "session" },
];

test("CC5b: [常に許可] は updatedPermissions が addRules・allow・session の 1 件（localSettings は session に、deny・ほかのツール・addDirectories・setMode は落ちる）", async (t) => {
  const s = await setup(t);
  const asked = await s.ask(S1, "npm test", NPM_TEST_SUGGESTIONS);
  // 線引きを通ったルールだけを行に残す
  assert.deepEqual(s.store.get(asked.id)?.alwaysRules, [{ toolName: "Bash", ruleContent: "npm test *" }]);
  assert.deepEqual(s.hold.answer(asked.id, "always", "web"), { ok: true, state: "allowed_always" });
  const reply = await asked.reply;
  assert.equal(reply.status, 200);
  assert.deepEqual(JSON.parse(reply.body), {
    hookSpecificOutput: {
      hookEventName: "PermissionRequest",
      decision: {
        behavior: "allow",
        updatedPermissions: [
          { type: "addRules", rules: [{ toolName: "Bash", ruleContent: "npm test *" }], behavior: "allow", destination: "session" },
        ],
      },
    },
  });
  for (const word of ["localSettings", "userSettings", "projectSettings", "addDirectories", "setMode", "deny", "updatedInput"]) {
    assert.ok(!reply.body.includes(word), word);
  }
  const row = s.store.get(asked.id)!;
  assert.equal(row.state, "allowed_always");
  assert.equal(row.via, "web");
  // 1 行に応答は 1 回
  assert.deepEqual(s.hold.answer(asked.id, "always", "web"), { ok: false, reason: "stale" });
  assert.deepEqual(s.hold.answer(asked.id, "allow", "web"), { ok: false, reason: "stale" });
  assert.ok(s.logs.some((line) => line === `Claude Code: 許可の要求（#${asked.id}）→ allowed_always（web）`));
  // log にルール・コマンドは出ない
  assert.ok(!s.logs.join("\n").includes("npm test"));
});

test("CC5b: 提案が無い・線引きで残らない要求の always は stale（保留は続き、[許可] は押せる）", async (t) => {
  const s = await setup(t);
  // addDirectories・setMode だけ（touch の実機の形）
  const touch = await s.ask(S1, "touch x", [
    { type: "addDirectories", directories: ["/tmp/x"], destination: "session" },
    { type: "setMode", mode: "acceptEdits", destination: "session" },
  ]);
  assert.equal(s.store.get(touch.id)?.alwaysRules, null);
  assert.deepEqual(s.hold.answer(touch.id, "always", "web"), { ok: false, reason: "stale" });
  assert.equal(s.store.get(touch.id)?.state, "pending");
  assert.deepEqual(s.hold.answer(touch.id, "allow", "web"), { ok: true, state: "allowed" });
  assert.equal(JSON.parse((await touch.reply).body).hookSpecificOutput.decision.updatedPermissions, undefined);
  // 広い・危ない Bash のルールだけ
  for (const ruleContent of ["rm *", "rm:*", "*", " *", ":*", "npm test | tee x *"]) {
    const asked = await s.ask(S1, "x", [{ type: "addRules", rules: [{ toolName: "Bash", ruleContent }], behavior: "allow", destination: "localSettings" }]);
    assert.equal(s.store.get(asked.id)?.alwaysRules, null, ruleContent);
    assert.deepEqual(s.hold.answer(asked.id, "always", "web"), { ok: false, reason: "stale" }, ruleContent);
    s.hold.answer(asked.id, "deny", "web");
    await asked.reply;
  }
});

test("CC5b: 常に許可の内容は押した時点の DB の行のルールから作る", async (t) => {
  const s = await setup(t);
  const asked = await s.ask(S1, "npm test", NPM_TEST_SUGGESTIONS);
  s.db.prepare("UPDATE cc_permissions SET always_rules = ? WHERE id = ?").run('[{"toolName":"Bash","ruleContent":"npm run lint"}]', asked.id);
  assert.deepEqual(s.hold.answer(asked.id, "always", "web"), { ok: true, state: "allowed_always" });
  const decision = JSON.parse((await asked.reply).body).hookSpecificOutput.decision;
  assert.deepEqual(decision.updatedPermissions[0].rules, [{ toolName: "Bash", ruleContent: "npm run lint" }]);
  assert.equal(decision.updatedPermissions[0].destination, "session");
});

test("decisionBody: always は allow + session の updatedPermissions", () => {
  const body = JSON.parse(decisionBody("always", [{ toolName: "Bash", ruleContent: "npm test *" }]));
  assert.equal(body.hookSpecificOutput.decision.behavior, "allow");
  assert.equal(body.hookSpecificOutput.decision.updatedPermissions.length, 1);
  assert.equal(body.hookSpecificOutput.decision.updatedPermissions[0].destination, "session");
});

test("openDb: always_rules の列を足す版で、前の行は残り always_rules は NULL", (t) => {
  const dir = tempDir(t);
  const path = join(dir, "self-agent.db");
  const before = MIGRATIONS.findIndex((migration) => migration.includes("ADD COLUMN always_rules"));
  assert.ok(before > 0);
  const old = new DatabaseSync(path);
  for (const migration of MIGRATIONS.slice(0, before)) old.exec(migration);
  old.exec(`PRAGMA user_version = ${before}`);
  old.exec(
    `INSERT INTO cc_permissions (session_id, request_hash, tool_name, summary, state, created_at) VALUES ('${S1}', 'h', 'Bash', 's', 'allowed', 'a')`,
  );
  old.close();
  const db = openDb(path);
  t.after(() => db.close());
  assert.equal(db.prepare("PRAGMA user_version").get()?.user_version, MIGRATIONS.length);
  const row = new CcPermissionStore(db).get(1)!;
  assert.equal(row.state, "allowed");
  assert.equal(row.alwaysRules, null);
});

// ----- Q1: 質問（AskUserQuestion） -----

const SECRET_QUESTION = "secret-question: どの色にしますか？";
const QUESTION_INPUT = {
  questions: [
    { question: SECRET_QUESTION, header: "Color", options: [{ label: "red", description: "赤" }, { label: "blue", description: "青" }], multiSelect: false },
    { question: "どれを入れますか？", header: "Parts", options: [{ label: "a", description: "" }, { label: "b", description: "" }, { label: "c", description: "" }], multiSelect: true },
  ],
};

function questionBody(sessionId: string, input: unknown = QUESTION_INPUT): Record<string, unknown> {
  return {
    hook_event_name: "PermissionRequest",
    session_id: sessionId,
    cwd: SECRET_CWD,
    permission_mode: "default",
    tool_name: "AskUserQuestion",
    tool_input: input,
    permission_suggestions: [],
  };
}

/** 質問を受け口に送り、pending の行ができるまで待つ */
async function askQuestion(s: Awaited<ReturnType<typeof setup>>, sessionId: string, input: unknown = QUESTION_INPUT) {
  const before = s.store.pendingFor(sessionId)?.id;
  const sent = post(s.port, questionBody(sessionId, input));
  await until(() => {
    const row = s.store.pendingFor(sessionId);
    return row !== undefined && row.id !== before;
  }, "pending の行");
  return { ...sent, id: s.store.pendingFor(sessionId)!.id };
}

test("Q1: AskUserQuestion は question_input に tool_input の JSON そのままを持ち、answerQuestion で allow + updatedInput（tool_input + answers）を返す", async (t) => {
  const s = await setup(t, { holdSec: 300, questionHoldSec: 900 });
  const asked = await askQuestion(s, S1);
  const row = s.store.get(asked.id)!;
  assert.equal(row.toolName, "AskUserQuestion");
  assert.equal(row.questionInput, JSON.stringify(QUESTION_INPUT));
  assert.equal(row.summary, `質問 2 問: ${SECRET_QUESTION}`);
  // 保留の長さは SELF_AGENT_CC_QUESTION_HOLD_SEC
  assert.equal(s.holdTimers.at(-1)!.ms, 900_000);
  assert.equal(permissionExpiresAt(row, 300, 900), new Date(BASE + 900_000).toISOString());
  // 質問に [許可]・[常に許可] は効かない（答えは answerQuestion）
  assert.deepEqual(s.hold.answer(asked.id, "allow", "web"), { ok: false, reason: "stale" });
  assert.deepEqual(s.hold.answer(asked.id, "always", "web"), { ok: false, reason: "stale" });
  // hash 違いは stale、問に合わない答えは invalid（どちらも行は pending のまま）
  assert.deepEqual(s.hold.answerQuestion(asked.id, "0".repeat(64), [{ labels: ["red"] }, { labels: ["a"] }], "web"), { ok: false, reason: "stale" });
  assert.deepEqual(s.hold.answerQuestion(asked.id, row.requestHash, [{ labels: ["red"] }], "web"), { ok: false, reason: "invalid" });
  assert.deepEqual(s.hold.answerQuestion(asked.id, row.requestHash, [{ labels: ["red", "blue"] }, { labels: ["a"] }], "web"), {
    ok: false,
    reason: "invalid",
  });
  assert.deepEqual(s.hold.answerQuestion(asked.id, row.requestHash, [{ labels: ["green"] }, { labels: ["a"] }], "web"), { ok: false, reason: "invalid" });
  assert.deepEqual(s.hold.answerQuestion(asked.id + 9, row.requestHash, [], "web"), { ok: false, reason: "not_found" });
  assert.equal(s.store.get(asked.id)?.state, "pending");
  // 複数選択は選択肢の順に ", " でつなぐ
  assert.deepEqual(s.hold.answerQuestion(asked.id, row.requestHash, [{ labels: ["blue"] }, { labels: ["c", "a"] }], "discord"), {
    ok: true,
    state: "allowed",
  });
  const reply = await asked.reply;
  assert.equal(reply.status, 200);
  const answers = { [SECRET_QUESTION]: "blue", "どれを入れますか？": "a, c" };
  assert.deepEqual(JSON.parse(reply.body), {
    hookSpecificOutput: { hookEventName: "PermissionRequest", decision: { behavior: "allow", updatedInput: { ...QUESTION_INPUT, answers } } },
  });
  const done = s.store.get(asked.id)!;
  assert.equal(done.state, "allowed");
  assert.equal(done.via, "discord");
  assert.deepEqual(done.answers, answers);
  assert.equal(permissionExpiresAt(done, 300, 900), null);
  // 2 回目は stale
  assert.deepEqual(s.hold.answerQuestion(asked.id, row.requestHash, [{ labels: ["red"] }, { labels: ["a"] }], "web"), { ok: false, reason: "stale" });
  // log は「質問（#id）」と状態・経路だけ（問の文・答えは出さない）
  assert.ok(s.logs.includes(`Claude Code: 質問（#${asked.id}）→ allowed（discord）`));
  assert.ok(!s.logs.join("\n").includes("secret-question"));
  assert.ok(!s.logs.join("\n").includes("blue"));
});

test("Q1: 質問の「その他」は打った文字列（改行以外の制御文字は空白・前後の空白を除く）。空・1,000 字超は invalid", async (t) => {
  const s = await setup(t);
  const asked = await askQuestion(s, S1);
  const hash = s.store.get(asked.id)!.requestHash;
  assert.deepEqual(s.hold.answerQuestion(asked.id, hash, [{ other: "   " }, { labels: ["a"] }], "web"), { ok: false, reason: "invalid" });
  assert.deepEqual(s.hold.answerQuestion(asked.id, hash, [{ other: "x".repeat(1001) }, { labels: ["a"] }], "web"), { ok: false, reason: "invalid" });
  assert.deepEqual(s.hold.answerQuestion(asked.id, hash, [{ other: "  緑\tにして\n ください " }, { labels: ["b"] }], "web"), { ok: true, state: "allowed" });
  const body = JSON.parse((await asked.reply).body);
  assert.deepEqual(body.hookSpecificOutput.decision.updatedInput.answers, { [SECRET_QUESTION]: "緑 にして\n ください", "どれを入れますか？": "b" });
});

test("Q1: 質問の [やめる] は deny + 「断りました」（interrupt なし）。押さずに保留が切れたら空の本文（自動の allow は無い）", async (t) => {
  const s = await setup(t);
  const asked = await askQuestion(s, S1);
  assert.deepEqual(s.hold.answer(asked.id, "deny", "web"), { ok: true, state: "denied" });
  const json = JSON.parse((await asked.reply).body);
  assert.deepEqual(json, {
    hookSpecificOutput: { hookEventName: "PermissionRequest", decision: { behavior: "deny", message: CC_QUESTION_DENY_MESSAGE } },
  });
  assert.equal(s.store.get(asked.id)?.answers, null);
  // 押さなければ時間切れで空の本文
  const second = await askQuestion(s, S1);
  s.holdTimers.at(-1)!.fn();
  const reply = await second.reply;
  assert.equal(reply.body, "");
  assert.equal(s.store.get(second.id)?.state, "expired");
});

test("Q1: 形の読めない AskUserQuestion は今までどおりの許可の要求（question_input は NULL・保留は許可の長さ・[許可] は効く）", async (t) => {
  const s = await setup(t, { holdSec: 300, questionHoldSec: 900 });
  const asked = await askQuestion(s, S1, { questions: [{ question: "q", options: [{ label: "only" }] }] });
  const row = s.store.get(asked.id)!;
  assert.equal(row.questionInput, null);
  assert.equal(s.holdTimers.at(-1)!.ms, 300_000);
  assert.deepEqual(s.hold.answerQuestion(asked.id, row.requestHash, [{ labels: ["only"] }], "web"), { ok: false, reason: "stale" });
  assert.deepEqual(s.hold.answer(asked.id, "deny", "web"), { ok: true, state: "denied" });
  assert.equal(JSON.parse((await asked.reply).body).hookSpecificOutput.decision.message, CC_PERMISSION_DENY_MESSAGE);
});

test("decisionBody: question は allow + updatedInput（tool_input + answers）、質問の deny は「断りました」", () => {
  assert.deepEqual(JSON.parse(decisionBody("question", { questions: [], x: 1 }, { q: "a" })), {
    hookSpecificOutput: { hookEventName: "PermissionRequest", decision: { behavior: "allow", updatedInput: { questions: [], x: 1, answers: { q: "a" } } } },
  });
  assert.equal(JSON.parse(decisionBody("deny", { question: true })).hookSpecificOutput.decision.message, CC_QUESTION_DENY_MESSAGE);
  assert.equal(JSON.parse(decisionBody("deny", { question: false })).hookSpecificOutput.decision.message, CC_PERMISSION_DENY_MESSAGE);
});

test("openDb: v37 の DB を v38 に上げると cc_permissions に question_input・answers が足され、前の行は NULL", (t) => {
  const dir = tempDir(t);
  const path = join(dir, "self-agent.db");
  const before = MIGRATIONS.findIndex((migration) => migration.includes("ADD COLUMN question_input"));
  assert.equal(before, 37);
  const old = new DatabaseSync(path);
  for (const migration of MIGRATIONS.slice(0, before)) old.exec(migration);
  old.exec(`PRAGMA user_version = ${before}`);
  old.exec(
    `INSERT INTO cc_permissions (session_id, request_hash, tool_name, summary, state, created_at) VALUES ('${S1}', 'h', 'AskUserQuestion', 's', 'pending', 'a')`,
  );
  old.close();
  const db = openDb(path);
  t.after(() => db.close());
  assert.equal(db.prepare("PRAGMA user_version").get()?.user_version, MIGRATIONS.length);
  const store = new CcPermissionStore(db);
  const row = store.get(1)!;
  assert.equal(row.questionInput, null);
  assert.equal(row.answers, null);
  // answers は resolve と同じ UPDATE で書き、移せなければ書かない
  assert.equal(store.resolve(1, "allowed", "web", { q: "a" }), true);
  assert.deepEqual(store.get(1)!.answers, { q: "a" });
  assert.equal(store.resolve(1, "denied", "web", { q: "b" }), false);
  assert.deepEqual(store.get(1)!.answers, { q: "a" });
  // 形の違う answers は null で読む
  db.exec("UPDATE cc_permissions SET answers = '[1]' WHERE id = 1");
  assert.equal(store.get(1)!.answers, null);
});
