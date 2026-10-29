// タブの中身: 状態・使用量・設定・ようこそ（W1）。会話・タスクなどは後の段で足す
"use strict";

(function () {
  const SA = (window.SA = window.SA || {});
  const { el, icon, count } = SA.ui;
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
        el("thead", {}, [el("tr", {}, headers.map((h) => el("th", { scope: "col", class: h.cls || null, text: h.text || h })))]),
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

  /** ISO の時刻 → このブラウザの時刻で 10/27(火) 4:12 */
  function dateTime(iso) {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return "-";
    return d.getMonth() + 1 + "/" + d.getDate() + "(" + WEEKDAYS[d.getDay()] + ") " + d.getHours() + ":" + String(d.getMinutes()).padStart(2, "0");
  }

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
    let text = "有効";
    if (g.lastFetchAt) text += "・最後の取得 " + SA.ui.hm(new Date(g.lastFetchAt));
    if (g.failure) text += "・失敗: " + g.failure;
    return text;
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
  };

  /** 知らない・無効な機能のタブは null（開かない） */
  function info(tabId) {
    return Object.prototype.hasOwnProperty.call(STATIC, tabId) ? STATIC[tabId] : null;
  }

  SA.views = { info, renderWelcome, selectUsageDate, usageDate: () => usageState.date, compact, dayLabel, todayTokens };
})();
