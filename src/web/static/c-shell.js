// 殻の部品（docs/plan/web-ui-components.md §6 の K3）: BottomBar とそのモデルの関数。
// hook を使わない（Node から関数として呼べる）。どの形にするか（variant）は入口が決めて渡す。クラスは固定の文字列、状態は data-* と aria-*
import { html } from "./c-lib.js";
import { Badge, Button, Icon, badgeText } from "./c-atoms.js";

const HAND = "右腕に頼む・訊く";

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
    const list = Array.isArray(tabs) ? tabs : [];
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

/** 下のバー（一覧の列の中。スクロールの入れ物の下の兄弟に置く）。on: { list(), hand(opener), tab(id), more(opener) } */
export function BottomBar({ variant, turns, hand, tabs, on }) {
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
        return html`<button class="c-bottom-hand" key="hand" type="button" data-act="hand" aria-label=${item.name} onClick=${(event) => on.hand(event.currentTarget)}>
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
