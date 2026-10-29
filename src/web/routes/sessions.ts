// セッションの操作（docs/plan/web-ui.md §6.2）: 新しいセッション・待ちにする・進行中に戻す・閉じる（と確認の確定）・会話を新しくする。
// Discord のコマンド・ボタンと同じ session-ops.ts の関数を通す。長い処理（/close の要約のターン・/renew の要約）は 202 ですぐ返し、
// 結果は会話の履歴（divider・notice）と状態で見せる。/close の確認（候補あり）は Discord にも同じ確認のメッセージ（ボタン付き）を持ち主の Bot で投稿し、
// 先に確定した方が勝つ（後の方は Discord なら NO_DRAFT_REPLY、Web なら 409）。/renew の結果の文も Discord に投稿する。
// log に題名・本文・チャンネル ID は出さない
import { DEFAULT_PERSONA_ID } from "../../config.ts";
import { ALREADY_CLOSED_REPLY, type CloseDeps, confirmButtons, confirmText, SUMMARY_FAILURE_REPLY } from "../../app/commands/close.ts";
import { type NewSessionDeps, sessionOwnerOf, TITLE_MAX_LENGTH } from "../../app/commands/new.ts";
import type { RenewDeps } from "../../app/commands/renew.ts";
import type { OwnerPosts, PersonaRouter } from "../../app/personas.ts";
import {
  closable,
  closeSession,
  confirmClose,
  continueSession,
  NO_CONVERSATION_REPLY,
  NOT_RENEWABLE_REPLY,
  openTopicSession,
  RENEW_FAILURE_REPLY,
  RENEW_NOT_SET_UP_REPLY,
  removeClosedNodeModules,
  renewChannel,
  waitSession,
} from "../../app/session-ops.ts";
import { type HistoryStore, recordHistory } from "../../store/history.ts";
import type { Route, RouteResult } from "../server.ts";
import { type ChannelRouteDeps, webChannelLookup } from "./channels.ts";

/** /close の確認（候補あり）を Discord に投稿したときの、会話の履歴の知らせ */
export const CLOSE_CONFIRM_NOTICE = "確認待ちです。登録するやることを選ぶと閉じます（Discord でも選べます）";
/** 確定で選べる候補の添字の数の上限（session_report の tasks より十分大きい） */
const SELECTED_MAX = 100;

/** /renew の結果のうち、区切りの行（divider）を書かないもの。Web では知らせの行にして会話に出す */
const RENEW_NOTICE_TEXTS: ReadonlySet<string> = new Set([
  NO_CONVERSATION_REPLY,
  RENEW_NOT_SET_UP_REPLY,
  RENEW_FAILURE_REPLY,
  NOT_RENEWABLE_REPLY,
  ALREADY_CLOSED_REPLY,
]);

export type SessionRouteDeps = Pick<ChannelRouteDeps, "cfg" | "resolveChannel"> &
  Pick<CloseDeps, "topicSessions" | "tasks" | "channelOps" | "turnQueue" | "turn" | "projects" | "projectsDir"> &
  Pick<RenewDeps, "inboxRotator"> & {
    /** 既定の人格の Bot（チャンネルを作る） */
    gateway: NewSessionDeps["gateway"];
    /** 既定の人格の Bot が Discord に接続しているか。していなければセッションを作らない（503） */
    defaultConnected: () => boolean;
    guildSettings: NewSessionDeps["guildSettings"];
    /** /setup・/new と同じキュー（layoutQueue） */
    queue: NewSessionDeps["queue"];
    /** チャンネルの持ち主の人格と Bot */
    personas: Pick<PersonaRouter, "ownerOf" | "gatewayFor">;
    /** 持ち主の Bot での投稿（/close の確認・/renew の結果） */
    ownerPosts: Pick<OwnerPosts, "send" | "sendMessage">;
    history: Pick<HistoryStore, "add">;
    log: (message: string) => void;
  };

const BAD_REQUEST: RouteResult = { status: 400, json: { error: "bad_request" } };
const NOT_FOUND: RouteResult = { status: 404, json: { error: "not_found" } };
const CLOSED: RouteResult = { status: 409, json: { error: "closed" } };

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function channelLink(guildId: string, channelId: string): string {
  return `https://discord.com/channels/${guildId}/${channelId}`;
}

/** 確定で選んだもの: "all"・"none" か、重ならない 0 以上の整数の配列（空は不可）。それ以外は undefined */
function parseSelected(value: unknown): number[] | "all" | "none" | undefined {
  if (value === "all" || value === "none") return value;
  if (!Array.isArray(value) || value.length === 0 || value.length > SELECTED_MAX) return undefined;
  if (!value.every((index) => Number.isInteger(index) && index >= 0 && index < SELECTED_MAX)) return undefined;
  return value as number[];
}

export function sessionRoutes(deps: SessionRouteDeps): Route[] {
  const { cfg, topicSessions, personas, ownerPosts, log } = deps;
  const lookup = webChannelLookup(deps);

  /** セッションのチャンネルのサーバー（許可したサーバーのもの）。無ければ undefined。状態の判定は session-ops.ts が行う */
  const sessionGuild = (channelId: string): string | undefined => {
    const guildId = topicSessions.get(channelId)?.guildId;
    return guildId !== undefined && cfg.allowedGuildIds.includes(guildId) ? guildId : undefined;
  };

  /** 会話の履歴に知らせの行を書く（失敗は log だけ） */
  const notice = (guildId: string, channelId: string, text: string): void => {
    recordHistory(deps.history, { guildId, channelId, kind: "notice", source: "system", persona: personas.ownerOf(channelId), text }, log);
  };

  /** /close の要約のターンが終わった後: 確認は Discord にも投稿し、失敗は知らせの行、閉じたら node_modules を消す（Discord の /close と同じ順） */
  const afterClose = async (guildId: string, channelId: string, outcome: Awaited<ReturnType<typeof closeSession>>): Promise<void> => {
    switch (outcome.result) {
      case "confirm":
        notice(guildId, channelId, CLOSE_CONFIRM_NOTICE);
        try {
          await ownerPosts.sendMessage(channelId, { text: confirmText(outcome.draft), components: [confirmButtons(channelId)] });
        } catch (error) {
          log(`/close の確認を Discord に投稿できませんでした: ${describeError(error)}`);
        }
        return;
      case "failed":
        notice(guildId, channelId, SUMMARY_FAILURE_REPLY);
        return;
      case "finalized":
        await removeClosedNodeModules(deps, channelId);
        return;
      case "closed":
      case "not_session":
        return;
    }
  };

  return [
    {
      method: "POST",
      pattern: /^\/api\/sessions$/,
      handle: async ({ body }) => {
        const guildId = body?.guildId;
        if (typeof guildId !== "string" || !cfg.allowedGuildIds.includes(guildId)) return BAD_REQUEST;
        const personaId = body?.persona;
        if (personaId !== undefined && typeof personaId !== "string") return BAD_REQUEST;
        const owner = sessionOwnerOf(cfg.personas, personaId);
        // 設定に無い人格では作らない（既定の人格の default は可）
        if (personaId !== undefined && personaId !== DEFAULT_PERSONA_ID && owner === undefined) return BAD_REQUEST;
        const title = body?.title;
        if (typeof title !== "string") return BAD_REQUEST;
        // Discord の /new と同じ字数（前後の空白を除いて数える）
        if (title.trim().length > TITLE_MAX_LENGTH) return { status: 400, json: { error: "too_long" } };
        // チャンネルを作るのは既定の人格の Bot
        if (!deps.defaultConnected()) return { status: 503, json: { error: "bot_disconnected" } };
        const result = await openTopicSession(guildId, title, owner, deps, "Web から");
        switch (result.result) {
          case "empty_title":
            return { status: 400, json: { error: "empty_title" } };
          case "not_set_up":
            return { status: 409, json: { error: "not_set_up" } };
          case "created":
            return { status: 201, json: { channelId: result.channelId, link: channelLink(guildId, result.channelId) } };
        }
      },
    },
    {
      method: "POST",
      pattern: /^\/api\/sessions\/(\d{1,25})\/wait$/,
      handle: async ({ params }) => {
        const channelId = params[0] ?? "";
        const guildId = sessionGuild(channelId);
        if (guildId === undefined) return NOT_FOUND;
        switch (waitSession(guildId, channelId, deps)) {
          case "not_session":
            return NOT_FOUND;
          case "closed":
            return CLOSED;
          case "waited":
          case "unchanged":
            return { status: 200, json: { state: topicSessions.get(channelId)?.state ?? "waiting" } };
        }
      },
    },
    {
      method: "POST",
      pattern: /^\/api\/sessions\/(\d{1,25})\/continue$/,
      handle: async ({ params }) => {
        const channelId = params[0] ?? "";
        const guildId = sessionGuild(channelId);
        if (guildId === undefined) return NOT_FOUND;
        switch (continueSession(guildId, channelId, deps)) {
          case "not_session":
            return NOT_FOUND;
          case "deleted":
            return { status: 409, json: { error: "deleted" } };
          case "continued":
          case "unchanged":
            return { status: 200, json: { state: topicSessions.get(channelId)?.state ?? "active" } };
        }
      },
    },
    {
      method: "POST",
      pattern: /^\/api\/sessions\/(\d{1,25})\/close$/,
      handle: async ({ params }) => {
        const channelId = params[0] ?? "";
        const guildId = sessionGuild(channelId);
        if (guildId === undefined) return NOT_FOUND;
        const check = closable(topicSessions.get(channelId), guildId);
        if (check === "not_session") return NOT_FOUND;
        if (check === "closed") return CLOSED;
        log(`Web から /close を始めました（guild=${guildId}）`);
        // 要約のターンは最長 SELF_AGENT_SESSION_TURN_TIMEOUT_SEC かかるので待たない（実行中のターンがあればキューで順番を待つ）
        void closeSession(guildId, channelId, deps)
          .then((outcome) => afterClose(guildId, channelId, outcome))
          .catch((error: unknown) => log(`Web からの /close に失敗しました: ${describeError(error)}`));
        return { status: 202, json: { accepted: true } };
      },
    },
    {
      method: "POST",
      pattern: /^\/api\/sessions\/(\d{1,25})\/close\/confirm$/,
      handle: async ({ params, body }) => {
        const selected = parseSelected(body?.selected);
        if (selected === undefined) return BAD_REQUEST;
        const channelId = params[0] ?? "";
        const guildId = sessionGuild(channelId);
        if (guildId === undefined) return NOT_FOUND;
        const closed = confirmClose(guildId, channelId, selected, deps);
        if (closed.result === "no_draft") return { status: 409, json: { error: "no_draft" } };
        // 結果を返してから、そのチャンネルのキューで node_modules を消す（Discord の確認のボタンと同じ順。reject しない）
        void removeClosedNodeModules(deps, channelId);
        return { status: 200, json: { summary: closed.summary, registered: closed.registered } };
      },
    },
    {
      method: "POST",
      pattern: /^\/api\/channels\/(\d{1,25})\/renew$/,
      handle: async ({ params }) => {
        const channelId = params[0] ?? "";
        const found = lookup(channelId);
        if (found === undefined) return NOT_FOUND;
        const { guildId } = found;
        // 受け付けるか（not_renewable・closed でないか）は renewChannel が onAccepted の前に同期で決める。
        // onAccepted が呼ばれなかったら、その結果（すぐに返る）で断る
        let accepted = false;
        const running = renewChannel(guildId, channelId, deps, async () => {
          accepted = true;
        });
        if (!accepted) {
          const result = await running;
          if (result.result === "closed") return CLOSED;
          if (result.result === "not_renewable") return NOT_FOUND;
        }
        log(`Web から /renew を始めました（guild=${guildId}）`);
        void running
          .then(async (result) => {
            if (result.result !== "done") return;
            // 区切りの行を書かない結果（会話が無い・失敗など）は、知らせの行にして Web の会話に出す
            if (RENEW_NOTICE_TEXTS.has(result.text)) notice(guildId, channelId, result.text);
            try {
              await ownerPosts.send(channelId, result.text);
            } catch (error) {
              log(`/renew の結果を Discord に投稿できませんでした: ${describeError(error)}`);
            }
          })
          .catch((error: unknown) => log(`Web からの /renew に失敗しました: ${describeError(error)}`));
        return { status: 202, json: { accepted: true } };
      },
    },
  ];
}
