// 会話（#inbox・#tasks・#<NAME>・セッション）のタブ（読むだけ）。SA.store.turns[channelId] の行を描き、見ている間は既読にする
"use strict";

(function () {
  const SA = (window.SA = window.SA || {});
  const { el, icon, elapsed, hm, linkify } = SA.ui;
  const store = SA.store;

  const STATE_LABEL = { active: "進行中", waiting: "待ち", done: "完了" };
  // 終わり方の文は src/app/progress.ts の progressEndText と同じ
  const OUTCOME_LABEL = { done: "完了", max_turns: "手順の上限で止まりました", aborted: "中断しました", failed: "止まりました" };
  const END_CLASS = { done: "is-done", max_turns: "is-warning", aborted: null, failed: "is-danger" };
  const END_ICON = { done: "check", max_turns: "triangle-alert", aborted: "square", failed: "triangle-alert" };
  const DISCORD_PREFIX = "https://discord.com/channels/";
  /** これより上に近づいたら前の行を読む（px） */
  const OLDER_THRESHOLD = 64;

  /** リンクにするのは https の Discord の URL だけ */
  function discordUrl(url) {
    return typeof url === "string" && url.startsWith(DISCORD_PREFIX) ? url : null;
  }

  /** プロジェクトの URL（サーバーが公開 URL から組み立てたもの）。http(s) でなければ使わない */
  function pageUrl(url) {
    return typeof url === "string" && /^https?:\/\//.test(url) ? url : null;
  }

  /** /turns の channel（新しい）→ 一覧の 1 件 */
  function channelById(channelId) {
    const t = store.turns[channelId];
    if (t && t.channel) return t.channel;
    return store.channels ? store.channels.channels.find((c) => c.id === channelId) || null : null;
  }

  function channelTitle(ch) {
    if (ch.kind === "session") return ch.title || "セッション";
    return "#" + (ch.name || ch.kind);
  }

  function persona(id) {
    const list = store.channels ? store.channels.personas : [];
    return list.find((p) => p.id === id) || { id, name: id, isDefault: id === "default" };
  }

  /** 今日ならその時刻、それ以外は 10/27 4:12 */
  function shortTime(iso) {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return "";
    const now = new Date();
    if (d.toDateString() === now.toDateString()) return hm(d);
    return d.getMonth() + 1 + "/" + d.getDate() + " " + hm(d);
  }

  /** 終わり方の文（「完了（m 分 s 秒・ツール n 回）」など）。時間・回数が無ければ終わり方だけ */
  function endText(turn) {
    const label = OUTCOME_LABEL[turn.outcome] || "終わりました";
    if (typeof turn.durationMs !== "number" || typeof turn.toolCalls !== "number") return label;
    return label + "（" + elapsed(turn.durationMs) + "・ツール " + turn.toolCalls + " 回）";
  }

  function activeChannelId() {
    const id = SA.app.activeTabId();
    return id && id.startsWith("ch:") ? id.slice(3) : null;
  }

  /** 前に出ていて、画面が見えているときだけ、読んだ最後の行まで既読にする */
  function markSeen(channelId) {
    if (activeChannelId() !== channelId || document.visibilityState !== "visible") return;
    const t = store.turns[channelId];
    if (!t || t.turns.length === 0) return;
    if (store.markSeen(channelId, t.turns[t.turns.length - 1].id)) {
      SA.app.refreshSidebar();
      SA.app.refreshStatus();
    }
  }

  function markSeenActive() {
    const channelId = activeChannelId();
    if (channelId) markSeen(channelId);
  }

  // ===== 描画 =====
  function avatar(letter, cls) {
    return el("span", { class: "avatar " + (cls || ""), "aria-hidden": "true", text: letter });
  }

  /** 時刻。Discord の発言があればそこへのリンク */
  function timeOf(turn) {
    const text = shortTime(turn.at);
    const href = turn.messageId ? discordUrl(turn.link) : null;
    if (!href) return el("span", { class: "tl-time", text });
    return el("a", { class: "tl-time", href, target: "_blank", rel: "noreferrer", title: "Discord で開く", text });
  }

  // 開いた手順（details）は描き直しても開いたままにする（このタブのメモリだけ。{ [channelId]: Set<turn.id> }。会話のタブを閉じたら消す）
  const openSteps = {};

  function openStepsOf(channelId) {
    if (!openSteps[channelId]) openSteps[channelId] = new Set();
    return openSteps[channelId];
  }

  function stepsList(steps) {
    const list = el("ol", { class: "steps-list" });
    for (const s of steps) list.append(el("li", { text: s }));
    if (steps.length === 0) list.append(el("li", { text: "手順の記録はありません" }));
    return list;
  }

  function renderTurn(turn, channelId) {
    if (turn.kind === "divider") {
      return el("div", { class: "tl-divider", role: "separator" }, [el("span", { text: turn.text })]);
    }
    if (turn.kind === "notice") {
      return el("div", { class: "tl-notice" }, [icon("info"), el("span", { text: turn.text }), timeOf(turn)]);
    }
    if (turn.kind === "owner") {
      return el("article", { class: "msg msg-owner" }, [
        avatar("オ", "avatar-owner"),
        el("div", { class: "msg-body" }, [
          el("div", { class: "msg-head" }, [el("span", { class: "msg-name", text: "オーナー" }), timeOf(turn)]),
          el("div", { class: "msg-text", text: turn.text }),
        ]),
      ]);
    }
    // agent
    const p = persona(turn.persona);
    const body = el("div", { class: "msg-body" }, [el("div", { class: "msg-head" }, [el("span", { class: "msg-name", text: p.name }), timeOf(turn)])]);
    if (turn.outcome) {
      const opened = openStepsOf(channelId);
      const details = el("details", { class: "steps", open: opened.has(turn.id) }, [
        el("summary", { class: END_CLASS[turn.outcome] || null }, [
          icon("chevron-right", "steps-chevron"),
          icon(END_ICON[turn.outcome] || "info"),
          el("span", { text: endText(turn) }),
        ]),
        stepsList(Array.isArray(turn.steps) ? turn.steps : []),
      ]);
      details.addEventListener("toggle", () => {
        if (details.open) opened.add(turn.id);
        else opened.delete(turn.id);
      });
      body.append(details);
    }
    // 返事の本文は http(s) の URL だけをリンクにする
    body.append(el("div", { class: "msg-text" }, linkify(typeof turn.text === "string" ? turn.text : "")));
    return el("article", { class: "msg msg-agent" }, [avatar(Array.from(p.name || "?")[0], "avatar-agent"), body]);
  }

  function header(ch, channelId) {
    if (!ch) {
      return el("header", { class: "ed-toolbar" }, [el("div", { class: "ed-title" }, [icon("hash"), el("h1", { text: "会話" })]), el("div", { class: "ed-actions" })]);
    }
    const isSession = ch.kind === "session";
    const p = persona(ch.persona);
    const titleRow = el("div", { class: "ed-title" }, [
      icon(isSession ? "message-square" : "hash"),
      el("h1", { text: isSession ? ch.title || "" : ch.name || ch.kind }),
      isSession && STATE_LABEL[ch.state] ? el("span", { class: "badge state-" + ch.state, text: STATE_LABEL[ch.state] }) : null,
      el("span", { class: "badge", text: p.name + (p.isDefault ? "" : "（人格）") }),
    ]);
    const actions = el("div", { class: "ed-actions" });
    if (ch.project) {
      actions.append(el("span", { class: "badge", title: "プロジェクト" }, [icon("folder"), ch.project.slug]));
      const url = pageUrl(ch.project.url);
      if (url) actions.append(el("a", { class: "btn btn-ghost btn-sm", href: url, target: "_blank", rel: "noreferrer" }, [icon("external-link"), "ページ"]));
    }
    const discord = discordUrl(ch.link);
    if (discord) actions.append(el("a", { class: "btn btn-ghost btn-sm", href: discord, target: "_blank", rel: "noreferrer" }, [icon("external-link"), "Discord"]));
    return el("header", { class: "ed-toolbar", "data-channel": channelId }, [titleRow, actions]);
  }

  /** 前に出ている会話のタブのスクロール */
  function scrollOf(channelId) {
    if (activeChannelId() !== channelId) return null;
    const ed = document.getElementById("ed");
    return ed ? ed.querySelector(".ed-scroll") : null;
  }

  /** 前の 50 件を読み、見ていた行の位置を保つ */
  const older = {};
  async function loadOlder(channelId) {
    const t = store.turns[channelId];
    if (!t || !t.hasMore || older[channelId]) return;
    older[channelId] = true;
    const before = scrollOf(channelId);
    const height = before ? before.scrollHeight : 0;
    const top = before ? before.scrollTop : 0;
    try {
      await store.load.olderTurns(channelId);
    } finally {
      older[channelId] = false;
    }
    SA.app.refresh("ch:" + channelId);
    const after = scrollOf(channelId);
    if (after && before) after.scrollTop = top + (after.scrollHeight - height);
  }

  function render(container, channelId) {
    const t = store.turns[channelId];
    const ch = channelById(channelId);
    if (!t || !t.loaded) {
      container.replaceChildren(header(ch, channelId), el("div", { class: "ed-scroll" }, [el("div", { class: "empty" }, [el("p", { text: "読み込んでいます…" })])]));
      return;
    }
    if (t.missing) {
      container.replaceChildren(
        header(null, channelId),
        el("div", { class: "ed-scroll" }, [el("div", { class: "empty" }, [icon("info"), el("p", { text: "このチャンネルは開けません（削除されたか、受け付けないチャンネルです）" })])]),
      );
      return;
    }
    const timeline = el("div", { class: "tl" });
    if (t.hasMore) {
      const more = el("button", { class: "btn btn-ghost btn-sm", type: "button", text: "前の会話を読む" });
      more.addEventListener("click", () => loadOlder(channelId));
      timeline.append(el("div", { class: "tl-hint" }, [more]));
    }
    for (const turn of t.turns) timeline.append(renderTurn(turn, channelId));
    if (t.turns.length === 0) timeline.append(el("p", { class: "tl-hint", text: "まだ記録はありません。Discord で発言すると、ここにも出ます。" }));
    if (ch && ch.kind === "session" && ch.state === "done") {
      timeline.append(el("p", { class: "tl-hint", text: "完了したセッションです。発言すると進行中に戻ります。" }));
    }
    const scroll = el("div", { class: "ed-scroll", "data-stick": "bottom" }, [timeline]);
    scroll.addEventListener("scroll", () => {
      if (scroll.scrollTop < OLDER_THRESHOLD) loadOlder(channelId);
    });
    container.replaceChildren(header(ch, channelId), scroll);
    markSeen(channelId);
  }

  /** タブの見出し。チャンネルがまだ分からなければ「会話」 */
  function info(channelId) {
    const ch = channelById(channelId);
    return {
      title: ch ? channelTitle(ch) : "会話",
      icon: ch && ch.kind === "session" ? "message-square" : "hash",
      render: (container) => render(container, channelId),
      onOpen: () => store.load.turns(channelId),
      onClose: () => {
        delete openSteps[channelId];
      },
    };
  }

  /** 一覧・/turns の channel が変わったとき: 開いている会話のタブの見出しが変わっていればタブを描き直す */
  function channelsChanged() {
    for (const tab of document.querySelectorAll('.tab[data-tab^="ch:"]')) {
      const text = tab.querySelector(".tab-text");
      if (text && text.textContent !== info(tab.getAttribute("data-tab").slice(3)).title) {
        SA.app.refreshTabs();
        return;
      }
    }
  }

  SA.chat = { info, channelTitle, shortTime, activeChannelId, markSeenActive, channelsChanged, STATE_LABEL };
})();
