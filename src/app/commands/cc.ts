// Claude Code のボタン（名前空間 `cc:`。docs/plan/claude-code-sessions.md §5.2）。custom_id は `cc:<種類>:<操作>:<id>` で、2 つ目の語で振り分ける。
// 今は許可の要求の `cc:perm:allow|always|deny:<id>`（CC5c）だけ。CC7 の `cc:send|start|keep:*` も同じ名前空間に足す。
// 許可の要求は Web と同じ permission-hold.ts の answer を通す（先に押した方が勝つ）。決めたら #system の 1 通を応答で書き換えてボタンを外し、
// 古ければ（Web・端末・RC で先に答えられた・時間切れ・停止・SELF_AGENT_CC が無効）本人にだけ「この操作は古くなっています」
import type { CcAnswerResult, CcPermissionDecision } from "../../cc/permission-hold.ts";
import type { ComponentHandler } from "../interactions.ts";
import { STALE_TURN_REPLY } from "./turn-controls.ts";

const NAMESPACE = "cc";

/** 許可の要求のボタンが使うもの（main が permission-hold.ts と cc/discord-notice.ts から作る） */
export type CcPermissionButtons = {
  /** Discord の操作として答える（permission-hold.ts の answer の via discord） */
  answer(id: number, decision: CcPermissionDecision): CcAnswerResult;
  /** 終わった要求の 1 通の本文（cc/discord-notice.ts の resolvedText）。行が無ければ undefined */
  resolvedText(id: number): string | undefined;
};

export type CcComponentDeps = {
  /** SELF_AGENT_CC が有効なときだけ（無ければ押されても古い扱い）。main で後から作るので関数で渡す */
  ccPermissionButtons?: () => CcPermissionButtons | undefined;
  log: (message: string) => void;
};

const DECISIONS: Readonly<Record<string, CcPermissionDecision>> = { allow: "allow", always: "always", deny: "deny" };

/** custom_id の id（1 以上の整数）。それ以外なら undefined */
function parseId(raw: string | undefined): number | undefined {
  return raw !== undefined && /^[1-9]\d{0,15}$/.test(raw) ? Number(raw) : undefined;
}

export function createCcComponent(deps: CcComponentDeps): ComponentHandler {
  return {
    namespace: NAMESPACE,
    async handle(interaction, responder) {
      const [, kind, action, rawId, ...rest] = interaction.customId.split(":");
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
      const text = buttons.resolvedText(id);
      if (text === undefined) {
        await responder.deferUpdate();
        return;
      }
      await responder.update({ text, components: [] });
    },
  };
}
