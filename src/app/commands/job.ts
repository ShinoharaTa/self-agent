// /job（作業ジョブを頼む。docs/plan/coding-jobs.md §7.2）と、#jobs のボタン・モーダル（名前空間 `job:`）。
// SELF_AGENT_JOBS が有効のときだけ登録・配線する。進行は jobs/orchestrator.ts
import type { ModalDef } from "../../discord/gateway.ts";
import {
  JOB_INSTRUCTION_MAX_CHARS,
  JOB_MORE_FIELD_ID,
  JOB_NAMESPACE,
  type JobOrchestrator,
} from "../../jobs/orchestrator.ts";
import type { CommandHandler, ComponentHandler } from "../interactions.ts";
import { STALE_TURN_REPLY } from "./turn-controls.ts";

export type JobCommandDeps = {
  jobs: Pick<JobOrchestrator, "accept" | "abort" | "retry" | "pushHeld" | "continueJob" | "messageText">;
  log: (message: string) => void;
};

/** 受け付けたときの応答（本人にだけ） */
export function acceptedReply(jobId: number): string {
  return `ジョブ #${jobId} を受け付けました（#jobs）`;
}

/** 続きを受け付けたときの応答（本人にだけ） */
export function continuedReply(jobId: number): string {
  return `ジョブ #${jobId} の続きを受け付けました（#jobs）`;
}

const TASK_OPTION = {
  type: "string",
  name: "task",
  description: "頼む作業の指示",
  required: true,
  maxLength: JOB_INSTRUCTION_MAX_CHARS,
} as const;

/** [続きを頼む] のモーダル（`job:more:<job_id>`） */
export function moreModal(jobId: number): ModalDef {
  return {
    customId: `${JOB_NAMESPACE}:more:${jobId}`,
    title: `ジョブ #${jobId} の続き`,
    fields: [
      {
        customId: JOB_MORE_FIELD_ID,
        label: "追加の指示",
        style: "paragraph",
        maxLength: JOB_INSTRUCTION_MAX_CHARS,
      },
    ],
  };
}

function stringOption(value: string | number | boolean | undefined): string {
  return typeof value === "string" ? value : "";
}

/** custom_id の番号（正の整数でなければ undefined） */
function idOf(text: string | undefined): number | undefined {
  if (text === undefined || !/^[1-9][0-9]{0,15}$/.test(text)) return undefined;
  const id = Number(text);
  return Number.isSafeInteger(id) ? id : undefined;
}

/**
 * `/job run repo:<owner/repo> task:<指示> [issue:<番号>]` と `/job new name:<リポジトリ名> task:<指示>`。
 * 受け付けたら本人にだけ「ジョブ #<id> を受け付けました（#jobs）」、形が違う・許可リストの外などは本人にだけ断る（行を作らない）
 */
export function createJobCommand(deps: JobCommandDeps): CommandHandler {
  const { jobs, log } = deps;
  return {
    def: {
      name: "job",
      description: "サーバー上の作業ジョブを頼みます（結果は #jobs に draft PR で返します）",
      subcommands: [
        {
          name: "run",
          description: "既存のリポジトリで作業を頼みます",
          options: [
            { type: "string", name: "repo", description: "リポジトリ（owner/repo）", required: true, maxLength: 140 },
            TASK_OPTION,
            { type: "integer", name: "issue", description: "Issue の番号（本文を参考資料にし、PR に Closes を付けます）", minValue: 1 },
          ],
        },
        {
          name: "new",
          description: "新しい非公開のリポジトリを作って作業を頼みます",
          options: [
            { type: "string", name: "name", description: "リポジトリの名前（英数字と . _ -）", required: true, maxLength: 100 },
            TASK_OPTION,
          ],
        },
      ],
    },
    async handle(interaction, responder) {
      // 許可サーバー以外（DM を含む）は interactions.ts で弾いている
      const guildId = interaction.guildId;
      if (guildId === null) throw new Error("サーバー外で /job が呼ばれました");
      const subcommand = interaction.subcommand;
      if (subcommand !== "run" && subcommand !== "new") throw new Error(`/job の不明なサブコマンドです（${subcommand ?? ""}）`);
      // gh のログインの確認と #jobs への投稿で 3 秒を超えうるので、先に保留する
      await responder.defer(true);
      const instruction = stringOption(interaction.options.task);
      const issue = interaction.options.issue;
      const result =
        subcommand === "run"
          ? await jobs.accept({
              kind: "run",
              guildId,
              repo: stringOption(interaction.options.repo),
              instruction,
              ...(typeof issue === "number" ? { issueNumber: issue } : {}),
            })
          : await jobs.accept({ kind: "new", guildId, name: stringOption(interaction.options.name), instruction });
      if (!result.ok) {
        log(`/job を断りました（guild=${guildId}）`);
        await responder.reply({ text: result.reply, ephemeral: true });
        return;
      }
      await responder.reply({ text: acceptedReply(result.jobId), ephemeral: true });
    },
  };
}

/**
 * #jobs のボタンとモーダル（`job:`）:
 * [中断]（`job:abort:<run_id>`）は実行中の run がそれなら止めて deferUpdate（表示は進行の終わりに書き換わる）。
 * [もう一度]（`job:retry:<run_id>`）・[ここまでを draft PR に]（`job:push:<run_id>`）は状態の表で許されるときだけ始めてボタンを外す。
 * [続きを頼む]（`job:more:<job_id>`）はモーダルを開き、送られたら続きの run を作る。
 * 古ければ（状態が合わない・実行中でない・job が無い・閉じた）本人にだけ「この操作は古くなっています」
 */
export function createJobComponent(deps: JobCommandDeps): ComponentHandler {
  const { jobs, log } = deps;
  return {
    namespace: JOB_NAMESPACE,
    async handle(interaction, responder) {
      const [, action, idText] = interaction.customId.split(":");
      const id = idOf(idText);
      if (id === undefined) throw new Error("job の custom_id に番号がありません");
      const guildId = interaction.guildId;
      if (guildId === null) throw new Error("サーバー外で job の操作がありました");

      if (interaction.kind === "modal" && action === "more") {
        // 続きの run を作って #jobs に投稿するので先に保留する
        await responder.defer(true);
        const result = await jobs.continueJob(id, interaction.fields[JOB_MORE_FIELD_ID] ?? "");
        if (result === "stale") {
          await responder.reply({ text: STALE_TURN_REPLY, ephemeral: true });
          return;
        }
        if (!result.ok) {
          await responder.reply({ text: result.reply, ephemeral: true });
          return;
        }
        log(`[続きを頼む] でジョブの続きを受け付けました（guild=${guildId}）`);
        await responder.reply({ text: continuedReply(id), ephemeral: true });
        return;
      }
      if (interaction.kind !== "button") throw new Error(`job の不明な操作です（${interaction.kind} ${action ?? ""}）`);

      switch (action) {
        case "abort":
          if (!jobs.abort(id)) {
            await responder.reply({ text: STALE_TURN_REPLY, ephemeral: true });
            return;
          }
          log(`[中断] でジョブを中断しました（guild=${guildId}）`);
          await responder.deferUpdate();
          return;
        case "more":
          await responder.showModal(moreModal(id));
          return;
        case "retry":
        case "push": {
          // 新しい run の投稿で 3 秒を超えうるので、元メッセージを変えずに保留してから始める
          await responder.deferUpdate();
          const before = jobs.messageText(id);
          const result = action === "retry" ? await jobs.retry(id) : await jobs.pushHeld(id);
          if (result === "stale" || before === undefined) {
            await responder.reply({ text: STALE_TURN_REPLY, ephemeral: true });
            return;
          }
          log(`${action === "retry" ? "[もう一度]" : "[ここまでを draft PR に]"} でジョブを始めました（guild=${guildId}）`);
          // 押したメッセージのボタンを外す（結果は新しいメッセージで報告する）
          await responder.update({ text: before, components: [] });
          return;
        }
        default:
          throw new Error(`job の不明な操作です（button ${action ?? ""}）`);
      }
    },
  };
}
