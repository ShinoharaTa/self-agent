import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createServer, request, type IncomingHttpHeaders, type Server } from "node:http";
import {
  CC_HOOK_BODY_LIMIT,
  CC_HOOK_TOKEN_LOG_INTERVAL_MS,
  CC_PROMPT_MIRROR_MAX_CHARS,
  createCcHookServer,
  createHookRequestListener,
  isHarnessPrompt,
  parseHookEvent,
  type CcHookEvent,
  type CcHookServer,
  summarizePermission,
  unwrapPastedContent,
} from "../src/cc/hook-server.ts";
import { CC_PROMPT_MAX_CHARS } from "../src/store/cc-sessions.ts";

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

async function setup(t: TestContext, opts: { ruleContext?: { workspaceDir?: string; home?: string } } = {}) {
  const received: CcHookEvent[] = [];
  const logs: string[] = [];
  const clock = { now: Date.parse("2026-11-01T00:00:00Z") };
  const receiver = { receive: (event: CcHookEvent) => received.push(event) };
  const server: CcHookServer = createCcHookServer({
    host: "127.0.0.1",
    port: 0,
    token: TOKEN,
    receiver,
    ...(opts.ruleContext === undefined ? {} : { ruleContext: opts.ruleContext }),
    now: () => new Date(clock.now),
    log: (line) => logs.push(line),
  });
  await server.start();
  t.after(() => server.close());
  const port = server.address()!.port;
  const post = (body: unknown, headers: Record<string, string> = { "X-Self-Agent-Hook": TOKEN, "Content-Type": "application/json" }) =>
    send(port, "/hook", { headers, body: typeof body === "string" ? body : JSON.stringify(body) });
  return { server, port, received, logs, post, receiver, clock };
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

test("hook の受け口: トークンが違う要求の log は 1 分に 1 回まで", async (t) => {
  const s = await setup(t);
  const body = { hook_event_name: "Stop", session_id: S1 };
  const wrong = { "X-Self-Agent-Hook": "wrong" };
  for (let i = 0; i < 3; i++) assert.equal((await s.post(body, wrong)).status, 403);
  assert.deepEqual(s.logs, ["Claude Code: hook のトークンが違います"]);
  s.clock.now += CC_HOOK_TOKEN_LOG_INTERVAL_MS - 1;
  await s.post(body, wrong);
  assert.equal(s.logs.length, 1);
  s.clock.now += 1;
  await s.post(body, wrong);
  assert.equal(s.logs.length, 2);
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
    // permission_suggestions が無ければ常に許可のルールは無い
    alwaysRules: null,
  });
  assert.ok(!JSON.stringify(event).includes("FULL-"));
});

test("summarizePermission: Bash は command、ファイルのツールは cwd からの相対パス、WebFetch は url、それ以外は JSON（どれも先頭 500 字）", () => {
  assert.equal(summarizePermission("Bash", { command: "npm test", description: "run" }, "/w").summary, "npm test");
  assert.equal(summarizePermission("Bash", { command: "a".repeat(600) }, "/w").summary, "a".repeat(500));
  assert.equal(summarizePermission("Edit", { file_path: "/w/app/src/x.ts", old_string: "o", new_string: "n" }, "/w/app").summary, "src/x.ts");
  assert.equal(summarizePermission("Read", { file_path: "/etc/hosts" }, "/w/app").summary, "/etc/hosts");
  // cwd が / なら相対にしない
  assert.equal(summarizePermission("Read", { file_path: "/etc/hosts" }, "/").summary, "/etc/hosts");
  assert.equal(summarizePermission("Edit", { file_path: "/w/app/x.ts" }, "/w/app/").summary, "x.ts");
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

test("summarizePermission: AskUserQuestion は形が通れば questionInput（tool_input の JSON そのまま）と「質問 n 問: …」の要約。読めない形・32 KB 超・ほかのツールは持たない", () => {
  const input = {
    questions: [
      { question: `${"長".repeat(150)}？`, header: "H", options: [{ label: "a", description: "" }, { label: "b", description: "" }], multiSelect: false },
      { question: "2 問目", header: "H2", options: [{ label: "x" }, { label: "y" }] },
    ],
  };
  const summary = summarizePermission("AskUserQuestion", input, "/w");
  assert.equal(summary.questionInput, JSON.stringify(input));
  assert.equal(summary.summary, `質問 2 問: ${"長".repeat(100)}`);
  assert.ok(!summary.summary.includes("{"));
  assert.equal(summary.requestHash, summarizePermission("AskUserQuestion", input, "/other").requestHash);
  // 読めない形（選択肢 1 つ）は今までどおり JSON の要約で、questionInput は無い
  const broken = summarizePermission("AskUserQuestion", { questions: [{ question: "q", options: [{ label: "a" }] }] }, "/w");
  assert.equal(broken.questionInput, undefined);
  assert.ok(broken.summary.startsWith('{"questions"'));
  // 32 KB を超える JSON は持たない
  const big = {
    questions: [{ question: "q", options: [{ label: "a", description: "d".repeat(1000) }, { label: "b", description: "" }] }],
    padding: "p".repeat(33 * 1024),
  };
  assert.equal(summarizePermission("AskUserQuestion", big, "/w").questionInput, undefined);
  // ほかのツールは同じ形でも持たない
  assert.equal(summarizePermission("mcp__x__y", input, "/w").questionInput, undefined);
});

test("unwrapPastedContent: pasted_content の開きと閉じのタグ（属性付き）を外して中身だけにする", () => {
  assert.equal(unwrapPastedContent('<pasted_content id="abc">本文\n2 行目</pasted_content id="abc">'), "本文\n2 行目");
  assert.equal(unwrapPastedContent('前 <pasted_content id="1" lines="2">a</pasted_content> 後 <pasted_content id="2">b</pasted_content>'), "前 a 後 b");
  assert.equal(unwrapPastedContent("<pasted_contents>そのまま</other>"), "<pasted_contents>そのまま</other>");
  assert.equal(unwrapPastedContent("タグなし"), "タグなし");
});

test("isHarnessPrompt: 全体が 1 つの XML 風の要素か SYSTEM NOTIFICATION などで始まるものは harness のプロンプト。人の指示は違う", () => {
  assert.equal(isHarnessPrompt("<task-notification>\n<task-id>abc</task-id>\n<status>completed</status>\n</task-notification>"), true);
  assert.equal(isHarnessPrompt("<system-reminder>\n注意\n</system-reminder>"), true);
  assert.equal(isHarnessPrompt('<cross-session-message from="x">本文</cross-session-message>'), true);
  assert.equal(isHarnessPrompt("[SYSTEM NOTIFICATION - NOT USER INPUT]\nThis is an automated event"), true);
  assert.equal(isHarnessPrompt("[Subagent hand-back] The text below is the final report"), true);
  assert.equal(isHarnessPrompt("Another Claude session sent a message:\n<agent-message>…</agent-message>"), true);
  // 人の指示
  assert.equal(isHarnessPrompt("次に進めて"), false);
  assert.equal(isHarnessPrompt("<task-notification> の形で返して"), false);
  assert.equal(isHarnessPrompt("この <b>太字</b> を直して"), false);
  assert.equal(isHarnessPrompt("<a>x</a> と <b>y</b>"), false);
  assert.equal(isHarnessPrompt(""), false);
  assert.equal(isHarnessPrompt("   "), false);
});

test("parseHookEvent: harness のプロンプトは prompt・promptChars を付けず harnessPrompt を立てる（写さない・本文を残さない）", () => {
  const at = new Date(0);
  const event = parseHookEvent(
    { hook_event_name: "UserPromptSubmit", session_id: S1, prompt: "\n<task-notification>\n<task-id>abc</task-id>\n</task-notification>\n" },
    at,
  );
  assert.equal(event?.event, "UserPromptSubmit");
  assert.equal(event?.harnessPrompt, true);
  assert.equal(event?.prompt, undefined);
  assert.equal(event?.promptChars, undefined);
  const human = parseHookEvent({ hook_event_name: "UserPromptSubmit", session_id: S1, prompt: "次に進めて" }, at);
  assert.equal(human?.harnessPrompt, undefined);
  assert.equal(human?.prompt, "次に進めて");
});

test("parseHookEvent: まとめた貼り付けの prompt はタグを外して前後の改行・空白を除いてから先頭 1,000 字を事象に（全体の字数も）", () => {
  const at = new Date(0);
  const parse = (text: string) => parseHookEvent({ hook_event_name: "UserPromptSubmit", session_id: S1, prompt: text }, at);
  const prompt = (text: string) => parse(text)?.prompt;
  // Claude Code の形（\n\n<pasted_content …>…</pasted_content>\n）
  assert.equal(prompt('\n\n<pasted_content id="1">1 行目\n2 行目</pasted_content id="1">\n'), "1 行目\n2 行目");
  assert.equal(prompt("  前後の空白  "), "前後の空白");
  assert.equal(CC_PROMPT_MIRROR_MAX_CHARS, 1000);
  const long = parse(`\n\n\n${"字".repeat(CC_PROMPT_MIRROR_MAX_CHARS + 10)}`);
  assert.equal(long?.prompt, "字".repeat(CC_PROMPT_MIRROR_MAX_CHARS));
  assert.equal(long?.promptChars, CC_PROMPT_MIRROR_MAX_CHARS + 10);
  // DB に残すのは 200 字のまま（cc-sessions.ts の applyEvent が切る。test/cc-registry.test.ts）
  assert.ok(CC_PROMPT_MAX_CHARS < CC_PROMPT_MIRROR_MAX_CHARS);
});

test("hook の受け口: 常に許可のファイルのルールは options の ruleContext（workspace・ホーム）で線引きし、無ければ候補にしない", async (t) => {
  const body = {
    hook_event_name: "PermissionRequest",
    session_id: S1,
    cwd: "/home/owner/workspace/app",
    tool_name: "Edit",
    tool_input: { file_path: "/home/owner/workspace/app/src/x.ts" },
    permission_suggestions: [
      {
        type: "addRules",
        rules: [
          { toolName: "Edit", ruleContent: "src/**" },
          { toolName: "Edit", ruleContent: "~/workspace/**" },
        ],
        behavior: "allow",
        destination: "localSettings",
      },
    ],
  };
  const withContext = await setup(t, { ruleContext: { workspaceDir: "/home/owner/workspace", home: "/home/owner" } });
  await withContext.post(body);
  assert.deepEqual(withContext.received[0]!.permission?.alwaysRules, [{ toolName: "Edit", ruleContent: "src/**" }]);
  const without = await setup(t);
  await without.post(body);
  assert.equal(without.received[0]!.permission?.alwaysRules, null);
});
