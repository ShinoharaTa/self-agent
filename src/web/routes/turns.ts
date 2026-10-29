// Web から送る・実行中のターン・[中断]・[続ける]（docs/plan/web-ui.md §5.2）。送った発言は handler の submitText で、Discord の発言と同じ経路で 1 ターン入る。
// [中断]・[続ける] は Discord のボタン（turn-controls.ts）と同じ handler の関数を呼ぶ。log に本文・チャンネル ID は出さない
import type { Handler } from "../../app/handler.ts";
import type { Route, RouteResult } from "../server.ts";
import { type ChannelRouteDeps, webChannelLookup } from "./channels.ts";

/** Web から送る本文の上限（字）。接頭辞（「（Web から）」と改行）を足して Discord の 2,000 字に収める */
export const WEB_MESSAGE_MAX_LENGTH = 1900;
/** 同じチャンネルに同じ本文がこれより短い間に来たら、2 回目は送らずに 1 回目の結果を返す（二重送信） */
export const WEB_DUPLICATE_WINDOW_MS = 5000;

export type TurnRouteDeps = Pick<ChannelRouteDeps, "cfg" | "guildSettings" | "topicSessions" | "resolveChannel"> & {
  handler: Pick<Handler, "submitText" | "runningTurns" | "abortTurn" | "continueTurn">;
  now: () => Date;
  log: (message: string) => void;
};

const NOT_FOUND: RouteResult = { status: 404, json: { error: "not_found" } };

function messageLink(guildId: string, channelId: string, messageId: string): string {
  return `https://discord.com/channels/${guildId}/${channelId}/${messageId}`;
}

export function turnRoutes(deps: TurnRouteDeps): Route[] {
  const { handler, now, log } = deps;
  const lookup = webChannelLookup(deps);
  /**
   * チャンネルごとの直近の送信（二重送信の判定）。結果は Promise で持ち、同時に来た 2 回目も 1 回目の結果を待って同じものを返す。
   * 受け付けなかった（202 以外）ものは消して、やり直せるようにする
   */
  const recent = new Map<string, { text: string; at: number; response: Promise<RouteResult> }>();

  const send = async (guildId: string, channelId: string, kind: string, text: string): Promise<RouteResult> => {
    const result = await handler.submitText({ guildId, channelId, content: text, at: now(), source: "web" });
    switch (result.result) {
      case "not_accepted":
        return NOT_FOUND;
      case "bot_disconnected":
        return { status: 503, json: { error: "bot_disconnected" } };
      case "echo_failed":
        return { status: 502, json: { error: "echo_failed" } };
      case "accepted":
        log(`Web から ${kind} に送りました（guild=${guildId}）`);
        return { status: 202, json: { turnId: result.turnId, link: messageLink(guildId, channelId, result.messageId) } };
    }
  };

  return [
    {
      method: "POST",
      pattern: /^\/api\/channels\/(\d{1,25})\/messages$/,
      handle: async ({ params, body }) => {
        const raw = body?.text;
        if (typeof raw !== "string" || raw.trim() === "") return { status: 400, json: { error: "empty" } };
        const text = raw.trim();
        if (text.length > WEB_MESSAGE_MAX_LENGTH) return { status: 400, json: { error: "too_long" } };
        const channelId = params[0] ?? "";
        const found = lookup(channelId);
        if (found === undefined) return NOT_FOUND;
        const at = now().getTime();
        const last = recent.get(channelId);
        if (last !== undefined && last.text === text && at - last.at < WEB_DUPLICATE_WINDOW_MS) return last.response;
        const response = send(found.guildId, channelId, found.kind, text);
        const entry = { text, at, response };
        recent.set(channelId, entry);
        const done = await response.catch((error: unknown) => {
          if (recent.get(channelId) === entry) recent.delete(channelId);
          throw error;
        });
        if (done.status !== 202 && recent.get(channelId) === entry) recent.delete(channelId);
        return done;
      },
    },
    {
      method: "GET",
      pattern: /^\/api\/running$/,
      handle: async () => {
        const at = now().getTime();
        const turns = handler.runningTurns().map((turn) => ({ ...turn, elapsedMs: Math.max(0, at - Date.parse(turn.startedAt)) }));
        return { status: 200, json: { turns } };
      },
    },
    {
      method: "POST",
      pattern: /^\/api\/channels\/(\d{1,25})\/turns\/(\d{1,16})\/abort$/,
      handle: async ({ params }) => {
        const aborted = handler.abortTurn(params[0] ?? "", Number(params[1]));
        return aborted ? { status: 200, json: { aborted: true } } : { status: 409, json: { error: "stale" } };
      },
    },
    {
      method: "POST",
      pattern: /^\/api\/channels\/(\d{1,25})\/continue$/,
      handle: async ({ params }) => {
        const channelId = params[0] ?? "";
        const found = lookup(channelId);
        if (found === undefined || found.kind !== "session") return NOT_FOUND;
        if (handler.runningTurns().some((turn) => turn.channelId === channelId)) return { status: 409, json: { error: "running" } };
        // 返信まで待たない（Discord の [続ける] と同じ handler の関数）
        void handler.continueTurn(found.guildId, channelId, now());
        return { status: 202, json: { accepted: true } };
      },
    },
  ];
}
