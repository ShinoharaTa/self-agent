// API が画像（か大きすぎるリクエスト）を受け付けなかったときの復旧（turn.ts）と、その判定（sdk-runner.ts の isImageRejection）
import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import type { RunResult } from "../src/agent/runner.ts";
import { isImageRejection } from "../src/agent/sdk-runner.ts";
import {
  type ChannelTurn,
  IMAGE_DROPPED_NOTE,
  RESUME_SEED_HEADER,
  runChannelTurn,
  type TurnDeps,
  withImageDroppedNote,
} from "../src/app/turn.ts";
import { createStores, tempDb } from "./helpers/db.ts";
import { FakeRunner, turnUsage } from "./helpers/runner.ts";

const NOW = new Date("2026-10-14T00:00:00.000Z");
const PROMPT = "[2026-10-14(水) 09:00 JST #領収書]\nこれを記録して";
const IMAGE = { mediaType: "image/png" as const, data: "iVBORw0KGgo=" };
const TURN: ChannelTurn = {
  guildId: "guild-1",
  channelId: "topic-1",
  kind: "session",
  prompt: PROMPT,
  allowedUrls: [],
  images: [IMAGE],
  attachmentIds: [5],
};

function ok(sessionId: string): RunResult {
  return { ok: true, text: "はい", sessionId, usage: turnUsage(1, 0, 0), durationMs: 1, toolCalls: 0, contextTokens: 1 };
}

/** API が画像を受け付けなかった失敗（result まで届き、SDK は会話を記録している） */
function rejected(sessionId: string): RunResult {
  return {
    ok: false,
    errorMessage: "success (is_error)",
    sessionId,
    sessionRecorded: true,
    toolCalls: 0,
    imageRejected: true,
  };
}

function setup(t: TestContext, results: RunResult[]) {
  const db = tempDb(t);
  const runner = new FakeRunner(results);
  const { sessions, seeds, topicSessions, memories, inboxSummaries, usage } = createStores(db, () => NOW);
  const logs: string[] = [];
  const deps: TurnDeps = {
    runner,
    sessions,
    seeds,
    topicSessions,
    inboxSummaries,
    memories,
    usage,
    log: (line) => {
      if (!line.startsWith("トークン（")) logs.push(line);
    },
  };
  topicSessions.create({ channelId: "topic-1", guildId: "guild-1", title: "領収書", categoryId: "active-1" });
  return { runner, sessions, seeds, logs, run: (turn: ChannelTurn = TURN) => runChannelTurn(deps, turn) };
}

test("isImageRejection: request_too_large・413、invalid_request_error / 400 と image の両方、画像を処理できない旨の文だけを当てる", () => {
  const hits = [
    'API Error: 413 {"type":"error","error":{"type":"request_too_large","message":"Request exceeds the maximum allowed number of bytes."}}',
    "Request too large (max 32MB)",
    'API Error: 400 {"type":"error","error":{"type":"invalid_request_error","message":"messages.0.content.1.image.source.base64: image exceeds 5 MB maximum"}}',
    'API Error: 400 {"error":{"type":"invalid_request_error","message":"Could not process image"}}',
    "Could not process image",
    "image dimensions exceed max allowed size",
  ];
  const misses = [
    'API Error: 400 {"type":"error","error":{"type":"invalid_request_error","message":"prompt is too long: 210000 tokens > 200000 maximum"}}',
    'API Error: 529 {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}',
    "No conversation found with session ID: abc",
    "error_max_turns",
    // 400 でも invalid_request_error でもない文の image は当てない
    "The imagery tool failed",
    "API Error: 4130 something",
  ];
  for (const text of hits) assert.equal(isImageRejection(text), true, text);
  for (const text of misses) assert.equal(isImageRejection(text), false, text);
});

test("withImageDroppedNote: 日時ヘッダの次に注記を入れる（本文が無ければヘッダの後ろに付ける）", () => {
  assert.equal(withImageDroppedNote(PROMPT), `[2026-10-14(水) 09:00 JST #領収書]\n${IMAGE_DROPPED_NOTE}\nこれを記録して`);
  assert.equal(withImageDroppedNote("[ヘッダ]\n"), `[ヘッダ]\n${IMAGE_DROPPED_NOTE}`);
  assert.equal(withImageDroppedNote("[ヘッダ]"), `[ヘッダ]\n${IMAGE_DROPPED_NOTE}`);
});

test("resume で画像を拒否されたら、回数を待たずに SDK セッションを捨てて seed から、画像を外し注記を付けて 1 回だけやり直す", async (t) => {
  const { runner, sessions, seeds, logs, run } = setup(t, [rejected("session-old"), ok("session-new")]);
  sessions.set("topic-1", "session-old");

  const result = await run();

  assert.ok(result.ok);
  assert.equal(runner.inputs.length, 2);
  assert.equal(runner.inputs[0]!.sessionId, "session-old");
  assert.deepEqual(runner.inputs[0]!.images, [IMAGE]);
  const retry = runner.inputs[1]!;
  assert.equal(retry.sessionId, undefined);
  assert.equal("images" in retry, false);
  assert.equal(retry.prompt, `${RESUME_SEED_HEADER}\n題名: 領収書\n\n${withImageDroppedNote(PROMPT)}`);
  // 添付の id は残す（記録への結びつけに使える）
  assert.deepEqual(retry.context?.attachmentIds, [5]);
  assert.equal(sessions.get("topic-1"), "session-new");
  assert.equal(seeds.get("topic-1"), undefined);
  assert.deepEqual(logs, ["API が画像を受け付けなかったため、SDK セッションを捨てて画像なしで 1 回だけやり直します"]);
});

test("画像の無いターンでも、resume が画像の拒否で失敗したら（会話に残った画像）すぐに捨ててやり直す。注記は付けない", async (t) => {
  const { runner, sessions, run } = setup(t, [rejected("session-old"), ok("session-new")]);
  sessions.set("topic-1", "session-old");
  const { images: _images, attachmentIds: _ids, ...textOnly } = TURN;

  const result = await run(textOnly);

  assert.ok(result.ok);
  assert.equal(runner.inputs.length, 2);
  assert.equal(runner.inputs[1]!.prompt, `${RESUME_SEED_HEADER}\n題名: 領収書\n\n${PROMPT}`);
  assert.equal(sessions.get("topic-1"), "session-new");
});

test("新しいセッションで画像を拒否されたら、画像を外して 1 回だけやり直す。やり直しも拒否されたらそこで止め、拒否された会話は残さない", async (t) => {
  const { runner, sessions, run } = setup(t, [rejected("session-a"), rejected("session-b")]);

  const result = await run();

  assert.equal(result.ok, false);
  assert.equal(runner.inputs.length, 2);
  assert.deepEqual(runner.inputs[0]!.images, [IMAGE]);
  assert.equal(runner.inputs[0]!.prompt, PROMPT);
  assert.equal("images" in runner.inputs[1]!, false);
  assert.equal(runner.inputs[1]!.prompt, withImageDroppedNote(PROMPT));
  assert.equal(sessions.get("topic-1"), undefined);
});

test("resume の失敗（記録切れ）のやり直しで画像を拒否されたら、もう 1 回だけ画像なしでやり直す（3 回で必ず止まる）", async (t) => {
  const resumeFailure: RunResult = {
    ok: false,
    errorMessage: "error_during_execution: No conversation found with session ID: session-old",
    sessionRecorded: false,
    toolCalls: 0,
  };
  const { runner, sessions, run } = setup(t, [resumeFailure, rejected("session-a"), ok("session-b")]);
  sessions.set("topic-1", "session-old");

  const result = await run();

  assert.ok(result.ok);
  assert.equal(runner.inputs.length, 3);
  assert.deepEqual(
    runner.inputs.map((input) => ["images" in input, input.sessionId]),
    [
      [true, "session-old"],
      [true, undefined],
      [false, undefined],
    ],
  );
  assert.equal(sessions.get("topic-1"), "session-b");
});

test("画像の拒否でない失敗は今までどおり（画像を外さず、やり直さない）", async (t) => {
  const failure: RunResult = { ok: false, errorMessage: "success (is_error)", sessionId: "s", sessionRecorded: true, toolCalls: 0 };
  const { runner, sessions, run } = setup(t, [failure]);

  const result = await run();

  assert.equal(result.ok, false);
  assert.equal(runner.inputs.length, 1);
  // 結果まで届いた失敗の会話は今までどおり残す
  assert.equal(sessions.get("topic-1"), "s");
});
