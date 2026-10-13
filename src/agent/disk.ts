// ディスクの上限と掃除（docs/plan/shell.md §2.7）。SDK に依存しない。
// 大きさは lstat の blocks（du と同じ実際の使用量）で数え、symlink はたどらない（リンクそのものだけを数える）
import { lstatSync, readdirSync, rmSync, statfsSync } from "node:fs";
import { lstat, readdir, realpath, rm, unlink } from "node:fs/promises";
import { join, sep } from "node:path";
import { TRASH_DIR_NAME } from "./project-files.ts";

/** workDir の空きがこれより少なければ、書き込み（Write・Edit）を拒否する */
export const WORKDIR_MIN_FREE_BYTES = 512 * 1024 * 1024;
/** 1 プロジェクト（直下の .trash は除く）の大きさの上限。超えたら書き込み（Write・Edit）を拒否する。.trash を含む全体は workDir の空きで抑える */
export const PROJECT_MAX_BYTES = 1024 * 1024 * 1024;
/** プロジェクトの大きさを数え直すまでの時間 */
export const PROJECT_SIZE_CACHE_MS = 60 * 1000;
/** `<workDir>/.tmp` の中のものを残す時間。過ぎたものは scheduler の tick で消す */
export const WORK_TMP_MAX_AGE_MS = 24 * 60 * 60 * 1000;
/** `<workDir>/.cache` の大きさの上限。超えたら scheduler の tick で丸ごと消す */
export const WORK_CACHE_MAX_BYTES = 1024 * 1024 * 1024;
/** /close で node_modules を探す深さ（`<dir>/node_modules` が 1、`<dir>/a/b/node_modules` が 3） */
export const NODE_MODULES_MAX_DEPTH = 3;

/** コマンド・ツールが使う一時ファイルの場所（`<workDir>/.tmp`） */
export const WORK_TMP_DIR_NAME = ".tmp";
/** パッケージのキャッシュの場所（`<workDir>/.cache`） */
export const WORK_CACHE_DIR_NAME = ".cache";

const MIB = 1024 * 1024;
const GIB = 1024 * MIB;

/** 容量の上限で拒否したときにモデルへ返す理由 */
export const DISK_LIMIT_REASON =
  `容量の上限を超えています（プロジェクトは .trash を除いて ${PROJECT_MAX_BYTES / GIB} GB まで、作業場所の空きは ${WORKDIR_MIN_FREE_BYTES / MIB} MB 以上が要ります）。` +
  "プロジェクトが大きすぎるときは、要らないもの（node_modules・ビルドの出力など）を project_files で .trash に移してください。作業場所の空きが足りないときは、オーナーに伝えてください";

export type DiskDecision = { allowed: true } | { allowed: false; reason: string };

function hasCode(error: unknown, ...codes: string[]): boolean {
  return error instanceof Error && "code" in error && codes.includes(String(error.code));
}

/** child が dir の中か（dir そのものは含まない） */
function isInside(child: string, dir: string): boolean {
  return child.startsWith(dir.endsWith(sep) ? dir : dir + sep);
}

/**
 * path（そのものを含む）の中の全部の大きさ（lstat の blocks × 512）。symlink はたどらず、リンクそのものだけを数える。
 * path が無ければ 0。数えている間に消えたものは飛ばす。stopAbove を超えたらそこで数えるのをやめて、その時点の値（stopAbove より大きい）を返す。
 * skipTopLevel の名前は path の直下のものだけ数えない
 */
export function treeSize(
  path: string,
  stopAbove = Number.POSITIVE_INFINITY,
  skipTopLevel: readonly string[] = [],
): number {
  let total = 0;
  const stack = [path];
  while (stack.length > 0) {
    const current = stack.pop() as string;
    let stats;
    try {
      stats = lstatSync(current);
    } catch (error) {
      if (hasCode(error, "ENOENT", "ENOTDIR")) continue;
      throw error;
    }
    total += stats.blocks * 512;
    if (total > stopAbove) return total;
    if (!stats.isDirectory()) continue;
    let names: string[];
    try {
      names = readdirSync(current);
    } catch (error) {
      if (hasCode(error, "ENOENT", "ENOTDIR")) continue;
      throw error;
    }
    for (const name of names) {
      if (current === path && skipTopLevel.includes(name)) continue;
      stack.push(join(current, name));
    }
  }
  return total;
}

/** statfs の結果のうち、空きの計算に使うもの */
export type StatFs = { bavail: number; bsize: number };

export type DiskQuotaDeps = {
  /** 空きを見る場所（workDir） */
  workDir: string;
  /** `<workDir>/projects`。プロジェクトのディレクトリは `<projectsDir>/<slug>` */
  projectsDir: string;
  /** 大きさのキャッシュの時計 */
  now: () => Date;
  /** 省略すると fs.statfsSync（テストで差し替える） */
  statfs?: (path: string) => StatFs;
  /** 省略すると PROJECT_MAX_BYTES（テストで小さくする） */
  projectMaxBytes?: number;
};

/**
 * 書き込みの前の容量の判定。workDir の空き（毎回 statfs）と、プロジェクトの大きさ（直下の .trash を除く。プロジェクトごとに 60 秒キャッシュ）を見る。
 * Write・Edit の hook で使う（Bash の hook からも同じ判定を使う）。読めない・数えられないなどの例外はそのまま投げる（呼び出し側で拒否する）
 */
export class DiskQuota {
  private readonly workDir: string;
  private readonly projectsDir: string;
  private readonly now: () => Date;
  private readonly statfs: (path: string) => StatFs;
  private readonly projectMaxBytes: number;
  /** slug ごとの大きさと数えた時刻（ミリ秒） */
  private readonly sizes = new Map<string, { bytes: number; at: number }>();

  constructor(deps: DiskQuotaDeps) {
    this.workDir = deps.workDir;
    this.projectsDir = deps.projectsDir;
    this.now = deps.now;
    this.statfs = deps.statfs ?? ((path) => statfsSync(path));
    this.projectMaxBytes = deps.projectMaxBytes ?? PROJECT_MAX_BYTES;
  }

  /** workDir の空き（バイト） */
  freeBytes(): number {
    const stats = this.statfs(this.workDir);
    return stats.bavail * stats.bsize;
  }

  /** プロジェクトの大きさ（バイト。直下の .trash は数えない）。60 秒以内に数えたものがあればそれを返す。上限を超えたところで数えるのをやめる */
  projectBytes(slug: string): number {
    const now = this.now().getTime();
    const cached = this.sizes.get(slug);
    if (cached !== undefined && now - cached.at < PROJECT_SIZE_CACHE_MS) return cached.bytes;
    const bytes = treeSize(join(this.projectsDir, slug), this.projectMaxBytes, [TRASH_DIR_NAME]);
    this.sizes.set(slug, { bytes, at: now });
    return bytes;
  }

  /** このプロジェクトに書いてよいか。workDir の空きが 512 MB 未満、またはプロジェクトが 1 GB を超えていれば拒否する */
  check(slug: string): DiskDecision {
    if (this.freeBytes() < WORKDIR_MIN_FREE_BYTES || this.projectBytes(slug) > this.projectMaxBytes) {
      return { allowed: false, reason: DISK_LIMIT_REASON };
    }
    return { allowed: true };
  }
}

/** path が実際のディレクトリか（symlink は false）。無ければ false */
function isRealDirectory(path: string): boolean {
  try {
    return lstatSync(path).isDirectory();
  } catch (error) {
    if (hasCode(error, "ENOENT", "ENOTDIR")) return false;
    throw error;
  }
}

/**
 * workDir の掃除（scheduler の tick）。`<workDir>/.tmp` の直下のもののうち更新から 1 日を過ぎたものと、
 * cacheMaxBytes（既定 1 GB）を超えた `<workDir>/.cache` を丸ごと消す。どちらも無い・実際のディレクトリでない（symlink）なら何もしない。
 * 片方が失敗してももう片方は行い、最後に最初の失敗を投げる
 */
export function pruneWorkDir(workDir: string, now: Date, cacheMaxBytes = WORK_CACHE_MAX_BYTES): void {
  let failure: unknown;
  try {
    const tmp = join(workDir, WORK_TMP_DIR_NAME);
    if (isRealDirectory(tmp)) {
      for (const name of readdirSync(tmp)) {
        const target = join(tmp, name);
        let mtime: number;
        try {
          mtime = lstatSync(target).mtimeMs;
        } catch (error) {
          if (hasCode(error, "ENOENT")) continue;
          throw error;
        }
        // symlink はリンクそのものを消す（rm は symlink をたどらない）
        if (now.getTime() - mtime > WORK_TMP_MAX_AGE_MS) rmSync(target, { recursive: true, force: true });
      }
    }
  } catch (error) {
    failure = error;
  }
  try {
    const cache = join(workDir, WORK_CACHE_DIR_NAME);
    if (isRealDirectory(cache) && treeSize(cache, cacheMaxBytes) > cacheMaxBytes) {
      rmSync(cache, { recursive: true, force: true });
    }
  } catch (error) {
    failure ??= error;
  }
  if (failure !== undefined) throw failure;
}

/**
 * プロジェクトの dir の中の node_modules を消し、消した数を返す（/close の後に使う。作り直せるもの）。
 * dir から深さ 3 まで（`<dir>/node_modules` が 1）を探し、直下の .trash には入らない。symlink はたどらない（探すのは実際のディレクトリだけ）。
 * 実際のディレクトリの node_modules は realpath が realpath(dir) の中のときだけ中身ごと消す。
 * symlink の node_modules は、リンクのある場所（親の realpath）が realpath(dir) の中のときだけリンクそのものを消す（指す先は消さない）。
 * dir が無ければ 0。失敗したら投げる
 */
export async function removeNodeModules(projectDir: string): Promise<number> {
  let root: string;
  try {
    root = await realpath(projectDir);
  } catch (error) {
    if (hasCode(error, "ENOENT", "ENOTDIR")) return 0;
    throw error;
  }
  if (!(await lstat(root)).isDirectory()) return 0;
  let removed = 0;
  const visit = async (dir: string, depth: number): Promise<void> => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (depth === 1 && entry.name === TRASH_DIR_NAME) continue;
      if (entry.name === "node_modules") {
        if (entry.isSymbolicLink()) {
          if (isInside(join(await realpath(dir), entry.name), root)) {
            await unlink(path);
            removed++;
          }
        } else if (entry.isDirectory() && isInside(await realpath(path), root)) {
          await rm(path, { recursive: true, force: true });
          removed++;
        }
        continue;
      }
      if (entry.isDirectory() && depth < NODE_MODULES_MAX_DEPTH) await visit(path, depth + 1);
    }
  };
  await visit(root, 1);
  return removed;
}
