// 新しい殻（v3.html）の話題の一覧（列 1）: GET /api/topics を読んで持ち、「あなたの番」の節と群・行を key で差し替える
// （入れ物を作り直さない。スクロール位置・焦点・hover を保つ。docs/plan/web-ui-v3.md §3.4）
"use strict";

(function () {
  const SA = (window.SA = window.SA || {});
  const { el, icon } = SA.ui;
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
  /** 絞り込みのとき、描いた群で当たった話題の数（draw の中だけ） */
  let hitCount = 0;
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
  /** ?done= で出す完了の数（src/app/topics.ts の TOPICS_DONE_MAX） */
  const DONE_MAX = 50;
  /** 「ほかのプロジェクト」の開閉（値 "1" で開。既定は閉じる） */
  const OTHERS_KEY = "self-agent-web:v3-others";
  const CC_UNREADABLE_NOTE = "Claude Code の一覧を読めません。作業中の話題が欠けて見えることがあります";

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
          store.syncReads(next.reads, ids);
          dataDone = asked;
          failed = false;
        } else failed = true;
      } catch {
        failed = true;
      }
      try {
        render();
      } catch {
        // 描けなかったものは失敗として出す（次の予約は必ず掛ける）
        failed = true;
        setNote(failedNote());
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
      current: current === t.id,
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
      current: current === hand.id,
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
    if (p.done) button.classList.add("is-done");
    else button.classList.remove("is-done");
  }

  function createRow(turn) {
    return () => {
      const button = el("button", { class: turn ? "v3-row v3-row-turn" : "v3-row", type: "button" });
      button.addEventListener("click", () => openRow(button.getAttribute("data-topic"), button.classList.contains("is-done")));
      return el("li", {}, [button]);
    };
  }

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
    else setNote("この話題はここからは開けません");
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

  /**
   * 群の見出し（名前・補足・General とプロジェクトの群は [+]）。子は最初の 1 回だけ作り、以後は文字と [+] の名前だけを差し替える
   * （作り直すと [+] の焦点が外れる）
   */
  function fillHead(head, g) {
    if (head.children.length === 0) {
      const parts = [el("span", { class: "v3-group-name" }), el("span", { class: "v3-group-note" })];
      if (g.kind === "general" || g.kind === "project") {
        const add = el("button", { class: "btn btn-ghost btn-sm btn-icon-sm v3-add", type: "button", "data-place": g.key }, [icon("plus")]);
        add.addEventListener("click", () => SA.app.newSession(add.getAttribute("data-place"), add));
        parts.push(add);
      }
      head.replaceChildren(...parts);
    }
    const [name, note, add] = Array.from(head.children);
    if (name.textContent !== g.name) name.textContent = g.name;
    const text = groupNote(g);
    if (note.textContent !== text) note.textContent = text;
    if (add) {
      const label = g.name + " で話題を始める";
      add.setAttribute("aria-label", label);
      add.setAttribute("title", label);
    }
  }

  /** 群の中の部分（data-part が rows・empty・done の子）。無ければ null */
  function partOf(parent, name) {
    for (const child of Array.from(parent.children)) if (child.getAttribute("data-part") === name) return child;
    return null;
  }

  /** 絞り込みの語（小文字・空白で区切る）。空なら絞り込まない */
  function filterWords() {
    return filter.toLowerCase().split(/\s+/).filter((w) => w !== "");
  }

  /** 題名・群の名前・人格の名前に、語を全部含むか */
  function hits(t, g, words) {
    const text = [t.title, g.name, t.persona || ""].join(" ").toLowerCase();
    return words.every((w) => text.includes(w));
  }

  /** 行の差し替え（当たらない行は hidden。要素は消さない） */
  function updateHit(shown) {
    return (li, p) => {
      updateRow(li, p);
      const off = !shown.has(p.id);
      if (li.hidden !== off) li.hidden = off;
    };
  }

  /** folded は「ほかのプロジェクト」の中の群（見出しと完了だけ。「話題はありません」は出さない） */
  function updateGroup(section, g, folded) {
    section.setAttribute("data-turns", String(g.turns));
    const head = section.firstElementChild;
    const headSig = JSON.stringify([g.name, groupNote(g)]);
    if (head.getAttribute("data-sig") !== headSig) {
      head.setAttribute("data-sig", headSig);
      fillHead(head, g);
    }
    const words = filterWords();
    const shown = new Set();
    const members = data.topics.filter((t) => t.group === g.key && t.state !== "done");
    for (const t of members) if (hits(t, g, words)) shown.add(t.id);
    const rowsPart = partOf(section, "rows");
    const emptyPart = partOf(section, "empty");
    if (folded === true) {
      if (rowsPart) rowsPart.remove();
      if (emptyPart) emptyPart.remove();
    } else if (members.length === 0) {
      if (rowsPart) rowsPart.remove();
      if (!emptyPart) section.insertBefore(el("p", { class: "v3-group-empty meta", "data-part": "empty", text: "話題はありません" }), head.nextElementSibling);
    } else {
      if (emptyPart) emptyPart.remove();
      let list = rowsPart;
      if (!list) {
        list = el("ul", { class: "v3-rows", "data-list": g.key, "data-part": "rows" });
        section.insertBefore(list, head.nextElementSibling);
      }
      reconcile(list, members.map(rowParts), (p) => p.id, createRow(false), updateHit(shown));
    }
    let n = shown.size;
    let done = partOf(section, "done");
    if (g.done > 0) {
      if (!done) {
        done = createDone(g.key);
        section.append(done);
      }
      n += updateDone(done, g, words);
    } else if (done) done.remove();
    hitCount += n;
    const off = words.length > 0 && n === 0;
    if (section.hidden !== off) section.hidden = off;
  }

  // ===== 完了（?done=。開いておけるのは 1 つ） =====
  function createDone(key) {
    const more = el("p", { class: "meta", "data-part": "more", text: "新しい " + DONE_MAX + " 件を出しています" });
    more.hidden = true;
    const details = el("details", { class: "v3-done", "data-part": "done", "data-key": "done:" + key }, [
      el("summary", { class: "v3-done-head" }),
      el("ul", { class: "v3-rows", "data-list": "done:" + key }),
      more,
    ]);
    // 群が「ほかのプロジェクト」へ移って作り直したときも、開いていた完了は開いたまま
    if (doneGroup === key) details.open = true;
    details.addEventListener("toggle", () => doneToggled(details, key));
    return details;
  }

  function doneToggled(details, key) {
    if (details.open) {
      if (doneGroup === key) return;
      doneGroup = key;
      // サーバーの ?done= は 1 つの群だけなので、ほかの完了は閉じる
      const groups = $("v3-groups");
      if (groups) for (const other of groups.querySelectorAll("details.v3-done")) if (other !== details && other.open) other.open = false;
      render();
      load();
    } else if (doneGroup === key) {
      // 読み直さない（行を外すのは次の render）
      doneGroup = null;
    }
  }

  /** 完了の見出しと行（開いていて、その群の完了を読めているときだけ行を出す）。当たった行の数を返す */
  function updateDone(details, g, words) {
    const summary = details.children[0];
    const loading = doneGroup === g.key && dataDone !== g.key;
    const text = "完了（" + g.done + "）" + (loading ? "読み込み中…" : "");
    if (summary.textContent !== text) summary.textContent = text;
    const showing = details.open && doneGroup === g.key && dataDone === g.key;
    const members = showing ? data.topics.filter((t) => t.group === g.key && t.state === "done") : [];
    const shown = new Set();
    for (const t of members) if (hits(t, g, words)) shown.add(t.id);
    reconcile(details.children[1], members.map(rowParts), (p) => p.id, createRow(false), updateHit(shown));
    const more = partOf(details, "more");
    const many = showing && g.done > DONE_MAX;
    if (more.hidden === many) more.hidden = !many;
    return shown.size;
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

  /** 絞り込みで開いた形にしている（保存した開閉は変えない） */
  let othersForced = false;

  function createOthers() {
    const details = el("details", { class: "v3-others", id: "v3-others" }, [
      el("summary", { class: "v3-others-head" }),
      el("div", { class: "v3-others-groups", "data-part": "others" }),
    ]);
    othersForced = false;
    if (othersSaved()) details.open = true;
    details.addEventListener("toggle", () => {
      if (!othersForced) saveOthers(details.open);
    });
    return details;
  }

  function updateOthers(details, folded) {
    const filtering = filterWords().length > 0;
    if (filtering && !othersForced) {
      othersForced = true;
      details.open = true;
    } else if (!filtering && othersForced) {
      othersForced = false;
      details.open = othersSaved();
    }
    const summary = details.children[0];
    const text = "ほかのプロジェクト（" + folded.length + "）";
    if (summary.textContent !== text) summary.textContent = text;
    const before = hitCount;
    reconcile(partOf(details, "others"), folded, (g) => g.key, createGroup, (section, g) => updateGroup(section, g, true));
    const off = filtering && hitCount === before;
    if (details.hidden !== off) details.hidden = off;
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

  function failedNote() {
    return data === null ? "読み込めませんでした" : "更新できませんでした。前の一覧を出しています";
  }

  /** 描き直す。焦点のある行が並びの中で動いて焦点が外れたら戻し、一覧のスクロール位置も前と同じにする */
  function render() {
    const groups = $("v3-groups");
    if (!groups) return;
    const body = $("v3-list-body");
    const focused = document.activeElement;
    const top = body ? body.scrollTop : 0;
    draw(groups);
    if (body && body.scrollTop !== top) body.scrollTop = top;
    if (focused && document.activeElement !== focused && document.contains(focused)) focused.focus({ preventScroll: true });
  }

  function draw(groups) {
    if (data === null) {
      setNote(failed ? failedNote() : "読み込み中…");
      return;
    }

    const turns = $("v3-turns");
    const turnKey = (p) => "turn:" + p.id;
    if (data.turns > 0) {
      turns.hidden = false;
      const n = String(data.turns);
      if ($("v3-turns-count").textContent !== n) $("v3-turns-count").textContent = n;
      const parts = data.turnIds.map(turnParts).filter((p) => p !== null);
      reconcile($("v3-turns-rows"), parts, turnKey, createRow(true), updateRow);
    } else {
      // 番が 0 に戻ったら行も外す（隠れた節の行に焦点・検索が当たらない）
      reconcile($("v3-turns-rows"), [], turnKey, createRow(true), updateRow);
      turns.hidden = true;
    }

    // 話題の無いプロジェクトの群は「ほかのプロジェクト」（key others）に畳む。置く位置は畳んだ最初の群の所（サーバーの群の順のまま）
    const outer = [];
    const folded = [];
    for (const g of data.groups) {
      if (g.kind === "project" && g.open === 0) {
        if (folded.length === 0) outer.push({ key: "others" });
        folded.push(g);
      } else outer.push(g);
    }
    hitCount = 0;
    reconcile(
      groups,
      outer,
      (g) => g.key,
      (g) => (g.key === "others" ? createOthers() : createGroup()),
      (node, g) => (g.key === "others" ? updateOthers(node, folded) : updateGroup(node, g, false)),
    );

    // 注意は 1 つだけ: 更新の失敗 ＞ Claude Code の一覧が読めない ＞ 絞り込みで当たらない
    if (failed) setNote(failedNote());
    else if (data.cc && data.cc.enabled && data.cc.unreadable) setNote(CC_UNREADABLE_NOTE);
    else if (filterWords().length > 0 && hitCount === 0) setNote("当たる話題がありません");
    else setNote(null);
    document.title = (data.turns > 0 ? "(" + data.turns + ") " : "") + "self-agent";
  }

  /** 絞り込みの文字を変える（描き直しは呼んだ側の render） */
  function setFilter(value) {
    filter = String(value || "");
  }

  /** 一覧で選んでいる話題（aria-current）を変える（描き直しは呼んだ側の render） */
  function setCurrent(id) {
    current = id || null;
  }

  SA.topics = { load, schedule, render, find, data: () => data, counts, setFilter, setCurrent, TURN_LABEL };
})();
