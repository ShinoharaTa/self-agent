// 二重起動の防止: `<dataDir>/lock` に起動したプロセスの PID と boot id を置く。同じ DB を 2 プロセスが使うと同じ発言に 2 回答えるため（docs/plan/personas.md §1）
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
  /** 今の起動の boot id。読めなければ undefined。既定は /proc/sys/kernel/random/boot_id */
  readBootId?: () => string | undefined;
  /** その PID のプロセスのコマンドライン（引数を空白でつないだもの）。読めなければ undefined。既定は /proc/<pid>/cmdline */
  readCmdline?: (pid: number) => string | undefined;
};

/** この Bot のプロセスのコマンドラインに含まれる文字列（npm start は node … src/main.ts） */
const BOT_COMMAND = "src/main.ts";

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

function procBootId(): string | undefined {
  try {
    const id = readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
    return id === "" ? undefined : id;
  } catch {
    return undefined;
  }
}

function procCmdline(pid: number): string | undefined {
  try {
    return readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0").join(" ").trim();
  } catch {
    return undefined;
  }
}

/** ロックのファイルの中身。無ければ undefined */
function readLockText(path: string): string | undefined {
  try {
    return readFileSync(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

type LockHolder = { pid: number; bootId: string | undefined };

/** 1 行目が PID、2 行目（任意）が boot id。形が違えば null */
function parseLock(text: string): LockHolder | null {
  const lines = text.split("\n");
  if (lines.at(-1) === "") lines.pop();
  if (lines.length < 1 || lines.length > 2 || !/^\d+$/.test(lines[0]!)) return null;
  const pid = Number(lines[0]);
  if (!Number.isSafeInteger(pid) || pid < 1) return null;
  const bootId = lines[1]?.trim();
  return { pid, bootId: bootId === undefined || bootId === "" ? undefined : bootId };
}

/** 書き終えた一時ファイルを link で置く（ファイルがあれば EEXIST）。読む側が書きかけのファイルを見ないように */
function tryCreate(path: string, pid: number, content: string): boolean {
  const temp = `${path}.${pid}.tmp`;
  writeFileSync(temp, content, { mode: 0o600 });
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
 * `<dataDir>/lock`（PID と boot id）を取る。ほかの self-agent が動いていればエラー。
 * 次のロックは古いものとして消して取り直す（取り直しは 1 回だけ）: 形が違う・自分の PID・boot id が今と違う（再起動の前のもの）・
 * PID のプロセスが無い・PID のプロセスはあるがコマンドラインがこの Bot（src/main.ts）でない（PID の再利用）。
 * boot id・コマンドラインが読めなければ、その確認は飛ばす（PID が生きていれば動いているとみなす）
 */
export function acquireDataLock(dataDir: string, options: DataLockOptions = {}): DataLock {
  const pid = options.pid ?? process.pid;
  const isAlive = options.isAlive ?? processAlive;
  const readCmdline = options.readCmdline ?? procCmdline;
  const bootId = (options.readBootId ?? procBootId)();
  const path = lockPath(dataDir);
  mkdirSync(dataDir, { recursive: true });

  const running = (holder: LockHolder): boolean => {
    if (holder.pid === pid) return false;
    if (holder.bootId !== undefined && bootId !== undefined && holder.bootId !== bootId) return false;
    if (!isAlive(holder.pid)) return false;
    const cmdline = readCmdline(holder.pid);
    return cmdline === undefined || cmdline.includes(BOT_COMMAND);
  };

  const content = bootId === undefined ? `${pid}\n` : `${pid}\n${bootId}\n`;
  for (let attempt = 0; ; attempt++) {
    if (tryCreate(path, pid, content)) break;
    const text = readLockText(path);
    if (text === undefined && attempt === 0) continue; // 読む前に外れた
    const holder = text === undefined ? null : parseLock(text);
    if (holder !== null && running(holder)) {
      throw new Error(`別の self-agent（PID ${holder.pid}）が同じ SELF_AGENT_DATA_DIR を使っているため起動できません`);
    }
    if (attempt > 0) {
      throw new Error("SELF_AGENT_DATA_DIR のロック（<SELF_AGENT_DATA_DIR>/lock）を取れませんでした");
    }
    // 古いロック。読んだ後に別のプロセスが取り直していなければ消す
    if (readLockText(path) === text) {
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
        const text = readLockText(path);
        if (text !== undefined && parseLock(text)?.pid === pid) unlinkSync(path);
      } catch {
        // 消せなくても次の起動で古いロックとして扱う
      }
    },
  };
}
