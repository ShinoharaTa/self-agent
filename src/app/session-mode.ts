// プロジェクトのセッションの許可のモード（default・acceptEdits・plan）を見る・変える（docs/plan/terminal-handover.md の H4b）。
// DB（sessions.permission_mode）を書き換えるだけで、次のターンの Options の permissionMode から効く（app/turn.ts が毎ターン読む）。
// ターンの途中では変えない（実行中・枠待ち・場所の付け替え中は断る）。ただし計画の許可（by plan）は実行中のターンの中から default に戻す。
// Discord には出さない（返信・投稿は呼び出し側）。log にチャンネル ID・題名・プロジェクトの名前を出さない
import type { ProjectPermissionMode } from "../agent/runner.ts";
import { type HistoryStore, recordHistory } from "../store/history.ts";
import type { TopicMoveStore } from "../store/topic-moves.ts";
import type { TopicSessionStore } from "../store/topic-sessions.ts";

export type SetModeResult = "not_session" | "closed" | "not_project" | "busy" | "unchanged" | "changed";

export type SessionModeDeps = {
  topicSessions: Pick<TopicSessionStore, "get" | "projectDirOf" | "setPermissionMode">;
  /** 実行中のターン（handler.runningTurns） */
  runningTurns: () => ReadonlyArray<{ channelId: string }>;
  /** 発言のターンと同じキュー（key は channelId。has は枠待ち・前のジョブ待ちの発言） */
  turnQueue: { has(key: string): boolean };
  /** 場所の付け替え（/move）の記録。無ければ見ない */
  moves?: Pick<TopicMoveStore, "runningChannels">;
  /** Web UI の会話の記録（Web UI が有効なときだけ） */
  history: Pick<HistoryStore, "add"> | undefined;
  log: (message: string) => void;
};

export const MODE_LABELS = {
  default: "default（使うたびに確認）",
  acceptEdits: "acceptEdits（編集は確認なし）",
  plan: "plan（計画だけ）",
} as const;

export function modeChangedText(mode: ProjectPermissionMode): string {
  return `許可のモードを ${MODE_LABELS[mode]} にしました。次の発言から効きます`;
}
export const MODE_PLAN_NOTE = "plan では、計画ができると許可の要求が出ます。許可すると default に戻して進めます";
export const MODE_PLAN_APPROVED_TEXT = "計画を許可したので、許可のモードを default に戻しました";
export function modeNowText(mode: ProjectPermissionMode): string {
  return `今の許可のモードは ${MODE_LABELS[mode]} です`;
}
export function modeSameText(mode: ProjectPermissionMode): string {
  return `許可のモードはもう ${mode} です`;
}
export const MODE_NOT_SESSION_REPLY = "/mode はプロジェクトのセッションのチャンネルで使ってください";
export const MODE_NOT_PROJECT_REPLY = "このセッションはプロジェクトのセッションではありません。許可のモードはありません";
export const MODE_CLOSED_REPLY = "このセッションは閉じています";
export const MODE_BUSY_REPLY = "担当が作業中です。終わってから変えてください";
export const MODE_INVALID_REPLY = "選べるのは default・acceptEdits・plan です";
// PR 1 では使わない。実機でキャッシュが外れると分かったときに返事の末尾へ足す
export const MODE_CACHE_NOTE = "次の発言は、会話を読み直すので利用枠を多めに使います";

/** 変えたときの文（Discord の返信・Web からの投稿で同じ）。plan は 2 行目に MODE_PLAN_NOTE */
export function modeChangedReply(mode: ProjectPermissionMode): string {
  return mode === "plan" ? `${modeChangedText("plan")}\n${MODE_PLAN_NOTE}` : modeChangedText(mode);
}

/** 今のモード（検査は順 1〜3 だけ: セッションが在る・閉じていない・プロジェクトのセッション） */
export function sessionModeOf(
  guildId: string,
  channelId: string,
  deps: Pick<SessionModeDeps, "topicSessions">,
): { result: "not_session" | "closed" | "not_project" } | { result: "ok"; mode: ProjectPermissionMode } {
  const topic = deps.topicSessions.get(channelId);
  if (topic === undefined || topic.guildId !== guildId) return { result: "not_session" };
  if (topic.state === "done" || topic.state === "deleted") return { result: "closed" };
  const project = deps.topicSessions.projectDirOf(channelId);
  if (project === undefined) return { result: "not_project" };
  return { result: "ok", mode: project.permissionMode };
}

/**
 * 許可のモードを変える。断ったとき・同じモードのときは DB も history も触らない。変えたら history に notice を 1 行と log を 1 行。
 * by plan（計画の許可の後に default へ戻す）だけは実行中でも変える。今のモードが plan でなければ何もしない（unchanged）
 */
export function setSessionMode(
  input: { guildId: string; channelId: string; mode: ProjectPermissionMode; by: "discord" | "web" | "plan" },
  deps: SessionModeDeps,
): { result: SetModeResult; mode?: ProjectPermissionMode } {
  const { guildId, channelId, mode, by } = input;
  const now = sessionModeOf(guildId, channelId, deps);
  if (now.result !== "ok") return { result: now.result };
  // 計画の許可の後の戻しは、今 plan のときだけ（acceptEdits のセッションで ExitPlanMode が許可されても default に落とさない）
  if (by === "plan" && now.mode !== "plan") return { result: "unchanged", mode: now.mode };
  if (
    by !== "plan" &&
    (deps.runningTurns().some((running) => running.channelId === channelId) ||
      deps.turnQueue.has(channelId) ||
      deps.moves?.runningChannels().has(channelId) === true)
  ) {
    return { result: "busy" };
  }
  if (now.mode === mode) return { result: "unchanged", mode };
  if (!deps.topicSessions.setPermissionMode(channelId, mode)) return { result: "not_session" };
  recordHistory(
    deps.history,
    { guildId, channelId, kind: "notice", source: "system", text: by === "plan" ? MODE_PLAN_APPROVED_TEXT : modeChangedText(mode) },
    deps.log,
  );
  deps.log(`許可のモードを変えました（guild=${guildId}、${by}、${mode}）`);
  return { result: "changed", mode };
}
