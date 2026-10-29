import { test } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { authenticate, issueCookie, LoginWindow, safeEqual, setCookieHeader } from "../src/web/auth.ts";
import { csrfOk, sameOrigin } from "../src/web/csrf.ts";
import { isLoopback } from "../src/web/server.ts";
import { staticFileFor } from "../src/web/static.ts";

const NOW = new Date("2026-10-29T00:00:00Z");
const TOKEN = "x".repeat(40);
const LOGIN = "owner@example.com";

function cookieFor(exp: number, token = TOKEN): string {
  return `self_agent_web=${exp}.${createHmac("sha256", token).update(`v1:${exp}`).digest("hex")}`;
}

/** token の null はトークンなし */
const auth = (headers: Record<string, string>, cookieHeader?: string, token: string | null = TOKEN) =>
  authenticate({ headers, cookieHeader, allowedLogin: LOGIN, token: token ?? undefined, now: NOW });

test("authenticate: Tailscale-User-Login の完全一致は login。違う・無いなら Cookie を見る", () => {
  assert.equal(auth({ "tailscale-user-login": LOGIN }), "login");
  assert.equal(auth({ "tailscale-user-login": LOGIN }, undefined, null), "login");
  assert.equal(auth({ "tailscale-user-login": "other@example.com" }), "none");
  assert.equal(auth({ "tailscale-user-login": `${LOGIN} ` }), "none");
  assert.equal(auth({ "tailscale-user-login": LOGIN.toUpperCase() }), "none");
  assert.equal(auth({}), "none");
});

test("authenticate: Cookie は exp が未来で hmac が一致するときだけ cookie。トークンが無ければ見ない", () => {
  const exp = Math.floor(NOW.getTime() / 1000) + 60;
  assert.equal(auth({}, cookieFor(exp)), "cookie");
  assert.equal(auth({}, `a=1; ${cookieFor(exp)}; b=2`), "cookie");
  // 期限切れ・ちょうど
  assert.equal(auth({}, cookieFor(Math.floor(NOW.getTime() / 1000) - 1)), "none");
  assert.equal(auth({}, cookieFor(Math.floor(NOW.getTime() / 1000))), "none");
  // 別のトークンで作ったもの・hmac の長さ違い・exp が数字でない
  assert.equal(auth({}, cookieFor(exp, "y".repeat(40))), "none");
  assert.equal(auth({}, `self_agent_web=${exp}.abcd`), "none");
  assert.equal(auth({}, `self_agent_web=1e12.${"0".repeat(64)}`), "none");
  assert.equal(auth({}, "self_agent_web="), "none");
  assert.equal(auth({}, "other=1"), "none");
  // トークンが無ければ Cookie は通さない
  assert.equal(auth({}, cookieFor(exp), null), "none");
});

test("issueCookie: 30 日後の exp と hmac。authenticate が通り、Set-Cookie は HttpOnly・Secure・SameSite=Strict・Max-Age=2592000", () => {
  const cookie = issueCookie(TOKEN, NOW);
  assert.equal(cookie.maxAge, 2592000);
  assert.match(cookie.value, /^\d+\.[0-9a-f]{64}$/);
  assert.equal(Number(cookie.value.split(".")[0]), Math.floor(NOW.getTime() / 1000) + 2592000);
  assert.equal(auth({}, `self_agent_web=${cookie.value}`), "cookie");
  assert.equal(
    setCookieHeader(cookie),
    `self_agent_web=${cookie.value}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=2592000`,
  );
});

test("safeEqual: 長さが違えば false、同じなら内容で比べる", () => {
  assert.equal(safeEqual("abc", "abc"), true);
  assert.equal(safeEqual("abc", "abd"), false);
  assert.equal(safeEqual("abc", "abcd"), false);
  assert.equal(safeEqual("", ""), true);
});

test("LoginWindow: 1 分に 5 回まで。6 回目は limited で、最初の試行から 1 分経てば戻る", () => {
  const window = new LoginWindow();
  const at = (ms: number) => new Date(NOW.getTime() + ms);
  for (let i = 0; i < 5; i++) assert.equal(window.attempt(at(i * 1000)), "ok", `${i + 1} 回目`);
  assert.equal(window.attempt(at(5000)), "limited");
  assert.equal(window.attempt(at(59_999)), "limited");
  assert.equal(window.attempt(at(60_000)), "ok");
  assert.equal(window.attempt(at(60_001)), "limited");
});

test("sameOrigin・csrfOk: Sec-Fetch-Site があれば same-origin だけ、無ければ Origin のホストが Host と一致。X-Self-Agent: 1 と JSON の Content-Type も要る", () => {
  const host = "127.0.0.1:8791";
  const base = { "x-self-agent": "1", "content-type": "application/json" };
  assert.equal(csrfOk({ ...base, "sec-fetch-site": "same-origin" }, host), true);
  assert.equal(csrfOk({ ...base, "sec-fetch-site": "same-origin", "content-type": "application/json; charset=utf-8" }, host), true);
  assert.equal(csrfOk({ ...base, origin: "http://127.0.0.1:8791" }, host), true);
  for (const site of ["same-site", "cross-site", "none"]) {
    // Origin が一致していても Sec-Fetch-Site を優先する
    assert.equal(csrfOk({ ...base, "sec-fetch-site": site, origin: "http://127.0.0.1:8791" }, host), false, site);
  }
  assert.equal(csrfOk({ ...base, origin: "http://127.0.0.1:9999" }, host), false);
  assert.equal(csrfOk({ ...base, origin: "null" }, host), false);
  assert.equal(csrfOk(base, host), false);
  assert.equal(csrfOk({ ...base, origin: "http://127.0.0.1:8791" }, undefined), false);
  assert.equal(csrfOk({ "content-type": "application/json", "sec-fetch-site": "same-origin" }, host), false);
  assert.equal(csrfOk({ ...base, "x-self-agent": "0", "sec-fetch-site": "same-origin" }, host), false);
  assert.equal(csrfOk({ ...base, "content-type": "text/plain", "sec-fetch-site": "same-origin" }, host), false);
  assert.equal(csrfOk({ "x-self-agent": "1", "sec-fetch-site": "same-origin" }, host), false);
  assert.equal(sameOrigin({ origin: "https://Example.ts.net:9444" }, "example.ts.net:9444"), true);
});

test("isLoopback: 127.0.0.1・::1・::ffff:127.0.0.1 だけ", () => {
  for (const address of ["127.0.0.1", "::1", "::ffff:127.0.0.1"]) assert.equal(isLoopback(address), true, address);
  for (const address of ["100.64.0.1", "127.0.0.2", "::ffff:100.64.0.1", "", undefined]) {
    assert.equal(isLoopback(address), false, String(address));
  }
});

test("staticFileFor: / は index.html、/static/<name> は 1 要素の html・css・js・svg だけ。base.css・icons.svg は templates から", () => {
  const dirs = { staticDir: "/s", templateSiteDir: "/t" };
  assert.deepEqual(staticFileFor("/", dirs), { file: "/s/index.html", contentType: "text/html; charset=utf-8" });
  assert.deepEqual(staticFileFor("/static/app.js", dirs), { file: "/s/app.js", contentType: "text/javascript; charset=utf-8" });
  assert.deepEqual(staticFileFor("/static/base.css", dirs), { file: "/t/base.css", contentType: "text/css; charset=utf-8" });
  assert.deepEqual(staticFileFor("/static/icons.svg", dirs), { file: "/t/icons.svg", contentType: "image/svg+xml; charset=utf-8" });
  for (const path of ["/static/..", "/static/.x", "/static/a", "/static/../x", "/static/a/b.js", "/static/a.png", "/static/%2e%2e", "/static/", "/static/.env.js", "/other"]) {
    assert.equal(staticFileFor(path, dirs), undefined, path);
  }
});
