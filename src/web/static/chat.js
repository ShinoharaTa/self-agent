// 会話（#inbox・#tasks・#<NAME>・セッション）のタブ。SA.store.turns[channelId] の行と実行中のターン（SA.store.running）を描き、見ている間は既読にする。
// 入力欄から送ると Discord の発言と同じ経路で 1 ターン動く（POST /messages）。[中断]・[続ける] は Discord のボタンと同じ handler の関数。
// 見出しの [待ちにする][閉じる][会話を新しくする] と /close の確認のカードは Discord の /wait・/close・/renew と同じ処理（src/app/session-ops.ts）。
// 右腕の場所を変える確認のカード（/turns の channel.moveProposal）は Discord の [変える][このまま] と同じ処理（POST /api/topics/moves/<id>/accept・/keep）。
// Claude Code のチャンネル（kind cc。docs/plan/claude-code-channels.md §5.2。CC14）は同じタブで Discord と同じ流れ（発言・写し・返事・許可・終わり）を出し、
// 見出しに状態・[RC で開く]・[画面]・[Discord で開く]・[閉じる]、末尾に許可のカード（保留中だけ）と送った本文の状態、入力欄から送るとそのセッションに届ける
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
  /** Claude Code のチャンネルで送れた（202）後に、セッションの今を読み直すまでの時間（ms）。届け待ち → 届けた → 作業中を早く拾う */
  const CC_SEND_RECHECK_MS = [1000, 3000, 6000];
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
  /** 待ちの行・空の文・完了の文（古い描き方と部品のカードで同じ文） */
  const WAIT_CLOSE_TEXT = "閉じる前の要約をしています…";
  const WAIT_RENEW_TEXT = "会話を新しくしています…";
  const EMPTY_TEXT = "まだ会話はありません。下の欄か Discord で送ると始まります。";
  const DONE_TEXT = "完了したセッションです。発言すると進行中に戻ります。";
  /** Claude Code のチャンネルの終わった文と空の文（古い描き方と部品のカードで同じ文） */
  const CC_ENDED_TEXT = "このセッションは終わっています。Discord のチャンネルに書くと、同じディレクトリで起動して続けられます。";
  const CC_EMPTY_TEXT = "まだ会話はありません。下の欄か Discord で送ると、このセッションに届きます。";

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

  /** 読んでいる会話（SA.app.readingChannelIds。隠れた列・重ねた右腕の下は入らない）で、画面が見えているときだけ、読んだ最後の行まで既読にする */
  function markSeen(channelId) {
    if (!SA.app.readingChannelIds().includes(channelId) || document.visibilityState !== "visible") return;
    const t = store.turns[channelId];
    if (!t || t.turns.length === 0) return;
    if (store.markSeen(channelId, t.turns[t.turns.length - 1].id)) {
      SA.app.refreshSidebar();
      SA.app.refreshStatus();
    }
  }

  function markSeenShown() {
    for (const id of SA.app.readingChannelIds()) markSeen(id);
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

  /** /close の確認の確定（selected は添字の配列・"all"・"none"）。通ったかに resolve する */
  async function confirmClose(channelId, selected, buttons) {
    for (const b of buttons) b.disabled = true;
    let ok = false;
    try {
      const data = await SA.api.post("/api/sessions/" + encodeURIComponent(channelId) + "/close/confirm", { selected }, { quiet: true });
      delete picked[channelId];
      const registered = data && typeof data.registered === "number" ? data.registered : 0;
      toast(registered > 0 ? "閉じました。タスクを " + registered + " 件登録しました" : "閉じました");
      if (data && data.registered > 0 && store.tasks !== null) store.reload("tasks");
      ok = true;
    } catch (err) {
      opFailed(err, () => confirmClose(channelId, selected, []));
      for (const b of buttons) b.disabled = false;
    }
    reloadAfterOp(channelId);
    return ok;
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

  // ===== 右腕の場所を変える確認（M6g。Discord の [変える][このまま] と同じ処理） =====
  const MOVE_STALE_TEXT = "この確認はもう使えません";

  /** 場所を変える確認に答える（action は accept・keep。[もう一度] はボタン無しでここから）。通ったかに resolve する */
  async function answerMove(channelId, id, action, buttons) {
    for (const b of buttons) b.disabled = true;
    let ok = false;
    try {
      await SA.api.post("/api/topics/moves/" + encodeURIComponent(id) + "/" + action, {}, { quiet: true });
      toast(action === "accept" ? "場所を変えています" : "場所はこのままにしました");
      ok = true;
    } catch (err) {
      if (err && err.status === 409 && err.code === "stale") toast(MOVE_STALE_TEXT);
      else if (err && err.data && typeof err.data.message === "string") toast(err.data.message);
      else opFailed(err, () => answerMove(channelId, id, action, []));
      for (const b of buttons) b.disabled = false;
    }
    reloadAfterOp(channelId);
    return ok;
  }

  /** 場所を変える確認のカード（今の場所・変える先・[変える][このまま]） */
  function moveCard(channelId, pending) {
    const ok = el("button", { class: "btn btn-primary btn-sm", type: "button", text: "変える" });
    const keep = el("button", { class: "btn btn-secondary btn-sm", type: "button", text: "このまま" });
    const buttons = [ok, keep];
    ok.addEventListener("click", () => answerMove(channelId, pending.id, "accept", buttons));
    keep.addEventListener("click", () => answerMove(channelId, pending.id, "keep", buttons));
    return el("section", { class: "card card-sm", "aria-label": "場所を変える確認" }, [
      el("div", { class: "card-head" }, [el("h2", { text: "場所を変える確認" }), el("span", { class: "meta", text: "Discord でも選べます" })]),
      el("dl", { class: "card-facts" }, [
        el("dt", { text: "今の場所" }),
        el("dd", { text: String(pending.from || "") }),
        el("dt", { text: "変える先" }),
        el("dd", { text: String(pending.to || "") }),
      ]),
      el("p", { text: "会話は新しくなり、担当には要点を引き継ぎます。記録はこのまま残ります。ファイルは動かしません。" }),
      el("div", { class: "msg-actions" }, buttons),
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
      pending: typeof info.sessionId === "string" ? store.ccPendingOf(info.sessionId, session ? session.pending : info.pending) : session ? session.pending : info.pending,
      inTmux: session ? !!session.inTmux : !!info.inTmux,
      rc: session ? SA.views.rcUrl(session.rcUrl) : null,
    };
  }

  /**
   * 会話の末尾に出す送信と作業の状態（届け待ち > 作業中 > 届けた の順で 1 つだけ）。出さなければ null。
   * 状態は持たず、描くたびに live から決め直す（条件が外れた描き直しで消える）
   */
  function ccStatusOf(live) {
    if (live.state === "ended") return null;
    const p = live.pending && typeof live.pending.id === "number" ? live.pending : null;
    if (p && p.state === "delivering") return { kind: "queued", text: "届けています…", cancel: false };
    if (p && p.state === "queued") {
      if (p.lastPaneState === "dialog") return { kind: "queued", text: "ダイアログが出ているため待っています（端末か RC で答えてください）", cancel: true };
      if (live.state === "running") return { kind: "queued", text: "作業中です。終わったら届けます", cancel: true };
      return { kind: "queued", text: "届け待ちです。入力待ちになったら届けます", cancel: true };
    }
    if (live.state === "running") return { kind: "running", text: "作業中…", cancel: false };
    if (p && p.state === "delivered" && p.replyState === "waiting" && live.state !== "needs_input") return { kind: "delivered", text: "届けました。返事を待っています", cancel: false };
    return null;
  }

  /** チャンネルごとの、前に描いた状態の行（種類・pending の id・[やめる] の有無が同じなら使い回す） */
  const ccStatusNodes = new Map();

  /**
   * ccStatusOf の行。届け待ちなら [やめる]。
   * 前の描画と状態の種類・pending の id が同じなら同じ要素を返す（文だけ書き換える。描き直しで焦点と押した直後の disabled を保つ。親は placeChildren でこの要素を動かさない）
   */
  function ccStatusRow(channelId, live) {
    const s = ccStatusOf(live);
    if (!s) {
      ccStatusNodes.delete(channelId);
      return null;
    }
    const id = live.pending && typeof live.pending.id === "number" ? live.pending.id : null;
    const cached = ccStatusNodes.get(channelId);
    if (cached && cached.kind === s.kind && cached.id === id && cached.cancel === s.cancel) {
      if (cached.text.textContent !== s.text) cached.text.textContent = s.text;
      return cached.node;
    }
    let cancel = null;
    if (s.cancel) {
      cancel = el("button", { class: "btn btn-ghost btn-sm", type: "button", text: "やめる" });
      cancel.addEventListener("click", () => SA.views.cancelCcSend(id, live.sessionId, cancel));
    }
    const text = el("span", { text: s.text });
    const node = el("div", { class: "tl-notice cc-status", role: "status", "aria-busy": "true", "data-cc-status": s.kind }, [
      el("span", { class: "spinner spinner-sm", "aria-hidden": "true" }),
      text,
      cancel,
    ]);
    ccStatusNodes.set(channelId, { kind: s.kind, id, cancel: s.cancel, text, node });
    return node;
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

  /** 見出し（状態・[RC で開く]・[画面]・[Discord で開く]・[閉じる]） */
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
    screen.addEventListener("click", () => toggleCcScreen(channelId));
    actions.append(screen);
    const discord = discordUrl(ch.link);
    if (discord) actions.append(el("a", { class: "btn btn-ghost btn-sm hide-sm", href: discord, target: "_blank", rel: "noreferrer" }, [icon("external-link"), "Discord で開く"]));
    const closeOff = live.state === "ended";
    const close = el("button", { class: "btn btn-secondary btn-sm", type: "button", disabled: closeOff, title: closeOff ? "閉じています" : null }, [icon("check"), "閉じる"]);
    close.addEventListener("click", () => closeCcChannel(channelId));
    const more = el("button", { class: "btn btn-ghost btn-sm btn-icon-sm ed-ops-more", type: "button", "aria-label": "ほかの操作", title: "ほかの操作" }, [icon("ellipsis")]);
    // このチャンネルの操作だけのシート（パレットは移動用）
    more.addEventListener("click", () =>
      SA.app.sheet(channelTitle(ch) + " の操作", ccMenu(ch, channelId, false), more),
    );
    actions.append(el("div", { class: "ed-ops" }, [close, more]));
    return el("header", { class: "ed-toolbar", "data-channel": channelId }, [titleRow, actions]);
  }

  /** 画面の写しを開く・閉じる（開いたらセッションの今を読む） */
  function toggleCcScreen(channelId) {
    const ch = channelById(channelId);
    const live = ch ? ccLive(ch) : {};
    if (ccScreenOpened.has(channelId)) ccScreenOpened.delete(channelId);
    else ccScreenOpened.add(channelId);
    if (ccScreenOpened.has(channelId) && live.sessionId) store.load.ccSession(live.sessionId, { quiet: true });
    SA.app.refresh("ch:" + channelId);
  }

  /** Claude Code のチャンネルの […] の行（RC で開く・Discord で開く・閉じる）。withScreen なら Discord の前に画面の開閉 */
  function ccMenu(ch, channelId, withScreen) {
    const live = ccLive(ch);
    const discord = discordUrl(ch.link);
    const closeOff = live.state === "ended";
    return [
      live.rc ? { icon: "external-link", label: "RC で開く", href: live.rc } : null,
      withScreen ? { icon: "terminal", label: ccScreenOpen(channelId) ? "画面を閉じる" : "画面を見る", run: () => toggleCcScreen(channelId) } : null,
      discord ? { icon: "external-link", label: "Discord で開く", href: discord } : null,
      { icon: "check", label: "閉じる", run: closeOff ? null : () => closeCcChannel(channelId), why: "閉じています" },
    ].filter(Boolean);
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

  /** [中断]。button は押したもの（[もう一度] からは null）。中断を受け付けられたら true */
  async function abortTurn(channelId, turnSeq, button) {
    if (button) button.disabled = true;
    // 音（sound.js）はこのチャンネルの次の終わりで鳴らさない。応答より先に終わりを読むことがあるので押した時点で知らせ、中断できなければ取り消す
    SA.events.emit("aborted", { channelId });
    let ok = true;
    try {
      await SA.api.post("/api/channels/" + encodeURIComponent(channelId) + "/turns/" + turnSeq + "/abort", {}, { quiet: true });
    } catch (err) {
      ok = false;
      SA.events.emit("abortFailed", { channelId });
      if (err && err.status === 409) toast(STALE_TEXT);
      else if (err && err.toast) toast(err.toast, null, { level: "error", retry: () => abortTurn(channelId, turnSeq, null) });
      if (button) button.disabled = false;
    }
    SA.poll.running();
    return ok;
  }

  /** [続ける]: 手順の上限で止まった最後の返事（セッション・実行中のターンが無いとき）。押したら隠す（このタブのメモリだけ） */
  const continued = new Set();
  /** [続ける] を出せるか: 手順の上限で止まった返事・セッション・実行中のターンが無い・まだ押して受け付けられていない */
  function continuable(ch, run, turn) {
    return !!turn && turn.kind === "agent" && turn.outcome === "max_turns" && !!ch && ch.kind === "session" && !run && !continued.has(turn.id);
  }
  function continueButton(channelId, turn) {
    const button = el("button", { class: "btn btn-secondary btn-sm", type: "button" }, [icon("play"), "続ける"]);
    button.addEventListener("click", () => continueTurn(channelId, turn, button));
    return el("div", { class: "msg-actions" }, [button]);
  }

  /** [続ける] を送る。button は押したもの（[もう一度] からは null）。受け付けられたら true */
  async function continueTurn(channelId, turn, button) {
    if (button) button.disabled = true;
    try {
      await SA.api.post("/api/channels/" + encodeURIComponent(channelId) + "/continue", {}, { quiet: true });
      continued.add(turn.id);
      SA.poll.running();
      SA.app.refresh("ch:" + channelId);
      return true;
    } catch (err) {
      if (err && err.status === 409) toast(err.code === "running" ? "実行中のターンがあります" : STALE_TEXT);
      else if (err && err.status === 404) toast(STALE_TEXT);
      else if (err && err.toast) toast(err.toast, null, { level: "error", retry: () => continueTurn(channelId, turn, null) });
      if (button) button.disabled = false;
      return false;
    }
  }

  function header(ch, channelId, frame) {
    if (frame) return frameHeader(ch, channelId, frame);
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
      SA.app.sheet(channelTitle(ch) + " の操作", sessionMenu(ch, channelId), more),
    );
    ops.append(renewBtn, more);
    actions.append(ops);
    return el("header", { class: "ed-toolbar", "data-channel": channelId }, [titleRow, actions]);
  }

  /** 会話の […] の行（待ちにする・閉じる・会話を新しくする・ページを開く・Discord で開く。押せないときは理由） */
  function sessionMenu(ch, channelId) {
    const isSession = ch.kind === "session";
    const url = ch.project ? pageUrl(ch.project.url) : null;
    const discord = discordUrl(ch.link);
    const busy = !!pendingOf(channelId, ch);
    const busyWhy = BUSY_TEXT;
    const waitOff = busy || ch.state !== "active";
    const closeOff = busy || ch.state === "done";
    return [
      isSession ? { icon: "pause", label: "待ちにする", run: waitOff ? null : () => setWaiting(channelId), why: busy ? busyWhy : "進行中のときだけ" } : null,
      isSession ? { icon: "check", label: "閉じる", run: closeOff ? null : () => closeSession(channelId), why: busy ? busyWhy : "閉じています" } : null,
      { icon: "rotate-ccw", label: "会話を新しくする", run: busy ? null : () => renew(channelId), why: busyWhy },
      url ? { icon: "external-link", label: "ページを開く", href: url } : null,
      discord ? { icon: "external-link", label: "Discord で開く", href: discord } : null,
    ].filter(Boolean);
  }

  /**
   * 新しい殻の見出し（入口 c-app.js の TopBar）に渡す中身。DOM は作らない。チャンネルが引けなければ null
   *   status: Claude Code は今の状態、セッションは待ち・完了のときだけ（{ text, tone }）。note: 人格が 2 つ以上のときの札の文。menu: […] の行
   */
  function head(channelId) {
    const ch = channelById(channelId);
    if (!ch) return null;
    if (ch.kind === "cc") {
      const live = ccLive(ch);
      const text = live.state ? CC_STATE_LABEL[live.state] : null;
      return {
        title: channelTitle(ch),
        status: text ? { text, tone: live.state === "needs_input" ? "warning" : live.state === "running" ? "accent" : "muted" } : null,
        note: null,
        menu: ccMenu(ch, channelId, true),
      };
    }
    const p = persona(ch.persona);
    return {
      title: channelTitle(ch),
      status: ch.kind === "session" && (ch.state === "waiting" || ch.state === "done") ? { text: STATE_LABEL[ch.state], tone: "muted" } : null,
      note: store.channels && store.channels.personas.length > 1 ? p.name + (p.isDefault ? "" : "（人格）") : null,
      menu: sessionMenu(ch, channelId),
    };
  }

  /**
   * 枠の指定（render の第 3 引数。省略できる。省略したときの描画は今と同じ）
   *   title: string                 見出しの h2（ページの h1 は列 2 の見出し）・[…] のシートの題（title + " の操作"）
   *   placeholder: string           入力欄の placeholder と aria-label
   *   ops: () => Node[]             見出しの右端に足すボタン（省略可）
   *   outgoing: (text) => string    送る直前の本文の差し替え（省略可）
   *   replyText: (text) => string   Bot の返事の本文を描く前の差し替え（省略可）
   *   replyExtras: (text) => Node[] Bot の返事の吹き出しの下に足す要素（省略可）
   */
  /** 枠の見出し: 題と […]（会話を新しくする・Discord で開く）と枠のボタン。[‹]・アイコン・バッジ・リンクのボタンは出さない */
  function frameHeader(ch, channelId, frame) {
    const actions = el("div", { class: "ed-actions" });
    if (ch) {
      const busy = !!pendingOf(channelId, ch);
      const discord = discordUrl(ch.link);
      const more = el("button", { class: "btn btn-ghost btn-sm btn-icon-sm ed-ops-more", type: "button", "aria-label": "ほかの操作", title: "ほかの操作" }, [icon("ellipsis")]);
      more.addEventListener("click", () =>
        SA.app.sheet(
          frame.title + " の操作",
          [
            { icon: "rotate-ccw", label: "会話を新しくする", run: busy ? null : () => renew(channelId), why: BUSY_TEXT },
            discord ? { icon: "external-link", label: "Discord で開く", href: discord } : null,
          ].filter(Boolean),
          more,
        ),
      );
      actions.append(el("div", { class: "ed-ops" }, [more]));
    }
    // .ed-ops の外（≤639px で .ed-ops の中のボタンは隠れるため）
    if (frame.ops) actions.append(...frame.ops());
    return el("header", { class: "ed-toolbar", "data-channel": channelId }, [el("div", { class: "ed-title" }, [el("h2", { text: frame.title })]), actions]);
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
        ta.placeholder = ta.dataset.placeholder || placeholderOf(ta.dataset.title || "会話");
        ta.setAttribute("enterkeyhint", enterHint());
      }
      // 新しい殻の入力欄（部品）は描き直して合わせる
      if (SA.composer && !composerBroken) for (const root of document.querySelectorAll("[data-composer]")) drawComposer(root.getAttribute("data-composer"));
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

  /** 送った本文が受け付けられた後（書きかけを消した後）: 仮の行・読み直し。Claude Code のチャンネルはセッションの今を読み直す */
  function afterSent(channelId, data, text) {
    const current = channelById(channelId);
    if (current && current.kind === "cc") {
      // Claude Code のチャンネル: 行（写し）はサーバーが書いている。届くまでの状態はセッションの今で出す
      store.load.turns(channelId);
      const live = ccLive(current);
      if (live.sessionId) {
        // サーバーのセッションの今が追いつくまで、仮の「届け待ち」をすぐ描く
        if (data && typeof data.sendId === "number") store.setCcOptimisticSend(live.sessionId, data.sendId);
        SA.app.refresh("ch:" + channelId);
        store.load.ccSession(live.sessionId, { quiet: true });
        for (const ms of CC_SEND_RECHECK_MS) setTimeout(() => store.load.ccSession(live.sessionId, { quiet: true }), ms);
      }
      return;
    }
    store.addOptimisticTurn(channelId, data && data.turnId, text);
    store.load.turns(channelId);
    SA.poll.running();
    for (const ms of RUNNING_RECHECK_MS) setTimeout(() => store.load.running({ quiet: true }), ms);
  }

  /** 送れなかったときの知らせ（[もう一度] は retry） */
  function sendFailed(err, retry) {
    const known = err && err.code && (SEND_ERRORS[err.code] || CC_SEND_ERRORS_EXTRA[err.code] || SA.views.CC_SEND_ERRORS[err.code]);
    if (err && err.toast) toast(known || err.toast, null, { level: "error", retry });
  }

  /** 入力欄の title（キーと届き方の説明） */
  function composerNote(ch) {
    return ch && ch.kind === "cc"
      ? "このセッションに届けます（入力待ちのときに貼ります）。返事はここと Discord の両方に出ます"
      : "Discord で発言したのと同じ経路で 1 ターン動きます。返事はここと Discord の両方に出ます";
  }

  function composer(ch, channelId, frame) {
    const title = frame ? frame.title : ch ? channelTitle(ch) : "会話";
    const ta = el("textarea", {
      class: "textarea composer-input",
      rows: "2",
      maxlength: "4000",
      "aria-label": frame ? frame.placeholder : title + " に送る",
      enterkeyhint: enterHint(),
      "data-title": title,
      "data-placeholder": frame ? frame.placeholder : undefined,
      placeholder: frame ? frame.placeholder : placeholderOf(title),
      title: composerNote(ch),
    });
    ta.value = SA.app.draft(channelId);
    const counter = el("span", { class: "counter", "aria-live": "polite" });
    const sendBtn = el("button", { class: "btn btn-primary btn-sm", type: "submit" }, [icon("send"), "送る"]);
    let sending = false;
    // 送る直前の本文（枠の指定があれば差し替える）。字数もこれで数える
    const outgoing = (text) => (frame && frame.outgoing ? frame.outgoing(text) : text);
    const update = () => {
      const raw = ta.value.trim();
      const n = raw === "" ? 0 : outgoing(raw).length;
      counter.textContent = n.toLocaleString("en-US") + " / 1,900";
      counter.classList.toggle("is-over", n > MESSAGE_MAX);
      // 上限を超えても押せる（押したらトーストで知らせる）
      sendBtn.disabled = sending || raw === "";
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
      const raw = ta.value.trim();
      if (sending || raw === "") return;
      const text = outgoing(raw);
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
        if (ta.value.trim() === raw) ta.value = "";
        SA.app.setDraft(channelId, ta.value);
        afterSent(channelId, data, text);
      } catch (err) {
        // 本文は入力欄に残す。[もう一度] は入力欄の今の本文を送り直す
        sendFailed(err, submit);
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

  /** その会話を描いている入れ物のスクロール（data-channel で引く。描いていなければ null） */
  function scrollOf(channelId) {
    if (!/^\d+$/.test(channelId)) return null;
    return document.querySelector('.ed-scroll[data-channel="' + channelId + '"]');
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

  // ===== 新しい殻の会話の行（入口 c-app.js の SA.talk。K4）。古い殻には SA.talk が無いので、ここは通らない =====
  /** 部品で描けなかった（以後はこのタブで古い描き方） */
  let talkBroken = false;
  /** 部品の行で開いた手順（{ [channelId]: Set<行の key = String(turn.id)> }。古い details の openSteps とは別） */
  const talkOpen = {};
  /** [中断] を押して応答を待っているチャンネル → その turnSeq */
  const aborting = new Map();
  /** [続ける] を押して、受け付けの返事を待っているチャンネル（部品の道だけ） */
  const continuing = new Set();

  function talkOpenOf(channelId) {
    if (!talkOpen[channelId]) talkOpen[channelId] = new Set();
    return talkOpen[channelId];
  }

  /** 部品に渡す state。on は channelId だけを閉じ込め、押されたときに今の状態を読む（行の vnode は作ったときの on を持ち続ける） */
  function talkState(channelId, ch) {
    const t = store.turns[channelId];
    const isCc = !!(ch && ch.kind === "cc");
    const run = isCc ? null : store.runningOf(channelId);
    if (aborting.has(channelId) && (!run || aborting.get(channelId) !== run.turnSeq)) aborting.delete(channelId);
    const last = t.turns[t.turns.length - 1];
    const continueKey = continuable(ch, run, last) ? String(last.id) : null;
    return {
      channelId,
      turns: t.turns,
      hasMore: !!t.hasMore,
      running: run,
      stopping: aborting.has(channelId),
      continueKey,
      continueBusy: continueKey !== null && continuing.has(channelId),
      openSteps: talkOpenOf(channelId),
      runStepsOpen: stepsOpened.has(channelId),
      fmt: {
        time: (turn) => shortTime(turn.at),
        label: (turn) => (turn.kind === "owner" ? "オーナー" : isCc ? "Claude Code" : persona(turn.persona).name),
        // 吹き出しの上の名前は renderTurn と同じ決め方
        name: (turn, prev) => {
          if (isCc) return followsSameAgent(prev, ch, turn.persona) ? null : "Claude Code";
          return showsAgentName(ch) && !followsSameAgent(prev, ch, turn.persona) ? persona(turn.persona).name : null;
        },
        end: endText,
        progress: progressText,
        waiting: (r) => store.runningWaitingText(r),
        allLabel: allStepsLabel,
        // 実行中の行の名前は renderRunning と同じ決め方
        runName: (prev) => (showsAgentName(ch) && !followsSameAgent(prev, ch, ch ? ch.persona : "default") ? persona(ch ? ch.persona : "default").name : null),
      },
      on: {
        older: () => loadOlder(channelId),
        toggleSteps: (key) => {
          const opened = talkOpenOf(channelId);
          if (opened.has(key)) opened.delete(key);
          else opened.add(key);
          drawTalk(channelId);
        },
        toggleRunSteps: () => {
          if (stepsOpened.has(channelId)) stepsOpened.delete(channelId);
          else stepsOpened.add(channelId);
          drawTalk(channelId);
        },
        stop: async () => {
          // 押されたときの実行を読む
          const now = store.runningOf(channelId);
          if (!now || aborting.has(channelId)) return;
          aborting.set(channelId, now.turnSeq);
          drawTalk(channelId);
          const ok = await abortTurn(channelId, now.turnSeq, null);
          // 待つ間に別の実行の印に替わっていたら、その印は消さない
          if (!ok && aborting.get(channelId) === now.turnSeq) {
            aborting.delete(channelId);
            drawTalk(channelId);
          }
        },
        continue: async (key) => {
          // 押されたときの最後の行を読む
          const now = store.turns[channelId];
          const lastNow = now && now.turns[now.turns.length - 1];
          if (!lastNow || String(lastNow.id) !== key || continuing.has(channelId)) return;
          if (!continuable(channelById(channelId), store.runningOf(channelId), lastNow)) return;
          continuing.add(channelId);
          drawTalk(channelId);
          let ok = false;
          try {
            ok = await continueTurn(channelId, lastNow, null);
          } finally {
            continuing.delete(channelId);
          }
          // 受け付けられたら continueTurn の refresh が描き直す（ボタンが消える）。だめなら待ちの形を戻す
          if (!ok) drawTalk(channelId);
        },
      },
    };
  }

  /** 部品の会話の根（data-talk で引く。描いていなければ null） */
  function talkRoot(channelId) {
    if (!/^\d+$/.test(channelId)) return null;
    return document.querySelector('[data-talk="' + channelId + '"]');
  }

  /** 部品の会話の行を全部描き直す（手順の開閉・[中断]）。描けなければ古い描き方で描き直す */
  function drawTalk(channelId) {
    if (!SA.talk || talkBroken) return;
    const root = talkRoot(channelId);
    const t = store.turns[channelId];
    if (!root || !t || !t.loaded) return;
    if (!SA.talk.draw(root, talkState(channelId, channelById(channelId)))) {
      talkBroken = true;
      SA.app.refresh("ch:" + channelId);
    }
  }

  /** container の直下の .ed-scroll の直下の、部品の会話の根を全部外す（子を辿る） */
  function dropTalkRoots(container, talk) {
    for (const scroll of [...container.children]) {
      if (!scroll.classList.contains("ed-scroll")) continue;
      for (const child of [...scroll.children]) if (child.getAttribute("data-talk") !== null) talk.drop(child);
    }
  }

  /**
   * container の直下の、そのチャンネルの部品の .ed-scroll（{ scroll, root, cardsRoot, tl }）。無ければ null。
   * withCards なら会話の根の次がそのチャンネルのカードの根でその次が .tl の形だけ、違えば会話の根のすぐ次が .tl の形だけ（cardsRoot は null）
   */
  function talkScrollOf(container, channelId, withCards) {
    for (const scroll of [...container.children]) {
      if (!scroll.classList.contains("ed-scroll") || scroll.getAttribute("data-channel") !== channelId) continue;
      const kids = [...scroll.children];
      const at = kids.findIndex((c) => c.getAttribute("data-talk") === channelId);
      if (at < 0) continue;
      const cardsRoot = withCards ? kids[at + 1] || null : null;
      if (withCards && (!cardsRoot || cardsRoot.getAttribute("data-cards") !== channelId)) continue;
      const tl = kids[at + (withCards ? 2 : 1)] || null;
      if (tl && tl.classList.contains("tl")) return { scroll, root: kids[at], cardsRoot, tl };
    }
    return null;
  }

  // ===== 新しい殻の入力欄（入口 c-app.js の SA.composer。K5）。古い殻には SA.composer が無いので、ここは通らない =====
  /** 部品で描けなかった（以後はこのタブで古い入力欄） */
  let composerBroken = false;
  /** 送っている間（受け付けの返事が来るまで）のチャンネル */
  const sendingNow = new Set();

  /** placeholder は決まった短い文（題名を入れない） */
  function composerPlaceholder(ch) {
    if (ch && ch.kind === "session") return "この話題に送る";
    if (ch && ch.kind === "cc") return "このセッションに送る";
    return "ここに送る";
  }

  /** 部品に渡す state。本文の持ち主は SA.app.draft。on は channelId だけを閉じ込める */
  function composerState(channelId, ch) {
    const text = SA.app.draft(channelId);
    return {
      text,
      count: text.trim().length,
      max: MESSAGE_MAX,
      sending: sendingNow.has(channelId),
      touch: touchPrimary(),
      label: (ch ? channelTitle(ch) : "会話") + " に送る",
      placeholder: composerPlaceholder(ch),
      note: composerNote(ch),
      on: {
        input: (value) => composerInput(channelId, value),
        send: () => composerSend(channelId),
      },
    };
  }

  /** 部品の入力欄の根（data-composer で引く。描いていなければ null） */
  function composerRoot(channelId) {
    if (!/^\d+$/.test(channelId)) return null;
    return document.querySelector('[data-composer="' + channelId + '"]');
  }

  /** 入力欄だけを描き直す（会話は描かない）。描けなければ根を外して古い入力欄で描き直し、false */
  function drawComposer(channelId) {
    if (!SA.composer || composerBroken) return false;
    const root = composerRoot(channelId);
    if (!root) return false;
    if (SA.composer.draw(root, composerState(channelId, channelById(channelId)))) return true;
    composerBroken = true;
    SA.composer.drop(root);
    SA.app.refresh("ch:" + channelId);
    return false;
  }

  /** 打鍵: 書きかけを覚え、入力欄だけを描き直す。一番下を見ていたら、欄が伸びても一番下のまま */
  function composerInput(channelId, text) {
    SA.app.setDraft(channelId, text);
    const scroll = scrollOf(channelId);
    const bottom = !!scroll && scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight < 48;
    drawComposer(channelId);
    if (bottom) scroll.scrollTop = scroll.scrollHeight;
  }

  /** [送る]・Enter（古い入力欄の submit と同じ順）。本文は SA.app.draft から読む */
  async function composerSend(channelId) {
    const raw = SA.app.draft(channelId).trim();
    if (sendingNow.has(channelId) || raw === "") return;
    if (raw.length > MESSAGE_MAX) {
      toast(TOO_LONG_TEXT);
      return;
    }
    sendingNow.add(channelId);
    drawComposer(channelId);
    try {
      const data = await SA.api.post("/api/channels/" + encodeURIComponent(channelId) + "/messages", { text: raw }, { quiet: true });
      // 受け付けた（202）: 音（sound.js）はここで「受け付けた」を鳴らす
      SA.events.emit("sent", { channelId });
      // 送っている間に打ち足していなければ書きかけを消す。set は値だけなので、すぐ同じ本文（空）で描いて高さを戻す
      if (SA.app.draft(channelId).trim() === raw) {
        SA.app.setDraft(channelId, "");
        const root = composerRoot(channelId);
        if (root && SA.composer && !composerBroken) SA.composer.set(root, "");
        drawComposer(channelId);
      }
      afterSent(channelId, data, raw);
    } catch (err) {
      // 本文は書きかけに残す。[もう一度] はその時の書きかけを送り直す
      sendFailed(err, () => composerSend(channelId));
    } finally {
      sendingNow.delete(channelId);
      drawComposer(channelId);
    }
  }

  /** container の直下の、部品の入力欄の根を全部外す */
  function dropComposerRoots(container, comp) {
    for (const child of [...container.children]) if (child.getAttribute("data-composer") !== null) comp.drop(child);
  }

  // ===== 新しい殻の「あなたの番」のカード・待ちの行・文（入口 c-app.js の SA.cards。K5）。古い殻には SA.cards が無いので、ここは通らない =====
  /** 部品で描けなかった（以後はこのタブで古いカード） */
  let cardsBroken = false;
  /** 送っている間と、送り終えて読み直すまでの項目（"close:" + channelId・"move:" + 提案の id・"ask:" + 要求の id） */
  const cardBusy = new Set();

  /** 質問（AskUserQuestion）の要求か（views.js の ccPermissionCard と同じ判定） */
  function isQuestion(p) {
    return !!(p.question && Array.isArray(p.question.questions) && p.question.questions.length > 0);
  }

  /** カードの項目（順は古い描き方の .tl と同じ: 待ちの行 → 閉じる前の確認 → 場所を変える確認 → 許可・質問 → 空の文 → 完了の文） */
  function cardItems(channelId) {
    const t = store.turns[channelId];
    const ch = channelById(channelId);
    const run = store.runningOf(channelId);
    const items = [];
    const waiting = pendingOf(channelId, ch);
    if (waiting) items.push({ kind: "note", id: "wait", busy: true, text: waiting.kind === "close" ? WAIT_CLOSE_TEXT : WAIT_RENEW_TEXT });
    // 閉じる前の確認の条件は古い描き方と同じ（閉じるのを待っている間は出さない）
    if (ch && ch.kind === "session" && ch.state !== "done" && ch.closeDraft && !(waiting && waiting.kind === "close")) {
      const draft = ch.closeDraft;
      const tasks = Array.isArray(draft.tasks) ? draft.tasks : [];
      if (!picked[channelId]) picked[channelId] = new Set();
      items.push({
        kind: "close",
        id: channelId,
        summary: String(draft.summary || ""),
        tasks: tasks.map((task, i) => i + 1 + ". " + String(task && task.title) + (task && task.due ? "（期限 " + task.due + "）" : "")),
        picked: [...picked[channelId]].filter((i) => i < tasks.length).sort((a, b) => a - b),
        busy: cardBusy.has("close:" + channelId),
      });
    }
    if (ch && ch.moveProposal) {
      const mp = ch.moveProposal;
      items.push({ kind: "move", id: mp.id, from: String(mp.from || ""), to: String(mp.to || ""), busy: cardBusy.has("move:" + mp.id) });
    }
    // プロジェクトのセッションの許可・質問（保留中だけ。終わったものは選んだ状態を捨てる）
    const ask = ch && ch.kind === "session" ? askRequestOf(ch) : null;
    if (ask) {
      const p = ask;
      if (p.state === "pending") {
        const item = SA.views.ccAsk.item(askSessionOf(ch, p), p);
        if (item) items.push(cardBusy.has("ask:" + p.id) ? Object.assign(item, { busy: true }) : item);
      } else {
        SA.views.ccQuestionForget(p.id);
      }
    }
    if (t && t.turns.length === 0 && !run) items.push({ kind: "note", id: "empty", text: EMPTY_TEXT });
    if (ch && ch.kind === "session" && ch.state === "done") items.push({ kind: "note", id: "done", text: DONE_TEXT });
    return items;
  }

  /** チャンネルの許可・質問の要求（プロジェクトのセッションは ch.permission、Claude Code のチャンネルはセッションの今）。id が数でなければ null */
  function askRequestOf(ch) {
    const p = ch && ch.kind === "session" ? ch.permission : ch && ch.kind === "cc" ? ccLive(ch).permission : null;
    return p && typeof p.id === "number" ? p : null;
  }

  /** 保留中の要求（無ければ null） */
  function pendingAskOf(ch) {
    const p = askRequestOf(ch);
    return p && p.state === "pending" ? p : null;
  }

  /** 要求の送り先のセッション（Claude Code のチャンネルはそのチャンネルのセッション、プロジェクトのセッションは要求の sessionId） */
  function askSessionOf(ch, p) {
    return ch && ch.kind === "cc" ? ccLive(ch).sessionId : p.sessionId;
  }

  /** 今の保留中の要求（id が同じで、質問か許可かが kind と合うときだけ。違えば null: 古い画面からの押しは捨てる） */
  function askOf(channelId, id, kind) {
    const p = pendingAskOf(channelById(channelId));
    if (!p || p.id !== id) return null;
    return isQuestion(p) === (kind === "question") ? p : null;
  }

  /** 部品に渡す on。channelId だけを閉じ込め、押されたときに今の状態を読む */
  function cardsOn(channelId) {
    const ask = () => SA.views.ccAsk;
    return {
      always: (id, checked) => {
        ask().always(id, checked);
        drawCards(channelId);
      },
      task: (_id, i, checked) => {
        if (!picked[channelId]) picked[channelId] = new Set();
        if (checked) picked[channelId].add(i);
        else picked[channelId].delete(i);
        drawCards(channelId);
      },
      pick: (id, index, label, checked) => {
        const p = askOf(channelId, id, "question");
        if (!p) return;
        ask().pick(p, index, label, checked);
        drawCards(channelId);
      },
      pickOther: (id, index, checked, byPointer) => {
        const p = askOf(channelId, id, "question");
        if (!p) return;
        ask().pickOther(p, index, checked);
        // 「その他」の欄に焦点を移すのは指・マウスで選んだときだけ（矢印キーで選んだ瞬間には飛ばさない）。描いて欄が見えてから
        if (drawCards(channelId) && byPointer && checked) {
          const root = cardsRoot(channelId);
          if (root) SA.cards.focus(root, id, index);
        }
      },
      other: (id, index, value) => {
        const p = askOf(channelId, id, "question");
        if (!p) return;
        ask().other(p, index, value);
        // [答える] の押せる・押せないが変わるので描く（欄の本文は部品が書き換えない）
        drawCards(channelId);
      },
      permit: (id, decision) => {
        const p = askOf(channelId, id, "permission");
        if (!p) return;
        cardOp(channelId, "ask:" + id, () => ask().permit(p.sessionId, p, decision, "ch:" + channelId));
      },
      answer: (id) => {
        const p = askOf(channelId, id, "question");
        if (!p) return;
        cardOp(channelId, "ask:" + id, () => ask().answer(p.sessionId, p, "ch:" + channelId));
      },
      dismiss: (id) => {
        const p = askOf(channelId, id, "question");
        if (!p) return;
        cardOp(channelId, "ask:" + id, () => ask().dismiss(p.sessionId, p, "ch:" + channelId));
      },
      close: (_id, which) => {
        let selected;
        if (which === "all" || which === "none") selected = which;
        else if (which === "picked") {
          selected = [...(picked[channelId] || [])].sort((a, b) => a - b);
          if (selected.length === 0) return;
        } else return;
        cardOp(channelId, "close:" + channelId, () => confirmClose(channelId, selected, []));
      },
      move: (id, action) => cardOp(channelId, "move:" + id, () => answerMove(channelId, id, action, [])),
    };
  }

  /** 送る（run は通ったかに resolve する）。送っている間と、通ったら読み直しが済むまで、その項目は待ちの形（二度押しさせない） */
  async function cardOp(channelId, key, run) {
    if (cardBusy.has(key)) return;
    cardBusy.add(key);
    drawCards(channelId);
    let ok = false;
    try {
      ok = (await run()) === true;
      // 通ったら、読み直しが済むまで待ちの形のまま。許可も質問も、送りの終わりに自分で 1 回読む。その読みは送る前に始まっていた
      // polling の読みに相乗りする事があり（同じ鍵の読みは重ならない）、そのときは古い状態を返す。ここの 1 回目もそれに相乗りするので、
      // 2 回目で初めて送った後の状態を読む（1 回だけだと、押せる形に一瞬戻る事がある）
      if (ok) {
        await store.load.turns(channelId, { quiet: true });
        await store.load.turns(channelId, { quiet: true });
      }
    } finally {
      cardBusy.delete(key);
      SA.app.refresh("ch:" + channelId);
    }
  }

  /** 部品のカードの根（data-cards で引く。描いていなければ null） */
  function cardsRoot(channelId) {
    if (!/^\d+$/.test(channelId)) return null;
    return document.querySelector('[data-cards="' + channelId + '"]');
  }

  /** カードだけを描き直す（会話・入力欄は描かない）。一番下を見ていたら一番下のまま。描けなければ根を外して古いカードで描き直し、false */
  function drawCards(channelId) {
    if (!SA.cards || cardsBroken) return false;
    const root = cardsRoot(channelId);
    if (!root) return false;
    const scroll = scrollOf(channelId);
    const bottom = !!scroll && scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight < 48;
    if (SA.cards.draw(root, { items: cardItems(channelId), on: cardsOn(channelId) })) {
      if (bottom) scroll.scrollTop = scroll.scrollHeight;
      return true;
    }
    cardsBroken = true;
    SA.cards.drop(root);
    root.remove();
    SA.app.refresh("ch:" + channelId);
    return false;
  }

  /** container の直下の .ed-scroll の直下の、部品のカードの根を全部外す */
  function dropCardRoots(container, cards) {
    for (const scroll of [...container.children]) {
      if (!scroll.classList.contains("ed-scroll")) continue;
      for (const child of [...scroll.children]) if (child.getAttribute("data-cards") !== null) cards.drop(child);
    }
  }

  /** 残り時間: pending の許可・質問が出ているチャンネルのカードだけを描き直す（実行中のターンが無くても進める。隠れたタブでは描かない） */
  function tickCards() {
    if (!SA.cards || cardsBroken || document.visibilityState !== "visible") return;
    for (const root of document.querySelectorAll("[data-cards]")) {
      const id = root.getAttribute("data-cards");
      if (!pendingAskOf(channelById(id))) continue;
      if (!drawCards(id)) return;
    }
  }

  function render(container, channelId, frame) {
    const t = store.turns[channelId];
    const ch = channelById(channelId);
    // 新しい殻の列 2 は、見出しを入口 c-app.js の部品が描く（右腕の枠は今の見出しのまま）
    const top = !frame && !!SA.top;
    // 新しい殻の列 2 は、会話の行も部品が描く（右腕は古い描き方のまま）
    const talk = !frame && SA.talk && !talkBroken ? SA.talk : null;
    // 入力欄も部品が描く（右腕は古い入力欄のまま）
    const comp = !frame && SA.composer && !composerBroken ? SA.composer : null;
    if (!t || !t.loaded) {
      if (talk) dropTalkRoots(container, talk);
      if (comp) dropComposerRoots(container, comp);
      if (!frame && SA.cards) dropCardRoots(container, SA.cards);
      container.replaceChildren(...[top ? null : header(ch, channelId, frame), el("div", { class: "ed-scroll" }, [el("div", { class: "ed-page" }, [SA.views.loading()])])].filter(Boolean));
      return;
    }
    if (t.missing) {
      if (talk) dropTalkRoots(container, talk);
      if (comp) dropComposerRoots(container, comp);
      if (!frame && SA.cards) dropCardRoots(container, SA.cards);
      container.replaceChildren(
        ...[
          top ? null : header(null, channelId, frame),
          el("div", { class: "ed-scroll" }, [el("div", { class: "empty" }, [icon("info"), el("p", { text: "このチャンネルは開けません。削除されたか、受け付けないチャンネルです。" })])]),
        ].filter(Boolean),
      );
      return;
    }
    // 会話の行は先に並べ、最後に .tl に入れる（質問のカードが前と同じなら、前の .tl を残してカードを動かさない）
    const parts = [];
    const timeline = { append: (...nodes) => parts.push(...nodes) };
    if (t.hasMore && !talk) {
      const more = el("button", { class: "btn btn-ghost btn-sm", type: "button", text: "前の会話を読む" });
      more.addEventListener("click", () => loadOlder(channelId));
      timeline.append(el("div", { class: "tl-hint" }, [more]));
    }
    const isCc = !!(ch && ch.kind === "cc");
    // 会話の行を部品が描く列 2 では、カード・待ちの行・文も部品が描く（Claude Code のチャンネルは古い .tl のまま）
    const cards = talk && !isCc && SA.cards && !cardsBroken ? SA.cards : null;
    // Claude Code のチャンネルにはターンが無い（実行中の行・[続ける] は出さない）
    const run = isCc ? null : store.runningOf(channelId);
    const last = t.turns[t.turns.length - 1];
    let prev = null;
    for (const turn of talk ? [] : t.turns) {
      // 枠の指定があれば Bot の返事の本文だけを差し替えて描く（prev・last との比べは元の行のまま）
      const reply = !!frame && turn.kind === "agent";
      const node = renderTurn(reply && frame.replyText ? Object.assign({}, turn, { text: frame.replyText(turn.text) }) : turn, channelId, ch, prev);
      prev = turn;
      // 手順の上限で止まった最後の返事には [続ける]（セッションで、実行中のターンが無いとき）
      if (turn === last && continuable(ch, run, turn)) {
        // 吹き出しの下に左寄せ
        node.append(continueButton(channelId, turn));
      }
      if (reply && frame.replyExtras) node.append(...frame.replyExtras(turn.text));
      timeline.append(node);
    }
    if (run && !talk) timeline.append(renderRunning(ch, run, prev));
    const waiting = pendingOf(channelId, ch);
    if (waiting && !cards) {
      timeline.append(
        el("div", { class: "tl-notice", "aria-busy": "true" }, [
          el("span", { class: "spinner spinner-sm", "aria-hidden": "true" }),
          el("span", { text: waiting.kind === "close" ? WAIT_CLOSE_TEXT : WAIT_RENEW_TEXT }),
        ]),
      );
    }
    // /close の確認（下書きがあり、閉じていない）。この画面で閉じるのを待っている間は出さない（要約のターンの途中の下書き）
    if (!cards && ch && ch.kind === "session" && ch.state !== "done" && ch.closeDraft && !(waiting && waiting.kind === "close")) {
      timeline.append(closeCard(channelId, ch.closeDraft));
    }
    // 右腕の場所を変える確認（期限の中の物があるときだけ）
    if (!cards && ch && ch.moveProposal) timeline.append(moveCard(channelId, ch.moveProposal));
    let ccPending = null;
    let card = null;
    if (isCc) {
      const live = ccLive(ch);
      // 一度も読んでいなければセッションの今を読む（その後は api.js の polling）
      if (!live.loaded && live.sessionId) store.load.ccSession(live.sessionId, { quiet: true });
      // 一覧から開いた直後（チャンネルがまだ分からなかった）でも、セッションの今の polling を始める
      SA.poll.kickCc();
      // 会話の行のすぐ下に、送信と作業の状態
      const status = ccStatusRow(channelId, live);
      if (status) timeline.append(status);
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
        timeline.append(el("p", { class: "tl-hint", text: CC_ENDED_TEXT }));
      }
      // 行が同じ送信の状態（届け待ち・届けた）を出している間は、入力欄の上の帯を出さない
      const statusKind = status ? status.getAttribute("data-cc-status") : null;
      ccPending = live.sessionId && !(statusKind === "queued" || statusKind === "delivered") ? SA.views.ccPendingBar(live.sessionId, live.pending) : null;
    } else if (!cards && ch && ch.kind === "session" && ch.permission && typeof ch.permission.id === "number") {
      // プロジェクトのセッション（docs/plan/unify.md §6.1 の 5）の許可の要求。Claude Code のチャンネルと同じカード・同じ /api/cc/permissions/<id>/*
      const p = ch.permission;
      if (p.state === "pending") {
        card = SA.views.ccPermissionCard(p.sessionId, p, null, "ch:" + channelId);
        if (card) timeline.append(card);
      } else {
        SA.views.ccQuestionForget(p.id);
      }
    }
    if (!cards && t.turns.length === 0 && !run) {
      timeline.append(
        el("p", { class: "tl-hint", text: isCc ? CC_EMPTY_TEXT : EMPTY_TEXT }),
      );
    }
    if (!cards && ch && ch.kind === "session" && ch.state === "done") {
      timeline.append(el("p", { class: "tl-hint", text: DONE_TEXT }));
    }
    // 前に描いたカード（質問の書きかけ）か状態の行（[やめる]）が前の .tl にあれば、その .ed-scroll と .tl を残して中身だけを並べ直す（外すと焦点・IME の変換が切れる）
    const reused = talk ? [] : [card, ccStatusNodes.has(channelId) ? ccStatusNodes.get(channelId).node : null].filter((n) => n && parts.includes(n));
    const oldScroll = reused.length > 0 ? [...container.children].find((child) => child.classList.contains("ed-scroll") && child.getAttribute("data-channel") === channelId) : null;
    const oldTimeline = (oldScroll && reused.map((n) => n.parentNode).find((p) => p && p.parentNode === oldScroll)) || null;
    let scroll;
    let talkRootEl = null;
    let cardsRootEl = null;
    // 部品の道: 同じチャンネルの .ed-scroll（直下の根と、カードの根と、その次の .tl）があれば使い回す（行の要素・文の選択・スクロールの位置・「その他」の欄を保つ）
    const same = talk ? talkScrollOf(container, channelId, !!cards) : null;
    if (same) {
      talkRootEl = same.root;
      cardsRootEl = same.cardsRoot;
      SA.views.placeChildren(same.tl, parts);
      scroll = same.scroll;
    } else if (talk) {
      dropTalkRoots(container, talk);
      if (SA.cards) dropCardRoots(container, SA.cards);
      talkRootEl = el("div", { "data-talk": channelId });
      if (cards) cardsRootEl = el("div", { "data-cards": channelId });
      scroll = el("div", { class: "ed-scroll", "data-stick": "bottom", "data-channel": channelId }, [talkRootEl, cardsRootEl, el("div", { class: "tl" }, parts)].filter(Boolean));
      scroll.addEventListener("scroll", () => {
        if (scroll.scrollTop < OLDER_THRESHOLD) loadOlder(channelId);
      });
    } else if (oldTimeline) {
      SA.views.placeChildren(oldTimeline, parts);
      scroll = oldScroll;
    } else {
      scroll = el("div", { class: "ed-scroll", "data-stick": "bottom", "data-channel": channelId }, [el("div", { class: "tl" }, parts)]);
      scroll.addEventListener("scroll", () => {
        if (scroll.scrollTop < OLDER_THRESHOLD) loadOlder(channelId);
      });
    }
    // 入力欄は作り直さない（書きかけ・フォーカス・IME の変換を保つ）。見出しと会話だけを入れ替える
    const kept = comp ? null : [...container.children].find((child) => child.classList.contains("composer-wrap") && child.getAttribute("data-channel") === channelId);
    // 部品の道: 同じチャンネルの根を使い回す（無ければ作り、ほかのチャンネルの根は外す）
    let compRoot = comp ? [...container.children].find((child) => child.getAttribute("data-composer") === channelId) || null : null;
    if (comp && !compRoot) {
      dropComposerRoots(container, comp);
      compRoot = el("div", { "data-composer": channelId });
    }
    // 送った本文の状態（Claude Code のチャンネル。[やめる]）は入力欄の上
    SA.views.placeChildren(container, [top ? null : header(ch, channelId, frame), scroll, ccPending, comp ? compRoot : kept || composer(ch, channelId, frame)]);
    // 置いてから描く（根が画面に付いた後）。入力欄を先に描く（描けずにやり直すとき、会話の描き直しを二重にしない）。描けなければ古い描き方で描き直す
    if (comp && !comp.draw(compRoot, composerState(channelId, ch))) {
      composerBroken = true;
      comp.drop(compRoot);
      render(container, channelId, frame);
      return;
    }
    if (talk && !talk.draw(talkRootEl, talkState(channelId, ch))) {
      talkBroken = true;
      talk.drop(talkRootEl);
      render(container, channelId, frame);
      return;
    }
    // カードは会話の後。描けなければ根を外す（やり直しでは会話の根のすぐ次が .tl の形として使い回せる）
    if (cards && !cards.draw(cardsRootEl, { items: cardItems(channelId), on: cardsOn(channelId) })) {
      cardsBroken = true;
      cards.drop(cardsRootEl);
      cardsRootEl.remove();
      render(container, channelId, frame);
      return;
    }
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
        delete talkOpen[channelId];
        aborting.delete(channelId);
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

  /** 実行中の行の経過時間を 1 秒ごとに進める（描き直さずに文だけ）。新しい殻のカードの残り時間も（実行中のターンが無くても） */
  setInterval(() => {
    tickCards();
    if (!store.running || store.running.length === 0 || document.visibilityState !== "visible") return;
    for (const node of document.querySelectorAll("[data-run-progress]")) {
      const run = store.runningOf(node.getAttribute("data-run-progress"));
      if (run) node.textContent = progressText(run);
    }
    // 新しい殻: 実行中のチャンネルの部品の根だけ、覚えた行のまま実行中の行を描く（部品の文を外から書き換えない）
    if (!SA.talk || talkBroken) return;
    for (const root of document.querySelectorAll("[data-talk]")) {
      const id = root.getAttribute("data-talk");
      const t = store.turns[id];
      if (!t || !t.loaded || !store.runningOf(id)) continue;
      if (!SA.talk.tick(root, talkState(id, channelById(id)))) {
        talkBroken = true;
        SA.app.refresh("ch:" + id);
        return;
      }
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
    markSeenShown,
    render,
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
    ccCommandState,
    head,
  };
})();
