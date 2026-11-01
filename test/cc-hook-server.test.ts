import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createServer, request, type IncomingHttpHeaders, type Server } from "node:http";
import {
  CC_HOOK_BODY_LIMIT,
  createCcHookServer,
  createHookRequestListener,
  type CcHookEvent,
  type CcHookServer,
  summarizePermission,
} from "../src/cc/hook-server.ts";

const TOKEN = "hook-token-for-tests-0123456789abcdef";
const S1 = "11111111-1111-4111-8111-111111111111";

type Response = { status: number; headers: IncomingHttpHeaders; body: string };

function send(
  port: number,
  path: string,
  options: { method?: string; headers?: Record<string, string>; body?: string | Buffer } = {},
): Promise<Response> {
  return new Promise((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port, path, method: options.method ?? "POST", headers: options.headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (chunk: Buffer) => chunks.push(chunk));
      res.on("end", () => resolve({ status: res.statusCode!, headers: res.headers, body: Buffer.concat(chunks).toString("utf8") }));
      res.on("error", reject);
    });
    req.on("error", reject);
    req.end(options.body);
  });
}

async function setup(t: TestContext) {
  const received: CcHookEvent[] = [];
  const logs: string[] = [];
  const receiver = { receive: (event: CcHookEvent) => received.push(event) };
  const server: CcHookServer = createCcHookServer({
    host: "127.0.0.1",
    port: 0,
    token: TOKEN,
    receiver,
    now: () => new Date("2026-11-01T00:00:00Z"),
    log: (line) => logs.push(line),
  });
  await server.start();
  t.after(() => server.close());
  const port = server.address()!.port;
  const post = (body: unknown, headers: Record<string, string> = { "X-Self-Agent-Hook": TOKEN, "Content-Type": "application/json" }) =>
    send(port, "/hook", { headers, body: typeof body === "string" ? body : JSON.stringify(body) });
  return { server, port, received, logs, post, receiver };
}

test("hook の受け口: 正しい要求は 200 で本文なし（Content-Length 0）。事象を渡す", async (t) => {
  const s = await setup(t);
  const response = await s.post({ hook_event_name: "UserPromptSubmit", session_id: S1, prompt: "hello", cwd: "/w" });
  assert.equal(response.status, 200);
  assert.equal(response.body, "");
  assert.equal(response.headers["content-length"], "0");
  assert.equal(s.received.length, 1);
  assert.equal(s.received[0]!.event, "UserPromptSubmit");
  assert.equal(s.received[0]!.prompt, "hello");
  // 知らない事象・UUID でない session_id も 200・空（渡さない）
  for (const body of [
    { hook_event_name: "PreToolUse", session_id: S1 },
    { hook_event_name: "Stop", session_id: "x" },
  ]) {
    const other = await s.post(body);
    assert.equal(other.status, 200);
    assert.equal(other.body, "");
  }
  assert.equal(s.received.length, 1);
});

test("hook の受け口: トークンが違う（長さ違い・同じ長さ・無い）なら 403 で記録しない。log にトークンを出さない", async (t) => {
  const s = await setup(t);
  const body = { hook_event_name: "Stop", session_id: S1 };
  const wrongSameLength = `${TOKEN.slice(0, -1)}x`;
  for (const headers of [
    { "X-Self-Agent-Hook": "short" },
    { "X-Self-Agent-Hook": wrongSameLength },
    { "X-Self-Agent-Hook": `${TOKEN}x` },
    {} as Record<string, string>,
  ]) {
    const response = await s.post(body, headers);
    assert.equal(response.status, 403, JSON.stringify(headers));
    assert.equal(response.body, "");
  }
  assert.equal(s.received.length, 0);
  assert.ok(s.logs.length > 0);
  assert.ok(!s.logs.join("\n").includes(TOKEN.slice(0, 10)));
  assert.ok(!s.logs.join("\n").includes("short"));
});

test("hook の受け口: 本文が 1 MB を超えれば 413（Content-Length で分かっても、chunked でも）、JSON のオブジェクトでなければ 400。どちらも記録しない", async (t) => {
  const s = await setup(t);
  const big = JSON.stringify({ hook_event_name: "PermissionRequest", session_id: S1, tool_name: "Write", tool_input: { content: "x".repeat(CC_HOOK_BODY_LIMIT) } });
  const tooLarge = await s.post(big);
  assert.equal(tooLarge.status, 413);
  assert.equal(tooLarge.body, "");
  // chunked（Content-Length なし）
  const chunked = await new Promise<number>((resolve, reject) => {
    const req = request(
      { host: "127.0.0.1", port: s.port, path: "/hook", method: "POST", headers: { "X-Self-Agent-Hook": TOKEN, "Transfer-Encoding": "chunked" } },
      (res) => {
        res.resume();
        resolve(res.statusCode!);
      },
    );
    req.on("error", reject);
    for (let i = 0; i < 17; i++) req.write("y".repeat(64 * 1024));
    req.end();
  });
  assert.equal(chunked, 413);
  // ちょうど 1 MB までは受ける
  const filler = "z".repeat(CC_HOOK_BODY_LIMIT - JSON.stringify({ hook_event_name: "Stop", session_id: S1, pad: "" }).length);
  const exact = JSON.stringify({ hook_event_name: "Stop", session_id: S1, pad: filler });
  assert.equal(Buffer.byteLength(exact), CC_HOOK_BODY_LIMIT);
  assert.equal((await s.post(exact)).status, 200);
  for (const body of ["not json", "[1,2]", "null", "\"s\""]) {
    const response = await s.post(body);
    assert.equal(response.status, 400, body);
    assert.equal(response.body, "");
  }
  assert.equal(s.received.length, 1);
});

test("hook の受け口: POST /hook だけ。ほかのパスは 404、ほかのメソッドは 405", async (t) => {
  const s = await setup(t);
  assert.equal((await send(s.port, "/", { headers: { "X-Self-Agent-Hook": TOKEN } })).status, 404);
  assert.equal((await send(s.port, "/hook?x=1", { headers: { "X-Self-Agent-Hook": TOKEN } })).status, 404);
  assert.equal((await send(s.port, "/api/status", { method: "GET" })).status, 404);
  const get = await send(s.port, "/hook", { method: "GET", headers: { "X-Self-Agent-Hook": TOKEN } });
  assert.equal(get.status, 405);
  assert.equal(get.body, "");
});

test("hook の受け口: 接続元が loopback でなければ 403 で記録しない", async (t) => {
  const received: CcHookEvent[] = [];
  const logs: string[] = [];
  const listener = createHookRequestListener({
    token: TOKEN,
    receiver: { receive: (event) => received.push(event) },
    now: () => new Date(),
    log: (line) => logs.push(line),
  });
  // 接続元を tailnet のアドレスに見せかける
  const server: Server = createServer((req, res) => {
    Object.defineProperty(req.socket, "remoteAddress", { value: "100.64.0.5", configurable: true });
    listener(req, res);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const address = server.address();
  const port = typeof address === "object" && address !== null ? address.port : 0;
  const response = await send(port, "/hook", {
    headers: { "X-Self-Agent-Hook": TOKEN },
    body: JSON.stringify({ hook_event_name: "Stop", session_id: S1 }),
  });
  assert.equal(response.status, 403);
  assert.equal(response.body, "");
  assert.equal(received.length, 0);
  assert.ok(!logs.join("\n").includes("100.64.0.5"));
});

test("hook の受け口: 処理（receiver）が投げても 200・空で返す", async (t) => {
  const logs: string[] = [];
  const server = createCcHookServer({
    host: "127.0.0.1",
    port: 0,
    token: TOKEN,
    receiver: {
      receive: () => {
        throw new Error(`secret ${S1}`);
      },
    },
    now: () => new Date(),
    log: (line) => logs.push(line),
  });
  await server.start();
  t.after(() => server.close());
  const response = await send(server.address()!.port, "/hook", {
    headers: { "X-Self-Agent-Hook": TOKEN },
    body: JSON.stringify({ hook_event_name: "Stop", session_id: S1 }),
  });
  assert.equal(response.status, 200);
  assert.equal(response.body, "");
  assert.deepEqual(logs, ["Claude Code: hook の事象の処理に失敗しました（Error）"]);
});

test("hook の受け口: PermissionRequest は保留せず即 200・空。要約は §3.4 の形で、tool_input の全体は渡さない", async (t) => {
  const s = await setup(t);
  const content = "FULL-".repeat(1000);
  const toolInput = { file_path: "/w/app/a.txt", content };
  const started = Date.now();
  const response = await s.post({ hook_event_name: "PermissionRequest", session_id: S1, cwd: "/w/app", tool_name: "Write", tool_input: toolInput });
  assert.ok(Date.now() - started < 2000);
  assert.equal(response.status, 200);
  assert.equal(response.body, "");
  const event = s.received[0]!;
  assert.deepEqual(event.permission, {
    toolName: "Write",
    summary: "a.txt",
    requestHash: createHash("sha256").update(`Write\n${JSON.stringify(toolInput)}`).digest("hex"),
  });
  assert.ok(!JSON.stringify(event).includes("FULL-"));
});

test("summarizePermission: Bash は command、ファイルのツールは cwd からの相対パス、WebFetch は url、それ以外は JSON（どれも先頭 500 字）", () => {
  assert.equal(summarizePermission("Bash", { command: "npm test", description: "run" }, "/w").summary, "npm test");
  assert.equal(summarizePermission("Bash", { command: "a".repeat(600) }, "/w").summary, "a".repeat(500));
  assert.equal(summarizePermission("Edit", { file_path: "/w/app/src/x.ts", old_string: "o", new_string: "n" }, "/w/app").summary, "src/x.ts");
  assert.equal(summarizePermission("Read", { file_path: "/etc/hosts" }, "/w/app").summary, "/etc/hosts");
  assert.equal(summarizePermission("NotebookEdit", { notebook_path: "/w/app/n.ipynb", new_source: "x" }, "/w/app").summary, "n.ipynb");
  assert.equal(summarizePermission("Glob", { pattern: "**/*.ts" }, "/w/app").summary, "**/*.ts");
  assert.equal(summarizePermission("WebFetch", { url: "https://example.com/a", prompt: "p" }, "/w").summary, "https://example.com/a");
  const mcp = summarizePermission("mcp__x__y", { q: "z".repeat(600) }, "/w").summary;
  assert.equal([...mcp].length, 500);
  assert.ok(mcp.startsWith('{"q":"zzz'));
  // 欄が無ければ JSON
  assert.equal(summarizePermission("Bash", { cmd: 1 }, "/w").summary, '{"cmd":1}');
  // 同じ内容は同じハッシュ、違えば違う
  const a = summarizePermission("Bash", { command: "ls" }, "/w").requestHash;
  assert.equal(summarizePermission("Bash", { command: "ls" }, "/other").requestHash, a);
  assert.notEqual(summarizePermission("Bash", { command: "ls -a" }, "/w").requestHash, a);
  assert.notEqual(summarizePermission("Read", { command: "ls" }, "/w").requestHash, a);
});
