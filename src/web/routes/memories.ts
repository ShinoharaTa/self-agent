// GET /api/memories・POST /api/memories/<id>/forget・/restore（docs/plan/web-ui.md §7.3）。オーナーについての記憶の一覧と、忘れる・トーストの [取り消す]（戻す）。
// 戻すときは Discord の [取り消す] と同じく件数の上限（MEMORY_MAX_ACTIVE）を確かめない。log に記憶の文は出さない
import type { Memory, MemoryStore } from "../../store/memories.ts";
import type { Route, RouteResult } from "../server.ts";

export type MemoryRouteDeps = {
  memories: Pick<MemoryStore, "list" | "softDelete" | "restore">;
  log: (message: string) => void;
};

const NOT_FOUND: RouteResult = { status: 404, json: { error: "not_found" } };

function memoryOf(memory: Memory) {
  return { id: memory.id, text: memory.text, createdAt: memory.createdAt };
}

export function memoryRoutes(deps: MemoryRouteDeps): Route[] {
  const { memories, log } = deps;
  return [
    {
      method: "GET",
      pattern: /^\/api\/memories$/,
      handle: async () => ({ status: 200, json: { memories: memories.list().map(memoryOf) } }),
    },
    {
      method: "POST",
      pattern: /^\/api\/memories\/(\d{1,15})\/forget$/,
      handle: async ({ params }) => {
        const memory = memories.softDelete(Number(params[0]));
        if (memory === undefined) return NOT_FOUND;
        log("Web で記憶を忘れました");
        return { status: 200, json: { memory: memoryOf(memory) } };
      },
    },
    {
      method: "POST",
      pattern: /^\/api\/memories\/(\d{1,15})\/restore$/,
      handle: async ({ params }) => {
        const memory = memories.restore(Number(params[0]));
        if (memory === undefined) return NOT_FOUND;
        log("Web で記憶を戻しました");
        return { status: 200, json: { memory: memoryOf(memory) } };
      },
    },
  ];
}
