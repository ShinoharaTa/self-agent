// Claude Code の新しいセッションの起動（docs/plan/claude-code-sessions.md §4.2・§7 の 5。CC4）。SELF_AGENT_WORKSPACE_DIR の直下の実際のディレクトリ
// （名前は CC_PROJECT_PATTERN、realpath がそのもの、workDir・dataDir・~/.config/self-agent・~/.claude・CLAUDE_CONFIG_DIR と重ならない。GitHub の [対応] の起動だけは 1 つ下も可。CC6）で、
// 既定のソケットの tmux に `new-session -d -P -F '#{session_id} #{pane_id}'` で `set -m; '<claude>' -n '<題名>' [--permission-mode '<mode>']; exec "$SHELL"` を起動する
// （set -m は非対話のシェルでも claude を自分のプロセスグループで前面に出し、tmux の pane_current_command を claude にするため）
// （tmux のサーバーが無ければ断る。決定 8）。引数は固定の形で、題名・モードは検証してから単引用符で囲む（`'` を含む題名は通さない）。
// セッション名は表示用で、オーナーの hook で変わりうるので、以後は返った $N・%N で追う。最初の指示は cc_sends にペイン宛て（origin start）で積み、
// 送るのは cc/sender.ts（入力待ちになるまで積んだまま。trust のダイアログにはキーを送らない）。起動したペインを一覧のセッションで見つけたら
// cc_sessions に started_by などを書く（cwd が起動したディレクトリの claude だけ）。起動から CC_TRUST_CHECK_DELAY_MS で、その後も CC_START_BIND_MS の間は
// tick ごとに、画面が trust のダイアログなら trust の確認待ちにし、消えたら外す（それより後・再起動の後は確認待ちの行だけを撮り直して外す）。
// 上限: 生きている claude が SELF_AGENT_CC_MAX_SESSIONS 以上・MemAvailable が 1 GB 未満・前の起動から 1 分未満なら断る。
// SDK のツール cc_start（CC7）は確認を出す前に check で検証と上限（1 分の間隔は除く）を確かめ、[起動する] で launch する。
// 起動したペインを一覧のセッションに結びつけたら onBound を呼ぶ（Claude Code のチャンネルを作る・最初の指示を写す。docs/plan/claude-code-channels.md §3.1。CC11）。
// log は起動したもの（web など）・送信の番号・件数・失敗の種類だけ（プロジェクト名・題名・パス・tmux のセッション名・ペイン id・sessionId は出さない）
import { lstatSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import type { Config } from "../config.ts";
import type { CcSendStore } from "../store/cc-sends.ts";
import type { CcSessionStore, CcStartedBy } from "../store/cc-sessions.ts";
import { classifyScreen, stripAnsi } from "../tmux/pane-state.ts";
import type { Tmux } from "../tmux/tmux.ts";
import { sessionOnStartedPane, type CcPaneResolver } from "./panes.ts";
import type { CcRegistry, CcTimers } from "./registry.ts";
import { normalizeSendText, type CcSender } from "./sender.ts";

/** 起動できるディレクトリの名前（直下だけ） */
export const CC_PROJECT_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
/** 題名（-n に渡す名前）。文字か数字で始まり（先頭の - を通さない）、`'`・`"`・`$`・`;` などシェルで意味のある文字を含まない */
export const CC_TITLE_PATTERN = /^[\p{L}\p{N}][\p{L}\p{N} _.-]{0,39}$/u;
/** 選べる権限モード（決定 4。bypassPermissions・dontAsk は選べない） */
export const CC_PERMISSION_MODES: readonly string[] = ["default", "acceptEdits", "plan", "auto"];
/** 前の起動からこの間は起動しない（§4.2 の 1 分に 1 回） */
export const CC_START_INTERVAL_MS = 60_000;
/** MemAvailable がこれ未満なら起動しない */
export const CC_MIN_MEM_AVAILABLE_BYTES = 1024 * 1024 * 1024;
/** 起動してから trust のダイアログを確かめるまで */
export const CC_TRUST_CHECK_DELAY_MS = 10_000;
/** 起動したセッションを一覧で探す・trust の確認待ちを確かめ直す間隔 */
export const CC_START_CHECK_MS = 10_000;
/** 起動したペインを一覧で探し、trust のダイアログを tick ごとに確かめる長さ（過ぎたら記録をあきらめる。最初の指示は送信の待ちの上限まで積んだまま） */
export const CC_START_BIND_MS = 10 * 60_000;
/** /api/cc/projects に出す数の上限 */
export const CC_PROJECTS_MAX = 500;
/** trust のダイアログの画面の語（§1.6。大文字小文字を問わない） */
export const CC_TRUST_MARKER = "trust this folder";

/** 起動を断った理由 */
export type CcStartFailure =
  | "invalid_project"
  | "invalid_title"
  | "invalid_mode"
  | "empty"
  | "too_long"
  | "invalid_text"
  | "limit"
  | "low_memory"
  | "too_soon"
  | "not_ready"
  | "no_server"
  | "tmux_failed"
  | "stopped";

export type CcStartResult =
  | { ok: true; tmuxSession: string; paneId: string; sendId: number | undefined }
  | { ok: false; reason: CcStartFailure };

/** 起動の入力（Web の本文のまま。検証は start がする） */
export type CcStartInput = {
  project: unknown;
  title: unknown;
  text?: unknown;
  permissionMode?: unknown;
  startedBy: Exclude<CcStartedBy, "owner">;
  /**
   * project に直下の 1 つ下（`<直下>/<名前>`）も許す（GitHub の [対応] の起動だけ。リポジトリの地図はワークスペースの 1 つ下まで見る。CC6）。
   * Web の起動は渡さない（直下だけ）
   */
  nested?: boolean;
  /** 最初の指示を GitHub の [対応]（origin github）として積むときの通知（CC6）。無ければ origin start */
  notificationId?: number;
  /** Discord から頼んだ起動（cc_start。CC7）なら頼んだチャンネル（最初の指示の送信と cc_sessions に書く） */
  channelId?: string;
  /** 起動の後に trust のダイアログの確認待ちに気づいたら 1 回呼ぶ（cc_start の確認の書き換え。CC7） */
  onTrustPending?: () => void;
};

/** 検証を通った起動の入力 */
export type CcStartPlan = { project: string; title: string; mode: string | undefined; text: string | undefined };

/** 起動できるか確かめた結果（check。起動はしない） */
export type CcStartCheck = ({ ok: true } & CcStartPlan) | { ok: false; reason: CcStartFailure };

/** 題名の検証（純関数）。前後の空白を除いて CC_TITLE_PATTERN に合えばそれ */
export function normalizeTitle(raw: unknown): string | undefined {
  if (typeof raw !== "string") return undefined;
  const title = raw.trim();
  return CC_TITLE_PATTERN.test(title) ? title : undefined;
}

/** 単引用符で囲む（純関数）。`'` や制御文字を含むものは投げる（呼び出し側が検証したものだけを渡す） */
export function quoteShellArg(value: string): string {
  if (value === "" || value.includes("'") || /[\u0000-\u001f\u007f-\u009f]/.test(value)) throw new Error("単引用符で囲めない値です");
  return `'${value}'`;
}

/**
 * tmux の new-session に渡す 1 つのシェルの文字列（純関数。§4.2）: `set -m; '<claude>' -n '<題名>' [--permission-mode '<mode>']; exec "$SHELL"`。
 * claude のパスは絶対パスで空白・`'` を含まないもの、題名は CC_TITLE_PATTERN、モードは CC_PERMISSION_MODES のどれか。合わなければ投げる
 */
export function buildClaudeCommand(input: { claudePath: string; title: string; permissionMode?: string }): string {
  const { claudePath, title, permissionMode } = input;
  if (!isAbsolute(claudePath) || /\s/.test(claudePath)) throw new Error("claude のパスが不正です");
  if (!CC_TITLE_PATTERN.test(title)) throw new Error("題名が不正です");
  if (permissionMode !== undefined && !CC_PERMISSION_MODES.includes(permissionMode)) throw new Error("権限モードが不正です");
  const mode = permissionMode === undefined ? "" : ` --permission-mode ${quoteShellArg(permissionMode)}`;
  return `set -m; ${quoteShellArg(claudePath)} -n ${quoteShellArg(title)}${mode}; exec "$SHELL"`;
}

/** tmux のセッション名に使う形（純関数）: 小文字にして英数字以外を - にまとめ、前後の - を除いて 40 字まで */
export function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .replace(/-+$/, "");
}

/**
 * 作るセッションの名前（純関数。§4.2）: `<slug(project)>`、既にあれば `<slug(project)>--<slug(題名)>`（題名から作れなければ飛ばす）、
 * それもあれば末尾に -2, -3, …。名前は表示用（オーナーの hook で変わりうる）
 */
export function chooseSessionName(project: string, title: string, existing: ReadonlySet<string>): string | undefined {
  const base = slugify(project) || "cc";
  const titled = slugify(title);
  const root = titled === "" ? base : `${base}--${titled}`;
  const candidates = [base, root];
  for (let n = 2; n <= 99; n++) candidates.push(`${root}-${n}`);
  return candidates.find((name) => !existing.has(name));
}

/** a と b が同じか、どちらかがもう一方の中にある */
function overlaps(a: string, b: string): boolean {
  return a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`);
}

function realOrResolved(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}

/** 起動の場所の判定に使う場所 */
export type CcPlaces = {
  workspaceDir: string;
  /** 重なってはいけない場所（workDir・dataDir・~/.config/self-agent・~/.claude・CLAUDE_CONFIG_DIR） */
  protectedDirs: readonly string[];
};

/**
 * 起動してよいディレクトリ（§4.2）。名前が CC_PROJECT_PATTERN で、`<realpath(workspace)>/<name>` が symlink でない実際のディレクトリで、
 * その realpath がそれそのもので、重なってはいけない場所と重ならず、tmux の書式の `#` を含まないときだけ、その絶対パス。それ以外は undefined。
 * nested なら `<直下>/<名前>`（どちらの要素も CC_PROJECT_PATTERN で、どちらの段も symlink でない実際のディレクトリ）も許す（GitHub の [対応]。CC6）
 */
export function projectDir(name: unknown, places: CcPlaces, options: { nested?: boolean } = {}): string | undefined {
  if (typeof name !== "string") return undefined;
  const parts = name.split("/");
  if (parts.length > (options.nested === true ? 2 : 1) || !parts.every((part) => CC_PROJECT_PATTERN.test(part))) return undefined;
  let root: string;
  try {
    root = realpathSync(places.workspaceDir);
  } catch {
    return undefined;
  }
  const dir = join(root, ...parts);
  try {
    for (let depth = 1; depth <= parts.length; depth++) {
      const stat = lstatSync(join(root, ...parts.slice(0, depth)));
      if (stat.isSymbolicLink() || !stat.isDirectory()) return undefined;
    }
    if (realpathSync(dir) !== dir) return undefined;
  } catch {
    return undefined;
  }
  if (dir.includes("#")) return undefined;
  if (places.protectedDirs.some((place) => overlaps(dir, realOrResolved(place)))) return undefined;
  return dir;
}

/** 起動できるディレクトリの名前（名前の順に CC_PROJECTS_MAX まで）。workspace が読めなければ空 */
export function listProjects(places: CcPlaces): string[] {
  let names: string[];
  try {
    names = readdirSync(places.workspaceDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
  } catch {
    return [];
  }
  return names
    .filter((name) => projectDir(name, places) !== undefined)
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
    .slice(0, CC_PROJECTS_MAX);
}

/** /proc/meminfo の MemAvailable（バイト）。読めなければ undefined（procFile はテスト用） */
export function procMemAvailable(procFile: string = "/proc/meminfo"): () => number | undefined {
  return () => {
    try {
      const match = /^MemAvailable:\s+(\d{1,15}) kB$/m.exec(readFileSync(procFile, "utf8"));
      return match === null ? undefined : Number(match[1]) * 1024;
    } catch {
      return undefined;
    }
  };
}

/** 画面が trust のダイアログか（純関数。§1.6） */
export function isTrustDialog(raw: string): boolean {
  return classifyScreen(raw) === "dialog" && stripAnsi(raw).toLowerCase().includes(CC_TRUST_MARKER);
}

export type CcStarterDeps = {
  cfg: Pick<Config, "workspaceDir" | "ccMaxSessions">;
  /** 起動の場所の判定（workspaceDir と重なってはいけない場所） */
  places: CcPlaces;
  /** 起動時に解決した claude の絶対パス */
  claudePath: string;
  registry: Pick<CcRegistry, "snapshot">;
  panes: Pick<CcPaneResolver, "lookup">;
  tmux: Pick<Tmux, "listPanes" | "newSession" | "capturePane">;
  sends: Pick<CcSendStore, "add" | "bindSession">;
  sessions: Pick<CcSessionStore, "recordStart" | "setTrustPending" | "listTrustPending">;
  /** 最初の指示を積んだ・結びつけたら待ち行列を回す */
  sender?: Pick<CcSender, "kick">;
  /**
   * 起動したペインを一覧のセッションに結びつけた後に 1 回（startedBy・頼んだチャンネル・最初の指示の送信）。Claude Code のチャンネルを作る（CC11）。
   * 投げても・reject しても結びつけは止めない
   */
  onBound?: (bound: { sessionId: string; startedBy: Exclude<CcStartedBy, "owner">; channelId?: string; sendId?: number }) => void | Promise<void>;
  /** MemAvailable（バイト）。読めなければ undefined（そのときは確かめない） */
  memAvailable: () => number | undefined;
  now: () => Date;
  timers?: CcTimers;
  log: (message: string) => void;
};

/** 起動したがまだ一覧のセッションと結びつけていないもの（pendingStarts） */
export type CcPendingStart = {
  project: string;
  title: string;
  /** trust のダイアログが出ている */
  trustPending: boolean;
  /** 起動した時刻（ミリ秒） */
  startedAt: number;
};

/** 起動してから CC_START_BIND_MS の間のもの（一覧のセッションとの結びつけと trust の確かめ。プロセスの中だけ） */
type Started = {
  startedBy: Exclude<CcStartedBy, "owner">;
  /** 起動したディレクトリの名前と題名（一覧に出る前の「起動中」の表示。/api/cc/sessions の starting） */
  project: string;
  title: string;
  tmuxSession: string;
  tmuxSessionId: string;
  paneId: string;
  /** 起動したディレクトリ（cwd がこれの claude にだけ結びつける） */
  dir: string;
  startedAt: number;
  sendId: number | undefined;
  /** 結びつけた一覧のセッション */
  sessionId: string | undefined;
  trustPendingAt: Date | null;
  channelId: string | undefined;
  onTrustPending: (() => void) | undefined;
};

const REAL_TIMERS: CcTimers = {
  after: (fn, ms) => {
    const timer = setTimeout(fn, ms);
    return () => clearTimeout(timer);
  },
};

function errorKind(error: unknown): string {
  return error instanceof Error ? error.name : typeof error;
}

export class CcStarter {
  private readonly deps: CcStarterDeps;
  private readonly timers: CcTimers;
  private started: Started[] = [];
  private lastStartAt: number | undefined;
  private starting = false;
  private loopStarted = false;
  private stopped = false;
  private cancelLoop: (() => void) | undefined;
  private readonly trustTimers = new Set<() => void>();
  private running: Promise<void> | undefined;
  private inFlight: Promise<unknown> | undefined;

  constructor(deps: CcStarterDeps) {
    this.deps = deps;
    this.timers = deps.timers ?? REAL_TIMERS;
  }

  /** 起動できるディレクトリの名前（/api/cc/projects） */
  projects(): string[] {
    return listProjects(this.deps.places);
  }

  /** 起動したペインをまだ一覧で見つけていない（registry の周期を短くする） */
  busy(): boolean {
    return this.started.some((entry) => entry.sessionId === undefined);
  }

  /**
   * 起動したが一覧のセッションとまだ結びつけていないもの（起動の古い順）。trust の確認を待っている claude は claude agents --json に出ないので、
   * Web の一覧はこれを「起動中」として出す（§5.1）
   */
  pendingStarts(): CcPendingStart[] {
    return this.started
      .filter((entry) => entry.sessionId === undefined)
      .map((entry) => ({ project: entry.project, title: entry.title, trustPending: entry.trustPendingAt !== null, startedAt: entry.startedAt }));
  }

  /** CC_START_CHECK_MS ごとに、起動したセッションを一覧で探し、trust の確認待ちを確かめ直す。stop の後・2 回目は何もしない */
  start(): void {
    if (this.loopStarted || this.stopped) return;
    this.loopStarted = true;
    this.schedule();
  }

  stop(): void {
    this.stopped = true;
    this.cancelLoop?.();
    this.cancelLoop = undefined;
    for (const cancel of this.trustTimers) cancel();
    this.trustTimers.clear();
  }

  async idle(): Promise<void> {
    await Promise.allSettled([this.running, this.inFlight]);
  }

  /**
   * 起動できるか確かめる（cc_start の確認を出す前。CC7）。launch と同じ検証と、上限（数・メモリ）・tmux のサーバーを確かめるが、
   * 1 分の間隔は見ない（起動するのはオーナーが [起動する] を押したとき）。起動はしない
   */
  async check(input: Omit<CcStartInput, "startedBy">): Promise<CcStartCheck> {
    if (this.stopped) return { ok: false, reason: "stopped" };
    const plan = this.validate(input);
    if (!plan.ok) return plan;
    const capacity = this.capacity();
    if (capacity !== undefined) return { ok: false, reason: capacity };
    const panes = await this.deps.tmux.listPanes();
    if (!panes.ok) return { ok: false, reason: panes.reason === "no_server" ? "no_server" : "tmux_failed" };
    return { ok: true, project: plan.project, title: plan.title, mode: plan.mode, text: plan.text };
  }

  /** 入力の検証（題名・権限モード・最初の指示・ディレクトリ） */
  private validate(input: Omit<CcStartInput, "startedBy">): ({ ok: true; dir: string } & CcStartPlan) | { ok: false; reason: CcStartFailure } {
    const title = normalizeTitle(input.title);
    if (title === undefined) return { ok: false, reason: "invalid_title" };
    const mode = input.permissionMode === undefined || input.permissionMode === null || input.permissionMode === "" ? undefined : input.permissionMode;
    if (mode !== undefined && (typeof mode !== "string" || !CC_PERMISSION_MODES.includes(mode))) return { ok: false, reason: "invalid_mode" };
    let text: string | undefined;
    if (typeof input.text === "string" && input.text.trim() !== "") {
      const checked = normalizeSendText(input.text);
      if (!checked.ok) return { ok: false, reason: checked.reason };
      text = checked.text;
    } else if (input.text !== undefined && input.text !== null && typeof input.text !== "string") {
      return { ok: false, reason: "invalid_text" };
    }
    const dir = projectDir(input.project, this.deps.places, { nested: input.nested === true });
    if (dir === undefined) return { ok: false, reason: "invalid_project" };
    return { ok: true, dir, project: input.project as string, title, mode: mode as string | undefined, text };
  }

  /** 一覧を読めていない・生きている claude が上限・MemAvailable が足りなければその理由 */
  private capacity(): "not_ready" | "limit" | "low_memory" | undefined {
    const snapshot = this.deps.registry.snapshot();
    // 一覧をまだ読めていない・読めない間は数を確かめられないので起動しない
    if (snapshot.fetchedAt === undefined || snapshot.unreadable) return "not_ready";
    const unbound = this.started.filter((entry) => entry.sessionId === undefined).length;
    if (snapshot.sessions.length + unbound >= this.deps.cfg.ccMaxSessions) return "limit";
    const mem = this.deps.memAvailable();
    if (mem !== undefined && mem < CC_MIN_MEM_AVAILABLE_BYTES) return "low_memory";
    return undefined;
  }

  /** 起動する（§4.2）。検証・上限を通ったら tmux に新しいセッションを作り、最初の指示があればペイン宛てに積む */
  async launch(input: CcStartInput): Promise<CcStartResult> {
    if (this.stopped) return { ok: false, reason: "stopped" };
    const plan = this.validate(input);
    if (!plan.ok) return plan;
    const { dir, project, title, mode, text } = plan;
    // 同時に 2 つは起動しない（2 つ目は 1 分の間隔と同じ扱い）
    if (this.starting) return { ok: false, reason: "too_soon" };
    this.starting = true;
    const run = this.run({
      project,
      dir,
      title,
      mode,
      text,
      startedBy: input.startedBy,
      ...(input.notificationId === undefined ? {} : { notificationId: input.notificationId }),
      channelId: input.channelId,
      onTrustPending: input.onTrustPending,
    });
    this.inFlight = run;
    try {
      return await run;
    } finally {
      this.starting = false;
      this.inFlight = undefined;
    }
  }

  private async run(input: {
    project: string;
    dir: string;
    title: string;
    mode: string | undefined;
    text: string | undefined;
    startedBy: Exclude<CcStartedBy, "owner">;
    notificationId?: number;
    channelId: string | undefined;
    onTrustPending: (() => void) | undefined;
  }): Promise<CcStartResult> {
    const { tmux, sends, now, log } = this.deps;
    const at = now().getTime();
    if (this.lastStartAt !== undefined && at - this.lastStartAt < CC_START_INTERVAL_MS) return { ok: false, reason: "too_soon" };
    const capacity = this.capacity();
    if (capacity !== undefined) return { ok: false, reason: capacity };
    // サーバーが無ければ new-session はサーバーを起こしてしまうので、先に確かめて断る（決定 8）
    const panes = await tmux.listPanes();
    if (!panes.ok) return { ok: false, reason: panes.reason === "no_server" ? "no_server" : "tmux_failed" };
    if (this.stopped) return { ok: false, reason: "stopped" };
    const name = chooseSessionName(input.project, input.title, new Set(panes.value.map((pane) => pane.sessionName)));
    if (name === undefined) return { ok: false, reason: "tmux_failed" };
    const command = buildClaudeCommand({
      claudePath: this.deps.claudePath,
      title: input.title,
      ...(input.mode === undefined ? {} : { permissionMode: input.mode }),
    });
    const created = await tmux.newSession({ name, dir: input.dir, command });
    if (!created.ok) {
      log(`Claude Code: 起動できませんでした（${created.reason}）`);
      return { ok: false, reason: created.reason === "no_server" ? "no_server" : "tmux_failed" };
    }
    this.lastStartAt = now().getTime();
    const { sessionId: tmuxSessionId, paneId } = created.value;
    const send =
      input.text === undefined
        ? undefined
        : sends.add({
            sessionId: null,
            paneId,
            startDir: input.dir,
            text: input.text,
            state: "queued",
            ...(input.notificationId === undefined ? { origin: "start" } : { origin: "github", notificationId: input.notificationId }),
            ...(input.channelId === undefined ? {} : { channelId: input.channelId }),
          });
    const entry: Started = {
      startedBy: input.startedBy,
      project: input.project,
      title: input.title,
      tmuxSession: name,
      tmuxSessionId,
      paneId,
      dir: input.dir,
      startedAt: this.lastStartAt,
      sendId: send?.id,
      sessionId: undefined,
      trustPendingAt: null,
      channelId: input.channelId,
      onTrustPending: input.onTrustPending,
    };
    this.started.push(entry);
    log(`Claude Code: 起動しました（${input.startedBy}${send === undefined ? "" : `、最初の指示 #${send.id}`}）`);
    // 停止を始めた後は張らない（stop が消した後に残らないように）
    if (!this.stopped) {
      const cancel = this.timers.after(() => {
        this.trustTimers.delete(cancel);
        void this.checkTrust(entry);
      }, CC_TRUST_CHECK_DELAY_MS);
      this.trustTimers.add(cancel);
    }
    if (send !== undefined) void this.deps.sender?.kick();
    return { ok: true, tmuxSession: name, paneId, sendId: send?.id };
  }

  /**
   * 画面が trust のダイアログなら確認待ちにし（キーは送らない。§4.2）、消えていれば（ペインが無くなっていても）外す。結びつけていれば cc_sessions にも書く。
   * 起動から CC_TRUST_CHECK_DELAY_MS で 1 回と、CC_START_BIND_MS の間は tick ごと
   */
  private async checkTrust(entry: Started): Promise<void> {
    if (this.stopped) return;
    try {
      const shot = await this.deps.tmux.capturePane(entry.paneId);
      if (!shot.ok && shot.reason !== "not_found") return;
      const dialog = shot.ok && isTrustDialog(shot.value);
      if (dialog && entry.trustPendingAt === null) {
        entry.trustPendingAt = this.deps.now();
        if (entry.sessionId !== undefined) this.deps.sessions.setTrustPending(entry.sessionId, entry.trustPendingAt);
        this.deps.log("Claude Code: 起動したセッションが trust の確認を待っています");
        entry.onTrustPending?.();
      } else if (!dialog && entry.trustPendingAt !== null) {
        entry.trustPendingAt = null;
        if (entry.sessionId !== undefined) this.deps.sessions.setTrustPending(entry.sessionId, null);
      }
    } catch (error) {
      this.deps.log(`Claude Code: trust のダイアログを確かめられませんでした（${errorKind(error)}）`);
    }
  }

  /** 起動から CC_START_BIND_MS を過ぎたものを忘れる（まだ一覧で見つけていなければ log） */
  private forgetDone(): void {
    const now = this.deps.now().getTime();
    this.started = this.started.filter((entry) => {
      if (now - entry.startedAt < CC_START_BIND_MS) return true;
      if (entry.sessionId === undefined) this.deps.log("Claude Code: 起動したセッションを一覧で見つけられませんでした");
      return false;
    });
  }

  private schedule(): void {
    if (this.stopped) return;
    this.cancelLoop = this.timers.after(() => {
      this.cancelLoop = undefined;
      void this.tick().then(() => this.schedule());
    }, CC_START_CHECK_MS);
  }

  /** 1 回確かめる（テストから直接呼ぶ）。reject しない */
  tick(): Promise<void> {
    if (this.running !== undefined) return this.running;
    const running = this.pass().finally(() => {
      this.running = undefined;
    });
    this.running = running;
    return running;
  }

  private async pass(): Promise<void> {
    try {
      this.forgetDone();
      await this.bind();
      for (const entry of [...this.started]) await this.checkTrust(entry);
      await this.recheckTrust();
    } catch (error) {
      this.deps.log(`Claude Code: 起動したセッションを確かめられませんでした（${errorKind(error)}）`);
    }
  }

  /**
   * 起動したペインを送り先にし、cwd が起動したディレクトリの一覧のセッションを探し（%N が同じというだけでは採らない）、
   * 見つけたら cc_sessions に記録して最初の指示を結びつける
   */
  private async bind(): Promise<void> {
    const waiting = this.started.filter((entry) => entry.sessionId === undefined);
    if (waiting.length === 0 || this.stopped) return;
    const snapshot = this.deps.registry.snapshot();
    // 前回の一覧（stale）では結びつけない（送信の経路と同じ）
    if (snapshot.fetchedAt === undefined || snapshot.unreadable || snapshot.stale) return;
    const lookup = await this.deps.panes.lookup(new Set(snapshot.sessions.map((session) => session.pid)));
    if (!lookup.ok) return;
    let bound = false;
    for (const entry of waiting) {
      const view = sessionOnStartedPane(lookup, snapshot.sessions, entry.paneId, entry.dir).found;
      if (view === undefined) continue;
      entry.sessionId = view.sessionId;
      this.deps.sessions.recordStart(view.sessionId, {
        startedBy: entry.startedBy,
        tmuxSession: entry.tmuxSession,
        tmuxSessionId: entry.tmuxSessionId,
        paneId: entry.paneId,
        trustPendingAt: entry.trustPendingAt,
        ...(entry.channelId === undefined ? {} : { channelId: entry.channelId }),
      });
      if (entry.sendId !== undefined && this.deps.sends.bindSession(entry.sendId, view.sessionId)) bound = true;
      this.notifyBound(entry, view.sessionId);
    }
    if (bound) void this.deps.sender?.kick();
  }

  /** 結びつけたことを onBound に渡す（待たない。投げても止めない） */
  private notifyBound(entry: Started, sessionId: string): void {
    const { onBound, log } = this.deps;
    if (onBound === undefined) return;
    const fail = (error: unknown): void => log(`Claude Code: 起動したセッションの結びつけの後の処理に失敗しました（${errorKind(error)}）`);
    try {
      const result = onBound({
        sessionId,
        startedBy: entry.startedBy,
        ...(entry.channelId === undefined ? {} : { channelId: entry.channelId }),
        ...(entry.sendId === undefined ? {} : { sendId: entry.sendId }),
      });
      if (result instanceof Promise) void result.catch(fail);
    } catch (error) {
      fail(error);
    }
  }

  /**
   * trust の確認待ちのセッション（起動から CC_START_BIND_MS を過ぎた・再起動の前に起動したもの）の画面を撮り直し、
   * ダイアログが消えていれば（ペインが無くなっていても）外す
   */
  private async recheckTrust(): Promise<void> {
    const tracked = new Set(this.started.map((entry) => entry.sessionId).filter((id) => id !== undefined));
    for (const row of this.deps.sessions.listTrustPending()) {
      if (this.stopped) return;
      if (tracked.has(row.sessionId)) continue;
      if (row.startPaneId === null) {
        this.deps.sessions.setTrustPending(row.sessionId, null);
        continue;
      }
      const shot = await this.deps.tmux.capturePane(row.startPaneId);
      if (!shot.ok && shot.reason !== "not_found") continue;
      if (!shot.ok || !isTrustDialog(shot.value)) this.deps.sessions.setTrustPending(row.sessionId, null);
    }
  }
}
