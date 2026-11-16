// 部品の見本のページ（/static/gallery.html。docs/plan/web-ui-components.md §9 の K1〜K4）。部品の状態を並べ、ui-shots が撮る。
// 認証の前に配られるので、個人の情報と API の呼び出しを入れない。data-section・data-demo は ui-shots が要素を探す印（CSS では使わない）
import { html, render, useRef, useState } from "./c-lib.js";
import { Badge, Button, Empty, Field, IconButton, Loading, Mark, Segmented } from "./c-atoms.js";
import { Confirm, Sheet, Toast } from "./c-sheet.js";
import { TopicList, YourTurn, listModel } from "./c-list.js";
import { BottomBar, TopBar } from "./c-shell.js";

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

// ===== 一覧と下のバー（K3）。データは作り物 =====

/** 一覧の形（行の高さ・[+] の大きさ・あなたの番の形）は、読み込みのときに 1 回だけ tokens.css の PC の上書きと同じ式で決める */
const COMPACT = window.matchMedia("(min-width: 640px) and (hover: hover) and (pointer: fine)").matches;

const LONG_TOPIC = "月末の領収書を写真から読み取って店と金額と日付の表にまとめ、去年の同じ月と比べて増えた所を短く書き出して残しておく話題。";
const LONG_SUMMARY = "見本の作業で使うコマンドを実行してよいか確かめています。対象は見本のプロジェクトの中のファイルだけで、外には全く出ません";
const AT = "2026-01-01T03:00:00Z";

const gTopic = (o) => ({ group: "p:a", origin: "session", persona: null, mark: null, turn: null, state: "active", activityAt: AT, last: null, ...o });
const gGroup = (o) => ({ kind: "project", turns: 0, running: 0, open: 0, done: 0, hasTopics: true, ...o });
const gTurn = (kind, summary) => ({ kind, summary, since: AT, expiresAt: null });

const FULL_DATA = {
  turns: 2,
  turnIds: ["ch:1", "ch:20"],
  groups: [
    gGroup({ key: "p:a", name: "見本のプロジェクト A", turns: 1, running: 1, open: 8, done: 3 }),
    gGroup({ key: "p:b", name: "見本のプロジェクト B", open: 1, done: 60 }),
    gGroup({ key: "p:c", name: "見本のプロジェクト C", done: 1 }),
    gGroup({ key: "p:d", name: "見本のプロジェクト D", hasTopics: false }),
    gGroup({ key: "general", kind: "general", name: "General" }),
  ],
  topics: [
    gTopic({ id: "ch:1", title: "見本の家計の話題", mark: "turn", turn: gTurn("permission", LONG_SUMMARY) }),
    gTopic({ id: "cc:2", title: "見本の作業中の話題", mark: "running", origin: "cc" }),
    gTopic({ id: "ch:3", title: "見本の未読の話題" }),
    gTopic({ id: "ch:4", title: "見本の読んだ話題" }),
    gTopic({ id: "ch:5", title: LONG_TOPIC }),
    gTopic({ id: "ch:6", title: "見本の選んでいる話題" }),
    gTopic({ id: "ch:7", title: "見本の人格の話題", persona: "見本の人格" }),
    gTopic({ id: "cc:8", title: "見本の端末の話題", origin: "cc" }),
    gTopic({ id: "ch:9", title: "見本の終わった話題 1", state: "done" }),
    gTopic({ id: "ch:10", title: "見本の終わった話題 2", state: "done" }),
    gTopic({ id: "ch:11", title: "見本の終わった話題 3", state: "done" }),
    gTopic({ id: "ch:12", group: "p:b", title: "見本の B の話題" }),
    gTopic({ id: "ch:13", group: "p:b", title: "見本の B の終わった話題 1", state: "done" }),
    gTopic({ id: "ch:14", group: "p:b", title: "見本の B の終わった話題 2", state: "done" }),
  ],
  rightHands: [{ id: "ch:20", guildId: "g1", title: "右腕", turn: gTurn("question", "見本の質問"), last: null, link: "" }],
  cc: { enabled: true, stale: false, unreadable: false },
};

const QUIET_DATA = {
  turns: 0,
  turnIds: [],
  groups: [gGroup({ key: "p:a", name: "見本のプロジェクト A", open: 2, done: 4 }), gGroup({ key: "p:b", name: "見本のプロジェクト B" }), gGroup({ key: "general", kind: "general", name: "General", open: 1 })],
  topics: [
    gTopic({ id: "ch:1", title: "見本の読んだ話題 1" }),
    gTopic({ id: "ch:2", title: "見本の読んだ話題 2" }),
    gTopic({ id: "ch:3", group: "general", title: "見本の場所を決めていない話題" }),
  ],
  rightHands: [],
  cc: { enabled: true, stale: false, unreadable: false },
};

const listState = (data, o = {}) => ({
  data,
  failed: false,
  filter: "",
  current: null,
  doneGroup: null,
  dataDone: null,
  othersOpen: false,
  isUnread: () => false,
  time: () => "12:34",
  ago: () => "1 分前",
  ...o,
});

const noop = () => undefined;
const LIST_ON = { open: noop, add: noop, toggleDone: noop, toggleOthers: noop, retry: noop };

/** 完了を開いておけるのは 1 つなので、B の群だけ B の完了を開いたモデルから取る（見本で 2 つの開いた形を並べるため） */
function fullModel() {
  const base = { current: "ch:6", othersOpen: true, isUnread: (channel) => channel === "3" };
  const a = listModel(listState(FULL_DATA, { ...base, doneGroup: "p:a", dataDone: "p:a" }));
  const b = listModel(listState(FULL_DATA, { ...base, doneGroup: "p:b", dataDone: "p:b" }));
  return { ...a, blocks: a.blocks.map((block) => (block.key === "p:b" ? b.blocks.find((x) => x.key === "p:b") : block)) };
}

function Pane({ demo, children }) {
  return html`<div data-demo=${demo}><div class="c-gallery-pane">${children}</div></div>`;
}

function ListDemo({ demo, model, on = LIST_ON }) {
  return html`<${Pane} demo=${demo}><${TopicList} model=${model} compact=${COMPACT} on=${on} /><//>`;
}

function Lists() {
  const [result, setResult] = useState("まだ押していません");
  return html`<${Section} name="list" title="一覧">
    <${ListDemo} demo="list-full" model=${fullModel()} />
    <${ListDemo} demo="list-quiet" model=${listModel(listState(QUIET_DATA))} />
    <${Pane} demo="turns-other"><${YourTurn} turns=${listModel(listState(FULL_DATA)).turns} compact=${!COMPACT} onOpen=${noop} /><//>
    <${ListDemo} demo="list-loading" model=${listModel(listState(null))} />
    <${ListDemo} demo="list-failed" model=${listModel(listState(null, { failed: true }))} on=${{ ...LIST_ON, retry: () => setResult("押した") }} />
    <p class="c-gallery-result">${result}</p>
    <${ListDemo} demo="list-stale" model=${listModel(listState(QUIET_DATA, { failed: true }))} />
    <${ListDemo} demo="list-nohit" model=${listModel(listState(QUIET_DATA, { filter: "当たらない語" }))} />
    <${ListDemo} demo="list-done-loading" model=${listModel(listState(QUIET_DATA, { doneGroup: "p:a" }))} />
  <//>`;
}

// ===== 会話の見出し（K4）。データは作り物 =====

const LONG_HEAD = "長い題の見本。".repeat(9).slice(0, 60);
const LONG_PLACE = "見本の長い名前のプロジェクトをここに置いて幅を見るための場所";
const TOP_WIDE_CC = {
  variant: "wide",
  view: "talk",
  title: "cc-self-agent",
  status: { text: "判断待ち", tone: "warning" },
  place: { text: "self-agent", movable: false, reason: "Claude Code のセッションは場所を変えられません" },
  views: { value: "talk" },
  menu: true,
};
// 帯に全部を出す広い幅の一番きつい形（状態の語が一番長い）
const TOP_WIDE_LONG = {
  variant: "wide",
  view: "talk",
  title: LONG_HEAD,
  status: { text: "あなたの番", tone: "warning" },
  note: "調べ物（人格）",
  place: { text: LONG_PLACE, movable: true },
  views: { value: "pane" },
  menu: true,
};
/** box: 入れ物（pane は一覧と同じ、full は広い幅の見出しが全部を出せる下限の幅ちょうど、list は一覧の列の幅ちょうど） */
const TOP_DEMOS = [
  { demo: "top-phone-talk", variant: "phone", view: "talk", title: "日程の取得が遅い", status: { text: "あなたの番", tone: "warning" }, place: { text: "General", movable: true }, menu: true, hand: "turn" },
  {
    demo: "top-phone-long",
    variant: "phone",
    view: "talk",
    title: LONG_HEAD,
    status: { text: "作業中", tone: "accent" },
    place: { text: "kakeibo-app", movable: true },
    note: "調べ物（人格）",
    menu: true,
    hand: "unread",
  },
  { demo: "top-phone-other", variant: "phone", view: "other", title: "設定", hand: null },
  { demo: "top-wide-talk", box: "full", variant: "wide", view: "talk", title: "日程の取得が遅い", status: { text: "待ち", tone: "muted" }, place: { text: "escape-mcp", movable: true }, menu: true },
  { demo: "top-wide-cc", box: "full", ...TOP_WIDE_CC },
  { demo: "top-wide-long", box: "full", ...TOP_WIDE_LONG },
  {
    demo: "top-wide-short",
    box: "full",
    variant: "wide",
    view: "talk",
    title: "RSS",
    status: { text: "作業中", tone: "accent" },
    note: "調べ物（人格）",
    place: { text: "General", movable: true },
    menu: true,
  },
  { demo: "top-wide-other", box: "full", variant: "wide", view: "other", title: "ナレッジ" },
  { demo: "top-compact-cc", box: "list", ...TOP_WIDE_CC, compact: true },
  { demo: "top-compact-long", box: "list", ...TOP_WIDE_LONG, compact: true },
];

/** 幅を決めた入れ物（スマホの幅でページが横に動かないよう、横に送れる包みの中） */
function FixedPane({ demo, box, children }) {
  return html`<div class="c-gallery-slide" data-demo=${demo}>
    ${box === "full" ? html`<div class="c-gallery-pane c-gallery-top-full">${children}</div>` : html`<div class="c-gallery-pane c-gallery-top-list">${children}</div>`}
  </div>`;
}

/** 押した物を結果の欄に書く（切り替えは選んだ value も書く。opener は書かない） */
function Tops() {
  const [result, setResult] = useState("まだ押していません");
  const on = {
    back: () => setResult("一覧へを押した"),
    place: () => setResult("場所を押した"),
    view: (value) => setResult(`切り替えた: ${value}`),
    menu: () => setResult("ほかの操作を押した"),
    hand: () => setResult("右腕を押した"),
  };
  return html`<${Section} name="top" title="見出し（TopBar）">
    ${TOP_DEMOS.map(({ demo, box, ...props }) =>
      box === undefined
        ? html`<${Pane} demo=${demo}><${TopBar} ...${props} on=${on} /><//>`
        : html`<${FixedPane} demo=${demo} box=${box}><${TopBar} ...${props} on=${on} /><//>`,
    )}
    <p class="c-gallery-result">${result}</p>
  <//>`;
}

const BOTTOM_ON = { list: noop, hand: noop, tab: noop, more: noop };
const WIDE_TABS = [
  { id: "tasks", title: "タスク" },
  { id: "reminders", title: "リマインド" },
];

function Bottoms() {
  return html`<${Section} name="bottom" title="下のバー">
    <${Pane} demo="bottom-phone"><${BottomBar} variant="phone" turns=${2} hand="turn" on=${BOTTOM_ON} /><//>
    <${Pane} demo="bottom-phone-quiet"><${BottomBar} variant="phone" turns=${0} hand=${null} on=${BOTTOM_ON} /><//>
    <${Pane} demo="bottom-phone-unread"><${BottomBar} variant="phone" turns=${120} hand="unread" on=${BOTTOM_ON} /><//>
    <${Pane} demo="bottom-wide"><${BottomBar} variant="wide" tabs=${WIDE_TABS} on=${BOTTOM_ON} /><//>
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
    <${Lists} />
    <${Tops} />
    <${Bottoms} />
    <${Toast} items=${toasts} onDismiss=${dismiss} />
  `;
}

applyTheme();
render(html`<${Gallery} />`, document.getElementById("gallery"));
