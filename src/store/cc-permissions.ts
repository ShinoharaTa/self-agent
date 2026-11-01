import type { DatabaseSync, SQLOutputValue } from "node:sqlite";

/** 許可の要求の行を残す日数（scheduler の tick で、created_at がこれより前の終わった行を消す。docs/plan/claude-code-sessions.md §9） */
export const CC_PERMISSION_KEEP_DAYS = 30;

/**
 * 許可の要求の状態（§3.4）。pending = 応答を保留している、allowed / denied = オーナーが押した（allowed_always は CC5b）、
 * answered_elsewhere = 端末・RC で先に答えられた（と判断した）、expired = 保留が切れた・Claude Code が先に接続を閉じた・再起動で残った、
 * released = self-agent が保留せず・保留をやめて空の本文を返した（停止・1 分の上限）
 */
export type CcPermissionState = "pending" | "allowed" | "allowed_always" | "denied" | "answered_elsewhere" | "expired" | "released";

/** 決まった経路（web・discord = 押した、hook・status = 他で答えられたと判断した元、shutdown・limit = released の理由）。expired は null */
export type CcPermissionVia = "web" | "discord" | "hook" | "status" | "shutdown" | "limit";

const STATES: readonly CcPermissionState[] = ["pending", "allowed", "allowed_always", "denied", "answered_elsewhere", "expired", "released"];
const VIAS: readonly CcPermissionVia[] = ["web", "discord", "hook", "status", "shutdown", "limit"];

/** cc_permissions の 1 行（時刻は ISO） */
export type CcPermissionRow = {
  /** 受け口の受信の連番 */
  id: number;
  sessionId: string;
  /** tool_name と tool_input（JSON）の sha256（hex） */
  requestHash: string;
  toolName: string;
  /** §3.4 の要約（先頭 500 字） */
  summary: string;
  permissionMode: string | null;
  state: CcPermissionState;
  via: CcPermissionVia | null;
  createdAt: string;
  /** pending でなくなった時刻 */
  resolvedAt: string | null;
};

function nullableString(value: SQLOutputValue | undefined): string | null {
  return value === null || value === undefined ? null : String(value);
}

function toRow(row: Record<string, SQLOutputValue>): CcPermissionRow {
  const state = STATES.find((value) => value === row.state);
  const via = row.via === null || row.via === undefined ? null : VIAS.find((value) => value === row.via);
  if (state === undefined || via === undefined) throw new Error("cc_permissions の行の形が違います");
  return {
    id: Number(row.id),
    sessionId: String(row.session_id),
    requestHash: String(row.request_hash),
    toolName: String(row.tool_name),
    summary: String(row.summary),
    permissionMode: nullableString(row.permission_mode),
    state,
    via,
    createdAt: String(row.created_at),
    resolvedAt: nullableString(row.resolved_at),
  };
}

/** Claude Code の許可の要求（cc_permissions。docs/plan/claude-code-sessions.md §3.4・§9）。物理削除は prune（日数）だけ */
export class CcPermissionStore {
  private readonly db: DatabaseSync;
  private readonly now: () => Date;

  constructor(db: DatabaseSync, now: () => Date = () => new Date()) {
    this.db = db;
    this.now = now;
  }

  /**
   * 行を作って返す。pending は 1 セッションに 1 件だけ（既にあれば例外。先に resolve で閉じる）。
   * pending 以外（保留しなかった released）は resolved_at も今にする
   */
  add(input: {
    sessionId: string;
    requestHash: string;
    toolName: string;
    summary: string;
    permissionMode: string | null;
    state: "pending" | "released";
    via?: CcPermissionVia;
  }): CcPermissionRow {
    const at = this.now().toISOString();
    const result = this.db
      .prepare(
        `INSERT INTO cc_permissions (session_id, request_hash, tool_name, summary, permission_mode, state, via, created_at, resolved_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.sessionId,
        input.requestHash,
        input.toolName,
        input.summary,
        input.permissionMode,
        input.state,
        input.via ?? null,
        at,
        input.state === "pending" ? null : at,
      );
    return this.get(Number(result.lastInsertRowid))!;
  }

  get(id: number): CcPermissionRow | undefined {
    const row = this.db.prepare("SELECT * FROM cc_permissions WHERE id = ?").get(id);
    return row === undefined ? undefined : toRow(row);
  }

  /** そのセッションの pending の行 */
  pendingFor(sessionId: string): CcPermissionRow | undefined {
    const row = this.db.prepare("SELECT * FROM cc_permissions WHERE session_id = ? AND state = 'pending'").get(sessionId);
    return row === undefined ? undefined : toRow(row);
  }

  /** pending の行を古い順に */
  listPending(): CcPermissionRow[] {
    return this.db.prepare("SELECT * FROM cc_permissions WHERE state = 'pending' ORDER BY id").all().map(toRow);
  }

  countPending(): number {
    const row = this.db.prepare("SELECT COUNT(*) AS n FROM cc_permissions WHERE state = 'pending'").get();
    return Number(row?.n ?? 0);
  }

  /** セッションごとの最新の行のうち、pending か resolved_at が since 以後のもの（Web のカードと、判断待ちの元の抑え。§2.2） */
  latestPerSession(since: Date): CcPermissionRow[] {
    return this.db
      .prepare(
        `SELECT * FROM cc_permissions WHERE id IN (SELECT MAX(id) FROM cc_permissions GROUP BY session_id)
           AND (state = 'pending' OR resolved_at >= ?) ORDER BY id`,
      )
      .all(since.toISOString())
      .map(toRow);
  }

  /** pending の行があるか、resolved_at が since 以後の行があるセッション */
  sessionsActiveSince(since: Date): Set<string> {
    const rows = this.db
      .prepare("SELECT DISTINCT session_id FROM cc_permissions WHERE state = 'pending' OR resolved_at >= ?")
      .all(since.toISOString());
    return new Set(rows.map((row) => String(row.session_id)));
  }

  /** そのセッションで since 以後に作った行の数（1 分の上限。§3.4） */
  countSince(sessionId: string, since: Date): number {
    const row = this.db
      .prepare("SELECT COUNT(*) AS n FROM cc_permissions WHERE session_id = ? AND created_at >= ?")
      .get(sessionId, since.toISOString());
    return Number(row?.n ?? 0);
  }

  /** 今が pending のときだけ to に移し、via と resolved_at（今）を書く（compare-and-set）。移したら true */
  resolve(id: number, to: Exclude<CcPermissionState, "pending">, via: CcPermissionVia | null): boolean {
    const result = this.db
      .prepare("UPDATE cc_permissions SET state = ?, via = ?, resolved_at = ? WHERE id = ? AND state = 'pending'")
      .run(to, via, this.now().toISOString(), id);
    return Number(result.changes) > 0;
  }

  /** 再起動の後: pending のまま残った行（応答を返す前に落ちた）を expired にし、その数を返す */
  expirePending(): number {
    const result = this.db
      .prepare("UPDATE cc_permissions SET state = 'expired', via = NULL, resolved_at = ? WHERE state = 'pending'")
      .run(this.now().toISOString());
    return Number(result.changes);
  }

  /** created_at が cutoff より前の終わった行を消し、消した数を返す（pending は消さない） */
  prune(cutoff: Date): number {
    const result = this.db
      .prepare("DELETE FROM cc_permissions WHERE created_at < ? AND state <> 'pending'")
      .run(cutoff.toISOString());
    return Number(result.changes);
  }
}
