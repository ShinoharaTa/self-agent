// 取り込み（docs/plan/takeover.md。#341）の本体。端末の tmux で動いている（か、終わった）Claude Code の会話を、新しいチャンネルの
// プロジェクトのセッションに引き継ぐ。手順は §4: 確認（propose）→ [取り込む]（confirm）で check → channel（新しいチャンネルを作る）
// → term（生きているときだけ SIGTERM）→ copy（記録を CLAUDE_CONFIG_DIR へ写す）→ commit（1 つのトランザクションで sessions と channel_sessions の行・
// 取り込みを done）→ 後始末（完了の文・cc のチャンネルの案内・確認の文の書き換え。失敗しても done）。
// チャンネルを作った後に失敗したら、そのチャンネル（sessions の行が無いものだけ）を消す。消せなければ行き先を残し、起動時の recoverEffects がもう一度消す。
// running の間の送信は holds で断る（sender.ts が見る）。再起動の後は recoverRunning（running を failed（restart）に）→ recoverEffects。
// 部品はすべて注入（kill・/proc の読み取り・sleep・チャンネルの作成も）。cc/channels.ts・sender.ts・replies.ts・starter.ts・app/commands/cc-confirm.ts は
// import しない（消える側。docs/plan/terminal-handover.md の X 段）。配線は H2・H3。
// log は理由の符号・段・取り込みの番号・サーバー ID だけ（session_id・pid・cwd・名前・パス・本文は出さない）。チャンネル ID は、消せなかった行き先のときだけ出す
import type { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { ChannelOpsQueue } from "../app/channel-ops.ts";
import { layoutQueueKey } from "../app/commands/setup.ts";
import type { KeyedSerialQueue } from "../app/queue.ts";
import { type NewTopicChannelResult, normalizeTopicTitle, type ProjectSessionCheck, TOPIC_TITLE_MAX_LENGTH } from "../app/session-ops.ts";
import { DEFAULT_PERSONA_ID, type Config } from "../config.ts";
import { escapeDiscordText } from "../discord/escape.ts";
import type { Gateway, OutgoingMessage } from "../discord/gateway.ts";
import type { CcChannelStore } from "../store/cc-channels.ts";
import type { CcPermissionStore } from "../store/cc-permissions.ts";
import type { CcSendStore } from "../store/cc-sends.ts";
import { headChars, type CcSessionRow, type CcSessionStore } from "../store/cc-sessions.ts";
import type { CcTakeoverEntry, CcTakeoverRow, CcTakeoverSource, CcTakeoverStore } from "../store/cc-takeovers.ts";
import { rollbackIfOpen } from "../store/db.ts";
import { recordHistory, type HistoryStore } from "../store/history.ts";
import type { SdkSessionStore } from "../store/sdk-sessions.ts";
import type { TopicSessionStore } from "../store/topic-sessions.ts";
import type { ProbeResult } from "../tmux/pane-state.ts";
import type { ClaudeDirs } from "./claude-dirs.ts";
import type { CcPaneResolver } from "./panes.ts";
import type { CcRegistry, CcSessionView, CcTimers } from "./registry.ts";
import { copyTranscript, inspectSource, prepareTarget, readAppended, takeoverPaths, takeoverProjectName } from "./takeover-files.ts";
import {
  appendedInterrupted,
  lineage,
  parseBtime,
  parseStat,
  type ProcStat,
  TAKEOVER_CHANNEL_TIMEOUT_MS,
  TAKEOVER_EXIT_POLL_MS,
  TAKEOVER_EXIT_TIMEOUT_MS,
  TAKEOVER_SETTLE_MS,
  type TakeoverFailure,
  takeoverFailureText,
  takeoverIdentity,
  type TakeoverPane,
  takeoverRefusal,
  TAKEOVER_MAYBE_TERM_TEXT,
} from "./takeover-rules.ts";

/** 確認の有効な長さ（10 分。§3.5） */
export const TAKEOVER_CONFIRM_TTL_MS = 10 * 60_000;
/** 確認の失効を確かめる間隔（1 分） */
export const TAKEOVER_EXPIRE_SWEEP_MS = 60_000;
/** [取り込む]（`cc:take:go:<id>`）・[やめる]（`cc:take:no:<id>`）の custom_id の頭（§3.5） */
export const TAKEOVER_GO_PREFIX = "cc:take:go";
export const TAKEOVER_NO_PREFIX = "cc:take:no";

/** 確認が期限切れになったときの確認の文（§3.5） */
export const TAKEOVER_EXPIRED_TEXT = "取り込みの確認は期限切れです（10 分）。";
/** 終わらせる直前に端末で動きがあったときに完了の文に足す 1 行（§4） */
export const TAKEOVER_INTERRUPTED_TEXT = "取り込みの直前に端末で動きがありました。最後の指示は途中で止まっているかもしれません。";
/** 取り込んだ会話を resume できずに新しい会話にしたときの 1 行（§3.6.3） */
export const TAKEOVER_DROPPED_TEXT =
  "取り込んだ会話を続けられなくなったため、新しい会話として続けます。元の会話は端末で claude --resume で開けます。";

/** 名前・題名の表示の上限 */
const LABEL_MAX_CHARS = 100;

/** 1 行の表示（制御文字を空白にし、Discord 向け（escape）なら Markdown とメンションを無効にする。Web は文字のまま出すので escape しない） */
function label(text: string, escape: boolean): string {
  const line = headChars(text.replace(/[\u0000-\u001f\u007f]/g, " "), LABEL_MAX_CHARS);
  return escape ? escapeDiscordText(line) : line;
}

/** 確認の文（§4。純関数）。escape が false なら Web 向け（エスケープ前） */
export function takeoverConfirmText(
  input: { title: string; project: string; source: CcTakeoverSource; terminalMode: string | null },
  escape = true,
): string {
  const ending = input.source === "alive" ? "端末の Claude Code は終了し、" : "端末の Claude Code はすでに終わっています。";
  return (
    `「${label(input.title, escape)}」（${label(input.project, escape)}）を取り込みます。${ending}続きは新しいチャンネルで self-agent が引き継ぎます。` +
    `許可のモードは default になります（端末: ${label(input.terminalMode ?? "不明", escape)}）。モデルは self-agent の設定のものになります。`
  );
}

/** 完了の文（§4。新しいチャンネルの最初の投稿と Web の履歴の知らせ。純関数）。escape が false なら Web 向け（エスケープ前） */
export function takeoverDoneText(project: string, interrupted: boolean, escape = true): string {
  const text =
    `端末の Claude Code から取り込みました。ここから先は self-agent がこの会話を続けます（${label(project, escape)}・許可のモード default）。` +
    "これより前の会話はここには出ませんが、self-agent は覚えています。" +
    "端末で claude --resume すると取り込む前までの会話が別に開きます（ここでの続きは入りません）。";
  return interrupted ? `${text}\n${TAKEOVER_INTERRUPTED_TEXT}` : text;
}

/** 確認の文の書き換え（Discord の入口の成功。§3.5）と confirm の結果の text */
export function takeoverLinkText(channelId: string): string {
  return `取り込みました → <#${channelId}>`;
}

/** 取り込んだセッションの cc のチャンネルへの案内（§3.2。共存の間だけ） */
export function takeoverMovedText(channelId: string): string {
  return `この会話は self-agent が取り込みました。続きは <#${channelId}> で。このチャンネルに書いても届きません。`;
}

/** Web の会話の区切り（history は文字のまま出すので Markdown を無効にしない） */
export function takeoverDivider(project: string): string {
  return `端末の Claude Code から取り込みました（${headChars(project.replace(/[\u0000-\u001f\u007f]/g, " "), LABEL_MAX_CHARS)}）`;
}

/** 確認のボタン（[取り込む][やめる]。純関数） */
export function takeoverButtons(id: number): NonNullable<OutgoingMessage["components"]> {
  return [
    {
      kind: "buttons",
      buttons: [
        { customId: `${TAKEOVER_GO_PREFIX}:${id}`, label: "取り込む", style: "primary" },
        { customId: `${TAKEOVER_NO_PREFIX}:${id}`, label: "やめる" },
      ],
    },
  ];
}

/** /proc/<pid>/stat を読む（読めなければ undefined。配線で readProc に渡す） */
export function readProcStat(pid: number): string | undefined {
  if (!Number.isSafeInteger(pid) || pid < 1) return undefined;
  try {
    return readFileSync(`/proc/${pid}/stat`, "utf8");
  } catch {
    return undefined;
  }
}

/** /proc/stat の btime（読めなければ undefined。配線で readBtime に渡す） */
export function readProcBtime(): number | undefined {
  try {
    return parseBtime(readFileSync("/proc/stat", "utf8"));
  } catch {
    return undefined;
  }
}

/** 記録のファイルの操作（既定は takeover-files.ts。テストで差し替える） */
export type TakeoverFiles = {
  inspectSource: typeof inspectSource;
  prepareTarget: typeof prepareTarget;
  copyTranscript: typeof copyTranscript;
  readAppended: typeof readAppended;
};

/** 前置き（§3.6.1）を付けるかを決めるターンの材料（turn.ts が渡す） */
export type TakeoverNoteTurn = {
  /** /close の要約など（あれば付けない） */
  purpose?: string;
  /** 予約した依頼のターン（付けない） */
  scheduled?: boolean;
};

export type CcTakeoverDeps = {
  /** commit の BEGIN IMMEDIATE（各 store と同じ接続） */
  db: DatabaseSync;
  cfg: Pick<Config, "workspaceDir">;
  /** ~ の場所（元の記録は ~/.claude/projects の下） */
  home: string;
  /** Bot の CLAUDE_CONFIG_DIR（写し先は projects の下） */
  claudeConfigDir: string;
  registry: Pick<CcRegistry, "tick" | "snapshot">;
  /** 共存の間だけ（X3 で外す）。ペインを引く口。panes か probePane が無ければ、生きているセッションはすべて not_in_tmux で断る（§3.4） */
  panes?: Pick<CcPaneResolver, "lookup">;
  /** 共存の間だけ（X3 で外す）。ペインを撮って状態を返す（tmux/pane-state.ts の probePaneState） */
  probePane?: (paneId: string) => Promise<ProbeResult>;
  dirs: Pick<ClaudeDirs, "sessionFile">;
  takeovers: CcTakeoverStore;
  /** 共存の間だけ（X3 で外す）。取り込んだセッションの cc のチャンネルを deleted にして案内する（§3.2）。無ければ何もしない */
  ccChannels?: Pick<CcChannelStore, "anyFor" | "markDeleted">;
  /** 題名（name）・終わったセッション（gone）の候補 */
  ccSessions: Pick<CcSessionStore, "get" | "listGone">;
  /** 共存の間だけ（X3 で外す）。届け待ちの確かめ。無ければ見ない */
  ccSends?: Pick<CcSendStore, "activeFor">;
  /** 共存の間だけ（X4 で外す）。self-agent が保留している許可の確かめ。無ければ一覧の pendingPermission だけを見る */
  ccPermissions?: Pick<CcPermissionStore, "pendingFor">;
  topicSessions: Pick<TopicSessionStore, "create" | "get">;
  sdkSessions: Pick<SdkSessionStore, "hasSessionId" | "set">;
  /** ProjectSessionGate.ready（SELF_AGENT_CC=1 とプロジェクトのセッションの準備） */
  ready: () => boolean;
  /** app/session-ops.ts の checkSessionProject（gate を束ねたもの） */
  checkSessionProject: (name: string) => ProjectSessionCheck;
  /** runner の cwd（cc/starter.ts の projectDir。places を束ねたもの。starter.ts は import しない） */
  verifiedProjectDir: (name: string) => string | undefined;
  /** 新しいチャンネルを作る（app/session-ops.ts の createTopicChannel を束ねたもの。queue の中で呼ぶ。sessions の行は作らない） */
  createChannel: (guildId: string, title: string, projectDir: string) => Promise<NewTopicChannelResult>;
  /** /setup・/new と同じキュー（key は layoutQueueKey） */
  queue: Pick<KeyedSerialQueue, "run">;
  /** cc のチャンネルを完了へ移す（共存の間だけ） */
  channelOps: Pick<ChannelOpsQueue, "enqueueMove">;
  /** 確認の文の書き換え・完了の文・案内・作ったチャンネルの削除（既定の人格の Bot） */
  gateway: Pick<Gateway, "sendMessage" | "editMessage" | "deleteChannel">;
  /** Web UI の会話の記録（無ければ書かない） */
  history?: Pick<HistoryStore, "add">;
  /** 送るのは SIGTERM だけ（process.kill） */
  kill: (pid: number, signal: "SIGTERM") => void;
  /** /proc/<pid>/stat の中身（readProcStat） */
  readProc: (pid: number) => string | undefined;
  /** /proc/stat の btime（readProcBtime） */
  readBtime: () => number | undefined;
  sleep: (ms: number) => Promise<void>;
  now: () => Date;
  /** 自分の pid（process.pid） */
  ownPid: number;
  /** 最初のターンの前置き（TAKEOVER_NOTE）。無ければ noteFor は何も返さない */
  note?: string;
  files?: Partial<TakeoverFiles>;
  log: (message: string) => void;
};

/**
 * propose の結果。message は確認の文とボタン（投稿して setConfirmMessage するのは呼び出し側。Web の行では呼ばない）。
 * plainText は同じ文のエスケープ前（Web の確認）
 */
export type CcTakeoverProposeResult =
  | { ok: true; id: number; message: OutgoingMessage; plainText: string }
  | { ok: false; reason: TakeoverFailure; text: string };

/** takeable の 1 行（§3.5） */
export type CcTakeable = { sessionId: string; title: string; project: string; alive: boolean };

/**
 * confirm の結果。stale = 確認待ちでない、expired = 10 分を過ぎた（取り消した）。
 * 成功の channelId は行き先の新しいチャンネル（新しい話題）、text は「取り込みました → <#…>」、plainText は完了の文のエスケープ前（Web の応答）。
 * edited は確認の文を書き換えられたか（Discord の入口で false なら、呼び出し側が押された 1 通を text に書き換えてボタンを外す）
 */
export type CcTakeoverConfirmResult =
  | { ok: true; channelId: string; text: string; plainText: string; edited: boolean }
  | { ok: false; reason: "stale" }
  | { ok: false; reason: "expired"; text: string; plainText: string; edited: boolean }
  | { ok: false; reason: TakeoverFailure; text: string; plainText: string; edited: boolean };

/** 条件を見た結果（§3.2・§3.4） */
type Assessed =
  | { ok: false; code: TakeoverFailure }
  | { ok: true; source: CcTakeoverSource; view: CcSessionView | undefined; cwd: string; project: string; session: CcSessionRow | undefined };

function errorKind(error: unknown): string {
  return error instanceof Error ? error.name : typeof error;
}

/** SIGTERM を送ったか: none = 送っていない、maybe = 送ったが終了を見届けていない（か分からない）、done = 送って終了を見届けた */
type TakeoverTerm = "none" | "maybe" | "done";

/** 失敗の文（§4）。done なら TAKEOVER_AFTER_TERM_TEXT（takeoverFailureText の afterTerm）、maybe なら TAKEOVER_MAYBE_TERM_TEXT を次の行に足す */
function failureText(code: TakeoverFailure, term: TakeoverTerm): string {
  if (term === "maybe") return `${takeoverFailureText(code, false)}\n${TAKEOVER_MAYBE_TERM_TEXT}`;
  return takeoverFailureText(code, term === "done");
}

export class CcTakeover {
  private readonly deps: CcTakeoverDeps;
  private readonly files: TakeoverFiles;
  /** resumeDropped を知らせた取り込み（1 回だけ。プロセスの中だけ） */
  private readonly droppedNoticed = new Set<number>();
  /** 起動時の前段（recoverRunning）が失敗にし、後段（recoverEffects）で確認の文を書き換える行 */
  private readonly resetPending: CcTakeoverRow[] = [];

  constructor(deps: CcTakeoverDeps) {
    this.deps = deps;
    this.files = { inspectSource, prepareTarget, copyTranscript, readAppended, ...deps.files };
  }

  /**
   * 確認を作る（§3.5）: 一覧を読む → 条件（takeoverRefusal）→ awaiting_confirm の行を作り、確認の文とボタンを返す。行き先はまだ作らない。
   * session_id は入口が出した候補の値で、cwd・pid・名前は一覧と cc_sessions から引き直す。entry が web なら confirmChannelId は渡さない。
   * 断るときは符号と文
   */
  async propose(input: { sessionId: string; entry: CcTakeoverEntry; guildId: string; confirmChannelId?: string }): Promise<CcTakeoverProposeResult> {
    const { takeovers, log } = this.deps;
    const refuse = (code: TakeoverFailure): CcTakeoverProposeResult => {
      log(`Claude Code: 取り込みを断りました（${code}、guild=${input.guildId}）`);
      return { ok: false, reason: code, text: takeoverFailureText(code, false) };
    };
    // 準備ができていなければ一覧を読まない（どのみち not_ready）
    const assessed = await this.judge(input.sessionId, this.deps.ready() ? await this.readList() : false);
    if (!assessed.ok) return refuse(assessed.code);
    const terminalMode = assessed.session?.permissionMode ?? assessed.view?.permissionMode ?? null;
    const row = takeovers.propose({
      sessionId: input.sessionId,
      source: assessed.source,
      project: assessed.project,
      guildId: input.guildId,
      entry: input.entry,
      ...(input.confirmChannelId === undefined ? {} : { confirmChannelId: input.confirmChannelId }),
      // H4b まで常に default（§3.6。mapTakeoverMode は呼ばない）
      permissionMode: "default",
      terminalMode,
    });
    if (row === undefined) return refuse("in_progress");
    log(`Claude Code: 取り込みの確認を作りました（#${row.id}、${row.source}、${row.entry}、guild=${row.guildId}）`);
    const title = this.titleOf(assessed.session, assessed.project);
    const confirmInput = { title, project: assessed.project, source: assessed.source, terminalMode };
    return {
      ok: true,
      id: row.id,
      message: { text: takeoverConfirmText(confirmInput), components: takeoverButtons(row.id) },
      plainText: takeoverConfirmText(confirmInput, false),
    };
  }

  /**
   * 取り込める物（§3.5。入口の候補）。一覧を 1 回だけ読み、待機の物（最後の活動の新しい順）→ 終わった物（cc_sessions の gone。終わった時刻の新しい順）を、
   * propose と同じ判定で見る。件数は切らない（切るのは入口）。ペインを撮る前に、ペインが待機だったとしても断られるものを外す（結果は変わらない）。
   * 準備ができていなければ一覧を読まずに空。log は出さない
   */
  async takeable(): Promise<CcTakeable[]> {
    const { registry, ccSessions } = this.deps;
    if (!this.deps.ready()) return [];
    const fresh = await this.readList();
    const alive = [...registry.snapshot().sessions].sort((a, b) => (b.lastActivityAt ?? -Infinity) - (a.lastActivityAt ?? -Infinity));
    const seen = new Set(alive.map((view) => view.sessionId));
    const gone = ccSessions
      .listGone()
      .filter((row) => !seen.has(row.sessionId))
      .sort((a, b) => Date.parse(b.goneAt ?? "") - Date.parse(a.goneAt ?? "") || 0);
    const candidates = [...alive.map((view) => view.sessionId), ...gone.map((row) => row.sessionId)];
    const result: CcTakeable[] = [];
    for (const sessionId of candidates) {
      if (!(await this.judge(sessionId, fresh, "idle")).ok) continue;
      const assessed = await this.judge(sessionId, fresh);
      if (!assessed.ok) continue;
      result.push({
        sessionId,
        title: this.titleOf(assessed.session, assessed.project),
        project: assessed.project,
        alive: assessed.source === "alive",
      });
    }
    return result;
  }

  /** propose・takeable の 1 件の判定（一覧は読んだ後）: 確認待ちか running の取り込みがあれば in_progress、ほかは assess */
  private async judge(sessionId: string, fresh: boolean, assumePane?: TakeoverPane): Promise<Assessed> {
    if (this.deps.takeovers.activeFor(sessionId) !== undefined) return { ok: false, code: "in_progress" };
    return this.assess(sessionId, fresh, assumePane);
  }

  /** [取り込む]（§4）: 確認待ちを running にして step を順に進める。結果の文で確認の文を書き換える */
  async confirm(id: number): Promise<CcTakeoverConfirmResult> {
    const { takeovers, now, log } = this.deps;
    const row = takeovers.get(id);
    if (row === undefined || row.state !== "awaiting_confirm") return { ok: false, reason: "stale" };
    if (now().getTime() - Date.parse(row.createdAt) >= TAKEOVER_CONFIRM_TTL_MS) {
      if (!takeovers.cancel(id)) return { ok: false, reason: "stale" };
      log(`Claude Code: 取り込みの確認の期限が過ぎていました（#${id}、guild=${row.guildId}）`);
      const edited = await this.editConfirm(id, { text: TAKEOVER_EXPIRED_TEXT, components: [] });
      return { ok: false, reason: "expired", text: TAKEOVER_EXPIRED_TEXT, plainText: TAKEOVER_EXPIRED_TEXT, edited };
    }
    if (!takeovers.start(id)) return { ok: false, reason: "stale" };
    log(`Claude Code: 取り込みを始めます（#${id}、${row.source}、guild=${row.guildId}）`);
    const progress = { afterTerm: false, exited: false };
    let outcome: { channelId: string } | TakeoverFailure;
    let term: TakeoverTerm;
    try {
      outcome = await this.run(row, progress);
      term = progress.afterTerm ? "done" : "none";
    } catch (error) {
      log(`Claude Code: 取り込みの途中で例外が起きました（#${id}、${errorKind(error)}）`);
      // SIGTERM より前なら端末はそのまま（internal）、後なら写し・切り替えの失敗と同じ。終了を見届ける前なら言い切らない
      outcome = progress.afterTerm ? "copy_failed" : "internal";
      term = !progress.afterTerm ? "none" : progress.exited ? "done" : "maybe";
    }
    if (typeof outcome === "string") return this.failed(row, outcome, term);
    log(`Claude Code: 取り込みました（#${id}、guild=${row.guildId}）`);
    const { plainText, edited } = await this.effects(id);
    return { ok: true, channelId: outcome.channelId, text: takeoverLinkText(outcome.channelId), plainText, edited };
  }

  /** [やめる]: 確認待ちを cancelled にする。移したら true（確認の文の書き換えは呼び出し側） */
  cancel(id: number): boolean {
    const row = this.deps.takeovers.get(id);
    if (row === undefined || !this.deps.takeovers.cancel(id)) return false;
    this.deps.log(`Claude Code: 取り込みをやめました（#${id}、guild=${row.guildId}）`);
    return true;
  }

  /** 10 分を過ぎた確認待ちを cancelled にし、確認の文を書き換える（1 分ごと）。移した数を返す */
  async expire(): Promise<number> {
    const { takeovers, now, log } = this.deps;
    const rows = takeovers.expire(new Date(now().getTime() - TAKEOVER_CONFIRM_TTL_MS).toISOString());
    for (const row of rows) await this.editConfirm(row.id, { text: TAKEOVER_EXPIRED_TEXT, components: [] });
    if (rows.length > 0) log(`Claude Code: 取り込みの確認 ${rows.length} 件が期限切れになりました`);
    return rows.length;
  }

  /** そのセッションに running の取り込みがあるか（sender.ts の holds） */
  holds(sessionId: string): boolean {
    return this.deps.takeovers.runningFor(sessionId) !== undefined;
  }

  /** 起動時の前段と後段を続けて呼ぶ（テスト・一度に済ませてよいとき） */
  async recover(): Promise<void> {
    this.recoverRunning();
    await this.recoverEffects();
  }

  /**
   * 起動時の前段（§3.4。DB だけで Discord を使わない）: running の行を failed（restart）にする。registry の最初の読み取りと、操作を受け付ける
   * （gateway.start）より前に 1 回呼ぶ。失敗にした行は後段（recoverEffects）が確認の文を書き換えるまで覚えておく
   */
  recoverRunning(): void {
    const reset = this.deps.takeovers.resetRunning();
    if (reset.length > 0) this.deps.log(`Claude Code: 再起動の前の取り込み ${reset.length} 件を失敗にしました（restart）`);
    this.resetPending.push(...reset);
  }

  /**
   * 起動時の後段（gateway.start の後・registry の start の前に 1 回）: (1) 前段が失敗にした行の確認の文を書き換え（待たない）、
   * (2) failed の行に残った行き先のチャンネルを消し（sessions の行があれば消さない。消せなければ log だけで、次の起動でもう一度）、
   * (3) 後始末の済んでいない done の行の後始末を 1 回やり直す（行き先の sessions の行が無ければ済みにする）
   */
  async recoverEffects(): Promise<void> {
    const { takeovers, topicSessions, gateway, log } = this.deps;
    const reset = this.resetPending.splice(0);
    for (const row of reset) {
      if (row.confirmChannelId === null || row.confirmMessageId === null) continue;
      // SIGTERM を送ったか分からない段なら、言い切らずに続け方を足す
      const maybeTerm = row.source === "alive" && (row.step === "term" || row.step === "copy" || row.step === "commit");
      const text = failureText("restart", maybeTerm ? "maybe" : "none");
      const channelId = row.confirmChannelId;
      const messageId = row.confirmMessageId;
      void Promise.resolve()
        .then(() => gateway.editMessage(channelId, messageId, { text, components: [] }))
        .catch((error: unknown) => {
          log(`Claude Code: 再起動の前の取り込みの確認の文を書き換えられませんでした（#${row.id}、${errorKind(error)}）`);
        });
    }
    for (const row of takeovers.listTargetLeft()) {
      if (row.targetChannelId !== null) await this.dropTarget(row.id, row.targetChannelId);
    }
    for (const row of takeovers.listEffectsPending()) {
      if (row.targetChannelId === null || topicSessions.get(row.targetChannelId) === undefined) {
        takeovers.markEffects(row.id);
        log(`Claude Code: 取り込んだ話題が無いため、後始末を済みにしました（#${row.id}、guild=${row.guildId}）`);
        continue;
      }
      await this.effects(row.id);
      log(`Claude Code: 取り込みの後始末をやり直しました（#${row.id}、guild=${row.guildId}）`);
    }
  }

  /**
   * 最初のターンの前置き（§3.6.1。turn.ts が resume の経路で呼ぶ）。purpose・予約でなく、そのチャンネル（行き先）の最新の done の取り込みが
   * note_pending で、その session_id が今 resume する sessionId と同じときだけ前置きを返す
   */
  noteFor(channelId: string, sessionId: string, turn: TakeoverNoteTurn): string | undefined {
    if (this.deps.note === undefined || turn.purpose !== undefined || turn.scheduled === true) return undefined;
    const row = this.deps.takeovers.takenFor(channelId);
    if (row === undefined || !row.notePending || row.sessionId !== sessionId) return undefined;
    return this.deps.note;
  }

  /** 前置きを消す（§3.6.1 の表で「消す」の結果） */
  noteDone(channelId: string): void {
    this.deps.takeovers.clearNote(channelId);
  }

  /**
   * turn.ts が SDK セッションを捨てる直前（§3.6.3）: 捨てる sessionId がそのチャンネル（行き先）の取り込んだものと同じなら、前置きを消し、
   * チャンネルに 1 回だけ知らせる（待たない・投げない）
   */
  resumeDropped(channelId: string, sessionId: string): void {
    const { takeovers, gateway, log } = this.deps;
    const row = takeovers.takenFor(channelId);
    if (row === undefined || row.sessionId !== sessionId || row.targetChannelId === null) return;
    takeovers.clearNote(channelId);
    if (this.droppedNoticed.has(row.id)) return;
    this.droppedNoticed.add(row.id);
    log(`Claude Code: 取り込んだ会話を続けられず、新しい会話にしました（#${row.id}、guild=${row.guildId}）`);
    this.record(row.guildId, row.targetChannelId, "notice", TAKEOVER_DROPPED_TEXT);
    void gateway.sendMessage(row.targetChannelId, { text: TAKEOVER_DROPPED_TEXT }).catch((error: unknown) => {
      log(`Claude Code: 取り込んだ会話の知らせを出せませんでした（#${row.id}、${errorKind(error)}）`);
    });
  }

  /**
   * check → channel → term → copy → commit（§4）。成功なら行き先のチャンネル、失敗なら符号。SIGTERM を送ったら progress.afterTerm を、
   * 終了を見届けたら progress.exited を立てる。
   * check が通るまでチャンネルを作らない。作ったチャンネルは直後に target_channel_id に書き、以後の失敗は failed() が消す
   */
  private async run(row: CcTakeoverRow, progress: { afterTerm: boolean; exited: boolean }): Promise<{ channelId: string } | TakeoverFailure> {
    const { takeovers, ccSessions, sdkSessions, dirs, queue, log } = this.deps;
    const id = row.id;
    const sessionId = row.sessionId;
    takeovers.setStep(id, "check");
    // 届け待ちが無いことの確かめは start の後（ここ）で行う（§3.2）
    const assessed = await this.assess(sessionId, await this.readList());
    if (!assessed.ok) return assessed.code;
    // 確認の後に終わった・戻った、場所が変わったものは、確認した内容と違うので断る
    if (assessed.source !== row.source || assessed.project !== row.project) return "changed";
    const paths = takeoverPaths(this.deps.home, this.deps.claudeConfigDir, assessed.cwd, sessionId);
    if (paths === undefined) return "no_transcript";
    const inspected = this.files.inspectSource(paths.src);
    if (!inspected.ok) return inspected.reason;
    let first: { pid: number; startTime: number } | undefined;
    if (assessed.source === "alive") {
      const pid = assessed.view!.pid;
      const stat = this.stat(pid);
      if (stat === undefined) return "identity";
      first = { pid, startTime: stat.startTime };
    }
    // 写し先の用意はチャンネルを作る前に済ませる（作ってすぐ消す場合を減らす）
    const projectsRoot = join(this.deps.claudeConfigDir, "projects");
    const target = this.files.prepareTarget(paths.dstDir, projectsRoot, dirname(paths.src));
    if (target === "invalid") return "target_invalid";

    // 新しいチャンネル（§3.1）: /new と同じキューの中で、進行中のカテゴリの解決とチャンネルの作成。期限は注入の sleep との競争（kill の前なので端末はそのまま）
    takeovers.setStep(id, "channel");
    const title = this.titleOf(ccSessions.get(sessionId), row.project);
    const creating = queue.run(layoutQueueKey(row.guildId), () => this.deps.createChannel(row.guildId, title, row.project));
    let created: NewTopicChannelResult | undefined;
    try {
      created = await Promise.race([creating, this.deps.sleep(TAKEOVER_CHANNEL_TIMEOUT_MS).then(() => undefined)]);
    } catch (error) {
      log(`Claude Code: 取り込みの新しいチャンネルを作れませんでした（#${id}、${errorKind(error)}）`);
      // 期限の待ちが投げたときは、作成が後から返りうる（作成自身が投げたのなら何も起きない）
      this.dropLate(id, creating);
      return "no_channel";
    }
    if (created === undefined) {
      log(`Claude Code: 取り込みの新しいチャンネルを期限までに作れませんでした（#${id}）`);
      this.dropLate(id, creating);
      return "no_channel";
    }
    if (created.result === "not_set_up") {
      log(`Claude Code: 取り込みの新しいチャンネルを作れませんでした（#${id}、not_set_up）`);
      return "no_channel";
    }
    const channelId = created.channelId;
    const categoryId = created.categoryId;
    let targeted: boolean;
    try {
      targeted = takeovers.setTarget(id, channelId);
    } catch (error) {
      // UNIQUE（別の行の行き先かもしれない）か DB の失敗。消さずに、手で消せるようチャンネル ID を出す（ログ方針の例外）
      log(`Claude Code: 取り込みの行き先を DB に書けませんでした。手で消してください（#${id}、channel=${channelId}、${errorKind(error)}）`);
      return "internal";
    }
    if (!targeted) {
      await this.dropUntracked(id, channelId);
      return "internal";
    }

    if (first !== undefined) {
      // 直前の競合（§3.4）: 2 秒おいて、一覧・ペイン・記録の増えた分を確かめ直す（ここから SIGTERM まで通信を挟まない）
      await this.deps.sleep(TAKEOVER_SETTLE_MS);
      const again = await this.assess(sessionId, await this.readList());
      if (!again.ok) return again.code;
      if (again.source !== "alive") return "changed";
      const appended = this.files.readAppended(paths.src, inspected.size);
      if (appended === undefined || appendedInterrupted(appended)) return "changed";
      takeovers.setStep(id, "term");
      const parentOf = (pid: number): number | undefined => this.stat(pid)?.ppid;
      const file = dirs.sessionFile(first.pid, sessionId);
      const identity = takeoverIdentity({
        view: again.view,
        first,
        sessionFile: file !== undefined,
        procStart: file?.procStart,
        stat: this.stat(first.pid),
        btimeSec: this.deps.readBtime(),
        ownPid: this.deps.ownPid,
        ownAncestors: lineage(this.deps.ownPid, parentOf),
        targetAncestors: lineage(first.pid, parentOf),
      });
      if (!identity) return "identity";
      try {
        this.deps.kill(first.pid, "SIGTERM");
      } catch (error) {
        log(`Claude Code: 取り込みの SIGTERM を送れませんでした（#${id}、${errorKind(error)}）`);
        // ESRCH は直前に自分で終わった（送っていない）
        return (error as { code?: unknown } | null)?.code === "ESRCH" ? "changed" : "identity";
      }
      progress.afterTerm = true;
      log(`Claude Code: 取り込みのため端末の Claude Code に SIGTERM を送りました（#${id}）`);
      if (!(await this.waitExit(first))) return "not_exited";
      progress.exited = true;
      // registry に追いつかせるだけ（読めなくても進む）
      try {
        await this.deps.registry.tick();
      } catch (error) {
        log(`Claude Code: 取り込みの後に一覧を読めませんでした（#${id}、${errorKind(error)}）`);
      }
      const later = this.files.readAppended(paths.src, inspected.size);
      if (later !== undefined && appendedInterrupted(later)) takeovers.setInterrupted(id);
    }
    // 終わったセッションが一覧に戻っていたら（端末で resume した）写さない。チャンネルの作成の間に戻ったものにも気づけるよう 1 回読み直す
    // （読めなくても今の snapshot で確かめて進む）
    if (row.source === "ended") await this.readList();
    if (row.source === "ended" && this.deps.registry.snapshot().sessions.some((candidate) => candidate.sessionId === sessionId)) return "changed";
    takeovers.setStep(id, "copy");
    let copied: ReturnType<typeof copyTranscript>;
    try {
      copied = this.files.copyTranscript({
        src: paths.src,
        dst: paths.dst,
        projectsRoot,
        hasMapping: sdkSessions.hasSessionId(sessionId),
        now: this.deps.now,
      });
    } catch (error) {
      log(`Claude Code: 取り込みの記録を写せませんでした（#${id}、${errorKind(error)}）`);
      return "copy_failed";
    }
    if (copied === "already_taken") return "already_taken";
    takeovers.setStep(id, "commit");
    const committed = this.commit(row, title, categoryId, channelId);
    if (committed !== undefined) return committed;
    return { channelId };
  }

  /**
   * commit（§4）: BEGIN IMMEDIATE の 1 つのトランザクションで、行き先の sessions の行・channel_sessions・取り込みを done。
   * 内側に BEGIN のある操作は呼ばない。cc のチャンネルの行には触らない（後始末で）。失敗なら巻き戻して copy_failed、成功なら undefined
   */
  private commit(row: CcTakeoverRow, title: string, categoryId: string, channelId: string): TakeoverFailure | undefined {
    const { db, topicSessions, sdkSessions, takeovers, log } = this.deps;
    db.exec("BEGIN IMMEDIATE");
    try {
      topicSessions.create({
        channelId,
        guildId: row.guildId,
        title,
        categoryId,
        origin: "command",
        projectDir: row.project,
        permissionMode: "default",
      });
      sdkSessions.set(channelId, row.sessionId);
      if (!takeovers.finish(row.id)) throw new Error("取り込みの行が実行中ではありません");
      db.exec("COMMIT");
      return undefined;
    } catch (error) {
      rollbackIfOpen(db);
      log(`Claude Code: 取り込みの DB の切り替えに失敗しました（#${row.id}、${errorKind(error)}）`);
      return "copy_failed";
    }
  }

  /**
   * 後始末（§4。失敗しても done のまま。投げない）: 行き先に完了の文・Web の履歴に区切りと知らせ → cc のチャンネル（open・ended）を deleted にして案内・完了へ
   * → Discord の確認の文を「取り込みました → <#…>」に → effects_at。完了の文（エスケープ前）と、確認の文を書き換えられたかを返す
   */
  private async effects(id: number): Promise<{ plainText: string; edited: boolean }> {
    const { takeovers, ccChannels, channelOps, gateway, log } = this.deps;
    const failed = (what: string) => (error: unknown) => log(`Claude Code: 取り込みの後に${what}できませんでした（#${id}、${errorKind(error)}）`);
    let row: CcTakeoverRow | undefined;
    try {
      row = takeovers.get(id);
    } catch (error) {
      failed("行を読み直")(error);
    }
    if (row === undefined || row.targetChannelId === null) return { plainText: "", edited: false };
    const target = row.targetChannelId;
    const text = takeoverDoneText(row.project, row.interrupted);
    const plainText = takeoverDoneText(row.project, row.interrupted, false);
    await gateway.sendMessage(target, { text }).then(() => undefined, failed("完了の文を出"));
    this.record(row.guildId, target, "divider", takeoverDivider(row.project));
    // 完了の文（注意を含む）も Web の会話に残す（history は文字のまま出すのでエスケープ前）
    this.record(row.guildId, target, "notice", plainText);
    // 共存の間だけ（§3.2）: 状態を読んでから deleted にするまで await を挟まない。resuming・行が無いときは何もしない
    let moved: { channelId: string; guildId: string } | undefined;
    try {
      const channel = ccChannels?.anyFor(row.sessionId);
      if (channel !== undefined && (channel.state === "open" || channel.state === "ended") && ccChannels!.markDeleted(channel.channelId)) {
        moved = { channelId: channel.channelId, guildId: channel.guildId };
      }
    } catch (error) {
      failed("cc のチャンネルを閉じ")(error);
    }
    if (moved !== undefined) {
      await gateway.sendMessage(moved.channelId, { text: takeoverMovedText(target) }).then(() => undefined, failed("cc のチャンネルに案内を出"));
      try {
        channelOps.enqueueMove(moved.channelId, { kind: "state", guildId: moved.guildId, state: "done" });
      } catch (error) {
        failed("cc のチャンネルを完了へ移")(error);
      }
    }
    let edited = false;
    if (row.confirmChannelId !== null && row.confirmMessageId !== null) {
      edited = await gateway.editMessage(row.confirmChannelId, row.confirmMessageId, { text: takeoverLinkText(target), components: [] }).then(
        () => true,
        (error: unknown) => {
          failed("確認の文を書き換え")(error);
          return false;
        },
      );
    }
    try {
      takeovers.markEffects(id);
    } catch (error) {
      failed("後始末の済みを書")(error);
    }
    return { plainText, edited };
  }

  /**
   * 失敗（§4）: failed にし、作った行き先のチャンネルを消し（sessions の行が無いときだけ）、確認の文を失敗の文に書き換える。
   * 投げない（DB の例外でも失敗の結果を返す）。例外で行が running のまま残ったら、次の起動の recoverRunning が restart にして直す
   */
  private async failed(row: CcTakeoverRow, code: TakeoverFailure, term: TakeoverTerm): Promise<CcTakeoverConfirmResult> {
    const { takeovers, log } = this.deps;
    const id = row.id;
    const text = failureText(code, term);
    let current: CcTakeoverRow | undefined;
    try {
      const before = takeovers.get(id);
      takeovers.fail(id, code);
      log(`Claude Code: 取り込めませんでした（#${id}、${code}、step=${before?.step ?? "-"}、guild=${row.guildId}）`);
      current = takeovers.get(id);
    } catch (error) {
      log(`Claude Code: 取り込めなかった後の処理で例外が起きました（#${id}、${code}、${errorKind(error)}）`);
    }
    if (current !== undefined && current.targetChannelId !== null) await this.dropTarget(id, current.targetChannelId);
    // 確認の文には名前が入らない（エスケープ前と同じ）。DB を読めなければ confirm の時の行で
    const edited = await this.editConfirm(id, { text, components: [] }, current ?? row);
    return { ok: false, reason: code, text, plainText: text, edited };
  }

  /**
   * 行き先に書いた（target_channel_id の）チャンネルを消す（§3.1）。sessions に行があれば消さない。消せたら clearTarget、
   * 消せなければ行き先を残して log にチャンネル ID（手で消せるよう。ログ方針の例外）。投げない
   */
  private async dropTarget(id: number, channelId: string): Promise<void> {
    const { takeovers, log } = this.deps;
    if (!this.unclaimed(id, channelId)) return;
    try {
      await this.deps.gateway.deleteChannel(channelId);
    } catch (error) {
      log(`Claude Code: 取り込みで作ったチャンネルを消せませんでした。次の起動でもう一度消します（#${id}、channel=${channelId}、${errorKind(error)}）`);
      return;
    }
    try {
      takeovers.clearTarget(id);
    } catch (error) {
      log(`Claude Code: 取り込みで作ったチャンネルを消しましたが、行き先を空に戻せませんでした（#${id}、${errorKind(error)}）`);
      return;
    }
    log(`Claude Code: 取り込みで作ったチャンネルを消しました（#${id}）`);
  }

  /** 期限の後（か期限の待ちが投げた後）に作成が返ったら、そのチャンネルを消す（待たない。作成が投げたら何もしない） */
  private dropLate(id: number, creating: Promise<NewTopicChannelResult>): void {
    void creating.then(
      (late) => (late.result === "created" ? this.dropUntracked(id, late.channelId) : undefined),
      () => undefined,
    );
  }

  /**
   * DB に書けなかった（期限の後にできた・setTarget が false だった）チャンネルをその場で消す（§3.1）。sessions に行があれば消さない。
   * 消せなければ log にチャンネル ID（手で消せるよう。/new の DB の保存の失敗と同じ扱い）。投げない
   */
  private async dropUntracked(id: number, channelId: string): Promise<void> {
    if (!this.unclaimed(id, channelId)) return;
    try {
      await this.deps.gateway.deleteChannel(channelId);
      this.deps.log(`Claude Code: 取り込みで作ったチャンネルを消しました（#${id}）`);
    } catch (error) {
      this.deps.log(`Claude Code: 取り込みで作ったチャンネルを消せませんでした。手で消してください（#${id}、channel=${channelId}、${errorKind(error)}）`);
    }
  }

  /** そのチャンネルに sessions の行が無いか（あるチャンネルは消さない。読めなければ消さない側に倒す） */
  private unclaimed(id: number, channelId: string): boolean {
    try {
      if (this.deps.topicSessions.get(channelId) === undefined) return true;
      this.deps.log(`Claude Code: 取り込みの行き先が話題になっているため消しませんでした（#${id}）`);
    } catch (error) {
      this.deps.log(`Claude Code: 取り込みの行き先が話題か確かめられなかったため消しませんでした（#${id}、${errorKind(error)}）`);
    }
    return false;
  }

  /**
   * 確認の文を書き換える（Discord の確認の投稿があるときだけ。失敗は log だけ）。書き換えたら true。
   * fallback は DB を読めないときの行（読めればその時の行を使う。投稿の返りより先に [取り込む] が押されても書き換えられるように）
   */
  private async editConfirm(id: number, message: OutgoingMessage, fallback?: CcTakeoverRow): Promise<boolean> {
    let row: CcTakeoverRow | undefined;
    try {
      row = this.deps.takeovers.get(id);
    } catch {
      row = fallback;
    }
    if (row === undefined || row.confirmChannelId === null || row.confirmMessageId === null) return false;
    try {
      await this.deps.gateway.editMessage(row.confirmChannelId, row.confirmMessageId, message);
      return true;
    } catch (error) {
      this.deps.log(`Claude Code: 取り込みの確認の文を書き換えられませんでした（#${id}、${errorKind(error)}）`);
      return false;
    }
  }

  /** 今読んだ一覧か（§3.4）: 読む前の時刻 → tick → stale でも unreadable でもなく、fetchedAt が読む前の時刻以後 */
  private async readList(): Promise<boolean> {
    const { registry, now } = this.deps;
    const t0 = now().getTime();
    try {
      await registry.tick();
    } catch {
      return false;
    }
    const snapshot = registry.snapshot();
    return !snapshot.stale && !snapshot.unreadable && snapshot.fetchedAt !== undefined && snapshot.fetchedAt >= t0;
  }

  /**
   * 取り込めるか（§3.2・§3.4）。今の一覧にあれば生きているセッション（ペインを撮る）、無ければ終わったセッション（cc_sessions が gone のときだけ）。
   * cwd は一覧の行 → 無ければ cc_sessions の行。cwd の形は projectOf。assumePane を渡せばペインを撮らずにその状態として見る（takeable の前もっての絞り込み）
   */
  private async assess(sessionId: string, listFresh: boolean, assumePane?: TakeoverPane): Promise<Assessed> {
    const { registry, ccSessions, ccSends, ccPermissions, sdkSessions } = this.deps;
    const snapshot = registry.snapshot();
    const view = snapshot.sessions.find((candidate) => candidate.sessionId === sessionId);
    const session = ccSessions.get(sessionId);
    const cwd = view !== undefined ? (view.cwd ?? null) : (session?.cwd ?? null);
    const project = this.projectOf(cwd);
    const pane: TakeoverPane | undefined =
      view !== undefined && listFresh ? (assumePane ?? (await this.paneOf(view, snapshot.sessions))) : undefined;
    const code = takeoverRefusal({
      ready: this.deps.ready(),
      listFresh,
      session: view !== undefined ? { source: "alive", view, pane: pane ?? "failed" } : { source: "ended" },
      project,
      queued: ccSends?.activeFor(sessionId) !== undefined ? 1 : 0,
      pendingPermission: ccPermissions?.pendingFor(sessionId) !== undefined || view?.pendingPermission === true,
      mapped: sdkSessions.hasSessionId(sessionId),
    });
    if (code !== undefined) return { ok: false, code };
    // 一覧に無いのに gone になっていない（registry がまだ見ていない）ものは、終わったと言えない
    if (view === undefined && (session === undefined || session.goneAt === null)) return { ok: false, code: "identity" };
    return { ok: true, source: view !== undefined ? "alive" : "ended", view, cwd: cwd!, project: project!, session };
  }

  /**
   * cwd の形（§3.4）: takeoverProjectName の名前が checkSessionProject を通り、端末の cwd（末尾の / を除く）が verifiedProjectDir と同じ文字列のときだけ名前
   */
  private projectOf(cwd: string | null): string | undefined {
    if (cwd === null) return undefined;
    const name = takeoverProjectName(cwd, this.deps.cfg.workspaceDir);
    if (name === undefined || !this.deps.checkSessionProject(name).ok) return undefined;
    const dir = this.deps.verifiedProjectDir(name);
    return dir !== undefined && cwd.replace(/\/+$/, "") === dir ? name : undefined;
  }

  /**
   * 生きているセッションのペインの状態。引く口・撮る口が無い・tmux のサーバーが無い・tmux の外は not_in_tmux、
   * ほかの引けない・撮れないは failed（tmux_failed で断る）
   */
  private async paneOf(view: CcSessionView, sessions: readonly CcSessionView[]): Promise<TakeoverPane> {
    const { panes, probePane } = this.deps;
    if (panes === undefined || probePane === undefined) return "not_in_tmux";
    try {
      const lookup = await panes.lookup(new Set(sessions.map((candidate) => candidate.pid)));
      if (!lookup.ok) return lookup.reason === "no_server" ? "not_in_tmux" : "failed";
      const target = lookup.sendable({ pid: view.pid, tmux: view.tmux });
      if (!target.ok) return "not_in_tmux";
      const probe = await probePane(target.pane.paneId);
      return probe.ok ? probe.state : "failed";
    } catch {
      return "failed";
    }
  }

  /** /proc/<pid>/stat（読めなければ undefined） */
  private stat(pid: number): ProcStat | undefined {
    try {
      const raw = this.deps.readProc(pid);
      return raw === undefined ? undefined : parseStat(raw);
    } catch {
      return undefined;
    }
  }

  /** SIGTERM の後、/proc/<pid> が消える（か starttime が変わる）のを TAKEOVER_EXIT_POLL_MS ごとに TAKEOVER_EXIT_TIMEOUT_MS まで待つ（§3.4） */
  private async waitExit(first: { pid: number; startTime: number }): Promise<boolean> {
    for (let waited = 0; waited < TAKEOVER_EXIT_TIMEOUT_MS; waited += TAKEOVER_EXIT_POLL_MS) {
      await this.deps.sleep(TAKEOVER_EXIT_POLL_MS);
      const stat = this.stat(first.pid);
      if (stat === undefined || stat.startTime !== first.startTime) return true;
    }
    return false;
  }

  /** 題名（§3.1）: cc_sessions.name を normalizeTopicTitle に通して TOPIC_TITLE_MAX_LENGTH 字（コードポイント）で切ったもの。空ならプロジェクトの名前 */
  private titleOf(session: CcSessionRow | undefined, project: string): string {
    const title = [...normalizeTopicTitle(session?.name ?? "")].slice(0, TOPIC_TITLE_MAX_LENGTH).join("").trimEnd();
    return title === "" ? project : title;
  }

  /** そのチャンネルの Web の会話に 1 行（無ければ書かない。失敗は log だけ） */
  private record(guildId: string, channelId: string, kind: "notice" | "divider", text: string): void {
    recordHistory(this.deps.history, { guildId, channelId, kind, source: "system", persona: DEFAULT_PERSONA_ID, text }, this.deps.log);
  }
}

const REAL_TIMERS: CcTimers = {
  after: (fn, ms) => {
    const timer = setTimeout(fn, ms);
    return () => clearTimeout(timer);
  },
};

/**
 * 確認の失効（CcTakeover の expire）を TAKEOVER_EXPIRE_SWEEP_MS ごとに呼ぶ（app/commands/cc-confirm.ts の CcConfirmExpirer と同じ形）。
 * main が SELF_AGENT_CC=1 のときだけ作り、停止で止める
 */
export class CcTakeoverExpirer {
  private readonly takeover: Pick<CcTakeover, "expire">;
  private readonly log: (message: string) => void;
  private readonly timers: CcTimers;
  private cancelTimer: (() => void) | undefined;
  private started = false;
  private stopped = false;
  private running: Promise<void> | undefined;

  constructor(deps: { takeover: Pick<CcTakeover, "expire">; log: (message: string) => void; timers?: CcTimers }) {
    this.takeover = deps.takeover;
    this.log = deps.log;
    this.timers = deps.timers ?? REAL_TIMERS;
  }

  /** 直後に 1 回確かめ、以後は TAKEOVER_EXPIRE_SWEEP_MS ごと。stop の後・2 回目は何もしない */
  start(): void {
    if (this.started || this.stopped) return;
    this.started = true;
    this.loop();
  }

  stop(): void {
    this.stopped = true;
    this.cancelTimer?.();
    this.cancelTimer = undefined;
  }

  async idle(): Promise<void> {
    await this.running;
  }

  private loop(): void {
    if (this.stopped) return;
    void this.sweep().then(() => {
      if (this.stopped) return;
      this.cancelTimer = this.timers.after(() => {
        this.cancelTimer = undefined;
        this.loop();
      }, TAKEOVER_EXPIRE_SWEEP_MS);
    });
  }

  /** 1 回確かめる（テストから直接呼ぶ）。reject しない */
  sweep(): Promise<void> {
    if (this.running !== undefined) return this.running;
    const running = this.takeover
      .expire()
      .then(
        () => undefined,
        (error: unknown) => {
          this.log(`Claude Code: 取り込みの確認の失効を確かめられませんでした（${errorKind(error)}）`);
        },
      )
      .finally(() => {
        this.running = undefined;
      });
    this.running = running;
    return running;
  }
}
