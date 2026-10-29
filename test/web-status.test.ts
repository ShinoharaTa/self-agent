import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { ShellState } from "../src/app/shell-state.ts";
import { startOfLocalDay } from "../src/app/time.ts";
import type { PersonaConfig } from "../src/config.ts";
import type { UsageRecord } from "../src/store/usage.ts";
import { statusRoutes, WEB_ENV_NAMES, type StatusDeps } from "../src/web/routes/status.ts";
import { usageRoutes } from "../src/web/routes/usage.ts";
import { createWebServer, type Route, type WebServer } from "../src/web/server.ts";
import { readPackageVersion } from "../src/web/version.ts";
import { createStores, tempDb, tempDir } from "./helpers/db.ts";

const LOGIN = "owner@example.com";
/** 2026-10-02(金) 09:12 JST */
const NOW = new Date("2026-10-02T00:12:00Z");

async function serve(t: TestContext, routes: Route[]): Promise<WebServer> {
  const server = createWebServer({
    host: "127.0.0.1",
    port: 0,
    allowedLogin: LOGIN,
    staticDir: tempDir(t),
    templateSiteDir: tempDir(t),
    routes,
    stopping: () => false,
    now: () => NOW,
    log: () => undefined,
  });
  await server.start();
  t.after(() => server.close());
  return server;
}

function getJson(server: WebServer, path: string): Promise<{ status: number; json: unknown }> {
  return new Promise((resolve, reject) => {
    const req = request(
      { host: "127.0.0.1", port: server.address()!.port, path, headers: { "tailscale-user-login": LOGIN } },
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

async function statusSetup(t: TestContext, overrides: Partial<StatusDeps> = {}) {
  const db = tempDb(t);
  const { guildSettings } = createStores(db, () => NOW);
  guildSettings.setChannel("guild-1", "systemChannelId", "system-1");
  let stopping = false;
  const shell = new ShellState({
    cfg: { allowedGuildIds: [] },
    check: async () => ({ ok: false, failed: ["bwrap が無い", "socat が無い"] }),
    guildSettings,
    gateway: { sendMessage: async () => "m" },
    log: () => undefined,
  });
  await shell.check();
  const deps: StatusDeps = {
    cfg: {
      allowedGuildIds: ["guild-1", "guild-2"],
      publicBaseUrl: undefined,
      devMode: true,
      github: true,
      jobs: false,
      guest: true,
    },
    version: () => "0.1.0",
    startedAt: new Date("2026-10-02T00:00:00Z"),
    stopping: () => stopping,
    personas: {
      all: [
        { id: "default", name: "default", connected: () => true },
        { id: "mika", name: "Mika", connected: () => false },
      ],
    },
    guestConnected: () => true,
    shellState: { configured: true, enabled: () => shell.enabled(), failedItems: () => shell.failedItems() },
    queue: { runningSessionJobs: () => 1 },
    running: () => 0,
    serving: () => false,
    guildSettings,
    env: {
      CLAUDE_CODE_OAUTH_TOKEN: "secret-oauth-value",
      DISCORD_TOKEN: "",
      SELF_AGENT_WEB_TOKEN: "secret-web-token-value-0123456789",
      UNLISTED_SECRET: "secret-unlisted",
    },
    ...overrides,
  };
  const server = await serve(t, statusRoutes(deps));
  return { server, setStopping: (value: boolean) => (stopping = value) };
}

test("/api/status: Bot・シェルの失敗の項目・キュー・GitHub（W6 までは null）・サーバーの /setup・停止中を返す", async (t) => {
  const { server, setStopping } = await statusSetup(t);
  const { status, json } = await getJson(server, "/api/status");
  assert.equal(status, 200);
  const body = json as Record<string, unknown>;
  assert.equal(body.version, "0.1.0");
  assert.equal(body.startedAt, "2026-10-02T00:00:00.000Z");
  assert.equal(body.stopping, false);
  assert.deepEqual(body.bots, [
    { persona: "default", name: "既定の人格", isDefault: true, connected: true },
    { persona: "mika", name: "Mika", isDefault: false, connected: false },
    { persona: "guest", name: "しのえもん", guest: true, connected: true },
  ]);
  assert.deepEqual(body.shell, { configured: true, enabled: false, failed: ["bwrap が無い", "socat が無い"] });
  assert.deepEqual(body.queue, { runningSessionJobs: 1 });
  assert.equal(body.running, 0);
  assert.equal(body.serving, false);
  assert.equal(body.publicBaseUrl, null);
  assert.equal(body.devMode, true);
  assert.deepEqual(body.github, { enabled: true, lastFetchAt: null, failure: null });
  assert.deepEqual(body.jobs, { enabled: false });
  assert.equal(body.guest, true);
  assert.deepEqual(body.guilds, [
    { id: "guild-1", setUp: true },
    { id: "guild-2", setUp: false },
  ]);

  setStopping(true);
  assert.equal(((await getJson(server, "/api/status")).json as Record<string, unknown>).stopping, true);
});

test("/api/status: env は [名前, 値があるか] だけで値を含まない。一覧は WEB_ENV_NAMES の順", async (t) => {
  const { server } = await statusSetup(t);
  const { json } = await getJson(server, "/api/status");
  const env = (json as { env: unknown[] }).env;
  assert.equal(env.length, WEB_ENV_NAMES.length);
  for (const [index, item] of env.entries()) {
    assert.ok(Array.isArray(item) && item.length === 2, JSON.stringify(item));
    assert.equal(item[0], WEB_ENV_NAMES[index]);
    assert.equal(typeof item[1], "boolean");
  }
  const map = new Map(env as Array<[string, boolean]>);
  assert.equal(map.get("CLAUDE_CODE_OAUTH_TOKEN"), true);
  assert.equal(map.get("DISCORD_TOKEN"), false);
  assert.equal(map.get("SELF_AGENT_WEB_TOKEN"), true);
  assert.equal(map.get("SELF_AGENT_MODEL"), false);
  assert.equal(map.has("UNLISTED_SECRET"), false);
  assert.ok(!JSON.stringify(json).includes("secret-"));
});

test("/api/status: シェルが通っていれば failed は空。ゲストが無ければゲストの Bot を出さない。githubStatus があればそれ", async (t) => {
  const { server } = await statusSetup(t, {
    shellState: { configured: false, enabled: () => false, failedItems: () => [] },
    guestConnected: undefined,
    githubStatus: () => ({ enabled: true, lastFetchAt: "2026-10-02T00:10:00.000Z", failure: "auth" }),
  });
  const body = (await getJson(server, "/api/status")).json as Record<string, unknown>;
  assert.deepEqual(body.shell, { configured: false, enabled: false, failed: [] });
  assert.equal((body.bots as unknown[]).length, 2);
  assert.deepEqual(body.github, { enabled: true, lastFetchAt: "2026-10-02T00:10:00.000Z", failure: "auth" });
});

test("WEB_ENV_NAMES: CLAUDE.md の環境変数の表の名前（廃止したものを除く）と同じ", () => {
  const claudeMd = readFileSync(new URL("../CLAUDE.md", import.meta.url), "utf8");
  const table = claudeMd.slice(claudeMd.indexOf("## 環境変数"), claudeMd.indexOf("## コーディング規約"));
  const names: string[] = [];
  for (const line of table.split("\n")) {
    const cell = /^\| ([^|]+) \|/.exec(line)?.[1];
    if (cell === undefined || cell.startsWith("~~")) continue;
    names.push(...[...cell.matchAll(/`([A-Z0-9_]+)`/g)].map((match) => match[1]!));
  }
  assert.deepEqual([...WEB_ENV_NAMES], names);
});

test("readPackageVersion: version が文字列ならそれ、無い・読めなければ null（今の package.json には version が無い）", (t) => {
  const dir = tempDir(t);
  const withVersion = join(dir, "a.json");
  writeFileSync(withVersion, JSON.stringify({ name: "x", version: "0.1.0" }));
  const without = join(dir, "b.json");
  writeFileSync(without, JSON.stringify({ name: "x", version: 1 }));
  const broken = join(dir, "c.json");
  writeFileSync(broken, "{");
  assert.equal(readPackageVersion(pathToFileURL(withVersion)), "0.1.0");
  assert.equal(readPackageVersion(pathToFileURL(without)), null);
  assert.equal(readPackageVersion(pathToFileURL(broken)), null);
  assert.equal(readPackageVersion(pathToFileURL(join(dir, "missing.json"))), null);
  const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version?: unknown };
  assert.equal(readPackageVersion(), typeof pkg.version === "string" ? pkg.version : null);
});

function usageSetup(t: TestContext, personas: Array<Pick<PersonaConfig, "id" | "name">> = [], guest = false) {
  const db = tempDb(t);
  const clock = { now: NOW };
  const { usage, attachments } = createStores(db, () => clock.now);
  const recordAt = (at: string, record: Partial<UsageRecord>): void => {
    clock.now = new Date(at);
    usage.record({ key: "inbox-1", ok: true, ...record });
    clock.now = NOW;
  };
  const routes = usageRoutes({
    cfg: { timeZone: "Asia/Tokyo", personas: personas as PersonaConfig[], guest },
    usage,
    attachments,
    now: () => clock.now,
  });
  return { usage, attachments, recordAt, routes };
}

test("/api/usage: その日（SELF_AGENT_TZ）の行が listRecent と同じ（steps は除く）。合計は既定の人格 → 足した人格 → ゲストの順で、その日の分だけ", async (t) => {
  const { usage, attachments, recordAt, routes } = usageSetup(t, [{ id: "mika", name: "Mika" }], true);
  // 2026-10-01 JST の前日・当日・翌日
  recordAt("2026-09-30T14:59:00.000Z", { inputTokens: 1000, outputTokens: 1000 });
  recordAt("2026-09-30T15:00:00.000Z", {
    kind: "inbox",
    inputTokens: 1,
    cacheReadInputTokens: 10,
    cacheCreationInputTokens: 100,
    outputTokens: 5,
    steps: [{ inputTokens: 1, cacheReadInputTokens: 10, cacheCreationInputTokens: 100, cacheCreation1hInputTokens: 0 }],
  });
  recordAt("2026-10-01T03:00:00.000Z", { kind: "session", persona: "mika", inputTokens: 2, outputTokens: 7 });
  recordAt("2026-10-01T04:00:00.000Z", { kind: "guest", persona: "guest", inputTokens: 3, outputTokens: 9 });
  recordAt("2026-10-01T05:00:00.000Z", { kind: "session", ok: false });
  recordAt("2026-10-01T15:00:00.000Z", { inputTokens: 2000, outputTokens: 2000 });
  attachments.add({ guildId: "g", channelId: "c", messageId: "m", path: "g/c/m-1.png", contentType: "image/png", sha256: "0".repeat(64), size: 2048 });

  const server = await serve(t, routes);
  const { status, json } = await getJson(server, "/api/usage?date=2026-10-01&last=10");
  assert.equal(status, 200);
  const body = json as { date: string; rows: unknown[]; totals: Array<Record<string, unknown>>; attachments: unknown };
  assert.equal(body.date, "2026-10-01");
  const expected = usage
    .listRecent({ since: new Date("2026-09-30T15:00:00.000Z"), until: new Date("2026-10-01T15:00:00.000Z"), limit: 10 })
    .map(({ steps: _steps, ...rest }) => rest);
  assert.equal(expected.length, 4);
  assert.deepEqual(body.rows, expected);
  assert.ok(!JSON.stringify(body.rows).includes("steps"));
  assert.deepEqual(
    body.totals.map((total) => [total.persona, total.name, (total.summary as { turns: number }).turns, total.outputTokens]),
    [
      ["default", "既定の人格", 2, 5],
      ["mika", "Mika", 1, 7],
      ["guest", "しのえもん", 1, 9],
    ],
  );
  assert.deepEqual(body.attachments, { count: 1, bytes: 2048 });

  // kind と last で絞る
  const sessions = (await getJson(server, "/api/usage?date=2026-10-01&kind=session")).json as { rows: Array<{ kind: string }> };
  assert.deepEqual(sessions.rows.map((row) => row.kind), ["session", "session"]);
  const lastOne = (await getJson(server, "/api/usage?date=2026-10-01&last=1")).json as { rows: Array<{ at: string }> };
  assert.deepEqual(lastOne.rows.map((row) => row.at), ["2026-10-01T05:00:00.000Z"]);
  // 既定は今日（2026-10-02 JST）
  const today = (await getJson(server, "/api/usage")).json as { date: string; rows: unknown[] };
  assert.equal(today.date, "2026-10-02");
  assert.equal(today.rows.length, 1);
});

test("/api/usage: 人格もゲストも無ければ合計は既定の人格だけ。last は 1〜200、date は YYYY-MM-DD の実在する日付だけ（それ以外は 400）", async (t) => {
  const { routes } = usageSetup(t);
  const server = await serve(t, routes);
  const body = (await getJson(server, "/api/usage")).json as { totals: Array<{ persona: string }> };
  assert.deepEqual(body.totals.map((total) => total.persona), ["default"]);
  assert.equal((await getJson(server, "/api/usage?last=200")).status, 200);
  for (const query of ["last=201", "last=0", "last=abc", "last=", "date=2026-1-1", "date=2026-02-30", "date=today", "date="]) {
    const { status, json } = await getJson(server, `/api/usage?${query}`);
    assert.equal(status, 400, query);
    assert.deepEqual(json, { error: "bad_request" }, query);
  }
});

test("/api/usage/days: 今日を含めた n 日の日付ごとのターン数と入力の合計（記録の無い日は 0）を古い順に", async (t) => {
  const { recordAt, routes } = usageSetup(t);
  recordAt("2026-09-29T15:00:00.000Z", { inputTokens: 1, cacheReadInputTokens: 10, cacheCreationInputTokens: 100 });
  recordAt("2026-10-01T14:59:00.000Z", { inputTokens: 2 });
  recordAt("2026-10-01T15:00:00.000Z", { ok: false });
  recordAt("2026-10-02T00:00:00.000Z", { inputTokens: 3, cacheReadInputTokens: 30 });
  const server = await serve(t, routes);

  const { status, json } = await getJson(server, "/api/usage/days?n=4");
  assert.equal(status, 200);
  assert.deepEqual(json, [
    { date: "2026-09-29", turns: 0, inputTokens: 0 },
    { date: "2026-09-30", turns: 1, inputTokens: 111 },
    { date: "2026-10-01", turns: 1, inputTokens: 2 },
    { date: "2026-10-02", turns: 2, inputTokens: 33 },
  ]);
  const defaults = (await getJson(server, "/api/usage/days")).json as Array<{ date: string }>;
  assert.equal(defaults.length, 30);
  assert.equal(defaults.at(-1)!.date, "2026-10-02");
  assert.equal(defaults[0]!.date, "2026-09-03");
  assert.ok(startOfLocalDay(NOW, "Asia/Tokyo", 29).toISOString().startsWith("2026-09-02T15:00"));
  for (const n of ["0", "367", "x"]) assert.equal((await getJson(server, `/api/usage/days?n=${n}`)).status, 400, n);
});
