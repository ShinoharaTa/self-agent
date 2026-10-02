// セッションの状態の遷移（進行中 / 待ち / 完了 / 削除済み）。transition は純関数、applySessionEvent が DB とカテゴリの移動に反映する
import type { TopicSession, TopicSessionState, TopicSessionStore } from "../store/topic-sessions.ts";
import type { ChannelOpsQueue } from "./channel-ops.ts";

/**
 * 状態を変えるきっかけ。message はセッションのチャンネルでの発言、wait は /wait、continue は [続ける]、
 * idle は最後の発言から SELF_AGENT_IDLE_HOURS 経ったこと（scheduler.ts）、close は /close の確定
 */
export type SessionEvent = "message" | "wait" | "continue" | "idle" | "close";

export type Transition = {
  next: TopicSessionState;
  /** 移す先の状態カテゴリ。移さないなら null */
  move: "active" | "waiting" | null;
};

/**
 * 遷移表。進行中 + idle・wait → 待ち、待ち・完了 + message・continue → 進行中、close → 完了（完了にする処理と移動は /close の確定が行う）。
 * 削除済みは何も変えない。それ以外は変化なし
 */
export function transition(state: TopicSessionState, event: SessionEvent): Transition {
  const unchanged: Transition = { next: state, move: null };
  if (state === "deleted") return unchanged;
  switch (event) {
    case "close":
      return { next: "done", move: null };
    case "idle":
    case "wait":
      return state === "active" ? { next: "waiting", move: "waiting" } : unchanged;
    case "message":
    case "continue":
      return state === "waiting" || state === "done" ? { next: "active", move: "active" } : unchanged;
  }
}

export type SessionEventDeps = {
  topicSessions: Pick<TopicSessionStore, "setActive" | "setWaiting">;
  channelOps: Pick<ChannelOpsQueue, "enqueueMove">;
};

/**
 * 遷移を DB に反映し、状態カテゴリへの移動を列に入れる（DB を先に更新する。await は挟まない）。
 * 待ちにしたら waiting_since を設定し、進行中に戻したら waiting_since と closed_at を消す。close は /close の確定が行うので受けない
 */
export function applySessionEvent(
  session: Pick<TopicSession, "channelId" | "guildId" | "state">,
  event: Exclude<SessionEvent, "close">,
  deps: SessionEventDeps,
): Transition {
  const result = transition(session.state, event);
  if (result.next === session.state) return result;
  if (result.next === "active") deps.topicSessions.setActive(session.channelId);
  if (result.next === "waiting") deps.topicSessions.setWaiting(session.channelId);
  if (result.move !== null) {
    deps.channelOps.enqueueMove(session.channelId, { kind: "state", guildId: session.guildId, state: result.move });
  }
  return result;
}
