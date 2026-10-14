import { type Config, DEFAULT_PERSONA_ID } from "../config.ts";
import type { IncomingMessage } from "../discord/gateway.ts";
import type { GuildSettingsStore } from "../store/guild-settings.ts";
import type { TopicSessionStore } from "../store/topic-sessions.ts";

/** 発言を受け付けるチャンネルの種類（#inbox（足した人格の #<NAME> も）、#tasks か、/new・session_open で作ったセッション） */
export type ChannelKind = "inbox" | "tasks" | "session";

/** そのチャンネルが受け付け対象なら種類を、対象外なら null を返す */
export type ResolveChannel = (guildId: string, channelId: string) => ChannelKind | null;

/** チャンネルの持ち主の人格の id（personas.ts の PersonaRouter.ownerOf） */
export type OwnerOf = (channelId: string) => string;

/**
 * 許可したサーバー（env の SELF_AGENT_ALLOWED_GUILD_IDS）の受け付け対象のチャンネルで、オーナー本人が書いた空でない発言だけを受け付ける（DM・bot・Webhook は弾く）。
 * 全部の Bot が同じ発言を受け取るので、受け取った Bot の人格（event.persona。省略は既定の人格）がそのチャンネルの持ち主（ownerOf。省略は全部既定の人格）のときだけ受け付け、
 * それ以外の Bot の分は黙って捨てる。受け付けるならチャンネルの種類を、弾くなら null を返す
 */
export function acceptedChannel(
  event: IncomingMessage,
  cfg: Pick<Config, "allowedGuildIds" | "ownerUserId">,
  resolveChannel: ResolveChannel,
  ownerOf?: OwnerOf,
): ChannelKind | null {
  if (
    event.guildId === null ||
    !cfg.allowedGuildIds.includes(event.guildId) ||
    event.authorId !== cfg.ownerUserId ||
    event.authorIsBot ||
    event.isWebhook ||
    event.content.trim() === ""
  ) {
    return null;
  }
  // DB を引くのは他の条件をすべて満たしたときだけ
  const kind = resolveChannel(event.guildId, event.channelId);
  if (kind === null) return null;
  const owner = ownerOf?.(event.channelId) ?? DEFAULT_PERSONA_ID;
  return owner === (event.persona ?? DEFAULT_PERSONA_ID) ? kind : null;
}

/**
 * /setup 済みのサーバーは DB の #inbox、guild_settings に行が無いサーバーだけ env の SELF_AGENT_INBOX_CHANNEL_ID を #inbox とみなす（env は P3 で廃止）。
 * #tasks は /setup 済みのサーバーの DB の #tasks だけ（env の fallback には無い）。
 * 足した人格（cfg.personas）の #<NAME> は、/setup 済みのサーバーの DB のもので、その人格が今も設定にあるときだけ #inbox と同じ種類として受け付ける
 * （人格が無ければ引かない）。
 * sessions に行があり、削除済みでなく、同じサーバーのチャンネルならセッションとして受け付ける
 */
export function createChannelResolver(
  cfg: Pick<Config, "inboxChannelId"> & Partial<Pick<Config, "personas">>,
  guildSettings: Pick<GuildSettingsStore, "get" | "entryChannel">,
  topicSessions: Pick<TopicSessionStore, "get">,
): ResolveChannel {
  const personaIds = new Set((cfg.personas ?? []).map((persona) => persona.id));
  return (guildId, channelId) => {
    const settings = guildSettings.get(guildId);
    const inboxChannelId = settings === undefined ? cfg.inboxChannelId : settings.inboxChannelId;
    if (channelId === inboxChannelId) return "inbox";
    if (settings !== undefined && channelId === settings.tasksChannelId) return "tasks";
    if (settings !== undefined && personaIds.size > 0) {
      const entry = guildSettings.entryChannel(channelId);
      if (entry !== undefined && entry.guildId === guildId && entry.kind === "inbox" && personaIds.has(entry.persona)) {
        return "inbox";
      }
    }
    const session = topicSessions.get(channelId);
    return session !== undefined && session.state !== "deleted" && session.guildId === guildId ? "session" : null;
  };
}

export type SetupStatusDeps = {
  cfg: Pick<Config, "allowedGuildIds" | "inboxChannelId">;
  guildSettings: Pick<GuildSettingsStore, "get">;
  log: (message: string) => void;
};

/** 起動時に、/setup を実行していない許可サーバーを log に出す */
export function logUnconfiguredGuilds(deps: SetupStatusDeps): void {
  const { cfg, guildSettings, log } = deps;
  for (const guildId of cfg.allowedGuildIds) {
    if (guildSettings.get(guildId) !== undefined) continue;
    log(
      cfg.inboxChannelId === undefined
        ? `/setup が未実行です（guild=${guildId}）。/setup を実行するまで発言は受け付けません`
        : `/setup が未実行です（guild=${guildId}）。env の SELF_AGENT_INBOX_CHANNEL_ID を #inbox として使用中です`,
    );
  }
}
