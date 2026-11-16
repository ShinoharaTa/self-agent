// 会話の入力欄の部品（docs/plan/web-ui-components.md §6 の K5）: Composer と、そのモデルの関数（composerModel・sendKey）と入力欄の口（composerMouth）。
// hook を使わない（Node から関数として呼べる）。本文は持たない: textarea に value を渡さず（書きかけ・変換の途中・選択を描き直しで失わない）、
// 最初の本文と送った後の空は口が要素に直に入れる。高さは CSS だけで伸ばす（同じ升に見えない写しを重ねる）。クラスは固定の文字列、状態は data-* と aria-*
import { html } from "./c-lib.js";
import { Button } from "./c-atoms.js";

/** 字数を出し始める残りの字数 */
export const COMPOSER_NEAR = 200;
/** textarea の maxlength（送れる上限 max より大きい。超えた分は送るときに呼ぶ側が知らせる） */
export const COMPOSER_HARD_MAX = 4000;

const str = (v) => (typeof v === "string" ? v : "");

/**
 * 入力欄のモデル（純粋）。state: { text, count（送る本文の字数。前後の空白を除く）, max, sending, touch, label, placeholder, note }。
 * 字数は残りが COMPOSER_NEAR を切ってから出し（超えた後も出る）、上限を超えても［送る］は押せる
 */
export function composerModel(state) {
  const text = str(state.text);
  const count = typeof state.count === "number" ? state.count : 0;
  const max = typeof state.max === "number" ? state.max : 0;
  const sending = !!state.sending;
  const touch = !!state.touch;
  const empty = text.trim() === "";
  const showCount = max - count < COMPOSER_NEAR;
  return {
    label: str(state.label),
    placeholder: str(state.placeholder),
    note: str(state.note),
    touch,
    enterHint: touch ? "enter" : "send",
    // 末尾の改行のぶんの行を写しにも出す
    mirror: text + " ",
    empty,
    showCount,
    countText: showCount ? `${count.toLocaleString("en-US")} / ${max.toLocaleString("en-US")}` : "",
    over: count > max,
    sendBusy: sending,
    sendDisabled: empty,
    sendReason: sending ? "送っています" : empty ? "本文を入れると送れます" : undefined,
  };
}

/** Enter で送るか（純粋）。変換の途中（isComposing・keyCode 229）は送らない。Ctrl・⌘ 付きはいつも、ほかは Shift なしでタッチが主でないときだけ */
export function sendKey(event, touch) {
  if (event.key !== "Enter" || event.isComposing || event.keyCode === 229) return false;
  return !!(event.ctrlKey || event.metaKey) || (!event.shiftKey && !touch);
}

/**
 * 入力欄。on: { input(今の値), send() }。send は押せるとき（本文が在り、送っている途中でない）だけ呼ぶ（［送る］も Enter も）。inputRef は textarea の要素を受ける callback の ref（口が渡す）。
 * textarea は升の最初の子で、前に条件つきの兄弟を置かない。直下の子に key を付ける（兄弟が増えても textarea を作り直さない）
 */
export function Composer({ model, on, inputRef }) {
  return html`<div class="c-composer">
    <div class="c-composer-row" key="row">
      <div class="c-composer-field">
        <textarea class="c-composer-input" rows="1" maxlength=${COMPOSER_HARD_MAX} aria-label=${model.label} placeholder=${model.placeholder}
          title=${model.note || undefined} enterkeyhint=${model.enterHint} ref=${inputRef}
          onInput=${(event) => on.input(event.currentTarget.value)}
          onKeyDown=${(event) => {
            if (!sendKey(event, model.touch)) return;
            event.preventDefault();
            // ［送る］と同じく、空・送っている途中は呼ばない（改行も入れない）
            if (model.sendDisabled || model.sendBusy) return;
            on.send();
          }}></textarea>
        <div class="c-composer-mirror" aria-hidden="true">${model.mirror}</div>
      </div>
      <${Button} kind="accent" size="md" label="送る" disabled=${model.sendDisabled} busy=${model.sendBusy} reason=${model.sendReason} onPress=${() => on.send()} />
    </div>
    <div class="c-composer-count" key="count" aria-live="polite">
      ${model.showCount ? html`<span class="c-composer-count-text" data-over=${model.over ? "true" : undefined}>${model.countText}</span>` : null}
    </div>
  </div>`;
}

/**
 * 入力欄の口（入口が 1 回だけ呼ぶ。render は c-lib の render を渡す）。{ draw(root, state), set(root, text), focus(root), drop(root) }。
 * 根ごとに { node, text, ref } を覚える。ref は根ごとに 1 つの同じ関数で、欄の要素が新しくなったときだけその時の本文を入れる（同じ要素には書かない）。
 * draw は覚えの本文を替えて描くだけで、既に在る要素の値に触れない。値を書き換えるのは set だけ。例外は握らない（握るのは入口）。
 * 欄がまだ無い根への set は false を返し、その本文は次の draw の state.text に負ける（最初の本文は draw の state.text で渡す）。
 * set は写し（高さ）を変えないので、呼ぶ側は set の後に同じ本文で draw する
 */
export function composerMouth(render) {
  const memo = new WeakMap();
  const memoOf = (root) => {
    let m = memo.get(root);
    if (m === undefined) {
      m = { node: null, text: "", ref: null };
      const own = m;
      own.ref = (node) => {
        if (node && node !== own.node) node.value = own.text;
        own.node = node || null;
      };
      memo.set(root, m);
    }
    return m;
  };
  const draw = (root, state) => {
    const m = memoOf(root);
    m.text = str(state.text);
    render(html`<${Composer} model=${composerModel(state)} on=${state.on} inputRef=${m.ref} />`, root);
  };
  const set = (root, text) => {
    const m = memoOf(root);
    m.text = str(text);
    if (!m.node) return false;
    m.node.value = m.text;
    return true;
  };
  const focus = (root) => {
    const m = memo.get(root);
    if (m === undefined || !m.node) return false;
    m.node.focus({ preventScroll: true });
    return true;
  };
  const drop = (root) => {
    memo.delete(root);
    render(null, root);
  };
  return { draw, set, focus, drop };
}
