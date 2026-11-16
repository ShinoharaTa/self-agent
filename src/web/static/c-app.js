// 新しい殻（v3.html）の部品の入口（docs/plan/web-ui-components.md §9 の K3）。状態は topics.js が持ち、SA.list.draw(state) で押し込む。
// 部品の c-*.js のうち document・window・SA に触るのはここだけ（見本の c-gallery.js は別）。文は部品とモデルが持ち、ここには書かない
import { html, render } from "./c-lib.js";
import { TopicList, listKey, listModel } from "./c-list.js";

const listRoot = document.getElementById("c-list-root");

if (listRoot) {
  // PC の式はトークンの上書き（tokens.css）・見本の compact と同じ
  const env = { fine: window.matchMedia("(min-width: 640px) and (hover: hover) and (pointer: fine)") };
  /** 最後に描いた state（幅・指の変化で描き直す） */
  let lastState = null;

  /** 一覧の根（.c-list。tabindex="-1"）。まだ描いていなければ null */
  const rootEl = () => listRoot.firstElementChild;
  const rows = () => Array.from(listRoot.querySelectorAll("button[data-topic]"));

  /** 同じ話題の行のうち、群の中の行（data-mark の付いた物）を先に。セレクタに id を埋めない */
  function rowFor(id) {
    const same = rows().filter((b) => b.dataset.topic === id);
    return same.find((b) => b.hasAttribute("data-mark")) || same[0] || null;
  }

  function draw(state) {
    lastState = state;
    const before = document.activeElement;
    const inside = !!before && listRoot.contains(before);
    const topic = inside && before.matches("button[data-topic]") ? before.dataset.topic : null;
    const root = rootEl();
    const top = root ? root.scrollTop : 0;
    try {
      const model = listModel(state);
      render(html`<${TopicList} model=${model} compact=${env.fine.matches} on=${state.on} />`, listRoot);
    } catch {
      console.error("[web] list draw failed");
      return false;
    }
    const after = rootEl();
    if (after && after.scrollTop !== top) after.scrollTop = top;
    if (!inside) return true;
    if (document.contains(before)) {
      if (document.activeElement !== before) before.focus({ preventScroll: true });
    } else {
      // 行が消えた（[もう一度読む]・PC の件数のボタンも）: 同じ話題の行へ、無ければ一覧の根へ（body に落とさない）
      const row = topic === null ? null : rowFor(topic);
      if (row) row.focus({ preventScroll: true });
      else if (after) after.focus({ preventScroll: true });
    }
    return true;
  }

  function focusRow(id) {
    const row = rowFor(id);
    if (!row) return false;
    row.focus({ preventScroll: true });
    return true;
  }

  function focusList() {
    const root = rootEl();
    if (root) root.focus();
  }

  function scrollTop() {
    const root = rootEl();
    return root ? root.scrollTop : 0;
  }

  function setScrollTop(n) {
    const root = rootEl();
    if (root) root.scrollTop = n;
  }

  // ↑↓・Home・End で行を動かす（修飾キー付きは素通し。完了の見出し・[+]・件数のボタンでは動かさない）
  listRoot.addEventListener("keydown", (event) => {
    if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
    const row = event.target instanceof Element ? event.target.closest("button[data-topic]") : null;
    if (!row || !listRoot.contains(row)) return;
    const all = rows();
    const to = listKey(event.key, all.length, all.indexOf(row));
    if (to === undefined) return;
    event.preventDefault();
    if (to !== null) all[to].focus();
  });

  env.fine.addEventListener("change", () => {
    if (lastState) draw(lastState);
  });

  window.SA = window.SA || {};
  window.SA.list = { draw, focusRow, focusList, scrollTop, setScrollTop };
}
