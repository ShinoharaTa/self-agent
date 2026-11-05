// Claude Code の許可の要求（PermissionRequest）の保留（docs/plan/claude-code-sessions.md §3.4。CC5a）。hook-server.ts が受けた要求を
// cc_permissions に pending で記録し、応答を最長 SELF_AGENT_CC_PERMISSION_HOLD_SEC 保留する。その間に Web で [許可]・[このセッションでは常に許可]・[拒否] が
// 押されれば決定の JSON を返す（常に許可（CC5b）のルールは permissions.ts の線引きを通って行に残したものだけで、destination は session）。
// 保留の間も端末・RC には普段のダイアログが出ていて、そこで先に答えられると Claude Code は先へ進み、hook の接続は開いたまま残る。
// それを次のどれかで「他で答えられた」（answered_elsewhere）と判断し、空の本文を返して閉じる: 同じセッションの次の PermissionRequest・
// そのセッションの Stop・UserPromptSubmit（via hook）、受信から 3 秒以上後に読み始めた claude agents --json の status が waiting でない（via status。
// 形が読めない status では閉じない）。一覧から消えたセッションの保留は expired にする。
// 保留が切れたら空の本文で expired、Claude Code が先に接続を閉じたら書かずに expired、停止では全部に空の本文で released（shutdown）、
// 同じセッションから 1 分に 20 件を超えたら保留せず released（limit）。一覧に無いセッションの要求は記録も保留もしない。
// allow を返すのはオーナーが押したときだけ（自動で allow する経路は無い）。
// 保留を始めた・終わった行は listen で渡した相手（cc/channel-posts.ts。Claude Code のチャンネルに出す）に知らせる。
// 質問（AskUserQuestion。question_input のある行。docs/plan/claude-code-questions.md §2。Q1）も同じ行・同じ保留で扱い、保留の長さだけ
// SELF_AGENT_CC_QUESTION_HOLD_SEC にする。答えは answerQuestion（allow + updatedInput に answers）、[やめる] は deny（message は「断りました」）。
// 質問の行に [許可]・[常に許可] は効かない（stale）。
// log は「Claude Code: 許可の要求（#id）→ <状態>（<経路>）」「Claude Code: 質問（#id）→ <状態>（<経路>）」と件数だけ
// （ツール名・要約・問の文・答え・セッションの ID は出さない）
import type { CcPermissionRow, CcPermissionState, CcPermissionStore, CcPermissionVia } from "../store/cc-permissions.ts";
import type { CcHookEvent } from "./hook-server.ts";
import { type CcRule, sessionRulesUpdate } from "./permissions.ts";
import { type CcQuestionPick, parseQuestionInput, validateAnswers } from "./questions.ts";
import type { CcTimers } from "./registry.ts";

/** 同じセッションの要求を数える窓 */
export const CC_PERMISSION_RATE_WINDOW_MS = 60_000;
/** 窓の中で保留する上限（これを超えた分は保留せず released） */
export const CC_PERMISSION_RATE_LIMIT = 20;
/** status で「他で答えられた」と判断するのは、受信からこの時間以上後に読み始めた一覧だけ（ダイアログは 0.7 秒以内に出て waiting になる） */
export const CC_PERMISSION_STATUS_GRACE_MS = 3_000;
/** 解決してからこの間は、そのセッションの permission_prompt の Notification を判断待ちの元にしない（§2.2。保留中でも 6 秒で来るため） */
export const CC_PERMISSION_SUPPRESS_MS = 60_000;
/** 一覧に無いセッションの要求を断った log の間隔（続けて来ても 1 回だけ出す） */
export const CC_PERMISSION_UNKNOWN_LOG_INTERVAL_MS = 60_000;
/** [拒否] の message（端末に `Error: <message>` と出て、モデルにも渡る） */
export const CC_PERMISSION_DENY_MESSAGE = "self-agent（Discord / Web）から拒否しました";
/** 質問の [やめる]（答えない）の message（Claude は止まらず、答えが無いまま次の手を考える） */
export const CC_QUESTION_DENY_MESSAGE = "self-agent（Discord / Web）から断りました";

/** 押された決定（always は「このセッションでは常に許可」。CC5b） */
export type CcPermissionDecision = "allow" | "always" | "deny";

/**
 * 決定の応答の本文（§3.4）。allow は behavior だけで、updatedPermissions・updatedInput は付けない。deny は message だけで interrupt は付けない
 * （質問の行では { question: true } で message を CC_QUESTION_DENY_MESSAGE に）。
 * always は allow に updatedPermissions（addRules・behavior allow・destination session の 1 件。permissions.ts）を足す。
 * question は allow に updatedInput（tool_input そのまま + answers。docs/plan/claude-code-questions.md §2.3）を足す
 */
export function decisionBody(decision: "allow"): string;
export function decisionBody(decision: "deny", options?: { question: boolean }): string;
export function decisionBody(decision: "always", rules: readonly CcRule[]): string;
export function decisionBody(decision: "question", input: Readonly<Record<string, unknown>>, answers: Readonly<Record<string, string>>): string;
export function decisionBody(
  decision: CcPermissionDecision | "question",
  extra?: readonly CcRule[] | { question: boolean } | Readonly<Record<string, unknown>>,
  answers?: Readonly<Record<string, string>>,
): string {
  let body: Record<string, unknown>;
  if (decision === "allow") body = { behavior: "allow" };
  else if (decision === "always") body = { behavior: "allow", updatedPermissions: sessionRulesUpdate((extra ?? []) as readonly CcRule[]) };
  else if (decision === "question") body = { behavior: "allow", updatedInput: { ...(extra as Record<string, unknown>), answers } };
  else {
    const question = (extra as { question?: boolean } | undefined)?.question === true;
    body = { behavior: "deny", message: question ? CC_QUESTION_DENY_MESSAGE : CC_PERMISSION_DENY_MESSAGE };
  }
  return JSON.stringify({ hookSpecificOutput: { hookEventName: "PermissionRequest", decision: body } });
}

export type CcPermissionHoldDeps = {
  /** 許可の要求の保留（SELF_AGENT_CC_PERMISSION_HOLD_SEC）と質問の保留（SELF_AGENT_CC_QUESTION_HOLD_SEC）の秒数 */
  cfg: { ccPermissionHoldSec: number; ccQuestionHoldSec: number };
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

/** 質問に答えた結果。invalid = 答えが行の問に合わない（数・無い label・1 つ選ぶ問に 2 つ・「その他」が空か長すぎる） */
export type CcQuestionAnswerResult = { ok: true; state: "allowed" } | { ok: false; reason: "not_found" | "stale" | "invalid" };

/** 保留を始めた・終わった行の受け手（cc/channel-posts.ts）。投げても保留には響かない（log だけ） */
export type CcPermissionListener = {
  /** pending で記録した直後 */
  held(row: CcPermissionRow): void;
  /** pending から移した直後（移した後の行） */
  resolved(row: CcPermissionRow): void;
};

/** 保留している 1 件（プロセスの中だけ） */
type Held = {
  sessionId: string;
  /** 質問（question_input のある行）か */
  question: boolean;
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
  /** 一覧に無いセッションの要求を最後に log に出した時刻 */
  private unknownLoggedAt: number | undefined;
  private readonly listeners: CcPermissionListener[] = [];

  constructor(deps: CcPermissionHoldDeps) {
    this.deps = deps;
    this.timers = deps.timers ?? REAL_TIMERS;
  }

  /** 保留を始めた・終わった行の受け手を足す（main が作った後に渡す） */
  listen(listener: CcPermissionListener): void {
    this.listeners.push(listener);
  }

  /**
   * 起動時（受け口を始める前）: 前のプロセスで pending のまま残った行を expired にし、その行を返す
   * （main が Discord につないだ後に、出した 1 通を書き換える。channel-posts.ts の rewriteRecovered）
   */
  recover(): CcPermissionRow[] {
    const rows = this.deps.store.expirePending();
    if (rows.length > 0) this.deps.log(`Claude Code: 再起動の前に保留していた許可の要求・質問 ${rows.length} 件を時間切れにしました`);
    return rows;
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
      const at = this.deps.now().getTime();
      if (this.unknownLoggedAt === undefined || at - this.unknownLoggedAt >= CC_PERMISSION_UNKNOWN_LOG_INTERVAL_MS) {
        this.unknownLoggedAt = at;
        log("Claude Code: 一覧に無いセッションの許可の要求は保留しませんでした");
      }
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
      alwaysRules: permission.alwaysRules ?? null,
      questionInput: permission.questionInput ?? null,
    };
    const question = fields.questionInput !== null;
    if (this.stopped) {
      const row = store.add({ ...fields, state: "released", via: "shutdown" });
      this.logResult(row.id, "released", "shutdown", question);
      return Promise.resolve(undefined);
    }
    const now = this.deps.now().getTime();
    if (store.countSince(sessionId, new Date(now - CC_PERMISSION_RATE_WINDOW_MS)) >= CC_PERMISSION_RATE_LIMIT) {
      const row = store.add({ ...fields, state: "released", via: "limit" });
      this.logResult(row.id, "released", "limit", question);
      return Promise.resolve(undefined);
    }
    const row = store.add({ ...fields, state: "pending" });
    return new Promise<string | undefined>((resolve) => {
      let settled = false;
      const held: Held = {
        sessionId,
        question,
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
      for (const listener of this.listeners) this.tell(() => listener.held(row));
      const holdSec = question ? this.deps.cfg.ccQuestionHoldSec : this.deps.cfg.ccPermissionHoldSec;
      held.cancelTimer = this.timers.after(() => this.close(row.id, "expired", null), holdSec * 1000);
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
   * 読み始めた一覧で、status が waiting でない（形が読めない undefined は除く）セッションの保留は他で答えられた。
   * 一覧から消えたセッション（claude が終わった）の保留は expired
   */
  onListed(statuses: ReadonlyMap<string, string | undefined>, readStartedAt: Date): void {
    const at = readStartedAt.getTime();
    for (const [id, held] of [...this.held]) {
      if (at - held.receivedAt < CC_PERMISSION_STATUS_GRACE_MS) continue;
      if (!statuses.has(held.sessionId)) {
        this.close(id, "expired", null);
        continue;
      }
      const status = statuses.get(held.sessionId);
      if (status !== undefined && status !== "waiting") this.close(id, "answered_elsewhere", "status");
    }
  }

  /**
   * Web（と後の段の Discord）の [許可]・[このセッションでは常に許可]・[拒否]。先に押した方が勝つ（pending からの compare-and-set）。
   * requestHash を渡せば行と合うときだけ。常に許可は押した時点の行のルールから作り、行にルールが無ければ stale。
   * 質問の行（question_input あり）は allow・always が stale（答えは answerQuestion）で、deny は message が「断りました」
   */
  answer(id: number, decision: CcPermissionDecision, via: "web" | "discord", requestHash?: string): CcAnswerResult {
    const row = this.deps.store.get(id);
    if (row === undefined) return { ok: false, reason: "not_found" };
    if (row.state !== "pending" || !this.held.has(id)) return { ok: false, reason: "stale" };
    if (requestHash !== undefined && requestHash !== row.requestHash) return { ok: false, reason: "stale" };
    const question = row.questionInput !== null;
    if (question && decision !== "deny") return { ok: false, reason: "stale" };
    let to: "allowed" | "allowed_always" | "denied";
    let body: string;
    if (decision === "deny") {
      to = "denied";
      body = decisionBody("deny", { question });
    } else if (decision === "always") {
      if (row.alwaysRules === null || row.alwaysRules.length === 0) return { ok: false, reason: "stale" };
      to = "allowed_always";
      body = decisionBody("always", row.alwaysRules);
    } else {
      to = "allowed";
      body = decisionBody("allow");
    }
    if (!this.close(id, to, via, body)) return { ok: false, reason: "stale" };
    return { ok: true, state: to };
  }

  /**
   * 質問に答える（Web と後の段の Discord。docs/plan/claude-code-questions.md §2.2）。行が pending で保留していて、requestHash が合い、
   * question_input が読めるときだけ。picks は問の順の答え（questions.ts の validateAnswers で行の問と照らす。合わなければ invalid）。
   * 先に答えた方が勝つ（pending から allowed への compare-and-set。answers の列も同じ UPDATE で書く）。応答は allow + updatedInput
   */
  answerQuestion(id: number, requestHash: string, picks: readonly CcQuestionPick[], via: "web" | "discord"): CcQuestionAnswerResult {
    const row = this.deps.store.get(id);
    if (row === undefined) return { ok: false, reason: "not_found" };
    if (row.state !== "pending" || !this.held.has(id) || requestHash !== row.requestHash) return { ok: false, reason: "stale" };
    const parsed = parseQuestionInput(row.questionInput);
    if (parsed === undefined) return { ok: false, reason: "stale" };
    const answers = validateAnswers(parsed.questions, picks);
    if (answers === undefined) return { ok: false, reason: "invalid" };
    if (!this.close(id, "allowed", via, decisionBody("question", parsed.input, answers), answers)) return { ok: false, reason: "stale" };
    return { ok: true, state: "allowed" };
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

  /**
   * pending から to に移せたら、保留している接続を body（undefined は空の本文）で閉じて log に出す。移せたら true。
   * answers（質問に答えたときだけ）は移すのと同じ UPDATE で行に書く
   */
  private close(
    id: number,
    to: Exclude<CcPermissionState, "pending">,
    via: CcPermissionVia | null,
    body?: string,
    answers?: Readonly<Record<string, string>>,
  ): boolean {
    const moved = this.deps.store.resolve(id, to, via, answers);
    const held = this.held.get(id);
    this.held.delete(id);
    held?.settle(moved ? body : undefined);
    if (moved) {
      const row = this.deps.store.get(id);
      this.logResult(id, to, via, held?.question ?? (row !== undefined && row.questionInput !== null));
      if (row !== undefined) for (const listener of this.listeners) this.tell(() => listener.resolved(row));
    }
    return moved;
  }

  private tell(fn: () => void): void {
    try {
      fn();
    } catch (error) {
      this.deps.log(`Claude Code: 許可の要求の知らせに失敗しました（${error instanceof Error ? error.name : typeof error}）`);
    }
  }

  private logResult(id: number, state: CcPermissionState, via: CcPermissionVia | null, question: boolean): void {
    this.deps.log(`Claude Code: ${question ? "質問" : "許可の要求"}（#${id}）→ ${state}${via === null ? "" : `（${via}）`}`);
  }
}

/** 保留の期限（Web に出す）。保留中の行だけで、終わった行は null。質問の行（question_input あり）は questionHoldSec で数える */
export function permissionExpiresAt(
  row: Pick<CcPermissionRow, "createdAt" | "state" | "questionInput">,
  holdSec: number,
  questionHoldSec: number,
): string | null {
  if (row.state !== "pending") return null;
  const seconds = row.questionInput !== null ? questionHoldSec : holdSec;
  return new Date(Date.parse(row.createdAt) + seconds * 1000).toISOString();
}
