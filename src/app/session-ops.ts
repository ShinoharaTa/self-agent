// セッションの操作（作る・待ちにする・進行中に戻す・閉じる・会話を新しくする）の本体。Discord のコマンド・ボタン（commands/）と Web UI が共有する。
// 応答（interaction への返信・保留）は呼び出し側が行い、ここは結果の種類を返す。保留が要る操作は、受け付けた（断らない）と決まった時点で onAccepted を呼ぶ
import { removeNodeModules } from "../agent/disk.ts";
import { DEFAULT_PERSONA_ID, type PersonaConfig } from "../config.ts";
import { normalizeChannelName } from "../discord/channel-name.ts";
import { type HistoryStore, recordHistory } from "../store/history.ts";
import type { SummaryChannelKind } from "../store/inbox-summaries.ts";
import type { CloseDraft, TopicSession, TopicSessionOrigin } from "../store/topic-sessions.ts";
import { findStateCategory } from "./categories.ts";
import type { CloseDeps } from "./commands/close.ts";
import { ALREADY_CLOSED_REPLY, CLOSE_PROMPT, closedText } from "./commands/close-text.ts";
import type { NewSessionDeps } from "./commands/new.ts";
import type { RenewDeps } from "./commands/renew.ts";
import { layoutQueueKey } from "./commands/setup.ts";
import type { WaitDeps } from "./commands/wait.ts";
import { ROTATED_NOTICE, ROTATED_NOTICE_FRESH, type RotateNowResult } from "./inbox-rotate.ts";
import { RENEWED_FRESH_REPLY, type RenewOutcome, renewedText, renewSession } from "./session-renew.ts";
import { applySessionEvent } from "./session-state.ts";
import { fallbackSummary } from "./summary.ts";
import { runChannelTurn } from "./turn.ts";

export const WAITED_REPLY = "待ちに移しました";
/** [続ける] を押した後の、待ちに移した知らせの本文 */
export const CONTINUED_TEXT = "進行中に戻しました";

export const NOT_RENEWABLE_REPLY = "セッションのチャンネルか #inbox・#tasks で実行してください";
export const NO_CONVERSATION_REPLY = "新しい会話はまだ始まっていません。次の発言から新しい会話で始まります";
export const RENEW_NOT_SET_UP_REPLY = "/setup を実行してください";
export const RENEW_FAILURE_REPLY = "失敗しました。もう一度 /renew を実行してください";

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// ---- 作る（/new・ホームパネル） ----

/** /setup が作る最初の進行中カテゴリ */
const FIRST_ORDINAL = 1;
/** 正規化して空になった題名のチャンネル名 */
const FALLBACK_CHANNEL_NAME = "session";

/**
 * 題名をチャンネル名にする。前後の空白を除く → 空白の連続を `-` に → `-` と `_` 以外の ASCII 記号を除く →
 * ASCII 英字を小文字に → `-` の連続を 1 つに、先頭・末尾の `-` を除く → 100 字で切る → 空なら `session`。日本語はそのまま残す
 */
export function toChannelName(title: string): string {
  const name = normalizeChannelName(title);
  return name === "" ? FALLBACK_CHANNEL_NAME : name;
}

/** セッションを作る人格（既定の人格以外）。チャンネル名の接頭辞と topic に表示名を使う */
export type SessionOwner = Pick<PersonaConfig, "id" | "name">;

/** セッションのチャンネル名。既定の人格は題名だけ（今のまま）、足した人格は `<NAME>-<題名>`（どちらも toChannelName の規則で 100 字まで） */
export function sessionChannelName(title: string, owner?: SessionOwner): string {
  if (owner === undefined) return toChannelName(title);
  return toChannelName(`${normalizeChannelName(owner.name)}-${toChannelName(title)}`);
}

/** セッションのチャンネルの topic。既定の人格は題名だけ（今のまま）、足した人格は題名に表示名を添える */
export function sessionTopic(title: string, owner?: SessionOwner): string {
  return owner === undefined ? title : `${title}（${owner.name}）`;
}

export function welcomeText(title: string): string {
  return `セッション「${title}」を始めました。ここで話しかけてください。`;
}

export type NewSessionResult = { result: "not_set_up" } | { result: "created"; channelId: string };

/**
 * 空きのある進行中カテゴリにセッション用のチャンネルを作り、sessions に保存する。/setup 前（進行中カテゴリが無い）なら何もしない。
 * origin は作られ方（/new・ホームパネルは command、#inbox・#<NAME> の session_open は inbox）。
 * owner は作る人格（チャンネルの持ち主。省略は既定の人格）。足した人格ならチャンネル名に `<NAME>-` を付け、topic に表示名を添える
 */
export async function createTopicSession(
  guildId: string,
  title: string,
  deps: Pick<NewSessionDeps, "gateway" | "guildSettings" | "topicSessions" | "log">,
  origin: TopicSessionOrigin = "command",
  owner?: SessionOwner,
): Promise<NewSessionResult> {
  const { gateway, guildSettings, topicSessions, log } = deps;
  if (
    guildSettings.get(guildId) === undefined ||
    guildSettings.getStateCategory(guildId, "active", FIRST_ORDINAL) === undefined
  ) {
    return { result: "not_set_up" };
  }
  const categoryId = await findStateCategory(guildId, "active", deps);
  // name・topic は作成時にだけ設定し、以後変更しない
  const channelId = await gateway.createTextChannel(guildId, {
    name: sessionChannelName(title, owner),
    parentId: categoryId,
    topic: sessionTopic(title, owner),
  });
  try {
    topicSessions.create({ channelId, guildId, title, categoryId, origin, ...(owner === undefined ? {} : { persona: owner.id }) });
  } catch (error) {
    // チャンネルだけが Discord に残る。手で消せるよう、ログにチャンネル ID を出す（ログ方針の例外）
    log(
      `セッションのチャンネルを作りましたが DB への保存に失敗しました（guild=${guildId}、channel=${channelId}）: ${describeError(error)}`,
    );
    throw error;
  }
  return { result: "created", channelId };
}

export type OpenTopicSessionResult = { result: "empty_title" } | NewSessionResult;

/**
 * 題名からセッションを作る（/new・ホームパネルの [新しいセッション]・Web で共通）。
 * 空白だけの題名は作らない（empty_title。onAccepted は呼ばない）→ onAccepted → /setup と同じキューで作成 → 最初の投稿（チャンネルの持ち主の Bot。失敗は log だけ）。
 * via は log の主語（「/new で」など）。owner は作る人格（省略は既定の人格）
 */
export async function openTopicSession(
  guildId: string,
  rawTitle: string,
  owner: SessionOwner | undefined,
  deps: Pick<NewSessionDeps, "gateway" | "personas" | "guildSettings" | "topicSessions" | "queue" | "log">,
  via: string,
  onAccepted?: () => Promise<void>,
): Promise<OpenTopicSessionResult> {
  const { gateway, personas, queue, log } = deps;
  // 空白だけの題名は Discord の min_length・必須の検証を通ってしまうので、ここで弾く
  const title = rawTitle.trim();
  if (title === "") return { result: "empty_title" };
  // Discord への作成が複数回ありうるので、呼び出し側はここで保留する
  await onAccepted?.();
  // 同時に走ると空きの数え方がずれるので、/setup と同じ key で 1 つずつ実行する
  const result = await queue.run(layoutQueueKey(guildId), () => createTopicSession(guildId, title, deps, "command", owner));
  if (result.result === "not_set_up") return result;
  log(`${via}セッションを作りました（guild=${guildId}${owner === undefined ? "" : `、人格 ${owner.id}`}）`);
  try {
    // 最初の投稿はチャンネルの持ち主の Bot が行う（足した人格のセッションはその人格の Bot）
    await (personas?.gatewayFor(result.channelId) ?? gateway).send(result.channelId, welcomeText(title));
  } catch (error) {
    // チャンネルと DB の行はできているので、失敗の返信にはしない
    log(`セッションの最初の投稿に失敗しました: ${describeError(error)}`);
  }
  return result;
}

// ---- 待ちにする・進行中に戻す（/wait・[続ける]） ----

export type WaitSessionDeps = Pick<WaitDeps, "topicSessions" | "channelOps" | "personas" | "history" | "log">;

/** 待ち・進行中の切り替えの知らせの行を history に書く（無ければ何もしない。失敗は log だけ） */
function recordStateNotice(deps: WaitSessionDeps, session: Pick<TopicSession, "guildId" | "channelId">, text: string): void {
  recordHistory(
    deps.history,
    {
      guildId: session.guildId,
      channelId: session.channelId,
      kind: "notice",
      source: "system",
      persona: deps.personas?.ownerOf(session.channelId) ?? DEFAULT_PERSONA_ID,
      text,
    },
    deps.log,
  );
}

/**
 * /wait: セッションを待ちにして待ちカテゴリへ移す。not_session は行が無い・サーバーが違う、closed は完了・削除済み、
 * waited は待ちに移した（log と history の知らせ）、unchanged は既に待ちで何も変えなかった
 */
export function waitSession(
  guildId: string,
  channelId: string,
  deps: WaitSessionDeps,
): "not_session" | "closed" | "waited" | "unchanged" {
  const session = deps.topicSessions.get(channelId);
  if (session === undefined || session.guildId !== guildId) return "not_session";
  if (session.state === "done" || session.state === "deleted") return "closed";
  // 既に待ちなら何も変えない
  if (applySessionEvent(session, "wait", deps).move === null) return "unchanged";
  deps.log(`/wait でセッションを待ちに移しました（guild=${guildId}）`);
  recordStateNotice(deps, session, WAITED_REPLY);
  return "waited";
}

/**
 * [続ける]: 待ち・完了のセッションを進行中に戻す。not_session は行が無い・サーバーが違う、deleted は削除済み、
 * continued は進行中に戻した（log と history の知らせ）、unchanged は既に進行中で何も変えなかった
 */
export function continueSession(
  guildId: string,
  channelId: string,
  deps: WaitSessionDeps,
): "not_session" | "deleted" | "continued" | "unchanged" {
  const session = deps.topicSessions.get(channelId);
  if (session === undefined || session.guildId !== guildId) return "not_session";
  if (session.state === "deleted") return "deleted";
  if (applySessionEvent(session, "continue", deps).move === null) return "unchanged";
  deps.log(`[続ける] でセッションを進行中に戻しました（guild=${session.guildId}）`);
  recordStateNotice(deps, session, CONTINUED_TEXT);
  return "continued";
}

// ---- 閉じる（/close・[閉じる]・確認のボタン） ----

/** /close を受け付けられるセッションか（行が無い・サーバーが違えば「セッションでない」、完了・削除済みは「閉じている」） */
export function closable(session: TopicSession | undefined, guildId: string): "ok" | "not_session" | "closed" {
  if (session === undefined || session.guildId !== guildId) return "not_session";
  return session.state === "done" || session.state === "deleted" ? "closed" : "ok";
}

/**
 * 閉じる: 選んだタスク（draft.tasks の添字）を登録 → 完了にして要約を残し下書きを消す → 完了カテゴリへの移動を列に入れる。
 * DB の更新は await を挟まずに行う（同じ下書きで 2 回登録しない）。登録した件数を返す
 */
function finalizeClose(
  session: TopicSession,
  draft: CloseDraft,
  selected: readonly number[],
  deps: Pick<CloseDeps, "topicSessions" | "tasks" | "channelOps" | "personas" | "history" | "log">,
): number {
  const { topicSessions, tasks, channelOps, log } = deps;
  // 選んだ順ではなく候補の順に登録する
  const chosen = [...new Set(selected)]
    .sort((a, b) => a - b)
    .flatMap((index) => {
      const task = draft.tasks[index];
      return task === undefined ? [] : [task];
    });
  for (const task of chosen) tasks.add({ title: task.title, due: task.due });
  topicSessions.close(session.channelId, draft.summary);
  channelOps.enqueueMove(session.channelId, { kind: "state", guildId: session.guildId, state: "done" });
  log(`/close でセッションを閉じました（guild=${session.guildId}、登録 ${chosen.length} 件）`);
  recordHistory(
    deps.history,
    {
      guildId: session.guildId,
      channelId: session.channelId,
      kind: "divider",
      source: "system",
      persona: deps.personas?.ownerOf(session.channelId) ?? DEFAULT_PERSONA_ID,
      text: closedText(draft.summary, chosen.length),
    },
    log,
  );
  return chosen.length;
}

/**
 * 閉じた後に、そのチャンネルのプロジェクト（あれば）の node_modules を消す（作り直せるもの。disk.ts の removeNodeModules）。
 * 発言と同じキュー（turnQueue、key は channelId）の中で行い、そのチャンネルの新しいターンと重ならないようにする。その時点で完了でなければ（戻っていれば）消さない。
 * プロジェクトの dir を確かめられなければ何も消さない。失敗は log だけで、/close の結果は変えない（パスは出さない）。reject しない。
 * closeSession の finalized・confirmClose の closed の後に、呼び出し側が結果を出してから呼ぶ（キューを待つ間、結果を遅らせない）
 */
export async function removeClosedNodeModules(
  deps: Pick<CloseDeps, "topicSessions" | "projects" | "projectsDir" | "turnQueue" | "log">,
  channelId: string,
): Promise<void> {
  const { topicSessions, projects, projectsDir, turnQueue, log } = deps;
  try {
    await turnQueue.run(
      channelId,
      async () => {
        // キューを待つ間に発言などで進行中に戻っていれば消さない
        if (topicSessions.get(channelId)?.state !== "done") return;
        const project = projects.getByChannel(channelId);
        if (project === undefined) return;
        const removed = await removeNodeModules(projectsDir, project.slug);
        if (removed === undefined) log("プロジェクトのディレクトリを確かめられないため node_modules を消しませんでした");
        else if (removed > 0) log(`node_modules を消しました（${removed} 件）`);
      },
      { session: true },
    );
  } catch {
    log("node_modules を消せませんでした");
  }
}

export type CloseTurnOutcome =
  | { result: "closed" }
  | { result: "failed"; errorMessage: string }
  | { result: "finalized"; summary: string }
  | { result: "confirm"; draft: CloseDraft };

/** 発言のターンと同じキューの中で行う（状態はキュー待ちの間に変わりうるので、ここでも確かめる） */
async function closeTurn(deps: CloseDeps, guildId: string, channelId: string): Promise<CloseTurnOutcome> {
  const { topicSessions, turn } = deps;
  const session = topicSessions.get(channelId);
  if (session === undefined || closable(session, guildId) !== "ok") return { result: "closed" };
  // 前の /close や通常のターンで残った下書きは使わない
  topicSessions.clearCloseDraft(channelId);
  // オーナーの発言ではないので、WebFetch で取得できる URL は無い
  const result = await runChannelTurn(turn, {
    guildId,
    channelId,
    kind: "session",
    prompt: CLOSE_PROMPT,
    allowedUrls: [],
    // 要約のターンでは Bash を使わせない（run の context の印）
    purpose: "close",
  });
  if (!result.ok) return { result: "failed", errorMessage: result.errorMessage };
  const draft = topicSessions.getCloseDraft(channelId) ?? { summary: fallbackSummary(result.text), tasks: [] };
  if (draft.tasks.length > 0) return { result: "confirm", draft };
  finalizeClose(session, draft, [], deps);
  return { result: "finalized", summary: draft.summary };
}

/**
 * /close の流れ: 閉じられるか確かめる（not_session・closed なら onAccepted を呼ばずに返す）→ onAccepted →
 * 発言のターンと同じキュー（セッションのジョブ）でそのセッションの会話に要約とやることの候補を作らせる →
 * 候補があれば confirm（下書きは DB に残る）、無ければ閉じて finalized。キューを待つ間に閉じられていれば closed、ターンの失敗は failed（log に出す）
 */
export async function closeSession(
  guildId: string,
  channelId: string,
  deps: CloseDeps,
  onAccepted?: () => Promise<void>,
): Promise<{ result: "not_session" } | CloseTurnOutcome> {
  const check = closable(deps.topicSessions.get(channelId), guildId);
  if (check === "not_session") return { result: "not_session" };
  if (check === "closed") return { result: "closed" };
  await onAccepted?.();
  // セッションのターンなので、発言のターンと同じく同時実行の枠を 1 つ #inbox 用に残す
  const outcome = await deps.turnQueue.run(channelId, () => closeTurn(deps, guildId, channelId), { session: true });
  if (outcome.result === "failed") deps.log(`/close のターンが失敗しました: ${outcome.errorMessage}`);
  return outcome;
}

/**
 * /close の確認の確定: DB の下書きで、選んだ候補（添字・全部・なし）を登録して閉じる。
 * セッションでない・閉じている・下書きが無ければ no_draft（何も変えない）
 */
export function confirmClose(
  guildId: string,
  channelId: string,
  selected: readonly number[] | "all" | "none",
  deps: Pick<CloseDeps, "topicSessions" | "tasks" | "channelOps" | "personas" | "history" | "log">,
): { result: "no_draft" } | { result: "closed"; summary: string; registered: number } {
  const session = deps.topicSessions.get(channelId);
  const draft = deps.topicSessions.getCloseDraft(channelId);
  if (session === undefined || draft === undefined || closable(session, guildId) !== "ok") return { result: "no_draft" };
  const indices = selected === "all" ? draft.tasks.map((_task, index) => index) : selected === "none" ? [] : selected;
  const registered = finalizeClose(session, draft, indices, deps);
  return { result: "closed", summary: draft.summary, registered };
}

// ---- 会話を新しくする（/renew） ----

/** セッションの /renew の結果の文 */
export function sessionReply(outcome: RenewOutcome): string {
  switch (outcome.result) {
    case "renewed":
      return renewedText(outcome.summary);
    case "renewed_fresh":
      return RENEWED_FRESH_REPLY;
    case "no_conversation":
      return NO_CONVERSATION_REPLY;
    case "not_session":
      return NOT_RENEWABLE_REPLY;
    case "closed":
      return ALREADY_CLOSED_REPLY;
    case "failed":
      return RENEW_FAILURE_REPLY;
  }
}

/** #inbox・#tasks・#<NAME> の /renew（rotateNow）の結果の文 */
export function rotateReply(result: RotateNowResult): string {
  switch (result) {
    case "rotated":
      return ROTATED_NOTICE;
    case "rotated_fresh":
      return ROTATED_NOTICE_FRESH;
    case "no_conversation":
      return NO_CONVERSATION_REPLY;
    case "not_set_up":
      return RENEW_NOT_SET_UP_REPLY;
    case "failed":
      return RENEW_FAILURE_REPLY;
  }
}

/**
 * 会話を要約して新しい SDK セッションに切り替える。#inbox・#tasks と足した人格の #<NAME>（/setup 済みのサーバーの DB のもの。#<NAME> は設定にある人格のものだけ）
 * では日次の切り替えと同じ処理（rotateNow）、セッションのチャンネルでは session-renew.ts。
 * どれでもない・セッションが閉じていれば onAccepted を呼ばずに not_renewable・closed を返す。それ以外は onAccepted の後に行い、結果の文を done で返す
 * （区切りの history の行は rotateNow・renewSession が書く）
 */
export async function renewChannel(
  guildId: string,
  channelId: string,
  deps: Pick<RenewDeps, "guildSettings" | "inboxRotator" | "personas" | "topicSessions" | "turnQueue" | "turn" | "history" | "log">,
  onAccepted?: () => Promise<void>,
): Promise<{ result: "not_renewable" } | { result: "closed" } | { result: "done"; text: string }> {
  const { guildSettings, topicSessions, inboxRotator } = deps;
  // #inbox・#tasks は /setup 済みのサーバーの DB のものだけ（/setup 前の env の #inbox は対象外）
  const settings = guildSettings.get(guildId);
  let channelKind: SummaryChannelKind | undefined;
  let persona = DEFAULT_PERSONA_ID;
  if (settings?.inboxChannelId === channelId) channelKind = "inbox";
  else if (settings?.tasksChannelId === channelId) channelKind = "tasks";
  else if (settings !== undefined && deps.personas !== undefined) {
    // 足した人格の #<NAME>: 持ち主がその人格のまま（設定から外していない）ときだけ
    const entry = guildSettings.entryChannel(channelId);
    if (
      entry !== undefined &&
      entry.guildId === guildId &&
      entry.kind === "inbox" &&
      entry.persona !== DEFAULT_PERSONA_ID &&
      deps.personas.ownerOf(channelId) === entry.persona
    ) {
      channelKind = "inbox";
      persona = entry.persona;
    }
  }
  if (channelKind !== undefined) {
    await onAccepted?.();
    const result = await inboxRotator.rotateNow(guildId, channelKind, persona);
    return { result: "done", text: rotateReply(result) };
  }

  const session = topicSessions.get(channelId);
  if (session === undefined || session.guildId !== guildId) return { result: "not_renewable" };
  if (session.state === "done" || session.state === "deleted") return { result: "closed" };
  // 要約のターンは 3 秒を超えるので、呼び出し側はここで保留する
  await onAccepted?.();
  const outcome = await renewSession(deps, guildId, channelId);
  return { result: "done", text: sessionReply(outcome) };
}
