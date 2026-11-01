// Claude Code の許可の要求（PermissionRequest）の保留（docs/plan/claude-code-sessions.md §3.4。CC5a）。hook-server.ts が受けた要求を
// cc_permissions に pending で記録し、応答を最長 SELF_AGENT_CC_PERMISSION_HOLD_SEC 保留する。その間に Web で [許可]・[拒否] が押されれば
// 決定の JSON を返す。保留の間も端末・RC には普段のダイアログが出ていて、そこで先に答えられると Claude Code は先へ進み、hook の接続は開いたまま残る。
// それを次のどれかで「他で答えられた」（answered_elsewhere）と判断し、空の本文を返して閉じる: 同じセッションの次の PermissionRequest・
// そのセッションの Stop・UserPromptSubmit（via hook）、受信から 3 秒以上後に読み始めた claude agents --json の status が waiting でない（via status）。
// 保留が切れたら空の本文で expired、Claude Code が先に接続を閉じたら書かずに expired、停止では全部に空の本文で released（shutdown）、
// 同じセッションから 1 分に 20 件を超えたら保留せず released（limit）。一覧に無いセッションの要求は記録も保留もしない。
// allow を返すのはオーナーが押したときだけ（自動で allow する経路は無い）。
// log は「Claude Code: 許可の要求（#id）→ <状態>（<経路>）」と件数だけ（ツール名・要約・セッションの ID は出さない）
import type { CcPermissionRow, CcPermissionState, CcPermissionStore, CcPermissionVia } from "../store/cc-permissions.ts";
import type { CcHookEvent } from "./hook-server.ts";
import type { CcTimers } from "./registry.ts";

/** 同じセッションの要求を数える窓 */
export const CC_PERMISSION_RATE_WINDOW_MS = 60_000;
/** 窓の中で保留する上限（これを超えた分は保留せず released） */
export const CC_PERMISSION_RATE_LIMIT = 20;
/** status で「他で答えられた」と判断するのは、受信からこの時間以上後に読み始めた一覧だけ（ダイアログは 0.7 秒以内に出て waiting になる） */
export const CC_PERMISSION_STATUS_GRACE_MS = 3_000;
/** 解決してからこの間は、そのセッションの permission_prompt の Notification を判断待ちの元にしない（§2.2。保留中でも 6 秒で来るため） */
export const CC_PERMISSION_SUPPRESS_MS = 60_000;
/** [拒否] の message（端末に `Error: <message>` と出て、モデルにも渡る） */
export const CC_PERMISSION_DENY_MESSAGE = "self-agent（Discord / Web）から拒否しました";

/** 押された決定（CC5a は許可・拒否だけ） */
export type CcPermissionDecision = "allow" | "deny";

/** 決定の応答の本文（§3.4）。allow は behavior だけで、updatedPermissions・updatedInput は付けない。deny は message だけで interrupt は付けない */
export function decisionBody(decision: CcPermissionDecision): string {
  const body =
    decision === "allow" ? { behavior: "allow" } : { behavior: "deny", message: CC_PERMISSION_DENY_MESSAGE };
  return JSON.stringify({ hookSpecificOutput: { hookEventName: "PermissionRequest", decision: body } });
}

export type CcPermissionHoldDeps = {
  cfg: { ccPermissionHoldSec: number };
  store: Pick<
    CcPermissionStore,
    "add" | "get" | "pendingFor" | "resolve" | "countSince" | "sessionsActiveSince" | "expirePending"
  >;
  /** claude agents --json の一覧にあるセッションか（registry.ts の knows） */
  known: (sessionId: string) => boolean;
  now: () => Date;
  timers?: CcTimers;
  log: (message: string) => void;
};

/** 押した結果。not_found = その id の行が無い、stale = 保留していない（終わった・時間切れ・他で答えられた）か request_hash が合わない */
export type CcAnswerResult = { ok: true; state: CcPermissionState } | { ok: false; reason: "not_found" | "stale" };

/** 保留している 1 件（プロセスの中だけ） */
type Held = {
  sessionId: string;
  receivedAt: number;
  /** 応答の本文で接続を閉じる（undefined は空の本文）。2 回目以降は何もしない */
  settle: (body: string | undefined) => void;
  cancelTimer: () => void;
};

const REAL_TIMERS: CcTimers = {
  after: (fn, ms) => {
    const timer = setTimeout(fn, ms);
    return () => clearTimeout(timer);
  },
};

export class CcPermissionHold {
  private readonly deps: CcPermissionHoldDeps;
  private readonly timers: CcTimers;
  private readonly held = new Map<number, Held>();
  private stopped = false;

  constructor(deps: CcPermissionHoldDeps) {
    this.deps = deps;
    this.timers = deps.timers ?? REAL_TIMERS;
  }

  /** 起動時（受け口を始める前）: 前のプロセスで pending のまま残った行を expired にする */
  recover(): void {
    const count = this.deps.store.expirePending();
    if (count > 0) this.deps.log(`Claude Code: 再起動の前に保留していた許可の要求 ${count} 件を時間切れにしました`);
  }

  /**
   * PermissionRequest を受ける（hook-server.ts）。保留するなら決定の本文か undefined（空の本文）で resolve し、保留しないならすぐ undefined。
   * closed は Claude Code が先に接続を閉じた印（timeout など。そのときは expired にして本文は使わない）。reject しない
   */
  request(event: CcHookEvent, closed: AbortSignal): Promise<string | undefined> {
    const permission = event.permission;
    if (event.event !== "PermissionRequest" || permission === undefined) return Promise.resolve(undefined);
    const { store, log } = this.deps;
    const sessionId = event.sessionId;
    // 一覧に無いセッション（偽の hook の対策。§2.2）は記録も保留もしない
    if (!this.deps.known(sessionId)) {
      log("Claude Code: 一覧に無いセッションの許可の要求は保留しませんでした");
      return Promise.resolve(undefined);
    }
    // 1 件ずつ来るので、次が来た = 前は端末か RC で決まった
    const previous = store.pendingFor(sessionId);
    if (previous !== undefined) this.close(previous.id, "answered_elsewhere", "hook");

    const fields = {
      sessionId,
      requestHash: permission.requestHash,
      toolName: permission.toolName,
      summary: permission.summary,
      permissionMode: event.permissionMode ?? null,
    };
    if (this.stopped) {
      const row = store.add({ ...fields, state: "released", via: "shutdown" });
      this.logResult(row.id, "released", "shutdown");
      return Promise.resolve(undefined);
    }
    const now = this.deps.now().getTime();
    if (store.countSince(sessionId, new Date(now - CC_PERMISSION_RATE_WINDOW_MS)) >= CC_PERMISSION_RATE_LIMIT) {
      const row = store.add({ ...fields, state: "released", via: "limit" });
      this.logResult(row.id, "released", "limit");
      return Promise.resolve(undefined);
    }
    const row = store.add({ ...fields, state: "pending" });
    return new Promise<string | undefined>((resolve) => {
      let settled = false;
      const held: Held = {
        sessionId,
        receivedAt: now,
        settle: (body) => {
          if (settled) return;
          settled = true;
          held.cancelTimer();
          closed.removeEventListener("abort", onClosed);
          resolve(body);
        },
        cancelTimer: () => undefined,
      };
      const onClosed = (): void => {
        // Claude Code が先に閉じた: 応答は書かない
        this.close(row.id, "expired", null);
      };
      this.held.set(row.id, held);
      held.cancelTimer = this.timers.after(() => this.close(row.id, "expired", null), this.deps.cfg.ccPermissionHoldSec * 1000);
      if (closed.aborted) onClosed();
      else closed.addEventListener("abort", onClosed, { once: true });
    });
  }

  /** hook の事象（PermissionRequest 以外）を見る。そのセッションの Stop・UserPromptSubmit が来たら、保留中の要求は他で答えられた */
  observe(event: CcHookEvent): void {
    if (event.event !== "Stop" && event.event !== "UserPromptSubmit") return;
    for (const [id, held] of [...this.held]) {
      if (held.sessionId === event.sessionId) this.close(id, "answered_elsewhere", "hook");
    }
  }

  /**
   * claude agents --json を読めたとき（registry.ts）。readStartedAt は読み始めた時刻。受信から CC_PERMISSION_STATUS_GRACE_MS 以上後に
   * 読み始めた一覧で status が waiting でない（一覧から消えたものを含む）セッションの保留は、他で答えられた
   */
  onListed(statuses: ReadonlyMap<string, string | undefined>, readStartedAt: Date): void {
    const at = readStartedAt.getTime();
    for (const [id, held] of [...this.held]) {
      if (at - held.receivedAt < CC_PERMISSION_STATUS_GRACE_MS) continue;
      if (statuses.get(held.sessionId) !== "waiting") this.close(id, "answered_elsewhere", "status");
    }
  }

  /** Web（と後の段の Discord）の [許可]・[拒否]。先に押した方が勝つ（pending からの compare-and-set）。requestHash を渡せば行と合うときだけ */
  answer(id: number, decision: CcPermissionDecision, via: "web" | "discord", requestHash?: string): CcAnswerResult {
    const row = this.deps.store.get(id);
    if (row === undefined) return { ok: false, reason: "not_found" };
    if (row.state !== "pending" || !this.held.has(id)) return { ok: false, reason: "stale" };
    if (requestHash !== undefined && requestHash !== row.requestHash) return { ok: false, reason: "stale" };
    const to = decision === "allow" ? "allowed" : "denied";
    if (!this.close(id, to, via, decisionBody(decision))) return { ok: false, reason: "stale" };
    return { ok: true, state: to };
  }

  /** 保留している要求があるか（registry.ts は保留中は一覧を 5 秒ごとに読む） */
  holding(): boolean {
    return this.held.size > 0;
  }

  /** 保留している要求のあるセッション */
  pendingSessions(): Set<string> {
    return new Set([...this.held.values()].map((held) => held.sessionId));
  }

  /** permission_prompt の Notification を判断待ちの元にしないセッション（pending か、直近 CC_PERMISSION_SUPPRESS_MS に解決した行がある） */
  suppressedSessions(): Set<string> {
    return this.deps.store.sessionsActiveSince(new Date(this.deps.now().getTime() - CC_PERMISSION_SUPPRESS_MS));
  }

  /** 停止: 保留中の全部に空の本文を返して released（shutdown）にし、以後の要求は保留しない */
  stop(): void {
    this.stopped = true;
    for (const id of [...this.held.keys()]) this.close(id, "released", "shutdown");
  }

  /** pending から to に移せたら、保留している接続を body（undefined は空の本文）で閉じて log に出す。移せたら true */
  private close(id: number, to: Exclude<CcPermissionState, "pending">, via: CcPermissionVia | null, body?: string): boolean {
    const moved = this.deps.store.resolve(id, to, via);
    const held = this.held.get(id);
    this.held.delete(id);
    held?.settle(moved ? body : undefined);
    if (moved) this.logResult(id, to, via);
    return moved;
  }

  private logResult(id: number, state: CcPermissionState, via: CcPermissionVia | null): void {
    this.deps.log(`Claude Code: 許可の要求（#${id}）→ ${state}${via === null ? "" : `（${via}）`}`);
  }
}

/** Web に出す 1 件（cc_permissions の行 + 保留の期限） */
export function permissionExpiresAt(row: Pick<CcPermissionRow, "createdAt">, holdSec: number): string {
  return new Date(Date.parse(row.createdAt) + holdSec * 1000).toISOString();
}
