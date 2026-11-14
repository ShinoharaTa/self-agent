// 新しい殻（v3.html。docs/plan/web-ui-v3.md §2・§11 の M2）: 話題の一覧（列 1。topics.js）と開いた話題（列 2）、
// SA.app（今の殻 workbench.js と同じ名前の契約。chat.js・views.js・api.js・ui.js・sound.js が呼ぶ）・hash・スマホの一覧 ⇄ 会話・テーマ・書きかけ・シート・キーボードの高さ、
// 下の口（タスク・リマインド・ほか）・接続の点と鈴・絞り込み・一覧のキー・[会話][端末]、右腕の枠（列 3。§4 の M3。畳んだ帯・スマホの 2 つの口・重ねる形・「いま見ている話題」の 1 行）
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
    let text;
    if (t.group === "other") text = "場所: ほかの場所" + (t.cwdLabel ? "（" + t.cwdLabel + "）" : "");
    else if (t.place && t.place.dir) text = "場所: " + t.place.dir;
    else text = "場所: General";
    const place = $("v3-place");
    if (place.textContent !== text) place.textContent = text;
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
    if (phone()) {
      if (S.handOver) {
        S.handOver = false;
        applyHand();
      }
      showBody();
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
  let handOpener = null;
  let handLoadedId = null;
  let handShown = null;
  let handStick = true;

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
    S.handMode = mode;
    S.handOver = false;
    applyHand();
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
  const HAND_FRAME = { title: "右腕", placeholder: "右腕に頼む・訊く", ops: handOps, outgoing: withViewing };

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
          history.pushState({ v3Body: S.view === "body", v3Hand: true }, "", location.href);
        } catch {
          // 積めなくても [畳む]・backdrop で閉じられる
        }
      }
    }
    applyHand();
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
    if (history.state && history.state.v3Hand) {
      try {
        history.back();
        return;
      } catch {
        // 戻れなければその場で閉じる
      }
    }
    S.handOver = false;
    applyHand();
    restoreHandFocus();
  }

  /** 閉じた後の焦点: 開いたボタンがあればそこ、無ければ見えている口 */
  function restoreHandFocus() {
    const opener = handOpener;
    handOpener = null;
    let target = opener && document.contains(opener) ? opener : null;
    if (!target) target = $(!phone() ? "v3-hand-show" : S.view === "body" ? "v3-hand-open" : "v3-hand-ask");
    if (target) target.focus();
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
    if (handVisible() && handShown !== handKey()) renderHand();
    renderHandEntries();
  }

  /** 列 2 に話題が出ていれば、その題名（空白を詰めて 80 字まで）。スマホは会話の上に右腕を出したときだけ */
  function viewingTitle() {
    if (phone() && S.view !== "body") return null;
    const t = S.active ? SA.topics.find(S.active) : null;
    if (!t) return null;
    const title = String(t.title).replace(/\s+/g, " ");
    return title.length > 80 ? title.slice(0, 80) + "…" : title;
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
      // 右腕を開いたまま話題を開いたら、右腕の entry を話題の entry に置き換える
      if (history.state && history.state.v3Hand) history.replaceState({ v3Body: true }, "", hash);
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

  function showList() {
    if (history.state && history.state.v3Body) {
      try {
        // popstate で一覧にする
        history.back();
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
      fitHand();
      renderBar();
    });
    window.addEventListener("popstate", (e) => {
      const st = e.state || {};
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
    $("v3-sheet").addEventListener("close", () => {
      const opener = sheetOpener;
      sheetOpener = null;
      if (opener && document.contains(opener)) opener.focus();
    });

    // 最初の 1 枚の前に右腕の形を決める（v3.html の初期値は畳んだ重ねる形）
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
    // 話題を始める口は M4
    newSession: () => undefined,
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
