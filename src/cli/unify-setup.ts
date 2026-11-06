// プロジェクトのセッションの共有の link の作り方を出す（docs/plan/unify.md §5.3・§6.1 の 8。npm run unify-setup -- --print）。
// Bot 専用の CLAUDE_CONFIG_DIR の skills・agents を ~/.claude の同じ名前への symlink にする `ln -s` の行を標準出力に出す
// （済んだものは「済」、symlink でないもの・向きの違うものは理由の文）。ファイルは書かない。cc-setup.ts に倣う
import { homedir } from "node:os";
import { loadClaudeConfigDir } from "../config.ts";
import { unifySetupLines } from "../agent/unify-setup-check.ts";

const USAGE =
  "使い方: npm run unify-setup -- --print（CLAUDE_CONFIG_DIR の skills・agents を ~/.claude への symlink にする ln -s の行を標準出力に出す。ファイルは書かない）";

export async function main(argv: readonly string[], env: NodeJS.ProcessEnv = process.env, home: string = homedir()): Promise<number> {
  if (argv.length !== 1 || argv[0] !== "--print") {
    console.error(USAGE);
    return 2;
  }
  let claudeConfigDir: string;
  try {
    claudeConfigDir = loadClaudeConfigDir(env);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  }
  console.log(unifySetupLines(claudeConfigDir, home).join("\n"));
  console.error("（ln -s の行を実行してから self-agent を再起動してください。このコマンドはファイルを書きません）");
  return 0;
}
