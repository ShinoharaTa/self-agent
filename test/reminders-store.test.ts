import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import type { NewReminder, ReminderStore } from "../src/store/reminders.ts";
import { createStores, tempDb } from "./helpers/db.ts";

/** 2026-10-13T00:<minute>:00.000Z */
function at(minute: number): Date {
  return new Date(Date.UTC(2026, 9, 13, 0, minute));
}

/** setMinute で進める時計を持つストア（初めは 00:00） */
function tempStore(t: TestContext): { store: ReminderStore; setMinute: (minute: number) => void } {
  let minute = 0;
  const { reminders: store } = createStores(tempDb(t), () => at(minute));
  return {
    store,
    setMinute: (value) => {
      minute = value;
    },
  };
}

function reminder(overrides: Partial<NewReminder> = {}): NewReminder {
  return { guildId: "g", channelId: "ch-1", kind: "notify", text: "薬を飲む", nextAt: at(30), ...overrides };
}

test("ReminderStore: 追加・取得", (t) => {
  const { store } = tempStore(t);
  const added = store.add(reminder({ taskId: 12 }));
  assert.deepEqual(added, {
    id: 1,
    guildId: "g",
    channelId: "ch-1",
    kind: "notify",
    text: "薬を飲む",
    taskId: 12,
    rule: null,
    nextAt: at(30).toISOString(),
    snoozeAt: null,
    status: "active",
    fireSeq: 0,
    lastFiredAt: null,
    lastMessageId: null,
    createdAt: at(0).toISOString(),
    updatedAt: at(0).toISOString(),
  });
  assert.deepEqual(store.get(1), added);
  assert.equal(store.get(2), undefined);
  assert.equal(store.add(reminder({ kind: "prompt", rule: "daily@08:00" })).rule, "daily@08:00");
});

test("ReminderStore: markFired・claim は fire_seq が合うときだけ書き換え、snooze_at を消して fire_seq を 1 増やす", (t) => {
  const { store, setMinute } = tempStore(t);
  const fire = (id: number, seq: number) =>
    store.markFired(id, seq, { nextAt: null, status: "fired", firedAt: at(30), messageId: "msg-1" });
  const claim = (id: number, seq: number) => store.claim(id, seq, { nextAt: at(90), status: "active", firedAt: at(30) });
  const cases: Array<[label: string, run: (id: number, seq: number) => boolean, expected: object]> = [
    ["markFired", fire, { nextAt: null, status: "fired", lastMessageId: "msg-1" }],
    ["claim は最後の投稿を変えない", claim, { nextAt: at(90).toISOString(), status: "active", lastMessageId: "old" }],
  ];
  for (const [label, run, expected] of cases) {
    setMinute(0);
    const { id } = store.add(reminder());
    store.markFired(id, 0, { nextAt: at(60), status: "active", firedAt: at(0), messageId: "old" });
    store.snooze(id, at(40));
    setMinute(31);
    assert.equal(run(id, 0), false, `${label}: 古い seq`);
    assert.equal(store.get(id)?.fireSeq, 1, label);
    assert.equal(run(id, 1), true, label);
    assert.deepEqual(
      store.get(id),
      { ...store.get(id)!, ...expected, snoozeAt: null, fireSeq: 2, lastFiredAt: at(30).toISOString(), updatedAt: at(31).toISOString() },
      label,
    );
    // 同じ seq でもう一度は書き換えない
    assert.equal(run(id, 1), false, `${label}: 2 回目`);
    assert.equal(run(999, 0), false, `${label}: 無い id`);
  }
});

test("ReminderStore: listDue は active で next_at か snooze_at が now 以前のものを早い順に、limit 件まで", (t) => {
  const { store } = tempStore(t);
  const due = store.add(reminder({ nextAt: at(10) }));
  const exact = store.add(reminder({ nextAt: at(20) }));
  const future = store.add(reminder({ nextAt: at(21) }));
  const snoozed = store.add(reminder({ nextAt: at(50) }));
  store.snooze(snoozed.id, at(5));
  const snoozedFuture = store.add(reminder({ nextAt: at(50) }));
  store.snooze(snoozedFuture.id, at(25));
  // 1 回だけで知らせた後（next_at なし）にスヌーズしたもの
  const firedSnoozed = store.add(reminder({ nextAt: at(1) }));
  store.markFired(firedSnoozed.id, 0, { nextAt: null, status: "fired", firedAt: at(1), messageId: "m" });
  store.snooze(firedSnoozed.id, at(15));
  store.complete(store.add(reminder({ nextAt: at(1) })).id);
  store.cancel(store.add(reminder({ nextAt: at(1) })).id);
  const fired = store.add(reminder({ nextAt: at(1) }));
  store.markFired(fired.id, 0, { nextAt: null, status: "fired", firedAt: at(1), messageId: "m" });

  assert.deepEqual(
    store.listDue(at(20), 20).map((r) => r.id),
    [snoozed.id, due.id, firedSnoozed.id, exact.id],
  );
  assert.deepEqual(store.listDue(at(20), 2).map((r) => r.id), [snoozed.id, due.id]);
  assert.ok(!store.listDue(at(20), 20).some((r) => r.id === future.id || r.id === snoozedFuture.id));
});

test("ReminderStore: listActive は active を next_at と snooze_at の早い方の順（同じなら id 順）に、countActive は kind ごとにも数える", (t) => {
  const { store } = tempStore(t);
  const late = store.add(reminder({ nextAt: at(50) }));
  const early = store.add(reminder({ nextAt: at(20), kind: "prompt", rule: "daily@09:20" }));
  const snoozed = store.add(reminder({ nextAt: at(60) }));
  store.snooze(snoozed.id, at(10));
  const sameTime = store.add(reminder({ nextAt: at(20) }));
  const cancelled = store.add(reminder({ nextAt: at(1), kind: "prompt" }));
  store.cancel(cancelled.id);

  assert.deepEqual(store.listActive(50).map((r) => r.id), [snoozed.id, early.id, sameTime.id, late.id]);
  assert.deepEqual(store.listActive(1).map((r) => r.id), [snoozed.id]);
  assert.equal(store.countActive(), 4);
  assert.equal(store.countActive({ kind: "prompt" }), 1);
  assert.equal(store.countActive({ kind: "notify" }), 3);
});

test("ReminderStore: findDuplicate は同じチャンネル・text・rule の active（1 回だけなら同じ時刻）", (t) => {
  const { store } = tempStore(t);
  const once = store.add(reminder());
  const repeating = store.add(reminder({ rule: "daily@08:00", nextAt: at(40) }));
  const cancelled = store.add(reminder({ text: "止めた", rule: "daily@08:00" }));
  store.cancel(cancelled.id);

  const cases: Array<[label: string, args: [string, string, string | null, Date | null], id: number | undefined]> = [
    ["1 回だけ: 同じ時刻", ["ch-1", "薬を飲む", null, at(30)], once.id],
    ["1 回だけ: 違う時刻", ["ch-1", "薬を飲む", null, at(31)], undefined],
    ["繰り返し: 時刻は見ない", ["ch-1", "薬を飲む", "daily@08:00", at(99)], repeating.id],
    ["違う rule", ["ch-1", "薬を飲む", "weekdays@08:00", at(40)], undefined],
    ["違うチャンネル", ["ch-2", "薬を飲む", null, at(30)], undefined],
    ["違う text", ["ch-1", "水を飲む", null, at(30)], undefined],
    ["active でない", ["ch-1", "止めた", "daily@08:00", at(30)], undefined],
  ];
  for (const [label, args, id] of cases) assert.equal(store.findDuplicate(...args)?.id, id, label);
});

test("ReminderStore: snooze・complete・cancel・skipNext・moveChannel は状態が合うときだけ書き換え、updated_at を今に", (t) => {
  const { store, setMinute } = tempStore(t);
  const fired = (r: { id: number }) =>
    store.markFired(r.id, 0, { nextAt: null, status: "fired", firedAt: at(0), messageId: "m" });

  const once = store.add(reminder());
  fired(once);
  setMinute(1);
  assert.equal(store.snooze(once.id, at(11)), true);
  assert.deepEqual(
    [store.get(once.id)?.status, store.get(once.id)?.snoozeAt, store.get(once.id)?.updatedAt],
    ["active", at(11).toISOString(), at(1).toISOString()],
  );

  // complete は active・fired、cancel は active だけ
  const firedOnce = store.add(reminder());
  fired(firedOnce);
  assert.equal(store.cancel(firedOnce.id), false);
  assert.equal(store.complete(firedOnce.id), true);
  assert.equal(store.get(firedOnce.id)?.status, "done");
  for (const op of [() => store.complete(firedOnce.id), () => store.cancel(firedOnce.id), () => store.snooze(firedOnce.id, at(5))]) {
    assert.equal(op(), false);
  }
  const repeating = store.add(reminder({ rule: "daily@08:00" }));
  setMinute(2);
  assert.equal(store.skipNext(once.id, at(99)), false, "1 回だけは飛ばせない");
  assert.equal(store.skipNext(repeating.id, at(99)), true);
  assert.equal(store.get(repeating.id)?.nextAt, at(99).toISOString());
  assert.equal(store.moveChannel(repeating.id, "ch-tasks"), true);
  assert.equal(store.get(repeating.id)?.channelId, "ch-tasks");
  assert.equal(store.cancel(repeating.id), true);
  assert.deepEqual([store.get(repeating.id)?.status, store.get(repeating.id)?.updatedAt], ["cancelled", at(2).toISOString()]);
  assert.equal(store.skipNext(repeating.id, at(120)), false, "止めたものは飛ばせない");
  for (const op of [() => store.snooze(999, at(5)), () => store.complete(999), () => store.cancel(999), () => store.moveChannel(999, "x")]) {
    assert.equal(op(), false);
  }
});

test("ReminderStore: 止めた後の markFired・claim は false、complete は 1 回だけ・clearSnooze は繰り返しだけ、expectedSeq が違えば書き換えない", (t) => {
  const { store } = tempStore(t);
  const update = { nextAt: at(99), status: "active" as const, firedAt: at(0) };

  // 発火を読んだ後（fire_seq 0）に止められたら、記録で active に戻さない
  const stopped = store.add(reminder({ rule: "daily@08:00" }));
  store.cancel(stopped.id);
  assert.equal(store.markFired(stopped.id, 0, { ...update, messageId: "m" }), false);
  assert.equal(store.claim(stopped.id, 0, update), false);
  assert.equal(store.get(stopped.id)?.status, "cancelled");

  const repeating = store.add(reminder({ rule: "daily@08:00" }));
  store.snooze(repeating.id, at(40));
  assert.equal(store.complete(repeating.id), false, "繰り返しは complete で終わらない");
  assert.equal(store.clearSnooze(repeating.id, 1), false, "seq が違う");
  assert.equal(store.clearSnooze(repeating.id, 0), true);
  assert.deepEqual([store.get(repeating.id)?.status, store.get(repeating.id)?.snoozeAt], ["active", null]);

  const once = store.add(reminder());
  assert.equal(store.clearSnooze(once.id), false, "1 回だけには使わない");
  store.markFired(once.id, 0, { ...update, nextAt: null, status: "fired", messageId: "m" });
  const staleSeq: Array<[label: string, op: () => boolean]> = [
    ["snooze", () => store.snooze(once.id, at(50), 0)],
    ["complete", () => store.complete(once.id, 0)],
    ["cancel", () => store.cancel(once.id, 0)],
  ];
  for (const [label, op] of staleSeq) assert.equal(op(), false, label);
  assert.equal(store.snooze(once.id, at(50), 1), true);
  assert.equal(store.complete(once.id, 1), true);
});

test("ReminderStore: nextForTasks は紐づけた active のうち次に知らせる時刻をタスクごとに", (t) => {
  const { store } = tempStore(t);
  store.add(reminder({ taskId: 1, nextAt: at(40) }));
  store.add(reminder({ taskId: 1, nextAt: at(30) }));
  const snoozed = store.add(reminder({ taskId: 2, nextAt: at(50) }));
  store.snooze(snoozed.id, at(20));
  const cancelled = store.add(reminder({ taskId: 3, nextAt: at(10) }));
  store.cancel(cancelled.id);
  store.add(reminder({ taskId: 4, nextAt: at(10) }));

  assert.deepEqual(
    store.nextForTasks([1, 2, 3, 5]),
    new Map([
      [1, at(30).toISOString()],
      [2, at(20).toISOString()],
    ]),
  );
  assert.deepEqual(store.nextForTasks([]), new Map());
});
