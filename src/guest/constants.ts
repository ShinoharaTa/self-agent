// ゲスト利用の簡易モード（docs/plan/guest-mode.md §5）の定数。env にはしない

/** サーバーごとの有効なチャンネルの上限 */
export const GUEST_MAX_CHANNELS_PER_GUILD = 5;
/** 同じユーザーの前のターンからの間隔（秒）。短ければ無視する */
export const GUEST_MIN_INTERVAL_SEC = 5;
/** 本文の長さの上限 */
export const GUEST_MAX_CONTENT_CHARS = 2000;
/** ゲストのキューの待ちの上限。超えたら「混み合っています」 */
export const GUEST_MAX_QUEUE = 5;
/** 同じ SDK セッションでの resume が、結果の届かない失敗（タイムアウト・中断を除く）でこの回数続いたら、次のターンの前に捨てる */
export const GUEST_RESUME_FAILURE_LIMIT = 3;
/** SDK セッションを作ってからこの時間で捨てる */
export const GUEST_SESSION_MAX_AGE_HOURS = 24;
/** 1 日のターン数（guest_turns）を残す日数 */
export const GUEST_TURNS_KEEP_DAYS = 8;
/** ゲスト Bot の呼び名（システムプロンプトと /guest の文面の固定の文字列） */
export const GUEST_BOT_NAME = "しのえもん";
/** ゲスト Bot の Gateway の persona と usage_log の persona。人格の id には使えない（SELF_AGENT_PERSONAS の予約語） */
export const GUEST_PERSONA_ID = "guest";

/** ゲストのチャンネルの SDK セッションの key（channel_sessions。オーナー側のチャンネル ID と混ざらない） */
export function guestSessionKey(channelId: string): string {
  return `guest:${channelId}`;
}

/** 認証コード（docs/plan/guest-mode.md §3.2.2）の有効期限（時間） */
export const GUEST_INVITE_TTL_HOURS = 24;
/** 認証コードの先頭（`guest-xxxx-…`） */
export const GUEST_INVITE_PREFIX = "guest";
/** 認証コードの「DB を引く失敗」（not_found・wrong_guild・used・expired・superseded）を、サーバーごとに GUEST_INVITE_LOCK_MIN 分の窓でこの回数まで数える */
export const GUEST_INVITE_FAIL_LIMIT = 5;
/** 失敗の数の窓（分）と、上限に達したときに受け付けない時間（分） */
export const GUEST_INVITE_LOCK_MIN = 10;
