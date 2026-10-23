// ゲストのターンの Options と runner（docs/plan/guest-mode.md §3.0・§3.3）。ツールは Options で無くし（tools: []・allowedTools: []・MCP サーバーなし）、
// PreToolUse の全拒否の hook で二重に塞ぐ。認証は API キー（ANTHROPIC_API_KEY）で、オーナーの OAuth・設定ディレクトリは子に渡さない。
// プロンプトキャッシュのため、全 run で同じ Options を使う
import { join } from "node:path";
import type { HookCallback, HookCallbackMatcher, Options } from "@anthropic-ai/claude-agent-sdk";
import { WORK_CWD_DIR_NAME } from "../agent/disk.ts";
import { guestChildEnv, guestClaudeConfigDir } from "../agent/query-options.ts";
import { type QueryFn, type RunnerProfile, SdkAgentRunner } from "../agent/sdk-runner.ts";
import type { Config, Effort } from "../config.ts";
import { GUEST_SYSTEM_PROMPT } from "./system-prompt.ts";

/** ゲストのターンの手順（maxTurns）の上限。ツールが無いので 1 で足りる（保険） */
export const GUEST_MAX_TURNS = 1;

/** ツールを拒否したときにモデルへ返す理由 */
export const GUEST_TOOL_DENIED_REASON = "このモードではツールを使えません";

/** ゲストの runner が受け付ける init の apiKeySource（API キーの環境変数）。それ以外（OAuth の none など）は失敗にする */
export function guestApiKeySource(source: unknown): boolean {
  return source === "ANTHROPIC_API_KEY";
}

/** ゲストの Options（全 run で同じ値）。env は guestChildEnv で作ったもの */
export function buildGuestQueryOptions(cfg: {
  model: string;
  effort: Effort;
  workDir: string;
  env: Record<string, string>;
}): Options {
  return {
    model: cfg.model,
    effort: cfg.effort,
    // 既定の人格と同じく記録させずに毎回送る（snapshot: false）
    systemPrompt: { type: "custom", prompt: GUEST_SYSTEM_PROMPT, snapshot: false },
    // 組み込みツールをすべて無効にし、何も許可しない。MCP サーバーは入れず、ほかの MCP 設定も読まない
    tools: [],
    allowedTools: [],
    strictMcpConfig: true,
    settingSources: [],
    permissionMode: "dontAsk",
    // オーナーと同じ空の専用ディレクトリ（ツールが無いので、tick で中身が消えても困らない）
    cwd: join(cfg.workDir, WORK_CWD_DIR_NAME),
    env: cfg.env,
    maxTurns: GUEST_MAX_TURNS,
  };
}

/** PreToolUse の全拒否（matcher なし）。log にはツール名だけを出す（入力は出さない） */
export function createGuestToolDenyHook(log: (message: string) => void): HookCallbackMatcher {
  const deny: HookCallback = async (input) => {
    if (input.hook_event_name !== "PreToolUse") return {};
    log(`ツールの呼び出しを拒否しました（${input.tool_name}）`);
    return {
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: GUEST_TOOL_DENIED_REASON,
      },
    };
  };
  return { hooks: [deny] };
}

/** ゲストの runner の Options と hooks の組み立て方。env は run ごとに source から作る（API キーは source の SELF_AGENT_GUEST_API_KEY） */
export function guestRunnerProfile(
  cfg: Pick<Config, "guestModel" | "guestEffort" | "workDir" | "claudeConfigDir">,
  source: NodeJS.ProcessEnv = process.env,
): RunnerProfile {
  return {
    buildOptions: () =>
      buildGuestQueryOptions({
        model: cfg.guestModel,
        effort: cfg.guestEffort,
        workDir: cfg.workDir,
        env: guestChildEnv(guestClaudeConfigDir(cfg.claudeConfigDir), cfg.workDir, source),
      }),
    preToolUse: (log) => [createGuestToolDenyHook(log)],
    acceptsApiKeySource: guestApiKeySource,
    // 失敗の文（handler が log に出す）に API・CLI のエラー文を入れない
    summarizeErrors: true,
  };
}

export type GuestRunnerDeps = {
  cfg: Pick<Config, "guestModel" | "guestEffort" | "guestTurnTimeoutSec" | "workDir" | "claudeConfigDir">;
  /** runner の log には `guest: ` を前に付けて渡す */
  log: (message: string) => void;
  /** 既定は process.env */
  source?: NodeJS.ProcessEnv;
  /** テスト用。既定は SDK の query */
  queryFn?: QueryFn;
};

/**
 * ゲストの runner。MCP サーバー・ファイル・Bash・WebFetch の hook は作らない。dev ログは渡さない（ゲストの本文を残さない）。
 * 打ち切りは guestTurnTimeoutSec（context を渡さないので turnTimeoutSec が効く）、手順は Options の maxTurns（1）
 */
export function createGuestRunner(deps: GuestRunnerDeps): SdkAgentRunner {
  const { cfg } = deps;
  return new SdkAgentRunner(
    {
      model: cfg.guestModel,
      effort: cfg.guestEffort,
      workDir: cfg.workDir,
      claudeConfigDir: guestClaudeConfigDir(cfg.claudeConfigDir),
      turnTimeoutSec: cfg.guestTurnTimeoutSec,
      sessionMaxTurns: GUEST_MAX_TURNS,
      sessionTurnTimeoutSec: cfg.guestTurnTimeoutSec,
    },
    undefined,
    undefined,
    (message) => deps.log(`guest: ${message}`),
    deps.queryFn,
    undefined,
    guestRunnerProfile(cfg, deps.source),
  );
}
