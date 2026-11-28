import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import vm from "node:vm";
import { staticFileFor } from "../src/web/static.ts";

// 新しい入口の計算（src/web/static/n-calc.js。docs/plan/web-ui-home.md §4.4 の P2a）。DOM・時計・タイマーは使わない。
// 決めた答えを直に書いた検査と、「古い … と同じ」（今の api.js・topics.js・c-deck.js・c-list.js と同じ入力で同じ答え）の検査。後者は古いファイルを消す段（Z）で消す
const STATIC_DIR = fileURLToPath(new URL("../src/web/static/", import.meta.url));
const read = (name: string): string => readFileSync(join(STATIC_DIR, name), "utf8");

type Obj = Record<string, unknown>;
type Entry = { key: string; kind: string; id: string | null; at: string | null; src: unknown; hand?: boolean };
type Strip = { key: string; kind: string; id: string | null; src: unknown; turn: boolean; unread: boolean };
type Calc = {
  BACKOFF_MAX_MS: number;
  FEED_MAX: number;
  NEAR_END_PX: number;
  MAIN: readonly string[];
  turnsPath(channelId: string, query: string): string;
  mergeTurns(current: Obj[], incoming: Obj[]): Obj[];
  realTurns(t: { turns: Obj[] }): Obj[];
  backoff(base: number, fails: number, max?: number): number;
  emptyTurns(): Obj;
  optimisticTurn(turnId: number, text: string, at: string): Obj;
  lastRowId(turns: unknown): number | null;
  isUnread(channelId: string, last: unknown, seen: unknown): boolean;
  seenUpTo(seen: unknown, channelId: string, id: unknown): unknown;
  mergeReads(seen: unknown, reads: unknown, ids: unknown, acked: unknown): { ok: boolean; seen: unknown; send: string[] };
  nearEnd(box: unknown, slack?: unknown): boolean;
  canMarkRead(o?: unknown): boolean;
  newBelow(o?: unknown): boolean;
  counts(data: unknown): { turns: number; running: number };
  stoppedTurns(data: unknown): number;
  topicsBusy(data: unknown): boolean;
  pins(data: unknown): string[];
  pinMax(data: unknown): number;
  hand(data: unknown): Obj | null;
  handChannel(data: unknown): string | null;
  handPinnable(data: unknown): boolean;
  handPinned(data: unknown): boolean;
  atMs(at: unknown): number | null;
  byNewest(a: { at: unknown }, b: { at: unknown }): number;
  dueRank(task: Obj, today: unknown): number;
  githubKind(url: unknown): string;
  rowMark(topic: Obj, isUnread: (channelId: string, last: unknown) => boolean): string;
  turnEntries(view: Obj): { items: Entry[]; held: number };
  runningEntries(view: Obj): Entry[];
  idleEntries(view: Obj): Entry[];
  unreadTopics(view: Obj): Entry[];
  turnTab(view: Obj): { ready: boolean; count: number; turns: Entry[]; replies: Entry[] };
  tasksTab(view: Obj): { ready: boolean; count: number; overdue: Entry[]; today: Entry[]; later: Entry[]; done: Entry[]; reminders: Entry[] };
  noticesTab(view: Obj): { ready: boolean; items: Entry[]; unseen: number };
  tabBadges(view: Obj): { talk: { dot: boolean }; topics: { dot: boolean }; turn: { count: number }; tasks: { count: number }; notices: { count: number } };
  pinStrip(view: Obj, openId: unknown): Strip[];
};
// 素の JS で型が無いので、URL を変数にして型の解決を避ける（test/web-render-text.test.ts と同じ）
const calcUrl = new URL("../src/web/static/n-calc.js", import.meta.url).href;
const calc = (await import(calcUrl)) as Calc;
const json = (value: unknown): unknown => JSON.parse(JSON.stringify(value));
const keys = (list: { key: string }[]): string[] => list.map((x) => x.key);

// ===== 見本 =====
const at = (h: number): string => `2026-11-28T${String(h).padStart(2, "0")}:00:00.000Z`;
const agent = (id: number): Obj => ({ id, kind: "agent" });
const owner = (id: number): Obj => ({ id, kind: "owner" });
const turnOf = (kind: string, h: number): Obj => ({ kind, since: at(h), summary: "要約" });
function topic(id: string, o: Obj = {}): Obj {
  return { id, title: "題 " + id, group: "g1", mark: null, state: "open", turn: null, last: null, activityAt: at(8), ...o };
}
/** GET /api/topics の応答の形（足りない鍵は空） */
function data(o: Obj = {}): Obj {
  return { turns: 0, turnIds: [], groups: [{ key: "g1", name: "場所" }], topics: [], rightHands: [], pins: [], pinMax: 4, handPins: [], reads: {}, ...o };
}
function view(o: Obj = {}): Obj {
  return { topics: null, seen: {}, tasks: null, doneTasks: null, reminders: null, github: null, notices: null, today: null, replies: "turn", noticesSeenAt: null, ...o };
}

/** 色々の入った話題の一覧（番 4・止まった番 1・動いている 3・未読・待機・留めた話題・完了・cc: の話題・入口の話題・右腕の番） */
function sampleTopics(o: Obj = {}): Obj {
  return data({
    turns: 4,
    turnIds: ["ch:1", "ch:100", "ch:2", "ch:11", "ch:404", "ch:1"],
    topics: [
      topic("ch:1", { mark: "turn", turn: turnOf("permission", 10), last: agent(3) }),
      topic("ch:2", { mark: "turn", turn: turnOf("question", 9) }),
      topic("ch:3", { mark: "running", activityAt: at(9) }),
      topic("ch:4", { mark: "running", activityAt: at(11) }),
      topic("ch:5", { last: owner(4), activityAt: at(6) }),
      topic("ch:6", { last: agent(10), activityAt: at(12) }),
      topic("ch:7", { last: agent(8), activityAt: at(5) }),
      topic("ch:8", { state: "done", last: agent(9) }),
      topic("cc:9", { origin: "cc", last: agent(2) }),
      topic("ch:10", { last: { id: 5, kind: "notice", lead: true }, activityAt: at(7) }),
      topic("ch:11", { mark: "turn", turn: turnOf("failed", 8) }),
      topic("ch:12", { activityAt: at(4) }),
      topic("ch:13", { pinned: true }),
      topic("ch:14", { mark: "running", activityAt: at(3) }),
      topic("ch:15", { activityAt: null }),
    ],
    rightHands: [{ id: "ch:100", turn: turnOf("question", 7), last: agent(20) }],
    pins: ["7", "14"],
    handPins: ["100"],
    ...o,
  });
}
const TASKS: Obj[] = [
  { id: 1, title: "a", due: "2026-11-29" },
  { id: 2, title: "b", due: "2026-11-27" },
  { id: 3, title: "c", due: null },
  { id: 4, title: "d", due: "2026-11-28" },
  { id: 5, title: "e", due: "" },
  { id: 6, title: "f", due: "2026-11-20" },
  { id: 7, title: "g", due: "2026-11-29" },
];
const REMINDERS: Obj[] = [
  { id: 1, text: "a", nextAt: at(12), rule: "" },
  { id: 2, text: "b", nextAt: null, rule: "" },
  { id: 3, text: "c", nextAt: at(9), rule: "daily" },
];
const GITHUB: Obj[] = [
  { id: "g1", url: "https://github.com/o/r/pull/1", updatedAt: at(12), title: "t1", handoff: false },
  { id: "g2", url: "https://github.com/o/r/issues/2", updatedAt: at(6), title: "t2", handoff: false },
  { id: "g3", url: "https://github.com/o/r", updatedAt: null, title: "t3", handoff: false },
];
const NOTICES: Obj[] = [{ at: at(12), text: "n1" }, { at: at(10), text: "n2" }, { text: "n3" }, { at: at(7), text: "n4" }];

/** 古い方と突き合わせる見本の view */
const VIEWS: Array<[string, Obj]> = [
  ["まだ読めていない", view()],
  ["色々", view({ topics: sampleTopics(), seen: { "10": 3 }, tasks: TASKS, reminders: REMINDERS, github: GITHUB, notices: NOTICES, today: "2026-11-28" })],
  ["右腕に番が無く未読", view({ topics: sampleTopics({ rightHands: [{ id: "ch:100", turn: null, last: agent(20) }], turnIds: ["ch:2", "ch:1"] }), notices: [], tasks: [] })],
  ["全部見た", view({ topics: sampleTopics(), seen: { "6": 10, "7": 8, "10": 5, "100": 20 }, notices: NOTICES, github: null, reminders: [] })],
  ["右腕が無い", view({ topics: sampleTopics({ rightHands: [] }), notices: NOTICES, github: GITHUB, today: null, tasks: TASKS })],
];

// ===== 読み込み・字の見張り・配信 =====
test("n-calc: 画面の物・時計・タイマー・保存・通信の字が無い（コメントも見る）", () => {
  const text = read("n-calc.js");
  for (const re of [
    /\bdocument\b/,
    /\bwindow\b/,
    /\bSA\b/,
    /Date\.now/,
    /new Date\(\s*\)/,
    /\bsetTimeout\b/,
    /\bsetInterval\b/,
    /\bclearTimeout\b/,
    /\blocalStorage\b/,
    /\bnavigator\b/,
    /\blocation\b/,
    /\bfetch\b/,
    /Math\.random/,
  ]) {
    assert.doesNotMatch(text, re);
  }
});

test("n-calc: import が無く、export は名前付きだけで、頭の階層で関数を呼ばない", () => {
  const text = read("n-calc.js");
  assert.deepEqual([...text.matchAll(/from "([^"]+)"/g)].map((m) => m[1]), []);
  assert.doesNotMatch(text, /^\s*import\b/m);
  assert.doesNotMatch(text, /\bimport\(/);
  assert.doesNotMatch(text, /export default/);
  // 頭の階層の行は コメント・export・const・function・閉じ括弧 だけ（読み込んだだけで何も起きない）
  for (const line of text.split("\n")) {
    if (line === "" || line.startsWith(" ")) continue;
    assert.match(line, /^(\/\/|\/\*\*|export (const|function) |const |function |\}|\);)/, line);
  }
});

test("n-calc: staticFileFor が JS の MIME で返す", () => {
  const dirs = { staticDir: "/s", templateSiteDir: "/t" };
  assert.deepEqual(staticFileFor("/static/n-calc.js", dirs), { file: "/s/n-calc.js", contentType: "text/javascript; charset=utf-8" });
});

// ===== 会話の行（§2.1 の 1〜4・6・7） =====
test("n-calc: turnsPath・mergeTurns・realTurns・backoff の決めた答え", () => {
  assert.equal(calc.turnsPath("12 3", "limit=50"), "/api/channels/12%203/turns?limit=50");
  const a = { id: 3, text: "a" };
  const b = { id: 1, text: "b" };
  const c = { id: 3, text: "c" };
  assert.deepEqual(calc.mergeTurns([a, b], [c, { id: 2 }]), [b, { id: 2 }, c]);
  assert.deepEqual(calc.realTurns({ turns: [{ id: 1 }, { id: 2, optimistic: true }, { id: 3, optimistic: false }] }), [{ id: 1 }, { id: 3, optimistic: false }]);
  assert.equal(calc.BACKOFF_MAX_MS, 60000);
  assert.deepEqual([0, 1, 2, 3, 10].map((n) => calc.backoff(5000, n)), [5000, 10000, 20000, 40000, 60000]);
  assert.equal(calc.backoff(70000, 2), 70000);
  assert.equal(calc.backoff(5000, 3, 30000), 30000);
});

test("n-calc: 古い api.js の turnsPath・mergeTurns・realTurns・backoff と同じ", () => {
  const api = read("api.js");
  const max = /const POLL_BACKOFF_MAX_MS = (\d+);/.exec(api)?.[1];
  assert.ok(max);
  const ctx: { result?: Record<string, (...args: never[]) => unknown> } = {};
  vm.runInNewContext(
    `const POLL_BACKOFF_MAX_MS = ${max};` +
      ["mergeTurns", "realTurns", "backoff", "turnsPath"].map((n) => fnSource(api, n)).join("") +
      "\nresult = { mergeTurns, realTurns, backoff, turnsPath };",
    ctx,
  );
  const old = ctx.result as unknown as Pick<Calc, "mergeTurns" | "realTurns" | "backoff" | "turnsPath">;
  for (const [id, q] of [
    ["123", "limit=50"],
    ["a/b?c", "before=3&limit=50"],
    ["", ""],
  ] as const) {
    assert.equal(calc.turnsPath(id, q), old.turnsPath(id, q));
  }
  const rows = [
    [[{ id: 3 }, { id: 1 }], [{ id: 2 }, { id: 3, x: 1 }]],
    [[], [{ id: 5, optimistic: true }]],
    [[{ id: 1, optimistic: true }], []],
  ] as const;
  for (const [cur, inc] of rows) {
    assert.deepEqual(calc.mergeTurns([...cur], [...inc]), json(old.mergeTurns([...cur], [...inc])));
    const t = { turns: [...cur, ...inc] };
    assert.deepEqual(calc.realTurns(t), json(old.realTurns(t)));
  }
  for (const base of [2000, 5000, 10000, 70000]) {
    for (const fails of [0, 1, 2, 3, 4, 5, 10]) assert.equal(calc.backoff(base, fails), old.backoff(base, fails), `${base} ${fails}`);
  }
});

test("n-calc: §2.1 の 6 emptyTurns は初めの形を毎回新しく返す", () => {
  const a = calc.emptyTurns();
  assert.deepEqual(a, { channel: null, turns: [], hasMore: false, loaded: false, missing: false });
  const b = calc.emptyTurns();
  assert.notEqual(a, b);
  assert.notEqual(a.turns, b.turns);
});

test("n-calc: §2.1 の 7 optimisticTurn は仮の owner の行", () => {
  assert.deepEqual(calc.optimisticTurn(7, "やあ", "2026-11-28T00:00:00.000Z"), {
    id: 7,
    at: "2026-11-28T00:00:00.000Z",
    kind: "owner",
    source: "web",
    text: "やあ",
    outcome: null,
    steps: null,
    toolCalls: null,
    durationMs: null,
    messageId: null,
    link: null,
    optimistic: true,
  });
});

// ===== 既読（§2.1 の 5・8・9） =====
test("n-calc: §2.1 の 5 isUnread の決めた答え", () => {
  assert.equal(calc.isUnread("1", agent(5), { "1": 4 }), true);
  assert.equal(calc.isUnread("1", agent(5), { "1": 5 }), false);
  assert.equal(calc.isUnread("1", owner(5), {}), false);
  assert.equal(calc.isUnread("1", { id: 5, kind: "notice", lead: true }, {}), true);
  assert.equal(calc.isUnread("1", null, {}), false);
  assert.equal(calc.isUnread("1", agent(5), null), true);
  assert.equal(calc.isUnread("1", agent(5), undefined), true);
  assert.equal(calc.isUnread("1", agent(5), { "1": "9" }), false);
});

test("n-calc: 古い api.js の store.isUnread と同じ", () => {
  const api = read("api.js");
  const src = /store\.isUnread = (\(channel\) => [^\n]*);/.exec(api)?.[1];
  assert.ok(src);
  const seen = { "1": 4, "2": "6", "3": 0 };
  const ctx: { result?: (channel: unknown) => boolean } = {};
  vm.runInNewContext(`const store = { seen: ${JSON.stringify(seen)} }; store.isUnread = ${src}; result = store.isUnread;`, ctx);
  const old = ctx.result!;
  for (const id of ["1", "2", "3", "4"]) {
    for (const last of [null, agent(3), agent(5), agent(7), owner(9), { id: 9, kind: "notice", lead: true }, { id: 9, kind: "notice", lead: "yes" }]) {
      assert.equal(calc.isUnread(id, last, seen), old({ id, last }), `${id} ${JSON.stringify(last)}`);
    }
  }
});

test("n-calc: §2.1 の 8 seenUpTo は進む時だけ新しい object、進まない時は同じ参照", () => {
  const seen = { "1": 5 };
  const next = calc.seenUpTo(seen, "1", 6);
  assert.deepEqual(next, { "1": 6 });
  assert.deepEqual(seen, { "1": 5 });
  assert.deepEqual(calc.seenUpTo(seen, "2", 1), { "1": 5, "2": 1 });
  assert.equal(calc.seenUpTo(seen, "1", 5), seen);
  assert.equal(calc.seenUpTo(seen, "1", 4), seen);
  assert.equal(calc.seenUpTo(seen, "1", "9"), seen);
  assert.equal(calc.seenUpTo(seen, "1", Number.NaN), seen);
  assert.deepEqual(calc.seenUpTo(null, "1", 3), { "1": 3 });
});

test("n-calc: §2.1 の 9 mergeReads の場合の表", () => {
  const seen = { "1": 5, "2": 3 };
  // 1. reads が object でない
  for (const reads of [null, [], "x", 3, undefined]) {
    const r = calc.mergeReads(seen, reads, ["1"], {});
    assert.deepEqual(r, { ok: false, seen, send: [] });
    assert.equal(r.seen, seen);
  }
  // 2. 手元より大きい数を取り込む（下げない。数でない・有限でない値は捨てる）
  const r2 = calc.mergeReads(seen, { "1": 4, "2": 8, "3": 2, "4": "9", "5": Number.POSITIVE_INFINITY, "6": Number.NaN }, [], {});
  assert.deepEqual(r2, { ok: true, seen: { "1": 5, "2": 8, "3": 2 }, send: [] });
  assert.deepEqual(seen, { "1": 5, "2": 3 });
  // 3. 手元 > サーバー かつ 手元 > acked の会話を ids の順で送る
  const r3 = calc.mergeReads({ "1": 5, "2": 3, "3": 7, "4": 2 }, { "2": 1, "4": 2 }, ["3", "4", "2", "1", "9"], { "1": 5 });
  assert.deepEqual(r3.send, ["3", "2"]);
  assert.equal(r3.ok, false);
  // 4. どれにも当たらない
  const r4 = calc.mergeReads(seen, { "1": 5, "2": 3 }, ["1", "2"], {});
  assert.deepEqual(r4, { ok: true, seen, send: [] });
  assert.equal(r4.seen, seen);
  // seen が null でも落ちない
  assert.deepEqual(calc.mergeReads(null, { "1": 2 }, ["1"], null), { ok: true, seen: { "1": 2 }, send: [] });
});

// ===== 既読の判定（§2.4） =====
test("n-calc: §2.4 canMarkRead の場合の表（0〜7）", () => {
  const base = { visible: true, main: "talk", surface: "talk", covered: false, nearEnd: true };
  const cases: Array<[string, unknown, boolean]> = [
    ["0 会話が表・重なり無し・最後の行の近く", base, true],
    ["1 話題のタブ", { ...base, main: "topics" }, false],
    ["1 あなたの番のタブ", { ...base, main: "turn" }, false],
    ["1 タスクのタブ", { ...base, main: "tasks" }, false],
    ["1 通知のタブ", { ...base, main: "notices" }, false],
    ["2 押して入る画面が重なっている", { ...base, covered: true }, false],
    ["3 上を読み返している", { ...base, nearEnd: false }, false],
    ["4 PC の右の柱の札", { ...base, surface: "card" }, false],
    ["5 PC の真ん中がタスク", { ...base, main: "tasks" }, false],
    ["5 PC の真ん中が通知", { ...base, main: "notices" }, false],
    ["6 画面が隠れている", { ...base, visible: false }, false],
    ["7 引数が無い", undefined, false],
    ["7 null", null, false],
    ["7 鍵が欠けている（covered）", { visible: true, main: "talk", surface: "talk", nearEnd: true }, false],
    ["7 鍵が欠けている（nearEnd）", { visible: true, main: "talk", surface: "talk", covered: false }, false],
    ["7 ほかの型", { ...base, visible: 1, covered: 0, nearEnd: "true" }, false],
  ];
  for (const [name, input, want] of cases) assert.equal(calc.canMarkRead(input), want, name);
  assert.equal(calc.canMarkRead(), false);
  assert.deepEqual([...calc.MAIN], ["talk", "topics", "turn", "tasks", "notices"]);
  assert.ok(Object.isFrozen(calc.MAIN));
});

test("n-calc: §2.4 nearEnd・lastRowId・newBelow", () => {
  assert.equal(calc.NEAR_END_PX, 48);
  assert.equal(calc.nearEnd({ scrollTop: 452, clientHeight: 500, scrollHeight: 1000 }), true);
  assert.equal(calc.nearEnd({ scrollTop: 451, clientHeight: 500, scrollHeight: 1000 }), false);
  assert.equal(calc.nearEnd({ scrollTop: 0, clientHeight: 500, scrollHeight: 200 }), true);
  assert.equal(calc.nearEnd({ scrollTop: 400, clientHeight: 500, scrollHeight: 1000 }, 100), true);
  assert.equal(calc.nearEnd({ scrollTop: "452", clientHeight: 500, scrollHeight: 1000 }), false);
  assert.equal(calc.nearEnd({ scrollTop: Number.NaN, clientHeight: 500, scrollHeight: 1000 }), false);
  assert.equal(calc.nearEnd({ scrollTop: 0, clientHeight: 500, scrollHeight: Number.POSITIVE_INFINITY }), false);
  assert.equal(calc.nearEnd({ scrollTop: 452, clientHeight: 500, scrollHeight: 1000 }, Number.NaN), false);
  assert.equal(calc.nearEnd(null), false);

  assert.equal(calc.lastRowId([]), null);
  assert.equal(calc.lastRowId(null), null);
  assert.equal(calc.lastRowId([{ id: 1 }, { id: 2 }]), 2);
  assert.equal(calc.lastRowId([{ id: 1 }, { id: 9, optimistic: true }]), 9);
  assert.equal(calc.lastRowId([{ id: 1 }, { id: "2" }]), null);

  const turns = [owner(1), agent(2)];
  assert.equal(calc.newBelow({ nearEnd: true, turns, seenId: 1 }), false, "下に居る");
  assert.equal(calc.newBelow({ nearEnd: false, turns, seenId: 1 }), true, "上に居て返事が来た");
  assert.equal(calc.newBelow({ nearEnd: false, turns: [agent(1), owner(2)], seenId: 0 }), false, "上に居て自分の行だけ");
  assert.equal(calc.newBelow({ nearEnd: false, turns: [agent(2), { ...owner(3), optimistic: true }], seenId: 1 }), true, "仮の行は数えない");
  assert.equal(calc.newBelow({ nearEnd: false, turns, seenId: 2 }), false, "既に見た");
  assert.equal(calc.newBelow({ nearEnd: false, turns: [], seenId: 0 }), false, "行が無い");
  assert.equal(calc.newBelow({ nearEnd: false, turns, seenId: null }), true, "見た印が無い");
  assert.equal(calc.newBelow(), false);
});

// ===== 数え方・ピン・右腕（§2.1 の 10〜13） =====
test("n-calc: counts・stoppedTurns・§2.1 の 12 topicsBusy の決めた答え", () => {
  assert.deepEqual(calc.counts(null), { turns: 0, running: 0 });
  assert.equal(calc.stoppedTurns(null), 0);
  assert.equal(calc.topicsBusy(null), false);
  const d = sampleTopics();
  assert.deepEqual(calc.counts(d), { turns: 4, running: 3 });
  assert.equal(calc.stoppedTurns(d), 1);
  const stoppedOnly = data({ turns: 2, topics: [topic("ch:1", { mark: "turn", turn: turnOf("failed", 1) }), topic("ch:2", { mark: "turn", turn: turnOf("max_turns", 1) })] });
  assert.equal(calc.topicsBusy(stoppedOnly), false);
  assert.equal(calc.topicsBusy({ ...stoppedOnly, turns: 3 }), true);
  assert.equal(calc.topicsBusy(data({ topics: [topic("ch:1", { mark: "running" })] })), true);
  assert.equal(calc.topicsBusy(data()), false);
});

test("n-calc: pins・pinMax・hand・handChannel・handPinnable・handPinned の決めた答え", () => {
  assert.deepEqual(calc.pins(null), []);
  assert.deepEqual(calc.pins(data({ pins: ["7", 8, "9"] })), ["7", "9"]);
  assert.equal(calc.pinMax(null), 0);
  assert.equal(calc.pinMax(data({ pinMax: 4 })), 4);
  assert.equal(calc.pinMax(data({ pinMax: 0 })), 0);
  assert.equal(calc.pinMax(data({ pinMax: 2.5 })), 0);
  const h = { id: "ch:5" };
  assert.equal(calc.hand(data({ rightHands: [h] })), h);
  assert.equal(calc.hand(data({ rightHands: [] })), null);
  assert.equal(calc.handChannel(data({ rightHands: [h] })), "5");
  assert.equal(calc.handChannel(data({ rightHands: [{ id: "cc:5" }] })), null);
  assert.equal(calc.handPinnable(data({ handPins: [] })), true);
  assert.equal(calc.handPinnable(data({ handPins: undefined })), false);
  assert.equal(calc.handPinned(data({ rightHands: [h], handPins: ["5"] })), true);
  assert.equal(calc.handPinned(data({ rightHands: [h], handPins: ["6"] })), false);
});

test("n-calc: 古い topics.js の counts・stoppedTurns・pins・pinMax・hand・handChannel・handPinnable・handPinned と同じ", () => {
  const topics = read("topics.js");
  const names = ["counts", "stoppedTurns", "pins", "pinMax", "hand", "handChannel", "handPinnable", "handPinned"] as const;
  const ctx: { result?: Record<string, () => unknown> & { set: (d: unknown) => void } } = {};
  vm.runInNewContext("let data = null;" + names.map((n) => fnSource(topics, n)).join("") + `\nresult = { ${names.join(", ")}, set: (d) => { data = d; } };`, ctx);
  const old = ctx.result!;
  const samples: unknown[] = [
    null,
    sampleTopics(),
    sampleTopics({ rightHands: [], pins: "x", pinMax: "4", handPins: null }),
    sampleTopics({ rightHands: [{ id: "cc:1" }], handPins: ["1"] }),
    sampleTopics({ pins: ["7", 8, "9"], pinMax: 0 }),
    data({ rightHands: [null] }),
  ];
  for (const d of samples) {
    old.set(d);
    for (const n of names) assert.deepEqual((calc[n] as (x: unknown) => unknown)(d), json(old[n]!()), n);
  }
});

// ===== 並べ方・行の印（§2.1 の 14・19） =====
test("n-calc: atMs・byNewest・dueRank・githubKind・rowMark の決めた答え", () => {
  assert.equal(calc.atMs(at(1)), Date.parse(at(1)));
  assert.equal(calc.atMs("x"), null);
  assert.equal(calc.atMs(null), null);
  assert.equal(calc.atMs(5), null);
  const list = [{ at: at(1) }, { at: null }, { at: at(3) }, { at: "x" }, { at: at(2) }];
  assert.deepEqual([...list].sort(calc.byNewest), [list[2], list[4], list[0], list[1], list[3]]);
  assert.equal(calc.dueRank({ due: "2026-11-27" }, "2026-11-28"), 0);
  assert.equal(calc.dueRank({ due: "2026-11-28" }, "2026-11-28"), 1);
  assert.equal(calc.dueRank({ due: "2026-11-29" }, "2026-11-28"), 2);
  assert.equal(calc.dueRank({ due: "2026-11-27" }, null), 2);
  assert.equal(calc.dueRank({ due: "" }, "2026-11-28"), 3);
  assert.equal(calc.dueRank({ due: null }, "2026-11-28"), 3);
  assert.equal(calc.githubKind("https://github.com/o/r/pull/1"), "pr");
  assert.equal(calc.githubKind("https://github.com/o/r/issues/1"), "issue");
  assert.equal(calc.githubKind("https://github.com/o/r"), "github");
  assert.equal(calc.githubKind(null), "github");
  const yes = (): boolean => true;
  const no = (): boolean => false;
  assert.equal(calc.rowMark(topic("ch:1", { mark: "turn" }), yes), "turn");
  assert.equal(calc.rowMark(topic("ch:1", { mark: "running" }), yes), "running");
  assert.equal(calc.rowMark(topic("ch:1"), yes), "unread");
  assert.equal(calc.rowMark(topic("ch:1"), no), "none");
  assert.equal(calc.rowMark(topic("cc:1"), yes), "none");
});

test("n-calc: 古い c-list.js の rowMark と同じ", async () => {
  const listUrl = new URL("../src/web/static/c-list.js", import.meta.url).href;
  const list = (await import(listUrl)) as { rowMark: Calc["rowMark"] };
  const seen = { "6": 10 };
  const isUnread = (channelId: string, last: unknown): boolean => calc.isUnread(channelId, last, seen);
  for (const t of (sampleTopics().topics as Obj[]).concat([topic("ch:20", { mark: "other" }), topic(5 as unknown as string)])) {
    assert.equal(calc.rowMark(t, isUnread), list.rowMark(t, isUnread), String(t.id));
  }
});

// ===== 3 つのタブの分け方（§2.1 の 15〜18・§2.5） =====
type Deck = {
  turnItems(state: Obj): { key: string }[];
  runningItems(state: Obj): { key: string }[];
  idleItems(state: Obj): { key: string }[];
  taskItems(state: Obj): { key: string }[];
  reminderItems(state: Obj): { key: string }[];
  feedItems(state: Obj): { key: string }[];
  deckModel(state: Obj): { columns: { count: number }[] };
};
const deckUrl = new URL("../src/web/static/c-deck.js", import.meta.url).href;
const deck = (await import(deckUrl)) as Deck;
/** c-deck.js が呼ぶ関数の代わり（語・時刻の字は空。未読は view の手元の既読で） */
function deckState(v: Obj): Obj {
  return { ...v, ago: () => "", time: () => "", day: () => "", oneLine: (s: string) => s, parts: () => null, isUnread: (channelId: string, last: unknown) => calc.isUnread(channelId, last, v.seen) };
}

test("n-calc: 古い c-deck.js の turnItems・runningItems・idleItems・deckModel の数と同じ", () => {
  for (const [name, v] of VIEWS) {
    const state = deckState(v);
    assert.deepEqual(keys(calc.turnEntries(v).items), keys(deck.turnItems(state)), name);
    assert.deepEqual(keys(calc.turnEntries({ ...v, handRow: true }).items), keys(deck.turnItems({ ...state, handRow: true })), name + " handRow");
    assert.deepEqual(keys(calc.turnTab(v).turns), keys(deck.turnItems(state)), name);
    assert.equal(calc.turnTab(v).count, deck.deckModel({ ...state, handRow: true }).columns[0]!.count, name);
    assert.equal(calc.turnTab({ ...v, handRow: true }).count, deck.deckModel({ ...state, handRow: true }).columns[0]!.count, name);
    assert.deepEqual(keys(calc.runningEntries(v)), keys(deck.runningItems(state)), name);
    assert.deepEqual(keys(calc.idleEntries(v)), keys(v.topics ? deck.idleItems(state) : []), name);
  }
  // 突き合わせが空の並び同士にならない（見本の「色々」は どの分け方にも項目が在る）
  const full = VIEWS[1]![1];
  assert.deepEqual(keys(calc.turnEntries(full).items), ["turn:ch:1", "turn:ch:100", "turn:ch:2", "turn:ch:11"]);
  assert.equal(calc.turnTab({ ...full, handRow: true }).turns.length, 3);
  assert.equal(calc.runningEntries(full).length, 2);
  assert.equal(calc.idleEntries(full).length, 3);
});

test("n-calc: 古い c-deck.js の taskItems・reminderItems・feedItems と同じ", () => {
  for (const [name, v] of VIEWS) {
    const state = deckState(v);
    const t = calc.tasksTab(v);
    assert.deepEqual(keys([...t.overdue, ...t.today, ...t.later]), keys(deck.taskItems(state)), name);
    assert.deepEqual(keys(t.reminders), keys(deck.reminderItems(state)), name);
    const n = calc.noticesTab({ ...v, replies: "notices" });
    assert.deepEqual(keys(n.items), keys(v.notices == null ? [] : deck.feedItems(state)), name);
  }
  const full = VIEWS[1]![1];
  assert.equal(calc.tasksTab(full).overdue.length + calc.tasksTab(full).today.length + calc.tasksTab(full).later.length, TASKS.length);
  assert.equal(calc.tasksTab(full).reminders.length, REMINDERS.length);
  assert.ok(calc.noticesTab({ ...full, replies: "notices" }).items.some((e) => e.kind === "reply"));
  // 50 件で切る所も同じ
  const many = view({ topics: data(), notices: Array.from({ length: 60 }, (_, i) => ({ at: at(i % 24), text: "n" + i })) });
  assert.deepEqual(keys(calc.noticesTab({ ...many, replies: "notices" }).items), keys(deck.feedItems(deckState(many))));
});

test("n-calc: 項目の形（key・kind・id・at・src は渡された物そのもの）", () => {
  const d = sampleTopics();
  const v = view({ topics: d, seen: { "10": 3 } });
  const t1 = (d.topics as Obj[])[0]!;
  const first = calc.turnEntries(v).items[0]!;
  assert.deepEqual(Object.keys(first).sort(), ["at", "id", "key", "kind", "src"]);
  assert.equal(first.src, t1);
  assert.deepEqual({ ...first, src: null }, { key: "turn:ch:1", kind: "permission", id: "ch:1", at: at(10), src: null });
  const run = calc.runningEntries(v);
  assert.deepEqual(
    run.map((e) => [e.key, e.kind, e.id, e.at]),
    [
      ["run:ch:4", "running", "ch:4", at(11)],
      ["run:ch:3", "running", "ch:3", at(9)],
    ],
  );
  const idle = calc.idleEntries(v);
  assert.deepEqual(keys(idle), ["idle:ch:5", "idle:ch:12", "idle:ch:15"]);
  assert.ok(idle.every((e) => e.kind === "idle"));
  assert.equal(idle[2]!.at, null);
  // 種類が文字列でない番は ""
  const odd = data({ turnIds: ["ch:1"], topics: [topic("ch:1", { mark: "turn", turn: { kind: 3, since: at(1) } })] });
  assert.equal(calc.turnEntries(view({ topics: odd })).items[0]!.kind, "");
});

test("n-calc: §2.5 turnTab の場合の表（1〜11）", () => {
  // 1
  assert.deepEqual(calc.turnTab(view()), { ready: false, count: 0, turns: [], replies: [] });
  // 2
  const kinds = ["permission", "question", "waiting", "confirm", "max_turns", "failed"];
  const six = kinds.map((k, i) => topic("ch:" + (i + 1), { mark: "turn", turn: turnOf(k, i + 1) }));
  const ids = ["ch:3", "ch:1", "ch:6", "ch:2", "ch:5", "ch:4"];
  const r2 = calc.turnTab(view({ topics: data({ turnIds: ids, topics: six }) }));
  assert.equal(r2.ready, true);
  assert.deepEqual(keys(r2.turns), ids.map((id) => "turn:" + id));
  assert.deepEqual(r2.turns.map((e) => e.kind), ["waiting", "permission", "failed", "question", "max_turns", "confirm"]);
  assert.equal(r2.count, 6, "2");
  // 3 動いている・番の無い話題は入らない
  const r3 = calc.turnTab(view({ topics: data({ turnIds: ids, topics: [...six, topic("ch:7", { mark: "running" }), topic("ch:8")] }) }));
  assert.deepEqual(keys(r3.turns), keys(r2.turns));
  assert.equal(r3.count, 6, "3");
  // 4 右腕の番は hand: true の項目で数える
  const handTurn = { id: "ch:100", turn: turnOf("question", 9), last: agent(3) };
  const d4 = data({ turnIds: ["ch:1", "ch:100"], topics: [six[0]], rightHands: [handTurn] });
  const r4 = calc.turnTab(view({ topics: d4 }));
  assert.deepEqual(keys(r4.turns), ["turn:ch:1", "turn:ch:100"]);
  assert.equal(r4.turns[1]!.hand, true);
  assert.equal(r4.turns[1]!.src, handTurn);
  assert.equal(r4.turns[0]!.hand, undefined);
  assert.equal(r4.count, 2, "4");
  // 5 handRow: true は項目にせず数える
  const r5 = calc.turnTab(view({ topics: d4, handRow: true }));
  assert.deepEqual(keys(r5.turns), ["turn:ch:1"]);
  assert.equal(r5.count, 2, "5");
  assert.equal(calc.turnEntries(view({ topics: d4, handRow: true })).held, 1);
  // 6 右腕に番が無い
  const r6 = calc.turnTab(view({ topics: data({ turnIds: ["ch:1", "ch:100"], topics: [six[0]], rightHands: [{ id: "ch:100", turn: null, last: agent(3) }] }) }));
  assert.deepEqual(keys(r6.turns), ["turn:ch:1"]);
  assert.equal(r6.count, 1, "6");
  // 7 引けない id は捨て、重なりは 1 つ
  const r7 = calc.turnTab(view({ topics: data({ turnIds: ["ch:1", "ch:404", "ch:1", "ch:2", "ch:2"], topics: six }) }));
  assert.deepEqual(keys(r7.turns), ["turn:ch:1", "turn:ch:2"]);
  assert.equal(r7.count, 2, "7");
  // 8 未読の話題が 2 つ（既定）
  const unread = [topic("ch:20", { last: agent(4), activityAt: at(3) }), topic("ch:21", { last: agent(2), activityAt: at(5) })];
  const d8 = data({ turnIds: ["ch:1"], topics: [six[0], ...unread] });
  const r8 = calc.turnTab(view({ topics: d8 }));
  assert.deepEqual(keys(r8.replies), ["topic:ch:21", "topic:ch:20"]);
  assert.ok(r8.replies.every((e) => e.kind === "reply"));
  assert.equal(r8.count, 1, "8");
  assert.deepEqual(keys(calc.turnTab(view({ topics: d8, replies: "other" })).replies), ["topic:ch:21", "topic:ch:20"], "8 ほかの値は turn");
  // 9
  assert.deepEqual(calc.turnTab(view({ topics: d8, replies: "notices" })).replies, [], "9 notices");
  assert.deepEqual(calc.turnTab(view({ topics: d8, replies: "dot" })).replies, [], "9 dot");
  // 10 番・動いている・完了・cc:・右腕は入らない
  const d10 = data({
    turnIds: ["ch:1"],
    topics: [
      topic("ch:1", { mark: "turn", turn: turnOf("question", 1), last: agent(5) }),
      topic("ch:2", { mark: "running", last: agent(5) }),
      topic("ch:3", { state: "done", last: agent(5) }),
      topic("cc:4", { last: agent(5) }),
    ],
    rightHands: [{ id: "ch:100", turn: null, last: agent(5) }],
  });
  assert.deepEqual(calc.turnTab(view({ topics: d10 })).replies, [], "10");
  // 11 最後の行まで見た
  assert.deepEqual(keys(calc.turnTab(view({ topics: d8, seen: { "20": 4 } })).replies), ["topic:ch:21"], "11");
});

test("n-calc: §2.5 tasksTab の場合の表（1〜7）", () => {
  const T = "2026-11-28";
  // 1
  assert.deepEqual(calc.tasksTab(view({ today: T })), { ready: false, count: 0, overdue: [], today: [], later: [], done: [], reminders: [] });
  assert.equal(calc.tasksTab(view({ tasks: [], reminders: null })).ready, true);
  assert.equal(calc.tasksTab(view({ tasks: null, reminders: [] })).ready, true);
  // 2
  const t2 = [
    { id: 1, due: "2026-11-27" },
    { id: 2, due: "2026-11-28" },
    { id: 3, due: "2026-11-29" },
    { id: 4, due: null },
    { id: 5, due: "" },
  ];
  const r2 = calc.tasksTab(view({ tasks: t2, today: T }));
  assert.deepEqual([keys(r2.overdue), keys(r2.today), keys(r2.later)], [["task:1"], ["task:2"], ["task:3", "task:4", "task:5"]]);
  assert.equal(r2.count, 2, "2");
  assert.deepEqual({ ...r2.overdue[0]!, src: null }, { key: "task:1", kind: "task", id: null, at: "2026-11-27", src: null });
  assert.equal(r2.overdue[0]!.src, t2[0]);
  assert.equal(r2.later[1]!.at, null);
  // 3 節の中は期限の昇順・同じ期限は渡された順・期限なしは最後
  const t3 = [
    { id: 1, due: null },
    { id: 2, due: "2026-11-27" },
    { id: 3, due: "2026-12-05" },
    { id: 4, due: "2026-11-20" },
    { id: 5, due: "" },
    { id: 6, due: "2026-11-30" },
    { id: 7, due: "2026-11-27" },
  ];
  const r3 = calc.tasksTab(view({ tasks: t3, today: T }));
  assert.deepEqual(keys(r3.overdue), ["task:4", "task:2", "task:7"], "3");
  assert.deepEqual(keys(r3.later), ["task:6", "task:3", "task:1", "task:5"], "3");
  // 4 today が null
  const r4 = calc.tasksTab(view({ tasks: t2, today: null }));
  assert.deepEqual([keys(r4.overdue), keys(r4.today), keys(r4.later)], [[], [], ["task:1", "task:2", "task:3", "task:4", "task:5"]]);
  assert.equal(r4.count, 0, "4");
  // 5 完了は渡された順・数えない
  const r5 = calc.tasksTab(view({ tasks: [], doneTasks: [{ id: 9, due: "2026-11-01" }, { id: 8, due: null }], today: T }));
  assert.deepEqual(keys(r5.done), ["task:9", "task:8"]);
  assert.equal(r5.count, 0, "5");
  // 6 リマインド: 先 → 後 → 無し
  const r6 = calc.tasksTab(view({ reminders: [{ id: 1, nextAt: at(12) }, { id: 2, nextAt: at(9) }, { id: 3, nextAt: null }, { id: 4, nextAt: at(9) }] }));
  assert.deepEqual(keys(r6.reminders), ["rem:2", "rem:4", "rem:1", "rem:3"]);
  assert.ok(r6.reminders.every((e) => e.kind === "reminder" && e.id === null));
  assert.equal(r6.count, 0, "6");
  // 7 tasks が配列でない
  const r7 = calc.tasksTab(view({ tasks: "x", reminders: [] }));
  assert.deepEqual([r7.overdue, r7.today, r7.later, r7.count], [[], [], [], 0]);
});

test("n-calc: §2.5 noticesTab の場合の表（1〜10）", () => {
  assert.equal(calc.FEED_MAX, 50);
  // 1
  assert.deepEqual(calc.noticesTab(view({ github: GITHUB })), { ready: false, items: [], unseen: 0 });
  // 2
  const r2 = calc.noticesTab(view({ notices: [{ at: at(3), text: "a" }, { at: at(5), text: "b" }] }));
  assert.equal(r2.ready, true);
  assert.deepEqual(keys(r2.items), [`notice:${at(5)}:1`, `notice:${at(3)}:0`]);
  // 3 同じ時刻は GitHub → 知らせ → 話題
  const d3 = data({ topics: [topic("ch:1", { last: agent(2), activityAt: at(4) })] });
  const r3 = calc.noticesTab(view({ topics: d3, replies: "notices", notices: [{ at: at(4), text: "n" }], github: [{ id: "g", url: "u", updatedAt: at(4) }] }));
  assert.deepEqual(keys(r3.items), ["gh:g", `notice:${at(4)}:0`, "topic:ch:1"]);
  assert.deepEqual(r3.items.map((e) => e.kind), ["github", "notice", "reply"]);
  assert.equal(r3.items[2]!.id, "ch:1");
  // 4 時刻の無い知らせは最後
  const r4 = calc.noticesTab(view({ notices: [{ text: "x" }, { at: at(1), text: "y" }] }));
  assert.deepEqual(keys(r4.items), [`notice:${at(1)}:1`, "notice:undefined:0"]);
  assert.equal(r4.items[1]!.at, null);
  // 5 60 件 → 50 件
  const r5 = calc.noticesTab(view({ notices: Array.from({ length: 30 }, (_, i) => ({ at: at(i % 24), text: "n" })), github: Array.from({ length: 30 }, (_, i) => ({ id: i, url: "u", updatedAt: at(i % 24) })) }));
  assert.equal(r5.items.length, 50);
  // 6 GitHub の種類
  const r6 = calc.noticesTab(view({ notices: [], github: GITHUB }));
  assert.deepEqual(
    r6.items.map((e) => [e.key, e.kind, e.id]),
    [
      ["gh:g1", "pr", null],
      ["gh:g2", "issue", null],
      ["gh:g3", "github", null],
    ],
  );
  assert.equal(r6.items[0]!.src, GITHUB[0]);
  // 7 知らせの key
  assert.deepEqual(keys(calc.noticesTab(view({ notices: NOTICES })).items).slice(0, 2), [`notice:${at(12)}:0`, `notice:${at(10)}:1`]);
  // 8 未読の話題は既定・dot では入らない
  for (const replies of ["turn", "dot", undefined]) {
    assert.deepEqual(keys(calc.noticesTab(view({ topics: d3, replies, notices: [] })).items), [], String(replies));
  }
  // 9 基準が無い・読めない
  assert.equal(calc.noticesTab(view({ notices: NOTICES, github: GITHUB })).unseen, 0, "9");
  assert.equal(calc.noticesTab(view({ notices: NOTICES, github: GITHUB, noticesSeenAt: "x" })).unseen, 0, "9 読めない");
  // 10 新しい GitHub 1・知らせ 1、古い知らせ 1、新しい未読の話題 1 → 2
  const r10 = calc.noticesTab(
    view({
      topics: data({ topics: [topic("ch:1", { last: agent(2), activityAt: at(12) })] }),
      replies: "notices",
      noticesSeenAt: at(8),
      github: [{ id: "g", url: "u", updatedAt: at(9) }],
      notices: [{ at: at(10), text: "新" }, { at: at(7), text: "古" }, { text: "時刻なし" }],
    }),
  );
  assert.equal(r10.items.length, 5);
  assert.equal(r10.unseen, 2, "10");
});

test("n-calc: §2.5 tabBadges の場合", () => {
  assert.deepEqual(calc.tabBadges(view()), { talk: { dot: false }, topics: { dot: false }, turn: { count: 0 }, tasks: { count: 0 }, notices: { count: 0 } });
  // 右腕だけ未読
  const handOnly = data({ rightHands: [{ id: "ch:100", turn: null, last: agent(5) }], topics: [topic("ch:1", { last: agent(2) })] });
  const b1 = calc.tabBadges(view({ topics: handOnly, seen: { "1": 2 } }));
  assert.deepEqual([b1.talk.dot, b1.topics.dot], [true, false]);
  // 右腕に番が在れば点ではない（番の数）
  const handTurn = data({ turnIds: ["ch:100"], rightHands: [{ id: "ch:100", turn: turnOf("question", 1), last: agent(5) }] });
  const b2 = calc.tabBadges(view({ topics: handTurn }));
  assert.deepEqual([b2.talk.dot, b2.turn.count], [false, 1]);
  // 話題だけ未読（置き場所によらない）
  for (const replies of ["turn", "notices", "dot"]) {
    const b3 = calc.tabBadges(view({ topics: handOnly, seen: { "100": 5 }, replies }));
    assert.deepEqual([b3.talk.dot, b3.topics.dot], [false, true], replies);
  }
  // 番 2・期限切れ 1・今日 1・見ていない通知 3
  const b4 = calc.tabBadges(
    view({
      topics: data({ turnIds: ["ch:1", "ch:2"], topics: [topic("ch:1", { mark: "turn", turn: turnOf("question", 1) }), topic("ch:2", { mark: "turn", turn: turnOf("permission", 1) })] }),
      tasks: [
        { id: 1, due: "2026-11-27" },
        { id: 2, due: "2026-11-28" },
        { id: 3, due: "2026-11-29" },
      ],
      today: "2026-11-28",
      notices: [{ at: at(9), text: "a" }, { at: at(10), text: "b" }, { at: at(1), text: "c" }],
      github: [{ id: "g", url: "u", updatedAt: at(11) }],
      noticesSeenAt: at(5),
    }),
  );
  assert.deepEqual([b4.turn.count, b4.tasks.count, b4.notices.count], [2, 2, 3]);
});

// ===== ピンの 1 段（§2.6） =====
test("n-calc: §2.6 pinStrip の場合の表（1〜7）", () => {
  // 1
  assert.deepEqual(calc.pinStrip(view(), "ch:5"), []);
  const hand = { id: "ch:100", turn: null, last: agent(5) };
  const t7 = topic("ch:7", { last: agent(3) });
  const t9 = topic("ch:9", { mark: "turn", turn: turnOf("question", 1) });
  const t5 = topic("ch:5", { mark: "running" });
  const d = data({ rightHands: [hand], topics: [t5, t7, t9], pins: ["7", "9"], handPins: [] });
  // 2 右腕が先頭（留めていなくても）
  const r2 = calc.pinStrip(view({ topics: d }), null);
  assert.deepEqual(r2[0], { key: "hand:ch:100", kind: "hand", id: "ch:100", src: hand, turn: false, unread: true });
  assert.equal(r2[0]!.src, hand);
  assert.equal(calc.pinStrip(view({ topics: d, seen: { "100": 5 } }), null)[0]!.unread, false);
  const turnHand = { id: "ch:100", turn: turnOf("question", 1), last: agent(5) };
  assert.deepEqual(calc.pinStrip(view({ topics: { ...d, rightHands: [turnHand] } }), null)[0], { key: "hand:ch:100", kind: "hand", id: "ch:100", src: turnHand, turn: true, unread: false });
  // 3 右腕が無い
  assert.deepEqual(keys(calc.pinStrip(view({ topics: { ...d, rightHands: [] } }), null)), ["pin:ch:7", "pin:ch:9"]);
  // 4 留めた順
  assert.deepEqual(r2.slice(1), [
    { key: "pin:ch:7", kind: "pin", id: "ch:7", src: t7, turn: false, unread: true },
    { key: "pin:ch:9", kind: "pin", id: "ch:9", src: t9, turn: true, unread: false },
  ]);
  assert.deepEqual(keys(calc.pinStrip(view({ topics: { ...d, pins: ["9", "7"] } }), null)), ["hand:ch:100", "pin:ch:9", "pin:ch:7"]);
  // 5 一覧に無い・右腕と同じ channelId は出さない（重なりも 1 つ）
  assert.deepEqual(keys(calc.pinStrip(view({ topics: { ...d, pins: ["404", "100", "7", "7"] } }), null)), ["hand:ch:100", "pin:ch:7"]);
  // 上限は切らない
  const many = data({ topics: ["1", "2", "3", "4", "5", "6"].map((n) => topic("ch:" + n)), pins: ["1", "2", "3", "4", "5", "6"], pinMax: 4 });
  assert.equal(calc.pinStrip(view({ topics: many }), null).length, 6);
  // 6 仮の項目
  assert.deepEqual(calc.pinStrip(view({ topics: d }), "ch:5").at(-1), { key: "temp:ch:5", kind: "temp", id: "ch:5", src: t5, turn: false, unread: false });
  assert.deepEqual(calc.pinStrip(view({ topics: d }), "ch:404").at(-1), { key: "temp:ch:404", kind: "temp", id: "ch:404", src: null, turn: false, unread: false });
  const tu = topic("ch:6", { last: agent(2) });
  assert.deepEqual(calc.pinStrip(view({ topics: { ...d, topics: [...(d.topics as Obj[]), tu] } }), "ch:6").at(-1), { key: "temp:ch:6", kind: "temp", id: "ch:6", src: tu, turn: false, unread: true });
  // 7 仮の項目が無い場合
  for (const openId of [null, undefined, "", "ch:100", "ch:7", "ch:9", "cc:abc"]) {
    assert.deepEqual(keys(calc.pinStrip(view({ topics: d }), openId)), ["hand:ch:100", "pin:ch:7", "pin:ch:9"], String(openId));
  }
  // 留めたが一覧に無い話題を開いていても仮の項目にしない
  assert.deepEqual(keys(calc.pinStrip(view({ topics: { ...d, pins: ["7", "404"] } }), "ch:404")), ["hand:ch:100", "pin:ch:7"]);
});

// ===== 関数の字の切り出し（test/web-static.test.ts の fnSource の写し。ほかの検査のファイルを import するとその検査が走るので写す） =====
function fnSource(js: string, name: string): string {
  const start = js.indexOf(`\n  function ${name}(`);
  assert.ok(start >= 0, name);
  const end = js.indexOf("\n  }\n", start);
  assert.ok(end > start, name);
  return js.slice(start, end + 4);
}
