import { test } from "node:test";
import assert from "node:assert/strict";
import type { MoveTarget } from "../src/app/channel-ops.ts";
import { applySessionEvent, type SessionEvent, transition, type Transition } from "../src/app/session-state.ts";
import type { TopicSessionState } from "../src/store/topic-sessions.ts";

const STATES: readonly TopicSessionState[] = ["active", "waiting", "done", "deleted"];
const EVENTS: readonly SessionEvent[] = ["message", "wait", "continue", "idle", "close"];

/** 遷移表（状態 × きっかけの全組み合わせ） */
const TABLE: Record<TopicSessionState, Record<SessionEvent, Transition>> = {
  active: {
    message: { next: "active", move: null },
    wait: { next: "waiting", move: "waiting" },
    continue: { next: "active", move: null },
    idle: { next: "waiting", move: "waiting" },
    close: { next: "done", move: null },
  },
  waiting: {
    message: { next: "active", move: "active" },
    wait: { next: "waiting", move: null },
    continue: { next: "active", move: "active" },
    idle: { next: "waiting", move: null },
    close: { next: "done", move: null },
  },
  done: {
    message: { next: "active", move: "active" },
    wait: { next: "done", move: null },
    continue: { next: "active", move: "active" },
    idle: { next: "done", move: null },
    close: { next: "done", move: null },
  },
  deleted: {
    message: { next: "deleted", move: null },
    wait: { next: "deleted", move: null },
    continue: { next: "deleted", move: null },
    idle: { next: "deleted", move: null },
    close: { next: "deleted", move: null },
  },
};

test("transition: 全組み合わせが遷移表どおり", () => {
  for (const state of STATES) {
    for (const event of EVENTS) {
      assert.deepEqual(transition(state, event), TABLE[state][event], `${state} + ${event}`);
    }
  }
});

class RecordingStore {
  calls: string[] = [];

  setActive(channelId: string): undefined {
    this.calls.push(`setActive ${channelId}`);
    return undefined;
  }
  setWaiting(channelId: string): undefined {
    this.calls.push(`setWaiting ${channelId}`);
    return undefined;
  }
}

class RecordingChannelOps {
  moves: Array<{ channelId: string; target: MoveTarget }> = [];

  enqueueMove(channelId: string, target: MoveTarget): void {
    this.moves.push({ channelId, target });
  }
}

test("applySessionEvent: 状態が変わるときだけ DB を更新し、移動を列に入れる", () => {
  const events: ReadonlyArray<Exclude<SessionEvent, "close">> = ["message", "wait", "continue", "idle"];
  for (const state of STATES) {
    for (const event of events) {
      const topicSessions = new RecordingStore();
      const channelOps = new RecordingChannelOps();

      const result = applySessionEvent({ channelId: "topic-1", guildId: "guild-1", state }, event, {
        topicSessions,
        channelOps,
      });

      const expected = TABLE[state][event];
      const label = `${state} + ${event}`;
      assert.deepEqual(result, expected, label);
      if (expected.next === state) {
        assert.deepEqual(topicSessions.calls, [], label);
        assert.deepEqual(channelOps.moves, [], label);
        continue;
      }
      assert.deepEqual(
        topicSessions.calls,
        [expected.next === "active" ? "setActive topic-1" : "setWaiting topic-1"],
        label,
      );
      assert.deepEqual(
        channelOps.moves,
        [{ channelId: "topic-1", target: { kind: "state", guildId: "guild-1", state: expected.move } }],
        label,
      );
    }
  }
});
