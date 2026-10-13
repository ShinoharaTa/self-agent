// project_files の本体（プロジェクトのファイルを .trash に移す・移す・作り直す・戻す）と、古い .trash の掃除。SDK に依存しない。
// 消したものは `<dir>/.trash/<trash_id>/<同じ相対パス>` に移す（site/ の外なので配信されない）。symlink はたどらず、1 つのものとして移す。
// ファイルの操作は同期で行う（同じターンで並べて呼ばれても、trash_id の選択と移動が混ざらない）
import { lstatSync, mkdirSync, readdirSync, renameSync, rmdirSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { resolveRealPath } from "./file-access.ts";
import { removeTree } from "./remove-tree.ts";
import { copyWebScaffold } from "./scaffold.ts";

/** プロジェクトの dir の直下の、消したものを置くディレクトリ */
export const TRASH_DIR_NAME = ".trash";
/** .trash/<trash_id> を残す日数。過ぎたものは scheduler の tick で消す */
export const TRASH_RETENTION_DAYS = 30;
/** trash の paths の上限 */
export const PROJECT_FILES_MAX_PATHS = 50;
/** trash_id の形（UTC の YYYYMMDDTHHmmssZ。同じ秒に重なれば -2、-3…） */
export const TRASH_ID_PATTERN = /^\d{8}T\d{6}Z(-\d+)?$/;

const DAY_MS = 24 * 60 * 60 * 1000;

/** trash・move でプロジェクトの dir が無い・解決できないときの message */
export const PROJECT_DIR_MISSING_MESSAGE = "プロジェクトのディレクトリがありません。project_open を使ってください";
/** .trash が実際のディレクトリでない（symlink・ファイル）ときの message */
export const TRASH_UNAVAILABLE_MESSAGE = ".trash がディレクトリではないため使えません";

export type ProjectFilesAction = "trash" | "move" | "clear" | "restore";
export type ProjectFilesArgs = { action: ProjectFilesAction; paths?: string[]; to?: string; trash_id?: string };

/** project_files の結果（そのまま JSON にしてモデルに返す） */
export type ProjectFilesResult =
  | { result: "trashed"; trash_id: string | null; moved: string[]; missing: string[] }
  | { result: "moved"; from: string; to: string }
  | { result: "missing"; path: string }
  | { result: "exists"; path: string }
  | { result: "cleared"; trash_id: string | null; scaffold: string[] }
  | { result: "list"; trashes: Array<{ trash_id: string; files: number }> }
  | { result: "not_found"; trash_id: string }
  | { result: "conflict"; paths: string[] }
  | { result: "restored"; trash_id: string; restored: string[] }
  | { result: "invalid_path"; path: string }
  | { result: "invalid_args"; message: string }
  | { result: "not_available"; message: string }
  | { result: "trash_unavailable"; message: string };

export type ProjectFilesOptions = {
  /** trash_id の時刻 */
  now: Date;
  /** clear で置き直す UI の土台の複製の元。省略すると templates/web/ */
  templateDir?: string;
  /** clear で UI の土台の複製に失敗したときの log */
  log: (message: string) => void;
};

function hasCode(error: unknown, ...codes: string[]): boolean {
  return error instanceof Error && "code" in error && codes.includes(String(error.code));
}

/** path に何か（ファイル・ディレクトリ・symlink）があるか。lstat なので symlink はたどらない */
function exists(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch (error) {
    if (hasCode(error, "ENOENT", "ENOTDIR")) return false;
    throw error;
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

/** child が dir の中か（dir そのものは含まない） */
function isInside(child: string, dir: string): boolean {
  return child.startsWith(dir.endsWith(sep) ? dir : dir + sep);
}

/** now から作る trash_id（UTC の YYYYMMDDTHHmmssZ） */
export function formatTrashId(now: Date): string {
  return now.toISOString().replace(/\.\d{3}Z$/, "Z").replace(/[-:]/g, "");
}

/** trash_id の時刻と、重なったときの番号（無ければ 1）。形に合わなければ undefined */
function parseTrashId(id: string): { time: number; seq: number } | undefined {
  const match = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z(?:-(\d+))?$/.exec(id);
  if (match === null) return undefined;
  const [y, mo, d, h, mi, s] = match.slice(1, 7).map(Number) as [number, number, number, number, number, number];
  const time = Date.UTC(y, mo - 1, d, h, mi, s);
  return Number.isNaN(time) ? undefined : { time, seq: match[7] === undefined ? 1 : Number(match[7]) };
}

/** `<dir>/.trash` に無い trash_id。now の秒の名前が既にあれば -2、-3… を付ける */
function nextTrashId(trashRoot: string, now: Date): string {
  const base = formatTrashId(now);
  let id = base;
  for (let n = 2; exists(join(trashRoot, id)); n++) id = `${base}-${n}`;
  return id;
}

/**
 * パスを確かめ、dir からの正規化した相対パスを返す。だめなら undefined:
 * 空・`/` で始まる・要素に `..` がある・dir そのもの（`.` など）・最初の要素が .trash、
 * resolveRealPath で解決できない・実際の場所が realpath(dir) の中でない・realpath(dir)/.trash そのものかその中
 */
function checkPath(dir: string, realDir: string, path: string): string | undefined {
  if (path === "" || path.startsWith("/") || path.split("/").includes("..")) return undefined;
  const rel = relative(dir, join(dir, path));
  if (rel === "" || rel.split(sep)[0] === TRASH_DIR_NAME) return undefined;
  const real = resolveRealPath(join(dir, rel));
  if (real === undefined || !isInside(real, realDir)) return undefined;
  const realTrash = join(realDir, TRASH_DIR_NAME);
  return real === realTrash || isInside(real, realTrash) ? undefined : rel;
}

/**
 * dir の中のディレクトリ以外のもの（ファイル・symlink）と空のディレクトリの、dir からの相対パス（`/` 区切り）。
 * symlink はたどらない。名前の順
 */
function collectEntries(dir: string, prefix = ""): string[] {
  const entries = readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  if (entries.length === 0 && prefix !== "") return [prefix];
  const found: string[] = [];
  for (const entry of entries) {
    const rel = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
    if (entry.isDirectory()) found.push(...collectEntries(join(dir, entry.name), rel));
    else found.push(rel);
  }
  return found;
}

/** dir の中のファイル（ディレクトリ以外。symlink を含む）の数。再帰。symlink はたどらない */
function countFiles(dir: string): number {
  let count = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    count += entry.isDirectory() ? countFiles(join(dir, entry.name)) : 1;
  }
  return count;
}

/**
 * dir からの相対パス rel（`/` 区切り）に戻すのを妨げるもの。rel そのものがあれば rel、途中の要素が
 * ディレクトリでない（ファイル・symlink）ならその要素までのパス。何も無ければ undefined
 */
function blockingPath(dir: string, rel: string): string | undefined {
  const parts = rel.split("/");
  for (let i = 1; i <= parts.length; i++) {
    const prefix = parts.slice(0, i).join("/");
    let isDirectory: boolean;
    try {
      isDirectory = lstatSync(join(dir, prefix)).isDirectory();
    } catch (error) {
      if (hasCode(error, "ENOENT")) return undefined;
      throw error;
    }
    if (i === parts.length || !isDirectory) return prefix;
  }
  return undefined;
}

/** 新しい順（時刻が同じなら番号の大きい順） */
function compareNewestFirst(a: string, b: string): number {
  const x = parseTrashId(a)!;
  const y = parseTrashId(b)!;
  return y.time - x.time || y.seq - x.seq;
}

const invalidArgs = (message: string): ProjectFilesResult => ({ result: "invalid_args", message });

/** action で使わない引数があれば invalid_args の message */
function extraArgs(args: ProjectFilesArgs, allowed: ReadonlyArray<"paths" | "to" | "trash_id">): string | undefined {
  const extras = (["paths", "to", "trash_id"] as const).filter((name) => !allowed.includes(name) && args[name] !== undefined);
  return extras.length === 0 ? undefined : `${args.action} では ${extras.join("・")} を指定しないでください`;
}

/**
 * paths を `.trash/<trash_id>/<同じ相対パス>` に移す。同じ相対パスの重複は最初の 1 つにまとめ、paths の中に祖先があるものは
 * 個別には移さない（祖先が移り、移す前にそれがあったなら moved、それ以外は missing）。moved・missing は入力の順
 */
function trash(dir: string, realDir: string, paths: string[], now: Date): ProjectFilesResult {
  const items: Array<{ path: string; rel: string }> = [];
  for (const path of paths) {
    const rel = checkPath(dir, realDir, path);
    if (rel === undefined) return { result: "invalid_path", path };
    if (!items.some((item) => item.rel === rel)) items.push({ path, rel });
  }
  /** rel の、paths の中で一番上の祖先（無ければ undefined） */
  const topAncestor = (rel: string): string | undefined =>
    items
      .map((item) => item.rel)
      .filter((other) => rel.startsWith(`${other}${sep}`))
      .sort((a, b) => a.length - b.length)[0];
  // 祖先と一緒に移るものは、移す前にあったかを見ておく
  const existedBefore = new Map(
    items.filter((item) => topAncestor(item.rel) !== undefined).map((item) => [item.rel, exists(join(dir, item.rel))]),
  );
  const trashRoot = join(dir, TRASH_DIR_NAME);
  const id = nextTrashId(trashRoot, now);
  /** 祖先の無いものの rel → 移したか */
  const movedTops = new Map<string, boolean>();
  for (const { rel } of items) {
    if (topAncestor(rel) !== undefined) continue;
    const source = join(dir, rel);
    if (!exists(source)) {
      movedTops.set(rel, false);
      continue;
    }
    const target = join(trashRoot, id, rel);
    mkdirSync(dirname(target), { recursive: true });
    renameSync(source, target);
    movedTops.set(rel, true);
  }
  const moved: string[] = [];
  const missing: string[] = [];
  for (const { path, rel } of items) {
    const top = topAncestor(rel);
    const wasMoved = top === undefined ? movedTops.get(rel) === true : movedTops.get(top) === true && existedBefore.get(rel) === true;
    (wasMoved ? moved : missing).push(path);
  }
  return { result: "trashed", trash_id: moved.length === 0 ? null : id, moved, missing };
}

function move(dir: string, realDir: string, from: string, to: string): ProjectFilesResult {
  const fromRel = checkPath(dir, realDir, from);
  if (fromRel === undefined) return { result: "invalid_path", path: from };
  const toRel = checkPath(dir, realDir, to);
  // to は移動先の名前まで書く（末尾が / ならだめ）。自分の中には移せない
  if (toRel === undefined || to.endsWith("/") || toRel.startsWith(`${fromRel}${sep}`)) {
    return { result: "invalid_path", path: to };
  }
  if (!exists(join(dir, fromRel))) return { result: "missing", path: from };
  if (exists(join(dir, toRel))) return { result: "exists", path: to };
  mkdirSync(dirname(join(dir, toRel)), { recursive: true });
  renameSync(join(dir, fromRel), join(dir, toRel));
  return { result: "moved", from, to };
}

async function clear(dir: string, options: ProjectFilesOptions): Promise<ProjectFilesResult> {
  let names: string[];
  try {
    names = readdirSync(dir).filter((name) => name !== TRASH_DIR_NAME);
  } catch (error) {
    if (!hasCode(error, "ENOENT")) throw error;
    names = [];
  }
  let id: string | null = null;
  if (names.length > 0) {
    const trashRoot = join(dir, TRASH_DIR_NAME);
    id = nextTrashId(trashRoot, options.now);
    mkdirSync(join(trashRoot, id), { recursive: true });
    for (const name of names) renameSync(join(dir, name), join(trashRoot, id, name));
  }
  const { copied, failed } = await copyWebScaffold(dir, "created", options.templateDir);
  // 中身は .trash に移し終えているので、結果はそのまま返す（パス・例外の中身は出さない）
  if (failed) options.log("project_files: UI の土台の複製に失敗しました");
  return { result: "cleared", trash_id: id, scaffold: copied };
}

function listTrashes(dir: string): ProjectFilesResult {
  const trashRoot = join(dir, TRASH_DIR_NAME);
  let names: string[];
  try {
    names = readdirSync(trashRoot);
  } catch (error) {
    if (!hasCode(error, "ENOENT", "ENOTDIR")) throw error;
    names = [];
  }
  const ids = names.filter((name) => TRASH_ID_PATTERN.test(name) && isRealDirectory(join(trashRoot, name)));
  return {
    result: "list",
    trashes: ids.sort(compareNewestFirst).map((id) => ({ trash_id: id, files: countFiles(join(trashRoot, id)) })),
  };
}

/**
 * path（実際のディレクトリ）の中の空のディレクトリを下から rmdir し、最後に path そのものを rmdir する（再帰の rm は使わない。symlink はたどらない）。
 * ディレクトリ以外が残っていれば ENOTEMPTY で投げる
 */
function removeEmptyDirs(path: string): void {
  for (const name of readdirSync(path)) {
    const child = join(path, name);
    if (isRealDirectory(child)) removeEmptyDirs(child);
  }
  rmdirSync(path);
}

function restore(dir: string, id: string, log: (message: string) => void): ProjectFilesResult {
  const trashDir = join(dir, TRASH_DIR_NAME, id);
  if (!TRASH_ID_PATTERN.test(id) || !isRealDirectory(trashDir)) return { result: "not_found", trash_id: id };
  const entries = collectEntries(trashDir);
  const conflicts = new Set<string>();
  for (const rel of entries) {
    const blocking = blockingPath(dir, rel);
    if (blocking !== undefined) conflicts.add(blocking);
  }
  if (conflicts.size > 0) return { result: "conflict", paths: [...conflicts] };
  for (const rel of entries) {
    const target = join(dir, rel);
    mkdirSync(dirname(target), { recursive: true });
    renameSync(join(trashDir, rel), target);
  }
  // 残っているのは空のディレクトリだけのはず。何か残っていて（途中で足された・消せない）も戻すのは済んでいるので、残して log だけ（パスは出さない）
  try {
    removeEmptyDirs(trashDir);
  } catch {
    log("project_files: 戻した後の .trash を消せませんでした");
  }
  return { result: "restored", trash_id: id, restored: entries };
}

/**
 * dir（`<projectsDir>/<slug>`）のファイルを操作する。パスは dir からの相対で、どれか 1 つでもだめなら何もせずに invalid_path。
 * trash・move は dir が無い・解決できなければ not_available。trash・clear・restore は `<dir>/.trash` が実際のディレクトリでない
 * （symlink・ファイル）なら何もせず trash_unavailable（無いのはよい）。
 * - trash: paths を `.trash/<trash_id>/<同じ相対パス>` に移す。無いものは missing。1 つも移さなければ .trash/<trash_id> を作らず trash_id は null
 * - move: paths[0] を to に移す（上書きしない。to の末尾が / なら invalid_path）
 * - clear: 直下の .trash 以外をすべて `.trash/<trash_id>/` に移し、UI の土台（created の 5 つ）を置き直す
 * - restore: trash_id を省けば一覧（新しい順）。指定すればその中身を元の場所に戻す（1 つでも既にあれば何も戻さず conflict）
 */
export async function runProjectFiles(
  dir: string,
  args: ProjectFilesArgs,
  options: ProjectFilesOptions,
): Promise<ProjectFilesResult> {
  const realDir = resolveRealPath(dir);
  const dirMissing = realDir === undefined || !isRealDirectory(realDir);
  const trashRoot = join(dir, TRASH_DIR_NAME);
  const trashUnavailable = exists(trashRoot) && !isRealDirectory(trashRoot);
  const notAvailable: ProjectFilesResult = { result: "not_available", message: PROJECT_DIR_MISSING_MESSAGE };
  const unavailable: ProjectFilesResult = { result: "trash_unavailable", message: TRASH_UNAVAILABLE_MESSAGE };
  switch (args.action) {
    case "trash": {
      if (args.paths === undefined || args.paths.length === 0 || args.paths.length > PROJECT_FILES_MAX_PATHS) {
        return invalidArgs(`trash には paths を 1〜${PROJECT_FILES_MAX_PATHS} 件指定してください`);
      }
      const extra = extraArgs(args, ["paths"]);
      if (extra !== undefined) return invalidArgs(extra);
      if (dirMissing) return notAvailable;
      if (trashUnavailable) return unavailable;
      return trash(dir, realDir, args.paths, options.now);
    }
    case "move": {
      if (args.paths === undefined || args.paths.length !== 1) return invalidArgs("move には paths を 1 件だけ指定してください");
      if (args.to === undefined) return invalidArgs("move には to を指定してください");
      const extra = extraArgs(args, ["paths", "to"]);
      if (extra !== undefined) return invalidArgs(extra);
      if (dirMissing) return notAvailable;
      return move(dir, realDir, args.paths[0]!, args.to);
    }
    case "clear": {
      const extra = extraArgs(args, []);
      if (extra !== undefined) return invalidArgs(extra);
      if (trashUnavailable) return unavailable;
      return clear(dir, options);
    }
    case "restore": {
      const extra = extraArgs(args, ["trash_id"]);
      if (extra !== undefined) return invalidArgs(extra);
      if (trashUnavailable) return unavailable;
      return args.trash_id === undefined ? listTrashes(dir) : restore(dir, args.trash_id, options.log);
    }
    default:
      return invalidArgs("action は trash・move・clear・restore のどれかを指定してください");
  }
}

/**
 * `<projectsDir>/<slug>/.trash/<name>` のうち、name が trash_id の形で、その時刻から days 日を過ぎたものを消す。
 * 形に合わない名前・ディレクトリでないもの（symlink を含む）は触らない（symlink の先も触らない）。projectsDir や .trash が無ければ何もしない。
 * 消すのは removeTree（symlink をたどらない rm）。1 つ消せなくても残りは続け、最後に失敗の数だけを投げる
 */
export async function pruneProjectTrash(projectsDir: string, now: Date, days = TRASH_RETENTION_DAYS): Promise<void> {
  let projects: string[];
  try {
    projects = readdirSync(projectsDir);
  } catch (error) {
    if (hasCode(error, "ENOENT")) return;
    throw error;
  }
  // 1 つ失敗しても残りは続け、最後にまとめて投げる（message にパスは入れない）
  let failures = 0;
  for (const project of projects) {
    try {
      const projectDir = join(projectsDir, project);
      const trashRoot = join(projectDir, TRASH_DIR_NAME);
      if (!isRealDirectory(projectDir) || !isRealDirectory(trashRoot)) continue;
      for (const name of readdirSync(trashRoot)) {
        const parsed = TRASH_ID_PATTERN.test(name) ? parseTrashId(name) : undefined;
        if (parsed === undefined || now.getTime() - parsed.time <= days * DAY_MS) continue;
        const target = join(trashRoot, name);
        try {
          if (isRealDirectory(target)) await removeTree(target);
        } catch {
          failures++;
        }
      }
    } catch {
      failures++;
    }
  }
  if (failures > 0) throw new Error(`古い .trash の削除で ${failures} 件失敗しました`);
}
