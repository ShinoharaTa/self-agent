// プロンプトキャッシュを効かせるため、全ターンで同じ Options を使う（resume・maxTurns・hooks は run 側で足す）
import { lstatSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import type { McpSdkServerConfigWithInstance, Options, SandboxSettings } from "@anthropic-ai/claude-agent-sdk";
import type { Config } from "../config.ts";
import { WORK_CACHE_DIR_NAME, WORK_TMP_DIR_NAME } from "./disk.ts";
import { resolveRealPath } from "./file-access.ts";
import {
  nodeVersionDir,
  sandboxReadablePlaces,
  sandboxSecretPlaces,
  shellPath,
  type SandboxPlaces,
} from "./sandbox-check.ts";
import { SHELL_SYSTEM_PROMPT, SYSTEM_PROMPT } from "./system-prompt.ts";
import { MCP_SERVER_NAME } from "./tools.ts";

/** ホストのプロキシの変数。シェルが有効なときは子プロセスに写さない（認証情報を含みうる。sandbox は自分のプロキシを設定する。shell.md §2.4） */
const PROXY_ENV_KEYS = ["HTTPS_PROXY", "HTTP_PROXY", "NO_PROXY", "https_proxy", "http_proxy", "no_proxy"];

/** Claude の子プロセスに渡す環境変数（許可方式）。これ以外（DISCORD_TOKEN など）は渡さない */
const CHILD_ENV_ALLOWLIST = [
  "PATH",
  "HOME",
  "USER",
  "LANG",
  "LC_ALL",
  "TZ",
  "TMPDIR",
  "NODE_EXTRA_CA_CERTS",
  ...PROXY_ENV_KEYS,
  "CLAUDE_CODE_OAUTH_TOKEN",
];

/** 1 コマンドの既定と上限の時間（ミリ秒。shell.md §2.4・§2.6） */
export const BASH_DEFAULT_TIMEOUT_MS = 120_000;
export const BASH_MAX_TIMEOUT_MS = 300_000;

/** シェルが有効なときに childEnv に渡すもの。workDir は実際の場所（.tmp・.cache を置く） */
export type ChildEnvShell = { workDir: string; execPath: string };

/**
 * CLI が cwd から作る会話の記録のディレクトリ名と同じ規則（docs sessions.md。英数字以外を `-` に置き換える）で、パスから作る名前。1〜64 字でなければ undefined。
 * cwd を `<workDir>/cwd` に変えても記録の場所を変えないために CLAUDE_CODE_PROJECT_DIR_NAME で固定する（#139）。
 * CLI は cwd を realpath にしてから名前を作るので、呼び出し側は実際の場所（projectDirNameFor）を渡す
 */
export function projectDirName(path: string): string | undefined {
  const name = path.replace(/[^A-Za-z0-9]/g, "-");
  return name.length >= 1 && name.length <= 64 ? name : undefined;
}

/** workDir の実際の場所（末尾の `/`・相対パス・symlink を解いたもの。今まで CLI が cwd から作っていた名前）から作る記録のディレクトリ名 */
export function projectDirNameFor(workDir: string): string | undefined {
  return projectDirName(realPath(workDir));
}

/**
 * Claude の子プロセスの env。SDK は env を渡すと process.env と混ぜずに置き換えるので、許可した変数だけを写し
 * （無いものは入れない）、設定ディレクトリと自動メモリ無効を足す。記録の場所は CLAUDE_CODE_PROJECT_DIR_NAME（projectDirName(workDir)）で固定する。
 * scripts/measure-turn.ts も使う。
 * shell（SELF_AGENT_SHELL=1）なら shell.md §2.4: プロキシの変数と TMPDIR はホストから写さず（TMPDIR は <workDir>/.tmp）、PATH を shellPath にし、一時ファイル・npm のキャッシュの場所、
 * git の設定、Bash の時間、バックグラウンド実行の無効を足す
 */
export function childEnv(
  claudeConfigDir: string,
  workDir: string,
  source: NodeJS.ProcessEnv = process.env,
  shell?: ChildEnvShell,
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const key of CHILD_ENV_ALLOWLIST) {
    if (shell !== undefined && (PROXY_ENV_KEYS.includes(key) || key === "TMPDIR")) continue;
    const value = source[key];
    if (value !== undefined) env[key] = value;
  }
  env.CLAUDE_CONFIG_DIR = claudeConfigDir;
  const projectDir = projectDirNameFor(workDir);
  if (projectDir !== undefined) env.CLAUDE_CODE_PROJECT_DIR_NAME = projectDir;
  env.CLAUDE_CODE_DISABLE_AUTO_MEMORY = "1";
  if (shell === undefined) return env;
  return {
    ...env,
    // service の PATH には nvm が無いので、自己診断と同じ PATH（bwrap・socat もここから探す）
    PATH: shellPath(shell.execPath),
    // 他の Claude Code と共有の /tmp/claude を使わない（/tmp は sandbox から読めない）
    TMPDIR: join(shell.workDir, WORK_TMP_DIR_NAME),
    CLAUDE_CODE_TMPDIR: join(shell.workDir, WORK_TMP_DIR_NAME),
    npm_config_cache: join(shell.workDir, WORK_CACHE_DIR_NAME, "npm"),
    npm_config_update_notifier: "false",
    npm_config_fund: "false",
    npm_config_audit: "false",
    // 非公開リポジトリで認証を待たずにすぐ失敗する。ホストの git の設定は読まない
    GIT_TERMINAL_PROMPT: "0",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    BASH_DEFAULT_TIMEOUT_MS: String(BASH_DEFAULT_TIMEOUT_MS),
    BASH_MAX_TIMEOUT_MS: String(BASH_MAX_TIMEOUT_MS),
    CLAUDE_CODE_DISABLE_BACKGROUND_TASKS: "1",
  };
}

/**
 * 権限ルールの `<realpath(workDir)>/projects` の下すべて（`//` で始まる絶対パスの形）。
 * 許可ルールは symlink の先も一致しないと効かないので、実際の場所で書く
 */
function projectsRulePath(workDir: string): string {
  return `//${join(realPath(workDir), "projects").replace(/^\/+/, "")}/**`;
}

/** 実際の場所（解決できなければ絶対パスにしただけのもの） */
function realPath(path: string): string {
  return resolveRealPath(path) ?? resolve(path);
}

/** sandbox が通してよいホスト（shell.md §2.2。git clone・codeload・GitHub の配布物・npm） */
export const SANDBOX_ALLOWED_DOMAINS: readonly string[] = [
  "github.com",
  "codeload.github.com",
  "raw.githubusercontent.com",
  "objects.githubusercontent.com",
  "release-assets.githubusercontent.com",
  "registry.npmjs.org",
];

/** sandbox から読ませない OS の場所（shell.md §2.2。ホーム・他のサービスのソケット・ログ） */
export const SANDBOX_DENY_READ_SYSTEM: readonly string[] = [
  "~",
  "/tmp",
  "/var/tmp",
  "/dev/shm",
  "/run",
  "/var/run",
  "/var/log",
  "/media",
  "/mnt",
];

/** 作業ジョブの作業場所（`<workDir>/jobs`。docs/plan/coding-jobs.md §4.1）。セッションの sandbox からは読ませない */
export const JOBS_DIR_NAME = "jobs";

/** CLI の cwd（`<workDir>/cwd`。空の専用ディレクトリで、sandbox からは読み取り専用。#139） */
export const WORK_CWD_DIR_NAME = "cwd";

/** sandbox が書ける workDir の中の場所（allowWrite）。無いと CLI が書き込み先から外すので、run の前に作る（ensureSandboxWriteDirs） */
const SANDBOX_WRITE_DIR_NAMES: readonly string[] = ["projects", WORK_CACHE_DIR_NAME, WORK_TMP_DIR_NAME];

/**
 * Options.sandbox（shell.md §2.2。全 run で同じ値）。場所は sandbox-check.ts と同じ関数（sandboxSecretPlaces・sandboxReadablePlaces）から作り、
 * 実際の場所で書く。denyRead には作業ジョブの作業場所（<realpath(workDir)>/jobs）も入れる
 */
export function sandboxSettings(places: SandboxPlaces): SandboxSettings {
  const workDir = realPath(places.workDir);
  return {
    enabled: true,
    failIfUnavailable: true,
    autoAllowBashIfSandboxed: true,
    allowUnsandboxedCommands: false,
    network: { allowedDomains: [...SANDBOX_ALLOWED_DOMAINS], strictAllowlist: true },
    filesystem: {
      denyRead: [...SANDBOX_DENY_READ_SYSTEM, ...sandboxSecretPlaces(places).map(realPath), join(workDir, JOBS_DIR_NAME)],
      allowRead: sandboxReadablePlaces(places).map(realPath),
      allowWrite: SANDBOX_WRITE_DIR_NAMES.map((name) => join(workDir, name)),
      // cwd は CLI の既定で書けるので denyWrite で読み取り専用にする（denyWrite が書き込み先を覆うと CLI はその場所を読み取り専用で bind する）。#139
      denyWrite: [join(workDir, WORK_CWD_DIR_NAME)],
    },
    credentials: { envVars: [{ name: "CLAUDE_CODE_OAUTH_TOKEN", mode: "deny" }] },
  };
}

/**
 * sandbox の書き込み先（projects・.cache・.tmp）と、denyRead に入れる作業ジョブの場所（jobs）、CLI の cwd（ensureCwdDir）を作る（.cache は掃除で丸ごと消えることがある）。
 * jobs が実際のディレクトリでない（symlink・ファイル）なら作らずに投げる（denyRead が symlink の先に向かないように）。失敗したら投げる
 */
export function ensureSandboxWriteDirs(workDir: string): void {
  const real = realPath(workDir);
  for (const name of SANDBOX_WRITE_DIR_NAMES) mkdirSync(join(real, name), { recursive: true });
  const jobs = join(real, JOBS_DIR_NAME);
  try {
    const stats = lstatSync(jobs);
    if (stats.isSymbolicLink() || !stats.isDirectory()) throw new Error("作業ジョブの場所が実際のディレクトリではありません");
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
    mkdirSync(jobs);
  }
  ensureCwdDir(workDir);
}

/**
 * CLI の cwd（`<realpath(workDir)>/cwd`）を作る（700）。既にあれば何もしない。symlink かディレクトリでなければ投げる
 * （denyWrite が symlink の先に向かないように）。作ったか既にあるパスを返す
 */
export function ensureCwdDir(workDir: string): string {
  const path = join(realPath(workDir), WORK_CWD_DIR_NAME);
  try {
    const stats = lstatSync(path);
    if (stats.isSymbolicLink() || !stats.isDirectory()) {
      throw new Error("CLI の作業ディレクトリ（<workDir>/cwd）が実際のディレクトリではありません");
    }
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
    mkdirSync(path, { mode: 0o700 });
  }
  return path;
}

/** このプロセスの場所（node・リポジトリ・ホーム）と env。テストでは差し替える */
export type SandboxHost = { execPath: string; cwd: string; homeDir: string; env: NodeJS.ProcessEnv };

export function defaultSandboxHost(): SandboxHost {
  return { execPath: process.execPath, cwd: process.cwd(), homeDir: homedir(), env: process.env };
}

/** sandbox の場所（自己診断と Options.sandbox で共通）。リポジトリは cwd、node の版のディレクトリは execPath の 2 つ上 */
export function sandboxPlacesOf(
  cfg: Pick<Config, "workDir" | "dataDir" | "claudeConfigDir">,
  host: Pick<SandboxHost, "execPath" | "cwd" | "homeDir">,
): SandboxPlaces {
  return {
    workDir: cfg.workDir,
    nodeDir: nodeVersionDir(host.execPath),
    dataDir: cfg.dataDir,
    claudeConfigDir: cfg.claudeConfigDir,
    repoDir: host.cwd,
    homeDir: host.homeDir,
  };
}

/** 組み込みツール。キャッシュのため順序も固定。シェルが有効なら末尾に Bash（shell.md §5.1） */
const BUILTIN_TOOLS = ["WebSearch", "WebFetch", "Read", "Write", "Edit", "Glob"];

/**
 * systemPrompt は人格のシステムプロンプト（system-prompt.ts の personaSystemPrompts）。省略すれば既定の人格のもの（シェルが有効なら SHELL_SYSTEM_PROMPT）。
 * shell（SELF_AGENT_SHELL=1）なら Bash をツールに足し、env を shell.md §2.4 にする。sandbox（自己診断が通っていて bwrap・socat がある run）なら
 * Options.sandbox を付ける（shell でなければ付けない）。dataDir は shell のときだけ要る
 */
export function buildQueryOptions(
  cfg: Pick<Config, "model" | "workDir" | "claudeConfigDir" | "effort"> & {
    systemPrompt?: string;
    shell?: boolean;
    dataDir?: string;
  },
  mcpServer: McpSdkServerConfigWithInstance,
  sandbox = false,
  host: SandboxHost = defaultSandboxHost(),
): Options {
  const shell = cfg.shell === true;
  const projects = projectsRulePath(cfg.workDir);
  // Options.sandbox を付ける run か（allowedTools の Bash と同じ条件で使う）
  const sandboxed = shell && sandbox;
  const sandboxOption = (): { sandbox?: SandboxSettings } => {
    if (!sandboxed) return {};
    if (cfg.dataDir === undefined) throw new Error("sandbox の設定には dataDir が要ります");
    return { sandbox: sandboxSettings(sandboxPlacesOf({ ...cfg, dataDir: cfg.dataDir }, host)) };
  };
  return {
    model: cfg.model,
    // snapshot: false で、SDK にセッション初回のプロンプトを記録させず毎回この SYSTEM_PROMPT を送る（直したプロンプトが既存のセッションにも次のターンから届く。
    // 変えたターンだけ全セッションでキャッシュが 1 回外れる。#69 で実測）。既定（記録する）に戻すと各セッションの最初の記録に戻るので戻さない
    systemPrompt: {
      type: "custom",
      prompt: cfg.systemPrompt ?? (shell ? SHELL_SYSTEM_PROMPT : SYSTEM_PROMPT),
      snapshot: false,
    },
    settingSources: [],
    // cwd は <workDir>/cwd（空の専用ディレクトリ。sandbox からは読み取り専用。記録の場所は childEnv の CLAUDE_CODE_PROJECT_DIR_NAME で今までの名前に固定。#139）
    cwd: join(cfg.workDir, WORK_CWD_DIR_NAME),
    // 組み込みツールは Web の 2 つとファイル操作の 4 つ（シェルが有効ならその後に Bash）。キャッシュのため順序も固定。
    // WebFetch の URL とファイル操作のパス、Bash を使える場面は sdk-runner の PreToolUse の hook で絞る。
    // 許可するのは自前の MCP ツール・Web の 2 つと、<workDir>/projects の下の読み書き（Edit のルールは Write にも、Read のルールは Glob にも効く）。
    // Bash は sandbox を付ける run だけ許可に入れる（autoAllowBashIfSandboxed は `$?` などの展開を含むコマンドを通さず通常の許可の流れに回すため。#135）。
    // sandbox を付けない run は hook が全部拒否し、dontAsk でも拒否される。fail-closed は failIfUnavailable と allowUnsandboxedCommands: false で保つ
    tools: shell ? [...BUILTIN_TOOLS, "Bash"] : [...BUILTIN_TOOLS],
    permissionMode: "dontAsk",
    allowedTools: [
      `mcp__${MCP_SERVER_NAME}__*`,
      "WebSearch",
      "WebFetch",
      `Read(${projects})`,
      `Edit(${projects})`,
      ...(sandboxed ? ["Bash"] : []),
    ],
    mcpServers: { [MCP_SERVER_NAME]: mcpServer },
    // mcpServers 以外の MCP 設定（.mcp.json・ユーザー設定・プラグイン）は読まない
    strictMcpConfig: true,
    // 未設定ならモデルの既定に任せる（キーごと入れない）
    ...(cfg.effort === undefined ? {} : { effort: cfg.effort }),
    env: childEnv(
      cfg.claudeConfigDir,
      cfg.workDir,
      host.env,
      shell ? { workDir: realPath(cfg.workDir), execPath: host.execPath } : undefined,
    ),
    ...sandboxOption(),
  };
}
