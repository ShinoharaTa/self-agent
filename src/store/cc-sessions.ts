import type { DatabaseSync, SQLOutputValue } from "node:sqlite";

/** last_prompt_text に残す本文の長さ（先頭の文字数。docs/plan/claude-code-sessions.md §2.2） */
export const CC_PROMPT_MAX_CHARS = 200;
/** 一覧から消えたセッションの行を残す日数（scheduler の tick で、gone_at がこれより前の行を消す） */
export const CC_SESSION_KEEP_DAYS = 30;

/** hook の事象の名前（§2.3 の固定の集合） */
export type CcHookEventName = "SessionStart" | "UserPromptSubmit" | "Stop" | "SessionEnd" | "Notification" | "PermissionRequest";

/** 起動したもの（owner = self-agent の外で起動したもの。web・tool・github は self-agent が起動したもの。§4.2） */
export type CcStartedBy = "owner" | "web" | "tool" | "github";

const STARTED_BY: readonly CcStartedBy[] = ["owner", "web", "tool", "github"];

/** cc_sessions の 1 行（時刻は ISO） */
export type CcSessionRow = {
  sessionId: string;
  cwd: string | null;
  name: string | null;
  pid: number | null;
  permissionMode: string | null;
  firstSeenAt: string;
  lastSeenAt: string;
  /** 一覧から消えた時刻。生きていれば null */
  goneAt: string | null;
  /** 最後の UserPromptSubmit を受けた時刻 */
  lastPromptAt: string | null;
  /** その本文の先頭 CC_PROMPT_MAX_CHARS 字 */
  lastPromptText: string | null;
  lastEvent: CcHookEventName | null;
  lastEventAt: string | null;
  /** 判断待ちにした Notification の種類。その後の UserPromptSubmit・Stop で null に戻す */
  waitingKind: string | null;
  /** 判断待ちが始まった時刻（続けて来た Notification では進めない） */
  waitingSince: string | null;
  /** claude agents --json の waitingFor（status が waiting のときだけ。最後に見た一覧の値） */
  waitingFor: string | null;
  /** 起動したもの（v29） */
  startedBy: CcStartedBy;
  /** self-agent が起動したときに付けた tmux のセッション名（表示用。オーナーの hook で変わりうる） */
  tmuxSession: string | null;
  /** self-agent が起動したときの tmux のセッション id（$N） */
  tmuxSessionId: string | null;
  /** self-agent が起動したときのペイン id（%N） */
  startPaneId: string | null;
  /** trust のダイアログの確認待ちに気づいた時刻（消えたら null） */
  trustPendingAt: string | null;
  /** 判断待ちを #system に最後に知らせた時刻（v32。CC5c。待ち始めより後なら、その待ちは知らせ済み） */
  notifiedAt: string | null;
  /** 最後に Discord から頼んだチャンネル（cc_send の [送る]・cc_start の [起動する]。CC7） */
  channelId: string | null;
};

/** self-agent が起動したセッションの記録（recordStart） */
export type CcStartRecord = {
  startedBy: Exclude<CcStartedBy, "owner">;
  tmuxSession: string;
  tmuxSessionId: string;
  paneId: string;
  trustPendingAt: Date | null;
  /** Discord から頼んだ起動（cc_start）なら頼んだチャンネル */
  channelId?: string;
};

/** 1 つの hook の事象で行に反映するもの */
export type CcEventUpdate = {
  event: CcHookEventName;
  /** hook の入力の permission_mode。無ければ今の値のまま */
  permissionMode?: string;
  /** UserPromptSubmit の本文（先頭 CC_PROMPT_MAX_CHARS 字に切って残す）。無ければ NULL */
  promptText?: string;
  /** Notification で判断待ちにする種類（判断待ちにしないものは渡さない） */
  waitingKind?: string;
};

const EVENT_NAMES: readonly CcHookEventName[] = [
  "SessionStart",
  "UserPromptSubmit",
  "Stop",
  "SessionEnd",
  "Notification",
  "PermissionRequest",
];

function nullableString(value: SQLOutputValue | undefined): string | null {
  return value === null || value === undefined ? null : String(value);
}

function toRow(row: Record<string, SQLOutputValue>): CcSessionRow {
  const lastEvent = EVENT_NAMES.find((name) => name === row.last_event) ?? null;
  return {
    sessionId: String(row.session_id),
    cwd: nullableString(row.cwd),
    name: nullableString(row.name),
    pid: row.pid === null || row.pid === undefined ? null : Number(row.pid),
    permissionMode: nullableString(row.permission_mode),
    firstSeenAt: String(row.first_seen_at),
    lastSeenAt: String(row.last_seen_at),
    goneAt: nullableString(row.gone_at),
    lastPromptAt: nullableString(row.last_prompt_at),
    lastPromptText: nullableString(row.last_prompt_text),
    lastEvent,
    lastEventAt: nullableString(row.last_event_at),
    waitingKind: nullableString(row.waiting_kind),
    waitingSince: nullableString(row.waiting_since),
    waitingFor: nullableString(row.waiting_for),
    startedBy: STARTED_BY.find((value) => value === row.started_by) ?? "owner",
    tmuxSession: nullableString(row.tmux_session),
    tmuxSessionId: nullableString(row.tmux_session_id),
    startPaneId: nullableString(row.start_pane_id),
    trustPendingAt: nullableString(row.trust_pending_at),
    notifiedAt: nullableString(row.notified_at),
    channelId: nullableString(row.channel_id),
  };
}

/** 先頭 max 字（コードポイントで数える。サロゲートを割らない） */
export function headChars(text: string, max: number): string {
  const chars = [...text];
  return chars.length <= max ? text : chars.slice(0, max).join("");
}

/** この機械の Claude Code のセッション（cc_sessions。docs/plan/claude-code-sessions.md §9）。物理削除は prune（gone_at から日数）だけ */
export class CcSessionStore {
  private readonly db: DatabaseSync;
  private readonly now: () => Date;

  constructor(db: DatabaseSync, now: () => Date = () => new Date()) {
    this.db = db;
    this.now = now;
  }

  /**
   * claude agents --json で見たセッションを書く（無ければ作り、あれば cwd・名前・pid・waitingFor・last_seen_at を今にして gone_at を外す）。
   * waitingFor は status が waiting のときだけの値で、無ければ NULL にする
   */
  upsertSeen(
    sessions: ReadonlyArray<{ sessionId: string; cwd: string | null; name: string | null; pid: number; waitingFor?: string | null }>,
  ): void {
    if (sessions.length === 0) return;
    const at = this.now().toISOString();
    const statement = this.db.prepare(
      `INSERT INTO cc_sessions (session_id, cwd, name, pid, waiting_for, first_seen_at, last_seen_at) VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (session_id) DO UPDATE SET cwd = excluded.cwd, name = excluded.name, pid = excluded.pid,
         waiting_for = excluded.waiting_for, last_seen_at = excluded.last_seen_at, gone_at = NULL`,
    );
    this.db.exec("BEGIN");
    try {
      for (const session of sessions) {
        statement.run(session.sessionId, session.cwd, session.name, session.pid, session.waitingFor ?? null, at, at);
      }
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  /** 生きている行のうち activeIds に無いものに gone_at（今）を入れ、入れた数を返す */
  markGone(activeIds: readonly string[]): number {
    const active = new Set(activeIds);
    const alive = this.db.prepare("SELECT session_id FROM cc_sessions WHERE gone_at IS NULL").all();
    const gone = alive.map((row) => String(row.session_id)).filter((id) => !active.has(id));
    if (gone.length === 0) return 0;
    const at = this.now().toISOString();
    const statement = this.db.prepare("UPDATE cc_sessions SET gone_at = ? WHERE session_id = ? AND gone_at IS NULL");
    this.db.exec("BEGIN");
    try {
      for (const id of gone) statement.run(at, id);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    return gone.length;
  }

  /**
   * hook の事象を行に反映する（at は受けた時刻）。last_event・last_event_at と、あれば permission_mode を書き、
   * UserPromptSubmit は last_prompt_at・last_prompt_text を進めて判断待ちを外し、Stop は判断待ちを外し、
   * 判断待ちの種類のある Notification は判断待ちにする（既に判断待ちなら始まりの時刻は進めない）。行が無ければ false
   */
  applyEvent(sessionId: string, update: CcEventUpdate, at: Date): boolean {
    const iso = at.toISOString();
    const mode = update.permissionMode ?? null;
    let result;
    switch (update.event) {
      case "UserPromptSubmit":
        result = this.db
          .prepare(
            `UPDATE cc_sessions SET last_event = ?, last_event_at = ?, permission_mode = COALESCE(?, permission_mode),
               last_prompt_at = ?, last_prompt_text = ?, waiting_kind = NULL, waiting_since = NULL WHERE session_id = ?`,
          )
          .run(
            update.event,
            iso,
            mode,
            iso,
            update.promptText === undefined ? null : headChars(update.promptText, CC_PROMPT_MAX_CHARS),
            sessionId,
          );
        break;
      case "Stop":
        result = this.db
          .prepare(
            `UPDATE cc_sessions SET last_event = ?, last_event_at = ?, permission_mode = COALESCE(?, permission_mode),
               waiting_kind = NULL, waiting_since = NULL WHERE session_id = ?`,
          )
          .run(update.event, iso, mode, sessionId);
        break;
      default:
        if (update.event === "Notification" && update.waitingKind !== undefined) {
          result = this.db
            .prepare(
              `UPDATE cc_sessions SET last_event = ?, last_event_at = ?, permission_mode = COALESCE(?, permission_mode),
                 waiting_kind = ?, waiting_since = COALESCE(waiting_since, ?) WHERE session_id = ?`,
            )
            .run(update.event, iso, mode, update.waitingKind, iso, sessionId);
        } else {
          result = this.db
            .prepare(
              "UPDATE cc_sessions SET last_event = ?, last_event_at = ?, permission_mode = COALESCE(?, permission_mode) WHERE session_id = ?",
            )
            .run(update.event, iso, mode, sessionId);
        }
    }
    return Number(result.changes) > 0;
  }

  get(sessionId: string): CcSessionRow | undefined {
    const row = this.db.prepare("SELECT * FROM cc_sessions WHERE session_id = ?").get(sessionId);
    return row === undefined ? undefined : toRow(row);
  }

  /** 生きている（gone_at が NULL の）行を session_id の順に */
  listAlive(): CcSessionRow[] {
    return this.db.prepare("SELECT * FROM cc_sessions WHERE gone_at IS NULL ORDER BY session_id").all().map(toRow);
  }

  /**
   * self-agent が起動したセッションの記録を書く（§4.2。行は一覧で見たときに作られている）。既に記録があれば（started_by が owner でない）書かない。
   * 書いたら true
   */
  recordStart(sessionId: string, record: CcStartRecord): boolean {
    const result = this.db
      .prepare(
        `UPDATE cc_sessions SET started_by = ?, tmux_session = ?, tmux_session_id = ?, start_pane_id = ?, trust_pending_at = ?,
           channel_id = COALESCE(?, channel_id)
         WHERE session_id = ? AND started_by = 'owner'`,
      )
      .run(
        record.startedBy,
        record.tmuxSession,
        record.tmuxSessionId,
        record.paneId,
        record.trustPendingAt === null ? null : record.trustPendingAt.toISOString(),
        record.channelId ?? null,
        sessionId,
      );
    return Number(result.changes) > 0;
  }

  /** 最後に Discord から頼んだチャンネルを書く（cc_send の [送る]。CC7）。行があれば true */
  setChannel(sessionId: string, channelId: string): boolean {
    const result = this.db.prepare("UPDATE cc_sessions SET channel_id = ? WHERE session_id = ?").run(channelId, sessionId);
    return Number(result.changes) > 0;
  }

  /** trust の確認待ちの時刻を書く（null で外す）。行があれば true */
  setTrustPending(sessionId: string, at: Date | null): boolean {
    const result = this.db
      .prepare("UPDATE cc_sessions SET trust_pending_at = ? WHERE session_id = ?")
      .run(at === null ? null : at.toISOString(), sessionId);
    return Number(result.changes) > 0;
  }

  /** 判断待ちを #system に知らせた時刻を書く（CC5c）。行があれば true */
  setNotifiedAt(sessionId: string, at: Date): boolean {
    const result = this.db.prepare("UPDATE cc_sessions SET notified_at = ? WHERE session_id = ?").run(at.toISOString(), sessionId);
    return Number(result.changes) > 0;
  }

  /** 生きている行のうち trust の確認待ちのもの */
  listTrustPending(): CcSessionRow[] {
    return this.db
      .prepare("SELECT * FROM cc_sessions WHERE gone_at IS NULL AND trust_pending_at IS NOT NULL ORDER BY session_id")
      .all()
      .map(toRow);
  }

  /** 複数行をそのまま送ってよいか（cc_state.multiline_ok。行が無ければ true。§3.2） */
  multilineOk(): boolean {
    const row = this.db.prepare("SELECT multiline_ok FROM cc_state WHERE id = 1").get();
    return row === undefined || Number(row.multiline_ok) !== 0;
  }

  /** multiline_ok を書く（ブラケット貼り付けが効いていないと分かったら false。§3.2）。変わったら true */
  setMultilineOk(ok: boolean): boolean {
    const result = this.db
      .prepare("INSERT INTO cc_state (id, multiline_ok) VALUES (1, ?) ON CONFLICT (id) DO UPDATE SET multiline_ok = excluded.multiline_ok WHERE multiline_ok <> excluded.multiline_ok")
      .run(ok ? 1 : 0);
    return Number(result.changes) > 0;
  }

  /** gone_at が cutoff より前の行を消し、消した数を返す（生きている行は消さない） */
  prune(cutoff: Date): number {
    const result = this.db.prepare("DELETE FROM cc_sessions WHERE gone_at IS NOT NULL AND gone_at < ?").run(cutoff.toISOString());
    return Number(result.changes);
  }
}
