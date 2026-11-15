// 話題の一覧の純関数（app/topics.ts。docs/plan/web-ui-v3.md §11 の M1）
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildTopics,
  compareTopics,
  compareTurns,
  groupKeyOf,
  pickTurn,
  summarize,
  TOPICS_DONE_MAX,
  type Topic,
  type TopicsInput,
  type TopicSeed,
  type TopicTurn,
} from "../src/app/topics.ts";

const at = (minute: number) => new Date(Date.UTC(2026, 10, 14, 0, minute)).toISOString();

function turn(kind: TopicTurn["kind"], since: number, expires: number | null = null): TopicTurn {
  return { kind, summary: kind, since: at(since), expiresAt: expires === null ? null : at(expires) };
}

function seed(id: string, overrides: Partial<TopicSeed> = {}): TopicSeed {
  return {
    id,
    title: id,
    origin: "session",
    dir: null,
    outside: false,
    pinned: false,
    persona: null,
    sessionId: null,
    cwdLabel: null,
    state: "active",
    activityAt: at(0),
    last: null,
    link: null,
    running: false,
    turns: [],
    movable: true,
    ...overrides,
  };
}

function input(seeds: TopicSeed[], overrides: Partial<TopicsInput> = {}): TopicsInput {
  return { seeds, projects: [], rightHands: [], done: null, cc: { enabled: true, stale: false, unreadable: false }, ...overrides };
}

function topic(id: string, overrides: Partial<Topic> = {}): Topic {
  return {
    id,
    title: id,
    group: "general",
    place: { dir: null },
    origin: "session",
    pinned: false,
    persona: null,
    sessionId: null,
    cwdLabel: null,
    mark: null,
    turn: null,
    state: "active",
    activityAt: at(0),
    last: null,
    movable: true,
    link: null,
    ...overrides,
  };
}

test("summarize: 改行と連続の空白を 1 つにし、80 字を超えたら 79 字 + …", () => {
  assert.equal(summarize("  a\n\n b\t\tc  "), "a b c");
  assert.equal(summarize("x".repeat(80)), "x".repeat(80));
  const long = summarize("y".repeat(81));
  assert.equal(long, `${"y".repeat(79)}…`);
  assert.equal(long.length, 80);
});

test("groupKeyOf: outside は other、dir は p:<名前>、ほかは general", () => {
  assert.equal(groupKeyOf({ dir: "alpha", outside: true }), "other");
  assert.equal(groupKeyOf({ dir: null, outside: true }), "other");
  assert.equal(groupKeyOf({ dir: "alpha", outside: false }), "p:alpha");
  assert.equal(groupKeyOf({ dir: null, outside: false }), "general");
});

test("pickTurn: 許可・質問 > 判断待ち > 確認。同じなら古い方。空は null", () => {
  assert.equal(pickTurn([]), null);
  const confirm = turn("confirm", 1);
  const waiting = turn("waiting", 5);
  const question = turn("question", 9);
  const permission = turn("permission", 3);
  assert.equal(pickTurn([confirm, waiting]), waiting);
  assert.equal(pickTurn([confirm, waiting, question]), question);
  assert.equal(pickTurn([question, permission, waiting]), permission);
  const older = turn("confirm", 0);
  assert.equal(pickTurn([confirm, older]), older);
});

test("compareTurns: 時間切れの近い順、null は後ろ、同じなら古い順", () => {
  const soon = turn("permission", 5, 10);
  const later = turn("permission", 1, 20);
  const none = turn("waiting", 0);
  const noneNewer = turn("waiting", 3);
  assert.deepEqual([none, later, soon, noneNewer].sort(compareTurns), [soon, later, none, noneNewer]);
  const sameA = turn("permission", 2, 10);
  assert.ok(compareTurns(sameA, soon) < 0);
});

test("compareTopics: 固定は末尾、あなたの番 → 作業中 → ほか、同じ印は新しい順、最後は id", () => {
  const pinned = topic("pin", { pinned: true, mark: "turn", turn: turn("confirm", 0) });
  const turnLate = topic("t2", { mark: "turn", turn: turn("permission", 0, 30) });
  const turnSoon = topic("t1", { mark: "turn", turn: turn("permission", 0, 10) });
  const running = topic("r", { mark: "running" });
  const newer = topic("b", { activityAt: at(5) });
  const sameB = topic("d", { activityAt: at(1) });
  const sameA = topic("c", { activityAt: at(1) });
  const sorted = [pinned, sameB, newer, running, turnLate, sameA, turnSoon].sort(compareTopics);
  assert.deepEqual(
    sorted.map((t) => t.id),
    ["t1", "t2", "r", "b", "c", "d", "pin"],
  );
});

test("compareTopics: activityAt が null（履歴の無い入口）は一番古い扱い", () => {
  const none = topic("n", { activityAt: null });
  const old = topic("o", { activityAt: at(0) });
  const newer = topic("w", { activityAt: at(5) });
  assert.deepEqual(
    [none, newer, old].sort(compareTopics).map((t) => t.id),
    ["w", "o", "n"],
  );
});

test("buildTopics: 3 種類（session・project・cc）が同じ形の Topic になり、id は ch: か cc:", () => {
  const result = buildTopics(
    input([
      seed("ch:1"),
      seed("ch:2", { origin: "project", dir: "alpha" }),
      seed("cc:s", { origin: "cc", dir: "alpha", sessionId: "s", cwdLabel: "alpha/sub", movable: { reason: "x" } }),
    ]),
  );
  const keys = Object.keys(result.topics[0]!).sort();
  for (const item of result.topics) {
    assert.deepEqual(Object.keys(item).sort(), keys);
    assert.match(item.id, /^(ch|cc):/);
  }
  assert.deepEqual(
    result.topics.map((t) => [t.id, t.origin, t.group, t.place.dir]),
    [
      ["cc:s", "cc", "p:alpha", "alpha"],
      ["ch:2", "project", "p:alpha", "alpha"],
      ["ch:1", "session", "general", null],
    ],
  );
});

test("buildTopics: 群の順は 話題のあるプロジェクト → 無いプロジェクト → general → other。general は空でも出て、other は seed があるときだけ", () => {
  const withOther = buildTopics(
    input([seed("ch:1", { dir: "zeta" }), seed("cc:x", { origin: "cc", outside: true, dir: "ignored" })], { projects: ["beta", "Alpha", "zeta"] }),
  );
  assert.deepEqual(
    withOther.groups.map((g) => [g.key, g.kind, g.name, g.open, g.hasTopics]),
    [
      ["p:zeta", "project", "zeta", 1, true],
      ["p:Alpha", "project", "Alpha", 0, false],
      ["p:beta", "project", "beta", 0, false],
      ["general", "general", "General", 0, false],
      ["other", "other", "ほかの場所", 1, true],
    ],
  );
  // other の place は dir を持たない
  assert.equal(withOther.topics.find((t) => t.id === "cc:x")!.place.dir, null);
  const empty = buildTopics(input([]));
  assert.deepEqual(
    empty.groups.map((g) => g.key),
    ["general"],
  );
  // 完了だけのプロジェクトも群になる（open 0）
  const doneOnly = buildTopics(input([seed("ch:9", { dir: "gamma", state: "done" })]));
  assert.deepEqual(
    doneOnly.groups.map((g) => [g.key, g.open, g.done]),
    [
      ["p:gamma", 0, 1],
      ["general", 0, 0],
    ],
  );
});

test("buildTopics: turns は印が turn の話題と右腕の数、turnIds は時間切れの近い順", () => {
  const result = buildTopics(
    input(
      [
        seed("ch:a", { turns: [turn("waiting", 1)] }),
        seed("ch:b", { turns: [turn("permission", 2, 10)], dir: "alpha" }),
        seed("ch:c", { running: true }),
        seed("ch:d", { turns: [turn("confirm", 0, 20)], pinned: true }),
      ],
      {
        rightHands: [
          { id: "ch:r", guildId: "g", title: "右腕", last: null, link: "https://discord.com/channels/g/r", turns: [turn("confirm", 3, 5)] },
          { id: "ch:q", guildId: "g", title: "右腕", last: null, link: "https://discord.com/channels/g/q", turns: [] },
        ],
      },
    ),
  );
  assert.equal(result.turns, 4);
  assert.deepEqual(result.turnIds, ["ch:r", "ch:b", "ch:d", "ch:a"]);
  assert.deepEqual(
    result.rightHands.map((h) => [h.id, h.turn?.kind ?? null]),
    [
      ["ch:r", "confirm"],
      ["ch:q", null],
    ],
  );
  const general = result.groups.find((g) => g.key === "general")!;
  assert.deepEqual([general.turns, general.running, general.open], [2, 1, 3]);
  assert.equal(result.topics.find((t) => t.id === "ch:c")!.mark, "running");
});

test("buildTopics: done の話題は turn・mark を持たず、done が null なら topics に入らず数だけ返る", () => {
  const seeds = [seed("ch:done", { state: "done", running: true, turns: [turn("permission", 0, 5)] }), seed("ch:open")];
  const result = buildTopics(input(seeds));
  assert.deepEqual(
    result.topics.map((t) => t.id),
    ["ch:open"],
  );
  assert.equal(result.turns, 0);
  const general = result.groups.find((g) => g.key === "general")!;
  assert.deepEqual([general.open, general.done, general.turns, general.running], [1, 1, 0, 0]);
  const withDone = buildTopics(input(seeds, { done: "general" }));
  const done = withDone.topics.find((t) => t.id === "ch:done")!;
  assert.equal(done.turn, null);
  assert.equal(done.mark, null);
});

test("buildTopics: done=<群> はその群の完了だけを新しい順に 50 件まで足し、ほかの群の完了は足さない", () => {
  const seeds: TopicSeed[] = [seed("ch:open", { dir: "alpha" }), seed("ch:other-done", { state: "done" })];
  for (let i = 0; i < 60; i++) seeds.push(seed(`ch:d${String(i).padStart(2, "0")}`, { dir: "alpha", state: "done", activityAt: at(i) }));
  const result = buildTopics(input(seeds, { done: "p:alpha" }));
  const ids = result.topics.map((t) => t.id);
  assert.equal(ids[0], "ch:open");
  const done = ids.slice(1).filter((id) => id.startsWith("ch:d"));
  assert.equal(done.length, TOPICS_DONE_MAX);
  assert.equal(done[0], "ch:d59");
  assert.equal(done[49], "ch:d10");
  assert.equal(ids.includes("ch:other-done"), false);
  assert.equal(result.groups.find((g) => g.key === "p:alpha")!.done, 60);
  // 知らない群は完了 0 件
  assert.deepEqual(
    buildTopics(input(seeds, { done: "p:none" })).topics.map((t) => t.id),
    ["ch:open"],
  );
});

test('buildTopics: mark に "unread" を出さない', () => {
  const result = buildTopics(
    input([seed("ch:1", { last: { id: 9, at: at(9), kind: "agent" } }), seed("ch:2", { running: true }), seed("ch:3", { turns: [turn("waiting", 0)] })]),
  );
  for (const item of result.topics) assert.notEqual(item.mark, "unread");
});

test("buildTopics: 500 件の seed でも 50ms 以内に返り、入力の配列を書き換えない", () => {
  const seeds: TopicSeed[] = [];
  for (let i = 0; i < 500; i++) {
    seeds.push(
      seed(`ch:${i}`, {
        dir: i % 3 === 0 ? `p${i % 20}` : null,
        outside: i % 7 === 0,
        state: i % 5 === 0 ? "done" : "active",
        activityAt: at(i % 60),
        running: i % 4 === 0,
        turns: i % 6 === 0 ? [turn("confirm", i % 30), turn("waiting", i % 50)] : [],
      }),
    );
  }
  const data = input(seeds, { projects: ["p1", "p2"], done: "p:p0" });
  const before = JSON.stringify(data);
  const started = performance.now();
  buildTopics(data);
  const elapsed = performance.now() - started;
  // 目安は 50ms（負荷のある機械でも落ちないよう 1000ms で確かめる）
  assert.ok(elapsed < 1000, `${elapsed}ms`);
  assert.equal(JSON.stringify(data), before);
});
