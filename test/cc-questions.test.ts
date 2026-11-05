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

test("validateAnswers: 問の文が __proto__ でも答えのキーとして残り、JSON に出る", () => {
  const questions = parseQuestions({ questions: [{ question: "__proto__", options: [option("a"), option("b")] }] })!;
  const answers = validateAnswers(questions, [{ labels: ["b"] }])!;
  assert.equal(JSON.stringify(answers), '{"__proto__":"b"}');
  assert.deepEqual(Object.keys(answers), ["__proto__"]);
});
