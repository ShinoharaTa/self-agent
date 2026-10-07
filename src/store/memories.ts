import type { DatabaseSync, SQLOutputValue } from "node:sqlite";

/** 有効な記憶の件数の上限（store は数えるだけで、確かめるのは呼び出し側） */
export const MEMORY_MAX_ACTIVE = 20;
/** 記憶 1 件の文字数の上限 */
export const MEMORY_TEXT_MAX_LENGTH = 150;

/** オーナーについての記憶（memories） */
export type Memory = {
  id: number;
  text: string;
  /** 記憶したチャンネル */
  channelId: string | null;
  createdAt: string;
  /** 消した時刻。有効なら null */
  deletedAt: string | null;
};

function nullableString(value: SQLOutputValue | undefined): string | null {
  return value === null || value === undefined ? null : String(value);
}

function toMemory(row: Record<string, SQLOutputValue>): Memory {
  return {
    id: Number(row.id),
    text: String(row.text),
    channelId: nullableString(row.channel_id),
    createdAt: String(row.created_at),
    deletedAt: nullableString(row.deleted_at),
  };
}

/** オーナーについての記憶。消すときは論理削除にして、取り消しで戻せるようにする */
export class MemoryStore {
  private readonly db: DatabaseSync;
  private readonly now: () => Date;

  constructor(db: DatabaseSync, now: () => Date = () => new Date()) {
    this.db = db;
    this.now = now;
  }

  add(text: string, channelId?: string): Memory {
    const row = this.db
      .prepare("INSERT INTO memories (text, channel_id, created_at) VALUES (?, ?, ?) RETURNING *")
      .get(text, channelId ?? null, this.now().toISOString());
    return toMemory(row!);
  }

  /** 有効な記憶を id 順に */
  list(): Memory[] {
    return this.db.prepare("SELECT * FROM memories WHERE deleted_at IS NULL ORDER BY id").all().map(toMemory);
  }

  /** 有効な記憶を消し、消した後の記憶を返す。無い id・既に消した記憶なら何もせず undefined */
  softDelete(id: number): Memory | undefined {
    const row = this.db
      .prepare("UPDATE memories SET deleted_at = ? WHERE id = ? AND deleted_at IS NULL RETURNING *")
      .get(this.now().toISOString(), id);
    return row === undefined ? undefined : toMemory(row);
  }

  /** 消した記憶を有効に戻し、戻した記憶を返す。無い id・有効な記憶なら何もせず undefined。件数の上限は確かめない */
  restore(id: number): Memory | undefined {
    const row = this.db
      .prepare("UPDATE memories SET deleted_at = NULL WHERE id = ? AND deleted_at IS NOT NULL RETURNING *")
      .get(id);
    return row === undefined ? undefined : toMemory(row);
  }

  countActive(): number {
    const row = this.db.prepare("SELECT COUNT(*) AS count FROM memories WHERE deleted_at IS NULL").get();
    return Number(row?.count ?? 0);
  }
}
