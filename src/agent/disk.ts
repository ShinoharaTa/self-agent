// ディスクの上限と掃除（docs/plan/shell.md §2.7）。SDK に依存しない。
// 大きさは lstat の blocks（du と同じ実際の使用量）で数え、symlink はたどらない（リンクそのものだけを数える）
import { lstatSync, readdirSync, statfsSync } from "node:fs";
import { lstat, readdir, realpath, rmdir, unlink } from "node:fs/promises";
import { join, sep } from "node:path";
import { TRASH_DIR_NAME } from "./project-files.ts";
import { removeTree } from "./remove-tree.ts";

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
/** プロジェクトの配信する場所（`<dir>/site`）。node_modules を探すときに入らない */
const SITE_DIR_NAME = "site";

const MIB = 1024 * 1024;
const GIB = 1024 * MIB;

/** workDir の空きが足りなくて拒否したときにモデルへ返す理由（.trash に移しても空きは増えない） */
export const DISK_FREE_REASON =
  `作業場所の空きが足りません（${WORKDIR_MIN_FREE_BYTES / MIB} MB 未満）。.trash に移しても空きは増えないので、書き込みをやめてオーナーに伝えてください`;
/** プロジェクトが大きすぎて拒否したときにモデルへ返す理由 */
export const PROJECT_SIZE_REASON =
  `このプロジェクトが容量の上限（.trash を除いて ${PROJECT_MAX_BYTES / GIB} GB）を超えています。要らないもの（node_modules・ビルドの出力など）を project_files で .trash に移してください`;

/** 拒否の種類。free は workDir の空き、project はプロジェクトの大きさ */
export type DiskDecision = { allowed: true } | { allowed: false; kind: "free" | "project"; reason: string };

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

  /**
   * プロジェクトの大きさ（バイト。直下の .trash は数えない）。60 秒以内に数えた上限の内のものがあればそれを返す。上限を超えたところで数えるのをやめる。
   * 上限を超えた結果はキャッシュしない（project_files で .trash に移したら、次の書き込みで数え直す）
   */
  projectBytes(slug: string): number {
    const now = this.now().getTime();
    const cached = this.sizes.get(slug);
    if (cached !== undefined && now - cached.at < PROJECT_SIZE_CACHE_MS) return cached.bytes;
    const bytes = treeSize(join(this.projectsDir, slug), this.projectMaxBytes, [TRASH_DIR_NAME]);
    if (bytes > this.projectMaxBytes) this.sizes.delete(slug);
    else this.sizes.set(slug, { bytes, at: now });
    return bytes;
  }

  /** このプロジェクトに書いてよいか。workDir の空きが 512 MB 未満（free）、またはプロジェクトが 1 GB を超えていれば（project）拒否する */
  check(slug: string): DiskDecision {
    if (this.freeBytes() < WORKDIR_MIN_FREE_BYTES) return { allowed: false, kind: "free", reason: DISK_FREE_REASON };
    if (this.projectBytes(slug) > this.projectMaxBytes) {
      return { allowed: false, kind: "project", reason: PROJECT_SIZE_REASON };
    }
    return { allowed: true };
  }
}

/** path が実際のディレクトリか（symlink は false）。無ければ false */
async function isRealDirectory(path: string): Promise<boolean> {
  try {
    return (await lstat(path)).isDirectory();
  } catch (error) {
    if (hasCode(error, "ENOENT", "ENOTDIR")) return false;
    throw error;
  }
}

/**
 * `<projectsDir>/<slug>` の realpath。projectsDir の直下のそのディレクトリそのもの（symlink でない）でなければ・確かめられなければ undefined
 */
export async function verifiedProjectDir(projectsDir: string, slug: string): Promise<string | undefined> {
  try {
    const base = await realpath(projectsDir);
    const real = await realpath(join(projectsDir, slug));
    return real === join(base, slug) ? real : undefined;
  } catch {
    return undefined;
  }
}

/**
 * `<workDir>/.tmp` の中を symlink をたどらずに回り、更新（自分の lstat の mtime）から 1 日を過ぎたファイル・symlink を消し、
 * そのあと空になったディレクトリのうち、中を消す前の更新から 1 日を過ぎたものを下から消す（.tmp そのものは消さない）。
 * 1 つ消せなくても（EACCES など）続け、失敗した数を返す。消している間に無くなったものは失敗に数えない
 */
async function pruneTmp(tmp: string, now: Date): Promise<number> {
  const cutoff = now.getTime() - WORK_TMP_MAX_AGE_MS;
  let failures = 0;
  const visit = async (dir: string): Promise<void> => {
    let names: string[];
    try {
      names = await readdir(dir);
    } catch (error) {
      if (!hasCode(error, "ENOENT")) failures++;
      return;
    }
    for (const name of names) {
      const path = join(dir, name);
      try {
        const stats = await lstat(path);
        if (stats.isDirectory()) {
          await visit(path);
          if (stats.mtimeMs < cutoff) {
            try {
              // 空でなければ（新しいものが残っている）消さない
              await rmdir(path);
            } catch (error) {
              if (!hasCode(error, "ENOTEMPTY", "EEXIST")) throw error;
            }
          }
        } else if (stats.mtimeMs < cutoff) {
          // unlink は symlink をたどらない（リンクそのものを消す）
          await unlink(path);
        }
      } catch (error) {
        if (!hasCode(error, "ENOENT")) failures++;
      }
    }
  };
  await visit(tmp);
  return failures;
}

/**
 * workDir の掃除（scheduler の tick）。`<workDir>/.tmp` の中の 1 日を過ぎたもの（pruneTmp）と、
 * cacheMaxBytes（既定 1 GB）を超えた `<workDir>/.cache` を丸ごと（removeTree で）消す。どちらも無い・実際のディレクトリでない（symlink）なら何もしない。
 * workDir の直下のほかのもの（lost+found など）は見ない。片方が失敗してももう片方は行い、失敗があれば最後にまとめて投げる（message にパスは入れない）
 */
export async function pruneWorkDir(workDir: string, now: Date, cacheMaxBytes = WORK_CACHE_MAX_BYTES): Promise<void> {
  let failures = 0;
  try {
    const tmp = join(workDir, WORK_TMP_DIR_NAME);
    if (await isRealDirectory(tmp)) failures += await pruneTmp(tmp, now);
  } catch {
    failures++;
  }
  try {
    const cache = join(workDir, WORK_CACHE_DIR_NAME);
    if ((await isRealDirectory(cache)) && treeSize(cache, cacheMaxBytes) > cacheMaxBytes) await removeTree(cache);
  } catch {
    failures++;
  }
  if (failures > 0) throw new Error(`作業場所の掃除で ${failures} 件失敗しました`);
}

/**
 * `<projectsDir>/<slug>` の中の node_modules を消し、消した数を返す（/close の後に使う。作り直せるもの）。
 * プロジェクトの dir が無ければ 0、projectsDir の直下のそのディレクトリそのもの（verifiedProjectDir）と確かめられなければ何も消さずに undefined。
 * dir から深さ 3 まで（`<dir>/node_modules` が 1）を探し、直下の .trash と site（配信する場所。手で書いたものがありうる）には入らない。
 * symlink はたどらない（探すのは実際のディレクトリだけ）。実際のディレクトリの node_modules は realpath が realpath(dir) の中のときだけ、
 * symlink の node_modules は、リンクのある場所（親の realpath）が realpath(dir) の中のときだけ、removeTree で消す（symlink はリンクそのものだけ）。
 * 失敗したら投げる
 */
export async function removeNodeModules(projectsDir: string, slug: string): Promise<number | undefined> {
  try {
    await lstat(join(projectsDir, slug));
  } catch (error) {
    if (hasCode(error, "ENOENT", "ENOTDIR")) return 0;
    throw error;
  }
  const root = await verifiedProjectDir(projectsDir, slug);
  if (root === undefined || !(await isRealDirectory(root))) return undefined;
  let removed = 0;
  const visit = async (dir: string, depth: number): Promise<void> => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (depth === 1 && (entry.name === TRASH_DIR_NAME || entry.name === SITE_DIR_NAME)) continue;
      if (entry.name === "node_modules") {
        const inside = entry.isSymbolicLink()
          ? isInside(join(await realpath(dir), entry.name), root)
          : entry.isDirectory() && isInside(await realpath(path), root);
        if (inside) {
          await removeTree(path);
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
