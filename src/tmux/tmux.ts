// tmux の包み（docs/plan/github-notifications.md §5・§7.1）。アプリ（node）の特権の操作で、LLM のツールではない。
// execFile で起動時に解決した絶対パスの tmux を呼び、シェルを通さない。引数は固定の形（list-panes・list-clients・capture-pane・
// load-buffer・paste-buffer・delete-buffer・send-keys だけ）。送り先は pane_id（%N）で指し、セッション名では指さない
import { execFile } from "node:child_process";
import { homedir } from "node:os";
import { isAbsolute } from "node:path";

/** 子プロセスの打ち切りまでのミリ秒（§7.1） */
export const CHILD_TIMEOUT_MS = 20_000;
/** 子プロセスの出力の上限（§7.1） */
export const CHILD_MAX_BUFFER = 5 * 1024 * 1024;
/** 子プロセスの PATH（§7.1） */
export const CHILD_PATH = "/usr/local/bin:/usr/bin:/bin";
/** 1 回に貼れる文字数の上限（§5.4。テンプレートは 400 字以内） */
export const MAX_PASTE_CHARS = 400;

/** 子プロセスの終わり方。起動できなかった・時間切れ・出力の上限・シグナルで終わったときは code が null */
export type RunResult = { code: number | null; stdout: string; stderr: string };

/** 子プロセスを実行する関数。テストでは偽物に差し替える。input があれば標準入力に書いて閉じる */
export type RunCommand = (
  file: string,
  args: readonly string[],
  options: { env: Record<string, string>; timeoutMs: number; maxBuffer: number; input?: string },
) => Promise<RunResult>;

/** execFile で実行する（シェルは通さない）。reject しない */
export const execFileRunner: RunCommand = (file, args, { env, timeoutMs, maxBuffer, input }) =>
  new Promise((resolvePromise) => {
    let child: ReturnType<typeof execFile>;
    try {
      child = execFile(
        file,
        [...args],
        { env, timeout: timeoutMs, maxBuffer, encoding: "utf8", killSignal: "SIGKILL", windowsHide: true },
        (error, stdout, stderr) => {
          const code = error === null ? 0 : typeof error.code === "number" ? error.code : null;
          resolvePromise({ code, stdout: String(stdout), stderr: String(stderr) });
        },
      );
    } catch {
      resolvePromise({ code: null, stdout: "", stderr: "" });
      return;
    }
    // 子が先に終わったときの EPIPE で落ちないように
    child.stdin?.on("error", () => {});
    child.stdin?.end(input ?? "");
  });

/** tmux・git の子プロセスの env（許可方式。TMUX は渡さない = 既定のソケットを使う。トークン類は渡さない） */
export function childEnv(): Record<string, string> {
  return { HOME: homedir(), PATH: CHILD_PATH, LANG: "C.UTF-8" };
}

/** tmux の子プロセスの env。childEnv に、設定されていれば TMUX_TMPDIR（ソケットの場所）を足す */
export function tmuxEnv(): Record<string, string> {
  const tmpdir = process.env.TMUX_TMPDIR;
  return tmpdir === undefined || tmpdir === "" ? childEnv() : { ...childEnv(), TMUX_TMPDIR: tmpdir };
}

/** list-panes で取るペインの情報（§5.2 の 2） */
export type TmuxPane = {
  sessionName: string;
  windowIndex: number;
  paneIndex: number;
  /** `%N` */
  paneId: string;
  windowActive: boolean;
  paneActive: boolean;
  currentPath: string;
  currentCommand: string;
  /** コピーモードなど（pane_in_mode） */
  inMode: boolean;
  dead: boolean;
};

/** list-clients で取るクライアントの情報。activityAt は最後の活動の時刻（エポックからのミリ秒。tmux は秒で返す） */
export type TmuxClient = { sessionName: string; activityAt: number };

/** 失敗の種類。no_server = tmux のサーバーが動いていない、not_found = ペインが無い、failed = それ以外 */
export type TmuxFailure = "no_server" | "not_found" | "failed";

export type TmuxResult<T> = { ok: true; value: T } | { ok: false; reason: TmuxFailure };

export type Tmux = {
  listPanes(): Promise<TmuxResult<TmuxPane[]>>;
  listClients(): Promise<TmuxResult<TmuxClient[]>>;
  /** 見えている画面だけを SGR 付きで撮る（`capture-pane -p -e`） */
  capturePane(paneId: string): Promise<TmuxResult<string>>;
  /** text を名前付きのバッファ（handoffBufferName）に入れる。text が空・MAX_PASTE_CHARS 字を超える・制御文字がある（1 行のテンプレートだけを送る。§5.4）なら投げる */
  loadBuffer(handoffId: number, text: string): Promise<TmuxResult<void>>;
  /** 名前付きのバッファをペインに貼って消す（`paste-buffer -p -d`。オーナーの貼り付けのバッファは上書きしない）。貼れなければバッファを消してから失敗を返す */
  pasteBuffer(handoffId: number, paneId: string): Promise<TmuxResult<void>>;
  /** 名前付きのバッファを消す（`delete-buffer -b`）。無くても失敗を返すだけ */
  deleteBuffer(handoffId: number): Promise<TmuxResult<void>>;
  sendEnter(paneId: string): Promise<TmuxResult<void>>;
};

export type TmuxOptions = {
  /** 起動時に解決した tmux の絶対パス */
  tmuxPath: string;
  /** `-L` で使うソケットの名前。既定（未指定）は既定のソケット。手動の確認で別のサーバーを使うときだけ */
  socketName?: string;
  /** 既定は execFileRunner */
  run?: RunCommand;
};

/** list-panes の -F（タブ区切り。§5.2 の 2） */
export const PANE_FORMAT = [
  "#{session_name}",
  "#{window_index}",
  "#{pane_index}",
  "#{pane_id}",
  "#{window_active}",
  "#{pane_active}",
  "#{pane_current_path}",
  "#{pane_current_command}",
  "#{pane_in_mode}",
  "#{pane_dead}",
].join("\t");

/** list-clients の -F */
export const CLIENT_FORMAT = ["#{client_session}", "#{client_activity}"].join("\t");

const PANE_ID = /^%\d+$/;
const SOCKET_NAME = /^[A-Za-z0-9._-]+$/;
const INDEX = /^\d+$/;
const FLAG = /^[01]$/;
// C0・DEL・C1 の制御文字（改行・ESC を含む）
const CONTROL_CHARS = /[\u0000-\u001f\u007f-\u009f]/;

/** 送り込みに使う名前付きのバッファの名前（`self-agent-<handoff_id>`） */
export function handoffBufferName(handoffId: number): string {
  if (!Number.isSafeInteger(handoffId) || handoffId <= 0) throw new Error("handoff の ID は正の整数で指定してください");
  return `self-agent-${handoffId}`;
}

function assertPaneId(paneId: string): void {
  if (!PANE_ID.test(paneId)) throw new Error("ペインは %N の形で指定してください");
}

/**
 * list-panes の出力を読む。空行は飛ばす。欄の数が合わない・数字や 0/1 であるべき欄が違う行が 1 つでもある、
 * または同じ pane_id が 2 回出てきたら一覧ごと undefined（パスの改行・タブでペインの行を作られても、それを信じない。fail-closed）
 */
export function parsePanes(stdout: string): TmuxPane[] | undefined {
  const panes: TmuxPane[] = [];
  for (const line of stdout.split("\n")) {
    if (line === "") continue;
    const fields = line.split("\t");
    if (fields.length !== 10) return undefined;
    const [sessionName, windowIndex, paneIndex, paneId, windowActive, paneActive, currentPath, currentCommand, inMode, dead] =
      fields as [string, string, string, string, string, string, string, string, string, string];
    if (!INDEX.test(windowIndex) || !INDEX.test(paneIndex) || !PANE_ID.test(paneId)) return undefined;
    if (![windowActive, paneActive, inMode, dead].every((flag) => FLAG.test(flag))) return undefined;
    panes.push({
      sessionName,
      windowIndex: Number(windowIndex),
      paneIndex: Number(paneIndex),
      paneId,
      windowActive: windowActive === "1",
      paneActive: paneActive === "1",
      currentPath,
      currentCommand,
      inMode: inMode === "1",
      dead: dead === "1",
    });
  }
  return new Set(panes.map((pane) => pane.paneId)).size === panes.length ? panes : undefined;
}

/** list-clients の出力を読む。欄の数が合わない・時刻が数字でない行は捨てる */
export function parseClients(stdout: string): TmuxClient[] {
  const clients: TmuxClient[] = [];
  for (const line of stdout.split("\n")) {
    const fields = line.split("\t");
    if (fields.length !== 2) continue;
    const [sessionName, activity] = fields as [string, string];
    if (!INDEX.test(activity)) continue;
    clients.push({ sessionName, activityAt: Number(activity) * 1000 });
  }
  return clients;
}

/** 0 以外で終わったときの種類（stderr の決まった文言で分ける。stderr そのものは返さない） */
function failureOf(result: RunResult): TmuxFailure {
  if (result.code === null) return "failed";
  if (/no server running|error connecting to/i.test(result.stderr)) return "no_server";
  if (/can't find (pane|window|session)/i.test(result.stderr)) return "not_found";
  return "failed";
}

export function createTmux(options: TmuxOptions): Tmux {
  if (!isAbsolute(options.tmuxPath)) throw new Error("tmux は絶対パスで指定してください");
  if (options.socketName !== undefined && !SOCKET_NAME.test(options.socketName)) throw new Error("ソケットの名前が不正です");
  const run = options.run ?? execFileRunner;
  const prefix = options.socketName === undefined ? [] : ["-L", options.socketName];

  const exec = async (args: string[], input?: string): Promise<TmuxResult<string>> => {
    const result = await run(options.tmuxPath, [...prefix, ...args], {
      env: tmuxEnv(),
      timeoutMs: CHILD_TIMEOUT_MS,
      maxBuffer: CHILD_MAX_BUFFER,
      ...(input === undefined ? {} : { input }),
    });
    return result.code === 0 ? { ok: true, value: result.stdout } : { ok: false, reason: failureOf(result) };
  };
  const done = (result: TmuxResult<string>): TmuxResult<void> => (result.ok ? { ok: true, value: undefined } : result);

  return {
    async listPanes() {
      const result = await exec(["list-panes", "-a", "-F", PANE_FORMAT]);
      if (!result.ok) return result;
      const panes = parsePanes(result.value);
      return panes === undefined ? { ok: false, reason: "failed" } : { ok: true, value: panes };
    },
    async listClients() {
      const result = await exec(["list-clients", "-F", CLIENT_FORMAT]);
      return result.ok ? { ok: true, value: parseClients(result.value) } : result;
    },
    async capturePane(paneId) {
      assertPaneId(paneId);
      return exec(["capture-pane", "-p", "-e", "-t", paneId]);
    },
    async loadBuffer(handoffId, text) {
      const name = handoffBufferName(handoffId);
      if (CONTROL_CHARS.test(text)) throw new Error("送る文字列に制御文字（改行を含む）は使えません");
      const length = [...text].length;
      if (length === 0 || length > MAX_PASTE_CHARS) throw new Error(`送る文字列は 1〜${MAX_PASTE_CHARS} 字にしてください`);
      return done(await exec(["load-buffer", "-b", name, "-"], text));
    },
    async pasteBuffer(handoffId, paneId) {
      const name = handoffBufferName(handoffId);
      assertPaneId(paneId);
      const result = await exec(["paste-buffer", "-p", "-d", "-b", name, "-t", paneId]);
      // 貼れなければ -d が効かないので、名前付きのバッファを残さない
      if (!result.ok) await exec(["delete-buffer", "-b", name]);
      return done(result);
    },
    async deleteBuffer(handoffId) {
      return done(await exec(["delete-buffer", "-b", handoffBufferName(handoffId)]));
    },
    async sendEnter(paneId) {
      assertPaneId(paneId);
      return done(await exec(["send-keys", "-t", paneId, "Enter"]));
    },
  };
}
