// 足した人格の Bot の接続の状態（docs/plan/personas.md §2.2）。scheduler が起動直後と tick ごとに refresh する。
// 接続できない・戻ったが変わったときだけ log に出し、/setup 済みのサーバーの #system に既定の人格の Bot で知らせる（shell-state.ts の知らせと同じ形）。
// 最初の確かめでは、接続できないときだけ知らせる。知らせはサーバーごとに、投稿できるまで（#system が無い・失敗・時間切れ）tick ごとにやり直す。
// 足した人格の Bot が落ちても既定の人格は動き続ける（その人格のチャンネルには答えられない）
import type { Config } from "../config.ts";
import type { Gateway, GatewayHandlers } from "../discord/gateway.ts";
import type { GuildSettingsStore } from "../store/guild-settings.ts";
import { SHELL_NOTICE_TIMEOUT_MS, withTimeout } from "./shell-state.ts";

/** 足した人格の Bot（既定の人格は含まない。既定の人格の Bot が接続できなければ起動しない） */
export type PersonaConnection = {
  id: string;
  /** 表示名（知らせに使う） */
  name: string;
  /** Discord に接続しているか */
  connected: () => boolean;
};

export type PersonaStatusDeps = {
  /** 知らせを投稿するサーバー */
  cfg: Pick<Config, "allowedGuildIds">;
  personas: readonly PersonaConnection[];
  /** 知らせの投稿先（#system） */
  guildSettings: Pick<GuildSettingsStore, "get">;
  /** 既定の人格の Bot */
  gateway: Pick<Gateway, "sendMessage">;
  log: (message: string) => void;
  /** 既定は SHELL_NOTICE_TIMEOUT_MS */
  noticeTimeoutMs?: number;
};

/** 足した人格の Bot に接続できなくなった知らせの本文 */
export function personaDisconnectedNotice(name: string): string {
  return `${name} の Bot に接続できません`;
}

/** 足した人格の Bot に接続できるようになった知らせの本文 */
export function personaReconnectedNotice(name: string): string {
  return `${name} の Bot に接続しました`;
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export class PersonaStatus {
  private readonly deps: PersonaStatusDeps;
  /** 人格ごとの、知らせる対象の状態（接続しているか）と、まだ知らせられていないサーバー。最初の確かめの前は無い */
  private readonly states = new Map<string, { connected: boolean; pending: Set<string> }>();

  constructor(deps: PersonaStatusDeps) {
    this.deps = deps;
  }

  /**
   * 人格ごとに、接続しているかが前回と変わったら（最初は接続できないときだけ）log に出し、許可サーバーを全部「まだ知らせていない」に戻す。
   * まだ知らせていないサーバーのうち /setup 済みで #system があるものに投稿し、投稿できたものだけを知らせ済みにする。
   * #system が無い・投稿の失敗・時間切れ（1 回 noticeTimeoutMs）のサーバーは、状態が変わらなければ次の tick でやり直す（失敗は log に出す）。reject しない
   */
  async refresh(): Promise<void> {
    const { cfg, personas, guildSettings, gateway, log } = this.deps;
    for (const persona of personas) {
      const connected = persona.connected();
      let state = this.states.get(persona.id);
      if (state === undefined || state.connected !== connected) {
        const first = state === undefined;
        if (!first || !connected) {
          log(connected ? `人格の Bot に接続しました（persona=${persona.id}）` : `人格の Bot に接続できません（persona=${persona.id}）`);
        }
        state = { connected, pending: first && connected ? new Set() : new Set(cfg.allowedGuildIds) };
        this.states.set(persona.id, state);
      }
      const text = connected ? personaReconnectedNotice(persona.name) : personaDisconnectedNotice(persona.name);
      for (const guildId of [...state.pending]) {
        try {
          const systemChannelId = guildSettings.get(guildId)?.systemChannelId ?? null;
          if (systemChannelId === null) continue;
          await withTimeout(gateway.sendMessage(systemChannelId, { text }), this.deps.noticeTimeoutMs ?? SHELL_NOTICE_TIMEOUT_MS);
          state.pending.delete(guildId);
        } catch (error) {
          log(`人格の Bot の接続の知らせの投稿に失敗しました（guild=${guildId}、persona=${persona.id}）: ${describeError(error)}`);
        }
      }
    }
  }
}

/** 足した人格の Bot のログインを待つ上限（止まったログインで起動を止めない。時間切れの後に接続できれば、次の tick で知らせが戻る） */
export const PERSONA_LOGIN_TIMEOUT_MS = 60_000;

/**
 * 足した人格の Bot を並べて start する（既定の人格の Bot の後）。ログインの失敗・時間切れは log に出すだけで、既定の人格は動き続ける
 * （接続できない間は refresh が #system に知らせる。ログインはやり直さない）。reject しない
 */
export async function startPersonaGateways(
  bots: ReadonlyArray<{ id: string; gateway: Pick<Gateway, "start"> }>,
  handlers: GatewayHandlers,
  log: (message: string) => void,
  timeoutMs: number = PERSONA_LOGIN_TIMEOUT_MS,
): Promise<void> {
  await Promise.all(
    bots.map(async ({ id, gateway }) => {
      try {
        await withTimeout(gateway.start(handlers), timeoutMs);
      } catch (error) {
        log(`人格の Bot に接続できませんでした（persona=${id}）: ${describeError(error)}`);
      }
    }),
  );
}
