// GET /api/github（docs/plan/web-ui.md §7.2）。#github に出した（投稿せずに済ませたものを含む）赤・黄の通知の新しい順と、ポーリングの状態。
// SELF_AGENT_GITHUB が無効なら 404。url は検証した部品から組み立てた形（poller.ts の HTML_URL_PATTERN）のときだけ返す。
// リポジトリ名は url から画面が切り出す（表示だけ）。log にはリポジトリ名・題名・URL・ログインを出さない。
// POST /api/github/<id>/act・/start は #github の [対応]・[起動して送る] と同じ app/github-handoff.ts（CC6。送り込みが無ければ 404）
import { type GithubHandoff, type GithubHandoffResult, handoffResultText } from "../../app/github-handoff.ts";
import type { Config } from "../../config.ts";
import { type GithubPollerStatus, HTML_URL_PATTERN } from "../../github/poller.ts";
import type { GithubStore } from "../../store/github.ts";
import type { Route, RouteResult } from "../server.ts";

/** /api/github の last の既定と上限 */
export const GITHUB_DEFAULT_LAST = 50;
export const GITHUB_MAX_LAST = 200;

export type GithubRouteDeps = {
  cfg: Pick<Config, "github">;
  store: Pick<GithubStore, "listPosted">;
  /** GithubPoller.status()（有効なときだけある） */
  status: (() => GithubPollerStatus) | undefined;
  /** Claude Code への送り込み（SELF_AGENT_CC も有効なときだけ）。無ければ [対応] は出さず、act・start は 404 */
  handoff?: Pick<GithubHandoff, "act" | "start">;
};

const BAD_REQUEST: RouteResult = { status: 400, json: { error: "bad_request" } };
const NOT_FOUND: RouteResult = { status: 404, json: { error: "not_found" } };

/** 1〜max の整数。省略は fallback、それ以外の形は undefined */
function boundedInt(value: string | null, fallback: number, max: number): number | undefined {
  if (value === null) return fallback;
  if (!/^\d+$/.test(value)) return undefined;
  const parsed = Number(value);
  return parsed >= 1 && parsed <= max ? parsed : undefined;
}

/** [対応]・[起動して送る] の結果の JSON。古い（行が無い・[対応] を付けない行）なら 404 */
function handoffJson(result: GithubHandoffResult): RouteResult {
  if (result.kind === "stale") return NOT_FOUND;
  return {
    status: 200,
    json: {
      result: result.kind,
      text: handoffResultText(result),
      ...("sendId" in result && result.sendId !== undefined ? { sendId: result.sendId } : {}),
      ...("state" in result ? { state: result.state } : {}),
      // セッションが無いとき、[起動して送る]（start）で起動できるか
      ...(result.kind === "no_session" ? { startable: result.dir !== undefined } : {}),
    },
  };
}

export function githubRoutes(deps: GithubRouteDeps): Route[] {
  const { cfg, store, status, handoff } = deps;
  const handoffPost = (action: "act" | "start"): Route => ({
    method: "POST",
    pattern: new RegExp(`^/api/github/(\\d{1,16})/${action}$`),
    handle: async ({ params }) => {
      if (!cfg.github || status === undefined || handoff === undefined) return NOT_FOUND;
      const id = Number(params[0]);
      if (!Number.isSafeInteger(id) || id < 1) return NOT_FOUND;
      return handoffJson(await handoff[action](id));
    },
  });
  return [
    {
      method: "GET",
      pattern: /^\/api\/github$/,
      handle: async ({ query }) => {
        if (!cfg.github || status === undefined) return NOT_FOUND;
        const last = boundedInt(query.get("last"), GITHUB_DEFAULT_LAST, GITHUB_MAX_LAST);
        if (last === undefined) return BAD_REQUEST;
        return {
          status: 200,
          json: {
            status: status(),
            // [対応]（Claude Code への送り込み）が使えるか
            handoff: handoff !== undefined,
            notifications: store.listPosted(last).map((row) => ({
              id: row.id,
              level: row.level,
              label: row.label,
              title: row.title,
              url: row.url !== null && HTML_URL_PATTERN.test(row.url) ? row.url : null,
              actorLogin: row.actorLogin,
              actorKnown: row.actorKnown,
              updatedAt: row.updatedAt,
              handoff: handoff !== undefined && row.handoffOk && row.url !== null && HTML_URL_PATTERN.test(row.url),
            })),
          },
        };
      },
    },
    handoffPost("act"),
    handoffPost("start"),
  ];
}
