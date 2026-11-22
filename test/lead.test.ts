import { test } from "node:test";
import assert from "node:assert/strict";
import {
  createLead,
  inScope,
  isLeadText,
  LEAD_LONG_MS,
  LEAD_MAX_LINES,
  LEAD_WINDOW_MS,
  type LeadCounts,
  type LeadDeps,
  leadCounts,
  leadText,
  ringsFor,
  type TurnEndEvent,
} from "../src/app/lead.ts";
import type { ProgressTimers, TurnOutcome } from "../src/app/progress.ts";
import type { Topic } from "../src/app/topics.ts";
import { PROPOSAL_EXPIRED_NOTICE, PROPOSAL_KEPT_NOTICE } from "../src/app/topic-proposals.ts";
import { idleNotice } from "../src/app/scheduler.ts";
import { ROTATED_NOTICE } from "../src/app/inbox-rotate.ts";
import type { OutgoingMessage } from "../src/discord/gateway.ts";
import { HistoryStore } from "../src/store/history.ts";
import { tempDb } from "./helpers/db.ts";

const GUILD = "900";
const INBOX = "500";
const OWNER = "700";

function event(channelId: string, over: Partial<TurnEndEvent> = {}): TurnEndEvent {
  return { guildId: GUILD, channelId, durationMs: 4 * 60_000, outcome: "done", byRightHand: false, pinged: false, ...over };
}

/** after だけを手で進める偽のタイマー */
function fakeTimers() {
  let seq = 0;
  let calls = 0;
  const pending = new Map<number, { fn: () => void; ms: number }>();
  const timers: ProgressTimers = {
    after(fn, ms) {
      const id = ++seq;
      calls++;
      pending.set(id, { fn, ms });
      return () => pending.delete(id);
    },
    every() {
      throw new Error("every は使わない");
    },
  };
  return {
    timers,
    pending,
    /** after が呼ばれた回数（張り直しを見分ける） */
    calls: () => calls,
    /** 溜まったタイマーを全部呼ぶ */
    fire() {
      const all = [...pending.values()];
      pending.clear();
      for (const timer of all) timer.fn();
    },
  };
}

function setup(t: Parameters<typeof tempDb>[0], over: Partial<LeadDeps> = {}) {
  const db = tempDb(t);
  const history = new HistoryStore(db);
  const clock = fakeTimers();
  const posts: Array<{ channelId: string; message: OutgoingMessage }> = [];
  const logs: string[] = [];
  const deps: LeadDeps = {
    settings: () => ({ ring: "long", scope: "all" }),
    ownerUserId: OWNER,
    inboxOf: () => INBOX,
    post: async (channelId, message) => {
      posts.push({ channelId, message });
      return "m1";
    },
    counts: () => ({ running: 1, queued: 0, yourTurn: 1 }),
    history,
    timers: clock.timers,
    log: (message) => logs.push(message),
    ...over,
  };
  const lead = createLead(deps);
  const rows = () => history.list(INBOX, { limit: 50 });
  return { lead, clock, posts, logs, rows };
}

function topic(over: Partial<Topic>): Topic {
  return {
    id: "ch:1",
    title: "t",
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
    activityAt: null,
    last: null,
    movable: true,
    link: null,
    queued: false,
    stopped: false,
    ended: null,
    tookMs: null,
    byRightHand: false,
    ...over,
  };
}

test("lead: 別々の 3 つの話題の事象は 60 秒後に #inbox へ 1 通・history に notice 1 行（system・既定の人格・mention なしの同じ文）", async (t) => {
  const { lead, clock, posts, rows } = setup(t, { settings: () => ({ ring: "all", scope: "all" }) });
  lead.onTurnEnd(event("111"));
  lead.onTurnEnd(event("222", { durationMs: 30_000 }));
  lead.onTurnEnd(event("333", { durationMs: 12 * 60_000 }));
  assert.equal(clock.pending.size, 1);
  // 窓は最初の事象から数える（後の事象で張り直さない）
  assert.equal(clock.calls(), 1);
  assert.equal([...clock.pending.values()][0]!.ms, LEAD_WINDOW_MS);
  assert.equal(posts.length, 0);
  clock.fire();
  await lead.idle();
  assert.equal(posts.length, 1);
  assert.equal(posts[0]!.channelId, INBOX);
  const text = "終わりました: <#111>（4 分）\n終わりました: <#222>（1 分未満）\n終わりました: <#333>（12 分）\n残り: 動いている 1・あなたの番 1";
  assert.deepEqual(posts[0]!.message, { text, mentionUserId: OWNER });
  const list = rows();
  assert.equal(list.length, 1);
  assert.equal(list[0]!.kind, "notice");
  assert.equal(list[0]!.source, "system");
  assert.equal(list[0]!.persona, "default");
  assert.equal(list[0]!.text, text);
  assert.equal(list[0]!.guildId, GUILD);
});

test("lead: 窓の中で同じ話題が 2 回 → 行は後の 1 つで順は後ろへ。窓の後の事象は次の 1 通", async (t) => {
  const { lead, clock, posts } = setup(t, { counts: () => null });
  lead.onTurnEnd(event("111", { durationMs: 60_000 }));
  lead.onTurnEnd(event("222"));
  lead.onTurnEnd(event("111", { durationMs: 3 * 60_000 }));
  // 窓は延ばさない（タイマーは 1 つ）
  assert.equal(clock.pending.size, 1);
  clock.fire();
  await lead.idle();
  assert.equal(posts[0]!.message.text, "終わりました: <#222>（4 分）\n終わりました: <#111>（3 分）");
  lead.onTurnEnd(event("333"));
  assert.equal(clock.pending.size, 1);
  clock.fire();
  await lead.idle();
  assert.equal(posts.length, 2);
  assert.equal(posts[1]!.message.text, "終わりました: <#333>（4 分）");
});

test("lead: サーバーごとに別の窓・別の宛先", async (t) => {
  const { lead, clock, posts } = setup(t, { inboxOf: (guildId) => (guildId === GUILD ? INBOX : "501"), counts: () => null });
  lead.onTurnEnd(event("111"));
  lead.onTurnEnd(event("222", { guildId: "901" }));
  assert.equal(clock.pending.size, 2);
  clock.fire();
  await lead.idle();
  assert.deepEqual(posts.map((post) => post.channelId).sort(), [INBOX, "501"]);
});

test("leadText: 11 件 → 話題の行 9 + 「ほか 2 件」。10 件 → 10 行", () => {
  const eleven = Array.from({ length: 11 }, (_, i) => event(String(100 + i)));
  const lines11 = leadText(eleven, null).split("\n");
  assert.equal(lines11.length, 10);
  assert.equal(lines11[8], "終わりました: <#108>（4 分）");
  assert.equal(lines11[9], "ほか 2 件");
  const lines10 = leadText(eleven.slice(0, 10), null).split("\n");
  assert.equal(lines10.length, 10);
  assert.equal(lines10[9], "終わりました: <#109>（4 分）");
});

test("leadText: 止まった物（上限 → 失敗 → 中断）を先・終わった物を後。同じ種類は事象の順。時間は 60 秒未満が「1 分未満」", () => {
  const text = leadText(
    [
      event("111"),
      event("444", { outcome: "aborted" }),
      event("222", { outcome: "failed" }),
      event("333", { outcome: "max_turns" }),
      event("555", { outcome: "failed" }),
      event("666", { durationMs: 59_999 }),
      event("777", { durationMs: 60_000 }),
    ],
    { running: 1, queued: 2, yourTurn: 1 },
  );
  assert.equal(
    text,
    [
      "止まりました: <#333>（上限。［続ける］が要ります）",
      "止まりました: <#222>（失敗）",
      "止まりました: <#555>（失敗）",
      "止まりました: <#444>（中断）",
      "終わりました: <#111>（4 分）",
      "終わりました: <#666>（1 分未満）",
      "終わりました: <#777>（1 分）",
      "残り: 動いている 1・順番待ち 2・あなたの番 1",
    ].join("\n"),
  );
});

test("leadText: 残りの行は 0 の項を出さず、全部 0 なら「残り: なし」、null なら出さない", () => {
  assert.equal(leadText([event("111")], { running: 0, queued: 3, yourTurn: 0 }), "終わりました: <#111>（4 分）\n残り: 順番待ち 3");
  assert.equal(leadText([event("111")], { running: 0, queued: 0, yourTurn: 0 }), "終わりました: <#111>（4 分）\n残り: なし");
  assert.equal(leadText([event("111")], null), "終わりました: <#111>（4 分）");
});

test("inScope: all・long（via 在り／120 秒ちょうど／done 以外／どれでもない）・right_hand", () => {
  const short = event("111", { durationMs: LEAD_LONG_MS - 1 });
  assert.equal(inScope(short, "all"), true);
  assert.equal(inScope(short, "long"), false);
  assert.equal(inScope({ ...short, via: "right_hand" }, "long"), true);
  assert.equal(inScope({ ...short, via: "github" }, "long"), true);
  assert.equal(inScope({ ...short, durationMs: LEAD_LONG_MS }, "long"), true);
  for (const outcome of ["max_turns", "failed", "aborted"] as const) {
    assert.equal(inScope({ ...short, outcome }, "long"), true, outcome);
  }
  assert.equal(inScope(short, "right_hand"), false);
  assert.equal(inScope({ ...short, byRightHand: true }, "right_hand"), true);
  // right_hand は時間・終わり方・via を見ない
  assert.equal(inScope({ ...short, outcome: "failed", via: "github", durationMs: LEAD_LONG_MS }, "right_hand"), false);
});

test("ringsFor: 4 つの値 ×（done 短い／done 120 秒以上／max_turns／failed／aborted）× pinged", () => {
  const cases: Array<[string, Partial<TurnEndEvent>]> = [
    ["doneShort", { outcome: "done", durationMs: LEAD_LONG_MS - 1 }],
    ["doneLong", { outcome: "done", durationMs: LEAD_LONG_MS }],
    ["maxTurns", { outcome: "max_turns", durationMs: 1000 }],
    ["failed", { outcome: "failed", durationMs: 1000 }],
    ["aborted", { outcome: "aborted", durationMs: LEAD_LONG_MS }],
  ];
  // [ring][case] → [pinged: false, pinged: true]
  const expected: Record<string, Record<string, [boolean, boolean]>> = {
    off: { doneShort: [false, false], doneLong: [false, false], maxTurns: [false, false], failed: [false, false], aborted: [false, false] },
    all: { doneShort: [true, true], doneLong: [true, true], maxTurns: [true, true], failed: [true, true], aborted: [true, true] },
    stopped: { doneShort: [false, false], doneLong: [false, false], maxTurns: [true, false], failed: [true, false], aborted: [false, false] },
    long: { doneShort: [false, false], doneLong: [true, false], maxTurns: [true, false], failed: [true, false], aborted: [false, false] },
  };
  for (const ring of ["off", "all", "stopped", "long"] as const) {
    for (const [name, over] of cases) {
      for (const [i, pinged] of [false, true].entries()) {
        assert.equal(ringsFor(event("111", { ...over, pinged }), ring), expected[ring]![name]![i], `${ring} ${name} pinged=${pinged}`);
      }
    }
  }
});

test("lead: 鳴らす物と鳴らさない物が混ざった 1 通は mention 1 つ。ownerUserId が無い・ring off なら付けない。鳴らす物が無ければ付けない", async (t) => {
  const mixed = [event("111", { durationMs: 1000 }), event("222", { outcome: "failed" })];
  const run = async (over: Partial<LeadDeps>, events: TurnEndEvent[]) => {
    const { lead, clock, posts } = setup(t, { counts: () => null, ...over });
    for (const e of events) lead.onTurnEnd(e);
    clock.fire();
    await lead.idle();
    assert.equal(posts.length, 1);
    return posts[0]!.message;
  };
  const rung = await run({}, mixed);
  assert.equal(rung.mentionUserId, OWNER);
  assert.ok(!rung.text.includes(OWNER));
  assert.equal("mentionUserId" in (await run({ ownerUserId: undefined }, mixed)), false);
  assert.equal("mentionUserId" in (await run({ settings: () => ({ ring: "off", scope: "all" }) }, mixed)), false);
  assert.equal("mentionUserId" in (await run({}, [event("111", { durationMs: 1000 })])), false);
});

test("lead: scope が偽の事象は捨てる（タイマーも立てない）", async (t) => {
  const { lead, clock, posts } = setup(t, { settings: () => ({ ring: "long", scope: "long" }) });
  lead.onTurnEnd(event("111", { durationMs: 1000 }));
  assert.equal(clock.pending.size, 0);
  clock.fire();
  await lead.idle();
  assert.equal(posts.length, 0);
});

test("lead: post が reject → 投げない・log 1 行・history 0 行。次の窓は普通に動く", async (t) => {
  let fail = true;
  const { lead, clock, posts, logs, rows } = setup(t, {
    post: async (channelId, message) => {
      if (fail) throw new Error("boom");
      posts.push({ channelId, message });
      return "m1";
    },
  });
  lead.onTurnEnd(event("111"));
  clock.fire();
  await lead.idle();
  assert.deepEqual(logs, ["まとめの投稿に失敗しました: boom"]);
  assert.equal(rows().length, 0);
  fail = false;
  lead.onTurnEnd(event("222"));
  clock.fire();
  await lead.idle();
  assert.equal(posts.length, 1);
  assert.equal(rows().length, 1);
});

test("lead: inboxOf が null → 投稿しない・log に件数", async (t) => {
  const { lead, clock, posts, logs, rows } = setup(t, { inboxOf: () => null });
  lead.onTurnEnd(event("111"));
  lead.onTurnEnd(event("222"));
  clock.fire();
  await lead.idle();
  assert.equal(posts.length, 0);
  assert.equal(rows().length, 0);
  assert.deepEqual(logs, ["まとめの宛先がありません（2 件）"]);
});

test("lead: counts が投げる → 残りの行なしで出し、log 1 行", async (t) => {
  const { lead, clock, posts, logs } = setup(t, {
    counts: () => {
      throw new Error("db");
    },
  });
  lead.onTurnEnd(event("111"));
  clock.fire();
  await lead.idle();
  assert.equal(posts[0]!.message.text, "終わりました: <#111>（4 分）");
  assert.deepEqual(logs, ["まとめの残りの数を取れませんでした"]);
});

test("lead: stop() → タイマー取り消し・投稿なし・log に件数。以後の onTurnEnd は捨てる", async (t) => {
  const { lead, clock, posts, logs } = setup(t);
  lead.onTurnEnd(event("111"));
  lead.onTurnEnd(event("222", { guildId: "901" }));
  assert.equal(clock.pending.size, 2);
  lead.stop();
  assert.equal(clock.pending.size, 0);
  assert.deepEqual(logs, ["停止のため、まとめ 2 件を出しませんでした"]);
  lead.onTurnEnd(event("333"));
  assert.equal(clock.pending.size, 0);
  clock.fire();
  await lead.idle();
  assert.equal(posts.length, 0);
  // 溜まった物が無ければ log を出さない
  lead.stop();
  assert.equal(logs.length, 1);
});

test("lead: どの log にも、渡したチャンネル ID の字が入っていない", async (t) => {
  const ids = ["123456789012345678", "223456789012345678", "323456789012345678"];
  const inbox = "423456789012345678";
  const all: string[] = [];
  const cases: Array<Partial<LeadDeps>> = [
    { inboxOf: () => null },
    { inboxOf: () => inbox, post: async () => Promise.reject(new Error("boom")) },
    {
      inboxOf: () => inbox,
      counts: () => {
        throw new Error("db");
      },
    },
  ];
  for (const over of cases) {
    const { lead, clock, logs } = setup(t, over);
    for (const id of ids) lead.onTurnEnd(event(id));
    clock.fire();
    await lead.idle();
    lead.onTurnEnd(event(ids[0]!));
    lead.stop();
    all.push(...logs);
  }
  assert.ok(all.length >= 4);
  for (const line of all) {
    for (const id of [...ids, inbox]) assert.ok(!line.includes(id), line);
  }
});

test("isLeadText: leadText の出す文（4 種類の先頭の行）で真、今在る notice の文で偽", () => {
  for (const outcome of ["done", "max_turns", "failed", "aborted"] as TurnOutcome[]) {
    assert.equal(isLeadText(leadText([event("111", { outcome })], { running: 0, queued: 0, yourTurn: 0 })), true, outcome);
  }
  const notices = [idleNotice(12, "111").text, PROPOSAL_KEPT_NOTICE, PROPOSAL_EXPIRED_NOTICE, ROTATED_NOTICE, "残り: なし", "ほか 2 件"];
  for (const text of notices) {
    assert.equal(isLeadText(text), false, text);
  }
});

test("leadCounts: origin cc の行を数えない・queued は true だけ・yourTurn は turns", () => {
  const counts: LeadCounts = leadCounts({
    turns: 4,
    topics: [
      topic({ mark: "running" }),
      topic({ origin: "project", mark: "running" }),
      topic({ origin: "cc", mark: "running" }),
      topic({ queued: true }),
      topic({ origin: "cc", queued: true }),
      topic({ mark: "turn" }),
    ],
  });
  assert.deepEqual(counts, { running: 2, queued: 1, yourTurn: 4 });
});

test("lead: 窓・長いターン・行の上限の値（文書の「60 秒」「2 分以上」「10 行」と同じ）", () => {
  assert.equal(LEAD_WINDOW_MS, 60_000);
  assert.equal(LEAD_LONG_MS, 120_000);
  assert.equal(LEAD_MAX_LINES, 10);
});

test("lead: idle は投稿の途中を待つ。途中で stop しても、その 1 通と history の 1 行は出る", async (t) => {
  let release: (id: string) => void = () => {};
  const posted = new Promise<string>((resolve) => {
    release = resolve;
  });
  let started = 0;
  const { lead, clock, logs, rows } = setup(t, {
    post: () => {
      started++;
      return posted;
    },
  });
  lead.onTurnEnd(event("111"));
  clock.fire();
  assert.equal(started, 1);
  let idled = false;
  const idle = lead.idle().then(() => {
    idled = true;
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(idled, false);
  lead.stop();
  assert.equal(rows().length, 0);
  release("m1");
  await idle;
  assert.equal(idled, true);
  assert.equal(rows().length, 1);
  assert.equal(rows()[0]!.kind, "notice");
  // 途中の 1 通は捨てた数に入らない
  assert.deepEqual(logs, []);
});

test("lead: 宛先を引く所が投げても reject せず、log 1 行だけ（ID を出さない）。次の窓は動く", async (t) => {
  let fail = true;
  const { lead, clock, posts, logs, rows } = setup(t, {
    inboxOf: () => {
      if (fail) throw new Error("引けません");
      return INBOX;
    },
  });
  lead.onTurnEnd(event("111"));
  clock.fire();
  await lead.idle();
  assert.equal(posts.length, 0);
  assert.equal(rows().length, 0);
  assert.deepEqual(logs, ["まとめに失敗しました: 引けません"]);
  assert.ok(!logs.some((line) => line.includes("111") || line.includes(INBOX)));
  fail = false;
  lead.onTurnEnd(event("222"));
  clock.fire();
  await lead.idle();
  assert.equal(posts.length, 1);
  assert.equal(rows().length, 1);
});
