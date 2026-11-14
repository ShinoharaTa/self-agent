// 右腕の場所を変える確認のボタン（app/commands/move-proposal.ts。docs/plan/web-ui-v3.md §4・§6.3 の M6e）。偽の本体と偽 Responder で応答を確かめる
import { test } from "node:test";
import assert from "node:assert/strict";
import { STALE_TEXT } from "../src/app/commands/delete.ts";
import { createMoveProposalButtons, MOVE_PROPOSAL_FAILED_REPLY } from "../src/app/commands/move-proposal.ts";
import { moveRefusalText } from "../src/app/topic-move.ts";
import { type AcceptResult, type KeepResult, MOVE_NAMESPACE, moveProposalButtons, type TopicProposals } from "../src/app/topic-proposals.ts";
import type { Interaction } from "../src/discord/gateway.ts";
import { FakeResponder } from "./helpers/responder.ts";

const NOW = new Date("2026-11-14T01:00:00Z");

function press(customId: string): Extract<Interaction, { kind: "button" }> {
  return { kind: "button", customId, guildId: "guild-1", channelId: "topic-1", userId: "owner-1", createdAt: NOW, messageId: "card-1" };
}

function setup(results: { accept?: AcceptResult | Error; keep?: KeepResult | Error } = {}) {
  const calls: Array<["accept" | "keep", number]> = [];
  const logs: string[] = [];
  const proposals: Pick<TopicProposals, "accept" | "keep"> = {
    accept: async (id) => {
      calls.push(["accept", id]);
      const result = results.accept ?? { result: "accepted" };
      if (result instanceof Error) throw result;
      return result;
    },
    keep: async (id) => {
      calls.push(["keep", id]);
      const result = results.keep ?? { result: "kept" };
      if (result instanceof Error) throw result;
      return result;
    },
  };
  const component = createMoveProposalButtons({ proposals, log: (line) => logs.push(line) });
  const run = async (customId: string): Promise<FakeResponder> => {
    const responder = new FakeResponder();
    await component.handle(press(customId), responder);
    return responder;
  };
  return { component, calls, logs, run };
}

test("move proposal: 名前空間は move で、確認の 1 通のボタン（move:ok・move:keep）を受ける", async () => {
  const s = setup();
  assert.equal(s.component.namespace, MOVE_NAMESPACE);
  const row = moveProposalButtons(42)?.[0];
  assert.ok(row?.kind === "buttons");
  for (const button of row.buttons) await s.run(button.customId);
  assert.deepEqual(s.calls, [
    ["accept", 42],
    ["keep", 42],
  ]);
});

test("move proposal: move:ok:<id> で accept が呼ばれ、accepted なら応答は deferUpdate だけ", async () => {
  const s = setup();
  const responder = await s.run("move:ok:7");
  assert.deepEqual(s.calls, [["accept", 7]]);
  assert.deepEqual(responder.calls, [{ method: "deferUpdate" }]);
});

test("move proposal: move:keep:<id> で keep が呼ばれ、kept なら応答は deferUpdate だけ", async () => {
  const s = setup();
  const responder = await s.run("move:keep:7");
  assert.deepEqual(s.calls, [["keep", 7]]);
  assert.deepEqual(responder.calls, [{ method: "deferUpdate" }]);
});

test("move proposal: stale のとき、押した投稿が STALE_TEXT になりボタンが消える（[変える]・[このまま] とも）", async () => {
  const s = setup({ accept: { result: "stale" }, keep: { result: "stale" } });
  for (const customId of ["move:ok:7", "move:keep:7"]) {
    const responder = await s.run(customId);
    assert.deepEqual(responder.calls, [{ method: "deferUpdate" }, { method: "update", message: { text: STALE_TEXT, components: [] } }], customId);
  }
});

test("move proposal: 実行中で断られたとき（kept が true）、その人だけに断りの文が出て、札は書き換えない", async () => {
  const s = setup({ accept: { result: "refused", reason: "busy", kept: true } });
  const responder = await s.run("move:ok:7");
  assert.deepEqual(responder.calls, [{ method: "deferUpdate" }, { method: "reply", message: { text: moveRefusalText("busy"), ephemeral: true } }]);
  assert.equal(
    responder.calls.some((call) => call.method === "update"),
    false,
  );
});

test("move proposal: 待っても通らない断り（kept が false）は deferUpdate だけ（札は本体が断りの文に書き換える）", async () => {
  const s = setup({ accept: { result: "refused", reason: "same_place", kept: false } });
  const responder = await s.run("move:ok:7");
  assert.deepEqual(responder.calls, [{ method: "deferUpdate" }]);
});

test("move proposal: custom_id の形が違う（id が数字でない・部分が足りない・多い・知らない操作・11 桁）とき、本体を呼ばず STALE_TEXT にする", async () => {
  const s = setup();
  for (const customId of ["move:ok:abc", "move:ok", "move:ok:", "move", "move:ok:7:8", "move:go:7", "move:keep:-1", "move:ok:12345678901"]) {
    const responder = await s.run(customId);
    assert.deepEqual(responder.calls, [{ method: "update", message: { text: STALE_TEXT, components: [] } }], customId);
  }
  assert.deepEqual(s.calls, []);
});

test("move proposal: 本体が例外を出しても投げず、その人だけに失敗の文。log は例外の名前だけで ID が出ない", async () => {
  const s = setup({ accept: new TypeError("edit failed topic-1 card-1 7"), keep: new RangeError("boom 9") });
  const accepted = await s.run("move:ok:7");
  assert.deepEqual(accepted.calls, [{ method: "deferUpdate" }, { method: "reply", message: { text: MOVE_PROPOSAL_FAILED_REPLY, ephemeral: true } }]);
  const kept = await s.run("move:keep:9");
  assert.deepEqual(kept.replies, [{ text: MOVE_PROPOSAL_FAILED_REPLY, ephemeral: true }]);
  assert.equal(s.logs.length, 2);
  assert.ok(s.logs[0]!.includes("TypeError"));
  for (const line of s.logs) {
    for (const secret of ["topic-1", "card-1", "7", "9", "edit failed", "boom"]) assert.equal(line.includes(secret), false, line);
  }

  // 失敗の文の応答まで失敗しても投げない
  const responder = new FakeResponder();
  responder.beforeReply = () => {
    throw new Error("Unknown interaction");
  };
  await s.component.handle(press("move:ok:7"), responder);
  assert.equal(s.logs.length, 4);
});
