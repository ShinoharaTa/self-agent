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
    { id: "chat", label: "会話", icon: "message-square", enabled: always, count: () => store.unreadCount(), countLabel: "未読 " },
    { id: "tasks", label: "タスク", icon: "square-check", enabled: always },
    { id: "reminders", label: "リマインド", icon: "bell", enabled: always },
    { id: "knowledge", label: "ナレッジ・記憶", icon: "book", enabled: always },
    { id: "projects", label: "プロジェクト", icon: "folder", enabled: always, stage: "w7" },
    { id: "jobs", label: "ジョブ", icon: "briefcase", enabled: (status) => !!(status.jobs && status.jobs.enabled), stage: "w8" },
    { id: "github", label: "GitHub", icon: "git-pull-request", enabled: (status) => !!(status.github && status.github.enabled), stage: "w6" },
    { id: "usage", label: "使用量", icon: "bar-chart", enabled: always },
    { id: "devlog", label: "会話ログ", icon: "file-text", enabled: (status) => !!status.devMode },
    { id: "status", label: "状態", icon: "activity", tab: "status", bottom: true, enabled: always },
    { id: "settings", label: "設定", icon: "settings", tab: "settings", bottom: true, enabled: always },
  ];

  /** 今出すアクティビティ。/api/status を読む前は enabled を見ずに段の印だけで決める */
  function visibleActivities() {
    const status = store.status;
    return ACTIVITIES.filter((a) => !a.stage && (status === null || a.enabled(status)));
  }

  // 完了は既定で閉じておく
  const ui = { query: "", groups: { done: false } };

  /** 一覧の 1 行。tabId を開く */
  function row(opts) {
    const current = opts.current !== undefined ? opts.current : SA.app.activeTabId() === opts.tab;
    const btn = el("button", { class: "sb-row" + (opts.cls ? " " + opts.cls : ""), type: "button", "aria-current": current ? "true" : null, title: opts.title || null }, [
      opts.icon ? icon(opts.icon) : null,
      el("span", { class: "sb-label", text: opts.label }),
      ...(opts.badges || []),
      opts.dot ? el("span", { class: "dot " + opts.dot, role: opts.dotLabel ? "img" : null, "aria-label": opts.dotLabel || null }) : null,
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

  // ===== 会話（入口・進行中・待ち・完了） =====
  function channelRow(ch) {
    const persona = store.channels.personas.find((p) => p.id === ch.persona);
    const badges = [];
    if (ch.kind === "session" && persona && !persona.isDefault) badges.push(el("span", { class: "badge badge-persona", text: persona.name }));
    // 実行中のターンがあればスピナー（その間は未読の点を出さない）
    const running = !!store.runningOf(ch.id);
    if (running) badges.push(el("span", { class: "spinner", role: "img", "aria-label": "実行中" }));
    const unread = !running && store.isUnread(ch);
    return row({
      tab: "ch:" + ch.id,
      icon: ch.kind === "session" ? null : "hash",
      label: ch.kind === "session" ? ch.title : ch.name,
      badges,
      dot: unread ? "dot-unread" : null,
      dotLabel: unread ? "未読" : null,
      meta: ch.last ? SA.chat.shortTime(ch.last.at) : "",
    });
  }

  function chatList() {
    const q = ui.query.trim();
    const match = (ch) => q === "" || String(ch.kind === "session" ? ch.title : ch.name).includes(q);
    const channels = store.channels.channels.filter(match);
    const by = (state) => channels.filter((c) => c.kind === "session" && c.state === state).map(channelRow);
    return [
      group("entrances", "入口", channels.filter((c) => c.kind !== "session").map(channelRow)),
      group("active", "進行中", by("active")),
      group("waiting", "待ち", by("waiting")),
      group("done", "完了", by("done"), [el("span", { class: "sb-note", text: "新しい 10 件" })]),
    ];
  }

  function renderChat(body) {
    if (store.channels === null) {
      store.load.channels();
      body.replaceChildren(group("entrances", "入口", [], null, "読み込んでいます…"));
      return;
    }
    if (!store.channels.guilds.some((g) => g.setUp)) {
      body.replaceChildren(el("p", { class: "sb-note-block", text: "/setup を実行したサーバーの会話がここに出ます。" }));
      return;
    }
    const listBox = el("div", { class: "sb-stack" }, chatList());
    const search = el("input", { class: "input input-sm", type: "search", placeholder: "セッションを絞り込む", "aria-label": "セッションを絞り込む", value: ui.query });
    search.addEventListener("input", () => {
      ui.query = search.value;
      listBox.replaceChildren(...chatList());
    });
    body.replaceChildren(el("div", { class: "sb-search" }, [search]), listBox);
  }

  // ===== タスク・リマインド =====
  function renderTasks(body) {
    if (store.tasks === null) {
      store.load.tasks();
      body.replaceChildren(group("open", "未完了", [], null, "読み込んでいます…"));
      return;
    }
    const items = store.tasks.open.map((t) =>
      row({ tab: "tasks", label: t.title, meta: t.due ? SA.views.dayLabel(t.due) : "", cls: SA.views.overdue(t) ? "is-overdue" : null, title: "#" + t.id }),
    );
    body.replaceChildren(group("open", "未完了", items));
  }

  function renderReminders(body) {
    if (store.reminders === null) {
      store.load.reminders();
      body.replaceChildren(group("rem", "動いているもの", [], null, "読み込んでいます…"));
      return;
    }
    const items = store.reminders.map((r) =>
      row({ tab: "reminders", icon: r.rule ? "rotate-ccw" : "clock", label: r.text, meta: r.nextAt ? SA.ui.hm(new Date(r.nextAt)) : "" }),
    );
    body.replaceChildren(group("rem", "動いているもの", items));
  }

  // ===== ナレッジ・記憶（ナレッジは W6。今は記憶の行だけ） =====
  function renderKnowledge(body) {
    if (store.memories === null) store.load.memories();
    const meta = store.memories === null ? "" : store.memories.length + " 件";
    body.replaceChildren(group("mem", "記憶", [row({ tab: "memories", icon: "book", label: "記憶の一覧", meta })]));
  }

  // ===== 会話ログ（日付の一覧） =====
  function renderDevlog(body) {
    if (store.devlogDays === null) {
      store.load.devlogDays();
      body.replaceChildren(group("devlog", "日付", [], null, "読み込んでいます…"));
      return;
    }
    const open = SA.app.activeTabId() === "devlog";
    // 今日（サーバーの SELF_AGENT_TZ）。会話ログをまだ読んでいなければ使用量の今日
    const today = store.devlogToday || store.today;
    const selected = SA.views.devlogDate() || today;
    const items = store.devlogDays.map((d) =>
      row({
        tab: "devlog",
        icon: "calendar",
        label: (d.date === today ? "今日 " : "") + SA.views.dayLabel(d.date),
        meta: d.count + " ターン",
        current: open && d.date === selected,
        before: () => SA.views.selectDevlogDate(d.date === today ? null : d.date),
      }),
    );
    body.replaceChildren(group("devlog", "日付", items, null, "記録はありません"));
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
    chat: renderChat,
    tasks: renderTasks,
    reminders: renderReminders,
    knowledge: renderKnowledge,
    usage: renderUsage,
    devlog: renderDevlog,
  };

  // サイドバーの見出しの右の操作
  function headerActions(id) {
    if (id === "tasks") return [openAll("tasks", "一覧を開く")];
    if (id === "reminders") return [openAll("reminders", "一覧を開く")];
    if (id === "usage") return [openAll("usage", "開く")];
    if (id === "devlog") return [openAll("devlog", "開く")];
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
