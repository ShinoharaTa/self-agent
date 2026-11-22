// GET /api/topics（docs/plan/web-ui-v3.md §3〜§5・§11 の M1）。セッション・プロジェクトのセッション・Claude Code のセッションを 1 つの形（app/topics.ts の Topic）にし、
// 群とあなたの番を数えて返す（読むだけ。DB は書かない）。対象は /setup 済みのサーバーだけ。?done=<群> のときだけ、その群の完了を TOPICS_DONE_MAX 件まで足す。
// Claude Code のセッション（cc）は SELF_AGENT_CC のときだけ（無ければ enabled: false で、その行と other の群は出ない）。GET は log を出さない。
// POST /api/topics（M4）は場所・題名・最初の一言で話題を始める（app/session-ops.ts の startTopic。start の配線があるときだけ）。
// POST /api/topics/ch:<id>/place（M5）は話題の場所を変える（app/topic-move.ts の moveTopic。move の配線があるときだけ。202 ですぐ返し、結果はチャンネルに投稿する）
// 右腕の場所を変える確認（M6e。app/topic-proposals.ts）は、proposals の配線があるとき、その話題の「あなたの番」（confirm）に付ける
// POST /api/topics/moves/<id>/accept・/keep（M6g）は、その確認に Web から答える（Discord の [変える][このまま] と同じ accept・keep。proposals の配線があるときだけ）
// POST /api/topics/ch:<id>/mode（H4b）はプロジェクトのセッションの許可のモードを変える（app/session-mode.ts の setSessionMode。mode の配線があるときだけ）
// 既読（M7。docs/plan/web-ui-v3.md §3.3）: GET の応答に reads（{ [channelId]: lastReadId }）を足し、POST /api/topics/ch:<id>/read で進める（reads の配線があるときだけ。log は出さない）
import { CC_CONFIRM_TTL_MS } from "../../app/commands/cc-confirm.ts";
import { SESSION_LIST_LIMITS } from "../../app/commands/sessions.ts";
import type { Handler } from "../../app/handler.ts";
import { isLeadText } from "../../app/lead.ts";
import type { OwnerPosts, PersonaRouter, PersonaRuntime } from "../../app/personas.ts";
import { normalizeTopicTitle, type StartTopicDeps, type StartTopicPlace, startTopic } from "../../app/session-ops.ts";
import {
  buildTopics,
  GENERAL_GROUP,
  OTHER_GROUP,
  summarize,
  TOPIC_GROUP_PATTERN,
  TOPICS_DONE_SCAN,
  type TopicLast,
  type TopicsInput,
  type TopicsResult,
  type TopicSeed,
  type TopicTurn,
} from "../../app/topics.ts";
import {
  MOVE_FAILED_TEXT,
  type MoveDeps,
  type MoveOutcome,
  moveRefusalText,
  movedPostText,
  moveTopic,
  parsePlace as parseMovePlace,
} from "../../app/topic-move.ts";
import type { TopicProposals } from "../../app/topic-proposals.ts";
import { modeChangedReply, type SessionModeDeps, setSessionMode } from "../../app/session-mode.ts";
import { resolveModelKey } from "../../agent/models.ts";
import { isProjectPermissionMode } from "../../agent/runner.ts";
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
import { type HistoryStore, type LatestHistory, recordHistory } from "../../store/history.ts";
import type { SdkSessionStore } from "../../store/sdk-sessions.ts";
import type { TopicReadStore } from "../../store/topic-reads.ts";
import type { TopicSessionStore } from "../../store/topic-sessions.ts";
import type { Route, RouteResult } from "../server.ts";
import { CC_PERMISSION_RECENT_MS, type HoldSeconds, questionJson } from "./cc.ts";
import { channelLink, CLOSE_CONFIRM_NOTICE, type webChannelLookup } from "./channels.ts";
import { WEB_DUPLICATE_WINDOW_MS } from "./turns.ts";

export type TopicRouteDeps = {
  cfg: Pick<Config, "allowedGuildIds" | "personas" | "workspaceDir">;
  guildSettings: Pick<GuildSettingsStore, "get" | "personaInbox">;
  topicSessions: Pick<TopicSessionStore, "get" | "listByState" | "getCloseDraft"> & Partial<Pick<TopicSessionStore, "projectDirOf">>;
  history: Pick<HistoryStore, "list" | "latestByChannel">;
  personas: Pick<PersonaRouter, "ownerOf"> & { all: readonly Pick<PersonaRuntime, "id" | "name">[] };
  /** 実行中のターンと、順番待ちのチャンネル（queuedChannels が無ければ queued は全部 false） */
  handler: Pick<Handler, "runningTurns"> & Partial<Pick<Handler, "queuedChannels">>;
  places: CcPlaces;
  home: string;
  /** projectOf に渡すワークスペースの root（配線で realpath したもの）。無ければ cfg.workspaceDir */
  workspaceRoot?: string;
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
  /** POST /api/topics の配線（sessionRoutes と同じ実体）。無ければ POST のルートを足さない */
  start?: StartTopicDeps & { defaultConnected: () => boolean };
  /**
   * POST /api/topics/ch:<id>/place の配線（/move と同じ実体）。無ければそのルートを足さず、movable も今のまま。
   * moves.runningChannels は movable の「場所を変えています」に使う。ownerPosts は結果の投稿（sessionRoutes に渡している物）
   */
  move?: MoveDeps & { ownerPosts: Pick<OwnerPosts, "send"> };
  /**
   * POST /api/topics/ch:<id>/mode の配線（/mode と同じ実体）。無ければそのルートを足さない。
   * post は変えたときの文をチャンネルへ持ち主の Bot で投稿する口（待たない。失敗は log だけ）
   */
  mode?: { deps: SessionModeDeps; post(channelId: string, text: string): Promise<void> };
  /**
   * 右腕の場所を変える確認（app/topic-proposals.ts）。期限の中の確認を、その話題の「あなたの番」（confirm）に付ける。
   * POST /api/topics/moves/<id>/accept・/keep の配線（Discord のボタンと同じ実体）。無ければその 2 つのルートを足さない
   */
  proposals?: Pick<TopicProposals, "pendingAll" | "accept" | "keep" | "channelOf">;
  /** GET /api/topics の元。右腕の topic_list と共有するとき、同じ deps で createTopicCollector から作った物を渡す。無ければここで作る */
  collect?: (at: number, done: string | null) => TopicsInput;
  /**
   * 既読（M7。topic_reads）。渡したときだけ GET /api/topics の reads に値を入れ、POST /api/topics/ch:<id>/read を足す。
   * lookup は Web で開ける会話かの判定（main の webChannelOf。/turns・/messages と同じ引き方）
   */
  reads?: { store: Pick<TopicReadStore, "all" | "get" | "advance">; lookup: ReturnType<typeof webChannelLookup> };
  now?: () => Date;
};

const BAD_REQUEST: RouteResult = { status: 400, json: { error: "bad_request" } };
const NOT_FOUND: RouteResult = { status: 404, json: { error: "not_found" } };
/** 答えた後・期限切れの確認（POST /api/topics/moves/<id>/accept・/keep） */
const STALE: RouteResult = { status: 409, json: { error: "stale" } };

/** 同じ内容の POST /api/topics をまとめる長さ（web/routes/turns.ts の二重送信と同じ） */
export const TOPIC_START_DUPLICATE_MS = WEB_DUPLICATE_WINDOW_MS;

/** 要求の place（群の key と同じ形。other は受けない）→ 始める場所。p:<General の名前> は general と同じ。合わなければ undefined */
function parsePlace(value: unknown, generalDir: string | undefined): StartTopicPlace | undefined {
  if (typeof value !== "string" || !TOPIC_GROUP_PATTERN.test(value) || value === OTHER_GROUP) return undefined;
  if (value === GENERAL_GROUP) return { kind: "general" };
  const name = value.slice("p:".length);
  return name === generalDir ? { kind: "general" } : { kind: "project", name };
}

/** 入口は場所を変えられない */
const ENTRY_UNMOVABLE = { reason: "入口は場所を変えられません" };
/** 端末のセッションは場所を変えられない */
const CC_UNMOVABLE = { reason: "端末のセッションは場所を変えられません" };
/** セッションの話題が場所を変えられない理由（move の配線があるときだけ） */
const PERSONA_UNMOVABLE = { reason: "足した人格の話題は場所を変えられません" };
const DONE_UNMOVABLE = { reason: "完了した話題は場所を変えられません" };
/** 入口・Claude Code のセッションの種の順番待ち・止まった・右腕の印（どれも見ない） */
const NO_PROGRESS = { queued: false, lastAgent: null, lastOwnerId: null, byRightHand: false } as const;

/** latestByChannel の行 → 種の lastAgent（at は使わない） */
function lastAgentOf(row: LatestHistory | undefined): TopicSeed["lastAgent"] {
  const agent = row?.lastAgent ?? null;
  return agent === null ? null : { id: agent.id, outcome: agent.outcome, durationMs: agent.durationMs };
}
const MOVING_UNMOVABLE = { reason: "場所を変えています" };
const CC_DISABLED_UNMOVABLE = { reason: moveRefusalText("cc_disabled") };
const UNIFY_NOT_READY_UNMOVABLE = { reason: moveRefusalText("unify_not_ready") };

/** moveTopic の断り → 応答（not_session は 404） */
function moveRefusalResult(result: Exclude<MoveOutcome["result"], "moved" | "failed">): RouteResult {
  switch (result) {
    case "not_session":
      return NOT_FOUND;
    case "unify_not_ready":
      return { status: 503, json: { error: result } };
    case "invalid_project":
      return { status: 400, json: { error: result } };
    default:
      return { status: 409, json: { error: result } };
  }
}

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

/**
 * GET /api/topics の元（TopicsInput）を集める関数を作る（状態を持たない。右腕の topic_list も同じ物を使う）。
 * at は今の時刻（ms）、done は ?done= の群の key（無ければ null）
 */
export function createTopicCollector(deps: TopicRouteDeps): (at: number, done: string | null) => TopicsInput {
  const { cfg, guildSettings, topicSessions, history, personas, handler, places, home, projectPermissions, cc, move, proposals } = deps;
  const workspaceRoot = deps.workspaceRoot ?? cfg.workspaceDir;

  /** 既定でない人格の名前（既定なら null） */
  const personaOf = (channelId: string): string | null => {
    const id = personas.ownerOf(channelId);
    if (id === DEFAULT_PERSONA_ID) return null;
    return personas.all.find((persona) => persona.id === id)?.name ?? id;
  };

  /**
   * /close の確認（Web から始めたもの。最後の行がその知らせで、下書きもある。channels.ts の /turns の closeDraft と同じ条件）。無ければ undefined。
   * latest（latestByChannel の行）が notice のときだけ history.list を読む
   */
  const closeConfirm = (channelId: string, latest: TopicLast): TopicTurn | undefined => {
    if (latest === null || latest.kind !== "notice") return undefined;
    const last = history.list(channelId, { limit: 1 })[0];
    if (last === undefined || last.kind !== "notice" || last.source !== "system" || last.text !== CLOSE_CONFIRM_NOTICE) return undefined;
    if ((topicSessions.getCloseDraft(channelId) ?? null) === null) return undefined;
    return { kind: "confirm", summary: "閉じる前の確認", since: last.at, expiresAt: null };
  };

  /**
   * 右腕の last。最後の行が統括のまとめの notice（source system・isLeadText）なら lead: true を足す（#457 の L2。Web の未読に数える）。
   * latest が notice のときだけ history.list を読む（closeConfirm と同じ読み方）
   */
  const handLast = (channelId: string, latest: TopicLast): TopicLast => {
    if (latest === null || latest.kind !== "notice") return latest;
    const last = history.list(channelId, { limit: 1 })[0];
    if (last === undefined || last.kind !== "notice" || last.source !== "system" || !isLeadText(last.text)) return latest;
    return { ...latest, lead: true };
  };

  const collect = (at: number, done: string | null): TopicsInput => {
    const nowIso = new Date(at).toISOString();
    const guilds = cfg.allowedGuildIds.filter((id) => guildSettings.get(id) !== undefined);
    const runningIds = new Set(handler.runningTurns().map((turn) => turn.channelId));
    // 発言を積んだが、まだ始まっていないターンの在るチャンネル（1 回だけ引く）
    const queuedIds = new Set(handler.queuedChannels?.() ?? []);
    // 付け替えの途中のチャンネル（move の配線があるときだけ。1 回だけ引く）
    const movingIds = move?.moves.runningChannels();
    // 連携の設定が済んでいるか（連携があるときだけ。1 回だけ引く）
    const unifyReady = move?.projectSessions?.ready();
    /**
     * セッションの話題の movable（move の配線が無ければ今までどおり true。実行中・許可待ち・/close の途中は出さず、押したときに断る）。
     * 理由の順は moveTopic の検査と同じ（完了 → 足した人格 → 場所を変えています → 連携 → 連携の設定）
     */
    const sessionMovable = (channelId: string, state: string, persona: string | null): TopicSeed["movable"] => {
      if (movingIds === undefined) return true;
      if (state === "done") return DONE_UNMOVABLE;
      if (persona !== null) return PERSONA_UNMOVABLE;
      if (movingIds.has(channelId)) return MOVING_UNMOVABLE;
      if (unifyReady === undefined) return CC_DISABLED_UNMOVABLE;
      if (!unifyReady) return UNIFY_NOT_READY_UNMOVABLE;
      return true;
    };
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

    // Claude Code のセッションの 1 行
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
      const project = projectOf(cwd, workspaceRoot);
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
        if (cc !== undefined) {
          for (const permission of hookPermissions) {
            if (permission.sessionId === view.sessionId) turns.push(permissionTurn(permission, cc));
          }
        }
        if (turns.length === 0 && view.state === "needs_input") {
          const since = sinceOf(view);
          turns.push({
            kind: "waiting",
            summary: summarize(view.waitingFor || "判断待ち"),
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
        ...NO_PROGRESS,
      };
    };

    for (const guildId of guilds) {
      const settings = guildSettings.get(guildId)!;
      const latest = history.latestByChannel(guildId);
      // last は id・at・kind だけ（lastAgent・lastOwnerId はセッションの話題の種にだけ使う）
      const lastOf = (channelId: string): TopicLast => {
        const row = latest.get(channelId);
        return row === undefined ? null : { id: row.id, at: row.at, kind: row.kind };
      };

      // (1) セッション
      for (const state of ["active", "waiting", "done"] as const) {
        const limit = state === "done" ? TOPICS_DONE_SCAN : SESSION_LIST_LIMITS[state];
        for (const item of topicSessions.listByState(guildId, state, limit)) {
          if (item.state === "deleted") continue;
          const channelId = item.channelId;
          const found = topicSessions.projectDirOf?.(channelId);
          const last = lastOf(channelId);
          const turns: TopicTurn[] = [];
          // done は turn を持たないので、待っているものを探さない
          if (item.state !== "done") {
            if (projectPermissions !== undefined) {
              const row = projectPermissions.store.latestSdkFor(
                channelId,
                projectPermissions.sessions.get(channelId),
                new Date(at - CC_PERMISSION_RECENT_MS),
              );
              if (row !== undefined && row.state === "pending") turns.push(permissionTurn(row, projectPermissions));
            }
            const confirm = closeConfirm(channelId, last);
            if (confirm !== undefined) turns.push(confirm);
          }
          const persona = personaOf(channelId);
          seeds.push({
            id: `ch:${channelId}`,
            title: item.title,
            origin: found === undefined ? "session" : "project",
            dir: found !== undefined && CC_PROJECT_PATTERN.test(found.projectDir) ? found.projectDir : null,
            outside: false,
            pinned: false,
            persona,
            sessionId: null,
            cwdLabel: null,
            state: item.state,
            activityAt: last?.at ?? item.lastActivityAt,
            last,
            link: channelLink(guildId, channelId),
            running: runningIds.has(channelId),
            turns,
            movable: sessionMovable(channelId, item.state, persona),
            queued: queuedIds.has(channelId) && !runningIds.has(channelId),
            lastAgent: lastAgentOf(latest.get(channelId)),
            lastOwnerId: latest.get(channelId)?.lastOwnerId ?? null,
            // session_open で始めた話題は origin inbox（#inbox の右腕。足した人格の入口 #<NAME> からも同じ）
            byRightHand: item.origin === "inbox",
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
          activityAt: last?.at ?? null,
          last,
          link: channelLink(guildId, channelId),
          running: runningIds.has(channelId),
          turns,
          movable: ENTRY_UNMOVABLE,
          ...NO_PROGRESS,
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
          last: handLast(settings.inboxChannelId, lastOf(settings.inboxChannelId)),
          link: channelLink(guildId, settings.inboxChannelId),
          turns,
        });
        track(settings.inboxChannelId, turns);
      }

      // (3) Claude Code のセッション（チャンネルのあるもの）
      if (cc !== undefined && snapshot !== undefined) {
        for (const row of ccRows.get(guildId) ?? []) {
          const listed = snapshot.sessions.find((session) => session.sessionId === row.sessionId);
          // 一覧に居れば active（/cc close で閉じただけのものも）。一覧が読めないときは open の行を active にする（全部を完了に見せない）
          const active = snapshot.unreadable ? row.state === "open" : listed !== undefined;
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
      }
    }

    // (3') チャンネルの無い Claude Code のセッション（サーバーによらず 1 回だけ足す）
    if (cc !== undefined && snapshot !== undefined) {
      for (const view of snapshot.sessions) {
        if (withChannel.has(view.sessionId)) continue;
        seeds.push(ccSeed({ id: `cc:${view.sessionId}`, view, row: undefined, active: true, last: null, link: null }));
      }
    }

    // (4) 確認の札（頼んだチャンネルの話題か右腕へ。合わないものは捨てる）
    // expiresAt を渡さなければ CC7 の確認の期限（作った時刻 + 10 分）
    const attach = (channelId: string, summary: string, createdAt: string, expiresAt?: string) => {
      const turn: TopicTurn = {
        kind: "confirm",
        summary,
        since: createdAt,
        expiresAt: expiresAt ?? new Date(Date.parse(createdAt) + CC_CONFIRM_TTL_MS).toISOString(),
      };
      for (const turns of byChannel.get(channelId) ?? []) turns.push(turn);
    };
    if (cc !== undefined) {
      const cutoff = new Date(at);
      for (const row of cc.starts.listAwaitingConfirmBefore(cutoff)) attach(row.channelId, "Claude Code を起動する確認", row.createdAt);
      for (const row of cc.sends.listAwaitingConfirmBefore(cutoff)) {
        if (row.origin === "tool" && row.channelId !== null) attach(row.channelId, "Claude Code に送る確認", row.createdAt);
      }
    }
    // 右腕の場所を変える確認（場所が変わる話題へ。cc が無くても付ける。cc の確認の後ろに置き、cc の確認の順を変えない）
    for (const proposal of proposals?.pendingAll() ?? []) {
      attach(proposal.channelId, summarize(`場所を ${proposal.to} に変える確認`), proposal.createdAt, proposal.expiresAt);
    }

    // 時間切れの待ちは数えない（expiresAt が今より前のもの）
    const live = (turns: TopicTurn[]): TopicTurn[] => turns.filter((turn) => turn.expiresAt === null || Date.parse(turn.expiresAt) >= at);
    return {
      seeds: seeds.map((seed) => ({ ...seed, turns: live(seed.turns) })),
      projects,
      generalDir: places.generalDir ?? null,
      rightHands: rightHands.map((hand) => ({ ...hand, turns: live(hand.turns) })),
      done,
      cc: snapshot === undefined ? { enabled: false, stale: false, unreadable: false } : { enabled: true, stale: snapshot.stale, unreadable: snapshot.unreadable },
    };
  };
  return collect;
}

/** 応答の話題（ch: の物）と右腕のうち、既読の行のある会話の { [channelId]: lastReadId }。reads の配線が無ければ {} */
function readsOfResult(result: TopicsResult, store: Pick<TopicReadStore, "all"> | undefined): Record<string, number> {
  const out: Record<string, number> = {};
  if (store === undefined) return out;
  const all = store.all();
  for (const { id } of [...result.topics, ...result.rightHands]) {
    if (!id.startsWith("ch:")) continue;
    const channelId = id.slice("ch:".length);
    const value = all.get(channelId);
    if (value !== undefined) out[channelId] = value;
  }
  return out;
}

export function topicRoutes(deps: TopicRouteDeps): Route[] {
  const { cfg, guildSettings, places, move, mode, proposals, reads } = deps;
  const now = deps.now ?? (() => new Date());
  const collect = deps.collect ?? createTopicCollector(deps);
  const readsOf = (result: TopicsResult): Record<string, number> => readsOfResult(result, reads?.store);

  const routes: Route[] = [
    {
      method: "GET",
      pattern: /^\/api\/topics$/,
      handle: async ({ query }) => {
        const done = query.get("done");
        if (done !== null && !TOPIC_GROUP_PATTERN.test(done)) return BAD_REQUEST;
        const result = buildTopics(collect(now().getTime(), done));
        return { status: 200, json: { ...result, reads: readsOf(result) } };
      },
    },
  ];
  if (reads !== undefined) {
    routes.push({
      method: "POST",
      pattern: /^\/api\/topics\/ch:(\d{1,25})\/read$/,
      handle: async ({ params, body }) => {
        const channelId = params[0] ?? "";
        const lastId: unknown = body?.lastId;
        if (typeof lastId !== "number" || !Number.isSafeInteger(lastId) || lastId < 1) return BAD_REQUEST;
        if (reads.lookup(channelId) === undefined) return NOT_FOUND;
        // まだ無い行まで既読にさせない（最新の history.id で頭打ち）。履歴の無い会話には書かない
        const latest = deps.history.list(channelId, { limit: 1 })[0];
        if (latest === undefined) return { status: 200, json: { lastReadId: reads.store.get(channelId) } };
        return { status: 200, json: { lastReadId: reads.store.advance(channelId, Math.min(lastId, latest.id)) } };
      },
    });
  }
  if (move !== undefined) {
    routes.push({
      method: "POST",
      pattern: /^\/api\/topics\/ch:(\d{1,25})\/place$/,
      handle: async ({ params, body }) => {
        const channelId = params[0] ?? "";
        const place = parseMovePlace(body?.place, places.generalDir);
        if (place === undefined) return BAD_REQUEST;
        const session = move.topicSessions.get(channelId);
        if (session === undefined || !cfg.allowedGuildIds.includes(session.guildId)) return NOT_FOUND;
        const { guildId } = session;
        // 受け付けるか（検査と running の行）は moveTopic が最初の await の前に決める。onAccepted が呼ばれなかったら、その結果で断る
        let accepted = false;
        const running = moveTopic({ guildId, channelId, place, by: "web" }, move, () => {
          accepted = true;
        });
        if (!accepted) {
          const outcome = await running;
          if (outcome.result === "moved" || outcome.result === "failed") throw new Error("場所の付け替えが受け付けずに終わりました");
          return moveRefusalResult(outcome.result);
        }
        move.log(`Web から場所の付け替えを受け付けました（guild=${guildId}）`);
        void running
          .then(async (outcome) => {
            const text =
              outcome.result === "moved"
                ? movedPostText(outcome, places.generalDir)
                : outcome.result === "failed"
                  ? MOVE_FAILED_TEXT
                  : `場所を変えられませんでした: ${moveRefusalText(outcome.result)}`;
            try {
              await move.ownerPosts.send(channelId, text);
            } catch (error) {
              move.log(`場所の付け替えの結果を Discord に投稿できませんでした（${errorName(error)}）`);
            }
          })
          .catch(async (error: unknown) => {
            // 受け付けた後の例外。失敗の文をチャンネルと履歴に残す。どちらの失敗も log だけ
            move.log(`Web からの場所の付け替えに失敗しました（${errorName(error)}）`);
            recordHistory(move.history, { guildId, channelId, kind: "notice", source: "system", text: MOVE_FAILED_TEXT }, move.log);
            try {
              await move.ownerPosts.send(channelId, MOVE_FAILED_TEXT);
            } catch (postError) {
              move.log(`場所の付け替えの結果を Discord に投稿できませんでした（${errorName(postError)}）`);
            }
          });
        return { status: 202, json: { accepted: true } };
      },
    });
  }
  if (mode !== undefined) {
    routes.push({
      method: "POST",
      pattern: /^\/api\/topics\/ch:(\d{1,25})\/mode$/,
      handle: async ({ params, body }) => {
        const channelId = params[0] ?? "";
        const value: unknown = body?.mode;
        if (!isProjectPermissionMode(value)) return BAD_REQUEST;
        const session = mode.deps.topicSessions.get(channelId);
        if (session === undefined || !cfg.allowedGuildIds.includes(session.guildId)) return NOT_FOUND;
        const { guildId } = session;
        const outcome = setSessionMode({ guildId, channelId, mode: value, by: "web" }, mode.deps);
        switch (outcome.result) {
          case "not_session":
            return NOT_FOUND;
          case "closed":
          case "not_project":
          case "busy":
            return { status: 409, json: { error: outcome.result } };
          case "unchanged":
            return { status: 200, json: { result: "unchanged", mode: value } };
          case "changed":
            mode.deps.log(`Web から許可のモードを変えました（guild=${guildId}）`);
            void mode.post(channelId, modeChangedReply(value)).catch((error: unknown) => {
              mode.deps.log(`許可のモードの変更を Discord に投稿できませんでした（${errorName(error)}）`);
            });
            return { status: 200, json: { result: "changed", mode: value } };
        }
      },
    });
  }
  if (proposals !== undefined) {
    /** 確認の行があり、その話題が許可したサーバーの物か（行が無い・話題が無い・許可の外は 404） */
    const known = (id: number): boolean => {
      const channelId = proposals.channelOf(id);
      if (channelId === undefined) return false;
      const session = deps.topicSessions.get(channelId);
      return session !== undefined && cfg.allowedGuildIds.includes(session.guildId);
    };
    routes.push(
      {
        method: "POST",
        pattern: /^\/api\/topics\/moves\/(\d{1,10})\/accept$/,
        handle: async ({ params }) => {
          const id = Number(params[0]);
          if (!known(id)) return NOT_FOUND;
          const result = await proposals.accept(id);
          switch (result.result) {
            case "accepted":
              return { status: 202, json: { accepted: true } };
            case "stale":
              return STALE;
            case "refused": {
              const refused = moveRefusalResult(result.reason);
              return { status: refused.status, json: { error: result.reason, message: moveRefusalText(result.reason) } };
            }
          }
        },
      },
      {
        method: "POST",
        pattern: /^\/api\/topics\/moves\/(\d{1,10})\/keep$/,
        handle: async ({ params }) => {
          const id = Number(params[0]);
          if (!known(id)) return NOT_FOUND;
          const result = await proposals.keep(id);
          return result.result === "kept" ? { status: 200, json: { ok: true } } : STALE;
        },
      },
    );
  }
  const start = deps.start;
  if (start === undefined) return routes;

  /**
   * 直近の POST /api/topics（二重の判定。最後の 1 件だけ）。結果は Promise で持ち、同時に来た 2 回目も 1 回目の結果を待って同じものを返す。
   * 201 でなかったものは消して、すぐやり直せるようにする
   */
  let recent: { key: string; at: number; response: Promise<RouteResult> } | undefined;

  /** model はモデルの key（resolveModelKey で確かめた物。省略は場所の既定） */
  const begin = async (
    guildId: string,
    place: StartTopicPlace,
    title: string | undefined,
    text: string | undefined,
    model: string | undefined,
  ): Promise<RouteResult> => {
    const result = await startTopic(
      {
        guildId,
        place,
        by: "web",
        at: now(),
        ...(title === undefined ? {} : { title }),
        ...(text === undefined ? {} : { text }),
        ...(model === undefined ? {} : { model }),
      },
      start,
    );
    switch (result.result) {
      case "empty":
        return { status: 400, json: { error: "empty" } };
      case "too_long":
        return { status: 400, json: { error: "too_long", field: result.field } };
      case "invalid_project":
        return { status: 400, json: { error: "invalid_project" } };
      case "cc_disabled":
        return { status: 409, json: { error: "cc_disabled" } };
      case "unify_not_ready":
        return { status: 503, json: { error: "unify_not_ready" } };
      case "not_set_up":
        return { status: 409, json: { error: "not_set_up" } };
      case "created": {
        const mode = result.projectDir === null ? "light" : "project";
        start.log(`Web から話題を始めました（guild=${guildId}、${mode === "project" ? "プロジェクトのセッション" : "軽いセッション"}）`);
        return {
          status: 201,
          json: {
            id: `ch:${result.channelId}`,
            channelId: result.channelId,
            link: channelLink(guildId, result.channelId),
            title: result.title,
            place: { dir: result.projectDir },
            mode,
            turn: result.turn,
          },
        };
      }
    }
  };

  routes.push({
    method: "POST",
    pattern: /^\/api\/topics$/,
    handle: async ({ body }) => {
      const place = parsePlace(body?.place, places.generalDir);
      if (place === undefined) return BAD_REQUEST;
      const title = body?.title;
      const text = body?.text;
      const requested = body?.guildId;
      if (title !== undefined && typeof title !== "string") return BAD_REQUEST;
      if (text !== undefined && typeof text !== "string") return BAD_REQUEST;
      if (requested !== undefined && (typeof requested !== "string" || !cfg.allowedGuildIds.includes(requested))) return BAD_REQUEST;
      // モデルは一覧の key だけ（空文字も知らない key として断る）
      const rawModel = body?.model;
      if (rawModel !== undefined && typeof rawModel !== "string") return BAD_REQUEST;
      const picked = rawModel === undefined ? undefined : resolveModelKey(rawModel);
      if (rawModel !== undefined && picked === undefined) return { status: 400, json: { error: "invalid_model" } };
      // 要求に無ければ、許可したサーバーのうち /setup 済みの最初の 1 つ
      const guildId = requested ?? cfg.allowedGuildIds.find((id) => guildSettings.get(id) !== undefined);
      if (guildId === undefined) return { status: 409, json: { error: "not_set_up" } };
      // チャンネルを作るのは既定の人格の Bot
      if (!start.defaultConnected()) return { status: 503, json: { error: "bot_disconnected" } };
      const placeKey = place.kind === "general" ? GENERAL_GROUP : `p:${place.name}`;
      const key = JSON.stringify([guildId, placeKey, normalizeTopicTitle(title ?? ""), (text ?? "").trim(), picked?.key ?? ""]);
      const at = now().getTime();
      if (recent !== undefined && recent.key === key && at - recent.at < TOPIC_START_DUPLICATE_MS) return recent.response;
      const entry = { key, at, response: begin(guildId, place, title, text, picked?.key) };
      recent = entry;
      const done = await entry.response.catch((error: unknown) => {
        if (recent === entry) recent = undefined;
        throw error;
      });
      if (done.status !== 201 && recent === entry) recent = undefined;
      return done;
    },
  });
  return routes;
}

function errorName(error: unknown): string {
  return error instanceof Error ? error.name : typeof error;
}
