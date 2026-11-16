// 「あなたの番」のカードの部品（docs/plan/web-ui-components.md §6 の K5）: 1 つの枠 Card と、その上の許可・閉じる前の確認・場所を変える確認のカード、待ちの行と文（Note）、並び（Cards）。
// hook を使わない（Node から関数として呼べる）。文は全部呼ぶ側が作って渡す（時刻・モード・番号を組まない）。選び方の決まりを持たず、起きた事を on に伝えるだけ。
// 押せない形は Button の disabled と reason（回る輪は使わない）。クラスは固定の文字列、状態は data-* と aria-*
import { html } from "./c-lib.js";
import { Button } from "./c-atoms.js";

/** 許可・質問のカードの下に出す説明の文 */
export const PERMISSION_NOTE = "端末や RC のダイアログでも答えられます。先に答えた方が効きます。";

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
function Check({ type = "checkbox", name, checked, disabled, reason, onChange, children }) {
  return html`<label class="c-card-check" title=${disabled && reason ? reason : undefined}>
    <input class="c-card-check-input" type=${type} name=${name} checked=${!!checked} disabled=${!!disabled} onChange=${onChange} />
    <span class="c-card-check-text">${children}</span>
  </label>`;
}

/** ボタンの並び（子は Button だけ。数で並べ方を変える） */
function Actions({ children }) {
  const list = [children].flat(Infinity).filter((c) => c && typeof c === "object");
  return html`<div class="c-card-actions" data-count=${String(list.length)}>${list}</div>`;
}

/** 許可の要求。item: { id, tool, mode, summary, rule, ruleNote, always, left, urgent, busy } */
export function PermissionCard({ item, on }) {
  const busy = !!item.busy;
  const rule = str(item.rule);
  const mode = str(item.mode);
  const ruleNote = str(item.ruleNote);
  const reason = busy ? SENDING : undefined;
  return html`<${Card} kind="permission" label="許可の要求" title="あなたの番: 許可" meta=${item.left} urgent=${!!item.urgent} note=${PERMISSION_NOTE}>
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

/** 閉じる前の確認。item: { id, summary, tasks（行の文の並び）, picked（選んだ番号の並び。番号は 0 から）, busy } */
export function CloseCard({ item, on }) {
  const busy = !!item.busy;
  const tasks = Array.isArray(item.tasks) ? item.tasks : [];
  const picked = Array.isArray(item.picked) ? item.picked : [];
  const reason = busy ? SENDING : undefined;
  const none = html`<${Button} kind="secondary" size="md" label="登録しない" disabled=${busy} reason=${reason} onPress=${() => on.close(item.id, "none")} />`;
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
            html`<${Button} kind="primary" size="md" label="全部登録" disabled=${busy} reason=${reason} onPress=${() => on.close(item.id, "all")} />`,
            html`<${Button} kind="secondary" size="md" label="選んだものを登録" disabled=${busy || picked.length === 0}
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

/** 待ちの行（busy。文は「…」で終わる。動きは無い）と、1 行の文 */
export function Note({ text, busy }) {
  return busy
    ? html`<p class="c-note" role="status" aria-busy="true" data-busy="true">${str(text)}</p>`
    : html`<p class="c-note">${str(text)}</p>`;
}

const KINDS = {
  note: ({ item }) => html`<${Note} text=${item.text} busy=${!!item.busy} />`,
  permission: PermissionCard,
  close: CloseCard,
  move: MoveCard,
};

/** カードの並び。items が並びでない・空なら何も出さない。key は kind + ":" + id。知らない kind は出さない */
export function Cards({ items, on }) {
  if (!Array.isArray(items) || items.length === 0) return null;
  return html`<div class="c-cards">
    ${items.map((item) => {
      const Kind = item && Object.hasOwn(KINDS, item.kind) ? KINDS[item.kind] : undefined;
      return Kind === undefined ? null : html`<${Kind} key=${item.kind + ":" + item.id} item=${item} on=${on} />`;
    })}
  </div>`;
}
