// HTTP の受け口で共通の小さな部品（接続元が loopback か・本文を上限まで読む・JSON のオブジェクトか）。
// Web UI のサーバー（server.ts）と Claude Code の hook の受け口（cc/hook-server.ts）が使う
import type { IncomingMessage } from "node:http";

/** loopback の接続元（IPv4・IPv6・IPv4 射影） */
const LOOPBACK_ADDRESSES: ReadonlySet<string> = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);

/** 接続元が loopback か（tailscale serve は 127.0.0.1 から来る） */
export function isLoopback(address: string | undefined): boolean {
  return address !== undefined && LOOPBACK_ADDRESSES.has(address);
}

export type BodyResult = { kind: "ok"; body: Buffer } | { kind: "too_large" };

/** 本文を limit バイトまで読む。超えたら（Content-Length で分かれば読まずに）too_large にし、残りは読み捨てる */
export function readBody(req: IncomingMessage, limit: number): Promise<BodyResult> {
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
export function parseJsonObject(body: Buffer): Record<string, unknown> | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body.toString("utf8"));
  } catch {
    return undefined;
  }
  return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : undefined;
}
