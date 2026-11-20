import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import type { GithubTopicResult } from "../src/app/github-topics.ts";
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

function post(server: WebServer, path: string): Promise<Response> {
  return new Promise((resolve, reject) => {
    const req = request(
      {
        host: "127.0.0.1",
        port: server.address()!.port,
        method: "POST",
        path,
        headers: { "tailscale-user-login": LOGIN, "sec-fetch-site": "same-origin", "x-self-agent": "1", "content-type": "application/json" },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () => resolve({ status: res.statusCode!, json: JSON.parse(Buffer.concat(chunks).toString("utf8")) }));
        res.on("error", reject);
      },
    );
    req.on("error", reject);
    req.end("{}");
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
      handoff: false,
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
          handoff: false,
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
          handoff: false,
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
          handoff: false,
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

test("GET /api/github・POST act: 話題を作る口があれば [対応] を付けられる行に handoff、結果は種類と文と、作った・もうある話題の channelId で返す", async (t) => {
  const store = new GithubStore(tempDb(t), () => NOW);
  const calls: string[] = [];
  const results: GithubTopicResult[] = [
    { kind: "created", channelId: "topic-1", turn: "started", overlapping: 0 },
    { kind: "already", channelId: "topic-1" },
    { kind: "busy" },
  ];
  const handoff = {
    act: async (id: number, guildId?: string) => {
      calls.push(`act ${id} ${guildId ?? "-"}`);
      return id === 999 ? ({ kind: "stale" } as const) : results.shift()!;
    },
  };
  const server = await serve(t, githubRoutes({ cfg: { github: true }, store, status: () => STATUS, handoff }), () => NOW);
  const ok = store.addNotification(event({ threadId: "t-1", handoffOk: true }));
  const no = store.addNotification(event({ threadId: "t-2", handoffOk: false }));
  assert.ok(ok.result === "added" && no.result === "added");
  store.markPosted(ok.notification.id, "github-1", "message-1");
  store.markPosted(no.notification.id, "github-1", "message-2");

  const listed = await get(server, "/api/github");
  assert.equal(listed.json.handoff, true);
  const rows = listed.json.notifications as Array<{ id: number; handoff: boolean }>;
  assert.equal(rows.find((row) => row.id === ok.notification.id)?.handoff, true);
  assert.equal(rows.find((row) => row.id === no.notification.id)?.handoff, false);

  const path = `/api/github/${ok.notification.id}/act`;
  assert.deepEqual(await post(server, path), { status: 200, json: { result: "created", text: "この通知の話題を作りました", channelId: "topic-1" } });
  assert.deepEqual(await post(server, path), { status: 200, json: { result: "already", text: "この通知の話題はもうあります", channelId: "topic-1" } });
  assert.deepEqual(await post(server, path), { status: 200, json: { result: "busy", text: "この通知の話題を作っている途中です" } });
  assert.deepEqual(await post(server, "/api/github/999/act"), { status: 404, json: { error: "not_found" } });
  // Web はサーバーを指定しない
  assert.deepEqual(calls, [`act ${ok.notification.id} -`, `act ${ok.notification.id} -`, `act ${ok.notification.id} -`, "act 999 -"]);
});

test("POST /api/github/<id>/start: 話題を作る口があっても 404 で、何も呼ばない", async (t) => {
  const store = new GithubStore(tempDb(t), () => NOW);
  const calls: number[] = [];
  const handoff = {
    act: async (id: number) => {
      calls.push(id);
      return { kind: "busy" } as const;
    },
  };
  const server = await serve(t, githubRoutes({ cfg: { github: true }, store, status: () => STATUS, handoff }), () => NOW);
  const added = store.addNotification(event({ threadId: "t-1", handoffOk: true }));
  assert.ok(added.result === "added");
  assert.deepEqual(await post(server, `/api/github/${added.notification.id}/start`), { status: 404, json: { error: "not_found" } });
  assert.deepEqual(calls, []);
});

test("POST /api/github/<id>/act: 送り込みが無ければ 404", async (t) => {
  const { server, add } = await setup(t);
  const id = add({ handoffOk: true });
  assert.deepEqual(await post(server, `/api/github/${id}/act`), { status: 404, json: { error: "not_found" } });
  assert.deepEqual(await post(server, `/api/github/${id}/start`), { status: 404, json: { error: "not_found" } });
});

test("POST /api/github/<id>/act: 地図に無いリポジトリ（not_local）は 200 で種類と文を返す", async (t) => {
  const store = new GithubStore(tempDb(t), () => NOW);
  const handoff = {
    act: async () => ({ kind: "not_local", repo: "example-org/example-repo" }) as GithubTopicResult,
  };
  const server = await serve(t, githubRoutes({ cfg: { github: true }, store, status: () => STATUS, handoff }), () => NOW);
  const response = await post(server, "/api/github/1/act");
  assert.equal(response.status, 200);
  assert.equal(response.json.result, "not_local");
  assert.equal(response.json.text, "example-org/example-repo は ~/workspace の直下にありません（話題を始める場所を決められません）");
  assert.equal(response.json.channelId, undefined);
});
