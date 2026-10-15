import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PaneState } from "../src/tmux/pane-state.ts";
import type { RunCommand, TmuxPane } from "../src/tmux/tmux.ts";
import {
  buildWorkspaceMap,
  choosePane,
  findRepoPanes,
  GIT_COMMON_DIR_ARGS,
  GIT_REMOTES_ARGS,
  paneLabel,
  parseGitHubRemote,
} from "../src/tmux/workspace-map.ts";

const GIT = "/usr/bin/git";

test("parseGitHubRemote: https・ssh の URL を owner/repo（小文字）に", () => {
  const cases: Array<[string, string | undefined]> = [
    ["https://github.com/Owner/Repo.git", "owner/repo"],
    ["https://github.com/owner/repo", "owner/repo"],
    ["git@github.com:Org/Web.site.git", "org/web.site"],
    ["ssh://git@github.com/owner/my_repo-2", "owner/my_repo-2"],
    ["https://GitHub.com/owner/repo.git\n", "owner/repo"],
    ["https://gitlab.com/owner/repo.git", undefined],
    ["https://github.com/owner/repo/tree/main", undefined],
    ["https://github.com/owner", undefined],
    ["https://evil.example/github.com/owner/repo", undefined],
    ["git@github.com:owner/..", undefined],
    ["https://github.com/owner/.git", undefined],
    [`https://github.com/owner/${"r".repeat(101)}`, undefined],
    ["/home/u/local/repo", undefined],
  ];
  for (const [url, expected] of cases) assert.equal(parseGitHubRemote(url), expected, url);
});

function pane(paneId: string, currentPath: string, overrides: Partial<TmuxPane> = {}): TmuxPane {
  return {
    sessionName: `s${paneId.slice(1)}`,
    windowIndex: 0,
    paneIndex: 0,
    paneId,
    windowActive: true,
    paneActive: true,
    currentPath,
    currentCommand: "claude",
    inMode: false,
    dead: false,
    ...overrides,
  };
}

/**
 * ワークスペースの形（§1.2・§5.2 の各場合）を一時ディレクトリに作る。git は偽物（-C のディレクトリごとに remote・common dir を返す）
 * - alpha: https の remote。中に .claude/worktrees/agent-1
 * - alpha--task: alpha の worktree（`<project>--<task>`。.git はファイル）
 * - org-site: GitHub の名前（Org/Website）と違う。ssh の origin と upstream
 * - parent: 親もリポジトリで、中に子リポジトリ child・other
 * - multi: リポジトリでない親の中に子リポジトリ sub1 と、2 つ下に alpha の worktree（multi/tmp/wt-alpha。地図を作るときには見ない深さ）
 * - norepo: remote が無い。plain: .git が無い。gitlab: GitHub でない remote。.hidden: 隠し。link: alpha への symlink
 * - 外の wt-alpha: alpha の worktree（/tmp の scratchpad の wt-* の形）。outside: リポジトリでない
 */
function setup(t: TestContext) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "self-agent-test-")));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const ws = join(root, "workspace");
  const dir = (path: string): string => {
    mkdirSync(path, { recursive: true });
    return path;
  };
  const repo = (path: string, gitFile = false): string => {
    dir(path);
    if (gitFile) writeFileSync(join(path, ".git"), "gitdir: elsewhere\n");
    else dir(join(path, ".git"));
    return path;
  };
  const d = {
    alpha: repo(join(ws, "alpha")),
    alphaAgent: dir(join(ws, "alpha/.claude/worktrees/agent-1")),
    alphaTask: repo(join(ws, "alpha--task"), true),
    site: repo(join(ws, "org-site")),
    siteSrc: dir(join(ws, "org-site/src")),
    parent: repo(join(ws, "parent")),
    child: repo(join(ws, "parent/child")),
    other: repo(join(ws, "parent/other")),
    multi: dir(join(ws, "multi")),
    sub1: repo(join(ws, "multi/sub1")),
    multiWt: repo(join(ws, "multi/tmp/wt-alpha"), true),
    norepo: repo(join(ws, "norepo")),
    plain: dir(join(ws, "plain")),
    gitlab: repo(join(ws, "gitlab")),
    hidden: repo(join(ws, ".hidden")),
    wt: dir(join(root, "scratchpad/wt-alpha/sub")),
    outside: dir(join(root, "outside")),
  };
  symlinkSync(d.alpha, join(ws, "link"));
  const remotes = new Map<string, string>([
    [d.alpha, "remote.origin.url https://github.com/Owner/Alpha.git\n"],
    [d.alphaTask, "remote.origin.url https://github.com/Owner/Alpha.git\n"],
    [d.site, "remote.origin.url git@github.com:Org/Website.git\nremote.upstream.url ssh://git@github.com/Upstream/Website\n"],
    [d.parent, "remote.origin.url https://github.com/owner/parent\n"],
    [d.child, "remote.origin.url https://github.com/owner/child.git\n"],
    [d.other, "remote.origin.url https://github.com/owner/other.git\n"],
    [d.sub1, "remote.origin.url https://github.com/owner/sub1.git\nremote.mirror.url /srv/mirror/sub1.git\n"],
    [d.gitlab, "remote.origin.url https://gitlab.com/owner/gitlab.git\n"],
    [d.hidden, "remote.origin.url https://github.com/owner/hidden.git\n"],
  ]);
  const commonDirs = new Map<string, string>([
    [d.wt, `${d.alpha}/.git\n`],
    [d.multiWt, `${d.alpha}/.git\n`],
  ]);
  const calls: Array<{ file: string; args: readonly string[]; env: Record<string, string> }> = [];
  const run: RunCommand = async (file, args, options) => {
    calls.push({ file, args, env: options.env });
    const [flag, cwd, ...rest] = args;
    assert.equal(flag, "-C");
    if (rest.join(" ") === GIT_REMOTES_ARGS.join(" ")) {
      const out = remotes.get(cwd!);
      return out === undefined ? { code: 1, stdout: "", stderr: "" } : { code: 0, stdout: out, stderr: "" };
    }
    if (rest.join(" ") === GIT_COMMON_DIR_ARGS.join(" ")) {
      const out = commonDirs.get(cwd!);
      return out === undefined ? { code: 128, stdout: "", stderr: "fatal: not a git repository" } : { code: 0, stdout: out, stderr: "" };
    }
    return assert.fail(`想定していない git の引数: ${rest.join(" ")}`);
  };
  return { ws, d, run, calls };
}

test("buildWorkspaceMap: remote から owner/repo → ディレクトリの地図を作る", async (t) => {
  const { ws, d, run, calls } = setup(t);
  const map = await buildWorkspaceMap({ workspaceDir: ws, gitPath: GIT, panes: [], run });
  assert.deepEqual(
    Object.fromEntries([...map.repos.entries()].sort(([a], [b]) => a.localeCompare(b))),
    {
      "org/website": [d.site],
      "owner/alpha": [d.alpha, d.alphaTask],
      "owner/child": [d.child],
      "owner/other": [d.other],
      "owner/parent": [d.parent],
      "owner/sub1": [d.sub1],
      "upstream/website": [d.site],
    },
  );
  // git は .git のあるディレクトリにだけ、固定の引数で呼ぶ（隠し・symlink・.git の無いもの・2 つより下は呼ばない）
  const dirs = calls.map((call) => call.args[1]);
  assert.ok(calls.every((call) => call.file === GIT && call.args.slice(2).join(" ") === GIT_REMOTES_ARGS.join(" ")));
  assert.deepEqual([...dirs].sort(), [d.alpha, d.alphaTask, d.gitlab, d.norepo, d.parent, d.child, d.other, d.site, d.sub1].sort());
  assert.deepEqual(Object.keys(calls[0]!.env).sort(), ["HOME", "LANG", "PATH"]);
});

test("buildWorkspaceMap・findRepoPanes: ペインの cwd から対応するディレクトリ・リポジトリを引く", async (t) => {
  const { ws, d, run, calls } = setup(t);
  const panes = [
    pane("%1", d.alpha),
    pane("%2", d.alphaAgent),
    pane("%3", d.alpha, { currentCommand: "bash" }),
    pane("%4", d.wt),
    pane("%5", d.parent),
    pane("%6", d.other),
    pane("%7", d.siteSrc),
    pane("%8", d.outside),
    pane("%9", d.alpha, { dead: true }),
    pane("%10", d.multi),
    pane("%11", d.alphaTask),
    pane("%12", join(ws, "link")),
    pane("%13", join(ws, "removed")),
    pane("%14", d.multiWt),
  ];
  const map = await buildWorkspaceMap({ workspaceDir: ws, gitPath: GIT, panes, run });
  const ids = (repo: string) => findRepoPanes(map, repo).panes.map((entry) => entry.paneId);
  // .claude/worktrees・/tmp の worktree・`<project>--<task>`・symlink の cwd も元のリポジトリに。シェル・pane_dead は候補にしない
  assert.deepEqual(ids("owner/alpha"), ["%1", "%2", "%4", "%11", "%12", "%14"]);
  assert.deepEqual(findRepoPanes(map, "owner/alpha").dirs, [d.alpha, d.alphaTask]);
  // 名前の違い・upstream・大文字小文字
  assert.deepEqual(ids("Org/Website"), ["%7"]);
  assert.deepEqual(ids("upstream/website"), ["%7"]);
  // 子リポジトリ: 自分のペインがあればそれ、無ければ親のディレクトリにいるペイン（別の子リポジトリのペインは除く）
  assert.deepEqual(ids("owner/other"), ["%6"]);
  assert.deepEqual(ids("owner/child"), ["%5"]);
  assert.deepEqual(ids("owner/parent"), ["%5"]);
  // リポジトリでない親の中でも、worktree で別のリポジトリ（alpha）に対応するペイン（%14）は親の候補にしない
  assert.deepEqual(ids("owner/sub1"), ["%10"]);
  // 地図に無い（remote 無し・GitHub でない・隠し・知らない）
  for (const repo of ["owner/norepo", "owner/gitlab", "owner/hidden", "someone/else"]) assert.deepEqual(findRepoPanes(map, repo), { dirs: [], panes: [] });
  // git の common dir を引くのは、地図のディレクトリの中にいない claude のペインだけ
  const revParse = calls.filter((call) => call.args.slice(2).join(" ") === GIT_COMMON_DIR_ARGS.join(" ")).map((call) => call.args[1]);
  assert.deepEqual(revParse.sort(), [d.multi, d.multiWt, d.outside, d.wt].sort());
  assert.deepEqual(
    map.panes.find((entry) => entry.pane.paneId === "%13"),
    { pane: panes[12], cwd: undefined, dir: undefined },
  );
});

test("buildWorkspaceMap: ワークスペースが無ければ空。git は絶対パスだけ", async (t) => {
  const { d, run } = setup(t);
  const map = await buildWorkspaceMap({ workspaceDir: join(d.outside, "none"), gitPath: GIT, panes: [pane("%1", d.alpha)], run });
  assert.equal(map.repos.size, 0);
  assert.deepEqual(findRepoPanes(map, "owner/alpha"), { dirs: [], panes: [] });
  await assert.rejects(buildWorkspaceMap({ workspaceDir: d.alpha, gitPath: "git", panes: [], run }));
});

test("choosePane: 入力待ち → アクティブなウィンドウのアクティブなペイン → それでも複数なら送らない", () => {
  const a = pane("%1", "/w/a", { sessionName: "a", windowActive: true, paneActive: true });
  const b = pane("%2", "/w/a", { sessionName: "a", windowIndex: 1, windowActive: false, paneActive: true });
  const c = pane("%3", "/w/a", { sessionName: "c", paneIndex: 1, windowActive: true, paneActive: true });
  const d = pane("%4", "/w/a", { sessionName: "a", paneIndex: 1, windowActive: true, paneActive: false });
  const of = (...pairs: Array<[TmuxPane, PaneState]>) => pairs.map(([p, state]) => ({ pane: p, state }));
  assert.deepEqual(choosePane([]), { kind: "none" });
  assert.deepEqual(choosePane(of([a, "busy"], [b, "draft"])), { kind: "waiting" });
  assert.deepEqual(choosePane(of([a, "busy"], [b, "idle"])), { kind: "chosen", pane: b });
  assert.deepEqual(choosePane(of([a, "idle"], [b, "idle"], [d, "idle"])), { kind: "chosen", pane: a });
  assert.deepEqual(choosePane(of([a, "idle"], [c, "idle"], [b, "idle"])), { kind: "ambiguous", panes: [a, c] });
  assert.deepEqual(choosePane(of([b, "idle"], [d, "idle"], [a, "busy"])), { kind: "ambiguous", panes: [b, d] });
  assert.equal(paneLabel(c), "c:0.1");
});
