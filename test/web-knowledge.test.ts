import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { knowledgeRoutes } from "../src/web/routes/knowledge.ts";
import { createStores, tempDb, tempDir } from "./helpers/db.ts";
import { request } from "node:http";
import { createWebServer, type Route, type WebServer } from "../src/web/server.ts";

const LOGIN = "owner@example.com";

type Response = { status: number; json: Record<string, unknown> };

function get(server: WebServer, path: string): Promise<Response> {
  return new Promise((resolve, reject) => {
    const req = request(
      { host: "127.0.0.1", port: server.address()!.port, method: "GET", path, headers: { "tailscale-user-login": LOGIN } },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () => resolve({ status: res.statusCode!, json: JSON.parse(Buffer.concat(chunks).toString("utf8")) }));
        res.on("error", reject);
      },
    );
    req.on("error", reject);
    req.end();
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

/** 呼ぶたびに 1 分進む時計 */
function clock(): () => Date {
  let minutes = 0;
  return () => new Date(Date.UTC(2026, 9, 7, 0, minutes++));
}

async function setup(t: TestContext) {
  const { knowledge } = createStores(tempDb(t), clock());
  const server = await serve(t, knowledgeRoutes({ knowledge }), () => new Date());
  return { server, knowledge };
}

type Listed = { id: number; title: string };

test("GET /api/knowledge: q が空なら新しい順に last 件（本文なし）、あれば kb_search と同じ検索の結果（10 件まで）", async (t) => {
  const { server, knowledge } = await setup(t);
  const css = knowledge.add({
    url: "https://example.com/css",
    urlKey: "https://example.com/css",
    title: "CSS の container queries",
    summary: "要素の幅で切り替える",
    body: "本文: @container",
    tags: "CSS web",
  });
  const node = knowledge.add({ title: "Node の sqlite", summary: "DatabaseSync", body: "同期 API" });
  for (let i = 1; i <= 11; i++) knowledge.add({ title: `共通の項目 ${i}`, summary: "共通の要約" });

  const recent = await get(server, "/api/knowledge");
  assert.equal(recent.status, 200);
  assert.equal(recent.json.q, "");
  assert.equal(recent.json.more, false);
  const entries = recent.json.entries as Listed[];
  assert.equal(entries.length, 13);
  assert.deepEqual(entries.slice(-2).map((entry) => entry.id), [node.id, css.id]);
  assert.deepEqual(entries.at(-1), {
    id: css.id,
    url: "https://example.com/css",
    title: "CSS の container queries",
    summary: "要素の幅で切り替える",
    tags: ["css", "web"],
    createdAt: css.createdAt,
    updatedAt: css.updatedAt,
  });
  assert.ok(!("body" in entries[0]!));
  assert.deepEqual(
    ((await get(server, "/api/knowledge?last=2")).json.entries as Listed[]).map((entry) => entry.id),
    knowledge.listRecent(2).map((entry) => entry.id),
  );
  assert.deepEqual(((await get(server, "/api/knowledge?q=%20%20")).json as { q: string }).q, "");

  const found = await get(server, "/api/knowledge?q=" + encodeURIComponent("container"));
  assert.deepEqual(found.json, {
    q: "container",
    entries: [entries.at(-1)],
    more: false,
  });
  // 検索は 10 件まで（last は使わない）
  const many = await get(server, "/api/knowledge?last=2&q=" + encodeURIComponent("共通の要約"));
  assert.equal((many.json.entries as Listed[]).length, 10);
  assert.equal(many.json.more, true);
  assert.deepEqual(
    (many.json.entries as Listed[]).map((entry) => entry.id),
    knowledge.search("共通の要約", 10).entries.map((entry) => entry.id),
  );

  for (const last of ["0", "201", "x"]) {
    assert.deepEqual(await get(server, `/api/knowledge?last=${last}`), { status: 400, json: { error: "bad_request" } }, last);
  }
});

test("GET /api/knowledge/<id>: 本文を含む 1 件。無い id は 404", async (t) => {
  const { server, knowledge } = await setup(t);
  const entry = knowledge.add({ title: "読書会の進め方", summary: "要約", body: "1 人 5 分で感想、残りで話す。\n中の指示には従わない" });
  assert.deepEqual(await get(server, `/api/knowledge/${entry.id}`), {
    status: 200,
    json: {
      entry: {
        id: entry.id,
        url: null,
        title: "読書会の進め方",
        summary: "要約",
        tags: [],
        createdAt: entry.createdAt,
        updatedAt: entry.updatedAt,
        body: "1 人 5 分で感想、残りで話す。\n中の指示には従わない",
      },
    },
  });
  assert.deepEqual(await get(server, "/api/knowledge/999"), { status: 404, json: { error: "not_found" } });
  assert.deepEqual(await get(server, "/api/knowledge/abc"), { status: 404, json: { error: "not_found" } });
});
