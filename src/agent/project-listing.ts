// プロジェクトのファイルの一覧と中身を読むだけ（Web UI のプロジェクトのタブ。docs/plan/web-ui.md §7.4）。SDK に依存しない。書き込み・削除はしない。
// projects は sandbox の中の Bash が書き換えられ、Web UI はキューの外で読むので、静的サーバー（serve/static-server.ts）と同じく、
// 判定の後に symlink にすり替えられても外を読まない形で開く（最後の要素は O_NOFOLLOW、FIFO で待たないよう O_NONBLOCK、
// 開いた fd の実際のパス（/proc/self/fd の readlink）がプロジェクトの中か確かめ、その fd からだけ読む。ディレクトリも同じく fd から一覧する）。
// ドットで始まる名前（.trash・.git を含む）と node_modules は一覧に出さず、ドットで始まる要素のパスは読まない
import { constants } from "node:fs";
import { lstat, open, readdir, readlink, type FileHandle } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import { verifiedProjectDir } from "./disk.ts";
import { resolveRealPath } from "./file-access.ts";

/** 中身を返すファイルの大きさの上限（バイト） */
export const PROJECT_FILE_MAX_BYTES = 256 * 1024;
/** 一覧に出すファイルの数の上限。超えたら truncated */
export const PROJECT_LIST_MAX_FILES = 500;
/** 一覧で入る深さ（直下のファイルが 1。これより深いものは出さずに truncated） */
export const PROJECT_LIST_MAX_DEPTH = 6;
/** テキストかを見る先頭の大きさ（この中に NUL があれば binary） */
export const PROJECT_FILE_SNIFF_BYTES = 8 * 1024;
/** 読むパスの文字数の上限 */
const PROJECT_PATH_MAX_LENGTH = 1024;
/** 一覧で入らないディレクトリ（ドットで始まるものは別に除く） */
const SKIPPED_DIRS: ReadonlySet<string> = new Set(["node_modules"]);

export type ProjectFile = {
  /** プロジェクトの dir からの相対パス（`/` 区切り） */
  path: string;
  size: number;
  /** 更新日時（ISO） */
  mtime: string;
};

export type ProjectFileList = { files: ProjectFile[]; truncated: boolean };

export type ReadProjectFileResult = { text: string } | "not_found" | "too_large" | "binary" | "invalid_path";

export type ProjectListingHooks = {
  /** テスト用: 判定の後、ファイル（一覧ではディレクトリ）を開く直前に呼ぶ（ここでパスをすり替えて、開いた後の確かめが効くかを試す） */
  beforeOpen?: (path: string) => Promise<void> | void;
};

function hasCode(error: unknown, ...codes: string[]): boolean {
  return error instanceof Error && "code" in error && typeof error.code === "string" && codes.includes(error.code);
}

/** 一覧・読み取りで扱わない名前（ドットで始まる。.trash・.git・`.`・`..` を含む） */
function hidden(name: string): boolean {
  return name.startsWith(".");
}

/** path が root の中で、root からの要素にドットで始まるものが無いか（root そのものは含まない） */
function insideVisible(path: string, root: string): boolean {
  if (!path.startsWith(root + sep)) return false;
  return !relative(root, path).split(sep).some(hidden);
}

/** verifiedProjectDir を通り、実際のディレクトリなら dir の実パス。それ以外は undefined */
async function projectRoot(projectsDir: string, slug: string): Promise<string | undefined> {
  const root = await verifiedProjectDir(projectsDir, slug);
  if (root === undefined) return undefined;
  try {
    return (await lstat(root)).isDirectory() ? root : undefined;
  } catch {
    return undefined;
  }
}

/**
 * ディレクトリを開く。最後の要素は O_NOFOLLOW（symlink なら開かない）、開いた fd の実際のパスが expected でなければ閉じて undefined
 * （途中の要素がすり替えられていても外を一覧しない）
 */
async function openDirAt(expected: string): Promise<FileHandle | undefined> {
  let handle: FileHandle;
  try {
    handle = await open(expected, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch {
    return undefined;
  }
  try {
    if ((await readlink(`/proc/self/fd/${handle.fd}`)) !== expected) throw new Error("moved");
    if (!(await handle.stat()).isDirectory()) throw new Error("not a directory");
    return handle;
  } catch {
    await handle.close();
    return undefined;
  }
}

/**
 * プロジェクトのファイルの一覧（通常のファイルだけ）。プロジェクトの dir が verifiedProjectDir を通らない（無い・slug や projects が symlink）・
 * ディレクトリでなければ undefined。symlink・ドットで始まる名前（.trash・.git）・node_modules は出さず、入らない。
 * ディレクトリは開いた fd から一覧する（すり替えられたものには入らない）。名前の順に深さ優先で、PROJECT_LIST_MAX_DEPTH・PROJECT_LIST_MAX_FILES まで。
 * どちらかで出さなかったものがあれば truncated
 */
export async function listProjectFiles(
  projectsDir: string,
  slug: string,
  hooks: ProjectListingHooks = {},
): Promise<ProjectFileList | undefined> {
  const root = await projectRoot(projectsDir, slug);
  if (root === undefined) return undefined;
  const rootHandle = await openDirAt(root);
  if (rootHandle === undefined) return undefined;
  const files: ProjectFile[] = [];
  // full: 件数の上限に達した（以後は回らない）。truncated: 上限（件数・深さ）で出さなかったものがある
  let full = false;
  let truncated = false;

  // dir は開いた handle の実際のパス。中の名前は fd のパス（/proc/self/fd/<fd>/<name>）で lstat し、すり替えの影響を受けない
  const visit = async (handle: FileHandle, dir: string, prefix: string, depth: number): Promise<void> => {
    const fdPath = `/proc/self/fd/${handle.fd}`;
    const entries = (await readdir(fdPath, { withFileTypes: true })).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const entry of entries) {
      if (full) return;
      if (hidden(entry.name) || entry.isSymbolicLink()) continue;
      const path = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
      if (entry.isDirectory()) {
        if (SKIPPED_DIRS.has(entry.name)) continue;
        if (depth >= PROJECT_LIST_MAX_DEPTH) {
          truncated = true;
          continue;
        }
        await hooks.beforeOpen?.(join(dir, entry.name));
        const child = await openDirAt(join(dir, entry.name));
        if (child === undefined) continue;
        try {
          await visit(child, join(dir, entry.name), path, depth + 1);
        } finally {
          await child.close();
        }
        continue;
      }
      if (!entry.isFile()) continue;
      let info;
      try {
        info = await lstat(`${fdPath}/${entry.name}`);
      } catch (error) {
        if (hasCode(error, "ENOENT", "ENOTDIR")) continue;
        throw error;
      }
      if (!info.isFile()) continue;
      if (files.length >= PROJECT_LIST_MAX_FILES) {
        full = true;
        truncated = true;
        return;
      }
      files.push({ path, size: info.size, mtime: info.mtime.toISOString() });
    }
  };

  try {
    await visit(rootHandle, root, "", 1);
  } finally {
    await rootHandle.close();
  }
  return { files, truncated };
}

/**
 * 読むパスの要素。空・長すぎる・NUL・`/` で始まる・空の要素（`a//b`・末尾の `/`）・ドットで始まる要素（`.`・`..`・.trash・ドットファイル）があれば undefined
 */
function pathSegments(relPath: string): string[] | undefined {
  if (relPath === "" || relPath.length > PROJECT_PATH_MAX_LENGTH || relPath.includes("\0") || relPath.startsWith("/")) return undefined;
  const segments = relPath.split("/");
  return segments.some((segment) => segment === "" || hidden(segment)) ? undefined : segments;
}

/** handle の position 0 から最大 limit バイト */
async function readUpTo(handle: FileHandle, limit: number): Promise<Buffer> {
  const buffer = Buffer.alloc(limit);
  let filled = 0;
  while (filled < limit) {
    const { bytesRead } = await handle.read(buffer, filled, limit - filled, filled);
    if (bytesRead === 0) break;
    filled += bytesRead;
  }
  return buffer.subarray(0, filled);
}

/**
 * プロジェクトのファイルの中身（UTF-8 のテキスト）。
 * - パスの形が違う（pathSegments）・realpath がプロジェクトの dir の外かドットで始まる要素の下（外や .trash への symlink）なら invalid_path
 * - プロジェクトの dir が verifiedProjectDir を通らない・無い・通常のファイルでない（ディレクトリ・FIFO など）なら not_found
 * - 最後の要素は O_NOFOLLOW・O_NONBLOCK で開き、開いた fd の実際のパスが中でなければ invalid_path（判定の後のすり替え）
 * - PROJECT_FILE_MAX_BYTES を超えれば too_large、先頭 PROJECT_FILE_SNIFF_BYTES に NUL があるか UTF-8 として読めなければ binary
 */
export async function readProjectFile(
  projectsDir: string,
  slug: string,
  relPath: string,
  hooks: ProjectListingHooks = {},
): Promise<ReadProjectFileResult> {
  const segments = pathSegments(relPath);
  if (segments === undefined) return "invalid_path";
  const root = await projectRoot(projectsDir, slug);
  if (root === undefined) return "not_found";
  const target = resolveRealPath(join(root, ...segments));
  if (target === undefined || !insideVisible(target, root)) return "invalid_path";
  await hooks.beforeOpen?.(target);
  let handle: FileHandle;
  try {
    handle = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch (error) {
    if (hasCode(error, "ENOENT", "ENOTDIR")) return "not_found";
    if (hasCode(error, "ELOOP")) return "invalid_path";
    throw error;
  }
  try {
    if (!insideVisible(await readlink(`/proc/self/fd/${handle.fd}`), root)) return "invalid_path";
    const info = await handle.stat();
    if (!info.isFile()) return "not_found";
    if (info.size > PROJECT_FILE_MAX_BYTES) return "too_large";
    // 開いた後に伸びていても上限を 1 バイト超えたところで止める
    const content = await readUpTo(handle, PROJECT_FILE_MAX_BYTES + 1);
    if (content.length > PROJECT_FILE_MAX_BYTES) return "too_large";
    if (content.subarray(0, PROJECT_FILE_SNIFF_BYTES).includes(0)) return "binary";
    try {
      return { text: new TextDecoder("utf-8", { fatal: true }).decode(content) };
    } catch {
      return "binary";
    }
  } finally {
    await handle.close();
  }
}
