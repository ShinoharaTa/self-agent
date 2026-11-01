import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  ancestorPids,
  CC_PANE_ANCESTOR_DEPTH,
  CcPaneResolver,
  findSendablePane,
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

test("paneIdOfHint: `<session>:@<window_id>.%<pane>`（実際の形）と `<session>:<window>.%<pane>` の %N だけ", () => {
  assert.equal(paneIdOfHint("foo:@12.%34"), "%34");
  assert.equal(paneIdOfHint("work:1.%23"), "%23");
  assert.equal(paneIdOfHint("work:@@1.%23"), undefined);
  assert.equal(paneIdOfHint("a:b:0.%7"), "%7");
  assert.equal(paneIdOfHint(undefined), undefined);
  assert.equal(paneIdOfHint("work:1.23"), undefined);
  assert.equal(paneIdOfHint("%23x"), undefined);
});

const NO_OTHERS: ReadonlySet<number> = new Set([500]);

test("findSessionPane: pane_pid が claude の親（シェル）〜 8 段上の claude のペイン。claude の pid そのものも当たる", () => {
  // claude 500 ← bash 400（%1 の pane_pid）← 300 ← … ← 20
  const chain: Record<number, number> = { 500: 400, 400: 300, 300: 200, 200: 100, 100: 90, 90: 80, 80: 70, 70: 60, 60: 50, 50: 1 };
  const { parentOf } = parents(chain);
  const panes = [pane("%0", 999), pane("%1", 400)];
  assert.equal(findSessionPane({ pid: 500, tmux: undefined }, panes, parentOf, NO_OTHERS)?.paneId, "%1");
  assert.equal(findSessionPane({ pid: 999, tmux: undefined }, panes, parentOf, new Set([999]))?.paneId, "%0");
  assert.equal(CC_PANE_ANCESTOR_DEPTH, 8);
  // 8 段上（60）までは当たる
  assert.equal(findSessionPane({ pid: 500, tmux: undefined }, [pane("%2", 60)], parentOf, NO_OTHERS)?.paneId, "%2");
  // 9 段上（50）は当たらない（tmux 欄で指していても）
  assert.equal(findSessionPane({ pid: 500, tmux: "work:0.%3" }, [pane("%3", 50)], parentOf, NO_OTHERS), undefined);
  // 死んだペインは採らない
  assert.equal(findSessionPane({ pid: 500, tmux: undefined }, [pane("%1", 400, { dead: true })], parentOf, NO_OTHERS), undefined);
  // どのペインにも当たらない（RC のサーバーモード・VS Code など）
  assert.equal(findSessionPane({ pid: 500, tmux: undefined }, [pane("%4", 777)], parentOf, NO_OTHERS), undefined);
});

test("findSessionPane: pane_pid が当たっても pane_current_command が claude でないペインは採らない（主の経路・tmux 欄とも）", () => {
  const { parentOf } = parents({ 500: 400, 400: 1 });
  const shell = pane("%1", 400, { currentCommand: "bash" });
  assert.equal(findSessionPane({ pid: 500, tmux: undefined }, [shell], parentOf, NO_OTHERS), undefined);
  assert.equal(findSessionPane({ pid: 500, tmux: "work:0.%1" }, [shell], parentOf, NO_OTHERS), undefined);
});

test("findSessionPane: たどる途中で一覧のほかのセッションの pid に当たれば（入れ子の claude）打ち切る", () => {
  // 外の claude 600 ← bash 400（%1）。内の claude 500 は外の claude の Bash（550）から起動した
  const { parentOf } = parents({ 500: 550, 550: 600, 600: 400, 400: 1 });
  const panes = [pane("%1", 400)];
  const all = new Set([500, 600]);
  assert.equal(findSessionPane({ pid: 600, tmux: undefined }, panes, parentOf, all)?.paneId, "%1");
  assert.equal(findSessionPane({ pid: 500, tmux: undefined }, panes, parentOf, all), undefined);
  // tmux 欄でそのペインを指していても同じ
  assert.equal(findSessionPane({ pid: 500, tmux: "work:0.%1" }, panes, parentOf, all), undefined);
  // 一覧に外の claude が無ければ（入れ子と分からない）祖先のペインに当たる
  assert.equal(findSessionPane({ pid: 500, tmux: undefined }, panes, parentOf, new Set([500]))?.paneId, "%1");
});

test("findSessionPane: sessions/<pid>.json の tmux 欄は、そのペインの pane_pid が同じ範囲の祖先のときだけ採る", () => {
  const { parentOf } = parents({ 500: 400, 400: 1 });
  // 祖先でないペイン（tmux 欄が古い・別のセッションのもの）は採らない
  assert.equal(findSessionPane({ pid: 500, tmux: "work:0.%6" }, [pane("%6", 888)], parentOf, NO_OTHERS), undefined);
  // tmux 欄のペインが無い
  assert.equal(findSessionPane({ pid: 500, tmux: "work:0.%9" }, [pane("%6", 888)], parentOf, NO_OTHERS), undefined);
  assert.equal(findSessionPane({ pid: 500, tmux: "foo:@12.%1" }, [pane("%1", 400)], parentOf, NO_OTHERS)?.paneId, "%1");
});

test("findSendablePane: 主の経路（祖先が pane_pid）で当たる claude のペインだけ。tmux 欄（補助）だけで採れるペインには送らない", () => {
  // claude 500 ← 400 ← … ← 50（9 段上。補助の経路でも祖先と確かめられない）
  const { parentOf } = parents({ 500: 400, 400: 300, 300: 200, 200: 150, 150: 1 });
  assert.deepEqual(findSendablePane({ pid: 500 }, [pane("%1", 400)], parentOf, NO_OTHERS), { ok: true, pane: pane("%1", 400) });
  assert.equal(findSendablePane({ pid: 500 }, [pane("%3", 150)], parentOf, NO_OTHERS).ok, true);
  // 祖先のペインがシェル（claude でない）なら絶対に送らない
  assert.deepEqual(findSendablePane({ pid: 500 }, [pane("%1", 400, { currentCommand: "bash" })], parentOf, NO_OTHERS), {
    ok: false,
    reason: "not_claude",
  });
  // tmux 欄の補助でしか採れないペイン（祖先でない pane_pid）・死んだペインは tmux の外
  const hinted = pane("%5", 888);
  assert.deepEqual(findSendablePane({ pid: 500 }, [hinted], parentOf, NO_OTHERS), { ok: false, reason: "not_in_tmux" });
  assert.deepEqual(findSendablePane({ pid: 500 }, [pane("%1", 400, { dead: true })], parentOf, NO_OTHERS), { ok: false, reason: "not_in_tmux" });
  // 入れ子（たどる途中にほかのセッションの pid）は外のペインに送らない
  assert.deepEqual(findSendablePane({ pid: 500 }, [pane("%3", 300)], parentOf, new Set([500, 400])), { ok: false, reason: "not_in_tmux" });
});

test("CcPaneResolver: lookup のたびに list-panes を読み直し、直近の結果を lastTmux に持つ。サーバーが無い・読めなければ ok: false で、resolve は undefined", async () => {
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
  assert.equal(resolver.lastTmux(), undefined);
  const first = await resolver.lookup(NO_OTHERS);
  assert.ok(first.ok);
  assert.equal(first.find({ pid: 500, tmux: undefined })?.paneId, "%1");
  assert.equal(resolver.lastTmux(), "ok");
  assert.deepEqual(first.sendable({ pid: 500, tmux: undefined }), { ok: true, pane: pane("%1", 400) });
  assert.deepEqual(await resolver.lookup(NO_OTHERS), { ok: false, reason: "no_server" });
  assert.equal(resolver.lastTmux(), "no_server");
  assert.equal(await resolver.resolve({ pid: 500, tmux: undefined }, NO_OTHERS), undefined);
  assert.equal(resolver.lastTmux(), "failed");
  assert.equal(await resolver.resolve({ pid: 500, tmux: undefined }, NO_OTHERS), undefined);
  assert.equal(calls, 4);
});
