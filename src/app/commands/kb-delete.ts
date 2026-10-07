// ナレッジベースの削除の確認。kb_delete ツールがチャンネルに投稿し、オーナーがボタンを押したときだけ消す（/kb からの削除も同じボタンを使う）
import type { ConfirmKbDelete } from "../../agent/tools.ts";
import type { Gateway, OutgoingMessage } from "../../discord/gateway.ts";
import type { KbEntry, KnowledgeStore } from "../../store/knowledge.ts";
import type { ComponentHandler } from "../interactions.ts";
import { STALE_TEXT } from "./delete.ts";

/** [やめる] を押した後の、確認メッセージの本文 */
export const KB_KEPT_TEXT = "やめました";

/** ボタンの custom_id の名前空間（`kb:<action>:<id>`） */
const NAMESPACE = "kb";

export type KbDeleteDeps = {
  knowledge: Pick<KnowledgeStore, "get" | "delete">;
  log: (message: string) => void;
};

/** 削除の確認。[削除する]（`kb:del:<id>`）で消し、[やめる]（`kb:keep:<id>`）で何もしない */
export function kbDeletePrompt(entry: Pick<KbEntry, "id" | "title">): OutgoingMessage {
  const { id, title } = entry;
  return {
    text: `${title}（#${id}）を削除しますか？`,
    components: [
      {
        kind: "buttons",
        buttons: [
          { customId: `${NAMESPACE}:del:${id}`, label: "削除する", style: "danger" },
          { customId: `${NAMESPACE}:keep:${id}`, label: "やめる" },
        ],
      },
    ],
  };
}

export function kbDeletedText(entry: Pick<KbEntry, "id" | "title">): string {
  return `${entry.title}（#${entry.id}）を削除しました`;
}

/** kb_delete の確認の投稿（run のチャンネルに投稿する）。失敗したら投げる */
export function createConfirmKbDelete(deps: { gateway: Pick<Gateway, "sendMessage"> }): ConfirmKbDelete {
  return async (entry, context) => {
    await deps.gateway.sendMessage(context.channelId, kbDeletePrompt(entry));
  };
}

/** custom_id の id（1 以上の整数）。それ以外なら undefined */
function parseId(raw: string | undefined): number | undefined {
  return raw !== undefined && /^[1-9]\d*$/.test(raw) ? Number(raw) : undefined;
}

/**
 * 削除の確認の [削除する]（`kb:del:<id>`）と [やめる]（`kb:keep:<id>`）。どちらも確認メッセージを書き換えてボタンを外す。
 * 既に無い項目なら何もせず「古くなっています」にする。DB の状態で動くので、再起動の後でも押せる
 */
export function createKbDeleteComponent(deps: KbDeleteDeps): ComponentHandler {
  const { knowledge, log } = deps;
  return {
    namespace: NAMESPACE,
    async handle(interaction, responder) {
      const [, action, rawId] = interaction.customId.split(":");
      const id = parseId(rawId);
      if (id === undefined) throw new Error("kb の custom_id に id がありません");
      if (interaction.kind !== "button" || (action !== "del" && action !== "keep")) {
        throw new Error(`kb の不明な操作です（${interaction.kind} ${action ?? ""}）`);
      }
      if (action === "keep") {
        await responder.update({ text: knowledge.get(id) === undefined ? STALE_TEXT : KB_KEPT_TEXT, components: [] });
        return;
      }
      const deleted = knowledge.delete(id);
      if (deleted === undefined) {
        await responder.update({ text: STALE_TEXT, components: [] });
        return;
      }
      log("[削除する] でナレッジベースの項目を削除しました");
      await responder.update({ text: kbDeletedText(deleted), components: [] });
    },
  };
}
