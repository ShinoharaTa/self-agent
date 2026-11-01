// Claude Code のボタン（名前空間 `cc:`。docs/plan/claude-code-sessions.md §5.2）。custom_id は `cc:<種類>:<操作>:<id>` で、2 つ目の語で振り分ける。
// 許可の要求の `cc:perm:allow|always|deny:<id>`（CC5c）と、SDK のツール cc_send・cc_start の確認の `cc:send:<id>`・`cc:start:<id>`・
// `cc:keep:send|start:<id>`（CC7。処理は commands/cc-confirm.ts）。
// 許可の要求は Web と同じ permission-hold.ts の answer を通す（先に押した方が勝つ）。決めたら #system の 1 通を応答で書き換えてボタンを外し
// （応答に失敗したら、その 1 通を gateway で書き換えて代える）、古ければ（Web・端末・RC で先に答えられた・時間切れ・停止・SELF_AGENT_CC が無効）
// 本人にだけ「この操作は古くなっています」
import type { CcAnswerResult, CcPermissionDecision } from "../../cc/permission-hold.ts";
import type { Gateway, OutgoingMessage } from "../../discord/gateway.ts";
import type { ComponentHandler } from "../interactions.ts";
import { type CcConfirmButtons, type CcConfirmDeps, createCcConfirmButtons } from "./cc-confirm.ts";
import { STALE_TURN_REPLY } from "./turn-controls.ts";

const NAMESPACE = "cc";

/** 許可の要求のボタンが使うもの（main が permission-hold.ts と cc/discord-notice.ts から作る） */
export type CcPermissionButtons = {
  /** Discord の操作として答える（permission-hold.ts の answer の via discord） */
  answer(id: number, decision: CcPermissionDecision): CcAnswerResult;
  /** 終わった要求の 1 通とそれを出した場所（cc/discord-notice.ts の resolvedMessage）。行が無ければ undefined */
  resolvedMessage(id: number): { message: OutgoingMessage; channelId: string | null; messageId: string | null } | undefined;
};

/**
 * ccPermissionButtons は許可の要求のボタン。確認のボタン（CC7）は CcConfirmDeps の項目を使う（interactions.ts の ComponentDeps では必須。
 * 無ければ cc:send|start|keep は例外）
 */
export type CcComponentDeps = {
  /** SELF_AGENT_CC が有効なときだけ（無ければ押されても古い扱い）。main で後から作るので関数で渡す */
  ccPermissionButtons?: () => CcPermissionButtons | undefined;
  /** 応答に失敗したときの書き換え（既定の人格の Bot。#system の 1 通を出した Bot） */
  gateway: Pick<Gateway, "editMessage">;
  log: (message: string) => void;
} & Partial<Omit<CcConfirmDeps, "log">>;

const DECISIONS: Readonly<Record<string, CcPermissionDecision>> = { allow: "allow", always: "always", deny: "deny" };

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
      const parts = interaction.customId.split(":");
      const [, kind, action, rawId, ...rest] = parts;
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
    },
  };
}
