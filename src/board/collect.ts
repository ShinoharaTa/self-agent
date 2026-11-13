// 進行状況の収集（docs/plan/project-board.md §4 PS1。SELF_AGENT_BOARD=1 で gh と git があるときだけ main が作る）。
// 起動から 30 秒後と、その後は 15 分ごとに、登録したプロジェクトを名前の順に 1 つずつ git と GitHub で確かめ、classify.ts で判定して board_projects に書く。
// tick は重ねない。refresh（登録した直後・POST /api/board/refresh）は前の回が終わってからもう 1 回回す。LLM は使わない。
// log は件数と種類だけ（リポジトリ名・ディレクトリ・題名・URL・番号は出さない）
import { realpathSync } from "node:fs";
import { isAbsolute, sep } from "node:path";
import { type CcPlaces, projectDir } from "../cc/starter.ts";
import { type GhHeaders, rateLimitFromHeaders } from "../github/gh.ts";
import { fetchLogin } from "../github/poller.ts";
import type { BoardError, BoardProjectRow, BoardStore } from "../store/board.ts";
import { type BoardCcSession, type BoardItem, type BoardLocal, BOARD_STATES, type BoardState, type Classification, classifyProject } from "./classify.ts";
import type { BoardGit } from "./git.ts";
import { fetchBoardItems, type GhGet } from "./github.ts";

/** 周期（15 分） */
export const BOARD_POLL_MS = 15 * 60 * 1000;
/** 起動から最初の回まで */
export const BOARD_FIRST_DELAY_MS = 30_000;
/** 直近の X-RateLimit-Remaining がこれ未満なら、その回は GitHub を取らない */
export const BOARD_LOW_RATE_REMAINING = 1000;

/** その場の材料（Claude Code のセッションと、プロジェクトのセッションの実行中のターン） */
export type BoardLive = { ccSessions: BoardCcSession[]; turnRunning: boolean };

/** dir は登録した名前、path はその実際の場所（projectDir を通らなければ undefined） */
export type BoardLiveSource = (dir: string, path: string | undefined) => BoardLive;

export const NO_LIVE: BoardLive = { ccSessions: [], turnRunning: false };

/** cwd の実際の場所（解決できなければそのまま） */
function realOrSelf(path: string): string {
  try {
    return realpathSync.native(path);
  } catch {
    return path;
  }
}

/**
 * Claude Code のセッションのうち、cwd がプロジェクトの dir（realpath）そのものかその中のもの（registry の一覧から。worktree もその中なら当たる）。
 * cwd の無いセッションは当てない
 */
export function boardCcSessions(
  sessions: ReadonlyArray<{ sessionId: string; cwd: string | undefined; state: BoardCcSession["state"]; pendingPermission: boolean }>,
  projectPath: string,
): BoardCcSession[] {
  const prefix = projectPath.endsWith(sep) ? projectPath : projectPath + sep;
  return sessions
    .filter((session) => {
      if (session.cwd === undefined || !isAbsolute(session.cwd)) return false;
      const cwd = realOrSelf(session.cwd);
      return cwd === projectPath || cwd.startsWith(prefix);
    })
    .map((session) => ({ sessionId: session.sessionId, state: session.state, pendingPermission: session.pendingPermission }));
}

/** 書いた行とその場の材料から判定する（収集と GET /api/board で同じ判定にする） */
export function classifyRow(row: Pick<BoardProjectRow, "checkedAt" | "error" | "local" | "items">, live: BoardLive): Classification {
  return classifyProject({
    unchecked: row.checkedAt === null,
    noRemote: row.error === "no_remote",
    local: row.error === "git_failed" ? null : row.local,
    items: row.items,
    ccSessions: live.ccSessions,
    sessionTurnRunning: live.turnRunning,
  });
}

export type BoardTimers = {
  /** ms 後に fn を 1 回呼び、取り消す関数を返す */
  after(fn: () => void, ms: number): () => void;
};

const REAL_TIMERS: BoardTimers = {
  after: (fn, ms) => {
    const timer = setTimeout(fn, ms);
    return () => clearTimeout(timer);
  },
};

export type BoardCollectorDeps = {
  store: Pick<BoardStore, "listActive" | "saveResult">;
  places: CcPlaces;
  git: BoardGit;
  gh: GhGet;
  live: BoardLiveSource;
  now: () => Date;
  timers?: BoardTimers;
  log: (message: string) => void;
};

export class BoardCollector {
  private readonly deps: BoardCollectorDeps;
  private readonly timers: BoardTimers;
  private cancelTimer: (() => void) | undefined;
  private started = false;
  private stopped = false;
  private running: Promise<void> | undefined;
  /** 前の回が終わってから回す refresh（重ねて頼まれても 1 回） */
  private queued: Promise<void> | undefined;
  /** gh のログイン（取れたらプロセスの間は使い続ける） */
  private me: string | undefined;
  private loginFailureLogged = false;
  private rateRemaining: number | undefined;
  private rateResetAt: Date | undefined;
  private loggedCounts: string | undefined;
  private loggedErrors = "";

  constructor(deps: BoardCollectorDeps) {
    this.deps = deps;
    this.timers = deps.timers ?? REAL_TIMERS;
  }

  /** 30 秒後に 1 回、以後は 15 分ごと。stop の後・2 回目は何もしない */
  start(): void {
    if (this.stopped || this.started) return;
    this.started = true;
    this.schedule(BOARD_FIRST_DELAY_MS);
  }

  stop(): void {
    this.stopped = true;
    this.cancelTimer?.();
    this.cancelTimer = undefined;
  }

  /** 実行中の回（と、その後の refresh）が終わったら resolve する */
  async idle(): Promise<void> {
    await this.running;
    await this.queued;
  }

  /** すぐに 1 回。回っていれば、それが終わってからもう 1 回（重ねて頼まれてもまとめる） */
  refresh(): Promise<void> {
    if (this.stopped) return Promise.resolve();
    if (this.running === undefined) return this.tick();
    this.queued ??= this.running.then(() => {
      this.queued = undefined;
      return this.tick();
    });
    return this.queued;
  }

  /** 1 回分。回っていれば重ねずにそれを返す。reject しない */
  tick(): Promise<void> {
    if (this.running !== undefined) return this.running;
    const running = this.runTick()
      .catch((error: unknown) => {
        this.deps.log(`board: 収集に失敗しました（${error instanceof Error ? error.name : "unknown"}）`);
      })
      .finally(() => {
        this.running = undefined;
      });
    this.running = running;
    return running;
  }

  /** 登録のときの remote（`owner/repo`）。無い・読めなければ null */
  async repoOf(dir: string): Promise<string | null> {
    const path = projectDir(dir, this.deps.places);
    if (path === undefined) return null;
    const remote = await this.deps.git.remote(path);
    return remote.kind === "ok" ? remote.repo : null;
  }

  private schedule(ms: number): void {
    if (this.stopped) return;
    this.cancelTimer = this.timers.after(() => {
      this.cancelTimer = undefined;
      void this.tick().then(() => this.schedule(BOARD_POLL_MS));
    }, ms);
  }

  private observe(headers: GhHeaders): void {
    const { remaining, resetAt } = rateLimitFromHeaders(headers);
    if (remaining !== undefined) this.rateRemaining = remaining;
    if (resetAt !== undefined) this.rateResetAt = resetAt;
  }

  private rateLow(): boolean {
    return this.rateRemaining !== undefined && this.rateRemaining < BOARD_LOW_RATE_REMAINING;
  }

  private async runTick(): Promise<void> {
    if (this.stopped) return;
    const now = this.deps.now();
    // リセットの時刻を過ぎた（か分からない）残りは、次の応答で読み直す
    if (this.rateResetAt === undefined || this.rateResetAt.getTime() <= now.getTime()) {
      this.rateRemaining = undefined;
      this.rateResetAt = undefined;
    }
    if (this.me === undefined && !this.rateLow()) {
      // /user の応答のレート制限も読む
      const observed: GhGet = {
        get: async (request) => {
          const response = await this.deps.gh.get(request);
          if ("headers" in response) this.observe(response.headers);
          return response;
        },
      };
      const login = await fetchLogin(observed, now, BOARD_POLL_MS);
      if ("login" in login) this.me = login.login;
      else if (!this.loginFailureLogged) {
        this.loginFailureLogged = true;
        this.deps.log(`board: gh のログインを読めませんでした（${login.failure.kind}）`);
      }
    }
    const counts: Record<BoardState, number> = { working: 0, owner: 0, agent: 0, done: 0, unknown: 0 };
    const errors = new Map<BoardError, number>();
    const rows = this.deps.store.listActive();
    for (const row of rows) {
      if (this.stopped) return;
      const { state, error } = await this.collectOne(row);
      counts[state]++;
      if (error !== null) errors.set(error, (errors.get(error) ?? 0) + 1);
    }
    const key = BOARD_STATES.map((state) => counts[state]).join(":") + `:${rows.length}`;
    if (key !== this.loggedCounts) {
      this.loggedCounts = key;
      this.deps.log(
        `board: ${rows.length} 件を確かめました（owner ${counts.owner}・agent ${counts.agent}・working ${counts.working}・done ${counts.done}・unknown ${counts.unknown}）`,
      );
    }
    const errorText = [...errors.entries()].map(([kind, n]) => `${kind} ${n}`).join("・");
    if (errorText !== this.loggedErrors) {
      this.loggedErrors = errorText;
      if (errorText !== "") this.deps.log(`board: 確かめられなかったもの（${errorText}）`);
    }
  }

  /** 1 つのプロジェクトを確かめて書く。失敗の種類は最初に起きたもの（remote → git → GitHub の順） */
  private async collectOne(row: BoardProjectRow): Promise<{ state: BoardState; error: BoardError | null }> {
    const { git, gh, store, places } = this.deps;
    const path = projectDir(row.dir, places);
    let repo = row.repo;
    let error: BoardError | null = null;
    // undefined は前回のまま
    let items: BoardItem[] | null | undefined;
    let local: BoardLocal | undefined;
    let remoteOk = false;
    if (path === undefined) {
      error = "git_failed";
    } else {
      const remote = await git.remote(path);
      if (remote.kind === "failed") error = "git_failed";
      else if (remote.kind === "none") {
        repo = null;
        items = null;
        error = "no_remote";
      } else {
        // remote が変わったら前の items は別のリポジトリのもの
        if (remote.repo !== row.repo) items = null;
        repo = remote.repo;
        remoteOk = true;
      }
      if (error !== "git_failed") {
        local = await git.local(path);
        if (local === undefined) error ??= "git_failed";
      }
    }
    if (remoteOk && repo !== null) {
      if (this.me === undefined) error ??= "github_failed";
      else if (this.rateLow()) error ??= "rate_limited";
      else {
        const fetched = await fetchBoardItems(gh, repo, this.me, (headers) => this.observe(headers));
        if (fetched.kind === "ok") items = fetched.items;
        else error ??= fetched.kind === "failed" ? "github_failed" : fetched.kind;
      }
    }
    const checkedAt = this.deps.now().toISOString();
    const merged = {
      checkedAt,
      error,
      local: local ?? row.local,
      items: items === undefined ? row.items : items,
    };
    const { state, reasons } = classifyRow(merged, this.deps.live(row.dir, path));
    store.saveResult(row.dir, {
      repo,
      state,
      reasons,
      ...(items === undefined ? {} : { items }),
      ...(local === undefined ? {} : { local }),
      error,
      checkedAt,
    });
    return { state, error };
  }
}
