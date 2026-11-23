// 部品の見本のページ（/static/gallery.html。docs/plan/web-ui-components.md §9 の K1〜K6 と、端末のセッションの札）。部品の状態を並べ、ui-shots が撮る。
// 認証の前に配られるので、個人の情報と API の呼び出しを入れない。data-section・data-demo は ui-shots が要素を探す印（CSS では使わない）
import { html, render, useRef, useState } from "./c-lib.js";
import { Badge, Button, Empty, Field, IconButton, Loading, Mark, Segmented } from "./c-atoms.js";
import { Confirm, Sheet, Toast } from "./c-sheet.js";
import { TopicList, YourTurn, listModel } from "./c-list.js";
import { BottomBar, TopBar } from "./c-shell.js";
import { TalkTimeline, parseBlocks, talkModel } from "./c-talk.js";
import { Composer, composerModel } from "./c-composer.js";
import { Cards } from "./c-cards.js";
import { HandHead } from "./c-hand.js";
import { TermCard, termView } from "./c-term.js";
import { Deck, DeckBand, deckModel } from "./c-deck.js";

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
    gGroup({ key: "p:a", name: "見本のプロジェクト A", turns: 1, running: 1, open: 11, done: 3 }),
    gGroup({ key: "p:b", name: "見本のプロジェクト B", open: 1, done: 60 }),
    gGroup({ key: "p:c", name: "見本のプロジェクト C", done: 1 }),
    gGroup({ key: "p:d", name: "見本のプロジェクト D", hasTopics: false }),
    gGroup({ key: "general", kind: "general", name: "General" }),
  ],
  topics: [
    gTopic({ id: "ch:1", title: "見本の家計の話題", mark: "turn", turn: gTurn("permission", LONG_SUMMARY) }),
    gTopic({ id: "cc:2", title: "見本の作業中の話題", mark: "running", origin: "cc" }),
    gTopic({ id: "ch:31", title: "見本の順番待ちの話題", queued: true }),
    gTopic({ id: "ch:32", title: "見本の上限で止まった話題", stopped: true, ended: "max_turns" }),
    gTopic({ id: "ch:33", title: "見本の中断した話題", stopped: true, ended: "aborted" }),
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
  // プロジェクトのセッションの許可のモード（押せる形と、作業中で押せない形）
  {
    demo: "top-wide-mode",
    box: "full",
    variant: "wide",
    view: "talk",
    title: "README を直す",
    place: { text: "self-agent", movable: true },
    mode: { value: "plan", disabled: false, reason: null },
    menu: true,
  },
  {
    demo: "top-wide-mode-busy",
    box: "full",
    variant: "wide",
    view: "talk",
    title: "README を直す",
    status: { text: "作業中", tone: "accent" },
    place: { text: "self-agent", movable: false, reason: "担当が作業中です。終わってから変えてください" },
    mode: { value: "default", disabled: true, reason: "担当が作業中です。終わってから変えてください" },
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
    mode: () => setResult("許可のモードを押した"),
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

const BOTTOM_ON = { list: noop, hand: noop, tab: noop, more: noop, page: noop };
/** スマホの流れの列の下のバーの列（名前は列のモデルの物。数は あなたの番 だけ） */
const deckPages = (turns) => deckModel({ cols: 1 }).columns.map((c) => ({ id: c.id, label: c.name, count: c.id === "turn" ? turns : null }));
const WIDE_TABS = [
  { id: "tasks", title: "タスク" },
  { id: "reminders", title: "リマインド" },
];

/** スマホの幅（外側 390）の入れ物。見本の列より広ければ包みの中で横に送る */
function PhonePane({ demo, children }) {
  return html`<div class="c-gallery-slide" data-demo=${demo}><div class="c-gallery-pane c-gallery-phone">${children}</div></div>`;
}

function Bottoms() {
  return html`<${Section} name="bottom" title="下のバー">
    <${Pane} demo="bottom-phone"><${BottomBar} variant="phone" turns=${2} hand="turn" on=${BOTTOM_ON} /><//>
    <${Pane} demo="bottom-phone-quiet"><${BottomBar} variant="phone" turns=${0} hand=${null} on=${BOTTOM_ON} /><//>
    <${Pane} demo="bottom-phone-unread"><${BottomBar} variant="phone" turns=${120} hand="unread" on=${BOTTOM_ON} /><//>
    <${Pane} demo="bottom-wide"><${BottomBar} variant="wide" tabs=${WIDE_TABS} on=${BOTTOM_ON} /><//>
    <${PhonePane} demo="bottom-deck"><${BottomBar} variant="deck" pages=${deckPages(12)} page="turn" hand="turn" on=${BOTTOM_ON} /><//>
    <${PhonePane} demo="bottom-deck-quiet"><${BottomBar} variant="deck" pages=${deckPages(0)} page="feed" hand=${null} on=${BOTTOM_ON} /><//>
  <//>`;
}

// ===== 会話の行（K4）。データは作り物（手順は Read src/app.ts のような形） =====

const FENCE = "```";
const TALK_MD = [
  "# 見出し",
  "**太字** と `code` と https://example.com/a の段落。",
  "",
  "- 箇条書き 1",
  "  - 入れ子 1",
  "  - 入れ子 2",
  "- 箇条書き 2",
  "",
  "3. 番号 3",
  "4. 番号 4",
  "",
  FENCE,
  "x".repeat(200),
  FENCE,
  "",
  "https://example.com/" + "a".repeat(380),
  "",
  "| 表 | の行 |",
  "> 引用の行",
].join("\n");

const STEPS_4 = ["Read src/app.ts", "Grep handleTurn", "Read src/web/chat.ts", "Bash npm test"];
const STEPS_5 = ["Read src/app.ts", "Edit src/app.ts", "Bash npm run check", "Bash npm test", "Read test/app.test.ts"];

/** 手順の上限で止まった返事（［続ける］の見本の 1 行） */
function stoppedTurn(id) {
  return { id, kind: "agent", text: "ここまで進めました。", time: "12:45", outcome: "max_turns", steps: STEPS_4.slice(0, 3), end: "手順の上限で止まりました（12 分 34 秒・ツール 128 回）" };
}

/** 見本の行。time・name・end は fmt がそのまま返す欄 */
const TALK_DEMOS = [
  {
    demo: "talk-basic",
    turns: [
      { id: "b1", kind: "notice", text: "セッションを開きました", time: "12:30" },
      { id: "b6", kind: "notice", text: "場所を「kakeibo-app」に変えました。ここまでの要点:\n\n- 月ごとの集計の表を直した\n- CSV の読み込みで日付の形式が 2 つある事が分かった\n- 残り: 繰り越しの計算と、その検査\n\n続きはこの話題で話せます。", time: "12:30" },
      { id: "b2", kind: "owner", text: "おはよう", time: "12:30" },
      { id: "b3", kind: "agent", text: "おはようございます。", time: "12:31", outcome: "done", steps: [] },
      { id: "b4", kind: "agent", name: "Claude Code", text: "1 つ目の返事です。", time: "12:32" },
      { id: "b5", kind: "agent", name: "Claude Code", text: "2 つ目の返事です。", time: "12:33" },
    ],
  },
  {
    demo: "talk-steps",
    turns: [
      { id: "s1", kind: "agent", text: "調べました。", time: "12:30", outcome: "done", steps: STEPS_4, end: "完了（1 分 23 秒・ツール 4 回）" },
      { id: "s2", kind: "agent", text: "直しました。", time: "12:32", outcome: "done", steps: ["Edit src/app.ts", "Bash npm test"], end: "完了（12 秒・ツール 2 回）" },
      { id: "s3", kind: "agent", text: "ここまで進めました。", time: "12:45", outcome: "max_turns", steps: STEPS_4.slice(0, 3), end: "手順の上限で止まりました（12 分 34 秒・ツール 128 回）" },
      { id: "s4", kind: "agent", text: "途中で失敗しました。", time: "12:46", outcome: "failed", steps: [], end: "止まりました（3 秒・ツール 0 回）" },
      { id: "s5", kind: "agent", text: "ここで止めます。", time: "12:47", outcome: "aborted", steps: [], end: "中断しました（5 秒・ツール 1 回）" },
    ],
  },
  { demo: "talk-stopped", continueKey: "p1", turns: [stoppedTurn("p1")] },
  { demo: "talk-stopped-open", continueKey: "p2", turns: [stoppedTurn("p2")] },
  { demo: "talk-stopped-busy", continueKey: "p3", continueBusy: true, turns: [stoppedTurn("p3")] },
  { demo: "talk-md", turns: [{ id: "m1", kind: "agent", text: TALK_MD, time: "12:30" }] },
  {
    demo: "talk-run",
    turns: [{ id: "r1", kind: "owner", text: "テストを回して", time: "12:30" }],
    running: { steps: STEPS_5, abortable: true, text: "作業中…（1 分 5 秒・ツール 5 回）", waiting: "許可を待っています" },
  },
  { demo: "talk-run-empty", turns: [], running: { steps: [], abortable: false, text: "作業中…（2 秒・ツール 0 回）", waiting: "許可を待っています: mcp__long_server_name__long_server_name__long_server_name__tool_x" }, runName: () => "Claude Code" },
  {
    demo: "talk-edge",
    hasMore: true,
    turns: [
      { id: "e1", kind: "divider", text: "ここから新しい会話" },
      { id: "e2", kind: "owner", text: "送っている発言", time: "12:30", optimistic: true },
      { id: "e3", kind: "owner", text: "長い発言。".repeat(120), time: "12:31" },
    ],
  },
];

const TALK_FMT = {
  time: (turn) => turn.time || "",
  label: (turn) => (turn.kind === "owner" ? "オーナー" : turn.name || "エージェント"),
  name: (turn, prev) => (turn.name && !(prev && prev.name === turn.name) ? turn.name : null),
  end: (turn) => turn.end || "",
  progress: (run) => run.text,
  waiting: (run) => run.waiting || null,
  allLabel: (run) => "すべての手順（" + run.steps.length + "）",
  runName: () => null,
};

/** 押した物を結果の欄に書く（手順の開閉は見本の中で覚える。見本もモデルを通して描く） */
function Talks() {
  const [openSteps, setOpenSteps] = useState(() => new Set(["s2", "p2"]));
  const [runStepsOpen, setRunStepsOpen] = useState(false);
  const [result, setResult] = useState("");
  const on = {
    older: () => setResult("older"),
    toggleSteps: (id) => {
      setOpenSteps((prev) => {
        const next = new Set(prev);
        if (next.has(id)) next.delete(id);
        else next.add(id);
        return next;
      });
      setResult(`steps ${id}`);
    },
    toggleRunSteps: () => {
      setRunStepsOpen((v) => !v);
      setResult("run-steps");
    },
    stop: () => setResult("stop"),
    continue: (key) => setResult(`continue ${key}`),
  };
  return html`<${Section} name="talk" title="会話（TalkTimeline・Bubble・Steps・RunLine）">
    ${TALK_DEMOS.map(({ demo, turns, hasMore = false, running = null, runName, continueKey = null, continueBusy = false }) => {
      const fmt = runName ? { ...TALK_FMT, runName } : TALK_FMT;
      const model = talkModel({ channelId: "g", turns, hasMore, running, stopping: false, continueKey, continueBusy, openSteps, runStepsOpen, fmt, on }, parseBlocks);
      return html`<div data-demo=${demo} key=${demo}><div class="c-gallery-talk"><${TalkTimeline} model=${model} on=${on} /></div></div>`;
    })}
    <p class="c-gallery-result">${result}</p>
  <//>`;
}

const COMPOSER_NOTE = "Discord で発言したのと同じ経路で 1 ターン動きます。返事はここと Discord の両方に出ます";
const COMPOSER_ONE = "明日の朝でお願いします";
/** 入力欄の見本（count は送る本文の字数のつもりの数。near・over は本文を短くして字数だけ渡す） */
const COMPOSER_DEMOS = [
  { demo: "empty", text: "" },
  { demo: "one", text: COMPOSER_ONE },
  { demo: "three", text: "読みました。\n明日の朝に直します。\n終わったら知らせます。" },
  { demo: "eight", text: Array.from({ length: 8 }, (_v, i) => `${i + 1} 行目`).join("\n") },
  { demo: "long-line", text: "abcdefghij".repeat(20) },
  { demo: "near", text: COMPOSER_ONE, count: 1701 },
  { demo: "over", text: COMPOSER_ONE, count: 1901 },
  { demo: "sending", text: COMPOSER_ONE, sending: true },
  { demo: "narrow", text: COMPOSER_ONE, narrow: true },
  // 送った本文の帯（Claude Code のチャンネル）
  { demo: "sent-done", text: "", sent: { id: 12, text: "本文 #12: 届けました・返事が来ました", tone: "done" } },
  { demo: "sent-warning", text: "", sent: { id: 13, text: "本文 #13: 入力待ちにならなかったため、届けるのをやめました", tone: "warning" } },
  { demo: "sent-cancel", text: "", sent: { id: 14, text: "本文 #14: 届け待ち。入力待ちになったら届けます", tone: "", cancel: true } },
];
const COMPOSER_ON = { input: noop, send: noop, cancel: noop };

/** 見本の欄に、要素が来たときに 1 回だけ本文を入れる ref（見本ごとに 1 つの同じ関数。本番は口が同じ事をする） */
const composerRefs = new Map();
function composerRef(demo, text) {
  if (!composerRefs.has(demo)) {
    const seen = new WeakSet();
    composerRefs.set(demo, (node) => {
      if (node && !seen.has(node)) {
        seen.add(node);
        node.value = text;
      }
    });
  }
  return composerRefs.get(demo);
}

function Composers() {
  return html`<${Section} name="composer" title="会話の入力欄（Composer）">
    ${COMPOSER_DEMOS.map(({ demo, text, count, sending = false, narrow = false, sent = null }) => {
      const model = composerModel({ text, count: count ?? text.trim().length, max: 1900, sending, touch: false, label: "見本の話題 に送る", placeholder: "この話題に送る", note: COMPOSER_NOTE, sent });
      const body = html`<${Composer} model=${model} on=${COMPOSER_ON} inputRef=${composerRef(demo, text)} />`;
      return html`<div data-demo=${demo} key=${demo}>${narrow ? html`<div class="c-gallery-composer c-gallery-composer-narrow">${body}</div>` : html`<div class="c-gallery-composer">${body}</div>`}</div>`;
    })}
  <//>`;
}

// ===== カード（K5） =====
const CARD_ON = { permit: noop, always: noop, task: noop, close: noop, move: noop, pick: noop, pickOther: noop, other: noop, answer: noop, dismiss: noop, cancel: noop };
const CARD_MODE = "default（使うたびに確認）";
const CARD_RULE = "Bash(npm run test:*)";
const cardPerm = (o) => ({ kind: "permission", id: "p1", tool: "Bash", mode: CARD_MODE, summary: "npm test", rule: "", ruleNote: "", always: false, left: "残り 4 分 12 秒", urgent: false, busy: false, ...o });
const cardPermRule = (o) => cardPerm({ summary: "npm run test:integration", rule: CARD_RULE, ruleNote: "見本の添え書き", ...o });
const CARD_LONG = Array.from({ length: 14 }, (_, i) => "echo 見本の行 " + (i + 1)).join("\n");
const CARD_SUMMARY = "見本の会話で決めた事をまとめた 1 段落目です。\n\n残っている事をまとめた 2 段落目です。";
const CARD_TASKS = ["1. 見本の候補 A", "2. 見本の候補 B（期限 11/20）", "3. 見本の候補 C"];
const cardClose = (o) => ({ kind: "close", id: "c1", summary: CARD_SUMMARY, tasks: CARD_TASKS, picked: [], busy: false, ...o });
// 切れ目の無い長い字（折り返しの決まりが外れると枠からはみ出す）
const CARD_UNBROKEN_URL = "https://example.com/" + "sample-path-without-a-break/".repeat(5) + "0123456789";
const CARD_UNBROKEN_PLACE = "sample_project_name_without_any_break_point_".repeat(3) + "0123456789";
const CARD_UNBROKEN_TOOL = "mcp__sample_server__" + "tool_name_without_break_".repeat(3) + "0123456789";
const CARD_LONG_TASK = "見本の長い題の候補をここに置いて、折り返しと幅を見るための行";
const CARD_OPTIONS = [
  { label: "小さく直す", description: "今の形を保って、足りない所だけ直します。" },
  { label: "作り直す", description: "部品から組み直します。時間がかかります。" },
  { label: "あとで決める", description: "" },
];
const cardQ = (o) => ({ legend: "進め方", text: "どの進め方にしますか。", multi: false, options: CARD_OPTIONS, picked: [], other: false, otherText: "", ...o });
const cardQ2 = (o) => cardQ({ legend: "問 2", text: "確かめる物を選んでください。", multi: true, options: [{ label: "単体のテスト", description: "" }, { label: "画面写し", description: "スマホと PC の両方です。" }], ...o });
// ラジオの name は id で分かれるので、見本ごとに別の id にする（同じ name だとページの中で 1 つしか選べない）
const cardQuestion = (o) => ({ kind: "question", id: "q1", who: "", left: "残り 4 分 12 秒", urgent: false, busy: false, ready: false, questions: [cardQ({})], ...o });
const CARD_DEMOS = [
  { demo: "card-perm", items: [cardPerm({})] },
  { demo: "card-perm-rule", items: [cardPermRule({})] },
  { demo: "card-perm-urgent", items: [cardPermRule({ always: true, left: "残り 42 秒", urgent: true })] },
  { demo: "card-perm-busy", items: [cardPermRule({ always: true, busy: true })] },
  { demo: "card-perm-long", items: [cardPerm({ mode: "", summary: CARD_LONG })] },
  { demo: "card-q-one", items: [cardQuestion({ id: "q1", who: "見本のセッション ・ " + CARD_MODE })] },
  { demo: "card-q-two", items: [cardQuestion({ id: "q2", ready: true, questions: [cardQ({ picked: ["小さく直す"] }), cardQ2({ picked: ["単体のテスト", "画面写し"] })] })] },
  { demo: "card-q-other", items: [cardQuestion({ id: "q3", ready: true, questions: [cardQ({ other: true, otherText: "別の案を書きます" })] })] },
  { demo: "card-q-busy", items: [cardQuestion({ id: "q4", ready: true, busy: true, questions: [cardQ({ picked: ["作り直す"] })] })] },
  { demo: "card-q-session", items: [cardQuestion({ id: "q5", terminal: false })] },
  { demo: "card-close", items: [cardClose({})] },
  { demo: "card-close-picked", items: [cardClose({ picked: [1] })] },
  { demo: "card-close-none", items: [cardClose({ tasks: [] })] },
  { demo: "card-move", items: [{ kind: "move", id: "m1", from: "self-agent", to: "見本のプロジェクト", busy: false }] },
  {
    demo: "card-note",
    items: [
      { kind: "note", id: "wait", text: "閉じる前の要約をしています…", busy: true },
      { kind: "note", id: "empty", text: "まだ会話はありません。下の欄か Discord で送ると始まります。" },
      { kind: "note", id: "done", text: "完了したセッションです。発言すると進行中に戻ります。" },
    ],
  },
  // 状態の行（Claude Code のチャンネル）。［やめる］の有り・無し・送っている間
  {
    demo: "card-status",
    items: [
      { kind: "status", id: "a", text: "届け待ちです。入力待ちになったら届けます", cancel: { id: 21, busy: false } },
      { kind: "status", id: "b", text: "作業中…", cancel: null },
      { kind: "status", id: "c", text: "作業中です。終わったら届けます", cancel: { id: 22, busy: true } },
    ],
  },
  {
    demo: "card-narrow",
    narrow: true,
    items: [
      { kind: "note", id: "wait", text: "会話を新しくしています…", busy: true },
      cardClose({ summary: CARD_SUMMARY + "\n" + CARD_UNBROKEN_URL, tasks: [1, 2, 3].map((n) => n + ". " + CARD_LONG_TASK + (n === 2 ? "（期限 11/20）" : "")) }),
      { kind: "move", id: "m1", from: "self-agent", to: LONG_PLACE, busy: false },
      { kind: "move", id: "m2", from: "self-agent", to: CARD_UNBROKEN_PLACE, busy: false },
      cardPerm({ tool: CARD_UNBROKEN_TOOL, rule: "Bash(npm run test:integration -- --only 見本の長い名前のルールをここに置いて幅を見る:*)", ruleNote: "見本の添え書き" }),
      cardQuestion({
        id: "q5",
        who: "見本のセッション ・ " + CARD_MODE,
        ready: true,
        questions: [
          cardQ({ legend: "見本の長い見出しをここに置いて折り返しを見る", options: [...CARD_OPTIONS, { label: CARD_UNBROKEN_PLACE, description: CARD_UNBROKEN_URL }], picked: ["作り直す"] }),
          cardQ2({ legend: CARD_UNBROKEN_PLACE, other: true, otherText: CARD_UNBROKEN_URL }),
        ],
      }),
    ],
  },
];

/** 「その他」の欄の字は、入力欄の見本と同じやり方で新しい要素に 1 回だけ入れる */
const cardOtherRef = (demo, items) => (id, index) => {
  const item = items.find((i) => i.kind === "question" && i.id === id);
  const q = item && item.questions[index];
  return composerRef(demo + ":" + id + ":" + index, q ? q.otherText : "");
};

function CardDemos() {
  return html`<${Section} name="cards" title="カード">
    ${CARD_DEMOS.map(({ demo, items, narrow = false }) => {
      const body = html`<${Cards} items=${items} on=${CARD_ON} otherRef=${cardOtherRef(demo, items)} />`;
      return html`<div data-demo=${demo} key=${demo}>${narrow ? html`<div class="c-gallery-cards c-gallery-cards-narrow">${body}</div>` : html`<div class="c-gallery-cards">${body}</div>`}</div>`;
    })}
  <//>`;
}

/** 右腕の見本の札（返事の本文の <#ID> の代わり。1 つは meta 無し） */
const HAND_REFS = [
  { id: "h1", title: "見本の話題: 週末の買い物の段取りを決める", meta: "12:40" },
  { id: "h2", title: "見本の話題: 部屋の片付け" },
];
const HAND_MARK = /<#[a-z0-9]+>/g;
/** 右腕の見本の文の関数（会話の見本と同じ。返事の本文から印を外し、印の数だけ札を返す） */
const HAND_FMT = {
  ...TALK_FMT,
  reply: (text) => text.replace(HAND_MARK, "").trim(),
  refs: (text) => HAND_REFS.slice(0, (text.match(HAND_MARK) || []).length),
};
const HAND_TURNS = [
  { id: "a1", kind: "owner", text: "週末の買い物と片付けの話題はどこ？", time: "12:41" },
  { id: "a2", kind: "agent", text: "この 2 つです。\n<#h1> <#h2>", time: "12:41" },
];
const HAND_ON = { older() {}, toggleSteps() {}, toggleRunSteps() {}, stop() {}, continue() {}, ref() {} };

/** 右腕の見本（右腕の列と同じ 360px の箱）。押しても何も起きない */
function Hands() {
  const model = talkModel({ channelId: "g-hand", turns: HAND_TURNS, hasMore: false, running: null, stopping: false, openSteps: new Set(), runStepsOpen: false, fmt: HAND_FMT, on: HAND_ON }, parseBlocks);
  return html`<${Section} name="hand" title="右腕">
    <div class="c-gallery-hand">
      <${HandHead} title="右腕" menu=${true} on=${{ menu() {}, close() {} }} />
      <${TalkTimeline} model=${model} on=${HAND_ON} />
    </div>
  <//>`;
}

/** 札の見本の既定の生の状態（書いていない物はこれ） */
const TERM_BASE = { title: "ログインの直し", place: "self-agent", rowState: "idle", activity: "11/20(金) 14:05", pane: true, check: null, checking: false, failed: false, phase: "idle", error: null };
const TERM_READY = { takeable: true, state: "idle", reason: null, text: null, rcUrl: "https://claude.ai/code/demo" };
/** 札の見本（ready・ended・busy・waiting・blocked が取り込めるかの 4 つの形、ほかは途中の形。long は幅 320 の入れ物で、題と場所に切れ目の無い字） */
const TERM_DEMOS = [
  { demo: "ready", raw: { check: TERM_READY } },
  { demo: "ended", raw: { rowState: null, pane: false, activity: "11/20(金) 13:40", check: { takeable: true, state: "ended", reason: null, text: null, rcUrl: null } } },
  { demo: "busy", raw: { rowState: "running", check: { takeable: false, state: "running", reason: "busy", text: "実行中です。終わると取り込めます", rcUrl: null } } },
  { demo: "waiting", raw: { rowState: "waiting", check: { takeable: false, state: "waiting", reason: "waiting", text: "判断待ちです。端末か RC で答えると取り込めます", rcUrl: null } } },
  { demo: "blocked", raw: { check: { takeable: false, state: "idle", reason: "not_in_tmux", text: "このセッションは外から終わらせません。終わらせてから取り込めます", rcUrl: null } } },
  { demo: "checking", raw: { checking: true } },
  { demo: "taking", raw: { check: TERM_READY, phase: "taking" } },
  { demo: "lost", raw: { check: TERM_READY, phase: "lost" } },
  { demo: "error", raw: { check: TERM_READY, error: "取り込めませんでした: 端末の画面が待機の状態ではありません（書きかけ・ダイアログ・操作の直後）" } },
  { demo: "long", narrow: true, raw: { check: TERM_READY, title: "端末のセッションの題がとても長いときに札の幅からはみ出さずに折り返すかを確かめるための見本の題です。ここまでで八十字になるように字を足していきます。あと少しです" + "sample_terminal_session_title_without_any_break_point_".repeat(2) + "0123456789", place: CARD_UNBROKEN_PLACE } },
];
const TERM_ON = { take() {}, pane() {}, recheck() {} };

/** 端末のセッションの札の見本。押しても何も起きない */
function Terms() {
  return html`<${Section} name="term" title="端末のセッションの札">
    ${TERM_DEMOS.map(({ demo, raw, narrow = false }) => {
      const body = html`<${TermCard} ...${termView({ ...TERM_BASE, ...raw })} on=${TERM_ON} />`;
      return html`<div data-demo=${demo} key=${demo}>${narrow ? html`<div class="c-gallery-cards c-gallery-cards-narrow">${body}</div>` : html`<div class="c-gallery-cards">${body}</div>`}</div>`;
    })}
  <//>`;
}

// ===== 流れの列と上の帯（D1）。データは作り物 =====

const DECK_DATA = {
  ...FULL_DATA,
  turnIds: ["ch:1", "ch:21", "ch:20"],
  topics: [
    ...FULL_DATA.topics,
    gTopic({ id: "ch:21", title: "見本の判断待ちの話題", mark: "turn", turn: gTurn("waiting", "") }),
  ],
};
const DECK_TASKS = [
  { id: 1, title: "見本の期限なしのタスク", due: null, status: "open" },
  { id: 2, title: "見本の今日のタスク", due: "2026-01-01", status: "open" },
  { id: 3, title: "見本の先のタスク", due: "2026-01-03", status: "open" },
  { id: 4, title: "見本の期限切れのタスク", due: "2025-12-30", status: "open" },
];
/** 本物（/api/reminders）の形。rule は保存した文字列か null、ruleText はその文 */
const DECK_REMINDERS = [
  { id: 1, text: "見本の毎朝の\nリマインド", nextAt: "2026-01-02T00:00:00Z", kind: "notify", rule: "daily@09:00", ruleText: "毎日 9:00" },
  { id: 2, text: "見本の 1 回のリマインド", nextAt: "2026-01-01T09:00:00Z", kind: "notify", rule: null, ruleText: null },
  { id: 3, text: "見本の平日の依頼", nextAt: "2026-01-02T03:00:00Z", kind: "prompt", rule: "weekdays@12:00", ruleText: "平日 12:00" },
];
const DECK_GITHUB = [
  { id: 1, url: "https://github.com/example/sample/pull/12", title: "見本の PR", label: "レビュー依頼", level: "yellow", updatedAt: "2026-01-01T02:00:00Z", actorLogin: "sample", handoff: null },
  { id: 2, url: "https://github.com/example/sample/issues/7", title: "", label: "", level: "white", updatedAt: "2026-01-01T01:00:00Z", actorLogin: "sample", handoff: null },
];
const DECK_NOTICES = [
  { at: "2026-01-01T02:30:00Z", text: "見本の知らせ（Discord に投稿した物）", level: "info", link: "https://discord.com/channels/1/2/3" },
  { at: "2026-01-01T00:30:00Z", text: "見本の知らせ（投稿していない物）", level: "warning", link: null },
];
const DECK_DAYS = { "2026-01-01": "1/1(木)", "2026-01-03": "1/3(土)", "2025-12-30": "12/30(火)" };
const GITHUB_URL = /^https:\/\/github\.com\/([^/]+)\/([^/]+)\/(?:pull|issues)\/(\d+)/;

const deckState = (o = {}) => ({
  cols: 3,
  current: "ch:21",
  topics: DECK_DATA,
  tasks: DECK_TASKS,
  reminders: DECK_REMINDERS,
  github: DECK_GITHUB,
  handoff: false,
  notices: DECK_NOTICES,
  today: "2026-01-01",
  isUnread: (channel) => channel === "3",
  time: () => "12:34",
  ago: () => "3 分前",
  day: (d) => DECK_DAYS[d] || d,
  oneLine: (text) => String(text).replace(/\s*[\r\n]+\s*/g, " "),
  parts: (url) => {
    const m = typeof url === "string" ? GITHUB_URL.exec(url) : null;
    return m ? { repo: m[1] + "/" + m[2], number: m[3] } : null;
  },
  ...o,
});
/** 操作の見本の通知（押せる［対応］と押せない［対応］・応答待ち） */
const DECK_GITHUB_OPS = [
  { ...DECK_GITHUB[0], handoff: true },
  DECK_GITHUB[1],
  { id: 3, url: "https://github.com/example/sample/pull/15", title: "見本の応答待ちの PR", label: "", level: "yellow", updatedAt: "2026-01-01T00:00:00Z", actorLogin: "sample", handoff: true },
];
const DECK_ON = { open: noop, op: noop };
const BAND_ON = { status: noop, find: noop, hand: noop, start: noop, more: noop };

/** スマホの幅の枠の操作つきの見本（タスクの列だけ。リマインドの操作の行が狭い列で 1 行に入るか） */
const deckTasksOnly = (state) => {
  const model = deckModel(state);
  return { ...model, columns: model.columns.filter((c) => c.id === "tasks") };
};

/** スマホの帯の題（今いる列の名前と数）の見本: あなたの番（warning の数）・タスク（数）・通知（0 なので数なし） */
const BAND_TITLES = Object.freeze([
  { demo: "band-phone-turn", title: { name: "あなたの番", count: 2, tone: "warning" } },
  { demo: "band-phone-tasks", title: { name: "タスク", count: 3 } },
  { demo: "band-phone-feed", title: { name: "通知", count: 0 } },
]);

/** 帯と 3 つの列の見本（列は見本の幅で 3 等分。band-phone・deck-paged・deck-phone-ops はスマホの幅の枠で、列は 1 列ずつ横に送る）。押しても何も起きない */
function Decks() {
  return html`<${Section} name="deck" title="流れの列と上の帯">
    <div class="c-gallery-slide" data-demo="band">
      <div class="c-gallery-deck c-gallery-band">
        <${DeckBand} conn=${{ tone: "ok", label: "見本の Bot: 接続中" }} hand=${{ mark: "turn", open: false }} controls="v3-hand" on=${BAND_ON} />
      </div>
    </div>
    <div class="c-gallery-slide" data-demo="band-phone">
      <div class="c-gallery-deck c-gallery-phone">
        <${DeckBand} variant="phone" conn=${{ tone: "ok", label: "見本の Bot: 接続中" }} hand=${{ mark: "turn", open: false }} controls="v3-hand" on=${BAND_ON} />
      </div>
    </div>
    ${BAND_TITLES.map(
      (t) => html`<div class="c-gallery-slide" key=${t.demo} data-demo=${t.demo}>
        <div class="c-gallery-deck c-gallery-phone">
          <${DeckBand} variant="phone" conn=${{ tone: "ok", label: "見本の Bot: 接続中" }} hand=${{ mark: "turn", open: false }} controls="v3-hand" title=${t.title} on=${BAND_ON} />
        </div>
      </div>`,
    )}
    <div class="c-gallery-deck" data-demo="deck-3"><${Deck} model=${deckModel(deckState())} on=${DECK_ON} /></div>
    <div class="c-gallery-slide" data-demo="deck-ops">
      <div class="c-gallery-deck c-gallery-deck-ops">
        <${Deck} model=${deckModel(deckState({ ops: true, busy: ["task:3", "gh:3", "rem:3"], busyOp: { "rem:3": "cancel" }, github: DECK_GITHUB_OPS, handoff: true }))} on=${DECK_ON} />
      </div>
    </div>
    <div class="c-gallery-deck" data-demo="deck-empty">
      <${Deck} model=${deckModel(deckState({ topics: QUIET_DATA, tasks: [], reminders: [], github: [], notices: [], isUnread: () => false }))} on=${DECK_ON} />
    </div>
    <div class="c-gallery-deck" data-demo="deck-loading">
      <${Deck} model=${deckModel(deckState({ topics: null, tasks: null, reminders: null, github: null, notices: null }))} on=${DECK_ON} />
    </div>
    <div class="c-gallery-slide" data-demo="deck-paged">
      <div class="c-gallery-deck c-gallery-phone"><${Deck} model=${deckModel(deckState({ cols: 1, paged: true }))} on=${DECK_ON} /></div>
    </div>
    <div class="c-gallery-slide" data-demo="deck-phone-ops">
      <div class="c-gallery-deck c-gallery-phone"><${Deck} model=${deckTasksOnly(deckState({ cols: 1, paged: true, ops: true }))} on=${DECK_ON} /></div>
    </div>
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
    <${Talks} />
    <${Composers} />
    <${CardDemos} />
    <${Hands} />
    <${Terms} />
    <${Decks} />
    <${Toast} items=${toasts} onDismiss=${dismiss} />
  `;
}

applyTheme();
render(html`<${Gallery} />`, document.getElementById("gallery"));
