// 右腕の部品（docs/plan/web-ui-components.md §6 の K6）: 見出し HandHead。hook を使わない（Node から関数として呼べる）。状態は持たない。
// 右腕の中の会話・入力欄・カードは c-talk・c-composer・c-cards の部品を使う（札 Refs は会話の行なので c-talk.js に置く）
import { html } from "./c-lib.js";
import { Button, IconButton } from "./c-atoms.js";

/**
 * 右腕の見出し。題は h2（ページの h1 は列 2 の見出しの 1 つ）。menu が true のときだけ「…」（押すと on.menu(押したボタン)）、いつも［畳む］（on.close()。読み上げの名前は「<題>を畳む」）
 */
export function HandHead({ title, menu = false, on }) {
  return html`<header class="c-hand-head">
    <h2 class="c-hand-title" key="title">${title}</h2>
    ${menu ? html`<span class="c-hand-act" key="menu" data-act="menu"><${IconButton} icon="ellipsis" label="ほかの操作" onPress=${(event) => on.menu(event.currentTarget)} /></span>` : null}
    <span class="c-hand-act" key="close" data-act="close"><${Button} kind="ghost" size="sm" label="畳む" name=${title + "を畳む"} onPress=${() => on.close()} /></span>
  </header>`;
}
