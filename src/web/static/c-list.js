// 話題の一覧（docs/plan/web-ui-components.md §6 の K3）: TopicList・YourTurn・ListLabel・Group・TopicRow・Fold・Others と、そのモデルの関数。
// hook を使わない（Node から関数として呼べる）。状態は持たず、入口が listModel(state) の結果を押し込む。クラスは固定の文字列、状態は data-* と aria-*
import { html } from "./c-lib.js";
import { Badge, Button, Empty, Icon, IconButton, Loading, Mark } from "./c-atoms.js";

/** あなたの番の種類の語（今の topics.js の TURN_LABEL） */
export const TURN_LABEL = Object.freeze({ permission: "許可", question: "質問", waiting: "判断待ち", confirm: "確認" });
/** ?done= で出す完了の数（src/app/topics.ts の TOPICS_DONE_MAX） */
export const DONE_MAX = 50;

const NOTE_FAILED = "更新できませんでした。前の一覧を出しています";
const NOTE_CC = "Claude Code の一覧を読めません。作業中の話題が欠けて見えることがあります";
const NOTE_NOHIT = "当たる話題がありません";

/** 絞り込みの語（小文字・空白で区切る）。空なら絞り込まない */
export function filterWords(filter) {
  return String(filter || "")
    .toLowerCase()
    .split(/\s+/)
    .filter((w) => w !== "");
}

/** 題・群の名前・人格の名前に、語を全部含むか */
export function topicHits(topic, groupName, words) {
  const text = [topic.title, groupName, topic.persona || ""].join(" ").toLowerCase();
  return words.every((w) => text.includes(w));
}

/** 印は あなたの番 > 作業中 > 未読 で 1 つだけ。未読は印の無い ch: の話題だけ isUnread(チャンネル, last) に訊く */
export function rowMark(topic, isUnread) {
  if (topic.mark === "turn") return "turn";
  if (topic.mark === "running") return "running";
  if (topic.mark === null && typeof topic.id === "string" && topic.id.startsWith("ch:") && isUnread(topic.id.slice(3), topic.last)) return "unread";
  return "none";
}

/** 行の値。右は状態の語か時刻のどちらか 1 つ（履歴の無い行は時刻も出さない）。ctx: { isUnread, time, current } */
export function rowModel(topic, ctx) {
  const mark = rowMark(topic, ctx.isUnread);
  const state =
    mark === "turn" && topic.turn ? { text: TURN_LABEL[topic.turn.kind], tone: "warning" } : mark === "running" ? { text: "作業中", tone: "accent" } : null;
  return {
    id: topic.id,
    title: topic.title,
    mark,
    state,
    time: state === null && topic.activityAt ? ctx.time(topic.activityAt) : null,
    tag: topic.origin === "cc" ? "端末" : topic.persona || null,
    done: topic.state === "done",
    current: ctx.current === topic.id,
  };
}

/** 群の見出しの右の文。畳んだ群（ほかのプロジェクトの中）は「話題なし」を出さない */
export function groupNote(group, memberCount, folded) {
  if (group.turns > 0) return { text: "あなたの番 " + group.turns, tone: "warning" };
  if (group.running > 0) return { text: "作業中 " + group.running, tone: "accent" };
  if (!folded && memberCount === 0 && group.done === 0) return { text: "話題なし", tone: "muted" };
  return null;
}

/** 「あなたの番」の項目（話題か右腕。どちらでも引けなければ null）。meta は種類と待ち始めからの時間、sub は場所と要約 */
export function turnItem(id, state) {
  const data = state.data;
  const topic = data.topics.find((t) => t.id === id && t.turn);
  if (topic) {
    const group = data.groups.find((g) => g.key === topic.group);
    return item(id, topic.title, topic.turn, group ? group.name : "", state);
  }
  const hand = data.rightHands.find((h) => h.id === id && h.turn);
  return hand ? item(id, "右腕", hand.turn, "", state) : null;
}

function item(id, title, turn, place, state) {
  return {
    id,
    title,
    meta: TURN_LABEL[turn.kind] + "・" + state.ago(turn.since),
    sub: [place, turn.summary || ""].filter((s) => s !== "").join("・"),
    current: state.current === id,
  };
}

/** ids の中で current の次（最後なら先頭へ）。current が無ければ先頭、空なら null */
export function nextTurnId(ids, current) {
  if (ids.length === 0) return null;
  const at = ids.indexOf(current);
  return at < 0 ? ids[0] : ids[(at + 1) % ids.length];
}

/** 注意は 1 つだけ: 更新の失敗 ＞ Claude Code の一覧が読めない ＞ 絞り込みで当たらない。data が無いときは ""（phase が出す） */
export function listNote({ failed, hasData, ccUnreadable, filtering, hitCount }) {
  if (!hasData) return "";
  if (failed) return NOTE_FAILED;
  if (ccUnreadable) return NOTE_CC;
  if (filtering && hitCount === 0) return NOTE_NOHIT;
  return "";
}

/** ↑↓・Home・End の行き先の番号（端なら null）。扱わないキーは undefined */
export function listKey(key, count, at) {
  if (!["Home", "End", "ArrowDown", "ArrowUp"].includes(key)) return undefined;
  if (count === 0) return null;
  if (key === "Home") return 0;
  if (key === "End") return count - 1;
  if (at < 0) return null;
  if (key === "ArrowDown") return at + 1 < count ? at + 1 : null;
  return at - 1 >= 0 ? at - 1 : null;
}

/** 群のモデル（folded は「ほかのプロジェクト」の中の群。行と見出しの右の文を持たない）。hits は入れた行の数 */
function groupModel(g, state, words, folded) {
  const ctx = { isUnread: state.isUnread, time: state.time, current: state.current };
  const topics = state.data.topics.filter((t) => t.group === g.key);
  const members = topics.filter((t) => t.state !== "done");
  const rows = folded ? [] : members.filter((t) => topicHits(t, g.name, words)).map((t) => rowModel(t, ctx));
  let done = null;
  let hits = rows.length;
  if (g.done > 0) {
    const open = state.doneGroup === g.key;
    const loading = open && state.dataDone !== g.key;
    const doneRows = open && !loading ? topics.filter((t) => t.state === "done" && topicHits(t, g.name, words)).map((t) => rowModel(t, ctx)) : [];
    hits += doneRows.length;
    done = {
      label: "完了（" + g.done + "）",
      open,
      loading,
      rows: doneRows,
      more: open && !loading && g.done > DONE_MAX ? "新しい " + DONE_MAX + " 件を出しています" : "",
    };
  }
  const canAdd = g.kind === "general" || g.kind === "project";
  return {
    block: {
      type: "group",
      key: g.key,
      kind: g.kind,
      name: g.name,
      hint: g.kind === "general" ? "場所を決めていない話題" : "",
      note: folded ? null : groupNote(g, members.length, false),
      canAdd,
      addLabel: g.name + " で話題を始める",
      rows,
      done,
    },
    hits,
  };
}

/** 一覧のモデル（今の topics.js の draw・updateGroup・updateDone・updateOthers の判断） */
export function listModel(state) {
  const data = state.data;
  if (data === null || data === undefined) {
    return { phase: state.failed ? "failed" : "loading", note: "", turns: null, blocks: [], hitCount: 0 };
  }
  const words = filterWords(state.filter);
  const filtering = words.length > 0;

  // 「あなたの番」は絞り込まない
  const items = data.turnIds.map((id) => turnItem(id, state)).filter((t) => t !== null);
  const turns =
    data.turns === 0 || items.length === 0
      ? null
      : { count: data.turns, nextId: nextTurnId(items.map((t) => t.id), state.current), items };

  // 話題の無いプロジェクトの群は「ほかのプロジェクト」に畳む。置く位置は畳んだ最初の群の所（サーバーの群の順のまま）
  const blocks = [];
  let hitCount = 0;
  let othersAt = -1;
  const folded = [];
  let foldedHits = 0;
  for (const g of data.groups) {
    const isFolded = g.kind === "project" && g.open === 0;
    const { block, hits } = groupModel(g, state, words, isFolded);
    if (isFolded) {
      if (othersAt < 0) othersAt = blocks.length;
      folded.push({ block, hits });
      foldedHits += hits;
    } else if (!filtering || hits > 0) {
      blocks.push(block);
      hitCount += hits;
    }
  }
  if (othersAt >= 0 && (!filtering || foldedHits > 0)) {
    blocks.splice(othersAt, 0, {
      type: "others",
      label: "ほかのプロジェクト（" + folded.length + "）",
      open: filtering || !!state.othersOpen,
      forced: filtering,
      groups: folded.filter((f) => !filtering || f.hits > 0).map((f) => f.block),
    });
    hitCount += foldedHits;
  }
  const labelAt = blocks.findIndex((b) => b.type === "others" || b.kind === "project");
  if (labelAt >= 0) blocks.splice(labelAt, 0, { type: "label", text: "プロジェクト" });

  const ccUnreadable = !!(data.cc && data.cc.enabled && data.cc.unreadable);
  return {
    phase: "ready",
    note: listNote({ failed: !!state.failed, hasData: true, ccUnreadable, filtering, hitCount }),
    turns,
    blocks,
    hitCount,
  };
}

// ===== 部品 =====

/** 一覧の根（スクロールの入れ物。どの phase でも同じ要素）。on: { open(id, done), add(key, opener), toggleDone(key), toggleOthers(), retry() } */
export function TopicList({ model, compact, on }) {
  let body = null;
  if (model.phase === "loading") body = html`<${Loading} key="loading" />`;
  else if (model.phase === "failed")
    body = html`<${Empty} key="failed" text="読み込めませんでした" action=${html`<${Button} kind="secondary" size="sm" label="もう一度読む" onPress=${() => on.retry()} />`} />`;
  else
    body = [
      model.turns ? html`<${YourTurn} key="turns" turns=${model.turns} compact=${compact} onOpen=${on.open} />` : null,
      ...model.blocks.map((b) =>
        b.type === "label"
          ? html`<${ListLabel} key="label" text=${b.text} />`
          : b.type === "others"
            ? html`<${Others} key="others" others=${b} compact=${compact} on=${on} />`
            : html`<${Group} key=${b.key} group=${b} compact=${compact} on=${on} />`,
      ),
    ];
  return html`<div class="c-list" tabindex="-1" data-phase=${model.phase}>
    <p class="c-list-note" role="status">${model.note}</p>
    ${body}
  </div>`;
}

/** あなたの番。指の端末は見出しと 2 行の項目、PC（compact）は件数のボタン 1 つ（押すと次の待ちの話題） */
export function YourTurn({ turns, compact, onOpen }) {
  if (!turns) return null;
  if (compact) {
    return html`<div class="c-turns" data-compact="true">
      <button class="c-turns-jump" type="button" aria-label=${"あなたの番 " + turns.count + " 件。次の話題を開く"} onClick=${() => onOpen(turns.nextId, false)}>
        <span class="c-turns-jump-label">あなたの番</span>
        <${Badge} count=${turns.count} tone="warning" />
      </button>
    </div>`;
  }
  return html`<section class="c-turns" aria-label="あなたの番">
    <h2 class="c-turns-head">あなたの番<span class="c-turns-count">${turns.count}</span></h2>
    <ul class="c-turns-list">
      ${turns.items.map(
        (t) => html`<li key=${"turn:" + t.id}>
          <button class="c-turn" type="button" data-topic=${t.id} aria-current=${t.current ? "true" : undefined} title=${t.title} onClick=${() => onOpen(t.id, false)}>
            <${Mark} state="turn" />
            <span class="c-turn-body">
              <span class="c-turn-line">
                <span class="c-turn-title">${t.title}</span>
                <span class="c-turn-meta">${t.meta}</span>
              </span>
              ${t.sub ? html`<span class="c-turn-sub">${t.sub}</span>` : null}
            </span>
          </button>
        </li>`,
      )}
    </ul>
  </section>`;
}

export function ListLabel({ text }) {
  return html`<p class="c-list-label">${text}</p>`;
}

function Rows({ rows, onOpen }) {
  if (rows.length === 0) return null;
  return html`<ul class="c-rows">
    ${rows.map((row) => html`<li key=${row.id}><${TopicRow} row=${row} onOpen=${onOpen} /></li>`)}
  </ul>`;
}

/** 群（見出し・行・完了）。[+] は見出しの h2 の外 */
export function Group({ group, compact, on }) {
  const done = group.done;
  return html`<section class="c-group" data-kind=${group.kind} aria-label=${group.name}>
    <div class="c-group-head" data-add=${group.canAdd ? "true" : "false"}>
      <h2 class="c-group-name">${group.name}</h2>
      ${group.hint ? html`<span class="c-group-hint">${group.hint}</span>` : null}
      ${group.note ? html`<span class="c-group-note" data-tone=${group.note.tone}>${group.note.text}</span>` : null}
      ${group.canAdd
        ? html`<${IconButton} icon="plus" label=${group.addLabel} size=${compact ? "sm" : "md"} onPress=${(event) => on.add(group.key, event.currentTarget)} />`
        : null}
    </div>
    <${Rows} rows=${group.rows} onOpen=${on.open} />
    ${done
      ? html`<${Fold} level="row" label=${done.label} open=${done.open} onToggle=${() => on.toggleDone(group.key)}>
          ${done.loading ? html`<p class="c-fold-note">読み込んでいます…</p>` : null}
          <${Rows} rows=${done.rows} onOpen=${on.open} />
          ${done.more ? html`<p class="c-fold-note">${done.more}</p>` : null}
        <//>`
      : null}
  </section>`;
}

/** 行。印・題・付記・右の語か時刻。押すと onOpen(id, done) */
export function TopicRow({ row, onOpen }) {
  return html`<button class="c-row" type="button" data-topic=${row.id} data-mark=${row.mark} data-done=${row.done ? "true" : undefined}
      aria-current=${row.current ? "true" : undefined} title=${row.title} onClick=${() => onOpen(row.id, row.done)}>
    <${Mark} state=${row.mark} label=${row.mark === "unread" ? "未読" : undefined} />
    <span class="c-row-title">${row.title}</span>
    ${row.tag ? html`<span class="c-row-tag">${row.tag}</span>` : null}
    ${row.state
      ? html`<span class="c-row-state" data-tone=${row.state.tone}>${row.state.text}</span>`
      : row.time
        ? html`<span class="c-row-time">${row.time}</span>`
        : null}
  </button>`;
}

/** 開け閉めの見出しと中身（完了・ほかのプロジェクト）。disabled のときは押しても onToggle を呼ばない */
export function Fold({ level, label, open, disabled = false, onToggle, children }) {
  return html`<div class="c-fold" data-level=${level === "group" ? "group" : "row"}>
    <button class="c-fold-head" type="button" aria-expanded=${open ? "true" : "false"} aria-disabled=${disabled ? "true" : undefined}
        onClick=${() => {
          if (!disabled) onToggle();
        }}>
      <${Icon} name=${open ? "chevron-down" : "chevron-right"} size="sm" />
      <span class="c-fold-label">${label}</span>
    </button>
    ${open ? html`<div class="c-fold-body">${children}</div>` : null}
  </div>`;
}

/** ほかのプロジェクト（話題の無いプロジェクトの群）。絞り込み中は開いたまま（forced） */
export function Others({ others, compact, on }) {
  return html`<${Fold} level="group" label=${others.label} open=${others.open} disabled=${others.forced} onToggle=${() => on.toggleOthers()}>
    ${others.groups.map((g) => html`<${Group} key=${g.key} group=${g} compact=${compact} on=${on} />`)}
  <//>`;
}
