import { isAbsolute } from "node:path";
import type { DatabaseSync, SQLOutputValue } from "node:sqlite";

/** 受け取った添付の原本（attachments）。ファイルそのものは呼び出し側が置き・消す */
export type Attachment = {
  id: number;
  guildId: string;
  channelId: string;
  /** 添付が付いていた Discord のメッセージ */
  messageId: string;
  /** 原本のファイルの場所。`<dataDir>/attachments` からの相対パス（絶対パスは入れない。消す前に呼び出し側が realpath でその中か確かめる） */
  path: string;
  contentType: string;
  /** バイト数 */
  size: number;
  /** 画像の幅・高さ（分からなければ null） */
  width: number | null;
  height: number | null;
  sha256: string;
  /** 結びつけた記録（routine_records の id）。結びついていなければ null */
  recordId: number | null;
  createdAt: string;
  /** 予備（v20 の時点では書かない。消すときは行ごと消す） */
  deletedAt: string | null;
};

export type NewAttachment = {
  guildId: string;
  channelId: string;
  messageId: string;
  /** `<dataDir>/attachments` からの相対パス */
  path: string;
  contentType: string;
  size: number;
  width?: number | null;
  height?: number | null;
  sha256: string;
};

function nullableString(value: SQLOutputValue | undefined): string | null {
  return value === null || value === undefined ? null : String(value);
}

function nullableNumber(value: SQLOutputValue | undefined): number | null {
  return value === null || value === undefined ? null : Number(value);
}

function toAttachment(row: Record<string, SQLOutputValue>): Attachment {
  return {
    id: Number(row.id),
    guildId: String(row.guild_id),
    channelId: String(row.channel_id),
    messageId: String(row.message_id),
    path: String(row.path),
    contentType: String(row.content_type),
    size: Number(row.size),
    width: nullableNumber(row.width),
    height: nullableNumber(row.height),
    sha256: String(row.sha256),
    recordId: nullableNumber(row.record_id),
    createdAt: String(row.created_at),
    deletedAt: nullableString(row.deleted_at),
  };
}

const DAY_MS = 24 * 60 * 60 * 1000;

/** 受け取った添付の記録。記録に結びついたものは残し、結びついていないものは呼び出し側が日数で消す */
export class AttachmentStore {
  private readonly db: DatabaseSync;
  private readonly now: () => Date;

  constructor(db: DatabaseSync, now: () => Date = () => new Date()) {
    this.db = db;
    this.now = now;
  }

  /** path が絶対パスか、`/` で分けた要素に `..` があれば例外（呼び出し側の誤り） */
  add(attachment: NewAttachment): Attachment {
    if (isAbsolute(attachment.path) || attachment.path.split("/").includes("..")) {
      throw new Error("添付のパスは <dataDir>/attachments からの相対パスにしてください");
    }
    const row = this.db
      .prepare(
        "INSERT INTO attachments (guild_id, channel_id, message_id, path, content_type, size, width, height, sha256, created_at) " +
          "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING *",
      )
      .get(
        attachment.guildId,
        attachment.channelId,
        attachment.messageId,
        attachment.path,
        attachment.contentType,
        attachment.size,
        attachment.width ?? null,
        attachment.height ?? null,
        attachment.sha256,
        this.now().toISOString(),
      );
    return toAttachment(row!);
  }

  get(id: number): Attachment | undefined {
    const row = this.db.prepare("SELECT * FROM attachments WHERE id = ?").get(id);
    return row === undefined ? undefined : toAttachment(row);
  }

  /**
   * ids のうち、まだどの記録にも結びついていないものを recordId の記録に結びつける（別の記録に結びついたものは移さない）。
   * 結びつけた数を返す。添付のチャンネルは問わない（#inbox から渡した画像を定型チャンネルの記録に結びつける）
   */
  linkToRecord(ids: readonly number[], recordId: number): number {
    if (ids.length === 0) return 0;
    const result = this.db
      .prepare(
        `UPDATE attachments SET record_id = ? WHERE id IN (${ids.map(() => "?").join(", ")}) AND record_id IS NULL AND deleted_at IS NULL`,
      )
      .run(recordId, ...ids);
    return Number(result.changes);
  }

  /** その記録に結びついた添付を id 順に */
  listByRecord(recordId: number): Attachment[] {
    return this.db
      .prepare("SELECT * FROM attachments WHERE record_id = ? AND deleted_at IS NULL ORDER BY id")
      .all(recordId)
      .map(toAttachment);
  }

  /** どの記録にも結びついておらず、受け取ってから days 日より前のものを古い順に（掃除で消す候補） */
  listUnlinkedOlderThan(days: number): Attachment[] {
    const cutoff = new Date(this.now().getTime() - days * DAY_MS).toISOString();
    return this.db
      .prepare("SELECT * FROM attachments WHERE record_id IS NULL AND deleted_at IS NULL AND created_at < ? ORDER BY created_at, id")
      .all(cutoff)
      .map(toAttachment);
  }

  /** 行を消す（ファイルを消した後に呼ぶ）。無い id なら false */
  delete(id: number): boolean {
    const result = this.db.prepare("DELETE FROM attachments WHERE id = ?").run(id);
    return Number(result.changes) > 0;
  }
}
