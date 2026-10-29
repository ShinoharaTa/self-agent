// 共通の部品: DOM の組み立て・アイコン・数と時刻の表示・トースト・確認ダイアログ
"use strict";

(function () {
  const SA = (window.SA = window.SA || {});

  // icons.svg（Lucide。templates/web/site のもの）にあるもの。それ以外は icons-app.svg（Web UI で足したもの）
  const BASE_ICONS = new Set([
    "plus", "x", "check", "trash-2", "pencil", "search", "settings", "chevron-left", "chevron-right", "chevron-down",
    "ellipsis", "calendar", "clock", "info", "triangle-alert", "rotate-ccw", "grip-vertical", "list", "square-check", "circle",
  ]);

  /** 要素を作る。props の text は textContent、on は { click: fn } のイベント、それ以外は属性 */
  function el(tag, props, children) {
    const node = document.createElement(tag);
    for (const [key, value] of Object.entries(props || {})) {
      if (value === undefined || value === null || value === false) continue;
      if (key === "text") node.textContent = value;
      else if (key === "on") {
        for (const [type, fn] of Object.entries(value)) node.addEventListener(type, fn);
      } else node.setAttribute(key, value === true ? "" : String(value));
    }
    for (const child of children || []) {
      if (child === undefined || child === null || child === false) continue;
      node.append(typeof child === "string" ? document.createTextNode(child) : child);
    }
    return node;
  }

  /** sprite のアイコン */
  function icon(name, extraClass) {
    const ns = "http://www.w3.org/2000/svg";
    const svg = document.createElementNS(ns, "svg");
    svg.setAttribute("class", "icon" + (extraClass ? " " + extraClass : ""));
    svg.setAttribute("aria-hidden", "true");
    const use = document.createElementNS(ns, "use");
    use.setAttribute("href", (BASE_ICONS.has(name) ? "/static/icons.svg#" : "/static/icons-app.svg#") + name);
    svg.append(use);
    return svg;
  }

  /** 桁区切り */
  function count(value) {
    return value === null || value === undefined ? "-" : value.toLocaleString("en-US");
  }

  /** 経過時間「m 分 s 秒」 */
  function elapsed(ms) {
    const sec = Math.max(0, Math.floor(ms / 1000));
    return Math.floor(sec / 60) + " 分 " + (sec % 60) + " 秒";
  }

  // ===== 時刻（SELF_AGENT_TZ。/api/status の timeZone。読む前・無効な値ならブラウザの既定） =====
  const WEEKDAYS = ["日", "月", "火", "水", "木", "金", "土"];
  const formatters = new Map();

  /** タイムゾーンごとに 1 つ作って使い回す。作れなければ（無効な名前）ブラウザの既定 */
  function formatter() {
    const status = SA.store && SA.store.status;
    const zone = status && typeof status.timeZone === "string" && status.timeZone !== "" ? status.timeZone : "";
    let f = formatters.get(zone);
    if (!f) {
      const opts = { year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric", second: "numeric", hourCycle: "h23" };
      try {
        f = new Intl.DateTimeFormat("en-US", zone ? { ...opts, timeZone: zone } : opts);
      } catch {
        f = new Intl.DateTimeFormat("en-US", opts);
      }
      formatters.set(zone, f);
    }
    return f;
  }

  /** Date か ISO の文字列 → 表示のタイムゾーンでの年月日・時分秒・曜日（0 が日曜）。時刻でなければ null */
  function zoned(value) {
    const d = value instanceof Date ? value : new Date(value);
    if (Number.isNaN(d.getTime())) return null;
    const p = {};
    for (const part of formatter().formatToParts(d)) p[part.type] = part.value;
    const year = Number(p.year);
    const month = Number(p.month);
    const day = Number(p.day);
    return {
      year,
      month,
      day,
      hour: Number(p.hour) % 24,
      minute: Number(p.minute),
      second: Number(p.second),
      weekday: new Date(Date.UTC(year, month - 1, day)).getUTCDay(),
      date: year + "-" + String(month).padStart(2, "0") + "-" + String(day).padStart(2, "0"),
    };
  }

  const pad2 = (n) => String(n).padStart(2, "0");

  /** HH:MM:SS */
  function clock(date) {
    const z = zoned(date);
    return z ? pad2(z.hour) + ":" + pad2(z.minute) + ":" + pad2(z.second) : "-";
  }

  /** HH:MM */
  function hm(date) {
    const z = zoned(date);
    return z ? pad2(z.hour) + ":" + pad2(z.minute) : "-";
  }

  /** 10/27(火) 4:12 */
  function dateTime(value) {
    const z = zoned(value);
    return z ? z.month + "/" + z.day + "(" + WEEKDAYS[z.weekday] + ") " + z.hour + ":" + pad2(z.minute) : "-";
  }

  /** 10/29(木) */
  function dateOf(value) {
    const z = zoned(value);
    return z ? z.month + "/" + z.day + "(" + WEEKDAYS[z.weekday] + ")" : "-";
  }

  /** 今日（表示のタイムゾーンの今の日付）ならその時刻、それ以外は 10/27 04:12 */
  function shortTime(value) {
    const z = zoned(value);
    if (!z) return "";
    const now = zoned(new Date());
    if (now && z.date === now.date) return pad2(z.hour) + ":" + pad2(z.minute);
    return z.month + "/" + z.day + " " + pad2(z.hour) + ":" + pad2(z.minute);
  }

  /** 本文の http(s) の URL だけをリンクにする（それ以外は文字のまま。innerHTML は使わない） */
  function linkify(text) {
    const parts = [];
    const re = /https?:\/\/[^\s<>]+/g;
    let last = 0;
    let match;
    while ((match = re.exec(text)) !== null) {
      if (match.index > last) parts.push(text.slice(last, match.index));
      parts.push(el("a", { href: match[0], target: "_blank", rel: "noreferrer noopener", text: match[0] }));
      last = match.index + match[0].length;
    }
    if (last < text.length) parts.push(text.slice(last));
    return parts;
  }

  // ===== トースト（多くて 2 つ。action があれば自動で消さない） =====
  // action（[取り消す] など）の付いたトーストが上に出ている間は、後から来たものをその下に 2 つ目として出す（2 つ目が既にあれば置き換える）。
  // それ以外は置き換える。action の付いたものは押すか閉じるまで残す
  const TOAST_MS = 4000;
  /** 出ているもの（上から）。{ node, action, timer } */
  let toasts = [];

  function removeToast(item) {
    clearTimeout(item.timer);
    item.node.remove();
    toasts = toasts.filter((t) => t !== item);
    const box = document.getElementById("toast");
    if (box && toasts.length === 0) box.hidden = true;
  }

  function toast(text, action) {
    const box = document.getElementById("toast");
    if (!box) return;
    const keep = toasts.length > 0 && toasts[0].action ? toasts[0] : null;
    for (const item of [...toasts]) if (item !== keep) removeToast(item);
    const item = { node: null, action: !!action, timer: null };
    const close = el("button", { class: "btn btn-ghost btn-sm btn-icon-sm", type: "button", "aria-label": "閉じる" }, [icon("x")]);
    close.addEventListener("click", () => removeToast(item));
    const children = [el("span", { text })];
    if (action) {
      const btn = el("button", { class: "btn btn-secondary btn-sm", type: "button", text: action.label });
      btn.addEventListener("click", () => {
        removeToast(item);
        action.run();
      });
      children.push(btn);
    }
    children.push(close);
    item.node = el("div", { class: "toast" }, children);
    toasts.push(item);
    box.append(item.node);
    box.hidden = false;
    if (!action) item.timer = setTimeout(() => removeToast(item), TOAST_MS);
  }

  // ===== ダイアログ（showModal が無い環境では open 属性で開く） =====
  function openDialog(dialog) {
    if (typeof dialog.showModal === "function") dialog.showModal();
    else dialog.setAttribute("open", "");
  }

  function closeDialog(dialog) {
    if (typeof dialog.close === "function") dialog.close();
    else dialog.removeAttribute("open");
  }

  /** 確認。ok なら run を呼ぶ */
  function confirm(opts) {
    const dialog = document.getElementById("dlg-confirm");
    document.getElementById("dlg-confirm-title").textContent = opts.title;
    document.getElementById("dlg-confirm-body").textContent = opts.body || "";
    const ok = document.getElementById("dlg-confirm-ok");
    ok.textContent = opts.ok || "OK";
    ok.className = "btn btn-sm " + (opts.danger ? "btn-danger" : "btn-primary");
    const cancel = document.getElementById("dlg-confirm-cancel");
    let finished = false;
    // Esc で閉じたときも close が来るので、後始末は 1 箇所で 1 回だけ
    const finish = (accepted) => {
      if (finished) return;
      finished = true;
      ok.removeEventListener("click", onOk);
      cancel.removeEventListener("click", onCancel);
      dialog.removeEventListener("close", onClose);
      closeDialog(dialog);
      if (accepted) opts.run();
    };
    const onOk = () => finish(true);
    const onCancel = () => finish(false);
    const onClose = () => finish(false);
    ok.addEventListener("click", onOk);
    cancel.addEventListener("click", onCancel);
    dialog.addEventListener("close", onClose);
    openDialog(dialog);
    ok.focus();
  }

  SA.ui = { el, icon, count, elapsed, clock, hm, dateTime, dateOf, shortTime, linkify, toast, confirm, openDialog, closeDialog };
})();
