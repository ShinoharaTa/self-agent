// 流れの列（docs/plan/web-ui-deck.md §4 の D1）: Deck・DeckBand と、そのモデルの関数（幅の計算・3 つの列の項目）。
// hook を使わない（Node から関数として呼べる）。状態は持たず、入口が deckModel(state) の結果を押し込む。クラスは固定の文字列、状態は data-* と aria-*
// あなたの番の列の「動いている」の下に、既読で動いていない話題の節「待機」（新しい順に IDLE_MAX 件。残りは「ほか n 件」で on.more。#505）
// 番の下に、留めた話題（番の無い物）の節「ピン留め」（留めた順。その話題は「動いている」「待機」に出さない。#507）
// state.handRow の間だけ、あなたの番の列の見出しの下に右腕の行（handItem。送られない）を出し、右腕の番は番の項目にしない（docs/plan/web-ui-hand-row.md の R1。#514）
import { html } from "./c-lib.js";
import { Badge, Button, Empty, IconButton, Loading, Mark } from "./c-atoms.js";
import { HAND_NONE, rowModel, turnWord } from "./c-list.js";

/** 幅の計算の数（設計書 §3。列の 300・席の幅は溝を含む目安）。数は全部ここ */
/** 会話の列の幅 CONV・列の間 GAP・帯の右の丸の通り道 LANE・留められる数 PIN_MAX は、留めた話題の会話の列の物（docs/plan/web-ui-pins.md §4.2。#507） */
export const DECK = Object.freeze({ COL_MIN: 300, COL_MAX: 420, SIDE_MIN: 1340, SIDE_REST: 900, SIDE_MAX: 720, FOLD_RATE: 0.48, FOLD_MIN: 440, FOLD_MAX: 600, CONV: 420, GAP: 8, LANE: 80, PIN_MAX: 4 });

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

/**
 * 帯（流れの列と留めた会話の列を 1 本に並べて横に送る所。#507）の幅。留めた数が 1 以上の時だけ使う。width・seatOpen は deckFit と同じ。
 * 返す: { show: 帯を出すか, seat: 席の幅, room: 帯の見える幅（width − 席 − 席との間 − 丸の通り道）, colW: 流れの列の幅, convW: 会話の列の幅 }。
 * 数でない・0 以下の幅、席だけの幅（deckFit の cols が 0）、見える幅が 0 の時は show: false
 */
export function stripFit(width, seatOpen) {
  if (typeof width !== "number" || !Number.isFinite(width) || width <= 0) return { show: false, seat: 0, room: 0, colW: 0, convW: 0 };
  const f = deckFit(width, seatOpen);
  if (f.cols === 0) return { show: false, seat: f.seat, room: 0, colW: 0, convW: 0 };
  const room = Math.max(0, width - f.seat - (f.seat > 0 ? DECK.GAP : 0) - DECK.LANE);
  if (room === 0) return { show: false, seat: f.seat, room: 0, colW: 0, convW: 0 };
  return { show: true, seat: f.seat, room, colW: Math.min(DECK.COL_MIN, room), convW: Math.min(DECK.CONV, room) };
}

const finite = (v) => typeof v === "number" && Number.isFinite(v);

/**
 * 帯の中で端まで見えている列の id（cols の順。#507）。view は { left, width }（帯の送りの位置と見える幅）、cols は [{ id, x, w }]（帯の中の位置と幅）。
 * 左端 x ≥ left − slack かつ右端 x + w ≤ left + width + slack の列。迷えば見えていない側に倒す: view・cols が壊れている・見える幅が 0 以下・slack が 0 以上の有限の数でなければ []、
 * x・w が有限の数でない列と幅が 0 以下の列は捨てる
 */
export function stripSeen(view, cols, slack = 1) {
  if (view === null || typeof view !== "object" || !finite(view.left) || !finite(view.width) || !(view.width > 0) || !Array.isArray(cols)) return [];
  if (!finite(slack) || slack < 0) return [];
  const { left, width } = view;
  return cols.filter((c) => c !== null && typeof c === "object" && finite(c.x) && finite(c.w) && c.w > 0 && c.x >= left - slack && c.x + c.w <= left + width + slack).map((c) => c.id);
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

/** 待機の語を決める rowModel の ctx（未読・時刻・開いている物は見ない） */
const IDLE_CTX = Object.freeze({ isUnread: () => false, time: () => "", current: null });

/**
 * 種類の語。src は元の物（タスク・リマインド・待機の話題のときだけ見る）、state は期限の語に使う。知らない種類は あなたの番 の語（turnWord）。
 * 待機は一覧の行の状態の語（順番待ち・上限で停止・失敗・中断・停止）が在ればそれ、無ければ「待機」（#505）
 */
export function itemWord(kind, src, state) {
  switch (kind) {
    case "running":
      return "動いている";
    case "pin": {
      // 留めた話題: 作業中 → 未読 → 待機の語（順番待ち・上限で停止など）
      if (src && src.mark === "running") return "作業中";
      const unread = typeof state.isUnread === "function" && src && typeof src.id === "string" && state.isUnread(src.id.slice(3), src.last);
      return unread ? "未読" : itemWord("idle", src, state);
    }
    case "idle": {
      const row = src ? rowModel(src, IDLE_CTX) : null;
      return row && row.state ? row.state.text : "待機";
    }
    case "task":
      return dueWord(src, state);
    case "reminder":
      return src && src.kind === "prompt" ? "依頼" : "リマインド";
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

/** 項目の形を揃える（ops は state.ops が true のときだけ。タスク・リマインドと GitHub の通知。opsRow は操作を題の下の行に置く項目（リマインド）） */
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
    opsRow: o.opsRow === true,
    current: target !== null && (state.current === target || seenIds(state).includes(target)),
  };
}

/** 見えている留めた列の話題（タブの ID。ch:<id> の形）。state.seen が配列ならその中の文字列だけ、でなければ空（#507） */
const seenIds = (state) => (Array.isArray(state.seen) ? state.seen.filter((id) => typeof id === "string") : []);

const topicsOf = (state) => (state.topics && Array.isArray(state.topics.topics) ? state.topics.topics : []);
/** 留めた話題の channelId（留めた順。ch: は付かない。文字列でない物と重なりは捨てる（最初の出現の順）。#507） */
const pinIds = (state) => (state.topics && Array.isArray(state.topics.pins) ? [...new Set(state.topics.pins.filter((id) => typeof id === "string"))] : []);
/** 留めた話題か（ch: の話題だけ） */
const isPinned = (state, t) => typeof t.id === "string" && t.id.startsWith("ch:") && pinIds(state).includes(t.id.slice(3));
const groupName = (state, key) => {
  const groups = state.topics && Array.isArray(state.topics.groups) ? state.topics.groups : [];
  const g = groups.find((x) => x.key === key);
  return g ? g.name : "";
};

/** 番の種類・語・待ち始めからの時間・要約（src は turn の在る話題か右腕。turnItems と handItem で同じ） */
function turnParts(src, state) {
  const kind = typeof src.turn.kind === "string" ? src.turn.kind : "";
  return { kind, word: itemWord(kind, src, state), time: src.turn.since ? state.ago(src.turn.since) : "", at: src.turn.since, summary: src.turn.summary };
}

/** 右腕の行に出す右腕（rightHands[0]。無ければ null。サーバーが複数でも選ぶ口は作らない） */
const rowHand = (state) => (state.topics && Array.isArray(state.topics.rightHands) && state.topics.rightHands.length > 0 ? state.topics.rightHands[0] : null);

/** あなたの番（turnIds の順。話題か右腕。引けない id は捨てる。c-list.js の turnItem と同じ引き方）。handRow の間は右腕の行の右腕の番を項目にしない（#514） */
export function turnItems(state) {
  return turnList(state).items;
}

/** turnItems の中身と、右腕の行に回したので項目にしなかった番の数 held（列の数はそれも数える。#514） */
function turnList(state) {
  const data = state.topics;
  if (!data) return { items: [], held: 0 };
  const ids = Array.isArray(data.turnIds) ? [...new Set(data.turnIds)] : [];
  const hands = Array.isArray(data.rightHands) ? data.rightHands : [];
  const row = state.handRow === true ? rowHand(state) : null;
  const out = [];
  let held = 0;
  for (const id of ids) {
    const topic = topicsOf(state).find((t) => t.id === id && t.turn);
    const hand = topic ? null : hands.find((h) => h.id === id && h.turn);
    const src = topic || hand;
    if (!src) continue;
    if (hand && hand === row) {
      held += 1;
      continue;
    }
    const t = turnParts(src, state);
    out.push(
      flowItem(state, {
        key: "turn:" + id,
        kind: t.kind,
        word: t.word,
        place: topic ? groupName(state, topic.group) : "",
        time: t.time,
        at: t.at,
        title: topic ? topic.title : "右腕",
        summary: t.summary,
        mark: "turn",
        turn: true,
        target: id,
      }),
    );
  }
  return { items: out, held };
}

/**
 * 右腕の行の項目（#514。docs/plan/web-ui-hand-row.md §4.2）。話題のデータをまだ読めていなければ null。key は hand:<id>、kind は hand、題は「右腕」。
 * 番なら番の項目と同じ語・時間・要約で mark turn。番でなければ語は 作業中 → 未読 → 待機（節「ピン留め」と同じ itemWord）、要約なし。
 * 印は 未読 → 作業中 の順で、見えている間（current か seen に在る）は出さない。作業中は state.isRunning(チャンネル) が在る時だけ訊く。
 * 右腕がまだ無ければ key hand:none・押せない（target null）・要約は HAND_NONE
 */
export function handItem(state) {
  if (!state.topics) return null;
  const hand = rowHand(state);
  if (!hand || !filled(hand.id)) return flowItem(state, { key: "hand:none", kind: "hand", word: "", title: "右腕", summary: HAND_NONE, mark: "none", target: null });
  const id = hand.id;
  if (hand.turn) {
    const t = turnParts(hand, state);
    return flowItem(state, { key: "hand:" + id, kind: "hand", word: t.word, time: t.time, at: t.at, title: "右腕", summary: t.summary, mark: "turn", turn: true, target: id });
  }
  const seen = state.current === id || seenIds(state).includes(id);
  const channelId = id.startsWith("ch:") ? id.slice(3) : null;
  const unread = channelId !== null && typeof state.isUnread === "function" && state.isUnread(channelId, hand.last) === true;
  const running = channelId !== null && typeof state.isRunning === "function" && state.isRunning(channelId) === true;
  return flowItem(state, {
    key: "hand:" + id,
    kind: "hand",
    // ch: でない右腕は未読・作業中を訊けないので待機の語（#514）
    word: channelId === null ? itemWord("idle", { id, last: hand.last }, state) : itemWord("pin", { id, last: hand.last, mark: running ? "running" : null }, state),
    title: "右腕",
    mark: seen ? "none" : unread ? "unread" : running ? "running" : "none",
    target: id,
  });
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
/** その項目の応答待ちが、押した操作（opId）か（state.busyOp は key → 操作の id。回る印は押した方だけ） */
const isBusyOp = (state, key, opId) => isBusy(state, key) && state.busyOp != null && typeof state.busyOp === "object" && state.busyOp[key] === opId;

/** [対応] を押せない理由（views.js の githubActButton の 2 文。連携の有無で選ぶ） */
export const ACT_REASON = Object.freeze({
  item: "この通知は対応できません。この機械に無いリポジトリか、[対応] を足す前の通知です",
  off: "Claude Code の連携が無効です（設定で有効にできます）",
});

/**
 * 留めた話題（pins の順のまま。並べ替えない）。完了・番の在る話題（番の項目だけに出す）・話題に無い ID は出さない。
 * 印は 作業中 = running、未読 = unread、ほかは none（#507）
 */
export function pinItems(state) {
  const unread = typeof state.isUnread === "function" ? state.isUnread : () => false;
  const out = [];
  for (const channelId of pinIds(state)) {
    const t = topicsOf(state).find((x) => x.id === "ch:" + channelId);
    if (!t || t.state === "done" || t.mark === "turn" || t.turn) continue;
    out.push(
      flowItem(state, {
        key: "pin:" + t.id,
        kind: "pin",
        word: itemWord("pin", t, state),
        place: groupName(state, t.group),
        time: t.activityAt ? state.time(t.activityAt) : "",
        at: t.activityAt,
        title: t.title,
        mark: t.mark === "running" ? "running" : unread(channelId, t.last) ? "unread" : "none",
        target: t.id,
      }),
    );
  }
  return out;
}

/** 動いている話題（あなたの番の無い物・留めていない物）。activityAt の新しい順 */
export function runningItems(state) {
  return topicsOf(state)
    .filter((t) => t.mark === "running" && !t.turn && t.state !== "done" && !isPinned(state, t))
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

/** 待機の節に出す数（残りは「ほか n 件」。#505） */
export const IDLE_MAX = 8;

/**
 * 待機: 印の無い・完了でない ch: の話題で、入口（pinned）でなく未読でない物（未読は通知の列。1 つの話題は 1 か所）。activityAt の新しい順で全部（切るのは deckModel。#505）。
 * 留めた話題（pins）は除く（節「ピン留め」に出す。#507）
 */
export function idleItems(state) {
  const unread = typeof state.isUnread === "function" ? state.isUnread : () => false;
  return topicsOf(state)
    .filter((t) => t.mark === null && t.state !== "done" && typeof t.id === "string" && t.id.startsWith("ch:") && t.pinned !== true && !unread(t.id.slice(3), t.last) && !isPinned(state, t))
    .map((t) =>
      flowItem(state, {
        key: "idle:" + t.id,
        kind: "idle",
        word: itemWord("idle", t, state),
        place: groupName(state, t.group),
        time: t.activityAt ? state.time(t.activityAt) : "",
        at: t.activityAt,
        title: t.title,
        mark: "none",
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

/** 繰り返しのリマインドか（rule が空でない文字列） */
const repeats = (r) => filled(r.rule);

/** リマインドの操作（繰り返しだけ［次を飛ばす］、常に［止める］。どちらかが応答待ちなら 2 つとも押せない） */
function reminderOps(state, r, key, title) {
  const disabled = isBusy(state, key);
  const op = (id, label, name) => ({ id, label, name, kind: "ghost", disabled, busy: disabled && isBusyOp(state, key, id), reason: null });
  return [repeats(r) ? op("skip", "次を飛ばす", "「" + title + "」の次を飛ばす") : null, op("cancel", "止める", "「" + title + "」を止める")].filter((x) => x !== null);
}

/** リマインド。nextAt の昇順（無い物は最後。同じ時刻は元の順）。語は種類（依頼か）、場所の所は繰り返しの文（無ければ「1 回だけ」） */
export function reminderItems(state) {
  const list = Array.isArray(state.reminders) ? state.reminders : [];
  return list
    .map((r, i) => ({ r, i, ms: atMs(r.nextAt) }))
    .sort((a, b) => (a.ms === null || b.ms === null ? (a.ms === null ? (b.ms === null ? 0 : 1) : -1) : a.ms - b.ms) || a.i - b.i)
    .map(({ r }) => {
      const key = "rem:" + r.id;
      const title = state.oneLine(r.text);
      return flowItem(state, {
        key,
        kind: "reminder",
        word: itemWord("reminder", r, state),
        place: repeats(r) ? (filled(r.ruleText) ? r.ruleText : r.rule) : "1 回だけ",
        time: r.nextAt ? state.time(r.nextAt) : "",
        at: r.nextAt,
        title,
        mark: "none",
        opsRow: true,
        ops: reminderOps(state, r, key, title),
      });
    });
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

/**
 * 焦点の行き先に数える項目の key（entries は列の項目の { key, pressable, kind }。押せる物（ボタン・リンク）を持たない項目は数えない）。
 * kind が文字列なら、その種類の項目だけで数える（タスクの列: 最後のタスクを完了にした焦点をリマインドの操作に乗せない）
 */
export function pressableKeys(entries, kind) {
  const only = typeof kind === "string";
  return entries.filter((e) => e.pressable === true && typeof e.key === "string" && (!only || e.kind === kind)).map((e) => e.key);
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

/**
 * 3 つの列のモデル。cols は見える列の数（0〜3。既定 3）。paged（スマホの 1 列ずつの横送り。D2）は true のときだけ。空の節は出さない。
 * あなたの番の列の節は 番・動いている・待機 の順。待機は IDLE_MAX 件までで、残りがあれば more: { count, label }（列の数は番だけ。#505）。
 * 番の次に留めた話題の節「ピン留め」（pinItems。留めた物が無ければ出ないので、pins の無い state の結果は前と同じ。#507）。
 * strip（帯の中の流れの列）は true のときだけ鍵 strip を足し、seen（見えている留めた列のタブの ID）の話題の項目にも current を付ける（#507）。
 * handRow が true のときだけ、あなたの番の列に鍵 top（handItem）を足し、右腕の番を節に出さない。列の数は右腕の番も数える（#514）
 */
export function deckModel(state) {
  const cols = typeof state.cols === "number" && Number.isFinite(state.cols) ? Math.max(0, Math.min(3, Math.floor(state.cols))) : 3;
  const sections = (list) => list.filter((s) => s.items.length > 0);
  const turnsAt = state.topics ? turnList(state) : { items: [], held: 0 };
  const turns = turnsAt.items;
  const idle = state.topics ? idleItems(state) : [];
  const idleRest = idle.length - IDLE_MAX;
  const tasks = taskItems(state);
  return {
    cols,
    paged: state.paged === true,
    // 帯（#507）の中の流れの列か。true の時だけ鍵ごと足す（渡さない今の呼び出しの結果は前と同じ）
    ...(state.strip === true ? { strip: true } : {}),
    columns: [
      {
        id: "turn",
        name: "あなたの番",
        count: turns.length + turnsAt.held,
        tone: "warning",
        phase: state.topics ? "ready" : "loading",
        empty: "今は待たせている事がありません",
        // 右腕の行（#514）。渡さない今の呼び出しの結果は前と同じ
        ...(state.handRow === true ? { top: handItem(state) } : {}),
        sections: state.topics
          ? sections([
              { label: null, items: turns },
              { label: "ピン留め", items: pinItems(state) },
              { label: "動いている", items: runningItems(state) },
              { label: "待機", items: idle.slice(0, IDLE_MAX), more: idleRest > 0 ? { count: idleRest, label: "ほか " + idleRest + " 件" } : null },
            ])
          : [],
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

/** 3 つの列（見えない列も描き、横に送る。paged は 1 列ずつ止まる。strip は帯の中で自分では送らない。#507）。on: { open(item, key), op(item, opId), more(colId) } */
export function Deck({ model, on }) {
  return html`<div class="c-deck" data-cols=${String(model.cols)} data-paged=${model.paged === true ? "true" : undefined} data-strip=${model.strip === true ? "true" : undefined}>
    ${model.columns.map((col) => html`<${Column} key=${col.id} col=${col} on=${on} />`)}
  </div>`;
}

/** 列の数の出し方（列の見出しとスマホの帯の題で同じ）: 数が 1 以上の数のときだけ数を出し、読み上げは「名前 N 件」か名前だけ */
function countLabel(name, count) {
  const counted = typeof count === "number" && count > 0;
  return { counted, label: counted ? name + " " + count + " 件" : name };
}

/**
 * 1 本の列。見出し（名前と数）と、縦に送る本体（同じ要素を使い回すので縦の位置が残る）。節に more があれば項目の後ろに［ほか n 件］（on.more(列の id)。list の子なので listitem で包み、key は節の語（ほかの節が出入りしても作り直さない）。#505）。
 * col.top（右腕の行。#514）が在れば、見出しと本体の間に送られない .c-col-top を置き、中に Item を 1 つ。右腕の行が番で節が空なら空の文を出さない
 */
export function Column({ col, on }) {
  const { counted, label } = countLabel(col.name, col.count);
  let body;
  if (col.phase === "loading") body = html`<${Loading} key="loading" />`;
  // 右腕の行が番の時は、数と食い違うので空の文を出さない（本体は空のまま置く。#514）
  else if (col.sections.length === 0) body = col.top && col.top.turn === true ? null : html`<${Empty} key="empty" text=${col.empty} />`;
  else
    body = col.sections.flatMap((s, i) => [
      s.label ? html`<p class="c-col-label" key=${"label:" + i}>${s.label}</p>` : null,
      ...s.items.map((item) => html`<${Item} key=${item.key} item=${item} on=${on} />`),
      s.more
        ? html`<div role="listitem" key=${"more:" + s.label}>
            <button class="c-col-more" type="button" onClick=${() => on.more && on.more(col.id)}>${s.more.label}</button>
          </div>`
        : null,
    ]);
  // 右腕の行の穴は top が無くても null で残す（top が付く・外れる描き直しで本体が作り直されず、縦の位置と焦点が残る。#514）
  return html`<section class="c-col" data-col=${col.id} aria-label=${label}>
    <header class="c-col-head">
      <h2 class="c-col-name">${col.name}</h2>
      ${counted ? (col.tone === "warning" ? html`<${Badge} count=${col.count} tone="warning" />` : html`<span class="c-col-count">${col.count}</span>`) : null}
    </header>
    ${col.top ? html`<div class="c-col-top" role="list"><${Item} key=${col.top.key} item=${col.top} on=${on} /></div>` : null}
    <div class="c-col-body" role="list">${body}</div>
  </section>`;
}

/** 押しっぱなしで繰り返す鍵（Enter・Space） */
const REPEAT_KEYS = Object.freeze(["Enter", " "]);
/** 操作のボタン（［完了］・［対応］・［次を飛ばす］・［止める］）。開くボタン・リンクは含めない */
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
 * 操作（ops）は開くボタン・リンクの中に入れない: 完了は押せない項目（div）の頭の印の場所、ほかは項目の中の兄弟の .c-item-ops。
 * opsRow の項目（リマインド）は .c-item-ops を題の下の行にする（data-ops="row"。左［次を飛ばす］・右端［止める］）
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
      data-ops=${item.opsRow ? "row" : undefined} data-current=${item.current ? "true" : undefined} onKeyDown=${item.ops.length > 0 ? holdRepeat : undefined}>
    ${item.target !== null
      ? html`<button class="c-item-main" type="button" aria-current=${item.current ? "true" : undefined} onClick=${() => on.open(item, item.key)}>${inner}</button>`
      : item.href
        ? html`<a class="c-item-link" href=${item.href} target="_blank" rel="noreferrer noopener">${inner}</a>`
        : html`<div class="c-item-main">${inner}</div>`}
    ${rest.length > 0
      ? html`<div class="c-item-ops">
          ${rest.map(
            (op) =>
              html`<${Button} key=${op.id} kind=${op.kind || undefined} size="sm" label=${op.label} name=${op.name || undefined} disabled=${op.disabled} busy=${op.busy}
                reason=${op.reason || undefined} onPress=${() => on.op(item, op.id)} />`,
          )}
        </div>`
      : null}
  </div>`;
}

/** 右腕のボタンの印（turn・unread・running。知らない値は null。c-shell の handMarkOf と同じ。c-deck は c-shell を import しない） */
function bandMark(mark) {
  return mark === "turn" || mark === "unread" || mark === "running" ? mark : null;
}

/** 右腕のボタンの読み上げの名前（印があれば語で足す） */
function bandHandName(mark) {
  return bandMark(mark) ? "右腕（" + MARK_LABEL[mark] + "）" : undefined;
}

/**
 * 上の帯。conn は { tone: "ok"|"bad", label } か null（状態をまだ読めていない）、hand は { mark, open } か null、controls は右腕のボタンの aria-controls。
 * variant が phone（スマホ。D2）なら［右腕］を出さず（下のバーの物）、［始める］は字のないボタン。ほかは今の形。hand が無ければ［右腕］を出さない（広い幅の口は右下の丸。D6）。
 * title は { name, count: number|null, tone: "warning"|undefined } か null（今いる列）。phone で name が空でないときだけ「self-agent」の代わりに列の名前と数を出す（列の見出しは出さない）。
 * turn は { count } か null（番の列が見えていない間の あなたの番 の数。#507）。phone でなく count が 1 以上の数のときだけ「self-agent」の代わりにボタン「あなたの番」と数。
 * on: { status(), find(opener), hand(opener), start(opener), more(opener), turn(opener) }
 */
export function DeckBand({ variant, conn, hand, controls, title, turn, on }) {
  const phone = variant === "phone";
  const page = phone && title && filled(title.name) ? title : null;
  const count = page ? countLabel(page.name, page.count) : null;
  const turns = !phone && turn !== null && typeof turn === "object" && typeof turn.count === "number" && turn.count >= 1 ? Math.floor(turn.count) : 0;
  const mark = hand ? bandMark(hand.mark) : null;
  return html`<header class="c-band">
    ${conn
      ? html`<button class="c-band-conn" key="conn" type="button" data-act="status" aria-label=${conn.label} title=${conn.label} onClick=${() => on.status()}>
          <span class="c-band-dot" data-tone=${conn.tone === "ok" ? "ok" : "bad"} aria-hidden="true"></span>
        </button>`
      : null}
    ${page
      ? html`<h2 class="c-band-name" key="name" data-kind="page" aria-label=${count.label}>
          <span class="c-band-title">${page.name}</span>
          ${count.counted
            ? page.tone === "warning"
              ? html`<${Badge} count=${page.count} tone="warning" />`
              : html`<span class="c-band-count">${page.count}</span>`
            : null}
        </h2>`
      : turns > 0
        ? html`<button class="c-band-name c-band-turn" key="name" type="button" data-act="turn" aria-label=${"あなたの番 " + turns + " 件"} onClick=${(event) => on.turn(event.currentTarget)}>
            <span class="c-band-title">あなたの番</span>
            <${Badge} count=${turns} tone="warning" />
          </button>`
        : html`<span class="c-band-name" key="name">self-agent</span>`}
    <span class="c-band-ops" key="ops">
      <span class="c-band-act" data-act="find"><${Button} kind="ghost" size="sm" icon="search" label="探す" onPress=${(event) => on.find(event.currentTarget)} /></span>
      ${phone || !hand
        ? null
        : html`<button class="c-band-hand" type="button" data-act="hand" aria-label=${bandHandName(mark)} aria-controls=${filled(controls) ? controls : undefined}
            aria-expanded=${hand && hand.open ? "true" : "false"} onClick=${(event) => on.hand(event.currentTarget)}>
            <span class="c-band-hand-label">右腕</span>
            ${mark ? html`<span class="c-band-hand-mark" data-state=${mark} aria-hidden="true"></span>` : null}
          </button>`}
      <span class="c-band-act" data-act="start">
        ${phone
          ? html`<${IconButton} icon="plus" label="始める" onPress=${(event) => on.start(event.currentTarget)} />`
          : html`<${Button} kind="ghost" size="sm" icon="plus" label="始める" onPress=${(event) => on.start(event.currentTarget)} />`}
      </span>
      <span class="c-band-act" data-act="more"><${IconButton} icon="settings" label="ほか" onPress=${(event) => on.more(event.currentTarget)} /></span>
    </span>
  </header>`;
}
