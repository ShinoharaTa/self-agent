// 実行中のターンの [中断] と、手順の上限で止まったターンの [続ける]（名前空間 `turn:`）。どちらもセッションのチャンネルの発言のターンにだけ付く
import type { ButtonDef } from "../../discord/gateway.ts";
import type { ResolveChannel } from "../access.ts";
import type { Handler } from "../handler.ts";
import type { ComponentHandler } from "../interactions.ts";

/** 1 ターンのツール呼び出しの上限（maxTurns）で止まったときの返信。会話は残っているので、もう一度送れば（[続ける] でも）続きから進む */
export const MAX_TURNS_REPLY = "途中までで止めました（手順が多すぎました）。続ける場合はもう一度送ってください。";
/**
 * [中断] でそのチャンネルに実行中のターンが無い・実行中のターンの番号と違う（前のターンのボタン）、
 * [続ける] でそのチャンネルが受け付けるセッションでなくなっていたときの応答（本人にだけ）
 */
export const STALE_TURN_REPLY = "この操作は古くなっています";

/** ボタンの custom_id の名前空間（`turn:abort:<channelId>:<turnSeq>`・`turn:continue:<channelId>`） */
const NAMESPACE = "turn";

export type TurnControlsDeps = {
  /** [続ける] のチャンネルが今も受け付けるセッションか */
  resolveChannel: ResolveChannel;
  /** 実行中のターンの中断と、[続ける] のターンの投入（handler.ts） */
  turns: Pick<Handler, "abortTurn" | "continueTurn">;
  log: (message: string) => void;
};

/** 途中経過のメッセージに付ける [中断]（`turn:abort:<channelId>:<turnSeq>`。turnSeq は handler がターンごとに振る番号） */
export function abortTurnButton(channelId: string, turnSeq: number): ButtonDef {
  return { customId: `${NAMESPACE}:abort:${channelId}:${turnSeq}`, label: "中断", style: "danger" };
}

/** 手順の上限で止まった返信に付ける [続ける]（`turn:continue:<channelId>`） */
export function continueTurnButton(channelId: string): ButtonDef {
  return { customId: `${NAMESPACE}:continue:${channelId}`, label: "続ける" };
}

/**
 * [中断]（`turn:abort:<channelId>:<turnSeq>`）: そのチャンネルで実行中のターンが turnSeq のものなら abort して deferUpdate する（表示はターンの終わりに handler が書き換える）。
 * [続ける]（`turn:continue:<channelId>`）: ボタンを外し、そのチャンネルに「続けてください」をオーナーの発言と同じ経路で 1 ターン入れる。
 * どちらも古ければ（実行中のターンが無い・番号が違う・番号が無い・受け付けるセッションでない）本人にだけ「この操作は古くなっています」と返す
 */
export function createTurnControlsComponent(deps: TurnControlsDeps): ComponentHandler {
  const { resolveChannel, turns, log } = deps;
  return {
    namespace: NAMESPACE,
    async handle(interaction, responder) {
      const [, action, channelId, turnSeqText] = interaction.customId.split(":");
      if (channelId === undefined || channelId === "") throw new Error("turn の custom_id にチャンネルがありません");
      if (interaction.kind !== "button" || (action !== "abort" && action !== "continue")) {
        throw new Error(`turn の不明な操作です（${interaction.kind} ${action ?? ""}）`);
      }
      // 許可サーバー以外（DM を含む）は interactions.ts で弾いている
      const guildId = interaction.guildId;
      if (guildId === null) throw new Error("サーバー外で turn のボタンが押されました");
      if (action === "abort") {
        // 番号の無い・数字でない custom_id は、どのターンの番号とも一致しないので古いものとして扱う
        const turnSeq = turnSeqText !== undefined && /^\d+$/.test(turnSeqText) ? Number(turnSeqText) : undefined;
        if (turnSeq === undefined || !turns.abortTurn(channelId, turnSeq)) {
          await responder.reply({ text: STALE_TURN_REPLY, ephemeral: true });
          return;
        }
        log(`[中断] でターンを中断しました（guild=${guildId}）`);
        await responder.deferUpdate();
        return;
      }
      if (resolveChannel(guildId, channelId) !== "session") {
        await responder.reply({ text: STALE_TURN_REPLY, ephemeral: true });
        return;
      }
      await responder.update({ text: MAX_TURNS_REPLY, components: [] });
      log(`[続ける] でターンを続けます（guild=${guildId}）`);
      // 日時ヘッダは押した時刻。返信まで待つ（reject しない）
      await turns.continueTurn(guildId, channelId, interaction.createdAt);
    },
  };
}
