// エージェント実行の境界。Agent SDK を import しない（実装は sdk-runner.ts、テストでは偽物に差し替える）

/** このターンを実行するチャンネル。ツールのハンドラに渡す（session_report が保存先を決める） */
export type RunContext = { guildId: string; channelId: string };

export type RunInput = {
  prompt: string;
  /** 指定すればそのセッションを resume する */
  sessionId?: string;
  context?: RunContext;
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
    }
  | {
      ok: false;
      errorMessage: string;
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
