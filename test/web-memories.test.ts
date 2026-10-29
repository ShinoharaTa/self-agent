import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { memoryRoutes } from "../src/web/routes/memories.ts";
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
  const { memories } = createStores(tempDb(t), () => NOW);
  const logs: string[] = [];
  const server = await serve(t, memoryRoutes({ memories, log: (line) => logs.push(line) }), () => NOW);
  return { server, memories, logs };
}

test("GET /api/memories: 有効な記憶を id 順に（チャンネルは返さない）", async (t) => {
  const { server, memories } = await setup(t);
  const a = memories.add("返事は短めがいい", "100");
  const b = memories.add("家計簿は月の 25 日で締める");
  const gone = memories.add("忘れた");
  memories.softDelete(gone.id);
  assert.deepEqual(await call(server, "GET", "/api/memories"), {
    status: 200,
    json: {
      memories: [
        { id: a.id, text: "返事は短めがいい", createdAt: NOW.toISOString() },
        { id: b.id, text: "家計簿は月の 25 日で締める", createdAt: NOW.toISOString() },
      ],
    },
  });
});

test("POST /api/memories/<id>/forget・/restore: 200 で忘れる・戻す。もう一度・無い id は 404。log に記憶の文は出さない", async (t) => {
  const { server, memories, logs } = await setup(t);
  const memory = memories.add("返事は短めがいい");
  const expected = { memory: { id: memory.id, text: "返事は短めがいい", createdAt: NOW.toISOString() } };

  assert.deepEqual(await call(server, "POST", `/api/memories/${memory.id}/forget`), { status: 200, json: expected });
  assert.deepEqual(memories.list(), []);
  assert.deepEqual(await call(server, "POST", `/api/memories/${memory.id}/forget`), { status: 404, json: { error: "not_found" } });
  assert.deepEqual(await call(server, "POST", "/api/memories/99/forget"), { status: 404, json: { error: "not_found" } });

  assert.deepEqual(await call(server, "POST", `/api/memories/${memory.id}/restore`), { status: 200, json: expected });
  assert.equal(memories.list().length, 1);
  assert.deepEqual(await call(server, "POST", `/api/memories/${memory.id}/restore`), { status: 404, json: { error: "not_found" } });
  assert.deepEqual(await call(server, "POST", "/api/memories/99/restore"), { status: 404, json: { error: "not_found" } });
  assert.deepEqual(logs, ["Web で記憶を忘れました", "Web で記憶を戻しました"]);
});
