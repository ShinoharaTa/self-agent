// リマインドの操作を Discord（/reminders の [次の回を飛ばす]・[止める]）と Web（/api/reminders/<id>/skip・/cancel）で共通にする（docs/plan/web-ui.md §3.4）。
// 文面と log は呼び出し側が持つ
import type { ReminderStore } from "../store/reminders.ts";
import { nextOccurrence } from "./recurrence.ts";

export type SkipNextResult = { result: "skipped"; skipped: Date; next: Date } | { result: "not_found" } | { result: "stale" };

/**
 * 繰り返しの次の回を飛ばす。無い id は not_found、active でない・1 回だけ・次の回が無い・書き換えられなかった（その間に変わった）なら stale。
 * skipped は飛ばした回（今の next_at）、next はその次の回（timeZone の壁時計で求める）
 */
export function skipNextOf(reminders: Pick<ReminderStore, "get" | "skipNext">, id: number, timeZone: string): SkipNextResult {
  const reminder = reminders.get(id);
  if (reminder === undefined) return { result: "not_found" };
  if (reminder.status !== "active") return { result: "stale" };
  const skipped = reminder.nextAt === null ? undefined : new Date(reminder.nextAt);
  const next = reminder.rule === null || skipped === undefined ? null : nextOccurrence(reminder.rule, skipped, timeZone);
  if (skipped === undefined || next === null || !reminders.skipNext(id, next)) return { result: "stale" };
  return { result: "skipped", skipped, next };
}

/** リマインドを止める。無い id は not_found、active でない・止められなかった（その間に変わった）なら stale */
export function cancelOf(reminders: Pick<ReminderStore, "get" | "cancel">, id: number): "cancelled" | "not_found" | "stale" {
  const reminder = reminders.get(id);
  if (reminder === undefined) return "not_found";
  if (reminder.status !== "active" || !reminders.cancel(id)) return "stale";
  return "cancelled";
}
