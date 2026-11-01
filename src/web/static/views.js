// タブの中身: 状態・使用量・設定・ようこそ（W1）・会話ログ（W2。会話のタブは chat.js）・タスク・リマインド・記憶（W4）・GitHub・ナレッジ（W6）・
// プロジェクト（W7。読むだけ）・Claude Code のセッション（CC2 の画面の写しと CC3 の送信と CC5a の許可のカード）。ジョブは後の段で足す
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

  // ===== GitHub（W6: #github に出した通知。[対応] は Claude Code のセッションへの送り込み（CC6）） =====
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

  /** [対応] と [起動して送る] の結果（サーバーの文をトーストに。積んだら [取り消す]、セッションが無ければ起動の確認） */
  function githubHandoffDone(n, data) {
    const text = data && typeof data.text === "string" ? data.text : "送りました";
    if (data && data.result === "no_session" && data.startable === true) {
      confirm({
        title: "新しいセッションを起動して送る",
        body: text,
        ok: "起動して送る",
        run: () => githubHandoff(null, n, "start"),
      });
      return;
    }
    const sendId = data && typeof data.sendId === "number" ? data.sendId : null;
    const cancellable = sendId !== null && (data.result === "started" || data.state === "queued");
    toast(
      text,
      cancellable
        ? {
            label: "取り消す",
            run: () =>
              SA.api.post("/api/cc/sends/" + sendId + "/cancel", {}, { quiet: true }).then(
                () => toast("取り消しました"),
                (err) => toast(err && err.status === 409 ? "この操作は古くなっています（届けている途中か、終わっています）" : (err && err.toast) || "取り消せませんでした"),
              ),
          }
        : undefined,
    );
  }

  /** POST /api/github/<id>/act（[対応]）・start（[起動して送る]）。押したボタンは終わるまで押せなくする */
  function githubHandoff(button, n, action) {
    if (button) button.disabled = true;
    SA.api.post("/api/github/" + n.id + "/" + action, {}, { quiet: true }).then(
      (data) => {
        if (button) button.disabled = false;
        githubHandoffDone(n, data);
      },
      (err) => {
        if (button) button.disabled = false;
        failed(err, "github");
      },
    );
  }

  function githubItem(n) {
    const parts = githubParts(n.url);
    const title = (n.label ? n.label + ": " : "") + (n.title || "（題名なし）") + (parts ? " #" + parts.number : "");
    const meta = [parts ? parts.repo : null, n.actorLogin, n.actorKnown ? null : "誰の操作か確かめられませんでした", SA.ui.shortTime(n.updatedAt)].filter((v) => v);
    return el("li", { class: "row-list-item" }, [
      el("span", { class: "dot " + (n.level === "red" ? "dot-bad" : "dot-warn"), "aria-hidden": "true" }),
      el("div", { class: "item-main" }, [el("span", { class: "item-title", text: title }), el("span", { class: "meta", text: meta.join("・") })]),
      parts ? el("a", { class: "btn btn-ghost btn-sm", href: n.url, target: "_blank", rel: "noreferrer noopener" }, [icon("external-link"), "GitHub"]) : null,
      githubActButton(n),
    ]);
  }

  /** [対応]。使えないもの（送り込みが無効・自分のでも地図にも無いリポジトリ）は押せない */
  function githubActButton(n) {
    const attrs = { class: "btn btn-secondary btn-sm", type: "button", text: "対応" };
    if (!n.handoff) {
      attrs.disabled = true;
      attrs.title = store.github && store.github.handoff ? "このリポジトリには送れません（または [対応] を付ける前の通知です）" : "SELF_AGENT_CC が無効です";
      return el("button", attrs);
    }
    attrs.title = "このリポジトリの Claude Code のセッションに対応依頼を送る";
    const button = el("button", attrs);
    button.addEventListener("click", () => githubHandoff(button, n, "act"));
    return button;
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
        el("p", {
          class: "meta",
          text: "#github に出したもの（「ほか n 件」にまとめたものを含む）です。[対応] でそのリポジトリの Claude Code のセッションに対応依頼（リポジトリ・番号・URL だけの 1 行）を送ります。セッションが無ければ起動を確かめます。",
        }),
      ]),
    );
  }

  // ===== プロジェクト（W7: ファイルの一覧と、選んだファイルの中身を読むだけ。ページはリンクで開く） =====
  /** slug → 選んだファイルのパス（無ければ site/index.html があればそれ） */
  const projectSel = {};
  const PROJECT_FILE_ERRORS = {
    not_found: "ファイルがありません（消えたか、移されました）",
    too_large: "256 KB を超えるため表示しません",
    binary: "テキストではないため表示しません",
    invalid_path: "このファイルは表示できません",
  };

  /** 読めなかったときの文。too_large は応答の上限（maxBytes）があればその大きさで */
  function projectFileError(current) {
    if (current.error === "too_large" && current.maxBytes) {
      const limit = current.maxBytes % 1024 === 0 ? current.maxBytes / 1024 + " KB" : bytes(current.maxBytes);
      return limit + " を超えるため表示しません";
    }
    return PROJECT_FILE_ERRORS[current.error] || "読み込めませんでした";
  }

  function pageUrl(url) {
    return typeof url === "string" && /^https?:\/\//.test(url) ? url : null;
  }

  function renderProject(container, slug) {
    const p = store.projects ? store.projects.find((x) => x.slug === slug) || null : null;
    const listing = store.projectFiles[slug];
    const actions = [];
    if (p && p.channelTitle) {
      const toSession = el("button", { class: "btn btn-ghost btn-sm", type: "button" }, [icon("message-square"), p.channelTitle]);
      toSession.addEventListener("click", () => SA.app.open("ch:" + p.channelId));
      actions.push(toSession);
    }
    const url = p ? pageUrl(p.url) : null;
    if (url) actions.push(el("a", { class: "btn btn-secondary btn-sm", href: url, target: "_blank", rel: "noreferrer" }, [icon("external-link"), "ページを開く"]));
    const head = toolbar("folder", slug, p && p.title !== slug ? [el("span", { class: "meta", text: p.title })] : [], actions);
    if (!listing) {
      container.replaceChildren(head, scroll([empty(null, "読み込んでいます…")]));
      return;
    }
    if (listing.missing) {
      container.replaceChildren(head, scroll([empty("folder", "このプロジェクトはありません（削除されたか、ディレクトリがありません）")]));
      return;
    }
    const files = listing.files;
    const sel = projectSel[slug] || (files.some((f) => f.path === "site/index.html") ? "site/index.html" : null);
    const shown = store.projectFile[slug];
    if (sel && (!shown || shown.path !== sel)) store.load.projectFile(slug, sel);
    const rows = files.map((f) => {
      const tr = el("tr", { class: "is-clickable" + (f.path === sel ? " is-selected" : ""), tabindex: "0", "aria-selected": String(f.path === sel) }, [
        td([icon("file"), " ", f.path], "td-main mono"),
        td(bytes(f.size), "td-num"),
        td(SA.ui.shortTime(f.mtime), "td-num"),
      ]);
      const pick = () => {
        projectSel[slug] = f.path;
        SA.app.refresh("project:" + slug);
      };
      tr.addEventListener("click", pick);
      tr.addEventListener("keydown", (e) => {
        if (e.key === "Enter") pick();
      });
      return tr;
    });
    let content = null;
    if (sel) {
      const current = shown && shown.path === sel ? shown : null;
      const text = !current || (current.text === null && current.error === null) ? "読み込んでいます…" : current.error ? projectFileError(current) : current.text;
      content = section(sel, [el("pre", { class: "code-pre", text })], [el("span", { class: "meta", text: "読むだけ" })]);
    }
    container.replaceChildren(
      head,
      scroll([
        el("p", {
          class: "meta",
          text: (p ? "更新 " + dateTime(p.updatedAt) + "・" : "") + "ページは別のオリジン（/p/" + slug + "/）なので、ここには埋め込まずリンクで開きます。",
        }),
        rows.length
          ? table(["ファイル", { text: "大きさ", cls: "td-num" }, { text: "更新", cls: "td-num" }], rows, "table-num")
          : empty("file", "ファイルはありません"),
        el("p", {
          class: "meta",
          text: (listing.truncated ? "一覧は 500 件・深さ 6 までです。" : "") + "ドットで始まるもの（.trash など）と node_modules は出しません。",
        }),
        content,
      ]),
    );
  }

  // ===== Claude Code のセッション（CC2: 見出しと画面の写し。CC3: 入力欄から送る・送信待ちの [取り消す]。CC4: 起動したもの・trust の確認待ち。CC5a: 許可のカード） =====
  const CC_STATES = { needs_input: "判断待ち", running: "実行中", idle: "待機" };
  /** 起動したもの（startedBy。owner は self-agent の外） */
  const CC_STARTED_BY = { web: "self-agent（Web）が起動", tool: "self-agent（Discord）が起動", github: "self-agent（GitHub）が起動" };
  const CC_SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

  /** 今から何秒前か（60 秒以上は ago と同じ「n 分前」など） */
  function secondsAgo(iso) {
    const ms = Date.now() - new Date(iso).getTime();
    if (!Number.isFinite(ms)) return "";
    return ms < 60000 ? Math.max(0, Math.floor(ms / 1000)) + " 秒前" : ago(iso);
  }

  /** 一覧の行の名前（名前が無ければディレクトリ） */
  function ccName(s) {
    return (s && (s.name || s.cwdLabel)) || "（名前なし）";
  }

  /** sessionId のセッション。タブで読んだもの（画面の写しを含む）があればそれ、無ければ一覧のもの */
  function ccSessionOf(sessionId) {
    const loaded = store.ccSessions[sessionId];
    if (loaded && loaded.session) return loaded.session;
    return store.cc ? store.cc.sessions.find((s) => s.sessionId === sessionId) || null : null;
  }

  /** RC のリンク（https://claude.ai/code/ のものだけ） */
  function rcUrl(url) {
    return typeof url === "string" && url.startsWith("https://claude.ai/code/") ? url : null;
  }

  /** Web から送る本文の上限（入力欄。サーバーは src/cc/sender.ts の CC_SEND_MAX_CHARS = 4,000 まで受ける） */
  const CC_MESSAGE_MAX = 2000;
  const CC_TOO_LONG_TEXT = "2,000 字までです";
  /** 送れなかったときのトースト（応答の error ごと）。無ければ「<status>: <error>」 */
  const CC_SEND_ERRORS = {
    already_queued: "送信待ちがあります。届くか取り消してから送ってください",
    not_in_tmux: "tmux の外のセッションには送れません。RC で開いてください",
    not_claude: "このペインは Claude Code ではないため送れません",
    no_server: "tmux が動いていません",
    tmux_failed: "tmux を読めませんでした",
    not_found: "このセッションは一覧にありません",
    too_long: "4,000 字までです",
    invalid_text: "改行のほかの制御文字（タブなど）は送れません",
    empty: "本文がありません",
    stopping: "再起動中です。終わったら送ってください",
  };
  /** 送信の状態の文（一覧の pending.state） */
  const CC_SEND_STATES = {
    awaiting_confirm: "Discord の確認を待っています",
    queued: "送信待ち（入力待ちになったら届けます）",
    delivering: "届けています…",
    delivered: "届けました",
    unconfirmed: "貼れたか・送れたかを確かめられませんでした。画面を確認してください（やり直しません）",
    failed: "送れませんでした（セッションが終わったか、tmux の中の Claude Code ではないか、起動したディレクトリの Claude Code ではありません）",
    gave_up: "入力待ちにならなかったため、届けるのを諦めました",
    cancelled: "取り消しました",
  };
  /** 書きかけ（このタブのメモリだけ。sessionId ごと） */
  const ccDrafts = {};

  /** 送信の状態の行。送信待ちなら [取り消す] */
  function ccPendingBar(sessionId, pending) {
    if (!pending || typeof pending.id !== "number") return null;
    // ダイアログ（trust・許可など）が出ている間は積んだまま待つ（再起動の後も、最後に見たペインの状態で分かる）
    const text =
      pending.state === "queued" && pending.lastPaneState === "dialog"
        ? "ダイアログが出ているため待っています（端末か RC で答えてください）"
        : CC_SEND_STATES[pending.state] || String(pending.state);
    const cls = pending.state === "delivered" ? " is-done" : pending.state === "unconfirmed" || pending.state === "failed" || pending.state === "gave_up" ? " is-warning" : "";
    const children = [el("span", { text: "送信 #" + pending.id + ": " + text })];
    if (pending.state === "queued" || pending.state === "delivering") children.unshift(el("span", { class: "spinner spinner-sm", "aria-hidden": "true" }));
    if (pending.state === "queued") {
      const cancel = el("button", { class: "btn btn-ghost btn-sm", type: "button", text: "取り消す" });
      cancel.addEventListener("click", () => {
        cancel.disabled = true;
        SA.api.post("/api/cc/sends/" + pending.id + "/cancel", {}, { quiet: true }).then(
          () => {
            toast("取り消しました");
            store.load.ccSession(sessionId);
          },
          (err) => {
            cancel.disabled = false;
            if (err && err.status === 409) toast("この操作は古くなっています（届けている途中か、終わっています）");
            else if (err && err.toast) toast(err.toast);
            store.load.ccSession(sessionId);
          },
        );
      });
      children.push(cancel);
    }
    return el("div", { class: "cc-send-state" + cls, "data-cc-pending": sessionId, "aria-live": "polite" }, children);
  }

  /** 入力欄（会話の入力欄と同じキー。chat.js の bindSendKeys）。描き直しでは作り直さない（書きかけ・フォーカス・IME の変換を保つ） */
  function ccComposer(sessionId, title) {
    const ta = el("textarea", {
      class: "textarea composer-input",
      rows: "3",
      maxlength: "4000",
      "aria-label": title + " に送る",
      enterkeyhint: "enter",
      "data-title": title,
      placeholder: SA.chat.placeholderOf(title),
    });
    ta.value = ccDrafts[sessionId] || "";
    const counter = el("span", { class: "counter", "aria-live": "polite" });
    const sendBtn = el("button", { class: "btn btn-primary btn-sm", type: "submit" }, [icon("send"), "送る"]);
    let sending = false;
    const lengthOf = () => [...ta.value.replace(/\n+$/, "")].length;
    const update = () => {
      const n = lengthOf();
      counter.textContent = n.toLocaleString("en-US") + " / 2,000";
      counter.classList.toggle("is-over", n > CC_MESSAGE_MAX);
      sendBtn.disabled = sending || ta.value.trim() === "";
    };
    update();
    ta.addEventListener("input", () => {
      if (ta.value) ccDrafts[sessionId] = ta.value;
      else delete ccDrafts[sessionId];
      update();
    });
    const submit = async () => {
      const text = ta.value;
      if (sending || text.trim() === "") return;
      if (lengthOf() > CC_MESSAGE_MAX) {
        toast(CC_TOO_LONG_TEXT);
        return;
      }
      sending = true;
      update();
      try {
        const data = await SA.api.post("/api/cc/sessions/" + encodeURIComponent(sessionId) + "/send", { text }, { quiet: true });
        if (ta.value === text) ta.value = "";
        if (ta.value) ccDrafts[sessionId] = ta.value;
        else delete ccDrafts[sessionId];
        // 届くまで送信の状態を出す（本物は次の読み直しで来る）
        const loaded = store.ccSessions[sessionId];
        if (loaded && loaded.session && data && typeof data.sendId === "number") loaded.session.pending = { id: data.sendId, state: data.state };
        SA.app.refresh("cc:" + sessionId);
        store.load.ccSession(sessionId);
        store.load.cc({ quiet: true });
      } catch (err) {
        // 本文は入力欄に残す
        if (err && err.toast) toast((err.code && CC_SEND_ERRORS[err.code]) || err.toast);
      } finally {
        sending = false;
        update();
      }
    };
    const form = el("form", { class: "composer", novalidate: true }, [
      ta,
      el("div", { class: "composer-foot" }, [
        el("span", { class: "composer-hint" }, [
          el("span", { text: "入力待ちのときに tmux で貼って Enter を押します。作業中なら入力待ちになるまで待ちます。改行もそのまま送ります。" }),
        ]),
        counter,
        sendBtn,
      ]),
    ]);
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      submit();
    });
    SA.chat.bindSendKeys(ta, submit);
    return el("div", { class: "composer-wrap", "data-cc": sessionId }, [form]);
  }

  // ----- 許可の要求（CC5a・CC5b）: 保留中なら [許可][このセッションでは常に許可（<ルール>）][拒否]（常に許可はルールがあるときだけ）、
  // 終わったものは終わり方。保留の間も端末・RC のダイアログは出ている -----
  /** 押した要求（応答が来るまでボタンを止める。このタブのメモリだけ） */
  const ccPermissionBusy = new Set();

  /** 終わった要求の文（state・via ごと） */
  function ccPermissionEndText(p) {
    const by = p.via === "discord" ? "（Discord）" : p.via === "web" ? "（Web）" : "";
    if (p.state === "allowed") return "許可しました" + by;
    if (p.state === "allowed_always") return "常に許可しました" + by;
    if (p.state === "denied") return "拒否しました" + by;
    if (p.state === "answered_elsewhere") return "端末か RC で答えられました";
    if (p.state === "expired") return "時間切れ。端末か RC で答えてください";
    if (p.state === "released" && p.via === "limit") return "要求が多すぎるため保留しませんでした。端末か RC で答えてください";
    if (p.state === "released") return "self-agent の再起動のため保留をやめました。端末か RC で答えてください";
    return String(p.state);
  }

  /** 保留の残り（m 分 s 秒）。過ぎていれば null */
  function remainingText(iso) {
    const ms = new Date(iso).getTime() - Date.now();
    if (!Number.isFinite(ms) || ms <= 0) return null;
    const sec = Math.ceil(ms / 1000);
    return (sec >= 60 ? Math.floor(sec / 60) + " 分 " : "") + (sec % 60) + " 秒";
  }

  function answerCcPermission(sessionId, p, decision) {
    if (ccPermissionBusy.has(p.id)) return;
    ccPermissionBusy.add(p.id);
    SA.app.refresh("cc:" + sessionId);
    SA.api.post("/api/cc/permissions/" + p.id + "/" + decision, { requestHash: p.requestHash }, { quiet: true }).then(
      () => toast(decision === "allow" ? "許可しました" : decision === "always" ? "このセッションでは常に許可しました" : "拒否しました"),
      (err) => {
        if (err && err.status === 409) toast("この操作は古くなっています（端末か RC で答えられたか、時間切れです）");
        else if (err && err.status === 404) toast("この要求はもうありません");
        else if (err && err.toast) toast(err.toast);
      },
    ).then(() => {
      ccPermissionBusy.delete(p.id);
      store.load.ccSession(sessionId);
      store.load.cc({ quiet: true });
    });
  }

  /** 許可のカード（要約・ツール名は hook から来たデータなので textContent で出す） */
  function ccPermissionCard(sessionId, p, rc) {
    if (!p || typeof p.id !== "number") return null;
    const pending = p.state === "pending";
    const left = pending ? remainingText(p.expiresAt) : null;
    const head = el("div", { class: "card-head" }, [
      el("h3", { text: pending ? "許可を待っています" : "許可の要求" }),
      el("span", { class: "meta", text: pending ? (left ? "残り " + left : "まもなく時間切れ") : ago(p.resolvedAt || p.createdAt) }),
    ]);
    const facts = [
      el("p", { class: "meta" }, [el("span", { class: "mono", text: String(p.toolName) }), p.permissionMode ? " ・ " + p.permissionMode : null]),
      el("pre", { class: "code-pre", text: String(p.summary || "") }),
    ];
    // 常に許可にすると加わるルール（保留中と、常に許可したものだけ）。ルール・意味は hook から来たデータなので textContent
    const rule = typeof p.alwaysRule === "string" && p.alwaysRule ? p.alwaysRule : null;
    if (rule && (pending || p.state === "allowed_always")) {
      facts.push(
        el("p", { class: "meta cc-permission-rule" }, [
          pending ? "常に許可にすると: " : "常に許可したルール: ",
          el("code", { class: "mono", text: rule }),
          typeof p.alwaysNote === "string" && p.alwaysNote ? "（" + p.alwaysNote + "）" : null,
        ]),
      );
    }
    if (!pending) {
      const end = [el("span", { text: ccPermissionEndText(p) })];
      if (rc && (p.state === "expired" || p.state === "released")) {
        end.push(" ", el("a", { href: rc, target: "_blank", rel: "noreferrer noopener", text: "RC で開く" }));
      }
      const cls = p.state === "allowed" || p.state === "allowed_always" ? " is-done" : p.state === "expired" || p.state === "released" ? " is-warning" : "";
      return el("section", { class: "card card-sm cc-permission" + cls, "aria-label": "許可の要求" }, [head, ...facts, el("p", { class: "cc-permission-end" }, end)]);
    }
    const busy = ccPermissionBusy.has(p.id);
    const allow = el("button", { class: "btn btn-primary btn-sm", type: "button", disabled: busy }, [icon("check"), "許可"]);
    const deny = el("button", { class: "btn btn-secondary btn-sm", type: "button", disabled: busy }, [icon("x"), "拒否"]);
    const always = rule
      ? el("button", { class: "btn btn-secondary btn-sm cc-permission-always", type: "button", disabled: busy }, [
          icon("check"),
          "このセッションでは常に許可（" + rule + "）",
        ])
      : null;
    allow.addEventListener("click", () => answerCcPermission(sessionId, p, "allow"));
    if (always) always.addEventListener("click", () => answerCcPermission(sessionId, p, "always"));
    deny.addEventListener("click", () => answerCcPermission(sessionId, p, "deny"));
    return el("section", { class: "card card-sm cc-permission is-pending", "aria-label": "許可の要求" }, [
      head,
      ...facts,
      el("div", { class: "msg-actions" }, [allow, always, deny].filter((x) => x)),
      el("p", {
        class: "meta",
        text: "端末や RC のダイアログでも答えられます（先に答えた方が効きます）。[常に許可] は Claude Code が規則を提案したときだけ出ます。",
      }),
    ]);
  }

  function renderCcSession(container, sessionId) {
    const loaded = store.ccSessions[sessionId];
    const s = ccSessionOf(sessionId);
    const rc = s ? rcUrl(s.rcUrl) : null;
    const actions = rc ? [el("a", { class: "btn btn-secondary btn-sm", href: rc, target: "_blank", rel: "noreferrer noopener" }, [icon("external-link"), "RC で開く"])] : [];
    const extras = s ? [el("span", { class: "badge" + (s.state === "needs_input" ? " badge-accent" : ""), text: CC_STATES[s.state] || String(s.state) })] : [];
    const head = toolbar("terminal", s ? ccName(s) : "Claude Code", extras, actions);
    if (loaded && loaded.missing) {
      container.replaceChildren(head, scroll([empty("terminal", "このセッションは一覧にありません（終わったか、一覧を読めません）")]));
      return;
    }
    if (!s) {
      container.replaceChildren(head, scroll([empty(null, "読み込んでいます…")]));
      return;
    }
    const facts = el("ul", { class: "kv-list" }, [
      kv("ディレクトリ", el("span", { class: "mono", text: s.cwdLabel || "-" })),
      kv(
        "状態",
        (CC_STATES[s.state] || String(s.state)) +
          (s.state === "needs_input" && s.waitingFor ? "・" + s.waitingFor : "") +
          (s.since ? "（" + ago(s.since) + "から）" : ""),
      ),
      kv("権限モード", el("span", { class: "mono", text: s.permissionMode || "-" })),
      kv("ペイン", s.inTmux && s.paneLabel ? el("span", { class: "mono", text: s.paneLabel }) : "tmux の外"),
      kv("最後の指示", s.lastPromptAt ? dateTime(s.lastPromptAt) + "（" + ago(s.lastPromptAt) + "）" : "-"),
      ...(CC_STARTED_BY[s.startedBy] ? [kv("起動", CC_STARTED_BY[s.startedBy])] : []),
    ]);
    // trust のダイアログ（self-agent はキーを送らない。§4.2）
    const trust = s.trustPending
      ? el("p", {
          class: "alert",
          role: "status",
          text: "新しいディレクトリでは trust の確認が出ています。端末か RC で「Yes, I trust this folder」を選んでください。最初の指示はその後に届けます。",
        })
      : null;
    const prompt = s.lastPromptText ? el("pre", { class: "code-pre", text: s.lastPromptText }) : null;
    let screen;
    if (!loaded || !loaded.session) screen = el("p", { class: "meta", text: "読み込んでいます…" });
    else if (!s.inTmux) {
      screen = el("p", { class: "meta", text: "tmux の外のセッションです。画面は見られません" + (rc ? "。RC で開いてください。" : "。") });
    } else if (typeof s.screen !== "string") screen = el("p", { class: "meta", text: "画面を読めませんでした" });
    else screen = el("pre", { class: "code-pre cc-screen", text: s.screen });
    // 許可のカードは見出しの下に固定する（画面の写しは下に付けて読むので、中に入れると見えなくなる）
    const card = ccPermissionCard(sessionId, s.permission, rc);
    const permission = card ? el("div", { class: "cc-permission-wrap" }, [card]) : null;
    const body = scroll([
      section("セッション", [trust, facts, prompt].filter((x) => x)),
      section("画面", [screen], [el("span", { class: "meta", text: "3 秒ごとに更新" })]),
    ]);
    // 画面の写しは最後の行（入力欄）を見たいので、下にいれば下に付ける
    body.dataset.stick = "bottom";
    const pending = ccPendingBar(sessionId, s.pending);
    // tmux の外には送れないので入力欄を出さない
    if (!s.inTmux) {
      container.replaceChildren(...[head, permission, body, pending].filter((x) => x));
      return;
    }
    // 入力欄は作り直さない。見出し・許可のカード・中身・送信の状態だけを入れ替える
    const kept = [...container.children].find((child) => child.classList.contains("composer-wrap") && child.getAttribute("data-cc") === sessionId);
    if (kept) {
      for (const child of [...container.children]) if (child !== kept) child.remove();
      for (const node of [head, permission, body, pending]) if (node) container.insertBefore(node, kept);
    } else {
      container.replaceChildren(...[head, permission, body, pending].filter((x) => x), ccComposer(sessionId, ccName(s)));
    }
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
    if (typeof item.updatedAt === "string" && item.updatedAt > entry.updatedAt && store.kbRetryFailed[item.id] !== item.updatedAt) {
      store.load.kbEntry(item.id, true, item.updatedAt);
    }
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
    ["Enter / Shift+Enter", "送る / 改行（タッチの端末では Enter で改行）"],
    ["Ctrl+Enter / ⌘+Enter", "送る"],
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
   * 知らない・無効な機能のタブは null（開かない）。会話は ch:<チャンネル ID>、プロジェクトは project:<slug>、Claude Code は cc:<sessionId>。
   * 会話ログ・GitHub・Claude Code は /api/status を読んで dev モード・GitHub・Claude Code の連携が有効と分かるまで開かない
   */
  function info(tabId) {
    if (tabId.startsWith("ch:")) {
      const channelId = tabId.slice(3);
      return /^\d{1,25}$/.test(channelId) ? SA.chat.info(channelId) : null;
    }
    if (tabId.startsWith("project:")) {
      const slug = tabId.slice(8);
      if (!/^[a-z0-9-]{1,30}$/.test(slug)) return null;
      return {
        title: slug,
        icon: "folder",
        render: (container) => renderProject(container, slug),
        // 前に出すたびに一覧と、選んでいるファイルの中身を読み直す
        onOpen: () => {
          delete store.projectFile[slug];
          store.load.projects();
          store.load.projectFiles(slug);
        },
        onClose: () => {
          delete projectSel[slug];
          delete store.projectFile[slug];
          delete store.projectFiles[slug];
        },
      };
    }
    if (tabId.startsWith("cc:")) {
      const sessionId = tabId.slice(3);
      if (!CC_SESSION_ID.test(sessionId) || !store.ccEnabled()) return null;
      const s = ccSessionOf(sessionId);
      return {
        title: s ? ccName(s) : "Claude Code",
        icon: "terminal",
        render: (container) => renderCcSession(container, sessionId),
        // 前に出すたびに画面の写しと一覧を読み直す（その後は api.js の polling）
        onOpen: () => {
          store.load.ccSession(sessionId);
          store.load.cc();
          SA.poll.kickCc();
        },
        onClose: () => {
          delete store.ccSessions[sessionId];
        },
      };
    }
    if (tabId === "devlog" && !(store.status && store.status.devMode)) return null;
    if (tabId === "github" && !(store.status && store.status.github && store.status.github.enabled)) return null;
    return Object.prototype.hasOwnProperty.call(STATIC, tabId) ? STATIC[tabId] : null;
  }

  /** /api/status を読むまで開けるか分からないタブ（読んだ後に開き直す） */
  function waitsForStatus(tabId) {
    return (tabId === "devlog" || tabId === "github" || tabId.startsWith("cc:")) && store.status === null;
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
    ccName,
    ago,
    secondsAgo,
    compact,
    dayLabel,
    overdue,
    oneLine,
    todayTokens,
  };
})();
