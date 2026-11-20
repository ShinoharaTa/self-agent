// 取り込みの入口（`/cc take`・セレクト `cc:takepick`・確認の [取り込む] `cc:take:go:<id>`・[やめる] `cc:take:no:<id>`。docs/plan/takeover.md §3.5）。
// `/cc take` は取り込める物（待機と終わった物）だけのセレクトを本人にだけ出し、選ぶと打ったチャンネルに確認の文とボタンを出す。
// [取り込む] は本体（cc/takeover.ts）の confirm、[やめる] は cancel。押したサーバー・チャンネルが確認を出した所でなければ本人にだけ断る
// （オーナーの判定は振り分けの前に interactions.ts が行う）。振り分けは commands/cc.ts。
// リモコンの側（cc/channels.ts・cc/sender.ts・cc/replies.ts・cc/starter.ts・commands/cc-confirm.ts）と commands/cc.ts は import しない（消す段で触らない）
import type { CcTakeable, CcTakeover } from "../../cc/takeover.ts";
import { takeoverFailureText } from "../../cc/takeover-rules.ts";
import type { Gateway, Interaction } from "../../discord/gateway.ts";
import type { CcTakeoverStore } from "../../store/cc-takeovers.ts";
import type { CommandInteraction, ComponentHandler } from "../interactions.ts";
import { formatWallClock } from "../recurrence.ts";
import { clip } from "./tasks.ts";

export const TAKE_PICK_SELECT_ID = "cc:takepick";
/** セレクトに出す数（Discord は 25 件まで） */
export const TAKE_PICK_MAX = 25;
export const CC_TAKE_POSTED_REPLY = "取り込みの確認をこのチャンネルに出しました";
export const CC_TAKE_POST_FAILED_REPLY = "取り込みの確認を出せませんでした";
export const CC_TAKE_STALE_REPLY = "この確認はもう使えません。";
export const CC_TAKE_CANCELLED_TEXT = "取り込みをやめました。";

/** セレクトの選択肢のラベル・説明の上限（Discord は 100 字まで） */
const OPTION_MAX_LENGTH = 100;

export type CcTakeRuntime = {
  takeover: Pick<CcTakeover, "takeable" | "propose" | "confirm" | "cancel">;
  takeovers: Pick<CcTakeoverStore, "get" | "setConfirmMessage">;
  /** 確認の文を出す（本体が後で書き換えるので、本体と同じ既定の人格の Bot） */
  gateway: Pick<Gateway, "sendMessage">;
  /** プロジェクトのセッションの準備（false なら候補を読まずに not_ready の文） */
  ready: () => boolean;
  /** 今の一覧の実行中・判断待ちの数（takeable の後に呼ぶ） */
  counts: () => { running: number; waiting: number };
  /** 判断待ちで断るときに足す RC のリンク（無ければ足さない） */
  rcUrl: (sessionId: string) => string | undefined;
  timeZone: string;
};
/** main で後から作るので関数で渡す。連携が動いていなければ undefined */
export type CcTakeGetter = () => CcTakeRuntime | undefined;

type Responder = Parameters<ComponentHandler["handle"]>[1];

function errorKind(error: unknown): string {
  return error instanceof Error ? error.name : typeof error;
}

/** 取り込める物が無いときの応答（純関数） */
export function takeNoneReply(running: number, waiting: number): string {
  return `取り込めるセッションがありません（実行中 ${running}・判断待ち ${waiting}）。`;
}

/** セレクトの上の文（純関数）。出した数が全部より少なければ件数の行、選べない物があればその数の行を足す */
export function takePickPrompt(shown: number, total: number, running: number, waiting: number): string {
  const lines = ["取り込むセッションを選んでください（端末の Claude Code を終わらせて、新しいチャンネルで続けます）"];
  if (total > shown) lines.push(`新しい順の ${shown} 件です（ほか ${total - shown} 件）`);
  if (running + waiting > 0) lines.push(`実行中 ${running}・判断待ち ${waiting} は選べません`);
  return lines.join("\n");
}

/** セレクトの選択肢（純関数。先頭 TAKE_PICK_MAX 件。説明は 待機｜終了・プロジェクト・MM-DD HH:MM） */
export function takeOptions(items: readonly CcTakeable[], timeZone: string): Array<{ label: string; value: string; description: string }> {
  return items.slice(0, TAKE_PICK_MAX).map((item) => {
    const title = clip(item.title.replace(/\s+/g, " ").trim(), OPTION_MAX_LENGTH);
    const parts = [item.alive ? "待機" : "終了", item.project, item.at === undefined ? null : formatWallClock(new Date(item.at), timeZone).slice(5)];
    return {
      label: title === "" ? item.project : title,
      value: item.sessionId,
      description: clip(parts.filter((part) => part !== null).join("・"), OPTION_MAX_LENGTH),
    };
  });
}

/** `/cc take`: 取り込める物だけのセレクト（cc:takepick）を本人にだけ出す（一覧の読み取りに数秒かかりうるので先に保留する） */
export async function handleTakeCommand(
  runtime: CcTakeRuntime,
  _interaction: CommandInteraction,
  responder: Responder,
  _log: (message: string) => void,
): Promise<void> {
  await responder.defer(true);
  if (!runtime.ready()) {
    await responder.reply({ text: takeoverFailureText("not_ready", false), ephemeral: true });
    return;
  }
  const items = await runtime.takeover.takeable();
  const { running, waiting } = runtime.counts();
  if (items.length === 0) {
    await responder.reply({ text: takeNoneReply(running, waiting), ephemeral: true });
    return;
  }
  await responder.reply({
    text: takePickPrompt(Math.min(items.length, TAKE_PICK_MAX), items.length, running, waiting),
    ephemeral: true,
    components: [
      {
        kind: "select",
        select: {
          customId: TAKE_PICK_SELECT_ID,
          placeholder: "取り込むセッション",
          minValues: 1,
          maxValues: 1,
          options: takeOptions(items, runtime.timeZone),
        },
      },
    ],
  });
}

/**
 * cc:takepick（形は commands/cc.ts が確かめた後）: 確認（propose）を作り、通ればその文とボタンを打ったチャンネルに出して記録する
 * （出せなければ確認をやめる）。断られたらその文を本人にだけ返す（判断待ちなら RC のリンクを足す）
 */
export async function handleTakePick(
  runtime: CcTakeRuntime,
  pick: { guildId: string; channelId: string; sessionId: string },
  responder: Responder,
  log: (message: string) => void,
): Promise<void> {
  const { guildId, channelId, sessionId } = pick;
  await responder.defer(true);
  const proposed = await runtime.takeover.propose({ sessionId, entry: "discord", guildId, confirmChannelId: channelId });
  if (!proposed.ok) {
    const url = proposed.reason === "waiting" ? runtime.rcUrl(sessionId) : undefined;
    await responder.reply({ text: url === undefined ? proposed.text : `${proposed.text}\n${url}`, ephemeral: true, suppressEmbeds: true });
    return;
  }
  try {
    const messageId = await runtime.gateway.sendMessage(channelId, proposed.message);
    runtime.takeovers.setConfirmMessage(proposed.id, messageId);
  } catch (error) {
    log(`Claude Code: 取り込みの確認を出せませんでした（#${proposed.id}、${errorKind(error)}）`);
    runtime.takeover.cancel(proposed.id);
    await responder.reply({ text: CC_TAKE_POST_FAILED_REPLY, ephemeral: true });
    return;
  }
  await responder.reply({ text: CC_TAKE_POSTED_REPLY, ephemeral: true });
}

/**
 * 確認の [取り込む]（go）・[やめる]。行が Discord の確認待ちで、押したサーバー・チャンネルが確認を出した所でなければ本人にだけ断り、何も呼ばない。
 * [取り込む] は保留してから confirm（結果の文は本体が確認の文に出す。書き換えられなかったときだけ押された 1 通を書き換える）
 */
export async function handleTakeButton(
  runtime: CcTakeRuntime,
  go: boolean,
  id: number,
  interaction: Pick<Extract<Interaction, { kind: "button" }>, "guildId" | "channelId">,
  responder: Responder,
  log: (message: string) => void,
): Promise<void> {
  const stale = (): Promise<void> => responder.reply({ text: CC_TAKE_STALE_REPLY, ephemeral: true });
  const row = runtime.takeovers.get(id);
  if (
    row === undefined ||
    row.entry !== "discord" ||
    row.state !== "awaiting_confirm" ||
    row.guildId !== interaction.guildId ||
    row.confirmChannelId === null ||
    row.confirmChannelId !== interaction.channelId
  ) {
    await stale();
    return;
  }
  if (!go) {
    if (!runtime.takeover.cancel(id)) {
      await stale();
      return;
    }
    try {
      await responder.update({ text: CC_TAKE_CANCELLED_TEXT, components: [] });
    } catch (error) {
      log(`Claude Code: 取り込みの確認の文を書き換えられませんでした（#${id}、${errorKind(error)}）`);
    }
    return;
  }
  await responder.deferUpdate();
  const result = await runtime.takeover.confirm(id);
  // 押す間に確認待ちでなくなった（二度押し・失効・[やめる]）
  if (!result.ok && result.reason === "stale") {
    await stale();
    return;
  }
  if (result.edited) return;
  try {
    await responder.update({ text: result.text, components: [] });
  } catch (error) {
    log(`Claude Code: 取り込みの結果を確認の文に出せませんでした（#${id}、${errorKind(error)}）`);
  }
}
