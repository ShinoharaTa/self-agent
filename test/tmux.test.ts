import { test } from "node:test";
import assert from "node:assert/strict";
import {
  CHILD_MAX_BUFFER,
  CHILD_PATH,
  CHILD_TIMEOUT_MS,
  CLIENT_FORMAT,
  createTmux,
  execFileRunner,
  handoffBufferName,
  PANE_FORMAT,
  parsePanes,
  type RunCommand,
  type RunResult,
} from "../src/tmux/tmux.ts";

const TMUX = "/usr/bin/tmux";

type Call = { file: string; args: readonly string[]; env: Record<string, string>; timeoutMs: number; maxBuffer: number; input?: string };

/** 呼び出しを記録し、result を返す偽の実行 */
function fakeRun(result: RunResult = { code: 0, stdout: "", stderr: "" }) {
  const calls: Call[] = [];
  const state = { result };
  const run: RunCommand = async (file, args, options) => {
    calls.push({ file, args, ...options });
    return state.result;
  };
  return { run, calls, state };
}

const paneLine = (fields: string[]): string => fields.join("\t");

test("引数が固定の形: list-panes・list-clients・capture-pane・load-buffer・paste-buffer・send-keys", async () => {
  const { run, calls } = fakeRun();
  const tmux = createTmux({ tmuxPath: TMUX, run });
  await tmux.listPanes();
  await tmux.listClients();
  await tmux.capturePane("%3");
  await tmux.loadBuffer(12, "1 行のテンプレート");
  await tmux.pasteBuffer(12, "%3");
  await tmux.sendEnter("%3");
  assert.deepEqual(
    calls.map((call) => [call.file, ...call.args]),
    [
      [TMUX, "list-panes", "-a", "-F", PANE_FORMAT],
      [TMUX, "list-clients", "-F", CLIENT_FORMAT],
      [TMUX, "capture-pane", "-p", "-e", "-t", "%3"],
      [TMUX, "load-buffer", "-b", "self-agent-12", "-"],
      [TMUX, "paste-buffer", "-p", "-d", "-b", "self-agent-12", "-t", "%3"],
      [TMUX, "send-keys", "-t", "%3", "Enter"],
    ],
  );
  // 標準入力に渡すのは load-buffer だけ
  assert.deepEqual(
    calls.map((call) => call.input),
    [undefined, undefined, undefined, "1 行のテンプレート", undefined, undefined],
  );
  assert.ok(calls.every((call) => call.timeoutMs === CHILD_TIMEOUT_MS && call.maxBuffer === CHILD_MAX_BUFFER));
});

test("子の env は HOME・PATH・LANG だけ（TMUX・トークン類を渡さない）", async (t) => {
  const keys = ["TMUX", "DISCORD_TOKEN", "CLAUDE_CODE_OAUTH_TOKEN"] as const;
  const saved = keys.map((key) => process.env[key]);
  t.after(() =>
    keys.forEach((key, i) => {
      if (saved[i] === undefined) delete process.env[key];
      else process.env[key] = saved[i];
    }),
  );
  for (const key of keys) process.env[key] = "secret";
  const { run, calls } = fakeRun();
  await createTmux({ tmuxPath: TMUX, run }).listPanes();
  assert.deepEqual(Object.keys(calls[0]!.env).sort(), ["HOME", "LANG", "PATH"]);
  assert.equal(calls[0]!.env.PATH, CHILD_PATH);
  assert.equal(calls[0]!.env.LANG, "C.UTF-8");
});

test("socketName を指定すると -L <名前> を先頭に付ける", async () => {
  const { run, calls } = fakeRun();
  await createTmux({ tmuxPath: TMUX, socketName: "sa-test", run }).sendEnter("%0");
  assert.deepEqual(calls[0]!.args, ["-L", "sa-test", "send-keys", "-t", "%0", "Enter"]);
});

test("不正な引数は tmux を呼ぶ前に投げる", async () => {
  const { run, calls } = fakeRun();
  assert.throws(() => createTmux({ tmuxPath: "tmux", run }));
  assert.throws(() => createTmux({ tmuxPath: TMUX, socketName: "a b", run }));
  const tmux = createTmux({ tmuxPath: TMUX, run });
  for (const paneId of ["session:0.0", "%1;ls", "%", "1", "-t"]) {
    await assert.rejects(tmux.capturePane(paneId));
    await assert.rejects(tmux.pasteBuffer(1, paneId));
    await assert.rejects(tmux.sendEnter(paneId));
  }
  for (const id of [0, -1, 1.5, Number.NaN]) {
    await assert.rejects(tmux.loadBuffer(id, "x"));
    assert.throws(() => handoffBufferName(id));
  }
  for (const text of ["a\nb", "a\rb", "a\x1b[2Jb", "a\tb", "a\x7fb", "a\u009bb"]) await assert.rejects(tmux.loadBuffer(1, text));
  assert.equal(calls.length, 0);
});

test("失敗の種類: サーバーが無い・ペインが無い・それ以外", async () => {
  const { run, state } = fakeRun();
  const tmux = createTmux({ tmuxPath: TMUX, run });
  state.result = { code: 1, stdout: "", stderr: "no server running on /tmp/tmux-1000/default\n" };
  assert.deepEqual(await tmux.listPanes(), { ok: false, reason: "no_server" });
  state.result = { code: 1, stdout: "", stderr: "error connecting to /tmp/tmux-1000/default (No such file or directory)\n" };
  assert.deepEqual(await tmux.listClients(), { ok: false, reason: "no_server" });
  state.result = { code: 1, stdout: "", stderr: "can't find pane: %9\n" };
  assert.deepEqual(await tmux.capturePane("%9"), { ok: false, reason: "not_found" });
  state.result = { code: 1, stdout: "", stderr: "something else\n" };
  assert.deepEqual(await tmux.sendEnter("%9"), { ok: false, reason: "failed" });
  state.result = { code: null, stdout: "", stderr: "" };
  assert.deepEqual(await tmux.loadBuffer(1, "x"), { ok: false, reason: "failed" });
  state.result = { code: 0, stdout: "", stderr: "" };
  assert.deepEqual(await tmux.pasteBuffer(1, "%9"), { ok: true, value: undefined });
});

test("list-panes・list-clients の出力を読む。形の合わない行は捨てる", async () => {
  const good = paneLine(["work", "0", "1", "%5", "1", "0", "/home/u/workspace/a", "claude", "0", "0"]);
  const stdout = [
    good,
    paneLine(["dead", "2", "0", "%6", "0", "1", "/tmp", "bash", "1", "1"]),
    paneLine(["short", "0", "0", "%7"]),
    paneLine(["bad-id", "0", "0", "7", "1", "1", "/tmp", "bash", "0", "0"]),
    paneLine(["bad-flag", "0", "0", "%8", "yes", "1", "/tmp", "bash", "0", "0"]),
    paneLine(["path\twith-tab", "0", "0", "%9", "1", "1", "/tmp", "bash", "0", "0"]),
    "",
  ].join("\n");
  assert.deepEqual(parsePanes(stdout), [
    {
      sessionName: "work",
      windowIndex: 0,
      paneIndex: 1,
      paneId: "%5",
      windowActive: true,
      paneActive: false,
      currentPath: "/home/u/workspace/a",
      currentCommand: "claude",
      inMode: false,
      dead: false,
    },
    {
      sessionName: "dead",
      windowIndex: 2,
      paneIndex: 0,
      paneId: "%6",
      windowActive: false,
      paneActive: true,
      currentPath: "/tmp",
      currentCommand: "bash",
      inMode: true,
      dead: true,
    },
  ]);
  const { run, state } = fakeRun();
  state.result = { code: 0, stdout: "work\t1760000000\nother\tx\nbroken\n", stderr: "" };
  assert.deepEqual(await createTmux({ tmuxPath: TMUX, run }).listClients(), {
    ok: true,
    value: [{ sessionName: "work", activityAt: 1760000000_000 }],
  });
});

test("execFileRunner: シェルを通さず、標準入力を渡し、終了コードを返す。起動できなければ code は null", async () => {
  const env = { PATH: CHILD_PATH };
  const options = { env, timeoutMs: 5000, maxBuffer: 1024 * 1024 };
  const echoed = await execFileRunner("/bin/echo", ["$HOME;", "`id`"], options);
  assert.deepEqual(echoed, { code: 0, stdout: "$HOME; `id`\n", stderr: "" });
  const cat = await execFileRunner("/bin/cat", [], { ...options, input: "標準入力" });
  assert.equal(cat.stdout, "標準入力");
  const failed = await execFileRunner("/bin/sh", ["-c", "echo err >&2; exit 3"], options);
  assert.deepEqual(failed, { code: 3, stdout: "", stderr: "err\n" });
  const missing = await execFileRunner("/nonexistent/tmux", [], options);
  assert.equal(missing.code, null);
});
