// Claude Code の質問（AskUserQuestion）の形と答え（docs/plan/claude-code-questions.md §2。Q1）。純関数だけ。
// AskUserQuestion は PermissionRequest の hook として届き、tool_input は { questions: [{ question, header, options: [{ label, description }], multiSelect }] }。
// 答えは allow + updatedInput（tool_input そのまま + answers）で返す。answers は question の文（そのまま）をキーに、選んだ label を値にする
// （複数選択は選択肢の順に ", " でつなぐ。「その他」は打った文字列）。questions・label は DB の行（question_input）から作り、
// 画面・ボタンからは問ごとの選んだ label か「その他」の文字列だけを受ける（§7 の 2）
import { headChars } from "../store/cc-sessions.ts";

/** AskUserQuestion の tool_name（受け口が読む固定の語） */
export const CC_QUESTION_TOOL = "AskUserQuestion";
/** question_input（tool_input の JSON そのまま）を持つ上限（バイト。これを超えれば持たず、今までどおりの許可の要求として扱う） */
export const CC_QUESTION_INPUT_MAX_BYTES = 32 * 1024;
/** 受ける問の数・1 問の選択肢の数 */
export const CC_QUESTION_MAX_QUESTIONS = 4;
export const CC_QUESTION_MIN_OPTIONS = 2;
export const CC_QUESTION_MAX_OPTIONS = 8;
/** 1 つの欄の長さの上限（字） */
const MAX_QUESTION_CHARS = 2000;
const MAX_HEADER_CHARS = 100;
const MAX_LABEL_CHARS = 200;
const MAX_DESCRIPTION_CHARS = 1000;
/** 「その他」の文字列の上限（字） */
export const CC_QUESTION_OTHER_MAX_CHARS = 1000;
/** 要約の最初の問の文の長さ（字） */
const SUMMARY_QUESTION_CHARS = 100;
/** 複数選択の label の区切り */
export const CC_QUESTION_MULTI_SEPARATOR = ", ";

export type CcQuestionOption = { label: string; description: string };
export type CcQuestion = {
  question: string;
  /** 省略なら空 */
  header: string;
  options: CcQuestionOption[];
  multiSelect: boolean;
};
/** 1 問の答え（問の順）。labels は選んだ label、other は「その他」に打った文字列 */
export type CcQuestionPick = { labels: string[] } | { other: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function charLength(value: string): number {
  return [...value].length;
}

/** 文字列で長さが min〜max 字なら返す */
function text(value: unknown, min: number, max: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const length = charLength(value);
  return length >= min && length <= max ? value : undefined;
}

/**
 * tool_input が質問の形か確かめる（§2.2）。questions は 1〜4 個、各問は question（1〜2,000 字）・header（省略可。100 字まで）・
 * options（2〜8 個の { label（1〜200 字。空白だけは不可・問の中で重ならない）, description（省略可。1,000 字まで） }）・multiSelect（省略可。boolean）。
 * answers のキーは question の文なので、同じ文の問が 2 つあれば読めない形とする。合わなければ undefined
 */
export function parseQuestions(toolInput: unknown): CcQuestion[] | undefined {
  if (!isRecord(toolInput) || !Array.isArray(toolInput.questions)) return undefined;
  const list = toolInput.questions;
  if (list.length < 1 || list.length > CC_QUESTION_MAX_QUESTIONS) return undefined;
  const questions: CcQuestion[] = [];
  for (const item of list) {
    if (!isRecord(item)) return undefined;
    const question = text(item.question, 1, MAX_QUESTION_CHARS);
    if (question === undefined || question.trim() === "") return undefined;
    if (questions.some((other) => other.question === question)) return undefined;
    const header = item.header === undefined ? "" : text(item.header, 0, MAX_HEADER_CHARS);
    if (header === undefined) return undefined;
    if (item.multiSelect !== undefined && typeof item.multiSelect !== "boolean") return undefined;
    if (!Array.isArray(item.options)) return undefined;
    if (item.options.length < CC_QUESTION_MIN_OPTIONS || item.options.length > CC_QUESTION_MAX_OPTIONS) return undefined;
    const options: CcQuestionOption[] = [];
    for (const option of item.options) {
      if (!isRecord(option)) return undefined;
      const label = text(option.label, 1, MAX_LABEL_CHARS);
      if (label === undefined || label.trim() === "") return undefined;
      if (options.some((other) => other.label === label)) return undefined;
      const description = option.description === undefined ? "" : text(option.description, 0, MAX_DESCRIPTION_CHARS);
      if (description === undefined) return undefined;
      options.push({ label, description });
    }
    questions.push({ question, header, options, multiSelect: item.multiSelect === true });
  }
  return questions;
}

/**
 * 行に残した question_input（tool_input の JSON）を読む。updatedInput の元（input）と問（questions）。
 * NULL・JSON でない・質問の形でなければ undefined
 */
export function parseQuestionInput(json: string | null): { input: Record<string, unknown>; questions: CcQuestion[] } | undefined {
  if (json === null) return undefined;
  let input: unknown;
  try {
    input = JSON.parse(json);
  } catch {
    return undefined;
  }
  if (!isRecord(input)) return undefined;
  const questions = parseQuestions(input);
  return questions === undefined ? undefined : { input, questions };
}

/** 質問の要約（cc_permissions.summary。一覧・知らせの表示に使う。JSON は出さない）: 「質問 n 問: <最初の問の文の先頭 100 字>」 */
export function questionSummary(questions: readonly CcQuestion[]): string {
  return `質問 ${questions.length} 問: ${headChars(questions[0]?.question ?? "", SUMMARY_QUESTION_CHARS)}`;
}

/** 「その他」の文字列を整える（改行以外の制御文字は空白に・前後の空白を除く）。1〜1,000 字でなければ undefined */
export function normalizeOther(value: string): string | undefined {
  const cleaned = value.replace(/[\u0000-\u0009\u000b-\u001f\u007f]/g, " ").trim();
  const length = charLength(cleaned);
  return length >= 1 && length <= CC_QUESTION_OTHER_MAX_CHARS ? cleaned : undefined;
}

/**
 * 問ごとの答え（問の順）から answers を作る（§2.3）。数が問と違う・labels が空・行の options に無い label・重なる label・
 * 複数選択でない問に 2 つ以上・「その他」が空か 1,000 字超なら undefined。複数選択は選択肢の順に ", " でつなぐ。キーは問の文そのまま
 */
export function validateAnswers(questions: readonly CcQuestion[], picks: readonly CcQuestionPick[]): Record<string, string> | undefined {
  if (picks.length !== questions.length) return undefined;
  const answers: Record<string, string> = {};
  for (const [index, question] of questions.entries()) {
    const pick = picks[index]!;
    let value: string | undefined;
    if ("labels" in pick) {
      const labels = pick.labels;
      if (labels.length === 0 || new Set(labels).size !== labels.length) return undefined;
      if (!question.multiSelect && labels.length !== 1) return undefined;
      if (!labels.every((label) => question.options.some((option) => option.label === label))) return undefined;
      value = question.options
        .map((option) => option.label)
        .filter((label) => labels.includes(label))
        .join(CC_QUESTION_MULTI_SEPARATOR);
    } else {
      value = normalizeOther(pick.other);
    }
    if (value === undefined) return undefined;
    answers[question.question] = value;
  }
  return answers;
}

/**
 * 画面・ボタンから来た答えの並びの形を確かめる（問の数・label の中身は validateAnswers）。配列で、各要素がちょうど labels（文字列の配列）か
 * other（文字列）の 1 つを持つオブジェクトでなければ undefined
 */
export function parsePicks(value: unknown): CcQuestionPick[] | undefined {
  if (!Array.isArray(value) || value.length < 1 || value.length > CC_QUESTION_MAX_QUESTIONS) return undefined;
  const picks: CcQuestionPick[] = [];
  for (const item of value) {
    if (!isRecord(item)) return undefined;
    const keys = Object.keys(item);
    if (keys.length !== 1) return undefined;
    if (keys[0] === "labels") {
      const labels = item.labels;
      if (!Array.isArray(labels) || labels.length > CC_QUESTION_MAX_OPTIONS || !labels.every((label) => typeof label === "string")) return undefined;
      picks.push({ labels: labels as string[] });
    } else if (keys[0] === "other" && typeof item.other === "string") {
      picks.push({ other: item.other });
    } else {
      return undefined;
    }
  }
  return picks;
}

/** 行に残した answers（JSON）を読む。文字列の値のオブジェクトでなければ null */
export function parseStoredAnswers(json: string | null): Record<string, string> | null {
  if (json === null) return null;
  try {
    const value: unknown = JSON.parse(json);
    if (!isRecord(value) || !Object.values(value).every((item) => typeof item === "string")) return null;
    return value as Record<string, string>;
  } catch {
    return null;
  }
}
