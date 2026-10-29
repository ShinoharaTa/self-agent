import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { request, type IncomingHttpHeaders } from "node:http";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createWebServer, TAILSCALE_ONLY_TEXT, type Route, type WebServer } from "../src/web/server.ts";
import { tempDir } from "./helpers/db.ts";

const HOST = "127.0.0.1";
const LOGIN = "owner@example.com";
const TOKEN = "web-token-for-tests-0123456789abcdef";
const TEMPLATE_SITE_DIR = fileURLToPath(new URL("../templates/web/site/", import.meta.url));
const INDEX_HTML = "<!doctype html><h1>self-agent</h1>";

type Response = { status: number; headers: IncomingHttpHeaders; body: string };

/** path はそのまま送る（`..` を畳まない）。body があれば送る */
function send(
  server: WebServer,
  path: string,
  options: { method?: string; headers?: Record<string, string>; body?: string | Buffer } = {},
): Promise<Response> {
  return new Promise((resolve, reject) => {
    const req = request(
      { host: HOST, port: server.address()!.port, path, method: options.method ?? "GET", headers: options.headers },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () =>
          resolve({ status: res.statusCode!, headers: res.headers, body: Buffer.concat(chunks).toString("utf8") }),
        );
        res.on("error", reject);
      },
    );
    req.on("error", reject);
    req.end(options.body);
  });
}

type SetupOptions = { token?: string | null; stopping?: () => boolean };

async function setup(t: TestContext, options: SetupOptions = {}) {
  const staticDir = tempDir(t);
  writeFileSync(join(staticDir, "index.html"), INDEX_HTML);
  writeFileSync(join(staticDir, "app.js"), "console.log(1);");
  const clock = { now: new Date("2026-10-29T00:00:00Z") };
  const logs: string[] = [];
  const posted: Array<Record<string, unknown> | undefined> = [];
  const routes: Route[] = [
    { method: "GET", pattern: /^\/api\/echo$/, handle: async ({ query }) => ({ status: 200, json: { q: query.get("q") } }) },
    {
      method: "POST",
      pattern: /^\/api\/echo$/,
      handle: async ({ body }) => {
        posted.push(body);
        return { status: 200, json: { ok: true } };
      },
    },
    { method: "GET", pattern: /^\/api\/items\/(\d+)$/, handle: async ({ params }) => ({ status: 200, json: { params } }) },
    {
      method: "GET",
      pattern: /^\/api\/boom$/,
      handle: async () => {
        throw new Error("/secret/path/to/file を読めませんでした");
      },
    },
  ];
  const token = options.token === null ? undefined : (options.token ?? TOKEN);
  const server = createWebServer({
    host: HOST,
    port: 0,
    allowedLogin: LOGIN,
    ...(token === undefined ? {} : { token }),
    staticDir,
    templateSiteDir: TEMPLATE_SITE_DIR,
    routes,
    stopping: options.stopping ?? (() => false),
    now: () => clock.now,
    log: (message) => logs.push(message),
  });
  await server.start();
  t.after(() => server.close());
  const origin = `http://${HOST}:${server.address()!.port}`;
  return { server, clock, logs, posted, origin };
}

const LOGIN_HEADER = { "tailscale-user-login": LOGIN };
const POST_HEADERS = { ...LOGIN_HEADER, "sec-fetch-site": "same-origin", "x-self-agent": "1", "content-type": "application/json" };

function assertCommonHeaders(response: Response, label: string): void {
  assert.equal(
    response.headers["content-security-policy"],
    "default-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
    label,
  );
  assert.equal(response.headers["x-frame-options"], "DENY", label);
  assert.equal(response.headers["x-content-type-options"], "nosniff", label);
  assert.equal(response.headers["referrer-policy"], "no-referrer", label);
  assert.equal(response.headers["cross-origin-resource-policy"], "same-origin", label);
}

function cookieFor(exp: number, token = TOKEN): string {
  return `self_agent_web=${exp}.${createHmac("sha256", token).update(`v1:${exp}`).digest("hex")}`;
}

test("Web UI: Tailscale-User-Login が一致すれば通し、違う・無ければ API は 401、画面は /login へ 302", async (t) => {
  const { server } = await setup(t);
  const ok = await send(server, "/api/echo?q=a", { headers: LOGIN_HEADER });
  assert.equal(ok.status, 200);
  assert.deepEqual(JSON.parse(ok.body), { q: "a" });
  assert.equal(ok.headers["content-type"], "application/json; charset=utf-8");
  assert.equal(ok.headers["cache-control"], "no-store");

  for (const headers of [{}, { "tailscale-user-login": "other@example.com" }] as Record<string, string>[]) {
    const api = await send(server, "/api/echo", { headers });
    assert.equal(api.status, 401);
    assert.deepEqual(JSON.parse(api.body), { error: "unauthorized" });
    const page = await send(server, "/", { headers });
    assert.equal(page.status, 302);
    assert.equal(page.headers.location, "/login");
  }

  const index = await send(server, "/", { headers: LOGIN_HEADER });
  assert.equal(index.status, 200);
  assert.equal(index.body, INDEX_HTML);
  assert.equal(index.headers["content-type"], "text/html; charset=utf-8");
  assert.equal(index.headers["cache-control"], "no-cache");
});

test("Web UI: トークンが無ければ /login は 404、認証を通らない画面は 401（Tailscale でつないでください）", async (t) => {
  const { server } = await setup(t, { token: null });
  assert.equal((await send(server, "/login")).status, 404);
  assert.equal((await send(server, "/login", { headers: LOGIN_HEADER })).status, 404);
  const page = await send(server, "/");
  assert.equal(page.status, 401);
  assert.equal(page.body.trim(), TAILSCALE_ONLY_TEXT);
  assert.equal((await send(server, "/api/echo")).status, 401);
  // Cookie はトークンが無ければ通さない
  assert.equal((await send(server, "/api/echo", { headers: { cookie: cookieFor(Date.now() / 1000 + 3600) } })).status, 401);
});

test("Web UI: Cookie は exp が未来で hmac が一致すれば通し、期限切れ・hmac 違いは 401", async (t) => {
  const { server, clock } = await setup(t);
  const nowSec = Math.floor(clock.now.getTime() / 1000);
  assert.equal((await send(server, "/api/echo", { headers: { cookie: cookieFor(nowSec + 60) } })).status, 200);
  assert.equal((await send(server, "/api/echo", { headers: { cookie: cookieFor(nowSec - 1) } })).status, 401);
  assert.equal(
    (await send(server, "/api/echo", { headers: { cookie: cookieFor(nowSec + 60, "another-token-0123456789abcdef-xx") } })).status,
    401,
  );
});

test("Web UI: /login はフォームを返し、POST はトークンの長さ違い・値違いで 401、6 回目は 429。一致で Cookie と / への 302", async (t) => {
  const { server, clock, origin, logs } = await setup(t);
  const form = await send(server, "/login");
  assert.equal(form.status, 200);
  assert.match(form.body, /<form [^>]*method="post" action="\/login"/);
  assert.match(form.body, /<link rel="stylesheet" href="\/static\/base.css">/);
  assert.doesNotMatch(form.body, /<script|<style|style=/);
  assertCommonHeaders(form, "GET /login");

  const post = (token: string) =>
    send(server, "/login", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", origin },
      body: new URLSearchParams({ token }).toString(),
    });
  assert.equal((await post("short")).status, 401);
  assert.equal((await post(TOKEN.replace(/.$/, "X"))).status, 401);
  assert.equal((await post("")).status, 401);
  assert.equal((await post(`${TOKEN}x`)).status, 401);
  assert.equal((await post("still-wrong")).status, 401);
  // 6 回目は正しいトークンでも窓が空くまで断る
  assert.equal((await post(TOKEN)).status, 429);

  clock.now = new Date(clock.now.getTime() + 60_000);
  const ok = await post(TOKEN);
  assert.equal(ok.status, 302);
  assert.equal(ok.headers.location, "/");
  const setCookie = ok.headers["set-cookie"]?.[0] ?? "";
  assert.match(setCookie, /^self_agent_web=\d+\.[0-9a-f]{64}; HttpOnly; Secure; SameSite=Strict; Path=\/; Max-Age=2592000$/);
  const cookie = setCookie.split(";")[0]!;
  assert.equal((await send(server, "/api/echo", { headers: { cookie } })).status, 200);

  // 同じオリジンでない・フォームでない POST は 403
  const crossSite = await send(server, "/login", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", "sec-fetch-site": "cross-site", origin },
    body: `token=${TOKEN}`,
  });
  assert.equal(crossSite.status, 403);
  const json = await send(server, "/login", {
    method: "POST",
    headers: { "content-type": "application/json", origin },
    body: JSON.stringify({ token: TOKEN }),
  });
  assert.equal(json.status, 403);

  // log は種類だけ（トークン・Cookie は出さない）
  assert.ok(logs.some((line) => line.includes("ログインのトークンが違います")));
  assert.ok(logs.some((line) => line.includes("ログインの試行が多すぎる")));
  for (const line of logs) {
    assert.ok(!line.includes(TOKEN) && !line.includes(cookie) && !line.includes("short"), line);
  }
});

test("Web UI: POST の CSRF の 3 条件。どれかが欠ければ 403、Sec-Fetch-Site が無くても Origin が一致すれば通る", async (t) => {
  const { server, origin, posted } = await setup(t);
  const post = (headers: Record<string, string>) => send(server, "/api/echo", { method: "POST", headers, body: "{}" });
  const { "sec-fetch-site": _site, ...withoutSite } = POST_HEADERS;
  const { "x-self-agent": _marker, ...withoutMarker } = POST_HEADERS;
  const cases: Array<[string, Record<string, string>]> = [
    ["Sec-Fetch-Site: same-site", { ...POST_HEADERS, "sec-fetch-site": "same-site" }],
    ["Sec-Fetch-Site: cross-site", { ...POST_HEADERS, "sec-fetch-site": "cross-site" }],
    ["Sec-Fetch-Site 無し・Origin 違い", { ...withoutSite, origin: "http://evil.example" }],
    ["Sec-Fetch-Site 無し・Origin 無し", withoutSite],
    ["X-Self-Agent 無し", withoutMarker],
    ["text/plain", { ...POST_HEADERS, "content-type": "text/plain" }],
  ];
  for (const [label, headers] of cases) {
    const response = await post(headers);
    assert.equal(response.status, 403, label);
    assert.deepEqual(JSON.parse(response.body), { error: "csrf" }, label);
  }
  assert.equal(posted.length, 0);

  const viaOrigin = await post({ ...withoutSite, origin });
  assert.equal(viaOrigin.status, 200);
  const charset = await post({ ...POST_HEADERS, "content-type": "application/json; charset=utf-8" });
  assert.equal(charset.status, 200);
  assert.deepEqual(posted, [{}, {}]);
});

test("Web UI: POST の本文は JSON オブジェクトだけ（[]・\"x\"・空は 400）、64 KB を超えれば 413", async (t) => {
  const { server, posted } = await setup(t);
  for (const body of ["[]", '"x"', "", "null", "{"]) {
    const response = await send(server, "/api/echo", { method: "POST", headers: POST_HEADERS, body });
    assert.equal(response.status, 400, JSON.stringify(body));
    assert.deepEqual(JSON.parse(response.body), { error: "bad_request" });
  }
  const large = JSON.stringify({ text: "a".repeat(65 * 1024) });
  const tooLarge = await send(server, "/api/echo", { method: "POST", headers: POST_HEADERS, body: large });
  assert.equal(tooLarge.status, 413);
  // Content-Length を付けずに送っても（chunked）読んだ量で止める
  const chunked = await send(server, "/api/echo", {
    method: "POST",
    headers: { ...POST_HEADERS, "transfer-encoding": "chunked" },
    body: large,
  });
  assert.equal(chunked.status, 413);
  const ok = await send(server, "/api/echo", { method: "POST", headers: POST_HEADERS, body: JSON.stringify({ a: 1 }) });
  assert.equal(ok.status, 200);
  assert.deepEqual(posted, [{ a: 1 }]);
});

test("Web UI: 停止を始めた後の POST は 503（GET は通る）", async (t) => {
  let stopping = false;
  const { server, posted } = await setup(t, { stopping: () => stopping });
  stopping = true;
  const response = await send(server, "/api/echo", { method: "POST", headers: POST_HEADERS, body: "{}" });
  assert.equal(response.status, 503);
  assert.deepEqual(JSON.parse(response.body), { error: "stopping" });
  assert.equal(posted.length, 0);
  assert.equal((await send(server, "/api/echo", { headers: LOGIN_HEADER })).status, 200);
});

test("Web UI: ルータは一致しなければ 404、メソッド違いは 405、捕獲は params。handle が投げたら 500 で log に message・パスを出さない", async (t) => {
  const { server, logs } = await setup(t);
  const notFound = await send(server, "/api/nothing", { headers: LOGIN_HEADER });
  assert.equal(notFound.status, 404);
  assert.equal((await send(server, "/nothing", { headers: LOGIN_HEADER })).status, 404);
  const method = await send(server, "/api/items/3", { method: "POST", headers: POST_HEADERS, body: "{}" });
  assert.equal(method.status, 405);
  assert.equal(method.headers.allow, "GET");
  assert.equal((await send(server, "/api/echo", { method: "DELETE", headers: LOGIN_HEADER })).status, 405);
  assert.deepEqual(JSON.parse((await send(server, "/api/items/42", { headers: LOGIN_HEADER })).body), { params: ["42"] });

  const boom = await send(server, "/api/boom", { headers: LOGIN_HEADER });
  assert.equal(boom.status, 500);
  assert.deepEqual(JSON.parse(boom.body), { error: "internal" });
  assert.equal(logs.length, 1);
  assert.match(logs[0]!, /Web UI: 要求の処理に失敗しました（Error）/);
  assert.ok(!logs[0]!.includes("/secret"));
});

test("Web UI: /static/* は認証なしで配り、名前が合わなければ 404。base.css は templates/web/site と同じ中身で、ETag が一致すれば 304", async (t) => {
  const { server } = await setup(t);
  for (const path of ["/static/../x", "/static/a/b", "/static/..", "/static/.x", "/static/a", "/static/a.png", "/static/missing.js"]) {
    const response = await send(server, path);
    assert.equal(response.status, 404, path);
    assertCommonHeaders(response, path);
  }
  const base = await send(server, "/static/base.css");
  assert.equal(base.status, 200);
  assert.equal(base.body, readFileSync(join(TEMPLATE_SITE_DIR, "base.css"), "utf8"));
  assert.equal(base.headers["content-type"], "text/css; charset=utf-8");
  assert.equal(base.headers["cache-control"], "no-cache");
  assertCommonHeaders(base, "base.css");
  const icons = await send(server, "/static/icons.svg");
  assert.equal(icons.status, 200);
  assert.equal(icons.body, readFileSync(join(TEMPLATE_SITE_DIR, "icons.svg"), "utf8"));
  const app = await send(server, "/static/app.js");
  assert.equal(app.headers["content-type"], "text/javascript; charset=utf-8");
  assert.equal(app.body, "console.log(1);");

  const etag = base.headers.etag;
  assert.match(etag ?? "", /^"[\d.]+-\d+"$/);
  const cached = await send(server, "/static/base.css", { headers: { "if-none-match": etag! } });
  assert.equal(cached.status, 304);
  assert.equal(cached.body, "");
  assert.equal((await send(server, "/static/base.css", { headers: { "if-none-match": '"0-0"' } })).status, 200);
  // 認証の要る / も ETag で 304
  const index = await send(server, "/", { headers: LOGIN_HEADER });
  assert.equal((await send(server, "/", { headers: { ...LOGIN_HEADER, "if-none-match": index.headers.etag! } })).status, 304);
  assert.equal((await send(server, "/static/app.js", { method: "POST", headers: POST_HEADERS, body: "{}" })).status, 405);
});

test("Web UI: 全部の応答に CSP・X-Frame-Options・nosniff・Referrer-Policy・CORP を付け、log にログイン・Cookie・トークンを出さない", async (t) => {
  const { server, logs, clock } = await setup(t);
  const cookie = cookieFor(Math.floor(clock.now.getTime() / 1000) + 60);
  const responses: Array<[string, Response]> = [
    ["200", await send(server, "/api/echo", { headers: LOGIN_HEADER })],
    ["401", await send(server, "/api/echo")],
    ["302", await send(server, "/")],
    ["404", await send(server, "/api/nothing", { headers: { cookie } })],
    ["403", await send(server, "/api/echo", { method: "POST", headers: { ...POST_HEADERS, "sec-fetch-site": "cross-site" }, body: "{}" })],
    ["400", await send(server, "/api/echo", { method: "POST", headers: POST_HEADERS, body: "[]" })],
    ["500", await send(server, "/api/boom", { headers: LOGIN_HEADER })],
    ["login", await send(server, "/login")],
    ["login 401", await send(server, "/login", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", "sec-fetch-site": "same-origin" }, body: "token=x" })],
  ];
  for (const [label, response] of responses) assertCommonHeaders(response, label);
  assert.ok(logs.length > 0);
  for (const line of logs) {
    assert.ok(!line.includes(LOGIN), line);
    assert.ok(!line.includes(cookie) && !line.includes(cookie.split("=")[1]!), line);
    assert.ok(!line.includes(TOKEN), line);
  }
});
