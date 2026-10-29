// 会話（#inbox・#tasks・#<NAME>・セッション）のタブ。SA.store.turns[channelId] の行と実行中のターン（SA.store.running）を描き、見ている間は既読にする。
// 入力欄から送ると Discord の発言と同じ経路で 1 ターン動く（POST /messages）。[中断]・[続ける] は Discord のボタンと同じ handler の関数。
// 見出しの [待ちにする][閉じる][会話を新しくする] と /close の確認のカードは Discord の /wait・/close・/renew と同じ処理（src/app/session-ops.ts）
"use strict";

(function () {
  const SA = (window.SA = window.SA || {});
  const { el, icon, elapsed, shortTime, linkify, toast, confirm } = SA.ui;
  const store = SA.store;

  const STATE_LABEL = { active: "進行中", waiting: "待ち", done: "完了" };
  // 終わり方の文は src/app/progress.ts の progressEndText と同じ
  const OUTCOME_LABEL = { done: "完了", max_turns: "手順の上限で止まりました", aborted: "中断しました", failed: "止まりました" };
  const END_CLASS = { done: "is-done", max_turns: "is-warning", aborted: null, failed: "is-danger" };
  const END_ICON = { done: "check", max_turns: "triangle-alert", aborted: "square", failed: "triangle-alert" };
  const DISCORD_PREFIX = "https://discord.com/channels/";
  /** これより上に近づいたら前の行を読む（px） */
  const OLDER_THRESHOLD = 64;
  /** Web から送る本文の上限（src/web/routes/turns.ts の WEB_MESSAGE_MAX_LENGTH） */
  const MESSAGE_MAX = 1900;
  const STALE_TEXT = "この操作は古くなっています";
  const TOO_LONG_TEXT = "1,900 字までです";
  /** 送れた（202）後に実行中のターンを読み直すまでの時間（ms）。進行中の読み込みに吸われても次で拾う */
  const RUNNING_RECHECK_MS = [500, 1500];
  /** 送れなかったときのトースト（応答の error ごと）。無ければ「<status>: <error>」 */
  const SEND_ERRORS = {
    bot_disconnected: "Bot が接続していません",
    echo_failed: "送れませんでした（Discord に投稿できません）",
    stopping: "再起動中です。終わったら送ってください",
    too_long: TOO_LONG_TEXT,
    not_found: "このチャンネルには送れません",
  };
  const CLOSED_TEXT = "このセッションは閉じています";
  /** 操作の後に会話をもう一度読むまでの時間（ms）。読んでいる途中のもの（操作の前の中身かもしれない）に吸われても次で拾う */
  const OP_RECHECK_MS = 1500;
  /** 要約を待つ表示を解除するまでの時間（ms）。行が来ないまま（知らせを書けなかったなど）操作を止めたままにしない */
  const PENDING_MAX_MS = 3 * 60 * 1000;

  /** リンクにするのは https の Discord の URL だけ */
  function discordUrl(url) {
    return typeof url === "string" && url.startsWith(DISCORD_PREFIX) ? url : null;
  }

  /** プロジェクトの URL（サーバーが公開 URL から組み立てたもの）。http(s) でなければ使わない */
  function pageUrl(url) {
    return typeof url === "string" && /^https?:\/\//.test(url) ? url : null;
  }

  /** /turns の channel（新しい）→ 一覧の 1 件 */
  function channelById(channelId) {
    const t = store.turns[channelId];
    if (t && t.channel) return t.channel;
    return store.channels ? store.channels.channels.find((c) => c.id === channelId) || null : null;
  }

  function channelTitle(ch) {
    if (ch.kind === "session") return ch.title || "セッション";
    return "#" + (ch.name || ch.kind);
  }

  function persona(id) {
    const list = store.channels ? store.channels.personas : [];
    return list.find((p) => p.id === id) || { id, name: id, isDefault: id === "default" };
  }

  /** 終わり方の文（「完了（m 分 s 秒・ツール n 回）」など）。時間・回数が無ければ終わり方だけ */
  function endText(turn) {
    const label = OUTCOME_LABEL[turn.outcome] || "終わりました";
    if (typeof turn.durationMs !== "number" || typeof turn.toolCalls !== "number") return label;
    return label + "（" + elapsed(turn.durationMs) + "・ツール " + turn.toolCalls + " 回）";
  }

  /** 実行中の行の 1 行目（src/app/progress.ts の progressText の 1 行目と同じ） */
  function progressText(run) {
    return "作業中…（" + elapsed(store.runningElapsed(run)) + "・ツール " + run.toolCalls + " 回）";
  }

  function activeChannelId() {
    const id = SA.app.activeTabId();
    return id && id.startsWith("ch:") ? id.slice(3) : null;
  }

  /** 前に出ていて、画面が見えているときだけ、読んだ最後の行まで既読にする */
  function markSeen(channelId) {
    if (activeChannelId() !== channelId || document.visibilityState !== "visible") return;
    const t = store.turns[channelId];
    if (!t || t.turns.length === 0) return;
    if (store.markSeen(channelId, t.turns[t.turns.length - 1].id)) {
      SA.app.refreshSidebar();
      SA.app.refreshStatus();
    }
  }

  function markSeenActive() {
    const channelId = activeChannelId();
    if (channelId) markSeen(channelId);
  }

  // ===== セッションの操作（/wait・/close・/renew。src/web/routes/sessions.ts） =====
  // 要約を待っている操作（{ [channelId]: { kind: "close" | "renew", afterId, at } }。このタブのメモリだけ）。
  // afterId より後の行（区切り・知らせ）が来るか、閉じたら終わりとみなす。PENDING_MAX_MS 経っても終わらなければ解除して会話を読み直す
  const pending = {};
  // 確認のカードで選んだ候補（{ [channelId]: Set<添字> }。このタブのメモリだけ。描き直しても保つ）
  const picked = {};

  /** サーバーから受け取った最後の行の id（Web から送った直後の仮の行を除く） */
  function lastRealId(channelId) {
    const t = store.turns[channelId];
    const real = t ? t.turns.filter((row) => !row.optimistic) : [];
    return real.length > 0 ? real[real.length - 1].id : 0;
  }

  /** 要約を待ち始める（PENDING_MAX_MS 後に、まだ同じものを待っていれば解除する） */
  function setPending(channelId, kind, afterId) {
    const p = { kind, afterId, at: Date.now() };
    pending[channelId] = p;
    setTimeout(() => {
      if (pending[channelId] === p) expirePending(channelId);
    }, PENDING_MAX_MS);
  }

  /** 待つのをやめて、会話を読み直す（描いている途中から呼ばれうるので次の tick で） */
  function expirePending(channelId) {
    delete pending[channelId];
    setTimeout(() => {
      SA.app.refresh("ch:" + channelId);
      store.load.turns(channelId);
    }, 0);
  }

  /** 要約を待っている操作。終わっていれば消して null（時間切れなら会話を読み直す） */
  function pendingOf(channelId, ch) {
    const p = pending[channelId];
    if (!p) return null;
    if (lastRealId(channelId) > p.afterId || (p.kind === "close" && ch && ch.state === "done")) {
      delete pending[channelId];
      return null;
    }
    if (Date.now() - p.at >= PENDING_MAX_MS) {
      expirePending(channelId);
      return null;
    }
    return p;
  }

  /** 操作の後: 会話と一覧を読み直す（会話は少し後にもう一度） */
  function reloadAfterOp(channelId) {
    store.load.turns(channelId);
    store.load.channels();
    setTimeout(() => store.load.turns(channelId), OP_RECHECK_MS);
  }

  /** 操作の失敗のトースト（404 は古い、409 は閉じている。それ以外は応答の文） */
  function opFailed(err) {
    if (err && err.status === 404) toast(STALE_TEXT);
    else if (err && err.status === 409) toast(err.code === "no_draft" ? STALE_TEXT : CLOSED_TEXT);
    else if (err && err.toast) toast(err.toast);
  }

  function setWaiting(channelId) {
    const ch = channelById(channelId);
    if (!ch || ch.kind !== "session" || ch.state !== "active") {
      toast("進行中のセッションだけ待ちにできます");
      return;
    }
    SA.api
      .post("/api/sessions/" + encodeURIComponent(channelId) + "/wait", {}, { quiet: true })
      .then(() => toast("「" + ch.title + "」を待ちにしました"), opFailed)
      .finally(() => reloadAfterOp(channelId));
  }

  function closeSession(channelId) {
    const ch = channelById(channelId);
    if (!ch || ch.kind !== "session" || ch.state === "done") {
      toast("閉じられるのは進行中・待ちのセッションだけです");
      return;
    }
    confirm({
      title: "「" + ch.title + "」を閉じますか",
      body: "会話を要約してから完了に移します。やることの候補があれば、ここと Discord に確認が出ます（先に選んだ方で閉じます）。チャンネルは残ります。",
      ok: "閉じる",
      run: async () => {
        const afterId = lastRealId(channelId);
        try {
          await SA.api.post("/api/sessions/" + encodeURIComponent(channelId) + "/close", {}, { quiet: true });
          setPending(channelId, "close", afterId);
          toast("要約しています。終わったらここに出ます");
        } catch (err) {
          opFailed(err);
        }
        SA.app.refresh("ch:" + channelId);
        reloadAfterOp(channelId);
      },
    });
  }

  function renew(channelId) {
    const ch = channelById(channelId);
    if (!ch) return;
    confirm({
      title: channelTitle(ch) + " の会話を新しくしますか",
      body: "今の会話を要約して、新しい会話に引き継ぎます。状態は変わりません。",
      ok: "新しくする",
      run: async () => {
        const afterId = lastRealId(channelId);
        try {
          await SA.api.post("/api/channels/" + encodeURIComponent(channelId) + "/renew", {}, { quiet: true });
          setPending(channelId, "renew", afterId);
          toast("要約しています。終わったらここに区切りが出ます");
        } catch (err) {
          opFailed(err);
        }
        SA.app.refresh("ch:" + channelId);
        reloadAfterOp(channelId);
      },
    });
  }

  /** /close の確認の確定（selected は添字の配列・"all"・"none"） */
  async function confirmClose(channelId, selected, buttons) {
    for (const b of buttons) b.disabled = true;
    try {
      const data = await SA.api.post("/api/sessions/" + encodeURIComponent(channelId) + "/close/confirm", { selected }, { quiet: true });
      delete picked[channelId];
      toast("閉じました（登録 " + (data && typeof data.registered === "number" ? data.registered : 0) + " 件）");
      if (data && data.registered > 0 && store.tasks !== null) store.reload("tasks");
    } catch (err) {
      opFailed(err);
      for (const b of buttons) b.disabled = false;
    }
    reloadAfterOp(channelId);
  }

  /** /close の確認のカード（要約・候補のチェックボックス・[全部登録][選んだものを登録][登録しない]） */
  function closeCard(channelId, draft) {
    const tasks = Array.isArray(draft.tasks) ? draft.tasks : [];
    if (!picked[channelId]) picked[channelId] = new Set();
    const chosen = picked[channelId];
    const all = el("button", { class: "btn btn-primary btn-sm", type: "button" }, [icon("check"), "全部登録"]);
    const pick = el("button", { class: "btn btn-secondary btn-sm", type: "button", text: "選んだものを登録" });
    const none = el("button", { class: "btn btn-secondary btn-sm", type: "button", text: "登録しない" });
    const buttons = [all, pick, none];
    const updatePick = () => {
      pick.disabled = chosen.size === 0;
    };
    const list = el("div", { class: "stack" });
    tasks.forEach((task, i) => {
      const box = el("input", { type: "checkbox", checked: chosen.has(i) });
      box.addEventListener("change", () => {
        if (box.checked) chosen.add(i);
        else chosen.delete(i);
        updatePick();
      });
      const due = task && task.due ? "（期限 " + task.due + "）" : "";
      list.append(el("label", { class: "check" }, [box, el("span", { text: i + 1 + ". " + String(task && task.title) + due })]));
    });
    if (tasks.length === 0) list.append(el("p", { class: "meta", text: "やることの候補はありません" }));
    updatePick();
    all.addEventListener("click", () => confirmClose(channelId, "all", buttons));
    pick.addEventListener("click", () => {
      if (chosen.size > 0) confirmClose(channelId, [...chosen].sort((a, b) => a - b), buttons);
    });
    none.addEventListener("click", () => confirmClose(channelId, "none", buttons));
    return el("section", { class: "card card-sm", "aria-label": "閉じる前の確認" }, [
      el("div", { class: "card-head" }, [el("h3", { text: "閉じる前の確認" }), el("span", { class: "meta", text: "Discord でも選べます" })]),
      el("p", { class: "meta", text: "要約" }),
      el("div", { class: "msg-text", text: String(draft.summary || "") }),
      el("p", { class: "meta", text: "やることの候補（タスクとして登録するものを選んでください）" }),
      list,
      el("div", { class: "msg-actions" }, tasks.length === 0 ? [none] : buttons),
    ]);
  }

  // ===== 描画 =====
  function avatar(letter, cls) {
    return el("span", { class: "avatar " + (cls || ""), "aria-hidden": "true", text: letter });
  }

  /** 時刻。Discord の発言があればそこへのリンク */
  function timeOf(turn) {
    const text = shortTime(turn.at);
    const href = turn.messageId ? discordUrl(turn.link) : null;
    if (!href) return el("span", { class: "tl-time", text });
    return el("a", { class: "tl-time", href, target: "_blank", rel: "noreferrer", title: "Discord で開く", text });
  }

  // 開いた手順（details）は描き直しても開いたままにする（このタブのメモリだけ。{ [channelId]: Set<turn.id> }。会話のタブを閉じたら消す）
  const openSteps = {};

  function openStepsOf(channelId) {
    if (!openSteps[channelId]) openSteps[channelId] = new Set();
    return openSteps[channelId];
  }

  function stepsList(steps) {
    const list = el("ol", { class: "steps-list" });
    for (const s of steps) list.append(el("li", { text: s }));
    if (steps.length === 0) list.append(el("li", { text: "手順の記録はありません" }));
    return list;
  }

  function renderTurn(turn, channelId) {
    if (turn.kind === "divider") {
      return el("div", { class: "tl-divider", role: "separator" }, [el("span", { text: turn.text })]);
    }
    if (turn.kind === "notice") {
      return el("div", { class: "tl-notice" }, [icon("info"), el("span", { text: turn.text }), timeOf(turn)]);
    }
    if (turn.kind === "owner") {
      return el("article", { class: "msg msg-owner" }, [
        avatar("オ", "avatar-owner"),
        el("div", { class: "msg-body" }, [
          el("div", { class: "msg-head" }, [el("span", { class: "msg-name", text: "オーナー" }), timeOf(turn)]),
          el("div", { class: "msg-text", text: turn.text }),
        ]),
      ]);
    }
    // agent
    const p = persona(turn.persona);
    const body = el("div", { class: "msg-body" }, [el("div", { class: "msg-head" }, [el("span", { class: "msg-name", text: p.name }), timeOf(turn)])]);
    if (turn.outcome) {
      const opened = openStepsOf(channelId);
      const details = el("details", { class: "steps", open: opened.has(turn.id) }, [
        el("summary", { class: END_CLASS[turn.outcome] || null }, [
          icon("chevron-right", "steps-chevron"),
          icon(END_ICON[turn.outcome] || "info"),
          el("span", { text: endText(turn) }),
        ]),
        stepsList(Array.isArray(turn.steps) ? turn.steps : []),
      ]);
      details.addEventListener("toggle", () => {
        if (details.open) opened.add(turn.id);
        else opened.delete(turn.id);
      });
      body.append(details);
    }
    // 返事の本文は http(s) の URL だけをリンクにする
    body.append(el("div", { class: "msg-text" }, linkify(typeof turn.text === "string" ? turn.text : "")));
    return el("article", { class: "msg msg-agent" }, [avatar(Array.from(p.name || "?")[0], "avatar-agent"), body]);
  }

  /** 実行中の行の手順を閉じたチャンネル（描き直しで開き直さない。既定は開く。このタブのメモリだけ） */
  const stepsClosed = new Set();

  /** 実行中のターンの行（is-running）。[中断] は中断できるターン（セッション）だけ */
  function renderRunning(ch, run) {
    const p = persona(ch ? ch.persona : "default");
    const steps = el("ol", { class: "steps-list" });
    run.steps.forEach((s, i) => steps.append(el("li", { class: i === run.steps.length - 1 ? "is-current" : null, text: s })));
    if (run.steps.length === 0) steps.append(el("li", { text: "まだ手順はありません" }));
    const details = el("details", { class: "steps", open: !stepsClosed.has(run.channelId) }, [
      el("summary", {}, [icon("chevron-right", "steps-chevron"), el("span", { class: "spinner", "aria-hidden": "true" }), el("span", { "data-run-progress": run.channelId, text: progressText(run) })]),
      steps,
    ]);
    details.addEventListener("toggle", () => {
      if (details.open) stepsClosed.delete(run.channelId);
      else stepsClosed.add(run.channelId);
    });
    const body = el("div", { class: "msg-body" }, [
      el("div", { class: "msg-head" }, [el("span", { class: "msg-name", text: p.name }), el("span", { class: "badge badge-accent", text: "実行中" })]),
      details,
    ]);
    if (run.abortable) {
      const abort = el("button", { class: "btn btn-secondary btn-sm", type: "button" }, [icon("square"), "中断"]);
      abort.addEventListener("click", () => abortTurn(run, abort));
      body.append(el("div", { class: "msg-actions" }, [abort]));
    }
    return el("article", { class: "msg msg-agent is-running", "aria-busy": "true" }, [avatar(Array.from(p.name || "?")[0], "avatar-agent"), body]);
  }

  async function abortTurn(run, button) {
    button.disabled = true;
    try {
      await SA.api.post("/api/channels/" + encodeURIComponent(run.channelId) + "/turns/" + run.turnSeq + "/abort", {}, { quiet: true });
    } catch (err) {
      if (err && err.status === 409) toast(STALE_TEXT);
      else if (err && err.toast) toast(err.toast);
      button.disabled = false;
    }
    SA.poll.running();
  }

  /** [続ける]: 手順の上限で止まった最後の返事（セッション・実行中のターンが無いとき）。押したら隠す（このタブのメモリだけ） */
  const continued = new Set();
  function continueButton(channelId, turn) {
    const button = el("button", { class: "btn btn-secondary btn-sm", type: "button" }, [icon("play"), "続ける"]);
    button.addEventListener("click", async () => {
      button.disabled = true;
      try {
        await SA.api.post("/api/channels/" + encodeURIComponent(channelId) + "/continue", {}, { quiet: true });
        continued.add(turn.id);
        SA.poll.running();
        SA.app.refresh("ch:" + channelId);
      } catch (err) {
        if (err && err.status === 409) toast(err.code === "running" ? "実行中のターンがあります" : STALE_TEXT);
        else if (err && err.status === 404) toast(STALE_TEXT);
        else if (err && err.toast) toast(err.toast);
        button.disabled = false;
      }
    });
    return el("div", { class: "msg-actions" }, [button]);
  }

  function header(ch, channelId) {
    if (!ch) {
      return el("header", { class: "ed-toolbar" }, [el("div", { class: "ed-title" }, [icon("hash"), el("h1", { text: "会話" })]), el("div", { class: "ed-actions" })]);
    }
    const isSession = ch.kind === "session";
    const p = persona(ch.persona);
    const titleRow = el("div", { class: "ed-title" }, [
      icon(isSession ? "message-square" : "hash"),
      el("h1", { text: isSession ? ch.title || "" : ch.name || ch.kind }),
      isSession && STATE_LABEL[ch.state] ? el("span", { class: "badge state-" + ch.state, text: STATE_LABEL[ch.state] }) : null,
      el("span", { class: "badge", text: p.name + (p.isDefault ? "" : "（人格）") }),
    ]);
    const actions = el("div", { class: "ed-actions" });
    if (ch.project) {
      actions.append(el("span", { class: "badge", title: "プロジェクト" }, [icon("folder"), ch.project.slug]));
      const url = pageUrl(ch.project.url);
      if (url) actions.append(el("a", { class: "btn btn-ghost btn-sm", href: url, target: "_blank", rel: "noreferrer" }, [icon("external-link"), "ページ"]));
    }
    const discord = discordUrl(ch.link);
    if (discord) actions.append(el("a", { class: "btn btn-ghost btn-sm", href: discord, target: "_blank", rel: "noreferrer" }, [icon("external-link"), "Discord"]));
    // 要約を待っている間は操作を重ねない
    const busy = !!pendingOf(channelId, ch);
    const ops = el("div", { class: "ed-ops" });
    if (isSession) {
      const wait = el("button", { class: "btn btn-secondary btn-sm", type: "button", disabled: busy || ch.state !== "active" }, [icon("pause"), "待ちにする"]);
      wait.addEventListener("click", () => setWaiting(channelId));
      const close = el("button", { class: "btn btn-secondary btn-sm", type: "button", disabled: busy || ch.state === "done" }, [icon("check"), "閉じる"]);
      close.addEventListener("click", () => closeSession(channelId));
      ops.append(wait, close);
    }
    const renewBtn = el("button", { class: "btn btn-secondary btn-sm", type: "button", disabled: busy }, [icon("rotate-ccw"), "会話を新しくする"]);
    renewBtn.addEventListener("click", () => renew(channelId));
    ops.append(renewBtn);
    actions.append(ops);
    return el("header", { class: "ed-toolbar", "data-channel": channelId }, [titleRow, actions]);
  }

  // ===== 入力欄（Enter で送る・Shift+Enter で改行・IME の変換中の Enter は送らない） =====
  function composer(ch, channelId) {
    const title = ch ? channelTitle(ch) : "会話";
    const ta = el("textarea", {
      class: "textarea composer-input",
      rows: "2",
      maxlength: "4000",
      "aria-label": title + " に送る",
      placeholder: title + " に送る（Enter で送信・Shift+Enter で改行）",
    });
    ta.value = SA.app.draft(channelId);
    const counter = el("span", { class: "counter", "aria-live": "polite" });
    const sendBtn = el("button", { class: "btn btn-primary btn-sm", type: "submit" }, [icon("send"), "送る"]);
    let sending = false;
    const update = () => {
      const n = ta.value.trim().length;
      counter.textContent = n.toLocaleString("en-US") + " / 1,900";
      counter.classList.toggle("is-over", n > MESSAGE_MAX);
      // 上限を超えても押せる（押したらトーストで知らせる）
      sendBtn.disabled = sending || n === 0;
    };
    update();
    ta.addEventListener("input", () => {
      SA.app.setDraft(channelId, ta.value);
      update();
    });
    const form = el("form", { class: "composer", novalidate: true }, [
      ta,
      el("div", { class: "composer-foot" }, [
        el("span", { class: "composer-hint" }, [el("span", { text: "Discord で発言したのと同じ経路で 1 ターン動きます。返事はここと Discord の両方に出ます。" })]),
        counter,
        sendBtn,
      ]),
    ]);
    const submit = async () => {
      const text = ta.value.trim();
      if (sending || text === "") return;
      if (text.length > MESSAGE_MAX) {
        toast(TOO_LONG_TEXT);
        return;
      }
      sending = true;
      update();
      try {
        const data = await SA.api.post("/api/channels/" + encodeURIComponent(channelId) + "/messages", { text }, { quiet: true });
        // 送れたら書きかけを消し、本物の行が来るまで仮の行を出す
        if (ta.value.trim() === text) ta.value = "";
        SA.app.setDraft(channelId, ta.value);
        store.addOptimisticTurn(channelId, data && data.turnId, text);
        store.load.turns(channelId);
        SA.poll.running();
        for (const ms of RUNNING_RECHECK_MS) setTimeout(() => store.load.running({ quiet: true }), ms);
      } catch (err) {
        // 本文は入力欄に残す
        if (err && err.toast) toast((err.code && SEND_ERRORS[err.code]) || err.toast);
      } finally {
        sending = false;
        update();
      }
    };
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      submit();
    });
    ta.addEventListener("keydown", (event) => {
      if (event.key === "Enter" && !event.shiftKey && !event.isComposing && event.keyCode !== 229) {
        event.preventDefault();
        submit();
      }
    });
    return el("div", { class: "composer-wrap", "data-channel": channelId }, [form]);
  }

  /** 前に出ている会話のタブのスクロール */
  function scrollOf(channelId) {
    if (activeChannelId() !== channelId) return null;
    const ed = document.getElementById("ed");
    return ed ? ed.querySelector(".ed-scroll") : null;
  }

  /** 前の 50 件を読み、見ていた行の位置を保つ */
  const older = {};
  async function loadOlder(channelId) {
    const t = store.turns[channelId];
    if (!t || !t.hasMore || older[channelId]) return;
    older[channelId] = true;
    const before = scrollOf(channelId);
    const height = before ? before.scrollHeight : 0;
    const top = before ? before.scrollTop : 0;
    try {
      await store.load.olderTurns(channelId);
    } finally {
      older[channelId] = false;
    }
    SA.app.refresh("ch:" + channelId);
    const after = scrollOf(channelId);
    if (after && before) after.scrollTop = top + (after.scrollHeight - height);
  }

  function render(container, channelId) {
    const t = store.turns[channelId];
    const ch = channelById(channelId);
    if (!t || !t.loaded) {
      container.replaceChildren(header(ch, channelId), el("div", { class: "ed-scroll" }, [el("div", { class: "empty" }, [el("p", { text: "読み込んでいます…" })])]));
      return;
    }
    if (t.missing) {
      container.replaceChildren(
        header(null, channelId),
        el("div", { class: "ed-scroll" }, [el("div", { class: "empty" }, [icon("info"), el("p", { text: "このチャンネルは開けません（削除されたか、受け付けないチャンネルです）" })])]),
      );
      return;
    }
    const timeline = el("div", { class: "tl" });
    if (t.hasMore) {
      const more = el("button", { class: "btn btn-ghost btn-sm", type: "button", text: "前の会話を読む" });
      more.addEventListener("click", () => loadOlder(channelId));
      timeline.append(el("div", { class: "tl-hint" }, [more]));
    }
    const run = store.runningOf(channelId);
    const last = t.turns[t.turns.length - 1];
    for (const turn of t.turns) {
      const node = renderTurn(turn, channelId);
      // 手順の上限で止まった最後の返事には [続ける]（セッションで、実行中のターンが無いとき）
      if (turn === last && turn.kind === "agent" && turn.outcome === "max_turns" && ch && ch.kind === "session" && !run && !continued.has(turn.id)) {
        const body = node.querySelector(".msg-body");
        if (body) body.append(continueButton(channelId, turn));
      }
      timeline.append(node);
    }
    if (run) timeline.append(renderRunning(ch, run));
    const waiting = pendingOf(channelId, ch);
    if (waiting) {
      timeline.append(
        el("div", { class: "tl-notice", "aria-busy": "true" }, [
          el("span", { class: "spinner spinner-sm", "aria-hidden": "true" }),
          el("span", { text: waiting.kind === "close" ? "閉じる前の要約をしています…" : "会話を新しくしています…" }),
        ]),
      );
    }
    // /close の確認（下書きがあり、閉じていない）。この画面で閉じるのを待っている間は出さない（要約のターンの途中の下書き）
    if (ch && ch.kind === "session" && ch.state !== "done" && ch.closeDraft && !(waiting && waiting.kind === "close")) {
      timeline.append(closeCard(channelId, ch.closeDraft));
    }
    if (t.turns.length === 0 && !run) timeline.append(el("p", { class: "tl-hint", text: "まだ記録はありません。ここか Discord で発言すると、ここに出ます。" }));
    if (ch && ch.kind === "session" && ch.state === "done") {
      timeline.append(el("p", { class: "tl-hint", text: "完了したセッションです。発言すると進行中に戻ります。" }));
    }
    const scroll = el("div", { class: "ed-scroll", "data-stick": "bottom" }, [timeline]);
    scroll.addEventListener("scroll", () => {
      if (scroll.scrollTop < OLDER_THRESHOLD) loadOlder(channelId);
    });
    // 入力欄は作り直さない（書きかけ・フォーカス・IME の変換を保つ）。見出しと会話だけを入れ替える
    const kept = [...container.children].find((child) => child.classList.contains("composer-wrap") && child.getAttribute("data-channel") === channelId);
    if (kept) {
      for (const child of [...container.children]) if (child !== kept) child.remove();
      container.insertBefore(header(ch, channelId), kept);
      container.insertBefore(scroll, kept);
    } else {
      container.replaceChildren(header(ch, channelId), scroll, composer(ch, channelId));
    }
    markSeen(channelId);
  }

  /** タブの見出し。チャンネルがまだ分からなければ「会話」 */
  function info(channelId) {
    const ch = channelById(channelId);
    return {
      title: ch ? channelTitle(ch) : "会話",
      icon: ch && ch.kind === "session" ? "message-square" : "hash",
      dirty: !!store.runningOf(channelId),
      render: (container) => render(container, channelId),
      onOpen: () => store.load.turns(channelId),
      onClose: () => {
        delete openSteps[channelId];
        delete picked[channelId];
      },
    };
  }

  /** 一覧・/turns の channel が変わったとき: 開いている会話のタブの見出しが変わっていればタブを描き直す */
  function channelsChanged() {
    for (const tab of document.querySelectorAll('.tab[data-tab^="ch:"]')) {
      const text = tab.querySelector(".tab-text");
      if (text && text.textContent !== info(tab.getAttribute("data-tab").slice(3)).title) {
        SA.app.refreshTabs();
        return;
      }
    }
  }

  /** 実行中の行の経過時間を 1 秒ごとに進める（描き直さずに文だけ） */
  setInterval(() => {
    if (!store.running || store.running.length === 0 || document.visibilityState !== "visible") return;
    for (const node of document.querySelectorAll("[data-run-progress]")) {
      const run = store.runningOf(node.getAttribute("data-run-progress"));
      if (run) node.textContent = progressText(run);
    }
  }, 1000);

  /** 前に出ている会話のタブのチャンネル（無ければ null） */
  function current() {
    const channelId = activeChannelId();
    return channelId ? channelById(channelId) : null;
  }

  SA.chat = { info, channelTitle, activeChannelId, markSeenActive, channelsChanged, endText, STATE_LABEL, current, setWaiting, closeSession, renew };
})();
