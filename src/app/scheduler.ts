// 定期処理（tick）。DB のセッションの状態と Discord の親カテゴリを突き合わせてずれを直し（再同期）、
// 最後の発言から SELF_AGENT_IDLE_HOURS 経った進行中のセッションを待ちに移し、
// 完了から SELF_AGENT_DELETE_AFTER_DAYS 日経ったセッションについてチャンネルを削除するか #system で確認し、
// 時期が来た #inbox の会話を切り替える（inbox-rotate.ts）。
// 対象は毎回 DB と Discord から求めるので、止まっていた間に過ぎた分や失敗した移動も起動直後の tick で拾う（永続のタイマーは持たない）
import type { Config } from "../config.ts";
import type { Gateway, OutgoingMessage } from "../discord/gateway.ts";
import type { ChannelSeedStore } from "../store/channel-seeds.ts";
import type { GuildSettings, GuildSettingsStore } from "../store/guild-settings.ts";
import type { SdkSessionStore } from "../store/sdk-sessions.ts";
import type { TopicSessionStore } from "../store/topic-sessions.ts";
import type { ChannelOpsQueue } from "./channel-ops.ts";
import { closeStartButton } from "./commands/close.ts";
import { deletePrompt } from "./commands/delete.ts";
import { continueButton } from "./commands/wait.ts";
import type { InboxRotator } from "./inbox-rotate.ts";
import { applySessionEvent } from "./session-state.ts";

/** tick の間隔 */
export const TICK_INTERVAL_MS = 5 * 60 * 1000;
/** 1 回の tick で待ちに移すセッションの上限（カテゴリ移動のレート制限に当たらないように） */
export const IDLE_BATCH_LIMIT = 5;
/** 1 回の tick で削除の確認を投稿するセッションの上限 */
export const DELETE_PROMPT_BATCH_LIMIT = 5;
/** 1 回の tick で 1 サーバーあたり、状態とカテゴリのずれを直す移動を入れるセッションの上限 */
export const RECONCILE_BATCH_LIMIT = 5;

/** /setup が self-agent カテゴリの中に作るチャンネル */
const HOME_CHANNEL_FIELDS = ["inboxChannelId", "tasksChannelId", "systemChannelId"] as const;

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
  /** allowedGuildIds は再同期の対象のサーバー */
  cfg: Pick<Config, "allowedGuildIds" | "idleHours" | "deleteAfterDays">;
  topicSessions: Pick<
    TopicSessionStore,
    "get" | "listIdle" | "setActive" | "setWaiting" | "listDeleteDue" | "setDeletePrompt" | "listUndeleted" | "markDeleted"
  >;
  /** 削除の確認の投稿先（#system）と、再同期で見る self-agent カテゴリ・状態カテゴリ */
  guildSettings: Pick<GuildSettingsStore, "get" | "listStateCategories">;
  /** Discord 上で消えていたセッションのチャンネルの SDK セッション（channel_sessions）を消す */
  sessions: Pick<SdkSessionStore, "delete">;
  /** Discord 上で消えていたセッションのチャンネルの seed（channel_seeds）を消す */
  seeds: Pick<ChannelSeedStore, "delete">;
  /** 待ちにしたセッションを待ちカテゴリへ移し、再同期でずれていたチャンネルを移す */
  channelOps: Pick<ChannelOpsQueue, "enqueueMove">;
  /** 待ちに移した知らせと削除の確認を投稿し、再同期でサーバーのチャンネルの親カテゴリを取る */
  gateway: Pick<Gateway, "sendMessage" | "listChannelParents" | "isInGuild">;
  /** #inbox の切り替え（日次・入力の大きさ）。要約のターンは発言と同じキューで行う */
  inboxRotator: Pick<InboxRotator, "rotateDue">;
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

  /**
   * 再同期・待ちへの移動・削除の確認・#inbox の切り替えは、どれかが失敗しても残りを行う。
   * 再同期は消えたチャンネルを先に削除済みにするため最初に、#inbox の切り替えは LLM のターンを待つので最後に行う
   */
  private async runTick(): Promise<void> {
    await this.reconcileChannels();
    await this.moveIdleSessions();
    await this.promptDeletes();
    // 停止を始めたら、まだ始めていない切り替えは行わない（始めたものは idle と shutdown のキューの待ち合わせで待つ）
    await this.deps.inboxRotator.rotateDue(() => this.stopped);
  }

  /**
   * /setup 済みの許可サーバーごとに、DB のセッションの状態と Discord の親カテゴリを突き合わせ、ずれていれば移動を列に入れる
   * （失敗した移動や手で動かされたチャンネルを直す）。サーバーごとに 1 回だけ Discord からチャンネルの一覧を取る。
   * - セッションのチャンネルが Discord 上に無ければ、手で消されたので削除済みにする（要約は残し、SDK セッションと seed を消す）
   * - 親がその状態のカテゴリのどれでもなければ、その状態のカテゴリへの移動を入れる（1 サーバーで最大 5 件。残りは次の tick）
   * - #inbox / #tasks / #system の親が self-agent カテゴリでなければ、そこへ戻す移動を入れる
   * self-agent カテゴリ・その状態のカテゴリが Discord 上に 1 つも無ければ、そこへは移さない（作り直すのは /setup）
   */
  private async reconcileChannels(): Promise<void> {
    const { cfg, guildSettings, gateway, log } = this.deps;
    for (const guildId of cfg.allowedGuildIds) {
      try {
        const settings = guildSettings.get(guildId);
        if (settings === undefined) continue;
        // Bot が抜けたサーバーは一覧を取れない。毎 tick の失敗 log を避けて静かに飛ばす
        if (!gateway.isInGuild(guildId)) continue;
        await this.reconcileGuild(settings);
      } catch (error) {
        log(`チャンネルのカテゴリの確認に失敗しました（guild=${guildId}）: ${describeError(error)}`);
      }
    }
  }

  private async reconcileGuild(settings: GuildSettings): Promise<void> {
    const { topicSessions, guildSettings, sessions, seeds, channelOps, gateway, log } = this.deps;
    const { guildId } = settings;
    // 一覧を取る前に DB から読む（取っている間に /new で作られたセッションを、一覧に無いからと削除済みにしない）
    const candidates = topicSessions.listUndeleted(guildId);
    const parents = await gateway.listChannelParents(guildId);

    let moved = 0;
    for (const candidate of candidates) {
      // 一覧を取っている間に状態が変わっている（発言・/close・削除）ことがあるので読み直す
      const session = topicSessions.get(candidate.channelId);
      if (session === undefined || session.state === "deleted") continue;
      if (!parents.has(session.channelId)) {
        topicSessions.markDeleted(session.channelId);
        sessions.delete(session.channelId);
        seeds.delete(session.channelId);
        log(`セッションのチャンネルが Discord 上に無いため、削除済みにしました（guild=${guildId}）`);
        continue;
      }
      if (moved >= RECONCILE_BATCH_LIMIT) continue;
      const categories = guildSettings
        .listStateCategories(guildId, session.state)
        .filter((category) => parents.has(category.categoryId));
      const parentId = parents.get(session.channelId) ?? null;
      if (categories.length === 0 || categories.some((category) => category.categoryId === parentId)) continue;
      channelOps.enqueueMove(session.channelId, { kind: "state", guildId, state: session.state });
      moved++;
    }
    if (moved > 0) log(`状態とカテゴリが合わないセッション ${moved} 件を移します（guild=${guildId}）`);

    const homeCategoryId = settings.homeCategoryId;
    if (homeCategoryId === null || !parents.has(homeCategoryId)) return;
    let returned = 0;
    for (const field of HOME_CHANNEL_FIELDS) {
      const channelId = settings[field];
      // チャンネル自体が無ければ作り直すのは /setup
      if (channelId === null || !parents.has(channelId) || parents.get(channelId) === homeCategoryId) continue;
      channelOps.enqueueMove(channelId, { kind: "category", categoryId: homeCategoryId });
      returned++;
    }
    if (returned > 0) log(`self-agent カテゴリの外にあるチャンネル ${returned} 件を戻します（guild=${guildId}）`);
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
        // 前の知らせの投稿を待つ間に、発言・[続ける] で進行中に戻っていれば投稿しない
        if (topicSessions.get(session.channelId)?.state === "active") continue;
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
