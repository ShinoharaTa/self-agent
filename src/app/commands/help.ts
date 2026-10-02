import type { CommandHandler } from "../interactions.ts";

export const HELP_TEXT = [
  "**self-agent の使い方**",
  "#inbox に書くと、タスクの登録・一覧・完了を受け付けます。",
  "",
  "**コマンド**",
  "`/help` この案内を表示します",
  "`/setup` self-agent 用のカテゴリとチャンネル（#inbox など）を作ります。2 回目以降は消えたものだけ作り直します",
  "`/new 題名` 「進行中」カテゴリにセッション用のチャンネルを作ります。そのチャンネルで話しかけると会話が続きます",
].join("\n");

/** `/help`: 使い方を本人にだけ表示する */
export const helpCommand: CommandHandler = {
  def: { name: "help", description: "使い方とコマンドの一覧を表示します" },
  async handle(_interaction, responder) {
    await responder.reply({ text: HELP_TEXT, ephemeral: true });
  },
};
