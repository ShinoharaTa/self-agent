// SDK のツール cc_send・cc_start の確認（docs/plan/claude-code-sessions.md §5.3・§7 の 6。CC7）。ツールが頼んだチャンネルに本文の全文（1 通
// CC_CONFIRM_PAGE_CHARS 字ずつ CC_CONFIRM_MAX_PAGES 通まで。見せていない部分は送らない）と、最後の 1 通に [送る][やめる]（`cc:send:<id>`・`cc:keep:send:<id>`）/ [起動する][やめる]（`cc:start:<id>`・`cc:keep:start:<id>`）を投稿し、オーナーが押したときだけ
// 送る（cc_sends を queued にして cc/sender.ts の待ち行列へ）・起動する（cc/starter.ts の launch）。確認は CC_CONFIRM_TTL_MS で失効し、
// [やめる] と同じく cancelled にしてボタンを外す（書き換えるのはボタンの付いた最後の 1 通だけ。CcConfirmExpirer が CC_CONFIRM_SWEEP_MS ごとに確かめる。押したときにも確かめる）。
// 名前空間 `cc:` は許可のボタン（`cc:perm:*`。CC5c）と共有し、custom_id の振り分けは commands/cc.ts の createCcComponent がまとめて行う。log は番号と結果の種類だけ（本文・名前・ディレクトリ・ペイン・チャンネル ID は出さない）
import { homedir } from "node:os";
import type { CcPaneResolver } from "../../cc/panes.ts";
import type { CcRegistry, CcTimers } from "../../cc/registry.ts";
import type { CcSender } from "../../cc/sender.ts";
import type { CcStartFailure, CcStarter } from "../../cc/starter.ts";
import type { Config } from "../../config.ts";
import { escapeDiscordText } from "../../discord/escape.ts";
import type { Gateway, OutgoingMessage } from "../../discord/gateway.ts";
import type { CcSendRow, CcSendStore } from "../../store/cc-sends.ts";
import type { CcSessionStore } from "../../store/cc-sessions.ts";
import type { CcStartRow, CcStartStore } from "../../store/cc-starts.ts";
import { paneLabel } from "../../tmux/workspace-map.ts";
import { CC_RC_URL_PREFIX, cwdLabel } from "../../web/routes/cc.ts";
import type { ComponentHandler } from "../interactions.ts";
import { STALE_TEXT } from "./delete.ts";

/** ボタンの custom_id の名前空間（`cc:<action>:…`。許可のボタン `cc:perm:*` と共有する） */
export const CC_NAMESPACE = "cc";
/** 確認の有効な長さ（§5.3。過ぎたら [やめる] と同じく取り消す） */
export const CC_CONFIRM_TTL_MS = 10 * 60_000;
/** 失効を確かめる間隔 */
export const CC_CONFIRM_SWEEP_MS = 60_000;
/** 確認の 1 通のコードブロックの中身の上限（``` を崩した後の字数。コードポイント。§5.3） */
export const CC_CONFIRM_PAGE_CHARS = 1800;
/** 確認の投稿の数の上限（本文 4,000 字が収まる。§5.3） */
export const CC_CONFIRM_MAX_PAGES = 3;
/** Discord の 1 メッセージの上限 */
const MESSAGE_MAX = 2000;
/** 見出しに出す名前・ディレクトリの長さ（コードポイント。超えたら … で切る。1 通目の見出しが 2,000 字から本文の分を引いた長さに収まるように） */
const NAME_MAX = 30;
const DIR_MAX = 40;

/** [やめる]・失効で取り消したときの一言 */
export const CC_SEND_CANCELLED = "送りませんでした";
export const CC_START_CANCELLED = "起動しませんでした";
/** SELF_AGENT_CC が無効なときに押された・残っていたら添える */
export const CC_DISABLED_NOTE = "（Claude Code の連携が無効です）";
/** [起動する] が一時的な理由で失敗したときに添える（確認待ちに戻してボタンを残す） */
export const CC_START_RETRY_NOTE = "。少し待ってもう一度押してください";

/** [起動する] が失敗しても確認待ちに戻す（時間が経てば通りうる）理由 */
const START_RETRY_REASONS: readonly CcStartFailure[] = ["too_soon", "limit", "low_memory", "no_server"];

/** 起動を断った理由の文（確認の書き換え） */
const START_FAILURE_TEXT: Readonly<Record<CcStartFailure, string>> = {
  invalid_project: "ディレクトリがありません",
  invalid_title: "題名が正しくありません",
  invalid_mode: "権限モードが正しくありません",
  empty: "最初の指示が空です",
  too_long: "最初の指示が長すぎます",
  invalid_text: "最初の指示に使えない文字があります",
  limit: "セッションの数が上限です",
  low_memory: "メモリが足りません",
  too_soon: "前の起動から 1 分経っていません",
  not_ready: "セッションの一覧をまだ読めていません",
  no_server: "tmux のサーバーがありません",
  tmux_failed: "tmux を使えませんでした",
  stopped: "停止中です",
};

function chars(text: string): string[] {
  return [...text];
}

function length(text: string): number {
  return chars(text).length;
}

/** 1 行にして max 字で切り、Markdown・メンションを無効にする */
function inline(text: string, max: number): string {
  const flat = chars(text.replace(/\s+/g, " ").trim());
  const cut = flat.length <= max ? flat.join("") : `${flat.slice(0, max - 1).join("")}…`;
  return escapeDiscordText(cut);
}

/** RC のリンク（一覧の rc_url と確認の書き換えで共通） */
export function ccRcUrl(bridgeSessionId: string): string {
  return `${CC_RC_URL_PREFIX}${encodeURIComponent(bridgeSessionId)}`;
}

/**
 * 本文をコードブロックの中身に分ける（純関数）。``` にならないよう 2 つ続いた ` の後の ` の前にゼロ幅の空白を挟み、崩した後の字数で
 * 1 つ CC_CONFIRM_PAGE_CHARS 字までにする（文字の途中・崩しの途中では切らない）。本文はすべてどれかに入る（省かない）
 */
export function splitConfirmBody(text: string): string[] {
  const pages: string[] = [];
  let page = "";
  let pageLength = 0;
  for (const char of chars(text)) {
    let piece = char === "`" && page.endsWith("``") ? "\u200b`" : char;
    if (pageLength + length(piece) > CC_CONFIRM_PAGE_CHARS) {
      pages.push(page);
      page = "";
      pageLength = 0;
      piece = char;
    }
    page += piece;
    pageLength += length(piece);
  }
  if (page !== "" || pages.length === 0) pages.push(page);
  return pages;
}

/** 本文が CC_CONFIRM_MAX_PAGES 通の確認に収まるか（収まらなければ確認を出さない＝送らない） */
export function fitsConfirm(text: string): boolean {
  return splitConfirmBody(text).length <= CC_CONFIRM_MAX_PAGES;
}

function block(body: string): string {
  return `\`\`\`\n${body}\n\`\`\``;
}

/**
 * 確認の各通の本文（純関数）。1 通目は見出し + 本文の 1 つ目、2 通目からは「（続き i/n）」+ 本文の続き。body が null なら見出しだけの 1 通。
 * 最後の通の最初の行を result の候補（長い順）のうち 2,000 字に収まる最初のものに置き換える（無ければ置き換えない）
 */
function pageTexts(head: string[], body: string | null, result?: readonly string[]): string[] {
  const parts = body === null ? [] : splitConfirmBody(body);
  const total = Math.max(1, parts.length);
  const texts = Array.from({ length: total }, (_, i) => {
    const lines = i === 0 ? [...head] : [`（続き ${i + 1}/${total}）`];
    if (i === 0 && total > 1) lines.push(`（1/${total}）`);
    return { lines, body: parts[i] };
  });
  const join = (page: { lines: string[]; body: string | undefined }): string =>
    page.body === undefined ? page.lines.join("\n") : `${page.lines.join("\n")}\n${block(page.body)}`;
  const last = texts[total - 1]!;
  if (result !== undefined && result.length > 0) {
    // 1 通なら見出しの 1 行目を結果に、2 通以上なら「（続き n/n）」の前に結果の行を足す
    const candidates = result.map((line) => ({
      lines: total === 1 ? [line, ...last.lines.slice(1)] : [line, ...last.lines],
      body: last.body,
    }));
    texts[total - 1] = candidates.find((page) => length(join(page)) <= MESSAGE_MAX) ?? candidates[candidates.length - 1]!;
  }
  return texts.map(join);
}

/** 送り先の表示（名前と、ディレクトリ名があれば括弧で） */
export type CcSendTarget = { name: string | null; dir: string | null };

function targetLabel(target: CcSendTarget): string {
  const name = target.name === null || target.name.trim() === "" ? "（名前なし）" : inline(target.name, NAME_MAX);
  return target.dir === null || target.dir === "" ? name : `${name}（${inline(target.dir, DIR_MAX)}）`;
}

function buttons(confirmId: string, confirmLabel: string, keepId: string): OutgoingMessage["components"] {
  return [
    {
      kind: "buttons",
      buttons: [
        { customId: confirmId, label: confirmLabel, style: "primary" },
        { customId: keepId, label: "やめる" },
      ],
    },
  ];
}

/** 投稿する各通。ボタンは最後の 1 通だけ */
function withButtons(texts: string[], components: OutgoingMessage["components"]): OutgoingMessage[] {
  return texts.map((text, i) => (i === texts.length - 1 ? { text, components } : { text }));
}

/** cc_send の確認のボタン（[送る][やめる]） */
export function ccSendButtons(id: number): OutgoingMessage["components"] {
  return buttons(`${CC_NAMESPACE}:send:${id}`, "送る", `${CC_NAMESPACE}:keep:send:${id}`);
}

/** cc_start の確認のボタン（[起動する][やめる]） */
export function ccStartButtons(id: number): OutgoingMessage["components"] {
  return buttons(`${CC_NAMESPACE}:start:${id}`, "起動する", `${CC_NAMESPACE}:keep:start:${id}`);
}

/**
 * cc_send の確認（§5.3）: 「Claude Code の <名前>（<ディレクトリ名>）に送りますか？」+ 本文の全文（1 通 CC_CONFIRM_PAGE_CHARS 字ずつ、
 * CC_CONFIRM_MAX_PAGES 通まで）。[送る][やめる] は最後の 1 通だけ。収まらない本文は呼び出し側が fitsConfirm で先に断る
 */
export function ccSendPrompt(id: number, target: CcSendTarget, text: string): OutgoingMessage[] {
  return withButtons(pageTexts([`Claude Code の ${targetLabel(target)}に送りますか？`], text), ccSendButtons(id));
}

/** cc_send の確認の最後の 1 通を押した後・失効した後に書き換える本文。results は結果の候補（長い順。2,000 字に収まる最初のものを使う） */
export function ccSendResultText(target: CcSendTarget, text: string, results: readonly string[]): string {
  const texts = pageTexts(
    [`Claude Code の ${targetLabel(target)}に送りますか？`],
    text,
    results.map((result) => `Claude Code の ${targetLabel(target)}に${result}`),
  );
  return texts[texts.length - 1]!;
}

/** cc_start の確認の見出し（題名・プロジェクトは英数字などだけなのでインラインのコードで出す） */
function startHead(row: Pick<CcStartRow, "project" | "title" | "permissionMode" | "text">, first: string): string[] {
  return [
    first,
    `題名: \`${row.title}\``,
    `権限モード: ${row.permissionMode ?? "default"}`,
    row.text === null ? "最初の指示: なし" : "最初の指示:",
  ];
}

function projectLabel(project: string): string {
  return `\`${project}\``;
}

/** cc_start の確認（§5.3）: 「<project> で新しいセッションを起動しますか？」+ 題名・権限モード・最初の指示（全文）。[起動する][やめる] は最後の 1 通だけ */
export function ccStartPrompt(row: Pick<CcStartRow, "id" | "project" | "title" | "permissionMode" | "text">): OutgoingMessage[] {
  const first = `${projectLabel(row.project)} で Claude Code の新しいセッションを起動しますか？`;
  return withButtons(pageTexts(startHead(row, first), row.text), ccStartButtons(row.id));
}

/** cc_start の確認の最後の 1 通を押した後・失効した後に書き換える本文。results は結果の候補（長い順） */
export function ccStartResultText(row: Pick<CcStartRow, "project" | "title" | "permissionMode" | "text">, results: readonly string[]): string {
  const first = `${projectLabel(row.project)} で Claude Code の新しいセッションを起動しますか？`;
  const texts = pageTexts(
    startHead(row, first),
    row.text,
    results.map((result) => `${projectLabel(row.project)} で${result}`),
  );
  return texts[texts.length - 1]!;
}

/** 起動できたときの一言の候補（長い順。trust の確認待ちなら、その旨を添える） */
export function ccStartedTexts(tmuxSession: string, trustPending: boolean): string[] {
  const started = `起動しました（tmux: ${inline(tmuxSession, 40)}）`;
  return trustPending
    ? [`${started}。このフォルダの trust の確認を待っています（端末か RC で答えてください）`, "起動しました。trust の確認を待っています"]
    : [started, "起動しました"];
}

/** 起動の後の送信・起動（SELF_AGENT_CC が無効なら無い） */
export type CcConfirmRuntime = {
  sender: Pick<CcSender, "confirm" | "kick">;
  starter: Pick<CcStarter, "launch">;
  registry: Pick<CcRegistry, "snapshot">;
  panes: Pick<CcPaneResolver, "lookup">;
};

export type CcConfirmDeps = {
  cfg: Pick<Config, "workspaceDir">;
  ccSends: Pick<CcSendStore, "get" | "transition">;
  ccStarts: Pick<CcStartStore, "get" | "transition">;
  ccSessions: Pick<CcSessionStore, "get" | "setChannel">;
  /** 送信・起動（main では後で作るので関数で渡す。SELF_AGENT_CC が無効なら undefined） */
  ccRuntime: () => CcConfirmRuntime | undefined;
  /** 確認を投稿した Bot（チャンネルの持ち主）。起動の後の trust の確認待ちの書き換えに使う */
  ccPosts: Pick<Gateway, "editMessage">;
  /** 既定は new Date */
  now?: () => Date;
  /** ~ の場所（ディレクトリ名の表示。既定は homedir()） */
  home?: string;
  log: (message: string) => void;
};

type Responder = Parameters<ComponentHandler["handle"]>[1];

/** 確認のボタンの処理（custom_id の振り分けは commands/cc.ts の createCcComponent。許可のボタンと同じ名前空間） */
export type CcConfirmButtons = {
  /** [送る]（`cc:send:<id>`） */
  send(id: number, responder: Responder): Promise<void>;
  /** [起動する]（`cc:start:<id>`） */
  start(id: number, responder: Responder): Promise<void>;
  /** [やめる]（`cc:keep:send|start:<id>`） */
  keep(kind: "send" | "start", id: number, responder: Responder): Promise<void>;
};

/** 送信の送り先の表示（cc_sessions の名前と cwd） */
function sendTarget(deps: Pick<CcConfirmDeps, "cfg" | "ccSessions" | "home">, row: CcSendRow): CcSendTarget {
  const session = row.sessionId === null ? undefined : deps.ccSessions.get(row.sessionId);
  return {
    name: session?.name ?? null,
    dir: cwdLabel(session?.cwd ?? undefined, deps.cfg.workspaceDir, deps.home ?? homedir()),
  };
}

function expired(createdAt: string, now: Date): boolean {
  return now.getTime() - Date.parse(createdAt) >= CC_CONFIRM_TTL_MS;
}

/**
 * [送る]・[起動する]・[やめる] のボタン（`cc:send:<id>`・`cc:start:<id>`・`cc:keep:send|start:<id>`）。DB の状態で動くので再起動の後でも押せる。
 * 確認待ちでなければメッセージは変えずに本人にだけ「古くなっています」、失効していれば取り消して「送りませんでした」などに書き換える
 */
export function createCcConfirmButtons(deps: CcConfirmDeps): CcConfirmButtons {
  const { ccSends, ccStarts, ccSessions, ccRuntime, ccPosts, log } = deps;
  const now = deps.now ?? (() => new Date());
  const stale = (responder: Responder): Promise<void> => responder.reply({ text: STALE_TEXT, ephemeral: true });

  const onSend = async (id: number, responder: Responder): Promise<void> => {
    const row = ccSends.get(id);
    if (row === undefined || row.origin !== "tool" || row.state !== "awaiting_confirm") {
      await stale(responder);
      return;
    }
    const target = sendTarget(deps, row);
    const runtime = ccRuntime();
    if (runtime === undefined || expired(row.createdAt, now())) {
      if (!ccSends.transition(id, ["awaiting_confirm"], "cancelled", { lastPaneState: runtime === undefined ? "disabled" : "expired" })) {
        await stale(responder);
        return;
      }
      log(`Claude Code: ${runtime === undefined ? "連携が無効" : "確認の期限が過ぎた"}ため送りませんでした（#${id}）`);
      const note = runtime === undefined ? CC_DISABLED_NOTE : "";
      await responder.update({ text: ccSendResultText(target, row.text, [`${CC_SEND_CANCELLED}${note}`]), components: [] });
      return;
    }
    await responder.deferUpdate();
    if (runtime.sender.confirm(id) !== "queued") {
      await stale(responder);
      return;
    }
    if (row.sessionId !== null && row.channelId !== null) ccSessions.setChannel(row.sessionId, row.channelId);
    // 入力待ちならこの場で届く。待ちなら積んだまま（30 秒ごとに試す）
    await runtime.sender.kick();
    const after = ccSends.get(id);
    let results: string[];
    switch (after?.state) {
      case "delivered":
        results = [`送りました${await location(runtime, row.sessionId)}`, "送りました"];
        break;
      case "queued":
      case "delivering":
        results = ["送ります。入力待ちになったら届けます"];
        break;
      case "unconfirmed":
        results = ["貼りましたが、届いたか確かめられませんでした"];
        break;
      case "cancelled":
        results = [CC_SEND_CANCELLED];
        break;
      default:
        results = ["送れませんでした"];
    }
    await responder.update({ text: ccSendResultText(target, row.text, results), components: [] });
  };

  const onStart = async (id: number, responder: Responder): Promise<void> => {
    const row = ccStarts.get(id);
    if (row === undefined || row.state !== "awaiting_confirm") {
      await stale(responder);
      return;
    }
    const runtime = ccRuntime();
    if (runtime === undefined || expired(row.createdAt, now())) {
      if (!ccStarts.transition(id, ["awaiting_confirm"], "cancelled")) {
        await stale(responder);
        return;
      }
      log(`Claude Code: ${runtime === undefined ? "連携が無効" : "確認の期限が過ぎた"}ため起動しませんでした（#${id}）`);
      const note = runtime === undefined ? CC_DISABLED_NOTE : "";
      await responder.update({ text: ccStartResultText(row, [`${CC_START_CANCELLED}${note}`]), components: [] });
      return;
    }
    await responder.deferUpdate();
    // 先に started にして、二度押し・失効と重ならないようにする（起動できなければ failed に移すか、一時的な理由なら確認待ちに戻す）
    if (!ccStarts.transition(id, ["awaiting_confirm"], "started")) {
      await stale(responder);
      return;
    }
    let tmuxSession: string | undefined;
    const result = await runtime.starter.launch({
      project: row.project,
      title: row.title,
      ...(row.text === null ? {} : { text: row.text }),
      ...(row.permissionMode === null ? {} : { permissionMode: row.permissionMode }),
      startedBy: "tool",
      channelId: row.channelId,
      onTrustPending: () => {
        if (tmuxSession === undefined || row.messageId === null) return;
        void ccPosts
          .editMessage(row.channelId, row.messageId, { text: ccStartResultText(row, ccStartedTexts(tmuxSession, true)), components: [] })
          .catch((error: unknown) => log(`Claude Code: 起動の確認を書き換えられませんでした（#${id}、${errorKind(error)}）`));
      },
    });
    if (!result.ok) {
      const failed = `起動できませんでした（${START_FAILURE_TEXT[result.reason]}）`;
      // 時間が経てば通りうる理由なら確認待ちに戻してボタンを残す（10 分の失効は作った時刻から数えたまま）
      if (START_RETRY_REASONS.includes(result.reason) && ccStarts.transition(id, ["started"], "awaiting_confirm")) {
        log(`Claude Code: 起動できませんでした。確認待ちに戻しました（#${id}、${result.reason}）`);
        await responder.update({ text: ccStartResultText(row, [`${failed}${CC_START_RETRY_NOTE}`]), components: ccStartButtons(id) });
        return;
      }
      ccStarts.transition(id, ["started"], "failed");
      log(`Claude Code: 起動できませんでした（#${id}、${result.reason}）`);
      await responder.update({ text: ccStartResultText(row, [failed]), components: [] });
      return;
    }
    tmuxSession = result.tmuxSession;
    ccStarts.transition(id, ["started"], "started", {
      tmuxSession: result.tmuxSession,
      paneId: result.paneId,
      ...(result.sendId === undefined ? {} : { sendId: result.sendId }),
    });
    await responder.update({ text: ccStartResultText(row, ccStartedTexts(result.tmuxSession, false)), components: [] });
  };

  const onKeep = async (kind: "send" | "start", id: number, responder: Responder): Promise<void> => {
    if (kind === "send") {
      const row = ccSends.get(id);
      if (row === undefined || row.origin !== "tool" || !ccSends.transition(id, ["awaiting_confirm"], "cancelled", { lastPaneState: "kept" })) {
        await stale(responder);
        return;
      }
      log(`Claude Code: [やめる] で送りませんでした（#${id}）`);
      await responder.update({ text: ccSendResultText(sendTarget(deps, row), row.text, [CC_SEND_CANCELLED]), components: [] });
      return;
    }
    if (kind === "start") {
      const row = ccStarts.get(id);
      if (row === undefined || !ccStarts.transition(id, ["awaiting_confirm"], "cancelled")) {
        await stale(responder);
        return;
      }
      log(`Claude Code: [やめる] で起動しませんでした（#${id}）`);
      await responder.update({ text: ccStartResultText(row, [CC_START_CANCELLED]), components: [] });
    }
  };

  return { send: onSend, start: onStart, keep: onKeep };
}

/** 届けた先の表示（「（<tmux のペイン>・RC: <リンク>）」。分からなければ空） */
async function location(runtime: CcConfirmRuntime, sessionId: string | null): Promise<string> {
  if (sessionId === null) return "";
  const { sessions } = runtime.registry.snapshot();
  const view = sessions.find((session) => session.sessionId === sessionId);
  if (view === undefined) return "";
  const parts: string[] = [];
  try {
    const lookup = await runtime.panes.lookup(new Set(sessions.map((session) => session.pid)));
    const pane = lookup.ok ? lookup.find({ pid: view.pid, tmux: view.tmux }) : undefined;
    if (pane !== undefined) parts.push(inline(paneLabel(pane), 60));
  } catch {
    // ペインが分からなくても送れたことは伝える
  }
  if (view.bridgeSessionId !== undefined) parts.push(`RC: <${ccRcUrl(view.bridgeSessionId)}>`);
  return parts.length === 0 ? "" : `（${parts.join("・")}）`;
}

function errorKind(error: unknown): string {
  return error instanceof Error ? error.name : typeof error;
}

export type CcConfirmExpirerDeps = Pick<CcConfirmDeps, "cfg" | "ccSessions" | "ccPosts" | "home" | "log"> & {
  ccSends: Pick<CcSendStore, "listAwaitingConfirmBefore" | "transition">;
  ccStarts: Pick<CcStartStore, "listAwaitingConfirmBefore" | "transition">;
  /** SELF_AGENT_CC が有効か（無効なら残っている確認待ちを時間を待たずに取り消して注記する。押したときと同じ） */
  ccEnabled: () => boolean;
  now: () => Date;
  timers?: CcTimers;
};

const REAL_TIMERS: CcTimers = {
  after: (fn, ms) => {
    const timer = setTimeout(fn, ms);
    return () => clearTimeout(timer);
  },
};

/**
 * 確認の失効（§5.3）。CC_CONFIRM_SWEEP_MS ごとに、作ってから CC_CONFIRM_TTL_MS 経った確認待ちを取り消し、確認の最後の 1 通（ボタンの付いたもの）の
 * ボタンを外して「送りませんでした」などに書き換える。SELF_AGENT_CC が無効なら（再起動の前に出した確認が残っていれば）時間を待たずに取り消して注記する。
 * SELF_AGENT_CC の有効・無効によらず main が作って動かす
 */
export class CcConfirmExpirer {
  private readonly deps: CcConfirmExpirerDeps;
  private readonly timers: CcTimers;
  private cancelTimer: (() => void) | undefined;
  private started = false;
  private stopped = false;
  private running: Promise<void> | undefined;

  constructor(deps: CcConfirmExpirerDeps) {
    this.deps = deps;
    this.timers = deps.timers ?? REAL_TIMERS;
  }

  /** 直後に 1 回確かめ、以後は CC_CONFIRM_SWEEP_MS ごと。stop の後・2 回目は何もしない */
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
      }, CC_CONFIRM_SWEEP_MS);
    });
  }

  /** 1 回確かめる（テストから直接呼ぶ）。reject しない */
  sweep(): Promise<void> {
    if (this.running !== undefined) return this.running;
    const running = this.pass().finally(() => {
      this.running = undefined;
    });
    this.running = running;
    return running;
  }

  private async pass(): Promise<void> {
    const { ccSends, ccStarts, ccPosts, now, log } = this.deps;
    try {
      const enabled = this.deps.ccEnabled();
      const cutoff = enabled ? new Date(now().getTime() - CC_CONFIRM_TTL_MS) : now();
      const why = enabled ? "確認の期限が過ぎた" : "連携が無効な";
      const note = enabled ? "" : CC_DISABLED_NOTE;
      const edits: Array<Promise<void>> = [];
      const edit = (channelId: string | null, messageId: string | null, text: string, label: string): void => {
        if (channelId === null || messageId === null) return;
        edits.push(
          ccPosts.editMessage(channelId, messageId, { text, components: [] }).catch((error: unknown) => {
            log(`Claude Code: 失効した確認を書き換えられませんでした（${label}、${errorKind(error)}）`);
          }),
        );
      };
      for (const row of ccSends.listAwaitingConfirmBefore(cutoff)) {
        if (!ccSends.transition(row.id, ["awaiting_confirm"], "cancelled", { lastPaneState: enabled ? "expired" : "disabled" })) continue;
        log(`Claude Code: ${why}ため送りませんでした（#${row.id}）`);
        edit(row.channelId, row.messageId, ccSendResultText(sendTarget(this.deps, row), row.text, [`${CC_SEND_CANCELLED}${note}`]), `送信 #${row.id}`);
      }
      for (const row of ccStarts.listAwaitingConfirmBefore(cutoff)) {
        if (!ccStarts.transition(row.id, ["awaiting_confirm"], "cancelled")) continue;
        log(`Claude Code: ${why}ため起動しませんでした（#${row.id}）`);
        edit(row.channelId, row.messageId, ccStartResultText(row, [`${CC_START_CANCELLED}${note}`]), `起動 #${row.id}`);
      }
      await Promise.all(edits);
    } catch (error) {
      log(`Claude Code: 確認の失効を確かめられませんでした（${errorKind(error)}）`);
    }
  }
}
