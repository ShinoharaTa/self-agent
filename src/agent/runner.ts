// エージェント実行の境界。Agent SDK を import しない（実装は sdk-runner.ts、テストでは偽物に差し替える）

export type RunInput = {
  prompt: string;
  /** 指定すればそのセッションを resume する */
  sessionId?: string;
};

/** メインループの各ステップの入力側トークン（resume しても累計にならない、このターンの分） */
export type TurnUsage = {
  inputTokens: number;
  cacheReadInputTokens: number;
  cacheCreationInputTokens: number;
};

export type RunResult =
  | { ok: true; text: string; sessionId: string; usage: TurnUsage; durationMs: number }
  | { ok: false; errorMessage: string; sessionId?: string };

export interface AgentRunner {
  run(input: RunInput): Promise<RunResult>;
}
