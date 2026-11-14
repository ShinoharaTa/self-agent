// 新しい殻（v3.html。docs/plan/web-ui-v3.md §2・§11 の M2）: 話題の一覧（列 1。topics.js）と開いた話題（列 2）、
// SA.app（今の殻 workbench.js と同じ名前の契約。chat.js・views.js・api.js・ui.js・sound.js が呼ぶ）・hash・スマホの一覧 ⇄ 会話・テーマ・書きかけ・シート・キーボードの高さ
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
  /** タブの中身を描く。スクロール位置は保つ */
  function renderEd(ed, tabId) {
    const oldScroll = ed.querySelector(".ed-scroll");
    const wasBottom = !oldScroll || oldScroll.scrollHeight - oldScroll.scrollTop - oldScroll.clientHeight < 48;
    const oldTop = oldScroll ? oldScroll.scrollTop : 0;
    const info = tabId ? SA.views.info(tabId) : null;
    if (!info) {
      ed.replaceChildren(el("div", { class: "v3-empty" }, [el("p", { class: "meta", text: "左の一覧から話題を選んでください" })]));
      return;
    }
    info.render(ed);
    const scroll = ed.querySelector(".ed-scroll");
    if (scroll) {
      if (scroll.dataset.stick === "bottom" && wasBottom) scroll.scrollTop = scroll.scrollHeight;
      else if (oldScroll) scroll.scrollTop = oldTop;
    }
  }

  /** 列 2 の上の帯（「場所」はただの文字。押せない。付け替えは M5） */
  function renderBar() {
    const bar = $("v3-bar");
    if (!bar) return;
    const t = S.active ? SA.topics.find(S.active) : null;
    if (!t) {
      bar.hidden = true;
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

  function renderMain() {
    renderBar();
    renderEd($("ed"), S.active);
    writeHash();
  }

  function activeTabId() {
    return S.active;
  }

  /** 話題か画面を列 2 に開く（知らない・無効な機能のタブは開かない） */
  function open(tabId) {
    if (!tabId) return;
    const info = SA.views.info(tabId);
    if (!info) return;
    if (S.active !== null && S.active !== tabId) {
      const prev = SA.views.info(S.active);
      if (prev && prev.onClose) prev.onClose();
    }
    S.active = tabId;
    deferred = null;
    renderMain();
    SA.topics.render();
    if (info.onOpen) info.onOpen();
    // 一覧（/api/channels）にまだ無いチャンネル（/api/topics で先に知った話題）は、見出しのために 1 回読む
    if (tabId.startsWith("ch:") && !SA.chat.channelById(tabId.slice(3))) SA.store.load.channels({ quiet: true });
    if (phone()) showBody();
  }

  /** tabId が列 2 に出ていれば中身だけ描き直す */
  function refresh(tabId) {
    if (S.active !== tabId) return;
    const ed = $("ed");
    if (ed) renderEd(ed, tabId);
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

  function reopenDeferred() {
    if (deferred === null || S.active !== null) {
      deferred = null;
      return;
    }
    if (SA.views.info(deferred)) {
      open(deferred);
      return;
    }
    if (SA.store.status !== null && topicsLoaded) deferred = null;
  }

  // ===== スマホの一覧 ⇄ 会話（履歴: 会話は v3Body の entry。戻ると一覧） =====
  function setView(view) {
    S.view = view;
    refs.v3.setAttribute("data-view", view);
  }

  function showBody() {
    setView("body");
    const hash = S.active ? hashOf(S.active) : location.pathname + location.search;
    try {
      if (history.state && history.state.v3Body) history.replaceState(history.state, "", hash);
      else history.pushState({ v3Body: true }, "", hash);
    } catch {
      // 積めなくても [‹] で一覧に戻れる
    }
  }

  /** 一覧に戻ったら、開いていた話題の行に焦点（一覧の位置は動かさない） */
  function focusCurrentRow() {
    if (!S.active) return;
    const row = refs.list.querySelector('button.v3-row[data-topic="' + CSS.escape(S.active) + '"]');
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
    dialog.replaceChildren(el("h2", { class: "dlg-title", text: label }), el("ul", { class: "more-list" }, rows));
    openDialog(dialog);
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
    if (e.key !== "Escape") return;
    if (document.querySelector("dialog[open]") || typing(document.activeElement)) return;
    if (phone() && S.view === "body") showList();
  }

  // ===== 起動 =====
  function init() {
    refs.v3 = $("v3");
    refs.list = $("v3-list-body");

    S.theme = THEMES.includes(load("theme", "dark")) ? load("theme", "dark") : "dark";
    applyTheme();
    const drafts = loadJson("drafts");
    if (drafts && !Array.isArray(drafts)) {
      for (const [id, v] of Object.entries(drafts)) if (typeof v === "string" && v !== "") S.drafts[id] = v;
    }

    bindViewport();
    mqPhone.addEventListener("change", () => {
      setView(S.active ? "body" : "list");
      fitViewport();
    });
    window.addEventListener("popstate", (e) => {
      if (e.state && e.state.v3Body && S.active) setView("body");
      else {
        setView("list");
        if (phone()) focusCurrentRow();
      }
    });
    document.addEventListener("keydown", onKey);
    $("v3-sheet").addEventListener("close", () => {
      const opener = sheetOpener;
      sheetOpener = null;
      if (opener && document.contains(opener)) opener.focus();
    });

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
    },
    refreshActivity: () => SA.topics.render(),
    refreshTabs: renderBar,
    // タブの見出しの実行中の印は無い
    refreshTabMarks: () => undefined,
    refreshStatus: () => {
      reopenDeferred();
    },
    // 接続の点と鈴は M2b
    refreshNotices: () => undefined,
    // 出力のパネルは持たない
    addOutput: () => undefined,
    activeTabId,
    sidebarShows,
    openDrawer,
    closeDrawer,
    sheet: openSheet,
    noticeLine,
    // サイドバー・パネルは無い
    toggleSidebar: () => undefined,
    togglePanel: () => undefined,
    // 絞り込み欄は M2b
    palette: () => undefined,
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
