// 新しい入口の計算（docs/plan/web-ui-home.md §4.4 の P2a）: 会話の行・既読・3 つのタブ（あなたの番・タスク・通知）の分け方と数の印・ピンの 1 段。
// 純粋な関数だけ。画面の物に触らず、時計は引数で受ける（時刻の文字列を数にするだけ）。読み込んだだけでは何も起きない。import は無い。
// 写した元: api.js（行の足し方・既読）・topics.js（数え方・ピン・右腕）・c-deck.js（流れの列の分け方）・c-list.js（行の印）。式は元のまま、外の物を引数にした所だけ違う

/** 続けて失敗している間の間隔の上限（api.js の POLL_BACKOFF_MAX_MS と同じ数） */
export const BACKOFF_MAX_MS = 60000;
/** 通知のタブに出す数（c-deck.js の FEED_MAX と同じ数） */
export const FEED_MAX = 50;
/** 下端からこの px 以内なら最後の行の近く（pins.js の「下端から 48px 以内」と同じ数） */
export const NEAR_END_PX = 48;
/** 主の面に出る物の名前（スマホは下のタブ、PC は真ん中の柱。設計書 §2.2 の経路に合わせた） */
export const MAIN = Object.freeze(["talk", "topics", "turn", "tasks", "notices"]);

const filled = (v) => typeof v === "string" && v !== "";

// ===== 会話の行（api.js） =====

/** 会話の行を読む口のパス（channelId は % に直す。query は ? の後ろにそのまま付ける） */
export function turnsPath(channelId, query) {
  return "/api/channels/" + encodeURIComponent(channelId) + "/turns?" + query;
}

/** 行を id で重ねずに足す（古い順を保つ）。同じ id はサーバーの行（incoming）で置き換える（Web から送った仮の行を本物にする） */
export function mergeTurns(current, incoming) {
  const byId = new Map(current.map((t) => [t.id, t]));
  for (const t of incoming) byId.set(t.id, t);
  return [...byId.values()].sort((a, b) => a.id - b.id);
}

/** サーバーから受け取った行（t は { turns }。Web から送った直後に足した仮の行を除く） */
export function realTurns(t) {
  return t.turns.filter((row) => !row.optimistic);
}

/** 続けて fails 回失敗した後の間隔（倍々で、max で止める。base より短くしない） */
export function backoff(base, fails, max = BACKOFF_MAX_MS) {
  return fails === 0 ? base : Math.max(base, Math.min(base * 2 ** fails, max));
}

/** 会話の行の初めの形（毎回新しい物）。loaded: 最初の 50 件を読んだ。missing: 開けないチャンネル */
export function emptyTurns() {
  return { channel: null, turns: [], hasMore: false, loaded: false, missing: false };
}

/** Web から送った直後に、本物の行（同じ id）が来るまで足す仮の owner の行。at は ISO の時刻の文字列 */
export function optimisticTurn(turnId, text, at) {
  return { id: turnId, at, kind: "owner", source: "web", text, outcome: null, steps: null, toolCalls: null, durationMs: null, messageId: null, link: null, optimistic: true };
}

/** 行の配列の最後の行の id（仮の行も数える）。空・数でなければ null */
export function lastRowId(turns) {
  if (!Array.isArray(turns) || turns.length === 0) return null;
  const last = turns[turns.length - 1];
  const id = last !== null && typeof last === "object" ? last.id : undefined;
  return typeof id === "number" && Number.isFinite(id) ? id : null;
}

// ===== 既読（api.js。seen は { <channelId>: 見た最後の行の id }。null・undefined は空） =====

const seenOf = (seen, channelId) => (seen == null ? 0 : Number(seen[channelId]) || 0);

/** 最後の行（last）が返事か統括のまとめ（右腕の last.lead）で、まだ見ていない */
export function isUnread(channelId, last, seen) {
  return !!(last && (last.kind === "agent" || last.lead === true) && last.id > seenOf(seen, channelId));
}

/** id まで見たことにする。進むなら鍵を足した新しい object、進まない（id が数でない・今の値以下）なら同じ参照 */
export function seenUpTo(seen, channelId, id) {
  if (typeof id !== "number" || !(id > seenOf(seen, channelId))) return seen;
  return { ...(seen == null ? {} : seen), [channelId]: id };
}

/**
 * サーバーの既読（応答の reads）を取り込み（下げない。数でない・有限でない値は捨てる）、ids の会話のうち、
 * 手元がサーバーより進んでいて、200 が返った送った値（acked）よりも進んでいる物を send に（ids の順）。
 * 返す: { ok: reads が読めて送る物が無い, seen: 変わらなければ同じ参照, send }。reads が object でなければ { ok: false, seen: 同じ参照, send: [] }
 */
export function mergeReads(seen, reads, ids, acked) {
  if (reads === null || typeof reads !== "object" || Array.isArray(reads)) return { ok: false, seen, send: [] };
  let next = seen;
  for (const [channelId, value] of Object.entries(reads)) {
    if (typeof value === "number" && Number.isFinite(value) && value > seenOf(next, channelId)) {
      if (next === seen) next = { ...(seen == null ? {} : seen) };
      next[channelId] = value;
    }
  }
  const send = [];
  for (const channelId of Array.isArray(ids) ? ids : []) {
    const mine = seenOf(next, channelId);
    const server = typeof reads[channelId] === "number" ? reads[channelId] : 0;
    if (mine > server && mine > seenOf(acked, channelId)) send.push(channelId);
  }
  return { ok: send.length === 0, seen: next, send };
}

/** box = { scrollTop, clientHeight, scrollHeight } が下端から slack 以内か（中身が枠より短い時も true）。数でない・有限でない値は false */
export function nearEnd(box, slack = NEAR_END_PX) {
  if (box === null || typeof box !== "object") return false;
  const { scrollTop, clientHeight, scrollHeight } = box;
  if (![scrollTop, clientHeight, scrollHeight, slack].every((v) => typeof v === "number" && Number.isFinite(v))) return false;
  return scrollHeight - scrollTop - clientHeight <= slack;
}

/**
 * その会話を既読に進めて良いか（設計書 §3.2。案 A）。画面が表に出ていて、主の面が会話で、訊いている会話が会話そのもの（右の柱の札でない）で、
 * 押して入る画面が重なっておらず、最後の行の近くに居る時だけ true。欠けた鍵・ほかの型は false
 */
export function canMarkRead(o) {
  return o !== null && typeof o === "object" && o.visible === true && o.main === "talk" && o.surface === "talk" && o.covered === false && o.nearEnd === true;
}

/** 「↓ 新しい返事」を出すか: 最後の行の近くに居ない時、最後の本物の行が owner でなく、seenId より新しい */
export function newBelow(o) {
  if (o === null || typeof o !== "object" || o.nearEnd === true || !Array.isArray(o.turns)) return false;
  const real = realTurns({ turns: o.turns });
  const last = real[real.length - 1];
  return !!last && last.kind !== "owner" && last.id > (Number(o.seenId) || 0);
}

// ===== 話題の一覧の数え方・ピン・右腕（topics.js。data は GET /api/topics の応答か null） =====

/** 番の数（応答の turns）と、作業中の話題の数 */
export function counts(data) {
  return { turns: data ? data.turns : 0, running: data ? data.topics.filter((t) => t !== null && typeof t === "object" && t.mark === "running").length : 0 };
}

/** 上限・失敗で止まった番の話題の数（counts の turns に含まれる。読み直しを急がせない分） */
export function stoppedTurns(data) {
  if (!data) return 0;
  return data.topics.filter((t) => t !== null && typeof t === "object" && t.mark === "turn" && !!t.turn && (t.turn.kind === "max_turns" || t.turn.kind === "failed")).length;
}

/** 読み直しを急がせるか（止まった物の外に番が在るか、作業中の話題が在る） */
export function topicsBusy(data) {
  return counts(data).turns > stoppedTurns(data) || counts(data).running > 0;
}

/** 留めた話題の channelId（留めた順。ch: は付かない）。形が違えば空 */
export function pins(data) {
  return data && Array.isArray(data.pins) ? data.pins.filter((id) => typeof id === "string") : [];
}

/** 留められる数（0 = ピン留めの口が無い） */
export function pinMax(data) {
  return data && Number.isInteger(data.pinMax) && data.pinMax >= 1 ? data.pinMax : 0;
}

/** 右腕（rightHands[0]。サーバーが複数でも選ぶ口は作らない）。無ければ null */
export function hand(data) {
  return data && Array.isArray(data.rightHands) && data.rightHands.length > 0 && data.rightHands[0] ? data.rightHands[0] : null;
}

/** 右腕のチャンネル（ch: を外した物）。右腕が無い・ch: でなければ null */
export function handChannel(data) {
  const h = hand(data);
  return h && typeof h.id === "string" && h.id.startsWith("ch:") ? h.id.slice(3) : null;
}

/** 右腕を留める口が在るか（応答の handPins が配列で、ピン留めの口が在る。古いサーバーの間は false） */
export function handPinnable(data) {
  return !!data && Array.isArray(data.handPins) && pinMax(data) >= 1;
}

/** 右腕を留めているか（handPins は表の順で rightHands の順と違う事が在るので、右腕のチャンネルが含まれるかで見る） */
export function handPinned(data) {
  const id = handChannel(data);
  return id !== null && handPinnable(data) && data.handPins.includes(id);
}

// ===== 並べ方（c-deck.js） =====

/** 時刻の文字列を ms に。読めなければ null */
export const atMs = (at) => {
  const ms = typeof at === "string" ? Date.parse(at) : NaN;
  return Number.isFinite(ms) ? ms : null;
};

/** 新しい順（時刻の無い物は最後。同じ時刻は元の順） */
export function byNewest(a, b) {
  const x = atMs(a.at);
  const y = atMs(b.at);
  if (x === null || y === null) return x === null ? (y === null ? 0 : 1) : -1;
  return y - x;
}

/** 期限の並びの段（期限切れ 0・今日 1・ほかの期限 2・期限なし 3） */
export function dueRank(task, today) {
  if (!filled(task.due)) return 3;
  if (filled(today) && task.due < today) return 0;
  if (filled(today) && task.due === today) return 1;
  return 2;
}

/** GitHub の通知の種類（URL の /pull/・/issues/） */
export function githubKind(url) {
  if (typeof url !== "string") return "github";
  if (url.includes("/pull/")) return "pr";
  if (url.includes("/issues/")) return "issue";
  return "github";
}

// ===== 行の印（c-list.js） =====

/** 印は あなたの番 > 作業中 > 未読 で 1 つだけ。未読は印の無い ch: の話題だけ isUnread(チャンネル, last) に訊く */
export function rowMark(topic, isUnread) {
  if (topic.mark === "turn") return "turn";
  if (topic.mark === "running") return "running";
  if (topic.mark === null && typeof topic.id === "string" && topic.id.startsWith("ch:") && isUnread(topic.id.slice(3), topic.last)) return "unread";
  return "none";
}

// ===== 3 つのタブの分け方（c-deck.js の turnItems・runningItems・idleItems・taskItems・reminderItems・feedItems から、語・時刻の字・ボタンを除いた物） =====
// view: { topics, seen, tasks, doneTasks, reminders, github, notices, today, replies, noticesSeenAt, handRow }（docs/plan/web-ui-home.md §3.3）。欠けた鍵は「まだ読めていない」。
// 項目は { key, kind, id: 開く先か null, at: 並べるのに使った時刻か null, src: 渡された物そのもの }

/** 項目の形を揃える */
const entry = (key, kind, id, at, src) => ({ key, kind, id: filled(id) ? id : null, at: filled(at) ? at : null, src });

const topicsOf = (view) => (view.topics && Array.isArray(view.topics.topics) ? view.topics.topics : []);
/** 留めた話題の channelId（重なりと文字列でない物は捨てる。最初の出現の順） */
const pinIds = (view) => (view.topics && Array.isArray(view.topics.pins) ? [...new Set(view.topics.pins.filter((id) => typeof id === "string"))] : []);
/** 留めた話題か（ch: の話題だけ） */
const isPinned = (view, t) => typeof t.id === "string" && t.id.startsWith("ch:") && pinIds(view).includes(t.id.slice(3));
/** view の手元の既読で訊く未読 */
const unreadOf = (view) => (channelId, last) => isUnread(channelId, last, view.seen);

/**
 * あなたの番（turnIds の順。話題か右腕。引けない id は捨て、重なりは 1 つ）。右腕の番の項目には hand: true を足す。
 * view.handRow が true の間だけ、右腕の番は項目にせず held に数える。返す: { items, held }
 */
export function turnEntries(view) {
  const data = view.topics;
  if (!data) return { items: [], held: 0 };
  const ids = Array.isArray(data.turnIds) ? [...new Set(data.turnIds)] : [];
  const hands = Array.isArray(data.rightHands) ? data.rightHands : [];
  const row = view.handRow === true ? hand(data) : null;
  const items = [];
  let held = 0;
  for (const id of ids) {
    const topic = topicsOf(view).find((t) => t.id === id && t.turn);
    const h = topic ? null : hands.find((x) => x.id === id && x.turn);
    const src = topic || h;
    if (!src) continue;
    if (h && h === row) {
      held += 1;
      continue;
    }
    const e = entry("turn:" + id, typeof src.turn.kind === "string" ? src.turn.kind : "", id, src.turn.since, src);
    items.push(h ? { ...e, hand: true } : e);
  }
  return { items, held };
}

/** 動いている話題（あなたの番の無い物・留めていない物）。activityAt の新しい順 */
export function runningEntries(view) {
  return topicsOf(view)
    .filter((t) => t.mark === "running" && !t.turn && t.state !== "done" && !isPinned(view, t))
    .map((t) => entry("run:" + t.id, "running", t.id, t.activityAt, t))
    .sort(byNewest);
}

/** 待機: 印の無い・完了でない ch: の話題で、入口（pinned）でなく、未読でなく、留めていない物。activityAt の新しい順で全部 */
export function idleEntries(view) {
  const unread = unreadOf(view);
  return topicsOf(view)
    .filter((t) => t.mark === null && t.state !== "done" && typeof t.id === "string" && t.id.startsWith("ch:") && t.pinned !== true && !unread(t.id.slice(3), t.last) && !isPinned(view, t))
    .map((t) => entry("idle:" + t.id, "idle", t.id, t.activityAt, t))
    .sort(byNewest);
}

/** 未読の返事が来た話題（印の無い・完了でない ch: の話題で未読の物。右腕は入らない）。新しい順 */
export function unreadTopics(view) {
  const unread = unreadOf(view);
  return topicsOf(view)
    .filter((t) => t.mark === null && t.state !== "done" && typeof t.id === "string" && t.id.startsWith("ch:") && unread(t.id.slice(3), t.last))
    .map((t) => entry("topic:" + t.id, "reply", t.id, t.activityAt, t))
    .sort(byNewest);
}

/** 未読の返事の置き場所（"turn"・"notices"・"dot"。ほかの値は "turn"） */
const repliesOf = (view) => (view.replies === "notices" || view.replies === "dot" ? view.replies : "turn");

/** あなたの番のタブ。count は番だけ（右腕の番も数える）。replies は置き場所が "turn" の時だけ未読の話題 */
export function turnTab(view) {
  if (!view.topics) return { ready: false, count: 0, turns: [], replies: [] };
  const { items, held } = turnEntries(view);
  return { ready: true, count: items.length + held, turns: items, replies: repliesOf(view) === "turn" ? unreadTopics(view) : [] };
}

/** タスクのタブ。開いているタスクを期限で 期限切れ・今日・ほか に分ける（節の中は期限の昇順・同じ期限は渡された順・期限なしは最後）。count は期限切れと今日 */
export function tasksTab(view) {
  const tasks = Array.isArray(view.tasks) ? view.tasks : [];
  const ranked = tasks
    .map((t, i) => ({ t, i, rank: dueRank(t, view.today) }))
    .sort((a, b) => a.rank - b.rank || (a.rank < 3 && a.t.due !== b.t.due ? (a.t.due < b.t.due ? -1 : 1) : 0) || a.i - b.i);
  const pick = (test) => ranked.filter(({ rank }) => test(rank)).map(({ t }) => entry("task:" + t.id, "task", null, t.due, t));
  const overdue = pick((r) => r === 0);
  const today = pick((r) => r === 1);
  const later = pick((r) => r >= 2);
  const done = (Array.isArray(view.doneTasks) ? view.doneTasks : []).map((t) => entry("task:" + t.id, "task", null, t.due, t));
  const reminders = (Array.isArray(view.reminders) ? view.reminders : [])
    .map((r, i) => ({ r, i, ms: atMs(r.nextAt) }))
    .sort((a, b) => (a.ms === null || b.ms === null ? (a.ms === null ? (b.ms === null ? 0 : 1) : -1) : a.ms - b.ms) || a.i - b.i)
    .map(({ r }) => entry("rem:" + r.id, "reminder", null, r.nextAt, r));
  return { ready: !(view.tasks == null && view.reminders == null), count: overdue.length + today.length, overdue, today, later, done, reminders };
}

/**
 * 通知のタブ。GitHub（配列のとき）・知らせ・（置き場所が "notices" の時だけ）未読の話題を、時刻の新しい順に混ぜる。
 * 同じ時刻は GitHub → 知らせ → 話題。時刻の無い物は最後。上から FEED_MAX 件。
 * unseen は GitHub と知らせのうち noticesSeenAt より新しい物の数（基準が無い・読めない時は 0。時刻の無い物は数えない）
 */
export function noticesTab(view) {
  if (view.notices == null) return { ready: false, items: [], unseen: 0 };
  const all = [];
  if (Array.isArray(view.github)) {
    for (const n of view.github) all.push({ src: 0, item: entry("gh:" + n.id, githubKind(n.url), null, n.updatedAt, n) });
  }
  if (Array.isArray(view.notices)) {
    view.notices.forEach((n, i) => {
      all.push({ src: 1, item: entry("notice:" + n.at + ":" + i, "notice", null, n.at, n) });
    });
  }
  if (repliesOf(view) === "notices") {
    for (const item of unreadTopics(view)) all.push({ src: 2, item });
  }
  const items = all
    .map((e, i) => ({ ...e, i }))
    .sort((a, b) => {
      const x = atMs(a.item.at);
      const y = atMs(b.item.at);
      if (x === null || y === null) return (x === null ? 1 : 0) - (y === null ? 1 : 0) || a.src - b.src || a.i - b.i;
      return y - x || a.src - b.src || a.i - b.i;
    })
    .slice(0, FEED_MAX)
    .map((e) => e.item);
  const base = atMs(view.noticesSeenAt);
  const unseen = base === null ? 0 : items.filter((e) => e.kind !== "reply" && atMs(e.at) !== null && atMs(e.at) > base).length;
  return { ready: true, items, unseen };
}

/** 下のタブ（と PC の柱）の印。会話は右腕の未読の点、話題は未読の話題の点、ほかは数 */
export function tabBadges(view) {
  const h = hand(view.topics);
  const channelId = handChannel(view.topics);
  return {
    talk: { dot: !!h && !h.turn && channelId !== null && isUnread(channelId, h.last, view.seen) },
    topics: { dot: unreadTopics(view).length > 0 },
    turn: { count: turnTab(view).count },
    tasks: { count: tasksTab(view).count },
    notices: { count: noticesTab(view).unseen },
  };
}

// ===== ピンの 1 段（設計書 §3.1） =====

/**
 * 会話の上の 1 段: 右腕（在れば。留めていなくても先頭）→ 留めた話題（留めた順。一覧に無い物・右腕と同じチャンネル・重なりは出さない）→
 * 開いている話題（openId が右腕でも留めた話題でもなく、cc: でない時だけ最後に仮の項目）。上限はここでは切らない。
 * 項目は { key, kind: "hand"|"pin"|"temp", id, src, turn: 番が在るか, unread: 番が無く未読か }
 */
export function pinStrip(view, openId) {
  const data = view.topics;
  if (!data) return [];
  const unread = unreadOf(view);
  const topicItem = (key, kind, id, t) => ({ key, kind, id, src: t, turn: !!t && (t.mark === "turn" || !!t.turn), unread: !!t && rowMark(t, unread) === "unread" });
  const out = [];
  const h = hand(data);
  const handId = h && filled(h.id) ? h.id : null;
  const channelId = handChannel(data);
  if (h) out.push({ key: "hand:" + h.id, kind: "hand", id: handId, src: h, turn: !!h.turn, unread: !h.turn && channelId !== null && isUnread(channelId, h.last, view.seen) });
  const pinned = pinIds(view).filter((p) => p !== channelId);
  for (const p of pinned) {
    const t = topicsOf(view).find((x) => x.id === "ch:" + p);
    if (t) out.push(topicItem("pin:ch:" + p, "pin", "ch:" + p, t));
  }
  if (filled(openId) && openId !== handId && !openId.startsWith("cc:") && !(openId.startsWith("ch:") && pinned.includes(openId.slice(3)))) {
    const t = topicsOf(view).find((x) => x.id === openId) || null;
    out.push(topicItem("temp:" + openId, "temp", openId, t));
  }
  return out;
}
