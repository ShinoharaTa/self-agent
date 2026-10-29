// サーバーとのやりとり: fetch の包み（SA.api）・/api/* の結果を持つメモリの状態（SA.store）・/api/status の polling（SA.poll）
"use strict";

(function () {
  const SA = (window.SA = window.SA || {});

  const STATUS_INTERVAL_MS = 10000;

  /** 失敗は 401 なら /login へ、それ以外は「<status>: <error>」のトーストを出して reject する */
  async function request(method, path, body) {
    const init = { method, headers: { "X-Self-Agent": "1" }, credentials: "same-origin", cache: "no-store" };
    if (method === "POST") {
      init.headers["Content-Type"] = "application/json";
      init.body = JSON.stringify(body ?? {});
    }
    let res;
    try {
      res = await fetch(path, init);
    } catch (err) {
      SA.ui.toast("サーバーにつながりません");
      throw err;
    }
    if (res.status === 401) {
      location.href = "/login";
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
      SA.ui.toast(res.status + ": " + error);
      throw new Error(res.status + ": " + error);
    }
    return data;
  }

  SA.api = {
    get: (path) => request("GET", path),
    post: (path, body) => request("POST", path, body),
  };

  // ===== 状態（このタブのメモリだけ） =====
  // status: /api/status。usage: /api/usage の結果（date はサーバーが使った日付）。usageDays: /api/usage/days。
  // today: 日付を付けずに /api/usage を呼んだときにサーバーが返した日付（SELF_AGENT_TZ の今日）
  const store = { status: null, usage: null, usageDays: null, today: null, load: {} };
  const loading = {};

  /** 同じものを同時に 2 回読まない。失敗は呼び出し側に返さず、トーストだけ（request が出す） */
  function once(key, fn) {
    if (loading[key]) return loading[key];
    loading[key] = fn()
      .catch(() => undefined)
      .finally(() => {
        loading[key] = null;
      });
    return loading[key];
  }

  store.load.status = () =>
    once("status", async () => {
      const data = await SA.api.get("/api/status");
      store.status = data;
      SA.app.refreshStatus();
      SA.app.refresh("status");
      SA.app.refresh("settings");
      if (data && data.stopping === true) {
        SA.poll.stop();
        SA.ui.toast("再起動中です");
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
        SA.app.refresh("usage");
        SA.app.refreshSidebar();
        SA.app.refreshStatus();
      })
      .catch(() => undefined);
  };

  store.load.usageDays = () =>
    once("usageDays", async () => {
      const data = await SA.api.get("/api/usage/days?n=30");
      store.usageDays = Array.isArray(data) ? data : [];
      SA.app.refreshSidebar();
      SA.app.refresh("usage");
      SA.app.refreshStatus();
    });

  SA.store = store;

  // ===== polling（見えているときだけ。隠れたら止め、戻ったら即 1 回） =====
  const poll = { timer: null, started: false, stopped: false };

  function schedule() {
    clearInterval(poll.timer);
    poll.timer = null;
    if (poll.stopped || document.visibilityState !== "visible") return;
    store.load.status();
    poll.timer = setInterval(() => store.load.status(), STATUS_INTERVAL_MS);
  }

  SA.poll = {
    start() {
      if (poll.started) return;
      poll.started = true;
      document.addEventListener("visibilitychange", schedule);
      schedule();
    },
    stop() {
      poll.stopped = true;
      clearInterval(poll.timer);
      poll.timer = null;
    },
  };
})();
