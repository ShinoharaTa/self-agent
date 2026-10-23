import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import {
  BWRAP_PROBE_ARGS,
  BWRAP_PROBE_TIMEOUT_MS,
  checkSandbox,
  findExecutable,
  isSeparateFilesystem,
  nodeVersionDir,
  placesOverlap,
  type ProbeResult,
  type RunProbe,
  SANDBOX_CHECK_ITEMS,
  type SandboxCheckInput,
  shellPath,
  spawnProbe,
} from "../src/agent/sandbox-check.ts";

const ITEMS = SANDBOX_CHECK_ITEMS;

function tempRoot(t: TestContext): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "self-agent-test-")));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

/** dir に実行できる（mode 755）シェルスクリプト name を置く */
function script(dir: string, name: string, body: string, mode: number = 0o755): string {
  mkdirSync(dir, { recursive: true });
  const file = join(dir, name);
  writeFileSync(file, `#!/bin/sh\n${body}\n`);
  chmodSync(file, mode);
  return file;
}

/**
 * 全部が通る入力。bin に bwrap・socat を置き、場所は root の下で重ならないように分け、
 * workDir だけ別のファイルシステム（deviceOf の偽物）にする。probe は記録して 0 で終わる
 */
function setup(t: TestContext) {
  const root = tempRoot(t);
  const bin = join(root, "bin");
  script(bin, "bwrap", "exit 0");
  script(bin, "socat", "exit 0");
  const dirs = {
    workDir: join(root, "work"),
    nodeDir: join(root, "node/v24"),
    dataDir: join(root, "data"),
    claudeConfigDir: join(root, "claude"),
    repoDir: join(root, "repo"),
    homeDir: join(root, "home"),
  };
  for (const dir of Object.values(dirs)) mkdirSync(dir, { recursive: true });
  const probes: Array<{ file: string; args: readonly string[]; env: Record<string, string>; timeoutMs: number }> = [];
  const probe = { result: { kind: "exited", code: 0 } as ProbeResult };
  const runProbe: RunProbe = async (file, args, options) => {
    probes.push({ file, args, ...options });
    return probe.result;
  };
  const input: SandboxCheckInput = {
    // ホストの /usr/bin は入れない（bwrap を入れたホストでも結果が変わらないように）
    pathEnv: [join(root, "empty"), bin].join(delimiter),
    ...dirs,
    runProbe,
    deviceOf: (path) => (path === dirs.workDir ? 2 : 1),
  };
  return { root, bin, dirs, input, probes, probe };
}

test("nodeVersionDir: execPath の 2 つ上", () => {
  assert.equal(nodeVersionDir("/home/u/.nvm/versions/node/v24.20.0/bin/node"), "/home/u/.nvm/versions/node/v24.20.0");
});

test("shellPath: node の bin を先頭に、/usr/local/bin・/usr/bin・/bin を続ける", () => {
  assert.equal(
    shellPath("/home/u/.nvm/versions/node/v24.20.0/bin/node"),
    ["/home/u/.nvm/versions/node/v24.20.0/bin", "/usr/local/bin", "/usr/bin", "/bin"].join(delimiter),
  );
});

test("findExecutable: PATH の前から順に、実行できるファイルだけを返す。相対・空の要素とディレクトリ・実行できないものは飛ばす", (t) => {
  const root = tempRoot(t);
  const first = join(root, "first");
  const second = join(root, "second");
  script(first, "tool", "exit 0", 0o644);
  mkdirSync(join(first, "dir-tool"), { recursive: true });
  const executable = script(second, "tool", "exit 0");
  script(second, "dir-tool", "exit 0");
  const pathEnv = ["", "relative/bin", first, second].join(delimiter);
  assert.equal(findExecutable("tool", pathEnv), executable);
  assert.equal(findExecutable("dir-tool", pathEnv), join(second, "dir-tool"));
  assert.equal(findExecutable("missing", pathEnv), undefined);
  assert.equal(findExecutable("tool", ""), undefined);
});

test("checkSandbox: 全部通れば ok。probe は PATH の bwrap を §4 の引数・5 秒・その PATH だけの env で 1 回実行する", async (t) => {
  const env = setup(t);
  assert.deepEqual(await checkSandbox(env.input), { ok: true });
  assert.deepEqual(env.probes, [
    { file: join(env.bin, "bwrap"), args: BWRAP_PROBE_ARGS, env: { PATH: env.input.pathEnv }, timeoutMs: BWRAP_PROBE_TIMEOUT_MS },
  ]);
  assert.equal(BWRAP_PROBE_TIMEOUT_MS, 5000);
  assert.deepEqual(BWRAP_PROBE_ARGS, [
    "--unshare-user", "--unshare-net", "--unshare-pid", "--die-with-parent", "--ro-bind", "/", "/", "--proc", "/proc", "--dev", "/dev", "/bin/true",
  ]);
});

test("checkSandbox: 失敗した項目を全部返す（項目にパスは入らない）", async (t) => {
  const cases: Array<{ name: string; arrange: (env: ReturnType<typeof setup>) => void; failed: string[]; probed: boolean }> = [
    { name: "bwrap が無い（probe もしない）", arrange: (env) => rmSync(join(env.bin, "bwrap")), failed: [ITEMS.bwrapMissing], probed: false },
    { name: "socat が無い", arrange: (env) => rmSync(join(env.bin, "socat")), failed: [ITEMS.socatMissing], probed: true },
    {
      name: "bwrap が実行できない",
      arrange: (env) => chmodSync(join(env.bin, "bwrap"), 0o644),
      failed: [ITEMS.bwrapMissing],
      probed: false,
    },
    { name: "probe が 0 以外で終わる", arrange: (env) => void (env.probe.result = { kind: "exited", code: 1 }), failed: [ITEMS.probeFailed], probed: true },
    { name: "probe がシグナルで終わる", arrange: (env) => void (env.probe.result = { kind: "exited", code: null }), failed: [ITEMS.probeFailed], probed: true },
    { name: "probe を起動できない", arrange: (env) => void (env.probe.result = { kind: "error" }), failed: [ITEMS.probeFailed], probed: true },
    { name: "probe が時間切れ", arrange: (env) => void (env.probe.result = { kind: "timeout" }), failed: [ITEMS.probeTimeout], probed: true },
    {
      name: "場所が重なる（dataDir が workDir の projects の中）",
      arrange: (env) => void (env.input.dataDir = join(env.dirs.workDir, "projects/data")),
      failed: [ITEMS.placesOverlap],
      probed: true,
    },
    {
      name: "workDir が親と同じファイルシステム",
      arrange: (env) => void (env.input.deviceOf = () => 1),
      failed: [ITEMS.sameFilesystem],
      probed: true,
    },
    {
      name: "全部だめ",
      arrange: (env) => {
        rmSync(env.bin, { recursive: true });
        env.input.repoDir = env.dirs.workDir;
        env.input.deviceOf = () => 1;
      },
      failed: [ITEMS.bwrapMissing, ITEMS.socatMissing, ITEMS.placesOverlap, ITEMS.sameFilesystem],
      probed: false,
    },
  ];
  for (const { name, arrange, failed, probed } of cases) {
    const env = setup(t);
    arrange(env);
    const result = await checkSandbox(env.input);
    assert.deepEqual(result, { ok: false, failed }, name);
    assert.equal(env.probes.length, probed ? 1 : 0, name);
    assert.ok(!JSON.stringify(result).includes(env.root), name);
  }
});

test("placesOverlap: 読める場所（workDir の projects・.cache・.tmp・cwd と node の版のディレクトリ）が秘密の場所と同じ・その中・その外側なら重なる（symlink は実際の場所で比べる）。workDir の直下の別の名前・名前の前方一致だけなら重ならない。解決できなければ重なるとみなす", (t) => {
  const cases: Array<{ name: string; arrange: (env: ReturnType<typeof setup>) => void; overlap: boolean }> = [
    { name: "重ならない", arrange: () => {}, overlap: false },
    { name: "dataDir が workDir と同じ（読める場所の外側）", arrange: (env) => void (env.input.dataDir = env.dirs.workDir), overlap: true },
    { name: "claudeConfigDir が workDir の projects の中", arrange: (env) => void (env.input.claudeConfigDir = join(env.dirs.workDir, "projects/claude")), overlap: true },
    { name: "dataDir が workDir の .cache と同じ", arrange: (env) => void (env.input.dataDir = join(env.dirs.workDir, ".cache")), overlap: true },
    { name: "repoDir が workDir の .tmp の中", arrange: (env) => void (env.input.repoDir = join(env.dirs.workDir, ".tmp/repo")), overlap: true },
    { name: "claudeConfigDir が workDir の cwd の中", arrange: (env) => void (env.input.claudeConfigDir = join(env.dirs.workDir, "cwd/claude")), overlap: true },
    { name: "dataDir が workDir の直下の jobs", arrange: (env) => void (env.input.dataDir = join(env.dirs.workDir, "jobs")), overlap: false },
    { name: "claudeConfigDir が workDir の直下の別の名前", arrange: (env) => void (env.input.claudeConfigDir = join(env.dirs.workDir, "other")), overlap: false },
    { name: "repoDir が workDir の外側", arrange: (env) => void (env.input.repoDir = env.root), overlap: true },
    {
      name: "workDir が ~/.config/self-agent の中",
      arrange: (env) => {
        env.input.workDir = join(env.dirs.homeDir, ".config/self-agent/work");
        mkdirSync(env.input.workDir, { recursive: true });
      },
      overlap: true,
    },
    {
      name: "workDir が dataDir を指す symlink",
      arrange: (env) => {
        env.input.workDir = join(env.root, "work-link");
        symlinkSync(env.dirs.dataDir, env.input.workDir);
      },
      overlap: true,
    },
    { name: "repoDir が node の版のディレクトリの中", arrange: (env) => void (env.input.repoDir = join(env.dirs.nodeDir, "lib/repo")), overlap: true },
    { name: "node の版のディレクトリが dataDir の中", arrange: (env) => void (env.input.nodeDir = join(env.dirs.dataDir, "node")), overlap: true },
    {
      name: "node の版のディレクトリが解決できなければ重なっているとみなす",
      arrange: (env) => {
        env.input.nodeDir = join(env.root, "node-broken");
        symlinkSync(join(env.root, "no-such"), env.input.nodeDir);
      },
      overlap: true,
    },
    { name: "dataDir が workDir と名前の前方だけ同じ", arrange: (env) => void (env.input.dataDir = `${env.dirs.workDir}2`), overlap: false },
    { name: "まだ無い場所は存在する親から求める", arrange: (env) => void (env.input.dataDir = join(env.root, "new/data")), overlap: false },
    {
      name: "解決できない（壊れた symlink）なら重なっているとみなす",
      arrange: (env) => {
        env.input.claudeConfigDir = join(env.root, "broken");
        symlinkSync(join(env.root, "no-such"), env.input.claudeConfigDir);
      },
      overlap: true,
    },
    {
      name: "解決できない（途中がファイル: ENOTDIR）なら重なっているとみなす",
      arrange: (env) => {
        writeFileSync(join(env.root, "file"), "");
        env.input.repoDir = join(env.root, "file/repo");
      },
      overlap: true,
    },
    {
      name: "workDir が解決できなければ重なっているとみなす",
      arrange: (env) => {
        env.input.workDir = join(env.root, "work-broken");
        symlinkSync(join(env.root, "no-such"), env.input.workDir);
      },
      overlap: true,
    },
  ];
  for (const { name, arrange, overlap } of cases) {
    const env = setup(t);
    arrange(env);
    assert.equal(placesOverlap(env.input), overlap, name);
  }
});

test("isSeparateFilesystem: workDir と親の st_dev が違えば true。同じ・stat できない・無いなら false", (t) => {
  const root = tempRoot(t);
  const workDir = join(root, "work");
  mkdirSync(workDir);
  assert.equal(isSeparateFilesystem(workDir, (path) => (path === workDir ? 2n : 1n)), true);
  assert.equal(isSeparateFilesystem(workDir, () => 1), false);
  assert.equal(
    isSeparateFilesystem(workDir, () => {
      throw new Error("EACCES");
    }),
    false,
  );
  // 一時ディレクトリの中は親と同じファイルシステム
  assert.equal(isSeparateFilesystem(workDir), false);
  assert.equal(isSeparateFilesystem(join(root, "missing")), false);
});

test("spawnProbe: 終了コード・時間切れ（SIGKILL で止める）・起動できないを返す", async (t) => {
  const root = tempRoot(t);
  const env = { PATH: "/usr/bin:/bin" };
  const cases: Array<{ name: string; file: string; timeoutMs: number; expected: ProbeResult }> = [
    { name: "0 で終わる", file: script(root, "ok", "exit 0"), timeoutMs: 5000, expected: { kind: "exited", code: 0 } },
    { name: "0 以外で終わる", file: script(root, "ng", "exit 3"), timeoutMs: 5000, expected: { kind: "exited", code: 3 } },
    { name: "時間切れ", file: script(root, "slow", "exec sleep 5"), timeoutMs: 100, expected: { kind: "timeout" } },
    { name: "起動できない", file: join(root, "missing"), timeoutMs: 5000, expected: { kind: "error" } },
  ];
  for (const { name, file, timeoutMs, expected } of cases) {
    const started = Date.now();
    assert.deepEqual(await spawnProbe(file, [], { env, timeoutMs }), expected, name);
    assert.ok(Date.now() - started < 3000, name);
  }
});
