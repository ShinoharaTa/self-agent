import type { Gateway } from "../../discord/gateway.ts";
import type { GuildSettingsStore, SessionState } from "../../store/guild-settings.ts";
import type { TopicSessionStore } from "../../store/topic-sessions.ts";
import type { CommandHandler } from "../interactions.ts";
import type { KeyedSerialQueue } from "../queue.ts";
import { layoutQueueKey, stateCategoryName } from "./setup.ts";

export const NOT_SET_UP_REPLY = "先に /setup を実行してください";
export const EMPTY_TITLE_REPLY = "題名を入力してください";

/** Discord で 1 つのカテゴリに入れられるチャンネル数 */
const CATEGORY_CHANNEL_LIMIT = 50;
/** /setup が作る最初の進行中カテゴリ */
const FIRST_ORDINAL = 1;

/** 題名の文字数（Discord 側で検証する） */
const TITLE_MAX_LENGTH = 100;
/** チャンネル名の文字数の上限（UTF-16 の単位で数える） */
const CHANNEL_NAME_MAX_LENGTH = 100;
/** 正規化して空になった題名のチャンネル名 */
const FALLBACK_CHANNEL_NAME = "session";

/** ASCII の記号のうち `-` と `_` 以外 */
const ASCII_SYMBOLS = /[\x21-\x2C\x2E\x2F\x3A-\x40\x5B-\x5E\x60\x7B-\x7E]/g;

/**
 * 題名をチャンネル名にする。前後の空白を除く → 空白の連続を `-` に → `-` と `_` 以外の ASCII 記号を除く →
 * ASCII 英字を小文字に → `-` の連続を 1 つに、先頭・末尾の `-` を除く → 100 字で切る → 空なら `session`。日本語はそのまま残す
 */
export function toChannelName(title: string): string {
  let name = title
    .trim()
    .replace(/\s+/gu, "-")
    .replace(ASCII_SYMBOLS, "")
    .replace(/[A-Z]/g, (letter) => letter.toLowerCase())
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, CHANNEL_NAME_MAX_LENGTH);
  // サロゲートペアの途中で切れたら、残った前半も落とす
  if (/[\uD800-\uDBFF]$/.test(name)) name = name.slice(0, -1);
  // 切った位置で末尾に - が残ることがあるので除く
  name = name.replace(/-+$/, "");
  return name === "" ? FALLBACK_CHANNEL_NAME : name;
}

export function welcomeText(title: string): string {
  return `セッション「${title}」を始めました。ここで話しかけてください。`;
}

export type NewSessionDeps = {
  gateway: Pick<Gateway, "createCategory" | "createTextChannel" | "channelExists" | "countChannelsIn" | "send">;
  guildSettings: GuildSettingsStore;
  topicSessions: TopicSessionStore;
  /** /setup と同じキュー。同じサーバーの /setup・/new を 1 つずつ実行する（key は layoutQueueKey） */
  queue: KeyedSerialQueue;
  log: (message: string) => void;
};

export type NewSessionResult = { result: "not_set_up" } | { result: "created"; channelId: string };

export type FindStateCategoryDeps = {
  gateway: Pick<Gateway, "createCategory" | "channelExists" | "countChannelsIn">;
  guildSettings: GuildSettingsStore;
  log: (message: string) => void;
};

/**
 * その状態のカテゴリのうち空き（50 未満）のあるものを ordinal の昇順で探す。Discord 上で消えていたカテゴリは飛ばす（作り直すのは /setup）。
 * どれも満杯なら `進行中 N`・`完了 N`（N は保存済みの最大 ordinal + 1）を作って保存する。/new と ChannelOpsQueue の移動先で使う
 */
export async function findStateCategory(
  guildId: string,
  state: SessionState,
  deps: FindStateCategoryDeps,
): Promise<string> {
  const { gateway, guildSettings, log } = deps;
  const stateName = stateCategoryName(state);
  const categories = guildSettings.listStateCategories(guildId, state);
  for (const { ordinal, categoryId } of categories) {
    if (!(await gateway.channelExists(categoryId))) {
      log(`${stateName}カテゴリ（${ordinal} 番目）が見つからないため飛ばしました（guild=${guildId}）`);
      continue;
    }
    if ((await gateway.countChannelsIn(categoryId)) < CATEGORY_CHANNEL_LIMIT) return categoryId;
  }
  const ordinal = Math.max(0, ...categories.map((category) => category.ordinal)) + 1;
  const name = `${stateName} ${ordinal}`;
  const categoryId = await gateway.createCategory(guildId, name);
  guildSettings.setStateCategory(guildId, state, ordinal, categoryId);
  log(`${stateName}カテゴリに空きが無いため「${name}」を作りました（guild=${guildId}）`);
  return categoryId;
}

/** 空きのある進行中カテゴリにセッション用のチャンネルを作り、sessions に保存する。/setup 前（進行中カテゴリが無い）なら何もしない */
export async function createTopicSession(
  guildId: string,
  title: string,
  deps: Pick<NewSessionDeps, "gateway" | "guildSettings" | "topicSessions" | "log">,
): Promise<NewSessionResult> {
  const { gateway, guildSettings, topicSessions, log } = deps;
  if (
    guildSettings.get(guildId) === undefined ||
    guildSettings.getStateCategory(guildId, "active", FIRST_ORDINAL) === undefined
  ) {
    return { result: "not_set_up" };
  }
  const categoryId = await findStateCategory(guildId, "active", deps);
  // name・topic は作成時にだけ設定し、以後変更しない
  const channelId = await gateway.createTextChannel(guildId, {
    name: toChannelName(title),
    parentId: categoryId,
    topic: title,
  });
  try {
    topicSessions.create({ channelId, guildId, title, categoryId });
  } catch (error) {
    // チャンネルだけが Discord に残る。手で消せるよう、ログにチャンネル ID を出す（ログ方針の例外）
    log(
      `セッションのチャンネルを作りましたが DB への保存に失敗しました（guild=${guildId}、channel=${channelId}）: ${describeError(error)}`,
    );
    throw error;
  }
  return { result: "created", channelId };
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** `/new 題名`: セッション用のチャンネルを進行中カテゴリに作り、そのリンクを本人にだけ表示する */
export function createNewSessionCommand(deps: NewSessionDeps): CommandHandler {
  const { gateway, queue, log } = deps;
  return {
    def: {
      name: "new",
      description: "セッション用のチャンネルを作ります（そのチャンネルで話しかけると会話が続きます）",
      options: [
        {
          type: "string",
          name: "title",
          description: "セッションの題名（チャンネル名と topic に使います）",
          required: true,
          minLength: 1,
          maxLength: TITLE_MAX_LENGTH,
        },
      ],
    },
    async handle(interaction, responder) {
      // 許可サーバー以外（DM を含む）は interactions.ts で弾いている
      const guildId = interaction.guildId;
      if (guildId === null) throw new Error("サーバー外で /new が呼ばれました");
      const rawTitle = interaction.options.title;
      if (typeof rawTitle !== "string") throw new Error("/new の題名がありません");
      // 空白だけの題名は Discord の min_length を通ってしまうので、ここで弾く
      const title = rawTitle.trim();
      if (title === "") {
        await responder.reply({ text: EMPTY_TITLE_REPLY, ephemeral: true });
        return;
      }
      // Discord への作成が複数回ありうるので、先に保留する
      await responder.defer(true);
      // 同時に走ると空きの数え方がずれるので、/setup と同じ key で 1 つずつ実行する
      const result = await queue.run(layoutQueueKey(guildId), () => createTopicSession(guildId, title, deps));
      if (result.result === "not_set_up") {
        await responder.reply({ text: NOT_SET_UP_REPLY, ephemeral: true });
        return;
      }
      log(`/new でセッションを作りました（guild=${guildId}）`);
      try {
        await gateway.send(result.channelId, welcomeText(title));
      } catch (error) {
        // チャンネルと DB の行はできているので、失敗の返信にはしない
        log(`セッションの最初の投稿に失敗しました: ${describeError(error)}`);
      }
      await responder.reply({ text: `<#${result.channelId}> を作りました`, ephemeral: true });
    },
  };
}
