// GET /api/reminders・POST /api/reminders/<id>/cancel・/skip（docs/plan/web-ui.md §3.4）。active のリマインドと予約した依頼の一覧と、止める・次の回を飛ばす。
// 操作は Discord の /reminders と同じ reminders-ops.ts。log に本文・チャンネル ID は出さない
import type { Config } from "../../config.ts";
import { describeRule } from "../../app/recurrence.ts";
import { cancelOf, skipNextOf } from "../../app/reminders-ops.ts";
import type { Reminder, ReminderStore } from "../../store/reminders.ts";
import type { Route, RouteResult } from "../server.ts";

/** 一覧に出す件数の上限（active の上限と同じ。/reminders の一覧と同じ） */
export const WEB_REMINDER_LIST_LIMIT = 50;

export type ReminderRouteDeps = {
  cfg: Pick<Config, "timeZone">;
  reminders: Pick<ReminderStore, "listActive" | "get" | "cancel" | "skipNext">;
  /** チャンネルの表示名（channels.ts の webChannelNamer）。Web で開けないチャンネルは null */
  channelName: (channelId: string) => string | null;
  log: (message: string) => void;
};

const NOT_FOUND: RouteResult = { status: 404, json: { error: "not_found" } };
const STALE: RouteResult = { status: 409, json: { error: "stale" } };

/** 次に知らせる時刻（next_at と snooze_at の早い方。ISO）。どちらも無ければ null */
function earliestAt(reminder: Reminder): string | null {
  const times = [reminder.nextAt, reminder.snoozeAt].filter((at): at is string => at !== null);
  if (times.length === 0) return null;
  return new Date(Math.min(...times.map((at) => Date.parse(at)))).toISOString();
}

export function reminderRoutes(deps: ReminderRouteDeps): Route[] {
  const { cfg, reminders, channelName, log } = deps;
  return [
    {
      method: "GET",
      pattern: /^\/api\/reminders$/,
      handle: async () => ({
        status: 200,
        json: {
          reminders: reminders.listActive(WEB_REMINDER_LIST_LIMIT).map((reminder) => ({
            id: reminder.id,
            kind: reminder.kind,
            text: reminder.text,
            rule: reminder.rule,
            ruleText: reminder.rule === null ? null : describeRule(reminder.rule),
            nextAt: earliestAt(reminder),
            channelId: reminder.channelId,
            channelName: channelName(reminder.channelId),
            taskId: reminder.taskId,
            link: `https://discord.com/channels/${reminder.guildId}/${reminder.channelId}`,
          })),
        },
      }),
    },
    {
      method: "POST",
      pattern: /^\/api\/reminders\/(\d{1,15})\/cancel$/,
      handle: async ({ params }) => {
        const id = Number(params[0]);
        const result = cancelOf(reminders, id);
        if (result === "not_found") return NOT_FOUND;
        if (result === "stale") return STALE;
        log(`Web でリマインドを止めました（#${id}）`);
        return { status: 200, json: { cancelled: true } };
      },
    },
    {
      method: "POST",
      pattern: /^\/api\/reminders\/(\d{1,15})\/skip$/,
      handle: async ({ params }) => {
        const id = Number(params[0]);
        const result = skipNextOf(reminders, id, cfg.timeZone);
        if (result.result === "not_found") return NOT_FOUND;
        if (result.result === "stale") return STALE;
        log(`Web でリマインドの次の回を飛ばしました（#${id}）`);
        return { status: 200, json: { skipped: result.skipped.toISOString(), next: result.next.toISOString() } };
      },
    },
  ];
}
