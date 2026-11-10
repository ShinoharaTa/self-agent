// ~/.claude の内部形式の読み取り（docs/plan/claude-code-sessions.md §1・§2.2）。公式でないので、RC のリンク（bridgeSessionId）・tmux の欄と
// 記録（jsonl）の最後の会話の時刻の補助だけに使い、ここに閉じ込める。形が合わなければ undefined にし、例外にしない。
// 読むのは `sessions/<pid>.json` の決まった欄と、記録の末尾の行の type・timestamp だけ（本文は持たない・`<pid>.<hex>.key` は読まない）。書き込みはしない
import { closeSync, openSync, readFileSync, readSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** sessions/<pid>.json の大きさの上限（これを超えるものは形が違うとみなす） */
const SESSION_FILE_MAX_BYTES = 64 * 1024;

/** 記録の末尾から最後の会話の行を探す範囲（バイト。見つからなければ次の大きさで読み直す） */
export const TRANSCRIPT_TAIL_BYTES: readonly number[] = [256 * 1024, 2 * 1024 * 1024];
/** 覚えておく記録の数の上限 */
const TRANSCRIPT_CACHE_MAX = 500;
/** 会話の行の type（それ以外の行（bridge-session・custom-title・mode・system など）は会話が無くても書き換わるので数えない。#310） */
const CONVERSATION_TYPES = new Set(["user", "assistant"]);

/**
 * jsonl の末尾の chunk から、最後の会話の行（type が user・assistant で timestamp が読める）の時刻（ミリ秒）。無ければ undefined。
 * whole が false なら chunk の先頭は行の途中かもしれないので最初の行を捨てる。
 * 記録は追記の順なので、末尾から最初に見つかった行を最後とみなす（最大値は取らない）。1 行が読む範囲より長ければその行は読めず、前の行か undefined になる
 */
export function lastConversationAt(chunk: string, whole: boolean): number | undefined {
  const lines = chunk.split("\n");
  const first = whole ? 0 : 1;
  for (let i = lines.length - 1; i >= first; i -= 1) {
    const line = lines[i]!.trim();
    if (line === "" || !line.includes('"timestamp"')) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) continue;
    const item = parsed as Record<string, unknown>;
    if (typeof item.type !== "string" || !CONVERSATION_TYPES.has(item.type) || typeof item.timestamp !== "string") continue;
    const at = Date.parse(item.timestamp);
    if (Number.isFinite(at)) return at;
  }
  return undefined;
}

/** `session_…`（`https://claude.ai/code/<id>` の id） */
const BRIDGE_SESSION_PATTERN = /^session_[A-Za-z0-9_-]{1,128}$/;
/**
 * `<session>:@<window_id>.%<pane>`（実際のファイルの形。例 `foo:@12.%34`）か `<session>:<window>.%<pane>`。
 * tmux のセッション名は改行・制御文字を含まない
 */
const TMUX_PATTERN = /^[^\u0000-\u001f\u007f]{1,200}:@?\d{1,6}\.%\d{1,9}$/;

/** sessions/<pid>.json から読む欄（どちらも形が合わなければ undefined） */
export type SessionFileInfo = {
  bridgeSessionId: string | undefined;
  /** `<session>:@<window_id>.%<pane>`（か `<session>:<window>.%<pane>`） */
  tmux: string | undefined;
};

/** 記録のディレクトリの名前（cwd の英数字以外を `-` に） */
export function projectDirName(cwd: string): string {
  return cwd.replace(/[^A-Za-z0-9]/g, "-");
}

export class ClaudeDirs {
  private readonly claudeDir: string;
  /** 記録ごとの最後に読んだ mtime・大きさと結果（変わっていなければ読み直さない） */
  private readonly lastAtCache = new Map<string, { mtimeMs: number; size: number; at: number | undefined }>();

  /** home は ~ の場所（既定は os.homedir()）。テストでは一時ディレクトリを渡す */
  constructor(home: string = homedir()) {
    this.claudeDir = join(home, ".claude");
  }

  /**
   * `sessions/<pid>.json` の bridgeSessionId・tmux。無い・読めない・JSON のオブジェクトでない・大きすぎる・
   * sessionId の欄が無いか sessionId と違う（pid が使い回された古いファイル）なら undefined
   */
  sessionFile(pid: number, sessionId: string): SessionFileInfo | undefined {
    if (!Number.isSafeInteger(pid) || pid < 1) return undefined;
    try {
      const path = join(this.claudeDir, "sessions", `${pid}.json`);
      const stat = statSync(path);
      if (!stat.isFile() || stat.size > SESSION_FILE_MAX_BYTES) return undefined;
      const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return undefined;
      const item = parsed as Record<string, unknown>;
      if (item.sessionId !== sessionId) return undefined;
      const bridge = item.bridgeSessionId;
      const tmux = item.tmux;
      return {
        bridgeSessionId: typeof bridge === "string" && BRIDGE_SESSION_PATTERN.test(bridge) ? bridge : undefined,
        tmux: typeof tmux === "string" && TMUX_PATTERN.test(tmux) ? tmux : undefined,
      };
    } catch {
      return undefined;
    }
  }

  /**
   * 記録（`projects/<cwd を - に>/<sessionId>.jsonl`）の最後の会話の行（user・assistant）の timestamp（エポックからのミリ秒）。
   * mtime は会話が無くても進む（RC の連携のメタデータなどを書き換える）ので使わない（#310）。末尾を TRANSCRIPT_TAIL_BYTES ずつ読み、
   * mtime・大きさが前回と同じなら読み直さない。無い・ファイルでない・会話の行が無い・読めなければ undefined。本文は残さない
   */
  transcriptLastAt(cwd: string, sessionId: string): number | undefined {
    if (!/^[0-9a-fA-F-]{36}$/.test(sessionId)) return undefined;
    const path = join(this.claudeDir, "projects", projectDirName(cwd), `${sessionId}.jsonl`);
    try {
      const stat = statSync(path);
      if (!stat.isFile()) return undefined;
      const cached = this.lastAtCache.get(path);
      if (cached !== undefined && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) return cached.at;
      const at = readLastConversationAt(path, stat.size);
      // 一覧から消えたセッションの分が溜まり続けないよう、上限を超えたら覚えた分を捨てて読み直す
      if (this.lastAtCache.size >= TRANSCRIPT_CACHE_MAX) this.lastAtCache.clear();
      this.lastAtCache.set(path, { mtimeMs: stat.mtimeMs, size: stat.size, at });
      return at;
    } catch {
      return undefined;
    }
  }
}

/** ファイルの末尾を TRANSCRIPT_TAIL_BYTES の順に読んで lastConversationAt を探す */
function readLastConversationAt(path: string, size: number): number | undefined {
  const fd = openSync(path, "r");
  try {
    for (const limit of TRANSCRIPT_TAIL_BYTES) {
      const length = Math.min(size, limit);
      const buffer = Buffer.alloc(length);
      const read = readSync(fd, buffer, 0, length, size - length);
      const at = lastConversationAt(buffer.subarray(0, read).toString("utf8"), length === size);
      if (at !== undefined || length === size) return at;
    }
    return undefined;
  } finally {
    closeSync(fd);
  }
}
