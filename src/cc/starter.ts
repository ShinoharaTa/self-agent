// Claude Code の新しいセッションの起動（docs/plan/claude-code-sessions.md §4.2・§7 の 5。CC4）。SELF_AGENT_WORKSPACE_DIR の直下の実際のディレクトリ
// （名前は CC_PROJECT_PATTERN、realpath がそのもの、workDir・dataDir・~/.config/self-agent・~/.claude・CLAUDE_CONFIG_DIR と重ならない）で、
// 既定のソケットの tmux に `new-session -d -P -F '#{session_id} #{pane_id}'` で `'<claude>' -n '<題名>' [--permission-mode '<mode>']; exec "$SHELL"` を起動する
// （tmux のサーバーが無ければ断る。決定 8）。引数は固定の形で、題名・モードは検証してから単引用符で囲む（`'` を含む題名は通さない）。
// セッション名は表示用で、オーナーの hook で変わりうるので、以後は返った $N・%N で追う。最初の指示は cc_sends にペイン宛て（origin start）で積み、
// 送るのは cc/sender.ts（入力待ちになるまで積んだまま。trust のダイアログにはキーを送らない）。起動したペインを一覧のセッションで見つけたら
// cc_sessions に started_by などを書く。起動から CC_TRUST_CHECK_DELAY_MS で画面が trust のダイアログなら trust の確認待ちにし、消えたら外す。
// 上限: 生きている claude が SELF_AGENT_CC_MAX_SESSIONS 以上・MemAvailable が 1 GB 未満・前の起動から 1 分未満なら断る。
// log は起動したもの（web など）・送信の番号・件数・失敗の種類だけ（プロジェクト名・題名・パス・tmux のセッション名・ペイン id・sessionId は出さない）
import { lstatSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import type { Config } from "../config.ts";
import type { CcSendStore } from "../store/cc-sends.ts";
import type { CcSessionStore, CcStartedBy } from "../store/cc-sessions.ts";
import { classifyScreen, stripAnsi } from "../tmux/pane-state.ts";
import type { Tmux } from "../tmux/tmux.ts";
import type { CcPaneResolver } from "./panes.ts";
import type { CcRegistry, CcTimers } from "./registry.ts";
import { normalizeSendText, type CcSender } from "./sender.ts";

/** 起動できるディレクトリの名前（直下だけ） */
export const CC_PROJECT_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
/** 題名（-n に渡す名前）。`'`・`"`・`$`・`;` などシェルで意味のある文字を含まない */
export const CC_TITLE_PATTERN = /^[\p{L}\p{N} _.-]{1,40}$/u;
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
/** 起動したペインを一覧で探す長さ（過ぎたら記録をあきらめる。最初の指示は送信の待ちの上限まで積んだまま） */
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
};

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
 * tmux の new-session に渡す 1 つのシェルの文字列（純関数。§4.2）: `'<claude>' -n '<題名>' [--permission-mode '<mode>']; exec "$SHELL"`。
 * claude のパスは絶対パスで空白・`'` を含まないもの、題名は CC_TITLE_PATTERN、モードは CC_PERMISSION_MODES のどれか。合わなければ投げる
 */
export function buildClaudeCommand(input: { claudePath: string; title: string; permissionMode?: string }): string {
  const { claudePath, title, permissionMode } = input;
  if (!isAbsolute(claudePath) || /\s/.test(claudePath)) throw new Error("claude のパスが不正です");
  if (!CC_TITLE_PATTERN.test(title)) throw new Error("題名が不正です");
  if (permissionMode !== undefined && !CC_PERMISSION_MODES.includes(permissionMode)) throw new Error("権限モードが不正です");
  const mode = permissionMode === undefined ? "" : ` --permission-mode ${quoteShellArg(permissionMode)}`;
  return `${quoteShellArg(claudePath)} -n ${quoteShellArg(title)}${mode}; exec "$SHELL"`;
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
 * その realpath がそれそのもので、重なってはいけない場所と重ならず、tmux の書式の `#` を含まないときだけ、その絶対パス。それ以外は undefined
 */
export function projectDir(name: unknown, places: CcPlaces): string | undefined {
  if (typeof name !== "string" || !CC_PROJECT_PATTERN.test(name)) return undefined;
  let root: string;
  try {
    root = realpathSync(places.workspaceDir);
  } catch {
    return undefined;
  }
  const dir = join(root, name);
  try {
    const stat = lstatSync(dir);
    if (stat.isSymbolicLink() || !stat.isDirectory()) return undefined;
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
  /** MemAvailable（バイト）。読めなければ undefined（そのときは確かめない） */
  memAvailable: () => number | undefined;
  now: () => Date;
  timers?: CcTimers;
  log: (message: string) => void;
};

/** 起動して、まだ一覧のセッションと結びつけていない・trust を確かめていないもの（プロセスの中だけ） */
type Started = {
  startedBy: Exclude<CcStartedBy, "owner">;
  tmuxSession: string;
  tmuxSessionId: string;
  paneId: string;
  startedAt: number;
  sendId: number | undefined;
  /** 結びつけた一覧のセッション */
  sessionId: string | undefined;
  trustChecked: boolean;
  trustPendingAt: Date | null;
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

  /** 起動する（§4.2）。検証・上限を通ったら tmux に新しいセッションを作り、最初の指示があればペイン宛てに積む */
  async launch(input: CcStartInput): Promise<CcStartResult> {
    if (this.stopped) return { ok: false, reason: "stopped" };
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
    const dir = projectDir(input.project, this.deps.places);
    if (dir === undefined) return { ok: false, reason: "invalid_project" };
    // 同時に 2 つは起動しない（2 つ目は 1 分の間隔と同じ扱い）
    if (this.starting) return { ok: false, reason: "too_soon" };
    this.starting = true;
    const run = this.run({ project: input.project as string, dir, title, mode, text, startedBy: input.startedBy });
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
  }): Promise<CcStartResult> {
    const { cfg, registry, tmux, sends, now, log } = this.deps;
    const at = now().getTime();
    if (this.lastStartAt !== undefined && at - this.lastStartAt < CC_START_INTERVAL_MS) return { ok: false, reason: "too_soon" };
    const snapshot = registry.snapshot();
    // 一覧をまだ読めていない・読めない間は数を確かめられないので起動しない
    if (snapshot.fetchedAt === undefined || snapshot.unreadable) return { ok: false, reason: "not_ready" };
    const unbound = this.started.filter((entry) => entry.sessionId === undefined).length;
    if (snapshot.sessions.length + unbound >= cfg.ccMaxSessions) return { ok: false, reason: "limit" };
    const mem = this.deps.memAvailable();
    if (mem !== undefined && mem < CC_MIN_MEM_AVAILABLE_BYTES) return { ok: false, reason: "low_memory" };
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
      input.text === undefined ? undefined : sends.add({ sessionId: null, paneId, text: input.text, origin: "start", state: "queued" });
    const entry: Started = {
      startedBy: input.startedBy,
      tmuxSession: name,
      tmuxSessionId,
      paneId,
      startedAt: this.lastStartAt,
      sendId: send?.id,
      sessionId: undefined,
      trustChecked: false,
      trustPendingAt: null,
    };
    this.started.push(entry);
    log(`Claude Code: 起動しました（${input.startedBy}${send === undefined ? "" : `、最初の指示 #${send.id}`}）`);
    const cancel = this.timers.after(() => {
      this.trustTimers.delete(cancel);
      void this.checkTrust(entry);
    }, CC_TRUST_CHECK_DELAY_MS);
    this.trustTimers.add(cancel);
    if (send !== undefined) void this.deps.sender?.kick();
    return { ok: true, tmuxSession: name, paneId, sendId: send?.id };
  }

  /** 1 回だけ: 起動から CC_TRUST_CHECK_DELAY_MS で画面が trust のダイアログなら確認待ちにする（キーは送らない。§4.2） */
  private async checkTrust(entry: Started): Promise<void> {
    if (this.stopped) return;
    try {
      const shot = await this.deps.tmux.capturePane(entry.paneId);
      entry.trustChecked = true;
      if (!shot.ok || !isTrustDialog(shot.value)) return;
      entry.trustPendingAt = this.deps.now();
      if (entry.sessionId !== undefined) this.deps.sessions.setTrustPending(entry.sessionId, entry.trustPendingAt);
      this.deps.log("Claude Code: 起動したセッションが trust の確認を待っています");
    } catch (error) {
      entry.trustChecked = true;
      this.deps.log(`Claude Code: trust のダイアログを確かめられませんでした（${errorKind(error)}）`);
    } finally {
      this.forgetDone();
    }
  }

  /** 結びつけて trust も確かめたもの・探す長さを過ぎたものを忘れる */
  private forgetDone(): void {
    const now = this.deps.now().getTime();
    this.started = this.started.filter((entry) => {
      if (entry.sessionId !== undefined && entry.trustChecked) return false;
      if (entry.sessionId === undefined && now - entry.startedAt >= CC_START_BIND_MS) {
        this.deps.log("Claude Code: 起動したセッションを一覧で見つけられませんでした");
        return false;
      }
      return true;
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
      await this.bind();
      await this.recheckTrust();
      this.forgetDone();
    } catch (error) {
      this.deps.log(`Claude Code: 起動したセッションを確かめられませんでした（${errorKind(error)}）`);
    }
  }

  /** 起動したペインを送り先にする一覧のセッションを探し、見つけたら cc_sessions に記録して最初の指示を結びつける */
  private async bind(): Promise<void> {
    const waiting = this.started.filter((entry) => entry.sessionId === undefined);
    if (waiting.length === 0 || this.stopped) return;
    const snapshot = this.deps.registry.snapshot();
    if (snapshot.fetchedAt === undefined || snapshot.unreadable) return;
    const lookup = await this.deps.panes.lookup(new Set(snapshot.sessions.map((session) => session.pid)));
    if (!lookup.ok) return;
    let bound = false;
    for (const entry of waiting) {
      const view = snapshot.sessions.find((session) => {
        const found = lookup.sendable({ pid: session.pid, tmux: session.tmux });
        return found.ok && found.pane.paneId === entry.paneId;
      });
      if (view === undefined) continue;
      entry.sessionId = view.sessionId;
      this.deps.sessions.recordStart(view.sessionId, {
        startedBy: entry.startedBy,
        tmuxSession: entry.tmuxSession,
        tmuxSessionId: entry.tmuxSessionId,
        paneId: entry.paneId,
        trustPendingAt: entry.trustPendingAt,
      });
      if (entry.sendId !== undefined && this.deps.sends.bindSession(entry.sendId, view.sessionId)) bound = true;
    }
    if (bound) void this.deps.sender?.kick();
  }

  /** trust の確認待ちのセッションの画面を撮り直し、ダイアログが消えていれば（ペインが無くなっていても）外す */
  private async recheckTrust(): Promise<void> {
    for (const row of this.deps.sessions.listTrustPending()) {
      if (this.stopped) return;
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
