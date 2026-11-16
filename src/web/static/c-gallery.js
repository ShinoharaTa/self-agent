// 部品の見本のページ（/static/gallery.html。docs/plan/web-ui-components.md §9 の K1）。K2 から部品をここに並べる。
// 認証の前に配られるので、個人の情報と API の呼び出しを入れない
import { html, render, useState } from "./c-lib.js";

// テーマ: shell.js と同じ（localStorage の self-agent-web:theme。dark・light は data-theme、system は外して OS に合わせる。読めなければ dark）
const THEMES = ["dark", "light", "system"];

function applyTheme() {
  let theme = "dark";
  try {
    const v = window.localStorage.getItem("self-agent-web:theme");
    if (THEMES.includes(v)) theme = v;
  } catch {
    // 読めない環境では既定のまま
  }
  const root = document.documentElement;
  if (theme === "system") delete root.dataset.theme;
  else root.dataset.theme = theme;
}

/** hook が動くことを見せる数え札 */
function Counter() {
  const [count, setCount] = useState(0);
  return html`<button class="c-gallery-count" type="button" onClick=${() => setCount((n) => n + 1)}>押した回数: ${count}</button>`;
}

function Gallery() {
  return html`
    <h1 class="c-gallery-title">部品の見本</h1>
    <p class="c-gallery-note">Preact + htm で描いています</p>
    <${Counter} />
  `;
}

applyTheme();
render(html`<${Gallery} />`, document.getElementById("gallery"));
