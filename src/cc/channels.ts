// Claude Code のセッションごとの Discord のチャンネル（docs/plan/claude-code-channels.md §3。CC10 の分）。
// - 作る（openChannel）: /setup・/new と同じ layoutQueueKey のキューで、1 セッション 1 チャンネル（既にあれば exists）・一覧にあって tmux の中
//   （findSendablePane が当たる）・カテゴリ「Claude Code」（guild_settings.cc_category_id）があって 50 未満のときだけ、`cc-<セッション名>` を作り、
//   cc_channels に行を書いて最初の 1 通を投稿する。手動の口（Web のタブの [Discord のチャンネルを作る]・/cc open）が呼ぶ。
//   ensureFor は「関わった」きっかけ（CC11）と、許可の要求・質問・判断待ちの知らせ（docs/plan/claude-code-questions.md §5。Q4。cc/channel-posts.ts）から
//   呼ぶ口で、既にあれば何もせず、作れなくても投げず、log だけ（同じ理由は 1 時間に 1 回。#system には出さない）。
//   知らせのきっかけ（permission・question・waiting）では tmux の外のセッションにも作る（そのチャンネルへの発言は sender が not_in_tmux で断る）。
// - 終わった（ended。registry が一覧から消えたセッションを渡す）: open の行を ended にして 1 行を出し、完了カテゴリへ移す。
// - 戻った（revived。同じ session_id が一覧に戻った）: その session_id の ended の行を open に戻して 1 行を出し、カテゴリ「Claude Code」へ戻す。
// - 再同期（reconcile。scheduler.ts の tick）: Discord 上に無い行を削除済みに、open でカテゴリ「Claude Code」の外のもの・ended で完了の外のものを戻す。
// - 関わった（CC11。§3.1）: Web・cc_send の [送る]・GitHub の [対応] で積んだ直後（announce）と、起動したセッションを一覧のセッションに結びつけたとき
//   （started）に ensureFor で作り、本文をチャンネルに写して（「（Web から）」など）その投稿を印と返事の返信先にする（作れなければ写さない）。
// - 発言（handleMessage。§3.3）: 許可サーバー・オーナー本人・Bot と Webhook でない・既定の人格の Bot で受けた、open の行のチャンネルの発言を
//   確認なしで cc_sends（origin discord）に積む（sender.submit。同じセッションに CC_CHANNEL_QUEUE_MAX 件まで）。SDK のターンは動かさない（LLM を呼ばない）。
//   resuming の間は断る。
// - 続ける（CC13。§3.6）: ended のチャンネルの発言は、セッションが一覧にある（/cc close で閉じただけ）なら開き直して積み、
//   無ければ積まずに「このセッションは終わっています」+ [起動して続ける][やめる] を返信する。[起動して続ける]（resume）は ended → resuming の compare-and-set の後、そのセッションの cwd
//   （SELF_AGENT_WORKSPACE_DIR の直下だけ）で starter.launch（startedBy tool・最初の指示はその発言）し、結びついたら（started の resumeChannelId）
//   session_id を付け替えて open に戻し、topic を書き換えてカテゴリ「Claude Code」へ戻す。起動の失敗・結びつけられなかったら ended に戻す。
//   取り込み（docs/plan/takeover.md §5.6。T4）が配線されていて、そのチャンネルを取り込めるときは間に [取り込んで続ける] も出す（処理は app/commands/cc.ts。
//   保留は takePending で引く）。
// - 閉じる（/cc close。close）: open を ended にして完了へ移し、届け待ちを取り消す（セッションが生きていても。次に関われば開き直す）。
// - 削除の確認（CC13）: scheduler.ts が ccDeletePrompt を #system に出し、app/commands/cc.ts の cc:del・cc:del:keep が処理する。
// - 印（§3.3）: 届け待ちは ⏳、届けたら ✅、確かめられなければ ⚠️ と返信、送れなければ ❌ と返信、取り消したら ⏳ を外す（リアクション。失敗は log だけ）。
// - Web の会話（CC14。§5.2。history を渡したとき（Web UI が有効）だけ）: オーナーの発言・外からの送信の写しを owner、届かなかった・ダイアログで待っている・
//   終わった・戻った・閉じた・終わったチャンネルの発言への返信を notice、[起動して続ける] で付け替えたことを divider で書く（guild_id は cc_channels の行、persona は既定）。
//   Web の会話の入力欄からの送信（submitWeb）は /api/cc/sessions/<id>/send と同じ sender.submit（origin web）で積み、写しと owner の行は announce が書く。
// 投稿・リアクションは既定の人格の Bot。名前・ディレクトリは hook から来たデータなので、Markdown とメンションを無効にする。
// log はサーバー ID と種類・件数・送信の番号だけ（チャンネル ID・名前・cwd・sessionId・本文は出さない。作った後の DB の失敗だけ例外）
import { basename, dirname } from "node:path";
import { realpathSync } from "node:fs";
import { CC_START_RETRY_NOTE, CC_START_THREW, CC_START_SEND_FAILED_NOTE, ccStartedTexts, START_FAILURE_TEXT } from "../app/commands/cc-confirm.ts";
import { layoutQueueKey } from "../app/commands/setup.ts";
import type { ChannelOpsQueue } from "../app/channel-ops.ts";
import type { KeyedSerialQueue } from "../app/queue.ts";
import { DEFAULT_PERSONA_ID, type Config } from "../config.ts";
import { normalizeChannelName, CHANNEL_NAME_MAX_LENGTH } from "../discord/channel-name.ts";
import { escapeDiscordText } from "../discord/escape.ts";
import { type Gateway, type IncomingMessage, type OutgoingMessage, NotCategoryError } from "../discord/gateway.ts";
import type { CcChannelOrigin, CcChannelRow, CcChannelStore } from "../store/cc-channels.ts";
import type { CcPermissionStore } from "../store/cc-permissions.ts";
import type { CcSendOrigin, CcSendRow, CcSendStore } from "../store/cc-sends.ts";
import { headChars, type CcSessionRow, type CcSessionStore, type CcStartedBy } from "../store/cc-sessions.ts";
import type { GuildSettingsStore } from "../store/guild-settings.ts";
import { recordHistory, type HistoryKind, type HistorySource, type HistoryStore } from "../store/history.ts";
import { cwdLabel } from "./labels.ts";
import type { CcPaneResolver } from "./panes.ts";
import type { CcRegistry, CcSessionView, CcState } from "./registry.ts";
import { CC_CHANNEL_QUEUE_MAX, normalizeSendText, type CcSender, type CcSubmitResult } from "./sender.ts";
import { breakMaskedLinks } from "./replies.ts";
import { normalizeTitle, type CcStartFailure, type CcStarter, type CcStartResult } from "./starter.ts";
import { TAKEOVER_BUSY_TEXT, TAKEOVER_SEND_REJECT_TEXT } from "./takeover-rules.ts";

/** Discord で 1 つのカテゴリに入れられるチャンネル数（カテゴリ「Claude Code」は 1 つだけで、満杯なら作らずに断る） */
export const CC_CATEGORY_CHANNEL_LIMIT = 50;
/** 作れなかった同じ理由を log に出す間隔（プロセスの中） */
export const CC_CHANNEL_FAILURE_LOG_MS = 60 * 60_000;
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
// 最初の投稿の「（<きっかけ>で作りました）」。日本語で終わるものは空白を挟まず、ボタン・コマンドの名前で終わるものだけ空白を挟む
const ORIGIN_LABEL: Readonly<Record<CcChannelOrigin, string>> = {
  web: "Web の [Discord のチャンネルを作る] ",
  command: "/cc open ",
  web_send: "Web から送った本文",
  web_start: "Web からの起動",
  permission: "許可の要求",
  tool_send: "cc_send の [送る] ",
  tool_start: "cc_start の [起動する] ",
  github: "#github の [対応] ",
  question: "質問",
  waiting: "判断待ちの知らせ",
};

/** 知らせのきっかけ（docs/plan/claude-code-questions.md §5。tmux の外のセッションにも作る） */
const NOTICE_ORIGINS: ReadonlySet<CcChannelOrigin> = new Set(["permission", "question", "waiting"]);

/** tmux の外のセッションのチャンネルへの発言の返信と、そのチャンネルの最初の投稿に足す 1 行 */
export const CC_NOT_IN_TMUX_REPLY = "このセッションは tmux の外なので、ここからは送れません（RC で開いてください）";

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
  already_queued: "届け待ちの本文があります。届くか、やめてから送ってください",
  queue_full: CC_QUEUE_FULL_REPLY,
  not_in_tmux: CC_NOT_IN_TMUX_REPLY,
  not_claude: "送り先のペインが claude ではありません",
  no_server: "tmux のサーバーがありません",
  tmux_failed: "tmux を使えませんでした",
  stopped: "停止中です",
  taking_over: TAKEOVER_SEND_REJECT_TEXT,
};

/** 送れなかった理由（cc_sends.last_pane_state）の表示 */
const FAILURE_REASON_TEXT: Readonly<Record<string, string>> = {
  gone: "セッションが一覧にありません",
  not_claude: "送り先が claude ではありません",
  not_in_tmux: "tmux の外です",
  cwd_mismatch: "起動したディレクトリと違います",
  invalid_text: "送れない文字があります",
};

/** 終わりの状態の印（cancelled は ⏳ を外すだけなので空） */
const FINAL_MARK: Readonly<Partial<Record<CcSendRow["state"], string>>> = {
  delivered: CC_MARK_DELIVERED,
  unconfirmed: CC_MARK_UNCONFIRMED,
  failed: CC_MARK_FAILED,
  gave_up: CC_MARK_FAILED,
  cancelled: "",
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

export const CC_CHANNEL_ENDED_TEXT = "セッションが終わりました。ここに書くと、同じディレクトリで起動して続けられます";
export const CC_CHANNEL_REVIVED_TEXT = "セッションが戻りました。";
/** 閉じた（/cc close）チャンネルを、セッションが一覧にあるうちに関わって開き直したときの 1 行 */
export const CC_CHANNEL_REOPENED_TEXT = "開き直しました";
/** /cc close の応答（チャンネルに出す） */
export const CC_CHANNEL_CLOSED_TEXT = "閉じました。ここに書くと起動して続けられます";

/** /cc close でやめた届け待ちの 1 行（純関数） */
export function ccClosedCancelledText(count: number): string {
  return `閉じたので、届け待ちの ${count} 件を送るのをやめました`;
}

/** 閉じたときの文（純関数。/cc close の応答・Web から閉じたときの投稿・Web の会話の知らせで共通） */
export function ccClosedText(cancelled: number): string {
  return cancelled > 0 ? `${CC_CHANNEL_CLOSED_TEXT}\n${ccClosedCancelledText(cancelled)}` : CC_CHANNEL_CLOSED_TEXT;
}

/** 終わったチャンネルの発言への返信（[起動して続ける][やめる]。CC13） */
export const CC_RESUME_PROMPT_TEXT = "このセッションは終わっています。[起動して続ける] で同じディレクトリで起動し、この発言を最初の指示として送ります";
export const CC_RESUME_KEPT_TEXT = "起動しませんでした";
export const CC_RESUME_BAD_PLACE_TEXT = "起動できる場所ではありません。Web か端末で起動してください";
export const CC_RESUME_GAVE_UP_TEXT = "起動したセッションを一覧で見つけられませんでした";
export const CC_RESUME_STALE_TEXT = "この操作は古くなっています";
/** [起動して続ける] の custom_id の頭（`cc:resume:<channel_id>:<message_id>`・`cc:resume:keep:<channel_id>:<message_id>`） */
export const CC_RESUME_PREFIX = "cc:resume";
/** [取り込んで続ける] の custom_id の頭（`cc:take:resume:<channel_id>:<message_id>`。docs/plan/takeover.md §5.6。T4） */
export const CC_TAKE_RESUME_PREFIX = "cc:take:resume";

/** 終わったチャンネルの [起動して続ける][やめる]（純関数）。take なら間に [取り込んで続ける]（T4） */
export function ccResumeButtons(channelId: string, messageId: string, take = false): NonNullable<OutgoingMessage["components"]> {
  return [
    {
      kind: "buttons",
      buttons: [
        { customId: `${CC_RESUME_PREFIX}:${channelId}:${messageId}`, label: "起動して続ける", style: "primary" },
        ...(take ? [{ customId: `${CC_TAKE_RESUME_PREFIX}:${channelId}:${messageId}`, label: "取り込んで続ける" }] : []),
        { customId: `${CC_RESUME_PREFIX}:keep:${channelId}:${messageId}`, label: "やめる" },
      ],
    },
  ];
}

/** 結びついたときの 1 行（純関数） */
export function ccResumedText(name: string): string {
  return `${plain(name)} として起動しました。続けます`;
}

/** Web の会話の区切り（[起動して続ける] で付け替えた。CC14。history は文字のまま出すので Markdown を無効にしない） */
export function ccResumedDivider(name: string): string {
  return `${headChars(name.replace(/[\u0000-\u001f\u007f]/g, " "), LABEL_MAX_CHARS)} として起動しました`;
}

/** Web の会話の入力欄からの送信（submitWeb。CC14）の結果。ended・resuming・not_channel は積まない */
export type CcSubmitWebResult =
  | { ok: true; sendId: number; channelId: string; messageId: string | null }
  | { ok: false; reason: Exclude<CcSubmitResult, { ok: true }>["reason"] | "not_channel" | "ended" | "resuming" | "empty" | "too_long" | "invalid_text" };

/** [起動して続ける] の結果 */
export type CcResumeResult =
  | { ok: true; message: OutgoingMessage }
  /** expired = 保留が無い（再起動・[やめる]・付け替えの後。確認のボタンを外す）、stale = 状態・サーバーが合わない */
  | { ok: false; reason: "stale" | "expired" }
  /** taking_over = 取り込みの途中（docs/plan/takeover.md §3.2。何も変えず、ボタンは残す） */
  | { ok: false; reason: CcResumeFailure | "taking_over"; message: OutgoingMessage };

/** [起動して続ける] で起動できなかった理由（bad_place = cwd が SELF_AGENT_WORKSPACE_DIR の直下でない、failed = launch が投げた） */
export type CcResumeFailure = "bad_place" | "failed" | CcStartFailure;

/** 削除の確認（純関数。scheduler.ts が #system に出す。CC13）。[削除する]（`cc:del:<channel_id>`）・[残す]（`cc:del:keep:<channel_id>`） */
export function ccDeletePrompt(row: Pick<CcChannelRow, "channelId" | "name">, deleteAfterDays: number): OutgoingMessage {
  return {
    text: `<#${row.channelId}>（${escapeDiscordText(row.name)}）は Claude Code のセッションが終わってから ${deleteAfterDays} 日経ちました。チャンネルを削除しますか？`,
    components: [
      {
        kind: "buttons",
        buttons: [
          { customId: `cc:del:${row.channelId}`, label: "削除する", style: "danger" },
          { customId: `cc:del:keep:${row.channelId}`, label: "残す" },
        ],
      },
    ],
  };
}

export function ccDeletedText(name: string): string {
  return `${escapeDiscordText(name)} を削除しました`;
}

export function ccKeptText(name: string, deleteAfterDays: number): string {
  return `${escapeDiscordText(name)} を残しました。${deleteAfterDays} 日後にもう一度確認します`;
}

/**
 * [起動して続ける] で起動するディレクトリの名前（純関数に近い。§3.6）: cwd の親が SELF_AGENT_WORKSPACE_DIR（realpath も見る）なら最後の名前、それ以外は undefined。
 * 実際に起動してよいかは starter.launch が projectDir で確かめる
 */
export function resumeProject(cwd: string | null, workspaceDir: string): string | undefined {
  if (cwd === null) return undefined;
  cwd = cwd.replace(/\/+$/, "");
  if (cwd === "") return undefined;
  const parent = dirname(cwd);
  let real: string | undefined;
  try {
    real = realpathSync(workspaceDir);
  } catch {
    real = undefined;
  }
  if (parent !== workspaceDir.replace(/\/+$/, "") && parent !== real) return undefined;
  const name = basename(cwd);
  return name === "" ? undefined : name;
}

/** /cc close の結果。closed は取り消した届け待ちの数を添える */
export type CcCloseResult = { result: "closed"; cancelled: number } | { result: "not_channel" | "resuming" | "ended" | "taking_over" };

/** 開き直す理由（back = 同じ session_id が一覧に戻った、reopened = 閉じたチャンネルのセッションが一覧にあるうちに関わった） */
export type CcReviveReason = "back" | "reopened";

/** 終わったチャンネルの発言の保留（[起動して続ける] を押すまで。プロセスの中だけで、再起動の後のボタンは古い） */
const RESUME_PENDING_MAX = 50;

/**
 * 保留した発言（[起動して続ける]・[取り込んで続ける] の最初の指示）。historyId は保留のときに書いた owner の行の id
 * （書いていない（Web UI が無効）なら無し、書けなければ 0）
 */
export type HeldMessage = { text: string; promptMessageId: string; historyId?: number };

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

/**
 * 最初の投稿（純関数）。tmux の外のセッション（知らせのために作ったもの）なら「ここに書くと届きます」を言わず、ここからは送れない旨の 1 行を足す
 */
export function ccChannelIntro(name: string | null, dir: string | null, origin: CcChannelOrigin, inTmux = true): string {
  const label = name === null || name === "" ? "（名前なし）" : name;
  return (
    `Claude Code のセッション「${plain(label)}」${dir === null || dir === "" ? "" : `（${plain(dir)}）`}のチャンネルです（${ORIGIN_LABEL[origin]}で作りました）。` +
    (inTmux ? "ここに書くとこのセッションに届きます。" : "") +
    "返事と許可の要求はここに出ます。セッションが終わると完了に移し、戻るとここに戻します" +
    (inTmux ? "" : `\n${CC_NOT_IN_TMUX_REPLY}`)
  );
}

export type CcChannelsDeps = {
  cfg: Pick<Config, "allowedGuildIds" | "workspaceDir" | "ownerUserId">;
  store: CcChannelStore;
  /** 写しを印と返事の返信先にする・/cc cancel の対象・[起動して続ける] の最初の指示の返信先 */
  sends: Pick<CcSendStore, "get" | "setMirror" | "listQueuedFor" | "setMessageId">;
  /** チャンネルの発言を積む・/cc cancel で取り消す（main では後で作るので関数で渡す） */
  sender: () => Pick<CcSender, "submit" | "cancel"> | undefined;
  /** [起動して続ける] の起動（CC13。無ければ「停止中です」） */
  starter?: () => Pick<CcStarter, "launch"> | undefined;
  /** [起動して続ける] のセッションの cwd・名前（cc_sessions。行が消えていれば cc_channels の cwd） */
  sessions?: Pick<CcSessionStore, "get">;
  /** Discord から頼んだ送信・起動の頼んだチャンネルのサーバー（そのサーバーに作る。分からなければ defaultGuild） */
  guildOf?: (channelId: string) => string | undefined;
  guildSettings: Pick<GuildSettingsStore, "get" | "ccCategoryId" | "listStateCategories">;
  registry: Pick<CcRegistry, "snapshot">;
  panes: Pick<CcPaneResolver, "lookup">;
  /** 作成・最初の投稿・終わった / 戻ったの 1 行・写し・印（既定の人格の Bot） */
  gateway: Pick<
    Gateway,
    | "createTextChannel"
    | "deleteChannel"
    | "channelExists"
    | "countChannelsIn"
    | "sendMessage"
    | "editMessage"
    | "addReaction"
    | "removeOwnReaction"
    | "setChannelTopic"
  >;
  /** /setup・/new と同じキュー（key は layoutQueueKey） */
  queue: Pick<KeyedSerialQueue, "run">;
  /** 完了カテゴリ・カテゴリ「Claude Code」への移動 */
  channelOps: Pick<ChannelOpsQueue, "enqueueMove" | "cancel">;
  /** Web UI の会話の記録（CC14。Web UI が有効なときだけ。無ければ書かない） */
  history?: Pick<HistoryStore, "add">;
  /**
   * 取り込み（docs/plan/takeover.md §3.2。cc/takeover.ts の CcTakeover）。running の取り込みがあるセッション・チャンネルの [起動して続ける]・
   * close・開き直しは何も変えない。無ければ見ない
   */
  takeover?: () => CcTakeoverGuard | undefined;
  /** ~ の場所（ディレクトリの表示） */
  home: string;
  now: () => Date;
  log: (message: string) => void;
};

/**
 * 取り込みの途中かを見る口（cc/takeover.ts の CcTakeover の holds・holdsChannel）。refusal は [取り込んで続ける] を出すかの判定（T4。
 * undefined を返せば取り込める。無ければ出さない）
 */
export type CcTakeoverGuard = {
  holds(sessionId: string): boolean;
  holdsChannel(channelId: string): boolean;
  refusal?(channelId: string): Promise<string | undefined>;
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
  /** 理由 → 最後に log に出した時刻（ensureFor。同じ理由は 1 時間に 1 回） */
  private readonly failureLoggedAt = new Map<string, number>();
  private readonly inFlight = new Set<Promise<void>>();
  /** 送信ごとの印の操作の列（付ける・外すを順に行う） */
  private readonly markChains = new Map<number, Promise<void>>();
  /** 終わりの印を付けた送信（返信を二重に出さない。プロセスの中だけ） */
  private readonly finalMarked = new Set<number>();
  /** 同じ本文を続けて書いた発言（送信 → そのチャンネルとメッセージ）。終わりの印をそこにも付ける */
  private readonly duplicates = new Map<number, Array<{ channelId: string; messageId: string }>>();
  /** ⚠️ を付けた送信 → 付けた投稿（後で UserPromptSubmit で届いたと分かったら ✅ に付け替える。sender.ts の CC_PROMPT_CONFIRM_WINDOW_MS） */
  private readonly unconfirmedMarked = new Map<number, Array<{ channelId: string; messageId: string }>>();
  /** ダイアログで待っていると返信した送信 */
  private readonly dialogNoticed = new Set<number>();
  /** 終わったチャンネルの発言（`<channel_id>:<message_id>` → 本文と確認の投稿）。[起動して続ける] の最初の指示（CC13） */
  private readonly resumePending = new Map<string, HeldMessage>();

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
   * 関わったきっかけ（CC11 で sender・starter・許可の応答）と知らせ（Q4。cc/channel-posts.ts の許可の要求・質問・判断待ち）から呼ぶ口。
   * 既にあれば何もしない。guildId を省けば defaultGuild。作れなくても投げず、log だけ（同じ理由は 1 時間に 1 回。#system には出さない）
   */
  async ensureFor(sessionId: string, origin: CcChannelOrigin, guildId?: string): Promise<CcOpenResult> {
    const existing = this.deps.store.anyFor(sessionId);
    if (existing !== undefined) {
      this.reopenIfListed(existing);
      return { ok: false, reason: "exists", channelId: existing.channelId, guildId: existing.guildId };
    }
    const target = guildId ?? this.defaultGuild();
    const result: CcOpenResult = target === undefined ? { ok: false, reason: "not_set_up" } : await this.openChannel(target, sessionId, origin);
    if (!result.ok && result.reason !== "exists") this.logFailure(result.reason, NOTICE_ORIGINS.has(origin));
    return result;
  }

  /**
   * 送信を queued にした直後（sender の announce。§3.1・§3.3）。外から積んだ送信（web・tool・github）なら、そのきっかけでチャンネルを作り
   * （guildId（Discord で押した [対応] のサーバー）→ tool は頼んだチャンネルのサーバー → defaultGuild。作れなくても止めない）、開いているチャンネルに本文を写して、
   * その投稿を印と返事の返信先にする。オーナーの発言（discord）は届け待ちの印を付けるだけ。送り先のセッションの開いているチャンネルの ID を返す
   */
  async announce(row: CcSendRow, guildId?: string): Promise<string | undefined> {
    if (row.sessionId === null) return undefined;
    if (row.origin === "discord") {
      this.mark(row);
      return this.deps.store.openFor(row.sessionId)?.channelId;
    }
    const origin = SEND_CHANNEL_ORIGIN[row.origin];
    if (origin !== undefined) await this.ensureFor(row.sessionId, origin, this.allowedGuild(guildId) ?? this.guildOfChannel(row.channelId));
    return this.mirrorSend(row);
  }

  /**
   * 起動したセッションを一覧のセッションに結びつけた（starter の onBound。§3.1 の 2・5・6）: 起動したもの（web・tool・github）のきっかけでチャンネルを作り
   * （tool は頼んだチャンネルのサーバー）、最初の指示があれば写す（届いた後なら返信先には使わない）。reject しない
   */
  async started(input: {
    sessionId: string;
    startedBy: Exclude<CcStartedBy, "owner">;
    channelId?: string;
    sendId?: number;
    /** Discord で押した [起動して送る] のサーバー */
    guildId?: string;
    /** [起動して続ける] のチャンネル（CC13。新しいチャンネルは作らずに付け替える） */
    resumeChannelId?: string;
  }): Promise<void> {
    try {
      if (input.resumeChannelId !== undefined && this.rebound(input.resumeChannelId, input.sessionId)) return;
      const guildId = this.allowedGuild(input.guildId) ?? this.guildOfChannel(input.channelId ?? null);
      await this.ensureFor(input.sessionId, START_CHANNEL_ORIGIN[input.startedBy], guildId);
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
    this.recordAt(target.channelId, "notice", CC_DIALOG_REPLY);
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
    const checked = normalizeSendText(message.content);
    if (!checked.ok) {
      if (checked.reason !== "empty") await this.reply(message, TEXT_REJECT_REPLY[checked.reason]);
      else if (hasAttachments(message)) await this.reply(message, CC_ATTACHMENT_REPLY);
      return true;
    }
    // 終わったチャンネルの発言: セッションが一覧にある（/cc close で閉じただけ）なら関わったとして開き直して積み、
    // 無ければ積まずに [起動して続ける] を出す（起動はボタンでだけ。§3.6）
    // 取り込みの途中は積まず、[起動して続ける] も出さない（docs/plan/takeover.md §3.2）
    if (this.deps.takeover?.()?.holdsChannel(row.channelId) === true) {
      await this.reply(message, TAKEOVER_SEND_REJECT_TEXT);
      return true;
    }
    let target = row;
    if (row.state === "ended" && !this.reopenIfListed(row)) {
      // 取り込めるかの判定は一覧を読むので、その間に戻って（revived）open になりうる。読み直して、ended のままのときだけ案内を出す
      const take = await this.takeable(row.channelId);
      const current = store.get(row.channelId);
      if (current?.state === "ended") {
        // owner の行を書いたら（Web UI が有効）その id を保留に持つ（[取り込んで続ける] のターンで二重に書かない。書けなければ 0）
        const ownerRow = this.record(current, "owner", "discord", checked.text, message.id);
        await this.promptResume(message, checked.text, this.deps.history === undefined ? undefined : (ownerRow ?? 0), take);
        this.record(current, "notice", "system", CC_RESUME_PROMPT_TEXT);
        return true;
      }
      if (current?.state === "resuming") {
        await this.reply(message, CC_RESUMING_REPLY);
        return true;
      }
      if (current === undefined) return true;
      target = current;
    }
    if (store.get(target.channelId)?.state !== "open") return true;
    await this.submitOwner(target, checked.text, message.channelId, message.id);
    return true;
  }

  /** オーナーの発言を origin discord で積む（断られたらその発言に返信で理由） */
  private async submitOwner(row: CcChannelRow, text: string, channelId: string, messageId: string): Promise<void> {
    const { log } = this.deps;
    const sender = this.deps.sender();
    if (sender === undefined) {
      await this.replyTo(channelId, messageId, SUBMIT_REJECT_REPLY.stopped);
      return;
    }
    const result = await sender.submit({ sessionId: row.sessionId, text, origin: "discord", channelId: row.channelId, messageId });
    if (!result.ok) {
      log(`Claude Code: チャンネルの発言を積みませんでした（${result.reason}）`);
      await this.replyTo(channelId, messageId, SUBMIT_REJECT_REPLY[result.reason]);
      return;
    }
    if (!result.duplicate) {
      log(`Claude Code: チャンネルの発言を積みました（#${result.send.id}）`);
      this.record(row, "owner", "discord", text, messageId);
    }
    // 5 秒以内の同じ本文（二重送信の規則）: 新しくは積まず、この発言にも前の行の印を付ける（無反応にしない）
    else this.markDuplicate(result.send, channelId, messageId);
  }

  /**
   * ended のチャンネルのセッションが今の一覧にあれば（/cc close で閉じただけ）、関わったとして開き直す（§3.6・§3.8）。開き直したら true
   */
  private reopenIfListed(row: CcChannelRow): boolean {
    return row.state === "ended" && this.listed(row.sessionId) && this.revived({ sessionId: row.sessionId }, "reopened");
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

  /**
   * /cc close（チャンネルの中で。§3.8）: open のチャンネルを ended にして完了へ移す（セッションが生きていても閉じる）。
   * cc のチャンネルでなければ not_channel、open でなければその状態
   */
  close(channelId: string, options: { fromWeb?: boolean } = {}): CcCloseResult {
    const row = this.deps.store.get(channelId);
    if (row === undefined || row.state === "deleted") return { result: "not_channel" };
    if (this.deps.takeover?.()?.holdsChannel(channelId) === true) return { result: "taking_over" };
    if (row.state !== "open") return { result: row.state };
    if (!this.deps.store.setState(channelId, "ended", ["open"])) {
      return { result: this.deps.store.get(channelId)?.state === "resuming" ? "resuming" : "ended" };
    }
    this.deps.log(`Claude Code: ${options.fromWeb === true ? "Web から" : "/cc close で"}チャンネルを閉じました（guild=${row.guildId}）`);
    this.deps.channelOps.enqueueMove(channelId, { kind: "state", guildId: row.guildId, state: "done" });
    // 閉じたチャンネルの届け待ちは取り消す（⏳ は sender の settled で外れる）
    const cancelled = this.cancelQueued(channelId) ?? 0;
    // Web の会話には /cc close の応答と同じ文（取り消した件数の行を含む）
    this.record(row, "notice", "system", ccClosedText(cancelled));
    return { result: "closed", cancelled };
  }

  /** Web から閉じた（POST /api/cc/channels/<id>/close。CC14）: /cc close の応答と同じ文をチャンネルに投稿する（失敗は log だけ） */
  postClosed(channelId: string, text: string): void {
    const row = this.deps.store.get(channelId);
    if (row !== undefined && row.state !== "deleted") this.post(row, text);
  }

  /**
   * Web の会話の入力欄からの送信（POST /api/channels/<id>/messages の cc。§5.2）: /api/cc/sessions/<id>/send と同じ sender.submit（origin web）で積む
   * （写し「（Web から）」・owner の行・印は announce が付ける）。open のチャンネルだけで、ended はセッションが一覧にあれば開き直して積み、
   * 無ければ積まない。resuming は積まない
   */
  async submitWeb(channelId: string, text: string): Promise<CcSubmitWebResult> {
    const row = this.deps.store.get(channelId);
    if (row === undefined || row.state === "deleted") return { ok: false, reason: "not_channel" };
    const checked = normalizeSendText(text);
    if (!checked.ok) return { ok: false, reason: checked.reason };
    if (this.deps.takeover?.()?.holdsChannel(channelId) === true) return { ok: false, reason: "taking_over" };
    // 閉じただけ（セッションが一覧にある）なら Discord の発言と同じく開き直して届ける。一覧に無ければ ended（Discord で [起動して続ける]）
    if (row.state === "ended") this.reopenIfListed(row);
    const state = this.deps.store.get(channelId)?.state ?? "deleted";
    if (state === "deleted") return { ok: false, reason: "not_channel" };
    if (state !== "open") return { ok: false, reason: state };
    const sender = this.deps.sender();
    if (sender === undefined) return { ok: false, reason: "stopped" };
    const result = await sender.submit({ sessionId: row.sessionId, text: checked.text, origin: "web" });
    if (!result.ok) return result;
    const send = this.deps.sends.get(result.send.id) ?? result.send;
    return { ok: true, sendId: send.id, channelId, messageId: send.channelId === channelId ? send.messageId : null };
  }

  /**
   * [起動して続ける]（cc:resume。§3.6）: その発言を保留していて、チャンネルを ended → resuming に移せたときだけ、そのセッションの cwd で起動する。
   * 保留が無ければ expired、押したサーバーが違う・移せなければ stale（二重起動を防ぐ）。セッションが一覧にある（/cc close で閉じただけ）なら
   * 起動せずに開き直してその発言を積む。直下でない cwd・起動の失敗は ended に戻す。結果は確認の投稿の書き換え
   */
  async resume(channelId: string, messageId: string, guildId: string | null): Promise<CcResumeResult> {
    const { store, cfg, log } = this.deps;
    // 取り込みの途中は何も変えない（保留とボタンは残す）
    if (this.deps.takeover?.()?.holdsChannel(channelId) === true) {
      return { ok: false, reason: "taking_over", message: { text: TAKEOVER_BUSY_TEXT, components: ccResumeButtons(channelId, messageId) } };
    }
    const key = `${channelId}:${messageId}`;
    const pending = this.resumePending.get(key);
    if (pending === undefined) return { ok: false, reason: "expired" };
    const current = store.get(channelId);
    if (current === undefined || current.guildId !== guildId || current.state !== "ended") return { ok: false, reason: "stale" };
    if (this.reopenIfListed(current)) {
      this.resumePending.delete(key);
      await this.submitOwner(current, pending.text, channelId, messageId);
      return { ok: true, message: { text: CC_CHANNEL_REOPENED_TEXT, components: [] } };
    }
    if (!store.setState(channelId, "resuming", ["ended"])) return { ok: false, reason: "stale" };
    const row = current;
    const back = (reason: CcResumeFailure, text: string, retry: boolean): CcResumeResult => {
      store.setState(channelId, "ended", ["resuming"]);
      log(`Claude Code: [起動して続ける] で起動できませんでした（${reason}、guild=${row.guildId}）`);
      return { ok: false, reason, message: { text, components: retry ? ccResumeButtons(channelId, messageId) : [] } };
    };
    const session = this.deps.sessions?.get(row.sessionId);
    const project = resumeProject(session?.cwd ?? row.cwd, cfg.workspaceDir);
    if (project === undefined) return back("bad_place", CC_RESUME_BAD_PLACE_TEXT, false);
    const starter = this.deps.starter?.();
    if (starter === undefined) return back("stopped", SUBMIT_REJECT_REPLY.stopped, true);
    const title = normalizeTitle(session?.name ?? "") ?? normalizeTitle(project) ?? "claude";
    let tmuxSession: string | undefined;
    let sendFailed = false;
    let result: CcStartResult;
    try {
      result = await starter.launch({
      project,
      title,
      text: pending.text,
      // cc_sessions.started_by の CHECK に discord が無いので tool で代える（§3.6）
      startedBy: "tool",
      // 最初の指示の送信の頼んだチャンネルをこのチャンネルにする（印と返事の返信先。追いかけにはしない）
      channelId,
      guildId: row.guildId,
      resumeChannelId: channelId,
      onTrustPending: () => {
        if (tmuxSession === undefined) return;
        this.editPrompt(channelId, pending.promptMessageId, { text: `${ccStartedTexts(tmuxSession, true)[0]!}${sendFailed ? CC_START_SEND_FAILED_NOTE : ""}`, components: [] });
      },
      onGaveUp: () => {
        if (!store.setState(channelId, "ended", ["resuming"])) return;
        log(`Claude Code: [起動して続ける] のセッションを結びつけられなかったため、チャンネルを終わったままにしました（guild=${row.guildId}）`);
        this.editPrompt(channelId, pending.promptMessageId, {
          text: `${CC_RESUME_GAVE_UP_TEXT}${CC_START_RETRY_NOTE}`,
          components: ccResumeButtons(channelId, messageId),
        });
      },
      });
    } catch (error) {
      log(`Claude Code: [起動して続ける] の起動が例外で終わりました（${errorKind(error)}）`);
      return back("failed", `${CC_START_THREW}${CC_START_RETRY_NOTE}`, true);
    }
    if (!result.ok) return back(result.reason, `起動できませんでした（${START_FAILURE_TEXT[result.reason]}）${CC_START_RETRY_NOTE}`, true);
    tmuxSession = result.tmuxSession;
    // 最初の指示（この発言の本文）を積めなかった（#315）: ⏳ は付けず、その旨を返す
    sendFailed = result.sendFailed === true;
    log(`Claude Code: [起動して続ける] で起動しました（guild=${row.guildId}${result.sendId === undefined ? "" : `、最初の指示 #${result.sendId}`}）`);
    // 最初の指示の印と返事は、その発言に付ける
    if (result.sendId !== undefined) {
      this.deps.sends.setMessageId(result.sendId, messageId);
      const send = this.deps.sends.get(result.sendId);
      if (send !== undefined) this.mark(send);
    }
    return { ok: true, message: { text: `${ccStartedTexts(result.tmuxSession, false)[0]!}${sendFailed ? CC_START_SEND_FAILED_NOTE : ""}`, components: [] } };
  }

  /** [やめる]（cc:resume:keep）: その発言の保留を捨てる。保留が無ければ false（古い） */
  keepEnded(channelId: string, messageId: string): boolean {
    return this.resumePending.delete(`${channelId}:${messageId}`);
  }

  /**
   * [取り込んで続ける]（cc:take:resume。T4）: その発言の保留（[起動して続ける] と同じ鍵）を引いて消す。無ければ gone。
   * [起動して続ける] の起動の途中（resuming）は引かずに resuming（その発言は起動の最初の指示に使っている。失敗のやり直しにも残す）、
   * ほかの ended でない状態（開き直した後など）は引かずに gone
   */
  takePending(channelId: string, messageId: string): { ok: true; held: HeldMessage } | { ok: false; reason: "resuming" | "gone" } {
    const state = this.deps.store.get(channelId)?.state;
    if (state === "resuming") return { ok: false, reason: "resuming" };
    if (state !== "ended") return { ok: false, reason: "gone" };
    const key = `${channelId}:${messageId}`;
    const pending = this.resumePending.get(key);
    if (pending === undefined) return { ok: false, reason: "gone" };
    this.resumePending.delete(key);
    return { ok: true, held: pending };
  }

  /** そのチャンネルの取り込みが配線されていて、断られないか（[取り込んで続ける] を出すか。判定が投げたら出さない） */
  private async takeable(channelId: string): Promise<boolean> {
    const guard = this.deps.takeover?.();
    if (guard?.refusal === undefined) return false;
    try {
      return (await guard.refusal(channelId)) === undefined;
    } catch (error) {
      this.deps.log(`Claude Code: 取り込めるかを確かめられませんでした（${errorKind(error)}）`);
      return false;
    }
  }

  /** そのセッションが今の一覧にあるか */
  private listed(sessionId: string): boolean {
    return this.deps.registry.snapshot().sessions.some((view) => view.sessionId === sessionId);
  }

  /** 終わったチャンネルの発言に [起動して続ける][やめる]（取り込めれば [取り込んで続ける] も）を返信し、本文を保留する（積まない） */
  private async promptResume(message: IncomingMessage, text: string, historyId: number | undefined, take: boolean): Promise<void> {
    try {
      const promptMessageId = await this.deps.gateway.sendMessage(message.channelId, {
        text: CC_RESUME_PROMPT_TEXT,
        replyToId: message.id,
        suppressEmbeds: true,
        components: ccResumeButtons(message.channelId, message.id, take),
      });
      this.resumePending.set(`${message.channelId}:${message.id}`, { text, promptMessageId, ...(historyId === undefined ? {} : { historyId }) });
      // 古いものから捨てる（Map は足した順）
      while (this.resumePending.size > RESUME_PENDING_MAX) {
        const oldest = this.resumePending.keys().next().value;
        if (oldest === undefined) break;
        this.resumePending.delete(oldest);
      }
    } catch (error) {
      this.deps.log(`Claude Code: 終わったチャンネルの発言に返信できませんでした（${errorKind(error)}）`);
    }
  }

  /**
   * [起動して続ける] で起動したセッションを結びつけた（started の resumeChannelId）: resuming のチャンネルの session_id を付け替えて open に戻し、
   * topic を書き換え、カテゴリ「Claude Code」へ戻して 1 行を出す。resuming でなければ（消された・ended に戻した後）false（通常の起動として扱う）
   */
  private rebound(channelId: string, sessionId: string): boolean {
    const { store, registry, log } = this.deps;
    const row = store.get(channelId);
    if (row === undefined || row.state !== "resuming") return false;
    // 新しいセッションに別のチャンネルが既にあれば付け替えない（一意の索引）
    if (store.anyFor(sessionId) !== undefined || !store.rebind(channelId, sessionId) || !store.setState(channelId, "open", ["resuming"])) {
      store.setState(channelId, "ended", ["resuming"]);
      log(`Claude Code: [起動して続ける] のチャンネルを付け替えられませんでした（guild=${row.guildId}）`);
      return false;
    }
    for (const key of [...this.resumePending.keys()]) if (key.startsWith(`${channelId}:`)) this.resumePending.delete(key);
    const view = registry.snapshot().sessions.find((candidate) => candidate.sessionId === sessionId);
    const name = view?.name ?? null;
    const dir = cwdLabel(view?.cwd ?? row.cwd ?? undefined, this.deps.cfg.workspaceDir, this.deps.home);
    log(`Claude Code: [起動して続ける] のセッションにチャンネルを付け替えました（guild=${row.guildId}）`);
    const updated = store.get(channelId) ?? row;
    this.track(async () => {
      try {
        await this.deps.gateway.setChannelTopic(channelId, ccChannelTopic(name, dir));
      } catch (error) {
        log(`Claude Code: チャンネルの topic を書き換えられませんでした（${errorKind(error)}）`);
      }
    });
    this.moveToCategory(updated);
    this.post(updated, ccResumedText(name ?? dir ?? "（名前なし）"));
    this.record(updated, "divider", "system", ccResumedDivider(name ?? dir ?? "（名前なし）"));
    return true;
  }

  /** 確認の投稿を書き換える（失敗は log だけ） */
  private editPrompt(channelId: string, messageId: string, message: OutgoingMessage): void {
    this.track(async () => {
      try {
        await this.deps.gateway.editMessage(channelId, messageId, message);
      } catch (error) {
        this.deps.log(`Claude Code: [起動して続ける] の確認を書き換えられませんでした（${errorKind(error)}）`);
      }
    });
  }

  /** 待てる非同期の処理（idle で待つ） */
  private track(fn: () => Promise<void>): void {
    const task = fn();
    this.inFlight.add(task);
    void task.finally(() => this.inFlight.delete(task));
  }

  /** 頼んだチャンネルのサーバー（許可サーバーのときだけ） */
  private guildOfChannel(channelId: string | null): string | undefined {
    if (channelId === null || this.deps.guildOf === undefined) return undefined;
    return this.allowedGuild(this.deps.guildOf(channelId));
  }

  /** 許可サーバーならそれ */
  private allowedGuild(guildId: string | undefined): string | undefined {
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
      // 本文の masked link は崩す（返事と同じ。写しの本文でリンクを偽らせない）
      for (const text of ccMirrorTexts(ccMirrorLabel(row.origin, row.channelId), breakMaskedLinks(row.text))) {
        const id = await this.deps.gateway.sendMessage(channel.channelId, { text, suppressEmbeds: true });
        messageId ??= id;
      }
      log(`Claude Code: 写しを出しました（#${row.id}）`);
    } catch (error) {
      log(`Claude Code: 写しを出せませんでした（#${row.id}、${errorKind(error)}）`);
    }
    // Web の会話の owner の行（写しの投稿に失敗しても書く。Web の送信は source web、それ以外は出所を見出しで）
    this.record(
      channel,
      "owner",
      row.origin === "web" ? "web" : "system",
      row.origin === "web" ? row.text : `${ccMirrorLabel(row.origin, null)}\n${row.text}`,
      messageId ?? null,
    );
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
    /** Web の会話の知らせ（届かなかったもの。終わりの印と同じく 1 回だけ） */
    let notice: string | undefined;
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
        notice = CC_UNCONFIRMED_REPLY;
        break;
      case "failed":
        steps = [remove(), add(CC_MARK_FAILED), reply(ccFailedReply(row.lastPaneState))];
        notice = ccFailedReply(row.lastPaneState);
        break;
      case "gave_up":
        steps = [remove(), add(CC_MARK_FAILED), reply(CC_GAVE_UP_REPLY)];
        notice = CC_GAVE_UP_REPLY;
        break;
      case "cancelled":
        steps = [remove()];
        break;
      default:
        return;
    }
    if (row.state !== "queued" && row.state !== "delivering") {
      if (this.finalMarked.has(row.id)) {
        // unconfirmed の後に届いたと分かった（UserPromptSubmit）: ⚠️ を外して ✅（返信・Web の知らせは足さない）
        const marked = this.unconfirmedMarked.get(row.id);
        if (row.state !== "delivered" || marked === undefined) return;
        this.unconfirmedMarked.delete(row.id);
        for (const at of marked) {
          this.chain(row.id, () => gateway.removeOwnReaction(at.channelId, at.messageId, CC_MARK_UNCONFIRMED));
          this.chain(row.id, () => gateway.addReaction(at.channelId, at.messageId, CC_MARK_DELIVERED));
        }
        return;
      }
      this.finalMarked.add(row.id);
      const extras = this.duplicates.get(row.id) ?? [];
      if (row.state === "unconfirmed") this.unconfirmedMarked.set(row.id, [target, ...extras]);
      // 同じ本文を続けて書いた発言にも同じ終わりの印（返信は最初の発言だけ）
      for (const extra of extras) for (const step of this.markSteps(extra, row.state)) this.chain(row.id, step);
      this.duplicates.delete(row.id);
      if (notice !== undefined) this.recordAt(channelId, "notice", notice);
    }
    for (const step of steps) this.chain(row.id, step);
  }

  /** 印だけの手順（返信は付けない）。終わりの状態なら ⏳ を外してその印、それ以外は ⏳ */
  private markSteps(target: { channelId: string; messageId: string }, state: CcSendRow["state"]): Array<() => Promise<void>> {
    const { gateway } = this.deps;
    const { channelId, messageId } = target;
    const final = FINAL_MARK[state];
    if (final === undefined) return [() => gateway.addReaction(channelId, messageId, CC_MARK_WAITING)];
    return [() => gateway.removeOwnReaction(channelId, messageId, CC_MARK_WAITING), ...(final === "" ? [] : [() => gateway.addReaction(channelId, messageId, final)])];
  }

  /** 二重送信の規則で積まなかった発言に、前の行の今の状態の印を付ける（まだ終わっていなければ終わったときにも付ける） */
  private markDuplicate(row: CcSendRow, channelId: string, messageId: string): void {
    const target = { channelId, messageId };
    const done = this.finalMarked.has(row.id) || FINAL_MARK[row.state] !== undefined;
    if (!done) {
      const list = this.duplicates.get(row.id) ?? [];
      list.push(target);
      this.duplicates.set(row.id, list);
    }
    for (const step of this.markSteps(target, row.state)) this.chain(row.id, step);
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
    await this.replyTo(message.channelId, message.id, text);
  }

  private async replyTo(channelId: string, messageId: string, text: string): Promise<void> {
    try {
      await this.deps.gateway.sendMessage(channelId, { text, replyToId: messageId, suppressEmbeds: true });
    } catch (error) {
      this.deps.log(`Claude Code: チャンネルの発言に返信できませんでした（${errorKind(error)}）`);
    }
  }

  /**
   * セッションが一覧から消えた（registry の ended）: open のチャンネルを ended にして 1 行を出し、完了カテゴリへ移す。
   * 既に ended（閉じた）のチャンネルなら、状態とカテゴリは変えずに 1 行だけ出して引き受ける（#system には出さない）。
   * 削除されていないチャンネルが無ければ false
   */
  ended(session: Pick<CcSessionRow, "sessionId">): boolean {
    const row = this.deps.store.anyFor(session.sessionId);
    if (row === undefined) return false;
    if (row.state === "ended") {
      this.deps.log(`Claude Code: 閉じたチャンネルのセッションが終わりました（guild=${row.guildId}）`);
      this.post(row, CC_CHANNEL_ENDED_TEXT);
      this.record(row, "notice", "system", CC_CHANNEL_ENDED_TEXT);
      return true;
    }
    if (!this.deps.store.setState(row.channelId, "ended", ["open"])) return false;
    this.deps.log(`Claude Code: セッションが終わったため、チャンネルを完了に移します（guild=${row.guildId}）`);
    this.post(row, CC_CHANNEL_ENDED_TEXT);
    this.record(row, "notice", "system", CC_CHANNEL_ENDED_TEXT);
    this.deps.channelOps.enqueueMove(row.channelId, { kind: "state", guildId: row.guildId, state: "done" });
    return true;
  }

  /**
   * 同じ session_id が一覧に戻った（registry の revived）: その session_id の ended のチャンネルを open に戻して 1 行を出し、
   * カテゴリ「Claude Code」へ戻す（付け替えの前の id（previous_session_id）では開き直さない）。開き直さなければ false
   */
  revived(session: Pick<CcSessionRow, "sessionId">, reason: CcReviveReason = "back"): boolean {
    // 取り込みの途中は開き直さない（reopenIfListed も通る）
    if (this.deps.takeover?.()?.holds(session.sessionId) === true) return false;
    const row = this.deps.store.anyFor(session.sessionId);
    if (row === undefined || row.state !== "ended" || !this.deps.store.setState(row.channelId, "open", ["ended"])) return false;
    this.deps.log(
      reason === "back"
        ? `Claude Code: セッションが戻ったため、チャンネルを開き直します（guild=${row.guildId}）`
        : `Claude Code: 閉じたチャンネルのセッションに関わったため、開き直します（guild=${row.guildId}）`,
    );
    this.post(row, reason === "back" ? CC_CHANNEL_REVIVED_TEXT : CC_CHANNEL_REOPENED_TEXT);
    this.record(row, "notice", "system", reason === "back" ? CC_CHANNEL_REVIVED_TEXT : CC_CHANNEL_REOPENED_TEXT);
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
      this.reopenIfListed(existing);
      return { ok: false, reason: "exists", channelId: existing.channelId, guildId: existing.guildId };
    }
    const sessions = registry.snapshot().sessions;
    const view = sessions.find((candidate) => candidate.sessionId === sessionId);
    if (view === undefined) return { ok: false, reason: "not_found" };
    // 知らせのきっかけでは tmux の外でも作る（発言は sender が断る。最初の投稿にその旨の 1 行）
    const inTmux = await this.inTmux(view, sessions);
    if (!inTmux && !NOTICE_ORIGINS.has(origin)) return { ok: false, reason: "not_in_tmux" };
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
    // 上の await の間に別のサーバー（キューは別）で同じセッションのチャンネルが作られていれば作らない
    const raced = store.anyFor(sessionId);
    if (raced !== undefined) {
      this.reopenIfListed(raced);
      return { ok: false, reason: "exists", channelId: raced.channelId, guildId: raced.guildId };
    }
    const channelId = await gateway.createTextChannel(guildId, { name: channelName, parentId: categoryId, topic: ccChannelTopic(name, dir) });
    try {
      store.create({ channelId, guildId, sessionId, name: channelName, cwd, origin });
    } catch (error) {
      // 記録できなかった（一意の索引など）チャンネルは孤児にしないよう消す。消せなければ手で消せるよう ID を出す（log 方針の例外。セッションのチャンネルと同じ）
      try {
        await gateway.deleteChannel(channelId);
        log(`Claude Code: チャンネルを作りましたが記録に失敗したため消しました（guild=${guildId}）: ${errorKind(error)}`);
      } catch (deleteError) {
        log(
          `Claude Code: チャンネルを作りましたが記録に失敗しました（guild=${guildId}、channel=${channelId}）: ${errorKind(error)}（消せませんでした: ${errorKind(deleteError)}）`,
        );
      }
      return { ok: false, reason: "failed" };
    }
    log(`Claude Code: チャンネルを作りました（guild=${guildId}、${origin}）`);
    try {
      await gateway.sendMessage(channelId, { text: ccChannelIntro(name, dir, origin, inTmux), suppressEmbeds: true });
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

  /** Web の会話に 1 行（CC14。history を渡したときだけ。書けなくても log だけで止めない） */
  private record(
    row: Pick<CcChannelRow, "guildId" | "channelId">,
    kind: HistoryKind,
    source: HistorySource,
    text: string,
    messageId: string | null = null,
  ): number | undefined {
    return recordHistory(
      this.deps.history,
      { guildId: row.guildId, channelId: row.channelId, kind, source, persona: DEFAULT_PERSONA_ID, text, messageId },
      this.deps.log,
    );
  }

  /** そのチャンネル（削除されていない cc のチャンネルのときだけ）の Web の会話に知らせを 1 行 */
  private recordAt(channelId: string, kind: "notice", text: string): void {
    const row = this.deps.store.get(channelId);
    if (row === undefined || row.state === "deleted") return;
    this.record(row, kind, "system", text);
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

  /** 作れなかった理由を log に 1 行（同じ理由は CC_CHANNEL_FAILURE_LOG_MS に 1 回）。failed は openChannel が種類付きで毎回出している */
  private logFailure(reason: CcChannelFailure, notice: boolean): void {
    if (reason === "failed") return;
    const key = `${notice ? "notice" : "touch"}:${reason}`;
    const now = this.deps.now().getTime();
    const last = this.failureLoggedAt.get(key);
    if (last !== undefined && now - last < CC_CHANNEL_FAILURE_LOG_MS) return;
    this.failureLoggedAt.set(key, now);
    this.deps.log(`Claude Code: ${notice ? "知らせの" : ""}チャンネルを作れませんでした（${reason}）`);
  }
}

/** ccEndedHandler・ccReplayEnded が呼ぶ 2 つ */
type CcEndedTargets = {
  channels: () => Pick<CcChannels, "ended"> | undefined;
  replier: () => { ended(session: CcSessionRow): boolean } | undefined;
};

/**
 * 終わったことを流す（channels.ended と replier.ended）。取り込みが差し止めた ended を流し直す口（docs/plan/takeover.md §3.2。CcTakeover の replayEnded）。
 * 届けたら true。channels・replier のどちらかがまだ無ければ、どちらも呼ばずに false（差し止めの印を残して後で流す）
 */
export function ccReplayEnded(deps: CcEndedTargets): (session: CcSessionRow) => boolean {
  return (session) => {
    const channels = deps.channels();
    const replier = deps.replier();
    if (channels === undefined || replier === undefined) return false;
    channels.ended(session);
    replier.ended(session);
    return true;
  };
}

/**
 * registry の ended に渡す関数（main の配線。§3.6）: チャンネルがあれば ended にして終わったことを 1 行出し完了へ移し、返事の追いかけ（replier）は
 * 今までどおり止める。チャンネルが無ければ終了は知らせない（#system には出さない。docs/plan/claude-code-questions.md §5.1）。
 * takeover を渡したとき、そのセッションに running の取り込みがあれば（intercept が true）どちらも呼ばない（差し止め。docs/plan/takeover.md §3.2）
 */
export function ccEndedHandler(
  deps: CcEndedTargets & { takeover?: () => { intercept(session: CcSessionRow): boolean } | undefined },
): (session: CcSessionRow) => void {
  return (session) => {
    if (deps.takeover?.()?.intercept(session) === true) return;
    // 普段の ended は今までどおり、あるものに渡す
    deps.channels()?.ended(session);
    deps.replier()?.ended(session);
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

/**
 * 許可の要求に答えた後（Web・Discord。main の配線。§3.1 の 3）: その要求のセッションのチャンネルを origin permission（質問の行は question）で作る
 * （guildId は Discord で押したサーバー。省けば最初の /setup 済みのサーバー）。待たない・投げない
 */
export function ccPermissionAnsweredHandler(deps: {
  permissions: Pick<CcPermissionStore, "get">;
  channels: () => Pick<CcChannels, "ensureFor"> | undefined;
  log: (message: string) => void;
}): (id: number, guildId: string | undefined) => void {
  return (id, guildId) => {
    const row = deps.permissions.get(id);
    const channels = deps.channels();
    // プロジェクトのセッションの要求（origin sdk）はセッションのチャンネルで答えたもので、Claude Code のチャンネルは作らない
    if (row === undefined || row.origin === "sdk" || channels === undefined) return;
    const origin = row.questionInput !== null ? "question" : "permission";
    void channels.ensureFor(row.sessionId, origin, guildId).catch((error: unknown) => {
      deps.log(`Claude Code: 許可の応答の後にチャンネルを用意できませんでした（${errorKind(error)}）`);
    });
  };
}
