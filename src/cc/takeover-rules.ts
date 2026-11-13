// 取り込み（docs/plan/takeover.md。#341）の判定と文（純関数）。取り込めるかの判定（takeoverRefusal。§3.2・§3.4）、許可のモードの写し方（§3.6）、
// /proc/<pid>/stat の starttime（§3.4 の相手の確かめ）、終わらせる直前の動きの見分け（§3.4）、失敗の文（§4）。T1 では配線しない
import type { CcTakeoverMode } from "../store/cc-takeovers.ts";
import type { PaneState } from "../tmux/pane-state.ts";
import type { CcSessionView } from "./registry.ts";

/** 最初の確かめから確かめ直しまでの間（§3.4） */
export const TAKEOVER_SETTLE_MS = 2000;
/** SIGTERM の後、/proc/<pid> が消えるのを待つ長さ（§3.4） */
export const TAKEOVER_EXIT_TIMEOUT_MS = 10000;
/** /proc/<pid> を見る間隔（§3.4） */
export const TAKEOVER_EXIT_POLL_MS = 250;
/** 写せる記録の大きさの上限（§3.3） */
export const TAKEOVER_MAX_BYTES = 128 * 1024 * 1024;

/** 失敗・断りの符号（§4） */
export type TakeoverFailure =
  | "not_ready"
  | "outside_workspace"
  | "busy"
  | "waiting"
  | "not_in_tmux"
  | "pane"
  | "queued"
  | "already_taken"
  | "in_progress"
  | "no_transcript"
  | "too_large"
  | "changed"
  | "identity"
  | "not_exited"
  | "copy_failed"
  | "restart";

/** ペインの状態。tmux の外は not_in_tmux、撮れなかった（tmux の失敗）は failed */
export type TakeoverPane = PaneState | "not_in_tmux" | "failed";

/** takeoverRefusal の材料 */
export type TakeoverRefusalInput = {
  /** ProjectSessionGate.ready（SELF_AGENT_CC=1 とプロジェクトのセッションの準備） */
  ready: boolean;
  /**
   * 生きているセッションは一覧の行とペインの状態、終わったセッション（cc_sessions が gone で一覧に無い）は ended。
   * どちらかは呼び出し側が決める
   */
  session:
    | { source: "alive"; view: Pick<CcSessionView, "state" | "status" | "kind" | "trustPending">; pane: TakeoverPane }
    | { source: "ended" };
  /** cwd が SELF_AGENT_WORKSPACE_DIR の直下のプロジェクトなら、その名前（channels.ts の resumeProject）。違えば undefined */
  project: string | undefined;
  /** そのセッションの届け待ち（cc_sends の awaiting_confirm・queued・delivering）の数 */
  queued: number;
  /** そのセッションに保留中（pending）の許可の要求がある */
  pendingPermission: boolean;
  /** channel_sessions にその session_id の行がある（すでに取り込んだ） */
  mapped: boolean;
};

/**
 * 取り込めるか（§3.2・§3.4 の条件。§4 の表の順に見る）。取り込めれば undefined、断るなら符号。
 * 元の記録の検査（no_transcript・too_large）と、確かめ直し・終了・写しの失敗は ここでは見ない（takeover-files.ts と T2 の本体）
 */
export function takeoverRefusal(input: TakeoverRefusalInput): TakeoverFailure | undefined {
  if (!input.ready) return "not_ready";
  if (input.project === undefined) return "outside_workspace";
  const session = input.session;
  if (session.source === "alive") {
    const view = session.view;
    // 対話のセッションでなければ、画面の証拠で相手を確かめられない
    if (view.kind !== "interactive") return "identity";
    if (input.pendingPermission || view.state === "needs_input" || view.status === "waiting") return "waiting";
    if (view.status !== "idle") return "busy";
    if (session.pane === "not_in_tmux") return "not_in_tmux";
    // 信頼の確認待ちは画面のダイアログ
    if (view.trustPending || session.pane !== "idle") return "pane";
  } else if (input.pendingPermission) {
    return "waiting";
  }
  if (input.queued > 0) return "queued";
  if (input.mapped) return "already_taken";
  return undefined;
}

/** 端末の許可のモードから、取り込んだセッションのモード（§3.6）。default・acceptEdits・plan はそのまま、ほか（auto・bypassPermissions・不明）は default */
export function mapTakeoverMode(mode: string | null | undefined): CcTakeoverMode {
  return mode === "acceptEdits" || mode === "plan" ? mode : "default";
}

/**
 * /proc/<pid>/stat の中身から starttime（22 番目の欄。起動からの clock tick）を読む。comm は括弧と空白を含みうるので、最後の `)` の後ろから
 * 数える（`)` の後ろの最初の欄が 3 番目の state）。形が合わなければ undefined
 */
export function parseStatStartTime(stat: string): number | undefined {
  const close = stat.lastIndexOf(")");
  if (close < 0) return undefined;
  const fields = stat.slice(close + 1).trim().split(/\s+/);
  const start = fields[22 - 3];
  if (start === undefined || !/^\d{1,20}$/.test(start)) return undefined;
  const value = Number(start);
  return Number.isSafeInteger(value) ? value : undefined;
}

/** 記録に増えた行のうち、JSON の type が user・assistant の行があれば true（終わらせる直前にターンが始まった。§3.4）。読めない行は無視する */
export function appendedInterrupted(lines: readonly string[]): boolean {
  for (const line of lines) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) continue;
    const type = (parsed as Record<string, unknown>).type;
    if (type === "user" || type === "assistant") return true;
  }
  return false;
}

const FAILURE_TEXTS: Readonly<Record<TakeoverFailure, string>> = {
  not_ready: "プロジェクトのセッションの準備ができていません（npm run unify-setup -- --print）",
  outside_workspace: "作業場所の直下のプロジェクトのセッションだけ取り込めます",
  busy: "実行中です。待機になってからもう一度",
  waiting: "判断待ち（許可・質問）です。待機になってからもう一度",
  not_in_tmux: "tmux の外のセッションです。端末で /exit してからもう一度",
  pane: "端末の画面が待機の状態ではありません（書きかけ・ダイアログ・操作の直後）",
  queued: "届け待ちの指示があります。届くのを待つか /cc cancel してから",
  already_taken: "すでに取り込んだ会話です",
  in_progress: "取り込みの途中です",
  no_transcript: "会話の記録が見つかりません",
  too_large: "記録が大きすぎます。端末で /compact してから",
  changed: "直前に動きがありました。もう一度",
  identity: "セッションを確かめられませんでした",
  not_exited: "端末の Claude Code が終わりませんでした。何も変えていません",
  copy_failed: "記録を写せませんでした",
  restart: "self-agent が再起動しました",
};

/** 終了の後の失敗に足す文（§4） */
export const TAKEOVER_AFTER_TERM_TEXT =
  "端末の Claude Code は終了しています。このチャンネルで /cc take をもう一度実行すると、終わった会話から取り込めます。";

/** 確認の文を書き換える失敗の文（§4）。afterTerm（端末の claude を終わらせた後の失敗）なら TAKEOVER_AFTER_TERM_TEXT を次の行に足す */
export function takeoverFailureText(code: TakeoverFailure, afterTerm: boolean): string {
  const text = `取り込めませんでした: ${FAILURE_TEXTS[code]}`;
  return afterTerm ? `${text}\n${TAKEOVER_AFTER_TERM_TEXT}` : text;
}
