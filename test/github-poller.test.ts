import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { createSystemNotifier } from "../src/app/system-notice.ts";
import { escapeDiscordText } from "../src/discord/escape.ts";
import type { GhHeaders, GhRequest, GhResponse } from "../src/github/gh.ts";
import {
  ACTOR_UNKNOWN_NOTE,
  createGithubPoller,
  GITHUB_AUTH_NOTICE,
  GITHUB_AUTH_RETRY_MS,
  GITHUB_FORBIDDEN_NOTICE,
  GITHUB_MAX_WAIT_MS,
  GITHUB_NETWORK_NOTICE,
  GITHUB_NETWORK_NOTICE_AFTER,
  GITHUB_NO_GH_NOTICE,
  GITHUB_RECOVERED_NOTICE,
  githubFoldedNotice,
  githubStartNotice,
  GithubPoller,
  type GithubTimers,
  NO_GITHUB_CHANNEL_LOG,
} from "../src/github/poller.ts";
import { GithubStore } from "../src/store/github.ts";
import { createStores, tempDb } from "./helpers/db.ts";
import { FakeGateway } from "./helpers/gateway.ts";

const NOW = new Date("2026-10-15T12:00:00Z");
const ME = "example-me";
const LAST_MODIFIED = "Thu, 15 Oct 2026 11:59:00 GMT";
/** 窓（前回の 2 回分の間隔 = 11:50 より後）の中の時刻 */
const IN_WINDOW = "2026-10-15T11:55:00Z";
/** log に出てはいけない印（リポジトリ名・題名・ログイン） */
const SECRET_OWNER = "secret-org";
const SECRET_REPO = "secret-repo";
const SECRET_TITLE = "MARKER-TITLE";
const SECRET_LOGIN = "secret-login";

type RawOptions = {
  reason?: string;
  updatedAt?: string;
  type?: "Issue" | "PullRequest";
  owner?: string;
  repo?: string;
  number?: number;
  title?: string;
};

/** GET /notifications の 1 要素 */
function raw(id: string, options: RawOptions = {}): unknown {
  const { reason = "mention", updatedAt = IN_WINDOW, type = "PullRequest", owner = SECRET_OWNER, repo = SECRET_REPO, number = 12 } = options;
  return {
    id,
    unread: true,
    reason,
    updated_at: updatedAt,
    last_read_at: null,
    subject: {
      title: options.title ?? SECRET_TITLE,
      url: `https://api.github.com/repos/${owner}/${repo}/${type === "Issue" ? "issues" : "pulls"}/${number}`,
      latest_comment_url: null,
      type,
    },
    repository: { full_name: `${owner}/${repo}`, private: true, owner: { login: owner } },
  };
}

function ok(body: unknown, headers: Record<string, string> = {}): GhResponse {
  return {
    kind: "ok",
    status: 200,
    headers: { "last-modified": LAST_MODIFIED, "x-ratelimit-remaining": "4000", ...headers },
    body: JSON.stringify(body),
  };
}

function notModified(headers: GhHeaders = {}): GhResponse {
  return { kind: "not_modified", status: 304, headers };
}

const NOT_FOUND: GhResponse = { kind: "http_error", status: 404, headers: {} };

/** 偽の gh。/user は ME、/notifications は notifications、それ以外（タイムライン・本体）は lookups（無ければ 404） */
class FakeGh {
  requests: GhRequest[] = [];
  notifications: () => GhResponse = () => ok([]);
  user: () => GhResponse = () => ok({ login: ME });
  lookups = new Map<string, GhResponse>();

  async get(request: GhRequest): Promise<GhResponse> {
    this.requests.push(request);
    if (request.path === "/user") return this.user();
    if (request.path.startsWith("/notifications")) return this.notifications();
    return this.lookups.get(request.path) ?? NOT_FOUND;
  }

  /** タイムライン・本体を取りに行った回数 */
  lookupCount(): number {
    return this.requests.filter((request) => request.path.startsWith("/repos/")).length;
  }
}

function setup(t: TestContext, options: { github?: boolean; withGh?: boolean; githubChannel?: boolean } = {}) {
  const db = tempDb(t);
  let now = NOW;
  const clock = (): Date => now;
  const store = new GithubStore(db, clock);
  const { guildSettings } = createStores(db, clock);
  guildSettings.setChannel("guild-1", "systemChannelId", "system-1");
  if (options.githubChannel !== false) guildSettings.setChannel("guild-1", "githubChannelId", "github-1");
  const gateway = new FakeGateway({ allow: ["sendMessage"] });
  const gh = new FakeGh();
  const logs: string[] = [];
  const delays: number[] = [];
  const scheduled: Array<() => void> = [];
  let cancelled = 0;
  const timers: GithubTimers = {
    after: (fn, ms) => {
      delays.push(ms);
      scheduled.push(fn);
      return () => {
        cancelled++;
      };
    },
  };
  const deps = {
    cfg: {
      github: options.github ?? true,
      allowedGuildIds: ["guild-1"],
      ownerUserId: "owner-1",
      githubPollSec: 300,
      githubOwners: [],
    },
    gh: options.withGh === false ? undefined : gh,
    store,
    guildSettings,
    gateway,
    notify: createSystemNotifier({ guildSettings, gateway, log: () => {} }),
    now: clock,
    timers,
    log: (line: string) => logs.push(line),
  };
  const poller = createGithubPoller(deps);
  return {
    poller: poller!,
    deps,
    store,
    guildSettings,
    gateway,
    gh,
    logs,
    delays,
    scheduled,
    cancelled: () => cancelled,
    setNow: (date: Date) => {
      now = date;
    },
    /** #github への投稿の本文 */
    githubPosts: () => gateway.posts.filter((post) => post.channelId === "github-1"),
    systemPosts: () => gateway.posts.filter((post) => post.channelId === "system-1").map((post) => post.message.text),
  };
}

/** 最初の回（未読なし）を済ませ、開始の知らせを消しておく */
async function baseline(env: ReturnType<typeof setup>): Promise<void> {
  env.gh.notifications = () => ok([]);
  await env.poller.tick();
  env.gateway.posts.length = 0;
  env.gh.requests = [];
}

/** log にリポジトリ名・題名・URL・ログインが出ていない */
function assertNoSecrets(logs: readonly string[]): void {
  for (const line of logs) {
    for (const secret of [SECRET_OWNER, SECRET_REPO, SECRET_TITLE, SECRET_LOGIN, "github.com", "https://"]) {
      assert.ok(!line.includes(secret), `log に ${secret} が出ています: ${line}`);
    }
  }
}

test("SELF_AGENT_GITHUB が無効ならポーラーを作らない（何も動かない）", (t) => {
  const env = setup(t, { github: false });
  assert.equal(env.poller, undefined);
  assert.deepEqual(env.gh.requests, []);
  assert.ok(setup(t).poller instanceof GithubPoller);
});

test("最初の回: 今ある未読は投稿せずに記録し、#github に開始の知らせを 1 通だけ出す。次の回は Last-Modified を付けて 304 なら何も投稿しない", async (t) => {
  const env = setup(t);
  env.gh.notifications = () => ok([raw("t-1"), raw("t-2", { reason: "author" }), raw("t-3", { reason: "subscribed" })]);

  await env.poller.tick();

  assert.deepEqual(
    env.githubPosts().map((post) => post.message),
    [{ text: githubStartNotice(3) }],
  );
  // 最初の回は調べに行かない
  assert.equal(env.gh.lookupCount(), 0);
  assert.equal(env.store.getPollState().baselineDone, true);
  assert.equal(env.store.getPollState().lastModified, LAST_MODIFIED);
  assert.ok(env.store.getThread("t-1") !== undefined);
  assert.deepEqual(env.store.listUnposted(10), []);

  env.gh.requests = [];
  env.gh.notifications = () => notModified();
  await env.poller.tick();
  const notificationRequests = env.gh.requests.filter((request) => request.path.startsWith("/notifications"));
  assert.equal(notificationRequests.length, 1);
  assert.equal(notificationRequests[0]!.ifModifiedSince, LAST_MODIFIED);
  assert.equal(env.githubPosts().length, 1);
  assertNoSecrets(env.logs);
});

test("赤はオーナーだけをメンションし、黄はメンションしない。URL は <> で囲み、誰の操作か分からなければ注記する", async (t) => {
  const env = setup(t);
  await baseline(env);
  env.gh.notifications = () =>
    ok([
      raw("red-1", { reason: "review_requested", number: 12 }),
      raw("yellow-1", { reason: "subscribed", type: "Issue", owner: ME, repo: SECRET_REPO, number: 3, updatedAt: "2026-10-15T11:56:00Z" }),
      raw("red-2", { reason: "mention", number: 13, updatedAt: "2026-10-15T11:57:00Z" }),
    ]);
  env.gh.lookups.set(
    `/repos/${SECRET_OWNER}/${SECRET_REPO}/issues/12/timeline?per_page=100&page=1`,
    ok([
      { event: "review_requested", actor: { login: SECRET_LOGIN, type: "User" }, requested_reviewer: { login: ME }, created_at: IN_WINDOW },
      { event: "commented", actor: { login: SECRET_LOGIN, type: "User" }, created_at: IN_WINDOW },
    ]),
  );
  env.gh.lookups.set(
    `/repos/${ME}/${SECRET_REPO}/issues/3`,
    ok({ user: { login: SECRET_LOGIN, type: "User" }, created_at: "2026-10-15T11:56:00Z" }),
  );
  env.gh.lookups.set(`/repos/${ME}/${SECRET_REPO}/issues/3/timeline?per_page=100&page=1`, ok([]));
  // red-2 のタイムラインは 404（分からない）

  await env.poller.tick();

  // 赤 → 黄の順（それぞれ古い順）
  const posts = env.githubPosts().map((post) => post.message);
  assert.equal(posts.length, 3);
  const repoText = escapeDiscordText(`${SECRET_OWNER}/${SECRET_REPO}`);
  assert.deepEqual(posts[0], {
    text: [
      `🔴 レビュー依頼  ${repoText}  PR #12  （${escapeDiscordText(SECRET_LOGIN)}）`,
      escapeDiscordText(SECRET_TITLE),
      `<https://github.com/${SECRET_OWNER}/${SECRET_REPO}/pull/12>`,
    ].join("\n"),
    mentionUserId: "owner-1",
  });
  assert.deepEqual(posts[2], {
    text: [
      `🟡 新しい Issue  ${escapeDiscordText(`${ME}/${SECRET_REPO}`)}  Issue #3  （${escapeDiscordText(SECRET_LOGIN)}）`,
      escapeDiscordText(SECRET_TITLE),
      `<https://github.com/${ME}/${SECRET_REPO}/issues/3>`,
    ].join("\n"),
  });
  const red2 = posts[1]!;
  assert.equal(red2.mentionUserId, "owner-1");
  assert.ok(red2.text.startsWith(`🔴 メンション  ${repoText}  PR #13`));
  assert.ok(red2.text.endsWith(`\n${ACTOR_UNKNOWN_NOTE}`));
  assert.ok(env.logs.includes("GitHub の通知: 新しい 3 件（赤 2・黄 1・白 0）"));
  assertNoSecrets(env.logs);
});

test("題名は改行を空白にして先頭 100 字にし、Markdown・メンションを無効にする", async (t) => {
  const env = setup(t);
  await baseline(env);
  env.gh.notifications = () => ok([raw("t-1", { title: `**a**\n@everyone <@1> ${"x".repeat(200)}` })]);
  await env.poller.tick();
  const line = env.githubPosts()[0]!.message.text.split("\n")[1]!;
  assert.ok(line.startsWith("\\*\\*a\\*\\* \\@everyone \\<\\@1\\> x"), line);
  assert.equal(line.replace(/\\/g, "").length, 100);
});

test("同じ (thread_id, updated_at) は 2 回投稿しない。同じスレッドに新しい出来事が来たら投稿する", async (t) => {
  const env = setup(t);
  await baseline(env);
  env.gh.notifications = () => ok([raw("t-1")]);
  await env.poller.tick();
  // 条件付き要求が効かず同じ一覧がまた来ても出さない
  await env.poller.tick();
  assert.equal(env.githubPosts().length, 1);

  env.gh.notifications = () => ok([raw("t-1", { updatedAt: "2026-10-15T11:58:00Z" })]);
  await env.poller.tick();
  assert.equal(env.githubPosts().length, 2);
});

test("30 日より古い未読は、スレッドの行が消えた後に一覧がまた来ても流さない", async (t) => {
  const env = setup(t);
  const old = raw("t-old", { updatedAt: "2026-08-01T00:00:00Z" });
  env.gh.notifications = () => ok([old]);
  await env.poller.tick();
  // 同じ tick の最初の prune でスレッドの行は消える
  await env.poller.tick();
  assert.equal(env.store.getThread("t-old"), undefined);
  assert.deepEqual(
    env.githubPosts().map((post) => post.message.text),
    [githubStartNotice(1)],
  );
});

test("白（自分の操作だけ・捨てる reason）は投稿しないが行は残す", async (t) => {
  const env = setup(t);
  await baseline(env);
  env.gh.notifications = () => ok([raw("t-1", { reason: "author" }), raw("t-2", { reason: "ci_activity" })]);
  env.gh.lookups.set(
    `/repos/${SECRET_OWNER}/${SECRET_REPO}/issues/12/timeline?per_page=100&page=1`,
    ok([{ event: "commented", actor: { login: ME, type: "User" }, created_at: IN_WINDOW }]),
  );
  await env.poller.tick();
  assert.deepEqual(env.githubPosts(), []);
  assert.ok(env.logs.includes("GitHub の通知: 新しい 2 件（赤 0・黄 0・白 2）"));
  // ci_activity は調べに行かない（タイムラインは t-1 の 1 回だけ）
  assert.equal(env.gh.lookupCount(), 1);
});

test("1 回に投稿するのは 10 件まで。11 件目以降は「ほか n 件」の 1 通にまとめ、次の回に出し直さない", async (t) => {
  const env = setup(t);
  await baseline(env);
  env.gh.notifications = () =>
    ok(Array.from({ length: 12 }, (_, index) => raw(`t-${index}`, { number: index + 1, updatedAt: `2026-10-15T11:55:${String(index).padStart(2, "0")}Z` })));

  await env.poller.tick();

  const texts = env.githubPosts().map((post) => post.message.text);
  assert.equal(texts.length, 11);
  assert.ok(texts[0]!.includes("PR #1\n"), texts[0]);
  assert.ok(texts[9]!.includes("PR #10\n"), texts[9]);
  // まとめた中に赤があれば、その数を書いてオーナーをメンションする
  assert.equal(texts[10], githubFoldedNotice(2, 2));
  assert.ok(texts[10]!.includes("うち自分宛て 2 件"));
  assert.equal(env.githubPosts()[10]!.message.mentionUserId, "owner-1");
  assert.deepEqual(env.store.listUnposted(100), []);

  env.gh.notifications = () => notModified();
  await env.poller.tick();
  assert.equal(env.githubPosts().length, 11);
});

test("投稿に失敗したものは次の回（304 でも）に 1 回だけ出し直す", async (t) => {
  const env = setup(t);
  await baseline(env);
  env.gh.notifications = () => ok([raw("t-1")]);
  env.gateway.beforeSendMessage = () => {
    throw new Error("Discord が落ちています");
  };
  await env.poller.tick();
  assert.equal(env.githubPosts().length, 0);
  assert.ok(env.logs.includes("GitHub の通知 1 件を投稿できませんでした（次の回に出し直します）"));

  env.gateway.beforeSendMessage = () => {};
  env.gh.notifications = () => notModified();
  await env.poller.tick();
  assert.equal(env.githubPosts().length, 1);
  await env.poller.tick();
  assert.equal(env.githubPosts().length, 1);
  assertNoSecrets(env.logs);
});

test("次の回までの間隔: X-Poll-Interval が設定より長ければそれに、短ければ設定に従う", async (t) => {
  const env = setup(t);
  await baseline(env);
  env.gh.notifications = () => notModified({ "x-poll-interval": "600" });
  assert.equal(await env.poller.tick(), 600_000);
  env.gh.notifications = () => notModified({ "x-poll-interval": "60" });
  assert.equal(await env.poller.tick(), 300_000);
});

test("X-RateLimit-Remaining が 1,000 未満ならタイムライン・本体を取りに行かず、分からないものとして流す", async (t) => {
  const env = setup(t);
  await baseline(env);
  env.gh.notifications = () => ok([raw("t-1", { reason: "author" })], { "x-ratelimit-remaining": "999" });
  await env.poller.tick();
  assert.equal(env.gh.lookupCount(), 0);
  const post = env.githubPosts()[0]!.message;
  assert.ok(post.text.startsWith("🔴 コメント"), post.text);
  assert.ok(post.text.endsWith(ACTOR_UNKNOWN_NOTE));
});

test("レート制限（403・Remaining 0）なら Reset まで取得を止め、30 分を超えるときだけ #system に知らせる", async (t) => {
  const env = setup(t);
  await baseline(env);
  const reset = Math.floor(NOW.getTime() / 1000) + 2 * 60 * 60;
  env.gh.notifications = () => ({
    kind: "rate_limited",
    status: 403,
    headers: { "x-ratelimit-remaining": "0", "x-ratelimit-reset": String(reset) },
  });
  assert.equal(await env.poller.tick(), 2 * 60 * 60 * 1000);
  assert.equal(env.systemPosts().length, 1);

  env.gh.requests = [];
  env.setNow(new Date(NOW.getTime() + 60 * 60 * 1000));
  assert.equal(await env.poller.tick(), 60 * 60 * 1000);
  assert.deepEqual(env.gh.requests, []);
  assert.equal(env.systemPosts().length, 1);
});

test("認証の失敗は 15 分間隔に落とし、#system には変わったときだけ 1 回、戻ったら 1 回知らせる", async (t) => {
  const env = setup(t);
  await baseline(env);
  env.gh.notifications = () => ({ kind: "auth", status: 401 });
  assert.equal(await env.poller.tick(), GITHUB_AUTH_RETRY_MS);
  assert.equal(await env.poller.tick(), GITHUB_AUTH_RETRY_MS);
  assert.deepEqual(env.systemPosts(), [GITHUB_AUTH_NOTICE]);
  assert.equal(env.store.getPollState().errorKind, "auth");

  env.gh.notifications = () => notModified();
  await env.poller.tick();
  await env.poller.tick();
  assert.deepEqual(env.systemPosts(), [GITHUB_AUTH_NOTICE, GITHUB_RECOVERED_NOTICE]);
  assert.equal(env.store.getPollState().errorKind, null);
});

test("通信の失敗は 6 回続いたら #system に 1 回知らせる（5 回までは知らせない）", async (t) => {
  const env = setup(t);
  await baseline(env);
  env.gh.notifications = () => ({ kind: "failed", reason: "timeout" });
  for (let i = 1; i < GITHUB_NETWORK_NOTICE_AFTER; i++) await env.poller.tick();
  assert.deepEqual(env.systemPosts(), []);
  await env.poller.tick();
  await env.poller.tick();
  assert.deepEqual(env.systemPosts(), [GITHUB_NETWORK_NOTICE]);
  assert.equal(env.logs.filter((line) => line.startsWith("GitHub の通知を取得できませんでした")).length, 1);
});

test("応答の形が違う回は捨てて、Last-Modified を保存しない", async (t) => {
  const env = setup(t);
  await baseline(env);
  env.store.savePollState({ lastModified: null });
  env.gh.notifications = () => ({ kind: "ok", status: 200, headers: { "last-modified": LAST_MODIFIED }, body: "{}" });
  await env.poller.tick();
  assert.equal(env.store.getPollState().lastModified, null);
  assert.deepEqual(env.systemPosts(), []);
  assert.ok(env.logs.includes("GitHub の通知を取得できませんでした（shape）"));
});

test("gh が見つからなければ取得せず、#system に 1 回だけ知らせる", async (t) => {
  const env = setup(t, { withGh: false });
  env.poller.start();
  await env.poller.idle();
  assert.deepEqual(env.systemPosts(), [GITHUB_NO_GH_NOTICE]);
  assert.deepEqual(env.delays, []);
});

test("start は直後に 1 回取得して次の回を予約し、stop で予約を取り消す", async (t) => {
  const env = setup(t);
  env.poller.start();
  await env.poller.idle();
  // 予約は tick の後の then で入る
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(env.delays, [300_000]);
  assert.equal(env.githubPosts().length, 1);
  env.poller.stop();
  assert.equal(env.cancelled(), 1);
  // stop の後に予約が呼ばれても取得しない
  env.gh.requests = [];
  env.scheduled[0]!();
  await env.poller.idle();
  assert.deepEqual(env.gh.requests, []);
});

test("赤 → 黄の順に投稿し、まとめた中に赤が無ければ「ほか n 件」はメンションしない", async (t) => {
  const env = setup(t);
  await baseline(env);
  const yellows = Array.from({ length: 10 }, (_, index) =>
    raw(`y-${index}`, { reason: "subscribed", type: "Issue", owner: ME, number: index + 1, updatedAt: `2026-10-15T11:51:${String(index).padStart(2, "0")}Z` }),
  );
  const reds = [raw("r-1", { number: 101 }), raw("r-2", { number: 102, updatedAt: "2026-10-15T11:56:00Z" })];
  env.gh.notifications = () => ok([...reds, ...yellows]);

  await env.poller.tick();

  const posts = env.githubPosts().map((post) => post.message);
  assert.equal(posts.length, 11);
  assert.ok(posts[0]!.text.includes("PR #101\n") && posts[1]!.text.includes("PR #102\n"));
  assert.ok(posts.slice(2, 10).every((post) => post.text.startsWith("🟡")));
  assert.ok(posts[2]!.text.includes("Issue #1\n"));
  assert.deepEqual(posts[10], { text: githubFoldedNotice(2) });
});

test("止まっていた後: 初めて見たスレッドの窓は最後に取得できた時刻まで広げる（他人のコメントの後に自分が返事をしても赤）", async (t) => {
  const env = setup(t);
  // 1 時間前に最後に取得できて、その後止まっていた
  env.setNow(new Date(NOW.getTime() - 60 * 60 * 1000));
  await baseline(env);
  env.setNow(NOW);
  env.gh.notifications = () => ok([raw("t-1", { reason: "author", updatedAt: "2026-10-15T11:20:00Z" })]);
  env.gh.lookups.set(
    `/repos/${SECRET_OWNER}/${SECRET_REPO}/issues/12/timeline?per_page=100&page=1`,
    ok([
      { event: "commented", actor: { login: SECRET_LOGIN, type: "User" }, created_at: "2026-10-15T11:10:00Z" },
      { event: "commented", actor: { login: ME, type: "User" }, created_at: "2026-10-15T11:20:00Z" },
    ]),
  );

  await env.poller.tick();

  const posts = env.githubPosts().map((post) => post.message);
  assert.equal(posts.length, 1);
  assert.ok(posts[0]!.text.startsWith(`🔴 コメント  ${escapeDiscordText(`${SECRET_OWNER}/${SECRET_REPO}`)}  PR #12  （${escapeDiscordText(SECRET_LOGIN)}）`), posts[0]!.text);
  assert.ok(!posts[0]!.text.includes(ACTOR_UNKNOWN_NOTE));
});

test("調べる枠（20 スレッド）は新しい通知から使い、溢れた古いものが「確かめられませんでした」になる", async (t) => {
  const env = setup(t);
  await baseline(env);
  env.gh.notifications = () =>
    ok(Array.from({ length: 21 }, (_, index) => raw(`t-${index}`, { reason: "author", number: index + 1, updatedAt: `2026-10-15T11:5${Math.floor(index / 10)}:${String(index % 10).padStart(2, "0")}Z` })));
  for (let number = 1; number <= 21; number++) {
    env.gh.lookups.set(
      `/repos/${SECRET_OWNER}/${SECRET_REPO}/issues/${number}/timeline?per_page=100&page=1`,
      ok([{ event: "commented", actor: { login: SECRET_LOGIN, type: "User" }, created_at: "2026-10-15T11:59:00Z" }]),
    );
  }

  await env.poller.tick();

  assert.equal(env.gh.lookupCount(), 20);
  const texts = env.githubPosts().map((post) => post.message.text);
  // 古い順に投稿する。いちばん古い PR #1 だけが調べられていない
  assert.ok(texts[0]!.includes("PR #1\n") && texts[0]!.endsWith(ACTOR_UNKNOWN_NOTE), texts[0]);
  assert.ok(texts.slice(1, 10).every((text) => !text.endsWith(ACTOR_UNKNOWN_NOTE)));
});

test("待ちは 1 日まで: X-Poll-Interval・Retry-After がそれより長くても 1 日後に取りに行く", async (t) => {
  const env = setup(t);
  await baseline(env);
  env.gh.notifications = () => notModified({ "x-poll-interval": "999999" });
  assert.equal(await env.poller.tick(), GITHUB_MAX_WAIT_MS);

  env.gh.notifications = () => ({ kind: "rate_limited", status: 429, headers: { "retry-after": String(3 * 24 * 60 * 60) } });
  assert.equal(await env.poller.tick(), GITHUB_MAX_WAIT_MS);
  // 1 日経てば取りに行く
  env.gh.requests = [];
  env.setNow(new Date(NOW.getTime() + GITHUB_MAX_WAIT_MS));
  await env.poller.tick();
  assert.equal(env.gh.requests.length, 1);
});

test("再起動の前から続いている失敗（DB の error_kind）は #system に出し直さず、戻ったら 1 回知らせる", async (t) => {
  const env = setup(t);
  await baseline(env);
  env.store.savePollState({ errorKind: "auth", errorSince: new Date(NOW.getTime() - 60 * 60 * 1000).toISOString() });
  const restarted = new GithubPoller(env.deps);
  env.gh.notifications = () => ({ kind: "auth", status: 401 });
  await restarted.tick();
  assert.deepEqual(env.systemPosts(), []);

  env.gh.notifications = () => notModified();
  await restarted.tick();
  assert.deepEqual(env.systemPosts(), [GITHUB_RECOVERED_NOTICE]);
});

test("再起動の前の通信の失敗は、知らせるまでの回数分続いていたときだけ知らせ済みとみなす", async (t) => {
  for (const { sinceMs, expected } of [
    { sinceMs: 60 * 60 * 1000, expected: [] },
    { sinceMs: 60 * 1000, expected: [GITHUB_NETWORK_NOTICE] },
  ]) {
    const env = setup(t);
    await baseline(env);
    env.store.savePollState({ errorKind: "network", errorSince: new Date(NOW.getTime() - sinceMs).toISOString() });
    const restarted = new GithubPoller(env.deps);
    env.gh.notifications = () => ({ kind: "failed", reason: "timeout" });
    for (let i = 0; i < GITHUB_NETWORK_NOTICE_AFTER; i++) await restarted.tick();
    assert.deepEqual(env.systemPosts(), expected, String(sinceMs));
  }
});

test("#github が無ければ log に 1 回だけ出し、最初の回を終えない（再起動しても）。#github ができたら開始の知らせを出す", async (t) => {
  const env = setup(t, { githubChannel: false });
  env.gh.notifications = () => ok([raw("t-1")]);
  await env.poller.tick();
  await env.poller.tick();
  assert.equal(env.logs.filter((line) => line === NO_GITHUB_CHANNEL_LOG).length, 1);
  assert.equal(env.store.getPollState().baselineDone, false);
  assert.deepEqual(env.gateway.posts, []);

  const restarted = new GithubPoller(env.deps);
  await restarted.tick();
  assert.equal(env.store.getPollState().baselineDone, false);

  env.guildSettings.setChannel("guild-1", "githubChannelId", "github-1");
  await restarted.tick();
  assert.deepEqual(
    env.githubPosts().map((post) => post.message),
    [{ text: githubStartNotice(1) }],
  );
  assert.equal(env.store.getPollState().baselineDone, true);
  // 最初の回の未読は流さない
  await restarted.tick();
  assert.equal(env.githubPosts().length, 1);
});

test("レート制限でない 403 は「拒否しました」として #system に 1 回知らせる（通信の失敗とは分ける）", async (t) => {
  const env = setup(t);
  await baseline(env);
  env.gh.notifications = () => ({ kind: "http_error", status: 403, headers: {} });
  await env.poller.tick();
  await env.poller.tick();
  assert.deepEqual(env.systemPosts(), [GITHUB_FORBIDDEN_NOTICE]);
  assert.equal(env.store.getPollState().errorKind, "forbidden");
});
