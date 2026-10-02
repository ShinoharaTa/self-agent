import { join } from "node:path";

/** Agent SDK の effort と同じ値。config は SDK に依存させないので独自に定義する */
export const EFFORT_LEVELS = ["low", "medium", "high", "xhigh", "max"] as const;
export type Effort = (typeof EFFORT_LEVELS)[number];

export type Config = {
  /** CLAUDE_CODE_OAUTH_TOKEN が設定されているか。値そのものは保持しない */
  oauthTokenPresent: boolean;
  /** DISCORD_TOKEN が設定されているか。値そのものは保持しない（discord-gateway が process.env から直接読む） */
  discordTokenPresent: boolean;
  claudeConfigDir: string;
  workDir: string;
  model: string;
  ownerUserId: string | undefined;
  /** 動作を許可するサーバー（ギルド）の ID。これ以外のサーバーと DM では一切反応しない */
  allowedGuildIds: string[];
  /** 任意。/setup を実行していないサーバーで #inbox とみなすチャンネル（P3 で廃止） */
  inboxChannelId: string | undefined;
  /** SQLite などの保存先。DB は `${dataDir}/self-agent.db` */
  dataDir: string;
  timeZone: string;
  maxConcurrentTurns: number;
  /** 1 ターンの打ち切りまでの秒数 */
  turnTimeoutSec: number;
  /** 未設定ならモデルの既定。プロセス内で固定（セッション途中で変えるとキャッシュが崩れるため） */
  effort: Effort | undefined;
  /** チャンネルのカテゴリ移動の間隔（ミリ秒）。全サーバーで 1 本の列にして、この間を空ける */
  channelOpGapMs: number;
};

const DEFAULT_MODEL = "claude-opus-5";
const DEFAULT_TIME_ZONE = "Asia/Tokyo";
const DEFAULT_MAX_CONCURRENT_TURNS = 2;
const DEFAULT_TURN_TIMEOUT_SEC = 300;
const DEFAULT_CHANNEL_OP_GAP_MS = 2000;

function nonEmpty(value: string | undefined): string | undefined {
  return value === undefined || value === "" ? undefined : value;
}

/** カンマ区切りの Discord ID の一覧。数字以外を含む要素があればエラー */
function idList(name: string, value: string | undefined): string[] {
  if (value === undefined) return [];
  const ids = value
    .split(",")
    .map((id) => id.trim())
    .filter((id) => id !== "");
  for (const id of ids) {
    if (!/^\d+$/.test(id)) {
      throw new Error(`${name} は数字の ID をカンマ区切りで指定してください`);
    }
  }
  return [...new Set(ids)];
}

function effortLevel(value: string | undefined): Effort | undefined {
  if (value === undefined) return undefined;
  const level = EFFORT_LEVELS.find((candidate) => candidate === value);
  if (level === undefined) {
    throw new Error(`SELF_AGENT_EFFORT は ${EFFORT_LEVELS.join(" / ")} のいずれかで指定してください`);
  }
  return level;
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
    allowedGuildIds: idList("SELF_AGENT_ALLOWED_GUILD_IDS", nonEmpty(env.SELF_AGENT_ALLOWED_GUILD_IDS)),
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
    effort: effortLevel(nonEmpty(env.SELF_AGENT_EFFORT)),
    channelOpGapMs: positiveInteger(
      "SELF_AGENT_CHANNEL_OP_GAP_MS",
      nonEmpty(env.SELF_AGENT_CHANNEL_OP_GAP_MS),
      DEFAULT_CHANNEL_OP_GAP_MS,
    ),
  };
}

/** 起動に必須で欠けている環境変数の名前（値は含めない） */
export function missingForStart(cfg: Config): string[] {
  const missing: string[] = [];
  if (!cfg.oauthTokenPresent) missing.push("CLAUDE_CODE_OAUTH_TOKEN");
  if (!cfg.discordTokenPresent) missing.push("DISCORD_TOKEN");
  if (cfg.ownerUserId === undefined) missing.push("SELF_AGENT_OWNER_ID");
  if (cfg.allowedGuildIds.length === 0) missing.push("SELF_AGENT_ALLOWED_GUILD_IDS");
  return missing;
}
