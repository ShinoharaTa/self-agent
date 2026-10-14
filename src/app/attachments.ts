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
/** モデルに渡す画像の長辺（これより大きい画像は Discord の media proxy で縮めたものを取る） */
export const MAX_IMAGE_LONG_SIDE = 1568;
/** モデルに渡す画像の大きさの上限（バイト。base64 で約 5 MB になる、API の上限の手前） */
export const MAX_PASSED_IMAGE_BYTES = 3.75 * 1024 * 1024;
/** 記録に結びついていない添付を残す日数 */
export const ATTACHMENT_RETENTION_DAYS = 30;

/** 縮めても大きすぎて渡さなかった画像があったときの返信 */
export const IMAGE_TOO_LARGE_REPLY = "画像が大きすぎて読めませんでした";
/** 取得できなかった（通信の失敗・時間切れ・中身が画像でない）画像があったときの返信 */
export const IMAGE_FETCH_FAILED_REPLY = "画像を取得できませんでした";

/** fetch の形。テストでは偽物に差し替える */
export type FetchFn = (url: string, init: { signal: AbortSignal }) => Promise<Response>;

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

/**
 * 長辺を MAX_IMAGE_LONG_SIDE に縮めた画像の media proxy の URL（`width`・`height` を足す）。
 * 幅・高さが分からない・もう長辺以下・URL が読めないなら undefined（原本をそのまま渡す）
 */
export function resizedProxyUrl(image: Pick<IncomingImage, "proxyUrl" | "width" | "height">): string | undefined {
  const { width, height } = image;
  if (width === null || height === null || width <= 0 || height <= 0) return undefined;
  const longSide = Math.max(width, height);
  if (longSide <= MAX_IMAGE_LONG_SIDE) return undefined;
  const scale = MAX_IMAGE_LONG_SIDE / longSide;
  try {
    const url = new URL(image.proxyUrl);
    url.searchParams.set("width", String(Math.max(1, Math.round(width * scale))));
    url.searchParams.set("height", String(Math.max(1, Math.round(height * scale))));
    return url.href;
  } catch {
    return undefined;
  }
}

/** 取得した中身。失敗（通信・時間切れ・2xx 以外・maxBytes を超える）なら undefined */
async function fetchBytes(fetchFn: FetchFn, url: string, maxBytes: number): Promise<Uint8Array | undefined> {
  try {
    const response = await fetchFn(url, { signal: AbortSignal.timeout(ATTACHMENT_FETCH_TIMEOUT_MS) });
    if (!response.ok) return undefined;
    const bytes = new Uint8Array(await response.arrayBuffer());
    return bytes.length > maxBytes ? undefined : bytes;
  } catch {
    return undefined;
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
  /** 縮めても MAX_PASSED_IMAGE_BYTES を超えたので渡さなかった数 */
  tooLarge: number;
  /** 取得できなかった（中身が画像でないものを含む）数 */
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
  image: Pick<IncomingImage, "width" | "height">,
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
      width: image.width,
      height: image.height,
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

async function prepareImage(
  deps: AttachmentDeps,
  fetchFn: FetchFn,
  source: AttachmentSource,
  image: IncomingImage,
  index: number,
): Promise<PreparedImage> {
  const original = await fetchBytes(fetchFn, image.url, MAX_IMAGE_BYTES);
  const originalType = original === undefined ? undefined : sniffImageType(original);
  if (original === undefined || originalType === undefined) return { kind: "failed" };
  // 渡すのは縮めたもの。proxy が縮めた画像を返さなければ（失敗・中身が画像でない）原本
  let passed = original;
  let passedType = originalType;
  const proxyUrl = resizedProxyUrl(image);
  if (proxyUrl !== undefined) {
    const resized = await fetchBytes(fetchFn, proxyUrl, MAX_IMAGE_BYTES);
    const resizedType = resized === undefined ? undefined : sniffImageType(resized);
    if (resized !== undefined && resizedType !== undefined) {
      passed = resized;
      passedType = resizedType;
    }
  }
  if (passed.length > MAX_PASSED_IMAGE_BYTES) return { kind: "tooLarge" };
  // 原本は縮めずに残す。保存に失敗しても画像は渡す（記録に結びつけられないだけ）
  let attachmentId: number | undefined;
  try {
    attachmentId = saveOriginal(deps, source, index, image, original, originalType);
  } catch {
    deps.log("添付の原本を保存できませんでした");
  }
  return {
    kind: "passed",
    image: { mediaType: passedType, data: Buffer.from(passed).toString("base64") },
    attachmentId,
  };
}

/**
 * 発言の画像を取り（1 回 ATTACHMENT_FETCH_TIMEOUT_MS まで。画像ごとに並べて行う）、渡す画像と保存した原本の id を返す。
 * 長辺が MAX_IMAGE_LONG_SIDE を超えるものは media proxy で縮めたものを渡し、取れなければ原本を渡す。
 * 渡すものが MAX_PASSED_IMAGE_BYTES を超えたら渡さない（tooLarge）。保存するのは渡す画像の原本だけ。reject しない
 */
export async function prepareImages(
  deps: AttachmentDeps,
  source: AttachmentSource,
  images: readonly IncomingImage[],
): Promise<PreparedImages> {
  const fetchFn = deps.fetch ?? ((url, init) => fetch(url, init));
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
