// 部品の見本のページ（/static/gallery.html。docs/plan/web-ui-components.md §9 の K1・K2）。部品の状態を並べ、ui-shots が撮る。
// 認証の前に配られるので、個人の情報と API の呼び出しを入れない。data-section・data-demo は ui-shots が要素を探す印（CSS では使わない）
import { html, render, useRef, useState } from "./c-lib.js";
import { Badge, Button, Empty, Field, IconButton, Loading, Mark, Segmented } from "./c-atoms.js";
import { Confirm, Sheet, Toast } from "./c-sheet.js";

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

function Section({ name, title, children }) {
  return html`<section class="c-gallery-section" data-section=${name}>
    <h2 class="c-gallery-heading">${title}</h2>
    ${children}
  </section>`;
}

const KINDS = [
  ["primary", "始める"],
  ["accent", "送る"],
  ["secondary", "開く"],
  ["ghost", "ほか"],
  ["danger", "消す"],
];

function Buttons() {
  return html`<${Section} name="button" title="ボタン">
    <div class="c-gallery-row">${KINDS.map(([kind, label]) => html`<${Button} kind=${kind} label=${label} />`)}</div>
    <div class="c-gallery-row">
      <${Button} kind="accent" icon="send" label="送る" />
      <${Button} kind="secondary" icon="plus" label="話題" />
    </div>
    <div class="c-gallery-row">${KINDS.map(([kind, label]) => html`<${Button} kind=${kind} label=${label} disabled=${true} reason="今は送れません" />`)}</div>
    <div class="c-gallery-row">
      <${Button} kind="primary" label="送っています…" busy=${true} />
      <${Button} kind="secondary" label="読み込んでいます…" busy=${true} />
    </div>
    <div class="c-gallery-row">
      ${KINDS.map(([kind, label]) => html`<${Button} kind=${kind} size="sm" label=${label} />`)}
      <${Button} kind="secondary" size="sm" label="開く" disabled=${true} reason="今は送れません" />
    </div>
    <div class="c-gallery-narrow">
      <${Button} kind="secondary" label="とても長い題の話題を開いて、そのまま続きの作業を頼む" />
    </div>
  <//>`;
}

function IconButtons() {
  return html`<${Section} name="iconbutton" title="絵のボタン">
    <div class="c-gallery-row">
      <${IconButton} icon="search" label="探す" />
      <${IconButton} icon="plus" label="足す" />
      <${IconButton} icon="ellipsis" label="ほか" />
      <${IconButton} icon="x" label="閉じる" />
      <${IconButton} icon="chevron-left" label="戻る" />
    </div>
    <div class="c-gallery-row">
      <${IconButton} icon="plus" size="sm" label="足す" />
      <${IconButton} icon="x" size="sm" label="閉じる" />
      <${IconButton} icon="bell" label="知らせ" badge=${3} />
      <${IconButton} icon="bell" label="知らせ" badge=${12} />
      <${IconButton} icon="settings" label="設定" disabled=${true} />
    </div>
  <//>`;
}

function Badges() {
  return html`<${Section} name="badge" title="件数">
    <div class="c-gallery-row">
      ${[1, 12, 99, 100].map((n) => html`<${Badge} count=${n} />`)}
      <${Badge} count=${3} tone="accent" />
      <${Badge} count=${3} tone="muted" />
    </div>
    <p class="c-gallery-note">0 件のときは何も出しません</p>
  <//>`;
}

const MARKS = [
  ["turn", "判断待ち"],
  ["running", "作業中"],
  ["unread", "未読"],
  ["none", "印なし"],
];

function Marks() {
  return html`<${Section} name="mark" title="印">
    ${MARKS.map(
      ([state, text]) => html`<div class="c-gallery-row">
        <${Mark} state=${state} />
        <p class="c-gallery-note">${text}</p>
      </div>`,
    )}
  <//>`;
}

function SegDemo({ items, first, label }) {
  const [value, setValue] = useState(first);
  return html`<${Segmented} items=${items} value=${value} onChange=${setValue} label=${label} />`;
}

const SEG_2 = [
  { value: "talk", label: "話す" },
  { value: "files", label: "ファイル" },
];
const SEG_3 = [
  { value: "list", label: "一覧" },
  { value: "talk", label: "会話" },
  { value: "settings", label: "設定", disabled: true },
];
const SEG_6 = [
  { value: "talk", label: "話す" },
  { value: "diff", label: "差分" },
  { value: "files", label: "ファイル" },
  { value: "screen", label: "端末の写し" },
  { value: "perms", label: "許可の履歴" },
  { value: "settings", label: "設定" },
];

function Segments() {
  return html`<${Section} name="segmented" title="切り替え">
    <div><${SegDemo} items=${SEG_2} first="talk" label="見る物" /></div>
    <div><${SegDemo} items=${SEG_3} first="list" label="画面" /></div>
    <div data-demo="seg-6"><${SegDemo} items=${SEG_6} first="talk" label="タブ" /></div>
  <//>`;
}

function Fields() {
  return html`<${Section} name="field" title="入力欄">
    <${Field} id="g-title" label="題名" hint="省くと最初の一言から付けます">${(c) => html`<input ...${c} type="text" />`}<//>
    <${Field} id="g-title2" label="題名" error="題名を入れてください">${(c) => html`<input ...${c} type="text" />`}<//>
    <${Field} id="g-body" label="最初の一言">${(c) => html`<textarea ...${c} rows="3"></textarea>`}<//>
    <${Field} id="g-place" label="場所">
      ${(c) => html`<select ...${c}>
        <option value="none">なし</option>
        <option value="alpha">alpha</option>
        <option value="beta">beta</option>
      </select>`}
    <//>
    <${Field} id="g-locked" label="作った日" hint="変えられません">${(c) => html`<input ...${c} type="text" value="2026-01-01" disabled />`}<//>
  <//>`;
}

function Empties() {
  return html`<${Section} name="empty" title="空・読み込み">
    <${Empty} text="まだ話題がありません" />
    <${Empty} text="まだ話題がありません" action=${html`<${Button} kind="secondary" label="話題を始める" />`} />
    <${Loading} />
  <//>`;
}

const LONG_TITLE = "月末にまとめて払う分の領収書を写真から読み取り、店の名前と金額と日付を表にして、去年の同じ月と比べて増えた所を短く書き出し、気になる出費があれば理由の見当も添えて、来月の予算の案まで一緒に考えてもらうための長い題の話題";

/** 押す物（data-demo を包む span。ui-shots が押す） */
function Opener({ demo, label, onPress }) {
  return html`<span data-demo=${demo}><${Button} kind="secondary" label=${label} onPress=${onPress} /></span>`;
}

/** 板・確認・知らせ（知らせは push で根の入れ物に足す） */
function Sheets({ push }) {
  const [open, setOpen] = useState(null);
  const [result, setResult] = useState("まだ何もしていません");
  const finish = (text) => {
    setOpen(null);
    setResult(text);
  };
  return html`<${Section} name="sheet" title="板・確認・知らせ">
    <div class="c-gallery-row">
      <${Opener} demo="sheet" label="板を開く" onPress=${() => setOpen("sheet")} />
      <${Opener} demo="confirm" label="確認を開く" onPress=${() => setOpen("confirm")} />
      <${Opener} demo="confirm-danger" label="消す確認を開く" onPress=${() => setOpen("confirm-danger")} />
      <${Opener} demo="toast" label="知らせを出す" onPress=${() => push({ text: "保存しました" })} />
      <${Opener}
        demo="toast-error"
        label="失敗の知らせを出す"
        onPress=${() => push({ text: "保存できませんでした。つながりを確かめてください", level: "error", actionLabel: "もう一度", onAction: () => setResult("もう一度を押した") })}
      />
    </div>
    <p class="c-gallery-result">${result}</p>
    <${Sheet}
      open=${open === "sheet"}
      id="g-sheet"
      title="新しい話題"
      onClose=${() => finish("閉じた")}
      footer=${html`<${Button} kind="secondary" label="やめる" onPress=${() => finish("やめた")} /><${Button} kind="primary" label="始める" onPress=${() => finish("実行した")} />`}
    >
      <${Field} id="g-new-title" label="題名" hint="省くと最初の一言から付けます">${(c) => html`<input ...${c} type="text" />`}<//>
    <//>
    <${Confirm}
      open=${open === "confirm"}
      id="g-confirm"
      title="始めますか"
      body="新しい話題を作ります。"
      okLabel="始める"
      onOk=${() => finish("実行した")}
      onCancel=${() => finish("やめた")}
    />
    <${Confirm}
      open=${open === "confirm-danger"}
      id="g-confirm-danger"
      title="消しますか"
      target=${LONG_TITLE}
      body="元に戻せません。"
      okLabel="消す"
      danger=${true}
      onOk=${() => finish("実行した")}
      onCancel=${() => finish("やめた")}
    />
  <//>`;
}

/** 知らせの入れ物は見本の根の直下に 1 つ（自動では消さない。× で消す） */
function Gallery() {
  const [toasts, setToasts] = useState([]);
  const seq = useRef(0);
  const push = (item) => {
    seq.current += 1;
    const id = `t${seq.current}`;
    setToasts((list) => [...list, { ...item, id }]);
  };
  const dismiss = (id) => setToasts((list) => list.filter((item) => item.id !== id));
  return html`
    <h1 class="c-gallery-title">部品の見本</h1>
    <p class="c-gallery-note">Preact + htm で描いています</p>
    <${Counter} />
    <${Buttons} />
    <${IconButtons} />
    <${Badges} />
    <${Marks} />
    <${Segments} />
    <${Fields} />
    <${Empties} />
    <${Sheets} push=${push} />
    <${Toast} items=${toasts} onDismiss=${dismiss} />
  `;
}

applyTheme();
render(html`<${Gallery} />`, document.getElementById("gallery"));
