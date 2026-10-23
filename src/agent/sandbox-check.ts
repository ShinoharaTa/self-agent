// シェル（Bash）の sandbox の自己診断（docs/plan/shell.md §4）。LLM は使わない。SELF_AGENT_SHELL=1 のとき起動時と tick ごとに app/shell-state.ts が呼ぶ。
// 失敗した項目は短い日本語で返す（log・#system に出すので、パス・ホスト名は入れない）
import { spawn } from "node:child_process";
import { accessSync, constants, statSync } from "node:fs";
import { delimiter, dirname, isAbsolute, join, sep } from "node:path";
import { PROJECTS_DIR_NAME, WORK_CACHE_DIR_NAME, WORK_CWD_DIR_NAME, WORK_TMP_DIR_NAME } from "./disk.ts";
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
  placesOverlap: "sandbox から読める場所と秘密の場所が重なっている",
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
  /** node の版のディレクトリ（nodeVersionDir。§2.2 の allowRead） */
  nodeDir: string;
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

/** node の版のディレクトリ（execPath の 2 つ上。npm を含む）。§2.2 の allowRead に入れる */
export function nodeVersionDir(execPath: string): string {
  return dirname(dirname(execPath));
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

/** sandbox の場所の基準（§2.2・§2.3）。自己診断（placesOverlap）と Options.sandbox（query-options.ts の sandboxSettings）が同じものを使う */
export type SandboxPlaces = Pick<SandboxCheckInput, "workDir" | "nodeDir" | "dataDir" | "claudeConfigDir" | "repoDir" | "homeDir">;

/**
 * sandbox から読める場所（allowRead。allowWrite はすべてこの中の projects・.cache・.tmp）。読める場所は workDir そのものではなく、
 * その下の projects・.cache・.tmp・cwd（CLI 2.1.286 では親を allowRead にすると cwd が読み取り専用になり bwrap が起動できない。#143）と node の版のディレクトリ。
 * workDir の直下は allowRead に無い（denyRead の下なら tmpfs の上で隠れ、外なら OS の既定で読めるが書けない）
 */
export function sandboxReadablePlaces(places: SandboxPlaces): string[] {
  return [
    join(places.workDir, PROJECTS_DIR_NAME),
    join(places.workDir, WORK_CACHE_DIR_NAME),
    join(places.workDir, WORK_TMP_DIR_NAME),
    join(places.workDir, WORK_CWD_DIR_NAME),
    places.nodeDir,
  ];
}

/**
 * 秘密の場所（データ・SDK の設定・env ファイルのある `~/.config/self-agent`・リポジトリ）。
 * denyRead に実際の場所で並べ（`~` の下でなくても隠すため）、読める場所と重なれば自己診断を通さない
 */
export function sandboxSecretPlaces(places: SandboxPlaces): string[] {
  return [places.dataDir, places.claudeConfigDir, join(places.homeDir, ".config/self-agent"), places.repoDir];
}

/** PATH（shellPath）に bwrap・socat が無ければ、その項目（SANDBOX_CHECK_ITEMS）。両方あれば空。各 run の前の確かめ直し（§4）に使う */
export function missingSandboxBinaries(pathEnv: string): string[] {
  return [
    ...(findExecutable("bwrap", pathEnv) === undefined ? [SANDBOX_CHECK_ITEMS.bwrapMissing] : []),
    ...(findExecutable("socat", pathEnv) === undefined ? [SANDBOX_CHECK_ITEMS.socatMissing] : []),
  ];
}

/** a と b が同じか、どちらかがもう一方の中にあるか */
function overlaps(a: string, b: string): boolean {
  const inside = (child: string, dir: string): boolean => child.startsWith(dir.endsWith(sep) ? dir : dir + sep);
  return a === b || inside(a, b) || inside(b, a);
}

/**
 * sandbox から読める・書ける場所（sandboxReadablePlaces。workDir の projects・.cache・.tmp・cwd と node の版のディレクトリ）と、
 * 秘密の場所（sandboxSecretPlaces）のどれかが、同じかその中・外側にあるか（§2.3）。
 * 実際の場所（resolveRealPath。まだ無い部分は存在する一番深い親から求める）で比べ、
 * どれかが解決できなければ（ENOENT 以外の失敗・壊れた symlink など）重なっているとみなす（fail-closed）
 */
export function placesOverlap(input: SandboxPlaces): boolean {
  const resolveAll = (paths: string[]): string[] | undefined => {
    const reals = paths.map((path) => resolveRealPath(path));
    return reals.every((real) => real !== undefined) ? (reals as string[]) : undefined;
  };
  const allowed = resolveAll(sandboxReadablePlaces(input));
  const secrets = resolveAll(sandboxSecretPlaces(input));
  if (allowed === undefined || secrets === undefined) return true;
  return allowed.some((place) => secrets.some((secret) => overlaps(place, secret)));
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
  failed.push(...missingSandboxBinaries(input.pathEnv));
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
