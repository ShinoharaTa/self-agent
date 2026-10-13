// リマインドの発火のメッセージのボタンと /reminders（名前空間 `rem:`。docs/plan/reminders.md §2.6・§6）
import type { Config } from "../../config.ts";
import type { InteractionResponder, OutgoingMessage } from "../../discord/gateway.ts";
import type { Reminder, ReminderStore } from "../../store/reminders.ts";
import type { TaskStore } from "../../store/tasks.ts";
import type { CommandHandler, ComponentHandler } from "../interactions.ts";
import { nextOccurrence, describeRule } from "../recurrence.ts";
import {
  formatShortDate,
  formatShortDateTime,
  formatShortTime,
  REMINDER_NAMESPACE,
  REMINDER_SNOOZE_MINUTES,
  reminderBaseLines,
  snoozeLabel,
} from "../reminders.ts";
import { STALE_TEXT } from "./delete.ts";
import { fitItems, omittedText } from "./sessions.ts";
import { clip } from "./tasks.ts";
import { STALE_TURN_REPLY } from "./turn-controls.ts";

export const NO_REMINDERS_TEXT = "リマインドはありません";
/** 一覧に出す件数の上限（active の上限と同じ） */
export const REMINDER_LIST_LIMIT = 50;
/** セレクトに出す件数の上限（Discord のセレクトの選択肢の上限） */
export const REMINDER_SELECT_LIMIT = 25;

const PICK_SELECT_ID = `${REMINDER_NAMESPACE}:pick`;
/** セレクトの選択肢のラベルの上限（Discord は 100 字まで） */
const OPTION_LABEL_MAX_LENGTH = 100;
const MINUTE_MS = 60_000;

export type RemindersDeps = {
  reminders: Pick<
    ReminderStore,
    "listActive" | "get" | "complete" | "clearSnooze" | "snooze" | "cancel" | "skipNext"
  >;
  /** [完了] で紐づけたタスクも完了にし、書き換えた本文に題名を出す */
  tasks: Pick<TaskStore, "get" | "complete">;
  /** 時刻の表示と、次の回の計算のタイムゾーン（SELF_AGENT_TZ） */
  cfg: Pick<Config, "timeZone">;
  log: (message: string) => void;
};

/** 次に知らせる時刻（next_at と snooze_at の早い方） */
function earliestAt(reminder: Reminder): Date | undefined {
  const times = [reminder.nextAt, reminder.snoozeAt].filter((at): at is string => at !== null).map((at) => new Date(at));
  if (times.length === 0) return undefined;
  return new Date(Math.min(...times.map((at) => at.getTime())));
}

/**
 * 一覧の 1 行。繰り返し: `#3 毎日 8:00 今日のタスクを出す（依頼・<#ch>）次 10/14(水) 8:00`。
 * 1 回だけ: `#5 10/14(水) 9:00 洗濯物（<#ch>）`（依頼は予約した依頼（prompt）のときだけ付ける）
 */
export function reminderLine(reminder: Reminder, timeZone: string): string {
  const at = earliestAt(reminder);
  const when = at === undefined ? "" : formatShortDateTime(at, timeZone);
  const where = `（${reminder.kind === "prompt" ? "依頼・" : ""}<#${reminder.channelId}>）`;
  if (reminder.rule === null) return `#${reminder.id} ${when} ${reminder.text}${where}`;
  return `#${reminder.id} ${describeRule(reminder.rule)} ${reminder.text}${where}次 ${when}`;
}

/**
 * active のリマインドの一覧（次に知らせる順。最大 50 件）と、選ぶセレクト（`rem:pick`、表示した分のうち最大 25 件）。
 * 2000 字を超えるなら末尾から削って「ほか n 件」を足す。0 件なら「リマインドはありません」だけ
 */
export function reminderListMessage(deps: Pick<RemindersDeps, "reminders" | "cfg">): OutgoingMessage {
  const { reminders, cfg } = deps;
  const list = reminders.listActive(REMINDER_LIST_LIMIT);
  if (list.length === 0) return { text: NO_REMINDERS_TEXT, components: [] };
  const { text, shown } = fitItems(list, (items, omitted) =>
    [...items.map((reminder) => reminderLine(reminder, cfg.timeZone)), ...(omitted > 0 ? [omittedText(omitted)] : [])].join("\n"),
  );
  return {
    text,
    components: [
      {
        kind: "select",
        select: {
          customId: PICK_SELECT_ID,
          placeholder: "止める・飛ばすものを選ぶ",
          minValues: 1,
          maxValues: 1,
          options: shown.slice(0, REMINDER_SELECT_LIMIT).map((reminder) => ({
            label: clip(`#${reminder.id} ${reminder.text}`, OPTION_LABEL_MAX_LENGTH),
            value: String(reminder.id),
          })),
        },
      },
    ],
  };
}

/** /reminders で選んだものの詳細。[次の回を飛ばす]（`rem:skip:<id>`、繰り返しだけ）と [止める]（`rem:cancel:<id>`） */
export function reminderDetailMessage(reminder: Reminder, timeZone: string): OutgoingMessage {
  return {
    text: reminderLine(reminder, timeZone),
    components: [
      {
        kind: "buttons",
        buttons: [
          ...(reminder.rule === null
            ? []
            : [{ customId: `${REMINDER_NAMESPACE}:skip:${reminder.id}`, label: "次の回を飛ばす" }]),
          { customId: `${REMINDER_NAMESPACE}:cancel:${reminder.id}`, label: "止める", style: "danger" as const },
        ],
      },
    ],
  };
}

/** id・seq の文字列（0 以上の整数）。それ以外なら undefined */
function parseNumber(raw: string | undefined): number | undefined {
  return raw !== undefined && /^\d+$/.test(raw) ? Number(raw) : undefined;
}

/** `/reminders`: active のリマインドと予約した依頼の一覧を本人にだけ表示し、セレクトで止める・飛ばすものを選べるようにする */
export function createRemindersCommand(deps: RemindersDeps): CommandHandler {
  return {
    def: { name: "reminders", description: "リマインドと予約した依頼の一覧を表示します（選んで止められます）" },
    async handle(_interaction, responder) {
      await responder.reply({ ...reminderListMessage(deps), ephemeral: true });
    },
  };
}

/**
 * 発火のメッセージのボタン（`rem:done:<id>:<seq>`・`rem:snooze:<10|60>:<id>:<seq>`・`rem:stop:<id>:<seq>`）と、
 * /reminders のセレクト（`rem:pick`）・詳細のボタン（`rem:skip:<id>`・`rem:cancel:<id>`）を受ける。DB の状態で動くので、再起動の後でも押せる
 */
export function createRemindersComponent(deps: RemindersDeps): ComponentHandler {
  const { reminders, tasks, cfg, log } = deps;

  /** 発火のメッセージを書き換える。本文は DB から作り直し、メンションは付けない */
  const rewrite = async (responder: InteractionResponder, id: number, result: string): Promise<void> => {
    const reminder = reminders.get(id)!;
    const taskTitle = reminder.taskId === null ? undefined : tasks.get(reminder.taskId)?.title;
    await responder.update({ text: [...reminderBaseLines(reminder, taskTitle), result].join("\n"), components: [] });
  };
  const stale = async (responder: InteractionResponder): Promise<void> => {
    await responder.reply({ text: STALE_TURN_REPLY, ephemeral: true });
  };

  return {
    namespace: REMINDER_NAMESPACE,
    async handle(interaction, responder) {
      if (interaction.customId === PICK_SELECT_ID) {
        if (interaction.kind !== "select") throw new Error(`rem の不明な操作です（${interaction.kind} pick）`);
        const id = parseNumber(interaction.values[0]);
        if (id === undefined) throw new Error("rem:pick の選択に id がありません");
        const reminder = reminders.get(id);
        // 一覧を出した後に止められた・知らせた
        if (reminder === undefined || reminder.status !== "active") {
          await responder.reply({ text: STALE_TEXT, ephemeral: true });
          return;
        }
        await responder.reply({ ...reminderDetailMessage(reminder, cfg.timeZone), ephemeral: true });
        return;
      }

      const parts = interaction.customId.split(":");
      const action = parts[1];
      if (interaction.kind !== "button") throw new Error(`rem の不明な操作です（${interaction.kind} ${action ?? ""}）`);

      if (action === "skip" || action === "cancel") {
        const id = parseNumber(parts[2]);
        if (id === undefined) throw new Error("rem の custom_id に id がありません");
        const reminder = reminders.get(id);
        if (reminder === undefined || reminder.status !== "active") {
          await responder.update({ text: STALE_TEXT, components: [] });
          return;
        }
        if (action === "cancel") {
          if (!reminders.cancel(id)) {
            await responder.update({ text: STALE_TEXT, components: [] });
            return;
          }
          log(`/reminders でリマインドを止めました（#${id}）`);
          await responder.update({ text: `止めました: ${reminder.text}`, components: [] });
          return;
        }
        const skipped = reminder.nextAt === null ? undefined : new Date(reminder.nextAt);
        const next =
          reminder.rule === null || skipped === undefined ? null : nextOccurrence(reminder.rule, skipped, cfg.timeZone);
        if (skipped === undefined || next === null || !reminders.skipNext(id, next)) {
          await responder.update({ text: STALE_TEXT, components: [] });
          return;
        }
        log(`/reminders でリマインドの次の回を飛ばしました（#${id}）`);
        await responder.update({
          text: `次の回（${formatShortDate(skipped, cfg.timeZone)}）を飛ばしました。次は ${formatShortDateTime(next, cfg.timeZone)}`,
          components: [],
        });
        return;
      }

      // 発火のメッセージのボタン。seq が今の fire_seq と違う・状態が合わなければ、ストアが書き換えずに false を返す
      if (action === "done" || action === "stop") {
        const id = parseNumber(parts[2]);
        const seq = parseNumber(parts[3]);
        if (id === undefined || seq === undefined) throw new Error("rem の custom_id に id がありません");
        const reminder = reminders.get(id);
        if (reminder === undefined) {
          await stale(responder);
          return;
        }
        if (action === "stop") {
          if (reminder.rule === null || !reminders.cancel(id, seq)) {
            await stale(responder);
            return;
          }
          log(`[止める] でリマインドを止めました（#${id}）`);
          await rewrite(responder, id, "→ 止めました");
          return;
        }
        if (reminder.rule !== null) {
          if (!reminders.clearSnooze(id, seq)) {
            await stale(responder);
            return;
          }
          log(`[済んだ] でリマインドの回を確認しました（#${id}）`);
          await rewrite(responder, id, "→ 完了にしました");
          return;
        }
        if (!reminders.complete(id, seq)) {
          await stale(responder);
          return;
        }
        let note = "";
        // まだ open のタスクだけ完了にする（やめた・完了済みのタスクは変えない）
        if (reminder.taskId !== null && tasks.get(reminder.taskId)?.status === "open" && tasks.complete(reminder.taskId).result !== "not_found") {
          note = `（#${reminder.taskId} も完了にしました）`;
        }
        log(`[完了] でリマインドを完了にしました（#${id}）`);
        await rewrite(responder, id, `→ 完了にしました${note}`);
        return;
      }

      if (action === "snooze") {
        const minutes = parseNumber(parts[2]);
        const id = parseNumber(parts[3]);
        const seq = parseNumber(parts[4]);
        if (minutes === undefined || !(REMINDER_SNOOZE_MINUTES as readonly number[]).includes(minutes)) {
          throw new Error("rem:snooze の分が正しくありません");
        }
        if (id === undefined || seq === undefined) throw new Error("rem の custom_id に id がありません");
        const at = new Date(interaction.createdAt.getTime() + minutes * MINUTE_MS);
        if (!reminders.snooze(id, at, seq)) {
          await stale(responder);
          return;
        }
        log(`[${snoozeLabel(minutes)}] でリマインドを延ばしました（#${id}）`);
        await rewrite(responder, id, `→ ${snoozeLabel(minutes)}（${formatShortTime(at, cfg.timeZone)}）にもう一度知らせます`);
        return;
      }

      throw new Error(`rem の不明な操作です（${interaction.kind} ${action ?? ""}）`);
    },
  };
}
