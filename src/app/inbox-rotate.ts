// #inbox と #tasks の会話の切り替え（Scheduler の tick から呼ぶ）。/setup 済みのサーバーの #inbox と #tasks のそれぞれについて同じ規則で、
// 毎日 SELF_AGENT_INBOX_ROTATE_AT（SELF_AGENT_TZ）を過ぎたとき（日次）と、
// 直近の成功したターンの最後のステップの入力が SELF_AGENT_INBOX_MAX_INPUT_TOKENS を超えたとき（サイズ）に、そのチャンネルの会話を要約して残し、
// SDK セッションを捨てて次の発言から新しいセッションにする。要約は seed として次の最初のターンに付ける。
// 要約はツールを足さず、要約を頼むターンの返答本文を使う（ツール集合を変えるとキャッシュが全セッションで外れるため）。
// /renew（rotateNow）は時期の判定を飛ばして同じ切り替えをすぐに行う。
// 足した人格の #<NAME>（#inbox と同じ扱い）も、その人格の要約・切り替えの日と時刻で同じように切り替える（#tasks の後に人格の設定の順）
import { type Config, DEFAULT_PERSONA_ID } from "../config.ts";
import type { Gateway } from "../discord/gateway.ts";
import type { GuildSettings, GuildSettingsStore } from "../store/guild-settings.ts";
import { type HistoryStore, recordHistory } from "../store/history.ts";
import type { InboxSummaryStore, SummaryChannelKind } from "../store/inbox-summaries.ts";
import { CLOSE_SUMMARY_MAX_LENGTH } from "../store/topic-sessions.ts";
import type { KeyedSerialQueue } from "./queue.ts";
import { fallbackSummary, rotatedSeed } from "./summary.ts";
import { formatDate } from "./time.ts";
import { recordTurnUsage, RESUME_FAILURE_PATTERN, type TurnDeps, turnPersonaOf } from "./turn.ts";

/** #inbox の要約を頼むターンの prompt。静的に保つ（日時ヘッダも付けない。字数は要約を切り詰める上限と揃える）。セッションに移った話題は案内と題名だけにする（中身はセッション側で進むため） */
export const ROTATE_PROMPT =
  `会話を新しくするので、ここまでの #inbox のやり取りのうち、今後も必要なこと（未完了の話題・決めたこと・約束）だけを ${CLOSE_SUMMARY_MAX_LENGTH} 字以内の箇条書きで返答してください。セッションのチャンネルに移った話題は、その後セッションで進むので、チャンネルの案内（<#チャンネルID>）と題名だけを書き、中身の進み具合は書かないでください。ツールは使わないでください。`;

/** #tasks の要約を頼むターンの prompt。タスクの一覧は DB にあるので書き写させない（静的に保つのは #inbox と同じ） */
export const TASKS_ROTATE_PROMPT =
  `会話を新しくするので、ここまでの #tasks のやり取りのうち、今後も必要なこと（相談の途中のこと・決めた方針・約束）だけを ${CLOSE_SUMMARY_MAX_LENGTH} 字以内の箇条書きで返答してください。タスクの一覧は DB にあるので書き写さないでください。ツールは使わないでください。`;

/** 切り替えた後にそのチャンネル（#inbox・#tasks）に投稿する 1 行 */
export const ROTATED_NOTICE = "（会話を新しくしました。これまでの要約を引き継いでいます）";
/** 引き継ぐ要約が無いとき（会話の記録が切れていて、前回の要約も無い） */
export const ROTATED_NOTICE_FRESH = "（会話を新しくしました）";

/** 切り替えに失敗したチャンネルは、失敗からこの時間が経つまでやり直さない */
export const ROTATE_RETRY_MS = 60 * 60 * 1000;

/** 要約を頼むターンの prompt（チャンネルの種類ごと） */
const ROTATE_PROMPTS: Record<SummaryChannelKind, string> = { inbox: ROTATE_PROMPT, tasks: TASKS_ROTATE_PROMPT };

/** 1 つのサーバーの中で、既定の人格のチャンネルを切り替える順（足した人格の #<NAME> はこの後） */
const ROTATED_KINDS: readonly SummaryChannelKind[] = ["inbox", "tasks"];

/** 切り替えるチャンネルの種類と、その持ち主の人格 */
type RotateSlot = { kind: SummaryChannelKind; persona: string };

/** 切り替える理由。日次（rotateAt を過ぎた）か、直近の成功したターンの最後のステップの入力の大きさか、/renew */
type RotateReason = { kind: "daily" } | { kind: "size"; contextTokens: number } | { kind: "manual" };

/**
 * 切り替えの結果。rotated は要約を引き継いだ（記録切れで前回の要約を引き継いだときも）、rotated_fresh は記録切れで引き継ぐ要約が無かった、
 * no_conversation は前回の切り替えから会話が無く日付と時刻だけ記録した、not_set_up はそのチャンネルが無い、failed は何も変えなかった
 */
export type RotateNowResult = "rotated" | "rotated_fresh" | "no_conversation" | "not_set_up" | "failed";

/** 切り替えるチャンネル（/setup 済みのサーバーの #inbox か #tasks、足した人格の #<NAME>）と、前回の切り替え */
type RotateTarget = {
  guildId: string;
  kind: SummaryChannelKind;
  /** チャンネルの持ち主の人格（#<NAME> はその人格、#inbox・#tasks は既定の人格） */
  persona: string;
  channelId: string;
  /** 前回の切り替えの日（timeZone の日付、YYYY-MM-DD）。まだ切り替えていなければ null */
  rotatedDate: string | null;
  /** 前回の切り替えの時刻（ISO）。まだ記録が無ければ null */
  rotatedAt: string | null;
};

export type InboxRotatorDeps = {
  /** personas は足した人格（その #<NAME> も切り替える）。無ければ #inbox・#tasks だけ */
  cfg: Pick<Config, "allowedGuildIds" | "timeZone" | "inboxRotateAt" | "inboxMaxInputTokens"> & Partial<Pick<Config, "personas">>;
  /** #inbox・#tasks・#<NAME> のチャンネルと、最後に切り替えた日・時刻（時刻を「前回の切り替え」とする） */
  guildSettings: Pick<GuildSettingsStore, "get" | "personaInbox" | "setInboxRotated" | "setTasksRotated">;
  /** 切り替えたときの要約（チャンネルの種類ごと） */
  inboxSummaries: Pick<InboxSummaryStore, "add" | "latest">;
  /** 発言のターンと同じキュー（key は channelId）。要約のターンが発言のターンと重ならないようにする */
  turnQueue: Pick<KeyedSerialQueue, "run">;
  /** 要約のターンの runner（チャンネルの持ち主の人格のもの）と、SDK セッション・seed・usage */
  turn: Pick<TurnDeps, "runner" | "personas" | "sessions" | "seeds" | "usage" | "log">;
  /** 切り替えた知らせを投稿する（チャンネルの持ち主の Bot） */
  gateway: Pick<Gateway, "sendMessage">;
  /** Web UI のためのターンの記録（Web UI が有効なときだけ渡す）。切り替えたら区切りの行を書く（/renew も）。無ければ書かない */
  history?: Pick<HistoryStore, "add">;
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

/** 失敗の時刻を覚える key（サーバーと人格とチャンネルの種類ごと。既定の人格は今までどおり種類とサーバーだけ） */
function failureKey(guildId: string, kind: SummaryChannelKind, persona: string): string {
  return persona === DEFAULT_PERSONA_ID ? `${kind}:${guildId}` : `${kind}:${persona}:${guildId}`;
}

/** log に出すチャンネルの名前（#inbox・#tasks。足した人格の #<NAME> は `#inbox（人格 <id>）`） */
function channelLabel(kind: SummaryChannelKind, persona: string): string {
  return persona === DEFAULT_PERSONA_ID ? `#${kind}` : `#${kind}（人格 ${persona}）`;
}

export class InboxRotator {
  private readonly deps: InboxRotatorDeps;
  /** 切り替えに失敗した時刻（サーバーと人格とチャンネルの種類ごと。プロセス内でだけ覚える） */
  private readonly failedAt = new Map<string, number>();

  constructor(deps: InboxRotatorDeps) {
    this.deps = deps;
  }

  /** 切り替えるチャンネルの順（既定の人格の #inbox → #tasks → 足した人格の #<NAME> を設定の順に） */
  private slots(): RotateSlot[] {
    return [
      ...ROTATED_KINDS.map((kind) => ({ kind, persona: DEFAULT_PERSONA_ID })),
      ...(this.deps.cfg.personas ?? []).map((persona): RotateSlot => ({ kind: "inbox", persona: persona.id })),
    ];
  }

  /**
   * 許可サーバーのうち /setup 済み（DB に #inbox・#tasks がある）のサーバーについて、切り替えの時期ならそのチャンネルを切り替える
   * （1 サーバーずつ、#inbox → #tasks → #<NAME> の順に 1 チャンネルずつ）。env の #inbox で受け付けているサーバーは対象外。
   * 失敗から ROTATE_RETRY_MS 経っていないチャンネルは飛ばす。stopping が true を返したら、まだ始めていない切り替えは行わない。
   * reject しない（失敗は log に出す）
   */
  async rotateDue(stopping: () => boolean): Promise<void> {
    const { cfg, guildSettings, turnQueue, now, log } = this.deps;
    for (const guildId of cfg.allowedGuildIds) {
      for (const { kind, persona } of this.slots()) {
        if (stopping()) return;
        const key = failureKey(guildId, kind, persona);
        try {
          const settings = guildSettings.get(guildId);
          const target = settings === undefined ? undefined : this.targetOf(settings, kind, persona);
          if (target === undefined) continue;
          // まだ一度も切り替えていない（/setup 直後・更新直後）なら、今を基準として記録するだけにする。
          // 記録が無いまま判定すると、最初の会話の直後に日次の切り替えが走ってしまう
          if (target.rotatedAt === null) {
            const at = now();
            this.markRotated(target, formatDate(at, cfg.timeZone), at);
            continue;
          }
          const failedAt = this.failedAt.get(key);
          if (failedAt !== undefined && now().getTime() - failedAt < ROTATE_RETRY_MS) continue;
          const reason = this.dueReason(target);
          if (reason === undefined) continue;
          await turnQueue.run(target.channelId, () => this.rotate(target, reason, stopping));
        } catch (error) {
          this.failedAt.set(key, now().getTime());
          log(`${channelLabel(kind, persona)} の切り替えに失敗しました（guild=${guildId}）: ${describeError(error)}`);
        }
      }
    }
  }

  /**
   * /renew: そのサーバーの #inbox か #tasks（persona が足した人格ならその #<NAME>）を今すぐ切り替える。日次・サイズの判定と、失敗の後の待ち（ROTATE_RETRY_MS）は飛ばし、
   * 発言と同じキューの中で rotateDue と同じ切り替えを行う。チャンネルへの知らせは投稿しない（呼び出し側がコマンドの返信で伝える）。
   * reject しない（例外は失敗の時刻を覚えて log に出し、failed を返す）
   */
  async rotateNow(guildId: string, kind: SummaryChannelKind, persona: string = DEFAULT_PERSONA_ID): Promise<RotateNowResult> {
    const { guildSettings, turnQueue, now, log } = this.deps;
    try {
      const settings = guildSettings.get(guildId);
      const target = settings === undefined ? undefined : this.targetOf(settings, kind, persona);
      if (target === undefined) return "not_set_up";
      // 停止の判定は渡さないので、rotate が何もせずに終わる（undefined）ことは無い
      const result = await turnQueue.run(target.channelId, () => this.rotate(target, { kind: "manual" }, () => false));
      return result ?? "failed";
    } catch (error) {
      this.failedAt.set(failureKey(guildId, kind, persona), now().getTime());
      log(`${channelLabel(kind, persona)} の切り替えに失敗しました（guild=${guildId}）: ${describeError(error)}`);
      return "failed";
    }
  }

  /** そのサーバーの #inbox・#tasks・#<NAME> と前回の切り替え。チャンネルがまだ無ければ undefined */
  private targetOf(settings: GuildSettings, kind: SummaryChannelKind, persona: string): RotateTarget | undefined {
    const { guildId } = settings;
    if (persona !== DEFAULT_PERSONA_ID) {
      // 足した人格の入口は #<NAME>（kind は inbox）だけ
      const inbox = kind === "inbox" ? this.deps.guildSettings.personaInbox(guildId, persona) : undefined;
      if (inbox === undefined || inbox.channelId === null) return undefined;
      return { guildId, kind, persona, channelId: inbox.channelId, rotatedDate: inbox.rotatedDate, rotatedAt: inbox.rotatedAt };
    }
    if (kind === "inbox") {
      if (settings.inboxChannelId === null) return undefined;
      return {
        guildId,
        kind,
        persona,
        channelId: settings.inboxChannelId,
        rotatedDate: settings.inboxRotatedDate,
        rotatedAt: settings.inboxRotatedAt,
      };
    }
    if (settings.tasksChannelId === null) return undefined;
    // #tasks は時刻だけを記録するので、切り替えた日はその時刻の timeZone の日付にする
    const rotatedAt = settings.tasksRotatedAt;
    return {
      guildId,
      kind,
      persona,
      channelId: settings.tasksChannelId,
      rotatedDate: rotatedAt === null ? null : formatDate(new Date(rotatedAt), this.deps.cfg.timeZone),
      rotatedAt,
    };
  }

  /** 切り替えた日（#inbox・#<NAME> だけ記録する）と時刻を記録する */
  private markRotated(target: Pick<RotateTarget, "guildId" | "kind" | "persona">, date: string, at: Date): void {
    const { guildSettings } = this.deps;
    if (target.kind === "inbox") guildSettings.setInboxRotated(target.guildId, date, at, target.persona);
    else guildSettings.setTasksRotated(target.guildId, at);
  }

  /** 前回の切り替えの時刻（persona_channels の rotated_at）。まだ記録が無ければ undefined（全履歴を見る） */
  private lastRotatedAt(target: Pick<RotateTarget, "guildId" | "kind" | "persona">): Date | undefined {
    const { guildSettings } = this.deps;
    let rotatedAt: string | null;
    if (target.persona !== DEFAULT_PERSONA_ID) {
      rotatedAt = guildSettings.personaInbox(target.guildId, target.persona)?.rotatedAt ?? null;
    } else {
      const settings = guildSettings.get(target.guildId);
      rotatedAt = (target.kind === "inbox" ? settings?.inboxRotatedAt : settings?.tasksRotatedAt) ?? null;
    }
    return rotatedAt === null ? undefined : new Date(rotatedAt);
  }

  /**
   * 切り替えの時期なら理由を返す。
   * - 日次: timeZone の時刻が rotateAt 以降で、今日（timeZone の日付）まだ切り替えていない
   * - サイズ: SDK セッションがあり、前回の切り替えの時刻より後の最新の成功したターンの最後のステップの入力（input + cache read + cache creation）が
   *   上限を超えた（要約のターン自身や、SDK セッションが無いときの記録で切り替え続けないように）
   */
  private dueReason(target: RotateTarget): RotateReason | undefined {
    const { cfg, turn, now } = this.deps;
    const at = now();
    const { hour, minute } = cfg.inboxRotateAt;
    if (target.rotatedDate !== formatDate(at, cfg.timeZone) && localMinutes(at, cfg.timeZone) >= hour * 60 + minute) {
      return { kind: "daily" };
    }
    if (turn.sessions.get(target.channelId) === undefined) return undefined;
    const entry = turn.usage.latestOkAfter(target.channelId, this.lastRotatedAt(target));
    if (entry === undefined || entry.contextTokens <= cfg.inboxMaxInputTokens) return undefined;
    return { kind: "size", contextTokens: entry.contextTokens };
  }

  /**
   * 発言のターンと同じキューの中で行う。SDK セッションが無いか、前回の切り替えより後にそのチャンネルのターンが無ければ、LLM を呼ばずに切り替えた日と時刻だけ記録する。
   * それ以外は要約を頼むターンを行う（resume 失敗からの復旧はしない。runChannelTurn は使わず、usage の記録と SDK が記録した session_id の保存だけ同じように行う）。
   * 要約のターンには context を渡さない（session_report・session_open は not_available になる）。WebFetch に許す URL も渡さない（取得はできない）。
   * 切り替えた時刻は要約のターンの usage を記録した後に取り直す（要約のターン自身の記録を「前回の切り替えより後」に数えないため）。
   * - 成功: 要約を保存 → SDK セッションを捨てる → seed を入れる → 切り替えた日を記録 → そのチャンネルに知らせる
   * - 会話の記録が無い（RESUME_FAILURE_PATTERN）: 要約は作らずに SDK セッションを捨て、切り替えた日を記録し、同じチャンネルの直近の要約があればそれを seed に入れて知らせる
   * - それ以外の失敗: 何も変えない（resume の連続失敗には数えない。失敗の時刻を覚え、ROTATE_RETRY_MS 経ってからやり直す）
   * /renew（reason が manual）のときは、SDK セッションがあれば前回の切り替えより後のターンが無くても要約を頼むターンを行い（オーナーが明示的に頼んだため）、
   * SDK セッションが無ければ何も変えない（切り替えた日を記録すると、その日の日次の切り替えを飛ばすため）。知らせは投稿しない。
   * 結果を返す（キュー待ちの間に停止を始めていて何もしなかったら undefined）
   */
  private async rotate(
    target: RotateTarget,
    reason: RotateReason,
    stopping: () => boolean,
  ): Promise<RotateNowResult | undefined> {
    const { cfg, inboxSummaries, turn, now, log } = this.deps;
    const { sessions, seeds, usage } = turn;
    const { guildId, kind, channelId } = target;
    // 要約のターンはチャンネルの持ち主の人格で動かし、要約もその人格のものとして残す
    const persona = turnPersonaOf(turn, channelId);
    const key = failureKey(guildId, kind, target.persona);
    const label = channelLabel(kind, target.persona);
    // キュー待ちの間に停止を始めていたら何もしない（次の起動の tick でやり直す）
    if (stopping()) return undefined;
    const today = formatDate(now(), cfg.timeZone);
    const sessionId = sessions.get(channelId);
    // /renew で SDK セッションが無ければ、切り替えた日も時刻も記録しない（その日の日次の切り替えを飛ばさない）
    if (reason.kind === "manual" && sessionId === undefined) return "no_conversation";
    // /renew は前回の切り替えより後のターンを数えない（SDK セッションがあれば要約する）
    const noTurns = reason.kind !== "manual" && usage.countAfter(channelId, this.lastRotatedAt(target)) === 0;
    if (sessionId === undefined || noTurns) {
      this.markRotated(target, today, now());
      this.failedAt.delete(key);
      log(`${label} に前回の切り替えからの会話が無いため、要約せずに切り替えた日だけ記録しました（guild=${guildId}）`);
      return "no_conversation";
    }

    // ツールの context は渡さない（#inbox の session_open で要約の途中にセッションを作らせない）。
    // オーナーの発言ではないので、WebFetch で取得できる URL も無い
    const result = await persona.runner.run({ prompt: ROTATE_PROMPTS[kind], sessionId, context: undefined, allowedUrls: [] });
    recordTurnUsage(turn, channelId, `${kind}-rotate`, result, persona);
    // usage の記録より後の時刻にする（次の判定で要約のターン自身の記録を数えない）
    const rotatedAt = now();

    if (result.ok) {
      // session_report が呼ばれても使わない（context が無いので not_available になる）。返答本文の先頭を要約にする
      const summary = fallbackSummary(result.text);
      inboxSummaries.add(guildId, today, summary, kind, persona.id);
      sessions.delete(channelId);
      seeds.set(channelId, rotatedSeed(summary, kind));
      this.markRotated(target, today, rotatedAt);
      this.failedAt.delete(key);
      const detail =
        reason.kind === "daily" ? "日次" : reason.kind === "manual" ? "/renew" : `直近の入力 ${reason.contextTokens} トークン`;
      log(`${label} の会話を要約して新しいセッションに切り替えました（guild=${guildId}、${detail}）`);
      this.recordDivider(target, ROTATED_NOTICE);
      if (reason.kind !== "manual") await this.notify(target, ROTATED_NOTICE);
      return "rotated";
    }

    if (RESUME_FAILURE_PATTERN.test(result.errorMessage)) {
      // 会話の記録が既に無いので要約は作れない。同じチャンネルの前回の要約があればそれを引き継ぐ
      const last = inboxSummaries.latest(guildId, kind, persona.id);
      sessions.delete(channelId);
      if (last !== undefined) seeds.set(channelId, rotatedSeed(last.summary, kind));
      this.markRotated(target, today, rotatedAt);
      this.failedAt.delete(key);
      // 実機の文言の確認のため、元のエラー文も出す
      const carried = last === undefined ? "前回の要約なし" : "前回の要約を引き継ぎ";
      log(
        `${label} の会話の記録が見つからないため、要約せずに新しいセッションに切り替えました（guild=${guildId}、${carried}）: ${result.errorMessage}`,
      );
      this.recordDivider(target, last === undefined ? ROTATED_NOTICE_FRESH : ROTATED_NOTICE);
      if (reason.kind !== "manual") await this.notify(target, last === undefined ? ROTATED_NOTICE_FRESH : ROTATED_NOTICE);
      return last === undefined ? "rotated_fresh" : "rotated";
    }

    // 途中まで記録された会話は次の発言で続ける（同じ SDK セッションなら置き換えない）
    if (result.sessionRecorded && result.sessionId !== undefined && result.sessionId !== sessions.get(channelId)) {
      sessions.set(channelId, result.sessionId);
    }
    this.failedAt.set(key, now().getTime());
    log(`${label} の要約に失敗したため、切り替えませんでした（guild=${guildId}）。1 時間後以降にやり直します: ${result.errorMessage}`);
    return "failed";
  }

  /** 切り替えた区切りの行を history に書く（無ければ何もしない。失敗は log だけ） */
  private recordDivider(target: RotateTarget, text: string): void {
    const { guildId, channelId, persona } = target;
    recordHistory(this.deps.history, { guildId, channelId, kind: "divider", source: "system", persona, text }, this.deps.log);
  }

  /** 切り替えた知らせをそのチャンネルに投稿する。失敗しても切り替えは済んでいるので log だけ出す */
  private async notify(target: RotateTarget, text: string): Promise<void> {
    try {
      await this.deps.gateway.sendMessage(target.channelId, { text });
    } catch (error) {
      this.deps.log(`${channelLabel(target.kind, target.persona)} への切り替えの知らせの投稿に失敗しました（guild=${target.guildId}）: ${describeError(error)}`);
    }
  }
}
