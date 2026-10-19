import { join } from "node:path";
import { normalizeChannelName } from "./discord/channel-name.ts";

/** Agent SDK の effort と同じ値。config は SDK に依存させないので独自に定義する */
export const EFFORT_LEVELS = ["low", "medium", "high", "xhigh", "max"] as const;
export type Effort = (typeof EFFORT_LEVELS)[number];

/** 既定の人格（今の Bot。DISCORD_TOKEN・SELF_AGENT_MODEL などの今の変数で動く）の id。予約語で、SELF_AGENT_PERSONAS には書けない */
export const DEFAULT_PERSONA_ID = "default";

/** 人格のターンを動かすエンジン */
export const ENGINES = ["claude", "codex"] as const;
export type Engine = (typeof ENGINES)[number];

/** SELF_AGENT_PERSONAS で足した人格（docs/plan/personas.md §1）。既定の人格は含まない。トークンは変数名だけを持ち、値は持たない */
export type PersonaConfig = {
  /** `[a-z0-9]{1,12}`。DB のキーになるので後から変えない */
  id: string;
  /** 表示名（20 字以内）。未設定なら id */
  name: string;
  /** その人格の Bot のトークンの変数名（SELF_AGENT_PERSONA_<ID>_DISCORD_TOKEN）。値は Gateway が process.env から読む */
  discordTokenEnv: string;
  /** 人格の文（性格・口調・役割）のファイル。起動時に 1 回読む */
  promptFile: string;
  /** 未設定ならそのエンジンの既定（claude なら SELF_AGENT_MODEL） */
  model: string | undefined;
} & (
  | { engine: "claude"; effort: Effort | undefined }
  /** codex の effort の値は codex のエンジン（PR-F）で確かめる。ここでは小文字の英字だけを受け付ける */
  | { engine: "codex"; effort: string | undefined }
);

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
  /** 毎日この時刻（timeZone）を過ぎたら #inbox・#tasks の会話を要約して新しいセッションに切り替える */
  inboxRotateAt: TimeOfDay;
  /** #inbox・#tasks の直近の成功したターンの最後のステップの入力（input + cache read + cache creation）がこれを超えたら、日次を待たずに切り替える */
  inboxMaxInputTokens: number;
  /** 任意。作ったプロジェクトを配る静的サーバーのポート（127.0.0.1 で待ち受ける）。これと publicBaseUrl のどちらかが無ければ機能ごと無効 */
  servePort: number | undefined;
  /** 任意。プロジェクトの URL の前半（例 `https://<host>.<tailnet>.ts.net:9443`）。末尾の `/` は除いてある */
  publicBaseUrl: string | undefined;
  /** 任意。設定すると、静的サーバーは Tailscale-User-Login ヘッダがこれと一致しない要求を拒否する */
  serveAllowedLogin: string | undefined;
  /** セッションのチャンネルの 1 ターンの手順（maxTurns）の上限 */
  sessionMaxTurns: number;
  /** セッションのチャンネルの 1 ターンの打ち切りまでの秒数 */
  sessionTurnTimeoutSec: number;
  /** dev モード。true なら run ごとの会話を `${dataDir}/devlog/` に記録する */
  devMode: boolean;
  /** dev モードの会話ログを残す日数（これより前の日のファイルは tick で消す。dev モードでなくても消す） */
  devLogDays: number;
  /** シェル（Bash）を使う設定。true なら起動時と tick ごとに sandbox の自己診断を行う（agent/sandbox-check.ts・docs/plan/shell.md） */
  shell: boolean;
  /** SELF_AGENT_PERSONAS で足した人格（設定の順）。未設定なら空で、今と同じ 1 体だけ */
  personas: PersonaConfig[];
  /** codex の認証と会話の記録の場所。未設定で codex の人格も無ければ undefined */
  codexHome: string | undefined;
} & GithubConfig &
  JobsConfig;

/** GitHub の通知の段 1（docs/plan/github-notifications.md §10）。npm run github-dry-run もこれだけを読む */
export type GithubConfig = {
  /** true なら GitHub の通知を取得して #github に流す（/setup も #github を作る）。false なら何もしない */
  github: boolean;
  /** ポーリングの間隔（秒、60 以上）。実際の間隔は直近の X-Poll-Interval との大きい方 */
  githubPollSec: number;
  /** 「自分のリポジトリ」とみなす持ち主（GitHub のログイン・org）。空なら gh のログイン 1 つ */
  githubOwners: string[];
};

/** 作業ジョブ（docs/plan/coding-jobs.md §14） */
export type JobsConfig = {
  /** true なら作業ジョブを使う（SELF_AGENT_SHELL=1 が要る）。PR-J4 まではいつも false（1 にすると設定エラー） */
  jobs: boolean;
  /** 対象にできるリポジトリ（`owner/*` か `owner/repo`。設定の順・重複は除く）。未設定なら空で、gh のログインの `<login>/*`（設定して中身が無ければ設定エラー） */
  jobsRepos: string[];
  /** 1 run の手順（maxTurns）の上限 */
  jobMaxTurns: number;
  /** 1 run の時間の上限（分。1440 まで） */
  jobTimeoutMin: number;
  /** 未設定なら既定の人格と同じ */
  jobModel: string | undefined;
  /** 未設定なら既定の人格と同じ */
  jobEffort: Effort | undefined;
  /** clone するリポジトリの大きさの上限（MB。GitHub の size） */
  jobsRepoMaxMb: number;
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
const DEFAULT_DEV_LOG_DAYS = 30;
const DEFAULT_GITHUB_POLL_SEC = 300;
const MIN_GITHUB_POLL_SEC = 60;
const DEFAULT_JOB_MAX_TURNS = 100;
const DEFAULT_JOB_TIMEOUT_MIN = 45;
/** SELF_AGENT_JOB_TIMEOUT_MIN の上限（1 日） */
const MAX_JOB_TIMEOUT_MIN = 1440;
const DEFAULT_JOBS_REPO_MAX_MB = 200;

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

function effortLevel(value: string | undefined, name = "SELF_AGENT_EFFORT"): Effort | undefined {
  if (value === undefined) return undefined;
  const level = EFFORT_LEVELS.find((candidate) => candidate === value);
  if (level === undefined) {
    throw new Error(`${name} は ${EFFORT_LEVELS.join(" / ")} のいずれかで指定してください`);
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

/** `1` なら true、未設定か `0` なら false。それ以外はエラー */
function flag(name: string, value: string | undefined): boolean {
  if (value === undefined || value === "0") return false;
  if (value === "1") return true;
  throw new Error(`${name} は 1（有効）か 0（無効）で指定してください`);
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

/** 既定のディレクトリの基準。既定のディレクトリが要るときだけ読む */
function homeDir(env: NodeJS.ProcessEnv): string {
  const value = nonEmpty(env.HOME);
  if (value === undefined) {
    throw new Error("HOME が設定されていないため既定のディレクトリを決められません");
  }
  return value;
}

/**
 * SQLite・dev ログの保存先と日付のタイムゾーンだけを読む。loadConfig と npm run devlog（トークンなど他の変数は読まない）で共通。
 * HOME は SELF_AGENT_DATA_DIR が無いときだけ読む
 */
export function loadDataConfig(env: NodeJS.ProcessEnv = process.env): Pick<Config, "dataDir" | "timeZone"> {
  return {
    dataDir: nonEmpty(env.SELF_AGENT_DATA_DIR) ?? join(homeDir(env), ".local/share/self-agent/data"),
    timeZone: nonEmpty(env.SELF_AGENT_TZ) ?? DEFAULT_TIME_ZONE,
  };
}

const PERSONA_ID = /^[a-z0-9]{1,12}$/;
const PERSONA_NAME_MAX_LENGTH = 20;
/** /setup が self-agent カテゴリに作るチャンネルの名前（github は SELF_AGENT_GITHUB=1 のときだけ作る）。足した人格の #<NAME> はこれと同じ名前にできない */
const RESERVED_CHANNEL_NAMES: readonly string[] = ["inbox", "tasks", "system", "github"];
/** 足せる人格の数の上限（/new の persona の選択肢を Discord の 25 個以内に、/usage を 1 メッセージの 2,000 字以内に収める） */
export const MAX_PERSONAS = 10;

/**
 * SELF_AGENT_PERSONAS と人格ごとの変数を読む（docs/plan/personas.md §1）。エラーには変数名だけを出し、値（トークンを含む）は出さない。
 * 確かめること: id の形・重複・予約語（default）・数（MAX_PERSONAS まで）、トークンの欠け、同じトークンを 2 人格に（既定の人格の DISCORD_TOKEN を含む）、表示名の長さ、
 * 表示名から作るチャンネル名（#<NAME>）が空にならない・inbox・tasks・system と重ならない・人格どうしで重ならない、エンジン、effort
 */
function personaList(env: NodeJS.ProcessEnv, home: () => string): PersonaConfig[] {
  const list = nonEmpty(env.SELF_AGENT_PERSONAS);
  if (list === undefined) return [];
  const ids = list
    .split(",")
    .map((id) => id.trim())
    .filter((id) => id !== "");
  const seen = new Set<string>();
  for (const id of ids) {
    if (!PERSONA_ID.test(id)) {
      throw new Error("SELF_AGENT_PERSONAS は英小文字と数字（1〜12 字）の id をカンマ区切りで指定してください");
    }
    if (id === DEFAULT_PERSONA_ID) {
      throw new Error(`SELF_AGENT_PERSONAS に ${DEFAULT_PERSONA_ID} は使えません（既定の人格の id です）`);
    }
    if (seen.has(id)) throw new Error(`SELF_AGENT_PERSONAS に同じ id（${id}）が 2 回あります`);
    seen.add(id);
  }
  if (ids.length > MAX_PERSONAS) throw new Error(`SELF_AGENT_PERSONAS に足せる人格は ${MAX_PERSONAS} までです`);

  // 同じトークンを 2 人格に渡していないか（値は比べるだけで、エラーには変数名を出す）
  const tokenOwners = new Map<string, string>();
  const defaultToken = nonEmpty(env.DISCORD_TOKEN?.trim());
  if (defaultToken !== undefined) tokenOwners.set(defaultToken, "DISCORD_TOKEN");
  // #<NAME> のチャンネル名 → その表示名の変数名（人格どうしの重なりを見る）
  const channelNameOwners = new Map<string, string>();

  return ids.map((id): PersonaConfig => {
    const prefix = `SELF_AGENT_PERSONA_${id.toUpperCase()}_`;
    const discordTokenEnv = `${prefix}DISCORD_TOKEN`;
    // 前後の空白は比べる前に除く（空白だけなら無いものとする）
    const token = nonEmpty(env[discordTokenEnv]?.trim());
    if (token === undefined) throw new Error(`${discordTokenEnv} が設定されていません`);
    const sameAs = tokenOwners.get(token);
    if (sameAs !== undefined) throw new Error(`${discordTokenEnv} と ${sameAs} に同じトークンが設定されています`);
    tokenOwners.set(token, discordTokenEnv);

    const name = nonEmpty(env[`${prefix}NAME`]) ?? id;
    if ([...name].length > PERSONA_NAME_MAX_LENGTH) {
      throw new Error(`${prefix}NAME は ${PERSONA_NAME_MAX_LENGTH} 字以内で指定してください`);
    }
    // 表示名は #<NAME> とセッションのチャンネル名の接頭辞になる（未設定なら id から作るので、エラーは NAME の変数名で出す）
    const channelName = normalizeChannelName(name);
    if (channelName === "") {
      throw new Error(`${prefix}NAME からチャンネル名を作れません（英数字か日本語を含めてください）`);
    }
    if (RESERVED_CHANNEL_NAMES.includes(channelName)) {
      throw new Error(`${prefix}NAME は ${RESERVED_CHANNEL_NAMES.join("・")} と同じチャンネル名になるため使えません`);
    }
    const sameName = channelNameOwners.get(channelName);
    if (sameName !== undefined) throw new Error(`${prefix}NAME と ${sameName} が同じチャンネル名になります`);
    channelNameOwners.set(channelName, `${prefix}NAME`);
    const promptFile =
      nonEmpty(env[`${prefix}PROMPT_FILE`]) ?? join(home(), ".config/self-agent/personas", `${id}.md`);
    const model = nonEmpty(env[`${prefix}MODEL`]);
    const engineName = `${prefix}ENGINE`;
    const engineValue = nonEmpty(env[engineName]) ?? "claude";
    const effortName = `${prefix}EFFORT`;
    const effortValue = nonEmpty(env[effortName]);
    const base = { id, name, discordTokenEnv, promptFile, model };
    if (engineValue === "claude") return { ...base, engine: "claude", effort: effortLevel(effortValue, effortName) };
    if (engineValue === "codex") {
      if (effortValue !== undefined && !/^[a-z]+$/.test(effortValue)) {
        throw new Error(`${effortName} は英小文字で指定してください`);
      }
      return { ...base, engine: "codex", effort: effortValue };
    }
    throw new Error(`${engineName} は ${ENGINES.join(" / ")} のいずれかで指定してください`);
  });
}

const GITHUB_OWNER = /^[A-Za-z0-9-]{1,39}$/;

/** SELF_AGENT_GITHUB・SELF_AGENT_GITHUB_POLL_SEC・SELF_AGENT_GITHUB_OWNERS を読む。loadConfig と npm run github-dry-run で共通 */
export function loadGithubConfig(env: NodeJS.ProcessEnv = process.env): GithubConfig {
  const pollSec = positiveInteger("SELF_AGENT_GITHUB_POLL_SEC", nonEmpty(env.SELF_AGENT_GITHUB_POLL_SEC), DEFAULT_GITHUB_POLL_SEC);
  if (pollSec < MIN_GITHUB_POLL_SEC) {
    throw new Error(`SELF_AGENT_GITHUB_POLL_SEC は ${MIN_GITHUB_POLL_SEC} 以上の整数で指定してください`);
  }
  const owners = (nonEmpty(env.SELF_AGENT_GITHUB_OWNERS) ?? "")
    .split(",")
    .map((owner) => owner.trim())
    .filter((owner) => owner !== "");
  if (owners.some((owner) => !GITHUB_OWNER.test(owner))) {
    throw new Error("SELF_AGENT_GITHUB_OWNERS は GitHub のユーザー名・org 名をカンマ区切りで指定してください");
  }
  return {
    github: flag("SELF_AGENT_GITHUB", nonEmpty(env.SELF_AGENT_GITHUB)),
    githubPollSec: pollSec,
    githubOwners: [...new Set(owners)],
  };
}

/** `owner/*` か `owner/repo`（名前は GitHub の形。`.`・`..` だけのリポジトリ名は除く） */
const JOBS_REPO_PATTERN = /^[A-Za-z0-9-]{1,39}\/(\*|[A-Za-z0-9._-]{1,100})$/;

/**
 * SELF_AGENT_JOBS と作業ジョブの変数を読む（docs/plan/coding-jobs.md §14）。SELF_AGENT_JOBS=1 は SELF_AGENT_SHELL=1 が要る。
 * ジョブの runner（PR-J4）ができるまでは、SELF_AGENT_JOBS=1 を設定エラーにする。ほかの変数は無効のときも形を確かめる
 */
function loadJobsConfig(env: NodeJS.ProcessEnv, shell: boolean): JobsConfig {
  const jobs = flag("SELF_AGENT_JOBS", nonEmpty(env.SELF_AGENT_JOBS));
  if (jobs && !shell) throw new Error("SELF_AGENT_JOBS=1 には SELF_AGENT_SHELL=1 が必要です");
  if (jobs) throw new Error("SELF_AGENT_JOBS: 作業ジョブはまだ使えません（未設定か 0 にしてください）");
  const reposValue = nonEmpty(env.SELF_AGENT_JOBS_REPOS);
  const repos = (reposValue ?? "")
    .split(",")
    .map((repo) => repo.trim())
    .filter((repo) => repo !== "");
  // 設定したのに中身が無い（"," など）なら、許可リストが黙って既定（gh のログインの <login>/*）に広がらないようにエラーにする
  if (reposValue !== undefined && repos.length === 0) {
    throw new Error("SELF_AGENT_JOBS_REPOS は owner/* か owner/repo をカンマ区切りで指定してください（空にするなら変数ごと消してください）");
  }
  if (repos.some((repo) => !JOBS_REPO_PATTERN.test(repo) || repo.endsWith("/.") || repo.endsWith("/.."))) {
    throw new Error("SELF_AGENT_JOBS_REPOS は owner/* か owner/repo をカンマ区切りで指定してください");
  }
  const timeoutMin = positiveInteger(
    "SELF_AGENT_JOB_TIMEOUT_MIN",
    nonEmpty(env.SELF_AGENT_JOB_TIMEOUT_MIN),
    DEFAULT_JOB_TIMEOUT_MIN,
  );
  if (timeoutMin > MAX_JOB_TIMEOUT_MIN) {
    throw new Error(`SELF_AGENT_JOB_TIMEOUT_MIN は ${MAX_JOB_TIMEOUT_MIN} 以下の正の整数で指定してください`);
  }
  return {
    jobs,
    jobsRepos: [...new Set(repos)],
    jobMaxTurns: positiveInteger("SELF_AGENT_JOB_MAX_TURNS", nonEmpty(env.SELF_AGENT_JOB_MAX_TURNS), DEFAULT_JOB_MAX_TURNS),
    jobTimeoutMin: timeoutMin,
    jobModel: nonEmpty(env.SELF_AGENT_JOB_MODEL),
    jobEffort: effortLevel(nonEmpty(env.SELF_AGENT_JOB_EFFORT), "SELF_AGENT_JOB_EFFORT"),
    jobsRepoMaxMb: positiveInteger(
      "SELF_AGENT_JOBS_REPO_MAX_MB",
      nonEmpty(env.SELF_AGENT_JOBS_REPO_MAX_MB),
      DEFAULT_JOBS_REPO_MAX_MB,
    ),
  };
}

/**
 * npm run job-dry-run が読む設定: 作業場所・データの場所（その中に一時ディレクトリを作る）と、作業ジョブの変数（許可リストなど）。
 * SELF_AGENT_JOBS・SELF_AGENT_SHELL は見ない（LLM もシェルも使わない）
 */
export function loadJobDryRunConfig(env: NodeJS.ProcessEnv = process.env): Pick<Config, "workDir" | "dataDir"> & JobsConfig {
  return {
    workDir: nonEmpty(env.SELF_AGENT_WORKDIR) ?? join(homeDir(env), ".local/share/self-agent/work"),
    dataDir: loadDataConfig(env).dataDir,
    ...loadJobsConfig({ ...env, SELF_AGENT_JOBS: undefined }, false),
  };
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const home = (): string => homeDir(env);
  const personas = personaList(env, home);
  const shell = flag("SELF_AGENT_SHELL", nonEmpty(env.SELF_AGENT_SHELL));

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
    ...loadDataConfig(env),
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
    devMode: flag("SELF_AGENT_DEV_MODE", nonEmpty(env.SELF_AGENT_DEV_MODE)),
    devLogDays: positiveInteger("SELF_AGENT_DEV_LOG_DAYS", nonEmpty(env.SELF_AGENT_DEV_LOG_DAYS), DEFAULT_DEV_LOG_DAYS),
    shell,
    personas,
    codexHome:
      nonEmpty(env.SELF_AGENT_CODEX_HOME) ??
      (personas.some((persona) => persona.engine === "codex") ? join(home(), ".local/share/self-agent/codex") : undefined),
    ...loadGithubConfig(env),
    ...loadJobsConfig(env, shell),
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
