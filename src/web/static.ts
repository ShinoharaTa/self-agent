// Web UI の画面のファイルの配信（docs/plan/web-ui.md §3.3）。`/` は staticDir の index.html、`/static/<name>` は staticDir のファイル
// （base.css・icons.svg だけは templates/web/site/ のものを複製せずに配る）。名前は 1 要素だけで、html・css・js・svg のものだけを返す。
// `/static/*` は認証なしで配る（秘密は無く、未認証の /login も base.css を読む）。`/` は認証が要る（server.ts）
import { readFile, stat } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { extname, join } from "node:path";

/** 拡張子（`.` なし）→ Content-Type（STATIC_NAME の拡張子と同じ） */
const CONTENT_TYPES: Readonly<Record<string, string>> = {
  html: "text/html; charset=utf-8",
  css: "text/css; charset=utf-8",
  js: "text/javascript; charset=utf-8",
  svg: "image/svg+xml; charset=utf-8",
};

/** templates/web/site/ から配るもの */
const TEMPLATE_FILES: ReadonlySet<string> = new Set(["base.css", "icons.svg"]);

const STATIC_PREFIX = "/static/";
/** `..`・ドットファイル・拡張子の無いもの・表に無い拡張子は合わない */
const STATIC_NAME = /^[A-Za-z0-9_-]+\.(html|css|js|svg)$/;

export type StaticDirs = {
  /** `src/web/static` */
  staticDir: string;
  /** `templates/web/site` */
  templateSiteDir: string;
};

/** パス（デコードしていない生のもの）が `/static/…` か（認証なしで配る） */
export function isStaticAssetPath(path: string): boolean {
  return path.startsWith(STATIC_PREFIX);
}

/**
 * パスに対応するファイル。`/` は index.html、`/static/<name>` は name が `[A-Za-z0-9_-]+.(html|css|js|svg)` のものだけ。
 * それ以外は undefined（404）
 */
export function staticFileFor(path: string, dirs: StaticDirs): { file: string; contentType: string } | undefined {
  const name = path === "/" ? "index.html" : isStaticAssetPath(path) ? path.slice(STATIC_PREFIX.length) : undefined;
  if (name === undefined || !STATIC_NAME.test(name)) return undefined;
  const contentType = CONTENT_TYPES[extname(name).slice(1)];
  if (contentType === undefined) return undefined;
  const dir = TEMPLATE_FILES.has(name) ? dirs.templateSiteDir : dirs.staticDir;
  return { file: join(dir, name), contentType };
}

/**
 * 画面のファイルを返す。ETag は `"<mtimeMs>-<size>"` で、If-None-Match が一致すれば 304。無い・通常のファイルでなければ 404。
 * 共通のヘッダ（CSP・Cache-Control など）は呼び出し側が先に setHeader しておく
 */
export async function sendStatic(req: IncomingMessage, res: ServerResponse, path: string, dirs: StaticDirs): Promise<void> {
  const target = staticFileFor(path, dirs);
  const info = target === undefined ? undefined : await stat(target.file).catch(() => undefined);
  if (target === undefined || info === undefined || !info.isFile()) {
    res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("Not Found\n");
    return;
  }
  const etag = `"${info.mtimeMs}-${info.size}"`;
  if (req.headers["if-none-match"] === etag) {
    res.writeHead(304, { ETag: etag });
    res.end();
    return;
  }
  const body = await readFile(target.file);
  res.writeHead(200, { "Content-Type": target.contentType, "Content-Length": body.length, ETag: etag });
  res.end(body);
}
