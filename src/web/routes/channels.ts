// GET /api/channels・/api/channels/<id>/turns（docs/plan/web-ui.md §4.3）。会話のサイドバーと会話のタブ（読むだけ）。
// 対象は /setup 済みのサーバーだけ（env の SELF_AGENT_INBOX_CHANNEL_ID は使わない）。ID は Discord のリンクを作るために返す（log には出さない）。
// Claude Code のチャンネル（docs/plan/claude-code-channels.md §5.2。CC14）: cc を渡したときだけ、削除されていない cc_channels の行を kind "cc" で一覧と /turns に出す
// （種類は ChannelKind | "cc"。access.ts の ChannelKind は変えない。SDK のターンが無いので /renew・/continue・/abort は呼び出し側で 404）
import { type Config, DEFAULT_PERSONA_ID } from "../../config.ts";
import type { ChannelKind, ResolveChannel } from "../../app/access.ts";
import type { CcChannelRow, CcChannelStore } from "../../store/cc-channels.ts";
import { SESSION_LIST_LIMITS } from "../../app/commands/sessions.ts";
import { DEFAULT_PERSONA_LABEL, type PersonaRouter, type PersonaRuntime } from "../../app/personas.ts";
import type { GuildSettingsStore } from "../../store/guild-settings.ts";
import type { HistoryKind, HistoryRow, HistoryStore } from "../../store/history.ts";
import { HISTORY_LIST_MAX } from "../../store/history.ts";
import type { ProjectStore } from "../../store/projects.ts";
import type { CcPermissionStore } from "../../store/cc-permissions.ts";
import type { SdkSessionStore } from "../../store/sdk-sessions.ts";
import { CC_PERMISSION_RECENT_MS, type HoldSeconds, permissionJson } from "./cc.ts";
import type { TopicSession, TopicSessionStore } from "../../store/topic-sessions.ts";
import type { Route, RouteResult } from "../server.ts";

/** /turns の limit の既定 */
export const TURNS_DEFAULT_LIMIT = 50;
/** Web から始めた /close の確認（候補あり）を Discord にも投稿したときの、会話の履歴の知らせ（routes/sessions.ts が書く）。これが最後の行の間だけ確認のカードを出す */
export const CLOSE_CONFIRM_NOTICE = "確認待ちです。登録するやることを選ぶと閉じます（Discord でも選べます）";

/** Web で開ける・送れるチャンネルの種類（Claude Code のチャンネルは cc。CC14） */
export type WebChannelKind = ChannelKind | "cc";

/** Claude Code のチャンネルのセッションの今（CC14。state の ended はチャンネルが終わった・一覧に無い。permission・pending は /api/cc/sessions と同じ形） */
export type WebCcInfo = {
  sessionId: string;
  state: "needs_input" | "running" | "idle" | "ended";
  cwdLabel: string | null;
  inTmux: boolean;
  permission: unknown;
  pending: unknown;
};

/** Claude Code のチャンネル（CC14）。describe は 1 回の要求で 1 回呼び、返した関数で各行の今を引く（一覧・送信・許可を読むのは 1 回だけ） */
export type WebCcChannelDeps = {
  store: Pick<CcChannelStore, "get" | "listUndeleted">;
  describe: () => (row: CcChannelRow) => { name: string | null; info: WebCcInfo };
};

/** 一覧に出す状態（完了は新しい SESSION_LIST_LIMITS.done 件） */
const LISTED_STATES = ["active", "waiting", "done"] as const;

export type ChannelRouteDeps = {
  cfg: Pick<Config, "allowedGuildIds" | "personas" | "publicBaseUrl">;
  guildSettings: Pick<GuildSettingsStore, "get" | "entryChannel" | "personaInbox">;
  topicSessions: Pick<TopicSessionStore, "get" | "listByState" | "getCloseDraft"> & Partial<Pick<TopicSessionStore, "projectDirOf">>;
  projects: Pick<ProjectStore, "getByChannel">;
  history: Pick<HistoryStore, "list" | "latestByChannel">;
  /** PersonaRouter（all は設定の順で、最初が既定の人格） */
  personas: Pick<PersonaRouter, "ownerOf"> & { all: readonly Pick<PersonaRuntime, "id" | "name" | "connected">[] };
  resolveChannel: ResolveChannel;
  /** Claude Code のチャンネル（SELF_AGENT_CC が動くときだけ。無ければ出さない） */
  cc?: WebCcChannelDeps;
  /**
   * プロジェクトのセッションの許可の要求（docs/plan/unify.md §6.1 の 5。SELF_AGENT_CC が動くときだけ）。セッションの行の permission に、
   * そのチャンネルの最新の origin sdk の要求（終わったものは CC_PERMISSION_RECENT_MS の間）を /api/cc/sessions と同じ形で出す。無ければ null
   */
  projectPermissions?: {
    store: Pick<CcPermissionStore, "latestSdkFor">;
    sessions: Pick<SdkSessionStore, "get">;
    now?: () => Date;
  } & HoldSeconds;
};

/** 一覧と /turns の 1 チャンネル */
export type WebChannel = {
  id: string;
  guildId: string;
  kind: "inbox" | "tasks" | "session" | "cc";
  /** 入口の名前（inbox・tasks・足した人格の表示名）・Claude Code のセッション名。セッションは null */
  name: string | null;
  /** セッションの題名。入口は null */
  title: string | null;
  persona: string;
  /** セッションの状態。入口は null */
  state: "active" | "waiting" | "done" | null;
  project: { slug: string; url: string | null } | null;
  last: { id: number; at: string; kind: HistoryKind } | null;
  link: string;
  /** Claude Code のチャンネルのセッションの今（kind cc だけ） */
  cc?: WebCcInfo;
  /** プロジェクトのセッション（sessions.project_dir）のプロジェクトと許可のモード（kind session だけ。軽いモードは null） */
  projectDir?: { dir: string; permissionMode: string } | null;
  /** プロジェクトのセッションの最新の許可の要求（routes/cc.ts の permissionJson。kind session だけ。無ければ null） */
  permission?: ReturnType<typeof permissionJson> | null;
};

type Last = WebChannel["last"];

const BAD_REQUEST: RouteResult = { status: 400, json: { error: "bad_request" } };
const NOT_FOUND: RouteResult = { status: 404, json: { error: "not_found" } };

function channelLink(guildId: string, channelId: string): string {
  return `https://discord.com/channels/${guildId}/${channelId}`;
}

/** 省略は undefined、正の整数でなければ null */
function optionalId(value: string | null): number | undefined | null {
  if (value === null) return undefined;
  if (!/^\d{1,15}$/.test(value)) return null;
  const parsed = Number(value);
  return parsed >= 1 ? parsed : null;
}

/**
 * Web で開ける・送れるチャンネルのサーバーと種類（/turns・/messages などで共通）。サーバーはセッション → 入口 → 既定の人格の #inbox・#tasks の順に引き、
 * 許可した /setup 済みのサーバーの受け付け対象（resolveChannel が null でない）でなければ undefined
 */
export function webChannelLookup(
  deps: Pick<ChannelRouteDeps, "cfg" | "resolveChannel"> & {
    guildSettings: Pick<GuildSettingsStore, "get" | "entryChannel">;
    topicSessions: Pick<TopicSessionStore, "get">;
    /** Claude Code のチャンネル（CC14）。渡したときだけ、削除されていない行を kind cc で通す */
    ccChannels?: Pick<CcChannelStore, "get">;
  },
): (channelId: string) => { guildId: string; kind: WebChannelKind } | undefined {
  const { cfg, guildSettings, topicSessions, resolveChannel, ccChannels } = deps;
  const guildOf = (channelId: string): string | undefined => {
    const found = topicSessions.get(channelId)?.guildId ?? guildSettings.entryChannel(channelId)?.guildId;
    if (found !== undefined) return found;
    return cfg.allowedGuildIds.find((guildId) => {
      const settings = guildSettings.get(guildId);
      return settings !== undefined && (settings.inboxChannelId === channelId || settings.tasksChannelId === channelId);
    });
  };
  const setUp = (guildId: string) => cfg.allowedGuildIds.includes(guildId) && guildSettings.get(guildId) !== undefined;
  return (channelId) => {
    const cc = ccChannels?.get(channelId);
    if (cc !== undefined && cc.state !== "deleted") return setUp(cc.guildId) ? { guildId: cc.guildId, kind: "cc" } : undefined;
    const guildId = guildOf(channelId);
    if (guildId === undefined || !setUp(guildId)) return undefined;
    const kind = resolveChannel(guildId, channelId);
    return kind === null ? undefined : { guildId, kind };
  };
}

/**
 * 入口のチャンネル（#inbox・#tasks・設定にある人格の #<NAME>）の種類と名前（inbox・tasks・人格の表示名）。そのサーバーが /setup 前・入口でなければ undefined。
 * /turns と /api/reminders で同じ引き方にする（/api/channels の entries と同じ順）
 */
function entryNameOf(
  cfg: Pick<Config, "personas">,
  guildSettings: Pick<GuildSettingsStore, "get" | "personaInbox">,
  guildId: string,
  channelId: string,
): { kind: "inbox" | "tasks"; name: string } | undefined {
  const settings = guildSettings.get(guildId);
  if (settings === undefined) return undefined;
  if (settings.inboxChannelId === channelId) return { kind: "inbox", name: "inbox" };
  if (settings.tasksChannelId === channelId) return { kind: "tasks", name: "tasks" };
  const persona = cfg.personas.find((candidate) => guildSettings.personaInbox(guildId, candidate.id)?.channelId === channelId);
  return persona === undefined ? undefined : { kind: "inbox", name: persona.name };
}

/**
 * チャンネルの表示名（#inbox・#tasks・#<NAME>・セッションの題名）。/turns と同じく、許可した /setup 済みのサーバーの受け付け対象でなければ null
 */
export function webChannelNamer(
  deps: Pick<ChannelRouteDeps, "cfg" | "guildSettings" | "resolveChannel"> & {
    topicSessions: Pick<TopicSessionStore, "get">;
    ccChannels?: Pick<CcChannelStore, "get">;
  },
): (channelId: string) => string | null {
  const { cfg, guildSettings, topicSessions, ccChannels } = deps;
  const lookup = webChannelLookup(deps);
  return (channelId) => {
    const found = lookup(channelId);
    if (found === undefined) return null;
    // Claude Code のチャンネルは Discord のチャンネル名（cc-<名前>）
    if (found.kind === "cc") {
      const row = ccChannels?.get(channelId);
      return row === undefined ? null : `#${row.name}`;
    }
    if (found.kind === "session") {
      const item = topicSessions.get(channelId);
      return item === undefined || item.state === "deleted" ? null : item.title;
    }
    const entry = entryNameOf(cfg, guildSettings, found.guildId, channelId);
    return entry === undefined ? null : `#${entry.name}`;
  };
}

export function channelRoutes(deps: ChannelRouteDeps): Route[] {
  const { cfg, guildSettings, topicSessions, projects, history, personas, resolveChannel, cc, projectPermissions } = deps;

  /** プロジェクトのセッションの最新の許可の要求（無ければ null） */
  const sessionPermission = (channelId: string): WebChannel["permission"] => {
    if (projectPermissions === undefined) return null;
    const now = projectPermissions.now?.() ?? new Date();
    const row = projectPermissions.store.latestSdkFor(
      channelId,
      projectPermissions.sessions.get(channelId),
      new Date(now.getTime() - CC_PERMISSION_RECENT_MS),
    );
    return row === undefined ? null : permissionJson(row, projectPermissions);
  };

  const project = (channelId: string): WebChannel["project"] => {
    const found = projects.getByChannel(channelId);
    if (found === undefined) return null;
    return { slug: found.slug, url: cfg.publicBaseUrl === undefined ? null : `${cfg.publicBaseUrl}/p/${found.slug}/` };
  };

  const entry = (
    guildId: string,
    channelId: string,
    kind: "inbox" | "tasks",
    name: string,
    last: Last,
  ): WebChannel => ({
    id: channelId,
    guildId,
    kind,
    name,
    title: null,
    persona: personas.ownerOf(channelId),
    state: null,
    project: project(channelId),
    last,
    link: channelLink(guildId, channelId),
  });

  const projectDirOf = (channelId: string): WebChannel["projectDir"] => {
    const found = topicSessions.projectDirOf?.(channelId);
    return found === undefined ? null : { dir: found.projectDir, permissionMode: found.permissionMode };
  };

  const session = (item: TopicSession, last: Last): WebChannel | undefined => {
    if (item.state === "deleted") return undefined;
    return {
      id: item.channelId,
      guildId: item.guildId,
      kind: "session",
      name: null,
      title: item.title,
      persona: personas.ownerOf(item.channelId),
      state: item.state,
      project: project(item.channelId),
      last,
      link: channelLink(item.guildId, item.channelId),
      projectDir: projectDirOf(item.channelId),
      permission: sessionPermission(item.channelId),
    };
  };

  /** Claude Code のチャンネル（CC14）。名前はセッション名（分からなければチャンネル名） */
  const ccChannel = (row: CcChannelRow, describe: ReturnType<WebCcChannelDeps["describe"]>, last: Last): WebChannel => {
    const { name, info } = describe(row);
    return {
      id: row.channelId,
      guildId: row.guildId,
      kind: "cc",
      name: name ?? row.name,
      title: null,
      persona: DEFAULT_PERSONA_ID,
      state: null,
      project: null,
      last,
      link: channelLink(row.guildId, row.channelId),
      cc: info,
    };
  };

  /** そのサーバー（/setup 済み）の入口（#inbox・#tasks・設定にある人格の #<NAME>） */
  const entries = (guildId: string, latest: ReturnType<HistoryStore["latestByChannel"]>): WebChannel[] => {
    const settings = guildSettings.get(guildId);
    if (settings === undefined) return [];
    const list: WebChannel[] = [];
    const add = (channelId: string, kind: "inbox" | "tasks", name: string) =>
      list.push(entry(guildId, channelId, kind, name, latest.get(channelId) ?? null));
    if (settings.inboxChannelId !== null) add(settings.inboxChannelId, "inbox", "inbox");
    if (settings.tasksChannelId !== null) add(settings.tasksChannelId, "tasks", "tasks");
    for (const persona of cfg.personas) {
      const channelId = guildSettings.personaInbox(guildId, persona.id)?.channelId;
      if (channelId !== null && channelId !== undefined) add(channelId, "inbox", persona.name);
    }
    return list;
  };

  /** そのサーバー（/setup 済み）の入口のうち channelId のもの（entries と同じ順で引き、ほかの入口は組み立てない）。入口でなければ undefined */
  const entryOf = (guildId: string, channelId: string, last: Last): WebChannel | undefined => {
    const found = entryNameOf(cfg, guildSettings, guildId, channelId);
    return found === undefined ? undefined : entry(guildId, channelId, found.kind, found.name, last);
  };

  /** そのチャンネルの最後の行 */
  const lastOf = (channelId: string): Last => {
    const row = history.list(channelId, { limit: 1 })[0];
    return row === undefined ? null : { id: row.id, at: row.at, kind: row.kind };
  };

  const lookup = webChannelLookup({ cfg, guildSettings, topicSessions, resolveChannel, ...(cc === undefined ? {} : { ccChannels: cc.store }) });

  /** /turns の 1 チャンネル。許可した /setup 済みのサーバーの受け付け対象でなければ undefined */
  const channelOf = (channelId: string): WebChannel | undefined => {
    const found = lookup(channelId);
    if (found === undefined) return undefined;
    const { guildId, kind } = found;
    if (kind === "cc") {
      const row = cc?.store.get(channelId);
      return row === undefined || cc === undefined ? undefined : ccChannel(row, cc.describe(), lastOf(channelId));
    }
    if (kind === "session") {
      const item = topicSessions.get(channelId);
      return item === undefined ? undefined : session(item, lastOf(channelId));
    }
    return entryOf(guildId, channelId, lastOf(channelId));
  };

  const turnOf = (row: HistoryRow, link: string) => ({
    id: row.id,
    at: row.at,
    kind: row.kind,
    source: row.source,
    persona: row.persona,
    text: row.text,
    outcome: row.outcome,
    steps: row.steps,
    toolCalls: row.toolCalls,
    durationMs: row.durationMs,
    messageId: row.messageId,
    link: row.messageId === null ? link : `${link}/${row.messageId}`,
  });

  return [
    {
      method: "GET",
      pattern: /^\/api\/channels$/,
      handle: async () => {
        const guilds = cfg.allowedGuildIds.map((id) => ({ id, setUp: guildSettings.get(id) !== undefined }));
        const channels: WebChannel[] = [];
        const describe = cc?.describe();
        for (const guild of guilds) {
          if (!guild.setUp) continue;
          const latest = history.latestByChannel(guild.id);
          channels.push(...entries(guild.id, latest));
          for (const state of LISTED_STATES) {
            for (const item of topicSessions.listByState(guild.id, state, SESSION_LIST_LIMITS[state])) {
              const channel = session(item, latest.get(item.channelId) ?? null);
              if (channel !== undefined) channels.push(channel);
            }
          }
          // Claude Code のチャンネル（サイドバーは群「Claude Code」の行から開き、未読の点にこの last を使う）
          if (cc !== undefined && describe !== undefined) {
            for (const row of cc.store.listUndeleted(guild.id)) channels.push(ccChannel(row, describe, latest.get(row.channelId) ?? null));
          }
        }
        const personaList = personas.all.map((persona) => ({
          id: persona.id,
          name: persona.id === DEFAULT_PERSONA_ID ? DEFAULT_PERSONA_LABEL : persona.name,
          isDefault: persona.id === DEFAULT_PERSONA_ID,
          connected: persona.connected(),
        }));
        return { status: 200, json: { guilds, personas: personaList, channels } };
      },
    },
    {
      method: "GET",
      pattern: /^\/api\/channels\/(\d{1,25})\/turns$/,
      handle: async ({ params, query }) => {
        const before = optionalId(query.get("before"));
        const after = optionalId(query.get("after"));
        const limitText = query.get("limit");
        const limit = limitText === null ? TURNS_DEFAULT_LIMIT : /^\d{1,4}$/.test(limitText) ? Number(limitText) : 0;
        if (before === null || after === null || (before !== undefined && after !== undefined)) return BAD_REQUEST;
        if (limit < 1 || limit > HISTORY_LIST_MAX) return BAD_REQUEST;
        const channelId = params[0] ?? "";
        const channel = channelOf(channelId);
        if (channel === undefined) return NOT_FOUND;
        const rows = history.list(channelId, {
          ...(before === undefined ? {} : { before }),
          ...(after === undefined ? {} : { after }),
          limit,
        });
        // /close の確認の下書き（閉じていないセッションのもの）。Web から始めた確認待ち（最後の行がその知らせ）の間だけ返し、会話の末尾に確認のカードを出す。
        // Discord から始めた /close の確認と、知らせの後に行が来たもの（発言・別の操作）は出さない（Discord で選ぶ）
        const last = channel.kind === "session" && channel.state !== "done" ? history.list(channelId, { limit: 1 })[0] : undefined;
        const awaitingConfirm = last !== undefined && last.kind === "notice" && last.source === "system" && last.text === CLOSE_CONFIRM_NOTICE;
        const closeDraft = awaitingConfirm ? (topicSessions.getCloseDraft(channelId) ?? null) : null;
        return {
          status: 200,
          json: {
            channel: { ...channel, closeDraft },
            turns: rows.map((row) => turnOf(row, channel.link)),
            // before で limit 件取れたら、まだ前があるかもしれない（最新の limit 件のときは画面が件数で判断する）
            hasMore: before !== undefined && rows.length === limit,
          },
        };
      },
    },
  ];
}
