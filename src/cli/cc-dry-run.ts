// この機械の Claude Code のセッションの一覧を 1 回だけ試す（docs/plan/claude-code-sessions.md §8 CC1。npm run cc-dry-run）。
// claude agents --json と ~/.claude の補助（RC のリンク・tmux の欄・記録の mtime）を 1 回読み、本体と同じ rankSessions で 3 群に分けて、
// 件数と各行の状態・名前・最後の活動の時刻を端末に出す（オーナーが見るものなので名前は出す。sessionId・cwd は出さない）。
// hook の事象は使わない（受け口を立てない）。投稿せず、DB も読み書きしない。読む設定は SELF_AGENT_DATA_DIR と SELF_AGENT_TZ（loadDataConfig）。
// `--reset-multiline` のときだけ、一覧は読まずに DB の cc_state.multiline_ok を 1 に戻す（複数行の送信を止めた後、実機で確かめ直したとき。
// docs/plan/claude-code-sessions.md §3.2。ほかは変えない。移行はしない）
import { existsSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { parseArgs } from "node:util";
import { formatWallClock } from "../app/recurrence.ts";
import { AgentsClient, type AgentEntry, resolveClaudePath } from "../cc/agents.ts";
import { ClaudeDirs, type SessionFileInfo } from "../cc/claude-dirs.ts";
import { type CcState, lastActivity, rankSessions, type RankInput } from "../cc/registry.ts";
import { loadDataConfig } from "../config.ts";
import { CcSessionStore } from "../store/cc-sessions.ts";
import { DB_BUSY_TIMEOUT_MS } from "../store/db.ts";

const USAGE = "使い方: npm run cc-dry-run -- [--reset-multiline] [--help]";
/** cc_state ができた user_version */
const CC_STATE_USER_VERSION = 27;

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
      lastEventAt: undefined,
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

/**
 * DB（dbPath）の cc_state.multiline_ok を 1 に戻す（--reset-multiline）。DB は移行せずに開き、cc_state が無い（古い）なら何もしない。
 * 戻したら 0、既に 1 なら 0（そう出す）、無い・開けない・古いなら 1
 */
export function resetMultiline(dbPath: string, out: (line: string) => void = console.log, err: (line: string) => void = console.error): number {
  // 無いファイルを作らない
  if (!existsSync(dbPath)) {
    err("DB がありません（SELF_AGENT_DATA_DIR を確かめてください）");
    return 1;
  }
  let db: DatabaseSync;
  try {
    db = new DatabaseSync(dbPath, { timeout: DB_BUSY_TIMEOUT_MS });
  } catch (error) {
    err(`DB を開けませんでした: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
  try {
    const userVersion = Number(db.prepare("PRAGMA user_version").get()?.user_version ?? 0);
    if (userVersion < CC_STATE_USER_VERSION) {
      err(`DB が古いので、ボットを再起動してから使ってください（user_version=${userVersion}）`);
      return 1;
    }
    const changed = new CcSessionStore(db).setMultilineOk(true);
    out(changed ? "複数行の送信を戻しました（multiline_ok = 1）。次の送信から改行をそのまま送ります" : "複数行の送信は既に有効です（multiline_ok = 1）");
    return 0;
  } finally {
    db.close();
  }
}

export async function main(argv: readonly string[]): Promise<number> {
  let values: { "reset-multiline"?: boolean; help?: boolean };
  try {
    ({ values } = parseArgs({ args: [...argv], options: { "reset-multiline": { type: "boolean" }, help: { type: "boolean" } } }));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return fail(USAGE);
  }
  if (values.help === true) {
    console.log(USAGE);
    return 0;
  }
  let timeZone: string;
  let dataDir: string;
  try {
    ({ timeZone, dataDir } = loadDataConfig());
  } catch (error) {
    return fail(error instanceof Error ? error.message : String(error));
  }
  if (values["reset-multiline"] === true) return resetMultiline(join(dataDir, "self-agent.db"));
  const claudePath = resolveClaudePath();
  if (claudePath === undefined) return fail("claude が見つかりません（~/.local/bin・/usr/local/bin・/usr/bin と PATH を確かめてください）");
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
