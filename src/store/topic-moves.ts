import type { DatabaseSync } from "node:sqlite";
import { rollbackIfOpen } from "./db.ts";

/** 付け替えの状態。M5 が書くのは running・done・failed だけ（proposed・cancelled は M6 の札） */
export type TopicMoveState = "proposed" | "running" | "done" | "cancelled" | "failed";
/** 誰が頼んだか。right_hand は M6 */
export type TopicMoveBy = "web" | "discord" | "right_hand";

export type TopicMove = {
  id: number;
  channelId: string;
  /** 前の project_dir。場所なし（軽い）は null */
  fromDir: string | null;
  toDir: string;
  state: TopicMoveState;
  by: TopicMoveBy;
  /** 引き継いだ要点の全文。要点なしで変えたときは null */
  note: string | null;
  createdAt: string;
  doneAt: string | null;
  /** 右腕の確認（proposed）の投稿の ID。投稿していない・確認でない行は null（v43） */
  messageId: string | null;
};

function nullableString(value: unknown): string | null {
  return value === null || value === undefined ? null : String(value);
}

function toMove(row: Record<string, unknown>): TopicMove {
  return {
    id: Number(row.id),
    channelId: String(row.channel_id),
    fromDir: nullableString(row.from_dir),
    toDir: String(row.to_dir),
    state: String(row.state) as TopicMoveState,
    by: String(row.by) as TopicMoveBy,
    note: nullableString(row.note),
    createdAt: String(row.created_at),
    doneAt: nullableString(row.done_at),
    messageId: nullableString(row.message_id),
  };
}

/** 一意索引（topic_moves_running・topic_moves_proposed）の違反か */
function isUniqueViolation(error: unknown): boolean {
  return error instanceof Error && /UNIQUE constraint failed/i.test(error.message);
}

/**
 * 話題の場所の付け替えの記録（topic_moves。docs/plan/web-ui-v3.md §6.3）。running と proposed（右腕の確認）はそれぞれ 1 チャンネルに 1 行。
 * finish は場所を変える書き込み（apply）と done を 1 つのトランザクションにする
 */
export class TopicMoveStore {
  private readonly db: DatabaseSync;
  private readonly now: () => Date;

  constructor(db: DatabaseSync, now: () => Date = () => new Date()) {
    this.db = db;
    this.now = now;
  }

  /** running の行を足して id を返す。同じチャンネルに running の行がもうあれば足さずに undefined。ほかのエラーは投げる */
  start(input: { channelId: string; fromDir: string | null; toDir: string; by: TopicMoveBy }): number | undefined {
    try {
      const row = this.db
        .prepare(
          "INSERT INTO topic_moves (channel_id, from_dir, to_dir, state, by, created_at) VALUES (?, ?, ?, 'running', ?, ?) RETURNING id",
        )
        .get(input.channelId, input.fromDir, input.toDir, input.by, this.now().toISOString());
      return Number(row!.id);
    } catch (error) {
      if (isUniqueViolation(error)) return undefined;
      throw error;
    }
  }

  /** proposed の行を足して id を返す。同じチャンネルに proposed の行がもうあれば足さずに undefined（一意の索引）。ほかのエラーは投げる */
  propose(input: { channelId: string; fromDir: string | null; toDir: string; by: TopicMoveBy }): number | undefined {
    try {
      const row = this.db
        .prepare(
          "INSERT INTO topic_moves (channel_id, from_dir, to_dir, state, by, created_at) VALUES (?, ?, ?, 'proposed', ?, ?) RETURNING id",
        )
        .get(input.channelId, input.fromDir, input.toDir, input.by, this.now().toISOString());
      return Number(row!.id);
    } catch (error) {
      if (isUniqueViolation(error)) return undefined;
      throw error;
    }
  }

  setMessageId(id: number, messageId: string): void {
    this.db.prepare("UPDATE topic_moves SET message_id = ? WHERE id = ?").run(messageId, id);
  }

  /**
   * その話題の proposed → running（from_dir・to_dir をその場で解いた場所に直す）。ほかの話題の行・proposed でない・
   * その話題に running があるときは false で、何も変えない（compare-and-set）
   */
  accept(id: number, input: { channelId: string; fromDir: string | null; toDir: string }): boolean {
    try {
      const result = this.db
        .prepare(
          "UPDATE topic_moves SET state = 'running', from_dir = ?, to_dir = ? WHERE id = ? AND channel_id = ? AND state = 'proposed'",
        )
        .run(input.fromDir, input.toDir, id, input.channelId);
      return Number(result.changes) === 1;
    } catch (error) {
      if (isUniqueViolation(error)) return false;
      throw error;
    }
  }

  /** proposed → cancelled（done_at を入れる）。proposed でなければ false（compare-and-set） */
  cancel(id: number): boolean {
    const result = this.db
      .prepare("UPDATE topic_moves SET state = 'cancelled', done_at = ? WHERE id = ? AND state = 'proposed'")
      .run(this.now().toISOString(), id);
    return Number(result.changes) === 1;
  }

  /** その話題の proposed の行 */
  proposedFor(channelId: string): TopicMove | undefined {
    const row = this.db.prepare("SELECT * FROM topic_moves WHERE channel_id = ? AND state = 'proposed'").get(channelId);
    return row === undefined ? undefined : toMove(row);
  }

  /** proposed の行すべて（id の順。/api/topics の「あなたの番」に使う） */
  listProposed(): TopicMove[] {
    return this.db.prepare("SELECT * FROM topic_moves WHERE state = 'proposed' ORDER BY id").all().map(toMove);
  }

  /** created_at が cutoff より前の proposed の行（id の順） */
  listProposedBefore(cutoff: Date): TopicMove[] {
    return this.db
      .prepare("SELECT * FROM topic_moves WHERE state = 'proposed' AND created_at < ? ORDER BY id")
      .all(cutoff.toISOString())
      .map(toMove);
  }

  /**
   * 1 つのトランザクションで apply（同期。自分のトランザクションを開かない store の書き込みだけ）と、その行の done・note・done_at を書く。
   * 行が running でなければ投げる。途中で投げたら apply の書き込みも戻して投げ直す
   */
  finish(id: number, note: string | null, apply: () => void): void {
    this.db.exec("BEGIN");
    try {
      apply();
      const result = this.db
        .prepare("UPDATE topic_moves SET state = 'done', note = ?, done_at = ? WHERE id = ? AND state = 'running'")
        .run(note, this.now().toISOString(), id);
      if (Number(result.changes) !== 1) throw new Error("場所の付け替えの行が running ではありません");
      this.db.exec("COMMIT");
    } catch (error) {
      rollbackIfOpen(this.db);
      throw error;
    }
  }

  /** running の行を failed にする。running でなければ何もしない */
  fail(id: number): void {
    this.db
      .prepare("UPDATE topic_moves SET state = 'failed', done_at = ? WHERE id = ? AND state = 'running'")
      .run(this.now().toISOString(), id);
  }

  get(id: number): TopicMove | undefined {
    const row = this.db.prepare("SELECT * FROM topic_moves WHERE id = ?").get(id);
    return row === undefined ? undefined : toMove(row);
  }

  /** そのチャンネルの running の行 */
  running(channelId: string): TopicMove | undefined {
    const row = this.db.prepare("SELECT * FROM topic_moves WHERE channel_id = ? AND state = 'running'").get(channelId);
    return row === undefined ? undefined : toMove(row);
  }

  /** running の行のあるチャンネル（/api/topics が 1 回の問い合わせで引くため） */
  runningChannels(): Set<string> {
    const rows = this.db.prepare("SELECT channel_id FROM topic_moves WHERE state = 'running'").all();
    return new Set(rows.map((row) => String(row.channel_id)));
  }

  /** 再起動の後: running の行（変える前に落ちた）をすべて failed にし、変えた後の行を id の順で返す */
  failInterrupted(): TopicMove[] {
    return this.db
      .prepare("UPDATE topic_moves SET state = 'failed', done_at = ? WHERE state = 'running' RETURNING *")
      .all(this.now().toISOString())
      .map(toMove)
      .sort((a, b) => a.id - b.id);
  }
}
