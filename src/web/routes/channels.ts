// GET /api/channels・/api/channels/<id>/turns（docs/plan/web-ui.md §4.3）。会話のサイドバーと会話のタブ（読むだけ）。
// 対象は /setup 済みのサーバーだけ（env の SELF_AGENT_INBOX_CHANNEL_ID は使わない）。ID は Discord のリンクを作るために返す（log には出さない）
import { type Config, DEFAULT_PERSONA_ID } from "../../config.ts";
import type { ChannelKind, ResolveChannel } from "../../app/access.ts";
import { SESSION_LIST_LIMITS } from "../../app/commands/sessions.ts";
import { DEFAULT_PERSONA_LABEL, type PersonaRouter, type PersonaRuntime } from "../../app/personas.ts";
import type { GuildSettingsStore } from "../../store/guild-settings.ts";
import type { HistoryKind, HistoryRow, HistoryStore } from "../../store/history.ts";
import { HISTORY_LIST_MAX } from "../../store/history.ts";
import type { ProjectStore } from "../../store/projects.ts";
import type { TopicSession, TopicSessionStore } from "../../store/topic-sessions.ts";
import type { Route, RouteResult } from "../server.ts";

/** /turns の limit の既定 */
export const TURNS_DEFAULT_LIMIT = 50;

/** 一覧に出す状態（完了は新しい SESSION_LIST_LIMITS.done 件） */
const LISTED_STATES = ["active", "waiting", "done"] as const;

export type ChannelRouteDeps = {
  cfg: Pick<Config, "allowedGuildIds" | "personas" | "publicBaseUrl">;
  guildSettings: Pick<GuildSettingsStore, "get" | "entryChannel" | "personaInbox">;
  topicSessions: Pick<TopicSessionStore, "get" | "listByState" | "getCloseDraft">;
  projects: Pick<ProjectStore, "getByChannel">;
  history: Pick<HistoryStore, "list" | "latestByChannel">;
  /** PersonaRouter（all は設定の順で、最初が既定の人格） */
  personas: Pick<PersonaRouter, "ownerOf"> & { all: readonly Pick<PersonaRuntime, "id" | "name" | "connected">[] };
  resolveChannel: ResolveChannel;
};

/** 一覧と /turns の 1 チャンネル */
export type WebChannel = {
  id: string;
  guildId: string;
  kind: "inbox" | "tasks" | "session";
  /** 入口の名前（inbox・tasks・足した人格の表示名）。セッションは null */
  name: string | null;
  /** セッションの題名。入口は null */
  title: string | null;
  persona: string;
  /** セッションの状態。入口は null */
  state: "active" | "waiting" | "done" | null;
  project: { slug: string; url: string | null } | null;
  last: { id: number; at: string; kind: HistoryKind } | null;
  link: string;
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
  },
): (channelId: string) => { guildId: string; kind: ChannelKind } | undefined {
  const { cfg, guildSettings, topicSessions, resolveChannel } = deps;
  const guildOf = (channelId: string): string | undefined => {
    const found = topicSessions.get(channelId)?.guildId ?? guildSettings.entryChannel(channelId)?.guildId;
    if (found !== undefined) return found;
    return cfg.allowedGuildIds.find((guildId) => {
      const settings = guildSettings.get(guildId);
      return settings !== undefined && (settings.inboxChannelId === channelId || settings.tasksChannelId === channelId);
    });
  };
  return (channelId) => {
    const guildId = guildOf(channelId);
    if (guildId === undefined || !cfg.allowedGuildIds.includes(guildId) || guildSettings.get(guildId) === undefined) return undefined;
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
  deps: Pick<ChannelRouteDeps, "cfg" | "guildSettings" | "resolveChannel"> & { topicSessions: Pick<TopicSessionStore, "get"> },
): (channelId: string) => string | null {
  const { cfg, guildSettings, topicSessions } = deps;
  const lookup = webChannelLookup(deps);
  return (channelId) => {
    const found = lookup(channelId);
    if (found === undefined) return null;
    if (found.kind === "session") {
      const item = topicSessions.get(channelId);
      return item === undefined || item.state === "deleted" ? null : item.title;
    }
    const entry = entryNameOf(cfg, guildSettings, found.guildId, channelId);
    return entry === undefined ? null : `#${entry.name}`;
  };
}

export function channelRoutes(deps: ChannelRouteDeps): Route[] {
  const { cfg, guildSettings, topicSessions, projects, history, personas, resolveChannel } = deps;

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

  const lookup = webChannelLookup({ cfg, guildSettings, topicSessions, resolveChannel });

  /** /turns の 1 チャンネル。許可した /setup 済みのサーバーの受け付け対象でなければ undefined */
  const channelOf = (channelId: string): WebChannel | undefined => {
    const found = lookup(channelId);
    if (found === undefined) return undefined;
    const { guildId, kind } = found;
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
        // /close の確認の下書き（閉じていないセッションのものだけ）。あれば会話の末尾に確認のカードを出す
        const closeDraft = channel.kind === "session" && channel.state !== "done" ? (topicSessions.getCloseDraft(channelId) ?? null) : null;
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
