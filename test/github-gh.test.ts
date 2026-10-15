import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  effectivePollIntervalSec,
  execFileRun,
  GH_MAX_BUFFER,
  GH_TIMEOUT_MS,
  GhClient,
  ghApiArgs,
  ghChildEnv,
  interpretGhResult,
  isAllowedGhPath,
  issuePath,
  lastModifiedFromHeaders,
  lastPageFromLink,
  notificationsPath,
  parseIncludeOutput,
  pollIntervalFromHeaders,
  rateLimitFromHeaders,
  resolveGhPath,
  retryAfterSecFromHeaders,
  timelinePath,
  type RunCommand,
  type RunResult,
} from "../src/github/gh.ts";

/** gh の --include の出力（ステータス行は \n、ヘッダと空行は \r\n。gh 2.100 で確かめた形） */
function include(statusLine: string, headers: readonly string[], body = ""): string {
  return `${statusLine}\n${headers.map((header) => `${header}\r\n`).join("")}\r\n${body}`;
}

function exited(code: number | null, stdout: string): RunResult {
  return { kind: "exited", code, stdout, stderr: "gh: 失敗の文" };
}

type Call = { file: string; args: readonly string[]; env: Record<string, string>; timeoutMs: number; maxBuffer: number };

function fakeRun(result: RunResult): { run: RunCommand; calls: Call[] } {
  const calls: Call[] = [];
  const run: RunCommand = async (file, args, options) => {
    calls.push({ file, args, ...options });
    return result;
  };
  return { run, calls };
}

test("isAllowedGhPath: 許可した 4 つの形と決まったクエリだけを通す", () => {
  for (const path of [
    "/user",
    "/notifications",
    notificationsPath(1),
    notificationsPath(4),
    issuePath("example-org", "example-repo", 12),
    issuePath("example-org", "example.repo_2", 3),
    timelinePath("example-org", "example-repo", 12),
    timelinePath("example-org", "example-repo", 12, 3),
    "/repos/example-org/example-repo/issues/12/timeline",
  ]) {
    assert.equal(isAllowedGhPath(path), true, path);
  }
  for (const path of [
    "",
    "notifications",
    "/notifications/threads/1",
    "/notifications?all=true&all=false",
    "/notifications?since=2026-10-01T00:00:00Z",
    "/notifications?per_page=0",
    "/notifications?",
    "/user?x=1",
    "/user/repos",
    "/graphql",
    "/repos/example-org/example-repo/pulls/12",
    "/repos/example-org/example-repo/issues/0",
    "/repos/example-org/example-repo/issues/12/comments",
    "/repos/example-org/example-repo/issues/12?state=open",
    "/repos/example-org/example-repo/issues/12/timeline?per_page=100&page=2&x=1",
    "/repos/example-org/../issues/12",
    "/repos/example-org/./issues/12",
    "/repos/{owner}/{repo}/issues/12",
    "/repos/example org/example-repo/issues/12",
    "/repos/example-org/example-repo/issues/12/timeline/extra",
    "https://api.github.com/user",
    "--method=POST",
    // パーセントエンコード・改行・# は通さない
    "/repos/example-org/example%2Frepo/issues/12",
    "/repos/example-org/example-repo/issues/12%2F..",
    "/repos/example%2Dorg/example-repo/issues/12",
    "/notifications?all=false&page=1%0A",
    "/notifications?all%3Dtrue",
    "/user\n",
    "/user\r\nX-Injected: 1",
    "/notifications?all=false\n&page=1",
    "/notifications?all=false&page=1\n",
    "/repos/example-org/example-repo/issues/12\n/timeline",
    "/notifications#fragment",
    "/notifications?all=false#x",
    "/repos/example-org/example-repo/issues/12#x",
    "/repos/example-org/example-repo/issues/12/timeline?page=1#x",
  ]) {
    assert.equal(isAllowedGhPath(path), false, path);
  }
});

test("ghApiArgs: GET・--include・固定のヘッダ・パスは最後。許可していないパス・GET 以外のメソッド・形の違う If-Modified-Since は投げる", () => {
  assert.deepEqual(ghApiArgs({ method: "GET", path: "/user" }), [
    "api",
    "--method",
    "GET",
    "--include",
    "-H",
    "Accept: application/vnd.github+json",
    "-H",
    "X-GitHub-Api-Version: 2022-11-28",
    "/user",
  ]);
  const conditional = ghApiArgs({ method: "GET", path: notificationsPath(1), ifModifiedSince: "Wed, 14 Oct 2026 01:02:03 GMT" });
  assert.deepEqual(conditional.slice(-3), ["-H", "If-Modified-Since: Wed, 14 Oct 2026 01:02:03 GMT", notificationsPath(1)]);
  for (const flag of ["-f", "-F", "--input", "--field", "--raw-field", "POST"]) assert.ok(!conditional.includes(flag));

  assert.throws(() => ghApiArgs({ method: "GET", path: "/repos/example-org/example-repo/pulls/1/merge" }), /許可していない/);
  for (const method of ["POST", "PATCH", "PUT", "DELETE", "get"]) {
    assert.throws(() => ghApiArgs({ method: method as "GET", path: "/user" }), /GET だけ/);
  }
  assert.throws(() => ghApiArgs({ method: "GET", path: "/user", ifModifiedSince: "x\r\nAuthorization: token" }), /If-Modified-Since/);
});

test("GhClient: 許可していないパス・メソッドでは gh を実行せずに投げる。実行するときは絶対パス・固定の引数・上限・許可した env だけ", async () => {
  const { run, calls } = fakeRun(exited(0, include("HTTP/2.0 200 OK", ["Content-Type: application/json"], "{}")));
  const client = new GhClient({
    ghPath: "/usr/bin/gh",
    run,
    sourceEnv: { HOME: "/home/example", DISCORD_TOKEN: "secret", GH_TOKEN: "secret", PATH: "/opt/evil:/usr/bin" },
  });
  await assert.rejects(client.get({ method: "GET", path: "/repos/example-org/example-repo/issues/1/comments" }), /許可していない/);
  await assert.rejects(client.get({ method: "DELETE" as "GET", path: "/user" }), /GET だけ/);
  assert.equal(calls.length, 0);

  const response = await client.get({ method: "GET", path: "/user" });
  assert.equal(response.kind, "ok");
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.file, "/usr/bin/gh");
  assert.deepEqual(calls[0]!.args, ghApiArgs({ method: "GET", path: "/user" }));
  assert.equal(calls[0]!.timeoutMs, GH_TIMEOUT_MS);
  assert.equal(calls[0]!.maxBuffer, GH_MAX_BUFFER);
  assert.deepEqual(calls[0]!.env, ghChildEnv({ HOME: "/home/example" }));

  assert.throws(() => new GhClient({ ghPath: "gh", run }), /絶対パス/);
});

test("ghChildEnv: HOME と固定の値だけ。トークン類・ほかの変数は写さない", () => {
  const source: NodeJS.ProcessEnv = {
    HOME: "/home/example",
    PATH: "/home/example/.nvm/bin:/usr/bin",
    DISCORD_TOKEN: "d",
    DISCORD_TOKEN_SECOND: "d2",
    CLAUDE_CODE_OAUTH_TOKEN: "c",
    GH_TOKEN: "g",
    GITHUB_TOKEN: "g2",
    GH_ENTERPRISE_TOKEN: "g3",
    SELF_AGENT_GITHUB_TOKEN: "g4",
    TMUX: "/tmp/tmux-1000/default,1,0",
    GH_HOST: "example.invalid",
    SELF_AGENT_OWNER_ID: "1",
  };
  const env = ghChildEnv(source);
  assert.deepEqual(env, {
    HOME: "/home/example",
    PATH: "/usr/local/bin:/usr/bin:/bin",
    LANG: "C.UTF-8",
    GH_PROMPT_DISABLED: "1",
    GH_NO_UPDATE_NOTIFIER: "1",
    NO_COLOR: "1",
  });
  assert.ok(!Object.keys(env).some((key) => /TOKEN|SECRET|PASSWORD/i.test(key)));
  assert.ok(!Object.values(env).some((value) => ["d", "d2", "c", "g", "g2", "g3", "g4"].includes(value)));
  assert.equal(ghChildEnv({}).HOME, undefined);
});

test("parseIncludeOutput: ステータス・ヘッダ（名前は小文字、重なりはつなぐ）・本文に分ける。ステータス行が無ければ undefined", () => {
  const parsed = parseIncludeOutput(
    include("HTTP/2.0 200 OK", ["Content-Type: application/json", "Link: <a>; rel=\"next\"", "X-Poll-Interval: 60", "Vary: Accept", "Vary: Origin"], '[{"a":1}]\n'),
  );
  assert.equal(parsed?.status, 200);
  assert.equal(parsed?.headers["content-type"], "application/json");
  assert.equal(parsed?.headers["x-poll-interval"], "60");
  assert.equal(parsed?.headers.vary, "Accept, Origin");
  assert.equal(parsed?.body, '[{"a":1}]\n');
  assert.equal(parseIncludeOutput("HTTP/1.1 304 Not Modified\r\nETag: x\r\n\r\n")?.status, 304);
  assert.equal(parseIncludeOutput(""), undefined);
  assert.equal(parseIncludeOutput("{\"message\":\"x\"}"), undefined);
});

test("interpretGhResult: 200 / 304（終了コード 1 でも）/ 401 / 403（Remaining 0）/ 終了コード 4 / そのほか", () => {
  const ok = interpretGhResult(exited(0, include("HTTP/2.0 200 OK", ["Last-Modified: Wed, 14 Oct 2026 01:02:03 GMT"], "[]")));
  assert.equal(ok.kind, "ok");
  assert.equal(ok.kind === "ok" && ok.body, "[]");

  const notModified = interpretGhResult(exited(1, include("HTTP/2.0 304 Not Modified", ["X-Poll-Interval: 60"])));
  assert.equal(notModified.kind, "not_modified");
  assert.equal(notModified.kind === "not_modified" && pollIntervalFromHeaders(notModified.headers), 60);
  assert.equal(interpretGhResult(exited(0, include("HTTP/2.0 304 Not Modified", []))).kind, "not_modified");

  assert.deepEqual(interpretGhResult(exited(1, include("HTTP/2.0 401 Unauthorized", [], '{"message":"Bad credentials"}'))), {
    kind: "auth",
    status: 401,
  });
  assert.deepEqual(interpretGhResult(exited(4, "")), { kind: "auth", status: null });
  assert.deepEqual(interpretGhResult(exited(4, include("HTTP/2.0 200 OK", [], "{}"))), { kind: "auth", status: null });

  const limited = interpretGhResult(
    exited(1, include("HTTP/2.0 403 Forbidden", ["X-RateLimit-Remaining: 0", "X-RateLimit-Reset: 1792056953"], "{}")),
  );
  assert.equal(limited.kind, "rate_limited");
  assert.equal(limited.kind === "rate_limited" && rateLimitFromHeaders(limited.headers).resetAt?.getTime(), 1792056953000);
  assert.equal(interpretGhResult(exited(1, include("HTTP/2.0 429 Too Many Requests", ["Retry-After: 30"]))).kind, "rate_limited");
  // Remaining が 0 でない 403 は権限などの失敗
  const forbidden = interpretGhResult(exited(1, include("HTTP/2.0 403 Forbidden", ["X-RateLimit-Remaining: 4000"])));
  assert.deepEqual([forbidden.kind, forbidden.kind === "http_error" && forbidden.status], ["http_error", 403]);
  const notFound = interpretGhResult(exited(1, include("HTTP/2.0 404 Not Found", [], "{}")));
  assert.deepEqual([notFound.kind, notFound.kind === "http_error" && notFound.status], ["http_error", 404]);
  assert.equal(interpretGhResult(exited(1, include("HTTP/2.0 502 Bad Gateway", []))).kind, "http_error");

  assert.deepEqual(interpretGhResult({ kind: "timeout" }), { kind: "failed", reason: "timeout" });
  assert.deepEqual(interpretGhResult({ kind: "too_large" }), { kind: "failed", reason: "output_too_large" });
  assert.deepEqual(interpretGhResult({ kind: "error" }), { kind: "failed", reason: "spawn" });
  assert.deepEqual(interpretGhResult(exited(1, "")), { kind: "failed", reason: "no_status" });
  assert.deepEqual(interpretGhResult(exited(1, include("HTTP/2.0 200 OK", [], "{}"))), { kind: "failed", reason: "exit" });
  assert.deepEqual(interpretGhResult(exited(null, include("HTTP/2.0 200 OK", [], "{}"))), { kind: "failed", reason: "exit" });
});

test("ヘッダの読み取り: X-Poll-Interval・Last-Modified・レート制限・Retry-After・Link の last", () => {
  assert.equal(pollIntervalFromHeaders({ "x-poll-interval": "60" }), 60);
  assert.equal(pollIntervalFromHeaders({ "x-poll-interval": "abc" }), undefined);
  assert.equal(pollIntervalFromHeaders({}), undefined);
  assert.equal(effectivePollIntervalSec(300, 60), 300);
  assert.equal(effectivePollIntervalSec(300, 600), 600);
  assert.equal(effectivePollIntervalSec(300, null), 300);

  assert.equal(lastModifiedFromHeaders({ "last-modified": "Wed, 14 Oct 2026 01:02:03 GMT" }), "Wed, 14 Oct 2026 01:02:03 GMT");
  assert.equal(lastModifiedFromHeaders({ "last-modified": "Wed\n, 14" }), undefined);
  assert.equal(lastModifiedFromHeaders({}), undefined);

  assert.deepEqual(rateLimitFromHeaders({ "x-ratelimit-remaining": "999", "x-ratelimit-reset": "1792056953" }), {
    remaining: 999,
    resetAt: new Date(1792056953000),
  });
  assert.deepEqual(rateLimitFromHeaders({ "x-ratelimit-remaining": "0" }), { remaining: 0 });
  assert.deepEqual(rateLimitFromHeaders({}), {});
  assert.equal(retryAfterSecFromHeaders({ "retry-after": "120" }), 120);
  assert.equal(retryAfterSecFromHeaders({ "retry-after": "Wed, 14 Oct 2026 01:02:03 GMT" }), undefined);

  const link =
    '<https://api.github.com/repositories/1/issues/2/timeline?per_page=100&page=2>; rel="next", ' +
    '<https://api.github.com/repositories/1/issues/2/timeline?per_page=100&page=7>; rel="last"';
  assert.equal(lastPageFromLink(link), 7);
  assert.equal(lastPageFromLink('<https://api.github.com/x?page=2>; rel="next"'), undefined);
  assert.equal(lastPageFromLink(undefined), undefined);
});

test("execFileRun: 終了コード・標準出力を返し、起動できなければ error、時間切れなら timeout。reject しない", async () => {
  const env = { PATH: "/usr/bin:/bin" };
  const options = { env, timeoutMs: 10_000, maxBuffer: 1024 * 1024 };
  const done = await execFileRun(process.execPath, ["-e", "process.stdout.write('HTTP/2.0 304 Not Modified\\n\\r\\n'); process.exit(1)"], options);
  assert.equal(done.kind, "exited");
  assert.equal(done.kind === "exited" && done.code, 1);
  assert.equal(interpretGhResult(done).kind, "not_modified");
  assert.deepEqual(await execFileRun("/nonexistent/gh", [], options), { kind: "error" });
  assert.deepEqual(await execFileRun(process.execPath, ["-e", "process.stdout.write('x'.repeat(4096))"], { ...options, maxBuffer: 1024 }), {
    kind: "too_large",
  });
  assert.deepEqual(await execFileRun(process.execPath, ["-e", "setTimeout(() => {}, 10000)"], { ...options, timeoutMs: 200 }), {
    kind: "timeout",
  });
});

test("resolveGhPath: PATH の絶対パスの要素を順に見て、実行できる gh のファイルの絶対パスを返す。無ければ undefined", (t) => {
  const root = mkdtempSync(join(tmpdir(), "self-agent-gh-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const notExecutable = join(root, "a");
  const directory = join(root, "b");
  const executable = join(root, "c");
  for (const dir of [notExecutable, directory, executable]) mkdirSync(dir);
  writeFileSync(join(notExecutable, "gh"), "", { mode: 0o644 });
  mkdirSync(join(directory, "gh"));
  writeFileSync(join(executable, "gh"), "", { mode: 0o755 });

  assert.equal(resolveGhPath(["relative", notExecutable, directory, executable].join(":")), join(executable, "gh"));
  assert.equal(resolveGhPath([notExecutable, directory].join(":")), undefined);
  assert.equal(resolveGhPath(""), undefined);
});
