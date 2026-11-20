// 端末のセッションの札の部品（docs/plan/terminal-handover.md の H3）: 札 TermCard と、つなぎの生の状態から札の props を作る termView、決めた文 TERM_TEXT、口 termMouth。
// hook を使わない（Node から関数として呼べる）。状態は持たず、起きた事を on に伝えるだけ。取り込めるかの判定と理由の文はサーバーの物をそのまま出す。
// 押せない形は Button の disabled・busy と reason。クラスは固定の文字列、状態は data-* と aria-*
import { html } from "./c-lib.js";
import { Button } from "./c-atoms.js";

/** 札の決めた文（状態の 4 つの言葉は chat.js の CC_STATE_LABEL と同じ） */
export const TERM_TEXT = Object.freeze({
  label: "端末のセッション",
  place: "場所",
  state: "状態",
  activity: "最後の活動",
  endedAt: "終わった時刻",
  noPlace: "不明",
  idle: "待機",
  running: "実行中",
  waiting: "判断待ち",
  ended: "終わりました",
  unknown: "不明",
  lead: "取り込むと、端末の Claude Code を終わらせて、続きを新しい話題で引き継ぎます。",
  leadEnded: "端末の Claude Code は終わっています。取り込むと、続きを新しい話題で引き継ぎます。",
  checking: "取り込めるか確かめています…",
  checkFailed: "取り込めるか確かめられませんでした。",
  taking: "取り込んでいます…",
  lost: "結果を確かめられませんでした。取り込みは続いているかもしれません。",
  blocked: "今は取り込めません",
  take: "取り込む",
  recheck: "確かめ直す",
  pane: "端末を見る",
  rc: "RC で開く",
});

/** 状態の言葉の色 */
const STATE_TONE = { running: "accent", waiting: "warning" };

/** 「状態」の行に使える値（needs_input は waiting に読み替え、ほかは unknown） */
const STATES = ["idle", "running", "waiting", "ended", "unknown"];
const stateOf = (v) => (v === "needs_input" ? "waiting" : STATES.includes(v) ? v : "unknown");

/** 空でない文字だけ。ほかは null */
const text = (v) => (typeof v === "string" && v !== "" ? v : null);

/** RC のリンクは claude.ai/code の https だけ。ほかは null */
const RC_HEAD = "https://claude.ai/code/";
const rcOf = (v) => (typeof v === "string" && v.startsWith(RC_HEAD) ? v : null);

/** kind（先に当たった物）。check は丸めた後の物（読めなかったときは null） */
function kindOf(raw, check) {
  if (raw.phase === "taking") return "taking";
  if (raw.phase === "lost") return "lost";
  if (raw.checking || (check === null && !raw.failed)) return "checking";
  if (check === null) return "blocked";
  if (check.takeable) return "ready";
  if (check.reason === "busy") return "busy";
  if (check.reason === "waiting") return "waiting";
  return "blocked";
}

/** 直前の失敗の文が無いときの下の文（先に当たった物）。無ければ null */
function plainNote(kind, check) {
  if (kind === "taking") return { text: TERM_TEXT.taking, tone: "plain", busy: true };
  if (kind === "lost") return { text: TERM_TEXT.lost, tone: "error", busy: false };
  if (kind === "checking") return { text: TERM_TEXT.checking, tone: "plain", busy: true };
  if (check === null) return { text: TERM_TEXT.checkFailed, tone: "error", busy: false };
  if (kind === "ready") return null;
  return { text: text(check.text) ?? TERM_TEXT.blocked, tone: "plain", busy: false };
}

/** 札の下の文。途中の形（taking・lost）のほかは、直前の失敗の文が先 */
function noteOf(kind, error, plain) {
  if (kind === "taking" || kind === "lost") return plain;
  if (error !== null) return { text: error, tone: "error", busy: false };
  return plain;
}

/** ［取り込む］の押せる・押せない。理由は直前の失敗の文ではなく今の理由（plain の文） */
function takeOf(raw, kind, plain) {
  if (kind === "ready") {
    if (raw.phase === "proposing") return { disabled: true, busy: true, reason: null };
    if (raw.phase === "asking") return { disabled: true, busy: false, reason: null };
    return { disabled: false, busy: false, reason: null };
  }
  if (kind === "taking") return { disabled: true, busy: true, reason: TERM_TEXT.taking };
  return { disabled: true, busy: false, reason: plain ? plain.text : null };
}

/**
 * つなぎが渡す生の状態 → TermCard の props（on は含めない）。
 * raw: { title, place, rowState（一覧の行の idle・running・waiting か null）, activity（表示用の時刻か null）, pane, check（null か { takeable, state, reason, text, rcUrl }）, checking, failed, phase（idle・proposing・asking・taking・lost）, error }
 * failed のときは check を見ない（読めなかった形にする）。
 * error は、つなぎが次の判定が読めたとき・［取り込む］を押し直したときに null に戻す（その間は下の文の先頭に出る）。
 */
export function termView(raw) {
  const check = raw.failed === true || raw.check === undefined || raw.check === null ? null : raw.check;
  const error = text(raw.error);
  const activity = text(raw.activity);
  const s = stateOf(check !== null && !raw.checking ? check.state : (raw.rowState ?? (check ? check.state : "unknown")));
  const kind = kindOf(raw, check);
  const plain = plainNote(kind, check);
  const note = noteOf(kind, error, plain);
  return {
    kind,
    title: raw.title,
    place: raw.place,
    state: { text: TERM_TEXT[s], tone: STATE_TONE[s] ?? "muted" },
    when: activity === null ? null : { label: s === "ended" ? TERM_TEXT.endedAt : TERM_TEXT.activity, text: activity },
    lead: kind === "ready" ? (s === "ended" ? TERM_TEXT.leadEnded : TERM_TEXT.lead) : null,
    note,
    take: takeOf(raw, kind, plain),
    pane: raw.pane ? { disabled: kind === "taking", reason: kind === "taking" ? TERM_TEXT.taking : null } : null,
    rcUrl: check ? rcOf(check.rcUrl) : null,
    recheck: kind === "blocked" || kind === "lost",
  };
}

/** 事実の 1 行（dt と dd）。tone が在れば dd に data-tone */
function Fact({ label, text, tone }) {
  return html`<div class="c-term-row">
    <dt class="c-term-dt">${label}</dt>
    <dd class="c-term-dd" data-tone=${tone}>${text}</dd>
  </div>`;
}

/** 端末のセッションの札。props は termView の返り値と on（take()・pane()・recheck()） */
export function TermCard({ kind, title, place, state, when, lead, note, take, pane, rcUrl, recheck, on }) {
  return html`<section class="c-term" aria-label=${TERM_TEXT.label} data-kind=${kind}>
    <h2 class="c-term-title" key="title">${title}</h2>
    <dl class="c-term-dl" key="dl">
      <${Fact} key="place" label=${TERM_TEXT.place} text=${place ?? TERM_TEXT.noPlace} />
      <${Fact} key="state" label=${TERM_TEXT.state} text=${state.text} tone=${state.tone} />
      ${when === null ? null : html`<${Fact} key="when" label=${when.label} text=${when.text} />`}
    </dl>
    ${lead === null ? null : html`<p class="c-term-lead" key="lead">${lead}</p>`}
    ${note === null
      ? null
      : html`<p class="c-term-note" key="note" role=${note.tone === "error" ? "alert" : "status"} data-tone=${note.tone} data-busy=${note.busy ? "true" : undefined}>${note.text}</p>`}
    <div class="c-term-actions" key="actions">
      <${Button} key="take" kind="primary" size="md" label=${TERM_TEXT.take} disabled=${take.disabled} busy=${take.busy} reason=${take.reason} onPress=${() => on.take()} />
      ${recheck ? html`<${Button} key="recheck" kind="secondary" size="md" label=${TERM_TEXT.recheck} onPress=${() => on.recheck()} />` : null}
      ${pane === null ? null : html`<${Button} key="pane" kind="ghost" size="md" label=${TERM_TEXT.pane} disabled=${pane.disabled} reason=${pane.reason} onPress=${() => on.pane()} />`}
      ${rcUrl === null ? null : html`<a class="c-term-link" key="rc" href=${rcUrl} target="_blank" rel="noreferrer noopener">${TERM_TEXT.rc}</a>`}
    </div>
  </section>`;
}

/** 口: 根に札を描く・外す（render は c-lib.js の物。例外は握らない。握るのは入口） */
export function termMouth(render) {
  return {
    draw: (root, raw) => render(html`<${TermCard} ...${termView(raw)} on=${raw.on} />`, root),
    drop: (root) => render(null, root),
  };
}
