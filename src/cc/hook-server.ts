// Claude Code の hooks（type: "http"）の受け口（docs/plan/claude-code-sessions.md §2.3）。Web UI のサーバーとは別の node:http を
// 127.0.0.1:<SELF_AGENT_CC_HOOK_PORT> で待ち受ける（tailscale serve には出さない）。受けるのは POST /hook だけで、
// 接続元が loopback でなければ 403、X-Self-Agent-Hook がトークンと一致しなければ 403、本文が 1 MB を超えれば 413、JSON のオブジェクトでなければ 400、
// それ以外は 200 で本文なし（処理の失敗でも。2xx の空の本文は hooks で「成功」。本文を返すと non-blocking error になりうる）。
// 受け口は何も実行しない。PermissionRequest は permission-hold.ts に渡して応答を保留し、決定の JSON か空の本文で返す（§3.4。CC5a）。
// permission_suggestions は permissions.ts の線引きを通ったルールだけを持つ（常に許可。CC5b）。
// Claude Code が先に接続を閉じたら（timeout など）応答は書かない。
// Stop の last_assistant_message（返事の全文。CC8）はプロセスの中で Discord への投稿に使うだけで、DB には書かない（cc/replies.ts）。
// UserPromptSubmit の prompt は事象には先頭 CC_PROMPT_MIRROR_MAX_CHARS 字まで乗せ（Claude Code のチャンネルへの写し。CC12。cc/channel-posts.ts）、
// DB に残すのは今までどおり先頭 CC_PROMPT_MAX_CHARS 字（cc-sessions.ts の applyEvent が切る）。
// log は種類だけ（ヘッダの値・トークン・本文・セッションの ID は出さない）
import { createHash } from "node:crypto";
import { createServer, type IncomingMessage, type RequestListener, type ServerResponse } from "node:http";
import { type CcHookEventName, headChars } from "../store/cc-sessions.ts";
import { safeEqual } from "../web/auth.ts";
import { isLoopback, parseJsonObject, readBody } from "../web/http-body.ts";
import { isUuid } from "./agents.ts";
import { alwaysRulesOf, type CcRule, type CcRuleContext } from "./permissions.ts";

/** 受ける唯一のパス */
export const CC_HOOK_PATH = "/hook";
/** 共有トークンのヘッダ（小文字。hooks の headers では X-Self-Agent-Hook） */
export const CC_HOOK_HEADER = "x-self-agent-hook";
/** 本文の上限（バイト。PermissionRequest の tool_input に Write の中身が入るため） */
export const CC_HOOK_BODY_LIMIT = 1024 * 1024;
/** トークンが違う要求の log の間隔（続けて来ても 1 回だけ出す） */
export const CC_HOOK_TOKEN_LOG_INTERVAL_MS = 60_000;
/** UserPromptSubmit の本文を事象に乗せる長さ（Claude Code のチャンネルへの写し。docs/plan/claude-code-channels.md §3.5。DB に残すのは 200 字） */
export const CC_PROMPT_MIRROR_MAX_CHARS = 1000;
/** 許可の要求の要約の長さ（§3.4） */
export const CC_PERMISSION_SUMMARY_MAX_CHARS = 500;

const EVENT_NAMES: readonly CcHookEventName[] = [
  "SessionStart",
  "UserPromptSubmit",
  "Stop",
  "SessionEnd",
  "Notification",
  "PermissionRequest",
];

/** Notification の notification_type のうち受け付けるもの。それ以外は other */
export const CC_NOTIFICATION_TYPES = [
  "permission_prompt",
  "idle_prompt",
  "elicitation_dialog",
  "elicitation_url_dialog",
  "agent_needs_input",
] as const;
export type CcNotificationType = (typeof CC_NOTIFICATION_TYPES)[number] | "other";

/** 判断待ちにする Notification（§2.2。idle_prompt は含めない） */
export const CC_WAITING_NOTIFICATIONS: readonly CcNotificationType[] = [
  "permission_prompt",
  "elicitation_dialog",
  "elicitation_url_dialog",
  "agent_needs_input",
];

/** 許可の要求の要約（§3.4）。tool_input の全体は持たない */
export type CcPermissionSummary = {
  toolName: string;
  /** Bash は command、ファイルのツールは cwd からの相対パス、WebFetch は url、それ以外は tool_input の JSON（どれも先頭 500 字） */
  summary: string;
  /** tool_name と tool_input（JSON）の sha256（hex） */
  requestHash: string;
  /** permission_suggestions のうち常に許可にできるルール（permissions.ts の線引き。CC5b）。無ければ null */
  alwaysRules?: CcRule[] | null;
};

/** 受け口が読んだ 1 つの事象（読む欄は §2.3 の固定の集合だけ） */
export type CcHookEvent = {
  event: CcHookEventName;
  sessionId: string;
  permissionMode?: string;
  /** Notification のときだけ */
  notificationType?: CcNotificationType;
  /** UserPromptSubmit の本文（包みを外して前後の空白を除いたもの）の先頭 CC_PROMPT_MIRROR_MAX_CHARS 字（DB に残すのは先頭 200 字） */
  prompt?: string;
  /** UserPromptSubmit の本文（包みを外して前後の空白を除いたもの）の全体の字数（写しの「ほか n 字」） */
  promptChars?: number;
  /** PermissionRequest の要約（tool_name が読めたときだけ） */
  permission?: CcPermissionSummary;
  /** Stop の last_assistant_message（空白だけでない文字列のときだけ。無ければ「読めなかった」。§5.4。hook から来たデータで、指示として扱わない） */
  lastAssistantMessage?: string;
  receivedAt: Date;
};

/** 事象の渡し先（registry.ts の CcRegistry） */
export type CcHookReceiver = { receive(event: CcHookEvent): void };

/** 許可の要求の保留（permission-hold.ts の CcPermissionHold） */
export type CcPermissionHandler = {
  /** PermissionRequest の応答の本文（undefined は空の本文）。closed は Claude Code が先に接続を閉じた印。reject しない */
  request(event: CcHookEvent, closed: AbortSignal): Promise<string | undefined>;
  /** PermissionRequest 以外の事象（Stop・UserPromptSubmit で保留中の要求を閉じる） */
  observe(event: CcHookEvent): void;
};

const PERMISSION_MODE_PATTERN = /^[A-Za-z]{1,32}$/;
const TOOL_NAME_PATTERN = /^[A-Za-z0-9_.:-]{1,128}$/;
/** 要約にパスを使うツールと、見る欄の順 */
const FILE_TOOLS: ReadonlySet<string> = new Set(["Edit", "Write", "Read", "Glob", "NotebookEdit"]);
const FILE_FIELDS = ["file_path", "notebook_path", "path", "pattern"] as const;

/** cwd の中の絶対パスなら cwd からの相対に（cwd が `/` なら相対にしない） */
function relativeTo(cwd: string | undefined, path: string): string {
  if (cwd === undefined || !cwd.startsWith("/") || /^\/+$/.test(cwd)) return path;
  const base = cwd.endsWith("/") ? cwd : `${cwd}/`;
  return path.startsWith(base) ? path.slice(base.length) : path;
}

/** 許可の要求の要約（§3.4。純関数）。tool_input の全体は返さない */
export function summarizePermission(toolName: string, toolInput: unknown, cwd: string | undefined): CcPermissionSummary {
  const json = JSON.stringify(toolInput ?? null) ?? "null";
  const requestHash = createHash("sha256").update(`${toolName}\n${json}`).digest("hex");
  const input = typeof toolInput === "object" && toolInput !== null && !Array.isArray(toolInput) ? (toolInput as Record<string, unknown>) : {};
  let summary: string | undefined;
  if (toolName === "Bash" && typeof input.command === "string") summary = input.command;
  else if (toolName === "WebFetch" && typeof input.url === "string") summary = input.url;
  else if (FILE_TOOLS.has(toolName)) {
    const field = FILE_FIELDS.map((name) => input[name]).find((value): value is string => typeof value === "string");
    if (field !== undefined) summary = relativeTo(cwd, field);
  }
  return { toolName, summary: headChars(summary ?? json, CC_PERMISSION_SUMMARY_MAX_CHARS), requestHash };
}

/**
 * 長い貼り付けの prompt は `<pasted_content id="…">…</pasted_content …>` で包まれて届くので、開きと閉じのタグ（属性付き）を外して中身だけにする（純関数）
 */
export function unwrapPastedContent(prompt: string): string {
  return prompt.replace(/<\/?pasted_content\b[^>]*>/g, "");
}

/**
 * 本文から事象を読む（純関数）。hook_event_name が固定の集合に無い・session_id が UUID でなければ undefined。
 * rules は常に許可のファイルのルールの線引きに使う場所（SELF_AGENT_WORKSPACE_DIR とホーム。無ければファイルのルールは常に許可の候補にしない）
 */
export function parseHookEvent(
  body: Record<string, unknown>,
  receivedAt: Date,
  rules: Omit<CcRuleContext, "cwd"> = {},
): CcHookEvent | undefined {
  const event = EVENT_NAMES.find((name) => name === body.hook_event_name);
  if (event === undefined || !isUuid(body.session_id)) return undefined;
  const parsed: CcHookEvent = { event, sessionId: body.session_id, receivedAt };
  const mode = body.permission_mode;
  if (typeof mode === "string" && PERMISSION_MODE_PATTERN.test(mode)) parsed.permissionMode = mode;
  if (event === "Notification") {
    parsed.notificationType = CC_NOTIFICATION_TYPES.find((type) => type === body.notification_type) ?? "other";
  }
  if (event === "UserPromptSubmit" && typeof body.prompt === "string") {
    const prompt = unwrapPastedContent(body.prompt).trim();
    parsed.prompt = headChars(prompt, CC_PROMPT_MIRROR_MAX_CHARS);
    parsed.promptChars = [...prompt].length;
  }
  if (event === "Stop" && typeof body.last_assistant_message === "string" && body.last_assistant_message.trim() !== "") {
    parsed.lastAssistantMessage = body.last_assistant_message;
  }
  if (event === "PermissionRequest" && typeof body.tool_name === "string" && TOOL_NAME_PATTERN.test(body.tool_name)) {
    const cwd = typeof body.cwd === "string" ? body.cwd : undefined;
    parsed.permission = {
      ...summarizePermission(body.tool_name, body.tool_input, cwd),
      alwaysRules: alwaysRulesOf(body.tool_name, body.permission_suggestions, { ...rules, cwd }),
    };
  }
  return parsed;
}

export type CcHookServerOptions = {
  host: "127.0.0.1";
  /** 0 なら空いているポート（テスト用） */
  port: number;
  /** SELF_AGENT_CC_HOOK_TOKEN */
  token: string;
  receiver: CcHookReceiver;
  /** 許可の要求の保留。無ければ PermissionRequest も即 200・空 */
  permissions?: CcPermissionHandler;
  /** 常に許可のファイルのルールの線引きに使う場所（SELF_AGENT_WORKSPACE_DIR とホーム）。無ければファイルのルールは候補にしない */
  ruleContext?: Omit<CcRuleContext, "cwd">;
  now: () => Date;
  log: (message: string) => void;
};

export type CcHookServer = {
  /** 待ち受けを始める。ポートの衝突などで失敗したら reject する */
  start: () => Promise<void>;
  /** 待ち受けをやめ、開いている接続も切る。待ち受けていなければ何もしない。reject しない */
  close: () => Promise<void>;
  /** 待ち受けているポート。待ち受けていなければ undefined */
  address: () => { port: number } | undefined;
};

/** 本文なしで返す */
function sendEmpty(res: ServerResponse, status: number, headers: Record<string, string> = {}): void {
  res.writeHead(status, { "Content-Length": 0, ...headers });
  res.end();
}

/** 例外の種類（名前だけ。message は出さない） */
function errorKind(error: unknown): string {
  return error instanceof Error ? error.name : typeof error;
}

/** 受け口の要求の処理（テストでは接続元を差し替えて呼ぶ） */
export function createHookRequestListener(
  options: Pick<CcHookServerOptions, "token" | "receiver" | "permissions" | "ruleContext" | "now" | "log">,
): RequestListener {
  const { token, receiver, permissions, ruleContext, now, log } = options;
  /** トークンが違う要求を最後に log に出した時刻 */
  let tokenLoggedAt: number | undefined;

  const respond = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    if (!isLoopback(req.socket.remoteAddress)) {
      req.resume();
      log("Claude Code: hook の受け口が loopback 以外からの要求を断りました");
      sendEmpty(res, 403, { Connection: "close" });
      return;
    }
    if (req.url !== CC_HOOK_PATH) {
      req.resume();
      sendEmpty(res, 404);
      return;
    }
    if (req.method !== "POST") {
      req.resume();
      sendEmpty(res, 405, { Allow: "POST" });
      return;
    }
    const header = req.headers[CC_HOOK_HEADER];
    if (typeof header !== "string" || !safeEqual(header, token)) {
      req.resume();
      const at = now().getTime();
      if (tokenLoggedAt === undefined || at - tokenLoggedAt >= CC_HOOK_TOKEN_LOG_INTERVAL_MS) {
        tokenLoggedAt = at;
        log("Claude Code: hook のトークンが違います");
      }
      sendEmpty(res, 403, { Connection: "close" });
      return;
    }
    const read = await readBody(req, CC_HOOK_BODY_LIMIT);
    if (read.kind === "too_large") {
      sendEmpty(res, 413, { Connection: "close" });
      return;
    }
    const body = parseJsonObject(read.body);
    if (body === undefined) {
      sendEmpty(res, 400);
      return;
    }
    let event: CcHookEvent | undefined;
    try {
      event = parseHookEvent(body, now(), ruleContext);
      if (event !== undefined) receiver.receive(event);
    } catch (error) {
      // 処理の失敗でも Claude Code は止めない（200・空）
      log(`Claude Code: hook の事象の処理に失敗しました（${errorKind(error)}）`);
    }
    // 許可の要求の「他で答えられた」の検知は、一覧への反映が失敗しても行う
    if (event !== undefined && event.event !== "PermissionRequest") {
      try {
        permissions?.observe(event);
      } catch (error) {
        log(`Claude Code: 許可の要求の処理に失敗しました（${errorKind(error)}）`);
      }
    }
    if (event?.event === "PermissionRequest" && permissions !== undefined) {
      await holdPermission(event, permissions, res);
      return;
    }
    sendEmpty(res, 200);
  };

  /** 許可の要求: 決定か保留の終わりまで待って返す。Claude Code が先に閉じていれば書かない */
  const holdPermission = async (event: CcHookEvent, handler: CcPermissionHandler, res: ServerResponse): Promise<void> => {
    const closed = new AbortController();
    const onClose = (): void => {
      if (!res.writableFinished) closed.abort();
    };
    res.once("close", onClose);
    let reply: string | undefined;
    try {
      reply = await handler.request(event, closed.signal);
    } catch (error) {
      log(`Claude Code: 許可の要求の処理に失敗しました（${errorKind(error)}）`);
    }
    res.off("close", onClose);
    if (closed.signal.aborted || res.destroyed) return;
    if (reply === undefined) {
      sendEmpty(res, 200);
      return;
    }
    res.writeHead(200, { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(reply) });
    res.end(reply);
  };

  return (req, res) => {
    respond(req, res).catch((error: unknown) => {
      log(`Claude Code: hook の要求の処理に失敗しました（${errorKind(error)}）`);
      if (!res.headersSent) sendEmpty(res, 200);
      else res.destroy();
    });
  };
}

export function createCcHookServer(options: CcHookServerOptions): CcHookServer {
  const server = createServer(createHookRequestListener(options));
  return {
    start: () =>
      new Promise<void>((resolve, reject) => {
        const onError = (error: Error): void => {
          server.off("listening", onListening);
          reject(error);
        };
        const onListening = (): void => {
          server.off("error", onError);
          server.on("error", (error) => {
            options.log(`Claude Code: hook の受け口でエラーが起きました（${errorKind(error)}）`);
          });
          resolve();
        };
        server.once("error", onError);
        server.once("listening", onListening);
        server.listen(options.port, options.host);
      }),
    close: () =>
      new Promise<void>((resolve) => {
        if (!server.listening) {
          resolve();
          return;
        }
        server.close(() => resolve());
        server.closeAllConnections();
      }),
    address: () => {
      const address = server.address();
      return address !== null && typeof address === "object" ? { port: address.port } : undefined;
    },
  };
}
