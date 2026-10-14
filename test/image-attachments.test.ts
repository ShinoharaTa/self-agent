import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import type { RunResult } from "../src/agent/runner.ts";
import { acceptedChannel, createChannelResolver } from "../src/app/access.ts";
import {
  attachmentNotes,
  attachmentsDir,
  type FetchFn,
  IMAGE_FETCH_FAILED_REPLY,
  IMAGE_TOO_LARGE_REPLY,
  imageSize,
  isAllowedAttachmentUrl,
  MAX_IMAGE_LONG_SIDE,
  MAX_PASSED_IMAGE_BYTES,
  prepareImages,
  pruneAttachments,
  resizedProxyUrl,
  sniffImageType,
} from "../src/app/attachments.ts";
import { attachmentTotalsLine, createUsageCommand } from "../src/app/commands/usage.ts";
import { createHandler, REVIVED_NOTE } from "../src/app/handler.ts";
import { buildTurnPrompt } from "../src/app/prompt.ts";
import { KeyedSerialQueue } from "../src/app/queue.ts";
import { formatDevLogRecord } from "../src/devlog/format.ts";
import type { DevLogRecord } from "../src/devlog/log.ts";
import { MAX_IMAGE_BYTES, toIncomingAttachments, type AttachmentSource } from "../src/discord/convert.ts";
import type { IncomingImage, IncomingMessage } from "../src/discord/gateway.ts";
import type { AttachmentStore } from "../src/store/attachments.ts";
import { createStores, tempDb, tempDir } from "./helpers/db.ts";
import { FakeGateway } from "./helpers/gateway.ts";
import { RecordingChannelOps } from "./helpers/recording.ts";
import { FakeResponder } from "./helpers/responder.ts";
import { FakeRunner, turnUsage } from "./helpers/runner.ts";

const DAY_MS = 24 * 60 * 60 * 1000;
const NOW = new Date("2026-10-14T00:00:00Z");
const GUILD = "111";
const CHANNEL = "222";
const MESSAGE = "333";
const CDN_URL = "https://cdn.discordapp.com/attachments/1/2/a.png?ex=1";
const PROXY_URL = "https://media.discordapp.net/attachments/1/2/a.png?ex=1";

/** 幅・高さを IHDR に持つ PNG の頭で、全体が size バイトの中身 */
function png(width = 800, height = 600, size = 64): Uint8Array {
  const bytes = new Uint8Array(Math.max(size, 24));
  const view = new DataView(bytes.buffer);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  view.setUint32(8, 13);
  bytes.set([0x49, 0x48, 0x44, 0x52], 12);
  view.setUint32(16, width);
  view.setUint32(20, height);
  return bytes;
}

/** APP0 の後ろに幅・高さを持つ SOF0 がある JPEG の頭 */
function jpeg(width = 800, height = 600, size = 64): Uint8Array {
  const bytes = new Uint8Array(Math.max(size, 40));
  const view = new DataView(bytes.buffer);
  bytes.set([0xff, 0xd8, 0xff, 0xe0]);
  view.setUint16(4, 16);
  bytes.set([0xff, 0xc0], 20);
  view.setUint16(22, 17);
  bytes[24] = 8;
  view.setUint16(25, height);
  view.setUint16(27, width);
  return bytes;
}

/** VP8X の WebP の頭 */
function webp(width = 800, height = 600, size = 64): Uint8Array {
  const bytes = new Uint8Array(Math.max(size, 30));
  bytes.set(new TextEncoder().encode("RIFF"), 0);
  bytes.set(new TextEncoder().encode("WEBPVP8X"), 8);
  const put24 = (at: number, value: number): void => {
    bytes[at] = value & 0xff;
    bytes[at + 1] = (value >> 8) & 0xff;
    bytes[at + 2] = (value >> 16) & 0xff;
  };
  put24(24, width - 1);
  put24(27, height - 1);
  return bytes;
}

function discordAttachment(overrides: Partial<AttachmentSource> = {}): AttachmentSource {
  return {
    url: "https://cdn.example/attachments/1/2/a.png?ex=1",
    proxyURL: "https://media.example/attachments/1/2/a.png?ex=1",
    contentType: "image/png",
    name: "a.png",
    size: 1000,
    width: 800,
    height: 600,
    ...overrides,
  };
}

function image(overrides: Partial<IncomingImage> = {}): IncomingImage {
  return {
    url: CDN_URL,
    proxyUrl: PROXY_URL,
    contentType: "image/png",
    size: 64,
    width: 800,
    height: 600,
    ...overrides,
  };
}

/** 原本の URL ごとの答え（url は CDN_URL の a.png を name に置き換えたもの） */
function cdn(name: string): string {
  return CDN_URL.replace("a.png", name);
}

/** 縮めた proxy の URL（webp か同じ形式） */
function proxyFor(size: { width: number; height: number }, webpFormat: boolean, base = PROXY_URL): string {
  return resizedProxyUrl(base, size, webpFormat)!;
}

type Answer = Uint8Array | number | Error | Response;

/** URL ごとの答え（無い URL は 404）。呼ばれた URL と init を残す */
function fakeFetch(answers: Record<string, Answer>) {
  const calls: Array<{ url: string; signal: AbortSignal; redirect: string }> = [];
  const fetch: FetchFn = async (url, init) => {
    calls.push({ url, signal: init.signal, redirect: init.redirect });
    const answer = answers[url];
    if (answer instanceof Error) throw answer;
    if (answer instanceof Response) return answer;
    if (answer === undefined) return new Response(null, { status: 404 });
    if (typeof answer === "number") return new Response(null, { status: answer });
    return new Response(new Uint8Array(answer));
  };
  return { fetch, calls };
}

function base64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64");
}

function setupStore(t: TestContext, clock: { now: Date } = { now: NOW }) {
  const db = tempDb(t);
  const { attachments } = createStores(db, () => clock.now);
  const dataDir = tempDir(t);
  const logs: string[] = [];
  return { db, attachments, dataDir, logs, clock };
}

const SOURCE = { guildId: GUILD, channelId: CHANNEL, messageId: MESSAGE };

// --- Gateway の添付の情報 ---

test("toIncomingAttachments: jpeg・png・webp・gif だけを画像として渡し、それ以外は読めない形式として数える。content type が無ければ拡張子で見る", () => {
  const result = toIncomingAttachments([
    discordAttachment({ contentType: "image/png" }),
    discordAttachment({ contentType: "image/jpeg; charset=binary", name: "b.jpg" }),
    discordAttachment({ contentType: "application/pdf", name: "c.pdf" }),
    discordAttachment({ contentType: "image/heic", name: "d.heic" }),
    discordAttachment({ contentType: null, name: "e.WEBP", width: null, height: null }),
    discordAttachment({ contentType: null, name: "f.txt" }),
  ]);

  assert.deepEqual(
    result.images.map((incoming) => incoming.contentType),
    ["image/png", "image/jpeg", "image/webp"],
  );
  assert.deepEqual(result.images[0], {
    url: "https://cdn.example/attachments/1/2/a.png?ex=1",
    proxyUrl: "https://media.example/attachments/1/2/a.png?ex=1",
    contentType: "image/png",
    size: 1000,
    width: 800,
    height: 600,
  });
  assert.equal(result.images[2]!.width, null);
  assert.deepEqual(result.skippedAttachments, { unsupported: 3, overLimit: 0 });
});

test("toIncomingAttachments: 1 発言 4 枚まで・1 枚 10 MB まで。超えたものは上限として数える", () => {
  const result = toIncomingAttachments([
    discordAttachment({ name: "1.png" }),
    discordAttachment({ name: "big.png", size: MAX_IMAGE_BYTES + 1 }),
    discordAttachment({ name: "2.png", size: MAX_IMAGE_BYTES }),
    discordAttachment({ name: "3.gif", contentType: "image/gif" }),
    discordAttachment({ name: "4.png" }),
    discordAttachment({ name: "5.png" }),
    discordAttachment({ name: "x.zip", contentType: "application/zip" }),
  ]);

  assert.equal(result.images.length, 4);
  assert.deepEqual(result.skippedAttachments, { unsupported: 1, overLimit: 2 });
  assert.deepEqual(toIncomingAttachments([]), { images: [], skippedAttachments: { unsupported: 0, overLimit: 0 } });
});

// --- 受付 ---

test("acceptedChannel: 本文が空でも渡せる画像か渡さない添付があれば受け付ける。本文も添付も無い発言は今どおり弾く", () => {
  const cfg = { allowedGuildIds: [GUILD], ownerUserId: "owner" };
  const resolve = () => "inbox" as const;
  const base: IncomingMessage = {
    id: MESSAGE,
    channelId: CHANNEL,
    guildId: GUILD,
    authorId: "owner",
    authorIsBot: false,
    isWebhook: false,
    content: "",
    createdAt: NOW,
  };

  assert.equal(acceptedChannel({ ...base, images: [image()] }, cfg, resolve), "inbox");
  // 読めない添付だけでも受け付ける（handler が注記を返す）
  assert.equal(acceptedChannel({ ...base, images: [], skippedAttachments: { unsupported: 1, overLimit: 0 } }, cfg, resolve), "inbox");
  assert.equal(acceptedChannel({ ...base, images: [], skippedAttachments: { unsupported: 0, overLimit: 2 } }, cfg, resolve), "inbox");
  assert.equal(acceptedChannel({ ...base, content: "  " }, cfg, resolve), null);
  assert.equal(acceptedChannel({ ...base, images: [], skippedAttachments: { unsupported: 0, overLimit: 0 } }, cfg, resolve), null);
  // 画像があってもオーナー以外・bot は弾く
  assert.equal(acceptedChannel({ ...base, images: [image()], authorId: "other" }, cfg, resolve), null);
  assert.equal(acceptedChannel({ ...base, images: [image()], authorIsBot: true }, cfg, resolve), null);
});

// --- 形式・大きさ・縮小 ---

test("sniffImageType: 中身の先頭で形式を見る。画像でなければ undefined", () => {
  assert.equal(sniffImageType(png()), "image/png");
  assert.equal(sniffImageType(jpeg()), "image/jpeg");
  assert.equal(sniffImageType(new TextEncoder().encode("GIF89a....")), "image/gif");
  assert.equal(sniffImageType(webp()), "image/webp");
  assert.equal(sniffImageType(new TextEncoder().encode("<html>")), undefined);
  assert.equal(sniffImageType(new Uint8Array()), undefined);
});

test("imageSize: PNG・JPEG・GIF・WebP（VP8X・VP8L・VP8）のヘッダから幅・高さを読む。読めない・0 なら undefined", () => {
  assert.deepEqual(imageSize(png(4032, 3024), "image/png"), { width: 4032, height: 3024 });
  assert.deepEqual(imageSize(jpeg(1200, 1600), "image/jpeg"), { width: 1200, height: 1600 });
  assert.deepEqual(imageSize(webp(2000, 1000), "image/webp"), { width: 2000, height: 1000 });
  const gif = new Uint8Array([...new TextEncoder().encode("GIF89a"), 0x20, 0x03, 0x58, 0x02]);
  assert.deepEqual(imageSize(gif, "image/gif"), { width: 800, height: 600 });
  // VP8L: 幅 - 1 と高さ - 1 を 14 ビットずつ
  const lossless = new Uint8Array(30);
  lossless.set(new TextEncoder().encode("RIFF"), 0);
  lossless.set(new TextEncoder().encode("WEBPVP8L"), 8);
  const bits = (100 - 1) | ((50 - 1) << 14);
  lossless.set([0x2f, bits & 0xff, (bits >> 8) & 0xff, (bits >> 16) & 0xff, (bits >> 24) & 0xff], 20);
  assert.deepEqual(imageSize(lossless, "image/webp"), { width: 100, height: 50 });
  // VP8: 開始の印の後ろに 14 ビットの幅・高さ
  const lossy = new Uint8Array(30);
  lossy.set(new TextEncoder().encode("RIFF"), 0);
  lossy.set(new TextEncoder().encode("WEBPVP8 "), 8);
  lossy.set([0x9d, 0x01, 0x2a, 0x40, 0x01, 0xf0, 0x00], 23);
  assert.deepEqual(imageSize(lossy, "image/webp"), { width: 320, height: 240 });

  assert.equal(imageSize(png(0, 600), "image/png"), undefined);
  assert.equal(imageSize(png().slice(0, 20), "image/png"), undefined);
  // SOF が無いまま SOS に着いた JPEG
  const noSof = new Uint8Array([0xff, 0xd8, 0xff, 0xda, 0x00, 0x08, 0, 0, 0, 0, 0, 0]);
  assert.equal(imageSize(noSof, "image/jpeg"), undefined);
  assert.equal(imageSize(new Uint8Array([0xff, 0xd8, 0xff]), "image/jpeg"), undefined);
});

test("resizedProxyUrl: 長辺を 1568 以下にした縦横比の width・height（と webp なら format=webp）を proxy の URL に足す。元の引数は残す", () => {
  const parsed = new URL(resizedProxyUrl(PROXY_URL, { width: 4032, height: 3024 }, true)!);
  assert.equal(parsed.searchParams.get("ex"), "1");
  assert.equal(parsed.searchParams.get("width"), String(MAX_IMAGE_LONG_SIDE));
  assert.equal(parsed.searchParams.get("height"), "1176");
  assert.equal(parsed.searchParams.get("format"), "webp");

  const plain = new URL(resizedProxyUrl(PROXY_URL, { width: 1000, height: 3136 }, false)!);
  assert.equal(plain.searchParams.get("width"), "500");
  assert.equal(plain.searchParams.get("height"), "1568");
  assert.equal(plain.searchParams.has("format"), false);
  // 長辺がもう上限以下なら同じ大きさのまま（形式・画質だけ変える）
  assert.equal(new URL(resizedProxyUrl(PROXY_URL, { width: 800, height: 600 }, true)!).searchParams.get("width"), "800");
  assert.equal(resizedProxyUrl("not a url", { width: 4000, height: 3000 }, true), undefined);
});

test("isAllowedAttachmentUrl: https の cdn.discordapp.com・media.discordapp.net だけ", () => {
  assert.equal(isAllowedAttachmentUrl(CDN_URL), true);
  assert.equal(isAllowedAttachmentUrl(PROXY_URL), true);
  for (const url of [
    "http://cdn.discordapp.com/a.png",
    "https://cdn.discordapp.com.evil.example/a.png",
    "https://evil.example/cdn.discordapp.com/a.png",
    "https://cdn.discordapp.com:8443/a.png",
    "https://user@media.discordapp.net/a.png",
    "file:///etc/passwd",
    "not a url",
  ]) {
    assert.equal(isAllowedAttachmentUrl(url), false, url);
  }
});

// --- 取得・保存 ---

test("prepareImages: 長辺も大きさも上限以下の画像は原本を 1 回（転送をたどらずに）取り、それを渡す。原本を 600 で、ディレクトリを 700 で置き、行（相対パス・sha256・大きさ・中身から読んだ幅・高さ）を記録する", async (t) => {
  const { attachments, dataDir, logs } = setupStore(t);
  const original = png(800, 600, 100);
  const { fetch, calls } = fakeFetch({ [CDN_URL]: original });

  // Discord の幅・高さは信じない（中身のヘッダの値を使う）
  const prepared = await prepareImages({ dataDir, attachments, fetch, log: (line) => logs.push(line) }, SOURCE, [
    image({ width: 9999, height: 9999 }),
  ]);

  assert.deepEqual(prepared, {
    images: [{ mediaType: "image/png", data: base64(original) }],
    attachmentIds: [1],
    tooLarge: 0,
    failed: 0,
  });
  assert.deepEqual(
    calls.map((call) => [call.url, call.redirect]),
    [[CDN_URL, "error"]],
  );
  assert.ok(calls[0]!.signal instanceof AbortSignal);
  const root = attachmentsDir(dataDir);
  const file = join(root, GUILD, CHANNEL, `${MESSAGE}-1.png`);
  assert.deepEqual(new Uint8Array(readFileSync(file)), original);
  assert.equal(statSync(file).mode & 0o777, 0o600);
  for (const dir of [root, join(root, GUILD), join(root, GUILD, CHANNEL)]) assert.equal(statSync(dir).mode & 0o777, 0o700);
  const row = attachments.get(1)!;
  assert.equal(row.path, join(GUILD, CHANNEL, `${MESSAGE}-1.png`));
  assert.equal(row.contentType, "image/png");
  assert.equal(row.size, 100);
  assert.equal(row.width, 800);
  assert.equal(row.height, 600);
  assert.equal(row.sha256, createHash("sha256").update(original).digest("hex"));
  assert.equal(row.recordId, null);
  assert.deepEqual(logs, []);
});

test("prepareImages: 長辺が大きい画像は media proxy の webp で縮めたものを渡し、原本は縮めずに残す", async (t) => {
  const { attachments, dataDir } = setupStore(t);
  const original = jpeg(4032, 3024, 500);
  const resized = webp(1568, 1176, 50);
  const size = { width: 4032, height: 3024 };
  const { fetch, calls } = fakeFetch({ [cdn("big.jpg")]: original, [proxyFor(size, true)]: resized });

  const prepared = await prepareImages({ dataDir, attachments, fetch, log: () => {} }, SOURCE, [
    image({ url: cdn("big.jpg"), contentType: "image/jpeg" }),
  ]);

  assert.deepEqual(prepared.images, [{ mediaType: "image/webp", data: base64(resized) }]);
  assert.deepEqual(
    calls.map((call) => call.url),
    [cdn("big.jpg"), proxyFor(size, true)],
  );
  assert.deepEqual(new Uint8Array(readFileSync(join(attachmentsDir(dataDir), GUILD, CHANNEL, `${MESSAGE}-1.jpg`))), original);
  const row = attachments.get(1)!;
  assert.deepEqual([row.size, row.width, row.height, row.contentType], [500, 4032, 3024, "image/jpeg"]);
});

test("prepareImages: webp の縮小を渡せない（失敗・画像でない・長辺が大きいまま・例外）なら同じ形式の縮小を渡す", async (t) => {
  const size = { width: 3000, height: 2000 };
  const resized = png(1568, 1045, 80);
  for (const answer of [500, new TextEncoder().encode("<html>"), webp(3000, 2000), new Error("timeout")]) {
    const { attachments, dataDir } = setupStore(t);
    const { fetch } = fakeFetch({ [CDN_URL]: png(3000, 2000), [proxyFor(size, true)]: answer, [proxyFor(size, false)]: resized });

    const prepared = await prepareImages({ dataDir, attachments, fetch, log: () => {} }, SOURCE, [image()]);

    assert.deepEqual(prepared.images, [{ mediaType: "image/png", data: base64(resized) }], String(answer));
    assert.deepEqual(prepared.attachmentIds, [1]);
  }
});

test("prepareImages: 縮めたものをどちらも渡せなければ原本は渡さない（取れなければ取得の失敗、1 MiB を超えれば大きすぎ）。保存もしない", async (t) => {
  const size = { width: 3000, height: 2000 };
  const cases: Array<{ label: string; webpAnswer: Answer; plainAnswer: Answer; expected: { tooLarge: number; failed: number } }> = [
    { label: "どちらも取れない", webpAnswer: 404, plainAnswer: new Error("x"), expected: { tooLarge: 0, failed: 1 } },
    { label: "縮めても大きい", webpAnswer: webp(1568, 1045, MAX_PASSED_IMAGE_BYTES + 1), plainAnswer: 500, expected: { tooLarge: 1, failed: 0 } },
    { label: "長辺が縮まない", webpAnswer: webp(3000, 2000), plainAnswer: png(3000, 2000), expected: { tooLarge: 0, failed: 1 } },
  ];
  for (const { label, webpAnswer, plainAnswer, expected } of cases) {
    const { attachments, dataDir } = setupStore(t);
    const { fetch } = fakeFetch({ [CDN_URL]: png(3000, 2000), [proxyFor(size, true)]: webpAnswer, [proxyFor(size, false)]: plainAnswer });

    const prepared = await prepareImages({ dataDir, attachments, fetch, log: () => {} }, SOURCE, [image()]);

    assert.deepEqual(prepared, { images: [], attachmentIds: [], ...expected }, label);
    assert.equal(existsSync(attachmentsDir(dataDir)), false, label);
  }
});

test("prepareImages: 長辺は小さくても 1 MiB を超える原本は、同じ大きさのまま webp に変えたものを渡す", async (t) => {
  const { attachments, dataDir } = setupStore(t);
  const size = { width: 1200, height: 900 };
  const converted = webp(1200, 900, 300);
  const { fetch } = fakeFetch({ [CDN_URL]: png(1200, 900, MAX_PASSED_IMAGE_BYTES + 1), [proxyFor(size, true)]: converted });

  const prepared = await prepareImages({ dataDir, attachments, fetch, log: () => {} }, SOURCE, [image()]);

  assert.deepEqual(prepared.images, [{ mediaType: "image/webp", data: base64(converted) }]);
  assert.equal(attachments.get(1)!.size, MAX_PASSED_IMAGE_BYTES + 1);
});

test("prepareImages: 中身が画像でない・幅と高さを読めない原本、許していない場所の URL は取得の失敗（許していない URL は取りに行かない）", async (t) => {
  const { attachments, dataDir } = setupStore(t);
  const { fetch, calls } = fakeFetch({
    [cdn("html.png")]: new TextEncoder().encode("<html>"),
    [cdn("zero.png")]: png(0, 0),
    "https://evil.example/a.png": png(),
  });

  const prepared = await prepareImages({ dataDir, attachments, fetch, log: () => {} }, SOURCE, [
    image({ url: cdn("html.png") }),
    image({ url: cdn("zero.png") }),
    image({ url: "https://evil.example/a.png" }),
    image({ url: "http://cdn.discordapp.com/a.png" }),
  ]);

  assert.deepEqual(prepared, { images: [], attachmentIds: [], tooLarge: 0, failed: 4 });
  assert.deepEqual(
    calls.map((call) => call.url).sort(),
    [cdn("html.png"), cdn("zero.png")].sort(),
  );
});

test("prepareImages: Content-Length が上限を超えていれば読まずに、読んでいる途中で超えたらそこで止めて大きすぎにする", async (t) => {
  const { attachments, dataDir } = setupStore(t);
  let pulled = 0;
  const chunk = new Uint8Array(1024 * 1024);
  chunk.set(png(3000, 2000).slice(0, 24));
  // Content-Length の無い、1 MiB ずつ流れる大きな原本
  const endless = new Response(
    new ReadableStream<Uint8Array>({
      pull(controller) {
        pulled++;
        controller.enqueue(chunk.slice());
      },
    }),
  );
  const declared = new Response(new Uint8Array(png()), { headers: { "content-length": String(MAX_IMAGE_BYTES + 1) } });
  const { fetch } = fakeFetch({ [cdn("endless.png")]: endless, [cdn("declared.png")]: declared });

  const prepared = await prepareImages({ dataDir, attachments, fetch, log: () => {} }, SOURCE, [
    image({ url: cdn("endless.png") }),
    image({ url: cdn("declared.png") }),
  ]);

  assert.deepEqual(prepared, { images: [], attachmentIds: [], tooLarge: 2, failed: 0 });
  // 10 MB を少し超えたところで止める（全部は読まない）
  assert.ok(pulled <= Math.ceil(MAX_IMAGE_BYTES / chunk.length) + 2, `pulled=${pulled}`);
});

test("prepareImages: 1 枚ずつ判定し、渡せたものだけを（発言の添付の順の番号で）保存する", async (t) => {
  const { attachments, dataDir } = setupStore(t);
  const { fetch } = fakeFetch({
    [cdn("1.png")]: png(800, 600, 10),
    [cdn("huge.png")]: png(800, 600, MAX_PASSED_IMAGE_BYTES + 1),
    [cdn("3.png")]: png(800, 600, MAX_PASSED_IMAGE_BYTES),
  });

  const prepared = await prepareImages({ dataDir, attachments, fetch, log: () => {} }, SOURCE, [
    image({ url: cdn("1.png") }),
    image({ url: cdn("huge.png") }),
    image({ url: cdn("3.png") }),
    image({ url: cdn("missing.png") }),
  ]);

  assert.equal(prepared.images.length, 2);
  assert.deepEqual(prepared.attachmentIds, [1, 2]);
  assert.equal(prepared.tooLarge, 1);
  assert.equal(prepared.failed, 1);
  assert.deepEqual(
    [attachments.get(1)!.path, attachments.get(2)!.path],
    [join(GUILD, CHANNEL, `${MESSAGE}-1.png`), join(GUILD, CHANNEL, `${MESSAGE}-3.png`)],
  );
  assert.equal(attachments.get(3), undefined);
  assert.equal(existsSync(join(attachmentsDir(dataDir), GUILD, CHANNEL, `${MESSAGE}-2.png`)), false);
});

test("prepareImages: 原本を保存できなくても（同じ名前のファイルがある）画像は渡す。既にあるファイルは上書きせず、log にパスは出さない", async (t) => {
  const { attachments, dataDir, logs } = setupStore(t);
  const existing = join(attachmentsDir(dataDir), GUILD, CHANNEL, `${MESSAGE}-1.png`);
  mkdirSync(join(attachmentsDir(dataDir), GUILD, CHANNEL), { recursive: true });
  writeFileSync(existing, "before");
  const { fetch } = fakeFetch({ [CDN_URL]: png() });

  const prepared = await prepareImages({ dataDir, attachments, fetch, log: (line) => logs.push(line) }, SOURCE, [image()]);

  assert.equal(prepared.images.length, 1);
  assert.deepEqual(prepared.attachmentIds, []);
  assert.equal(readFileSync(existing, "utf8"), "before");
  assert.deepEqual(logs, ["添付の原本を保存できませんでした"]);
});

test("attachmentNotes: 渡さなかった添付の注記（無ければ空）", () => {
  assert.deepEqual(attachmentNotes(undefined, undefined), []);
  assert.deepEqual(attachmentNotes({ unsupported: 0, overLimit: 0 }, { tooLarge: 0, failed: 0 }), []);
  assert.deepEqual(attachmentNotes({ unsupported: 2, overLimit: 1 }, { tooLarge: 1, failed: 1 }), [
    "（添付 2 件は読めない形式のため渡していません）",
    "（画像 1 枚は上限（1 発言 4 枚・1 枚 10 MB）を超えるため渡していません）",
    "（画像 1 枚は大きすぎるため渡していません）",
    "（画像 1 枚は取得できなかったため渡していません）",
  ]);
});

// --- 30 日の掃除 ---

/** days 日前に受け取った添付を、attachments の下のファイルと行で作る */
function addAt(
  env: { attachments: AttachmentStore; dataDir: string; clock: { now: Date } },
  days: number,
  name: string,
): { id: number; file: string } {
  const saved = env.clock.now;
  env.clock.now = new Date(NOW.getTime() - days * DAY_MS);
  const path = join(GUILD, CHANNEL, name);
  const file = join(attachmentsDir(env.dataDir), path);
  mkdirSync(join(file, ".."), { recursive: true });
  writeFileSync(file, "x");
  const { id } = env.attachments.add({
    guildId: GUILD,
    channelId: CHANNEL,
    messageId: MESSAGE,
    path,
    contentType: "image/png",
    size: 1,
    sha256: "00",
  });
  env.clock.now = saved;
  return { id, file };
}

/** days 日前の行を path のまま直接入れる（ストアは `..`・絶対パスを受け付けないので、壊れた行を作るため） */
function insertRawAt(env: { db: DatabaseSync }, days: number, path: string): { id: number } {
  const row = env.db
    .prepare(
      "INSERT INTO attachments (guild_id, channel_id, message_id, path, content_type, size, sha256, created_at) " +
        "VALUES (?, ?, ?, ?, 'image/png', 1, '00', ?) RETURNING id",
    )
    .get(GUILD, CHANNEL, MESSAGE, path, new Date(NOW.getTime() - days * DAY_MS).toISOString());
  return { id: Number(row!.id) };
}

test("pruneAttachments: 30 日を過ぎた結びつきの無い添付だけをファイルと行ごと消す。結びついたもの・新しいものは残す", (t) => {
  const env = setupStore(t);
  const old = addAt(env, 31, "old.png");
  const linked = addAt(env, 40, "linked.png");
  const fresh = addAt(env, 29, "fresh.png");
  env.attachments.linkToRecord([linked.id], 1);

  assert.equal(pruneAttachments(env.dataDir, env.attachments), 1);

  assert.equal(existsSync(old.file), false);
  assert.equal(env.attachments.get(old.id), undefined);
  assert.ok(existsSync(linked.file) && env.attachments.get(linked.id) !== undefined);
  assert.ok(existsSync(fresh.file) && env.attachments.get(fresh.id) !== undefined);
  assert.equal(pruneAttachments(env.dataDir, env.attachments), 0);
});

test("pruneAttachments: attachments の外（`..`・絶対パス・外への symlink のディレクトリ）と symlink のファイルは消さず（たどらず）、行だけ消す", (t) => {
  const env = setupStore(t);
  const outside = join(env.dataDir, "outside");
  mkdirSync(outside);
  const secret = join(outside, "secret.png");
  writeFileSync(secret, "keep");
  // attachments/<guild>/link → outside（ディレクトリの symlink）
  mkdirSync(join(attachmentsDir(env.dataDir), GUILD), { recursive: true });
  symlinkSync(outside, join(attachmentsDir(env.dataDir), GUILD, "link"));
  // attachments/<guild>/<channel>/file-link.png → secret（ファイルの symlink）
  mkdirSync(join(attachmentsDir(env.dataDir), GUILD, CHANNEL), { recursive: true });
  const fileLink = join(attachmentsDir(env.dataDir), GUILD, CHANNEL, "file-link.png");
  symlinkSync(secret, fileLink);
  const rows = [
    insertRawAt(env, 31, join("..", "outside", "secret.png")),
    insertRawAt(env, 31, secret),
    insertRawAt(env, 31, join(GUILD, "link", "secret.png")),
    insertRawAt(env, 31, join(GUILD, CHANNEL, "file-link.png")),
  ];

  assert.equal(pruneAttachments(env.dataDir, env.attachments), 4);

  assert.equal(readFileSync(secret, "utf8"), "keep");
  assert.ok(existsSync(fileLink));
  for (const row of rows) assert.equal(env.attachments.get(row.id), undefined);
});

test("pruneAttachments: attachments のディレクトリもファイルも無ければ行だけ消す", (t) => {
  const env = setupStore(t);
  const { id } = env.attachments.add({
    guildId: GUILD,
    channelId: CHANNEL,
    messageId: MESSAGE,
    path: join(GUILD, CHANNEL, "gone.png"),
    contentType: "image/png",
    size: 1,
    sha256: "00",
  });
  env.clock.now = new Date(NOW.getTime() + 31 * DAY_MS);

  assert.equal(pruneAttachments(env.dataDir, env.attachments), 1);
  assert.equal(env.attachments.get(id), undefined);
});

// --- handler ---

const handlerCfg = { allowedGuildIds: [GUILD], inboxChannelId: CHANNEL, ownerUserId: "owner", timeZone: "Asia/Tokyo" };

function okResult(): RunResult {
  return { ok: true, text: "読みました", sessionId: "s-1", usage: turnUsage(1, 2, 3), durationMs: 10, toolCalls: 0, contextTokens: 6 };
}

function setupHandler(t: TestContext, results: RunResult[], answers: Record<string, Answer>) {
  const db = tempDb(t);
  const dataDir = tempDir(t);
  const stores = createStores(db, () => NOW);
  const gateway = new FakeGateway({ allow: ["send", "sendMessage", "editMessage", "startTyping"] });
  const runner = new FakeRunner(results);
  const logs: string[] = [];
  const { fetch } = fakeFetch(answers);
  const handler = createHandler({
    cfg: handlerCfg,
    resolveChannel: createChannelResolver(handlerCfg, stores.guildSettings, stores.topicSessions),
    gateway,
    runner,
    sessions: stores.sessions,
    seeds: stores.seeds,
    topicSessions: stores.topicSessions,
    inboxSummaries: stores.inboxSummaries,
    memories: stores.memories,
    channelOps: new RecordingChannelOps(),
    usage: stores.usage,
    queue: new KeyedSerialQueue(2),
    now: () => NOW,
    prepareImages: (source, images) =>
      prepareImages({ dataDir, attachments: stores.attachments, fetch, log: (line) => logs.push(line) }, source, images),
    log: (line) => {
      if (!line.startsWith("トークン（")) logs.push(line);
    },
  });
  return { handler, gateway, runner, logs, stores, dataDir };
}

function ownerMessage(overrides: Partial<IncomingMessage> = {}): IncomingMessage {
  return {
    id: MESSAGE,
    channelId: CHANNEL,
    guildId: GUILD,
    authorId: "owner",
    authorIsBot: false,
    isWebhook: false,
    content: "",
    createdAt: NOW,
    ...overrides,
  };
}

test("handler: 画像だけの発言を受け付け、runner に画像 1 件・ヘッダだけの prompt・保存した原本の id（context）を渡す。log は枚数だけ", async (t) => {
  const original = png(800, 600, 40);
  const env = setupHandler(t, [okResult()], { [CDN_URL]: original });

  await env.handler.handleMessage(ownerMessage({ images: [image()], skippedAttachments: { unsupported: 0, overLimit: 0 } }));

  assert.equal(env.runner.inputs.length, 1);
  const input = env.runner.inputs[0]!;
  assert.equal(input.prompt, buildTurnPrompt("", NOW, "Asia/Tokyo"));
  assert.deepEqual(input.images, [{ mediaType: "image/png", data: base64(original) }]);
  assert.deepEqual(input.context, { guildId: GUILD, channelId: CHANNEL, kind: "inbox", attachmentIds: [1] });
  assert.deepEqual(
    env.gateway.sent.map((sent) => sent.text),
    ["読みました"],
  );
  assert.deepEqual(env.logs, ["画像を受け取りました（渡す 1 枚・大きすぎ 0 枚・取得失敗 0 枚）"]);
  for (const line of env.logs) assert.ok(!line.includes("discordapp") && !line.includes(env.dataDir));
});

test("handler: 渡さない添付はヘッダの次に注記し、大きすぎる画像はオーナーに「画像が大きすぎて読めませんでした」と返す。本文と他の画像は渡す", async (t) => {
  const env = setupHandler(t, [okResult()], {
    [CDN_URL]: png(800, 600, 10),
    [cdn("huge.png")]: png(800, 600, MAX_PASSED_IMAGE_BYTES + 1),
  });

  await env.handler.handleMessage(
    ownerMessage({
      content: "この 2 枚を見て",
      images: [image(), image({ url: cdn("huge.png") })],
      skippedAttachments: { unsupported: 1, overLimit: 0 },
    }),
  );

  const input = env.runner.inputs[0]!;
  assert.equal(
    input.prompt,
    buildTurnPrompt(
      "（添付 1 件は読めない形式のため渡していません）\n（画像 1 枚は大きすぎるため渡していません）\nこの 2 枚を見て",
      NOW,
      "Asia/Tokyo",
    ),
  );
  assert.equal(input.images?.length, 1);
  assert.deepEqual(
    env.gateway.sent.map((sent) => [sent.text, sent.replyToId]),
    [
      [IMAGE_TOO_LARGE_REPLY, MESSAGE],
      ["読みました", MESSAGE],
    ],
  );
});

test("handler: 本文が無く、渡せる画像が 1 枚も残らなければターンを行わず、理由だけを返す", async (t) => {
  const env = setupHandler(t, [], { [cdn("huge.png")]: png(800, 600, MAX_PASSED_IMAGE_BYTES + 1) });

  await env.handler.handleMessage(
    ownerMessage({
      images: [image({ url: cdn("huge.png") }), image({ url: cdn("gone.png") })],
      skippedAttachments: { unsupported: 0, overLimit: 1 },
    }),
  );

  assert.equal(env.runner.inputs.length, 0);
  assert.deepEqual(
    env.gateway.sent.map((sent) => sent.text),
    [
      `${IMAGE_TOO_LARGE_REPLY}\n${IMAGE_FETCH_FAILED_REPLY}\n（画像 1 枚は上限（1 発言 4 枚・1 枚 10 MB）を超えるため渡していません）`,
    ],
  );
});

test("handler: 読めない添付・上限を超える画像だけの発言は無視せず、注記の文を返す（ターンは行わず、取りにも行かない）", async (t) => {
  const env = setupHandler(t, [], {});

  await env.handler.handleMessage(ownerMessage({ images: [], skippedAttachments: { unsupported: 2, overLimit: 0 } }));
  await env.handler.handleMessage(ownerMessage({ id: "334", images: [], skippedAttachments: { unsupported: 0, overLimit: 3 } }));

  assert.equal(env.runner.inputs.length, 0);
  assert.deepEqual(
    env.gateway.sent.map((sent) => [sent.text, sent.replyToId]),
    [
      ["（添付 2 件は読めない形式のため渡していません）", MESSAGE],
      ["（画像 3 枚は上限（1 発言 4 枚・1 枚 10 MB）を超えるため渡していません）", "334"],
    ],
  );
  assert.deepEqual(env.logs, []);
});

test("handler: 待ちのセッションで画像が 1 枚も渡せずターンを行わなくても、進行中に戻したことを返信に含める", async (t) => {
  const env = setupHandler(t, [], {});
  env.stores.topicSessions.create({ channelId: "444", guildId: GUILD, title: "領収書", categoryId: "active-1" });
  env.stores.topicSessions.setWaiting("444");

  await env.handler.handleMessage(ownerMessage({ channelId: "444", images: [image({ url: cdn("gone.png") })] }));

  assert.equal(env.runner.inputs.length, 0);
  assert.deepEqual(
    env.gateway.sent.map((sent) => sent.text),
    [`${REVIVED_NOTE}\n${IMAGE_FETCH_FAILED_REPLY}`],
  );
  assert.equal(env.stores.topicSessions.get("444")!.state, "active");
});

test("handler: 画像の無い発言は今までどおり（images・attachmentIds を付けず、prompt は本文そのまま）", async (t) => {
  const env = setupHandler(t, [okResult()], {});

  await env.handler.handleMessage(ownerMessage({ content: "こんにちは", images: [], skippedAttachments: { unsupported: 0, overLimit: 0 } }));

  assert.deepEqual(env.runner.inputs, [
    {
      prompt: buildTurnPrompt("こんにちは", NOW, "Asia/Tokyo"),
      sessionId: undefined,
      context: { guildId: GUILD, channelId: CHANNEL, kind: "inbox" },
      allowedUrls: [],
    },
  ]);
  assert.deepEqual(env.logs, []);
});

test("handler: resume に失敗して新しいセッションでやり直すときも同じ画像を渡す", async (t) => {
  const original = png(800, 600, 40);
  const resumeFailure: RunResult = {
    ok: false,
    errorMessage: "error_during_execution: No conversation found with session ID: s-old",
    sessionRecorded: false,
    toolCalls: 0,
  };
  const env = setupHandler(t, [resumeFailure, okResult()], { [CDN_URL]: original });
  env.stores.sessions.set(CHANNEL, "s-old");

  await env.handler.handleMessage(ownerMessage({ content: "これ", images: [image()] }));

  assert.equal(env.runner.inputs.length, 2);
  assert.equal(env.runner.inputs[0]!.sessionId, "s-old");
  assert.equal(env.runner.inputs[1]!.sessionId, undefined);
  for (const input of env.runner.inputs) {
    assert.deepEqual(input.images, [{ mediaType: "image/png", data: base64(original) }]);
    assert.deepEqual(input.context?.attachmentIds, [1]);
  }
});

// --- devlog・/usage ---

test("devlog の表示: 画像を渡した run は prompt の後に [画像 n 枚] の印だけを出す", () => {
  const record: DevLogRecord = {
    at: NOW.toISOString(),
    durationMs: 1000,
    guildId: GUILD,
    channelId: CHANNEL,
    kind: "inbox",
    model: "m",
    effort: null,
    maxTurns: 8,
    resume: null,
    prompt: "[ヘッダ]\n領収書",
    images: 2,
    steps: [],
    result: { ok: true, text: "はい", sessionId: "s", usage: turnUsage(1, 2, 3), toolCalls: 0, contextTokens: 6 },
  };

  const text = formatDevLogRecord(record, "Asia/Tokyo");
  assert.ok(text.includes("--- prompt ---\n[ヘッダ]\n領収書\n[画像 2 枚]\n--- steps ---"), text);
  const { images: _images, ...withoutImages } = record;
  assert.ok(!formatDevLogRecord(withoutImages, "Asia/Tokyo").includes("[画像"));
});

test("/usage: 保存している添付の件数と合計の大きさを最後に 1 行出す（AttachmentStore.totals）", async (t) => {
  const env = setupStore(t);
  assert.deepEqual(env.attachments.totals(), { count: 0, bytes: 0 });
  addAt(env, 1, "a.png");
  env.attachments.add({
    guildId: GUILD,
    channelId: CHANNEL,
    messageId: MESSAGE,
    path: join(GUILD, CHANNEL, "b.png"),
    contentType: "image/png",
    size: 3 * 1024 * 1024,
    sha256: "00",
  });
  assert.deepEqual(env.attachments.totals(), { count: 2, bytes: 3 * 1024 * 1024 + 1 });
  assert.equal(attachmentTotalsLine({ count: 2, bytes: 3 * 1024 * 1024 + 1 }), "保存している添付 2 件（3.0 MB）");

  const { usage } = createStores(tempDb(t), () => NOW);
  const command = createUsageCommand({ usage, cfg: { timeZone: "Asia/Tokyo" }, attachments: env.attachments });
  const responder = new FakeResponder();
  await command.handle(
    { kind: "command", name: "usage", options: {}, guildId: GUILD, channelId: CHANNEL, userId: "owner", createdAt: NOW },
    responder,
  );
  const reply = responder.calls.find((call) => call.method === "reply");
  assert.ok(reply !== undefined && "message" in reply && reply.message.text.endsWith("\n\n保存している添付 2 件（3.0 MB）"));
});
