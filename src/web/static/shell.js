// 新しい殻（v3.html。docs/plan/web-ui-v3.md §2・§11 の M2）: 話題の一覧（列 1。topics.js）と開いた話題（列 2）、
// SA.app（今の殻 workbench.js と同じ名前の契約。chat.js・views.js・api.js・ui.js・sound.js が呼ぶ）・hash・スマホの一覧 ⇄ 会話・テーマ・書きかけ・シート・キーボードの高さ、
// 下の口（タスク・リマインド・ほか）・接続の点と鈴・絞り込み・一覧のキー・[会話][端末]、右腕の枠（列 3。§4 の M3。畳んだ帯・スマホの 2 つの口・重ねる形・「いま見ている話題」の 1 行・札）、話題を始めるダイアログ（#v3-start。§2・§5 の M4）
"use strict";

(function () {
  const SA = (window.SA = window.SA || {});
  const { el, icon, openDialog, closeDialog } = SA.ui;
  const root = document.documentElement;

  // ===== 保存（このブラウザだけ。読めなくても動く。鍵は今の殻と同じなので、テーマと書きかけは 2 つの画面で共有する） =====
  const STORAGE_PREFIX = "self-agent-web:";

  function load(key, fallback) {
    try {
      const v = window.localStorage.getItem(STORAGE_PREFIX + key);
      return v === null ? fallback : v;
    } catch {
      return fallback;
    }
  }

  function save(key, value) {
    try {
      window.localStorage.setItem(STORAGE_PREFIX + key, value);
    } catch {
      // 保存できない環境（プライベートモードなど）では覚えないだけ
    }
  }

  function loadJson(key) {
    try {
      const v = JSON.parse(load(key, "null"));
      return v !== null && typeof v === "object" ? v : null;
    } catch {
      return null;
    }
  }

  // スマホ（639px 以下）は 1 列（一覧 ⇄ 会話）、640px 以上は 2 列
  const mqPhone = window.matchMedia ? window.matchMedia("(max-width: 639px)") : { matches: false, addEventListener() {} };
  const phone = () => mqPhone.matches;

  // ===== 状態 =====
  const THEMES = ["dark", "light", "system"];

  const S = {
    // 列 2 に出している話題か画面のタブ ID（ch:<id>・cc:<id>・tasks など）
    active: null,
    theme: "dark",
    // チャンネルごとの書きかけ（localStorage の drafts。送ったら消す）
    drafts: {},
    // スマホで見えている側（"list" | "body"）
    view: "list",
    // Claude Code のチャンネルのある話題で見ている物（"talk" 会話 | "pane" 端末の画面の写し）。話題を開くたびに talk
    view2: "talk",
    // 右腕: 列のとき開いているか（localStorage の v3-hand）・重ねる形で開いているか（保存しない）・形（"column" | "over"）
    handWant: true,
    handOver: false,
    handMode: "over",
  };

  const $ = (id) => document.getElementById(id);
  const refs = {};

  // ===== テーマ =====
  // ブラウザの上の帯の色（--surface。v3.html の theme-color の 2 つと同じ値）
  const THEME_COLORS = { light: "#ffffff", dark: "#11141c" };

  function applyTheme() {
    if (S.theme === "system") delete root.dataset.theme;
    else root.dataset.theme = S.theme;
    // OS に合わせるときは media ごとの元の値、決めたときは 2 つともそのテーマの値
    for (const meta of document.querySelectorAll('meta[name="theme-color"]')) {
      const own = (meta.getAttribute("media") || "").includes("dark") ? "dark" : "light";
      meta.setAttribute("content", THEME_COLORS[S.theme === "system" ? own : S.theme]);
    }
    const dark = S.theme === "dark" || (S.theme === "system" && window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches);
    const btn = $("theme-toggle");
    if (btn) {
      btn.replaceChildren(icon(dark ? "sun" : "moon"));
      btn.setAttribute("aria-label", dark ? "ライトにする" : "ダークにする");
      btn.title = dark ? "ライトにする" : "ダークにする";
    }
  }

  function setTheme(theme) {
    S.theme = THEMES.includes(theme) ? theme : "dark";
    save("theme", S.theme);
    applyTheme();
  }

  // ===== 書きかけ =====
  /** 書きかけを localStorage に残す（読めない・書けない環境ではこのタブのメモリだけ） */
  function setDraft(channelId, value) {
    if (value) S.drafts[channelId] = value;
    else delete S.drafts[channelId];
    save("drafts", JSON.stringify(S.drafts));
  }

  /** 一覧（/api/channels）に無いチャンネルの書きかけを消す */
  function pruneDrafts(channelIds) {
    try {
      const keep = new Set(channelIds);
      const stale = Object.keys(S.drafts).filter((id) => !keep.has(id));
      if (stale.length === 0) return;
      for (const id of stale) delete S.drafts[id];
      save("drafts", JSON.stringify(S.drafts));
    } catch {
      // 消せなくても書きかけが残るだけ
    }
  }

  // ===== 知らせの 1 行（views.js の知らせの画面が使う） =====
  /** 知らせの重さごとのアイコン */
  const NOTICE_ICONS = { warning: "triangle-alert", danger: "triangle-alert", success: "check", info: "info" };

  /** 知らせの 1 行（本文は文字のまま。Discord のリンクは投稿できたものだけ） */
  function noticeLine(n) {
    const level = Object.prototype.hasOwnProperty.call(NOTICE_ICONS, n.level) ? n.level : "info";
    return el("li", { class: "notice-item is-" + level }, [
      icon(NOTICE_ICONS[level]),
      el("span", { class: "out-time", title: SA.ui.dateTime(n.at), text: SA.ui.shortTime(n.at) }),
      el("span", { text: String(n.text) }),
      typeof n.link === "string" && n.link.startsWith("https://discord.com/channels/")
        ? el("a", { class: "meta", href: n.link, target: "_blank", rel: "noreferrer noopener", "aria-label": "Discord で開く", title: "Discord で開く" }, [icon("external-link")])
        : null,
    ]);
  }

  // ===== 列 2 =====
  /** 下端から 48px 以内なら下端に居るとみなす */
  function atBottom(scroll) {
    return scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight < 48;
  }

  /** スマホで一覧を出している間は列 2 が display: none で、スクロールの読み書きが効かない */
  function mainHidden() {
    return phone() && S.view === "list";
  }

  // 列 2 が隠れる直前のスクロール（{ top, bottom }）と、隠れている間に描き直して「表示されたら下端に寄せる」印
  let hiddenScroll = null;
  let stickOnShow = false;

  // 列 2 に最後に描いたタブ（[端末] の間は cc:<sessionId>）
  let edTab = null;

  /** タブの中身を描く。同じタブならスクロール位置は保ち、別のタブに切り替えたとき（switched）は下端（data-stick="bottom"）か先頭から */
  function renderEd(ed, tabId, switched) {
    edTab = tabId || null;
    const hidden = mainHidden();
    const oldScroll = switched || hidden ? null : ed.querySelector(".ed-scroll");
    const wasBottom = !oldScroll || atBottom(oldScroll);
    const oldTop = oldScroll ? oldScroll.scrollTop : 0;
    const info = tabId ? SA.views.info(tabId) : null;
    if (!info) {
      ed.replaceChildren(el("div", { class: "v3-empty" }, [el("p", { class: "meta", text: "左の一覧から話題を選んでください" })]));
      return;
    }
    info.render(ed);
    const scroll = ed.querySelector(".ed-scroll");
    if (!scroll) return;
    const stick = scroll.dataset.stick === "bottom";
    if (hidden) {
      // 隠れている間は位置を書けないので、表示したとき（setView）に当てる
      if (stick && hiddenScroll && hiddenScroll.bottom) stickOnShow = true;
    } else if (stick && wasBottom) scroll.scrollTop = scroll.scrollHeight;
    else scroll.scrollTop = oldTop;
  }

  /** [会話][端末] を出せる話題（Discord のチャンネルがあり、今も一覧に居る Claude Code のセッション）なら、そのセッションの ID */
  function paneSession() {
    const t = S.active ? SA.topics.find(S.active) : null;
    return t && t.origin === "cc" && t.id.startsWith("ch:") && t.sessionId !== null ? t.sessionId : null;
  }

  /** 列 2 に出しているタブ（[端末] の間は cc:<sessionId>。一覧の aria-current と hash は S.active のまま） */
  function shownTabId() {
    if (S.view2 === "pane") {
      const sessionId = paneSession();
      if (sessionId) return "cc:" + sessionId;
    }
    return S.active;
  }

  /** [会話] ⇄ [端末]（切り替えは別のタブとして下端に寄せる） */
  function setView2(view) {
    if (S.view2 === view) return;
    S.view2 = view;
    renderBar();
    renderEd($("ed"), shownTabId(), true);
    // 前に出た方を読み直す（端末は画面の写し、会話は turns など。その後は api.js の polling）。切り替えでは閉じない
    const info = SA.views.info(shownTabId());
    if (info && info.onOpen) info.onOpen();
  }

  /** [会話][端末] の切り替え（ボタンは 1 度だけ作り、押した状態だけ合わせる） */
  function renderViews() {
    const box = $("v3-views");
    if (!box) return;
    const sessionId = paneSession();
    // 出せなくなったら会話に戻す
    if (!sessionId && S.view2 === "pane") S.view2 = "talk";
    box.hidden = !sessionId;
    if (!sessionId) return;
    if (box.children.length === 0) {
      for (const [view, label] of [
        ["talk", "会話"],
        ["pane", "端末"],
      ]) {
        const b = el("button", { type: "button", "data-view": view, text: label });
        b.addEventListener("click", () => setView2(view));
        box.append(b);
      }
    }
    for (const b of Array.from(box.children)) {
      const pressed = String(b.getAttribute("data-view") === S.view2);
      if (b.getAttribute("aria-pressed") !== pressed) b.setAttribute("aria-pressed", pressed);
    }
  }

  /** 列 2 の上の帯（「場所」はただの文字。押せない。付け替えは M5）と [会話][端末] */
  function renderBar() {
    const bar = $("v3-bar");
    if (!bar) return;
    const t = S.active ? SA.topics.find(S.active) : null;
    renderViews();
    if (!t) {
      // スマホは [右腕] を出すため、話題でない画面でも帯を残す（「場所」は空）
      bar.hidden = !(phone() && S.active !== null);
      const place = $("v3-place");
      if (place.textContent !== "") place.textContent = "";
      return;
    }
    bar.hidden = false;
    const text = "場所: " + placeText(t);
    const place = $("v3-place");
    if (place.textContent !== text) place.textContent = text;
  }

  /** 話題の「場所」の文字（帯と札で同じ決め方）。群 general は General のセッションなら「General」、場所の無い軽いセッションは「なし」 */
  function placeText(t) {
    if (t.group === "other") return "ほかの場所" + (t.cwdLabel ? "（" + t.cwdLabel + "）" : "");
    if (t.group === "general") return t.place && t.place.dir ? "General" : "なし";
    return t.place && t.place.dir ? t.place.dir : "なし";
  }

  function renderMain(switched) {
    renderBar();
    renderEd($("ed"), shownTabId(), switched);
    writeHash();
  }

  /** 一覧を読み直した後: 帯を描き、[端末] を出せなくなって出す物が変わったら描き直す */
  function refreshTabs() {
    renderBar();
    const shown = shownTabId();
    const ed = $("ed");
    if (ed && shown !== edTab) {
      // 一覧を出している間に会話に戻したら、次に会話の列を出したとき下端にする（[端末] の位置を当てない）
      if (mainHidden()) hiddenScroll = { top: 0, bottom: true };
      renderEd(ed, shown, true);
    }
    syncHand();
  }

  /** api.js の polling・SA.app.refresh が当たるのは列 2 に出している物（[端末] の間は cc:<sessionId>） */
  function activeTabId() {
    return shownTabId();
  }

  /**
   * 画面に描かれていて見えている会話のチャンネル（ch: を外したもの）。列 2 の会話の 1 つ（[端末] の間は無い）と、見えている右腕。
   * スマホで一覧を出している間（会話の列が隠れている間）も、最後に開いた会話を返す（M2a からの動き。変えるなら polling・音・既読が一緒に変わる）
   */
  function shownChannelIds() {
    const tabId = shownTabId();
    const ids = tabId && tabId.startsWith("ch:") ? [tabId.slice(3)] : [];
    const hand = handVisible() ? handChannelId() : null;
    if (hand && !ids.includes(hand)) ids.push(hand);
    return ids;
  }

  /** 話題か画面を列 2 に開く（知らない・無効な機能のタブは開かない） */
  function open(tabId) {
    if (!tabId) return;
    const info = SA.views.info(tabId);
    if (!info) {
      // /api/status が届く前の Claude Code の話題は、届いたら開く（起動の hash と同じ道）
      if (tabId.startsWith("cc:") && SA.store.status === null) deferred = tabId;
      return;
    }
    // 右腕のチャンネルは列 2 に描かない（同じチャンネルを 2 つの入れ物に描かない）。右腕を開く
    if (tabId === handTab()) {
      openHand(document.activeElement, false);
      return;
    }
    const switched = S.active !== tabId;
    const shownBefore = edTab;
    // 会話（ch:）は閉じない（開いた手順・選びかけの選択肢を、ほかの話題を見て戻っても保つ）
    if (S.active !== null && switched && !S.active.startsWith("ch:")) {
      const prev = SA.views.info(S.active);
      if (prev && prev.onClose) prev.onClose();
    }
    S.active = tabId;
    S.view2 = "talk";
    SA.topics.setCurrent(tabId);
    deferred = null;
    if (switched) {
      hiddenScroll = null;
      stickOnShow = false;
    }
    // スマホは先に会話の列を出してから描く（隠れたままではスクロールを書けない）。重ねた右腕は畳む（履歴の entry は showBody が話題に置き換える）
    const handWasOver = S.handMode === "over" && S.handOver;
    const focusInHand = handWasOver && handHasFocus();
    if (phone()) {
      if (S.handOver) {
        S.handOver = false;
        applyHand();
      }
      showBody();
    } else if (handWasOver) {
      // 640px 以上の重ねる形は entry を積んでいないので、その場で畳む
      S.handOver = false;
      applyHand();
    }
    // 同じ話題でも [端末] から会話に戻ったときは別のタブとして描く
    renderMain(switched || shownBefore !== shownTabId());
    SA.topics.render();
    if (info.onOpen) info.onOpen();
    // 一覧（/api/channels）にまだ無いチャンネル（/api/topics で先に知った話題）は、見出しのために 1 回読む
    if (tabId.startsWith("ch:") && !SA.chat.channelById(tabId.slice(3))) SA.store.load.channels({ quiet: true });
    // スマホは一覧が隠れるので、見出しの [‹] に焦点
    if (phone()) {
      const back = $("ed").querySelector(".ed-back");
      if (back) back.focus({ preventScroll: true });
    } else if (focusInHand) {
      // 畳んだ右腕の中にあった焦点は列 2 の側へ（入力欄が無ければ一覧の開いた行）
      const input = $("ed").querySelector("textarea.composer-input");
      if (input) input.focus({ preventScroll: true });
      else focusCurrentRow();
    }
  }

  /** tabId が列 2 に出ていれば中身だけ描き直す */
  function refresh(tabId) {
    if (tabId !== null && tabId === handTab()) {
      renderHand();
      return;
    }
    if (shownTabId() !== tabId) return;
    const ed = $("ed");
    if (ed) renderEd(ed, tabId);
  }

  // ===== 右腕（列 3。中身は既定の人格の #inbox を chat.js で描く。docs/plan/web-ui-v3.md §4） =====
  /** 列 2 が残す最小の幅（px）。これを切るなら右腕を列にせず重ねる */
  const HAND_MAIN_MIN = 360;
  const HAND_NONE_TEXT = "右腕はまだありません。Discord で /setup を実行すると、ここで頼めます。";
  const HAND_MARK_TEXT = { turn: "あなたの番", unread: "未読" };

  // 閉じた後に焦点を戻すボタン・最初の読み込みを済ませた右腕のチャンネル・最後に描いた物（チャンネル ID か "none"・"loading"）・次に描くとき下端に寄せるか
  // 札: 最後に描いた返事の <#ID> と、その札の中身の署名（一覧を読んで変わったら描き直す）
  let handCardIds = [];
  let handCardSig = null;
  let handOpener = null;
  let handLoadedId = null;
  let handShown = null;
  let handStick = true;
  // 重ねた右腕の [畳む] で history.back() を呼んでから popstate が来るまで（連打で 2 つ戻らない）
  let handClosing = false;

  /** 右腕のタブ（/api/topics の rightHands の先頭。サーバーが複数でも選ぶ口は作らない）。無ければ null */
  function handTab() {
    const data = SA.topics.data();
    const hand = data && data.rightHands[0];
    return hand ? hand.id : null;
  }

  function handChannelId() {
    const tab = handTab();
    return tab && tab.startsWith("ch:") ? tab.slice(3) : null;
  }

  function handVisible() {
    return S.handMode === "column" ? S.handWant : S.handOver;
  }

  /** 列 3 が入るか（スマホか、列 2 が HAND_MAIN_MIN を切るなら重ねる形） */
  function handModeOf(isPhone, total, list, hand) {
    return isPhone || total - list - hand < HAND_MAIN_MIN ? "over" : "column";
  }

  /** shell.css の --v3-hand-w（読めなければ 360） */
  function handWidth() {
    try {
      const v = parseFloat(getComputedStyle(root).getPropertyValue("--v3-hand-w"));
      return Number.isFinite(v) ? v : 360;
    } catch {
      return 360;
    }
  }

  /** 幅を測って形を決める。形が変わったら重ねて開いていた状態を閉じる（列は保存した開閉に従う） */
  function fitHand() {
    if (!refs.v3) return;
    const list = $("v3-list");
    const mode = handModeOf(phone(), refs.v3.clientWidth, list ? list.offsetWidth : 0, handWidth());
    if (mode === S.handMode) return;
    const focusInHand = handHasFocus();
    S.handMode = mode;
    S.handOver = false;
    dropHandMark();
    applyHand();
    if (focusInHand && !handVisible()) restoreHandFocus();
  }

  /** 焦点が右腕の中にあるか */
  function handHasFocus() {
    const hand = $("v3-hand");
    return !!hand && hand.contains(document.activeElement);
  }

  /** 履歴を戻らずに右腕を閉じた状態にするとき、今の entry の右腕の印（v3Hand）を外す（残すと次の [畳む] がその entry へ戻るだけになる） */
  function dropHandMark() {
    try {
      if (history.state && history.state.v3Hand) {
        // 一覧までの段数を持つ。右腕の entry の v3Depth は下の entry の段数なので、会話の上に積んだものはその 1 つ上（印の無い古い entry は下を 1 と見る）
        const st = history.state.v3Body ? { v3Body: true, v3Depth: depthOf(history.state) + 1 } : { v3Body: false };
        history.replaceState(st, "", location.href);
      }
    } catch {
      // 書けなくても右腕は閉じている
    }
  }

  /** 開閉と形を属性に書き、見えていれば描く（見えていない間は高さが測れないので、属性を書いた後で描く） */
  function applyHand() {
    const v3 = refs.v3;
    if (!v3) return;
    const visible = handVisible();
    const over = S.handMode === "over" && S.handOver;
    v3.setAttribute("data-hand-mode", S.handMode);
    v3.setAttribute("data-hand", visible ? "open" : "closed");
    const backdrop = $("v3-hand-backdrop");
    if (backdrop) backdrop.hidden = !over;
    // 重ねている間は後ろ（一覧・列 2）を押せず、Tab でも入らない
    for (const id of ["v3-list", "v3-main"]) {
      const n = $(id);
      if (n) n.inert = over;
    }
    const hand = $("v3-hand");
    if (hand) {
      if (over) hand.setAttribute("role", "dialog");
      else hand.removeAttribute("role");
    }
    const show = $("v3-hand-show");
    if (show) show.setAttribute("aria-expanded", String(visible));
    // 隠れていた間の位置は当てにならないので、次に描くときは下端から
    if (!visible) handStick = true;
    renderHand();
    renderHandEntries();
  }

  /** 右腕の入れ物を描く。描く前の位置を覚え、下に付いていたら（か bottom なら）下へ、でなければ前の位置（renderEd と同じ考え方） */
  function keepScroll(ed, draw, bottom) {
    const old = ed.querySelector(".ed-scroll");
    const wasBottom = bottom || !old || atBottom(old);
    const oldTop = old ? old.scrollTop : 0;
    draw();
    const scroll = ed.querySelector(".ed-scroll");
    if (!scroll) return;
    if (scroll.dataset.stick === "bottom" && wasBottom) scroll.scrollTop = scroll.scrollHeight;
    else scroll.scrollTop = oldTop;
  }

  /** chat.js に渡す枠の指定（毎回同じ物） */
  const HAND_FRAME = { title: "右腕", placeholder: "右腕に頼む・訊く", ops: handOps, outgoing: withViewing, replyText: namedText, replyExtras: handCards };

  /** 何を描くか（右腕のチャンネル ID か、無ければ "none"、一覧をまだ読んでいなければ "loading"） */
  function handKey() {
    return handChannelId() || (SA.topics.data() === null ? "loading" : "none");
  }

  /** 見えている右腕を描く（[畳む] に焦点があれば、描き直した後の [畳む] に戻す。入力欄は chat.js が残す） */
  function renderHand() {
    if (!handVisible()) return;
    const ed = $("v3-hand-ed");
    if (!ed) return;
    const closeBefore = $("v3-hand-close");
    const refocus = !!closeBefore && document.activeElement === closeBefore;
    const id = handChannelId();
    const key = handKey();
    handCardIds = [];
    if (id) {
      const first = handLoadedId !== id;
      keepScroll(ed, () => SA.chat.render(ed, id, HAND_FRAME), handStick || handShown !== key);
      if (first) {
        handLoadedId = id;
        SA.store.load.turns(id);
      }
    } else {
      ed.replaceChildren(
        el("header", { class: "ed-toolbar" }, [el("div", { class: "ed-title" }, [el("h1", { text: "右腕" })]), el("div", { class: "ed-actions" }, handOps())]),
        key === "loading" ? SA.views.loading() : el("div", { class: "v3-empty" }, [el("p", { class: "meta", text: HAND_NONE_TEXT })]),
      );
    }
    handShown = key;
    handStick = false;
    handCardSig = cardSig();
    if (refocus) {
      const close = $("v3-hand-close");
      if (close) close.focus();
    }
  }

  /** 右腕の見出しの右端（[畳む]） */
  function handOps() {
    const b = el("button", { class: "btn btn-ghost btn-sm", id: "v3-hand-close", type: "button", "aria-label": "右腕を畳む", text: "畳む" });
    b.addEventListener("click", () => closeHand());
    return [b];
  }

  /** 右腕を開く。focusInput なら入力欄に、でなければ [畳む] に焦点 */
  function openHand(opener, focusInput) {
    handOpener = opener || null;
    handClosing = false;
    const wasVisible = handVisible();
    if (S.handMode === "column") {
      if (!S.handWant) {
        S.handWant = true;
        save("v3-hand", "1");
      }
    } else if (!S.handOver) {
      S.handOver = true;
      // スマホは戻る（端のスワイプ）で閉じられるよう entry を 1 つ積む
      if (phone()) {
        try {
          history.pushState({ v3Body: S.view === "body", v3Hand: true, v3Depth: depthOf(history.state) }, "", location.href);
        } catch {
          // 積めなくても [畳む]・backdrop で閉じられる
        }
      }
    }
    // 畳んでいた間の返事を読む（初めて描くチャンネルは renderHand が読む）
    const id = handChannelId();
    const reload = !wasVisible && id !== null && handLoadedId === id;
    applyHand();
    if (reload && handVisible()) SA.store.load.turns(id);
    const ed = $("v3-hand-ed");
    const input = focusInput && ed ? ed.querySelector(".composer-input") : null;
    const target = input || $("v3-hand-close");
    if (target) target.focus();
  }

  /** 右腕を畳む（列は保存して帯のボタンに焦点。重ねる形は履歴の entry があれば戻る = popstate で閉じる） */
  function closeHand() {
    if (S.handMode === "column") {
      S.handWant = false;
      save("v3-hand", "0");
      applyHand();
      const show = $("v3-hand-show");
      if (show) show.focus();
      return;
    }
    if (handClosing) return;
    if (history.state && history.state.v3Hand) {
      try {
        handClosing = true;
        history.back();
        return;
      } catch {
        // 戻れなければその場で閉じる
        handClosing = false;
      }
    }
    S.handOver = false;
    applyHand();
    restoreHandFocus();
  }

  /** 閉じた後の焦点: 開いたボタンが見えていればそこ、無ければ見えている口 */
  function restoreHandFocus() {
    const opener = handOpener;
    handOpener = null;
    let target = shownNode(opener) ? opener : null;
    if (!target) target = $(!phone() ? "v3-hand-show" : S.view === "body" ? "v3-hand-open" : "v3-hand-ask");
    if (target) target.focus();
  }

  /** document の中にあり、自分も祖先も hidden・inert でない要素か（body は焦点の戻り先にしない） */
  function shownNode(n) {
    if (!n || n === document.body || !document.contains(n)) return false;
    for (let p = n; p; p = p.parentElement) if (p.hidden || p.inert) return false;
    return true;
  }

  /** 口の印（あなたの番 > 未読 で 1 つ。見えている右腕には未読を出さない） */
  function handMark() {
    const data = SA.topics.data();
    const hand = data && data.rightHands[0];
    if (!hand) return null;
    if (hand.turn) return "turn";
    if (!handVisible() && SA.store.isUnread({ id: handChannelId(), last: hand.last })) return "unread";
    return null;
  }

  function handDot(mark, labelled) {
    if (!mark) return null;
    return el("span", {
      class: "dot " + (mark === "turn" ? "dot-warn" : "dot-unread"),
      role: labelled ? "img" : undefined,
      "aria-label": labelled ? HAND_MARK_TEXT[mark] : undefined,
      "aria-hidden": labelled ? undefined : "true",
    });
  }

  /** 3 つの口（畳んだ帯・一覧の下・上の帯）の中身。印が前と同じなら触らない */
  function renderHandEntries() {
    const mark = handMark();
    const sig = String(mark);
    const fill = (id, build) => {
      const b = $(id);
      if (!b || b.getAttribute("data-sig") === sig) return;
      b.setAttribute("data-sig", sig);
      build(b);
    };
    fill("v3-hand-show", (b) => {
      const label = "右腕を開く" + (mark ? "（" + HAND_MARK_TEXT[mark] + "）" : "");
      b.setAttribute("aria-label", label);
      b.setAttribute("title", label);
      b.replaceChildren(...[icon("bot"), handDot(mark, false)].filter(Boolean));
    });
    fill("v3-hand-ask", (b) => b.replaceChildren(...[icon("bot"), el("span", { text: "右腕に頼む・訊く" }), handDot(mark, true)].filter(Boolean)));
    fill("v3-hand-open", (b) => b.replaceChildren(...[el("span", { text: "右腕" }), handDot(mark, true)].filter(Boolean)));
  }

  /** 話題の一覧を読むたびに: 列 2 に右腕のチャンネルが出ていたら右腕へ移し、右腕が変わっていたら描き直し、口を描く */
  function syncHand() {
    const tab = handTab();
    if (tab !== null && S.active === tab) {
      const prev = SA.views.info(S.active);
      if (prev && prev.onClose) prev.onClose();
      S.active = null;
      S.view2 = "talk";
      SA.topics.setCurrent(null);
      if (phone()) {
        setView("list");
        try {
          if (history.state && history.state.v3Body) history.replaceState({}, "", location.pathname + location.search);
        } catch {
          // 書けなくても一覧は出ている
        }
      }
      renderMain();
      SA.topics.render();
      openHand(null, false);
    }
    if (handVisible() && (handShown !== handKey() || handCardSig !== cardSig())) renderHand();
    renderHandEntries();
  }

  // ===== 札（右腕の返事の <#ID> を話題の行で引いて、吹き出しの下に 1 行ずつ。右腕の会話にだけ出す） =====
  /** 返事の <#ID> を出た順に、同じものは 1 つ、先頭 5 つ（先頭が 0 の数字は ID として扱わない。namedText と同じ形） */
  function cardIds(text) {
    const ids = [];
    for (const m of String(text || "").matchAll(/<#([1-9]\d*)>/g)) {
      if (!ids.includes(m[1])) ids.push(m[1]);
      if (ids.length === 5) break;
    }
    return ids;
  }

  /** 札の中身（一覧の話題か、一覧から外れた（完了した）セッション）。引けなければ null */
  function cardParts(id) {
    const t = SA.topics.find("ch:" + id);
    if (t) {
      const state = t.mark === "turn" ? "あなたの番" : t.mark === "running" ? "作業中" : SA.chat.STATE_LABEL[t.state] || null;
      return { id: t.id, title: t.title, place: placeText(t), state };
    }
    const ch = SA.chat.channelById(id);
    if (ch && ch.kind === "session") return { id: "ch:" + id, title: SA.chat.channelTitle(ch), place: null, state: SA.chat.STATE_LABEL[ch.state] || null };
    return null;
  }

  function cardSig() {
    return JSON.stringify(handCardIds.map(cardParts));
  }

  /** 返事の吹き出しの下に足す札（題名・場所・状態・[開く]） */
  function handCards(text) {
    const cards = [];
    for (const id of cardIds(text)) {
      if (!handCardIds.includes(id)) handCardIds.push(id);
      const p = cardParts(id);
      if (!p) continue;
      const open = el("button", { class: "btn btn-ghost btn-sm", type: "button", "aria-label": p.title + " を開く", text: "開く" });
      open.addEventListener("click", () => SA.app.open(p.id));
      const meta = [p.place, p.state].filter(Boolean).join("・");
      // 場所も状態も引けなければ meta の span を作らない
      const parts = [el("span", { class: "v3-card-title", text: p.title }), meta ? el("span", { class: "v3-card-meta", text: meta }) : null, open].filter(Boolean);
      cards.push(el("div", { class: "v3-card", "data-topic": p.id }, parts));
    }
    return cards;
  }

  /** 返事の本文の <#ID> のうち引けたものを「<題名>」に（引けないもの・先頭が 0 の数字はそのまま） */
  function namedText(text) {
    if (typeof text !== "string") return text;
    return text.replace(/<#([1-9]\d*)>/g, (all, id) => {
      const p = cardParts(id);
      return p ? "「" + p.title + "」" : all;
    });
  }

  /** 列 2 に話題が出ていれば、その題名（空白を詰めて前後を落とし、80 字まで）。スマホは会話の上に右腕を出したときだけ */
  function viewingTitle() {
    if (phone() && S.view !== "body") return null;
    const t = S.active ? SA.topics.find(S.active) : null;
    if (!t) return null;
    const title = String(t.title).replace(/\s+/g, " ").trim();
    // サロゲートペアを割らないよう code point で数える
    const chars = Array.from(title);
    return chars.length > 80 ? chars.slice(0, 80).join("") + "…" : title;
  }

  /** 右腕へ送る本文の先頭に「（いま見ている話題: <題名>）」を毎回 1 行添える（モデルがどの話題の話かを取り違えないため） */
  function withViewing(text) {
    const title = viewingTitle();
    return title === null ? text : "（いま見ている話題: " + title + "）\n" + text;
  }

  // ===== hash（#/ch/<id>・#/cc/<id>・#/tasks。今の殻と同じ形） =====
  function hashOf(tabId) {
    return "#/" + tabId.replace(":", "/");
  }

  function tabFromHash(hash) {
    const path = String(hash || "").replace(/^#\/?/, "");
    if (path === "") return null;
    const slash = path.indexOf("/");
    return slash > 0 ? path.slice(0, slash) + ":" + path.slice(slash + 1) : path;
  }

  function writeHash() {
    // 起動の hash の話題を待っている間は消さない
    if (S.active === null && deferred !== null) return;
    try {
      // 履歴の印（v3Body）は残す
      if (S.active) history.replaceState(history.state, "", hashOf(S.active));
      else history.replaceState(history.state, "", location.pathname + location.search);
    } catch {
      // hash を書けなくても画面は動く
    }
  }

  // 起動の hash のタブで、まだ開けないもの（/api/status を待つ github・devlog・cc: など）。status と最初の一覧の後に試し、それでも開けなければ捨てる
  let deferred = null;
  let topicsLoaded = false;

  // 押した行（cc:）も待つので、ほかの話題が開いていても試す（その後に何かを開けば open が deferred を消す）
  function reopenDeferred() {
    if (deferred === null) return;
    if (SA.views.info(deferred)) {
      open(deferred);
      return;
    }
    if (SA.store.status !== null && topicsLoaded) {
      deferred = null;
      writeHash();
    }
  }

  // ===== スマホの一覧 ⇄ 会話（履歴: 会話は v3Body の entry。戻ると一覧） =====
  function setView(view) {
    const wasHidden = mainHidden();
    const scroll = $("ed").querySelector(".ed-scroll");
    // 隠す前に読む（隠した後は読めない）
    const before = !wasHidden && scroll ? { top: scroll.scrollTop, bottom: atBottom(scroll) } : null;
    S.view = view;
    refs.v3.setAttribute("data-view", view);
    const hidden = mainHidden();
    if (wasHidden === hidden) return;
    if (hidden) {
      hiddenScroll = before;
      stickOnShow = false;
      return;
    }
    if (scroll && hiddenScroll) {
      if (stickOnShow) scroll.scrollTop = scroll.scrollHeight;
      else if (!hiddenScroll.bottom) scroll.scrollTop = hiddenScroll.top;
    }
    hiddenScroll = null;
    stickOnShow = false;
  }

  function showBody() {
    setView("body");
    const hash = S.active ? hashOf(S.active) : location.pathname + location.search;
    try {
      // 右腕を開いたまま話題を開いたら、右腕の entry を話題の entry に置き換える（一覧までの段数は下の entry の 1 つ上）
      if (history.state && history.state.v3Hand) history.replaceState({ v3Body: true, v3Depth: (history.state.v3Depth || 0) + 1 }, "", hash);
      else if (history.state && history.state.v3Body) history.replaceState(history.state, "", hash);
      else history.pushState({ v3Body: true }, "", hash);
    } catch {
      // 積めなくても [‹] で一覧に戻れる
    }
  }

  /** 一覧に戻ったら、開いていた話題の行に焦点（一覧の位置は動かさない） */
  function focusCurrentRow() {
    if (!S.active) return;
    const selector = 'button.v3-row[data-topic="' + CSS.escape(S.active) + '"]';
    // 群の中の行を先に。無ければ「あなたの番」の行（節が出ているときだけ）
    let row = $("v3-groups").querySelector(selector);
    const turns = $("v3-turns");
    if (!row && !turns.hidden) row = turns.querySelector(selector);
    if (row) row.focus({ preventScroll: true });
  }

  /** 履歴の entry から一覧までの段数（会話の entry は v3Depth、無ければ 1。一覧は 0） */
  function depthOf(state) {
    return state && state.v3Body ? state.v3Depth || 1 : 0;
  }

  function showList() {
    if (history.state && history.state.v3Body) {
      try {
        // popstate で一覧にする（札で開いた話題は、その下の話題の entry も越えて一覧まで戻る）
        const depth = depthOf(history.state);
        if (depth > 1) history.go(-depth);
        else history.back();
        return;
      } catch {
        // 戻れなければその場で一覧にする
      }
    }
    setView("list");
    focusCurrentRow();
  }

  function openDrawer() {
    if (phone()) showList();
    else refs.list.focus();
  }

  function closeDrawer() {
    if (phone() && S.active !== null) showBody();
  }

  function sidebarShows(id) {
    return id === "chat" && (!phone() || S.view === "list");
  }

  // ===== シート（見出しの […] のチャンネルの操作など。≤639px では app.css が dialog を下からのシートにする） =====
  /** 閉じた後に焦点を戻すボタン（行を選んで閉じたときは戻さない。焦点は開いた先が決める） */
  let sheetOpener = null;

  /**
   * items は { icon, label, run?, href?, why? }: href は新しいタブで開くリンク、run が無ければ押せない行で why を右に出す。opener は閉じた後に焦点を戻すボタン
   */
  function openSheet(label, items, opener) {
    const dialog = $("v3-sheet");
    const chosen = () => {
      sheetOpener = null;
      closeDialog(dialog);
    };
    const rows = items.map((it) => {
      let row;
      if (it.href) {
        row = el("a", { class: "more-row", href: it.href, target: "_blank", rel: "noreferrer noopener" }, [icon(it.icon || "external-link"), el("span", { class: "sb-label", text: it.label })]);
        row.addEventListener("click", chosen);
      } else {
        row = el("button", { class: "more-row", type: "button", disabled: !it.run }, [
          icon(it.icon || "circle"),
          el("span", { class: "sb-label", text: it.label }),
          !it.run && it.why ? el("span", { class: "sb-meta", text: it.why }) : null,
        ]);
        if (it.run) {
          row.addEventListener("click", () => {
            chosen();
            it.run();
          });
        }
      }
      return el("li", {}, [row]);
    });
    sheetOpener = opener || null;
    dialog.setAttribute("aria-label", label);
    // 題と ×（閉じ方を見せる。今の殻の sheetHead と同じ）
    const close = el("button", { class: "btn btn-ghost btn-sm btn-icon-sm sheet-close", type: "button", "aria-label": "閉じる" }, [icon("x")]);
    close.addEventListener("click", () => closeDialog(dialog));
    dialog.replaceChildren(el("div", { class: "sheet-head" }, [el("span", { class: "sheet-title", text: label }), close]), el("ul", { class: "more-list" }, rows));
    openDialog(dialog);
    // 最初の焦点は押せる最初の行（× ではなく）
    const first = dialog.querySelector(".more-row:not([disabled])");
    if (first) first.focus();
  }

  // ===== 話題を始める（群の見出しの [+] → #v3-start → POST /api/topics。docs/plan/web-ui-v3.md §2・§5） =====
  const START_SET_UP = "設定が済んでいません。端末で npm run unify-setup -- --print の行を実行して再起動してください";
  const START_EMPTY = "最初の一言か題名を入れてください";
  /** 始められなかったときの文（応答の error ごと。too_long は field で分ける） */
  const START_ERRORS = {
    empty: START_EMPTY,
    invalid_project: "そのプロジェクトは使えません",
    cc_disabled: "プロジェクトで始めるには Claude Code の連携が要ります",
    unify_not_ready: START_SET_UP,
    not_set_up: "先に Discord で /setup を実行してください",
    bot_disconnected: "Discord につながっていません。少し待ってからもう一度試してください",
  };
  // 送っている最中か・閉じた後に焦点を戻す [+]・話題を開くために閉じたか（そのときは焦点を戻さない）
  let starting = false;
  let startOpener = null;
  let startOpened = false;

  /** 場所の候補（General を先頭に、プロジェクトをサーバーの順のまま）。一覧をまだ読めていなければ General だけ */
  function startPlaces() {
    const data = SA.topics.data();
    if (!data) return [{ key: "general", name: "General" }];
    const general = data.groups.filter((g) => g.kind === "general").slice(0, 1);
    const projects = data.groups.filter((g) => g.kind === "project");
    const places = general.concat(projects).map((g) => ({ key: g.key, name: g.name }));
    return general.length > 0 ? places : [{ key: "general", name: "General" }].concat(places);
  }

  /** 場所ごとの 1 行。状態（/api/status の cc）がまだ無ければ連携が有効なときと同じ文 */
  function startHint(place) {
    const status = SA.store.status;
    const cc = status && status.cc ? status.cc : null;
    if (place === "general") {
      if (cc && (cc.enabled !== true || cc.unifyReady === false)) return "Discord にチャンネルができます。Claude Code の連携が使えないので、場所なしの話題として始めます。";
      return "Discord にチャンネルができます。";
    }
    if (cc && cc.enabled !== true) return "プロジェクトで始めるには Claude Code の連携が要ります。";
    if (cc && cc.unifyReady === false) return START_SET_UP;
    const hit = startPlaces().find((p) => p.key === place);
    return "Discord にチャンネルができます。" + (hit ? hit.name : place.replace(/^p:/, "")) + " の中で作業します。";
  }

  function showStartHint() {
    $("v3-start-hint").textContent = startHint($("v3-start-place").value || "general");
  }

  /** エラーの欄（role=alert）。text が null なら隠す。field はその欄に aria-invalid を付ける入力欄の id */
  function startError(text, field) {
    const box = $("v3-start-error");
    box.textContent = text === null ? "" : text;
    box.hidden = text === null;
    for (const id of ["v3-start-text", "v3-start-name"]) {
      if (id === field) $(id).setAttribute("aria-invalid", "true");
      else $(id).removeAttribute("aria-invalid");
    }
  }

  /** ダイアログを開く（場所は place が候補にあればそれ、無ければ General）。焦点は最初の一言 */
  function openStart(place, opener) {
    const dialog = $("v3-start");
    if (!dialog) return;
    const places = startPlaces();
    const select = $("v3-start-place");
    select.replaceChildren(...places.map((p) => el("option", { value: p.key, text: p.name })));
    select.value = places.some((p) => p.key === place) ? place : "general";
    $("v3-start-text").value = "";
    $("v3-start-name").value = "";
    startError(null, null);
    // 前に送った分がまだ返っていなければ（送っている間に閉じた）、[始める] は無効のまま
    $("v3-start-ok").disabled = starting;
    showStartHint();
    startOpener = opener || null;
    startOpened = false;
    openDialog(dialog);
    $("v3-start-text").focus();
  }

  function startFailure(err) {
    const code = err && err.code;
    if (code === "too_long") {
      const field = err.data && err.data.field;
      if (field === "title") return { text: "題名は 100 字までです", field: "v3-start-name" };
      return { text: "最初の一言は 1,900 字までです", field: "v3-start-text" };
    }
    if (code === "empty") return { text: START_EMPTY, field: "v3-start-text" };
    if (typeof code === "string" && Object.prototype.hasOwnProperty.call(START_ERRORS, code)) return { text: START_ERRORS[code], field: null };
    if (err && err.status === 0) return { text: "サーバーにつながりません", field: null };
    return { text: "始められませんでした。もう一度試してください", field: null };
  }

  /** 送る（送っている最中は何もしない。空の題名・一言は欄ごと送らない） */
  async function submitStart() {
    if (starting) return;
    const place = $("v3-start-place").value || "general";
    const rawText = $("v3-start-text").value;
    const title = $("v3-start-name").value.trim();
    const text = rawText.trim();
    if (title === "" && text === "") {
      startError(START_EMPTY, "v3-start-text");
      $("v3-start-text").focus();
      return;
    }
    startError(null, null);
    const body = { place };
    if (title !== "") body.title = title;
    if (text !== "") body.text = text;
    starting = true;
    $("v3-start-ok").disabled = true;
    let data;
    try {
      data = await SA.api.post("/api/topics", body, { quiet: true });
    } catch (err) {
      starting = false;
      $("v3-start-ok").disabled = false;
      const failure = startFailure(err);
      startError(failure.text, failure.field);
      return;
    }
    starting = false;
    $("v3-start-ok").disabled = false;
    startOpened = true;
    closeDialog($("v3-start"));
    const name = data && typeof data.title === "string" ? data.title : title;
    if (data && data.turn === "failed" && typeof data.channelId === "string") {
      setDraft(data.channelId, rawText);
      SA.ui.toast("話題「" + name + "」を始めました。最初の一言は送れなかったので、入力欄に戻しました");
    } else SA.ui.toast("話題「" + name + "」を始めました");
    SA.topics.load();
    if (data && typeof data.id === "string") open(data.id);
  }

  function bindStart() {
    const dialog = $("v3-start");
    if (!dialog) return;
    $("v3-start-form").addEventListener("submit", (e) => {
      e.preventDefault();
      submitStart();
    });
    $("v3-start-cancel").addEventListener("click", () => closeDialog(dialog));
    $("v3-start-place").addEventListener("change", showStartHint);
    // 最初の一言の中の Ctrl+Enter・⌘+Enter で送る（ただの Enter は改行。変換の確定中は何もしない）
    $("v3-start-text").addEventListener("keydown", (e) => {
      if (e.isComposing || e.keyCode === 229) return;
      if ((e.ctrlKey || e.metaKey) && e.key === "Enter") {
        e.preventDefault();
        submitStart();
      }
    });
    dialog.addEventListener("close", () => {
      const opener = startOpener;
      const opened = startOpened;
      startOpener = null;
      startOpened = false;
      if (!opened && opener && document.contains(opener)) opener.focus();
    });
  }

  // ===== 下の口（タスク・リマインド・ほか） =====
  /** 「ほか」に並べる画面の順（引けるものだけ。GitHub は有効のとき・会話ログは dev のとき） */
  const MORE_TABS = ["knowledge", "memories", "github", "usage", "devlog", "notices", "status", "settings"];

  function openMore(opener) {
    const items = [];
    for (const id of MORE_TABS) {
      const info = SA.views.info(id);
      if (info) items.push({ label: info.title, icon: info.icon, run: () => open(id) });
    }
    openSheet("ほか", items, opener);
  }

  function renderFoot() {
    const foot = $("v3-list-foot");
    if (!foot) return;
    const buttons = [];
    for (const id of ["tasks", "reminders"]) {
      const info = SA.views.info(id);
      if (!info) continue;
      const b = el("button", { class: "btn btn-ghost btn-sm v3-foot-btn", type: "button" }, [icon(info.icon), el("span", { text: info.title })]);
      b.addEventListener("click", () => open(id));
      buttons.push(b);
    }
    const more = el("button", { class: "btn btn-ghost btn-sm v3-foot-btn", type: "button" }, [icon("ellipsis"), el("span", { text: "ほか" })]);
    more.addEventListener("click", () => openMore(more));
    buttons.push(more);
    foot.replaceChildren(...buttons);
  }

  // ===== 接続の点と鈴（今の殻の renderTitleStatus と同じ中身。幅によらず画面を開く） =====
  let connSig = null;

  function renderConn() {
    const box = refs.conn;
    if (!box) return;
    const status = SA.store.status;
    const bot = status && status.bots ? status.bots[0] : null;
    const notices = SA.store.notices;
    const botLabel = bot ? bot.name + " の Bot: " + (bot.connected ? "接続中" : "接続できません") : null;
    const bellCount = notices ? notices.recent24h : null;
    // 変わらなければ作り直さない（焦点を外さない）
    const sig = JSON.stringify([botLabel, bot ? !!bot.connected : null, bellCount]);
    if (sig === connSig) return;
    connSig = sig;
    const items = [];
    if (bot) {
      const b = el("button", { class: "btn btn-ghost btn-sm btn-icon-sm", type: "button", "aria-label": botLabel, title: botLabel }, [
        el("span", { class: "dot " + (bot.connected ? "dot-ok" : "dot-bad"), "aria-hidden": "true" }),
      ]);
      b.addEventListener("click", () => open("status"));
      items.push(b);
    }
    if (notices) {
      const label = "知らせ（直近 24 時間 " + notices.recent24h + " 件）";
      const b = el("button", { class: "btn btn-ghost btn-sm title-bell", type: "button", "aria-label": label, title: label }, [
        icon("bell"),
        notices.recent24h > 0 ? el("span", { class: "title-bell-count", text: String(notices.recent24h), "aria-hidden": "true" }) : null,
      ]);
      b.addEventListener("click", () => open("notices"));
      items.push(b);
    }
    box.replaceChildren(...items);
  }

  // ===== 絞り込み（読めている話題だけ。サーバーには訊かない） =====
  // 絞り込んでいるか・始める前の一覧の位置（消したら戻す）
  let filterOn = false;
  let filterTop = null;

  function searchInput() {
    let input = $("v3-search");
    if (!input) {
      input = el("input", {
        class: "input",
        id: "v3-search",
        type: "search",
        placeholder: "題名で絞り込む",
        "aria-label": "話題を絞り込む",
        autocomplete: "off",
        enterkeyhint: "search",
      });
      input.addEventListener("input", () => applyFilter(input.value));
      refs.searchBox.append(input);
    }
    return input;
  }

  function applyFilter(value) {
    const was = filterOn;
    filterOn = String(value || "").trim() !== "";
    if (!was && filterOn) filterTop = refs.list.scrollTop;
    SA.topics.setFilter(value);
    SA.topics.render();
    if (was && !filterOn && filterTop !== null) {
      refs.list.scrollTop = filterTop;
      filterTop = null;
    }
  }

  function openSearch() {
    if (!refs.searchBox) return;
    refs.searchBox.hidden = false;
    if (refs.searchToggle) refs.searchToggle.setAttribute("aria-expanded", "true");
    searchInput().focus();
  }

  function closeSearch() {
    if (!refs.searchBox) return;
    const input = $("v3-search");
    if (input && input.value !== "") {
      input.value = "";
      applyFilter("");
    }
    refs.searchBox.hidden = true;
    if (refs.searchToggle) {
      refs.searchToggle.setAttribute("aria-expanded", "false");
      refs.searchToggle.focus();
    }
  }

  function renderHeadOps() {
    const ops = $("v3-head-ops");
    if (!ops) return;
    const toggle = el("button", { class: "btn btn-ghost btn-sm btn-icon-sm", id: "v3-search-toggle", type: "button", "aria-label": "話題を絞り込む", title: "話題を絞り込む", "aria-expanded": "false" }, [
      icon("search"),
    ]);
    toggle.addEventListener("click", () => {
      if (refs.searchBox && refs.searchBox.hidden) openSearch();
      else closeSearch();
    });
    // 点と鈴は status・知らせのたびに描き直すので、入れ物を分ける（絞り込みのボタンの焦点を外さない）
    const conn = el("span", { class: "v3-conn" });
    ops.replaceChildren(toggle, conn);
    refs.searchToggle = toggle;
    refs.conn = conn;
  }

  /** 見えている（hidden の祖先・閉じた details の中に無い）一覧の行 */
  function visibleRows() {
    return Array.from(refs.list.querySelectorAll("button.v3-row")).filter((row) => {
      for (let n = row; n && n !== refs.list; n = n.parentElement) {
        if (n.hidden) return false;
        const parent = n.parentElement;
        // 閉じた details の中（summary を除く）は出ていない
        if (parent && String(parent.tagName).toLowerCase() === "details" && !parent.open && String(n.tagName).toLowerCase() !== "summary") return false;
      }
      return true;
    });
  }

  /** 一覧の中の ↑↓・Home・End（行に焦点があるときだけ。端では動かない） */
  function onListKey(e) {
    const target = e.target;
    if (!target || !target.classList || !target.classList.contains("v3-row")) return;
    if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(e.key)) return;
    const rows = visibleRows();
    const at = rows.indexOf(target);
    let next = null;
    if (e.key === "Home") next = rows[0];
    else if (e.key === "End") next = rows[rows.length - 1];
    else if (at >= 0) next = rows[at + (e.key === "ArrowDown" ? 1 : -1)];
    e.preventDefault();
    if (next) next.focus();
  }

  // ===== スマホのキーボード（visualViewport。今の殻と同じ） =====
  // iOS はキーボードで layout viewport を縮めないので、見えている高さを --vvh に書いて .v3 をそれに合わせ、ずらされたページを戻す。
  // キーボードが出ている間は .is-keyboard。--kb はキーボードの高さ（シートのダイアログを上に出す）。PC では書かない
  // キーボードの判定は幅ごとの最大の見えている高さとの差で見る。--vvt は visualViewport の上のずれ
  const KEYBOARD_MIN_PX = 100;
  /** ピンチの後に scale が 1 に戻った最後の状態を拾い直すまでの時間（ms） */
  const PINCH_RECHECK_MS = 250;
  /** 幅（px）ごとの最大の見えている高さ */
  const fullHeights = new Map();
  let pinchTimer = null;

  function fitViewport() {
    const vv = window.visualViewport;
    if (!vv || !phone()) {
      root.style.removeProperty("--vvh");
      root.style.removeProperty("--kb");
      root.style.removeProperty("--vvt");
      if (refs.v3) refs.v3.classList.remove("is-keyboard");
      return;
    }
    // ピンチで拡大している間の高さはキーボードではないので書き換えず、少し後に（scale が 1 に戻っていれば）計算し直す
    clearTimeout(pinchTimer);
    if (Math.abs(vv.scale - 1) > 0.01) {
      pinchTimer = setTimeout(fitViewport, PINCH_RECHECK_MS);
      return;
    }
    const width = Math.round(vv.width);
    const full = Math.max(fullHeights.get(width) || 0, vv.height);
    fullHeights.set(width, full);
    const keyboard = vv.height < full - KEYBOARD_MIN_PX;
    const kb = Math.max(0, Math.round(window.innerHeight - vv.height - vv.offsetTop));
    root.style.setProperty("--vvh", Math.round(vv.height) + "px");
    root.style.setProperty("--kb", kb + "px");
    root.style.setProperty("--vvt", Math.round(vv.offsetTop) + "px");
    refs.v3.classList.toggle("is-keyboard", keyboard);
    if (window.scrollY !== 0) window.scrollTo(0, 0);
  }

  function bindViewport() {
    const vv = window.visualViewport;
    if (!vv) return;
    vv.addEventListener("resize", fitViewport);
    vv.addEventListener("scroll", fitViewport);
    fitViewport();
  }

  // ===== キー =====
  function typing(node) {
    return !!node && !!node.closest && !!node.closest("input, textarea, select, [contenteditable]");
  }

  function onKey(e) {
    // Ctrl+K（mac は Meta+K）: 絞り込み欄。入力欄に焦点があっても効かせる
    if ((e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey && (e.key === "k" || e.key === "K")) {
      if (document.querySelector("dialog[open]")) return;
      // 重ねた右腕が開いている間は絞り込み欄が inert の中なので取らない
      if (S.handMode === "over" && S.handOver) return;
      e.preventDefault();
      openSearch();
      return;
    }
    if (e.key !== "Escape") return;
    // IME の変換中の Escape は変換を取り消すだけ（殻は取らない）
    if (e.isComposing || e.keyCode === 229) return;
    if (document.querySelector("dialog[open]")) return;
    // 重ねた右腕は入力欄に焦点があっても畳む（列の右腕は畳まない）
    if (S.handMode === "over" && S.handOver) {
      closeHand();
      return;
    }
    const input = $("v3-search");
    if (input && document.activeElement === input) {
      closeSearch();
      return;
    }
    if (typing(document.activeElement)) return;
    if (phone() && S.view === "body") showList();
  }

  // ===== 起動 =====
  function init() {
    refs.v3 = $("v3");
    refs.list = $("v3-list-body");
    refs.searchBox = $("v3-search-box");

    S.theme = THEMES.includes(load("theme", "dark")) ? load("theme", "dark") : "dark";
    applyTheme();
    const drafts = loadJson("drafts");
    if (drafts && !Array.isArray(drafts)) {
      for (const [id, v] of Object.entries(drafts)) if (typeof v === "string" && v !== "") S.drafts[id] = v;
    }

    S.handWant = load("v3-hand", "1") !== "0";

    bindViewport();
    mqPhone.addEventListener("change", () => {
      setView(S.active ? "body" : "list");
      fitViewport();
      // 帯を先に（右腕が閉じて焦点を戻す先の [右腕] が帯の中にある）
      renderBar();
      fitHand();
    });
    window.addEventListener("popstate", (e) => {
      const st = e.state || {};
      handClosing = false;
      // 重ねた右腕の開閉は履歴の v3Hand に合わせる（スマホで開いたときだけ entry を積む）
      let handClosed = false;
      let handChanged = false;
      if (S.handMode === "over" && S.handOver !== !!st.v3Hand) {
        S.handOver = !!st.v3Hand;
        handChanged = true;
        handClosed = !S.handOver;
        applyHand();
      }
      if (st.v3Body && S.active) setView("body");
      else {
        setView("list");
        // 一覧の行への焦点は右腕が関わらなかったときだけ（閉じたなら開いた口へ戻す）
        if (phone() && !handChanged && !S.handOver) focusCurrentRow();
      }
      if (handClosed) restoreHandFocus();
      // 進むで開いたら [畳む] に焦点
      else if (handChanged) {
        const close = $("v3-hand-close");
        if (close) close.focus();
      }
    });
    window.addEventListener("resize", fitHand);
    // 手で書き換えた hash・リンク（自分で書いた hash は replaceState・pushState なので来ない）
    window.addEventListener("hashchange", () => {
      const tabId = tabFromHash(location.hash);
      if (tabId && tabId !== S.active && SA.views.info(tabId)) open(tabId);
    });
    document.addEventListener("keydown", onKey);
    refs.list.addEventListener("keydown", onListKey);
    // 右腕の 3 つの口と backdrop
    for (const [id, focusInput] of [
      ["v3-hand-show", false],
      ["v3-hand-ask", true],
      ["v3-hand-open", false],
    ]) {
      const b = $(id);
      if (b) b.addEventListener("click", () => openHand(b, focusInput));
    }
    const backdrop = $("v3-hand-backdrop");
    if (backdrop) backdrop.addEventListener("click", () => closeHand());
    renderHeadOps();
    renderConn();
    renderFoot();
    bindStart();
    $("v3-sheet").addEventListener("close", () => {
      const opener = sheetOpener;
      sheetOpener = null;
      if (opener && document.contains(opener)) opener.focus();
    });

    // 最初の 1 枚の前に右腕の形を決める（v3.html の初期値は畳んだ重ねる形）。再読み込みで残った右腕の印は外す
    dropHandMark();
    fitHand();
    applyHand();

    const fromHash = tabFromHash(location.hash);
    if (fromHash && SA.views.info(fromHash)) open(fromHash);
    else {
      deferred = fromHash;
      renderMain();
    }

    // 設定・使用量の画面が使う（今の殻と同じ）
    SA.store.load.usageDays();
    SA.store.load.usage(null);
    // api.js の polling は今のまま全部動かす（chat.js が store.channels・store.running・store.cc を使う）
    SA.poll.start();
    SA.topics.load().then(() => {
      topicsLoaded = true;
      reopenDeferred();
    });
  }

  SA.app = {
    open,
    refresh,
    // 未読の点・選んでいる行を今の値で描き直し、2 秒に 1 回までの読み直し
    refreshSidebar: () => {
      SA.topics.render();
      SA.topics.schedule();
      renderHandEntries();
    },
    refreshActivity: () => SA.topics.render(),
    refreshTabs,
    // タブの見出しの実行中の印は無い
    refreshTabMarks: () => undefined,
    refreshStatus: () => {
      renderConn();
      reopenDeferred();
    },
    refreshNotices: renderConn,
    // 出力のパネルは持たない
    addOutput: () => undefined,
    activeTabId,
    shownChannelIds,
    sidebarShows,
    openDrawer,
    closeDrawer,
    sheet: openSheet,
    noticeLine,
    // サイドバー・パネルは無い
    toggleSidebar: () => undefined,
    togglePanel: () => undefined,
    // パレットは無い。絞り込み欄を出して焦点（prefix は捨てる）
    palette: () => openSearch(),
    // 話題を始める（群の見出しの [+]）。tmux の Claude Code を起動する口は新しい殻に無い
    newSession: (place, opener) => openStart(place || "general", opener || null),
    ccStart: () => undefined,
    theme: () => S.theme,
    setTheme,
    draft: (channelId) => S.drafts[channelId] || "",
    setDraft,
    pruneDrafts,
  };

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();
})();
