// タブの中身: 状態・使用量・設定・ようこそ（W1）・会話ログ（W2。会話のタブは chat.js）・タスク・リマインド・記憶（W4）・GitHub・ナレッジ（W6）。
// プロジェクト・ジョブは後の段で足す
"use strict";

(function () {
  const SA = (window.SA = window.SA || {});
  const { el, icon, count, toast, confirm } = SA.ui;
  const store = SA.store;

  const WEEKDAYS = ["日", "月", "火", "水", "木", "金", "土"];

  function toolbar(iconName, title, extras, actions) {
    return el("header", { class: "ed-toolbar" }, [
      el("div", { class: "ed-title" }, [icon(iconName), el("h1", { text: title }), ...(extras || [])]),
      el("div", { class: "ed-actions" }, actions || []),
    ]);
  }

  function scroll(children, cls) {
    return el("div", { class: "ed-scroll" + (cls ? " " + cls : "") }, [el("div", { class: "ed-page" }, children)]);
  }

  function section(title, children, extras) {
    return el("section", { class: "ed-section" }, [el("div", { class: "ed-section-head" }, [el("h2", { text: title }), ...(extras || [])]), ...children]);
  }

  function table(headers, rows, cls) {
    return el("div", { class: "table-wrap" }, [
      el("table", { class: "table" + (cls ? " " + cls : "") }, [
        el("thead", {}, [el("tr", {}, headers.map((h) => el("th", { scope: "col", class: h.cls || null, text: typeof h === "string" ? h : h.text })))]),
        el("tbody", {}, rows),
      ]),
    ]);
  }

  function td(content, cls) {
    return el("td", { class: cls || null }, Array.isArray(content) ? content : [content]);
  }

  function empty(iconName, text) {
    return el("div", { class: "empty" }, [iconName ? icon(iconName) : null, el("p", { text })]);
  }

  // ===== 数と日付の表示 =====
  /** 1.47M・12.3k のような短い数 */
  function compact(value) {
    if (typeof value !== "number" || !Number.isFinite(value)) return "-";
    if (value >= 1000000) return (value / 1000000).toFixed(2) + "M";
    if (value >= 1000) return (value / 1000).toFixed(1) + "k";
    return String(value);
  }

  /** YYYY-MM-DD → 10/29(木)。形が違えばそのまま */
  function dayLabel(date) {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date || "");
    if (!m) return date || "";
    const day = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
    return Number(m[2]) + "/" + Number(m[3]) + "(" + WEEKDAYS[day.getUTCDay()] + ")";
  }

  // 時刻（SELF_AGENT_TZ）の表示は ui.js
  const { dateTime, dateOf } = SA.ui;

  /** 今からどれだけ前か（分・時間・日） */
  function ago(iso) {
    const ms = Date.now() - new Date(iso).getTime();
    if (!Number.isFinite(ms)) return "";
    const min = Math.max(0, Math.floor(ms / 60000));
    if (min < 60) return min + " 分前";
    if (min < 60 * 24) return Math.floor(min / 60) + " 時間前";
    return Math.floor(min / (60 * 24)) + " 日前";
  }

  /** 入力（input + read + creation）。どれかが無ければ null */
  function inputOf(input, read, creation) {
    return typeof input === "number" && typeof read === "number" && typeof creation === "number" ? input + read + creation : null;
  }

  function rate(read, total) {
    return typeof read !== "number" || typeof total !== "number" || total === 0 ? "-" : Math.round((read / total) * 100) + "%";
  }

  function bytes(value) {
    if (typeof value !== "number" || !Number.isFinite(value)) return "-";
    if (value >= 1024 * 1024) return (value / (1024 * 1024)).toFixed(1) + " MB";
    if (value >= 1024) return (value / 1024).toFixed(1) + " KB";
    return value + " B";
  }

  /** 今日（サーバーの日付）の入力のトークン。分からなければ null */
  function todayTokens() {
    if (!store.today || !Array.isArray(store.usageDays)) return null;
    const day = store.usageDays.find((d) => d.date === store.today);
    return day ? day.inputTokens : 0;
  }

  // ===== 使用量（W1） =====
  const usageState = { date: null };

  function selectUsageDate(date) {
    usageState.date = date || null;
  }

  function usageDateOptions() {
    const dates = new Set();
    if (store.today) dates.add(store.today);
    for (const d of store.usageDays || []) dates.add(d.date);
    if (usageState.date) dates.add(usageState.date);
    return [...dates].sort().reverse();
  }

  function renderUsage(container) {
    const want = usageState.date || store.today;
    const u = store.usage;
    const date = el("select", { class: "select select-sm", "aria-label": "日付" });
    for (const d of usageDateOptions()) {
      date.append(el("option", { value: d, selected: d === want, text: (d === store.today ? "今日 " : "") + dayLabel(d) }));
    }
    date.addEventListener("change", () => {
      usageState.date = date.value === store.today ? null : date.value;
      store.load.usage(usageState.date);
      SA.app.refreshSidebar();
    });
    const head = toolbar("bar-chart", "使用量", [], [date]);
    // まだ読んでいない・別の日付のものしか無い
    if (!u || (want && u.date !== want)) {
      const failed = store.usageFailed !== null && store.usageFailed === (usageState.date || "today");
      container.replaceChildren(head, scroll([empty(null, failed ? "読み込めませんでした" : "読み込んでいます…")]));
      return;
    }
    const cards = el(
      "div",
      { class: "metric-grid" },
      (u.totals || []).map((t) => {
        const s = t.summary || {};
        const input = inputOf(s.inputTokens, s.cacheReadInputTokens, s.cacheCreationInputTokens);
        return el("div", { class: "card card-sm" }, [
          el("div", { class: "card-head" }, [el("h3", { text: t.name }), el("span", { class: "meta", text: "ターン " + (s.turns ?? 0) + (s.failedTurns > 0 ? "（失敗 " + s.failedTurns + "）" : "") })]),
          el("dl", { class: "metrics" }, [
            el("div", {}, [el("dt", { text: "入力" }), el("dd", { text: count(input) })]),
            el("div", {}, [el("dt", { text: "キャッシュ率" }), el("dd", { text: rate(s.cacheReadInputTokens, input) })]),
            el("div", {}, [el("dt", { text: "出力" }), el("dd", { text: count(t.outputTokens) })]),
          ]),
        ]);
      }),
    );
    const rows = (u.rows || []).map((r) => {
      const input = inputOf(r.inputTokens, r.cacheReadInputTokens, r.cacheCreationInputTokens);
      return el("tr", {}, [
        td(SA.ui.clock(new Date(r.at)), "td-num"),
        td(r.kind || "-"),
        td(r.ok ? "成功" : "失敗", r.ok ? null : "is-overdue"),
        td(String(r.toolCalls ?? 0), "td-num"),
        td(count(input), "td-num"),
        td(count(r.cacheReadInputTokens), "td-num"),
        td(count(r.cacheCreationInputTokens), "td-num"),
        td(count(r.outputTokens), "td-num"),
        td(rate(r.cacheReadInputTokens, input), "td-num"),
      ]);
    });
    const turns =
      rows.length === 0
        ? empty("bar-chart", "この日のターンはありません")
        : table(
            ["時刻", "種類", "結果", { text: "ツール", cls: "td-num" }, { text: "入力", cls: "td-num" }, { text: "読み", cls: "td-num" }, { text: "書き", cls: "td-num" }, { text: "出力", cls: "td-num" }, { text: "率", cls: "td-num" }],
            rows,
            "table-num",
          );
    const att = u.attachments || {};
    container.replaceChildren(
      head,
      scroll([
        cards,
        section("ターン", [turns], rows.length > 0 ? [el("span", { class: "meta", text: "新しい " + rows.length + " 件" })] : []),
        el("p", { class: "meta", text: "保存している添付: " + count(att.count ?? 0) + " 件・" + bytes(att.bytes ?? 0) }),
      ]),
    );
  }

  // ===== 会話ログ（W2。dev モードだけ。左に一覧、右に中身） =====
  // date: 見ている日（null はサーバーの今日）。selected: 一覧で選んでいる記録（新しい順の位置）
  const devlogState = { date: null, kind: "all", selected: 0 };

  function selectDevlogDate(date) {
    devlogState.date = date || null;
    devlogState.selected = 0;
  }

  const DEVLOG_KINDS = [
    ["all", "全部"],
    ["inbox", "#inbox"],
    ["tasks", "#tasks"],
    ["session", "セッション"],
  ];

  /** 記録の見出し（チャンネルが一覧にあれば #名前・題名、無ければ種類） */
  function devlogLabel(r) {
    if (!r.kind) return "（チャンネルなし）";
    const ch = store.channels && r.channelId ? store.channels.channels.find((c) => c.id === r.channelId) : null;
    if (ch) return SA.chat.channelTitle(ch);
    return r.kind === "session" ? "セッション" : "#" + r.kind;
  }

  function renderDevlog(container) {
    const chips = el("div", { class: "row row-tight", role: "group", "aria-label": "種類" });
    for (const [key, label] of DEVLOG_KINDS) {
      const c = el("button", { class: "chip chip-sm", type: "button", "aria-pressed": String(devlogState.kind === key), text: label });
      c.addEventListener("click", () => {
        devlogState.kind = key;
        devlogState.selected = 0;
        SA.app.refresh("devlog");
      });
      chips.append(c);
    }
    const want = devlogState.date || store.devlogToday;
    const data = store.devlog;
    if (!data || !want || data.date !== want) {
      const failed = store.devlogFailed !== null && store.devlogFailed === (devlogState.date || "today");
      container.replaceChildren(toolbar("file-text", "会話ログ", [], [chips]), scroll([empty(null, failed ? "読み込めませんでした" : "読み込んでいます…")]));
      return;
    }
    // 新しい順に並べる（API は古い順）
    const records = (Array.isArray(data.records) ? data.records : []).filter((r) => devlogState.kind === "all" || r.kind === devlogState.kind).reverse();
    devlogState.selected = Math.min(devlogState.selected, Math.max(0, records.length - 1));
    const list = el("ul", { class: "master-list", role: "listbox", "aria-label": "ターン" });
    records.forEach((r, i) => {
      const item = el("li", { role: "option", "aria-selected": String(i === devlogState.selected), tabindex: "0", class: "master-item" }, [
        el("span", { class: "master-title" }, [el("span", { class: "dot " + (r.ok ? "dot-ok" : "dot-bad"), "aria-hidden": "true" }), SA.ui.clock(new Date(r.at)) + " " + devlogLabel(r)]),
        el("span", { class: "meta", text: SA.ui.elapsed(r.durationMs || 0) + "・ツール " + (r.toolCalls ?? 0) + " 回" + (r.ok ? "" : "・失敗") }),
      ]);
      const pick = () => {
        devlogState.selected = i;
        SA.app.refresh("devlog");
      };
      item.addEventListener("click", pick);
      item.addEventListener("keydown", (e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          pick();
        }
      });
      list.append(item);
    });
    const current = records[devlogState.selected];
    const detail = current ? el("pre", { class: "code-pre", text: current.text }) : empty(null, data.records && data.records.length > 0 ? "この種類のターンはありません" : "この日の記録はありません");
    container.replaceChildren(
      toolbar("file-text", "会話ログ", [el("span", { class: "meta", text: dayLabel(data.date) + "・dev モード" })], [chips]),
      el("div", { class: "master-detail" }, [el("div", { class: "master" }, [list]), el("div", { class: "detail" }, [detail])]),
    );
  }

  // ===== タスク・リマインド・記憶の操作（W4） =====
  /** 操作が通らなかったとき: 404・409 は「古くなっています」、それ以外は request の文。どちらも一覧を読み直す */
  function failed(err, key) {
    const stale = err && (err.status === 404 || err.status === 409);
    toast(stale ? "この操作は古くなっています" : (err && err.toast) || "操作に失敗しました");
    store.reload(key);
  }

  /**
   * POST して、通ったら一覧を読み直して then を呼ぶ。押したボタンは終わるまで押せなくし、読み直しが終わったら（失敗でも）押せる状態に戻す
   * （読み直せていれば行ごと描き直されている）
   */
  function act(button, path, key, then) {
    if (button) button.disabled = true;
    SA.api.post(path, {}, { quiet: true }).then(
      (data) => {
        store.reload(key).then(() => {
          if (button) button.disabled = false;
        });
        if (then) then(data);
      },
      (err) => {
        if (button) button.disabled = false;
        failed(err, key);
      },
    );
  }

  // ===== タスク（W4: 一覧と [完了]・トーストの [取り消す]） =====
  const TASK_STATUSES = [
    ["open", "未完了"],
    ["done", "完了"],
    ["dropped", "やめた"],
  ];

  /** 期限（YYYY-MM-DD）が今日（サーバーの日付）より前の未完了 */
  function overdue(t) {
    return t.status === "open" && typeof t.due === "string" && !!store.today && t.due < store.today;
  }

  function completeTask(button, t) {
    act(button, "/api/tasks/" + t.id + "/complete", "tasks", () => {
      toast("「" + t.title + "」を完了にしました", {
        label: "取り消す",
        run: () => act(null, "/api/tasks/" + t.id + "/reopen", "tasks"),
      });
    });
  }

  function renderTasks(container) {
    const shown = store.taskStatus;
    // 件数は直前に読んだもの（切り替えた直後の読み込み中も出す）
    const counts = store.tasks ? store.tasks.counts : null;
    const seg = el("div", { class: "segmented segmented-sm", role: "group", "aria-label": "状態" });
    for (const [key, label] of TASK_STATUSES) {
      const n = counts && typeof counts[key] === "number" ? counts[key] : null;
      const b = el("button", { type: "button", "aria-pressed": String(shown === key), text: n === null ? label : label + " " + n });
      b.addEventListener("click", () => {
        if (store.taskStatus === key) return;
        store.taskStatus = key;
        SA.app.refresh("tasks");
        store.reload("tasks");
      });
      seg.append(b);
    }
    const head = toolbar("square-check", "タスク", [], [seg]);
    if (!store.tasks || store.tasks.status !== shown) {
      container.replaceChildren(head, scroll([empty(null, "読み込んでいます…")]));
      return;
    }
    const rows = store.tasks.tasks.map((t) => {
      const late = overdue(t);
      const due = t.due === null ? "—" : dayLabel(t.due) + (late ? "・過ぎています" : "");
      const action = el("td", { class: "td-actions" });
      if (t.status === "open") {
        const done = el("button", { class: "btn btn-secondary btn-sm", type: "button" }, [icon("check"), "完了"]);
        done.addEventListener("click", () => completeTask(done, t));
        action.append(done);
      }
      const closed = (t.status === "done" ? "完了 " : "やめた ") + (t.completedAt ? dateOf(t.completedAt) : "-");
      return el("tr", { "data-task": String(t.id) }, [
        td("#" + t.id, "td-num"),
        td(t.title, "td-main"),
        td(due, late ? "is-overdue" : null),
        td(t.status === "open" ? (t.remind ? dateTime(t.remind) : "—") : closed),
        action,
      ]);
    });
    const body =
      rows.length === 0
        ? empty("square-check", "このタスクはありません")
        : table(["#", "題名", "期限", shown === "open" ? "知らせ" : "閉じた日", { text: "", cls: "th-actions" }], rows);
    container.replaceChildren(
      head,
      scroll([body, el("p", { class: "meta", text: "追加・編集は #inbox か #tasks に書いてください（Bot が task_add・task_update を使います）。" })]),
    );
  }

  // ===== リマインド（W4: 止める・次を飛ばす） =====
  /** 一覧・確認のダイアログに出すリマインドの text（改行を空白に） */
  function oneLine(text) {
    return String(text).replace(/\s*[\r\n]+\s*/g, " ");
  }

  function renderReminders(container) {
    const list = store.reminders;
    if (!list) {
      container.replaceChildren(toolbar("bell", "リマインド"), scroll([empty(null, "読み込んでいます…")]));
      return;
    }
    const rows = list.map((r) => {
      const actions = el("td", { class: "td-actions" });
      if (r.rule !== null) {
        const skip = el("button", { class: "btn btn-ghost btn-sm", type: "button", text: "次を飛ばす" });
        skip.addEventListener("click", () =>
          act(skip, "/api/reminders/" + r.id + "/skip", "reminders", (data) => {
            toast("次の回を飛ばしました。次は " + (data && data.next ? dateTime(data.next) : "-") + " です");
          }),
        );
        actions.append(skip);
      }
      const stop = el("button", { class: "btn btn-ghost btn-sm", type: "button", text: "止める" });
      stop.addEventListener("click", () =>
        confirm({
          title: "「" + oneLine(r.text) + "」を止めますか",
          body: "止めたリマインドは戻せません。",
          ok: "止める",
          danger: true,
          run: () =>
            act(stop, "/api/reminders/" + r.id + "/cancel", "reminders", () => {
              toast("「" + r.text + "」を止めました");
            }),
        }),
      );
      actions.append(stop);
      return el("tr", {}, [
        td(r.nextAt ? dateTime(r.nextAt) : "-", "td-nowrap"),
        td([r.kind === "prompt" ? el("span", { class: "badge badge-accent", text: "依頼" }) : null, r.kind === "prompt" ? " " : null, oneLine(r.text)], "td-main"),
        td(r.rule === null ? "1 回だけ" : r.ruleText || r.rule),
        td(r.channelName || "—"),
        actions,
      ]);
    });
    const body =
      rows.length === 0
        ? empty("bell", "動いているリマインドはありません")
        : table(["次の時刻", "内容", "繰り返し", "頼んだ場所", { text: "", cls: "th-actions" }], rows);
    container.replaceChildren(
      toolbar("bell", "リマインド", [el("span", { class: "meta", text: list.length + " 件" })]),
      scroll([body, el("p", { class: "meta", text: "発火のメッセージのボタン（済んだ・10 分後・1 時間後）は Discord にだけあります。" })]),
    );
  }

  // ===== 記憶（W4: 一覧と [忘れる]・トーストの [取り消す]） =====
  function renderMemories(container) {
    const list = store.memories;
    if (!list) {
      container.replaceChildren(toolbar("book", "記憶"), scroll([empty(null, "読み込んでいます…")]));
      return;
    }
    // 新しい順に並べる（API は id 順）
    const rows = [...list]
      .sort((a, b) => b.id - a.id)
      .map((m) => {
        const forget = el("button", { class: "btn btn-ghost btn-sm", type: "button", text: "忘れる" });
        forget.addEventListener("click", () =>
          act(forget, "/api/memories/" + m.id + "/forget", "memories", () => {
            toast("忘れました: " + m.text, {
              label: "取り消す",
              run: () => act(null, "/api/memories/" + m.id + "/restore", "memories"),
            });
          }),
        );
        return el("tr", {}, [td("#" + m.id, "td-num"), td(m.text, "td-main"), td(dateOf(m.createdAt)), el("td", { class: "td-actions" }, [forget])]);
      });
    container.replaceChildren(
      toolbar("book", "記憶"),
      scroll([
        el("p", { class: "meta", text: "オーナーについての記憶です。毎ターンの先頭に付きます。" }),
        rows.length ? table(["#", "記憶", "保存", { text: "", cls: "th-actions" }], rows) : empty(null, "記憶はありません"),
      ]),
    );
  }

  // ===== GitHub（W6: #github に出した通知。[対応] は段 2） =====
  /** 検証した部品から組み立てた Issue・PR の URL（サーバーの poller.ts と同じ形）。合わなければ null（リンクにしない） */
  const GITHUB_URL = /^https:\/\/github\.com\/([A-Za-z0-9-]{1,39})\/([A-Za-z0-9._-]{1,100})\/(pull|issues)\/([1-9][0-9]{0,9})$/;

  function githubParts(url) {
    const m = typeof url === "string" ? GITHUB_URL.exec(url) : null;
    return m ? { repo: m[1] + "/" + m[2], number: m[4] } : null;
  }

  /** 失敗の種類の表示（poller.ts の GithubFailure と no_gh） */
  const GITHUB_FAILURES = {
    auth: "gh の認証",
    rate_limited: "レート制限",
    forbidden: "GitHub が拒否しました（403）",
    network: "通信の失敗",
    shape: "応答の形が違います",
    no_gh: "gh が見つかりません",
  };

  function githubFailureText(kind) {
    return Object.prototype.hasOwnProperty.call(GITHUB_FAILURES, kind) ? GITHUB_FAILURES[kind] : String(kind);
  }

  /** 取得の状態の 1 行（最後の取得・失敗・止めている間） */
  function githubFetchLine(g) {
    const parts = [g && g.lastFetchAt ? "最後の取得 " + SA.ui.shortTime(g.lastFetchAt) : "まだ取得していません"];
    if (g && g.failure) parts.push("失敗: " + githubFailureText(g.failure));
    if (g && g.pausedUntil) parts.push(SA.ui.shortTime(g.pausedUntil) + " まで止めています");
    return parts.join("・");
  }

  function githubItem(n) {
    const parts = githubParts(n.url);
    const title = (n.label ? n.label + ": " : "") + (n.title || "（題名なし）") + (parts ? " #" + parts.number : "");
    const meta = [parts ? parts.repo : null, n.actorLogin, n.actorKnown ? null : "誰の操作か確かめられませんでした", SA.ui.shortTime(n.updatedAt)].filter((v) => v);
    return el("li", { class: "row-list-item" }, [
      el("span", { class: "dot " + (n.level === "red" ? "dot-bad" : "dot-warn"), "aria-hidden": "true" }),
      el("div", { class: "item-main" }, [el("span", { class: "item-title", text: title }), el("span", { class: "meta", text: meta.join("・") })]),
      parts ? el("a", { class: "btn btn-ghost btn-sm", href: n.url, target: "_blank", rel: "noreferrer noopener" }, [icon("external-link"), "GitHub"]) : null,
      el("button", { class: "btn btn-secondary btn-sm", type: "button", disabled: true, title: "段 2 で足す", text: "対応" }),
    ]);
  }

  function renderGithub(container) {
    const data = store.github;
    if (!data) {
      container.replaceChildren(toolbar("git-pull-request", "GitHub の通知"), scroll([empty(null, "読み込んでいます…")]));
      return;
    }
    const group = (level, title) => {
      const items = data.notifications.filter((n) => n.level === level);
      return section(
        title,
        [items.length ? el("ul", { class: "row-list" }, items.map(githubItem)) : el("p", { class: "meta", text: "ありません" })],
        [el("span", { class: "meta", text: items.length + " 件" })],
      );
    };
    container.replaceChildren(
      toolbar("git-pull-request", "GitHub の通知", [], [el("span", { class: "meta", text: githubFetchLine(data.status) })]),
      scroll([
        group("red", "自分宛て"),
        group("yellow", "自分のリポジトリの新しい Issue / PR"),
        el("p", { class: "meta", text: "#github に出したものと同じです。[対応]（Claude Code のセッションに渡す）は段 2 です。" }),
      ]),
    );
  }

  // ===== ナレッジ（W6: 一覧と中身。検索は 3 文字以上。読むだけで、削除は Discord から） =====
  // q: 検索欄の語（打っている途中も）。selected: 選んでいる項目の id
  const kbState = { q: "", selected: null, timer: null };
  /** 検索欄（タブとサイドバーに 1 つずつ。kbInput）。描き直しても同じ要素を使い、打っている間のフォーカスを保つ */
  const kbInputs = [];
  /** 打ち終わってから検索するまで */
  const KB_SEARCH_DELAY_MS = 300;

  /** 検索欄の語で読む（空なら新しい順。1〜2 文字の間は読まない） */
  function searchKnowledge() {
    clearTimeout(kbState.timer);
    kbState.timer = null;
    const q = kbState.q.trim();
    if (q !== "" && [...q].length < 3) return;
    store.load.knowledge(q);
  }

  function kbSearchInput() {
    const input = el("input", { class: "input input-sm", type: "search", placeholder: "検索（3 文字以上）", "aria-label": "ナレッジを検索" });
    input.value = kbState.q;
    input.addEventListener("input", () => {
      kbState.q = input.value;
      for (const other of kbInputs) if (other !== input) other.value = input.value;
      clearTimeout(kbState.timer);
      kbState.timer = setTimeout(searchKnowledge, KB_SEARCH_DELAY_MS);
    });
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") searchKnowledge();
    });
    kbInputs.push(input);
    return input;
  }

  /** 検索欄（which は "tab" か "sidebar"）。どちらに打っても同じ語になる */
  const kbInputFor = {};
  function kbInput(which) {
    if (!kbInputFor[which]) kbInputFor[which] = kbSearchInput();
    return kbInputFor[which];
  }

  /** 描き直しで外れたフォーカスを戻す（同じ要素なのでカーソルの位置も残る） */
  function keepFocus(input, render) {
    const focused = document.activeElement === input;
    render();
    if (focused && input.isConnected) input.focus();
  }

  function selectKb(id) {
    kbState.selected = id;
  }

  /** 一覧で選んでいる項目（無ければ先頭） */
  function kbSelected(entries) {
    const found = entries.find((k) => k.id === kbState.selected);
    return found || entries[0] || null;
  }

  function kbDetail(item) {
    if (!item) return empty(null, store.knowledge && store.knowledge.q ? "見つかりませんでした" : "ナレッジはありません");
    const entry = store.kbEntries[item.id];
    if (entry === undefined) {
      store.load.kbEntry(item.id);
      return empty(null, "読み込んでいます…");
    }
    if (entry === "missing") return empty(null, "この項目はもうありません");
    if (entry === "failed") return empty(null, "読み込めませんでした");
    // 一覧の方が新しければ読み直す（読み直す間は前の中身を出す）
    if (typeof item.updatedAt === "string" && item.updatedAt > entry.updatedAt) store.load.kbEntry(item.id, true);
    const url = typeof entry.url === "string" && /^https?:\/\//.test(entry.url) ? entry.url : null;
    return el("div", { class: "ed-page" }, [
      el("h2", { text: entry.title }),
      url ? el("a", { href: url, target: "_blank", rel: "noreferrer noopener", text: url }) : el("span", { class: "meta", text: entry.url ? entry.url : "URL なし" }),
      entry.summary ? el("p", { text: entry.summary }) : null,
      Array.isArray(entry.tags) && entry.tags.length > 0 ? el("div", { class: "row row-tight" }, entry.tags.map((tag) => el("span", { class: "badge", text: tag }))) : null,
      entry.body ? el("p", { class: "msg-text", text: entry.body }) : null,
      el("p", { class: "meta", text: "#" + entry.id + "・保存 " + dateOf(entry.createdAt) + (entry.updatedAt !== entry.createdAt ? "・更新 " + dateOf(entry.updatedAt) : "") }),
      el("p", { class: "meta", text: "削除は Discord の確認（kb_delete）から行います。" }),
    ]);
  }

  function renderKnowledge(container) {
    const input = kbInput("tab");
    keepFocus(input, () => {
      const data = store.knowledge;
      if (!data) {
        container.replaceChildren(toolbar("book", "ナレッジ", [], [input]), scroll([empty(null, "読み込んでいます…")]));
        return;
      }
      const current = kbSelected(data.entries);
      const list = el("ul", { class: "master-list", role: "listbox", "aria-label": "ナレッジ" });
      for (const k of data.entries) {
        const item = el("li", { role: "option", tabindex: "0", class: "master-item", "aria-selected": String(current !== null && k.id === current.id) }, [
          el("span", { class: "master-title", text: k.title }),
          el("span", { class: "meta", text: "#" + k.id + "・" + dateOf(k.updatedAt) }),
        ]);
        const pick = () => {
          kbState.selected = k.id;
          SA.app.refresh("knowledge");
          SA.app.refreshSidebar();
        };
        item.addEventListener("click", pick);
        item.addEventListener("keydown", (e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            pick();
          }
        });
        list.append(item);
      }
      const note = data.q ? (data.more ? "「" + data.q + "」の上位 " + data.entries.length + " 件" : "「" + data.q + "」 " + data.entries.length + " 件") : null;
      container.replaceChildren(
        toolbar("book", "ナレッジ", note ? [el("span", { class: "meta", text: note })] : [], [input]),
        el("div", { class: "master-detail" }, [el("div", { class: "master" }, [list]), el("div", { class: "detail" }, [kbDetail(current)])]),
      );
    });
  }

  // ===== 状態（W1） =====
  function kv(label, value) {
    return el("li", { class: "kv" }, [el("span", { class: "kv-label" }, [label]), el("span", { class: "kv-value" }, [value])]);
  }

  function okBadge(ok, yes, no) {
    return el("span", { class: "badge " + (ok ? "badge-success" : "badge-danger") }, [icon(ok ? "check" : "triangle-alert"), ok ? yes : no]);
  }

  function botNote(b) {
    if (b.guest) return "ゲスト";
    if (b.isDefault) return "既定";
    return "人格";
  }

  function shellValue(shell) {
    if (!shell || !shell.configured) return "使わない";
    if (shell.enabled) return okBadge(true, "通ります", "");
    const failed = Array.isArray(shell.failed) && shell.failed.length > 0 ? "（" + shell.failed.join("・") + "）" : "";
    return el("span", { class: "row row-tight" }, [okBadge(false, "", "通りません"), failed]);
  }

  function githubLine(g) {
    if (!g || !g.enabled) return "無効";
    return "有効・" + githubFetchLine(g);
  }

  function renderStatus(container) {
    const s = store.status;
    const head = toolbar("activity", "状態", [el("span", { class: "meta", text: "10 秒ごとに更新" })]);
    if (!s) {
      container.replaceChildren(head, scroll([empty(null, "読み込んでいます…")]));
      return;
    }
    const guilds = Array.isArray(s.guilds) ? s.guilds : [];
    container.replaceChildren(
      head,
      scroll([
        s.stopping ? el("p", { class: "alert", role: "alert", text: "再起動中です。新しい操作は受け付けません。" }) : null,
        el("div", { class: "two-col" }, [
          section("Bot の接続", [
            el("ul", { class: "kv-list" }, (s.bots || []).map((b) => kv(b.name + "（" + botNote(b) + "）", okBadge(b.connected, "接続中", "接続できません")))),
          ]),
          section("動作", [
            el("ul", { class: "kv-list" }, [
              kv("シェルの自己診断", shellValue(s.shell)),
              kv("実行中のセッションのジョブ", String(s.queue ? s.queue.runningSessionJobs : 0)),
              kv("実行中のターン", String(s.running ?? 0)),
              kv("プロジェクトの配信", !s.serveConfigured ? "無効" : s.serving ? "待ち受け中" : "止まっています"),
              kv("dev モード", s.devMode ? "有効" : "無効"),
              kv("GitHub の通知", githubLine(s.github)),
              kv("作業ジョブ", s.jobs && s.jobs.enabled ? "有効" : "無効"),
              kv("ゲスト", s.guest ? "有効" : "無効"),
              kv("サーバー", guilds.length + " 件（/setup 済み " + guilds.filter((g) => g.setUp).length + "）"),
              kv("版", s.version || "-"),
              kv("起動", s.startedAt ? dateTime(s.startedAt) + "（" + ago(s.startedAt) + "）" : "-"),
            ]),
          ]),
        ]),
      ]),
    );
  }

  // ===== 設定（読むだけ + この画面の表示） =====
  const KEYS = [
    ["Ctrl+K / Ctrl+P", "移動（画面）"],
    ["Ctrl+Shift+P", "コマンド"],
    ["Ctrl+B", "サイドバーの表示"],
    ["Ctrl+J", "パネルの表示"],
    ["Alt+W", "タブを閉じる"],
    ["Alt+1〜9", "n 番目のタブ"],
    ["Esc", "パレット・ドロワーを閉じる"],
  ];

  function renderSettings(container) {
    const theme = SA.app.theme();
    const seg = el("div", { class: "segmented segmented-sm", role: "group", "aria-label": "テーマ" });
    for (const [key, label] of [["dark", "ダーク"], ["light", "ライト"], ["system", "OS に合わせる"]]) {
      const b = el("button", { type: "button", "aria-pressed": String(theme === key), text: label });
      b.addEventListener("click", () => {
        SA.app.setTheme(key);
        SA.app.refresh("settings");
      });
      seg.append(b);
    }
    const env = store.status && Array.isArray(store.status.env) ? store.status.env : null;
    container.replaceChildren(
      toolbar("settings", "設定"),
      scroll([
        el("div", { class: "two-col" }, [
          section("この画面の表示", [
            el("ul", { class: "kv-list" }, [kv("テーマ", seg)]),
            el("p", { class: "meta", text: "表示の設定はこのブラウザにだけ残ります。" }),
          ]),
          section("キーボード", [el("ul", { class: "kv-list" }, KEYS.map(([k, v]) => kv(el("kbd", { text: k }), v)))]),
        ]),
        section("環境変数", [
          el("p", { class: "meta", text: "あるかないかだけを出します。値は出しません。変えるときは ~/.config/self-agent/env を編集して再起動します。" }),
          env
            ? el("ul", { class: "kv-list kv-grid" }, env.map(([name, has]) => kv(el("span", { class: "mono", text: name }), el("span", { class: "badge", text: has ? "あり" : "なし" }))))
            : empty(null, "読み込んでいます…"),
        ]),
      ]),
    );
  }

  // ===== ようこそ（タブが無いとき） =====
  function renderWelcome(container) {
    const action = (label, keys, fn) => {
      const b = el("button", { class: "welcome-link", type: "button" }, [el("span", { text: label }), keys ? el("kbd", { text: keys }) : null]);
      b.addEventListener("click", fn);
      return b;
    };
    container.replaceChildren(
      el("div", { class: "welcome" }, [
        el("h1", { text: "self-agent" }),
        el("p", { class: "meta", text: "左の一覧から開くか、コマンドで移動します。" }),
        el("div", { class: "welcome-links" }, [
          action("移動", "Ctrl+K", () => SA.app.palette("")),
          action("コマンド", "Ctrl+Shift+P", () => SA.app.palette(">")),
          action("状態を開く", "", () => SA.app.open("status")),
          action("使用量を開く", "", () => SA.app.open("usage")),
          action("サイドバー", "Ctrl+B", () => SA.app.toggleSidebar()),
          action("パネル", "Ctrl+J", () => SA.app.togglePanel()),
        ]),
      ]),
    );
  }

  // ===== タブ ID → 表示（onOpen はタブを前に出したときに呼ぶ） =====
  const STATIC = {
    tasks: { title: "タスク", icon: "square-check", render: renderTasks, onOpen: () => store.load.tasks() },
    reminders: { title: "リマインド", icon: "bell", render: renderReminders, onOpen: () => store.load.reminders() },
    memories: { title: "記憶", icon: "book", render: renderMemories, onOpen: () => store.load.memories() },
    github: { title: "GitHub", icon: "git-pull-request", render: renderGithub, onOpen: () => store.load.github() },
    knowledge: {
      title: "ナレッジ",
      icon: "book",
      render: renderKnowledge,
      onOpen: () => {
        // 開いたときは今の語で一覧を、選んでいる項目の本文を読み直す
        store.load.knowledge(store.knowledge ? store.knowledge.q : kbState.q.trim().length >= 3 ? kbState.q.trim() : "");
        if (kbState.selected !== null) store.load.kbEntry(kbState.selected, true);
      },
    },
    usage: {
      title: "使用量",
      icon: "bar-chart",
      render: renderUsage,
      onOpen: () => {
        store.load.usage(usageState.date);
        store.load.usageDays();
      },
    },
    status: { title: "状態", icon: "activity", render: renderStatus, onOpen: () => store.load.status() },
    settings: { title: "設定", icon: "settings", render: renderSettings },
    devlog: {
      title: "会話ログ",
      icon: "file-text",
      render: renderDevlog,
      onOpen: () => {
        store.load.devlog(devlogState.date);
        store.load.devlogDays();
      },
    },
  };

  /**
   * 知らない・無効な機能のタブは null（開かない）。会話は ch:<チャンネル ID>。会話ログ・GitHub は /api/status を読んで
   * dev モード・GitHub が有効と分かるまで開かない
   */
  function info(tabId) {
    if (tabId.startsWith("ch:")) {
      const channelId = tabId.slice(3);
      return /^\d{1,25}$/.test(channelId) ? SA.chat.info(channelId) : null;
    }
    if (tabId === "devlog" && !(store.status && store.status.devMode)) return null;
    if (tabId === "github" && !(store.status && store.status.github && store.status.github.enabled)) return null;
    return Object.prototype.hasOwnProperty.call(STATIC, tabId) ? STATIC[tabId] : null;
  }

  /** /api/status を読むまで開けるか分からないタブ（読んだ後に開き直す） */
  function waitsForStatus(tabId) {
    return (tabId === "devlog" || tabId === "github") && store.status === null;
  }

  SA.views = {
    info,
    waitsForStatus,
    renderWelcome,
    selectUsageDate,
    usageDate: () => usageState.date,
    selectDevlogDate,
    devlogDate: () => devlogState.date,
    selectKb,
    kbSelectedId: () => (store.knowledge ? (kbSelected(store.knowledge.entries) || { id: null }).id : null),
    kbInput,
    githubParts,
    compact,
    dayLabel,
    overdue,
    oneLine,
    todayTokens,
  };
})();
