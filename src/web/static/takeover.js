// 新しい殻（v3.html）の端末のセッションの札のつなぎ（docs/plan/terminal-handover.md の H3）: 取り込みの判定を読み、確認・進める・やめるを
// サーバー（/api/cc/sessions/<id>/takeover・/api/cc/takeovers/<番号>/confirm|cancel）に送り、生の状態を口 SA.term へ押し込む（描くのは部品 c-term.js）。
// 判定は開いたとき・一覧の行の状態が変わったとき・［確かめ直す］と、結果が分からないときの決めた読み直しだけ読む（時間では読まない）。画面の写しは読まない
"use strict";

(function () {
  const SA = (window.SA = window.SA || {});

  // ===== 決めた文（部品の文は c-term.js の TERM_TEXT） =====
  const CONFIRM_TITLE = "取り込みますか";
  const CONFIRM_OK = "取り込む";
  const NOT_SET_UP_TEXT = "先に Discord で /setup を実行してください";
  const FAILED_TEXT = "取り込めませんでした。";
  const NOT_STARTED_TEXT = "取り込みは始まっていません。もう一度試せます。";
  const FALLBACK_TEXT = "操作に失敗しました。もう一度試してください";
  /** 結果が分からないときに判定を読み直す間（ms） */
  const LOST_RECHECK_MS = [1500, 5000, 15000];
  /** RC のリンクは claude.ai/code の https だけ渡す */
  const RC_HEAD = "https://claude.ai/code/";
  /** 札の題が無いとき */
  const DEFAULT_TITLE = "Claude Code";

  // ===== 状態 =====
  /** sessionId → 1 件 */
  const entries = new Map();

  function entryOf(sessionId) {
    let e = entries.get(sessionId);
    if (e) return e;
    e = {
      id: sessionId,
      root: null,
      scroll: null,
      rowSig: "none",
      sig: "none",
      pane: null,
      check: null,
      checking: false,
      failed: false,
      phase: "idle",
      error: null,
      seq: 0,
      takeover: null,
      timers: [],
      // 最後に描いた札の題（確認の対象・済んだ知らせに使う）
      title: DEFAULT_TITLE,
      on: null,
    };
    const mine = e;
    e.on = {
      take: () => take(mine),
      pane: () => {
        if (typeof mine.pane === "function") mine.pane();
      },
      recheck: () => {
        if (!mine.checking) load(mine);
      },
    };
    entries.set(sessionId, e);
    return e;
  }

  /** 1 件を消す（同じ物が残っているときだけ） */
  function forget(e) {
    if (entries.get(e.id) === e) entries.delete(e.id);
  }

  const text = (v) => (typeof v === "string" && v !== "" ? v : null);
  const path = (sessionId) => "/api/cc/sessions/" + encodeURIComponent(sessionId) + "/takeover";

  /** 一覧の行の状態（cc: の行だけ。Claude Code のチャンネルの行・無いときは null） */
  function rowStateOf(row) {
    if (!row || typeof row.id !== "string" || !row.id.startsWith("cc:")) return null;
    if (row.mark === "running") return "running";
    if (row.mark === "turn") return "waiting";
    return "idle";
  }

  function redraw(e) {
    SA.app.refresh("term:" + e.id);
  }

  function stopTimers(e) {
    for (const t of e.timers) clearTimeout(t);
    e.timers = [];
  }

  function dropRoot(e) {
    if (e.root && SA.term) SA.term.drop(e.root);
    e.root = null;
    e.scroll = null;
  }

  /** 失敗の文: 応答の text → /setup 前 → 例外のトーストの文 */
  function failureText(err) {
    const data = err && err.data;
    const said = data && typeof data === "object" ? text(data.text) : null;
    if (said !== null) return said;
    if (err && err.code === "not_set_up") return NOT_SET_UP_TEXT;
    return (err && text(err.toast)) || FALLBACK_TEXT;
  }

  // ===== 判定を読む =====
  /** keep: 断られた直後の読み直し。読めても失敗の文は残す（次に読めたとき・押し直したときに消す） */
  async function load(e, quiet, keep) {
    e.checking = true;
    const seq = ++e.seq;
    if (!quiet) redraw(e);
    let data = null;
    try {
      data = await SA.api.get(path(e.id), { quiet: true });
    } catch {
      data = null;
    }
    if (seq !== e.seq) return;
    if (data !== null && typeof data === "object") {
      e.check = data;
      e.failed = false;
      if (!keep) e.error = null;
      e.sig = e.rowSig;
    } else {
      e.check = null;
      e.failed = true;
    }
    e.checking = false;
    if (e.phase === "lost" && afterRecheck(e)) return;
    redraw(e);
  }

  /** 結果が分からない間の読み直しの後。済んで札を外したら true */
  function afterRecheck(e) {
    const last = e.check && e.check.last && typeof e.check.last === "object" ? e.check.last : null;
    if (last === null || typeof last.takeover !== "number") return false;
    // 後から別の取り込みが作られていれば、自分の分はもう終わっている（結果は分からないので、今の判定だけ見せる）
    if (last.takeover > e.takeover) {
      toIdle(e, null);
      return false;
    }
    if (last.takeover !== e.takeover) return false;
    if (last.state === "done") {
      if (text(last.id) !== null) {
        done(e, last.id);
        return true;
      }
      // 済んだが行き先が返らない: 知らせて一覧を読み直し、今の判定を見せる
      toIdle(e, null);
      SA.ui.toast(doneText(e));
      SA.topics.load();
      return false;
    }
    if (last.state === "failed") {
      toIdle(e, null);
      fail(e, FAILED_TEXT);
    } else if (last.state === "awaiting_confirm" || last.state === "cancelled") {
      toIdle(e, null);
      fail(e, NOT_STARTED_TEXT);
    }
    return false;
  }

  function toIdle(e, error) {
    stopTimers(e);
    e.phase = "idle";
    e.takeover = null;
    e.error = error;
  }

  /** 進めた後の失敗の文を札に置く。札を出していなければ知らせも出す（文は、札に戻って開いたときの読み直しでは消さない） */
  function fail(e, error) {
    e.error = error;
    if (SA.app.activeTabId() !== "term:" + e.id) SA.ui.toast("「" + e.title + "」: " + error, null, { level: "error" });
  }

  // ===== 取り込む =====
  async function take(e) {
    if (e.phase !== "idle" || !e.check || e.check.takeable !== true) return;
    e.phase = "proposing";
    e.error = null;
    redraw(e);
    let res;
    try {
      res = await SA.api.post(path(e.id), {}, { quiet: true });
    } catch (err) {
      e.phase = "idle";
      e.error = failureText(err);
      if (err && err.status === 0) redraw(e);
      else load(e, false, true);
      return;
    }
    if (!res || typeof res.id !== "number") {
      e.phase = "idle";
      e.error = FALLBACK_TEXT;
      load(e, false, true);
      return;
    }
    const id = res.id;
    e.phase = "asking";
    e.takeover = id;
    redraw(e);
    let accepted = false;
    SA.ui.confirm({
      title: CONFIRM_TITLE,
      target: e.title,
      body: typeof res.text === "string" ? res.text : "",
      ok: CONFIRM_OK,
      danger: true,
      run: () => {
        accepted = true;
        go(e, id);
      },
      // closed は run より先に呼ばれるので、やめたかどうかは次の microtask で見る
      closed: () => {
        queueMicrotask(() => {
          if (!accepted) stop(e, id);
        });
      },
    });
  }

  /** 確認をやめた（結果は捨てる。失敗しても知らせない。行は 10 分で失効する） */
  function stop(e, id) {
    if (e.phase !== "asking" || e.takeover !== id) return;
    e.phase = "idle";
    e.takeover = null;
    redraw(e);
    SA.api.post("/api/cc/takeovers/" + id + "/cancel", {}, { quiet: true }).catch(() => {});
  }

  /** 確認で進めた（終わるまで待つので時間切れを付けない） */
  async function go(e, id) {
    if (e.phase !== "asking" || e.takeover !== id) return;
    e.phase = "taking";
    redraw(e);
    let res;
    try {
      res = await SA.api.post("/api/cc/takeovers/" + id + "/confirm", {}, { quiet: true });
    } catch (err) {
      if (err && err.status === 409) {
        toIdle(e, null);
        const stale = err.code === "stale";
        if (stale) SA.ui.toast(failureText(err), null, { level: "error" });
        else fail(e, failureText(err));
        load(e, false, !stale);
      } else lost(e);
      return;
    }
    if (res && res.ok === true && text(res.id) !== null) done(e, res.id);
    else lost(e);
  }

  /** 結果が分からない: 決めた間で判定を読み直す（［確かめ直す］も出る） */
  function lost(e) {
    e.phase = "lost";
    redraw(e);
    stopTimers(e);
    e.timers = LOST_RECHECK_MS.map((ms) => setTimeout(() => load(e), ms));
  }

  /** 済んだ: 札を外して知らせ、一覧を読み直す。札が出ていたときだけ新しい話題を開く */
  function done(e, channelTabId) {
    const shown = SA.app.activeTabId() === "term:" + e.id;
    stopTimers(e);
    e.phase = "idle";
    e.takeover = null;
    dropRoot(e);
    forget(e);
    SA.ui.toast(doneText(e));
    SA.topics.load();
    if (shown) SA.app.open(channelTabId);
  }

  function doneText(e) {
    return "「" + e.title + "」を取り込みました";
  }

  // ===== 口 =====
  /** 札を列 2 の ed に描く（ctx: { row, place, pane }）。描けなければ false */
  function render(ed, sessionId, ctx) {
    if (!SA.term) return false;
    const e = entryOf(sessionId);
    const row = ctx && ctx.row ? ctx.row : null;
    e.pane = ctx && typeof ctx.pane === "function" ? ctx.pane : null;
    const rowState = rowStateOf(row);
    e.rowSig = rowState === null ? "none" : rowState;
    // 行の状態が前に読んだときと違えば読み直す（描き直さない。この描きが確かめている形になる）
    if (e.check !== null && !e.checking && e.phase === "idle" && e.rowSig !== e.sig) load(e, true);
    if (ed.firstElementChild !== e.scroll || e.scroll === null) {
      e.root = SA.ui.el("div", { "data-term": "" });
      e.scroll = SA.ui.el("div", { class: "ed-scroll" }, [e.root]);
      ed.replaceChildren(e.scroll);
    }
    const check = e.check;
    e.title = (row && text(row.title)) || (check && text(check.title)) || DEFAULT_TITLE;
    const place = ctx && ctx.place !== null && ctx.place !== undefined ? ctx.place : (check && text(check.project)) || null;
    const at = (row && text(row.activityAt)) || (check && text(check.activityAt)) || null;
    const raw = {
      title: e.title,
      place,
      rowState,
      activity: at === null ? null : SA.ui.dateTime(at),
      pane: row !== null || (check !== null && ["idle", "running", "waiting"].includes(check.state)),
      check:
        check === null
          ? null
          : {
              takeable: check.takeable === true,
              state: check.state,
              reason: check.reason,
              text: check.text,
              rcUrl: typeof check.rcUrl === "string" && check.rcUrl.startsWith(RC_HEAD) ? check.rcUrl : null,
            },
      checking: e.checking,
      failed: e.failed,
      phase: e.phase,
      error: e.error,
      on: e.on,
    };
    return SA.term.draw(e.root, raw) === true;
  }

  /** 札を開いた（読んでいなければ判定を読む。離れている間の失敗の文が残っていれば、この読み直しでは消さない） */
  function open(sessionId) {
    const e = entryOf(sessionId);
    if (!e.checking) load(e, false, e.error !== null);
  }

  /** 札を閉じた（読み直しのタイマーは止めない。途中の取り込みは残して応答を受ける） */
  function close(sessionId) {
    const e = entries.get(sessionId);
    if (!e) return;
    dropRoot(e);
    if (e.phase === "idle") forget(e);
  }

  SA.takeover = { render, open, close };
})();
