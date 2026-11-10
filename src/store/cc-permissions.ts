import type { DatabaseSync, SQLOutputValue } from "node:sqlite";
import { type CcRule, parseStoredRules } from "../cc/permissions.ts";
import { parseStoredAnswers } from "../cc/questions.ts";
import { rollbackIfOpen } from "./db.ts";

/** 許可の要求の行を残す日数（scheduler の tick で、created_at がこれより前の終わった行を消す。docs/plan/claude-code-sessions.md §9） */
export const CC_PERMISSION_KEEP_DAYS = 30;

/**
 * 許可の要求の状態（§3.4）。pending = 応答を保留している、allowed / allowed_always / denied = オーナーが押した（allowed_always は常に許可）、
 * answered_elsewhere = 端末・RC で先に答えられた（と判断した）、expired = 保留が切れた・Claude Code が先に接続を閉じた・再起動で残った、
 * released = self-agent が保留せず・保留をやめて空の本文を返した（停止・1 分の上限）
 */
export type CcPermissionState = "pending" | "allowed" | "allowed_always" | "denied" | "answered_elsewhere" | "expired" | "released";

/**
 * 決まった経路（web・discord = 押した、hook・status = 他で答えられたと判断した元、shutdown・limit = released の理由、
 * abort = プロジェクトのセッションのターンが止まって保留をやめた（released。docs/plan/unify.md §5.1））。expired は null
 */
export type CcPermissionVia = "web" | "discord" | "hook" | "status" | "shutdown" | "limit" | "abort";

/** 要求の出どころ（v40）。hook = Claude Code の hook の受け口（cc/hook-server.ts）、sdk = プロジェクトのセッションの canUseTool（agent/permission-bridge.ts） */
export type CcPermissionOrigin = "hook" | "sdk";

const STATES: readonly CcPermissionState[] = ["pending", "allowed", "allowed_always", "denied", "answered_elsewhere", "expired", "released"];
const VIAS: readonly CcPermissionVia[] = ["web", "discord", "hook", "status", "shutdown", "limit", "abort"];
const ORIGINS: readonly CcPermissionOrigin[] = ["hook", "sdk"];

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
  /** 常に許可にできるルール（線引きを通った提案。無ければ null = [常に許可] は出せない） */
  alwaysRules: CcRule[] | null;
  state: CcPermissionState;
  via: CcPermissionVia | null;
  createdAt: string;
  /** pending でなくなった時刻 */
  resolvedAt: string | null;
  /** #system に出した 1 通のメッセージの ID とそのチャンネル（CC5c。出していなければ null） */
  messageId: string | null;
  messageChannelId: string | null;
  /** AskUserQuestion の tool_input の JSON そのまま（質問の形が読めたときだけ。Q1）。無ければ null = 今までどおりの許可の要求 */
  questionInput: string | null;
  /** 質問に答えたときに返した answers（question の文 → 値）。無ければ・形が違えば null */
  answers: Record<string, string> | null;
  origin: CcPermissionOrigin;
};

function nullableString(value: SQLOutputValue | undefined): string | null {
  return value === null || value === undefined ? null : String(value);
}

function toRow(row: Record<string, SQLOutputValue>): CcPermissionRow {
  const state = STATES.find((value) => value === row.state);
  const via = row.via === null || row.via === undefined ? null : VIAS.find((value) => value === row.via);
  const origin = ORIGINS.find((value) => value === row.origin);
  if (state === undefined || via === undefined || origin === undefined) throw new Error("cc_permissions の行の形が違います");
  return {
    id: Number(row.id),
    sessionId: String(row.session_id),
    requestHash: String(row.request_hash),
    toolName: String(row.tool_name),
    summary: String(row.summary),
    permissionMode: nullableString(row.permission_mode),
    alwaysRules: parseStoredRules(nullableString(row.always_rules)),
    state,
    via,
    createdAt: String(row.created_at),
    resolvedAt: nullableString(row.resolved_at),
    messageId: nullableString(row.message_id),
    messageChannelId: nullableString(row.message_channel_id),
    questionInput: nullableString(row.question_input),
    answers: parseStoredAnswers(nullableString(row.answers)),
    origin,
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
    alwaysRules?: readonly CcRule[] | null;
    /** AskUserQuestion の tool_input の JSON（質問の形が読めたときだけ） */
    questionInput?: string | null;
    state: "pending" | "released";
    via?: CcPermissionVia;
    /** 省略は hook */
    origin?: CcPermissionOrigin;
  }): CcPermissionRow {
    const at = this.now().toISOString();
    const result = this.db
      .prepare(
        `INSERT INTO cc_permissions (session_id, request_hash, tool_name, summary, permission_mode, always_rules, question_input, state, via, created_at, resolved_at, origin)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.sessionId,
        input.requestHash,
        input.toolName,
        input.summary,
        input.permissionMode,
        input.alwaysRules === undefined || input.alwaysRules === null || input.alwaysRules.length === 0
          ? null
          : JSON.stringify(input.alwaysRules),
        input.questionInput ?? null,
        input.state,
        input.via ?? null,
        at,
        input.state === "pending" ? null : at,
        input.origin ?? "hook",
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

  /** pending の行を古い順に。origin を渡せばその出どころの行だけ */
  listPending(origin?: CcPermissionOrigin): CcPermissionRow[] {
    return origin === undefined
      ? this.db.prepare("SELECT * FROM cc_permissions WHERE state = 'pending' ORDER BY id").all().map(toRow)
      : this.db.prepare("SELECT * FROM cc_permissions WHERE state = 'pending' AND origin = ? ORDER BY id").all(origin).map(toRow);
  }

  /** pending の行の数。origin を渡せばその出どころの行だけ */
  countPending(origin?: CcPermissionOrigin): number {
    const row =
      origin === undefined
        ? this.db.prepare("SELECT COUNT(*) AS n FROM cc_permissions WHERE state = 'pending'").get()
        : this.db.prepare("SELECT COUNT(*) AS n FROM cc_permissions WHERE state = 'pending' AND origin = ?").get(origin);
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

  /**
   * プロジェクトのセッションのチャンネルの最新の要求（origin sdk。docs/plan/unify.md §6.1 の 5）。1 通をそのチャンネルに出した行か、
   * session_id がそのチャンネルの SDK セッション（sessionId。まだ無ければ省く）の行のうち最新のもので、pending か resolved_at が since 以後のものだけ
   */
  latestSdkFor(channelId: string, sessionId: string | undefined, since: Date): CcPermissionRow | undefined {
    const row = this.db
      .prepare(
        `SELECT * FROM cc_permissions WHERE origin = 'sdk' AND (message_channel_id = ? OR session_id = ?) ORDER BY id DESC LIMIT 1`,
      )
      .get(channelId, sessionId ?? null);
    if (row === undefined) return undefined;
    const found = toRow(row);
    return found.state === "pending" || (found.resolvedAt !== null && found.resolvedAt >= since.toISOString()) ? found : undefined;
  }

  /**
   * pending の行があるか、resolved_at が since 以後の行があるセッション（origin hook の行だけ。sdk はプロジェクトのセッションで、registry の一覧に居ない）。
   * released（limit）を含む（判断待ちの元の抑え。判断待ちの知らせの抑えは released を除いた sessionsAnsweredSince）
   */
  sessionsActiveSince(since: Date): Set<string> {
    const rows = this.db
      .prepare("SELECT DISTINCT session_id FROM cc_permissions WHERE origin = 'hook' AND (state = 'pending' OR resolved_at >= ?)")
      .all(since.toISOString());
    return new Set(rows.map((row) => String(row.session_id)));
  }

  /**
   * pending の行があるか、resolved_at が since 以後の行があるセッションのうち、released（保留しなかった・やめた。#system に 1 通を出していない）を除いたもの。
   * 判断待ちの知らせ（CC5c）はこのセッションには出さない（許可の要求の 1 通で済ませる。§5.2）
   */
  sessionsAnsweredSince(since: Date): Set<string> {
    const rows = this.db
      .prepare("SELECT DISTINCT session_id FROM cc_permissions WHERE state = 'pending' OR (resolved_at >= ? AND state <> 'released')")
      .all(since.toISOString());
    return new Set(rows.map((row) => String(row.session_id)));
  }

  /** #system に出した 1 通を記録する（CC5c。書き換えてボタンを外すため）。行があれば true */
  setMessage(id: number, channelId: string, messageId: string): boolean {
    const result = this.db
      .prepare("UPDATE cc_permissions SET message_id = ?, message_channel_id = ? WHERE id = ?")
      .run(messageId, channelId, id);
    return Number(result.changes) > 0;
  }

  /** そのセッションで since 以後に作った行の数（1 分の上限。§3.4） */
  countSince(sessionId: string, since: Date): number {
    const row = this.db
      .prepare("SELECT COUNT(*) AS n FROM cc_permissions WHERE session_id = ? AND created_at >= ?")
      .get(sessionId, since.toISOString());
    return Number(row?.n ?? 0);
  }

  /**
   * 今が pending のときだけ to に移し、via と resolved_at（今）を書く（compare-and-set）。移したら true。
   * answers（質問に答えたときだけ）を渡せば同じ UPDATE で answers の列も書く（移せなければ書かない）
   */
  resolve(id: number, to: Exclude<CcPermissionState, "pending">, via: CcPermissionVia | null, answers?: Readonly<Record<string, string>>): boolean {
    const result = this.db
      .prepare(
        "UPDATE cc_permissions SET state = ?, via = ?, resolved_at = ?, answers = COALESCE(?, answers) WHERE id = ? AND state = 'pending'",
      )
      .run(to, via, this.now().toISOString(), answers === undefined ? null : JSON.stringify(answers), id);
    return Number(result.changes) > 0;
  }

  /**
   * 再起動の後: pending のまま残った行（応答を返す前に落ちた）を expired にし、移した後の行を返す
   * （#system に出した 1 通を「時間切れ」に書き換えるため。CC5c）
   */
  expirePending(): CcPermissionRow[] {
    const ids = this.db
      .prepare("SELECT id FROM cc_permissions WHERE state = 'pending' ORDER BY id")
      .all()
      .map((row) => Number(row.id));
    if (ids.length === 0) return [];
    const statement = this.db.prepare("UPDATE cc_permissions SET state = 'expired', via = NULL, resolved_at = ? WHERE id = ? AND state = 'pending'");
    const at = this.now().toISOString();
    this.db.exec("BEGIN");
    try {
      for (const id of ids) statement.run(at, id);
      this.db.exec("COMMIT");
    } catch (error) {
      rollbackIfOpen(this.db);
      throw error;
    }
    return ids.map((id) => this.get(id)).filter((row): row is CcPermissionRow => row !== undefined);
  }

  /** created_at が cutoff より前の終わった行を消し、消した数を返す（pending は消さない） */
  prune(cutoff: Date): number {
    const result = this.db
      .prepare("DELETE FROM cc_permissions WHERE created_at < ? AND state <> 'pending'")
      .run(cutoff.toISOString());
    return Number(result.changes);
  }
}
