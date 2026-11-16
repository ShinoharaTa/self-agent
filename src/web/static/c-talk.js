// 会話の行の部品（docs/plan/web-ui-components.md §6 の K4）: 返事の最小限の Markdown の解析。
// 解析は ui.js の parseBlocks・parseInline の写し（同じ結果である事を test/web-render-text.test.ts が留める。正規表現は変えない）

// ===== 返事の最小限の Markdown（ui.js と同じ。docs/plan/web-ui-polish.md の UI-11） =====
// 見出し（# 〜 ###）・太字 **x**・箇条書き（- * と 1.。入れ子は 1 段まで）・フェンス ```（情報文字列は使わない）・
// インラインコード `x`・リンク（http(s) の URL だけ）。表・引用・画像・HTML はそのまま文字。閉じない ** も文字のまま。
// 閉じないフェンスは末尾までコード
const FENCE_RE = /^\s*```/;
const FENCE_CLOSE_RE = /^\s*```\s*$/;
const HEADING_RE = /^#{1,3}[ \t]+(\S.*)$/;
const ITEM_RE = /^([ \t]*)([-*]|\d{1,9}\.)[ \t]+(\S.*)$/;

/** 本文をブロックに分ける。{ type: "paragraph"|"heading"|"code", text } と { type: "list", ordered, start, items: [{ text, children }] } */
export function parseBlocks(text) {
  const lines = String(text).replace(/\r\n?/g, "\n").split("\n");
  const blocks = [];
  let para = [];
  let list = null;
  const flushPara = () => {
    if (para.length > 0) blocks.push({ type: "paragraph", text: para.join("\n") });
    para = [];
  };
  const flushList = () => {
    if (list) blocks.push(list);
    list = null;
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (FENCE_RE.test(line)) {
      // 閉じないフェンスは末尾までコード
      let end = i + 1;
      while (end < lines.length && !FENCE_CLOSE_RE.test(lines[end])) end++;
      flushPara();
      flushList();
      blocks.push({ type: "code", text: lines.slice(i + 1, end).join("\n") });
      i = end;
      continue;
    }
    if (line.trim() === "") {
      flushPara();
      flushList();
      continue;
    }
    const heading = HEADING_RE.exec(line);
    if (heading) {
      flushPara();
      flushList();
      blocks.push({ type: "heading", text: heading[1].trim() });
      continue;
    }
    const item = ITEM_RE.exec(line);
    if (item) {
      flushPara();
      const ordered = item[2] !== "-" && item[2] !== "*";
      const nested = item[1].replace(/\t/g, "  ").length >= 2 && list !== null && list.items.length > 0;
      if (nested) {
        // 入れ子は 1 段まで（それより深いものも同じ段）
        const parent = list.items[list.items.length - 1];
        if (!parent.children) parent.children = { ordered, start: ordered ? Number.parseInt(item[2], 10) : 1, items: [] };
        parent.children.items.push({ text: item[3] });
        continue;
      }
      if (list && list.ordered !== ordered) flushList();
      if (!list) list = { type: "list", ordered, start: ordered ? Number.parseInt(item[2], 10) : 1, items: [] };
      list.items.push({ text: item[3], children: null });
      continue;
    }
    // 箇条書きの後の地の行は段落にする（項目の続きとはみなさない）
    flushList();
    para.push(line);
  }
  flushPara();
  flushList();
  return blocks;
}

/**
 * 1 行の中の記法。{ type: "text"|"strong"|"code"|"link", text } の配列。左から先に始まるものを取るので、URL の中の ** や ` で URL は切れない。
 * 太字の中の URL は splitLinks で分ける
 */
export function parseInline(text) {
  const out = [];
  const re = /`([^`\n]+)`|\*\*([^*\n](?:[^\n]*?[^*\n])??)\*\*|(https?:\/\/[^\s<>]+)/g;
  let last = 0;
  let match;
  while ((match = re.exec(text)) !== null) {
    if (match.index > last) out.push({ type: "text", text: text.slice(last, match.index) });
    if (match[1] !== undefined) out.push({ type: "code", text: match[1] });
    else if (match[2] !== undefined) out.push({ type: "strong", text: match[2] });
    else out.push({ type: "link", text: match[3] });
    last = match.index + match[0].length;
  }
  if (last < text.length) out.push({ type: "text", text: text.slice(last) });
  return out;
}

/** 太字の中の URL を分ける（ui.js の linkify と同じ正規表現）。[{ type: "text"|"link", text }]。空の文字の項は作らない */
export function splitLinks(text) {
  const parts = [];
  const re = /https?:\/\/[^\s<>]+/g;
  let last = 0;
  let match;
  while ((match = re.exec(text)) !== null) {
    if (match.index > last) parts.push({ type: "text", text: text.slice(last, match.index) });
    parts.push({ type: "link", text: match[0] });
    last = match.index + match[0].length;
  }
  if (last < text.length) parts.push({ type: "text", text: text.slice(last) });
  return parts;
}
