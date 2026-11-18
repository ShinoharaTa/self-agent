import type { DatabaseSync, SQLOutputValue } from "node:sqlite";
import type { TakeoverFailure } from "../cc/takeover-rules.ts";

/**
 * 取り込みの状態（docs/plan/takeover.md §4）。awaiting_confirm = 確認待ち、running = [取り込む] を受けた（step が今の位置）、
 * done = 取り込んだ、failed = 取り込めなかった（failure が符号）、cancelled = [やめる]・10 分の放置
 */
export type CcTakeoverState = "awaiting_confirm" | "running" | "done" | "failed" | "cancelled";

/** running の間の位置（§4） */
export type CcTakeoverStep = "check" | "channel" | "term" | "copy" | "commit";

/** alive = 一覧にある（待機の）セッション、ended = 終わった（一覧に無い）セッション */
export type CcTakeoverSource = "alive" | "ended";

export type CcTakeoverEntry = "discord" | "web";

/** 取り込んだセッションの許可のモード（§3.6。mapTakeoverMode の結果） */
export type CcTakeoverMode = "default" | "acceptEdits" | "plan";

const STATES: readonly CcTakeoverState[] = ["awaiting_confirm", "running", "done", "failed", "cancelled"];
const STEPS: readonly CcTakeoverStep[] = ["check", "channel", "term", "copy", "commit"];
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
  /** 行き先のチャンネルを作るサーバー */
  guildId: string;
  entry: CcTakeoverEntry;
  /** 確認を出した Discord のチャンネル（entry が discord のときだけ） */
  confirmChannelId: string | null;
  /** 行き先の新しいチャンネル（step channel で作った直後に入る。失敗して消せたら null に戻す） */
  targetChannelId: string | null;
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
  entry: CcTakeoverEntry;
  /** 確認を出した Discord のチャンネル（entry が discord のときだけ渡す。合わなければ表の CHECK が投げる） */
  confirmChannelId?: string;
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
    entry,
    confirmChannelId: nullableString(row.confirm_channel_id),
    targetChannelId: nullableString(row.target_channel_id),
    state,
    step,
    failure: nullableString(row.failure),
    permissionMode,
    terminalMode: nullableString(row.terminal_mode),
    interrupted: Number(row.interrupted) === 1,
    notePending: Number(row.note_pending) === 1,
    confirmMessageId: nullableString(row.confirm_message_id),
    effectsAt: nullableString(row.effects_at),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
    finishedAt: nullableString(row.finished_at),
  };
}

/** 取り込み（cc_takeovers。docs/plan/takeover.md §3.9・§4・§5 の H1a）。状態の遷移は compare-and-set で、当たらなければ何も変えない。物理削除はしない */
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
        `INSERT INTO cc_takeovers (session_id, source, project, guild_id, entry, confirm_channel_id, state, permission_mode, terminal_mode,
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
        input.entry,
        input.confirmChannelId ?? null,
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

  /** 確認待ち → 実行中（[取り込む]）。位置は最初の check にする。移したら true */
  start(id: number): boolean {
    const result = this.db
      .prepare("UPDATE cc_takeovers SET state = 'running', step = 'check', updated_at = ? WHERE id = ? AND state = 'awaiting_confirm'")
      .run(this.now().toISOString(), id);
    return Number(result.changes) > 0;
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

  /**
   * 実行中で行き先がまだ空の行に、行き先のチャンネルを書く（step channel で作った直後）。書いたら true。
   * 同じチャンネルが別の行の行き先に在ると UNIQUE の違反で投げる（作ったばかりのチャンネルでは起きない）。
   * 呼び出し側は false と同じく失敗として扱い、投げた例外を外に出さない
   */
  setTarget(id: number, channelId: string): boolean {
    const result = this.db
      .prepare("UPDATE cc_takeovers SET target_channel_id = ?, updated_at = ? WHERE id = ? AND state = 'running' AND target_channel_id IS NULL")
      .run(channelId, this.now().toISOString(), id);
    return Number(result.changes) > 0;
  }

  /** failed の行の行き先を空に戻す（作ったチャンネルを消せた後）。戻したら true */
  clearTarget(id: number): boolean {
    const result = this.db
      .prepare("UPDATE cc_takeovers SET target_channel_id = NULL, updated_at = ? WHERE id = ? AND state = 'failed' AND target_channel_id IS NOT NULL")
      .run(this.now().toISOString(), id);
    return Number(result.changes) > 0;
  }

  /** 失敗して行き先のチャンネルが残っている行を古い順に（消し直す） */
  listTargetLeft(): CcTakeoverRow[] {
    return this.db.prepare("SELECT * FROM cc_takeovers WHERE state = 'failed' AND target_channel_id IS NOT NULL ORDER BY id").all().map(toRow);
  }

  /** 実行中 → done（note_pending = 1）。行き先が空なら移さずに false。移したら true。トランザクションは開かない（呼び出し側の commit の中で呼ぶ） */
  finish(id: number): boolean {
    const at = this.now().toISOString();
    const result = this.db
      .prepare("UPDATE cc_takeovers SET state = 'done', note_pending = 1, finished_at = ?, updated_at = ? WHERE id = ? AND state = 'running' AND target_channel_id IS NOT NULL")
      .run(at, at, id);
    return Number(result.changes) > 0;
  }

  /** 実行中 → failed（failure に TakeoverFailure の符号）。移したら true。行き先は変えない */
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

  /** 起動時に、実行中の行をすべて failed（restart）にし、移した行を古い順に返す（§3.4）。行き先は変えない */
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

  /** そのチャンネル（行き先）に取り込んだ最新の行（done） */
  takenFor(channelId: string): CcTakeoverRow | undefined {
    const row = this.db
      .prepare("SELECT * FROM cc_takeovers WHERE target_channel_id = ? AND state = 'done' ORDER BY id DESC LIMIT 1")
      .get(channelId);
    return row === undefined ? undefined : toRow(row);
  }

  /** そのチャンネル（行き先）の done の行の note_pending を 0 にする。変えたら true */
  clearNote(channelId: string): boolean {
    const result = this.db
      .prepare("UPDATE cc_takeovers SET note_pending = 0, updated_at = ? WHERE target_channel_id = ? AND state = 'done' AND note_pending = 1")
      .run(this.now().toISOString(), channelId);
    return Number(result.changes) > 0;
  }

  /**
   * 確認のメッセージを書く（Discord から始めた行に 1 回だけ。書いたら true）。
   * Web から始めた行（確認のチャンネルが無い）と、すでに書いた行は変えない。
   * 状態は見ない（投稿の返りより先に [取り込む] が押されても、後で確認の文を書き換えられるように）
   */
  setConfirmMessage(id: number, messageId: string): boolean {
    const result = this.db
      .prepare(
        "UPDATE cc_takeovers SET confirm_message_id = ?, updated_at = ? WHERE id = ? AND confirm_channel_id IS NOT NULL AND confirm_message_id IS NULL",
      )
      .run(messageId, this.now().toISOString(), id);
    return Number(result.changes) > 0;
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
