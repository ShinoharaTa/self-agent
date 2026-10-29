import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { join } from "node:path";
import { formatDevLogRecord } from "../src/devlog/format.ts";
import type { DevLogRecord } from "../src/devlog/log.ts";
import { DEVLOG_UNREADABLE_TEXT, devlogRoutes } from "../src/web/routes/devlog.ts";
import { createWebServer, type WebServer } from "../src/web/server.ts";
import { tempDir } from "./helpers/db.ts";
import { turnUsage } from "./helpers/runner.ts";

const LOGIN = "owner@example.com";
/** 2026-10-02(金) 09:12 JST */
const NOW = new Date("2026-10-02T00:12:00Z");
const TZ = "Asia/Tokyo";

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

function record(at: string, kind: DevLogRecord["kind"], channelId: string | null, extra: Partial<DevLogRecord> = {}): DevLogRecord {
  return {
    at,
    durationMs: 12_000,
    guildId: channelId === null ? null : "111",
    channelId,
    kind,
    model: "claude-opus-5",
    effort: null,
    maxTurns: 8,
    resume: null,
    prompt: `[${at}] こんにちは`,
    steps: [{ t: "text", text: "はい" }],
    result: { ok: true, text: "はい", sessionId: "s", usage: turnUsage(1, 2, 3), toolCalls: 2, contextTokens: 6 },
    ...extra,
  };
}

async function setup(t: TestContext, devMode: boolean) {
  const dataDir = tempDir(t);
  const server = createWebServer({
    host: "127.0.0.1",
    port: 0,
    allowedLogin: LOGIN,
    staticDir: tempDir(t),
    templateSiteDir: tempDir(t),
    routes: devlogRoutes({ cfg: { devMode, dataDir, timeZone: TZ }, now: () => NOW }),
    stopping: () => false,
    now: () => NOW,
    log: () => undefined,
  });
  await server.start();
  t.after(() => server.close());
  return { server, dir: join(dataDir, "devlog") };
}

test("/api/devlog: dev モードでなければ /api/devlog/days も /api/devlog も 404", async (t) => {
  const { server, dir } = await setup(t, false);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "2026-10-02.jsonl"), `${JSON.stringify(record("2026-10-02T00:00:00Z", "inbox", "100"))}\n`);
  for (const path of ["/api/devlog/days", "/api/devlog", "/api/devlog?date=2026-10-02"]) {
    const { status, json } = await getJson(server, path);
    assert.equal(status, 404, path);
    assert.deepEqual(json, { error: "not_found" });
  }
});

test("/api/devlog/days: ディレクトリが無ければ空、あれば YYYY-MM-DD.jsonl の新しい順と行数（ほかの名前は数えない）", async (t) => {
  const { server, dir } = await setup(t, true);
  assert.deepEqual((await getJson(server, "/api/devlog/days")).json, []);
  mkdirSync(dir, { recursive: true });
  const line = JSON.stringify(record("2026-10-01T00:00:00Z", "inbox", "100"));
  writeFileSync(join(dir, "2026-09-30.jsonl"), `${line}\n`);
  writeFileSync(join(dir, "2026-10-01.jsonl"), `${line}\n${line}\n\n${line}\n`);
  writeFileSync(join(dir, "notes.txt"), "x\n");
  writeFileSync(join(dir, "2026-10-1.jsonl"), `${line}\n`);
  mkdirSync(join(dir, "2026-10-02.jsonl"));
  const { status, json } = await getJson(server, "/api/devlog/days");
  assert.equal(status, 200);
  assert.deepEqual(json, [
    { date: "2026-10-01", count: 3 },
    { date: "2026-09-30", count: 1 },
  ]);
});

test("/api/devlog: 既定は今日（SELF_AGENT_TZ）の最後の 20 件。kind・channel・persona・last で絞り、text は npm run devlog と同じ", async (t) => {
  const { server, dir } = await setup(t, true);
  mkdirSync(dir, { recursive: true });
  const records = [
    record("2026-10-01T15:30:00Z", "inbox", "100"),
    record("2026-10-01T15:40:00Z", "session", "200", {
      persona: "mika",
      durationMs: 65_000,
      result: { ok: false, errorMessage: "timeout", sessionRecorded: false, toolCalls: 4 },
    }),
    record("2026-10-01T15:50:00Z", null, null),
  ];
  // 2026-10-02 JST のファイル。壊れた行は飛ばす
  writeFileSync(join(dir, "2026-10-02.jsonl"), [...records.map((r) => JSON.stringify(r)), "{壊れた行", JSON.stringify({ at: 1 })].join("\n") + "\n");

  const today = await getJson(server, "/api/devlog");
  assert.equal(today.status, 200);
  const body = today.json as { date: string; records: Array<Record<string, unknown>> };
  assert.equal(body.date, "2026-10-02");
  assert.deepEqual(
    body.records.map((r) => [r.at, r.kind, r.channelId, r.persona, r.ok, r.durationMs, r.toolCalls]),
    [
      ["2026-10-01T15:30:00Z", "inbox", "100", "default", true, 12_000, 2],
      ["2026-10-01T15:40:00Z", "session", "200", "mika", false, 65_000, 4],
      ["2026-10-01T15:50:00Z", null, null, "default", true, 12_000, 2],
    ],
  );
  assert.equal(body.records[1]!.text, formatDevLogRecord(records[1]!, TZ));

  const filtered = async (query: string) =>
    ((await getJson(server, `/api/devlog?date=2026-10-02&${query}`)).json as { records: Array<Record<string, unknown>> }).records.map(
      (r) => r.at,
    );
  assert.deepEqual(await filtered("kind=session"), ["2026-10-01T15:40:00Z"]);
  assert.deepEqual(await filtered("channel=100"), ["2026-10-01T15:30:00Z"]);
  assert.deepEqual(await filtered("persona=default"), ["2026-10-01T15:30:00Z", "2026-10-01T15:50:00Z"]);
  assert.deepEqual(await filtered("last=1"), ["2026-10-01T15:50:00Z"]);
  assert.deepEqual(await filtered("kind="), ["2026-10-01T15:30:00Z", "2026-10-01T15:40:00Z", "2026-10-01T15:50:00Z"]);

  // ファイルの無い日は空
  assert.deepEqual((await getJson(server, "/api/devlog?date=2026-09-01")).json, { date: "2026-09-01", records: [] });
});

test("/api/devlog: steps の要素が壊れた行があっても 200 で、その行の text は（読めない記録）。ほかの項目と行はそのまま", async (t) => {
  const { server, dir } = await setup(t, true);
  mkdirSync(dir, { recursive: true });
  const good = record("2026-10-01T15:30:00Z", "inbox", "100");
  const broken = { ...record("2026-10-01T15:40:00Z", "session", "200"), steps: [null] };
  writeFileSync(join(dir, "2026-10-02.jsonl"), `${JSON.stringify(broken)}\n${JSON.stringify(good)}\n`);
  const { status, json } = await getJson(server, "/api/devlog?date=2026-10-02");
  assert.equal(status, 200);
  const body = json as { records: Array<Record<string, unknown>> };
  assert.deepEqual(
    body.records.map((r) => [r.at, r.kind, r.channelId, r.ok, r.toolCalls, r.text]),
    [
      ["2026-10-01T15:40:00Z", "session", "200", true, 2, DEVLOG_UNREADABLE_TEXT],
      ["2026-10-01T15:30:00Z", "inbox", "100", true, 2, formatDevLogRecord(good, TZ)],
    ],
  );
});

test("/api/devlog: <date>.jsonl がディレクトリ・symlink なら、その日は記録なし（/days と同じく数えない）", async (t) => {
  const { server, dir } = await setup(t, true);
  mkdirSync(dir, { recursive: true });
  mkdirSync(join(dir, "2026-10-02.jsonl"));
  const target = join(tempDir(t), "other.jsonl");
  writeFileSync(target, `${JSON.stringify(record("2026-10-01T15:30:00Z", "inbox", "100"))}\n`);
  symlinkSync(target, join(dir, "2026-10-01.jsonl"));
  assert.deepEqual(await getJson(server, "/api/devlog"), { status: 200, json: { date: "2026-10-02", records: [] } });
  assert.deepEqual(await getJson(server, "/api/devlog?date=2026-10-01"), { status: 200, json: { date: "2026-10-01", records: [] } });
  assert.deepEqual((await getJson(server, "/api/devlog/days")).json, []);
});

test("/api/devlog: 日付の形・kind・channel・persona・last が違えば 400", async (t) => {
  const { server } = await setup(t, true);
  for (const query of [
    "date=2026-1-02",
    "date=../x",
    "date=",
    "kind=other",
    "channel=abc",
    "persona=Mika",
    "last=0",
    "last=201",
    "last=x",
  ]) {
    const { status, json } = await getJson(server, `/api/devlog?${query}`);
    assert.equal(status, 400, query);
    assert.deepEqual(json, { error: "bad_request" });
  }
  assert.equal((await getJson(server, "/api/devlog?last=200")).status, 200);
});
