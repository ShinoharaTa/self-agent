// Claude Code の返事を Discord に戻す（追いかけ。docs/plan/claude-code-sessions.md §5.4・§7 の 6・11。CC8）。Discord から頼んだ送信（cc_sends の channel_id がある。
// origin tool / start / github）が届いたら（sender.ts の onFinished）、そのセッションを追いかけ（cc_sessions.follow = 1・follow_channel_id = 頼んだチャンネル）にし、
// 以後そのセッションの Stop（registry.ts の onEvent。一覧に居るセッションの事象だけ）の last_assistant_message を、そのチャンネルにチャンネルの持ち主の Bot で出す
// （RC・端末・Web から打ったターンの返事も）。返事は hook から来たデータなので「Claude Code の返事（hook）」と出所を書き、メンションは鳴らさず
// （allowedMentions の parse: []）、URL の埋め込みも出さない。ターンの prompt には入れない（Web の会話には history の notice として出す）。
// 1 通 CC_REPLY_PAGE_CHARS 字で CC_REPLY_MAX_PAGES 通まで（超えた分は「ほか n 字」）、最後の 1 通に [追いかけをやめる]（`cc:unfollow:<cc_replies の id>`）。
// 最初の返事（届けた後の最初の Stop）は確認の投稿への返信、以後は返信先なし。10 秒以内の同じ本文は skipped、1 日 CC_REPLY_DAILY_LIMIT 通を超えたら上限の 1 行を
// 1 回出してその日は出さない。一覧から消えたら（registry.ts の ended。SessionEnd の hook は根拠にしない）「終わりました」を出して follow = 0、最後の Stop から CC_FOLLOW_IDLE_DAYS 日で黙って follow = 0。
// 貼っている途中（delivering）に来た Stop は、その送信が終わるまで（最長 CC_REPLY_HOLD_MS）待ってから扱う（届けた送信の返事として結びつけるため）。
// 本文はプロセスの中だけで使い、DB（cc_replies）には sha256 と長さだけを書く。log は番号と件数だけ（本文・名前・チャンネル ID・sessionId は出さない）
import { createHash } from "node:crypto";
import { formatDate } from "../app/time.ts";
import type { Config } from "../config.ts";
import { escapeDiscordText } from "../discord/escape.ts";
import type { Gateway, OutgoingMessage } from "../discord/gateway.ts";
import type { CcReplyRow, CcReplyStore } from "../store/cc-replies.ts";
import type { CcSendRow, CcSendStore } from "../store/cc-sends.ts";
import type { CcSessionRow, CcSessionStore } from "../store/cc-sessions.ts";
import { recordHistory, type HistoryStore } from "../store/history.ts";
import type { CcHookEvent } from "./hook-server.ts";
import type { CcTimers } from "./registry.ts";

/** 最後の Stop（無ければ追いかけを始めた時刻）からこの日数 Stop が無ければ、黙って追いかけをやめる */
export const CC_FOLLOW_IDLE_DAYS = 3;
/** 1 セッションが 1 日（SELF_AGENT_TZ の日付）に出す返事の数の上限（超えた最初の 1 回だけ上限の 1 行を出す） */
export const CC_REPLY_DAILY_LIMIT = 50;
/** 返事の 1 通の本文の字数（コードポイント） */
export const CC_REPLY_PAGE_CHARS = 1800;
/** 1 つの返事を出す通の数の上限（超えた分は「ほか n 字」） */
export const CC_REPLY_MAX_PAGES = 3;
/** 同じセッション・同じ本文の Stop をこの間に受けたら出さない（同じ Stop の二重） */
export const CC_REPLY_DUPLICATE_MS = 10_000;
/** 届けた送信の返事（最初の Stop）をこの時間待って来なければ timed_out */
export const CC_REPLY_WAIT_MS = 24 * 60 * 60_000;
/** 失効・終了・無活動・出せなかった返事のやり直しを確かめる間隔 */
export const CC_REPLY_SWEEP_MS = 60_000;
/** 貼っている途中（delivering）に来た Stop を、送信が終わるまで待つ上限 */
export const CC_REPLY_HOLD_MS = 30_000;
/** 名前の表示の長さ（コードポイント） */
const NAME_MAX = 30;
/** Discord の 1 メッセージの上限 */
const MESSAGE_MAX = 2000;

/** [追いかけをやめる] で書き換えるときに足す一言 */
export const CC_UNFOLLOW_NOTE = "（追いかけをやめました）";
/** [追いかけをやめる] のラベル */
export const CC_UNFOLLOW_LABEL = "追いかけをやめる";

function chars(text: string): string[] {
  return [...text];
}

/** 1 行にして max 字で切り、Markdown・メンションを無効にする（名前は hook・一覧から来たデータ） */
function inline(text: string, max: number): string {
  const flat = chars(text.replace(/\s+/g, " ").trim());
  const cut = flat.length <= max ? flat.join("") : `${flat.slice(0, max - 1).join("")}…`;
  return escapeDiscordText(cut);
}

/** 返事の本文の sha256（hex）と長さ（コードポイント）。本文が無ければ空文字列のもの */
export function replyDigest(text: string | undefined): { hash: string; length: number } {
  const body = text ?? "";
  return { hash: createHash("sha256").update(body).digest("hex"), length: chars(body).length };
}

/** コードブロックの開き・閉じの行（行頭の空白 3 つまで + ``` 以上） */
const FENCE = /^ {0,3}(`{3,}|~{3,})/;

/** text の終わりで開いたままのコードブロックの開きの行（無ければ null）。open は text の前から開いているもの */
function openFenceAfter(text: string, open: string | null): string | null {
  let current = open;
  for (const line of text.split("\n")) {
    if (!FENCE.test(line)) continue;
    current = current === null ? line.trim() : null;
  }
  return current;
}

/**
 * 返事の本文を通に分ける（純関数。§5.4）。1 通 CC_REPLY_PAGE_CHARS 字（コードポイント）ずつ CC_REPLY_MAX_PAGES 通まで、残りの字数を rest に。
 * コードブロックが通の途中で切れたら、その通の終わりで閉じて次の通の始めで同じ開きの行から開き直す（足した行は字数に数えない）
 */
export function splitReplyBody(text: string): { pages: string[]; rest: number } {
  const all = chars(text);
  const raw: string[] = [];
  for (let i = 0; i < all.length && raw.length < CC_REPLY_MAX_PAGES; i += CC_REPLY_PAGE_CHARS) {
    raw.push(all.slice(i, i + CC_REPLY_PAGE_CHARS).join(""));
  }
  const rest = Math.max(0, all.length - CC_REPLY_MAX_PAGES * CC_REPLY_PAGE_CHARS);
  const pages: string[] = [];
  let open: string | null = null;
  for (const page of raw) {
    const reopened = open === null ? page : `${open}\n${page}`;
    open = openFenceAfter(page, open);
    pages.push(open === null ? reopened : `${reopened}${reopened.endsWith("\n") ? "" : "\n"}\`\`\``);
  }
  return { pages, rest };
}

/** 返事の投稿の出所の表示（名前を 1 行にして切り、Markdown・メンションを無効にしたもの。無ければ「名前なし」） */
export function replyLabel(name: string | null): string {
  return name === null || name.trim() === "" ? "名前なし" : inline(name, NAME_MAX);
}

/** [追いかけをやめる] のボタン */
export function ccUnfollowButtons(replyId: number): OutgoingMessage["components"] {
  return [{ kind: "buttons", buttons: [{ customId: `cc:unfollow:${replyId}`, label: CC_UNFOLLOW_LABEL }] }];
}

/** 「RC で読む <リンク>」（リンクが無ければ「RC で読んでください」） */
function rcRead(rcUrl: string | undefined): string {
  return rcUrl === undefined ? "RC で読んでください" : `RC で読む <${rcUrl}>`;
}

/**
 * 返事の各通の本文（純関数）。1 通目は「Claude Code（<名前>）の返事（hook）:」、2 通目からは「…の返事の続き（i/n）:」の見出し + 本文。
 * 収まらなかった分は最後の通に「（ほか n 字。RC で読む <リンク>）」。本文が無ければ「終わりました（返事を読めませんでした）」の 1 通
 */
export function replyTexts(label: string, body: string | undefined, rcUrl: string | undefined): string[] {
  if (body === undefined) return [`Claude Code（${label}）が終わりました（返事を読めませんでした）`];
  const { pages, rest } = splitReplyBody(body);
  const total = pages.length;
  return pages.map((page, i) => {
    const head =
      i === 0
        ? `Claude Code（${label}）の返事（hook）${total > 1 ? `（1/${total}）` : ""}:`
        : `Claude Code（${label}）の返事の続き（${i + 1}/${total}）:`;
    const tail = i === total - 1 && rest > 0 ? `\n（ほか ${rest.toLocaleString("en-US")} 字。${rcRead(rcUrl)}）` : "";
    return `${head}\n${page}${tail}`;
  });
}

/** 1 日の上限に達したときの 1 行 */
export function replyLimitText(label: string, rcUrl: string | undefined): string {
  return `Claude Code（${label}）: 今日はここまで（上限 ${CC_REPLY_DAILY_LIMIT}）。${rcRead(rcUrl)}`;
}

/** セッションが終わったときの 1 行 */
export function replyEndedText(label: string): string {
  return `Claude Code（${label}）のセッションが終わりました。追いかけをやめます`;
}

/** [追いかけをやめる] を押したメッセージの書き換え（元の本文を残して一言を足す。2,000 字に収まらなければ元の本文を切る） */
export function unfollowedText(original: string | undefined): string {
  if (original === undefined || original === "") return CC_UNFOLLOW_NOTE;
  const room = MESSAGE_MAX - chars(CC_UNFOLLOW_NOTE).length - 1;
  const body = chars(original);
  const kept = body.length <= room ? original : `${body.slice(0, room - 1).join("")}…`;
  return `${kept}\n${CC_UNFOLLOW_NOTE}`;
}

/** [追いかけをやめる] の結果（stopped = やめた、stale = 古い（行が無い・追いかけ中でない・前の追いかけのボタン）） */
export type CcUnfollowResult = "stopped" | "stale";

/**
 * [追いかけをやめる]（`cc:unfollow:<reply id>`）。その返事の行があり、そのセッションが追いかけ中で、返事がいまの追いかけの間に受けたものなら follow = 0。
 * SELF_AGENT_CC の有効・無効によらず DB だけで動く
 */
export function unfollowByReply(
  deps: { replies: Pick<CcReplyStore, "get">; sessions: Pick<CcSessionStore, "get" | "stopFollow"> },
  replyId: number,
): CcUnfollowResult {
  const reply = deps.replies.get(replyId);
  if (reply === undefined) return "stale";
  const session = deps.sessions.get(reply.sessionId);
  if (session === undefined || !session.follow || session.followSince === null) return "stale";
  if (Date.parse(reply.receivedAt) < Date.parse(session.followSince)) return "stale";
  return deps.sessions.stopFollow(reply.sessionId) ? "stopped" : "stale";
}

export type CcReplierDeps = {
  cfg: Pick<Config, "timeZone">;
  sessions: Pick<CcSessionStore, "get" | "startFollow" | "stopFollow" | "noteStop" | "countReply" | "listFollowing">;
  sends: Pick<CcSendStore, "activeFor" | "takeReplyWaiting" | "timeOutReplies">;
  replies: Pick<CcReplyStore, "add" | "findRecentSame" | "finish">;
  /** 返事の投稿（チャンネルの持ち主の Bot。ownerPosts） */
  posts: Pick<Gateway, "sendMessage">;
  /** RC のリンク（registry の bridgeSessionId から。分からなければ undefined） */
  rcUrl?: (sessionId: string) => string | undefined;
  /** Web UI の会話の記録（Web UI が有効なときだけ）。チャンネルのサーバーと持ち主の人格が分かるときだけ notice を書く */
  history?: Pick<HistoryStore, "add">;
  guildOf?: (channelId: string) => string | undefined;
  personaOf?: (channelId: string) => string;
  now: () => Date;
  timers?: CcTimers;
  log: (message: string) => void;
};

const REAL_TIMERS: CcTimers = {
  after: (fn, ms) => {
    const timer = setTimeout(fn, ms);
    return () => clearTimeout(timer);
  },
};

function errorKind(error: unknown): string {
  return error instanceof Error ? error.name : typeof error;
}

/** 出せなかった返事の残り（次の tick に 1 回だけやり直す。プロセスの中だけ） */
type Retry = { replyId: number; channelId: string; messages: OutgoingMessage[]; total: number; markPosted: boolean };

export class CcReplier {
  private readonly deps: CcReplierDeps;
  private readonly timers: CcTimers;
  private cancelTimer: (() => void) | undefined;
  private started = false;
  private stopped = false;
  private sweeping: Promise<void> | undefined;
  /** セッションごとの投稿の列（同じセッションの返事を受けた順に出す） */
  private readonly chains = new Map<string, Promise<void>>();
  /** 貼っている途中に来た Stop（送信が終わるのを待っている。セッションごとに 1 つ） */
  private readonly held = new Map<string, CcHookEvent>();
  private retries: Retry[] = [];

  constructor(deps: CcReplierDeps) {
    this.deps = deps;
    this.timers = deps.timers ?? REAL_TIMERS;
  }

  /** 直後に 1 回確かめ、以後は CC_REPLY_SWEEP_MS ごと。stop の後・2 回目は何もしない */
  start(): void {
    if (this.started || this.stopped) return;
    this.started = true;
    this.loop();
  }

  /** 以後は受けない・確かめない（投稿の途中のものは idle で待つ） */
  stop(): void {
    this.stopped = true;
    this.cancelTimer?.();
    this.cancelTimer = undefined;
    this.held.clear();
  }

  async idle(): Promise<void> {
    await this.sweeping;
    await Promise.all([...this.chains.values()]);
  }

  /**
   * 採った hook の事象（registry.ts の onEvent）。Stop は返事。SessionEnd は追いかけの終わりの根拠にしない（偽の hook で止められず、
   * 一覧から消えたこと（ended）と二重にならないように。CC5c の終了の知らせと同じ）
   */
  onEvent(event: CcHookEvent): void {
    if (this.stopped) return;
    if (event.event === "Stop") this.onStop(event);
  }

  /**
   * セッションが一覧から消えた（registry.ts の ended。gone_at を入れる前の行）。追いかけ中なら「終わりました」を出して follow = 0 にし、true を返す
   * （そのときは #system の終了の知らせを出さない）。追いかけていなければ false
   */
  ended(row: CcSessionRow): boolean {
    if (this.stopped) return false;
    return this.end(row.sessionId);
  }

  /** 送信が貼っている途中から終わった（sender.ts の onFinished）。Discord から頼んだ送信が届いたら追いかけを始め、待たせていた Stop を扱う */
  onSendFinished(row: CcSendRow): void {
    if (this.stopped) return;
    const { sessions, log } = this.deps;
    if (row.state === "delivered" && row.sessionId !== null && row.channelId !== null) {
      const before = sessions.get(row.sessionId);
      if (sessions.startFollow(row.sessionId, row.channelId)) {
        if (before?.follow !== true) log(`Claude Code: 返事を追いかけます（#${row.id}）`);
        else if (before.followChannelId !== row.channelId) log(`Claude Code: 返事を出すチャンネルを移しました（#${row.id}）`);
      }
    }
    if (row.sessionId === null) return;
    const held = this.held.get(row.sessionId);
    if (held === undefined) return;
    this.held.delete(row.sessionId);
    this.enqueue(held);
  }

  /** 1 回確かめる（テストから直接呼ぶ）。reject しない */
  sweep(): Promise<void> {
    if (this.sweeping !== undefined) return this.sweeping;
    const running = this.pass().finally(() => {
      this.sweeping = undefined;
    });
    this.sweeping = running;
    return running;
  }

  private loop(): void {
    if (this.stopped) return;
    void this.sweep().then(() => {
      if (this.stopped) return;
      this.cancelTimer = this.timers.after(() => {
        this.cancelTimer = undefined;
        this.loop();
      }, CC_REPLY_SWEEP_MS);
    });
  }

  private onStop(event: CcHookEvent): void {
    const { sessions, sends } = this.deps;
    sessions.noteStop(event.sessionId, event.receivedAt);
    // 貼っている途中なら、その送信の返事として結びつけるため、送信が終わるまで待つ（idle を確かめてから貼るので、その間の Stop は貼ったものの返事）
    if (sends.activeFor(event.sessionId)?.state === "delivering") {
      const before = this.held.get(event.sessionId);
      if (before !== undefined) this.enqueue(before);
      this.held.set(event.sessionId, event);
      return;
    }
    this.enqueue(event);
  }

  /** セッションごとの列に入れて扱う */
  private enqueue(event: CcHookEvent): void {
    const previous = this.chains.get(event.sessionId) ?? Promise.resolve();
    const next = previous
      .then(() => this.handle(event))
      .catch((error: unknown) => {
        this.deps.log(`Claude Code: 返事を戻せませんでした（${errorKind(error)}）`);
      });
    this.chains.set(event.sessionId, next);
    void next.finally(() => {
      if (this.chains.get(event.sessionId) === next) this.chains.delete(event.sessionId);
    });
  }

  /** 名前（無ければディレクトリの最後の名前） */
  private label(row: CcSessionRow): string {
    const dir = row.cwd?.replace(/\/+$/, "").split("/").pop();
    return replyLabel(row.name ?? (dir === undefined || dir === "" ? null : dir));
  }

  /** Web UI の会話に notice を 1 行（チャンネルのサーバーが分かるときだけ） */
  private record(channelId: string, text: string): void {
    const { history, guildOf, personaOf, log } = this.deps;
    if (history === undefined || guildOf === undefined) return;
    const guildId = guildOf(channelId);
    if (guildId === undefined) return;
    recordHistory(
      history,
      { guildId, channelId, kind: "notice", source: "system", ...(personaOf === undefined ? {} : { persona: personaOf(channelId) }), text },
      log,
    );
  }

  private async handle(event: CcHookEvent): Promise<void> {
    const { sessions, sends, replies, now, log } = this.deps;
    const message = event.lastAssistantMessage;
    // 届けた送信の返事の印（追いかけ中かによらない）
    const send = sends.takeReplyWaiting(event.sessionId, message === undefined ? "unreadable" : "posted");
    const row = sessions.get(event.sessionId);
    if (row === undefined || !row.follow || row.followChannelId === null) return;
    const channelId = row.followChannelId;
    const digest = replyDigest(message);
    const base = { sessionId: event.sessionId, receivedAt: event.receivedAt, textHash: digest.hash, textLength: digest.length, sendId: send?.id ?? null, channelId };
    // 同じ Stop が二重に来た（10 秒以内の同じ本文）なら出さない
    if (replies.findRecentSame(event.sessionId, digest.hash, new Date(event.receivedAt.getTime() - CC_REPLY_DUPLICATE_MS)) !== undefined) {
      const skipped = replies.add({ ...base, state: "skipped" });
      log(`Claude Code: 同じ返事を続けて受けたため出しません（返事 #${skipped.id}）`);
      return;
    }
    const count = sessions.countReply(event.sessionId, formatDate(now(), this.deps.cfg.timeZone)) ?? 0;
    const label = this.label(row);
    const rcUrl = this.deps.rcUrl?.(event.sessionId);
    if (count > CC_REPLY_DAILY_LIMIT) {
      const skipped = replies.add({ ...base, state: "skipped" });
      // 上限を超えた最初の 1 回だけ、上限の 1 行を出す（その日は以後出さない）
      if (count === CC_REPLY_DAILY_LIMIT + 1) {
        log(`Claude Code: 返事の 1 日の上限に達しました（返事 #${skipped.id}）`);
        const text = replyLimitText(label, rcUrl);
        await this.post(skipped, channelId, [{ text, components: ccUnfollowButtons(skipped.id), suppressEmbeds: true }], false);
        this.record(channelId, text);
      }
      return;
    }
    const reply = replies.add({ ...base, state: "posted" });
    const texts = replyTexts(label, message, rcUrl);
    // 届けた後の最初の返事は、その送信の確認の投稿への返信にする（同じチャンネルのときだけ）
    const replyToId = send !== undefined && send.channelId === channelId && send.messageId !== null ? send.messageId : undefined;
    const messages: OutgoingMessage[] = texts.map((text, i) => ({
      text,
      suppressEmbeds: true,
      ...(i === 0 && replyToId !== undefined ? { replyToId } : {}),
      ...(i === texts.length - 1 ? { components: ccUnfollowButtons(reply.id) } : {}),
    }));
    if (await this.post(reply, channelId, messages, true)) {
      log(`Claude Code: 返事を戻しました（${send === undefined ? "" : `#${send.id}、`}返事 #${reply.id}、${messages.length} 通）`);
    }
    this.record(channelId, message === undefined ? texts[0]! : `Claude Code（${label}）の返事（hook）:\n${message}`);
  }

  /**
   * messages を順に出し、最後の 1 通の ID を cc_replies に書く。markPosted なら状態も posted に（上限の 1 行は skipped のまま）。
   * 途中で失敗したら（markPosted なら failed にして）出せなかった通から先を次の tick に 1 回だけやり直す。全部出せたら true
   */
  private async post(reply: CcReplyRow, channelId: string, messages: OutgoingMessage[], markPosted: boolean): Promise<boolean> {
    const { posts, replies, log } = this.deps;
    let last: string | undefined;
    for (const [i, message] of messages.entries()) {
      try {
        last = await posts.sendMessage(channelId, message);
      } catch (error) {
        if (markPosted) replies.finish(reply.id, "failed");
        log(`Claude Code: 返事を出せませんでした（返事 #${reply.id}、${errorKind(error)}）`);
        // 出せなかった通から先をやり直す（前の通は出ているので、返信先は最初の通のときだけ残す）
        const rest = messages.slice(i).map((page, j) => {
          if (i === 0 && j === 0) return page;
          const { replyToId: _replyToId, ...others } = page;
          return others;
        });
        this.retries.push({ replyId: reply.id, channelId, messages: rest, total: messages.length, markPosted });
        return false;
      }
    }
    if (last !== undefined) replies.finish(reply.id, markPosted ? "posted" : "skipped", last);
    return true;
  }

  /** 追いかけをやめて「終わりました」を出す（一覧から消えた）。追いかけ中でなければ何もせず false */
  private end(sessionId: string): boolean {
    const { sessions, posts, log } = this.deps;
    const row = sessions.get(sessionId);
    if (row === undefined || !row.follow || row.followChannelId === null) return false;
    if (!sessions.stopFollow(sessionId)) return false;
    const channelId = row.followChannelId;
    const text = replyEndedText(this.label(row));
    log("Claude Code: セッションが終わったため追いかけをやめました");
    const previous = this.chains.get(sessionId) ?? Promise.resolve();
    const next = previous
      .then(async () => {
        await posts.sendMessage(channelId, { text });
        this.record(channelId, text);
      })
      .catch((error: unknown) => log(`Claude Code: 終わりの知らせを出せませんでした（${errorKind(error)}）`));
    this.chains.set(sessionId, next);
    void next.finally(() => {
      if (this.chains.get(sessionId) === next) this.chains.delete(sessionId);
    });
    return true;
  }

  private async pass(): Promise<void> {
    const { sessions, sends, replies, posts, now, log } = this.deps;
    try {
      const at = now().getTime();
      // 出せなかった返事の残りを 1 回だけやり直す
      const retries = this.retries;
      this.retries = [];
      for (const retry of retries) {
        if (this.stopped) return;
        let last: string | undefined;
        try {
          for (const message of retry.messages) last = await posts.sendMessage(retry.channelId, message);
          if (last !== undefined) replies.finish(retry.replyId, retry.markPosted ? "posted" : "skipped", last);
          log(`Claude Code: 返事を戻しました（返事 #${retry.replyId}、やり直し、${retry.total} 通）`);
        } catch (error) {
          log(`Claude Code: 返事をやり直しても出せませんでした（返事 #${retry.replyId}、${errorKind(error)}）`);
        }
      }
      // 送信が終わらないまま待たせている Stop は、待ちの上限で扱う
      for (const [sessionId, event] of [...this.held.entries()]) {
        if (at - event.receivedAt.getTime() < CC_REPLY_HOLD_MS) continue;
        this.held.delete(sessionId);
        this.enqueue(event);
      }
      const timedOut = sends.timeOutReplies(new Date(at - CC_REPLY_WAIT_MS));
      if (timedOut.length > 0) log(`Claude Code: 返事の来なかった送信 ${timedOut.length} 件を時間切れにしました`);
      for (const row of sessions.listFollowing()) {
        if (row.goneAt !== null) {
          this.end(row.sessionId);
          continue;
        }
        const last = Math.max(Date.parse(row.followSince ?? "") || 0, Date.parse(row.followLastStopAt ?? "") || 0);
        if (at - last >= CC_FOLLOW_IDLE_DAYS * 24 * 60 * 60_000 && sessions.stopFollow(row.sessionId)) {
          log(`Claude Code: ${CC_FOLLOW_IDLE_DAYS} 日返事が無いため追いかけをやめました`);
        }
      }
    } catch (error) {
      log(`Claude Code: 返事の追いかけを確かめられませんでした（${errorKind(error)}）`);
    }
  }
}
