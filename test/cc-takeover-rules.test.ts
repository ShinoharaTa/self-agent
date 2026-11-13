import { test } from "node:test";
import assert from "node:assert/strict";
import {
  appendedInterrupted,
  mapTakeoverMode,
  parseStatStartTime,
  TAKEOVER_AFTER_TERM_TEXT,
  TAKEOVER_EXIT_POLL_MS,
  TAKEOVER_EXIT_TIMEOUT_MS,
  TAKEOVER_MAX_BYTES,
  TAKEOVER_SETTLE_MS,
  takeoverFailureText,
  takeoverRefusal,
  type TakeoverFailure,
  type TakeoverRefusalInput,
} from "../src/cc/takeover-rules.ts";

type AliveView = Extract<TakeoverRefusalInput["session"], { source: "alive" }>["view"];

function alive(view: Partial<AliveView> = {}, pane: Extract<TakeoverRefusalInput["session"], { source: "alive" }>["pane"] = "idle") {
  return { source: "alive" as const, view: { state: "idle" as const, status: "idle", kind: "interactive", trustPending: false, ...view }, pane };
}

function input(overrides: Partial<TakeoverRefusalInput> = {}): TakeoverRefusalInput {
  return { ready: true, session: alive(), project: "alpha", queued: 0, pendingPermission: false, mapped: false, ...overrides };
}

test("定数", () => {
  assert.equal(TAKEOVER_SETTLE_MS, 2000);
  assert.equal(TAKEOVER_EXIT_TIMEOUT_MS, 10000);
  assert.equal(TAKEOVER_EXIT_POLL_MS, 250);
  assert.equal(TAKEOVER_MAX_BYTES, 128 * 1024 * 1024);
});

test("takeoverRefusal: 待機・tmux の中・直下・届け待ちなし・未取り込みなら取り込める", () => {
  assert.equal(takeoverRefusal(input()), undefined);
  assert.equal(takeoverRefusal(input({ session: { source: "ended" } })), undefined);
});

test("takeoverRefusal: §4 の各符号", () => {
  const cases: Array<[Partial<TakeoverRefusalInput>, TakeoverFailure]> = [
    [{ ready: false }, "not_ready"],
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
    [{ session: alive({}, "failed") }, "pane"],
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

test("takeoverRefusal: 準備ができていなければ、ほかの条件より先に not_ready", () => {
  assert.equal(takeoverRefusal(input({ ready: false, project: undefined, queued: 3, mapped: true })), "not_ready");
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

test("parseStatStartTime: 22 番目の欄。comm の括弧・空白は最後の ) で切る", () => {
  const tail = (start: string) =>
    `S 100 100 100 34816 100 4194560 1000 0 0 0 10 5 0 0 20 0 1 0 ${start} 123456789 2000 18446744073709551615`;
  assert.equal(parseStatStartTime(`4242 (claude) ${tail("987654")}`), 987654);
  assert.equal(parseStatStartTime(`4242 (a (b) c) ${tail("55")}`), 55);
  assert.equal(parseStatStartTime(`4242 (x) y) ${tail("77")}`), 77);
  assert.equal(parseStatStartTime("4242 claude S 1"), undefined);
  assert.equal(parseStatStartTime("4242 (claude) S 1 2 3"), undefined);
  assert.equal(parseStatStartTime(`4242 (claude) ${tail("-1")}`), undefined);
  assert.equal(parseStatStartTime(""), undefined);
});

test("appendedInterrupted: type が user・assistant の行があれば true。読めない行は無視", () => {
  assert.equal(appendedInterrupted([]), false);
  assert.equal(appendedInterrupted(['{"type":"summary"}', '{"type":"system"}']), false);
  assert.equal(appendedInterrupted(["not json", '{"type":"user","message":{}}']), true);
  assert.equal(appendedInterrupted(['{"type":"assistant"}']), true);
  assert.equal(appendedInterrupted(["[1,2]", "null", '"user"', '{"type":"user"']), false);
});

test("takeoverFailureText: §4 の文。終了の後なら次の行に足す", () => {
  assert.equal(takeoverFailureText("busy", false), "取り込めませんでした: 実行中です。待機になってからもう一度");
  assert.equal(takeoverFailureText("waiting", false), "取り込めませんでした: 判断待ち（許可・質問）です。待機になってからもう一度");
  assert.equal(takeoverFailureText("copy_failed", true), `取り込めませんでした: 記録を写せませんでした\n${TAKEOVER_AFTER_TERM_TEXT}`);
  assert.match(TAKEOVER_AFTER_TERM_TEXT, /\/cc take をもう一度/);
  const codes: TakeoverFailure[] = [
    "not_ready",
    "outside_workspace",
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
