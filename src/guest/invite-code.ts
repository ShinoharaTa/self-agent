// 認証コード（docs/plan/guest-mode.md §3.2.2）。純関数。
// 形は `guest-` + 小文字の Crockford base32（i l o u を使わない）24 文字を 4 文字ずつ `-` で区切ったもの。DB にはハッシュ（sha256 の hex）だけを置く
import { createHash } from "node:crypto";
import { GUEST_INVITE_PREFIX } from "./constants.ts";

/** 小文字の Crockford base32 */
const ALPHABET = "0123456789abcdefghjkmnpqrstvwxyz";
/** 120 bit。base32 で丁度 24 文字（余りなし） */
const CODE_BYTES = 15;
const GROUP_CHARS = 4;
/** 正規化した（小文字の）コードの形 */
const CODE_PATTERN = new RegExp(`^${GUEST_INVITE_PREFIX}(-[0-9a-hjkmnp-tv-z]{${GROUP_CHARS}}){6}$`);

/** 新しいコード（randomBytes は node:crypto の randomBytes。テストでは決まった値を渡す） */
export function generateInviteCode(randomBytes: (size: number) => Uint8Array): string {
  const bytes = randomBytes(CODE_BYTES);
  if (bytes.length !== CODE_BYTES) throw new Error("認証コードの乱数の長さが違います");
  let chars = "";
  let buffer = 0;
  let bits = 0;
  for (const byte of bytes) {
    buffer = (buffer << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      chars += ALPHABET[(buffer >> bits) & 31];
    }
    buffer &= (1 << bits) - 1;
  }
  const groups: string[] = [];
  for (let index = 0; index < chars.length; index += GROUP_CHARS) groups.push(chars.slice(index, index + GROUP_CHARS));
  return [GUEST_INVITE_PREFIX, ...groups].join("-");
}

/**
 * 貼られた本文から正規化したコードを取る（docs/plan/guest-mode.md §3.2.2）。ゲスト Bot へのメンションは呼び出し側が先に除く（stripBotMention）。
 * 前後の空白を除き、両端が 1 組のバッククォートならそれも除いて小文字にし、形に合えばその文字列、合わなければ undefined（前置き・後置きがあれば合わない）
 */
export function parseInviteCode(text: string): string | undefined {
  let value = text.trim();
  if (value.length >= 2 && value.startsWith("`") && value.endsWith("`")) value = value.slice(1, -1);
  value = value.toLowerCase();
  return CODE_PATTERN.test(value) ? value : undefined;
}

/** 正規化したコード（generateInviteCode の結果か、貼られた本文を正規化したもの）の sha256 の hex */
export function hashInviteCode(code: string): string {
  return createHash("sha256").update(code).digest("hex");
}
