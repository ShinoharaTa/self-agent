import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileRun, GH_MAX_BUFFER, GH_TIMEOUT_MS, type RunCommand, type RunOptions, type RunResult } from "../src/github/gh.ts";
import {
  alreadyExists,
  isAllowedJobGetPath,
  isAllowedJobPostPath,
  JobGithubApi,
  jobGhApiArgs,
  noreplyAuthor,
  parseComments,
  parseIssue,
  parsePull,
  parseRepo,
  parseReviews,
  parseUser,
  pullUrl,
} from "../src/jobs/github-api.ts";

const GH = "/usr/bin/gh";

/** gh の --include の出力（ステータス行は \n、ヘッダと空行は \r\n） */
function include(statusLine: string, body: unknown, headers: readonly string[] = []): string {
  return `${statusLine}\n${headers.map((header) => `${header}\r\n`).join("")}\r\n${typeof body === "string" ? body : JSON.stringify(body)}`;
}

function ok(body: unknown, headers: readonly string[] = []): RunResult {
  return { kind: "exited", code: 0, stdout: include("HTTP/2.0 200 OK", body, headers), stderr: "" };
}

function status(code: number, body: unknown): RunResult {
  return { kind: "exited", code: 1, stdout: include(`HTTP/2.0 ${code} Error`, body), stderr: "gh: error" };
}

type Call = { file: string; args: readonly string[]; options: RunOptions };

function fakeRun(results: RunResult[]): { run: RunCommand; calls: Call[] } {
  const calls: Call[] = [];
  const run: RunCommand = async (file, args, options) => {
    calls.push({ file, args, options });
    const result = results.shift();
    if (result === undefined) throw new Error("想定より多く呼ばれました");
    return result;
  };
  return { run, calls };
}

const PULL = {
  number: 7,
  state: "open",
  draft: true,
  merged_at: null,
  head: { ref: "self-agent/job-3", repo: { full_name: "example-org/example-repo" } },
  base: { ref: "main" },
};

test("isAllowedJobGetPath: §7.5 の形と決まったクエリだけを通す", () => {
  for (const path of [
    "/user",
    "/repos/example-org/example-repo",
    "/repos/example-org/example-repo/issues/12",
    "/repos/example-org/example-repo/issues/12/comments?per_page=100&page=2",
    "/repos/example-org/example-repo/issues/12/comments",
    "/repos/example-org/example-repo/pulls/12",
    "/repos/example-org/example-repo/pulls/12/comments?per_page=100&page=1",
    "/repos/example-org/example-repo/pulls/12/reviews?per_page=50&page=1",
    "/repos/example-org/example-repo/pulls?head=example-org:self-agent/job-3&state=all",
    "/repos/example-org/example-repo/pulls?head=example-org:self-agent/job-3&state=all&per_page=100",
  ]) {
    assert.equal(isAllowedJobGetPath(path), true, path);
  }
  for (const path of [
    "",
    "/user?x=1",
    "/user/repos",
    "/repos/example-org",
    "/repos/example-org/..",
    "/repos/example-org/example-repo?x=1",
    "/repos/example-org/example-repo/issues/0",
    "/repos/example-org/example-repo/issues/12/reviews",
    "/repos/example-org/example-repo/issues/12/comments?since=2026-01-01",
    "/repos/example-org/example-repo/issues/12/comments?per_page=101",
    "/repos/example-org/example-repo/issues/12/comments?page=1&page=2",
    "/repos/example-org/example-repo/pulls/12/files",
    "/repos/example-org/example-repo/pulls/12/merge",
    "/repos/example-org/example-repo/pulls",
    "/repos/example-org/example-repo/pulls?state=all",
    "/repos/example-org/example-repo/pulls?head=other-org:self-agent/job-3",
    "/repos/example-org/example-repo/pulls?head=example-org:main",
    "/repos/example-org/example-repo/pulls?head=example-org:self-agent/job-3&state=merged",
    "/repos/example-org/example-repo/contents/x",
    "/repos/example-org/example-repo/git/refs",
    "/graphql",
  ]) {
    assert.equal(isAllowedJobGetPath(path), false, path);
  }
});

test("isAllowedJobPostPath・jobGhApiArgs: POST は 2 つのパスだけで --input -。ほかのメソッド・パスは投げる", () => {
  assert.equal(isAllowedJobPostPath("/repos/example-org/example-repo/pulls"), true);
  assert.equal(isAllowedJobPostPath("/user/repos"), true);
  for (const path of ["/repos/example-org/example-repo/pulls/1/merge", "/repos/example-org/example-repo/issues", "/orgs/x/repos", "/user/repos?x=1", "/repos/a/b/git/refs"]) {
    assert.equal(isAllowedJobPostPath(path), false, path);
    assert.throws(() => jobGhApiArgs({ method: "POST", path }));
  }
  assert.throws(() => jobGhApiArgs({ method: "GET", path: "/repos/example-org/example-repo/pulls" }));
  assert.throws(() => jobGhApiArgs({ method: "PATCH" as "GET", path: "/user" }));
  assert.throws(() => jobGhApiArgs({ method: "DELETE" as "POST", path: "/user/repos" }));
  assert.deepEqual(jobGhApiArgs({ method: "POST", path: "/user/repos" }), [
    "api",
    "--method",
    "POST",
    "--include",
    "-H",
    "Accept: application/vnd.github+json",
    "-H",
    "X-GitHub-Api-Version: 2022-11-28",
    "--input",
    "-",
    "/user/repos",
  ]);
  assert.deepEqual(jobGhApiArgs({ method: "GET", path: "/user" }).slice(0, 4), ["api", "--method", "GET", "--include"]);
  assert.equal(jobGhApiArgs({ method: "GET", path: "/user" }).includes("--input"), false);
});

test("createDraftPull: 本文は標準入力の JSON で、引数に出ない。env にトークン類が無い。URL は検証した部品から", async () => {
  const { run, calls } = fakeRun([{ kind: "exited", code: 0, stdout: include("HTTP/2.0 201 Created", { number: 9, html_url: "https://evil.example/x" }), stderr: "" }]);
  const api = new JobGithubApi({ ghPath: GH, run, sourceEnv: { HOME: "/home/example", GH_TOKEN: "dummy", CLAUDE_CODE_OAUTH_TOKEN: "dummy", DISCORD_TOKEN: "dummy", HTTPS_PROXY: "x" } });
  const result = await api.createDraftPull({
    owner: "example-org",
    repo: "example-repo",
    head: "self-agent/job-3",
    base: "main",
    title: "題名 SECRET-TITLE",
    body: "本文 SECRET-BODY",
  });
  assert.deepEqual(result, { ok: true, value: { number: 9, url: "https://github.com/example-org/example-repo/pull/9", existing: false } });
  assert.equal(calls.length, 1);
  const call = calls[0]!;
  assert.equal(call.file, GH);
  assert.deepEqual(call.args.slice(-3), ["--input", "-", "/repos/example-org/example-repo/pulls"]);
  assert.equal(call.args.some((arg) => arg.includes("SECRET")), false);
  assert.deepEqual(JSON.parse(call.options.input!), {
    title: "題名 SECRET-TITLE",
    head: "self-agent/job-3",
    base: "main",
    body: "本文 SECRET-BODY",
    draft: true,
    maintainer_can_modify: false,
  });
  assert.equal(call.options.timeoutMs, GH_TIMEOUT_MS);
  assert.equal(call.options.maxBuffer, GH_MAX_BUFFER);
  assert.deepEqual(Object.keys(call.options.env).sort(), ["GH_NO_UPDATE_NOTIFIER", "GH_PROMPT_DISABLED", "HOME", "LANG", "NO_COLOR", "PATH"]);
});

test("createDraftPull: 422（既にある）なら head で引いた既存の PR を返す。見つからなければ http_error", async () => {
  const exists = status(422, { message: "Validation Failed", errors: [{ message: "A pull request already exists for example-org:self-agent/job-3." }] });
  const other = { ...PULL, number: 5, head: { ref: "self-agent/job-3", repo: { full_name: "someone/example-repo" } } };
  const { run, calls } = fakeRun([exists, ok([other, PULL])]);
  const api = new JobGithubApi({ ghPath: GH, run });
  const input = { owner: "example-org", repo: "example-repo", head: "self-agent/job-3", base: "main", title: "t", body: "b" };
  assert.deepEqual(await api.createDraftPull(input), {
    ok: true,
    value: { number: 7, url: "https://github.com/example-org/example-repo/pull/7", existing: true },
  });
  assert.deepEqual(calls[1]!.args.slice(1, 3), ["--method", "GET"]);
  assert.equal(calls[1]!.args.at(-1), "/repos/example-org/example-repo/pulls?head=example-org:self-agent/job-3&state=all&per_page=100");
  assert.equal(calls[1]!.options.input, undefined);

  const none = new JobGithubApi({ ghPath: GH, run: fakeRun([exists, ok([])]).run });
  assert.deepEqual(await none.createDraftPull(input), { ok: false, failure: "http_error", status: 422 });
  const authFailed = new JobGithubApi({ ghPath: GH, run: fakeRun([status(401, { message: "Bad credentials" })]).run });
  assert.deepEqual(await authFailed.createDraftPull(input), { ok: false, failure: "auth", status: 401 });
  const notFound = new JobGithubApi({ ghPath: GH, run: fakeRun([status(404, { message: "Not Found" })]).run });
  assert.deepEqual(await notFound.createDraftPull(input), { ok: false, failure: "not_found", status: 404 });
  const badShape = new JobGithubApi({ ghPath: GH, run: fakeRun([ok({ number: "9" })]).run });
  assert.deepEqual(await badShape.createDraftPull(input), { ok: false, failure: "bad_response", status: null });
});

test("createDraftPull: head が self-agent/ の下でない・名前の形が違うものは実行せずに投げる", async () => {
  const { run, calls } = fakeRun([]);
  const api = new JobGithubApi({ ghPath: GH, run });
  const input = { owner: "example-org", repo: "example-repo", head: "self-agent/job-3", base: "main", title: "t", body: "b" };
  await assert.rejects(api.createDraftPull({ ...input, head: "main" }));
  await assert.rejects(api.createDraftPull({ ...input, head: "other:self-agent/job-3" }));
  await assert.rejects(api.createDraftPull({ ...input, base: "a..b" }));
  await assert.rejects(api.createDraftPull({ ...input, owner: "a/b" }));
  await assert.rejects(api.createDraftPull({ ...input, repo: ".." }));
  await assert.rejects(api.createDraftPull({ ...input, title: "" }));
  await assert.rejects(api.getIssue("example-org", "example-repo", 0));
  await assert.rejects(api.listIssueComments("example-org", "example-repo", 1, 1, 101));
  assert.equal(calls.length, 0);
});

test("createRepo: POST /user/repos に非公開・auto_init の JSON を標準入力で。既にあれば exists", async () => {
  const created = { name: "sample-app", owner: { login: "example" }, default_branch: "main", private: true, html_url: "https://evil.example" };
  const { run, calls } = fakeRun([{ kind: "exited", code: 0, stdout: include("HTTP/2.0 201 Created", created), stderr: "" }]);
  const api = new JobGithubApi({ ghPath: GH, run });
  assert.deepEqual(await api.createRepo({ name: "sample-app" }), {
    ok: true,
    value: { owner: "example", repo: "sample-app", defaultBranch: "main", url: "https://github.com/example/sample-app" },
  });
  assert.equal(calls[0]!.args.at(-1), "/user/repos");
  assert.deepEqual(JSON.parse(calls[0]!.options.input!), { name: "sample-app", private: true, auto_init: true });

  const exists = status(422, { message: "Repository creation failed.", errors: [{ resource: "Repository", code: "custom", field: "name", message: "name already exists on this account" }] });
  assert.deepEqual(await new JobGithubApi({ ghPath: GH, run: fakeRun([exists]).run }).createRepo({ name: "sample-app" }), {
    ok: false,
    failure: "exists",
    status: 422,
  });
  const invalid = status(422, { message: "Validation Failed", errors: [{ message: "name is too long" }] });
  assert.deepEqual(await new JobGithubApi({ ghPath: GH, run: fakeRun([invalid]).run }).createRepo({ name: "sample-app" }), {
    ok: false,
    failure: "http_error",
    status: 422,
  });
  const wrongName = ok({ ...created, name: "other" });
  assert.deepEqual(await new JobGithubApi({ ghPath: GH, run: fakeRun([wrongName]).run }).createRepo({ name: "sample-app" }), {
    ok: false,
    failure: "bad_response",
    status: null,
  });
  await assert.rejects(api.createRepo({ name: "a/b" }));
  assert.equal(alreadyExists("not json"), false);
});

test("GET の包み: 応答の形を確かめる（Issue・コメント・レビュー・PR・リポジトリ・ユーザー）", async () => {
  const issue = { number: 12, title: "題名", body: null, user: { login: "someone" }, state: "open" };
  const comments = [
    { id: 1, user: { login: "someone" }, body: "a", created_at: "2026-10-01T00:00:00Z" },
    { id: 2, user: { login: "dependabot[bot]" }, body: "b", created_at: "2026-10-02T00:00:00Z", path: "src/x.ts" },
  ];
  const reviews = [{ id: 3, user: { login: "someone" }, body: "", state: "CHANGES_REQUESTED", submitted_at: "2026-10-03T00:00:00Z" }];
  const repo = { default_branch: "main", size: 1234, private: true, archived: false, permissions: { push: true } };
  const user = { id: 1234, login: "example", name: "Example Name" };
  const link = 'Link: <https://api.github.com/repositories/1/issues/12/comments?per_page=100&page=3>; rel="last"';
  const { run, calls } = fakeRun([ok(issue), ok(comments, [link]), ok(reviews), ok(comments), ok(PULL), ok(repo), ok(user)]);
  const api = new JobGithubApi({ ghPath: GH, run });
  assert.deepEqual(await api.getIssue("example-org", "example-repo", 12), {
    ok: true,
    value: { number: 12, title: "題名", body: "", author: "someone", state: "open", isPullRequest: false },
  });
  const listed = await api.listIssueComments("example-org", "example-repo", 12, 2);
  assert.equal(listed.ok && listed.value.items.length, 2);
  assert.equal(listed.ok && listed.value.lastPage, 3);
  assert.equal(listed.ok && listed.value.items[1]!.path, "src/x.ts");
  assert.deepEqual(await api.listPullReviews("example-org", "example-repo", 7), {
    ok: true,
    value: { items: [{ id: 3, author: "someone", body: "", state: "CHANGES_REQUESTED", submittedAt: "2026-10-03T00:00:00Z" }], lastPage: undefined },
  });
  assert.equal((await api.listPullReviewComments("example-org", "example-repo", 7)).ok, true);
  assert.deepEqual(await api.getPull("example-org", "example-repo", 7), {
    ok: true,
    value: { number: 7, state: "open", merged: false, draft: true, headRef: "self-agent/job-3", headRepo: "example-org/example-repo", baseRef: "main" },
  });
  assert.deepEqual(await api.getRepo("example-org", "example-repo"), {
    ok: true,
    value: { defaultBranch: "main", sizeKb: 1234, private: true, archived: false, canPush: true },
  });
  assert.deepEqual(await api.getUser(), { ok: true, value: user });
  assert.deepEqual(
    calls.map((call) => call.args.at(-1)),
    [
      "/repos/example-org/example-repo/issues/12",
      "/repos/example-org/example-repo/issues/12/comments?per_page=100&page=2",
      "/repos/example-org/example-repo/pulls/7/reviews?per_page=100&page=1",
      "/repos/example-org/example-repo/pulls/7/comments?per_page=100&page=1",
      "/repos/example-org/example-repo/pulls/7",
      "/repos/example-org/example-repo",
      "/user",
    ],
  );
  for (const call of calls) assert.equal(call.options.input, undefined);
});

test("parse*: 形の違う応答は undefined（一覧は 1 つでも違えば全体を捨てる）", () => {
  assert.equal(parseUser(JSON.stringify({ id: "1", login: "x" })), undefined);
  assert.equal(parseUser(JSON.stringify({ id: 1, login: "a b" })), undefined);
  assert.equal(parseUser("not json"), undefined);
  assert.equal(parseRepo(JSON.stringify({ default_branch: "a..b", size: 1, private: false })), undefined);
  assert.equal(parseRepo(JSON.stringify({ default_branch: "main", size: -1, private: false })), undefined);
  assert.equal(parseRepo(JSON.stringify({ default_branch: "main", size: 1 })), undefined);
  assert.equal(parseIssue(JSON.stringify({ number: 1, title: 1, body: "", user: { login: "x" }, state: "open" })), undefined);
  assert.equal(parseIssue(JSON.stringify({ number: 1, title: "t", body: "", user: { login: "x" }, state: "merged" })), undefined);
  assert.equal(parseIssue(JSON.stringify({ number: 1, title: "t", body: "", user: { login: "x" }, state: "open", pull_request: {} }))?.isPullRequest, true);
  assert.equal(parseComments(JSON.stringify([{ id: 1, user: { login: "x" }, body: "a", created_at: "t" }, { id: 2 }])), undefined);
  assert.equal(parseComments(JSON.stringify({})), undefined);
  assert.equal(parseComments(JSON.stringify([{ id: 1, user: null, body: "a", created_at: "t" }]))?.[0]?.author, "ghost");
  assert.equal(parseReviews(JSON.stringify([{ id: 1, user: { login: "x" }, body: "a" }])), undefined);
  assert.equal(parsePull(JSON.stringify({ ...PULL, head: { ref: "x", repo: { full_name: "a/b/c" } } })), undefined);
  assert.equal(parsePull(JSON.stringify({ ...PULL, head: { ref: "x", repo: null } }))?.headRepo, null);
  assert.equal(parsePull(JSON.stringify({ ...PULL, merged_at: "2026-10-01T00:00:00Z", state: "closed" }))?.merged, true);
});

test("noreplyAuthor: <id>+<login>@users.noreply.github.com と name（無い・使えなければ login）", () => {
  assert.deepEqual(noreplyAuthor({ id: 1234, login: "example", name: "Example Name" }), {
    name: "Example Name",
    email: "1234+example@users.noreply.github.com",
  });
  assert.deepEqual(noreplyAuthor({ id: 1234, login: "example", name: null }), { name: "example", email: "1234+example@users.noreply.github.com" });
  assert.equal(noreplyAuthor({ id: 1, login: "example", name: "a\n<b>\u0000" }).name, "ab");
  assert.equal(noreplyAuthor({ id: 1, login: "example", name: " <> " }).name, "example");
  assert.equal(noreplyAuthor({ id: 1, login: "example", name: "x".repeat(300) }).name.length, 100);
  assert.throws(() => noreplyAuthor({ id: 0, login: "example", name: null }));
  assert.throws(() => noreplyAuthor({ id: 1, login: "a@b", name: null }));
  assert.equal(pullUrl("example-org", "example-repo", 3), "https://github.com/example-org/example-repo/pull/3");
});

test("execFileRun: input を標準入力に渡す（input が無ければ今までどおり）", async () => {
  const options = { env: { PATH: "/usr/bin:/bin" }, timeoutMs: 10_000, maxBuffer: 1024 * 1024 };
  const echo = ["-e", "let s='';process.stdin.on('data',(d)=>s+=d).on('end',()=>process.stdout.write('['+s+']'))"];
  assert.deepEqual(await execFileRun(process.execPath, echo, { ...options, input: '{"a":1}' }), { kind: "exited", code: 0, stdout: '[{"a":1}]', stderr: "" });
  const noRead = ["-e", "process.stdout.write('x')"];
  assert.deepEqual(await execFileRun(process.execPath, noRead, options), { kind: "exited", code: 0, stdout: "x", stderr: "" });
});

test("execFileRun: 時間切れでは子のプロセスグループごと止める（孫を残さない）", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "self-agent-run-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const pidFile = join(root, "pid");
  const script = `const c=require('child_process').spawn('/bin/sleep',['30'],{stdio:'ignore'});require('fs').writeFileSync(${JSON.stringify(pidFile)},String(c.pid));setInterval(()=>{},1000)`;
  const result = await execFileRun(process.execPath, ["-e", script], { env: { PATH: "/usr/bin:/bin" }, timeoutMs: 500, maxBuffer: 1024 });
  assert.deepEqual(result, { kind: "timeout" });
  const grandchild = Number(readFileSync(pidFile, "utf8"));
  assert.ok(grandchild > 0);
  const alive = () => {
    try {
      process.kill(grandchild, 0);
      return true;
    } catch {
      return false;
    }
  };
  for (let i = 0; i < 40 && alive(); i += 1) await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(alive(), false);
});

test("createDraftPull: 422 で同じ head の PR が closed・merged しか無ければ既存として返さない（http_error）", async () => {
  const exists = status(422, { message: "Validation Failed", errors: [{ message: "A pull request already exists" }] });
  const closed = { ...PULL, state: "closed" };
  const merged = { ...PULL, number: 8, state: "closed", merged_at: "2026-10-01T00:00:00Z" };
  const api = new JobGithubApi({ ghPath: GH, run: fakeRun([exists, ok([closed, merged])]).run });
  const input = { owner: "example-org", repo: "example-repo", head: "self-agent/job-3", base: "main", title: "t", body: "b" };
  assert.deepEqual(await api.createDraftPull(input), { ok: false, failure: "http_error", status: 422 });
});
