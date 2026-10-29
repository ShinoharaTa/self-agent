import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import type { GithubPollerStatus } from "../src/github/poller.ts";
import { GithubStore, type NewGithubNotification } from "../src/store/github.ts";
import { githubRoutes } from "../src/web/routes/github.ts";
import { tempDb, tempDir } from "./helpers/db.ts";
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

const NOW = new Date("2026-10-15T12:00:00.000Z");
const STATUS: GithubPollerStatus = { enabled: true, lastFetchAt: "2026-10-15T11:55:00.000Z", failure: null, pausedUntil: null };

function event(overrides: Partial<NewGithubNotification>): NewGithubNotification {
  return {
    threadId: "t-1",
    updatedAt: "2026-10-15T00:00:00Z",
    reason: "author",
    level: "red",
    label: "コメント",
    actorLogin: "example-other",
    actorKnown: true,
    title: "題名",
    url: "https://github.com/example-org/example-repo/pull/12",
    repoPrivate: true,
    handoffOk: false,
    ...overrides,
  };
}

async function setup(t: TestContext, options: { github?: boolean } = {}) {
  const store = new GithubStore(tempDb(t), () => NOW);
  const enabled = options.github ?? true;
  const server = await serve(
    t,
    githubRoutes({ cfg: { github: enabled }, store, status: enabled ? () => STATUS : undefined }),
    () => NOW,
  );
  const add = (overrides: Partial<NewGithubNotification>): number => {
    const added = store.addNotification(event(overrides));
    assert.ok(added.result === "added");
    return added.notification.id;
  };
  return { server, store, add };
}

test("GET /api/github: 投稿した赤・黄だけを updated_at の新しい順に、ポーリングの状態と一緒に返す", async (t) => {
  const { server, store, add } = await setup(t);
  const red = add({ threadId: "t-1", updatedAt: "2026-10-15T00:01:00Z" });
  const yellow = add({
    threadId: "t-2",
    updatedAt: "2026-10-15T00:05:00Z",
    level: "yellow",
    label: "新しい Issue",
    actorLogin: null,
    actorKnown: false,
    title: "<b>題名</b> @everyone",
    url: "https://github.com/example-org/other-repo/issues/3",
  });
  const unposted = add({ threadId: "t-3", updatedAt: "2026-10-15T00:09:00Z" });
  add({ threadId: "t-4", updatedAt: "2026-10-15T00:10:00Z", level: "drop" });
  // 形の違う URL（検証した部品の形でないもの）はリンクにしない
  const odd = add({ threadId: "t-5", updatedAt: "2026-10-15T00:00:30Z", url: "javascript:alert(1)" });
  store.markPosted(red, "github-1", "message-1");
  store.markSkipped(yellow);
  store.markPosted(odd, "github-1", "message-2");

  const response = await get(server, "/api/github");
  assert.deepEqual(response, {
    status: 200,
    json: {
      status: STATUS,
      notifications: [
        {
          id: yellow,
          level: "yellow",
          label: "新しい Issue",
          title: "<b>題名</b> @everyone",
          url: "https://github.com/example-org/other-repo/issues/3",
          actorLogin: null,
          actorKnown: false,
          updatedAt: "2026-10-15T00:05:00Z",
        },
        {
          id: red,
          level: "red",
          label: "コメント",
          title: "題名",
          url: "https://github.com/example-org/example-repo/pull/12",
          actorLogin: "example-other",
          actorKnown: true,
          updatedAt: "2026-10-15T00:01:00Z",
        },
        {
          id: odd,
          level: "red",
          label: "コメント",
          title: "題名",
          url: null,
          actorLogin: "example-other",
          actorKnown: true,
          updatedAt: "2026-10-15T00:00:30Z",
        },
      ],
    },
  });
  assert.ok(!(response.json.notifications as { id: number }[]).some((row) => row.id === unposted));

  const one = await get(server, "/api/github?last=1");
  assert.deepEqual((one.json.notifications as { id: number }[]).map((row) => row.id), [yellow]);
  for (const last of ["0", "201", "x"]) {
    assert.deepEqual(await get(server, `/api/github?last=${last}`), { status: 400, json: { error: "bad_request" } }, last);
  }
});

test("GET /api/github: SELF_AGENT_GITHUB が無効なら 404", async (t) => {
  const { server } = await setup(t, { github: false });
  assert.deepEqual(await get(server, "/api/github"), { status: 404, json: { error: "not_found" } });
});
