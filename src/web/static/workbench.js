// アプリの殻（VS Code の構成）: アクティビティバー・サイドバー・エディタのタブ・パネル・ステータスバー・コマンドパレット・キーボード・hash のルータ・新しいセッションのダイアログ・Claude Code の起動のダイアログ
"use strict";

(function () {
  const SA = (window.SA = window.SA || {});
  const { el, icon, toast, openDialog, closeDialog } = SA.ui;
  const root = document.documentElement;

  // ===== 保存（このブラウザだけ。読めなくても動く） =====
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

  const mqNarrow = window.matchMedia ? window.matchMedia("(max-width: 1023px)") : { matches: false, addEventListener() {} };
  // スマホ（639px 以下）: 下タブは固定 4（会話・タスク・リマインド・その他）。ドロワーの判定は mqNarrow のまま
  const mqPhone = window.matchMedia ? window.matchMedia("(max-width: 639px)") : { matches: false, addEventListener() {} };

  // ===== 状態 =====
  const PANEL_TABS = [
    { id: "output", label: "出力" },
    { id: "notices", label: "知らせ" },
    { id: "jobs", label: "ジョブ" },
  ];

  const THEMES = ["dark", "light", "system"];
  /** パネルの「出力」に残す行の数（このタブのメモリだけ） */
  const OUTPUT_MAX = 500;

  const S = {
    activity: "chat",
    sidebarHidden: false,
    drawerOpen: false,
    // スマホの下からのシート（開いているか・"more" は「その他」、"ops" は見出しの […] のチャンネルの操作・ops を開いたボタン）
    moreOpen: false,
    sheetKind: "more",
    sheetOpener: null,
    tabs: [],
    active: null,
    panelOpen: !mqNarrow.matches,
    panelTab: "output",
    theme: "dark",
    // チャンネルごとの書きかけ（localStorage の drafts。送ったら消す）
    drafts: {},
    // パネルの「出力」の行（{ at, where, text }。古い順）
    output: [],
  };

  const $ = (id) => document.getElementById(id);
  const refs = {};

  function narrow() {
    return mqNarrow.matches;
  }

  function phone() {
    return mqPhone.matches;
  }

  // ===== テーマ =====
  // ブラウザの上の帯の色（--surface。index.html の theme-color の 2 つと同じ値）
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

  function toggleTheme() {
    const dark = root.dataset.theme ? root.dataset.theme === "dark" : window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches;
    setTheme(dark ? "light" : "dark");
  }

  // ===== アクティビティバー =====
  /** 今のアクティビティが出せなくなったら、出せる最初のもの（タブを開くものを除く）にする */
  function ensureActivity() {
    const visible = SA.sidebar.visibleActivities();
    if (visible.some((a) => a.id === S.activity && !a.tab)) return;
    const first = visible.find((a) => !a.tab);
    S.activity = first ? first.id : null;
  }

  /** そのアクティビティのサイドバー（狭い画面ではドロワー）が見えている */
  function sidebarShows(id) {
    return S.activity === id && (narrow() ? S.drawerOpen : !S.sidebarHidden);
  }

  /** アクティビティのボタン 1 つ（数・実行中のスピナー付き） */
  function activityButton(a) {
    // スマホでタブを直接開くもの（タスク・リマインド）は、そのタブが前に出ている間が押された状態
    const asTab = phone() && a.phoneTab;
    const pressed = asTab ? S.active === a.id && !S.drawerOpen : !a.tab && sidebarShows(a.id);
    // 数（会話は未読のチャンネルの数）
    const n = a.count ? a.count() : 0;
    const countLabel = typeof a.countLabel === "function" ? a.countLabel() : a.countLabel || "";
    const label = a.label + (n > 0 ? "（" + countLabel + n + "）" : "");
    const btn = el(
      "button",
      {
        class: "act-btn",
        type: "button",
        "aria-label": label,
        title: label,
        "aria-pressed": a.tab && !asTab ? null : String(pressed),
      },
      [icon(a.icon), el("span", { class: "act-label", text: a.label }), n > 0 ? el("span", { class: "act-count", text: String(n), "aria-hidden": "true" }) : null],
    );
    // 実行中のターンがあれば、スマホでは会話の数の位置にスピナーを出す（CSS で 639px 以下だけ）
    if (a.running && a.running() > 0) {
      btn.classList.add("is-running");
      btn.append(el("span", { class: "spinner spinner-sm act-spin", role: "img", "aria-label": "実行中" }));
    }
    btn.addEventListener("click", () => {
      // スマホで「その他」のシートが開いていれば閉じてから
      closeMore({ keepFocus: true });
      selectActivity(a);
    });
    return btn;
  }

  /** 「その他」の中の画面が前に出ている（一覧が見えている・状態や設定のタブ・ナレッジから開いた記憶のタブ） */
  function moreShows(more) {
    return more.some((a) => (a.tab ? S.active === a.tab : sidebarShows(a.id))) || S.active === "memories";
  }

  function renderActivity() {
    ensureActivity();
    renderTitle();
    if (phone()) {
      // スマホは主要の 3 つ + 「その他」の 1 群（bottom の 2 群分けは使わない）
      const { primary, more } = SA.sidebar.phoneActivities();
      const group = el("div", { class: "act-group" });
      for (const a of primary) group.append(activityButton(a));
      const hasCount = more.some((a) => a.count && a.count() > 0);
      const label = hasCount ? "その他（未読あり）" : "その他";
      // 開閉は aria-expanded だけ（aria-pressed と重ねない）。中の画面が前に出ている間は印の線だけ付ける
      const btn = el(
        "button",
        {
          class: "act-btn act-more" + (moreShows(more) ? " is-current" : ""),
          type: "button",
          "aria-label": label,
          title: label,
          "aria-expanded": String(S.moreOpen && S.sheetKind === "more"),
          "aria-controls": "more-sheet",
        },
        [icon("ellipsis"), el("span", { class: "act-label", text: "その他" }), hasCount ? el("span", { class: "dot dot-unread", "aria-hidden": "true" }) : null],
      );
      btn.addEventListener("click", () => {
        if (S.moreOpen && S.sheetKind === "more") closeMore();
        else {
          closeMore({ keepFocus: true });
          openMore();
        }
      });
      group.append(btn);
      refs.activity.replaceChildren(group);
      return;
    }
    const top = el("div", { class: "act-group" });
    const bottom = el("div", { class: "act-group act-bottom" });
    for (const a of SA.sidebar.visibleActivities()) (a.bottom ? bottom : top).append(activityButton(a));
    refs.activity.replaceChildren(top, bottom);
  }

  // ===== スマホの下からのシート（「その他」と、見出しの […] のチャンネルの操作。同じ #more-sheet を使う） =====
  function renderMore() {
    const items = SA.sidebar.phoneActivities().more.map((a) => {
      const n = a.count ? a.count() : 0;
      const btn = el("button", { class: "more-row", type: "button" }, [
        icon(a.icon),
        el("span", { class: "sb-label", text: a.label }),
        n > 0 ? el("span", { class: "sb-meta", text: String(n) }) : null,
      ]);
      // シートの行は「開く」（同じものを選んでも閉じない）
      btn.addEventListener("click", () => {
        closeMore({ keepFocus: true });
        if (a.tab) {
          open(a.tab);
          closeDrawer();
          refs.editors.focus();
        } else {
          S.activity = a.id;
          openDrawer();
        }
      });
      return el("li", {}, [btn]);
    });
    $("more-sheet").setAttribute("aria-label", "その他の画面");
    $("more-sheet").replaceChildren(sheetHead("その他"), el("ul", { class: "more-list" }, items));
  }

  /** シートの題と ×（閉じ方を見せる。UI-8） */
  function sheetHead(title) {
    const close = el("button", { class: "btn btn-ghost btn-sm btn-icon-sm sheet-close", type: "button", "aria-label": "閉じる" }, [icon("x")]);
    close.addEventListener("click", () => closeMore());
    return el("div", { class: "sheet-head" }, [el("span", { class: "sheet-title", text: title }), close]);
  }

  /** シートを出す（中身は描いた後） */
  function showSheet() {
    S.moreOpen = true;
    refs.wb.classList.add("is-more-open");
    $("more-backdrop").hidden = false;
    renderActivity();
    const first = $("more-sheet").querySelector(".more-row:not([disabled])");
    if (first) first.focus();
  }

  function openMore() {
    S.sheetKind = "more";
    S.sheetOpener = null;
    renderMore();
    showSheet();
  }

  /**
   * 見出しの […] のシート（そのチャンネルの操作だけ。docs/plan/web-ui-polish.md の UI-7）。
   * items は { icon, label, run?, href?, why? }: href は新しいタブで開くリンク、run が無ければ押せない行で why を右に出す。opener は閉じた後に焦点を戻すボタン
   */
  function openSheet(label, items, opener) {
    closeMore({ keepFocus: true });
    S.sheetKind = "ops";
    S.sheetOpener = opener || null;
    const rows = items.map((it) => {
      let row;
      if (it.href) {
        row = el("a", { class: "more-row", href: it.href, target: "_blank", rel: "noreferrer noopener" }, [icon(it.icon || "external-link"), el("span", { class: "sb-label", text: it.label })]);
        row.addEventListener("click", () => closeMore({ keepFocus: true }));
      } else {
        row = el("button", { class: "more-row", type: "button", disabled: !it.run }, [
          icon(it.icon || "circle"),
          el("span", { class: "sb-label", text: it.label }),
          !it.run && it.why ? el("span", { class: "sb-meta", text: it.why }) : null,
        ]);
        if (it.run) {
          row.addEventListener("click", () => {
            closeMore({ keepFocus: true });
            it.run();
          });
        }
      }
      return el("li", {}, [row]);
    });
    $("more-sheet").setAttribute("aria-label", label);
    $("more-sheet").replaceChildren(sheetHead(label), el("ul", { class: "more-list" }, rows));
    showSheet();
  }

  /** opts.keepFocus は行を選んだとき（焦点は開いた先が決める） */
  function closeMore(opts) {
    if (!S.moreOpen) return;
    S.moreOpen = false;
    refs.wb.classList.remove("is-more-open");
    $("more-backdrop").hidden = true;
    renderActivity();
    if (!(opts && opts.keepFocus)) {
      const opener = S.sheetKind === "ops" ? S.sheetOpener : refs.activity.querySelector(".act-more");
      if (opener && document.contains(opener)) opener.focus();
    }
    S.sheetOpener = null;
  }

  function selectActivity(a) {
    // スマホ: タスク・リマインドはタブを直接開き、一覧のあるもの（会話）は押すたびに一覧を開く（閉じない）
    if (phone() && a.phoneTab) {
      open(a.id);
      closeDrawer();
      return;
    }
    if (phone() && !a.tab) {
      S.activity = a.id;
      openDrawer();
      return;
    }
    if (a.tab) {
      open(a.tab);
      closeDrawer();
      return;
    }
    if (narrow()) {
      if (S.activity === a.id && S.drawerOpen) closeDrawer();
      else {
        S.activity = a.id;
        openDrawer();
      }
    } else if (S.activity === a.id) {
      S.sidebarHidden = !S.sidebarHidden;
      applyLayout();
    } else {
      S.activity = a.id;
      S.sidebarHidden = false;
      applyLayout();
    }
    renderActivity();
    renderSidebar();
  }

  // ===== サイドバー・ドロワー =====
  function renderSidebar() {
    ensureActivity();
    SA.sidebar.render(refs.sidebar, S.activity);
  }

  function applyLayout() {
    refs.wb.classList.toggle("is-sidebar-hidden", S.sidebarHidden);
    refs.wb.classList.toggle("is-drawer-open", S.drawerOpen);
    refs.wb.classList.toggle("is-panel-hidden", !S.panelOpen);
    $("drawer-backdrop").hidden = !S.drawerOpen;
    $("sidebar-toggle").setAttribute("aria-expanded", String(narrow() ? S.drawerOpen : !S.sidebarHidden));
    $("panel-toggle").setAttribute("aria-pressed", String(S.panelOpen));
  }

  /**
   * 一覧を開く。スマホで、本文が一覧から開いた履歴（pushState の saBody）の上にあれば戻る（popstate で一覧を開く。
   * [‹]・下タブ「会話」・ブラウザの戻る・端のスワイプが同じ履歴の 1 段になる）
   */
  function openDrawer() {
    if (phone() && !S.drawerOpen && history.state && history.state.saBody) {
      try {
        history.back();
        return;
      } catch {
        // 戻れなければその場で開く
      }
    }
    showDrawer();
  }

  function showDrawer() {
    S.drawerOpen = true;
    applyLayout();
    renderActivity();
    renderSidebar();
    const first = refs.sidebar.querySelector("input, button");
    if (first) first.focus();
  }

  /** 一覧を閉じる。スマホで本文が見えるようになったら、その本文を履歴に積む（戻ると一覧） */
  function closeDrawer() {
    if (!S.drawerOpen) return;
    S.drawerOpen = false;
    applyLayout();
    renderActivity();
    if (phone() && S.active) {
      try {
        history.pushState({ saBody: true }, "", "#/" + S.active.replace(":", "/"));
      } catch {
        // 積めなくても [‹] で一覧に戻れる
      }
    }
  }

  function toggleSidebar() {
    if (narrow()) {
      if (S.drawerOpen) closeDrawer();
      else openDrawer();
      return;
    }
    S.sidebarHidden = !S.sidebarHidden;
    applyLayout();
    renderActivity();
  }

  // ===== スマホのタイトルバーの中央（今の画面の名前。一覧なら一覧の名前、本文なら題名） =====
  function renderTitle() {
    const node = $("title-current");
    if (!node) return;
    let text = "";
    if (S.drawerOpen) {
      const a = SA.sidebar.visibleActivities().find((x) => x.id === S.activity);
      text = a ? a.label : "";
    } else if (S.active) {
      const info = SA.views.info(S.active);
      text = info ? info.title : "";
    }
    if (node.textContent !== text) node.textContent = text;
  }

  // ===== hash のルータ（#/status・#/ch/<id> など。サーバーには届かない） =====
  const PREFIXED = ["ch", "project", "job", "cc"];

  function tabFromHash(hash) {
    const path = String(hash || "").replace(/^#\/?/, "");
    if (path === "") return null;
    const slash = path.indexOf("/");
    if (slash > 0 && PREFIXED.includes(path.slice(0, slash))) return path.slice(0, slash) + ":" + path.slice(slash + 1);
    return path;
  }

  function writeHash() {
    try {
      // 履歴の印（saBody）は残す
      if (S.active) history.replaceState(history.state, "", "#/" + S.active.replace(":", "/"));
      else history.replaceState(history.state, "", location.pathname + location.search);
    } catch {
      // hash を書けなくても画面は動く
    }
  }

  function saveTabs() {
    save("tabs", JSON.stringify({ tabs: S.tabs, active: S.active }));
  }

  // ===== エディタ（タブ） =====
  function activeTabId() {
    return S.active;
  }

  function renderEditors() {
    renderTitle();
    const box = refs.editors;
    const section = el("section", { class: "wb-group is-active", "aria-label": "エディタ" });
    if (S.tabs.length === 0) {
      const ed = el("div", { class: "ed" });
      SA.views.renderWelcome(ed);
      section.append(ed);
      box.replaceChildren(section);
      return;
    }
    const tabbar = el("div", { class: "tabbar" });
    const tablist = el("div", { class: "tablist", role: "tablist", "aria-label": "開いているタブ" });
    for (const id of S.tabs) {
      const info = SA.views.info(id);
      if (!info) continue;
      const selected = id === S.active;
      const label = el("button", { class: "tab-label", type: "button", role: "tab", "aria-selected": String(selected), tabindex: selected ? "0" : "-1", title: info.title }, [
        icon(info.icon),
        el("span", { class: "tab-text", text: info.title }),
        info.dirty ? el("span", { class: "spinner spinner-sm", role: "img", "aria-label": "実行中" }) : null,
      ]);
      label.addEventListener("click", () => activate(id));
      label.addEventListener("auxclick", (e) => {
        if (e.button === 1) closeTab(id);
      });
      label.addEventListener("keydown", (e) => {
        if (e.key === "ArrowRight" || e.key === "ArrowLeft") {
          const i = S.tabs.indexOf(id);
          const next = S.tabs[(i + (e.key === "ArrowRight" ? 1 : S.tabs.length - 1)) % S.tabs.length];
          activate(next);
          const n = refs.editors.querySelector('.tab-label[aria-selected="true"]');
          if (n) n.focus();
        }
      });
      const close = el("button", { class: "tab-close", type: "button", "aria-label": info.title + " を閉じる", tabindex: "-1" }, [icon("x")]);
      close.addEventListener("click", (e) => {
        e.stopPropagation();
        closeTab(id);
      });
      tablist.append(el("div", { role: "presentation", class: "tab" + (selected ? " is-selected" : ""), "data-tab": id }, [label, close]));
    }
    tabbar.append(tablist, el("div", { class: "tabbar-actions" }));
    const ed = el("div", { class: "ed", role: "tabpanel", id: "ed" });
    section.append(tabbar, ed);
    box.replaceChildren(section);
    renderEd(ed, S.active);
  }

  /** タブの中身を描く。スクロール位置は保つ */
  function renderEd(ed, tabId) {
    const oldScroll = ed.querySelector(".ed-scroll");
    const wasBottom = !oldScroll || oldScroll.scrollHeight - oldScroll.scrollTop - oldScroll.clientHeight < 48;
    const oldTop = oldScroll ? oldScroll.scrollTop : 0;
    const info = tabId ? SA.views.info(tabId) : null;
    if (!info) {
      SA.views.renderWelcome(ed);
      return;
    }
    info.render(ed);
    const scroll = ed.querySelector(".ed-scroll");
    if (scroll) {
      if (scroll.dataset.stick === "bottom" && wasBottom) scroll.scrollTop = scroll.scrollHeight;
      else if (oldScroll) scroll.scrollTop = oldTop;
    }
  }

  function activate(tabId) {
    if (!S.tabs.includes(tabId)) return;
    S.active = tabId;
    saveTabs();
    writeHash();
    renderEditors();
    renderSidebar();
    renderActivity();
    const info = SA.views.info(tabId);
    if (info && info.onOpen) info.onOpen();
  }

  /** タブを開く（あれば前に出す）。知らない・無効な機能のタブは開かない */
  function open(tabId) {
    if (!tabId || !SA.views.info(tabId)) return;
    if (!S.tabs.includes(tabId)) {
      const at = S.tabs.indexOf(S.active);
      S.tabs.splice(at + 1, 0, tabId);
    }
    activate(tabId);
  }

  function closeTab(tabId) {
    const i = S.tabs.indexOf(tabId);
    if (i < 0) return;
    const closing = SA.views.info(tabId);
    if (closing && closing.onClose) closing.onClose();
    S.tabs.splice(i, 1);
    if (S.active === tabId) {
      S.active = S.tabs[Math.min(i, S.tabs.length - 1)] || null;
      const info = S.active ? SA.views.info(S.active) : null;
      if (info && info.onOpen) info.onOpen();
    }
    saveTabs();
    writeHash();
    renderEditors();
    renderSidebar();
  }

  /** tabId が前に出ていれば中身だけ描き直す */
  function refresh(tabId) {
    if (!refs.editors || S.active !== tabId) return;
    const ed = $("ed");
    if (ed) renderEd(ed, tabId);
  }

  /** タブの見出しの実行中の印だけを付け外しする（中身は描き直さない。書きかけの入力欄を保つ） */
  function refreshTabMarks() {
    if (!refs.editors) return;
    for (const tab of refs.editors.querySelectorAll(".tab")) {
      const info = SA.views.info(tab.getAttribute("data-tab"));
      const label = tab.querySelector(".tab-label");
      if (!label) continue;
      const spin = label.querySelector(".spinner");
      if (info && info.dirty && !spin) label.append(el("span", { class: "spinner spinner-sm", role: "img", "aria-label": "実行中" }));
      if (info && !info.dirty && spin) spin.remove();
    }
  }

  // ===== パネル（出力は実行中のターンの手順と終わり方、知らせは #system に出したもの。ジョブの中身は後の段） =====
  function savePanel() {
    save("panel", JSON.stringify({ open: S.panelOpen, tab: S.panelTab }));
  }

  function renderPanel() {
    const tabs = el("div", { class: "panel-tabs", role: "tablist", "aria-label": "パネル" });
    for (const t of PANEL_TABS) {
      const b = el("button", { class: "panel-tab", type: "button", role: "tab", "aria-selected": String(S.panelTab === t.id) }, [
        t.label,
        t.id === "notices" ? el("span", { class: "sb-count", id: "panel-notices-count", title: "直近 24 時間", text: noticeCount() }) : null,
      ]);
      b.addEventListener("click", () => {
        S.panelTab = t.id;
        savePanel();
        renderPanel();
        if (t.id === "notices") SA.store.load.notices();
      });
      tabs.append(b);
    }
    const close = el("button", { class: "btn btn-ghost btn-sm btn-icon-sm", type: "button", "aria-label": "パネルを閉じる（Ctrl+J）", title: "パネルを閉じる（Ctrl+J）" }, [icon("x")]);
    close.addEventListener("click", () => togglePanel(false));
    const body = el("div", { class: "panel-body", role: "tabpanel" });
    if (S.panelTab === "output") {
      body.append(el("ol", { class: "out-list", id: "out-list", "aria-live": "polite" }, S.output.map(outLine)));
      if (S.output.length === 0) body.append(el("p", { class: "meta panel-note", text: "実行中のターンの手順と終わり方がここに出ます。この画面を開いている間だけ残ります。" }));
    } else if (S.panelTab === "notices") {
      const data = SA.store.notices;
      if (data === null) body.append(el("p", { class: "meta panel-note", text: "読み込んでいます…" }));
      else {
        if (data.notices.length > 0) body.append(el("ul", { class: "notice-list" }, data.notices.map(noticeLine)));
        body.append(el("p", { class: "meta panel-note", text: data.notices.length > 0 ? "#system に出した知らせと同じものです。" : "知らせはありません。#system に出たものがここにも出ます。" }));
      }
    } else {
      body.append(el("p", { class: "meta panel-note", text: "ジョブはまだありません。" }));
    }
    refs.panel.replaceChildren(el("div", { class: "panel-head" }, [tabs, el("span", { class: "sb-spacer" }), close]), body);
    const list = $("out-list");
    if (list) list.scrollTop = list.scrollHeight;
  }

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

  /** 直近 24 時間の知らせの数（まだ読んでいなければ空） */
  function noticeCount() {
    const data = SA.store.notices;
    return data === null ? "" : String(data.recent24h);
  }

  /** パネルを開いてそのタブを出す */
  function showPanel(tab) {
    S.panelTab = tab;
    if (S.panelOpen) {
      savePanel();
      renderPanel();
    } else togglePanel(true);
    if (tab === "notices") SA.store.load.notices();
  }

  /** /api/notices が変わったとき: ステータスバーとパネルの数、知らせを出していればパネル */
  function refreshNotices() {
    if (!refs.status) return;
    renderStatus();
    const badge = $("panel-notices-count");
    if (badge) badge.textContent = noticeCount();
    if (S.panelOpen && S.panelTab === "notices") renderPanel();
    refresh("notices");
  }

  function outLine(o) {
    return el("li", { class: "out-line" }, [el("span", { class: "out-time", text: o.at }), el("span", { class: "out-where", text: o.where }), el("span", { text: o.text })]);
  }

  /** パネルの「出力」に 1 行足す（OUTPUT_MAX を超えたら古いものから落とす） */
  function addOutput(where, text) {
    const o = { at: SA.ui.clock(new Date()), where, text };
    S.output.push(o);
    const dropped = S.output.length > OUTPUT_MAX;
    if (dropped) S.output.shift();
    const list = $("out-list");
    if (!list) return;
    if (dropped || list.children.length === 0) {
      // 最初の行・落とした行があれば描き直す（案内の文を消すため）
      if (S.panelOpen && S.panelTab === "output") renderPanel();
      return;
    }
    list.append(outLine(o));
    list.scrollTop = list.scrollHeight;
  }

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

  function togglePanel(force) {
    S.panelOpen = typeof force === "boolean" ? force : !S.panelOpen;
    savePanel();
    applyLayout();
    if (S.panelOpen) renderPanel();
  }

  // ===== ステータスバー =====
  function sbarItem(children, opts) {
    const b = el("button", { class: "sbar-item" + (opts.cls ? " " + opts.cls : ""), type: "button", title: opts.title || null }, children);
    b.addEventListener("click", opts.run);
    return b;
  }

  function renderStatus() {
    const status = SA.store.status;
    const left = el("div", { class: "sbar-side" });
    const right = el("div", { class: "sbar-side" });
    if (status) {
      for (const b of status.bots || []) {
        left.append(
          sbarItem([el("span", { class: "dot " + (b.connected ? "dot-ok" : "dot-bad"), "aria-hidden": "true" }), b.name], {
            title: b.name + " の Bot: " + (b.connected ? "接続中" : "接続できません"),
            run: () => open("status"),
          }),
        );
      }
      if (status.shell && status.shell.configured) {
        left.append(sbarItem([icon("terminal"), "シェル " + (status.shell.enabled ? "通ります" : "通りません")], { title: "シェルの自己診断", run: () => open("status"), cls: "hide-sm" }));
      }
      // 実行中のターンは /api/running（2 秒ごと）があればそれ、まだ無ければ /api/status の数
      const running = SA.store.running;
      const count = running ? running.length : status.running;
      if (count > 0) {
        const first = running && running[0] ? "ch:" + running[0].channelId : null;
        left.append(
          sbarItem([el("span", { class: "spinner spinner-sm", "aria-hidden": "true" }), "実行中 " + count], {
            title: "実行中のターン",
            run: () => (first && SA.views.info(first) ? open(first) : open("status")),
          }),
        );
      }
    }
    const notices = SA.store.notices;
    if (notices !== null) right.append(sbarItem([icon("bell"), String(notices.recent24h)], { title: "知らせ（直近 24 時間）", run: () => showPanel("notices") }));
    const today = SA.views.todayTokens();
    if (today !== null) right.append(sbarItem(["今日 " + SA.views.compact(today)], { title: "今日のトークン（入力）", run: () => open("usage") }));
    if (status && status.version) right.append(sbarItem(["v" + status.version], { title: "状態", run: () => open("status"), cls: "hide-sm" }));
    refs.status.replaceChildren(left, right);
    renderTitleStatus();
  }

  /** スマホ（ステータスバーを出さない幅）のタイトルバー: 名前の右に既定の人格の Bot の接続の点、右に知らせの鈴（CSS で 639px 以下だけ） */
  function renderTitleStatus() {
    if (!refs.titleStatus) return;
    const status = SA.store.status;
    const items = [];
    const bot = status && status.bots ? status.bots[0] : null;
    if (bot) {
      const label = bot.name + " の Bot: " + (bot.connected ? "接続中" : "接続できません");
      const b = el("button", { class: "btn btn-ghost btn-sm btn-icon-sm", type: "button", "aria-label": label, title: label }, [
        el("span", { class: "dot " + (bot.connected ? "dot-ok" : "dot-bad"), "aria-hidden": "true" }),
      ]);
      b.addEventListener("click", () => {
        open("status");
        closeDrawer();
      });
      // スマホでは名前（self-agent）の右に置く（署名の「生きている点」）
      if (refs.brandStatus) refs.brandStatus.replaceChildren(b);
    } else if (refs.brandStatus) refs.brandStatus.replaceChildren();
    const notices = SA.store.notices;
    if (notices !== null) {
      const label = "知らせ（直近 24 時間 " + notices.recent24h + " 件）";
      const b = el("button", { class: "btn btn-ghost btn-sm title-bell", type: "button", "aria-label": label, title: label }, [
        icon("bell"),
        notices.recent24h > 0 ? el("span", { class: "title-bell-count", text: String(notices.recent24h), "aria-hidden": "true" }) : null,
      ]);
      // スマホにパネルは無いので、知らせのタブを開く
      b.addEventListener("click", () => {
        if (phone()) {
          open("notices");
          closeDrawer();
        } else showPanel("notices");
      });
      items.push(b);
    }
    refs.titleStatus.replaceChildren(...items);
  }

  /** /api/status が変わったとき: ステータスバーと、出す項目が変わりうるアクティビティバー・サイドバー。status を待っていたタブを開き直す */
  function refreshStatus() {
    if (!refs.status) return;
    reopenDeferred();
    const before = S.activity;
    renderStatus();
    renderActivity();
    if (S.activity !== before) renderSidebar();
  }

  // ===== コマンドパレット =====
  function commands() {
    const active = activeTabId();
    // 前に出ている会話のタブのチャンネル（/close・/wait はセッション、/renew は会話のタブのとき）
    const ch = SA.chat.current();
    // 要約を待っている間は /close・/renew を重ねない
    const busy = !!ch && SA.chat.busy(ch.id);
    const sessionOnly = (fn) => (ch && ch.kind === "session" && !busy ? fn : null);
    const sessionWhyOf = (why) => (busy && ch && ch.kind === "session" ? SA.chat.BUSY_TEXT : why);
    // label は動詞句、Discord のコマンド名・キーは右の kbd（keys）。使えないときは why を detail の位置に出す
    const sessionWhy = sessionWhyOf("セッションの会話のタブで使えます");
    return [
      { label: "新しいセッションを作る", keys: "/new", detail: "題名と人格を決めて作ります", run: newSession },
      // Claude Code の起動（会話の一覧の群「Claude Code」の [Claude Code を起動] と同じダイアログ）。連携が無効なら出さない
      ...(SA.store.ccEnabled() ? [{ label: "Claude Code を起動", detail: "この機械の tmux に新しいセッションを作ります", run: ccStart }] : []),
      { label: "今のセッションを閉じる", keys: "/close", detail: "要約してから完了に移します", run: sessionOnly(() => SA.chat.closeSession(ch.id)), why: sessionWhy },
      { label: "今のセッションを待ちにする", keys: "/wait", detail: "発言すると進行中に戻ります", run: sessionOnly(() => SA.chat.setWaiting(ch.id)), why: sessionWhy },
      // Claude Code のチャンネルにはターンが無いので使えない（CC14）
      {
        label: "会話を新しくする",
        keys: "/renew",
        detail: "要約して新しい会話に引き継ぎます",
        run: ch && ch.kind !== "cc" && !busy ? () => SA.chat.renew(ch.id) : null,
        why: busy ? SA.chat.BUSY_TEXT : ch && ch.kind === "cc" ? "Claude Code のチャンネルでは使えません" : "会話のタブで使えます",
      },
      // Claude Code のチャンネルの [閉じる]・リンク（≤639px の見出しでは […] からここへ。Discord の /cc close と同じ）
      ...(ch && ch.kind === "cc" ? ccCommands(ch) : []),
      { label: "タスクを開く", keys: "/tasks", detail: "", run: () => open("tasks") },
      { label: "リマインドを開く", keys: "/reminders", detail: "", run: () => open("reminders") },
      { label: "使用量を開く", keys: "/usage", detail: "", run: () => open("usage") },
      { label: "状態を開く", detail: "", run: () => open("status") },
      { label: "設定を開く", detail: "", run: () => open("settings") },
      // PC の画面の部品（スマホにはサイドバー・パネル・タブの帯が無く、テーマは設定で変える）
      { label: "サイドバーを切り替える", keys: "Ctrl+B", run: toggleSidebar, pcOnly: true },
      { label: "パネルを切り替える", keys: "Ctrl+J", run: () => togglePanel(), pcOnly: true },
      { label: "タブを閉じる", keys: "Alt+W", run: active ? () => closeTab(active) : null, why: "開いているタブがありません", pcOnly: true },
      { label: "テーマを切り替える", detail: "ダーク / ライト", run: toggleTheme, pcOnly: true },
    ].filter((it) => !(it.pcOnly && phone()));
  }

  /** Claude Code のチャンネルのコマンド（閉じる・RC で開く・Discord で開く） */
  function ccCommands(ch) {
    const rc = SA.chat.ccRcUrl(ch.id);
    const discord = SA.chat.discordUrl(ch.link);
    const items = [
      {
        label: "このチャンネルを閉じる",
        keys: "/cc close",
        detail: "Discord のチャンネルを完了に移します",
        run: SA.chat.ccClosable(ch.id) ? () => SA.chat.closeCcChannel(ch.id) : null,
        why: "閉じています",
      },
    ];
    if (rc) items.push({ label: "RC で開く", detail: "", run: () => window.open(rc, "_blank", "noopener,noreferrer") });
    if (discord) items.push({ label: "Discord で開く", detail: "", run: () => window.open(discord, "_blank", "noopener,noreferrer") });
    return items;
  }

  function gotoItems() {
    const items = [];
    for (const a of SA.sidebar.visibleActivities()) {
      const tab = a.tab || (SA.views.info(a.id) ? a.id : null);
      if (!tab) continue;
      items.push({ label: a.label, detail: "画面", icon: a.icon, run: () => open(tab) });
    }
    items.push({ label: "記憶", detail: "画面", icon: "book", run: () => open("memories") });
    return items;
  }

  const P = { items: [], index: 0 };

  function palette(prefix) {
    const back = $("palette-backdrop");
    const input = $("palette-input");
    back.hidden = false;
    input.value = prefix || "";
    P.index = 0;
    renderPalette();
    input.focus();
  }

  function closePalette() {
    $("palette-backdrop").hidden = true;
  }

  function renderPalette() {
    const input = $("palette-input");
    const raw = input.value;
    const isCmd = raw.startsWith(">") || raw.startsWith("/");
    const q = (raw.startsWith(">") ? raw.slice(1) : raw).trim().toLowerCase();
    const source = isCmd ? commands() : gotoItems();
    P.items = source.filter((it) => q === "" || (it.label + " " + (it.detail || "") + " " + (it.keys || "")).toLowerCase().includes(q));
    P.index = Math.min(P.index, Math.max(0, P.items.length - 1));
    $("palette-mode").textContent = isCmd ? "コマンド" : "移動（> でコマンド）";
    const list = $("palette-list");
    if (P.items.length === 0) {
      list.replaceChildren(el("li", { class: "palette-empty", text: "見つかりません" }));
      input.removeAttribute("aria-activedescendant");
      return;
    }
    list.replaceChildren(
      ...P.items.map((it, i) => {
        const li = el("li", { class: "palette-item" + (it.run ? "" : " is-disabled"), role: "option", id: "pal-" + i, "aria-selected": String(i === P.index), "aria-disabled": it.run ? null : "true" }, [
          // アイコンの無い候補は空の 16px の箱（一律の chevron を置かない。GUIDELINES §5 パレット）
          it.icon ? icon(it.icon) : el("span", { class: "icon icon-blank", "aria-hidden": "true" }),
          el("span", { class: "palette-label", text: it.label }),
          el("span", { class: "palette-detail", text: it.run ? it.detail || "" : it.why || "今は使えません" }),
          it.keys ? el("kbd", { text: it.keys }) : null,
        ]);
        li.addEventListener("mousemove", () => {
          if (P.index !== i) {
            P.index = i;
            markPalette();
          }
        });
        li.addEventListener("click", () => runPalette(i));
        return li;
      }),
    );
    markPalette();
  }

  function markPalette() {
    const items = $("palette-list").querySelectorAll(".palette-item");
    items.forEach((n, i) => n.setAttribute("aria-selected", String(i === P.index)));
    $("palette-input").setAttribute("aria-activedescendant", "pal-" + P.index);
    const cur = items[P.index];
    if (cur && cur.scrollIntoView) cur.scrollIntoView({ block: "nearest" });
  }

  function runPalette(i) {
    const it = P.items[i];
    if (!it || !it.run) return;
    closePalette();
    it.run();
  }

  function bindPalette() {
    const input = $("palette-input");
    input.addEventListener("input", () => {
      P.index = 0;
      renderPalette();
    });
    input.addEventListener("keydown", (e) => {
      if (e.isComposing) return;
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        if (P.items.length === 0) return;
        P.index = (P.index + (e.key === "ArrowDown" ? 1 : P.items.length - 1)) % P.items.length;
        markPalette();
      } else if (e.key === "Enter") {
        e.preventDefault();
        runPalette(P.index);
      } else if (e.key === "Escape") {
        e.preventDefault();
        closePalette();
      }
    });
    $("palette-backdrop").addEventListener("pointerdown", (e) => {
      if (e.target === $("palette-backdrop")) closePalette();
    });
  }

  // ===== 新しいセッション（Discord の /new と同じ。POST /api/sessions） =====
  /** 作れなかったときのトースト（応答の error ごと）。無ければ api.js の「操作に失敗しました。…」 */
  const NEW_ERRORS = {
    not_set_up: "作れませんでした。Discord で /setup を実行してください",
    bot_disconnected: "作れませんでした。Bot が Discord につながっていません",
    too_long: "題名は 100 字までです",
  };
  let creating = false;

  /** ダイアログを開く。サーバーは /setup 済みのもの（1 つなら隠す）、人格は足した人格があるときだけ選ぶ */
  async function newSession() {
    if (SA.store.channels === null) await SA.store.load.channels();
    const channels = SA.store.channels;
    if (channels === null) return;
    const guilds = channels.guilds.filter((g) => g.setUp);
    if (guilds.length === 0) {
      toast("セッションを作れるサーバーがありません。Discord で /setup を実行してください");
      return;
    }
    $("new-guild").replaceChildren(...guilds.map((g) => el("option", { value: g.id, text: g.id })));
    $("new-guild-field").hidden = guilds.length < 2;
    const personas = channels.personas;
    $("new-persona").replaceChildren(...personas.map((p) => el("option", { value: p.id, text: p.name + (p.isDefault ? "（既定）" : "") })));
    $("new-persona-field").hidden = personas.length < 2;
    $("new-title").value = "";
    newError(false);
    openDialog($("dlg-new"));
    $("new-title").focus();
  }

  /** 題名のエラーの表示（欄のすぐ下の role=alert と、欄の aria-invalid。GUIDELINES §5 入力欄） */
  function newError(shown) {
    $("new-error").textContent = shown ? "題名を入れてください" : "";
    $("new-error").hidden = !shown;
    if (shown) $("new-title").setAttribute("aria-invalid", "true");
    else $("new-title").removeAttribute("aria-invalid");
  }

  function bindNewSession() {
    const dialog = $("dlg-new");
    $("dlg-new-cancel").addEventListener("click", () => closeDialog(dialog));
    $("new-form").addEventListener("submit", async (e) => {
      e.preventDefault();
      if (creating) return;
      const title = $("new-title").value.trim();
      if (title === "") {
        newError(true);
        $("new-title").focus();
        return;
      }
      newError(false);
      const body = { guildId: $("new-guild").value, title };
      if (!$("new-persona-field").hidden) body.persona = $("new-persona").value;
      creating = true;
      $("dlg-new-ok").disabled = true;
      try {
        const data = await SA.api.post("/api/sessions", body, { quiet: true });
        closeDialog(dialog);
        toast("セッション「" + title + "」を作りました");
        if (data && typeof data.channelId === "string") {
          S.activity = "chat";
          open("ch:" + data.channelId);
        }
        SA.store.load.channels();
      } catch (err) {
        if (err && err.code === "empty_title") {
          newError(true);
          $("new-title").focus();
        } else if (err && err.toast) toast((err.code && NEW_ERRORS[err.code]) || err.toast, null, { level: "error" });
      } finally {
        creating = false;
        $("dlg-new-ok").disabled = false;
      }
    });
  }

  // ===== 新しい Claude Code のセッション（POST /api/cc/sessions。docs/plan/claude-code-sessions.md §4.2・§5.1） =====
  /** 題名の形（サーバーの src/cc/starter.ts の CC_TITLE_PATTERN と同じ） */
  const CC_TITLE = /^[\p{L}\p{N}][\p{L}\p{N} _.-]{0,39}$/u;
  /** 起動できなかったときの文（応答の error ごと）。無ければ api.js のトーストの「操作に失敗しました。…」 */
  const CC_START_ERRORS = {
    invalid_project: "このプロジェクトでは起動できません。起動できるのはワークスペースの直下のディレクトリだけです",
    invalid_title: "題名は文字か数字で始まる、文字・数字・空白・_ . - の 40 字までです（' などの記号は使えません）",
    invalid_mode: "権限モードを選び直してください",
    too_long: "最初の指示は 4,000 字までです",
    invalid_text: "最初の指示に改行のほかの制御文字（タブなど）は使えません",
    limit: "Claude Code のセッションが上限の数に達しています",
    low_memory: "空きメモリが 1 GB 未満のため起動しません",
    too_soon: "前の起動から 1 分経っていません。少し待ってください",
    not_ready: "セッションの一覧をまだ読めていません。少し待ってください",
    no_server: "tmux が動いていません。端末で tmux を始めてから起動してください",
    tmux_failed: "tmux でセッションを作れませんでした",
    stopping: "再起動中です。終わったら起動してください",
  };
  const CC_TEXT_MAX = 2000;
  let ccStarting = false;

  /** 起動のエラーを欄の下に出す。field（題名・最初の指示の欄）があればそれに aria-invalid を付ける。text が null なら消す */
  function ccStartError(text, field) {
    $("cc-start-error").textContent = text || "";
    $("cc-start-error").hidden = text === null;
    for (const id of ["cc-start-title", "cc-start-text"]) {
      if (id === field) $(id).setAttribute("aria-invalid", "true");
      else $(id).removeAttribute("aria-invalid");
    }
  }

  /** ダイアログを開く。プロジェクトは /api/cc/projects（SELF_AGENT_WORKSPACE_DIR の直下）から */
  async function ccStart() {
    let data;
    try {
      data = await SA.api.get("/api/cc/projects", { quiet: true });
    } catch (err) {
      toast(err && err.toast ? err.toast : "サーバーにつながりません", null, { level: "error", retry: ccStart });
      return;
    }
    const projects = Array.isArray(data && data.projects) ? data.projects.filter((p) => p && typeof p.name === "string") : [];
    if (projects.length === 0) {
      toast("起動できるプロジェクトがありません。ワークスペースの直下にディレクトリを作ってください");
      return;
    }
    const keep = $("cc-start-project").value;
    $("cc-start-project").replaceChildren(...projects.map((p) => el("option", { value: p.name, text: p.name })));
    if (projects.some((p) => p.name === keep)) $("cc-start-project").value = keep;
    $("cc-start-title").value = "";
    $("cc-start-text").value = "";
    $("cc-start-mode").value = "";
    ccStartError(null);
    openDialog($("dlg-cc-start"));
    $("cc-start-title").focus();
  }

  function bindCcStart() {
    const dialog = $("dlg-cc-start");
    $("dlg-cc-start-cancel").addEventListener("click", () => closeDialog(dialog));
    $("cc-start-form").addEventListener("submit", async (e) => {
      e.preventDefault();
      if (ccStarting) return;
      const title = $("cc-start-title").value.trim();
      if (!CC_TITLE.test(title)) {
        ccStartError(CC_START_ERRORS.invalid_title, "cc-start-title");
        $("cc-start-title").focus();
        return;
      }
      const text = $("cc-start-text").value;
      if ([...text.replace(/\n+$/, "")].length > CC_TEXT_MAX) {
        ccStartError("最初の指示は 2,000 字までです", "cc-start-text");
        $("cc-start-text").focus();
        return;
      }
      const body = { project: $("cc-start-project").value, title };
      if (text.trim() !== "") body.text = text;
      if ($("cc-start-mode").value !== "") body.permissionMode = $("cc-start-mode").value;
      ccStarting = true;
      $("dlg-cc-start-ok").disabled = true;
      ccStartError(null);
      try {
        await SA.api.post("/api/cc/sessions", body, { quiet: true });
        closeDialog(dialog);
        // trust の答え方はサイドバーの起動中の行に出す
        toast("「" + title + "」を起動しました" + (body.text ? "。最初の指示は入力待ちになったら届けます" : ""));
        SA.store.load.cc({ quiet: true });
      } catch (err) {
        const known = err && err.code && CC_START_ERRORS[err.code];
        if (known) ccStartError(known, err.code === "invalid_title" ? "cc-start-title" : err.code === "too_long" || err.code === "invalid_text" ? "cc-start-text" : null);
        else if (err && err.toast) toast(err.toast, null, { level: "error" });
      } finally {
        ccStarting = false;
        $("dlg-cc-start-ok").disabled = false;
      }
    });
  }

  // ===== スマホのキーボード（visualViewport。UI-8） =====
  // iOS はキーボードで layout viewport を縮めないので、見えている高さを --vvh に書いて .wb をそれに合わせ、ずらされたページを戻す。
  // キーボードが出ている間は .is-keyboard（≤639px で下タブを隠す）。--kb はキーボードの高さ（シートのダイアログを上に出す）。PC では書かない
  const KEYBOARD_MIN_PX = 100;

  function fitViewport() {
    const vv = window.visualViewport;
    if (!vv || !phone()) {
      root.style.removeProperty("--vvh");
      root.style.removeProperty("--kb");
      if (refs.wb) refs.wb.classList.remove("is-keyboard");
      return;
    }
    // ピンチで拡大している間の高さはキーボードではないので書き換えない
    if (Math.abs(vv.scale - 1) > 0.01) return;
    const kb = Math.max(0, Math.round(window.innerHeight - vv.height - vv.offsetTop));
    root.style.setProperty("--vvh", Math.round(vv.height) + "px");
    root.style.setProperty("--kb", kb + "px");
    refs.wb.classList.toggle("is-keyboard", vv.height < window.innerHeight - KEYBOARD_MIN_PX);
    if (window.scrollY !== 0) window.scrollTo(0, 0);
  }

  function bindViewport() {
    const vv = window.visualViewport;
    if (!vv) return;
    vv.addEventListener("resize", fitViewport);
    vv.addEventListener("scroll", fitViewport);
    fitViewport();
  }

  // ===== 幅・高さの変更（つまみ） =====
  // CSS の変数は CSSOM（style.setProperty）で変える。style 属性は書かない（CSP の style-src 'self' でも動く）
  const SIZES = {
    sidebar: { prop: "--sidebar-w", def: 280, min: 180, max: 520 },
    panel: { prop: "--panel-h", def: 220, min: 96, max: 600 },
  };
  const sidebarSash = { axis: "x", size: SIZES.sidebar, sign: 1 };
  const panelSash = { axis: "y", size: SIZES.panel, sign: -1 };

  function currentSize(size) {
    const v = parseFloat(getComputedStyle(root).getPropertyValue(size.prop));
    return Number.isFinite(v) ? v : size.def;
  }

  function setSize(size, value) {
    const v = Math.round(Math.min(size.max, Math.max(size.min, value)));
    root.style.setProperty(size.prop, v + "px");
    save(size.prop, String(v));
    return v;
  }

  function makeSash(node, spec) {
    node.addEventListener("pointerdown", (e) => {
      e.preventDefault();
      if (node.setPointerCapture) node.setPointerCapture(e.pointerId);
      node.classList.add("is-dragging");
      const start = spec.axis === "x" ? e.clientX : e.clientY;
      const base = currentSize(spec.size);
      const move = (ev) => {
        const pos = spec.axis === "x" ? ev.clientX : ev.clientY;
        setSize(spec.size, base + spec.sign * (pos - start));
      };
      const up = () => {
        node.classList.remove("is-dragging");
        node.removeEventListener("pointermove", move);
        node.removeEventListener("pointerup", up);
        node.removeEventListener("pointercancel", up);
      };
      node.addEventListener("pointermove", move);
      node.addEventListener("pointerup", up);
      node.addEventListener("pointercancel", up);
    });
    node.addEventListener("dblclick", () => setSize(spec.size, spec.size.def));
    node.addEventListener("keydown", (e) => {
      const keys = spec.axis === "x" ? { dec: "ArrowLeft", inc: "ArrowRight" } : { dec: "ArrowDown", inc: "ArrowUp" };
      let delta = 0;
      if (e.key === keys.dec) delta = -16;
      else if (e.key === keys.inc) delta = 16;
      else if (e.key === "Home") {
        setSize(spec.size, spec.size.def);
        return;
      } else return;
      e.preventDefault();
      setSize(spec.size, currentSize(spec.size) + (spec.axis === "y" ? delta : delta * spec.sign));
    });
  }

  // ===== キーボード =====
  function onKey(e) {
    const mod = e.ctrlKey || e.metaKey;
    const k = String(e.key || "").toLowerCase();
    if (mod && e.shiftKey && k === "p") {
      e.preventDefault();
      palette(">");
    } else if (mod && !e.shiftKey && (k === "k" || k === "p")) {
      e.preventDefault();
      palette("");
    } else if (mod && !e.shiftKey && k === "b") {
      e.preventDefault();
      toggleSidebar();
    } else if (mod && !e.shiftKey && k === "j") {
      e.preventDefault();
      togglePanel();
    } else if (e.altKey && !mod && k === "w") {
      e.preventDefault();
      if (activeTabId()) closeTab(activeTabId());
    } else if (e.altKey && !mod && !e.shiftKey && /^[1-9]$/.test(e.key)) {
      const id = S.tabs[Number(e.key) - 1];
      if (id) {
        e.preventDefault();
        activate(id);
      }
    } else if (e.key === "Escape") {
      if (!$("palette-backdrop").hidden) closePalette();
      else if (S.moreOpen) closeMore();
      else if (S.drawerOpen) closeDrawer();
    }
  }

  // ===== 全体 =====
  function renderAll() {
    applyLayout();
    renderActivity();
    renderSidebar();
    renderEditors();
    if (S.panelOpen) renderPanel();
    renderStatus();
  }

  // /api/status を読むまで開けるか分からないタブ（会話ログ）は、戻すのを status を読んだ後まで待つ（active は前に出すもの）
  const deferred = { tabs: [], active: null };

  function reopenDeferred() {
    if (deferred.tabs.length === 0 || !SA.store.status) return;
    const { tabs, active } = deferred;
    deferred.tabs = [];
    deferred.active = null;
    for (const id of tabs) if (SA.views.info(id) && !S.tabs.includes(id)) S.tabs.push(id);
    if (active && S.tabs.includes(active)) activate(active);
    else {
      saveTabs();
      renderEditors();
    }
  }

  /** 前回のタブ（localStorage）を戻し、hash があればそのタブを開いて前に出す */
  function restoreTabs() {
    const waits = (id) => !SA.views.info(id) && SA.views.waitsForStatus(id);
    const saved = loadJson("tabs");
    if (saved && Array.isArray(saved.tabs)) {
      const ids = saved.tabs.filter((id) => typeof id === "string");
      S.tabs = [...new Set(ids.filter((id) => SA.views.info(id)))];
      deferred.tabs = [...new Set(ids.filter(waits))];
      S.active = typeof saved.active === "string" && S.tabs.includes(saved.active) ? saved.active : S.tabs[0] || null;
      if (typeof saved.active === "string" && deferred.tabs.includes(saved.active)) deferred.active = saved.active;
    }
    const fromHash = tabFromHash(location.hash);
    if (fromHash && SA.views.info(fromHash)) {
      if (!S.tabs.includes(fromHash)) S.tabs.push(fromHash);
      S.active = fromHash;
      deferred.active = null;
    } else if (fromHash && waits(fromHash)) {
      if (!deferred.tabs.includes(fromHash)) deferred.tabs.push(fromHash);
      deferred.active = fromHash;
    }
  }

  function init() {
    refs.wb = $("wb");
    refs.activity = $("activity");
    refs.sidebar = $("sidebar");
    refs.editors = $("editors");
    refs.panel = $("panel");
    refs.status = $("statusbar");
    refs.titleStatus = el("div", { class: "wb-title-status" });
    document.querySelector(".wb-title-actions").prepend(refs.titleStatus);
    refs.brandStatus = el("span", { class: "wb-brand-status" });
    document.querySelector(".wb-brand").after(refs.brandStatus);

    // 前回の幅・高さ・表示
    for (const size of Object.values(SIZES)) {
      const v = Number(load(size.prop, ""));
      if (v > 0) setSize(size, v);
    }
    S.theme = THEMES.includes(load("theme", "dark")) ? load("theme", "dark") : "dark";
    applyTheme();
    const drafts = loadJson("drafts");
    if (drafts && !Array.isArray(drafts)) {
      for (const [id, v] of Object.entries(drafts)) if (typeof v === "string" && v !== "") S.drafts[id] = v;
    }
    const panel = loadJson("panel");
    if (panel) {
      if (PANEL_TABS.some((t) => t.id === panel.tab)) S.panelTab = panel.tab;
      if (typeof panel.open === "boolean") S.panelOpen = panel.open && !narrow();
    }
    restoreTabs();
    // スマホでタブも hash も無い（戻すのを待つタブも無い）起動は、ようこそでなく会話の一覧から始める
    if (phone() && S.tabs.length === 0 && deferred.tabs.length === 0 && !tabFromHash(location.hash)) {
      S.activity = "chat";
      S.drawerOpen = true;
    }

    makeSash($("sash-sidebar"), sidebarSash);
    makeSash($("sash-panel"), panelSash);

    $("sidebar-toggle").addEventListener("click", toggleSidebar);
    $("panel-toggle").addEventListener("click", () => togglePanel());
    $("command-center").addEventListener("click", () => palette(""));
    $("theme-toggle").addEventListener("click", toggleTheme);
    $("drawer-backdrop").addEventListener("click", closeDrawer);
    $("more-backdrop").addEventListener("click", () => closeMore());
    // 開いている間は Tab / Shift+Tab を最初と最後の行で折り返す（aria-modal）
    $("more-sheet").addEventListener("keydown", (e) => {
      if (e.key !== "Tab") return;
      const rows = $("more-sheet").querySelectorAll(".sheet-close, .more-row:not([disabled])");
      if (rows.length === 0) return;
      const first = rows[0];
      const last = rows[rows.length - 1];
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    });
    document.addEventListener("keydown", onKey);
    window.addEventListener("hashchange", () => {
      const tabId = tabFromHash(location.hash);
      // 戻る（popstate）で今のタブの hash に書き直した後のものは何もしない
      if (tabId && tabId === S.active) return;
      // 知らない・空の hash は開かず、今のタブの hash に戻す
      if (tabId && SA.views.info(tabId)) open(tabId);
      else writeHash();
    });
    // スマホ: 一覧から開いた本文で戻ると一覧へ（closeDrawer が積んだ履歴）。hash は今のタブのものに書き直す
    window.addEventListener("popstate", () => {
      if (!phone()) return;
      if (!S.drawerOpen) {
        closeMore({ keepFocus: true });
        closePalette();
        showDrawer();
      }
      writeHash();
    });
    bindPalette();
    bindNewSession();
    bindCcStart();

    mqNarrow.addEventListener("change", () => {
      closeMore({ keepFocus: true });
      S.drawerOpen = false;
      if (narrow()) S.panelOpen = false;
      renderAll();
    });
    mqPhone.addEventListener("change", () => {
      closeMore({ keepFocus: true });
      renderActivity();
      fitViewport();
    });
    bindViewport();

    // 最初の描画では一覧（ドロワー）を動かさない（1 フレームだけ transition を止める）
    refs.wb.classList.add("no-transition");
    renderAll();
    requestAnimationFrame(() => requestAnimationFrame(() => refs.wb.classList.remove("no-transition")));
    writeHash();
    saveTabs();
    const info = S.active ? SA.views.info(S.active) : null;
    if (info && info.onOpen) info.onOpen();

    // 今日の日付（サーバーの SELF_AGENT_TZ）とトークンはステータスバーとサイドバーで使う
    SA.store.load.usageDays();
    if (S.active !== "usage") SA.store.load.usage(null);
    SA.poll.start();
  }

  SA.app = {
    open,
    refresh,
    refreshSidebar: renderSidebar,
    refreshActivity: renderActivity,
    refreshTabs: renderEditors,
    refreshTabMarks,
    refreshStatus,
    refreshNotices,
    addOutput,
    activeTabId,
    sidebarShows,
    openDrawer,
    closeDrawer,
    sheet: openSheet,
    noticeLine,
    toggleSidebar,
    togglePanel,
    palette,
    newSession,
    ccStart,
    theme: () => S.theme,
    setTheme,
    draft: (channelId) => S.drafts[channelId] || "",
    setDraft,
    pruneDrafts,
  };

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();
})();
