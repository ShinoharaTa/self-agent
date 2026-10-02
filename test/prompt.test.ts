import { test } from "node:test";
import assert from "node:assert/strict";
import { buildTurnPrompt } from "../src/app/prompt.ts";

test("先頭に日時ヘッダを 1 行付ける", () => {
  const at = new Date("2026-10-02T00:12:00Z");
  assert.equal(
    buildTurnPrompt("明日買い物に行く", at, "Asia/Tokyo"),
    "[2026-10-02(金) 09:12 JST #inbox]\n明日買い物に行く",
  );
});

test("タイムゾーンで日付と曜日が変わる", () => {
  const at = new Date("2026-10-03T14:59:00Z");
  assert.equal(buildTurnPrompt("x", at, "Asia/Tokyo"), "[2026-10-03(土) 23:59 JST #inbox]\nx");
  const nextDay = new Date("2026-10-03T15:00:00Z");
  assert.equal(buildTurnPrompt("x", nextDay, "Asia/Tokyo"), "[2026-10-04(日) 00:00 JST #inbox]\nx");
});

test("チャンネル名を指定できる", () => {
  const at = new Date("2026-10-02T00:12:00Z");
  assert.equal(buildTurnPrompt("x", at, "Asia/Tokyo", "general"), "[2026-10-02(金) 09:12 JST #general]\nx");
});
