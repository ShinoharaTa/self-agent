// サーバーとのやりとり: fetch の包み（SA.api）・/api/* の結果を持つメモリの状態（SA.store）・既読（localStorage の seen）・polling（SA.poll）・
// 実行中のターン（/api/running）とパネルの「出力」への手順・終わり方
"use strict";

(function () {
  const SA = (window.SA = window.SA || {});

  const STATUS_INTERVAL_MS = 10000;
  const CHANNELS_INTERVAL_MS = 60000;
  const TURNS_INTERVAL_MS = 5000;
  /** polling が続けて失敗している間は間隔を倍にしていき、ここで止める */
  const POLL_BACKOFF_MAX_MS = 60000;
  /** /api/running の間隔（実行中のターンがあるとき・無いとき） */
  const RUNNING_BUSY_MS = 2000;
  const RUNNING_IDLE_MS = 10000;
  /** ターンが終わってから返事の行が書かれるまで（Discord への返信の後）を待って、もう一度読むまでの時間 */
  const END_RELOAD_MS = 2500;
  /** 会話のタブで一度に読む行の数（開いたとき・上にスクロールしたとき） */
  const TURNS_PAGE = 50;
  /** 会話ログで 1 日分として読む件数（/api/devlog の last の上限） */
  const DEVLOG_LAST = 200;
  /** 知らせ・GitHub の通知・ナレッジの一覧で読む件数 */
  const NOTICES_LAST = 50;
  const GITHUB_LAST = 50;
  const KNOWLEDGE_LAST = 30;
  const SEEN_KEY = "self-agent-web:seen";

  /**
   * 失敗は 401 なら /login へ、それ以外は「<status>: <error>」のトーストを出して reject する（error.status に HTTP の status（つながらなければ 0）、
   * error.code に応答の error、error.data に応答の JSON（読めなければ null）、error.toast にトーストの文）。opts.quiet ならトーストは出さない（呼び出し側が出すか・文を選ぶ）
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
      if (err && typeof err === "object") {
        err.status = 0;
        err.toast = text;
      }
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
      failure.code = data && typeof data.error === "string" ? data.error : null;
      failure.data = data;
      failure.toast = res.status + ": " + error;
      throw failure;
    }
    return data;
  }

  SA.api = {
    get: (path, opts) => request("GET", path, undefined, opts),
    post: (path, body, opts) => request("POST", path, body, opts),
  };

  // ===== 状態（このタブのメモリだけ） =====
  // status: /api/status。usage: /api/usage の結果（date はサーバーが使った日付）。usageDays: /api/usage/days。
  // today: 日付を付けずに /api/usage を呼んだときにサーバーが返した日付（SELF_AGENT_TZ の今日）。
  // channels: /api/channels（guilds・personas・channels）。turns[channelId]: 会話のタブの行（古い順）と、/turns の channel・まだ前があるか。
  // devlogDays: /api/devlog/days。devlog: /api/devlog の結果（date はサーバーが使った日付）。devlogToday: 日付を付けずに読んだときの日付。
  // running: /api/running の turns（まだ読んでいなければ null）。runningAt: それを受け取った時刻（経過時間を進めて見せる）。
  // taskStatus: タスクのタブで出している状態。tasks: その状態の /api/tasks（{ status, tasks, counts }）。openTasks: open の一覧（サイドバー）。
  // reminders: /api/reminders。memories: /api/memories（どれもまだ読んでいなければ null）。
  // notices: /api/notices（{ notices, recent24h }）。github: /api/github（{ status, notifications }）。
  // knowledge: /api/knowledge の結果（{ q, entries, more }。q は検索した語で、空なら新しい順）。
  // kbEntries[id]: /api/knowledge/<id> の entry（404 なら "missing"、それ以外の失敗は "failed"）
  // projects: /api/projects（まだ読んでいなければ null）。projectFiles[slug]: /files の結果（{ files, truncated, missing }。missing は 404）。
  // projectFile[slug]: 選んだファイルの中身（{ path, text, error, maxBytes }。読んでいる間は text も error も null。maxBytes は 413 の応答の上限（無ければ null））
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
    running: null,
    runningAt: 0,
    taskStatus: "open",
    tasks: null,
    openTasks: null,
    reminders: null,
    memories: null,
    notices: null,
    github: null,
    knowledge: null,
    kbEntries: {}, kbRetryFailed: {},
    projects: null,
    projectFiles: {},
    projectFile: {},
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
      // 時刻の表示のタイムゾーン（timeZone）が来た・変わったら、前に出ているタブとサイドバーの時刻も描き直す
      const zoneChanged = (store.status && store.status.timeZone) !== (data && data.timeZone);
      store.status = data;
      SA.app.refreshStatus();
      SA.app.refresh("status");
      SA.app.refresh("settings");
      if (zoneChanged) {
        const tabId = SA.app.activeTabId();
        if (tabId && tabId !== "status" && tabId !== "settings") SA.app.refresh(tabId);
        SA.app.refreshSidebar();
      }
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
        if (!date && data && typeof data.date === "string" && store.today !== data.date) {
          store.today = data.date;
          // 期限を過ぎたタスクの印は今日で決まる
          SA.app.refresh("tasks");
        }
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
      // 一覧に無いチャンネル（削除した・開けなくなった）の書きかけを捨てる。形の違う応答では捨てない
      if (Array.isArray(data && data.channels)) SA.app.pruneDrafts(store.channels.channels.map((c) => c && c.id));
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

  /** 行を id で重ねずに足す（古い順を保つ）。同じ id はサーバーの行（incoming）で置き換える（Web から送った仮の行を本物にする） */
  function mergeTurns(current, incoming) {
    const byId = new Map(current.map((t) => [t.id, t]));
    for (const t of incoming) byId.set(t.id, t);
    return [...byId.values()].sort((a, b) => a.id - b.id);
  }

  /** サーバーから受け取った行（Web から送った直後に足した仮の行を除く） */
  function realTurns(t) {
    return t.turns.filter((row) => !row.optimistic);
  }

  // ===== パネルの「出力」: 実行中のターンの手順と、返事の行の終わり方 =====
  /** 終わり方を出した返事の行（id）。ターンが終わったと分かったチャンネル（返事の行が来たら終わり方を出す） */
  const reportedEnds = new Set();
  const pendingEnds = new Set();

  function whereOf(channelId) {
    const t = store.turns[channelId];
    const ch = (t && t.channel) || (store.channels ? store.channels.channels.find((c) => c.id === channelId) : null);
    return ch ? SA.chat.channelTitle(ch) : "会話";
  }

  /**
   * 読んだ行のうち、終わり方のある返事の行を出力に出す。incremental（after で読んだ）なら新しい行を全部、最初の読み込みでは
   * ターンの終わりを待っているチャンネルの最後の行だけ（開いたときに昔の行を並べない）
   */
  function reportEnds(channelId, rows, incremental) {
    const agents = rows.filter((row) => row.kind === "agent" && row.outcome && !reportedEnds.has(row.id));
    const last = rows[rows.length - 1];
    for (const row of agents) {
      reportedEnds.add(row.id);
      if (incremental || (pendingEnds.has(channelId) && row === last)) SA.app.addOutput(whereOf(channelId), SA.chat.endText(row));
    }
    if (last && last.kind === "agent" && last.outcome) pendingEnds.delete(channelId);
  }

  /** 開いたときは最新の 50 件、その後は最後の行より後（after）を読む */
  store.load.turns = (channelId, opts) =>
    once("turns:" + channelId, async () => {
      const t = turnsOf(channelId);
      if (t.missing) return;
      let changed = false;
      try {
        if (!t.loaded || realTurns(t).length === 0) {
          const data = await SA.api.get(turnsPath(channelId, "limit=" + TURNS_PAGE), opts);
          const turns = Array.isArray(data && data.turns) ? data.turns : [];
          changed = !t.loaded || turns.length > 0 || t.turns.length > 0;
          reportEnds(channelId, turns, false);
          t.turns = turns;
          // 最新の取得では hasMore は返らないので、件数で前があるかを決める
          t.hasMore = turns.length === TURNS_PAGE;
          t.channel = data && data.channel ? data.channel : t.channel;
          t.loaded = true;
        } else {
          // 5 秒の間に 50 件を超えて増えることはまず無いが、超えたら続けて読む
          for (let i = 0; i < 4; i++) {
            const real = realTurns(t);
            const lastId = real[real.length - 1].id;
            const data = await SA.api.get(turnsPath(channelId, "after=" + lastId + "&limit=" + TURNS_PAGE), opts);
            const turns = Array.isArray(data && data.turns) ? data.turns : [];
            if (data && data.channel) {
              const before = t.channel;
              t.channel = data.channel;
              if (!before || before.state !== data.channel.state || before.title !== data.channel.title) changed = true;
            }
            if (turns.length > 0) {
              reportEnds(channelId, turns, true);
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

  /** Web から送った直後に、本物の行（同じ id）が来るまでの仮の owner の行を足す（会話をまだ読んでいなければ足さない） */
  store.addOptimisticTurn = (channelId, turnId, text) => {
    const t = store.turns[channelId];
    if (!t || !t.loaded || t.missing || typeof turnId !== "number" || turnId < 1) return;
    if (t.turns.some((row) => row.id === turnId)) return;
    const row = { id: turnId, at: new Date().toISOString(), kind: "owner", source: "web", text, outcome: null, steps: null, toolCalls: null, durationMs: null, messageId: null, link: null, optimistic: true };
    t.turns = mergeTurns(t.turns, [row]);
    SA.app.refresh("ch:" + channelId);
  };

  // ===== 実行中のターン（/api/running） =====
  /** そのチャンネルの実行中のターン。無ければ null */
  store.runningOf = (channelId) => (store.running ? store.running.find((r) => r.channelId === channelId) || null : null);

  /** 経過時間（受け取った後の時間を足す） */
  store.runningElapsed = (turn) => turn.elapsedMs + (Date.now() - store.runningAt);

  /**
   * 前回との差: 始まった・終わった・手順が進んだチャンネルの会話を読み直し、出力に手順を積む。
   * 終わったチャンネルは返事の行が書かれるのを待ってもう一度読む
   */
  function applyRunning(next) {
    const before = new Map((store.running || []).map((r) => [r.channelId, r]));
    const after = new Map(next.map((r) => [r.channelId, r]));
    const changed = [];
    const started = [];
    for (const [channelId, turn] of after) {
      const prev = before.get(channelId);
      const sameTurn = prev && prev.turnSeq === turn.turnSeq;
      if (!sameTurn) {
        SA.app.addOutput(whereOf(channelId), "ターンを始めました");
        started.push(channelId);
      }
      const known = sameTurn ? prev.toolCalls : 0;
      const added = Math.min(Math.max(turn.toolCalls - known, 0), turn.steps.length);
      for (const step of turn.steps.slice(turn.steps.length - added)) SA.app.addOutput(whereOf(channelId), step);
      if (!sameTurn || prev.toolCalls !== turn.toolCalls || prev.label !== turn.label) changed.push(channelId);
      // 前のターンが終わって次が始まっていれば、前のターンの返事も待つ
      if (prev && !sameTurn) pendingEnds.add(channelId);
    }
    const ended = [...before.keys()].filter((channelId) => !after.has(channelId) || after.get(channelId).turnSeq !== before.get(channelId).turnSeq);
    for (const channelId of ended) {
      pendingEnds.add(channelId);
      if (!changed.includes(channelId)) changed.push(channelId);
    }
    store.running = next;
    store.runningAt = Date.now();
    // 開いている会話は描き直す（実行中の行）。手順・ツール回数が変わっただけなら会話は読み直さない
    for (const channelId of changed) SA.app.refresh("ch:" + channelId);
    // 会話を読み直すのはターンが始まった（読んだことがあるチャンネル）・終わったときだけ
    for (const channelId of new Set([...started, ...ended])) {
      const t = store.turns[channelId];
      if ((t && t.loaded) || ended.includes(channelId)) store.load.turns(channelId);
    }
    for (const channelId of ended) setTimeout(() => store.load.turns(channelId), END_RELOAD_MS);
    if (changed.length > 0 || before.size !== after.size) {
      SA.app.refreshTabMarks();
      SA.app.refreshSidebar();
      SA.app.refreshStatus();
    }
  }

  /** opts.quiet は polling から（失敗のトーストは polling が出す） */
  store.load.running = (opts) =>
    once("running", async () => {
      const data = await SA.api.get("/api/running", opts);
      const turns = Array.isArray(data && data.turns) ? data.turns.filter((r) => r && typeof r.channelId === "string") : [];
      for (const r of turns) {
        if (!Array.isArray(r.steps)) r.steps = [];
        if (typeof r.toolCalls !== "number") r.toolCalls = 0;
        if (typeof r.elapsedMs !== "number") r.elapsedMs = 0;
      }
      applyRunning(turns);
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

  // ===== タスク・リマインド・記憶（W4） =====
  /**
   * 出している状態の一覧と状態ごとの件数を 1 回で読む。open 以外を出しているときは、サイドバーの未完了のために open も読む。
   * opts.quiet は polling から
   */
  store.load.tasks = (opts) =>
    once("tasks", async () => {
      const status = store.taskStatus;
      const statuses = status === "open" ? ["open"] : [status, "open"];
      const results = await Promise.all(statuses.map((s) => SA.api.get("/api/tasks?status=" + s, opts)));
      const listOf = (data) => (Array.isArray(data && data.tasks) ? data.tasks : []);
      const counts = results[0] && results[0].counts && typeof results[0].counts === "object" ? results[0].counts : null;
      store.tasks = { status, tasks: listOf(results[0]), counts };
      store.openTasks = listOf(results[statuses.indexOf("open")]);
      SA.app.refresh("tasks");
      SA.app.refreshSidebar();
    });

  store.load.reminders = (opts) =>
    once("reminders", async () => {
      const data = await SA.api.get("/api/reminders", opts);
      store.reminders = Array.isArray(data && data.reminders) ? data.reminders : [];
      SA.app.refresh("reminders");
      SA.app.refreshSidebar();
    });

  store.load.memories = (opts) =>
    once("memories", async () => {
      const data = await SA.api.get("/api/memories", opts);
      store.memories = Array.isArray(data && data.memories) ? data.memories : [];
      SA.app.refresh("memories");
      SA.app.refreshSidebar();
    });

  // ===== 知らせ・GitHub・ナレッジ（W6） =====
  /** opts.quiet は polling から（失敗のトーストは polling が出す） */
  store.load.notices = (opts) =>
    once("notices", async () => {
      const data = await SA.api.get("/api/notices?last=" + NOTICES_LAST, opts);
      store.notices = {
        notices: Array.isArray(data && data.notices) ? data.notices : [],
        recent24h: data && typeof data.recent24h === "number" ? data.recent24h : 0,
      };
      SA.app.refreshNotices();
    });

  store.load.github = (opts) =>
    once("github", async () => {
      const data = await SA.api.get("/api/github?last=" + GITHUB_LAST, opts);
      store.github = {
        status: data && data.status && typeof data.status === "object" ? data.status : null,
        notifications: Array.isArray(data && data.notifications) ? data.notifications : [],
      };
      SA.app.refresh("github");
      SA.app.refreshSidebar();
    });

  /**
   * q は検索する語（前後の空白を除いたもの。空なら新しい順）。省略は今出している語。同じ語を読んでいる途中ならそれを待つ。
   * 語を続けて変えたときは最後に頼んだものだけを使う。opts.quiet は polling から
   */
  let knowledgeSeq = 0;
  let knowledgeLoading = null;
  store.load.knowledge = (q, opts) => {
    const query = typeof q === "string" ? q.trim() : store.knowledge ? store.knowledge.q : "";
    if (knowledgeLoading && knowledgeLoading.q === query) return knowledgeLoading.promise;
    const seq = ++knowledgeSeq;
    const promise = SA.api
      .get("/api/knowledge?last=" + KNOWLEDGE_LAST + (query === "" ? "" : "&q=" + encodeURIComponent(query)), opts)
      .then((data) => {
        if (seq !== knowledgeSeq) return null;
        store.knowledge = { q: query, entries: Array.isArray(data && data.entries) ? data.entries : [], more: !!(data && data.more) };
        SA.app.refresh("knowledge");
        SA.app.refreshSidebar();
        return null;
      })
      .catch((err) => err || new Error("failed"))
      .finally(() => {
        if (seq === knowledgeSeq) knowledgeLoading = null;
      });
    knowledgeLoading = { q: query, promise };
    return promise;
  };

  /**
   * 1 件（本文あり）。読んだもの（読めなかったものも）は持っておき、force のときだけ読み直す（読み直す間は前のものを出す）。
   * 一覧の updatedAt（forUpdatedAt）で読み直して失敗したら、その updatedAt では描き直しのたびに読み直さない（store.kbRetryFailed）
   */
  store.load.kbEntry = (id, force, forUpdatedAt) => {
    if (!force && store.kbEntries[id] !== undefined) return Promise.resolve(null);
    return once("kb:" + id, async () => {
      try {
        const data = await SA.api.get("/api/knowledge/" + encodeURIComponent(id), { quiet: true });
        store.kbEntries[id] = data && data.entry ? data.entry : "missing";
      } catch (err) {
        if (err && err.status === 404) store.kbEntries[id] = "missing";
        else {
          if (typeof store.kbEntries[id] !== "object") store.kbEntries[id] = "failed";
          if (forUpdatedAt !== undefined) store.kbRetryFailed[id] = forUpdatedAt;
          SA.ui.toast((err && err.toast) || "読み込めませんでした");
        }
      }
      SA.app.refresh("knowledge");
    });
  };

  // ===== プロジェクト（W7。読むだけ） =====
  store.load.projects = (opts) =>
    once("projects", async () => {
      const data = await SA.api.get("/api/projects", opts);
      store.projects = Array.isArray(data && data.projects) ? data.projects : [];
      SA.app.refreshSidebar();
      const tabId = SA.app.activeTabId();
      if (tabId && tabId.startsWith("project:")) SA.app.refresh(tabId);
    });

  function projectPath(slug, rest) {
    return "/api/projects/" + encodeURIComponent(slug) + rest;
  }

  /** ファイルの一覧。404（削除された・ディレクトリが無い）は missing にしてトーストを出さない */
  store.load.projectFiles = (slug) =>
    once("projectFiles:" + slug, async () => {
      try {
        const data = await SA.api.get(projectPath(slug, "/files"), { quiet: true });
        store.projectFiles[slug] = { files: Array.isArray(data && data.files) ? data.files : [], truncated: !!(data && data.truncated), missing: false };
      } catch (err) {
        if (err && err.status === 404) store.projectFiles[slug] = { files: [], truncated: false, missing: true };
        else {
          SA.ui.toast(err && typeof err.toast === "string" ? err.toast : "サーバーにつながりません");
          throw err;
        }
      }
      SA.app.refresh("project:" + slug);
    });

  /** ファイルの中身。失敗は error に応答の error（つながらなければ "network"）を入れて画面に出す。続けて選んだときは最後に選んだものだけを使う */
  const projectFileSeq = {};
  store.load.projectFile = (slug, path) => {
    const seq = (projectFileSeq[slug] = (projectFileSeq[slug] || 0) + 1);
    // 画面の描画の中から呼ぶので、ここでは描き直さない（呼んだ描画が「読み込んでいます…」を出す）
    store.projectFile[slug] = { path, text: null, error: null, maxBytes: null };
    return SA.api
      .get(projectPath(slug, "/file?path=" + encodeURIComponent(path)), { quiet: true })
      .then(
        (data) => ({ path, text: data && typeof data.text === "string" ? data.text : "", error: null, maxBytes: null }),
        (err) => ({
          path,
          text: null,
          error: (err && err.code) || "network",
          maxBytes: err && err.data && Number.isSafeInteger(err.data.maxBytes) && err.data.maxBytes > 0 ? err.data.maxBytes : null,
        }),
      )
      .then((result) => {
        if (seq !== projectFileSeq[slug]) return;
        store.projectFile[slug] = result;
        SA.app.refresh("project:" + slug);
      });
  };

  /** 操作の後: 読んでいる途中のもの（操作の前の中身かもしれない）が終わるのを待ってから、もう一度読む */
  store.reload = (key) => Promise.resolve(loading[key]).then(() => store.load[key]());

  /**
   * 一度読んだ一覧（タスク・リマインド・記憶・GitHub・プロジェクト・ナレッジ）だけを読み直す（polling）。ナレッジは今出している語で読み直す。
   * 失敗があれば最初の error で resolve する
   */
  store.load.lists = (opts) => {
    const keys = ["tasks", "reminders", "memories", "github", "projects"].filter((key) => store[key] !== null);
    const runs = keys.map((key) => store.load[key](opts));
    if (store.knowledge !== null) runs.push(store.load.knowledge(undefined, opts));
    return Promise.all(runs).then((errors) => errors.find((err) => err) || null);
  };

  SA.store = store;

  // ===== polling（見えているときだけ。隠れたら止め、戻ったら即 1 回） =====
  // /api/status は 10 秒、/api/channels・/api/notices と一度読んだタスク・リマインド・記憶・GitHub・プロジェクト・ナレッジは 60 秒、前に出ている会話のタブの /turns（after）は 5 秒ごと、
  // /api/running は実行中のターンがあれば 2 秒・無ければ 10 秒ごと（どれも応答が来てから次を予約する）。
  // 失敗のトーストは続けて失敗している間は最初の 1 回だけで、その間は間隔を倍にして POLL_BACKOFF_MAX_MS まで伸ばす。成功したら元に戻す
  const poll = { started: false, stopped: false };

  function activeTurns(opts) {
    const channelId = SA.chat.activeChannelId();
    return channelId ? store.load.turns(channelId, opts) : Promise.resolve(null);
  }

  /** run は opts（quiet）を受け、成功なら null・失敗ならその error で resolve する。base は成功しているときの間隔。fails は続けて失敗した回数 */
  const polls = {
    status: { base: () => STATUS_INTERVAL_MS, run: (opts) => store.load.status(opts), fails: 0, timer: null },
    channels: { base: () => CHANNELS_INTERVAL_MS, run: (opts) => store.load.channels(opts), fails: 0, timer: null },
    notices: { base: () => CHANNELS_INTERVAL_MS, run: (opts) => store.load.notices(opts), fails: 0, timer: null },
    lists: { base: () => CHANNELS_INTERVAL_MS, run: (opts) => store.load.lists(opts), fails: 0, timer: null },
    turns: { base: () => TURNS_INTERVAL_MS, run: activeTurns, fails: 0, timer: null },
    running: {
      base: () => (store.running && store.running.length > 0 ? RUNNING_BUSY_MS : RUNNING_IDLE_MS),
      run: (opts) => store.load.running(opts),
      fails: 0,
      timer: null,
    },
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
      p.timer = setTimeout(() => runPoll(p), backoff(p.base(), p.fails));
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
    /** 送った・中断した直後: 実行中のターンをすぐ読む */
    running: () => runPoll(polls.running),
    stop() {
      poll.stopped = true;
      clearTimers();
    },
  };
})();
