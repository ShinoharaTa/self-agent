import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { BoardCollector, type BoardTimers, boardCcSessions, classifyRow, BOARD_FIRST_DELAY_MS, BOARD_POLL_MS, NO_LIVE } from "../src/board/collect.ts";
import { BOARD_GIT_TIMEOUT_MS, createBoardGit, parseCommitTime, parsePorcelainStatus } from "../src/board/git.ts";
import { ciOfCheckRuns, cleanTitle, fetchBoardItems, parseIssueItem, parsePull } from "../src/board/github.ts";
import type { GhRequest, GhResponse } from "../src/github/gh.ts";
import { BOARD_MAX_PROJECTS, BoardStore } from "../src/store/board.ts";
import type { RunCommand } from "../src/tmux/tmux.ts";
import { tempDb, tempDir } from "./helpers/db.ts";

const SHA = "0123456789abcdef0123456789abcdef01234567";

test("BoardStore: add・開き直し・上限・remove・listActive・saveResult", (t) => {
  const db = tempDb(t);
  let clock = new Date("2026-11-13T00:00:00Z");
  const store = new BoardStore(db, () => clock);
  assert.equal(store.add("beta", "o/beta"), "added");
  assert.equal(store.add("alpha", null), "added");
  assert.equal(store.add("alpha", null), "exists");
  assert.deepEqual(
    store.listActive().map((row) => row.dir),
    ["alpha", "beta"],
  );
  assert.equal(store.remove("alpha"), true);
  assert.equal(store.remove("alpha"), false);
  assert.equal(store.get("alpha")?.removedAt, clock.toISOString());
  clock = new Date("2026-11-14T00:00:00Z");
  assert.equal(store.add("alpha", "o/alpha"), "reopened");
  const reopened = store.get("alpha")!;
  assert.equal(reopened.removedAt, null);
  assert.equal(reopened.repo, "o/alpha");
  assert.equal(reopened.addedAt, clock.toISOString());

  const item = { kind: "pr" as const, number: 3, title: "t", url: "https://github.com/o/beta/pull/3", mine: true, draft: false, ci: "success" as const };
  assert.equal(
    store.saveResult("beta", {
      repo: "o/beta",
      state: "owner",
      reasons: Array.from({ length: 10 }, (_, i) => `r${i}`),
      items: Array.from({ length: 90 }, () => item).slice(0, 40),
      local: { branch: "main", dirty: 1, ahead: 0, behind: 0, lastCommitAt: null },
      error: null,
      checkedAt: clock.toISOString(),
    }),
    true,
  );
  let row = store.get("beta")!;
  assert.equal(row.state, "owner");
  assert.equal(row.reasons?.length, 8);
  assert.equal(row.items?.length, 40);
  assert.deepEqual(row.capped, { pulls: false, issues: false });
  assert.deepEqual(row.local, { branch: "main", dirty: 1, ahead: 0, behind: 0, lastCommitAt: null });
  // items・local を省けば前のまま
  store.saveResult("beta", { repo: "o/beta", state: "unknown", reasons: [], error: "rate_limited", checkedAt: clock.toISOString() });
  row = store.get("beta")!;
  assert.equal(row.items?.length, 40);
  assert.equal(row.error, "rate_limited");
  // 80 件まで残し、上限の印も items と一緒に書く
  store.saveResult("beta", {
    repo: "o/beta",
    state: "agent",
    reasons: [],
    items: Array.from({ length: 90 }, () => item),
    capped: { pulls: true, issues: true },
    error: null,
    checkedAt: clock.toISOString(),
  });
  row = store.get("beta")!;
  assert.equal(row.items?.length, 80);
  assert.deepEqual(row.capped, { pulls: true, issues: true });
  // 外したものには書かない
  store.remove("beta");
  assert.equal(store.saveResult("beta", { repo: null, state: "done", reasons: [], error: null, checkedAt: clock.toISOString() }), false);

  for (let i = 0; store.countActive() < BOARD_MAX_PROJECTS; i++) store.add(`p${i}`, null);
  assert.equal(store.add("one-more", null), "limit");
  assert.equal(store.add("beta", null), "limit");
});

test("parsePorcelainStatus: ブランチ・ahead・behind・変更の数", () => {
  const out = [
    "# branch.oid 0123",
    "# branch.head feature/x",
    "# branch.upstream origin/feature/x",
    "# branch.ab +2 -1",
    "1 .M N... 100644 100644 100644 a b src/a.ts",
    "? new.txt",
    "",
  ].join("\n");
  assert.deepEqual(parsePorcelainStatus(out), { branch: "feature/x", dirty: 2, ahead: 2, behind: 1 });
  assert.deepEqual(parsePorcelainStatus("# branch.oid (initial)\n# branch.head (detached)\n"), { branch: null, dirty: 0, ahead: 0, behind: 0 });
  assert.equal(parseCommitTime("1763000000\n"), "2025-11-13T02:13:20.000Z");
  assert.equal(parseCommitTime("x"), null);
});

test("createBoardGit: 固定の引数・env・10 秒。origin が無い・GitHub でないのは none、失敗は failed", async () => {
  const calls: Array<{ args: readonly string[]; env: Record<string, string>; timeoutMs: number }> = [];
  const replies: Record<string, { code: number | null; stdout: string }> = {
    config: { code: 0, stdout: "git@github.com:Owner/Repo.git\n" },
    status: { code: 0, stdout: "# branch.head main\n" },
    log: { code: 128, stdout: "" },
  };
  const run: RunCommand = async (_file, args, options) => {
    calls.push({ args, env: options.env, timeoutMs: options.timeoutMs });
    const reply = replies[args.find((arg) => arg in replies)!]!;
    return { ...reply, stderr: "" };
  };
  const git = createBoardGit({ gitPath: "/usr/bin/git", run });
  assert.deepEqual(await git.remote("/w/p"), { kind: "ok", repo: "owner/repo" });
  assert.deepEqual(await git.local("/w/p"), { branch: "main", dirty: 0, ahead: 0, behind: 0, lastCommitAt: null });
  assert.deepEqual(calls[0]!.args, ["-C", "/w/p", "config", "--local", "--get", "remote.origin.url"]);
  const readOnly = ["-c", "core.fsmonitor=false", "-c", "core.untrackedCache=false"];
  assert.deepEqual(calls[1]!.args, ["-C", "/w/p", ...readOnly, "status", "--porcelain=v2", "--branch"]);
  assert.deepEqual(calls[2]!.args, ["-C", "/w/p", ...readOnly, "log", "-1", "--format=%ct"]);
  assert.equal(calls[0]!.env.GIT_OPTIONAL_LOCKS, "0");
  assert.deepEqual(Object.keys(calls[0]!.env).sort(), ["GIT_OPTIONAL_LOCKS", "HOME", "LANG", "PATH"]);
  assert.equal(calls[0]!.timeoutMs, BOARD_GIT_TIMEOUT_MS);
  replies.config = { code: 1, stdout: "" };
  assert.deepEqual(await git.remote("/w/p"), { kind: "none" });
  replies.config = { code: 0, stdout: "https://gitlab.com/o/r.git\n" };
  assert.deepEqual(await git.remote("/w/p"), { kind: "none" });
  replies.config = { code: 128, stdout: "" };
  assert.deepEqual(await git.remote("/w/p"), { kind: "failed" });
  replies.status = { code: null, stdout: "" };
  assert.equal(await git.local("/w/p"), undefined);
  assert.throws(() => createBoardGit({ gitPath: "git" }));
});

test("parsePull・parseIssueItem: 形を確かめ、URL は組み立て、題名は 200 字で改行を空白に", () => {
  const pull = parsePull(
    { number: 12, title: "a\nb", user: { login: "Me" }, draft: true, head: { sha: SHA }, html_url: "https://evil.example/" },
    "o",
    "r",
    "me",
  );
  assert.deepEqual(pull, {
    item: { kind: "pr", number: 12, title: "a b", url: "https://github.com/o/r/pull/12", mine: true, draft: true, ci: "unchecked" },
    sha: SHA,
  });
  assert.equal(parsePull({ number: "12", title: "x", user: { login: "me" } }, "o", "r", "me"), undefined);
  assert.equal(parsePull({ number: 1, title: "x", user: {} }, "o", "r", "me"), undefined);
  assert.equal(parsePull({ number: 1, title: "x", user: { login: "me" }, head: { sha: "main" } }, "o", "r", "me")?.sha, undefined);
  assert.equal(parseIssueItem({ number: 3, title: "x", pull_request: {} }, "o", "r", "me"), undefined);
  assert.equal(parseIssueItem({ number: 3, title: "x", user: { login: "other" } }, "o", "r", "me")?.url, "https://github.com/o/r/issues/3");
  assert.equal([...cleanTitle("あ".repeat(300))].length, 200);
});

test("ciOfCheckRuns: failure・pending・success・none", () => {
  const run = (status: string, conclusion: string | null) => ({ status, conclusion });
  assert.equal(ciOfCheckRuns({ total_count: 0, check_runs: [] }), "none");
  assert.equal(ciOfCheckRuns({ check_runs: [run("completed", "success"), run("completed", "skipped"), run("completed", "neutral")] }), "success");
  assert.equal(ciOfCheckRuns({ check_runs: [run("completed", "success"), run("in_progress", null)] }), "pending");
  for (const conclusion of ["failure", "timed_out", "cancelled", "action_required"]) {
    assert.equal(ciOfCheckRuns({ check_runs: [run("in_progress", null), run("completed", conclusion)] }), "failure", conclusion);
  }
  // 知らない conclusion は決められないので pending
  assert.equal(ciOfCheckRuns({ check_runs: [run("completed", "stale")] }), "pending");
  assert.equal(ciOfCheckRuns({ check_runs: [{}] }), undefined);
  assert.equal(ciOfCheckRuns([]), undefined);
});

type Fake = { calls: string[]; get(request: GhRequest): Promise<GhResponse> };

function fakeGh(routes: Record<string, unknown | GhResponse>, headers: Record<string, string> = {}): Fake {
  const calls: string[] = [];
  return {
    calls,
    get: async (request) => {
      calls.push(request.path);
      const base = request.path.split("?")[0]!;
      const value = Object.hasOwn(routes, request.path) ? routes[request.path] : routes[base];
      if (value === undefined) return { kind: "http_error", status: 404, headers };
      if (typeof value === "object" && value !== null && "kind" in value) return value as GhResponse;
      return { kind: "ok", status: 200, headers, body: JSON.stringify(value) };
    },
  };
}

test("fetchBoardItems: PR → issue、check-runs は自分の draft でない PR を 5 件まで（残りは unchecked）、失敗の種類", async () => {
  const pulls: Array<Record<string, unknown>> = Array.from({ length: 7 }, (_, i) => ({ number: i + 1, title: `p${i}`, user: { login: "me" }, head: { sha: SHA } }));
  pulls.unshift({ number: 40, title: "draft", user: { login: "me" }, draft: true, head: { sha: SHA } });
  pulls.push({ number: 41, title: "no sha", user: { login: "me" } });
  pulls.push({ number: 50, title: "other", user: { login: "other" }, head: { sha: SHA } });
  const gh = fakeGh({
    "/repos/o/r/pulls": pulls,
    "/repos/o/r/issues": [{ number: 9, title: "i", user: { login: "x" } }, { number: 1, title: "pr", pull_request: {} }],
    [`/repos/o/r/commits/${SHA}/check-runs`]: { check_runs: [{ status: "completed", conclusion: "failure" }] },
  });
  const result = await fetchBoardItems(gh, "o/r", "me", () => {});
  assert.equal(result.kind, "ok");
  if (result.kind !== "ok") return;
  assert.deepEqual(
    result.items.map((item) => `${item.kind}#${item.number}:${item.ci}`),
    [
      "pr#40:unchecked",
      "pr#1:failure",
      "pr#2:failure",
      "pr#3:failure",
      "pr#4:failure",
      "pr#5:failure",
      "pr#6:unchecked",
      "pr#7:unchecked",
      "pr#41:unchecked",
      "pr#50:none",
      "issue#9:none",
    ],
  );
  assert.equal(gh.calls.filter((path) => path.includes("check-runs")).length, 5);
  assert.deepEqual(result.capped, { pulls: false, issues: false });
  // 1 ページの上限まで取れたら capped
  const full = await fetchBoardItems(
    fakeGh({
      "/repos/o/r/pulls": Array.from({ length: 30 }, (_, i) => ({ number: i + 1, title: "p", user: { login: "x" } })),
      "/repos/o/r/issues": Array.from({ length: 50 }, (_, i) => ({ number: i + 100, title: "i", user: { login: "x" } })),
    }),
    "o/r",
    "me",
    () => {},
  );
  assert.equal(full.kind, "ok");
  if (full.kind === "ok") assert.deepEqual(full.capped, { pulls: true, issues: true });
  assert.deepEqual(await fetchBoardItems(fakeGh({}), "o/r", "me", () => {}), { kind: "not_found" });
  assert.deepEqual(
    await fetchBoardItems(fakeGh({ "/repos/o/r/pulls": { kind: "rate_limited", status: 403, headers: {} } }), "o/r", "me", () => {}),
    { kind: "rate_limited" },
  );
  assert.deepEqual(await fetchBoardItems(fakeGh({ "/repos/o/r/pulls": { x: 1 } }), "o/r", "me", () => {}), { kind: "failed" });
  assert.deepEqual(await fetchBoardItems(fakeGh({}), "bad", "me", () => {}), { kind: "failed" });
});

test("boardCcSessions: cwd がプロジェクトの dir かその中のものだけ", (t) => {
  const root = realpathSync(tempDir(t));
  const project = join(root, "proj");
  mkdirSync(join(project, "wt"), { recursive: true });
  mkdirSync(join(root, "proj2"));
  const view = (sessionId: string, cwd: string | undefined) => ({ sessionId, cwd, state: "running" as const, pendingPermission: false });
  const found = boardCcSessions([view("a", project), view("b", join(project, "wt")), view("c", join(root, "proj2")), view("d", undefined)], project);
  assert.deepEqual(
    found.map((session) => session.sessionId),
    ["a", "b"],
  );
});

function fakeTimers(): BoardTimers & { pending: Array<{ fn: () => void; ms: number }> } {
  const pending: Array<{ fn: () => void; ms: number }> = [];
  return {
    pending,
    after: (fn, ms) => {
      const entry = { fn, ms };
      pending.push(entry);
      return () => pending.splice(pending.indexOf(entry), 1);
    },
  };
}

function setupCollector(t: Parameters<typeof tempDb>[0], ghRoutes: Record<string, unknown>, headers: Record<string, string> = {}) {
  const db = tempDb(t);
  const store = new BoardStore(db, () => new Date("2026-11-13T00:00:00Z"));
  const workspace = realpathSync(tempDir(t));
  mkdirSync(join(workspace, "alpha"));
  mkdirSync(join(workspace, "beta"));
  const remotes: Record<string, string | null> = { alpha: "o/alpha", beta: null };
  const git = {
    remote: async (dir: string) => {
      const repo = remotes[dir.split("/").pop()!];
      return repo === null || repo === undefined ? ({ kind: "none" } as const) : ({ kind: "ok", repo } as const);
    },
    local: async () => ({ branch: "main", dirty: 0, ahead: 0, behind: 0, lastCommitAt: null }),
  };
  // 同じ物を渡す（テストが後から道を消せるように）
  const gh = fakeGh(Object.assign(ghRoutes, { "/user": { login: "me" } }), headers);
  const logs: string[] = [];
  const timers = fakeTimers();
  const collector = new BoardCollector({
    store,
    places: { workspaceDir: workspace, protectedDirs: [] },
    git,
    gh,
    live: () => NO_LIVE,
    now: () => new Date("2026-11-13T00:00:00Z"),
    timers,
    log: (message) => logs.push(message),
  });
  return { store, collector, gh, logs, timers, remotes };
}

test("BoardCollector: 名前の順に確かめて書き、件数が変わったときだけ log（名前・リポジトリは出さない）", async (t) => {
  const { store, collector, logs } = setupCollector(t, {
    "/repos/o/alpha/pulls": [{ number: 4, title: "x", user: { login: "someone" } }],
    "/repos/o/alpha/issues": [],
  });
  store.add("beta", null);
  store.add("alpha", "o/alpha");
  await collector.tick();
  assert.equal(store.get("alpha")?.state, "owner");
  assert.deepEqual(store.get("alpha")?.reasons, ["レビュー待ちの PR #4"]);
  assert.equal(store.get("beta")?.state, "unknown");
  assert.equal(store.get("beta")?.error, "no_remote");
  assert.deepEqual(logs, ["board: 2 件を確かめました（owner 1・agent 0・working 0・done 0・unknown 1）", "board: 確かめられなかったもの（no_remote 1）"]);
  await collector.tick();
  assert.equal(logs.length, 2);
  assert.ok(logs.every((line) => !line.includes("alpha") && !line.includes("o/")));
});

test("BoardCollector: レート制限の残りが 1,000 未満なら GitHub を取らず rate_limited で前回の items を残す", async (t) => {
  const reset = String(Math.floor(new Date("2026-11-13T01:00:00Z").getTime() / 1000));
  const { store, collector, gh } = setupCollector(
    t,
    { "/repos/o/alpha/pulls": [], "/repos/o/alpha/issues": [{ number: 2, title: "i", user: { login: "x" } }] },
    { "x-ratelimit-remaining": "999", "x-ratelimit-reset": reset },
  );
  store.add("alpha", "o/alpha");
  await collector.tick();
  // /user で残りが分かったので、その回の GitHub は取らない
  assert.deepEqual(gh.calls, ["/user"]);
  assert.equal(store.get("alpha")?.error, "rate_limited");
  assert.equal(store.get("alpha")?.items, null);
  assert.equal(store.get("alpha")?.state, "unknown");
});

test("BoardCollector: start は 30 秒後、以後 15 分ごと。refresh は回っている回の後にもう 1 回。stop で止まる", async (t) => {
  const { store, collector, timers, gh } = setupCollector(t, { "/repos/o/alpha/pulls": [], "/repos/o/alpha/issues": [] });
  store.add("alpha", "o/alpha");
  collector.start();
  assert.equal(timers.pending.length, 1);
  assert.equal(timers.pending[0]!.ms, BOARD_FIRST_DELAY_MS);
  timers.pending.shift()!.fn();
  await collector.idle();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(timers.pending[0]?.ms, BOARD_POLL_MS);
  assert.equal(store.get("alpha")?.state, "done");
  const before = gh.calls.length;
  const first = collector.tick();
  const again = collector.refresh();
  const merged = collector.refresh();
  assert.equal(again, merged);
  await Promise.all([first, again]);
  // 2 回分（/user は最初の回だけ）
  assert.equal(gh.calls.length - before, 4);
  collector.stop();
  assert.equal(timers.pending.length, 0);
  await collector.refresh();
  assert.equal(gh.calls.length - before, 4);
});

test("BoardCollector: issue が上限なら「n 件以上」で、書いた行から決め直しても同じ根拠の行", async (t) => {
  const { store, collector } = setupCollector(t, {
    "/repos/o/alpha/pulls": [],
    "/repos/o/alpha/issues": Array.from({ length: 50 }, (_, i) => ({ number: i + 1, title: "i", user: { login: "x" } })),
  });
  store.add("alpha", "o/alpha");
  await collector.tick();
  const row = store.get("alpha")!;
  assert.deepEqual(row.reasons, ["手つかずの issue 50 件以上"]);
  assert.equal(row.items?.length, 50);
  assert.deepEqual(classifyRow(row, NO_LIVE).reasons, row.reasons);
});

test("BoardCollector: リポジトリが見つからなければ前回の items を捨てる", async (t) => {
  const routes: Record<string, unknown> = {
    "/repos/o/alpha/pulls": [{ number: 4, title: "x", user: { login: "someone" } }],
    "/repos/o/alpha/issues": [],
  };
  const { store, collector } = setupCollector(t, routes);
  store.add("alpha", "o/alpha");
  await collector.tick();
  assert.equal(store.get("alpha")?.items?.length, 1);
  delete routes["/repos/o/alpha/pulls"];
  delete routes["/repos/o/alpha/issues"];
  await collector.tick();
  const row = store.get("alpha")!;
  assert.equal(row.error, "not_found");
  assert.equal(row.items, null);
  assert.equal(row.state, "unknown");
});
