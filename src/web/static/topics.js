// 新しい殻（v3.html）の話題の一覧（列 1）: GET /api/topics を読んで状態を持ち、描くのは部品（入口 c-app.js の SA.list.draw。
// docs/plan/web-ui-components.md §9 の K3。スクロール位置・焦点を保つのも入口）
"use strict";

(function () {
  const SA = (window.SA = window.SA || {});
  const store = SA.store;

  // ===== 状態 =====
  /** 最後に読めた TopicsResult（src/app/topics.ts） */
  let data = null;
  /** 最後の読み取りが失敗した（data は前のまま） */
  let failed = false;
  /** 完了を開いている群の key（?done=。開いておけるのは 1 つ） */
  let doneGroup = null;
  /** 今の data を読んだときの ?done= の群（違えば、開いた完了はまだ読み込み中） */
  let dataDone = null;
  /** 絞り込みの文字（題名・群・人格の名前。サーバーには訊かない） */
  let filter = "";
  /** 一覧で選んでいる話題（列 2 の話題の ID。[端末] の間も ch: のまま。shell.js が setCurrent で渡す） */
  let current = null;
  let lastLoadAt = 0;
  /** schedule の残りの時間の後の 1 回 */
  let pending = null;
  /** polling の次の 1 回 */
  let timer = null;
  /** 読んでいる途中の 1 回と、その間に頼まれたか（終わったらもう 1 回だけ読む） */
  let inflight = null;
  let again = false;

  /** 読み直しの最短の間（schedule） */
  const MIN_GAP_MS = 2000;
  /** polling: あなたの番か作業中があれば 10 秒、無ければ 60 秒 */
  const BUSY_MS = 10000;
  const IDLE_MS = 60000;

  /** 「ほかのプロジェクト」の開閉（値 "1" で開。既定は閉じる） */
  const OTHERS_KEY = "self-agent-web:v3-others";

  // ===== 読む =====
  function load() {
    if (inflight) {
      again = true;
      return inflight;
    }
    clearTimeout(pending);
    pending = null;
    lastLoadAt = Date.now();
    inflight = (async () => {
      try {
        const asked = doneGroup;
        const next = await SA.api.get("/api/topics" + (asked ? "?done=" + encodeURIComponent(asked) : ""), { quiet: true });
        if (next && Array.isArray(next.groups) && Array.isArray(next.topics) && Array.isArray(next.turnIds) && Array.isArray(next.rightHands)) {
          data = next;
          // 既読（M7）: 応答の reads を取り込み、こちらの方が進んでいる話題（ch:）と右腕を送る（描くのはこの後の render）
          const ids = next.topics
            .concat(next.rightHands)
            .map((t) => t && t.id)
            .filter((id) => typeof id === "string" && id.startsWith("ch:"))
            .map((id) => id.slice(3));
          dataDone = asked;
          failed = false;
          store.syncReads(next.reads, ids);
        } else failed = true;
      } catch {
        failed = true;
      }
      try {
        render();
      } catch {
        // 描けなかったものは失敗として出す（次の予約は必ず掛ける）
        failed = true;
      } finally {
        arm();
      }
      SA.app.refreshTabs();
    })();
    return inflight.finally(() => {
      inflight = null;
      if (again) {
        again = false;
        schedule();
      }
    });
  }

  /** 最後の読み取りから MIN_GAP_MS 以上たっていればすぐ、たっていなければ残りの時間の後に 1 回だけ読む */
  function schedule() {
    const wait = lastLoadAt + MIN_GAP_MS - Date.now();
    if (wait <= 0) {
      load();
      return;
    }
    if (pending !== null) return;
    pending = setTimeout(() => {
      pending = null;
      load();
    }, wait);
  }

  /** 次の polling を 1 つ予約する（前の予約は消す）。隠れている間・止めた後は予約しない */
  function arm() {
    clearTimeout(timer);
    timer = null;
    if (document.visibilityState === "visible" && !SA.poll.stopped()) {
      timer = setTimeout(load, counts().turns > 0 || counts().running > 0 ? BUSY_MS : IDLE_MS);
    }
  }

  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") schedule();
    else {
      clearTimeout(timer);
      timer = null;
    }
  });

  function find(id) {
    if (!data) return null;
    return data.topics.find((t) => t.id === id) || null;
  }

  function counts() {
    return { turns: data ? data.turns : 0, running: data ? data.topics.filter((t) => t.mark === "running").length : 0 };
  }

  // ===== 行を開く =====
  /**
   * 行を開く。完了の行は /api/channels の一覧に無いことがある（あちらの完了は新しい 10 件だけ）ので、
   * 引けなければ一覧を 1 回読んでからもう一度引き、それでも引けなければ知らせる（黙らない）
   */
  async function openRow(id, done) {
    const waitsStatus = id.startsWith("cc:") && SA.store.status === null;
    if (!done || waitsStatus || SA.views.info(id)) {
      SA.app.open(id);
      return;
    }
    try {
      await SA.store.load.channels({ quiet: true });
    } catch {
      // 読めなくても下で引き直して知らせる
    }
    if (SA.views.info(id)) SA.app.open(id);
    else if (SA.ui.toast) SA.ui.toast("この話題はここからは開けません");
  }

  // ===== 「ほかのプロジェクト」（話題の無いプロジェクトの群を畳む） =====
  function othersSaved() {
    try {
      return window.localStorage.getItem(OTHERS_KEY) === "1";
    } catch {
      return false;
    }
  }

  function saveOthers(open) {
    try {
      window.localStorage.setItem(OTHERS_KEY, open ? "1" : "0");
    } catch {
      // 保存できない環境では覚えないだけ
    }
  }

  // ===== 部品の入口（c-app.js の SA.list）へ渡す物 =====
  /** 部品は (channelId, last) で訊く（store.isUnread は { id, last }） */
  const IS_UNREAD = (channelId, last) => store.isUnread({ id: channelId, last });

  /** 一覧の部品が押されたとき（1 回だけ作る） */
  const LIST_ON = {
    open: (id, done) => openRow(id, done),
    add: (key, opener) => SA.app.newSession(key, opener),
    toggleDone(key) {
      // 開いておけるのは 1 つ。開いたら ?done= で読み直し、閉じたら読み直さない
      if (doneGroup !== key) {
        doneGroup = key;
        render();
        load();
      } else {
        doneGroup = null;
        render();
      }
    },
    toggleOthers() {
      // 絞り込み中は開いたまま（保存した開閉は変えない）
      if (filter.trim() !== "") return;
      saveOthers(!othersSaved());
      render();
    },
    retry: () => load(),
  };

  /** listModel（c-list.js）が読む状態 */
  function listState() {
    return {
      data,
      failed,
      filter,
      current,
      doneGroup,
      dataDone,
      othersOpen: othersSaved(),
      isUnread: IS_UNREAD,
      time: SA.ui.shortTime,
      ago: SA.views.ago,
      on: LIST_ON,
    };
  }

  // ===== 描く =====
  /** 部品に描かせる。描けなかったら（入口が false）失敗にして、失敗の表示を 1 回だけ描き直す */
  function render() {
    if (!SA.list) return;
    const ok = SA.list.draw(listState());
    if (data) document.title = (data.turns > 0 ? "(" + data.turns + ") " : "") + "self-agent";
    if (!ok && !failed) {
      failed = true;
      SA.list.draw(listState());
    }
  }

  /** 絞り込みの文字を変える（描き直しは呼んだ側の render） */
  function setFilter(value) {
    filter = String(value || "");
  }

  /** 一覧で選んでいる話題（aria-current）を変える（描き直しは呼んだ側の render） */
  function setCurrent(id) {
    current = id || null;
  }

  SA.topics = { load, schedule, render, find, data: () => data, counts, setFilter, setCurrent };
})();
