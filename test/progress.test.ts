import { test } from "node:test";
import assert from "node:assert/strict";
import type { OutgoingMessage } from "../src/discord/gateway.ts";
import { PROGRESS_INTERVAL_MS, type ProgressTimers, startProgress } from "../src/app/progress.ts";

/** 書き換えの列を進める */
async function flush(): Promise<void> {
  for (let i = 0; i < 5; i++) await Promise.resolve();
}

/** 呼ばれたタイマーを覚えておき、run で手で呼ぶ */
class ManualTimers implements ProgressTimers {
  afters: Array<{ fn: () => void; ms: number; cancelled: boolean }> = [];
  everys: Array<{ fn: () => void; ms: number; stopped: boolean }> = [];
  after(fn: () => void, ms: number): () => void {
    const timer = { fn, ms, cancelled: false };
    this.afters.push(timer);
    return () => {
      timer.cancelled = true;
    };
  }
  every(fn: () => void, ms: number): () => void {
    const timer = { fn, ms, stopped: false };
    this.everys.push(timer);
    return () => {
      timer.stopped = true;
    };
  }
}

test("startProgress: messageId があれば最初の 1 通は送らずにそれを書き換え（遅れ 0）、終わり方に書き換えてボタンを外す", async () => {
  const timers = new ManualTimers();
  const sent: OutgoingMessage[] = [];
  const edits: Array<{ messageId: string; message: OutgoingMessage }> = [];
  let now = 0;
  const progress = startProgress({
    send: async (message) => {
      sent.push(message);
      return "new";
    },
    edit: async (messageId, message) => {
      edits.push({ messageId, message });
    },
    messageId: "queued-1",
    buttons: [{ customId: "job:abort:1", label: "中断" }],
    delayMs: 0,
    now: () => new Date(now),
    timers,
    log: () => {},
  });
  assert.equal(timers.afters[0]!.ms, 0);
  timers.afters[0]!.fn();
  await flush();
  progress.onProgress({ label: "読んでいます" });
  now = 12_000;
  assert.equal(timers.everys[0]!.ms, PROGRESS_INTERVAL_MS);
  timers.everys[0]!.fn();
  await flush();
  await progress.finish("done");

  assert.deepEqual(sent, []);
  assert.deepEqual(edits, [
    {
      messageId: "queued-1",
      message: { text: "作業中…（0 分 0 秒・ツール 0 回）", components: [{ kind: "buttons", buttons: [{ customId: "job:abort:1", label: "中断" }] }] },
    },
    { messageId: "queued-1", message: { text: "作業中…（0 分 12 秒・ツール 1 回）\n読んでいます" } },
    { messageId: "queued-1", message: { text: "完了（0 分 12 秒・ツール 1 回）", components: [] } },
  ]);
  assert.equal(timers.everys[0]!.stopped, true);
});

test("startProgress: messageId があれば、最初の表示の前に終わっても終わり方に書き換える。無ければ何も送らない", async () => {
  const withId: string[] = [];
  const early = startProgress({
    send: async () => assert.fail("想定外の呼び出し"),
    edit: async (_messageId, message) => {
      withId.push(message.text);
    },
    messageId: "queued-1",
    buttons: [],
    delayMs: 0,
    now: () => new Date(0),
    timers: new ManualTimers(),
    log: () => {},
  });
  await early.finish("failed");
  assert.deepEqual(withId, ["止まりました（0 分 0 秒・ツール 0 回）"]);

  const none = startProgress({
    send: async () => assert.fail("想定外の呼び出し"),
    edit: async () => assert.fail("想定外の呼び出し"),
    buttons: [],
    delayMs: 20_000,
    now: () => new Date(0),
    timers: new ManualTimers(),
    log: () => {},
  });
  await none.finish("done");
});
