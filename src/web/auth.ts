// Web UI の認証（docs/plan/web-ui.md §2）。Tailscale-User-Login の完全一致か、SELF_AGENT_WEB_TOKEN から作った Cookie（HMAC）。
// 純関数と、/login の失敗の窓（プロセス内）だけ。値（ヘッダ・Cookie・トークン）は log に出さない
import { createHmac, timingSafeEqual } from "node:crypto";
import type { IncomingHttpHeaders } from "node:http";

/** Cookie の名前 */
export const WEB_COOKIE_NAME = "self_agent_web";
/** Cookie の有効期間（秒。30 日） */
export const WEB_COOKIE_MAX_AGE_SEC = 2_592_000;
/** /login の窓（全体で 1 つ）: LOGIN_WINDOW_MS の間に LOGIN_MAX_ATTEMPTS 回まで */
export const LOGIN_WINDOW_MS = 60_000;
export const LOGIN_MAX_ATTEMPTS = 5;

export type AuthResult = "login" | "cookie" | "none";

/** 長さが違えば比べずに false。同じ長さなら timingSafeEqual */
export function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a, "utf8");
  const right = Buffer.from(b, "utf8");
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

function cookieHmac(token: string, exp: string): string {
  return createHmac("sha256", token).update(`v1:${exp}`).digest("hex");
}

/** Cookie ヘッダから名前の値を取り出す（無ければ undefined。同じ名前が複数あれば最初のもの） */
function cookieValue(cookieHeader: string | undefined, name: string): string | undefined {
  if (cookieHeader === undefined) return undefined;
  for (const part of cookieHeader.split(";")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim();
  }
  return undefined;
}

/**
 * 要求の認証。tailscale-user-login が allowedLogin と完全一致なら login、
 * token があり Cookie self_agent_web の `<exp>.<hmac>` の exp が数字で now より後、hmac が一致すれば cookie、それ以外は none
 */
export function authenticate(input: {
  headers: IncomingHttpHeaders;
  cookieHeader: string | undefined;
  allowedLogin: string;
  token: string | undefined;
  now: Date;
}): AuthResult {
  const login = input.headers["tailscale-user-login"];
  if (typeof login === "string" && safeEqual(login, input.allowedLogin)) return "login";
  if (input.token === undefined) return "none";
  const value = cookieValue(input.cookieHeader, WEB_COOKIE_NAME);
  if (value === undefined) return "none";
  const dot = value.indexOf(".");
  if (dot === -1) return "none";
  const exp = value.slice(0, dot);
  const hmac = value.slice(dot + 1);
  if (!/^\d{1,15}$/.test(exp) || Number(exp) * 1000 <= input.now.getTime()) return "none";
  return safeEqual(hmac, cookieHmac(input.token, exp)) ? "cookie" : "none";
}

/** /login が通ったときに渡す Cookie の値（exp は now から 30 日後の UNIX 秒） */
export function issueCookie(token: string, now: Date): { value: string; maxAge: number } {
  const exp = String(Math.floor(now.getTime() / 1000) + WEB_COOKIE_MAX_AGE_SEC);
  return { value: `${exp}.${cookieHmac(token, exp)}`, maxAge: WEB_COOKIE_MAX_AGE_SEC };
}

/** Set-Cookie の値 */
export function setCookieHeader(cookie: { value: string; maxAge: number }): string {
  return `${WEB_COOKIE_NAME}=${cookie.value}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=${cookie.maxAge}`;
}

/**
 * /login の試行の窓（全体で 1 つ）。attempt はトークンを比べる前に呼び、直近 LOGIN_WINDOW_MS に LOGIN_MAX_ATTEMPTS 回の試行があれば limited（数えない）、
 * それ以外は ok として数える
 */
export class LoginWindow {
  private attempts: number[] = [];

  attempt(now: Date): "ok" | "limited" {
    const at = now.getTime();
    this.attempts = this.attempts.filter((time) => at - time < LOGIN_WINDOW_MS);
    if (this.attempts.length >= LOGIN_MAX_ATTEMPTS) return "limited";
    this.attempts.push(at);
    return "ok";
  }
}
