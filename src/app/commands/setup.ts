import type { Config, PersonaConfig } from "../../config.ts";
import { normalizeChannelName } from "../../discord/channel-name.ts";
import type { Gateway, OutgoingMessage } from "../../discord/gateway.ts";
import type { GuildChannelField, GuildSettingsStore, SessionState } from "../../store/guild-settings.ts";
import type { CommandHandler } from "../interactions.ts";
import type { KeyedSerialQueue } from "../queue.ts";

const HOME_CATEGORY_NAME = "self-agent";

/** self-agent カテゴリの中に作るテキストチャンネル（作る順）。name・topic は作成時にだけ設定する */
const HOME_CHANNELS: ReadonlyArray<{
  field: Exclude<GuildChannelField, "homeCategoryId" | "githubChannelId">;
  name: string;
  topic: string;
}> = [
  { field: "inboxChannelId", name: "inbox", topic: "思いつきややることを書くと Bot が返事します" },
  { field: "tasksChannelId", name: "tasks", topic: "タスクの話だけをする場所。登録・期限の変更・やめる・今日やることを Bot と話せます" },
  { field: "systemChannelId", name: "system", topic: "Bot の起動・エラー・利用状況の通知" },
];

/** GitHub の通知を流すチャンネル（SELF_AGENT_GITHUB=1 のときだけ、#system の後に作る。docs/plan/github-notifications.md §4.1） */
const GITHUB_CHANNEL = { name: "github", topic: "GitHub の通知（自分宛て・自分のリポジトリの新しい Issue / PR）" };

/** 作業ジョブの報告のチャンネル（SELF_AGENT_JOBS が有効のときだけ、#github の後に作る。docs/plan/coding-jobs.md §9。発言は受け付けない） */
const JOBS_CHANNEL = { name: "jobs", topic: "作業ジョブ（/job）の進み具合と結果。ここへの発言には返事しません" };

/** 足した人格の入口（#<NAME>）。チャンネル名は表示名から作る（config で空・inbox/tasks/system・人格どうしの重なりを弾いてある） */
export function personaInboxName(persona: Pick<PersonaConfig, "name">): string {
  return normalizeChannelName(persona.name);
}

/** 足した人格の #<NAME> の topic（作成時にだけ設定する） */
export function personaInboxTopic(persona: Pick<PersonaConfig, "name">): string {
  return `${persona.name} と話す場所。思いつきややることを書くと ${persona.name} が返事します`;
}

/** 状態カテゴリ（作る順）。/setup が作るのは各状態の 1 つ目（ordinal 1）だけ */
const STATE_CATEGORIES: ReadonlyArray<{ state: SessionState; name: string }> = [
  { state: "active", name: "進行中" },
  { state: "waiting", name: "待ち" },
  { state: "done", name: "完了" },
];

const FIRST_ORDINAL = 1;

export const HOME_PANEL_TEXT = "self-agent のホーム。ボタンかスラッシュコマンドで操作できます。";
/** ホームパネルのボタンの custom_id の名前空間（`home:<action>`。処理は home.ts） */
export const HOME_NAMESPACE = "home";

/** 状態カテゴリの名前（満杯で足すカテゴリは `進行中 2` のようにこれに ordinal を付ける） */
export function stateCategoryName(state: SessionState): string {
  const category = STATE_CATEGORIES.find((candidate) => candidate.state === state);
  if (category === undefined) throw new Error(`状態カテゴリの名前がありません: ${state}`);
  return category.name;
}

/** カテゴリ・チャンネルを作る操作（/setup・/new・session_open）の直列化の key。同じサーバーではどれも 1 つずつ実行する */
export function layoutQueueKey(guildId: string): string {
  return `layout:${guildId}`;
}

export type SetupDeps = {
  /** personas は足した人格（#<NAME> を作る）、github が true なら #github も、jobs が true なら #jobs も作る。無ければ今と同じ */
  cfg?: Partial<Pick<Config, "personas" | "github" | "jobs">>;
  gateway: Pick<
    Gateway,
    | "createCategory"
    | "createTextChannel"
    | "channelExists"
    | "moveChannel"
    | "sendMessage"
    | "pinMessage"
    | "messageExists"
  >;
  guildSettings: GuildSettingsStore;
  /** 同じサーバーの /setup・/new を 1 つずつ実行する（key は layoutQueueKey） */
  queue: KeyedSerialQueue;
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
 * self-agent カテゴリを作り直したときは、残っている #inbox / #tasks / #<NAME> / #system をそこへ移す
 * （移動に失敗した分や手で動かされた分は、定期処理の再同期（scheduler.ts）が戻す）。
 * 足した人格（cfg.personas）があれば、#tasks の後にその人格の #<NAME> を self-agent カテゴリに作る（作るのは既定の人格の Bot。ホームパネルは置かない）。
 * cfg.github が true なら、#system の後に #github を作る（false なら作らず、既にあるものも触らない）。
 * cfg.jobs が true なら、その後に #jobs を作る（同じく false なら作らず触らない）
 */
export async function ensureGuildLayout(
  guildId: string,
  deps: {
    cfg?: SetupDeps["cfg"];
    gateway: Pick<SetupDeps["gateway"], "createCategory" | "createTextChannel" | "channelExists" | "moveChannel">;
    guildSettings: GuildSettingsStore;
  },
): Promise<SetupResult> {
  const { gateway, guildSettings } = deps;
  const personas = deps.cfg?.personas ?? [];
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
    const moveIfRecreated = async (id: string): Promise<void> => {
      if (homeRecreated) await gateway.moveChannel(id, homeCategoryId);
    };
    for (const { field, name, topic } of HOME_CHANNELS) {
      // #<NAME> は #tasks の後、#system の前に作る
      if (field === "systemChannelId") {
        for (const persona of personas) {
          await ensure(
            guildSettings.personaInbox(guildId, persona.id)?.channelId,
            () =>
              gateway.createTextChannel(guildId, {
                name: personaInboxName(persona),
                parentId: homeCategoryId,
                topic: personaInboxTopic(persona),
              }),
            (id) => guildSettings.setPersonaInbox(guildId, persona.id, id),
            moveIfRecreated,
          );
        }
      }
      await ensure(
        settings?.[field],
        () => gateway.createTextChannel(guildId, { name, parentId: homeCategoryId, topic }),
        (id) => guildSettings.setChannel(guildId, field, id),
        moveIfRecreated,
      );
    }
    if (deps.cfg?.github === true) {
      await ensure(
        settings?.githubChannelId,
        () => gateway.createTextChannel(guildId, { ...GITHUB_CHANNEL, parentId: homeCategoryId }),
        (id) => guildSettings.setChannel(guildId, "githubChannelId", id),
        moveIfRecreated,
      );
    }
    if (deps.cfg?.jobs === true) {
      await ensure(
        guildSettings.jobsChannelId(guildId),
        () => gateway.createTextChannel(guildId, { ...JOBS_CHANNEL, parentId: homeCategoryId }),
        (id) => {
          guildSettings.setJobsChannel(guildId, id);
        },
        moveIfRecreated,
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

/** #inbox にピン留めするホームパネル: [新しいセッション]（`home:new`）[タスク一覧]（`home:tasks`）[待ちのセッション]（`home:waiting`） */
export function homePanelMessage(): OutgoingMessage {
  return {
    text: HOME_PANEL_TEXT,
    components: [
      {
        kind: "buttons",
        buttons: [
          { customId: `${HOME_NAMESPACE}:new`, label: "新しいセッション", style: "primary" },
          { customId: `${HOME_NAMESPACE}:tasks`, label: "タスク一覧" },
          { customId: `${HOME_NAMESPACE}:waiting`, label: "待ちのセッション" },
        ],
      },
    ],
  };
}

/**
 * #inbox にホームパネルを投稿してピン留めし、メッセージ ID を保存する。保存したメッセージがまだあれば何もしない（ピン留めも確かめない）。
 * ピン留めに失敗しても投稿と保存は残し、log に出す。存在の確認・投稿の失敗は投げる
 */
export async function ensureHomePanel(
  guildId: string,
  deps: Pick<SetupDeps, "gateway" | "guildSettings" | "log">,
): Promise<void> {
  const { gateway, guildSettings, log } = deps;
  const settings = guildSettings.get(guildId);
  const inboxChannelId = settings?.inboxChannelId;
  if (settings === undefined || inboxChannelId === null || inboxChannelId === undefined) return;
  const savedId = settings.homePanelMessageId;
  // #inbox を作り直したときは、前の #inbox のメッセージは見つからない（投稿し直す）
  if (savedId !== null && (await gateway.messageExists(inboxChannelId, savedId))) return;
  const messageId = await gateway.sendMessage(inboxChannelId, homePanelMessage());
  guildSettings.setHomePanelMessageId(guildId, messageId);
  try {
    await gateway.pinMessage(inboxChannelId, messageId);
    log(`ホームパネルを #inbox に投稿してピン留めしました（guild=${guildId}）`);
  } catch (error) {
    log(`ホームパネルを #inbox に投稿しましたが、ピン留めに失敗しました（guild=${guildId}）: ${describeError(error)}`);
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

/** `/setup`: self-agent 用のカテゴリとチャンネル（足した人格の #<NAME> を含む）を作り、#inbox にホームパネルをピン留めして、結果を本人にだけ表示する */
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
      const { result, panelFailure } = await queue.run(layoutQueueKey(guildId), async () => {
        const layout = await ensureGuildLayout(guildId, deps);
        // 途中で失敗した回は揃っていないので、ホームパネルは次の /setup で直す
        if (layout.failure !== null) return { result: layout, panelFailure: null };
        try {
          await ensureHomePanel(guildId, deps);
          return { result: layout, panelFailure: null };
        } catch (error) {
          // カテゴリとチャンネルは揃っているので /setup の失敗にはせず、返信に 1 行足す
          log(`ホームパネルの投稿に失敗しました（guild=${guildId}）: ${describeError(error)}`);
          return { result: layout, panelFailure: describeError(error) };
        }
      });
      if (result.failure === null) {
        log(`/setup を実行しました（guild=${guildId}、作成 ${result.created.length} 件）`);
      } else {
        log(`/setup が途中で失敗しました（guild=${guildId}、作成 ${result.created.length} 件）: ${result.failure}`);
      }
      const text = formatSetupResult(result);
      await responder.reply({
        text: panelFailure === null ? text : `${text}\nホームパネルの投稿に失敗しました: ${panelFailure}`,
        ephemeral: true,
      });
    },
  };
}
