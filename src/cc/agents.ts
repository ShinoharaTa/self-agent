// `claude agents --json` の実行と出力の検証（docs/plan/claude-code-sessions.md §2.2・§7 の 9・10）。公式の一覧で、この機械で動いている
// Claude Code のセッション（対話・background）が配列で出る。execFile で起動時に解決した絶対パスの claude を固定の引数で呼び、シェルを通さない。
// 子の env は HOME・PATH・LANG だけ（Bot の CLAUDE_CONFIG_DIR を渡すと別の設定ディレクトリの一覧になる。トークン類も渡さない）
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { resolveCommandPath } from "../github/gh.ts";
import { CHILD_MAX_BUFFER, CHILD_PATH, CHILD_TIMEOUT_MS, execFileRunner, type RunCommand } from "../tmux/tmux.ts";

/** 固定の引数 */
export const AGENTS_ARGS: readonly string[] = ["agents", "--json"];

/** 子の PATH（§7 の 9。claude 自身は起動時に解決した絶対パスで呼ぶ） */
export function agentsChildPath(home: string): string {
  return `${join(home, ".local/bin")}:/usr/local/bin:/usr/bin:/bin`;
}

/** 子の env（許可方式。HOME・PATH・LANG だけ） */
export function agentsChildEnv(home: string = homedir()): Record<string, string> {
  return { HOME: home, PATH: agentsChildPath(home), LANG: "C.UTF-8" };
}

/**
 * claude の絶対パスを起動時に 1 回解決する。子に渡すのと同じ固定の PATH（`~/.local/bin` が先）で探し、無ければ pathEnv（既定は process.env.PATH）。
 * Bot の transient unit の PATH には `~/.local/bin` が無いため、PATH だけでは探さない
 */
export function resolveClaudePath(home: string = homedir(), pathEnv: string | undefined = process.env.PATH): string | undefined {
  return resolveCommandPath("claude", `${agentsChildPath(home)}:${pathEnv ?? ""}`);
}

/** tmux の絶対パスを起動時に 1 回解決する。tmux.ts の子の固定の PATH で探し、無ければ pathEnv（既定は process.env.PATH） */
export function resolveTmuxPath(pathEnv: string | undefined = process.env.PATH): string | undefined {
  return resolveCommandPath("tmux", `${CHILD_PATH}:${pathEnv ?? ""}`);
}

/** 一覧の 1 要素（未知の欄は捨てる。形の合わない欄は無いものとする） */
export type AgentEntry = {
  pid: number;
  /** UUID */
  sessionId: string;
  cwd: string | undefined;
  name: string | undefined;
  /** interactive / background など */
  kind: string | undefined;
  /** 起動の時刻（エポックからのミリ秒） */
  startedAt: number | undefined;
  /** busy / waiting / idle */
  status: string | undefined;
  /** status が waiting のときの理由（permission prompt / input needed など） */
  waitingFor: string | undefined;
};

/** exited = 終了コードが 0 でない（起動できない・時間切れ・出力の上限を含む）、json = JSON でない、shape = 配列でない */
export type AgentsFailure = "exited" | "json" | "shape";

export type AgentsResult = { ok: true; agents: AgentEntry[]; dropped: number } | { ok: false; reason: AgentsFailure };

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(value: unknown): value is string {
  return typeof value === "string" && UUID_PATTERN.test(value);
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

/** 1 要素を検証する。pid（正の整数）が無い・sessionId が UUID でなければ undefined */
function parseEntry(value: unknown): AgentEntry | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const item = value as Record<string, unknown>;
  const pid = item.pid;
  if (typeof pid !== "number" || !Number.isSafeInteger(pid) || pid < 1) return undefined;
  if (!isUuid(item.sessionId)) return undefined;
  const startedAt = item.startedAt;
  return {
    pid,
    sessionId: item.sessionId,
    cwd: optionalString(item.cwd),
    name: optionalString(item.name),
    kind: optionalString(item.kind),
    startedAt: typeof startedAt === "number" && Number.isFinite(startedAt) ? startedAt : undefined,
    status: optionalString(item.status),
    waitingFor: optionalString(item.waitingFor),
  };
}

/** 出力を検証する（純関数）。JSON でない・配列でなければ失敗、要素のうち形の合わないものは捨てて数える。同じ sessionId は最初の 1 つだけ */
export function parseAgentsOutput(stdout: string): AgentsResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return { ok: false, reason: "json" };
  }
  if (!Array.isArray(parsed)) return { ok: false, reason: "shape" };
  const agents: AgentEntry[] = [];
  const seen = new Set<string>();
  let dropped = 0;
  for (const value of parsed) {
    const entry = parseEntry(value);
    if (entry === undefined || seen.has(entry.sessionId)) {
      dropped++;
      continue;
    }
    seen.add(entry.sessionId);
    agents.push(entry);
  }
  return { ok: true, agents, dropped };
}

export type AgentsClientOptions = {
  /** 起動時に解決した claude の絶対パス */
  claudePath: string;
  run?: RunCommand;
  /** 子の HOME（既定は os.homedir()） */
  home?: string;
};

/** claude agents --json を実行して検証する。reject しない */
export class AgentsClient {
  private readonly claudePath: string;
  private readonly run: RunCommand;
  private readonly env: Record<string, string>;

  constructor(options: AgentsClientOptions) {
    if (!isAbsolute(options.claudePath)) throw new Error("claude のパスは絶対パスにしてください");
    this.claudePath = options.claudePath;
    this.run = options.run ?? execFileRunner;
    this.env = agentsChildEnv(options.home);
  }

  async list(): Promise<AgentsResult> {
    const result = await this.run(this.claudePath, AGENTS_ARGS, {
      env: { ...this.env },
      timeoutMs: CHILD_TIMEOUT_MS,
      maxBuffer: CHILD_MAX_BUFFER,
    });
    if (result.code !== 0) return { ok: false, reason: "exited" };
    return parseAgentsOutput(result.stdout);
  }
}
