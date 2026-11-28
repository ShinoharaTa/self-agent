// 記憶の変更の知らせと [取り消す]。memory_save・memory_forget で変えたら、run のチャンネルに [取り消す] 付きで知らせる。
// ローカルの場所（Discord に出せない。docs/plan/personas-web-antigravity.md §3.3 の 3）では送らず、その場所の履歴に同じ文を notice の行で書く
import type { MemoryChange, NotifyMemoryChange } from "../../agent/tools.ts";
import { DEFAULT_PERSONA_ID } from "../../config.ts";
import type { Gateway, OutgoingMessage } from "../../discord/gateway.ts";
import { type HistoryStore, recordHistory } from "../../store/history.ts";
import type { MemoryStore } from "../../store/memories.ts";
import type { ComponentHandler } from "../interactions.ts";
import type { PlaceRefs } from "../place-refs.ts";

/** [取り消す] を押した後の、知らせの本文 */
export const MEMORY_UNDONE_TEXT = "（取り消しました）";

/** ボタンの custom_id の名前空間（`mem:undo:<追加した id|0>:<消した id|0>`） */
const NAMESPACE = "mem";

export type MemoryUndoDeps = {
  memories: Pick<MemoryStore, "softDelete" | "restore">;
  log: (message: string) => void;
};

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** 記憶の変更の知らせ。[取り消す] は追加した記憶を消し、消した記憶を戻す（無い側は 0） */
export function memoryNotice(change: MemoryChange): OutgoingMessage {
  const text = change.kind === "saved" ? `（記憶しました: ${change.added.text}）` : `（忘れました: ${change.removed.text}）`;
  const added = change.kind === "saved" ? change.added.id : 0;
  const removed = change.removed?.id ?? 0;
  return {
    text,
    components: [{ kind: "buttons", buttons: [{ customId: `${NAMESPACE}:undo:${added}:${removed}`, label: "取り消す" }] }],
  };
}

/**
 * 記憶の変更を run のチャンネルに知らせる。変更は済んでいるので、投稿の失敗は log に出すだけ。
 * ローカルの場所では送らず、その場所の履歴に知らせの文を notice の行で書く（[取り消す] は付けない。Web の記憶の画面で直す）
 */
export function createNotifyMemoryChange(deps: {
  gateway: Pick<Gateway, "sendMessage">;
  /** 場所がローカルか（無ければどこでも送る） */
  places?: Pick<PlaceRefs, "isLocal">;
  /** ローカルの場所の知らせの行を書く（無ければ書かない） */
  history?: Pick<HistoryStore, "add">;
  /** 履歴の行の persona（チャンネルの持ち主の人格。無ければ既定の人格） */
  personaOf?: (channelId: string) => string;
  log: (message: string) => void;
}): NotifyMemoryChange {
  const { gateway, log } = deps;
  return async (change, context) => {
    if (deps.places?.isLocal(context.channelId) === true) {
      recordHistory(
        deps.history,
        {
          guildId: context.guildId,
          channelId: context.channelId,
          kind: "notice",
          source: "system",
          persona: deps.personaOf?.(context.channelId) ?? DEFAULT_PERSONA_ID,
          text: memoryNotice(change).text,
        },
        log,
      );
      return;
    }
    try {
      await gateway.sendMessage(context.channelId, memoryNotice(change));
    } catch (error) {
      log(`記憶の変更の知らせの投稿に失敗しました: ${describeError(error)}`);
    }
  };
}

/** custom_id の id（0 以上の整数。0 は無し）。それ以外なら undefined */
function parseId(raw: string | undefined): number | undefined {
  return raw !== undefined && /^(0|[1-9]\d*)$/.test(raw) ? Number(raw) : undefined;
}

/**
 * 記憶の変更の [取り消す]（`mem:undo:<added>:<removed>`）。追加した記憶を論理削除し、消した記憶を戻して、知らせのボタンを外す。
 * 既に消えている・既に戻っている側は何もしないので、何度押しても同じ結果になる。件数の上限は確かめない
 */
export function createMemoryUndoComponent(deps: MemoryUndoDeps): ComponentHandler {
  const { memories, log } = deps;
  return {
    namespace: NAMESPACE,
    async handle(interaction, responder) {
      const [, action, rawAdded, rawRemoved] = interaction.customId.split(":");
      const added = parseId(rawAdded);
      const removed = parseId(rawRemoved);
      if (added === undefined || removed === undefined || (added === 0 && removed === 0)) {
        throw new Error("mem の custom_id に id がありません");
      }
      if (interaction.kind !== "button" || action !== "undo") {
        throw new Error(`mem の不明な操作です（${interaction.kind} ${action ?? ""}）`);
      }
      const undoneAdd = added !== 0 && memories.softDelete(added) !== undefined;
      const undoneRemove = removed !== 0 && memories.restore(removed) !== undefined;
      if (undoneAdd || undoneRemove) log("[取り消す] で記憶の変更を取り消しました");
      await responder.update({ text: MEMORY_UNDONE_TEXT, components: [] });
    },
  };
}
