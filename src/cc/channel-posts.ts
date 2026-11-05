// Claude Code のチャンネルへの許可の要求・判断待ち・端末の指示の写し（docs/plan/claude-code-channels.md §3.5。CC12）。
// SELF_AGENT_CC=1 で連携が動くときは SELF_AGENT_CC_NOTIFY によらず main が作る（チャンネルはオーナーが関わって作ったもので、全部がその目的）。
// - 許可の要求: permission-hold.ts の listen に discord-notice.ts より先に渡し、そのセッションに開いているチャンネル（cc_channels の open の行）が
//   あれば引き受けて（claims）、#system の代わりにそのチャンネルへ CC5c と同じ 1 通（オーナーだけをメンション・[許可][このセッションでは常に許可][拒否]・
//   [RC で開く]）を出し、cc_permissions.message_channel_id に残す。終わったら（Web で押された・他で答えられた・時間切れ・停止・再起動の前に残った）
//   その 1 通を書き換えてボタンを外す。Discord で押されたものは app/commands/cc.ts が応答で書き換える。チャンネルの無いセッションは #system のまま。
//   チャンネルに出せなかったら（投稿の失敗・チャンネルが見つからない）引き受けを戻し（permission-hold.ts の release）、#system に落とす。
// - 判断待ち: discord-notice.ts と同じ条件（許可の要求以外が 60 秒）で、チャンネルのあるセッションだけをそのチャンネルに出す。1 時間の上限は
//   discord-notice.ts と CcWaitBudget を共有して 1 つで数え、超えた分は出さずに、そのチャンネルに 1 時間に 1 回だけ短い 1 行（メンションなし）を出す。
// - 端末・RC から打った指示の写し: UserPromptSubmit のうち self-agent が届けたものでないものを「（端末か RC から）」+ 本文の先頭
//   CC_PROMPT_MIRROR_MAX_CHARS 字で出す（超えた分は「（ほか n 字）」）。self-agent が届けたもの = そのセッションの貼っている途中か直近
//   CC_PROMPT_MIRROR_WINDOW_MS に届けた送信で、貼ったときの形（singleLine の後）と prompt の両方の空白を 1 つにして先頭 200 字が同じもの。
//   写しだけではチャンネルを作らず、写した投稿を返事の返信先にもしない。
// Web の会話（CC14。§5.2。history を渡したときだけ）: 許可の要求とその結果・判断待ちを notice、端末・RC からの指示の写しを owner（source system・
// 「（端末か RC から）」+ 本文）で書く（guild_id は cc_channels の行、persona は既定。本文は Discord のエスケープをしない文字のまま）。
// 終了の 1 行は cc/channels.ts の ended（ccEndedHandler）が出す。投稿は既定の人格の Bot。本文・名前・ディレクトリ・要約は hook から来たデータなので、
// Markdown とメンションを無効にし（allowedMentions の parse: [] は Gateway の既定）、埋め込みを出さない。
// log は id と種類だけ（チャンネル ID・名前・cwd・本文・セッションの ID は出さない）
import { DEFAULT_PERSONA_ID, type Config } from "../config.ts";
import { escapeDiscordText } from "../discord/escape.ts";
import type { Gateway, OutgoingMessage } from "../discord/gateway.ts";
import type { CcChannelStore } from "../store/cc-channels.ts";
import type { CcPermissionRow, CcPermissionStore } from "../store/cc-permissions.ts";
import type { CcSendStore } from "../store/cc-sends.ts";
import { recordHistory, type HistoryStore } from "../store/history.ts";
import { CC_PROMPT_MAX_CHARS, type CcSessionStore, headChars } from "../store/cc-sessions.ts";
import {
  CC_WAIT_CHECK_MS,
  CC_WAIT_NOTIFY_LIMIT,
  CC_WAIT_NOTIFY_WINDOW_MS,
  type CcNoticeSession,
  type CcWaitBudget,
  dueWaitingViews,
  noticeSessionOf,
  permissionNotice,
  permissionResolvedMessage,
  permissionResultLine,
  waitingNotice,
} from "./discord-notice.ts";
import { CC_PROMPT_MIRROR_MAX_CHARS, type CcHookEvent } from "./hook-server.ts";
import type { CcPermissionListener } from "./permission-hold.ts";
import type { CcRegistry, CcTimers } from "./registry.ts";
import { singleLine } from "./sender.ts";

/** self-agent が届けたものとみなす窓（届けてからこの間の UserPromptSubmit は、本文が同じなら写さない） */
export const CC_PROMPT_MIRROR_WINDOW_MS = 30_000;
/** 端末・RC からの指示の写しの見出し */
export const CC_PROMPT_MIRROR_LABEL = "（端末か RC から）";
/** Discord の 1 メッセージの上限 */
const MESSAGE_MAX = 2000;
/** 判断待ちの知らせが上限に達したときの 1 行（メンションなし。チャンネルごとに CC_WAIT_NOTIFY_WINDOW_MS に 1 回） */
export const CC_CHANNEL_WAIT_OVERFLOW_TEXT = `判断待ちの知らせが上限（1 時間に ${CC_WAIT_NOTIFY_LIMIT} 件）に達したので、しばらく出しません（Web で確かめてください）`;

/** 比べるための形（空白（改行を含む）の連なりを 1 つの空白にして前後を除き、先頭 CC_PROMPT_MAX_CHARS 字） */
export function promptKey(text: string): string {
  return headChars(text.replace(/\s+/g, " ").trim(), CC_PROMPT_MAX_CHARS);
}

/**
 * 端末・RC からの指示の写しの各通（純関数）。1 通目は見出し + 改行 + 本文。本文は改行以外の制御文字を空白にして 1 字ずつ Markdown とメンションを
 * 無効にし、1 通 MESSAGE_MAX 字に収まるよう字の境目で分ける。total（全体の字数）が本文より長ければ末尾に「（ほか n 字）」
 */
export function ccPromptMirrorTexts(prompt: string, total: number): string[] {
  const shown = [...headChars(prompt, CC_PROMPT_MIRROR_MAX_CHARS)];
  const rest = Math.max(0, total - shown.length);
  const texts: string[] = [];
  let current = `${CC_PROMPT_MIRROR_LABEL}\n`;
  /** current の字数（コードポイント） */
  let length = [...current].length;
  for (const char of shown) {
    // 1 字のエスケープは 1〜2 字
    const piece = escapeDiscordText(char === "\n" ? char : char.replace(/[\u0000-\u001f\u007f]/, " "));
    const pieceLength = piece.length === char.length ? 1 : 2;
    if (length + pieceLength > MESSAGE_MAX) {
      texts.push(current);
      current = "";
      length = 0;
    }
    current += piece;
    length += pieceLength;
  }
  if (rest > 0) {
    const note = `（ほか ${rest} 字）`;
    if (length + 1 + [...note].length > MESSAGE_MAX) {
      texts.push(current);
      current = note;
    } else {
      current += `\n${note}`;
    }
  }
  texts.push(current);
  return texts;
}

export type CcChannelPostsDeps = {
  cfg: Pick<Config, "ownerUserId" | "workspaceDir" | "ccPermissionHoldSec">;
  /** 開いているチャンネル（cc_channels） */
  channels: Pick<CcChannelStore, "openFor" | "get">;
  /** 投稿・書き換え（既定の人格の Bot） */
  gateway: Pick<Gateway, "sendMessage" | "editMessage">;
  permissions: Pick<CcPermissionStore, "get" | "setMessage" | "sessionsAnsweredSince">;
  sessions: Pick<CcSessionStore, "get" | "setNotifiedAt">;
  /** 写しで self-agent が届けたものを見分ける */
  sends: Pick<CcSendStore, "listRecentDelivered">;
  registry: Pick<CcRegistry, "snapshot">;
  /** 判断待ちの知らせの 1 時間の上限（discord-notice.ts と共有する） */
  waitBudget: CcWaitBudget;
  /** チャンネルに出せなかった許可の要求の引き受けを戻す（permission-hold.ts の release。次の受け手の #system に落とす）。main で後から渡す */
  release?: (id: number) => void;
  /** ~ の場所（ディレクトリの表示） */
  home: string;
  /** Web UI の会話の記録（CC14。Web UI が有効なときだけ。無ければ書かない） */
  history?: Pick<HistoryStore, "add">;
  now: () => Date;
  timers?: CcTimers;
  log: (message: string) => void;
};

/** 許可の要求の Web の会話の 1 行（純関数。文字のまま） */
export function permissionHistoryText(row: Pick<CcPermissionRow, "toolName" | "summary">): string {
  return `許可を待っています: ${row.toolName}\n${row.summary}`;
}

/** 終わった許可の要求の Web の会話の 1 行（純関数）。pending なら undefined */
export function permissionResultHistoryText(row: Pick<CcPermissionRow, "toolName" | "state" | "via" | "alwaysRules">): string | undefined {
  const line = permissionResultLine(row, undefined);
  return line === undefined ? undefined : `許可の要求（${row.toolName}）: ${line}`;
}

const REAL_TIMERS: CcTimers = {
  after: (fn, ms) => {
    const timer = setTimeout(fn, ms);
    return () => clearTimeout(timer);
  },
};

function errorKind(error: unknown): string {
  return error instanceof Error ? error.name : typeof error;
}

export class CcChannelPosts implements CcPermissionListener {
  private readonly deps: CcChannelPostsDeps;
  private readonly timers: CcTimers;
  private cancelTimer: (() => void) | undefined;
  private started = false;
  private stopped = false;
  private readonly inFlight = new Set<Promise<void>>();
  /** チャンネル → 判断待ちの上限の 1 行を最後に出した時刻（プロセスの中） */
  private readonly overflowNoticedAt = new Map<string, number>();

  constructor(deps: CcChannelPostsDeps) {
    this.deps = deps;
    this.timers = deps.timers ?? REAL_TIMERS;
  }

  /** 判断待ちを CC_WAIT_CHECK_MS ごとに確かめ始める。stop の後・2 回目は何もしない */
  start(): void {
    if (this.started || this.stopped) return;
    this.started = true;
    this.schedule();
  }

  /** 以後は新しく投稿しない（許可の要求・判断待ち・写し）。終わった許可の要求の書き換え（停止の released を含む）は続ける */
  stop(): void {
    this.stopped = true;
    this.cancelTimer?.();
    this.cancelTimer = undefined;
  }

  /** 投稿・書き換えの途中のものを待つ */
  async idle(): Promise<void> {
    while (this.inFlight.size > 0) await Promise.all([...this.inFlight]);
  }

  /** 保留を始めた許可の要求を引き受けるか（そのセッションに開いているチャンネルがあれば） */
  claims(row: CcPermissionRow): boolean {
    return !this.stopped && this.deps.channels.openFor(row.sessionId) !== undefined;
  }

  /** 引き受けた許可の要求: そのチャンネルに 1 通 */
  held(row: CcPermissionRow): void {
    if (this.stopped) return;
    this.track(this.postPermission(row));
  }

  /** 終わった許可の要求: 1 通を書き換えてボタンを外す。Discord で押したものは応答で書き換える。投稿の途中なら投稿の後に書き換える */
  resolved(row: CcPermissionRow): void {
    // 結果を Web の会話に（チャンネルに出した要求だけ。投稿の前に終わったものは postPermission が書く）
    if (row.messageChannelId !== null) this.recordResult(row);
    if (row.via === "discord" || row.messageId === null || row.messageChannelId === null) return;
    this.track(this.editResolved(row));
  }

  /**
   * Discord のボタンで終えた要求の書き換え後の 1 通と、それを出した場所（app/commands/cc.ts の応答。#system に出したものも同じ形）。
   * 行が無ければ undefined
   */
  resolvedMessage(id: number): { message: OutgoingMessage; channelId: string | null; messageId: string | null } | undefined {
    const row = this.deps.permissions.get(id);
    if (row === undefined) return undefined;
    return {
      message: permissionResolvedMessage(row, this.sessionOf(row.sessionId), this.places()),
      channelId: row.messageChannelId,
      messageId: row.messageId,
    };
  }

  /** その要求の 1 通を Claude Code のチャンネルに出したか（再起動の前の行の書き換えを振り分ける） */
  owns(row: Pick<CcPermissionRow, "messageChannelId">): boolean {
    return row.messageChannelId !== null && this.deps.channels.get(row.messageChannelId) !== undefined;
  }

  /** 再起動の前に保留していて expired にした行のうち、Claude Code のチャンネルに出した 1 通を「時間切れ」に書き換える。Discord につないだ後に呼ぶ */
  rewriteRecovered(rows: readonly CcPermissionRow[]): void {
    for (const row of rows) if (row.messageId !== null && this.owns(row)) this.track(this.editResolved(row));
  }

  /** 判断待ちを 1 回確かめる（周期のほか、テストから呼ぶ）: チャンネルのあるセッションだけ、そのチャンネルに出す */
  checkWaiting(): void {
    if (this.stopped) return;
    const { channels, sessions, waitBudget, cfg, log } = this.deps;
    const now = this.deps.now().getTime();
    /** セッション → 開いているチャンネル（判定のときに引いたもの） */
    const channelOf = new Map<string, string>();
    const due = dueWaitingViews(this.deps, now, (sessionId) => {
      const channel = channels.openFor(sessionId);
      if (channel !== undefined) channelOf.set(sessionId, channel.channelId);
      return channel !== undefined;
    });
    let skipped = 0;
    for (const view of due) {
      const channelId = channelOf.get(view.sessionId);
      if (channelId === undefined) continue;
      // 出せなくてもやり直さない（待ちごとに 1 回）
      sessions.setNotifiedAt(view.sessionId, new Date(now));
      if (!waitBudget.take(now)) {
        skipped++;
        this.noticeOverflow(channelId, now);
        continue;
      }
      const message = waitingNotice(view, { ...this.places(), ownerUserId: cfg.ownerUserId });
      this.record(channelId, "notice", view.waitingFor === undefined || view.waitingFor === "" ? "判断を待っています" : `判断を待っています: ${view.waitingFor}`);
      this.track(
        this.deps.gateway.sendMessage(channelId, { ...message, suppressEmbeds: true }).then(
          () => {
            log("Claude Code: 判断待ちをチャンネルに知らせました");
          },
          (error: unknown) => {
            log(`Claude Code: 判断待ちをチャンネルに知らせられませんでした（${errorKind(error)}）`);
          },
        ),
      );
    }
    if (skipped > 0) log(`Claude Code: 判断待ちの知らせを上限のためチャンネルに出しませんでした（${skipped} 件）`);
  }

  /**
   * hook の事象（registry の onEvent）: UserPromptSubmit のうち self-agent が届けたものでないものを、そのセッションの開いているチャンネルに写す。
   * チャンネルが無ければ何もしない（写しだけではチャンネルを作らない）
   */
  onEvent(event: CcHookEvent): void {
    if (this.stopped || event.event !== "UserPromptSubmit" || event.prompt === undefined || event.prompt === "") return;
    const channel = this.deps.channels.openFor(event.sessionId);
    if (channel === undefined) return;
    const key = promptKey(event.prompt);
    const since = new Date(event.receivedAt.getTime() - CC_PROMPT_MIRROR_WINDOW_MS);
    if (this.deps.sends.listRecentDelivered(event.sessionId, since).some((send) => promptKey(singleLine(send.text)) === key)) return;
    const texts = ccPromptMirrorTexts(event.prompt, event.promptChars ?? [...event.prompt].length);
    const channelId = channel.channelId;
    const total = event.promptChars ?? [...event.prompt].length;
    const rest = total - [...event.prompt].length;
    this.record(channelId, "owner", `${CC_PROMPT_MIRROR_LABEL}\n${event.prompt}${rest > 0 ? `\n（ほか ${rest} 字）` : ""}`);
    this.track(
      (async () => {
        try {
          for (const text of texts) await this.deps.gateway.sendMessage(channelId, { text, suppressEmbeds: true });
          this.deps.log("Claude Code: 写しを出しました（端末か RC から）");
        } catch (error) {
          this.deps.log(`Claude Code: 端末か RC からの指示を写せませんでした（${errorKind(error)}）`);
        }
      })(),
    );
  }

  /** 判断待ちの上限に達した 1 行（メンションなし。チャンネルごとに CC_WAIT_NOTIFY_WINDOW_MS に 1 回。失敗は log だけ） */
  private noticeOverflow(channelId: string, now: number): void {
    const last = this.overflowNoticedAt.get(channelId);
    if (last !== undefined && now - last < CC_WAIT_NOTIFY_WINDOW_MS) return;
    this.overflowNoticedAt.set(channelId, now);
    this.track(
      this.deps.gateway.sendMessage(channelId, { text: CC_CHANNEL_WAIT_OVERFLOW_TEXT, suppressEmbeds: true }).then(
        () => undefined,
        (error: unknown) => {
          this.deps.log(`Claude Code: 判断待ちの上限の知らせをチャンネルに出せませんでした（${errorKind(error)}）`);
        },
      ),
    );
  }

  private schedule(): void {
    if (this.stopped) return;
    this.cancelTimer = this.timers.after(() => {
      this.cancelTimer = undefined;
      try {
        this.checkWaiting();
      } catch (error) {
        this.deps.log(`Claude Code: 判断待ちの確認に失敗しました（${errorKind(error)}）`);
      }
      this.schedule();
    }, CC_WAIT_CHECK_MS);
  }

  private track(promise: Promise<void>): void {
    const settled = promise.catch((error: unknown) => {
      this.deps.log(`Claude Code: チャンネルへの知らせに失敗しました（${errorKind(error)}）`);
    });
    this.inFlight.add(settled);
    void settled.then(() => this.inFlight.delete(settled));
  }

  private places(): { workspaceDir: string; home: string } {
    return { workspaceDir: this.deps.cfg.workspaceDir, home: this.deps.home };
  }

  private sessionOf(sessionId: string): CcNoticeSession | undefined {
    return noticeSessionOf(this.deps.sessions, this.deps.registry, sessionId);
  }

  private async postPermission(row: CcPermissionRow): Promise<void> {
    const { channels, permissions, cfg, gateway, log } = this.deps;
    const channel = channels.openFor(row.sessionId);
    if (channel === undefined) {
      // 引き受けた後にチャンネルが閉じた: #system に落とす
      log(`Claude Code: 許可の要求（#${row.id}）を出すチャンネルが見つからないため #system に回します`);
      this.deps.release?.(row.id);
      return;
    }
    const message = permissionNotice(row, this.sessionOf(row.sessionId), {
      ...this.places(),
      holdSec: cfg.ccPermissionHoldSec,
      ownerUserId: cfg.ownerUserId,
    });
    let messageId: string;
    try {
      messageId = await gateway.sendMessage(channel.channelId, { ...message, suppressEmbeds: true });
    } catch (error) {
      log(`Claude Code: 許可の要求（#${row.id}）をチャンネルに出せなかったため #system に回します（${errorKind(error)}）`);
      this.deps.release?.(row.id);
      return;
    }
    permissions.setMessage(row.id, channel.channelId, messageId);
    log(`Claude Code: 許可の要求（#${row.id}）をチャンネルに出しました`);
    this.record(channel.channelId, "notice", permissionHistoryText(row));
    // 投稿の間に終わっていれば（Web・他で答えられた・時間切れ）書き換える（resolved は 1 通の場所が分かる前に来たので、結果もここで書く）
    const latest = permissions.get(row.id);
    if (latest !== undefined && latest.state !== "pending") {
      this.recordResult(latest);
      if (latest.via !== "discord") await this.editResolved(latest);
    }
  }

  /** Web の会話に 1 行（削除されていない cc のチャンネルのときだけ。書けなくても log だけ） */
  private record(channelId: string, kind: "owner" | "notice", text: string): void {
    if (this.deps.history === undefined) return;
    const channel = this.deps.channels.get(channelId);
    if (channel === undefined || channel.state === "deleted") return;
    recordHistory(
      this.deps.history,
      { guildId: channel.guildId, channelId, kind, source: "system", persona: DEFAULT_PERSONA_ID, text },
      this.deps.log,
    );
  }

  /** 終わった許可の要求の結果（1 件につき 1 回。プロセスの中） */
  private readonly resultRecorded = new Set<number>();

  private recordResult(row: CcPermissionRow): void {
    if (row.messageChannelId === null || this.resultRecorded.has(row.id)) return;
    const text = permissionResultHistoryText(row);
    if (text === undefined) return;
    this.resultRecorded.add(row.id);
    this.record(row.messageChannelId, "notice", text);
  }

  private async editResolved(row: CcPermissionRow): Promise<void> {
    if (row.messageId === null || row.messageChannelId === null) return;
    const message = permissionResolvedMessage(row, this.sessionOf(row.sessionId), this.places());
    try {
      await this.deps.gateway.editMessage(row.messageChannelId, row.messageId, message);
    } catch (error) {
      this.deps.log(`Claude Code: 許可の要求（#${row.id}）の知らせを書き換えられませんでした（${errorKind(error)}）`);
    }
  }
}
