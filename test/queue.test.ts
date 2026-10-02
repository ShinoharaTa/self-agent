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
