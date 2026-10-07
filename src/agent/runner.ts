// エージェント実行の境界。Agent SDK を import しない（実装は sdk-runner.ts、テストでは偽物に差し替える）

/**
 * このターンを実行するチャンネル。ツールのハンドラに渡す（session_report が保存先を決める）。
 * kind はチャンネルの種類（#inbox かセッションか）。1 ターンの上限とファイル操作の可否を決める
 */
export type RunContext = { guildId: string; channelId: string; kind: "inbox" | "session" };

/** 途中経過の 1 手順（assistant メッセージの tool_use 1 つ）。label は表示用の短い文で、ファイルの中身・コマンド・URL・検索語は入れない */
export type ProgressStep = { label: string };

export type RunInput = {
  prompt: string;
  /** 指定すればそのセッションを resume する */
  sessionId?: string;
  context?: RunContext;
  /** このターンで WebFetch に取得を許す URL（オーナーがこのターンの発言に貼ったもの）。未指定・空なら WebFetch はすべて拒否する */
  allowedUrls?: readonly string[];
  /** 外からの中断（[中断]）。abort されたらターンを止め、errorMessage "aborted" の失敗を返す（打ち切りの "timeout" とは別） */
  signal?: AbortSignal;
  /** メインループの assistant メッセージの tool_use ごとに 1 回呼ぶ（途中経過の表示に使う） */
  onProgress?: (step: ProgressStep) => void;
};

/** メインループの各ステップの入力側トークン（resume しても累計にならない、このターンの分） */
export type TurnUsage = {
  inputTokens: number;
  cacheReadInputTokens: number;
  cacheCreationInputTokens: number;
};

/** このターン中に SDK が会話を要約した（compaction）。trigger は "auto" / "manual"、preTokens は要約前のトークン数 */
export type Compaction = { trigger: string; preTokens?: number };

export type RunResult =
  | {
      ok: true;
      text: string;
      sessionId: string;
      usage: TurnUsage;
      durationMs: number;
      /** compaction が起きたときだけ入る */
      compacted?: Compaction;
      /** このターンのツール呼び出しの回数（失敗した呼び出しを含む） */
      toolCalls: number;
      /**
       * メインループの最後のステップ（最後の assistant メッセージ）の入力（input + cache read + cache creation）。
       * usage と違って合算しないので、ターンを終えた時点の会話の大きさの目安になる
       */
      contextTokens: number;
    }
  | {
      ok: false;
      errorMessage: string;
      /** 失敗するまでのツール呼び出しの回数（失敗した呼び出しを含む） */
      toolCalls: number;
      /** 途中で受け取った session_id（まだ受け取っていなければ resume 元の sessionId）。中断・打ち切り・例外で終わっても入る */
      sessionId?: string;
      /**
       * sessionId が result メッセージのもの（SDK が会話を記録済みで、次のターンで resume できる）なら true。
       * 例外・タイムアウトなど result を受け取れなかった失敗では false
       */
      sessionRecorded: boolean;
    };

export interface AgentRunner {
  run(input: RunInput): Promise<RunResult>;
}
