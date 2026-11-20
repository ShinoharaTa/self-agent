// GitHub の通知の［対応］を、その PR・Issue ごとの話題（プロジェクトのセッション）にする（docs/plan/terminal-handover.md の H5。#428）。
// #github の［対応］（commands/github.ts の gh:act）と Web の GitHub のタブの［対応］（web/routes/github.ts）で、通知のリポジトリが
// ワークスペースの直下にあれば、そこを場所に startTopic（by github）で話題を作り、対応依頼のテンプレート（app/github-handoff.ts の handoffTemplate。
// 題名などの第三者の文字列は入れない）を最初の一言として送る。題名は handoffTitle（`GitHub PR 12` の形）。
// 同じスレッドの話題がまだ開いていれば（github_topics の新しい行・active か waiting・チャンネルがある）作らずにその話題を返す。
// 端末の Claude Code のセッションへ送る古い経路（GithubHandoff）はコードに残るが、配線していない。
// log は結果の種類と通知の行の番号だけ（リポジトリ名・題名・URL・チャンネル ID・プロジェクトの名前は出さない）
import { realpathSync } from "node:fs";
import { sep } from "node:path";
import type { GithubNotificationRow, GithubStore } from "../store/github.ts";
import type { GithubTopicStore } from "../store/github-topics.ts";
import type { TopicSessionStore } from "../store/topic-sessions.ts";
import { buildWorkspaceMap } from "../tmux/workspace-map.ts";
import { handoffRepo, handoffTarget, handoffTemplate, handoffTitle, startDirOf } from "./github-handoff.ts";
import type { StartTopicInput, StartTopicResult } from "./session-ops.ts";

/** ［対応］の結果 */
export type GithubTopicResult =
  /** 話題を作った。turn は最初の一言（対応依頼）を受け付けたか。overlapping は同じ場所で実行中の、ほかの話題の数 */
  | { kind: "created"; channelId: string; turn: "started" | "failed"; overlapping: number }
  /** 同じスレッドの話題がまだ開いている（作り直さない・送り直さない） */
  | { kind: "already"; channelId: string }
  /** そのリポジトリがワークスペースの直下に無い（話題を始める場所を決められない） */
  | { kind: "not_local"; repo: string }
  /** プロジェクトのセッションを使えない（SELF_AGENT_CC が無効・unify-setup が済んでいない） */
  | { kind: "not_ready" }
  /** /setup 済みのサーバーが無い */
  | { kind: "not_set_up" }
  | { kind: "failed" }
  /** 同じスレッドを処理している途中 */
  | { kind: "busy" }
  /** 通知が無い・［対応］を付けない行 */
  | { kind: "stale" };

export type GithubTopicDeps = {
  workspaceDir: string;
  /** 起動時に解決した git の絶対パス（地図の remote を読む） */
  gitPath: string;
  store: Pick<GithubStore, "getNotification">;
  topics: Pick<GithubTopicStore, "add" | "latestForThread">;
  topicSessions: Pick<TopicSessionStore, "get" | "projectDirOf">;
  channelExists: (channelId: string) => Promise<boolean>;
  /** サーバーの指定が無いとき（Web）に使う、/setup 済みのサーバー */
  setUpGuild: () => string | undefined;
  /** startTopic（session-ops.ts）に deps を付けたもの */
  start: (input: StartTopicInput) => Promise<StartTopicResult>;
  runningTurns: () => ReadonlyArray<{ channelId: string }>;
  now: () => Date;
  log: (message: string) => void;
  /** テストの差し替え（既定は buildWorkspaceMap） */
  map?: typeof buildWorkspaceMap;
};

/** 地図のディレクトリから話題の場所（プロジェクトの名前）を決める（純関数）。startDirOf がワークスペースの直下（1 段）を返すときだけその名前 */
export function topicProjectOf(dirs: readonly string[], workspaceRoot: string): string | undefined {
  const dir = startDirOf(dirs, workspaceRoot);
  return dir === undefined || dir.includes(sep) ? undefined : dir;
}

/**
 * 結果の文（純関数）。discord は行を改行で、web は「。」でつなぐ（web の末尾に句点を付けない）。
 * escape は第三者から来た文字列（リポジトリ名）に当てる（Discord は escapeDiscordText、Web は textContent で出すのでそのまま）
 */
export function topicResultText(result: GithubTopicResult, where: "discord" | "web", escape: (text: string) => string = (text) => text): string {
  const lines: string[] = [];
  switch (result.kind) {
    case "created":
      lines.push(where === "discord" ? `この通知の話題を作りました → <#${result.channelId}>` : "この通知の話題を作りました");
      if (result.turn === "failed") lines.push("最初の対応依頼は送れませんでした。その話題で頼み直してください");
      if (result.overlapping >= 1) lines.push(`同じ場所で実行中の話題: ${result.overlapping} 件`);
      break;
    case "already":
      lines.push(where === "discord" ? `この通知の話題はもうあります → <#${result.channelId}>` : "この通知の話題はもうあります");
      break;
    case "not_local":
      lines.push(`${where === "discord" ? escape(result.repo) : result.repo} は ~/workspace の直下にありません（話題を始める場所を決められません）`);
      break;
    case "not_ready":
      lines.push("プロジェクトのセッションの設定が済んでいません（SELF_AGENT_CC と unify-setup が要ります）");
      break;
    case "not_set_up":
      lines.push("先に /setup を実行してください");
      break;
    case "failed":
      lines.push("話題を作れませんでした。少し待ってからもう一度押してください");
      break;
    case "busy":
      lines.push("この通知の話題を作っている途中です");
      break;
    case "stale":
      lines.push("この操作は古くなっています");
      break;
  }
  return lines.join(where === "discord" ? "\n" : "。");
}

function realpathOr(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

export class GithubTopicHandoff {
  private readonly deps: GithubTopicDeps;
  /** 処理している途中のスレッド（同じスレッドの押下を重ねない） */
  private readonly inFlight = new Set<string>();

  constructor(deps: GithubTopicDeps) {
    this.deps = deps;
  }

  /** 地図にあって、ワークスペースの直下にあるリポジトリ（`owner/repo` の小文字。［対応］を付けるかの判定）。地図を作れなければ空 */
  async mappedRepos(): Promise<ReadonlySet<string>> {
    let map: Awaited<ReturnType<typeof buildWorkspaceMap>>;
    try {
      map = await this.buildMap();
    } catch {
      this.deps.log("GitHub の地図を作れませんでした");
      return new Set();
    }
    const root = realpathOr(this.deps.workspaceDir);
    const repos = new Set<string>();
    for (const [repo, dirs] of map.repos) if (topicProjectOf(dirs, root) !== undefined) repos.add(repo);
    return repos;
  }

  /** ［対応］: その通知の PR・Issue の話題を作り、対応依頼を最初の一言として送る。guildId は Discord で押したサーバー（Web は省いて /setup 済みのサーバー） */
  async act(notificationId: number, guildId?: string): Promise<GithubTopicResult> {
    const row = this.deps.store.getNotification(notificationId);
    if (row === undefined) {
      this.deps.log("GitHub の対応: stale");
      return { kind: "stale" };
    }
    const result = await this.handle(row, guildId);
    this.deps.log(`GitHub の対応: ${result.kind}（通知 #${row.id}）`);
    return result;
  }

  private buildMap(): ReturnType<typeof buildWorkspaceMap> {
    return (this.deps.map ?? buildWorkspaceMap)({ workspaceDir: this.deps.workspaceDir, gitPath: this.deps.gitPath, panes: [] });
  }

  private async handle(row: GithubNotificationRow, guildId: string | undefined): Promise<GithubTopicResult> {
    const target = handoffTarget(row);
    if (target === undefined) return { kind: "stale" };
    if (this.inFlight.has(row.threadId)) return { kind: "busy" };
    this.inFlight.add(row.threadId);
    try {
      const open = await this.openTopic(row.threadId);
      if (open !== undefined) return { kind: "already", channelId: open };
      const guild = guildId ?? this.deps.setUpGuild();
      if (guild === undefined) return { kind: "not_set_up" };
      let dirs: readonly string[];
      try {
        dirs = (await this.buildMap()).repos.get(handoffRepo(target)) ?? [];
      } catch {
        return { kind: "failed" };
      }
      const name = topicProjectOf(dirs, realpathOr(this.deps.workspaceDir));
      if (name === undefined) return { kind: "not_local", repo: handoffRepo(target) };
      const at = this.deps.now();
      let started: StartTopicResult;
      try {
        started = await this.deps.start({
          guildId: guild,
          title: handoffTitle(target),
          text: handoffTemplate(target),
          place: { kind: "project", name },
          by: "github",
          at,
        });
      } catch {
        return { kind: "failed" };
      }
      switch (started.result) {
        case "created":
          break;
        case "cc_disabled":
        case "unify_not_ready":
          return { kind: "not_ready" };
        case "invalid_project":
          return { kind: "not_local", repo: handoffRepo(target) };
        case "not_set_up":
          return { kind: "not_set_up" };
        default:
          return { kind: "failed" };
      }
      // 最初の一言を送れなくても話題はできているので、次の押下で作り直さないように記録する
      try {
        this.deps.topics.add({ notificationId: row.id, threadId: row.threadId, channelId: started.channelId, at });
      } catch {
        this.deps.log("GitHub の［対応］の話題を記録できませんでした");
      }
      return {
        kind: "created",
        channelId: started.channelId,
        turn: started.turn === "started" ? "started" : "failed",
        overlapping: this.overlapping(started.channelId, started.projectDir),
      };
    } finally {
      this.inFlight.delete(row.threadId);
    }
  }

  /** 同じスレッドの話題がまだ開いていればそのチャンネル。チャンネルを確かめられない（Discord の不調）ときはあるものとする */
  private async openTopic(threadId: string): Promise<string | undefined> {
    const latest = this.deps.topics.latestForThread(threadId);
    if (latest === undefined) return undefined;
    const session = this.deps.topicSessions.get(latest.channelId);
    if (session === undefined || (session.state !== "active" && session.state !== "waiting")) return undefined;
    let exists = true;
    try {
      exists = await this.deps.channelExists(latest.channelId);
    } catch {
      // 不調のたびに話題が二重にできないよう、ある方に倒す
    }
    return exists ? latest.channelId : undefined;
  }

  /** 作った話題と同じ場所で実行中の、ほかの話題の数（同じチャンネルは 1 つに数える） */
  private overlapping(channelId: string, projectDir: string | null): number {
    if (projectDir === null) return 0;
    const channels = new Set<string>();
    for (const turn of this.deps.runningTurns()) {
      if (turn.channelId === channelId || channels.has(turn.channelId)) continue;
      if (this.deps.topicSessions.projectDirOf(turn.channelId)?.projectDir === projectDir) channels.add(turn.channelId);
    }
    return channels.size;
  }
}
