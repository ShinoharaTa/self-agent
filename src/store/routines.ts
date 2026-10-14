import type { DatabaseSync, SQLOutputValue } from "node:sqlite";
import { DEFAULT_PERSONA_ID } from "../config.ts";

/** サーバーごとの active の定型チャンネルの上限（/routine new・定型化の前に countActive で確かめる） */
export const ROUTINE_MAX_ACTIVE_PER_GUILD = 20;
/** 手順の文字数の上限（モーダル・propose_instructions） */
export const ROUTINE_INSTRUCTIONS_MAX_LENGTH = 2000;

/** active は使っている、archived は削除した（Discord のチャンネルは無い。記録・添付・手順は残す） */
export type RoutineState = "active" | "archived";

/** 定型チャンネル（routines。docs/plan/routines.md） */
export type Routine = {
  channelId: string;
  guildId: string;
  /** 持ち主の人格の id */
  persona: string;
  /** Discord のチャンネル名（改名は再同期で合わせる） */
  name: string;
  /** 1 行の目的 */
  purpose: string;
  /** 手順（オーナーが決めた常設の指示） */
  instructions: string;
  /** 手順の版。作ったときは 1 で、手順を変えるたびに 1 増える */
  instructionsRev: number;
  /** SDK セッションに渡した手順の版。まだ渡していなければ 0 */
  seenRev: number;
  /** 直近の会話の切り替えの要約。まだ無ければ null */
  summary: string | null;
  /** 最後に会話を切り替えた日（SELF_AGENT_TZ の日付、YYYY-MM-DD）。まだ切り替えていなければ null */
  rotatedDate: string | null;
  /** 最後に会話を切り替えた時刻（ISO）。まだ切り替えていなければ null */
  rotatedAt: string | null;
  state: RoutineState;
  createdAt: string;
  updatedAt: string;
  /** archived にした時刻。active なら null */
  archivedAt: string | null;
};

export type NewRoutine = {
  channelId: string;
  guildId: string;
  /** 省略したら既定の人格 */
  persona?: string;
  name: string;
  purpose?: string;
  instructions?: string;
};

export type SetInstructionsResult =
  | { result: "updated"; routine: Routine }
  | { result: "no_change"; routine: Routine }
  /** expectedRev が今の版と違う（確認のボタンが古い） */
  | { result: "stale"; routine: Routine }
  | { result: "not_found" };

function nullableString(value: SQLOutputValue | undefined): string | null {
  return value === null || value === undefined ? null : String(value);
}

function toRoutine(row: Record<string, SQLOutputValue>): Routine {
  return {
    channelId: String(row.channel_id),
    guildId: String(row.guild_id),
    persona: String(row.persona),
    name: String(row.name),
    purpose: String(row.purpose),
    instructions: String(row.instructions),
    instructionsRev: Number(row.instructions_rev),
    seenRev: Number(row.seen_rev),
    summary: nullableString(row.summary),
    rotatedDate: nullableString(row.rotated_date),
    rotatedAt: nullableString(row.rotated_at),
    state: row.state === "archived" ? "archived" : "active",
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
    archivedAt: nullableString(row.archived_at),
  };
}

/**
 * 定型チャンネル（1 チャンネル 1 行。channel_id は archived を含めて一意）。物理削除はしない。updated_at は書き換えるたびに今にする。
 * 上限（ROUTINE_MAX_ACTIVE_PER_GUILD）・文字数は呼び出し側が確かめる
 */
export class RoutineStore {
  private readonly db: DatabaseSync;
  private readonly now: () => Date;

  constructor(db: DatabaseSync, now: () => Date = () => new Date()) {
    this.db = db;
    this.now = now;
  }

  /**
   * active で作る（手順の版は 1、渡した版は 0）。セッションだったチャンネルも作れる（sessions とは別の表）。
   * そのチャンネルの行が既にあれば（archived を含む）UNIQUE 制約のエラーを投げる（呼び出し側が先に get で確かめる）
   */
  create(routine: NewRoutine): Routine {
    const at = this.now().toISOString();
    const row = this.db
      .prepare(
        "INSERT INTO routines (channel_id, guild_id, persona, name, purpose, instructions, created_at, updated_at) " +
          "VALUES (?, ?, ?, ?, ?, ?, ?, ?) RETURNING *",
      )
      .get(
        routine.channelId,
        routine.guildId,
        routine.persona ?? DEFAULT_PERSONA_ID,
        routine.name,
        routine.purpose ?? "",
        routine.instructions ?? "",
        at,
        at,
      );
    return toRoutine(row!);
  }

  /** そのチャンネルの定型チャンネル（archived も返す） */
  get(channelId: string): Routine | undefined {
    const row = this.db.prepare("SELECT * FROM routines WHERE channel_id = ?").get(channelId);
    return row === undefined ? undefined : toRoutine(row);
  }

  /** そのサーバーの active を作った順に */
  listActive(guildId: string): Routine[] {
    return this.db
      .prepare("SELECT * FROM routines WHERE guild_id = ? AND state = 'active' ORDER BY created_at, channel_id")
      .all(guildId)
      .map(toRoutine);
  }

  /** そのサーバーの active の数（ROUTINE_MAX_ACTIVE_PER_GUILD と比べる） */
  countActive(guildId: string): number {
    const row = this.db.prepare("SELECT COUNT(*) AS count FROM routines WHERE guild_id = ? AND state = 'active'").get(guildId);
    return Number(row?.count ?? 0);
  }

  /**
   * 手順を変える。今と同じ文なら版を変えずに no_change。expectedRev を渡したときは、今の版と同じときだけ変える（違えば stale）。
   * 変えたら版を 1 増やす（渡した版は変えないので、次のターンで変わったことが分かる）
   */
  setInstructions(channelId: string, instructions: string, expectedRev?: number): SetInstructionsResult {
    const current = this.get(channelId);
    if (current === undefined) return { result: "not_found" };
    if (expectedRev !== undefined && current.instructionsRev !== expectedRev) return { result: "stale", routine: current };
    if (current.instructions === instructions) return { result: "no_change", routine: current };
    const row = this.db
      .prepare(
        "UPDATE routines SET instructions = ?, instructions_rev = instructions_rev + 1, updated_at = ? " +
          "WHERE channel_id = ? AND instructions_rev = ? RETURNING *",
      )
      .get(instructions, this.now().toISOString(), channelId, current.instructionsRev);
    // 読んでから書くまでに別の変更が入った
    if (row === undefined) return { result: "stale", routine: this.get(channelId)! };
    return { result: "updated", routine: toRoutine(row) };
  }

  /** SDK セッションに rev の版の手順を渡したことを記録する。今の渡した版より大きく、手順の版以下のときだけ進める（戻さない）。進めたら true */
  markInstructionsSeen(channelId: string, rev: number): boolean {
    const result = this.db
      .prepare(
        "UPDATE routines SET seen_rev = ?, updated_at = ? WHERE channel_id = ? AND seen_rev < ? AND ? <= instructions_rev",
      )
      .run(rev, this.now().toISOString(), channelId, rev, rev);
    return Number(result.changes) > 0;
  }

  /** 会話の切り替えの要約を保存する（直近の 1 つだけ）。無いチャンネルなら false */
  setSummary(channelId: string, summary: string): boolean {
    const result = this.db
      .prepare("UPDATE routines SET summary = ?, updated_at = ? WHERE channel_id = ?")
      .run(summary, this.now().toISOString(), channelId);
    return Number(result.changes) > 0;
  }

  /** 会話を切り替えた日（YYYY-MM-DD）と時刻（rotatedAt）を保存する。無いチャンネルなら false */
  setRotated(channelId: string, date: string, rotatedAt: Date): boolean {
    const result = this.db
      .prepare("UPDATE routines SET rotated_date = ?, rotated_at = ?, updated_at = ? WHERE channel_id = ?")
      .run(date, rotatedAt.toISOString(), this.now().toISOString(), channelId);
    return Number(result.changes) > 0;
  }

  /** 名前を変える（再同期で Discord のチャンネル名に合わせる）。無いチャンネル・同じ名前なら何もせず false */
  rename(channelId: string, name: string): boolean {
    const result = this.db
      .prepare("UPDATE routines SET name = ?, updated_at = ? WHERE channel_id = ? AND name <> ?")
      .run(name, this.now().toISOString(), channelId, name);
    return Number(result.changes) > 0;
  }

  /** archived にする。無いチャンネル・既に archived なら何もせず false */
  archive(channelId: string): boolean {
    const at = this.now().toISOString();
    const result = this.db
      .prepare("UPDATE routines SET state = 'archived', archived_at = ?, updated_at = ? WHERE channel_id = ? AND state = 'active'")
      .run(at, at, channelId);
    return Number(result.changes) > 0;
  }

  /** active に戻す（上限は呼び出し側が確かめる）。無いチャンネル・既に active なら何もせず false */
  restore(channelId: string): boolean {
    const result = this.db
      .prepare("UPDATE routines SET state = 'active', archived_at = NULL, updated_at = ? WHERE channel_id = ? AND state = 'archived'")
      .run(this.now().toISOString(), channelId);
    return Number(result.changes) > 0;
  }
}
