// 足した人格の Bot の接続の状態（docs/plan/personas.md §2.2）。scheduler が起動直後と tick ごとに refresh する。
// 接続できない・戻ったが変わったときだけ log に出し、/setup 済みのサーバーの #system に既定の人格の Bot で知らせる（shell-state.ts の知らせと同じ形）。
// 最初の確かめでは、接続できないときだけ知らせる。知らせはサーバーごとに、投稿できるまで（#system が無い・失敗・時間切れ）tick ごとにやり直す。
// ログインの途中（まだ接続していないが、成功も失敗もしていない）は分からないものとして何もしない。接続できないとみなすのは、続けて
// DISCONNECTED_CHECKS 回の確かめで接続していないときだけ（ふだんの再接続で知らせない）。戻ったのは 1 回で分かる。
// 足した人格の Bot が落ちても既定の人格は動き続ける（その人格のチャンネルには答えられない）
import type { Config } from "../config.ts";
import type { Gateway, GatewayHandlers } from "../discord/gateway.ts";
import { withTimeout } from "./shell-state.ts";
import type { SystemNotifier } from "./system-notice.ts";

/** 足した人格の Bot（既定の人格は含まない。既定の人格の Bot が接続できなければ起動しない） */
export type PersonaConnection = {
  id: string;
  /** 表示名（知らせに使う） */
  name: string;
  /** Discord に接続しているか */
  connected: () => boolean;
  /** 起動時のログインが終わったか（成功・失敗・時間切れ）。終わる前に接続していなければ、まだ分からない */
  loginSettled: () => boolean;
};

/** 接続できないとみなすまでに、続けて接続していなかった確かめの回数 */
export const DISCONNECTED_CHECKS = 2;

export type PersonaStatusDeps = {
  /** 知らせを投稿するサーバー */
  cfg: Pick<Config, "allowedGuildIds">;
  personas: readonly PersonaConnection[];
  /** #system への知らせ（system-notice.ts。既定の人格の Bot） */
  notify: SystemNotifier;
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
  /** 人格ごとの、続けて接続していなかった確かめの回数（ログインの途中は数えない） */
  private readonly downChecks = new Map<string, number>();

  constructor(deps: PersonaStatusDeps) {
    this.deps = deps;
  }

  /**
   * 人格ごとに、接続しているか（ログインの途中は飛ばす。接続できないのは続けて DISCONNECTED_CHECKS 回のときだけ）が前回と変わったら
   * （最初は接続できないときだけ）log に出し、許可サーバーを全部「まだ知らせていない」に戻す。
   * まだ知らせていないサーバーのうち /setup 済みで #system があるものに投稿し、投稿できたものだけを知らせ済みにする。
   * #system が無い・投稿の失敗・時間切れ（1 回 noticeTimeoutMs）のサーバーは、状態が変わらなければ次の tick でやり直す（失敗は log に出す）。reject しない
   */
  async refresh(): Promise<void> {
    const { cfg, personas, notify, log } = this.deps;
    for (const persona of personas) {
      const now = persona.connected();
      // ログインの途中はまだ分からない
      if (!now && !persona.loginSettled()) continue;
      const downChecks = now ? 0 : (this.downChecks.get(persona.id) ?? 0) + 1;
      this.downChecks.set(persona.id, downChecks);
      let state = this.states.get(persona.id);
      // 続けて DISCONNECTED_CHECKS 回になるまでは前の状態のまま（最初の結果がまだなら何もしない）
      const connected = now ? true : downChecks >= DISCONNECTED_CHECKS ? false : state?.connected;
      if (connected === undefined) continue;
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
          const messageId = await notify(
            guildId,
            { text },
            { level: connected ? "success" : "warning", timeoutMs: this.deps.noticeTimeoutMs },
          );
          if (messageId === undefined) continue;
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
 * 足した人格の Bot を並べて start する（既定の人格の Bot の後。main は待たずに定期処理を始める）。ログインの失敗・時間切れは log に出すだけで、
 * 既定の人格は動き続ける（接続できない間は refresh が #system に知らせる。ログインはやり直さない）。
 * ログインが終わったら（成功・失敗・時間切れ）その人格の id で onSettled を呼ぶ。reject しない
 */
export async function startPersonaGateways(
  bots: ReadonlyArray<{ id: string; gateway: Pick<Gateway, "start"> }>,
  handlers: GatewayHandlers,
  log: (message: string) => void,
  options: { timeoutMs?: number; onSettled?: (id: string) => void } = {},
): Promise<void> {
  await Promise.all(
    bots.map(async ({ id, gateway }) => {
      try {
        await withTimeout(gateway.start(handlers), options.timeoutMs ?? PERSONA_LOGIN_TIMEOUT_MS);
      } catch (error) {
        log(`人格の Bot に接続できませんでした（persona=${id}）: ${describeError(error)}`);
      } finally {
        options.onSettled?.(id);
      }
    }),
  );
}
