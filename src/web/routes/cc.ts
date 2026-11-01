// GET /api/cc/sessions・/api/cc/sessions/<id>（docs/plan/claude-code-sessions.md §5.1。CC2）と /api/status の cc。
// この機械の Claude Code のセッションの一覧（registry.ts の snapshot。判断待ち → 実行中 → 待機の順）と、1 つのセッションの画面の写し
// （tmux の capture-pane を stripAnsi して最後の CC_SCREEN_LINES 行。tmux の外は screen: null）。SELF_AGENT_CC が無効なら 404。
// GET のたびに registry の touch() を呼ぶ（見ている間は一覧を設定の周期で読む。§2.2）。
// 名前・cwd・最後の指示は hook から来たデータで、画面は textContent で出す。log は出さない（名前・パス・sessionId・ペイン id を出さない）
import { isUuid } from "../../cc/agents.ts";
import type { CcPaneResolver, PaneLookup } from "../../cc/panes.ts";
import type { CcRegistry, CcSessionView } from "../../cc/registry.ts";
import type { CcSessionStore } from "../../store/cc-sessions.ts";
import { stripAnsi } from "../../tmux/pane-state.ts";
import type { Tmux, TmuxPane } from "../../tmux/tmux.ts";
import { paneLabel } from "../../tmux/workspace-map.ts";
import type { Route, RouteResult } from "../server.ts";

/** 画面の写しの行数（capture-pane -S で撮る履歴の行数も同じ） */
export const CC_SCREEN_LINES = 200;
/** RC のリンクの前半（`<これ><bridgeSessionId>`） */
export const CC_RC_URL_PREFIX = "https://claude.ai/code/";

export type CcRouteDeps = {
  /** SELF_AGENT_CC が無効なら undefined（/api/cc/* は 404） */
  registry: Pick<CcRegistry, "snapshot" | "touch"> | undefined;
  panes: Pick<CcPaneResolver, "lookup"> | undefined;
  tmux: Pick<Tmux, "capturePane"> | undefined;
  /** ディレクトリの表示の元（`~/workspace`。cwd がこの中なら相対で出す） */
  workspaceDir: string;
  /** ~ の場所（workspace の外で ~ の中なら `~/…` で出す） */
  home: string;
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

export function ccRoutes(deps: CcRouteDeps): Route[] {
  const { registry, panes, tmux, workspaceDir, home } = deps;

  const sessionJson = (view: CcSessionView, pane: TmuxPane | undefined) => ({
    sessionId: view.sessionId,
    name: view.name ?? null,
    cwdLabel: cwdLabel(view.cwd, workspaceDir, home),
    permissionMode: view.permissionMode,
    state: view.state,
    since: iso(sinceOf(view)),
    lastPromptAt: iso(view.lastPromptAt),
    lastPromptText: view.lastPromptText,
    inTmux: pane !== undefined,
    paneLabel: pane === undefined ? null : paneLabel(pane),
    rcUrl: view.bridgeSessionId === undefined ? null : `${CC_RC_URL_PREFIX}${view.bridgeSessionId}`,
    // 起動したもの（web / tool / github）は CC4 から。それまではすべてオーナーが起動したもの
    startedBy: "owner",
    // 送信待ち（CC3）・保留中の許可（CC5a）はまだ無い
    pending: null,
    permission: null,
  });

  const lookupPanes = async (): Promise<PaneLookup | undefined> => (panes === undefined ? undefined : panes.lookup());
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
        const lookup = await lookupPanes();
        return {
          status: 200,
          json: {
            stale: snapshot.stale,
            unreadable: snapshot.unreadable,
            sessions: snapshot.sessions.map((view) => sessionJson(view, paneOf(lookup, view))),
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
        const view = registry.snapshot().sessions.find((session) => session.sessionId === id);
        if (view === undefined) return NOT_FOUND;
        const pane = paneOf(await lookupPanes(), view);
        let screen: string | null = null;
        if (pane !== undefined && tmux !== undefined) {
          const captured = await tmux.capturePane(pane.paneId, { historyLines: CC_SCREEN_LINES });
          if (captured.ok) screen = screenText(captured.value);
        }
        return { status: 200, json: { ...sessionJson(view, pane), screen } };
      },
    },
  ];
}

/** /api/status の cc（§5.1）。tmux は list-panes の結果（ok / no_server / failed）。許可の保留は CC5a から */
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
  tmux: Pick<Tmux, "listPanes">;
  hookListening: () => boolean;
  store: Pick<CcSessionStore, "multilineOk">;
};

/** SELF_AGENT_CC が有効なときの /api/status の cc */
export async function ccStatus(deps: CcStatusDeps): Promise<CcStatus> {
  const panes = await deps.tmux.listPanes();
  return {
    enabled: true,
    hookPort: deps.hookListening(),
    tmux: panes.ok ? "ok" : panes.reason === "no_server" ? "no_server" : "failed",
    multilineOk: deps.store.multilineOk(),
    pendingPermissions: 0,
  };
}
