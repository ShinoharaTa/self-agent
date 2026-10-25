import type { DatabaseSync, SQLOutputValue } from "node:sqlite";

/** revoke は /guests revoke、left はゲスト Bot がサーバーから外された（起動時に参加していなかったを含む） */
export type GuestRevokedReason = "revoke" | "left";

/** ゲスト Bot が参加した（ことのある）サーバーと許可の状態（guest_guilds。docs/plan/guest-mode.md §4） */
export type GuestGuild = {
  guildId: string;
  /** 初めて見た時刻（ISO）。再参加では変えない */
  joinedAt: string;
  /** 認証コードで許可した時刻。未許可なら null */
  allowedAt: string | null;
  /** 取り消した時刻。null なら（allowedAt があれば）許可済み */
  revokedAt: string | null;
  revokedReason: GuestRevokedReason | null;
  /** 定型文を投稿したチャンネルとメッセージ・時刻。未投稿・外されたら null */
  noticeChannelId: string | null;
  noticeMessageId: string | null;
  noticePostedAt: string | null;
};

function nullableString(value: SQLOutputValue | undefined): string | null {
  return value === null || value === undefined ? null : String(value);
}

function toReason(value: SQLOutputValue | undefined): GuestRevokedReason | null {
  return value === "revoke" || value === "left" ? value : null;
}

function toGuestGuild(row: Record<string, SQLOutputValue>): GuestGuild {
  return {
    guildId: String(row.guild_id),
    joinedAt: String(row.joined_at),
    allowedAt: nullableString(row.allowed_at),
    revokedAt: nullableString(row.revoked_at),
    revokedReason: toReason(row.revoked_reason),
    noticeChannelId: nullableString(row.notice_channel_id),
    noticeMessageId: nullableString(row.notice_message_id),
    noticePostedAt: nullableString(row.notice_posted_at),
  };
}

/** 許可済み := allowed_at があり revoked_at が無い */
export function isGuestGuildAllowed(guild: GuestGuild | undefined): boolean {
  return guild !== undefined && guild.allowedAt !== null && guild.revokedAt === null;
}

/** ゲストのサーバー（guest_guilds。物理削除しない）。時刻は呼び出し側が渡す */
export class GuestGuildStore {
  private readonly db: DatabaseSync;

  constructor(db: DatabaseSync) {
    this.db = db;
  }

  /** 参加の記録。行が無ければ joined_at を now で作り、あれば何も変えない。今の行を返す */
  upsertJoined(guildId: string, now: Date): GuestGuild {
    this.db
      .prepare("INSERT INTO guest_guilds (guild_id, joined_at) VALUES (?, ?) ON CONFLICT (guild_id) DO NOTHING")
      .run(guildId, now.toISOString());
    const guild = this.get(guildId);
    if (guild === undefined) throw new Error("ゲストのサーバーを保存できませんでした");
    return guild;
  }

  get(guildId: string): GuestGuild | undefined {
    const row = this.db.prepare("SELECT * FROM guest_guilds WHERE guild_id = ?").get(guildId);
    return row === undefined ? undefined : toGuestGuild(row);
  }

  isAllowed(guildId: string): boolean {
    return isGuestGuildAllowed(this.get(guildId));
  }

  /** 許可する（allowed_at を now、取り消しの列を NULL に）。行が無ければ joined_at も now で作る */
  allow(guildId: string, now: Date): void {
    const at = now.toISOString();
    this.db
      .prepare(
        "INSERT INTO guest_guilds (guild_id, joined_at, allowed_at) VALUES (?, ?, ?) " +
          "ON CONFLICT (guild_id) DO UPDATE SET allowed_at = excluded.allowed_at, revoked_at = NULL, revoked_reason = NULL",
      )
      .run(guildId, at, at);
  }

  /** 許可済みの行だけ取り消す。取り消したら true、行が無い・未許可・取り消し済みなら false（何も変えない） */
  revoke(guildId: string, reason: GuestRevokedReason, now: Date): boolean {
    const result = this.db
      .prepare(
        "UPDATE guest_guilds SET revoked_at = ?, revoked_reason = ? WHERE guild_id = ? AND allowed_at IS NOT NULL AND revoked_at IS NULL",
      )
      .run(now.toISOString(), reason, guildId);
    return Number(result.changes) > 0;
  }

  /** 定型文を投稿したチャンネル・メッセージを記録する */
  setNotice(guildId: string, channelId: string, messageId: string, now: Date): void {
    this.db
      .prepare("UPDATE guest_guilds SET notice_channel_id = ?, notice_message_id = ?, notice_posted_at = ? WHERE guild_id = ?")
      .run(channelId, messageId, now.toISOString(), guildId);
  }

  /** 定型文の記録（notice_* の 3 列）を NULL に戻す（外された・案内が消えていた）。ほかの列は変えない */
  clearNotice(guildId: string): void {
    this.db
      .prepare(
        "UPDATE guest_guilds SET notice_channel_id = NULL, notice_message_id = NULL, notice_posted_at = NULL WHERE guild_id = ?",
      )
      .run(guildId);
  }

  /** 全部の行（参加した順） */
  list(): GuestGuild[] {
    return this.db.prepare("SELECT * FROM guest_guilds ORDER BY joined_at, guild_id").all().map(toGuestGuild);
  }
}
