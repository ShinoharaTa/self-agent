// 右腕の場所を変える確認（docs/plan/web-ui-v3.md §4・§6.3。#369 の M6d）。場所が変わる話題のチャンネルに [変える][このまま] の 1 通を出し、
// topic_moves に proposed の行（1 つの話題に 1 つ）を残す。場所を変えるのはオーナーが [変える] を押したとき（accept → moveTopic の proposalId）だけ。
// 確認は MOVE_PROPOSAL_TTL_MS で失効し、TopicProposalExpirer が MOVE_PROPOSAL_SWEEP_MS ごとに札を「期限が切れました」に書き換える。
// proposed の行は再起動で消さない（期限の中なら再起動の後も押せる）。札がまだ出ていない（message_id の無い）行は答えられず、一覧にも出さない。log に話題の ID・チャンネル ID・場所の名前・題名を出さない
import type { CcTimers } from "../cc/registry.ts";
import { escapeDiscordText } from "../discord/escape.ts";
import type { OutgoingMessage } from "../discord/gateway.ts";
import { recordHistory } from "../store/history.ts";
import type { TopicMove, TopicMoveStore } from "../store/topic-moves.ts";
import type { OwnerPosts } from "./personas.ts";
import {
  checkMovable,
  MOVE_FAILED_TEXT,
  type MoveDeps,
  type MovePlace,
  type MoveRefusal,
  moveRefusalText,
  movedPostText,
  moveTopic,
  placeLabel,
} from "./topic-move.ts";

/** ボタンの custom_id の名前空間（`move:ok:<id>`・`move:keep:<id>`） */
export const MOVE_NAMESPACE = "move";
/** 確認の有効な長さ（CC7 の確認と同じ） */
export const MOVE_PROPOSAL_TTL_MS = 10 * 60_000;
/** 失効を確かめる間隔 */
export const MOVE_PROPOSAL_SWEEP_MS = 60_000;

/** 確認の 1 通（from・to は placeLabel の文を escape した物） */
export function proposalText(from: string, to: string): string {
  return (
    `場所を **${from}** から **${to}** に変えますか。\n` +
    "会話は新しくなり、担当には要点を引き継ぎます。記録はこのまま残ります。ファイルは動かしません。\n" +
    "（10 分で失効します）"
  );
}
export function PROPOSAL_ACCEPTED(to: string): string {
  return `場所を **${to}** に変えています`;
}
export function PROPOSAL_KEPT(from: string): string {
  return `場所はこのままにしました（${from}）`;
}
export const PROPOSAL_EXPIRED = "確認の期限が切れました。場所は変わっていません";
export function PROPOSAL_REFUSED(text: string): string {
  return `場所を変えられませんでした: ${text}`;
}
/** 履歴の知らせ（場所の名前は escape しない） */
export function proposedNoticeText(from: string, to: string): string {
  return `場所を ${from} から ${to} に変える確認を出しました`;
}
export const PROPOSAL_KEPT_NOTICE = "場所はこのままにしました";
export const PROPOSAL_EXPIRED_NOTICE = "場所を変える確認の期限が切れました";

/** 押したときの断りのうち、待てば通る物（札を残す） */
const RETRYABLE: ReadonlySet<MoveRefusal> = new Set<MoveRefusal>(["busy", "moving", "closing", "cc_disabled", "unify_not_ready"]);

export type TopicProposalDeps = {
  /** moveTopic・checkMovable に渡す物（M5b の main の moveDeps） */
  move: MoveDeps;
  moves: Pick<TopicMoveStore, "propose" | "setMessageId" | "cancel" | "get" | "proposedFor" | "listProposed" | "listProposedBefore">;
  ownerPosts: Pick<OwnerPosts, "send" | "sendMessage" | "editMessage">;
  /** 期限の判定に使う。moves（TopicMoveStore）に渡した時計と同じ物 */
  now: () => Date;
  log: (message: string) => void;
};

export type ProposeResult =
  /** from・to は placeLabel の文 */
  | { result: "proposed"; id: number; channelId: string; from: string; to: string }
  | { result: "already_proposed"; channelId: string }
  | { result: "refused"; reason: MoveRefusal };
export type AcceptResult = { result: "accepted" } | { result: "stale" } | { result: "refused"; reason: MoveRefusal; kept: boolean };
export type KeepResult = { result: "kept" } | { result: "stale" };
export type PendingProposal = { id: number; channelId: string; from: string; to: string; createdAt: string; expiresAt: string };

export type TopicProposals = {
  propose(input: { guildId: string; channelId: string; place: MovePlace }): Promise<ProposeResult>;
  /** 札がまだ出ていない行は、取り消さずに stale */
  accept(id: number): Promise<AcceptResult>;
  /** 札がまだ出ていない行は、取り消さずに stale */
  keep(id: number): Promise<KeepResult>;
  /** 期限の切れた確認を片付ける */
  sweep(): Promise<void>;
  /** その話題の、期限の中の確認（札がまだ出ていない・話題が無い・閉じた話題の物は出さない） */
  pending(channelId: string): PendingProposal | undefined;
  /** 期限の中の確認すべて（pending と同じく、札がまだ出ていない・話題が無い・閉じた話題の物は出さない） */
  pendingAll(): PendingProposal[];
  /** id の確認がどの話題の物か（期限・状態は見ない。口がサーバーを確かめるのに使う） */
  channelOf(id: number): string | undefined;
};

/** [変える][このまま] */
export function moveProposalButtons(id: number): OutgoingMessage["components"] {
  return [
    {
      kind: "buttons",
      buttons: [
        { customId: `${MOVE_NAMESPACE}:ok:${id}`, label: "変える", style: "primary" },
        { customId: `${MOVE_NAMESPACE}:keep:${id}`, label: "このまま", style: "secondary" },
      ],
    },
  ];
}

function errorName(error: unknown): string {
  return error instanceof Error ? error.name : typeof error;
}

export function createTopicProposals(deps: TopicProposalDeps): TopicProposals {
  const { move, moves, ownerPosts, now, log } = deps;
  const generalDir = (): string | undefined => move.projectSessions?.places.generalDir;
  const expiresAt = (row: TopicMove): number => new Date(row.createdAt).getTime() + MOVE_PROPOSAL_TTL_MS;
  const live = (row: TopicMove): boolean => expiresAt(row) > now().getTime();
  const label = (dir: string | null): string => placeLabel(dir, generalDir());
  /** 一覧に出す行か（期限の中・札が出ている・話題があり閉じていない。閉じたの判定は topic-move.ts の checkTopic の closed と同じ） */
  const listable = (row: TopicMove): boolean => {
    if (!live(row) || row.messageId === null) return false;
    const topic = move.topicSessions.get(row.channelId);
    return topic !== undefined && topic.state !== "deleted" && topic.state !== "done";
  };

  /** 札を書き換える（ボタンは外す）。message_id が無い・失敗は log だけ */
  const editCard = async (row: TopicMove, text: string): Promise<void> => {
    if (row.messageId === null) return;
    try {
      await ownerPosts.editMessage(row.channelId, row.messageId, { text, components: [] });
    } catch (error) {
      log(`場所を変える確認の書き換えに失敗しました（${errorName(error)}）`);
    }
  };
  const notice = (channelId: string, text: string): void => {
    const topic = move.topicSessions.get(channelId);
    if (topic === undefined) return;
    recordHistory(move.history, { guildId: topic.guildId, channelId, kind: "notice", source: "system", text }, log);
  };

  /** 期限切れの片付け: 行を cancelled にし、札を書き換え、履歴に知らせ。cancel が false（もう running・cancelled）の行は何もしない */
  const expireRows = async (rows: TopicMove[]): Promise<void> => {
    let count = 0;
    for (const row of rows) {
      if (!moves.cancel(row.id)) continue;
      count += 1;
      await editCard(row, PROPOSAL_EXPIRED);
      notice(row.channelId, PROPOSAL_EXPIRED_NOTICE);
    }
    if (count > 0) log(`期限の切れた場所を変える確認を ${count} 件片付けました`);
  };
  /** created_at + TTL <= now（live の逆）の proposed の行すべてを片付ける */
  const expireDue = async (): Promise<void> => {
    // listProposedBefore は created_at < cutoff。1 ms 足して「created_at + TTL <= now」にそろえる
    await expireRows(moves.listProposedBefore(new Date(now().getTime() - MOVE_PROPOSAL_TTL_MS + 1)));
  };

  const toPending = (row: TopicMove): PendingProposal => ({
    id: row.id,
    channelId: row.channelId,
    from: label(row.fromDir),
    to: label(row.toDir),
    createdAt: row.createdAt,
    expiresAt: new Date(expiresAt(row)).toISOString(),
  });

  return {
    async propose(input) {
      const checked = checkMovable(input, move);
      if (!checked.ok) return { result: "refused", reason: checked.result };
      const { channelId } = input;
      const existing = moves.proposedFor(channelId);
      if (existing !== undefined) {
        if (live(existing)) return { result: "already_proposed", channelId };
        await expireRows([existing]);
      }
      const id = moves.propose({ channelId, fromDir: checked.fromDir, toDir: checked.toDir, by: "right_hand" });
      if (id === undefined) return { result: "already_proposed", channelId };
      const from = label(checked.fromDir);
      const to = label(checked.toDir);
      let messageId: string;
      try {
        messageId = await ownerPosts.sendMessage(channelId, {
          text: proposalText(escapeDiscordText(from), escapeDiscordText(to)),
          components: moveProposalButtons(id),
        });
      } catch (error) {
        moves.cancel(id);
        throw error;
      }
      moves.setMessageId(id, messageId);
      recordHistory(move.history, { guildId: input.guildId, channelId, kind: "notice", source: "system", text: proposedNoticeText(from, to) }, log);
      log("場所を変える確認を出しました");
      return { result: "proposed", id, channelId, from, to };
    },

    async accept(id) {
      const row = moves.get(id);
      if (row === undefined || row.state !== "proposed") return { result: "stale" };
      if (!live(row)) {
        await expireRows([row]);
        return { result: "stale" };
      }
      // 札がまだ出ていない（propose が sendMessage を待っている）。取り消さない
      if (row.messageId === null) return { result: "stale" };
      // ここから moveTopic を呼ぶまで await を入れない（間に取り消された行で moveTopic が moving を返し、札を残す方に入らないため）
      const { channelId } = row;
      const topic = move.topicSessions.get(channelId);
      if (topic === undefined) {
        moves.cancel(id);
        return { result: "stale" };
      }
      const { guildId } = topic;
      const place: MovePlace = row.toDir === generalDir() ? { kind: "general" } : { kind: "project", name: row.toDir };
      // 受け付けるか（検査と proposed → running）は moveTopic が最初の await の前に決める（Web の /place と同じ旗の形）
      let accepted = false;
      const running = moveTopic({ guildId, channelId, place, by: "right_hand", proposalId: id }, move, () => {
        accepted = true;
      });
      if (!accepted) {
        const outcome = await running;
        if (outcome.result === "moved" || outcome.result === "failed") throw new Error("場所の付け替えが受け付けずに終わりました");
        if (RETRYABLE.has(outcome.result)) {
          // 待つ間に別の口（keep・期限）が片付けた
          if (moves.get(id)?.state !== "proposed") return { result: "stale" };
          return { result: "refused", reason: outcome.result, kept: true };
        }
        if (moves.cancel(id)) {
          const text = moveRefusalText(outcome.result);
          await editCard(row, PROPOSAL_REFUSED(text));
          notice(channelId, PROPOSAL_REFUSED(text));
        }
        return { result: "refused", reason: outcome.result, kept: false };
      }
      const edited = editCard(row, PROPOSAL_ACCEPTED(escapeDiscordText(label(row.toDir))));
      // 結果の投稿は web/routes/topics.ts の /place と同じ（札の書き換えの後に投稿する）
      void running
        .then(async (outcome) => {
          await edited;
          const text =
            outcome.result === "moved"
              ? movedPostText(outcome, generalDir())
              : outcome.result === "failed"
                ? MOVE_FAILED_TEXT
                : `場所を変えられませんでした: ${moveRefusalText(outcome.result)}`;
          try {
            await ownerPosts.send(channelId, text);
          } catch (error) {
            log(`場所の付け替えの結果を Discord に投稿できませんでした（${errorName(error)}）`);
          }
        })
        .catch(async (error: unknown) => {
          // 受け付けた後の例外。失敗の文をチャンネルと履歴に残す。どちらの失敗も log だけ
          log(`確認からの場所の付け替えに失敗しました（${errorName(error)}）`);
          recordHistory(move.history, { guildId, channelId, kind: "notice", source: "system", text: MOVE_FAILED_TEXT }, log);
          try {
            await ownerPosts.send(channelId, MOVE_FAILED_TEXT);
          } catch (postError) {
            log(`場所の付け替えの結果を Discord に投稿できませんでした（${errorName(postError)}）`);
          }
        });
      await edited;
      return { result: "accepted" };
    },

    async keep(id) {
      const row = moves.get(id);
      if (row === undefined || row.state !== "proposed") return { result: "stale" };
      if (!live(row)) {
        await expireRows([row]);
        return { result: "stale" };
      }
      // 札がまだ出ていない（propose が sendMessage を待っている）。取り消さない
      if (row.messageId === null) return { result: "stale" };
      if (!moves.cancel(id)) return { result: "stale" };
      await editCard(row, PROPOSAL_KEPT(escapeDiscordText(label(row.fromDir))));
      notice(row.channelId, PROPOSAL_KEPT_NOTICE);
      return { result: "kept" };
    },

    sweep: expireDue,

    pending(channelId) {
      const row = moves.proposedFor(channelId);
      return row !== undefined && listable(row) ? toPending(row) : undefined;
    },

    pendingAll() {
      return moves.listProposed().filter(listable).map(toPending);
    },

    channelOf(id) {
      return moves.get(id)?.channelId;
    },
  };
}

export type TopicProposalExpirerDeps = {
  proposals: Pick<TopicProposals, "sweep">;
  log: (message: string) => void;
  timers?: CcTimers;
};

const REAL_TIMERS: CcTimers = {
  after: (fn, ms) => {
    const timer = setTimeout(fn, ms);
    timer.unref();
    return () => clearTimeout(timer);
  },
};

/** 確認の失効。start の直後に 1 回、以後は MOVE_PROPOSAL_SWEEP_MS ごとに sweep する（commands/cc-confirm.ts の CcConfirmExpirer と同じ形） */
export class TopicProposalExpirer {
  private readonly deps: TopicProposalExpirerDeps;
  private readonly timers: CcTimers;
  private cancelTimer: (() => void) | undefined;
  private started = false;
  private stopped = false;
  private running: Promise<void> | undefined;

  constructor(deps: TopicProposalExpirerDeps) {
    this.deps = deps;
    this.timers = deps.timers ?? REAL_TIMERS;
  }

  /** 直後に 1 回確かめ、以後は MOVE_PROPOSAL_SWEEP_MS ごと。stop の後・2 回目は何もしない */
  start(): void {
    if (this.started || this.stopped) return;
    this.started = true;
    this.loop();
  }

  stop(): void {
    this.stopped = true;
    this.cancelTimer?.();
    this.cancelTimer = undefined;
  }

  async idle(): Promise<void> {
    await this.running;
  }

  private loop(): void {
    if (this.stopped) return;
    void this.sweep().then(() => {
      if (this.stopped) return;
      this.cancelTimer = this.timers.after(() => {
        this.cancelTimer = undefined;
        this.loop();
      }, MOVE_PROPOSAL_SWEEP_MS);
    });
  }

  /** 1 回確かめる（テストから直接呼ぶ）。前の回が終わっていなければその回を待つ。reject しない */
  sweep(): Promise<void> {
    if (this.running !== undefined) return this.running;
    const running = this.pass().finally(() => {
      this.running = undefined;
    });
    this.running = running;
    return running;
  }

  private async pass(): Promise<void> {
    try {
      await this.deps.proposals.sweep();
    } catch (error) {
      this.deps.log(`場所を変える確認の失効を確かめられませんでした（${errorName(error)}）`);
    }
  }
}
