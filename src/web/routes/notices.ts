// GET /api/notices（docs/plan/web-ui.md §7.1）。#system に出した知らせの記録（notices）の新しい順と、直近 24 時間の件数（ステータスバー）。
// link は投稿できた行（message_id がある）で、そのサーバーの #system が分かるときだけ。log には本文を出さない
import type { GuildSettingsStore } from "../../store/guild-settings.ts";
import { NOTICE_LIST_MAX, type NoticeRow, type NoticeStore } from "../../store/notices.ts";
import type { Route, RouteResult } from "../server.ts";

/** /api/notices の last の既定（上限は NOTICE_LIST_MAX） */
export const NOTICES_DEFAULT_LAST = 50;
/** recent24h に数える時間 */
const RECENT_MS = 24 * 60 * 60 * 1000;

export type NoticeRouteDeps = {
  notices: Pick<NoticeStore, "listRecent" | "countSince">;
  /** 投稿した #system（Discord のリンク） */
  guildSettings: Pick<GuildSettingsStore, "get">;
  now: () => Date;
};

const BAD_REQUEST: RouteResult = { status: 400, json: { error: "bad_request" } };

/** 1〜max の整数。省略は fallback、それ以外の形は undefined */
function boundedInt(value: string | null, fallback: number, max: number): number | undefined {
  if (value === null) return fallback;
  if (!/^\d+$/.test(value)) return undefined;
  const parsed = Number(value);
  return parsed >= 1 && parsed <= max ? parsed : undefined;
}

export function noticeRoutes(deps: NoticeRouteDeps): Route[] {
  const { notices, guildSettings, now } = deps;
  const linkOf = (row: NoticeRow): string | null => {
    if (row.messageId === null) return null;
    const systemChannelId = guildSettings.get(row.guildId)?.systemChannelId ?? null;
    return systemChannelId === null ? null : `https://discord.com/channels/${row.guildId}/${systemChannelId}/${row.messageId}`;
  };
  return [
    {
      method: "GET",
      pattern: /^\/api\/notices$/,
      handle: async ({ query }) => {
        const last = boundedInt(query.get("last"), NOTICES_DEFAULT_LAST, NOTICE_LIST_MAX);
        if (last === undefined) return BAD_REQUEST;
        return {
          status: 200,
          json: {
            notices: notices.listRecent(last).map((row) => ({
              id: row.id,
              at: row.at,
              guildId: row.guildId,
              level: row.level,
              text: row.text,
              link: linkOf(row),
            })),
            recent24h: notices.countSince(new Date(now().getTime() - RECENT_MS)),
          },
        };
      },
    },
  ];
}
