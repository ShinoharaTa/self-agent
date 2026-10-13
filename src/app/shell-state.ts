// シェル（Bash）を使えるかの状態（docs/plan/shell.md §4）。SELF_AGENT_SHELL=1 のときだけ、main が起動時に check し、scheduler が tick ごとに refresh する。
// 結果が変わったとき（通る・通らない、通らない項目）だけ log に出し、通る・通らないが変わったときだけ /setup 済みのサーバーの #system に知らせる。
// 最初の診断の後は、通らないときだけ知らせる。知らせはサーバーごとに、投稿できるまで（#system が無い・失敗・時間切れ）tick ごとにやり直す。
// 診断が通るまで（未設定・診断前・失敗）は enabled() が false（fail-closed）
import type { SandboxCheckResult } from "../agent/sandbox-check.ts";
import type { Config } from "../config.ts";
import type { Gateway } from "../discord/gateway.ts";
import type { GuildSettingsStore } from "../store/guild-settings.ts";

/** 知らせの 1 回の投稿を待つ上限（止まった投稿で tick を止めない） */
export const SHELL_NOTICE_TIMEOUT_MS = 10_000;

/** 診断そのものが例外で終わったときの項目 */
export const SHELL_CHECK_ERROR_ITEM = "自己診断に失敗した";

/** SELF_AGENT_SHELL=1 のときだけ scheduler の tick に渡す自己診断。無効なら undefined（診断も log も投稿もしない） */
export function shellRefresher(
  cfg: Pick<Config, "shell">,
  state: Pick<ShellState, "refresh">,
): (() => Promise<void>) | undefined {
  return cfg.shell ? () => state.refresh() : undefined;
}

export type ShellStateDeps = {
  /** 知らせを投稿するサーバー */
  cfg: Pick<Config, "allowedGuildIds">;
  /** 自己診断（agent/sandbox-check.ts の checkSandbox） */
  check: () => Promise<SandboxCheckResult>;
  /** 知らせの投稿先（#system） */
  guildSettings: Pick<GuildSettingsStore, "get">;
  gateway: Pick<Gateway, "sendMessage">;
  log: (message: string) => void;
  /** 既定は SHELL_NOTICE_TIMEOUT_MS */
  noticeTimeoutMs?: number;
};

/** 自己診断が通らなくなった知らせの本文 */
export function shellDisabledNotice(failed: readonly string[]): string {
  return `シェル（Bash）を使えない状態です: ${failed.join("、")}`;
}

/** 自己診断が通るようになった知らせの本文 */
export const SHELL_RESUMED_NOTICE = "シェル（Bash）の自己診断が通りました";

/** promise を ms で打ち切る（時間切れは reject。元の投稿は止められないので、後から届くことはある） */
async function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${ms} ms で終わりませんでした`)), ms);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/** 結果の比べ方。通る・通らないと、通らない項目の集合（順序は見ない） */
function resultKey(result: SandboxCheckResult): string {
  return result.ok ? "ok" : JSON.stringify([...result.failed].sort());
}

export class ShellState {
  private readonly deps: ShellStateDeps;
  /** 直近の診断の結果。診断前は undefined */
  private current: SandboxCheckResult | undefined;
  /** 知らせる対象の状態（通る・通らない）。最初の知らせの前は undefined */
  private announced: boolean | undefined;
  /** announced をまだ知らせられていないサーバー。投稿できたものから除く */
  private pending = new Set<string>();

  constructor(deps: ShellStateDeps) {
    this.deps = deps;
  }

  /** 直近の診断が通っていれば true。診断前は false */
  enabled(): boolean {
    return this.current?.ok === true;
  }

  /** 診断して状態を更新し、結果（通る・通らない、通らない項目の集合）が変わったとき（最初の結果を含む）だけ log に出す。reject しない */
  async check(): Promise<void> {
    let result: SandboxCheckResult;
    try {
      result = await this.deps.check();
    } catch {
      result = { ok: false, failed: [SHELL_CHECK_ERROR_ITEM] };
    }
    const changed = this.current === undefined || resultKey(this.current) !== resultKey(result);
    this.current = result;
    if (!changed) return;
    this.deps.log(result.ok ? "シェルの自己診断が通りました" : `シェルの自己診断が通りません（${result.failed.join("、")}）`);
  }

  /**
   * 通る・通らない（項目は見ない）が前回と変わったら、許可サーバーを全部「まだ知らせていない」に戻す（最初は通らないときだけ）。
   * まだ知らせていないサーバーのうち /setup 済みで #system があるものに投稿し、投稿できたものだけを知らせ済みにする。
   * #system が無い・投稿の失敗・時間切れ（1 回 noticeTimeoutMs）のサーバーは、状態が変わらなければ次の tick でやり直す（失敗は log に出す）。reject しない
   */
  async announce(): Promise<void> {
    const { cfg, guildSettings, gateway, log } = this.deps;
    const current = this.current;
    if (current === undefined) return;
    if (this.announced !== current.ok) {
      const first = this.announced === undefined;
      this.announced = current.ok;
      this.pending = first && current.ok ? new Set() : new Set(cfg.allowedGuildIds);
    }
    const text = current.ok ? SHELL_RESUMED_NOTICE : shellDisabledNotice(current.failed);
    for (const guildId of [...this.pending]) {
      try {
        const systemChannelId = guildSettings.get(guildId)?.systemChannelId ?? null;
        if (systemChannelId === null) continue;
        await withTimeout(gateway.sendMessage(systemChannelId, { text }), this.deps.noticeTimeoutMs ?? SHELL_NOTICE_TIMEOUT_MS);
        this.pending.delete(guildId);
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
