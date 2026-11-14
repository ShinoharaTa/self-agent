// 新しい殻（v3.html）の話題の一覧（列 1）: GET /api/topics を読んで持ち、「あなたの番」の節と群・行を key で差し替える
// （入れ物を作り直さない。スクロール位置・焦点・hover を保つ。docs/plan/web-ui-v3.md §3.4）
"use strict";

(function () {
  const SA = (window.SA = window.SA || {});
  const { el } = SA.ui;
  const store = SA.store;

  // ===== 状態 =====
  /** 最後に読めた TopicsResult（src/app/topics.ts） */
  let data = null;
  /** 最後の読み取りが失敗した（data は前のまま） */
  let failed = false;
  /** 完了を開いている群の key（M2b。今は null のまま） */
  let doneGroup = null;
  /** 絞り込みの語（M2b） */
  let filter = "";
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

  const TURN_LABEL = { permission: "許可", question: "質問", waiting: "判断待ち", confirm: "確認" };

  const $ = (id) => document.getElementById(id);

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
        const next = await SA.api.get("/api/topics" + (doneGroup ? "?done=" + encodeURIComponent(doneGroup) : ""), { quiet: true });
        if (next && Array.isArray(next.groups) && Array.isArray(next.topics)) {
          data = next;
          failed = false;
        } else failed = true;
      } catch {
        failed = true;
      }
      render();
      SA.app.refreshTabs();
      arm();
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

  // ===== 行 =====
  /** 表示に使う値（JSON にしたものが行の署名 data-sig）。印は あなたの番 > 作業中 > 未読 で 1 つだけ */
  function rowParts(t) {
    const channelId = t.id.startsWith("ch:") ? t.id.slice(3) : null;
    const unread = t.mark === null && channelId !== null && store.isUnread({ id: channelId, last: t.last });
    return {
      id: t.id,
      title: t.title,
      mark: t.mark === "turn" ? "turn" : t.mark === "running" ? "running" : unread ? "unread" : "none",
      turnKind: t.turn ? t.turn.kind : null,
      kind: t.origin === "cc" ? "端末" : null,
      persona: t.persona,
      // 履歴の無い行（activityAt が null）は時刻を出さない
      time: t.activityAt === null ? null : SA.ui.shortTime(t.activityAt),
      done: t.state === "done",
      current: SA.app.activeTabId() === t.id,
    };
  }

  /** 「あなたの番」の 2 行目（種類・待ち始めからの時間・要約） */
  function turnSub(turn) {
    return TURN_LABEL[turn.kind] + "・" + SA.views.ago(turn.since) + (turn.summary ? " " + turn.summary : "");
  }

  /** 「あなたの番」の行の値（話題か右腕。どちらでも引けなければ null） */
  function turnParts(id) {
    const t = find(id);
    if (t && t.turn) return Object.assign(rowParts(t), { sub: turnSub(t.turn) });
    const hand = data.rightHands.find((h) => h.id === id && h.turn);
    if (!hand) return null;
    return {
      id: hand.id,
      title: "右腕",
      mark: "turn",
      turnKind: hand.turn.kind,
      kind: null,
      persona: null,
      time: SA.ui.shortTime(hand.turn.since),
      done: false,
      current: SA.app.activeTabId() === hand.id,
      sub: turnSub(hand.turn),
    };
  }

  /** 行のボタンの中身（印の箱・題名・添え書き。「あなたの番」なら 2 行目） */
  function fillRow(button, p) {
    let mark = null;
    if (p.mark === "turn") mark = el("span", { class: "dot dot-warn", "aria-hidden": "true" });
    else if (p.mark === "running") mark = el("span", { class: "v3-ring", "aria-hidden": "true" });
    else if (p.mark === "unread") mark = el("span", { class: "dot dot-unread", role: "img", "aria-label": "未読" });
    const meta = [];
    if (p.kind) meta.push(el("span", { class: "v3-row-kind", text: "端末" }));
    if (p.persona) meta.push(el("span", { text: p.persona }));
    if (p.mark === "turn") meta.push(el("span", { class: "v3-row-state", text: TURN_LABEL[p.turnKind] }));
    else if (p.mark === "running") meta.push(el("span", { class: "v3-row-state", text: "作業中" }));
    if (p.time !== null) meta.push(el("span", { class: "v3-row-time", text: p.time }));
    const parts = [el("span", { class: "v3-row-mark" }, [mark]), el("span", { class: "v3-row-title", text: p.title }), el("span", { class: "v3-row-meta" }, meta)];
    if (p.sub !== undefined) parts.push(el("span", { class: "v3-row-sub", text: p.sub }));
    button.replaceChildren(...parts);
  }

  function createRow(turn) {
    return () => {
      const button = el("button", { class: turn ? "v3-row v3-row-turn" : "v3-row", type: "button" });
      button.addEventListener("click", () => SA.app.open(button.getAttribute("data-topic")));
      return el("li", {}, [button]);
    };
  }

  /** 署名が前と同じなら何もしない（焦点・hover・スクロールが動かない） */
  function updateRow(li, p) {
    const sig = JSON.stringify(p);
    if (li.getAttribute("data-sig") === sig) return;
    li.setAttribute("data-sig", sig);
    const button = li.firstElementChild;
    button.setAttribute("data-topic", p.id);
    button.setAttribute("title", p.title);
    fillRow(button, p);
    if (p.current) button.setAttribute("aria-current", "true");
    else button.removeAttribute("aria-current");
  }

  // ===== 差し替え =====
  /**
   * parent の子（data-key 付き）を items の順にそろえる。同じ key の子はその要素を使い回し（update だけ）、無ければ create する。
   * 消えた key の子を先に外し、期待する位置に無いときだけ動かす（順が同じなら insertBefore・remove を呼ばない）
   */
  function reconcile(parent, items, keyOf, create, update) {
    const byKey = new Map();
    for (const child of Array.from(parent.children)) byKey.set(child.getAttribute("data-key"), child);
    const keys = new Set(items.map(keyOf));
    for (const [key, child] of byKey) {
      if (!keys.has(key)) {
        child.remove();
        byKey.delete(key);
      }
    }
    items.forEach((item, i) => {
      const key = keyOf(item);
      let node = byKey.get(key);
      if (!node) {
        node = create(item);
        node.setAttribute("data-key", key);
        byKey.set(key, node);
      }
      update(node, item);
      if (parent.children[i] !== node) parent.insertBefore(node, parent.children[i] || null);
    });
  }

  // ===== 群 =====
  function groupNote(g) {
    if (g.turns > 0) return "あなたの番 " + g.turns;
    if (g.running > 0) return "作業中 " + g.running;
    return "";
  }

  function createGroup() {
    return el("section", { class: "v3-group" }, [el("h2", { class: "v3-group-head" })]);
  }

  function updateGroup(section, g) {
    section.setAttribute("data-turns", String(g.turns));
    const head = section.firstElementChild;
    const headSig = JSON.stringify([g.name, groupNote(g)]);
    if (head.getAttribute("data-sig") !== headSig) {
      head.setAttribute("data-sig", headSig);
      head.replaceChildren(el("span", { class: "v3-group-name", text: g.name }), el("span", { class: "v3-group-note", text: groupNote(g) }));
    }
    const members = data.topics.filter((t) => t.group === g.key && t.state !== "done");
    const current = head.nextElementSibling;
    if (members.length === 0) {
      if (current && current.classList.contains("v3-group-empty")) return;
      const empty = el("p", { class: "v3-group-empty meta", text: "話題はありません" });
      if (current) current.replaceWith(empty);
      else section.append(empty);
      return;
    }
    let list = current && current.classList.contains("v3-rows") ? current : null;
    if (!list) {
      list = el("ul", { class: "v3-rows", "data-list": g.key });
      if (current) current.replaceWith(list);
      else section.append(list);
    }
    reconcile(list, members.map(rowParts), (p) => p.id, createRow(false), updateRow);
  }

  // ===== 描く =====
  function setNote(text) {
    const note = $("v3-list-note");
    if (!note) return;
    if (text === null) {
      note.hidden = true;
      return;
    }
    note.hidden = false;
    if (note.textContent !== text) note.textContent = text;
  }

  function render() {
    const groups = $("v3-groups");
    if (!groups) return;
    if (data === null) {
      setNote(failed ? "読み込めませんでした" : "読み込み中…");
      return;
    }
    setNote(failed ? "更新できませんでした。前の一覧を出しています" : null);

    const turns = $("v3-turns");
    if (data.turns > 0) {
      turns.hidden = false;
      const n = String(data.turns);
      if ($("v3-turns-count").textContent !== n) $("v3-turns-count").textContent = n;
      const parts = data.turnIds.map(turnParts).filter((p) => p !== null);
      reconcile($("v3-turns-rows"), parts, (p) => "turn:" + p.id, createRow(true), updateRow);
    } else turns.hidden = true;

    reconcile(groups, data.groups, (g) => g.key, createGroup, updateGroup);
    document.title = (data.turns > 0 ? "(" + data.turns + ") " : "") + "self-agent";
  }

  SA.topics = { load, schedule, render, find, data: () => data, counts, TURN_LABEL };
})();
