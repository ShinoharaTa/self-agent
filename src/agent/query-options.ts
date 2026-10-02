// プロンプトキャッシュを効かせるため、全ターンで同じ Options を使う（resume だけ run 側で足す）
import type { McpSdkServerConfigWithInstance, Options } from "@anthropic-ai/claude-agent-sdk";
import type { Config } from "../config.ts";
import { SYSTEM_PROMPT } from "./system-prompt.ts";
import { MCP_SERVER_NAME } from "./tools.ts";

const MAX_TURNS = 8;

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
  "HTTPS_PROXY",
  "HTTP_PROXY",
  "NO_PROXY",
  "https_proxy",
  "http_proxy",
  "no_proxy",
  "CLAUDE_CODE_OAUTH_TOKEN",
];

/**
 * Claude の子プロセスの env。SDK は env を渡すと process.env と混ぜずに置き換えるので、許可した変数だけを写し
 * （無いものは入れない）、設定ディレクトリと自動メモリ無効を足す。scripts/measure-turn.ts も使う
 */
export function childEnv(claudeConfigDir: string, source: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const env: Record<string, string> = {};
  for (const key of CHILD_ENV_ALLOWLIST) {
    const value = source[key];
    if (value !== undefined) env[key] = value;
  }
  env.CLAUDE_CONFIG_DIR = claudeConfigDir;
  env.CLAUDE_CODE_DISABLE_AUTO_MEMORY = "1";
  return env;
}

export function buildQueryOptions(
  cfg: Pick<Config, "model" | "workDir" | "claudeConfigDir" | "effort">,
  mcpServer: McpSdkServerConfigWithInstance,
): Options {
  return {
    model: cfg.model,
    systemPrompt: SYSTEM_PROMPT,
    settingSources: [],
    cwd: cfg.workDir,
    // 組み込みツールは無効。自前の MCP ツールだけを許可し、それ以外は dontAsk で拒否する
    tools: [],
    permissionMode: "dontAsk",
    allowedTools: [`mcp__${MCP_SERVER_NAME}__*`],
    mcpServers: { [MCP_SERVER_NAME]: mcpServer },
    // mcpServers 以外の MCP 設定（.mcp.json・ユーザー設定・プラグイン）は読まない
    strictMcpConfig: true,
    maxTurns: MAX_TURNS,
    // 未設定ならモデルの既定に任せる（キーごと入れない）
    ...(cfg.effort === undefined ? {} : { effort: cfg.effort }),
    env: childEnv(cfg.claudeConfigDir),
  };
}
