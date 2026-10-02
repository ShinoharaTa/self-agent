import type { ModalDef } from "../../discord/gateway.ts";
import type { ComponentHandler } from "../interactions.ts";
import { type NewSessionDeps, startTopicSession, TITLE_MAX_LENGTH } from "./new.ts";
import { type SessionsDeps, sessionListText } from "./sessions.ts";
import { HOME_NAMESPACE } from "./setup.ts";
import { taskListMessage, type TasksDeps } from "./tasks.ts";

/** [新しいセッション] で開くモーダルの custom_id と、題名の入力欄の custom_id */
const NEW_MODAL_ID = `${HOME_NAMESPACE}:new-modal`;
const TITLE_FIELD_ID = "title";

export type HomeDeps = NewSessionDeps & TasksDeps & SessionsDeps;

/** [新しいセッション] のモーダル: 題名（1〜100 字）の 1 項目 */
export const NEW_SESSION_MODAL: ModalDef = {
  customId: NEW_MODAL_ID,
  title: "新しいセッション",
  fields: [{ customId: TITLE_FIELD_ID, label: "題名", required: true, maxLength: TITLE_MAX_LENGTH }],
};

/**
 * ホームパネル（/setup が #inbox にピン留めする）のボタンとモーダル。
 * [新しいセッション]（`home:new`）→ 題名のモーダル（`home:new-modal`）→ /new と同じ作成。
 * [タスク一覧]（`home:tasks`）は /tasks と同じ、[待ちのセッション]（`home:waiting`）は待ちだけの一覧を本人にだけ表示する
 */
export function createHomeComponent(deps: HomeDeps): ComponentHandler {
  const { tasks, topicSessions } = deps;
  return {
    namespace: HOME_NAMESPACE,
    async handle(interaction, responder) {
      // 許可サーバー以外（DM を含む）は interactions.ts で弾いている
      const guildId = interaction.guildId;
      if (guildId === null) throw new Error("サーバー外でホームパネルが操作されました");
      const action = interaction.customId.split(":")[1];
      if (interaction.kind === "button" && action === "new") {
        await responder.showModal(NEW_SESSION_MODAL);
        return;
      }
      if (interaction.kind === "modal" && interaction.customId === NEW_MODAL_ID) {
        const title = interaction.fields[TITLE_FIELD_ID];
        if (title === undefined) throw new Error("新しいセッションのモーダルに題名がありません");
        await startTopicSession(guildId, title, responder, deps, "ホームパネルから");
        return;
      }
      if (interaction.kind === "button" && action === "tasks") {
        await responder.reply({ ...taskListMessage(tasks), ephemeral: true });
        return;
      }
      if (interaction.kind === "button" && action === "waiting") {
        const text = sessionListText(topicSessions, guildId, ["waiting"], interaction.createdAt);
        await responder.reply({ text, ephemeral: true });
        return;
      }
      throw new Error(`home の不明な操作です（${interaction.kind} ${action ?? ""}）`);
    },
  };
}
