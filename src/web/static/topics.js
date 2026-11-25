// 新しい殻（index.html）の話題の一覧（列 1）: GET /api/topics を読んで状態を持ち、描くのは部品（入口 c-app.js の SA.list.draw。
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
  /** 一覧から最後に開いた話題（「あなたの番 N」のボタンの次の起点。右腕は current にならないので別に持つ） */
  let turnFrom = null;
  let lastLoadAt = 0;
  /** schedule の残りの時間の後の 1 回 */
  let pending = null;
  /** polling の次の 1 回 */
  let timer = null;
  /** 読んでいる途中の 1 回と、その間に頼まれたか（終わったらもう 1 回だけ読む） */
  let inflight = null;
  let again = false;
  /** setPins の世代（#507）。読んでいる途中に留めた・外した物を、古い応答の pins で戻さない */
  let pinGen = 0;

  /** 読み直しの最短の間（schedule） */
  const MIN_GAP_MS = 2000;
  /** polling: 待っている番（許可・質問・判断待ち・確認）か作業中があれば 10 秒、無ければ 60 秒。上限・失敗で止まった番はオーナーが動くまで変わらないので急がない */
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
        const gen = pinGen;
        const next = await SA.api.get("/api/topics" + (asked ? "?done=" + encodeURIComponent(asked) : ""), { quiet: true });
        if (next && Array.isArray(next.groups) && Array.isArray(next.topics) && Array.isArray(next.turnIds) && Array.isArray(next.rightHands)) {
          // 読んでいる間に setPins があれば、古い応答の pins・pinMax は今の値に置き換える
          if (gen !== pinGen && data) {
            next.pins = data.pins;
            next.pinMax = data.pinMax;
          }
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
      timer = setTimeout(load, counts().turns > stoppedTurns() || counts().running > 0 ? BUSY_MS : IDLE_MS);
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
    return { turns: data ? data.turns : 0, running: data ? data.topics.filter((t) => t !== null && typeof t === "object" && t.mark === "running").length : 0 };
  }

  /** 上限・失敗で止まった番の話題の数（counts().turns に含まれる。polling を急がせない分） */
  function stoppedTurns() {
    if (!data) return 0;
    return data.topics.filter((t) => t !== null && typeof t === "object" && t.mark === "turn" && !!t.turn && (t.turn.kind === "max_turns" || t.turn.kind === "failed")).length;
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
  /** 右腕の行の作業中の印（#514）。チャンネルに実行中のターンが在るか */
  const IS_RUNNING = (channelId) => store.runningOf(channelId) !== null;

  /** 一覧の部品が押されたとき（1 回だけ作る） */
  const LIST_ON = {
    open(id, done) {
      // 右腕は列 2 に開かず描き直しが来ないことがあるので、起点が変わったらここで描き直す（次に押したとき先へ進む）
      if (turnFrom !== id) {
        turnFrom = id;
        render();
      }
      openRow(id, done);
    },
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
      turnFrom,
      othersOpen: othersSaved(),
      isUnread: IS_UNREAD,
      isRunning: IS_RUNNING,
      // 一覧の一番上に右腕の行（#514。いつも）
      handRow: true,
      time: SA.ui.shortTime,
      ago: SA.views.ago,
      on: LIST_ON,
    };
  }

  // ===== 描く =====
  /**
   * 部品に描かせる。描けなかったら（入口が false）失敗にして、失敗の表示を 1 回だけ描き直す。
   * 同じ data ではまた描けないので、2 回目は data の無い形で渡す（data 自体は消さない。次の読み取りで置き換わる）
   */
  function render() {
    if (data) document.title = (data.turns > 0 ? "(" + data.turns + ") " : "") + "self-agent";
    if (!SA.list) return;
    const ok = SA.list.draw(listState());
    if (!ok && !failed) {
      failed = true;
      SA.list.draw({ ...listState(), data: null, failed: true });
    }
  }

  /** 絞り込みの文字を変える（描き直しは呼んだ側の render） */
  function setFilter(value) {
    filter = String(value || "");
  }

  /** 一覧で選んでいる話題（aria-current）を変える（描き直しは呼んだ側の render） */
  function setCurrent(id) {
    current = id || null;
    if (current !== null) turnFrom = current;
  }

  // ===== ピン留め（#507。GET /api/topics の pins・pinMax） =====
  /** 留めた話題の channelId（留めた順。ch: は付かない）。形が違えば空 */
  function pins() {
    return data && Array.isArray(data.pins) ? data.pins.filter((id) => typeof id === "string") : [];
  }

  /** 留められる数（0 = ピン留めの口が無い） */
  function pinMax() {
    return data && Number.isInteger(data.pinMax) && data.pinMax >= 1 ? data.pinMax : 0;
  }

  /** POST …/pin の応答（{ pins, pinMax }）を取り込んで描き直す（load の後と同じ道）。形が違う・まだ読めていなければ何もしない */
  function setPins(res) {
    if (!data || !res || !Array.isArray(res.pins) || typeof res.pinMax !== "number") return;
    pinGen++;
    data.pins = res.pins;
    data.pinMax = res.pinMax;
    render();
    SA.app.refreshTabs();
  }

  SA.topics = { load, schedule, render, find, data: () => data, counts, setFilter, setCurrent, pins, pinMax, setPins };
})();
