// 起動のときの、足した人格の場所（docs/plan/personas-web-antigravity.md §3.1・§3.2）。どちらも同期で DB だけを見る。
// checkPersonaPlaces: 人格の場所は id に付き、後から変えられない。述語（Web だけの人格か）と、今在る入口・話題の場所が食い違えば起動を断る（両向き）。
// ensureLocalEntries: /setup 済みの許可サーバーごとに、Web だけの人格のローカルの入口（番号だけ。Discord に何も作らない）を作る。/setup は作らない
import type { Config } from "../config.ts";
import type { GuildSettingsStore } from "../store/guild-settings.ts";
import type { ChannelPlace } from "../store/local-places.ts";
import type { TopicSessionStore } from "../store/topic-sessions.ts";
import type { LocalPersonaPlaces } from "./personas.ts";

export type LocalEntriesDeps = {
  cfg: Pick<Config, "allowedGuildIds" | "personas">;
  guildSettings: Pick<GuildSettingsStore, "get" | "personaInbox" | "setPersonaInbox">;
  topicSessions: Pick<TopicSessionStore, "hasPlaceOtherThan">;
  localPlaces: LocalPersonaPlaces;
  log: (message: string) => void;
};

/** 場所の Discord に出さない名前（断る文に使う） */
function placeName(place: ChannelPlace): string {
  return place === "local" ? "Web" : "Discord";
}

/**
 * 設定にある足した人格ごとに、望む場所（述語が true なら local、偽なら discord）と違う場所の、番号の在る入口の行（許可サーバーごと）か
 * 削除済みでない話題が 1 つでもあれば、その人格の文を 1 つ返す。揃っていれば空。設定に無い人格の行は見ない。文に番号を出さない
 */
export function checkPersonaPlaces(deps: LocalEntriesDeps): string[] {
  const { cfg, guildSettings, topicSessions, localPlaces } = deps;
  const errors: string[] = [];
  for (const persona of cfg.personas) {
    const wanted: ChannelPlace = localPlaces.isLocalPersona(persona.id) ? "local" : "discord";
    const entryDiffers = cfg.allowedGuildIds.some((guildId) => {
      const inbox = guildSettings.personaInbox(guildId, persona.id);
      return inbox !== undefined && inbox.channelId !== null && inbox.place !== wanted;
    });
    if (!entryDiffers && !topicSessions.hasPlaceOtherThan(persona.id, wanted)) continue;
    const other: ChannelPlace = wanted === "local" ? "discord" : "local";
    errors.push(
      `SELF_AGENT_PERSONA_${persona.id.toUpperCase()}_SURFACE: この人格の場所は ${placeName(other)} に在ります。` +
        "人格の場所は後から変えられません（別の id で足してください）",
    );
  }
  return errors;
}

/**
 * /setup 済みの許可サーバーごとに、述語が true の人格で入口の番号がまだ無ければ、ローカルの番号で入口の行（place local）を作る。
 * 番号が在れば何もしない。作った数を返し、1 件ごとに log（番号は出さない）
 */
export function ensureLocalEntries(deps: LocalEntriesDeps): number {
  const { cfg, guildSettings, localPlaces, log } = deps;
  let made = 0;
  for (const guildId of cfg.allowedGuildIds) {
    if (guildSettings.get(guildId) === undefined) continue;
    for (const persona of cfg.personas) {
      if (!localPlaces.isLocalPersona(persona.id)) continue;
      if ((guildSettings.personaInbox(guildId, persona.id)?.channelId ?? null) !== null) continue;
      guildSettings.setPersonaInbox(guildId, persona.id, localPlaces.ids.next(), "local");
      made += 1;
      log(`ローカルの入口を作りました（persona=${persona.id}、guild=${guildId}）`);
    }
  }
  return made;
}
