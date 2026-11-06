// プロジェクトのセッションの許可の橋（docs/plan/unify.md §5.1）。SDK の canUseTool を受けて cc_permissions に origin sdk・pending の行を作り、
// そのセッションのチャンネルに Claude Code の許可の要求と同じ 1 通（cc/notice-text.ts の permissionNotice。ボタンは cc:perm:*）を持ち主の Bot で出し、
// cc/permission-hold.ts の holdExternal で保留する。答えは今までどおり Web の /api/cc/permissions/<id>/allow|always|deny と Discord の cc:perm:* が
// hold.answer で返し、閉じた後の行から PermissionResult を作る: allowed → allow、allowed_always → allow + updatedPermissions（destination は必ず session）、
// denied → deny、時間切れ（expired）→ deny（headless には端末のダイアログが無いので fail-closed）、ターンの中断・停止（released）→ deny。
// 1 セッションに pending は 1 件なので、同じセッションの要求は前のものが閉じるまで待つ。
// log は「プロジェクトのセッション: 許可の要求（#id）→ <状態>（<経路>）」だけ（ツール名・要約・パス・セッションの ID は出さない）
import { join } from "node:path";
import type { CanUseTool, PermissionResult } from "@anthropic-ai/claude-agent-sdk";
import { permissionHistoryText, permissionResultHistoryText } from "../cc/channel-posts.ts";
import { summarizePermission } from "../cc/hook-server.ts";
import {
  type CcNoticeSession,
  permissionNotice,
  permissionResolvedMessage,
} from "../cc/notice-text.ts";
import type { CcPermissionHold } from "../cc/permission-hold.ts";
import { alwaysRulesOf, sessionRulesUpdate } from "../cc/permissions.ts";
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
  /** 常に許可のファイルのルールの線引き（cc/permissions.ts の ruleContext）と、要約の相対パスの元 */
  workspaceDir: string;
  home: string;
  log: (message: string) => void;
};

/** プロジェクトのセッションの cwd（`<workspaceDir>/<projectDir>`） */
function projectCwd(workspaceDir: string, context: RunContext): string | undefined {
  return context.projectDir === undefined ? undefined : join(workspaceDir, context.projectDir);
}

/**
 * 許可の橋を作る。返す関数は run ごとに、その run の context と session_id（runner が init で受けたもの。resume なら元の id）から canUseTool を作る
 * （project-profile.ts の buildOptions が呼ぶ）。run（sdk-runner.ts の ProfileRunState）があれば、保留している間（前の要求を待つ間を含む）は
 * waitPermission で打ち切りを止めて途中経過に出し、run の signal（[中断]・打ち切り。query より先に abort される）でも保留をやめて拒否する
 */
export function createPermissionBridge(
  deps: PermissionBridgeDeps,
): (
  context: RunContext,
  sessionId: () => string | undefined,
  run?: Pick<ProfileRunState, "waitPermission" | "signal">,
) => CanUseTool {
  const { permissions, hold, poster, holdSec, workspaceDir, home, log } = deps;
  /** セッション → 前の要求が閉じるまでの Promise（1 セッションに pending は 1 件のため、同じセッションの要求は順に） */
  const chains = new Map<string, Promise<unknown>>();

  const handle = async (
    context: RunContext,
    sessionId: string,
    toolName: string,
    input: Record<string, unknown>,
    options: Parameters<CanUseTool>[2],
  ): Promise<PermissionResult> => {
    // 前の要求を待つ間にターンが止まっていれば、行もカードも作らずに拒否する
    if (options.signal.aborted) return { behavior: "deny", message: PROJECT_PERMISSION_ABORT_MESSAGE };
    const cwd = projectCwd(workspaceDir, context);
    const summarized = summarizePermission(toolName, input, cwd);
    const row = permissions.add({
      sessionId,
      requestHash: summarized.requestHash,
      toolName,
      summary: options.title ?? summarized.summary,
      permissionMode: context.permissionMode ?? "default",
      alwaysRules: alwaysRulesOf(toolName, options.suggestions, { cwd, workspaceDir, home }),
      state: "pending",
      origin: "sdk",
    });
    // 先に保留に登録する（投稿の間に Web で押されても答えられるように）
    const closing = hold.holdExternal(row, holdSec * 1000, options.signal);
    await poster.post(context, row).catch(() => undefined);
    const closed = await closing;
    const final = permissions.get(row.id) ?? closed;
    log(`プロジェクトのセッション: 許可の要求（#${row.id}）→ ${final.state}${final.via === null ? "" : `（${final.via}）`}`);
    await poster.resolved(context, final).catch(() => undefined);
    return permissionResultOf(final, holdSec);
  };

  return (context, sessionId, run) => async (toolName, input, sdkOptions) => {
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
    // SDK の signal（query の後始末）と run の signal（[中断]・打ち切り）のどちらでも保留をやめる
    const signal = run?.signal === undefined ? sdkOptions.signal : AbortSignal.any([sdkOptions.signal, run.signal]);
    const options = { ...sdkOptions, signal };
    const endWaiting = run?.waitPermission?.({
      toolName,
      ...(sdkOptions.displayName === undefined ? {} : { displayName: sdkOptions.displayName }),
    });
    const previous = chains.get(id) ?? Promise.resolve();
    const current = previous.then(
      () => handle(context, id, toolName, input, options),
      () => handle(context, id, toolName, input, options),
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
  /** Web UI の会話の記録（Web UI が有効なときだけ） */
  history?: Pick<HistoryStore, "add">;
  log: (message: string) => void;
};

function errorKind(error: unknown): string {
  return error instanceof Error ? error.name : typeof error;
}

/** 許可の要求の 1 通の出し方（そのセッションのチャンネルに、持ち主の Bot で）と、Discord のボタンの応答の書き換え（resolvedMessage） */
export function createPermissionPoster(deps: PermissionPosterDeps): PermissionPoster & {
  /** Discord で押した sdk の行の書き換え後の 1 通とその場所（app/commands/cc.ts の応答）。行が無ければ undefined */
  resolvedMessage(id: number): { message: OutgoingMessage; channelId: string | null; messageId: string | null } | undefined;
  /** 再起動の前に保留していて expired にした sdk の行の 1 通を書き換える（Discord につないだ後）。待たない */
  rewriteRecovered(rows: readonly CcPermissionRow[]): void;
} {
  const { gateway, permissions, topicSessions, cfg, home, holdSec, history, log } = deps;
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
        holdSec,
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
    rewriteRecovered(rows) {
      for (const row of rows) {
        if (row.origin !== "sdk") continue;
        void edit(row);
      }
    },
  };
}
