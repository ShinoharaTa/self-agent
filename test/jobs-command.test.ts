import { test } from "node:test";
import assert from "node:assert/strict";
import { createChannelResolver } from "../src/app/access.ts";
import { acceptedReply, continuedReply, createJobCommand, createJobComponent, type JobCommandDeps, moreModal } from "../src/app/commands/job.ts";
import { STALE_TURN_REPLY } from "../src/app/commands/turn-controls.ts";
import { type CommandDeps, type ComponentDeps, type ComponentInteraction, createCommands, createComponents } from "../src/app/interactions.ts";
import type { Interaction } from "../src/discord/gateway.ts";
import type { JobRequest } from "../src/jobs/orchestrator.ts";
import { GuildSettingsStore } from "../src/store/guild-settings.ts";
import { tempDb } from "./helpers/db.ts";
import { FakeResponder } from "./helpers/responder.ts";

const NOW = new Date("2026-10-19T00:00:00Z");
const BASE = { guildId: "guild-1", channelId: "jobs-1", userId: "owner-1", createdAt: NOW };

type Jobs = JobCommandDeps["jobs"];

/** 偽の作業ジョブ（呼ばれた操作を残し、決めた結果を返す） */
class FakeJobs implements Jobs {
  calls: unknown[] = [];
  acceptResult: Awaited<ReturnType<Jobs["accept"]>> = { ok: true, jobId: 4, runId: 9 };
  abortResult = true;
  retryResult: "started" | "stale" = "started";
  pushResult: "started" | "stale" = "started";
  continueResult: Awaited<ReturnType<Jobs["continueJob"]>> = { ok: true, runId: 10 };
  text: string | undefined = "⚠ ジョブ #4 は push していません";

  async accept(request: JobRequest) {
    this.calls.push(["accept", request]);
    return this.acceptResult;
  }
  abort(runId: number) {
    this.calls.push(["abort", runId]);
    return this.abortResult;
  }
  async retry(runId: number) {
    this.calls.push(["retry", runId]);
    return this.retryResult;
  }
  async pushHeld(runId: number) {
    this.calls.push(["pushHeld", runId]);
    return this.pushResult;
  }
  async continueJob(jobId: number, instruction: string) {
    this.calls.push(["continueJob", jobId, instruction]);
    return this.continueResult;
  }
  messageText(runId: number) {
    this.calls.push(["messageText", runId]);
    return this.text;
  }
}

function command(subcommand: string, options: Record<string, string | number | boolean>): Extract<Interaction, { kind: "command" }> {
  return { ...BASE, kind: "command", name: "job", subcommand, options };
}

function button(customId: string): ComponentInteraction {
  return { ...BASE, kind: "button", customId, messageId: "msg-1" };
}

test("/job の定義: run（repo・task・issue）と new（name・task）のサブコマンド", () => {
  const def = createJobCommand({ jobs: new FakeJobs(), log: () => {} }).def;
  assert.equal(def.name, "job");
  assert.deepEqual(
    def.subcommands?.map((sub) => [sub.name, (sub.options ?? []).map((option) => `${option.name}:${option.type}:${option.required === true}`)]),
    [
      ["run", ["repo:string:true", "task:string:true", "issue:integer:false"]],
      ["new", ["name:string:true", "task:string:true"]],
    ],
  );
});

test("/job run・/job new: 保留してから受け付け、本人にだけ「ジョブ #<id> を受け付けました（#jobs）」。断るときは理由を本人にだけ", async () => {
  const jobs = new FakeJobs();
  const handler = createJobCommand({ jobs, log: () => {} });

  const responder = new FakeResponder();
  await handler.handle(command("run", { repo: "owner/repo", task: "直して", issue: 3 }), responder);
  assert.deepEqual(jobs.calls, [["accept", { kind: "run", guildId: "guild-1", repo: "owner/repo", instruction: "直して", issueNumber: 3 }]]);
  assert.deepEqual(responder.calls, [
    { method: "defer", ephemeral: true },
    { method: "reply", message: { text: acceptedReply(4), ephemeral: true } },
  ]);
  assert.equal(acceptedReply(4), "ジョブ #4 を受け付けました（#jobs）");

  jobs.calls = [];
  jobs.acceptResult = { ok: false, reply: "このリポジトリは対象にできません（SELF_AGENT_JOBS_REPOS）" };
  const refused = new FakeResponder();
  await handler.handle(command("new", { name: "sample", task: "作って" }), refused);
  assert.deepEqual(jobs.calls, [["accept", { kind: "new", guildId: "guild-1", name: "sample", instruction: "作って" }]]);
  assert.deepEqual(refused.replies, [{ text: "このリポジトリは対象にできません（SELF_AGENT_JOBS_REPOS）", ephemeral: true }]);

  await assert.rejects(handler.handle(command("other", {}), new FakeResponder()));
});

test("job のボタン: [中断] は実行中なら deferUpdate、違えば古い。[もう一度]・[ここまでを draft PR に] は始めたらボタンを外し、古ければ本人にだけ古い", async () => {
  const jobs = new FakeJobs();
  const component = createJobComponent({ jobs, log: () => {} });

  const abort = new FakeResponder();
  await component.handle(button("job:abort:9"), abort);
  assert.deepEqual(abort.calls, [{ method: "deferUpdate" }]);
  jobs.abortResult = false;
  const staleAbort = new FakeResponder();
  await component.handle(button("job:abort:9"), staleAbort);
  assert.deepEqual(staleAbort.replies, [{ text: STALE_TURN_REPLY, ephemeral: true }]);

  const retry = new FakeResponder();
  await component.handle(button("job:retry:9"), retry);
  assert.deepEqual(retry.calls, [
    { method: "deferUpdate" },
    { method: "update", message: { text: "⚠ ジョブ #4 は push していません", components: [] } },
  ]);
  jobs.pushResult = "stale";
  const push = new FakeResponder();
  await component.handle(button("job:push:9"), push);
  assert.deepEqual(push.calls, [{ method: "deferUpdate" }, { method: "reply", message: { text: STALE_TURN_REPLY, ephemeral: true } }]);
  assert.deepEqual(
    jobs.calls.filter((call) => Array.isArray(call) && (call[0] === "retry" || call[0] === "pushHeld")),
    [
      ["retry", 9],
      ["pushHeld", 9],
    ],
  );

  await assert.rejects(component.handle(button("job:retry:abc"), new FakeResponder()));
  await assert.rejects(component.handle(button("job:unknown:1"), new FakeResponder()));
});

test("[続きを頼む]: ボタンでモーダルを開き、送られたら続きを受け付ける。job が無い・閉じていれば古い", async () => {
  const jobs = new FakeJobs();
  const component = createJobComponent({ jobs, log: () => {} });

  const open = new FakeResponder();
  await component.handle(button("job:more:4"), open);
  assert.deepEqual(open.calls, [{ method: "showModal", modal: moreModal(4) }]);
  assert.equal(moreModal(4).customId, "job:more:4");
  assert.equal(moreModal(4).fields[0]!.maxLength, 2000);

  const modal: ComponentInteraction = { ...BASE, kind: "modal", customId: "job:more:4", fields: { instruction: "テストも足して" } };
  const submitted = new FakeResponder();
  await component.handle(modal, submitted);
  assert.deepEqual(jobs.calls.at(-1), ["continueJob", 4, "テストも足して"]);
  assert.deepEqual(submitted.calls, [
    { method: "defer", ephemeral: true },
    { method: "reply", message: { text: continuedReply(4), ephemeral: true } },
  ]);

  jobs.continueResult = "stale";
  const stale = new FakeResponder();
  await component.handle(modal, stale);
  assert.deepEqual(stale.replies, [{ text: STALE_TURN_REPLY, ephemeral: true }]);
});

test("interactions: /job と job: は作業ジョブを渡したときだけ（SELF_AGENT_JOBS が有効のときだけ）", () => {
  const without = createCommands({} as CommandDeps).map((handler) => handler.def.name);
  assert.equal(without.includes("job"), false);
  const withJobs = createCommands({ jobs: new FakeJobs(), log: () => {} } as unknown as CommandDeps).map((handler) => handler.def.name);
  assert.equal(withJobs.at(-1), "job");
  assert.equal(createComponents({} as ComponentDeps).some((handler) => handler.namespace === "job"), false);
  assert.equal(
    createComponents({ jobs: new FakeJobs(), log: () => {} } as unknown as ComponentDeps).some((handler) => handler.namespace === "job"),
    true,
  );
});

test("#jobs の発言は受け付けない（受け付けるのは #inbox・#tasks・セッションだけ）", (t) => {
  const guildSettings = new GuildSettingsStore(tempDb(t), () => NOW);
  guildSettings.setChannel("guild-1", "inboxChannelId", "inbox-1");
  guildSettings.setJobsChannel("guild-1", "jobs-1");
  const resolve = createChannelResolver({ inboxChannelId: undefined }, guildSettings, { get: () => undefined });
  assert.equal(resolve("guild-1", "inbox-1"), "inbox");
  assert.equal(resolve("guild-1", "jobs-1"), null);
});
