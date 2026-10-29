// GET /api/knowledge・/api/knowledge/<id>（docs/plan/web-ui.md §7.3）。ナレッジの一覧（q が空なら新しい順、あれば kb_search と同じ検索）と 1 件（本文あり）。
// 読むだけで、削除は Discord の確認（kb_delete）から。log に題名・URL・本文は出さない
import { KB_SEARCH_MAX_LIMIT, type KbEntry, type KbSearchEntry, type KnowledgeStore } from "../../store/knowledge.ts";
import type { Route, RouteResult } from "../server.ts";

/** /api/knowledge の last の既定と上限（q が空のときだけ使う。検索は KB_SEARCH_MAX_LIMIT 件） */
export const KNOWLEDGE_DEFAULT_LAST = 30;
export const KNOWLEDGE_MAX_LAST = 200;

export type KnowledgeRouteDeps = {
  knowledge: Pick<KnowledgeStore, "listRecent" | "search" | "get">;
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

/** 一覧の 1 件（url_key・チャンネルは返さない） */
function entryOf(entry: KbSearchEntry) {
  return {
    id: entry.id,
    url: entry.url,
    title: entry.title,
    summary: entry.summary,
    tags: entry.tags,
    createdAt: entry.createdAt,
    updatedAt: entry.updatedAt,
  };
}

export function knowledgeRoutes(deps: KnowledgeRouteDeps): Route[] {
  const { knowledge } = deps;
  return [
    {
      method: "GET",
      pattern: /^\/api\/knowledge$/,
      handle: async ({ query }) => {
        const last = boundedInt(query.get("last"), KNOWLEDGE_DEFAULT_LAST, KNOWLEDGE_MAX_LAST);
        if (last === undefined) return BAD_REQUEST;
        const q = (query.get("q") ?? "").trim();
        if (q === "") return { status: 200, json: { q, entries: knowledge.listRecent(last).map(entryOf), more: false } };
        const result = knowledge.search(q, KB_SEARCH_MAX_LIMIT);
        return { status: 200, json: { q, entries: result.entries.map(entryOf), more: result.more } };
      },
    },
    {
      method: "GET",
      pattern: /^\/api\/knowledge\/(\d{1,15})$/,
      handle: async ({ params }) => {
        const entry: KbEntry | undefined = knowledge.get(Number(params[0]));
        if (entry === undefined) return NOT_FOUND;
        return { status: 200, json: { entry: { ...entryOf(entry), body: entry.body } } };
      },
    },
  ];
}
