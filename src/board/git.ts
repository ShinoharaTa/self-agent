// 進行状況の git の読み取り（docs/plan/project-board.md §4 PS1）。tmux.ts の execFileRunner でシェルを通さず、起動時に解決した絶対パスの git を
// 固定の引数で呼ぶ。env は HOME・PATH（固定）・LANG・GIT_OPTIONAL_LOCKS=0 だけ（index.lock を取らない）。時間切れは 10 秒。書き込みはしない
import { isAbsolute } from "node:path";
import { CHILD_MAX_BUFFER, childEnv, execFileRunner, type RunCommand } from "../tmux/tmux.ts";
import { parseGitHubRemote } from "../tmux/workspace-map.ts";
import type { BoardLocal } from "./classify.ts";

/** 1 回の git の時間切れ */
export const BOARD_GIT_TIMEOUT_MS = 10_000;

/** origin の URL（リポジトリの設定だけ。worktree では元のリポジトリの設定） */
export const GIT_ORIGIN_URL_ARGS: readonly string[] = ["config", "--local", "--get", "remote.origin.url"];
/** リポジトリの設定の fsmonitor（コマンドを起動しうる）と untracked cache（書き込みうる）を、読むときだけ切る */
export const GIT_READ_ONLY_CONFIG: readonly string[] = ["-c", "core.fsmonitor=false", "-c", "core.untrackedCache=false"];
export const GIT_STATUS_ARGS: readonly string[] = [...GIT_READ_ONLY_CONFIG, "status", "--porcelain=v2", "--branch"];
export const GIT_LAST_COMMIT_ARGS: readonly string[] = [...GIT_READ_ONLY_CONFIG, "log", "-1", "--format=%ct"];

/** git の子の env（tmux.ts の childEnv に GIT_OPTIONAL_LOCKS=0） */
export function boardGitEnv(): Record<string, string> {
  return { ...childEnv(), GIT_OPTIONAL_LOCKS: "0" };
}

/** `git status --porcelain=v2 --branch` の出力を読む（純関数）。`# branch.head`・`# branch.ab +A -B` と、`#` で始まらない行の数 */
export function parsePorcelainStatus(stdout: string): Omit<BoardLocal, "lastCommitAt"> {
  let branch: string | null = null;
  let ahead = 0;
  let behind = 0;
  let dirty = 0;
  for (const line of stdout.split("\n")) {
    if (line === "") continue;
    if (!line.startsWith("#")) {
      dirty++;
      continue;
    }
    const head = /^# branch\.head (.+)$/.exec(line);
    if (head !== null) {
      // (detached) はブランチではない
      branch = head[1] === "(detached)" ? null : head[1]!.slice(0, 200);
      continue;
    }
    const ab = /^# branch\.ab \+(\d{1,9}) -(\d{1,9})$/.exec(line);
    if (ab !== null) {
      ahead = Number(ab[1]);
      behind = Number(ab[2]);
    }
  }
  return { branch, dirty, ahead, behind };
}

/** `git log -1 --format=%ct` の出力（UNIX 秒）を ISO にする。形が違えば null */
export function parseCommitTime(stdout: string): string | null {
  const text = stdout.trim();
  if (!/^\d{1,12}$/.test(text)) return null;
  const date = new Date(Number(text) * 1000);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

/** remote の結果。none = origin が無い・GitHub の URL でない、failed = git が失敗した（リポジトリでない・起動できない） */
export type RemoteResult = { kind: "ok"; repo: string } | { kind: "none" } | { kind: "failed" };

export type BoardGit = {
  remote(dir: string): Promise<RemoteResult>;
  /** git が失敗したら undefined。最後のコミットが読めない（コミットが無い）のは lastCommitAt を null にするだけ */
  local(dir: string): Promise<BoardLocal | undefined>;
};

export function createBoardGit(options: { gitPath: string; run?: RunCommand }): BoardGit {
  if (!isAbsolute(options.gitPath)) throw new Error("git は絶対パスで指定してください");
  const run = options.run ?? execFileRunner;
  const git = (dir: string, args: readonly string[]) =>
    run(options.gitPath, ["-C", dir, ...args], { env: boardGitEnv(), timeoutMs: BOARD_GIT_TIMEOUT_MS, maxBuffer: CHILD_MAX_BUFFER });
  return {
    async remote(dir) {
      const result = await git(dir, GIT_ORIGIN_URL_ARGS);
      // origin が無ければ終了コード 1
      if (result.code === 1) return { kind: "none" };
      if (result.code !== 0) return { kind: "failed" };
      const repo = parseGitHubRemote(result.stdout);
      return repo === undefined ? { kind: "none" } : { kind: "ok", repo };
    },
    async local(dir) {
      const status = await git(dir, GIT_STATUS_ARGS);
      if (status.code !== 0) return undefined;
      const log = await git(dir, GIT_LAST_COMMIT_ARGS);
      return { ...parsePorcelainStatus(status.stdout), lastCommitAt: log.code === 0 ? parseCommitTime(log.stdout) : null };
    },
  };
}
