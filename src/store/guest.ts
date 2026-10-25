import type { DatabaseSync, SQLOutputValue } from "node:sqlite";
import { GUEST_MAX_CHANNELS_PER_GUILD } from "../guest/constants.ts";

/** command は /guest off、left はゲスト Bot がサーバーから外された、startup は起動時にゲスト Bot がそのサーバーに参加していなかった */
export type GuestDisabledReason = "command" | "left" | "startup";

/** ゲストのサーバーで答えるチャンネル（guest_channels。docs/plan/guest-mode.md §4） */
export type GuestChannel = {
  guildId: string;
  channelId: string;
  /** 最後に有効にした時刻（ISO） */
  enabledAt: string;
  /** 無効にした時刻。有効なら null */
  disabledAt: string | null;
  disabledReason: GuestDisabledReason | null;
  /** 今の SDK セッションを始めた時刻。まだ無ければ null */
  sessionStartedAt: string | null;
  /** 今の SDK セッションのターン数 */
  sessionTurns: number;
};

export type GuestEnableResult =
  /** 新しく有効にした（無効な行を開き直したものを含む）。active は有効にした後のそのサーバーの有効なチャンネルの数 */
  | { result: "enabled"; channel: GuestChannel; active: number }
  | { result: "already_enabled"; channel: GuestChannel }
  /** そのサーバーの有効なチャンネルが上限に達している */
  | { result: "limit" };

function nullableString(value: SQLOutputValue | undefined): string | null {
  return value === null || value === undefined ? null : String(value);
}

function toReason(value: SQLOutputValue | undefined): GuestDisabledReason | null {
  return value === "command" || value === "left" || value === "startup" ? value : null;
}

function toGuestChannel(row: Record<string, SQLOutputValue>): GuestChannel {
  return {
    guildId: String(row.guild_id),
    channelId: String(row.channel_id),
    enabledAt: String(row.enabled_at),
    disabledAt: nullableString(row.disabled_at),
    disabledReason: toReason(row.disabled_reason),
    sessionStartedAt: nullableString(row.session_started_at),
    sessionTurns: Number(row.session_turns),
  };
}

/**
 * ゲストのチャンネル（guest_channels。物理削除しない）と 1 日のターン数（guest_turns）。
 * 1 日（day）は呼び出し側が SELF_AGENT_TZ の YYYY-MM-DD で渡す
 */
export class GuestStore {
  private readonly db: DatabaseSync;
  private readonly now: () => Date;

  constructor(db: DatabaseSync, now: () => Date = () => new Date()) {
    this.db = db;
    this.now = now;
  }

  /**
   * チャンネルを有効にする。無効な行があれば開き直し（disabled_* を NULL、enabled_at を今、SDK セッションの数をリセット）、無ければ作る。
   * 既に有効なら already_enabled、そのサーバーの有効なチャンネルが limit 以上なら limit（どちらも何も変えない）。
   * 呼び出し側のトランザクションの中（guest-invites.ts の redeem）なら、自分では BEGIN せずその中で行う
   */
  enable(guildId: string, channelId: string, limit: number = GUEST_MAX_CHANNELS_PER_GUILD): GuestEnableResult {
    const own = !this.db.isTransaction;
    if (own) this.db.exec("BEGIN");
    try {
      const existing = this.get(channelId);
      let result: GuestEnableResult;
      if (existing !== undefined && existing.disabledAt === null) {
        result = { result: "already_enabled", channel: existing };
      } else if (this.countActive(guildId) >= limit) {
        result = { result: "limit" };
      } else {
        const row = this.db
          .prepare(
            "INSERT INTO guest_channels (guild_id, channel_id, enabled_at) VALUES (?, ?, ?) " +
              "ON CONFLICT (channel_id) DO UPDATE SET guild_id = excluded.guild_id, enabled_at = excluded.enabled_at, " +
              "disabled_at = NULL, disabled_reason = NULL, session_started_at = NULL, session_turns = 0 RETURNING *",
          )
          .get(guildId, channelId, this.now().toISOString());
        if (row === undefined) throw new Error("ゲストのチャンネルを保存できませんでした");
        result = { result: "enabled", channel: toGuestChannel(row), active: this.countActive(guildId) };
      }
      if (own) this.db.exec("COMMIT");
      return result;
    } catch (error) {
      if (own) this.db.exec("ROLLBACK");
      throw error;
    }
  }

  /** 有効なチャンネルを無効にする。無効にしたら true、行が無い・既に無効なら false（何も変えない） */
  disable(channelId: string, reason: GuestDisabledReason): boolean {
    const result = this.db
      .prepare("UPDATE guest_channels SET disabled_at = ?, disabled_reason = ? WHERE channel_id = ? AND disabled_at IS NULL")
      .run(this.now().toISOString(), reason, channelId);
    return Number(result.changes) > 0;
  }

  /** そのサーバーの有効なチャンネルをすべて無効にし、無効にした数を返す */
  disableGuild(guildId: string, reason: GuestDisabledReason): number {
    const result = this.db
      .prepare("UPDATE guest_channels SET disabled_at = ?, disabled_reason = ? WHERE guild_id = ? AND disabled_at IS NULL")
      .run(this.now().toISOString(), reason, guildId);
    return Number(result.changes);
  }

  /** 無効な行も返す */
  get(channelId: string): GuestChannel | undefined {
    const row = this.db.prepare("SELECT * FROM guest_channels WHERE channel_id = ?").get(channelId);
    return row === undefined ? undefined : toGuestChannel(row);
  }

  /** そのサーバーの有効なチャンネル（有効にした順） */
  listActive(guildId: string): GuestChannel[] {
    return this.db
      .prepare("SELECT * FROM guest_channels WHERE guild_id = ? AND disabled_at IS NULL ORDER BY enabled_at, channel_id")
      .all(guildId)
      .map(toGuestChannel);
  }

  countActive(guildId: string): number {
    const row = this.db
      .prepare("SELECT COUNT(*) AS count FROM guest_channels WHERE guild_id = ? AND disabled_at IS NULL")
      .get(guildId);
    return Number(row?.count ?? 0);
  }

  /** 今の SDK セッションのターンを 1 つ数える（始めた時刻が無ければ今にする） */
  bumpSession(channelId: string): void {
    this.db
      .prepare(
        "UPDATE guest_channels SET session_turns = session_turns + 1, session_started_at = COALESCE(session_started_at, ?) WHERE channel_id = ?",
      )
      .run(this.now().toISOString(), channelId);
  }

  /** SDK セッションを捨てたときに、始めた時刻とターン数を戻す */
  resetSession(channelId: string): void {
    this.db
      .prepare("UPDATE guest_channels SET session_started_at = NULL, session_turns = 0 WHERE channel_id = ?")
      .run(channelId);
  }

  /** そのサーバーのその日のターン数（全ユーザーの合計） */
  countTurns(guildId: string, day: string): number {
    const row = this.db
      .prepare("SELECT COALESCE(SUM(count), 0) AS total FROM guest_turns WHERE guild_id = ? AND day = ?")
      .get(guildId, day);
    return Number(row?.total ?? 0);
  }

  /** そのサーバーでのそのユーザーのその日のターン数 */
  countUserTurns(guildId: string, userId: string, day: string): number {
    const row = this.db
      .prepare("SELECT count FROM guest_turns WHERE guild_id = ? AND user_id = ? AND day = ?")
      .get(guildId, userId, day);
    return Number(row?.count ?? 0);
  }

  /** ターンを 1 つ数える */
  recordTurn(guildId: string, userId: string, day: string): void {
    this.db
      .prepare(
        "INSERT INTO guest_turns (guild_id, user_id, day, count) VALUES (?, ?, ?, 1) " +
          "ON CONFLICT (guild_id, user_id, day) DO UPDATE SET count = count + 1",
      )
      .run(guildId, userId, day);
  }

  /** beforeDay（YYYY-MM-DD）より前の日の行を消し、消した数を返す */
  pruneTurns(beforeDay: string): number {
    const result = this.db.prepare("DELETE FROM guest_turns WHERE day < ?").run(beforeDay);
    return Number(result.changes);
  }
}
