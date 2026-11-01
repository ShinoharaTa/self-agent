// Claude Code のセッション → tmux のペイン（docs/plan/claude-code-sessions.md §3.1）。claude の pid から /proc/<pid>/stat の親 pid を
// CC_PANE_ANCESTOR_DEPTH 段までたどり、`tmux list-panes -a` の pane_pid に当たるペインを採る（pane_pid はシェルで、claude はその子）。
// 当たらなければ sessions/<pid>.json の tmux 欄（`%<pane>`。内部形式）を補助に、そのペインの pane_current_command が claude で、
// その pane_pid が claude の祖先（CC_PANE_HINT_ANCESTOR_DEPTH 段まで）と確かめられるときだけ採る。どちらでも決まらなければ tmux の外。
// 画面の写し（CC2）と送信（CC3）で使う。送り先は呼ぶたびに引き直す。log は出さない（pid・ペイン id は呼び出し側も出さない）
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Tmux, TmuxFailure, TmuxPane } from "../tmux/tmux.ts";

/** 親 pid をたどる段数（§3.1） */
export const CC_PANE_ANCESTOR_DEPTH = 3;
/** sessions/<pid>.json の tmux 欄を補助に使うときに祖先関係を確かめる段数 */
export const CC_PANE_HINT_ANCESTOR_DEPTH = 8;

/** pid の親 pid。分からなければ undefined */
export type ParentPidReader = (pid: number) => number | undefined;

/**
 * /proc/<pid>/stat の中身から親 pid を読む（純関数）。comm は括弧と空白を含みうるので、最後の `)` の後ろから読む
 * （`<pid> (<comm>) <state> <ppid> …`）。形が合わなければ undefined
 */
export function parseStatParentPid(stat: string): number | undefined {
  const close = stat.lastIndexOf(")");
  if (close < 0) return undefined;
  const fields = stat.slice(close + 1).trim().split(/\s+/);
  const ppid = fields[1];
  if (ppid === undefined || !/^\d{1,10}$/.test(ppid)) return undefined;
  const value = Number(ppid);
  return Number.isSafeInteger(value) ? value : undefined;
}

/** /proc/<pid>/stat から親 pid を読む。読めなければ undefined（procDir はテスト用） */
export function procParentPid(procDir: string = "/proc"): ParentPidReader {
  return (pid) => {
    if (!Number.isSafeInteger(pid) || pid < 1) return undefined;
    try {
      return parseStatParentPid(readFileSync(join(procDir, String(pid), "stat"), "utf8"));
    } catch {
      return undefined;
    }
  };
}

/** pid の祖先（親から順に depth 段まで）。1 以下（init・不明）に着いたら止める */
export function ancestorPids(pid: number, parentOf: ParentPidReader, depth: number): number[] {
  const result: number[] = [];
  let current = pid;
  for (let i = 0; i < depth; i++) {
    const parent = parentOf(current);
    if (parent === undefined || parent <= 1 || parent === pid || result.includes(parent)) break;
    result.push(parent);
    current = parent;
  }
  return result;
}

/** sessions/<pid>.json の tmux 欄（`<session>:<window>.%<pane>`）からペイン id（`%N`）。形が合わなければ undefined */
export function paneIdOfHint(hint: string | undefined): string | undefined {
  const match = hint === undefined ? null : /\.(%\d{1,9})$/.exec(hint);
  return match === null ? undefined : match[1];
}

/** ペインを決める材料（claude agents --json の pid と、sessions/<pid>.json の tmux 欄） */
export type PaneTarget = { pid: number; tmux: string | undefined };

/** pid が claude の pid そのものか祖先のペイン。死んだペインは採らない（純関数。parentOf だけ /proc を読む） */
export function findSessionPane(target: PaneTarget, panes: readonly TmuxPane[], parentOf: ParentPidReader): TmuxPane | undefined {
  const alive = panes.filter((pane) => !pane.dead && pane.panePid > 1);
  const near = [target.pid, ...ancestorPids(target.pid, parentOf, CC_PANE_ANCESTOR_DEPTH)];
  for (const pid of near) {
    const pane = alive.find((candidate) => candidate.panePid === pid);
    if (pane !== undefined) return pane;
  }
  const hinted = paneIdOfHint(target.tmux);
  if (hinted === undefined) return undefined;
  const pane = alive.find((candidate) => candidate.paneId === hinted);
  if (pane === undefined || pane.currentCommand !== "claude") return undefined;
  return ancestorPids(target.pid, parentOf, CC_PANE_HINT_ANCESTOR_DEPTH).includes(pane.panePid) ? pane : undefined;
}

/** 1 回の list-panes で引いた結果。tmux のサーバーが無い・読めなければ ok: false（どのセッションも tmux の外として扱う） */
export type PaneLookup =
  | { ok: true; find: (target: PaneTarget) => TmuxPane | undefined }
  | { ok: false; reason: TmuxFailure };

export type CcPaneResolverDeps = {
  tmux: Pick<Tmux, "listPanes">;
  parentOf: ParentPidReader;
};

/** セッション → ペインを引く。lookup() のたびに list-panes を 1 回読み直す（送り先・画面の写しは使うたびに引き直す） */
export class CcPaneResolver {
  private readonly deps: CcPaneResolverDeps;

  constructor(deps: CcPaneResolverDeps) {
    this.deps = deps;
  }

  async lookup(): Promise<PaneLookup> {
    const result = await this.deps.tmux.listPanes();
    if (!result.ok) return result;
    const panes = result.value;
    return { ok: true, find: (target) => findSessionPane(target, panes, this.deps.parentOf) };
  }

  /** 1 つのセッションのペイン。tmux の外・サーバーが無い・読めなければ undefined */
  async resolve(target: PaneTarget): Promise<TmuxPane | undefined> {
    const lookup = await this.lookup();
    return lookup.ok ? lookup.find(target) : undefined;
  }
}
