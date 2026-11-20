import { isProjectPermissionMode, PROJECT_PERMISSION_MODES } from "../../agent/runner.ts";
import type { CommandDef } from "../../discord/gateway.ts";
import type { CommandHandler } from "../interactions.ts";
import {
  MODE_BUSY_REPLY,
  MODE_CLOSED_REPLY,
  MODE_INVALID_REPLY,
  MODE_LABELS,
  MODE_NOT_PROJECT_REPLY,
  MODE_NOT_SESSION_REPLY,
  modeChangedReply,
  modeNowText,
  modeSameText,
  type SessionModeDeps,
  sessionModeOf,
  setSessionMode,
} from "../session-mode.ts";

export type ModeCommandDeps = SessionModeDeps;

/** /mode の引数の名前 */
export const MODE_OPTION = "mode";

/** /mode の定義。選択肢は default・acceptEdits・plan の 3 つだけ（name は表示の文、value は識別子） */
export const MODE_COMMAND_DEF: CommandDef = {
  name: "mode",
  description: "プロジェクトのセッションの許可のモードを見る・変える",
  options: [
    {
      type: "string",
      name: MODE_OPTION,
      description: "新しいモード（省くと今のモードを表示）",
      required: false,
      choices: PROJECT_PERMISSION_MODES.map((mode) => ({ name: MODE_LABELS[mode], value: mode })),
    },
  ],
};

/**
 * `/mode [mode]`: プロジェクトのセッションの許可のモードを見る・変える（app/session-mode.ts）。DB だけの同期の処理なので保留しない。
 * 変えたときだけ全員に見える返信（そのままチャンネルの投稿になる）、ほかは本人にだけ
 */
export function createModeCommand(deps: ModeCommandDeps): CommandHandler {
  return {
    def: MODE_COMMAND_DEF,
    async handle(interaction, responder) {
      const guildId = interaction.guildId;
      const channelId = interaction.channelId;
      if (guildId === null || channelId === null) {
        await responder.reply({ text: MODE_NOT_SESSION_REPLY, ephemeral: true });
        return;
      }
      const now = sessionModeOf(guildId, channelId, deps);
      if (now.result !== "ok") {
        await responder.reply({ text: refusalText(now.result), ephemeral: true });
        return;
      }
      const raw = interaction.options[MODE_OPTION];
      if (raw === undefined || raw === null) {
        await responder.reply({ text: modeNowText(now.mode), ephemeral: true });
        return;
      }
      const value = typeof raw === "string" ? raw.trim() : "";
      if (!isProjectPermissionMode(value)) {
        await responder.reply({ text: MODE_INVALID_REPLY, ephemeral: true });
        return;
      }
      const outcome = setSessionMode({ guildId, channelId, mode: value, by: "discord" }, deps);
      switch (outcome.result) {
        case "changed":
          await responder.reply({ text: modeChangedReply(value), ephemeral: false });
          return;
        case "unchanged":
          await responder.reply({ text: modeSameText(value), ephemeral: true });
          return;
        case "busy":
          await responder.reply({ text: MODE_BUSY_REPLY, ephemeral: true });
          return;
        default:
          await responder.reply({ text: refusalText(outcome.result), ephemeral: true });
      }
    },
  };
}

function refusalText(result: "not_session" | "closed" | "not_project"): string {
  switch (result) {
    case "closed":
      return MODE_CLOSED_REPLY;
    case "not_project":
      return MODE_NOT_PROJECT_REPLY;
    default:
      return MODE_NOT_SESSION_REPLY;
  }
}
