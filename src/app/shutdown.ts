// 停止処理: 新しい発言・操作の受付と定期処理を止め、進行中の処理を上限付きで待ってから gateway を止めて DB を閉じる
import type { Config } from "../config.ts";
import type {
  Gateway,
  GatewayHandlers,
  IncomingMessage,
  Interaction,
  InteractionResponder,
} from "../discord/gateway.ts";
import type { KeyedSerialQueue } from "./queue.ts";
import type { Scheduler } from "./scheduler.ts";

/** 停止を始めた後に来た操作への応答（応答期限があるので、受け付けない旨だけ返す） */
export const RESTARTING_REPLY = "再起動中です";

export type ShutdownDeps = {
  cfg: Pick<Config, "allowedGuildIds" | "shutdownGraceSec">;
  gateway: Pick<Gateway, "stop">;
  /** 完了を待つキュー（ターン用と /setup・/new 用） */
  queues: ReadonlyArray<Pick<KeyedSerialQueue, "idle">>;
  /** 定期処理。停止を始めたら止め、実行中の tick があれば終わるのを待つ */
  scheduler: Pick<Scheduler, "stop" | "idle">;
  closeDb: () => void;
  log: (message: string) => void;
};

/** 受け付けた発言・操作を処理する関数。返す Promise は reject しない前提（handler.ts・interactions.ts） */
export type InnerHandlers = {
  handleMessage: (message: IncomingMessage) => Promise<void>;
  handleInteraction: (interaction: Interaction, responder: InteractionResponder) => Promise<void>;
};

export type Shutdown = {
  /** gateway.start に渡すハンドラ。停止を始めたら新しい発言・操作を受け付けない */
  handlers: GatewayHandlers;
  /**
   * 受付と定期処理を止め、受け付け済みの発言・操作（返信まで）とキューのジョブ・実行中の tick が終わるのを最大 shutdownGraceSec 秒待ってから、
   * gateway を止めて DB を閉じる。待っている間も gateway は動いているので、終わったターンの返信は送られる。reject しない
   */
  shutdown: () => Promise<void>;
  /** 停止を始めたか */
  stopping: () => boolean;
};

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** ms 以内に promise が終われば true、終わらなければ false */
async function settlesWithin(promise: Promise<unknown>, ms: number): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<false>((resolve) => {
    timer = setTimeout(() => resolve(false), ms);
  });
  try {
    return await Promise.race([promise.then(() => true), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

export function createShutdown(deps: ShutdownDeps, inner: InnerHandlers): Shutdown {
  const { cfg, gateway, queues, scheduler, closeDb, log } = deps;
  let stopping = false;
  /** 受け付けて、まだ終わっていない発言・操作の処理（返信を含む） */
  const inFlight = new Set<Promise<void>>();

  const track = (promise: Promise<void>): void => {
    const settled = promise.then(
      () => undefined,
      () => undefined,
    );
    inFlight.add(settled);
    void settled.then(() => inFlight.delete(settled));
  };

  const drained = async (): Promise<void> => {
    // 待っている間に増えた分（停止中の操作への応答）も待つ
    while (inFlight.size > 0) await Promise.all([...inFlight]);
    await Promise.all([...queues.map((queue) => queue.idle()), scheduler.idle()]);
  };

  const handlers: GatewayHandlers = {
    onMessage: (message) => {
      // 停止中の発言は何もしない
      if (stopping) return;
      track(inner.handleMessage(message));
    },
    onInteraction: (interaction, responder) => {
      if (!stopping) {
        track(inner.handleInteraction(interaction, responder));
        return;
      }
      // DM・許可外のサーバーには、通常どおり応答もしない
      if (interaction.guildId === null || !cfg.allowedGuildIds.includes(interaction.guildId)) return;
      track(
        responder.reply({ text: RESTARTING_REPLY, ephemeral: true }).catch((error: unknown) => {
          log(`停止中の操作への応答に失敗しました: ${describeError(error)}`);
        }),
      );
    },
  };

  const shutdown = async (): Promise<void> => {
    stopping = true;
    scheduler.stop();
    log(`停止します（進行中の処理を最大 ${cfg.shutdownGraceSec} 秒待ちます）`);
    if (!(await settlesWithin(drained(), cfg.shutdownGraceSec * 1000))) {
      log(`進行中の処理が ${cfg.shutdownGraceSec} 秒で終わらなかったため、待たずに終了します`);
    }
    try {
      await gateway.stop();
    } catch (error) {
      log(`Discord との切断に失敗しました: ${describeError(error)}`);
    }
    try {
      closeDb();
    } catch (error) {
      log(`DB を閉じられませんでした: ${describeError(error)}`);
    }
  };

  return { handlers, shutdown, stopping: () => stopping };
}
