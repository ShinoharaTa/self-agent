// 新しい殻（index.html）の流れの列（docs/plan/web-ui-deck.md の D1）: 3 つの列の状態と読み込みと、項目を押したときの口。
// 描くのは入口 c-app.js の SA.deck.draw（モデルの純関数は c-deck.js）。見える列の数・席に開いている物・1 列ずつの横送りか（スマホ）は shell.js が setView で渡す。
// 読むのは api.js の store（タスク・リマインドは store.want で polling に足す。GitHub は /api/status で有効と分かってから。無効の間は一度も読まない）。
// init は shell.js が初めて流れの列になったときに呼ぶ（スマホでも。D2）
"use strict";

(function () {
  const SA = (window.SA = window.SA || {});
  const store = SA.store;

  // ===== 状態 =====
  /** 見える列の数（0〜3。shell.js が幅から決める） */
  let cols = 3;
  /** 席に開いているタブの ID（閉じていれば null） */
  let current = null;
  /** 1 列ずつの横送りか（スマホ。shell.js が幅から決める） */
  let paged = false;
  /** GitHub の通知を読むか（/api/status の github.enabled が true になった後） */
  let githubOn = false;
  let started = false;
  /** 最後に押した項目の key（shell.js の open が 1 回だけ読む。閉じた後の焦点の戻り先） */
  let pressedKey = null;
  /** 操作を押してから応答までの項目の key → 押した操作の id（同じ項目を二度送らない。描き直しで押せなくし、回る印は押した方だけ） */
  const busy = new Map();

  /** 部品が押されたとき（1 回だけ作る） */
  const FLOW_ON = {
    open: (item, key) => {
      if (!item || typeof item.target !== "string") return;
      pressedKey = typeof key === "string" ? key : null;
      SA.app.open(item.target);
    },
    // 完了 → views.js の completeTask（知らせと［取り消す］・一覧の読み直しは views.js のまま）、対応 → githubHandoff、
    // 次を飛ばす → skipReminder、止める → 確認（stopReminderAsk）の後に stopReminder。busy は確認の後から
    op: (item, opId) => {
      if (!item || typeof item.key !== "string" || busy.has(item.key)) return;
      const key = item.key;
      const plan = opRun(key, opId);
      if (!plan) return;
      const start = () => {
        if (busy.has(key)) return;
        busy.set(key, opId);
        render();
        const done = () => {
          busy.delete(key);
          render();
        };
        // 同期で投げても busy を残さない
        let answer;
        try {
          answer = plan.run();
        } catch (error) {
          answer = Promise.reject(error);
        }
        Promise.resolve(answer).then(done, done);
      };
      if (plan.ask) SA.ui.confirm(Object.assign({}, plan.ask, { run: start }));
      else start();
    },
    // 節の［ほか n 件］（あなたの番の列の待機。#505）→ 流れの列では「探す」の板
    more: () => {
      if (SA.app && typeof SA.app.palette === "function") SA.app.palette();
    },
  };

  /** 繰り返しのリマインドか（c-deck.js の項目と同じ条件） */
  const repeats = (r) => typeof r.rule === "string" && r.rule !== "";

  /** 項目の key と操作から、元の物に対する { run, ask }（ask は先に出す確認の opts か null）を返す（引けなければ null） */
  function opRun(key, opId) {
    if (opId === "complete") {
      const task = (store.openTasks || []).find((t) => "task:" + t.id === key);
      return task ? { run: () => SA.views.completeTask(null, task), ask: null } : null;
    }
    if (opId === "act") {
      const list = store.github && Array.isArray(store.github.notifications) ? store.github.notifications : [];
      const n = list.find((x) => "gh:" + x.id === key);
      return n && n.handoff ? { run: () => SA.views.githubHandoff(null, n, "act"), ask: null } : null;
    }
    if (opId === "skip" || opId === "cancel") {
      const r = (store.reminders || []).find((x) => "rem:" + x.id === key);
      if (!r) return null;
      if (opId === "skip") return repeats(r) ? { run: () => SA.views.skipReminder(null, r), ask: null } : null;
      return { run: () => SA.views.stopReminder(null, r), ask: SA.views.stopReminderAsk(r) };
    }
    return null;
  }

  const isUnread = (channelId, last) => store.isUnread({ id: channelId, last });

  /** 部品に渡す state（c-deck.js の deckModel の引数） */
  function flowState() {
    return {
      cols,
      current,
      paged,
      topics: SA.topics.data(),
      tasks: store.openTasks,
      reminders: store.reminders,
      github: githubOn && store.github ? store.github.notifications : null,
      handoff: !!(store.github && store.github.handoff),
      notices: store.notices ? store.notices.notices : null,
      today: store.today,
      isUnread,
      time: SA.ui.shortTime,
      ago: SA.views.ago,
      day: SA.views.dayLabel,
      oneLine: SA.views.oneLine,
      parts: SA.views.githubParts,
      ops: true,
      busy: [...busy.keys()],
      busyOp: Object.fromEntries(busy),
      on: FLOW_ON,
    };
  }

  // ===== 読む =====
  /** タスク・リマインドを polling に足して 1 回読む（1 回だけ） */
  function init() {
    if (started) return;
    started = true;
    store.want(["tasks", "reminders"]);
    store.load.tasks({ quiet: true });
    store.load.reminders({ quiet: true });
    status();
  }

  /** /api/status を読んだ後: GitHub が初めて有効と分かったら polling に足して 1 回読む（init の前は何もしない） */
  function status() {
    if (!started || githubOn) return;
    const st = store.status;
    if (!(st && st.github && st.github.enabled === true)) return;
    githubOn = true;
    store.want(["github"]);
    store.load.github({ quiet: true });
  }

  // ===== 描く =====
  function setView(view) {
    cols = view.cols;
    current = view.current;
    paged = view.paged === true;
  }

  /** 入口が在れば描く。描けなければ話題の無い形で 1 回だけ描き直す */
  function render() {
    if (!SA.deck) return;
    const st = flowState();
    if (SA.deck.draw(st)) return;
    SA.deck.draw(Object.assign({}, st, { topics: null }));
  }

  /** 最後に押した項目の key を返して忘れる（無ければ null） */
  function lastKey() {
    const key = pressedKey;
    pressedKey = null;
    return key;
  }

  SA.flows = { init, status, setView, render, state: flowState, lastKey };
})();
