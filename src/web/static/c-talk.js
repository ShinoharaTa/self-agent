// 会話の行の部品（docs/plan/web-ui-components.md §6 の K4）: TalkTimeline・TalkRows・Bubble・Refs・Steps・StepList・RunLine・Notice・Divider・Blocks・Inline と、
// そのモデルの関数（talkModel・footOf・refsOf）と返事の最小限の Markdown の解析、会話の口（talkMouth）。hook を使わない（Node から関数として呼べる）。状態は持たず、
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

/** 札の並び（返事の <#ID>）。並びでなければ []。id・title が空でない文字列の物だけを { id, title, meta } に（meta は文字列でなければ ""）。同じ id は先の 1 つだけ（札の key にする）。数は絞らない */
export function refsOf(list) {
  if (!Array.isArray(list)) return [];
  const out = [];
  const seen = new Set();
  for (const ref of list) {
    if (!ref || typeof ref.id !== "string" || ref.id === "" || typeof ref.title !== "string" || ref.title === "" || seen.has(ref.id)) continue;
    seen.add(ref.id);
    out.push({ id: ref.id, title: ref.title, meta: typeof ref.meta === "string" ? ref.meta : "" });
  }
  return out;
}

/**
 * 会話の行のモデル。{ older, items, running }。openSteps は key（行の id を文字列にした物）の Set。state.on は読まない（TalkTimeline の prop で渡す）。
 * continueKey の返事の行にだけ act: { busy }（busy は continueBusy が true のとき）。ほかの行には act の欄を置かない。
 * Bot の返事の行だけ: fmt.reply が関数なら解析する本文をその結果にし（文字列でない物が返れば元の本文のまま）、fmt.refs が関数なら（差し替える前の本文から）札を取り、
 * 1 つ以上在るときだけ返事のすぐ後ろに { kind: "refs", key: key + ":refs", refs } の行を足す
 */
export function talkModel(state, parse) {
  const fmt = state.fmt;
  const turns = Array.isArray(state.turns) ? state.turns : [];
  const openSteps = state.openSteps;
  const reply = typeof fmt.reply === "function" ? fmt.reply : null;
  const refsFn = typeof fmt.refs === "function" ? fmt.refs : null;
  const items = turns.flatMap((turn, i) => {
    const prev = i > 0 ? turns[i - 1] : null;
    const key = String(turn.id);
    const text = textOr(turn.text);
    if (turn.kind === "divider") return [{ kind: "divider", key, text }];
    if (turn.kind === "notice") return [{ kind: "notice", key, text, time: fmt.time(turn) }];
    const time = fmt.time(turn);
    const label = fmt.label(turn);
    if (turn.kind === "owner") {
      return [{ kind: "bubble", key, who: "owner", label, name: null, blocks: [{ type: "plain", text }], time, state: turn.optimistic === true ? "sending" : null, foot: null }];
    }
    const open = openSteps ? openSteps.has(key) : false;
    const shown = reply ? reply(text) : text;
    const row = {
      kind: "bubble",
      key,
      who: "agent",
      label,
      name: fmt.name(turn, prev),
      blocks: parse(typeof shown === "string" ? shown : text),
      time,
      state: null,
      foot: hasOutcome(turn) ? footOf(turn, open, fmt.end(turn)) : null,
    };
    if (state.continueKey === key) row.act = { busy: state.continueBusy === true };
    const refs = refsFn ? refsOf(refsFn(text)) : [];
    return refs.length > 0 ? [row, { kind: "refs", key: key + ":refs", refs }] : [row];
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

/**
 * 会話の行の根。on: { older(), toggleSteps(key), toggleRunSteps(), stop(), continue(key) }。
 * rows（TalkRows の vnode）を渡せばそれを置き、model.older・model.items を見ない（1 秒ごとは同じ rows を渡して実行中の行だけを描く）
 */
export function TalkTimeline({ model, on, rows }) {
  return html`<div class="c-talk">
    ${rows !== undefined ? rows : html`<${TalkRows} key="rows" older=${model.older} items=${model.items} on=${on} />`}
    ${model.running ? html`<${RunLine} key="run" run=${model.running} on=${on} />` : null}
  </div>`;
}

/** 「前の会話を読む」と行（要素で包まず、配列を返す）。on は押されたときに今の状態を読む物を渡す（作ったときの物を持ち続けるため）。行の［続ける］は on.continue(key)、札の［開く］は on.ref(id)（無ければ何もしない） */
export function TalkRows({ older, items, on }) {
  return [
    older ? html`<div class="c-talk-older" key="older"><${Button} kind="ghost" size="sm" label="前の会話を読む" onPress=${() => on.older()} /></div>` : null,
    ...items.map((item) => {
      if (item.kind === "divider") return html`<${Divider} key=${item.key} text=${item.text} />`;
      if (item.kind === "notice") return html`<${Notice} key=${item.key} text=${item.text} time=${item.time} />`;
      if (item.kind === "refs") {
        return html`<${Refs} key=${item.key} refs=${item.refs} onOpen=${(id) => {
          if (on.ref) on.ref(id);
        }} />`;
      }
      return html`<${Bubble} key=${item.key} ...${item} onToggle=${() => on.toggleSteps(item.key)} onAct=${() => on.continue(item.key)} />`;
    }),
  ];
}

/** 解析の覚えの数の上限（越えたら空にしてから入れる） */
const PARSE_MEMO_MAX = 400;

/**
 * 会話の口（入口が 1 回だけ呼ぶ。render は c-lib の render を渡す）。{ draw(root, state), tick(root, state), drop(root) }。
 * draw は行を作り直して覚え、tick は覚えた行の vnode をそのまま渡して実行中の行だけを描く（モデルも実行中の行の分だけ作る。覚えが無ければ draw と同じ）。
 * 例外は握らない（握るのは入口）
 */
export function talkMouth(render) {
  const parsed = new Map();
  const parse = (text) => {
    if (parsed.has(text)) return parsed.get(text);
    if (parsed.size >= PARSE_MEMO_MAX) parsed.clear();
    const blocks = parseBlocks(text);
    parsed.set(text, blocks);
    return blocks;
  };
  const rowsOf = new WeakMap();
  const paint = (root, model, on, rows) => {
    try {
      render(html`<${TalkTimeline} model=${model} on=${on} rows=${rows} />`, root);
    } catch (error) {
      rowsOf.delete(root);
      throw error;
    }
  };
  const draw = (root, state) => {
    const model = talkModel(state, parse);
    const rows = html`<${TalkRows} key="rows" older=${model.older} items=${model.items} on=${state.on} />`;
    rowsOf.set(root, rows);
    paint(root, model, state.on, rows);
  };
  const tick = (root, state) => {
    const rows = rowsOf.get(root);
    if (rows === undefined) {
      draw(root, state);
      return;
    }
    // 行は覚えた物を使うので、作るのは実行中の行のモデルだけ（行ごとの文の関数と解析を呼ばない）
    const turns = Array.isArray(state.turns) ? state.turns : [];
    paint(root, { older: false, items: [], running: state.running ? runModel(state, turns) : null }, state.on, rows);
  };
  const drop = (root) => {
    rowsOf.delete(root);
    render(null, root);
  };
  return { draw, tick, drop };
}

/** 区切り（文字をそのまま。中に要素を作らない） */
export function Divider({ text }) {
  return html`<div class="c-divider" role="separator">${text}</div>`;
}

/** 知らせ（文字をそのまま。時刻だけ包む） */
export function Notice({ text, time }) {
  return html`<div class="c-notice">${text}${typeof time === "string" && time !== "" ? html`<span class="c-notice-time">${time}</span>` : null}</div>`;
}

/** 吹き出し。結果の文と手順は吹き出しの外（.c-msg-foot と、その下の一覧）。act があれば行の一番下に［続ける］（押すと onAct） */
export function Bubble({ who, label, name, blocks, time, state, foot, act, onToggle, onAct }) {
  const sending = state === "sending";
  return html`<article class="c-msg" data-who=${who} data-state=${sending ? "sending" : undefined} aria-label=${label}>
    ${name ? html`<span class="c-msg-name">${name}</span>` : null}
    <div class="c-bubble"><${Blocks} blocks=${blocks} /></div>
    <div class="c-msg-foot">
      <span class="c-msg-time">${sending ? "送っています…" : time}</span>
      ${foot ? html`<${Steps} text=${foot.text} tone=${foot.tone} toggles=${Array.isArray(foot.steps)} open=${foot.open} onToggle=${onToggle} />` : null}
    </div>
    ${foot && foot.open && Array.isArray(foot.steps) ? html`<${StepList} steps=${foot.steps} />` : null}
    ${act ? html`<div class="c-msg-act"><${Button} kind="secondary" size="sm" icon="play" label="続ける" busy=${act.busy} onPress=${() => onAct()} /></div>` : null}
  </article>`;
}

/** 札（返事の <#ID>）。札ごとに題・meta（空なら出さない）・［開く］（押すと onOpen(id)。読み上げの名前は「<題> を開く」）。状態は持たない */
export function Refs({ refs, onOpen }) {
  return html`<div class="c-refs">
    ${refs.map(
      (ref) => html`<div class="c-ref" key=${ref.id}>
        <span class="c-ref-title">${ref.title}</span>
        ${ref.meta !== "" ? html`<span class="c-ref-meta">${ref.meta}</span>` : null}
        <${Button} kind="ghost" size="sm" label="開く" name=${ref.title + " を開く"} onPress=${() => onOpen(ref.id)} />
      </div>`,
    )}
  </div>`;
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
