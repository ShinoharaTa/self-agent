// GET /api/topics（docs/plan/web-ui-v3.md §3〜§5・§11 の M1）。セッション・プロジェクトのセッション・Claude Code のセッションを 1 つの形（app/topics.ts の Topic）にし、
// 群とあなたの番を数えて返す（読むだけ。DB は書かない）。対象は /setup 済みのサーバーだけ。?done=<群> のときだけ、その群の完了を TOPICS_DONE_MAX 件まで足す。
// Claude Code のセッション（cc）は SELF_AGENT_CC のときだけ（無ければ enabled: false で、その行と other の群は出ない）。log は出さない
import { CC_CONFIRM_TTL_MS } from "../../app/commands/cc-confirm.ts";
import { SESSION_LIST_LIMITS } from "../../app/commands/sessions.ts";
import type { Handler } from "../../app/handler.ts";
import type { PersonaRouter, PersonaRuntime } from "../../app/personas.ts";
import {
  buildTopics,
  summarize,
  TOPIC_GROUP_PATTERN,
  TOPICS_DONE_SCAN,
  type TopicLast,
  type TopicsInput,
  type TopicSeed,
  type TopicTurn,
} from "../../app/topics.ts";
import { cwdLabel, projectOf } from "../../cc/labels.ts";
import { permissionExpiresAt } from "../../cc/permission-hold.ts";
import { sinceOf, type CcRegistry, type CcSessionView } from "../../cc/registry.ts";
import { CC_PROJECT_PATTERN, type CcPlaces, listProjects } from "../../cc/starter.ts";
import { type Config, DEFAULT_PERSONA_ID } from "../../config.ts";
import type { CcChannelRow, CcChannelStore } from "../../store/cc-channels.ts";
import type { CcPermissionRow, CcPermissionStore } from "../../store/cc-permissions.ts";
import type { CcSendStore } from "../../store/cc-sends.ts";
import type { CcStartStore } from "../../store/cc-starts.ts";
import type { GuildSettingsStore } from "../../store/guild-settings.ts";
import type { HistoryStore } from "../../store/history.ts";
import type { SdkSessionStore } from "../../store/sdk-sessions.ts";
import type { TopicSessionStore } from "../../store/topic-sessions.ts";
import type { Route, RouteResult } from "../server.ts";
import { CC_PERMISSION_RECENT_MS, type HoldSeconds, questionJson } from "./cc.ts";
import { channelLink, CLOSE_CONFIRM_NOTICE } from "./channels.ts";

export type TopicRouteDeps = {
  cfg: Pick<Config, "allowedGuildIds" | "personas" | "workspaceDir">;
  guildSettings: Pick<GuildSettingsStore, "get" | "personaInbox">;
  topicSessions: Pick<TopicSessionStore, "listByState"> & Partial<Pick<TopicSessionStore, "projectDirOf">>;
  history: Pick<HistoryStore, "list" | "latestByChannel">;
  personas: Pick<PersonaRouter, "ownerOf"> & { all: readonly Pick<PersonaRuntime, "id" | "name">[] };
  handler: Pick<Handler, "runningTurns">;
  places: CcPlaces;
  home: string;
  /** プロジェクトのセッションの許可（channels.ts の projectPermissions と同じ物） */
  projectPermissions?: { store: Pick<CcPermissionStore, "latestSdkFor">; sessions: Pick<SdkSessionStore, "get"> } & HoldSeconds;
  /** SELF_AGENT_CC=1 のときだけ */
  cc?: {
    registry: Pick<CcRegistry, "snapshot" | "touch">;
    channels: Pick<CcChannelStore, "listUndeleted">;
    permissions: Pick<CcPermissionStore, "listPending">;
    sends: Pick<CcSendStore, "listAwaitingConfirmBefore">;
    starts: Pick<CcStartStore, "listAwaitingConfirmBefore">;
  } & HoldSeconds;
  now?: () => Date;
};

const BAD_REQUEST: RouteResult = { status: 400, json: { error: "bad_request" } };

/** 入口は場所を変えられない */
const ENTRY_UNMOVABLE = { reason: "入口は場所を変えられません" };
/** 端末のセッションは場所を変えられない */
const CC_UNMOVABLE = { reason: "端末のセッションは場所を変えられません" };

/** 許可の要求・質問の行 → 待っているもの */
function permissionTurn(row: CcPermissionRow, hold: HoldSeconds): TopicTurn {
  let kind: TopicTurn["kind"] = "permission";
  let summary: string;
  if (row.questionInput !== null) {
    kind = "question";
    const text = questionJson(row)?.questions[0]?.question;
    const flat = text === undefined ? "" : summarize(text);
    summary = flat === "" ? "質問" : flat;
  } else {
    summary = summarize(`${row.toolName}: ${row.summary}`);
  }
  return { kind, summary, since: row.createdAt, expiresAt: permissionExpiresAt(row, hold.holdSec, hold.questionHoldSec) };
}

export function topicRoutes(deps: TopicRouteDeps): Route[] {
  const { cfg, guildSettings, topicSessions, history, personas, handler, places, home, projectPermissions, cc } = deps;
  const now = deps.now ?? (() => new Date());

  /** 既定でない人格の名前（既定なら null） */
  const personaOf = (channelId: string): string | null => {
    const id = personas.ownerOf(channelId);
    if (id === DEFAULT_PERSONA_ID) return null;
    return personas.all.find((persona) => persona.id === id)?.name ?? id;
  };

  /** /close の確認（Web から始めたもの。最後の行がその知らせ）。無ければ undefined */
  const closeConfirm = (channelId: string): TopicTurn | undefined => {
    const last = history.list(channelId, { limit: 1 })[0];
    if (last === undefined || last.kind !== "notice" || last.source !== "system" || last.text !== CLOSE_CONFIRM_NOTICE) return undefined;
    return { kind: "confirm", summary: "閉じる前の確認", since: last.at, expiresAt: null };
  };

  const collect = (at: number, done: string | null): TopicsInput => {
    const nowIso = new Date(at).toISOString();
    const guilds = cfg.allowedGuildIds.filter((id) => guildSettings.get(id) !== undefined);
    const runningIds = new Set(handler.runningTurns().map((turn) => turn.channelId));
    let projects: string[];
    try {
      projects = listProjects(places);
    } catch {
      projects = [];
    }
    const seeds: TopicSeed[] = [];
    const rightHands: TopicsInput["rightHands"] = [];
    // チャンネル → その話題・右腕の turns（確認の札を足す先）
    const byChannel = new Map<string, TopicTurn[][]>();
    const track = (channelId: string, turns: TopicTurn[]) => {
      const list = byChannel.get(channelId) ?? [];
      list.push(turns);
      byChannel.set(channelId, list);
    };

    if (cc !== undefined) cc.registry.touch();
    const snapshot = cc?.registry.snapshot();
    const hookPermissions = cc === undefined ? [] : cc.permissions.listPending("hook");
    const ccRows = new Map<string, CcChannelRow[]>(cc === undefined ? [] : guilds.map((guildId) => [guildId, cc.channels.listUndeleted(guildId)]));
    const withChannel = new Set([...ccRows.values()].flat().map((row) => row.sessionId));

    for (const [index, guildId] of guilds.entries()) {
      const settings = guildSettings.get(guildId)!;
      const latest = history.latestByChannel(guildId);
      const lastOf = (channelId: string): TopicLast => latest.get(channelId) ?? null;

      // (1) セッション
      for (const state of ["active", "waiting", "done"] as const) {
        const limit = state === "done" ? TOPICS_DONE_SCAN : SESSION_LIST_LIMITS[state];
        for (const item of topicSessions.listByState(guildId, state, limit)) {
          if (item.state === "deleted") continue;
          const channelId = item.channelId;
          const found = topicSessions.projectDirOf?.(channelId);
          const turns: TopicTurn[] = [];
          if (projectPermissions !== undefined) {
            const row = projectPermissions.store.latestSdkFor(
              channelId,
              projectPermissions.sessions.get(channelId),
              new Date(at - CC_PERMISSION_RECENT_MS),
            );
            if (row !== undefined && row.state === "pending") turns.push(permissionTurn(row, projectPermissions));
          }
          if (item.state !== "done") {
            const confirm = closeConfirm(channelId);
            if (confirm !== undefined) turns.push(confirm);
          }
          const last = lastOf(channelId);
          seeds.push({
            id: `ch:${channelId}`,
            title: item.title,
            origin: found === undefined ? "session" : "project",
            dir: found !== undefined && CC_PROJECT_PATTERN.test(found.projectDir) ? found.projectDir : null,
            outside: false,
            pinned: false,
            persona: personaOf(channelId),
            sessionId: null,
            cwdLabel: null,
            state: item.state,
            activityAt: last?.at ?? item.lastActivityAt,
            last,
            link: channelLink(guildId, channelId),
            running: runningIds.has(channelId),
            turns,
            movable: true,
          });
          track(channelId, turns);
        }
      }

      // (2) 入口（#tasks・足した人格の入口は固定の話題、既定の人格の #inbox は右腕）
      const entry = (channelId: string, title: string, persona: string | null) => {
        const last = lastOf(channelId);
        const turns: TopicTurn[] = [];
        seeds.push({
          id: `ch:${channelId}`,
          title,
          origin: "session",
          dir: null,
          outside: false,
          pinned: true,
          persona,
          sessionId: null,
          cwdLabel: null,
          state: "active",
          activityAt: last?.at ?? new Date(0).toISOString(),
          last,
          link: channelLink(guildId, channelId),
          running: runningIds.has(channelId),
          turns,
          movable: ENTRY_UNMOVABLE,
        });
        track(channelId, turns);
      };
      if (settings.tasksChannelId !== null) entry(settings.tasksChannelId, "#tasks", null);
      for (const persona of cfg.personas) {
        const channelId = guildSettings.personaInbox(guildId, persona.id)?.channelId;
        if (channelId !== null && channelId !== undefined) entry(channelId, `#${persona.name}`, persona.name);
      }
      if (settings.inboxChannelId !== null) {
        const turns: TopicTurn[] = [];
        rightHands.push({
          id: `ch:${settings.inboxChannelId}`,
          guildId,
          title: "右腕",
          last: lastOf(settings.inboxChannelId),
          link: channelLink(guildId, settings.inboxChannelId),
          turns,
        });
        track(settings.inboxChannelId, turns);
      }

      // (3) Claude Code のセッション
      if (cc !== undefined && snapshot !== undefined) {
        const ccSeed = (input: {
          id: string;
          view: CcSessionView | undefined;
          row: CcChannelRow | undefined;
          active: boolean;
          last: TopicLast;
          link: string | null;
        }): TopicSeed => {
          const { view, row, active, last } = input;
          const cwd = (active ? view?.cwd : undefined) ?? row?.cwd ?? undefined;
          const project = projectOf(cwd, cfg.workspaceDir);
          const label = cwdLabel(cwd, cfg.workspaceDir, home);
          const viewName = view?.name;
          const title = viewName !== undefined && viewName !== "" ? viewName : (row?.name ?? label ?? "Claude Code");
          const activityAt =
            last?.at ??
            (view?.lastActivityAt !== undefined ? new Date(view.lastActivityAt).toISOString() : undefined) ??
            (row === undefined ? undefined : (row.endedAt ?? row.updatedAt)) ??
            nowIso;
          const turns: TopicTurn[] = [];
          if (active && view !== undefined) {
            for (const permission of hookPermissions) {
              if (permission.sessionId === view.sessionId) turns.push(permissionTurn(permission, cc));
            }
            if (turns.length === 0 && view.state === "needs_input") {
              const since = sinceOf(view);
              turns.push({
                kind: "waiting",
                summary: summarize(view.waitingFor ?? "判断待ち"),
                since: since === undefined ? activityAt : new Date(since).toISOString(),
                expiresAt: null,
              });
            }
          }
          return {
            id: input.id,
            title,
            origin: "cc",
            dir: project?.dir ?? null,
            outside: project === null,
            pinned: false,
            persona: null,
            sessionId: active && view !== undefined ? view.sessionId : null,
            cwdLabel: label,
            state: active ? "active" : "done",
            activityAt,
            last,
            link: input.link,
            running: active && view?.state === "running",
            turns,
            movable: CC_UNMOVABLE,
          };
        };
        for (const row of ccRows.get(guildId) ?? []) {
          const listed = snapshot.sessions.find((session) => session.sessionId === row.sessionId);
          const active = (row.state === "open" || row.state === "resuming") && listed !== undefined;
          const seed = ccSeed({
            id: `ch:${row.channelId}`,
            // 終わったチャンネルの cwd は行のもの（名前と時刻は一覧に居れば一覧のもの）
            view: listed,
            row,
            active,
            last: lastOf(row.channelId),
            link: channelLink(guildId, row.channelId),
          });
          seeds.push(seed);
          if (active) track(row.channelId, seed.turns);
        }
        // チャンネルの無いセッションは最初のサーバーにだけ足す（サーバーをまたいで重ねない）
        if (index === 0) {
          for (const view of snapshot.sessions) {
            if (withChannel.has(view.sessionId)) continue;
            seeds.push(ccSeed({ id: `cc:${view.sessionId}`, view, row: undefined, active: true, last: null, link: null }));
          }
        }
      }
    }

    // (4) 確認の札（頼んだチャンネルの話題か右腕へ。合わないものは捨てる）
    if (cc !== undefined) {
      const cutoff = new Date(at);
      const attach = (channelId: string, summary: string, createdAt: string) => {
        const turn: TopicTurn = {
          kind: "confirm",
          summary,
          since: createdAt,
          expiresAt: new Date(Date.parse(createdAt) + CC_CONFIRM_TTL_MS).toISOString(),
        };
        for (const turns of byChannel.get(channelId) ?? []) turns.push(turn);
      };
      for (const row of cc.starts.listAwaitingConfirmBefore(cutoff)) attach(row.channelId, "Claude Code を起動する確認", row.createdAt);
      for (const row of cc.sends.listAwaitingConfirmBefore(cutoff)) {
        if (row.origin === "tool" && row.channelId !== null) attach(row.channelId, "Claude Code に送る確認", row.createdAt);
      }
    }

    return {
      seeds,
      projects,
      rightHands,
      done,
      cc: snapshot === undefined ? { enabled: false, stale: false, unreadable: false } : { enabled: true, stale: snapshot.stale, unreadable: snapshot.unreadable },
    };
  };

  return [
    {
      method: "GET",
      pattern: /^\/api\/topics$/,
      handle: async ({ query }) => {
        const done = query.get("done");
        if (done !== null && !TOPIC_GROUP_PATTERN.test(done)) return BAD_REQUEST;
        return { status: 200, json: buildTopics(collect(now().getTime(), done)) };
      },
    },
  ];
}
