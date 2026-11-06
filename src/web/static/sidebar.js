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
  // phone はスマホ（639px 以下）の置き場: primary は下タブ、more は「その他」のシート（docs/plan/web-ui-polish.md の NAV）。
  // phoneTab はスマホで一覧を開かずにタブ（表）を直接開くもの（UI-7）
  // Claude Code は会話の一覧の群（docs/plan/claude-code-channels.md §2）で、アクティビティには置かない。会話の数は未読 + 判断待ち
  const ACTIVITIES = [
    { id: "chat", label: "会話", phone: "primary", icon: "message-square", enabled: always, count: () => store.unreadCount() + store.ccNeedsInputCount(), countLabel: chatCountLabel, running: () => (store.running ? store.running.length : store.status ? store.status.running || 0 : 0) },
    { id: "tasks", label: "タスク", phone: "primary", phoneTab: true, icon: "square-check", enabled: always },
    { id: "reminders", label: "リマインド", phone: "primary", phoneTab: true, icon: "bell", enabled: always },
    { id: "knowledge", label: "ナレッジ・記憶", phone: "more", icon: "book", enabled: always },
    { id: "projects", label: "プロジェクト", phone: "more", icon: "folder", enabled: always },
    { id: "jobs", label: "ジョブ", phone: "more", icon: "briefcase", enabled: (status) => !!(status.jobs && status.jobs.enabled), stage: "w8" },
    { id: "github", label: "GitHub", phone: "more", icon: "git-pull-request", enabled: (status) => !!(status.github && status.github.enabled) },
    { id: "usage", label: "使用量", phone: "more", icon: "bar-chart", enabled: always },
    { id: "devlog", label: "会話ログ", phone: "more", icon: "file-text", enabled: (status) => !!status.devMode },
    { id: "status", label: "状態", phone: "more", icon: "activity", tab: "status", bottom: true, enabled: always },
    { id: "settings", label: "設定", phone: "more", icon: "settings", tab: "settings", bottom: true, enabled: always },
  ];

  /** 会話の数の語（未読だけ・判断待ちだけ・両方） */
  function chatCountLabel() {
    const unread = store.unreadCount() > 0;
    const needs = store.ccNeedsInputCount() > 0;
    return unread && needs ? "未読・判断待ち " : needs ? "判断待ち " : "未読 ";
  }

  /** 今出すアクティビティ。/api/status を読む前は enabled を見ずに段の印だけで決める */
  function visibleActivities() {
    const status = store.status;
    return ACTIVITIES.filter((a) => !a.stage && (status === null || a.enabled(status)));
  }

  /** スマホの下タブ（primary）と「その他」のシート（more）に分けた visibleActivities()。順は ACTIVITIES のまま */
  function phoneActivities() {
    const visible = visibleActivities();
    return { primary: visible.filter((a) => a.phone === "primary"), more: visible.filter((a) => a.phone !== "primary") };
  }

  // 完了は既定で閉じておく
  const ui = { query: "", groups: { done: false } };

  /** 一覧の 1 行。tabId を開く。opts.sub は 2 行目（スマホだけ出す。PC は title） */
  function row(opts) {
    const current = opts.current !== undefined ? opts.current : SA.app.activeTabId() === opts.tab;
    const btn = el("button", { class: "sb-row" + (opts.cls ? " " + opts.cls : ""), type: "button", "aria-current": current ? "true" : null, title: opts.title || null }, [
      // アイコンの無い行も 16px の空の箱でラベルの開始位置を揃える（GUIDELINES §4）
      opts.icon ? icon(opts.icon) : el("span", { class: "icon icon-blank", "aria-hidden": "true" }),
      opts.sub
        ? el("span", { class: "sb-text" }, [el("span", { class: "sb-label", text: opts.label }), el("span", { class: "sb-sub show-sm", text: opts.sub })])
        : el("span", { class: "sb-label", text: opts.label }),
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

  /** opts.count は見出しの数（既定は行の数）、opts.title は見出しの title、opts.before・opts.after は行の前・後に置く要素（群を閉じると隠れる） */
  function group(key, title, items, extras, emptyText, opts) {
    const o = opts || {};
    const details = el("details", { class: "sb-group", open: ui.groups[key] !== false }, [
      el("summary", { title: o.title || null }, [
        icon("chevron-right", "sb-chevron"),
        el("span", { text: title }),
        el("span", { class: "sb-count", text: String(o.count !== undefined ? o.count : items.length) }),
        ...(extras || []),
      ]),
      ...(o.before || []),
      items.length ? el("ul", { class: "sb-list" }, items) : el("p", { class: "sb-empty", text: emptyText || "ありません" }),
      ...(o.after || []),
    ]);
    details.addEventListener("toggle", () => {
      ui.groups[key] = details.open;
    });
    return details;
  }

  // ===== 会話（入口・Claude Code・進行中・待ち・完了） =====
  function channelRow(ch) {
    const persona = store.channels.personas.find((p) => p.id === ch.persona);
    const badges = [];
    if (ch.kind === "session" && persona && !persona.isDefault) badges.push(el("span", { class: "badge badge-persona", text: persona.name }));
    // プロジェクトのセッション（docs/plan/unify.md）はプロジェクトの名前
    if (ch.kind === "session" && ch.projectDir && typeof ch.projectDir.dir === "string") {
      badges.push(el("span", { class: "badge badge-project", title: "プロジェクトのセッション", text: ch.projectDir.dir }));
    }
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
      meta: ch.last ? SA.ui.shortTime(ch.last.at) : "",
    });
  }

  function chatList() {
    const q = ui.query.trim();
    const match = (ch) => q === "" || String(ch.kind === "session" ? ch.title : ch.name).includes(q);
    // Claude Code のチャンネル（kind cc）は群「Claude Code」の行から開く（CC14）
    const channels = store.channels.channels.filter((c) => c.kind !== "cc").filter(match);
    const by = (state) => channels.filter((c) => c.kind === "session" && c.state === state).map(channelRow);
    // Discord の /new と同じ（新しいセッションのダイアログ）
    const newBtn = el("button", { class: "btn btn-secondary btn-sm sb-new", type: "button" }, [icon("plus"), "新しいセッション"]);
    newBtn.addEventListener("click", () => {
      SA.app.closeDrawer();
      SA.app.newSession();
    });
    return [
      group("entrances", "入口", channels.filter((c) => c.kind !== "session").map(channelRow)),
      ...ccGroup(q),
      el("div", { class: "sb-new-row" }, [newBtn]),
      group("active", "進行中", by("active")),
      group("waiting", "待ち", by("waiting")),
      group("done", "完了", by("done"), [el("span", { class: "sb-note", text: "新しい 10 件" })]),
    ];
  }

  function renderChat(body) {
    watchCc();
    if (store.channels === null) {
      store.load.channels();
      body.replaceChildren(group("entrances", "入口", [], null, "読み込んでいます…"), ...ccGroup(""));
      return;
    }
    if (!store.channels.guilds.some((g) => g.setUp)) {
      // Claude Code の群は Discord の /setup によらず出す
      body.replaceChildren(el("p", { class: "sb-note-block", text: "会話はまだありません。Discord で /setup を実行すると、ここに出ます。" }), ...ccGroup(""));
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
    if (store.openTasks === null) {
      store.load.tasks();
      body.replaceChildren(group("open", "未完了", [], null, "読み込んでいます…"));
      return;
    }
    const items = store.openTasks.map((t) =>
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
      // 時刻は今日なら時刻だけ、それ以外は日付も
      row({ tab: "reminders", icon: r.rule ? "rotate-ccw" : "clock", label: SA.views.oneLine(r.text), meta: r.nextAt ? SA.ui.shortTime(r.nextAt) : "" }),
    );
    body.replaceChildren(group("rem", "動いているもの", items));
  }

  // ===== ナレッジ・記憶（ナレッジは新しい順か検索の結果。検索欄はナレッジのタブと同じ語） =====
  function renderKnowledge(body) {
    if (store.memories === null) store.load.memories();
    if (store.knowledge === null) store.load.knowledge();
    const open = SA.app.activeTabId() === "knowledge";
    const selected = SA.views.kbSelectedId();
    const kb =
      store.knowledge === null
        ? group("kb", "ナレッジ", [], null, "読み込んでいます…")
        : group(
            "kb",
            store.knowledge.q ? "検索の結果" : "ナレッジ",
            store.knowledge.entries.map((k) =>
              row({
                tab: "knowledge",
                label: k.title,
                meta: SA.ui.dateOf(k.updatedAt),
                title: "#" + k.id,
                current: open && k.id === selected,
                before: () => SA.views.selectKb(k.id),
              }),
            ),
            null,
            store.knowledge.q ? "見つかりませんでした" : "ありません",
          );
    const meta = store.memories === null ? "" : store.memories.length + " 件";
    // 検索欄は描き直しても同じ要素（打っている間のフォーカスは render が戻す）
    const input = SA.views.kbInput("sidebar");
    body.replaceChildren(el("div", { class: "sb-search" }, [input]), kb, group("mem", "記憶", [row({ tab: "memories", icon: "book", label: "記憶の一覧", meta })]));
  }

  // ===== GitHub（#github に出した通知） =====
  function renderGithub(body) {
    if (store.github === null) {
      store.load.github();
      body.replaceChildren(group("gh", "最近の通知", [], null, "読み込んでいます…"));
      return;
    }
    const items = store.github.notifications.map((n) => {
      const parts = SA.views.githubParts(n.url);
      return row({
        tab: "github",
        label: n.title || n.label,
        dot: n.level === "red" ? "dot-bad" : "dot-warn",
        dotLabel: n.level === "red" ? "自分宛て" : "新しい Issue / PR",
        meta: SA.ui.shortTime(n.updatedAt),
        title: parts ? parts.repo + " #" + parts.number : n.label,
      });
    });
    body.replaceChildren(group("gh", "最近の通知", items));
  }

  // ===== Claude Code（会話の一覧の群。この機械のセッション。並びはサーバーの rankSessions: 判断待ち → 実行中 → 最近の指示） =====
  /** 一覧をこの時間より前に読んだものなら、会話の一覧を出したときに読み直す */
  const CC_FRESH_MS = 10000;

  function ccRow(s) {
    // 行のバッジは最重要の 1 つだけ（許可待ち・質問 > 届け待ち > trust の確認待ち > tmux の外。GUIDELINES §5 バッジ）。残りは title とタブに
    const asking = s.permission && s.permission.state === "pending";
    // 質問（AskUserQuestion。Q3）は「許可待ち」と区別して「質問」
    const questions = asking && s.permission.question && Array.isArray(s.permission.question.questions) && s.permission.question.questions.length > 0 ? s.permission.question.questions : null;
    const delivering = !!(s.pending && (s.pending.state === "queued" || s.pending.state === "delivering"));
    const top = asking ? (questions ? "質問" : "許可待ち") : delivering ? "届け待ち" : s.trustPending ? "trust の確認待ち" : !s.inTmux ? "tmux の外" : null;
    const badges = [];
    // スマホ（≤639px）は文字のバッジを出さず点の色だけ（文字はタブの見出しと中身に）。同じ色の点が既にあれば足さない
    if (top) badges.push(el("span", { class: "badge hide-sm " + (asking ? "badge-accent" : "badge-cc"), text: top }));
    const topDot = asking ? "dot-warn" : delivering ? "dot-unread" : s.trustPending ? "dot-warn" : null;
    if (s.state === "running") badges.push(el("span", { class: "spinner", role: "img", "aria-label": "実行中" }));
    // title: 場所、許可の要求の中身、出さなかった印（権限モード・判断待ちの理由・起動した人・ほかの状態）
    const notes = [];
    if (s.cwdLabel) notes.push(s.cwdLabel);
    if (questions) notes.push("質問: " + SA.views.oneLine(String(questions[0].question || "")));
    else if (asking) notes.push(s.permission.toolName + ": " + SA.views.oneLine(String(s.permission.summary || "")));
    if (s.permissionMode) notes.push("権限モード: " + s.permissionMode);
    // 判断待ちの理由（permission prompt など。一覧の waitingFor）
    if (s.state === "needs_input" && s.waitingFor) notes.push("判断待ち: " + s.waitingFor);
    if (s.startedBy && s.startedBy !== "owner") notes.push("self-agent が起動");
    for (const [on, text] of [
      [delivering, "届け待ち"],
      [s.trustPending, "trust の確認待ち"],
      [!s.inTmux, "tmux の外"],
    ]) {
      if (on && text !== top) notes.push(text);
    }
    // Discord のチャンネル（Claude Code のチャンネル）があるものは # で、会話のタブ（ch:<id>。CC14）を開く。未読の点は会話と同じ（history の最後の行）。
    // 無いものは今の Claude Code のタブ
    const channelId = s.channel && typeof s.channel.channelId === "string" && s.channel.state !== "deleted" ? s.channel.channelId : null;
    const channel = channelId && store.channels ? store.channels.channels.find((c) => c.id === channelId) || null : null;
    const unread = !!channel && store.isUnread(channel);
    const dot = s.state === "needs_input" ? "dot-warn" : unread ? "dot-unread" : null;
    return row({
      tab: channelId ? "ch:" + channelId : "cc:" + s.sessionId,
      icon: channelId ? "hash" : null,
      label: SA.views.ccName(s),
      sub: s.cwdLabel || null,
      badges: topDot && topDot !== dot ? [...badges, el("span", { class: "dot show-sm " + topDot, role: "img", "aria-label": top })] : badges,
      dot,
      dotLabel: s.state === "needs_input" ? "判断待ち" : unread ? "未読" : null,
      meta: s.since ? SA.views.ago(s.since) : "",
      title: notes.length ? notes.join("\n") : null,
    });
  }

  /** 起動したがまだ一覧に出ていないもの（sessionId が無いのでタブは開かない）。trust の確認待ちなら答え方を添える */
  function ccStartingRow(s) {
    const badges = [];
    if (s.trustPending) badges.push(el("span", { class: "badge badge-accent", text: "trust の確認待ち" }));
    return el("li", {}, [
      el("div", { class: "sb-row sb-row-static", title: s.project || null }, [
        el("span", { class: "sb-label", text: s.title }),
        ...badges,
        s.startedAt ? el("span", { class: "sb-meta", text: SA.views.ago(s.startedAt) }) : null,
      ]),
      s.trustPending ? el("p", { class: "sb-hint", text: "端末か RC で trust に答えてください" }) : null,
    ]);
  }

  /** 会話の一覧を出している間: polling を始め直し、止まっていた間に古くなっていれば読み直す（読めなくても ccAt は進む）。出していなければ読まない */
  function watchCc() {
    if (!store.ccEnabled() || !SA.app.sidebarShows("chat")) return;
    SA.poll.kickCc();
    if (store.ccAt === 0 || Date.now() - store.ccAt > CC_FRESH_MS) store.load.cc(store.cc === null ? undefined : { quiet: true });
  }

  /** 群「Claude Code」（Claude Code の連携が無効なら出さない）。q は絞り込みの語（名前・場所・題名に効く） */
  function ccGroup(q) {
    if (!store.ccEnabled()) return [];
    if (store.cc === null) return [group("cc", "Claude Code", [], null, store.ccFailed ? "一覧を読めませんでした" : "読み込んでいます…")];
    const match = (...texts) => q === "" || texts.some((t) => typeof t === "string" && t.includes(q));
    const sessions = store.cc.sessions.filter((s) => match(SA.views.ccName(s), s.cwdLabel));
    // 起動中（trust の確認待ちの claude は一覧に出ないので、起動したがまだ一覧に無いもの）を先頭に
    const starting = store.cc.starting.filter((s) => match(s.title, s.project));
    const items = [...starting.map(ccStartingRow), ...sessions.map(ccRow)];
    // 見出しの数は判断待ちの数（0 なら全体の数）
    const needs = sessions.filter((s) => s.state === "needs_input").length;
    const note = store.cc.unreadable ? "一覧を読めませんでした。" : store.cc.stale ? "一覧を読めませんでした。前に読めた一覧です。" : null;
    // 一覧を最後に読めた時刻（サーバーの読み取り）は見出しの title に
    const fetched = store.cc.fetchedAt ? "一覧は " + SA.views.secondsAgo(store.cc.fetchedAt) + "のもの" + (store.ccFailed ? "（今は読めません）" : "") : null;
    // この機械の tmux に新しいセッションを起動する（起動のダイアログ）。会話の「新しいセッション」と同じ形で群の外に置き、語を分ける（GUIDELINES §7）
    const startBtn = el("button", { class: "btn btn-secondary btn-sm sb-new", type: "button" }, [icon("plus"), "Claude Code を起動"]);
    startBtn.addEventListener("click", () => {
      SA.app.closeDrawer();
      SA.app.ccStart();
    });
    return [
      group("cc", "Claude Code", items, null, null, {
        count: needs > 0 ? needs : items.length,
        title: fetched,
        before: note ? [el("p", { class: "sb-hint", text: note })] : [],
      }),
      el("div", { class: "sb-new-row" }, [startBtn]),
    ];
  }

  // ===== プロジェクト（W7。配信が無効でも出す） =====
  function renderProjects(body) {
    if (store.projects === null) {
      store.load.projects();
      body.replaceChildren(group("proj", "プロジェクト", [], null, "読み込んでいます…"));
      return;
    }
    const items = store.projects.map((p) =>
      row({ tab: "project:" + p.slug, icon: "folder", label: p.slug, meta: SA.ui.shortTime(p.updatedAt), title: p.channelTitle || p.title }),
    );
    body.replaceChildren(
      group("proj", "プロジェクト", items),
      el("p", { class: "sb-note-block", text: "プロジェクトは会話でページを作ると増えます。" }),
    );
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
    github: renderGithub,
    projects: renderProjects,
    usage: renderUsage,
    devlog: renderDevlog,
  };

  // サイドバーの見出しの右の操作
  function headerActions(id) {
    if (id === "tasks") return [openAll("tasks", "一覧を開く")];
    if (id === "reminders") return [openAll("reminders", "一覧を開く")];
    if (id === "usage") return [openAll("usage", "開く")];
    if (id === "devlog") return [openAll("devlog", "開く")];
    if (id === "github") return [openAll("github", "開く")];
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
    // 描き直しても同じ要素を使うもの（ナレッジの検索欄）にフォーカスがあれば、描き直した後に戻す。
    // 作り直す入力欄（会話の絞り込み）は同じ aria-label の新しい欄に焦点と選択範囲を戻す
    const focused = document.activeElement;
    const rebuilt =
      focused && focused.tagName === "INPUT" && container.contains(focused) && focused.getAttribute("aria-label")
        ? { label: focused.getAttribute("aria-label"), start: focused.selectionStart, end: focused.selectionEnd }
        : null;
    const body = el("div", { class: "sb-body" });
    RENDER[id](body);
    container.replaceChildren(
      el("div", { class: "sb-header" }, [el("h2", { class: "sb-title", text: act.label }), el("span", { class: "sb-spacer" }), ...headerActions(id)]),
      body,
    );
    if (focused && focused !== document.activeElement && container.contains(focused)) focused.focus();
    else if (rebuilt) {
      const input = [...container.querySelectorAll("input")].find((n) => n.getAttribute("aria-label") === rebuilt.label);
      if (input) {
        input.focus();
        try {
          input.setSelectionRange(rebuilt.start, rebuilt.end);
        } catch {
          // 選択範囲を持たない種類の欄なら焦点だけ
        }
      }
    }
  }

  SA.sidebar = { ACTIVITIES, visibleActivities, phoneActivities, render };
})();
