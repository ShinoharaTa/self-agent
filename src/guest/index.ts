// ゲスト利用の簡易モードの配線（docs/plan/guest-mode.md。SELF_AGENT_GUEST_* が揃ったときだけ main が呼ぶ）。
// ゲスト専用の Bot（SELF_AGENT_GUEST_DISCORD_TOKEN）を既存の DiscordGateway で動かし、既定の人格の層（PersonaRouter・access.ts・interactions.ts）には入れない。
// /guest はゲストのサーバーのうち参加しているものにだけ登録する。Bot がサーバーから外されたら（と起動時に参加していなければ）そのサーバーの有効な
// チャンネルを無効にして、オーナーの #system に知らせる。PR-GU1 では発言に答えない（受付判定にかかわらず黙って捨てる）
import { registerCommands } from "../app/interactions.ts";
import { PERSONA_LOGIN_TIMEOUT_MS } from "../app/persona-status.ts";
import { withTimeout } from "../app/shell-state.ts";
import { RESTARTING_REPLY } from "../app/shutdown.ts";
import type { Config } from "../config.ts";
import { DiscordGateway } from "../discord/discord-gateway.ts";
import type { Gateway, GatewayHandlers } from "../discord/gateway.ts";
import type { GuestStore } from "../store/guest.ts";
import type { GuildSettingsStore } from "../store/guild-settings.ts";
import type { SdkSessionStore } from "../store/sdk-sessions.ts";
import { createGuestCommand } from "./commands/guest.ts";
import { GUEST_PERSONA_ID } from "./constants.ts";
import { createGuestInteractionHandler } from "./interactions.ts";
import { createGuestNotifier, guestLeftNotice, guestNotJoinedNotice } from "./notify.ts";

/** ゲストの層が使う Gateway の部分 */
export type GuestGateway = Pick<Gateway, "start" | "stop" | "isInGuild" | "registerGuildCommands">;

export type StartGuestDeps = {
  cfg: Pick<
    Config,
    "allowedGuildIds" | "ownerUserId" | "timeZone" | "guestGuildIds" | "guestTokenEnv" | "guestTurnsPerDay"
  >;
  guest: GuestStore;
  sessions: Pick<SdkSessionStore, "delete">;
  /** 知らせの投稿先（オーナーのサーバーの #system） */
  guildSettings: Pick<GuildSettingsStore, "get">;
  /** 既定の人格の Bot（PersonaRouter の admin）。#system への知らせに使う */
  adminGateway: Pick<Gateway, "sendMessage">;
  /** 停止を始めたか（shutdown.ts）。始めた後の /guest には「再起動中です」だけを返す */
  stopping: () => boolean;
  now: () => Date;
  log: (message: string) => void;
  /** テスト用。既定は DiscordGateway（persona guest・トークンは cfg.guestTokenEnv） */
  createGateway?: (onGuildLeave: (guildId: string) => void) => GuestGateway;
  /** 既定は PERSONA_LOGIN_TIMEOUT_MS */
  loginTimeoutMs?: number;
};

export type GuestLayer = {
  /** ログイン → 参加していないサーバーの行の無効化 → /guest の登録が終わったら resolve する（ログインの失敗・時間切れを含む）。reject しない */
  ready: Promise<void>;
  /** 受け付けた /guest の処理と、外されたときの知らせが終わるのを待つ（停止の待ち。shutdown.ts の queues に渡す） */
  idle: () => Promise<void>;
  stop: () => Promise<void>;
};

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** ゲスト Bot を作り、待たずにログインを始める */
export function startGuest(deps: StartGuestDeps): GuestLayer {
  const { cfg, guest, stopping, log } = deps;
  const inFlight = new Set<Promise<void>>();
  const track = (promise: Promise<void>): void => {
    const settled = promise.then(
      () => undefined,
      (error: unknown) => log(`guest: 処理に失敗しました: ${describeError(error)}`),
    );
    inFlight.add(settled);
    void settled.then(() => inFlight.delete(settled));
  };

  const notify = createGuestNotifier({ cfg, guildSettings: deps.guildSettings, gateway: deps.adminGateway, log });
  const command = createGuestCommand({ cfg, guest, sessions: deps.sessions, notify, now: deps.now, log });
  const handleInteraction = createGuestInteractionHandler({ cfg, command, log });

  const onGuildLeave = (guildId: string): void => {
    if (!cfg.guestGuildIds.includes(guildId)) {
      log(`guest: ゲストのサーバーでないサーバーから外されました（guild=${guildId}）`);
      return;
    }
    track(
      (async () => {
        const disabled = guest.disableGuild(guildId, "left");
        log(`guest: サーバーから外されたため、有効なチャンネル ${disabled} 件を無効にしました（guild=${guildId}）`);
        await notify(guestLeftNotice(guildId, disabled));
      })(),
    );
  };

  const gateway =
    deps.createGateway?.(onGuildLeave) ??
    new DiscordGateway(cfg.guestGuildIds, { persona: GUEST_PERSONA_ID, tokenEnv: cfg.guestTokenEnv, onGuildLeave });

  const handlers: GatewayHandlers = {
    // PR-GU1 では答えない（log も出さない）
    onMessage: () => {},
    onInteraction: (interaction, responder) => {
      if (!stopping()) {
        track(handleInteraction(interaction, responder));
        return;
      }
      // ゲストのサーバーの外・DM には、通常どおり応答もしない
      if (interaction.guildId === null || !cfg.guestGuildIds.includes(interaction.guildId)) return;
      track(responder.reply({ text: RESTARTING_REPLY, ephemeral: true }));
    },
  };

  const start = async (): Promise<void> => {
    const login = gateway.start(handlers);
    // ログインが終わったか（時間切れと、ログインの失敗を分ける）
    let loginSettled = false;
    login.then(
      () => {
        loginSettled = true;
      },
      () => {
        loginSettled = true;
      },
    );
    try {
      await withTimeout(login, deps.loginTimeoutMs ?? PERSONA_LOGIN_TIMEOUT_MS);
    } catch (error) {
      log(`guest: ゲスト Bot に接続できませんでした: ${describeError(error)}`);
      // 時間切れの後にログインできても、参加の確かめと /guest の登録はやり直さない
      if (!loginSettled) log("guest: ログインが時間切れになったため、参加の確かめと /guest の登録を行っていません");
      return;
    }
    // 止まっていた間に外されたサーバー: 参加していなければ、そのサーバーの有効なチャンネルを無効にする
    for (const guildId of cfg.guestGuildIds) {
      try {
        if (gateway.isInGuild(guildId)) continue;
        const disabled = guest.disableGuild(guildId, "startup");
        if (disabled === 0) continue;
        log(`guest: 参加していないサーバーのため、有効なチャンネル ${disabled} 件を無効にしました（guild=${guildId}）`);
        await notify(guestNotJoinedNotice(guildId, disabled));
      } catch (error) {
        log(`guest: 参加の確かめに失敗しました（guild=${guildId}）: ${describeError(error)}`);
      }
    }
    await registerCommands({
      cfg: { allowedGuildIds: cfg.guestGuildIds },
      gateway,
      commands: [command],
      log: (message) => log(`guest: ${message}`),
    });
  };

  return {
    ready: start().catch((error: unknown) => log(`guest: 起動の処理に失敗しました: ${describeError(error)}`)),
    idle: async () => {
      // 待っている間に増えた分も待つ
      while (inFlight.size > 0) await Promise.all([...inFlight]);
    },
    stop: () => gateway.stop(),
  };
}
