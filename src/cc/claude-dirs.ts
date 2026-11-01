// ~/.claude の内部形式の読み取り（docs/plan/claude-code-sessions.md §1・§2.2）。公式でないので、RC のリンク（bridgeSessionId）・tmux の欄と
// 記録（jsonl）の mtime の補助だけに使い、ここに閉じ込める。形が合わなければ undefined にし、例外にしない。
// 読むのは `sessions/<pid>.json` の決まった欄と、記録のファイルの stat だけ（記録の中身・`<pid>.<hex>.key` は読まない）。書き込みはしない
import { readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** sessions/<pid>.json の大きさの上限（これを超えるものは形が違うとみなす） */
const SESSION_FILE_MAX_BYTES = 64 * 1024;

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

  /** 記録（`projects/<cwd を - に>/<sessionId>.jsonl`）の mtime（エポックからのミリ秒）。無い・ファイルでなければ undefined。中身は読まない */
  transcriptMtime(cwd: string, sessionId: string): number | undefined {
    if (!/^[0-9a-fA-F-]{36}$/.test(sessionId)) return undefined;
    try {
      const stat = statSync(join(this.claudeDir, "projects", projectDirName(cwd), `${sessionId}.jsonl`));
      return stat.isFile() ? stat.mtimeMs : undefined;
    } catch {
      return undefined;
    }
  }
}
