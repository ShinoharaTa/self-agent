// 進行状況に登録したプロジェクト（board_projects。v42。docs/plan/project-board.md §4 PS1）。物理削除はしない（外すのは removed_at）
import type { DatabaseSync, SQLOutputValue } from "node:sqlite";
import { BOARD_STATES, type BoardCapped, type BoardCi, type BoardItem, type BoardLocal, type BoardState, NOT_CAPPED } from "../board/classify.ts";

/** 生きている（外していない）プロジェクトの上限 */
export const BOARD_MAX_PROJECTS = 30;
/** items に残す件数の上限（PR 30 件と issue 50 件をすべて残す） */
export const BOARD_MAX_ITEMS = 80;

/** 収集の失敗の種類 */
export type BoardError = "no_remote" | "git_failed" | "github_failed" | "rate_limited" | "not_found";

const BOARD_ERRORS: readonly BoardError[] = ["no_remote", "git_failed", "github_failed", "rate_limited", "not_found"];
const CI_VALUES: readonly BoardCi[] = ["success", "failure", "pending", "none", "unchecked"];

export type BoardProjectRow = {
  /** SELF_AGENT_WORKSPACE_DIR の直下の名前 */
  dir: string;
  /** `owner/repo`（小文字）。remote が無ければ null */
  repo: string | null;
  addedAt: string;
  removedAt: string | null;
  state: BoardState | null;
  reasons: string[] | null;
  items: BoardItem[] | null;
  /** items が 1 ページの上限に当たったか（無ければ当たっていない） */
  capped: BoardCapped;
  local: BoardLocal | null;
  checkedAt: string | null;
  error: BoardError | null;
};

export type BoardAddResult = "added" | "reopened" | "exists" | "limit";

/** 1 回の収集の結果。undefined の項目は変えない（rate_limited のときの items など） */
export type BoardResult = {
  repo: string | null;
  state: BoardState;
  reasons: readonly string[];
  items?: readonly BoardItem[] | null;
  /** items と一緒に書く（items を書かないときは前のまま） */
  capped?: BoardCapped;
  local?: BoardLocal | null;
  error: BoardError | null;
  checkedAt: string;
};

function nullableString(value: SQLOutputValue | undefined): string | null {
  return value === null || value === undefined ? null : String(value);
}

function parseJson(value: SQLOutputValue | undefined): unknown {
  if (typeof value !== "string") return undefined;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return undefined;
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseItems(value: SQLOutputValue | undefined): BoardItem[] | null {
  const parsed = parseJson(value);
  if (!Array.isArray(parsed)) return null;
  const items: BoardItem[] = [];
  for (const item of parsed) {
    if (!isObject(item)) continue;
    const { kind, number, title, url, mine, draft, ci } = item;
    if ((kind !== "pr" && kind !== "issue") || typeof number !== "number" || !Number.isSafeInteger(number)) continue;
    if (typeof title !== "string" || typeof url !== "string" || typeof mine !== "boolean" || typeof draft !== "boolean") continue;
    const foundCi = CI_VALUES.find((candidate) => candidate === ci);
    if (foundCi === undefined) continue;
    items.push({ kind, number, title, url, mine, draft, ci: foundCi });
  }
  return items;
}

function parseLocal(value: SQLOutputValue | undefined): BoardLocal | null {
  const parsed = parseJson(value);
  if (!isObject(parsed)) return null;
  const { branch, dirty, ahead, behind, lastCommitAt } = parsed;
  const count = (n: unknown): n is number => typeof n === "number" && Number.isSafeInteger(n) && n >= 0;
  if ((branch !== null && typeof branch !== "string") || !count(dirty) || !count(ahead) || !count(behind)) return null;
  if (lastCommitAt !== null && typeof lastCommitAt !== "string") return null;
  return { branch, dirty, ahead, behind, lastCommitAt };
}

function parseCapped(value: SQLOutputValue | undefined): BoardCapped {
  const parsed = parseJson(value);
  if (!isObject(parsed)) return NOT_CAPPED;
  return { pulls: parsed.pulls === true, issues: parsed.issues === true };
}

function parseReasons(value: SQLOutputValue | undefined): string[] | null {
  const parsed = parseJson(value);
  return Array.isArray(parsed) ? parsed.filter((line): line is string => typeof line === "string") : null;
}

function toRow(row: Record<string, SQLOutputValue>): BoardProjectRow {
  return {
    dir: String(row.dir),
    repo: nullableString(row.repo),
    addedAt: String(row.added_at),
    removedAt: nullableString(row.removed_at),
    state: BOARD_STATES.find((state) => state === row.state) ?? null,
    reasons: parseReasons(row.reasons),
    items: parseItems(row.items),
    capped: parseCapped(row.capped),
    local: parseLocal(row.local),
    checkedAt: nullableString(row.checked_at),
    error: BOARD_ERRORS.find((error) => error === row.error) ?? null,
  };
}

export class BoardStore {
  private readonly db: DatabaseSync;
  private readonly now: () => Date;

  constructor(db: DatabaseSync, now: () => Date = () => new Date()) {
    this.db = db;
    this.now = now;
  }

  /** 登録する。外したものは開き直す（removed_at を NULL に、added_at を今に）。生きている数が BOARD_MAX_PROJECTS なら limit */
  add(dir: string, repo: string | null): BoardAddResult {
    const existing = this.get(dir);
    if (existing !== undefined && existing.removedAt === null) return "exists";
    if (this.countActive() >= BOARD_MAX_PROJECTS) return "limit";
    const at = this.now().toISOString();
    if (existing !== undefined) {
      this.db.prepare("UPDATE board_projects SET removed_at = NULL, added_at = ?, repo = ? WHERE dir = ?").run(at, repo, dir);
      return "reopened";
    }
    this.db.prepare("INSERT INTO board_projects (dir, repo, added_at) VALUES (?, ?, ?)").run(dir, repo, at);
    return "added";
  }

  /** 外す。生きている行が無ければ false */
  remove(dir: string): boolean {
    const result = this.db
      .prepare("UPDATE board_projects SET removed_at = ? WHERE dir = ? AND removed_at IS NULL")
      .run(this.now().toISOString(), dir);
    return Number(result.changes) > 0;
  }

  countActive(): number {
    return Number(this.db.prepare("SELECT COUNT(*) AS n FROM board_projects WHERE removed_at IS NULL").get()?.n ?? 0);
  }

  /** 生きているものを dir の順に */
  listActive(): BoardProjectRow[] {
    return this.db.prepare("SELECT * FROM board_projects WHERE removed_at IS NULL ORDER BY dir").all().map(toRow);
  }

  get(dir: string): BoardProjectRow | undefined {
    const row = this.db.prepare("SELECT * FROM board_projects WHERE dir = ?").get(dir);
    return row === undefined ? undefined : toRow(row);
  }

  /** 収集の結果を書く（生きている行だけ）。items は BOARD_MAX_ITEMS 件まで、reasons は 8 件まで。行が無ければ false */
  saveResult(dir: string, result: BoardResult): boolean {
    const sets = ["repo = ?", "state = ?", "reasons = ?", "error = ?", "checked_at = ?"];
    const values: (string | null)[] = [result.repo, result.state, JSON.stringify(result.reasons.slice(0, 8)), result.error, result.checkedAt];
    if (result.items !== undefined) {
      sets.push("items = ?");
      values.push(result.items === null ? null : JSON.stringify(result.items.slice(0, BOARD_MAX_ITEMS)));
      sets.push("capped = ?");
      values.push(JSON.stringify(result.items === null ? NOT_CAPPED : (result.capped ?? NOT_CAPPED)));
    }
    if (result.local !== undefined) {
      sets.push("local = ?");
      values.push(result.local === null ? null : JSON.stringify(result.local));
    }
    const changes = this.db
      .prepare(`UPDATE board_projects SET ${sets.join(", ")} WHERE dir = ? AND removed_at IS NULL`)
      .run(...values, dir).changes;
    return Number(changes) > 0;
  }
}
