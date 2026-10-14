// オーナーの発言の画像の受け取り（docs/plan/routines.md §5.3）。Gateway が渡す添付の情報から画像を取り、モデルに渡す形（base64）にし、
// 原本を `<dataDir>/attachments/<guildId>/<channelId>/<messageId>-<n>.<ext>`（ディレクトリ 700・ファイル 600）に置いて attachments に記録する。
// 記録に結びついていない古いものは scheduler の tick で消す（pruneAttachments）。log には枚数だけを出し、URL・パス・中身は出さない
import { createHash } from "node:crypto";
import { lstatSync, mkdirSync, realpathSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { RunImage } from "../agent/runner.ts";
import { MAX_IMAGE_BYTES } from "../discord/convert.ts";
import type { ImageMediaType, IncomingImage } from "../discord/gateway.ts";
import type { AttachmentStore } from "../store/attachments.ts";

/** 1 回の取得の打ち切りまでの時間 */
export const ATTACHMENT_FETCH_TIMEOUT_MS = 15_000;
/** モデルに渡す画像の長辺の上限（これより大きい画像は Discord の media proxy で縮めたものを取る。縮めたものを取れなければ渡さない） */
export const MAX_IMAGE_LONG_SIDE = 1568;
/**
 * モデルに渡す画像の大きさの上限（バイト）。画像は SDK の会話の記録に残り、resume のたびに送り直されるので、
 * API の上限（base64 で 5 MB）よりずっと小さくする
 */
export const MAX_PASSED_IMAGE_BYTES = 1024 * 1024;
/** 記録に結びついていない添付を残す日数 */
export const ATTACHMENT_RETENTION_DAYS = 30;
/** 取得してよい場所（Discord の添付の CDN と media proxy。https だけ） */
export const ATTACHMENT_HOSTS: readonly string[] = ["cdn.discordapp.com", "media.discordapp.net"];

/** 縮めても大きすぎて渡さなかった画像があったときの返信 */
export const IMAGE_TOO_LARGE_REPLY = "画像が大きすぎて読めませんでした";
/** 取得できなかった（通信の失敗・時間切れ・中身が画像でない・縮めたものを取れない）画像があったときの返信 */
export const IMAGE_FETCH_FAILED_REPLY = "画像を取得できませんでした";

/** fetch の形。テストでは偽物に差し替える。転送はたどらない（redirect: "error"） */
export type FetchFn = (url: string, init: { signal: AbortSignal; redirect: "error" }) => Promise<Response>;

/** `<dataDir>/attachments`。attachments.path はここからの相対パス */
export function attachmentsDir(dataDir: string): string {
  return join(dataDir, "attachments");
}

const EXTENSIONS: Record<ImageMediaType, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "image/gif": "gif",
};

function startsWith(bytes: Uint8Array, prefix: readonly number[], offset = 0): boolean {
  return bytes.length >= offset + prefix.length && prefix.every((byte, index) => bytes[offset + index] === byte);
}

const ascii = (text: string): number[] => [...text].map((char) => char.charCodeAt(0));

/** 中身の先頭から画像の形式を見る（Discord の content type と中身が違うと API が受け付けないため）。渡せない形式なら undefined */
export function sniffImageType(bytes: Uint8Array): ImageMediaType | undefined {
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) return "image/jpeg";
  if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return "image/png";
  if (startsWith(bytes, ascii("GIF87a")) || startsWith(bytes, ascii("GIF89a"))) return "image/gif";
  if (startsWith(bytes, ascii("RIFF")) && startsWith(bytes, ascii("WEBP"), 8)) return "image/webp";
  return undefined;
}

export type ImageSize = { width: number; height: number };

/** JPEG の SOF（フレームの始まり）のマーカー。幅・高さはここから読む */
const JPEG_SOF_MARKERS = new Set([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf]);

function jpegSize(bytes: Uint8Array, view: DataView): ImageSize | undefined {
  let offset = 2;
  while (offset + 4 <= bytes.length) {
    if (bytes[offset] !== 0xff) return undefined;
    const marker = bytes[offset + 1]!;
    // 詰め物の 0xFF
    if (marker === 0xff) {
      offset++;
      continue;
    }
    // 長さを持たないマーカー
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd8)) {
      offset += 2;
      continue;
    }
    // 画像の終わり・スキャンの始まりまでに SOF が無い
    if (marker === 0xd9 || marker === 0xda) return undefined;
    const length = view.getUint16(offset + 2);
    if (length < 2) return undefined;
    if (JPEG_SOF_MARKERS.has(marker)) {
      if (offset + 9 > bytes.length) return undefined;
      return { height: view.getUint16(offset + 5), width: view.getUint16(offset + 7) };
    }
    offset += 2 + length;
  }
  return undefined;
}

function webpSize(bytes: Uint8Array, view: DataView): ImageSize | undefined {
  if (startsWith(bytes, ascii("VP8X"), 12) && bytes.length >= 30) {
    const uint24 = (at: number): number => bytes[at]! | (bytes[at + 1]! << 8) | (bytes[at + 2]! << 16);
    return { width: uint24(24) + 1, height: uint24(27) + 1 };
  }
  if (startsWith(bytes, ascii("VP8L"), 12) && bytes.length >= 25 && bytes[20] === 0x2f) {
    const [b0, b1, b2, b3] = [bytes[21]!, bytes[22]!, bytes[23]!, bytes[24]!];
    return { width: 1 + (((b1 & 0x3f) << 8) | b0), height: 1 + (((b3 & 0x0f) << 10) | (b2 << 2) | ((b1 & 0xc0) >> 6)) };
  }
  if (startsWith(bytes, ascii("VP8 "), 12) && bytes.length >= 30 && startsWith(bytes, [0x9d, 0x01, 0x2a], 23)) {
    return { width: view.getUint16(26, true) & 0x3fff, height: view.getUint16(28, true) & 0x3fff };
  }
  return undefined;
}

/**
 * 中身のヘッダから読んだ幅・高さ（Discord の width・height は信じない）。読めない・0 なら undefined。
 * JPEG は SOF の値（EXIF の向きは見ないが、長辺は変わらない）
 */
export function imageSize(bytes: Uint8Array, type: ImageMediaType): ImageSize | undefined {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let size: ImageSize | undefined;
  if (type === "image/png") {
    size =
      bytes.length >= 24 && startsWith(bytes, ascii("IHDR"), 12)
        ? { width: view.getUint32(16), height: view.getUint32(20) }
        : undefined;
  } else if (type === "image/gif") {
    size = bytes.length >= 10 ? { width: view.getUint16(6, true), height: view.getUint16(8, true) } : undefined;
  } else if (type === "image/webp") {
    size = webpSize(bytes, view);
  } else {
    size = jpegSize(bytes, view);
  }
  return size === undefined || size.width <= 0 || size.height <= 0 ? undefined : size;
}

/**
 * 長辺を MAX_IMAGE_LONG_SIDE 以下にした画像の media proxy の URL（`width`・`height` を足す。webp なら `format=webp` も）。
 * size は原本の中身から読んだもの。URL が読めなければ undefined
 */
export function resizedProxyUrl(proxyUrl: string, size: ImageSize, webp: boolean): string | undefined {
  const scale = Math.min(1, MAX_IMAGE_LONG_SIDE / Math.max(size.width, size.height));
  try {
    const url = new URL(proxyUrl);
    url.searchParams.set("width", String(Math.max(1, Math.floor(size.width * scale))));
    url.searchParams.set("height", String(Math.max(1, Math.floor(size.height * scale))));
    if (webp) url.searchParams.set("format", "webp");
    return url.href;
  } catch {
    return undefined;
  }
}

/** 取得してよい URL か（https で、ATTACHMENT_HOSTS のどれか。ポート・認証情報の付いたものは許さない） */
export function isAllowedAttachmentUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return (
      url.protocol === "https:" &&
      url.port === "" &&
      url.username === "" &&
      url.password === "" &&
      ATTACHMENT_HOSTS.includes(url.hostname)
    );
  } catch {
    return false;
  }
}

/** 取得の結果。tooLarge は maxBytes を超えた（Content-Length か読んだ量で判定）、failed はそれ以外の失敗 */
type Fetched = { kind: "ok"; bytes: Uint8Array } | { kind: "tooLarge" } | { kind: "failed" };

/**
 * url の中身を maxBytes まで取る（全体で ATTACHMENT_FETCH_TIMEOUT_MS まで）。許した場所以外・転送・2xx 以外は失敗。
 * Content-Length が maxBytes を超えていれば読まずに、読んでいる途中で超えたらそこで止めて tooLarge
 */
async function fetchBytes(fetchFn: FetchFn, url: string, maxBytes: number): Promise<Fetched> {
  if (!isAllowedAttachmentUrl(url)) return { kind: "failed" };
  const controller = new AbortController();
  const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(ATTACHMENT_FETCH_TIMEOUT_MS)]);
  try {
    const response = await fetchFn(url, { signal, redirect: "error" });
    if (!response.ok) {
      controller.abort();
      return { kind: "failed" };
    }
    const length = response.headers.get("content-length");
    if (length !== null && Number(length) > maxBytes) {
      controller.abort();
      return { kind: "tooLarge" };
    }
    if (response.body === null) return { kind: "failed" };
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        controller.abort();
        await reader.cancel().catch(() => {});
        return { kind: "tooLarge" };
      }
      chunks.push(value);
    }
    const bytes = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return { kind: "ok", bytes };
  } catch {
    controller.abort();
    return { kind: "failed" };
  }
}

/** 画像の付いていた発言（保存先と記録に使う。どれも Discord の ID） */
export type AttachmentSource = { guildId: string; channelId: string; messageId: string };

/** 取った画像のうち、渡すものと保存した原本の id、渡さなかった数 */
export type PreparedImages = {
  /** モデルに渡す画像（発言の添付の順） */
  images: RunImage[];
  /** 渡す画像の原本のうち保存できたものの id */
  attachmentIds: number[];
  /** 縮めても MAX_PASSED_IMAGE_BYTES を超えた（原本が 10 MB を超えたものを含む）ので渡さなかった数 */
  tooLarge: number;
  /** 取得できなかった（中身が画像でない・幅と高さを読めない・長辺が大きいのに縮めたものを取れないものを含む）数 */
  failed: number;
};

export type AttachmentDeps = {
  dataDir: string;
  attachments: Pick<AttachmentStore, "add">;
  /** 省略すれば globalThis.fetch */
  fetch?: FetchFn;
  log: (message: string) => void;
};

const SNOWFLAKE = /^\d+$/;

/**
 * 原本を `<attachmentsDir>/<guildId>/<channelId>/<messageId>-<n>.<ext>` に置き（ディレクトリ 700・ファイル 600。既にあれば上書きしない）、
 * attachments に記録して id を返す。path は attachmentsDir からの相対パス。記録に失敗したら置いたファイルを消して投げる
 */
function saveOriginal(
  deps: Pick<AttachmentDeps, "dataDir" | "attachments">,
  source: AttachmentSource,
  index: number,
  size: ImageSize,
  bytes: Uint8Array,
  contentType: ImageMediaType,
): number {
  const { guildId, channelId, messageId } = source;
  // ID は Discord の数字だけ（パスの要素にするので確かめる）
  if (![guildId, channelId, messageId].every((id) => SNOWFLAKE.test(id))) throw new Error("添付の保存先の ID が不正です");
  const root = attachmentsDir(deps.dataDir);
  const relativePath = join(guildId, channelId, `${messageId}-${index + 1}.${EXTENSIONS[contentType]}`);
  const file = join(root, relativePath);
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  // wx: 既にあるもの（symlink を含む）は上書きもたどりもしない
  writeFileSync(file, bytes, { mode: 0o600, flag: "wx" });
  try {
    return deps.attachments.add({
      guildId,
      channelId,
      messageId,
      path: relativePath,
      contentType,
      size: bytes.length,
      width: size.width,
      height: size.height,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    }).id;
  } catch (error) {
    unlinkSync(file);
    throw error;
  }
}

type PreparedImage =
  | { kind: "passed"; image: RunImage; attachmentId: number | undefined }
  | { kind: "tooLarge" }
  | { kind: "failed" };

/** 渡せる画像（中身が画像で、幅・高さを読め、長辺が上限以下で、大きさが上限以下） */
type Passable = { kind: "ok"; bytes: Uint8Array; type: ImageMediaType } | { kind: "tooLarge" } | { kind: "failed" };

function passable(bytes: Uint8Array): Passable {
  const type = sniffImageType(bytes);
  const size = type === undefined ? undefined : imageSize(bytes, type);
  if (type === undefined || size === undefined || Math.max(size.width, size.height) > MAX_IMAGE_LONG_SIDE) {
    return { kind: "failed" };
  }
  return bytes.length > MAX_PASSED_IMAGE_BYTES ? { kind: "tooLarge" } : { kind: "ok", bytes, type };
}

async function prepareImage(
  deps: AttachmentDeps,
  fetchFn: FetchFn,
  source: AttachmentSource,
  image: IncomingImage,
  index: number,
): Promise<PreparedImage> {
  const original = await fetchBytes(fetchFn, image.url, MAX_IMAGE_BYTES);
  if (original.kind !== "ok") return original;
  const originalType = sniffImageType(original.bytes);
  const originalSize = originalType === undefined ? undefined : imageSize(original.bytes, originalType);
  if (originalType === undefined || originalSize === undefined) return { kind: "failed" };
  // 長辺も大きさも上限以下なら原本を渡す。それ以外は media proxy で縮めたもの（webp を先に、無ければ同じ形式）。
  // どちらも渡せなければ渡さない（原本は渡さない）
  let passed = passable(original.bytes);
  if (passed.kind !== "ok") {
    let tooLarge = passed.kind === "tooLarge";
    passed = { kind: "failed" };
    for (const webp of [true, false]) {
      const url = resizedProxyUrl(image.proxyUrl, originalSize, webp);
      const resized = url === undefined ? ({ kind: "failed" } as const) : await fetchBytes(fetchFn, url, MAX_PASSED_IMAGE_BYTES);
      const candidate = resized.kind === "ok" ? passable(resized.bytes) : resized;
      if (candidate.kind === "ok") {
        passed = candidate;
        break;
      }
      if (candidate.kind === "tooLarge") tooLarge = true;
    }
    if (passed.kind !== "ok") return { kind: tooLarge ? "tooLarge" : "failed" };
  }
  // 原本は縮めずに残す。保存に失敗しても画像は渡す（記録に結びつけられないだけ）
  let attachmentId: number | undefined;
  try {
    attachmentId = saveOriginal(deps, source, index, originalSize, original.bytes, originalType);
  } catch {
    deps.log("添付の原本を保存できませんでした");
  }
  return {
    kind: "passed",
    image: { mediaType: passed.type, data: Buffer.from(passed.bytes).toString("base64") },
    attachmentId,
  };
}

/**
 * 発言の画像を取り（1 回 ATTACHMENT_FETCH_TIMEOUT_MS まで。画像ごとに並べて行う）、渡す画像と保存した原本の id を返す。
 * 幅・高さは中身のヘッダから読み、長辺が MAX_IMAGE_LONG_SIDE を超えるか MAX_PASSED_IMAGE_BYTES を超えるものは media proxy で縮めたもの
 * （format=webp を先に、無ければ同じ形式）を渡す。縮めたものも渡せなければ渡さない（大きすぎれば tooLarge、それ以外は failed）。
 * 保存するのは渡す画像の原本だけ。reject しない
 */
export async function prepareImages(
  deps: AttachmentDeps,
  source: AttachmentSource,
  images: readonly IncomingImage[],
): Promise<PreparedImages> {
  const fetchFn: FetchFn = deps.fetch ?? ((url, init) => fetch(url, init));
  const results = await Promise.all(
    images.map((image, index) =>
      prepareImage(deps, fetchFn, source, image, index).catch((): PreparedImage => ({ kind: "failed" })),
    ),
  );
  const prepared: PreparedImages = { images: [], attachmentIds: [], tooLarge: 0, failed: 0 };
  for (const result of results) {
    if (result.kind === "tooLarge") prepared.tooLarge++;
    else if (result.kind === "failed") prepared.failed++;
    else {
      prepared.images.push(result.image);
      if (result.attachmentId !== undefined) prepared.attachmentIds.push(result.attachmentId);
    }
  }
  return prepared;
}

/** 渡さなかった添付の注記（prompt のヘッダの次に 1 行ずつ付ける）。無ければ空 */
export function attachmentNotes(
  skipped: { unsupported: number; overLimit: number } | undefined,
  prepared: Pick<PreparedImages, "tooLarge" | "failed"> | undefined,
): string[] {
  const notes: string[] = [];
  if (skipped !== undefined && skipped.unsupported > 0) {
    notes.push(`（添付 ${skipped.unsupported} 件は読めない形式のため渡していません）`);
  }
  if (skipped !== undefined && skipped.overLimit > 0) {
    notes.push(`（画像 ${skipped.overLimit} 枚は上限（1 発言 4 枚・1 枚 10 MB）を超えるため渡していません）`);
  }
  if (prepared !== undefined && prepared.tooLarge > 0) notes.push(`（画像 ${prepared.tooLarge} 枚は大きすぎるため渡していません）`);
  if (prepared !== undefined && prepared.failed > 0) notes.push(`（画像 ${prepared.failed} 枚は取得できなかったため渡していません）`);
  return notes;
}

/** 渡せなかった画像についてオーナーに返す文。無ければ undefined */
export function attachmentReply(prepared: Pick<PreparedImages, "tooLarge" | "failed">): string | undefined {
  const lines: string[] = [];
  if (prepared.tooLarge > 0) lines.push(IMAGE_TOO_LARGE_REPLY);
  if (prepared.failed > 0) lines.push(IMAGE_FETCH_FAILED_REPLY);
  return lines.length === 0 ? undefined : lines.join("\n");
}

function hasCode(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}

/** child が root（どちらも実際の場所）の中か */
function isInside(root: string, child: string): boolean {
  const rel = relative(root, child);
  return rel !== "" && !isAbsolute(rel) && rel.split(sep)[0] !== "..";
}

/**
 * 記録の path（attachmentsDir からの相対パス）のファイルを消す。path が絶対・`..` を含む、親の realpath が realRoot の外、
 * 実際のファイルでない（symlink・ディレクトリ）ものは消さない（たどらない）。もう無ければ何もしない
 */
function removeAttachmentFile(realRoot: string, path: string): void {
  if (path === "" || isAbsolute(path) || path.split(/[\\/]/).includes("..")) return;
  let parent: string;
  try {
    parent = realpathSync(dirname(resolve(realRoot, path)));
  } catch (error) {
    if (hasCode(error, "ENOENT")) return;
    throw error;
  }
  if (!isInside(realRoot, parent)) return;
  const file = join(parent, basename(path));
  try {
    if (!lstatSync(file).isFile()) return;
  } catch (error) {
    if (hasCode(error, "ENOENT")) return;
    throw error;
  }
  unlinkSync(file);
}

/**
 * どの記録にも結びついておらず、受け取ってから days 日より前の添付を、ファイル（attachmentsDir の中の実際のファイルだけ）と行ごと消す。
 * attachmentsDir が無ければファイルは消さずに行だけ消す。1 つ失敗しても残りは続け、最後にまとめて投げる（message にパスは入れない）。
 * 消した行の数を返す
 */
export function pruneAttachments(
  dataDir: string,
  attachments: Pick<AttachmentStore, "listUnlinkedOlderThan" | "delete">,
  days = ATTACHMENT_RETENTION_DAYS,
): number {
  let realRoot: string | undefined;
  try {
    realRoot = realpathSync(attachmentsDir(dataDir));
  } catch (error) {
    if (!hasCode(error, "ENOENT")) throw error;
  }
  let deleted = 0;
  let failures = 0;
  for (const attachment of attachments.listUnlinkedOlderThan(days)) {
    try {
      if (realRoot !== undefined) removeAttachmentFile(realRoot, attachment.path);
      if (attachments.delete(attachment.id)) deleted++;
    } catch {
      failures++;
    }
  }
  if (failures > 0) throw new Error(`古い添付 ${failures} 件を消せませんでした`);
  return deleted;
}
