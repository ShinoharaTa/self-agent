// この機械の Claude Code のセッションの一覧を 1 回だけ試す（docs/plan/claude-code-sessions.md §8 CC1。npm run cc-dry-run）。
// claude agents --json と ~/.claude の補助（RC のリンク・tmux の欄・記録の mtime）を 1 回読み、本体と同じ rankSessions で 3 群に分けて、
// 件数と各行の状態・名前・最後の活動の時刻を端末に出す（オーナーが見るものなので名前は出す。sessionId・cwd は出さない）。
// hook の事象は使わない（受け口を立てない）。投稿せず、DB も読み書きしない。読む設定は SELF_AGENT_TZ だけ
import { formatWallClock } from "../app/recurrence.ts";
import { AgentsClient, type AgentEntry } from "../cc/agents.ts";
import { ClaudeDirs, type SessionFileInfo } from "../cc/claude-dirs.ts";
import { type CcState, lastActivity, rankSessions, type RankInput } from "../cc/registry.ts";
import { loadDataConfig } from "../config.ts";
import { resolveCommandPath } from "../github/gh.ts";

const STATE_LABELS: Readonly<Record<CcState, string>> = { needs_input: "判断待ち", running: "実行中", idle: "待機" };

/** 1 セッションの材料（hook の事象なし） */
export type DryRunItem = { agent: AgentEntry; file: SessionFileInfo | undefined; transcriptMtime: number | undefined };

/** 端末に出す名前（制御文字は空白に。無ければ「（名前なし）」） */
function displayName(name: string | undefined): string {
  const cleaned = (name ?? "").replace(/[\u0000-\u001f\u007f]/g, " ").trim();
  return cleaned === "" ? "（名前なし）" : cleaned;
}

/** 出す行（純関数）。dropped は形の合わなかった要素の数 */
export function ccDryRunLines(items: readonly DryRunItem[], dropped: number, timeZone: string): string[] {
  const ranked = rankSessions(
    items.map((item): RankInput & { item: DryRunItem } => ({
      sessionId: item.agent.sessionId,
      status: item.agent.status,
      pendingPermission: false,
      waitingKind: null,
      waitingSince: undefined,
      lastPromptAt: undefined,
      transcriptMtime: item.transcriptMtime,
      startedAt: item.agent.startedAt,
      item,
    })),
  );
  const count = (state: CcState): number => ranked.filter((session) => session.state === state).length;
  const lines = [
    `Claude Code のセッション: ${ranked.length} 件（判断待ち ${count("needs_input")}・実行中 ${count("running")}・待機 ${count("idle")}。形の合わない要素 ${dropped} 件）`,
  ];
  for (const state of ["needs_input", "running", "idle"] as const) {
    const group = ranked.filter((session) => session.state === state);
    if (group.length === 0) continue;
    lines.push(`${STATE_LABELS[state]}:`);
    for (const session of group) {
      const at = lastActivity(session);
      const time = at === undefined ? "不明" : formatWallClock(new Date(at), timeZone);
      lines.push(`  [${STATE_LABELS[state]}] ${displayName(session.item.agent.name)}（最後の活動 ${time}）`);
    }
  }
  const bridges = items.filter((item) => item.file?.bridgeSessionId !== undefined).length;
  const tmux = items.filter((item) => item.file?.tmux !== undefined).length;
  lines.push(`RC のリンクが読めたもの ${bridges} 件・tmux の欄が読めたもの ${tmux} 件`);
  lines.push("（hook の事象は使っていないので、最後の活動は記録の更新か起動の時刻です。投稿していません。DB も変えていません）");
  return lines;
}

function fail(message: string): number {
  console.error(message);
  return 1;
}

export async function main(_argv: readonly string[]): Promise<number> {
  let timeZone: string;
  try {
    timeZone = loadDataConfig().timeZone;
  } catch (error) {
    return fail(error instanceof Error ? error.message : String(error));
  }
  const claudePath = resolveCommandPath("claude");
  if (claudePath === undefined) return fail("claude が見つかりません（PATH を確かめてください）");
  const result = await new AgentsClient({ claudePath }).list();
  if (!result.ok) return fail(`claude agents --json を読めませんでした（${result.reason}）`);
  const dirs = new ClaudeDirs();
  const items = result.agents.map((agent) => ({
    agent,
    file: dirs.sessionFile(agent.pid, agent.sessionId),
    transcriptMtime: agent.cwd === undefined ? undefined : dirs.transcriptMtime(agent.cwd, agent.sessionId),
  }));
  for (const line of ccDryRunLines(items, result.dropped, timeZone)) console.log(line);
  return 0;
}
