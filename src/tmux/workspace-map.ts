// リポジトリ → ディレクトリ → ペインの地図（docs/plan/github-notifications.md §5.2）。押すたびに作り直す（キャッシュしない）。
// ディレクトリは git の remote で引く（名前の違いに左右されない）。tmux のセッション名は使わず、表示にだけ使う。
// git は execFile で起動時に解決した絶対パスを呼び、シェルを通さない
import { lstatSync, readdirSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, join, sep } from "node:path";
import { CLAUDE_COMMAND, type PaneState } from "./pane-state.ts";
import { CHILD_MAX_BUFFER, CHILD_TIMEOUT_MS, childEnv, execFileRunner, type RunCommand, type TmuxPane } from "./tmux.ts";

/** remote の URL を読む git の引数（-C <dir> の後ろ） */
export const GIT_REMOTES_ARGS: readonly string[] = ["config", "--get-regexp", "^remote\\..*\\.url$"];
/** worktree の元のリポジトリを求める git の引数（-C <dir> の後ろ） */
export const GIT_COMMON_DIR_ARGS: readonly string[] = ["rev-parse", "--path-format=absolute", "--git-common-dir"];

const OWNER = "[A-Za-z0-9-]{1,39}";
const NAME = "[A-Za-z0-9._-]+";
const REPO_NAME = /^[A-Za-z0-9._-]{1,100}$/;
const GITHUB_URLS: readonly RegExp[] = [
  new RegExp(`^https://github\\.com/(${OWNER})/(${NAME})$`, "i"),
  new RegExp(`^git@github\\.com:(${OWNER})/(${NAME})$`, "i"),
  new RegExp(`^ssh://git@github\\.com/(${OWNER})/(${NAME})$`, "i"),
];

/** GitHub の remote の URL（https・`git@github.com:`・`ssh://git@github.com/`。末尾の .git は任意）を `owner/repo`（小文字）にする。それ以外は undefined */
export function parseGitHubRemote(url: string): string | undefined {
  for (const pattern of GITHUB_URLS) {
    const match = pattern.exec(url.trim());
    if (match === null) continue;
    const owner = match[1]!;
    const name = match[2]!.replace(/\.git$/, "");
    if (!REPO_NAME.test(name) || name === "." || name === "..") return undefined;
    return `${owner}/${name}`.toLowerCase();
  }
  return undefined;
}

/** 地図に載ったペイン（claude のペインだけ）。cwd は pane_current_path の realpath、dir は対応する地図のディレクトリ */
export type MappedPane = { pane: TmuxPane; cwd: string | undefined; dir: string | undefined };

export type WorkspaceMap = {
  /** `owner/repo`（小文字）→ ディレクトリ（realpath。名前順） */
  repos: Map<string, string[]>;
  /** ワークスペースの 1 つ下のディレクトリ → その親（ワークスペースの直下のもの） */
  parents: Map<string, string>;
  panes: MappedPane[];
};

export type MapOptions = {
  workspaceDir: string;
  /** 起動時に解決した git の絶対パス */
  gitPath: string;
  /** tmux の list-panes の結果 */
  panes: readonly TmuxPane[];
  /** 既定は execFileRunner */
  run?: RunCommand;
};

function realpathOrUndefined(path: string): string | undefined {
  try {
    return realpathSync.native(path);
  } catch {
    return undefined;
  }
}

/** dir の中の隠しでないディレクトリ（symlink は除く）の名前。名前順。読めなければ空 */
function childDirs(dir: string): string[] {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
      .map((entry) => entry.name)
      .sort();
  } catch {
    return [];
  }
}

/** `.git`（ディレクトリかファイル）があるか */
function hasGit(dir: string): boolean {
  try {
    const stat = lstatSync(join(dir, ".git"));
    return stat.isDirectory() || stat.isFile();
  } catch {
    return false;
  }
}

/** child が dir そのものかその中か */
function isWithin(child: string, dir: string): boolean {
  return child === dir || child.startsWith(dir.endsWith(sep) ? dir : dir + sep);
}

/**
 * 地図を作る。ワークスペースの直下と、その 1 つ下（隠しディレクトリは見ない）の `.git` があるディレクトリについて、全 remote の GitHub の URL を読む。
 * ペインは claude のもの（pane_dead でない）だけを載せ、対応するディレクトリを決める:
 * cwd が地図のディレクトリの中ならいちばん深いもの、どれの中でもなければ git の common dir の親（worktree → 元のリポジトリ）が地図にあればそれ
 */
export async function buildWorkspaceMap(options: MapOptions): Promise<WorkspaceMap> {
  if (!isAbsolute(options.gitPath)) throw new Error("git は絶対パスで指定してください");
  const run = options.run ?? execFileRunner;
  const git = (dir: string, args: readonly string[]) =>
    run(options.gitPath, ["-C", dir, ...args], { env: childEnv(), timeoutMs: CHILD_TIMEOUT_MS, maxBuffer: CHILD_MAX_BUFFER });

  const repos = new Map<string, string[]>();
  const parents = new Map<string, string>();
  const allDirs = new Set<string>();
  const addDir = async (dir: string): Promise<void> => {
    if (!hasGit(dir)) return;
    const result = await git(dir, GIT_REMOTES_ARGS);
    // remote が 1 つも無ければ終了コード 1（地図に入らない）
    if (result.code !== 0) return;
    for (const line of result.stdout.split("\n")) {
      const space = line.indexOf(" ");
      if (space < 0) continue;
      const repo = parseGitHubRemote(line.slice(space + 1));
      if (repo === undefined) continue;
      const dirs = repos.get(repo) ?? [];
      if (!dirs.includes(dir)) dirs.push(dir);
      repos.set(repo, dirs);
      allDirs.add(dir);
    }
  };

  const root = realpathOrUndefined(options.workspaceDir);
  if (root !== undefined) {
    for (const name of childDirs(root)) {
      const top = join(root, name);
      await addDir(top);
      for (const childName of childDirs(top)) {
        const child = join(top, childName);
        parents.set(child, top);
        await addDir(child);
      }
    }
  }
  for (const dirs of repos.values()) dirs.sort();

  const deepest = (cwd: string): string | undefined => {
    let found: string | undefined;
    for (const dir of allDirs) if (isWithin(cwd, dir) && (found === undefined || dir.length > found.length)) found = dir;
    return found;
  };
  const panes: MappedPane[] = [];
  for (const pane of options.panes) {
    if (pane.dead || pane.currentCommand !== CLAUDE_COMMAND) continue;
    const cwd = realpathOrUndefined(pane.currentPath);
    let dir = cwd === undefined ? undefined : deepest(cwd);
    if (cwd !== undefined && dir === undefined) {
      const result = await git(cwd, GIT_COMMON_DIR_ARGS);
      const commonDir = result.code === 0 ? result.stdout.trim() : "";
      if (isAbsolute(commonDir)) {
        const owner = dirname(realpathOrUndefined(commonDir) ?? commonDir);
        if (allDirs.has(owner)) dir = owner;
      }
    }
    panes.push({ pane, cwd, dir });
  }
  return { repos, parents, panes };
}

/**
 * リポジトリ（`owner/repo`）のディレクトリと、送り先の候補のペイン（claude のもの）。
 * そのディレクトリのどれかに対応するペインが 1 つも無ければ、1 つ下のディレクトリの親（ワークスペースの直下のもの）にいるペインを候補にする
 * （親の中の別の子リポジトリに対応するペインは除く）
 */
export function findRepoPanes(map: WorkspaceMap, repo: string): { dirs: string[]; panes: TmuxPane[] } {
  const dirs = map.repos.get(repo.toLowerCase()) ?? [];
  const direct = map.panes.filter((entry) => entry.dir !== undefined && dirs.includes(entry.dir));
  if (direct.length > 0) return { dirs, panes: direct.map((entry) => entry.pane) };
  const parentDirs = [...new Set(dirs.flatMap((dir) => map.parents.get(dir) ?? []))];
  const fallback = map.panes.filter(
    (entry) =>
      entry.cwd !== undefined &&
      parentDirs.some(
        (parent) => isWithin(entry.cwd!, parent) && (entry.dir === undefined || entry.dir === parent || !isWithin(entry.dir, parent)),
      ),
  );
  return { dirs, panes: fallback.map((entry) => entry.pane) };
}

/** 送り先の選び方の結果。none = 候補が無い、waiting = 入力待ちが無い（待ち行列へ）、ambiguous = 送らずに一覧を返す */
export type PaneChoice =
  | { kind: "chosen"; pane: TmuxPane }
  | { kind: "none" }
  | { kind: "waiting" }
  | { kind: "ambiguous"; panes: TmuxPane[] };

/**
 * 候補から送り先を 1 つ選ぶ（§5.2 の 5）: 入力待ち（idle）のもの → その中でアクティブなウィンドウのアクティブなペイン →
 * それでも複数（か 0）なら ambiguous（アクティブなものが複数ならそれら、無ければ入力待ちのもの全部）
 */
export function choosePane(candidates: ReadonlyArray<{ pane: TmuxPane; state: PaneState }>): PaneChoice {
  if (candidates.length === 0) return { kind: "none" };
  const idle = candidates.filter((candidate) => candidate.state === "idle").map((candidate) => candidate.pane);
  if (idle.length === 0) return { kind: "waiting" };
  if (idle.length === 1) return { kind: "chosen", pane: idle[0]! };
  const active = idle.filter((pane) => pane.windowActive && pane.paneActive);
  if (active.length === 1) return { kind: "chosen", pane: active[0]! };
  return { kind: "ambiguous", panes: active.length > 1 ? active : idle };
}

/** 表示用のペインの名前（`<session>:<window>.<pane>`） */
export function paneLabel(pane: TmuxPane): string {
  return `${pane.sessionName}:${pane.windowIndex}.${pane.paneIndex}`;
}
