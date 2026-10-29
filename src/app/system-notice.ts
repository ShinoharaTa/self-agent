// #system への知らせ（docs/plan/web-ui.md §7.1）。シェルの状態・人格の Bot の接続・GitHub の取得の失敗・削除の確認・ゲストの知らせは、
// どれもこれを通して既定の人格の Bot で投稿する。notices があれば投稿の前に行を書き（Web UI で見る）、投稿できたら message_id と posted_at を入れる。
// 同じサーバー・同じ本文の未投稿の行があればそれを使うので、やり直しで行は増えない。投稿の文面・やり直しの規則は呼び出し側が持つ
import type { Gateway, OutgoingMessage } from "../discord/gateway.ts";
import type { GuildSettingsStore } from "../store/guild-settings.ts";
import type { NoticeLevel, NoticeStore } from "../store/notices.ts";
import { SHELL_NOTICE_TIMEOUT_MS, withTimeout } from "./shell-state.ts";

/**
 * そのサーバーの #system に message を投稿し、メッセージの ID を返す。#system が無ければ undefined（記録の行は未投稿のまま残る）。
 * 投稿の失敗・時間切れ（timeoutMs。既定は SHELL_NOTICE_TIMEOUT_MS。null なら時間切れなしで待つ）は投げる（行は未投稿のまま。やり直すかは呼び出し側が決める）
 */
export type SystemNotifier = (
  guildId: string,
  message: OutgoingMessage,
  options: { level: NoticeLevel; timeoutMs?: number | null },
) => Promise<string | undefined>;

export type SystemNotifierDeps = {
  /** 投稿先（#system） */
  guildSettings: Pick<GuildSettingsStore, "get">;
  /** 既定の人格の Bot */
  gateway: Pick<Gateway, "sendMessage">;
  /** 知らせの記録（Web UI が有効なときだけ渡す）。無ければ記録せずに投稿だけする */
  notices?: Pick<NoticeStore, "add" | "findUnposted" | "markPosted">;
  log: (message: string) => void;
};

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function createSystemNotifier(deps: SystemNotifierDeps): SystemNotifier {
  const { guildSettings, gateway, notices, log } = deps;
  return async (guildId, message, options) => {
    // 記録の失敗では投稿を止めない（log に出すだけ。本文は出さない）
    let id: number | undefined;
    if (notices !== undefined) {
      try {
        id = notices.findUnposted(guildId, message.text)?.id ?? notices.add({ guildId, level: options.level, text: message.text });
      } catch (error) {
        log(`#system への知らせの記録に失敗しました（guild=${guildId}）: ${describeError(error)}`);
      }
    }
    const systemChannelId = guildSettings.get(guildId)?.systemChannelId ?? null;
    if (systemChannelId === null) return undefined;
    const sending = gateway.sendMessage(systemChannelId, message);
    const messageId = options.timeoutMs === null ? await sending : await withTimeout(sending, options.timeoutMs ?? SHELL_NOTICE_TIMEOUT_MS);
    if (notices !== undefined && id !== undefined) {
      try {
        notices.markPosted(id, messageId);
      } catch (error) {
        log(`#system への知らせの記録に失敗しました（guild=${guildId}）: ${describeError(error)}`);
      }
    }
    return messageId;
  };
}
