// Claude Code のセッションごとの Discord のチャンネル（docs/plan/claude-code-channels.md §3。CC10 の分）。
// - 作る（openChannel）: /setup・/new と同じ layoutQueueKey のキューで、1 セッション 1 チャンネル（既にあれば exists）・一覧にあって tmux の中
//   （findSendablePane が当たる）・カテゴリ「Claude Code」（guild_settings.cc_category_id）があって 50 未満のときだけ、`cc-<セッション名>` を作り、
//   cc_channels に行を書いて最初の 1 通を投稿する。手動の口（Web のタブの [Discord のチャンネルを作る]・/cc open）が呼ぶ。
//   ensureFor は「関わった」きっかけ（CC11）から呼ぶ口で、既にあれば何もせず、作れなくても投げず、log と #system に 1 行（同じ理由は 1 時間に 1 回）。
// - 終わった（ended。registry が一覧から消えたセッションを渡す）: open の行を ended にして 1 行を出し、完了カテゴリへ移す。
// - 戻った（revived。同じ session_id が一覧に戻った）: その session_id の ended の行を open に戻して 1 行を出し、カテゴリ「Claude Code」へ戻す。
// - 再同期（reconcile。scheduler.ts の tick）: Discord 上に無い行を削除済みに、open でカテゴリ「Claude Code」の外のもの・ended で完了の外のものを戻す。
// 発言はまだ届けず（CC11）、返事もまだチャンネルに出さない。投稿は既定の人格の Bot。名前・ディレクトリは hook から来たデータなので、
// Markdown とメンションを無効にする。log はサーバー ID と種類・件数だけ（チャンネル ID・名前・cwd・sessionId は出さない。作った後の DB の失敗だけ例外）
import { layoutQueueKey } from "../app/commands/setup.ts";
import type { ChannelOpsQueue } from "../app/channel-ops.ts";
import type { KeyedSerialQueue } from "../app/queue.ts";
import type { SystemNotifier } from "../app/system-notice.ts";
import type { Config } from "../config.ts";
import { normalizeChannelName, CHANNEL_NAME_MAX_LENGTH } from "../discord/channel-name.ts";
import { escapeDiscordText } from "../discord/escape.ts";
import type { Gateway } from "../discord/gateway.ts";
import type { CcChannelOrigin, CcChannelRow, CcChannelStore } from "../store/cc-channels.ts";
import { headChars, type CcSessionRow } from "../store/cc-sessions.ts";
import type { GuildSettingsStore } from "../store/guild-settings.ts";
import { cwdLabel } from "../web/routes/cc.ts";
import type { CcPaneResolver } from "./panes.ts";
import type { CcRegistry, CcSessionView, CcState } from "./registry.ts";

/** Discord で 1 つのカテゴリに入れられるチャンネル数（カテゴリ「Claude Code」は 1 つだけで、満杯なら作らずに断る） */
export const CC_CATEGORY_CHANNEL_LIMIT = 50;
/** 作れなかった同じ理由を #system に出す間隔（プロセスの中） */
export const CC_CHANNEL_FAILURE_NOTICE_MS = 60 * 60_000;
/** /cc open のセレクトに出す件数（Discord のセレクトの上限） */
export const CC_PICK_LIMIT = 25;
/** 名前・ディレクトリを出す長さ */
const LABEL_MAX_CHARS = 100;

/** 作れなかった理由。not_found = 一覧に無い、not_in_tmux = tmux の外、not_set_up = カテゴリが無い・消えた、full = 50、failed = Discord の失敗 */
export type CcChannelFailure = "not_found" | "not_in_tmux" | "not_set_up" | "full" | "failed";

export type CcOpenResult =
  | { ok: true; channelId: string; guildId: string }
  | { ok: false; reason: "exists"; channelId: string; guildId: string }
  | { ok: false; reason: CcChannelFailure };

/** きっかけの表示（最初の投稿） */
const ORIGIN_LABEL: Readonly<Record<CcChannelOrigin, string>> = {
  web: "Web の [Discord のチャンネルを作る]",
  command: "/cc open",
  web_send: "Web からの送信",
  web_start: "Web からの起動",
  permission: "許可の応答",
  tool_send: "cc_send の [送る]",
  tool_start: "cc_start の [起動する]",
  github: "#github の [対応]",
};

/** 作れなかった理由の #system の 1 行と log の語 */
const FAILURE_NOTICE: Readonly<Record<"not_set_up" | "full" | "failed", string>> = {
  not_set_up: "Claude Code のチャンネルを作れませんでした（カテゴリ「Claude Code」がありません。/setup を実行してください）",
  full: `Claude Code のチャンネルを作れませんでした（カテゴリ「Claude Code」が満杯（${CC_CATEGORY_CHANNEL_LIMIT}）です。完了したチャンネルを消すか、/setup を確かめてください）`,
  failed: "Claude Code のチャンネルを作れませんでした（Discord の操作に失敗しました。次に関わったときにまた試します）",
};

export const CC_CHANNEL_ENDED_TEXT = "セッションが終わりました。";
export const CC_CHANNEL_REVIVED_TEXT = "セッションが戻りました。";

/** 1 行の表示（制御文字を空白にし、Markdown とメンションを無効にする） */
function plain(text: string): string {
  return escapeDiscordText(headChars(text.replace(/[\u0000-\u001f\u007f]/g, " "), LABEL_MAX_CHARS));
}

/** topic の 1 行（制御文字を空白に。topic は Markdown として描かれないので崩さない） */
function topicPart(text: string): string {
  return headChars(text.replace(/[\u0000-\u001f\u007f]/g, " "), LABEL_MAX_CHARS);
}

/** ディレクトリの最後の名前 */
function lastSegment(cwd: string | null): string {
  if (cwd === null) return "";
  const parts = cwd.split("/").filter((part) => part !== "");
  return parts[parts.length - 1] ?? "";
}

/**
 * チャンネル名（純関数。§3.2）: `cc-<normalizeChannelName(セッション名)>`、名前が無ければ `cc-<ディレクトリの最後の名前>`、どちらも空なら `cc-session`。
 * 100 字で切り、taken（そのサーバーの削除されていない cc のチャンネルの名前）にあれば `-2`, `-3` を付ける
 */
export function ccChannelName(name: string | null, cwd: string | null, taken: ReadonlySet<string>): string {
  const raw = normalizeChannelName(name ?? "") || normalizeChannelName(lastSegment(cwd)) || "session";
  const base = normalizeChannelName(`cc-${raw}`);
  if (!taken.has(base)) return base;
  for (let n = 2; ; n++) {
    const suffix = `-${n}`;
    const candidate = `${base.slice(0, CHANNEL_NAME_MAX_LENGTH - suffix.length).replace(/-+$/, "")}${suffix}`;
    if (!taken.has(candidate)) return candidate;
  }
}

/** topic（純関数。§3.2）: `Claude Code: <名前>（<ディレクトリ>）` */
export function ccChannelTopic(name: string | null, dir: string | null): string {
  const label = name === null || name === "" ? (dir ?? "（名前なし）") : name;
  return `Claude Code: ${topicPart(label)}${dir === null || dir === "" ? "" : `（${topicPart(dir)}）`}`;
}

/** 最初の投稿（純関数）。発言を届けるのは CC11 なので、まだ届かないことを書く */
export function ccChannelIntro(name: string | null, dir: string | null, origin: CcChannelOrigin): string {
  const label = name === null || name === "" ? "（名前なし）" : name;
  return (
    `Claude Code のセッション「${plain(label)}」${dir === null || dir === "" ? "" : `（${plain(dir)}）`}のチャンネルです（${ORIGIN_LABEL[origin]} で作りました）。` +
    "セッションが終わると完了に移し、戻るとここに戻します。今はまだ、ここに書いてもセッションには届きません"
  );
}

export type CcChannelsDeps = {
  cfg: Pick<Config, "allowedGuildIds" | "workspaceDir">;
  store: CcChannelStore;
  guildSettings: Pick<GuildSettingsStore, "get" | "ccCategoryId" | "listStateCategories">;
  registry: Pick<CcRegistry, "snapshot">;
  panes: Pick<CcPaneResolver, "lookup">;
  /** 作成・最初の投稿・終わった / 戻ったの 1 行（既定の人格の Bot） */
  gateway: Pick<Gateway, "createTextChannel" | "channelExists" | "countChannelsIn" | "sendMessage">;
  /** /setup・/new と同じキュー（key は layoutQueueKey） */
  queue: Pick<KeyedSerialQueue, "run">;
  /** 完了カテゴリ・カテゴリ「Claude Code」への移動 */
  channelOps: Pick<ChannelOpsQueue, "enqueueMove" | "cancel">;
  /** ensureFor で作れなかったときの #system の 1 行 */
  notify: SystemNotifier;
  /** ~ の場所（ディレクトリの表示） */
  home: string;
  now: () => Date;
  log: (message: string) => void;
};

/** /cc open のセレクトの 1 件 */
export type CcPickItem = { sessionId: string; label: string; state: CcState; dir: string | null; hasChannel: boolean };

function errorKind(error: unknown): string {
  return error instanceof Error ? error.name : typeof error;
}

export class CcChannels {
  private readonly deps: CcChannelsDeps;
  /** 理由 → 最後に #system に出した時刻（ensureFor。同じ理由は 1 時間に 1 回） */
  private readonly noticedAt = new Map<string, number>();
  private readonly inFlight = new Set<Promise<void>>();

  constructor(deps: CcChannelsDeps) {
    this.deps = deps;
  }

  /** 投稿の途中のものを待つ */
  async idle(): Promise<void> {
    while (this.inFlight.size > 0) await Promise.all([...this.inFlight]);
  }

  /** そのセッションの削除されていないチャンネル（Web の一覧の channel） */
  channelOf(sessionId: string): CcChannelRow | undefined {
    return this.deps.store.anyFor(sessionId);
  }

  /**
   * 作る先のサーバー（guildId を渡せばそれ）。渡さなければ SELF_AGENT_ALLOWED_GUILD_IDS の順で最初の、カテゴリ「Claude Code」を記録しているサーバー。
   * どれも無ければ undefined
   */
  defaultGuild(): string | undefined {
    return this.deps.cfg.allowedGuildIds.find((guildId) => this.deps.guildSettings.ccCategoryId(guildId) !== null);
  }

  /** /cc open のセレクトの候補（一覧の順に CC_PICK_LIMIT 件まで） */
  pickItems(): CcPickItem[] {
    return this.deps.registry
      .snapshot()
      .sessions.slice(0, CC_PICK_LIMIT)
      .map((view) => ({
        sessionId: view.sessionId,
        label: view.name ?? cwdLabel(view.cwd, this.deps.cfg.workspaceDir, this.deps.home) ?? "（名前なし）",
        state: view.state,
        dir: cwdLabel(view.cwd, this.deps.cfg.workspaceDir, this.deps.home),
        hasChannel: this.deps.store.anyFor(view.sessionId) !== undefined,
      }));
  }

  /**
   * チャンネルを作る（§3.1 の流れ。手動の口）。guildId は許可サーバーであること（呼び出し側が確かめる）。reject しない
   */
  openChannel(guildId: string, sessionId: string, origin: CcChannelOrigin): Promise<CcOpenResult> {
    return this.deps.queue.run(layoutQueueKey(guildId), async () => {
      try {
        return await this.create(guildId, sessionId, origin);
      } catch (error) {
        this.deps.log(`Claude Code: チャンネルを作れませんでした（failed・${errorKind(error)}）`);
        return { ok: false, reason: "failed" };
      }
    });
  }

  /**
   * 関わったきっかけから呼ぶ口（CC11 で sender・starter・許可の応答から呼ぶ）。既にあれば何もしない。guildId を省けば defaultGuild。
   * 作れなくても投げず、log に 1 行と、not_set_up・full・failed は #system に 1 行（同じ理由は 1 時間に 1 回）
   */
  async ensureFor(sessionId: string, origin: CcChannelOrigin, guildId?: string): Promise<CcOpenResult> {
    const existing = this.deps.store.anyFor(sessionId);
    if (existing !== undefined) return { ok: false, reason: "exists", channelId: existing.channelId, guildId: existing.guildId };
    const target = guildId ?? this.defaultGuild();
    const result: CcOpenResult = target === undefined ? { ok: false, reason: "not_set_up" } : await this.openChannel(target, sessionId, origin);
    if (!result.ok && result.reason !== "exists") {
      // failed は openChannel が種類付きで出している
      if (result.reason !== "failed") this.deps.log(`Claude Code: チャンネルを作れませんでした（${result.reason}）`);
      if (result.reason === "not_set_up" || result.reason === "full" || result.reason === "failed") {
        const noticeGuild = target ?? this.deps.cfg.allowedGuildIds.find((id) => this.deps.guildSettings.get(id) !== undefined);
        if (noticeGuild !== undefined) this.noticeFailure(noticeGuild, result.reason);
      }
    }
    return result;
  }

  /**
   * セッションが一覧から消えた（registry の ended）: open のチャンネルを ended にして 1 行を出し、完了カテゴリへ移す。
   * 開いているチャンネルが無ければ false
   */
  ended(session: Pick<CcSessionRow, "sessionId">): boolean {
    const row = this.deps.store.openFor(session.sessionId);
    if (row === undefined || !this.deps.store.setState(row.channelId, "ended", ["open"])) return false;
    this.deps.log(`Claude Code: セッションが終わったため、チャンネルを完了に移します（guild=${row.guildId}）`);
    this.post(row, CC_CHANNEL_ENDED_TEXT);
    this.deps.channelOps.enqueueMove(row.channelId, { kind: "state", guildId: row.guildId, state: "done" });
    return true;
  }

  /**
   * 同じ session_id が一覧に戻った（registry の revived）: その session_id の ended のチャンネルを open に戻して 1 行を出し、
   * カテゴリ「Claude Code」へ戻す（付け替えの前の id（previous_session_id）では開き直さない）。開き直さなければ false
   */
  revived(session: Pick<CcSessionRow, "sessionId">): boolean {
    const row = this.deps.store.anyFor(session.sessionId);
    if (row === undefined || row.state !== "ended" || !this.deps.store.setState(row.channelId, "open", ["ended"])) return false;
    this.deps.log(`Claude Code: セッションが戻ったため、チャンネルを開き直します（guild=${row.guildId}）`);
    this.post(row, CC_CHANNEL_REVIVED_TEXT);
    this.moveToCategory(row);
    return true;
  }

  /**
   * 再同期（scheduler.ts の tick。§3.6）: listedAt より前に作ったそのサーバーの削除されていない行のうち、Discord 上に無いものは削除済みに、
   * open でカテゴリ「Claude Code」の外のものはそこへ、ended で完了カテゴリの外のものは完了へ移す（移すのは limit 件まで）。移した数を返す
   */
  reconcile(guildId: string, parents: ReadonlyMap<string, string | null>, listedAt: Date, limit: number): number {
    const { store, guildSettings, channelOps, log } = this.deps;
    const ccCategoryId = guildSettings.ccCategoryId(guildId);
    const doneCategories = guildSettings
      .listStateCategories(guildId, "done")
      .map((category) => category.categoryId)
      .filter((id) => parents.has(id));
    let moved = 0;
    let deleted = 0;
    for (const candidate of store.listUndeleted(guildId)) {
      // 一覧を取っている間に作った行は、一覧に無くても消さない
      if (Date.parse(candidate.createdAt) >= listedAt.getTime()) continue;
      const row = store.get(candidate.channelId);
      if (row === undefined || row.state === "deleted") continue;
      if (!parents.has(row.channelId)) {
        if (store.markDeleted(row.channelId)) {
          channelOps.cancel(row.channelId);
          deleted++;
        }
        continue;
      }
      if (moved >= limit) continue;
      const parentId = parents.get(row.channelId) ?? null;
      if (row.state === "open") {
        if (ccCategoryId === null || !parents.has(ccCategoryId) || parentId === ccCategoryId) continue;
        channelOps.enqueueMove(row.channelId, { kind: "category", categoryId: ccCategoryId });
        moved++;
      } else if (row.state === "ended") {
        if (doneCategories.length === 0 || (parentId !== null && doneCategories.includes(parentId))) continue;
        channelOps.enqueueMove(row.channelId, { kind: "state", guildId, state: "done" });
        moved++;
      }
    }
    if (deleted > 0) log(`Claude Code: Discord 上に無いチャンネル ${deleted} 件を削除済みにしました（guild=${guildId}）`);
    if (moved > 0) log(`Claude Code: カテゴリが合わないチャンネル ${moved} 件を移します（guild=${guildId}）`);
    return moved;
  }

  private async create(guildId: string, sessionId: string, origin: CcChannelOrigin): Promise<CcOpenResult> {
    const { store, guildSettings, registry, panes, gateway, log } = this.deps;
    const existing = store.anyFor(sessionId);
    if (existing !== undefined) {
      // 終わったチャンネルでも、セッションが一覧に戻っていれば開き直す（§3.6）
      if (existing.state === "ended" && registry.snapshot().sessions.some((view) => view.sessionId === sessionId)) {
        this.revived({ sessionId });
      }
      return { ok: false, reason: "exists", channelId: existing.channelId, guildId: existing.guildId };
    }
    const sessions = registry.snapshot().sessions;
    const view = sessions.find((candidate) => candidate.sessionId === sessionId);
    if (view === undefined) return { ok: false, reason: "not_found" };
    if (!(await this.inTmux(view, sessions))) return { ok: false, reason: "not_in_tmux" };
    const categoryId = guildSettings.ccCategoryId(guildId);
    if (categoryId === null || !(await gateway.channelExists(categoryId))) return { ok: false, reason: "not_set_up" };
    if ((await gateway.countChannelsIn(categoryId)) >= CC_CATEGORY_CHANNEL_LIMIT) return { ok: false, reason: "full" };
    const name = view.name ?? null;
    const cwd = view.cwd ?? null;
    const dir = cwdLabel(view.cwd, this.deps.cfg.workspaceDir, this.deps.home);
    const taken = new Set(store.listUndeleted(guildId).map((row) => row.name));
    const channelName = ccChannelName(name, cwd, taken);
    const channelId = await gateway.createTextChannel(guildId, { name: channelName, parentId: categoryId, topic: ccChannelTopic(name, dir) });
    try {
      store.create({ channelId, guildId, sessionId, name: channelName, cwd, origin });
    } catch (error) {
      // 手で消せるよう、作ったチャンネルの ID を出す（log 方針の例外。セッションのチャンネルと同じ）
      log(`Claude Code: チャンネルを作りましたが記録に失敗しました（guild=${guildId}、channel=${channelId}）: ${errorKind(error)}`);
      return { ok: false, reason: "failed" };
    }
    log(`Claude Code: チャンネルを作りました（guild=${guildId}、${origin}）`);
    try {
      await gateway.sendMessage(channelId, { text: ccChannelIntro(name, dir, origin), suppressEmbeds: true });
    } catch (error) {
      log(`Claude Code: チャンネルの最初の投稿に失敗しました（${errorKind(error)}）`);
    }
    return { ok: true, channelId, guildId };
  }

  /** 送ってよいペイン（findSendablePane）に当たるか */
  private async inTmux(view: CcSessionView, sessions: readonly CcSessionView[]): Promise<boolean> {
    const lookup = await this.deps.panes.lookup(new Set(sessions.map((session) => session.pid)));
    return lookup.ok && lookup.sendable({ pid: view.pid, tmux: view.tmux }).ok;
  }

  private moveToCategory(row: CcChannelRow): void {
    const categoryId = this.deps.guildSettings.ccCategoryId(row.guildId);
    // カテゴリを作り直すのは /setup（作り直した後は再同期が戻す）
    if (categoryId === null) return;
    this.deps.channelOps.enqueueMove(row.channelId, { kind: "category", categoryId });
  }

  /** そのチャンネルに 1 行（失敗は log だけ） */
  private post(row: CcChannelRow, text: string): void {
    const task = (async () => {
      try {
        await this.deps.gateway.sendMessage(row.channelId, { text, suppressEmbeds: true });
      } catch (error) {
        this.deps.log(`Claude Code: チャンネルへの投稿に失敗しました（${errorKind(error)}）`);
      }
    })();
    this.inFlight.add(task);
    void task.finally(() => this.inFlight.delete(task));
  }

  /** 作れなかった理由を #system に 1 行（同じ理由は CC_CHANNEL_FAILURE_NOTICE_MS に 1 回。失敗は log だけ） */
  private noticeFailure(guildId: string, reason: "not_set_up" | "full" | "failed"): void {
    const now = this.deps.now().getTime();
    const last = this.noticedAt.get(reason);
    if (last !== undefined && now - last < CC_CHANNEL_FAILURE_NOTICE_MS) return;
    this.noticedAt.set(reason, now);
    const task = (async () => {
      try {
        await this.deps.notify(guildId, { text: FAILURE_NOTICE[reason] }, { level: "warning" });
      } catch (error) {
        this.deps.log(`Claude Code: チャンネルを作れなかった知らせに失敗しました（${errorKind(error)}）`);
      }
    })();
    this.inFlight.add(task);
    void task.finally(() => this.inFlight.delete(task));
  }
}
