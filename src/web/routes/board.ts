// 進行状況（docs/plan/project-board.md §4 PS1）。GET /api/board・POST /api/board/projects・POST /api/board/projects/<dir>/remove・POST /api/board/refresh。
// 状態は書いた行（git・GitHub）とその場の材料（Claude Code のセッション・プロジェクトのセッションの実行中のターン）から classify.ts で決め直す。
// 無効（SELF_AGENT_BOARD が無い・gh か git が無い）なら GET は enabled: false、POST は 404。題名・URL は文字のまま返す（画面は textContent で出す）。
// log は件数と種類だけ（ディレクトリ・リポジトリ名は出さない）
import { type BoardCollector, type BoardLiveSource, classifyRow } from "../../board/collect.ts";
import { BOARD_DISPLAY_ORDER } from "../../board/classify.ts";
import { CC_PROJECT_PATTERN, type CcPlaces, listProjects, projectDir } from "../../cc/starter.ts";
import type { BoardStore } from "../../store/board.ts";
import type { Route, RouteResult } from "../server.ts";

export type BoardRouteDeps = {
  /** 有効なときだけ。無ければ GET は enabled: false、POST は 404 */
  board?: {
    store: Pick<BoardStore, "add" | "remove" | "listActive">;
    collector: Pick<BoardCollector, "refresh" | "repoOf">;
    places: CcPlaces;
    live: BoardLiveSource;
  };
  log: (message: string) => void;
};

const NOT_FOUND: RouteResult = { status: 404, json: { error: "not_found" } };

export function boardRoutes(deps: BoardRouteDeps): Route[] {
  const { board, log } = deps;
  /** 待たずに回す（失敗は collector が log に出す） */
  const kick = (): void => {
    void board?.collector.refresh();
  };
  return [
    {
      method: "GET",
      pattern: /^\/api\/board$/,
      handle: async () => {
        if (board === undefined) return { status: 200, json: { enabled: false, projects: [], candidates: [] } };
        const rows = board.store.listActive();
        const projects = rows.map((row) => {
          const live = board.live(row.dir, projectDir(row.dir, board.places));
          const { state, reasons } = classifyRow(row, live);
          return {
            dir: row.dir,
            repo: row.repo,
            state,
            reasons,
            items: row.items ?? [],
            local: row.local,
            checkedAt: row.checkedAt,
            error: row.error,
            ccSessions: live.ccSessions.map((session) => ({ sessionId: session.sessionId, state: session.state })),
          };
        });
        projects.sort(
          (a, b) => BOARD_DISPLAY_ORDER.indexOf(a.state) - BOARD_DISPLAY_ORDER.indexOf(b.state) || (a.dir < b.dir ? -1 : a.dir > b.dir ? 1 : 0),
        );
        const registered = new Set(rows.map((row) => row.dir));
        const candidates = listProjects(board.places)
          .filter((name) => !registered.has(name))
          .map((name) => ({ name }));
        return { status: 200, json: { enabled: true, projects, candidates } };
      },
    },
    {
      method: "POST",
      pattern: /^\/api\/board\/projects$/,
      handle: async ({ body }) => {
        if (board === undefined) return NOT_FOUND;
        const dir = body?.dir;
        if (typeof dir !== "string" || projectDir(dir, board.places) === undefined) {
          return { status: 400, json: { error: "invalid_project" } };
        }
        const repo = await board.collector.repoOf(dir);
        const result = board.store.add(dir, repo);
        if (result === "limit") return { status: 409, json: { error: "limit" } };
        if (result !== "exists") {
          log(`board: Web でプロジェクトを登録しました（${result}）`);
          kick();
        }
        return { status: result === "exists" ? 200 : 201, json: { dir } };
      },
    },
    {
      method: "POST",
      pattern: /^\/api\/board\/projects\/([^/]{1,200})\/remove$/,
      handle: async ({ params }) => {
        if (board === undefined) return NOT_FOUND;
        let dir: string;
        try {
          dir = decodeURIComponent(params[0]!);
        } catch {
          return NOT_FOUND;
        }
        if (!CC_PROJECT_PATTERN.test(dir) || !board.store.remove(dir)) return NOT_FOUND;
        log("board: Web でプロジェクトを外しました");
        return { status: 200, json: { dir } };
      },
    },
    {
      method: "POST",
      pattern: /^\/api\/board\/refresh$/,
      handle: async () => {
        if (board === undefined) return NOT_FOUND;
        kick();
        return { status: 202, json: { accepted: true } };
      },
    },
  ];
}
