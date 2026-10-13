// シェル（Bash）の sandbox の自己診断（docs/plan/shell.md §4）。LLM は使わない。SELF_AGENT_SHELL=1 のとき起動時と tick ごとに app/shell-state.ts が呼ぶ。
// 失敗した項目は短い日本語で返す（log・#system に出すので、パス・ホスト名は入れない）
import { spawn } from "node:child_process";
import { accessSync, constants, statSync } from "node:fs";
import { delimiter, dirname, isAbsolute, join, resolve, sep } from "node:path";
import { resolveRealPath } from "./file-access.ts";

/** Bash の子プロセスの PATH のうち、node の bin の後ろに続ける OS のディレクトリ（§2.4） */
export const SHELL_SYSTEM_PATH_DIRS: readonly string[] = ["/usr/local/bin", "/usr/bin", "/bin"];

/** bwrap の probe（§4 の 2）。userns・ネット名前空間・loopback・PID 名前空間を作れるか */
export const BWRAP_PROBE_ARGS: readonly string[] = [
  "--unshare-user",
  "--unshare-net",
  "--unshare-pid",
  "--die-with-parent",
  "--ro-bind",
  "/",
  "/",
  "--proc",
  "/proc",
  "--dev",
  "/dev",
  "/bin/true",
];

/** probe の打ち切りまでのミリ秒 */
export const BWRAP_PROBE_TIMEOUT_MS = 5000;

/** 失敗した項目（log と #system に出す） */
export const SANDBOX_CHECK_ITEMS = {
  bwrapMissing: "bwrap が見つからない",
  socatMissing: "socat が見つからない",
  probeFailed: "bwrap で sandbox を作れない",
  probeTimeout: "bwrap の確認が時間内に終わらない",
  placesOverlap: "作業ディレクトリが他の場所と重なっている",
  sameFilesystem: "作業ディレクトリが別のファイルシステムでない",
} as const;

export type SandboxCheckResult = { ok: true } | { ok: false; failed: string[] };

/** probe の終わり方。起動できなかった（spawn の error）は error */
export type ProbeResult = { kind: "exited"; code: number | null } | { kind: "timeout" } | { kind: "error" };

/** probe を実行する関数。テストでは偽物に差し替える */
export type RunProbe = (
  file: string,
  args: readonly string[],
  options: { env: Record<string, string>; timeoutMs: number },
) => Promise<ProbeResult>;

export type SandboxCheckInput = {
  /** Bash の子プロセスと同じ PATH（shellPath） */
  pathEnv: string;
  workDir: string;
  dataDir: string;
  claudeConfigDir: string;
  /** Bot のリポジトリ（process.cwd()） */
  repoDir: string;
  /** `~/.config/self-agent` の基準 */
  homeDir: string;
  /** 既定は child_process.spawn で実行する */
  runProbe?: RunProbe;
  /** 既定は BWRAP_PROBE_TIMEOUT_MS */
  probeTimeoutMs?: number;
  /** パスの st_dev。既定は statSync。読めなければ投げる */
  deviceOf?: (path: string) => number | bigint;
};

/** Bash の子プロセスの PATH（§2.4）。node の bin（execPath のディレクトリ）を先頭に置く（service の PATH には nvm が無いため） */
export function shellPath(execPath: string): string {
  return [dirname(execPath), ...SHELL_SYSTEM_PATH_DIRS].join(delimiter);
}

/** PATH の絶対パスの要素から、実行できるファイル name を探す。無ければ undefined */
export function findExecutable(name: string, pathEnv: string): string | undefined {
  for (const dir of pathEnv.split(delimiter)) {
    if (dir === "" || !isAbsolute(dir)) continue;
    const file = join(dir, name);
    try {
      if (!statSync(file).isFile()) continue;
      accessSync(file, constants.X_OK);
      return file;
    } catch {
      // 無い・実行できないなら次の要素
    }
  }
  return undefined;
}

/** 実際の場所（解決できなければ絶対パスにしただけのもの） */
function realOrResolved(path: string): string {
  return resolveRealPath(path) ?? resolve(path);
}

/** a と b が同じか、どちらかがもう一方の中にあるか */
function overlaps(a: string, b: string): boolean {
  const inside = (child: string, dir: string): boolean => child.startsWith(dir.endsWith(sep) ? dir : dir + sep);
  return a === b || inside(a, b) || inside(b, a);
}

/** workDir が他の場所（データ・SDK の設定・リポジトリ・`~/.config/self-agent`）と同じか、その中・外側にあるか（§2.3） */
export function placesOverlap(input: Pick<SandboxCheckInput, "workDir" | "dataDir" | "claudeConfigDir" | "repoDir" | "homeDir">): boolean {
  const workDir = realOrResolved(input.workDir);
  const others = [input.dataDir, input.claudeConfigDir, input.repoDir, join(input.homeDir, ".config/self-agent")];
  return others.some((other) => overlaps(workDir, realOrResolved(other)));
}

/** workDir が親ディレクトリと別のファイルシステム（st_dev が違う）か（§2.7）。解決・stat できなければ false */
export function isSeparateFilesystem(workDir: string, deviceOf: (path: string) => number | bigint = defaultDeviceOf): boolean {
  const real = resolveRealPath(workDir);
  if (real === undefined) return false;
  const parent = dirname(real);
  if (parent === real) return false;
  try {
    return deviceOf(real) !== deviceOf(parent);
  } catch {
    return false;
  }
}

function defaultDeviceOf(path: string): number {
  return statSync(path).dev;
}

/** child_process.spawn で実行し、終わり方を返す。時間切れなら SIGKILL で止める。reject しない */
export const spawnProbe: RunProbe = (file, args, { env, timeoutMs }) =>
  new Promise((resolvePromise) => {
    let timer: NodeJS.Timeout | undefined;
    let settled = false;
    const finish = (result: ProbeResult): void => {
      if (settled) return;
      settled = true;
      if (timer !== undefined) clearTimeout(timer);
      resolvePromise(result);
    };
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(file, [...args], { env, stdio: "ignore" });
    } catch {
      finish({ kind: "error" });
      return;
    }
    child.once("error", () => finish({ kind: "error" }));
    child.once("exit", (code) => finish({ kind: "exited", code }));
    timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish({ kind: "timeout" });
    }, timeoutMs);
  });

/**
 * 自己診断（§4）。どれかが失敗しても残りも確かめ、失敗した項目を全部返す。
 * 1. PATH に bwrap と socat がある 2. bwrap の probe が時間内に 0 で終わる（bwrap が無ければ行わない）
 * 3. 場所の重なりが無い（§2.3） 4. workDir が別のファイルシステム（§2.7）
 */
export async function checkSandbox(input: SandboxCheckInput): Promise<SandboxCheckResult> {
  const failed: string[] = [];
  const bwrap = findExecutable("bwrap", input.pathEnv);
  if (bwrap === undefined) failed.push(SANDBOX_CHECK_ITEMS.bwrapMissing);
  if (findExecutable("socat", input.pathEnv) === undefined) failed.push(SANDBOX_CHECK_ITEMS.socatMissing);
  if (bwrap !== undefined) {
    const runProbe = input.runProbe ?? spawnProbe;
    const result = await runProbe(bwrap, BWRAP_PROBE_ARGS, {
      env: { PATH: input.pathEnv },
      timeoutMs: input.probeTimeoutMs ?? BWRAP_PROBE_TIMEOUT_MS,
    });
    if (result.kind === "timeout") failed.push(SANDBOX_CHECK_ITEMS.probeTimeout);
    else if (result.kind === "error" || result.code !== 0) failed.push(SANDBOX_CHECK_ITEMS.probeFailed);
  }
  if (placesOverlap(input)) failed.push(SANDBOX_CHECK_ITEMS.placesOverlap);
  if (!isSeparateFilesystem(input.workDir, input.deviceOf)) failed.push(SANDBOX_CHECK_ITEMS.sameFilesystem);
  return failed.length === 0 ? { ok: true } : { ok: false, failed };
}
