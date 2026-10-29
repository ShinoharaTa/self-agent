import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { taskRoutes } from "../src/web/routes/tasks.ts";
import { request } from "node:http";
import { createWebServer, type Route, type WebServer } from "../src/web/server.ts";
import { createStores, tempDb, tempDir } from "./helpers/db.ts";

const LOGIN = "owner@example.com";
const POST_HEADERS = {
  "tailscale-user-login": LOGIN,
  "sec-fetch-site": "same-origin",
  "x-self-agent": "1",
  "content-type": "application/json",
};

type Response = { status: number; json: Record<string, unknown> };

function call(server: WebServer, method: "GET" | "POST", path: string): Promise<Response> {
  return new Promise((resolve, reject) => {
    const req = request(
      {
        host: "127.0.0.1",
        port: server.address()!.port,
        method,
        path,
        headers: method === "POST" ? POST_HEADERS : { "tailscale-user-login": LOGIN },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () => resolve({ status: res.statusCode!, json: JSON.parse(Buffer.concat(chunks).toString("utf8")) }));
        res.on("error", reject);
      },
    );
    req.on("error", reject);
    req.end(method === "POST" ? "{}" : undefined);
  });
}

async function serve(t: TestContext, routes: Route[], now: () => Date): Promise<WebServer> {
  const server = createWebServer({
    host: "127.0.0.1",
    port: 0,
    allowedLogin: LOGIN,
    staticDir: tempDir(t),
    templateSiteDir: tempDir(t),
    routes,
    stopping: () => false,
    now,
    log: () => undefined,
  });
  await server.start();
  t.after(() => server.close());
  return server;
}

const NOW = new Date("2026-10-13T00:25:00.000Z");

async function setup(t: TestContext) {
  const { tasks, reminders } = createStores(tempDb(t), () => NOW);
  const logs: string[] = [];
  const server = await serve(t, taskRoutes({ tasks, reminders, log: (line) => logs.push(line) }), () => NOW);
  return { server, tasks, reminders, logs };
}

test("GET /api/tasks: 状態ごとの一覧。open だけ紐づけた active のリマインドの次の時刻（ISO）を remind に。status が違えば 400", async (t) => {
  const { server, tasks, reminders } = await setup(t);
  const late = tasks.add({ title: "図書館の本を返す", due: "2026-10-20" });
  const soon = tasks.add({ title: "住民票を取る", due: "2026-10-14" });
  const none = tasks.add({ title: "インクを買う" });
  const done = tasks.add({ title: "健康診断の予約" });
  tasks.complete(done.id);
  const dropped = tasks.add({ title: "古いルーターを売る" });
  tasks.update(dropped.id, { status: "dropped" });
  reminders.add({ guildId: "g", channelId: "c", kind: "notify", text: "住民票", taskId: soon.id, nextAt: new Date("2026-10-13T23:00:00.000Z") });
  // 止めたリマインドは付けない
  const stopped = reminders.add({ guildId: "g", channelId: "c", kind: "notify", text: "本", taskId: late.id, nextAt: new Date("2026-10-19T00:00:00.000Z") });
  reminders.cancel(stopped.id);

  const open = await call(server, "GET", "/api/tasks?status=open");
  assert.equal(open.status, 200);
  assert.deepEqual(open.json.tasks, [
    { id: soon.id, title: "住民票を取る", due: "2026-10-14", status: "open", completedAt: null, remind: "2026-10-13T23:00:00.000Z" },
    { id: late.id, title: "図書館の本を返す", due: "2026-10-20", status: "open", completedAt: null, remind: null },
    { id: none.id, title: "インクを買う", due: null, status: "open", completedAt: null, remind: null },
  ]);
  // 省略は open
  assert.deepEqual((await call(server, "GET", "/api/tasks")).json, open.json);
  assert.deepEqual((await call(server, "GET", "/api/tasks?status=done")).json.tasks, [
    { id: done.id, title: "健康診断の予約", due: null, status: "done", completedAt: NOW.toISOString(), remind: null },
  ]);
  assert.deepEqual((await call(server, "GET", "/api/tasks?status=dropped")).json.tasks, [
    { id: dropped.id, title: "古いルーターを売る", due: null, status: "dropped", completedAt: NOW.toISOString(), remind: null },
  ]);
  for (const status of ["all", "", "OPEN"]) {
    assert.deepEqual(await call(server, "GET", `/api/tasks?status=${status}`), { status: 400, json: { error: "bad_request" } }, status);
  }
});

test("POST /api/tasks/<id>/complete: 200 で完了に、2 回目は 409、無い id は 404。reopen で open に戻り、もう一度は 409", async (t) => {
  const { server, tasks, logs } = await setup(t);
  const task = tasks.add({ title: "住民票を取る", due: "2026-10-14" });

  const completed = await call(server, "POST", `/api/tasks/${task.id}/complete`);
  assert.deepEqual(completed, {
    status: 200,
    json: { task: { id: task.id, title: "住民票を取る", due: "2026-10-14", status: "done", completedAt: NOW.toISOString(), remind: null } },
  });
  assert.equal(tasks.get(task.id)?.status, "done");
  // Discord の /tasks（open の一覧）から消える
  assert.deepEqual(tasks.list({ status: "open", limit: 25 }), []);
  assert.deepEqual(await call(server, "POST", `/api/tasks/${task.id}/complete`), { status: 409, json: { error: "already_done" } });
  assert.deepEqual(await call(server, "POST", "/api/tasks/99/complete"), { status: 404, json: { error: "not_found" } });

  const reopened = await call(server, "POST", `/api/tasks/${task.id}/reopen`);
  assert.deepEqual(reopened, {
    status: 200,
    json: { task: { id: task.id, title: "住民票を取る", due: "2026-10-14", status: "open", completedAt: null, remind: null } },
  });
  assert.equal(tasks.list({ status: "open", limit: 25 }).length, 1);
  assert.deepEqual(await call(server, "POST", `/api/tasks/${task.id}/reopen`), { status: 409, json: { error: "no_change" } });
  assert.deepEqual(await call(server, "POST", "/api/tasks/99/reopen"), { status: 404, json: { error: "not_found" } });
  assert.deepEqual(logs, [`Web でタスクを完了にしました（#${task.id}）`, `Web でタスクを未完了に戻しました（#${task.id}）`]);
});

test("POST /api/tasks/<id>/reopen: やめたタスクも open に戻す。GET は 405", async (t) => {
  const { server, tasks } = await setup(t);
  const task = tasks.add({ title: "古いルーターを売る" });
  tasks.update(task.id, { status: "dropped" });
  assert.equal((await call(server, "POST", `/api/tasks/${task.id}/reopen`)).status, 200);
  assert.equal(tasks.get(task.id)?.status, "open");
  assert.equal((await call(server, "GET", `/api/tasks/${task.id}/complete`)).status, 405);
});
