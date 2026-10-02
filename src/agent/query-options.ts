// プロンプトキャッシュを効かせるため、全ターンで同じ Options を使う（resume だけ run 側で足す）
import type { McpSdkServerConfigWithInstance, Options } from "@anthropic-ai/claude-agent-sdk";
import type { Config } from "../config.ts";
import { SYSTEM_PROMPT } from "./system-prompt.ts";
import { MCP_SERVER_NAME } from "./tools.ts";

const MAX_TURNS = 8;

// Claude の子プロセスには不要な秘密を渡さない
const ENV_DENYLIST = ["DISCORD_TOKEN"];

function childEnv(): Record<string, string | undefined> {
  return Object.fromEntries(Object.entries(process.env).filter(([key]) => !ENV_DENYLIST.includes(key)));
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
    maxTurns: MAX_TURNS,
    // 未設定ならモデルの既定に任せる（キーごと入れない）
    ...(cfg.effort === undefined ? {} : { effort: cfg.effort }),
    env: {
      ...childEnv(),
      CLAUDE_CONFIG_DIR: cfg.claudeConfigDir,
      CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1",
    },
  };
}
