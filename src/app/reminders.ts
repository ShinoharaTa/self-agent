// リマインドの発火（docs/plan/reminders.md §2.4〜§2.6・§5）。5 分の Scheduler とは別に、分の境目にそろえた 1 分ごとの tick で DB を見る。
// 永続のタイマーは持たないので、止まっていた間に過ぎた分は起動直後の tick で拾う。notify は「投稿してから進める」（少なくとも 1 回届く）。
// prompt（予約した依頼）は「進めてから動かす」（多くても 1 回）。ターンは発言と同じキューに入れ、tick では待たない
import type { RunResult } from "../agent/runner.ts";
import { type Config, DEFAULT_PERSONA_ID } from "../config.ts";
import type { ButtonDef, Gateway, OutgoingMessage } from "../discord/gateway.ts";
import { mentionPrefix } from "../discord/convert.ts";
import type { GuildSettingsStore } from "../store/guild-settings.ts";
import { type HistoryStore, recordHistory } from "../store/history.ts";
import type { FireUpdate, Reminder, ReminderStore } from "../store/reminders.ts";
import type { TaskStore } from "../store/tasks.ts";
import type { TopicSessionStore } from "../store/topic-sessions.ts";
import type { ChannelKind, ResolveChannel } from "./access.ts";
import { MESSAGE_MAX_LENGTH } from "./commands/sessions.ts";
import { clip } from "./commands/tasks.ts";
import { MAX_TURNS_REPLY } from "./commands/turn-controls.ts";
import { COMPACTED_NOTE, EMPTY_REPLY, turnOutcome } from "./handler.ts";
import { buildTurnPrompt } from "./prompt.ts";
import type { PersonaRouter } from "./personas.ts";
import type { KeyedSerialQueue } from "./queue.ts";
import { describeRule, nextOccurrence } from "./recurrence.ts";
import { offsetMs } from "./time.ts";
import { MAX_TURNS_ERROR_PREFIX, runChannelTurn, type TurnDeps } from "./turn.ts";

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
/** 元のチャンネルの持ち主（足した人格）の Bot に接続できない・その Bot で投稿できなかったため #tasks・#inbox に出したときの注記 */
export const OWNER_UNREACHABLE_NOTE = "（元のチャンネルの Bot に接続できないため、ここに出しました）";

/**
 * 予約した依頼のターンの prompt の本文（日時ヘッダの後ろ）。例: `予約した依頼（#3・毎日 8:00）:\n今日のタスクを出して`。
 * 遅れたときは late（例: `8:00 の予定から 25 分遅れ`）を括弧の中に足す
 */
export function scheduledPromptContent(reminder: Pick<Reminder, "id" | "rule" | "text">, late?: string): string {
  const repeat = reminder.rule === null ? "1 回だけ" : describeRule(reminder.rule);
  return `予約した依頼（#${reminder.id}・${repeat}${late === undefined ? "" : `・${late}`}）:\n${reminder.text}`;
}

/** 予約した依頼の返答の末尾に足す 1 行 */
export function scheduledReplyNote(id: number): string {
  return `（予約した依頼 #${id}）`;
}

/** 予約した依頼のターンが失敗したときの知らせ（手順の上限で止まったときは MAX_TURNS_REPLY） */
export function scheduledFailureText(id: number): string {
  return `予約した依頼（#${id}）を実行できませんでした`;
}

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
    "listDue" | "get" | "markFired" | "claim" | "complete" | "clearSnooze" | "cancel" | "skipNext" | "moveChannel"
  >;
  /** 紐づけたタスクが open か確かめ、本文に題名を出す */
  tasks: Pick<TaskStore, "get">;
  /** 頼んだチャンネルが無いときの投稿先（そのサーバーの #tasks、無ければ #inbox） */
  guildSettings: Pick<GuildSettingsStore, "get">;
  /** 頼んだチャンネルが削除済みのセッションか */
  topicSessions: Pick<TopicSessionStore, "get">;
  /** 投稿・書き換え・入力中表示はチャンネルの持ち主の Bot で行う（main で personas.ts の ownerPosts を渡す） */
  gateway: Pick<Gateway, "sendMessage" | "editMessage" | "channelExists" | "send" | "startTyping">;
  /**
   * 投稿先のチャンネルの持ち主の人格。足した人格のチャンネルで、その Bot が接続していない・投稿に失敗したら、やり直さずに #tasks・#inbox
   * （既定の人格の Bot）に出す。無ければすべて既定の人格
   */
  personas?: Pick<PersonaRouter, "ownerOf" | "ownerConnected">;
  /** 予約した依頼を動かすチャンネル（#inbox・#tasks）か */
  resolveChannel: ResolveChannel;
  /** 発言のターンと同じキュー（key は channelId）。予約した依頼のターンはセッション以外のジョブとして入れる */
  turnQueue: Pick<KeyedSerialQueue, "run">;
  /** 予約した依頼のターン（runChannelTurn。usage の記録・resume・seed は発言と同じ） */
  turn: TurnDeps;
  /** Web UI のためのターンの記録（Web UI が有効なときだけ渡す）。予約した依頼のターンの依頼と返事の行を書く。無ければ書かない */
  history?: Pick<HistoryStore, "add">;
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

/** unreachable は、頼んだチャンネルの持ち主（足した人格）の Bot に接続できない・投稿できなかったため、ほかのチャンネルに出したか */
type PostResult = { kind: "posted"; channelId: string; messageId: string; unreachable: boolean } | { kind: "nowhere" };

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
  /** キューに入れてまだ終わっていない予約した依頼のターン（id ごと）。同じ id を重ねず、idle で待つ */
  private readonly prompts = new Map<number, Promise<void>>();

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

  /** 実行中の tick（投稿を含む）と、キューに入れた予約した依頼のターン（返信まで）が終わったら resolve する（停止時に使う） */
  async idle(): Promise<void> {
    await this.running;
    // 待っている間に tick が入れた分も待つ
    while (this.prompts.size > 0) await Promise.all([...this.prompts.values()]);
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
    // 同じ予約した依頼のターンが走っている間は重ねない（DB は変えないので、終わった後の tick で拾う）
    if (reminder.kind === "prompt" && this.prompts.has(id)) return;
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

    if (reminder.kind === "prompt") {
      this.startPrompt(reminder, now);
      return;
    }
    const occurrence = this.occurrence(reminder, now);
    if (occurrence === undefined) return;
    const update = this.nextUpdate(reminder, occurrence, now);

    const key = `${id}:${reminder.fireSeq}`;
    let result: PostResult;
    try {
      result = await this.post(reminder, (note) => this.message(reminder, taskTitle, occurrence, now, note));
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

    if (!reminders.markFired(id, reminder.fireSeq, { ...update, messageId: result.messageId, messageChannelId: result.channelId })) {
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
    // 元のチャンネルが無くて移したときは以後も移した先に出す。持ち主の Bot に接続できなかった回は、この回だけほかに出して channel_id は変えない
    const moved = result.channelId !== reminder.channelId && !result.unreachable;
    if (moved) reminders.moveChannel(id, result.channelId);
    const lateMinutes = Math.floor((now.getTime() - occurrence.at.getTime()) / MINUTE_MS);
    log(`リマインドを知らせました（#${id}、guild=${reminder.guildId}、遅れ ${lateMinutes} 分）`);
    // 移したときは前のチャンネルが無いので、前の回のボタンは外せない
    if (!moved) await this.clearPreviousButtons(reminder, taskTitle);
  }

  /**
   * 予約した依頼の回: 実行先の key で発言と同じキューに入れる（tick では待たない）。claim はジョブの先頭で行う（runPrompt）。
   * 実行先が無ければ、notify と同じくこの回を出さずに進める
   */
  private startPrompt(reminder: Reminder, now: Date): void {
    const { log } = this.deps;
    const { id } = reminder;
    const target = this.promptChannel(reminder);
    if (target === undefined) {
      const occurrence = this.occurrence(reminder, now);
      if (occurrence === undefined) return;
      this.giveUp(reminder, occurrence, now);
      log(`予約した依頼の実行先が無いため、この回を諦めました（#${id}、guild=${reminder.guildId}）`);
      return;
    }
    const key = target.channelId;
    const job = this.deps.turnQueue
      .run(key, () => this.runPrompt(id, key))
      .catch((error: unknown) => {
        log(`予約した依頼の処理に失敗しました（#${id}）: ${describeError(error)}`);
      })
      .finally(() => {
        if (this.prompts.get(id) === job) this.prompts.delete(id);
      });
    this.prompts.set(id, job);
  }

  /**
   * 予約した依頼を動かすチャンネル。頼んだチャンネルが #inbox・#tasks ならそこ、それ以外・無ければそのサーバーの #tasks、無ければ #inbox。
   * どれも無ければ undefined
   */
  private promptChannel(reminder: Reminder): { channelId: string; kind: Exclude<ChannelKind, "session"> } | undefined {
    const { resolveChannel, guildSettings } = this.deps;
    const kind = resolveChannel(reminder.guildId, reminder.channelId);
    if (kind === "inbox" || kind === "tasks") return { channelId: reminder.channelId, kind };
    const settings = guildSettings.get(reminder.guildId);
    if (settings === undefined) return undefined;
    if (settings.tasksChannelId !== null) return { channelId: settings.tasksChannelId, kind: "tasks" };
    if (settings.inboxChannelId !== null) return { channelId: settings.inboxChannelId, kind: "inbox" };
    return undefined;
  }

  /**
   * キューの中で予約した依頼のターンを 1 回動かし、返答（失敗なら知らせ）をオーナーをメンションして送る。やり直さない。
   * 途中経過・[中断]・[続ける] は付けない
   */
  private async runPrompt(id: number, key: string): Promise<void> {
    const { cfg, gateway, turn, reminders, history, now, log } = this.deps;
    // 停止を始めていたら claim せずに戻る（次の起動の最初の tick で拾う）
    if (this.stopped) {
      log(`停止を始めたため、予約した依頼を動かしませんでした（#${id}）`);
      return;
    }
    // キューで待っている間に止められた・変えられたものは動かさない（読み直して確かめる）
    const at = now();
    const reminder = reminders.get(id);
    if (reminder === undefined || !isDue(reminder, at)) {
      log(`動かす前に予約した依頼が止められたため、実行しませんでした（#${id}）`);
      return;
    }
    const target = this.promptChannel(reminder);
    if (target?.channelId !== key) {
      // 待っている間に #inbox・#tasks が変わった。key と違うチャンネルで動かすと発言と直列にならないので、次の tick で入れ直す
      log(`予約した依頼の実行先が変わったため、次の確認で動かします（#${id}）`);
      return;
    }
    const occurrence = this.occurrence(reminder, at);
    if (occurrence === undefined) return;
    const update = this.nextUpdate(reminder, occurrence, at);
    // 先に進めてから動かす（多くても 1 回）。1 回だけのものは fired ではなく done にする（押すボタンが無いため）
    if (!reminders.claim(id, reminder.fireSeq, { ...update, status: update.status === "fired" ? "done" : update.status })) {
      log(`動かす前に予約した依頼が止められたため、実行しませんでした（#${id}）`);
      return;
    }
    const lateMs = at.getTime() - occurrence.at.getTime();
    const late =
      lateMs < REMINDER_LATE_NOTE_MS
        ? undefined
        : `${lateMs >= DAY_MS ? formatShortDateTime(occurrence.at, cfg.timeZone) : formatShortTime(occurrence.at, cfg.timeZone)} の予定から ${Math.floor(lateMs / MINUTE_MS)} 分遅れ`;
    const { channelId, kind } = target;
    log(`予約した依頼のターンを始めました（#${id}、guild=${reminder.guildId}）`);
    // history の行は実際にターンを行うチャンネル（#inbox・#tasks）に、その持ち主の人格で書く
    const historyRow = {
      guildId: reminder.guildId,
      channelId,
      source: "system",
      persona: this.deps.personas?.ownerOf(channelId) ?? DEFAULT_PERSONA_ID,
    } as const;
    recordHistory(history, { ...historyRow, kind: "owner", text: scheduledPromptContent(reminder, late) }, log);
    const startedAt = now().getTime();
    const stopTyping = gateway.startTyping(channelId);
    let result: RunResult | undefined;
    try {
      result = await runChannelTurn(turn, {
        guildId: reminder.guildId,
        channelId,
        kind,
        prompt: buildTurnPrompt(scheduledPromptContent(reminder, late), at, cfg.timeZone, kind),
        // オーナーが貼った URL は無いので WebFetch は使えない
        allowedUrls: [],
        scheduled: true,
      });
    } catch (error) {
      log(`予約した依頼のターンが失敗しました（#${id}）: ${describeError(error)}`);
    } finally {
      stopTyping();
    }

    let text: string;
    if (result?.ok === true) {
      const body = result.text.trim() === "" ? EMPTY_REPLY : result.text;
      text = `${result.compacted === undefined ? body : `${body}\n${COMPACTED_NOTE}`}\n${scheduledReplyNote(id)}`;
    } else {
      if (result !== undefined) log(`予約した依頼のターンが失敗しました（#${id}）: ${result.errorMessage}`);
      // sdk-runner は result の失敗を subtype から書き始める
      text = result?.errorMessage.startsWith(MAX_TURNS_ERROR_PREFIX) === true ? MAX_TURNS_REPLY : scheduledFailureText(id);
    }
    try {
      await gateway.send(channelId, text, undefined, cfg.ownerUserId);
    } catch (error) {
      log(`予約した依頼の返信に失敗しました（#${id}）: ${describeError(error)}`);
    }
    recordHistory(
      history,
      {
        ...historyRow,
        kind: "agent",
        text,
        outcome: turnOutcome(result),
        steps: null,
        toolCalls: result?.toolCalls ?? null,
        durationMs: result?.ok === true ? result.durationMs : now().getTime() - startedAt,
      },
      log,
    );
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
    /** 頼んだチャンネル以外に出したときの注記（MOVED_NOTE・OWNER_UNREACHABLE_NOTE） */
    note: string | undefined,
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
    if (note !== undefined) lines.push(note);
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
   * 足した人格が持ち主のチャンネルは、その Bot が接続していない・投稿に失敗したら、やり直さずに次の候補へ（注記は OWNER_UNREACHABLE_NOTE。
   * channel_id は変えないので、次の回はまた持ち主の Bot で頼んだチャンネルに出す）。
   * どれも無ければ nowhere
   */
  private async post(reminder: Reminder, build: (note: string | undefined) => OutgoingMessage): Promise<PostResult> {
    const { guildSettings, topicSessions, gateway, personas, log } = this.deps;
    const candidates: string[] = [];
    if (topicSessions.get(reminder.channelId)?.state !== "deleted") candidates.push(reminder.channelId);
    const settings = guildSettings.get(reminder.guildId);
    for (const channelId of [settings?.tasksChannelId, settings?.inboxChannelId]) {
      if (channelId !== null && channelId !== undefined && channelId !== reminder.channelId && !candidates.includes(channelId)) {
        candidates.push(channelId);
      }
    }
    let unreachable = false;
    for (const channelId of candidates) {
      const byOtherPersona = personas !== undefined && personas.ownerOf(channelId) !== DEFAULT_PERSONA_ID;
      if (byOtherPersona && !personas.ownerConnected(channelId)) {
        log(`リマインドのチャンネルの Bot に接続していないため、ほかのチャンネルに出します（#${reminder.id}）`);
        unreachable = true;
        continue;
      }
      const note = channelId === reminder.channelId ? undefined : unreachable ? OWNER_UNREACHABLE_NOTE : MOVED_NOTE;
      try {
        const messageId = await gateway.sendMessage(channelId, build(note));
        return { kind: "posted", channelId, messageId, unreachable };
      } catch (error) {
        if (byOtherPersona) {
          log(`リマインドのチャンネルの Bot で投稿できなかったため、ほかのチャンネルに出します（#${reminder.id}）: ${describeError(error)}`);
          unreachable = true;
          continue;
        }
        if (await gateway.channelExists(channelId)) throw error;
      }
    }
    return { kind: "nowhere" };
  }

  /**
   * 前の回のメッセージのボタンを外す（本文は DB から作り直し、メンションは付けない）。メッセージを出したチャンネル（last_message_channel_id、無ければ channel_id）で、
   * それを出した Bot（そのチャンネルの持ち主の Bot）で書き換える。その Bot（足した人格）が接続していなければ外さない。失敗は log だけ
   */
  private async clearPreviousButtons(reminder: Reminder, taskTitle: string | undefined): Promise<void> {
    const { gateway, personas, log } = this.deps;
    if (reminder.lastMessageId === null) return;
    const channelId = reminder.lastMessageChannelId ?? reminder.channelId;
    if (personas !== undefined && personas.ownerOf(channelId) !== DEFAULT_PERSONA_ID && !personas.ownerConnected(channelId)) {
      log(`前のリマインドを出した Bot に接続していないため、ボタンを外しませんでした（#${reminder.id}）`);
      return;
    }
    try {
      await gateway.editMessage(channelId, reminder.lastMessageId, {
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
