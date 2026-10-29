import type { DatabaseSync, SQLOutputValue } from "node:sqlite";
import { clip } from "../app/summary.ts";
import { DEFAULT_PERSONA_ID } from "../config.ts";

/** 行の種類。owner はオーナーの発言（予約した依頼の本文を含む）、agent は返事、notice は知らせ、divider は会話の区切り（/renew・切り替え・/close） */
export type HistoryKind = "owner" | "agent" | "notice" | "divider";
/** どこから来たか。system はアプリが行ったもの（予約した依頼・切り替え・待ちへの移動など） */
export type HistorySource = "discord" | "web" | "system";
/** agent の行のターンの終わり方 */
export type HistoryOutcome = "done" | "max_turns" | "aborted" | "failed";

/** Web UI で会話を見るためのターンの記録（history。docs/plan/web-ui.md §4.2） */
export type HistoryRow = {
  id: number;
  guildId: string;
  channelId: string;
  /** 書いた時刻（ISO） */
  at: string;
  kind: HistoryKind;
  source: HistorySource;
  /** チャンネルの持ち主の人格 */
  persona: string;
  /** 本文（先頭 HISTORY_TEXT_MAX_LENGTH 字） */
  text: string;
  /** agent の行だけ */
  outcome: HistoryOutcome | null;
  /** 手順の label（先頭 HISTORY_STEPS_MAX 件と、それより多ければ「（ほか n 手順）」）。無ければ null */
  steps: string[] | null;
  toolCalls: number | null;
  durationMs: number | null;
  /** Discord の発言の ID（オーナーの発言だけ） */
  messageId: string | null;
};

/** 足す行。persona の省略は既定の人格、それ以外の省略は null */
export type NewHistoryRow = {
  guildId: string;
  channelId: string;
  kind: HistoryKind;
  source: HistorySource;
  persona?: string;
  text: string;
  outcome?: HistoryOutcome | null;
  steps?: readonly string[] | null;
  toolCalls?: number | null;
  durationMs?: number | null;
  messageId?: string | null;
};

/** text を切る字数（返事の全文は Discord にある） */
export const HISTORY_TEXT_MAX_LENGTH = 4000;
/** steps に残す手順の数（それより多ければ「（ほか n 手順）」を 1 つ足す） */
export const HISTORY_STEPS_MAX = 50;
/** list で一度に取れる行の数の上限 */
export const HISTORY_LIST_MAX = 200;

const KINDS: readonly HistoryKind[] = ["owner", "agent", "notice", "divider"];
const SOURCES: readonly HistorySource[] = ["discord", "web", "system"];
const OUTCOMES: readonly HistoryOutcome[] = ["done", "max_turns", "aborted", "failed"];

function pick<T extends string>(values: readonly T[], value: SQLOutputValue | undefined, column: string): T {
  const found = values.find((candidate) => candidate === value);
  if (found === undefined) throw new Error(`history.${column} が不正です: ${String(value)}`);
  return found;
}

function nullableString(value: SQLOutputValue | undefined): string | null {
  return value === null || value === undefined ? null : String(value);
}

function nullableNumber(value: SQLOutputValue | undefined): number | null {
  return value === null || value === undefined ? null : Number(value);
}

function parseSteps(value: SQLOutputValue | undefined): string[] | null {
  if (value === null || value === undefined) return null;
  const parsed: unknown = JSON.parse(String(value));
  return Array.isArray(parsed) ? parsed.map(String) : null;
}

function toRow(row: Record<string, SQLOutputValue>): HistoryRow {
  return {
    id: Number(row.id),
    guildId: String(row.guild_id),
    channelId: String(row.channel_id),
    at: String(row.at),
    kind: pick(KINDS, row.kind, "kind"),
    source: pick(SOURCES, row.source, "source"),
    persona: String(row.persona),
    text: String(row.text),
    outcome: row.outcome === null || row.outcome === undefined ? null : pick(OUTCOMES, row.outcome, "outcome"),
    steps: parseSteps(row.steps),
    toolCalls: nullableNumber(row.tool_calls),
    durationMs: nullableNumber(row.duration_ms),
    messageId: nullableString(row.message_id),
  };
}

/** 保存する steps（先頭 HISTORY_STEPS_MAX 件 + 残りがあれば「（ほか n 手順）」）の JSON */
function stepsJson(steps: readonly string[] | null | undefined): string | null {
  if (steps === null || steps === undefined) return null;
  const kept = steps.slice(0, HISTORY_STEPS_MAX);
  if (steps.length > HISTORY_STEPS_MAX) kept.push(`（ほか ${steps.length - HISTORY_STEPS_MAX} 手順）`);
  return JSON.stringify(kept);
}

/** ターンの記録。物理削除は prune（日数）だけ */
export class HistoryStore {
  private readonly db: DatabaseSync;
  private readonly now: () => Date;

  constructor(db: DatabaseSync, now: () => Date = () => new Date()) {
    this.db = db;
    this.now = now;
  }

  /** 1 行足して id を返す。text は先頭 HISTORY_TEXT_MAX_LENGTH 字に切る */
  add(row: NewHistoryRow): number {
    const result = this.db
      .prepare(
        "INSERT INTO history (guild_id, channel_id, at, kind, source, persona, text, outcome, steps, tool_calls, duration_ms, message_id) " +
          "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id",
      )
      .get(
        row.guildId,
        row.channelId,
        this.now().toISOString(),
        row.kind,
        row.source,
        row.persona ?? DEFAULT_PERSONA_ID,
        clip(row.text, HISTORY_TEXT_MAX_LENGTH),
        row.outcome ?? null,
        stepsJson(row.steps),
        row.toolCalls ?? null,
        row.durationMs ?? null,
        row.messageId ?? null,
      );
    return Number(result?.id);
  }

  /**
   * そのチャンネルの行を古い順に。before があればその id より前の limit 件（新しい側から）、after があればその id より後の limit 件（古い側から）、
   * どちらも無ければ最新の limit 件。limit が 1〜HISTORY_LIST_MAX の整数でない・before と after の両方があれば RangeError
   */
  list(channelId: string, options: { before?: number; after?: number; limit: number }): HistoryRow[] {
    const { before, after, limit } = options;
    if (!Number.isInteger(limit) || limit < 1 || limit > HISTORY_LIST_MAX) {
      throw new RangeError(`limit は 1〜${HISTORY_LIST_MAX} の整数にしてください`);
    }
    if (before !== undefined && after !== undefined) throw new RangeError("before と after は同時に指定できません");
    if (after !== undefined) {
      return this.db
        .prepare("SELECT * FROM history WHERE channel_id = ? AND id > ? ORDER BY id LIMIT ?")
        .all(channelId, after, limit)
        .map(toRow);
    }
    const rows =
      before === undefined
        ? this.db.prepare("SELECT * FROM history WHERE channel_id = ? ORDER BY id DESC LIMIT ?").all(channelId, limit)
        : this.db
            .prepare("SELECT * FROM history WHERE channel_id = ? AND id < ? ORDER BY id DESC LIMIT ?")
            .all(channelId, before, limit);
    return rows.map(toRow).reverse();
  }

  /** そのサーバーのチャンネルごとの最後の行（key は channelId） */
  latestByChannel(guildId: string): Map<string, { id: number; at: string; kind: HistoryKind }> {
    const rows = this.db
      .prepare(
        "SELECT h.channel_id, h.id, h.at, h.kind FROM history h " +
          "JOIN (SELECT channel_id, MAX(id) AS id FROM history WHERE guild_id = ? GROUP BY channel_id) m ON h.id = m.id",
      )
      .all(guildId);
    return new Map(
      rows.map((row) => [String(row.channel_id), { id: Number(row.id), at: String(row.at), kind: pick(KINDS, row.kind, "kind") }]),
    );
  }

  /** cutoff より前に書いた行を消し、消した数を返す */
  prune(cutoff: Date): number {
    const result = this.db.prepare("DELETE FROM history WHERE at < ?").run(cutoff.toISOString());
    return Number(result.changes);
  }
}

/**
 * history に 1 行書く（history が無ければ何もしない）。失敗は log に出すだけでターンは止めない（本文は出さない）。
 * 書けたら id を返す
 */
export function recordHistory(
  history: Pick<HistoryStore, "add"> | undefined,
  row: NewHistoryRow,
  log: (message: string) => void,
): number | undefined {
  if (history === undefined) return undefined;
  try {
    return history.add(row);
  } catch (error) {
    log(`履歴の書き込みに失敗しました（${row.kind}）: ${error instanceof Error ? error.message : String(error)}`);
    return undefined;
  }
}
