// Claude Code の質問（AskUserQuestion）の Discord の操作（名前空間 `cc:q:*`。docs/plan/claude-code-questions.md §3.2。Q2）。振り分けは commands/cc.ts。
// - `cc:q:pick:<id>:<問>:<選択肢>`（選択肢のボタン）・`cc:q:ok:<id>:<問>`（[決める]。セレクトで選んだもの）・`cc:q:text:<id>:<問>`（「その他」のモーダルの送信）
//   → その問の答えを途中の答え（cc/question-flow.ts）に記録し、次の問があれば 1 通を次の問に書き換え、最後の問なら permission-hold.ts の
//   answerQuestion（via discord）に渡して答えの行に書き換える（ボタンを外し、[RC で開く] は残す）。
// - `cc:q:sel:<id>:<問>`（セレクト）→ 選んだものを覚えて deferUpdate（[決める] で確定）。
// - `cc:q:other:<id>:<問>`（[その他]）→ モーダル（`cc:q:text:<id>:<問>`。paragraph・1,000 字）を開く。
// - `cc:q:drop:<id>`（[やめる]）→ answer の deny（質問の行の message は「断りました」）。途中の答えは捨てる。
// 行が pending でない・質問でない・問が次の問でない・添字が範囲外・SELF_AGENT_CC が無効なら本人にだけ「この操作は古くなっています」。
// 応答の書き換えに失敗したら、記録した 1 通（cc_permissions.message_channel_id・message_id）を gateway で書き換えて代える。
// log は失敗の種類だけ（答えの結果は permission-hold.ts の「Claude Code: 質問（#id）→ <状態>（discord）」。問・答え・名前は出さない）
import { CC_QUESTION_TEXT_INPUT_ID, questionCustomId, questionModalTitle } from "../../cc/notice-text.ts";
import type { CcQuestionAnswerResult } from "../../cc/permission-hold.ts";
import type { CcQuestionFlow } from "../../cc/question-flow.ts";
import { CC_QUESTION_OTHER_MAX_CHARS, type CcQuestion, type CcQuestionPick, normalizeOther } from "../../cc/questions.ts";
import type { Gateway, InteractionResponder, OutgoingMessage } from "../../discord/gateway.ts";
import type { ComponentInteraction } from "../interactions.ts";
import { STALE_TURN_REPLY } from "./turn-controls.ts";

/** セレクトで選ばずに [決める] を押したとき（本人にだけ） */
export const CC_QUESTION_SELECT_FIRST_REPLY = "選んでから [決める] を押してください";
/** 「その他」が空か長すぎるとき（本人にだけ） */
export const CC_QUESTION_OTHER_INVALID_REPLY = `「その他」は 1〜${CC_QUESTION_OTHER_MAX_CHARS.toLocaleString("en-US")} 字で書いてください`;

/** 書き換える 1 通とそれを出した場所 */
export type CcQuestionPlace = { message: OutgoingMessage; channelId: string | null; messageId: string | null };

/** 質問の操作が使うもの（main が permission-hold.ts と cc/channel-posts.ts から作る） */
export type CcQuestionButtons = {
  /** 途中の答え（プロセスの中） */
  flow: CcQuestionFlow;
  /** 保留中（pending）の質問の行の問と request_hash（channel-posts.ts の pendingQuestion）。それ以外は undefined */
  pendingQuestion(id: number): { requestHash: string; questions: CcQuestion[] } | undefined;
  /** 全部の問に答える（permission-hold.ts の answerQuestion の via discord） */
  answerQuestion(id: number, requestHash: string, picks: readonly CcQuestionPick[]): CcQuestionAnswerResult;
  /** 次の問の 1 通（channel-posts.ts の questionStepMessage）。行が無ければ undefined */
  stepMessage(id: number, picks: readonly CcQuestionPick[]): CcQuestionPlace | undefined;
};

/** 質問の操作が使う許可の要求のボタンの口（commands/cc.ts の CcPermissionButtons の一部） */
export type CcQuestionDeps = {
  /** [やめる] は deny（permission-hold.ts の answer の via discord） */
  answer(id: number, decision: "deny"): { ok: boolean };
  /** 終わった行の 1 通（channel-posts.ts の resolvedMessage。質問の行は答えの行） */
  resolvedMessage(id: number): CcQuestionPlace | undefined;
  /** 答えた後（そのセッションの Claude Code のチャンネルを作る。CC11）。待たない・投げない */
  answered?(id: number, guildId: string | null): void;
  questions?: CcQuestionButtons;
};

/** 0 始まりの添字（0〜99）。それ以外なら undefined */
function parseIndex(raw: string | undefined): number | undefined {
  return raw !== undefined && /^(0|[1-9]\d?)$/.test(raw) ? Number(raw) : undefined;
}

/** custom_id の id（1 以上の整数）。それ以外なら undefined */
function parseId(raw: string | undefined): number | undefined {
  return raw !== undefined && /^[1-9]\d{0,15}$/.test(raw) ? Number(raw) : undefined;
}

function errorKind(error: unknown): string {
  return error instanceof Error ? error.name : typeof error;
}

/** 操作の種類ごとの interaction の種類（違えば custom_id の形の誤り） */
const KIND_OF: Readonly<Record<string, ComponentInteraction["kind"]>> = {
  pick: "button",
  other: "button",
  ok: "button",
  drop: "button",
  sel: "select",
  text: "modal",
};

/**
 * `cc:q:*` の操作（parts は custom_id を `:` で分けたもの）。形の違う custom_id は投げる（振り分けが「処理に失敗しました」にする）
 */
export async function handleQuestion(
  parts: readonly string[],
  interaction: ComponentInteraction,
  responder: InteractionResponder,
  buttons: CcQuestionDeps | undefined,
  deps: { gateway: Pick<Gateway, "editMessage">; log: (message: string) => void },
): Promise<void> {
  const action = parts[2] ?? "";
  const expectedLength = action === "drop" ? 4 : action === "pick" ? 6 : 5;
  const id = parseId(parts[3]);
  const questionIndex = action === "drop" ? 0 : parseIndex(parts[4]);
  const optionIndex = action === "pick" ? parseIndex(parts[5]) : 0;
  if (KIND_OF[action] === undefined || KIND_OF[action] !== interaction.kind || parts.length !== expectedLength) {
    throw new Error(`cc:q の不明な操作です（${interaction.kind} ${action}）`);
  }
  if (id === undefined || questionIndex === undefined || optionIndex === undefined) {
    throw new Error(`cc:q の custom_id が正しくありません（${action}）`);
  }
  const stale = (): Promise<void> => responder.reply({ text: STALE_TURN_REPLY, ephemeral: true });
  const questions = buttons?.questions;
  const pending = questions?.pendingQuestion(id);
  if (buttons === undefined || questions === undefined || pending === undefined) {
    questions?.flow.drop(id);
    await stale();
    return;
  }
  /** 1 通を書き換える（応答に失敗したら記録した 1 通を直接書き換える。それも失敗すれば投げて、振り分けが log に出す） */
  const show = async (place: CcQuestionPlace | undefined): Promise<void> => {
    if (place === undefined) {
      await responder.deferUpdate();
      return;
    }
    try {
      await responder.update(place.message);
    } catch (error) {
      deps.log(`Claude Code: 質問（#${id}）への応答に失敗したため、投稿を書き換えます（${errorKind(error)}）`);
      if (place.channelId !== null && place.messageId !== null) await deps.gateway.editMessage(place.channelId, place.messageId, place.message);
    }
  };
  /** 終わった 1 通に書き換え、答えた（関わった）ので、そのセッションのチャンネルを押したサーバーに作る */
  const finish = async (): Promise<void> => {
    try {
      await show(buttons.resolvedMessage(id));
    } finally {
      buttons.answered?.(id, interaction.guildId);
    }
  };

  if (action === "drop") {
    questions.flow.drop(id);
    if (!buttons.answer(id, "deny").ok) {
      await stale();
      return;
    }
    await finish();
    return;
  }
  const question = pending.questions[questionIndex];
  if (question === undefined || questionIndex !== questions.flow.step(id)) {
    await stale();
    return;
  }

  let pick: CcQuestionPick;
  if (action === "other") {
    await responder.showModal({
      customId: questionCustomId("text", id, questionIndex),
      title: questionModalTitle(question),
      fields: [
        {
          customId: CC_QUESTION_TEXT_INPUT_ID,
          label: `答え（${CC_QUESTION_OTHER_MAX_CHARS.toLocaleString("en-US")} 字まで）`,
          style: "paragraph",
          required: true,
          maxLength: CC_QUESTION_OTHER_MAX_CHARS,
        },
      ],
    });
    return;
  } else if (action === "sel") {
    if (interaction.kind !== "select") throw new Error("cc:q:sel はセレクトだけです");
    const indexes = interaction.values.map((value) => parseIndex(value));
    const max = question.multiSelect ? question.options.length : 1;
    if (
      indexes.length < 1 ||
      indexes.length > max ||
      new Set(indexes).size !== indexes.length ||
      indexes.some((index) => index === undefined || index >= question.options.length)
    ) {
      throw new Error("cc:q:sel の選択が正しくありません");
    }
    // 選択肢の順に覚える
    const labels = question.options.filter((_, index) => indexes.includes(index)).map((option) => option.label);
    questions.flow.select(id, questionIndex, labels);
    await responder.deferUpdate();
    return;
  } else if (action === "ok") {
    const labels = questions.flow.selected(id, questionIndex);
    if (labels === undefined || labels.length === 0) {
      await responder.reply({ text: CC_QUESTION_SELECT_FIRST_REPLY, ephemeral: true });
      return;
    }
    pick = { labels };
  } else if (action === "pick") {
    const option = question.options[optionIndex];
    if (option === undefined) {
      await stale();
      return;
    }
    pick = { labels: [option.label] };
  } else {
    if (interaction.kind !== "modal") throw new Error("cc:q:text はモーダルだけです");
    const other = normalizeOther(interaction.fields[CC_QUESTION_TEXT_INPUT_ID] ?? "");
    if (other === undefined) {
      await responder.reply({ text: CC_QUESTION_OTHER_INVALID_REPLY, ephemeral: true });
      return;
    }
    pick = { other };
  }

  const picks = questions.flow.answer(id, questionIndex, pick);
  if (picks === undefined) {
    await stale();
    return;
  }
  if (picks.length < pending.questions.length) {
    await show(questions.stepMessage(id, picks));
    return;
  }
  const result = questions.answerQuestion(id, pending.requestHash, picks);
  questions.flow.drop(id);
  if (!result.ok) {
    await stale();
    return;
  }
  await finish();
}
