import { join } from "node:path";

export type Config = {
  /** CLAUDE_CODE_OAUTH_TOKEN が設定されているか。値そのものは保持しない */
  oauthTokenPresent: boolean;
  claudeConfigDir: string;
  workDir: string;
  model: string;
};

const DEFAULT_MODEL = "claude-opus-5";

function nonEmpty(value: string | undefined): string | undefined {
  return value === undefined || value === "" ? undefined : value;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const home = (): string => {
    const value = nonEmpty(env.HOME);
    if (value === undefined) {
      throw new Error("HOME が設定されていないため既定のディレクトリを決められません");
    }
    return value;
  };

  return {
    oauthTokenPresent: nonEmpty(env.CLAUDE_CODE_OAUTH_TOKEN) !== undefined,
    claudeConfigDir:
      nonEmpty(env.CLAUDE_CONFIG_DIR) ?? join(home(), ".local/share/self-agent/claude"),
    workDir: nonEmpty(env.SELF_AGENT_WORKDIR) ?? join(home(), ".local/share/self-agent/work"),
    model: nonEmpty(env.SELF_AGENT_MODEL) ?? DEFAULT_MODEL,
  };
}
