// 「あなたの番」のカードの部品（docs/plan/web-ui-components.md §6 の K5）: 1 つの枠 Card と、その上の許可・質問・閉じる前の確認・場所を変える確認のカード、待ちの行と文（Note）、状態の行と［やめる］（StatusRow）、並び（Cards）と口（cardsMouth）。
// hook を使わない（Node から関数として呼べる）。文は全部呼ぶ側が作って渡す（時刻・モード・番号を組まない）。選び方の決まりを持たず、起きた事を on に伝えるだけ。
// 押せない形は Button の disabled と reason（回る輪は状態の行の［やめる］の busy だけ）。クラスは固定の文字列、状態は data-* と aria-*
import { html } from "./c-lib.js";
import { Button } from "./c-atoms.js";

/** 許可・質問のカードの下に出す説明の文 */
export const PERMISSION_NOTE = "端末や RC のダイアログでも答えられます。先に答えた方が効きます。";
/** 端末の無いセッション（item.terminal が false）の許可のカードの説明の文 */
export const SESSION_PERMISSION_NOTE = "時間が過ぎると拒否になります。";
/** 端末の無いセッション（item.terminal が false）の質問のカードの説明の文 */
export const SESSION_QUESTION_NOTE = "時間が過ぎると時間切れになります。そのときは、答えを発言で送ってください。";

/** 「その他」の欄の maxlength */
export const OTHER_MAX = 1000;

const SENDING = "答えを送っています";
const BOTH_PLACES = "Discord でも選べます";
const MOVE_TEXT = "会話は新しくなり、担当には要点を引き継ぎます。記録はこのまま残ります。ファイルは動かしません。";

const str = (v) => (typeof v === "string" ? v : "");

/**
 * カードの枠。urgent は true・false なら右の文に data-urgent、undefined なら付けない。children は各カードが key を付けて渡す。
 * meta・note が空なら出さない
 */
export function Card({ kind, label, title, meta, urgent, note, children }) {
  const metaText = str(meta);
  const noteText = str(note);
  return html`<section class="c-card" aria-label=${label} data-kind=${kind}>
    <div class="c-card-head" key="head">
      <h2 class="c-card-title">${title}</h2>
      ${metaText === "" ? null : html`<span class="c-card-meta" data-urgent=${urgent === undefined ? undefined : urgent ? "true" : "false"}>${metaText}</span>`}
    </div>
    ${children}
    ${noteText === "" ? null : html`<p class="c-card-note" key="note">${noteText}</p>`}
  </section>`;
}

/** カードの中のチェック・ラジオの行（label が包む。押せない理由は disabled のときだけ行の title に） */
function Check({ type = "checkbox", name, checked, disabled, reason, onChange, onPointerDown, children }) {
  return html`<label class="c-card-check" title=${disabled && reason ? reason : undefined} onPointerDown=${onPointerDown}>
    <input class="c-card-check-input" type=${type} name=${name} checked=${!!checked} disabled=${!!disabled} onChange=${onChange} />
    <span class="c-card-check-text">${children}</span>
  </label>`;
}

/** ボタンの並び（子は Button だけ。数で並べ方を変える） */
function Actions({ children }) {
  const list = [children].flat(Infinity).filter((c) => c && typeof c === "object");
  return html`<div class="c-card-actions" data-count=${String(list.length)}>${list}</div>`;
}

/** 許可の要求。item: { id, tool, mode, summary, rule, ruleNote, always, left, urgent, busy, terminal（false なら端末の無いセッションの説明の文） } */
export function PermissionCard({ item, on }) {
  const busy = !!item.busy;
  const rule = str(item.rule);
  const mode = str(item.mode);
  const ruleNote = str(item.ruleNote);
  const reason = busy ? SENDING : undefined;
  return html`<${Card} kind="permission" label="許可の要求" title="あなたの番: 許可" meta=${item.left} urgent=${!!item.urgent} note=${item.terminal === false ? SESSION_PERMISSION_NOTE : PERMISSION_NOTE}>
    <p class="c-card-facts" key="facts"><span class="c-card-mono">${str(item.tool)}</span>${mode === "" ? null : " ・ " + mode}</p>
    <pre class="c-card-code" key="code">${str(item.summary)}</pre>
    ${rule === ""
      ? null
      : html`<div class="c-card-always" key="always">
          <${Check} checked=${!!item.always} disabled=${busy} reason=${SENDING}
            onChange=${(event) => on.always(item.id, event.currentTarget.checked)}>このセッションでは常に許可<//>
          <p class="c-card-rule"><code class="c-card-rule-code">${rule}</code>${ruleNote === "" ? null : html`<span class="c-card-rule-note">${"（" + ruleNote + "）"}</span>`}</p>
        </div>`}
    <${Actions} key="actions">
      <${Button} kind="secondary" size="md" label="許可" disabled=${busy} reason=${reason}
        onPress=${() => on.permit(item.id, rule !== "" && item.always ? "always" : "allow")} />
      <${Button} kind="ghost" size="md" label="拒否" disabled=${busy} reason=${reason} onPress=${() => on.permit(item.id, "deny")} />
    <//>
  <//>`;
}

/** 指・マウスで「その他」の行を押した問（fieldset の要素）。要素に付けて覚える（描く関数の中の変数だと、押し始めと change の間に描き直しが入ったときに消える） */
const pointed = new WeakSet();

/**
 * 質問の 1 問（fieldset。直下の子は全部 key つき）。「その他」の欄はいつも木に在り、hidden で隠す（描き直しで作り直さない）。
 * 本文は渡さない（ref で口が新しい要素にだけ入れる）。指・マウスで「その他」を選んだかは、行の pointerdown で印を付け、問の中のキー（ほかの選択肢からの矢印キーも）で外し、change で読んで外す
 */
function questionSet({ item, q, index, on, otherRef }) {
  const busy = !!item.busy;
  const multi = !!q.multi;
  const other = !!q.other;
  const type = multi ? "checkbox" : "radio";
  const name = "ccq-" + item.id + "-" + index;
  const legend = str(q.legend);
  const options = Array.isArray(q.options) ? q.options : [];
  const picked = Array.isArray(q.picked) ? q.picked : [];
  return html`<fieldset class="c-card-q" key=${"q" + index} onKeyDown=${(event) => void pointed.delete(event.currentTarget)}>
    <legend class="c-card-q-legend" key="legend">${legend}</legend>
    <p class="c-card-q-text" key="text">${str(q.text)}</p>
    ${multi ? html`<p class="c-card-q-hint" key="hint">いくつでも選べます</p>` : null}
    ${options.map((o, i) => {
      const label = str(o && o.label);
      const desc = str(o && o.description);
      return html`<${Check} key=${"o" + i} type=${type} name=${name} checked=${!other && picked.includes(label)} disabled=${busy} reason=${SENDING}
        onChange=${(event) => on.pick(item.id, index, label, event.currentTarget.checked)}>
        <strong class="c-card-check-label">${label}</strong>${desc === "" ? null : html`<span class="c-card-check-desc">${desc}</span>`}
      <//>`;
    })}
    <${Check} key="other" type=${type} name=${name} checked=${other} disabled=${busy} reason=${SENDING}
      onPointerDown=${(event) => {
        const set = event.currentTarget.closest("fieldset");
        if (set) pointed.add(set);
      }}
      onChange=${(event) => {
        const set = event.currentTarget.closest("fieldset");
        on.pickOther(item.id, index, event.currentTarget.checked, !!set && pointed.delete(set));
      }}><strong class="c-card-check-label">その他</strong><//>
    <textarea class="c-card-other" key="field" rows="2" maxlength=${OTHER_MAX} aria-label=${"その他の答え（" + legend + "）"}
      hidden=${!other} disabled=${busy} ref=${otherRef ? otherRef(item.id, index) : undefined}
      onInput=${(event) => on.other(item.id, index, event.currentTarget.value)}></textarea>
  </fieldset>`;
}

/**
 * 質問。item: { id, who, left, urgent, busy, ready（全部の問に答えたか）, terminal（false なら端末の無いセッションの説明の文）, questions: [{ legend, text, multi, options: [{ label, description }], picked, other, otherText }] }。
 * otherRef(id, 問の番号) は「その他」の欄の ref を返す（口が渡す。無ければ付けない）
 */
export function QuestionCard({ item, on, otherRef }) {
  const busy = !!item.busy;
  const who = str(item.who);
  const questions = Array.isArray(item.questions) ? item.questions : [];
  const answerReason = busy ? SENDING : item.ready ? undefined : "すべての問に答えると押せます";
  return html`<${Card} kind="question" label="質問" title="あなたの番: 質問" meta=${item.left} urgent=${!!item.urgent} note=${item.terminal === false ? SESSION_QUESTION_NOTE : PERMISSION_NOTE}>
    ${who === "" ? null : html`<p class="c-card-facts" key="who">${who}</p>`}
    ${questions.map((q, index) => questionSet({ item, q: q || {}, index, on, otherRef }))}
    <${Actions} key="actions">
      <${Button} key="answer" kind="primary" size="md" label="答える" disabled=${busy || !item.ready} reason=${answerReason} onPress=${() => on.answer(item.id)} />
      <${Button} key="cancel" kind="ghost" size="md" label="やめる" disabled=${busy} reason=${busy ? SENDING : undefined} onPress=${() => on.dismiss(item.id)} />
    <//>
  <//>`;
}

/** 閉じる前の確認。item: { id, summary, tasks（行の文の並び）, picked（選んだ番号の並び。番号は 0 から）, busy } */
export function CloseCard({ item, on }) {
  const busy = !!item.busy;
  const tasks = Array.isArray(item.tasks) ? item.tasks : [];
  const picked = Array.isArray(item.picked) ? item.picked : [];
  const reason = busy ? SENDING : undefined;
  // ボタンは key で見分ける（候補が無い形から在る形へ替わっても、［登録しない］の要素が別のボタンにならない）
  const none = html`<${Button} key="none" kind="secondary" size="md" label="登録しない" disabled=${busy} reason=${reason} onPress=${() => on.close(item.id, "none")} />`;
  return html`<${Card} kind="close" label="閉じる前の確認" title="あなたの番: 閉じる前の確認" meta=${BOTH_PLACES}>
    <dl class="c-card-dl" key="dl">
      <dt class="c-card-dt">要約</dt>
      <dd class="c-card-dd"><div class="c-card-text">${str(item.summary)}</div></dd>
      <dt class="c-card-dt">タスクにする候補</dt>
      <dd class="c-card-dd">
        ${tasks.length === 0
          ? html`<p class="c-card-none">やることの候補はありません。</p>`
          : tasks.map(
              (text, i) => html`<${Check} key=${i} checked=${picked.includes(i)} disabled=${busy} reason=${SENDING}
                onChange=${(event) => on.task(item.id, i, event.currentTarget.checked)}>${str(text)}<//>`,
            )}
      </dd>
    </dl>
    <${Actions} key="actions">
      ${tasks.length === 0
        ? none
        : [
            html`<${Button} key="all" kind="primary" size="md" label="全部登録" disabled=${busy} reason=${reason} onPress=${() => on.close(item.id, "all")} />`,
            html`<${Button} key="picked" kind="secondary" size="md" label="選んだものを登録" disabled=${busy || picked.length === 0}
              reason=${busy ? SENDING : picked.length === 0 ? "候補を選ぶと押せます" : undefined} onPress=${() => on.close(item.id, "picked")} />`,
            none,
          ]}
    <//>
  <//>`;
}

/** 場所を変える確認。item: { id, from, to, busy } */
export function MoveCard({ item, on }) {
  const busy = !!item.busy;
  const reason = busy ? SENDING : undefined;
  return html`<${Card} kind="move" label="場所を変える確認" title="あなたの番: 場所を変える確認" meta=${BOTH_PLACES}>
    <dl class="c-card-dl" key="dl">
      <dt class="c-card-dt">今の場所</dt>
      <dd class="c-card-dd">${str(item.from)}</dd>
      <dt class="c-card-dt">変える先</dt>
      <dd class="c-card-dd">${str(item.to)}</dd>
    </dl>
    <p class="c-card-text" key="text">${MOVE_TEXT}</p>
    <${Actions} key="actions">
      <${Button} kind="primary" size="md" label="変える" disabled=${busy} reason=${reason} onPress=${() => on.move(item.id, "accept")} />
      <${Button} kind="secondary" size="md" label="このまま" disabled=${busy} reason=${reason} onPress=${() => on.move(item.id, "keep")} />
    <//>
  <//>`;
}

/** 待ちの行（busy。文は「…」で終わる。動きは無い）と、1 行の文。待ちの行は読み上げる（aria-busy を付けると、外れるまで読み上げが待たされる。この行は外れずに消える） */
export function Note({ text, busy }) {
  return busy
    ? html`<p class="c-note" role="status" data-busy="true">${str(text)}</p>`
    : html`<p class="c-note">${str(text)}</p>`;
}

/**
 * 状態の行（待ちの行の文）と、取り消せるときの［やめる］。item: { id, text, cancel: null か { id: 取り消す物の id, busy } }。
 * 文の要素は［やめる］の出入りでも同じ（key）。aria-busy は付けない（Note と同じ理由）。押せない理由の文は付けない（busy の輪だけ）
 */
export function StatusRow({ item, on }) {
  const cancel = item.cancel && typeof item.cancel === "object" ? item.cancel : null;
  return html`<div class="c-status">
    <p class="c-note" key="text" role="status" data-busy="true">${str(item.text)}</p>
    ${cancel === null
      ? null
      : html`<${Button} key="cancel" kind="ghost" size="sm" label="やめる" busy=${!!cancel.busy} onPress=${() => on.cancel(cancel.id)} />`}
  </div>`;
}

const KINDS = {
  note: ({ item }) => html`<${Note} text=${item.text} busy=${!!item.busy} />`,
  status: StatusRow,
  permission: PermissionCard,
  question: QuestionCard,
  close: CloseCard,
  move: MoveCard,
};

/** カードの並び。otherRef は質問のカードへ渡す。items が並びでない・空なら何も出さない。key は kind + ":" + id。知らない kind は出さない */
export function Cards({ items, on, otherRef }) {
  if (!Array.isArray(items) || items.length === 0) return null;
  return html`<div class="c-cards">
    ${items.map((item) => {
      const Kind = item && Object.hasOwn(KINDS, item.kind) ? KINDS[item.kind] : undefined;
      return Kind === undefined ? null : html`<${Kind} key=${item.kind + ":" + item.id} item=${item} on=${on} otherRef=${otherRef} />`;
    })}
  </div>`;
}

/**
 * カードの口: { draw(root, state), focus(root, id, index), drop(root) }。state は { items, on }。
 * 「その他」の欄の本文は呼ぶ側が持ち（on.other で受けた値を次の draw の otherText に）、口は新しい要素にだけその時の本文を入れる（同じ要素には書かない。打っている途中・変換の途中を壊さない）。
 * ref は根と鍵（id と問の番号）ごとに同じ関数。項目が消えた鍵は覚えを捨てる。例外は握らない
 */
export function cardsMouth(render) {
  const memo = new WeakMap();
  const keyOf = (id, index) => String(id) + ":" + index;
  const slotOf = (slots, key) => {
    let m = slots.get(key);
    if (m === undefined) {
      m = { node: null, text: "", ref: null };
      const own = m;
      own.ref = (node) => {
        if (node && node !== own.node) node.value = own.text;
        own.node = node || null;
      };
      slots.set(key, m);
    }
    return m;
  };
  const draw = (root, state) => {
    let slots = memo.get(root);
    if (slots === undefined) {
      slots = new Map();
      memo.set(root, slots);
    }
    const live = new Set();
    for (const item of Array.isArray(state.items) ? state.items : []) {
      if (!item || item.kind !== "question" || !Array.isArray(item.questions)) continue;
      item.questions.forEach((q, index) => {
        const key = keyOf(item.id, index);
        live.add(key);
        slotOf(slots, key).text = str(q && q.otherText);
      });
    }
    for (const key of [...slots.keys()]) if (!live.has(key)) slots.delete(key);
    const own = slots;
    render(html`<${Cards} items=${state.items} on=${state.on} otherRef=${(id, index) => slotOf(own, keyOf(id, index)).ref} />`, root);
  };
  const focus = (root, id, index) => {
    const slots = memo.get(root);
    const m = slots === undefined ? undefined : slots.get(keyOf(id, index));
    if (m === undefined || !m.node || m.node.hidden) return false;
    m.node.focus();
    return true;
  };
  const drop = (root) => {
    memo.delete(root);
    render(null, root);
  };
  return { draw, focus, drop };
}
