// AgentRunner の Agent SDK 実装。query() を使うのはこのファイルだけ
import {
  query,
  type HookCallback,
  type HookCallbackMatcher,
  type HookJSONOutput,
  type McpSdkServerConfigWithInstance,
  type Options,
  type SDKMessage,
  type SDKResultMessage,
  type SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import type { Config } from "../config.ts";
import { devLogResult, devLogToolInput, truncateText, type DevLogSink, type DevLogStep } from "../devlog/log.ts";
import type { ProjectStore } from "../store/projects.ts";
import type { DiskQuota } from "./disk.ts";
import {
  FILE_NO_CONTEXT_REASON,
  FILE_TOOLS,
  FILE_WRITE_DENIED_REASON,
  FILE_WRITE_TOOLS,
  judgeFileAccess,
  resolveRealPath,
} from "./file-access.ts";
import { normalizeUrl } from "./url.ts";
import { buildQueryOptions, ensureSandboxWriteDirs } from "./query-options.ts";
import type {
  AgentRunner,
  Compaction,
  RunContext,
  RunImage,
  RunInput,
  RunResult,
  StepUsage,
  TurnUsage,
} from "./runner.ts";
import { MCP_SERVER_NAME } from "./tools.ts";

/** query() の形。テストでは偽のストリームを返す関数に差し替える */
export type QueryFn = (params: {
  prompt: string | AsyncIterable<SDKUserMessage>;
  options: Options;
}) => AsyncIterable<SDKMessage>;

/**
 * 画像付きのターンの prompt。[text, ...画像] の content を持つユーザーメッセージを 1 件だけ流して終える。
 * 形は SDK が文字列の prompt から作るもの（session_id は空、parent_tool_use_id は null）に画像の block を足したもの。
 * client_composed は付けない（付けるとターンの始めの添付（スキルの一覧など）が付かない）
 */
export async function* imagePrompt(text: string, images: readonly RunImage[]): AsyncIterable<SDKUserMessage> {
  yield {
    type: "user",
    session_id: "",
    message: {
      role: "user",
      content: [
        { type: "text", text },
        ...images.map((image) => ({
          type: "image" as const,
          source: { type: "base64" as const, media_type: image.mediaType, data: image.data },
        })),
      ],
    },
    parent_tool_use_id: null,
  };
}

/** query() に渡す prompt。画像が無ければ文字列のまま（今までと同じ）、あれば imagePrompt */
export function queryPrompt(input: Pick<RunInput, "prompt" | "images">): string | AsyncIterable<SDKUserMessage> {
  return input.images === undefined || input.images.length === 0 ? input.prompt : imagePrompt(input.prompt, input.images);
}

/** #inbox・#tasks と context の無いターン（#inbox・#tasks の要約）の手順（maxTurns）の上限。セッションのチャンネルは cfg.sessionMaxTurns */
export const INBOX_MAX_TURNS = 8;

const ERROR_TEXT_LIMIT = 200;
/** Claude の子プロセスの stderr のうち保持する末尾の文字数 */
const STDERR_KEEP_LENGTH = 2000;

/** ログ向けに 1 行・上限文字数に縮める */
function shorten(text: string): string {
  const oneLine = text.replace(/\s+/g, " ").trim();
  return oneLine.length > ERROR_TEXT_LIMIT ? `${oneLine.slice(0, ERROR_TEXT_LIMIT)}…` : oneLine;
}

/**
 * resume 先の会話の記録が無いときの CLI の文言（app/turn.ts の RESUME_FAILURE_PATTERN と同じ）。
 * シェルが有効なときは stderr の末尾を errorMessage に入れないので、これだけは印として残す（turn.ts が resume 失敗を見分けられるように）
 */
const RESUME_FAILURE_TEXT = "No conversation found";

/**
 * シェルが有効なときの stderr の扱い（shell.md §2.8）。末尾は出さず（sandbox の拒否の文がホスト名・パスを含みうる）、大きさだけを返す。
 * resume 失敗の文言があればその固定の文だけ添える。空なら空文字
 */
function stderrSummary(text: string): string {
  if (text.trim() === "") return "";
  const resume = text.toLowerCase().includes(RESUME_FAILURE_TEXT.toLowerCase()) ? `・${RESUME_FAILURE_TEXT}` : "";
  return `stderr あり（${text.length} 字）${resume}`;
}

/** stderr を 1 行にして末尾の上限文字数だけ残す（空なら空文字）。サロゲートペアの途中から始まれば後半も落とす */
function stderrTail(text: string): string {
  const oneLine = text.replace(/\s+/g, " ").trim();
  if (oneLine.length <= ERROR_TEXT_LIMIT) return oneLine;
  let tail = oneLine.slice(-ERROR_TEXT_LIMIT);
  if (/^[\uDC00-\uDFFF]/.test(tail)) tail = tail.slice(1);
  return `…${tail}`;
}

/**
 * result のエラーを 1 行にする。errors があれば添える（resume 失敗の文言などを handler が判定できるように残す）。
 * result の本文（result.result）は会話の内容を含みうるので、is_error でも入れない
 */
export function describeResultError(result: SDKResultMessage): string {
  if (result.subtype === "success") {
    return "success (is_error)";
  }
  const errors = result.errors.filter((error) => error.trim() !== "");
  return errors.length === 0 ? result.subtype : `${result.subtype}: ${shorten(errors.join(" / "))}`;
}

/**
 * API が画像（か大きすぎるリクエスト）を受け付けなかったことを示すエラー文か。エラーの経路（API エラーの assistant メッセージ・
 * is_error の result・result の errors・例外と stderr）の文だけに使う。狭く取る: request_too_large・413、
 * または invalid_request_error / 400 と image を両方含むもの、画像を処理できない旨の文
 */
export function isImageRejection(text: string): boolean {
  if (/request_too_large|request too large|API Error: 413\b/i.test(text)) return true;
  if (/invalid_request_error|API Error: 400\b/i.test(text) && /\bimage/i.test(text)) return true;
  return /could not process image|image (?:exceeds|was too large|is too large|dimensions exceed)/i.test(text);
}

/** ステップごとの usage（起きた順）から、このターンの入力側の usage（合計と内訳）を作る。出力は入れない */
function toTurnUsage(steps: readonly StepUsage[]): TurnUsage {
  const usage: TurnUsage = {
    inputTokens: 0,
    cacheReadInputTokens: 0,
    cacheCreationInputTokens: 0,
    cacheCreation1hInputTokens: 0,
    steps: [...steps],
  };
  for (const step of steps) {
    usage.inputTokens += step.inputTokens;
    usage.cacheReadInputTokens += step.cacheReadInputTokens;
    usage.cacheCreationInputTokens += step.cacheCreationInputTokens;
    usage.cacheCreation1hInputTokens += step.cacheCreation1hInputTokens;
  }
  return usage;
}

/** ツール呼び出しの記録。hooks を Options に入れ、count でそのターンの回数を読む */
export type ToolCallRecorder = {
  hooks: NonNullable<Options["hooks"]>;
  count(): number;
};

/**
 * ツール呼び出しを数え、ツール名と所要時間（取れなければ名前だけ）を log に出す。失敗した呼び出しも数え、失敗として出す。
 * ツールの入力・出力・エラーの中身は log に出さない。hooks は SDK 側（クライアント）で呼ばれるだけなので、プロンプトキャッシュには影響しない
 */
export function createToolCallRecorder(log: (message: string) => void): ToolCallRecorder {
  let calls = 0;
  const duration = (ms: number | undefined): string => (typeof ms === "number" ? `（${ms} ms）` : "");
  const onToolUse: HookCallback = async (input) => {
    if (input.hook_event_name === "PostToolUse") {
      calls++;
      log(`ツールを呼び出しました: ${input.tool_name}${duration(input.duration_ms)}`);
    } else if (input.hook_event_name === "PostToolUseFailure") {
      calls++;
      log(`ツールの呼び出しが失敗しました: ${input.tool_name}${duration(input.duration_ms)}`);
    }
    return {};
  };
  return {
    hooks: { PostToolUse: [{ hooks: [onToolUse] }], PostToolUseFailure: [{ hooks: [onToolUse] }] },
    count: () => calls,
  };
}

/** 自前の MCP ツールの名前の接頭辞（途中経過ではこれを除いた名前を出す） */
const MCP_TOOL_PREFIX = `mcp__${MCP_SERVER_NAME}__`;

/**
 * file_path（cwd を基準に絶対パスにする）が projectDir の中なら、projectDir からの相対パス。
 * どちらも resolveRealPath で実際の場所にして比べる。中でない・file_path が無い・解決できないなら undefined
 */
function projectRelativePath(toolInput: unknown, cwd: string, projectDir: string | undefined): string | undefined {
  if (projectDir === undefined || typeof toolInput !== "object" || toolInput === null) return undefined;
  const filePath = (toolInput as Record<string, unknown>).file_path;
  if (typeof filePath !== "string") return undefined;
  const target = resolveRealPath(resolve(cwd, filePath));
  const dir = resolveRealPath(projectDir);
  if (target === undefined || dir === undefined) return undefined;
  const rel = relative(dir, target);
  return rel === "" || isAbsolute(rel) || rel.split(sep)[0] === ".." ? undefined : rel;
}

/**
 * 途中経過に出す 1 手順の文。ファイルの中身・コマンド（Bash の command・description）・URL・検索語は出さない。
 * Write・Edit・Read の対象は、このチャンネルのプロジェクトのディレクトリ（projectDir）の中ならそこからの相対パスだけを添える
 */
export function progressLabel(
  toolName: string,
  toolInput: unknown,
  cwd: string,
  projectDir: string | undefined,
): string {
  const withPath = (label: string): string => {
    const rel = projectRelativePath(toolInput, cwd, projectDir);
    return rel === undefined ? label : `${label}: ${rel}`;
  };
  switch (toolName) {
    case "Write":
    case "Edit":
      return withPath("書いています");
    case "Read":
      return withPath("読んでいます");
    case "Glob":
      return "ファイルを探しています";
    case "WebSearch":
      return "Web を検索しています";
    case "WebFetch":
      return "ページを読んでいます";
    case "Bash":
      return "コマンドを実行しています";
  }
  if (toolName === `${MCP_TOOL_PREFIX}project_files`) return "ファイルを整理しています";
  if (toolName.startsWith(MCP_TOOL_PREFIX)) return `ツールを使っています: ${toolName.slice(MCP_TOOL_PREFIX.length)}`;
  return `${toolName} を使っています`;
}

/** WebFetch を拒否したときにモデルへ返す理由 */
export const WEB_FETCH_DENIED_REASON = "オーナーが発言に貼った URL だけ取得できます";

/** 1 ターンで WebFetch の許可に加える転送先の数の上限 */
export const WEB_FETCH_MAX_REDIRECTS = 5;

/**
 * WebFetch の結果のうち転送先を示す行（CLI の `Redirect URL (from the server's Location header — …): <url>`）。
 * URL の後ろに注記が続く行（長すぎて切り詰めた・取得できない宛先）は対象にしない
 */
const REDIRECT_LINE_PATTERN = /^[ \t]*Redirect URL \([^)\n]*\): (https?:\/\/\S+)[ \t]*$/m;

/**
 * WebFetch の tool_response（CLI の出力 `{ bytes, code, codeText, result, durationMs, url }`）が転送を示すなら、その結果のテキスト。
 * 転送かどうかは HTTP の状態コード（code が 300〜399）で判定する。普通のページの result はページの中身をもとにした要約で、
 * 偽の Redirect 行を含みうるので読まない。転送先は構造化された項目に無いので result の Redirect 行から読む。
 * code を持たない形（文字列・content ブロックの配列など）は転送と判定できないので undefined
 */
function webFetchRedirectText(response: unknown): string | undefined {
  if (typeof response !== "object" || response === null || Array.isArray(response)) return undefined;
  const { code, result } = response as Record<string, unknown>;
  if (typeof code !== "number" || !Number.isInteger(code) || code < 300 || code > 399) return undefined;
  return typeof result === "string" ? result : undefined;
}

/** 転送先（正規化したもの）と、http なら同じ URL の https（ページは https で取得されることがある） */
function redirectTargets(redirectUrl: string): string[] {
  const url = new URL(redirectUrl);
  if (url.protocol !== "http:") return [redirectUrl];
  url.protocol = "https:";
  const https = normalizeUrl(url.href);
  return https === undefined ? [redirectUrl] : [redirectUrl, https];
}

/** WebFetch の tool_input の url を正規化したもの。無い・解析できなければ undefined */
function webFetchUrl(toolInput: unknown): string | undefined {
  return typeof toolInput === "object" && toolInput !== null && "url" in toolInput && typeof toolInput.url === "string"
    ? normalizeUrl(toolInput.url)
    : undefined;
}

/** WebFetch のガード。PreToolUse で取得する URL を絞り、PostToolUse で結果の転送先をそのターンの許可に加える */
export type WebFetchGuard = { preToolUse: HookCallbackMatcher; postToolUse: HookCallbackMatcher };

/**
 * WebFetch を、allowedUrls（このターンにオーナーが貼った URL）に含まれる URL だけに絞る。
 * PreToolUse の hook は、含まれない・解析できない URL を拒否して log に出す（URL は出さない）。
 * PostToolUse の hook は、許可済みの URL を WebFetch した結果が転送（code が 3xx で、result に Redirect URL の行）なら、
 * その転送先（http なら https も）をこのターンの許可に加える（転送先の転送も同じ。1 ターンで WEB_FETCH_MAX_REDIRECTS 回まで。
 * log に URL は出さない）。WebFetch 以外のツールは何もしない
 */
export function createWebFetchGuard(allowedUrls: readonly string[], log: (message: string) => void): WebFetchGuard {
  const allowed = new Set(allowedUrls.map(normalizeUrl).filter((url) => url !== undefined));
  let redirects = 0;
  const guard: HookCallback = async (input) => {
    if (input.hook_event_name !== "PreToolUse" || input.tool_name !== "WebFetch") return {};
    const url = webFetchUrl(input.tool_input);
    // 許可する URL は判断を足さずに通す（allowedTools の許可に任せる）
    if (url !== undefined && allowed.has(url)) return {};
    log("WebFetch を拒否しました（貼られていない URL）");
    return {
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: WEB_FETCH_DENIED_REASON,
      },
    };
  };
  // 許可済みの URL からの転送だけを辿る。http の転送先は https も加え、2 つで 1 回と数える。既に許可している転送先は数えない
  const followRedirect: HookCallback = async (input) => {
    if (input.hook_event_name !== "PostToolUse" || input.tool_name !== "WebFetch") return {};
    const url = webFetchUrl(input.tool_input);
    if (url === undefined || !allowed.has(url) || redirects >= WEB_FETCH_MAX_REDIRECTS) return {};
    const text = webFetchRedirectText(input.tool_response);
    const target = text === undefined ? undefined : REDIRECT_LINE_PATTERN.exec(text)?.[1];
    const redirectUrl = target === undefined ? undefined : normalizeUrl(target);
    if (redirectUrl === undefined) return {};
    const added = redirectTargets(redirectUrl).filter((candidate) => !allowed.has(candidate));
    if (added.length === 0) return {};
    for (const candidate of added) allowed.add(candidate);
    redirects++;
    log("WebFetch の転送先を許可しました");
    return {};
  };
  return {
    preToolUse: { matcher: "WebFetch", hooks: [guard] },
    postToolUse: { matcher: "WebFetch", hooks: [followRedirect] },
  };
}

/** ファイル操作の hook が使うプロジェクトのストアと場所 */
export type FileGuardDeps = {
  /** context のチャンネルのプロジェクトを引き、書き込みを許したら更新日時を今にする */
  projects: Pick<ProjectStore, "getByChannel" | "touch">;
  /** `<workDir>/projects` */
  projectsDir: string;
  /** Write・Edit を許す前の容量の判定（workDir の空きとプロジェクトの大きさ） */
  disk: Pick<DiskQuota, "check">;
};

/** ファイル操作の判定が例外で終わったときにモデルへ返す理由 */
export const FILE_GUARD_FAILED_REASON = "判定に失敗したため拒否しました";

/** シェルが有効なとき、セッション以外のターン（#inbox・#tasks）でファイルのツールを拒否したときにモデルへ返す理由（shell.md §2.9 の I2） */
export const FILE_SESSION_ONLY_REASON = "ファイルはセッションのチャンネルでだけ扱えます。project_open のあるセッションのチャンネルで頼むよう伝えてください";

/** project_files（自前の MCP ツール）の名前。シェルが有効なときはファイル操作の hook の対象に入れる */
const PROJECT_FILES_TOOL = `mcp__${MCP_SERVER_NAME}__project_files`;

/** PreToolUse の hook の拒否 */
function denyToolUse(reason: string): HookJSONOutput {
  return {
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: reason,
    },
  };
}

/**
 * ファイル操作（Read・Write・Edit・Glob）を judgeFileAccess で絞る PreToolUse の hook。context はこの run のチャンネル。
 * Write・Edit は judgeFileAccess で許すものでも、容量の上限（disk.check）を超えていれば拒否する。
 * 拒否したら理由をモデルに返し、log にはツール名だけを出す（パスは出さない）。Write・Edit を許したらプロジェクトの更新日時を今にする。
 * CLI は hook の例外を「判断なし」として通してしまうので、判定（ストアの読み書きを含む）が例外で終わったら拒否する（パス・例外の中身は log に出さない）。
 * shell（SELF_AGENT_SHELL=1）なら project_files も対象にし、セッション以外のターン（#inbox・#tasks・context の無いターン）では
 * Read・Glob・Write・Edit・project_files をすべて拒否する（セッションの Bash と同時に動くターンがプロジェクトに触れないように。shell.md §2.9 の I2）
 */
export function createFileGuard(
  context: RunContext | undefined,
  deps: FileGuardDeps,
  log: (message: string) => void,
  shell = false,
): HookCallbackMatcher {
  const { projects, projectsDir, disk } = deps;
  const tools = shell ? [...FILE_TOOLS, PROJECT_FILES_TOOL] : FILE_TOOLS;
  const guard: HookCallback = async (input) => {
    if (input.hook_event_name !== "PreToolUse" || !tools.includes(input.tool_name)) return {};
    if (shell && (context === undefined || context.kind !== "session")) {
      log(`ファイル操作を拒否しました（${input.tool_name}）`);
      return denyToolUse(context === undefined ? FILE_NO_CONTEXT_REASON : FILE_SESSION_ONLY_REASON);
    }
    // project_files の可否はツールの処理（tools.ts）が決める
    if (input.tool_name === PROJECT_FILES_TOOL) return {};
    try {
      const project = context === undefined ? undefined : projects.getByChannel(context.channelId);
      const decision = judgeFileAccess({
        toolName: input.tool_name,
        toolInput: input.tool_input,
        cwd: input.cwd,
        context,
        projectsDir,
        project,
      });
      if (decision.allowed) {
        if (project !== undefined && FILE_WRITE_TOOLS.includes(input.tool_name)) {
          const quota = disk.check(project.slug);
          if (!quota.allowed) {
            log(`ファイル操作を拒否しました（${input.tool_name}・容量: ${quota.kind === "free" ? "空き" : "プロジェクト"}）`);
            return denyToolUse(quota.reason);
          }
          projects.touch(project.id);
        }
        // 判断を足さずに通す（allowedTools の許可に任せる）
        return {};
      }
      log(`ファイル操作を拒否しました（${input.tool_name}）`);
      return denyToolUse(decision.reason);
    } catch {
      log(`ファイル操作の判定に失敗したため拒否しました（${input.tool_name}）`);
      return denyToolUse(FILE_GUARD_FAILED_REASON);
    }
  };
  return { matcher: tools.join("|"), hooks: [guard] };
}

/** Bash の拒否の理由（モデルへ返す） */
export const BASH_DISABLED_REASON = "今はコマンドを実行できません";
export const BASH_PLACE_REASON = "コマンドはセッションのチャンネルで使えます";
export const BASH_ARGS_REASON = "バックグラウンド実行と sandbox の外での実行はできません。run_in_background・dangerouslyDisableSandbox を付けずに実行してください";
export const BASH_GUARD_FAILED_REASON = "判定に失敗したため拒否しました";

/** Bash の hook が使うもの。enabled はこの run でシェルを使えるか（自己診断が通っていて bwrap・socat があり、sandbox を付けた） */
export type BashGuardDeps = Pick<FileGuardDeps, "projects" | "disk"> & { enabled: boolean };

/**
 * Bash の PreToolUse の hook（shell.md §2.5）。どの run にも入れる。上から順に判定して拒否し、理由をモデルに返す:
 * 1. この run でシェルを使えない 2. context が無い・セッションでない・予約した依頼・/close のターン 3. このチャンネルのプロジェクトが無い
 * 4. run_in_background・dangerouslyDisableSandbox 5. 容量の上限（Write・Edit と同じ disk.check。workDir の空き・プロジェクトの大きさ）。
 * 通すときは判断を足さない（sandbox の autoAllowBashIfSandboxed に任せる）。コマンドの中身は見ず、log は「Bash を拒否しました（<種類>）」だけ
 * （コマンド・description・パスは出さない）。判定が例外で終わったら拒否する（fail-closed）
 */
export function createBashGuard(
  context: RunContext | undefined,
  deps: BashGuardDeps,
  log: (message: string) => void,
): HookCallbackMatcher {
  const { projects, disk, enabled } = deps;
  const deny = (kind: string, reason: string): HookJSONOutput => {
    log(`Bash を拒否しました（${kind}）`);
    return denyToolUse(reason);
  };
  const guard: HookCallback = async (input) => {
    if (input.hook_event_name !== "PreToolUse" || input.tool_name !== "Bash") return {};
    try {
      if (!enabled) return deny("無効", BASH_DISABLED_REASON);
      if (
        context === undefined ||
        context.kind !== "session" ||
        context.scheduled === true ||
        context.purpose === "close"
      ) {
        return deny("場所", BASH_PLACE_REASON);
      }
      const project = projects.getByChannel(context.channelId);
      if (project === undefined) return deny("プロジェクトなし", FILE_WRITE_DENIED_REASON);
      const toolInput =
        typeof input.tool_input === "object" && input.tool_input !== null ? (input.tool_input as Record<string, unknown>) : {};
      if (toolInput.run_in_background === true || toolInput.dangerouslyDisableSandbox === true) {
        return deny("引数", BASH_ARGS_REASON);
      }
      const quota = disk.check(project.slug);
      if (!quota.allowed) return deny("容量", quota.reason);
      // 判断を足さずに通す（sandbox の autoAllowBashIfSandboxed に任せる）
      return {};
    } catch {
      return deny("判定の失敗", BASH_GUARD_FAILED_REASON);
    }
  };
  return { matcher: "Bash", hooks: [guard] };
}

/** tool_result の content をテキストにする（テキスト以外のブロックは `[<type>]`） */
function toolResultText(content: string | ReadonlyArray<{ type: string }> | undefined): string {
  if (content === undefined) return "";
  if (typeof content === "string") return content;
  return content
    .map((block) => ("text" in block && typeof block.text === "string" ? block.text : `[${block.type}]`))
    .join("\n");
}

/**
 * dev ログの steps に足す、メッセージ 1 つ分の手順（assistant のテキストと tool_use、user の tool_result、compact_boundary）。
 * thinking の中身は残さない。長い文字列は切る
 */
export function devLogSteps(message: SDKMessage): DevLogStep[] {
  if (message.type === "assistant") {
    const steps: DevLogStep[] = [];
    for (const block of message.message.content ?? []) {
      if (block.type === "text") {
        steps.push({ t: "text", text: truncateText(block.text) });
      } else if (block.type === "tool_use") {
        steps.push({ t: "tool_use", id: block.id, name: block.name, input: devLogToolInput(block.input) });
      }
    }
    return steps;
  }
  if (message.type === "user") {
    const content = message.message.content;
    if (typeof content === "string") return [];
    const steps: DevLogStep[] = [];
    for (const block of content) {
      if (block.type !== "tool_result") continue;
      steps.push({
        t: "tool_result",
        id: block.tool_use_id,
        isError: block.is_error === true,
        content: truncateText(toolResultText(block.content)),
      });
    }
    return steps;
  }
  if (message.type === "system" && message.subtype === "compact_boundary") {
    const metadata = message.compact_metadata;
    const preTokens = typeof metadata.pre_tokens === "number" ? metadata.pre_tokens : null;
    return [{ t: "compact", trigger: metadata.trigger, preTokens }];
  }
  return [];
}

/**
 * runner の設定。人格ごとに 1 つ作り、model・effort はその人格のもの。systemPrompt はその人格のシステムプロンプト
 * （省略すれば既定の人格の SYSTEM_PROMPT）。persona は足した人格の id（dev ログの印。既定の人格の runner では渡さず、記録にも付けない）
 */
export type SdkRunnerConfig = Pick<
  Config,
  "model" | "workDir" | "claudeConfigDir" | "turnTimeoutSec" | "effort" | "sessionMaxTurns" | "sessionTurnTimeoutSec"
> & {
  systemPrompt?: string;
  persona?: string;
  /** SELF_AGENT_SHELL=1。Bash をツールに入れる（省略は false） */
  shell?: boolean;
  /** sandbox の denyRead に入れるデータの場所（shell のときだけ要る） */
  dataDir?: string;
  /**
   * shell のとき、run の前に呼んでこの run でシェルを使えるか（自己診断が通っていて bwrap・socat がある。app/shell-state.ts の enabledForRun）。
   * true の run だけ Options.sandbox を付けて Bash を通す。省略・例外は使えない
   */
  shellAvailable?: () => boolean;
};

/** dev モードの会話ログの受け口と、開始時刻・所要時間に使う時計 */
export type DevLogDeps = { sink: DevLogSink; now: () => Date };

export class SdkAgentRunner implements AgentRunner {
  private readonly cfg: SdkRunnerConfig;
  private readonly createMcpServer: (context?: RunContext) => McpSdkServerConfigWithInstance;
  private readonly files: FileGuardDeps;
  private readonly log: (message: string) => void;
  private readonly queryFn: QueryFn;
  private readonly devLog: DevLogDeps | undefined;

  /**
   * MCP サーバーのインスタンスは同時に 1 つの query にしか接続できないため、run ごとに createMcpServer で作る。
   * ツール定義は毎回同じ（ハンドラが参照する context だけが変わる）なのでプロンプトキャッシュには影響しない。
   * files はファイル操作の hook が使う。log はツール呼び出しの記録に使う。queryFn は省略すれば SDK の query（テストで差し替える）。
   * devLog は dev モードのときだけ渡す（run ごとに 1 行記録する）。無ければ何もしない
   */
  constructor(
    cfg: SdkRunnerConfig,
    createMcpServer: (context?: RunContext) => McpSdkServerConfigWithInstance,
    files: FileGuardDeps,
    log: (message: string) => void,
    queryFn: QueryFn = query,
    devLog?: DevLogDeps,
  ) {
    this.cfg = cfg;
    this.createMcpServer = createMcpServer;
    this.files = files;
    this.log = log;
    this.queryFn = queryFn;
    this.devLog = devLog;
  }

  /**
   * セッションのチャンネルのターンは cfg.sessionTurnTimeoutSec、それ以外（#inbox・#tasks・context なし）は cfg.turnTimeoutSec で打ち切る。
   * input.signal が abort されたら（[中断]）同じ abortController で止める。
   * dev モードなら、起きた順の手順を集めて run の終わりに（成功・失敗・中断・打ち切りのどれでも）1 行記録する
   */
  async run(input: RunInput): Promise<RunResult> {
    const recording =
      this.devLog === undefined ? undefined : { devLog: this.devLog, startedAt: this.devLog.now(), steps: [] as DevLogStep[] };
    // 手順の上限はチャンネルの種類で変える（セッションのチャンネルは cfg.sessionMaxTurns、それ以外は INBOX_MAX_TURNS）
    const maxTurns = input.context?.kind === "session" ? this.cfg.sessionMaxTurns : INBOX_MAX_TURNS;
    const abortController = new AbortController();
    const timeoutSec = input.context?.kind === "session" ? this.cfg.sessionTurnTimeoutSec : this.cfg.turnTimeoutSec;
    const timer = setTimeout(() => abortController.abort(), timeoutSec * 1000);
    const onAbort = (): void => abortController.abort();
    input.signal?.addEventListener("abort", onAbort);
    if (input.signal?.aborted === true) abortController.abort();
    let result: RunResult;
    try {
      result = await this.runQuery(input, abortController, maxTurns, recording?.steps);
    } finally {
      clearTimeout(timer);
      input.signal?.removeEventListener("abort", onAbort);
    }
    if (recording !== undefined) this.writeDevLog(recording, input, maxTurns, result);
    return result;
  }

  /** dev ログに 1 行記録する。失敗してもターンは止めない（log には中身・パスを出さない） */
  private writeDevLog(
    recording: { devLog: DevLogDeps; startedAt: Date; steps: DevLogStep[] },
    input: RunInput,
    maxTurns: number,
    result: RunResult,
  ): void {
    const { devLog, startedAt, steps } = recording;
    try {
      devLog.sink.write({
        at: startedAt.toISOString(),
        durationMs: devLog.now().getTime() - startedAt.getTime(),
        guildId: input.context?.guildId ?? null,
        channelId: input.context?.channelId ?? null,
        kind: input.context?.kind ?? null,
        ...(this.cfg.persona === undefined ? {} : { persona: this.cfg.persona }),
        model: this.cfg.model,
        effort: this.cfg.effort ?? null,
        maxTurns,
        resume: input.sessionId ?? null,
        prompt: input.prompt,
        // 画像は枚数だけ（中身は書かない）
        ...(input.images === undefined || input.images.length === 0 ? {} : { images: input.images.length }),
        steps,
        result: devLogResult(result),
      });
    } catch {
      this.log("dev ログを書けませんでした");
    }
  }

  /**
   * この run でシェル（Bash）を使えるか。shell でなければ false。shellAvailable が true のときだけ、sandbox の書き込み先を作って true
   * （作れなければ log に出して false）。shellAvailable の例外も false
   */
  private sandboxForRun(): boolean {
    if (this.cfg.shell !== true) return false;
    let available: boolean;
    try {
      available = this.cfg.shellAvailable?.() ?? false;
    } catch {
      available = false;
    }
    if (!available) return false;
    try {
      ensureSandboxWriteDirs(this.cfg.workDir);
      return true;
    } catch {
      this.log("sandbox の書き込み先を作れなかったため、この run ではコマンドを使いません");
      return false;
    }
  }

  /** steps を渡したら（dev モード）、受け取ったメッセージから起きた順に手順を足す */
  private async runQuery(
    input: RunInput,
    abortController: AbortController,
    maxTurns: number,
    steps: DevLogStep[] | undefined,
  ): Promise<RunResult> {
    const shell = this.cfg.shell === true;
    // sandbox は自己診断が通っていて bwrap・socat がある run だけに付ける（付けると failIfUnavailable で #inbox まで失敗しうるため）
    const sandbox = this.sandboxForRun();
    const base = buildQueryOptions(this.cfg, this.createMcpServer(input.context), sandbox);
    // ツール呼び出しの回数はターンごとに数え、WebFetch に許す URL（貼った URL とその転送先）とファイル操作を許す場所もターンごとに違うので、
    // hooks は run ごとに作って足す。ファイル操作と Bash の hook はどの run にも必ず入れる
    const tools = createToolCallRecorder(this.log);
    const webFetch = createWebFetchGuard(input.allowedUrls ?? [], this.log);
    const hooks: NonNullable<Options["hooks"]> = {
      PreToolUse: [
        webFetch.preToolUse,
        createFileGuard(input.context, this.files, this.log, shell),
        createBashGuard(input.context, { ...this.files, enabled: sandbox }, this.log),
      ],
      ...tools.hooks,
      PostToolUse: [...(tools.hooks.PostToolUse ?? []), webFetch.postToolUse],
    };
    // 子プロセスの stderr は末尾だけ保持し、例外で終わったときに errorMessage に添える（中身を log に直接は出さない）。
    // シェルが有効なら末尾は添えず、大きさだけにする（errorMessage は handler が log に出す。shell.md §2.8）
    let stderr = "";
    const onStderr = (data: string): void => {
      stderr = (stderr + data).slice(-STDERR_KEEP_LENGTH);
    };
    const options: Options =
      input.sessionId === undefined
        ? { ...base, maxTurns, abortController, hooks, stderr: onStderr }
        : { ...base, maxTurns, abortController, hooks, stderr: onStderr, resume: input.sessionId };
    // メインループのステップ（message.id）ごとの入力側の usage。同じ message.id は content のブロックごとに 1 回ずつ届くが、
    // 入力側（input・cache read・cache creation・1 時間の分）は message_start の時点で確定しているので、どれから取っても同じ値になる。最初に届いたものを使う。
    // 途中の assistant メッセージの output は確定していないので使わず、出力の合計は result メッセージの usage から取る（成功したターンだけ）。
    // 終わりに合計と内訳（toTurnUsage）にし、失敗でも 1 ステップでもあれば返す
    const stepUsages = new Map<string, StepUsage>();
    const failedUsage = (): { usage?: TurnUsage } =>
      stepUsages.size === 0 ? {} : { usage: toTurnUsage([...stepUsages.values()]) };
    let sessionId = input.sessionId;
    let result: SDKResultMessage | undefined;
    // API が画像（か大きすぎるリクエスト）を受け付けなかった。エラーの文は log にも結果にも入れず、印だけ返す
    let imageRejected = false;
    const rejected = (): { imageRejected?: true } => (imageRejected ? { imageRejected: true } : {});
    let compacted: Compaction | undefined;
    // 途中経過は tool_use ごとに 1 回（同じ tool_use の id は 1 回だけ）
    const seenToolUseIds = new Set<string>();
    // 中断（[中断]）と打ち切りは同じ abortController で止まるので、input.signal で見分ける。
    // 途中で受け取った session_id は返す（turn.ts が、まだ SDK セッションの無いチャンネルでだけ残す）
    const stopped = (): RunResult => ({
      ok: false,
      errorMessage: input.signal?.aborted === true ? "aborted" : "timeout",
      sessionId,
      sessionRecorded: false,
      toolCalls: tools.count(),
      ...failedUsage(),
    });

    try {
      for await (const message of this.queryFn({ prompt: queryPrompt(input), options })) {
        if ("session_id" in message && typeof message.session_id === "string") {
          sessionId = message.session_id;
        }
        steps?.push(...devLogSteps(message));
        if (
          message.type === "assistant" &&
          message.parent_tool_use_id === null &&
          !stepUsages.has(message.message.id)
        ) {
          const stepUsage = message.message.usage;
          stepUsages.set(message.message.id, {
            inputTokens: stepUsage.input_tokens,
            cacheReadInputTokens: stepUsage.cache_read_input_tokens ?? 0,
            cacheCreationInputTokens: stepUsage.cache_creation_input_tokens ?? 0,
            cacheCreation1hInputTokens: stepUsage.cache_creation?.ephemeral_1h_input_tokens ?? 0,
          });
        }
        // assistant メッセージは並列ツール呼び出しでも 1 ブロックずつ届くので、message.id ではなく tool_use の id で重複を除く
        if (message.type === "assistant" && message.parent_tool_use_id === null && input.onProgress !== undefined) {
          for (const block of message.message.content ?? []) {
            if (block.type !== "tool_use" || seenToolUseIds.has(block.id)) continue;
            seenToolUseIds.add(block.id);
            // プロジェクトはターンの途中で project_open で作られうるので、そのたびに引く
            const project =
              input.context === undefined ? undefined : this.files.projects.getByChannel(input.context.channelId);
            const projectDir = project === undefined ? undefined : join(this.files.projectsDir, project.slug);
            input.onProgress({ label: progressLabel(block.name, block.input, this.cfg.workDir, projectDir) });
          }
        }
        // 会話が長くなり SDK が古い部分を要約した。1 ターンに複数回あれば最後のもの
        if (message.type === "system" && message.subtype === "compact_boundary") {
          const metadata = message.compact_metadata;
          compacted = {
            trigger: metadata.trigger,
            ...(typeof metadata.pre_tokens === "number" ? { preTokens: metadata.pre_tokens } : {}),
          };
        }
        // API エラーの assistant メッセージ（CLI が作るもの）の本文
        if (message.type === "assistant" && message.parent_tool_use_id === null && message.error !== undefined) {
          for (const block of message.message.content ?? []) {
            if (block.type === "text" && isImageRejection(block.text)) imageRejected = true;
          }
        }
        if (message.type === "result") {
          result = message;
          const errorTexts = message.subtype === "success" ? (message.is_error ? [message.result] : []) : message.errors;
          if (errorTexts.some(isImageRejection)) imageRejected = true;
        }
      }
    } catch (error) {
      if (abortController.signal.aborted) return stopped();
      const text = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
      if (isImageRejection(text) || isImageRejection(stderr)) imageRejected = true;
      const tail = shell ? stderrSummary(stderr) : stderrTail(stderr);
      const note = tail === "" ? "" : shell ? `（${tail}）` : `（stderr: ${tail}）`;
      return {
        ok: false,
        errorMessage: `exception: ${shorten(text)}${note}`,
        sessionId,
        sessionRecorded: false,
        toolCalls: tools.count(),
        ...failedUsage(),
        ...rejected(),
      };
    }

    if (abortController.signal.aborted) return stopped();
    if (result === undefined) {
      return {
        ok: false,
        errorMessage: "result メッセージを受け取れませんでした",
        sessionId,
        sessionRecorded: false,
        toolCalls: tools.count(),
        ...failedUsage(),
        ...rejected(),
      };
    }
    if (result.subtype !== "success" || result.is_error) {
      // result まで届いたので SDK は会話を記録している（error_max_turns なら途中のツール呼び出しも含む）
      return {
        ok: false,
        errorMessage: describeResultError(result),
        sessionId: result.session_id,
        sessionRecorded: true,
        toolCalls: tools.count(),
        ...failedUsage(),
        ...rejected(),
      };
    }
    // 出力の合計は result メッセージの usage（メインループだけ・このターンの分）。数でなければ入れない
    const outputTokens = result.usage?.output_tokens;
    const usage: TurnUsage = {
      ...toTurnUsage([...stepUsages.values()]),
      ...(typeof outputTokens === "number" ? { outputTokens } : {}),
    };
    // メインループの最後のステップの入力（合算しない）
    const last = usage.steps.at(-1);
    const contextTokens =
      last === undefined ? 0 : last.inputTokens + last.cacheReadInputTokens + last.cacheCreationInputTokens;
    return {
      ok: true,
      text: result.result,
      sessionId: result.session_id,
      usage,
      durationMs: result.duration_ms,
      ...(compacted === undefined ? {} : { compacted }),
      toolCalls: tools.count(),
      contextTokens,
    };
  }
}
