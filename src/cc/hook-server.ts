// Claude Code の hooks（type: "http"）の受け口（docs/plan/claude-code-sessions.md §2.3）。Web UI のサーバーとは別の node:http を
// 127.0.0.1:<SELF_AGENT_CC_HOOK_PORT> で待ち受ける（tailscale serve には出さない）。受けるのは POST /hook だけで、
// 接続元が loopback でなければ 403、X-Self-Agent-Hook がトークンと一致しなければ 403、本文が 1 MB を超えれば 413、JSON のオブジェクトでなければ 400、
// それ以外は 200 で本文なし（処理の失敗でも。2xx の空の本文は hooks で「成功」。本文を返すと non-blocking error になりうる）。
// 受け口は何も実行しない。PermissionRequest は CC1 では保留せず、要約（§3.4）だけを渡して即 200・空で返す（保留は CC5a）。
// log は種類だけ（ヘッダの値・トークン・本文・セッションの ID は出さない）
import { createHash } from "node:crypto";
import { createServer, type IncomingMessage, type RequestListener, type ServerResponse } from "node:http";
import { CC_PROMPT_MAX_CHARS, type CcHookEventName, headChars } from "../store/cc-sessions.ts";
import { safeEqual } from "../web/auth.ts";
import { isLoopback, parseJsonObject, readBody } from "../web/http-body.ts";
import { isUuid } from "./agents.ts";

/** 受ける唯一のパス */
export const CC_HOOK_PATH = "/hook";
/** 共有トークンのヘッダ（小文字。hooks の headers では X-Self-Agent-Hook） */
export const CC_HOOK_HEADER = "x-self-agent-hook";
/** 本文の上限（バイト。PermissionRequest の tool_input に Write の中身が入るため） */
export const CC_HOOK_BODY_LIMIT = 1024 * 1024;
/** トークンが違う要求の log の間隔（続けて来ても 1 回だけ出す） */
export const CC_HOOK_TOKEN_LOG_INTERVAL_MS = 60_000;
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
};

/** 受け口が読んだ 1 つの事象（読む欄は §2.3 の固定の集合だけ） */
export type CcHookEvent = {
  event: CcHookEventName;
  sessionId: string;
  permissionMode?: string;
  /** Notification のときだけ */
  notificationType?: CcNotificationType;
  /** UserPromptSubmit の本文の先頭 CC_PROMPT_MAX_CHARS 字 */
  prompt?: string;
  /** PermissionRequest の要約（tool_name が読めたときだけ） */
  permission?: CcPermissionSummary;
  receivedAt: Date;
};

/** 事象の渡し先（registry.ts の CcRegistry） */
export type CcHookReceiver = { receive(event: CcHookEvent): void };

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

/** 本文から事象を読む（純関数）。hook_event_name が固定の集合に無い・session_id が UUID でなければ undefined */
export function parseHookEvent(body: Record<string, unknown>, receivedAt: Date): CcHookEvent | undefined {
  const event = EVENT_NAMES.find((name) => name === body.hook_event_name);
  if (event === undefined || !isUuid(body.session_id)) return undefined;
  const parsed: CcHookEvent = { event, sessionId: body.session_id, receivedAt };
  const mode = body.permission_mode;
  if (typeof mode === "string" && PERMISSION_MODE_PATTERN.test(mode)) parsed.permissionMode = mode;
  if (event === "Notification") {
    parsed.notificationType = CC_NOTIFICATION_TYPES.find((type) => type === body.notification_type) ?? "other";
  }
  if (event === "UserPromptSubmit" && typeof body.prompt === "string") {
    parsed.prompt = headChars(unwrapPastedContent(body.prompt), CC_PROMPT_MAX_CHARS);
  }
  if (event === "PermissionRequest" && typeof body.tool_name === "string" && TOOL_NAME_PATTERN.test(body.tool_name)) {
    const cwd = typeof body.cwd === "string" ? body.cwd : undefined;
    parsed.permission = summarizePermission(body.tool_name, body.tool_input, cwd);
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
export function createHookRequestListener(options: Pick<CcHookServerOptions, "token" | "receiver" | "now" | "log">): RequestListener {
  const { token, receiver, now, log } = options;
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
    try {
      const event = parseHookEvent(body, now());
      if (event !== undefined) receiver.receive(event);
    } catch (error) {
      // 処理の失敗でも Claude Code は止めない（200・空）
      log(`Claude Code: hook の事象の処理に失敗しました（${errorKind(error)}）`);
    }
    sendEmpty(res, 200);
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
