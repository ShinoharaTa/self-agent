// 作業ジョブのアプリ側の流れを利用枠なしで 1 回試す（docs/plan/coding-jobs.md §18 PR-J3）。npm run job-dry-run -- --repo <owner/repo> [--issue <n>]。
// LLM の代わりに決まったファイル（self-agent-dry-run.md に日時）を書いて commit する偽 Runner で、本体と同じ準備 → 取り込み → 検査 → push →
// draft PR までを**実際に**行う（gh の今のログインを使う。push 先は self-agent/job-<id> のブランチ、PR は draft）。Discord には投稿せず、
// #jobs に出す文を標準出力に出す。DB・作業場所・bare リポジトリは SELF_AGENT_WORKDIR・SELF_AGENT_DATA_DIR の中に作る一時ディレクトリに置き
// （本番の DB・作業場所・bare は触らない）、成功したら消す（失敗したら調べられるように残して場所を出す）。
// 読む設定は SELF_AGENT_WORKDIR・SELF_AGENT_DATA_DIR と作業ジョブの変数（SELF_AGENT_JOBS_REPOS・SELF_AGENT_JOBS_REPO_MAX_MB など）だけ
import { execFile } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import type { AgentRunner, RunInput, RunResult } from "../agent/runner.ts";
import { KeyedSerialQueue } from "../app/queue.ts";
import { loadJobDryRunConfig } from "../config.ts";
import type { OutgoingMessage } from "../discord/gateway.ts";
import { resolveCommandPath, resolveGhPath } from "../github/gh.ts";
import { GIT_CHILD_PATH, GitClient } from "../jobs/git.ts";
import { JobGithubApi } from "../jobs/github-api.ts";
import { JobOrchestrator, jobPaths, removeVerifiedChild } from "../jobs/orchestrator.ts";
import { openDb } from "../store/db.ts";
import { JobStore } from "../store/jobs.ts";
import { UsageStore } from "../store/usage.ts";

const run = promisify(execFile);

const USAGE = "使い方: npm run job-dry-run -- --repo <owner/repo> [--issue <番号>]";

function fail(message: string): number {
  console.error(message);
  return 1;
}

/** `--repo <owner/repo>` と `--issue <n>`。形が違えば undefined */
function parseArgs(argv: readonly string[]): { repo: string; issue: number | undefined } | undefined {
  let repo: string | undefined;
  let issue: number | undefined;
  for (let i = 0; i < argv.length; i++) {
    const name = argv[i];
    const value = argv[i + 1];
    if (name === "--repo" && value !== undefined) {
      repo = value;
      i++;
    } else if (name === "--issue" && value !== undefined && /^[1-9][0-9]*$/.test(value)) {
      issue = Number(value);
      i++;
    } else {
      return undefined;
    }
  }
  if (repo === undefined) return undefined;
  return { repo, issue };
}

export async function main(argv: readonly string[]): Promise<number> {
  const parsed = parseArgs(argv);
  if (parsed === undefined) return fail(USAGE);
  const { repo, issue } = parsed;
  let config: ReturnType<typeof loadJobDryRunConfig>;
  try {
    config = loadJobDryRunConfig();
  } catch (error) {
    return fail(error instanceof Error ? error.message : String(error));
  }
  const ghPath = resolveGhPath();
  const gitPath = resolveCommandPath("git");
  if (ghPath === undefined || gitPath === undefined) return fail("gh と git が要ります（PATH を確かめてください）");

  // 本番と同じファイルシステムの中に、このための一時ディレクトリを作る（本番の jobs/active・<dataDir>/jobs と重ならない）
  mkdirSync(config.workDir, { recursive: true });
  mkdirSync(config.dataDir, { recursive: true });
  const workDir = mkdtempSync(join(realpathSync(config.workDir), "job-dry-run-"));
  const dataDir = mkdtempSync(join(realpathSync(config.dataDir), "job-dry-run-"));
  chmodSync(workDir, 0o700);
  chmodSync(dataDir, 0o700);
  const now = (): Date => new Date();
  const log = (message: string): void => console.error(message);
  const db = openDb(join(dataDir, "dry-run.db"));
  // job の番号（ブランチ self-agent/job-<id>）を今の秒から始め、本番のジョブ・前の dry-run のブランチと重ならないようにする
  db.prepare("INSERT INTO sqlite_sequence (name, seq) VALUES ('jobs', ?)").run(Math.floor(Date.now() / 1000));
  const store = new JobStore(db, now);
  const repoDir = jobPaths(workDir, dataDir).repoDir;

  /** #jobs の代わり: 投稿と書き換えを標準出力に出す */
  const gateway = {
    sendMessage: async (_channelId: string, message: OutgoingMessage): Promise<string> => {
      console.log(`--- #jobs に投稿 ---\n${message.text}`);
      return `dry-run-${Date.now()}`;
    },
    editMessage: async (_channelId: string, _messageId: string, message: OutgoingMessage): Promise<void> => {
      console.log(`--- #jobs を書き換え ---\n${message.text}`);
    },
  };

  /** LLM の代わり: 決まったファイルを書いて commit し、job_result を届ける（利用枠は使わない） */
  class DryRunRunner implements AgentRunner {
    orchestrator: JobOrchestrator | undefined;

    async run(input: RunInput): Promise<RunResult> {
      const runId = Number(/^\[作業ジョブ #(\d+)\]/.exec(input.prompt)?.[1]);
      const env = { HOME: process.env.HOME ?? "/nonexistent", PATH: GIT_CHILD_PATH, LANG: "C.UTF-8", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" };
      writeFileSync(join(repoDir, "self-agent-dry-run.md"), `# self-agent dry-run\n\n${now().toISOString()}\n`);
      input.onProgress?.({ label: "書いています: self-agent-dry-run.md" });
      await run(gitPath!, ["-C", repoDir, "-c", "core.hooksPath=/dev/null", "add", "--", "self-agent-dry-run.md"], { env });
      await run(gitPath!, ["-C", repoDir, "-c", "core.hooksPath=/dev/null", "commit", "--quiet", "--no-verify", "-m", "self-agent dry-run"], { env });
      this.orchestrator?.recordResult(runId, {
        outcome: "done",
        tests: "not_run",
        prTitle: "self-agent: dry-run",
        summary: "self-agent の作業ジョブの dry-run（LLM なし）で作ったコミットです。確かめたら PR を閉じてブランチを消してください。",
      });
      const zero = { inputTokens: 0, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, cacheCreation1hInputTokens: 0 };
      return { ok: true, text: "", sessionId: "dry-run", usage: { ...zero, outputTokens: 0, steps: [] }, durationMs: 0, toolCalls: 1, contextTokens: 0 };
    }
  }

  const runner = new DryRunRunner();
  const orchestrator = new JobOrchestrator({
    // メンションはしない（Discord に出さないため）
    cfg: { ...config, ownerUserId: undefined },
    workDir,
    dataDir,
    jobs: store,
    guildSettings: { jobsChannelId: () => "dry-run" },
    usage: new UsageStore(db, now),
    queue: new KeyedSerialQueue(2),
    runner,
    git: new GitClient({ gitPath, ghPath, log, removeTree: (path) => removeVerifiedChild(jobPaths(workDir, dataDir).root, path) }),
    github: new JobGithubApi({ ghPath }),
    gateway,
    // LLM もシェルも使わない
    shellEnabled: () => true,
    now,
    log,
  });
  runner.orchestrator = orchestrator;

  const accepted = await orchestrator.accept({
    kind: "run",
    guildId: "dry-run",
    repo,
    instruction: "dry-run: self-agent-dry-run.md に日時を書いて commit する（LLM なし）",
    ...(issue === undefined ? {} : { issueNumber: issue }),
  });
  if (!accepted.ok) {
    db.close();
    rmSync(workDir, { recursive: true, force: true });
    rmSync(dataDir, { recursive: true, force: true });
    return fail(`受け付けられませんでした: ${accepted.reply}`);
  }
  await orchestrator.idle();
  const result = store.getRun(accepted.runId);
  const job = store.getJob(accepted.jobId);
  db.close();
  const succeeded = result?.state === "pr_opened" || (result?.state === "pushed" && result.failure === null);
  console.log(`--- 結果 ---\n状態: ${result?.state ?? "?"}・失敗: ${result?.failure ?? "-"}${job?.prUrl == null ? "" : `\ndraft PR: ${job.prUrl}`}`);
  if (succeeded) {
    rmSync(workDir, { recursive: true, force: true });
    rmSync(dataDir, { recursive: true, force: true });
    console.log(`確かめたら、draft PR を閉じてブランチ（${job?.branch ?? "?"}）を消してください`);
  } else {
    console.error(`調べられるように一時ディレクトリを残しました（確かめたら消してください）:\n${workDir}\n${dataDir}`);
    return 1;
  }
  return 0;
}
