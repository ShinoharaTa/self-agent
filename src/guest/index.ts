// ゲスト利用の簡易モードの配線（docs/plan/guest-mode.md。SELF_AGENT_GUEST_* が揃ったときだけ main が呼ぶ）。
// ゲスト専用の Bot（SELF_AGENT_GUEST_DISCORD_TOKEN）を既存の DiscordGateway で動かし、既定の人格の層（PersonaRouter・access.ts・interactions.ts）には入れない。
// サーバーの許可は DB（guest_guilds）で持つ。起動時に参加しているサーバーに定型文（notice.ts。未投稿のサーバーだけ）を投稿し、参加していない許可済みの
// サーバーは取り消してそのサーバーの有効なチャンネルを無効にし、参加しているサーバー（メインのサーバーを除く）に /guest を登録する。新しく入ったサーバーにも
// 定型文を投稿してから /guest を登録する。Bot がサーバーから外されたときも許可済みなら取り消して、オーナーの #system に知らせる。
// 定型文への返信（同じチャンネル）は activation.ts の有効化に渡し、それ以外の発言は受付判定（access.ts）を通ったものだけを handler.ts のターンに渡す
import type { AgentRunner } from "../agent/runner.ts";
import { registerCommands } from "../app/interactions.ts";
import { PERSONA_LOGIN_TIMEOUT_MS } from "../app/persona-status.ts";
import { withTimeout } from "../app/shell-state.ts";
import { RESTARTING_REPLY } from "../app/shutdown.ts";
import type { Config } from "../config.ts";
import { DiscordGateway } from "../discord/discord-gateway.ts";
import type { Gateway, GatewayHandlers } from "../discord/gateway.ts";
import type { GuestStore } from "../store/guest.ts";
import { type GuestGuildStore, isGuestGuildAllowed } from "../store/guest-guilds.ts";
import type { GuestInviteStore } from "../store/guest-invites.ts";
import type { GuildSettingsStore } from "../store/guild-settings.ts";
import type { SdkSessionStore } from "../store/sdk-sessions.ts";
import type { UsageStore } from "../store/usage.ts";
import { acceptsGuestMessage } from "./access.ts";
import { createGuestActivation } from "./activation.ts";
import type { GuestAdmin } from "./commands/admin.ts";
import { createGuestCommand } from "./commands/guest.ts";
import { GUEST_PERSONA_ID } from "./constants.ts";
import { createGuestHandler } from "./handler.ts";
import { createGuestInteractionHandler } from "./interactions.ts";
import { buildGuestNoticeText, createGuestOnboarding } from "./notice.ts";
import { createGuestNotifier, guestLeftNotice, guestNotJoinedNotice } from "./notify.ts";

/** ゲストの層が使う Gateway の部分。selfUserId はゲスト Bot のユーザー ID（ログイン前は undefined） */
export type GuestGateway = Pick<
  Gateway,
  "start" | "stop" | "isInGuild" | "registerGuildCommands" | "send" | "sendMessage" | "messageExists" | "startTyping"
> & {
  selfUserId(): string | undefined;
  /** 参加しているサーバーの ID（DiscordGateway.listGuildIds） */
  listGuildIds(): string[];
  /** 定型文の投稿先の候補（DiscordGateway.findNoticeChannels） */
  findNoticeChannels(guildId: string): Promise<string[]>;
  /** そのサーバーのメンバーが Manage Server を持つか（DiscordGateway.memberCanManageGuild。REST 1 回。失敗・いない・権限なしは false） */
  memberCanManageGuild(guildId: string, userId: string): Promise<boolean>;
};

export type { GuestAdmin } from "./commands/admin.ts";

export type GuestLayerDeps = {
  cfg: Pick<
    Config,
    | "allowedGuildIds"
    | "ownerUserId"
    | "timeZone"
    | "guestTokenEnv"
    | "guestTurnsPerDay"
    | "guestUserTurnsPerDay"
    | "guestMaxConcurrent"
    | "guestSessionMaxTurns"
    | "guestSessionMaxInputTokens"
  >;
  guest: GuestStore;
  /** ゲストのサーバーと許可の状態（guest_guilds） */
  guilds: GuestGuildStore;
  /** 認証コード（guest_invites） */
  invites: Pick<GuestInviteStore, "issue" | "redeem" | "supersedeAll" | "activeFor" | "listActive">;
  /** ゲストのチャンネルの SDK セッション（key `guest:<channelId>`） */
  sessions: Pick<SdkSessionStore, "get" | "set" | "delete">;
  /** ゲストの runner（query-options.ts の createGuestRunner） */
  runner: AgentRunner;
  /** ゲストのターンの usage_log */
  usage: UsageStore;
  /** 知らせの投稿先（オーナーのサーバーの #system） */
  guildSettings: Pick<GuildSettingsStore, "get">;
  /** 既定の人格の Bot（PersonaRouter の admin）。#system への知らせに使う */
  adminGateway: Pick<Gateway, "sendMessage">;
  now: () => Date;
  log: (message: string) => void;
  /** テスト用。既定は DiscordGateway（persona guest・トークンは cfg.guestTokenEnv） */
  createGateway?: (onGuildLeave: (guildId: string) => void, onGuildJoin: (guildId: string) => void) => GuestGateway;
  /** 既定は PERSONA_LOGIN_TIMEOUT_MS */
  loginTimeoutMs?: number;
};

export type GuestLayer = {
  /** /guests（メインサーバー。commands/admin.ts）が使う操作 */
  admin: GuestAdmin;
  /**
   * 待たずにログインを始め、ログイン → 起動時の sweep → /guest の登録が終わったら resolve する（ログインの失敗・時間切れを含む）。reject しない。
   * stopping は停止を始めたか（shutdown.ts）で、始めた後の /guest には「再起動中です」だけを返す。2 回目以降は最初の Promise を返す
   */
  start: (stopping: () => boolean) => Promise<void>;
  /** 受け付けた /guest の処理・ゲストのターン（返事まで）・有効化の返信と、参加・外されたときの処理が終わるのを待つ（停止の待ち。shutdown.ts の queues に渡す） */
  idle: () => Promise<void>;
  /** start していなければ何もしない */
  stop: () => Promise<void>;
};

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** ゲスト Bot と、その操作・ターンの処理を作る（ログインは start で始める） */
export function createGuestLayer(deps: GuestLayerDeps): GuestLayer {
  const { cfg, guest, guilds, log } = deps;
  let stopping: () => boolean = () => false;
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
  const command = createGuestCommand({ cfg, guest, guilds, sessions: deps.sessions, notify, now: deps.now, log });
  const handleInteraction = createGuestInteractionHandler({ guilds, command, log });

  // 外された（GuildDelete）: 許可済みなら取り消し・チャンネルの無効化・定型文の記録の消去と #system。未許可の行は記録の消去だけ
  const onGuildLeave = (guildId: string): void => {
    track(
      (async () => {
        const row = guilds.get(guildId);
        if (row === undefined) {
          log(`guest: ゲストのサーバーでないサーバーから外されました（guild=${guildId}）`);
          return;
        }
        if (!isGuestGuildAllowed(row)) {
          guilds.clearNotice(guildId);
          log(`guest: 許可していないサーバーから外されました（guild=${guildId}）`);
          return;
        }
        guilds.revoke(guildId, "left", deps.now());
        const disabled = guest.disableGuild(guildId, "left");
        guilds.clearNotice(guildId);
        log(`guest: サーバーから外されたため、許可を取り消し、有効なチャンネル ${disabled} 件を無効にしました（guild=${guildId}）`);
        await notify(guestLeftNotice(guildId, disabled));
      })(),
    );
  };

  // 新しく入った（GuildCreate。再起動・再接続では鳴らない）: 定型文を投稿してから、そのサーバーに /guest を 1 回登録する（参加の経路の登録）
  const onGuildJoin = (guildId: string): void => {
    // メインのサーバーはゲストのサーバーにしない。停止を始めた後は何もしない（次の起動の sweep が拾う）
    if (cfg.allowedGuildIds.includes(guildId)) {
      log(`guest: メインのサーバーに参加しています（guild=${guildId}）`);
      return;
    }
    if (stopping()) return;
    track(
      (async () => {
        log(`guest: サーバーに参加しました（guild=${guildId}）`);
        try {
          await onboardGuild(guildId);
        } catch (error) {
          log(`guest: 案内の投稿に失敗しました（guild=${guildId}）: ${describeError(error)}`);
        }
        try {
          await gateway.registerGuildCommands(guildId, [command.def]);
          log(`guest: コマンドを登録しました（guild=${guildId}、1 件）`);
        } catch (error) {
          log(`guest: コマンドの登録に失敗しました（guild=${guildId}）: ${describeError(error)}`);
        }
      })(),
    );
  };

  // 許可は DB で持つので、許可していないサーバーへの参加の警告は出さない
  const gateway =
    deps.createGateway?.(onGuildLeave, onGuildJoin) ??
    new DiscordGateway([], {
      persona: GUEST_PERSONA_ID,
      tokenEnv: cfg.guestTokenEnv,
      onGuildLeave,
      onGuildJoin,
      warnOnUnlistedGuild: false,
    });

  // 定型文の本文は起動時に 1 回作る
  const onboardGuild = createGuestOnboarding({
    guilds,
    gateway,
    noticeText: buildGuestNoticeText(cfg),
    notify,
    now: deps.now,
    log,
  });
  const activation = createGuestActivation({
    cfg,
    invites: deps.invites,
    guest,
    sessions: deps.sessions,
    gateway,
    notify,
    now: deps.now,
    log,
  });
  const admin: GuestAdmin = {
    cfg,
    invites: deps.invites,
    guilds,
    guest,
    gateway,
    onboardGuild,
    notify,
    now: deps.now,
  };

  const turns = createGuestHandler({
    cfg,
    guest,
    sessions: deps.sessions,
    usage: deps.usage,
    runner: deps.runner,
    gateway,
    now: deps.now,
    log,
  });

  const handlers: GatewayHandlers = {
    // 定型文への返信（同じチャンネル）は有効化に渡す（会話としては扱わない）。
    // それ以外で受付判定（docs/plan/guest-mode.md §3.2 の 5 条件）を通らない発言と、停止を始めた後の発言は黙って捨てる（log も出さない）
    onMessage: (message) => {
      if (stopping()) return;
      const botUserId = gateway.selfUserId();
      // 判定（DB の読み）が投げたら受け付けない（fail-closed。discord.js のリスナーの外に例外を出さない）
      let accepted = false;
      try {
        if (message.guildId !== null && message.replyToMessageId !== undefined) {
          const row = guilds.get(message.guildId);
          if (
            row !== undefined &&
            row.noticeMessageId !== null &&
            row.noticeMessageId === message.replyToMessageId &&
            row.noticeChannelId === message.channelId
          ) {
            track(activation.handleReply(message));
            return;
          }
        }
        const guildAllowed = message.guildId !== null && guilds.isAllowed(message.guildId);
        const channel = guest.get(message.channelId);
        accepted = acceptsGuestMessage({ message, guildAllowed, channel, botUserId });
      } catch {
        log("guest: 発言の受付判定に失敗したため捨てました");
        return;
      }
      if (!accepted) return;
      track(turns.handleMessage(message, botUserId));
    },
    onInteraction: (interaction, responder) => {
      if (!stopping()) {
        track(handleInteraction(interaction, responder));
        return;
      }
      // ゲストのサーバーの外（参加した記録の無いサーバー）・DM には、通常どおり応答もしない
      if (interaction.guildId === null || guilds.get(interaction.guildId) === undefined) return;
      track(responder.reply({ text: RESTARTING_REPLY, ephemeral: true }));
    },
  };

  /** 起動時の sweep（docs/plan/guest-mode.md §3.2.7 の 1〜4） */
  const sweep = async (): Promise<void> => {
    const joined = new Set(gateway.listGuildIds());
    const guestGuildIds: string[] = [];
    for (const guildId of joined) {
      // 同じサーバーに既定の Bot とゲスト Bot を置かない前提。メインのサーバーはゲストのサーバーにしない
      if (cfg.allowedGuildIds.includes(guildId)) {
        log(`guest: メインのサーバーに参加しています（guild=${guildId}）`);
        continue;
      }
      guestGuildIds.push(guildId);
      // 行を作り、定型文が未投稿（行が無い・投稿できていない・外されて戻った）なら投稿する
      try {
        await onboardGuild(guildId);
      } catch (error) {
        log(`guest: 参加の記録・案内の投稿に失敗しました（guild=${guildId}）: ${describeError(error)}`);
      }
    }
    // 止まっていた間に外されたサーバー: 許可済みなら取り消し、そのサーバーの有効なチャンネルを無効にする。未許可の行は定型文の記録を消すだけ
    let rows: ReturnType<GuestGuildStore["list"]> = [];
    try {
      rows = guilds.list();
    } catch (error) {
      log(`guest: ゲストのサーバーの一覧を読めませんでした: ${describeError(error)}`);
    }
    for (const row of rows) {
      if (joined.has(row.guildId)) continue;
      try {
        if (!isGuestGuildAllowed(row)) {
          if (row.noticeMessageId !== null || row.noticeChannelId !== null || row.noticePostedAt !== null) {
            guilds.clearNotice(row.guildId);
            log(`guest: 参加していない（許可していない）サーバーの案内の記録を消しました（guild=${row.guildId}）`);
          }
          continue;
        }
        guilds.revoke(row.guildId, "left", deps.now());
        const disabled = guest.disableGuild(row.guildId, "startup");
        guilds.clearNotice(row.guildId);
        log(`guest: 参加していないサーバーのため、許可を取り消し、有効なチャンネル ${disabled} 件を無効にしました（guild=${row.guildId}）`);
        await notify(guestNotJoinedNotice(row.guildId, disabled));
      } catch (error) {
        log(`guest: 参加の確かめに失敗しました（guild=${row.guildId}）: ${describeError(error)}`);
      }
    }
    // 参加している全サーバー（メインのサーバーを除く。未許可のサーバーでも「まだ有効になっていません」を返せるように）に /guest を登録する
    await registerCommands({
      cfg: { allowedGuildIds: guestGuildIds },
      gateway,
      commands: [command],
      log: (message) => log(`guest: ${message}`),
    });
  };

  const run = async (): Promise<void> => {
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
    await sweep();
  };

  let started: Promise<void> | undefined;
  return {
    admin,
    start: (isStopping) => {
      if (started !== undefined) return started;
      stopping = isStopping;
      started = run().catch((error: unknown) => log(`guest: 起動の処理に失敗しました: ${describeError(error)}`));
      return started;
    },
    idle: async () => {
      // 待っている間に増えた分も待つ
      while (inFlight.size > 0) await Promise.all([...inFlight]);
      await turns.idle();
    },
    stop: async () => {
      if (started === undefined) return;
      await gateway.stop();
    },
  };
}
