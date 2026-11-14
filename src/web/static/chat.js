// 会話（#inbox・#tasks・#<NAME>・セッション）のタブ。SA.store.turns[channelId] の行と実行中のターン（SA.store.running）を描き、見ている間は既読にする。
// 入力欄から送ると Discord の発言と同じ経路で 1 ターン動く（POST /messages）。[中断]・[続ける] は Discord のボタンと同じ handler の関数。
// 見出しの [待ちにする][閉じる][会話を新しくする] と /close の確認のカードは Discord の /wait・/close・/renew と同じ処理（src/app/session-ops.ts）。
// Claude Code のチャンネル（kind cc。docs/plan/claude-code-channels.md §5.2。CC14）は同じタブで Discord と同じ流れ（発言・写し・返事・許可・終わり）を出し、
// 見出しに状態・[RC で開く]・[画面]・[Discord で開く]・[取り込む]（docs/plan/takeover.md §5.7。T5）・[閉じる]、末尾に許可のカード（保留中だけ）と送った本文の状態、入力欄から送るとそのセッションに届ける
// （ターンは動かないので実行中の行・[中断]・[続ける]・[会話を新しくする] は無い）。セッションの今は /api/cc/sessions/<id>（api.js の polling）
"use strict";

(function () {
  const SA = (window.SA = window.SA || {});
  const { el, icon, elapsed, shortTime, renderText, toast, confirm } = SA.ui;
  const store = SA.store;

  const STATE_LABEL = { active: "進行中", waiting: "待ち", done: "完了" };
  // 終わり方の文は src/app/progress.ts の progressEndText と同じ
  const OUTCOME_LABEL = { done: "完了", max_turns: "手順の上限で止まりました", aborted: "中断しました", failed: "止まりました" };
  const END_CLASS = { done: "is-done", max_turns: "is-warning", aborted: null, failed: "is-danger" };
  const DISCORD_PREFIX = "https://discord.com/channels/";
  /** これより上に近づいたら前の行を読む（px） */
  const OLDER_THRESHOLD = 64;
  /** Web から送る本文の上限（src/web/routes/turns.ts の WEB_MESSAGE_MAX_LENGTH） */
  const MESSAGE_MAX = 1900;
  const STALE_TEXT = "この操作は古くなっています";
  const TOO_LONG_TEXT = "1,900 字までです";
  /** 送れた（202）後に実行中のターンを読み直すまでの時間（ms）。進行中の読み込みに吸われても次で拾う */
  const RUNNING_RECHECK_MS = [500, 1500];
  /** 送れなかったときのトースト（応答の error ごと）。無ければ api.js の「操作に失敗しました。…」 */
  const SEND_ERRORS = {
    bot_disconnected: "送れませんでした。Bot が Discord につながっていません",
    echo_failed: "送れませんでした。Discord に投稿できません",
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
    if (ch.kind === "cc") return ch.name || "Claude Code";
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

  /** 操作の失敗のトースト（404 は古い、409 は閉じている（closing は要約中）。それ以外は応答の文を失敗のトーストで。retry があれば [もう一度]） */
  function opFailed(err, retry) {
    if (err && err.status === 404) toast(STALE_TEXT);
    else if (err && err.status === 409) toast(err.code === "no_draft" ? STALE_TEXT : err.code === "closing" ? BUSY_TEXT : CLOSED_TEXT);
    else if (err && err.toast) toast(err.toast, null, { level: "error", retry });
  }

  function setWaiting(channelId) {
    const ch = channelById(channelId);
    if (!ch || ch.kind !== "session" || ch.state !== "active") {
      toast("進行中のセッションだけ待ちにできます");
      return;
    }
    SA.api
      .post("/api/sessions/" + encodeURIComponent(channelId) + "/wait", {}, { quiet: true })
      .then(
        () => toast("「" + ch.title + "」を待ちにしました"),
        (err) => opFailed(err, () => setWaiting(channelId)),
      )
      .finally(() => reloadAfterOp(channelId));
  }

  function closeSession(channelId) {
    const ch = channelById(channelId);
    if (!ch || ch.kind !== "session" || ch.state === "done") {
      toast("閉じられるのは進行中・待ちのセッションだけです");
      return;
    }
    confirm({
      title: "閉じますか",
      target: ch.title,
      body: "会話を要約してから完了に移します。やることの候補があれば、ここか Discord で選んでから閉じます。",
      ok: "閉じる",
      run: () => startClose(channelId),
    });
  }

  /** /close を始める（確認の後。[もう一度] は確認を挟まずにここから） */
  /** 要約を待っている間の文（/close・/renew を重ねない。見出しのボタンの title・パレット・トーストで共通） */
  const BUSY_TEXT = "要約しています。終わると使えます";

  /** 要約を待っているか（パレットの候補を止めるのにも使う） */
  function busy(channelId) {
    return !!pendingOf(channelId, channelById(channelId));
  }

  async function startClose(channelId) {
    if (busy(channelId)) {
      toast(BUSY_TEXT);
      return;
    }
    const afterId = lastRealId(channelId);
    try {
      await SA.api.post("/api/sessions/" + encodeURIComponent(channelId) + "/close", {}, { quiet: true });
      setPending(channelId, "close", afterId);
    } catch (err) {
      opFailed(err, () => startClose(channelId));
    }
    SA.app.refresh("ch:" + channelId);
    reloadAfterOp(channelId);
  }

  function renew(channelId) {
    const ch = channelById(channelId);
    if (!ch) return;
    confirm({
      title: "会話を新しくしますか",
      target: channelTitle(ch),
      body: "今の会話を要約して、新しい会話に引き継ぎます。状態は変わりません。",
      ok: "新しくする",
      run: () => startRenew(channelId),
    });
  }

  /** /renew を始める（確認の後。[もう一度] は確認を挟まずにここから） */
  async function startRenew(channelId) {
    if (busy(channelId)) {
      toast(BUSY_TEXT);
      return;
    }
    const afterId = lastRealId(channelId);
    try {
      await SA.api.post("/api/channels/" + encodeURIComponent(channelId) + "/renew", {}, { quiet: true });
      setPending(channelId, "renew", afterId);
    } catch (err) {
      opFailed(err, () => startRenew(channelId));
    }
    SA.app.refresh("ch:" + channelId);
    reloadAfterOp(channelId);
  }

  /** /close の確認の確定（selected は添字の配列・"all"・"none"） */
  async function confirmClose(channelId, selected, buttons) {
    for (const b of buttons) b.disabled = true;
    try {
      const data = await SA.api.post("/api/sessions/" + encodeURIComponent(channelId) + "/close/confirm", { selected }, { quiet: true });
      delete picked[channelId];
      const registered = data && typeof data.registered === "number" ? data.registered : 0;
      toast(registered > 0 ? "閉じました。タスクを " + registered + " 件登録しました" : "閉じました");
      if (data && data.registered > 0 && store.tasks !== null) store.reload("tasks");
    } catch (err) {
      opFailed(err, () => confirmClose(channelId, selected, []));
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
      if (pick.disabled) pick.title = "候補を選ぶと押せます";
      else pick.removeAttribute("title");
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
    if (tasks.length === 0) list.append(el("p", { class: "meta", text: "やることの候補はありません。" }));
    updatePick();
    all.addEventListener("click", () => confirmClose(channelId, "all", buttons));
    pick.addEventListener("click", () => {
      if (chosen.size > 0) confirmClose(channelId, [...chosen].sort((a, b) => a - b), buttons);
    });
    none.addEventListener("click", () => confirmClose(channelId, "none", buttons));
    return el("section", { class: "card card-sm", "aria-label": "閉じる前の確認" }, [
      el("div", { class: "card-head" }, [el("h2", { text: "閉じる前の確認" }), el("span", { class: "meta", text: "Discord でも選べます" })]),
      // ラベルと値は dl（GUIDELINES §8 見出し）
      el("dl", { class: "card-facts" }, [
        el("dt", { text: "要約" }),
        el("dd", {}, [el("div", { class: "msg-text", text: String(draft.summary || "") })]),
        el("dt", { text: "タスクにする候補" }),
        el("dd", {}, [list]),
      ]),
      el("div", { class: "msg-actions" }, tasks.length === 0 ? [none] : buttons),
    ]);
  }

  // ===== Claude Code のチャンネル（CC14） =====
  const CC_STATE_LABEL = { needs_input: "判断待ち", running: "実行中", idle: "待機", ended: "終わりました" };
  const CC_SEND_ERRORS_EXTRA = {
    ended: "このセッションは終わっています。Discord のチャンネルに書くと、起動して続けられます",
    resuming: "起動中です。少し待ってから送ってください",
  };
  /** 画面の節を開いているチャンネル（既定は閉じる。このタブのメモリだけ） */
  const ccScreenOpened = new Set();
  const ccScreenOpen = (channelId) => ccScreenOpened.has(channelId);

  /**
   * そのチャンネルのセッションの今。/api/cc/sessions/<id> で読んだものがあればそれ（一覧から消えていれば ended）、無ければ /api/channels の cc。
   * session は読んだ 1 件（画面の写し・RC のリンクを含む。無ければ null）
   */
  function ccLive(ch) {
    const info = ch.cc || {};
    const loaded = typeof info.sessionId === "string" ? store.ccSessions[info.sessionId] : undefined;
    const session = loaded && loaded.session ? loaded.session : null;
    const ended = info.state === "ended" || !!(loaded && loaded.missing);
    return {
      sessionId: info.sessionId,
      session,
      loaded: !!loaded,
      state: ended ? "ended" : session ? session.state : info.state,
      permission: session ? session.permission : info.permission,
      pending: session ? session.pending : info.pending,
      inTmux: session ? !!session.inTmux : !!info.inTmux,
      rc: session ? SA.views.rcUrl(session.rcUrl) : null,
    };
  }

  /** [閉じる]（Discord の /cc close と同じ。確認の後） */
  function closeCcChannel(channelId) {
    const ch = channelById(channelId);
    if (!ch || ch.kind !== "cc") return;
    confirm({
      title: "チャンネルを閉じますか",
      target: channelTitle(ch),
      body: "Discord のチャンネルを完了に移し、届け待ちの本文をやめます。セッションは止めません。書くと続けられます。",
      ok: "閉じる",
      run: () =>
        SA.api
          .post("/api/cc/channels/" + encodeURIComponent(channelId) + "/close", {}, { quiet: true })
          .then(
            () => toast("閉じました"),
            (err) => {
              if (err && (err.status === 404 || err.status === 409)) toast(err.code === "ended" ? "このチャンネルは既に閉じています" : STALE_TEXT);
              else if (err && err.toast) toast(err.toast, null, { level: "error", retry: () => closeCcChannel(channelId) });
            },
          )
          .finally(() => {
            reloadAfterOp(channelId);
            const live = ccLive(ch);
            if (live.sessionId) store.load.ccSession(live.sessionId, { quiet: true });
          }),
    });
  }

  // ===== 取り込み（docs/plan/takeover.md §5.7。T5。Discord の /cc take と同じ行で、Discord の確認の投稿からも答えられる） =====
  /** 断られた・失敗した文がサーバーから来なかったとき */
  const TAKE_FAILED_TEXT = "取り込めませんでした。もう一度試してください";
  /** POST …/takeover の途中（[取り込む] の二度押しで確認を 2 つ作らない） */
  let takeRequesting = false;
  /** 開いている取り込みの確認（{ id, channelId, busy, done }。無ければ null） */
  let taking = null;

  /**
   * 断られた・失敗した（409）ならサーバーの文、ほかは応答の文（つながらないなど）。断られた（確認の前）は知らせのトースト、
   * 取り込みの失敗（alert）は失敗のトースト（端末が終わったかもしれないことを消さずに残す）
   */
  function takeFailed(err, alert) {
    const text = err && err.data && typeof err.data.text === "string" && err.data.text !== "" ? err.data.text : null;
    if (err && err.status === 409) toast(text || TAKE_FAILED_TEXT, null, alert ? { level: "error" } : undefined);
    else if (err && err.status === 404) toast(STALE_TEXT);
    else toast(err && err.toast ? err.toast : TAKE_FAILED_TEXT, null, { level: "error" });
  }

  /** タブの中身を作り直す（取り込んだ後はセッションの種類で開き直す。終わった端末の状態も読み直す） */
  function reloadTaken(channelId) {
    store.resetTurns(channelId);
    ccScreenOpened.delete(channelId);
    // 入力欄も作り直す（説明の title が種類ごと。書きかけは SA.app.draft に残っている）
    for (const node of document.querySelectorAll(".composer-wrap")) if (node.getAttribute("data-channel") === channelId) node.remove();
    SA.app.refresh("ch:" + channelId);
    Promise.all([store.load.channels(), store.load.turns(channelId)]).then(() => SA.app.refreshTabs());
    setTimeout(() => store.load.turns(channelId), OP_RECHECK_MS);
  }

  /** 見出しの [取り込む] に焦点を戻す（ダイアログを開いたボタン。描き直していれば今のもの。無ければ何もしない） */
  function focusTakeButton(channelId) {
    const header = [...document.querySelectorAll(".ed-toolbar")].find((node) => node.getAttribute("data-channel") === channelId);
    const button = header && header.querySelector('[data-op="take"]');
    if (button && !button.disabled && button.offsetParent !== null) button.focus();
  }

  /** [取り込む]: 確認を作り（POST …/takeover）、サーバーの確認の文をダイアログに出す。断られたらその文 */
  function takeoverCc(channelId) {
    const ch = channelById(channelId);
    if (!ch || ch.kind !== "cc" || takeRequesting || taking) return;
    const live = ccLive(ch);
    if (typeof live.sessionId !== "string") return;
    takeRequesting = true;
    SA.api
      .post("/api/cc/sessions/" + encodeURIComponent(live.sessionId) + "/takeover", {}, { quiet: true })
      .then(
        (data) => {
          if (data && typeof data.id === "number" && typeof data.text === "string") openTakeDialog(channelId, data.id, data.text);
          else toast(TAKE_FAILED_TEXT, null, { level: "error" });
        },
        (err) => takeFailed(err, false),
      )
      .finally(() => {
        takeRequesting = false;
      });
  }

  /** 確認のダイアログ: [取り込む] → POST …/confirm（待つ間はボタンを止める）、[やめる]・閉じた → POST …/cancel（失敗は出さない） */
  function openTakeDialog(channelId, id, text) {
    const dialog = document.getElementById("dlg-cc-take");
    const ok = document.getElementById("dlg-cc-take-ok");
    const cancel = document.getElementById("dlg-cc-take-cancel");
    const status = document.getElementById("dlg-cc-take-status");
    // 文はサーバーのものをそのまま（改行は .dlg-text で保つ）
    document.getElementById("dlg-cc-take-body").textContent = text;
    const state = { id, channelId, busy: false, done: false };
    taking = state;
    const setBusy = (busy) => {
      state.busy = busy;
      ok.disabled = busy;
      cancel.disabled = busy;
      status.hidden = !busy;
      if (busy) dialog.setAttribute("aria-busy", "true");
      else dialog.removeAttribute("aria-busy");
    };
    const finish = () => {
      if (state.done) return;
      state.done = true;
      ok.removeEventListener("click", onOk);
      cancel.removeEventListener("click", onCancel);
      dialog.removeEventListener("close", onClose);
      dialog.removeEventListener("cancel", onEsc);
      setBusy(false);
      taking = null;
      SA.ui.closeDialog(dialog);
      focusTakeButton(channelId);
    };
    const onOk = () => {
      if (state.busy || state.done) return;
      setBusy(true);
      SA.api
        .post("/api/cc/takeovers/" + encodeURIComponent(String(id)) + "/confirm", {}, { quiet: true })
        .then(
          (data) => {
            finish();
            if (data && typeof data.text === "string" && data.text !== "") toast(data.text);
          },
          (err) => {
            finish();
            takeFailed(err, true);
          },
        )
        .finally(() => reloadTaken(channelId));
    };
    // [やめる]・Esc・backdrop: 確認をやめる（取り込みの途中は閉じても続き、結果は戻ってから出す）
    const onCancel = () => SA.ui.closeDialog(dialog);
    const onEsc = (event) => {
      if (state.busy) event.preventDefault();
    };
    const onClose = () => {
      if (state.busy || state.done) return;
      finish();
      SA.api.post("/api/cc/takeovers/" + encodeURIComponent(String(id)) + "/cancel", {}, { quiet: true }).catch(() => undefined);
    };
    ok.addEventListener("click", onOk);
    cancel.addEventListener("click", onCancel);
    dialog.addEventListener("close", onClose);
    dialog.addEventListener("cancel", onEsc);
    setBusy(false);
    SA.ui.openDialog(dialog);
    ok.focus();
  }

  /**
   * パレットの Claude Code のチャンネルのコマンドの材料: 閉じられるか（終わっていない）・RC のリンク（読んだ 1 件にあるときだけ）・Discord のリンク。
   * cc のチャンネルでなければ null
   */
  function ccCommandState(channelId) {
    const ch = channelById(channelId);
    if (!ch || ch.kind !== "cc") return null;
    const live = ccLive(ch);
    return { closable: live.state !== "ended", rc: live.rc, discord: discordUrl(ch.link) };
  }

  /** 見出し（状態・[RC で開く]・[画面]・[Discord で開く]・[取り込む]・[閉じる]） */
  function ccHeader(ch, channelId) {
    const live = ccLive(ch);
    const titleRow = el("div", { class: "ed-title" }, [
      SA.ui.backButton(),
      icon("terminal"),
      el("h1", { text: channelTitle(ch) }),
      live.state && CC_STATE_LABEL[live.state]
        ? el("span", { class: "badge" + (live.state === "needs_input" ? " badge-accent" : ""), text: CC_STATE_LABEL[live.state] })
        : null,
      live.state === "running" ? el("span", { class: "spinner", role: "img", "aria-label": "実行中" }) : null,
    ]);
    const actions = el("div", { class: "ed-actions" });
    // 狭い画面（≤639px）では [画面] だけ残し、リンクと [閉じる] は […] のコマンドへ（hide-sm と .ed-ops の規則）
    if (live.rc) actions.append(el("a", { class: "btn btn-ghost btn-sm hide-sm", href: live.rc, target: "_blank", rel: "noreferrer noopener" }, [icon("external-link"), "RC で開く"]));
    const opened = ccScreenOpen(channelId);
    const screen = el("button", {
      class: "btn btn-ghost btn-sm",
      type: "button",
      "aria-expanded": opened ? "true" : "false",
      "aria-controls": "cc-screen-" + channelId,
      title: "開いている間は 3 秒ごとに更新",
    }, [
      icon("terminal"),
      "画面",
    ]);
    screen.addEventListener("click", () => {
      if (ccScreenOpened.has(channelId)) ccScreenOpened.delete(channelId);
      else ccScreenOpened.add(channelId);
      if (ccScreenOpened.has(channelId) && live.sessionId) store.load.ccSession(live.sessionId, { quiet: true });
      SA.app.refresh("ch:" + channelId);
    });
    actions.append(screen);
    const discord = discordUrl(ch.link);
    if (discord) actions.append(el("a", { class: "btn btn-ghost btn-sm hide-sm", href: discord, target: "_blank", rel: "noreferrer" }, [icon("external-link"), "Discord で開く"]));
    const closeOff = live.state === "ended";
    const close = el("button", { class: "btn btn-secondary btn-sm", type: "button", disabled: closeOff, title: closeOff ? "閉じています" : null }, [icon("check"), "閉じる"]);
    close.addEventListener("click", () => closeCcChannel(channelId));
    // [取り込む]（開いていても終わっていても。取り込めるかはサーバーが確かめ、断られたらその文を出す）
    const take = el("button", { class: "btn btn-ghost btn-sm", type: "button", "data-op": "take", title: "この会話を self-agent のセッションとして続けます" }, [icon("message-square"), "取り込む"]);
    take.addEventListener("click", () => takeoverCc(channelId));
    const more = el("button", { class: "btn btn-ghost btn-sm btn-icon-sm ed-ops-more", type: "button", "aria-label": "ほかの操作", title: "ほかの操作" }, [icon("ellipsis")]);
    // このチャンネルの操作だけのシート（パレットは移動用）
    more.addEventListener("click", () =>
      SA.app.sheet(
        channelTitle(ch) + " の操作",
        [
          live.rc ? { icon: "external-link", label: "RC で開く", href: live.rc } : null,
          discord ? { icon: "external-link", label: "Discord で開く", href: discord } : null,
          { icon: "message-square", label: "取り込む", run: () => takeoverCc(channelId) },
          { icon: "check", label: "閉じる", run: closeOff ? null : () => closeCcChannel(channelId), why: "閉じています" },
        ].filter(Boolean),
        more,
      ),
    );
    actions.append(el("div", { class: "ed-ops" }, [take, close, more]));
    return el("header", { class: "ed-toolbar", "data-channel": channelId }, [titleRow, actions]);
  }

  /** 画面の写しの節（開いているときだけ） */
  function ccScreenSection(ch, channelId) {
    if (!ccScreenOpen(channelId)) return null;
    const live = ccLive(ch);
    let body;
    if (!live.session) body = el("p", { class: "meta", text: live.state === "ended" ? "セッションが一覧にありません。" : "読み込んでいます…" });
    else if (!live.inTmux) body = el("p", { class: "meta", text: "tmux の外のセッションです。画面は見られません。" });
    else if (typeof live.session.screen !== "string") body = el("p", { class: "meta", text: "画面を読めませんでした。" });
    else body = el("pre", { class: "code-pre cc-screen", text: live.session.screen });
    return el("section", { class: "card card-sm", id: "cc-screen-" + channelId, "aria-label": "画面" }, [el("div", { class: "card-head" }, [el("h2", { text: "画面" })]), body]);
  }

  // ===== 描画 =====
  /** Bot の名前を吹き出しの上に出すか（人格が 2 体以上のときと Claude Code のチャンネル。オーナーの名前は出さない） */
  function showsAgentName(ch) {
    return !!(ch && ch.kind === "cc") || !!(store.channels && store.channels.personas.length > 1);
  }

  /** 直前の行が同じ話者の Bot の返事か（続けて出す名前は省く。LINE の形）。persona は今の行の人格 */
  function followsSameAgent(prev, ch, personaId) {
    if (!prev || prev.kind !== "agent") return false;
    if (ch && ch.kind === "cc") return true;
    return (prev.persona || "default") === (personaId || "default");
  }

  /**
   * 吹き出しの 1 行（msg-owner は右・msg-agent は左）。label は読み上げの話者（article の aria-label）、
   * name は吹き出しの上に見せる名前（null なら出さない）、time は吹き出しの下
   */
  function bubbleRow(side, label, name, bubbleChildren, time, attrs) {
    return el("article", Object.assign({ class: "msg msg-" + side, "aria-label": label }, attrs || {}), [
      name ? el("span", { class: "msg-name", text: name }) : null,
      el("div", { class: "msg-bubble" }, bubbleChildren),
      time,
    ]);
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

  /** prev は直前の行（同じ話者の Bot が続くなら名前を出さない） */
  function renderTurn(turn, channelId, ch, prev) {
    if (turn.kind === "divider") {
      return el("div", { class: "tl-divider", role: "separator" }, [el("span", { text: turn.text })]);
    }
    if (turn.kind === "notice") {
      return el("div", { class: "tl-notice" }, [icon("info"), el("span", { text: turn.text }), timeOf(turn)]);
    }
    if (turn.kind === "owner") {
      return bubbleRow("owner", "オーナー", null, [el("div", { class: "msg-text", text: turn.text })], timeOf(turn));
    }
    // agent。Claude Code のチャンネルの返事は名前を Claude Code にし、手順は出さない（記録が無い）
    if (ch && ch.kind === "cc") {
      return bubbleRow("agent", "Claude Code", followsSameAgent(prev, ch, turn.persona) ? null : "Claude Code", [el("div", { class: "msg-text msg-md" }, [renderText(turn.text)])], timeOf(turn));
    }
    const p = persona(turn.persona);
    const body = [];
    if (turn.outcome) {
      const opened = openStepsOf(channelId);
      // 枠も地も付けない 1 行（終わり方の文）。押すとすべての手順
      const details = el("details", { class: "steps-plain", open: opened.has(turn.id) }, [
        el("summary", { class: END_CLASS[turn.outcome] || null }, [
          icon("chevron-right", "steps-chevron"),
          // 終わり方は文の色で（アイコンは chevron の 1 つだけ）
          el("span", { text: endText(turn) }),
        ]),
        stepsList(Array.isArray(turn.steps) ? turn.steps : []),
      ]);
      details.addEventListener("toggle", () => {
        if (details.open) opened.add(turn.id);
        else opened.delete(turn.id);
      });
      body.push(details);
    }
    // 返事の本文は最小限の Markdown（ui.js の renderText。リンクは http(s) の URL だけ）
    body.push(el("div", { class: "msg-text msg-md" }, [renderText(turn.text)]));
    const name = showsAgentName(ch) && !followsSameAgent(prev, ch, turn.persona) ? p.name : null;
    return bubbleRow("agent", p.name, name, body, timeOf(turn));
  }

  /** 実行中の行の「すべての手順」を開いたチャンネル（描き直しで閉じ直さない。既定は閉じる。このタブのメモリだけ） */
  const stepsOpened = new Set();
  /** 実行中の行に薄い文字で出す直近の手順の数 */
  const RECENT_STEPS = 3;

  /** 「すべての手順」の見出し。手順は直近 30 件しか届かない（handler.ts）ので、ツールの回数より少なければ「直近の手順」 */
  function allStepsLabel(run) {
    return (run.toolCalls > run.steps.length ? "直近の手順（" : "すべての手順（") + run.steps.length + "）";
  }

  /** 実行中のターンの行（is-running）。[中断] は中断できるターン（セッション）だけ */
  function renderRunning(ch, run, prev) {
    const p = persona(ch ? ch.persona : "default");
    // 1 行目: スピナー + 「作業中…（経過・ツール n 回）」（数字は 1 秒ごとに data-run-progress の文字だけ変える）
    const line = el("div", { class: "run-line" }, [el("span", { class: "spinner", "aria-hidden": "true" }), el("span", { "data-run-progress": run.channelId, text: progressText(run) })]);
    // 直近の手順を薄い文字で（最後が今の手順）
    const recent = el("ol", { class: "run-recent" });
    const last = run.steps.slice(-RECENT_STEPS);
    last.forEach((s, i) => recent.append(el("li", { class: i === last.length - 1 ? "is-current" : null, text: s })));
    if (run.steps.length === 0) recent.append(el("li", { text: "まだ手順はありません" }));
    const body = [line];
    // 許可を待っている間は、その 1 行（プロジェクトのセッション。答えは会話の許可のカードで）
    const waiting = store.runningWaitingText(run);
    if (waiting) body.push(el("div", { class: "run-waiting", text: waiting }));
    body.push(recent);
    // 直近に収まらないときだけ、押して開くすべての手順
    if (run.steps.length > RECENT_STEPS) {
      const details = el("details", { class: "steps-plain", open: stepsOpened.has(run.channelId) }, [
        el("summary", {}, [icon("chevron-right", "steps-chevron"), el("span", { text: allStepsLabel(run) })]),
        stepsList(run.steps),
      ]);
      details.addEventListener("toggle", () => {
        if (details.open) stepsOpened.add(run.channelId);
        else stepsOpened.delete(run.channelId);
      });
      body.push(details);
    }
    // [中断] も Bot 側の吹き出しの中（実行中であることはスピナーと「作業中…」で分かる）
    if (run.abortable) {
      const abort = el("button", { class: "btn btn-secondary btn-sm", type: "button" }, [icon("square"), "中断"]);
      abort.addEventListener("click", () => abortTurn(run.channelId, run.turnSeq, abort));
      body.push(el("div", { class: "msg-actions" }, [abort]));
    }
    const name = showsAgentName(ch) && !followsSameAgent(prev, ch, ch ? ch.persona : "default") ? p.name : null;
    return bubbleRow("agent", "作業中", name, body, null, { class: "msg msg-agent is-running", "aria-busy": "true" });
  }

  /** [中断]。button は押したもの（[もう一度] からは null） */
  async function abortTurn(channelId, turnSeq, button) {
    if (button) button.disabled = true;
    // 音（sound.js）はこのチャンネルの次の終わりで鳴らさない。応答より先に終わりを読むことがあるので押した時点で知らせ、中断できなければ取り消す
    SA.events.emit("aborted", { channelId });
    try {
      await SA.api.post("/api/channels/" + encodeURIComponent(channelId) + "/turns/" + turnSeq + "/abort", {}, { quiet: true });
    } catch (err) {
      SA.events.emit("abortFailed", { channelId });
      if (err && err.status === 409) toast(STALE_TEXT);
      else if (err && err.toast) toast(err.toast, null, { level: "error", retry: () => abortTurn(channelId, turnSeq, null) });
      if (button) button.disabled = false;
    }
    SA.poll.running();
  }

  /** [続ける]: 手順の上限で止まった最後の返事（セッション・実行中のターンが無いとき）。押したら隠す（このタブのメモリだけ） */
  const continued = new Set();
  function continueButton(channelId, turn) {
    const button = el("button", { class: "btn btn-secondary btn-sm", type: "button" }, [icon("play"), "続ける"]);
    button.addEventListener("click", () => continueTurn(channelId, turn, button));
    return el("div", { class: "msg-actions" }, [button]);
  }

  /** [続ける] を送る。button は押したもの（[もう一度] からは null） */
  async function continueTurn(channelId, turn, button) {
    if (button) button.disabled = true;
    try {
      await SA.api.post("/api/channels/" + encodeURIComponent(channelId) + "/continue", {}, { quiet: true });
      continued.add(turn.id);
      SA.poll.running();
      SA.app.refresh("ch:" + channelId);
    } catch (err) {
      if (err && err.status === 409) toast(err.code === "running" ? "実行中のターンがあります" : STALE_TEXT);
      else if (err && err.status === 404) toast(STALE_TEXT);
      else if (err && err.toast) toast(err.toast, null, { level: "error", retry: () => continueTurn(channelId, turn, null) });
      if (button) button.disabled = false;
    }
  }

  function header(ch, channelId) {
    if (ch && ch.kind === "cc") return ccHeader(ch, channelId);
    if (!ch) {
      return el("header", { class: "ed-toolbar" }, [el("div", { class: "ed-title" }, [SA.ui.backButton(), icon("hash"), el("h1", { text: "会話" })]), el("div", { class: "ed-actions" })]);
    }
    const isSession = ch.kind === "session";
    const p = persona(ch.persona);
    const titleRow = el("div", { class: "ed-title" }, [
      SA.ui.backButton(),
      icon(isSession ? "message-square" : "hash"),
      el("h1", { text: isSession ? ch.title || "" : ch.name || ch.kind }),
      isSession && STATE_LABEL[ch.state] ? el("span", { class: "badge state-" + ch.state, text: STATE_LABEL[ch.state] }) : null,
      // 人格が 1 体だけなら毎回同じ語になるので出さない
      store.channels && store.channels.personas.length > 1 ? el("span", { class: "badge", text: p.name + (p.isDefault ? "" : "（人格）") }) : null,
    ]);
    const actions = el("div", { class: "ed-actions" });
    // プロジェクトのセッション（docs/plan/unify.md）: プロジェクトと許可のモード（モードの切り替えは後の段）
    if (isSession && ch.projectDir) {
      actions.append(
        el("span", { class: "badge hide-sm", title: "プロジェクトのセッション（許可のモード: " + ch.projectDir.permissionMode + "）" }, [
          icon("terminal"),
          ch.projectDir.dir,
        ]),
      );
    }
    // 狭い画面（≤639px）ではプロジェクト・リンクも隠し、[…] のシートに入れる（見出しを 1 行にする）
    const url = ch.project ? pageUrl(ch.project.url) : null;
    if (ch.project) {
      actions.append(el("span", { class: "badge hide-sm", title: "プロジェクト" }, [icon("folder"), ch.project.slug]));
      if (url) actions.append(el("a", { class: "btn btn-ghost btn-sm hide-sm", href: url, target: "_blank", rel: "noreferrer" }, [icon("external-link"), "ページ"]));
    }
    const discord = discordUrl(ch.link);
    if (discord) actions.append(el("a", { class: "btn btn-ghost btn-sm hide-sm", href: discord, target: "_blank", rel: "noreferrer" }, [icon("external-link"), "Discord"]));
    // 要約を待っている間は操作を重ねない
    const busy = !!pendingOf(channelId, ch);
    const ops = el("div", { class: "ed-ops" });
    // secondary は [閉じる] だけ、他は ghost（GUIDELINES §5 ボタン）。押せないときは理由を title に
    const busyWhy = BUSY_TEXT;
    const waitOff = busy || ch.state !== "active";
    const closeOff = busy || ch.state === "done";
    if (isSession) {
      const wait = el("button", { class: "btn btn-ghost btn-sm", type: "button", disabled: waitOff, title: waitOff ? (busy ? busyWhy : "進行中のときだけ待ちにできます") : null }, [
        icon("pause"),
        "待ちにする",
      ]);
      wait.addEventListener("click", () => setWaiting(channelId));
      const close = el("button", { class: "btn btn-secondary btn-sm", type: "button", disabled: closeOff, title: closeOff ? (busy ? busyWhy : "閉じています") : null }, [
        icon("check"),
        "閉じる",
      ]);
      close.addEventListener("click", () => closeSession(channelId));
      ops.append(wait, close);
    }
    const renewBtn = el("button", { class: "btn btn-ghost btn-sm", type: "button", disabled: busy, title: busy ? busyWhy : null }, [icon("rotate-ccw"), "会話を新しくする"]);
    renewBtn.addEventListener("click", () => renew(channelId));
    // 狭い画面（≤639px）では上の操作を隠し、[…] でこのチャンネルの操作だけのシートを開く（CSS で出し分ける。パレットは移動用）
    const more = el("button", { class: "btn btn-ghost btn-sm btn-icon-sm ed-ops-more", type: "button", "aria-label": "ほかの操作", title: "ほかの操作" }, [icon("ellipsis")]);
    more.addEventListener("click", () =>
      SA.app.sheet(
        channelTitle(ch) + " の操作",
        [
          isSession ? { icon: "pause", label: "待ちにする", run: waitOff ? null : () => setWaiting(channelId), why: busy ? busyWhy : "進行中のときだけ" } : null,
          isSession ? { icon: "check", label: "閉じる", run: closeOff ? null : () => closeSession(channelId), why: busy ? busyWhy : "閉じています" } : null,
          { icon: "rotate-ccw", label: "会話を新しくする", run: busy ? null : () => renew(channelId), why: busyWhy },
          url ? { icon: "external-link", label: "ページを開く", href: url } : null,
          discord ? { icon: "external-link", label: "Discord で開く", href: discord } : null,
        ].filter(Boolean),
        more,
      ),
    );
    ops.append(renewBtn, more);
    actions.append(ops);
    return el("header", { class: "ed-toolbar", "data-channel": channelId }, [titleRow, actions]);
  }

  // ===== 入力欄（Enter で送る・Shift+Enter で改行。タッチが主の端末では Enter は改行で、送るのはボタン。
  // どちらでも Ctrl+Enter・⌘+Enter で送る。IME の変換中の Enter は送らない） =====
  const touchQuery = window.matchMedia ? window.matchMedia("(pointer: coarse) and (hover: none)") : null;
  /** 画面のキーボードが主の端末か（Shift が無いので Enter は改行にする） */
  const touchPrimary = () => Boolean(touchQuery && touchQuery.matches);
  /** 画面のキーボードの Enter の表示（タッチが主なら改行、それ以外は送る） */
  const enterHint = () => (touchPrimary() ? "enter" : "send");
  // placeholder は動詞句だけ（GUIDELINES §5 入力欄）。キーの説明は設定のキー一覧と入力欄の title
  const placeholderOf = (title) => title + " に送る";
  // 外付けのキーボード・トラックパッドの付け外しで判定が変わったら、出ている入力欄の案内を合わせる
  if (touchQuery && touchQuery.addEventListener) {
    touchQuery.addEventListener("change", () => {
      for (const ta of document.querySelectorAll(".composer-input")) {
        ta.placeholder = placeholderOf(ta.dataset.title || "会話");
        ta.setAttribute("enterkeyhint", enterHint());
      }
    });
  }
  /** 入力欄のキー（Claude Code のセッションのタブの入力欄も同じ）: Enter で送る（タッチが主の端末では改行）・Shift+Enter で改行・Ctrl+Enter・⌘+Enter はいつも送る。IME の変換中は送らない */
  function bindSendKeys(ta, submit) {
    ta.addEventListener("keydown", (event) => {
      if (event.key !== "Enter" || event.isComposing || event.keyCode === 229) return;
      const send = event.ctrlKey || event.metaKey || (!event.shiftKey && !touchPrimary());
      if (send) {
        event.preventDefault();
        submit();
      }
    });
  }

  function composer(ch, channelId) {
    const title = ch ? channelTitle(ch) : "会話";
    const ta = el("textarea", {
      class: "textarea composer-input",
      rows: "2",
      maxlength: "4000",
      "aria-label": title + " に送る",
      enterkeyhint: enterHint(),
      "data-title": title,
      placeholder: placeholderOf(title),
      title:
        ch && ch.kind === "cc"
          ? "このセッションに届けます（入力待ちのときに貼ります）。返事はここと Discord の両方に出ます"
          : "Discord で発言したのと同じ経路で 1 ターン動きます。返事はここと Discord の両方に出ます",
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
      if (sendBtn.disabled) sendBtn.title = sending ? "送っています" : "本文を入れると送れます";
      else sendBtn.removeAttribute("title");
    };
    update();
    ta.addEventListener("input", () => {
      SA.app.setDraft(channelId, ta.value);
      update();
    });
    const form = el("form", { class: "composer", novalidate: true }, [
      ta,
      el("div", { class: "composer-foot" }, [
        el("span", { class: "composer-hint" }),
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
        // 受け付けた（202）: 音（sound.js）はここで「受け付けた」を鳴らす
        SA.events.emit("sent", { channelId });
        // 送れたら書きかけを消し、本物の行が来るまで仮の行を出す
        if (ta.value.trim() === text) ta.value = "";
        SA.app.setDraft(channelId, ta.value);
        const current = channelById(channelId);
        if (current && current.kind === "cc") {
          // Claude Code のチャンネル: 行（写し）はサーバーが書いている。届くまでの状態はセッションの今で出す
          store.load.turns(channelId);
          const live = ccLive(current);
          if (live.sessionId) store.load.ccSession(live.sessionId, { quiet: true });
          return;
        }
        store.addOptimisticTurn(channelId, data && data.turnId, text);
        store.load.turns(channelId);
        SA.poll.running();
        for (const ms of RUNNING_RECHECK_MS) setTimeout(() => store.load.running({ quiet: true }), ms);
      } catch (err) {
        // 本文は入力欄に残す。[もう一度] は入力欄の今の本文を送り直す
        const known = err && err.code && (SEND_ERRORS[err.code] || CC_SEND_ERRORS_EXTRA[err.code] || SA.views.CC_SEND_ERRORS[err.code]);
        if (err && err.toast) toast(known || err.toast, null, { level: "error", retry: submit });
      } finally {
        sending = false;
        update();
      }
    };
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      submit();
    });
    bindSendKeys(ta, submit);
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
      container.replaceChildren(header(ch, channelId), el("div", { class: "ed-scroll" }, [el("div", { class: "ed-page" }, [SA.views.loading()])]));
      return;
    }
    if (t.missing) {
      container.replaceChildren(
        header(null, channelId),
        el("div", { class: "ed-scroll" }, [el("div", { class: "empty" }, [icon("info"), el("p", { text: "このチャンネルは開けません。削除されたか、受け付けないチャンネルです。" })])]),
      );
      return;
    }
    // 会話の行は先に並べ、最後に .tl に入れる（質問のカードが前と同じなら、前の .tl を残してカードを動かさない）
    const parts = [];
    const timeline = { append: (...nodes) => parts.push(...nodes) };
    if (t.hasMore) {
      const more = el("button", { class: "btn btn-ghost btn-sm", type: "button", text: "前の会話を読む" });
      more.addEventListener("click", () => loadOlder(channelId));
      timeline.append(el("div", { class: "tl-hint" }, [more]));
    }
    const isCc = !!(ch && ch.kind === "cc");
    // Claude Code のチャンネルにはターンが無い（実行中の行・[続ける] は出さない）
    const run = isCc ? null : store.runningOf(channelId);
    const last = t.turns[t.turns.length - 1];
    let prev = null;
    for (const turn of t.turns) {
      const node = renderTurn(turn, channelId, ch, prev);
      prev = turn;
      // 手順の上限で止まった最後の返事には [続ける]（セッションで、実行中のターンが無いとき）
      if (turn === last && turn.kind === "agent" && turn.outcome === "max_turns" && ch && ch.kind === "session" && !run && !continued.has(turn.id)) {
        // 吹き出しの下に左寄せ
        node.append(continueButton(channelId, turn));
      }
      timeline.append(node);
    }
    if (run) timeline.append(renderRunning(ch, run, prev));
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
    let ccPending = null;
    let card = null;
    if (isCc) {
      const live = ccLive(ch);
      // 一度も読んでいなければセッションの今を読む（その後は api.js の polling）
      if (!live.loaded && live.sessionId) store.load.ccSession(live.sessionId, { quiet: true });
      // 一覧から開いた直後（チャンネルがまだ分からなかった）でも、セッションの今の polling を始める
      SA.poll.kickCc();
      const p = live.permission;
      if (p && p.state === "pending") {
        card = SA.views.ccPermissionCard(live.sessionId, p, live.rc, "ch:" + channelId);
        if (card) timeline.append(card);
      } else if (p && typeof p.id === "number") {
        // 終わった質問の選んだ状態を捨てる（このタブでは終わったカードを出さない）
        SA.views.ccQuestionForget(p.id);
      }
      const screen = ccScreenSection(ch, channelId);
      if (screen) timeline.append(screen);
      if (live.state === "ended") {
        timeline.append(el("p", { class: "tl-hint", text: "このセッションは終わっています。Discord のチャンネルに書くと、同じディレクトリで起動して続けられます。" }));
      }
      ccPending = live.sessionId ? SA.views.ccPendingBar(live.sessionId, live.pending) : null;
    } else if (ch && ch.kind === "session" && ch.permission && typeof ch.permission.id === "number") {
      // プロジェクトのセッション（docs/plan/unify.md §6.1 の 5）の許可の要求。Claude Code のチャンネルと同じカード・同じ /api/cc/permissions/<id>/*
      const p = ch.permission;
      if (p.state === "pending") {
        card = SA.views.ccPermissionCard(p.sessionId, p, null, "ch:" + channelId);
        if (card) timeline.append(card);
      } else {
        SA.views.ccQuestionForget(p.id);
      }
    }
    if (t.turns.length === 0 && !run) {
      timeline.append(
        el("p", { class: "tl-hint", text: isCc ? "まだ会話はありません。下の欄か Discord で送ると、このセッションに届きます。" : "まだ会話はありません。下の欄か Discord で送ると始まります。" }),
      );
    }
    if (ch && ch.kind === "session" && ch.state === "done") {
      timeline.append(el("p", { class: "tl-hint", text: "完了したセッションです。発言すると進行中に戻ります。" }));
    }
    // 前に描いたカード（質問の書きかけ）が前の .tl にあれば、その .ed-scroll と .tl を残して中身だけを並べ直す（外すと焦点・IME の変換が切れる）
    const oldScroll = card ? [...container.children].find((child) => child.classList.contains("ed-scroll") && child.getAttribute("data-channel") === channelId) : null;
    const oldTimeline = oldScroll && card.parentNode && card.parentNode.parentNode === oldScroll ? card.parentNode : null;
    let scroll;
    if (oldTimeline) {
      SA.views.placeChildren(oldTimeline, parts);
      scroll = oldScroll;
    } else {
      scroll = el("div", { class: "ed-scroll", "data-stick": "bottom", "data-channel": channelId }, [el("div", { class: "tl" }, parts)]);
      scroll.addEventListener("scroll", () => {
        if (scroll.scrollTop < OLDER_THRESHOLD) loadOlder(channelId);
      });
    }
    // 入力欄は作り直さない（書きかけ・フォーカス・IME の変換を保つ）。見出しと会話だけを入れ替える
    const kept = [...container.children].find((child) => child.classList.contains("composer-wrap") && child.getAttribute("data-channel") === channelId);
    // 送った本文の状態（Claude Code のチャンネル。[やめる]）は入力欄の上
    SA.views.placeChildren(container, [header(ch, channelId), scroll, ccPending, kept || composer(ch, channelId)]);
    markSeen(channelId);
  }

  /** タブの見出し。チャンネルがまだ分からなければ「会話」 */
  function info(channelId) {
    const ch = channelById(channelId);
    return {
      title: ch ? channelTitle(ch) : "会話",
      icon: ch && ch.kind === "session" ? "message-square" : ch && ch.kind === "cc" ? "terminal" : "hash",
      dirty: !!store.runningOf(channelId),
      render: (container) => render(container, channelId),
      onOpen: () => {
        store.load.turns(channelId);
        // Claude Code のチャンネル: セッションの今を読み、一覧・画面の polling を始め直す
        if (ch && ch.kind === "cc") {
          const live = ccLive(ch);
          if (live.sessionId) store.load.ccSession(live.sessionId, { quiet: true });
          SA.poll.kickCc();
        }
      },
      onClose: () => {
        delete openSteps[channelId];
        stepsOpened.delete(channelId);
        delete picked[channelId];
        ccScreenOpened.delete(channelId);
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

  SA.chat = {
    info,
    channelTitle,
    activeChannelId,
    markSeenActive,
    channelsChanged,
    endText,
    STATE_LABEL,
    current,
    channelById,
    setWaiting,
    closeSession,
    renew,
    busy,
    BUSY_TEXT,
    bindSendKeys,
    placeholderOf,
    enterHint,
    ccScreenOpen,
    closeCcChannel,
    takeoverCc,
    ccCommandState,
  };
})();
