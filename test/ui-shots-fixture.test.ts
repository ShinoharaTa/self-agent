// 画面写し（scripts/ui-shots.ts・scripts/ui-shots-fixture.ts。#386）。Chromium は起動しない:
// 作り物のデータでサーバーが答えること・閉じたら何も残らないこと・データに実在の ID やメールらしい物が無いこと・引数の誤りで exit 2・--only に合わなければ exit 1
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { startFixtureServer } from "../scripts/ui-shots-fixture.ts";
import { permissionHistoryText } from "../src/cc/channel-posts.ts";
import { CC_CHANNEL_ENDED_TEXT } from "../src/cc/channels.ts";
import { takeoverConfirmText } from "../src/cc/takeover.ts";

const FIXTURE_SOURCE = fileURLToPath(new URL("../scripts/ui-shots-fixture.ts", import.meta.url));
const SCRIPT = fileURLToPath(new URL("../scripts/ui-shots.ts", import.meta.url));
const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));

type TopicsJson = {
  turns: number;
  turnIds: string[];
  groups: Array<{ kind: string; name: string; turns: number; running: number; open: number }>;
  topics: Array<{ id: string }>;
  rightHands: Array<{ id: string }>;
};

/** port に TCP でつながるか */
function canConnect(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect({ host: "127.0.0.1", port });
    socket.once("connect", () => {
      socket.destroy();
      resolve(true);
    });
    socket.once("error", () => resolve(false));
  });
}

test("作り物のデータで本物のルートが答え、閉じたらポートも一時ディレクトリも残らない", async () => {
  const fixture = await startFixtureServer();
  const port = Number(new URL(fixture.url).port);
  assert.equal(existsSync(fixture.dir), true);
  assert.ok(fixture.clockNow().getTime() <= Date.now());
  try {
    const auth = { "Tailscale-User-Login": fixture.login };
    const topicsRes = await fetch(`${fixture.url}/api/topics`, { headers: auth });
    assert.equal(topicsRes.status, 200);
    const topics = (await topicsRes.json()) as TopicsJson;
    // あなたの番（許可の要求と質問）・実行中・プロジェクトの群・General・右腕
    assert.equal(topics.turns, 2);
    assert.deepEqual([...topics.turnIds].sort(), [`ch:${fixture.topics.perm}`, `ch:${fixture.topics.q}`].sort());
    assert.ok(topics.groups.some((group) => group.running >= 1));
    const projects = topics.groups.filter((group) => group.kind === "project").map((group) => group.name);
    assert.deepEqual([...projects].sort(), ["blog-site", "garden-sensor", "kakeibo-app"]);
    const general = topics.groups.find((group) => group.kind === "general");
    // 話題 2 つと #tasks
    assert.ok(general !== undefined && general.open >= 2, JSON.stringify(general));
    assert.equal(topics.rightHands.length, 1);
    assert.ok(topics.topics.some((topic) => topic.id === `ch:${fixture.topics.open}`));

    // 会話・ナレッジ・タスク
    const turnsRes = await fetch(`${fixture.url}/api/channels/${fixture.topics.open}/turns`, { headers: auth });
    assert.equal(turnsRes.status, 200);
    assert.ok(JSON.stringify(await turnsRes.json()).includes("家計簿アプリの集計の直し方"));
    const knowledgeRes = await fetch(`${fixture.url}/api/knowledge`, { headers: auth });
    assert.equal(knowledgeRes.status, 200);
    assert.ok(JSON.stringify(await knowledgeRes.json()).includes("CSS の container queries"));
    const tasksRes = await fetch(`${fixture.url}/api/tasks`, { headers: auth });
    assert.equal(tasksRes.status, 200);
    assert.ok(JSON.stringify(await tasksRes.json()).includes("図書館の本を返す"));

    // 吹き出しの確かめ・長い会話（General の話題）
    assert.ok(topics.topics.some((topic) => topic.id === `ch:${fixture.topics.talk}`));
    assert.ok(topics.topics.some((topic) => topic.id === `ch:${fixture.topics.long}`));
    type TurnsJson = { turns: Array<{ id: number; kind: string; outcome?: string | null }>; hasMore: boolean };
    const talkRes = await fetch(`${fixture.url}/api/channels/${fixture.topics.talk}/turns`, { headers: auth });
    assert.equal(talkRes.status, 200);
    const talk = (await talkRes.json()) as TurnsJson;
    assert.ok(talk.turns.some((turn) => turn.kind === "divider"));
    assert.ok(talk.turns.some((turn) => turn.outcome === "failed"));
    assert.ok(talk.turns.some((turn) => turn.outcome === "aborted"));
    // 長い会話: 最新の 50 行（前があるかは画面が件数で決める）。前の 10 行は before で読める
    const longRes = await fetch(`${fixture.url}/api/channels/${fixture.topics.long}/turns`, { headers: auth });
    assert.equal(longRes.status, 200);
    const long = (await longRes.json()) as TurnsJson;
    assert.equal(long.turns.length, 50);
    assert.equal(long.turns.at(-1)?.outcome, "max_turns");
    const olderRes = await fetch(`${fixture.url}/api/channels/${fixture.topics.long}/turns?before=${long.turns[0]?.id}&limit=50`, { headers: auth });
    assert.equal(olderRes.status, 200);
    const older = (await olderRes.json()) as TurnsJson;
    assert.equal(older.turns.length, 10);
    assert.equal(older.hasMore, false);

    // ヘッダ無しは通らない（今の認証のまま）
    const anonymous = await fetch(`${fixture.url}/api/topics`);
    assert.equal(anonymous.status, 401);
    await anonymous.body?.cancel();
  } finally {
    await fixture.close();
  }
  assert.equal(await canConnect(port), false);
  assert.equal(existsSync(fixture.dir), false);
  // 2 回目の close は何もしない
  await fixture.close();
});

test("cc: true では Claude Code の連携が動き、チャンネル 3 つ（届け待ち・許可・終わった）と届け待ちの取り消し・reset が本物のルートで答える", async () => {
  const fixture = await startFixtureServer({ cc: true });
  try {
    const cc = fixture.cc;
    assert.ok(cc !== undefined);
    const auth = { "Tailscale-User-Login": fixture.login };
    const post = { ...auth, "Sec-Fetch-Site": "same-origin", "X-Self-Agent": "1", "Content-Type": "application/json" };
    const get = async (path: string): Promise<{ status: number; json: Record<string, unknown> }> => {
      const res = await fetch(`${fixture.url}${path}`, { headers: auth });
      return { status: res.status, json: (await res.json()) as Record<string, unknown> };
    };
    const status = await get("/api/status");
    assert.equal(status.status, 200);
    assert.equal((status.json.cc as { enabled: boolean }).enabled, true);
    assert.equal((status.json.cc as { unifyReady: boolean }).unifyReady, true);

    // /api/channels: kind cc が 3 つ。終わったチャンネルは ended
    const channels = (await get("/api/channels")).json.channels as Array<{ id: string; kind: string; cc?: { sessionId: string; state: string; pending: { id: number; state: string } | null; permission: { state: string } | null } }>;
    const ccRows = channels.filter((c) => c.kind === "cc");
    assert.deepEqual(ccRows.map((c) => c.id).sort(), [cc.queue, cc.ask, cc.ended].sort());
    const byId = new Map(ccRows.map((c) => [c.id, c.cc!]));
    assert.equal(byId.get(cc.ended)!.state, "ended");
    assert.equal(byId.get(cc.ask)!.permission?.state, "pending");
    const a = byId.get(cc.queue)!.sessionId;
    const ended = byId.get(cc.ended)!.sessionId;
    for (const row of ccRows) assert.match(row.cc!.sessionId, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-8[0-9a-f]{3}-[0-9a-f]{12}$/);

    // /api/topics: 動いている 2 つはそのプロジェクトの群の行、終わった 1 つはその群の完了（?done=）の行
    type Topics = { topics: Array<{ id: string; group: string; state: string }> };
    const topics = (await get("/api/topics")).json as Topics;
    const rowOf = (list: Topics, id: string) => list.topics.find((topic) => topic.id === `ch:${id}`);
    assert.deepEqual([rowOf(topics, cc.queue)?.state, rowOf(topics, cc.ask)?.state, rowOf(topics, cc.ended)], ["active", "active", undefined]);
    const done = (await get(`/api/topics?done=${encodeURIComponent("p:blog-site")}`)).json as Topics;
    assert.equal(rowOf(done, cc.ended)?.state, "done");

    // 会話・セッション（届け待ち）・終わったセッションは 404
    const turns = await get(`/api/channels/${cc.queue}/turns`);
    assert.equal(turns.status, 200);
    assert.ok((turns.json.turns as unknown[]).length >= 2);
    // 許可・終わったチャンネルの最後の行は、本体が残すのと同じ知らせ（notice）の行
    type Turn = { kind: string; text: string };
    const lastTurn = async (id: string): Promise<Turn> => ((await get(`/api/channels/${id}/turns`)).json.turns as Turn[]).at(-1)!;
    assert.deepEqual(await lastTurn(cc.ask), { ...(await lastTurn(cc.ask)), kind: "notice", text: permissionHistoryText({ toolName: "Bash", summary: "npm update --save", questionInput: null }) });
    assert.deepEqual(await lastTurn(cc.ended), { ...(await lastTurn(cc.ended)), kind: "notice", text: CC_CHANNEL_ENDED_TEXT });
    assert.equal((await lastTurn(cc.queue)).kind, "owner");
    const session = await get(`/api/cc/sessions/${a}`);
    assert.equal(session.status, 200);
    const pending = session.json.pending as { id: number; state: string };
    assert.equal(pending.state, "queued");
    assert.equal(typeof session.json.screen, "string");
    assert.equal((await get(`/api/cc/sessions/${ended}`)).status, 404);

    // 取り消すと cancelled。reset でまた queued（新しい行）
    const cancel = await fetch(`${fixture.url}/api/cc/sends/${pending.id}/cancel`, { method: "POST", headers: post, body: "{}" });
    assert.equal(cancel.status, 200);
    await cancel.body?.cancel();
    assert.equal(((await get(`/api/cc/sessions/${a}`)).json.pending as { state: string }).state, "cancelled");
    cc.reset();
    const again = (await get(`/api/cc/sessions/${a}`)).json.pending as { id: number; state: string };
    assert.equal(again.state, "queued");
    assert.notEqual(again.id, pending.id);

    // 許可に答えると終わり、reset で新しい保留が 1 つ
    const perms = (await get("/api/cc/permissions")).json.permissions as Array<{ id: number; requestHash: string }>;
    assert.equal(perms.length, 1);
    const allow = await fetch(`${fixture.url}/api/cc/permissions/${perms[0]!.id}/allow`, { method: "POST", headers: post, body: JSON.stringify({ requestHash: perms[0]!.requestHash }) });
    assert.equal(allow.status, 200);
    await allow.body?.cancel();
    assert.equal(((await get("/api/cc/permissions")).json.permissions as unknown[]).length, 0);
    cc.reset();
    const fresh = (await get("/api/cc/permissions")).json.permissions as Array<{ id: number }>;
    assert.equal(fresh.length, 1);
    assert.notEqual(fresh[0]!.id, perms[0]!.id);
  } finally {
    await fixture.close();
  }
});

test("cc: true では、チャンネルの無い待機のセッションが 1 つ在り（cc: の行）、取り込みの 4 つのルートが作り物の本体で答える", async () => {
  const fixture = await startFixtureServer({ cc: true });
  try {
    const cc = fixture.cc;
    assert.ok(cc !== undefined);
    const auth = { "Tailscale-User-Login": fixture.login };
    const post = { ...auth, "Sec-Fetch-Site": "same-origin", "X-Self-Agent": "1", "Content-Type": "application/json" };
    const get = async (path: string): Promise<{ status: number; json: Record<string, unknown> }> => {
      const res = await fetch(`${fixture.url}${path}`, { headers: auth });
      return { status: res.status, json: (await res.json()) as Record<string, unknown> };
    };
    const send = async (path: string): Promise<{ status: number; json: Record<string, unknown> }> => {
      const res = await fetch(`${fixture.url}${path}`, { method: "POST", headers: post, body: "{}" });
      return { status: res.status, json: (await res.json()) as Record<string, unknown> };
    };
    // 一覧: 待機のセッションは cc: の行で、あなたの番・作業中に入らない
    type Topics = { topics: Array<{ id: string; title: string; group: string; mark: string | null; state: string }>; turnIds: string[] };
    const topics = (await get("/api/topics")).json as Topics;
    const row = topics.topics.find((t) => t.id === `cc:${cc.term}`);
    assert.ok(row, "cc: の行");
    assert.deepEqual([row.title, row.group, row.mark, row.state], ["見本の調べもの", "p:kakeibo-app", null, "active"]);
    assert.equal(topics.turnIds.includes(row.id), false);
    // 判定: 4 つ目は取り込める、ほかは busy
    const check = await get(`/api/cc/sessions/${cc.term}/takeover`);
    assert.equal(check.status, 200);
    assert.deepEqual([check.json.takeable, check.json.state, check.json.reason, check.json.title, check.json.project, check.json.rcUrl, check.json.last], [true, "idle", null, "見本の調べもの", "kakeibo-app", null, null]);
    assert.equal(typeof check.json.activityAt, "string");
    const channels = (await get("/api/channels")).json.channels as Array<{ id: string; kind: string; cc?: { sessionId: string } }>;
    const other = channels.find((c) => c.id === cc.queue)!.cc!.sessionId;
    const busy = await get(`/api/cc/sessions/${other}/takeover`);
    assert.deepEqual([busy.json.takeable, busy.json.reason, busy.json.state], [false, "busy", "running"]);
    // 確認を作る: 本物の確認の文
    const propose = await send(`/api/cc/sessions/${cc.term}/takeover`);
    assert.equal(propose.status, 201);
    assert.deepEqual(propose.json, { id: 1, text: takeoverConfirmText({ title: "見本の調べもの", project: "kakeibo-app", source: "alive", permissionMode: "default", terminalMode: null }, false) });
    assert.match(String(propose.json.text), /を取り込みます。/);
    // やめるは通り、進めるは使えない確認、知らない番号は 404
    assert.deepEqual((await send("/api/cc/takeovers/1/cancel")).json, { ok: true });
    const confirm = await send("/api/cc/takeovers/1/confirm");
    assert.deepEqual([confirm.status, confirm.json.error], [409, "stale"]);
    assert.equal((await send("/api/cc/takeovers/2/confirm")).status, 404);
  } finally {
    await fixture.close();
  }
});

test("cc なしでは Claude Code の連携は無効で、kind cc のチャンネルも Claude Code のルートも無い", async () => {
  const fixture = await startFixtureServer();
  try {
    assert.equal(fixture.cc, undefined);
    const auth = { "Tailscale-User-Login": fixture.login };
    const status = (await (await fetch(`${fixture.url}/api/status`, { headers: auth })).json()) as { cc: { enabled: boolean } };
    assert.equal(status.cc.enabled, false);
    const channels = (await (await fetch(`${fixture.url}/api/channels`, { headers: auth })).json()) as { channels: Array<{ kind: string }> };
    assert.equal(channels.channels.filter((c) => c.kind === "cc").length, 0);
    const sessions = await fetch(`${fixture.url}/api/cc/sessions`, { headers: auth });
    assert.equal(sessions.status, 404);
    await sessions.body?.cancel();
    // 取り込みのルートも無い
    const uuid = "c0de0d04-0000-4000-8000-0000000000d4";
    const post = { ...auth, "Sec-Fetch-Site": "same-origin", "X-Self-Agent": "1", "Content-Type": "application/json" };
    for (const [method, path] of [
      ["GET", `/api/cc/sessions/${uuid}/takeover`],
      ["POST", `/api/cc/sessions/${uuid}/takeover`],
      ["POST", "/api/cc/takeovers/1/confirm"],
      ["POST", "/api/cc/takeovers/1/cancel"],
    ] as const) {
      const res = await fetch(`${fixture.url}${path}`, method === "GET" ? { headers: auth } : { method, headers: post, body: "{}" });
      assert.equal(res.status, 404, `${method} ${path}`);
      await res.body?.cancel();
    }
  } finally {
    await fixture.close();
  }
});

test("作り物のデータに、Discord の ID らしい数字・実在のメールらしい物が無い", () => {
  const source = readFileSync(FIXTURE_SOURCE, "utf8");
  assert.deepEqual(source.match(/(?<!\d)\d{17,20}(?!\d)/g) ?? [], []);
  const emails = (source.match(/[\w.+-]+@[\w-]+(?:\.[\w-]+)*\.[A-Za-z]{2,}(?![\w.-])/g) ?? []).filter((email) => !email.endsWith("@example.test"));
  assert.deepEqual(emails, []);
});

test("ui-shots: --out が無い・知らない引数・リポジトリの中の --out は exit 2（Chromium は起動しない）", () => {
  const run = (args: string[]) => spawnSync(process.execPath, [SCRIPT, ...args], { encoding: "utf8", timeout: 30_000 });
  const none = run([]);
  assert.equal(none.status, 2);
  assert.match(none.stderr, /使い方/);
  const unknown = run(["--out", tmpdir(), "--bogus"]);
  assert.equal(unknown.status, 2);
  const inside = `${REPO_ROOT}ui-shots-out-should-not-exist`;
  const repo = run(["--out", inside]);
  assert.equal(repo.status, 2);
  assert.match(repo.stderr, /リポジトリの中/);
  assert.equal(existsSync(inside), false);
  // `..` で始まる名前もリポジトリの中
  const dotted = `${REPO_ROOT}..shots-x`;
  const dottedRun = run(["--out", dotted]);
  assert.equal(dottedRun.status, 2);
  assert.equal(existsSync(dotted), false);
  const root = run(["--out", REPO_ROOT]);
  assert.equal(root.status, 2);
});

test("ui-shots: --only に合う画面が無ければ Chromium を起動せずに exit 1", () => {
  const out = join(mkdtempSync(join(tmpdir(), "ui-shots-only-")), "out");
  // Chromium を探しに行けば入れ方の文が出る（空のディレクトリ）
  const browsers = mkdtempSync(join(tmpdir(), "ui-shots-browsers-"));
  try {
    const result = spawnSync(process.execPath, [SCRIPT, "--out", out, "--only", "zzz"], {
      encoding: "utf8",
      timeout: 30_000,
      env: { ...process.env, PLAYWRIGHT_BROWSERS_PATH: browsers },
    });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /--only zzz に合う画面が無い（例: phone-dark-a-list/);
    assert.doesNotMatch(result.stderr, /Chromium が見つからない/);
    assert.equal(existsSync(out), false);
  } finally {
    rmSync(dirname(out), { recursive: true, force: true });
    rmSync(browsers, { recursive: true, force: true });
  }
});
