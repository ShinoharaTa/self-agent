import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, realpathSync } from "node:fs";
import { request } from "node:http";
import { join } from "node:path";
import type { BoardLive } from "../src/board/collect.ts";
import { BOARD_MAX_PROJECTS, BoardStore } from "../src/store/board.ts";
import { boardRoutes } from "../src/web/routes/board.ts";
import { createWebServer, type WebServer } from "../src/web/server.ts";
import { tempDb, tempDir } from "./helpers/db.ts";

const LOGIN = "owner@example.com";

type Response = { status: number; json: Record<string, unknown> };

function call(server: WebServer, method: "GET" | "POST", path: string, body?: unknown): Promise<Response> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = { "tailscale-user-login": LOGIN };
    if (method === "POST") Object.assign(headers, { "sec-fetch-site": "same-origin", "x-self-agent": "1", "content-type": "application/json" });
    const req = request({ host: "127.0.0.1", port: server.address()!.port, method, path, headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (chunk: Buffer) => chunks.push(chunk));
      res.on("end", () => resolve({ status: res.statusCode!, json: JSON.parse(Buffer.concat(chunks).toString("utf8")) }));
      res.on("error", reject);
    });
    req.on("error", reject);
    req.end(method === "POST" ? JSON.stringify(body ?? {}) : undefined);
  });
}

async function serve(t: TestContext, routes: ReturnType<typeof boardRoutes>): Promise<WebServer> {
  const server = createWebServer({
    host: "127.0.0.1",
    port: 0,
    allowedLogin: LOGIN,
    staticDir: tempDir(t),
    templateSiteDir: tempDir(t),
    routes,
    stopping: () => false,
    now: () => new Date("2026-11-13T00:00:00Z"),
    log: () => undefined,
  });
  await server.start();
  t.after(() => server.close());
  return server;
}

async function setup(t: TestContext, live: (dir: string) => BoardLive = () => ({ ccSessions: [], turnRunning: false })) {
  const store = new BoardStore(tempDb(t), () => new Date("2026-11-13T00:00:00Z"));
  const workspace = realpathSync(tempDir(t));
  for (const name of ["alpha", "beta", "gamma", "delta"]) mkdirSync(join(workspace, name));
  const refreshed: number[] = [];
  const logs: string[] = [];
  const server = await serve(
    t,
    boardRoutes({
      board: {
        store,
        collector: { refresh: async () => void refreshed.push(1), repoOf: async (dir) => (dir === "alpha" ? "o/alpha" : null) },
        places: { workspaceDir: workspace, protectedDirs: [] },
        live: (dir) => live(dir),
      },
      log: (message) => logs.push(message),
    }),
  );
  return { store, server, refreshed, logs };
}

const CHECKED = "2026-11-13T00:00:00.000Z";

test("GET /api/board: 無効なら enabled false・POST は 404", async (t) => {
  const server = await serve(t, boardRoutes({ log: () => undefined }));
  assert.deepEqual((await call(server, "GET", "/api/board")).json, { enabled: false, projects: [], candidates: [] });
  assert.equal((await call(server, "POST", "/api/board/projects", { dir: "alpha" })).status, 404);
  assert.equal((await call(server, "POST", "/api/board/refresh")).status, 404);
  assert.equal((await call(server, "POST", "/api/board/projects/alpha/remove")).status, 404);
});

test("GET /api/board: 状態はその場の材料で決め直し、owner → agent → working → done → unknown・dir の順。candidates は未登録のもの", async (t) => {
  const { store, server } = await setup(t, (dir) =>
    dir === "delta" ? { ccSessions: [{ sessionId: "s-1", state: "running", pendingPermission: false }], turnRunning: false } : { ccSessions: [], turnRunning: false },
  );
  for (const dir of ["alpha", "beta", "delta"]) store.add(dir, null);
  const local = { branch: "main", dirty: 0, ahead: 0, behind: 0, lastCommitAt: null };
  store.saveResult("alpha", { repo: "o/alpha", state: "done", reasons: [], items: [], local, error: null, checkedAt: CHECKED });
  store.saveResult("beta", {
    repo: "o/beta",
    state: "done",
    reasons: [],
    items: [{ kind: "issue", number: 2, title: "<b>題名</b>", url: "https://github.com/o/beta/issues/2", mine: false, draft: false, ci: "none" }],
    local,
    error: null,
    checkedAt: CHECKED,
  });
  store.saveResult("delta", { repo: "o/delta", state: "done", reasons: [], items: [], local, error: null, checkedAt: CHECKED });
  const { status, json } = await call(server, "GET", "/api/board");
  assert.equal(status, 200);
  assert.equal(json.enabled, true);
  const projects = json.projects as Array<Record<string, unknown>>;
  assert.deepEqual(
    projects.map((p) => [p.dir, p.state]),
    [
      ["beta", "agent"],
      ["delta", "working"],
      ["alpha", "done"],
    ],
  );
  assert.deepEqual(projects[0]!.reasons, ["手つかずの issue 1 件"]);
  assert.equal((projects[0]!.items as Array<Record<string, unknown>>)[0]!.title, "<b>題名</b>");
  assert.deepEqual(projects[1]!.ccSessions, [{ sessionId: "s-1", state: "running" }]);
  assert.deepEqual(json.candidates, [{ name: "gamma" }]);
});

test("POST /api/board/projects: 201・既にあれば 200・形が違えば 400 invalid_project・上限は 409 limit。登録したら回す", async (t) => {
  const { store, server, refreshed, logs } = await setup(t);
  const created = await call(server, "POST", "/api/board/projects", { dir: "alpha" });
  assert.equal(created.status, 201);
  assert.equal(store.get("alpha")?.repo, "o/alpha");
  assert.equal(refreshed.length, 1);
  assert.equal((await call(server, "POST", "/api/board/projects", { dir: "alpha" })).status, 200);
  assert.equal(refreshed.length, 1);
  for (const dir of ["nope", "../alpha", "", 3]) {
    const res = await call(server, "POST", "/api/board/projects", { dir });
    assert.equal(res.status, 400, String(dir));
    assert.equal(res.json.error, "invalid_project");
  }
  for (let i = 0; store.countActive() < BOARD_MAX_PROJECTS; i++) store.add(`p${i}`, null);
  const limit = await call(server, "POST", "/api/board/projects", { dir: "beta" });
  assert.equal(limit.status, 409);
  assert.equal(limit.json.error, "limit");
  assert.ok(logs.every((line) => !line.includes("alpha")));
});

test("POST /api/board/projects/<dir>/remove: 200・無ければ 404。POST /api/board/refresh は 202", async (t) => {
  const { store, server, refreshed } = await setup(t);
  store.add("alpha", null);
  assert.equal((await call(server, "POST", "/api/board/projects/alpha/remove")).status, 200);
  assert.equal(store.get("alpha")?.removedAt, "2026-11-13T00:00:00.000Z");
  assert.equal((await call(server, "POST", "/api/board/projects/alpha/remove")).status, 404);
  assert.equal((await call(server, "POST", "/api/board/projects/%2E%2E/remove")).status, 404);
  const res = await call(server, "POST", "/api/board/refresh");
  assert.equal(res.status, 202);
  assert.equal(refreshed.length, 1);
});
