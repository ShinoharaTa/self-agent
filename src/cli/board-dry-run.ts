// 進行状況を 1 回だけ集めて判定する（docs/plan/project-board.md §4 PS1。npm run board-dry-run）。登録済みのプロジェクトを本体と同じ収集（git と gh の GET）と
// 判定で確かめ、名前・状態・根拠の行を標準出力に出す。DB は読み取り専用で開き、書かない・投稿しない。Claude Code のセッションとプロジェクトのセッションの
// 実行中のターンは材料にしない（Bot の外なので分からない）。読む設定は SELF_AGENT_WORKDIR・SELF_AGENT_DATA_DIR・SELF_AGENT_WORKSPACE_DIR・CLAUDE_CONFIG_DIR
import { homedir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { BoardCollector, NO_LIVE } from "../board/collect.ts";
import { createBoardGit } from "../board/git.ts";
import { ccPlacesOf } from "../cc/starter.ts";
import { loadCcConfig, loadClaudeConfigDir, loadJobDryRunConfig } from "../config.ts";
import { GhClient, resolveCommandPath, resolveGhPath } from "../github/gh.ts";
import { type BoardResult, BoardStore } from "../store/board.ts";
import { DB_BUSY_TIMEOUT_MS } from "../store/db.ts";

/** board_projects ができた user_version */
const REQUIRED_USER_VERSION = 42;

function fail(message: string): number {
  console.error(message);
  return 1;
}

export async function main(_argv: readonly string[]): Promise<number> {
  let places: ReturnType<typeof ccPlacesOf>;
  let dataDir: string;
  try {
    const { workDir, dataDir: dir } = loadJobDryRunConfig();
    dataDir = dir;
    places = ccPlacesOf({ workDir, dataDir, workspaceDir: loadCcConfig().workspaceDir, claudeConfigDir: loadClaudeConfigDir() }, homedir());
  } catch (error) {
    return fail(error instanceof Error ? error.message : String(error));
  }
  const ghPath = resolveGhPath();
  const gitPath = resolveCommandPath("git");
  if (ghPath === undefined || gitPath === undefined) return fail("gh と git が要ります（PATH を確かめてください）");

  let db: DatabaseSync;
  try {
    db = new DatabaseSync(join(dataDir, "self-agent.db"), { readOnly: true, timeout: DB_BUSY_TIMEOUT_MS });
  } catch (error) {
    return fail(`DB を開けませんでした: ${error instanceof Error ? error.message : String(error)}`);
  }
  try {
    const userVersion = Number(db.prepare("PRAGMA user_version").get()?.user_version ?? 0);
    if (userVersion < REQUIRED_USER_VERSION) {
      return fail(`DB が古いので、ボットを再起動してから使ってください（user_version=${userVersion}）`);
    }
    const store = new BoardStore(db);
    const results: Array<{ dir: string; result: BoardResult }> = [];
    const collector = new BoardCollector({
      // 書かずに結果だけを受け取る
      store: {
        listActive: () => store.listActive(),
        saveResult: (dir, result) => {
          results.push({ dir, result });
          return true;
        },
      },
      places,
      git: createBoardGit({ gitPath }),
      gh: new GhClient({ ghPath }),
      live: () => NO_LIVE,
      now: () => new Date(),
      log: (message) => console.error(message),
    });
    await collector.tick();
    if (results.length === 0) {
      console.log("登録したプロジェクトはありません");
      return 0;
    }
    for (const { dir, result } of results) {
      console.log(`${dir}: ${result.state}${result.error === null ? "" : `（${result.error}）`}`);
      for (const reason of result.reasons) console.log(`  - ${reason}`);
    }
    return 0;
  } finally {
    db.close();
  }
}
