// 途中経過のメッセージ（「作業中…（m 分 s 秒・ツール n 回）」+ 直近の手順と [中断]）。セッションのチャンネルのターン（handler.ts）と
// 作業ジョブ（jobs/orchestrator.ts）で共通。送信先・ボタン・最初の 1 通を出すまでの遅れは呼び出し側が決める
import type { ProgressStep } from "../agent/runner.ts";
import type { ButtonDef, OutgoingMessage } from "../discord/gateway.ts";

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

export const REAL_TIMERS: ProgressTimers = {
  after: (fn, ms) => {
    const timer = setTimeout(fn, ms);
    return () => clearTimeout(timer);
  },
  every: (fn, ms) => {
    const timer = setInterval(fn, ms);
    return () => clearInterval(timer);
  },
};

export type ProgressOptions = {
  /** 最初の 1 通を送り、そのメッセージの ID を返す（messageId があれば使わない） */
  send: (message: OutgoingMessage) => Promise<string>;
  /**
   * 既に送ってあるメッセージ（ジョブの受け付けのメッセージ）。あれば最初の 1 通は送らずにこれを書き換え、finish では
   * 最初の表示の前に終わっても終わり方に書き換える
   */
  messageId?: string;
  /** 送ったメッセージを書き換える（components を省略するとボタンを残し、[] で外す） */
  edit: (messageId: string, message: OutgoingMessage) => Promise<void>;
  /** 途中経過に付けるボタン（[中断]） */
  buttons: readonly ButtonDef[];
  /** 始めてから最初の 1 通を送るまでの時間（セッションのターンは 20 秒、ジョブは 0） */
  delayMs: number;
  /** 経過時間を測る */
  now: () => Date;
  /** 省略すれば実際のタイマー */
  timers?: ProgressTimers;
  log: (message: string) => void;
};

export type Progress = {
  /** 手順（tool_use）ごとに呼ぶ */
  onProgress: (step: ProgressStep) => void;
  /** タイマーを止め、送っていれば終わり方（progressEndText）に書き換えてボタンを外す。送信・書き換えが終わるまで待つ */
  finish: (outcome: TurnOutcome) => Promise<void>;
};

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * 途中経過。始めてから delayMs 経っても終わっていなければ、buttons 付きのメッセージを 1 つ送り（messageId があればそれを書き換え）、
 * 以後 PROGRESS_INTERVAL_MS ごとに、表示が変わっていれば書き換える（ボタンは残す）。finish でタイマーを止め、
 * 送っていれば終わり方（progressEndText）に書き換えてボタンを外す。送信・編集は順に行い、失敗は log だけ（呼び出し側の処理は止めない）
 */
export function startProgress(options: ProgressOptions): Progress {
  const { send, edit, buttons, delayMs, now, log } = options;
  const timers = options.timers ?? REAL_TIMERS;
  const startedAt = now().getTime();
  let toolCalls = 0;
  let label: string | undefined;
  let messageId: string | undefined = options.messageId;
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
        await edit(messageId, { text });
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
      const message: OutgoingMessage = { text, components: [{ kind: "buttons", buttons: [...buttons] }] };
      try {
        if (messageId === undefined) messageId = await send(message);
        else await edit(messageId, message);
        shown = text;
      } catch (error) {
        log(`途中経過の送信に失敗しました: ${describeError(error)}`);
      }
    });
    stopEvery = timers.every(update, PROGRESS_INTERVAL_MS);
  }, delayMs);

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
          await edit(messageId, { text, components: [] });
        } catch (error) {
          log(`途中経過の更新に失敗しました: ${describeError(error)}`);
        }
      });
      await chain;
    },
  };
}
