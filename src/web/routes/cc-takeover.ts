// 取り込み（docs/plan/takeover.md。#341）の Web の入口。端末の Claude Code のセッションの札が使う 4 つのルート:
// GET /api/cc/sessions/<id>/takeover（判定と事実を読む。本体の check。行を作らない）、POST /api/cc/sessions/<id>/takeover（確認を作る。
// 自分（Web）の確認待ちが残っていれば取り消して作り直す）、POST /api/cc/takeovers/<番号>/confirm（進める）、POST /api/cc/takeovers/<番号>/cancel（やめる）。
// 判定・進め方は Discord の /cc take と同じ本体（cc/takeover.ts）。配線が無い（SELF_AGENT_CC が無効）なら 4 つとも 404。
// 消える側（cc/channels.ts・sender.ts・replies.ts・starter.ts・web/routes/cc.ts・app/commands/ の下）は import しない（docs/plan/terminal-handover.md の X 段）。
// ルート自身は log を出さない（本体が取り込みの番号と符号だけを出す）。応答の error は符号だけ
import { isUuid } from "../../cc/agents.ts";
import { ccRcUrl } from "../../cc/labels.ts";
import type { CcTakeover } from "../../cc/takeover.ts";
import { takeoverReasonText } from "../../cc/takeover-rules.ts";
import type { Config } from "../../config.ts";
import type { CcTakeoverStore } from "../../store/cc-takeovers.ts";
import type { GuildSettingsStore } from "../../store/guild-settings.ts";
import type { Route, RouteResult } from "../server.ts";

/** もう使えない確認への応答の文（Discord の入口の CC_TAKE_STALE_REPLY と同じ文。テストが同じ事を見る） */
export const TAKEOVER_WEB_STALE_TEXT = "この確認はもう使えません。";

export type CcTakeoverRouteDeps = {
  /** 取り込みの本体。配線が無い（SELF_AGENT_CC が無効）なら undefined で、4 つとも 404 */
  takeover: () => Pick<CcTakeover, "check" | "propose" | "confirm" | "cancel"> | undefined;
  takeovers: Pick<CcTakeoverStore, "get" | "activeFor">;
  cfg: Pick<Config, "allowedGuildIds">;
  guildSettings: Pick<GuildSettingsStore, "get">;
};

const NOT_FOUND: RouteResult = { status: 404, json: { error: "not_found" } };
const BAD_REQUEST: RouteResult = { status: 400, json: { error: "bad_request" } };
const STALE: RouteResult = { status: 409, json: { error: "stale", text: TAKEOVER_WEB_STALE_TEXT } };

/** 取り込みの番号（数字だけ。ほかは undefined） */
function parseTakeoverId(raw: string | undefined): number | undefined {
  return raw !== undefined && /^\d{1,15}$/.test(raw) ? Number(raw) : undefined;
}

export function ccTakeoverRoutes(deps: CcTakeoverRouteDeps): Route[] {
  const { takeovers, cfg, guildSettings } = deps;
  return [
    {
      // 判定を読む（札を開いた・状態が変わった・確かめ直すとき）
      method: "GET",
      pattern: /^\/api\/cc\/sessions\/([^/]+)\/takeover$/,
      handle: async ({ params }) => {
        const takeover = deps.takeover();
        const sessionId = params[0];
        if (takeover === undefined || !isUuid(sessionId)) return NOT_FOUND;
        const check = await takeover.check(sessionId);
        const reason = check.reason ?? null;
        const last = check.last;
        return {
          status: 200,
          json: {
            takeable: check.takeable,
            state: check.state,
            reason,
            text: reason === null ? null : takeoverReasonText(reason),
            title: check.title,
            project: check.project ?? null,
            activityAt: check.at === undefined ? null : new Date(check.at).toISOString(),
            rcUrl: check.bridgeSessionId === undefined ? null : ccRcUrl(check.bridgeSessionId),
            last:
              last === undefined
                ? null
                : {
                    takeover: last.id,
                    state: last.state,
                    id: last.state === "done" && last.targetChannelId !== null ? `ch:${last.targetChannelId}` : null,
                  },
          },
        };
      },
    },
    {
      // 確認を作る（行き先は /setup 済みの最初のサーバー）
      method: "POST",
      pattern: /^\/api\/cc\/sessions\/([^/]+)\/takeover$/,
      handle: async ({ params }) => {
        const takeover = deps.takeover();
        const sessionId = params[0];
        if (takeover === undefined || !isUuid(sessionId)) return NOT_FOUND;
        const guildId = cfg.allowedGuildIds.find((id) => guildSettings.get(id) !== undefined);
        if (guildId === undefined) return { status: 409, json: { error: "not_set_up" } };
        // 自分（Web）の確認待ちが残っていれば取り消して作り直す。Discord の行・実行中の行は取り消さない（propose が in_progress で断る）
        const active = takeovers.activeFor(sessionId);
        if (active !== undefined && active.entry === "web" && active.state === "awaiting_confirm") takeover.cancel(active.id);
        const result = await takeover.propose({ sessionId, entry: "web", guildId });
        if (!result.ok) return { status: 409, json: { error: result.reason, text: result.text } };
        return { status: 201, json: { id: result.id, text: result.plainText } };
      },
    },
    {
      // 進める（終わるまで待つ。10 秒を超える事がある。停止は本体の idle が待つ）
      method: "POST",
      pattern: /^\/api\/cc\/takeovers\/([^/]+)\/confirm$/,
      handle: async ({ params }) => {
        const takeover = deps.takeover();
        if (takeover === undefined) return NOT_FOUND;
        const id = parseTakeoverId(params[0]);
        if (id === undefined) return BAD_REQUEST;
        const row = takeovers.get(id);
        if (row === undefined) return NOT_FOUND;
        if (row.entry !== "web") return STALE;
        const result = await takeover.confirm(id);
        if (result.ok) return { status: 200, json: { ok: true, id: `ch:${result.channelId}`, text: result.plainText } };
        if (result.reason === "stale") return STALE;
        return { status: 409, json: { error: result.reason, text: result.plainText } };
      },
    },
    {
      // やめる
      method: "POST",
      pattern: /^\/api\/cc\/takeovers\/([^/]+)\/cancel$/,
      handle: async ({ params }) => {
        const takeover = deps.takeover();
        if (takeover === undefined) return NOT_FOUND;
        const id = parseTakeoverId(params[0]);
        if (id === undefined) return BAD_REQUEST;
        const row = takeovers.get(id);
        if (row === undefined) return NOT_FOUND;
        if (row.entry !== "web") return STALE;
        return takeover.cancel(id) ? { status: 200, json: { ok: true } } : STALE;
      },
    },
  ];
}
