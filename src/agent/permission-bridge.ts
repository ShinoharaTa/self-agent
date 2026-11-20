// プロジェクトのセッションの許可の橋（docs/plan/unify.md §5.1）。SDK の canUseTool を受けて cc_permissions に origin sdk・pending の行を作り、
// そのセッションのチャンネルに Claude Code の許可の要求と同じ 1 通（cc/notice-text.ts の permissionNotice。ボタンは cc:perm:*）を持ち主の Bot で出し、
// cc/permission-hold.ts の holdExternal で保留する。答えは今までどおり Web の /api/cc/permissions/<id>/allow|always|deny と Discord の cc:perm:* が
// hold.answer で返し、閉じた後の行から PermissionResult を作る: allowed → allow、allowed_always → allow + updatedPermissions（destination は必ず session）、
// denied → deny、時間切れ（expired）→ deny（headless には端末のダイアログが無いので fail-closed）、ターンの中断・停止（released）→ deny。
// 1 セッションに pending は 1 件なので、同じセッションの要求は前のものが閉じるまで待つ。
// AskUserQuestion は質問の行（question_input 付き。常に許可のルールは持たない）にして、質問の 1 通（questionNotice。ボタンは cc:q:*）を出し、
// SELF_AGENT_CC_QUESTION_HOLD_SEC の間保留する。答えは allow + updatedInput（元の input + answers）、[やめる]・時間切れ・中断は deny。
// 読めない形の質問は行も 1 通も作らずに deny（本文で訊かせる）。
// log は「プロジェクトのセッション: 許可の要求（#id）→ <状態>（<経路>）」「プロジェクトのセッション: 質問（#id）→ <状態>（<経路>）」だけ
// （ツール名・要約・パス・問の文・答え・セッションの ID は出さない）
import { join } from "node:path";
import type { CanUseTool, PermissionResult } from "@anthropic-ai/claude-agent-sdk";
import { summarizePermission } from "../cc/hook-server.ts";
import {
  type CcNoticeSession,
  permissionHistoryText,
  permissionNotice,
  permissionResolvedMessage,
  permissionResultHistoryText,
  questionNotice,
} from "../cc/notice-text.ts";
import type { CcPermissionHold } from "../cc/permission-hold.ts";
import { alwaysRulesOf, sessionRulesUpdate } from "../cc/permissions.ts";
import { CC_QUESTION_TOOL, type CcQuestion, type CcQuestionPick, parseQuestionInput } from "../cc/questions.ts";
import { type Config, DEFAULT_PERSONA_ID } from "../config.ts";
import type { OutgoingMessage } from "../discord/gateway.ts";
import type { OwnerPosts } from "../app/personas.ts";
import type { CcPermissionRow, CcPermissionStore } from "../store/cc-permissions.ts";
import { type HistoryStore, recordHistory } from "../store/history.ts";
import type { TopicSessionStore } from "../store/topic-sessions.ts";
import type { RunContext } from "./runner.ts";
import type { ProfileRunState } from "./sdk-runner.ts";

/** [拒否] の message（モデルに渡る） */
export const PROJECT_PERMISSION_DENY_MESSAGE = "self-agent（Discord / Web）から拒否しました";
/** session_id が分からず保留できなかったときの message */
export const PROJECT_PERMISSION_NO_SESSION_MESSAGE = "self-agent で許可を確かめられませんでした";
/** /close・/renew の要約のターン（purpose close・renew）でツールを拒否したときの message */
export const PROJECT_PERMISSION_SUMMARY_TURN_MESSAGE = "要約のターンではツールを使えません";
/** ターンの中断・停止で保留をやめたときの message */
export const PROJECT_PERMISSION_ABORT_MESSAGE = "self-agent でターンが止まったため拒否しました";

/** 許可の橋がまだ無い（Claude Code の連携の配線の前・動いていない）ときの canUseTool。すべて拒否する（fail-closed） */
export const denyAllPermissions: CanUseTool = async () => ({ behavior: "deny", message: PROJECT_PERMISSION_NO_SESSION_MESSAGE });

/** 時間切れの message（holdSec 秒） */
export function projectPermissionTimeoutMessage(holdSec: number): string {
  return `self-agent で時間切れ（${holdSec} 秒）`;
}

/** 閉じた後の行から PermissionResult を作る（純関数）。allowed_always のルールは行の always_rules を destination session で返す */
export function permissionResultOf(row: Pick<CcPermissionRow, "state" | "alwaysRules">, holdSec: number): PermissionResult {
  switch (row.state) {
    case "allowed":
      return { behavior: "allow" };
    case "allowed_always":
      // 提案（suggestions）の destination は localSettings（リポジトリの中の設定ファイルに書かれる。U0）なので、行のルールから session で作り直す
      return row.alwaysRules === null || row.alwaysRules.length === 0
        ? { behavior: "allow" }
        : { behavior: "allow", updatedPermissions: sessionRulesUpdate(row.alwaysRules) };
    case "denied":
      return { behavior: "deny", message: PROJECT_PERMISSION_DENY_MESSAGE };
    case "expired":
      return { behavior: "deny", message: projectPermissionTimeoutMessage(holdSec) };
    default:
      // released（中断・停止）・answered_elsewhere（起きない）・pending（起きない）は拒否
      return { behavior: "deny", message: PROJECT_PERMISSION_ABORT_MESSAGE };
  }
}

/** 質問の [やめる] の message（モデルに渡る） */
export const PROJECT_QUESTION_DROP_MESSAGE =
  "オーナーは選択肢で答えずに閉じました。同じ質問を繰り返さず、必要なら訊きたいことを本文に書いてください";
/** 読めない形の質問の message（行もカードも作らない） */
export const PROJECT_QUESTION_UNREADABLE_MESSAGE =
  "この形の質問は self-agent で出せません（問は 1〜4 個、選択肢は問ごとに 2〜8 個、問の文と選択肢の名前はそれぞれ重ならないこと）。形を直すか、本文で訊いてください";

/** 質問の時間切れの message（holdSec 秒） */
export function projectQuestionTimeoutMessage(holdSec: number): string {
  return `質問は時間切れになりました（${holdSec} 秒）。オーナーはまだ答えていません。答えを推測して進めず、訊きたいことを本文に書いてこのターンを終えてください`;
}

/** 閉じた質問の行から canUseTool の結果を作る（純関数）。input は canUseTool が受けた tool_input */
export function questionResultOf(
  row: Pick<CcPermissionRow, "state" | "answers">,
  input: Record<string, unknown>,
  holdSec: number,
): PermissionResult {
  switch (row.state) {
    case "allowed":
      // 答えが無い allowed は起きないはず（fail-closed）
      return row.answers === null || Object.keys(row.answers).length === 0
        ? { behavior: "deny", message: PROJECT_PERMISSION_NO_SESSION_MESSAGE }
        : { behavior: "allow", updatedInput: { ...input, answers: row.answers } };
    case "denied":
      return { behavior: "deny", message: PROJECT_QUESTION_DROP_MESSAGE };
    case "expired":
      return { behavior: "deny", message: projectQuestionTimeoutMessage(holdSec) };
    default:
      // released（中断・停止）・allowed_always（質問の行には起きない）などは拒否
      return { behavior: "deny", message: PROJECT_PERMISSION_ABORT_MESSAGE };
  }
}

/** 許可の要求をチャンネルに出す・書き換える口（createPermissionPoster）。投げない */
export type PermissionPoster = {
  /** pending の行の 1 通をそのセッションのチャンネルに出して permissions.setMessage する。Web の会話にも「許可を待っています」を書く */
  post(context: RunContext, row: CcPermissionRow): Promise<void>;
  /** 閉じた行（post の後）。Discord で押したもの以外は 1 通を書き換えてボタンを外す。Web の会話に結果を書く */
  resolved(context: RunContext, row: CcPermissionRow): Promise<void>;
};

export type PermissionBridgeDeps = {
  permissions: Pick<CcPermissionStore, "add" | "get">;
  hold: Pick<CcPermissionHold, "holdExternal">;
  poster: PermissionPoster;
  /** 保留の長さ（SELF_AGENT_CC_PERMISSION_HOLD_SEC の秒） */
  holdSec: number;
  /** 質問の保留の長さ（SELF_AGENT_CC_QUESTION_HOLD_SEC の秒） */
  questionHoldSec: number;
  /** 常に許可のファイルのルールの線引き（cc/permissions.ts の ruleContext）と、要約の相対パスの元 */
  workspaceDir: string;
  home: string;
  log: (message: string) => void;
};

/** プロジェクトのセッションの cwd（`<workspaceDir>/<projectDir>`） */
function projectCwd(workspaceDir: string, context: RunContext): string | undefined {
  return context.projectDir === undefined ? undefined : join(workspaceDir, context.projectDir);
}

/** SDK の title を要約の前に添えるときの上限（字） */
const TITLE_MAX_CHARS = 200;

/**
 * カードの要約（純関数）。常に tool_input から作った要約（summarizePermission。request_hash・常に許可のルールと同じ入力から作るので、
 * 見たものと許すものが合う）を出し、SDK の title があればその前の 1 行に添える（制御文字は空白、先頭 200 字）
 */
export function bridgeSummary(summary: string, title: string | undefined): string {
  if (title === undefined || title.trim() === "") return summary;
  const line = [...title.replace(/[\u0000-\u001f\u007f]/g, " ").trim()].slice(0, TITLE_MAX_CHARS).join("");
  return `${line}\n${summary}`;
}

/**
 * 許可の橋を作る。返す関数は run ごとに、その run の context と session_id（runner が init で受けたもの。resume なら元の id）と
 * run（sdk-runner.ts の ProfileRunState）から canUseTool を作る（project-profile.ts の buildOptions が呼ぶ）。保留は canUseTool の signal と
 * run の signal（[中断]・打ち切り。query の abortController より先に abort される）のどちらが鳴ってもやめる（SDK が query の abort で
 * canUseTool の signal をすぐ鳴らさない場合に備える）。保留している間（前の要求を待つ間を含む）は run の waitPermission で打ち切りを止めて途中経過に出す
 */
export function createPermissionBridge(
  deps: PermissionBridgeDeps,
): (
  context: RunContext,
  sessionId: () => string | undefined,
  run?: Pick<ProfileRunState, "waitPermission" | "signal">,
) => CanUseTool {
  const { permissions, hold, poster, holdSec, questionHoldSec, workspaceDir, home, log } = deps;
  /** セッション → 前の要求が閉じるまでの Promise（1 セッションに pending は 1 件のため、同じセッションの要求は順に） */
  const chains = new Map<string, Promise<unknown>>();

  const handle = async (
    context: RunContext,
    sessionId: string,
    toolName: string,
    input: Record<string, unknown>,
    options: Parameters<CanUseTool>[2],
    signal: AbortSignal,
  ): Promise<PermissionResult> => {
    // 前の要求を待っている間にターンが止まっていれば、行もカードも作らない
    if (signal.aborted) {
      log("プロジェクトのセッション: ターンが止まったため許可の要求を出さずに拒否しました");
      return { behavior: "deny", message: PROJECT_PERMISSION_ABORT_MESSAGE };
    }
    const cwd = projectCwd(workspaceDir, context);
    const summarized = summarizePermission(toolName, input, cwd);
    const question = toolName === CC_QUESTION_TOOL;
    // 読めない形の質問は行も 1 通も作らない（本文で訊かせる）
    if (question && summarized.questionInput === undefined) {
      log("プロジェクトのセッション: 読めない形の質問を出さずに断りました");
      return { behavior: "deny", message: PROJECT_QUESTION_UNREADABLE_MESSAGE };
    }
    const row = permissions.add({
      sessionId,
      requestHash: summarized.requestHash,
      toolName,
      permissionMode: context.permissionMode ?? "default",
      state: "pending",
      origin: "sdk",
      ...(question
        ? { summary: summarized.summary, alwaysRules: null, questionInput: summarized.questionInput }
        : {
            summary: bridgeSummary(summarized.summary, options.title),
            alwaysRules: alwaysRulesOf(toolName, options.suggestions, { cwd, workspaceDir, home }),
          }),
    });
    const sec = question ? questionHoldSec : holdSec;
    // 先に保留に登録する（投稿の間に Web で押されても答えられるように）
    const closing = hold.holdExternal(row, sec * 1000, signal);
    await poster.post(context, row).catch(() => undefined);
    const closed = await closing;
    const final = permissions.get(row.id) ?? closed;
    log(`プロジェクトのセッション: ${question ? "質問" : "許可の要求"}（#${row.id}）→ ${final.state}${final.via === null ? "" : `（${final.via}）`}`);
    await poster.resolved(context, final).catch(() => undefined);
    return question ? questionResultOf(final, input, sec) : permissionResultOf(final, holdSec);
  };

  return (context, sessionId, run) => async (toolName, input, options) => {
    // 要約のターン（/close・/renew）はカードを出さず、行も作らずに全部拒否する
    if (context.purpose === "close" || context.purpose === "renew") {
      log(`プロジェクトのセッション: 要約のターンのツールを拒否しました（${context.purpose}）`);
      return { behavior: "deny", message: PROJECT_PERMISSION_SUMMARY_TURN_MESSAGE };
    }
    const id = sessionId();
    if (id === undefined) {
      log("プロジェクトのセッション: session_id が分からないため許可の要求を拒否しました");
      return { behavior: "deny", message: PROJECT_PERMISSION_NO_SESSION_MESSAGE };
    }
    const signal = run?.signal === undefined ? options.signal : AbortSignal.any([options.signal, run.signal]);
    const endWaiting = run?.waitPermission?.({
      toolName,
      ...(options.displayName === undefined ? {} : { displayName: options.displayName }),
    });
    const previous = chains.get(id) ?? Promise.resolve();
    const current = previous.then(
      () => handle(context, id, toolName, input, options, signal),
      () => handle(context, id, toolName, input, options, signal),
    );
    chains.set(id, current);
    try {
      return await current;
    } catch (error) {
      // 行を作れない・保留できない（fail-closed）
      log(`プロジェクトのセッション: 許可の要求を処理できなかったため拒否しました（${error instanceof Error ? error.name : typeof error}）`);
      return { behavior: "deny", message: PROJECT_PERMISSION_NO_SESSION_MESSAGE };
    } finally {
      endWaiting?.();
      if (chains.get(id) === current) chains.delete(id);
    }
  };
}

/** Discord のボタン（app/commands/cc.ts の resolvedMessage）の書き換え後の 1 通とその場所 */
export type ResolvedPermissionMessage = { message: OutgoingMessage; channelId: string | null; messageId: string | null };

/**
 * 終わった許可の要求の 1 通を、行の origin で作り分ける（main の cc:perm の resolvedMessage）。origin sdk（プロジェクトのセッション）は sdk
 * （createPermissionPoster。題名・プロジェクト・端末なし）、それ以外は hook（cc/channel-posts.ts）。行が無ければ hook に任せる
 */
export function resolvedMessageByOrigin(deps: {
  permissions: Pick<CcPermissionStore, "get">;
  sdk: (id: number) => ResolvedPermissionMessage | undefined;
  hook: (id: number) => ResolvedPermissionMessage | undefined;
}): (id: number) => ResolvedPermissionMessage | undefined {
  return (id) => (deps.permissions.get(id)?.origin === "sdk" ? deps.sdk(id) : deps.hook(id));
}

/** cc:q の今の問と次の 1 通を作る口（createPermissionPoster と cc/channel-posts.ts の CcChannelPosts が持つ） */
export type QuestionPlaces = {
  /** 保留中（pending）の質問の行の問と request_hash。行が無い・pending でない・question_input が読めなければ undefined */
  pendingQuestion(id: number): { requestHash: string; questions: CcQuestion[] } | undefined;
  /** 質問の次の問の 1 通とその場所（picks は答えた問の答え）。行が無い・質問でなければ undefined */
  questionStepMessage(id: number, picks: readonly CcQuestionPick[]): ResolvedPermissionMessage | undefined;
};

/** cc:q の「今の問」と「次の 1 通」を、行の origin で作り分ける（main の questions）。行が無ければ hook に任せる */
export function questionPlacesByOrigin(deps: {
  permissions: Pick<CcPermissionStore, "get">;
  sdk: QuestionPlaces;
  hook: QuestionPlaces;
}): { pendingQuestion: QuestionPlaces["pendingQuestion"]; stepMessage: QuestionPlaces["questionStepMessage"] } {
  const placesOf = (id: number): QuestionPlaces => (deps.permissions.get(id)?.origin === "sdk" ? deps.sdk : deps.hook);
  return {
    pendingQuestion: (id) => placesOf(id).pendingQuestion(id),
    stepMessage: (id, picks) => placesOf(id).questionStepMessage(id, picks),
  };
}

export type PermissionPosterDeps = {
  /** 投稿・書き換え（持ち主の Bot。app/personas.ts の ownerPosts） */
  gateway: Pick<OwnerPosts, "sendMessage" | "editMessage">;
  permissions: Pick<CcPermissionStore, "get" | "setMessage">;
  /** 1 通の名前（題名）とディレクトリ（プロジェクト） */
  topicSessions: Pick<TopicSessionStore, "get" | "projectDirOf">;
  cfg: Pick<Config, "ownerUserId" | "workspaceDir">;
  home: string;
  /** ボタンが効く時間（SELF_AGENT_CC_PERMISSION_HOLD_SEC） */
  holdSec: number;
  /** 質問のボタンが効く時間（SELF_AGENT_CC_QUESTION_HOLD_SEC） */
  questionHoldSec: number;
  /** Web UI の会話の記録（Web UI が有効なときだけ） */
  history?: Pick<HistoryStore, "add">;
  log: (message: string) => void;
};

function errorKind(error: unknown): string {
  return error instanceof Error ? error.name : typeof error;
}

/** 許可の要求の 1 通の出し方（そのセッションのチャンネルに、持ち主の Bot で）と、Discord のボタンの応答の書き換え（resolvedMessage） */
export function createPermissionPoster(deps: PermissionPosterDeps): PermissionPoster &
  QuestionPlaces & {
  /** Discord で押した sdk の行の書き換え後の 1 通とその場所（app/commands/cc.ts の応答）。行が無ければ undefined */
  resolvedMessage(id: number): { message: OutgoingMessage; channelId: string | null; messageId: string | null } | undefined;
  /** 再起動の前に保留していて expired にした sdk の行の 1 通を書き換える（Discord につないだ後）。待たない */
  rewriteRecovered(rows: readonly CcPermissionRow[]): void;
} {
  const { gateway, permissions, topicSessions, cfg, home, holdSec, questionHoldSec, history, log } = deps;
  const places = { workspaceDir: cfg.workspaceDir, home };
  /** 1 通の名前（セッションの題名）とディレクトリ（プロジェクト）。RC のリンクは無い */
  const sessionOf = (channelId: string): CcNoticeSession => {
    const project = topicSessions.projectDirOf(channelId);
    return {
      name: topicSessions.get(channelId)?.title ?? null,
      cwd: project === undefined ? null : join(cfg.workspaceDir, project.projectDir),
    };
  };
  const record = (context: Pick<RunContext, "guildId" | "channelId">, text: string): void => {
    recordHistory(
      history,
      { guildId: context.guildId, channelId: context.channelId, kind: "notice", source: "system", persona: DEFAULT_PERSONA_ID, text },
      log,
    );
  };
  const edit = async (row: CcPermissionRow): Promise<void> => {
    if (row.messageId === null || row.messageChannelId === null) return;
    try {
      await gateway.editMessage(
        row.messageChannelId,
        row.messageId,
        permissionResolvedMessage(row, sessionOf(row.messageChannelId), places, false),
      );
    } catch (error) {
      log(`プロジェクトのセッション: 許可の要求（#${row.id}）の知らせを書き換えられませんでした（${errorKind(error)}）`);
    }
  };
  return {
    async post(context, row) {
      const message = permissionNotice(row, sessionOf(context.channelId), {
        ...places,
        holdSec: row.questionInput !== null ? questionHoldSec : holdSec,
        ownerUserId: cfg.ownerUserId,
        // 端末・RC のダイアログは無い（時間切れは拒否）
        terminal: false,
      });
      record(context, permissionHistoryText(row));
      let messageId: string;
      try {
        messageId = await gateway.sendMessage(context.channelId, { ...message, suppressEmbeds: true });
      } catch (error) {
        log(`プロジェクトのセッション: 許可の要求（#${row.id}）をチャンネルに出せませんでした（${errorKind(error)}）`);
        return;
      }
      permissions.setMessage(row.id, context.channelId, messageId);
    },
    async resolved(context, row) {
      const text = permissionResultHistoryText(row, false);
      if (text !== undefined) record(context, text);
      // Discord で押したものは app/commands/cc.ts が応答で書き換える
      if (row.via === "discord") return;
      await edit(permissions.get(row.id) ?? row);
    },
    resolvedMessage(id) {
      const row = permissions.get(id);
      if (row === undefined) return undefined;
      const session = row.messageChannelId === null ? undefined : sessionOf(row.messageChannelId);
      return {
        message: { ...permissionResolvedMessage(row, session, places, false), suppressEmbeds: true },
        channelId: row.messageChannelId,
        messageId: row.messageId,
      };
    },
    pendingQuestion(id) {
      const row = permissions.get(id);
      if (row === undefined || row.state !== "pending") return undefined;
      const parsed = parseQuestionInput(row.questionInput);
      return parsed === undefined ? undefined : { requestHash: row.requestHash, questions: parsed.questions };
    },
    questionStepMessage(id, picks) {
      const row = permissions.get(id);
      const parsed = parseQuestionInput(row?.questionInput ?? null);
      if (row === undefined || parsed === undefined) return undefined;
      const session = row.messageChannelId === null ? undefined : sessionOf(row.messageChannelId);
      // 書き換えでは鳴らさないのでメンションは付けない
      const message = questionNotice(row, parsed.questions, picks, session, { ...places, holdSec: questionHoldSec, terminal: false });
      return { message: { ...message, suppressEmbeds: true }, channelId: row.messageChannelId, messageId: row.messageId };
    },
    rewriteRecovered(rows) {
      for (const row of rows) {
        if (row.origin !== "sdk") continue;
        void edit(row);
      }
    },
  };
}
