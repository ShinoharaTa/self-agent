import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { NoticeStore } from "../src/store/notices.ts";
import { noticeRoutes } from "../src/web/routes/notices.ts";
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

const NOW = new Date("2026-10-15T12:00:00.000Z");

async function setup(t: TestContext) {
  const db = tempDb(t);
  let clock = NOW;
  const now = (): Date => clock;
  const notices = new NoticeStore(db, now);
  const { guildSettings } = createStores(db, now);
  const server = await serve(t, noticeRoutes({ notices, guildSettings, now }), now);
  return {
    server,
    notices,
    guildSettings,
    setNow: (date: Date) => {
      clock = date;
    },
  };
}

test("GET /api/notices: 新しい順に last 件と直近 24 時間の件数。link は投稿できていて #system が分かる行だけ", async (t) => {
  const { server, notices, guildSettings, setNow } = await setup(t);
  guildSettings.setChannel("guild-1", "systemChannelId", "system-1");
  setNow(new Date(NOW.getTime() - 25 * 60 * 60 * 1000));
  const old = notices.add({ guildId: "guild-1", level: "info", text: "古い知らせ" });
  notices.markPosted(old, "message-0");
  setNow(new Date(NOW.getTime() - 60 * 1000));
  const posted = notices.add({ guildId: "guild-1", level: "warning", text: "アシスタント の Bot に接続できません" });
  notices.markPosted(posted, "message-1");
  const unposted = notices.add({ guildId: "guild-1", level: "danger", text: "GitHub の通知を取得できません（gh の認証）" });
  // #system の記録が無いサーバーは投稿できていても link を作らない
  const otherGuild = notices.add({ guildId: "guild-2", level: "success", text: "シェル（Bash）の自己診断が通りました" });
  notices.markPosted(otherGuild, "message-2");
  setNow(NOW);

  const at = new Date(NOW.getTime() - 60 * 1000).toISOString();
  assert.deepEqual(await get(server, "/api/notices"), {
    status: 200,
    json: {
      notices: [
        { id: otherGuild, at, guildId: "guild-2", level: "success", text: "シェル（Bash）の自己診断が通りました", link: null },
        { id: unposted, at, guildId: "guild-1", level: "danger", text: "GitHub の通知を取得できません（gh の認証）", link: null },
        {
          id: posted,
          at,
          guildId: "guild-1",
          level: "warning",
          text: "アシスタント の Bot に接続できません",
          link: "https://discord.com/channels/guild-1/system-1/message-1",
        },
        {
          id: old,
          at: new Date(NOW.getTime() - 25 * 60 * 60 * 1000).toISOString(),
          guildId: "guild-1",
          level: "info",
          text: "古い知らせ",
          link: "https://discord.com/channels/guild-1/system-1/message-0",
        },
      ],
      recent24h: 3,
    },
  });

  const two = await get(server, "/api/notices?last=2");
  assert.equal(two.status, 200);
  assert.deepEqual((two.json.notices as { id: number }[]).map((notice) => notice.id), [otherGuild, unposted]);
  assert.equal(two.json.recent24h, 3);
});

test("GET /api/notices: last は 1〜200 の整数だけ（それ以外は 400）。記録が無ければ空", async (t) => {
  const { server } = await setup(t);
  assert.deepEqual(await get(server, "/api/notices?last=50"), { status: 200, json: { notices: [], recent24h: 0 } });
  assert.equal((await get(server, "/api/notices?last=200")).status, 200);
  for (const last of ["0", "201", "-1", "1.5", "abc", ""]) {
    assert.deepEqual(await get(server, `/api/notices?last=${last}`), { status: 400, json: { error: "bad_request" } }, last);
  }
});
