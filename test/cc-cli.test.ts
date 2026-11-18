import { test } from "node:test";
import assert from "node:assert/strict";
import type { AgentEntry } from "../src/cc/agents.ts";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { ccDryRunLines, resetMultiline } from "../src/cli/cc-dry-run.ts";
import { CcSessionStore } from "../src/store/cc-sessions.ts";
import { MIGRATIONS, openDb } from "../src/store/db.ts";
import { tempDir } from "./helpers/db.ts";
import { CC_TOKEN_PLACEHOLDER, ccHookSettings, main as ccSetup } from "../src/cli/cc-setup.ts";

const S1 = "11111111-1111-4111-8111-111111111111";
const S2 = "22222222-2222-4222-8222-222222222222";
const S3 = "33333333-3333-4333-8333-333333333333";
const TOKEN = "c".repeat(40);

function agent(sessionId: string, overrides: Partial<AgentEntry> = {}): AgentEntry {
  return {
    pid: 1,
    sessionId,
    cwd: "/home/owner/workspace/hidden-dir",
    name: "name",
    kind: "interactive",
    startedAt: Date.parse("2026-11-01T00:00:00Z"),
    status: "idle",
    waitingFor: undefined,
    ...overrides,
  };
}

/** console.log・console.error を一時的に集める */
async function capture(run: () => Promise<number>): Promise<{ code: number; out: string[]; err: string[] }> {
  const out: string[] = [];
  const err: string[] = [];
  const log = console.log;
  const error = console.error;
  console.log = (text: string) => out.push(String(text));
  console.error = (text: string) => err.push(String(text));
  try {
    return { code: await run(), out, err };
  } finally {
    console.log = log;
    console.error = error;
  }
}

test("cc-setup: 6 つの事象に同じ url・headers・allowedEnvVars の http hook。timeout は 3 秒、PermissionRequest だけ保留（許可と質問の大きい方）+ 5 秒", () => {
  const settings = ccHookSettings({ ccPermissionHoldSec: 300, ccQuestionHoldSec: 200 }, 8792) as {
    env: Record<string, string>;
    hooks: Record<string, Array<{ matcher?: string; hooks: Array<Record<string, unknown>> }>>;
  };
  assert.deepEqual(settings.env, { SELF_AGENT_CC_HOOK_TOKEN: CC_TOKEN_PLACEHOLDER });
  // SessionStart は http hook に対応していないので出さない
  assert.deepEqual(Object.keys(settings.hooks), ["UserPromptSubmit", "Stop", "SessionEnd", "Notification", "PermissionRequest"]);
  for (const [event, groups] of Object.entries(settings.hooks)) {
    assert.equal(groups.length, 1);
    assert.equal(groups[0]!.matcher, undefined);
    assert.deepEqual(groups[0]!.hooks, [
      {
        type: "http",
        url: "http://127.0.0.1:8792/hook",
        timeout: event === "PermissionRequest" ? 305 : 3,
        headers: { "X-Self-Agent-Hook": "$SELF_AGENT_CC_HOOK_TOKEN" },
        allowedEnvVars: ["SELF_AGENT_CC_HOOK_TOKEN"],
      },
    ]);
  }
  const custom = ccHookSettings({ ccPermissionHoldSec: 60, ccQuestionHoldSec: 30 }, 1) as { hooks: Record<string, Array<{ hooks: Array<{ timeout: number }> }>> };
  assert.equal(custom.hooks.PermissionRequest![0]!.hooks[0]!.timeout, 65);
  // 質問の保留の方が長ければそちら + 5
  const question = ccHookSettings({ ccPermissionHoldSec: 300, ccQuestionHoldSec: 900 }, 1) as { hooks: Record<string, Array<{ hooks: Array<{ timeout: number }> }>> };
  assert.equal(question.hooks.PermissionRequest![0]!.hooks[0]!.timeout, 905);
});

test("cc-setup: --print は JSON を標準出力に出す（トークンの値は出さない）。--print が無ければ使い方で 2、ポートが無ければ 1", async () => {
  const env = { HOME: "/home/tester", SELF_AGENT_CC_HOOK_PORT: "8792", SELF_AGENT_CC_HOOK_TOKEN: TOKEN, SELF_AGENT_CC_PERMISSION_HOLD_SEC: "120", SELF_AGENT_CC_QUESTION_HOLD_SEC: "100" };
  const printed = await capture(() => ccSetup(["--print"], env));
  assert.equal(printed.code, 0);
  const json = JSON.parse(printed.out.join("\n")) as { hooks: Record<string, Array<{ hooks: Array<{ timeout: number }> }>> };
  assert.equal(json.hooks.PermissionRequest![0]!.hooks[0]!.timeout, 125);
  assert.ok(!printed.out.join("\n").includes(TOKEN));
  assert.ok(!printed.err.join("\n").includes(TOKEN));

  for (const argv of [[], ["--write"], ["--print", "x"]]) {
    const usage = await capture(() => ccSetup(argv, env));
    assert.equal(usage.code, 2, argv.join(" "));
    assert.deepEqual(usage.out, []);
    assert.match(usage.err.join("\n"), /使い方/);
  }
  const noPort = await capture(() => ccSetup(["--print"], { HOME: "/home/tester" }));
  assert.equal(noPort.code, 1);
  assert.match(noPort.err.join("\n"), /SELF_AGENT_CC_HOOK_PORT/);
  const badToken = await capture(() => ccSetup(["--print"], { ...env, SELF_AGENT_CC_HOOK_TOKEN: "short" }));
  assert.equal(badToken.code, 1);
  assert.match(badToken.err.join("\n"), /SELF_AGENT_CC_HOOK_TOKEN/);
});

test("cc-dry-run: 3 群の件数と、各行の状態・名前・最後の活動の時刻。sessionId・cwd は出さない", () => {
  const lines = ccDryRunLines(
    [
      { agent: agent(S1, { name: "idle-one" }), file: { bridgeSessionId: "session_a", tmux: "s:0.%1", procStart: undefined }, transcriptLastAt: Date.parse("2026-11-01T03:04:00Z") },
      { agent: agent(S2, { name: "busy\none", status: "busy" }), file: undefined, transcriptLastAt: undefined },
      { agent: agent(S3, { name: undefined, status: "waiting" }), file: { bridgeSessionId: undefined, tmux: undefined, procStart: undefined }, transcriptLastAt: undefined },
    ],
    2,
    "Asia/Tokyo",
  );
  assert.deepEqual(lines, [
    "Claude Code のセッション: 3 件（判断待ち 1・実行中 1・待機 1。形の合わない要素 2 件）",
    "判断待ち:",
    "  [判断待ち] （名前なし）（最後の活動 2026-11-01 09:00）",
    "実行中:",
    "  [実行中] busy one（最後の活動 2026-11-01 09:00）",
    "待機:",
    "  [待機] idle-one（最後の活動 2026-11-01 12:04）",
    "RC のリンクが読めたもの 1 件・tmux の欄が読めたもの 1 件",
    "（hook の事象は使っていないので、最後の活動は記録の更新か起動の時刻です。投稿していません。DB も変えていません）",
  ]);
  const text = lines.join("\n");
  for (const secret of [S1, S2, S3, "hidden-dir", "/home/owner"]) assert.ok(!text.includes(secret), secret);
});

test("cc-dry-run --reset-multiline: DB の multiline_ok だけを 1 に戻す。無い DB は作らず、古い DB は変えない", (t) => {
  const dir = tempDir(t);
  const path = join(dir, "self-agent.db");
  const out: string[] = [];
  const err: string[] = [];
  assert.equal(resetMultiline(path, (line) => out.push(line), (line) => err.push(line)), 1);
  assert.equal(existsSync(path), false);

  const db = openDb(path);
  const sessions = new CcSessionStore(db);
  sessions.upsertSeen([{ sessionId: S1, cwd: "/w/a", name: "a", pid: 1 }]);
  sessions.setMultilineOk(false);
  db.close();
  assert.equal(resetMultiline(path, (line) => out.push(line), (line) => err.push(line)), 0);
  assert.equal(resetMultiline(path, (line) => out.push(line), (line) => err.push(line)), 0);
  assert.equal(out.length, 2);
  const after = new DatabaseSync(path);
  t.after(() => after.close());
  assert.equal(new CcSessionStore(after).multilineOk(), true);
  assert.equal(new CcSessionStore(after).get(S1)?.name, "a");
  assert.equal(after.prepare("PRAGMA user_version").get()?.user_version, MIGRATIONS.length);

  const oldPath = join(dir, "old.db");
  const old = new DatabaseSync(oldPath);
  for (const migration of MIGRATIONS.slice(0, 26)) old.exec(migration);
  old.exec("PRAGMA user_version = 26");
  old.close();
  assert.equal(resetMultiline(oldPath, (line) => out.push(line), (line) => err.push(line)), 1);
  const reopened = new DatabaseSync(oldPath);
  t.after(() => reopened.close());
  assert.equal(reopened.prepare("PRAGMA user_version").get()?.user_version, 26);
  assert.equal(err.length, 2);
});
