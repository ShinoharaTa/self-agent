// 話題の一覧（docs/plan/web-ui-v3.md §3〜§5・§11 の M1）。セッション・プロジェクトのセッション・Claude Code のセッションを 1 つの形（Topic）にし、
// 群（プロジェクト・General・ほかの場所）と「あなたの番」を数える純関数（DB・時計・fs を触らない）。集めるのは web/routes/topics.ts
import type { HistoryKind } from "../store/history.ts";

export type TopicTurnKind = "permission" | "question" | "waiting" | "confirm";
export type TopicTurn = {
  kind: TopicTurnKind;
  /** 1 行・80 字まで */
  summary: string;
  /** 待ち始めた時刻（ISO） */
  since: string;
  /** 時間切れの時刻（ISO）。無ければ null */
  expiresAt: string | null;
};
/** "unread" は M7 で使う。M1 は出さない（型にだけ置く） */
export type TopicMark = "turn" | "running" | "unread" | null;
export type TopicLast = { id: number; at: string; kind: HistoryKind } | null;

export type Topic = {
  /** Discord のチャンネルがあれば "ch:<channelId>"、無い Claude Code のセッションは "cc:<sessionId>" */
  id: string;
  title: string;
  /** 群の key（"p:<名前>"・"general"・"other"） */
  group: string;
  place: { dir: string | null };
  origin: "session" | "project" | "cc";
  /** 入口（#tasks・足した人格の入口）。完了にならず、群の末尾に固定 */
  pinned: boolean;
  /** 既定でない人格の名前。既定なら null */
  persona: string | null;
  /** Claude Code のセッションの ID（origin cc で、一覧に居るときだけ。ほかは null） */
  sessionId: string | null;
  /** origin cc の cwd の表示（cc/labels.ts の cwdLabel）。ほかは null */
  cwdLabel: string | null;
  mark: TopicMark;
  turn: TopicTurn | null;
  state: "active" | "waiting" | "done";
  /** 並びに使う時刻（ISO） */
  activityAt: string;
  last: TopicLast;
  movable: true | { reason: string };
  /** Discord のチャンネルの URL。無ければ null */
  link: string | null;
};

export type TopicGroup = {
  key: string;
  kind: "project" | "general" | "other";
  name: string;
  /** mark が "turn" の話題の数 */
  turns: number;
  /** mark が "running" の話題の数 */
  running: number;
  /** done でない話題の数（pinned を含む） */
  open: number;
  done: number;
  hasTopics: boolean;
};

export type RightHand = { id: string; guildId: string; title: "右腕"; turn: TopicTurn | null; last: TopicLast; link: string };

export type TopicsResult = {
  turns: number;
  turnIds: string[];
  groups: TopicGroup[];
  topics: Topic[];
  rightHands: RightHand[];
  cc: { enabled: boolean; stale: boolean; unreadable: boolean };
};

/** ルートが集めて渡す 1 行 */
export type TopicSeed = {
  id: string;
  title: string;
  origin: Topic["origin"];
  /** ワークスペースの直下のプロジェクトの名前。無ければ null */
  dir: string | null;
  /** cwd がワークスペースの外（origin cc だけ true になりうる） */
  outside: boolean;
  pinned: boolean;
  persona: string | null;
  sessionId: string | null;
  cwdLabel: string | null;
  state: Topic["state"];
  activityAt: string;
  last: TopicLast;
  link: string | null;
  running: boolean;
  /** この話題で待っているもの全部（0 個以上。pickTurn が 1 つ選ぶ） */
  turns: TopicTurn[];
  movable: Topic["movable"];
};

export type TopicsInput = {
  seeds: TopicSeed[];
  /** ワークスペースの直下のプロジェクトの名前（話題が無くても群にする） */
  projects: string[];
  rightHands: (Omit<RightHand, "turn"> & { turns: TopicTurn[] })[];
  /** ?done= の群の key。無ければ null */
  done: string | null;
  cc: TopicsResult["cc"];
};

/** 待っているものの要約の長さ */
export const TOPIC_SUMMARY_MAX = 80;
/** 完了のセッションを読む数（?done= の元） */
export const TOPICS_DONE_SCAN = 200;
/** ?done= で足す完了の数 */
export const TOPICS_DONE_MAX = 50;
export const GENERAL_GROUP = "general";
export const OTHER_GROUP = "other";
export const GENERAL_NAME = "General";
export const OTHER_NAME = "ほかの場所";
/** 群の key の形（?done= の検証） */
export const TOPIC_GROUP_PATTERN = /^(general|other|p:[A-Za-z0-9_-]{1,64})$/;

const PROJECT_PREFIX = "p:";

/** 空白の並び（改行を含む）を 1 つにし、前後を削り、TOPIC_SUMMARY_MAX 字を超えたら切って … を付ける */
export function summarize(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > TOPIC_SUMMARY_MAX ? `${flat.slice(0, TOPIC_SUMMARY_MAX - 1)}…` : flat;
}

/** 群の key（外は other、プロジェクトは p:<名前>、ほかは general） */
export function groupKeyOf(seed: Pick<TopicSeed, "dir" | "outside">): string {
  if (seed.outside) return OTHER_GROUP;
  return seed.dir !== null ? `${PROJECT_PREFIX}${seed.dir}` : GENERAL_GROUP;
}

/** ISO の時刻 → ms（読めなければ 0） */
function time(iso: string): number {
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? 0 : ms;
}

function compareIds(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** 新しい順 */
function newerFirst(a: { activityAt: string }, b: { activityAt: string }): number {
  return time(b.activityAt) - time(a.activityAt);
}

/** 時間切れの近い順（null は後ろ）→ 待ち始めの古い順 */
export function compareTurns(a: TopicTurn, b: TopicTurn): number {
  if (a.expiresAt !== b.expiresAt) {
    if (a.expiresAt === null) return 1;
    if (b.expiresAt === null) return -1;
    const diff = time(a.expiresAt) - time(b.expiresAt);
    if (diff !== 0) return diff;
  }
  return time(a.since) - time(b.since);
}

const TURN_PRIORITY: Readonly<Record<TopicTurnKind, number>> = { permission: 0, question: 0, waiting: 1, confirm: 2 };

/** 待っているものから 1 つ（許可・質問 > 判断待ち > 確認。同じなら古い方）。空なら null */
export function pickTurn(turns: TopicTurn[]): TopicTurn | null {
  let best: TopicTurn | null = null;
  for (const turn of turns) {
    if (best === null) {
      best = turn;
      continue;
    }
    const diff = TURN_PRIORITY[turn.kind] - TURN_PRIORITY[best.kind];
    if (diff < 0 || (diff === 0 && time(turn.since) < time(best.since))) best = turn;
  }
  return best;
}

/** 印（あなたの番 → 作業中。M1 は "unread" を返さない） */
export function markOf(turn: TopicTurn | null, running: boolean): TopicMark {
  if (turn !== null) return "turn";
  return running ? "running" : null;
}

function markRank(mark: TopicMark): number {
  return mark === "turn" ? 0 : mark === "running" ? 1 : 2;
}

/** 群の中の並び（固定は末尾 → 印 → あなたの番は時間切れの近い順 → 新しい順 → id） */
export function compareTopics(a: Topic, b: Topic): number {
  if (a.pinned !== b.pinned) return a.pinned ? 1 : -1;
  const rank = markRank(a.mark) - markRank(b.mark);
  if (rank !== 0) return rank;
  if (a.mark === "turn" && b.mark === "turn" && a.turn !== null && b.turn !== null) {
    const turn = compareTurns(a.turn, b.turn);
    if (turn !== 0) return turn;
  }
  const newer = newerFirst(a, b);
  if (newer !== 0) return newer;
  return compareIds(a.id, b.id);
}

function topicOf(seed: TopicSeed): Topic {
  const done = seed.state === "done";
  const turn = done ? null : pickTurn(seed.turns);
  return {
    id: seed.id,
    title: seed.title,
    group: groupKeyOf(seed),
    place: { dir: seed.outside ? null : seed.dir },
    origin: seed.origin,
    pinned: seed.pinned,
    persona: seed.persona,
    sessionId: seed.sessionId,
    cwdLabel: seed.cwdLabel,
    mark: done ? null : markOf(turn, seed.running),
    turn,
    state: seed.state,
    activityAt: seed.activityAt,
    last: seed.last,
    movable: seed.movable,
    link: seed.link,
  };
}

function emptyGroup(key: string, kind: TopicGroup["kind"], name: string): TopicGroup {
  return { key, kind, name, turns: 0, running: 0, open: 0, done: 0, hasTopics: false };
}

/** 話題の一覧・群・あなたの番（入力は書き換えない） */
export function buildTopics(input: TopicsInput): TopicsResult {
  const all = input.seeds.map(topicOf);

  // 群（プロジェクトは input.projects と話題の p: の名前の和）
  const groups = new Map<string, TopicGroup>();
  for (const name of input.projects) groups.set(`${PROJECT_PREFIX}${name}`, emptyGroup(`${PROJECT_PREFIX}${name}`, "project", name));
  groups.set(GENERAL_GROUP, emptyGroup(GENERAL_GROUP, "general", GENERAL_NAME));
  for (const topic of all) {
    if (!groups.has(topic.group)) {
      groups.set(
        topic.group,
        topic.group === OTHER_GROUP
          ? emptyGroup(OTHER_GROUP, "other", OTHER_NAME)
          : emptyGroup(topic.group, "project", topic.group.slice(PROJECT_PREFIX.length)),
      );
    }
    const group = groups.get(topic.group)!;
    if (topic.mark === "turn") group.turns++;
    if (topic.mark === "running") group.running++;
    if (topic.state === "done") group.done++;
    else group.open++;
  }
  for (const group of groups.values()) group.hasTopics = group.open > 0;

  const projects = [...groups.values()].filter((group) => group.kind === "project").sort((a, b) => compareIds(a.name, b.name));
  const ordered = [
    ...projects.filter((group) => group.open > 0),
    ...projects.filter((group) => group.open === 0),
    groups.get(GENERAL_GROUP)!,
    ...(groups.has(OTHER_GROUP) ? [groups.get(OTHER_GROUP)!] : []),
  ];

  // 話題（群の順 → done でないもの → ?done= の群の完了を新しい順に TOPICS_DONE_MAX 件まで）
  const topics: Topic[] = [];
  for (const group of ordered) {
    const members = all.filter((topic) => topic.group === group.key);
    topics.push(...members.filter((topic) => topic.state !== "done").sort(compareTopics));
    if (input.done === group.key) {
      topics.push(
        ...members
          .filter((topic) => topic.state === "done")
          .sort((a, b) => newerFirst(a, b) || compareIds(a.id, b.id))
          .slice(0, TOPICS_DONE_MAX),
      );
    }
  }

  const rightHands: RightHand[] = input.rightHands.map((hand) => ({
    id: hand.id,
    guildId: hand.guildId,
    title: hand.title,
    turn: pickTurn(hand.turns),
    last: hand.last,
    link: hand.link,
  }));

  // あなたの番（話題と右腕）
  const waiting: Array<{ id: string; turn: TopicTurn }> = [];
  for (const topic of all) if (topic.mark === "turn" && topic.turn !== null) waiting.push({ id: topic.id, turn: topic.turn });
  for (const hand of rightHands) if (hand.turn !== null) waiting.push({ id: hand.id, turn: hand.turn });
  waiting.sort((a, b) => compareTurns(a.turn, b.turn) || compareIds(a.id, b.id));

  return {
    turns: waiting.length,
    turnIds: waiting.map((item) => item.id),
    groups: ordered,
    topics,
    rightHands,
    cc: input.cc,
  };
}
