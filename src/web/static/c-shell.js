// 殻の部品（docs/plan/web-ui-components.md §6 の K3・K4）: BottomBar・TopBar とそのモデルの関数。
// hook を使わない（Node から関数として呼べる）。どの形にするか（variant）は入口が決めて渡す。クラスは固定の文字列、状態は data-* と aria-*
import { html } from "./c-lib.js";
import { Badge, Button, Icon, IconButton, Segmented, badgeText } from "./c-atoms.js";

const HAND = "右腕に頼む・訊く";

const filled = (v) => typeof v === "string" && v !== "";

/** 右腕のボタンの名前（印があれば語で足す） */
export function handLabel(mark) {
  if (mark === "turn") return HAND + "（あなたの番）";
  if (mark === "unread") return HAND + "（未読）";
  return HAND;
}

/** 「一覧」のボタンの名前（件数は K2 の Badge と同じく 99 まで） */
export function listLabel(turns) {
  const text = badgeText(turns);
  return text === "" ? "一覧" : "一覧（あなたの番 " + text + " 件）";
}

/** 下のバーの項目。phone は 一覧・右腕・ほか、wide は tabs の順に文字のボタンと最後に「ほか」 */
export function bottomModel({ variant, turns, hand, tabs }) {
  const v = variant === "wide" ? "wide" : "phone";
  const n = typeof turns === "number" && !Number.isNaN(turns) ? turns : 0;
  const more = { act: "more", label: "ほか" };
  if (v === "wide") {
    // null・id の無い物は捨てる
    const list = Array.isArray(tabs) ? tabs.filter((tab) => tab !== null && typeof tab === "object" && tab.id !== undefined && tab.id !== null && tab.id !== "") : [];
    return { variant: v, items: [...list.map((tab) => ({ act: "tab", id: tab.id, label: tab.title })), more] };
  }
  const mark = hand === "turn" || hand === "unread" ? hand : null;
  return {
    variant: v,
    items: [
      { act: "list", label: "一覧", name: listLabel(n), count: n },
      { act: "hand", label: HAND, name: handLabel(mark), mark },
      more,
    ],
  };
}

/** 下のバー（一覧の列の中。スクロールの入れ物の下の兄弟に置く）。controls は右腕のボタンの aria-controls。on: { list(), hand(opener), tab(id), more(opener) } */
export function BottomBar({ variant, turns, hand, tabs, controls, on }) {
  const model = bottomModel({ variant, turns, hand, tabs });
  return html`<div class="c-bottom" role="group" aria-label="移動" data-variant=${model.variant}>
    ${model.items.map((item) => {
      if (item.act === "list") {
        return html`<button class="c-bottom-btn" key="list" type="button" data-act="list" aria-current="page" aria-label=${item.name} onClick=${() => on.list()}>
          <span class="c-bottom-btn-label">${item.label}</span>
          <${Badge} count=${item.count} tone="warning" />
        </button>`;
      }
      if (item.act === "hand") {
        return html`<button class="c-bottom-hand" key="hand" type="button" data-act="hand" aria-label=${item.name} aria-controls=${filled(controls) ? controls : undefined} onClick=${(event) => on.hand(event.currentTarget)}>
          <${Icon} name="bot" />
          <span class="c-bottom-hand-label">${item.label}</span>
          ${item.mark ? html`<span class="c-bottom-hand-mark" data-state=${item.mark} aria-hidden="true"></span>` : null}
        </button>`;
      }
      if (item.act === "tab") return html`<${Button} key=${"tab:" + item.id} kind="ghost" size="sm" label=${item.label} onPress=${() => on.tab(item.id)} />`;
      return html`<${Button} key="more" kind="ghost" size="sm" label=${item.label} onPress=${(event) => on.more(event.currentTarget)} />`;
    })}
  </div>`;
}

// ===== 会話の見出し（TopBar。K4）。1 段で、スマホは 一覧へ・題・「…」・右腕、広い幅は 題・状態・場所・［会話］［端末］・「…」 =====

const TOP_TONES = ["warning", "accent", "muted"];
const TOP_VIEWS = [
  { value: "talk", label: "会話" },
  { value: "pane", label: "端末" },
];


/** 見出しの中身。view が talk・other でなければ null（何も描かない）。スマホは場所・切り替えを出さず（「…」の板から）、広い幅は右腕を出さない（右の列の物） */
export function topModel({ variant, view, title, status, note, place, views, hand, menu }) {
  if (view !== "talk" && view !== "other") return null;
  const v = variant === "wide" ? "wide" : "phone";
  const talk = view === "talk";
  const st = talk && status && filled(status.text) ? { text: status.text, tone: TOP_TONES.includes(status.tone) ? status.tone : "muted" } : null;
  const placeText = talk && place ? "場所: " + place.text : null;
  const noteText = talk && filled(note) ? note : null;
  let rest = "";
  let pl = null;
  let vw = null;
  let hd = null;
  if (v === "phone") {
    rest = [placeText, noteText].filter((s) => s !== null).join(" ・ ");
    const mark = hand === "turn" || hand === "unread" ? hand : null;
    hd = { name: handLabel(mark), mark };
  } else {
    rest = noteText ?? "";
    if (placeText !== null) {
      const disabled = place.movable !== true;
      pl = { text: placeText, disabled, reason: disabled && filled(place.reason) ? place.reason : null };
    }
    if (talk && views) vw = { value: views.value === "pane" ? "pane" : "talk", items: TOP_VIEWS };
  }
  return {
    variant: v,
    view,
    title: typeof title === "string" ? title : "",
    back: v === "phone",
    status: st,
    rest,
    place: pl,
    views: vw,
    menu: talk && menu === true,
    hand: hd,
  };
}

/** 会話の見出し（列 2 の上）。on: { back(), place(opener), view(value), menu(opener), hand(opener) }。直下の子は決まった key（増減しても残る子を作り直さない） */
export function TopBar({ variant, view, title, status, note, place, views, hand, menu, controls, on }) {
  const m = topModel({ variant, view, title, status, note, place, views, hand, menu });
  if (m === null) return null;
  const wide = m.variant === "wide";
  const statusEl = m.status ? html`<span class="c-top-status" key="status" data-tone=${m.status.tone}>${m.status.text}</span>` : null;
  const restEl = m.rest !== "" ? html`<span class="c-top-rest" key="rest">${m.rest}</span>` : null;
  return html`<header class="c-top" data-variant=${m.variant} data-view=${m.view}>
    ${m.back ? html`<span class="c-top-act" key="back" data-act="back"><${IconButton} icon="chevron-left" label="一覧へ" onPress=${() => on.back()} /></span>` : null}
    <div class="c-top-text" key="text">
      <h1 class="c-top-title">${m.title}</h1>
      ${!wide && (statusEl || restEl) ? html`<p class="c-top-sub">${statusEl}${statusEl && restEl ? " ・ " : null}${restEl}</p>` : null}
    </div>
    ${wide ? statusEl : null}
    ${wide ? restEl : null}
    ${m.place
      ? html`<button class="c-top-place" key="place" type="button" data-act="place" aria-haspopup="dialog" disabled=${m.place.disabled}
          title=${m.place.reason ?? undefined} onClick=${(event) => on.place(event.currentTarget)}>
          <span class="c-top-place-text">${m.place.text}</span>
          <${Icon} name="chevron-down" size="sm" />
        </button>`
      : null}
    ${wide ? html`<span class="c-top-gap" key="gap"></span>` : null}
    ${m.views ? html`<div class="c-top-views" key="views"><${Segmented} items=${m.views.items} value=${m.views.value} label="見る物" onChange=${(value) => on.view(value)} /></div>` : null}
    ${m.menu ? html`<span class="c-top-act" key="menu" data-act="menu"><${IconButton} icon="ellipsis" label="ほかの操作" onPress=${(event) => on.menu(event.currentTarget)} /></span>` : null}
    ${m.hand
      ? html`<button class="c-top-hand" key="hand" type="button" data-act="hand" aria-label=${m.hand.name} aria-controls=${filled(controls) ? controls : undefined}
          onClick=${(event) => on.hand(event.currentTarget)}>
          <${Icon} name="bot" />
          <span class="c-top-hand-label">右腕</span>
          ${m.hand.mark ? html`<span class="c-top-hand-mark" data-state=${m.hand.mark} aria-hidden="true"></span>` : null}
        </button>`
      : null}
  </header>`;
}
