// Web UI のサーバー（node:http。docs/plan/web-ui.md §2・§3.3）。127.0.0.1 で待ち受け、tailnet には tailscale serve（9444）で出す。
// 前処理の順: 接続元が loopback か → 共通のヘッダ → /login と /static/*（認証なし。/login はトークンが無ければ 404）→ 認証（auth.ts）
// → POST の CSRF（csrf.ts）・停止中・本文 → ルータ。
// log はリクエストごとには出さない。出すのは /login の失敗の種類、要求の処理の例外の種類（errno の code か例外の名前。message はパスを含みうるので出さない）、
// 待ち受けた後のサーバーのエラーだけで、ヘッダの値・Cookie・トークン・パス・本文は出さない
import { createServer, type IncomingMessage, type OutgoingHttpHeaders, type ServerResponse } from "node:http";
import { authenticate, issueCookie, LoginWindow, safeEqual, setCookieHeader } from "./auth.ts";
import { csrfOk, hasContentType, sameOrigin } from "./csrf.ts";
import { isStaticAssetPath, sendStatic } from "./static.ts";

/** POST の本文の上限（バイト） */
export const WEB_BODY_LIMIT = 64 * 1024;

/** すべての応答に付けるヘッダ（Cache-Control は API とそれ以外で分ける） */
const COMMON_HEADERS: OutgoingHttpHeaders = {
  "Content-Security-Policy": "default-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
  "X-Frame-Options": "DENY",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  "Cross-Origin-Resource-Policy": "same-origin",
};

/** loopback の接続元（IPv4・IPv6・IPv4 射影） */
const LOOPBACK_ADDRESSES: ReadonlySet<string> = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);

/** トークンが無いときに、認証を通らない画面の要求へ返す本文 */
export const TAILSCALE_ONLY_TEXT = "Tailscale でつないでください";

const API_PREFIX = "/api/";
const LOGIN_PATH = "/login";

export type RouteContext = {
  /** pattern の捕獲（デコードしていない） */
  params: string[];
  query: URLSearchParams;
  /** POST の本文（JSON オブジェクト）。GET は undefined */
  body: Record<string, unknown> | undefined;
};

export type RouteResult = { status: number; json?: unknown; text?: string; headers?: Record<string, string> };

export type Route = {
  method: "GET" | "POST";
  /** パスだけ（クエリを含まない・デコードしていない）に当てる */
  pattern: RegExp;
  handle: (ctx: RouteContext) => Promise<RouteResult>;
};

export type WebServerOptions = {
  host: "127.0.0.1";
  /** 0 なら空いているポート（テスト用） */
  port: number;
  /** Tailscale-User-Login がこれと完全一致すれば通す */
  allowedLogin: string;
  /** SELF_AGENT_WEB_TOKEN。あれば /login と Cookie を使える */
  token?: string;
  /** `src/web/static` */
  staticDir: string;
  /** `templates/web/site`（base.css・icons.svg） */
  templateSiteDir: string;
  routes: readonly Route[];
  /** 停止を始めたか。true の間の POST は 503 */
  stopping: () => boolean;
  now: () => Date;
  log: (message: string) => void;
};

export type WebServer = {
  /** 待ち受けを始める。ポートの衝突などで失敗したら reject する（listening() は false のまま） */
  start: () => Promise<void>;
  /** 待ち受けをやめ、開いている接続も切る。待ち受けていなければ何もしない。reject しない */
  close: () => Promise<void>;
  /** 待ち受けているポート。待ち受けていなければ undefined */
  address: () => { port: number } | undefined;
  /** 待ち受けているか */
  listening: () => boolean;
};

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** 要求の処理の例外の種類（errno の code か例外の名前）。message はパスなどを含みうるので出さない */
function describeErrorKind(error: unknown): string {
  if (!(error instanceof Error)) return typeof error;
  const code = (error as NodeJS.ErrnoException).code;
  return typeof code === "string" && /^[A-Z0-9_]{1,40}$/.test(code) ? code : error.name;
}

/** 接続元が loopback か（tailscale serve は 127.0.0.1 から来る） */
export function isLoopback(address: string | undefined): boolean {
  return address !== undefined && LOOPBACK_ADDRESSES.has(address);
}

function sendJson(res: ServerResponse, status: number, json: unknown, headers: OutgoingHttpHeaders = {}): void {
  const body = Buffer.from(JSON.stringify(json), "utf8");
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Content-Length": body.length, ...headers });
  res.end(body);
}

function sendText(res: ServerResponse, status: number, text: string, headers: OutgoingHttpHeaders = {}): void {
  const body = Buffer.from(`${text}\n`, "utf8");
  res.writeHead(status, { "Content-Type": "text/plain; charset=utf-8", "Content-Length": body.length, ...headers });
  res.end(body);
}

function sendHtml(res: ServerResponse, status: number, html: string, headers: OutgoingHttpHeaders = {}): void {
  const body = Buffer.from(html, "utf8");
  res.writeHead(status, { "Content-Type": "text/html; charset=utf-8", "Content-Length": body.length, ...headers });
  res.end(body);
}

/** API（/api/*）は JSON の { error }、それ以外は本文だけ */
function sendError(res: ServerResponse, api: boolean, status: number, error: string, headers: OutgoingHttpHeaders = {}): void {
  if (api) sendJson(res, status, { error }, headers);
  else sendText(res, status, error, headers);
}

/** /login のフォーム（inline の script・style は書かない。message は固定の文だけ） */
function loginPage(message?: string): string {
  return `<!doctype html>
<html lang="ja">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="color-scheme" content="dark light">
<title>self-agent にログイン</title>
<link rel="stylesheet" href="/static/base.css">
</head>
<body>
<main class="container stack">
<h1>self-agent</h1>
<p>Tailscale でつないでいないときは、トークン（SELF_AGENT_WEB_TOKEN）を貼ってください。</p>
${message === undefined ? "" : `<p role="alert"><strong>${message}</strong></p>\n`}<form class="stack" method="post" action="/login">
<label for="token">トークン</label>
<input class="input" id="token" type="password" name="token" autocomplete="current-password" required>
<button class="btn btn-primary" type="submit">ログイン</button>
</form>
</main>
</body>
</html>
`;
}

type BodyResult = { kind: "ok"; body: Buffer } | { kind: "too_large" };

/** 本文を limit バイトまで読む。超えたら（Content-Length で分かれば読まずに）too_large にし、残りは読み捨てる */
function readBody(req: IncomingMessage, limit: number): Promise<BodyResult> {
  return new Promise((resolve, reject) => {
    const declared = Number(req.headers["content-length"]);
    if (Number.isFinite(declared) && declared > limit) {
      req.resume();
      resolve({ kind: "too_large" });
      return;
    }
    const chunks: Buffer[] = [];
    let size = 0;
    const onData = (chunk: Buffer): void => {
      size += chunk.length;
      if (size > limit) {
        req.off("data", onData);
        req.off("end", onEnd);
        req.off("error", onError);
        req.resume();
        resolve({ kind: "too_large" });
        return;
      }
      chunks.push(chunk);
    };
    const onEnd = (): void => resolve({ kind: "ok", body: Buffer.concat(chunks) });
    const onError = (error: Error): void => reject(error);
    req.on("data", onData);
    req.on("end", onEnd);
    req.on("error", onError);
  });
}

/** 本文が JSON のオブジェクト（配列・null は除く）ならそれ、それ以外は undefined */
function parseJsonObject(body: Buffer): Record<string, unknown> | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body.toString("utf8"));
  } catch {
    return undefined;
  }
  return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : undefined;
}

export function createWebServer(options: WebServerOptions): WebServer {
  const { host, port, allowedLogin, token, staticDir, templateSiteDir, routes, stopping, now, log } = options;
  const loginWindow = new LoginWindow();
  const dirs = { staticDir, templateSiteDir };

  /** POST /login: 同じオリジンとフォームの形を確かめ、窓を数えてからトークンを比べる。一致なら Cookie と / への 302 */
  const handleLogin = async (req: IncomingMessage, res: ServerResponse, loginToken: string): Promise<void> => {
    if (!sameOrigin(req.headers, req.headers.host) || !hasContentType(req.headers, "application/x-www-form-urlencoded")) {
      req.resume();
      sendText(res, 403, "Forbidden", { Connection: "close" });
      return;
    }
    const read = await readBody(req, WEB_BODY_LIMIT);
    if (read.kind === "too_large") {
      sendText(res, 413, "Payload Too Large", { Connection: "close" });
      return;
    }
    if (loginWindow.attempt(now()) === "limited") {
      log("Web UI: ログインの試行が多すぎるため断りました");
      sendHtml(res, 429, loginPage("試行が多すぎます。1 分ほど待ってからやり直してください"), { "Retry-After": "60" });
      return;
    }
    const submitted = new URLSearchParams(read.body.toString("utf8")).get("token") ?? "";
    if (!safeEqual(submitted, loginToken)) {
      log("Web UI: ログインのトークンが違います");
      sendHtml(res, 401, loginPage("トークンが違います"));
      return;
    }
    res.writeHead(302, { Location: "/", "Set-Cookie": setCookieHeader(issueCookie(loginToken, now())), "Content-Length": 0 });
    res.end();
  };

  const respond = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    // URL クラスは `..` や `%2e%2e` を先に畳んでしまうので、生のまま分ける
    const url = req.url ?? "";
    const queryStart = url.indexOf("?");
    const path = queryStart === -1 ? url : url.slice(0, queryStart);
    const query = new URLSearchParams(queryStart === -1 ? "" : url.slice(queryStart + 1));
    const api = path.startsWith(API_PREFIX);
    for (const [name, value] of Object.entries(COMMON_HEADERS)) res.setHeader(name, value as string);
    res.setHeader("Cache-Control", api ? "no-store" : "no-cache");

    if (!isLoopback(req.socket.remoteAddress)) {
      req.resume();
      sendError(res, api, 403, api ? "forbidden" : "Forbidden");
      return;
    }

    if (path === LOGIN_PATH) {
      if (token === undefined) {
        req.resume();
        sendText(res, 404, "Not Found");
        return;
      }
      if (req.method === "GET") {
        sendHtml(res, 200, loginPage());
        return;
      }
      if (req.method === "POST") {
        await handleLogin(req, res, token);
        return;
      }
      req.resume();
      sendText(res, 405, "Method Not Allowed", { Allow: "GET, POST" });
      return;
    }

    // 画面の部品（CSS・JS・SVG）は秘密を含まないので認証なしで配る（未認証の /login も base.css を読む）
    if (isStaticAssetPath(path)) {
      req.resume();
      if (req.method === "GET") await sendStatic(req, res, path, dirs);
      else sendText(res, 405, "Method Not Allowed", { Allow: "GET" });
      return;
    }

    const auth = authenticate({ headers: req.headers, cookieHeader: req.headers.cookie, allowedLogin, token, now: now() });
    if (auth === "none") {
      req.resume();
      if (api) sendJson(res, 401, { error: "unauthorized" });
      else if (token !== undefined) {
        res.writeHead(302, { Location: LOGIN_PATH, "Content-Length": 0 });
        res.end();
      } else sendText(res, 401, TAILSCALE_ONLY_TEXT);
      return;
    }

    let body: Record<string, unknown> | undefined;
    if (req.method === "POST") {
      if (!csrfOk(req.headers, req.headers.host)) {
        req.resume();
        sendError(res, api, 403, "csrf", { Connection: "close" });
        return;
      }
      if (stopping()) {
        req.resume();
        sendError(res, api, 503, "stopping", { Connection: "close" });
        return;
      }
      const read = await readBody(req, WEB_BODY_LIMIT);
      if (read.kind === "too_large") {
        sendError(res, api, 413, "too_large", { Connection: "close" });
        return;
      }
      body = parseJsonObject(read.body);
      if (body === undefined) {
        sendError(res, api, 400, "bad_request");
        return;
      }
    } else {
      req.resume();
    }

    if (path === "/") {
      if (req.method === "GET") await sendStatic(req, res, path, dirs);
      else sendText(res, 405, "Method Not Allowed", { Allow: "GET" });
      return;
    }

    const matches = routes
      .map((route) => ({ route, match: route.pattern.exec(path) }))
      .filter((entry): entry is { route: Route; match: RegExpExecArray } => entry.match !== null);
    if (matches.length === 0) {
      sendError(res, api, 404, api ? "not_found" : "Not Found");
      return;
    }
    const hit = matches.find((entry) => entry.route.method === req.method);
    if (hit === undefined) {
      const allow = [...new Set(matches.map((entry) => entry.route.method))].join(", ");
      sendError(res, api, 405, api ? "method_not_allowed" : "Method Not Allowed", { Allow: allow });
      return;
    }
    let result: RouteResult;
    try {
      result = await hit.route.handle({ params: hit.match.slice(1), query, body });
    } catch (error) {
      log(`Web UI: 要求の処理に失敗しました（${describeErrorKind(error)}）`);
      sendJson(res, 500, { error: "internal" });
      return;
    }
    if (result.json !== undefined) sendJson(res, result.status, result.json, result.headers);
    else if (result.text !== undefined) sendText(res, result.status, result.text, result.headers);
    else {
      res.writeHead(result.status, { "Content-Length": 0, ...result.headers });
      res.end();
    }
  };

  const server = createServer((req, res) => {
    respond(req, res).catch((error: unknown) => {
      // 想定外の失敗（ファイルの読み取りなど）。message はパスを含みうるので種類だけ
      log(`Web UI: 要求の処理に失敗しました（${describeErrorKind(error)}）`);
      if (!res.headersSent) sendText(res, 500, "Internal Server Error");
      else res.destroy();
    });
  });

  return {
    start: () =>
      new Promise<void>((resolve, reject) => {
        const onError = (error: Error): void => {
          server.off("listening", onListening);
          reject(error);
        };
        const onListening = (): void => {
          server.off("error", onError);
          server.on("error", (error) => {
            log(`Web UI でエラーが起きました: ${describeError(error)}`);
          });
          resolve();
        };
        server.once("error", onError);
        server.once("listening", onListening);
        server.listen(port, host);
      }),
    close: () =>
      new Promise<void>((resolve) => {
        if (!server.listening) {
          resolve();
          return;
        }
        server.close(() => resolve());
        server.closeAllConnections();
      }),
    address: () => {
      const address = server.address();
      return address !== null && typeof address === "object" ? { port: address.port } : undefined;
    },
    listening: () => server.listening,
  };
}
