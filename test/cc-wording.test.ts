import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// Claude Code への送信のサーバー側の文（Discord・#system・Web に出す）の語彙（docs/design/WEB-UI-GUIDELINES.md §7。#232）。
// test/web-static.test.ts の「画面の言葉」と同じ決まりで、コメントと log の行を除いた文字列を見る
const FILES = [
  "src/app/github-handoff.ts",
  "src/app/commands/cc-confirm.ts",
  "src/app/commands/cc.ts",
  "src/app/commands/github.ts",
  "src/cc/discord-notice.ts",
  "src/cc/replies.ts",
  "src/cc/channels.ts",
  "src/cc/channel-posts.ts",
  "src/app/cc-tools.ts",
];

/** "…"・`…` の文字列（コメントと log( の行を除いてから拾う。https:// の // はコメントとみなさない） */
function stringLiterals(ts: string): string[] {
  const code = ts
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:"'\\])\/\/.*$/gm, "$1")
    .split("\n")
    .filter((line) => !/\blog\??\.?\(/.test(line))
    .join("\n");
  return [...code.matchAll(/(["`])((?:[^"`\\\n]|\\.)*)\1/g)].map((m) => m[2] ?? "");
}

test("Claude Code への送信の文に語彙の表で使わない語（送信・キャンセル・送信待ち）が無い", () => {
  for (const file of FILES) {
    const texts = stringLiterals(readFileSync(new URL(`../${file}`, import.meta.url), "utf8"));
    assert.ok(texts.length > 0, file);
    for (const text of texts) assert.doesNotMatch(text, /送信|キャンセル/, `${file}: ${text}`);
  }
});
