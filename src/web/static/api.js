// サーバーとのやりとり: fetch の包み（SA.api）・/api/* の結果を持つメモリの状態（SA.store）・既読（localStorage の seen）・polling（SA.poll）
"use strict";

(function () {
  const SA = (window.SA = window.SA || {});

  const STATUS_INTERVAL_MS = 10000;
  const CHANNELS_INTERVAL_MS = 60000;
  const TURNS_INTERVAL_MS = 5000;
  /** polling が続けて失敗している間は間隔を倍にしていき、ここで止める */
  const POLL_BACKOFF_MAX_MS = 60000;
  /** 会話のタブで一度に読む行の数（開いたとき・上にスクロールしたとき） */
  const TURNS_PAGE = 50;
  /** 会話ログで 1 日分として読む件数（/api/devlog の last の上限） */
  const DEVLOG_LAST = 200;
  const SEEN_KEY = "self-agent-web:seen";

  /**
   * 失敗は 401 なら /login へ、それ以外は「<status>: <error>」のトーストを出して reject する（error.status に HTTP の status、error.toast にトーストの文）。
   * opts.quiet ならトーストは出さない（呼び出し側が出すかを決める）
   */
  async function request(method, path, body, opts) {
    const quiet = !!(opts && opts.quiet);
    const init = { method, headers: { "X-Self-Agent": "1" }, credentials: "same-origin", cache: "no-store" };
    if (method === "POST") {
      init.headers["Content-Type"] = "application/json";
      init.body = JSON.stringify(body ?? {});
    }
    let res;
    try {
      res = await fetch(path, init);
    } catch (err) {
      const text = "サーバーにつながりません";
      if (!quiet) SA.ui.toast(text);
      if (err && typeof err === "object") err.toast = text;
      throw err;
    }
    if (res.status === 401) {
      // / はトークンがあれば /login へ 302、無ければ「Tailscale でつないでください」を返す（/login はトークンが無いと 404）
      location.href = "/";
      throw new Error("unauthorized");
    }
    let data = null;
    try {
      data = await res.json();
    } catch {
      data = null;
    }
    if (!res.ok) {
      const error = data && typeof data.error === "string" ? data.error : res.statusText || "error";
      if (!quiet) SA.ui.toast(res.status + ": " + error);
      const failure = new Error(res.status + ": " + error);
      failure.status = res.status;
      failure.toast = res.status + ": " + error;
      throw failure;
    }
    return data;
  }

  SA.api = {
    get: (path, opts) => request("GET", path, undefined, opts),
    post: (path, body) => request("POST", path, body),
  };

  // ===== 状態（このタブのメモリだけ） =====
  // status: /api/status。usage: /api/usage の結果（date はサーバーが使った日付）。usageDays: /api/usage/days。
  // today: 日付を付けずに /api/usage を呼んだときにサーバーが返した日付（SELF_AGENT_TZ の今日）。
  // channels: /api/channels（guilds・personas・channels）。turns[channelId]: 会話のタブの行（古い順）と、/turns の channel・まだ前があるか。
  // devlogDays: /api/devlog/days。devlog: /api/devlog の結果（date はサーバーが使った日付）。devlogToday: 日付を付けずに読んだときの日付
  const store = {
    status: null,
    usage: null,
    usageFailed: null,
    usageDays: null,
    today: null,
    channels: null,
    turns: {},
    devlogDays: null,
    devlog: null,
    devlogFailed: null,
    devlogToday: null,
    load: {},
  };
  const loading = {};

  /**
   * 同じものを同時に 2 回読まない。失敗は reject せず、トーストだけ（request が出す。quiet なら出さない）。
   * 成功なら null、失敗ならその error で resolve する（polling が続けて失敗しているかを知るため）
   */
  function once(key, fn) {
    if (loading[key]) return loading[key];
    loading[key] = fn()
      .then(
        () => null,
        (err) => err || new Error("failed"),
      )
      .finally(() => {
        loading[key] = null;
      });
    return loading[key];
  }

  /** opts.quiet は polling から（失敗のトーストは polling が出す） */
  store.load.status = (opts) =>
    once("status", async () => {
      const data = await SA.api.get("/api/status", opts);
      store.status = data;
      SA.app.refreshStatus();
      SA.app.refresh("status");
      SA.app.refresh("settings");
      if (data && data.stopping === true && !SA.poll.stopped()) {
        SA.poll.stop();
        SA.ui.toast("再起動中です。終わったら再読み込みしてください");
      }
    });

  /** date は YYYY-MM-DD。省略（null）はサーバーの今日。日付を続けて変えたときは最後に頼んだものだけを使う */
  let usageSeq = 0;
  store.load.usage = (date) => {
    const seq = ++usageSeq;
    return SA.api
      .get("/api/usage" + (date ? "?date=" + encodeURIComponent(date) : ""))
      .then((data) => {
        if (!date && data && typeof data.date === "string") store.today = data.date;
        if (seq !== usageSeq) return;
        store.usage = data;
        store.usageFailed = null;
        SA.app.refresh("usage");
        SA.app.refreshSidebar();
        SA.app.refreshStatus();
      })
      .catch(() => {
        if (seq !== usageSeq) return;
        store.usageFailed = date || "today";
        SA.app.refresh("usage");
      });
  };

  store.load.usageDays = () =>
    once("usageDays", async () => {
      const data = await SA.api.get("/api/usage/days?n=30");
      store.usageDays = Array.isArray(data) ? data : [];
      SA.app.refreshSidebar();
      SA.app.refresh("usage");
      SA.app.refreshStatus();
    });

  // ===== 会話（/api/channels・/turns） =====
  store.load.channels = (opts) =>
    once("channels", async () => {
      const data = await SA.api.get("/api/channels", opts);
      store.channels = {
        guilds: Array.isArray(data && data.guilds) ? data.guilds : [],
        personas: Array.isArray(data && data.personas) ? data.personas : [],
        channels: Array.isArray(data && data.channels) ? data.channels : [],
      };
      SA.app.refreshSidebar();
      SA.app.refreshStatus();
      SA.chat.channelsChanged();
    });

  /** 会話のタブの状態。loaded: 最初の 50 件を読んだ。missing: 404（開けないチャンネル。以後は読まない） */
  function turnsOf(channelId) {
    if (!store.turns[channelId]) store.turns[channelId] = { channel: null, turns: [], hasMore: false, loaded: false, missing: false };
    return store.turns[channelId];
  }

  function turnsPath(channelId, query) {
    return "/api/channels/" + encodeURIComponent(channelId) + "/turns?" + query;
  }

  /** /turns の channel で一覧の 1 件も新しくする（状態・最後の行が変わる）。closeDraft は一覧に入れない */
  function updateChannel(channel) {
    if (!channel || !store.channels) return false;
    const list = store.channels.channels;
    const i = list.findIndex((c) => c.id === channel.id);
    if (i < 0) return false;
    const { closeDraft: _closeDraft, ...rest } = channel;
    const before = list[i];
    list[i] = rest;
    return before.state !== rest.state || (before.last && before.last.id) !== (rest.last && rest.last.id);
  }

  /** 行を id で重ねずに足す（古い順を保つ） */
  function mergeTurns(current, incoming) {
    const known = new Set(current.map((t) => t.id));
    return current.concat(incoming.filter((t) => !known.has(t.id))).sort((a, b) => a.id - b.id);
  }

  /** 開いたときは最新の 50 件、その後は最後の行より後（after）を読む */
  store.load.turns = (channelId, opts) =>
    once("turns:" + channelId, async () => {
      const t = turnsOf(channelId);
      if (t.missing) return;
      let changed = false;
      try {
        if (!t.loaded || t.turns.length === 0) {
          const data = await SA.api.get(turnsPath(channelId, "limit=" + TURNS_PAGE), opts);
          const turns = Array.isArray(data && data.turns) ? data.turns : [];
          changed = !t.loaded || turns.length > 0;
          t.turns = turns;
          // 最新の取得では hasMore は返らないので、件数で前があるかを決める
          t.hasMore = turns.length === TURNS_PAGE;
          t.channel = data && data.channel ? data.channel : t.channel;
          t.loaded = true;
        } else {
          // 5 秒の間に 50 件を超えて増えることはまず無いが、超えたら続けて読む
          for (let i = 0; i < 4; i++) {
            const lastId = t.turns[t.turns.length - 1].id;
            const data = await SA.api.get(turnsPath(channelId, "after=" + lastId + "&limit=" + TURNS_PAGE), opts);
            const turns = Array.isArray(data && data.turns) ? data.turns : [];
            if (data && data.channel) {
              const before = t.channel;
              t.channel = data.channel;
              if (!before || before.state !== data.channel.state || before.title !== data.channel.title) changed = true;
            }
            if (turns.length > 0) {
              t.turns = mergeTurns(t.turns, turns);
              changed = true;
            }
            if (turns.length < TURNS_PAGE) break;
          }
        }
      } catch (err) {
        if (err && err.status === 404) {
          t.missing = true;
          t.loaded = true;
          changed = true;
        } else throw err;
      }
      if (updateChannel(t.channel)) SA.app.refreshSidebar();
      if (changed) {
        SA.app.refresh("ch:" + channelId);
        SA.chat.channelsChanged();
      }
    });

  /** 上にスクロールしたとき: 最初の行より前（before）を 50 件足す */
  store.load.olderTurns = (channelId) =>
    once("older:" + channelId, async () => {
      const t = turnsOf(channelId);
      if (!t.loaded || !t.hasMore || t.turns.length === 0) return;
      const data = await SA.api.get(turnsPath(channelId, "before=" + t.turns[0].id + "&limit=" + TURNS_PAGE));
      const turns = Array.isArray(data && data.turns) ? data.turns : [];
      t.turns = mergeTurns(turns, t.turns);
      t.hasMore = data && data.hasMore === true;
    });

  // ===== 既読（このブラウザだけ。{ [channelId]: 見た最後の history.id }。読めなくても動く） =====
  // 同じブラウザのほかのタブも書くので、書く前に読み直してチャンネルごとに大きい方を残し、storage イベントで読み直す
  function readSeen() {
    try {
      const v = JSON.parse(window.localStorage.getItem(SEEN_KEY) || "null");
      return v !== null && typeof v === "object" && !Array.isArray(v) ? v : {};
    } catch {
      return {};
    }
  }

  /** チャンネルごとに id の大きい方 */
  function mergeSeen(a, b) {
    const merged = {};
    for (const source of [a, b]) {
      for (const [channelId, value] of Object.entries(source)) {
        const id = Number(value);
        if (Number.isFinite(id) && id > (merged[channelId] || 0)) merged[channelId] = id;
      }
    }
    return merged;
  }

  store.seen = mergeSeen(readSeen(), {});

  /** id まで見たことにする。進んだら true */
  store.markSeen = (channelId, id) => {
    if (typeof id !== "number" || !(id > (Number(store.seen[channelId]) || 0))) return false;
    store.seen[channelId] = id;
    store.seen = mergeSeen(readSeen(), store.seen);
    try {
      window.localStorage.setItem(SEEN_KEY, JSON.stringify(store.seen));
    } catch {
      // 保存できない環境では、このタブのメモリだけで覚える
    }
    return true;
  };

  // ほかのタブが既読を書いたら読み直す
  window.addEventListener("storage", (e) => {
    if (e.key !== SEEN_KEY) return;
    store.seen = mergeSeen(readSeen(), store.seen);
    SA.app.refreshSidebar();
    SA.app.refreshStatus();
  });

  /** 最後の行が返事で、まだ見ていない */
  store.isUnread = (channel) => !!(channel && channel.last && channel.last.kind === "agent" && channel.last.id > (Number(store.seen[channel.id]) || 0));

  store.unreadCount = () => (store.channels ? store.channels.channels.filter(store.isUnread).length : 0);

  // ===== 会話ログ（dev モードだけ） =====
  store.load.devlogDays = () =>
    once("devlogDays", async () => {
      const data = await SA.api.get("/api/devlog/days");
      store.devlogDays = Array.isArray(data) ? data : [];
      SA.app.refreshSidebar();
    });

  /** date は YYYY-MM-DD。省略（null）はサーバーの今日。日付を続けて変えたときは最後に頼んだものだけを使う */
  let devlogSeq = 0;
  store.load.devlog = (date) => {
    const seq = ++devlogSeq;
    return SA.api
      .get("/api/devlog?last=" + DEVLOG_LAST + (date ? "&date=" + encodeURIComponent(date) : ""))
      .then((data) => {
        if (!date && data && typeof data.date === "string") store.devlogToday = data.date;
        if (seq !== devlogSeq) return;
        store.devlog = data;
        store.devlogFailed = null;
        SA.app.refresh("devlog");
        SA.app.refreshSidebar();
      })
      .catch(() => {
        if (seq !== devlogSeq) return;
        store.devlogFailed = date || "today";
        SA.app.refresh("devlog");
      });
  };

  SA.store = store;

  // ===== polling（見えているときだけ。隠れたら止め、戻ったら即 1 回） =====
  // /api/status は 10 秒、/api/channels は 60 秒、前に出ている会話のタブの /turns（after）は 5 秒ごと（応答が来てから次を予約する）。
  // 失敗のトーストは続けて失敗している間は最初の 1 回だけで、その間は間隔を倍にして POLL_BACKOFF_MAX_MS まで伸ばす。成功したら元に戻す
  const poll = { started: false, stopped: false };

  function activeTurns(opts) {
    const channelId = SA.chat.activeChannelId();
    return channelId ? store.load.turns(channelId, opts) : Promise.resolve(null);
  }

  /** run は opts（quiet）を受け、成功なら null・失敗ならその error で resolve する。fails は続けて失敗した回数 */
  const polls = {
    status: { base: STATUS_INTERVAL_MS, run: (opts) => store.load.status(opts), fails: 0, timer: null },
    channels: { base: CHANNELS_INTERVAL_MS, run: (opts) => store.load.channels(opts), fails: 0, timer: null },
    turns: { base: TURNS_INTERVAL_MS, run: activeTurns, fails: 0, timer: null },
  };

  function active() {
    return !poll.stopped && document.visibilityState === "visible";
  }

  /** 続けて fails 回失敗した後の間隔 */
  function backoff(base, fails) {
    return fails === 0 ? base : Math.max(base, Math.min(base * 2 ** fails, POLL_BACKOFF_MAX_MS));
  }

  /** 失敗を数え、続く失敗の最初の 1 回だけトーストを出す。成功なら数を戻す */
  function countFailure(p, err) {
    if (!err) {
      p.fails = 0;
      return;
    }
    p.fails++;
    if (p.fails === 1) SA.ui.toast(typeof err.toast === "string" ? err.toast : "サーバーにつながりません");
  }

  /** 1 回読み、終わったら次を予約する（重ねて呼ばれても予約は 1 つ） */
  function runPoll(p) {
    clearTimeout(p.timer);
    p.timer = null;
    if (!active()) return;
    p.run({ quiet: true }).then((err) => {
      countFailure(p, err);
      if (!active()) return;
      clearTimeout(p.timer);
      p.timer = setTimeout(() => runPoll(p), backoff(p.base, p.fails));
    });
  }

  function clearTimers() {
    for (const p of Object.values(polls)) {
      clearTimeout(p.timer);
      p.timer = null;
    }
  }

  function schedule() {
    clearTimers();
    if (!active()) return;
    for (const p of Object.values(polls)) runPoll(p);
    // 隠れている間に返事が来ていれば、戻ったときに既読にする
    SA.chat.markSeenActive();
  }

  SA.poll = {
    start() {
      if (poll.started) return;
      poll.started = true;
      document.addEventListener("visibilitychange", schedule);
      schedule();
    },
    stopped: () => poll.stopped,
    stop() {
      poll.stopped = true;
      clearTimers();
    },
  };
})();
