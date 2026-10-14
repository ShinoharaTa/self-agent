// Discord のテキストチャンネル名への正規化（/new・session_open のセッションと、足した人格の #<NAME> で共通。config の検証にも使う）

/** チャンネル名の文字数の上限（UTF-16 の単位で数える） */
export const CHANNEL_NAME_MAX_LENGTH = 100;

/** ASCII の記号のうち `-` と `_` 以外 */
const ASCII_SYMBOLS = /[\x21-\x2C\x2E\x2F\x3A-\x40\x5B-\x5E\x60\x7B-\x7E]/g;

/**
 * 文字列をチャンネル名にする。前後の空白を除く → 空白の連続を `-` に → `-` と `_` 以外の ASCII 記号を除く →
 * ASCII 英字を小文字に → `-` の連続を 1 つに、先頭・末尾の `-` を除く → 100 字で切る。日本語はそのまま残す。空になることがある
 */
export function normalizeChannelName(text: string): string {
  let name = text
    .trim()
    .replace(/\s+/gu, "-")
    .replace(ASCII_SYMBOLS, "")
    .replace(/[A-Z]/g, (letter) => letter.toLowerCase())
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, CHANNEL_NAME_MAX_LENGTH);
  // サロゲートペアの途中で切れたら、残った前半も落とす
  if (/[\uD800-\uDBFF]$/.test(name)) name = name.slice(0, -1);
  // 切った位置で末尾に - が残ることがあるので除く
  return name.replace(/-+$/, "");
}
