import type { Gateway } from "../../discord/gateway.ts";
import type { GuildChannelField, GuildSettingsStore, SessionState } from "../../store/guild-settings.ts";
import type { ChannelOpsQueue } from "../channel-ops.ts";
import type { CommandHandler } from "../interactions.ts";
import type { KeyedSerialQueue } from "../queue.ts";

const HOME_CATEGORY_NAME = "self-agent";

/** self-agent カテゴリの中に作るテキストチャンネル（作る順）。name・topic は作成時にだけ設定する */
const HOME_CHANNELS: ReadonlyArray<{
  field: Exclude<GuildChannelField, "homeCategoryId">;
  name: string;
  topic: string;
}> = [
  { field: "inboxChannelId", name: "inbox", topic: "思いつきややることを書くと Bot が返事します" },
  { field: "tasksChannelId", name: "tasks", topic: "タスクの一覧" },
  { field: "systemChannelId", name: "system", topic: "Bot の起動・エラー・利用状況の通知" },
];

/** 状態カテゴリ（作る順）。/setup が作るのは各状態の 1 つ目（ordinal 1）だけ */
const STATE_CATEGORIES: ReadonlyArray<{ state: SessionState; name: string }> = [
  { state: "active", name: "進行中" },
  { state: "waiting", name: "待ち" },
  { state: "done", name: "完了" },
];

const FIRST_ORDINAL = 1;

/** 状態カテゴリの名前（満杯で足すカテゴリは `進行中 2` のようにこれに ordinal を付ける） */
export function stateCategoryName(state: SessionState): string {
  const category = STATE_CATEGORIES.find((candidate) => candidate.state === state);
  if (category === undefined) throw new Error(`状態カテゴリの名前がありません: ${state}`);
  return category.name;
}

/** カテゴリ・チャンネルを作る操作（/setup・/new）の直列化の key。同じサーバーではどちらも 1 つずつ実行する */
export function layoutQueueKey(guildId: string): string {
  return `layout:${guildId}`;
}

export type SetupDeps = {
  gateway: Pick<Gateway, "createCategory" | "createTextChannel" | "channelExists" | "moveChannel" | "getParentId">;
  guildSettings: GuildSettingsStore;
  /** 同じサーバーの /setup・/new を 1 つずつ実行する（key は layoutQueueKey） */
  queue: KeyedSerialQueue;
  /** self-agent カテゴリの外に出ている #inbox / #tasks / #system を戻す */
  channelOps: Pick<ChannelOpsQueue, "enqueueMove">;
  log: (message: string) => void;
};

export type SetupResult = {
  /** 今回作ったカテゴリ・チャンネルの ID（作った順） */
  created: string[];
  /** DB にあり、Discord 上にも残っていたもの */
  existing: string[];
  /** 途中で失敗したときの理由。それまでに作ったものは保存済み */
  failure: string | null;
};

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * 足りないカテゴリ・チャンネルを作る。1 つ作るごとに DB へ保存するので、途中で失敗しても次の実行で続きから作る。
 * DB にあって Discord 上に残っているものは作らない（既存の同名カテゴリは再利用しない）。
 * self-agent カテゴリを作り直したときは、残っている #inbox / #tasks / #system をそこへ移す
 */
export async function ensureGuildLayout(
  guildId: string,
  deps: Pick<SetupDeps, "gateway" | "guildSettings">,
): Promise<SetupResult> {
  const { gateway, guildSettings } = deps;
  const result: SetupResult = { created: [], existing: [], failure: null };

  const ensure = async (
    savedId: string | null | undefined,
    create: () => Promise<string>,
    save: (id: string) => void,
    /** 残っていたときに呼ぶ */
    onExisting: (id: string) => Promise<void> = async () => {},
  ): Promise<string> => {
    if (savedId !== null && savedId !== undefined && (await gateway.channelExists(savedId))) {
      await onExisting(savedId);
      result.existing.push(savedId);
      return savedId;
    }
    const id = await create();
    save(id);
    result.created.push(id);
    return id;
  };

  try {
    const settings = guildSettings.get(guildId);
    const homeCategoryId = await ensure(
      settings?.homeCategoryId,
      () => gateway.createCategory(guildId, HOME_CATEGORY_NAME),
      (id) => guildSettings.setChannel(guildId, "homeCategoryId", id),
    );
    // カテゴリが消えると中のチャンネルはカテゴリ外に残るので、作り直したカテゴリへ戻す
    const homeRecreated = homeCategoryId !== settings?.homeCategoryId;
    for (const { field, name, topic } of HOME_CHANNELS) {
      await ensure(
        settings?.[field],
        () => gateway.createTextChannel(guildId, { name, parentId: homeCategoryId, topic }),
        (id) => guildSettings.setChannel(guildId, field, id),
        async (id) => {
          if (homeRecreated) await gateway.moveChannel(id, homeCategoryId);
        },
      );
    }
    for (const { state, name } of STATE_CATEGORIES) {
      await ensure(
        guildSettings.getStateCategory(guildId, state, FIRST_ORDINAL),
        () => gateway.createCategory(guildId, name),
        (id) => guildSettings.setStateCategory(guildId, state, FIRST_ORDINAL, id),
      );
    }
  } catch (error) {
    result.failure = describeError(error);
  }
  return result;
}

/**
 * #inbox / #tasks / #system の今の親が self-agent カテゴリと違えば、ChannelOpsQueue に戻す移動を入れる（移動は後で順に行う）。
 * カテゴリを作り直した回に移動が失敗した場合や、手で動かされた場合を直す。確認の失敗は log に出して次へ進む
 */
export async function repairHomeChannelParents(
  guildId: string,
  deps: Pick<SetupDeps, "gateway" | "guildSettings" | "channelOps" | "log">,
): Promise<void> {
  const { gateway, guildSettings, channelOps, log } = deps;
  const settings = guildSettings.get(guildId);
  const homeCategoryId = settings?.homeCategoryId;
  if (settings === undefined || homeCategoryId === null || homeCategoryId === undefined) return;
  let queued = 0;
  for (const { field } of HOME_CHANNELS) {
    const channelId = settings[field];
    if (channelId === null) continue;
    try {
      if ((await gateway.getParentId(channelId)) === homeCategoryId) continue;
      channelOps.enqueueMove(channelId, { kind: "category", categoryId: homeCategoryId });
      queued++;
    } catch (error) {
      log(`親カテゴリの確認に失敗しました（guild=${guildId}）: ${describeError(error)}`);
    }
  }
  if (queued > 0) {
    log(`self-agent カテゴリの外にあるチャンネル ${queued} 件を戻します（guild=${guildId}）`);
  }
}

function mentions(ids: readonly string[]): string {
  return ids.map((id) => `<#${id}>`).join(" ");
}

export function formatSetupResult(result: SetupResult): string {
  const lines: string[] = [];
  if (result.failure !== null) {
    lines.push(`途中で失敗しました: ${result.failure}`, "もう一度 /setup を実行すると、続きから作ります。");
  } else if (result.created.length === 0) {
    lines.push("すべて揃っています。新しく作ったものはありません。");
  } else {
    lines.push("セットアップしました。");
  }
  if (result.created.length > 0) lines.push(`作成: ${mentions(result.created)}`);
  if (result.existing.length > 0) lines.push(`既存: ${mentions(result.existing)}`);
  return lines.join("\n");
}

/** `/setup`: self-agent 用のカテゴリとチャンネルを作り、結果を本人にだけ表示する */
export function createSetupCommand(deps: SetupDeps): CommandHandler {
  const { queue, log } = deps;
  return {
    def: { name: "setup", description: "self-agent 用のカテゴリとチャンネルを作ります（消えたものだけ作り直します）" },
    async handle(interaction, responder) {
      // 許可サーバー以外（DM を含む）は interactions.ts で弾いている
      const guildId = interaction.guildId;
      if (guildId === null) throw new Error("サーバー外で /setup が呼ばれました");
      // Discord への作成が複数回あり 3 秒を超えうるので、先に保留する
      await responder.defer(true);
      // 同時に走ると両方が「未作成」と判断して二重に作るので、サーバーごとに 1 つずつ実行する（/new とも）
      const result = await queue.run(layoutQueueKey(guildId), async () => {
        const layout = await ensureGuildLayout(guildId, deps);
        // 途中で失敗した回は揃っていないので、親のずれは次の /setup で直す
        if (layout.failure === null) await repairHomeChannelParents(guildId, deps);
        return layout;
      });
      if (result.failure === null) {
        log(`/setup を実行しました（guild=${guildId}、作成 ${result.created.length} 件）`);
      } else {
        log(`/setup が途中で失敗しました（guild=${guildId}、作成 ${result.created.length} 件）: ${result.failure}`);
      }
      await responder.reply({ text: formatSetupResult(result), ephemeral: true });
    },
  };
}
