// 停止処理: 新しい発言・操作の受付と定期処理を止め、進行中の処理（実行中のチャンネルの移動を含む）を上限付きで待ってから gateway を止め、静的サーバー・Web UI・
// Claude Code の hook の受け口と DB を閉じる
import type { CcChannelPosts } from "../cc/channel-posts.ts";
import type { CcHookServer } from "../cc/hook-server.ts";
import type { CcPermissionHold } from "../cc/permission-hold.ts";
import type { CcRegistry } from "../cc/registry.ts";
import type { CcReplier } from "../cc/replies.ts";
import type { CcSender } from "../cc/sender.ts";
import type { CcStarter } from "../cc/starter.ts";
import type { CcConfirmExpirer } from "./commands/cc-confirm.ts";
import type { Config } from "../config.ts";
import type { GithubPoller } from "../github/poller.ts";
import type { JobOrchestrator } from "../jobs/orchestrator.ts";
import type {
  Gateway,
  GatewayHandlers,
  IncomingMessage,
  Interaction,
  InteractionResponder,
} from "../discord/gateway.ts";
import type { StaticServer } from "../serve/static-server.ts";
import type { WebServer } from "../web/server.ts";
import type { ChannelOpsQueue } from "./channel-ops.ts";
import type { KeyedSerialQueue } from "./queue.ts";
import type { ReminderScheduler } from "./reminders.ts";
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
  /** リマインドの発火。scheduler と同じ時点で止め、実行中の投稿と予約した依頼のターン（返信まで）が終わるのを待つ（まだ始めていない発火は次の起動で拾う） */
  reminderScheduler: Pick<ReminderScheduler, "stop" | "idle">;
  /** GitHub の通知のポーリング（SELF_AGENT_GITHUB=1 のときだけ）。scheduler と同じ時点で止め、実行中の取得・投稿が終わるのを待つ */
  githubPoller?: Pick<GithubPoller, "stop" | "idle">;
  /**
   * 作業ジョブ（SELF_AGENT_JOBS が有効のときだけ）。停止を始めたら、実行中の run を待たずに中断し（failed / interrupted・作業場所は kept に）、
   * まだ始めていない run は始めない（queued のまま次の起動で入れ直す）。中断した run の後始末と報告が終わるのを待つ
   */
  jobs?: Pick<JobOrchestrator, "stop" | "idle">;
  /** チャンネルの移動の列。実行中の 1 件だけ終わるのを待つ（まだ始めていない移動は待たない。次の起動の再同期が直す） */
  channelOps: Pick<ChannelOpsQueue, "idle">;
  /** 作ったプロジェクトの静的サーバー。DB を閉じる前に閉じる。無ければ（機能が無効）何もしない */
  staticServer?: Pick<StaticServer, "close">;
  /** Web UI のサーバー。静的サーバーの次（DB を閉じる前）に閉じる。無ければ（Web UI が無効）何もしない */
  webServer?: Pick<WebServer, "close">;
  /** Claude Code のセッションの一覧（SELF_AGENT_CC=1 のときだけ）。scheduler と同じ時点で止め、実行中の読み取りが終わるのを待つ */
  ccRegistry?: Pick<CcRegistry, "stop" | "idle">;
  /**
   * Claude Code への送信の待ち行列（SELF_AGENT_CC=1 のときだけ）。scheduler と同じ時点で止め（新しく試さない。queued は次の起動で続ける）、
   * 貼っている途中の 1 件が終わるのを待つ（待ちきれずに落ちれば、次の起動で unconfirmed になる）
   */
  ccSender?: Pick<CcSender, "stop" | "idle">;
  /**
   * Claude Code のセッションの起動（SELF_AGENT_CC=1 のときだけ）。scheduler と同じ時点で止め（新しく起動しない・確かめ直さない）、
   * 起動の途中の 1 件と確かめている途中のものを待つ（起動した tmux のセッションは Bot の外なので残る）
   */
  ccStarter?: Pick<CcStarter, "stop" | "idle">;
  /**
   * Claude Code の許可の要求の保留（SELF_AGENT_CC=1 のときだけ）。scheduler と同じ時点で、保留中の全部に空の本文を返して released にし
   * （端末・RC のダイアログは残る）、以後の要求は保留しない
   */
  ccPermissions?: Pick<CcPermissionHold, "stop">;
  /**
   * Claude Code のチャンネルへの許可の要求・判断待ち・写し（SELF_AGENT_CC=1 のときだけ。CC12）。許可の要求の保留をやめた後に止め（新しく投稿しない）、
   * 投稿・書き換えの途中のもの（保留をやめた 1 通の書き換えを含む）を待つ
   */
  ccChannelPosts?: Pick<CcChannelPosts, "stop" | "idle">;
  /** cc_send・cc_start の確認の失効（SELF_AGENT_CC の有効・無効によらず動かす）。scheduler と同じ時点で止め、書き換えの途中のものを待つ */
  ccConfirmExpirer?: Pick<CcConfirmExpirer, "stop" | "idle">;
  /** Claude Code の返事を Discord に戻す（SELF_AGENT_CC=1 のときだけ）。scheduler と同じ時点で止め（新しい Stop を扱わない）、投稿の途中のものを待つ */
  ccReplier?: Pick<CcReplier, "stop" | "idle">;
  /** Claude Code の hook の受け口（SELF_AGENT_CC=1 のときだけ）。Web UI の次（DB を閉じる前）に閉じる */
  ccHookServer?: Pick<CcHookServer, "close">;
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
   * 受付と定期処理を止め、受け付け済みの発言・操作（返信まで）とキューのジョブ・実行中の tick・実行中のチャンネルの移動が終わるのを最大 shutdownGraceSec 秒待ってから、
   * gateway を止め、静的サーバー・Web UI と DB を閉じる。待っている間も gateway は動いているので、終わったターンの返信は送られる。reject しない
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
  const {
    cfg,
    gateway,
    queues,
    scheduler,
    reminderScheduler,
    githubPoller,
    jobs,
    channelOps,
    staticServer,
    webServer,
    ccRegistry,
    ccSender,
    ccStarter,
    ccPermissions,
    ccChannelPosts,
    ccConfirmExpirer,
    ccReplier,
    ccHookServer,
    closeDb,
    log,
  } = deps;
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
    await Promise.all([
      ...queues.map((queue) => queue.idle()),
      scheduler.idle(),
      reminderScheduler.idle(),
      githubPoller?.idle(),
      jobs?.idle(),
      ccRegistry?.idle(),
      ccSender?.idle(),
      ccStarter?.idle(),
      ccChannelPosts?.idle(),
      ccConfirmExpirer?.idle(),
      ccReplier?.idle(),
    ]);
    // ターンと定期処理が入れた移動のうち、その時点で実行中のものだけ待つ
    await channelOps.idle();
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
    reminderScheduler.stop();
    githubPoller?.stop();
    jobs?.stop();
    ccRegistry?.stop();
    ccSender?.stop();
    ccStarter?.stop();
    ccPermissions?.stop();
    ccChannelPosts?.stop();
    ccConfirmExpirer?.stop();
    ccReplier?.stop();
    log(`停止します（進行中の処理を最大 ${cfg.shutdownGraceSec} 秒待ちます）`);
    if (!(await settlesWithin(drained(), cfg.shutdownGraceSec * 1000))) {
      log(`進行中の処理が ${cfg.shutdownGraceSec} 秒で終わらなかったため、待たずに終了します`);
    }
    try {
      await gateway.stop();
    } catch (error) {
      log(`Discord との切断に失敗しました: ${describeError(error)}`);
    }
    // 配信のリクエストは DB を引くので、DB より先に閉じる
    try {
      await staticServer?.close();
    } catch (error) {
      log(`ページの配信を止められませんでした: ${describeError(error)}`);
    }
    try {
      await webServer?.close();
    } catch (error) {
      log(`Web UI を止められませんでした: ${describeError(error)}`);
    }
    try {
      await ccHookServer?.close();
    } catch (error) {
      log(`Claude Code の hook の受け口を止められませんでした: ${describeError(error)}`);
    }
    try {
      closeDb();
    } catch (error) {
      log(`DB を閉じられませんでした: ${describeError(error)}`);
    }
  };

  return { handlers, shutdown, stopping: () => stopping };
}
