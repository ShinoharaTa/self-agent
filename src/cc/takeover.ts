// 取り込み（docs/plan/takeover.md。#341）の本体。端末の tmux で動いている（か、終わった）Claude Code の会話を、その cc のチャンネルを
// その場でプロジェクトのセッションに変えて引き継ぐ。手順は §4: 確認（propose）→ [取り込む]（confirm）で check → term（生きているときだけ SIGTERM）
// → copy（記録を CLAUDE_CONFIG_DIR へ写す）→ commit（1 つのトランザクションで cc の行を deleted・sessions と channel_sessions の行・取り込みを done）
// → 後始末（進行中へ移す・topic・完了の文など。失敗しても done）。
// running の間は ended の知らせを差し止め（intercept。§3.2）、失敗したら流し直す。送信とチャンネルの操作は holds・holdsChannel で断る（sender.ts・channels.ts）。
// 再起動の後は recover（running を failed（restart）にし、差し止めた ended を流し直し、後始末の残りの移動と topic をやり直す）。
// 部品はすべて注入（kill・/proc の読み取り・sleep も）。T2 では main に配線しない。
// log は理由の符号・段・取り込みの番号・サーバー ID だけ（session_id・pid・cwd・名前・パス・本文は出さない）
import type { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { ChannelOpsQueue } from "../app/channel-ops.ts";
import { CC_CONFIRM_TTL_MS } from "../app/commands/cc-confirm.ts";
import { layoutQueueKey } from "../app/commands/setup.ts";
import type { KeyedSerialQueue } from "../app/queue.ts";
import { sessionTopic, type ProjectSessionCheck } from "../app/session-ops.ts";
import { DEFAULT_PERSONA_ID, type Config } from "../config.ts";
import { escapeDiscordText } from "../discord/escape.ts";
import type { Gateway, OutgoingMessage } from "../discord/gateway.ts";
import type { CcChannelRow, CcChannelStore } from "../store/cc-channels.ts";
import type { CcPermissionStore } from "../store/cc-permissions.ts";
import type { CcSendStore } from "../store/cc-sends.ts";
import { headChars, type CcSessionRow, type CcSessionStore } from "../store/cc-sessions.ts";
import type { CcTakeoverEntry, CcTakeoverRow, CcTakeoverSource, CcTakeoverStore } from "../store/cc-takeovers.ts";
import { rollbackIfOpen } from "../store/db.ts";
import type { GuildSettingsStore } from "../store/guild-settings.ts";
import { recordHistory, type HistoryStore } from "../store/history.ts";
import type { SdkSessionStore } from "../store/sdk-sessions.ts";
import type { TopicSessionStore } from "../store/topic-sessions.ts";
import type { ProbeResult } from "../tmux/pane-state.ts";
import { resumeProject } from "./channels.ts";
import type { ClaudeDirs } from "./claude-dirs.ts";
import type { CcPaneResolver } from "./panes.ts";
import type { CcRegistry, CcSessionView } from "./registry.ts";
import { normalizeTitle } from "./starter.ts";
import { copyTranscript, inspectSource, prepareTarget, readAppended, takeoverPaths } from "./takeover-files.ts";
import {
  appendedInterrupted,
  lineage,
  parseBtime,
  parseStat,
  type ProcStat,
  TAKEOVER_CATEGORY_TIMEOUT_MS,
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

/** 確認の有効な長さ（cc_send の確認と同じ 10 分。§3.5） */
export const TAKEOVER_CONFIRM_TTL_MS = CC_CONFIRM_TTL_MS;
/** [取り込む]（`cc:take:go:<id>`）・[やめる]（`cc:take:no:<id>`）の custom_id の頭（§3.5） */
export const TAKEOVER_GO_PREFIX = "cc:take:go";
export const TAKEOVER_NO_PREFIX = "cc:take:no";

/** 確認が期限切れになったときの確認の文（§5.2） */
export const TAKEOVER_EXPIRED_TEXT = "取り込みの確認は期限切れです（10 分）。";
/** cc のチャンネルの外で取り込もうとしたとき（§5.5） */
export const TAKEOVER_NOT_CHANNEL_TEXT = "Claude Code のチャンネルの中で使ってください（無ければ /cc open）。";
/** 終わらせる直前に端末で動きがあったときに完了の文に足す 1 行（§4） */
export const TAKEOVER_INTERRUPTED_TEXT = "取り込みの直前に端末で動きがありました。最後の指示は途中で止まっているかもしれません。";
/** ended のチャンネルの削除の確認（#system の cc:del）の書き換え（§3.1） */
export const TAKEOVER_DELETE_PROMPT_TEXT = "取り込まれました";
/** 追いかけ先が取り込み先と別のチャンネルだったときの 1 行（§3.2） */
export const TAKEOVER_FOLLOW_STOPPED_TEXT = "このセッションは self-agent のチャンネルに取り込んだため、ここでの返事の追いかけをやめました";
/** 取り込んだ会話を resume できずに新しい会話にしたときの 1 行（§3.6.3） */
export const TAKEOVER_DROPPED_TEXT =
  "取り込んだ会話を続けられなくなったため、新しい会話として続けます。元の会話は端末で claude --resume で開けます。";

/** 名前・題名の表示の上限 */
const LABEL_MAX_CHARS = 100;

/** 1 行の表示（制御文字を空白にし、Markdown とメンションを無効にする） */
function label(text: string): string {
  return escapeDiscordText(headChars(text.replace(/[\u0000-\u001f\u007f]/g, " "), LABEL_MAX_CHARS));
}

/** 確認の文（§4。純関数） */
export function takeoverConfirmText(input: { title: string; project: string; source: CcTakeoverSource; terminalMode: string | null }): string {
  const ending = input.source === "alive" ? "端末の Claude Code は終了し、" : "端末の Claude Code はすでに終わっています。";
  return (
    `「${label(input.title)}」（${label(input.project)}）を取り込みます。${ending}続きはこのチャンネルで self-agent が引き継ぎます。` +
    `許可のモードは default になります（端末: ${label(input.terminalMode ?? "不明")}）。モデルは self-agent の設定のものになります。`
  );
}

/** 完了の文（§4。純関数） */
export function takeoverDoneText(project: string, interrupted: boolean): string {
  const text =
    `取り込みました。ここから先は self-agent がこの会話を続けます（${label(project)}・許可のモード default）。` +
    "端末で claude --resume すると取り込む前までの会話が別に開きます（ここでの続きは入りません）。";
  return interrupted ? `${text}\n${TAKEOVER_INTERRUPTED_TEXT}` : text;
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

/** /proc/<pid>/stat を読む（読めなければ undefined。T3b の配線で readProc に渡す） */
export function readProcStat(pid: number): string | undefined {
  if (!Number.isSafeInteger(pid) || pid < 1) return undefined;
  try {
    return readFileSync(`/proc/${pid}/stat`, "utf8");
  } catch {
    return undefined;
  }
}

/** /proc/stat の btime（読めなければ undefined。T3b の配線で readBtime に渡す） */
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

/** 前置き（§3.6.1）を付けるかを決めるターンの材料（T3a の turn.ts が渡す） */
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
  panes: Pick<CcPaneResolver, "lookup">;
  /** ペインを撮って状態を返す（tmux/pane-state.ts の probePaneState） */
  probePane: (paneId: string) => Promise<ProbeResult>;
  dirs: Pick<ClaudeDirs, "sessionFile">;
  takeovers: CcTakeoverStore;
  ccChannels: Pick<CcChannelStore, "get" | "markTaken">;
  ccSessions: Pick<CcSessionStore, "get" | "stopFollow">;
  ccSends: Pick<CcSendStore, "activeFor">;
  ccPermissions: Pick<CcPermissionStore, "pendingFor">;
  topicSessions: Pick<TopicSessionStore, "create">;
  sdkSessions: Pick<SdkSessionStore, "hasSessionId" | "set">;
  /** #system（削除の確認の書き換え） */
  guildSettings: Pick<GuildSettingsStore, "get">;
  /** ProjectSessionGate.ready（SELF_AGENT_CC=1 とプロジェクトのセッションの準備） */
  ready: () => boolean;
  /** app/session-ops.ts の checkSessionProject（gate を束ねたもの） */
  checkSessionProject: (name: string) => ProjectSessionCheck;
  /** cc/starter.ts の projectDir（runner の cwd。places を束ねたもの） */
  verifiedProjectDir: (name: string) => string | undefined;
  /** 進行中のカテゴリ（app/categories.ts の findStateCategory。queue の中で呼ぶ） */
  findStateCategory: (guildId: string, state: "active") => Promise<string>;
  /** /setup・/new と同じキュー（key は layoutQueueKey） */
  queue: Pick<KeyedSerialQueue, "run">;
  channelOps: Pick<ChannelOpsQueue, "enqueueMove">;
  /** 確認の文の書き換え・完了の文・topic・追いかけ先への 1 行（既定の人格の Bot） */
  gateway: Pick<Gateway, "sendMessage" | "editMessage" | "setChannelTopic">;
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
  /** 差し止めた ended を流し直す（channels.ts の ccReplayEnded）。届け先がまだ無く流さなかったら false（印を残して次の recover で流す） */
  replayEnded: (session: CcSessionRow) => boolean;
  /** 最初のターンの前置き（TAKEOVER_NOTE。T3a）。無ければ noteFor は何も返さない */
  note?: string;
  files?: Partial<TakeoverFiles>;
  log: (message: string) => void;
};

/** propose の結果。message は確認の文とボタン（投稿して setConfirmMessage するのは呼び出し側） */
export type CcTakeoverProposeResult =
  | { ok: true; id: number; message: OutgoingMessage }
  | { ok: false; reason: TakeoverFailure | "not_channel"; text: string };

/** confirm の結果。stale = 確認待ちでない、expired = 10 分を過ぎた（取り消した） */
export type CcTakeoverConfirmResult =
  | { ok: true; text: string }
  | { ok: false; reason: "stale" | "expired" }
  | { ok: false; reason: TakeoverFailure; text: string };

/** 条件を見た結果（§3.2・§3.4） */
type Assessed =
  | { ok: false; code: TakeoverFailure }
  | { ok: true; source: CcTakeoverSource; view: CcSessionView | undefined; cwd: string; project: string; session: CcSessionRow | undefined };

/** commit まで進んだときの後始末の材料 */
type Committed = { title: string; project: string; followChannelId: string | null; deletePromptMessageId: string | null };

function errorKind(error: unknown): string {
  return error instanceof Error ? error.name : typeof error;
}

export class CcTakeover {
  private readonly deps: CcTakeoverDeps;
  private readonly files: TakeoverFiles;
  /** resumeDropped を知らせた取り込み（1 回だけ。プロセスの中だけ） */
  private readonly droppedNoticed = new Set<number>();

  constructor(deps: CcTakeoverDeps) {
    this.deps = deps;
    this.files = { inspectSource, prepareTarget, copyTranscript, readAppended, ...deps.files };
  }

  /**
   * 確認を作る（§5.2）: cc のチャンネル（削除されていない行）→ 一覧を読む → 条件（takeoverRefusal）→ awaiting_confirm の行を作り、確認の文とボタンを返す。
   * 断るときは符号と文
   */
  async propose(input: { channelId: string; entry: CcTakeoverEntry }): Promise<CcTakeoverProposeResult> {
    const { ccChannels, takeovers, log } = this.deps;
    const channel = ccChannels.get(input.channelId);
    if (channel === undefined || channel.state === "deleted") return { ok: false, reason: "not_channel", text: TAKEOVER_NOT_CHANNEL_TEXT };
    const refuse = (code: TakeoverFailure): CcTakeoverProposeResult => {
      log(`Claude Code: 取り込みを断りました（${code}、guild=${channel.guildId}）`);
      return { ok: false, reason: code, text: takeoverFailureText(code, false) };
    };
    if (takeovers.activeFor(channel.sessionId) !== undefined) return refuse("in_progress");
    const fresh = await this.readList();
    const assessed = await this.assess(channel, fresh);
    if (!assessed.ok) return refuse(assessed.code);
    const current = ccChannels.get(input.channelId);
    if (current === undefined || current.state === "deleted" || current.sessionId !== channel.sessionId) return refuse("channel_changed");
    const terminalMode = assessed.session?.permissionMode ?? assessed.view?.permissionMode ?? null;
    const row = takeovers.propose({
      sessionId: channel.sessionId,
      source: assessed.source,
      project: assessed.project,
      guildId: channel.guildId,
      channelId: channel.channelId,
      entry: input.entry,
      // U2 まで常に default（§3.6。mapTakeoverMode は呼ばない）
      permissionMode: "default",
      terminalMode,
    });
    if (row === undefined) return refuse("in_progress");
    log(`Claude Code: 取り込みの確認を作りました（#${row.id}、${row.source}、guild=${row.guildId}）`);
    const title = this.titleOf(assessed.session, assessed.project);
    return {
      ok: true,
      id: row.id,
      message: { text: takeoverConfirmText({ title, project: assessed.project, source: assessed.source, terminalMode }), components: takeoverButtons(row.id) },
    };
  }

  /** [取り込む]（§4）: 確認待ちを running にして step を順に進める。結果の文で確認の文を書き換える */
  async confirm(id: number): Promise<CcTakeoverConfirmResult> {
    const { takeovers, now, log } = this.deps;
    const row = takeovers.get(id);
    if (row === undefined || row.state !== "awaiting_confirm") return { ok: false, reason: "stale" };
    if (now().getTime() - Date.parse(row.createdAt) >= TAKEOVER_CONFIRM_TTL_MS) {
      if (!takeovers.cancel(id)) return { ok: false, reason: "stale" };
      log(`Claude Code: 取り込みの確認の期限が過ぎていました（#${id}、guild=${row.guildId}）`);
      await this.editConfirm(id, { text: TAKEOVER_EXPIRED_TEXT, components: [] });
      return { ok: false, reason: "expired" };
    }
    if (!takeovers.start(id)) return { ok: false, reason: "stale" };
    log(`Claude Code: 取り込みを始めます（#${id}、${row.source}、guild=${row.guildId}）`);
    const progress = { afterTerm: false };
    let outcome: Committed | TakeoverFailure;
    try {
      outcome = await this.run(row, progress);
    } catch (error) {
      log(`Claude Code: 取り込みの途中で例外が起きました（#${id}、${errorKind(error)}）`);
      // SIGTERM より前なら端末はそのまま（internal）、後なら写し・切り替えの失敗と同じ
      outcome = progress.afterTerm ? "copy_failed" : "internal";
    }
    if (typeof outcome === "string") return this.failed(row, outcome, progress.afterTerm);
    log(`Claude Code: 取り込みました（#${id}、guild=${row.guildId}）`);
    const text = await this.effects(id, outcome);
    return { ok: true, text };
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

  /** そのセッションに running の取り込みがあるか（sender.ts の holds・channels.ts の revived） */
  holds(sessionId: string): boolean {
    return this.deps.takeovers.runningFor(sessionId) !== undefined;
  }

  /** そのチャンネルに running の取り込みがあるか（channels.ts の resume・close、[削除する]） */
  holdsChannel(channelId: string): boolean {
    return this.deps.takeovers.runningForChannel(channelId) !== undefined;
  }

  /**
   * registry の ended（ccEndedHandler）: そのセッションに running の取り込みがあれば ended_held を 1 にして true（channels.ended・replier.ended を呼ばない）。
   * 無ければ false。投げない（読めなければ false で、ended は今までどおり流れる）
   */
  intercept(session: Pick<CcSessionRow, "sessionId">): boolean {
    try {
      const row = this.deps.takeovers.runningFor(session.sessionId);
      if (row === undefined) return false;
      if (this.deps.takeovers.hold(row.id)) this.deps.log(`Claude Code: 取り込みの途中のため、終わった知らせを差し止めました（#${row.id}）`);
      return true;
    } catch (error) {
      this.deps.log(`Claude Code: 取り込みの差し止めを確かめられませんでした（${errorKind(error)}）`);
      return false;
    }
  }

  /**
   * 起動時（registry を始める前）に 1 回（§3.4）: running の行を failed（restart）にし（確認の文があれば失敗の文に書き換える。待たない。§9.1）、
   * 差し止めた ended を流し直し（届け先があって流せた行だけ印を外す）、後始末の済んでいない done の行の移動と topic をやり直す（topic は待たない）
   */
  async recover(): Promise<void> {
    const { takeovers, ccSessions, channelOps, gateway, log } = this.deps;
    const reset = takeovers.resetRunning();
    if (reset.length > 0) log(`Claude Code: 再起動の前の取り込み ${reset.length} 件を失敗にしました（restart）`);
    for (const row of reset) {
      if (row.confirmMessageId === null) continue;
      // SIGTERM を送ったか分からない段なら、言い切らずに続け方を足す
      const maybeTerm = row.source === "alive" && (row.step === "term" || row.step === "copy" || row.step === "commit");
      const text = `${takeoverFailureText("restart", false)}${maybeTerm ? `\n${TAKEOVER_MAYBE_TERM_TEXT}` : ""}`;
      void Promise.resolve()
        .then(() => gateway.editMessage(row.channelId, row.confirmMessageId!, { text, components: [] }))
        .catch((error: unknown) => {
          log(`Claude Code: 再起動の前の取り込みの確認の文を書き換えられませんでした（#${row.id}、${errorKind(error)}）`);
        });
    }
    for (const row of takeovers.listHeld()) this.replayHeld(row);
    for (const row of takeovers.listEffectsPending()) {
      channelOps.enqueueMove(row.channelId, { kind: "state", guildId: row.guildId, state: "active" });
      const title = this.titleOf(ccSessions.get(row.sessionId), row.project);
      // 起動を遅らせない（失敗は log だけ）
      void Promise.resolve()
        .then(() => gateway.setChannelTopic(row.channelId, sessionTopic(title, undefined, row.project)))
        .catch((error: unknown) => {
          log(`Claude Code: 取り込んだチャンネルの topic を書き換えられませんでした（#${row.id}、${errorKind(error)}）`);
        });
      takeovers.markEffects(row.id);
      log(`Claude Code: 取り込みの後始末をやり直しました（#${row.id}、guild=${row.guildId}）`);
    }
  }

  /**
   * 最初のターンの前置き（§3.6.1。T3a の turn.ts が resume の経路で呼ぶ）。purpose・予約でなく、そのチャンネルの最新の done の取り込みが
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
   * turn.ts が SDK セッションを捨てる直前（§3.6.3）: 捨てる sessionId がそのチャンネルの取り込んだものと同じなら、前置きを消し、
   * チャンネルに 1 回だけ知らせる（待たない・投げない）
   */
  resumeDropped(channelId: string, sessionId: string): void {
    const { takeovers, gateway, log } = this.deps;
    const row = takeovers.takenFor(channelId);
    if (row === undefined || row.sessionId !== sessionId) return;
    takeovers.clearNote(channelId);
    if (this.droppedNoticed.has(row.id)) return;
    this.droppedNoticed.add(row.id);
    log(`Claude Code: 取り込んだ会話を続けられず、新しい会話にしました（#${row.id}、guild=${row.guildId}）`);
    this.record(row, "notice", TAKEOVER_DROPPED_TEXT);
    void gateway.sendMessage(row.channelId, { text: TAKEOVER_DROPPED_TEXT }).catch((error: unknown) => {
      log(`Claude Code: 取り込んだ会話の知らせを出せませんでした（#${row.id}、${errorKind(error)}）`);
    });
  }

  /** check → term → copy → commit（§4）。成功なら後始末の材料、失敗なら符号。SIGTERM を送ったら progress.afterTerm を立てる */
  private async run(row: CcTakeoverRow, progress: { afterTerm: boolean }): Promise<Committed | TakeoverFailure> {
    const { takeovers, ccChannels, ccSessions, sdkSessions, dirs, queue, log } = this.deps;
    const id = row.id;
    const sessionId = row.sessionId;
    takeovers.setStep(id, "check");
    // 届け待ちが無いことの確かめは start の後（ここ）で行う（§3.2）
    const assessed = await this.assessChannel(row, await this.readList());
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
    // 終わらせる前に済ませる（§3.4）: 進行中のカテゴリ（無ければここで作られ、失敗しても残る）と写し先
    let categoryId: string;
    try {
      // 期限は注入の sleep との競争（過ぎたら no_category。kill の前なので端末はそのまま）
      const found = await Promise.race([
        queue.run(layoutQueueKey(row.guildId), () => this.deps.findStateCategory(row.guildId, "active")),
        this.deps.sleep(TAKEOVER_CATEGORY_TIMEOUT_MS).then(() => undefined),
      ]);
      if (found === undefined) {
        log(`Claude Code: 取り込みの進行中のカテゴリを期限までに用意できませんでした（#${id}）`);
        return "no_category";
      }
      categoryId = found;
    } catch (error) {
      log(`Claude Code: 取り込みの進行中のカテゴリを用意できませんでした（#${id}、${errorKind(error)}）`);
      return "no_category";
    }
    const projectsRoot = join(this.deps.claudeConfigDir, "projects");
    const target = this.files.prepareTarget(paths.dstDir, projectsRoot, dirname(paths.src));
    if (target === "invalid") return "target_invalid";
    if (first !== undefined) {
      // 直前の競合（§3.4）: 2 秒おいて、一覧・ペイン・記録の増えた分を確かめ直す
      await this.deps.sleep(TAKEOVER_SETTLE_MS);
      const again = await this.assessChannel(row, await this.readList());
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
      // registry に追いつかせるだけ（読めなくても進む）。ここで ended が来れば intercept が差し止める
      try {
        await this.deps.registry.tick();
      } catch (error) {
        log(`Claude Code: 取り込みの後に一覧を読めませんでした（#${id}、${errorKind(error)}）`);
      }
      const later = this.files.readAppended(paths.src, inspected.size);
      if (later !== undefined && appendedInterrupted(later)) takeovers.setInterrupted(id);
    }
    // 終わったセッションが一覧に戻っていたら（端末で resume した）写さない（同期で見る）
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
    const session = ccSessions.get(sessionId);
    const title = this.titleOf(session, row.project);
    const before = ccChannels.get(row.channelId);
    const followChannelId = session?.follow === true && session.followChannelId !== row.channelId ? session.followChannelId : null;
    const committed = this.commit(row, title, categoryId);
    if (committed !== undefined) return committed;
    return { title, project: row.project, followChannelId, deletePromptMessageId: before?.deletePromptMessageId ?? null };
  }

  /**
   * commit（§4）: BEGIN IMMEDIATE の 1 つのトランザクションで、cc の行を条件付きで deleted（0 行なら巻き戻して channel_changed）・sessions の行・
   * channel_sessions・stopFollow・取り込みを done。内側に BEGIN のある操作は呼ばない。失敗なら符号、成功なら undefined
   */
  private commit(row: CcTakeoverRow, title: string, categoryId: string): TakeoverFailure | undefined {
    const { db, ccChannels, topicSessions, sdkSessions, ccSessions, takeovers, log } = this.deps;
    db.exec("BEGIN IMMEDIATE");
    try {
      if (!ccChannels.markTaken(row.channelId, row.sessionId)) {
        rollbackIfOpen(db);
        return "channel_changed";
      }
      topicSessions.create({
        channelId: row.channelId,
        guildId: row.guildId,
        title,
        categoryId,
        origin: "command",
        projectDir: row.project,
        permissionMode: "default",
      });
      sdkSessions.set(row.channelId, row.sessionId);
      ccSessions.stopFollow(row.sessionId);
      if (!takeovers.finish(row.id)) throw new Error("取り込みの行が実行中ではありません");
      db.exec("COMMIT");
      return undefined;
    } catch (error) {
      rollbackIfOpen(db);
      log(`Claude Code: 取り込みの DB の切り替えに失敗しました（#${row.id}、${errorKind(error)}）`);
      return "copy_failed";
    }
  }

  /** 後始末（§4。失敗しても done のまま）: 進行中へ移す・完了の文・履歴の区切り・削除の確認・追いかけ先への 1 行・topic → effects_at。完了の文を返す */
  private async effects(id: number, done: Committed): Promise<string> {
    const { takeovers, channelOps, gateway, guildSettings, log } = this.deps;
    const row = takeovers.get(id)!;
    channelOps.enqueueMove(row.channelId, { kind: "state", guildId: row.guildId, state: "active" });
    const failed = (what: string) => (error: unknown) => log(`Claude Code: 取り込みの後に${what}できませんでした（#${id}、${errorKind(error)}）`);
    const text = takeoverDoneText(done.project, row.interrupted);
    if (row.confirmMessageId !== null) {
      await gateway.editMessage(row.channelId, row.confirmMessageId, { text, components: [] }).catch(failed("確認の文を書き換え"));
    } else {
      await gateway.sendMessage(row.channelId, { text }).then(() => undefined, failed("完了の文を出"));
    }
    this.record(row, "divider", takeoverDivider(done.project));
    if (done.deletePromptMessageId !== null) {
      const systemChannelId = guildSettings.get(row.guildId)?.systemChannelId ?? null;
      if (systemChannelId !== null) {
        await gateway
          .editMessage(systemChannelId, done.deletePromptMessageId, { text: TAKEOVER_DELETE_PROMPT_TEXT, components: [] })
          .catch(failed("削除の確認を書き換え"));
      }
    }
    if (done.followChannelId !== null) {
      await gateway.sendMessage(done.followChannelId, { text: TAKEOVER_FOLLOW_STOPPED_TEXT }).then(() => undefined, failed("追いかけ先に知らせ"));
    }
    // topic は最後（確認の文の「取り込みました」を先に出す）
    await gateway.setChannelTopic(row.channelId, sessionTopic(done.title, undefined, done.project)).catch(failed("topic を書き換え"));
    takeovers.markEffects(id);
    return text;
  }

  /**
   * 失敗（§4）: failed にし、差し止めた ended があれば流し直し、確認の文を失敗の文に書き換える。投げない（DB の例外でも失敗の結果を返す）。
   * 例外で行が running のまま残ったら、次の recover（再起動）が restart にして直す
   */
  private async failed(row: CcTakeoverRow, code: TakeoverFailure, afterTerm: boolean): Promise<CcTakeoverConfirmResult> {
    const { takeovers, gateway, log } = this.deps;
    const id = row.id;
    const text = takeoverFailureText(code, afterTerm);
    const message: OutgoingMessage = { text, components: [] };
    try {
      const before = takeovers.get(id);
      takeovers.fail(id, code);
      log(`Claude Code: 取り込めませんでした（#${id}、${code}、step=${before?.step ?? "-"}、guild=${row.guildId}）`);
      this.replayHeld(row);
      await this.editConfirm(id, message);
    } catch (error) {
      log(`Claude Code: 取り込めなかった後の処理で例外が起きました（#${id}、${code}、${errorKind(error)}）`);
      // 確認の文の書き換えだけは試す（DB を読まずに confirm の時の行で）
      if (row.confirmMessageId !== null) {
        await gateway.editMessage(row.channelId, row.confirmMessageId, message).catch((editError: unknown) => {
          log(`Claude Code: 取り込みの確認の文を書き換えられませんでした（#${id}、${errorKind(editError)}）`);
        });
      }
    }
    return { ok: false, reason: code, text };
  }

  /**
   * 差し止めた ended を流し直す（§3.2）: 行が ended_held なら replayEnded → 流せたときだけ releaseHeld（failed の行で 1 → 0）。
   * 届け先がまだ無ければ印を残す（次の recover で流す）。流している途中で投げたら二重に出さないよう印を外す。await を挟まない
   */
  private replayHeld(row: Pick<CcTakeoverRow, "id" | "sessionId">): void {
    const { takeovers, ccSessions, replayEnded, log } = this.deps;
    const current = takeovers.get(row.id);
    if (current === undefined || !current.endedHeld) return;
    const session = ccSessions.get(row.sessionId);
    if (session === undefined) {
      takeovers.releaseHeld(row.id);
      log(`Claude Code: 差し止めた終わった知らせのセッションの行がありません（#${row.id}）`);
      return;
    }
    let delivered: boolean;
    try {
      delivered = replayEnded(session);
    } catch (error) {
      takeovers.releaseHeld(row.id);
      log(`Claude Code: 差し止めた終わった知らせを流し直せませんでした（#${row.id}、${errorKind(error)}）`);
      return;
    }
    if (!delivered) {
      log(`Claude Code: 差し止めた終わった知らせを流し直せませんでした（届け先がまだありません。#${row.id}）`);
      return;
    }
    takeovers.releaseHeld(row.id);
    log(`Claude Code: 差し止めた終わった知らせを流し直しました（#${row.id}）`);
  }

  /** 確認の文を書き換える（確認のメッセージがあるときだけ。失敗は log だけ） */
  private async editConfirm(id: number, message: OutgoingMessage): Promise<void> {
    const row = this.deps.takeovers.get(id);
    if (row === undefined || row.confirmMessageId === null) return;
    try {
      await this.deps.gateway.editMessage(row.channelId, row.confirmMessageId, message);
    } catch (error) {
      this.deps.log(`Claude Code: 取り込みの確認の文を書き換えられませんでした（#${id}、${errorKind(error)}）`);
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

  /** 取り込みの行のチャンネルを引き直して条件を見る（行が消えた・別のセッションに付け替わったら channel_changed） */
  private async assessChannel(row: CcTakeoverRow, listFresh: boolean): Promise<Assessed> {
    const channel = this.deps.ccChannels.get(row.channelId);
    if (channel === undefined || channel.state === "deleted" || channel.sessionId !== row.sessionId) return { ok: false, code: "channel_changed" };
    return this.assess(channel, listFresh);
  }

  /**
   * 取り込めるか（§3.2・§3.4）。今の一覧にあれば生きているセッション（ペインを撮る）、無ければ終わったセッション（cc_sessions が gone のときだけ）。
   * cwd の形は projectOf
   */
  private async assess(channel: CcChannelRow, listFresh: boolean): Promise<Assessed> {
    const { registry, ccSessions, ccSends, ccPermissions, sdkSessions } = this.deps;
    const sessionId = channel.sessionId;
    const snapshot = registry.snapshot();
    const view = snapshot.sessions.find((candidate) => candidate.sessionId === sessionId);
    const session = ccSessions.get(sessionId);
    const cwd = view !== undefined ? (view.cwd ?? null) : (session?.cwd ?? channel.cwd);
    const project = this.projectOf(cwd);
    const pane: TakeoverPane | undefined = view !== undefined && listFresh ? await this.paneOf(view, snapshot.sessions) : undefined;
    const code = takeoverRefusal({
      ready: this.deps.ready(),
      listFresh,
      channelState: channel.state === "deleted" ? "open" : channel.state,
      session: view !== undefined ? { source: "alive", view, pane: pane ?? "failed" } : { source: "ended" },
      project,
      queued: ccSends.activeFor(sessionId) !== undefined ? 1 : 0,
      pendingPermission: ccPermissions.pendingFor(sessionId) !== undefined || view?.pendingPermission === true,
      mapped: sdkSessions.hasSessionId(sessionId),
    });
    if (code !== undefined) return { ok: false, code };
    // 一覧に無いのに gone になっていない（registry がまだ見ていない）ものは、終わったと言えない
    if (view === undefined && (session === undefined || session.goneAt === null)) return { ok: false, code: "identity" };
    return { ok: true, source: view !== undefined ? "alive" : "ended", view, cwd: cwd!, project: project!, session };
  }

  /**
   * cwd の形（§3.4）: resumeProject の名前が checkSessionProject を通り、端末の cwd（末尾の / を除く）が verifiedProjectDir と同じ文字列のときだけ名前
   */
  private projectOf(cwd: string | null): string | undefined {
    if (cwd === null) return undefined;
    const name = resumeProject(cwd, this.deps.cfg.workspaceDir);
    if (name === undefined || !this.deps.checkSessionProject(name).ok) return undefined;
    const dir = this.deps.verifiedProjectDir(name);
    return dir !== undefined && cwd.replace(/\/+$/, "") === dir ? name : undefined;
  }

  /** 生きているセッションのペインの状態。tmux の外は not_in_tmux、引けない・撮れないは failed */
  private async paneOf(view: CcSessionView, sessions: readonly CcSessionView[]): Promise<TakeoverPane> {
    try {
      const lookup = await this.deps.panes.lookup(new Set(sessions.map((candidate) => candidate.pid)));
      if (!lookup.ok) return "failed";
      const target = lookup.sendable({ pid: view.pid, tmux: view.tmux });
      if (!target.ok) return "not_in_tmux";
      const probe = await this.deps.probePane(target.pane.paneId);
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

  /** 題名は cc_sessions.name（§3.1。題名の形でなければプロジェクトの名前） */
  private titleOf(session: CcSessionRow | undefined, project: string): string {
    return normalizeTitle(session?.name ?? "") ?? project;
  }

  /** そのチャンネルの Web の会話に 1 行（無ければ書かない。失敗は log だけ） */
  private record(row: Pick<CcTakeoverRow, "guildId" | "channelId">, kind: "notice" | "divider", text: string): void {
    recordHistory(
      this.deps.history,
      { guildId: row.guildId, channelId: row.channelId, kind, source: "system", persona: DEFAULT_PERSONA_ID, text },
      this.deps.log,
    );
  }
}
