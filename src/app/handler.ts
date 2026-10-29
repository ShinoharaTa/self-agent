import type { AgentRunner, RunResult } from "../agent/runner.ts";
import { type Config, DEFAULT_PERSONA_ID } from "../config.ts";
import type { IncomingImage, IncomingMessage, OutgoingMessage } from "../discord/gateway.ts";
import type { ChannelSeedStore } from "../store/channel-seeds.ts";
import { type HistoryStore, recordHistory } from "../store/history.ts";
import type { InboxSummaryStore } from "../store/inbox-summaries.ts";
import type { MemoryStore } from "../store/memories.ts";
import type { SdkSessionStore } from "../store/sdk-sessions.ts";
import type { TopicSession, TopicSessionStore } from "../store/topic-sessions.ts";
import type { UsageStore } from "../store/usage.ts";
import { acceptedChannel, type ChannelKind, type ResolveChannel } from "./access.ts";
import { type AttachmentSource, attachmentNotes, attachmentReply, type PreparedImages } from "./attachments.ts";
import type { ChannelOpsQueue } from "./channel-ops.ts";
import { abortTurnButton, continueTurnButton, MAX_TURNS_REPLY } from "./commands/turn-controls.ts";
import { buildTurnPrompt } from "./prompt.ts";
import {
  formatElapsed,
  PROGRESS_INTERVAL_MS,
  progressEndText,
  progressText,
  type ProgressTimers,
  startProgress,
  type TurnOutcome,
} from "./progress.ts";
import type { KeyedSerialQueue } from "./queue.ts";
import type { OwnerPosts, PersonaRouter } from "./personas.ts";
import { applySessionEvent } from "./session-state.ts";
import { ABORTED_ERROR, MAX_TURNS_ERROR_PREFIX, runChannelTurn, type TurnDeps } from "./turn.ts";
import { extractUrls } from "./urls.ts";

// 手順の上限で止まったときの返信は、その [続ける] と同じ turn-controls.ts に置く
export { MAX_TURNS_REPLY };

export const FAILURE_REPLY = "処理に失敗しました。時間をおいてもう一度送ってください。";
/** [中断] で止めたターンの返信 */
export const ABORTED_REPLY = "中断しました。続けるときは発言してください";
/** [続ける] で入れるターンの本文（オーナーの発言として扱う） */
export const CONTINUE_PROMPT = "続けてください";
export const EMPTY_REPLY = "（返答が空でした）";
/** そのターンで compaction が起きたとき、返信の末尾に足す 1 行 */
export const COMPACTED_NOTE = "（会話が長くなったため、古い部分を要約しました）";
/** 発言で待ち・完了から進行中に戻したターンの、返信の先頭に足す 1 行（成功したときだけ） */
export const REVIVED_NOTE = "（進行中に戻しました）";

/** セッションのチャンネルのターンが、開始からこれだけ経っても終わっていなければ途中経過のメッセージを出す */
export const PROGRESS_DELAY_MS = 20_000;
/** history に残すためにターンごとに集める手順の label の数（保存するときはストアが先頭 50 件に切る） */
const HISTORY_STEPS_COLLECT_MAX = 60;
// 途中経過の表示は progress.ts（ジョブと共通）。これまでどおり handler からも使えるようにする
export { formatElapsed, PROGRESS_INTERVAL_MS, progressEndText, progressText, type ProgressTimers, type TurnOutcome };

/** ターンの終わり方。結果が無ければ（例外）failed */
export function turnOutcome(result: RunResult | undefined): TurnOutcome {
  if (result === undefined) return "failed";
  if (result.ok) return "done";
  if (result.errorMessage === ABORTED_ERROR) return "aborted";
  // sdk-runner は result の失敗を subtype から書き始める
  return result.errorMessage.startsWith(MAX_TURNS_ERROR_PREFIX) ? "max_turns" : "failed";
}

export type HandlerDeps = {
  cfg: Pick<Config, "allowedGuildIds" | "ownerUserId" | "timeZone">;
  /** 受け付け対象のチャンネルか（DB の設定、無ければ env の #inbox。/new で作ったセッション） */
  resolveChannel: ResolveChannel;
  /** 返信・途中経過・入力中表示（チャンネルの持ち主の Bot で投稿する。personas.ts の ownerPosts） */
  gateway: OwnerPosts;
  /** 既定の人格の runner */
  runner: AgentRunner;
  /**
   * チャンネルの持ち主の人格。発言は持ち主の Bot が受け取った分だけを受け付け、ターンは持ち主の人格の runner で動かす。
   * 無ければすべて既定の人格
   */
  personas?: Pick<PersonaRouter, "ownerOf" | "turnPersona">;
  sessions: SdkSessionStore;
  /** 次のターンの prompt の先頭に付ける文（resume 失敗の復旧など） */
  seeds: ChannelSeedStore;
  /** セッションの題名と最終発言の時刻、resume 失敗時の要約。待ち・完了のセッションは発言で進行中に戻す */
  topicSessions: Pick<TopicSessionStore, "touch" | "get" | "setActive" | "setWaiting">;
  /** #inbox・#tasks の resume 失敗時の seed（そのチャンネルの直近の要約） */
  inboxSummaries: Pick<InboxSummaryStore, "latest">;
  /** 新しい SDK セッションの最初の prompt に付ける記憶 */
  memories: Pick<MemoryStore, "list">;
  /** 進行中に戻したセッションを進行中カテゴリへ移す */
  channelOps: Pick<ChannelOpsQueue, "enqueueMove">;
  usage: UsageStore;
  /** ターンのキュー（key は channelId）。/close のターンも同じキューに入れる。セッションのターンはセッションのジョブとして入れる */
  queue: KeyedSerialQueue;
  /** 途中経過の経過時間を測る */
  now: () => Date;
  /** 途中経過を出す・書き換えるタイマー。省略すれば実際のタイマー */
  timers?: ProgressTimers;
  /**
   * 発言の画像を取り、渡す画像と保存した原本の id を返す（attachments.ts の prepareImages）。reject しない。
   * 省略すれば画像は渡さない（本文と注記だけ）
   */
  prepareImages?: (source: AttachmentSource, images: readonly IncomingImage[]) => Promise<PreparedImages>;
  /** Web UI のためのターンの記録（Web UI が有効なときだけ渡す）。無ければ書かない */
  history?: Pick<HistoryStore, "add">;
  log: (message: string) => void;
};

export type Handler = {
  /** 受け付けた発言を 1 ターンとして処理する。reject しない（失敗は log に出す） */
  handleMessage(event: IncomingMessage): Promise<void>;
  /**
   * [続ける]: そのチャンネルに「続けてください」を、オーナーの発言と同じ経路で 1 ターン入れる（日時ヘッダは at、返信先は無し、URL は無し）。
   * 受け付けるセッションでなければ何もしない。返信まで待つ。reject しない
   */
  continueTurn(guildId: string, channelId: string, at: Date): Promise<void>;
  /**
   * そのセッションのチャンネルで実行中の（発言・[続ける] の）ターンを、番号（turnSeq）が一致するときだけ中断する。
   * 実行中のターンが無い・番号が違う（前のターンのボタン）なら false（#inbox・#tasks・/close のターンは中断できない）
   */
  abortTurn(channelId: string, turnSeq: number): boolean;
};

/** 1 ターンの依頼（オーナーの発言か [続ける]） */
type TurnRequest = {
  guildId: string;
  channelId: string;
  kind: ChannelKind;
  /** オーナーの発言の本文（[続ける] なら CONTINUE_PROMPT） */
  content: string;
  /** 日時ヘッダの時刻 */
  at: Date;
  /** 返信先の発言。無ければ返信にしない */
  replyToId?: string;
  /** 発言の添付（渡せる画像と、渡さない添付の数）。オーナーの発言だけ */
  attachments?: { messageId: string; images: readonly IncomingImage[]; skipped?: IncomingMessage["skippedAttachments"] };
  /** どこから来た依頼か（history の source） */
  source: "discord" | "web";
  /** 呼び出し側が先に書いた owner の行の id。あれば submit は owner の行を書かない */
  historyId?: number;
};

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** owner の行の text（本文。画像があれば「（画像 n 枚）」を、本文が空ならそれだけ、あれば末尾に改行して足す） */
function ownerText(request: TurnRequest): string {
  const count = request.attachments?.images.length ?? 0;
  if (count === 0) return request.content;
  const images = `（画像 ${count} 枚）`;
  return request.content.trim() === "" ? images : `${request.content}\n${images}`;
}

/**
 * 受け付けた発言（と [続ける]）を 1 ターンとして処理する。セッションのチャンネルのターンには途中経過と [中断] を付け、
 * 手順の上限で止まったら [続ける] を付ける（#inbox・#tasks には付けない）
 */
export function createHandler(deps: HandlerDeps): Handler {
  const {
    cfg,
    resolveChannel,
    gateway,
    runner,
    personas,
    sessions,
    seeds,
    topicSessions,
    inboxSummaries,
    memories,
    channelOps,
    usage,
    queue,
    now,
    prepareImages,
    history,
    log,
  } = deps;
  const timers = deps.timers;
  const turnDeps: TurnDeps = {
    runner,
    ...(personas === undefined ? {} : { personas }),
    sessions,
    seeds,
    topicSessions,
    inboxSummaries,
    memories,
    usage,
    log,
  };
  const ownerOf = personas === undefined ? undefined : (channelId: string) => personas.ownerOf(channelId);
  /** history の行の persona（チャンネルの持ち主の人格） */
  const personaOf = (channelId: string): string => ownerOf?.(channelId) ?? DEFAULT_PERSONA_ID;
  /** 実行中のセッションのチャンネルのターンの番号と中断（key は channelId。ターンが終わったら消す） */
  const running = new Map<string, { turnSeq: number; controller: AbortController }>();
  /**
   * 最後に振ったターンの番号（セッションのチャンネルのターンごとに 1 ずつ増やす。[中断] のボタンに入れる）。
   * 開始値は handler を作った時刻のミリ秒にし、再起動しても前の番号（残ったボタン）と重ならないようにする
   */
  let lastTurnSeq = now().getTime();

  /** セッションが待ち・完了なら進行中に戻して進行中カテゴリへ移す（知らせは返信の先頭に付ける）。戻したら true */
  const revive = (session: Pick<TopicSession, "channelId" | "guildId" | "state">): boolean => {
    if (applySessionEvent(session, "message", { topicSessions, channelOps }).move === null) return false;
    log(`発言があったためセッションを進行中に戻しました（guild=${session.guildId}）`);
    return true;
  };

  /** 返信の失敗は log に出して終える（再試行しない）。返信先が無ければ普通の投稿にする */
  const reply = async (request: TurnRequest, text: string): Promise<void> => {
    try {
      await gateway.send(request.channelId, text, request.replyToId);
    } catch (error) {
      log(`返信に失敗しました: ${describeError(error)}`);
    }
  };

  /** ボタン付きの返信（返信先は付けない）。失敗は log に出して終える */
  const replyWithButtons = async (request: TurnRequest, message: OutgoingMessage): Promise<void> => {
    try {
      await gateway.sendMessage(request.channelId, message);
    } catch (error) {
      log(`返信に失敗しました: ${describeError(error)}`);
    }
  };

  /**
   * セッションのチャンネルのターンの途中経過（progress.ts）。開始から PROGRESS_DELAY_MS 経っても終わっていなければ、そのターンの番号の [中断] 付きのメッセージを
   * そのチャンネルに 1 つ送り、以後は表示が変わっていれば書き換える。終わったら終わり方に書き換えてボタンを外す
   */
  const startTurnProgress = (channelId: string, turnSeq: number) =>
    startProgress({
      send: (message) => gateway.sendMessage(channelId, message),
      edit: (messageId, message) => gateway.editMessage(channelId, messageId, message),
      buttons: [abortTurnButton(channelId, turnSeq)],
      delayMs: PROGRESS_DELAY_MS,
      now,
      ...(timers === undefined ? {} : { timers }),
      log,
    });

  /**
   * channelName は prompt の日時ヘッダに入れるチャンネル名。revivedBeforeQueue はキュー待ちの前に進行中に戻したか。
   * セッションはキュー待ちの間に変わりうる（/close の確定で完了になる等）ので、ここで読み直して待ち・完了なら改めて進行中に戻す。
   * セッションのチャンネルのターンは、番号を振って実行中の間だけ中断できるようにし、途中経過を出す
   */
  const handleTurn = async (request: TurnRequest, channelName: string, revivedBeforeQueue: boolean): Promise<void> => {
    const { guildId, channelId, kind } = request;
    const current = kind === "session" ? topicSessions.get(channelId) : undefined;
    const revived = (current !== undefined && revive(current)) || revivedBeforeQueue;
    // 画像はキューの中で取る（同じチャンネルの発言の順を崩さない）。渡せなかったものはヘッダの次に注記し、オーナーにも返す
    const prepared = await prepareTurnImages(request);
    const failedReply = prepared === undefined ? undefined : attachmentReply(prepared);
    const images = prepared?.images ?? [];
    // 本文も渡せる画像も残らなければ（読めない添付だけの発言を含む）ターンは行わず、理由（と進行中に戻したこと）だけを返す
    if (request.content.trim() === "" && images.length === 0) {
      const lines = [
        ...(revived ? [REVIVED_NOTE] : []),
        ...(failedReply === undefined ? [] : [failedReply]),
        ...attachmentNotes(request.attachments?.skipped, undefined),
      ];
      if (lines.length > 0) {
        await reply(request, lines.join("\n"));
        recordHistory(
          history,
          { guildId, channelId, kind: "notice", source: request.source, persona: personaOf(channelId), text: lines.join("\n") },
          log,
        );
      }
      return;
    }
    if (failedReply !== undefined) await reply(request, failedReply);
    const notes = attachmentNotes(request.attachments?.skipped, prepared);
    const body = [...notes, ...(request.content.trim() === "" ? [] : [request.content])].join("\n");
    const stopTyping = gateway.startTyping(channelId);
    const turn = kind === "session" ? { turnSeq: ++lastTurnSeq, controller: new AbortController() } : undefined;
    if (turn !== undefined) running.set(channelId, turn);
    const progress = turn === undefined ? undefined : startTurnProgress(channelId, turn.turnSeq);
    const persona = personaOf(channelId);
    // 進行中に戻したことは、返事とは別の行に残す（返事の行の text には付けない）
    if (revived) recordHistory(history, { guildId, channelId, kind: "notice", source: request.source, persona, text: REVIVED_NOTE }, log);
    // history に残す手順の label（history があるときだけ集める）。途中経過にもそのまま渡す
    const steps: string[] = [];
    const onProgress =
      history === undefined
        ? progress?.onProgress
        : (step: { label: string }) => {
            if (steps.length < HISTORY_STEPS_COLLECT_MAX) steps.push(step.label);
            progress?.onProgress(step);
          };
    const startedAt = now().getTime();
    let result: RunResult | undefined;
    try {
      // 会話の単位はチャンネル（key は channelId）
      result = await runChannelTurn(turnDeps, {
        guildId,
        channelId,
        kind,
        // 日時はキュー待ちでずれないよう、発言の時刻（[続ける] は押した時刻）を使う
        prompt: buildTurnPrompt(body, request.at, cfg.timeZone, channelName),
        ...(images.length === 0 ? {} : { images }),
        ...(prepared === undefined || prepared.attachmentIds.length === 0 ? {} : { attachmentIds: prepared.attachmentIds }),
        // WebFetch で取得できるのは、この発言に貼られた URL だけ
        allowedUrls: extractUrls(request.content),
        ...(turn === undefined ? {} : { signal: turn.controller.signal }),
        ...(onProgress === undefined ? {} : { onProgress }),
      });
    } finally {
      stopTyping();
      if (turn !== undefined && running.get(channelId) === turn) running.delete(channelId);
      // 途中経過のタイマーはターンの終わりで必ず止める
      await progress?.finish(turnOutcome(result));
    }

    const finished = result;
    // 返事の行は返信の後に書く（text は REVIVED_NOTE を付ける前の返信の本文）
    const recordReply = (text: string): void => {
      recordHistory(
        history,
        {
          guildId,
          channelId,
          kind: "agent",
          source: request.source,
          persona,
          text,
          outcome: turnOutcome(finished),
          steps,
          toolCalls: finished.toolCalls,
          durationMs: finished.ok ? finished.durationMs : now().getTime() - startedAt,
        },
        log,
      );
    };

    if (result.ok) {
      const body = result.text.trim() === "" ? EMPTY_REPLY : result.text;
      const text = result.compacted === undefined ? body : `${body}\n${COMPACTED_NOTE}`;
      await reply(request, revived ? `${REVIVED_NOTE}\n${text}` : text);
      recordReply(text);
      return;
    }

    log(`ターンが失敗しました: ${result.errorMessage}`);
    if (result.errorMessage === ABORTED_ERROR) {
      await reply(request, ABORTED_REPLY);
      recordReply(ABORTED_REPLY);
      return;
    }
    // sdk-runner は result の失敗を subtype から書き始める
    if (!result.errorMessage.startsWith(MAX_TURNS_ERROR_PREFIX)) {
      await reply(request, FAILURE_REPLY);
      recordReply(FAILURE_REPLY);
      return;
    }
    // セッションのチャンネルだけ [続ける] を付ける
    if (kind === "session") {
      await replyWithButtons(request, {
        text: MAX_TURNS_REPLY,
        components: [{ kind: "buttons", buttons: [continueTurnButton(channelId)] }],
      });
      recordReply(MAX_TURNS_REPLY);
      return;
    }
    await reply(request, MAX_TURNS_REPLY);
    recordReply(MAX_TURNS_REPLY);
  };

  /**
   * 発言の画像を取る（入力中表示を出しながら）。画像が無い・取る手段が無ければ undefined。
   * 投げたら（prepareImages は reject しないはず）全部を取得の失敗として扱う。log は枚数だけ
   */
  const prepareTurnImages = async (request: TurnRequest): Promise<PreparedImages | undefined> => {
    const attachments = request.attachments;
    if (attachments === undefined || attachments.images.length === 0 || prepareImages === undefined) return undefined;
    const stopTyping = gateway.startTyping(request.channelId);
    let prepared: PreparedImages;
    try {
      prepared = await prepareImages(
        { guildId: request.guildId, channelId: request.channelId, messageId: attachments.messageId },
        attachments.images,
      );
    } catch {
      prepared = { images: [], attachmentIds: [], tooLarge: 0, failed: attachments.images.length };
    } finally {
      stopTyping();
    }
    log(
      `画像を受け取りました（渡す ${prepared.images.length} 枚・大きすぎ ${prepared.tooLarge} 枚・取得失敗 ${prepared.failed} 枚）`,
    );
    return prepared;
  };

  /** 受け付けた依頼をキューに入れる（発言と [続ける] で共通） */
  const submit = async (request: TurnRequest): Promise<void> => {
    // 日時ヘッダのチャンネル名（#inbox・#tasks。セッションは題名）
    let channelName = request.kind === "tasks" ? "tasks" : "inbox";
    let revived = false;
    if (request.kind === "session") {
      // 最終発言の時刻はキュー待ちの前に記録する。日時ヘッダには題名を出す
      const session = topicSessions.touch(request.channelId);
      if (session === undefined) return;
      channelName = session.title;
      // 待ち・完了なら進行中に戻して進行中カテゴリへ移す（ターンは通常どおり行い、返信の先頭で知らせる）
      revived = revive(session);
    }
    // オーナーの発言の行はキューに入れる前に書く（Web の発言は呼び出し側が先に書いている）
    if (request.historyId === undefined) {
      const messageId = request.attachments?.messageId ?? request.replyToId;
      recordHistory(
        history,
        {
          guildId: request.guildId,
          channelId: request.channelId,
          kind: "owner",
          source: request.source,
          persona: personaOf(request.channelId),
          text: ownerText(request),
          ...(messageId === undefined ? {} : { messageId }),
        },
        log,
      );
    }
    // セッションのターンは同時実行の枠を 1 つ #inbox・#tasks 用に残す
    await queue.run(request.channelId, () => handleTurn(request, channelName, revived), {
      session: request.kind === "session",
    });
  };

  return {
    handleMessage: async (event) => {
      try {
        // 受付判定は DB を引くので try の中で行う
        const kind = acceptedChannel(event, cfg, resolveChannel, ownerOf);
        // 受け付けた発言は必ずサーバー内（guildId は null でない）
        if (kind === null || event.guildId === null) return;
        await submit({
          guildId: event.guildId,
          channelId: event.channelId,
          kind,
          content: event.content,
          at: event.createdAt,
          replyToId: event.id,
          source: "discord",
          ...(event.images === undefined && event.skippedAttachments === undefined
            ? {}
            : {
                attachments: {
                  messageId: event.id,
                  images: event.images ?? [],
                  ...(event.skippedAttachments === undefined ? {} : { skipped: event.skippedAttachments }),
                },
              }),
        });
      } catch (error) {
        log(`ターンの処理中にエラーが発生しました: ${describeError(error)}`);
      }
    },
    continueTurn: async (guildId, channelId, at) => {
      try {
        if (resolveChannel(guildId, channelId) !== "session") return;
        await submit({ guildId, channelId, kind: "session", content: CONTINUE_PROMPT, at, source: "discord" });
      } catch (error) {
        log(`ターンの処理中にエラーが発生しました: ${describeError(error)}`);
      }
    },
    abortTurn: (channelId, turnSeq) => {
      const turn = running.get(channelId);
      if (turn === undefined || turn.turnSeq !== turnSeq) return false;
      turn.controller.abort();
      return true;
    },
  };
}
