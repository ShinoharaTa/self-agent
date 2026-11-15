import { listProjects } from "../../cc/starter.ts";
import type { CommandDef } from "../../discord/gateway.ts";
import type { CommandHandler } from "../interactions.ts";
import { type CommandResponse, commandResponse, type OwnerPosts, type PersonaRouter } from "../personas.ts";
import { MOVE_FAILED_TEXT, type MoveDeps, type MoveOutcome, moveRefusalText, movedPostText, moveTopic, parsePlace } from "../topic-move.ts";
import { PROJECT_CHOICES_MAX } from "./new.ts";

export type MoveCommandDeps = MoveDeps & {
  /** チャンネルの持ち主の人格（/renew と同じ。足した人格の話題は moveTopic が断るので、保留の形を揃えるためだけに使う） */
  personas?: Pick<PersonaRouter, "ownerOf" | "gatewayFor">;
  /** 受け付けた後の結果を応答に出せなかったときに、同じ文をチャンネルへ投稿する口（Web のルートと同じ） */
  ownerPosts: Pick<OwnerPosts, "send">;
};

export const MOVE_NOT_SESSION_REPLY = "/move は話題のチャンネルで使ってください";

/** /move の場所の引数の名前 */
export const PLACE_OPTION = "place";

/**
 * /move の定義。projects があれば、先頭に General、続けてプロジェクトの名前を選択肢にする（値は general・p:<名前>）。
 * 合計が 25 を超えたら・連携が無ければ（projects が undefined）、選択肢を出さず文字列で受ける
 */
export function moveCommandDef(projects: readonly string[] | undefined): CommandDef {
  const choices = projects === undefined ? undefined : [{ name: "General", value: "general" }, ...projects.map((name) => ({ name, value: `p:${name}` }))];
  return {
    name: "move",
    description: "この話題の場所（プロジェクト）を変えます",
    options: [
      {
        type: "string",
        name: PLACE_OPTION,
        description: "新しい場所",
        required: true,
        ...(choices === undefined || choices.length > PROJECT_CHOICES_MAX ? { maxLength: 66 } : { choices }),
      },
    ],
  };
}

/**
 * `/move place`: 話題の場所を変える（app/topic-move.ts の moveTopic）。候補は登録のときに 1 回だけ組み立てる。
 * 断りは本人にだけ返し、受け付けたら公開で保留して（要点のターンは 3 秒を超える）、結果をチャンネルに残す
 */
export function createMoveCommand(deps: MoveCommandDeps): CommandHandler {
  const places = deps.projectSessions?.places;
  const generalDir = places?.generalDir;
  return {
    def: moveCommandDef(places === undefined ? undefined : listProjects(places)),
    async handle(interaction, responder) {
      // 許可サーバー以外（DM を含む）は interactions.ts で弾いている
      const guildId = interaction.guildId;
      if (guildId === null) throw new Error("サーバー外で /move が呼ばれました");
      const channelId = interaction.channelId;
      if (channelId === null) {
        await responder.reply({ text: MOVE_NOT_SESSION_REPLY, ephemeral: true });
        return;
      }
      const raw = interaction.options[PLACE_OPTION];
      const value = typeof raw === "string" ? raw.trim() : "";
      // 選択肢の無い文字列では名前だけ（General・プロジェクトの名前）でも受ける
      const place = parsePlace(value, generalDir) ?? parsePlace(`p:${value}`, generalDir);
      if (place === undefined) {
        await responder.reply({ text: moveRefusalText("invalid_project"), ephemeral: true });
        return;
      }
      let response: CommandResponse | undefined;
      let outcome: MoveOutcome;
      try {
        outcome = await moveTopic({ guildId, channelId, place, by: "discord" }, deps, () => {
          response = commandResponse(deps.personas, channelId, responder, deps.log);
          return response.defer();
        });
      } catch (error) {
        // 受け付ける前の例外は今までどおり外へ。受け付けた後なら失敗の文を出して終える
        if (response === undefined) throw error;
        deps.log(`/move の場所の付け替えに失敗しました（${errorName(error)}）`);
        await showResult(deps, response, channelId, MOVE_FAILED_TEXT);
        return;
      }
      if (outcome.result === "moved" || outcome.result === "failed") {
        if (response === undefined) throw new Error("/move の結果を保留せずに受け取りました");
        await showResult(deps, response, channelId, outcome.result === "moved" ? movedPostText(outcome, generalDir) : MOVE_FAILED_TEXT);
        return;
      }
      if (response !== undefined) {
        // 受け付けた後（キューの中）で断った
        await showResult(deps, response, channelId, `場所を変えられませんでした: ${moveRefusalText(outcome.result)}`);
        return;
      }
      await responder.reply({
        text: outcome.result === "not_session" ? MOVE_NOT_SESSION_REPLY : moveRefusalText(outcome.result),
        ephemeral: true,
      });
    },
  };
}

/**
 * 受け付けた後の結果を保留した応答に出す。出せなければ（保留の失敗・応答の期限切れなど）同じ文をチャンネルへ投稿し、
 * それも失敗したら log だけ（投げない。場所はもう変わっていることがある）
 */
async function showResult(deps: MoveCommandDeps, response: CommandResponse, channelId: string, text: string): Promise<void> {
  try {
    await response.show({ text });
    return;
  } catch (error) {
    deps.log(`/move の結果を応答に出せなかったため、チャンネルに投稿します（${errorName(error)}）`);
  }
  try {
    await deps.ownerPosts.send(channelId, text);
  } catch (error) {
    deps.log(`/move の結果をチャンネルに投稿できませんでした（${errorName(error)}）`);
  }
}

function errorName(error: unknown): string {
  return error instanceof Error ? error.name : typeof error;
}
