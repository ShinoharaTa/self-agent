// 新しい殻（index.html）の流れの列（docs/plan/web-ui-deck.md の D1）: 3 つの列の状態と読み込みと、項目を押したときの口。
// 描くのは入口 c-app.js の SA.deck.draw（モデルの純関数は c-deck.js）。見える列の数と席に開いている物は shell.js が setView で渡す。
// 読むのは api.js の store（タスク・リマインドは store.want で polling に足す。GitHub は /api/status で有効と分かってから。無効の間は一度も読まない）
"use strict";

(function () {
  const SA = (window.SA = window.SA || {});
  const store = SA.store;

  // ===== 状態 =====
  /** 見える列の数（0〜3。shell.js が幅から決める） */
  let cols = 3;
  /** 席に開いているタブの ID（閉じていれば null） */
  let current = null;
  /** GitHub の通知を読むか（/api/status の github.enabled が true になった後） */
  let githubOn = false;
  let started = false;
  /** 最後に押した項目の key（shell.js の open が 1 回だけ読む。閉じた後の焦点の戻り先） */
  let pressedKey = null;

  /** 部品が押されたとき（1 回だけ作る） */
  const FLOW_ON = {
    open: (item, key) => {
      if (!item || typeof item.target !== "string") return;
      pressedKey = typeof key === "string" ? key : null;
      SA.app.open(item.target);
    },
  };

  const isUnread = (channelId, last) => store.isUnread({ id: channelId, last });

  /** 部品に渡す state（c-deck.js の deckModel の引数） */
  function flowState() {
    return {
      cols,
      current,
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
      ops: false,
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

  /** /api/status を読んだ後: GitHub が初めて有効と分かったら polling に足して 1 回読む */
  function status() {
    if (githubOn) return;
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
