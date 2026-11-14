// 話題の場所の付け替え（docs/plan/web-ui-v3.md §6.3 の案 B「要約を持って新しい会話へ」。#364）。
// 検査 → 今の会話に要点を 1 ターン頼む → 場所（project_dir）・SDK セッション・seed・要約・記録を 1 つのトランザクションで書き換える。
// チャンネル・履歴・題名はそのまま残し、次の発言から新しい場所の新しい会話で続ける。ファイルは動かさない。
// SDK の Options・システムプロンプト・ツールは変えない（seed の見出しは /renew と同じ RENEWED_SEED_HEADER）
import type { RunContext, RunResult } from "../agent/runner.ts";
import { ensureGeneralDir } from "../cc/starter.ts";
import { DEFAULT_PERSONA_ID } from "../config.ts";
import { escapeDiscordText } from "../discord/escape.ts";
import { type HistoryStore, recordHistory } from "../store/history.ts";
import type { TopicMoveStore } from "../store/topic-moves.ts";
import { RENEW_SUMMARY_MAX_LENGTH, type TopicSession, type TopicSessionStore } from "../store/topic-sessions.ts";
import type { KeyedSerialQueue } from "./queue.ts";
import { checkSessionProject, closeInProgress, type ProjectSessionGate, sessionTopic, type StartTopicPlace } from "./session-ops.ts";
import { RENEWED_SEED_HEADER } from "./session-renew.ts";
import { clip } from "./summary.ts";
import { GENERAL_GROUP, OTHER_GROUP, TOPIC_GROUP_PATTERN } from "./topics.ts";
import { recordTurnUsage, RESUME_FAILURE_PATTERN, resumeSeed, type TurnDeps, turnPersonaOf } from "./turn.ts";

export type MovePlace = StartTopicPlace;
export type MoveInput = { guildId: string; channelId: string; place: MovePlace; by: "web" | "discord" };
export type MoveRefusal =
  | "not_session"
  | "closed"
  | "persona"
  | "moving"
  | "closing"
  | "busy"
  | "cc_disabled"
  | "unify_not_ready"
  | "invalid_project"
  | "same_place";
export type MoveOutcome =
  | { result: MoveRefusal }
  | { result: "moved"; from: string | null; to: string; note: string | null }
  | { result: "failed" };

export type MoveDeps = {
  topicSessions: Pick<TopicSessionStore, "get" | "personaOf" | "projectDirOf" | "setProject" | "setRenewed" | "getCloseDraft">;
  moves: Pick<TopicMoveStore, "start" | "finish" | "fail">;
  /** 発言のターンと同じキュー（key は channelId） */
  turnQueue: Pick<KeyedSerialQueue, "run">;
  turn: Pick<TurnDeps, "runner" | "projectRunner" | "personas" | "sessions" | "seeds" | "usage" | "log">;
  /** 実行中のターン（handler.runningTurns） */
  runningTurns: () => ReadonlyArray<{ channelId: string }>;
  /** SELF_AGENT_CC=1 のときだけ。places には generalDir が入っている（M4a） */
  projectSessions?: ProjectSessionGate;
  history?: Pick<HistoryStore, "add">;
  /** Discord の topic の書き換え（gateway.setChannelTopic）。無ければ書き換えない */
  setChannelTopic?: (channelId: string, topic: string) => Promise<void>;
  log: (message: string) => void;
};

/** 引き継ぐ要点の上限（topic_moves.note） */
export const MOVE_NOTE_MAX_LENGTH = 4000;
/** Discord の結果の 1 通に載せる要点の字数 */
export const MOVE_NOTE_POST_MAX = 1500;

/** 要点を頼むターンの prompt。静的に保つ（行き先の名前・日時を入れない） */
export const MOVE_NOTE_PROMPT =
  `作業する場所を変えるので、新しい場所で続けるために必要なこと（目的・決めたこと・途中の作業・触ったファイル（今の場所からの相対パスと、何をしたか）・次にすること・約束・作っているものの URL）だけを ${MOVE_NOTE_MAX_LENGTH} 字以内の箇条書きで返答してください。SPEC.md があれば、その中身は書き写さず、SPEC.md があることだけ書いてください。ツールは使わないでください。`;

export const MOVE_FAILED_TEXT =
  "場所を変えられませんでした（要点をまとめられませんでした）。場所は変わっていません。少し待ってからもう一度試してください";
export const MOVE_INTERRUPTED_TEXT = "場所の付け替えが途中で止まりました。場所は変わっていません。もう一度試してください";

const REFUSAL_TEXT: Record<MoveRefusal, string> = {
  not_session: "この話題は場所を変えられません",
  closed: "完了した話題は場所を変えられません",
  persona: "足した人格の話題は場所を変えられません",
  moving: "場所を変えています。終わるまで待ってください",
  closing: "閉じる途中です。終わってから変えてください",
  busy: "担当が作業中です。終わってから変えてください",
  cc_disabled: "場所を変えるには Claude Code の連携が要ります",
  unify_not_ready: "設定が済んでいません。端末で npm run unify-setup -- --print の行を実行して再起動してください",
  invalid_project: "その場所は使えません",
  same_place: "もうその場所です",
};

/** 断りの文（Discord の断り・受け付けた後の履歴の知らせ・Web の toast で共通） */
export function moveRefusalText(result: MoveRefusal): string {
  return REFUSAL_TEXT[result];
}

/** 場所の呼び名。場所なしは「なし」、General のディレクトリは「General」、ほかはプロジェクトの名前 */
export function placeLabel(dir: string | null, generalDir: string | undefined): string {
  if (dir === null) return "なし";
  return dir === generalDir ? "General" : dir;
}

/** seed の見出しの直後に入れる場所の 2 行 */
export function placeLines(from: string | null, to: string, generalDir: string | undefined): string {
  return (
    `作業する場所は ${placeLabel(to, generalDir)} に変わりました（前は ${placeLabel(from, generalDir)}）。\n` +
    "ファイルは動かしていません。前の場所のファイルは前の場所にあります。"
  );
}

/** 付け替えた後の最初のターンの seed（見出し → 場所の 2 行 → 要点か題名） */
export function movedSeed(from: string | null, to: string, body: string, generalDir: string | undefined): string {
  return `${RENEWED_SEED_HEADER}\n${placeLines(from, to, generalDir)}\n${body}`;
}

/** 履歴の仕切り */
export function movedDividerText(from: string | null, to: string, generalDir: string | undefined): string {
  return `場所を ${placeLabel(from, generalDir)} から ${placeLabel(to, generalDir)} に変えました`;
}

/** 履歴の知らせ（要点の全文。履歴は 4,000 字で切れる） */
export function movedNoticeText(note: string | null): string {
  return note === null
    ? "ファイルは動かしていません。引き継ぐ要点はありません（会話がまだ無いか、記録が残っていませんでした）"
    : `ファイルは動かしていません。担当に引き継いだ要点:\n${note}`;
}

/** Discord の結果の 1 通（場所の名前は escape する。要点は先頭 MOVE_NOTE_POST_MAX 字） */
export function movedPostText(
  outcome: Pick<Extract<MoveOutcome, { result: "moved" }>, "from" | "to" | "note">,
  generalDir: string | undefined,
): string {
  const from = escapeDiscordText(placeLabel(outcome.from, generalDir));
  const to = escapeDiscordText(placeLabel(outcome.to, generalDir));
  const head = `場所を **${from}** から **${to}** に変えました。会話は新しくなりました（記録はこのまま残ります）。ファイルは動かしていません。`;
  if (outcome.note === null) return `${head}\n引き継ぐ要点はありません。`;
  const note = outcome.note.length > MOVE_NOTE_POST_MAX ? `${clip(outcome.note, MOVE_NOTE_POST_MAX)}…` : outcome.note;
  return `${head}\n\n**引き継いだ要点**\n${note}`;
}

/** 要求の place（群の key と同じ形。other は受けない）→ 行き先。p:<General の名前> は general と同じ。合わなければ undefined */
export function parsePlace(value: unknown, generalDir: string | undefined): MovePlace | undefined {
  if (typeof value !== "string" || !TOPIC_GROUP_PATTERN.test(value) || value === OTHER_GROUP) return undefined;
  if (value === GENERAL_GROUP) return { kind: "general" };
  const name = value.slice("p:".length);
  return name === generalDir ? { kind: "general" } : { kind: "project", name };
}

/** 検査の 1〜4（話題・完了・人格・閉じる途中）。通れば話題 */
function checkTopic(input: MoveInput, deps: MoveDeps): { session: TopicSession } | { refusal: MoveRefusal } {
  const session = deps.topicSessions.get(input.channelId);
  if (session === undefined || session.guildId !== input.guildId || session.state === "deleted") return { refusal: "not_session" };
  if (session.state === "done") return { refusal: "closed" };
  if (deps.topicSessions.personaOf(input.channelId) !== DEFAULT_PERSONA_ID) return { refusal: "persona" };
  if (closeInProgress(input.channelId) || deps.topicSessions.getCloseDraft(input.channelId) !== undefined) return { refusal: "closing" };
  return { session };
}

/** 検査の 8・9（行き先を決める・今の場所と同じか）。通れば前と後の project_dir */
function checkDestination(
  input: MoveInput,
  deps: MoveDeps,
  gate: ProjectSessionGate,
): { from: string | null; to: string } | { refusal: MoveRefusal } {
  let to: string;
  if (input.place.kind === "general") {
    const general = ensureGeneralDir(gate.places);
    if (general === "unavailable" || gate.places.generalDir === undefined) return { refusal: "invalid_project" };
    if (general === "created") deps.log("General のディレクトリを作りました");
    to = gate.places.generalDir;
  } else {
    const checked = checkSessionProject(input.place.name, gate);
    if (!checked.ok) return { refusal: checked.reason === "not_set_up" ? "unify_not_ready" : "invalid_project" };
    to = checked.projectDir;
  }
  const from = deps.topicSessions.projectDirOf(input.channelId)?.projectDir ?? null;
  if (from === to) return { refusal: "same_place" };
  return { from, to };
}

/**
 * 話題の場所を変える。検査（同期）で断れば onAccepted を呼ばず DB にも書かない。受け付けたら topic_moves に running の行を足して
 * onAccepted を待ち、発言と同じキュー（セッションのジョブ）の中で検査をやり直してから、会話があれば要点のターンを 1 つ走らせ、
 * 場所・SDK セッション・seed・要約・記録を 1 つのトランザクションで書き換える。要点のターンが失敗したら何も変えない。
 * 抜けるときに running の行を残さない。log に題名・本文・要点・チャンネル ID・プロジェクトの名前・パスを出さない
 */
export async function moveTopic(
  input: MoveInput,
  deps: MoveDeps,
  onAccepted?: () => void | Promise<void>,
): Promise<MoveOutcome> {
  // (1) 検査（最初の await の前に受け付けまで済ませる）
  const topic = checkTopic(input, deps);
  if ("refusal" in topic) return { result: topic.refusal };
  if (deps.runningTurns().some((running) => running.channelId === input.channelId)) return { result: "busy" };
  const gate = deps.projectSessions;
  if (gate === undefined) return { result: "cc_disabled" };
  if (!gate.ready()) return { result: "unify_not_ready" };
  const destination = checkDestination(input, deps, gate);
  if ("refusal" in destination) return { result: destination.refusal };

  // (2) 受け付け（二重の要求は一意索引で止まる）
  const id = deps.moves.start({ channelId: input.channelId, fromDir: destination.from, toDir: destination.to, by: input.by });
  if (id === undefined) return { result: "moving" };
  try {
    await onAccepted?.();
    // (3) キュー
    const outcome = await deps.turnQueue.run(input.channelId, () => moveTurn(input, deps, gate, id), { session: true });
    // (4) topic の書き換えは待たない（回数の制限で待たされることがある）。失敗は log だけ
    if (outcome.result === "moved" && deps.setChannelTopic !== undefined) {
      const title = deps.topicSessions.get(input.channelId)?.title;
      if (title !== undefined) {
        void deps.setChannelTopic(input.channelId, sessionTopic(title, undefined, outcome.to)).catch((error: unknown) => {
          deps.log(`topic の書き換えに失敗しました（${errorName(error)}）`);
        });
      }
    }
    return outcome;
  } finally {
    // done になっていれば何もしない
    failQuietly(deps, id);
  }
}

async function moveTurn(input: MoveInput, deps: MoveDeps, gate: ProjectSessionGate, id: number): Promise<MoveOutcome> {
  const { topicSessions, turn } = deps;
  const { guildId, channelId } = input;
  const generalDir = gate.places.generalDir;

  // 待っている間に閉じられた・消えた・別の口で場所が変わった（busy はやり直さない。自分がキューの先頭にいる）
  const topic = checkTopic(input, deps);
  if ("refusal" in topic) return refuseQueued(deps, guildId, channelId, id, topic.refusal);
  const destination = checkDestination(input, deps, gate);
  if ("refusal" in destination) return refuseQueued(deps, guildId, channelId, id, destination.refusal);
  const { session } = topic;
  const { from, to } = destination;
  const lines = placeLines(from, to, generalDir);

  const sessionId = turn.sessions.get(channelId);
  if (sessionId === undefined) {
    // 会話がまだ無い: ターンを使わずに場所だけ変える。今ある seed は消さずに末尾へ場所の 2 行を足す
    return finish(input, deps, id, from, to, null, generalDir, () => {
      topicSessions.setProject(channelId, to, "default");
      const seed = turn.seeds.get(channelId);
      if (seed !== undefined) turn.seeds.set(channelId, `${seed}\n\n${lines}`);
    });
  }

  // 要点のターン（/renew の要約のターンと同じ組み立て。オーナーの発言ではないので WebFetch に許す URL は無い）
  const persona = turnPersonaOf(turn, channelId);
  const project = topicSessions.projectDirOf(channelId);
  let result: RunResult | undefined;
  if (project === undefined || turn.projectRunner !== undefined) {
    const context: RunContext | undefined =
      project === undefined
        ? undefined
        : { guildId, channelId, kind: "session", purpose: "renew", projectDir: project.projectDir, permissionMode: project.permissionMode };
    const runner = project !== undefined && turn.projectRunner !== undefined ? turn.projectRunner : persona.runner;
    try {
      result = await runner.run({ prompt: MOVE_NOTE_PROMPT, sessionId, context, allowedUrls: [] });
    } catch (error) {
      deps.log(`場所の付け替えの要点のターンが投げました（guild=${guildId}、${errorName(error)}）`);
    }
  }
  if (result !== undefined) recordTurnUsage(turn, channelId, "topic-move", result, persona);

  if (result?.ok === true) {
    const text = result.text.trim();
    const note = text === "" ? null : clip(text, MOVE_NOTE_MAX_LENGTH);
    return finish(input, deps, id, from, to, note, generalDir, () => {
      topicSessions.setProject(channelId, to, "default");
      turn.sessions.delete(channelId);
      turn.seeds.set(channelId, movedSeed(from, to, note ?? `題名: ${session.title}`, generalDir));
      if (note !== null) topicSessions.setRenewed(channelId, clip(note, RENEW_SUMMARY_MAX_LENGTH));
    });
  }

  if (result !== undefined && !result.ok && RESUME_FAILURE_PATTERN.test(result.errorMessage)) {
    // 会話の記録がもう無いので要点は取れない。resume の復旧と同じ seed（前の /renew の要約 → /close の要約 → 題名）に場所の 2 行を足す
    const seed = resumeSeed(session, undefined, "inbox");
    return finish(input, deps, id, from, to, null, generalDir, () => {
      topicSessions.setProject(channelId, to, "default");
      turn.sessions.delete(channelId);
      turn.seeds.set(channelId, seed === undefined ? lines : `${seed}\n\n${lines}`);
    });
  }

  // ほかの失敗: 何も変えない。途中まで記録された会話は次の発言で続ける（同じ SDK セッションなら置き換えない）
  if (result !== undefined && !result.ok && result.sessionRecorded && result.sessionId !== undefined && result.sessionId !== sessionId) {
    turn.sessions.set(channelId, result.sessionId);
  }
  if (result === undefined && project !== undefined && turn.projectRunner === undefined) {
    deps.log(`場所の付け替えの要点のターンを始めませんでした（guild=${guildId}、プロジェクトの runner が無い）`);
  } else if (result !== undefined) {
    deps.log(`場所の付け替えの要点のターンが失敗しました（guild=${guildId}）`);
  }
  failQuietly(deps, id);
  notice(deps, guildId, channelId, MOVE_FAILED_TEXT);
  return { result: "failed" };
}

/** 受け付けた後（キューの中）で断る: 行を failed にし、履歴に知らせ */
function refuseQueued(deps: MoveDeps, guildId: string, channelId: string, id: number, refusal: MoveRefusal): MoveOutcome {
  failQuietly(deps, id);
  notice(deps, guildId, channelId, `場所を変えられませんでした: ${moveRefusalText(refusal)}`);
  deps.log(`場所の付け替えを断りました（guild=${guildId}、${refusal}）`);
  return { result: refusal };
}

/** 場所を変える書き込みと done を 1 つのトランザクションで。通ったら履歴に仕切りと知らせ */
function finish(
  input: MoveInput,
  deps: MoveDeps,
  id: number,
  from: string | null,
  to: string,
  note: string | null,
  generalDir: string | undefined,
  apply: () => void,
): MoveOutcome {
  const { guildId, channelId } = input;
  try {
    deps.moves.finish(id, note, apply);
  } catch (error) {
    deps.log(`場所の付け替えの書き込みに失敗しました（guild=${guildId}、${errorName(error)}）`);
    failQuietly(deps, id);
    notice(deps, guildId, channelId, MOVE_FAILED_TEXT);
    return { result: "failed" };
  }
  recordHistory(
    deps.history,
    { guildId, channelId, kind: "divider", source: "system", text: movedDividerText(from, to, generalDir) },
    deps.log,
  );
  notice(deps, guildId, channelId, movedNoticeText(note));
  deps.log(`場所を付け替えました（guild=${guildId}、${note === null ? "要点なし" : "要点あり"}）`);
  return { result: "moved", from, to, note };
}

/** 履歴に知らせを 1 行（無ければ何もしない。失敗は log だけ） */
function notice(deps: { history?: Pick<HistoryStore, "add">; log: (message: string) => void }, guildId: string, channelId: string, text: string): void {
  recordHistory(deps.history, { guildId, channelId, kind: "notice", source: "system", text }, deps.log);
}

/** running の行を failed にする（running でなければ何もしない）。投げても log だけ */
function failQuietly(deps: Pick<MoveDeps, "moves" | "log">, id: number): void {
  try {
    deps.moves.fail(id);
  } catch (error) {
    deps.log(`場所の付け替えの行を失敗にできませんでした（${errorName(error)}）`);
  }
}

function errorName(error: unknown): string {
  return error instanceof Error ? error.name : typeof error;
}

/**
 * 起動時の片付け: 途中で止まった（running のまま残った）付け替えを failed にし、その話題の履歴に知らせを 1 行書く。
 * 場所を変える書き込みは 1 つのトランザクションなので、残った行は「変える前に落ちた」だけ。やり直さない（利用枠を勝手に使わない）
 */
export function recoverMoves(deps: {
  moves: Pick<TopicMoveStore, "failInterrupted">;
  topicSessions: Pick<TopicSessionStore, "get">;
  history?: Pick<HistoryStore, "add">;
  log: (message: string) => void;
}): void {
  const rows = deps.moves.failInterrupted();
  for (const row of rows) {
    const session = deps.topicSessions.get(row.channelId);
    if (session !== undefined) notice(deps, session.guildId, row.channelId, MOVE_INTERRUPTED_TEXT);
  }
  if (rows.length > 0) deps.log(`途中で止まった場所の付け替えを ${rows.length} 件、失敗にしました`);
}
