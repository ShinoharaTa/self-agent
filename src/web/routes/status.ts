// GET /api/status（docs/plan/web-ui.md §3.5）。Bot の接続・シェル・キュー・配信・GitHub・サーバー・環境変数の有無。
// 環境変数は名前と「値があるか」だけを返し、値は見ない
import { type Config, DEFAULT_PERSONA_ID } from "../../config.ts";
import { GUEST_BOT_NAME, GUEST_PERSONA_ID } from "../../guest/constants.ts";
import type { GuildSettingsStore } from "../../store/guild-settings.ts";
import { DEFAULT_PERSONA_LABEL, type PersonaRuntime } from "../../app/personas.ts";
import type { Route } from "../server.ts";

/**
 * 設定の画面に有無を出す環境変数（CLAUDE.md の環境変数の表の名前。廃止した SELF_AGENT_GUEST_GUILD_IDS は除く）。
 * 人格ごとの変数（SELF_AGENT_PERSONA_<ID>_*）は名前が決まらないので含めない
 */
export const WEB_ENV_NAMES: readonly string[] = [
  "CLAUDE_CODE_OAUTH_TOKEN",
  "DISCORD_TOKEN",
  "SELF_AGENT_ALLOWED_GUILD_IDS",
  "SELF_AGENT_OWNER_ID",
  "SELF_AGENT_INBOX_CHANNEL_ID",
  "CLAUDE_CONFIG_DIR",
  "SELF_AGENT_WORKDIR",
  "SELF_AGENT_DATA_DIR",
  "SELF_AGENT_MODEL",
  "SELF_AGENT_EFFORT",
  "SELF_AGENT_TZ",
  "SELF_AGENT_MAX_CONCURRENT",
  "SELF_AGENT_TURN_TIMEOUT_SEC",
  "SELF_AGENT_CHANNEL_OP_GAP_MS",
  "SELF_AGENT_SHUTDOWN_GRACE_SEC",
  "SELF_AGENT_IDLE_HOURS",
  "SELF_AGENT_AUTO_SESSION_PER_DAY",
  "SELF_AGENT_DELETE_AFTER_DAYS",
  "SELF_AGENT_INBOX_ROTATE_AT",
  "SELF_AGENT_INBOX_MAX_INPUT_TOKENS",
  "SELF_AGENT_SERVE_PORT",
  "SELF_AGENT_PUBLIC_BASE_URL",
  "SELF_AGENT_SERVE_ALLOWED_LOGIN",
  "SELF_AGENT_SESSION_MAX_TURNS",
  "SELF_AGENT_SESSION_TURN_TIMEOUT_SEC",
  "SELF_AGENT_DEV_MODE",
  "SELF_AGENT_DEV_LOG_DAYS",
  "SELF_AGENT_PERSONAS",
  "SELF_AGENT_CODEX_HOME",
  "SELF_AGENT_SHELL",
  "SELF_AGENT_GITHUB",
  "SELF_AGENT_GITHUB_POLL_SEC",
  "SELF_AGENT_GITHUB_OWNERS",
  "SELF_AGENT_JOBS",
  "SELF_AGENT_JOBS_REPOS",
  "SELF_AGENT_JOB_MAX_TURNS",
  "SELF_AGENT_JOB_TIMEOUT_MIN",
  "SELF_AGENT_JOB_MODEL",
  "SELF_AGENT_JOB_EFFORT",
  "SELF_AGENT_JOBS_REPO_MAX_MB",
  "SELF_AGENT_GUEST_DISCORD_TOKEN",
  "SELF_AGENT_GUEST_API_KEY",
  "SELF_AGENT_GUEST_MODEL",
  "SELF_AGENT_GUEST_EFFORT",
  "SELF_AGENT_GUEST_TURNS_PER_DAY",
  "SELF_AGENT_GUEST_USER_TURNS_PER_DAY",
  "SELF_AGENT_GUEST_MAX_CONCURRENT",
  "SELF_AGENT_GUEST_TURN_TIMEOUT_SEC",
  "SELF_AGENT_GUEST_SESSION_MAX_TURNS",
  "SELF_AGENT_GUEST_SESSION_MAX_INPUT_TOKENS",
  "SELF_AGENT_WEB_PORT",
  "SELF_AGENT_WEB_ALLOWED_LOGIN",
  "SELF_AGENT_WEB_TOKEN",
  "SELF_AGENT_WEB_HISTORY_DAYS",
];

/** GitHub の通知のポーリングの状態（W6 で GithubPoller.status() から読む） */
export type GithubStatus = { enabled: boolean; lastFetchAt: string | null; failure: string | null };

export type StatusDeps = {
  cfg: Pick<Config, "allowedGuildIds" | "publicBaseUrl" | "devMode" | "github" | "jobs" | "guest">;
  /** package.json の版（version.ts の readPackageVersion） */
  version: () => string | null;
  startedAt: Date;
  stopping: () => boolean;
  /** PersonaRouter（all は設定の順で、最初が既定の人格） */
  personas: { all: readonly Pick<PersonaRuntime, "id" | "name" | "connected">[] };
  /** ゲスト Bot の接続（ゲストが有効のときだけ） */
  guestConnected?: () => boolean;
  shellState: { configured: boolean; enabled: () => boolean; failedItems: () => readonly string[] };
  queue: { runningSessionJobs: () => number };
  /** 実行中のターンの数（W3 まで 0） */
  running: () => number;
  /** プロジェクトの配信が待ち受けているか */
  serving: () => boolean;
  /** 無ければ（W6 まで）{ enabled: cfg.github, lastFetchAt: null, failure: null } */
  githubStatus?: () => GithubStatus;
  guildSettings: Pick<GuildSettingsStore, "get">;
  env: NodeJS.ProcessEnv;
};

type BotStatus = { persona: string; name: string; isDefault?: boolean; guest?: true; connected: boolean };

export function statusBody(deps: StatusDeps): Record<string, unknown> {
  const { cfg } = deps;
  const bots: BotStatus[] = deps.personas.all.map((persona) => ({
    persona: persona.id,
    name: persona.id === DEFAULT_PERSONA_ID ? DEFAULT_PERSONA_LABEL : persona.name,
    isDefault: persona.id === DEFAULT_PERSONA_ID,
    connected: persona.connected(),
  }));
  if (deps.guestConnected !== undefined) {
    bots.push({ persona: GUEST_PERSONA_ID, name: GUEST_BOT_NAME, guest: true, connected: deps.guestConnected() });
  }
  return {
    version: deps.version(),
    startedAt: deps.startedAt.toISOString(),
    stopping: deps.stopping(),
    bots,
    shell: {
      configured: deps.shellState.configured,
      enabled: deps.shellState.enabled(),
      failed: [...deps.shellState.failedItems()],
    },
    queue: { runningSessionJobs: deps.queue.runningSessionJobs() },
    running: deps.running(),
    serving: deps.serving(),
    publicBaseUrl: cfg.publicBaseUrl ?? null,
    devMode: cfg.devMode,
    github: deps.githubStatus?.() ?? { enabled: cfg.github, lastFetchAt: null, failure: null },
    jobs: { enabled: cfg.jobs },
    guest: cfg.guest,
    guilds: cfg.allowedGuildIds.map((id) => ({ id, setUp: deps.guildSettings.get(id) !== undefined })),
    env: WEB_ENV_NAMES.map((name) => {
      const value = deps.env[name];
      return [name, value !== undefined && value !== ""];
    }),
  };
}

export function statusRoutes(deps: StatusDeps): Route[] {
  return [{ method: "GET", pattern: /^\/api\/status$/, handle: async () => ({ status: 200, json: statusBody(deps) }) }];
}
