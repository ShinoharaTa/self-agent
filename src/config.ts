import { join } from "node:path";

export type Config = {
  /** CLAUDE_CODE_OAUTH_TOKEN が設定されているか。値そのものは保持しない */
  oauthTokenPresent: boolean;
  /** DISCORD_TOKEN が設定されているか。値そのものは保持しない（discord-gateway が process.env から直接読む） */
  discordTokenPresent: boolean;
  claudeConfigDir: string;
  workDir: string;
  model: string;
  ownerUserId: string | undefined;
  guildId: string | undefined;
  inboxChannelId: string | undefined;
  /** SQLite などの保存先。DB は `${dataDir}/self-agent.db` */
  dataDir: string;
  timeZone: string;
  maxConcurrentTurns: number;
  /** 1 ターンの打ち切りまでの秒数 */
  turnTimeoutSec: number;
};

const DEFAULT_MODEL = "claude-opus-5";
const DEFAULT_TIME_ZONE = "Asia/Tokyo";
const DEFAULT_MAX_CONCURRENT_TURNS = 2;
const DEFAULT_TURN_TIMEOUT_SEC = 300;

function nonEmpty(value: string | undefined): string | undefined {
  return value === undefined || value === "" ? undefined : value;
}

function positiveInteger(name: string, value: string | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  const parsed = /^\d+$/.test(value) ? Number(value) : Number.NaN;
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw new Error(`${name} は正の整数で指定してください`);
  }
  return parsed;
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
    discordTokenPresent: nonEmpty(env.DISCORD_TOKEN) !== undefined,
    claudeConfigDir:
      nonEmpty(env.CLAUDE_CONFIG_DIR) ?? join(home(), ".local/share/self-agent/claude"),
    workDir: nonEmpty(env.SELF_AGENT_WORKDIR) ?? join(home(), ".local/share/self-agent/work"),
    model: nonEmpty(env.SELF_AGENT_MODEL) ?? DEFAULT_MODEL,
    ownerUserId: nonEmpty(env.SELF_AGENT_OWNER_ID),
    guildId: nonEmpty(env.SELF_AGENT_GUILD_ID),
    inboxChannelId: nonEmpty(env.SELF_AGENT_INBOX_CHANNEL_ID),
    dataDir: nonEmpty(env.SELF_AGENT_DATA_DIR) ?? join(home(), ".local/share/self-agent/data"),
    timeZone: nonEmpty(env.SELF_AGENT_TZ) ?? DEFAULT_TIME_ZONE,
    maxConcurrentTurns: positiveInteger(
      "SELF_AGENT_MAX_CONCURRENT",
      nonEmpty(env.SELF_AGENT_MAX_CONCURRENT),
      DEFAULT_MAX_CONCURRENT_TURNS,
    ),
    turnTimeoutSec: positiveInteger(
      "SELF_AGENT_TURN_TIMEOUT_SEC",
      nonEmpty(env.SELF_AGENT_TURN_TIMEOUT_SEC),
      DEFAULT_TURN_TIMEOUT_SEC,
    ),
  };
}

/** 起動に必須で欠けている環境変数の名前（値は含めない） */
export function missingForStart(cfg: Config): string[] {
  const missing: string[] = [];
  if (!cfg.oauthTokenPresent) missing.push("CLAUDE_CODE_OAUTH_TOKEN");
  if (!cfg.discordTokenPresent) missing.push("DISCORD_TOKEN");
  if (cfg.ownerUserId === undefined) missing.push("SELF_AGENT_OWNER_ID");
  if (cfg.guildId === undefined) missing.push("SELF_AGENT_GUILD_ID");
  if (cfg.inboxChannelId === undefined) missing.push("SELF_AGENT_INBOX_CHANNEL_ID");
  return missing;
}
