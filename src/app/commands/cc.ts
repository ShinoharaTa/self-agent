// Claude Code のボタン（名前空間 `cc:`。docs/plan/claude-code-sessions.md §5.2）。custom_id は `cc:<種類>:<操作>:<id>` で、2 つ目の語で振り分ける。
// 許可の要求の `cc:perm:allow|always|deny:<id>`（CC5c）と、SDK のツール cc_send・cc_start の確認の `cc:send:<id>`・`cc:start:<id>`・
// `cc:keep:send|start:<id>`（CC7。処理は commands/cc-confirm.ts）、返事の投稿の [追いかけをやめる] の `cc:unfollow:<cc_replies の id>`（CC8。cc/replies.ts）。
// 許可の要求は Web と同じ permission-hold.ts の answer を通す（先に押した方が勝つ）。決めたら #system か Claude Code のチャンネル（CC12）の 1 通を応答で書き換えてボタンを外し
// （応答に失敗したら、その 1 通を gateway で書き換えて代える）、古ければ（Web・端末・RC で先に答えられた・時間切れ・停止・SELF_AGENT_CC が無効）
// 本人にだけ「この操作は古くなっています」。
// /cc（SELF_AGENT_CC=1 のときだけ登録。docs/plan/claude-code-channels.md §3.8。CC10 は open だけ）は一覧を rankSessions の順に最大 25 件の
// セレクト `cc:pick` で本人にだけ出し、選ぶとそのセッションの Discord のチャンネルを作る（cc/channels.ts の openChannel。origin command）。
// `/cc cancel`（CC11）は Claude Code のチャンネルの中で、そのセッションの届け待ち（queued）を全部取り消す（本人にだけ件数を返す）。
// `/cc close`（CC13）は Claude Code のチャンネルの中で、そのチャンネルを閉じて完了へ移す（結果はチャンネルに出す）。
// 終わったチャンネルの [起動して続ける]（`cc:resume:<channel_id>:<message_id>`）・[やめる]（`cc:resume:keep:<channel_id>:<message_id>`）は
// cc/channels.ts の resume・keepEnded（CC13）。削除の確認の [削除する]（`cc:del:<channel_id>`）・[残す]（`cc:del:keep:<channel_id>`）は
// commands/delete.ts に倣い、記録した今の確認のボタンで、チャンネルが ended のときだけ動く（DB だけで動くので SELF_AGENT_CC が無効でも押せる）
import {
  type CcChannelFailure,
  type CcChannels,
  type CcOpenResult,
  ccDeletedText,
  ccKeptText,
  CC_CHANNEL_CLOSED_TEXT,
  CC_RESUME_KEPT_TEXT,
  CC_RESUME_STALE_TEXT,
} from "../../cc/channels.ts";
import type { CcChannelStore } from "../../store/cc-channels.ts";
import type { ChannelOpsQueue } from "../channel-ops.ts";
import { ALREADY_HANDLED_TEXT, STALE_TEXT } from "./delete.ts";
import type { CcState } from "../../cc/registry.ts";
import type { CcAnswerResult, CcPermissionDecision } from "../../cc/permission-hold.ts";
import { unfollowByReply, unfollowedText } from "../../cc/replies.ts";
import type { CcReplyStore } from "../../store/cc-replies.ts";
import type { CcSessionStore } from "../../store/cc-sessions.ts";
import type { Gateway, OutgoingMessage } from "../../discord/gateway.ts";
import { isUuid } from "../../cc/agents.ts";
import type { GuildSettingsStore } from "../../store/guild-settings.ts";
import type { CommandHandler, ComponentHandler } from "../interactions.ts";
import { clip } from "./tasks.ts";
import { type CcConfirmButtons, type CcConfirmDeps, createCcConfirmButtons } from "./cc-confirm.ts";
import { STALE_TURN_REPLY } from "./turn-controls.ts";

const NAMESPACE = "cc";
/** /cc open のセレクト */
const PICK_SELECT_ID = `${NAMESPACE}:pick`;
/** セレクトの選択肢のラベル・説明の上限（Discord は 100 字まで） */
const OPTION_MAX_LENGTH = 100;

/** /cc と cc:pick が使うチャンネルの操作（SELF_AGENT_CC=1 で動いているときだけ。main で後から作るので関数で渡す） */
export type CcChannelsGetter = () => Pick<CcChannels, "openChannel" | "pickItems" | "cancelQueued" | "close" | "resume" | "keepEnded"> | undefined;

/** Claude Code の連携が動いていないとき（hook の受け口の設定が無いなど） */
export const CC_UNAVAILABLE_REPLY = "Claude Code の連携が動いていません";
export const CC_NOT_SET_UP_REPLY = "カテゴリ「Claude Code」がありません。/setup を実行してください";
export const CC_NO_SESSIONS_REPLY = "Claude Code のセッションがありません";
export const CC_CANCEL_NOT_CHANNEL_REPLY = "Claude Code のチャンネルで実行してください";
export const CC_CANCEL_NONE_REPLY = "届け待ちはありません";

/** /cc close で取り消した届け待ちの 1 行（純関数） */
export function ccClosedCancelledText(count: number): string {
  return `閉じたので届け待ちを ${count} 件取り消しました`;
}

/** /cc close の応答（純関数。closed はチャンネルに出す） */
export function closeReply(closed: ReturnType<CcChannels["close"]>): { text: string; ephemeral: boolean } {
  switch (closed.result) {
    case "closed":
      return {
        text: closed.cancelled > 0 ? `${CC_CHANNEL_CLOSED_TEXT}\n${ccClosedCancelledText(closed.cancelled)}` : CC_CHANNEL_CLOSED_TEXT,
        ephemeral: false,
      };
    case "not_channel":
      return { text: CC_CANCEL_NOT_CHANNEL_REPLY, ephemeral: true };
    case "resuming":
      return { text: "起動中です。少し待ってから実行してください", ephemeral: true };
    case "ended":
      return { text: "このチャンネルは既に閉じています", ephemeral: true };
  }
}

/** /cc cancel の応答（純関数） */
export function cancelReply(count: number | undefined): string {
  if (count === undefined) return CC_CANCEL_NOT_CHANNEL_REPLY;
  return count === 0 ? CC_CANCEL_NONE_REPLY : `届け待ちを ${count} 件取り消しました`;
}

const STATE_LABEL: Readonly<Record<CcState, string>> = { needs_input: "判断待ち", running: "実行中", idle: "待機" };

/** 作れなかった理由の応答（/cc open） */
const OPEN_FAILURE_REPLY: Readonly<Record<CcChannelFailure, string>> = {
  not_found: "このセッションは一覧にありません",
  not_in_tmux: "tmux の外のセッションにはチャンネルを作れません",
  not_set_up: CC_NOT_SET_UP_REPLY,
  full: "カテゴリ「Claude Code」が満杯（50）のため作れません。完了したチャンネルを消してください",
  failed: "チャンネルを作れませんでした",
};

/** openChannel の結果の応答（純関数） */
export function openResultReply(result: CcOpenResult): string {
  if (result.ok) return `チャンネルを作りました: <#${result.channelId}>`;
  if (result.reason === "exists") return `このセッションのチャンネルは既にあります: <#${result.channelId}>`;
  return OPEN_FAILURE_REPLY[result.reason];
}

export type CcCommandDeps = {
  ccChannels: CcChannelsGetter;
  /** /setup 前のサーバー（カテゴリ「Claude Code」が無い）では断る */
  guildSettings: Pick<GuildSettingsStore, "ccCategoryId">;
  log: (message: string) => void;
};

/** `/cc open`: Claude Code のセッションを選ぶセレクトを本人にだけ出す（選んだら cc:pick でチャンネルを作る） */
export function createCcCommand(deps: CcCommandDeps): CommandHandler {
  return {
    def: {
      name: "cc",
      description: "Claude Code のセッションの Discord のチャンネルを操作します",
      subcommands: [
        { name: "open", description: "Claude Code のセッションを選んで、そのチャンネルを作ります" },
        { name: "cancel", description: "このチャンネルのセッションへの届け待ちを取り消します" },
        { name: "close", description: "このチャンネルを閉じて完了に移します（書くと起動して続けられます）" },
      ],
    },
    async handle(interaction, responder) {
      if (interaction.subcommand !== "open" && interaction.subcommand !== "cancel" && interaction.subcommand !== "close") {
        throw new Error(`/cc の不明なサブコマンドです（${interaction.subcommand ?? ""}）`);
      }
      const guildId = interaction.guildId;
      if (guildId === null) throw new Error("サーバー外で /cc が呼ばれました");
      const channels = deps.ccChannels();
      if (channels === undefined) {
        await responder.reply({ text: CC_UNAVAILABLE_REPLY, ephemeral: true });
        return;
      }
      if (interaction.subcommand === "close") {
        const result = interaction.channelId === null ? { result: "not_channel" as const } : channels.close(interaction.channelId);
        await responder.reply({ ...closeReply(result), suppressEmbeds: true });
        return;
      }
      if (interaction.subcommand === "cancel") {
        const count = interaction.channelId === null ? undefined : channels.cancelQueued(interaction.channelId);
        await responder.reply({ text: cancelReply(count), ephemeral: true });
        return;
      }
      if (deps.guildSettings.ccCategoryId(guildId) === null) {
        await responder.reply({ text: CC_NOT_SET_UP_REPLY, ephemeral: true });
        return;
      }
      const items = channels.pickItems();
      if (items.length === 0) {
        await responder.reply({ text: CC_NO_SESSIONS_REPLY, ephemeral: true });
        return;
      }
      await responder.reply({
        text: "チャンネルを作るセッションを選んでください",
        ephemeral: true,
        components: [
          {
            kind: "select",
            select: {
              customId: PICK_SELECT_ID,
              placeholder: "Claude Code のセッション",
              minValues: 1,
              maxValues: 1,
              options: items.map((item) => ({
                label: clip(item.label.replace(/\s+/g, " "), OPTION_MAX_LENGTH),
                value: item.sessionId,
                description: clip(
                  [STATE_LABEL[item.state], item.dir, item.hasChannel ? "チャンネルあり" : null].filter((part) => part !== null && part !== "").join("・"),
                  OPTION_MAX_LENGTH,
                ),
              })),
            },
          },
        ],
      });
    },
  };
}

/** 許可の要求のボタンが使うもの（main が permission-hold.ts と cc/channel-posts.ts から作る。SELF_AGENT_CC_NOTIFY によらない） */
export type CcPermissionButtons = {
  /** Discord の操作として答える（permission-hold.ts の answer の via discord） */
  answer(id: number, decision: CcPermissionDecision): CcAnswerResult;
  /** 終わった要求の 1 通とそれを出した場所（cc/channel-posts.ts の resolvedMessage。#system に出したものも同じ形）。行が無ければ undefined */
  resolvedMessage(id: number): { message: OutgoingMessage; channelId: string | null; messageId: string | null } | undefined;
  /**
   * 答えた後（応答を返した直後）。そのセッションの Claude Code のチャンネルを押したサーバーに作る（docs/plan/claude-code-channels.md §3.1 の 3。CC11）。
   * 待たない・投げない
   */
  answered?(id: number, guildId: string | null): void;
};

/**
 * ccPermissionButtons は許可の要求のボタン。確認のボタン（CC7）は CcConfirmDeps の項目を使う（interactions.ts の ComponentDeps では必須。
 * 無ければ cc:send|start|keep は例外）
 */
export type CcComponentDeps = {
  /** SELF_AGENT_CC が有効なときだけ（無ければ押されても古い扱い）。main で後から作るので関数で渡す */
  ccPermissionButtons?: () => CcPermissionButtons | undefined;
  /** 返事の追いかけ（[追いかけをやめる]。CC8）。DB だけで動くので SELF_AGENT_CC が無効でも渡す。無ければ cc:unfollow は例外 */
  ccFollow?: { replies: Pick<CcReplyStore, "get">; sessions: Pick<CcSessionStore, "get" | "stopFollow"> };
  /** /cc open のセレクト（cc:pick）と [起動して続ける]（cc:resume）。無ければ cc:pick・cc:resume は例外 */
  ccChannels?: CcChannelsGetter;
  /** 削除の確認の [削除する][残す]（cc:del。CC13。DB だけで動くので SELF_AGENT_CC が無効でも渡す）。無ければ cc:del は例外 */
  ccDelete?: {
    deleteAfterDays: number;
    store: Pick<CcChannelStore, "get" | "touchEnded" | "markDeleted">;
    gateway: Pick<Gateway, "deleteChannel">;
    /** 削除したチャンネルの未実行の移動を捨てる */
    channelOps: Pick<ChannelOpsQueue, "cancel">;
  };
  /** 応答に失敗したときの書き換え（既定の人格の Bot。#system の 1 通を出した Bot） */
  gateway: Pick<Gateway, "editMessage">;
  log: (message: string) => void;
} & Partial<Omit<CcConfirmDeps, "log">>;

const DECISIONS: Readonly<Record<string, CcPermissionDecision>> = { allow: "allow", always: "always", deny: "deny" };

/** Discord の ID の形（数字だけ） */
function isSnowflake(raw: string): boolean {
  return /^\d{1,20}$/.test(raw);
}

type CcDeleteDeps = NonNullable<CcComponentDeps["ccDelete"]>;

/**
 * 削除の確認の [削除する]・[残す]（commands/delete.ts に倣う）。行が無い・削除済み・別のサーバーなら「すでに処理済み」、ended でない（戻った・続けた）・
 * 押されたメッセージが記録した確認と違えば「古くなっています」にしてボタンを外し、DB は変えない。[削除する] は deleteChannel → channelOps.cancel → deleted
 */
async function handleDelete(
  deps: CcDeleteDeps,
  channelId: string,
  keep: boolean,
  interaction: { guildId: string | null; messageId?: string },
  responder: Parameters<ComponentHandler["handle"]>[1],
  log: (message: string) => void,
): Promise<void> {
  const check = (): "handled" | "stale" | NonNullable<ReturnType<CcDeleteDeps["store"]["get"]>> => {
    const row = deps.store.get(channelId);
    if (row === undefined || row.state === "deleted" || row.guildId !== interaction.guildId) return "handled";
    if (row.state !== "ended" || interaction.messageId === undefined || row.deletePromptMessageId !== interaction.messageId) return "stale";
    return row;
  };
  const dismiss = (result: "handled" | "stale"): Promise<void> =>
    responder.update({ text: result === "handled" ? ALREADY_HANDLED_TEXT : STALE_TEXT, components: [] });
  const show = async (text: string): Promise<void> => {
    try {
      await responder.update({ text, components: [] });
    } catch (error) {
      log(`Claude Code: 削除の確認の書き換えに失敗しました（${errorKind(error)}）`);
    }
  };
  const first = check();
  if (typeof first === "string") {
    await dismiss(first);
    return;
  }
  if (keep) {
    if (!deps.store.touchEnded(channelId)) {
      await dismiss("stale");
      return;
    }
    log(`Claude Code: [残す] でチャンネルを残しました（guild=${first.guildId}）`);
    await show(ccKeptText(first.name, deps.deleteAfterDays));
    return;
  }
  // チャンネルの削除は Discord に問い合わせるので先に保留する
  await responder.deferUpdate();
  const second = check();
  if (typeof second === "string") {
    await dismiss(second);
    return;
  }
  // 失敗したら何も変えずに投げる（ボタンは残るので押し直せる）
  await deps.gateway.deleteChannel(channelId);
  deps.channelOps.cancel(channelId);
  deps.store.markDeleted(channelId);
  log(`Claude Code: チャンネルを削除しました（guild=${second.guildId}）`);
  await show(ccDeletedText(second.name));
}

/** custom_id の id（1 以上の整数）。それ以外なら undefined */
function parseId(raw: string | undefined): number | undefined {
  return raw !== undefined && /^[1-9]\d{0,15}$/.test(raw) ? Number(raw) : undefined;
}

function errorKind(error: unknown): string {
  return error instanceof Error ? error.name : typeof error;
}

/** 確認のボタンの処理。CcConfirmDeps が揃っていなければ undefined */
function confirmButtons(deps: CcComponentDeps): CcConfirmButtons | undefined {
  const { cfg, ccSends, ccStarts, ccSessions, ccRuntime, ccPosts } = deps;
  if (cfg === undefined || ccSends === undefined || ccStarts === undefined || ccSessions === undefined || ccRuntime === undefined || ccPosts === undefined) {
    return undefined;
  }
  return createCcConfirmButtons({ ...deps, cfg, ccSends, ccStarts, ccSessions, ccRuntime, ccPosts });
}

export function createCcComponent(deps: CcComponentDeps): ComponentHandler {
  const confirm = confirmButtons(deps);
  return {
    namespace: NAMESPACE,
    async handle(interaction, responder) {
      // /cc open のセレクト（CC10）: 選んだセッションのチャンネルを作る（作成は数秒かかりうるので先に保留する）
      if (interaction.customId === PICK_SELECT_ID) {
        if (interaction.kind !== "select" || deps.ccChannels === undefined) throw new Error(`cc:pick の不明な操作です（${interaction.kind}）`);
        const guildId = interaction.guildId;
        const sessionId = interaction.values[0];
        if (guildId === null || sessionId === undefined || !isUuid(sessionId)) throw new Error("cc:pick の選択が正しくありません");
        const channels = deps.ccChannels();
        if (channels === undefined) {
          await responder.reply({ text: CC_UNAVAILABLE_REPLY, ephemeral: true });
          return;
        }
        await responder.defer(true);
        const result = await channels.openChannel(guildId, sessionId, "command");
        await responder.reply({ text: openResultReply(result), ephemeral: true });
        return;
      }
      const parts = interaction.customId.split(":");
      const [, kind, action, rawId, ...rest] = parts;
      // 終わったチャンネルの [起動して続ける][やめる]（CC13）: cc:resume:<channel_id>:<message_id>・cc:resume:keep:<channel_id>:<message_id>
      if (kind === "resume") {
        const keep = parts.length === 5 && parts[2] === "keep";
        const [channelId, messageId] = keep ? [parts[3], parts[4]] : parts.length === 4 ? [parts[2], parts[3]] : [undefined, undefined];
        if (interaction.kind !== "button" || channelId === undefined || messageId === undefined || !isSnowflake(channelId) || !isSnowflake(messageId)) {
          throw new Error(`cc:resume の不明な操作です（${interaction.kind}）`);
        }
        const channels = deps.ccChannels?.();
        // 保留が無い（再起動・[やめる]・付け替えの後・連携が止まった）ボタンは、確認のボタンを外して古いと書き換える
        const expire = (): Promise<void> => responder.update({ text: CC_RESUME_STALE_TEXT, components: [], suppressEmbeds: true });
        if (keep) {
          if (channels === undefined || !channels.keepEnded(channelId, messageId)) {
            await expire();
            return;
          }
          await responder.update({ text: CC_RESUME_KEPT_TEXT, components: [], suppressEmbeds: true });
          return;
        }
        if (channels === undefined) {
          await expire();
          return;
        }
        // 起動は tmux に問い合わせるので先に保留する
        await responder.deferUpdate();
        const result = await channels.resume(channelId, messageId, interaction.guildId);
        if ("message" in result) {
          await responder.update({ ...result.message, suppressEmbeds: true });
        } else if (result.reason === "expired") {
          await expire();
        } else {
          await responder.reply({ text: STALE_TURN_REPLY, ephemeral: true });
        }
        return;
      }
      // 削除の確認（CC13）: cc:del:<channel_id>・cc:del:keep:<channel_id>
      if (kind === "del") {
        const keep = parts.length === 4 && parts[2] === "keep";
        const channelId = keep ? parts[3] : parts.length === 3 ? parts[2] : undefined;
        if (interaction.kind !== "button" || channelId === undefined || !isSnowflake(channelId) || deps.ccDelete === undefined) {
          throw new Error(`cc:del の不明な操作です（${interaction.kind}）`);
        }
        await handleDelete(deps.ccDelete, channelId, keep, interaction, responder, deps.log);
        return;
      }
      // 確認（CC7）: cc:send:<id>・cc:start:<id>・cc:keep:send|start:<id>
      if (kind === "send" || kind === "start" || kind === "keep") {
        const id = kind === "keep" ? (parts.length === 4 ? parseId(parts[3]) : undefined) : parts.length === 3 ? parseId(parts[2]) : undefined;
        if (interaction.kind !== "button" || id === undefined || confirm === undefined || (kind === "keep" && action !== "send" && action !== "start")) {
          throw new Error(`cc:${kind} の不明な操作です（${interaction.kind}）`);
        }
        if (kind === "keep") await confirm.keep(action as "send" | "start", id, responder);
        else await confirm[kind](id, responder);
        return;
      }
      // 返事の追いかけ（CC8）: cc:unfollow:<cc_replies の id>。本文は残して一言を足し、ボタンを外す
      if (kind === "unfollow") {
        const id = parts.length === 3 ? parseId(parts[2]) : undefined;
        if (interaction.kind !== "button" || id === undefined || deps.ccFollow === undefined) {
          throw new Error(`cc:unfollow の不明な操作です（${interaction.kind}）`);
        }
        if (unfollowByReply(deps.ccFollow, id) !== "stopped") {
          await responder.reply({ text: STALE_TURN_REPLY, ephemeral: true });
          return;
        }
        deps.log(`Claude Code: [追いかけをやめる] で追いかけをやめました（返事 #${id}）`);
        await responder.update({ text: unfollowedText(interaction.messageText), components: [], suppressEmbeds: true });
        return;
      }
      if (kind !== "perm") throw new Error(`cc の不明な操作です（${interaction.kind} ${kind ?? ""}）`);
      const decision = action === undefined ? undefined : DECISIONS[action];
      const id = parseId(rawId);
      if (interaction.kind !== "button" || decision === undefined || id === undefined || rest.length > 0) {
        throw new Error(`cc:perm の不明な操作です（${interaction.kind} ${action ?? ""}）`);
      }
      const buttons = deps.ccPermissionButtons?.();
      const result = buttons === undefined ? undefined : buttons.answer(id, decision);
      if (buttons === undefined || result === undefined || !result.ok) {
        await responder.reply({ text: STALE_TURN_REPLY, ephemeral: true });
        return;
      }
      const resolved = buttons.resolvedMessage(id);
      try {
        if (resolved === undefined) {
          await responder.deferUpdate();
          return;
        }
        try {
          await responder.update(resolved.message);
        } catch (error) {
          // 答えは決まっているので、ボタンが残らないよう 1 通を直接書き換える（これも失敗すれば投げて、振り分けが log に出す）
          deps.log(`Claude Code: 許可の要求（#${id}）への応答に失敗したため、投稿を書き換えます（${errorKind(error)}）`);
          if (resolved.channelId !== null && resolved.messageId !== null) {
            await deps.gateway.editMessage(resolved.channelId, resolved.messageId, resolved.message);
          }
        }
      } finally {
        // 答えた（関わった）ので、そのセッションのチャンネルをこのサーバーに作る（作れなくても応答は変わらない）
        buttons.answered?.(id, interaction.guildId);
      }
    },
  };
}
