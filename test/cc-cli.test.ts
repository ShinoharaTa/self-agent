import { test } from "node:test";
import assert from "node:assert/strict";
import type { AgentEntry } from "../src/cc/agents.ts";
import { ccDryRunLines } from "../src/cli/cc-dry-run.ts";
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

test("cc-setup: 6 つの事象に同じ url・headers・allowedEnvVars の http hook。timeout は 3 秒、PermissionRequest だけ保留 + 5 秒", () => {
  const settings = ccHookSettings({ ccPermissionHoldSec: 300 }, 8792) as {
    env: Record<string, string>;
    hooks: Record<string, Array<{ matcher?: string; hooks: Array<Record<string, unknown>> }>>;
  };
  assert.deepEqual(settings.env, { SELF_AGENT_CC_HOOK_TOKEN: CC_TOKEN_PLACEHOLDER });
  assert.deepEqual(Object.keys(settings.hooks), ["SessionStart", "UserPromptSubmit", "Stop", "SessionEnd", "Notification", "PermissionRequest"]);
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
  const custom = ccHookSettings({ ccPermissionHoldSec: 60 }, 1) as { hooks: Record<string, Array<{ hooks: Array<{ timeout: number }> }>> };
  assert.equal(custom.hooks.PermissionRequest![0]!.hooks[0]!.timeout, 65);
});

test("cc-setup: --print は JSON を標準出力に出す（トークンの値は出さない）。--print が無ければ使い方で 2、ポートが無ければ 1", async () => {
  const env = { HOME: "/home/tester", SELF_AGENT_CC_HOOK_PORT: "8792", SELF_AGENT_CC_HOOK_TOKEN: TOKEN, SELF_AGENT_CC_PERMISSION_HOLD_SEC: "120" };
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
      { agent: agent(S1, { name: "idle-one" }), file: { bridgeSessionId: "session_a", tmux: "s:0.%1" }, transcriptMtime: Date.parse("2026-11-01T03:04:00Z") },
      { agent: agent(S2, { name: "busy\none", status: "busy" }), file: undefined, transcriptMtime: undefined },
      { agent: agent(S3, { name: undefined, status: "waiting" }), file: { bridgeSessionId: undefined, tmux: undefined }, transcriptMtime: undefined },
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
