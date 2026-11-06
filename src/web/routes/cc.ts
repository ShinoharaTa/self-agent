// GET /api/cc/sessions・/api/cc/sessions/<id>（docs/plan/claude-code-sessions.md §5.1。CC2）、POST /api/cc/sessions/<id>/send・
// /api/cc/sends/<id>/cancel（CC3。送信は cc/sender.ts）、GET /api/cc/projects・POST /api/cc/sessions（CC4。起動は cc/starter.ts）、
// GET /api/cc/permissions・POST /api/cc/permissions/<id>/allow|always|deny（CC5a・CC5b。保留は cc/permission-hold.ts、常に許可の線引きは
// cc/permissions.ts）、POST /api/cc/permissions/<id>/answer（質問（AskUserQuestion）に答える。docs/plan/claude-code-questions.md §4。Q1）、POST /api/cc/sessions/<id>/unfollow（CC8。返事の追いかけをやめる。Discord の [追いかけをやめる] と同じ）、
// POST /api/cc/sessions/<id>/channel（CC10。そのセッションの Discord のチャンネルを作る。cc/channels.ts。docs/plan/claude-code-channels.md §3.1）、
// POST /api/cc/channels/<id>/close（CC14。/cc close と同じ）と /api/status の cc。ccChannelDescriber は /api/channels の kind cc の行の今（CC14）。
// この機械の Claude Code のセッションの一覧（registry.ts の snapshot。判断待ち → 実行中 → 待機の順。starting は cc/starter.ts の起動したがまだ一覧に出ていないもの）と、1 つのセッションの画面の写し
// （tmux の capture-pane を stripAnsi して最後の CC_SCREEN_LINES 行。tmux の外は screen: null）。SELF_AGENT_CC が無効なら 404。
// GET・POST のたびに registry の touch() を呼ぶ（見ている間は一覧を設定の周期で読む。§2.2）。
// 名前・cwd・最後の指示は hook から来たデータで、画面は textContent で出す。log は /unfollow の 1 行だけ（名前・パス・sessionId・ペイン id を出さない）
import { closeReply } from "../../app/commands/cc.ts";
import { isUuid } from "../../cc/agents.ts";
import { cwdLabel } from "../../cc/labels.ts";
import { type CcPermissionHold, permissionExpiresAt } from "../../cc/permission-hold.ts";
import { describeRule, formatRule } from "../../cc/permissions.ts";
import { parsePicks, parseQuestionInput } from "../../cc/questions.ts";
import type { CcChannelFailure, CcChannels } from "../../cc/channels.ts";
import type { CcPaneResolver, PaneLookup } from "../../cc/panes.ts";
import type { CcRegistry, CcSessionView } from "../../cc/registry.ts";
import { normalizeSendText, type CcSender } from "../../cc/sender.ts";
import type { CcStartFailure, CcStarter } from "../../cc/starter.ts";
import type { CcChannelRow } from "../../store/cc-channels.ts";
import type { CcPermissionRow, CcPermissionStore } from "../../store/cc-permissions.ts";
import type { CcSendRow, CcSendStore } from "../../store/cc-sends.ts";
import type { CcSessionStore } from "../../store/cc-sessions.ts";
import { stripAnsi } from "../../tmux/pane-state.ts";
import type { Tmux, TmuxPane } from "../../tmux/tmux.ts";
import { paneLabel } from "../../tmux/workspace-map.ts";
import type { Route, RouteResult } from "../server.ts";
import type { WebCcInfo } from "./channels.ts";

/** 画面の写しの行数（capture-pane -S で撮る履歴の行数も同じ） */
export const CC_SCREEN_LINES = 200;
/** RC のリンクの前半（`<これ><bridgeSessionId>`） */
export const CC_RC_URL_PREFIX = "https://claude.ai/code/";
/** 一覧の送信の印に、終わった送信を出す長さ（終わってからこの間だけ「届けました」などを出す） */
export const CC_SEND_RECENT_MS = 10 * 60_000;
/** 一覧の許可のカードに、終わった要求を出す長さ（終わってからこの間だけ「端末か RC で答えられました」などを出す） */
export const CC_PERMISSION_RECENT_MS = 10 * 60_000;

export type CcRouteDeps = {
  /** SELF_AGENT_CC が無効なら undefined（/api/cc/* は 404） */
  registry: Pick<CcRegistry, "snapshot" | "touch"> | undefined;
  panes: Pick<CcPaneResolver, "lookup"> | undefined;
  tmux: Pick<Tmux, "capturePane"> | undefined;
  /** ディレクトリの表示の元（`~/workspace`。cwd がこの中なら相対で出す） */
  workspaceDir: string;
  /** ~ の場所（workspace の外で ~ の中なら `~/…` で出す） */
  home: string;
  /** 送信（CC3）。無ければ /send・/cancel は 404 */
  sender?: Pick<CcSender, "submit" | "cancel">;
  /** 一覧の送信の印（pending） */
  sends?: Pick<CcSendStore, "latestPerSession">;
  /** 起動（CC4）。無ければ /api/cc/projects・POST /api/cc/sessions は 404 */
  starter?: Pick<CcStarter, "projects" | "launch" | "pendingStarts">;
  /** 許可の要求（CC5a）。無ければ一覧の permission は null で、/api/cc/permissions は 404 */
  permissions?: {
    hold: Pick<CcPermissionHold, "answer" | "answerQuestion">;
    /** 答えた後（応答を返す直前）。そのセッションの Claude Code のチャンネルを作る（CC11。待たない・投げない） */
    answered?: (id: number) => void;
    store: Pick<CcPermissionStore, "latestPerSession" | "listPending">;
    /** SELF_AGENT_CC_PERMISSION_HOLD_SEC（期限の表示） */
    holdSec: number;
    /** SELF_AGENT_CC_QUESTION_HOLD_SEC（質問の行の期限の表示） */
    questionHoldSec: number;
  };
  /** 返事の追いかけ（CC8）。無ければ一覧の follow は null で、/unfollow は 404 */
  follows?: Pick<CcSessionStore, "listFollowing" | "stopFollow">;
  /**
   * セッションの Discord のチャンネル（CC10）。無ければ一覧の channel は null で、/channel は 404。
   * allowedGuildIds は /channel の guildId の許可（SELF_AGENT_ALLOWED_GUILD_IDS）
   */
  channels?: {
    store: Pick<CcChannels, "openChannel" | "channelOf" | "defaultGuild" | "close" | "postClosed">;
    allowedGuildIds: readonly string[];
    /**
     * Web で開けるチャンネルの引き方（routes/channels.ts の webChannelLookup に ccChannels を渡したもの。/messages と同じ）。
     * POST /api/cc/channels/<id>/close はこれが kind cc を返すチャンネルだけを閉じる（無ければ 404）
     */
    lookup?: (channelId: string) => { guildId: string; kind: string } | undefined;
  };
  /** /unfollow の log（無ければ出さない） */
  log?: (message: string) => void;
  /** 既定は new Date */
  now?: () => Date;
};

const NOT_FOUND: RouteResult = { status: 404, json: { error: "not_found" } };

/** Discord のチャンネルのリンク */
function discordLink(guildId: string, channelId: string): string {
  return `https://discord.com/channels/${guildId}/${channelId}`;
}

/** チャンネルを作れなかった理由 → HTTP の状態（docs/plan/claude-code-channels.md §3.1） */
const CHANNEL_STATUS: Readonly<Record<CcChannelFailure, number>> = {
  not_found: 404,
  not_in_tmux: 409,
  full: 409,
  not_set_up: 503,
  failed: 502,
};

/** 画面の写し: 制御シーケンスを落とし、末尾の空行を除いて最後の CC_SCREEN_LINES 行（純関数） */
export function screenText(raw: string): string {
  const lines = stripAnsi(raw).split("\n");
  while (lines.length > 0 && lines[lines.length - 1]!.trim() === "") lines.pop();
  return lines.slice(-CC_SCREEN_LINES).join("\n");
}

function iso(ms: number | undefined): string | null {
  return ms === undefined ? null : new Date(ms).toISOString();
}

/** 状態の始まり（判断待ちは待ち始め、それ以外は最後の活動） */
function sinceOf(view: CcSessionView): number | undefined {
  return view.state === "needs_input" ? (view.waitingSince ?? view.lastActivityAt) : view.lastActivityAt;
}

/** 送れなかった理由 → HTTP の状態（§5.1。routes/turns.ts の Claude Code のチャンネルの送信も同じ） */
export const SUBMIT_STATUS: Readonly<Record<string, number>> = {
  not_found: 404,
  already_queued: 409,
  queue_full: 409,
  not_in_tmux: 409,
  not_claude: 409,
  no_server: 503,
  tmux_failed: 503,
  stopped: 503,
};

/** 起動を断った理由 → HTTP の状態（§5.1） */
const START_STATUS: Readonly<Record<CcStartFailure, number>> = {
  invalid_project: 400,
  invalid_title: 400,
  invalid_mode: 400,
  empty: 400,
  too_long: 400,
  invalid_text: 400,
  limit: 409,
  low_memory: 409,
  too_soon: 409,
  not_ready: 503,
  no_server: 503,
  tmux_failed: 503,
  stopped: 503,
};

/**
 * 一覧の送信の印（そのセッションの最新の送信。終わったものは CC_SEND_RECENT_MS の間だけ）。lastPaneState は最後に見たペインの状態か送れなかった理由
 * （dialog なら画面に「ダイアログが出ているため待っています」を出す）
 */
function pendingJson(
  row: CcSendRow | undefined,
): { id: number; state: string; lastPaneState: string | null; replyState: string | null; updatedAt: string } | null {
  return row === undefined
    ? null
    : { id: row.id, state: row.state, lastPaneState: row.lastPaneState, replyState: row.replyState, updatedAt: row.updatedAt };
}

/** 常に許可のルールの意味（Bash のルールの添え書きを「、」でつなぐ。無ければ null） */
function alwaysNote(row: CcPermissionRow): string | null {
  const notes = (row.alwaysRules ?? []).map(describeRule).filter((note): note is string => note !== null);
  return notes.length === 0 ? null : notes.join("、");
}

/** 保留の長さ（許可の要求と質問） */
export type HoldSeconds = { holdSec: number; questionHoldSec: number };

/**
 * 質問の行の問と答え（question_input から作る。表示用に切らない。画面が切る）。質問でない・読めなければ null。
 * answers は答えたときに返したもの（question の文 → 値）で、答えていなければ null
 */
function questionJson(row: CcPermissionRow) {
  const parsed = parseQuestionInput(row.questionInput);
  return parsed === undefined ? null : { questions: parsed.questions, answers: row.answers };
}

/** 許可の要求の 1 件（Web は textContent で出す。要約・ツール名・質問は hook から来たデータ） */
export function permissionJson(row: CcPermissionRow, hold: HoldSeconds) {
  return {
    id: row.id,
    sessionId: row.sessionId,
    state: row.state,
    via: row.via,
    toolName: row.toolName,
    summary: row.summary,
    // 常に許可にすると加わるルール（`Bash(npm test *)`。複数なら「、」でつなぐ）とその意味（Bash だけ）。提案が無ければ null
    alwaysRule: row.alwaysRules === null ? null : row.alwaysRules.map(formatRule).join("、"),
    alwaysNote: alwaysNote(row),
    requestHash: row.requestHash,
    permissionMode: row.permissionMode,
    createdAt: row.createdAt,
    expiresAt: permissionExpiresAt(row, hold.holdSec, hold.questionHoldSec),
    resolvedAt: row.resolvedAt,
    // 質問（AskUserQuestion）なら { questions, answers }、それ以外は null
    question: questionJson(row),
  };
}

/**
 * /api/channels の Claude Code のチャンネルの行の今（CC14。docs/plan/claude-code-channels.md §5.2）。返した関数は 1 回の要求の中で使い、
 * 一覧・送信・許可は最初に 1 回だけ読む。ペインは引かず、inTmux は一覧の tmux の有無（画面の写しと送る先の確かめは /api/cc/sessions/<id> と送信が行う）。
 * チャンネルが open でない・一覧に無いセッションは ended。名前は一覧の名前 → cc_sessions の名前 → チャンネル名から `cc-` を外したもの（閉じた行でも同じ形）
 */
export function ccChannelDescriber(
  deps: Pick<CcRouteDeps, "registry" | "workspaceDir" | "home" | "sends" | "now"> & {
    permissions?: { store: Pick<CcPermissionStore, "latestPerSession"> } & HoldSeconds;
    /** 一覧に居ないセッションの名前（cc_sessions） */
    sessions?: Pick<CcSessionStore, "get">;
  },
): () => (row: CcChannelRow) => { name: string | null; info: WebCcInfo } {
  const now = deps.now ?? (() => new Date());
  return () => {
    const at = now().getTime();
    const sessions = deps.registry?.snapshot().sessions ?? [];
    const sends = new Map((deps.sends?.latestPerSession(new Date(at - CC_SEND_RECENT_MS)) ?? []).map((row) => [row.sessionId ?? "", row]));
    const permissions = new Map(
      (deps.permissions?.store.latestPerSession(new Date(at - CC_PERMISSION_RECENT_MS)) ?? []).map((row) => [row.sessionId, row]),
    );
    return (row) => {
      const listed = sessions.find((session) => session.sessionId === row.sessionId);
      const view = row.state === "open" || row.state === "resuming" ? listed : undefined;
      const permission = permissions.get(row.sessionId);
      const name = listed?.name ?? deps.sessions?.get(row.sessionId)?.name ?? row.name.replace(/^cc-/, "");
      return {
        name: name === "" ? null : name,
        info: {
          sessionId: row.sessionId,
          state: view === undefined ? "ended" : view.state,
          cwdLabel: cwdLabel(view?.cwd ?? row.cwd ?? undefined, deps.workspaceDir, deps.home),
          inTmux: view?.tmux !== undefined,
          permission: permission === undefined ? null : permissionJson(permission, deps.permissions ?? NO_HOLD),
          pending: pendingJson(sends.get(row.sessionId)),
        },
      };
    };
  };
}

/** /api/cc/channels/<id>/close の結果 → HTTP の状態（closed は 200） */
const CLOSE_STATUS: Readonly<Record<"not_channel" | "resuming" | "ended", RouteResult>> = {
  not_channel: NOT_FOUND,
  resuming: { status: 409, json: { error: "resuming" } },
  ended: { status: 409, json: { error: "ended" } },
};

/** 押した操作の結果 → HTTP の状態 */
const ANSWER_STATUS: Readonly<Record<string, number>> = { not_found: 404, stale: 409 };

/** 許可の要求を扱わないとき（期限は出ない） */
const NO_HOLD: HoldSeconds = { holdSec: 0, questionHoldSec: 0 };

export function ccRoutes(deps: CcRouteDeps): Route[] {
  const { registry, panes, tmux, workspaceDir, home, sender, sends, starter, permissions, follows, channels } = deps;
  const now = deps.now ?? (() => new Date());

  const latestSends = (): Map<string, CcSendRow> => {
    const rows = sends === undefined ? [] : sends.latestPerSession(new Date(now().getTime() - CC_SEND_RECENT_MS));
    return new Map(rows.map((row) => [row.sessionId ?? "", row]));
  };

  const latestPermissions = (): Map<string, CcPermissionRow> => {
    const rows = permissions === undefined ? [] : permissions.store.latestPerSession(new Date(now().getTime() - CC_PERMISSION_RECENT_MS));
    return new Map(rows.map((row) => [row.sessionId, row]));
  };

  const hold: HoldSeconds = permissions ?? NO_HOLD;

  // 追いかけ中のセッション → 始めた時刻
  const following = (): Map<string, string | null> =>
    new Map((follows === undefined ? [] : follows.listFollowing()).map((row) => [row.sessionId, row.followSince]));

  const sessionJson = (
    view: CcSessionView,
    pane: TmuxPane | undefined,
    send: CcSendRow | undefined,
    permission: CcPermissionRow | undefined,
    follow: Map<string, string | null>,
  ) => ({
    sessionId: view.sessionId,
    name: view.name ?? null,
    cwdLabel: cwdLabel(view.cwd, workspaceDir, home),
    permissionMode: view.permissionMode,
    state: view.state,
    // 判断待ちの理由（claude agents --json の waitingFor。status が waiting のときだけ）
    waitingFor: view.waitingFor ?? null,
    since: iso(sinceOf(view)),
    lastPromptAt: iso(view.lastPromptAt),
    lastPromptText: view.lastPromptText,
    inTmux: pane !== undefined,
    paneLabel: pane === undefined ? null : paneLabel(pane),
    rcUrl: view.bridgeSessionId === undefined ? null : `${CC_RC_URL_PREFIX}${view.bridgeSessionId}`,
    // 起動したもの（owner = self-agent の外。web / tool / github は self-agent が起動したもの）
    startedBy: view.startedBy,
    // trust のダイアログの確認待ち（self-agent が起動したものだけ。§4.2）
    trustPending: view.trustPending,
    // そのセッションの最新の送信（CC3）
    pending: pendingJson(send),
    // そのセッションの最新の許可の要求（保留中か、終わってから CC_PERMISSION_RECENT_MS の間。CC5a）
    permission: permission === undefined ? null : permissionJson(permission, hold),
    // 返事を Discord に戻しているか（CC8。追いかけ中なら始めた時刻）
    follow: follow.has(view.sessionId) ? { since: follow.get(view.sessionId) ?? null } : null,
    // そのセッションの Discord のチャンネル（CC10。削除されていないもの）
    channel: channelJson(view.sessionId),
  });

  const channelJson = (sessionId: string): { channelId: string; guildId: string; link: string; state: string } | null => {
    const row = channels?.store.channelOf(sessionId);
    return row === undefined ? null : { channelId: row.channelId, guildId: row.guildId, link: discordLink(row.guildId, row.channelId), state: row.state };
  };

  // 入れ子の claude を見分けるため、一覧のすべての pid を渡す
  const lookupPanes = async (views: readonly CcSessionView[]): Promise<PaneLookup | undefined> =>
    panes === undefined ? undefined : panes.lookup(new Set(views.map((view) => view.pid)));
  const paneOf = (lookup: PaneLookup | undefined, view: CcSessionView): TmuxPane | undefined =>
    lookup !== undefined && lookup.ok ? lookup.find({ pid: view.pid, tmux: view.tmux }) : undefined;

  return [
    {
      method: "GET",
      pattern: /^\/api\/cc\/sessions$/,
      handle: async () => {
        if (registry === undefined) return NOT_FOUND;
        registry.touch();
        const snapshot = registry.snapshot();
        const lookup = await lookupPanes(snapshot.sessions);
        const latest = latestSends();
        const latestPermission = latestPermissions();
        const follow = following();
        return {
          status: 200,
          json: {
            stale: snapshot.stale,
            unreadable: snapshot.unreadable,
            // 最後に読めた時刻（画面の「n 秒前」。まだなら null）
            fetchedAt: iso(snapshot.fetchedAt),
            sessions: snapshot.sessions.map((view) =>
              sessionJson(view, paneOf(lookup, view), latest.get(view.sessionId), latestPermission.get(view.sessionId), follow),
            ),
            // 起動したがまだ一覧に出ていないもの（trust の確認待ちの claude は claude agents --json に出ない。sessionId はまだ無い）
            starting: (starter?.pendingStarts() ?? []).map((entry) => ({
              project: entry.project,
              title: entry.title,
              trustPending: entry.trustPending,
              startedAt: iso(entry.startedAt),
            })),
          },
        };
      },
    },
    {
      method: "GET",
      pattern: /^\/api\/cc\/sessions\/([^/]+)$/,
      handle: async ({ params }) => {
        if (registry === undefined) return NOT_FOUND;
        registry.touch();
        const id = params[0] ?? "";
        if (!isUuid(id)) return NOT_FOUND;
        const sessions = registry.snapshot().sessions;
        const view = sessions.find((session) => session.sessionId === id);
        if (view === undefined) return NOT_FOUND;
        const pane = paneOf(await lookupPanes(sessions), view);
        let screen: string | null = null;
        if (pane !== undefined && tmux !== undefined) {
          const captured = await tmux.capturePane(pane.paneId, { historyLines: CC_SCREEN_LINES });
          if (captured.ok) screen = screenText(captured.value);
        }
        const json = sessionJson(view, pane, latestSends().get(view.sessionId), latestPermissions().get(view.sessionId), following());
        return { status: 200, json: { ...json, screen } };
      },
    },
    {
      method: "POST",
      pattern: /^\/api\/cc\/sessions\/([^/]+)\/send$/,
      handle: async ({ params, body }) => {
        if (registry === undefined || sender === undefined) return NOT_FOUND;
        registry.touch();
        const id = params[0] ?? "";
        if (!isUuid(id)) return NOT_FOUND;
        const checked = normalizeSendText(body?.text);
        if (!checked.ok) return { status: 400, json: { error: checked.reason } };
        const result = await sender.submit({ sessionId: id, text: checked.text, origin: "web" });
        if (result.ok) return { status: 202, json: { sendId: result.send.id, state: result.send.state } };
        return { status: SUBMIT_STATUS[result.reason] ?? 503, json: { error: result.reason === "stopped" ? "stopping" : result.reason } };
      },
    },
    {
      method: "POST",
      pattern: /^\/api\/cc\/sessions\/([^/]+)\/unfollow$/,
      handle: async ({ params }) => {
        if (registry === undefined || follows === undefined) return NOT_FOUND;
        registry.touch();
        const id = params[0] ?? "";
        if (!isUuid(id)) return NOT_FOUND;
        // 追いかけ中でなければ（既にやめた・始めていない）古い操作
        if (!follows.stopFollow(id)) return { status: 409, json: { error: "stale" } };
        deps.log?.("Claude Code: Web で追いかけをやめました");
        return { status: 200, json: { follow: null } };
      },
    },
    {
      method: "POST",
      pattern: /^\/api\/cc\/sessions\/([^/]+)\/channel$/,
      handle: async ({ params, body }) => {
        if (registry === undefined || channels === undefined) return NOT_FOUND;
        registry.touch();
        const id = params[0] ?? "";
        if (!isUuid(id)) return NOT_FOUND;
        // guildId: /setup 済みのサーバーが複数なら画面が選ぶ。省けば最初のカテゴリ「Claude Code」のあるサーバー
        const rawGuild = body?.guildId;
        if (rawGuild !== undefined && (typeof rawGuild !== "string" || !channels.allowedGuildIds.includes(rawGuild))) {
          return { status: 400, json: { error: "bad_request" } };
        }
        const guildId = rawGuild ?? channels.store.defaultGuild();
        if (guildId === undefined) return { status: 503, json: { error: "not_set_up" } };
        const result = await channels.store.openChannel(guildId, id, "web");
        if (result.ok) return { status: 201, json: { channelId: result.channelId, link: discordLink(result.guildId, result.channelId) } };
        if (result.reason === "exists") {
          return { status: 409, json: { error: "exists", channelId: result.channelId, link: discordLink(result.guildId, result.channelId) } };
        }
        return { status: CHANNEL_STATUS[result.reason], json: { error: result.reason } };
      },
    },
    {
      method: "POST",
      pattern: /^\/api\/cc\/channels\/(\d{1,25})\/close$/,
      handle: async ({ params }) => {
        if (registry === undefined || channels === undefined) return NOT_FOUND;
        // /cc close と同じ（open を ended にして完了へ移す）。結果の文はチャンネルにも投稿する
        registry.touch();
        const channelId = params[0] ?? "";
        // /messages と同じく、許可した /setup 済みのサーバーの削除されていない Claude Code のチャンネルだけ
        if (channels.lookup?.(channelId)?.kind !== "cc") return NOT_FOUND;
        const closed = channels.store.close(channelId, { fromWeb: true });
        if (closed.result !== "closed") return CLOSE_STATUS[closed.result];
        channels.store.postClosed(channelId, closeReply(closed).text);
        return { status: 200, json: { state: "ended", cancelled: closed.cancelled } };
      },
    },
    {
      method: "GET",
      pattern: /^\/api\/cc\/projects$/,
      handle: async () => {
        if (registry === undefined || starter === undefined) return NOT_FOUND;
        return { status: 200, json: { projects: starter.projects().map((name) => ({ name })) } };
      },
    },
    {
      method: "POST",
      pattern: /^\/api\/cc\/sessions$/,
      handle: async ({ body }) => {
        if (registry === undefined || starter === undefined) return NOT_FOUND;
        registry.touch();
        const result = await starter.launch({
          project: body?.project,
          title: body?.title,
          text: body?.text,
          permissionMode: body?.permissionMode,
          startedBy: "web",
        });
        if (!result.ok) return { status: START_STATUS[result.reason], json: { error: result.reason === "stopped" ? "stopping" : result.reason } };
        return {
          status: 201,
          json: { tmuxSession: result.tmuxSession, paneId: result.paneId, ...(result.sendId === undefined ? {} : { sendId: result.sendId }) },
        };
      },
    },
    {
      method: "POST",
      pattern: /^\/api\/cc\/sends\/(\d{1,16})\/cancel$/,
      handle: async ({ params }) => {
        if (registry === undefined || sender === undefined) return NOT_FOUND;
        registry.touch();
        const result = sender.cancel(Number(params[0]));
        if (result === "not_found") return NOT_FOUND;
        if (result === "stale") return { status: 409, json: { error: "stale" } };
        return { status: 200, json: { state: "cancelled" } };
      },
    },
    {
      method: "GET",
      pattern: /^\/api\/cc\/permissions$/,
      handle: async () => {
        if (registry === undefined || permissions === undefined) return NOT_FOUND;
        registry.touch();
        return { status: 200, json: { permissions: permissions.store.listPending().map((row) => permissionJson(row, hold)) } };
      },
    },
    {
      method: "POST",
      pattern: /^\/api\/cc\/permissions\/(\d{1,16})\/(allow|always|deny)$/,
      handle: async ({ params, body }) => {
        if (registry === undefined || permissions === undefined) return NOT_FOUND;
        registry.touch();
        // requestHash: 画面が出していた要求と行が同じことを確かめる（§3.4）。無ければ 400
        const requestHash = body?.requestHash;
        if (typeof requestHash !== "string") return { status: 400, json: { error: "bad_request" } };
        // always は行にルールが無ければ 409（stale）
        const decision = params[1] === "allow" ? "allow" : params[1] === "always" ? "always" : "deny";
        const result = permissions.hold.answer(Number(params[0]), decision, "web", requestHash);
        if (result.ok) {
          permissions.answered?.(Number(params[0]));
          return { status: 200, json: { state: result.state } };
        }
        return { status: ANSWER_STATUS[result.reason] ?? 409, json: { error: result.reason } };
      },
    },
    {
      // 質問に答える（docs/plan/claude-code-questions.md §4）。answers は問の順に { labels } か { other }。
      // 形が違う・問の数や選択肢に合わなければ 400、無い id は 404、保留していない・requestHash が違う・質問でない行は 409（stale）
      method: "POST",
      pattern: /^\/api\/cc\/permissions\/(\d{1,16})\/answer$/,
      handle: async ({ params, body }) => {
        if (registry === undefined || permissions === undefined) return NOT_FOUND;
        registry.touch();
        const requestHash = body?.requestHash;
        const picks = parsePicks(body?.answers);
        if (typeof requestHash !== "string" || picks === undefined) return { status: 400, json: { error: "bad_request" } };
        const result = permissions.hold.answerQuestion(Number(params[0]), requestHash, picks, "web");
        if (result.ok) {
          permissions.answered?.(Number(params[0]));
          return { status: 200, json: { state: result.state } };
        }
        if (result.reason === "invalid") return { status: 400, json: { error: "bad_request" } };
        return { status: ANSWER_STATUS[result.reason] ?? 409, json: { error: result.reason } };
      },
    },
  ];
}

/** /api/status の cc（§5.1）。tmux は直近の list-panes の結果（ok / no_server / failed。まだ読んでいなければ null）。pendingPermissions は保留中の許可の要求の数 */
export type CcStatus = {
  enabled: boolean;
  /** hook の受け口が待ち受けているか */
  hookPort: boolean;
  tmux: "ok" | "no_server" | "failed" | null;
  multilineOk: boolean | null;
  pendingPermissions: number;
  /** プロジェクトのセッションの共有の link（npm run unify-setup）が起動時の確認で済んでいたか（docs/plan/unify.md §6.1 の 8） */
  unifyReady: boolean;
};

export const CC_STATUS_DISABLED: CcStatus = {
  enabled: false,
  hookPort: false,
  tmux: null,
  multilineOk: null,
  pendingPermissions: 0,
  unifyReady: false,
};

export type CcStatusDeps = {
  panes: Pick<CcPaneResolver, "lastTmux">;
  hookListening: () => boolean;
  store: Pick<CcSessionStore, "multilineOk">;
  permissions?: Pick<CcPermissionStore, "countPending">;
  /** 起動時の共有の link の確認（agent/unify-setup-check.ts の checkSharedLinks）。省略は済んでいない */
  unifyReady?: () => boolean;
};

/** SELF_AGENT_CC が有効なときの /api/status の cc。tmux は /api/cc/* が引いた直近の結果で、ここでは list-panes を起動しない */
export function ccStatus(deps: CcStatusDeps): CcStatus {
  const tmux = deps.panes.lastTmux();
  return {
    enabled: true,
    hookPort: deps.hookListening(),
    tmux: tmux === undefined ? null : tmux === "ok" || tmux === "no_server" ? tmux : "failed",
    multilineOk: deps.store.multilineOk(),
    pendingPermissions: deps.permissions?.countPending() ?? 0,
    unifyReady: deps.unifyReady?.() ?? false,
  };
}
