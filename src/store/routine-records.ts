import type { DatabaseSync, SQLInputValue, SQLOutputValue } from "node:sqlite";

/** fields のキーの数の上限 */
export const ROUTINE_RECORD_MAX_FIELDS = 30;
/** fields の JSON の文字数の上限 */
export const ROUTINE_RECORD_FIELDS_MAX_LENGTH = 2000;
/** list の件数の既定と上限 */
export const ROUTINE_RECORD_LIST_DEFAULT_LIMIT = 30;
export const ROUTINE_RECORD_LIST_MAX_LIMIT = 100;

/** void は取り消した記録（削除の代わり。active に戻せる） */
export type RoutineRecordStatus = "active" | "void";

/** 記録の項目。名前は手順で決め、値は文字列か数 */
export type RecordFields = Record<string, string | number>;

/** 定型チャンネルの記録（routine_records） */
export type RoutineRecord = {
  id: number;
  channelId: string;
  /** YYYY-MM-DD。無ければ null */
  date: string | null;
  fields: RecordFields;
  status: RoutineRecordStatus;
  createdAt: string;
  updatedAt: string;
};

export type NewRoutineRecord = {
  channelId: string;
  /** YYYY-MM-DD（形は呼び出し側が確かめる） */
  date?: string | null;
  fields: RecordFields;
};

/** update で変える項目。省略した項目は変えない。date の null は日付を外し、fields は指定したキーだけ変える（null はそのキーを消す） */
export type RecordChanges = {
  date?: string | null;
  fields?: Record<string, string | number | null>;
  status?: RoutineRecordStatus;
};

export type RecordListOptions = {
  /** この日以降（YYYY-MM-DD）。指定したら日付の無い記録は除く */
  dateFrom?: string;
  /** この日以前（YYYY-MM-DD）。指定したら日付の無い記録は除く */
  dateTo?: string;
  /** fields の値（数は文字列にして）の部分一致。英字の大文字・小文字は区別しない */
  query?: string;
  /** 既定は active */
  status?: RoutineRecordStatus;
  /** 合計する項目の名前。値が数の記録だけを足す */
  sum?: string;
  /** 既定 ROUTINE_RECORD_LIST_DEFAULT_LIMIT、1〜ROUTINE_RECORD_LIST_MAX_LIMIT に収める */
  limit?: number;
};

export type RecordListResult = {
  /** 新しい日付の順（日付の無いものは後ろ）、同じなら新しい id の順に、先頭から limit 件（絞らなければ直近の limit 件） */
  records: RoutineRecord[];
  /** 条件に合う件数（limit で切る前） */
  count: number;
  /** sum を指定したときだけ。条件に合うすべて（limit で切る前）の合計 */
  total?: number;
};

export type AddRecordResult = { result: "added"; record: RoutineRecord } | { result: "invalid_fields"; message: string };

export type UpdateRecordResult =
  | { result: "updated"; before: RoutineRecord; after: RoutineRecord }
  | { result: "no_change"; record: RoutineRecord }
  | { result: "not_found" }
  | { result: "invalid_fields"; message: string };

/** fields が保存できる形か。できなければ理由（モデルに返す文）、できれば null */
export function validateRecordFields(fields: unknown): string | null {
  if (typeof fields !== "object" || fields === null || Array.isArray(fields)) return "fields はオブジェクトにしてください";
  const entries = Object.entries(fields);
  if (entries.length > ROUTINE_RECORD_MAX_FIELDS) return `fields のキーは ${ROUTINE_RECORD_MAX_FIELDS} 個までです`;
  for (const [key, value] of entries) {
    if (key.trim() === "") return "fields のキーを空にはできません";
    const ok = typeof value === "string" || (typeof value === "number" && Number.isFinite(value));
    if (!ok) return "fields の値は文字列か数にしてください";
  }
  if ([...JSON.stringify(fields)].length > ROUTINE_RECORD_FIELDS_MAX_LENGTH) {
    return `fields は JSON で ${ROUTINE_RECORD_FIELDS_MAX_LENGTH} 字までです`;
  }
  return null;
}

function nullableString(value: SQLOutputValue | undefined): string | null {
  return value === null || value === undefined ? null : String(value);
}

function toRecord(row: Record<string, SQLOutputValue>): RoutineRecord {
  return {
    id: Number(row.id),
    channelId: String(row.channel_id),
    date: nullableString(row.date),
    fields: JSON.parse(String(row.fields)) as RecordFields,
    status: row.status === "void" ? "void" : "active",
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

/** キーの順を問わず同じ項目・同じ値か */
function sameFields(a: RecordFields, b: RecordFields): boolean {
  const keys = Object.keys(a);
  return keys.length === Object.keys(b).length && keys.every((key) => Object.hasOwn(b, key) && a[key] === b[key]);
}

/** LIKE の % _ \ を文字として扱う */
function escapeLike(text: string): string {
  return text.replace(/[\\%_]/g, (char) => `\\${char}`);
}

/** 定型チャンネルの記録。物理削除はしない（void にする）。操作はチャンネルの中に閉じる（ほかのチャンネルの id は not_found） */
export class RoutineRecordStore {
  private readonly db: DatabaseSync;
  private readonly now: () => Date;

  constructor(db: DatabaseSync, now: () => Date = () => new Date()) {
    this.db = db;
    this.now = now;
  }

  add(record: NewRoutineRecord): AddRecordResult {
    const message = validateRecordFields(record.fields);
    if (message !== null) return { result: "invalid_fields", message };
    const at = this.now().toISOString();
    const row = this.db
      .prepare(
        "INSERT INTO routine_records (channel_id, date, fields, status, created_at, updated_at) VALUES (?, ?, ?, 'active', ?, ?) RETURNING *",
      )
      .get(record.channelId, record.date ?? null, JSON.stringify(record.fields), at, at);
    return { result: "added", record: toRecord(row!) };
  }

  /** そのチャンネルの記録（void も返す） */
  get(channelId: string, id: number): RoutineRecord | undefined {
    const row = this.db.prepare("SELECT * FROM routine_records WHERE id = ? AND channel_id = ?").get(id, channelId);
    return row === undefined ? undefined : toRecord(row);
  }

  /** そのチャンネルの記録を条件で絞る。件数と合計はアプリが数える（limit で切る前のすべて） */
  list(channelId: string, options: RecordListOptions = {}): RecordListResult {
    const conditions = ["channel_id = ?", "status = ?"];
    const params: SQLInputValue[] = [channelId, options.status ?? "active"];
    if (options.dateFrom !== undefined) {
      conditions.push("date IS NOT NULL AND date >= ?");
      params.push(options.dateFrom);
    }
    if (options.dateTo !== undefined) {
      conditions.push("date IS NOT NULL AND date <= ?");
      params.push(options.dateTo);
    }
    if (options.query !== undefined && options.query !== "") {
      conditions.push(
        "EXISTS (SELECT 1 FROM json_each(routine_records.fields) WHERE CAST(json_each.value AS TEXT) LIKE ? ESCAPE '\\')",
      );
      params.push(`%${escapeLike(options.query)}%`);
    }
    const all = this.db
      .prepare(`SELECT * FROM routine_records WHERE ${conditions.join(" AND ")} ORDER BY date IS NULL, date DESC, id DESC`)
      .all(...params)
      .map(toRecord);
    const limit = Math.min(
      Math.max(Math.trunc(options.limit ?? ROUTINE_RECORD_LIST_DEFAULT_LIMIT), 1),
      ROUTINE_RECORD_LIST_MAX_LIMIT,
    );
    const result: RecordListResult = { records: all.slice(0, limit), count: all.length };
    if (options.sum !== undefined) {
      const key = options.sum;
      result.total = all.reduce((total, record) => {
        const value = Object.hasOwn(record.fields, key) ? record.fields[key] : undefined;
        return typeof value === "number" ? total + value : total;
      }, 0);
    }
    return result;
  }

  /** 変える項目だけ変える。変えた後の fields が保存できない形なら何も変えずに invalid_fields */
  update(channelId: string, id: number, changes: RecordChanges): UpdateRecordResult {
    const before = this.get(channelId, id);
    if (before === undefined) return { result: "not_found" };
    const fields: RecordFields = { ...before.fields };
    for (const [key, value] of Object.entries(changes.fields ?? {})) {
      if (value === null) delete fields[key];
      else fields[key] = value;
    }
    const message = validateRecordFields(fields);
    if (message !== null) return { result: "invalid_fields", message };
    const date = changes.date === undefined ? before.date : changes.date;
    const status = changes.status ?? before.status;
    if (date === before.date && status === before.status && sameFields(fields, before.fields)) {
      return { result: "no_change", record: before };
    }
    const row = this.db
      .prepare("UPDATE routine_records SET date = ?, fields = ?, status = ?, updated_at = ? WHERE id = ? AND channel_id = ? RETURNING *")
      .get(date, JSON.stringify(fields), status, this.now().toISOString(), id, channelId);
    return { result: "updated", before, after: toRecord(row!) };
  }

  /** void にする（update の status: void と同じ） */
  markVoid(channelId: string, id: number): UpdateRecordResult {
    return this.update(channelId, id, { status: "void" });
  }

  /** active に戻す（update の status: active と同じ） */
  restore(channelId: string, id: number): UpdateRecordResult {
    return this.update(channelId, id, { status: "active" });
  }
}
