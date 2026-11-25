// 殻の部品（docs/plan/web-ui-components.md §6 の K3・K4）: BottomBar・TopBar とそのモデルの関数と、右腕の丸（HandOrb。#463 の D6）。
// hook を使わない（Node から関数として呼べる）。どの形にするか（variant）は入口が決めて渡す。クラスは固定の文字列、状態は data-* と aria-*
import { html } from "./c-lib.js";
import { Badge, Button, Icon, IconButton, Mark, Segmented, badgeText } from "./c-atoms.js";

const HAND = "右腕に頼む・訊く";

const filled = (v) => typeof v === "string" && v !== "";

/** 右腕のボタンの名前（印があれば語で足す） */
export function handLabel(mark) {
  if (mark === "turn") return HAND + "（あなたの番）";
  if (mark === "unread") return HAND + "（未読）";
  if (mark === "running") return HAND + "（作業中）";
  return HAND;
}

/** 右腕の口の印（turn・unread・running。知らない値は null） */
function handMarkOf(mark) {
  return mark === "turn" || mark === "unread" || mark === "running" ? mark : null;
}

/** 「一覧」のボタンの名前（件数は K2 の Badge と同じく 99 まで） */
export function listLabel(turns) {
  const text = badgeText(turns);
  return text === "" ? "一覧" : "一覧（あなたの番 " + text + " 件）";
}

/** 列のボタンの名前（数が 1 以上なら「<label>（n 件）」。件数は K2 の Badge と同じく 99 まで。unread なら「・未読」か「（未読）」を足す。#514） */
function pageName(label, count, unread) {
  const text = badgeText(count);
  if (unread) return text === "" ? label + "（未読）" : label + "（" + text + " 件・未読）";
  return text === "" ? label : label + "（" + text + " 件）";
}

/**
 * 下のバーの項目。phone は 一覧・ほか、wide は tabs の順に文字のボタンと最後に「ほか」。
 * deck（スマホの流れの列。D2）は pages（[{ id, label, count, unread }]。列の名前は入口が渡す）の順に列のボタンだけ。今の列は page（合う物が無ければ先頭）。
 * unread（true のときだけ）は列のボタンの未読の点（あなたの番 の列に右腕の未読。#514）
 */
export function bottomModel({ variant, turns, tabs, pages, page }) {
  const v = variant === "wide" ? "wide" : variant === "deck" ? "deck" : "phone";
  const n = typeof turns === "number" && !Number.isNaN(turns) ? turns : 0;
  const more = { act: "more", label: "ほか" };
  if (v === "deck") {
    // null・id の無い物は捨てる
    const list = Array.isArray(pages) ? pages.filter((p) => p !== null && typeof p === "object" && filled(p.id)) : [];
    const current = list.some((p) => p.id === page) ? page : list.length > 0 ? list[0].id : null;
    return {
      variant: v,
      items: list.map((p) => {
        const label = typeof p.label === "string" ? p.label : "";
        const count = typeof p.count === "number" && Number.isFinite(p.count) && p.count > 0 ? p.count : 0;
        const unread = p.unread === true;
        return { act: "page", id: p.id, label, name: pageName(label, count, unread), count, unread, current: p.id === current };
      }),
    };
  }
  if (v === "wide") {
    // null・id の無い物は捨てる
    const list = Array.isArray(tabs) ? tabs.filter((tab) => tab !== null && typeof tab === "object" && tab.id !== undefined && tab.id !== null && tab.id !== "") : [];
    return { variant: v, items: [...list.map((tab) => ({ act: "tab", id: tab.id, label: tab.title })), more] };
  }
  return {
    variant: v,
    items: [{ act: "list", label: "一覧", name: listLabel(n), count: n }, more],
  };
}

/**
 * 下のバー（一覧の列の中。スクロールの入れ物の下の兄弟に置く。deck は流れの列の下）。
 * on: { list(), tab(id), more(opener), page(id) }（page は deck の列のボタン。今の列でも呼ぶ）
 */
export function BottomBar({ variant, turns, tabs, pages, page, on }) {
  const model = bottomModel({ variant, turns, tabs, pages, page });
  return html`<div class="c-bottom" role="group" aria-label="移動" data-variant=${model.variant}>
    ${model.items.map((item) => {
      if (item.act === "page") {
        return html`<button class="c-bottom-page" key=${item.id} type="button" data-act="page" data-page=${item.id} aria-current=${item.current ? "true" : undefined}
            aria-label=${item.name} onClick=${() => on.page(item.id)}>
          <span class="c-bottom-page-in">
            <span class="c-bottom-page-label">${item.label}</span>
            ${item.count > 0 ? html`<${Badge} count=${item.count} tone="warning" />` : null}
            ${item.unread ? html`<${Mark} state="unread" />` : null}
          </span>
        </button>`;
      }
      if (item.act === "list") {
        return html`<button class="c-bottom-btn" key="list" type="button" data-act="list" aria-current="page" aria-label=${item.name} onClick=${() => on.list()}>
          <span class="c-bottom-btn-label">${item.label}</span>
          <${Badge} count=${item.count} tone="warning" />
        </button>`;
      }
      if (item.act === "tab") return html`<${Button} key=${"tab:" + item.id} kind="ghost" size="sm" label=${item.label} onPress=${() => on.tab(item.id)} />`;
      return html`<${Button} key="more" kind="ghost" size="sm" label=${item.label} onPress=${(event) => on.more(event.currentTarget)} />`;
    })}
  </div>`;
}

// ===== 会話の見出し（TopBar。K4）。1 段で、スマホは 一覧へ・題・「…」、広い幅は 題・状態・場所・［会話］［端末］・「…」 =====

const TOP_TONES = ["warning", "accent", "muted"];
/** 帯に出す許可のモード（プロジェクトのセッションで選べる 3 つ） */
const TOP_MODES = ["default", "acceptEdits", "plan"];
const TOP_VIEWS = [
  { value: "talk", label: "会話" },
  { value: "pane", label: "端末" },
];

/**
 * 見出しの中身。view が talk・other でなければ null（何も描かない）。スマホは場所・切り替えを出さない（「…」の板から）。
 * compact（広い幅で根が狭いとき。入口が測って渡す）は、広い幅でも場所・切り替えを帯に出さず、スマホと同じく補足の語にする。
 * place は text が空でない文字列のときだけ場所として扱う。広い幅の帯のボタンは名前だけを見せ、「場所: 」付きは読み上げの名前（label）。
 * mode（プロジェクトのセッションの許可のモード）は、広い幅で compact でない会話の見出しで、value が default・acceptEdits・plan のときだけ帯のボタンにする
 * （スマホ・compact は帯にも補足の語にも出さない。「…」の板から）。
 * close（流れの列の席。D1）は true のときだけ帯の右端に［閉じる］を出す。
 * pin（ピン留めのボタン。#507）は広い幅（compact も）の会話の見出しで物のときだけ { on, disabled, why }（why は押せないときの理由）。ほかは null
 */
export function topModel({ variant, view, title, status, note, place, views, menu, compact, mode, close, pin }) {
  if (view !== "talk" && view !== "other") return null;
  const v = variant === "wide" ? "wide" : "phone";
  const narrow = v === "wide" && compact === true;
  const talk = view === "talk";
  const st = talk && status && filled(status.text) ? { text: status.text, tone: TOP_TONES.includes(status.tone) ? status.tone : "muted" } : null;
  const placeName = talk && place && filled(place.text) ? place.text : null;
  const placeText = placeName === null ? null : "場所: " + placeName;
  const noteText = talk && filled(note) ? note : null;
  let rest = "";
  let pl = null;
  let vw = null;
  let md = null;
  if (v === "phone") {
    rest = [placeText, noteText].filter((s) => s !== null).join(" ・ ");
  } else if (narrow) {
    rest = [placeText, noteText].filter((s) => s !== null).join(" ・ ");
  } else {
    rest = noteText ?? "";
    if (placeText !== null) {
      const disabled = place.movable !== true;
      pl = { text: placeName, label: placeText, disabled, reason: disabled && filled(place.reason) ? place.reason : null };
    }
    if (talk && views) vw = { value: views.value === "pane" ? "pane" : "talk", items: TOP_VIEWS };
    if (talk && mode && TOP_MODES.includes(mode.value)) {
      const disabled = mode.disabled === true;
      md = { text: mode.value, label: "許可のモード: " + mode.value, disabled, reason: disabled && filled(mode.reason) ? mode.reason : null };
    }
  }
  return {
    variant: v,
    view,
    title: typeof title === "string" ? title : "",
    back: v === "phone",
    compact: narrow,
    status: st,
    rest,
    place: pl,
    mode: md,
    views: vw,
    menu: talk && menu === true,
    close: close === true,
    pin:
      talk && v === "wide" && pin !== null && typeof pin === "object"
        ? { on: pin.on === true, disabled: pin.disabled === true, why: pin.disabled === true && filled(pin.why) ? pin.why : null }
        : null,
  };
}

/**
 * 会話の見出し（列 2 の上）。on: { back(), place(opener), mode(opener), view(value), menu(opener), pin(opener), close() }。直下の子は決まった key（増減しても残る子を作り直さない）。
 * backLabel は［‹］の名前（空でない文字列のときだけ。既定は「一覧へ」）。level は題の見出しの段（2 のときだけ h2。ほかは h1。留めた会話の列の見出しは 2。#507）
 */
export function TopBar({ variant, view, title, status, note, place, views, menu, compact, mode, close, pin, backLabel, level, on }) {
  const m = topModel({ variant, view, title, status, note, place, views, menu, compact, mode, close, pin });
  if (m === null) return null;
  const wide = m.variant === "wide";
  const statusEl = m.status ? html`<span class="c-top-status" key="status" data-tone=${m.status.tone}>${m.status.text}</span>` : null;
  const restEl = m.rest !== "" ? html`<span class="c-top-rest" key="rest">${m.rest}</span>` : null;
  return html`<header class="c-top" data-variant=${m.variant} data-view=${m.view} data-compact=${m.compact ? "true" : undefined}>
    ${m.back ? html`<span class="c-top-act" key="back" data-act="back"><${IconButton} icon="chevron-left" label=${filled(backLabel) ? backLabel : "一覧へ"} onPress=${() => on.back()} /></span>` : null}
    <div class="c-top-text" key="text">
      ${level === 2 ? html`<h2 class="c-top-title">${m.title}</h2>` : html`<h1 class="c-top-title">${m.title}</h1>`}
      ${!wide && (statusEl || restEl) ? html`<p class="c-top-sub">${statusEl}${statusEl && restEl ? " ・ " : null}${restEl}</p>` : null}
    </div>
    ${wide ? statusEl : null}
    ${wide ? restEl : null}
    ${m.place
      ? html`<button class="c-top-place" key="place" type="button" data-act="place" aria-haspopup="dialog" aria-label=${m.place.label}
          aria-disabled=${m.place.disabled ? "true" : undefined} title=${m.place.disabled ? (m.place.reason ?? undefined) : "場所を変える"}
          onClick=${(event) => {
            if (m.place.disabled) {
              event.preventDefault();
              return;
            }
            on.place(event.currentTarget);
          }}>
          <span class="c-top-place-text">${m.place.text}</span>
          <${Icon} name="chevron-down" size="sm" />
        </button>`
      : null}
    ${m.mode
      ? html`<button class="c-top-mode" key="mode" type="button" data-act="mode" aria-haspopup="dialog" aria-label=${m.mode.label}
          aria-disabled=${m.mode.disabled ? "true" : undefined} title=${m.mode.disabled ? (m.mode.reason ?? undefined) : "許可のモードを変える"}
          onClick=${(event) => {
            if (m.mode.disabled) {
              event.preventDefault();
              return;
            }
            on.mode(event.currentTarget);
          }}>
          <span class="c-top-mode-text">${m.mode.text}</span>
          <${Icon} name="chevron-down" size="sm" />
        </button>`
      : null}
    ${wide ? html`<span class="c-top-gap" key="gap"></span>` : null}
    ${m.views ? html`<div class="c-top-views" key="views"><${Segmented} items=${m.views.items} value=${m.views.value} label="見る物" onChange=${(value) => on.view(value)} /></div>` : null}
    ${m.menu ? html`<span class="c-top-act" key="menu" data-act="menu"><${IconButton} icon="ellipsis" label="ほかの操作" onPress=${(event) => on.menu(event.currentTarget)} /></span>` : null}
    ${m.pin
      ? html`<span class="c-top-act" key="pin" data-act="pin"><${IconButton} icon="pin" label="ピン留め" pressed=${m.pin.on}
          disabled=${m.pin.disabled} reason=${m.pin.why ?? undefined} onPress=${(event) => on.pin(event.currentTarget)} /></span>`
      : null}
    ${m.close ? html`<span class="c-top-act" key="close" data-act="close"><${IconButton} icon="x" label="閉じる" onPress=${() => on.close()} /></span>` : null}
  </header>`;
}

// ===== 右腕の丸（HandOrb。#463 の D6）: 広い幅の流れの列で右下に浮く 56 の円。中は bot のアイコンと印だけ（字は無い） =====

/**
 * 右腕の丸。tone は "accent"（列だけの間）か、ほかは静かな顔（quiet。席が開いている間）。mark は turn・unread・running、ほかは印なし。
 * 印は accent の顔が自前の点（下のバーと同じ配色）、静かな顔が K2 の Mark。open は枠が開いているか（aria-expanded）、controls は aria-controls。
 * on: { hand(opener) }（押したボタンを渡す）
 */
export function HandOrb({ mark, tone, open, controls, on }) {
  const face = tone === "accent" ? "accent" : "quiet";
  const state = handMarkOf(mark);
  const name = handLabel(state);
  return html`<button class="c-orb" type="button" data-act="hand" data-tone=${face} aria-label=${name} title=${name}
      aria-controls=${filled(controls) ? controls : undefined} aria-expanded=${open ? "true" : "false"} onClick=${(event) => on.hand(event.currentTarget)}>
    <${Icon} name="bot" />
    ${state
      ? html`<span class="c-orb-mark">${face === "accent" ? html`<span class="c-orb-dot" data-state=${state} aria-hidden="true"></span>` : html`<${Mark} state=${state} />`}</span>`
      : null}
  </button>`;
}
