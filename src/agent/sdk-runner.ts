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
} from "@anthropic-ai/claude-agent-sdk";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import type { Config } from "../config.ts";
import { devLogResult, devLogToolInput, truncateText, type DevLogSink, type DevLogStep } from "../devlog/log.ts";
import type { ProjectStore } from "../store/projects.ts";
import { FILE_TOOLS, FILE_WRITE_TOOLS, judgeFileAccess, resolveRealPath } from "./file-access.ts";
import { normalizeUrl } from "./url.ts";
import { buildQueryOptions } from "./query-options.ts";
import type { AgentRunner, Compaction, RunContext, RunInput, RunResult, TurnUsage } from "./runner.ts";
import { MCP_SERVER_NAME } from "./tools.ts";

/** query() の形。テストでは偽のストリームを返す関数に差し替える */
export type QueryFn = (params: { prompt: string; options: Options }) => AsyncIterable<SDKMessage>;

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
 * 途中経過に出す 1 手順の文。ファイルの中身・コマンド・URL・検索語は出さない。
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
    case "Grep":
      return "ファイルを探しています";
    case "WebSearch":
      return "Web を検索しています";
    case "WebFetch":
      return "ページを読んでいます";
  }
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
};

/** ファイル操作の判定が例外で終わったときにモデルへ返す理由 */
export const FILE_GUARD_FAILED_REASON = "判定に失敗したため拒否しました";

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
 * ファイル操作（Read・Write・Edit・Glob・Grep）を judgeFileAccess で絞る PreToolUse の hook。context はこの run のチャンネル。
 * 拒否したら理由をモデルに返し、log にはツール名だけを出す（パスは出さない）。Write・Edit を許したらプロジェクトの更新日時を今にする。
 * CLI は hook の例外を「判断なし」として通してしまうので、判定（ストアの読み書きを含む）が例外で終わったら拒否する（パス・例外の中身は log に出さない）
 */
export function createFileGuard(
  context: RunContext | undefined,
  deps: FileGuardDeps,
  log: (message: string) => void,
): HookCallbackMatcher {
  const { projects, projectsDir } = deps;
  const guard: HookCallback = async (input) => {
    if (input.hook_event_name !== "PreToolUse" || !FILE_TOOLS.includes(input.tool_name)) return {};
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
        if (project !== undefined && FILE_WRITE_TOOLS.includes(input.tool_name)) projects.touch(project.id);
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
  return { matcher: FILE_TOOLS.join("|"), hooks: [guard] };
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

/** dev モードの会話ログの受け口と、開始時刻・所要時間に使う時計 */
export type DevLogDeps = { sink: DevLogSink; now: () => Date };

export class SdkAgentRunner implements AgentRunner {
  private readonly cfg: Pick<
    Config,
    "model" | "workDir" | "claudeConfigDir" | "turnTimeoutSec" | "effort" | "sessionMaxTurns" | "sessionTurnTimeoutSec"
  >;
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
    cfg: Pick<
      Config,
      "model" | "workDir" | "claudeConfigDir" | "turnTimeoutSec" | "effort" | "sessionMaxTurns" | "sessionTurnTimeoutSec"
    >,
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
        model: this.cfg.model,
        effort: this.cfg.effort ?? null,
        maxTurns,
        resume: input.sessionId ?? null,
        prompt: input.prompt,
        steps,
        result: devLogResult(result),
      });
    } catch {
      this.log("dev ログを書けませんでした");
    }
  }

  /** steps を渡したら（dev モード）、受け取ったメッセージから起きた順に手順を足す */
  private async runQuery(
    input: RunInput,
    abortController: AbortController,
    maxTurns: number,
    steps: DevLogStep[] | undefined,
  ): Promise<RunResult> {
    const base = buildQueryOptions(this.cfg, this.createMcpServer(input.context));
    // ツール呼び出しの回数はターンごとに数え、WebFetch に許す URL（貼った URL とその転送先）とファイル操作を許す場所もターンごとに違うので、
    // hooks は run ごとに作って足す。ファイル操作の hook はどの run にも必ず入れる
    const tools = createToolCallRecorder(this.log);
    const webFetch = createWebFetchGuard(input.allowedUrls ?? [], this.log);
    const hooks: NonNullable<Options["hooks"]> = {
      PreToolUse: [webFetch.preToolUse, createFileGuard(input.context, this.files, this.log)],
      ...tools.hooks,
      PostToolUse: [...(tools.hooks.PostToolUse ?? []), webFetch.postToolUse],
    };
    // 子プロセスの stderr は末尾だけ保持し、例外で終わったときに errorMessage に添える（中身を log に直接は出さない）
    let stderr = "";
    const onStderr = (data: string): void => {
      stderr = (stderr + data).slice(-STDERR_KEEP_LENGTH);
    };
    const options: Options =
      input.sessionId === undefined
        ? { ...base, maxTurns, abortController, hooks, stderr: onStderr }
        : { ...base, maxTurns, abortController, hooks, stderr: onStderr, resume: input.sessionId };
    // メインループの各ステップの usage を合算する。並列ツール呼び出しは同じ message.id を共有するので重複を除く
    const seenMessageIds = new Set<string>();
    const usage: TurnUsage = { inputTokens: 0, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 };
    // メインループの最後のステップの入力（合算しない）
    let contextTokens = 0;
    let sessionId = input.sessionId;
    let result: SDKResultMessage | undefined;
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
    });

    try {
      for await (const message of this.queryFn({ prompt: input.prompt, options })) {
        if ("session_id" in message && typeof message.session_id === "string") {
          sessionId = message.session_id;
        }
        steps?.push(...devLogSteps(message));
        if (
          message.type === "assistant" &&
          message.parent_tool_use_id === null &&
          !seenMessageIds.has(message.message.id)
        ) {
          seenMessageIds.add(message.message.id);
          const stepUsage = message.message.usage;
          usage.inputTokens += stepUsage.input_tokens;
          usage.cacheReadInputTokens += stepUsage.cache_read_input_tokens ?? 0;
          usage.cacheCreationInputTokens += stepUsage.cache_creation_input_tokens ?? 0;
          contextTokens =
            stepUsage.input_tokens + (stepUsage.cache_read_input_tokens ?? 0) + (stepUsage.cache_creation_input_tokens ?? 0);
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
        if (message.type === "result") {
          result = message;
        }
      }
    } catch (error) {
      if (abortController.signal.aborted) return stopped();
      const text = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
      const tail = stderrTail(stderr);
      return {
        ok: false,
        errorMessage: tail === "" ? `exception: ${shorten(text)}` : `exception: ${shorten(text)}（stderr: ${tail}）`,
        sessionId,
        sessionRecorded: false,
        toolCalls: tools.count(),
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
      };
    }
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
