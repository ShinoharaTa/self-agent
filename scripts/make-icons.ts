// Web UI のホーム画面のアイコン（docs/plan/web-ui.md §11.5。npm run make-icons）。
// 同じ図形の定義（角丸の正方形の地・2 本の横線・右下の点）から app-icon.svg と 4 つの PNG を src/web/static/ に書く。
// 依存なし: PNG は RGBA / RGB のピクセル → フィルタ 0 の行 → node:zlib の deflate → IHDR / IDAT / IEND と crc32。
// 縁は 4×4 のスーパーサンプルで取る。`--out <dir>` で書き先を変えられる（テストが一時ディレクトリに書いて commit と比べる）
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { crc32, deflateSync } from "node:zlib";

type Rgb = readonly [number, number, number];

/** GUIDELINES §2.1 のダーク: 地 `--surface`・線 `--text`・点 `--accent` */
const SURFACE: Rgb = [0x11, 0x14, 0x1c];
const TEXT: Rgb = [0xee, 0xf0, 0xf5];
const ACCENT: Rgb = [0x6b, 0x9a, 0xff];

/** 図形は 0〜1 の座標（1 = 一辺）。線は両端が丸い矩形、点は円 */
const BG_RADIUS = 0.1875;
const LINES: ReadonlyArray<{ x0: number; x1: number; cy: number; h: number }> = [
  { x0: 0.22, x1: 0.78, cy: 0.4, h: 0.08 },
  { x0: 0.22, x1: 0.58, cy: 0.6, h: 0.08 },
];
const DOT = { cx: 0.73, cy: 0.6, r: 0.07 };

type Variant = {
  /** 地を角丸にして角を透過にする（false なら一面を塗り、透過なし） */
  rounded: boolean;
  /** 印を中央からこの倍率で縮める（maskable は中央 80% の円に余裕を持って収める） */
  scale: number;
};

const SUB = 4;

function inRoundRect(x: number, y: number, x0: number, y0: number, x1: number, y1: number, r: number): boolean {
  if (x < x0 || x > x1 || y < y0 || y > y1) return false;
  const dx = x < x0 + r ? x0 + r - x : x > x1 - r ? x - (x1 - r) : 0;
  const dy = y < y0 + r ? y0 + r - y : y > y1 - r ? y - (y1 - r) : 0;
  return dx * dx + dy * dy <= r * r;
}

/** 1 点の色（上の図形から順に）。地の外は undefined（透過） */
function colorAt(x: number, y: number, v: Variant): Rgb | undefined {
  if (v.rounded && !inRoundRect(x, y, 0, 0, 1, 1, BG_RADIUS)) return undefined;
  // 印の座標に戻す（中央を基準に縮めた分を広げる）
  const mx = 0.5 + (x - 0.5) / v.scale;
  const my = 0.5 + (y - 0.5) / v.scale;
  const ddx = mx - DOT.cx;
  const ddy = my - DOT.cy;
  if (ddx * ddx + ddy * ddy <= DOT.r * DOT.r) return ACCENT;
  for (const l of LINES) {
    if (inRoundRect(mx, my, l.x0, l.cy - l.h / 2, l.x1, l.cy + l.h / 2, l.h / 2)) return TEXT;
  }
  return SURFACE;
}

/** size×size のピクセル（opaque なら RGB、それ以外は RGBA。透過の画素の色は 0） */
function render(size: number, v: Variant): { channels: 3 | 4; data: Buffer } {
  const channels = v.rounded ? 4 : 3;
  const data = Buffer.alloc(size * size * channels);
  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      let r = 0;
      let g = 0;
      let b = 0;
      let covered = 0;
      for (let sy = 0; sy < SUB; sy++) {
        for (let sx = 0; sx < SUB; sx++) {
          const c = colorAt((px + (sx + 0.5) / SUB) / size, (py + (sy + 0.5) / SUB) / size, v);
          if (c === undefined) continue;
          r += c[0];
          g += c[1];
          b += c[2];
          covered++;
        }
      }
      const i = (py * size + px) * channels;
      if (covered === 0) continue;
      data[i] = Math.round(r / covered);
      data[i + 1] = Math.round(g / covered);
      data[i + 2] = Math.round(b / covered);
      if (channels === 4) data[i + 3] = Math.round((covered * 255) / (SUB * SUB));
    }
  }
  return { channels, data };
}

function chunk(type: string, body: Buffer): Buffer {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(body.length, 0);
  head.write(type, 4, "ascii");
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), body])), 0);
  return Buffer.concat([head, body, crc]);
}

function png(size: number, v: Variant): Buffer {
  const { channels, data } = render(size, v);
  const stride = size * channels;
  const raw = Buffer.alloc((stride + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (stride + 1)] = 0; // フィルタ 0（なし）
    data.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // ビット深度
  ihdr[9] = channels === 4 ? 6 : 2; // RGBA / RGB
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

const hex = (c: Rgb): string => `#${c.map((n) => n.toString(16).padStart(2, "0")).join("")}`;
const u = (n: number): string => String(Math.round(n * 512 * 100) / 100);

/** favicon（角丸の地・余白は any と同じ）。512 の viewBox で同じ図形を書く */
function svg(): string {
  const lines = LINES.map(
    (l) => `  <rect x="${u(l.x0)}" y="${u(l.cy - l.h / 2)}" width="${u(l.x1 - l.x0)}" height="${u(l.h)}" rx="${u(l.h / 2)}" fill="${hex(TEXT)}"/>\n`,
  ).join("");
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">\n` +
    `  <rect width="512" height="512" rx="${u(BG_RADIUS)}" fill="${hex(SURFACE)}"/>\n` +
    lines +
    `  <circle cx="${u(DOT.cx)}" cy="${u(DOT.cy)}" r="${u(DOT.r)}" fill="${hex(ACCENT)}"/>\n` +
    `</svg>\n`
  );
}

const ANY: Variant = { rounded: true, scale: 1 };
const FLAT: Variant = { rounded: false, scale: 1 };
const MASKABLE: Variant = { rounded: false, scale: 0.8 };

const outIndex = process.argv.indexOf("--out");
const outDir = outIndex >= 0 && process.argv[outIndex + 1] ? process.argv[outIndex + 1]! : fileURLToPath(new URL("../src/web/static/", import.meta.url));
mkdirSync(outDir, { recursive: true });
writeFileSync(join(outDir, "app-icon.svg"), svg());
writeFileSync(join(outDir, "apple-touch-icon.png"), png(180, FLAT));
writeFileSync(join(outDir, "icon-192.png"), png(192, ANY));
writeFileSync(join(outDir, "icon-512.png"), png(512, ANY));
writeFileSync(join(outDir, "icon-512-maskable.png"), png(512, MASKABLE));
console.log("make-icons: 5 個のファイルを書きました");
