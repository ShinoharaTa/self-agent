// 取り込み（docs/plan/takeover.md §3.3・§3.4。#341）の記録のファイル。元（~/.claude/projects/<cwd を - に>/<session_id>.jsonl）を
// CLAUDE_CONFIG_DIR の同じ場所へ写す。書くのは CLAUDE_CONFIG_DIR の中だけで、~/.claude には書かない。本文は解釈しない（写すのと、増えた行を返すだけ）。
// log は出さない（パス・session_id は呼び出し側も出さない）
import { closeSync, constants, fchmodSync, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readSync, realpathSync, renameSync, rmSync, writeSync } from "node:fs";
import { dirname, join, sep } from "node:path";
import { isUuid } from "./agents.ts";
import { projectDirName } from "./claude-dirs.ts";
import { TAKEOVER_MAX_BYTES } from "./takeover-rules.ts";

/** 写すときの読み書きの単位 */
const COPY_CHUNK_BYTES = 1024 * 1024;

export type TakeoverPaths = {
  /** 元の記録（~/.claude の下） */
  src: string;
  /** 写し先のディレクトリ（CLAUDE_CONFIG_DIR の下） */
  dstDir: string;
  /** 写し先の記録 */
  dst: string;
};

/** 元と写し先の場所。sessionId が UUID の形でなければ undefined */
export function takeoverPaths(home: string, configDir: string, cwd: string, sessionId: string): TakeoverPaths | undefined {
  if (!isUuid(sessionId)) return undefined;
  const name = projectDirName(cwd);
  const file = `${sessionId}.jsonl`;
  const dstDir = join(configDir, "projects", name);
  return { src: join(home, ".claude", "projects", name, file), dstDir, dst: join(dstDir, file) };
}

/** 元の記録の検査の結果。大きさと mtime は確かめ直し（§3.4）で比べる */
export type SourceInspection =
  | { ok: true; size: number; mtimeMs: number }
  | { ok: false; reason: "no_transcript" | "too_large" };

/** 元の記録を lstat で見る。無い・通常ファイルでない（symlink を含む）は no_transcript、TAKEOVER_MAX_BYTES を超えれば too_large */
export function inspectSource(path: string): SourceInspection {
  let stat;
  try {
    stat = lstatSync(path);
  } catch {
    return { ok: false, reason: "no_transcript" };
  }
  if (!stat.isFile()) return { ok: false, reason: "no_transcript" };
  if (stat.size > TAKEOVER_MAX_BYTES) return { ok: false, reason: "too_large" };
  return { ok: true, size: stat.size, mtimeMs: stat.mtimeMs };
}

function realOrUndefined(path: string): string | undefined {
  try {
    return realpathSync(path);
  } catch {
    return undefined;
  }
}

/**
 * 写し先のディレクトリを作る（mkdir -p。作るものは mode 700。§5.1）。作った後の実体が元のディレクトリ（srcDir）と同じなら shared、
 * CLAUDE_CONFIG_DIR の projects（projectsRoot）の下なら ready、ほか（mkdir の失敗・projects の外を指す symlink を含む）は invalid
 */
export function prepareTarget(dir: string, projectsRoot: string, srcDir: string): "ready" | "shared" | "invalid" {
  let real: string;
  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    real = realpathSync(dir);
    if (!lstatSync(real).isDirectory()) return "invalid";
  } catch {
    return "invalid";
  }
  if (real === realOrUndefined(srcDir)) return "shared";
  return insideProjects(real, projectsRoot) ? "ready" : "invalid";
}

/** 実体のパス real が CLAUDE_CONFIG_DIR の projects（projectsRoot の実体）の下か（prepareTarget の ready と copyTranscript の確かめ直しで共通） */
function insideProjects(real: string, projectsRoot: string): boolean {
  const root = realOrUndefined(projectsRoot);
  if (root === undefined) return false;
  return real.startsWith(root.endsWith(sep) ? root : root + sep);
}

function exists(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * 記録を写す（§3.3）。copied = 写した、shared = 元と写し先のディレクトリの実体が同じ（写さない）、already_taken = 写し先に同じ名前があり
 * channel_sessions にその session_id の行がある（hasMapping。写さない）。行が無ければ古い方を `<名前>.old` に退けてから写す（あれば上書き）。
 * 元を開く前に、写し先のディレクトリの実体が projectsRoot の下かを確かめ直す（prepareTarget の ready と同じ条件）。
 * 写し先のディレクトリが projects の外・元が通常ファイルでない（symlink・FIFO を含む）・TAKEOVER_MAX_BYTES を超える・読み書きに失敗したときは例外（copy_failed）。
 * 一時名（排他・mode 600）に写して fsync してから rename する。失敗したら一時ファイルは消す。now は一時名にだけ使う。
 * 根拠の確かめは O_NOFOLLOW・O_NONBLOCK で開いた元の fstat（inspectSource は事前の検査）
 */
export function copyTranscript(input: {
  src: string;
  dst: string;
  projectsRoot: string;
  hasMapping: boolean;
  now?: () => Date;
}): "copied" | "shared" | "already_taken" {
  const now = input.now ?? (() => new Date());
  const dstDir = realpathSync(dirname(input.dst));
  if (realpathSync(dirname(input.src)) === dstDir) return "shared";
  if (!insideProjects(dstDir, input.projectsRoot)) throw new Error("取り込みの記録の写し先が projects の外です");
  const source = openSync(input.src, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = fstatSync(source);
    if (!stat.isFile()) throw new Error("取り込みの元の記録が通常ファイルではありません");
    if (stat.size > TAKEOVER_MAX_BYTES) throw new Error("取り込みの元の記録が大きすぎます");
    if (exists(input.dst)) {
      if (input.hasMapping) return "already_taken";
      renameSync(input.dst, `${input.dst}.old`);
    }
    const temp = `${input.dst}.tmp-${process.pid}-${now().getTime()}`;
    // O_EXCL で作れなければ（同じ名前が既にある）、その他人のファイルは消さずに例外にする
    const target = openSync(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    let closed = false;
    try {
      fchmodSync(target, 0o600);
      const buffer = Buffer.allocUnsafe(COPY_CHUNK_BYTES);
      let total = 0;
      for (;;) {
        const read = readSync(source, buffer, 0, buffer.length, null);
        if (read === 0) break;
        total += read;
        if (total > TAKEOVER_MAX_BYTES) throw new Error("取り込みの元の記録が大きすぎます");
        let written = 0;
        while (written < read) written += writeSync(target, buffer, written, read - written);
      }
      fsyncSync(target);
      // close が投げても二度は閉じない
      closed = true;
      closeSync(target);
      renameSync(temp, input.dst);
    } catch (error) {
      if (!closed) {
        closed = true;
        try {
          closeSync(target);
        } catch {
          // 元の例外を投げ直すので、ここでは何もしない
        }
      }
      try {
        rmSync(temp, { force: true });
      } catch {
        // 元の例外を投げ直すので、ここでは何もしない
      }
      throw error;
    }
    return "copied";
  } finally {
    closeSync(source);
  }
}

/**
 * fromSize（バイト）から後ろに増えた行（空の行は除く）。読めない・通常ファイルでない・fromSize より小さくなった（FIFO などに替えられても O_NONBLOCK で待たない）・増えた分が
 * TAKEOVER_MAX_BYTES を超えるときは undefined（増えた行の type を見る §3.4 のため。中身は呼び出し側が appendedInterrupted に渡すだけ）
 */
export function readAppended(path: string, fromSize: number): string[] | undefined {
  if (!Number.isSafeInteger(fromSize) || fromSize < 0) return undefined;
  let fd: number;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch {
    return undefined;
  }
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size < fromSize) return undefined;
    const length = stat.size - fromSize;
    if (length > TAKEOVER_MAX_BYTES) return undefined;
    const buffer = Buffer.alloc(length);
    let offset = 0;
    while (offset < length) {
      const read = readSync(fd, buffer, offset, length - offset, fromSize + offset);
      if (read === 0) break;
      offset += read;
    }
    return buffer
      .subarray(0, offset)
      .toString("utf8")
      .split("\n")
      .filter((line) => line.trim() !== "");
  } catch {
    return undefined;
  } finally {
    closeSync(fd);
  }
}
