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

  /** HH:MM:SS */
  function clock(date) {
    return date.toLocaleTimeString("ja-JP", { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false });
  }

  /** HH:MM */
  function hm(date) {
    return date.toLocaleTimeString("ja-JP", { hour: "2-digit", minute: "2-digit", hour12: false });
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

  // ===== トースト（action があれば自動で消さない） =====
  let toastTimer;
  function toast(text, action) {
    const box = document.getElementById("toast");
    if (!box) return;
    const close = el("button", { class: "btn btn-ghost btn-sm btn-icon-sm", type: "button", "aria-label": "閉じる" }, [icon("x")]);
    close.addEventListener("click", () => {
      box.hidden = true;
    });
    const children = [el("span", { text })];
    if (action) {
      const btn = el("button", { class: "btn btn-secondary btn-sm", type: "button", text: action.label });
      btn.addEventListener("click", () => {
        box.hidden = true;
        action.run();
      });
      children.push(btn);
    }
    children.push(close);
    box.replaceChildren(...children);
    box.hidden = false;
    clearTimeout(toastTimer);
    if (!action) {
      toastTimer = setTimeout(() => {
        box.hidden = true;
      }, 4000);
    }
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

  SA.ui = { el, icon, count, elapsed, clock, hm, linkify, toast, confirm, openDialog, closeDialog };
})();
