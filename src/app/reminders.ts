// リマインドの発火（docs/plan/reminders.md §2.4〜§2.6・§5）。5 分の Scheduler とは別に、分の境目にそろえた 1 分ごとの tick で DB を見る。
// 永続のタイマーは持たないので、止まっていた間に過ぎた分は起動直後の tick で拾う。notify は「投稿してから進める」（少なくとも 1 回届く）。
// prompt（予約した依頼）の実行は PR-R3 まで未対応で、来たら log に出して止める
import type { Config } from "../config.ts";
import type { ButtonDef, Gateway, OutgoingMessage } from "../discord/gateway.ts";
import { mentionPrefix } from "../discord/convert.ts";
import type { GuildSettingsStore } from "../store/guild-settings.ts";
import type { FireUpdate, Reminder, ReminderStore } from "../store/reminders.ts";
import type { TaskStore } from "../store/tasks.ts";
import type { TopicSessionStore } from "../store/topic-sessions.ts";
import { MESSAGE_MAX_LENGTH } from "./commands/sessions.ts";
import { clip } from "./commands/tasks.ts";
import { describeRule, nextOccurrence } from "./recurrence.ts";
import { offsetMs } from "./time.ts";

/** tick は次の分の境目からこれだけ後に行う（境目ちょうどの時刻を確実に過ぎてから見る） */
export const REMINDER_TICK_OFFSET_MS = 200;
/** 1 回の tick で処理する件数の上限（残りは次の tick） */
export const REMINDER_BATCH_LIMIT = 20;
/** 同じ回の投稿にこの回数失敗したら、その回は諦めて進める（回数はプロセス内で覚える） */
export const REMINDER_MAX_ATTEMPTS = 30;
/** 繰り返しの、止まっていた間に過ぎた最後の回がこれより古ければ出さずに次の回へ進める */
export const REMINDER_STALE_MS = 12 * 60 * 60 * 1000;
/** 1 回だけのものが予定からこれ以上遅れたら、遅れの注記を添える */
export const REMINDER_LATE_NOTE_MS = 5 * 60 * 1000;
/** 止まっていた間に過ぎた回を数える上限 */
export const REMINDER_CATCH_UP_LIMIT = 400;
/** スヌーズの選択肢（分） */
export const REMINDER_SNOOZE_MINUTES = [10, 60] as const;
/** 発火のメッセージのボタンの custom_id の名前空間（`rem:done:<id>:<seq>` など） */
export const REMINDER_NAMESPACE = "rem";

const MINUTE_MS = 60_000;
const DAY_MS = 24 * 60 * MINUTE_MS;
/** getUTCDay（0 = 日曜）の順の表示 */
const DAY_OF_WEEK_LABELS = ["日", "月", "火", "水", "木", "金", "土"];

/** その時刻の timeZone の壁時計を UTC として表したもの（getUTC* で読む） */
function toWall(at: Date, timeZone: string): Date {
  return new Date(at.getTime() + offsetMs(at, timeZone));
}

/** 例: 9:05 */
export function formatShortTime(at: Date, timeZone: string): string {
  const wall = toWall(at, timeZone);
  return `${wall.getUTCHours()}:${String(wall.getUTCMinutes()).padStart(2, "0")}`;
}

/** 例: 10/14(水) */
export function formatShortDate(at: Date, timeZone: string): string {
  const wall = toWall(at, timeZone);
  return `${wall.getUTCMonth() + 1}/${wall.getUTCDate()}(${DAY_OF_WEEK_LABELS[wall.getUTCDay()]})`;
}

/** 例: 10/14(水) 9:05 */
export function formatShortDateTime(at: Date, timeZone: string): string {
  return `${formatShortDate(at, timeZone)} ${formatShortTime(at, timeZone)}`;
}

/** スヌーズの表示（10 分後・1 時間後） */
export function snoozeLabel(minutes: number): string {
  return minutes % 60 === 0 ? `${minutes / 60} 時間後` : `${minutes} 分後`;
}

/**
 * 発火のメッセージの本文のうち、DB から作り直せる部分: `リマインド: <text>`、紐づけたタスク `（#12 <題名>）`、繰り返し `（毎週 月・水 8:00）`。
 * ボタンを押した後・前の回のボタンを外すときの書き換えにも使う
 */
export function reminderBaseLines(reminder: Pick<Reminder, "text" | "taskId" | "rule">, taskTitle: string | undefined): string[] {
  const lines = [`リマインド: ${reminder.text}`];
  if (reminder.taskId !== null) {
    lines.push(taskTitle === undefined ? `（#${reminder.taskId}）` : `（#${reminder.taskId} ${taskTitle}）`);
  }
  if (reminder.rule !== null) lines.push(`（${describeRule(reminder.rule)}）`);
  return lines;
}

/**
 * 発火のメッセージのボタン（seq は投稿した後の fire_seq）。
 * 1 回だけ: [完了][10 分後][1 時間後]。繰り返し: [済んだ][10 分後][1 時間後][止める]
 */
export function reminderFireButtons(reminder: Pick<Reminder, "id" | "rule">, seq: number): ButtonDef[] {
  const { id } = reminder;
  const repeating = reminder.rule !== null;
  return [
    { customId: `${REMINDER_NAMESPACE}:done:${id}:${seq}`, label: repeating ? "済んだ" : "完了", style: "success" },
    ...REMINDER_SNOOZE_MINUTES.map(
      (minutes): ButtonDef => ({ customId: `${REMINDER_NAMESPACE}:snooze:${minutes}:${id}:${seq}`, label: snoozeLabel(minutes) }),
    ),
    ...(repeating ? [{ customId: `${REMINDER_NAMESPACE}:stop:${id}:${seq}`, label: "止める", style: "danger" as const }] : []),
  ];
}

/** 元のチャンネルが無いため #tasks・#inbox に出したときの注記 */
export const MOVED_NOTE = "（元のチャンネルが無いため、ここに出しました）";

/** テストでは偽のタイマーに差し替える */
export type ReminderTimers = {
  /** ms 後に fn を 1 回呼び、取り消す関数を返す */
  after(fn: () => void, ms: number): () => void;
};

const REAL_TIMERS: ReminderTimers = {
  after: (fn, ms) => {
    const timer = setTimeout(fn, ms);
    return () => clearTimeout(timer);
  },
};

export type ReminderSchedulerDeps = {
  /** ownerUserId はメンションする相手、timeZone は注記の時刻と繰り返しの計算 */
  cfg: Pick<Config, "ownerUserId" | "timeZone">;
  reminders: Pick<
    ReminderStore,
    "listDue" | "get" | "markFired" | "complete" | "clearSnooze" | "cancel" | "skipNext" | "moveChannel"
  >;
  /** 紐づけたタスクが open か確かめ、本文に題名を出す */
  tasks: Pick<TaskStore, "get">;
  /** 頼んだチャンネルが無いときの投稿先（そのサーバーの #tasks、無ければ #inbox） */
  guildSettings: Pick<GuildSettingsStore, "get">;
  /** 頼んだチャンネルが削除済みのセッションか */
  topicSessions: Pick<TopicSessionStore, "get">;
  gateway: Pick<Gateway, "sendMessage" | "editMessage" | "channelExists">;
  now: () => Date;
  timers?: ReminderTimers;
  log: (message: string) => void;
};

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** 今回知らせる回 */
type Occurrence = {
  /** 回の時刻 */
  at: Date;
  /** スヌーズで決めた回か */
  snooze: boolean;
  /** 止まっていた間に過ぎた回の数（今回の回を含む。スヌーズは 1） */
  count: number;
};

type PostResult = { kind: "posted"; channelId: string; messageId: string } | { kind: "nowhere" };

export class ReminderScheduler {
  private readonly deps: ReminderSchedulerDeps;
  private readonly timers: ReminderTimers;
  /** 次の tick のタイマーを取り消す関数。start 前・stop 後は undefined */
  private cancelTimer: (() => void) | undefined;
  private started = false;
  private stopped = false;
  /** 実行中の tick */
  private running: Promise<void> | undefined;
  /** 投稿に失敗した回数（`<id>:<fire_seq>` ごと。プロセス内だけ） */
  private readonly failures = new Map<string, number>();

  constructor(deps: ReminderSchedulerDeps) {
    this.deps = deps;
    this.timers = deps.timers ?? REAL_TIMERS;
  }

  /** 直後に 1 回 tick し、以後は次の分の境目 + 200ms ごとに tick する。stop の後・2 回目は何もしない */
  start(): void {
    if (this.stopped || this.started) return;
    this.started = true;
    void this.tick();
    this.schedule();
  }

  /** 以後の tick を止める。実行中の tick は、まだ始めていない発火を行わずに終わる（終わるのは idle で待つ） */
  stop(): void {
    this.stopped = true;
    this.cancelTimer?.();
    this.cancelTimer = undefined;
  }

  /** 実行中の tick（投稿を含む）が終わったら resolve する（停止時に使う） */
  idle(): Promise<void> {
    return this.running ?? Promise.resolve();
  }

  /** 1 回分の処理。前の tick が終わっていなければ重ねずにそれを返す。reject しない（失敗は log に出す） */
  tick(): Promise<void> {
    if (this.running !== undefined) return this.running;
    const running = this.runTick().finally(() => {
      this.running = undefined;
    });
    this.running = running;
    return running;
  }

  /** 次の分の境目 + 200ms に tick する。毎回 now から求めるので、ずれは溜まらない */
  private schedule(): void {
    if (this.stopped) return;
    const now = this.deps.now().getTime();
    const delay = MINUTE_MS - (now % MINUTE_MS) + REMINDER_TICK_OFFSET_MS;
    this.cancelTimer = this.timers.after(() => {
      this.cancelTimer = undefined;
      void this.tick();
      this.schedule();
    }, delay);
  }

  private async runTick(): Promise<void> {
    const { reminders, now, log } = this.deps;
    if (this.stopped) return;
    try {
      const at = now();
      for (const listed of reminders.listDue(at, REMINDER_BATCH_LIMIT)) {
        // 停止を始めたら、まだ始めていない発火は行わない（次の起動の最初の tick で拾う）
        if (this.stopped) return;
        // 前の件を投稿している間に止められた・ボタンで変えられたものは出さない（読み直して確かめる）
        const reminder = reminders.get(listed.id);
        if (reminder === undefined || reminder.fireSeq !== listed.fireSeq || !isDue(reminder, at)) continue;
        try {
          await this.fire(reminder, at);
        } catch (error) {
          log(`リマインドの処理に失敗しました（#${reminder.id}）: ${describeError(error)}`);
        }
      }
    } catch (error) {
      log(`リマインドの確認に失敗しました: ${describeError(error)}`);
    }
  }

  private async fire(reminder: Reminder, now: Date): Promise<void> {
    const { reminders, tasks, gateway, log } = this.deps;
    const { id } = reminder;
    if (reminder.kind === "prompt") {
      // 予約した依頼の実行は PR-R3 で入れる
      reminders.cancel(id);
      log(`予約した依頼は未対応のため止めました（#${id}）`);
      return;
    }
    let taskTitle: string | undefined;
    if (reminder.taskId !== null) {
      const task = tasks.get(reminder.taskId);
      if (task === undefined || task.status !== "open") {
        reminders.complete(id);
        log(`紐づけたタスクが閉じているため知らせませんでした（#${id}）`);
        return;
      }
      taskTitle = task.title;
    }

    const occurrence = this.occurrence(reminder, now);
    if (occurrence === undefined) return;
    const update = this.nextUpdate(reminder, occurrence, now);

    const key = `${id}:${reminder.fireSeq}`;
    let result: PostResult;
    try {
      result = await this.post(reminder, (moved) => this.message(reminder, taskTitle, occurrence, now, moved));
    } catch (error) {
      const failures = (this.failures.get(key) ?? 0) + 1;
      if (failures < REMINDER_MAX_ATTEMPTS) {
        // DB は変えないので、次の tick でやり直す
        this.failures.set(key, failures);
        log(`リマインドの投稿に失敗しました（#${id}、guild=${reminder.guildId}）: ${describeError(error)}`);
        return;
      }
      this.failures.delete(key);
      this.giveUp(reminder, occurrence, now);
      log(`リマインドの投稿に ${REMINDER_MAX_ATTEMPTS} 回失敗したため、この回を諦めました（#${id}、guild=${reminder.guildId}）: ${describeError(error)}`);
      return;
    }
    this.failures.delete(key);
    if (result.kind === "nowhere") {
      this.giveUp(reminder, occurrence, now);
      log(`リマインドの投稿先が無いため、この回を諦めました（#${id}、guild=${reminder.guildId}）`);
      return;
    }

    if (!reminders.markFired(id, reminder.fireSeq, { ...update, messageId: result.messageId })) {
      // 投稿している間に止められた。いま投稿したメッセージのボタンは押しても古いので外す
      log(`投稿している間にリマインドが止められたため、記録しませんでした（#${id}）`);
      try {
        await gateway.editMessage(result.channelId, result.messageId, {
          text: reminderBaseLines(reminder, taskTitle).join("\n"),
          components: [],
        });
      } catch (error) {
        log(`リマインドのボタンを外せませんでした（#${id}）: ${describeError(error)}`);
      }
      return;
    }
    const moved = result.channelId !== reminder.channelId;
    if (moved) reminders.moveChannel(id, result.channelId);
    const lateMinutes = Math.floor((now.getTime() - occurrence.at.getTime()) / MINUTE_MS);
    log(`リマインドを知らせました（#${id}、guild=${reminder.guildId}、遅れ ${lateMinutes} 分）`);
    // 移したときは前のチャンネルが無いので、前の回のボタンは外せない
    if (!moved) await this.clearPreviousButtons(reminder, taskTitle);
  }

  /**
   * この回を出さずに進める（投稿に 30 回失敗した・投稿先が無い）。1 回だけなら完了に、
   * 繰り返しのスヌーズの回ならスヌーズを消し、繰り返しの規則による回なら次の回へ（無ければ止める）
   */
  private giveUp(reminder: Reminder, occurrence: Occurrence, now: Date): void {
    const { cfg, reminders } = this.deps;
    if (reminder.rule === null) {
      reminders.complete(reminder.id);
      return;
    }
    if (occurrence.snooze) {
      reminders.clearSnooze(reminder.id);
      return;
    }
    const next = nextOccurrence(reminder.rule, now, cfg.timeZone);
    if (next === null) reminders.cancel(reminder.id);
    else reminders.skipNext(reminder.id, next);
  }

  /**
   * 今回知らせる回。規則による回（next_at）が due ならそれを優先し（スヌーズは markFired で消える）、繰り返しは過ぎた最後の回とその数を求める。
   * 繰り返しで最後の回が 12 時間より古ければ、出さずに次の回へ進めて undefined
   */
  private occurrence(reminder: Reminder, now: Date): Occurrence | undefined {
    const { cfg, reminders, log } = this.deps;
    const nowMs = now.getTime();
    if (reminder.nextAt !== null && new Date(reminder.nextAt).getTime() <= nowMs) {
      let at = new Date(reminder.nextAt);
      let count = 1;
      if (reminder.rule !== null) {
        while (count < REMINDER_CATCH_UP_LIMIT) {
          const next = nextOccurrence(reminder.rule, at, cfg.timeZone);
          if (next === null || next.getTime() > nowMs) break;
          at = next;
          count++;
        }
        if (nowMs - at.getTime() > REMINDER_STALE_MS) {
          const next = nextOccurrence(reminder.rule, now, cfg.timeZone);
          if (next === null) reminders.cancel(reminder.id);
          else {
            reminders.skipNext(reminder.id, next);
            // 飛ばした回より前のスヌーズも古いので、次の tick で鳴らさない
            reminders.clearSnooze(reminder.id);
          }
          log(`止まっていた間に過ぎたため飛ばしました（#${reminder.id}、${count} 回）`);
          return undefined;
        }
      }
      return { at, snooze: false, count };
    }
    // listDue が返したので、next_at が due でなければ snooze_at が due
    const at = new Date(reminder.snoozeAt ?? now.toISOString());
    if (reminder.rule !== null && nowMs - at.getTime() > REMINDER_STALE_MS) {
      // 繰り返しのスヌーズも、12 時間より古ければ出さない（1 回だけのものは遅れの注記付きで出す）
      reminders.clearSnooze(reminder.id);
      log(`止まっていた間に過ぎたため飛ばしました（#${reminder.id}、スヌーズ）`);
      return undefined;
    }
    return { at, snooze: true, count: 1 };
  }

  /**
   * 知らせた後の next_at と状態。規則による回: 1 回だけなら next_at を消して fired、繰り返しなら次の回へ（無ければ done）。
   * スヌーズの回: next_at は変えず、1 回だけ（next_at が無い）なら fired
   */
  private nextUpdate(reminder: Reminder, occurrence: Occurrence, now: Date): FireUpdate {
    if (occurrence.snooze) {
      const nextAt = reminder.nextAt === null ? null : new Date(reminder.nextAt);
      return { nextAt, status: nextAt === null ? "fired" : "active", firedAt: now };
    }
    if (reminder.rule === null) return { nextAt: null, status: "fired", firedAt: now };
    const nextAt = nextOccurrence(reminder.rule, now, this.deps.cfg.timeZone);
    return { nextAt, status: nextAt === null ? "done" : "active", firedAt: now };
  }

  /** 発火のメッセージ。オーナーをメンションし、本文はメンションの分を差し引いて 2000 字に収める */
  private message(
    reminder: Reminder,
    taskTitle: string | undefined,
    occurrence: Occurrence,
    now: Date,
    moved: boolean,
  ): OutgoingMessage {
    const { cfg } = this.deps;
    const lines = reminderBaseLines(reminder, taskTitle);
    if (occurrence.snooze) lines.push("（もう一度）");
    const late = now.getTime() - occurrence.at.getTime();
    if (reminder.rule === null && late >= REMINDER_LATE_NOTE_MS) {
      lines.push(
        late >= DAY_MS
          ? `（${formatShortDateTime(occurrence.at, cfg.timeZone)} の予定でした）`
          : `（${formatShortTime(occurrence.at, cfg.timeZone)} の予定・${Math.floor(late / MINUTE_MS)} 分遅れ）`,
      );
    }
    if (occurrence.count >= 2) lines.push(`（ほか ${occurrence.count - 1} 回分は止まっていた間に過ぎました）`);
    if (moved) lines.push(MOVED_NOTE);
    const mention = cfg.ownerUserId;
    const limit = MESSAGE_MAX_LENGTH - (mention === undefined ? 0 : mentionPrefix(mention).length);
    return {
      text: clip(lines.join("\n"), limit),
      components: [{ kind: "buttons", buttons: reminderFireButtons(reminder, reminder.fireSeq + 1) }],
      ...(mention === undefined ? {} : { mentionUserId: mention }),
    };
  }

  /**
   * 頼んだチャンネル → そのサーバーの #tasks → #inbox の順に投稿する。頼んだチャンネルが削除済みのセッションなら最初から飛ばす。
   * 投稿に失敗して channelExists が false なら次の候補へ。あるのに失敗した・確かめられなければ投げる（この回はやり直す）。
   * どれも無ければ nowhere
   */
  private async post(reminder: Reminder, build: (moved: boolean) => OutgoingMessage): Promise<PostResult> {
    const { guildSettings, topicSessions, gateway } = this.deps;
    const candidates: string[] = [];
    if (topicSessions.get(reminder.channelId)?.state !== "deleted") candidates.push(reminder.channelId);
    const settings = guildSettings.get(reminder.guildId);
    for (const channelId of [settings?.tasksChannelId, settings?.inboxChannelId]) {
      if (channelId !== null && channelId !== undefined && channelId !== reminder.channelId && !candidates.includes(channelId)) {
        candidates.push(channelId);
      }
    }
    for (const channelId of candidates) {
      try {
        const messageId = await gateway.sendMessage(channelId, build(channelId !== reminder.channelId));
        return { kind: "posted", channelId, messageId };
      } catch (error) {
        if (await gateway.channelExists(channelId)) throw error;
      }
    }
    return { kind: "nowhere" };
  }

  /** 前の回のメッセージのボタンを外す（本文は DB から作り直し、メンションは付けない）。失敗は log だけ */
  private async clearPreviousButtons(reminder: Reminder, taskTitle: string | undefined): Promise<void> {
    const { gateway, log } = this.deps;
    if (reminder.lastMessageId === null) return;
    try {
      await gateway.editMessage(reminder.channelId, reminder.lastMessageId, {
        text: reminderBaseLines(reminder, taskTitle).join("\n"),
        components: [],
      });
    } catch (error) {
      log(`前のリマインドのボタンを外せませんでした（#${reminder.id}）: ${describeError(error)}`);
    }
  }
}

/** active で、next_at か snooze_at が now 以前（listDue と同じ条件） */
function isDue(reminder: Reminder, now: Date): boolean {
  if (reminder.status !== "active") return false;
  const nowMs = now.getTime();
  return [reminder.nextAt, reminder.snoozeAt].some((at) => at !== null && new Date(at).getTime() <= nowMs);
}
