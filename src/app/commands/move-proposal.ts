// 右腕の場所を変える確認のボタン（名前空間 `move:`。docs/plan/web-ui-v3.md §4・§6.3。#369 の M6e）。[変える]（`move:ok:<id>`）・[このまま]（`move:keep:<id>`）。
// 処理は app/topic-proposals.ts の accept・keep で、札の書き換えも本体が行う。ここは応答だけ（先に deferUpdate してから結果で分ける）。
// 押したのがオーナーか・許可したサーバーかは interactions.ts が見る。log に話題の ID・チャンネル ID・場所の名前を出さない
import type { ComponentHandler } from "../interactions.ts";
import { MOVE_NAMESPACE, type TopicProposals } from "../topic-proposals.ts";
import { moveRefusalText } from "../topic-move.ts";
import { STALE_TEXT } from "./delete.ts";

/** 本体が例外を出したときに、押した人にだけ出す文 */
export const MOVE_PROPOSAL_FAILED_REPLY = "場所を変えられませんでした";

const CUSTOM_ID = new RegExp(`^${MOVE_NAMESPACE}:(ok|keep):(\\d{1,10})$`);

export type MoveProposalButtonsDeps = {
  proposals: Pick<TopicProposals, "accept" | "keep" | "channelOf">;
  log: (message: string) => void;
};

function errorName(error: unknown): string {
  return error instanceof Error ? error.name : typeof error;
}

/**
 * [変える]・[このまま]。accepted・kept と、断られて札が断りの文になった（kept が false）ときは deferUpdate だけ。
 * custom_id の形が違うときは押した投稿を STALE_TEXT にしてボタンを外す。古い（stale）・押されたチャンネルが確認の話題と違うときは
 * 札を書き換えず（本体が書いた「変えています」「期限が切れました」を残す）、押した人にだけ STALE_TEXT。待てば通る断り（kept が true）は札を残し、押した人にだけ断りの文
 */
export function createMoveProposalButtons(deps: MoveProposalButtonsDeps): ComponentHandler {
  const { proposals, log } = deps;
  return {
    namespace: MOVE_NAMESPACE,
    async handle(interaction, responder) {
      const match = CUSTOM_ID.exec(interaction.customId);
      if (match === null || interaction.kind !== "button") {
        await responder.update({ text: STALE_TEXT, components: [] });
        return;
      }
      const id = Number(match[2]);
      try {
        await responder.deferUpdate();
        // 別のチャンネルの札（行が無い id も）は古い確認として扱い、本体を呼ばない
        if (proposals.channelOf(id) !== interaction.channelId) {
          await responder.reply({ text: STALE_TEXT, ephemeral: true });
          return;
        }
        if (match[1] === "keep") {
          const kept = await proposals.keep(id);
          if (kept.result === "stale") await responder.reply({ text: STALE_TEXT, ephemeral: true });
          return;
        }
        const accepted = await proposals.accept(id);
        if (accepted.result === "stale") {
          await responder.reply({ text: STALE_TEXT, ephemeral: true });
        } else if (accepted.result === "refused" && accepted.kept) {
          await responder.reply({ text: moveRefusalText(accepted.reason), ephemeral: true });
        }
      } catch (error) {
        log(`場所を変える確認のボタンを処理できませんでした（${errorName(error)}）`);
        try {
          await responder.reply({ text: MOVE_PROPOSAL_FAILED_REPLY, ephemeral: true });
        } catch (replyError) {
          log(`場所を変える確認のボタンに応答できませんでした（${errorName(replyError)}）`);
        }
      }
    },
  };
}
