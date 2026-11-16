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
