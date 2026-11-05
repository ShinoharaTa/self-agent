// Claude Code の hooks の設定を出す（docs/plan/claude-code-sessions.md §2.4。npm run cc-setup -- --print）。self-agent は ~/.claude を触らないので、
// オーナーが ~/.claude/settings.json に 1 回だけ書く形を、ポート（SELF_AGENT_CC_HOOK_PORT）と PermissionRequest の timeout
// （SELF_AGENT_CC_PERMISSION_HOLD_SEC と SELF_AGENT_CC_QUESTION_HOLD_SEC の大きい方 + 5）を埋めて標準出力に出す。ファイルは書かない。トークンの値は出さず、置き場所の文にする
import { type CcConfig, loadCcConfig } from "../config.ts";
import { CC_HOOK_PATH } from "../cc/hook-server.ts";

/** hooks の timeout（秒）。http は同期なので短くし、self-agent が落ちていても発言を待たせない */
export const CC_HOOK_TIMEOUT_SEC = 3;
/** PermissionRequest の timeout は保留の秒数（許可と質問の大きい方）にこれを足す */
export const CC_PERMISSION_TIMEOUT_MARGIN_SEC = 5;
/** env に置くトークンの値の代わりに出す文 */
export const CC_TOKEN_PLACEHOLDER = "<~/.config/self-agent/env の SELF_AGENT_CC_HOOK_TOKEN と同じ値>";

const USAGE = "使い方: npm run cc-setup -- --print（~/.claude/settings.json に足す hooks の設定を標準出力に出す。ファイルは書かない）";

/**
 * hooks を付ける事象（§2.4。matcher は付けない）。SessionStart は http hook に対応していない（Claude Code の debug log で確かめた）ので付けない
 * （受け口は受けられるまま）
 */
const EVENTS = ["UserPromptSubmit", "Stop", "SessionEnd", "Notification", "PermissionRequest"] as const;

/** ~/.claude/settings.json に足す env と hooks（純関数） */
export function ccHookSettings(cfg: Pick<CcConfig, "ccPermissionHoldSec" | "ccQuestionHoldSec">, port: number): Record<string, unknown> {
  const hook = (timeout: number) => ({
    type: "http",
    url: `http://127.0.0.1:${port}${CC_HOOK_PATH}`,
    timeout,
    headers: { "X-Self-Agent-Hook": "$SELF_AGENT_CC_HOOK_TOKEN" },
    allowedEnvVars: ["SELF_AGENT_CC_HOOK_TOKEN"],
  });
  const hooks: Record<string, unknown> = {};
  // 質問（AskUserQuestion）も同じ PermissionRequest の hook で届くので、長い方の保留に合わせる
  const holdSec = Math.max(cfg.ccPermissionHoldSec, cfg.ccQuestionHoldSec);
  for (const event of EVENTS) {
    const timeout = event === "PermissionRequest" ? holdSec + CC_PERMISSION_TIMEOUT_MARGIN_SEC : CC_HOOK_TIMEOUT_SEC;
    hooks[event] = [{ hooks: [hook(timeout)] }];
  }
  return { env: { SELF_AGENT_CC_HOOK_TOKEN: CC_TOKEN_PLACEHOLDER }, hooks };
}

export async function main(argv: readonly string[], env: NodeJS.ProcessEnv = process.env): Promise<number> {
  if (argv.length !== 1 || argv[0] !== "--print") {
    console.error(USAGE);
    return 2;
  }
  let cfg: CcConfig;
  try {
    cfg = loadCcConfig(env);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  }
  if (cfg.ccHookPort === undefined) {
    console.error("SELF_AGENT_CC_HOOK_PORT が設定されていません（~/.config/self-agent/env に置いてください）");
    return 1;
  }
  console.log(JSON.stringify(ccHookSettings(cfg, cfg.ccHookPort), null, 2));
  console.error(
    "（~/.claude/settings.json の env と hooks に足してください。env の値は ~/.config/self-agent/env の SELF_AGENT_CC_HOOK_TOKEN と同じものに置き換えます。このコマンドはファイルを書きません）",
  );
  return 0;
}
