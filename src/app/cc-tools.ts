// SDK のエージェントのツール cc_list・cc_send・cc_start の処理（docs/plan/claude-code-sessions.md §5.3。CC7）。SELF_AGENT_CC=1 のときだけ main が作る。
// cc_list は registry の一覧（§2.2 の順）を最大 CC_LIST_MAX 件。cc_send・cc_start は送り先・起動の場所を確かめてから、頼んだチャンネルに
// 確認（commands/cc-confirm.ts）をそのチャンネルの持ち主の Bot で投稿するだけで、送る・起動するのはオーナーがボタンを押したとき。
// 使えるターンの判定（not_available）は agent/tools.ts の createCcToolHandlers。log は番号だけ（本文・名前・ディレクトリ・チャンネル ID は出さない）
import { homedir } from "node:os";
import type { CcListEntry, CcListResult, CcSendResult, CcStartResult, CcToolDeps } from "../agent/tools.ts";
import { formatWallClock } from "./recurrence.ts";
import { isUuid } from "../cc/agents.ts";
import type { CcPaneResolver } from "../cc/panes.ts";
import type { CcRegistry, CcSessionView } from "../cc/registry.ts";
import { normalizeSendText, type CcSender } from "../cc/sender.ts";
import type { CcStartFailure, CcStarter } from "../cc/starter.ts";
import type { Config } from "../config.ts";
import type { Gateway } from "../discord/gateway.ts";
import type { CcSendStore } from "../store/cc-sends.ts";
import type { CcStartStore } from "../store/cc-starts.ts";
import { CC_RC_URL_PREFIX, cwdLabel } from "../web/routes/cc.ts";
import { ccSendPrompt, ccStartPrompt } from "./commands/cc-confirm.ts";

/** cc_list が返す件数の上限 */
export const CC_LIST_MAX = 30;

export type CcToolsDeps = {
  cfg: Pick<Config, "workspaceDir" | "timeZone">;
  registry: Pick<CcRegistry, "snapshot">;
  panes: Pick<CcPaneResolver, "lookup">;
  sender: Pick<CcSender, "propose">;
  starter: Pick<CcStarter, "check">;
  sends: Pick<CcSendStore, "setMessageId" | "transition">;
  starts: Pick<CcStartStore, "add" | "setMessageId" | "transition">;
  /** 確認の投稿（チャンネルの持ち主の Bot。ownerPosts） */
  gateway: Pick<Gateway, "sendMessage">;
  /** ~ の場所（ディレクトリ名の表示。既定は homedir()） */
  home?: string;
  log: (message: string) => void;
};

/** 状態の始まり（判断待ちは待ち始め、それ以外は最後の活動。web/routes/cc.ts と同じ） */
function sinceOf(view: CcSessionView): number | undefined {
  return view.state === "needs_input" ? (view.waitingSince ?? view.lastActivityAt) : view.lastActivityAt;
}

/** cc_start の確認を出せなかった理由 → ツールの結果 */
function startFailure(reason: CcStartFailure): CcStartResult {
  switch (reason) {
    case "invalid_project":
      return { result: "invalid_project" };
    case "no_server":
      return { result: "no_server" };
    case "invalid_title":
      return { result: "invalid_args", message: "題名は文字・数字・空白・_ . - だけで 40 字までです" };
    case "invalid_mode":
      return { result: "invalid_args", message: "権限モードが正しくありません" };
    case "empty":
    case "too_long":
    case "invalid_text":
      return { result: "invalid_args", message: "最初の指示に使えない文字があるか、長すぎます（改行以外の制御文字は使えません）" };
    case "limit":
      return { result: "limit", message: "Claude Code のセッションの数が上限です" };
    case "low_memory":
      return { result: "limit", message: "メモリが足りないため起動できません" };
    case "too_soon":
      return { result: "limit", message: "前の起動から 1 分経っていません" };
    case "not_ready":
      return { result: "not_available", message: "Claude Code のセッションの一覧をまだ読めていません" };
    case "tmux_failed":
      return { result: "not_available", message: "tmux を使えませんでした" };
    case "stopped":
      return { result: "not_available", message: "停止中です" };
  }
}

export function createCcTools(deps: CcToolsDeps): CcToolDeps {
  const { cfg, registry, panes, sender, starter, sends, starts, gateway, log } = deps;
  const home = deps.home ?? homedir();
  const time = (ms: number | undefined): string | null => (ms === undefined ? null : formatWallClock(new Date(ms), cfg.timeZone));

  return {
    async list(args): Promise<CcListResult> {
      const snapshot = registry.snapshot();
      const views = snapshot.sessions.filter((view) => args.state === undefined || view.state === args.state);
      const lookup = await panes.lookup(new Set(snapshot.sessions.map((view) => view.pid)));
      const sessions = views.slice(0, CC_LIST_MAX).map((view): CcListEntry => {
        const inTmux = lookup.ok && lookup.find({ pid: view.pid, tmux: view.tmux }) !== undefined;
        return {
          session_id: view.sessionId,
          name: view.name ?? null,
          dir: cwdLabel(view.cwd, cfg.workspaceDir, home),
          state: view.state,
          ...(view.waitingFor === undefined ? {} : { waiting_for: view.waitingFor }),
          since: time(sinceOf(view)),
          last_prompt_at: time(view.lastPromptAt),
          last_prompt: view.lastPromptText,
          in_tmux: inTmux,
          permission_mode: view.permissionMode,
          ...(view.bridgeSessionId === undefined ? {} : { rc_url: `${CC_RC_URL_PREFIX}${view.bridgeSessionId}` }),
        };
      });
      return {
        sessions,
        more: Math.max(0, views.length - CC_LIST_MAX),
        stale: snapshot.fetchedAt === undefined || snapshot.stale || snapshot.unreadable,
      };
    },

    async send(args, context): Promise<CcSendResult> {
      if (!isUuid(args.session_id)) return { result: "not_found" };
      const checked = normalizeSendText(args.text);
      if (!checked.ok) {
        return { result: "invalid_args", message: "本文が空か、改行以外の制御文字（タブなど）を含むか、長すぎます" };
      }
      const proposed = await sender.propose({ sessionId: args.session_id, text: checked.text, channelId: context.channelId });
      if (!proposed.ok) {
        switch (proposed.reason) {
          case "not_found":
            return { result: "not_found" };
          case "already_queued":
            return { result: "already_queued" };
          case "not_in_tmux":
          case "not_claude":
          case "no_server":
            return { result: "not_in_tmux" };
          case "tmux_failed":
            return { result: "not_available", message: "tmux を使えませんでした" };
          case "stopped":
            return { result: "not_available", message: "停止中です" };
        }
      }
      const { send } = proposed;
      const view = registry.snapshot().sessions.find((session) => session.sessionId === args.session_id);
      const target = { name: view?.name ?? null, dir: cwdLabel(view?.cwd, cfg.workspaceDir, home) };
      let messageId: string;
      try {
        messageId = await gateway.sendMessage(context.channelId, ccSendPrompt(send.id, target, send.text));
      } catch (error) {
        // 確認を出せなければ送らない
        sends.transition(send.id, ["awaiting_confirm"], "cancelled", { lastPaneState: "post_failed" });
        throw error;
      }
      sends.setMessageId(send.id, messageId);
      log(`Claude Code: cc_send の確認を出しました（#${send.id}）`);
      return { result: "confirmation_posted", send_id: send.id };
    },

    async start(args, context): Promise<CcStartResult> {
      const checked = await starter.check({
        project: args.project,
        title: args.title,
        ...(args.text === undefined ? {} : { text: args.text }),
        ...(args.permission_mode === undefined ? {} : { permissionMode: args.permission_mode }),
      });
      if (!checked.ok) return startFailure(checked.reason);
      const row = starts.add({
        project: checked.project,
        title: checked.title,
        ...(checked.text === undefined ? {} : { text: checked.text }),
        ...(checked.mode === undefined ? {} : { permissionMode: checked.mode }),
        channelId: context.channelId,
      });
      let messageId: string;
      try {
        messageId = await gateway.sendMessage(context.channelId, ccStartPrompt(row));
      } catch (error) {
        starts.transition(row.id, ["awaiting_confirm"], "cancelled");
        throw error;
      }
      starts.setMessageId(row.id, messageId);
      log(`Claude Code: cc_start の確認を出しました（#${row.id}）`);
      return { result: "confirmation_posted", start_id: row.id };
    },
  };
}
