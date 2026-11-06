// プロジェクトのセッション（docs/plan/unify.md §4.1・§5・§6.1 の 2）の Options と hooks の組み立て方（RunnerProfile）。
// cwd は SELF_AGENT_WORKSPACE_DIR の直下のプロジェクトで、Claude Code と同じ装備（preset のシステムプロンプト・ユーザー / プロジェクトの設定・
// CLI の既定のツール）に自前の MCP ツールを足す。許可は canUseTool（permission-bridge.ts）で Discord・Web のカードに流す。
// 軽いモード（query-options.ts の buildQueryOptions）は変えない。キャッシュの規則の例外（preset・snapshot: true・settingSources）はこの profile だけ
import { homedir } from "node:os";
import { join, resolve, sep } from "node:path";
import type {
  CanUseTool,
  HookCallback,
  HookCallbackMatcher,
  McpSdkServerConfigWithInstance,
  Options,
} from "@anthropic-ai/claude-agent-sdk";
import { ccPlacesOf, projectDir as verifiedProjectDir } from "../cc/starter.ts";
import type { Config } from "../config.ts";
import { resolveRealPath } from "./file-access.ts";
import { childEnv } from "./query-options.ts";
import { isProjectPermissionMode, type ProjectPermissionMode, type RunContext, type RunInput } from "./runner.ts";
import { createWebFetchGuard, type ProfileRunState, type RunnerProfile, ownerApiKeySource } from "./sdk-runner.ts";
import { PROJECT_APPEND } from "./system-prompt.ts";
import { MCP_SERVER_NAME } from "./tools.ts";

/** プロジェクトのセッションで外す CLI の組み込みツール（U1。質問は U2 で canUseTool → 質問カードにする） */
export const PROJECT_DISALLOWED_TOOLS: readonly string[] = ["AskUserQuestion"];

/** 要約のターン（/close・/renew）でさらに外すツール（書く・動かす・サブエージェント） */
export const PROJECT_SUMMARY_DISALLOWED_TOOLS: readonly string[] = ["Bash", "Edit", "Write", "MultiEdit", "NotebookEdit", "Agent"];

/** 秘密の場所の拒否の理由（モデルへ返す） */
export const PROJECT_SECRET_DENIED_REASON = "self-agent の秘密の場所は読めません";
/** 秘密の場所の判定が例外で終わったときの理由 */
export const PROJECT_SECRET_GUARD_FAILED_REASON = "判定に失敗したため拒否しました";

/** 秘密の場所の判定の対象のツール */
const SECRET_GUARD_TOOLS: readonly string[] = ["Read", "Edit", "Write", "MultiEdit", "Glob", "Grep", "NotebookEdit"];
/** 下へ辿って探すツール（対象の場所が秘密の場所を含むときも拒否する） */
const SEARCH_TOOLS: readonly string[] = ["Glob", "Grep"];
/** パスを持つ入力の項目 */
const PATH_KEYS: readonly string[] = ["file_path", "path", "notebook_path"];

/** run の context に入れるプロジェクトの検証に失敗したときの例外の文（パスは入れない） */
export const PROJECT_DIR_INVALID_ERROR = "プロジェクトのディレクトリを開けません";

export type ProjectProfileDeps = {
  cfg: Pick<
    Config,
    "model" | "effort" | "workDir" | "dataDir" | "claudeConfigDir" | "workspaceDir" | "sessionMaxTurns"
  >;
  /** 自前の MCP サーバー（軽いモードと同じ tools.ts の createTaskMcpServer。run ごとに作る） */
  createMcpServer: (context?: RunContext) => McpSdkServerConfigWithInstance;
  /** 許可の橋（permission-bridge.ts の createPermissionBridge）。run の context と session_id から canUseTool を作る */
  canUseTool: (
    context: RunContext,
    sessionId: () => string | undefined,
    run: Pick<ProfileRunState, "waitPermission" | "signal">,
  ) => CanUseTool;
  /** ~ の場所（既定は homedir()） */
  home?: string;
  /** 子プロセスに写す元の env（既定は process.env） */
  env?: NodeJS.ProcessEnv;
  /** 許可のモードの補正の log（hook の log は runner の log） */
  log: (message: string) => void;
};

/** 実際の場所（解決できなければ絶対パスにしただけのもの） */
function realOrResolved(path: string): string {
  return resolveRealPath(path) ?? resolve(path);
}

/** child が dir と同じか、その中か */
function isSameOrInside(child: string, dir: string): boolean {
  return child === dir || child.startsWith(dir.endsWith(sep) ? dir : dir + sep);
}

/** `~` で始まるパスをホームに展開する（`~user` は展開しない） */
function expandHome(path: string, home: string): string {
  if (path === "~") return home;
  if (path.startsWith("~/")) return join(home, path.slice(2));
  return path;
}

/** Glob の pattern のうち、glob の文字（* ? [ {）を含む要素より前の部分（探し始める場所）。無ければ空 */
function staticPrefix(pattern: string): string {
  const parts = pattern.split("/");
  const index = parts.findIndex((part) => /[*?[{]/.test(part));
  return (index === -1 ? parts : parts.slice(0, index)).join("/");
}

/**
 * 秘密の場所（docs/plan/unify.md §5.5 の 3）。dataDir・CLAUDE_CONFIG_DIR・~/.config/self-agent・~/.ssh・~/.config/gh・~/.claude（オーナーの .credentials.json）・
 * /proc（プロセスの environ など）
 */
export function projectSecretPlaces(cfg: Pick<Config, "dataDir" | "claudeConfigDir">, home: string): string[] {
  return [
    cfg.dataDir,
    cfg.claudeConfigDir,
    join(home, ".config/self-agent"),
    join(home, ".ssh"),
    join(home, ".config/gh"),
    join(home, ".claude"),
    "/proc",
  ];
}

/**
 * ツールの入力が秘密の場所を指すか（純関数に近い。realpath だけ読む）。対象は file_path・path・notebook_path（無ければ cwd）と、
 * Glob の pattern の探し始める場所。パスの字面（resolve したもの）と realpath のどちらかが秘密の場所（字面と realpath の両方）の中なら true。
 * Glob・Grep は対象の場所が秘密の場所を含む（祖先）ときも true（下へ辿って読めるため）。解決できなければ true（fail-closed）
 */
export function touchesSecretPlace(
  toolName: string,
  toolInput: unknown,
  cwd: string,
  secrets: readonly string[],
  home: string,
): boolean {
  const input = typeof toolInput === "object" && toolInput !== null ? (toolInput as Record<string, unknown>) : {};
  const raws: string[] = [];
  for (const key of PATH_KEYS) {
    const value = input[key];
    if (typeof value === "string" && value !== "") raws.push(value);
  }
  const search = SEARCH_TOOLS.includes(toolName);
  if (raws.length === 0) raws.push(cwd);
  if (toolName === "Glob" && typeof input.pattern === "string") {
    const base = typeof input.path === "string" && input.path !== "" ? input.path : cwd;
    const prefix = staticPrefix(input.pattern);
    if (input.pattern.startsWith("/")) raws.push(prefix === "" ? "/" : prefix);
    else if (input.pattern.startsWith("~")) raws.push(prefix);
    else raws.push(join(expandHome(base, home), prefix));
  }
  const places = secrets.flatMap((place) => [resolve(place), realOrResolved(place)]);
  for (const raw of raws) {
    const literal = resolve(cwd, expandHome(raw, home));
    const real = resolveRealPath(literal);
    if (real === undefined) return true;
    for (const target of [literal, real]) {
      for (const place of places) {
        if (isSameOrInside(target, place)) return true;
        if (search && isSameOrInside(place, target)) return true;
      }
    }
  }
  return false;
}

/**
 * 秘密の場所の Read・Edit・Write・MultiEdit・Glob・Grep・NotebookEdit を拒否する PreToolUse の hook（docs/plan/unify.md §5.5 の 3）。
 * Bash の字面は見ない（境界は許可のカード）。判定が例外なら拒否（fail-closed）。log はツール名だけ（パスは出さない）
 */
export function createSecretPlaceGuard(
  secrets: readonly string[],
  home: string,
  log: (message: string) => void,
): HookCallbackMatcher {
  const deny = (reason: string) => ({
    hookSpecificOutput: { hookEventName: "PreToolUse" as const, permissionDecision: "deny" as const, permissionDecisionReason: reason },
  });
  const guard: HookCallback = async (input) => {
    if (input.hook_event_name !== "PreToolUse" || !SECRET_GUARD_TOOLS.includes(input.tool_name)) return {};
    try {
      if (!touchesSecretPlace(input.tool_name, input.tool_input, input.cwd, secrets, home)) return {};
      log(`プロジェクトのセッション: 秘密の場所の操作を拒否しました（${input.tool_name}）`);
      return deny(PROJECT_SECRET_DENIED_REASON);
    } catch {
      log(`プロジェクトのセッション: 秘密の場所の判定に失敗したため拒否しました（${input.tool_name}）`);
      return deny(PROJECT_SECRET_GUARD_FAILED_REASON);
    }
  };
  return { matcher: SECRET_GUARD_TOOLS.join("|"), hooks: [guard] };
}

/** Claude の子プロセスの env（軽いモードの childEnv から記録の場所の固定とバックグラウンド実行の無効を外す。自動メモリ無効は U3 まで残す） */
export function projectChildEnv(cfg: Pick<Config, "claudeConfigDir" | "workDir">, source: NodeJS.ProcessEnv): Record<string, string> {
  const env = childEnv(cfg.claudeConfigDir, cfg.workDir, source);
  delete env.CLAUDE_CODE_PROJECT_DIR_NAME;
  delete env.CLAUDE_CODE_DISABLE_BACKGROUND_TASKS;
  return env;
}

/** run の許可のモード（default / acceptEdits / plan だけ。それ以外・無ければ default） */
function permissionModeOf(context: RunContext, log: (message: string) => void): ProjectPermissionMode {
  const mode = context.permissionMode;
  if (mode === undefined) return "default";
  if (isProjectPermissionMode(mode)) return mode;
  log("プロジェクトのセッション: 許可のモードが選べるものでないため default にしました");
  return "default";
}

/**
 * プロジェクトのセッションの RunnerProfile。buildOptions は run の context の projectDir を cc/starter.ts の projectDir で確かめて
 * （名前の形・symlink でない実際のディレクトリ・realpath・守る場所と重ならない）cwd にし、通らなければ投げる（その run は失敗）。
 */
export function createProjectProfile(deps: ProjectProfileDeps): RunnerProfile {
  const { cfg, log } = deps;
  const home = deps.home ?? homedir();
  const source = deps.env ?? process.env;
  const places = ccPlacesOf(cfg, home);
  const secrets = projectSecretPlaces(cfg, home);
  return {
    buildOptions: (input: RunInput, run: ProfileRunState): Options => {
      const context = input.context;
      if (context === undefined || context.projectDir === undefined) throw new Error(PROJECT_DIR_INVALID_ERROR);
      const cwd = verifiedProjectDir(context.projectDir, places);
      if (cwd === undefined) throw new Error(PROJECT_DIR_INVALID_ERROR);
      const summaryTurn = context.purpose === "close" || context.purpose === "renew";
      return {
        model: cfg.model,
        // Claude Code の preset に self-agent の文を足す。snapshot: true で会話ごとに記録して固定する（プロジェクトのセッションだけの例外。docs/plan/unify.md §5.4）
        systemPrompt: { type: "preset", preset: "claude_code", append: PROJECT_APPEND, snapshot: true },
        // ユーザー（Bot の CLAUDE_CONFIG_DIR）・プロジェクト・ローカルの設定・CLAUDE.md・skills・agents を読む
        settingSources: ["user", "project", "local"],
        cwd,
        // tools は付けない（CLI の既定。Bash・Grep・Agent・Skill …）。要約のターン（/close・/renew）は書く・動かすツールも外し、
        // モードを default に固定する（acceptEdits・設定の permissions.allow・常に許可は canUseTool を通らないため。橋の拒否は二重の守り）
        disallowedTools: summaryTurn ? [...PROJECT_DISALLOWED_TOOLS, ...PROJECT_SUMMARY_DISALLOWED_TOOLS] : [...PROJECT_DISALLOWED_TOOLS],
        permissionMode: summaryTurn ? "default" : permissionModeOf(context, log),
        // 自前のツールと Web の 2 つはカードを出さない（今の dontAsk と同じ扱い。WebFetch の URL は hook で絞る）
        allowedTools: [`mcp__${MCP_SERVER_NAME}__*`, "WebSearch", "WebFetch"],
        mcpServers: { [MCP_SERVER_NAME]: deps.createMcpServer(context) },
        strictMcpConfig: true,
        ...(cfg.effort === undefined ? {} : { effort: cfg.effort }),
        maxTurns: cfg.sessionMaxTurns,
        env: projectChildEnv(cfg, source),
        canUseTool: deps.canUseTool(context, run.sessionId, run),
      };
    },
    toolHooks: (hookLog, input) => {
      const webFetch = createWebFetchGuard(input.allowedUrls ?? [], hookLog);
      return {
        preToolUse: [webFetch.preToolUse, createSecretPlaceGuard(secrets, home, hookLog)],
        postToolUse: [webFetch.postToolUse],
      };
    },
    acceptsApiKeySource: ownerApiKeySource,
  };
}
