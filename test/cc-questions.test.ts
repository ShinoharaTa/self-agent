import { test } from "node:test";
import assert from "node:assert/strict";
import {
  type CcQuestion,
  normalizeOther,
  parsePicks,
  parseQuestionInput,
  parseQuestions,
  parseStoredAnswers,
  questionSummary,
  validateAnswers,
} from "../src/cc/questions.ts";
import { permissionResolvedMessage, questionModalTitle, questionNotice, questionResolvedMessage } from "../src/cc/notice-text.ts";
import type { OutgoingMessage } from "../src/discord/gateway.ts";
import type { CcPermissionRow } from "../src/store/cc-permissions.ts";

const option = (label: string, description?: string) => (description === undefined ? { label } : { label, description });
const one = (overrides: Record<string, unknown> = {}) => ({ question: "色は？", header: "Color", options: [option("red", "赤"), option("blue")], multiSelect: false, ...overrides });

test("parseQuestions: 1〜4 問・各 2〜8 択の形だけを通し、header・description・multiSelect の省略は空・false に", () => {
  assert.deepEqual(parseQuestions({ questions: [{ question: "q", options: [option("a"), option("b")] }] }), [
    { question: "q", header: "", options: [{ label: "a", description: "" }, { label: "b", description: "" }], multiSelect: false },
  ]);
  assert.equal(parseQuestions({ questions: [one(), one({ question: "2" }), one({ question: "3" }), one({ question: "4" })] })?.length, 4);
  const eight = Array.from({ length: 8 }, (_, i) => option(`o${i}`));
  assert.equal(parseQuestions({ questions: [one({ options: eight })] })?.[0]?.options.length, 8);
  // 合わない形
  const bad: unknown[] = [
    undefined,
    null,
    [],
    { questions: [] },
    { questions: "x" },
    { questions: [one(), one({ question: "2" }), one({ question: "3" }), one({ question: "4" }), one({ question: "5" })] },
    { questions: [one({ options: [option("a")] })] },
    { questions: [one({ options: [...eight, option("o8")] })] },
    { questions: [one({ question: "" })] },
    { questions: [one({ question: "   " })] },
    { questions: [one({ question: 1 })] },
    { questions: [one({ question: "x".repeat(2001) })] },
    { questions: [one({ header: 1 })] },
    { questions: [one({ header: "h".repeat(101) })] },
    { questions: [one({ multiSelect: "yes" })] },
    { questions: [one({ options: [option(""), option("b")] })] },
    { questions: [one({ options: [option(" "), option("b")] })] },
    { questions: [one({ options: [option("a"), option("a")] })] },
    { questions: [one({ options: [{ label: 1 }, option("b")] })] },
    { questions: [one({ options: [option("a", "d".repeat(1001)), option("b")] })] },
    { questions: [one({ options: [option("l".repeat(201)), option("b")] })] },
    // answers のキーは問の文なので、同じ文の問は読めない
    { questions: [one(), one()] },
  ];
  for (const input of bad) assert.equal(parseQuestions(input), undefined, JSON.stringify(input));
});

test("parseQuestionInput: 行の JSON を読み、元の input と問を返す。NULL・JSON でない・形が違えば undefined", () => {
  const input = { questions: [one()], extra: 1 };
  const parsed = parseQuestionInput(JSON.stringify(input))!;
  assert.deepEqual(parsed.input, input);
  assert.equal(parsed.questions[0]!.question, "色は？");
  assert.equal(parseQuestionInput(null), undefined);
  assert.equal(parseQuestionInput("{"), undefined);
  assert.equal(parseQuestionInput("[]"), undefined);
  assert.equal(parseQuestionInput('{"questions":[]}'), undefined);
});

test("questionSummary: 「質問 n 問: <最初の問の先頭 100 字>」", () => {
  const questions = parseQuestions({ questions: [one({ question: "あ".repeat(120) }), one({ question: "2" })] })!;
  assert.equal(questionSummary(questions), `質問 2 問: ${"あ".repeat(100)}`);
});

test("validateAnswers: 1 つ選ぶ・複数選択（選択肢の順に \", \"）・その他。数・無い label・重なり・1 つの問に 2 つは undefined", () => {
  const questions: CcQuestion[] = parseQuestions({
    questions: [one(), { question: "部品は？", options: [option("a"), option("b"), option("c")], multiSelect: true }],
  })!;
  assert.deepEqual(validateAnswers(questions, [{ labels: ["blue"] }, { labels: ["c", "a"] }]), { "色は？": "blue", "部品は？": "a, c" });
  assert.deepEqual(validateAnswers(questions, [{ other: " 緑 " }, { labels: ["b"] }]), { "色は？": "緑", "部品は？": "b" });
  assert.deepEqual(validateAnswers(questions, [{ labels: ["red"] }, { other: "全部" }]), { "色は？": "red", "部品は？": "全部" });
  assert.equal(validateAnswers(questions, [{ labels: ["red"] }]), undefined);
  assert.equal(validateAnswers(questions, [{ labels: ["red"] }, { labels: ["a"] }, { labels: ["a"] }]), undefined);
  assert.equal(validateAnswers(questions, [{ labels: [] }, { labels: ["a"] }]), undefined);
  assert.equal(validateAnswers(questions, [{ labels: ["red", "blue"] }, { labels: ["a"] }]), undefined);
  assert.equal(validateAnswers(questions, [{ labels: ["green"] }, { labels: ["a"] }]), undefined);
  assert.equal(validateAnswers(questions, [{ labels: ["red"] }, { labels: ["a", "a"] }]), undefined);
  assert.equal(validateAnswers(questions, [{ other: "" }, { labels: ["a"] }]), undefined);
});

test("normalizeOther: 改行以外の制御文字は空白・前後の空白を除いて 1〜1,000 字", () => {
  assert.equal(normalizeOther("\ta\u0007b\nc "), "a b\nc");
  assert.equal(normalizeOther("x".repeat(1000)), "x".repeat(1000));
  assert.equal(normalizeOther("x".repeat(1001)), undefined);
  assert.equal(normalizeOther(" \t "), undefined);
});

test("parsePicks: 各要素がちょうど labels（文字列の配列）か other（文字列）の 1 つ", () => {
  assert.deepEqual(parsePicks([{ labels: ["a"] }, { other: "x" }]), [{ labels: ["a"] }, { other: "x" }]);
  const bad: unknown[] = [
    undefined,
    {},
    [],
    [{}],
    [{ labels: "a" }],
    [{ labels: [1] }],
    [{ other: 1 }],
    [{ labels: ["a"], other: "x" }],
    [{ label: ["a"] }],
    [null],
    [{ labels: ["a"] }, { labels: ["a"] }, { labels: ["a"] }, { labels: ["a"] }, { labels: ["a"] }],
  ];
  for (const value of bad) assert.equal(parsePicks(value), undefined, JSON.stringify(value));
});

test("parseStoredAnswers: 文字列の値のオブジェクトだけ", () => {
  assert.deepEqual(parseStoredAnswers('{"q":"a"}'), { q: "a" });
  assert.equal(parseStoredAnswers(null), null);
  assert.equal(parseStoredAnswers('{"q":1}'), null);
  assert.equal(parseStoredAnswers("[]"), null);
  assert.equal(parseStoredAnswers("{"), null);
});

// ---- Q2: Discord の 1 通（notice-text.ts。docs/plan/claude-code-questions.md §3.2） ----

const PLACES = { workspaceDir: "/home/owner/workspace", home: "/home/owner" };
const SESSION = { name: "@everyone **name**", cwd: "/home/owner/workspace/proj", bridgeSessionId: "session_01ABC" };
const ROW = { id: 12345, permissionMode: "default" };

function shape(message: OutgoingMessage): void {
  const rows = message.components ?? [];
  assert.ok(rows.length <= 5, `行が ${rows.length}`);
  for (const row of rows) {
    if (row.kind === "buttons") {
      assert.ok(row.buttons.length <= 5);
      for (const button of row.buttons) {
        assert.ok(button.label.length <= 80, button.label);
        assert.ok(button.customId.length <= 100);
      }
    }
    if (row.kind === "select") {
      assert.ok(row.select.options.length <= 25);
      for (const item of row.select.options) {
        assert.ok(item.label.length <= 100);
        assert.ok((item.description ?? "").length <= 100);
      }
    }
  }
  const mention = message.mentionUserId === undefined ? 0 : `<@${message.mentionUserId}> `.length;
  assert.ok([...message.text].length + mention <= 2000, `${[...message.text].length}`);
}

test("questionNotice: 1 問目・2 問目（答えた問は上に 1 行ずつ）・見出しとボタンの効く時間。名前・問・選択肢はエスケープする", () => {
  const questions = parseQuestions({
    questions: [
      { question: "**色**は？ @here", header: "Co_lor", options: [{ label: "<@1> red", description: "赤 `x`" }, { label: "blue" }] },
      { question: "形は？", header: "", options: [{ label: "丸" }, { label: "角" }] },
    ],
  })!;
  const first = questionNotice(ROW, questions, [], SESSION, { ...PLACES, holdSec: 900, ownerUserId: "owner-1" });
  assert.equal(
    first.text,
    [
      "Claude Code が質問しています（2 問）: \\@everyone \\*\\*name\\*\\*（proj・default）",
      "質問 1/2「Co\\_lor」",
      "\\*\\*色\\*\\*は？ \\@here",
      "1. \\<\\@1\\> red — 赤 \\`x\\`",
      "2. blue",
      "端末や RC のダイアログでも答えられます（ボタンは 15 分効きます）",
    ].join("\n"),
  );
  assert.equal(first.mentionUserId, "owner-1");
  // ボタンの label はエスケープしない（Markdown として出ない）
  assert.deepEqual(
    first.components?.map((row) => (row.kind === "buttons" ? row.buttons.map((button) => button.label) : row.kind)),
    [["1. <@1> red", "2. blue", "その他"], ["やめる"], "links"],
  );
  shape(first);
  const second = questionNotice(ROW, questions, [{ labels: ["<@1> red"] }], SESSION, { ...PLACES, holdSec: 300 });
  assert.ok(second.text.includes("\n答え済み:\n1. 「Co\\_lor」\\<\\@1\\> red\n質問 2/2\n形は？\n1. 丸\n2. 角\n"), second.text);
  assert.ok(second.text.endsWith("（ボタンは 5 分効きます）"));
  assert.equal(second.components?.[0]?.kind, "buttons");
  assert.ok(second.components?.[0]?.kind === "buttons" && second.components[0].buttons[0]!.customId === "cc:q:pick:12345:1:0");
});

test("questionNotice: 長い問・説明・label でも 2,000 字・5 行・1 行 5 つ・label 80 字に収まる。5 択以上と複数選択はセレクト", () => {
  const long = (n: number, c = "あ") => c.repeat(n);
  const eight = Array.from({ length: 8 }, (_, i) => ({ label: `${i}${long(199, "*")}`, description: long(1000, "_") }));
  const questions = parseQuestions({
    questions: [
      { question: `1${long(1999, "#")}`, header: long(100, "h"), options: eight },
      { question: `2${long(1999)}`, header: long(100), options: eight.slice(0, 4), multiSelect: true },
      { question: `3${long(1999)}`, header: long(100), options: eight.slice(0, 4) },
      { question: `4${long(1999)}`, header: long(100), options: eight.slice(0, 4) },
    ],
  })!;
  assert.equal(questions.length, 4);
  const picks = [{ other: long(1000, "@") }, { labels: eight.slice(0, 4).map((o) => o.label) }, { labels: [eight[0]!.label] }];
  for (let step = 0; step < 4; step++) {
    const message = questionNotice(ROW, questions, picks.slice(0, step), SESSION, { ...PLACES, holdSec: 900, ownerUserId: "owner-1" });
    shape(message);
    assert.ok(message.text.endsWith("（ボタンは 15 分効きます）"), `step ${step}`);
  }
  const select = questionNotice(ROW, questions, [], SESSION, { ...PLACES, holdSec: 900 });
  const row = select.components?.[0];
  assert.ok(row?.kind === "select");
  assert.deepEqual([row.select.customId, row.select.minValues, row.select.maxValues, row.select.options.length], ["cc:q:sel:12345:0", 1, 1, 8]);
  assert.deepEqual(row.select.options.map((item) => item.value), ["0", "1", "2", "3", "4", "5", "6", "7"]);
  assert.ok(select.components?.[1]?.kind === "buttons");
  assert.deepEqual(select.components[1].buttons.map((button) => button.customId), ["cc:q:ok:12345:0", "cc:q:other:12345:0", "cc:q:drop:12345"]);
  const multi = questionNotice(ROW, questions, picks.slice(0, 1), SESSION, { ...PLACES, holdSec: 900 });
  assert.ok(multi.components?.[0]?.kind === "select" && multi.components[0].select.maxValues === 4);
  assert.ok(multi.text.includes("いくつでも選べます"));
  // RC の id が無ければリンクの行は無い
  assert.equal(questionNotice(ROW, questions, [], undefined, { ...PLACES, holdSec: 900 }).components?.length, 2);
});

test("questionResolvedMessage・questionModalTitle: 答え・答えなかった・時間切れ。ボタンは外し [RC で開く] は残す", () => {
  const questions = parseQuestions({ questions: [{ question: "色は？", header: "Color", options: [{ label: "red" }, { label: "blue" }] }] })!;
  const base = {
    id: 7,
    sessionId: "s",
    requestHash: "h",
    toolName: "AskUserQuestion",
    summary: "質問 1 問: 色は？",
    permissionMode: null,
    createdAt: "2026-11-05T00:00:00.000Z",
    resolvedAt: null,
    alwaysRules: null,
    messageId: "m",
    messageChannelId: "c",
    questionInput: JSON.stringify({ questions }),
    answers: null,
  } as CcPermissionRow;
  const answered = questionResolvedMessage({ ...base, state: "allowed", via: "web", answers: { "色は？": "blue" } }, questions, SESSION, PLACES);
  assert.equal(answered.text, "Claude Code が質問しています（1 問）: \\@everyone \\*\\*name\\*\\*（proj）\n答えました（Web）:\n1. 「Color」blue");
  assert.deepEqual(answered.components, [{ kind: "links", links: [{ label: "RC で開く", url: "https://claude.ai/code/session_01ABC" }] }]);
  assert.ok(questionResolvedMessage({ ...base, state: "denied", via: "discord" }, questions, SESSION, PLACES).text.endsWith("\n答えませんでした（Discord）"));
  assert.ok(
    questionResolvedMessage({ ...base, state: "expired", via: null }, questions, SESSION, PLACES).text.endsWith(
      "\n時間切れ。端末か RC で答えてください <https://claude.ai/code/session_01ABC>",
    ),
  );
  assert.deepEqual(questionResolvedMessage({ ...base, state: "answered_elsewhere", via: "hook" }, questions, undefined, PLACES).components, []);
  // permissionResolvedMessage も質問の行なら同じ
  assert.equal(permissionResolvedMessage({ ...base, state: "allowed", via: "web", answers: { "色は？": "blue" } }, SESSION, PLACES).text, answered.text);
  assert.equal(questionModalTitle(questions[0]!), "その他（Color）");
  assert.equal(questionModalTitle({ ...questions[0]!, header: "" }), "その他");
  assert.ok([...questionModalTitle({ ...questions[0]!, header: "x".repeat(100) })].length <= 45);
});
