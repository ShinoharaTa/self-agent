// Claude Code のセッション → tmux のペイン（docs/plan/claude-code-sessions.md §3.1）。claude の pid から /proc/<pid>/stat の親 pid を
// CC_PANE_ANCESTOR_DEPTH 段までたどり、`tmux list-panes -a` の pane_pid に当たるペインを採る（pane_pid はシェルで、claude はその子）。
// 当たらなければ sessions/<pid>.json の tmux 欄（`%<pane>`。内部形式）を補助に、その pane_pid が同じ範囲の祖先と確かめられるときだけ採る。
// どちらの経路も pane_current_command が claude で生きているペインだけ。たどる途中で一覧のほかのセッションの pid に当たったら
// （claude の中で起動した claude）打ち切る。どちらでも決まらなければ tmux の外。
// 画面の写し（CC2）と送信（CC3）で使う。送り先は主の経路で当たったペインだけ（findSendablePane。補助の tmux 欄だけでは送らない）で、呼ぶたびに引き直す。log は出さない（pid・ペイン id は呼び出し側も出さない）
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { CLAUDE_COMMAND } from "../tmux/pane-state.ts";
import type { Tmux, TmuxFailure, TmuxPane } from "../tmux/tmux.ts";

/** 親 pid をたどる段数（§3.1 の 3 段に、間にラッパーが入る分の余裕を足したもの。補助の経路も同じ） */
export const CC_PANE_ANCESTOR_DEPTH = 8;

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

/**
 * sessions/<pid>.json の tmux 欄（`<session>:@<window_id>.%<pane>`。claude-dirs.ts と同じく `<session>:<window>.%<pane>` も）から
 * ペイン id（`%N`）。形が合わなければ undefined
 */
export function paneIdOfHint(hint: string | undefined): string | undefined {
  const match = hint === undefined ? null : /:@?\d{1,6}\.(%\d{1,9})$/.exec(hint);
  return match === null ? undefined : match[1];
}

/** ペインを決める材料（claude agents --json の pid と、sessions/<pid>.json の tmux 欄） */
export type PaneTarget = { pid: number; tmux: string | undefined };

/**
 * pane_pid が claude の pid そのものか祖先のペイン（純関数。parentOf だけ /proc を読む）。死んだペイン・pane_current_command が claude で
 * ないペインは採らない。sessionPids は一覧のすべてのセッションの pid で、たどる途中で自分以外のものに当たったら undefined
 */
export function findSessionPane(
  target: PaneTarget,
  panes: readonly TmuxPane[],
  parentOf: ParentPidReader,
  sessionPids: ReadonlySet<number>,
): TmuxPane | undefined {
  const alive = panes.filter((pane) => !pane.dead && pane.panePid > 1 && pane.currentCommand === CLAUDE_COMMAND);
  const chain = [target.pid];
  for (const pid of chain.concat(ancestorPids(target.pid, parentOf, CC_PANE_ANCESTOR_DEPTH))) {
    if (pid !== target.pid) {
      // 入れ子（ほかのセッションの中で起動した claude）: そのペインはほかのセッションのもの
      if (sessionPids.has(pid)) return undefined;
      chain.push(pid);
    }
    const pane = alive.find((candidate) => candidate.panePid === pid);
    if (pane !== undefined) return pane;
  }
  const hinted = paneIdOfHint(target.tmux);
  if (hinted === undefined) return undefined;
  const pane = alive.find((candidate) => candidate.paneId === hinted);
  return pane !== undefined && chain.includes(pane.panePid) ? pane : undefined;
}

/** list-panes の直近の結果（/api/status の cc.tmux） */
export type TmuxState = "ok" | TmuxFailure;

/** 送り先を引いた結果。not_in_tmux = 主の経路で当たるペインが無い、not_claude = 当たったペインの pane_current_command が claude でない（絶対に送らない） */
export type SendablePane = { ok: true; pane: TmuxPane } | { ok: false; reason: "not_in_tmux" | "not_claude" };

/**
 * 送ってよいペイン（§3.1・§7 の 2。純関数）: claude の pid そのものか CC_PANE_ANCESTOR_DEPTH 段までの祖先が pane_pid の、死んでいないペインで、
 * pane_current_command が claude のものだけ。sessions/<pid>.json の tmux 欄（補助）だけで採れるペインには送らない。
 * たどる途中で一覧のほかのセッションの pid に当たったら（入れ子）tmux の外とする
 */
export function findSendablePane(
  target: Pick<PaneTarget, "pid">,
  panes: readonly TmuxPane[],
  parentOf: ParentPidReader,
  sessionPids: ReadonlySet<number>,
): SendablePane {
  const alive = panes.filter((pane) => !pane.dead && pane.panePid > 1);
  for (const pid of [target.pid, ...ancestorPids(target.pid, parentOf, CC_PANE_ANCESTOR_DEPTH)]) {
    if (pid !== target.pid && sessionPids.has(pid)) return { ok: false, reason: "not_in_tmux" };
    const pane = alive.find((candidate) => candidate.panePid === pid);
    if (pane !== undefined) return pane.currentCommand === CLAUDE_COMMAND ? { ok: true, pane } : { ok: false, reason: "not_claude" };
  }
  return { ok: false, reason: "not_in_tmux" };
}

/** 1 回の list-panes で引いた結果。tmux のサーバーが無い・読めなければ ok: false（どのセッションも tmux の外として扱う） */
export type PaneLookup =
  | {
      ok: true;
      /** 画面の写しに使うペイン（findSessionPane） */
      find: (target: PaneTarget) => TmuxPane | undefined;
      /** 送ってよいペイン（findSendablePane） */
      sendable: (target: PaneTarget) => SendablePane;
    }
  | { ok: false; reason: TmuxFailure };

export type CcPaneResolverDeps = {
  tmux: Pick<Tmux, "listPanes">;
  parentOf: ParentPidReader;
};

/**
 * セッション → ペインを引く。lookup() のたびに list-panes を 1 回読み直す（送り先・画面の写しは使うたびに引き直す）。
 * sessionPids は今の一覧（registry の snapshot）のすべての pid
 */
export class CcPaneResolver {
  private readonly deps: CcPaneResolverDeps;
  private last: TmuxState | undefined;

  constructor(deps: CcPaneResolverDeps) {
    this.deps = deps;
  }

  async lookup(sessionPids: ReadonlySet<number>): Promise<PaneLookup> {
    const result = await this.deps.tmux.listPanes();
    this.last = result.ok ? "ok" : result.reason;
    if (!result.ok) return result;
    const panes = result.value;
    const { parentOf } = this.deps;
    return {
      ok: true,
      find: (target) => findSessionPane(target, panes, parentOf, sessionPids),
      sendable: (target) => findSendablePane(target, panes, parentOf, sessionPids),
    };
  }

  /** 1 つのセッションのペイン。tmux の外・サーバーが無い・読めなければ undefined */
  async resolve(target: PaneTarget, sessionPids: ReadonlySet<number>): Promise<TmuxPane | undefined> {
    const lookup = await this.lookup(sessionPids);
    return lookup.ok ? lookup.find(target) : undefined;
  }

  /** 直近の lookup の list-panes の結果。まだ読んでいなければ undefined（/api/status は spawn せずにこれを出す） */
  lastTmux(): TmuxState | undefined {
    return this.last;
  }
}
