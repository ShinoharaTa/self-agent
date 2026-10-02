import { test } from "node:test";
import assert from "node:assert/strict";
import { splitMessage } from "../src/discord/split.ts";

const lengths = (chunks: string[]): number[] => chunks.map((chunk) => chunk.length);

test("上限以内ならそのまま 1 つ", () => {
  assert.deepEqual(splitMessage("hello"), ["hello"]);
  assert.deepEqual(lengths(splitMessage("a".repeat(2000))), [2000]);
});

test("上限内の最後の改行で切り、その改行は落とす", () => {
  const text = `${"a".repeat(1500)}\n${"b".repeat(1000)}\n${"c".repeat(100)}`;
  const chunks = splitMessage(text);
  assert.deepEqual(chunks, ["a".repeat(1500), `${"b".repeat(1000)}\n${"c".repeat(100)}`]);
});

test("改行が無ければ 2000 文字で切る", () => {
  const text = "a".repeat(4500);
  const chunks = splitMessage(text);
  assert.deepEqual(lengths(chunks), [2000, 2000, 500]);
  assert.equal(chunks.join(""), text);
});

test("サロゲートペアの途中では切らない", () => {
  const text = `${"a".repeat(1999)}😀b`;
  const chunks = splitMessage(text);
  assert.deepEqual(lengths(chunks), [1999, 3]);
  assert.equal(chunks[1], "😀b");
  assert.equal(chunks.join(""), text);
});

test("空文字なら何も返さない", () => {
  assert.deepEqual(splitMessage(""), []);
});

test("空白だけの塊は除く", () => {
  assert.deepEqual(splitMessage(" \n\t "), []);
  const text = `${"a".repeat(1990)}\n${" ".repeat(1000)}`;
  assert.deepEqual(splitMessage(text), ["a".repeat(1990)]);
});
