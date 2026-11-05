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

  // ===== トースト（GUIDELINES §5。知らせは #toast、失敗は #toast-alert） =====
  // 知らせ（role="status"）は多くて 2 つ。新しいトーストは下に足す。action の無いトーストは次のトーストで消し、action（[取り消す] など）の
  // 付いたものは押すか閉じるまで残す。2 つを超えるときだけ、いちばん古いもの（action 付きでも）を消す。action の無いものは TOAST_MS で消え、
  // マウスが乗っている間（pointerType が mouse のときだけ。指のタップでは止めない）と focus の間は止めて、離れたら TOAST_MS から数え直す。
  // 失敗（opts.level === "error"）は #toast-alert（role="alert"）に入れて自動で消さない。opts.retry があれば [もう一度] を付ける。こちらも多くて 2 つ
  // スマホ（≤639px。トーストは上に出る）はそれぞれ 1 つまで（新しいもので置き換える）で、[取り消す] の付いたものも TOAST_MS で消す（見出しを覆い続けない。UI-8）
  const TOAST_MS = 4000;
  const phoneQuery = window.matchMedia ? window.matchMedia("(max-width: 639px)") : null;
  const phone = () => Boolean(phoneQuery && phoneQuery.matches);
  /**
   * 消える動き（長さは app.css の .is-leaving）の transitionend で DOM から外す。transition が無い（prefers-reduced-motion・
   * 非対応）と transitionend が来ないので、この時間で必ず外す保険（動きの長さより長く）
   */
  const TOAST_LEAVE_FALLBACK_MS = 400;
  /** 出ているもの（古い順）。{ node, box, action, auto, timer, hover, focus } */
  let toasts = [];

  function removeToast(item) {
    if (!toasts.includes(item)) return;
    clearTimeout(item.timer);
    toasts = toasts.filter((t) => t !== item);
    let done = false;
    const detach = () => {
      if (done) return;
      done = true;
      item.node.remove();
      if (item.box.childElementCount === 0) item.box.hidden = true;
    };
    // 中のボタンの transform の transitionend も上がってくるので、トーストそのもののものだけを使う
    item.node.addEventListener("transitionend", (event) => {
      if (event.target === item.node) detach();
    });
    setTimeout(detach, TOAST_LEAVE_FALLBACK_MS);
    item.node.classList.add("is-leaving");
  }

  /** 自動で消すものだけ、hover・focus が無ければ TOAST_MS 後に消す（あれば止めたまま） */
  function armToast(item) {
    clearTimeout(item.timer);
    item.timer = null;
    if (item.auto && !item.hover && !item.focus) item.timer = setTimeout(() => removeToast(item), TOAST_MS);
  }

  function toast(text, action, opts) {
    const error = !!(opts && opts.level === "error");
    const retry = error && opts && typeof opts.retry === "function" ? opts.retry : null;
    const box = document.getElementById(error ? "toast-alert" : "toast");
    if (!box) return;
    if (!error) for (const item of toasts.filter((t) => t.box === box)) if (!item.action) removeToast(item);
    const max = phone() ? 1 : 2;
    for (let mine = toasts.filter((t) => t.box === box); mine.length >= max; mine = toasts.filter((t) => t.box === box)) removeToast(mine[0]);
    const item = { node: null, box, action: !!action, auto: !error && (!action || phone()), timer: null, hover: false, focus: false };
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
    if (retry) {
      const btn = el("button", { class: "btn btn-secondary btn-sm", type: "button", text: "もう一度" });
      btn.addEventListener("click", () => {
        removeToast(item);
        retry();
      });
      children.push(btn);
    }
    children.push(close);
    item.node = el("div", { class: error ? "toast toast-alert" : "toast" }, children);
    item.node.addEventListener("pointerenter", (event) => {
      if (event.pointerType !== "mouse") return;
      item.hover = true;
      armToast(item);
    });
    item.node.addEventListener("pointerleave", (event) => {
      if (event.pointerType !== "mouse") return;
      item.hover = false;
      armToast(item);
    });
    item.node.addEventListener("focusin", () => {
      item.focus = true;
      armToast(item);
    });
    item.node.addEventListener("focusout", (event) => {
      if (event.relatedTarget && item.node.contains(event.relatedTarget)) return;
      item.focus = false;
      armToast(item);
    });
    toasts.push(item);
    box.append(item.node);
    box.hidden = false;
    armToast(item);
  }

  /** スマホ（≤639px）の見出しの左端の [‹]（一覧へ。押すと一覧を開く）。≥640px では CSS で出さない */
  function backButton() {
    const b = el("button", { class: "btn btn-ghost btn-sm btn-icon-sm ed-back", type: "button", "aria-label": "一覧へ", title: "一覧へ" }, [icon("chevron-left")]);
    b.addEventListener("click", () => SA.app.openDrawer());
    return b;
  }

  // ===== ダイアログ（showModal が無い環境では open 属性で開く） =====
  /** backdrop の click で閉じるのを登録したダイアログ（1 回だけ） */
  const backdropBound = new WeakSet();

  function openDialog(dialog) {
    // backdrop（ダイアログの箱の外）を押すと閉じる。箱の余白の click も target は dialog なので、位置で外かを見る（スマホのシートの約束。UI-8）。
    // 押し始め（pointerdown）も外だったときだけ（本文の文字を選んで外で離したときは閉じない）
    if (!backdropBound.has(dialog)) {
      backdropBound.add(dialog);
      const outside = (event) => {
        if (event.target !== dialog) return false;
        const r = dialog.getBoundingClientRect();
        return !(event.clientX >= r.left && event.clientX <= r.right && event.clientY >= r.top && event.clientY <= r.bottom);
      };
      let downOutside = false;
      dialog.addEventListener("pointerdown", (event) => {
        downOutside = outside(event);
      });
      dialog.addEventListener("click", (event) => {
        const close = downOutside && outside(event);
        downOutside = false;
        if (close) closeDialog(dialog);
      });
    }
    if (typeof dialog.showModal === "function") dialog.showModal();
    else dialog.setAttribute("open", "");
  }

  function closeDialog(dialog) {
    if (typeof dialog.close === "function") dialog.close();
    else dialog.removeAttribute("open");
  }

  /** 確認の対象の 1 行（改行・連続する空白を 1 つにし、80 字を超えたら「…」）。「」で囲む */
  const TARGET_MAX = 80;
  function targetLine(text) {
    const chars = [...String(text).replace(/\s+/g, " ").trim()];
    return "「" + (chars.length > TARGET_MAX ? chars.slice(0, TARGET_MAX).join("") + "…" : chars.join("")) + "」";
  }

  /**
   * 確認。ok なら run を呼ぶ。title は動詞だけ（「閉じますか」）、target（任意）は対象の題名で本文の前の 1 行に出す
   * （長い題名で見出しを何行にもしない。UI-8）
   */
  function confirm(opts) {
    const dialog = document.getElementById("dlg-confirm");
    document.getElementById("dlg-confirm-title").textContent = opts.title;
    const target = document.getElementById("dlg-confirm-target");
    if (target) {
      const has = typeof opts.target === "string" && opts.target.trim() !== "";
      target.textContent = has ? targetLine(opts.target) : "";
      target.hidden = !has;
    }
    document.getElementById("dlg-confirm-body").textContent = opts.body || "";
    const ok = document.getElementById("dlg-confirm-ok");
    ok.textContent = opts.ok || "実行する";
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
    // 危険な操作は最初のフォーカスを [やめる] に（Enter で実行しない。GUIDELINES §5）
    if (opts.danger) cancel.focus();
    else ok.focus();
  }

  SA.ui = { el, icon, count, elapsed, clock, hm, dateTime, dateOf, shortTime, linkify, toast, confirm, openDialog, closeDialog, backButton };
})();
