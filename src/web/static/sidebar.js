// アクティビティバーの項目と、選んだアクティビティのサイドバー（一覧）
"use strict";

(function () {
  const SA = (window.SA = window.SA || {});
  const { el, icon } = SA.ui;
  const store = SA.store;

  const always = () => true;

  // tab があるものはサイドバーを開かずにそのタブを開く（状態・設定）。
  // enabled(status) が false の機能（dev モードでない会話ログ・GitHub 無効・ジョブ無効）は出さない。
  // stage の付いたものはその段で中身を足すまで出さない（足した段で stage を外す）
  const ACTIVITIES = [
    { id: "chat", label: "会話", icon: "message-square", enabled: always, stage: "w2" },
    { id: "tasks", label: "タスク", icon: "square-check", enabled: always, stage: "w4" },
    { id: "reminders", label: "リマインド", icon: "bell", enabled: always, stage: "w4" },
    { id: "knowledge", label: "ナレッジ・記憶", icon: "book", enabled: always, stage: "w6" },
    { id: "projects", label: "プロジェクト", icon: "folder", enabled: always, stage: "w7" },
    { id: "jobs", label: "ジョブ", icon: "briefcase", enabled: (status) => !!(status.jobs && status.jobs.enabled), stage: "w8" },
    { id: "github", label: "GitHub", icon: "git-pull-request", enabled: (status) => !!(status.github && status.github.enabled), stage: "w6" },
    { id: "usage", label: "使用量", icon: "bar-chart", enabled: always },
    { id: "devlog", label: "会話ログ", icon: "file-text", enabled: (status) => !!status.devMode, stage: "w2" },
    { id: "status", label: "状態", icon: "activity", tab: "status", bottom: true, enabled: always },
    { id: "settings", label: "設定", icon: "settings", tab: "settings", bottom: true, enabled: always },
  ];

  /** 今出すアクティビティ。/api/status を読む前は enabled を見ずに段の印だけで決める */
  function visibleActivities() {
    const status = store.status;
    return ACTIVITIES.filter((a) => !a.stage && (status === null || a.enabled(status)));
  }

  const ui = { groups: {} };

  /** 一覧の 1 行。tabId を開く */
  function row(opts) {
    const current = opts.current !== undefined ? opts.current : SA.app.activeTabId() === opts.tab;
    const btn = el("button", { class: "sb-row" + (opts.cls ? " " + opts.cls : ""), type: "button", "aria-current": current ? "true" : null, title: opts.title || null }, [
      opts.icon ? icon(opts.icon) : null,
      el("span", { class: "sb-label", text: opts.label }),
      ...(opts.badges || []),
      opts.meta ? el("span", { class: "sb-meta", text: opts.meta }) : null,
    ]);
    btn.addEventListener("click", () => {
      if (opts.before) opts.before();
      SA.app.open(opts.tab);
      SA.app.closeDrawer();
    });
    return el("li", {}, [btn]);
  }

  function group(key, title, items, extras, emptyText) {
    const details = el("details", { class: "sb-group", open: ui.groups[key] !== false }, [
      el("summary", {}, [icon("chevron-right", "sb-chevron"), el("span", { text: title }), el("span", { class: "sb-count", text: String(items.length) }), ...(extras || [])]),
      items.length ? el("ul", { class: "sb-list" }, items) : el("p", { class: "sb-empty", text: emptyText || "ありません" }),
    ]);
    details.addEventListener("toggle", () => {
      ui.groups[key] = details.open;
    });
    return details;
  }

  // ===== 使用量（日付の一覧） =====
  function renderUsage(body) {
    if (store.usageDays === null) {
      store.load.usageDays();
      body.replaceChildren(group("usage", "日付", [], null, "読み込んでいます…"));
      return;
    }
    const usageOpen = SA.app.activeTabId() === "usage";
    const selected = SA.views.usageDate() || store.today;
    const days = [...store.usageDays].sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
    const items = days.map((d) =>
      row({
        tab: "usage",
        icon: "calendar",
        label: (d.date === store.today ? "今日 " : "") + SA.views.dayLabel(d.date),
        meta: SA.views.compact(d.inputTokens),
        title: "ターン " + d.turns,
        current: usageOpen && d.date === selected,
        before: () => SA.views.selectUsageDate(d.date === store.today ? null : d.date),
      }),
    );
    body.replaceChildren(group("usage", "日付", items));
  }

  const RENDER = {
    usage: renderUsage,
  };

  // サイドバーの見出しの右の操作
  function headerActions(id) {
    if (id === "usage") return [openAll("usage", "開く")];
    return [];
  }

  function openAll(tab, label) {
    const b = el("button", { class: "btn btn-ghost btn-sm", type: "button", text: label });
    b.addEventListener("click", () => {
      SA.app.open(tab);
      SA.app.closeDrawer();
    });
    return b;
  }

  function render(container, id) {
    const act = ACTIVITIES.find((a) => a.id === id);
    if (!act || !RENDER[id]) {
      container.replaceChildren();
      return;
    }
    const body = el("div", { class: "sb-body" });
    RENDER[id](body);
    container.replaceChildren(
      el("div", { class: "sb-header" }, [el("h2", { class: "sb-title", text: act.label }), el("span", { class: "sb-spacer" }), ...headerActions(id)]),
      body,
    );
  }

  SA.sidebar = { ACTIVITIES, visibleActivities, render };
})();
