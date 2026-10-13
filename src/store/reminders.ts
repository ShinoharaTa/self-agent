import type { DatabaseSync, SQLOutputValue } from "node:sqlite";

/** notify は決まった文を投稿するだけ、prompt はその時刻にエージェントのターンを 1 回起こす */
export type ReminderKind = "notify" | "prompt";

/** active はこれから知らせる、fired は 1 回だけのものを知らせてボタンが押されていない、done は完了、cancelled は止めた */
export type ReminderStatus = "active" | "fired" | "done" | "cancelled";

/** リマインドと予約した依頼（reminders）。時刻はすべて UTC の ISO */
export type Reminder = {
  id: number;
  guildId: string;
  /** 投稿するチャンネル（無くなっていたら呼び出し側が moveChannel で書き換える） */
  channelId: string;
  kind: ReminderKind;
  text: string;
  /** 紐づけたタスク（1 回だけのものだけ） */
  taskId: number | null;
  /** 繰り返しの形（recurrence.ts の formatRule）。1 回だけなら null */
  rule: string | null;
  /** 規則による次の回（1 回だけなら指定時刻）。もう無ければ null */
  nextAt: string | null;
  /** スヌーズで決めた、もう一度知らせる時刻 */
  snoozeAt: string | null;
  status: ReminderStatus;
  /** 投稿（prompt は進めた回数）のたびに 1 増える。発火とボタンの compare-and-set に使う */
  fireSeq: number;
  lastFiredAt: string | null;
  /** 最後に投稿した発火のメッセージ */
  lastMessageId: string | null;
  createdAt: string;
  updatedAt: string;
};

export type NewReminder = {
  guildId: string;
  channelId: string;
  kind: ReminderKind;
  text: string;
  taskId?: number;
  rule?: string;
  nextAt: Date;
};

/** markFired・claim で書き換える内容。nextAt が null ならもう回が無い */
export type FireUpdate = {
  nextAt: Date | null;
  status: ReminderStatus;
  firedAt: Date;
};

/** next_at と snooze_at の早い方（片方が NULL ならもう片方） */
const EARLIEST_AT = "COALESCE(MIN(next_at, snooze_at), next_at, snooze_at)";

function nullableString(value: SQLOutputValue | undefined): string | null {
  return value === null || value === undefined ? null : String(value);
}

function toStatus(value: SQLOutputValue | undefined): ReminderStatus {
  return value === "fired" || value === "done" || value === "cancelled" ? value : "active";
}

function toReminder(row: Record<string, SQLOutputValue>): Reminder {
  return {
    id: Number(row.id),
    guildId: String(row.guild_id),
    channelId: String(row.channel_id),
    kind: row.kind === "prompt" ? "prompt" : "notify",
    text: String(row.text),
    taskId: row.task_id === null || row.task_id === undefined ? null : Number(row.task_id),
    rule: nullableString(row.rule),
    nextAt: nullableString(row.next_at),
    snoozeAt: nullableString(row.snooze_at),
    status: toStatus(row.status),
    fireSeq: Number(row.fire_seq),
    lastFiredAt: nullableString(row.last_fired_at),
    lastMessageId: nullableString(row.last_message_id),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

/** リマインドと予約した依頼。物理削除はしない。updated_at は書き換えるたびに今にする */
export class ReminderStore {
  private readonly db: DatabaseSync;
  private readonly now: () => Date;

  constructor(db: DatabaseSync, now: () => Date = () => new Date()) {
    this.db = db;
    this.now = now;
  }

  add(reminder: NewReminder): Reminder {
    const at = this.now().toISOString();
    const row = this.db
      .prepare(
        "INSERT INTO reminders (guild_id, channel_id, kind, text, task_id, rule, next_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING *",
      )
      .get(
        reminder.guildId,
        reminder.channelId,
        reminder.kind,
        reminder.text,
        reminder.taskId ?? null,
        reminder.rule ?? null,
        reminder.nextAt.toISOString(),
        at,
        at,
      );
    return toReminder(row!);
  }

  get(id: number): Reminder | undefined {
    const row = this.db.prepare("SELECT * FROM reminders WHERE id = ?").get(id);
    return row === undefined ? undefined : toReminder(row);
  }

  /** active を次に知らせる順（next_at と snooze_at の早い方。同じなら id 順）に */
  listActive(limit: number): Reminder[] {
    return this.db
      .prepare(`SELECT * FROM reminders WHERE status = 'active' ORDER BY ${EARLIEST_AT}, id LIMIT ?`)
      .all(limit)
      .map(toReminder);
  }

  /** 知らせる時刻が now 以前になった active を早い順に */
  listDue(now: Date, limit: number): Reminder[] {
    const at = now.toISOString();
    return this.db
      .prepare(
        `SELECT * FROM reminders WHERE status = 'active'
          AND ((next_at IS NOT NULL AND next_at <= ?) OR (snooze_at IS NOT NULL AND snooze_at <= ?))
          ORDER BY ${EARLIEST_AT}, id LIMIT ?`,
      )
      .all(at, at, limit)
      .map(toReminder);
  }

  /** active の件数。kind を渡せばその種類だけ */
  countActive(options: { kind?: ReminderKind } = {}): number {
    const row =
      options.kind === undefined
        ? this.db.prepare("SELECT COUNT(*) AS n FROM reminders WHERE status = 'active'").get()
        : this.db.prepare("SELECT COUNT(*) AS n FROM reminders WHERE status = 'active' AND kind = ?").get(options.kind);
    return Number(row?.n ?? 0);
  }

  /** 同じチャンネル・text・rule の active（1 回だけ（rule が null）なら next_at も同じもの） */
  findDuplicate(channelId: string, text: string, rule: string | null, nextAt: Date | null): Reminder | undefined {
    const row =
      rule === null
        ? this.db
            .prepare(
              "SELECT * FROM reminders WHERE status = 'active' AND channel_id = ? AND text = ? AND rule IS NULL AND next_at IS ? ORDER BY id LIMIT 1",
            )
            .get(channelId, text, nextAt === null ? null : nextAt.toISOString())
        : this.db
            .prepare("SELECT * FROM reminders WHERE status = 'active' AND channel_id = ? AND text = ? AND rule = ? ORDER BY id LIMIT 1")
            .get(channelId, text, rule);
    return row === undefined ? undefined : toReminder(row);
  }

  /**
   * 投稿した回を記録する。active で fire_seq が expectedSeq のときだけ（投稿の間に止められたら false）、next_at・status・最後の投稿を書き換え、snooze_at を消し、fire_seq を 1 増やす。
   * 書き換えたら true
   */
  markFired(id: number, expectedSeq: number, update: FireUpdate & { messageId: string }): boolean {
    const result = this.db
      .prepare(
        `UPDATE reminders SET next_at = ?, snooze_at = NULL, status = ?, fire_seq = fire_seq + 1,
          last_fired_at = ?, last_message_id = ?, updated_at = ? WHERE id = ? AND fire_seq = ? AND status = 'active'`,
      )
      .run(
        update.nextAt === null ? null : update.nextAt.toISOString(),
        update.status,
        update.firedAt.toISOString(),
        update.messageId,
        this.now().toISOString(),
        id,
        expectedSeq,
      );
    return Number(result.changes) > 0;
  }

  /** prompt の回を動かす前に進める。markFired と同じ compare-and-set で、最後の投稿（last_message_id）は変えない */
  claim(id: number, expectedSeq: number, update: FireUpdate): boolean {
    const result = this.db
      .prepare(
        `UPDATE reminders SET next_at = ?, snooze_at = NULL, status = ?, fire_seq = fire_seq + 1,
          last_fired_at = ?, updated_at = ? WHERE id = ? AND fire_seq = ? AND status = 'active'`,
      )
      .run(
        update.nextAt === null ? null : update.nextAt.toISOString(),
        update.status,
        update.firedAt.toISOString(),
        this.now().toISOString(),
        id,
        expectedSeq,
      );
    return Number(result.changes) > 0;
  }

  /**
   * at にもう一度知らせる。active・fired のときだけ（fired は active に戻す）。
   * expectedSeq を渡せば fire_seq が一致するときだけ（ボタンの古さの判定）。書き換えたら true
   */
  snooze(id: number, at: Date, expectedSeq?: number): boolean {
    return this.changedWithSeq(
      "UPDATE reminders SET snooze_at = ?, status = 'active', updated_at = ? WHERE id = ? AND status IN ('active', 'fired')",
      expectedSeq,
      at.toISOString(),
      this.now().toISOString(),
      id,
    );
  }

  /** 1 回だけ（rule が NULL）のものを done にする。active・fired のときだけ。expectedSeq は snooze と同じ。書き換えたら true */
  complete(id: number, expectedSeq?: number): boolean {
    return this.changedWithSeq(
      "UPDATE reminders SET status = 'done', updated_at = ? WHERE id = ? AND status IN ('active', 'fired') AND rule IS NULL",
      expectedSeq,
      this.now().toISOString(),
      id,
    );
  }

  /** 繰り返しの回を済ませる（[済んだ]）。active の繰り返しの snooze_at を消すだけ。expectedSeq は snooze と同じ。書き換えたら true */
  clearSnooze(id: number, expectedSeq?: number): boolean {
    return this.changedWithSeq(
      "UPDATE reminders SET snooze_at = NULL, updated_at = ? WHERE id = ? AND status = 'active' AND rule IS NOT NULL",
      expectedSeq,
      this.now().toISOString(),
      id,
    );
  }

  /** cancelled にする。active のときだけ。expectedSeq は snooze と同じ。書き換えたら true */
  cancel(id: number, expectedSeq?: number): boolean {
    return this.changedWithSeq(
      "UPDATE reminders SET status = 'cancelled', updated_at = ? WHERE id = ? AND status = 'active'",
      expectedSeq,
      this.now().toISOString(),
      id,
    );
  }

  /** 繰り返しの次の回を nextAt にする（呼び出し側が今の next_at の次の回を求めて渡す）。active の繰り返しのときだけ。書き換えたら true */
  skipNext(id: number, nextAt: Date): boolean {
    return this.changed(
      "UPDATE reminders SET next_at = ?, updated_at = ? WHERE id = ? AND status = 'active' AND rule IS NOT NULL",
      nextAt.toISOString(),
      this.now().toISOString(),
      id,
    );
  }

  /** 投稿するチャンネルを変える。書き換えたら true */
  moveChannel(id: number, channelId: string): boolean {
    return this.changed(
      "UPDATE reminders SET channel_id = ?, updated_at = ? WHERE id = ?",
      channelId,
      this.now().toISOString(),
      id,
    );
  }

  /** タスクごとの、紐づけた active のうち次に知らせる時刻（next_at と snooze_at の早い方）。無いタスクは含めない */
  nextForTasks(taskIds: readonly number[]): Map<number, string> {
    const result = new Map<number, string>();
    if (taskIds.length === 0) return result;
    const placeholders = taskIds.map(() => "?").join(", ");
    const rows = this.db
      .prepare(
        `SELECT task_id, MIN(${EARLIEST_AT}) AS at FROM reminders
          WHERE status = 'active' AND task_id IN (${placeholders}) GROUP BY task_id`,
      )
      .all(...taskIds);
    for (const row of rows) {
      if (row.at !== null && row.at !== undefined) result.set(Number(row.task_id), String(row.at));
    }
    return result;
  }

  private changedWithSeq(sql: string, expectedSeq: number | undefined, ...params: Array<string | number>): boolean {
    if (expectedSeq === undefined) return this.changed(sql, ...params);
    return this.changed(`${sql} AND fire_seq = ?`, ...params, expectedSeq);
  }

  private changed(sql: string, ...params: Array<string | number>): boolean {
    return Number(this.db.prepare(sql).run(...params).changes) > 0;
  }
}
