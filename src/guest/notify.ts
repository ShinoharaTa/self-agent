// ゲストの知らせ（docs/plan/guest-mode.md §6）。オーナーのサーバー（/setup 済み）の #system に、既定の人格の Bot で 1 行出す。
// 本文に入れるのはゲストのサーバーの ID と数だけ（チャンネル ID は入れない）。失敗は log だけ
import type { SystemNotifier } from "../app/system-notice.ts";
import type { Config } from "../config.ts";
import type { NoticeLevel } from "../store/notices.ts";
import {
  GUEST_INVITE_FAIL_LIMIT,
  GUEST_INVITE_LOCK_MIN,
  GUEST_INVITE_TTL_HOURS,
  GUEST_MAX_CHANNELS_PER_GUILD,
} from "./constants.ts";

/** 操作した人がオーナーでなく管理者（Manage Server）なら末尾に「（管理者）」を付ける（ユーザー ID は入れない） */
function byAdminSuffix(byAdmin: boolean): string {
  return byAdmin ? "（管理者）" : "";
}

export function guestEnabledNotice(guildId: string, active: number, byAdmin = false): string {
  return `ゲスト: サーバー ${guildId} でチャンネルを有効化しました（${active}/${GUEST_MAX_CHANNELS_PER_GUILD}）${byAdminSuffix(byAdmin)}`;
}

export function guestDisabledNotice(guildId: string, active: number, byAdmin = false): string {
  return `ゲスト: サーバー ${guildId} でチャンネルを無効化しました（${active}/${GUEST_MAX_CHANNELS_PER_GUILD}）${byAdminSuffix(byAdmin)}`;
}

/** 許可済みのサーバーから外された（GuildDelete） */
export function guestLeftNotice(guildId: string, disabled: number): string {
  return `ゲスト: サーバー ${guildId} から外されたため、許可を取り消しました（有効なチャンネル ${disabled} 件を無効にしました）`;
}

/** 起動時に、許可済みのサーバーに参加していなかった */
export function guestNotJoinedNotice(guildId: string, disabled: number): string {
  return `ゲスト: サーバー ${guildId} に参加していないため、許可を取り消しました（有効なチャンネル ${disabled} 件を無効にしました）`;
}

/** 定型文（案内）を投稿できた（参加した・起動時に見つけた・/guests invite で投稿し直した） */
export function guestJoinedNotice(guildId: string): string {
  return `ゲスト: サーバー ${guildId} に参加し、案内を投稿しました`;
}

/** 定型文を投稿できなかった理由（no_channel は候補が無い、send_failed は候補の送信がすべて失敗） */
export type GuestNoticeFailure = "no_channel" | "send_failed";

const NOTICE_FAILURE_TEXT: Record<GuestNoticeFailure, string> = {
  no_channel: "投稿できるチャンネルがありません",
  send_failed: "送信に失敗しました",
};

export function guestNoticeFailureText(reason: GuestNoticeFailure): string {
  return NOTICE_FAILURE_TEXT[reason];
}

export function guestNoticeFailedNotice(guildId: string, reason: GuestNoticeFailure): string {
  return `ゲスト: サーバー ${guildId} に参加しましたが、案内を投稿できませんでした（${guestNoticeFailureText(reason)}）`;
}

/** /guests invite で認証コードを発行した（コードは入れない） */
export function guestInviteIssuedNotice(guildId: string): string {
  return `ゲスト: サーバー ${guildId} の認証コードを発行しました（${GUEST_INVITE_TTL_HOURS} 時間有効）`;
}

/** 定型文への返信の認証コードで有効にした。byAdmin は返信した人がオーナーでなく管理者か */
export function guestActivatedNotice(guildId: string, active: number, byAdmin: boolean): string {
  return `ゲスト: サーバー ${guildId} を認証コードで有効にしました（チャンネル ${active}/${GUEST_MAX_CHANNELS_PER_GUILD}。${byAdmin ? "管理者" : "オーナー"}）`;
}

/** 有効化の返信を投稿できなかった（DB は戻さない） */
export function guestActivationReplyFailedNotice(guildId: string): string {
  return `ゲスト: サーバー ${guildId} で有効化の返信を投稿できませんでした（有効化は済んでいます）`;
}

/** オーナーか管理者が貼ったコードを受け付けなかった理由（not_found は知らせない） */
export type GuestInviteRejection = "expired" | "used" | "superseded" | "wrong_guild";

const REJECTION_TEXT: Record<GuestInviteRejection, string> = {
  expired: "期限切れ",
  used: "使用済み",
  superseded: "無効",
  wrong_guild: "別のサーバー向け",
};

export function guestInviteRejectedNotice(guildId: string, reason: GuestInviteRejection): string {
  return `ゲスト: サーバー ${guildId} で認証コードが受け付けられませんでした（${REJECTION_TEXT[reason]}）`;
}

/** 認証コードの失敗が窓の中で上限に達した */
export function guestInviteLockedNotice(guildId: string): string {
  return `ゲスト: サーバー ${guildId} で認証コードの失敗が ${GUEST_INVITE_LOCK_MIN} 分以内に ${GUEST_INVITE_FAIL_LIMIT} 回に達したため、${GUEST_INVITE_LOCK_MIN} 分間は受け付けません`;
}

/** /guests revoke で許可を取り消した */
export function guestRevokedNotice(guildId: string, disabled: number): string {
  return `ゲスト: サーバー ${guildId} の許可を取り消しました（有効なチャンネル ${disabled} 件を無効にしました）`;
}

export type GuestNotifyDeps = {
  /** 知らせを投稿するサーバー（オーナーのサーバー） */
  cfg: Pick<Config, "allowedGuildIds">;
  /** #system への知らせ（app/system-notice.ts。既定の人格の Bot） */
  notify: SystemNotifier;
  log: (message: string) => void;
  /** 既定は SHELL_NOTICE_TIMEOUT_MS */
  timeoutMs?: number;
};

/** ゲストの知らせ。level は notices の記録の重さで、省略は info（外された・失敗の上限は warning） */
export type GuestNotify = (text: string, level?: NoticeLevel) => Promise<void>;

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** /setup 済み（#system がある）のオーナーのサーバーに 1 回ずつ投稿する。やり直さない。reject しない */
export function createGuestNotifier(deps: GuestNotifyDeps): GuestNotify {
  const { cfg, notify, log } = deps;
  return async (text, level = "info") => {
    for (const guildId of cfg.allowedGuildIds) {
      try {
        await notify(guildId, { text }, { level, timeoutMs: deps.timeoutMs });
      } catch (error) {
        log(`guest: #system への知らせの投稿に失敗しました（guild=${guildId}）: ${describeError(error)}`);
      }
    }
  };
}
