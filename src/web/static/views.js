// タブの中身: 状態・使用量・設定・ようこそ（W1）・会話ログ（W2。会話のタブは chat.js）・タスク・リマインド・記憶（W4）・GitHub・ナレッジ（W6）・
// プロジェクト（W7。読むだけ）・Claude Code のセッション（CC2 の画面の写しと CC3 の送信と CC5a の許可のカード）。ジョブは後の段で足す
"use strict";

(function () {
  const SA = (window.SA = window.SA || {});
  const { el, icon, count, toast, confirm } = SA.ui;
  const store = SA.store;

  const WEEKDAYS = ["日", "月", "火", "水", "木", "金", "土"];

  function toolbar(iconName, title, extras, actions, cls) {
    return el("header", { class: "ed-toolbar" + (cls ? " " + cls : "") }, [
      el("div", { class: "ed-title" }, [SA.ui.backButton(), icon(iconName), el("h1", { text: title }), ...(extras || [])]),
      el("div", { class: "ed-actions" }, actions || []),
    ]);
  }

  function scroll(children, cls) {
    return el("div", { class: "ed-scroll" + (cls ? " " + cls : "") }, [el("div", { class: "ed-page" }, children)]);
  }

  function section(title, children, extras) {
    return el("section", { class: "ed-section" }, [el("div", { class: "ed-section-head" }, [el("h2", { text: title }), ...(extras || [])]), ...children]);
  }

  /**
   * 表。opts.stack なら ≤639px で行の積み（tr を grid にし、th は隠す。各 td の置き場所は表の class ごとに app.css の grid-area で決める）。
   * 積んだ行では見出しが見えないので、2 行目の値には label() の語を添える
   */
  function table(headers, rows, cls, opts) {
    const stack = !!(opts && opts.stack);
    return el("div", { class: "table-wrap" + (stack ? " table-wrap-stack" : "") }, [
      el("table", { class: "table" + (stack ? " table-stack" : "") + (cls ? " " + cls : "") }, [
        el("thead", {}, [el("tr", {}, headers.map((h) => el("th", { scope: "col", class: h.cls || null, "aria-label": h.label || null, text: typeof h === "string" ? h : h.text })))]),
        el("tbody", {}, rows),
      ]),
    ]);
  }

  function td(content, cls) {
    return el("td", { class: cls || null }, Array.isArray(content) ? content : [content]);
  }

  /** 積んだ行（≤639px）でだけ出す値の前の語（「期限 」など。≥640px は表の見出しがあるので出さない） */
  function label(text) {
    return el("span", { class: "td-label show-sm", text: text + " " });
  }

  /** 空の表示（何が無いか・次にすること。GUIDELINES §5）。retry があれば [読み直す]（読めなかったとき） */
  function empty(iconName, text, retry) {
    let again = null;
    if (retry) {
      again = el("button", { class: "btn btn-ghost btn-sm", type: "button", text: "読み直す" });
      again.addEventListener("click", retry);
    }
    return el("div", { class: "empty" }, [iconName ? icon(iconName) : null, el("p", { text }), again]);
  }

  /** 読み込み中（枠も余白も無い文だけ。読めた瞬間に跳ばないよう .empty を流用しない。GUIDELINES §5） */
  function loading() {
    return el("p", { class: "loading", "aria-busy": "true", text: "読み込んでいます…" });
  }

  /** 権限モードの表示（識別子は値として残し、説明を添える。GUIDELINES §5 チェック・選択）。知らないものは識別子だけ */
  const PERMISSION_MODES = {
    default: "default（使うたびに確認）",
    acceptEdits: "acceptEdits（編集は確認なし）",
    plan: "plan（計画だけ）",
    auto: "auto（自動で判断）",
    dontAsk: "dontAsk（確認せずに拒否）",
    bypassPermissions: "bypassPermissions（確認なし）",
  };

  function permissionModeText(mode) {
    return Object.prototype.hasOwnProperty.call(PERMISSION_MODES, mode) ? PERMISSION_MODES[mode] : String(mode);
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
      container.replaceChildren(
        head,
        scroll([failed ? empty(null, "使用量を読み込めませんでした。", () => store.load.usage(usageState.date)) : loading()]),
      );
      return;
    }
    // 人格ごとの行の表（GUIDELINES §5 使用量の数字）。キャッシュ率だけ大きく。≤639px は人格ごとのブロック（1 行目に名前とキャッシュ率、
    // 2 行目にターン・入力・出力）で、失敗の列を隠してターンの後に添える
    const personas = (u.totals || []).map((t) => {
      const s = t.summary || {};
      const input = inputOf(s.inputTokens, s.cacheReadInputTokens, s.cacheCreationInputTokens);
      const failedTurns = s.failedTurns > 0 ? s.failedTurns : 0;
      return el("tr", {}, [
        td(t.name, "td-main"),
        td([label("ターン"), String(s.turns ?? 0), failedTurns > 0 ? el("span", { class: "show-sm", text: "（失敗 " + failedTurns + "）" }) : null], "td-num td-turns"),
        td(failedTurns > 0 ? String(failedTurns) : "", "td-num hide-sm"),
        td([label("入力"), count(input)], "td-num td-input"),
        td([label("出力"), count(t.outputTokens)], "td-num td-output"),
        td(rate(s.cacheReadInputTokens, input), "td-num td-rate"),
      ]);
    });
    const totals = table(
      [
        "人格",
        { text: "ターン", cls: "td-num" },
        { text: "失敗", cls: "td-num hide-sm" },
        { text: "入力", cls: "td-num" },
        { text: "出力", cls: "td-num" },
        { text: "キャッシュ率", cls: "td-num" },
      ],
      personas,
      "table-num table-personas",
      { stack: true },
    );
    // ターンの表。≤639px は行の積み（1 行目: 時刻・種類・結果、2 行目: 入力・出力・率）にし、ツール・読み・書きは出さない（GUIDELINES §4）
    const rows = (u.rows || []).map((r) => {
      const input = inputOf(r.inputTokens, r.cacheReadInputTokens, r.cacheCreationInputTokens);
      return el("tr", {}, [
        td(SA.ui.clock(new Date(r.at)), "td-num td-time"),
        td(r.kind || "-", "td-kind-name"),
        td(r.ok ? "成功" : "失敗", "td-result" + (r.ok ? "" : " is-overdue")),
        td(String(r.toolCalls ?? 0), "td-num hide-sm"),
        td([label("入力"), count(input)], "td-num td-input"),
        td(count(r.cacheReadInputTokens), "td-num hide-sm"),
        td(count(r.cacheCreationInputTokens), "td-num hide-sm"),
        td([label("出力"), count(r.outputTokens)], "td-num td-output"),
        td([label("率"), rate(r.cacheReadInputTokens, input)], "td-num td-turn-rate"),
      ]);
    });
    const turns =
      rows.length === 0
        ? empty("bar-chart", "この日のターンはありません。日付を変えると別の日を見られます。")
        : table(
            [
              "時刻",
              "種類",
              "結果",
              { text: "ツール", cls: "td-num hide-sm" },
              { text: "入力", cls: "td-num" },
              { text: "読み", cls: "td-num hide-sm" },
              { text: "書き", cls: "td-num hide-sm" },
              { text: "出力", cls: "td-num" },
              { text: "率", cls: "td-num" },
            ],
            rows,
            "table-num table-turns",
            { stack: true },
          );
    const att = u.attachments || {};
    container.replaceChildren(
      head,
      scroll([
        totals,
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
      container.replaceChildren(
        toolbar("file-text", "会話ログ", [], [chips]),
        scroll([failed ? empty(null, "会話ログを読み込めませんでした。", () => store.load.devlog(devlogState.date)) : loading()]),
      );
      return;
    }
    // 新しい順に並べる（API は古い順）
    const records = (Array.isArray(data.records) ? data.records : []).filter((r) => devlogState.kind === "all" || r.kind === devlogState.kind).reverse();
    devlogState.selected = Math.min(devlogState.selected, Math.max(0, records.length - 1));
    const list = el("ul", { class: "master-list", role: "listbox", "aria-label": "ターン" });
    records.forEach((r, i) => {
      const item = el("li", { role: "option", "aria-selected": String(i === devlogState.selected), tabindex: "0", class: "master-item" }, [
        el("span", { class: "master-title" }, [el("span", { class: "dot " + (r.ok ? "dot-ok" : "dot-bad"), "aria-hidden": "true" }), SA.ui.clock(new Date(r.at)) + " " + devlogLabel(r)]),
        el("span", { class: "meta", text: SA.ui.elapsed(r.durationMs || 0) + "・ツール " + (r.toolCalls ?? 0) + " 回" + (r.ok ? "" : "（失敗）") }),
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
    const detail = current
      ? el("pre", { class: "code-pre", text: current.text })
      : empty(
          null,
          data.records && data.records.length > 0
            ? "この種類のターンはありません。種類を「全部」に戻すと出ます。"
            : "この日の記録はありません。日付を変えると別の日を見られます。",
        );
    container.replaceChildren(
      toolbar("file-text", "会話ログ", [el("span", { class: "meta", text: dayLabel(data.date) + "・dev モード" })], [chips]),
      el("div", { class: "master-detail" }, [el("div", { class: "master" }, [list]), el("div", { class: "detail" }, [detail])]),
    );
  }

  // ===== タスク・リマインド・記憶の操作（W4） =====
  /**
   * 操作が通らなかったとき: 404・409 は「古くなっています」、それ以外は request の文を失敗のトースト（消えない。retry があれば [もう一度]）で。
   * どちらも一覧を読み直す
   */
  function failed(err, key, retry) {
    const stale = err && (err.status === 404 || err.status === 409);
    if (stale) toast("この操作は古くなっています");
    else toast((err && err.toast) || "操作に失敗しました。もう一度試してください", null, { level: "error", retry });
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
        // チェックで押したもの（タスクの完了）は、通らなければチェックを外す
        if (button && button.type === "checkbox") button.checked = false;
        failed(err, key, () => act(null, path, key, then));
      },
    );
  }

  // ===== タスク（W4: 一覧と [完了]・トーストの [取り消す]） =====
  const TASK_STATUSES = [
    ["open", "未完了"],
    ["done", "完了"],
    ["dropped", "やめた"],
  ];

  /** 状態ごとの空の表示 */
  const TASK_EMPTY = {
    open: "未完了のタスクはありません。会話で「やることに足して」と頼むと増えます。",
    done: "完了したタスクはありません。",
    dropped: "やめたタスクはありません。",
  };

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
      container.replaceChildren(head, scroll([loading()]));
      return;
    }
    // 行の操作は 1 つ（完了はチェック。GUIDELINES §5 一覧の行）。id は題名の下の補足、空のセルは空のまま
    const open = shown === "open";
    const rows = store.tasks.tasks.map((t) => {
      const late = overdue(t);
      const due = t.due === null ? "" : dayLabel(t.due) + (late ? "・過ぎています" : "");
      const cells = [];
      if (open) {
        const done = el("input", { type: "checkbox", "aria-label": "「" + t.title + "」を完了にする" });
        done.addEventListener("change", () => {
          if (done.checked) completeTask(done, t);
        });
        // 当たりは ≤639px で行の高さ・幅 48px（行のタップでは完了にしない。戻せるが誤操作が多い）
        cells.push(el("td", { class: "td-check" }, [el("label", { class: "check check-sm" }, [done])]));
      }
      const closed = (t.status === "done" ? "完了 " : "やめた ") + (t.completedAt ? dateOf(t.completedAt) : "-");
      cells.push(
        td([el("span", { class: "td-title", text: t.title }), el("span", { class: "meta td-sub", text: "#" + t.id })], "td-main"),
        td(due ? [label("期限"), due] : "", "td-due" + (late ? " is-overdue" : "")),
        td(open ? (t.remind ? [label("知らせ"), dateTime(t.remind)] : "") : closed, "td-remind"),
      );
      return el("tr", { "data-task": String(t.id) }, cells);
    });
    const body =
      rows.length === 0
        ? empty("square-check", TASK_EMPTY[shown] || "タスクはありません。")
        : table([...(open ? [{ text: "", cls: "th-check", label: "完了" }] : []), "題名", "期限", open ? "知らせ" : "閉じた日"], rows, "table-tasks", { stack: true });
    container.replaceChildren(head, scroll([body]));
  }

  // ===== リマインド（W4: 止める・次を飛ばす） =====
  /** 一覧・確認のダイアログに出すリマインドの text（改行を空白に） */
  function oneLine(text) {
    return String(text).replace(/\s*[\r\n]+\s*/g, " ");
  }

  function renderReminders(container) {
    const list = store.reminders;
    if (!list) {
      container.replaceChildren(toolbar("bell", "リマインド"), scroll([loading()]));
      return;
    }
    const rows = list.map((r) => {
      // [止める]（戻せない）は [次を飛ばす] から離して右端に（GUIDELINES §4・§5 一覧の行）
      const actions = el("div", { class: "td-apart" });
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
          title: "止めますか",
          target: r.text,
          body: "止めたリマインドは戻せません。",
          ok: "止める",
          danger: true,
          run: () =>
            act(stop, "/api/reminders/" + r.id + "/cancel", "reminders", () => {
              toast("「" + oneLine(r.text) + "」を止めました");
            }),
        }),
      );
      actions.append(stop);
      return el("tr", {}, [
        td(r.nextAt ? dateTime(r.nextAt) : "-", "td-nowrap td-next"),
        td([r.kind === "prompt" ? el("span", { class: "badge badge-accent", text: "依頼" }) : null, r.kind === "prompt" ? " " : null, oneLine(r.text)], "td-main"),
        // 種類はサイドバーと同じアイコン（繰り返しは rotate-ccw、1 回だけは clock）
        td(el("span", {}, [icon(r.rule === null ? "clock" : "rotate-ccw"), r.rule === null ? "1 回だけ" : r.ruleText || r.rule]), "td-kind"),
        td(r.channelName || "", "td-place"),
        td(actions, "td-actions"),
      ]);
    });
    const body =
      rows.length === 0
        ? empty("bell", "動いているリマインドはありません。会話で「明日 9 時に知らせて」と頼むと増えます。")
        : table(["次の時刻", "内容", "繰り返し", "頼んだ場所", { text: "", cls: "th-actions" }], rows, "table-reminders", { stack: true });
    container.replaceChildren(toolbar("bell", "リマインド", [el("span", { class: "meta", text: list.length + " 件" })]), scroll([body]));
  }

  // ===== 記憶（W4: 一覧と [忘れる]・トーストの [取り消す]） =====
  function renderMemories(container) {
    const list = store.memories;
    if (!list) {
      container.replaceChildren(toolbar("book", "記憶"), scroll([loading()]));
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
        rows.length
          ? table(["#", "記憶", "保存", { text: "", cls: "th-actions" }], rows)
          : empty(null, "記憶はありません。会話で「覚えておいて」と頼むと増えます。"),
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
    auth: "gh の認証が通りません",
    rate_limited: "レート制限",
    forbidden: "GitHub に拒否されました",
    network: "通信の失敗",
    shape: "応答の形が違います",
    no_gh: "gh が見つかりません",
  };

  function githubFailureText(kind) {
    return Object.prototype.hasOwnProperty.call(GITHUB_FAILURES, kind) ? GITHUB_FAILURES[kind] : String(kind);
  }

  /** 取得の状態の 1 行（最後の取得・失敗。止めている間は失敗の後の括弧に。「・」は 2 要素まで） */
  function githubFetchLine(g) {
    const parts = [g && g.lastFetchAt ? "最後の取得 " + SA.ui.shortTime(g.lastFetchAt) : "まだ取得していません"];
    const paused = g && g.pausedUntil ? SA.ui.shortTime(g.pausedUntil) + " まで止めています" : null;
    if (g && g.failure) parts.push("失敗: " + githubFailureText(g.failure) + (paused ? "（" + paused + "）" : ""));
    else if (paused) parts.push(paused);
    return parts.join("・");
  }

  /** [対応] と [起動して送る] の結果（サーバーの文をトーストに。積んだら [やめる]、セッションが無ければ起動の確認） */
  function githubHandoffDone(n, data) {
    const text = data && typeof data.text === "string" ? data.text : "送りました";
    if (data && data.result === "no_session" && data.startable === true) {
      confirm({
        title: "Claude Code を起動して送りますか",
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
            label: "やめる",
            run: () => cancelCcSend(sendId, null, null),
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
        failed(err, "github", () => githubHandoff(null, n, action));
      },
    );
  }

  function githubItem(n) {
    const parts = githubParts(n.url);
    const title = (n.label ? n.label + ": " : "") + (n.title || "（題名なし）") + (parts ? " #" + parts.number : "");
    // 補足の「・」は 2 要素まで（GUIDELINES §7）。リポジトリ・人と、時刻・注記を 2 つの span に分ける
    const who = [parts ? parts.repo : null, n.actorLogin].filter((v) => v);
    const when = [SA.ui.shortTime(n.updatedAt), n.actorKnown ? null : "誰の操作か確かめられませんでした"].filter((v) => v);
    return el("li", { class: "row-list-item" }, [
      el("span", { class: "dot " + (n.level === "red" ? "dot-bad" : "dot-warn"), "aria-hidden": "true" }),
      el("div", { class: "item-main" }, [
        el("span", { class: "item-title", text: title }),
        who.length ? el("span", { class: "meta", text: who.join("・") }) : null,
        el("span", { class: "meta", text: when.join("・") }),
      ]),
      parts ? el("a", { class: "btn btn-ghost btn-sm", href: n.url, target: "_blank", rel: "noreferrer noopener" }, [icon("external-link"), "GitHub"]) : null,
      githubActButton(n),
    ]);
  }

  /** [対応]。使えないもの（送り込みが無効・自分のでも地図にも無いリポジトリ）は押せない */
  function githubActButton(n) {
    const attrs = { class: "btn btn-secondary btn-sm", type: "button", text: "対応" };
    if (!n.handoff) {
      attrs.disabled = true;
      attrs.title =
        store.github && store.github.handoff
          ? "この通知は送れません。この機械に無いリポジトリか、[対応] を足す前の通知です"
          : "Claude Code の連携が無効です（設定で有効にできます）";
      return el("button", attrs);
    }
    attrs.title = "このリポジトリの Claude Code のセッションに対応依頼（リポジトリ、番号、URL の 1 行）を送ります。セッションが無ければ起動するか確かめます";
    const button = el("button", attrs);
    button.addEventListener("click", () => githubHandoff(button, n, "act"));
    return button;
  }

  function renderGithub(container) {
    const data = store.github;
    if (!data) {
      container.replaceChildren(toolbar("git-pull-request", "GitHub の通知"), scroll([loading()]));
      return;
    }
    const group = (level, title) => {
      const items = data.notifications.filter((n) => n.level === level);
      return section(
        title,
        [items.length ? el("ul", { class: "row-list" }, items.map(githubItem)) : el("p", { class: "meta", text: "ありません。" })],
        [el("span", { class: "meta", text: items.length + " 件" })],
      );
    };
    container.replaceChildren(
      toolbar("git-pull-request", "GitHub の通知", [], [el("span", { class: "meta", text: githubFetchLine(data.status) })]),
      scroll([
        group("red", "自分宛て"),
        group("yellow", "自分のリポジトリの新しい Issue / PR"),
      ]),
    );
  }

  // ===== プロジェクト（W7: ファイルの一覧と、選んだファイルの中身を読むだけ。ページはリンクで開く） =====
  /** slug → 選んだファイルのパス（無ければ site/index.html があればそれ） */
  const projectSel = {};
  const PROJECT_FILE_ERRORS = {
    not_found: "ファイルがありません。消えたか、移されました。",
    too_large: "256 KB を超えるため表示しません。",
    binary: "テキストではないため表示しません。",
    invalid_path: "このファイルは表示できません。",
  };

  /** 読めなかったときの文。too_large は応答の上限（maxBytes）があればその大きさで */
  function projectFileError(current) {
    if (current.error === "too_large" && current.maxBytes) {
      const limit = current.maxBytes % 1024 === 0 ? current.maxBytes / 1024 + " KB" : bytes(current.maxBytes);
      return limit + " を超えるため表示しません。";
    }
    return PROJECT_FILE_ERRORS[current.error] || "このファイルを読み込めませんでした。";
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
    if (url) {
      actions.push(
        el("a", { class: "btn btn-secondary btn-sm", href: url, target: "_blank", rel: "noreferrer", title: "ページは別のオリジン（/p/" + slug + "/）なので、埋め込まずに開きます" }, [
          icon("external-link"),
          "ページを開く",
        ]),
      );
    }
    const head = toolbar("folder", slug, p && p.title !== slug ? [el("span", { class: "meta", text: p.title })] : [], actions);
    if (!listing) {
      container.replaceChildren(head, scroll([loading()]));
      return;
    }
    if (listing.missing) {
      container.replaceChildren(head, scroll([empty("folder", "このプロジェクトはありません。削除されたか、ディレクトリが消えています。")]));
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
        p ? el("p", { class: "meta", text: "更新 " + dateTime(p.updatedAt) }) : null,
        rows.length
          ? table(["ファイル", { text: "大きさ", cls: "td-num" }, { text: "更新", cls: "td-num" }], rows, "table-num")
          : empty("file", "ファイルはありません（ドットで始まるものと node_modules は出しません）。会話でページを作ると増えます。"),
        listing.truncated ? el("p", { class: "meta", text: "一覧は 500 件・深さ 6 までです。" }) : null,
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
  /** 送れなかったときのトースト（応答の error ごと）。無ければ api.js の「操作に失敗しました。…」 */
  const CC_SEND_ERRORS = {
    already_queued: "届け待ちの本文があります。届くか、やめてから送ってください",
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
  /** 送った本文の状態の文（一覧の pending.state） */
  const CC_SEND_STATES = {
    awaiting_confirm: "Discord の確認を待っています",
    queued: "届け待ち。入力待ちになったら届けます",
    delivering: "届けています…",
    delivered: "届けました",
    unconfirmed: "届いたかを確かめられませんでした。画面で確かめてください。やり直しはしません",
    failed: "送れませんでした。セッションが終わったか、別の Claude Code に変わっています",
    gave_up: "入力待ちにならなかったため、届けるのをやめました",
    cancelled: "送るのをやめました",
  };
  /** 届けた送信に返事が来たか（一覧の pending.replyState。CC8） */
  const CC_REPLY_STATES = {
    waiting: "返事を待っています",
    posted: "返事が来ました",
    unreadable: "終わりました（返事を読めませんでした）",
    timed_out: "返事が来ませんでした（中断されたか、24 時間経ちました）",
  };
  /** 書きかけ（このタブのメモリだけ。sessionId ごと） */
  const ccDrafts = {};

  /** 返事の追いかけ（CC8）。追いかけ中なら [追いかけをやめる]（Discord の返事の投稿のボタンと同じ） */
  function ccFollowFact(sessionId, s) {
    if (!s.follow) return kv("返事", "Discord には戻していません（Discord から頼むと戻します）");
    const stop = el("button", { class: "btn btn-ghost btn-sm", type: "button", text: "追いかけをやめる" });
    stop.addEventListener("click", () => unfollowCc(sessionId, stop));
    const since = s.follow.since ? "（" + ago(s.follow.since) + "から）" : "";
    return kv("返事", el("span", {}, ["Discord に戻しています" + since + " ", stop]));
  }

  /** チャンネルを作れなかったときのトースト（応答の error ごと。CC10） */
  const CC_CHANNEL_ERRORS = {
    not_in_tmux: "tmux の外のセッションにはチャンネルを作れません",
    full: "カテゴリ「Claude Code」が満杯（50）です。完了したチャンネルを消してください",
    not_set_up: "カテゴリ「Claude Code」がありません。Discord で /setup を実行してください",
    not_found: "このセッションは一覧にありません",
    failed: "チャンネルを作れませんでした",
  };

  /**
   * Discord のチャンネル（CC10）。あればリンク、無ければ [Discord のチャンネルを作る]（tmux の中だけ）。
   * /setup 済みのサーバーが複数なら、作る先を選ぶ
   */
  function ccChannelFact(sessionId, s) {
    if (s.channel && typeof s.channel.link === "string" && s.channel.link.startsWith("https://discord.com/channels/")) {
      const link = el("a", { href: s.channel.link, target: "_blank", rel: "noreferrer noopener", text: "チャンネルを開く" });
      return kv("Discord", el("span", {}, [(s.channel.state === "ended" ? "完了に移しています" : "チャンネルがあります") + " ", link]));
    }
    if (!s.inTmux) return kv("Discord", "tmux の外のため、チャンネルは作れません");
    const guilds = store.channels ? store.channels.guilds.filter((g) => g.setUp) : [];
    const pick = guilds.length > 1 ? el("select", { class: "select select-sm", "aria-label": "作るサーバー" }, guilds.map((g) => el("option", { value: g.id, text: g.id }))) : null;
    const create = el("button", { class: "btn btn-secondary btn-sm", type: "button", text: "Discord のチャンネルを作る" });
    create.addEventListener("click", () => createCcChannel(sessionId, pick ? pick.value : null, create));
    return kv("Discord", el("span", {}, [...(pick ? [pick, " "] : []), create]));
  }

  /** [Discord のチャンネルを作る]。guildId は選んだサーバー（null ならサーバーが決める）。button は押したもの（[もう一度] からは null） */
  function createCcChannel(sessionId, guildId, button) {
    if (button) button.disabled = true;
    const body = guildId ? { guildId } : {};
    SA.api.post("/api/cc/sessions/" + encodeURIComponent(sessionId) + "/channel", body, { quiet: true }).then(
      () => {
        toast("Discord のチャンネルを作りました");
        store.load.ccSession(sessionId);
      },
      (err) => {
        if (button) button.disabled = false;
        if (err && err.code === "exists") toast("このセッションのチャンネルは既にあります");
        else if (err && CC_CHANNEL_ERRORS[err.code]) toast(CC_CHANNEL_ERRORS[err.code], null, { level: "error" });
        else if (err && err.toast) toast(err.toast, null, { level: "error", retry: () => createCcChannel(sessionId, guildId, null) });
        store.load.ccSession(sessionId);
      },
    );
  }

  /** [追いかけをやめる]。button は押したもの（[もう一度] からは null） */
  function unfollowCc(sessionId, button) {
    if (button) button.disabled = true;
    SA.api.post("/api/cc/sessions/" + encodeURIComponent(sessionId) + "/unfollow", {}, { quiet: true }).then(
      () => {
        toast("追いかけをやめました");
        store.load.ccSession(sessionId);
      },
      (err) => {
        if (button) button.disabled = false;
        if (err && err.status === 409) toast("この操作は古くなっています");
        else if (err && err.toast) toast(err.toast, null, { level: "error", retry: () => unfollowCc(sessionId, null) });
        store.load.ccSession(sessionId);
      },
    );
  }

  /** 届け待ちを取り下げる（[やめる]）。sessionId があれば終わった後にそのセッションを読み直す。button は押したもの（[もう一度] からは null） */
  function cancelCcSend(sendId, sessionId, button) {
    if (button) button.disabled = true;
    SA.api.post("/api/cc/sends/" + sendId + "/cancel", {}, { quiet: true }).then(
      () => {
        toast("送るのをやめました");
        if (sessionId) store.load.ccSession(sessionId);
      },
      (err) => {
        if (button) button.disabled = false;
        if (err && err.status === 409) toast("この操作は古くなっています（届けている途中か、終わっています）");
        else toast((err && err.toast) || "送るのをやめられませんでした", null, { level: "error", retry: () => cancelCcSend(sendId, sessionId, null) });
        if (sessionId) store.load.ccSession(sessionId);
      },
    );
  }

  /** 送った本文の状態の行。届け待ちなら [やめる] */
  function ccPendingBar(sessionId, pending) {
    if (!pending || typeof pending.id !== "number") return null;
    // ダイアログ（trust・許可など）が出ている間は積んだまま待つ（再起動の後も、最後に見たペインの状態で分かる）
    const text =
      pending.state === "queued" && pending.lastPaneState === "dialog"
        ? "ダイアログが出ているため待っています（端末か RC で答えてください）"
        : CC_SEND_STATES[pending.state] || String(pending.state);
    const cls = pending.state === "delivered" ? " is-done" : pending.state === "unconfirmed" || pending.state === "failed" || pending.state === "gave_up" ? " is-warning" : "";
    const reply = pending.state === "delivered" && pending.replyState ? CC_REPLY_STATES[pending.replyState] : null;
    const children = [el("span", { text: "本文 #" + pending.id + ": " + text + (reply ? "・" + reply : "") })];
    if (pending.state === "queued" || pending.state === "delivering") children.unshift(el("span", { class: "spinner spinner-sm", "aria-hidden": "true" }));
    if (pending.state === "queued") {
      const cancel = el("button", { class: "btn btn-ghost btn-sm", type: "button", text: "やめる" });
      cancel.addEventListener("click", () => cancelCcSend(pending.id, sessionId, cancel));
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
      enterkeyhint: SA.chat.enterHint(),
      "data-title": title,
      placeholder: SA.chat.placeholderOf(title),
      title: "入力待ちのときに tmux で貼って Enter を押します。作業中なら入力待ちになるまで待ちます",
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
      if (sendBtn.disabled) sendBtn.title = sending ? "送っています" : "本文を入れると送れます";
      else sendBtn.removeAttribute("title");
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
        // 本文は入力欄に残す。[もう一度] は入力欄の今の本文を送り直す
        if (err && err.toast) toast((err.code && CC_SEND_ERRORS[err.code]) || err.toast, null, { level: "error", retry: submit });
      } finally {
        sending = false;
        update();
      }
    };
    const form = el("form", { class: "composer", novalidate: true }, [
      ta,
      el("div", { class: "composer-foot" }, [
        el("span", { class: "composer-hint" }),
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

  // ----- 許可の要求（CC5a・CC5b）: 保留中なら [許可][拒否] と「このセッションでは常に許可」のチェック（ルールがあるときだけ。
  // チェックが入っていれば [許可] は always、無ければ allow）、終わったものは終わり方。保留の間も端末・RC のダイアログは出ている -----
  /** 押した要求（応答が来るまでボタンを止める。このタブのメモリだけ） */
  const ccPermissionBusy = new Set();
  /** 「このセッションでは常に許可」にチェックを入れた要求（3 秒ごとの描き直しでも残す。このタブのメモリだけ） */
  const ccPermissionAlways = new Set();

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

  const PERMISSION_NOTE = "端末や RC のダイアログでも答えられます。先に答えた方が効きます。";

  /** 保留の残り（m 分 s 秒）。過ぎていれば null */
  function remainingText(iso) {
    const ms = new Date(iso).getTime() - Date.now();
    if (!Number.isFinite(ms) || ms <= 0) return null;
    const sec = Math.ceil(ms / 1000);
    return (sec >= 60 ? Math.floor(sec / 60) + " 分 " : "") + (sec % 60) + " 秒";
  }

  /** 残りが 60 秒を切ったか（残り時間を warning にする） */
  function permissionUrgent(iso) {
    const ms = new Date(iso).getTime() - Date.now();
    return Number.isFinite(ms) && ms < 60000;
  }

  /** 許可のカードの見出しの残り時間の文 */
  function permissionLeftText(iso) {
    const left = remainingText(iso);
    return left ? "残り " + left : "まもなく時間切れ";
  }

  /** 許可の残り時間を 1 秒ごとに進める（GUIDELINES §6.1。描き直さずに文だけ。カードが無い・隠れたタブでは何もしない） */
  setInterval(() => {
    if (document.visibilityState !== "visible") return;
    const nodes = document.querySelectorAll("[data-permission-left]");
    if (nodes.length === 0) return;
    for (const node of nodes) {
      const iso = node.getAttribute("data-permission-left");
      const text = permissionLeftText(iso);
      if (node.textContent !== text) node.textContent = text;
      node.classList.toggle("is-urgent", permissionUrgent(iso));
    }
  }, 1000);

  /** tabId は描き直すタブ（Claude Code のチャンネルの会話のタブから押したときは ch:<id>。CC14） */
  function answerCcPermission(sessionId, p, decision, tabId) {
    if (ccPermissionBusy.has(p.id)) return;
    ccPermissionBusy.add(p.id);
    SA.app.refresh(tabId || "cc:" + sessionId);
    SA.api.post("/api/cc/permissions/" + p.id + "/" + decision, { requestHash: p.requestHash }, { quiet: true }).then(
      () => {
        ccPermissionAlways.delete(p.id);
        toast(decision === "allow" ? "許可しました" : decision === "always" ? "このセッションでは常に許可しました" : "拒否しました");
      },
      (err) => {
        if (err && err.status === 409) toast("この操作は古くなっています（端末か RC で答えられたか、時間切れです）");
        else if (err && err.status === 404) toast("この要求はもうありません");
        else if (err && err.toast) toast(err.toast, null, { level: "error", retry: () => answerCcPermission(sessionId, p, decision, tabId) });
      },
    ).then(() => {
      ccPermissionBusy.delete(p.id);
      // プロジェクトのセッションの会話のタブ（kind session）のカードは /turns の channel から出す（docs/plan/unify.md §6.1 の 5）
      const ch = tabId && tabId.startsWith("ch:") ? SA.chat.channelById(tabId.slice(3)) : null;
      if (ch && ch.kind === "session") {
        store.load.turns(ch.id, { quiet: true });
        SA.app.refresh(tabId);
        return;
      }
      store.load.ccSession(sessionId);
      store.load.cc({ quiet: true });
    });
  }

  // ----- 質問（AskUserQuestion。docs/plan/claude-code-questions.md §4。Q3）: 問ごとに選択肢（1 つ選ぶ形はラジオ・複数はチェック）と「その他」。
  // 全部の問に答えるまで [答える] は押せない。[やめる] は答えない（/deny）。終わったものは答えか終わり方 -----
  /** 「その他」の上限（字。サーバーは src/cc/questions.ts の CC_QUESTION_OTHER_MAX_CHARS） */
  const CC_QUESTION_OTHER_MAX = 1000;
  /** 選んだ状態（要求の id → 問ごとの { labels（選んだ label）, other（「その他」を選んだか）, text（「その他」の文） }）。
   * 描き直しでも残す（このタブのメモリだけ）。終わったら消す */
  const ccQuestionDrafts = new Map();
  /** 描いた保留中のカード（タブ → { id, key, node, sync }。タブごとに 1 つ）。中身が変わらなければ同じ要素を返し、「その他」の書きかけ・焦点を保つ */
  const ccQuestionNodes = new Map();

  /** 終わった・無くなった質問の選んだ状態と描いたカードを捨てる（chat.js が保留中でない要求を見たときにも呼ぶ） */
  function ccQuestionForget(id) {
    ccQuestionDrafts.delete(id);
    for (const [tab, entry] of ccQuestionNodes) if (entry.id === id) ccQuestionNodes.delete(tab);
  }

  /** 問の draft（無ければ空で作る） */
  function ccQuestionDraft(id, count) {
    let drafts = ccQuestionDrafts.get(id);
    if (!drafts) {
      drafts = [];
      for (let i = 0; i < count; i++) drafts.push({ labels: [], other: false, text: "" });
      ccQuestionDrafts.set(id, drafts);
    }
    return drafts;
  }

  /** 「その他」の文が送れる形か（前後の空白を除いて 1〜1,000 字） */
  function otherReady(text) {
    const length = [...String(text).trim()].length;
    return length >= 1 && length <= CC_QUESTION_OTHER_MAX;
  }

  /** 問ごとの答え（問の順。/answer の answers）。答えていない問があれば null。複数選択の label は選択肢の順 */
  function ccQuestionPicks(questions, drafts) {
    const picks = [];
    for (let i = 0; i < questions.length; i++) {
      const d = drafts[i];
      if (!d) return null;
      if (d.other) {
        if (!otherReady(d.text)) return null;
        picks.push({ other: d.text.trim() });
        continue;
      }
      const labels = questions[i].options.map((o) => o.label).filter((label) => d.labels.includes(label));
      if (labels.length === 0) return null;
      picks.push({ labels });
    }
    return picks;
  }

  /** fieldset の legend（header が無ければ「問 n」。問の文は直下に出すので重ねない） */
  function questionLegend(q, index) {
    return typeof q.header === "string" && q.header.trim() ? q.header : "問 " + (index + 1);
  }

  /** 終わったカードの答えの行の見出し（header が無ければ問の文の先頭 40 字） */
  function questionHeading(q, index) {
    const header = typeof q.header === "string" && q.header.trim() ? q.header : null;
    if (header) return header;
    const chars = [...oneLine(String(q.question || ""))];
    return chars.length > 40 ? chars.slice(0, 40).join("") + "…" : chars.join("") || "問 " + (index + 1);
  }

  /** 終わった質問の文（答えたなら answers から「1. <見出し>: <答え>」の行） */
  function ccQuestionEndLines(p) {
    const by = p.via === "discord" ? "（Discord）" : p.via === "web" ? "（Web）" : "";
    if (p.state === "allowed") {
      const questions = p.question.questions;
      const answers = p.question.answers && typeof p.question.answers === "object" ? p.question.answers : {};
      const lines = questions.map((q, i) => (i + 1) + ". " + questionHeading(q, i) + ": " + (typeof answers[q.question] === "string" ? answers[q.question] : "-"));
      return ["答えました" + by, ...lines];
    }
    if (p.state === "denied") return ["答えませんでした" + by];
    return [ccPermissionEndText(p)];
  }

  /** 質問の答えを送る（path は answer か deny） */
  function postCcQuestion(sessionId, p, path, body, tabId) {
    if (ccPermissionBusy.has(p.id)) return;
    ccPermissionBusy.add(p.id);
    SA.app.refresh(tabId || "cc:" + sessionId);
    SA.api.post("/api/cc/permissions/" + p.id + "/" + path, body, { quiet: true }).then(
      () => {
        ccQuestionDrafts.delete(p.id);
        toast(path === "answer" ? "答えました" : "答えませんでした");
      },
      (err) => {
        if (err && err.status === 409) toast("この操作は古くなっています（端末か RC で答えられたか、時間切れです）");
        else if (err && err.status === 400) toast("答えの形が合いません");
        else if (err && err.status === 404) toast("この質問はもうありません");
        // 古い・無い要求の選んだ状態は使わない
        if (err && (err.status === 404 || err.status === 409)) ccQuestionForget(p.id);
        else if (err && err.toast) toast(err.toast, null, { level: "error", retry: () => postCcQuestion(sessionId, p, path, body, tabId) });
      },
    ).then(() => {
      ccPermissionBusy.delete(p.id);
      store.load.ccSession(sessionId);
      store.load.cc({ quiet: true });
    });
  }

  /** 保留の残り時間の見出し（許可のカードと同じ刻み） */
  function questionHead(title, p, pending) {
    return el("div", { class: "card-head" }, [
      el("h2", { text: title }),
      el("span", {
        class: "meta" + (pending && typeof p.expiresAt === "string" && permissionUrgent(p.expiresAt) ? " is-urgent" : ""),
        "data-permission-left": pending && typeof p.expiresAt === "string" ? p.expiresAt : null,
        text: pending ? permissionLeftText(p.expiresAt) : ago(p.resolvedAt || p.createdAt),
      }),
    ]);
  }

  /** 1 問の fieldset（legend に見出し・問の文・選択肢と「その他」）。sync は選んだ状態を input に写す（ほかのタブで選んだものも） */
  function questionFieldset(p, q, index, draft, busy, onChange) {
    const multi = !!q.multiSelect;
    const name = "ccq-" + p.id + "-" + index;
    const inputs = [];
    const other = el("textarea", {
      class: "textarea cc-question-other",
      rows: 2,
      maxlength: CC_QUESTION_OTHER_MAX,
      "aria-label": "その他の答え（" + questionLegend(q, index) + "）",
      disabled: busy,
    });
    other.value = draft.text;
    const sync = () => {
      for (const { input, label } of inputs) input.checked = label === null ? draft.other : !draft.other && draft.labels.includes(label);
      other.hidden = !draft.other;
      if (other.value !== draft.text && document.activeElement !== other) other.value = draft.text;
    };
    const option = (label, children) => {
      const input = el("input", { type: multi ? "checkbox" : "radio", name, disabled: busy });
      inputs.push({ input, label });
      // 「その他」の文の欄に焦点を移すのは指・マウスで選んだときだけ（矢印キーで選んだ瞬間には飛ばさない）
      let byPointer = false;
      input.addEventListener("change", () => {
        if (label === null) {
          // 「その他」と選択肢は同時に選べない（答えは labels か other の 1 つ）
          draft.other = multi ? input.checked : true;
          if (draft.other) draft.labels = [];
        } else {
          draft.other = false;
          if (!multi) draft.labels = [label];
          else if (input.checked) draft.labels = draft.labels.includes(label) ? draft.labels : [...draft.labels, label];
          else draft.labels = draft.labels.filter((l) => l !== label);
        }
        sync();
        onChange();
        if (label === null && draft.other && byPointer && typeof other.focus === "function") other.focus();
        byPointer = false;
      });
      const row = el("label", { class: "check cc-question-option" }, [input, el("span", { class: "cc-question-label" }, children)]);
      row.addEventListener("pointerdown", () => {
        byPointer = true;
      });
      return row;
    };
    const options = q.options.map((o) =>
      option(o.label, [el("strong", { text: String(o.label) }), o.description ? el("span", { class: "cc-question-desc", text: String(o.description) }) : null]),
    );
    other.addEventListener("input", () => {
      draft.text = other.value;
      onChange();
    });
    sync();
    const node = el("fieldset", { class: "cc-question" }, [
      el("legend", { text: questionLegend(q, index) }),
      el("p", { class: "cc-question-text", text: String(q.question || "") }),
      ...(multi ? [el("p", { class: "meta", text: "いくつでも選べます" })] : []),
      ...options,
      option(null, [el("strong", { text: "その他" })]),
      other,
    ]);
    return { node, sync };
  }

  /** 質問のカード（問・選択肢・説明は hook から来たデータなので textContent で出す。GUIDELINES §5 質問のカード）。ccPermissionCard が委ねる */
  function ccQuestionCard(sessionId, p, rc, tabId) {
    const questions = p.question.questions;
    const pending = p.state === "pending";
    const cacheKey = tabId || "cc:" + sessionId;
    const s = store.ccSessions ? ccSessionOf(sessionId) : null;
    const who = s ? el("p", { class: "meta", text: ccName(s) + (p.permissionMode ? " ・ " + permissionModeText(p.permissionMode) : "") }) : null;
    if (!pending) {
      ccQuestionForget(p.id);
      const [first, ...lines] = ccQuestionEndLines(p);
      const end = [el("span", { text: first })];
      if (rc && (p.state === "expired" || p.state === "released")) end.push(" ", el("a", { href: rc, target: "_blank", rel: "noreferrer noopener", text: "RC で開く" }));
      const cls = p.state === "allowed" ? " is-done" : p.state === "expired" || p.state === "released" ? " is-warning" : "";
      return el("section", { class: "card card-sm cc-permission cc-question-card" + cls, "aria-label": "質問" }, [
        questionHead("質問", p, false),
        who,
        el("p", { class: "cc-permission-end" }, end),
        ...lines.map((line) => el("p", { class: "cc-question-answer", text: line })),
      ]);
    }
    const busy = ccPermissionBusy.has(p.id);
    // 中身が変わらなければ同じ要素を返す（描き直しで「その他」の書きかけ・焦点を保つ。親は placeChildren でこの要素を動かさない）
    const key = JSON.stringify([p.requestHash, p.expiresAt, busy, rc, who ? who.textContent : null]);
    const cached = ccQuestionNodes.get(cacheKey);
    if (cached && cached.id === p.id && cached.key === key) {
      // ほかのタブ（cc: と ch:）で選んだものをこのカードにも写す
      cached.sync();
      const active = document.activeElement;
      if (active && cached.node.contains(active)) {
        // 親が入れ替えるときに外れる焦点を戻す（同じ要素なのでカーソルの位置も残る）
        const start = active.selectionStart;
        const endPos = active.selectionEnd;
        Promise.resolve().then(() => {
          if (!active.isConnected || document.activeElement === active) return;
          active.focus({ preventScroll: true });
          if (typeof start === "number" && typeof active.setSelectionRange === "function") active.setSelectionRange(start, endPos);
        });
      }
      return cached.node;
    }
    const drafts = ccQuestionDraft(p.id, questions.length);
    const answer = el("button", { class: "btn btn-primary btn-sm", type: "button" }, [icon("check"), "答える"]);
    const drop = el("button", { class: "btn btn-ghost btn-sm", type: "button", disabled: busy, title: busy ? "答えを送っています" : null }, [icon("x"), "やめる"]);
    const update = () => {
      const ready = ccQuestionPicks(questions, drafts) !== null;
      answer.disabled = busy || !ready;
      // 空の title はカードの title（端末でも答えられる旨）を隠すので、押せるときは外す
      if (busy || !ready) answer.title = busy ? "答えを送っています" : "すべての問に答えると押せます";
      else answer.removeAttribute("title");
    };
    const fieldsets = questions.map((q, i) => questionFieldset(p, q, i, drafts[i], busy, update));
    update();
    const sync = () => {
      for (const f of fieldsets) f.sync();
      update();
    };
    answer.addEventListener("click", () => {
      const picks = ccQuestionPicks(questions, drafts);
      if (picks) postCcQuestion(sessionId, p, "answer", { requestHash: p.requestHash, answers: picks }, tabId);
    });
    // 確認なしで答えない（Claude Code に「断りました」を返す）
    drop.addEventListener("click", () => postCcQuestion(sessionId, p, "deny", { requestHash: p.requestHash }, tabId));
    const node = el(
      "section",
      { class: "card card-sm cc-permission cc-question-card is-pending", "aria-label": "質問", title: PERMISSION_NOTE },
      [
        questionHead("質問を待っています", p, true),
        who,
        ...fieldsets.map((f) => f.node),
        el("div", { class: "msg-actions" }, [answer, drop]),
        el("p", { class: "cc-permission-note show-sm", text: PERMISSION_NOTE }),
      ],
    );
    ccQuestionNodes.set(cacheKey, { id: p.id, key, node, sync });
    return node;
  }

  /**
   * container の子を nodes の順にする。既に中にある要素は動かさず、無いものだけを前後に差し込む（外す・付け直すと焦点・IME の変換が切れるため。
   * 入力欄と質問のカード）。nodes に無い子は外す。中に残る要素どうしの順は nodes と同じであること
   */
  function placeChildren(container, nodes) {
    const keep = new Set(nodes.filter((n) => n));
    for (const child of [...container.children]) if (!keep.has(child)) child.remove();
    let ref = container.firstElementChild;
    for (const node of keep) {
      if (node === ref) ref = ref.nextElementSibling;
      else container.insertBefore(node, ref);
    }
  }

  /** 許可のカード（要約・ツール名は hook から来たデータなので textContent で出す。GUIDELINES §5 許可のカード）。tabId は押した後に描き直すタブ（省けば cc:<sessionId>） */
  function ccPermissionCard(sessionId, p, rc, tabId) {
    if (!p || typeof p.id !== "number") return null;
    // 質問（AskUserQuestion）は質問のカード（Q3）
    if (p.question && Array.isArray(p.question.questions) && p.question.questions.length > 0) return ccQuestionCard(sessionId, p, rc, tabId);
    const pending = p.state === "pending";
    const head = el("div", { class: "card-head" }, [
      el("h2", { text: pending ? "許可を待っています" : "許可の要求" }),
      el("span", {
        class: "meta" + (pending && typeof p.expiresAt === "string" && permissionUrgent(p.expiresAt) ? " is-urgent" : ""),
        "data-permission-left": pending && typeof p.expiresAt === "string" ? p.expiresAt : null,
        text: pending ? permissionLeftText(p.expiresAt) : ago(p.resolvedAt || p.createdAt),
      }),
    ]);
    const facts = [
      el("p", { class: "meta" }, [el("span", { class: "mono", text: String(p.toolName) }), p.permissionMode ? " ・ " + permissionModeText(p.permissionMode) : null]),
      el("pre", { class: "code-pre", text: String(p.summary || "") }),
    ];
    // 常に許可にすると加わるルール（保留中と、常に許可したものだけ）。ルール・意味は hook から来たデータなので textContent
    const rule = typeof p.alwaysRule === "string" && p.alwaysRule ? p.alwaysRule : null;
    const note = typeof p.alwaysNote === "string" && p.alwaysNote ? "（" + p.alwaysNote + "）" : null;
    if (!pending) {
      // 終わった要求のチェックは覚えておかない
      ccPermissionAlways.delete(p.id);
      if (rule && p.state === "allowed_always") {
        facts.push(el("p", { class: "meta cc-permission-rule" }, ["常に許可したルール: ", el("code", { class: "mono", text: rule }), note]));
      }
      const end = [el("span", { text: ccPermissionEndText(p) })];
      if (rc && (p.state === "expired" || p.state === "released")) {
        end.push(" ", el("a", { href: rc, target: "_blank", rel: "noreferrer noopener", text: "RC で開く" }));
      }
      const cls = p.state === "allowed" || p.state === "allowed_always" ? " is-done" : p.state === "expired" || p.state === "released" ? " is-warning" : "";
      return el("section", { class: "card card-sm cc-permission" + cls, "aria-label": "許可の要求" }, [head, ...facts, el("p", { class: "cc-permission-end" }, end)]);
    }
    const busy = ccPermissionBusy.has(p.id);
    const disabledTitle = busy ? "答えを送っています" : null;
    // ルールがあるときだけ「このセッションでは常に許可」のチェック。ルールは次の行の <code>
    let always = null;
    if (rule) {
      always = el("input", { type: "checkbox", disabled: busy });
      always.checked = ccPermissionAlways.has(p.id);
      always.addEventListener("change", () => {
        if (always.checked) ccPermissionAlways.add(p.id);
        else ccPermissionAlways.delete(p.id);
      });
      facts.push(
        el("div", { class: "cc-permission-always" }, [
          el("label", { class: "check check-sm", title: disabledTitle }, [always, "このセッションでは常に許可"]),
          el("p", { class: "meta cc-permission-rule" }, [el("code", { class: "mono", text: rule }), note]),
        ]),
      );
    }
    // 許可は戻せない側なので primary にしない（許可 secondary・拒否 ghost）
    const allow = el("button", { class: "btn btn-secondary btn-sm", type: "button", disabled: busy, title: disabledTitle }, [icon("check"), "許可"]);
    const deny = el("button", { class: "btn btn-ghost btn-sm", type: "button", disabled: busy, title: disabledTitle }, [icon("x"), "拒否"]);
    allow.addEventListener("click", () => answerCcPermission(sessionId, p, always && always.checked ? "always" : "allow", tabId));
    deny.addEventListener("click", () => answerCcPermission(sessionId, p, "deny", tabId));
    return el(
      "section",
      {
        class: "card card-sm cc-permission is-pending",
        "aria-label": "許可の要求",
        title: PERMISSION_NOTE,
      },
      // title はタッチで出ないので、スマホでは同じ文を 12px で常設する（PC は title）
      [head, ...facts, el("div", { class: "msg-actions" }, [allow, deny]), el("p", { class: "cc-permission-note show-sm", text: PERMISSION_NOTE })],
    );
  }

  function renderCcSession(container, sessionId) {
    const loaded = store.ccSessions[sessionId];
    const s = ccSessionOf(sessionId);
    const rc = s ? rcUrl(s.rcUrl) : null;
    const actions = rc ? [el("a", { class: "btn btn-secondary btn-sm", href: rc, target: "_blank", rel: "noreferrer noopener" }, [icon("external-link"), "RC で開く"])] : [];
    const extras = s ? [el("span", { class: "badge" + (s.state === "needs_input" ? " badge-accent" : ""), text: CC_STATES[s.state] || String(s.state) })] : [];
    const head = toolbar("terminal", s ? ccName(s) : "Claude Code", extras, actions);
    if (loaded && loaded.missing) {
      container.replaceChildren(head, scroll([empty("terminal", "このセッションは一覧にありません。終わったセッションなら、このタブを閉じてください。")]));
      return;
    }
    if (!s) {
      container.replaceChildren(head, scroll([loading()]));
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
      kv("権限モード", el("span", { class: "mono", text: s.permissionMode ? permissionModeText(s.permissionMode) : "-" })),
      kv("ペイン", s.inTmux && s.paneLabel ? el("span", { class: "mono", text: s.paneLabel }) : "tmux の外"),
      kv("最後の指示", s.lastPromptAt ? dateTime(s.lastPromptAt) + "（" + ago(s.lastPromptAt) + "）" : "-"),
      ...(CC_STARTED_BY[s.startedBy] ? [kv("起動", CC_STARTED_BY[s.startedBy])] : []),
      ccFollowFact(sessionId, s),
      ccChannelFact(sessionId, s),
    ]);
    // trust のダイアログ（self-agent はキーを送らない。§4.2）
    const trust = s.trustPending
      ? el("p", {
          class: "alert",
          role: "status",
          text: "trust の確認が出ています。端末か RC で「Yes, I trust this folder」を選ぶと、最初の指示を届けます。",
        })
      : null;
    const prompt = s.lastPromptText ? el("pre", { class: "code-pre", text: s.lastPromptText }) : null;
    let screen;
    if (!loaded || !loaded.session) screen = el("p", { class: "meta", text: "読み込んでいます…" });
    else if (!s.inTmux) {
      screen = el("p", { class: "meta", text: "tmux の外のセッションです。画面は見られません" + (rc ? "。RC で開いてください。" : "。") });
    } else if (typeof s.screen !== "string") screen = el("p", { class: "meta", text: "画面を読めませんでした。" });
    else screen = el("pre", { class: "code-pre cc-screen", text: s.screen });
    // 許可のカードは見出しの下に固定する（画面の写しは下に付けて読むので、中に入れると見えなくなる）
    const card = ccPermissionCard(sessionId, s.permission, rc);
    // 同じカード（質問の書きかけ）なら、それを入れている枠ごと残して動かさない
    const oldWrap = [...container.children].find((child) => child.classList.contains("cc-permission-wrap"));
    const permission = card ? (oldWrap && oldWrap.firstElementChild === card ? oldWrap : el("div", { class: "cc-permission-wrap" }, [card])) : null;
    // 更新の間隔は常設の文にせず見出しの title に（GUIDELINES §5）
    const screenSection = section("画面", [screen]);
    screenSection.querySelector("h2").title = "3 秒ごとに更新";
    const body = scroll([section("セッション", [trust, facts, prompt].filter((x) => x)), screenSection]);
    // 画面の写しは最後の行（入力欄）を見たいので、下にいれば下に付ける
    body.dataset.stick = "bottom";
    const pending = ccPendingBar(sessionId, s.pending);
    // tmux の外には送れないので入力欄を出さない
    if (!s.inTmux) {
      placeChildren(container, [head, permission, body, pending]);
      return;
    }
    // 入力欄と同じカードの枠は作り直さず動かさない。見出し・中身・送信の状態だけを入れ替える
    const kept = [...container.children].find((child) => child.classList.contains("composer-wrap") && child.getAttribute("data-cc") === sessionId);
    placeChildren(container, [head, permission, body, pending, kept || ccComposer(sessionId, ccName(s))]);
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
    const input = el("input", { class: "input input-sm", type: "search", placeholder: "探す", title: "3 文字以上で探します", "aria-label": "ナレッジを探す" });
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
    if (!item) {
      return empty(
        null,
        store.knowledge && store.knowledge.q
          ? "「" + store.knowledge.q + "」に合うナレッジはありません。別の語で探してください。"
          : "ナレッジはありません。会話で URL を貼って「保存して」と頼むと増えます。",
      );
    }
    const entry = store.kbEntries[item.id];
    if (entry === undefined) {
      store.load.kbEntry(item.id);
      return loading();
    }
    if (entry === "missing") return empty(null, "この項目はもうありません。一覧から選び直してください。");
    if (entry === "failed") return empty(null, "この項目を読み込めませんでした。", () => store.load.kbEntry(item.id, true));
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
      el("p", { class: "meta", text: "#" + entry.id + "・保存 " + dateOf(entry.createdAt) + (entry.updatedAt !== entry.createdAt ? "（更新 " + dateOf(entry.updatedAt) + "）" : "") }),
      el("p", { class: "meta", text: "削除は Discord の確認から行います。" }),
    ]);
  }

  function renderKnowledge(container) {
    const input = kbInput("tab");
    keepFocus(input, () => {
      const data = store.knowledge;
      if (!data) {
        container.replaceChildren(toolbar("book", "ナレッジ", [], [input], "ed-toolbar-kb"), scroll([loading()]));
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
        toolbar("book", "ナレッジ", note ? [el("span", { class: "meta", text: note })] : [], [input], "ed-toolbar-kb"),
        // ≤639px は中身だけ（一覧と検索はサイドバー。.master-detail-phone）
        el("div", { class: "master-detail master-detail-phone" }, [el("div", { class: "master" }, [list]), el("div", { class: "detail" }, [kbDetail(current)])]),
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
    return "有効（" + githubFetchLine(g) + "）";
  }

  function renderStatus(container) {
    const s = store.status;
    // 更新の間隔は常設の文にせず見出しの title に（GUIDELINES §5）
    const head = toolbar("activity", "状態");
    head.querySelector("h1").title = "10 秒ごとに更新";
    if (!s) {
      container.replaceChildren(head, scroll([loading()]));
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
    ["Alt+数字", "その番号のタブ（1 から 9）"],
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
          // キーボードは ≤639px で隠し、代わりにスマホの操作（Enter の扱いは chat.js の指の端末の判定によるので、条件に触れる文にする）
          el("div", { class: "hide-sm" }, [section("キーボード", [el("ul", { class: "kv-list" }, KEYS.map(([k, v]) => kv(el("kbd", { text: k }), v)))])]),
          el("div", { class: "show-sm" }, [
            section("スマホの操作", [
              el("p", { class: "meta", text: "送るのは入力欄の [送る] です。タッチの端末では Enter は改行で、Ctrl+Enter（⌘+Enter）でも送れます。" }),
            ]),
          ]),
        ]),
        section("環境変数", [
          el("p", { class: "meta", text: "あるかないかだけを出します。値は出しません。変えるときは ~/.config/self-agent/env を編集して再起動します。" }),
          env
            ? el("ul", { class: "kv-list kv-grid kv-env" }, env.map(([name, has]) => kv(el("span", { class: "mono", text: name }), el("span", { class: "badge", text: has ? "あり" : "なし" }))))
            : loading(),
        ]),
      ]),
    );
  }

  // ===== 知らせ（スマホの鈴で開くタブ。PC はパネルの「知らせ」。行は workbench.js の noticeLine を共用） =====
  function renderNotices(container) {
    const data = store.notices;
    if (data === null) {
      container.replaceChildren(toolbar("bell", "知らせ"), scroll([loading()]));
      return;
    }
    container.replaceChildren(
      toolbar("bell", "知らせ", [el("span", { class: "meta", text: "直近 24 時間 " + data.recent24h + " 件" })]),
      scroll([
        data.notices.length > 0
          ? el("ul", { class: "notice-list" }, data.notices.map(SA.app.noticeLine))
          : empty("bell", "知らせはありません。#system に出たものがここにも出ます。"),
      ]),
    );
  }

  // ===== ようこそ（タブが無いとき） =====
  function renderWelcome(container) {
    const action = (label, keys, fn, cls) => {
      const b = el("button", { class: "welcome-link" + (cls ? " " + cls : ""), type: "button" }, [el("span", { text: label }), keys ? el("kbd", { text: keys }) : null]);
      b.addEventListener("click", fn);
      return b;
    };
    container.replaceChildren(
      el("div", { class: "welcome" }, [
        el("h1", { text: "self-agent" }),
        el("p", { class: "meta" }, [
          el("span", { class: "hide-sm", text: "左の一覧から開くか、コマンドで移動します。" }),
          el("span", { class: "show-sm", text: "下の「会話」から開くか、上の「探す」で移動します。" }),
        ]),
        el("div", { class: "welcome-links" }, [
          action("移動", "Ctrl+K", () => SA.app.palette("")),
          action("コマンド", "Ctrl+Shift+P", () => SA.app.palette(">")),
          action("状態を開く", "", () => SA.app.open("status")),
          action("使用量を開く", "", () => SA.app.open("usage")),
          action("サイドバー", "Ctrl+B", () => SA.app.toggleSidebar(), "hide-sm"),
          action("パネル", "Ctrl+J", () => SA.app.togglePanel(), "hide-sm"),
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
    notices: { title: "知らせ", icon: "bell", render: renderNotices, onOpen: () => store.load.notices() },
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
    ccPermissionCard,
    ccQuestionPicks,
    ccQuestionForget,
    placeChildren,
    // Claude Code のチャンネルの会話のタブ（chat.js。CC14）と共用する
    ccPendingBar,
    ccSessionOf,
    rcUrl,
    CC_STATES,
    CC_SEND_ERRORS,
    loading,
  };
})();
