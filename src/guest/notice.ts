// ゲスト Bot の定型文（案内。docs/plan/guest-mode.md §3.2.4・§6）。サーバーに入ったときに 1 通だけ投稿し、有効化の返信先にする。
// 投稿の条件は guest_guilds の notice_message_id が無いことの 1 つ（外されたら index.ts が消す）。/guest の登録はここでは行わない
import type { Config } from "../config.ts";
import type { GuestGuildStore } from "../store/guest-guilds.ts";
import { GUEST_BOT_NAME, GUEST_MAX_CONTENT_CHARS } from "./constants.ts";
import type { GuestGateway } from "./index.ts";
import { guestJoinedNotice, type GuestNoticeFailure, guestNoticeFailedNotice } from "./notify.ts";

/** 定型文を送る候補の数の上限（findNoticeChannels の返す数と同じ） */
const NOTICE_SEND_ATTEMPTS = 3;

function formatCount(value: number): string {
  return value.toLocaleString("en-US");
}

/** 定型文の本文。上限の数字だけを cfg から入れる（起動時に 1 回作る。サーバー名・日付は入れない） */
export function buildGuestNoticeText(cfg: Pick<Config, "guestTurnsPerDay" | "guestUserTurnsPerDay">): string {
  const name = GUEST_BOT_NAME;
  return [
    `こんにちは、**${name}** です。この Bot は **AI** です（人ではありません）。`,
    "",
    "**できること**",
    `- このサーバーで有効にしたチャンネルで、${name} を **@メンション** するか、${name} の発言に**返信**すると答えます`,
    "",
    "**できないこと**",
    "- ファイル・Web・コマンドの実行、通知・リマインド、長期の記憶（チャンネルの会話は一定の長さ・時間で新しくなります。前の会話は引き継ぎません）",
    "",
    "**記録について**",
    `- ${name} とのやり取り（発言の本文・返事）は、この Bot の持ち主の手元に**会話の記録と利用量の記録として残り、持ち主が読めます**。見られて困ることは書かないでください`,
    "",
    "**使い始めるには**",
    "- このサーバーの管理者（「サーバー管理」権限を持つ人）が、Bot の持ち主から受け取った認証コードを **このメッセージへの返信** として貼ってください（コード以外は書かないでください）。返信したチャンネルで答えるようになります",
    "- 以後のチャンネルの追加・削除は管理者の `/guest on`・`/guest off`、確認は `/guest status`",
    "",
    "**上限**",
    `- サーバー全体で 1 日 ${formatCount(cfg.guestTurnsPerDay)} 回、1 人 1 日 ${formatCount(cfg.guestUserTurnsPerDay)} 回まで。1 回 ${formatCount(GUEST_MAX_CONTENT_CHARS)} 字まで`,
  ].join("\n");
}

/** already は既に投稿済み（何もしていない）、posted は投稿して記録した、それ以外は投稿できなかった理由 */
export type GuestOnboardResult = "already" | "posted" | GuestNoticeFailure;

export type GuestOnboardingDeps = {
  guilds: Pick<GuestGuildStore, "upsertJoined" | "setNotice">;
  gateway: Pick<GuestGateway, "findNoticeChannels" | "sendMessage">;
  /** buildGuestNoticeText の結果（起動時に 1 回作ったもの） */
  noticeText: string;
  /** オーナーのサーバーの #system への知らせ（notify.ts。reject しない） */
  notify: (text: string) => Promise<void>;
  now: () => Date;
  log: (message: string) => void;
};

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * onboardGuild(guildId): 行を upsert → notice_message_id があれば何もしない → 候補（findNoticeChannels。最大 3 つ）の先頭から送り、
 * 失敗したら次の候補へ → 送れたらそのチャンネル・メッセージを記録して #system に「参加し、案内を投稿しました」。
 * 候補が無い・全部失敗なら記録は変えず（未投稿のまま）、#system に理由付きで知らせる。
 * 同じサーバーの処理が重なったら（参加の経路と起動の sweep など）、先の処理の結果を待って同じ結果を返す（重ねて投稿しない）。
 * DB・候補の取得の失敗は reject する（呼び出し側が log に出す）
 */
export function createGuestOnboarding(deps: GuestOnboardingDeps): (guildId: string) => Promise<GuestOnboardResult> {
  const { guilds, gateway, noticeText, notify, now, log } = deps;
  const running = new Map<string, Promise<GuestOnboardResult>>();

  const onboard = async (guildId: string): Promise<GuestOnboardResult> => {
    const row = guilds.upsertJoined(guildId, now());
    if (row.noticeMessageId !== null) return "already";
    const candidates = (await gateway.findNoticeChannels(guildId)).slice(0, NOTICE_SEND_ATTEMPTS);
    if (candidates.length === 0) {
      log(`guest: 案内を投稿できるチャンネルがありません（guild=${guildId}）`);
      await notify(guestNoticeFailedNotice(guildId, "no_channel"));
      return "no_channel";
    }
    for (const [index, channelId] of candidates.entries()) {
      let messageId: string;
      try {
        messageId = await gateway.sendMessage(channelId, { text: noticeText });
      } catch (error) {
        log(`guest: 案内の送信に失敗しました（guild=${guildId}、候補 ${index + 1}/${candidates.length}）: ${describeError(error)}`);
        continue;
      }
      guilds.setNotice(guildId, channelId, messageId, now());
      log(`guest: 案内を投稿しました（guild=${guildId}）`);
      await notify(guestJoinedNotice(guildId));
      return "posted";
    }
    await notify(guestNoticeFailedNotice(guildId, "send_failed"));
    return "send_failed";
  };

  return (guildId) => {
    const current = running.get(guildId);
    if (current !== undefined) return current;
    const promise = onboard(guildId).finally(() => running.delete(guildId));
    running.set(guildId, promise);
    return promise;
  };
}
