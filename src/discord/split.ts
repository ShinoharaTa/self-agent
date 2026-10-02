// Discord の本文分割。discord.js を import しない（単体テストのため）

const MESSAGE_LIMIT = 2000;

/** Discord の文字数上限で分割する。上限内の最後の改行で切り、改行が無ければ上限で切る */
export function splitMessage(text: string, limit: number = MESSAGE_LIMIT): string[] {
  const chunks: string[] = [];
  let rest = text;
  while (rest.length > limit) {
    const newline = rest.lastIndexOf("\n", limit);
    if (newline > 0) {
      chunks.push(rest.slice(0, newline));
      rest = rest.slice(newline + 1);
      continue;
    }
    let cut = limit;
    // サロゲートペアの途中で切らない
    const code = rest.charCodeAt(cut - 1);
    if (code >= 0xd800 && code <= 0xdbff) cut -= 1;
    chunks.push(rest.slice(0, cut));
    rest = rest.slice(cut);
  }
  chunks.push(rest);
  // 空白だけの塊は Discord が受け付けないので送らない
  return chunks.filter((chunk) => chunk.trim() !== "");
}
