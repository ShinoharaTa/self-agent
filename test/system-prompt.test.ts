import { test } from "node:test";
import assert from "node:assert/strict";
import { buildSystemPrompt, personaSystemPrompts, SYSTEM_PROMPT } from "../src/agent/system-prompt.ts";

/** SYSTEM_PROMPT の最初の段落（1 行目）の後ろ */
const COMMON = SYSTEM_PROMPT.slice(SYSTEM_PROMPT.indexOf("\n"));

test("既定の人格のシステムプロンプトは SYSTEM_PROMPT と 1 バイトも違わない（プロンプトキャッシュ）", () => {
  assert.equal(buildSystemPrompt(), SYSTEM_PROMPT);
  assert.equal(Buffer.compare(Buffer.from(buildSystemPrompt()), Buffer.from(SYSTEM_PROMPT)), 0);
  assert.equal(personaSystemPrompts([]).get("default"), SYSTEM_PROMPT);
  assert.deepEqual([...personaSystemPrompts([]).keys()], ["default"]);
});

test("足した人格のシステムプロンプトは、最初の段落を人格の文（前後の空白を除く）に置き換え、残りは SYSTEM_PROMPT と同じ", () => {
  assert.ok(SYSTEM_PROMPT.startsWith("あなたは self-agent。"));
  assert.ok(COMMON.startsWith("\n\n各発言の先頭には"));

  const cases = [
    { label: "1 行", text: "あなたはアオイ。落ち着いた口調で話します。", head: "あなたはアオイ。落ち着いた口調で話します。" },
    { label: "前後の空白と改行", text: "\n  あなたはアオイ。\n\n役割: 調べもの。\n\n", head: "あなたはアオイ。\n\n役割: 調べもの。" },
  ];
  for (const { label, text, head } of cases) {
    const prompt = buildSystemPrompt(text);
    assert.equal(prompt, head + COMMON, label);
    assert.ok(!prompt.includes("あなたは self-agent。"), label);
  }
  assert.throws(() => buildSystemPrompt(" \n "), /人格の文が空/);
});

test("personaSystemPrompts: 人格の文のファイルを 1 回ずつ読み、id ごとに組み立てる。読めない・空なら変数名だけを出してエラー", () => {
  const files: Record<string, string> = { "/p/aoi.md": "あなたはアオイ。\n", "/p/kai.md": "あなたはカイ。" };
  const reads: string[] = [];
  const read = (path: string): string => {
    reads.push(path);
    const text = files[path];
    if (text === undefined) throw new Error(`ENOENT: ${path}`);
    return text;
  };
  const prompts = personaSystemPrompts(
    [
      { id: "aoi", promptFile: "/p/aoi.md" },
      { id: "kai", promptFile: "/p/kai.md" },
    ],
    read,
  );
  assert.deepEqual(reads, ["/p/aoi.md", "/p/kai.md"]);
  assert.deepEqual([...prompts.keys()], ["default", "aoi", "kai"]);
  assert.equal(prompts.get("default"), SYSTEM_PROMPT);
  assert.equal(prompts.get("aoi"), `あなたはアオイ。${COMMON}`);
  assert.equal(prompts.get("kai"), `あなたはカイ。${COMMON}`);

  for (const { label, promptFile, error } of [
    { label: "無いファイル", promptFile: "/p/none.md", error: /SELF_AGENT_PERSONA_AOI_PROMPT_FILE のファイルを読めません$/ },
    { label: "空のファイル", promptFile: "/p/empty.md", error: /SELF_AGENT_PERSONA_AOI_PROMPT_FILE のファイルが空です$/ },
  ]) {
    files["/p/empty.md"] = " \n";
    assert.throws(() => personaSystemPrompts([{ id: "aoi", promptFile }], read), error, label);
  }
});
