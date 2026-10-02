import type { CommandHandler } from "../interactions.ts";

export const HELP_TEXT = [
  "**self-agent の使い方**",
  "#inbox に書くと、タスクの登録・一覧・完了を受け付けます。",
  "",
  "**コマンド**",
  "`/help` この案内を表示します",
  "`/setup` self-agent 用のカテゴリとチャンネル（#inbox など）を作ります。2 回目以降は消えたものだけ作り直します",
  "`/new 題名` 「進行中」カテゴリにセッション用のチャンネルを作ります。そのチャンネルで話しかけると会話が続きます",
  "`/close` セッションのチャンネルで実行すると、要約を残し、やることの候補を確認して登録してから「完了」カテゴリへ移します",
  "`/wait` セッションのチャンネルで実行すると「待ち」カテゴリへ移します。そのチャンネルで発言すると「進行中」に戻ります",
  "`/sessions` 進行中・待ち・完了（最近の分）のセッションをリンク付きで一覧にします",
  "`/tasks` 未完了のタスクを一覧にします。選んで完了にできます",
  "`/usage` 今日と直近 7 日のターン数・トークン・キャッシュ・ツール呼び出しの数を表示します",
  "",
  "#inbox にピン留めしたホームパネル（/setup が投稿します）のボタンでも、セッションの作成・タスク一覧・待ちのセッションの一覧を開けます。",
].join("\n");

/** `/help`: 使い方を本人にだけ表示する */
export const helpCommand: CommandHandler = {
  def: { name: "help", description: "使い方とコマンドの一覧を表示します" },
  async handle(_interaction, responder) {
    await responder.reply({ text: HELP_TEXT, ephemeral: true });
  },
};
