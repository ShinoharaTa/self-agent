// この機械の Claude Code のセッションの一覧（docs/plan/claude-code-sessions.md §2.2）。claude agents --json を周期で読み（誰かが見ている間は
// SELF_AGENT_CC_POLL_SEC、それ以外は 60 秒。hook の事象が来たら 2 秒にまとめて 1 回）、cc_sessions に書き、hook の事象（hook-server.ts）を反映する。
// 読めなければ前回の一覧を stale で出し、CC_STALE_LIMIT 回続けば空にする。一覧に無い session_id の事象は CC_PENDING_MS だけ保留し、
// その間の一覧に現れれば採り、現れなければ捨てる（PermissionRequest は保留しない）。状態と並びは純関数の rankSessions。
// log は件数と失敗の種類だけ（名前・cwd・パス・本文・sessionId は出さない）
import type { Config } from "../config.ts";
import type { CcEventUpdate, CcSessionStore, CcStartedBy } from "../store/cc-sessions.ts";
import type { AgentEntry, AgentsClient } from "./agents.ts";
import type { ClaudeDirs } from "./claude-dirs.ts";
import { CC_WAITING_NOTIFICATIONS, type CcHookEvent, type CcHookReceiver, type CcPermissionSummary } from "./hook-server.ts";

/** 誰も見ていないときの周期 */
export const CC_IDLE_POLL_MS = 60_000;
/** 最後の touch() からこの間は「見ている」 */
export const CC_WATCH_MS = 30_000;
/** hook の事象が来てから読むまで（この間に来た事象はまとめて 1 回） */
export const CC_EVENT_REFRESH_MS = 2_000;
/** 一覧に無い session_id の事象を保留する長さ */
export const CC_PENDING_MS = 30_000;
/** 保留できる事象の数（超えた分は捨てる） */
export const CC_PENDING_MAX = 100;
/** 続けて読めなかったらこの回数で一覧を空にする */
export const CC_STALE_LIMIT = 5;

/** needs_input = 判断待ち、running = 実行中、idle = 待機 */
export type CcState = "needs_input" | "running" | "idle";

/** 状態と並びを決める材料（時刻はエポックからのミリ秒） */
export type RankInput = {
  sessionId: string;
  /** claude agents --json の status（busy / waiting / idle） */
  status: string | undefined;
  /** 保留中の PermissionRequest がある（CC5a から。今はいつも false） */
  pendingPermission: boolean;
  /** hook で判断待ちにした Notification の種類。その後の UserPromptSubmit・Stop で null */
  waitingKind: string | null;
  /** 判断待ちが始まった時刻 */
  waitingSince: number | undefined;
  /** 最後の UserPromptSubmit を受けた時刻 */
  lastPromptAt: number | undefined;
  /** 記録（jsonl）の mtime */
  transcriptMtime: number | undefined;
  startedAt: number | undefined;
};

/** 状態の決め方（§2.2。上から順） */
export function sessionState(input: RankInput): CcState {
  if (input.pendingPermission || input.status === "waiting" || (input.waitingKind !== null && input.status !== "busy")) {
    return "needs_input";
  }
  if (input.status === "busy") return "running";
  return "idle";
}

/** 最後の活動（最後の指示 → 記録の mtime → 起動の時刻） */
export function lastActivity(input: Pick<RankInput, "lastPromptAt" | "transcriptMtime" | "startedAt">): number | undefined {
  return input.lastPromptAt ?? input.transcriptMtime ?? input.startedAt;
}

const STATE_ORDER: Readonly<Record<CcState, number>> = { needs_input: 0, running: 1, idle: 2 };

/** 小さい順（undefined は後ろ） */
function ascending(a: number | undefined, b: number | undefined): number {
  if (a === undefined || b === undefined) return a === b ? 0 : a === undefined ? 1 : -1;
  return a - b;
}

/**
 * 状態を付けて並べる（純関数。§2.2）: 判断待ち（待ち始めの古い順）→ 実行中 → 待機（どちらも最後の指示の新しい順。
 * 無ければ記録の mtime → 起動の時刻）。同じなら sessionId の順
 */
export function rankSessions<T extends RankInput>(items: readonly T[]): Array<T & { state: CcState }> {
  return items
    .map((item) => ({ ...item, state: sessionState(item) }))
    .sort((a, b) => {
      const group = STATE_ORDER[a.state] - STATE_ORDER[b.state];
      if (group !== 0) return group;
      const order =
        a.state === "needs_input" ? ascending(a.waitingSince, b.waitingSince) : ascending(negate(lastActivity(a)), negate(lastActivity(b)));
      if (order !== 0) return order;
      return a.sessionId < b.sessionId ? -1 : a.sessionId > b.sessionId ? 1 : 0;
    });
}

function negate(value: number | undefined): number | undefined {
  return value === undefined ? undefined : -value;
}

/** 一覧の 1 行（Web・ツールに出すもの。DB・Web・Discord にだけ出し、log には出さない） */
export type CcSessionView = RankInput & {
  state: CcState;
  pid: number;
  name: string | undefined;
  cwd: string | undefined;
  kind: string | undefined;
  waitingFor: string | undefined;
  lastPromptText: string | null;
  permissionMode: string | null;
  /** 最後の活動（lastActivity） */
  lastActivityAt: number | undefined;
  /** RC のリンクの id（sessions/<pid>.json。読めなければ undefined） */
  bridgeSessionId: string | undefined;
  tmux: string | undefined;
  /** 起動したもの（cc_sessions.started_by。self-agent が起動したものは CC4 から） */
  startedBy: CcStartedBy;
  /** trust のダイアログの確認待ち（cc_sessions.trust_pending_at がある） */
  trustPending: boolean;
  /** 直近の PermissionRequest の要約（CC1 では保留せず記録するだけ。その後の UserPromptSubmit・Stop で消す。プロセスの中だけ） */
  permission: (CcPermissionSummary & { at: number }) | undefined;
};

export type CcSnapshot = {
  sessions: CcSessionView[];
  /** 直近の読み取りに失敗した（CC_STALE_LIMIT 回までは前回の一覧を出している） */
  stale: boolean;
  /** CC_STALE_LIMIT 回続けて読めず、一覧を空にした */
  unreadable: boolean;
  /** 最後に読めた時刻。まだなら undefined */
  fetchedAt: number | undefined;
};

/** テストでは偽のタイマーに差し替える */
export type CcTimers = {
  /** ms 後に fn を 1 回呼び、取り消す関数を返す */
  after(fn: () => void, ms: number): () => void;
};

const REAL_TIMERS: CcTimers = {
  after: (fn, ms) => {
    const timer = setTimeout(fn, ms);
    return () => clearTimeout(timer);
  },
};

export type CcRegistryDeps = {
  cfg: Pick<Config, "ccPollSec">;
  agents: Pick<AgentsClient, "list">;
  dirs: Pick<ClaudeDirs, "sessionFile" | "transcriptMtime">;
  store: Pick<CcSessionStore, "upsertSeen" | "markGone" | "applyEvent" | "listAlive">;
  now: () => Date;
  timers?: CcTimers;
  /** 送信の待ち行列が空でない（§2.2。CC3 から）・起動したセッションをまだ一覧で見つけていない（CC4）。true の間は見ていなくても設定の周期で読む */
  busy?: () => boolean;
  log: (message: string) => void;
};

/** sessions/<pid>.json と記録から読んだ補助 */
type Extra = { bridgeSessionId: string | undefined; tmux: string | undefined; transcriptMtime: number | undefined };

function errorKind(error: unknown): string {
  return error instanceof Error ? error.name : typeof error;
}

function parseTime(iso: string | null): number | undefined {
  if (iso === null) return undefined;
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? ms : undefined;
}

export class CcRegistry implements CcHookReceiver {
  private readonly deps: CcRegistryDeps;
  private readonly timers: CcTimers;
  private cancelTimer: (() => void) | undefined;
  private started = false;
  private stopped = false;
  /** 事象のための早い読み取りを予約しているか */
  private soon = false;
  private running: Promise<void> | undefined;
  /** 読んでいる間に読み直しを頼まれた */
  private rerun = false;
  /** 最後に読めた一覧（読めなければ前回のまま。CC_STALE_LIMIT 回続けば空） */
  private agents: AgentEntry[] = [];
  private extras = new Map<string, Extra>();
  private failures = 0;
  private fetchedAt: number | undefined;
  /** status が waiting なのを最初に見た時刻（hook が無くても待ち始めで並べる） */
  private observedWaiting = new Map<string, number>();
  private permissions = new Map<string, CcPermissionSummary & { at: number }>();
  /** 一覧に無い session_id の事象（受けた順） */
  private pending: CcHookEvent[] = [];
  private lastTouch: number | undefined;
  /** 最後に読み取りを始めた時刻（読めた・読めなかったを問わない） */
  private lastAttemptAt: number | undefined;
  /** 直近に log に出した一覧の件数（件数か判断待ちが変わったときだけ出す） */
  private loggedCounts: string | undefined;
  private loggedFailure: string | undefined;
  /** sessions/<pid>.json を読めなかった数（変わったときだけ log） */
  private loggedMissingFiles = 0;

  constructor(deps: CcRegistryDeps) {
    this.deps = deps;
    this.timers = deps.timers ?? REAL_TIMERS;
  }

  /** 直後に 1 回読み、以後は周期で読む。stop の後・2 回目は何もしない */
  start(): void {
    if (this.started || this.stopped) return;
    this.started = true;
    this.loop();
  }

  /** 以後の読み取りを止め、保留中の事象を捨てる。実行中の読み取りは idle で待つ */
  stop(): void {
    this.stopped = true;
    this.cancelTimer?.();
    this.cancelTimer = undefined;
    this.pending = [];
  }

  async idle(): Promise<void> {
    await this.running;
  }

  /**
   * 誰かが一覧を見ている印（Web の /api/cc/* の GET が呼ぶ）。CC_WATCH_MS の間は周期を短くする。見ていなかった状態から見た状態に変わったとき、
   * 最後に読み始めてから SELF_AGENT_CC_POLL_SEC 経っていれば、待っている（最長 60 秒の）予約を取り消してすぐ 1 回読む。
   * 読んでいる途中・事象の早い読み取りを予約している・start の前・stop の後は予約を変えない
   */
  touch(): void {
    const now = this.deps.now().getTime();
    const watched = this.lastTouch !== undefined && now - this.lastTouch < CC_WATCH_MS;
    this.lastTouch = now;
    if (watched || !this.started || this.stopped || this.running !== undefined || this.soon) return;
    if (this.lastAttemptAt !== undefined && now - this.lastAttemptAt < this.deps.cfg.ccPollSec * 1000) return;
    this.schedule(0);
  }

  /** hook の事象を受ける（hook-server.ts）。一覧にあれば反映し、無ければ保留する。どちらでも早めに 1 回読む */
  receive(event: CcHookEvent): void {
    if (this.stopped) return;
    if (this.agents.some((agent) => agent.sessionId === event.sessionId)) {
      this.apply(event);
    } else if (event.event !== "PermissionRequest" && this.pending.length < CC_PENDING_MAX) {
      this.pending.push(event);
    }
    this.scheduleSoon();
  }

  /** 今の一覧（状態を付けて並べたもの） */
  snapshot(): CcSnapshot {
    const rows = new Map(this.deps.store.listAlive().map((row) => [row.sessionId, row]));
    const views: Array<Omit<CcSessionView, "state">> = this.agents.map((agent) => {
      const row = rows.get(agent.sessionId);
      const extra = this.extras.get(agent.sessionId);
      const waitingKind = row?.waitingKind ?? null;
      const hookWaiting = waitingKind === null ? undefined : parseTime(row?.waitingSince ?? null);
      const observed = this.observedWaiting.get(agent.sessionId);
      const waitingSince =
        hookWaiting === undefined ? observed : observed === undefined ? hookWaiting : Math.min(hookWaiting, observed);
      const view = {
        sessionId: agent.sessionId,
        status: agent.status,
        pendingPermission: false,
        waitingKind,
        waitingSince,
        lastPromptAt: parseTime(row?.lastPromptAt ?? null),
        transcriptMtime: extra?.transcriptMtime,
        startedAt: agent.startedAt,
        pid: agent.pid,
        name: agent.name,
        cwd: agent.cwd,
        kind: agent.kind,
        waitingFor: agent.waitingFor,
        lastPromptText: row?.lastPromptText ?? null,
        permissionMode: row?.permissionMode ?? null,
        lastActivityAt: undefined as number | undefined,
        bridgeSessionId: extra?.bridgeSessionId,
        tmux: extra?.tmux,
        permission: this.permissions.get(agent.sessionId),
        startedBy: row?.startedBy ?? "owner",
        trustPending: row?.trustPendingAt !== null && row?.trustPendingAt !== undefined,
      };
      view.lastActivityAt = lastActivity(view);
      return view;
    });
    return {
      sessions: rankSessions(views),
      stale: this.failures > 0,
      unreadable: this.failures >= CC_STALE_LIMIT,
      fetchedAt: this.fetchedAt,
    };
  }

  /** 保留中の事象の数（テスト・状態の表示用） */
  pendingCount(): number {
    return this.pending.length;
  }

  /** 1 回読む。読んでいる途中なら、終わった後にもう 1 回読む。reject しない */
  tick(): Promise<void> {
    if (this.running !== undefined) {
      this.rerun = true;
      return this.running;
    }
    const running = (async () => {
      do {
        this.rerun = false;
        await this.refresh();
      } while (this.rerun && !this.stopped);
    })().finally(() => {
      this.running = undefined;
    });
    this.running = running;
    return running;
  }

  private loop(): void {
    if (this.stopped) return;
    this.soon = false;
    void this.tick().then(() => {
      // 読んでいる間に事象が来て早い読み取りを予約していれば、それに任せる
      if (!this.stopped && !this.soon) this.schedule(this.nextDelay());
    });
  }

  private schedule(ms: number): void {
    if (this.stopped) return;
    this.cancelTimer?.();
    this.cancelTimer = this.timers.after(() => {
      this.cancelTimer = undefined;
      this.loop();
    }, ms);
  }

  private scheduleSoon(): void {
    if (!this.started || this.stopped || this.soon) return;
    this.soon = true;
    this.schedule(CC_EVENT_REFRESH_MS);
  }

  /** 見ている・保留中の事象がある・送信の待ち行列が空でないなら設定の周期、それ以外は 60 秒（設定の方が長ければ設定） */
  private nextDelay(): number {
    const pollMs = this.deps.cfg.ccPollSec * 1000;
    const now = this.deps.now().getTime();
    const watched = this.lastTouch !== undefined && now - this.lastTouch < CC_WATCH_MS;
    return watched || this.pending.length > 0 || this.deps.busy?.() === true ? pollMs : Math.max(pollMs, CC_IDLE_POLL_MS);
  }

  private apply(event: CcHookEvent): void {
    const update: CcEventUpdate = { event: event.event };
    if (event.permissionMode !== undefined) update.permissionMode = event.permissionMode;
    if (event.prompt !== undefined) update.promptText = event.prompt;
    if (event.notificationType !== undefined && CC_WAITING_NOTIFICATIONS.includes(event.notificationType)) {
      update.waitingKind = event.notificationType;
    }
    this.deps.store.applyEvent(event.sessionId, update, event.receivedAt);
    if (event.event === "PermissionRequest" && event.permission !== undefined) {
      this.permissions.set(event.sessionId, { ...event.permission, at: event.receivedAt.getTime() });
    } else if (event.event === "UserPromptSubmit" || event.event === "Stop") {
      this.permissions.delete(event.sessionId);
    }
  }

  private async refresh(): Promise<void> {
    if (this.stopped) return;
    const { log } = this.deps;
    this.lastAttemptAt = this.deps.now().getTime();
    try {
      const result = await this.deps.agents.list();
      if (this.stopped) return;
      const now = this.deps.now().getTime();
      if (!result.ok) {
        this.failures++;
        if (this.loggedFailure !== result.reason) {
          this.loggedFailure = result.reason;
          log(`Claude Code: 一覧を読めませんでした（${result.reason}）`);
        }
        if (this.failures === CC_STALE_LIMIT) {
          this.agents = [];
          this.extras.clear();
          this.observedWaiting.clear();
          this.permissions.clear();
          log(`Claude Code: 一覧を ${CC_STALE_LIMIT} 回続けて読めないため空にしました`);
        }
        this.loggedCounts = undefined;
        this.dropExpired(now, new Set());
        return;
      }
      this.failures = 0;
      this.loggedFailure = undefined;
      this.fetchedAt = now;
      const ids = new Set(result.agents.map((agent) => agent.sessionId));
      this.deps.store.upsertSeen(
        result.agents.map((agent) => ({
          sessionId: agent.sessionId,
          cwd: agent.cwd ?? null,
          name: agent.name ?? null,
          pid: agent.pid,
          waitingFor: agent.waitingFor ?? null,
        })),
      );
      this.deps.store.markGone([...ids]);
      // 行を書いてから一覧を入れ替える（receive が一覧にあるとみなした session_id の行は必ずある）
      this.agents = result.agents;

      const extras = new Map<string, Extra>();
      let missingFiles = 0;
      for (const agent of result.agents) {
        const file = this.deps.dirs.sessionFile(agent.pid, agent.sessionId);
        if (file === undefined) missingFiles++;
        extras.set(agent.sessionId, {
          bridgeSessionId: file?.bridgeSessionId,
          tmux: file?.tmux,
          transcriptMtime: agent.cwd === undefined ? undefined : this.deps.dirs.transcriptMtime(agent.cwd, agent.sessionId),
        });
        if (agent.status === "waiting") {
          if (!this.observedWaiting.has(agent.sessionId)) this.observedWaiting.set(agent.sessionId, now);
        } else {
          this.observedWaiting.delete(agent.sessionId);
        }
      }
      this.extras = extras;
      for (const id of [...this.observedWaiting.keys()]) if (!ids.has(id)) this.observedWaiting.delete(id);
      for (const id of [...this.permissions.keys()]) if (!ids.has(id)) this.permissions.delete(id);
      if (missingFiles !== this.loggedMissingFiles) {
        this.loggedMissingFiles = missingFiles;
        log(`Claude Code: セッションの補助の記録を読めないもの ${missingFiles} 件`);
      }

      this.dropExpired(now, ids);
      this.logCounts();
    } catch (error) {
      log(`Claude Code: 一覧の更新に失敗しました（${errorKind(error)}）`);
    }
  }

  /** 保留中の事象のうち、一覧に現れたものを反映し、CC_PENDING_MS を過ぎたものを捨てる */
  private dropExpired(now: number, ids: ReadonlySet<string>): void {
    const kept: CcHookEvent[] = [];
    for (const event of this.pending) {
      if (ids.has(event.sessionId) && now - event.receivedAt.getTime() <= CC_PENDING_MS) this.apply(event);
      else if (now - event.receivedAt.getTime() < CC_PENDING_MS) kept.push(event);
    }
    this.pending = kept;
  }

  private logCounts(): void {
    const ranked = this.snapshot().sessions;
    const needsInput = ranked.filter((session) => session.state === "needs_input").length;
    const running = ranked.filter((session) => session.state === "running").length;
    const key = `${ranked.length}:${needsInput}`;
    if (key === this.loggedCounts) return;
    this.loggedCounts = key;
    this.deps.log(`Claude Code: 一覧 ${ranked.length} 件（判断待ち ${needsInput}・実行中 ${running}）`);
  }
}
