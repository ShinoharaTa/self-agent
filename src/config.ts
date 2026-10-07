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
  /** 停止時（SIGINT / SIGTERM）に進行中のターンを待つ上限の秒数 */
  shutdownGraceSec: number;
  /** 進行中のセッションを、最後の発言からこの時間（時間単位）経ったら待ちに移す */
  idleHours: number;
  /** #inbox から session_open で自動で作れるセッションの 1 日（timeZone の日付）あたりの数 */
  autoSessionPerDay: number;
  /** 完了からこの日数経ったセッションについて、チャンネルを削除するか #system で確認する */
  deleteAfterDays: number;
  /** 毎日この時刻（timeZone）を過ぎたら #inbox の会話を要約して新しいセッションに切り替える */
  inboxRotateAt: TimeOfDay;
  /** #inbox の直近の成功したターンの最後のステップの入力（input + cache read + cache creation）がこれを超えたら、日次を待たずに切り替える */
  inboxMaxInputTokens: number;
  /** 任意。作ったプロジェクトを配る静的サーバーのポート（127.0.0.1 で待ち受ける）。これと publicBaseUrl のどちらかが無ければ機能ごと無効 */
  servePort?: number;
  /** 任意。プロジェクトの URL の前半（例 `https://<host>.<tailnet>.ts.net:9443`）。末尾の `/` は除いてある */
  publicBaseUrl?: string;
  /** 任意。設定すると、静的サーバーは Tailscale-User-Login ヘッダがこれと一致しない要求を拒否する */
  serveAllowedLogin?: string;
  /** セッションのチャンネルの 1 ターンの手順（maxTurns）の上限 */
  sessionMaxTurns: number;
  /** セッションのチャンネルの 1 ターンの打ち切りまでの秒数 */
  sessionTurnTimeoutSec: number;
};

/** 1 日の中の時刻（時は 0〜23、分は 0〜59） */
export type TimeOfDay = { hour: number; minute: number };

const DEFAULT_MODEL = "claude-opus-5";
const DEFAULT_TIME_ZONE = "Asia/Tokyo";
const DEFAULT_MAX_CONCURRENT_TURNS = 2;
const DEFAULT_TURN_TIMEOUT_SEC = 300;
const DEFAULT_CHANNEL_OP_GAP_MS = 2000;
const DEFAULT_SHUTDOWN_GRACE_SEC = 30;
const DEFAULT_IDLE_HOURS = 12;
const DEFAULT_AUTO_SESSION_PER_DAY = 3;
const DEFAULT_DELETE_AFTER_DAYS = 30;
const DEFAULT_INBOX_ROTATE_AT: TimeOfDay = { hour: 4, minute: 0 };
const DEFAULT_INBOX_MAX_INPUT_TOKENS = 150000;
const DEFAULT_SESSION_MAX_TURNS = 40;
const DEFAULT_SESSION_TURN_TIMEOUT_SEC = 900;

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

/** 1〜65535 の整数。それ以外はエラー */
function port(name: string, value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const parsed = /^\d+$/.test(value) ? Number(value) : Number.NaN;
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > 65535) {
    throw new Error(`${name} は 1〜65535 の整数で指定してください`);
  }
  return parsed;
}

/** `http://` か `https://` で始まる URL。末尾の `/` は除く。それ以外はエラー */
function baseUrl(name: string, value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const trimmed = value.replace(/\/+$/, "");
  if (!/^https?:\/\//.test(trimmed)) {
    throw new Error(`${name} は http:// か https:// で始まる URL で指定してください`);
  }
  return trimmed;
}

/** `HH:MM`（00:00〜23:59、時・分とも 2 桁）。それ以外はエラー */
function timeOfDay(name: string, value: string | undefined, fallback: TimeOfDay): TimeOfDay {
  if (value === undefined) return fallback;
  const match = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(value);
  if (match === null) {
    throw new Error(`${name} は HH:MM（00:00〜23:59）で指定してください`);
  }
  return { hour: Number(match[1]), minute: Number(match[2]) };
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
    shutdownGraceSec: positiveInteger(
      "SELF_AGENT_SHUTDOWN_GRACE_SEC",
      nonEmpty(env.SELF_AGENT_SHUTDOWN_GRACE_SEC),
      DEFAULT_SHUTDOWN_GRACE_SEC,
    ),
    idleHours: positiveInteger("SELF_AGENT_IDLE_HOURS", nonEmpty(env.SELF_AGENT_IDLE_HOURS), DEFAULT_IDLE_HOURS),
    autoSessionPerDay: positiveInteger(
      "SELF_AGENT_AUTO_SESSION_PER_DAY",
      nonEmpty(env.SELF_AGENT_AUTO_SESSION_PER_DAY),
      DEFAULT_AUTO_SESSION_PER_DAY,
    ),
    deleteAfterDays: positiveInteger(
      "SELF_AGENT_DELETE_AFTER_DAYS",
      nonEmpty(env.SELF_AGENT_DELETE_AFTER_DAYS),
      DEFAULT_DELETE_AFTER_DAYS,
    ),
    inboxRotateAt: timeOfDay(
      "SELF_AGENT_INBOX_ROTATE_AT",
      nonEmpty(env.SELF_AGENT_INBOX_ROTATE_AT),
      DEFAULT_INBOX_ROTATE_AT,
    ),
    inboxMaxInputTokens: positiveInteger(
      "SELF_AGENT_INBOX_MAX_INPUT_TOKENS",
      nonEmpty(env.SELF_AGENT_INBOX_MAX_INPUT_TOKENS),
      DEFAULT_INBOX_MAX_INPUT_TOKENS,
    ),
    servePort: port("SELF_AGENT_SERVE_PORT", nonEmpty(env.SELF_AGENT_SERVE_PORT)),
    publicBaseUrl: baseUrl("SELF_AGENT_PUBLIC_BASE_URL", nonEmpty(env.SELF_AGENT_PUBLIC_BASE_URL)),
    serveAllowedLogin: nonEmpty(env.SELF_AGENT_SERVE_ALLOWED_LOGIN),
    sessionMaxTurns: positiveInteger(
      "SELF_AGENT_SESSION_MAX_TURNS",
      nonEmpty(env.SELF_AGENT_SESSION_MAX_TURNS),
      DEFAULT_SESSION_MAX_TURNS,
    ),
    sessionTurnTimeoutSec: positiveInteger(
      "SELF_AGENT_SESSION_TURN_TIMEOUT_SEC",
      nonEmpty(env.SELF_AGENT_SESSION_TURN_TIMEOUT_SEC),
      DEFAULT_SESSION_TURN_TIMEOUT_SEC,
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
