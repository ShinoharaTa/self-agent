// エージェント実行の境界。Agent SDK を import しない（実装は sdk-runner.ts、テストでは偽物に差し替える）

/**
 * このターンを実行するチャンネル。ツールのハンドラに渡す（session_report が保存先を決める）。
 * kind はチャンネルの種類（#inbox・#tasks かセッションか）。1 ターンの上限とファイル操作の可否を決める。
 * scheduled は予約した依頼（リマインドの prompt）のターンで立てる（session_open を not_available にする）。
 * attachmentIds はこのターンの発言の画像のうち保存した原本（attachments の id）。保存したものがあるときだけ入る（記録への結びつけに使う）
 */
export type RunContext = {
  guildId: string;
  channelId: string;
  kind: "inbox" | "tasks" | "session";
  scheduled?: true;
  attachmentIds?: readonly number[];
};

/** prompt と一緒にモデルに渡す画像（base64）。形式は中身から確かめたもの */
export type RunImage = { mediaType: "image/jpeg" | "image/png" | "image/webp" | "image/gif"; data: string };

/** 途中経過の 1 手順（assistant メッセージの tool_use 1 つ）。label は表示用の短い文で、ファイルの中身・コマンド・URL・検索語は入れない */
export type ProgressStep = { label: string };

export type RunInput = {
  prompt: string;
  /** あれば prompt の後ろに画像の block として付けて渡す。無い・空なら prompt は文字列のまま渡す */
  images?: readonly RunImage[];
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

/**
 * メインループの 1 ステップ（API 呼び出し 1 回）の入力側のトークン。cacheCreation1hInputTokens は cacheCreationInputTokens のうち 1 時間のキャッシュの分。
 * 出力は持たない（途中の assistant メッセージの出力は確定していない）
 */
export type StepUsage = {
  inputTokens: number;
  cacheReadInputTokens: number;
  cacheCreationInputTokens: number;
  cacheCreation1hInputTokens: number;
};

/** メインループの各ステップの入力側のトークンの合計と、ステップごとの内訳（起きた順）。resume しても累計にならない、このターンの分 */
export type TurnUsage = {
  inputTokens: number;
  cacheReadInputTokens: number;
  cacheCreationInputTokens: number;
  cacheCreation1hInputTokens: number;
  /** このターンのメインループの出力の合計（result メッセージの usage）。成功したターンだけ入る */
  outputTokens?: number;
  steps: StepUsage[];
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
      /** 失敗するまでのメインループのトークン。1 ステップも届いていなければ入らない（中断・打ち切り・例外・result のエラーでも、届いた分は入る） */
      usage?: TurnUsage;
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
