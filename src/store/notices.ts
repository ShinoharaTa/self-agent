import type { DatabaseSync, SQLOutputValue } from "node:sqlite";

/** 知らせの重さ（Web UI の色）。info は確認・案内、success は戻った・通った、warning は注意、danger は取得できないなど */
export type NoticeLevel = "info" | "success" | "warning" | "danger";

/** #system への知らせの記録（notices。docs/plan/web-ui.md §7.1） */
export type NoticeRow = {
  id: number;
  /** 書いた時刻（ISO） */
  at: string;
  guildId: string;
  level: NoticeLevel;
  text: string;
  /** 投稿した #system のメッセージの ID。未投稿なら null */
  messageId: string | null;
  /** 投稿できた時刻（ISO）。未投稿なら null */
  postedAt: string | null;
};

/** 記録を残す日数（scheduler の tick で、これより前の行を未投稿も含めて消す） */
export const NOTICE_KEEP_DAYS = 90;
/** listRecent で一度に取れる行の数の上限 */
export const NOTICE_LIST_MAX = 200;

const LEVELS: readonly NoticeLevel[] = ["info", "success", "warning", "danger"];

function pickLevel(value: SQLOutputValue | undefined): NoticeLevel {
  const found = LEVELS.find((candidate) => candidate === value);
  if (found === undefined) throw new Error(`notices.level が不正です: ${String(value)}`);
  return found;
}

function nullableString(value: SQLOutputValue | undefined): string | null {
  return value === null || value === undefined ? null : String(value);
}

function toRow(row: Record<string, SQLOutputValue>): NoticeRow {
  return {
    id: Number(row.id),
    at: String(row.at),
    guildId: String(row.guild_id),
    level: pickLevel(row.level),
    text: String(row.text),
    messageId: nullableString(row.message_id),
    postedAt: nullableString(row.posted_at),
  };
}

/** #system への知らせの記録。物理削除は prune（日数）だけ */
export class NoticeStore {
  private readonly db: DatabaseSync;
  private readonly now: () => Date;

  constructor(db: DatabaseSync, now: () => Date = () => new Date()) {
    this.db = db;
    this.now = now;
  }

  /** 未投稿の行を 1 つ足して id を返す。書いた時刻は now */
  add(notice: { guildId: string; level: NoticeLevel; text: string }): number {
    const result = this.db
      .prepare("INSERT INTO notices (at, guild_id, level, text) VALUES (?, ?, ?, ?) RETURNING id")
      .get(this.now().toISOString(), notice.guildId, notice.level, notice.text);
    return Number(result?.id);
  }

  /** そのサーバー・同じ本文で未投稿（posted_at が NULL）の行のうち最新の 1 件。無ければ undefined */
  findUnposted(guildId: string, text: string): NoticeRow | undefined {
    const row = this.db
      .prepare("SELECT * FROM notices WHERE guild_id = ? AND text = ? AND posted_at IS NULL ORDER BY id DESC LIMIT 1")
      .get(guildId, text);
    return row === undefined ? undefined : toRow(row);
  }

  /** 投稿できた行に message_id と posted_at（now）を入れる。行が無ければ false */
  markPosted(id: number, messageId: string): boolean {
    const result = this.db
      .prepare("UPDATE notices SET message_id = ?, posted_at = ? WHERE id = ?")
      .run(messageId, this.now().toISOString(), id);
    return Number(result.changes) > 0;
  }

  /** 新しい順に limit 件。limit が 1〜NOTICE_LIST_MAX の整数でなければ RangeError */
  listRecent(limit: number): NoticeRow[] {
    if (!Number.isInteger(limit) || limit < 1 || limit > NOTICE_LIST_MAX) {
      throw new RangeError(`limit は 1〜${NOTICE_LIST_MAX} の整数にしてください`);
    }
    return this.db.prepare("SELECT * FROM notices ORDER BY id DESC LIMIT ?").all(limit).map(toRow);
  }

  /** since 以後に書いた行の数（未投稿を含む） */
  countSince(since: Date): number {
    const row = this.db.prepare("SELECT COUNT(*) AS count FROM notices WHERE at >= ?").get(since.toISOString());
    return Number(row?.count ?? 0);
  }

  /** cutoff より前に書いた行（未投稿も）を消し、消した数を返す */
  prune(cutoff: Date): number {
    const result = this.db.prepare("DELETE FROM notices WHERE at < ?").run(cutoff.toISOString());
    return Number(result.changes);
  }
}
