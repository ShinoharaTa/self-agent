// Discord に出す文字列のエスケープ（純関数だけ。#github と #jobs の投稿で共通）

/** Discord の Markdown・メンション・リンクとして解釈される文字を無効にする（第三者の文字列を 1 行で出すため） */
export function escapeDiscordText(text: string): string {
  return text.replace(/[\\*_~`|>#[\]()<:@-]/g, (char) => `\\${char}`);
}
