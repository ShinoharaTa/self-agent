import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  ancestorPids,
  CC_PANE_ANCESTOR_DEPTH,
  CcPaneResolver,
  findSessionPane,
  paneIdOfHint,
  parseStatParentPid,
  procParentPid,
} from "../src/cc/panes.ts";
import type { TmuxPane, TmuxResult } from "../src/tmux/tmux.ts";
import { tempDir } from "./helpers/db.ts";

function pane(paneId: string, panePid: number, overrides: Partial<TmuxPane> = {}): TmuxPane {
  return {
    sessionName: "work",
    windowIndex: 0,
    paneIndex: Number(paneId.slice(1)),
    paneId,
    windowActive: true,
    paneActive: true,
    currentPath: "/home/u/workspace/a",
    currentCommand: "claude",
    inMode: false,
    dead: false,
    panePid,
    ...overrides,
  };
}

/** 子 → 親の表から作る親 pid の読み手 */
function parents(table: Record<number, number>) {
  const reads: number[] = [];
  const parentOf = (pid: number): number | undefined => {
    reads.push(pid);
    return table[pid];
  };
  return { parentOf, reads };
}

test("parseStatParentPid: comm の括弧・空白に惑わされず、最後の ) の後ろの 2 つ目を読む", () => {
  assert.equal(parseStatParentPid("4321 (claude) S 4300 4321 4300 34816 ..."), 4300);
  assert.equal(parseStatParentPid("4321 (a) S 99 (b)) R 1234 1 2 3"), 1234);
  assert.equal(parseStatParentPid("4321 (my cmd) S 1 4321"), 1);
  for (const bad of ["", "4321 claude S 4300", "4321 (claude)", "4321 (claude) S", "4321 (claude) S x 1"]) {
    assert.equal(parseStatParentPid(bad), undefined, bad);
  }
});

test("procParentPid: <procDir>/<pid>/stat を読む。無い・不正な pid は undefined", (t) => {
  const proc = tempDir(t);
  mkdirSync(join(proc, "4321"));
  writeFileSync(join(proc, "4321", "stat"), "4321 (claude) S 4300 4321 4300 0 -1\n");
  const parentOf = procParentPid(proc);
  assert.equal(parentOf(4321), 4300);
  assert.equal(parentOf(4322), undefined);
  assert.equal(parentOf(0), undefined);
  assert.equal(parentOf(-1), undefined);
});

test("ancestorPids: 親から順に depth 段まで。init（1）・不明・循環で止まる", () => {
  const { parentOf } = parents({ 50: 40, 40: 30, 30: 20, 20: 1 });
  assert.deepEqual(ancestorPids(50, parentOf, 3), [40, 30, 20]);
  assert.deepEqual(ancestorPids(50, parentOf, 2), [40, 30]);
  assert.deepEqual(ancestorPids(50, parentOf, 10), [40, 30, 20]);
  assert.deepEqual(ancestorPids(99, parentOf, 3), []);
  const loop = parents({ 5: 6, 6: 5 });
  assert.deepEqual(ancestorPids(5, loop.parentOf, 10), [6]);
});

test("paneIdOfHint: `<session>:<window>.%<pane>` の %N だけ", () => {
  assert.equal(paneIdOfHint("work:1.%23"), "%23");
  assert.equal(paneIdOfHint("a:b:0.%7"), "%7");
  assert.equal(paneIdOfHint(undefined), undefined);
  assert.equal(paneIdOfHint("work:1.23"), undefined);
  assert.equal(paneIdOfHint("%23x"), undefined);
});

test("findSessionPane: pane_pid が claude の親（シェル）〜 3 段上のペイン。claude の pid そのものも当たる", () => {
  // claude 500 ← bash 400（%1 の pane_pid）
  const { parentOf } = parents({ 500: 400, 400: 300, 300: 200, 200: 100, 100: 1 });
  const panes = [pane("%0", 999), pane("%1", 400, { currentCommand: "bash" })];
  // pane_current_command が claude でなくても、祖先関係で決まる（画面の写しのため。送ってよいかは送信の段で別に確かめる）
  assert.equal(findSessionPane({ pid: 500, tmux: undefined }, panes, parentOf)?.paneId, "%1");
  assert.equal(findSessionPane({ pid: 999, tmux: undefined }, panes, parentOf)?.paneId, "%0");
  // 3 段上（200）までは当たる
  assert.equal(findSessionPane({ pid: 500, tmux: undefined }, [pane("%2", 200)], parentOf)?.paneId, "%2");
  assert.equal(CC_PANE_ANCESTOR_DEPTH, 3);
  // 4 段上（100）は当たらない（hint も無い）
  assert.equal(findSessionPane({ pid: 500, tmux: undefined }, [pane("%3", 100)], parentOf), undefined);
  // 死んだペインは採らない
  assert.equal(findSessionPane({ pid: 500, tmux: undefined }, [pane("%1", 400, { dead: true })], parentOf), undefined);
  // どのペインにも当たらない（RC のサーバーモード・VS Code など）
  assert.equal(findSessionPane({ pid: 500, tmux: undefined }, [pane("%4", 777)], parentOf), undefined);
});

test("findSessionPane: sessions/<pid>.json の tmux 欄は、そのペインが claude で祖先関係を確かめられるときだけ採る", () => {
  // claude 500 ← 400 ← 300 ← 200 ← 150（%5 の pane_pid。4 段上）
  const { parentOf } = parents({ 500: 400, 400: 300, 300: 200, 200: 150, 150: 1 });
  const deep = pane("%5", 150);
  assert.equal(findSessionPane({ pid: 500, tmux: "work:0.%5" }, [deep], parentOf)?.paneId, "%5");
  // tmux 欄が無ければ採らない
  assert.equal(findSessionPane({ pid: 500, tmux: undefined }, [deep], parentOf), undefined);
  // claude でないペインは採らない
  assert.equal(findSessionPane({ pid: 500, tmux: "work:0.%5" }, [pane("%5", 150, { currentCommand: "bash" })], parentOf), undefined);
  // 祖先でないペイン（tmux 欄が古い・別のセッションのもの）は採らない
  assert.equal(findSessionPane({ pid: 500, tmux: "work:0.%6" }, [deep, pane("%6", 888)], parentOf), undefined);
  // tmux 欄のペインが無い
  assert.equal(findSessionPane({ pid: 500, tmux: "work:0.%9" }, [deep], parentOf), undefined);
});

test("CcPaneResolver: lookup のたびに list-panes を読み直す。サーバーが無い・読めなければ ok: false で、resolve は undefined", async () => {
  const { parentOf } = parents({ 500: 400 });
  const results: Array<TmuxResult<TmuxPane[]>> = [
    { ok: true, value: [pane("%1", 400)] },
    { ok: false, reason: "no_server" },
    { ok: false, reason: "failed" },
  ];
  let calls = 0;
  const resolver = new CcPaneResolver({
    tmux: {
      listPanes: async () => {
        calls++;
        return results.shift() ?? { ok: true, value: [] };
      },
    },
    parentOf,
  });
  const first = await resolver.lookup();
  assert.ok(first.ok);
  assert.equal(first.find({ pid: 500, tmux: undefined })?.paneId, "%1");
  assert.deepEqual(await resolver.lookup(), { ok: false, reason: "no_server" });
  assert.equal(await resolver.resolve({ pid: 500, tmux: undefined }), undefined);
  assert.equal(await resolver.resolve({ pid: 500, tmux: undefined }), undefined);
  assert.equal(calls, 4);
});
