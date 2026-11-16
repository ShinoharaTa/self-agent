// 小さい部品（docs/plan/web-ui-components.md §6 の K2）: Icon・Button・IconButton・Badge・Mark・Segmented・Field・Empty・Loading。
// hook を使わない（Node から関数として呼べる）。クラスは固定の文字列、状態は data-* と aria-*。属性を出さないときは undefined
import { html } from "./c-lib.js";

/** base.css と同じ所から配る sprite（templates/web/site/icons.svg）の symbol。ほかは icons-app.svg */
export const ICONS_BASE = Object.freeze(["plus", "x", "check", "trash-2", "pencil", "search", "settings", "chevron-left", "chevron-right", "chevron-down", "ellipsis", "calendar", "clock", "info", "triangle-alert", "rotate-ccw", "grip-vertical", "list", "square-check", "circle"]);

export function iconHref(name) {
  return (ICONS_BASE.includes(name) ? "/static/icons.svg#" : "/static/icons-app.svg#") + name;
}

/** size: "md"（20）| "sm"（16） */
export function Icon({ name, size = "md" }) {
  return html`<svg class="c-icon" data-size=${size} aria-hidden="true" focusable="false"><use href=${iconHref(name)} /></svg>`;
}

const BUTTON_KINDS = ["primary", "accent", "secondary", "ghost", "danger"];

/** 知らない kind・size は secondary・md に丸める。押せない（disabled か busy）ときは aria-disabled */
export function buttonState({ kind, size, disabled, busy }) {
  const inert = !!disabled || !!busy;
  return {
    kind: BUTTON_KINDS.includes(kind) ? kind : "secondary",
    size: size === "sm" ? "sm" : "md",
    inert,
    ariaDisabled: inert ? "true" : undefined,
    ariaBusy: busy ? "true" : undefined,
  };
}

/** native の disabled は付けない（フォーカスと押せない理由の title を残す） */
export function Button({ kind = "secondary", size = "md", icon, label, disabled = false, busy = false, reason, type = "button", autofocus = false, onPress }) {
  const s = buttonState({ kind, size, disabled, busy });
  return html`<button class="c-btn" type=${type} data-kind=${s.kind} data-size=${s.size}
      aria-disabled=${s.ariaDisabled} aria-busy=${s.ariaBusy}
      title=${s.inert && reason ? reason : undefined} autofocus=${autofocus ? true : undefined}
      onClick=${(event) => {
        if (s.inert) {
          event.preventDefault();
          return;
        }
        if (onPress) onPress();
      }}>
    ${busy ? html`<span class="c-btn-spin" aria-hidden="true"></span>` : icon ? html`<${Icon} name=${icon} size="sm" />` : null}
    <span class="c-btn-label">${label}</span>
  </button>`;
}

/** 絵だけのボタンの名前（空なら例外）。件数があれば「（3 件）」を足す */
export function iconButtonLabel(label, badge) {
  if (typeof label !== "string" || label === "") throw new TypeError("IconButton の label が要る");
  const text = badgeText(badge);
  return text === "" ? label : `${label}（${text} 件）`;
}

export function IconButton({ icon, label, size = "md", badge = 0, badgeTone = "warning", disabled = false, onPress }) {
  const sz = size === "sm" ? "sm" : "md";
  return html`<button class="c-iconbtn" type="button" data-size=${sz}
      aria-label=${iconButtonLabel(label, badge)} title=${label} aria-disabled=${disabled ? "true" : undefined}
      onClick=${(event) => {
        if (disabled) {
          event.preventDefault();
          return;
        }
        if (onPress) onPress();
      }}>
    <${Icon} name=${icon} size=${sz} />
    <${Badge} count=${badge} tone=${badgeTone} />
  </button>`;
}

/** 件数の文。数でない・1 未満は ""、100 以上は 99+ */
export function badgeText(count) {
  if (typeof count !== "number" || Number.isNaN(count) || count < 1) return "";
  const n = Math.floor(count);
  return n >= 100 ? "99+" : String(n);
}

const BADGE_TONES = ["warning", "accent", "muted"];

export function Badge({ count, tone = "warning" }) {
  const text = badgeText(count);
  if (text === "") return null;
  return html`<span class="c-badge" data-tone=${BADGE_TONES.includes(tone) ? tone : "warning"}>${text}</span>`;
}

/** 印: 判断待ち（turn）・作業中（running）・未読（unread）・なし（none。幅は取る） */
export const MARK_STATES = Object.freeze(["turn", "running", "unread", "none"]);

export function markState(state) {
  return MARK_STATES.includes(state) ? state : "none";
}

/** 色だけの違いなので、意味は隣の文か label で言葉にする（label が無ければ読み上げない） */
export function Mark({ state = "none", label }) {
  return html`<span class="c-mark" data-state=${markState(state)} role=${label ? "img" : undefined}
      aria-label=${label || undefined} aria-hidden=${label ? undefined : "true"}></span>`;
}

/** Tab で入る項目。value が押せればそれ、違えば最初の押せる項目、無ければ null */
export function segmentedTabStop(items, value) {
  const current = items.find((item) => item.value === value);
  if (current && !current.disabled) return current.value;
  const first = items.find((item) => !item.disabled);
  return first ? first.value : null;
}

/** キーで動く先（押せない項目を飛ばし、端で折り返す）。動かないときは null */
export function segmentedKey(items, current, key) {
  const enabled = items.map((item, index) => ({ item, index })).filter(({ item }) => !item.disabled);
  if (enabled.length === 0) return null;
  const at = items.findIndex((item) => item.value === current);
  let next;
  if (key === "Home") next = enabled[0];
  else if (key === "End") next = enabled[enabled.length - 1];
  else if (key === "ArrowRight" || key === "ArrowDown") next = enabled.find(({ index }) => index > at) || enabled[0];
  else if (key === "ArrowLeft" || key === "ArrowUp") next = [...enabled].reverse().find(({ index }) => at >= 0 && index < at) || enabled[enabled.length - 1];
  else return null;
  return next.item.value === current ? null : next.item.value;
}

/** いくつかから 1 つを選ぶ切り替え（radiogroup）。折り返さず、入りきらなければ横に送る */
export function Segmented({ items, value, onChange, label }) {
  const stop = segmentedTabStop(items, value);
  const onKey = (event) => {
    const from = event.target.closest(".c-seg-item");
    if (!from) return;
    const next = segmentedKey(items, from.dataset.value, event.key);
    if (next === null) return;
    event.preventDefault();
    const el = [...event.currentTarget.children].find((child) => child.dataset.value === next);
    if (el) {
      el.focus();
      el.scrollIntoView({ block: "nearest", inline: "nearest" });
    }
    onChange(next);
  };
  return html`<div class="c-seg" role="radiogroup" aria-label=${label} onKeyDown=${onKey}>
    ${items.map(
      (item) => html`<button class="c-seg-item" type="button" role="radio" key=${item.value} data-value=${item.value}
          aria-checked=${item.value === value ? "true" : "false"}
          aria-disabled=${item.disabled ? "true" : undefined}
          tabindex=${item.value === stop ? 0 : -1}
          onClick=${(event) => {
            if (item.disabled || item.value === value) return;
            event.currentTarget.scrollIntoView({ block: "nearest", inline: "nearest" });
            onChange(item.value);
          }}>
        <span class="c-seg-label">${item.label}</span>
      </button>`,
    )}
  </div>`;
}

/** 入力欄に付ける属性（id・クラス・説明と誤りの結び付き） */
export function fieldControl(id, { hint, error } = {}) {
  const described = [hint ? `${id}-hint` : "", error ? `${id}-error` : ""].filter((s) => s !== "").join(" ");
  return { id, class: "c-input", "aria-describedby": described === "" ? undefined : described, "aria-invalid": error ? "true" : undefined };
}

/** children は (control) => vnode。誤りの入れ物は空でも置く（出たときに読まれ、下がずれない） */
export function Field({ id, label, hint, error, children }) {
  return html`<div class="c-field">
    <label class="c-field-label" for=${id}>${label}</label>
    ${children(fieldControl(id, { hint, error }))}
    ${hint ? html`<p class="c-field-hint" id=${id + "-hint"}>${hint}</p>` : null}
    <p class="c-field-error" id=${id + "-error"} role="alert">${error || ""}</p>
  </div>`;
}

/** 何も無いときの文（action は Button などの vnode） */
export function Empty({ text, action }) {
  return html`<div class="c-empty"><p class="c-empty-text">${text}</p>${action || null}</div>`;
}

/** 読み込み中の文（aria-busy は読み込んでいる入れ物の側に付ける） */
export function Loading({ text = "読み込んでいます…", action }) {
  return html`<div class="c-loading" role="status"><p class="c-loading-text">${text}</p>${action || null}</div>`;
}
