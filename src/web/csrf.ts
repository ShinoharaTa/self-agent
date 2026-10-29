// Web UI の POST の CSRF の判定（docs/plan/web-ui.md §2）。純関数
import type { IncomingHttpHeaders } from "node:http";

function header(headers: IncomingHttpHeaders, name: string): string | undefined {
  const value = headers[name];
  return typeof value === "string" ? value : undefined;
}

/** Sec-Fetch-Site があれば same-origin、無ければ Origin のホスト部（host:port）が host と一致。どちらも無ければ false（/login も使う） */
export function sameOrigin(headers: IncomingHttpHeaders, host: string | undefined): boolean {
  const site = header(headers, "sec-fetch-site");
  if (site !== undefined) return site === "same-origin";
  const origin = header(headers, "origin");
  if (origin === undefined || host === undefined) return false;
  try {
    return new URL(origin).host === host.toLowerCase();
  } catch {
    return false;
  }
}

/** Content-Type が type（`; charset=…` などの引数付きも可。大文字小文字は問わない） */
export function hasContentType(headers: IncomingHttpHeaders, type: string): boolean {
  const value = header(headers, "content-type");
  if (value === undefined) return false;
  return value.split(";")[0]!.trim().toLowerCase() === type;
}

/** API の POST の 3 条件のうちヘッダの分: 同じオリジン（sameOrigin）・X-Self-Agent: 1・Content-Type: application/json。本文の形は呼び出し側が確かめる */
export function csrfOk(headers: IncomingHttpHeaders, host: string | undefined): boolean {
  return sameOrigin(headers, host) && header(headers, "x-self-agent") === "1" && hasContentType(headers, "application/json");
}
