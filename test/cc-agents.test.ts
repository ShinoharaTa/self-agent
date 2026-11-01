import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { AGENTS_ARGS, AgentsClient, agentsChildEnv, parseAgentsOutput, resolveClaudePath, resolveTmuxPath } from "../src/cc/agents.ts";
import { ClaudeDirs, projectDirName } from "../src/cc/claude-dirs.ts";
import { resolveCommandPath } from "../src/github/gh.ts";
import { CHILD_MAX_BUFFER, CHILD_PATH, CHILD_TIMEOUT_MS, type RunCommand } from "../src/tmux/tmux.ts";
import { tempDir } from "./helpers/db.ts";

const S1 = "11111111-1111-4111-8111-111111111111";
const S2 = "22222222-2222-4222-8222-222222222222";

test("AgentsClient: 絶対パスの claude を固定の引数で呼び、env は HOME・PATH・LANG だけ（20 秒・5 MB）", async () => {
  const calls: Array<{ file: string; args: readonly string[]; options: Parameters<RunCommand>[2] }> = [];
  const run: RunCommand = async (file, args, options) => {
    calls.push({ file, args, options });
    return { code: 0, stdout: JSON.stringify([{ pid: 10, sessionId: S1, status: "idle" }]), stderr: "" };
  };
  const client = new AgentsClient({ claudePath: "/home/o/.local/bin/claude", run, home: "/home/o" });
  const result = await client.list();
  assert.equal(result.ok, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.file, "/home/o/.local/bin/claude");
  assert.deepEqual(calls[0]!.args, ["agents", "--json"]);
  assert.deepEqual(AGENTS_ARGS, ["agents", "--json"]);
  assert.deepEqual(calls[0]!.options.env, { HOME: "/home/o", PATH: "/home/o/.local/bin:/usr/local/bin:/usr/bin:/bin", LANG: "C.UTF-8" });
  assert.deepEqual(agentsChildEnv("/home/o"), calls[0]!.options.env);
  assert.equal(calls[0]!.options.timeoutMs, CHILD_TIMEOUT_MS);
  assert.equal(calls[0]!.options.maxBuffer, CHILD_MAX_BUFFER);
  assert.throws(() => new AgentsClient({ claudePath: "claude", run }));
});

test("AgentsClient: 終了コードが 0 でない（起動できない・時間切れ・上限を含む）なら失敗", async () => {
  for (const code of [1, null]) {
    const client = new AgentsClient({ claudePath: "/bin/claude", run: async () => ({ code, stdout: "[]", stderr: "" }) });
    assert.deepEqual(await client.list(), { ok: false, reason: "exited" });
  }
});

test("parseAgentsOutput: JSON でない・配列でないなら失敗。pid が無い・sessionId が UUID でない要素は捨てて数え、未知の欄は無視する", () => {
  assert.deepEqual(parseAgentsOutput("not json"), { ok: false, reason: "json" });
  assert.deepEqual(parseAgentsOutput(""), { ok: false, reason: "json" });
  assert.deepEqual(parseAgentsOutput('{"agents":[]}'), { ok: false, reason: "shape" });
  assert.deepEqual(parseAgentsOutput("null"), { ok: false, reason: "shape" });
  const result = parseAgentsOutput(
    JSON.stringify([
      { pid: 10, sessionId: S1, cwd: "/w/a", kind: "interactive", startedAt: 1000, name: "a", status: "busy", extra: { x: 1 } },
      { sessionId: S2, status: "idle" },
      { pid: "11", sessionId: S2 },
      { pid: 12, sessionId: "not-a-uuid" },
      { pid: 13, sessionId: S1 },
      { pid: 14, sessionId: S2, status: "waiting", waitingFor: "permission prompt", name: 5, startedAt: "x" },
      "string",
      null,
    ]),
  );
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.dropped, 6);
  assert.deepEqual(result.agents, [
    { pid: 10, sessionId: S1, cwd: "/w/a", name: "a", kind: "interactive", startedAt: 1000, status: "busy", waitingFor: undefined },
    {
      pid: 14,
      sessionId: S2,
      cwd: undefined,
      name: undefined,
      kind: undefined,
      startedAt: undefined,
      status: "waiting",
      waitingFor: "permission prompt",
    },
  ]);
});

test("ClaudeDirs.sessionFile: bridgeSessionId・tmux を読む。形が合わない欄は undefined、壊れた・別のセッション・無いファイルは undefined（例外にしない）", (t) => {
  const home = tempDir(t);
  const sessions = join(home, ".claude", "sessions");
  mkdirSync(sessions, { recursive: true });
  writeFileSync(
    join(sessions, "10.json"),
    JSON.stringify({ pid: 10, sessionId: S1, bridgeSessionId: "session_abcDEF123", tmux: "self-agent:0.%12", name: "a", cwd: "/w/a" }),
  );
  writeFileSync(join(sessions, "11.json"), JSON.stringify({ pid: 11, sessionId: S1, bridgeSessionId: "https://evil", tmux: "a\nb:0.%1" }));
  writeFileSync(join(sessions, "12.json"), "{broken");
  writeFileSync(join(sessions, "13.json"), JSON.stringify({ pid: 13, sessionId: S2, bridgeSessionId: "session_x" }));
  writeFileSync(join(sessions, "14.json"), "[]");
  // sessionId の欄が無いファイルは、どのセッションのものか分からないので読まない
  writeFileSync(join(sessions, "15.json"), JSON.stringify({ pid: 15, bridgeSessionId: "session_nosid", tmux: "s:0.%1" }));
  // 鍵のファイルは読まない（あっても結果は変わらない）
  writeFileSync(join(sessions, "10.abcdef.key"), "secret");
  const dirs = new ClaudeDirs(home);
  assert.deepEqual(dirs.sessionFile(10, S1), { bridgeSessionId: "session_abcDEF123", tmux: "self-agent:0.%12" });
  assert.deepEqual(dirs.sessionFile(11, S1), { bridgeSessionId: undefined, tmux: undefined });
  assert.equal(dirs.sessionFile(12, S1), undefined);
  assert.equal(dirs.sessionFile(13, S1), undefined);
  assert.equal(dirs.sessionFile(14, S1), undefined);
  assert.equal(dirs.sessionFile(15, S1), undefined);
  assert.equal(dirs.sessionFile(99, S1), undefined);
  assert.equal(dirs.sessionFile(-1, S1), undefined);
  assert.equal(new ClaudeDirs(join(home, "nothing")).sessionFile(10, S1), undefined);
});

test("ClaudeDirs.transcriptMtime: projects/<cwd を - に>/<sessionId>.jsonl の mtime。無ければ undefined", (t) => {
  const home = tempDir(t);
  assert.equal(projectDirName("/home/o/workspace/self-agent"), "-home-o-workspace-self-agent");
  const dir = join(home, ".claude", "projects", projectDirName("/w/my.app"));
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${S1}.jsonl`);
  writeFileSync(file, '{"type":"user"}\n');
  const mtime = new Date("2026-10-31T12:00:00.000Z");
  utimesSync(file, mtime, mtime);
  const dirs = new ClaudeDirs(home);
  assert.equal(dirs.transcriptMtime("/w/my.app", S1), mtime.getTime());
  assert.equal(dirs.transcriptMtime("/w/my.app", S2), undefined);
  assert.equal(dirs.transcriptMtime("/w/other", S1), undefined);
  assert.equal(dirs.transcriptMtime("/w/my.app", "../x"), undefined);
});

test("resolveClaudePath・resolveTmuxPath: 子と同じ固定の PATH（claude は ~/.local/bin が先）で探し、無ければ PATH。どちらにも無ければ undefined", (t) => {
  const root = tempDir(t);
  const home = join(root, "home");
  const extra = join(root, "extra");
  const empty = join(root, "empty");
  for (const dir of [join(home, ".local", "bin"), extra, empty]) mkdirSync(dir, { recursive: true });
  const executable = (path: string): string => {
    writeFileSync(path, "#!/bin/sh\n");
    chmodSync(path, 0o755);
    return path;
  };
  const inExtra = executable(join(extra, "claude"));
  // ~/.local/bin に無ければ PATH（ほかに /usr/local/bin などにあればそれが先）
  const fixed = resolveCommandPath("claude", "/usr/local/bin:/usr/bin:/bin");
  assert.equal(resolveClaudePath(home, extra), fixed ?? inExtra);
  if (fixed === undefined) assert.equal(resolveClaudePath(home, empty), undefined);
  // ~/.local/bin にあればそれが先（PATH に無くても）
  const local = executable(join(home, ".local", "bin", "claude"));
  assert.equal(resolveClaudePath(home, undefined), local);
  assert.equal(resolveClaudePath(home, extra), local);
  // 実行できないファイルは採らない
  writeFileSync(join(empty, "tmux"), "");
  const tmuxFixed = resolveCommandPath("tmux", CHILD_PATH);
  assert.equal(resolveTmuxPath(empty), tmuxFixed);
  const tmuxExtra = executable(join(extra, "tmux"));
  assert.equal(resolveTmuxPath(extra), tmuxFixed ?? tmuxExtra);
});
