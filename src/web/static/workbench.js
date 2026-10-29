// アプリの殻（VS Code の構成）: アクティビティバー・サイドバー・エディタのタブ・パネル・ステータスバー・コマンドパレット・キーボード・hash のルータ・新しいセッションのダイアログ
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

  // ===== テーマ =====
  function applyTheme() {
    if (S.theme === "system") delete root.dataset.theme;
    else root.dataset.theme = S.theme;
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

  function renderActivity() {
    ensureActivity();
    const top = el("div", { class: "act-group" });
    const bottom = el("div", { class: "act-group act-bottom" });
    for (const a of SA.sidebar.visibleActivities()) {
      const pressed = !a.tab && S.activity === a.id && (narrow() ? S.drawerOpen : !S.sidebarHidden);
      // 数（会話は未読のチャンネルの数）
      const n = a.count ? a.count() : 0;
      const label = a.label + (n > 0 ? "（" + (a.countLabel || "") + n + "）" : "");
      const btn = el(
        "button",
        {
          class: "act-btn",
          type: "button",
          "aria-label": label,
          title: label,
          "aria-pressed": a.tab ? null : String(pressed),
        },
        [icon(a.icon), el("span", { class: "act-label", text: a.label }), n > 0 ? el("span", { class: "act-count", text: String(n), "aria-hidden": "true" }) : null],
      );
      btn.addEventListener("click", () => selectActivity(a));
      (a.bottom ? bottom : top).append(btn);
    }
    refs.activity.replaceChildren(top, bottom);
  }

  function selectActivity(a) {
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

  function openDrawer() {
    S.drawerOpen = true;
    applyLayout();
    renderActivity();
    renderSidebar();
    const first = refs.sidebar.querySelector("input, button");
    if (first) first.focus();
  }

  function closeDrawer() {
    if (!S.drawerOpen) return;
    S.drawerOpen = false;
    applyLayout();
    renderActivity();
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

  // ===== hash のルータ（#/status・#/ch/<id> など。サーバーには届かない） =====
  const PREFIXED = ["ch", "project", "job"];

  function tabFromHash(hash) {
    const path = String(hash || "").replace(/^#\/?/, "");
    if (path === "") return null;
    const slash = path.indexOf("/");
    if (slash > 0 && PREFIXED.includes(path.slice(0, slash))) return path.slice(0, slash) + ":" + path.slice(slash + 1);
    return path;
  }

  function writeHash() {
    try {
      if (S.active) history.replaceState(null, "", "#/" + S.active.replace(":", "/"));
      else history.replaceState(null, "", location.pathname + location.search);
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
      if (S.output.length === 0) body.append(el("p", { class: "meta panel-note", text: "実行中のターンの手順と終わり方がここに出ます（この画面を開いている間だけ）。" }));
    } else if (S.panelTab === "notices") {
      const data = SA.store.notices;
      if (data === null) body.append(el("p", { class: "meta panel-note", text: "読み込んでいます…" }));
      else {
        if (data.notices.length > 0) body.append(el("ul", { class: "notice-list" }, data.notices.map(noticeLine)));
        body.append(el("p", { class: "meta panel-note", text: data.notices.length > 0 ? "#system に出した知らせと同じものです。" : "#system に出した知らせがここに出ます。" }));
      }
    } else {
      body.append(el("p", { class: "meta panel-note", text: "まだありません" }));
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
    const sessionOnly = (fn) => (ch && ch.kind === "session" ? fn : null);
    return [
      { label: "/new 新しいセッション", detail: "題名と人格を決めて作ります", run: newSession },
      { label: "/close 今のセッションを閉じる", detail: "要約してから完了に移します", run: sessionOnly(() => SA.chat.closeSession(ch.id)) },
      { label: "/wait 今のセッションを待ちにする", detail: "発言すると進行中に戻ります", run: sessionOnly(() => SA.chat.setWaiting(ch.id)) },
      { label: "/renew 会話を新しくする", detail: "要約して新しい会話に引き継ぎます", run: ch ? () => SA.chat.renew(ch.id) : null },
      { label: "/tasks タスクを開く", detail: "", run: () => open("tasks") },
      { label: "/reminders リマインドを開く", detail: "", run: () => open("reminders") },
      { label: "/usage 使用量を開く", detail: "", run: () => open("usage") },
      { label: "状態を開く", detail: "", run: () => open("status") },
      { label: "設定を開く", detail: "", run: () => open("settings") },
      { label: "表示: サイドバーの切り替え", keys: "Ctrl+B", run: toggleSidebar },
      { label: "表示: パネルの切り替え", keys: "Ctrl+J", run: () => togglePanel() },
      { label: "表示: タブを閉じる", keys: "Alt+W", run: active ? () => closeTab(active) : null },
      { label: "表示: テーマを切り替える", detail: "ダーク / ライト", run: toggleTheme },
    ];
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
    P.items = source.filter((it) => q === "" || (it.label + " " + (it.detail || "")).toLowerCase().includes(q));
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
          it.icon ? icon(it.icon) : icon("chevron-right"),
          el("span", { class: "palette-label", text: it.label }),
          el("span", { class: "palette-detail", text: it.run ? it.detail || "" : "今は使えません" }),
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
  /** 作れなかったときのトースト（応答の error ごと）。無ければ「<status>: <error>」 */
  const NEW_ERRORS = {
    not_set_up: "/setup を実行してください",
    bot_disconnected: "Bot が接続していません",
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
      toast("/setup を実行してください");
      return;
    }
    $("new-guild").replaceChildren(...guilds.map((g) => el("option", { value: g.id, text: g.id })));
    $("new-guild-field").hidden = guilds.length < 2;
    const personas = channels.personas;
    $("new-persona").replaceChildren(...personas.map((p) => el("option", { value: p.id, text: p.name + (p.isDefault ? "（既定）" : "") })));
    $("new-persona-field").hidden = personas.length < 2;
    $("new-title").value = "";
    $("new-error").hidden = true;
    openDialog($("dlg-new"));
    $("new-title").focus();
  }

  function bindNewSession() {
    const dialog = $("dlg-new");
    $("dlg-new-cancel").addEventListener("click", () => closeDialog(dialog));
    $("new-form").addEventListener("submit", async (e) => {
      e.preventDefault();
      if (creating) return;
      const title = $("new-title").value.trim();
      if (title === "") {
        $("new-error").hidden = false;
        $("new-title").focus();
        return;
      }
      const body = { guildId: $("new-guild").value, title };
      if (!$("new-persona-field").hidden) body.persona = $("new-persona").value;
      creating = true;
      $("dlg-new-ok").disabled = true;
      try {
        const data = await SA.api.post("/api/sessions", body, { quiet: true });
        closeDialog(dialog);
        toast("セッション「" + title + "」を作りました（Discord にもチャンネルができました）");
        if (data && typeof data.channelId === "string") {
          S.activity = "chat";
          open("ch:" + data.channelId);
        }
        SA.store.load.channels();
      } catch (err) {
        if (err && err.code === "empty_title") {
          $("new-error").hidden = false;
          $("new-title").focus();
        } else if (err && err.toast) toast((err.code && NEW_ERRORS[err.code]) || err.toast);
      } finally {
        creating = false;
        $("dlg-new-ok").disabled = false;
      }
    });
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

    makeSash($("sash-sidebar"), sidebarSash);
    makeSash($("sash-panel"), panelSash);

    $("sidebar-toggle").addEventListener("click", toggleSidebar);
    $("panel-toggle").addEventListener("click", () => togglePanel());
    $("command-center").addEventListener("click", () => palette(""));
    $("theme-toggle").addEventListener("click", toggleTheme);
    $("drawer-backdrop").addEventListener("click", closeDrawer);
    document.addEventListener("keydown", onKey);
    window.addEventListener("hashchange", () => {
      const tabId = tabFromHash(location.hash);
      // 知らない・空の hash は開かず、今のタブの hash に戻す
      if (tabId && SA.views.info(tabId)) open(tabId);
      else writeHash();
    });
    bindPalette();
    bindNewSession();

    mqNarrow.addEventListener("change", () => {
      S.drawerOpen = false;
      if (narrow()) S.panelOpen = false;
      renderAll();
    });

    renderAll();
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
    refreshTabs: renderEditors,
    refreshTabMarks,
    refreshStatus,
    refreshNotices,
    addOutput,
    activeTabId,
    closeDrawer,
    toggleSidebar,
    togglePanel,
    palette,
    newSession,
    theme: () => S.theme,
    setTheme,
    draft: (channelId) => S.drafts[channelId] || "",
    setDraft,
    pruneDrafts,
  };

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();
})();
