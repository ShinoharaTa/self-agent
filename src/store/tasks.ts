import type { DatabaseSync, SQLOutputValue } from "node:sqlite";

/** dropped はやめたタスク（削除の代わり。open に戻せる） */
export type TaskStatus = "open" | "done" | "dropped";

export type Task = {
  id: number;
  title: string;
  /** YYYY-MM-DD。期限なしは null */
  due: string | null;
  status: TaskStatus;
  createdAt: string;
  completedAt: string | null;
  sourceMessageId: string | null;
};

export type NewTask = {
  title: string;
  due?: string;
  sourceMessageId?: string;
};

export type CompleteResult =
  | { result: "completed"; task: Task }
  | { result: "already_done"; task: Task }
  | { result: "not_found" };

/** update で変える項目。省略した項目は変えない。due の null は期限を外す */
export type TaskChanges = {
  title?: string;
  due?: string | null;
  status?: TaskStatus;
};

export type UpdateResult =
  | { result: "updated"; before: Task; after: Task }
  | { result: "no_change"; task: Task }
  | { result: "not_found" };

function nullableString(value: SQLOutputValue | undefined): string | null {
  return value === null || value === undefined ? null : String(value);
}

function toTask(row: Record<string, SQLOutputValue>): Task {
  return {
    id: Number(row.id),
    title: String(row.title),
    due: nullableString(row.due),
    status: row.status === "done" || row.status === "dropped" ? row.status : "open",
    createdAt: String(row.created_at),
    completedAt: nullableString(row.completed_at),
    sourceMessageId: nullableString(row.source_message_id),
  };
}

export class TaskStore {
  private readonly db: DatabaseSync;
  private readonly now: () => Date;

  constructor(db: DatabaseSync, now: () => Date = () => new Date()) {
    this.db = db;
    this.now = now;
  }

  add(task: NewTask): Task {
    const row = this.db
      .prepare(
        "INSERT INTO tasks (title, due, status, created_at, source_message_id) VALUES (?, ?, 'open', ?, ?) RETURNING *",
      )
      .get(task.title, task.due ?? null, this.now().toISOString(), task.sourceMessageId ?? null);
    return toTask(row!);
  }

  get(id: number): Task | undefined {
    const row = this.db.prepare("SELECT * FROM tasks WHERE id = ?").get(id);
    return row === undefined ? undefined : toTask(row);
  }

  /**
   * open は期限の昇順（期限なしは後ろ）、同じ期限なら登録順。done・dropped は閉じた時刻の新しい順。
   * dueBy（YYYY-MM-DD）があれば期限がその日以前のものだけ（期限なしは除く）
   */
  list(options: { status: TaskStatus; limit: number; dueBy?: string }): Task[] {
    const orderBy = options.status === "open" ? "due IS NULL, due, id" : "completed_at DESC, id DESC";
    if (options.dueBy !== undefined) {
      return this.db
        .prepare(`SELECT * FROM tasks WHERE status = ? AND due IS NOT NULL AND due <= ? ORDER BY ${orderBy} LIMIT ?`)
        .all(options.status, options.dueBy, options.limit)
        .map(toTask);
    }
    return this.db
      .prepare(`SELECT * FROM tasks WHERE status = ? ORDER BY ${orderBy} LIMIT ?`)
      .all(options.status, options.limit)
      .map(toTask);
  }

  complete(id: number): CompleteResult {
    const task = this.get(id);
    if (task === undefined) return { result: "not_found" };
    if (task.status === "done") return { result: "already_done", task };
    const row = this.db
      .prepare("UPDATE tasks SET status = 'done', completed_at = ? WHERE id = ? RETURNING *")
      .get(this.now().toISOString(), id);
    return { result: "completed", task: toTask(row!) };
  }

  /**
   * 題名・期限・状態を変える。今と同じ値は変更に数えず、変わる項目が無ければ no_change。
   * 状態が done・dropped に変わったら completed_at を今に、open に戻ったら null にする
   */
  update(id: number, changes: TaskChanges): UpdateResult {
    const before = this.get(id);
    if (before === undefined) return { result: "not_found" };
    const title = changes.title ?? before.title;
    const due = changes.due === undefined ? before.due : changes.due;
    const status = changes.status ?? before.status;
    if (title === before.title && due === before.due && status === before.status) {
      return { result: "no_change", task: before };
    }
    const completedAt =
      status === before.status ? before.completedAt : status === "open" ? null : this.now().toISOString();
    const row = this.db
      .prepare("UPDATE tasks SET title = ?, due = ?, status = ?, completed_at = ? WHERE id = ? RETURNING *")
      .get(title, due, status, completedAt, id);
    return { result: "updated", before, after: toTask(row!) };
  }
}
