// 要約の文字列（/close と #inbox の切り替えで共通）
import { CLOSE_SUMMARY_MAX_LENGTH } from "../store/topic-sessions.ts";

/** session_report が呼ばれず、返答も空だったときの要約 */
export const EMPTY_SUMMARY = "（要約なし）";

/** UTF-16 の単位で max までに切る。サロゲートペアの途中で切れたら前半も落とす */
export function clip(text: string, max: number, ellipsis: string = ""): string {
  if (text.length <= max) return text;
  let cut = text.slice(0, max - ellipsis.length);
  if (/[\uD800-\uDBFF]$/.test(cut)) cut = cut.slice(0, -1);
  return `${cut}${ellipsis}`;
}

/** session_report が呼ばれなかったときの要約（返答本文の先頭 600 字。空なら「（要約なし）」）。#inbox の切り替えの要約にも使う */
export function fallbackSummary(text: string): string {
  const summary = clip(text.trim(), CLOSE_SUMMARY_MAX_LENGTH);
  return summary === "" ? EMPTY_SUMMARY : summary;
}

/** #inbox の要約を次のターンの prompt の先頭に付けるときの形（切り替えと、#inbox の resume 失敗からの復旧で共通） */
export function rotatedSeed(summary: string): string {
  return `これまでの #inbox の要約:\n${summary}`;
}
