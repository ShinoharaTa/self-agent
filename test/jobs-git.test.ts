import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  assertSafePushArgs,
  BLOB_MAX_BYTES,
  buildPushArgs,
  copyObjects,
  GIT_BASE_CONFIG_ARGS,
  GIT_LOCAL_TIMEOUT_MS,
  GIT_NET_TIMEOUT_MS,
  gitChildEnv,
  gitCredentialArgs,
  GitClient,
  githubRemoteUrl,
  isAllowedRemote,
  isBranchName,
  isForbiddenPath,
  isJobBranch,
  jobBranch,
  readBranchTip,
} from "../src/jobs/git.ts";
import type { RunCommand, RunOptions, RunResult } from "../src/github/gh.ts";

const GIT = "/usr/bin/git";
const GH = "/usr/bin/gh";
const AUTHOR = { name: "example", email: "1234+example@users.noreply.github.com" };
const SHA = "0123456789abcdef0123456789abcdef01234567";

/** テストの中で LLM・リモートの持ち主の代わりに git を動かすときの env（global・system の設定を読まない） */
function plainEnv(extra: Record<string, string> = {}): Record<string, string> {
  return {
    PATH: "/usr/local/bin:/usr/bin:/bin",
    HOME: "/nonexistent",
    LANG: "C.UTF-8",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    ...extra,
  };
}

function git(cwd: string, args: readonly string[], extra: Record<string, string> = {}): string {
  return execFileSync(GIT, [...args], { cwd, env: plainEnv(extra), encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

/** LLM の commit（作業場所の config の user.name・user.email を使う） */
function commitFile(repo: string, path: string, content: string | Buffer, extra: Record<string, string> = {}): string {
  const file = join(repo, path);
  mkdirSync(join(file, ".."), { recursive: true });
  writeFileSync(file, content);
  git(repo, ["add", "--", path], extra);
  git(repo, ["commit", "--quiet", "--no-verify", "-m", `add ${path}`], extra);
  return git(repo, ["rev-parse", "HEAD"]);
}

type Fixture = {
  root: string;
  remote: string;
  bare: string;
  repo: string;
  quarantine: string;
  markers: string;
  logs: string[];
  client: GitClient;
};

/** 一時ディレクトリに「リモート」（ローカルの bare。main に 1 コミット）と、bare・作業場所の場所を用意する */
function setup(t: { after: (fn: () => void) => void }, run?: RunCommand): Fixture {
  const root = mkdtempSync(join(tmpdir(), "self-agent-jobs-git-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const seed = join(root, "seed");
  mkdirSync(seed);
  git(seed, ["init", "--quiet", "--initial-branch=main"]);
  git(seed, ["config", "user.name", "owner"]);
  git(seed, ["config", "user.email", "owner@example.com"]);
  commitFile(seed, "README.md", "hello\n");
  const remote = join(root, "remote.git");
  git(root, ["clone", "--quiet", "--bare", seed, remote]);
  const markers = join(root, "markers");
  mkdirSync(markers);
  mkdirSync(join(root, "active"));
  const logs: string[] = [];
  const client = new GitClient({
    gitPath: GIT,
    ghPath: GH,
    log: (message) => logs.push(message),
    sourceEnv: { HOME: join(root, "home"), GH_TOKEN: "dummy-gh-token", CLAUDE_CODE_OAUTH_TOKEN: "dummy-oauth", DISCORD_TOKEN: "dummy-discord" },
    ...(run === undefined ? {} : { run }),
  });
  return {
    root,
    remote,
    bare: join(root, "data", "jobs", "1.git"),
    repo: join(root, "active", "repo"),
    quarantine: join(root, "quarantine-1.git"),
    markers,
    logs,
    client,
  };
}

/** 準備（bare の clone と作業用の clone）まで済ませる */
async function prepare(f: Fixture, branch = jobBranch(1)): Promise<void> {
  mkdirSync(join(f.root, "data", "jobs"), { recursive: true });
  assert.deepEqual(await f.client.cloneBare({ remote: f.remote, base: "main", bareDir: f.bare }), { ok: true });
  assert.deepEqual(
    await f.client.prepareWorkspace({ bareDir: f.bare, repoDir: f.repo, checkout: "main", newBranch: branch, author: AUTHOR }),
    { ok: true },
  );
}

async function importAndInspect(f: Fixture, runId = 1) {
  const imported = await f.client.importWork({ repoDir: f.repo, branch: jobBranch(1), quarantineDir: f.quarantine, bareDir: f.bare, runId });
  if (!imported.ok) return imported;
  const base = await f.client.revParse(f.bare, "refs/heads/main");
  assert.ok(base !== undefined);
  return f.client.inspect({ bareDir: f.bare, base, staged: imported.sha, authorEmail: AUTHOR.email });
}

/** 実行されたら印のファイルを作るスクリプト */
function markerScript(path: string, markers: string, name: string): void {
  writeFileSync(path, `#!/bin/sh\ntouch '${join(markers, name)}'\ncat >/dev/null 2>&1\nexit 0\n`);
  chmodSync(path, 0o755);
}

test("準備: bare に clone し、作業用の clone はジョブのブランチ・origin なし・author は noreply（config --local）", async (t) => {
  const f = setup(t);
  await prepare(f);
  assert.equal(git(f.repo, ["rev-parse", "--abbrev-ref", "HEAD"]), "self-agent/job-1");
  assert.equal(git(f.repo, ["remote"]), "");
  assert.equal(git(f.repo, ["config", "--local", "user.email"]), AUTHOR.email);
  assert.equal(git(f.repo, ["config", "--local", "user.name"]), AUTHOR.name);
  // テンプレートを使わない（hooks のサンプルが無い）
  assert.equal(existsSync(join(f.repo, ".git", "hooks")), false);
  assert.equal(existsSync(join(f.bare, "hooks")), false);
});

test("取り込み → 検査 → push: 作業場所に仕込んだ hooks・設定・alternates はどれも host 側で動かない", async (t) => {
  const f = setup(t);
  await prepare(f);
  const gitDir = join(f.repo, ".git");
  // LLM が書ける .git に危ないものを仕込む
  mkdirSync(join(gitDir, "hooks"), { recursive: true });
  for (const hook of ["pre-push", "post-checkout", "reference-transaction", "pre-commit", "post-update", "pre-receive"]) {
    markerScript(join(gitDir, "hooks", hook), f.markers, `hook-${hook}`);
  }
  const evilHooks = join(f.root, "evil-hooks");
  mkdirSync(evilHooks);
  for (const hook of ["pre-push", "reference-transaction", "post-checkout"]) markerScript(join(evilHooks, hook), f.markers, `hookspath-${hook}`);
  const helper = join(f.root, "evil-helper");
  markerScript(helper, f.markers, "script");
  git(f.repo, ["config", "core.hooksPath", evilHooks]);
  git(f.repo, ["config", "core.fsmonitor", helper]);
  git(f.repo, ["config", "filter.x.clean", helper]);
  git(f.repo, ["config", "filter.x.smudge", helper]);
  git(f.repo, ["config", "credential.helper", `!${helper}`]);
  git(f.repo, ["config", `url.${join(f.root, "elsewhere.git")}.insteadOf`, f.remote]);
  git(f.repo, ["config", `url.${join(f.root, "elsewhere.git")}.pushInsteadOf`, f.remote]);
  const otherObjects = join(f.root, "other", "objects");
  mkdirSync(otherObjects, { recursive: true });
  writeFileSync(join(gitDir, "objects", "info", "alternates"), `${otherObjects}\n`);
  writeFileSync(join(gitDir, "objects", "info", "http-alternates"), "https://example.invalid/objects\n");

  // LLM の commit。作業場所の中の git では仕込んだもの（fsmonitor・hooks）が動く = 仕込みが効いていることの確かめ。印は消してから取り込む
  writeFileSync(join(f.repo, ".gitattributes"), "* filter=x\n");
  const sha = commitFile(f.repo, "src/app.js", "console.log('hi');\n");
  assert.ok(readdirSync(f.markers).length > 0);
  for (const name of readdirSync(f.markers)) rmSync(join(f.markers, name));

  const imported = await f.client.importWork({ repoDir: f.repo, branch: jobBranch(1), quarantineDir: f.quarantine, bareDir: f.bare, runId: 1 });
  assert.deepEqual(imported, { ok: true, sha, ref: "refs/self-agent/staged/1" });
  assert.equal(existsSync(f.quarantine), false);
  const base = await f.client.revParse(f.bare, "refs/heads/main");
  assert.ok(base !== undefined);
  assert.deepEqual(await f.client.inspect({ bareDir: f.bare, base, staged: sha, authorEmail: AUTHOR.email }), { ok: true, commits: 1 });
  assert.deepEqual(await f.client.push({ bareDir: f.bare, remote: f.remote, sha, branch: jobBranch(1) }), { ok: true });

  assert.equal(git(f.root, ["--git-dir", f.remote, "rev-parse", "refs/heads/self-agent/job-1"]), sha);
  assert.deepEqual(readdirSync(f.markers), []);
  // bare に作業場所の設定・alternates が入っていない
  assert.equal(existsSync(join(f.bare, "objects", "info", "alternates")), false);
  const bareConfig = git(f.root, ["--git-dir", f.bare, "config", "--list", "--local"]);
  assert.equal(/hookspath|fsmonitor|filter\.|credential|insteadof|alternates/i.test(bareConfig), false, bareConfig);
});

test("取り込み: .git が gitfile・symlink、objects が symlink、作業場所が symlink なら import_failed", async (t) => {
  const cases: Array<[string, (f: Fixture) => void]> = [
    [
      "gitfile",
      (f) => {
        const moved = join(f.root, "moved.git");
        execFileSync("/usr/bin/mv", [join(f.repo, ".git"), moved]);
        writeFileSync(join(f.repo, ".git"), `gitdir: ${moved}\n`);
      },
    ],
    [
      ".git symlink",
      (f) => {
        const moved = join(f.root, "moved.git");
        execFileSync("/usr/bin/mv", [join(f.repo, ".git"), moved]);
        symlinkSync(moved, join(f.repo, ".git"));
      },
    ],
    [
      "objects symlink",
      (f) => {
        const moved = join(f.root, "moved-objects");
        execFileSync("/usr/bin/mv", [join(f.repo, ".git", "objects"), moved]);
        symlinkSync(moved, join(f.repo, ".git", "objects"));
      },
    ],
    [
      "repo symlink",
      (f) => {
        const moved = join(f.root, "moved-repo");
        execFileSync("/usr/bin/mv", [f.repo, moved]);
        symlinkSync(moved, f.repo);
      },
    ],
    [
      "refs symlink",
      (f) => {
        const moved = join(f.root, "moved-heads");
        execFileSync("/usr/bin/mv", [join(f.repo, ".git", "refs", "heads"), moved]);
        symlinkSync(moved, join(f.repo, ".git", "refs", "heads"));
      },
    ],
    [
      "branch deleted",
      (f) => {
        git(f.repo, ["switch", "--quiet", "-c", "other"]);
        git(f.repo, ["branch", "--quiet", "-D", jobBranch(1)]);
      },
    ],
    [
      "symbolic ref",
      (f) => {
        writeFileSync(join(f.repo, ".git", "refs", "heads", "self-agent", "job-1"), "ref: refs/heads/main\n");
      },
    ],
  ];
  for (const [name, tamper] of cases) {
    await t.test(name, async (st) => {
      const f = setup(st);
      await prepare(f);
      commitFile(f.repo, "a.txt", "a\n");
      tamper(f);
      assert.deepEqual(
        await f.client.importWork({ repoDir: f.repo, branch: jobBranch(1), quarantineDir: f.quarantine, bareDir: f.bare, runId: 1 }),
        { ok: false, failure: "import_failed" },
      );
      assert.equal(existsSync(f.quarantine), false);
    });
  }
});

test("取り込み: packed-refs のブランチの先端も読める（loose が無いとき）", async (t) => {
  const f = setup(t);
  await prepare(f);
  const sha = commitFile(f.repo, "a.txt", "a\n");
  git(f.repo, ["pack-refs", "--all", "--prune"]);
  assert.equal(existsSync(join(f.repo, ".git", "refs", "heads", "self-agent", "job-1")), false);
  assert.equal(readBranchTip(join(f.repo, ".git"), jobBranch(1)), sha);
  assert.deepEqual(await importAndInspect(f), { ok: true, commits: 1 });
});

test("readBranchTip: 40 桁の 16 進だけを読む。形の違うものは undefined", (t) => {
  const root = mkdtempSync(join(tmpdir(), "self-agent-jobs-ref-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const dir = join(root, "refs", "heads", "self-agent");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "job-1"), `${SHA}\n`);
  writeFileSync(join(dir, "job-2"), `${SHA}\nextra\n`);
  writeFileSync(join(dir, "job-3"), SHA.toUpperCase());
  mkdirSync(join(dir, "job-4"));
  assert.equal(readBranchTip(root, "self-agent/job-1"), SHA);
  assert.equal(readBranchTip(root, "self-agent/job-2"), undefined);
  assert.equal(readBranchTip(root, "self-agent/job-3"), undefined);
  assert.equal(readBranchTip(root, "self-agent/job-4"), undefined);
  assert.equal(readBranchTip(root, "self-agent/job-5"), undefined);
  writeFileSync(join(root, "packed-refs"), `# pack-refs with: peeled fully-peeled sorted\n${SHA} refs/heads/self-agent/job-5\n^${SHA}\n`);
  assert.equal(readBranchTip(root, "self-agent/job-5"), SHA);
  assert.throws(() => readBranchTip(root, "../x"));
});

test("copyObjects: ルーズオブジェクトとパックだけを写す。symlink・info（alternates）・FIFO・ほかの名前は写さず、上限で止める", (t) => {
  const root = mkdtempSync(join(tmpdir(), "self-agent-jobs-objects-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const source = join(root, "src");
  const destination = join(root, "dst");
  const outside = join(root, "outside");
  writeFileSync(outside, "secret");
  mkdirSync(join(source, "ab"), { recursive: true });
  mkdirSync(join(source, "pack"));
  mkdirSync(join(source, "info"));
  mkdirSync(destination);
  writeFileSync(join(source, "ab", "c".repeat(38)), "loose");
  symlinkSync(outside, join(source, "ab", "d".repeat(38)));
  writeFileSync(join(source, "ab", "not-an-object"), "x");
  execFileSync("/usr/bin/mkfifo", [join(source, "ab", "e".repeat(38))]);
  writeFileSync(join(source, "pack", `pack-${SHA}.pack`), "pack");
  writeFileSync(join(source, "pack", `pack-${SHA}.idx`), "idx");
  writeFileSync(join(source, "pack", `pack-${SHA}.bitmap`), "bitmap");
  writeFileSync(join(source, "info", "alternates"), "/elsewhere\n");
  writeFileSync(join(source, "info", "http-alternates"), "https://example.invalid\n");
  symlinkSync(join(root, "elsewhere"), join(source, "cd"));

  const result = copyObjects(source, destination);
  assert.deepEqual(result, { ok: true, files: 3, bytes: 5 + 4 + 3, skipped: 6 });
  assert.deepEqual(readdirSync(join(destination, "ab")), ["c".repeat(38)]);
  assert.deepEqual(readdirSync(join(destination, "pack")).sort(), [`pack-${SHA}.idx`, `pack-${SHA}.pack`]);
  assert.equal(existsSync(join(destination, "info")), false);
  assert.equal(existsSync(join(destination, "cd")), false);

  assert.deepEqual(copyObjects(source, join(root, "dst2"), 6), { ok: false, reason: "too_large" });
});

test("検査: .github を変えたコミット（後で消しても）は forbidden_path", async (t) => {
  const f = setup(t);
  await prepare(f);
  commitFile(f.repo, ".github/workflows/x.yml", "on: push\n");
  assert.deepEqual(await importAndInspect(f), { ok: false, failure: "forbidden_path" });

  const g = setup(t);
  await prepare(g);
  commitFile(g.repo, ".github/workflows/x.yml", "on: push\n");
  git(g.repo, ["rm", "--quiet", "-r", ".github"]);
  git(g.repo, ["commit", "--quiet", "-m", "remove"]);
  commitFile(g.repo, "a.txt", "a\n");
  assert.deepEqual(await importAndInspect(g), { ok: false, failure: "forbidden_path" });
});

test("検査: author・committer の email が noreply でなければ bad_author", async (t) => {
  const f = setup(t);
  await prepare(f);
  commitFile(f.repo, "a.txt", "a\n", { GIT_AUTHOR_EMAIL: "someone@example.com" });
  assert.deepEqual(await importAndInspect(f), { ok: false, failure: "bad_author" });

  const g = setup(t);
  await prepare(g);
  commitFile(g.repo, "a.txt", "a\n");
  commitFile(g.repo, "b.txt", "b\n", { GIT_COMMITTER_EMAIL: "someone@example.com" });
  assert.deepEqual(await importAndInspect(g), { ok: false, failure: "bad_author" });
});

test("検査: コミットが無ければ no_commits、base を祖先に持たなければ not_fast_forward", async (t) => {
  const f = setup(t);
  await prepare(f);
  assert.deepEqual(await importAndInspect(f), { ok: false, failure: "no_commits" });

  const g = setup(t);
  await prepare(g);
  git(g.repo, ["switch", "--quiet", "--orphan", "rewritten"]);
  commitFile(g.repo, "a.txt", "a\n");
  git(g.repo, ["branch", "--quiet", "-M", "rewritten", jobBranch(1)]);
  assert.deepEqual(await importAndInspect(g), { ok: false, failure: "not_fast_forward" });
});

test("検査: 50 MB を超える blob があれば too_large（ちょうど 50 MB は通す）", async (t) => {
  const f = setup(t);
  await prepare(f);
  commitFile(f.repo, "ok.bin", Buffer.alloc(BLOB_MAX_BYTES));
  assert.deepEqual(await importAndInspect(f), { ok: true, commits: 1 });

  const g = setup(t);
  await prepare(g);
  commitFile(g.repo, "big.bin", Buffer.alloc(BLOB_MAX_BYTES + 1));
  assert.deepEqual(await importAndInspect(g), { ok: false, failure: "too_large" });
});

test("push: リモートのブランチが先に進んでいれば push_rejected（--force しない）", async (t) => {
  const f = setup(t);
  await prepare(f);
  // 誰かがリモートのジョブのブランチを別の先端にした
  const other = join(f.root, "other");
  git(f.root, ["clone", "--quiet", f.remote, other]);
  git(other, ["config", "user.name", "owner"]);
  git(other, ["config", "user.email", "owner@example.com"]);
  commitFile(other, "other.txt", "o\n");
  git(other, ["push", "--quiet", "origin", `HEAD:refs/heads/${jobBranch(1)}`]);
  const theirs = git(other, ["rev-parse", "HEAD"]);

  const sha = commitFile(f.repo, "a.txt", "a\n");
  const imported = await f.client.importWork({ repoDir: f.repo, branch: jobBranch(1), quarantineDir: f.quarantine, bareDir: f.bare, runId: 1 });
  assert.ok(imported.ok);
  assert.deepEqual(await f.client.push({ bareDir: f.bare, remote: f.remote, sha, branch: jobBranch(1) }), { ok: false, failure: "push_rejected" });
  assert.equal(git(f.root, ["--git-dir", f.remote, "rev-parse", `refs/heads/${jobBranch(1)}`]), theirs);
});

test("続き: fetchBare でリモートのジョブのブランチを取り、その先端から作業できる。ブランチが無ければ branch_missing", async (t) => {
  const f = setup(t);
  await prepare(f);
  const first = commitFile(f.repo, "a.txt", "a\n");
  assert.ok((await f.client.importWork({ repoDir: f.repo, branch: jobBranch(1), quarantineDir: f.quarantine, bareDir: f.bare, runId: 1 })).ok);
  assert.deepEqual(await f.client.push({ bareDir: f.bare, remote: f.remote, sha: first, branch: jobBranch(1) }), { ok: true });

  rmSync(join(f.root, "active"), { recursive: true });
  mkdirSync(join(f.root, "active"));
  assert.deepEqual(await f.client.fetchBare({ remote: f.remote, base: "main", branch: jobBranch(1), bareDir: f.bare }), { ok: true });
  assert.deepEqual(
    await f.client.prepareWorkspace({ bareDir: f.bare, repoDir: f.repo, checkout: jobBranch(1), author: AUTHOR }),
    { ok: true },
  );
  assert.equal(git(f.repo, ["rev-parse", "HEAD"]), first);
  const second = commitFile(f.repo, "b.txt", "b\n");
  const imported = await f.client.importWork({ repoDir: f.repo, branch: jobBranch(1), quarantineDir: f.quarantine, bareDir: f.bare, runId: 2 });
  assert.deepEqual(imported, { ok: true, sha: second, ref: "refs/self-agent/staged/2" });
  const base = await f.client.revParse(f.bare, `refs/heads/${jobBranch(1)}`);
  assert.equal(base, first);
  assert.deepEqual(await f.client.inspect({ bareDir: f.bare, base: first, staged: second, authorEmail: AUTHOR.email }), { ok: true, commits: 1 });
  assert.deepEqual(await f.client.push({ bareDir: f.bare, remote: f.remote, sha: second, branch: jobBranch(1) }), { ok: true });

  assert.deepEqual(await f.client.fetchBare({ remote: f.remote, base: "main", branch: jobBranch(9), bareDir: f.bare }), {
    ok: false,
    failure: "branch_missing",
  });
});

test("log: 失敗の 1 行は操作と種類だけで、パス・ブランチ名・リモートを含まない", async (t) => {
  const f = setup(t);
  await f.client.fetchBare({ remote: f.remote, base: "main", branch: jobBranch(9), bareDir: f.bare });
  await f.client.importWork({ repoDir: f.repo, branch: jobBranch(1), quarantineDir: f.quarantine, bareDir: f.bare, runId: 1 });
  assert.ok(f.logs.length >= 2);
  for (const line of f.logs) {
    assert.match(line, /^ジョブの git が失敗しました（[a-z-]+・[a-z_ 0-9]+）$/);
    for (const secret of [f.root, "self-agent/job", "remote.git", "main"]) assert.equal(line.includes(secret), false, line);
  }
});

type Call = { file: string; args: readonly string[]; options: RunOptions };

function fakeRun(results: (args: readonly string[]) => RunResult): { run: RunCommand; calls: Call[] } {
  const calls: Call[] = [];
  const run: RunCommand = async (file, args, options) => {
    calls.push({ file, args, options });
    return results(args);
  };
  return { run, calls };
}

const OK: RunResult = { kind: "exited", code: 0, stdout: "", stderr: "" };

test("引数と env（偽の run）: 全コマンドに -C と固定の -c、credential はネットの操作だけ、env にトークン類・プロキシが無い", async (t) => {
  const { run, calls } = fakeRun(() => OK);
  const root = mkdtempSync(join(tmpdir(), "self-agent-jobs-fake-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const client = new GitClient({
    gitPath: GIT,
    ghPath: GH,
    run,
    sourceEnv: {
      HOME: "/home/example",
      GH_TOKEN: "dummy",
      GITHUB_TOKEN: "dummy",
      CLAUDE_CODE_OAUTH_TOKEN: "dummy",
      DISCORD_TOKEN: "dummy",
      HTTPS_PROXY: "http://proxy.invalid",
      https_proxy: "http://proxy.invalid",
      GIT_ASKPASS: "/bin/true",
      SSH_AUTH_SOCK: "/tmp/agent",
      GIT_DIR: "/elsewhere",
    },
  });
  const remote = githubRemoteUrl("example-org", "example-repo");
  const bare = join(root, "1.git");
  await client.cloneBare({ remote, base: "main", bareDir: bare });
  await client.fetchBare({ remote, base: "main", branch: jobBranch(1), bareDir: bare });
  await client.prepareWorkspace({ bareDir: bare, repoDir: join(root, "repo"), checkout: "main", newBranch: jobBranch(1), author: AUTHOR });
  await client.push({ bareDir: bare, remote, sha: SHA, branch: jobBranch(1) });
  await client.inspect({ bareDir: bare, base: SHA, staged: SHA, authorEmail: AUTHOR.email });

  const credential = gitCredentialArgs(GH);
  assert.deepEqual(credential, ["-c", "credential.https://github.com.helper=", "-c", `credential.https://github.com.helper=!${GH} auth git-credential`]);
  const network = new Set(["clone --bare", "fetch", "push"]);
  for (const call of calls) {
    assert.equal(call.file, GIT);
    assert.equal(call.args[0], "-C");
    assert.deepEqual(call.args.slice(2, 2 + GIT_BASE_CONFIG_ARGS.length), GIT_BASE_CONFIG_ARGS);
    const rest = call.args.slice(2 + GIT_BASE_CONFIG_ARGS.length);
    const hasCredential = rest[1] === credential[1] && rest[3] === credential[3];
    const command = (hasCredential ? rest.slice(4) : rest).filter((arg) => !arg.startsWith("--git-dir="));
    const key = command[0] === "clone" && command[1] === "--bare" ? "clone --bare" : command[0]!;
    const isNetwork = network.has(key) && (key !== "fetch" || !command.includes("transfer.fsckObjects=true"));
    assert.equal(hasCredential, isNetwork, call.args.join(" "));
    assert.equal(call.options.timeoutMs, isNetwork ? GIT_NET_TIMEOUT_MS : GIT_LOCAL_TIMEOUT_MS);
    assert.deepEqual(call.options.env, {
      HOME: "/home/example",
      PATH: "/usr/local/bin:/usr/bin:/bin",
      LANG: "C.UTF-8",
      GIT_TERMINAL_PROMPT: "0",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_NO_REPLACE_OBJECTS: "1",
      GH_PROMPT_DISABLED: "1",
    });
  }
  assert.deepEqual(
    calls.find((call) => call.args.includes("push"))?.args.slice(-5),
    ["push", "--porcelain", "--no-verify", remote, `${SHA}:refs/heads/self-agent/job-1`],
  );
  assert.deepEqual(gitChildEnv({ GH_TOKEN: "x" }).GH_TOKEN, undefined);
});

test("push の引数: 送り先が self-agent/ の下でない・+・--force 系・--mirror は実行せずに投げる", async () => {
  const { run, calls } = fakeRun(() => OK);
  const client = new GitClient({ gitPath: GIT, ghPath: GH, run });
  const remote = githubRemoteUrl("example-org", "example-repo");
  for (const branch of ["main", "+self-agent/job-1", "self-agent/../main", "self-agent/", "refs/heads/self-agent/job-1", "self-agent/job-1.lock", "self-agent/-x", "self-agent/a b"]) {
    await assert.rejects(client.push({ bareDir: "/tmp/x.git", remote, sha: SHA, branch }), branch);
    assert.throws(() => buildPushArgs(remote, SHA, branch), branch);
  }
  await assert.rejects(client.push({ bareDir: "/tmp/x.git", remote, sha: "HEAD", branch: jobBranch(1) }));
  await assert.rejects(client.push({ bareDir: "/tmp/x.git", remote: "--upload-pack=x", sha: SHA, branch: jobBranch(1) }));
  await assert.rejects(client.push({ bareDir: "/tmp/x.git", remote: "https://example.com/a/b.git", sha: SHA, branch: jobBranch(1) }));
  assert.equal(calls.length, 0);

  const good = buildPushArgs(remote, SHA, jobBranch(1));
  assertSafePushArgs(good);
  for (const extra of ["--force", "-f", "--force-with-lease", "--force-with-lease=x", "--mirror", "--delete", "--all", "--tags"]) {
    assert.throws(() => assertSafePushArgs([...good.slice(0, 1), extra, ...good.slice(1)]), extra);
  }
  assert.throws(() => assertSafePushArgs(["push", "--porcelain", remote, `+${SHA}:refs/heads/self-agent/job-1`]));
  assert.throws(() => assertSafePushArgs(["push", "--porcelain", remote, `${SHA}:refs/heads/main`]));
  assert.throws(() => assertSafePushArgs(["push", "--porcelain", remote, `${SHA}:refs/heads/self-agent/job-1`, `${SHA}:refs/heads/main`]));
  assert.throws(() => assertSafePushArgs(["push", "--porcelain", remote, `:refs/heads/self-agent/job-1`]));
});

test("push の失敗の分け方（偽の run）: 拒否・認証・それ以外", async () => {
  const remote = githubRemoteUrl("example-org", "example-repo");
  const cases: Array<[RunResult, string]> = [
    [{ kind: "exited", code: 1, stdout: `To x\n!\t${SHA}:refs/heads/self-agent/job-1\t[rejected] (fetch first)\nDone\n`, stderr: "" }, "push_rejected"],
    [{ kind: "exited", code: 128, stdout: "", stderr: "remote: Permission to example-org/example-repo.git denied to example.\nfatal: unable to access: The requested URL returned error: 403\n" }, "push_auth"],
    [{ kind: "exited", code: 128, stdout: "", stderr: "fatal: could not read Username for 'https://github.com': terminal prompts disabled\n" }, "push_auth"],
    [{ kind: "exited", code: 128, stdout: "", stderr: "fatal: unable to access: Could not resolve host: github.com\n" }, "push_failed"],
    [{ kind: "timeout" }, "push_failed"],
    [{ kind: "error" }, "push_failed"],
  ];
  for (const [result, failure] of cases) {
    const logs: string[] = [];
    const client = new GitClient({ gitPath: GIT, ghPath: GH, run: fakeRun(() => result).run, log: (line) => logs.push(line) });
    assert.deepEqual(await client.push({ bareDir: "/tmp/x.git", remote, sha: SHA, branch: jobBranch(1) }), { ok: false, failure });
    assert.equal(logs.length, 1);
    assert.equal(/example|github|self-agent/.test(logs[0]!), false, logs[0]);
  }
});

test("clone・fetch の失敗は clone_failed、続きでジョブのブランチが無ければ branch_missing（偽の run）", async () => {
  const remote = githubRemoteUrl("example-org", "example-repo");
  const failed = new GitClient({ gitPath: GIT, ghPath: GH, run: fakeRun(() => ({ kind: "exited", code: 128, stdout: "", stderr: "fatal: repository not found" })).run });
  assert.deepEqual(await failed.cloneBare({ remote, base: "main", bareDir: "/tmp/x.git" }), { ok: false, failure: "clone_failed" });
  assert.deepEqual(await failed.fetchBare({ remote, base: "main", branch: jobBranch(1), bareDir: "/tmp/x.git" }), { ok: false, failure: "clone_failed" });
  const missing = new GitClient({
    gitPath: GIT,
    ghPath: GH,
    run: fakeRun(() => ({ kind: "exited", code: 128, stdout: "", stderr: "fatal: couldn't find remote ref refs/heads/self-agent/job-1\n" })).run,
  });
  assert.deepEqual(await missing.fetchBare({ remote, base: "main", branch: jobBranch(1), bareDir: "/tmp/x.git" }), { ok: false, failure: "branch_missing" });
  const baseMissing = new GitClient({
    gitPath: GIT,
    ghPath: GH,
    run: fakeRun(() => ({ kind: "exited", code: 128, stdout: "", stderr: "fatal: couldn't find remote ref refs/heads/main\n" })).run,
  });
  assert.deepEqual(await baseMissing.fetchBare({ remote, base: "main", branch: jobBranch(1), bareDir: "/tmp/x.git" }), { ok: false, failure: "clone_failed" });
});

test("名前の形: gh のパス・リモート・ブランチ", () => {
  assert.throws(() => gitCredentialArgs("/usr/local/my bin/gh"));
  assert.throws(() => gitCredentialArgs("/usr/bin/gh;rm"));
  assert.throws(() => gitCredentialArgs("gh"));
  assert.throws(() => new GitClient({ gitPath: GIT, ghPath: "/opt/$(x)/gh" }));
  assert.throws(() => new GitClient({ gitPath: "git", ghPath: GH }));

  assert.equal(isAllowedRemote("https://github.com/example-org/example.repo.git"), true);
  assert.equal(isAllowedRemote("/tmp/remote.git"), true);
  for (const remote of ["https://github.com/a/b", "http://github.com/a/b.git", "ssh://github.com/a/b.git", "ext::sh -c x", "-x", "/tmp/../etc", "/tmp/a b", "https://github.com/a/../b.git"]) {
    assert.equal(isAllowedRemote(remote), false, remote);
  }
  assert.throws(() => githubRemoteUrl("a/b", "c"));
  assert.throws(() => githubRemoteUrl("a", ".."));

  for (const name of ["main", "release/1.2", "feature_x", "self-agent/job-1"]) assert.equal(isBranchName(name), true, name);
  for (const name of ["", "-x", ".x", "a..b", "a.lock", "a/", "/a", "a//b", "a b", "a~1", "a^", "a:b", "@{x}", "a.", "HEAD^"]) {
    assert.equal(isBranchName(name), false, name);
  }
  assert.equal(isJobBranch("self-agent/job-12"), true);
  assert.equal(isJobBranch("self-agent"), false);
  assert.equal(isJobBranch("main"), false);
  assert.equal(jobBranch(12), "self-agent/job-12");
  assert.throws(() => jobBranch(0));
  assert.throws(() => jobBranch(1.5));

  assert.equal(isForbiddenPath(".github/workflows/x.yml"), true);
  assert.equal(isForbiddenPath(".GitHub/workflows/x.yml"), true);
  assert.equal(isForbiddenPath(".github"), true);
  assert.equal(isForbiddenPath("docs/.github/x"), false);
  assert.equal(isForbiddenPath(".githubx"), false);
});
