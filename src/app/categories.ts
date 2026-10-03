// 状態カテゴリ（進行中 / 待ち / 完了）の選び方。/new・session_open の作成先と ChannelOpsQueue の移動先で共通
import type { Gateway } from "../discord/gateway.ts";
import type { GuildSettingsStore, SessionState } from "../store/guild-settings.ts";
import { stateCategoryName } from "./commands/setup.ts";

/** Discord で 1 つのカテゴリに入れられるチャンネル数 */
const CATEGORY_CHANNEL_LIMIT = 50;

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
