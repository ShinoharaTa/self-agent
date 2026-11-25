// 新しい殻（index.html。docs/plan/web-ui-v3.md §2・§11 の M2）: 話題の一覧（列 1。topics.js）と開いた話題（列 2）、
// SA.app（古い殻 workbench.js と同じ名前の契約。chat.js・views.js・api.js・ui.js・sound.js が呼ぶ）・hash・スマホの一覧 ⇄ 会話・テーマ・書きかけ・シート・キーボードの高さ、
// 下のバー（描くのは入口 c-app.js）と「ほか」の板・接続の点と鈴・絞り込み・一覧のキー、列 2 の見出し（描くのは入口 c-app.js の SA.top。[会話][端末]・場所・「…」の板。K4）、右腕（#514。一覧・列の一番上の行からほかの話題と同じに列 2（席）に開く。見出し・印・札）、話題を始めるダイアログ（#v3-start。§2・§5 の M4）、場所を変える（シートと確認。§6.3 の M5）、
// 640px 以上の流れの列（docs/plan/web-ui-deck.md の D1。入口 c-app.js の SA.deck が在るときだけ）: 上の帯・3 つの列（状態は flows.js）・席（列 2 を開いたときだけ）・「探す」の板（一覧を重ねる）
"use strict";

(function () {
  const SA = (window.SA = window.SA || {});
  const { el, icon, openDialog, closeDialog } = SA.ui;
  const root = document.documentElement;

  // ===== 保存（このブラウザだけ。読めなくても動く。鍵は古い殻と同じなので、テーマと書きかけは 2 つの画面で共有する） =====
  const STORAGE_PREFIX = "self-agent-web:";

  function load(key, fallback) {
    try {
      const v = window.localStorage.getItem(STORAGE_PREFIX + key);
      return v === null ? fallback : v;
    } catch {
      return fallback;
    }
  }

  function save(key, value) {
    try {
      window.localStorage.setItem(STORAGE_PREFIX + key, value);
    } catch {
      // 保存できない環境（プライベートモードなど）では覚えないだけ
    }
  }

  function loadJson(key) {
    try {
      const v = JSON.parse(load(key, "null"));
      return v !== null && typeof v === "object" ? v : null;
    } catch {
      return null;
    }
  }

  // スマホ（639px 以下）は 1 列（一覧 ⇄ 会話）、640px 以上は 2 列
  const mqPhone = window.matchMedia ? window.matchMedia("(max-width: 639px)") : { matches: false, addEventListener() {} };
  const phone = () => mqPhone.matches;
  // 流れの列の入口（c-app.js の SA.deck）が在れば、640px 以上は上の帯 + 3 列 + 席。無ければ今の広い幅の形（一覧 + 列 2）に落ちる（D10 で落ち先ごと消す）
  // スマホは入口に下のバーの口（SA.deck.drawBar）も在るときだけ、上の帯 + 1 列ずつの横送り + 下のバー（deckFull。D2）。無ければ今のスマホの殻（一覧 ⇄ 会話）
  const deckOn = () => !!SA.deck && (!phone() || typeof SA.deck.drawBar === "function");
  const deckFull = () => phone() && deckOn();

  // ===== 状態 =====
  const THEMES = ["dark", "light", "system"];

  const S = {
    // 列 2 に出している話題か画面のタブ ID（ch:<id>・cc:<id>・tasks など）
    active: null,
    theme: "dark",
    // チャンネルごとの書きかけ（localStorage の drafts。送ったら消す）
    drafts: {},
    // スマホで見えている側（"list" | "body"）
    view: "list",
    // Claude Code のチャンネルのある話題で見ている物（"talk" 会話 | "pane" 端末の画面の写し）。話題を開くたびに talk
    view2: "talk",
    // 端末のセッションの話題（cc:）で見ている物（"card" 札 | "pane" 今の［端末］のタブ）。話題を開くたびに card
    term: "card",
    // 見出しを compact（場所・[会話][端末] を「…」の板へ）にするか。列 2 の幅を測れるまでは compact（fitTop が入口に測らせて決める）
    topCompact: true,
    // 流れの列: 最後に書いた見える列の数と席に開いている物（null は流れの列でない）・席を開いた元（{ key } か { find: true }。閉じた後の焦点）
    deckCols: null,
    deckCurrent: null,
    seatFrom: null,
    // スマホの流れの列で見ている列（"turn" | "tasks" | "feed"。メモリだけ。履歴・hash・保存に書かない）
    deckPage: "turn",
    // 留めた話題の会話の列を帯に並べているか（#507。fitDeck が #v3 の data-pins と一緒に書く）
    deckPins: false,
  };

  const $ = (id) => document.getElementById(id);
  const refs = {};

  // ===== テーマ =====
  // ブラウザの上の帯の色（--surface。index.html の theme-color の 2 つと同じ値）
  const THEME_COLORS = { light: "#ffffff", dark: "#11141c" };

  function applyTheme() {
    if (S.theme === "system") delete root.dataset.theme;
    else root.dataset.theme = S.theme;
    // OS に合わせるときは media ごとの元の値、決めたときは 2 つともそのテーマの値
    for (const meta of document.querySelectorAll('meta[name="theme-color"]')) {
      const own = (meta.getAttribute("media") || "").includes("dark") ? "dark" : "light";
      meta.setAttribute("content", THEME_COLORS[S.theme === "system" ? own : S.theme]);
    }
    const dark = S.theme === "dark" || (S.theme === "system" && window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches);
    const btn = $("theme-toggle");
    if (btn) {
      btn.replaceChildren(icon(dark ? "sun" : "moon"));
      btn.setAttribute("aria-label", dark ? "ライトにする" : "ダークにする");
      btn.title = dark ? "ライトにする" : "ダークにする";
    }
  }

  function setTheme(theme) {
    S.theme = THEMES.includes(theme) ? theme : "dark";
    save("theme", S.theme);
    applyTheme();
  }

  // ===== 書きかけ =====
  /** 書きかけを localStorage に残す（読めない・書けない環境ではこのタブのメモリだけ） */
  function setDraft(channelId, value) {
    if (value) S.drafts[channelId] = value;
    else delete S.drafts[channelId];
    save("drafts", JSON.stringify(S.drafts));
  }

  /** 一覧（/api/channels）に無いチャンネルの書きかけを消す。列 2 に開いている会話の分は残す（入力欄に字が見えたまま、送れない形にしない） */
  function pruneDrafts(channelIds) {
    try {
      const keep = new Set(channelIds);
      if (S.active && S.active.startsWith("ch:")) keep.add(S.active.slice(3));
      const stale = Object.keys(S.drafts).filter((id) => !keep.has(id));
      if (stale.length === 0) return;
      for (const id of stale) delete S.drafts[id];
      save("drafts", JSON.stringify(S.drafts));
    } catch {
      // 消せなくても書きかけが残るだけ
    }
  }

  // ===== 知らせの 1 行（views.js の知らせの画面が使う） =====
  /** 知らせの重さごとのアイコン */
  const NOTICE_ICONS = { warning: "triangle-alert", danger: "triangle-alert", success: "check", info: "info" };

  /** 知らせの 1 行（本文は文字のまま。Discord のリンクは投稿できたものだけ） */
  function noticeLine(n) {
    const level = Object.prototype.hasOwnProperty.call(NOTICE_ICONS, n.level) ? n.level : "info";
    return el("li", { class: "notice-item is-" + level }, [
      icon(NOTICE_ICONS[level]),
      el("span", { class: "out-time", title: SA.ui.dateTime(n.at), text: SA.ui.shortTime(n.at) }),
      el("span", { text: String(n.text) }),
      typeof n.link === "string" && n.link.startsWith("https://discord.com/channels/")
        ? el("a", { class: "meta", href: n.link, target: "_blank", rel: "noreferrer noopener", "aria-label": "Discord で開く", title: "Discord で開く" }, [icon("external-link")])
        : null,
    ]);
  }

  // ===== 列 2 =====
  /** 下端から 48px 以内なら下端に居るとみなす */
  function atBottom(scroll) {
    return scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight < 48;
  }

  /** スマホで一覧を出している間（流れの列では席を閉じている間）は列 2 が display: none で、スクロールの読み書きが効かない */
  function mainHidden() {
    return S.view === "list" && (phone() || deckOn());
  }

  // 列 2 が隠れる直前のスクロール（{ top, bottom }）と、隠れている間に描き直して「表示されたら下端に寄せる」印
  let hiddenScroll = null;
  let stickOnShow = false;

  // 列 2 に最後に描いたタブ（[端末] の間は cc:<sessionId>）と、それを右腕の会話の指定で描いたか（一覧より先に hash で開いた右腕は、一覧が読めたら描き直す）
  let edTab = null;
  let edHand = false;
  // 札を描けなかった。次からは今の［端末］のタブを出す
  let termBroken = false;

  /** タブの中身を描く。同じタブならスクロール位置は保ち、別のタブに切り替えたとき（switched）は下端（data-stick="bottom"）か先頭から */
  function renderEd(ed, tabId, switched) {
    edTab = tabId || null;
    edHand = false;
    const hidden = mainHidden();
    const oldScroll = switched || hidden ? null : ed.querySelector(".ed-scroll");
    const wasBottom = !oldScroll || atBottom(oldScroll);
    const oldTop = oldScroll ? oldScroll.scrollTop : 0;
    if (tabId && tabId.startsWith("term:")) {
      const sessionId = tabId.slice(5);
      let drawn = false;
      try {
        drawn = SA.takeover.render(ed, sessionId, termCtx(sessionId)) === true;
      } catch (error) {
        console.error("[web] term render failed", error instanceof Error ? error.name : "");
      }
      // 札は短いので位置は覚えない
      if (drawn) return;
      // 描けなければ今の［端末］のタブに戻し、次からも札を試さない（画面の写しは、open からなら下の onOpen が読み始める。描き直しの途中なら行を開き直したとき）
      termBroken = true;
      SA.takeover.close(sessionId);
      tabId = shownTabId();
      edTab = tabId || null;
      // 見出しは札の名前で描いた後なので、戻したタブの名前で描き直す
      renderBar();
    }
    const info = tabId ? SA.views.info(tabId) : null;
    if (!info) {
      ed.replaceChildren(el("div", { class: "v3-empty" }, [el("p", { class: "meta", text: "左の一覧から話題を選んでください" })]));
      return;
    }
    // 席の右腕（#514。行から開く）は右腕の会話の指定で描く。札の <#ID> を覚え直す（一覧が変われば syncHand が描き直す）
    const seatId = tabId === handTab() ? handChannelId() : null;
    if (seatId !== null) {
      edHand = true;
      handCardIds = [];
      SA.chat.render(ed, seatId, HAND_TALK);
      handCardSig = cardSig();
    } else info.render(ed);
    const scroll = ed.querySelector(".ed-scroll");
    if (!scroll) return;
    const stick = scroll.dataset.stick === "bottom";
    if (hidden) {
      // 隠れている間は位置を書けないので、表示したとき（setView）に当てる
      if (stick && hiddenScroll && hiddenScroll.bottom) stickOnShow = true;
    } else if (stick && wasBottom) scroll.scrollTop = scroll.scrollHeight;
    else scroll.scrollTop = oldTop;
  }

  /** [会話][端末] を出せる話題（Discord のチャンネルがあり、今も一覧に居る Claude Code のセッション）なら、そのセッションの ID */
  function paneSession() {
    const t = S.active ? SA.topics.find(S.active) : null;
    return t && t.origin === "cc" && t.id.startsWith("ch:") && t.sessionId !== null ? t.sessionId : null;
  }

  /** 札を出す話題（cc: で、札の入口と口が在り、まだ「端末を見る」を押していない）なら、そのセッションの ID */
  function termSession() {
    if (S.term !== "card" || termBroken || !S.active || !S.active.startsWith("cc:")) return null;
    return SA.takeover && SA.term ? S.active.slice(3) : null;
  }

  /** 「…」の板に「取り込む」を出せる話題（Claude Code のチャンネルが在り、今も一覧に居るセッションで、札の入口と口が在る）なら、そのセッションの ID */
  function takeSession() {
    return SA.takeover && SA.term && !termBroken ? paneSession() : null;
  }

  /** 札に渡す物: 一覧の行（cc: の行。無ければ同じセッションの Claude Code のチャンネルの行。どちらも無ければ null）・場所の文字・「端末を見る」 */
  function termCtx(sessionId) {
    const data = SA.topics.data();
    const row =
      SA.topics.find("cc:" + sessionId) ||
      (data ? data.topics.find((t) => t !== null && typeof t === "object" && t.origin === "cc" && t.sessionId === sessionId) : null) ||
      null;
    return { row, place: row ? placeText(row) : null, pane: showTermPane };
  }

  /** 札の「端末を見る」: 今の［端末］のタブに替える（別のタブとして描き、画面の写しを読む） */
  function showTermPane() {
    const sessionId = termSession();
    if (sessionId === null) return;
    S.term = "pane";
    SA.takeover.close(sessionId);
    renderMain(true);
    const info = SA.views.info(shownTabId());
    if (info && info.onOpen) info.onOpen();
  }

  /** 列 2 に出しているタブ（[端末] の間は cc:<sessionId>、札の間は term:<sessionId>。一覧の aria-current と hash は S.active のまま） */
  function shownTabId() {
    const term = termSession();
    if (term) return "term:" + term;
    if (S.view2 === "pane") {
      const sessionId = paneSession();
      if (sessionId) return "cc:" + sessionId;
    }
    return S.active;
  }

  /** [会話] ⇄ [端末]（切り替えは別のタブとして下端に寄せる） */
  function setView2(view) {
    if (S.view2 === view) return;
    S.view2 = view;
    renderBar();
    renderEd($("ed"), shownTabId(), true);
    // 前に出た方を読み直す（端末は画面の写し、会話は turns など。その後は api.js の polling）。切り替えでは閉じない
    const info = SA.views.info(shownTabId());
    if (info && info.onOpen) info.onOpen();
  }

  /** 見出しの押した先（1 回だけ作り、毎回同じ物を渡す） */
  const TOP_ON = {
    back: () => openDrawer(),
    place: (opener) => openPlace(opener),
    mode: (opener) => openMode(opener),
    view: (value) => setView2(value),
    menu: (opener) => openTopMenu(opener),
    // 流れの列の席を閉じる（スマホの一覧へと同じ履歴）
    close: () => showList(),
    // 席の話題を留める（#507。帯の末尾の列にしてそこへ送る）
    pin: () => {
      if (S.active) pinSeat(S.active);
    },
  };

  /** 列 2 に出している会話のチャンネルの見出しの中身（chat.js の head）。会話でなければ null */
  function topHead() {
    return S.active && S.active.startsWith("ch:") && SA.chat.head ? SA.chat.head(S.active.slice(3)) : null;
  }

  /** 見出しに渡す state（入口 c-app.js の TopBar の props）。何も開いていなければ view: none */
  function topState() {
    const info = S.active ? SA.views.info(S.active) : null;
    if (!info) return { view: "none", title: "", status: null, note: null, place: null, views: null, compact: S.topCompact, menu: false, mode: null, close: false, on: TOP_ON };
    if (handSeated()) return handSeatTop();
    const t = SA.topics.find(S.active) || null;
    const head = topHead();
    const pin = seatPin(t);
    let status = null;
    if (t) {
      if (t.mark === "turn") status = { text: "あなたの番", tone: "warning" };
      else if (t.mark === "running") status = { text: "作業中", tone: "accent" };
      else status = head ? head.status : null;
    }
    return {
      view: t ? "talk" : "other",
      title: t && typeof t.title === "string" && t.title !== "" ? t.title : info.title || "",
      status,
      note: head ? head.note : null,
      place: t
        ? {
            text: placeText(t),
            movable: t.movable === true,
            reason: t.movable !== true && t.movable && typeof t.movable.reason === "string" ? t.movable.reason : null,
          }
        : null,
      views: paneSession() !== null ? { value: S.view2 } : null,
      compact: S.topCompact,
      menu: t !== null && (topNarrow() || takeSession() !== null || (head !== null && head.menu.length > 0) || pinRow(t) !== null),
      mode: head && head.mode ? { value: head.mode, disabled: modeBusy(t), reason: modeBusy(t) ? MODE_BUSY : null } : null,
      close: deckOn() && !phone(),
      // ピンのボタン（#507）は出す時だけ鍵を足す（出さない時の state は前と同じ）
      ...(pin ? { pin } : {}),
      // スマホの流れの列の［‹］は列へ戻る（落ち先は「一覧へ」のまま）
      backLabel: deckFull() ? "戻る" : undefined,
      on: TOP_ON,
    };
  }

  /** 列 2 の見出し（描くのは入口 c-app.js）。描けなければ題だけの形で 1 回だけ描き直す。入口が無ければ何もしない（chat.js・views.js が今の見出しを描く） */
  function renderBar() {
    // [端末] を出せなくなったら会話に戻す（入口が無くても）
    if (paneSession() === null && S.view2 === "pane") S.view2 = "talk";
    if (!SA.top) return;
    const st = topState();
    if (SA.top.draw(st)) return;
    SA.top.draw({ view: st.view, title: st.title, status: null, note: null, place: null, views: null, compact: S.topCompact, menu: false, mode: null, close: st.close, backLabel: st.backLabel, on: TOP_ON });
  }

  /** 見出しの帯に場所・[会話][端末] が出ていないか（スマホか、広い幅の compact）。出ていなければ「…」の板に入れる */
  function topNarrow() {
    return phone() || S.topCompact;
  }

  /**
   * 列 2 の幅を入口に測らせ、見出しの compact を決める（替わったときだけ描く）。測れなければ compact。
   * 板が開いている間は測らない（後ろの見出しの形を替えない。板は opener を覚えている）。呼ぶのは起動・resize・スマホの境・板の close
   */
  function fitTop() {
    if (!SA.top) return;
    const sheet = $("v3-sheet");
    if (sheet && sheet.open) return;
    const next = SA.top.compact() === false ? false : true;
    if (next === S.topCompact) return;
    S.topCompact = next;
    renderBar();
  }

  /** 見出しの「…」の板: スマホと compact は場所を変える・[会話][端末] の代わりを先頭に、後ろにチャンネルの操作（head.menu）。席の右腕は右腕の「…」の板 */
  function openTopMenu(opener) {
    if (handSeated()) {
      openHandMenu(opener);
      return;
    }
    const t = S.active ? SA.topics.find(S.active) : null;
    if (!t) return;
    const head = topHead();
    const items = [];
    if (topNarrow()) {
      items.push({
        icon: "pencil",
        label: "場所を変える",
        run: t.movable === true ? () => openPlace(opener) : null,
        why: t.movable !== true && t.movable && typeof t.movable.reason === "string" ? t.movable.reason : "",
      });
      if (head && head.mode) {
        const busy = modeBusy(t);
        items.push({ icon: "settings", label: "許可のモードを変える", run: busy ? null : () => openMode(opener), why: MODE_BUSY });
      }
      if (paneSession() !== null) {
        items.push(S.view2 === "pane" ? { icon: "chevron-left", label: "会話に戻る", run: () => setView2("talk") } : { icon: "terminal", label: "端末を見る", run: () => setView2("pane") });
      }
    }
    const takeId = takeSession();
    if (takeId !== null) items.push({ icon: "play", label: "取り込む", run: () => open("cc:" + takeId) });
    const pin = pinRow(t);
    if (pin) items.push(pin);
    if (head) items.push(...head.menu);
    if (items.length === 0) return;
    openSheet(topState().title + " の操作", items, opener);
  }

  /**
   * 「…」の板の「ピン留めする／ピン留めを外す」の行（#507）。ピン留めの口が在り、完了でない ch: の話題で、右腕でないときだけ。出さなければ null。
   * 上限の時、留めていない話題の行は押せず理由の文
   */
  function pinRow(t) {
    const max = SA.topics.pinMax();
    if (max <= 0 || !t || typeof t.id !== "string" || !t.id.startsWith("ch:") || t.state === "done" || t.id === handTab()) return null;
    const pins = SA.topics.pins();
    if (pins.includes(t.id.slice(3))) return { icon: "pin", label: "ピン留めを外す", run: () => setPin(t.id, false) };
    const full = pins.length >= max;
    return { icon: "pin", label: "ピン留めする", run: full ? null : () => pinSeat(t.id), why: full ? pinLimitText(max) : "" };
  }

  /** 上限の理由の文（#507。「…」の行・席のピンのボタン・409 の知らせで同じ文） */
  function pinLimitText(max) {
    return "ピン留めは " + max + " つまで";
  }

  /**
   * 席の見出しのピンのボタン（#507）: 帯が出る幅（640px 以上で席だけの幅でない）で、「…」の板に「ピン留めする」を出す話題（pinRow）のうち留めていない物だけ { on: false }。ほかは null。
   * 上限の時は押せず（IconButton の aria-disabled。押しても on.pin を呼ばない）、理由の文を出す。ほかの端末と競った時はサーバーの 409 の知らせ
   */
  function seatPin(t) {
    if (phone() || !deckOn() || !SA.pins || typeof SA.deck.stripFit !== "function" || !t || pinRow(t) === null) return null;
    if (SA.topics.pins().includes(t.id.slice(3)) || SA.deck.stripFit(refs.v3.clientWidth, true).show !== true) return null;
    const max = SA.topics.pinMax();
    if (SA.topics.pins().length >= max) return { on: false, disabled: true, why: pinLimitText(max) };
    return { on: false };
  }

  /** 話題の「場所」の文字（帯と札で同じ決め方）。群 general は General のセッションなら「General」、場所の無い軽いセッションは「なし」 */
  function placeText(t) {
    if (t.group === "other") return "ほかの場所" + (t.cwdLabel ? "（" + t.cwdLabel + "）" : "");
    if (t.group === "general") return t.place && t.place.dir ? "General" : "なし";
    return t.place && t.place.dir ? t.place.dir : "なし";
  }

  function renderMain(switched) {
    renderBar();
    renderEd($("ed"), shownTabId(), switched);
    writeHash();
  }

  /** 最後に fitDeck が済んだ留めた話題（#507。","で繋いだ channelId。0 個は ""。fitDeck が投げたら書かず、次の refreshTabs でやり直す） */
  let pinSig = "";

  /** 一覧を読み直した後: 留めた話題が変わったら帯の列を合わせ（#507）、帯を描き、[端末] を出せなくなって出す物が変わったら描き直す */
  function refreshTabs() {
    const sig = SA.topics.pins().join(",");
    if (sig !== pinSig) {
      fitDeck();
      pinSig = sig;
    }
    renderBar();
    const shown = shownTabId();
    const ed = $("ed");
    if (ed && shown !== edTab) {
      // 一覧を出している間に会話に戻したら、次に会話の列を出したとき下端にする（[端末] の位置を当てない）
      if (mainHidden()) hiddenScroll = { top: 0, bottom: true };
      renderEd(ed, shown, true);
    } else if (ed && shown && shown.startsWith("term:")) renderEd(ed, shown);
    syncHand();
    renderFlows();
  }

  /** api.js の polling・SA.app.refresh が当たるのは列 2 に出している物（[端末] の間は cc:<sessionId>） */
  function activeTabId() {
    return shownTabId();
  }

  /**
   * 画面に描かれていて見えている会話のチャンネル（ch: を外したもの）。列 2 の会話の 1 つ（[端末] の間は無い。右腕も列 2 の会話。#514）と、帯の見えている留めた話題の列（#507）。
   * スマホで一覧を出している間（会話の列が隠れている間）も、最後に開いた会話を返す（M2a からの動き。変えるなら polling・音が一緒に変わる（既読は readingChannelIds））
   */
  function shownChannelIds() {
    const tabId = shownTabId();
    const ids = tabId && tabId.startsWith("ch:") ? [tabId.slice(3)] : [];
    for (const id of pinsSeen()) if (!ids.includes(id)) ids.push(id);
    return ids;
  }

  /** 帯の端まで見えている留めた話題の列（#507。pins.js が送りの止まった後に数えた物。帯が出ていなければ空） */
  function pinsSeen() {
    return SA.pins && pinsShown() ? SA.pins.seen() : [];
  }

  /**
   * 既読を付ける会話（chat.js の markSeen。M7）。shownChannelIds から、スマホで一覧を出している間（流れの列では席を閉じている間）の列 2 の会話を除いたもの。
   * 帯の留めた話題の列（#507）は、「探す」の板が開いている間は入れない
   */
  function readingChannelIds() {
    const tabId = shownTabId();
    const ids = !mainHidden() && tabId && tabId.startsWith("ch:") ? [tabId.slice(3)] : [];
    if (!findOpen()) for (const id of pinsSeen()) if (!ids.includes(id)) ids.push(id);
    return ids;
  }

  /** 流れの列の間の古い行き先（古い hash・画面のタブ）→ 列の id。古い表は開かず、その列へ */
  const OLD_PAGES = { tasks: "tasks", reminders: "tasks", github: "feed", notices: "feed" };

  /** 古い行き先か（流れの列の間だけ。幅に依らない） */
  function oldPage(tabId) {
    return deckOn() && Object.prototype.hasOwnProperty.call(OLD_PAGES, tabId) ? OLD_PAGES[tabId] : null;
  }

  /** 古い行き先を列に読み替える: 今の列を替え（スマホはその列へ送る）、hash は今の物に書き直す。履歴は積まず、スレッドが開いていても閉じない */
  function showOldPage(page) {
    S.deckPage = page;
    if (deckFull()) {
      SA.deck.page(page);
      renderBottom(handMark());
      renderBand();
    }
    writeHash();
  }

  /** 話題か画面を列 2 に開く（知らない・無効な機能のタブは開かない） */
  function open(tabId) {
    // 流れの列の項目から開いたときの key（押した直後の 1 回だけ。ほかの開き方では null）
    const fromKey = SA.flows ? SA.flows.lastKey() : null;
    if (!tabId) return;
    // 帯が出ている間の留めた話題（#507）は席に開かず、その列へ送って入力欄に焦点（住所は書かない）。「探す」の板は先に畳む
    if (tabId.startsWith("ch:") && pinsShown() && SA.pins.has(tabId.slice(3))) {
      if (findOpen()) closeFind(false);
      SA.pins.jump(tabId.slice(3), "composer");
      return;
    }
    const page = oldPage(tabId);
    if (page !== null) {
      showOldPage(page);
      return;
    }
    const info = SA.views.info(tabId);
    if (!info) {
      // /api/status が届く前の Claude Code の話題は、届いたら開く（起動の hash と同じ道）
      if (tabId.startsWith("cc:") && SA.store.status === null) deferred = tabId;
      return;
    }
    // 右腕のタブもほかの ch: と同じに席（列 2）に開く（#514）
    const seatedBefore = handSeated();
    const switched = S.active !== tabId;
    const shownBefore = edTab;
    // 会話（ch:）は閉じない（開いた手順・選びかけの選択肢を、ほかの話題を見て戻っても保つ）
    if (S.active !== null && switched && !S.active.startsWith("ch:")) {
      const prev = SA.views.info(S.active);
      if (prev && prev.onClose) prev.onClose();
      if (S.active.startsWith("cc:") && SA.takeover) SA.takeover.close(S.active.slice(3));
    }
    S.active = tabId;
    S.view2 = "talk";
    S.term = "card";
    SA.topics.setCurrent(tabId);
    deferred = null;
    if (switched) {
      hiddenScroll = null;
      stickOnShow = false;
    }
    // スマホは先に会話の列を出してから描く（隠れたままではスクロールを書けない）
    // 流れの列: 「探す」の板から開いたか（板は閉じ、焦点は席の［閉じる］へ）
    const fromFind = deckOn() && findOpen();
    if (phone()) {
      // スマホの流れの列: 板は閉じ（entry は showBody が話題に置き換える）、閉じた後の焦点の元を覚える
      if (deckFull()) {
        if (fromFind) closeFind(false);
        S.seatFrom = fromFind ? { find: true } : { key: fromKey };
      }
      showBody();
    } else if (deckOn()) {
      // 席はスマホの会話と同じ履歴（v3Body の entry）。板は畳む
      if (fromFind) closeFind(false);
      S.seatFrom = fromFind ? { find: true } : { key: fromKey };
      showBody();
    }
    // 同じ話題でも [端末] から会話に戻ったときは別のタブとして描く
    renderMain(switched || shownBefore !== shownTabId());
    SA.topics.render();
    // 席の住人が右腕になった・やめた: 右腕の印（見えている右腕には未読・作業中を出さない）
    if (handSeated() !== seatedBefore) renderHandEntries();
    // 札のときは画面の写しを読まない（判定だけ読む）
    const term = termSession();
    if (term) SA.takeover.open(term);
    else if (info.onOpen) info.onOpen();
    // 一覧（/api/channels）にまだ無いチャンネル（/api/topics で先に知った話題）は、見出しのために 1 回読む
    if (tabId.startsWith("ch:") && !SA.chat.channelById(tabId.slice(3))) SA.store.load.channels({ quiet: true });
    // スマホは一覧が隠れるので、見出しの「一覧へ」に焦点（入口が無ければ今の見出しの [‹]）
    if (phone()) {
      if (!(SA.top && SA.top.focus("back"))) {
        const back = $("ed").querySelector(".ed-back");
        if (back) back.focus({ preventScroll: true });
      }
    } else if (deckOn() && (fromFind || S.deckCols === 0)) {
      // 板から開いた・席だけの幅（列が隠れて押した項目が見えない）: 席の［閉じる］へ。項目から開いたなら焦点は項目のまま
      if (SA.top) SA.top.focus("close");
    }
  }

  /** tabId が列 2 に出ていれば見出しと中身だけ描き直す */
  function refresh(tabId) {
    // 帯の中の留めた話題の列（#507）は、見えていなくても描き直す（留めた話題は席に開かないので席の側とは取り合わない）
    if (tabId !== null && tabId.startsWith("ch:") && SA.pins && SA.pins.has(tabId.slice(3))) SA.pins.refresh(tabId.slice(3));
    if (shownTabId() !== tabId) return;
    // チャンネルの状態が変わったときに見出しも合わせる
    renderBar();
    const ed = $("ed");
    if (ed) renderEd(ed, tabId);
  }

  // ===== 右腕（既定の人格の #inbox。一覧・列の一番上の行からほかの話題と同じに列 2（席）に開き、chat.js が描く。#514） =====
  // 札: 最後に描いた返事の <#ID> と、その札の中身の署名（一覧を読んで変わったら描き直す）
  let handCardIds = [];
  let handCardSig = null;

  /** 右腕のタブ（/api/topics の rightHands の先頭。サーバーが複数でも選ぶ口は作らない）。無ければ null */
  function handTab() {
    const data = SA.topics.data();
    const hand = data && data.rightHands[0];
    return hand ? hand.id : null;
  }

  function handChannelId() {
    const tab = handTab();
    return tab && tab.startsWith("ch:") ? tab.slice(3) : null;
  }

  /** 席の住人が右腕か（行から開く open はほかの話題と同じ。席を閉じても住人は右腕のまま） */
  function handSeated() {
    return S.active !== null && S.active === handTab();
  }

  /** 右腕の会話が見えているか（席の住人が右腕で、席が隠れていない間）。見えていなければ行と下のバーに未読・作業中を出す */
  function handSeen() {
    return handSeated() && !mainHidden();
  }

  /**
   * 押せない（inert）所を 1 か所で決める: 「探す」の板の間は上の帯・列・下のバー・列 2（一覧は板として前に出る）。
   * 呼ぶのは openFind・closeFind・fitDeck（流れの列でなくなったとき）
   */
  function applyInert() {
    const find = deckOn() && findOpen();
    for (const id of ["v3-band", "v3-deck", "v3-foot", "v3-main"]) {
      const n = $(id);
      if (n) n.inert = find;
    }
  }

  /** chat.js に渡す席の右腕の枠の指定（毎回同じ物）。見出しは列 2 の部品が描く（head: false）。送る本文は入力のまま。札は古い描き方では replyExtras（DOM）、部品の道では replyRefs・noticeRefs（データ）と onRef */
  const HAND_TALK = {
    title: "右腕",
    placeholder: "右腕に頼む・訊く",
    replyText: namedText,
    noticeText: handNoticeText,
    replyExtras: handCards,
    replyRefs: handRefs,
    noticeRefs: handRefs,
    onRef: (id) => SA.app.open(id),
    head: false,
  };

  /** 右腕の「…」の行（chat.js の head の menu。#inbox では会話を新しくする・Discord で開く）。チャンネルが無ければ空 */
  function handMenu() {
    const id = handChannelId();
    const head = id && SA.chat.head ? SA.chat.head(id) : null;
    return head ? head.menu : [];
  }

  function openHandMenu(opener) {
    const items = handMenu();
    if (items.length === 0) return;
    openSheet(HAND_TALK.title + " の操作", items, opener);
  }

  /** 席の入力欄に焦点（部品なら口に頼む）。無ければ席の［閉じる］ */
  function focusSeatInput() {
    const ed = $("ed");
    const root = ed ? [...ed.children].find((child) => child.getAttribute("data-composer") !== null) : null;
    if (root && SA.composer && SA.composer.focus(root)) return;
    const input = ed ? ed.querySelector("textarea.composer-input") : null;
    if (input) input.focus({ preventScroll: true });
    else if (SA.top) SA.top.focus("close");
  }

  /** 席の右腕の見出しの state: 題「右腕」・状態は あなたの番 > 作業中・場所・モード・［会話］［端末］は無し・「…」は右腕の操作 */
  function handSeatTop() {
    const data = SA.topics.data();
    const hand = data && data.rightHands[0];
    let status = null;
    if (hand && hand.turn) status = { text: "あなたの番", tone: "warning" };
    else if (SA.store.runningOf(handChannelId()) !== null) status = { text: "作業中", tone: "accent" };
    return {
      view: "talk",
      title: HAND_TALK.title,
      status,
      note: null,
      place: null,
      views: null,
      compact: S.topCompact,
      menu: handMenu().length > 0,
      mode: null,
      close: deckOn() && !phone(),
      backLabel: deckFull() ? "戻る" : undefined,
      on: TOP_ON,
    };
  }

  /**
   * 席の右腕をやめる（右腕のチャンネルが替わった・無くなった。呼ぶ側が席の住人を確かめる）。席の住人を空にする（前の右腕を普通の会話の枠で描かない）。
   * 席が出たままなら一覧にし、席の entry を一覧の物に置き換える
   */
  function leaveHandSeat() {
    if (S.active !== null) {
      S.active = null;
      S.view2 = "talk";
      SA.topics.setCurrent(null);
      if (S.view === "body") {
        setView("list");
        try {
          if (history.state && history.state.v3Body) history.replaceState({}, "", location.pathname + location.search);
        } catch {
          // 書けなくても一覧は出ている
        }
      }
      renderMain();
      SA.topics.render();
    }
    renderHandEntries();
  }

  /** document の中にあり、自分も祖先も hidden・inert でない要素か（body は焦点の戻り先にしない） */
  function shownNode(n) {
    if (!n || n === document.body || !document.contains(n)) return false;
    for (let p = n; p; p = p.parentElement) if (p.hidden || p.inert) return false;
    return true;
  }

  /** 右腕の印（あなたの番 > 未読 > 作業中 で 1 つ。見えている右腕（handSeen）には未読・作業中を出さない。作業中は右腕のチャンネルに実行中のターンが在る間） */
  function handMark() {
    const data = SA.topics.data();
    const hand = data && data.rightHands[0];
    if (!hand) return null;
    if (hand.turn) return "turn";
    if (!handSeen() && SA.store.isUnread({ id: handChannelId(), last: hand.last })) return "unread";
    if (!handSeen() && SA.store.runningOf(handChannelId()) !== null) return "running";
    return null;
  }

  /** 右腕の印が変わり得るとき: 一覧（「探す」の板）の右腕の行に渡す見えている右腕（変われば一覧を描き直す）・下のバーの［あなたの番］の未読の点（毎回。件数は印と別に変わる）と、見出しの状態（席の右腕の あなたの番・作業中） */
  function renderHandEntries() {
    if (SA.topics.setSeen(handSeen() ? [handTab()] : [])) SA.topics.render();
    renderBottom(handMark());
    renderBar();
  }

  /** 最後の syncHand が見た右腕のタブ（右腕のチャンネルが替わった・無くなったかを比べる。#514） */
  let lastHandTab = null;

  /**
   * 話題の一覧を読むたびに: 右腕が替わっていたら席の前の右腕をやめ、席の右腕は一覧より先に開いた（hash）・札の中身が変わったら席の側を描き直し、印を描く（#514）
   */
  function syncHand() {
    const tab = handTab();
    // 席に右腕を開いた後で右腕のチャンネルが替わった・無くなった: 席の右腕をやめ、席を空にする（前の右腕を普通の会話の枠で描かない）
    if (lastHandTab !== null && lastHandTab !== tab && S.active === lastHandTab) leaveHandSeat();
    lastHandTab = tab;
    if (handSeated() && (!edHand || handCardSig !== cardSig())) refresh(tab);
    renderHandEntries();
  }

  // ===== 札（右腕の返事の <#ID> を話題の行で引いて、吹き出しの下に 1 行ずつ。右腕の会話にだけ出す） =====
  /** 返事の <#ID> を出た順に、同じものは 1 つ、先頭 5 つ（先頭が 0 の数字は ID として扱わない。namedText と同じ形） */
  function cardIds(text) {
    const ids = [];
    for (const m of String(text || "").matchAll(/<#([1-9]\d*)>/g)) {
      if (!ids.includes(m[1])) ids.push(m[1]);
      if (ids.length === 5) break;
    }
    return ids;
  }

  /** 札の中身（一覧の話題か、一覧から外れた（完了した）セッション）。引けなければ null */
  function cardParts(id) {
    const t = SA.topics.find("ch:" + id);
    if (t) {
      const state = t.mark === "turn" ? "あなたの番" : t.mark === "running" ? "作業中" : SA.chat.STATE_LABEL[t.state] || null;
      return { id: t.id, title: t.title, place: placeText(t), state };
    }
    const ch = SA.chat.channelById(id);
    if (ch && ch.kind === "session") return { id: "ch:" + id, title: SA.chat.channelTitle(ch), place: null, state: SA.chat.STATE_LABEL[ch.state] || null };
    return null;
  }

  function cardSig() {
    return JSON.stringify(handCardIds.map(cardParts));
  }

  /** 返事の札のデータ（{ id, title, meta }。meta は場所・状態を「・」で。引けた物だけ）。引いた <#ID> を覚える（一覧が変われば描き直す）。投げたら札を出さない */
  function handRefs(text) {
    try {
      const refs = [];
      for (const id of cardIds(text)) {
        if (!handCardIds.includes(id)) handCardIds.push(id);
        const p = cardParts(id);
        if (p) refs.push({ id: p.id, title: p.title, meta: [p.place, p.state].filter(Boolean).join("・") });
      }
      return refs;
    } catch {
      // 本文・ID は出さない（1 つの返事の札が出ないだけにする）
      console.warn("[web] hand refs failed");
      return [];
    }
  }

  /** 返事の吹き出しの下に足す札（題名・場所・状態・[開く]。古い描き方） */
  function handCards(text) {
    return handRefs(text).map((r) => {
      const open = el("button", { class: "btn btn-ghost btn-sm", type: "button", "aria-label": r.title + " を開く", text: "開く" });
      open.addEventListener("click", () => SA.app.open(r.id));
      // 場所も状態も引けなければ meta の span を作らない
      const parts = [el("span", { class: "v3-card-title", text: r.title }), r.meta ? el("span", { class: "v3-card-meta", text: r.meta }) : null, open].filter(Boolean);
      return el("div", { class: "v3-card", "data-topic": r.id }, parts);
    });
  }

  /** 返事の本文の <#ID> のうち引けたものを「<題名>」に（引けないもの・先頭が 0 の数字はそのまま） */
  function namedText(text) {
    if (typeof text !== "string") return text;
    return text.replace(/<#([1-9]\d*)>/g, (all, id) => {
      const p = cardParts(id);
      return p ? "「" + p.title + "」" : all;
    });
  }

  /** 知らせ（統括のまとめ）の <#ID> を名前に。出た ID は全部覚える（一覧が変われば描き直す。札は部品の道の noticeRefs）。投げたら元の文 */
  function handNoticeText(text) {
    if (typeof text !== "string") return text;
    try {
      for (const m of text.matchAll(/<#([1-9]\d*)>/g)) {
        if (!handCardIds.includes(m[1])) handCardIds.push(m[1]);
      }
      return namedText(text);
    } catch {
      console.warn("[web] hand notice failed");
      return text;
    }
  }

  // ===== hash（#/ch/<id>・#/cc/<id>・#/tasks。古い殻と同じ形） =====
  function hashOf(tabId) {
    return "#/" + tabId.replace(":", "/");
  }

  function tabFromHash(hash) {
    const path = String(hash || "").replace(/^#\/?/, "");
    if (path === "") return null;
    const slash = path.indexOf("/");
    return slash > 0 ? path.slice(0, slash) + ":" + path.slice(slash + 1) : path;
  }

  function writeHash() {
    // 起動の hash の話題を待っている間は消さない
    if (S.active === null && deferred !== null) return;
    try {
      // 履歴の印（v3Body）は残す
      if (S.active) history.replaceState(history.state, "", hashOf(S.active));
      else history.replaceState(history.state, "", location.pathname + location.search);
    } catch {
      // hash を書けなくても画面は動く
    }
  }

  // 起動の hash のタブで、まだ開けないもの（/api/status を待つ github・devlog・cc: など）。status と最初の一覧の後に試し、それでも開けなければ捨てる
  let deferred = null;
  let topicsLoaded = false;

  // 押した行（cc:）も待つので、ほかの話題が開いていても試す（その後に何かを開けば open が deferred を消す）
  function reopenDeferred() {
    if (deferred === null) return;
    if (SA.views.info(deferred)) {
      open(deferred);
      return;
    }
    if (SA.store.status !== null && topicsLoaded) {
      deferred = null;
      writeHash();
    }
  }

  // ===== スマホの一覧 ⇄ 会話・流れの列の席の開閉（履歴: 会話は v3Body の entry。戻ると一覧・席を閉じる） =====
  function setView(view) {
    const wasHidden = mainHidden();
    const scroll = $("ed").querySelector(".ed-scroll");
    // 隠す前に読む（隠した後は読めない）
    const before = !wasHidden && scroll ? { top: scroll.scrollTop, bottom: atBottom(scroll) } : null;
    S.view = view;
    refs.v3.setAttribute("data-view", view);
    // 流れの列は席の開閉で見える列の数が変わる（隠れ方は S.view と幅で決まるので、ここで書いても下の判定は変わらない）
    fitDeck();
    const hidden = mainHidden();
    if (wasHidden === hidden) return;
    // 席の住人が右腕なら、隠れた・出たで見えているか（handSeen）が変わる: 下のバーの未読の点と見出しを描き直す（#514）
    if (handSeated()) renderHandEntries();
    if (hidden) {
      hiddenScroll = before;
      stickOnShow = false;
      return;
    }
    if (scroll && hiddenScroll) {
      if (stickOnShow) scroll.scrollTop = scroll.scrollHeight;
      else if (!hiddenScroll.bottom) scroll.scrollTop = hiddenScroll.top;
    }
    hiddenScroll = null;
    stickOnShow = false;
    // 隠れていた間に来た行を既読にする（readingChannelIds に入った）
    SA.chat.markSeenShown();
  }

  /** 席が開くとき・留めた列が出るときの動き（shell.css の [data-moves="on"]。D5 の PR-1・#507 の P5）は最初の操作（pointerdown か keydown）の後だけ。読み込みで開いた席（hash）は動かさない。付けた後は外さない */
  function movesOn() {
    refs.v3.setAttribute("data-moves", "on");
  }

  function showBody() {
    setView("body");
    const hash = S.active ? hashOf(S.active) : location.pathname + location.search;
    try {
      if (history.state && history.state.v3Body) history.replaceState(history.state, "", hash);
      // スマホの「探す」の板の entry も話題に置き換える（戻ると列）
      // スレッドの上で開いた板（Ctrl+K）なら、下の話題の entry も越えて列まで戻れるよう段数を 1 つ上にする
      else if (history.state && history.state.v3Find) history.replaceState(history.state.v3Depth ? { v3Body: true, v3Depth: history.state.v3Depth + 1 } : { v3Body: true }, "", hash);
      else history.pushState({ v3Body: true }, "", hash);
    } catch {
      // 積めなくても [‹] で一覧に戻れる
    }
  }

  /** 一覧に戻ったら、開いていた話題の行に焦点（一覧の位置は動かさない。群の中の行を先に探すのは入口 c-app.js） */
  function focusCurrentRow() {
    if (!S.active) return;
    if (SA.list) SA.list.focusRow(S.active);
  }

  /** 履歴の entry から一覧までの段数（会話の entry は v3Depth、無ければ 1。一覧は 0） */
  function depthOf(state) {
    return state && state.v3Body ? state.v3Depth || 1 : 0;
  }

  /** 「探す」の板の entry の下から列までの段数（スレッドの上で開いた板だけ。列の上の板は 0） */
  function underFind(state) {
    return state && state.v3Find ? state.v3Depth || 0 : 0;
  }

  function showList() {
    // 進むで戻ってきた板の entry（スレッドの上。板は閉じたまま）からは、下のスレッドの entry も越えて列まで戻る
    if (underFind(history.state) > 0) {
      try {
        history.go(-(underFind(history.state) + 1));
        return;
      } catch {
        // 戻れなければその場で一覧にする
      }
    }
    if (history.state && history.state.v3Body) {
      try {
        // popstate で一覧にする（札で開いた話題は、その下の話題の entry も越えて一覧まで戻る）
        const depth = depthOf(history.state);
        if (depth > 1) history.go(-depth);
        else history.back();
        return;
      } catch {
        // 戻れなければその場で一覧にする
      }
    }
    setView("list");
    if (deckOn()) focusSeatFrom();
    else focusCurrentRow();
  }

  function openDrawer() {
    if (phone()) showList();
    else if (SA.list) SA.list.focusList();
  }

  function closeDrawer() {
    if (phone() && S.active !== null) showBody();
  }

  function sidebarShows(id) {
    return id === "chat" && (!phone() || S.view === "list");
  }

  // ===== シート（見出しの […] のチャンネルの操作など。≤639px では app.css が dialog を下からのシートにする） =====
  /** 閉じた後に焦点を戻すボタン（行を選んで閉じたときは戻さない。焦点は開いた先が決める） */
  let sheetOpener = null;

  /**
   * items は { icon, label, run?, href?, why? }: href は新しいタブで開くリンク、run が無ければ押せない行で why を右に出す。opener は閉じた後に焦点を戻すボタン
   */
  function openSheet(label, items, opener) {
    const dialog = $("v3-sheet");
    const chosen = () => {
      sheetOpener = null;
      closeDialog(dialog);
    };
    const rows = items.map((it) => {
      let row;
      if (it.href) {
        row = el("a", { class: "more-row", href: it.href, target: "_blank", rel: "noreferrer noopener" }, [icon(it.icon || "external-link"), el("span", { class: "sb-label", text: it.label })]);
        row.addEventListener("click", chosen);
      } else {
        row = el("button", { class: "more-row", type: "button", disabled: !it.run }, [
          icon(it.icon || "circle"),
          el("span", { class: "sb-label", text: it.label }),
          !it.run && it.why ? el("span", { class: "sb-meta", text: it.why }) : null,
        ]);
        if (it.run) {
          row.addEventListener("click", () => {
            chosen();
            it.run();
          });
        }
      }
      return el("li", {}, [row]);
    });
    sheetOpener = opener || null;
    dialog.setAttribute("aria-label", label);
    // 題と ×（閉じ方を見せる。古い殻の sheetHead と同じ）
    const close = el("button", { class: "btn btn-ghost btn-sm btn-icon-sm sheet-close", type: "button", "aria-label": "閉じる" }, [icon("x")]);
    close.addEventListener("click", () => closeDialog(dialog));
    dialog.replaceChildren(el("div", { class: "sheet-head" }, [el("span", { class: "sheet-title", text: label }), close]), el("ul", { class: "more-list" }, rows));
    openDialog(dialog);
    // 最初の焦点は押せる最初の行（× ではなく）
    const first = dialog.querySelector(".more-row:not([disabled])");
    if (first) first.focus();
  }

  // ===== 話題を始める（群の見出しの [+] → #v3-start → POST /api/topics。docs/plan/web-ui-v3.md §2・§5） =====
  const START_SET_UP = "設定が済んでいません。端末で npm run unify-setup -- --print の行を実行して再起動してください";
  const START_EMPTY = "最初の一言か題名を入れてください";
  /** 始められなかったときの文（応答の error ごと。too_long は field で分ける） */
  const START_ERRORS = {
    empty: START_EMPTY,
    invalid_project: "そのプロジェクトは使えません",
    cc_disabled: "プロジェクトで始めるには Claude Code の連携が要ります",
    unify_not_ready: START_SET_UP,
    not_set_up: "先に Discord で /setup を実行してください",
    bot_disconnected: "Discord につながっていません。少し待ってからもう一度試してください",
  };
  // 開くたびに 1 増える番号・送っている開きの番号（0 は送っていない）・開いているか。
  // 応答が返ったとき、送った開きのままでなければダイアログに触らない（閉じた・開き直した後の応答は toast で知らせる）
  let startSeq = 0;
  let startBusy = 0;
  let startShown = false;
  // 閉じた後に焦点を戻す [+]・話題を開くために閉じたか（そのときは焦点を戻さない）
  let startOpener = null;
  let startOpened = false;

  /** 場所の候補（General を先頭に、プロジェクトをサーバーの順のまま）。一覧をまだ読めていなければ General だけ */
  function startPlaces() {
    const data = SA.topics.data();
    if (!data) return [{ key: "general", name: "General" }];
    const general = data.groups.filter((g) => g.kind === "general").slice(0, 1);
    const projects = data.groups.filter((g) => g.kind === "project");
    const places = general.concat(projects).map((g) => ({ key: g.key, name: g.name }));
    return general.length > 0 ? places : [{ key: "general", name: "General" }].concat(places);
  }

  /** 場所ごとの 1 行。状態（/api/status の cc）がまだ無ければ連携が有効なときと同じ文 */
  function startHint(place) {
    const status = SA.store.status;
    const cc = status && status.cc ? status.cc : null;
    if (place === "general") {
      if (cc && (cc.enabled !== true || cc.unifyReady === false)) return "Discord にチャンネルができます。Claude Code の連携が使えないので、場所なしの話題として始めます。";
      return "Discord にチャンネルができます。";
    }
    if (cc && cc.enabled !== true) return "プロジェクトで始めるには Claude Code の連携が要ります。";
    if (cc && cc.unifyReady === false) return START_SET_UP;
    const hit = startPlaces().find((p) => p.key === place);
    return "Discord にチャンネルができます。" + (hit ? hit.name : place.replace(/^p:/, "")) + " の中で作業します。";
  }

  function showStartHint() {
    $("v3-start-hint").textContent = startHint($("v3-start-place").value || "general");
  }

  /** エラーの欄（role=alert）。text が null なら隠す。field はその欄に aria-invalid を付ける入力欄の id */
  function startError(text, field) {
    const box = $("v3-start-error");
    box.textContent = text === null ? "" : text;
    box.hidden = text === null;
    for (const id of ["v3-start-text", "v3-start-name"]) {
      if (id === field) $(id).setAttribute("aria-invalid", "true");
      else $(id).removeAttribute("aria-invalid");
    }
  }

  /** ダイアログを開く（場所は place が候補にあればそれ、無ければ General）。焦点は最初の一言 */
  function openStart(place, opener) {
    const dialog = $("v3-start");
    if (!dialog) return;
    const places = startPlaces();
    const select = $("v3-start-place");
    select.replaceChildren(...places.map((p) => el("option", { value: p.key, text: p.name })));
    select.value = places.some((p) => p.key === place) ? place : "general";
    $("v3-start-text").value = "";
    $("v3-start-name").value = "";
    startError(null, null);
    // 新しい開き。前の開きの送信がまだ返っていなくても [始める] は押せる
    startSeq++;
    $("v3-start-ok").disabled = false;
    showStartHint();
    startOpener = opener || null;
    startOpened = false;
    openDialog(dialog);
    startShown = true;
    $("v3-start-text").focus();
  }

  function startFailure(err) {
    const code = err && err.code;
    if (code === "too_long") {
      const field = err.data && err.data.field;
      if (field === "title") return { text: "題名は 100 字までです", field: "v3-start-name" };
      return { text: "最初の一言は 1,900 字までです", field: "v3-start-text" };
    }
    if (code === "empty") return { text: START_EMPTY, field: "v3-start-text" };
    if (typeof code === "string" && Object.prototype.hasOwnProperty.call(START_ERRORS, code)) return { text: START_ERRORS[code], field: null };
    if (err && err.status === 0) return { text: "サーバーにつながりません", field: null };
    return { text: "始められませんでした。もう一度試してください", field: null };
  }

  /** 送る（同じ開きで送っている最中は何もしない。空の題名・一言は欄ごと送らない） */
  async function submitStart() {
    const seq = startSeq;
    if (startBusy === seq) return;
    const place = $("v3-start-place").value || "general";
    const rawText = $("v3-start-text").value;
    const title = $("v3-start-name").value.trim();
    const text = rawText.trim();
    if (title === "" && text === "") {
      startError(START_EMPTY, "v3-start-text");
      $("v3-start-text").focus();
      return;
    }
    startError(null, null);
    const body = { place };
    if (title !== "") body.title = title;
    if (text !== "") body.text = text;
    startBusy = seq;
    $("v3-start-ok").disabled = true;
    let data;
    let failed = null;
    try {
      data = await SA.api.post("/api/topics", body, { quiet: true });
    } catch (err) {
      failed = err || {};
    }
    // 送った開きのままか（閉じた・開き直したなら、ダイアログ・欄・[始める]・エラーの欄に触らない）
    const current = seq === startSeq && startShown;
    if (startBusy === seq) startBusy = 0;
    if (failed) {
      const failure = startFailure(failed);
      if (!current) {
        SA.ui.toast(failure.text, null, { level: "error" });
        return;
      }
      $("v3-start-ok").disabled = false;
      startError(failure.text, failure.field);
      return;
    }
    if (current) {
      $("v3-start-ok").disabled = false;
      startOpened = true;
      closeDialog($("v3-start"));
    }
    const name = data && typeof data.title === "string" ? data.title : title;
    if (data && data.turn === "failed" && typeof data.channelId === "string") {
      setDraft(data.channelId, rawText);
      SA.ui.toast("話題「" + name + "」を始めました。最初の一言は送れなかったので、入力欄に戻しました");
    } else SA.ui.toast("話題「" + name + "」を始めました");
    SA.topics.load();
    // 閉じた・開き直した後なら話題へは移らない（オーナーはもう別の事をしている）
    if (current && data && typeof data.id === "string") open(data.id);
  }

  function bindStart() {
    const dialog = $("v3-start");
    if (!dialog) return;
    $("v3-start-form").addEventListener("submit", (e) => {
      e.preventDefault();
      submitStart();
    });
    $("v3-start-cancel").addEventListener("click", () => closeDialog(dialog));
    $("v3-start-place").addEventListener("change", showStartHint);
    // 最初の一言の中の Ctrl+Enter・⌘+Enter で送る（ただの Enter は改行。変換の確定中は何もしない）
    $("v3-start-text").addEventListener("keydown", (e) => {
      if (e.isComposing || e.keyCode === 229) return;
      if ((e.ctrlKey || e.metaKey) && e.key === "Enter") {
        e.preventDefault();
        submitStart();
      }
    });
    dialog.addEventListener("close", () => {
      startShown = false;
      const opener = startOpener;
      const opened = startOpened;
      startOpener = null;
      startOpened = false;
      if (!opened && opener && document.contains(opener)) opener.focus();
    });
  }

  // ===== 場所を変える（列 2 の見出しの場所のボタンか「…」の板 → シート → 確認 → POST /api/topics/ch:<id>/place。docs/plan/web-ui-v3.md §6.3 の M5） =====
  // 断りの文（応答の error ごと）。サーバーの moveRefusalText（src/app/topic-move.ts の REFUSAL_TEXT）と同じ文。片方を直したらもう片方も直す
  const PLACE_ERRORS = {
    busy: "担当が作業中です。終わってから変えてください",
    closing: "閉じる途中です。終わってから変えてください",
    moving: "場所を変えています。終わるまで待ってください",
    closed: "完了した話題は場所を変えられません",
    persona: "足した人格の話題は場所を変えられません",
    cc_disabled: "場所を変えるには Claude Code の連携が要ります",
    unify_not_ready: START_SET_UP,
    invalid_project: "その場所は使えません",
    bad_request: "その場所は使えません",
    same_place: "もうその場所です",
    not_found: "この話題は場所を変えられません",
  };
  // 送っている話題の id。応答は toast と一覧の読み直しだけで、帯・シート・確認には触らない（返る前に別の話題を開いても壊さない）
  const placeBusy = new Set();

  /** 今の場所の key（startPlaces の key と比べる）。場所なし・ほかの場所は null */
  function placeKey(t) {
    if (t.group === "other") return null;
    if (t.group === "general") return t.place && t.place.dir ? "general" : null;
    return t.group;
  }

  /** シートに場所の候補を並べる（今の場所は押せない行）。今の話題が無い・変えられない話題なら何もしない */
  function openPlace(opener) {
    const t = S.active ? SA.topics.find(S.active) : null;
    if (!t || t.movable !== true) return;
    const now = placeKey(t);
    const items = startPlaces().map((p) =>
      p.key === now ? { icon: "check", label: p.name, why: "今の場所" } : { icon: "circle", label: p.name, run: () => confirmPlace(t.id, p) },
    );
    openSheet("場所を変える", items, opener);
  }

  /** 確認。閉じたら（[変える]・[やめる]・Escape）見出しの場所のボタン（スマホは「…」）に焦点を戻す */
  function confirmPlace(id, place) {
    const t = SA.topics.find(id);
    if (!t) return;
    const body =
      t.place && t.place.dir
        ? "場所を " + placeText(t) + " から " + place.name + " に変えます。ファイルは動かしません。会話の記録はこのまま残り、担当には要点を引き継ぎます。あとで戻せます"
        : "場所を なし から " + place.name + " に変えます。会話の記録はこのまま残り、担当には要点を引き継ぎます。場所なしには戻せません";
    SA.ui.confirm({
      title: "場所を変えますか",
      target: t.title,
      body,
      ok: "変える",
      run: () => submitPlace(id, place),
      closed: () => {
        if (SA.top) SA.top.focus("place") || SA.top.focus("menu");
      },
    });
  }

  function placeFailure(err) {
    const code = err && err.code;
    if (typeof code === "string" && Object.prototype.hasOwnProperty.call(PLACE_ERRORS, code)) return PLACE_ERRORS[code];
    if (err && err.status === 0) return "サーバーにつながりません";
    return "場所を変えられませんでした。もう一度試してください";
  }

  /** 送る（同じ話題に送っている最中は何もしない）。id（ch:<channelId>）は encode しない（%3A ではルートに当たらない） */
  async function submitPlace(id, place) {
    if (placeBusy.has(id)) return;
    placeBusy.add(id);
    let failed = null;
    try {
      await SA.api.post("/api/topics/" + id + "/place", { place: place.key }, { quiet: true });
    } catch (err) {
      failed = err || {};
    }
    placeBusy.delete(id);
    if (failed) {
      SA.ui.toast(placeFailure(failed), null, { level: "error" });
      return;
    }
    // 受け付けただけ。結果は一覧の place・movable と履歴の仕切りで見せる
    SA.ui.toast("場所を " + place.name + " に変えています。要点をまとめるので少しかかります");
    SA.topics.load();
  }

  // ===== 許可のモード（列 2 の見出しのモードのボタンか「…」の板 → シート → POST /api/topics/ch:<id>/mode。プロジェクトのセッションだけ） =====
  // 選べるモードと板の文。サーバーの MODE_LABELS（src/app/session-mode.ts）と views.js の PERMISSION_MODES と同じ文。片方を直したらもう片方も直す
  const MODE_ROWS = [
    ["default", "default（使うたびに確認）"],
    ["acceptEdits", "acceptEdits（編集は確認なし）"],
    ["plan", "plan（計画だけ）"],
  ];
  const MODE_BUSY = "担当が作業中です。終わってから変えてください";
  /** モードを変えられない間（サーバーの busy と同じ向き）: 作業中と、許可の要求・質問の待ち（ターンは実行中）。判断待ち・確認は変えられる */
  function modeBusy(t) {
    if (!t) return false;
    if (t.mark === "running") return true;
    return !!t.turn && (t.turn.kind === "permission" || t.turn.kind === "question");
  }

  /** シートに 3 つのモードを並べる（今のモードは押せない行）。今の話題がプロジェクトのセッションでなければ何もしない */
  function openMode(opener) {
    const t = S.active ? SA.topics.find(S.active) : null;
    const head = topHead();
    if (!t || !head || !head.mode) return;
    const now = head.mode;
    const id = t.id;
    const rows = MODE_ROWS.map(([value, label]) =>
      value === now ? { icon: "check", label, run: null, why: "今のモード" } : { icon: "circle", label, run: () => setMode(id, value) },
    );
    openSheet("許可のモード", rows, opener);
  }

  /** 送る。id（ch:<channelId>）は encode しない（%3A ではルートに当たらない）。成功したら一覧を読み直して見出しを描き直す */
  async function setMode(id, value) {
    try {
      await SA.api.post("/api/topics/" + id + "/mode", { mode: value }, { quiet: true });
    } catch (err) {
      const code = err && err.status === 409 ? err.code : null;
      if (code === "busy") SA.ui.toast(MODE_BUSY, null, { level: "error" });
      else if (code === "closed") SA.ui.toast("閉じています", null, { level: "error" });
      else if (code === "not_project") SA.ui.toast("このセッションに許可のモードはありません。", null, { level: "error" });
      else SA.ui.toast(err && typeof err.toast === "string" ? err.toast : "サーバーにつながりません", null, { level: "error", retry: () => setMode(id, value) });
      return;
    }
    // 帯に見えない形（スマホ・compact）だけ知らせる
    if (topNarrow()) SA.ui.toast("許可のモードを " + value + " にしました");
    SA.topics.load();
    // モードは会話の一覧（/api/channels の projectDir）から引くので、それも読み直してから描き直す
    try {
      await SA.store.load.channels({ quiet: true });
    } catch {
      // 読めなければ次の polling で直る
    }
    renderBar();
  }

  /**
   * 留める・外す（#507）。id（ch:<channelId>）は encode しない。成功したら pins を取り込み（setPins の refreshTabs が見出しの「…」の行の語も描き直す）、知らせて一覧を読み直す。
   * 上限（409）・引けない（404）は知らせの後に読み直す（画面の pins が古い）。つながらない時は読み直さない。成功したら true
   */
  async function setPin(id, on) {
    let res;
    try {
      res = await SA.api.post("/api/topics/" + id + "/pin", { on }, { quiet: true });
    } catch (err) {
      const code = err && err.status === 409 ? err.code : null;
      if (code === "pin_limit") {
        const max = err.data && typeof err.data.max === "number" ? err.data.max : SA.topics.pinMax();
        SA.ui.toast(pinLimitText(max), null, { level: "error" });
        // 画面の pins が古いので読み直す
        SA.topics.load();
      } else if (err && err.status === 404) {
        SA.ui.toast("この話題はピン留めできません", null, { level: "error" });
        SA.topics.load();
      } else SA.ui.toast(err && typeof err.toast === "string" ? err.toast : "サーバーにつながりません", null, { level: "error", retry: () => setPin(id, on) });
      return false;
    }
    // 帯の列は setPins の refreshTabs が合わせる（pins が変わった時に fitDeck を通る。同じ値なら合わせる物が無い）
    SA.topics.setPins(res);
    SA.ui.toast(on ? "ピン留めした" : "ピン留めを外した");
    SA.topics.load();
    return true;
  }

  // ===== 下のバー（描くのは入口 c-app.js）と「ほか」の板 =====
  /** 「ほか」に並べる画面の順（引けるものだけ。GitHub は有効のとき・会話ログは dev のとき。スマホはタスク・リマインドを先頭に） */
  const MORE_TABS = ["knowledge", "memories", "github", "usage", "devlog", "notices", "status", "settings"];

  function openMore(opener) {
    const items = [];
    for (const id of phone() ? ["tasks", "reminders", ...MORE_TABS] : MORE_TABS) {
      const info = SA.views.info(id);
      if (info) items.push({ label: info.title, icon: info.icon, run: () => open(id) });
    }
    openSheet("ほか", items, opener);
  }

  /** 下のバーの押した先（1 回だけ作り、毎回同じ物を渡す） */
  const BAR_ON = {
    // スマホの「一覧」: 一覧の先頭へ
    list: () => SA.list.setScrollTop(0),
    tab: (id) => open(id),
    more: (opener) => openMore(opener),
  };

  /** スマホの流れの列の下のバーの押した先（1 回だけ作り、毎回同じ物を渡す） */
  const DECKBAR_ON = {
    // バーで選んだ列へすぐ送る（履歴・hash は変えない）
    page: (id) => {
      S.deckPage = id;
      SA.deck.page(id);
      renderBottom(handMark());
      if (deckFull()) renderBand();
    },
    // 指・焦点の移動で送られた列（何度来てもよい。ここから SA.deck.page を呼ばない）
    paged: (id) => {
      if (S.deckPage === id) return;
      S.deckPage = id;
      renderBottom(handMark());
      if (deckFull()) renderBand();
    },
  };

  /** 広い幅のバーに並べる画面（引けるものだけ） */
  function barTabs() {
    const tabs = [];
    for (const id of ["tasks", "reminders"]) {
      const info = SA.views.info(id);
      if (info) tabs.push({ id, title: info.title });
    }
    return tabs;
  }

  /** 下のバー（描くのは入口 c-app.js。形は入口が幅で決める）。mark は handMark() の値（スマホの流れの列の［あなたの番］の未読の点。#514）。描けなければ件数・印・タブの無い形で 1 回だけ描き直す */
  function renderBottom(mark) {
    if (deckOn()) {
      // 流れの列の間は一覧の下のバーを描かない。広い幅は行き先が上の帯なのでスマホの列の下のバーも空にする
      if (SA.list) SA.list.drawBar(null);
      if (!phone()) {
        if (typeof SA.deck.drawBar === "function") SA.deck.drawBar(null);
        return;
      }
      // スマホは列の下のバー（列 3 つ。右腕が未読なら［あなたの番］に点）。描けなければ点の無い形で 1 回だけ描き直す
      const bar = { page: S.deckPage, unread: mark === "unread", on: DECKBAR_ON };
      if (!SA.deck.drawBar(bar)) SA.deck.drawBar(Object.assign({}, bar, { unread: false }));
      return;
    }
    if (!SA.list) return;
    const ok = SA.list.drawBar({ turns: SA.topics.counts().turns, tabs: barTabs(), on: BAR_ON });
    if (!ok) SA.list.drawBar({ turns: 0, tabs: [], on: BAR_ON });
  }

  // ===== 接続の点と鈴（古い殻の renderTitleStatus と同じ中身。幅によらず画面を開く） =====
  let connSig = null;

  /** 接続の点の中身（/api/status の最初の Bot）。読めていない・Bot が無ければ null */
  function connBot() {
    const status = SA.store.status;
    const bot = status && status.bots ? status.bots[0] : null;
    return bot ? { connected: !!bot.connected, label: bot.name + " の Bot: " + (bot.connected ? "接続中" : "接続できません") } : null;
  }

  function renderConn() {
    // 流れの列は上の帯に点を出す（鈴は出さない。知らせは通知の列）
    renderBand();
    const box = refs.conn;
    if (!box) return;
    const status = SA.store.status;
    const bot = status && status.bots ? status.bots[0] : null;
    const notices = SA.store.notices;
    const botLabel = bot ? connBot().label : null;
    const bellCount = notices ? notices.recent24h : null;
    // 変わらなければ作り直さない（焦点を外さない）
    const sig = JSON.stringify([botLabel, bot ? !!bot.connected : null, bellCount]);
    if (sig === connSig) return;
    connSig = sig;
    const items = [];
    if (bot) {
      const b = el("button", { class: "btn btn-ghost btn-sm btn-icon-sm", type: "button", "aria-label": botLabel, title: botLabel }, [
        el("span", { class: "dot " + (bot.connected ? "dot-ok" : "dot-bad"), "aria-hidden": "true" }),
      ]);
      b.addEventListener("click", () => open("status"));
      items.push(b);
    }
    if (notices) {
      const label = "知らせ（直近 24 時間 " + notices.recent24h + " 件）";
      const b = el("button", { class: "btn btn-ghost btn-sm title-bell", type: "button", "aria-label": label, title: label }, [
        icon("bell"),
        notices.recent24h > 0 ? el("span", { class: "title-bell-count", text: String(notices.recent24h), "aria-hidden": "true" }) : null,
      ]);
      b.addEventListener("click", () => open("notices"));
      items.push(b);
    }
    box.replaceChildren(...items);
  }

  // ===== 絞り込み（読めている話題だけ。サーバーには訊かない） =====
  // 絞り込んでいるか・始める前の一覧の位置（消したら戻す）
  let filterOn = false;
  let filterTop = null;

  function searchInput() {
    let input = $("v3-search");
    if (!input) {
      input = el("input", {
        class: "input",
        id: "v3-search",
        type: "search",
        placeholder: "題名で絞り込む",
        "aria-label": "話題を絞り込む",
        autocomplete: "off",
        enterkeyhint: "search",
      });
      input.addEventListener("input", () => applyFilter(input.value));
      refs.searchBox.append(input);
    }
    return input;
  }

  function applyFilter(value) {
    const was = filterOn;
    filterOn = String(value || "").trim() !== "";
    if (!was && filterOn) filterTop = SA.list ? SA.list.scrollTop() : 0;
    SA.topics.setFilter(value);
    SA.topics.render();
    if (was && !filterOn && filterTop !== null) {
      if (SA.list) SA.list.setScrollTop(filterTop);
      filterTop = null;
    }
  }

  function openSearch() {
    if (!refs.searchBox) return;
    refs.searchBox.hidden = false;
    if (refs.searchToggle) refs.searchToggle.setAttribute("aria-expanded", "true");
    searchInput().focus();
  }

  function closeSearch() {
    if (!refs.searchBox) return;
    const input = $("v3-search");
    if (input && input.value !== "") {
      input.value = "";
      applyFilter("");
    }
    refs.searchBox.hidden = true;
    if (refs.searchToggle) {
      refs.searchToggle.setAttribute("aria-expanded", "false");
      refs.searchToggle.focus();
    }
  }

  function renderHeadOps() {
    const ops = $("v3-head-ops");
    if (!ops) return;
    const toggle = el("button", { class: "btn btn-ghost btn-sm btn-icon-sm", id: "v3-search-toggle", type: "button", "aria-label": "話題を絞り込む", title: "話題を絞り込む", "aria-expanded": "false" }, [
      icon("search"),
    ]);
    toggle.addEventListener("click", () => {
      if (refs.searchBox && refs.searchBox.hidden) openSearch();
      else closeSearch();
    });
    // 点と鈴は status・知らせのたびに描き直すので、入れ物を分ける（絞り込みのボタンの焦点を外さない）
    const conn = el("span", { class: "v3-conn" });
    ops.replaceChildren(toggle, conn);
    refs.searchToggle = toggle;
    refs.conn = conn;
  }

  // ===== 流れの列（入口 SA.deck が在るとき。docs/plan/web-ui-deck.md の D1・D2）: 上の帯・3 つの列・席・「探す」の板。スマホは 1 列ずつの横送りと下のバー =====
  /**
   * 幅と席の開閉から見える列の数と席の形を決めて #v3 に書く（data-deck・data-seat・data-find）。変わったら列・帯・下のバー・見出しを描き直す。
   * スマホは列 1・席 full（スレッドは列の上に重ねる）で、描き直したら今の列へ送る。
   * 流れの列でなくなったら（入口が無い）属性を消し、板を閉じ、下のバーを戻す。呼ぶのは起動・resize・スマホの境・setView
   */
  function fitDeck() {
    const v3 = refs.v3;
    if (!v3) return;
    if (!deckOn()) {
      if (S.deckCols === null) return;
      S.deckPins = false;
      applyPins({ show: false });
      closeFind(false);
      for (const name of ["data-deck", "data-seat", "data-find"]) v3.removeAttribute(name);
      applyInert();
      S.deckCols = null;
      S.deckCurrent = null;
      renderBottom(handMark());
      return;
    }
    // 幅の判定は phone() だけ（スマホは deckFit を使わず 1 列）
    const full = phone();
    // 留めた話題が席に開いたまま帯が出るなら、列を描く前に席を閉じる（#507。同じチャンネルを 2 か所に描かない）。
    // 焦点が席の中に在れば（ほかの端末で留められた時など）、列を描いた後にその列の入力欄へ移す（席のピンのボタンから留めた時は pinSeat がピンのボタンへ移すので移さない）
    let refocus = null;
    if (!full && pinnedSeat()) {
      const main = $("v3-main");
      if (!seatPinning && main && main.contains(document.activeElement)) refocus = S.active.slice(3);
      leavePinnedSeat();
    }
    const fit = full ? { cols: 1, side: false } : SA.deck.fit(v3.clientWidth, S.view === "body");
    const seat = full ? "full" : fit.side ? "side" : "fold";
    const current = S.view === "body" ? S.active : null;
    const first = S.deckCols === null;
    const wasFull = v3.getAttribute("data-seat") === "full";
    let changed = first || S.deckCols !== fit.cols || S.deckCurrent !== current || v3.getAttribute("data-seat") !== seat;
    v3.setAttribute("data-deck", String(fit.cols));
    v3.setAttribute("data-seat", seat);
    if (first) v3.setAttribute("data-find", "closed");
    // 初めて流れの列になったときに、列のタスク・リマインドを polling に足して読む（スマホでも。中は 1 回だけ）
    if (first && SA.flows) SA.flows.init();
    // 留めた話題の会話の列（#507）。帯を出す・やめるが替わったら流れの列も描き直す
    const pins = full ? { show: false } : pinFit(S.view === "body");
    if ((pins.show === true) !== S.deckPins) changed = true;
    S.deckPins = pins.show === true;
    if (!changed) {
      applyPins(pins);
      measurePins();
      if (refocus !== null) SA.pins.jump(refocus, "composer");
      syncBandTurn();
      return;
    }
    S.deckCols = fit.cols;
    S.deckCurrent = current;
    // 帯をやめるときは先に帯を片付ける。出すときは流れの列を帯の形（strip）で描いた後に帯にする（帯が送りの止まる所を決める時に、流れの列がもう帯の幅で並んでいるように）
    if (!S.deckPins) applyPins(pins);
    if (SA.flows) {
      // 帯の間だけ strip を渡す（帯でなければ鍵を足さない）
      SA.flows.setView(Object.assign({ cols: fit.cols, current, paged: full }, S.deckPins ? { strip: true } : {}));
      SA.flows.render();
    }
    if (S.deckPins) applyPins(pins);
    renderBand();
    // スマホと広い幅をまたいだら下のバーを描き直す（スマホは列の下のバー、広い幅は空）
    if (first || wasFull !== full) renderBottom(handMark());
    fitTop();
    // 列を描き直した後に今の列へ送る（列の入れ物が幅 0 の間は入口が何もしない）
    if (full) SA.deck.page(S.deckPage);
    measurePins();
    if (refocus !== null) SA.pins.jump(refocus, "composer");
    // 帯が出る・やめる・列の数が変わると番の列の見え方が変わる（上の帯の「あなたの番 n」）
    syncBandTurn();
  }

  /** 列を今の値で描き直す（流れの列の間だけ） */
  function renderFlows() {
    if (SA.flows && deckOn()) SA.flows.render();
  }

  // ===== 留めた話題の会話の列（#507。docs/plan/web-ui-pins.md §4.1〜§4.3。状態と描き出しは pins.js） =====
  /** pins.js に渡す押した先（1 回だけ作り、毎回同じ物を渡す）。seen は見えている列が替わった時（節「ピン留め」の行の線） */
  const PINS_ON = {
    seen: () => renderFlows(),
    menu: (channelId, opener) => openPinMenu(channelId, opener),
    pin: (channelId) => unpinColumn(channelId),
  };

  /** 留めた列の見出しの「…」の板: 「ピン留めを外す」と、チャンネルの操作（chat.js の head の menu。席の「…」と同じ順）。場所・許可のモードは出さない */
  function openPinMenu(channelId, opener) {
    const head = SA.chat.head ? SA.chat.head(channelId) : null;
    const t = SA.topics.find("ch:" + channelId);
    const title = head && typeof head.title === "string" && head.title !== "" ? head.title : t && typeof t.title === "string" && t.title !== "" ? t.title : "会話";
    const items = [{ icon: "pin", label: "ピン留めを外す", run: () => unpinColumn(channelId) }];
    if (head) items.push(...head.menu);
    openSheet(title + " の操作", items, opener);
  }

  /** 席の話題を留めている間（応答を待つ間。fitDeck が席を閉じても入力欄へ焦点を移さない。焦点は pinSeat がピンのボタンへ） */
  let seatPinning = false;

  /**
   * 留める・外すの応答の後に焦点を移してよいか: 焦点が無い・body・文書の外・操作を始めた入れ物（box）の中の時だけ。
   * 待つ間にほかの入力欄などへ移っていたら奪わない（移った先のピンのボタンで Space・Enter が効かないように）
   */
  function focusFree(box) {
    const a = document.activeElement;
    return !a || a === document.body || a.isConnected === false || (!!box && box.contains(a));
  }

  /** 席の話題を留める: 成功したら席を閉じて（fitDeck の守り）帯の末尾の列にし、その列へ送ってピンのボタンに焦点（焦点が席の中・どこにも無い時だけ）。帯が出ない幅では留めるだけ */
  async function pinSeat(id) {
    const box = $("v3-main");
    seatPinning = true;
    let ok;
    try {
      ok = await setPin(id, true);
    } finally {
      seatPinning = false;
    }
    if (!ok) return;
    const channelId = id.slice(3);
    if (pinsShown() && SA.pins.has(channelId)) SA.pins.jump(channelId, focusFree(box) ? "pin" : null);
  }

  /** 列のピンのボタン・「…」の「ピン留めを外す」: 成功したら列を片付け（setPins の fitDeck）、焦点は 右隣の列のピンのボタン → 左隣 → 上の帯の［探す］（焦点がその列の中・どこにも無い時だけ） */
  async function unpinColumn(channelId) {
    const before = SA.pins ? SA.pins.ids() : [];
    const at = before.indexOf(channelId);
    const pinsBox = $("v3-pins");
    const box = pinsBox ? [...pinsBox.children].find((n) => n.getAttribute("data-pin") === channelId) || null : null;
    if (!(await setPin("ch:" + channelId, false))) return;
    const free = focusFree(box);
    const now = pinsShown() ? SA.pins.ids() : [];
    const right = at < 0 ? undefined : before.slice(at + 1).find((id) => now.includes(id));
    const left = at < 0 ? undefined : before.slice(0, at).reverse().find((id) => now.includes(id));
    const next = right !== undefined ? right : left;
    if (next !== undefined && SA.pins.jump(next, free ? "pin" : null)) return;
    if (free && SA.deck) SA.deck.focusBand("find");
  }

  /** 帯が出ているか（#v3 の data-pins） */
  function pinsShown() {
    return !!refs.v3 && refs.v3.getAttribute("data-pins") === "true";
  }

  /** 留めた数が 1 以上で帯が出る幅なら c-deck.js の stripFit の結果（show が true）、ほかは { show: false }。seatOpen は席が開いているか */
  function pinFit(seatOpen) {
    if (!SA.pins || !SA.deck || typeof SA.deck.stripFit !== "function" || SA.topics.pins().length === 0) return { show: false };
    return SA.deck.stripFit(refs.v3.clientWidth, seatOpen);
  }

  /** 席の住人が留めた話題（ch:）で、今の席の開閉のまま帯が出るか */
  function pinnedSeat() {
    if (!S.active || !S.active.startsWith("ch:") || !SA.pins || !SA.topics.pins().includes(S.active.slice(3))) return false;
    return pinFit(S.view === "body").show === true;
  }

  /**
   * 留めた話題を席から帯の列へ移す前に席を閉じる（#507 の守り）: 席の中の部品の根を外して空にし、席の住人を空にする。会話の状態（開いた手順など）は閉じない（列で続ける）。
   * 席が開いていれば一覧にし、今の entry を一覧の物に置き換える（syncHand と同じ）
   */
  function leavePinnedSeat() {
    const ed = $("ed");
    if (ed) {
      for (const [attr, part] of [
        ["data-talk", SA.talk],
        ["data-composer", SA.composer],
        ["data-cards", SA.cards],
      ]) {
        if (part && typeof part.drop === "function") for (const n of ed.querySelectorAll("[" + attr + "]")) part.drop(n);
      }
      ed.replaceChildren();
    }
    edTab = null;
    S.active = null;
    S.view2 = "talk";
    S.term = "card";
    SA.topics.setCurrent(null);
    if (S.view === "body") {
      setView("list");
      try {
        if (history.state && history.state.v3Body) history.replaceState({}, "", location.pathname + location.search);
      } catch {
        // 書けなくても一覧は出ている
      }
    }
    renderMain();
    SA.topics.render();
  }

  /**
   * 帯（#507）を当てる。fit は pinFit の結果: show なら #v3 に data-pins と列の幅の変数を書いて pins.js に列を合わせさせ、
   * そうでなければ書いた物を消して列を片付ける（書いていなければ何も書かない。留めた数 0 の今の形のまま）
   */
  function applyPins(fit) {
    const v3 = refs.v3;
    if (fit.show === true) {
      v3.setAttribute("data-pins", "true");
      v3.style.setProperty("--c-deck-col-w", fit.colW + "px");
      v3.style.setProperty("--c-deck-conv-w", fit.convW + "px");
      SA.pins.sync({ show: true, fit, on: PINS_ON });
    } else {
      if (v3.getAttribute("data-pins") !== null) {
        v3.removeAttribute("data-pins");
        v3.style.removeProperty("--c-deck-col-w");
        v3.style.removeProperty("--c-deck-conv-w");
        // 変数のほかに書いた物は無いので、空になった style の属性ごと外す（留めた数 0 の今の形に戻す）
        if (v3.style.length === 0) v3.removeAttribute("style");
      }
      // 帯を出していない時も sync を通す（pins.js が留めた話題を覚え、後で帯が出直した列を「新しく留めた列」と取り違えない。列が無ければほかは何もしない）
      if (SA.pins) SA.pins.sync({ show: false, fit: null, on: PINS_ON });
    }
  }

  /** 帯が出ていれば見えている列を数え直す（流れの列を描き直した後。列の位置が決まってから） */
  function measurePins() {
    if (S.deckPins && SA.pins) SA.pins.measure();
  }

  /**
   * 帯の横の送り（#507）: scroll のたびに見えている列を減らすだけ（SA.pins.moved）、止まったら（scrollend か、来なければ最後の scroll から PINS_SCROLL_MS）数え直す（SA.pins.settle）。
   * ページが見えるようになったら数え直す。wheel は取らない
   */
  const PINS_SCROLL_MS = 150;

  function bindPins() {
    const band = $("v3-deck");
    if (!band || !SA.pins) return;
    let timer = null;
    const settle = () => {
      clearTimeout(timer);
      timer = null;
      SA.pins.settle();
      syncBandTurn();
    };
    band.addEventListener(
      "scroll",
      () => {
        SA.pins.moved();
        syncBandTurn();
        clearTimeout(timer);
        timer = setTimeout(settle, PINS_SCROLL_MS);
      },
      { passive: true },
    );
    // scrollend の無いブラウザでは来ない（150ms の方で止まったとみなす）
    band.addEventListener("scrollend", settle);
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "visible") SA.pins.measure();
    });
  }

  /** 上の帯の押した先（1 回だけ作り、毎回同じ物を渡す） */
  const BAND_ON = {
    status: () => open("status"),
    find: (opener) => openFind(opener),
    start: (opener) => openStart("general", opener),
    more: (opener) => openDeckMore(opener),
    // 「あなたの番 n」（#507）: 帯を左端へすぐ送り（動かさない）、数え直して帯を描き直し、番の列の最初の押せる物へ（置けなければ［探す］）
    turn: () => {
      const band = $("v3-deck");
      if (band) band.scrollLeft = 0;
      if (SA.pins) SA.pins.settle();
      syncBandTurn();
      if (!(typeof SA.deck.focusCol === "function" && SA.deck.focusCol("turn"))) SA.deck.focusBand("find");
    },
  };

  /**
   * 上の帯（描くのは入口 c-app.js。流れの列の間だけ）。点は接続の Bot（右腕は帯に出さない。あなたの番 の列の一番上の行。#514）。スマホは今の列（page）の名前と数を題に出す
   */
  function renderBand() {
    if (!deckOn()) return;
    const bot = connBot();
    bandTurnAway = turnAway();
    SA.deck.drawBand({
      variant: phone() ? "phone" : "wide",
      conn: bot ? { tone: bot.connected ? "ok" : "bad", label: bot.label } : null,
      page: phone() ? S.deckPage : undefined,
      turnAway: bandTurnAway,
      on: BAND_ON,
    });
  }

  /** 最後に renderBand が渡した turnAway（#507。syncBandTurn が比べる） */
  let bandTurnAway = false;

  /** 番の列が帯で送られて端まで見えていないか（#507 の上の帯の「あなたの番 n」。数は入口が列の見出しと同じ所から引く）。スマホ・帯が出ていない時は false */
  function turnAway() {
    return !phone() && pinsShown() && !!SA.pins && !SA.pins.turnSeen();
  }

  /** 上の帯の turnAway が変わった時だけ帯を描き直す（帯の scroll・止まった時・fitDeck の終わり） */
  function syncBandTurn() {
    if (turnAway() !== bandTurnAway) renderBand();
  }

  /** 上の帯の歯車の「ほか」の板（引けるものだけ。会話ログは dev のとき。タスク・リマインド・GitHub・知らせは列にあるので出さない） */
  const DECK_MORE_TABS = ["knowledge", "memories", "usage", "devlog", "settings"];

  function openDeckMore(opener) {
    const items = [];
    for (const id of DECK_MORE_TABS) {
      const info = SA.views.info(id);
      if (info) items.push({ label: info.title, icon: info.icon, run: () => open(id) });
    }
    openSheet("ほか", items, opener);
  }

  // 「探す」の板を開いたボタン（閉じた後に焦点を戻す）・板の entry を戻っている途中か（popstate で閉じる）
  let findOpener = null;
  let findClosing = false;

  function findOpen() {
    return !!refs.v3 && refs.v3.getAttribute("data-find") === "open";
  }

  /**
   * 「探す」の板: 一覧（話題の一覧と絞り込み）を列の上に重ね、後ろを押せなくして、絞り込み欄に焦点。履歴は広い幅では積まず、スマホは entry を 1 つ積む（戻るで閉じる）。
   * ダイアログの間は開かない（Ctrl+K と同じ）。開いていれば絞り込み欄に焦点を戻すだけ
   */
  function openFind(opener) {
    if (!deckOn() || !refs.searchBox) return;
    if (document.querySelector("dialog[open]")) return;
    if (!findOpen()) {
      findOpener = opener || null;
      findClosing = false;
      refs.v3.setAttribute("data-find", "open");
      if (deckFull()) {
        try {
          // スレッドの上で開いたら（Ctrl+K）、下の entry から列までの段数を覚える（板の行を開いたときに showBody が使う）
          const under = depthOf(history.state);
          if (!(history.state && history.state.v3Find)) history.pushState(under > 0 ? { v3Find: true, v3Depth: under } : { v3Find: true }, "", location.href);
        } catch {
          // 積めなくても Esc・幕で閉じられる
        }
      }
      const backdrop = $("v3-find-backdrop");
      if (backdrop) backdrop.hidden = false;
      const list = $("v3-list");
      if (list) {
        list.setAttribute("role", "dialog");
        list.setAttribute("aria-modal", "true");
        list.setAttribute("aria-label", "話題を探す");
      }
      applyInert();
      // 帯の見えている列を数え直す（#507。板の下の列は readingChannelIds が既読から外す）
      if (SA.pins) SA.pins.measure();
    }
    refs.searchBox.hidden = false;
    if (refs.searchToggle) refs.searchToggle.setAttribute("aria-expanded", "true");
    searchInput().focus();
  }

  /**
   * 板を閉じる（属性を戻し、絞り込みの字を空にする）。restore なら開いたボタンへ焦点。
   * restore で今の entry が板の物（v3Find。スマホ）なら戻る（popstate で閉じる）。restore でない閉じ方（行を開く）は戻らず、entry は開いた先が置き換える
   */
  function closeFind(restore) {
    if (!findOpen()) return;
    if (restore && history.state && history.state.v3Find) {
      if (findClosing) return;
      try {
        findClosing = true;
        history.back();
        return;
      } catch {
        // 戻れなければその場で閉じる
        findClosing = false;
      }
    }
    refs.v3.setAttribute("data-find", "closed");
    const backdrop = $("v3-find-backdrop");
    if (backdrop) backdrop.hidden = true;
    const list = $("v3-list");
    if (list) {
      list.removeAttribute("role");
      list.removeAttribute("aria-modal");
      list.setAttribute("aria-label", "話題");
    }
    applyInert();
    // 帯の見えている列を数え直し、板の下で読めなかった列に既読を付け直す（#507。帯の列が見えている時だけ）
    if (SA.pins) {
      SA.pins.measure();
      if (pinsSeen().length > 0) SA.chat.markSeenShown();
    }
    const input = $("v3-search");
    if (input && input.value !== "") {
      input.value = "";
      applyFilter("");
    }
    if (refs.searchBox) refs.searchBox.hidden = true;
    if (refs.searchToggle) refs.searchToggle.setAttribute("aria-expanded", "false");
    const opener = findOpener;
    findOpener = null;
    if (restore && shownNode(opener)) opener.focus();
  }

  /** 席を閉じた後の焦点: 開いた項目 → 席に開いていた話題の項目 → 帯の［探す］ */
  function focusSeatFrom() {
    const from = S.seatFrom;
    S.seatFrom = null;
    if (!SA.deck) return;
    if (from && typeof from.key === "string" && SA.deck.focusItem(from.key)) return;
    if (S.active) {
      // #507: 節「ピン留め」へ焦点を返すのは、あなたの番の列の項目から開いた時だけ（鍵を足すたびに #505 と同じ形でスマホの列が横に送られないように）
      const fromTurnColumn = !!from && typeof from.key === "string" && ["turn:", "run:", "idle:", "pin:"].some((p) => from.key.startsWith(p));
      const prefixes = fromTurnColumn ? ["turn:", "run:", "pin:", "topic:"] : ["turn:", "run:", "topic:"];
      for (const prefix of prefixes) if (SA.deck.focusItem(prefix + S.active)) return;
    }
    SA.deck.focusBand("find");
  }

  // ===== スマホのキーボード（visualViewport。古い殻と同じ） =====
  // iOS はキーボードで layout viewport を縮めないので、見えている高さを --vvh に書いて .v3 をそれに合わせ、ずらされたページを戻す。
  // キーボードが出ている間は .is-keyboard。--kb はキーボードの高さ（シートのダイアログを上に出す）。PC では書かない
  // キーボードの判定は幅ごとの最大の見えている高さとの差で見る。--vvt は visualViewport の上のずれ
  const KEYBOARD_MIN_PX = 100;
  /** ピンチの後に scale が 1 に戻った最後の状態を拾い直すまでの時間（ms） */
  const PINCH_RECHECK_MS = 250;
  /** 幅（px）ごとの最大の見えている高さ */
  const fullHeights = new Map();
  let pinchTimer = null;

  function fitViewport() {
    const vv = window.visualViewport;
    if (!vv || !phone()) {
      root.style.removeProperty("--vvh");
      root.style.removeProperty("--kb");
      root.style.removeProperty("--vvt");
      if (refs.v3) refs.v3.classList.remove("is-keyboard");
      return;
    }
    // ピンチで拡大している間の高さはキーボードではないので書き換えず、少し後に（scale が 1 に戻っていれば）計算し直す
    clearTimeout(pinchTimer);
    if (Math.abs(vv.scale - 1) > 0.01) {
      pinchTimer = setTimeout(fitViewport, PINCH_RECHECK_MS);
      return;
    }
    const width = Math.round(vv.width);
    const full = Math.max(fullHeights.get(width) || 0, vv.height);
    fullHeights.set(width, full);
    const keyboard = vv.height < full - KEYBOARD_MIN_PX;
    const kb = Math.max(0, Math.round(window.innerHeight - vv.height - vv.offsetTop));
    root.style.setProperty("--vvh", Math.round(vv.height) + "px");
    root.style.setProperty("--kb", kb + "px");
    root.style.setProperty("--vvt", Math.round(vv.offsetTop) + "px");
    refs.v3.classList.toggle("is-keyboard", keyboard);
    if (window.scrollY !== 0) window.scrollTo(0, 0);
  }

  function bindViewport() {
    const vv = window.visualViewport;
    if (!vv) return;
    vv.addEventListener("resize", fitViewport);
    vv.addEventListener("scroll", fitViewport);
    fitViewport();
  }

  // ===== キー =====
  function typing(node) {
    return !!node && !!node.closest && !!node.closest("input, textarea, select, [contenteditable]");
  }

  function onKey(e) {
    // Ctrl+K（mac は Meta+K）: 絞り込み欄。入力欄に焦点があっても効かせる
    if ((e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey && (e.key === "k" || e.key === "K")) {
      if (document.querySelector("dialog[open]")) return;
      e.preventDefault();
      // 流れの列は「探す」の板
      if (deckOn()) openFind(document.activeElement);
      else openSearch();
      return;
    }
    if (e.key !== "Escape") return;
    // IME の変換中の Escape は変換を取り消すだけ（殻は取らない）
    if (e.isComposing || e.keyCode === 229) return;
    if (document.querySelector("dialog[open]")) return;
    // 「探す」の板は入力欄に焦点があっても閉じ、開いたボタンへ戻す
    if (findOpen()) {
      closeFind(true);
      return;
    }
    const input = $("v3-search");
    if (input && document.activeElement === input) {
      closeSearch();
      return;
    }
    if (typing(document.activeElement)) return;
    if ((phone() || deckOn()) && S.view === "body") showList();
  }

  // ===== 起動 =====
  function init() {
    refs.v3 = $("v3");
    // 一覧を描く入口（c-app.js の module）が読めなかったら、一覧の場所に 1 文と [ページを読み直す] だけを出す（下のバーの代わりは作らない。ほかは続ける）
    if (!SA.list) {
      const root = $("c-list-root");
      if (root) {
        const again = el("button", { class: "btn btn-secondary", type: "button", text: "ページを読み直す" });
        again.addEventListener("click", () => location.reload());
        root.replaceChildren(el("div", { class: "v3-empty v3-entry-missing" }, [el("p", { class: "meta", text: "一覧を表示できませんでした" }), again]));
      }
      console.error("[web] list entry missing");
    } else {
      // 最初の応答が返るまでは読み込み中を出す（data がまだ無い）
      SA.topics.render();
    }
    refs.searchBox = $("v3-search-box");

    S.theme = THEMES.includes(load("theme", "dark")) ? load("theme", "dark") : "dark";
    applyTheme();
    const drafts = loadJson("drafts");
    if (drafts && !Array.isArray(drafts)) {
      for (const [id, v] of Object.entries(drafts)) if (typeof v === "string" && v !== "") S.drafts[id] = v;
    }

    bindViewport();
    mqPhone.addEventListener("change", () => {
      // 流れの列とスマホの間は、席（会話）を出しているかをそのまま保つ。入口が無ければ今までどおり話題があれば会話
      if (SA.deck) setView(S.view);
      else setView(S.active ? "body" : "list");
      fitViewport();
      // 見出しを先に（スマホの境で形が替わる。compact はその後に測る）
      renderBar();
      fitTop();
      // 列 2 が見えるようになったときの既読（setView は切り替わった後の phone() で測るので、ここで付け直す。隠れた会話は readingChannelIds が外す）
      SA.chat.markSeenShown();
    });
    window.addEventListener("popstate", (e) => {
      const st = e.state || {};
      findClosing = false;
      // スマホの「探す」の板は履歴の v3Find に合わせて閉じる（進むでは開き直さない）
      const findClosed = findOpen() && !st.v3Find;
      if (findClosed) closeFind(true);
      // スレッドの上で開いた板の entry（進むで戻ってきた。板は開き直さない）は、下のスレッドのまま。席の住人が右腕でも話題と同じ（住人は残す。#514）
      if ((st.v3Body || underFind(st) > 0) && S.active) setView("body");
      else {
        setView("list");
        // 一覧の行（流れの列では席を開いた元）への焦点は板が関わらなかったときだけ（閉じたなら開いたボタンへ戻す）
        if (!findClosed) {
          if (deckOn()) focusSeatFrom();
          else if (phone()) focusCurrentRow();
        }
      }
    });
    // 流れの列の数と席の形を先に（見出しの compact はその後に測る）
    window.addEventListener("resize", fitDeck);
    // 席の形が決まった後に測る（登録の順に呼ばれる）
    window.addEventListener("resize", fitTop);
    // 手で書き換えた hash・リンク（自分で書いた hash は replaceState・pushState なので来ない）
    window.addEventListener("hashchange", () => {
      const tabId = tabFromHash(location.hash);
      if (tabId && tabId !== S.active && (SA.views.info(tabId) || oldPage(tabId) !== null)) open(tabId);
    });
    document.addEventListener("keydown", onKey);
    // 押した物の受け口より先に（capture）、1 回だけ
    for (const type of ["pointerdown", "keydown"]) document.addEventListener(type, movesOn, { capture: true, once: true });
    const findBackdrop = $("v3-find-backdrop");
    if (findBackdrop) findBackdrop.addEventListener("click", () => closeFind(true));
    renderHeadOps();
    renderConn();
    renderBottom(handMark());
    bindStart();
    bindPins();
    $("v3-sheet").addEventListener("close", () => {
      // 閉じてすぐ同じ板を開き直したとき、後から届いた close が新しい opener を消さない
      if ($("v3-sheet").open) return;
      const opener = sheetOpener;
      sheetOpener = null;
      if (opener && document.contains(opener)) opener.focus();
      // 開いている間は測らないので、閉じた所で測る（opener に戻した後。compact に替わって消えたら入口が「…」へ）
      fitTop();
    });

    // 最初の 1 枚の前に流れの列の形を決め、見出しの compact を測る
    fitDeck();
    fitTop();

    const fromHash = tabFromHash(location.hash);
    // 流れの列の間の古い hash（#/tasks など）は列に読み替える（open の頭）
    if (fromHash && (SA.views.info(fromHash) || oldPage(fromHash) !== null)) open(fromHash);
    else {
      deferred = fromHash;
      renderMain();
    }

    // 設定・使用量の画面が使う（古い殻と同じ）
    SA.store.load.usageDays();
    SA.store.load.usage(null);
    // api.js の polling は今のまま全部動かす（chat.js が store.channels・store.running・store.cc を使う）
    SA.poll.start();
    // 住所の話題が留めた話題なら（一覧を読むと fitDeck の守りが席を閉じて帯の列にする）、その列へ送って入力欄に焦点（#507。open と同じ扱い）
    const hashPin = fromHash && fromHash.startsWith("ch:") ? fromHash.slice(3) : null;
    SA.topics.load().then(() => {
      topicsLoaded = true;
      reopenDeferred();
      if (hashPin !== null && S.active === null && pinsShown() && SA.pins.has(hashPin)) SA.pins.jump(hashPin, "composer");
    });
  }

  SA.app = {
    open,
    refresh,
    // 未読の点・選んでいる行を今の値で描き直し、2 秒に 1 回までの読み直し
    refreshSidebar: () => {
      SA.topics.render();
      SA.topics.schedule();
      renderHandEntries();
      renderFlows();
    },
    refreshActivity: () => SA.topics.render(),
    refreshTabs,
    // タブの見出しの実行中の印は無い
    refreshTabMarks: () => undefined,
    refreshStatus: () => {
      renderConn();
      reopenDeferred();
      if (SA.flows) SA.flows.status();
      renderFlows();
    },
    refreshNotices: () => {
      renderConn();
      renderFlows();
    },
    // 出力のパネルは持たない
    addOutput: () => undefined,
    activeTabId,
    shownChannelIds,
    readingChannelIds,
    sidebarShows,
    openDrawer,
    closeDrawer,
    sheet: openSheet,
    noticeLine,
    // サイドバー・パネルは無い
    toggleSidebar: () => undefined,
    togglePanel: () => undefined,
    // パレットは無い。絞り込み欄（流れの列では「探す」の板）を出して焦点（prefix は捨てる）
    palette: () => (deckOn() ? openFind(document.activeElement) : openSearch()),
    // 話題を始める（群の見出しの [+]）。tmux の Claude Code を起動する口は新しい殻に無い
    newSession: (place, opener) => openStart(place || "general", opener || null),
    ccStart: () => undefined,
    theme: () => S.theme,
    setTheme,
    draft: (channelId) => S.drafts[channelId] || "",
    setDraft,
    pruneDrafts,
  };

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();
})();
