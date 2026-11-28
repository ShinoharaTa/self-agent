// 統括のまとめ（docs/plan/lead.md の L2。#457）。話題のターンの終わりの事象を 60 秒の窓でサーバーごとに束ね、#inbox に 1 通と history の notice 1 行を出す。
// LLM は使わない。題名・本文は入れない。失敗は log だけ。再起動で窓の中の分は出さない
import { DEFAULT_PERSONA_ID, type LeadRing, type LeadScope } from "../config.ts";
import { mentionPrefix } from "../discord/convert.ts";
import type { OutgoingMessage } from "../discord/gateway.ts";
import { type HistoryStore, recordHistory } from "../store/history.ts";
import { MESSAGE_MAX_LENGTH } from "./commands/sessions.ts";
import { type ProgressTimers, REAL_TIMERS, type TurnOutcome } from "./progress.ts";
import type { TopicsResult } from "./topics.ts";

/** 最初の事象から出すまでの窓（延ばさない） */
export const LEAD_WINDOW_MS = 60_000;
/** これ以上かかったターンを「長い」とみなす */
export const LEAD_LONG_MS = 120_000;
/** 話題の行の上限 */
export const LEAD_MAX_LINES = 10;

/** 話題（セッションのチャンネル）のターンの終わり */
export type TurnEndEvent = {
  guildId: string;
  channelId: string;
  durationMs: number;
  outcome: TurnOutcome;
  /** そのターンの入口（右腕・GitHub から送った最初の一言） */
  via?: "right_hand" | "github";
  /** 右腕が始めた話題（sessions.origin が inbox） */
  byRightHand: boolean;
  /** 返事が Discord のオーナーの発言への返信で出た（その返事で既に鳴っている） */
  pinged: boolean;
};

export type LeadSettings = { ring: LeadRing; scope: LeadScope };
export type LeadCounts = { running: number; queued: number; yourTurn: number };

/** まとめに入れるか */
export function inScope(event: TurnEndEvent, scope: LeadScope): boolean {
  switch (scope) {
    case "all":
      return true;
    case "long":
      return event.via !== undefined || event.durationMs >= LEAD_LONG_MS || event.outcome !== "done";
    case "right_hand":
      return event.byRightHand;
  }
}

/** この事象でオーナーを鳴らすか。中断（オーナーの操作）と、返事で既に鳴ったターンは鳴らさない */
export function ringsFor(event: TurnEndEvent, ring: LeadRing): boolean {
  const hard = event.outcome === "max_turns" || event.outcome === "failed";
  switch (ring) {
    case "off":
      return false;
    case "all":
      return true;
    case "stopped":
      return hard && !event.pinged;
    case "long":
      return (hard || (event.outcome === "done" && event.durationMs >= LEAD_LONG_MS)) && !event.pinged;
  }
}

/** 残りの数。端末の行（origin cc）は数えない。あなたの番は一覧と同じ turns */
export function leadCounts(result: Pick<TopicsResult, "turns" | "topics">): LeadCounts {
  let running = 0;
  let queued = 0;
  for (const topic of result.topics) {
    if (topic.origin === "cc") continue;
    if (topic.mark === "running") running++;
    if (topic.queued === true) queued++;
  }
  return { running, queued, yourTurn: result.turns };
}

const DONE_HEAD = "終わりました: <#";
const STOPPED_HEAD = "止まりました: <#";

/** 並びの順（止まった物を先、終わった物を後） */
const OUTCOME_ORDER: Record<TurnOutcome, number> = { max_turns: 0, failed: 1, aborted: 2, done: 3 };

function durationText(ms: number): string {
  return ms < 60_000 ? "1 分未満" : `${Math.floor(ms / 60_000)} 分`;
}

/** 既定の場所の書き方（今の `<#ID>`） */
function channelRef(channelId: string): string {
  return `<#${channelId}>`;
}

function eventLine(event: TurnEndEvent, refOf: (channelId: string) => string = channelRef): string {
  const channel = refOf(event.channelId);
  switch (event.outcome) {
    case "done":
      return `終わりました: ${channel}（${durationText(event.durationMs)}）`;
    case "max_turns":
      return `止まりました: ${channel}（上限。［続ける］が要ります）`;
    case "failed":
      return `止まりました: ${channel}（失敗）`;
    case "aborted":
      return `止まりました: ${channel}（中断）`;
  }
}

function countsLine(counts: LeadCounts): string {
  const parts = [
    ...(counts.running > 0 ? [`動いている ${counts.running}`] : []),
    ...(counts.queued > 0 ? [`順番待ち ${counts.queued}`] : []),
    ...(counts.yourTurn > 0 ? [`あなたの番 ${counts.yourTurn}`] : []),
  ];
  return `残り: ${parts.length === 0 ? "なし" : parts.join("・")}`;
}

/**
 * まとめの本文（mention の字は入れない）。counts が null なら残りの行を出さない。
 * refOf は話題の書き方（place-refs.ts。既定は `<#ID>`）。maxLines は話題の行の上限（超えれば maxLines - 1 行 + 「ほか n 件」）
 */
export function leadText(
  events: readonly TurnEndEvent[],
  counts: LeadCounts | null,
  refOf: (channelId: string) => string = channelRef,
  maxLines: number = LEAD_MAX_LINES,
): string {
  const sorted = events
    .map((event, index) => ({ event, index }))
    .sort((a, b) => OUTCOME_ORDER[a.event.outcome] - OUTCOME_ORDER[b.event.outcome] || a.index - b.index)
    .map(({ event }) => event);
  const shown = sorted.length > maxLines ? sorted.slice(0, maxLines - 1) : sorted;
  const lines = shown.map((event) => eventLine(event, refOf));
  if (shown.length < sorted.length) lines.push(`ほか ${sorted.length - shown.length} 件`);
  if (counts !== null) lines.push(countsLine(counts));
  return lines.join("\n");
}

/** まとめの文か（history の notice の本文を見分ける） */
export function isLeadText(text: string): boolean {
  return text.startsWith(DONE_HEAD) || text.startsWith(STOPPED_HEAD);
}

export type LeadDeps = {
  /** 関数で受ける（後で Web の設定に差し替えられる） */
  settings: () => LeadSettings;
  ownerUserId: string | undefined;
  /** そのサーバーの既定の人格の #inbox。無ければ null */
  inboxOf: (guildId: string) => string | null;
  post: (channelId: string, message: OutgoingMessage) => Promise<string>;
  /** 残りの数。取れなければ null */
  counts: () => LeadCounts | null;
  history?: HistoryStore;
  /**
   * Discord に投げる文の中での話題の書き方（place-refs.ts。ローカルの話題は `「題名」（Web）`）。無ければ `<#ID>`。
   * 履歴の行はいつも `<#ID>`（Web の右腕の未読の印と札が頭の形を見る）
   */
  refOf?: (channelId: string) => string;
  /** 既定は REAL_TIMERS */
  timers?: ProgressTimers;
  log: (message: string) => void;
};

export type Lead = {
  onTurnEnd(event: TurnEndEvent): void;
  /** タイマーを取り消し、溜まった分を捨てる。以後の事象は捨てる */
  stop(): void;
  /** 実行中の投稿を待つ */
  idle(): Promise<void>;
};

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function createLead(deps: LeadDeps): Lead {
  const timers = deps.timers ?? REAL_TIMERS;
  const { log } = deps;
  /** サーバーごとの窓の中の事象（チャンネルごとに後の 1 つ） */
  const pending = new Map<string, Map<string, TurnEndEvent>>();
  const cancels = new Map<string, () => void>();
  const flushing = new Set<Promise<void>>();
  let stopped = false;

  async function flush(guildId: string): Promise<void> {
    cancels.delete(guildId);
    const bucket = pending.get(guildId);
    pending.delete(guildId);
    if (bucket === undefined || bucket.size === 0) return;
    const events = [...bucket.values()];
    const inbox = deps.inboxOf(guildId);
    if (inbox === null) {
      log(`まとめの宛先がありません（${events.length} 件）`);
      return;
    }
    let counts: LeadCounts | null;
    try {
      counts = deps.counts();
    } catch {
      log("まとめの残りの数を取れませんでした");
      counts = null;
    }
    // 履歴の文はいつも `<#ID>`。Discord に投げる文だけ refOf で書く（書けなければ `<#ID>` のまま投げる）
    const text = leadText(events, counts);
    let posted = text;
    if (deps.refOf !== undefined) {
      try {
        posted = leadText(events, counts, deps.refOf);
      } catch {
        log("まとめの場所の書き方を引けませんでした");
      }
    }
    const ownerUserId = deps.ownerUserId;
    // 鳴らし方は出す時点の設定を 1 回だけ読む
    const ringSetting = deps.settings().ring;
    const ring = ownerUserId !== undefined && events.some((event) => ringsFor(event, ringSetting));
    // 1 通の上限（mention の字も同じ 1 通に乗る）を超えるときだけ、行の上限を 1 ずつ減らして作り直す（2 まで。ローカルの話題の長い題名）。
    // それでも超える・作り直せなければ、履歴の文（`<#ID>`）を投げる
    const limit = MESSAGE_MAX_LENGTH - (ring && ownerUserId !== undefined ? mentionPrefix(ownerUserId).length : 0);
    for (let maxLines = LEAD_MAX_LINES - 1; posted.length > limit && maxLines >= 2; maxLines--) {
      try {
        posted = leadText(events, counts, deps.refOf, maxLines);
      } catch {
        log("まとめの場所の書き方を引けませんでした");
        posted = text;
        break;
      }
    }
    if (posted.length > limit) posted = text;
    try {
      await deps.post(inbox, { text: posted, ...(ring ? { mentionUserId: ownerUserId } : {}) });
    } catch (error) {
      log(`まとめの投稿に失敗しました: ${describeError(error)}`);
      return;
    }
    recordHistory(
      deps.history,
      { guildId, channelId: inbox, kind: "notice", source: "system", persona: DEFAULT_PERSONA_ID, text },
      log,
    );
  }

  function startFlush(guildId: string): void {
    const running = flush(guildId).catch((error: unknown) => {
      log(`まとめに失敗しました: ${describeError(error)}`);
    });
    flushing.add(running);
    void running.finally(() => flushing.delete(running));
  }

  return {
    onTurnEnd(event) {
      if (stopped) return;
      if (!inScope(event, deps.settings().scope)) return;
      let bucket = pending.get(event.guildId);
      if (bucket === undefined) {
        bucket = new Map();
        pending.set(event.guildId, bucket);
      }
      // 同じ話題は後の 1 つだけ残し、順は後ろへ
      bucket.delete(event.channelId);
      bucket.set(event.channelId, event);
      if (!cancels.has(event.guildId)) {
        cancels.set(
          event.guildId,
          timers.after(() => startFlush(event.guildId), LEAD_WINDOW_MS),
        );
      }
    },
    stop() {
      stopped = true;
      for (const cancel of cancels.values()) cancel();
      cancels.clear();
      let dropped = 0;
      for (const bucket of pending.values()) dropped += bucket.size;
      pending.clear();
      if (dropped > 0) log(`停止のため、まとめ ${dropped} 件を出しませんでした`);
    },
    async idle() {
      await Promise.all([...flushing]);
    },
  };
}
