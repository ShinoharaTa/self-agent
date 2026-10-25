// 定型文への返信による有効化（docs/plan/guest-mode.md §3.2.5）。返信先が定型文か（同じチャンネル）は呼び出し側（index.ts）が見る。
// 上から順に落とし、落ちたら何も返さない（リアクションもしない）。log はサーバー ID と種類だけ（チャンネル ID・ユーザー ID・本文・コードは出さない）
import type { Config } from "../config.ts";
import type { IncomingMessage } from "../discord/gateway.ts";
import type { GuestStore } from "../store/guest.ts";
import type { GuestInviteStore } from "../store/guest-invites.ts";
import type { SdkSessionStore } from "../store/sdk-sessions.ts";
import { GUEST_LIMIT_REPLY, GUEST_ON_REPLY } from "./commands/guest.ts";
import { GUEST_INVITE_FAIL_LIMIT, GUEST_INVITE_LOCK_MIN, GUEST_MAX_CHANNELS_PER_GUILD, guestSessionKey } from "./constants.ts";
import { stripBotMention } from "./handler.ts";
import type { GuestGateway } from "./index.ts";
import { hashInviteCode, parseInviteCode } from "./invite-code.ts";
import {
  guestActivatedNotice,
  guestActivationReplyFailedNotice,
  guestInviteLockedNotice,
  guestInviteRejectedNotice,
} from "./notify.ts";

/** 有効にしたときの公開の返信 */
export const GUEST_ACTIVATED_REPLY = `有効にしました。\n${GUEST_ON_REPLY}`;
/** サーバーは許可したが、チャンネルの上限で有効にできなかったときの公開の返信 */
export const GUEST_ACTIVATED_LIMIT_REPLY = `このサーバーを有効にしました。\n${GUEST_LIMIT_REPLY}`;

const LOCK_MS = GUEST_INVITE_LOCK_MIN * 60_000;

export type GuestActivationDeps = {
  cfg: Pick<Config, "ownerUserId">;
  /** コードの消費・サーバーの許可・チャンネルの有効化（1 トランザクション） */
  invites: Pick<GuestInviteStore, "redeem">;
  /** #system の「チャンネル n/5」（既に有効・上限のとき） */
  guest: Pick<GuestStore, "countActive">;
  /** 有効にしたチャンネルの SDK セッション（`guest:<channelId>`）を捨てる */
  sessions: Pick<SdkSessionStore, "delete">;
  gateway: Pick<GuestGateway, "send" | "selfUserId" | "memberCanManageGuild">;
  /** オーナーのサーバーの #system への知らせ（notify.ts。reject しない） */
  notify: (text: string) => Promise<void>;
  now: () => Date;
  log: (message: string) => void;
};

export type GuestActivation = {
  /** 定型文への返信（呼び出し側が確かめたもの）を検証して有効化する。reject しない */
  handleReply: (message: IncomingMessage) => Promise<void>;
};

/** サーバーごとの失敗の時刻（窓の中のもの）と、受け付けない期限（ミリ秒） */
type FailureState = { failures: number[]; lockedUntil: number | undefined };

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function createGuestActivation(deps: GuestActivationDeps): GuestActivation {
  const { cfg, invites, guest, sessions, gateway, notify, now, log } = deps;
  // 失敗の回数はプロセス内（再起動で消える）
  const states = new Map<string, FailureState>();

  /** 受け付けない間か（期限を過ぎていれば回数を 0 に戻す） */
  const isLocked = (guildId: string, at: number): boolean => {
    const state = states.get(guildId);
    if (state?.lockedUntil === undefined) return false;
    if (at < state.lockedUntil) return true;
    states.delete(guildId);
    return false;
  };

  /** DB を引く失敗を 1 回数える。窓の中で上限に達したら true（受け付けない期限を入れる） */
  const recordFailure = (guildId: string, at: number): boolean => {
    const state = states.get(guildId) ?? { failures: [], lockedUntil: undefined };
    state.failures = state.failures.filter((time) => at - time < LOCK_MS);
    state.failures.push(at);
    states.set(guildId, state);
    if (state.failures.length < GUEST_INVITE_FAIL_LIMIT) return false;
    state.failures = [];
    state.lockedUntil = at + LOCK_MS;
    return true;
  };

  const canManage = async (message: IncomingMessage, guildId: string): Promise<boolean> => {
    if (cfg.ownerUserId !== undefined && message.authorId === cfg.ownerUserId) return true;
    if (message.authorCanManageGuild !== undefined) return message.authorCanManageGuild;
    // 発言に member が付いていなかったときだけ、Discord から 1 回取る（失敗・いない・権限なしは false）
    log(`guest: 返信者の権限を Discord から取ります（guild=${guildId}）`);
    try {
      return await gateway.memberCanManageGuild(guildId, message.authorId);
    } catch (error) {
      log(`guest: 返信者の権限を取れませんでした（guild=${guildId}）: ${describeError(error)}`);
      return false;
    }
  };

  const handleReply = async (message: IncomingMessage): Promise<void> => {
    const guildId = message.guildId;
    if (guildId === null) return;
    const drop = (kind: string): void => log(`guest: 案内への返信を受け付けませんでした（guild=${guildId}、${kind}）`);
    if (message.authorIsBot || message.isWebhook) {
      drop("bot");
      return;
    }
    // 形が合わないもの（定型文への普通の返信）は log も出さない
    const code = parseInviteCode(stripBotMention(message.content, gateway.selfUserId()));
    if (code === undefined) return;
    // 受け付けない間は権限も DB も引かない（log も #system も無し）
    if (isLocked(guildId, now().getTime())) return;
    const isOwner = cfg.ownerUserId !== undefined && message.authorId === cfg.ownerUserId;
    if (!(await canManage(message, guildId))) {
      // 権限の無い人の貼り付けは失敗に数えない（管理者を締め出させない）
      drop("forbidden");
      return;
    }
    const at = now();
    const redeemed = invites.redeem(hashInviteCode(code), guildId, at, message.authorId, message.channelId);
    if (redeemed.result !== "ok") {
      drop(redeemed.result);
      if (redeemed.result !== "not_found") await notify(guestInviteRejectedNotice(guildId, redeemed.result));
      if (recordFailure(guildId, at.getTime())) {
        log(
          `guest: 認証コードの失敗が ${GUEST_INVITE_LOCK_MIN} 分以内に ${GUEST_INVITE_FAIL_LIMIT} 回に達したため、${GUEST_INVITE_LOCK_MIN} 分間は受け付けません（guild=${guildId}）`,
        );
        await notify(guestInviteLockedNotice(guildId));
      }
      return;
    }
    // 成功で回数を 0 に戻す
    states.delete(guildId);
    const enable = redeemed.enable;
    let active: number;
    let reply: string;
    if (enable.result === "enabled") {
      // 開き直したら前の会話は続けない（/guest on と同じ）
      sessions.delete(guestSessionKey(message.channelId));
      active = enable.active;
      reply = GUEST_ACTIVATED_REPLY;
    } else if (enable.result === "already_enabled") {
      active = guest.countActive(guildId);
      reply = GUEST_ACTIVATED_REPLY;
    } else {
      active = GUEST_MAX_CHANNELS_PER_GUILD;
      reply = GUEST_ACTIVATED_LIMIT_REPLY;
    }
    log(`guest: 認証コードで有効にしました（guild=${guildId}、${enable.result}、${active}/${GUEST_MAX_CHANNELS_PER_GUILD}）`);
    let replied = true;
    try {
      await gateway.send(message.channelId, reply, message.id);
    } catch (error) {
      replied = false;
      log(`guest: 有効化の返信を投稿できませんでした（guild=${guildId}）: ${describeError(error)}`);
    }
    await notify(guestActivatedNotice(guildId, active, !isOwner));
    if (!replied) await notify(guestActivationReplyFailedNotice(guildId));
  };

  return {
    handleReply: async (message) => {
      try {
        await handleReply(message);
      } catch (error) {
        log(`guest: 案内への返信の処理に失敗しました（guild=${message.guildId ?? "DM"}）: ${describeError(error)}`);
      }
    },
  };
}
