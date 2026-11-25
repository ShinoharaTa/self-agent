// 新しい殻（index.html）の部品の入口（docs/plan/web-ui-components.md §9 の K3）。状態は topics.js が持ち、SA.list.draw(state) で押し込む。
// 部品の c-*.js のうち document・window・SA に触るのはここだけ（見本の c-gallery.js は別）。文は部品とモデルが持ち、ここには書かない
// 下のバーは shell.js が SA.list.drawBar(bar) で押し込む。会話の見出し（K4）は SA.top.draw(state) で、compact にするかは shell.js が SA.top.compact() で測らせて決める
// 会話の行（K4）は chat.js が根と state を SA.talk.draw(root, state)・1 秒ごとは SA.talk.tick(root, state) で押し込む（覚えと刻みは c-talk.js の talkMouth）
// 会話の入力欄（K5）は chat.js が根と state を SA.composer.draw(root, state) で押し込み、送った後の空は SA.composer.set(root, "")（欄の要素と本文の覚えは c-composer.js の composerMouth）
// 「あなたの番」のカード（K5）は chat.js が根と state を SA.cards.draw(root, state) で押し込み、「その他」の欄への焦点は SA.cards.focus(root, id, index)（「その他」の本文の覚えは c-cards.js の cardsMouth）
// 知らせと確認（K6）は ui.js が SA.notice.draw(state)・SA.ask.draw(state) で押し込む（状態とタイマーは ui.js が持ち、ここは描くだけ）
// 右腕の見出し（K6）は shell.js が SA.hand.draw(state) で押し込み、[畳む]・「…」への焦点は SA.hand.focus(what)（右腕の中の会話・入力欄・カードは上の口を使い回す）
// 端末のセッションの札（H3）は SA.term.draw(root, raw) で描き（raw は c-term.js の termView に渡す生の状態と on）、SA.term.drop(root) で外す
// 流れの列と上の帯（D1）は flows.js が SA.deck.draw(state)・shell.js が SA.deck.drawBand(state) で押し込む。幅の計算（SA.deck.fit）は c-deck.js の deckFit
// スマホの流れの列の下のバー（D2）は #c-foot-root が在るときだけ SA.deck.drawBar(bar)・SA.deck.page(id)・SA.deck.focusBar(act)（指で送った列は bar.on.paged(id) で知らせる）
// スマホの上の帯の題（今いる列の名前と数）は drawBand の state.page の列を最後に描けた列のモデルから引き、列を描き直して題が変われば帯も描き直す
// 広い幅の右腕の丸（D6）は #c-orb-root が在るときだけ shell.js が SA.deck.drawOrb(state) で押し込み、焦点は SA.deck.focusOrb()
// 留めた会話の列（#507）の見出しは SA.pin.drawHead(root, state)・SA.pin.clear(root)、帯の幅と端まで見えている列は SA.deck.stripFit・SA.deck.stripSeen（配線は P4）
import { html, render } from "./c-lib.js";
import { TopicList, listKey, listModel } from "./c-list.js";
import { BottomBar, HandOrb, TopBar } from "./c-shell.js";
import { talkMouth } from "./c-talk.js";
import { composerMouth } from "./c-composer.js";
import { cardsMouth } from "./c-cards.js";
import { termMouth } from "./c-term.js";
import { HandHead } from "./c-hand.js";
import { Confirm, Toast } from "./c-sheet.js";
import { Deck, DeckBand, deckFit, deckModel, focusAfter, pressableKeys, stripFit, stripSeen } from "./c-deck.js";

const listRoot = document.getElementById("c-list-root");

if (listRoot) {
  // PC の式はトークンの上書き（tokens.css）・見本の compact と同じ
  const env = { fine: window.matchMedia("(min-width: 640px) and (hover: hover) and (pointer: fine)") };
  // スマホの形のバーにする幅（shell.js の mqPhone と同じ式）
  env.phone = window.matchMedia("(max-width: 639px)");
  /** 最後に描いた state（幅・指の変化で描き直す） */
  let lastState = null;
  /** 下のバーの入れ物。無ければ null */
  const barRoot = document.getElementById("c-bottom-root");
  /** 最後に渡された bar（幅が変わったら描き直す） */
  let lastBar = null;
  /** 会話の見出しの入れ物。無ければ null */
  const topRoot = document.getElementById("c-top-root");
  /** 最後に渡された見出しの state（幅が変わったら描き直す） */
  let lastTop = null;
  /** compact にする列の幅（トークン --c-top-full-min が読めないときの値。tokens.css と同じ数） */
  const TOP_FULL_MIN = 520;

  /** 一覧の根（.c-list。tabindex="-1"）。まだ描いていなければ null */
  const rootEl = () => listRoot.firstElementChild;
  const rows = () => Array.from(listRoot.querySelectorAll("button[data-topic]"));

  /** 同じ話題の行のうち、群の中の行（data-mark の付いた物）を先に。セレクタに id を埋めない */
  function rowFor(id) {
    const same = rows().filter((b) => b.dataset.topic === id);
    return same.find((b) => b.hasAttribute("data-mark")) || same[0] || null;
  }

  function draw(state) {
    lastState = state;
    const before = document.activeElement;
    const inside = !!before && listRoot.contains(before);
    const topic = inside && before.matches("button[data-topic]") ? before.dataset.topic : null;
    const root = rootEl();
    const top = root ? root.scrollTop : 0;
    try {
      const model = listModel(state);
      render(html`<${TopicList} model=${model} compact=${env.fine.matches} on=${state.on} />`, listRoot);
    } catch (error) {
      // 名前だけ（message・stack は本文を含むことがあるので出さない）
      console.error("[web] list draw failed", error instanceof Error ? error.name : "");
      return false;
    }
    const after = rootEl();
    if (after && after.scrollTop !== top) after.scrollTop = top;
    if (!inside) return true;
    if (document.contains(before)) {
      if (document.activeElement !== before) before.focus({ preventScroll: true });
    } else {
      // 行が消えた（[もう一度読む]・PC の件数のボタンも）: 同じ話題の行へ、無ければ一覧の根へ（body に落とさない）
      const row = topic === null ? null : rowFor(topic);
      if (row) row.focus({ preventScroll: true });
      else if (after) after.focus({ preventScroll: true });
    }
    return true;
  }

  function focusRow(id) {
    const row = rowFor(id);
    if (!row) return false;
    row.focus({ preventScroll: true });
    return true;
  }

  function focusList() {
    const root = rootEl();
    if (root) root.focus();
  }

  function scrollTop() {
    const root = rootEl();
    return root ? root.scrollTop : 0;
  }

  function setScrollTop(n) {
    const root = rootEl();
    if (root) root.scrollTop = n;
  }

  /** 下のバーを描く。bar は { turns, hand, tabs, controls, on } か null（流れの列の間は描かない）。形（スマホか広い幅か）はここで決める。フォーカスと一覧の位置には触らない */
  function drawBar(bar) {
    lastBar = bar;
    // 描く所が無いのは失敗ではない
    if (!barRoot) return true;
    try {
      if (bar === null) {
        render(null, barRoot);
        return true;
      }
      render(
        html`<${BottomBar} variant=${env.phone.matches ? "phone" : "wide"} turns=${bar.turns} hand=${bar.hand} tabs=${bar.tabs} controls=${bar.controls} on=${bar.on} />`,
        barRoot,
      );
    } catch (error) {
      // draw と同じく名前だけ
      console.error("[web] bar draw failed", error instanceof Error ? error.name : "");
      return false;
    }
    return true;
  }

  /** スマホのバーの右腕のボタンにフォーカス。無ければ false（広い幅では必ず false） */
  function focusHand() {
    const b = barRoot ? barRoot.querySelector('button[data-act="hand"]') : null;
    if (!b) return false;
    b.focus();
    return true;
  }

  /** --c-top-full-min の px（呼ばれるたびに読む。読めなければ TOP_FULL_MIN） */
  function topFullMin() {
    try {
      const v = parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--c-top-full-min"));
      return Number.isFinite(v) && v > 0 ? v : TOP_FULL_MIN;
    } catch {
      return TOP_FULL_MIN;
    }
  }

  /**
   * 今の列の幅なら見出しを compact にするか（測るだけ。覚えない・描かない）。スマホは false、測れなければ null。
   * 根（.v3-slot）は display: contents で箱が無いので、根の親（列）の幅を測る
   */
  function topCompact() {
    if (env.phone.matches) return false;
    const box = topRoot ? topRoot.parentElement : null;
    if (!box) return null;
    const w = box.clientWidth;
    if (!Number.isFinite(w) || w <= 0) return null;
    return w < topFullMin();
  }

  /** その要素が button ならそれ、違えば中の最初の button（無ければ null） */
  function buttonIn(node) {
    if (!node) return null;
    return node.matches("button") ? node : node.querySelector("button");
  }

  /** 見出しの vnode（drawTop と、留めた列の見出しの SA.pin.drawHead で同じ形。pin と level（題の段。留めた列は 2）は #507） */
  function topBar(state, variant, level) {
    return html`<${TopBar}
      variant=${variant}
      view=${state.view}
      title=${state.title}
      status=${state.status}
      note=${state.note}
      place=${state.place}
      views=${state.views}
      hand=${state.hand}
      menu=${state.menu}
      compact=${state.compact === true}
      mode=${state.mode}
      close=${state.close === true}
      pin=${state.pin}
      backLabel=${state.backLabel}
      controls=${state.controls}
      level=${level}
      on=${state.on}
    />`;
  }

  /** 見出しを描く。state は { view, title, status, note, place, views, hand, compact, menu, mode, close, pin, backLabel, controls, on }。形（スマホか広い幅か）はここで、compact は state のまま */
  function drawTop(state) {
    lastTop = state;
    if (!topRoot) return true;
    const before = document.activeElement;
    const inside = !!before && topRoot.contains(before);
    try {
      render(topBar(state, env.phone.matches ? "phone" : "wide"), topRoot);
    } catch (error) {
      // draw と同じく名前だけ
      console.error("[web] top draw failed", error instanceof Error ? error.name : "");
      return false;
    }
    // 焦点のあったボタンが消えた（compact に替わった・スマホの境をまたいだ）: 「…」→「一覧へ」→ 最初のボタン（body に落とさない）
    if (inside && !document.contains(before)) {
      const next = buttonIn(topRoot.querySelector('[data-act="menu"]')) || buttonIn(topRoot.querySelector('[data-act="back"]')) || topRoot.querySelector("button");
      if (next) next.focus({ preventScroll: true });
    }
    return true;
  }

  /**
   * 留めた会話の列（#507）の見出しを root に描く。state は drawTop と同じ形。形は広い幅、題は h2 に決め、lastTop・#c-top-root には触らない（焦点は持ち直さない）。
   * root が無い・描けなければ false
   */
  function drawPinHead(root, state) {
    if (!root) return false;
    try {
      render(topBar(state, "wide", 2), root);
    } catch (error) {
      // drawTop と同じく名前だけ
      console.error("[web] pin head draw failed", error instanceof Error ? error.name : "");
      return false;
    }
    return true;
  }

  /** 留めた会話の列の見出しを外す */
  function clearPinHead(root) {
    if (root) render(null, root);
  }

  /** 見出しのボタン（back・place・mode・menu・hand・pin・close）にフォーカス。無い・押せなければ false */
  function focusTop(act) {
    if (!topRoot || !["back", "place", "mode", "menu", "hand", "pin", "close"].includes(act)) return false;
    const b = buttonIn(topRoot.querySelector('[data-act="' + act + '"]'));
    if (!b || b.disabled) return false;
    b.focus({ preventScroll: true });
    return true;
  }

  /** 会話の口（行の vnode と解析の覚えを持つ） */
  const talk = talkMouth(render);

  /** 会話の行を全部描く。描けなければ false（chat.js が古い描き方に戻す） */
  function drawTalk(root, state) {
    try {
      talk.draw(root, state);
    } catch (error) {
      // draw と同じく名前だけ
      console.error("[web] talk draw failed", error instanceof Error ? error.name : "");
      return false;
    }
    return true;
  }

  /** 1 秒ごとの描き（覚えた行はそのまま、実行中の行だけ）。描けなければ false */
  function tickTalk(root, state) {
    try {
      talk.tick(root, state);
    } catch (error) {
      console.error("[web] talk draw failed", error instanceof Error ? error.name : "");
      return false;
    }
    return true;
  }

  /** 根を空にして覚えを消す */
  function dropTalk(root) {
    try {
      talk.drop(root);
    } catch {
      // 外すだけなので握る
    }
  }

  /** 入力欄の口（根ごとに欄の要素と本文を覚える） */
  const composer = composerMouth(render);

  /** 入力欄を描く。描けなければ false（chat.js が古い入力欄に戻す） */
  function drawComposer(root, state) {
    try {
      composer.draw(root, state);
    } catch (error) {
      // draw と同じく名前だけ
      console.error("[web] composer draw failed", error instanceof Error ? error.name : "");
      return false;
    }
    return true;
  }

  /** 欄の値を書き換える（送った後の空）。欄がまだ無い・書けなければ false */
  function setComposer(root, text) {
    try {
      return composer.set(root, text);
    } catch (error) {
      console.error("[web] composer set failed", error instanceof Error ? error.name : "");
      return false;
    }
  }

  /** 欄にフォーカス。欄が無い・できなければ false */
  function focusComposer(root) {
    try {
      return composer.focus(root);
    } catch (error) {
      console.error("[web] composer focus failed", error instanceof Error ? error.name : "");
      return false;
    }
  }

  /** 根を空にして覚えを消す */
  function dropComposer(root) {
    try {
      composer.drop(root);
    } catch {
      // 外すだけなので握る
    }
  }

  /** カードの口（根ごとに「その他」の欄の要素と本文を覚える） */
  const cards = cardsMouth(render);

  /** カードを描く。描けなければ false（chat.js が古いカードに戻す） */
  function drawCards(root, state) {
    try {
      cards.draw(root, state);
    } catch (error) {
      // draw と同じく名前だけ
      console.error("[web] cards draw failed", error instanceof Error ? error.name : "");
      return false;
    }
    return true;
  }

  /** 「その他」の欄にフォーカス。欄が無い・隠れている・できなければ false */
  function focusCards(root, id, index) {
    try {
      return cards.focus(root, id, index);
    } catch (error) {
      console.error("[web] cards focus failed", error instanceof Error ? error.name : "");
      return false;
    }
  }

  /** 根を空にして覚えを消す */
  function dropCards(root) {
    try {
      cards.drop(root);
    } catch {
      // 外すだけなので握る
    }
  }

  /** 札の口 */
  const term = termMouth(render);

  /** 端末のセッションの札を描く。描けなければ false（shell.js が今の［端末］のタブに戻す） */
  function drawTerm(root, raw) {
    const before = document.activeElement;
    const inside = !!before && root.contains(before);
    try {
      term.draw(root, raw);
    } catch (error) {
      // draw と同じく名前だけ
      console.error("[web] term draw failed", error instanceof Error ? error.name : "");
      return false;
    }
    // 焦点のあったボタンが消えた（［確かめ直す］など）: 押せる最初のボタン → RC のリンク → 最初のボタン（body に落とさない）
    if (inside && !document.contains(before)) {
      const next = root.querySelector('button:not([aria-disabled="true"])') || root.querySelector("a.c-term-link") || root.querySelector("button");
      if (next) next.focus({ preventScroll: true });
    }
    return true;
  }

  /** 根を空にする */
  function dropTerm(root) {
    try {
      term.drop(root);
    } catch {
      // 外すだけなので握る
    }
  }

  // ↑↓・Home・End で行を動かす（修飾キー付きは素通し。完了の見出し・[+]・件数のボタンでは動かさない）
  listRoot.addEventListener("keydown", (event) => {
    if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
    const row = event.target instanceof Element ? event.target.closest("button[data-topic]") : null;
    if (!row || !listRoot.contains(row)) return;
    const all = rows();
    const to = listKey(event.key, all.length, all.indexOf(row));
    if (to === undefined) return;
    event.preventDefault();
    if (to !== null) all[to].focus();
  });

  env.fine.addEventListener("change", () => {
    if (lastState) draw(lastState);
  });

  env.phone.addEventListener("change", () => {
    if (lastBar) drawBar(lastBar);
    if (lastTop) drawTop(lastTop);
  });

  window.SA = window.SA || {};
  window.SA.list = { draw, focusRow, focusList, scrollTop, setScrollTop, drawBar, focusHand };
  if (topRoot) window.SA.top = { draw: drawTop, focus: focusTop, compact: topCompact };
  window.SA.talk = { draw: drawTalk, tick: tickTalk, drop: dropTalk };
  window.SA.composer = { draw: drawComposer, set: setComposer, focus: focusComposer, drop: dropComposer };
  window.SA.cards = { draw: drawCards, focus: focusCards, drop: dropCards };
  window.SA.term = { draw: drawTerm, drop: dropTerm };
  window.SA.pin = { drawHead: drawPinHead, clear: clearPinHead };
}

/** 流れの列と上の帯の入れ物。両方が無ければ口を置かない（shell.js は今の広い幅の形のまま） */
const deckRoot = document.getElementById("c-deck-root");
const bandRoot = document.getElementById("c-band-root");
/** スマホの流れの列の下のバーの入れ物（D2）。無ければ null（下のバーの口を置かない。shell.js はスマホを今の殻のままにする） */
const footRoot = document.getElementById("c-foot-root");
/** 広い幅の右腕の丸の入れ物（D6）。無ければ null（丸の口は在るが描けない = false。shell.js は帯の［右腕］を出す） */
const orbRoot = document.getElementById("c-orb-root");

if (deckRoot && bandRoot) {
  /** 最後に描けた列のモデル（下のバーの列の名前と番の数に使う） */
  let lastModel = null;
  /** 最後に渡された下のバー（null は描いていない） */
  let lastBar = null;
  /** 最後に描けた上の帯の state（null は描いていない） */
  let lastBand = null;
  /** 横送りで今いる列の id（指で送ったときだけ知らせる。SA.deck.page は先にここを書く） */
  let pagedAt = null;

  /** その要素が button ならそれ、違えば中の最初の button（無ければ null） */
  const buttonOf = (node) => (!node ? null : node.matches("button") ? node : node.querySelector("button"));

  /** key の項目の押せるボタン（席に開けない項目は div なので null）。セレクタに key を埋めない */
  const itemButton = (key) => {
    const item = Array.from(deckRoot.querySelectorAll("[data-key]")).find((n) => n.dataset.key === key);
    const main = item ? item.querySelector(".c-item-main") : null;
    return main && main.matches("button") ? main : null;
  };

  /** 帯のボタン（status・find・hand・start・more と「あなたの番 n」の turn。#507）にフォーカス。無ければ false */
  const focusBand = (act) => {
    if (!["status", "find", "hand", "start", "more", "turn"].includes(act)) return false;
    const b = buttonOf(bandRoot.querySelector('[data-act="' + act + '"]'));
    if (!b) return false;
    b.focus({ preventScroll: true });
    return true;
  };

  const focusItem = (key) => {
    const b = itemButton(key);
    if (!b) return false;
    b.focus();
    return true;
  };

  /** 列（data-col）の項目のうち、押せる物（ボタン・リンク）を持つ項目の key の並び（押せない項目は数えない）。kind が文字列ならその種類（data-kind）の項目だけ */
  const colKeys = (col, kind) => {
    const box = col === null ? null : Array.from(deckRoot.querySelectorAll("[data-col]")).find((n) => n.dataset.col === col);
    if (!box) return [];
    return pressableKeys(
      Array.from(box.querySelectorAll("[data-key]")).map((n) => ({ key: n.dataset.key, kind: n.dataset.kind, pressable: n.querySelector("button, a[href]") !== null })),
      kind,
    );
  };

  /**
   * key の項目の中の最初の押せる物（［完了］・リンク・開くボタン）にフォーカス。リマインドは操作の行の最後のボタン（［止める］。確認つきなので続けて Enter を押しても確認で止まる）。
   * 無ければ false
   */
  const focusFirstIn = (key) => {
    const item = Array.from(deckRoot.querySelectorAll("[data-key]")).find((n) => n.dataset.key === key);
    const target = !item ? null : item.dataset.kind === "reminder" ? item.querySelector(".c-item-ops button:last-child") : item.querySelector("button, a[href]");
    if (!target) return false;
    target.focus();
    return true;
  };

  /**
   * 3 つの列を描く。state は flows.js の flowState()。描けなければ false。列は同じ要素を使い回すので、列ごとの縦の位置は残る。
   * 焦点のあった物が消えたら、同じ key の項目が残っていればその項目（開くボタン）→ 帯の［探す］。項目がどの理由で消えても（完了・取り消し・読み直し）、
   * 同じ列の押せる項目のうち同じ並びの位置に来た項目（無ければ列の最後）の最初の押せる物へ。列に押せる項目が無ければ帯の［探す］（body に落とさない）。
   * タスクの列は、消えた項目と同じ種類（タスクかリマインド）の項目だけで数える（最後のタスクを完了にした焦点をリマインドの［止める］に乗せない）。
   * 焦点のあった物が残っているのに焦点だけ外れたら（並び替えで節が動いた）、同じ物へ戻す
   */
  const drawDeck = (state) => {
    const before = document.activeElement;
    const inside = !!before && deckRoot.contains(before);
    const holder = inside ? before.closest("[data-key]") : null;
    const key = holder ? holder.dataset.key : null;
    const colBox = holder ? holder.closest("[data-col]") : null;
    const col = colBox ? colBox.dataset.col : null;
    const kind = col === "tasks" && holder ? holder.dataset.kind : undefined;
    const keysBefore = colKeys(col, kind);
    const turnsBefore = turnCount();
    const titleBefore = bandTitleKey();
    try {
      const model = deckModel(state);
      render(html`<${Deck} model=${model} on=${state.on} />`, deckRoot);
      lastModel = model;
    } catch (error) {
      // 名前だけ（message・stack は本文を含むことがあるので出さない）
      console.error("[web] deck draw failed", error instanceof Error ? error.name : "");
      return false;
    }
    // 下のバーの番の数は列の見出しと同じ数
    if (lastBar !== null && turnCount() !== turnsBefore) drawBar(lastBar);
    // スマホの帯の題（今いる列の名前と数）は列と同じ数
    if (lastBand !== null && bandTitleKey() !== titleBefore) drawBand(lastBand);
    if (inside && !document.contains(before)) {
      const keysAfter = colKeys(col, kind);
      const next = key === null || keysAfter.includes(key) ? null : focusAfter(keysBefore, keysAfter, key);
      const moved = key === null ? false : next === null ? keysAfter.includes(key) && focusItem(key) : focusFirstIn(next);
      if (!moved) focusBand("find");
    } else if (inside && document.activeElement !== before) {
      // 並び替え（リマインドの［次を飛ばす］）で節が動くと、残っている節でも焦点を失うブラウザが在る（moveBefore の無い物）。同じ物へ戻す
      before.focus();
    }
    return true;
  };

  /** 上の帯を描く。state は { variant, conn, hand, controls, page, turn, on }（variant は phone か、ほかは今の形。page は今いる列の id か undefined。turn は番の列が見えない間の { count }。#507）。描けなければ false */
  const drawBand = (state) => {
    const before = document.activeElement;
    const inside = !!before && bandRoot.contains(before);
    const act = inside && before.closest("[data-act]") ? before.closest("[data-act]").getAttribute("data-act") : null;
    try {
      render(
        html`<${DeckBand} variant=${state.variant} conn=${state.conn} hand=${state.hand} controls=${state.controls} title=${bandTitle(state)} turn=${state.turn} on=${state.on} />`,
        bandRoot,
      );
      lastBand = state;
    } catch (error) {
      console.error("[web] band draw failed", error instanceof Error ? error.name : "");
      return false;
    }
    if (inside && !document.contains(before) && !(act !== null && focusBand(act))) focusBand("find");
    return true;
  };

  /** スマホの帯の題: state.page の列（最後に描けたモデルの列。まだ無ければ空の state の列）の名前と数。phone でない・page が無い・その列が無ければ null */
  function bandTitle(state) {
    if (state.variant !== "phone" || typeof state.page !== "string") return null;
    const c = (lastModel || deckModel({ cols: 1 })).columns.find((col) => col.id === state.page);
    return c ? { name: c.name, count: c.count, tone: c.tone } : null;
  }

  /** 最後に描けた帯の題を比べる字（phone で題が在るときだけ。ほかは null） */
  function bandTitleKey() {
    const t = lastBand !== null && lastBand.variant === "phone" ? bandTitle(lastBand) : null;
    return t === null ? null : [t.name, t.count, t.tone].join("\u0000");
  }

  /** 最後に描けた列の番の数（まだ描いていなければ null） */
  function turnCount() {
    const col = lastModel ? lastModel.columns.find((c) => c.id === "turn") : null;
    return col ? col.count : null;
  }

  /** 下のバーに渡す列（最後に描けたモデルの列。まだ無ければ空の state の列）。数は あなたの番 だけ */
  const barPages = () => (lastModel || deckModel({ cols: 1 })).columns.map((c) => ({ id: c.id, label: c.name, count: c.id === "turn" ? c.count : null }));

  /** 列の入れ物（.c-deck）と、id の列（セレクタに id を埋めない）。無ければ null */
  const deckBox = () => deckRoot.firstElementChild;
  const colOf = (id) => Array.from(deckRoot.querySelectorAll("[data-col]")).find((n) => n.dataset.col === id) || null;
  /** 列の左端の横の位置（入れ物の送りの中の位置） */
  const colLeft = (box, col) => box.scrollLeft + col.getBoundingClientRect().left - box.getBoundingClientRect().left;

  /**
   * 下のバーを描く（D2。スマホの流れの列の下）。bar は { page, hand, controls, on: { page(id), paged(id), hand(opener) } } か null（空にする）。
   * paged(id) は自分で page() した分のほかに送られて一番近い列が替わったとき（半分を越えた時点。何度来ても同じ結果にし、中から page() を呼ばない）。
   * 描けなければ false。フォーカスには触らない
   */
  function drawBar(bar) {
    lastBar = bar;
    try {
      if (bar === null) {
        render(null, footRoot);
        return true;
      }
      render(html`<${BottomBar} variant="deck" pages=${barPages()} page=${bar.page} hand=${bar.hand} controls=${bar.controls} on=${bar.on} />`, footRoot);
    } catch (error) {
      console.error("[web] deck bar draw failed", error instanceof Error ? error.name : "");
      return false;
    }
    return true;
  }

  /** その列の左端へすぐ送る（動かさない）。スマホの横送り（data-paged）のときに呼ぶ。列が無い・列の入れ物が隠れている間（幅 0）は false */
  const page = (id) => {
    const box = deckBox();
    const col = colOf(id);
    if (!box || !col || box.clientWidth === 0) return false;
    pagedAt = id;
    box.scrollLeft = colLeft(box, col);
    return true;
  };

  /** 下のバーのボタン（"hand" か列の id）にフォーカス。無ければ false */
  const focusBar = (act) => {
    const b =
      act === "hand"
        ? footRoot.querySelector('button[data-act="hand"]')
        : Array.from(footRoot.querySelectorAll('button[data-act="page"]')).find((n) => n.dataset.page === act) || null;
    if (!b) return false;
    b.focus({ preventScroll: true });
    return true;
  };

  /**
   * 横送り（data-paged の列）で一番近い列が替わったら、下のバーに知らせる。自分で page() した分のほか（指・幅の変化の止まり直し・焦点の移動で送られた分）。
   * 半分を越えた時点で来るので、受け手は何度来ても同じ結果にする。受け手の中から page() を呼ばない。タイマーは使わない
   */
  const onScroll = (event) => {
    const box = event.target;
    if (!box || box.parentElement !== deckRoot || !box.hasAttribute("data-paged")) return;
    let near = null;
    let gap = Infinity;
    for (const col of box.querySelectorAll(":scope > [data-col]")) {
      const d = Math.abs(colLeft(box, col) - box.scrollLeft);
      if (d < gap) {
        gap = d;
        near = col.dataset.col;
      }
    }
    if (near === null || near === pagedAt) return;
    pagedAt = near;
    if (lastBar && lastBar.on && typeof lastBar.on.paged === "function") lastBar.on.paged(near);
  };

  /**
   * 右腕の丸を描く（D6。広い幅の流れの列の右下）。state は { mark, tone, open, controls, on: { hand(opener) } } か null（空にする）。
   * 描けた（null で空にできた）なら true、入れ物が無い・描くのに失敗したら（空にしてから）false（shell.js は帯の［右腕］を出す）。
   * 描き直しで丸の焦点が消えたら（null で空にした）、帯の［探す］へ
   */
  const drawOrb = (state) => {
    if (!orbRoot) return false;
    const before = document.activeElement;
    const inside = !!before && orbRoot.contains(before);
    try {
      render(state === null ? null : html`<${HandOrb} mark=${state.mark} tone=${state.tone} open=${state.open} controls=${state.controls} on=${state.on} />`, orbRoot);
    } catch (error) {
      console.error("[web] orb draw failed", error instanceof Error ? error.name : "");
      // 前に描けた丸を残さない（帯の［右腕］と両方出さない）
      try {
        render(null, orbRoot);
      } catch {
        // 空にもできなければそのまま（帯の［右腕］は出る）
      }
      return false;
    }
    if (inside && !document.contains(before) && !focusOrb()) focusBand("find");
    return true;
  };

  /** 右腕の丸にフォーカス。丸が無ければ false */
  const focusOrb = () => {
    const b = orbRoot ? orbRoot.querySelector('button[data-act="hand"]') : null;
    if (!b) return false;
    b.focus({ preventScroll: true });
    return true;
  };

  window.SA = window.SA || {};
  window.SA.deck = { draw: drawDeck, drawBand, fit: deckFit, focusItem, focusBand, drawOrb, focusOrb };
  // 帯の幅と端まで見えている列（#507。配線は shell.js の P4）
  Object.assign(window.SA.deck, { stripFit, stripSeen });
  if (footRoot) {
    deckRoot.addEventListener("scroll", onScroll, { capture: true, passive: true });
    Object.assign(window.SA.deck, { drawBar, page, focusBar });
  }
}

/** 知らせの入れ物。無ければ null（口を置かない。ui.js は古い #toast に出す） */
const noticeRoot = document.getElementById("c-notice-root");
/** 確認の入れ物。無ければ null（口を置かない。ui.js は古い #dlg-confirm を開く） */
const askRoot = document.getElementById("c-ask-root");

if (noticeRoot) {
  /** 知らせを描く。state は { items, on: { dismiss(id), hold(id, kind, on), left(id) } }。描けなければ false（ui.js が古い描き方に戻す） */
  const drawNotice = (state) => {
    try {
      render(html`<${Toast} items=${state.items} onDismiss=${state.on.dismiss} onHold=${state.on.hold} onLeft=${state.on.left} />`, noticeRoot);
    } catch (error) {
      // 名前だけ（message・stack は本文を含むことがあるので出さない）
      console.error("[web] notice draw failed", error instanceof Error ? error.name : "");
      return false;
    }
    return true;
  };
  window.SA = window.SA || {};
  window.SA.notice = { draw: drawNotice };
}

if (askRoot) {
  /** 確認を描く。state は { open, title, target, body, okLabel, danger, on: { ok(), cancel() } }。描けなければ false */
  const drawAsk = (state) => {
    try {
      render(
        html`<${Confirm}
          open=${state.open}
          id="c-ask"
          title=${state.title}
          target=${state.target}
          body=${state.body}
          okLabel=${state.okLabel}
          danger=${state.danger}
          onOk=${state.on.ok}
          onCancel=${state.on.cancel}
        />`,
        askRoot,
      );
    } catch (error) {
      console.error("[web] ask draw failed", error instanceof Error ? error.name : "");
      return false;
    }
    return true;
  };
  window.SA = window.SA || {};
  window.SA.ask = { draw: drawAsk };
}

/** 右腕の見出しの入れ物。無ければ null（口を置かない。chat.js が古い見出しを描く） */
const handRoot = document.getElementById("c-hand-root");

if (handRoot) {
  /** 右腕の見出しのボタン（close・menu）。無ければ null */
  const handButton = (what) => {
    const span = handRoot.querySelector('[data-act="' + what + '"]');
    return span ? span.querySelector("button") : null;
  };

  /** 見出しを描く。state は { title, menu, seat, on: { menu(opener), close(), seat(opener) } } か null（消す）。seat が true のときだけ［広げる］。描けなければ false（shell.js が古い見出しに戻す） */
  const drawHand = (state) => {
    const before = document.activeElement;
    const inside = !!before && handRoot.contains(before);
    try {
      render(state === null ? null : html`<${HandHead} title=${state.title} menu=${state.menu} seat=${state.seat === true} on=${state.on} />`, handRoot);
    } catch (error) {
      // 名前だけ（message・stack は本文を含むことがあるので出さない）
      console.error("[web] hand draw failed", error instanceof Error ? error.name : "");
      return false;
    }
    // 焦点のあったボタンが消えた（「…」が出なくなった）: [畳む] へ（body に落とさない）
    if (inside && !document.contains(before)) {
      const next = handButton("close");
      if (next) next.focus({ preventScroll: true });
    }
    return true;
  };

  /** 見出しのボタン（close・menu）にフォーカス。無ければ false。送らない（枠が出る動きの間、枠は画面の外へはみ出している。席の見出しと同じ） */
  const focusHand = (what) => {
    if (what !== "close" && what !== "menu") return false;
    const b = handButton(what);
    if (!b) return false;
    b.focus({ preventScroll: true });
    return true;
  };

  window.SA = window.SA || {};
  window.SA.hand = { draw: drawHand, focus: focusHand };
}
