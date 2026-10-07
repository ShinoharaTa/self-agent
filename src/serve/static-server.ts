// 作ったプロジェクトの site/ を配る静的サーバー（node:http）。127.0.0.1 で待ち受け、tailnet には tailscale serve で出す
// log はリクエストごとには出さない（パス・slug・題名も出さない）。出すのは待ち受けた後のサーバーのエラーだけ
import { open, realpath, stat, type FileHandle } from "node:fs/promises";
import { createServer, type IncomingMessage, type OutgoingHttpHeaders, type ServerResponse } from "node:http";
import { extname, join, sep } from "node:path";
import { pipeline } from "node:stream/promises";
import type { ProjectStore } from "../store/projects.ts";

export type StaticServerOptions = {
  host: string;
  /** 0 なら空いているポート（テスト用） */
  port: number;
  /** `<workDir>/projects`。`/p/<slug>/<path>` は `<projectsDir>/<slug>/site/<path>` を返す */
  projectsDir: string;
  projects: Pick<ProjectStore, "getBySlug" | "list">;
  /** 設定すると、Tailscale-User-Login ヘッダがこれと完全一致しない要求を 403 にする */
  allowedLogin?: string;
  /** 一覧（`/`）の更新日時を表示するタイムゾーン */
  timeZone: string;
  log: (message: string) => void;
};

export type StaticServer = {
  /** 待ち受けを始める。ポートの衝突などで失敗したら reject する（listening() は false のまま） */
  start: () => Promise<void>;
  /** 待ち受けをやめ、開いている接続も切る。待ち受けていなければ何もしない。reject しない */
  close: () => Promise<void>;
  /** 待ち受けているポート。待ち受けていなければ undefined */
  address: () => { port: number } | undefined;
  /** 待ち受けているか */
  listening: () => boolean;
};

/** すべての応答に付けるヘッダ。CSP は付けない（ページからの外部通信を止めない決定） */
const COMMON_HEADERS: OutgoingHttpHeaders = {
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  "Cache-Control": "no-cache",
};

/** 拡張子（小文字・`.` なし）→ Content-Type。ここに無いものは application/octet-stream */
const CONTENT_TYPES: Readonly<Record<string, string>> = {
  html: "text/html; charset=utf-8",
  css: "text/css; charset=utf-8",
  js: "text/javascript; charset=utf-8",
  mjs: "text/javascript; charset=utf-8",
  json: "application/json",
  svg: "image/svg+xml",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  ico: "image/x-icon",
  txt: "text/plain; charset=utf-8",
  map: "application/json",
  wasm: "application/wasm",
  woff: "font/woff",
  woff2: "font/woff2",
};

const PROJECT_PREFIX = "/p/";

/** 本文だけの応答（リダイレクト・エラー）の本文 */
const STATUS_TEXT: Readonly<Record<number, string>> = {
  301: "Moved Permanently",
  403: "Forbidden",
  404: "Not Found",
  405: "Method Not Allowed",
  500: "Internal Server Error",
};

function contentTypeOf(path: string): string {
  return CONTENT_TYPES[extname(path).slice(1).toLowerCase()] ?? "application/octet-stream";
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function escapeHtml(text: string): string {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

/** デコードできなければ undefined */
function decode(raw: string): string | undefined {
  try {
    return decodeURIComponent(raw);
  } catch {
    return undefined;
  }
}

/** 例: `2026-10-07 09:12`（timeZone での日時） */
function formatDateTime(iso: string, timeZone: string): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).formatToParts(new Date(iso));
  const part = (type: Intl.DateTimeFormatPartTypes): string => parts.find((p) => p.type === type)?.value ?? "";
  return `${part("year")}-${part("month")}-${part("day")} ${part("hour")}:${part("minute")}`;
}

/** プロジェクトの一覧のページ（削除されていないものだけ。新しく更新した順） */
function indexPage(projects: Pick<ProjectStore, "list">, timeZone: string): string {
  const items = projects
    .list()
    .map(
      (project) =>
        `<li><a href="/p/${escapeHtml(project.slug)}/">${escapeHtml(project.title)}</a>` +
        `<span>更新 ${escapeHtml(formatDateTime(project.updatedAt, timeZone))}</span></li>`,
    );
  const body = items.length === 0 ? "<p>まだありません</p>" : `<ul>\n${items.join("\n")}\n</ul>`;
  return `<!doctype html>
<html lang="ja">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>プロジェクト</title>
<style>
:root { color-scheme: light dark; }
body { font-family: system-ui, sans-serif; margin: 16px; line-height: 1.6; }
ul { list-style: none; padding: 0; }
li { padding: 12px 0; border-bottom: 1px solid #8884; }
a { font-size: 1.1em; overflow-wrap: anywhere; }
span { display: block; font-size: 0.85em; opacity: 0.7; }
</style>
</head>
<body>
<h1>プロジェクト</h1>
${body}
</body>
</html>
`;
}

/** 本文の決まった応答。HEAD には本文を付けない */
function sendBody(
  req: IncomingMessage,
  res: ServerResponse,
  status: number,
  contentType: string,
  body: string,
  headers: OutgoingHttpHeaders = {},
): void {
  const buffer = Buffer.from(body, "utf8");
  res.writeHead(status, {
    ...COMMON_HEADERS,
    "Content-Type": contentType,
    "Content-Length": buffer.length,
    ...headers,
  });
  res.end(req.method === "HEAD" ? undefined : buffer);
}

function sendStatus(req: IncomingMessage, res: ServerResponse, status: number, headers: OutgoingHttpHeaders = {}): void {
  sendBody(req, res, status, "text/plain; charset=utf-8", `${STATUS_TEXT[status] ?? status}\n`, headers);
}

/**
 * site の中の segments が指すファイルの実パス。ディレクトリなら その中の index.html。
 * 無い・通常のファイルでない・realpath が `<realpath(projectsDir)>/<slug>/site` の外（symlink・slug や site 自体の symlink を含む）なら undefined
 */
async function resolveFile(projectsDir: string, slug: string, segments: string[]): Promise<string | undefined> {
  try {
    const site = join(await realpath(projectsDir), slug, "site");
    const inside = (path: string): boolean => path.startsWith(site + sep) || path === site;
    let real = await realpath(join(site, ...segments));
    if (!inside(real)) return undefined;
    if ((await stat(real)).isDirectory()) {
      real = await realpath(join(real, "index.html"));
      if (!inside(real)) return undefined;
    }
    return (await stat(real)).isFile() ? real : undefined;
  } catch {
    return undefined;
  }
}

/** ファイルをストリームで返す。開けなければ 404。HEAD には本文を付けない */
async function sendFile(req: IncomingMessage, res: ServerResponse, path: string): Promise<void> {
  let handle: FileHandle;
  try {
    handle = await open(path, "r");
  } catch {
    sendStatus(req, res, 404);
    return;
  }
  let size: number;
  try {
    const info = await handle.stat();
    if (!info.isFile()) throw new Error("not a file");
    size = info.size;
  } catch {
    await handle.close();
    sendStatus(req, res, 404);
    return;
  }
  res.writeHead(200, { ...COMMON_HEADERS, "Content-Type": contentTypeOf(path), "Content-Length": size });
  if (req.method === "HEAD" || size === 0) {
    await handle.close();
    res.end();
    return;
  }
  try {
    // 開いた時点の大きさまで（途中で伸びても Content-Length を超えない）
    await pipeline(handle.createReadStream({ start: 0, end: size - 1 }), res);
  } catch {
    // 相手が途中で切った・読めなかった。pipeline が両方を閉じる
  }
}

export function createStaticServer(options: StaticServerOptions): StaticServer {
  const { host, port, projectsDir, projects, allowedLogin, timeZone, log } = options;

  const respond = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    if (allowedLogin !== undefined && req.headers["tailscale-user-login"] !== allowedLogin) {
      sendStatus(req, res, 403);
      return;
    }
    if (req.method !== "GET" && req.method !== "HEAD") {
      sendStatus(req, res, 405, { Allow: "GET, HEAD" });
      return;
    }
    // URL クラスは `..` や `%2e%2e` を先に畳んでしまうので、生のまま分ける
    const url = req.url ?? "";
    const queryStart = url.indexOf("?");
    const rawPath = queryStart === -1 ? url : url.slice(0, queryStart);
    const query = queryStart === -1 ? "" : url.slice(queryStart);
    if (rawPath === "/") {
      sendBody(req, res, 200, "text/html; charset=utf-8", indexPage(projects, timeZone));
      return;
    }
    if (!rawPath.startsWith(PROJECT_PREFIX)) {
      sendStatus(req, res, 404);
      return;
    }
    const afterPrefix = rawPath.slice(PROJECT_PREFIX.length);
    const slash = afterPrefix.indexOf("/");
    const slug = decode(slash === -1 ? afterPrefix : afterPrefix.slice(0, slash));
    const project = slug === undefined || slug === "" ? undefined : projects.getBySlug(slug);
    if (project === undefined) {
      sendStatus(req, res, 404);
      return;
    }
    if (slash === -1) {
      sendStatus(req, res, 301, { Location: `${PROJECT_PREFIX}${project.slug}/${query}` });
      return;
    }
    const path = decode(afterPrefix.slice(slash + 1));
    if (path === undefined || path.includes("\0") || path.includes("..")) {
      sendStatus(req, res, 404);
      return;
    }
    const segments = path.split("/");
    if (segments.some((segment) => segment.startsWith("."))) {
      sendStatus(req, res, 404);
      return;
    }
    const file = await resolveFile(projectsDir, project.slug, segments);
    if (file === undefined) {
      sendStatus(req, res, 404);
      return;
    }
    await sendFile(req, res, file);
  };

  const server = createServer((req, res) => {
    respond(req, res).catch(() => {
      // 想定外の失敗。パスを含みうるので log には出さない
      if (!res.headersSent) sendStatus(req, res, 500);
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
            log(`ページの配信でエラーが起きました: ${describeError(error)}`);
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
        // 配信中・keep-alive の接続も切る（待つと停止が終わらないことがある）
        server.closeAllConnections();
      }),
    address: () => {
      const address = server.address();
      return address !== null && typeof address === "object" ? { port: address.port } : undefined;
    },
    listening: () => server.listening,
  };
}
