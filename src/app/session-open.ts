// #inbox（足した人格の #<NAME> も）から始めた話題の文と seed。session_open の処理は app/right-hand.ts（M6）

export const AUTO_SESSION_LIMIT_MESSAGE = "今日はこれ以上自動で作れません。/new で作ってください";

/** 新しいチャンネルの最初のターンの prompt の先頭に付ける文（seed） */
export function inboxSeed(context: string): string {
  return `#inbox からの続き:\n${context}`;
}

/** session_open で作ったチャンネルの最初の投稿。from は呼ばれたチャンネルの名前（足した人格は #<NAME>） */
export function inboxWelcomeText(title: string, from: string = "inbox"): string {
  return `セッション「${title}」を始めました。#${from} の話の続きです。`;
}
