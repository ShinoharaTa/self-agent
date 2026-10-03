// チャンネルのカテゴリ移動を全サーバー共通の 1 本の列で順に行う。Discord のレート制限に当たらないよう、操作の間を空け、同じチャンネルの移動はまとめる。
// 失敗しても再試行しない（log に出して終える）。ずれは Scheduler の tick の再同期（DB の状態と Discord の親カテゴリの突き合わせ）が直す
import { setTimeout as delay } from "node:timers/promises";
import { type Gateway, UnknownChannelError } from "../discord/gateway.ts";
import type { GuildSettingsStore, SessionState } from "../store/guild-settings.ts";
import type { TopicSessionStore } from "../store/topic-sessions.ts";
import { findStateCategory } from "./categories.ts";

/** 移動先。state は実行時に、その状態のカテゴリのうち空きのあるものを選ぶ（満杯なら `完了 N` などを作る） */
export type MoveTarget =
  | { kind: "category"; categoryId: string }
  | { kind: "state"; guildId: string; state: SessionState };

/** テストでは偽の時計に差し替える */
export type ChannelOpsTimers = {
  /** 操作の間隔を空ける */
  sleep(ms: number): Promise<void>;
};

const REAL_TIMERS: ChannelOpsTimers = {
  sleep: (ms) => delay(ms),
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

type MoveOp = { channelId: string; target: MoveTarget };

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export class ChannelOpsQueue {
  private readonly deps: ChannelOpsDeps;
  private readonly timers: ChannelOpsTimers;
  /** まだ実行していない移動（channelId ごとに 1 つ。Map の挿入順に実行する） */
  private readonly pending = new Map<string, MoveOp>();
  private running = false;
  /** 実行中の移動（間隔を空けている間は undefined） */
  private current: Promise<void> | undefined;

  constructor(deps: ChannelOpsDeps) {
    this.deps = deps;
    this.timers = deps.timers ?? REAL_TIMERS;
  }

  /**
   * 移動を列に入れる（すぐ返る）。同じチャンネルの未実行の移動があれば、この目的地で置き換える。
   * 実行時に Discord 上の今の親がもう目的地なら何もしない
   */
  enqueueMove(channelId: string, target: MoveTarget): void {
    // 既にあれば列の位置はそのままで中身だけ置き換わる
    this.pending.set(channelId, { channelId, target });
    void this.drain();
  }

  /** そのチャンネルの未実行の移動を捨てる（チャンネルを削除したとき）。実行中の移動は止めない */
  cancel(channelId: string): void {
    this.pending.delete(channelId);
  }

  /** 実行中の移動が終わったら resolve する（停止時に使う。まだ始めていない移動は待たない） */
  idle(): Promise<void> {
    return this.current ?? Promise.resolve();
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
        const current = this.execute(op);
        this.current = current;
        try {
          await current;
        } finally {
          this.current = undefined;
        }
        // 次の操作との間を空ける（この間に入った移動も、空けてから実行する）
        await this.timers.sleep(this.deps.gapMs);
      }
    } finally {
      this.running = false;
    }
  }

  /** reject しない。失敗は log に出して終える（チャンネルが既に無ければ何も出さない） */
  private async execute(op: MoveOp): Promise<void> {
    try {
      await this.move(op);
    } catch (error) {
      // 削除されたチャンネルの移動。次の tick の再同期で削除済みになる
      if (error instanceof UnknownChannelError) return;
      this.deps.log(`チャンネルの移動に失敗しました（次の定期処理で直します）: ${describeError(error)}`);
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
}
