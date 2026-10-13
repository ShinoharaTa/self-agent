// シェル（Bash）を使えるかの状態（docs/plan/shell.md §4）。SELF_AGENT_SHELL=1 のときだけ、main が起動時に check し、scheduler が tick ごとに refresh する。
// 状態が変わったときだけ log に出し、/setup 済みのサーバーの #system に知らせる。最初の診断の後は、使えないときだけ知らせる。
// 診断が通るまで（未設定・診断前・失敗）は enabled() が false（fail-closed）
import type { SandboxCheckResult } from "../agent/sandbox-check.ts";
import type { Config } from "../config.ts";
import type { Gateway } from "../discord/gateway.ts";
import type { GuildSettingsStore } from "../store/guild-settings.ts";

/** 診断そのものが例外で終わったときの項目 */
export const SHELL_CHECK_ERROR_ITEM = "自己診断に失敗した";

export type ShellStateDeps = {
  /** 知らせを投稿するサーバー */
  cfg: Pick<Config, "allowedGuildIds">;
  /** 自己診断（agent/sandbox-check.ts の checkSandbox） */
  check: () => Promise<SandboxCheckResult>;
  /** 知らせの投稿先（#system） */
  guildSettings: Pick<GuildSettingsStore, "get">;
  gateway: Pick<Gateway, "sendMessage">;
  log: (message: string) => void;
};

/** 止めた知らせの本文 */
export function shellDisabledNotice(failed: readonly string[]): string {
  return `シェル（Bash）を止めています: ${failed.join("、")}`;
}

/** 再開した知らせの本文 */
export const SHELL_RESUMED_NOTICE = "シェル（Bash）を再開しました";

export class ShellState {
  private readonly deps: ShellStateDeps;
  /** 直近の診断の結果。診断前は undefined */
  private current: SandboxCheckResult | undefined;
  /** 直近に #system に知らせた（知らせないと決めた）状態。最初の知らせの前は undefined */
  private announced: boolean | undefined;

  constructor(deps: ShellStateDeps) {
    this.deps = deps;
  }

  /** 直近の診断が通っていれば true。診断前は false */
  enabled(): boolean {
    return this.current?.ok === true;
  }

  /** 診断して状態を更新し、変わったとき（最初の結果を含む）だけ log に出す。reject しない */
  async check(): Promise<void> {
    let result: SandboxCheckResult;
    try {
      result = await this.deps.check();
    } catch {
      result = { ok: false, failed: [SHELL_CHECK_ERROR_ITEM] };
    }
    const changed = this.current === undefined || this.current.ok !== result.ok;
    this.current = result;
    if (!changed) return;
    this.deps.log(result.ok ? "Bash を有効にしました" : `Bash を無効にしました（${result.failed.join("、")}）`);
  }

  /**
   * 前回知らせた状態と今の状態が違えば、/setup 済みのサーバーの #system に 1 回ずつ投稿する。
   * 最初は使えないときだけ投稿する。投稿の失敗は log だけで、やり直さない。reject しない
   */
  async announce(): Promise<void> {
    const { cfg, guildSettings, gateway, log } = this.deps;
    const current = this.current;
    if (current === undefined) return;
    const previous = this.announced;
    if (previous === current.ok) return;
    this.announced = current.ok;
    if (previous === undefined && current.ok) return;
    const text = current.ok ? SHELL_RESUMED_NOTICE : shellDisabledNotice(current.failed);
    for (const guildId of cfg.allowedGuildIds) {
      try {
        const systemChannelId = guildSettings.get(guildId)?.systemChannelId ?? null;
        if (systemChannelId === null) continue;
        await gateway.sendMessage(systemChannelId, { text });
      } catch (error) {
        log(`シェルの状態の知らせの投稿に失敗しました（guild=${guildId}）: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }

  /** 診断して、変わっていれば知らせる（scheduler の tick） */
  async refresh(): Promise<void> {
    await this.check();
    await this.announce();
  }
}
