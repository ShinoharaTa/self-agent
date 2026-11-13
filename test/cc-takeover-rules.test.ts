import { test } from "node:test";
import assert from "node:assert/strict";
import {
  appendedInterrupted,
  lineage,
  mapTakeoverMode,
  parseBtime,
  parseStat,
  procStartMs,
  TAKEOVER_AFTER_TERM_TEXT,
  TAKEOVER_CLK_TCK,
  TAKEOVER_COMM,
  TAKEOVER_LINEAGE_MAX,
  TAKEOVER_START_SLACK_MS,
  TAKEOVER_EXIT_POLL_MS,
  TAKEOVER_EXIT_TIMEOUT_MS,
  TAKEOVER_MAX_BYTES,
  TAKEOVER_SETTLE_MS,
  takeoverFailureText,
  takeoverIdentity,
  takeoverRefusal,
  type TakeoverFailure,
  type TakeoverIdentityInput,
  type TakeoverRefusalInput,
} from "../src/cc/takeover-rules.ts";

type AliveView = Extract<TakeoverRefusalInput["session"], { source: "alive" }>["view"];

function alive(view: Partial<AliveView> = {}, pane: Extract<TakeoverRefusalInput["session"], { source: "alive" }>["pane"] = "idle") {
  return { source: "alive" as const, view: { state: "idle" as const, status: "idle", kind: "interactive", trustPending: false, ...view }, pane };
}

function input(overrides: Partial<TakeoverRefusalInput> = {}): TakeoverRefusalInput {
  return {
    ready: true,
    listFresh: true,
    channelState: "open",
    session: alive(),
    project: "alpha",
    queued: 0,
    pendingPermission: false,
    mapped: false,
    ...overrides,
  };
}

test("定数", () => {
  assert.equal(TAKEOVER_SETTLE_MS, 2000);
  assert.equal(TAKEOVER_EXIT_TIMEOUT_MS, 10000);
  assert.equal(TAKEOVER_EXIT_POLL_MS, 250);
  assert.equal(TAKEOVER_MAX_BYTES, 128 * 1024 * 1024);
  assert.equal(TAKEOVER_COMM, "claude");
  assert.equal(TAKEOVER_START_SLACK_MS, 2000);
  assert.equal(TAKEOVER_LINEAGE_MAX, 1024);
  assert.equal(TAKEOVER_CLK_TCK, 100);
});

test("takeoverRefusal: 待機・tmux の中・直下・届け待ちなし・未取り込みなら取り込める", () => {
  assert.equal(takeoverRefusal(input()), undefined);
  assert.equal(takeoverRefusal(input({ session: { source: "ended" } })), undefined);
  assert.equal(takeoverRefusal(input({ channelState: "ended" })), undefined);
});

test("takeoverRefusal: §4 の各符号", () => {
  const cases: Array<[Partial<TakeoverRefusalInput>, TakeoverFailure]> = [
    [{ ready: false }, "not_ready"],
    [{ listFresh: false }, "list_failed"],
    [{ session: { source: "ended" }, listFresh: false }, "list_failed"],
    [{ channelState: "resuming" }, "channel_busy"],
    [{ project: undefined }, "outside_workspace"],
    [{ session: { source: "ended" }, project: undefined }, "outside_workspace"],
    [{ session: alive({ status: "busy", state: "running" }) }, "busy"],
    [{ session: alive({ status: undefined }) }, "busy"],
    [{ session: alive({ status: "waiting", state: "needs_input" }) }, "waiting"],
    [{ session: alive({ state: "needs_input" }) }, "waiting"],
    [{ pendingPermission: true }, "waiting"],
    [{ session: { source: "ended" }, pendingPermission: true }, "waiting"],
    [{ session: alive({}, "not_in_tmux") }, "not_in_tmux"],
    [{ session: alive({}, "draft") }, "pane"],
    [{ session: alive({}, "dialog") }, "pane"],
    [{ session: alive({}, "owner_active") }, "pane"],
    [{ session: alive({}, "copy_mode") }, "pane"],
    [{ session: alive({}, "failed") }, "tmux_failed"],
    [{ session: alive({ trustPending: true }) }, "pane"],
    [{ queued: 1 }, "queued"],
    [{ session: { source: "ended" }, queued: 2 }, "queued"],
    [{ mapped: true }, "already_taken"],
    [{ session: { source: "ended" }, mapped: true }, "already_taken"],
    [{ session: alive({ kind: "bg" }) }, "identity"],
    [{ session: alive({ kind: undefined }) }, "identity"],
  ];
  for (const [overrides, code] of cases) {
    assert.equal(takeoverRefusal(input(overrides)), code, JSON.stringify(overrides));
  }
});

test("takeoverRefusal: not_ready → list_failed → outside_workspace → channel_busy → 今までの順", () => {
  const all = { listFresh: false, project: undefined, channelState: "resuming" as const, queued: 3, mapped: true, session: alive({ status: "busy" }) };
  assert.equal(takeoverRefusal(input({ ready: false, ...all })), "not_ready");
  assert.equal(takeoverRefusal(input({ ...all })), "list_failed");
  assert.equal(takeoverRefusal(input({ ...all, listFresh: true })), "outside_workspace");
  assert.equal(takeoverRefusal(input({ ...all, listFresh: true, project: "alpha" })), "channel_busy");
  assert.equal(takeoverRefusal(input({ ...all, listFresh: true, project: "alpha", channelState: "open" })), "busy");
});

test("mapTakeoverMode: default・acceptEdits・plan はそのまま、ほかは default", () => {
  assert.equal(mapTakeoverMode("default"), "default");
  assert.equal(mapTakeoverMode("acceptEdits"), "acceptEdits");
  assert.equal(mapTakeoverMode("plan"), "plan");
  assert.equal(mapTakeoverMode("auto"), "default");
  assert.equal(mapTakeoverMode("bypassPermissions"), "default");
  assert.equal(mapTakeoverMode(null), "default");
  assert.equal(mapTakeoverMode(undefined), "default");
});

/** /proc/<pid>/stat の 1 行（state・ppid・starttime を差し込む） */
function statLine(comm: string, state = "S", ppid = 100, start = 987654): string {
  return `4242 (${comm}) ${state} ${ppid} 100 100 34816 100 4194560 1000 0 0 0 10 5 0 0 20 0 1 0 ${start} 123456789 2000 18446744073709551615`;
}

test("parseStat: comm は最初の ( と最後の ) の間。後ろの 1・2・20 番目が state・ppid・starttime", () => {
  assert.deepEqual(parseStat(statLine("claude")), { comm: "claude", state: "S", ppid: 100, startTime: 987654 });
  assert.deepEqual(parseStat(statLine("a (b) c", "Z", 7, 55)), { comm: "a (b) c", state: "Z", ppid: 7, startTime: 55 });
  assert.equal(parseStat(statLine("x) y"))?.comm, "x) y");
  assert.equal(parseStat("4242 claude S 1"), undefined);
  assert.equal(parseStat("4242 (claude) S 1 2 3"), undefined);
  assert.equal(parseStat(statLine("claude", "S", 100, -1)), undefined);
  assert.equal(parseStat(""), undefined);
  // state が英字 1 文字でなければ undefined
  assert.equal(parseStat(statLine("claude", "1")), undefined);
  assert.equal(parseStat(statLine("claude", "?")), undefined);
  assert.equal(parseStat(statLine("claude", "SS")), undefined);
});

test("parseBtime・procStartMs", () => {
  assert.equal(parseBtime("cpu  1 2 3\nintr 5\nbtime 1763000000\nprocesses 10\n"), 1763000000);
  assert.equal(parseBtime("cpu 1 2 3\n"), undefined);
  assert.equal(procStartMs(250, 1000), 1_000_000 + 2500);
});

test("lineage: pid ≤ 1 までの親の列。読めない・長すぎるなら undefined", () => {
  const parents = new Map([[50, 40], [40, 1], [1, 0]]);
  const parentOf = (pid: number) => parents.get(pid);
  assert.deepEqual(lineage(50, parentOf), [40, 1]);
  assert.deepEqual(lineage(1, parentOf), []);
  assert.equal(lineage(60, parentOf), undefined);
  // 自分を親に持つ（ループ）・とても深い列は上限で打ち切る
  assert.equal(lineage(5, () => 5), undefined);
  // 親が 0 以上の安全な整数でなければ undefined
  assert.equal(lineage(50, () => Number.NaN), undefined);
  assert.equal(lineage(50, () => -1), undefined);
  assert.equal(lineage(50, () => 1.5), undefined);
  assert.equal(lineage(50, () => Number.MAX_SAFE_INTEGER + 2), undefined);
  assert.equal(lineage(TAKEOVER_LINEAGE_MAX + 10, (pid) => pid - 1), undefined);
  assert.equal(lineage(TAKEOVER_LINEAGE_MAX + 1, (pid) => pid - 1)?.length, TAKEOVER_LINEAGE_MAX);
});

const BTIME = 1_763_000_000;
const START_TICKS = 50_000;
const STARTED_AT = procStartMs(START_TICKS, BTIME);

function identity(overrides: Partial<TakeoverIdentityInput> = {}): TakeoverIdentityInput {
  return {
    view: { pid: 4242, kind: "interactive", status: "idle", startedAt: STARTED_AT },
    first: { pid: 4242, startTime: START_TICKS },
    sessionFile: true,
    procStart: undefined,
    stat: { comm: "claude", state: "S", ppid: 300, startTime: START_TICKS },
    btimeSec: BTIME,
    ownPid: 900,
    ownAncestors: [800, 1],
    targetAncestors: [300, 200, 1],
    ...overrides,
  };
}

test("takeoverIdentity: §3.4 の 1〜5 がそろえば true", () => {
  assert.equal(takeoverIdentity(identity()), true);
  // state は R・S・D なら通る
  for (const state of ["R", "S", "D"]) assert.equal(takeoverIdentity(identity({ stat: { ...identity().stat!, state } })), true, state);
  // procStart があれば starttime と同じなら通る（無ければ今までどおり）
  assert.equal(takeoverIdentity(identity({ procStart: String(START_TICKS) })), true);
  // 開始が startedAt + 2 秒ちょうどまでは通る
  assert.equal(takeoverIdentity(identity({ view: { pid: 4242, kind: "interactive", status: "idle", startedAt: STARTED_AT - TAKEOVER_START_SLACK_MS } })), true);
});

test("takeoverIdentity: 1 つでも欠ければ false", () => {
  const view = identity().view!;
  const stat = identity().stat!;
  const cases: Array<[string, Partial<TakeoverIdentityInput>]> = [
    ["一覧に無い", { view: undefined }],
    ["pid が違う", { view: { ...view, pid: 4243 } }],
    ["interactive でない", { view: { ...view, kind: "bg" } }],
    ["idle でない", { view: { ...view, status: "busy" } }],
    ["sessionFile が無い", { sessionFile: false }],
    ["stat が読めない", { stat: undefined }],
    ["comm が claude でない", { stat: { ...stat, comm: "node" } }],
    ["comm に空白・括弧", { stat: { ...stat, comm: "claude (x)" } }],
    ["state Z", { stat: { ...stat, state: "Z" } }],
    ["state T（止まっている）", { stat: { ...stat, state: "T" } }],
    ["state t（トレースで止まっている）", { stat: { ...stat, state: "t" } }],
    ["state X（死んでいる）", { stat: { ...stat, state: "X" } }],
    ["procStart が starttime と違う", { procStart: String(START_TICKS + 1) }],
    ["starttime が違う", { stat: { ...stat, startTime: START_TICKS + 1 } }],
    ["開始が startedAt + 2 秒を超える", { view: { ...view, startedAt: STARTED_AT - TAKEOVER_START_SLACK_MS - 1 } }],
    ["startedAt が無い", { view: { ...view, startedAt: undefined } }],
    ["btime が無い", { btimeSec: undefined }],
    ["pid が自分", { ownPid: 4242 }],
    ["pid が自分の祖先", { ownAncestors: [4242, 1] }],
    ["pid が自分の子孫", { targetAncestors: [900, 800, 1] }],
    ["自分の祖先が読めない", { ownAncestors: undefined }],
    ["相手の祖先が読めない・長すぎる", { targetAncestors: undefined }],
    ["pid が 1", { view: { ...view, pid: 1 }, first: { pid: 1, startTime: START_TICKS } }],
  ];
  for (const [label, overrides] of cases) {
    assert.equal(takeoverIdentity(identity(overrides)), false, label);
  }
});

test("appendedInterrupted: type が user・assistant の行か、読めない（書きかけの）行があれば true", () => {
  assert.equal(appendedInterrupted([]), false);
  assert.equal(appendedInterrupted(['{"type":"summary"}', '{"type":"system"}']), false);
  assert.equal(appendedInterrupted(["not json", '{"type":"user","message":{}}']), true);
  assert.equal(appendedInterrupted(['{"type":"assistant"}']), true);
  assert.equal(appendedInterrupted(["[1,2]", "null", '"user"']), false);
  // 空白だけの行は無視し、読めない行（書きかけ）は動きありとみなす
  assert.equal(appendedInterrupted(["   ", "\t"]), false);
  assert.equal(appendedInterrupted(['{"type":"summary"}', '{"type":"user"']), true);
  assert.equal(appendedInterrupted(["not json"]), true);
});

test("takeoverFailureText: §4 の文。終了の後なら次の行に足す", () => {
  assert.equal(takeoverFailureText("busy", false), "取り込めませんでした: 実行中です。待機になってからもう一度");
  assert.equal(takeoverFailureText("waiting", false), "取り込めませんでした: 判断待ち（許可・質問）です。待機になってからもう一度");
  assert.equal(takeoverFailureText("copy_failed", true), `取り込めませんでした: 記録を写せませんでした\n${TAKEOVER_AFTER_TERM_TEXT}`);
  assert.equal(
    takeoverFailureText("not_exited", true),
    "取り込めませんでした: 10 秒待っても端末の Claude Code が終わりませんでした。取り込みはやめました。後から終わったら、もう一度 /cc take してください",
  );
  assert.equal(takeoverFailureText("identity", false), "取り込めませんでした: セッションを確かめられませんでした。端末の Claude Code はそのままです");
  assert.equal(takeoverFailureText("tmux_failed", false), "取り込めませんでした: 端末の画面を読めませんでした。もう一度");
  assert.equal(
    takeoverFailureText("target_invalid", false),
    "取り込めませんでした: 記録の写し先を使えません（CLAUDE_CONFIG_DIR の projects の外を指しています）",
  );
  assert.match(TAKEOVER_AFTER_TERM_TEXT, /\/cc take をもう一度/);
  const codes: TakeoverFailure[] = [
    "not_ready",
    "list_failed",
    "outside_workspace",
    "channel_busy",
    "channel_changed",
    "no_category",
    "target_invalid",
    "tmux_failed",
    "busy",
    "waiting",
    "not_in_tmux",
    "pane",
    "queued",
    "already_taken",
    "in_progress",
    "no_transcript",
    "too_large",
    "changed",
    "identity",
    "not_exited",
    "copy_failed",
    "restart",
  ];
  const texts = new Set(codes.map((code) => takeoverFailureText(code, false)));
  assert.equal(texts.size, codes.length);
});
