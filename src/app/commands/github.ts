// #github の [対応] と、その結果の返信のボタン（docs/plan/github-notifications.md §5.6。CC6）。名前空間 `gh:`。
// [対応]（`gh:act:<通知の行 ID>`。#github の投稿に付けるのは github/poller.ts の githubActButton）は本人にだけの保留の後に app/github-handoff.ts の act を呼び、結果を本人にだけ返す。
// セッションが無ければ [起動して送る]（`gh:start:<通知の行 ID>`）、積んだら [取り消す]（`gh:cancel:<送信の ID>`）をその返信に付ける。
// 送り先・本文は押した時点の DB と地図だけで決め、custom_id から読むのは整数の ID だけ（形が違えば古い扱い）
import { escapeDiscordText } from "../../discord/escape.ts";
import type { ButtonDef, OutgoingMessage } from "../../discord/gateway.ts";
import { ccRepliesIn } from "./cc-confirm.ts";
import { type GithubHandoff, type GithubHandoffResult, handoffResultText } from "../github-handoff.ts";
import type { ComponentHandler } from "../interactions.ts";

/** ボタンの custom_id の名前空間（`gh:<action>:<id>`） */
const NAMESPACE = "gh";

/** 古い・形の違うボタン */
export const GITHUB_STALE_TEXT = "この操作は古くなっています";
/** [対応] を使えない（SELF_AGENT_CC が無効・起動時に準備できなかった） */
export const GITHUB_HANDOFF_UNAVAILABLE_TEXT = "Claude Code への送り込みは使えません（SELF_AGENT_CC と git が要ります）";
/** [取り消す] を押した後 */
export const GITHUB_CANCELLED_TEXT = "対応依頼を取り消しました";

export type GithubComponentDeps = {
  /** [対応] の処理。起動時に準備できなければ undefined（押されたら本人にだけ断る） */
  githubHandoff: () => Pick<GithubHandoff, "act" | "start" | "cancel"> | undefined;
  log: (message: string) => void;
};

/** 結果の返信（純関数）: 文と、起動の確認なら [起動して送る]、積んだなら [取り消す] */
export function githubResultMessage(notificationId: number, result: GithubHandoffResult): OutgoingMessage {
  const buttons: ButtonDef[] = [];
  if (result.kind === "no_session" && result.dir !== undefined) {
    buttons.push({ customId: `${NAMESPACE}:start:${notificationId}`, label: "起動して送る", style: "primary" });
  }
  if ((result.kind === "queued" || result.kind === "already" || result.kind === "started") && result.sendId !== undefined) {
    if (result.kind === "started" || result.state === "queued") {
      buttons.push({ customId: `${NAMESPACE}:cancel:${result.sendId}`, label: "取り消す" });
    }
  }
  // 返事は Claude Code のチャンネルに出る（CC11。Web のトーストには出さない）
  const where = result.kind === "queued" && result.channelId !== undefined ? `（${ccRepliesIn(result.channelId)}）` : "";
  return { text: `${handoffResultText(result, escapeDiscordText)}${where}`, components: buttons.length === 0 ? [] : [{ kind: "buttons", buttons }] };
}

/** `gh:<act|start|cancel>:<1 以上の整数>` を読む。形が違えば undefined */
export function parseGithubCustomId(customId: string): { action: "act" | "start" | "cancel"; id: number } | undefined {
  const match = /^gh:(act|start|cancel):([1-9]\d{0,15})$/.exec(customId);
  if (match === null) return undefined;
  const id = Number(match[2]);
  return Number.isSafeInteger(id) ? { action: match[1] as "act" | "start" | "cancel", id } : undefined;
}

/**
 * [対応]（#github の投稿。本人にだけの返信で結果を出す）・[起動して送る]・[取り消す]（どちらもその返信の書き換え）。
 * 形の違う custom_id・ボタン以外は本人にだけ「古くなっています」
 */
export function createGithubComponent(deps: GithubComponentDeps): ComponentHandler {
  return {
    namespace: NAMESPACE,
    async handle(interaction, responder) {
      const parsed = interaction.kind === "button" ? parseGithubCustomId(interaction.customId) : undefined;
      if (parsed === undefined) {
        await responder.reply({ text: GITHUB_STALE_TEXT, ephemeral: true });
        return;
      }
      const handoff = deps.githubHandoff();
      if (handoff === undefined) {
        await responder.reply({ text: GITHUB_HANDOFF_UNAVAILABLE_TEXT, ephemeral: true });
        return;
      }
      if (parsed.action === "cancel") {
        const result = handoff.cancel(parsed.id);
        if (result === "stale") {
          await responder.reply({ text: GITHUB_STALE_TEXT, ephemeral: true });
          return;
        }
        deps.log(`GitHub の対応依頼を取り消しました（送信 #${parsed.id}）`);
        await responder.update({ text: GITHUB_CANCELLED_TEXT, components: [] });
        return;
      }
      if (parsed.action === "act") {
        // 送り先を決めるのに入力待ちを 2 回撮るので 3 秒を超えうる。結果は本人にだけ
        await responder.defer(true);
        // そのセッションの Claude Code のチャンネルは押したサーバーに作る（CC11）
        const result = await handoff.act(parsed.id, interaction.guildId ?? undefined);
        await responder.reply({ ...githubResultMessage(parsed.id, result), ephemeral: true });
        return;
      }
      // [起動して送る]: 確認の返信を書き換える。同じ通知を処理している途中（二重の押下）なら、返信は書き換えずに本人にだけ返す
      await responder.deferUpdate();
      const result = await handoff.start(parsed.id, interaction.guildId ?? undefined);
      if (result.kind === "busy") {
        await responder.reply({ ...githubResultMessage(parsed.id, result), ephemeral: true });
        return;
      }
      await responder.update(githubResultMessage(parsed.id, result));
    },
  };
}
