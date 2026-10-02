// 定期処理（tick）。最後の発言から SELF_AGENT_IDLE_HOURS 経った進行中のセッションを待ちに移し、
// 完了から SELF_AGENT_DELETE_AFTER_DAYS 日経ったセッションについてチャンネルを削除するか #system で確認する。
// 対象は毎回 DB から求めるので、止まっていた間に過ぎた分も起動直後の tick で拾う（永続のタイマーは持たない）
import type { Config } from "../config.ts";
import type { Gateway, OutgoingMessage } from "../discord/gateway.ts";
import type { GuildSettingsStore } from "../store/guild-settings.ts";
import type { TopicSessionStore } from "../store/topic-sessions.ts";
import type { ChannelOpsQueue } from "./channel-ops.ts";
import { closeStartButton } from "./commands/close.ts";
import { deletePrompt } from "./commands/delete.ts";
import { continueButton } from "./commands/wait.ts";
import { applySessionEvent } from "./session-state.ts";

/** tick の間隔 */
export const TICK_INTERVAL_MS = 5 * 60 * 1000;
/** 1 回の tick で待ちに移すセッションの上限（カテゴリ移動のレート制限に当たらないように） */
export const IDLE_BATCH_LIMIT = 5;
/** 1 回の tick で削除の確認を投稿するセッションの上限 */
export const DELETE_PROMPT_BATCH_LIMIT = 5;

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

/** テストでは偽のタイマーに差し替える */
export type SchedulerTimers = {
  /** fn を ms ごとに呼び、止める関数を返す */
  every(fn: () => void, ms: number): () => void;
};

const REAL_TIMERS: SchedulerTimers = {
  every: (fn, ms) => {
    const timer = setInterval(fn, ms);
    return () => clearInterval(timer);
  },
};

export type SchedulerDeps = {
  cfg: Pick<Config, "idleHours" | "deleteAfterDays">;
  topicSessions: Pick<TopicSessionStore, "listIdle" | "setActive" | "setWaiting" | "listDeleteDue" | "setDeletePrompt">;
  /** 削除の確認の投稿先（#system） */
  guildSettings: Pick<GuildSettingsStore, "get">;
  /** 待ちにしたセッションを待ちカテゴリへ移す */
  channelOps: Pick<ChannelOpsQueue, "enqueueMove">;
  /** 待ちに移した知らせと削除の確認を投稿する */
  gateway: Pick<Gateway, "sendMessage">;
  now: () => Date;
  timers?: SchedulerTimers;
  log: (message: string) => void;
};

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** 待ちに移したチャンネルに投稿する知らせ。[続ける] で進行中に戻し、[閉じる] で /close と同じ流れを始める */
export function idleNotice(idleHours: number, channelId: string): OutgoingMessage {
  return {
    text: `${idleHours} 時間発言がないので待ちに移しました。`,
    components: [{ kind: "buttons", buttons: [continueButton(channelId), closeStartButton(channelId)] }],
  };
}

export class Scheduler {
  private readonly deps: SchedulerDeps;
  private readonly timers: SchedulerTimers;
  /** 定期実行を止める関数。start 前・stop 後は undefined */
  private cancel: (() => void) | undefined;
  private stopped = false;
  /** 実行中の tick */
  private running: Promise<void> | undefined;

  constructor(deps: SchedulerDeps) {
    this.deps = deps;
    this.timers = deps.timers ?? REAL_TIMERS;
  }

  /** 直後に 1 回 tick し、以後 intervalMs ごとに tick する。stop の後は何もしない */
  start(intervalMs: number): void {
    if (this.stopped || this.cancel !== undefined) return;
    this.cancel = this.timers.every(() => void this.tick(), intervalMs);
    void this.tick();
  }

  /** 以後の tick を止める。実行中の tick は止めない（終わるのは idle で待つ） */
  stop(): void {
    this.stopped = true;
    this.cancel?.();
    this.cancel = undefined;
  }

  /** 実行中の tick が終わったら resolve する（停止時に使う） */
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

  /** 待ちへの移動と削除の確認は、片方が失敗してももう片方を行う */
  private async runTick(): Promise<void> {
    await this.moveIdleSessions();
    await this.promptDeletes();
  }

  private async moveIdleSessions(): Promise<void> {
    const { cfg, topicSessions, gateway, now, log } = this.deps;
    try {
      // 最後の発言がちょうど idleHours 前のものも含める
      const before = new Date(now().getTime() - cfg.idleHours * HOUR_MS);
      const idle = topicSessions.listIdle(before, IDLE_BATCH_LIMIT);
      // 先に全部を DB で待ちにして移動を列に入れる（await を挟まない）。知らせはその後で投稿する
      for (const session of idle) {
        applySessionEvent(session, "idle", this.deps);
        log(`${cfg.idleHours} 時間発言が無いセッションを待ちに移しました（guild=${session.guildId}）`);
      }
      for (const session of idle) {
        try {
          await gateway.sendMessage(session.channelId, idleNotice(cfg.idleHours, session.channelId));
        } catch (error) {
          // 待ちにはしてあるので、知らせだけ諦める
          log(`待ちに移した知らせの投稿に失敗しました（guild=${session.guildId}）: ${describeError(error)}`);
        }
      }
    } catch (error) {
      log(`定期処理に失敗しました: ${describeError(error)}`);
    }
  }

  /**
   * 完了から deleteAfterDays 日経ち、まだ確認していないセッションについて、そのサーバーの #system に [削除する][残す] を投稿する（閉じた時刻の古い順に最大 5 件）。
   * 投稿したメッセージを記録して以後は投稿し直さない。#system が無いサーバーは飛ばし、投稿に失敗したら記録せずに次の tick でやり直す
   */
  private async promptDeletes(): Promise<void> {
    const { cfg, topicSessions, guildSettings, gateway, now, log } = this.deps;
    try {
      // 閉じたのがちょうど deleteAfterDays 日前のものも含める
      const before = new Date(now().getTime() - cfg.deleteAfterDays * DAY_MS);
      const due = topicSessions.listDeleteDue(before, DELETE_PROMPT_BATCH_LIMIT);
      // #system が無いことを log に出したサーバー（1 回の tick で 1 回だけ出す）
      const unconfigured = new Set<string>();
      for (const session of due) {
        const systemChannelId = guildSettings.get(session.guildId)?.systemChannelId ?? null;
        if (systemChannelId === null) {
          if (!unconfigured.has(session.guildId)) {
            unconfigured.add(session.guildId);
            log(`#system が無いため、削除の確認を投稿できません（guild=${session.guildId}）。/setup を実行してください`);
          }
          continue;
        }
        let messageId: string;
        try {
          messageId = await gateway.sendMessage(systemChannelId, deletePrompt(session, cfg.deleteAfterDays));
        } catch (error) {
          // 記録しないので、次の tick でやり直す
          log(`削除の確認の投稿に失敗しました（guild=${session.guildId}）: ${describeError(error)}`);
          continue;
        }
        topicSessions.setDeletePrompt(session.channelId, messageId);
        log(`完了から ${cfg.deleteAfterDays} 日経ったセッションの削除の確認を投稿しました（guild=${session.guildId}）`);
      }
    } catch (error) {
      log(`定期処理に失敗しました: ${describeError(error)}`);
    }
  }
}
