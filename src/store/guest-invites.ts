import { randomBytes as cryptoRandomBytes } from "node:crypto";
import type { DatabaseSync, SQLOutputValue } from "node:sqlite";
import { GUEST_INVITE_TTL_HOURS } from "../guest/constants.ts";
import { generateInviteCode, hashInviteCode } from "../guest/invite-code.ts";
import type { GuestEnableResult, GuestStore } from "./guest.ts";
import type { GuestGuildStore } from "./guest-guilds.ts";

/** 認証コード（guest_invites。docs/plan/guest-mode.md §4）。平文は持たない */
export type GuestInvite = {
  id: number;
  guildId: string;
  createdAt: string;
  expiresAt: string;
  /** 同じサーバーに新しいコードを発行した・取り消したときに無効にした時刻 */
  supersededAt: string | null;
  usedAt: string | null;
  usedByUserId: string | null;
  usedChannelId: string | null;
};

export type GuestIssueResult = {
  /** 平文のコード。ここにだけ載せ、DB・log には残さない */
  code: string;
  expiresAt: string;
  /** 同じサーバーの生きているコードを無効にしたか */
  replaced: boolean;
};

export type GuestRedeemResult =
  /** コードを使い、サーバーを許可した。enable はそのチャンネルの有効化の結果（limit でも許可は成立する） */
  | { result: "ok"; enable: GuestEnableResult }
  | { result: "not_found" | "wrong_guild" | "used" | "expired" | "superseded" };

function nullableString(value: SQLOutputValue | undefined): string | null {
  return value === null || value === undefined ? null : String(value);
}

function toGuestInvite(row: Record<string, SQLOutputValue>): GuestInvite {
  return {
    id: Number(row.id),
    guildId: String(row.guild_id),
    createdAt: String(row.created_at),
    expiresAt: String(row.expires_at),
    supersededAt: nullableString(row.superseded_at),
    usedAt: nullableString(row.used_at),
    usedByUserId: nullableString(row.used_by_user_id),
    usedChannelId: nullableString(row.used_channel_id),
  };
}

/** 生きている := 未使用・置き換えられていない・期限内 */
const LIVE = "used_at IS NULL AND superseded_at IS NULL AND expires_at > ?";

export type GuestInviteStoreDeps = {
  /** コードを使ったときにサーバーを許可する */
  guilds: Pick<GuestGuildStore, "allow">;
  /** コードを使ったときに返信のあったチャンネルを有効にする */
  channels: Pick<GuestStore, "enable">;
  /** 既定は node:crypto の randomBytes */
  randomBytes?: (size: number) => Uint8Array;
};

/** 認証コード（物理削除しない）。時刻は呼び出し側が渡す */
export class GuestInviteStore {
  private readonly db: DatabaseSync;
  private readonly deps: GuestInviteStoreDeps;

  constructor(db: DatabaseSync, deps: GuestInviteStoreDeps) {
    this.db = db;
    this.deps = deps;
  }

  /**
   * 新しいコードを発行する（1 トランザクション）: 同じサーバーの生きているコードを superseded にし、ハッシュの行を 1 つ作る。
   * 有効期限は now から GUEST_INVITE_TTL_HOURS
   */
  issue(guildId: string, now: Date): GuestIssueResult {
    const code = generateInviteCode(this.deps.randomBytes ?? cryptoRandomBytes);
    const at = now.toISOString();
    const expiresAt = new Date(now.getTime() + GUEST_INVITE_TTL_HOURS * 3_600_000).toISOString();
    this.db.exec("BEGIN");
    try {
      const replaced = this.supersedeLive(guildId, at) > 0;
      this.db
        .prepare("INSERT INTO guest_invites (guild_id, code_hash, created_at, expires_at) VALUES (?, ?, ?, ?)")
        .run(guildId, hashInviteCode(code), at, expiresAt);
      this.db.exec("COMMIT");
      return { code, expiresAt, replaced };
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  /**
   * コードを使う（1 トランザクション）。code_hash の行があり、guild_id が一致し、未使用・置き換えられておらず、期限内なら、used_* を書き、
   * サーバーを許可し、そのチャンネルを有効にして ok。それ以外は理由を返して何も変えない。許可・有効化が投げたらコードの使用も戻す
   */
  redeem(hash: string, guildId: string, now: Date, userId: string, channelId: string): GuestRedeemResult {
    const at = now.toISOString();
    this.db.exec("BEGIN");
    try {
      const row = this.db.prepare("SELECT * FROM guest_invites WHERE code_hash = ?").get(hash);
      let result: GuestRedeemResult;
      if (row === undefined) {
        result = { result: "not_found" };
      } else {
        const invite = toGuestInvite(row);
        if (invite.guildId !== guildId) result = { result: "wrong_guild" };
        else if (invite.usedAt !== null) result = { result: "used" };
        else if (invite.supersededAt !== null) result = { result: "superseded" };
        else if (invite.expiresAt <= at) result = { result: "expired" };
        else {
          this.db
            .prepare("UPDATE guest_invites SET used_at = ?, used_by_user_id = ?, used_channel_id = ? WHERE id = ?")
            .run(at, userId, channelId, invite.id);
          this.deps.guilds.allow(guildId, now);
          result = { result: "ok", enable: this.deps.channels.enable(guildId, channelId) };
        }
      }
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  /** そのサーバーの生きているコードをすべて無効にし、無効にした数を返す（/guests revoke） */
  supersedeAll(guildId: string, now: Date): number {
    return this.supersedeLive(guildId, now.toISOString());
  }

  /** そのサーバーの生きているコード（多くても 1 つ） */
  activeFor(guildId: string, now: Date): GuestInvite | undefined {
    const row = this.db
      .prepare(`SELECT * FROM guest_invites WHERE guild_id = ? AND ${LIVE} ORDER BY id DESC LIMIT 1`)
      .get(guildId, now.toISOString());
    return row === undefined ? undefined : toGuestInvite(row);
  }

  private supersedeLive(guildId: string, at: string): number {
    const result = this.db
      .prepare(`UPDATE guest_invites SET superseded_at = ? WHERE guild_id = ? AND ${LIVE}`)
      .run(at, guildId, at);
    return Number(result.changes);
  }
}
