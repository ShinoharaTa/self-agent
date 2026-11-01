// GET /api/cc/sessions・/api/cc/sessions/<id>（docs/plan/claude-code-sessions.md §5.1。CC2）、POST /api/cc/sessions/<id>/send・
// /api/cc/sends/<id>/cancel（CC3。送信は cc/sender.ts）、GET /api/cc/projects・POST /api/cc/sessions（CC4。起動は cc/starter.ts）と /api/status の cc。
// この機械の Claude Code のセッションの一覧（registry.ts の snapshot。判断待ち → 実行中 → 待機の順）と、1 つのセッションの画面の写し
// （tmux の capture-pane を stripAnsi して最後の CC_SCREEN_LINES 行。tmux の外は screen: null）。SELF_AGENT_CC が無効なら 404。
// GET・POST のたびに registry の touch() を呼ぶ（見ている間は一覧を設定の周期で読む。§2.2）。
// 名前・cwd・最後の指示は hook から来たデータで、画面は textContent で出す。log は出さない（名前・パス・sessionId・ペイン id を出さない）
import { isUuid } from "../../cc/agents.ts";
import type { CcPaneResolver, PaneLookup } from "../../cc/panes.ts";
import type { CcRegistry, CcSessionView } from "../../cc/registry.ts";
import { normalizeSendText, type CcSender } from "../../cc/sender.ts";
import type { CcStartFailure, CcStarter } from "../../cc/starter.ts";
import type { CcSendRow, CcSendStore } from "../../store/cc-sends.ts";
import type { CcSessionStore } from "../../store/cc-sessions.ts";
import { stripAnsi } from "../../tmux/pane-state.ts";
import type { Tmux, TmuxPane } from "../../tmux/tmux.ts";
import { paneLabel } from "../../tmux/workspace-map.ts";
import type { Route, RouteResult } from "../server.ts";

/** 画面の写しの行数（capture-pane -S で撮る履歴の行数も同じ） */
export const CC_SCREEN_LINES = 200;
/** RC のリンクの前半（`<これ><bridgeSessionId>`） */
export const CC_RC_URL_PREFIX = "https://claude.ai/code/";
/** 一覧の送信の印に、終わった送信を出す長さ（終わってからこの間だけ「届けました」などを出す） */
export const CC_SEND_RECENT_MS = 10 * 60_000;

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
  starter?: Pick<CcStarter, "projects" | "launch">;
  /** 既定は new Date */
  now?: () => Date;
};

const NOT_FOUND: RouteResult = { status: 404, json: { error: "not_found" } };

/** cwd の表示（`~/workspace/` からの相対。その外で ~ の中なら `~/…`、それ以外はそのまま）。無ければ null */
export function cwdLabel(cwd: string | undefined, workspaceDir: string, home: string): string | null {
  if (cwd === undefined || cwd === "") return null;
  const within = (base: string): string | undefined => {
    const root = base.replace(/\/+$/, "");
    if (root === "") return undefined;
    if (cwd === root) return "";
    return cwd.startsWith(`${root}/`) ? cwd.slice(root.length + 1) : undefined;
  };
  const inWorkspace = within(workspaceDir);
  if (inWorkspace !== undefined && inWorkspace !== "") return inWorkspace;
  const inHome = within(home);
  if (inHome !== undefined) return inHome === "" ? "~" : `~/${inHome}`;
  return cwd;
}

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

/** 送れなかった理由 → HTTP の状態（§5.1） */
const SUBMIT_STATUS: Readonly<Record<string, number>> = {
  not_found: 404,
  already_queued: 409,
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
): { id: number; state: string; lastPaneState: string | null; updatedAt: string } | null {
  return row === undefined ? null : { id: row.id, state: row.state, lastPaneState: row.lastPaneState, updatedAt: row.updatedAt };
}

export function ccRoutes(deps: CcRouteDeps): Route[] {
  const { registry, panes, tmux, workspaceDir, home, sender, sends, starter } = deps;
  const now = deps.now ?? (() => new Date());

  const latestSends = (): Map<string, CcSendRow> => {
    const rows = sends === undefined ? [] : sends.latestPerSession(new Date(now().getTime() - CC_SEND_RECENT_MS));
    return new Map(rows.map((row) => [row.sessionId ?? "", row]));
  };

  const sessionJson = (view: CcSessionView, pane: TmuxPane | undefined, send: CcSendRow | undefined) => ({
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
    // そのセッションの最新の送信（CC3）。保留中の許可（CC5a）はまだ無い
    pending: pendingJson(send),
    permission: null,
  });

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
        return {
          status: 200,
          json: {
            stale: snapshot.stale,
            unreadable: snapshot.unreadable,
            // 最後に読めた時刻（画面の「n 秒前」。まだなら null）
            fetchedAt: iso(snapshot.fetchedAt),
            sessions: snapshot.sessions.map((view) => sessionJson(view, paneOf(lookup, view), latest.get(view.sessionId))),
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
        return { status: 200, json: { ...sessionJson(view, pane, latestSends().get(view.sessionId)), screen } };
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
  ];
}

/** /api/status の cc（§5.1）。tmux は直近の list-panes の結果（ok / no_server / failed。まだ読んでいなければ null）。許可の保留は CC5a から */
export type CcStatus = {
  enabled: boolean;
  /** hook の受け口が待ち受けているか */
  hookPort: boolean;
  tmux: "ok" | "no_server" | "failed" | null;
  multilineOk: boolean | null;
  pendingPermissions: number;
};

export const CC_STATUS_DISABLED: CcStatus = { enabled: false, hookPort: false, tmux: null, multilineOk: null, pendingPermissions: 0 };

export type CcStatusDeps = {
  panes: Pick<CcPaneResolver, "lastTmux">;
  hookListening: () => boolean;
  store: Pick<CcSessionStore, "multilineOk">;
};

/** SELF_AGENT_CC が有効なときの /api/status の cc。tmux は /api/cc/* が引いた直近の結果で、ここでは list-panes を起動しない */
export function ccStatus(deps: CcStatusDeps): CcStatus {
  const tmux = deps.panes.lastTmux();
  return {
    enabled: true,
    hookPort: deps.hookListening(),
    tmux: tmux === undefined ? null : tmux === "ok" || tmux === "no_server" ? tmux : "failed",
    multilineOk: deps.store.multilineOk(),
    pendingPermissions: 0,
  };
}
