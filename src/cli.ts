#!/usr/bin/env node
// self-agent コマンドの入口（docs/plan/distribution.md §4.2）。self-agent <サブコマンド> [オプション]。
// サブコマンドの本体は src/cli/<name>.ts の main（start は src/main.ts をそのまま動かす）。本体を動かす前に env ファイルを読む（§4.3。cli/env.ts）
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { envFilePath, loadEnv, type LoadEnvResult } from "./cli/env.ts";

/** サブコマンドと使い方の 1 行（並びは --help の順） */
const SUBCOMMANDS = {
  start: "Bot を起動する",
  devlog: "dev モードの会話ログを 1 ターンずつ表示する",
  usage: "ターンごとのトークン（キャッシュの読み・書き）を表示する",
  "guest-setup": "ゲストの変数を端末で対話式に訊いて env に書く",
  "github-dry-run": "GitHub の通知を 1 回だけ取得して振り分け、件数だけを表示する（投稿しない）",
  "shell-check": "シェル（Bash）の受け入れの実機確認（利用枠を消費する）",
  "job-dry-run": "作業ジョブのアプリ側を LLM なしで 1 回試す",
  measure: "ターン時間・RSS・トークン使用量の実測（利用枠を消費する）",
} as const;

export type SubcommandName = keyof typeof SUBCOMMANDS;

/** 版が分からないとき（package.json に version が無い・読めない） */
export const DEV_VERSION = "0.0.0-dev";

export function usageText(): string {
  const width = Math.max(...Object.keys(SUBCOMMANDS).map((name) => name.length));
  return [
    "使い方: self-agent <サブコマンド> [オプション]",
    "",
    "サブコマンド:",
    ...Object.entries(SUBCOMMANDS).map(([name, description]) => `  ${name.padEnd(width)}  ${description}`),
    "",
    "オプション:",
    `  ${"--help".padEnd(width)}  この使い方を表示する`,
    `  ${"--version".padEnd(width)}  版を表示する`,
    "",
    "env ファイル（既定 ~/.config/self-agent/env。SELF_AGENT_ENV_FILE で変えられる）を読んでから動かします（既にある環境変数は上書きしません）",
  ].join("\n");
}

/** パッケージの直下（このファイルの親）の package.json の version。無ければ DEV_VERSION */
export function packageVersion(packageJsonPath: string = join(import.meta.dirname, "..", "package.json")): string {
  try {
    const version: unknown = JSON.parse(readFileSync(packageJsonPath, "utf8")).version;
    return typeof version === "string" && version !== "" ? version : DEV_VERSION;
  } catch {
    return DEV_VERSION;
  }
}

function isSubcommand(name: string | undefined): name is SubcommandName {
  return name !== undefined && Object.hasOwn(SUBCOMMANDS, name);
}

/** サブコマンドの本体を動かす。exit コードを返す。start は main.ts が自分で終わるので undefined */
async function runSubcommand(name: SubcommandName, argv: readonly string[]): Promise<number | undefined> {
  switch (name) {
    case "start":
      // main.ts は top-level の script のまま（読み込むと起動する）
      await import("./main.ts");
      return undefined;
    case "devlog":
      return (await import("./cli/devlog.ts")).main(argv);
    case "usage":
      return (await import("./cli/usage.ts")).main(argv);
    case "guest-setup":
      return (await import("./cli/guest-setup.ts")).main(argv);
    case "github-dry-run":
      return (await import("./cli/github-dry-run.ts")).main(argv);
    case "shell-check":
      return (await import("./cli/shell-check.ts")).main(argv);
    case "job-dry-run":
      return (await import("./cli/job-dry-run.ts")).main(argv);
    case "measure":
      return (await import("./cli/measure.ts")).main(argv);
  }
}

export type CliDeps = {
  /** 標準出力・標準エラーへの 1 回の出力。既定は console.log・console.error */
  out?: (text: string) => void;
  err?: (text: string) => void;
  /** env ファイルを読む。既定は envFilePath() の場所を loadEnv で */
  loadEnv?: () => LoadEnvResult;
  /** サブコマンドの本体。既定は runSubcommand */
  run?: (name: SubcommandName, argv: readonly string[]) => Promise<number | undefined>;
  /** --version で出す版。既定は packageVersion() */
  version?: () => string;
};

/**
 * argv（node と cli.ts の後ろ）を振り分ける。--help は使い方を標準出力に出して 0、--version は版を出して 0、
 * サブコマンドが無い・知らない名前は使い方を標準エラーに出して 2。env ファイルが読めなければ（無いのはよい）1。
 * それ以外はサブコマンドの本体の結果（start は undefined。呼び出し側は exit しない）
 */
export async function runCli(argv: readonly string[], deps: CliDeps = {}): Promise<number | undefined> {
  const out = deps.out ?? ((text: string) => console.log(text));
  const err = deps.err ?? ((text: string) => console.error(text));
  const [name, ...rest] = argv;
  if (name === "--help") {
    out(usageText());
    return 0;
  }
  if (name === "--version") {
    out((deps.version ?? packageVersion)());
    return 0;
  }
  if (!isSubcommand(name)) {
    if (name !== undefined) err(`知らないサブコマンドです: ${name}`);
    err(usageText());
    return 2;
  }
  // パス・変数名・中身は出さない
  if ((deps.loadEnv ?? (() => loadEnv(envFilePath())))() === "failed") {
    err("env ファイルを読めませんでした");
    return 1;
  }
  return (deps.run ?? runSubcommand)(name, rest);
}

if (import.meta.main) {
  const code = await runCli(process.argv.slice(2));
  if (code !== undefined) process.exit(code);
}
