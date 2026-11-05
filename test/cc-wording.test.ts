import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// Claude Code への送信のサーバー側の文（Discord・#system・Web に出す）の語彙（docs/design/WEB-UI-GUIDELINES.md §7。#232）。
// test/web-static.test.ts の「画面の言葉」と同じ決まりで、コメントと log の呼び出しを除いた文字列を見る。
// 「取り消す」は undo だけに使う語なので、届け待ちを取り下げる文にも使わない
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

/**
 * log(…)・log?.(…) の呼び出しを、`log(` から対応する `)` まで除く（複数行にまたがるものも）。
 * 括弧は文字列の中も数える（log の文に釣り合わない括弧は無い前提）。テンプレートの `${…}` の入れ子は見ない
 */
function stripLogCalls(code: string): string {
  let out = "";
  let pos = 0;
  const start = /\blog\??\.?\(/g;
  for (let m = start.exec(code); m !== null; m = start.exec(code)) {
    out += code.slice(pos, m.index);
    let depth = 0;
    let i = m.index + m[0].length - 1;
    for (; i < code.length; i++) {
      if (code[i] === "(") depth++;
      else if (code[i] === ")" && --depth === 0) break;
    }
    pos = i + 1;
    start.lastIndex = pos;
  }
  return out + code.slice(pos);
}

/** "…"・`…` の文字列（コメントと log の呼び出しを除いてから拾う。https:// の // はコメントとみなさない） */
function stringLiterals(ts: string): string[] {
  const code = stripLogCalls(ts.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'\\])\/\/.*$/gm, "$1"));
  return [...code.matchAll(/(["`])((?:[^"`\\\n]|\\.)*)\1/g)].map((m) => m[2] ?? "");
}

test("Claude Code への送信の文に語彙の表で使わない語（送信・キャンセル・送信待ち・取り消す）が無い", () => {
  for (const file of FILES) {
    const texts = stringLiterals(readFileSync(new URL(`../${file}`, import.meta.url), "utf8"));
    assert.ok(texts.length > 0, file);
    for (const text of texts) assert.doesNotMatch(text, /送信|キャンセル|取り消/, `${file}: ${text}`);
  }
});
