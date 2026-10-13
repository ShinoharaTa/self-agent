// 二重起動の防止: `<dataDir>/lock` に起動したプロセスの PID を置く。同じ DB を 2 プロセスが使うと同じ発言に 2 回答えるため（docs/plan/personas.md §1）
import { linkSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export type DataLock = {
  /** ロックを外す（ファイルの PID が自分のときだけ消す）。何度呼んでもよい */
  release: () => void;
};

export type DataLockOptions = {
  /** 自分の PID。既定 process.pid */
  pid?: number;
  /** その PID のプロセスが生きているか。既定は signal 0 を送って確かめる */
  isAlive?: (pid: number) => boolean;
};

export function lockPath(dataDir: string): string {
  return join(dataDir, "lock");
}

/** ESRCH（そのプロセスが無い）なら false。EPERM（別ユーザーのプロセス）は生きているとみなす */
function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** ロックのファイルの PID。無ければ undefined、読めても PID の形でなければ null */
function readLockPid(path: string): number | null | undefined {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  const pid = /^\d+\n?$/.test(text) ? Number(text.trim()) : Number.NaN;
  return Number.isSafeInteger(pid) && pid > 0 ? pid : null;
}

/** 書き終えた一時ファイルを link で置く（ファイルがあれば EEXIST）。読む側が書きかけのファイルを見ないように */
function tryCreate(path: string, pid: number): boolean {
  const temp = `${path}.${pid}.tmp`;
  writeFileSync(temp, `${pid}\n`, { mode: 0o600 });
  try {
    linkSync(temp, path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw error;
  } finally {
    unlinkSync(temp);
  }
}

/**
 * `<dataDir>/lock` を取る。ほかの生きているプロセスが持っていればエラー。
 * 持ち主のプロセスがもう無い（PID の形でない場合を含む）ロックは古いものとして消して取り直す（取り直しは 1 回だけ）
 */
export function acquireDataLock(dataDir: string, options: DataLockOptions = {}): DataLock {
  const pid = options.pid ?? process.pid;
  const isAlive = options.isAlive ?? processAlive;
  const path = lockPath(dataDir);
  mkdirSync(dataDir, { recursive: true });

  for (let attempt = 0; ; attempt++) {
    if (tryCreate(path, pid)) break;
    const holder = readLockPid(path);
    if (holder === undefined && attempt === 0) continue; // 読む前に外れた
    if (typeof holder === "number" && holder !== pid && isAlive(holder)) {
      throw new Error(`別の self-agent（PID ${holder}）が同じ SELF_AGENT_DATA_DIR を使っているため起動できません`);
    }
    if (attempt > 0) {
      throw new Error("SELF_AGENT_DATA_DIR のロック（<SELF_AGENT_DATA_DIR>/lock）を取れませんでした");
    }
    // 古いロック。読んだ後に別のプロセスが取り直していなければ消す
    if (readLockPid(path) === holder) {
      try {
        unlinkSync(path);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
  }

  let released = false;
  return {
    release: () => {
      if (released) return;
      released = true;
      try {
        if (readLockPid(path) === pid) unlinkSync(path);
      } catch {
        // 消せなくても次の起動で古いロックとして扱う
      }
    },
  };
}
