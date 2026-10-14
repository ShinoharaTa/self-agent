// セッションのチャンネルの /renew。会話を要約して SDK セッションを捨て、次の発言から新しい SDK セッションで続ける
// （長くなった会話や、前の返事の癖を引きずらずに続けたいときに使う。システムプロンプトの変更は snapshot: false で次のターンから届く）。
// 要約はツールを足さず、要約を頼むターンの返答本文を使う（#inbox・#tasks の切り替えと同じ）。セッションの状態とカテゴリは変えない
import { RENEW_SUMMARY_MAX_LENGTH, type TopicSessionStore } from "../store/topic-sessions.ts";
import type { KeyedSerialQueue } from "./queue.ts";
import { clip, EMPTY_SUMMARY } from "./summary.ts";
import { recordTurnUsage, RESUME_FAILURE_PATTERN, resumeSeed, type TurnDeps, turnPersonaOf } from "./turn.ts";

/** /renew の要約を頼むターンの prompt。静的に保つ（日時ヘッダも付けない。字数は要約を切り詰める上限と揃える） */
export const RENEW_PROMPT =
  `会話を新しくするので、続きに必要なこと（目的・決めたこと・やり残し・約束・作っているものの URL）だけを ${RENEW_SUMMARY_MAX_LENGTH} 字以内の箇条書きで返答してください。SPEC.md があれば、その中身は書き写さず、SPEC.md があることだけ書いてください。ツールは使わないでください。`;

/** 新しくした後の最初のターンの prompt の先頭に付ける seed の見出し（システムプロンプトでこの文を説明している） */
export const RENEWED_SEED_HEADER = "会話を新しくしました。前の会話の要約:";

export type SessionRenewDeps = {
  topicSessions: Pick<TopicSessionStore, "get" | "setRenewed">;
  /** 発言のターンと同じキュー（key は channelId）。要約のターンが発言のターンと重ならないようにする */
  turnQueue: Pick<KeyedSerialQueue, "run">;
  /** 要約のターンの runner（チャンネルの持ち主の人格のもの）と、SDK セッション・seed・usage */
  turn: Pick<TurnDeps, "runner" | "personas" | "sessions" | "seeds" | "usage" | "log">;
  log: (message: string) => void;
};

/**
 * /renew の結果。not_session・closed はキュー待ちの間に変わった、no_conversation は SDK セッションが無く何も変えなかった、
 * renewed は要約して新しくした、renewed_fresh は会話の記録が無く要約せずに新しくした、failed は何も変えなかった
 */
export type RenewOutcome =
  | { result: "not_session" }
  | { result: "closed" }
  | { result: "no_conversation" }
  | { result: "renewed"; summary: string }
  | { result: "renewed_fresh" }
  | { result: "failed"; errorMessage: string };

/** 新しくした後の最初のターンに付ける seed */
export function renewedSeed(summary: string): string {
  return `${RENEWED_SEED_HEADER}\n${summary}`;
}

/**
 * 発言のターンと同じキューの中で（セッションのジョブとして）行う。状態はキュー待ちの間に変わりうるので、キューの中で確かめる。
 * 要約のターンは resume だけで、resume 失敗からの復旧はしない（runChannelTurn は使わず、usage の記録と SDK が記録した session_id の保存だけ同じように行う）。
 * context は渡さない（session_report・session_open は not_available になる）。WebFetch に許す URL も渡さない。
 * - 成功: 要約（返答本文の前後の空白を除いた先頭 RENEW_SUMMARY_MAX_LENGTH 字）を保存 → SDK セッションを捨てる → seed を入れる。
 *   返答本文が空なら要約は保存せず（前の /renew の要約を残す）、seed は題名にし、返信には「（要約なし）」を出す
 * - 会話の記録が無い（RESUME_FAILURE_PATTERN）: 要約は作らずに SDK セッションを捨て、resume 失敗の復旧と同じ seed を入れる
 * - それ以外の失敗: 何も変えない
 */
export async function renewSession(deps: SessionRenewDeps, guildId: string, channelId: string): Promise<RenewOutcome> {
  return deps.turnQueue.run(channelId, () => renewTurn(deps, guildId, channelId), { session: true });
}

async function renewTurn(deps: SessionRenewDeps, guildId: string, channelId: string): Promise<RenewOutcome> {
  const { topicSessions, turn, log } = deps;
  const { sessions, seeds } = turn;
  const session = topicSessions.get(channelId);
  if (session === undefined || session.guildId !== guildId) return { result: "not_session" };
  if (session.state === "done" || session.state === "deleted") return { result: "closed" };
  const sessionId = sessions.get(channelId);
  if (sessionId === undefined) return { result: "no_conversation" };

  // オーナーの発言ではないので、WebFetch で取得できる URL は無い。ターンはチャンネルの持ち主の人格で動かす
  const persona = turnPersonaOf(turn, channelId);
  const result = await persona.runner.run({ prompt: RENEW_PROMPT, sessionId, context: undefined, allowedUrls: [] });
  recordTurnUsage(turn, channelId, "session-renew", result, persona);

  if (result.ok) {
    const text = result.text.trim();
    const summary = text === "" ? undefined : clip(text, RENEW_SUMMARY_MAX_LENGTH);
    if (summary !== undefined) topicSessions.setRenewed(channelId, summary);
    sessions.delete(channelId);
    seeds.set(channelId, renewedSeed(summary ?? `題名: ${session.title}`));
    log(`/renew でセッションの会話を新しくしました（guild=${guildId}）`);
    return { result: "renewed", summary: summary ?? EMPTY_SUMMARY };
  }

  if (RESUME_FAILURE_PATTERN.test(result.errorMessage)) {
    // 会話の記録が既に無いので要約は作れない。resume 失敗の復旧と同じ seed（前の /renew の要約 → /close の要約 → 題名）にする
    sessions.delete(channelId);
    const seed = resumeSeed(session, undefined, "inbox");
    if (seed !== undefined) seeds.set(channelId, seed);
    // 実機の文言の確認のため、元のエラー文も出す
    log(
      `/renew でセッションの会話の記録が見つからないため、要約せずに新しくしました（guild=${guildId}）: ${result.errorMessage}`,
    );
    return { result: "renewed_fresh" };
  }

  // 途中まで記録された会話は次の発言で続ける（同じ SDK セッションなら置き換えない）
  if (result.sessionRecorded && result.sessionId !== undefined && result.sessionId !== sessions.get(channelId)) {
    sessions.set(channelId, result.sessionId);
  }
  log(`/renew の要約に失敗しました（guild=${guildId}）: ${result.errorMessage}`);
  return { result: "failed", errorMessage: result.errorMessage };
}
