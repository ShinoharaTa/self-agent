// GitHub の通知の取得と振り分けを 1 回だけ試す（docs/plan/github-notifications.md §13 PR-G2）。npm run github-dry-run。
// gh の今のログインで未読の通知を取り（GitHub の既読は変えない）、本体と同じ振り分け（タイムライン・本体の取得を含む）をして、件数だけを端末に出す。
// Discord には投稿せず、DB も読み書きしない（どのスレッドも初めて見たものとして振り分ける。30 日より古いものは本体と同じく見ない）。読む設定は SELF_AGENT_GITHUB_POLL_SEC と SELF_AGENT_GITHUB_OWNERS だけ。
// リポジトリ名・題名・URL・ログインは出さない
import { loadGithubConfig } from "../src/config.ts";
import { type GithubNotification, parseNotification } from "../src/github/classify.ts";
import { GhClient, resolveGhPath } from "../src/github/gh.ts";
import {
  classifyWithLookups,
  fetchLogin,
  fetchNotifications,
  GITHUB_MAX_LOOKUP_THREADS,
  GITHUB_PRUNE_MS,
  newLookupBudget,
} from "../src/github/poller.ts";

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

let githubConfig: ReturnType<typeof loadGithubConfig>;
try {
  githubConfig = loadGithubConfig();
} catch (error) {
  fail(error instanceof Error ? error.message : String(error));
}

const ghPath = resolveGhPath();
if (ghPath === undefined) fail("gh が見つかりません（PATH を確かめてください）");
const gh = new GhClient({ ghPath });
const now = new Date();
const intervalMs = githubConfig.githubPollSec * 1000;

const me = await fetchLogin(gh, now, intervalMs);
if ("failure" in me) fail(`gh のログインを取得できませんでした（${me.failure.kind}）`);

const fetched = await fetchNotifications(gh, undefined, now, intervalMs);
if (fetched.kind === "failed") fail(`通知を取得できませんでした（${fetched.failure.kind}）`);
if (fetched.kind === "not_modified") fail("通知を取得できませんでした（304）");

const notifications: GithubNotification[] = [];
let invalid = 0;
for (const item of fetched.items) {
  const notification = parseNotification(item);
  if (notification === undefined) invalid++;
  else notifications.push(notification);
}

const owners = githubConfig.githubOwners.length > 0 ? githubConfig.githubOwners : [me.login];
const budget = newLookupBudget(fetched.remaining);
const counts = { red: 0, yellow: 0, drop: 0 };
let unknown = 0;
// 本体と同じく、30 日より古いものは見ず、調べる枠は新しいものから使う
const cutoff = now.getTime() - GITHUB_PRUNE_MS;
const recent = notifications
  .filter((notification) => Date.parse(notification.updatedAt) >= cutoff)
  .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
for (const notification of recent) {
  const classification = await classifyWithLookups(notification, {
    gh,
    me: me.login,
    owners,
    now,
    pollIntervalSec: githubConfig.githubPollSec,
    previousUpdatedAt: null,
    lastSuccessAt: null,
    firstSeen: true,
    budget,
  });
  counts[classification.level]++;
  if (classification.level !== "drop" && !classification.actorKnown) unknown++;
}

console.log(
  `未読の通知: ${notifications.length} 件（形の違うもの ${invalid} 件、30 日より古いため見なかったもの ${notifications.length - recent.length} 件）`,
);
console.log(`赤 ${counts.red}・黄 ${counts.yellow}・白 ${counts.drop}（赤・黄のうち誰の操作か確かめられなかったもの ${unknown} 件）`);
console.log(`タイムラインを調べたスレッド: ${budget.threads} 件（上限 ${GITHUB_MAX_LOOKUP_THREADS}）。レート制限の残り: ${budget.remaining ?? "不明"}`);
console.log("（どのスレッドも初めて見たものとして振り分けています。本体では前回見た後の出来事だけを見るので、件数は本体と違うことがあります）");
console.log("（投稿していません。DB も GitHub の既読も変えていません）");
