// 会話の行の部品（docs/plan/web-ui-components.md §6 の K4）: TalkTimeline・Bubble・Steps・StepList・RunLine・Notice・Divider・Blocks・Inline と、
// そのモデルの関数（talkModel・footOf）と返事の最小限の Markdown の解析。hook を使わない（Node から関数として呼べる）。状態は持たず、
// 入口が talkModel(state, parse) の結果を押し込む。クラスは固定の文字列、状態は data-* と aria-*。置くのは TalkTimeline だけ。
// 解析は ui.js の parseBlocks・parseInline の写し（同じ結果である事を test/web-render-text.test.ts が留める。正規表現は変えない）
import { html } from "./c-lib.js";
import { Button, Icon } from "./c-atoms.js";

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

// ===== モデル（純粋） =====

const FOOT_TONES = { done: "muted", max_turns: "warning", failed: "danger" };

const textOr = (v) => (typeof v === "string" ? v : "");
const hasOutcome = (turn) => turn.outcome !== undefined && turn.outcome !== null;

/**
 * 吹き出しの外の 1 行（結果の文と手順）。outcome が無い・完了で手順 0 は null（1 文の返事は吹き出しだけ）。
 * 手順が 0 のとき steps は null で、押せない文だけになる（open は false）
 */
export function footOf(turn, open, end) {
  if (!hasOutcome(turn)) return null;
  const n = Array.isArray(turn.steps) ? turn.steps.length : 0;
  if (turn.outcome === "done" && n === 0) return null;
  const tone = Object.hasOwn(FOOT_TONES, turn.outcome) ? FOOT_TONES[turn.outcome] : "muted";
  return { text: end, tone, steps: n > 0 ? turn.steps : null, open: n > 0 && open === true };
}

/** 会話の行のモデル。{ older, items, running }。openSteps は key（行の id を文字列にした物）の Set。state.on は読まない（TalkTimeline の prop で渡す） */
export function talkModel(state, parse) {
  const fmt = state.fmt;
  const turns = Array.isArray(state.turns) ? state.turns : [];
  const openSteps = state.openSteps;
  const items = turns.map((turn, i) => {
    const prev = i > 0 ? turns[i - 1] : null;
    const key = String(turn.id);
    const text = textOr(turn.text);
    if (turn.kind === "divider") return { kind: "divider", key, text };
    if (turn.kind === "notice") return { kind: "notice", key, text, time: fmt.time(turn) };
    const time = fmt.time(turn);
    const label = fmt.label(turn);
    if (turn.kind === "owner") {
      return { kind: "bubble", key, who: "owner", label, name: null, blocks: [{ type: "plain", text }], time, state: turn.optimistic === true ? "sending" : null, foot: null };
    }
    const open = openSteps ? openSteps.has(key) : false;
    return {
      kind: "bubble",
      key,
      who: "agent",
      label,
      name: fmt.name(turn, prev),
      blocks: parse(text),
      time,
      state: null,
      foot: hasOutcome(turn) ? footOf(turn, open, fmt.end(turn)) : null,
    };
  });
  return { older: state.hasMore === true, items, running: state.running ? runModel(state, turns) : null };
}

function runModel(state, turns) {
  const fmt = state.fmt;
  const run = state.running;
  const steps = Array.isArray(run.steps) ? run.steps : [];
  const tail = steps.slice(-3);
  return {
    name: fmt.runName(turns.length > 0 ? turns[turns.length - 1] : null),
    text: fmt.progress(run),
    waiting: fmt.waiting(run) || null,
    recent: tail.length === 0 ? [{ text: "まだ手順はありません", current: false }] : tail.map((text, i) => ({ text, current: i === tail.length - 1 })),
    all: steps.length > 3 ? { label: fmt.allLabel(run), open: state.runStepsOpen === true, steps } : null,
    stop: run.abortable ? { busy: state.stopping === true } : null,
  };
}

// ===== 部品 =====

/** 会話の行の根。on: { older(), toggleSteps(key), toggleRunSteps(), stop() } */
export function TalkTimeline({ model, on }) {
  return html`<div class="c-talk">
    ${model.older ? html`<div class="c-talk-older" key="older"><${Button} kind="ghost" size="sm" label="前の会話を読む" onPress=${() => on.older()} /></div>` : null}
    ${model.items.map((item) => {
      if (item.kind === "divider") return html`<${Divider} key=${item.key} text=${item.text} />`;
      if (item.kind === "notice") return html`<${Notice} key=${item.key} text=${item.text} time=${item.time} />`;
      return html`<${Bubble} key=${item.key} ...${item} onToggle=${() => on.toggleSteps(item.key)} />`;
    })}
    ${model.running ? html`<${RunLine} key="run" run=${model.running} on=${on} />` : null}
  </div>`;
}

/** 区切り（文字をそのまま。中に要素を作らない） */
export function Divider({ text }) {
  return html`<div class="c-divider" role="separator">${text}</div>`;
}

/** 知らせ（文字をそのまま。時刻だけ包む） */
export function Notice({ text, time }) {
  return html`<div class="c-notice">${text}${typeof time === "string" && time !== "" ? html`<span class="c-notice-time">${time}</span>` : null}</div>`;
}

/** 吹き出し。結果の文と手順は吹き出しの外（.c-msg-foot と、その下の一覧） */
export function Bubble({ who, label, name, blocks, time, state, foot, onToggle }) {
  const sending = state === "sending";
  return html`<article class="c-msg" data-who=${who} data-state=${sending ? "sending" : undefined} aria-label=${label}>
    ${name ? html`<span class="c-msg-name">${name}</span>` : null}
    <div class="c-bubble"><${Blocks} blocks=${blocks} /></div>
    <div class="c-msg-foot">
      <span class="c-msg-time">${sending ? "送っています…" : time}</span>
      ${foot ? html`<${Steps} text=${foot.text} tone=${foot.tone} toggles=${Array.isArray(foot.steps)} open=${foot.open} onToggle=${onToggle} />` : null}
    </div>
    ${foot && foot.open && Array.isArray(foot.steps) ? html`<${StepList} steps=${foot.steps} />` : null}
  </article>`;
}

/** 結果の文。手順があれば開閉のボタン（開閉の状態は外が持つ。aria-controls は付けず、一覧はボタンのすぐ後ろに出す） */
export function Steps({ text, tone, toggles, open, onToggle }) {
  if (!toggles) return html`<span class="c-steps-text" data-tone=${tone}>${text}</span>`;
  return html`<button class="c-steps-toggle" type="button" data-tone=${tone} aria-expanded=${open ? "true" : "false"} onClick=${() => onToggle()}>
    <${Icon} name=${open ? "chevron-down" : "chevron-right"} size="sm" />
    <span class="c-steps-label">${text}</span>
  </button>`;
}

/** 手順の一覧（文字列の配列。1 つを 1 つの項目に） */
export function StepList({ steps }) {
  return html`<ol class="c-steps-list">${steps.map((step) => html`<li>${step}</li>`)}</ol>`;
}

/** 実行中の行（吹き出しにしない）。文が 1 秒ごとに変わるので aria-live・role=status を付けない */
export function RunLine({ run, on }) {
  return html`<div class="c-run" role="group" aria-label="作業中" aria-busy="true">
    ${run.name ? html`<span class="c-msg-name">${run.name}</span>` : null}
    <div class="c-run-line"><span class="c-run-spin" aria-hidden="true"></span><span class="c-run-text">${run.text}</span></div>
    ${run.waiting ? html`<p class="c-run-waiting">${run.waiting}</p>` : null}
    <ol class="c-run-recent">${run.recent.map((item) => html`<li data-current=${item.current ? "true" : undefined}>${item.text}</li>`)}</ol>
    ${run.all ? html`<${Steps} text=${run.all.label} tone="muted" toggles=${true} open=${run.all.open} onToggle=${() => on.toggleRunSteps()} />` : null}
    ${run.all && run.all.open ? html`<${StepList} steps=${run.all.steps} />` : null}
    ${run.stop ? html`<div class="c-run-actions"><${Button} kind="secondary" size="sm" icon="square" label="中断" busy=${run.stop.busy} onPress=${() => on.stop()} /></div>` : null}
  </div>`;
}

/** 箇条書き（入れ子は children の 1 段） */
function MdList({ list }) {
  const items = list.items.map((item) => html`<li><${Inline} text=${item.text} />${item.children ? html`<${MdList} list=${item.children} />` : null}</li>`);
  if (list.ordered) return html`<ol class="c-md-list" start=${list.start}>${items}</ol>`;
  return html`<ul class="c-md-list">${items}</ul>`;
}

/** 本文のブロック。plain はオーナーの発言（解析しない）。見出しは見出しのタグにせず段落の字で、コードの段は pre だけ。知らない type は段落として text を出す */
export function Blocks({ blocks }) {
  return html`<div class="c-md">
    ${blocks.map((block) => {
      if (block.type === "plain") return html`<p class="c-md-p" data-plain="true">${textOr(block.text)}</p>`;
      if (block.type === "paragraph") return html`<p class="c-md-p"><${Inline} text=${block.text} /></p>`;
      if (block.type === "heading") return html`<p class="c-md-h"><${Inline} text=${block.text} /></p>`;
      if (block.type === "code") return html`<pre class="c-md-pre">${textOr(block.text)}</pre>`;
      if (block.type === "list") return html`<${MdList} list=${block} />`;
      return html`<p class="c-md-p">${textOr(block.text)}</p>`;
    })}
  </div>`;
}

/** リンク（href と文字は同じ URL） */
function Link({ url }) {
  return html`<a class="c-md-link" href=${url} target="_blank" rel="noreferrer noopener">${url}</a>`;
}

/** 1 行の中の記法（文字・太字・行の中のコード・リンク）。太字の中の URL もリンクにする */
export function Inline({ text }) {
  return parseInline(textOr(text)).map((part) => {
    if (part.type === "strong") return html`<strong>${splitLinks(part.text).map((p) => (p.type === "link" ? html`<${Link} url=${p.text} />` : p.text))}</strong>`;
    if (part.type === "code") return html`<code class="c-md-code">${part.text}</code>`;
    if (part.type === "link") return html`<${Link} url=${part.text} />`;
    return part.text;
  });
}
