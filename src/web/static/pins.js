// 新しい殻（index.html）の留めた話題の会話の列（#507。docs/plan/web-ui-pins.md §4.1・§4.2・§4.6）: 帯（#v3-deck）の中の #v3-pins に、留めた順の列（見出し + 会話）を足す・消す・描き直す。
// 見出しは入口 c-app.js の SA.pin.drawHead、会話は chat.js の render（右腕と同じ head: false の形）。見えている列（端まで見えて送りが止まっている）は c-deck.js の stripSeen で数える。
// いつ出すか・帯の幅・押した先（見出しの「…」・ピンのボタン・見えている列が替わった）は shell.js が sync の on で渡す（shell.js は呼ぶだけ）
"use strict";

(function () {
  const SA = (window.SA = window.SA || {});
  const $ = (id) => document.getElementById(id);

  /** chat.js に渡す枠の指定（毎回同じ物。見出しは SA.pin が描く） */
  const FRAME = { head: false };

  // ===== 状態 =====
  /** 列（channelId → { id, section, head, ed, stick, on }）。DOM の順は留めた順（#v3-pins の子の順） */
  const cols = new Map();
  /** 最後に数えた、端まで見えている留めた列の channelId（DOM の順） */
  let seenIds = [];
  /** shell.js から渡された押した先: { seen(), menu(channelId, opener), pin(channelId, opener) } */
  let hooks = null;

  // ===== 描く =====
  /** 下端から 48px 以内なら下端に居るとみなす（shell.js の atBottom と同じ） */
  function atBottom(scroll) {
    return scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight < 48;
  }

  /** 描く前の位置を覚え、下に付いていたら（か bottom なら）下へ、でなければ前の位置（shell.js の右腕の keepScroll と同じ形） */
  function keepScroll(ed, draw, bottom) {
    const old = ed.querySelector(".ed-scroll");
    const wasBottom = bottom || !old || atBottom(old);
    const oldTop = old ? old.scrollTop : 0;
    draw();
    const scroll = ed.querySelector(".ed-scroll");
    if (!scroll) return;
    if (scroll.dataset.stick === "bottom" && wasBottom) scroll.scrollTop = scroll.scrollHeight;
    else scroll.scrollTop = oldTop;
  }

  /** 列の題（chat.js の head の題、無ければ一覧の話題の題、どちらも無ければ「会話」） */
  function titleOf(id, head) {
    if (head && typeof head.title === "string" && head.title !== "") return head.title;
    const t = SA.topics.find("ch:" + id);
    return t && typeof t.title === "string" && t.title !== "" ? t.title : "会話";
  }

  /**
   * 列の見出しの state（入口 c-app.js の TopBar の props）。題・状態は chat.js の head から。注記・場所・許可のモード・［会話］［端末］・右腕・［閉じる］は出さない。
   * 幅 420（狭いときは 212〜299）は --c-top-full-min（520）より狭いので compact（場所・注記を渡さないので帯の中身は compact でない形と同じ）
   */
  function headState(c) {
    const head = SA.chat.head ? SA.chat.head(c.id) : null;
    return {
      view: "talk",
      title: titleOf(c.id, head),
      status: head ? head.status : null,
      note: null,
      place: null,
      views: null,
      hand: null,
      compact: true,
      menu: true,
      mode: null,
      close: false,
      pin: { on: true },
      on: c.on,
    };
  }

  /** 列の見出しと会話を描く。見出しを描けなければ題とピンのボタンだけの形で 1 回だけ描き直す */
  function draw(c) {
    const st = headState(c);
    c.section.setAttribute("aria-label", st.title);
    if (SA.pin && !SA.pin.drawHead(c.head, st)) SA.pin.drawHead(c.head, Object.assign({}, st, { status: null, menu: false }));
    keepScroll(c.ed, () => SA.chat.render(c.ed, c.id, FRAME), c.stick);
    c.stick = false;
  }

  /** 列を作る（DOM だけ。描くのは呼ぶ側） */
  function make(id) {
    const { el } = SA.ui;
    const head = el("div", { class: "v3-slot v3-pin-head" });
    const ed = el("div", { class: "ed" });
    const section = el("section", { class: "v3-pin", "data-pin": id, "aria-label": titleOf(id, null) }, [head, ed]);
    const c = { id, section, head, ed, stick: true, on: null };
    // 見出しの押した先（列ごとに 1 回だけ作り、毎回同じ物を渡す）
    c.on = {
      menu: (opener) => {
        if (hooks && hooks.menu) hooks.menu(id, opener);
      },
      pin: (opener) => {
        if (hooks && hooks.pin) hooks.pin(id, opener);
      },
    };
    return c;
  }

  /** 列を片付ける（右腕の clearHandEd と同じ順: 部品の根を外す → DOM を消す）。見出しの根も外す */
  function clear(c) {
    for (const [attr, part] of [
      ["data-talk", SA.talk],
      ["data-composer", SA.composer],
      ["data-cards", SA.cards],
    ]) {
      if (part && typeof part.drop === "function") for (const n of c.ed.querySelectorAll("[" + attr + "]")) part.drop(n);
    }
    if (SA.pin) SA.pin.clear(c.head);
    c.ed.replaceChildren();
    c.section.remove();
  }

  /** 見えている列を今在る列に絞る（消えた列を数えない）。変わったら true */
  function keepSeen() {
    const next = seenIds.filter((id) => cols.has(id));
    if (next.length === seenIds.length) return false;
    seenIds = next;
    return true;
  }

  /**
   * 留めた話題（SA.topics.pins()）に列を合わせる。opts は { show, fit, on }（show は帯が出る幅で留めた数が 1 以上、fit は SA.deck.stripFit の結果、on は shell.js の押した先）。
   * 要らない列を片付け、無い列を足し、DOM の順を留めた順にする。足した列は 1 回描き、会話を 1 回読む。show が false なら全部片付けて空にする
   */
  function sync(opts) {
    const o = opts || {};
    if (o.on) hooks = o.on;
    const box = $("v3-pins");
    const want = box && o.show === true ? SA.topics.pins() : [];
    for (const [id, c] of [...cols]) {
      if (want.includes(id)) continue;
      clear(c);
      cols.delete(id);
    }
    const added = [];
    for (const id of want) {
      if (cols.has(id)) continue;
      const c = make(id);
      cols.set(id, c);
      added.push(c);
    }
    want.forEach((id, i) => {
      const section = cols.get(id).section;
      if (box.children[i] !== section) box.insertBefore(section, box.children[i] || null);
    });
    for (const c of added) {
      draw(c);
      SA.store.load.turns(c.id);
    }
    // 消えた列は見えている物から外す（帯が出ている間は呼ぶ側が続けて measure で数え直す）
    if (keepSeen() && hooks && hooks.seen) hooks.seen();
  }

  function has(id) {
    return cols.has(id);
  }

  /** その列の見出しと会話を描き直す（見えていなくても）。無ければ false */
  function refresh(id) {
    const c = cols.get(id);
    if (!c) return false;
    draw(c);
    return true;
  }

  /** 今 DOM に在る列の channelId（留めた順） */
  function ids() {
    const box = $("v3-pins");
    return box ? [...box.children].map((n) => n.getAttribute("data-pin")).filter((id) => typeof id === "string" && cols.has(id)) : [];
  }

  // ===== 見えている列（docs/plan/web-ui-pins.md §4.6） =====
  /** 帯の送りの位置と見える幅（帯が無い・入口に stripSeen が無ければ null） */
  function viewOf() {
    const band = $("v3-deck");
    if (!band || !SA.deck || typeof SA.deck.stripSeen !== "function") return null;
    return { band, view: { left: band.scrollLeft, width: band.clientWidth } };
  }

  /** 列の帯の中の位置と幅（帯が offsetParent。shell.css の data-pins の間の .v3-deck は position: relative） */
  const boxOf = (id, node) => ({ id, x: node.offsetLeft, w: node.offsetWidth });

  /**
   * 見えている列を数え直す: 帯が在り・ページが見えていて、列の左右の端が帯の見える範囲の内（1px の遊び）。判定は c-deck.js の stripSeen だけ。
   * 結果が前と変わった時だけ、新しく見えた列を 1 回読んで描き直して既読を付け直し（SA.chat.markSeenShown）、shell.js の seen を呼ぶ。送りが止まった後に呼ぶ
   */
  function measure() {
    const v = cols.size > 0 && document.visibilityState === "visible" ? viewOf() : null;
    const next = v === null ? [] : SA.deck.stripSeen(v.view, ids().map((id) => boxOf(id, cols.get(id).section)));
    if (next.length === seenIds.length && next.every((id, i) => id === seenIds[i])) return;
    const fresh = next.filter((id) => !seenIds.includes(id));
    seenIds = next;
    for (const id of fresh) {
      SA.store.load.turns(id);
      draw(cols.get(id));
    }
    SA.chat.markSeenShown();
    if (hooks && hooks.seen) hooks.seen();
  }

  /** 最後に数えた、見えている留めた列の channelId */
  function seen() {
    return seenIds.slice();
  }

  /** 番の列（#c-deck-root の最初の列）が端まで見えているか（P5 の上の帯の「あなたの番 n」が使う）。帯が出ていなければ true（帯で送って隠せない）、列が無ければ false */
  function turnSeen() {
    if (cols.size === 0) return true;
    const root = $("c-deck-root");
    const col = root ? root.querySelector("[data-col]") : null;
    const v = viewOf();
    if (!col || v === null) return false;
    return SA.deck.stripSeen(v.view, [boxOf("turn", col)]).length === 1;
  }

  SA.pins = { sync, has, refresh, measure, seen, turnSeen, ids };
})();
