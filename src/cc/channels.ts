// Claude Code のセッションごとの Discord のチャンネル（docs/plan/claude-code-channels.md §3。CC10 の分）。
// - 作る（openChannel）: /setup・/new と同じ layoutQueueKey のキューで、1 セッション 1 チャンネル（既にあれば exists）・一覧にあって tmux の中
//   （findSendablePane が当たる）・カテゴリ「Claude Code」（guild_settings.cc_category_id）があって 50 未満のときだけ、`cc-<セッション名>` を作り、
//   cc_channels に行を書いて最初の 1 通を投稿する。手動の口（Web のタブの [Discord のチャンネルを作る]・/cc open）が呼ぶ。
//   ensureFor は「関わった」きっかけ（CC11）から呼ぶ口で、既にあれば何もせず、作れなくても投げず、log と #system に 1 行（同じ理由は 1 時間に 1 回）。
// - 終わった（ended。registry が一覧から消えたセッションを渡す）: open の行を ended にして 1 行を出し、完了カテゴリへ移す。
// - 戻った（revived。同じ session_id が一覧に戻った）: その session_id の ended の行を open に戻して 1 行を出し、カテゴリ「Claude Code」へ戻す。
// - 再同期（reconcile。scheduler.ts の tick）: Discord 上に無い行を削除済みに、open でカテゴリ「Claude Code」の外のもの・ended で完了の外のものを戻す。
// - 関わった（CC11。§3.1）: Web・cc_send の [送る]・GitHub の [対応] で積んだ直後（announce）と、起動したセッションを一覧のセッションに結びつけたとき
//   （started）に ensureFor で作り、本文をチャンネルに写して（「（Web から）」など）その投稿を印と返事の返信先にする（作れなければ写さない）。
// - 発言（handleMessage。§3.3）: 許可サーバー・オーナー本人・Bot と Webhook でない・既定の人格の Bot で受けた、open の行のチャンネルの発言を
//   確認なしで cc_sends（origin discord）に積む（sender.submit。同じセッションに CC_CHANNEL_QUEUE_MAX 件まで）。SDK のターンは動かさない（LLM を呼ばない）。
//   resuming の間は断り、ended（CC13 で [起動して続ける]）の発言は黙って捨てる。
// - 印（§3.3）: 届け待ちは ⏳、届けたら ✅、確かめられなければ ⚠️ と返信、送れなければ ❌ と返信、取り消したら ⏳ を外す（リアクション。失敗は log だけ）。
// 投稿・リアクションは既定の人格の Bot。名前・ディレクトリは hook から来たデータなので、Markdown とメンションを無効にする。
// log はサーバー ID と種類・件数・送信の番号だけ（チャンネル ID・名前・cwd・sessionId・本文は出さない。作った後の DB の失敗だけ例外）
import { layoutQueueKey } from "../app/commands/setup.ts";
import type { ChannelOpsQueue } from "../app/channel-ops.ts";
import type { KeyedSerialQueue } from "../app/queue.ts";
import type { SystemNotifier } from "../app/system-notice.ts";
import { DEFAULT_PERSONA_ID, type Config } from "../config.ts";
import { normalizeChannelName, CHANNEL_NAME_MAX_LENGTH } from "../discord/channel-name.ts";
import { escapeDiscordText } from "../discord/escape.ts";
import { type Gateway, type IncomingMessage, NotCategoryError } from "../discord/gateway.ts";
import type { CcChannelOrigin, CcChannelRow, CcChannelStore } from "../store/cc-channels.ts";
import type { CcSendOrigin, CcSendRow, CcSendStore } from "../store/cc-sends.ts";
import { headChars, type CcSessionRow, type CcStartedBy } from "../store/cc-sessions.ts";
import type { GuildSettingsStore } from "../store/guild-settings.ts";
import { cwdLabel } from "./labels.ts";
import type { CcPaneResolver } from "./panes.ts";
import type { CcRegistry, CcSessionView, CcState } from "./registry.ts";
import { CC_CHANNEL_QUEUE_MAX, normalizeSendText, type CcSender, type CcSubmitResult } from "./sender.ts";

/** Discord で 1 つのカテゴリに入れられるチャンネル数（カテゴリ「Claude Code」は 1 つだけで、満杯なら作らずに断る） */
export const CC_CATEGORY_CHANNEL_LIMIT = 50;
/** 作れなかった同じ理由を #system に出す間隔（プロセスの中） */
export const CC_CHANNEL_FAILURE_NOTICE_MS = 60 * 60_000;
/** /cc open のセレクトに出す件数（Discord のセレクトの上限） */
export const CC_PICK_LIMIT = 25;
/** 名前・ディレクトリを出す長さ */
const LABEL_MAX_CHARS = 100;

/** 作れなかった理由。not_found = 一覧に無い、not_in_tmux = tmux の外、not_set_up = カテゴリが無い・消えた、full = 50、failed = Discord の失敗 */
export type CcChannelFailure = "not_found" | "not_in_tmux" | "not_set_up" | "full" | "failed";

export type CcOpenResult =
  | { ok: true; channelId: string; guildId: string }
  | { ok: false; reason: "exists"; channelId: string; guildId: string }
  | { ok: false; reason: CcChannelFailure };

/** きっかけの表示（最初の投稿） */
const ORIGIN_LABEL: Readonly<Record<CcChannelOrigin, string>> = {
  web: "Web の [Discord のチャンネルを作る]",
  command: "/cc open",
  web_send: "Web からの送信",
  web_start: "Web からの起動",
  permission: "許可の応答",
  tool_send: "cc_send の [送る]",
  tool_start: "cc_start の [起動する]",
  github: "#github の [対応]",
};

/** 作れなかった理由の #system の 1 行と log の語 */
const FAILURE_NOTICE: Readonly<Record<"not_set_up" | "full" | "failed", string>> = {
  not_set_up: "Claude Code のチャンネルを作れませんでした（カテゴリ「Claude Code」がありません。/setup を実行してください）",
  full: `Claude Code のチャンネルを作れませんでした（カテゴリ「Claude Code」が満杯（${CC_CATEGORY_CHANNEL_LIMIT}）です。完了したチャンネルを消すか、/setup を確かめてください）`,
  failed: "Claude Code のチャンネルを作れませんでした（Discord の操作に失敗しました。次に関わったときにまた試します）",
};

/** Discord の 1 メッセージの上限 */
const MESSAGE_MAX = 2000;

/** 印（リアクション。§3.3） */
export const CC_MARK_WAITING = "⏳";
export const CC_MARK_DELIVERED = "✅";
export const CC_MARK_UNCONFIRMED = "⚠️";
export const CC_MARK_FAILED = "❌";

/** 印に添える返信 */
export const CC_UNCONFIRMED_REPLY = "届いたかを確かめられませんでした。画面で確かめてください";
export const CC_GAVE_UP_REPLY = "入力待ちにならなかったため、届けるのをやめました";
export const CC_DIALOG_REPLY = "ダイアログが出ているため待っています（端末か RC で答えてください）";

/** チャンネルの発言を断る返信 */
export const CC_ATTACHMENT_REPLY = "画像・ファイルは送れません";
export const CC_RESUMING_REPLY = "起動中です。少し待ってから書いてください";
export const CC_QUEUE_FULL_REPLY = `届け待ちが ${CC_CHANNEL_QUEUE_MAX} 件あります。届いてから送ってください`;
const TEXT_REJECT_REPLY: Readonly<Record<"too_long" | "invalid_text", string>> = {
  too_long: "長すぎます（4,000 字まで）",
  invalid_text: "改行のほかの制御文字は送れません",
};
const SUBMIT_REJECT_REPLY: Readonly<Record<Exclude<CcSubmitResult, { ok: true }>["reason"], string>> = {
  not_found: "このセッションは一覧にありません（終わったかもしれません）",
  already_queued: "届け待ちの送信があります。届いてから送ってください",
  queue_full: CC_QUEUE_FULL_REPLY,
  not_in_tmux: "tmux の外のセッションには送れません",
  not_claude: "送り先のペインが claude ではありません",
  no_server: "tmux のサーバーがありません",
  tmux_failed: "tmux を使えませんでした",
  stopped: "停止中です",
};

/** 送れなかった理由（cc_sends.last_pane_state）の表示 */
const FAILURE_REASON_TEXT: Readonly<Record<string, string>> = {
  gone: "セッションが一覧にありません",
  not_claude: "送り先が claude ではありません",
  not_in_tmux: "tmux の外です",
  cwd_mismatch: "起動したディレクトリと違います",
  invalid_text: "送れない文字があります",
};

/** 送れなかったときの返信（純関数） */
export function ccFailedReply(reason: string | null): string {
  return `送れませんでした（${(reason === null ? undefined : FAILURE_REASON_TEXT[reason]) ?? "送り先に届けられませんでした"}）`;
}

/** 積んだ送信の出所 → 作るときのきっかけ（start は起動したセッションを結びつけたとき（started）に作る。discord はチャンネルの中の発言） */
const SEND_CHANNEL_ORIGIN: Readonly<Partial<Record<CcSendOrigin, CcChannelOrigin>>> = { web: "web_send", tool: "tool_send", github: "github" };
/** 起動したもの → 作るときのきっかけ */
const START_CHANNEL_ORIGIN: Readonly<Record<Exclude<CcStartedBy, "owner">, CcChannelOrigin>> = {
  web: "web_start",
  tool: "tool_start",
  github: "github",
};

/** 写しの見出し（純関数。§3.3）。tool は頼んだチャンネル（requestedChannelId）を `<#…>` で */
export function ccMirrorLabel(origin: CcSendOrigin, requestedChannelId: string | null): string {
  switch (origin) {
    case "web":
      return "（Web から）";
    case "tool":
      return requestedChannelId === null ? "（cc_send から）" : `（<#${requestedChannelId}> から）`;
    case "github":
      return "（#github の [対応]）";
    case "start":
      return "（起動の最初の指示）";
    case "discord":
      return "";
  }
}

/**
 * 写しの各通（純関数）。1 通目は見出し + 改行 + 本文、収まらない分は 2 通目以降に（1 通 MESSAGE_MAX 字。コードポイントで切る）
 */
export function ccMirrorTexts(label: string, text: string): string[] {
  const all = [...text];
  const firstRoom = MESSAGE_MAX - [...label].length - 1;
  const texts = [`${label}\n${all.slice(0, firstRoom).join("")}`];
  for (let pos = firstRoom; pos < all.length; pos += MESSAGE_MAX) texts.push(all.slice(pos, pos + MESSAGE_MAX).join(""));
  return texts;
}

export const CC_CHANNEL_ENDED_TEXT = "セッションが終わりました。";
export const CC_CHANNEL_REVIVED_TEXT = "セッションが戻りました。";

/** 1 行の表示（制御文字を空白にし、Markdown とメンションを無効にする） */
function plain(text: string): string {
  return escapeDiscordText(headChars(text.replace(/[\u0000-\u001f\u007f]/g, " "), LABEL_MAX_CHARS));
}

/** topic の 1 行（制御文字を空白に。topic は Markdown として描かれないので崩さない） */
function topicPart(text: string): string {
  return headChars(text.replace(/[\u0000-\u001f\u007f]/g, " "), LABEL_MAX_CHARS);
}

/** ディレクトリの最後の名前 */
function lastSegment(cwd: string | null): string {
  if (cwd === null) return "";
  const parts = cwd.split("/").filter((part) => part !== "");
  return parts[parts.length - 1] ?? "";
}

/**
 * チャンネル名（純関数。§3.2）: `cc-<normalizeChannelName(セッション名)>`、名前が無ければ `cc-<ディレクトリの最後の名前>`、どちらも空なら `cc-session`。
 * 100 字で切り、taken（そのサーバーの削除されていない cc のチャンネルの名前）にあれば `-2`, `-3` を付ける
 */
export function ccChannelName(name: string | null, cwd: string | null, taken: ReadonlySet<string>): string {
  const raw = normalizeChannelName(name ?? "") || normalizeChannelName(lastSegment(cwd)) || "session";
  const base = normalizeChannelName(`cc-${raw}`);
  if (!taken.has(base)) return base;
  for (let n = 2; ; n++) {
    const suffix = `-${n}`;
    const candidate = `${base.slice(0, CHANNEL_NAME_MAX_LENGTH - suffix.length).replace(/-+$/, "")}${suffix}`;
    if (!taken.has(candidate)) return candidate;
  }
}

/** topic（純関数。§3.2）: `Claude Code: <名前>（<ディレクトリ>）` */
export function ccChannelTopic(name: string | null, dir: string | null): string {
  const label = name === null || name === "" ? (dir ?? "（名前なし）") : name;
  return `Claude Code: ${topicPart(label)}${dir === null || dir === "" ? "" : `（${topicPart(dir)}）`}`;
}

/** 最初の投稿（純関数） */
export function ccChannelIntro(name: string | null, dir: string | null, origin: CcChannelOrigin): string {
  const label = name === null || name === "" ? "（名前なし）" : name;
  return (
    `Claude Code のセッション「${plain(label)}」${dir === null || dir === "" ? "" : `（${plain(dir)}）`}のチャンネルです（${ORIGIN_LABEL[origin]} で作りました）。` +
    "ここに書くとこのセッションに届きます。返事と許可の要求はここに出ます。セッションが終わると完了に移し、戻るとここに戻します"
  );
}

export type CcChannelsDeps = {
  cfg: Pick<Config, "allowedGuildIds" | "workspaceDir" | "ownerUserId">;
  store: CcChannelStore;
  /** 写しを印と返事の返信先にする・/cc cancel の対象 */
  sends: Pick<CcSendStore, "get" | "setMirror" | "listQueuedFor">;
  /** チャンネルの発言を積む・/cc cancel で取り消す（main では後で作るので関数で渡す） */
  sender: () => Pick<CcSender, "submit" | "cancel"> | undefined;
  /** Discord から頼んだ送信・起動の頼んだチャンネルのサーバー（そのサーバーに作る。分からなければ defaultGuild） */
  guildOf?: (channelId: string) => string | undefined;
  guildSettings: Pick<GuildSettingsStore, "get" | "ccCategoryId" | "listStateCategories">;
  registry: Pick<CcRegistry, "snapshot">;
  panes: Pick<CcPaneResolver, "lookup">;
  /** 作成・最初の投稿・終わった / 戻ったの 1 行・写し・印（既定の人格の Bot） */
  gateway: Pick<Gateway, "createTextChannel" | "channelExists" | "countChannelsIn" | "sendMessage" | "addReaction" | "removeOwnReaction">;
  /** /setup・/new と同じキュー（key は layoutQueueKey） */
  queue: Pick<KeyedSerialQueue, "run">;
  /** 完了カテゴリ・カテゴリ「Claude Code」への移動 */
  channelOps: Pick<ChannelOpsQueue, "enqueueMove" | "cancel">;
  /** ensureFor で作れなかったときの #system の 1 行 */
  notify: SystemNotifier;
  /** ~ の場所（ディレクトリの表示） */
  home: string;
  now: () => Date;
  log: (message: string) => void;
};

/** /cc open のセレクトの 1 件 */
export type CcPickItem = { sessionId: string; label: string; state: CcState; dir: string | null; hasChannel: boolean };

/** 添付（渡せる画像・渡さない添付）があるか */
function hasAttachments(message: IncomingMessage): boolean {
  const skipped = message.skippedAttachments;
  return (message.images?.length ?? 0) > 0 || (skipped !== undefined && skipped.unsupported + skipped.overLimit > 0);
}

function errorKind(error: unknown): string {
  return error instanceof Error ? error.name : typeof error;
}

export class CcChannels {
  private readonly deps: CcChannelsDeps;
  /** 理由 → 最後に #system に出した時刻（ensureFor。同じ理由は 1 時間に 1 回） */
  private readonly noticedAt = new Map<string, number>();
  private readonly inFlight = new Set<Promise<void>>();
  /** 送信ごとの印の操作の列（付ける・外すを順に行う） */
  private readonly markChains = new Map<number, Promise<void>>();
  /** 終わりの印を付けた送信（返信を二重に出さない。プロセスの中だけ） */
  private readonly finalMarked = new Set<number>();
  /** ダイアログで待っていると返信した送信 */
  private readonly dialogNoticed = new Set<number>();

  constructor(deps: CcChannelsDeps) {
    this.deps = deps;
  }

  /** 投稿の途中のものを待つ */
  async idle(): Promise<void> {
    while (this.inFlight.size > 0) await Promise.all([...this.inFlight]);
  }

  /** そのセッションの削除されていないチャンネル（Web の一覧の channel） */
  channelOf(sessionId: string): CcChannelRow | undefined {
    return this.deps.store.anyFor(sessionId);
  }

  /**
   * 作る先のサーバー（guildId を渡せばそれ）。渡さなければ SELF_AGENT_ALLOWED_GUILD_IDS の順で最初の、カテゴリ「Claude Code」を記録しているサーバー。
   * どれも無ければ undefined
   */
  defaultGuild(): string | undefined {
    return this.deps.cfg.allowedGuildIds.find((guildId) => this.deps.guildSettings.ccCategoryId(guildId) !== null);
  }

  /** /cc open のセレクトの候補（一覧の順に CC_PICK_LIMIT 件まで） */
  pickItems(): CcPickItem[] {
    return this.deps.registry
      .snapshot()
      .sessions.slice(0, CC_PICK_LIMIT)
      .map((view) => ({
        sessionId: view.sessionId,
        label: view.name ?? cwdLabel(view.cwd, this.deps.cfg.workspaceDir, this.deps.home) ?? "（名前なし）",
        state: view.state,
        dir: cwdLabel(view.cwd, this.deps.cfg.workspaceDir, this.deps.home),
        hasChannel: this.deps.store.anyFor(view.sessionId) !== undefined,
      }));
  }

  /**
   * チャンネルを作る（§3.1 の流れ。手動の口）。guildId は許可サーバーであること（呼び出し側が確かめる）。reject しない
   */
  openChannel(guildId: string, sessionId: string, origin: CcChannelOrigin): Promise<CcOpenResult> {
    return this.deps.queue.run(layoutQueueKey(guildId), async () => {
      try {
        return await this.create(guildId, sessionId, origin);
      } catch (error) {
        this.deps.log(`Claude Code: チャンネルを作れませんでした（failed・${errorKind(error)}）`);
        return { ok: false, reason: "failed" };
      }
    });
  }

  /**
   * 関わったきっかけから呼ぶ口（CC11 で sender・starter・許可の応答から呼ぶ）。既にあれば何もしない。guildId を省けば defaultGuild。
   * 作れなくても投げず、log に 1 行と、not_set_up・full・failed は #system に 1 行（同じ理由は 1 時間に 1 回）
   */
  async ensureFor(sessionId: string, origin: CcChannelOrigin, guildId?: string): Promise<CcOpenResult> {
    const existing = this.deps.store.anyFor(sessionId);
    if (existing !== undefined) return { ok: false, reason: "exists", channelId: existing.channelId, guildId: existing.guildId };
    const target = guildId ?? this.defaultGuild();
    const result: CcOpenResult = target === undefined ? { ok: false, reason: "not_set_up" } : await this.openChannel(target, sessionId, origin);
    if (!result.ok && result.reason !== "exists") {
      // failed は openChannel が種類付きで出している
      if (result.reason !== "failed") this.deps.log(`Claude Code: チャンネルを作れませんでした（${result.reason}）`);
      if (result.reason === "not_set_up" || result.reason === "full" || result.reason === "failed") {
        const noticeGuild = target ?? this.deps.cfg.allowedGuildIds.find((id) => this.deps.guildSettings.get(id) !== undefined);
        if (noticeGuild !== undefined) this.noticeFailure(noticeGuild, result.reason);
      }
    }
    return result;
  }

  /**
   * 送信を queued にした直後（sender の announce。§3.1・§3.3）。外から積んだ送信（web・tool・github）なら、そのきっかけでチャンネルを作り
   * （tool は頼んだチャンネルのサーバー、それ以外は defaultGuild。作れなくても止めない）、開いているチャンネルに本文を写して、その投稿を印と返事の返信先にする。
   * オーナーの発言（discord）は届け待ちの印を付けるだけ。送り先のセッションの開いているチャンネルの ID を返す
   */
  async announce(row: CcSendRow): Promise<string | undefined> {
    if (row.sessionId === null) return undefined;
    if (row.origin === "discord") {
      this.mark(row);
      return this.deps.store.openFor(row.sessionId)?.channelId;
    }
    const origin = SEND_CHANNEL_ORIGIN[row.origin];
    if (origin !== undefined) await this.ensureFor(row.sessionId, origin, this.guildOfChannel(row.channelId));
    return this.mirrorSend(row);
  }

  /**
   * 起動したセッションを一覧のセッションに結びつけた（starter の onBound。§3.1 の 2・5・6）: 起動したもの（web・tool・github）のきっかけでチャンネルを作り
   * （tool は頼んだチャンネルのサーバー）、最初の指示があれば写す（届いた後なら返信先には使わない）。reject しない
   */
  async started(input: { sessionId: string; startedBy: Exclude<CcStartedBy, "owner">; channelId?: string; sendId?: number }): Promise<void> {
    try {
      await this.ensureFor(input.sessionId, START_CHANNEL_ORIGIN[input.startedBy], this.guildOfChannel(input.channelId ?? null));
      const row = input.sendId === undefined ? undefined : this.deps.sends.get(input.sendId);
      if (row !== undefined) await this.mirrorSend(row);
    } catch (error) {
      this.deps.log(`Claude Code: 起動したセッションのチャンネルを用意できませんでした（${errorKind(error)}）`);
    }
  }

  /** 送信が終わった（sender の settled）: 印を付け替える */
  settled(row: CcSendRow): void {
    this.mark(row);
  }

  /** 送り先のダイアログで待っている（sender の dialog）: その送信のチャンネルの投稿に 1 回だけ返信する */
  dialog(row: CcSendRow): void {
    const target = this.markTarget(row);
    if (target === undefined || this.dialogNoticed.has(row.id)) return;
    this.dialogNoticed.add(row.id);
    this.chain(row.id, async () => {
      await this.deps.gateway.sendMessage(target.channelId, { text: CC_DIALOG_REPLY, replyToId: target.messageId, suppressEmbeds: true });
    });
  }

  /**
   * Claude Code のチャンネルへの発言（main の振り分け。§3.3）。cc のチャンネル（削除されていない cc_channels の行）なら true を返して扱い
   * （SDK のターンにはしない）、それ以外は false（handler へ）。積むのは許可サーバー・オーナー本人・Bot と Webhook でない・既定の人格の Bot で受けた、
   * open の行のチャンネルの発言だけ（それ以外は黙って捨てる）。本文が送れない形・添付だけ・列が満杯なら返信で断り、積まない
   */
  async handleMessage(message: IncomingMessage): Promise<boolean> {
    const { store, cfg, log } = this.deps;
    const row = store.get(message.channelId);
    if (row === undefined || row.state === "deleted") return false;
    if ((message.persona ?? DEFAULT_PERSONA_ID) !== DEFAULT_PERSONA_ID) return true;
    if (
      message.guildId === null ||
      !cfg.allowedGuildIds.includes(message.guildId) ||
      message.guildId !== row.guildId ||
      cfg.ownerUserId === undefined ||
      message.authorId !== cfg.ownerUserId ||
      message.authorIsBot ||
      message.isWebhook
    ) {
      return true;
    }
    if (row.state === "resuming") {
      await this.reply(message, CC_RESUMING_REPLY);
      return true;
    }
    // 終わったチャンネルの [起動して続ける] は CC13
    if (row.state !== "open") return true;
    const checked = normalizeSendText(message.content);
    if (!checked.ok) {
      if (checked.reason !== "empty") await this.reply(message, TEXT_REJECT_REPLY[checked.reason]);
      else if (hasAttachments(message)) await this.reply(message, CC_ATTACHMENT_REPLY);
      return true;
    }
    const sender = this.deps.sender();
    if (sender === undefined) {
      await this.reply(message, SUBMIT_REJECT_REPLY.stopped);
      return true;
    }
    const result = await sender.submit({ sessionId: row.sessionId, text: checked.text, origin: "discord", channelId: row.channelId, messageId: message.id });
    if (!result.ok) {
      log(`Claude Code: チャンネルの発言を積みませんでした（${result.reason}）`);
      await this.reply(message, SUBMIT_REJECT_REPLY[result.reason]);
      return true;
    }
    if (!result.duplicate) log(`Claude Code: チャンネルの発言を積みました（#${result.send.id}）`);
    return true;
  }

  /**
   * /cc cancel（チャンネルの中で）: そのチャンネルのセッションの queued を全部取り消し、取り消した数を返す（印は sender の settled で外れる）。
   * cc のチャンネル（削除されていない行）でなければ undefined
   */
  cancelQueued(channelId: string): number | undefined {
    const row = this.deps.store.get(channelId);
    if (row === undefined || row.state === "deleted") return undefined;
    const sender = this.deps.sender();
    if (sender === undefined) return 0;
    let cancelled = 0;
    for (const send of this.deps.sends.listQueuedFor(row.sessionId)) {
      if (sender.cancel(send.id) === "cancelled") cancelled++;
    }
    if (cancelled > 0) this.deps.log(`Claude Code: チャンネルの届け待ちを ${cancelled} 件取り消しました（guild=${row.guildId}）`);
    return cancelled;
  }

  /** 頼んだチャンネルのサーバー（許可サーバーのときだけ） */
  private guildOfChannel(channelId: string | null): string | undefined {
    if (channelId === null || this.deps.guildOf === undefined) return undefined;
    const guildId = this.deps.guildOf(channelId);
    return guildId !== undefined && this.deps.cfg.allowedGuildIds.includes(guildId) ? guildId : undefined;
  }

  /**
   * 送信をそのセッションの開いているチャンネルに写し（§3.3）、まだ届けていなければその投稿を印と返事の返信先にする。開いているチャンネルの ID を返す。
   * 写しの投稿に失敗しても止めない（印と返信先が無いだけ）
   */
  private async mirrorSend(row: CcSendRow): Promise<string | undefined> {
    const { store, sends, log } = this.deps;
    if (row.sessionId === null) return undefined;
    const channel = store.openFor(row.sessionId);
    if (channel === undefined) return undefined;
    // 既に写した（返信先がこのチャンネル）なら出し直さない
    if (row.channelId === channel.channelId) return channel.channelId;
    let messageId: string | undefined;
    try {
      for (const text of ccMirrorTexts(ccMirrorLabel(row.origin, row.channelId), row.text)) {
        const id = await this.deps.gateway.sendMessage(channel.channelId, { text, suppressEmbeds: true });
        messageId ??= id;
      }
      log(`Claude Code: 写しを出しました（#${row.id}）`);
    } catch (error) {
      log(`Claude Code: 写しを出せませんでした（#${row.id}、${errorKind(error)}）`);
    }
    if (messageId !== undefined && sends.setMirror(row.id, channel.channelId, messageId)) {
      const updated = sends.get(row.id);
      if (updated !== undefined) this.mark(updated);
    }
    return channel.channelId;
  }

  /** 印を付ける先（cc のチャンネルの、オーナーの発言か写しの投稿）。無ければ undefined */
  private markTarget(row: CcSendRow): { channelId: string; messageId: string } | undefined {
    if (row.channelId === null || row.messageId === null) return undefined;
    const channel = this.deps.store.get(row.channelId);
    if (channel === undefined || channel.state === "deleted") return undefined;
    return { channelId: row.channelId, messageId: row.messageId };
  }

  /** 送信の今の状態の印（§3.3）。終わりの印と返信は 1 回だけ */
  private mark(row: CcSendRow): void {
    const target = this.markTarget(row);
    if (target === undefined) return;
    const { gateway } = this.deps;
    const { channelId, messageId } = target;
    const add = (emoji: string) => () => gateway.addReaction(channelId, messageId, emoji);
    const remove = () => () => gateway.removeOwnReaction(channelId, messageId, CC_MARK_WAITING);
    const reply = (text: string) => async () => {
      await gateway.sendMessage(channelId, { text, replyToId: messageId, suppressEmbeds: true });
    };
    let steps: Array<() => Promise<void>>;
    switch (row.state) {
      case "queued":
      case "delivering":
        steps = [add(CC_MARK_WAITING)];
        break;
      case "delivered":
        steps = [remove(), add(CC_MARK_DELIVERED)];
        break;
      case "unconfirmed":
        steps = [remove(), add(CC_MARK_UNCONFIRMED), reply(CC_UNCONFIRMED_REPLY)];
        break;
      case "failed":
        steps = [remove(), add(CC_MARK_FAILED), reply(ccFailedReply(row.lastPaneState))];
        break;
      case "gave_up":
        steps = [remove(), add(CC_MARK_FAILED), reply(CC_GAVE_UP_REPLY)];
        break;
      case "cancelled":
        steps = [remove()];
        break;
      default:
        return;
    }
    if (row.state !== "queued" && row.state !== "delivering") {
      if (this.finalMarked.has(row.id)) return;
      this.finalMarked.add(row.id);
    }
    for (const step of steps) this.chain(row.id, step);
  }

  /** 送信ごとの列に Discord の操作を足す（失敗は log だけ） */
  private chain(sendId: number, step: () => Promise<void>): void {
    const previous = this.markChains.get(sendId) ?? Promise.resolve();
    const next = previous.then(async () => {
      try {
        await step();
      } catch (error) {
        this.deps.log(`Claude Code: 印を付けられませんでした（#${sendId}、${errorKind(error)}）`);
      }
    });
    this.markChains.set(sendId, next);
    this.inFlight.add(next);
    void next.finally(() => {
      this.inFlight.delete(next);
      if (this.markChains.get(sendId) === next) this.markChains.delete(sendId);
    });
  }

  /** オーナーの発言への返信（失敗は log だけ） */
  private async reply(message: IncomingMessage, text: string): Promise<void> {
    try {
      await this.deps.gateway.sendMessage(message.channelId, { text, replyToId: message.id, suppressEmbeds: true });
    } catch (error) {
      this.deps.log(`Claude Code: チャンネルの発言に返信できませんでした（${errorKind(error)}）`);
    }
  }

  /**
   * セッションが一覧から消えた（registry の ended）: open のチャンネルを ended にして 1 行を出し、完了カテゴリへ移す。
   * 開いているチャンネルが無ければ false
   */
  ended(session: Pick<CcSessionRow, "sessionId">): boolean {
    const row = this.deps.store.openFor(session.sessionId);
    if (row === undefined || !this.deps.store.setState(row.channelId, "ended", ["open"])) return false;
    this.deps.log(`Claude Code: セッションが終わったため、チャンネルを完了に移します（guild=${row.guildId}）`);
    this.post(row, CC_CHANNEL_ENDED_TEXT);
    this.deps.channelOps.enqueueMove(row.channelId, { kind: "state", guildId: row.guildId, state: "done" });
    return true;
  }

  /**
   * 同じ session_id が一覧に戻った（registry の revived）: その session_id の ended のチャンネルを open に戻して 1 行を出し、
   * カテゴリ「Claude Code」へ戻す（付け替えの前の id（previous_session_id）では開き直さない）。開き直さなければ false
   */
  revived(session: Pick<CcSessionRow, "sessionId">): boolean {
    const row = this.deps.store.anyFor(session.sessionId);
    if (row === undefined || row.state !== "ended" || !this.deps.store.setState(row.channelId, "open", ["ended"])) return false;
    this.deps.log(`Claude Code: セッションが戻ったため、チャンネルを開き直します（guild=${row.guildId}）`);
    this.post(row, CC_CHANNEL_REVIVED_TEXT);
    this.moveToCategory(row);
    return true;
  }

  /**
   * 再同期（scheduler.ts の tick。§3.6）: listedAt より前に作ったそのサーバーの削除されていない行のうち、Discord 上に無いものは削除済みに、
   * open でカテゴリ「Claude Code」の外のものはそこへ、ended で完了カテゴリの外のものは完了へ移す（移すのは limit 件まで）。移した数を返す
   */
  reconcile(guildId: string, parents: ReadonlyMap<string, string | null>, listedAt: Date, limit: number): number {
    const { store, guildSettings, channelOps, log } = this.deps;
    const ccCategoryId = guildSettings.ccCategoryId(guildId);
    const doneCategories = guildSettings
      .listStateCategories(guildId, "done")
      .map((category) => category.categoryId)
      .filter((id) => parents.has(id));
    let moved = 0;
    let deleted = 0;
    for (const row of store.listUndeleted(guildId)) {
      // 一覧を取っている間に作った行は、一覧に無くても消さない
      if (Date.parse(row.createdAt) >= listedAt.getTime()) continue;
      if (!parents.has(row.channelId)) {
        if (store.markDeleted(row.channelId)) {
          channelOps.cancel(row.channelId);
          deleted++;
        }
        continue;
      }
      if (moved >= limit) continue;
      const parentId = parents.get(row.channelId) ?? null;
      if (row.state === "open") {
        if (ccCategoryId === null || !parents.has(ccCategoryId) || parentId === ccCategoryId) continue;
        channelOps.enqueueMove(row.channelId, { kind: "category", categoryId: ccCategoryId });
        moved++;
      } else if (row.state === "ended") {
        if (doneCategories.length === 0 || (parentId !== null && doneCategories.includes(parentId))) continue;
        channelOps.enqueueMove(row.channelId, { kind: "state", guildId, state: "done" });
        moved++;
      }
    }
    if (deleted > 0) log(`Claude Code: Discord 上に無いチャンネル ${deleted} 件を削除済みにしました（guild=${guildId}）`);
    if (moved > 0) log(`Claude Code: カテゴリが合わないチャンネル ${moved} 件を移します（guild=${guildId}）`);
    return moved;
  }

  private async create(guildId: string, sessionId: string, origin: CcChannelOrigin): Promise<CcOpenResult> {
    const { store, guildSettings, registry, panes, gateway, log } = this.deps;
    const existing = store.anyFor(sessionId);
    if (existing !== undefined) {
      // 終わったチャンネルでも、セッションが一覧に戻っていれば開き直す（§3.6）
      if (existing.state === "ended" && registry.snapshot().sessions.some((view) => view.sessionId === sessionId)) {
        this.revived({ sessionId });
      }
      return { ok: false, reason: "exists", channelId: existing.channelId, guildId: existing.guildId };
    }
    const sessions = registry.snapshot().sessions;
    const view = sessions.find((candidate) => candidate.sessionId === sessionId);
    if (view === undefined) return { ok: false, reason: "not_found" };
    if (!(await this.inTmux(view, sessions))) return { ok: false, reason: "not_in_tmux" };
    const categoryId = guildSettings.ccCategoryId(guildId);
    if (categoryId === null || !(await gateway.channelExists(categoryId))) return { ok: false, reason: "not_set_up" };
    let count: number;
    try {
      count = await gateway.countChannelsIn(categoryId);
    } catch (error) {
      // 記録した ID が別の種類のチャンネルになっている（カテゴリが消えた）のは /setup 前と同じ
      if (error instanceof NotCategoryError) return { ok: false, reason: "not_set_up" };
      throw error;
    }
    if (count >= CC_CATEGORY_CHANNEL_LIMIT) return { ok: false, reason: "full" };
    const name = view.name ?? null;
    const cwd = view.cwd ?? null;
    const dir = cwdLabel(view.cwd, this.deps.cfg.workspaceDir, this.deps.home);
    const taken = new Set(store.listUndeleted(guildId).map((row) => row.name));
    const channelName = ccChannelName(name, cwd, taken);
    const channelId = await gateway.createTextChannel(guildId, { name: channelName, parentId: categoryId, topic: ccChannelTopic(name, dir) });
    try {
      store.create({ channelId, guildId, sessionId, name: channelName, cwd, origin });
    } catch (error) {
      // 手で消せるよう、作ったチャンネルの ID を出す（log 方針の例外。セッションのチャンネルと同じ）
      log(`Claude Code: チャンネルを作りましたが記録に失敗しました（guild=${guildId}、channel=${channelId}）: ${errorKind(error)}`);
      return { ok: false, reason: "failed" };
    }
    log(`Claude Code: チャンネルを作りました（guild=${guildId}、${origin}）`);
    try {
      await gateway.sendMessage(channelId, { text: ccChannelIntro(name, dir, origin), suppressEmbeds: true });
    } catch (error) {
      log(`Claude Code: チャンネルの最初の投稿に失敗しました（${errorKind(error)}）`);
    }
    return { ok: true, channelId, guildId };
  }

  /** 送ってよいペイン（findSendablePane）に当たるか */
  private async inTmux(view: CcSessionView, sessions: readonly CcSessionView[]): Promise<boolean> {
    const lookup = await this.deps.panes.lookup(new Set(sessions.map((session) => session.pid)));
    return lookup.ok && lookup.sendable({ pid: view.pid, tmux: view.tmux }).ok;
  }

  private moveToCategory(row: CcChannelRow): void {
    const categoryId = this.deps.guildSettings.ccCategoryId(row.guildId);
    // カテゴリを作り直すのは /setup（作り直した後は再同期が戻す）
    if (categoryId === null) return;
    this.deps.channelOps.enqueueMove(row.channelId, { kind: "category", categoryId });
  }

  /** そのチャンネルに 1 行（失敗は log だけ） */
  private post(row: CcChannelRow, text: string): void {
    const task = (async () => {
      try {
        await this.deps.gateway.sendMessage(row.channelId, { text, suppressEmbeds: true });
      } catch (error) {
        this.deps.log(`Claude Code: チャンネルへの投稿に失敗しました（${errorKind(error)}）`);
      }
    })();
    this.inFlight.add(task);
    void task.finally(() => this.inFlight.delete(task));
  }

  /** 作れなかった理由を #system に 1 行（同じ理由は CC_CHANNEL_FAILURE_NOTICE_MS に 1 回。失敗は log だけ） */
  private noticeFailure(guildId: string, reason: "not_set_up" | "full" | "failed"): void {
    const now = this.deps.now().getTime();
    const last = this.noticedAt.get(reason);
    if (last !== undefined && now - last < CC_CHANNEL_FAILURE_NOTICE_MS) return;
    this.noticedAt.set(reason, now);
    const task = (async () => {
      try {
        await this.deps.notify(guildId, { text: FAILURE_NOTICE[reason] }, { level: "warning" });
      } catch (error) {
        this.deps.log(`Claude Code: チャンネルを作れなかった知らせに失敗しました（${errorKind(error)}）`);
      }
    })();
    this.inFlight.add(task);
    void task.finally(() => this.inFlight.delete(task));
  }
}

/**
 * registry の ended に渡す関数（main の配線。§3.6）: チャンネルがあれば ended にして完了へ移し、返事の追いかけ（replier）は今までどおり止め、
 * #system の終了の知らせ（notifier）はチャンネルも追いかけも無いときだけ出す（チャンネルに出したので二重にしない）
 */
export function ccEndedHandler(deps: {
  channels: () => Pick<CcChannels, "ended"> | undefined;
  replier: () => { ended(session: CcSessionRow): boolean } | undefined;
  notifier: () => { ended(session: CcSessionRow): void } | undefined;
}): (session: CcSessionRow) => void {
  return (session) => {
    const inChannel = deps.channels()?.ended(session) === true;
    const followed = deps.replier()?.ended(session) === true;
    if (!inChannel && !followed) deps.notifier()?.ended(session);
  };
}

/**
 * 発言の handler の包み（main の配線。§3.3・§3.8）: 削除されていない cc_channels の行のチャンネルへの発言は、ターンにせず channels の handleMessage で
 * 届ける（連携が動いていなければ黙って捨てる）。それ以外は handle に渡す
 */
export function routeCcChannelMessages(
  store: Pick<CcChannelStore, "get">,
  channels: () => Pick<CcChannels, "handleMessage"> | undefined,
  handle: (message: IncomingMessage) => Promise<void>,
): (message: IncomingMessage) => Promise<void> {
  return async (message) => {
    const row = store.get(message.channelId);
    if (row === undefined || row.state === "deleted") return handle(message);
    await channels()?.handleMessage(message);
  };
}
