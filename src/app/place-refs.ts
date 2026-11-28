// チャンネルの場所（place。docs/plan/personas-web-antigravity.md §3.1）の引き方と、Discord に出す文の中での場所の書き方（§3.3 の 1・§3.2）。
// store だけで作れるので、人格の振り分け（personas.ts）を待たずに配線できる
import { escapeDiscordText } from "../discord/escape.ts";
import type { GuildSettingsStore } from "../store/guild-settings.ts";
import type { ChannelPlace } from "../store/local-places.ts";
import type { TopicSessionStore } from "../store/topic-sessions.ts";

export type PlaceStores = {
  /** 入口のチャンネル（#inbox・#tasks・#<NAME>）の場所 */
  guildSettings: Pick<GuildSettingsStore, "entryChannel">;
  /** セッションのチャンネルの場所 */
  topicSessions: Pick<TopicSessionStore, "get">;
};

/** チャンネルの場所。persona_channels（入口）→ sessions（セッション）の順に引き、どちらにも無ければ discord */
export function channelPlaceOf(stores: PlaceStores, channelId: string): ChannelPlace {
  return stores.guildSettings.entryChannel(channelId)?.place ?? stores.topicSessions.get(channelId)?.place ?? "discord";
}

export type PlaceRefsDeps = PlaceStores & {
  /** 人格の表示名。引けなければ undefined（人格の id で書く） */
  personaName: (personaId: string) => string | undefined;
};

export type PlaceRefs = {
  /** 場所がローカルか */
  isLocal(channelId: string): boolean;
  /**
   * Discord に出す文の中での場所の書き方。Discord の場所は `<#ID>`（今と同じ字）。
   * ローカルの話題は `「題名」（Web）`、ローカルの入口は `「人格の表示名」（Web）`（Discord ではローカルの番号は開けない）
   */
  refOf(channelId: string): string;
};

export function createPlaceRefs(deps: PlaceRefsDeps): PlaceRefs {
  return {
    isLocal: (channelId) => channelPlaceOf(deps, channelId) === "local",
    refOf(channelId) {
      // 引く順は channelPlaceOf と同じ（入口 → 話題）
      const entry = deps.guildSettings.entryChannel(channelId);
      if (entry !== undefined) {
        if (entry.place !== "local") return `<#${channelId}>`;
        return `「${escapeDiscordText(deps.personaName(entry.persona) ?? entry.persona)}」（Web）`;
      }
      const topic = deps.topicSessions.get(channelId);
      if (topic?.place !== "local") return `<#${channelId}>`;
      return `「${escapeDiscordText(topic.title)}」（Web）`;
    },
  };
}
