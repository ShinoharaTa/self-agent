// チャンネルのカテゴリ移動を全サーバー共通の 1 本の列で順に行う。Discord のレート制限に当たらないよう、操作の間を空け、同じチャンネルの移動はまとめる
import { setTimeout as delay } from "node:timers/promises";
import type { Gateway } from "../discord/gateway.ts";
import type { GuildSettingsStore, SessionState } from "../store/guild-settings.ts";
import type { TopicSessionStore } from "../store/topic-sessions.ts";
import { findStateCategory } from "./commands/new.ts";

/** 移動先。state は実行時に、その状態のカテゴリのうち空きのあるものを選ぶ（満杯なら `完了 N` などを作る） */
export type MoveTarget =
  | { kind: "category"; categoryId: string }
  | { kind: "state"; guildId: string; state: SessionState };

/** 失敗したときの再試行の間隔。3 回やり直してもだめなら log に出してやめる */
export const RETRY_DELAYS_MS: readonly number[] = [30_000, 120_000, 600_000];

/** テストでは偽の時計に差し替える */
export type ChannelOpsTimers = {
  /** 操作の間隔を空ける */
  sleep(ms: number): Promise<void>;
  /** 再試行を予約し、取り消す関数を返す */
  schedule(fn: () => void, ms: number): () => void;
};

const REAL_TIMERS: ChannelOpsTimers = {
  sleep: (ms) => delay(ms),
  schedule: (fn, ms) => {
    const timer = setTimeout(fn, ms);
    return () => clearTimeout(timer);
  },
};

export type ChannelOpsDeps = {
  gateway: Pick<Gateway, "getParentId" | "moveChannel" | "channelExists" | "countChannelsIn" | "createCategory">;
  guildSettings: GuildSettingsStore;
  /** 移動したら sessions の category_id（今置いているカテゴリ）を更新する */
  topicSessions: Pick<TopicSessionStore, "setCategory">;
  /** 操作の間隔（SELF_AGENT_CHANNEL_OP_GAP_MS） */
  gapMs: number;
  timers?: ChannelOpsTimers;
  log: (message: string) => void;
};

type MoveOp = { channelId: string; target: MoveTarget; attempt: number };

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export class ChannelOpsQueue {
  private readonly deps: ChannelOpsDeps;
  private readonly timers: ChannelOpsTimers;
  /** まだ実行していない移動（channelId ごとに 1 つ。Map の挿入順に実行する） */
  private readonly pending = new Map<string, MoveOp>();
  /** 再試行を待っている移動の取り消し */
  private readonly retries = new Map<string, () => void>();
  private running = false;

  constructor(deps: ChannelOpsDeps) {
    this.deps = deps;
    this.timers = deps.timers ?? REAL_TIMERS;
  }

  /**
   * 移動を列に入れる（すぐ返る）。同じチャンネルの未実行の移動（再試行待ちを含む）があれば、この目的地で置き換える。
   * 実行時に Discord 上の今の親がもう目的地なら何もしない
   */
  enqueueMove(channelId: string, target: MoveTarget): void {
    const cancelRetry = this.retries.get(channelId);
    if (cancelRetry !== undefined) {
      cancelRetry();
      this.retries.delete(channelId);
    }
    // 既にあれば列の位置はそのままで中身だけ置き換わる
    this.pending.set(channelId, { channelId, target, attempt: 0 });
    void this.drain();
  }

  private async drain(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      for (;;) {
        const next = this.pending.values().next();
        if (next.done === true) break;
        const op = next.value;
        this.pending.delete(op.channelId);
        await this.execute(op);
        // 次の操作との間を空ける（この間に入った移動も、空けてから実行する）
        await this.timers.sleep(this.deps.gapMs);
      }
    } finally {
      this.running = false;
    }
  }

  private async execute(op: MoveOp): Promise<void> {
    try {
      await this.move(op);
    } catch (error) {
      this.retryLater(op, error);
    }
  }

  private async move(op: MoveOp): Promise<void> {
    const { gateway, guildSettings, topicSessions, log } = this.deps;
    const { channelId, target } = op;
    const parentId = await gateway.getParentId(channelId);
    let categoryId: string;
    if (target.kind === "category") {
      categoryId = target.categoryId;
    } else {
      // その状態のカテゴリのどれかに既にあれば動かさない（満杯の判定で別のカテゴリへ移さない）
      const current = guildSettings
        .listStateCategories(target.guildId, target.state)
        .find((category) => category.categoryId === parentId);
      // カテゴリを作ることがあるが、この列は 1 本なので同時に 2 つ作らない
      categoryId =
        current?.categoryId ?? (await findStateCategory(target.guildId, target.state, { gateway, guildSettings, log }));
    }
    if (parentId !== categoryId) await gateway.moveChannel(channelId, categoryId);
    topicSessions.setCategory(channelId, categoryId);
  }

  private retryLater(op: MoveOp, error: unknown): void {
    const { log } = this.deps;
    // 実行中に同じチャンネルの新しい移動が入っていれば、そちらに任せる
    if (this.pending.has(op.channelId)) return;
    const wait = RETRY_DELAYS_MS[op.attempt];
    if (wait === undefined) {
      log(`チャンネルの移動に ${op.attempt + 1} 回失敗したため、やめました: ${describeError(error)}`);
      return;
    }
    log(`チャンネルの移動に失敗しました（${op.attempt + 1} 回目）。${wait / 1000} 秒後にやり直します: ${describeError(error)}`);
    const cancel = this.timers.schedule(() => {
      this.retries.delete(op.channelId);
      this.pending.set(op.channelId, { ...op, attempt: op.attempt + 1 });
      void this.drain();
    }, wait);
    this.retries.set(op.channelId, cancel);
  }
}
