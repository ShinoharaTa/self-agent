// 取り込み（docs/plan/takeover.md。#341）の判定と文（純関数）。取り込めるかの判定（takeoverRefusal。§3.2・§3.4）、許可のモードの写し方（§3.6）、
// /proc の読み取りの解釈と SIGTERM の相手の確かめ（takeoverIdentity。§3.4 の 1〜5）、終わらせる直前の動きの見分け（§3.4）、失敗の文（§4）。
// T1・T1b（§5.1）では配線しない
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
/** SIGTERM の相手の /proc/<pid>/stat の comm（§3.4 の 3） */
export const TAKEOVER_COMM = "claude";
/** SIGTERM を送ってよい /proc/<pid>/stat の state（走っている・眠っている）。止まっている（T・t）・死んでいる（X・x・Z）ものは保留されて後で死ぬので落とす */
export const TAKEOVER_LIVE_STATES: readonly string[] = ["R", "S", "D"];
/** プロセスの開始が一覧の startedAt からこれ以上遅ければ、使い回された pid とみなす（§3.4 の 4） */
export const TAKEOVER_START_SLACK_MS = 2000;
/** 祖先をたどる段数の上限（§3.4 の 5。超えたら確かめられない） */
export const TAKEOVER_LINEAGE_MAX = 1024;
/** /proc/<pid>/stat の starttime の単位（clock tick / 秒。Linux の USER_HZ） */
export const TAKEOVER_CLK_TCK = 100;

/** 失敗・断りの符号（§4） */
export type TakeoverFailure =
  | "not_ready"
  | "list_failed"
  | "outside_workspace"
  | "channel_busy"
  | "channel_changed"
  | "no_category"
  | "target_invalid"
  | "tmux_failed"
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

/** ペインの状態。tmux の外は not_in_tmux、撮れなかった（tmux の失敗）は failed（tmux_failed で断る） */
export type TakeoverPane = PaneState | "not_in_tmux" | "failed";

/** takeoverRefusal の材料 */
export type TakeoverRefusalInput = {
  /** ProjectSessionGate.ready（SELF_AGENT_CC=1 とプロジェクトのセッションの準備） */
  ready: boolean;
  /** 今読んだ一覧（§3.4。tick の後の snapshot が stale でも unreadable でもなく、fetchedAt が読む前の時刻以後） */
  listFresh: boolean;
  /** 取り込み先の cc のチャンネルの状態（resuming は [起動して続ける] の途中） */
  channelState: "open" | "ended" | "resuming";
  /**
   * 生きているセッションは一覧の行とペインの状態、終わったセッション（cc_sessions が gone で一覧に無い）は ended。
   * どちらかは呼び出し側が決める
   */
  session:
    | { source: "alive"; view: Pick<CcSessionView, "state" | "status" | "kind" | "trustPending">; pane: TakeoverPane }
    | { source: "ended" };
  /**
   * cwd の形まで合った（§3.4。resumeProject の名前が checkSessionProject を通り、端末の cwd が verifiedProjectDir と同じ文字列）プロジェクトの名前。
   * 合わなければ呼び出し側が undefined を渡す
   */
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
  if (!input.listFresh) return "list_failed";
  if (input.project === undefined) return "outside_workspace";
  if (input.channelState === "resuming") return "channel_busy";
  const session = input.session;
  if (session.source === "alive") {
    const view = session.view;
    // 対話のセッションでなければ、画面の証拠で相手を確かめられない
    if (view.kind !== "interactive") return "identity";
    if (input.pendingPermission || view.state === "needs_input" || view.status === "waiting") return "waiting";
    if (view.status !== "idle") return "busy";
    if (session.pane === "not_in_tmux") return "not_in_tmux";
    if (session.pane === "failed") return "tmux_failed";
    // 信頼の確認待ちは画面のダイアログ
    if (view.trustPending || session.pane !== "idle") return "pane";
  } else if (input.pendingPermission) {
    return "waiting";
  }
  if (input.queued > 0) return "queued";
  if (input.mapped) return "already_taken";
  return undefined;
}

/** 端末の許可のモードから、取り込んだセッションのモード（§3.6）。U2 まで呼ばない（取り込んだセッションは常に default）。default・acceptEdits・plan はそのまま、ほか（auto・bypassPermissions・不明）は default */
export function mapTakeoverMode(mode: string | null | undefined): CcTakeoverMode {
  return mode === "acceptEdits" || mode === "plan" ? mode : "default";
}

/** /proc/<pid>/stat の解釈（parseStat）。startTime は起動からの clock tick */
export type ProcStat = { comm: string; state: string; ppid: number; startTime: number };

/**
 * /proc/<pid>/stat の中身を読む（純関数）。comm は最初の `(` と最後の `)` の間（空白・括弧を含みうる）。その後ろの欄の 1・2・20 番目が
 * state・ppid・starttime。形が合わなければ undefined
 */
export function parseStat(stat: string): ProcStat | undefined {
  const open = stat.indexOf("(");
  const close = stat.lastIndexOf(")");
  if (open < 0 || close < open) return undefined;
  const fields = stat.slice(close + 1).trim().split(/\s+/);
  const state = fields[0];
  const ppid = fields[1];
  const start = fields[19];
  if (state === undefined || !/^[A-Za-z]$/.test(state)) return undefined;
  if (ppid === undefined || !/^\d{1,10}$/.test(ppid) || start === undefined || !/^\d{1,20}$/.test(start)) return undefined;
  const ppidValue = Number(ppid);
  const startValue = Number(start);
  if (!Number.isSafeInteger(ppidValue) || !Number.isSafeInteger(startValue)) return undefined;
  return { comm: stat.slice(open + 1, close), state, ppid: ppidValue, startTime: startValue };
}

/** /proc/stat の中身から btime（起動の時刻。エポックからの秒）を読む。無ければ undefined */
export function parseBtime(procStat: string): number | undefined {
  const match = /^btime\s+(\d{1,15})\s*$/m.exec(procStat);
  if (match === null) return undefined;
  const value = Number(match[1]);
  return Number.isSafeInteger(value) ? value : undefined;
}

/** プロセスの開始の時刻（エポックからのミリ秒）。starttime（clock tick）と btime（秒）から */
export function procStartMs(startTime: number, btimeSec: number): number {
  return btimeSec * 1000 + (startTime * 1000) / TAKEOVER_CLK_TCK;
}

/**
 * pid の祖先の列（親から順に、pid ≤ 1 に着くまで。自分は含めない）。途中で親を読めない・親が 0 以上の安全な整数でない・
 * TAKEOVER_LINEAGE_MAX 段を超えるなら undefined
 */
export function lineage(pid: number, parentOf: (pid: number) => number | undefined): number[] | undefined {
  const result: number[] = [];
  let current = pid;
  while (current > 1) {
    const parent = parentOf(current);
    if (parent === undefined || !Number.isSafeInteger(parent) || parent < 0) return undefined;
    result.push(parent);
    if (result.length > TAKEOVER_LINEAGE_MAX) return undefined;
    current = parent;
  }
  return result;
}

/** takeoverIdentity の材料（signal の直前に読んだもの） */
export type TakeoverIdentityInput = {
  /** 今読んだ一覧のその session_id の行（無ければ undefined） */
  view: Pick<CcSessionView, "pid" | "kind" | "status" | "startedAt"> | undefined;
  /** 最初の確かめで覚えた pid と starttime */
  first: { pid: number; startTime: number };
  /** sessionFile(pid, sessionId) が返った */
  sessionFile: boolean;
  /** /proc/<pid>/stat（parseStat。読めなければ undefined） */
  stat: ProcStat | undefined;
  /** /proc/stat の btime（読めなければ undefined） */
  btimeSec: number | undefined;
  ownPid: number;
  /** sessions/<pid>.json の procStart（ClaudeDirs.sessionFile。あれば /proc/<pid>/stat の starttime と同じでなければならない） */
  procStart: string | undefined;
  /** 自分の祖先（lineage(ownPid)） */
  ownAncestors: number[] | undefined;
  /** 相手の祖先（lineage(pid)） */
  targetAncestors: number[] | undefined;
};

/** SIGTERM を送ってよい相手か（§3.4 の 1〜5 を全部満たすときだけ true。1 つでも欠ければ identity で、signal は送らない） */
export function takeoverIdentity(input: TakeoverIdentityInput): boolean {
  const { view, first, stat } = input;
  const pid = first.pid;
  // 1. 今読んだ一覧に同じ pid の interactive・idle の行がある
  if (view === undefined || view.pid !== pid || view.kind !== "interactive" || view.status !== "idle") return false;
  // 2. sessions/<pid>.json がその session_id
  if (!input.sessionFile) return false;
  // 3. comm が claude・state が R・S・D・starttime が最初と同じ（sessions/<pid>.json に procStart があればそれとも同じ。pid の使い回しを時計に頼らず落とす）
  if (stat === undefined || stat.comm !== TAKEOVER_COMM || !TAKEOVER_LIVE_STATES.includes(stat.state) || stat.startTime !== first.startTime) {
    return false;
  }
  if (input.procStart !== undefined && String(stat.startTime) !== input.procStart) return false;
  // 4. プロセスの開始が一覧の startedAt + TAKEOVER_START_SLACK_MS 以下（使い回された pid を落とす）
  if (view.startedAt === undefined || input.btimeSec === undefined) return false;
  if (procStartMs(stat.startTime, input.btimeSec) > view.startedAt + TAKEOVER_START_SLACK_MS) return false;
  // 5. 1 より大きく、自分でも自分の祖先・子孫でもない
  if (pid <= 1 || pid === input.ownPid) return false;
  if (input.ownAncestors === undefined || input.targetAncestors === undefined) return false;
  if (input.ownAncestors.includes(pid) || input.targetAncestors.includes(input.ownPid)) return false;
  return true;
}

/**
 * 記録に増えた行のうち、JSON の type が user・assistant の行があれば true（終わらせる直前にターンが始まった。§3.4）。
 * 空白だけでない行が JSON として読めなければ（書きかけの行）も true（「動きなし」と読まない）
 */
export function appendedInterrupted(lines: readonly string[]): boolean {
  for (const line of lines) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      if (line.trim() !== "") return true;
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
  list_failed: "Claude Code の一覧を読めませんでした。もう一度",
  outside_workspace: "作業場所の直下のプロジェクトのセッションだけ取り込めます",
  channel_busy: "このチャンネルは起動の途中です。終わってからもう一度",
  channel_changed: "取り込みの間にチャンネルの状態が変わりました。もう一度",
  no_category: "進行中のカテゴリを用意できませんでした",
  target_invalid: "記録の写し先を使えません（CLAUDE_CONFIG_DIR の projects の外を指しています）",
  tmux_failed: "端末の画面を読めませんでした。もう一度",
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
  identity: "セッションを確かめられませんでした。端末の Claude Code はそのままです",
  not_exited: "10 秒待っても端末の Claude Code が終わりませんでした。取り込みはやめました。後から終わったら、もう一度 /cc take してください",
  copy_failed: "記録を写せませんでした",
  restart: "self-agent が再起動しました",
};

/** SIGTERM を送った後の失敗に足す文（§4。not_exited には足さない） */
export const TAKEOVER_AFTER_TERM_TEXT =
  "端末の Claude Code は終了しています。このチャンネルで /cc take をもう一度実行すると、終わった会話から取り込めます。";

/**
 * 確認の文を書き換える失敗の文（§4）。afterTerm（SIGTERM を送った後の失敗）なら TAKEOVER_AFTER_TERM_TEXT を次の行に足す。
 * not_exited は文の中に続け方があるので足さない
 */
export function takeoverFailureText(code: TakeoverFailure, afterTerm: boolean): string {
  const text = `取り込めませんでした: ${FAILURE_TEXTS[code]}`;
  return afterTerm && code !== "not_exited" ? `${text}\n${TAKEOVER_AFTER_TERM_TEXT}` : text;
}
