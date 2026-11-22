// 流れの列（docs/plan/web-ui-deck.md §4 の D1）: Deck・DeckBand と、そのモデルの関数（幅の計算・3 つの列の項目）。
// hook を使わない（Node から関数として呼べる）。状態は持たず、入口が deckModel(state) の結果を押し込む。クラスは固定の文字列、状態は data-* と aria-*
import { html } from "./c-lib.js";
import { Badge, Button, Empty, IconButton, Loading, Mark } from "./c-atoms.js";
import { turnWord } from "./c-list.js";

/** 幅の計算の数（設計書 §3。列の 300・席の幅は溝を含む目安）。数は全部ここ */
export const DECK = Object.freeze({ COL_MIN: 300, COL_MAX: 420, SIDE_MIN: 1340, SIDE_REST: 900, SIDE_MAX: 720, FOLD_RATE: 0.48, FOLD_MIN: 440, FOLD_MAX: 600 });

/**
 * width は #v3 の幅、seatOpen は席が開いているか。返す: { cols: 見える列の数 0〜3, side: 列と席が並ぶ幅か, seat: 席の幅, colW: 1 列の幅 }。
 * 席が閉じているときは 1 列は出す。数でない・0 以下の幅は { cols: 1, side: false, seat: 0, colW: 0 }
 */
export function deckFit(width, seatOpen) {
  if (typeof width !== "number" || !Number.isFinite(width) || width <= 0) return { cols: 1, side: false, seat: 0, colW: 0 };
  const side = width >= DECK.SIDE_MIN;
  const seat = !seatOpen
    ? 0
    : side
      ? Math.min(DECK.SIDE_MAX, width - DECK.SIDE_REST)
      : Math.min(DECK.FOLD_MAX, Math.max(DECK.FOLD_MIN, Math.round(width * DECK.FOLD_RATE)));
  const room = width - seat;
  let cols = room < DECK.COL_MIN ? 0 : Math.min(3, Math.floor(room / DECK.COL_MIN));
  if (!seatOpen && cols < 1) cols = 1;
  const colW = cols === 0 ? 0 : Math.min(DECK.COL_MAX, Math.floor(room / cols));
  return { cols, side, seat, colW };
}

const filled = (v) => typeof v === "string" && v !== "";

/** 印の読み上げの語（none は読み上げない） */
const MARK_LABEL = Object.freeze({ turn: "あなたの番", running: "作業中", unread: "未読" });

/** 期限の語（期限切れ・今日、ほかは「タスク」。期限の日付は右の時刻の所にだけ出す） */
function dueWord(task, state) {
  const due = task && typeof task.due === "string" && task.due !== "" ? task.due : null;
  if (due === null) return "タスク";
  if (filled(state.today) && due < state.today) return "期限切れ";
  if (filled(state.today) && due === state.today) return "今日";
  return "タスク";
}

/** 種類の語。src は元の物（タスクのときだけ見る）、state は期限の語に使う。知らない種類は あなたの番 の語（turnWord） */
export function itemWord(kind, src, state) {
  switch (kind) {
    case "running":
      return "動いている";
    case "task":
      return dueWord(src, state);
    case "reminder":
      return "リマインド";
    case "pr":
      return "PR";
    case "issue":
      return "Issue";
    case "github":
      return "GitHub";
    case "notice":
      return "知らせ";
    case "reply":
      return "返事";
    default:
      return turnWord(kind);
  }
}

/** 項目の形を揃える（ops は state.ops が true のときだけ。タスクと GitHub の通知） */
function flowItem(state, o) {
  const target = filled(o.target) ? o.target : null;
  return {
    key: o.key,
    kind: o.kind,
    word: o.word,
    place: filled(o.place) ? o.place : "",
    time: filled(o.time) ? o.time : "",
    at: filled(o.at) ? o.at : null,
    title: typeof o.title === "string" ? o.title : String(o.title ?? ""),
    summary: filled(o.summary) ? o.summary : "",
    mark: o.mark,
    turn: o.turn === true,
    target,
    href: target === null && filled(o.href) ? o.href : null,
    ops: state.ops === true && Array.isArray(o.ops) ? o.ops : [],
    current: target !== null && state.current === target,
  };
}

const topicsOf = (state) => (state.topics && Array.isArray(state.topics.topics) ? state.topics.topics : []);
const groupName = (state, key) => {
  const groups = state.topics && Array.isArray(state.topics.groups) ? state.topics.groups : [];
  const g = groups.find((x) => x.key === key);
  return g ? g.name : "";
};

/** あなたの番（turnIds の順。話題か右腕。引けない id は捨てる。c-list.js の turnItem と同じ引き方） */
export function turnItems(state) {
  const data = state.topics;
  if (!data) return [];
  const ids = Array.isArray(data.turnIds) ? [...new Set(data.turnIds)] : [];
  const hands = Array.isArray(data.rightHands) ? data.rightHands : [];
  const out = [];
  for (const id of ids) {
    const topic = topicsOf(state).find((t) => t.id === id && t.turn);
    const hand = topic ? null : hands.find((h) => h.id === id && h.turn);
    const src = topic || hand;
    if (!src) continue;
    const kind = typeof src.turn.kind === "string" ? src.turn.kind : "";
    out.push(
      flowItem(state, {
        key: "turn:" + id,
        kind,
        word: itemWord(kind, src, state),
        place: topic ? groupName(state, topic.group) : "",
        time: src.turn.since ? state.ago(src.turn.since) : "",
        at: src.turn.since,
        title: topic ? topic.title : "右腕",
        summary: src.turn.summary,
        mark: "turn",
        turn: true,
        target: id,
      }),
    );
  }
  return out;
}

const atMs = (at) => {
  const ms = typeof at === "string" ? Date.parse(at) : NaN;
  return Number.isFinite(ms) ? ms : null;
};

/** 新しい順（時刻の無い物は最後。同じ時刻は元の順） */
function byNewest(a, b) {
  const x = atMs(a.at);
  const y = atMs(b.at);
  if (x === null || y === null) return x === null ? (y === null ? 0 : 1) : -1;
  return y - x;
}

/** 押してから応答までの項目か（state.busy は key の配列。flows.js の busy） */
const isBusy = (state, key) => Array.isArray(state.busy) && state.busy.includes(key);

/** [対応] を押せない理由（views.js の githubActButton の 2 文。連携の有無で選ぶ） */
export const ACT_REASON = Object.freeze({
  item: "この通知は対応できません。この機械に無いリポジトリか、[対応] を足す前の通知です",
  off: "Claude Code の連携が無効です（設定で有効にできます）",
});

/** 動いている話題（あなたの番の無い物）。activityAt の新しい順 */
export function runningItems(state) {
  return topicsOf(state)
    .filter((t) => t.mark === "running" && !t.turn && t.state !== "done")
    .map((t) =>
      flowItem(state, {
        key: "run:" + t.id,
        kind: "running",
        word: itemWord("running", t, state),
        place: groupName(state, t.group),
        time: t.activityAt ? state.time(t.activityAt) : "",
        at: t.activityAt,
        title: t.title,
        mark: "running",
        target: t.id,
      }),
    )
    .sort(byNewest);
}

/** 期限の並びの段（期限切れ 0・今日 1・ほかの期限 2・期限なし 3） */
function dueRank(task, today) {
  if (!filled(task.due)) return 3;
  if (filled(today) && task.due < today) return 0;
  if (filled(today) && task.due === today) return 1;
  return 2;
}

/** タスク（open）。期限切れ → 今日 → 期限の昇順 → 期限なし。同じ期限は元の順 */
export function taskItems(state) {
  const tasks = Array.isArray(state.tasks) ? state.tasks : [];
  return tasks
    .map((t, i) => ({ t, i, rank: dueRank(t, state.today) }))
    .sort((a, b) => a.rank - b.rank || (a.rank < 3 && a.t.due !== b.t.due ? (a.t.due < b.t.due ? -1 : 1) : 0) || a.i - b.i)
    .map(({ t }) =>
      flowItem(state, {
        key: "task:" + t.id,
        kind: "task",
        word: itemWord("task", t, state),
        time: filled(t.due) ? state.day(t.due) : "",
        at: t.due,
        title: t.title,
        mark: "none",
        ops: [{ id: "complete", label: "完了", name: "「" + t.title + "」を完了にする", disabled: isBusy(state, "task:" + t.id), busy: isBusy(state, "task:" + t.id), reason: null }],
      }),
    );
}

/** リマインド。nextAt の昇順（無い物は最後。同じ時刻は元の順） */
export function reminderItems(state) {
  const list = Array.isArray(state.reminders) ? state.reminders : [];
  return list
    .map((r, i) => ({ r, i, ms: atMs(r.nextAt) }))
    .sort((a, b) => (a.ms === null || b.ms === null ? (a.ms === null ? (b.ms === null ? 0 : 1) : -1) : a.ms - b.ms) || a.i - b.i)
    .map(({ r }) =>
      flowItem(state, {
        key: "rem:" + r.id,
        kind: "reminder",
        word: itemWord("reminder", r, state),
        time: r.nextAt ? state.time(r.nextAt) : "",
        at: r.nextAt,
        title: state.oneLine(r.text),
        mark: "none",
      }),
    );
}

/** 通知の列に出す数 */
export const FEED_MAX = 50;
const DISCORD_LINK = "https://discord.com/channels/";

/** GitHub の通知の種類（URL の /pull/・/issues/） */
function githubKind(url) {
  if (typeof url !== "string") return "github";
  if (url.includes("/pull/")) return "pr";
  if (url.includes("/issues/")) return "issue";
  return "github";
}

/**
 * 通知: GitHub（state.github が配列のとき）・知らせ・未読の話題（印の無い ch: の話題で isUnread の物）を、時刻の新しい順に混ぜる。
 * 同じ時刻は GitHub → 知らせ → 話題。時刻の無い物は最後。上から FEED_MAX 件
 */
export function feedItems(state) {
  const all = [];
  if (Array.isArray(state.github)) {
    for (const n of state.github) {
      const parts = state.parts(n.url);
      const kind = githubKind(n.url);
      const busy = isBusy(state, "gh:" + n.id);
      all.push({
        src: 0,
        item: flowItem(state, {
          key: "gh:" + n.id,
          kind,
          word: itemWord(kind, n, state),
          place: parts ? parts.repo : "",
          time: n.updatedAt ? state.time(n.updatedAt) : "",
          at: n.updatedAt,
          title: (filled(n.label) ? n.label + ": " : "") + (filled(n.title) ? n.title : "（題名なし）") + (parts && parts.number ? " #" + parts.number : ""),
          mark: "none",
          href: typeof n.url === "string" && n.url.startsWith("https://") ? n.url : null,
          ops: [{ id: "act", label: "対応", name: null, disabled: !n.handoff || busy, busy, reason: n.handoff ? null : state.handoff ? ACT_REASON.item : ACT_REASON.off }],
        }),
      });
    }
  }
  if (Array.isArray(state.notices)) {
    state.notices.forEach((n, i) => {
      all.push({
        src: 1,
        item: flowItem(state, {
          key: "notice:" + n.at + ":" + i,
          kind: "notice",
          word: itemWord("notice", n, state),
          time: n.at ? state.time(n.at) : "",
          at: n.at,
          title: String(n.text ?? ""),
          mark: "none",
          href: typeof n.link === "string" && n.link.startsWith(DISCORD_LINK) ? n.link : null,
        }),
      });
    });
  }
  for (const t of topicsOf(state)) {
    if (t.mark !== null || t.state === "done" || typeof t.id !== "string" || !t.id.startsWith("ch:")) continue;
    if (!state.isUnread(t.id.slice(3), t.last)) continue;
    all.push({
      src: 2,
      item: flowItem(state, {
        key: "topic:" + t.id,
        kind: "reply",
        word: itemWord("reply", t, state),
        place: groupName(state, t.group),
        time: t.activityAt ? state.time(t.activityAt) : "",
        at: t.activityAt,
        title: t.title,
        mark: "unread",
        target: t.id,
      }),
    });
  }
  return all
    .map((e, i) => ({ ...e, i }))
    .sort((a, b) => {
      const x = atMs(a.item.at);
      const y = atMs(b.item.at);
      if (x === null || y === null) return (x === null ? 1 : 0) - (y === null ? 1 : 0) || a.src - b.src || a.i - b.i;
      return y - x || a.src - b.src || a.i - b.i;
    })
    .slice(0, FEED_MAX)
    .map((e) => e.item);
}

/** 焦点の行き先に数える項目の key（entries は列の項目の { key, pressable }。押せる物（ボタン・リンク）を持たない項目は数えない） */
export function pressableKeys(entries) {
  return entries.filter((e) => e.pressable === true && typeof e.key === "string").map((e) => e.key);
}

/**
 * 焦点のあった項目（key）の描き直しの後の行き先の key。before・after はその列の項目の key の並び（描き直しの前と後）。
 * key が残っていれば key、消えていれば同じ並びの位置に来た項目（無ければ列の最後）、列が空なら null
 */
export function focusAfter(before, after, key) {
  if (after.includes(key)) return key;
  if (after.length === 0) return null;
  const i = before.indexOf(key);
  return after[Math.min(Math.max(i, 0), after.length - 1)];
}

/** 3 つの列のモデル。cols は見える列の数（0〜3。既定 3）。空の節は出さない */
export function deckModel(state) {
  const cols = typeof state.cols === "number" && Number.isFinite(state.cols) ? Math.max(0, Math.min(3, Math.floor(state.cols))) : 3;
  const sections = (list) => list.filter((s) => s.items.length > 0);
  const turns = state.topics ? turnItems(state) : [];
  const tasks = taskItems(state);
  return {
    cols,
    columns: [
      {
        id: "turn",
        name: "あなたの番",
        count: turns.length,
        tone: "warning",
        phase: state.topics ? "ready" : "loading",
        empty: "今は待たせている事がありません",
        sections: state.topics ? sections([{ label: null, items: turns }, { label: "動いている", items: runningItems(state) }]) : [],
      },
      {
        id: "tasks",
        name: "タスク",
        count: tasks.length,
        tone: "none",
        phase: state.tasks == null && state.reminders == null ? "loading" : "ready",
        empty: "タスクとリマインドはありません",
        sections: sections([{ label: null, items: tasks }, { label: "リマインド", items: reminderItems(state) }]),
      },
      {
        id: "feed",
        name: "通知",
        count: null,
        tone: "none",
        phase: state.notices == null ? "loading" : "ready",
        empty: "通知はありません",
        sections: state.notices == null ? [] : sections([{ label: null, items: feedItems(state) }]),
      },
    ],
  };
}

// ===== 部品 =====

/** 3 つの列（見えない列も描き、横に送る）。on: { open(item, key), op(item, opId) } */
export function Deck({ model, on }) {
  return html`<div class="c-deck" data-cols=${String(model.cols)}>
    ${model.columns.map((col) => html`<${Column} key=${col.id} col=${col} on=${on} />`)}
  </div>`;
}

/** 1 本の列。見出し（名前と数）と、縦に送る本体（同じ要素を使い回すので縦の位置が残る） */
export function Column({ col, on }) {
  const counted = typeof col.count === "number" && col.count > 0;
  const label = counted ? col.name + " " + col.count + " 件" : col.name;
  let body;
  if (col.phase === "loading") body = html`<${Loading} key="loading" />`;
  else if (col.sections.length === 0) body = html`<${Empty} key="empty" text=${col.empty} />`;
  else
    body = col.sections.flatMap((s, i) => [
      s.label ? html`<p class="c-col-label" key=${"label:" + i}>${s.label}</p>` : null,
      ...s.items.map((item) => html`<${Item} key=${item.key} item=${item} on=${on} />`),
    ]);
  return html`<section class="c-col" data-col=${col.id} aria-label=${label}>
    <header class="c-col-head">
      <h2 class="c-col-name">${col.name}</h2>
      ${counted ? (col.tone === "warning" ? html`<${Badge} count=${col.count} tone="warning" />` : html`<span class="c-col-count">${col.count}</span>`) : null}
    </header>
    <div class="c-col-body" role="list">${body}</div>
  </section>`;
}

/** 押しっぱなしで繰り返す鍵（Enter・Space） */
const REPEAT_KEYS = Object.freeze(["Enter", " "]);
/** 操作のボタン（［完了］・［対応］）。開くボタン・リンクは含めない */
const OP_BUTTON = ".c-item-meta .c-iconbtn, .c-item-ops .c-btn";

/**
 * 項目の入れ物の keydown: 操作のボタンから来た繰り返し（repeat）の Enter・Space は押さない（完了の後に焦点が次の［完了］へ移るので、押しっぱなしで次々に完了にしない）。
 * 開くボタン・リンクと、繰り返しでない keydown はそのまま
 */
export function holdRepeat(event) {
  if (!event || event.repeat !== true || !REPEAT_KEYS.includes(event.key)) return;
  const from = event.target;
  if (from && typeof from.closest === "function" && from.closest(OP_BUTTON)) event.preventDefault();
}

/**
 * 1 つの項目。席に開ける物（target）はボタン、外へのリンクだけの物は項目ごとリンク（新しいタブ）、どちらでもなければ押せない。
 * 操作（ops）は開くボタン・リンクの中に入れない: 完了は押せない項目（div）の頭の印の場所、ほかは項目の中の兄弟の .c-item-ops
 */
export function Item({ item, on }) {
  const head = [item.word, item.place].filter(filled).join("・");
  const done = item.target === null && !item.href ? item.ops.find((op) => op.id === "complete") : undefined;
  const rest = item.ops.filter((op) => op !== done);
  const inner = [
    html`<span class="c-item-meta" key="meta">
      ${done
        ? html`<${IconButton} icon="circle" size="sm" label=${done.name} disabled=${done.disabled} reason=${done.reason || undefined} onPress=${() => on.op(item, done.id)} />`
        : html`<${Mark} state=${item.mark} label=${MARK_LABEL[item.mark]} />`}
      <span class="c-item-word">${head}</span>
      ${item.time ? html`<span class="c-item-time">${item.time}</span>` : null}
    </span>`,
    html`<span class="c-item-title" key="title">${item.title}</span>`,
    item.summary ? html`<span class="c-item-sum" key="sum">${item.summary}</span>` : null,
  ];
  return html`<div class="c-item" role="listitem" data-key=${item.key} data-kind=${item.kind} data-turn=${item.turn ? "true" : undefined}
      data-current=${item.current ? "true" : undefined} onKeyDown=${item.ops.length > 0 ? holdRepeat : undefined}>
    ${item.target !== null
      ? html`<button class="c-item-main" type="button" aria-current=${item.current ? "true" : undefined} onClick=${() => on.open(item, item.key)}>${inner}</button>`
      : item.href
        ? html`<a class="c-item-link" href=${item.href} target="_blank" rel="noreferrer noopener">${inner}</a>`
        : html`<div class="c-item-main">${inner}</div>`}
    ${rest.length > 0
      ? html`<div class="c-item-ops">
          ${rest.map(
            (op) =>
              html`<${Button} key=${op.id} size="sm" label=${op.label} name=${op.name || undefined} disabled=${op.disabled} busy=${op.busy}
                reason=${op.reason || undefined} onPress=${() => on.op(item, op.id)} />`,
          )}
        </div>`
      : null}
  </div>`;
}

/** 右腕のボタンの読み上げの名前（印があれば語で足す） */
function bandHandName(mark) {
  return mark === "turn" || mark === "unread" ? "右腕（" + MARK_LABEL[mark] + "）" : undefined;
}

/**
 * 上の帯。conn は { tone: "ok"|"bad", label } か null（状態をまだ読めていない）、hand は { mark, open }、controls は右腕のボタンの aria-controls。
 * on: { status(), find(opener), hand(opener), start(opener), more(opener) }
 */
export function DeckBand({ conn, hand, controls, on }) {
  const mark = hand && (hand.mark === "turn" || hand.mark === "unread") ? hand.mark : null;
  return html`<header class="c-band">
    ${conn
      ? html`<button class="c-band-conn" key="conn" type="button" data-act="status" aria-label=${conn.label} title=${conn.label} onClick=${() => on.status()}>
          <span class="c-band-dot" data-tone=${conn.tone === "ok" ? "ok" : "bad"} aria-hidden="true"></span>
        </button>`
      : null}
    <span class="c-band-name" key="name">self-agent</span>
    <span class="c-band-ops" key="ops">
      <span class="c-band-act" data-act="find"><${Button} kind="ghost" size="sm" icon="search" label="探す" onPress=${(event) => on.find(event.currentTarget)} /></span>
      <button class="c-band-hand" type="button" data-act="hand" aria-label=${bandHandName(mark)} aria-controls=${filled(controls) ? controls : undefined}
          aria-expanded=${hand && hand.open ? "true" : "false"} onClick=${(event) => on.hand(event.currentTarget)}>
        <span class="c-band-hand-label">右腕</span>
        ${mark ? html`<span class="c-band-hand-mark" data-state=${mark} aria-hidden="true"></span>` : null}
      </button>
      <span class="c-band-act" data-act="start"><${Button} kind="ghost" size="sm" icon="plus" label="始める" onPress=${(event) => on.start(event.currentTarget)} /></span>
      <span class="c-band-act" data-act="more"><${IconButton} icon="settings" label="ほか" onPress=${(event) => on.more(event.currentTarget)} /></span>
    </span>
  </header>`;
}
