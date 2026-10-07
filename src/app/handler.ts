import type { AgentRunner, ProgressStep, RunResult } from "../agent/runner.ts";
import type { Config } from "../config.ts";
import type { Gateway, IncomingMessage, OutgoingMessage } from "../discord/gateway.ts";
import type { ChannelSeedStore } from "../store/channel-seeds.ts";
import type { InboxSummaryStore } from "../store/inbox-summaries.ts";
import type { MemoryStore } from "../store/memories.ts";
import type { SdkSessionStore } from "../store/sdk-sessions.ts";
import type { TopicSession, TopicSessionStore } from "../store/topic-sessions.ts";
import type { UsageStore } from "../store/usage.ts";
import { acceptedChannel, type ChannelKind, type ResolveChannel } from "./access.ts";
import type { ChannelOpsQueue } from "./channel-ops.ts";
import { abortTurnButton, continueTurnButton, MAX_TURNS_REPLY } from "./commands/turn-controls.ts";
import { buildTurnPrompt } from "./prompt.ts";
import type { KeyedSerialQueue } from "./queue.ts";
import { applySessionEvent } from "./session-state.ts";
import { ABORTED_ERROR, MAX_TURNS_ERROR_PREFIX, runChannelTurn, type TurnDeps } from "./turn.ts";
import { extractUrls } from "./urls.ts";

// 手順の上限で止まったときの返信は、その [続ける] と同じ turn-controls.ts に置く
export { MAX_TURNS_REPLY };

export const FAILURE_REPLY = "処理に失敗しました。時間をおいてもう一度送ってください。";
/** [中断] で止めたターンの返信 */
export const ABORTED_REPLY = "中断しました。続けるときは発言してください";
/** [続ける] で入れるターンの本文（オーナーの発言として扱う） */
export const CONTINUE_PROMPT = "続けてください";
export const EMPTY_REPLY = "（返答が空でした）";
/** そのターンで compaction が起きたとき、返信の末尾に足す 1 行 */
export const COMPACTED_NOTE = "（会話が長くなったため、古い部分を要約しました）";
/** 発言で待ち・完了から進行中に戻したターンの、返信の先頭に足す 1 行（成功したときだけ） */
export const REVIVED_NOTE = "（進行中に戻しました）";

/** セッションのチャンネルのターンが、開始からこれだけ経っても終わっていなければ途中経過のメッセージを出す */
export const PROGRESS_DELAY_MS = 20_000;
/** 途中経過のメッセージを出した後、表示が変わっていれば書き換える間隔 */
export const PROGRESS_INTERVAL_MS = 10_000;

/** 経過時間（`<m> 分 <s> 秒`。秒未満は切り捨て） */
export function formatElapsed(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  return `${Math.floor(seconds / 60)} 分 ${seconds % 60} 秒`;
}

/** 途中経過のメッセージの本文。直近の手順がまだ無ければ 2 行目は付けない */
export function progressText(elapsedMs: number, toolCalls: number, label: string | undefined): string {
  const head = `作業中…（${formatElapsed(elapsedMs)}・ツール ${toolCalls} 回）`;
  return label === undefined ? head : `${head}\n${label}`;
}

/** ターンの終わり方（途中経過の最後の書き換えに使う）。failed は timeout・例外など、それ以外の失敗 */
export type TurnOutcome = "done" | "max_turns" | "aborted" | "failed";

const OUTCOME_LABELS: Record<TurnOutcome, string> = {
  done: "完了",
  max_turns: "手順の上限で止まりました",
  aborted: "中断しました",
  failed: "止まりました",
};

/** ターンの終わり方。結果が無ければ（例外）failed */
export function turnOutcome(result: RunResult | undefined): TurnOutcome {
  if (result === undefined) return "failed";
  if (result.ok) return "done";
  if (result.errorMessage === ABORTED_ERROR) return "aborted";
  // sdk-runner は result の失敗を subtype から書き始める
  return result.errorMessage.startsWith(MAX_TURNS_ERROR_PREFIX) ? "max_turns" : "failed";
}

/** ターンが終わった後の途中経過のメッセージの本文（「完了」「手順の上限で止まりました」「中断しました」「止まりました」） */
export function progressEndText(outcome: TurnOutcome, elapsedMs: number, toolCalls: number): string {
  return `${OUTCOME_LABELS[outcome]}（${formatElapsed(elapsedMs)}・ツール ${toolCalls} 回）`;
}

/** テストでは偽のタイマーに差し替える */
export type ProgressTimers = {
  /** ms 後に fn を 1 回呼び、取り消す関数を返す */
  after(fn: () => void, ms: number): () => void;
  /** fn を ms ごとに呼び、止める関数を返す */
  every(fn: () => void, ms: number): () => void;
};

const REAL_TIMERS: ProgressTimers = {
  after: (fn, ms) => {
    const timer = setTimeout(fn, ms);
    return () => clearTimeout(timer);
  },
  every: (fn, ms) => {
    const timer = setInterval(fn, ms);
    return () => clearInterval(timer);
  },
};

export type HandlerDeps = {
  cfg: Pick<Config, "allowedGuildIds" | "ownerUserId" | "timeZone">;
  /** 受け付け対象のチャンネルか（DB の設定、無ければ env の #inbox。/new で作ったセッション） */
  resolveChannel: ResolveChannel;
  gateway: Gateway;
  runner: AgentRunner;
  sessions: SdkSessionStore;
  /** 次のターンの prompt の先頭に付ける文（resume 失敗の復旧など） */
  seeds: ChannelSeedStore;
  /** セッションの題名と最終発言の時刻、resume 失敗時の要約。待ち・完了のセッションは発言で進行中に戻す */
  topicSessions: Pick<TopicSessionStore, "touch" | "get" | "setActive" | "setWaiting">;
  /** #inbox の resume 失敗時の seed（直近の #inbox の要約） */
  inboxSummaries: Pick<InboxSummaryStore, "latest">;
  /** 新しい SDK セッションの最初の prompt に付ける記憶 */
  memories: Pick<MemoryStore, "list">;
  /** 進行中に戻したセッションを進行中カテゴリへ移す */
  channelOps: Pick<ChannelOpsQueue, "enqueueMove">;
  usage: UsageStore;
  /** ターンのキュー（key は channelId）。/close のターンも同じキューに入れる。セッションのターンはセッションのジョブとして入れる */
  queue: KeyedSerialQueue;
  /** 途中経過の経過時間を測る */
  now: () => Date;
  /** 途中経過を出す・書き換えるタイマー。省略すれば実際のタイマー */
  timers?: ProgressTimers;
  log: (message: string) => void;
};

export type Handler = {
  /** 受け付けた発言を 1 ターンとして処理する。reject しない（失敗は log に出す） */
  handleMessage(event: IncomingMessage): Promise<void>;
  /**
   * [続ける]: そのチャンネルに「続けてください」を、オーナーの発言と同じ経路で 1 ターン入れる（日時ヘッダは at、返信先は無し、URL は無し）。
   * 受け付けるセッションでなければ何もしない。返信まで待つ。reject しない
   */
  continueTurn(guildId: string, channelId: string, at: Date): Promise<void>;
  /**
   * そのセッションのチャンネルで実行中の（発言・[続ける] の）ターンを、番号（turnSeq）が一致するときだけ中断する。
   * 実行中のターンが無い・番号が違う（前のターンのボタン）なら false（#inbox・/close のターンは中断できない）
   */
  abortTurn(channelId: string, turnSeq: number): boolean;
};

/** 1 ターンの依頼（オーナーの発言か [続ける]） */
type TurnRequest = {
  guildId: string;
  channelId: string;
  kind: ChannelKind;
  /** オーナーの発言の本文（[続ける] なら CONTINUE_PROMPT） */
  content: string;
  /** 日時ヘッダの時刻 */
  at: Date;
  /** 返信先の発言。無ければ返信にしない */
  replyToId?: string;
};

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * 受け付けた発言（と [続ける]）を 1 ターンとして処理する。セッションのチャンネルのターンには途中経過と [中断] を付け、
 * 手順の上限で止まったら [続ける] を付ける（#inbox には付けない）
 */
export function createHandler(deps: HandlerDeps): Handler {
  const {
    cfg,
    resolveChannel,
    gateway,
    runner,
    sessions,
    seeds,
    topicSessions,
    inboxSummaries,
    memories,
    channelOps,
    usage,
    queue,
    now,
    log,
  } = deps;
  const timers = deps.timers ?? REAL_TIMERS;
  const turnDeps: TurnDeps = { runner, sessions, seeds, topicSessions, inboxSummaries, memories, usage, log };
  /** 実行中のセッションのチャンネルのターンの番号と中断（key は channelId。ターンが終わったら消す） */
  const running = new Map<string, { turnSeq: number; controller: AbortController }>();
  /** 最後に振ったターンの番号（セッションのチャンネルのターンごとに 1 ずつ増やす。[中断] のボタンに入れる） */
  let lastTurnSeq = 0;

  /** セッションが待ち・完了なら進行中に戻して進行中カテゴリへ移す（知らせは返信の先頭に付ける）。戻したら true */
  const revive = (session: Pick<TopicSession, "channelId" | "guildId" | "state">): boolean => {
    if (applySessionEvent(session, "message", { topicSessions, channelOps }).move === null) return false;
    log(`発言があったためセッションを進行中に戻しました（guild=${session.guildId}）`);
    return true;
  };

  /** 返信の失敗は log に出して終える（再試行しない）。返信先が無ければ普通の投稿にする */
  const reply = async (request: TurnRequest, text: string): Promise<void> => {
    try {
      await gateway.send(request.channelId, text, request.replyToId);
    } catch (error) {
      log(`返信に失敗しました: ${describeError(error)}`);
    }
  };

  /** ボタン付きの返信（返信先は付けない）。失敗は log に出して終える */
  const replyWithButtons = async (request: TurnRequest, message: OutgoingMessage): Promise<void> => {
    try {
      await gateway.sendMessage(request.channelId, message);
    } catch (error) {
      log(`返信に失敗しました: ${describeError(error)}`);
    }
  };

  /**
   * セッションのチャンネルのターンの途中経過。開始から PROGRESS_DELAY_MS 経っても終わっていなければ、そのターンの番号の [中断] 付きのメッセージを 1 つ送り、
   * 以後 PROGRESS_INTERVAL_MS ごとに、表示が変わっていれば書き換える（ボタンは残す）。finish でタイマーを止め、
   * 送っていれば終わり方（progressEndText）に書き換えてボタンを外す。送信・編集は順に行い、失敗は log だけ（ターンは止めない）
   */
  const startProgress = (
    channelId: string,
    turnSeq: number,
  ): { onProgress: (step: ProgressStep) => void; finish: (outcome: TurnOutcome) => Promise<void> } => {
    const startedAt = now().getTime();
    let toolCalls = 0;
    let label: string | undefined;
    let messageId: string | undefined;
    let shown: string | undefined;
    let finished = false;
    let chain = Promise.resolve();
    let stopEvery = (): void => {};
    const elapsed = (): number => now().getTime() - startedAt;
    const enqueue = (fn: () => Promise<void>): void => {
      chain = chain.then(fn);
    };
    const update = (): void => {
      enqueue(async () => {
        if (finished || messageId === undefined) return;
        const text = progressText(elapsed(), toolCalls, label);
        if (text === shown) return;
        try {
          await gateway.editMessage(channelId, messageId, { text });
          shown = text;
        } catch (error) {
          log(`途中経過の更新に失敗しました: ${describeError(error)}`);
        }
      });
    };
    const cancelDelay = timers.after(() => {
      enqueue(async () => {
        if (finished) return;
        const text = progressText(elapsed(), toolCalls, label);
        try {
          messageId = await gateway.sendMessage(channelId, {
            text,
            components: [{ kind: "buttons", buttons: [abortTurnButton(channelId, turnSeq)] }],
          });
          shown = text;
        } catch (error) {
          log(`途中経過の送信に失敗しました: ${describeError(error)}`);
        }
      });
      stopEvery = timers.every(update, PROGRESS_INTERVAL_MS);
    }, PROGRESS_DELAY_MS);

    return {
      onProgress: (step) => {
        toolCalls++;
        label = step.label;
      },
      finish: async (outcome) => {
        finished = true;
        cancelDelay();
        stopEvery();
        const text = progressEndText(outcome, elapsed(), toolCalls);
        enqueue(async () => {
          if (messageId === undefined) return;
          try {
            await gateway.editMessage(channelId, messageId, { text, components: [] });
          } catch (error) {
            log(`途中経過の更新に失敗しました: ${describeError(error)}`);
          }
        });
        await chain;
      },
    };
  };

  /**
   * channelName は prompt の日時ヘッダに入れるチャンネル名。revivedBeforeQueue はキュー待ちの前に進行中に戻したか。
   * セッションはキュー待ちの間に変わりうる（/close の確定で完了になる等）ので、ここで読み直して待ち・完了なら改めて進行中に戻す。
   * セッションのチャンネルのターンは、番号を振って実行中の間だけ中断できるようにし、途中経過を出す
   */
  const handleTurn = async (request: TurnRequest, channelName: string, revivedBeforeQueue: boolean): Promise<void> => {
    const { guildId, channelId, kind } = request;
    const current = kind === "session" ? topicSessions.get(channelId) : undefined;
    const revived = (current !== undefined && revive(current)) || revivedBeforeQueue;
    const stopTyping = gateway.startTyping(channelId);
    const turn = kind === "session" ? { turnSeq: ++lastTurnSeq, controller: new AbortController() } : undefined;
    if (turn !== undefined) running.set(channelId, turn);
    const progress = turn === undefined ? undefined : startProgress(channelId, turn.turnSeq);
    let result: RunResult | undefined;
    try {
      // 会話の単位はチャンネル（key は channelId）
      result = await runChannelTurn(turnDeps, {
        guildId,
        channelId,
        kind,
        // 日時はキュー待ちでずれないよう、発言の時刻（[続ける] は押した時刻）を使う
        prompt: buildTurnPrompt(request.content, request.at, cfg.timeZone, channelName),
        // WebFetch で取得できるのは、この発言に貼られた URL だけ
        allowedUrls: extractUrls(request.content),
        ...(turn === undefined ? {} : { signal: turn.controller.signal }),
        ...(progress === undefined ? {} : { onProgress: progress.onProgress }),
      });
    } finally {
      stopTyping();
      if (turn !== undefined && running.get(channelId) === turn) running.delete(channelId);
      // 途中経過のタイマーはターンの終わりで必ず止める
      await progress?.finish(turnOutcome(result));
    }

    if (result.ok) {
      let text = result.text.trim() === "" ? EMPTY_REPLY : result.text;
      if (revived) text = `${REVIVED_NOTE}\n${text}`;
      await reply(request, result.compacted === undefined ? text : `${text}\n${COMPACTED_NOTE}`);
      return;
    }

    log(`ターンが失敗しました: ${result.errorMessage}`);
    if (result.errorMessage === ABORTED_ERROR) {
      await reply(request, ABORTED_REPLY);
      return;
    }
    // sdk-runner は result の失敗を subtype から書き始める
    if (!result.errorMessage.startsWith(MAX_TURNS_ERROR_PREFIX)) {
      await reply(request, FAILURE_REPLY);
      return;
    }
    // セッションのチャンネルだけ [続ける] を付ける
    if (kind === "session") {
      await replyWithButtons(request, {
        text: MAX_TURNS_REPLY,
        components: [{ kind: "buttons", buttons: [continueTurnButton(channelId)] }],
      });
      return;
    }
    await reply(request, MAX_TURNS_REPLY);
  };

  /** 受け付けた依頼をキューに入れる（発言と [続ける] で共通） */
  const submit = async (request: TurnRequest): Promise<void> => {
    let channelName = "inbox";
    let revived = false;
    if (request.kind === "session") {
      // 最終発言の時刻はキュー待ちの前に記録する。日時ヘッダには題名を出す
      const session = topicSessions.touch(request.channelId);
      if (session === undefined) return;
      channelName = session.title;
      // 待ち・完了なら進行中に戻して進行中カテゴリへ移す（ターンは通常どおり行い、返信の先頭で知らせる）
      revived = revive(session);
    }
    // セッションのターンは同時実行の枠を 1 つ #inbox 用に残す
    await queue.run(request.channelId, () => handleTurn(request, channelName, revived), {
      session: request.kind === "session",
    });
  };

  return {
    handleMessage: async (event) => {
      try {
        // 受付判定は DB を引くので try の中で行う
        const kind = acceptedChannel(event, cfg, resolveChannel);
        // 受け付けた発言は必ずサーバー内（guildId は null でない）
        if (kind === null || event.guildId === null) return;
        await submit({
          guildId: event.guildId,
          channelId: event.channelId,
          kind,
          content: event.content,
          at: event.createdAt,
          replyToId: event.id,
        });
      } catch (error) {
        log(`ターンの処理中にエラーが発生しました: ${describeError(error)}`);
      }
    },
    continueTurn: async (guildId, channelId, at) => {
      try {
        if (resolveChannel(guildId, channelId) !== "session") return;
        await submit({ guildId, channelId, kind: "session", content: CONTINUE_PROMPT, at });
      } catch (error) {
        log(`ターンの処理中にエラーが発生しました: ${describeError(error)}`);
      }
    },
    abortTurn: (channelId, turnSeq) => {
      const turn = running.get(channelId);
      if (turn === undefined || turn.turnSeq !== turnSeq) return false;
      turn.controller.abort();
      return true;
    },
  };
}
