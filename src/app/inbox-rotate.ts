// #inbox の会話の切り替え（Scheduler の tick から呼ぶ）。毎日 SELF_AGENT_INBOX_ROTATE_AT（SELF_AGENT_TZ）を過ぎたとき（日次）と、
// 直近の成功したターンの最後のステップの入力が SELF_AGENT_INBOX_MAX_INPUT_TOKENS を超えたとき（サイズ）に、#inbox の会話を要約して残し、
// SDK セッションを捨てて次の発言から新しいセッションにする。要約は seed として次の最初のターンに付ける。
// 要約はツールを足さず、要約を頼むターンの返答本文を使う（ツール集合を変えるとキャッシュが全セッションで外れるため）
import type { Config } from "../config.ts";
import type { Gateway } from "../discord/gateway.ts";
import type { GuildSettingsStore } from "../store/guild-settings.ts";
import type { InboxSummaryStore } from "../store/inbox-summaries.ts";
import { fallbackSummary } from "./commands/close.ts";
import { formatDate } from "./commands/usage.ts";
import type { KeyedSerialQueue } from "./queue.ts";
import { recordTurnUsage, RESUME_FAILURE_PATTERN, type TurnDeps } from "./turn.ts";

/** 要約を頼むターンの prompt。静的に保つ（日時ヘッダも付けない） */
export const ROTATE_PROMPT =
  "会話を新しくするので、ここまでの #inbox のやり取りのうち、今後も必要なこと（未完了の話題・決めたこと・約束）だけを 600 字以内の箇条書きで返答してください。ツールは使わないでください。";

/** 切り替えた後に #inbox に投稿する 1 行 */
export const ROTATED_NOTICE = "（会話を新しくしました。これまでの要約を引き継いでいます）";
/** 引き継ぐ要約が無いとき（会話の記録が切れていて、前回の要約も無い） */
export const ROTATED_NOTICE_FRESH = "（会話を新しくしました）";

/** 切り替えに失敗したサーバーは、失敗からこの時間が経つまでやり直さない */
export const ROTATE_RETRY_MS = 60 * 60 * 1000;

/** 切り替えた後の最初のターンの prompt の先頭に付ける文（seed） */
export function rotatedSeed(summary: string): string {
  return `これまでの #inbox の要約:\n${summary}`;
}

/** 切り替える理由。日次（rotateAt を過ぎた）か、直近の成功したターンの最後のステップの入力の大きさ */
type RotateReason = { kind: "daily" } | { kind: "size"; contextTokens: number };

export type InboxRotatorDeps = {
  cfg: Pick<Config, "allowedGuildIds" | "timeZone" | "inboxRotateAt" | "inboxMaxInputTokens">;
  /** #inbox のチャンネルと、最後に切り替えた日 */
  guildSettings: Pick<GuildSettingsStore, "get" | "setInboxRotatedDate">;
  /** 切り替えたときの要約（最後の要約の時刻を「前回の切り替え」とする） */
  inboxSummaries: Pick<InboxSummaryStore, "add" | "latest">;
  /** 発言のターンと同じキュー（key は channelId）。要約のターンが発言のターンと重ならないようにする */
  turnQueue: Pick<KeyedSerialQueue, "run">;
  /** 要約のターンの runner と、SDK セッション・seed・usage */
  turn: Pick<TurnDeps, "runner" | "sessions" | "seeds" | "usage" | "log">;
  /** 切り替えた知らせを投稿する */
  gateway: Pick<Gateway, "sendMessage">;
  now: () => Date;
  log: (message: string) => void;
};

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** その時刻の、timeZone での時刻（0 時からの分） */
function localMinutes(at: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    hour: "numeric",
    minute: "numeric",
  }).formatToParts(at);
  const part = (type: Intl.DateTimeFormatPartTypes): number => Number(parts.find((p) => p.type === type)?.value);
  return part("hour") * 60 + part("minute");
}

export class InboxRotator {
  private readonly deps: InboxRotatorDeps;
  /** 切り替えに失敗した時刻（サーバーごと。プロセス内でだけ覚える） */
  private readonly failedAt = new Map<string, number>();

  constructor(deps: InboxRotatorDeps) {
    this.deps = deps;
  }

  /**
   * 許可サーバーのうち /setup 済み（DB に #inbox がある）のサーバーについて、切り替えの時期なら #inbox を切り替える（1 サーバーずつ）。
   * env の #inbox で受け付けているサーバーは対象外。失敗から ROTATE_RETRY_MS 経っていないサーバーは飛ばす。
   * stopping が true を返したら、まだ始めていない切り替えは行わない。reject しない（失敗は log に出す）
   */
  async rotateDue(stopping: () => boolean): Promise<void> {
    const { cfg, guildSettings, turnQueue, now, log } = this.deps;
    for (const guildId of cfg.allowedGuildIds) {
      if (stopping()) return;
      try {
        const settings = guildSettings.get(guildId);
        const inboxChannelId = settings?.inboxChannelId ?? null;
        if (settings === undefined || inboxChannelId === null) continue;
        const failedAt = this.failedAt.get(guildId);
        if (failedAt !== undefined && now().getTime() - failedAt < ROTATE_RETRY_MS) continue;
        const reason = this.dueReason(guildId, inboxChannelId, settings.inboxRotatedDate);
        if (reason === undefined) continue;
        await turnQueue.run(inboxChannelId, () => this.rotate(guildId, inboxChannelId, reason, stopping));
      } catch (error) {
        this.failedAt.set(guildId, now().getTime());
        log(`#inbox の切り替えに失敗しました（guild=${guildId}）: ${describeError(error)}`);
      }
    }
  }

  /** 前回の切り替え（最後に要約を残した時刻）。まだ要約が無ければ undefined */
  private lastRotatedAt(guildId: string): Date | undefined {
    const last = this.deps.inboxSummaries.latest(guildId);
    return last === undefined ? undefined : new Date(last.createdAt);
  }

  /**
   * 切り替えの時期なら理由を返す。
   * - 日次: timeZone の時刻が rotateAt 以降で、今日（timeZone の日付）まだ切り替えていない
   * - サイズ: SDK セッションがあり、前回の切り替えより後の最新の成功したターンの最後のステップの入力（input + cache read + cache creation）が
   *   上限を超えた（要約のターン自身や、SDK セッションが無いときの記録で切り替え続けないように）
   */
  private dueReason(guildId: string, inboxChannelId: string, rotatedDate: string | null): RotateReason | undefined {
    const { cfg, turn, now } = this.deps;
    const at = now();
    const { hour, minute } = cfg.inboxRotateAt;
    if (rotatedDate !== formatDate(at, cfg.timeZone) && localMinutes(at, cfg.timeZone) >= hour * 60 + minute) {
      return { kind: "daily" };
    }
    if (turn.sessions.get(inboxChannelId) === undefined) return undefined;
    const entry = turn.usage.latestOkAfter(inboxChannelId, this.lastRotatedAt(guildId));
    if (entry === undefined || entry.contextTokens <= cfg.inboxMaxInputTokens) return undefined;
    return { kind: "size", contextTokens: entry.contextTokens };
  }

  /**
   * 発言のターンと同じキューの中で行う。SDK セッションが無いか、前回の切り替えより後に #inbox のターンが無ければ、LLM を呼ばずに切り替えた日だけ記録する。
   * それ以外は要約を頼むターンを行う（resume 失敗からの復旧はしない。runChannelTurn は使わず、usage の記録と SDK が記録した session_id の保存だけ同じように行う）。
   * - 成功: 要約を保存 → SDK セッションを捨てる → seed を入れる → 切り替えた日を記録 → #inbox に知らせる
   * - 会話の記録が無い（RESUME_FAILURE_PATTERN）: 要約は作らずに SDK セッションを捨て、切り替えた日を記録し、直近の要約があればそれを seed に入れて知らせる
   * - それ以外の失敗: 何も変えない（resume の連続失敗には数えない。失敗の時刻を覚え、ROTATE_RETRY_MS 経ってからやり直す）
   */
  private async rotate(
    guildId: string,
    inboxChannelId: string,
    reason: RotateReason,
    stopping: () => boolean,
  ): Promise<void> {
    const { cfg, guildSettings, inboxSummaries, turn, now, log } = this.deps;
    const { runner, sessions, seeds, usage } = turn;
    // キュー待ちの間に停止を始めていたら何もしない（次の起動の tick でやり直す）
    if (stopping()) return;
    const today = formatDate(now(), cfg.timeZone);
    const sessionId = sessions.get(inboxChannelId);
    if (sessionId === undefined || usage.countAfter(inboxChannelId, this.lastRotatedAt(guildId)) === 0) {
      guildSettings.setInboxRotatedDate(guildId, today);
      this.failedAt.delete(guildId);
      log(`#inbox に前回の切り替えからの会話が無いため、要約せずに切り替えた日だけ記録しました（guild=${guildId}）`);
      return;
    }

    const result = await runner.run({
      prompt: ROTATE_PROMPT,
      sessionId,
      context: { guildId, channelId: inboxChannelId },
    });
    recordTurnUsage(turn, inboxChannelId, result);

    if (result.ok) {
      // session_report が呼ばれても使わない（#inbox では not_available になる）。返答本文の先頭を要約にする
      const summary = fallbackSummary(result.text);
      inboxSummaries.add(guildId, today, summary);
      sessions.delete(inboxChannelId);
      seeds.set(inboxChannelId, rotatedSeed(summary));
      guildSettings.setInboxRotatedDate(guildId, today);
      this.failedAt.delete(guildId);
      const detail = reason.kind === "daily" ? "日次" : `直近の入力 ${reason.contextTokens} トークン`;
      log(`#inbox の会話を要約して新しいセッションに切り替えました（guild=${guildId}、${detail}）`);
      await this.notify(guildId, inboxChannelId, ROTATED_NOTICE);
      return;
    }

    if (RESUME_FAILURE_PATTERN.test(result.errorMessage)) {
      // 会話の記録が既に無いので要約は作れない。前回の要約があればそれを引き継ぐ
      const last = inboxSummaries.latest(guildId);
      sessions.delete(inboxChannelId);
      if (last !== undefined) seeds.set(inboxChannelId, rotatedSeed(last.summary));
      guildSettings.setInboxRotatedDate(guildId, today);
      this.failedAt.delete(guildId);
      // 実機の文言の確認のため、元のエラー文も出す
      const carried = last === undefined ? "前回の要約なし" : "前回の要約を引き継ぎ";
      log(
        `#inbox の会話の記録が見つからないため、要約せずに新しいセッションに切り替えました（guild=${guildId}、${carried}）: ${result.errorMessage}`,
      );
      await this.notify(guildId, inboxChannelId, last === undefined ? ROTATED_NOTICE_FRESH : ROTATED_NOTICE);
      return;
    }

    // 途中まで記録された会話は次の発言で続ける（同じ SDK セッションなら置き換えない）
    if (result.sessionRecorded && result.sessionId !== undefined && result.sessionId !== sessions.get(inboxChannelId)) {
      sessions.set(inboxChannelId, result.sessionId);
    }
    this.failedAt.set(guildId, now().getTime());
    log(`#inbox の要約に失敗したため、切り替えませんでした（guild=${guildId}）。1 時間後以降にやり直します: ${result.errorMessage}`);
  }

  /** 切り替えた知らせを #inbox に投稿する。失敗しても切り替えは済んでいるので log だけ出す */
  private async notify(guildId: string, inboxChannelId: string, text: string): Promise<void> {
    try {
      await this.deps.gateway.sendMessage(inboxChannelId, { text });
    } catch (error) {
      this.deps.log(`#inbox への切り替えの知らせの投稿に失敗しました（guild=${guildId}）: ${describeError(error)}`);
    }
  }
}
