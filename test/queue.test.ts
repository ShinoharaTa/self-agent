import { test } from "node:test";
import assert from "node:assert/strict";
import { setImmediate as flush } from "node:timers/promises";
import { KeyedSerialQueue } from "../src/app/queue.ts";

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

test("同じ key のジョブは投入順に 1 つずつ実行する", async () => {
  const queue = new KeyedSerialQueue(4);
  const events: string[] = [];
  const gates = [deferred(), deferred(), deferred()];
  const runs = gates.map((gate, index) =>
    queue.run("a", async () => {
      events.push(`start ${index}`);
      await gate.promise;
      events.push(`end ${index}`);
      return index;
    }),
  );

  await flush();
  assert.deepEqual(events, ["start 0"]);
  gates[0]!.resolve();
  await flush();
  assert.deepEqual(events, ["start 0", "end 0", "start 1"]);
  gates[1]!.resolve();
  gates[2]!.resolve();
  assert.deepEqual(await Promise.all(runs), [0, 1, 2]);
  assert.deepEqual(events, ["start 0", "end 0", "start 1", "end 1", "start 2", "end 2"]);
});

test("異なる key は並列に動くが、同時実行数は maxConcurrent まで", async () => {
  const queue = new KeyedSerialQueue(2);
  let active = 0;
  let peak = 0;
  const gates = Array.from({ length: 5 }, () => deferred());
  const started: number[] = [];
  const runs = gates.map((gate, index) =>
    queue.run(`key-${index}`, async () => {
      active++;
      peak = Math.max(peak, active);
      started.push(index);
      await gate.promise;
      active--;
    }),
  );

  await flush();
  assert.deepEqual(started, [0, 1]);
  gates[1]!.resolve();
  await flush();
  assert.deepEqual(started, [0, 1, 2]);
  for (const gate of gates) gate.resolve();
  await Promise.all(runs);
  assert.equal(peak, 2);
  assert.deepEqual(started, [0, 1, 2, 3, 4]);
});

test("ジョブの例外は呼び出し元に返し、キューは止めない", async () => {
  const queue = new KeyedSerialQueue(1);
  const failed = queue.run("a", async () => {
    throw new Error("boom");
  });
  const sameKey = queue.run("a", async () => "same key");
  const otherKey = queue.run("b", async () => "other key");

  await assert.rejects(failed, /boom/);
  assert.equal(await sameKey, "same key");
  assert.equal(await otherKey, "other key");
});

test("maxConcurrent は正の整数", () => {
  assert.throws(() => new KeyedSerialQueue(0), RangeError);
  assert.throws(() => new KeyedSerialQueue(1.5), RangeError);
});

test("idle: 何も無ければすぐ resolve する", async () => {
  const queue = new KeyedSerialQueue(1);
  await queue.idle();
  await queue.run("a", async () => undefined);
  await queue.idle();
});

test("idle: 実行中・枠待ち・同じ key の前のジョブ待ちがすべて終わってから resolve する（例外で終わったジョブも数える）", async () => {
  const queue = new KeyedSerialQueue(1);
  const gates = [deferred(), deferred(), deferred()];
  // a-0 が実行中、b は枠待ち、a-1 は a-0 待ち
  const runs = [
    queue.run("a", () => gates[0]!.promise),
    queue.run("b", async () => {
      await gates[1]!.promise;
      throw new Error("boom");
    }),
    queue.run("a", () => gates[2]!.promise),
  ];
  let idle = false;
  const waiting = queue.idle().then(() => {
    idle = true;
  });

  for (const gate of gates) {
    await flush();
    assert.equal(idle, false);
    gate.resolve();
  }
  await waiting;
  assert.equal(idle, true);
  await Promise.allSettled(runs);
});

test("idle: 待っている間に足されたジョブも終わるまで resolve しない", async () => {
  const queue = new KeyedSerialQueue(2);
  const first = deferred();
  const second = deferred();
  void queue.run("a", () => first.promise);
  let idle = false;
  const waiting = queue.idle().then(() => {
    idle = true;
  });

  void queue.run("b", () => second.promise);
  first.resolve();
  await flush();
  await flush();
  assert.equal(idle, false);

  second.resolve();
  await waiting;
  assert.equal(idle, true);
});

test("セッションのジョブ: maxConcurrent 2 なら同時に 1 つまでで、その間も #inbox など（セッションでない）のジョブは動ける", async () => {
  const queue = new KeyedSerialQueue(2);
  const gates = { topicA: deferred(), topicB: deferred(), inbox: deferred() };
  const started: string[] = [];
  const job = (name: keyof typeof gates) => async () => {
    started.push(name);
    await gates[name].promise;
  };
  const runs = [
    queue.run("topic-a", job("topicA"), { session: true }),
    queue.run("topic-b", job("topicB"), { session: true }),
    queue.run("inbox", job("inbox")),
  ];

  // topic-b は枠が空いていてもセッションの上限で待ち、後から来た inbox が先に動く
  await flush();
  assert.deepEqual(started, ["topicA", "inbox"]);
  gates.inbox.resolve();
  await flush();
  assert.deepEqual(started, ["topicA", "inbox"]);
  gates.topicA.resolve();
  await flush();
  assert.deepEqual(started, ["topicA", "inbox", "topicB"]);
  gates.topicB.resolve();
  await Promise.all(runs);
});

test("セッションのジョブ: 待ちの順は来た順。枠が空いたら、先に来たもののうち枠の条件を満たすものから動く", async () => {
  const queue = new KeyedSerialQueue(2);
  const gates = Array.from({ length: 5 }, () => deferred());
  const started: number[] = [];
  const job = (index: number) => async () => {
    started.push(index);
    await gates[index]!.promise;
  };
  const runs = [
    // 0: セッション、1: #inbox で全枠を使う
    queue.run("topic-0", job(0), { session: true }),
    queue.run("inbox-1", job(1)),
    // 2: セッション、3: #inbox、4: #inbox の順に待つ
    queue.run("topic-2", job(2), { session: true }),
    queue.run("inbox-3", job(3)),
    queue.run("inbox-4", job(4)),
  ];
  await flush();
  assert.deepEqual(started, [0, 1]);

  // #inbox が終わって 1 枠空いても、セッションの 2 はセッションの上限で動けないので、次に来た 3 が動く
  gates[1]!.resolve();
  await flush();
  assert.deepEqual(started, [0, 1, 3]);

  // セッションの 0 が終わると、待っている中で一番先の 2 が動く（4 より先）
  gates[0]!.resolve();
  await flush();
  assert.deepEqual(started, [0, 1, 3, 2]);

  gates[3]!.resolve();
  await flush();
  assert.deepEqual(started, [0, 1, 3, 2, 4]);
  for (const gate of gates) gate.resolve();
  await Promise.all(runs);
});

test("セッションのジョブ: maxConcurrent 1 なら、セッションもそれ以外も全部 1 つずつ", async () => {
  const queue = new KeyedSerialQueue(1);
  let active = 0;
  let peak = 0;
  const gates = Array.from({ length: 4 }, () => deferred());
  const started: number[] = [];
  const runs = gates.map((gate, index) =>
    queue.run(
      `key-${index}`,
      async () => {
        active++;
        peak = Math.max(peak, active);
        started.push(index);
        await gate.promise;
        active--;
      },
      { session: index % 2 === 0 },
    ),
  );

  for (const [index, gate] of gates.entries()) {
    await flush();
    assert.deepEqual(started, Array.from({ length: index + 1 }, (_value, i) => i));
    gate.resolve();
  }
  await Promise.all(runs);
  assert.equal(peak, 1);
});

test("セッションのジョブ: 同じ key は種類によらず直列。idle はセッションのジョブも待つ", async () => {
  const queue = new KeyedSerialQueue(3);
  const gates = [deferred(), deferred()];
  const events: string[] = [];
  const runs = [
    queue.run(
      "topic-1",
      async () => {
        events.push("start 0");
        await gates[0]!.promise;
        events.push("end 0");
      },
      { session: true },
    ),
    // 同じチャンネルの /close のターンなど
    queue.run(
      "topic-1",
      async () => {
        events.push("start 1");
        await gates[1]!.promise;
        events.push("end 1");
      },
      { session: true },
    ),
  ];
  let idle = false;
  const waiting = queue.idle().then(() => {
    idle = true;
  });

  await flush();
  assert.deepEqual(events, ["start 0"]);
  gates[0]!.resolve();
  await flush();
  assert.deepEqual(events, ["start 0", "end 0", "start 1"]);
  assert.equal(idle, false);
  gates[1]!.resolve();
  await waiting;
  await Promise.all(runs);
  assert.deepEqual(events, ["start 0", "end 0", "start 1", "end 1"]);
});
