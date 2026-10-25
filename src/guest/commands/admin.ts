// /guests（docs/plan/guest-mode.md §3.2.3）。メインサーバー（SELF_AGENT_ALLOWED_GUILD_IDS）で既定の人格の Bot が受ける、オーナー専用のコマンド。
// サーバー・オーナーの判定は app/interactions.ts の createInteractionHandler が行う。応答はすべて本人にだけ。
// invite はゲストのサーバーの認証コードを発行し（平文は応答に 1 回だけ）、revoke は許可を取り消し、list はゲストのサーバーの一覧を出す
import { formatWallClock } from "../../app/recurrence.ts";
import type { CommandHandler } from "../../app/interactions.ts";
import type { Config } from "../../config.ts";
import type { GuestStore } from "../../store/guest.ts";
import { type GuestGuild, type GuestGuildStore, isGuestGuildAllowed } from "../../store/guest-guilds.ts";
import type { GuestInviteStore } from "../../store/guest-invites.ts";
import { GUEST_BOT_NAME, GUEST_INVITE_TTL_HOURS, GUEST_MAX_CHANNELS_PER_GUILD } from "../constants.ts";
import type { GuestGateway } from "../index.ts";
import type { GuestOnboardResult } from "../notice.ts";
import { guestInviteIssuedNotice, guestNoticeFailureText, guestRevokedNotice } from "../notify.ts";

/** /guests が使うゲストの層の操作（guest/index.ts の createGuestLayer の admin） */
export type GuestAdmin = {
  cfg: Pick<Config, "allowedGuildIds" | "timeZone">;
  invites: Pick<GuestInviteStore, "issue" | "supersedeAll" | "activeFor">;
  guilds: Pick<GuestGuildStore, "get" | "list" | "revoke" | "clearNotice">;
  guest: Pick<GuestStore, "disableGuild" | "countActive">;
  /** ゲスト Bot（参加しているか・定型文がまだあるか） */
  gateway: Pick<GuestGateway, "isInGuild" | "messageExists">;
  /** 定型文の投稿（notice.ts の createGuestOnboarding） */
  onboardGuild: (guildId: string) => Promise<GuestOnboardResult>;
  /** オーナーのサーバーの #system への知らせ（notify.ts。reject しない） */
  notify: (text: string) => Promise<void>;
  now: () => Date;
};

export type GuestsCommandDeps = {
  guests: GuestAdmin;
  log: (message: string) => void;
};

export const GUESTS_BAD_ID_REPLY = "サーバー ID は数字です";
export const GUESTS_MAIN_GUILD_REPLY = "メインのサーバーには発行できません";
export const GUESTS_NOT_JOINED_NOTE = "ゲスト Bot はまだこのサーバーに参加していません。招待すると案内を投稿します";
export const GUESTS_NOTICE_CHECK_FAILED_NOTE = "案内の確認・投稿に失敗しました（コードは発行済みです）";
export const GUESTS_EMPTY_LIST_REPLY = "ゲストのサーバーはありません";

/** Discord のメッセージの上限 */
const MAX_REPLY_CHARS = 2000;

const SERVER_ID_OPTION = {
  type: "string",
  name: "server_id",
  description: "ゲストのサーバーの ID",
  required: true,
  minLength: 17,
  maxLength: 20,
} as const;

/** 発行の応答（本人にだけ）。コードはここに 1 回だけ載せる */
export function inviteReply(guildId: string, code: string, replaced: boolean, note: string | undefined): string {
  return [
    `サーバー ${guildId} の認証コード（${GUEST_INVITE_TTL_HOURS} 時間有効・1 回だけ）:`,
    `\`${code}\``,
    `そのサーバーの管理者に渡し、${GUEST_BOT_NAME} の案内への**返信**として貼ってもらってください。`,
    ...(replaced ? ["前のコードは無効にしました"] : []),
    ...(note === undefined ? [] : [note]),
  ].join("\n");
}

export function revokedReply(guildId: string, disabled: number): string {
  return `サーバー ${guildId} の許可を取り消しました（有効なチャンネル ${disabled} 件を無効にしました）`;
}

export function notAllowedReply(guildId: string): string {
  return `サーバー ${guildId} は許可していません`;
}

function stringOption(value: string | number | boolean | undefined): string {
  return typeof value === "string" ? value.trim() : "";
}

function isServerId(text: string): boolean {
  return /^\d{17,20}$/.test(text);
}

/** 定型文の再投稿の結果を、応答に添える 1 行に（投稿済み・投稿できたなら何も添えない） */
function onboardNote(result: GuestOnboardResult): string | undefined {
  if (result === "already" || result === "posted") return undefined;
  return `案内を投稿できませんでした（${guestNoticeFailureText(result)}）`;
}

/** list の 1 行 */
function listLine(admin: GuestAdmin, row: GuestGuild, at: Date): string {
  let state: string;
  if (isGuestGuildAllowed(row)) {
    state = `許可済み（チャンネル ${admin.guest.countActive(row.guildId)}/${GUEST_MAX_CHANNELS_PER_GUILD}）`;
  } else if (row.revokedAt !== null) {
    state = `取り消し済み（${row.revokedReason === "left" ? "外された" : "/guests revoke"}）`;
  } else {
    state = "未許可";
  }
  const invite = admin.invites.activeFor(row.guildId, at);
  const code = invite === undefined ? "コードなし" : `コード有効 ${formatWallClock(new Date(invite.expiresAt), admin.cfg.timeZone)} まで`;
  const joined = admin.gateway.isInGuild(row.guildId) ? "" : "（不参加）";
  return `${row.guildId}: ${state}・${code}${joined}`;
}

/** list の本文（2,000 字に収まらなければ「ほか n 件」） */
export function listText(lines: readonly string[]): string {
  if (lines.length === 0) return GUESTS_EMPTY_LIST_REPLY;
  const kept: string[] = [];
  for (const [index, line] of lines.entries()) {
    const rest = lines.length - index - 1;
    const tail = rest > 0 ? `\nほか ${rest} 件` : "";
    if ([...kept, line].join("\n").length + tail.length > MAX_REPLY_CHARS) {
      return `${kept.join("\n")}\nほか ${lines.length - kept.length} 件`;
    }
    kept.push(line);
  }
  return kept.join("\n");
}

/**
 * `/guests invite server_id:<id>`・`/guests revoke server_id:<id>`・`/guests list`。
 * ゲスト（SELF_AGENT_GUEST_* が揃ったとき）のときだけ、既定の人格の Bot がメインサーバーに登録する
 */
export function createGuestsCommand(deps: GuestsCommandDeps): CommandHandler {
  const { guests: admin, log } = deps;

  /** 発行した後の定型文の確かめ（参加していて、記録が無いかメッセージが消えていれば投稿し直す）。応答に添える 1 行を返す */
  const ensureNotice = async (guildId: string): Promise<string | undefined> => {
    if (!admin.gateway.isInGuild(guildId)) return GUESTS_NOT_JOINED_NOTE;
    try {
      const row = admin.guilds.get(guildId);
      if (row !== undefined && row.noticeMessageId !== null) {
        const exists =
          row.noticeChannelId !== null && (await admin.gateway.messageExists(row.noticeChannelId, row.noticeMessageId));
        if (exists) return undefined;
        // 消えていると返信先が無く有効化できないので、記録を消してから投稿し直す
        admin.guilds.clearNotice(guildId);
        log(`guest: 案内が見つからないため投稿し直します（guild=${guildId}）`);
      }
      return onboardNote(await admin.onboardGuild(guildId));
    } catch (error) {
      log(`guest: 案内の確認・投稿に失敗しました（guild=${guildId}）: ${error instanceof Error ? error.message : String(error)}`);
      return GUESTS_NOTICE_CHECK_FAILED_NOTE;
    }
  };

  return {
    def: {
      name: "guests",
      description: "ゲストのサーバーの認証コードの発行・許可の取り消し・一覧（オーナー専用）",
      subcommands: [
        { name: "invite", description: "ゲストのサーバーの認証コードを発行します（24 時間有効・1 回だけ）", options: [SERVER_ID_OPTION] },
        { name: "revoke", description: "ゲストのサーバーの許可を取り消します", options: [SERVER_ID_OPTION] },
        { name: "list", description: "ゲストのサーバーの一覧" },
      ],
    },
    async handle(interaction, responder) {
      const subcommand = interaction.subcommand;
      if (subcommand === "list") {
        const at = admin.now();
        const lines = admin.guilds.list().map((row) => listLine(admin, row, at));
        await responder.reply({ text: listText(lines), ephemeral: true });
        return;
      }
      if (subcommand !== "invite" && subcommand !== "revoke") throw new Error(`/guests の不明なサブコマンドです（${subcommand ?? ""}）`);
      const guildId = stringOption(interaction.options.server_id);
      if (!isServerId(guildId)) {
        await responder.reply({ text: GUESTS_BAD_ID_REPLY, ephemeral: true });
        return;
      }
      if (subcommand === "invite") {
        if (admin.cfg.allowedGuildIds.includes(guildId)) {
          await responder.reply({ text: GUESTS_MAIN_GUILD_REPLY, ephemeral: true });
          return;
        }
        // 定型文の確かめで Discord を呼ぶので、先に保留する
        await responder.defer(true);
        const issued = admin.invites.issue(guildId, admin.now());
        log(`guest: 認証コードを発行しました（guild=${guildId}${issued.replaced ? "、前のコードを無効化" : ""}）`);
        const note = await ensureNotice(guildId);
        try {
          await responder.reply({ text: inviteReply(guildId, issued.code, issued.replaced, note), ephemeral: true });
        } finally {
          await admin.notify(guestInviteIssuedNotice(guildId));
        }
        return;
      }
      // revoke
      if (!isGuestGuildAllowed(admin.guilds.get(guildId))) {
        await responder.reply({ text: notAllowedReply(guildId), ephemeral: true });
        return;
      }
      const at = admin.now();
      admin.guilds.revoke(guildId, "revoke", at);
      const disabled = admin.guest.disableGuild(guildId, "command");
      const superseded = admin.invites.supersedeAll(guildId, at);
      log(`guest: 許可を取り消しました（guild=${guildId}、チャンネル ${disabled} 件・コード ${superseded} 件を無効化）`);
      try {
        await responder.reply({ text: revokedReply(guildId, disabled), ephemeral: true });
      } finally {
        await admin.notify(guestRevokedNotice(guildId, disabled));
      }
    },
  };
}
