import { test } from "node:test";
import assert from "node:assert/strict";
import {
  classifyNotification,
  collectActors,
  DROP_LABEL,
  isBotUser,
  parseIssue,
  parseNotification,
  parseSubjectUrl,
  subjectHtmlUrl,
  timelineSince,
  wantsIssueInfo,
  type ActorSet,
  type ClassifyInput,
  type GithubIssueInfo,
  type GithubNotification,
} from "../src/github/classify.ts";

// ログイン・リポジトリはすべてプレースホルダ
const ME = "example-user";
const OWNERS = ["example-user", "example-org"];
const NOW = new Date("2026-10-15T12:00:00Z");
/** 前回見た updated_at（これより後の出来事だけを数える） */
const SINCE = new Date("2026-10-15T11:00:00Z");

function user(login: string, type: "User" | "Bot" = "User"): { login: string; type: string } {
  return { login, type };
}

/** GET /notifications の 1 要素の形 */
function rawNotification(overrides: { reason?: string; type?: string; url?: string | null; owner?: string } = {}): unknown {
  const owner = overrides.owner ?? "example-org";
  return {
    id: "1000001",
    unread: true,
    reason: overrides.reason ?? "author",
    updated_at: "2026-10-15T11:30:00Z",
    last_read_at: null,
    subject: {
      title: "題名",
      url: overrides.url === undefined ? `https://api.github.com/repos/${owner}/example-repo/pulls/12` : overrides.url,
      latest_comment_url: null,
      type: overrides.type ?? "PullRequest",
    },
    repository: { full_name: `${owner}/example-repo`, private: true, owner: { login: owner } },
  };
}

function notification(overrides: Parameters<typeof rawNotification>[0] = {}): GithubNotification {
  const parsed = parseNotification(rawNotification(overrides));
  assert.ok(parsed);
  return parsed;
}

/** 前回より後の出来事の偽のタイムライン */
const after = "2026-10-15T11:10:00Z";
const before = "2026-10-15T10:00:00Z";
const timelines = {
  onlyMe: [
    { event: "commented", actor: user(ME), user: user(ME), created_at: after },
    { event: "committed", author: { name: "someone", date: after } },
    { event: "closed", actor: user("example-other"), created_at: before },
  ],
  onlyBots: [
    { event: "commented", actor: user("github-actions[bot]", "Bot"), created_at: after },
    { event: "reviewed", user: user("copilot-pull-request-reviewer[bot]", "Bot"), submitted_at: after },
    { event: "labeled", actor: user("renovate", "Bot"), created_at: after },
  ],
  othersComment: [
    { event: "commented", actor: user(ME), created_at: after },
    { event: "commented", actor: user("example-other"), user: user("example-other"), created_at: after },
  ],
  othersReview: [
    { event: "reviewed", user: user("example-reviewer"), submitted_at: after },
    { event: "line-commented", comments: [{ user: user("example-reviewer"), created_at: after }] },
  ],
  copilotReview: [
    { event: "reviewed", user: user("Copilot", "Bot"), submitted_at: after },
    { event: "line-commented", comments: [{ user: user("Copilot", "Bot"), created_at: after }] },
  ],
  empty: [] as unknown[],
  onlyOld: [{ event: "commented", actor: user("example-other"), created_at: before }],
};

function actors(items: readonly unknown[]): ActorSet {
  return collectActors(items, SINCE);
}

function issue(login: string, createdAt: string, type: "User" | "Bot" = "User"): GithubIssueInfo {
  const parsed = parseIssue({ user: user(login, type), created_at: createdAt, title: "x" });
  assert.ok(parsed);
  return parsed;
}

function classify(overrides: Partial<ClassifyInput> & { notification: GithubNotification }) {
  return classifyNotification({
    me: ME,
    owners: OWNERS,
    firstSeen: false,
    actors: { known: false },
    now: NOW,
    ...overrides,
  });
}

test("parseNotification: 必要な欄を取り出し、型の違うものは undefined", () => {
  assert.deepEqual(notification(), {
    threadId: "1000001",
    reason: "author",
    updatedAt: "2026-10-15T11:30:00Z",
    lastReadAt: null,
    title: "題名",
    subjectUrl: "https://api.github.com/repos/example-org/example-repo/pulls/12",
    subjectType: "PullRequest",
    repoFullName: "example-org/example-repo",
    repoOwner: "example-org",
    repoPrivate: true,
  });
  assert.equal(notification({ url: null }).subjectUrl, null);
  assert.equal(parseNotification(null), undefined);
  assert.equal(parseNotification({ ...(rawNotification() as object), id: 1 }), undefined);
  assert.equal(parseNotification({ ...(rawNotification() as object), repository: { full_name: "x", private: "no", owner: { login: "x" } } }), undefined);
  assert.equal(parseNotification({ ...(rawNotification() as object), subject: { title: "x", url: 3, type: "Issue" } }), undefined);
});

test("parseSubjectUrl・subjectHtmlUrl: API の URL から番号を取り、画面の URL は検証した部品から組み立てる", () => {
  assert.deepEqual(parseSubjectUrl("https://api.github.com/repos/example-org/example-repo/pulls/12"), {
    owner: "example-org",
    repo: "example-repo",
    number: 12,
    kind: "pull",
  });
  const issueSubject = parseSubjectUrl("https://api.github.com/repos/example-org/example.repo/issues/3");
  assert.ok(issueSubject);
  assert.equal(subjectHtmlUrl(issueSubject), "https://github.com/example-org/example.repo/issues/3");
  assert.equal(subjectHtmlUrl(parseSubjectUrl("https://api.github.com/repos/example-org/example-repo/pulls/12")!), "https://github.com/example-org/example-repo/pull/12");
  for (const url of [
    null,
    "https://api.github.com/repos/example-org/example-repo/releases/1",
    "https://api.github.com/repos/example-org/example-repo/pulls/0",
    "https://api.github.com/repos/example-org/../pulls/1",
    "https://example.invalid/repos/example-org/example-repo/pulls/1",
    "https://api.github.com/repos/example-org/example-repo/pulls/1?x=1",
  ]) {
    assert.equal(parseSubjectUrl(url), undefined, String(url));
  }
});

test("collectActors: 前回より後の人を集める（commented は actor、reviewed は user、line-commented は comments[].user、committed は数えない）。誰もいなければ分からない", () => {
  assert.deepEqual(actors(timelines.onlyMe), { known: true, actors: [{ login: ME, isBot: false }], reviewedBy: [] });
  const bots = actors(timelines.onlyBots);
  assert.ok(bots.known);
  assert.deepEqual(
    bots.actors.map((actor) => [actor.login, actor.isBot]),
    [
      ["github-actions[bot]", true],
      ["copilot-pull-request-reviewer[bot]", true],
      ["renovate", true],
    ],
  );
  const review = actors(timelines.othersReview);
  assert.ok(review.known);
  assert.deepEqual(review.reviewedBy.map((actor) => actor.login), ["example-reviewer"]);
  assert.deepEqual(actors(timelines.empty), { known: false });
  assert.deepEqual(actors(timelines.onlyOld), { known: false });
  assert.deepEqual(actors([{ event: "committed", author: { name: "x" }, created_at: after }, "x", null]), { known: false });
  assert.equal(isBotUser({ login: "dependabot[bot]", type: "User" }), true);
  assert.equal(isBotUser({ login: "example-other", type: "User" }), false);
});

test("timelineSince: 前回の updated_at → last_read_at → ポーリング間隔の 2 回分前", () => {
  assert.equal(timelineSince({ previousUpdatedAt: "2026-10-15T10:00:00Z", lastReadAt: "2026-10-15T09:00:00Z", now: NOW, pollIntervalSec: 300 }).toISOString(), "2026-10-15T10:00:00.000Z");
  assert.equal(timelineSince({ previousUpdatedAt: undefined, lastReadAt: "2026-10-15T09:00:00Z", now: NOW, pollIntervalSec: 300 }).toISOString(), "2026-10-15T09:00:00.000Z");
  assert.equal(timelineSince({ previousUpdatedAt: null, lastReadAt: null, now: NOW, pollIntervalSec: 300 }).toISOString(), "2026-10-15T11:50:00.000Z");
});

test("規則 1: Issue・PullRequest 以外と、番号の取れない subject は白", () => {
  for (const type of ["CheckSuite", "Release", "Discussion", "Commit", "RepositoryVulnerabilityAlert"]) {
    const result = classify({ notification: notification({ type, reason: "mention" }), actors: actors(timelines.othersComment) });
    assert.deepEqual([result.level, result.rule, result.label], ["drop", 1, DROP_LABEL], type);
  }
  assert.equal(classify({ notification: notification({ url: null, reason: "mention" }) }).rule, 1);
});

test("規則 2: ci_activity・security_alert・state_change などの reason は白", () => {
  for (const reason of ["ci_activity", "security_alert", "security_advisory_credit", "state_change", "member_feature_requested", "agent_session_finished"]) {
    const result = classify({ notification: notification({ reason }), actors: actors(timelines.othersComment) });
    assert.deepEqual([result.level, result.rule], ["drop", 2], reason);
  }
});

test("規則 3: スレッドの作成者が Bot（Dependabot の PR）なら、レビュー依頼でも他人がいても白", () => {
  const dependabot = issue("dependabot[bot]", "2026-10-15T11:00:00Z", "Bot");
  for (const reason of ["review_requested", "author", "subscribed"]) {
    const result = classify({
      notification: notification({ reason }),
      actors: actors(timelines.othersComment),
      issue: dependabot,
      firstSeen: true,
    });
    assert.deepEqual([result.level, result.rule], ["drop", 3], reason);
  }
});

test("規則 4: 新しい出来事が自分だけ・Bot だけ（Copilot のレビューを含む）なら、メンション・自分の PR でも白", () => {
  for (const [name, items] of [
    ["自分だけ", timelines.onlyMe],
    ["Bot だけ", timelines.onlyBots],
    ["Copilot のレビュー", timelines.copilotReview],
  ] as const) {
    for (const reason of ["author", "comment", "mention", "review_requested"]) {
      const result = classify({ notification: notification({ reason }), actors: actors(items) });
      assert.deepEqual([result.level, result.rule, result.actorKnown], ["drop", 4, true], `${name} ${reason}`);
    }
  }
});

test("規則 5: review_requested・mention・team_mention・assign・approval_requested は赤（他人がいるか分からなくても）", () => {
  const cases = [
    ["review_requested", "レビュー依頼"],
    ["approval_requested", "レビュー依頼"],
    ["mention", "メンション"],
    ["team_mention", "メンション"],
    ["assign", "担当"],
  ] as const;
  for (const [reason, label] of cases) {
    const known = classify({ notification: notification({ reason }), actors: actors(timelines.othersComment) });
    assert.deepEqual([known.level, known.rule, known.label, known.actorLogin, known.actorKnown], ["red", 5, label, "example-other", true], reason);
    const unknown = classify({ notification: notification({ reason }), actors: actors(timelines.empty) });
    assert.deepEqual([unknown.level, unknown.rule, unknown.actorLogin, unknown.actorKnown], ["red", 5, null, false], reason);
  }
});

test("規則 6: author・comment で他人の出来事があれば赤（レビューなら種別はレビュー）。分からなければ他人がいるとみなして赤", () => {
  for (const reason of ["author", "comment"]) {
    const comment = classify({ notification: notification({ reason }), actors: actors(timelines.othersComment) });
    assert.deepEqual([comment.level, comment.rule, comment.label, comment.actorLogin, comment.actorKnown], ["red", 6, "コメント", "example-other", true]);
    const review = classify({ notification: notification({ reason }), actors: actors(timelines.othersReview) });
    assert.deepEqual([review.level, review.rule, review.label, review.actorLogin], ["red", 6, "レビュー", "example-reviewer"]);
    const unknown = classify({ notification: notification({ reason }), actors: actors(timelines.onlyOld) });
    assert.deepEqual([unknown.level, unknown.rule, unknown.label, unknown.actorLogin, unknown.actorKnown], ["red", 6, "コメント", null, false]);
  }
  const subject = classify({ notification: notification({ reason: "author" }), actors: actors(timelines.othersComment) }).subject;
  assert.deepEqual(subject, { owner: "example-org", repo: "example-repo", number: 12, kind: "pull" });
});

test("規則 7: 自分のリポジトリで初めて見た、他人が 24 時間以内に作った Issue・PR は黄。本体が分からなければ reason と持ち主と初めて見たかだけで黄", () => {
  const newIssue = notification({ reason: "subscribed", type: "Issue", url: "https://api.github.com/repos/example-org/example-repo/issues/3" });
  assert.equal(wantsIssueInfo(newIssue, OWNERS, true), true);
  const yellow = classify({
    notification: newIssue,
    firstSeen: true,
    actors: actors(timelines.empty),
    issue: issue("example-other", "2026-10-15T08:00:00Z"),
  });
  assert.deepEqual([yellow.level, yellow.rule, yellow.label, yellow.actorLogin, yellow.actorKnown], ["yellow", 7, "新しい Issue", "example-other", true]);

  const newPr = classify({
    notification: notification({ reason: "manual" }),
    firstSeen: true,
    actors: actors(timelines.othersComment),
    issue: issue("example-other", "2026-10-15T11:00:00Z"),
  });
  assert.deepEqual([newPr.level, newPr.rule, newPr.label], ["yellow", 7, "新しい PR"]);

  // 持ち主の比較は大小を区別しない
  assert.equal(classify({ notification: notification({ reason: "subscribed", owner: "Example-Org" }), firstSeen: true, issue: issue("example-other", "2026-10-15T11:00:00Z") }).level, "yellow");

  const unknown = classify({ notification: newIssue, firstSeen: true, actors: actors(timelines.empty) });
  assert.deepEqual([unknown.level, unknown.rule, unknown.label, unknown.actorLogin, unknown.actorKnown], ["yellow", 7, "新しい Issue", null, false]);
});

test("規則 7 に当たらないもの: 24 時間より古い・自分が作った・初めてではない・他人のリポジトリは白（規則 8）", () => {
  const newIssue = notification({ reason: "subscribed", type: "Issue", url: "https://api.github.com/repos/example-org/example-repo/issues/3" });
  const old = classify({ notification: newIssue, firstSeen: true, issue: issue("example-other", "2026-10-14T11:59:59Z") });
  assert.deepEqual([old.level, old.rule], ["drop", 8]);
  const justIn = classify({ notification: newIssue, firstSeen: true, issue: issue("example-other", "2026-10-14T12:00:00Z") });
  assert.equal(justIn.level, "yellow");
  const mine = classify({ notification: newIssue, firstSeen: true, issue: issue("Example-User", "2026-10-15T11:00:00Z") });
  assert.deepEqual([mine.level, mine.rule], ["drop", 8]);
  const seen = classify({ notification: newIssue, firstSeen: false, issue: issue("example-other", "2026-10-15T11:00:00Z") });
  assert.deepEqual([seen.level, seen.rule], ["drop", 8]);
  const foreign = notification({ reason: "subscribed", owner: "someone-else" });
  assert.equal(wantsIssueInfo(foreign, OWNERS, true), false);
  assert.equal(wantsIssueInfo(newIssue, OWNERS, false), false);
  assert.deepEqual(
    (({ level, rule }) => [level, rule])(classify({ notification: foreign, firstSeen: true, issue: issue("example-other", "2026-10-15T11:00:00Z") })),
    ["drop", 8],
  );
});

test("規則 8: 他人どうしのスレッドの続き（subscribed で既に見たスレッド）や、知らない reason は白", () => {
  const followUp = classify({ notification: notification({ reason: "subscribed" }), actors: actors(timelines.othersComment) });
  assert.deepEqual([followUp.level, followUp.rule], ["drop", 8]);
  const invitation = classify({ notification: notification({ reason: "invitation" }), actors: actors(timelines.othersComment) });
  assert.deepEqual([invitation.level, invitation.rule], ["drop", 8]);
});
