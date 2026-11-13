import type { DatabaseSync, SQLOutputValue } from "node:sqlite";
import type { TakeoverFailure } from "../cc/takeover-rules.ts";

/**
 * 取り込みの状態（docs/plan/takeover.md §4）。awaiting_confirm = 確認待ち、running = [取り込む] を受けた（step が今の位置）、
 * done = 取り込んだ、failed = 取り込めなかった（failure が符号）、cancelled = [やめる]・10 分の放置
 */
export type CcTakeoverState = "awaiting_confirm" | "running" | "done" | "failed" | "cancelled";

/** running の間の位置（§4） */
export type CcTakeoverStep = "check" | "term" | "copy" | "commit";

/** alive = 一覧にある（待機の）セッション、ended = 終わった（一覧に無い）セッション */
export type CcTakeoverSource = "alive" | "ended";

export type CcTakeoverEntry = "discord" | "web";

/** 取り込んだセッションの許可のモード（§3.6。mapTakeoverMode の結果） */
export type CcTakeoverMode = "default" | "acceptEdits" | "plan";

const STATES: readonly CcTakeoverState[] = ["awaiting_confirm", "running", "done", "failed", "cancelled"];
const STEPS: readonly CcTakeoverStep[] = ["check", "term", "copy", "commit"];
const SOURCES: readonly CcTakeoverSource[] = ["alive", "ended"];
const ENTRIES: readonly CcTakeoverEntry[] = ["discord", "web"];
const MODES: readonly CcTakeoverMode[] = ["default", "acceptEdits", "plan"];

/** cc_takeovers の 1 行（時刻は ISO） */
export type CcTakeoverRow = {
  id: number;
  sessionId: string;
  source: CcTakeoverSource;
  /** SELF_AGENT_WORKSPACE_DIR の直下の名前 */
  project: string;
  guildId: string;
  /** 取り込み先のチャンネル（cc-<名前>） */
  channelId: string;
  entry: CcTakeoverEntry;
  state: CcTakeoverState;
  step: CcTakeoverStep | null;
  /** failed の符号（takeover-rules.ts の TakeoverFailure。読むときは文字列のまま） */
  failure: string | null;
  permissionMode: CcTakeoverMode;
  /** 端末のときの許可のモード（cc_sessions.permission_mode。確認の文に出す） */
  terminalMode: string | null;
  /** 終わらせる直前に端末で動きがあった */
  interrupted: boolean;
  /** 最初のターンの前置き（TAKEOVER_NOTE）をまだ付けていない */
  notePending: boolean;
  /** 取り込みの間に ended の知らせを差し止めた（§3.2。失敗したら流し直す印） */
  endedHeld: boolean;
  confirmMessageId: string | null;
  /** 後始末（進行中へ移す・topic など）を済ませた時刻 */
  effectsAt: string | null;
  createdAt: string;
  updatedAt: string;
  finishedAt: string | null;
};

export type CcTakeoverPropose = {
  sessionId: string;
  source: CcTakeoverSource;
  project: string;
  guildId: string;
  channelId: string;
  entry: CcTakeoverEntry;
  permissionMode: CcTakeoverMode;
  terminalMode?: string | null;
};

function nullableString(value: SQLOutputValue | undefined): string | null {
  return value === null || value === undefined ? null : String(value);
}

function toRow(row: Record<string, SQLOutputValue>): CcTakeoverRow {
  const state = STATES.find((value) => value === row.state);
  const source = SOURCES.find((value) => value === row.source);
  const entry = ENTRIES.find((value) => value === row.entry);
  const permissionMode = MODES.find((value) => value === row.permission_mode);
  const step = row.step === null || row.step === undefined ? null : STEPS.find((value) => value === row.step);
  if (state === undefined || source === undefined || entry === undefined || permissionMode === undefined || step === undefined) {
    throw new Error("cc_takeovers の行の形が違います");
  }
  return {
    id: Number(row.id),
    sessionId: String(row.session_id),
    source,
    project: String(row.project),
    guildId: String(row.guild_id),
    channelId: String(row.channel_id),
    entry,
    state,
    step,
    failure: nullableString(row.failure),
    permissionMode,
    terminalMode: nullableString(row.terminal_mode),
    interrupted: Number(row.interrupted) === 1,
    notePending: Number(row.note_pending) === 1,
    endedHeld: Number(row.ended_held) === 1,
    confirmMessageId: nullableString(row.confirm_message_id),
    effectsAt: nullableString(row.effects_at),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
    finishedAt: nullableString(row.finished_at),
  };
}

/** 取り込み（cc_takeovers。docs/plan/takeover.md §4・§5 の T1）。状態の遷移は compare-and-set で、当たらなければ何も変えない。物理削除はしない */
export class CcTakeoverStore {
  private readonly db: DatabaseSync;
  private readonly now: () => Date;

  constructor(db: DatabaseSync, now: () => Date = () => new Date()) {
    this.db = db;
    this.now = now;
  }

  /** 確認待ち（awaiting_confirm）の行を作って返す。同じ session_id に確認待ち・実行中の行があれば作らずに undefined */
  propose(input: CcTakeoverPropose): CcTakeoverRow | undefined {
    const at = this.now().toISOString();
    const row = this.db
      .prepare(
        `INSERT INTO cc_takeovers (session_id, source, project, guild_id, channel_id, entry, state, permission_mode, terminal_mode,
           created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, 'awaiting_confirm', ?, ?, ?, ?)
         ON CONFLICT (session_id) WHERE state IN ('awaiting_confirm','running') DO NOTHING
         RETURNING *`,
      )
      .get(
        input.sessionId,
        input.source,
        input.project,
        input.guildId,
        input.channelId,
        input.entry,
        input.permissionMode,
        input.terminalMode ?? null,
        at,
        at,
      );
    return row === undefined ? undefined : toRow(row);
  }

  get(id: number): CcTakeoverRow | undefined {
    const row = this.db.prepare("SELECT * FROM cc_takeovers WHERE id = ?").get(id);
    return row === undefined ? undefined : toRow(row);
  }

  /** その session_id の確認待ち・実行中の行（あれば 1 つ） */
  activeFor(sessionId: string): CcTakeoverRow | undefined {
    const row = this.db
      .prepare("SELECT * FROM cc_takeovers WHERE session_id = ? AND state IN ('awaiting_confirm', 'running')")
      .get(sessionId);
    return row === undefined ? undefined : toRow(row);
  }

  /** その session_id の実行中の行 */
  runningFor(sessionId: string): CcTakeoverRow | undefined {
    const row = this.db.prepare("SELECT * FROM cc_takeovers WHERE session_id = ? AND state = 'running'").get(sessionId);
    return row === undefined ? undefined : toRow(row);
  }

  /** そのチャンネルの実行中の行 */
  runningForChannel(channelId: string): CcTakeoverRow | undefined {
    const row = this.db.prepare("SELECT * FROM cc_takeovers WHERE channel_id = ? AND state = 'running' ORDER BY id DESC LIMIT 1").get(channelId);
    return row === undefined ? undefined : toRow(row);
  }

  /** 確認待ち → 実行中（[取り込む]）。移したら true */
  start(id: number): boolean {
    return this.move(id, "awaiting_confirm", "running", false);
  }

  /** 実行中の行の位置を書く。実行中でなければ false */
  setStep(id: number, step: CcTakeoverStep): boolean {
    const result = this.db
      .prepare("UPDATE cc_takeovers SET step = ?, updated_at = ? WHERE id = ? AND state = 'running'")
      .run(step, this.now().toISOString(), id);
    return Number(result.changes) > 0;
  }

  /** 終わらせる直前に端末で動きがあった（実行中の行だけ） */
  setInterrupted(id: number): boolean {
    const result = this.db
      .prepare("UPDATE cc_takeovers SET interrupted = 1, updated_at = ? WHERE id = ? AND state = 'running'")
      .run(this.now().toISOString(), id);
    return Number(result.changes) > 0;
  }

  /** 実行中の行の ended の知らせを差し止めた印を立てる（§3.2）。変わったら true */
  hold(id: number): boolean {
    const result = this.db
      .prepare("UPDATE cc_takeovers SET ended_held = 1, updated_at = ? WHERE id = ? AND state = 'running' AND ended_held = 0")
      .run(this.now().toISOString(), id);
    return Number(result.changes) > 0;
  }

  /** failed の行の差し止めた印を外す。1 行変わったときだけ true（流し直しの compare-and-set。running の行・2 回目は false） */
  releaseHeld(id: number): boolean {
    const result = this.db
      .prepare("UPDATE cc_takeovers SET ended_held = 0, updated_at = ? WHERE id = ? AND state = 'failed' AND ended_held = 1")
      .run(this.now().toISOString(), id);
    return Number(result.changes) === 1;
  }

  /** 失敗して ended の知らせを差し止めたままの行を古い順に（流し直す。§3.2） */
  listHeld(): CcTakeoverRow[] {
    return this.db.prepare("SELECT * FROM cc_takeovers WHERE state = 'failed' AND ended_held = 1 ORDER BY id").all().map(toRow);
  }

  /** 実行中 → done（note_pending = 1・ended_held = 0）。移したら true。トランザクションは開かない（呼び出し側の commit の中で呼ぶ） */
  finish(id: number): boolean {
    const at = this.now().toISOString();
    const result = this.db
      .prepare("UPDATE cc_takeovers SET state = 'done', note_pending = 1, ended_held = 0, finished_at = ?, updated_at = ? WHERE id = ? AND state = 'running'")
      .run(at, at, id);
    return Number(result.changes) > 0;
  }

  /** 実行中 → failed（failure に TakeoverFailure の符号）。移したら true。ended_held は変えない */
  fail(id: number, failure: TakeoverFailure): boolean {
    const at = this.now().toISOString();
    const result = this.db
      .prepare("UPDATE cc_takeovers SET state = 'failed', failure = ?, finished_at = ?, updated_at = ? WHERE id = ? AND state = 'running'")
      .run(failure, at, at, id);
    return Number(result.changes) > 0;
  }

  /** 確認待ち → cancelled（[やめる]）。移したら true */
  cancel(id: number): boolean {
    return this.move(id, "awaiting_confirm", "cancelled", true);
  }

  /** created_at が cutoffIso 以前の確認待ちを cancelled にし、移した行を古い順に返す（10 分の失効） */
  expire(cutoffIso: string): CcTakeoverRow[] {
    const at = this.now().toISOString();
    return this.db
      .prepare(
        `UPDATE cc_takeovers SET state = 'cancelled', finished_at = ?, updated_at = ?
         WHERE state = 'awaiting_confirm' AND created_at <= ? RETURNING *`,
      )
      .all(at, at, cutoffIso)
      .map(toRow)
      .sort((a, b) => a.id - b.id);
  }

  /** 起動時に、実行中の行をすべて failed（restart）にし、移した行を古い順に返す（§3.4）。ended_held は変えない */
  resetRunning(): CcTakeoverRow[] {
    const at = this.now().toISOString();
    return this.db
      .prepare(
        `UPDATE cc_takeovers SET state = 'failed', failure = 'restart', finished_at = ?, updated_at = ?
         WHERE state = 'running' RETURNING *`,
      )
      .all(at, at)
      .map(toRow)
      .sort((a, b) => a.id - b.id);
  }

  /** そのチャンネルに取り込んだ最新の行（done） */
  takenFor(channelId: string): CcTakeoverRow | undefined {
    const row = this.db
      .prepare("SELECT * FROM cc_takeovers WHERE channel_id = ? AND state = 'done' ORDER BY id DESC LIMIT 1")
      .get(channelId);
    return row === undefined ? undefined : toRow(row);
  }

  /** そのチャンネルの done の行の note_pending を 0 にする。変えたら true */
  clearNote(channelId: string): boolean {
    const result = this.db
      .prepare("UPDATE cc_takeovers SET note_pending = 0, updated_at = ? WHERE channel_id = ? AND state = 'done' AND note_pending = 1")
      .run(this.now().toISOString(), channelId);
    return Number(result.changes) > 0;
  }

  /** 確認のメッセージを書く */
  setConfirmMessage(id: number, messageId: string): void {
    this.db
      .prepare("UPDATE cc_takeovers SET confirm_message_id = ?, updated_at = ? WHERE id = ?")
      .run(messageId, this.now().toISOString(), id);
  }

  /** 後始末を済ませた（done で effects_at が空の行だけ。2 回目は false） */
  markEffects(id: number): boolean {
    const at = this.now().toISOString();
    const result = this.db
      .prepare("UPDATE cc_takeovers SET effects_at = ?, updated_at = ? WHERE id = ? AND state = 'done' AND effects_at IS NULL")
      .run(at, at, id);
    return Number(result.changes) > 0;
  }

  /** done で後始末がまだの行を古い順に（起動時のやり直し） */
  listEffectsPending(): CcTakeoverRow[] {
    return this.db.prepare("SELECT * FROM cc_takeovers WHERE state = 'done' AND effects_at IS NULL ORDER BY id").all().map(toRow);
  }

  /** from → to の compare-and-set。finished なら finished_at も今に */
  private move(id: number, from: CcTakeoverState, to: CcTakeoverState, finished: boolean): boolean {
    const at = this.now().toISOString();
    const result = this.db
      .prepare("UPDATE cc_takeovers SET state = ?, updated_at = ?, finished_at = CASE WHEN ? THEN ? ELSE finished_at END WHERE id = ? AND state = ?")
      .run(to, at, finished ? 1 : 0, at, id, from);
    return Number(result.changes) > 0;
  }
}
