// ファイル操作（Read・Write・Edit・Glob・Grep）の可否の判定。sdk-runner.ts の PreToolUse の hook と query-options.ts で使う
import { lstatSync, realpathSync } from "node:fs";
import { basename, dirname, join, resolve, sep } from "node:path";
import type { RunContext } from "./runner.ts";

/** 判定するツール（PreToolUse の hook の対象） */
export const FILE_TOOLS: readonly string[] = ["Read", "Write", "Edit", "Glob", "Grep"];
/** 書き込むツール。このチャンネルのプロジェクトの中だけを許す */
export const FILE_WRITE_TOOLS: readonly string[] = ["Write", "Edit"];

/** Write・Edit を拒否したときにモデルへ返す理由 */
export const FILE_WRITE_DENIED_REASON = "このチャンネルのプロジェクトの中だけに書けます。先に project_open を使ってください";
/** Read・Glob・Grep を拒否したときにモデルへ返す理由 */
export const FILE_READ_DENIED_REASON = "読めるのはプロジェクトのディレクトリの中だけです。project_open が返した dir の中を指定してください";
/** context の無いターン（#inbox の要約のターン）で拒否したときにモデルへ返す理由 */
export const FILE_NO_CONTEXT_REASON = "このターンではファイルを扱えません";

export type FileAccessRequest = {
  toolName: string;
  toolInput: unknown;
  /** 相対パスの基準。Glob・Grep で path が無ければ、ここを対象にする */
  cwd: string;
  context: RunContext | undefined;
  /** `<workDir>/projects` */
  projectsDir: string;
  /** context のチャンネルの削除されていないプロジェクト。無ければ undefined */
  project: { slug: string } | undefined;
};

export type FileAccessDecision = { allowed: true } | { allowed: false; reason: string };

function isNotFound(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

/**
 * パスの実際の場所。絶対パスにし、存在する一番深い親（パスそのものを含む）の realpath に、まだ無い残りの部分を足す。
 * 解決できない（壊れた symlink・symlink のループ・途中がファイル・読めないなど）なら undefined
 */
export function resolveRealPath(path: string): string | undefined {
  const rest: string[] = [];
  let current = resolve(path);
  for (;;) {
    try {
      return join(realpathSync.native(current), ...rest);
    } catch (error) {
      if (!isNotFound(error)) return undefined;
    }
    // 壊れた symlink（lstat はできる）は、書き込むと先に作られるので解決できないことにする
    try {
      lstatSync(current);
      return undefined;
    } catch (error) {
      if (!isNotFound(error)) return undefined;
    }
    const parent = dirname(current);
    if (parent === current) return undefined;
    rest.unshift(basename(current));
    current = parent;
  }
}

/** child が dir の中か（dir そのものは含まない） */
function isInside(child: string, dir: string): boolean {
  return child.startsWith(dir.endsWith(sep) ? dir : dir + sep);
}

/** ツールの入力の対象のパス。Read・Write・Edit は file_path、Glob・Grep は path（無ければ cwd）。形が違えば undefined */
function targetPath(toolName: string, toolInput: unknown, cwd: string): string | undefined {
  const input = typeof toolInput === "object" && toolInput !== null ? (toolInput as Record<string, unknown>) : {};
  if (toolName === "Glob" || toolName === "Grep") {
    if (input.path === undefined || input.path === null) return cwd;
    return typeof input.path === "string" ? input.path : undefined;
  }
  return typeof input.file_path === "string" ? input.file_path : undefined;
}

/**
 * Glob の pattern・Grep の glob が path の外を指しうるか。絶対パス（`/` か `~` で始まる）か、`/` で分けた要素に `..` があれば true。
 * 無い・文字列でなければ false（path だけで判定する）
 */
function patternEscapes(toolName: string, toolInput: unknown): boolean {
  const input = typeof toolInput === "object" && toolInput !== null ? (toolInput as Record<string, unknown>) : {};
  const pattern = toolName === "Glob" ? input.pattern : toolName === "Grep" ? input.glob : undefined;
  if (typeof pattern !== "string") return false;
  return pattern.startsWith("/") || pattern.startsWith("~") || pattern.split("/").includes("..");
}

/**
 * ファイル操作を許すか。対象のパスは cwd を基準に絶対パスにし、resolveRealPath で実際の場所にして判定する（symlink・`..` で外に出られない）。
 * - context が無い: すべて拒否
 * - Write・Edit: #inbox・プロジェクトの無いチャンネルでは拒否。対象が `<realpath(projectsDir)>/<slug>/` の中でなければ拒否
 * - Read・Glob・Grep: 対象が `<realpath(projectsDir)>/` の中でなければ拒否。Glob の pattern・Grep の glob が絶対パスか `..` を含めば拒否
 * FILE_TOOLS 以外のツールは何もせず許す
 */
export function judgeFileAccess(request: FileAccessRequest): FileAccessDecision {
  const { toolName, toolInput, cwd, context, projectsDir, project } = request;
  if (!FILE_TOOLS.includes(toolName)) return { allowed: true };
  if (context === undefined) return { allowed: false, reason: FILE_NO_CONTEXT_REASON };
  const write = FILE_WRITE_TOOLS.includes(toolName);
  const denied: FileAccessDecision = { allowed: false, reason: write ? FILE_WRITE_DENIED_REASON : FILE_READ_DENIED_REASON };
  if (write && (context.kind !== "session" || project === undefined)) return denied;
  if (patternEscapes(toolName, toolInput)) return denied;
  const raw = targetPath(toolName, toolInput, cwd);
  const target = raw === undefined ? undefined : resolveRealPath(resolve(cwd, raw));
  const projects = resolveRealPath(projectsDir);
  if (target === undefined || projects === undefined) return denied;
  const allowedDir = write && project !== undefined ? join(projects, project.slug) : projects;
  return isInside(target, allowedDir) ? { allowed: true } : denied;
}
