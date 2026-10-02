import type { DatabaseSync, SQLOutputValue } from "node:sqlite";

export type TaskStatus = "open" | "done";

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

function nullableString(value: SQLOutputValue | undefined): string | null {
  return value === null || value === undefined ? null : String(value);
}

function toTask(row: Record<string, SQLOutputValue>): Task {
  return {
    id: Number(row.id),
    title: String(row.title),
    due: nullableString(row.due),
    status: row.status === "done" ? "done" : "open",
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

  /** 期限の昇順（期限なしは後ろ）、同じ期限なら登録順 */
  list(options: { status: TaskStatus; limit: number }): Task[] {
    return this.db
      .prepare("SELECT * FROM tasks WHERE status = ? ORDER BY due IS NULL, due, id LIMIT ?")
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
}
