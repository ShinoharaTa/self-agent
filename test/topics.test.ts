// 話題の一覧の純関数（app/topics.ts。docs/plan/web-ui-v3.md §11 の M1）
import { test } from "node:test";
import assert from "node:assert/strict";
import { SESSION_OPEN_TEXT_MAX_LENGTH } from "../src/agent/tools.ts";
import { TOPIC_TEXT_MAX_LENGTH } from "../src/app/session-ops.ts";
import {
  buildTopics,
  compareTopics,
  compareTurns,
  groupKeyOf,
  pickTurn,
  stoppedOf,
  summarize,
  TOPIC_LIST_MAX,
  topicListRows,
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
    queued: false,
    lastAgent: null,
    lastOwnerId: null,
    lastDividerId: null,
    byRightHand: false,
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
    queued: false,
    stopped: false,
    ended: null,
    tookMs: null,
    byRightHand: false,
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

test("buildTopics: dir が generalDir の話題は群 general で place.dir はその名前。p:<General> の群は作らない。projects に General があっても群にしない", () => {
  const result = buildTopics(
    input(
      [
        seed("ch:1", { origin: "project", dir: "General" }),
        seed("ch:2"),
        seed("cc:3", { origin: "cc", dir: "General" }),
        seed("ch:4", { origin: "project", dir: "alpha" }),
      ],
      { projects: ["General", "alpha"], generalDir: "General" },
    ),
  );
  assert.deepEqual(
    result.groups.map((group) => group.key),
    ["p:alpha", "general"],
  );
  const general = result.groups.find((group) => group.key === "general")!;
  assert.equal(general.open, 3);
  assert.equal(general.name, "General");
  const byId = new Map(result.topics.map((item) => [item.id, item]));
  assert.deepEqual([byId.get("ch:1")?.group, byId.get("ch:1")?.place.dir], ["general", "General"]);
  assert.deepEqual([byId.get("ch:2")?.group, byId.get("ch:2")?.place.dir], ["general", null]);
  assert.deepEqual([byId.get("cc:3")?.group, byId.get("cc:3")?.place.dir], ["general", "General"]);
  assert.equal(byId.get("ch:4")?.group, "p:alpha");
  assert.equal(groupKeyOf({ dir: "General", outside: false }, "General"), "general");
  assert.equal(groupKeyOf({ dir: "General", outside: true }, "General"), "other");
});

test("buildTopics: generalDir を渡さなければ今までどおり（dir があれば p:）", () => {
  const result = buildTopics(input([seed("ch:1", { origin: "project", dir: "General" })], { projects: ["General"] }));
  assert.deepEqual(
    result.groups.map((group) => group.key),
    ["p:General", "general"],
  );
  assert.equal(result.topics[0]?.group, "p:General");
  assert.equal(groupKeyOf({ dir: "General", outside: false }), "p:General");
});

// ---- 右腕の topic_list の行（topicListRows。M6b） ----

const LIST_OPTIONS = { timeZone: "Asia/Tokyo", generalDir: "General" };

test("topicListRows: あなたの番 → 作業中 → 残り（待ち・進行中）の順で、同じ中では新しい順。state・turn・place・at が入る", () => {
  const result = buildTopics(
    input([
      seed("ch:1", { activityAt: at(5) }),
      seed("ch:2", { activityAt: at(1), running: true, dir: "alpha", origin: "project" }),
      seed("ch:3", { activityAt: at(2), turns: [turn("permission", 0)], dir: "General", origin: "project" }),
      seed("ch:4", { activityAt: at(9), state: "waiting" }),
      seed("ch:5", { activityAt: at(3), running: true }),
    ]),
  );
  const rows = topicListRows(result, LIST_OPTIONS);
  assert.deepEqual(
    rows.topics.map((row) => [row.channel_id, row.state]),
    [
      ["3", "your_turn"],
      ["5", "running"],
      ["2", "running"],
      ["4", "waiting"],
      ["1", "idle"],
    ],
  );
  assert.deepEqual(rows.topics[0], { channel_id: "3", kind: "session", title: "ch:3", place: "General", state: "your_turn", turn: "permission", at: "2026-11-14 09:02" });
  assert.deepEqual(
    rows.topics.map((row) => row.place),
    ["General", "なし", "alpha", "なし", "なし"],
  );
  assert.equal(rows.topics.filter((row) => row.turn !== undefined).length, 1);
  assert.deepEqual(rows.counts, { your_turn: 1, running: 2, queued: 0, stopped: 0, total: 5 });
  assert.equal(rows.more, 0);
});

test("topicListRows: あなたの番・作業中でない入口と、完了した話題は出ない（数にも入らない）", () => {
  const result = buildTopics(
    input(
      [
        seed("ch:1"),
        seed("ch:2", { pinned: true }),
        seed("ch:3", { state: "done" }),
        seed("ch:4", { pinned: true, state: "waiting" }),
      ],
      { done: "general" },
    ),
  );
  const rows = topicListRows(result, LIST_OPTIONS);
  assert.deepEqual(
    rows.topics.map((row) => row.channel_id),
    ["1"],
  );
  assert.deepEqual(rows.counts, { your_turn: 0, running: 0, queued: 0, stopped: 0, total: 1 });
});

test("topicListRows: 入口に「あなたの番」があると行に出て、counts.your_turn が result.turns と同じ", () => {
  const result = buildTopics(input([seed("ch:1"), seed("ch:2", { title: "#tasks", pinned: true, turns: [turn("confirm", 0)], activityAt: at(3) })]));
  const rows = topicListRows(result, LIST_OPTIONS);
  assert.deepEqual(rows.topics[0], { channel_id: "2", kind: "session", title: "#tasks", place: "なし", state: "your_turn", turn: "confirm", at: "2026-11-14 09:03" });
  assert.equal(rows.counts.your_turn, result.turns);
  assert.equal(rows.counts.your_turn, 1);
  assert.equal(rows.counts.total, 2);
});

test("topicListRows: 入口が作業中だと行に出て、counts.running が群の running の和と同じ", () => {
  const result = buildTopics(
    input([seed("ch:1", { running: true, dir: "alpha", origin: "project" }), seed("ch:2", { title: "#Mika", pinned: true, running: true, persona: "Mika" })]),
  );
  const rows = topicListRows(result, LIST_OPTIONS);
  assert.deepEqual(
    rows.topics.map((row) => [row.channel_id, row.title, row.state]),
    [
      ["1", "ch:1", "running"],
      ["2", "#Mika", "running"],
    ],
  );
  assert.equal(rows.counts.running, result.groups.reduce((sum, group) => sum + group.running, 0));
  assert.equal(rows.counts.running, 2);
});

test("topicListRows: 右腕に「あなたの番」があると #inbox の行が出て、counts.your_turn が result.turns と同じ。番の無い右腕は出ない", () => {
  const result = buildTopics(
    input([seed("ch:1")], {
      rightHands: [
        { id: "ch:10", guildId: "guild-1", title: "右腕", last: { id: 1, at: at(4), kind: "agent" }, link: "https://x", turns: [turn("confirm", 0)] },
        { id: "ch:20", guildId: "guild-2", title: "右腕", last: { id: 2, at: at(5), kind: "agent" }, link: "https://y", turns: [] },
      ],
    }),
  );
  const rows = topicListRows(result, LIST_OPTIONS);
  assert.deepEqual(rows.topics, [
    { channel_id: "10", kind: "session", title: "#inbox", place: "なし", state: "your_turn", turn: "confirm", at: "2026-11-14 09:04" },
    { channel_id: "1", kind: "session", title: "ch:1", place: "なし", state: "idle", at: "2026-11-14 09:00" },
  ]);
  assert.equal(rows.counts.your_turn, result.turns);
  assert.deepEqual(rows.counts, { your_turn: 1, running: 0, queued: 0, stopped: 0, total: 2 });
});

test("topicListRows: 右腕の最後の発言が無ければ at は空で、あなたの番の中で一番古い扱い", () => {
  const result = buildTopics(
    input([seed("ch:1", { turns: [turn("question", 0)], activityAt: at(1) })], {
      rightHands: [{ id: "ch:10", guildId: "guild-1", title: "右腕", last: null, link: "https://x", turns: [turn("confirm", 0)] }],
    }),
  );
  const rows = topicListRows(result, LIST_OPTIONS);
  assert.deepEqual(
    rows.topics.map((row) => [row.channel_id, row.at]),
    [
      ["1", "2026-11-14 09:01"],
      ["10", ""],
    ],
  );
});

test("topicListRows: 話題・入口・右腕に 1 つずつ番があると counts.your_turn === result.turns === 3", () => {
  const result = buildTopics(
    input([seed("ch:1", { turns: [turn("permission", 0)] }), seed("ch:2", { title: "#tasks", pinned: true, turns: [turn("confirm", 1)] })], {
      rightHands: [{ id: "ch:10", guildId: "guild-1", title: "右腕", last: null, link: "https://x", turns: [turn("confirm", 2)] }],
    }),
  );
  const rows = topicListRows(result, LIST_OPTIONS);
  assert.equal(result.turns, 3);
  assert.equal(rows.counts.your_turn, 3);
  assert.equal(rows.counts.your_turn, result.turns);
});

test("topicListRows: 31 件あると topics は 30 件で more が 1、counts は 31 件分", () => {
  const seeds = Array.from({ length: TOPIC_LIST_MAX + 1 }, (_, i) => seed(`ch:${i + 1}`, { activityAt: at(i), running: i === 0 }));
  const rows = topicListRows(buildTopics(input(seeds)), LIST_OPTIONS);
  assert.equal(TOPIC_LIST_MAX, 30);
  assert.equal(rows.topics.length, 30);
  assert.equal(rows.more, 1);
  assert.deepEqual(rows.counts, { your_turn: 0, running: 1, queued: 0, stopped: 0, total: 31 });
  // 作業中が先、残りは新しい順なので、いちばん古い（ch:2）が切られる
  assert.equal(rows.topics[0]?.channel_id, "1");
  assert.equal(rows.topics.some((row) => row.channel_id === "2"), false);
});

test("topicListRows: Claude Code だけの行には channel_id が無く、kind が claude_code。チャンネルのある行は kind session", () => {
  const rows = topicListRows(
    buildTopics(
      input([
        seed("cc:abc", { origin: "cc", sessionId: "abc", cwdLabel: "~/x", dir: "alpha" }),
        seed("ch:9", { origin: "cc", activityAt: at(1) }),
      ]),
    ),
    LIST_OPTIONS,
  );
  const cc = rows.topics.find((row) => row.kind === "claude_code");
  assert.ok(cc !== undefined);
  assert.equal("channel_id" in cc, false);
  assert.equal(cc.place, "alpha");
  assert.deepEqual(rows.topics.find((row) => row.channel_id === "9")?.kind, "session");
});

test("topicListRows: 行に最後の発言の本文・sessionId・cwd・link が入らない（キーの一覧）", () => {
  const rows = topicListRows(
    buildTopics(
      input([
        seed("cc:abc", { origin: "cc", sessionId: "abc", cwdLabel: "~/secret", last: { id: 1, at: at(0), kind: "owner" }, link: "https://x" }),
        seed("ch:1", { turns: [turn("question", 0)], last: { id: 2, at: at(0), kind: "agent" }, link: "https://y" }),
      ]),
    ),
    LIST_OPTIONS,
  );
  assert.deepEqual(
    rows.topics.map((row) => Object.keys(row).sort()),
    [
      ["at", "channel_id", "kind", "place", "state", "title", "turn"],
      ["at", "kind", "place", "state", "title"],
    ],
  );
  assert.equal(JSON.stringify(rows).includes("secret"), false);
  assert.equal(JSON.stringify(rows).includes("https://"), false);
});

test("SESSION_OPEN_TEXT_MAX_LENGTH は startTopic の TOPIC_TEXT_MAX_LENGTH と同じ", () => {
  assert.equal(SESSION_OPEN_TEXT_MAX_LENGTH, TOPIC_TEXT_MAX_LENGTH);
});

// ---- 順番待ち・止まった・終わり方・かかった時間・右腕の印（#457 の L1a） ----

test("stoppedOf: 上限・失敗・中断で終わり、後に owner の行が無ければ真。ふつうの終わり・後に owner の行・agent の行なしは偽", () => {
  for (const outcome of ["max_turns", "failed", "aborted"] as const) {
    assert.equal(stoppedOf({ id: 5, at: at(0), outcome, durationMs: null }, null, null), true, outcome);
    assert.equal(stoppedOf({ id: 5, at: at(0), outcome, durationMs: null }, 4, null), true, outcome);
    assert.equal(stoppedOf({ id: 5, at: at(0), outcome, durationMs: null }, 6, null), false, outcome);
  }
  assert.equal(stoppedOf({ id: 5, at: at(0), outcome: "done", durationMs: 1000 }, null, null), false);
  assert.equal(stoppedOf({ id: 5, at: at(0), outcome: null, durationMs: null }, null, null), false);
  assert.equal(stoppedOf(null, null, null), false);
  assert.equal(stoppedOf(null, 3, null), false);
});

test("stoppedOf: 後に区切り（divider）の行があれば偽。前の区切り・区切りの後にもう一度止まったのは真", () => {
  for (const outcome of ["max_turns", "failed", "aborted"] as const) {
    assert.equal(stoppedOf({ id: 5, at: at(0), outcome, durationMs: null }, null, 6), false, outcome);
    assert.equal(stoppedOf({ id: 5, at: at(0), outcome, durationMs: null }, 4, 6), false, outcome);
    assert.equal(stoppedOf({ id: 5, at: at(0), outcome, durationMs: null }, null, 4), true, outcome);
    assert.equal(stoppedOf({ id: 5, at: at(0), outcome, durationMs: null }, 3, 4), true, outcome);
  }
  // 同じ話題で区切りの後にもう一度止まった（agent の行の id の方が大きい）
  assert.equal(stoppedOf({ id: 9, at: at(0), outcome: "max_turns", durationMs: null }, 7, 8), true);
});

const STOPPED_SEED = { lastAgent: { id: 10, at: at(1), outcome: "failed", durationMs: 90_000 }, lastOwnerId: 9 } as const;

test("buildTopics: queued は running なら false。stopped は running・queued・done なら false。ended・tookMs・byRightHand はそのまま", () => {
  const result = buildTopics(
    input(
      [
        seed("ch:1", { queued: true }),
        seed("ch:2", { queued: true, running: true }),
        seed("ch:3", { ...STOPPED_SEED, byRightHand: true }),
        seed("ch:4", { ...STOPPED_SEED, running: true }),
        seed("ch:5", { ...STOPPED_SEED, queued: true }),
        seed("ch:6", { ...STOPPED_SEED, state: "done" }),
        seed("ch:7", { lastAgent: { id: 10, at: at(0), outcome: "done", durationMs: 1000 }, lastOwnerId: 11 }),
      ],
      { done: "general" },
    ),
  );
  const of = (id: string) => result.topics.find((item) => item.id === id)!;
  assert.deepEqual(
    ["ch:1", "ch:2", "ch:3", "ch:4", "ch:5", "ch:6", "ch:7"].map((id) => [id, of(id).queued, of(id).stopped]),
    [
      ["ch:1", true, false],
      ["ch:2", false, false],
      ["ch:3", false, true],
      ["ch:4", false, false],
      ["ch:5", true, false],
      ["ch:6", false, false],
      ["ch:7", false, false],
    ],
  );
  assert.deepEqual([of("ch:3").ended, of("ch:3").tookMs, of("ch:3").byRightHand], ["failed", 90_000, true]);
  assert.deepEqual([of("ch:7").ended, of("ch:7").tookMs, of("ch:7").byRightHand], ["done", 1000, false]);
  assert.deepEqual([of("ch:1").ended, of("ch:1").tookMs], [null, null]);
  // queued は mark にしない。失敗で止まった話題（active）は あなたの番（#457 の L1c PR-3）
  assert.equal(of("ch:1").mark, null);
  assert.equal(of("ch:3").mark, "turn");
  assert.equal(result.groups.find((group) => group.key === "general")?.running, 2);
});

test("topicListRows: あなたの番 → 止まった → 作業中 → 順番待ち → 残りの順。counts に queued・stopped", () => {
  const result = buildTopics(
    input([
      seed("ch:1", { activityAt: at(9) }),
      seed("ch:2", { activityAt: at(1), running: true }),
      seed("ch:3", { activityAt: at(8), queued: true }),
      seed("ch:4", { activityAt: at(2), ...STOPPED_SEED }),
      seed("ch:5", { activityAt: at(3), turns: [turn("question", 0)], ...STOPPED_SEED }),
      seed("ch:6", { activityAt: at(7), state: "waiting" }),
      seed("ch:7", { activityAt: at(4), queued: true }),
    ]),
  );
  const rows = topicListRows(result, LIST_OPTIONS);
  assert.deepEqual(
    rows.topics.map((row) => [row.channel_id, row.state]),
    [
      ["5", "your_turn"],
      ["4", "stopped"],
      ["2", "running"],
      ["3", "queued"],
      ["7", "queued"],
      ["1", "idle"],
      ["6", "waiting"],
    ],
  );
  assert.deepEqual(rows.counts, { your_turn: 1, running: 1, queued: 2, stopped: 1, total: 7 });
});

test("buildTopics・topicListRows: 止まった後に区切り（divider）の行があれば stopped は false、state は idle（待ちなら waiting）", () => {
  const result = buildTopics(
    input([
      seed("ch:1", { activityAt: at(2), ...STOPPED_SEED, lastDividerId: 11 }),
      seed("ch:2", { activityAt: at(1), ...STOPPED_SEED, lastDividerId: 11, state: "waiting" }),
      seed("ch:3", { activityAt: at(3), ...STOPPED_SEED, lastDividerId: 8 }),
    ]),
  );
  const of = (id: string) => result.topics.find((item) => item.id === id)!;
  assert.deepEqual(
    ["ch:1", "ch:2", "ch:3"].map((id) => [id, of(id).stopped]),
    [
      ["ch:1", false],
      ["ch:2", false],
      ["ch:3", true],
    ],
  );
  const rows = topicListRows(result, LIST_OPTIONS);
  assert.deepEqual(
    rows.topics.map((row) => [row.channel_id, row.state]),
    [
      ["3", "stopped"],
      ["1", "idle"],
      ["2", "waiting"],
    ],
  );
});

test("topicListRows: ended・took_min（1 分の下限・丸め）・by_right_hand は値が在るときだけ", () => {
  const agent = (durationMs: number | null) => ({ lastAgent: { id: 10, at: at(0), outcome: "done" as const, durationMs }, lastOwnerId: 9 });
  const result = buildTopics(
    input([
      seed("ch:1", { activityAt: at(5), ...agent(29_000) }),
      seed("ch:2", { activityAt: at(4), ...agent(90_000) }),
      seed("ch:3", { activityAt: at(3), ...agent(null), byRightHand: true }),
      seed("ch:4", { activityAt: at(2) }),
    ]),
  );
  const rows = topicListRows(result, LIST_OPTIONS);
  const of = (id: string) => rows.topics.find((row) => row.channel_id === id)!;
  assert.equal(of("1").took_min, 1);
  assert.equal(of("2").took_min, 2);
  assert.equal("took_min" in of("3"), false);
  assert.equal(of("3").ended, "done");
  assert.equal(of("3").by_right_hand, true);
  assert.equal("by_right_hand" in of("1"), false);
  assert.deepEqual(Object.keys(of("4")).sort(), ["at", "channel_id", "kind", "place", "state", "title"]);
});

// ---- 上限・失敗で止まった話題を あなたの番 に数える（#457 の L1c PR-3） ----

const stoppedSeed = (outcome: "max_turns" | "failed" | "aborted", minute: number) =>
  ({ lastAgent: { id: 10, at: at(minute), outcome, durationMs: 60_000 }, lastOwnerId: 9 }) as const;

test("buildTopics: 上限・失敗で止まった active の話題は mark turn・turn は終わり方の種類で、turns・turnIds・群の turns に入る", () => {
  const result = buildTopics(
    input([seed("ch:1", { dir: "alpha", ...stoppedSeed("max_turns", 3) }), seed("ch:2", { dir: "alpha", ...stoppedSeed("failed", 4) })], {
      projects: ["alpha"],
    }),
  );
  const of = (id: string) => result.topics.find((item) => item.id === id)!;
  assert.equal(of("ch:1").mark, "turn");
  assert.deepEqual(of("ch:1").turn, { kind: "max_turns", summary: "", since: at(3), expiresAt: null });
  assert.equal(of("ch:2").mark, "turn");
  assert.deepEqual(of("ch:2").turn, { kind: "failed", summary: "", since: at(4), expiresAt: null });
  // stopped・ended・tookMs の意味は変えない
  assert.deepEqual([of("ch:1").stopped, of("ch:1").ended, of("ch:1").tookMs], [true, "max_turns", 60_000]);
  assert.equal(result.turns, 2);
  assert.deepEqual(result.turnIds, ["ch:1", "ch:2"]);
  assert.equal(result.groups.find((group) => group.key === "p:alpha")?.turns, 2);
});

test("buildTopics: 中断・待ち・完了・作業中・順番待ち・後に owner の行・後に区切りの話題は あなたの番 にならない", () => {
  const result = buildTopics(
    input(
      [
        seed("ch:1", stoppedSeed("aborted", 1)),
        seed("ch:2", { ...stoppedSeed("max_turns", 1), state: "waiting" }),
        seed("ch:3", { ...stoppedSeed("failed", 1), state: "done" }),
        seed("ch:4", { ...stoppedSeed("max_turns", 1), running: true }),
        seed("ch:5", { ...stoppedSeed("failed", 1), queued: true }),
        seed("ch:6", { ...stoppedSeed("max_turns", 1), lastOwnerId: 11 }),
        seed("ch:7", { ...stoppedSeed("failed", 1), lastDividerId: 11 }),
      ],
      { done: "general" },
    ),
  );
  const of = (id: string) => result.topics.find((item) => item.id === id)!;
  assert.deepEqual(
    ["ch:1", "ch:2", "ch:3", "ch:4", "ch:5", "ch:6", "ch:7"].map((id) => [id, of(id).mark, of(id).turn, of(id).stopped]),
    [
      ["ch:1", null, null, true],
      ["ch:2", null, null, true],
      ["ch:3", null, null, false],
      ["ch:4", "running", null, false],
      ["ch:5", null, null, false],
      ["ch:6", null, null, false],
      ["ch:7", null, null, false],
    ],
  );
  assert.equal(result.turns, 0);
  assert.deepEqual(result.turnIds, []);
});

test("buildTopics: 止まった話題にほかの番（/close の確認・許可）が在れば、ほかの番が勝つ", () => {
  const result = buildTopics(
    input([
      seed("ch:1", { ...stoppedSeed("max_turns", 1), turns: [turn("confirm", 5)] }),
      seed("ch:2", { ...stoppedSeed("failed", 1), turns: [turn("permission", 6)] }),
    ]),
  );
  const of = (id: string) => result.topics.find((item) => item.id === id)!;
  assert.equal(of("ch:1").turn?.kind, "confirm");
  assert.equal(of("ch:2").turn?.kind, "permission");
  assert.equal(result.turns, 2);
});

test("buildTopics: 並びは時間切れの在る許可が先、止まった話題は since（最後の agent の行の時刻）の古い順", () => {
  const result = buildTopics(
    input([
      seed("ch:1", { activityAt: at(9), ...stoppedSeed("max_turns", 8) }),
      seed("ch:2", { activityAt: at(2), ...stoppedSeed("failed", 2) }),
      seed("ch:3", { activityAt: at(1), turns: [turn("permission", 7, 30)] }),
    ]),
  );
  assert.deepEqual(result.turnIds, ["ch:3", "ch:2", "ch:1"]);
  assert.deepEqual(result.topics.map((item) => item.id), ["ch:3", "ch:2", "ch:1"]);
});

test("topicListRows: 上限・失敗で止まった番の話題は stopped の行で turn を付けない。counts.your_turn + その行の数 = result.turns", () => {
  const result = buildTopics(
    input(
      [
        seed("ch:1", { activityAt: at(3), ...stoppedSeed("max_turns", 3) }),
        seed("ch:2", { activityAt: at(2), ...stoppedSeed("failed", 2) }),
        seed("ch:3", { activityAt: at(1), turns: [turn("question", 1)] }),
        seed("ch:4", { activityAt: at(4), ...stoppedSeed("aborted", 4) }),
      ],
      { rightHands: [{ id: "ch:10", guildId: "guild-1", title: "右腕", last: null, link: "https://x", turns: [turn("confirm", 0)] }] },
    ),
  );
  const rows = topicListRows(result, LIST_OPTIONS);
  const of = (id: string) => rows.topics.find((row) => row.channel_id === id)!;
  assert.deepEqual(
    ["1", "2", "3", "4", "10"].map((id) => [id, of(id).state, "turn" in of(id)]),
    [
      ["1", "stopped", false],
      ["2", "stopped", false],
      ["3", "your_turn", true],
      ["4", "stopped", false],
      ["10", "your_turn", true],
    ],
  );
  assert.deepEqual(rows.counts, { your_turn: 2, running: 0, queued: 0, stopped: 3, total: 5 });
  const stoppedTurns = result.topics.filter((item) => item.mark === "turn" && (item.turn?.kind === "max_turns" || item.turn?.kind === "failed")).length;
  assert.equal(stoppedTurns, 2);
  assert.equal(rows.counts.your_turn + stoppedTurns, result.turns);
});

test("buildTopics: 完了の話題は種の queued が true でも queued: false", () => {
  const result = buildTopics(input([seed("ch:1", { queued: true, state: "done" }), seed("ch:2", { queued: true })], { done: "general" }));
  const of = (id: string) => result.topics.find((item) => item.id === id)!;
  assert.deepEqual([of("ch:1").queued, of("ch:2").queued], [false, true]);
});

test("topicListRows: 作業中・順番待ちの行には ended・took_min を付けない（前のターンの値）。止まった・idle の行には付く", () => {
  const agent = { lastAgent: { id: 10, at: at(0), outcome: "done" as const, durationMs: 90_000 }, lastOwnerId: 11 };
  const result = buildTopics(
    input([
      seed("ch:1", { activityAt: at(5), ...agent, running: true, byRightHand: true }),
      seed("ch:2", { activityAt: at(4), ...agent, queued: true, byRightHand: true }),
      seed("ch:3", { activityAt: at(3), ...STOPPED_SEED }),
      seed("ch:4", { activityAt: at(2), ...agent }),
    ]),
  );
  const rows = topicListRows(result, LIST_OPTIONS);
  const of = (id: string) => rows.topics.find((row) => row.channel_id === id)!;
  assert.deepEqual(
    ["1", "2", "3", "4"].map((id) => [of(id).state, of(id).ended, of(id).took_min, "ended" in of(id), "took_min" in of(id)]),
    [
      ["running", undefined, undefined, false, false],
      ["queued", undefined, undefined, false, false],
      ["stopped", "failed", 2, true, true],
      ["idle", "done", 2, true, true],
    ],
  );
  // by_right_hand は今までどおり付く
  assert.deepEqual([of("1").by_right_hand, of("2").by_right_hand], [true, true]);
});
