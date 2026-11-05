// 配線だけ: config → store → runner → gateway → handler
import { mkdirSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { DiskQuota, pruneWorkDir } from "./agent/disk.ts";
import { pruneProjectTrash } from "./agent/project-files.ts";
import {
  defaultSandboxHost,
  ensureCwdDir,
  ensureGuestConfigDir,
  sandboxPlacesOf,
  projectDirNameFor,
} from "./agent/query-options.ts";
import { checkSandbox, missingSandboxBinaries, shellPath } from "./agent/sandbox-check.ts";
import { WEB_TEMPLATE_DIR } from "./agent/scaffold.ts";
import type { AgentRunner, RunContext } from "./agent/runner.ts";
import { SdkAgentRunner } from "./agent/sdk-runner.ts";
import { personaSystemPrompts } from "./agent/system-prompt.ts";
import { createTaskMcpServer } from "./agent/tools.ts";
import { createChannelResolver, logUnconfiguredGuilds } from "./app/access.ts";
import { prepareImages, pruneAttachments } from "./app/attachments.ts";
import { ChannelOpsQueue } from "./app/channel-ops.ts";
import { createHandler } from "./app/handler.ts";
import { InboxRotator } from "./app/inbox-rotate.ts";
import type { CcPermissionButtons } from "./app/commands/cc.ts";
import { createConfirmKbDelete } from "./app/commands/kb-delete.ts";
import { ccRcUrl, CcConfirmExpirer, type CcConfirmRuntime } from "./app/commands/cc-confirm.ts";
import { createCcTools } from "./app/cc-tools.ts";
import type { CcToolDeps } from "./agent/tools.ts";
import { createNotifyMemoryChange } from "./app/commands/memory-undo.ts";
import { GithubHandoff } from "./app/github-handoff.ts";
import { createCommands, createComponents, createInteractionHandler, registerCommands } from "./app/interactions.ts";
import { createTurnQueue, KeyedSerialQueue } from "./app/queue.ts";
import { ReminderScheduler } from "./app/reminders.ts";
import { Scheduler, TICK_INTERVAL_MS } from "./app/scheduler.ts";
import { PersonaStatus, startPersonaGateways } from "./app/persona-status.ts";
import { PersonaRouter, type PersonaRuntime } from "./app/personas.ts";
import { createOpenSession } from "./app/session-open.ts";
import { createShutdown } from "./app/shutdown.ts";
import { ShellState, shellRefresher } from "./app/shell-state.ts";
import { createSystemNotifier } from "./app/system-notice.ts";
import { formatDate, startOfLocalDay } from "./app/time.ts";
import { AgentsClient, resolveClaudePath, resolveTmuxPath } from "./cc/agents.ts";
import { ClaudeDirs } from "./cc/claude-dirs.ts";
import { CcChannels, ccEndedHandler, ccPermissionAnsweredHandler, routeCcChannelMessages } from "./cc/channels.ts";
import { CcChannelPosts } from "./cc/channel-posts.ts";
import { CcDiscordNotifier, CcWaitBudget } from "./cc/discord-notice.ts";
import { createCcHookServer, type CcHookServer } from "./cc/hook-server.ts";
import { CcPaneResolver, procParentPid } from "./cc/panes.ts";
import { CcPermissionHold } from "./cc/permission-hold.ts";
import { CcRegistry } from "./cc/registry.ts";
import { CcReplier } from "./cc/replies.ts";
import { CcSender } from "./cc/sender.ts";
import { CcStarter, procMemAvailable } from "./cc/starter.ts";
import { DEFAULT_PERSONA_ID, loadConfig, missingForStart } from "./config.ts";
import { createDevLogSink, devLogDir, pruneDevLogs } from "./devlog/log.ts";
import { DiscordGateway } from "./discord/discord-gateway.ts";
import { GhClient, resolveCommandPath, resolveGhPath } from "./github/gh.ts";
import { createGithubPoller } from "./github/poller.ts";
import { GUEST_TURNS_KEEP_DAYS } from "./guest/constants.ts";
import { createGuestLayer } from "./guest/index.ts";
import { createGuestRunner } from "./guest/query-options.ts";
import { GitClient } from "./jobs/git.ts";
import { JobGithubApi } from "./jobs/github-api.ts";
import { JobOrchestrator, jobPaths, removeVerifiedChild } from "./jobs/orchestrator.ts";
import { createStaticServer, type StaticServer } from "./serve/static-server.ts";
import { AttachmentStore } from "./store/attachments.ts";
import { ChannelSeedStore } from "./store/channel-seeds.ts";
import { GithubStore } from "./store/github.ts";
import { GuestStore } from "./store/guest.ts";
import { GuestGuildStore } from "./store/guest-guilds.ts";
import { GuestInviteStore } from "./store/guest-invites.ts";
import { acquireDataLock, type DataLock } from "./store/data-lock.ts";
import { CC_CHANNEL_KEEP_DAYS, CcChannelStore } from "./store/cc-channels.ts";
import { CC_PERMISSION_KEEP_DAYS, type CcPermissionRow, CcPermissionStore } from "./store/cc-permissions.ts";
import { CC_REPLY_KEEP_DAYS, CcReplyStore } from "./store/cc-replies.ts";
import { CC_SEND_KEEP_DAYS, CcSendStore } from "./store/cc-sends.ts";
import { CC_SESSION_KEEP_DAYS, CcSessionStore } from "./store/cc-sessions.ts";
import { CC_START_KEEP_DAYS, CcStartStore } from "./store/cc-starts.ts";
import { backupBeforeMigration, openDb } from "./store/db.ts";
import { GuildSettingsStore } from "./store/guild-settings.ts";
import { HistoryStore } from "./store/history.ts";
import { InboxSummaryStore } from "./store/inbox-summaries.ts";
import { JobStore } from "./store/jobs.ts";
import { KnowledgeStore } from "./store/knowledge.ts";
import { MemoryStore } from "./store/memories.ts";
import { NOTICE_KEEP_DAYS, NoticeStore } from "./store/notices.ts";
import { ProjectStore } from "./store/projects.ts";
import { ReminderStore } from "./store/reminders.ts";
import { RoutineRecordStore } from "./store/routine-records.ts";
import { RoutineStore } from "./store/routines.ts";
import { SdkSessionStore } from "./store/sdk-sessions.ts";
import { TaskStore } from "./store/tasks.ts";
import { TopicSessionStore } from "./store/topic-sessions.ts";
import { UsageStore } from "./store/usage.ts";
import { createTmux, type Tmux } from "./tmux/tmux.ts";
import { ccChannelDescriber, ccRoutes, ccStatus, type CcStatus } from "./web/routes/cc.ts";
import { channelRoutes, webChannelLookup, webChannelNamer } from "./web/routes/channels.ts";
import { devlogRoutes } from "./web/routes/devlog.ts";
import { githubRoutes } from "./web/routes/github.ts";
import { knowledgeRoutes } from "./web/routes/knowledge.ts";
import { memoryRoutes } from "./web/routes/memories.ts";
import { noticeRoutes } from "./web/routes/notices.ts";
import { projectRoutes } from "./web/routes/projects.ts";
import { reminderRoutes } from "./web/routes/reminders.ts";
import { sessionRoutes } from "./web/routes/sessions.ts";
import { statusRoutes } from "./web/routes/status.ts";
import { taskRoutes } from "./web/routes/tasks.ts";
import { turnRoutes } from "./web/routes/turns.ts";
import { usageRoutes } from "./web/routes/usage.ts";
import { createWebServer, type WebServer } from "./web/server.ts";
import { readPackageVersion } from "./web/version.ts";

const config = loadConfig();

const missing = missingForStart(config);
if (missing.length > 0) {
  console.error(`起動に必要な環境変数が設定されていません: ${missing.join(", ")}`);
  process.exit(1);
}

// Claude Code のセッション（SELF_AGENT_CC=1 のときだけ）: claude と tmux の絶対パスを 1 回解決する（子に渡すのと同じ固定の PATH（claude は ~/.local/bin が先）、
// 無ければ PATH）。無ければ起動しない
const ccClaudePath = config.cc ? resolveClaudePath() : undefined;
const ccTmuxPath = config.cc ? resolveTmuxPath() : undefined;
if (config.cc && (ccClaudePath === undefined || ccTmuxPath === undefined)) {
  console.error("SELF_AGENT_CC=1 には claude と tmux が要ります（~/.local/bin・/usr/local/bin・/usr/bin と PATH を確かめてください）");
  process.exit(1);
}

// 人格ごとのシステムプロンプト。足した人格の文のファイルは起動時に 1 回読み、読めない・空なら変数名を出して起動しない
// （既定の人格は今の SYSTEM_PROMPT。SELF_AGENT_SHELL=1 なら Bash の行を足したもの）
let systemPrompts: Map<string, string>;
try {
  systemPrompts = personaSystemPrompts(config.personas, undefined, config.shell);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}

// 二重起動の防止: 同じ DB を 2 プロセスが使うと同じ発言に 2 回答えるので、<dataDir>/lock を取れなければ起動しない。終了するときに外す
let dataLock: DataLock;
try {
  dataLock = acquireDataLock(config.dataDir);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
process.on("exit", () => dataLock.release());

mkdirSync(config.workDir, { recursive: true });
// CLI の cwd（<workDir>/cwd。空の専用ディレクトリ）。symlink・ファイルなら起動しない（#139）
try {
  ensureCwdDir(config.workDir);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
// 会話の記録の場所を今までの名前に固定できない（パスが長すぎる）と、既存のセッションを resume できないことがある
if (projectDirNameFor(config.workDir) === undefined) {
  console.error("会話の記録の場所を固定できません（SELF_AGENT_WORKDIR のパスが長すぎます）。既存のセッションは resume できないことがあります");
}
mkdirSync(config.claudeConfigDir, { recursive: true });
// ゲストの子プロセスの設定ディレクトリ（<claudeConfigDir>-guest。オーナーの設定ディレクトリを見せない）。symlink・ファイルなら起動しない
if (config.guest) {
  try {
    ensureGuestConfigDir(config.claudeConfigDir);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}

const now = (): Date => new Date();
const log = (message: string): void => console.error(message);
// 移行するなら、先に移行前の DB の控えを <dataDir>/self-agent.db.v<版>.bak に取る
const dbPath = join(config.dataDir, "self-agent.db");
await backupBeforeMigration(dbPath, log);
const db = openDb(dbPath);
const tasks = new TaskStore(db, now);
const sessions = new SdkSessionStore(db, now);
const usage = new UsageStore(db, now);
const guildSettings = new GuildSettingsStore(db, now);
const topicSessions = new TopicSessionStore(db, now);
const seeds = new ChannelSeedStore(db, now);
const inboxSummaries = new InboxSummaryStore(db, now);
const knowledge = new KnowledgeStore(db, now);
const memories = new MemoryStore(db, now);
const projects = new ProjectStore(db, now);
const reminders = new ReminderStore(db, now);
// 定型チャンネル（docs/plan/routines.md）。使うのは R2 以降
const routines = new RoutineStore(db, now);
const routineRecords = new RoutineRecordStore(db, now);
// オーナーの発言の画像の原本（<dataDir>/attachments/ に置く）
const attachments = new AttachmentStore(db, now);
// Web UI で会話を見るためのターンの記録（docs/plan/web-ui.md §4.2）。書くのは Web UI が有効なときだけで、古いものは有効・無効を問わず tick で消す
const historyStore = new HistoryStore(db, now);
const history = config.web ? { history: historyStore } : {};
// #system への知らせの記録（docs/plan/web-ui.md §7.1）。書くのは Web UI が有効なときだけで、古いものは有効・無効を問わず tick で消す
const noticeStore = new NoticeStore(db, now);
const notices = config.web ? noticeStore : undefined;
// この機械の Claude Code のセッション（docs/plan/claude-code-sessions.md §9）。書くのは SELF_AGENT_CC=1 のときだけで、古い行は有効・無効を問わず tick で消す
const ccSessions = new CcSessionStore(db, now);
const ccSends = new CcSendStore(db, now);
const ccPermissionStore = new CcPermissionStore(db, now);
// GitHub の通知のスレッド・出来事・ポーリングの状態（SELF_AGENT_GITHUB=1 のときだけ書く。古い行は tick で消す）
const githubStore = new GithubStore(db, now);
// cc_start の起動の確認（CC7）
const ccStarts = new CcStartStore(db, now);
// Claude Code の返事を Discord に戻した記録（CC8。本文は持たない）
const ccReplies = new CcReplyStore(db, now);
// Claude Code のセッションの Discord のチャンネル（CC10。docs/plan/claude-code-channels.md）。作る・終わった・戻ったは下の CcChannels
const ccChannelStore = new CcChannelStore(db, now);
// 再起動の前の [起動して続ける]（resuming）は起動を追えないので、終わったままに戻す（CC13）
{
  const reset = ccChannelStore.resetResuming();
  if (reset > 0) log(`Claude Code: 起動中のまま残ったチャンネル ${reset} 件を終わったままに戻しました`);
}
// SELF_AGENT_CC=1 で連携が動くときだけ下で作る（/cc・cc:pick・再同期・Web は呼ぶときに読む）
let ccChannels: CcChannels | undefined;
/** 許可の要求に答えた後（Web・Discord）: そのセッションのチャンネルを作る（guildId を省けば最初の /setup 済みのサーバー。待たない・投げない） */
const ccPermissionAnswered = ccPermissionAnsweredHandler({ permissions: ccPermissionStore, channels: () => ccChannels, log });
// ゲストのチャンネルと 1 日のターン数（SELF_AGENT_GUEST_* が揃ったときだけ使う）
const guestStore = new GuestStore(db, now);
// ゲストのサーバーと許可の状態（guest_guilds）
const guestGuilds = new GuestGuildStore(db);
// ゲストのサーバーの認証コード（guest_invites）。使ったときにサーバーを許可し、チャンネルを有効にする
const guestInvites = new GuestInviteStore(db, { guilds: guestGuilds, channels: guestStore });

// 作ったプロジェクトの場所。権限ルール（<realpath(workDir)>/projects）と同じ実際の場所にする
const realWorkDir = realpathSync(config.workDir);
const projectsDir = join(realWorkDir, "projects");
// 書き込みの前の容量の判定（workDir の空きと、プロジェクトごとに 60 秒キャッシュした大きさ）
const diskQuota = new DiskQuota({ workDir: realWorkDir, projectsDir, now });

// 人格ごとの Bot（docs/plan/personas.md）。既定の人格は DISCORD_TOKEN で、管理の操作（カテゴリ・チャンネル・ピン留め・#system・再同期・コマンドの登録）もこの Bot が行う。
// 足した人格は SELF_AGENT_PERSONA_<ID>_DISCORD_TOKEN（値は start で読む）で、自分のチャンネルの返事・途中経過・ボタンだけを投稿する
const gateway = new DiscordGateway(config.allowedGuildIds);
// #system への知らせ（シェルの状態・人格の Bot の接続・GitHub の取得の失敗・削除の確認・ゲスト）は既定の人格の Bot で、notices に記録してから投稿する
const notify = createSystemNotifier({ guildSettings, gateway, notices, log });
const personaGateways = config.personas.map((persona) => ({
  persona,
  gateway: new DiscordGateway(config.allowedGuildIds, { persona: persona.id, tokenEnv: persona.discordTokenEnv }),
}));
const resolveChannel = createChannelResolver(config, guildSettings, topicSessions);
// /setup・/new・session_open 専用のキュー（ターンの同時実行枠とは分ける）
const layoutQueue = new KeyedSerialQueue(1);
// project_open: 配信が無効（設定が無い・待ち受けに失敗した）なら not_configured（staticServer は下で作る）。
// project_files: このチャンネルのプロジェクトのファイルを .trash に移す・移す・作り直す・戻す
const projectTools = {
  projects,
  projectsDir,
  publicBaseUrl: config.publicBaseUrl,
  serving: () => staticServer?.listening() ?? false,
  // shellState は下で作る（project_open のときに読む）。使えるなら注意に Bash の使い方を入れる
  shellEnabled: () => shellState.enabled(),
  log,
  now,
};
// リマインドのツール（reminder_set・reminder_list・reminder_cancel）と task_list の remind
const reminderTools = { reminders, log, now };
// dev モードなら run ごとの会話を <dataDir>/devlog/<日付>.jsonl に残す（dev モードでなければ受け口を作らない）
const devLogSink = createDevLogSink(config);
if (devLogSink !== undefined) log(`dev モード: 会話を記録します（${config.devLogDays} 日で消します）`);
// ツールのハンドラには run ごとのチャンネル（context）を渡す。ツール定義は毎回同じ（全人格で共通）。
// ファイル操作は run ごとの hook で <workDir>/projects の中（書き込みはそのチャンネルのプロジェクトの中で、容量の上限まで）に絞る。
// SELF_AGENT_SHELL=1 なら Bash もツールに入れ、run ごとの hook でセッションのチャンネルのプロジェクトがあるときだけ通す（sandbox は自己診断が通っていて
// bwrap・socat がある run だけに付ける。shellAvailable は run の前に呼ぶ）。openSession・kbMemory・shellState・ccTools は下で作る（run のときに読む）。
// Claude Code のツール（cc_list・cc_send・cc_start）は SELF_AGENT_CC が無効でも定義し、ccTools が無ければ not_available を返す
const createMcpServer = (context?: RunContext) =>
  createTaskMcpServer(tasks, topicSessions, openSession, kbMemory, projectTools, reminderTools, context, ccTools);
const runnerFiles = { projects, projectsDir, disk: diskQuota };
const runnerDevLog = devLogSink === undefined ? undefined : { sink: devLogSink, now };
const runnerConfig = { ...config, shellAvailable: () => shellState.enabledForRun() };
const runner = new SdkAgentRunner(runnerConfig, createMcpServer, runnerFiles, log, undefined, runnerDevLog);
// 足した人格の runner: システムプロンプトはその人格のもの、model・effort はその人格の設定（無ければ既定の人格と同じ）。
// codex のエンジンはまだ無いので、codex の人格も既定の人格の Claude の model・effort で動かす（usage のエンジンは claude）
if (config.personas.some((persona) => persona.engine === "codex")) {
  log("codex のエンジンはまだ無いため、codex の人格も Claude で動かします");
}
const personaRuntimes: PersonaRuntime[] = [
  { id: DEFAULT_PERSONA_ID, name: DEFAULT_PERSONA_ID, engine: "claude", runner, gateway, connected: () => gateway.connected() },
  ...personaGateways.map(({ persona, gateway: personaGateway }): PersonaRuntime => {
    const modelAndEffort =
      persona.engine === "claude"
        ? { model: persona.model ?? config.model, effort: persona.effort ?? config.effort }
        : { model: config.model, effort: config.effort };
    // personaSystemPrompts は設定したすべての人格の分を作る。無ければ既定の人格のプロンプトに黙って戻さずに止める
    const systemPrompt = systemPrompts.get(persona.id);
    if (systemPrompt === undefined) throw new Error(`人格 ${persona.id} のシステムプロンプトがありません`);
    const personaRunner = new SdkAgentRunner(
      { ...runnerConfig, ...modelAndEffort, systemPrompt, persona: persona.id },
      createMcpServer,
      runnerFiles,
      log,
      undefined,
      runnerDevLog,
    );
    return {
      id: persona.id,
      name: persona.name,
      engine: "claude",
      runner: personaRunner,
      gateway: personaGateway,
      connected: () => personaGateway.connected(),
    };
  }),
];
// チャンネルの持ち主の人格（persona_channels・sessions.persona）への振り分け。返事などは持ち主の Bot（ownerPosts）、管理の操作は既定の人格の Bot（gateway）
const personas = new PersonaRouter({ personas: personaRuntimes, guildSettings, topicSessions });
const ownerPosts = personas.ownerPosts();
// #inbox・#<NAME> の session_open: /new と同じキュー（layoutQueue）で作る。作るセッションの持ち主は呼ばれたチャンネルの持ち主の人格で、最初の投稿はその人格の Bot
const openSession = createOpenSession({
  cfg: config,
  resolveChannel,
  gateway,
  personas,
  guildSettings,
  topicSessions,
  seeds,
  queue: layoutQueue,
  now,
  log,
});
// ナレッジベースと記憶のツール: kb_delete の確認と記憶の変更の知らせは run のチャンネルに、その持ち主の Bot で投稿する
const kbMemory = {
  knowledge,
  memories,
  confirmKbDelete: createConfirmKbDelete({ gateway: ownerPosts }),
  notifyMemoryChange: createNotifyMemoryChange({ gateway: ownerPosts, log }),
  timeZone: config.timeZone,
};
// 発言と /close・/renew のターンのキュー（key は channelId）。SELF_AGENT_SHELL=1 ならセッションのジョブは同時に 1 つだけ
const turnQueue = createTurnQueue(config);
// ターンはチャンネルの持ち主の人格の runner で動かす（personas）
const turn = { runner, personas, sessions, seeds, topicSessions, inboxSummaries, memories, usage, log };
const channelOps = new ChannelOpsQueue({
  gateway,
  guildSettings,
  topicSessions,
  gapMs: config.channelOpGapMs,
  log,
});
// セッションのチャンネルのターンには途中経過と [中断] を付け、手順の上限で止まったら [続ける] を付ける。
// 発言はチャンネルの持ち主の Bot が受け取った分だけを受け付け、返信・途中経過・入力中表示もその Bot で行う。
// 発言の画像はキューの中で取り、そのターンに渡して原本を <dataDir>/attachments/ に置く。
// Web からの発言は持ち主の Bot が接続しているときだけ受け付け、その Bot で「（Web から）」を投稿してから同じ経路で 1 ターン入れる
const handler = createHandler({
  cfg: config,
  resolveChannel,
  ...turn,
  gateway: ownerPosts,
  channelOps,
  queue: turnQueue,
  now,
  prepareImages: (source, images) => prepareImages({ dataDir: config.dataDir, attachments, log }, source, images),
  ...history,
  ownerConnected: (channelId) => personas.ownerConnected(channelId),
  // lifecycle は下で作る（Web からの発言のときに読む）
  stopping: () => lifecycle.stopping(),
});
// #inbox・#tasks の切り替え: 要約のターンは発言と同じキュー（turnQueue、key はそのチャンネルの channelId）で行う。
// 定期処理と、#inbox・#tasks での /renew で使う
const inboxRotator = new InboxRotator({
  cfg: config,
  guildSettings,
  inboxSummaries,
  turnQueue,
  turn,
  gateway: ownerPosts,
  ...history,
  now,
  log,
});
// 作業ジョブ（docs/plan/coding-jobs.md。SELF_AGENT_JOBS=1 のときだけ）: /job・#jobs のボタンで頼み、turnQueue の key `job`（セッションのジョブ）で
// 準備 → run → 取り込み → 検査 → push → draft PR まで進め、#jobs に既定の人格の Bot で報告する。git・gh は起動時に PATH から 1 回解決する。
// PR-J4 で入れる: ジョブ用の runner（§3 の Options の SdkAgentRunner）。それまで SELF_AGENT_JOBS=1 は設定エラーなので、ここは通らない
const jobRunner: AgentRunner | undefined = undefined;
const createJobs = (runner: AgentRunner | undefined): JobOrchestrator => {
  if (runner === undefined) throw new Error("作業ジョブの runner がまだありません（PR-J4）");
  const jobGhPath = resolveGhPath();
  const gitPath = resolveCommandPath("git");
  if (jobGhPath === undefined || gitPath === undefined) {
    console.error("SELF_AGENT_JOBS=1 には gh と git が要ります（PATH を確かめてください）");
    process.exit(1);
  }
  return new JobOrchestrator({
    cfg: config,
    workDir: realWorkDir,
    dataDir: realpathSync(config.dataDir),
    jobs: new JobStore(db, now),
    guildSettings,
    usage,
    queue: turnQueue,
    runner,
    // 隔離の場所（<workDir>/jobs/quarantine-<run_id>.git）は <workDir>/jobs の直下と確かめてから消す
    git: new GitClient({
      gitPath,
      ghPath: jobGhPath,
      log,
      removeTree: (path) => removeVerifiedChild(jobPaths(realWorkDir, config.dataDir).root, path),
    }),
    github: new JobGithubApi({ ghPath: jobGhPath }),
    gateway,
    // shellState は下で作る（run の準備のときに読む）
    shellEnabled: () => shellState.enabled(),
    now,
    log,
  });
};
const jobs = config.jobs ? createJobs(jobRunner) : undefined;
// ゲスト利用の簡易モード（docs/plan/guest-mode.md。SELF_AGENT_GUEST_* が揃ったときだけ）。ゲスト Bot はここで作り、既定の人格の Bot のコマンド登録の後に
// 待たずに start する（下）。停止では、受け付けた /guest の処理とゲストのターン（返事まで）を待ってからゲスト Bot も止める。
// ターンは API キーで動くゲスト専用の runner（ツールなし・dev ログなし）と専用のキューで行う。
// 参加・有効化・無効化・外されたときの知らせは既定の人格の Bot で #system に出す。/guests（admin）は既定の人格の Bot のコマンドに足す
const guest = config.guest
  ? createGuestLayer({
      cfg: config,
      guest: guestStore,
      guilds: guestGuilds,
      invites: guestInvites,
      sessions,
      runner: createGuestRunner({ cfg: config, log }),
      usage,
      notify,
      now,
      log,
    })
  : undefined;
// コマンドは既定の人格のアプリだけが登録して受ける。/close・/renew のターンはチャンネルの持ち主の人格で動かし、結果は持ち主の Bot が投稿する
const commands = createCommands({
  cfg: config,
  gateway,
  personas,
  guildSettings,
  topicSessions,
  queue: layoutQueue,
  channelOps,
  tasks,
  usage,
  attachments,
  projects,
  projectsDir,
  turnQueue,
  turn,
  inboxRotator,
  reminders,
  // /job（SELF_AGENT_JOBS=1 のときだけ登録する）
  ...(jobs === undefined ? {} : { jobs }),
  // /guests（ゲストが有効のときだけ登録する。メインサーバーでオーナーが認証コードの発行・許可の取り消し・一覧を行う）
  ...(guest === undefined ? {} : { guests: guest.admin }),
  // /close の確定と /renew の区切りの行（Web UI が有効なときだけ）
  ...history,
  // /cc（SELF_AGENT_CC=1 のときだけ登録する。チャンネルの操作は下で作る）
  ...(config.cc ? { ccChannels: () => ccChannels } : {}),
  log,
});
// GitHub の通知の [対応]（下の Claude Code の配線の後で作る。ボタンは押されたときに読む）
let githubHandoff: GithubHandoff | undefined;
const handleInteraction = createInteractionHandler({
  cfg: config,
  commands,
  // ホームパネルの [新しいセッション] は /new と同じキュー（layoutQueue）で作る。[中断]・[続ける] は発言の handler に渡す
  components: createComponents({
    cfg: config,
    resolveChannel,
    turns: handler,
    gateway,
    personas,
    guildSettings,
    topicSessions,
    sessions,
    seeds,
    queue: layoutQueue,
    tasks,
    knowledge,
    memories,
    projects,
    projectsDir,
    channelOps,
    turnQueue,
    turn,
    reminders,
    // cc_send・cc_start の確認のボタン（cc:）。送信・起動は SELF_AGENT_CC=1 のときだけ下で作る（押したときに読む）。書き換えは確認を投稿した持ち主の Bot
    ccSends,
    ccStarts,
    ccSessions,
    // 返事の投稿の [追いかけをやめる]（cc:unfollow。DB だけで動く）
    ccFollow: { replies: ccReplies, sessions: ccSessions },
    ccRuntime: () => ccRuntime,
    ccPosts: ownerPosts,
    // /cc open のセレクト（cc:pick）と終わったチャンネルの [起動して続ける]（cc:resume）
    ccChannels: () => ccChannels,
    // Claude Code のチャンネルの削除の確認の [削除する][残す]（cc:del。DB だけで動く）
    ccDelete: { deleteAfterDays: config.deleteAfterDays, store: ccChannelStore, gateway, channelOps },
    // #jobs のボタンとモーダル（SELF_AGENT_JOBS=1 のときだけ）
    ...(jobs === undefined ? {} : { jobs }),
    // #system の許可の要求のボタン（SELF_AGENT_CC=1 で SELF_AGENT_CC_NOTIFY が 1 のときだけ。下で作る）
    ccPermissionButtons: () => ccPermissionButtons,
    // #github の [対応]（SELF_AGENT_GITHUB と SELF_AGENT_CC のときだけ。送り込みは下で作る）
    ...(config.github && config.cc ? { githubHandoff: () => githubHandoff } : {}),
    // /close の確定の区切りの行（Web UI が有効なときだけ）
    ...history,
    log,
  }),
  log,
});
// シェル（Bash）を使えるか（docs/plan/shell.md §4）。SELF_AGENT_SHELL=1 のときだけ起動時と tick ごとに自己診断し、結果が変わったら log に、通る・通らないが変わったら #system に出す。
// 各 run の前には bwrap・socat の有無だけを確かめ直す（無ければその run に sandbox を付けず、通らないに変える）。
// 秘密の場所と読める場所は Options.sandbox と同じ関数（sandboxPlacesOf）から作る
const shellState = new ShellState({
  cfg: config,
  check: () =>
    checkSandbox({
      pathEnv: shellPath(process.execPath),
      ...sandboxPlacesOf(config, defaultSandboxHost()),
    }),
  missingBinaries: () => missingSandboxBinaries(shellPath(process.execPath)),
  notify,
  log,
});
// 足した人格の Bot のうち、起動時のログインが終わった（成功・失敗・時間切れ）もの。終わる前は接続の知らせを出さない
const loginSettled = new Set<string>();
// 足した人格の Bot の接続（docs/plan/personas.md §2.2）。起動直後と tick ごとに確かめ、接続できない・戻ったが変わったら #system に知らせる
const personaStatus =
  personaGateways.length === 0
    ? undefined
    : new PersonaStatus({
        cfg: config,
        personas: personaGateways.map(({ persona, gateway: personaGateway }) => ({
          id: persona.id,
          name: persona.name,
          connected: () => personaGateway.connected(),
          loginSettled: () => loginSettled.has(persona.id),
        })),
        notify,
        log,
      });
// 定期処理: SELF_AGENT_SHELL=1 ならシェルの自己診断をやり直し、セッションの状態と Discord の親カテゴリのずれを直し、発言の無い進行中のセッションを待ちに移し、
// 完了から日数の経ったセッションの削除を #system で確認し、古い dev ログ（dev モードでなくても）とプロジェクトの古い .trash、workDir の古い .tmp と大きくなった .cache、
// 記録に結びついていない古い添付を消し、#inbox・#tasks の会話を切り替える
const scheduler = new Scheduler({
  cfg: config,
  topicSessions,
  guildSettings,
  sessions,
  seeds,
  channelOps,
  gateway,
  // 削除の確認（#system）
  notify,
  // 待ちに移した知らせはチャンネルの持ち主の Bot で出す
  personas,
  inboxRotator,
  pruneDevLogs: () => pruneDevLogs(devLogDir(config.dataDir), now(), config.timeZone, config.devLogDays),
  pruneProjectTrash: () => pruneProjectTrash(projectsDir, now()),
  refreshShell: shellRefresher(config, shellState),
  ...(personaStatus === undefined ? {} : { refreshPersonas: () => personaStatus.refresh() }),
  pruneWorkDir: () => pruneWorkDir(realWorkDir),
  pruneAttachments: () => pruneAttachments(config.dataDir, attachments),
  // SELF_AGENT_WEB_HISTORY_DAYS 日より前のターンの記録を消す（Web UI が無効でも消す）
  pruneHistory: () => {
    const deleted = historyStore.prune(new Date(now().getTime() - config.webHistoryDays * 24 * 60 * 60 * 1000));
    if (deleted > 0) log(`古いターンの記録 ${deleted} 件を消しました`);
  },
  // NOTICE_KEEP_DAYS 日より前の #system への知らせの記録を消す（Web UI が無効でも消す）
  pruneNotices: () => {
    const deleted = noticeStore.prune(new Date(now().getTime() - NOTICE_KEEP_DAYS * 24 * 60 * 60 * 1000));
    if (deleted > 0) log(`古い知らせの記録 ${deleted} 件を消しました`);
  },
  // 一覧から消えて CC_SESSION_KEEP_DAYS 日経った Claude Code のセッションの行と、CC_SEND_KEEP_DAYS 日より前の終わった送信の行、
  // CC_PERMISSION_KEEP_DAYS 日より前の終わった許可の要求の行を消す（SELF_AGENT_CC が無効でも消す）
  pruneCcSessions: () => {
    const deleted = ccSessions.prune(new Date(now().getTime() - CC_SESSION_KEEP_DAYS * 24 * 60 * 60 * 1000));
    if (deleted > 0) log(`古い Claude Code のセッションの記録 ${deleted} 件を消しました`);
    const deletedSends = ccSends.prune(new Date(now().getTime() - CC_SEND_KEEP_DAYS * 24 * 60 * 60 * 1000));
    if (deletedSends > 0) log(`古い Claude Code への送信の記録 ${deletedSends} 件を消しました`);
    const deletedPermissions = ccPermissionStore.prune(new Date(now().getTime() - CC_PERMISSION_KEEP_DAYS * 24 * 60 * 60 * 1000));
    if (deletedPermissions > 0) log(`古い Claude Code の許可の要求の記録 ${deletedPermissions} 件を消しました`);
    const deletedStarts = ccStarts.prune(new Date(now().getTime() - CC_START_KEEP_DAYS * 24 * 60 * 60 * 1000));
    if (deletedStarts > 0) log(`古い Claude Code の起動の確認の記録 ${deletedStarts} 件を消しました`);
    const deletedReplies = ccReplies.prune(new Date(now().getTime() - CC_REPLY_KEEP_DAYS * 24 * 60 * 60 * 1000));
    if (deletedReplies > 0) log(`古い Claude Code の返事の記録 ${deletedReplies} 件を消しました`);
    const deletedChannels = ccChannelStore.prune(new Date(now().getTime() - CC_CHANNEL_KEEP_DAYS * 24 * 60 * 60 * 1000));
    if (deletedChannels > 0) log(`削除済みの Claude Code のチャンネルの記録 ${deletedChannels} 件を消しました`);
  },
  // 待ちに移した知らせの行（Web UI が有効なときだけ）
  ...history,
  // Claude Code のチャンネルの再同期（SELF_AGENT_CC=1 のときだけ。連携が動いていなければ何もしない）
  ...(config.cc
    ? {
        ccChannels: { reconcile: (guildId, parents, listedAt, limit) => ccChannels?.reconcile(guildId, parents, listedAt, limit) ?? 0 },
        // 終わってから SELF_AGENT_DELETE_AFTER_DAYS 日経った Claude Code のチャンネルの削除の確認（CC13）
        ccDeletes: ccChannelStore,
      }
    : {}),
  // ゲストの 1 日のターン数のうち、GUEST_TURNS_KEEP_DAYS 日より前の日の行を消す（ゲストのときだけ。Discord のゲストのサーバーには触らない）
  ...(config.guest
    ? {
        pruneGuestTurns: () =>
          guestStore.pruneTurns(formatDate(startOfLocalDay(now(), config.timeZone, GUEST_TURNS_KEEP_DAYS), config.timeZone)),
      }
    : {}),
  // .trash・.tmp・.cache の削除は発言と同じキューにセッションのジョブとして入れる（セッションのジョブが実行中ならその tick では消さない）
  turnQueue,
  now,
  log,
});

// リマインドの発火: 分の境目にそろえた 1 分ごとの tick で、時刻の来たリマインドをオーナーをメンションして投稿する。
// 予約した依頼（prompt）のターンは発言と同じキュー（turnQueue、key は #inbox・#tasks の channelId）で行う。投稿はそのチャンネルの持ち主の Bot で行う
const reminderScheduler = new ReminderScheduler({
  cfg: config,
  reminders,
  tasks,
  guildSettings,
  topicSessions,
  gateway: { ...ownerPosts, channelExists: (channelId) => gateway.channelExists(channelId) },
  // 足した人格の Bot が接続していない・投稿に失敗したら、既定の人格の Bot で #tasks・#inbox に出す
  personas,
  resolveChannel,
  turnQueue,
  turn,
  // 予約した依頼の依頼と返事の行（Web UI が有効なときだけ）
  ...history,
  now,
  log,
});

// Claude Code のセッション（docs/plan/claude-code-sessions.md。SELF_AGENT_CC=1 のときだけ）: claude agents --json を周期で読んで cc_sessions に書き、
// hook の受け口（127.0.0.1:SELF_AGENT_CC_HOOK_PORT。Web UI とは別のサーバー）で事象を受ける。Web から送る本文は cc_sends に積み、
// 入力待ちのときだけ tmux で貼る（cc/sender.ts。待ち行列は 30 秒ごと）。Web から新しいセッションを SELF_AGENT_WORKSPACE_DIR の直下に起動する（cc/starter.ts）。
// 許可の要求は応答を保留し、Web と #system の [許可]・[このセッションでは常に許可]・[拒否] で返す（cc/permission-hold.ts）。
// SELF_AGENT_CC_NOTIFY が 1 なら、許可の要求・判断待ち・self-agent が起動したセッションの終了を #system に出す（cc/discord-notice.ts）。
// Claude Code のチャンネルが開いているセッションの許可の要求・判断待ちと端末・RC からの指示の写しは、SELF_AGENT_CC_NOTIFY によらずそのチャンネルに出す（cc/channel-posts.ts。CC12）
let ccRegistry: CcRegistry | undefined;
let ccNotifier: CcDiscordNotifier | undefined;
let ccChannelPosts: CcChannelPosts | undefined;
let ccPermissionButtons: CcPermissionButtons | undefined;
// 再起動の前に保留していて expired にした許可の要求（#system の 1 通を「時間切れ」に書き換える）
let ccRecoveredPermissions: CcPermissionRow[] = [];
let ccSender: CcSender | undefined;
let ccStarter: CcStarter | undefined;
let ccPermissions: CcPermissionHold | undefined;
let ccHookServer: CcHookServer | undefined;
// 返事を Discord に戻す（CC8。Discord から頼んだ送信が届いたセッションの Stop を、頼んだチャンネルに出す）
let ccReplier: CcReplier | undefined;
// 画面の写し（Web）と、セッション → ペインの引き当て（pid の祖先と pane_pid。§3.1）
let ccTmux: Tmux | undefined;
let ccPanes: CcPaneResolver | undefined;
// /api/status の cc（hook の受け口が待ち受けているか・tmux のサーバー・複数行）
let ccStatusOf: (() => CcStatus) | undefined;
// SDK のツール cc_list・cc_send・cc_start（CC7）と、その確認のボタンが使う送信・起動。確認の失効（10 分）は下の ccConfirmExpirer
let ccTools: CcToolDeps | undefined;
let ccRuntime: CcConfirmRuntime | undefined;
const ccHookToken = process.env.SELF_AGENT_CC_HOOK_TOKEN;
if (
  config.cc &&
  ccClaudePath !== undefined &&
  ccTmuxPath !== undefined &&
  config.ccHookPort !== undefined &&
  ccHookToken !== undefined &&
  ccHookToken !== ""
) {
  // 保留してよいのは一覧にあるセッションの要求だけ（registry は下で作る）
  let knownSessions: CcRegistry | undefined;
  const permissionHold = new CcPermissionHold({
    cfg: config,
    store: ccPermissionStore,
    known: (sessionId) => knownSessions?.knows(sessionId) ?? false,
    now,
    log,
  });
  ccPermissions = permissionHold;
  const registry = new CcRegistry({
    cfg: config,
    agents: new AgentsClient({ claudePath: ccClaudePath }),
    dirs: new ClaudeDirs(),
    store: ccSessions,
    now,
    // 送信の待ち行列が空でない・起動したセッションをまだ一覧で見つけていない間は、見ていなくても設定の周期で一覧を読む（返事は hook で届くので待たない）
    busy: () => ccSends.countActive() > 0 || ccStarter?.busy() === true,
    // 許可の要求を保留している間は 5 秒ごとに読み、status で「他で答えられた」を見る
    permissions: permissionHold,
    // 一覧から消えたセッション: チャンネルがあれば、終わったことをそこに 1 行出して完了カテゴリへ移す。
    // 返事を追いかけていれば、追いかけのチャンネルに「終わりました」を出して止める。どちらも無いときだけ、
    // self-agent が起動したセッションの終了を #system に出す（cc/channels.ts の ccEndedHandler）
    ended: ccEndedHandler({ channels: () => ccChannels, replier: () => ccReplier, notifier: () => ccNotifier }),
    // 同じ session_id が一覧に戻ったら、終わったチャンネルを開き直してカテゴリ「Claude Code」へ戻す
    revived: (session) => {
      ccChannels?.revived(session);
    },
    // 採った hook の事象（Stop）を返事の追いかけと送信に渡す（Stop で作業中に積んだ送信を周期を待たずに試す）
    // 端末・RC から打った指示（UserPromptSubmit）は、チャンネルがあればそこに写す（CC12）
    onEvent: (event) => {
      ccSender?.onEvent(event);
      ccReplier?.onEvent(event);
      ccChannelPosts?.onEvent(event);
    },
    log,
  });
  knownSessions = registry;
  ccRegistry = registry;
  // 判断待ちの知らせの 1 時間の上限は #system とチャンネルで 1 つ
  const waitBudget = new CcWaitBudget();
  // チャンネルが開いているセッションの許可の要求は、#system より先にチャンネルが引き受ける（1 件は 1 か所）
  const channelPosts = new CcChannelPosts({
    cfg: config,
    channels: ccChannelStore,
    gateway,
    permissions: ccPermissionStore,
    sessions: ccSessions,
    sends: ccSends,
    registry,
    waitBudget,
    // チャンネルに出せなかった許可の要求は #system（notifier）に回す
    release: (id) => permissionHold.release(id),
    home: homedir(),
    // Web UI が有効なら、許可の要求・判断待ち・端末の指示の写しを会話に書く（CC14）
    ...history,
    now,
    log,
  });
  ccChannelPosts = channelPosts;
  permissionHold.listen(channelPosts);
  if (config.ccNotify) {
    const notifier = new CcDiscordNotifier({
      cfg: config,
      guildSettings,
      notify,
      // notify と同じ既定の人格の Bot で書き換える
      gateway,
      permissions: ccPermissionStore,
      sessions: ccSessions,
      registry,
      // チャンネルのあるセッションの判断待ちは channelPosts が出す
      hasChannel: (sessionId) => ccChannelStore.openFor(sessionId) !== undefined,
      waitBudget,
      home: homedir(),
      now,
      log,
    });
    ccNotifier = notifier;
    permissionHold.listen(notifier);
  }
  // 許可の要求のボタン（#system とチャンネルのどちらの 1 通でも）。SELF_AGENT_CC_NOTIFY=0 でもチャンネルのボタンが効くよう、notifier によらず作る
  ccPermissionButtons = {
    answer: (id, decision) => permissionHold.answer(id, decision, "discord"),
    resolvedMessage: (id) => channelPosts.resolvedMessage(id),
    // 答えた（関わった）ら、押したサーバーにそのセッションのチャンネルを作る（CC11）
    answered: (id, guildId) => ccPermissionAnswered(id, guildId ?? undefined),
  };
  // 受け付けを始める前に、再起動で pending のまま残った許可の要求を expired にする（#system の 1 通は Discord につないだ後に書き換える）
  ccRecoveredPermissions = permissionHold.recover();
  const hookServer = createCcHookServer({
    host: "127.0.0.1",
    port: config.ccHookPort,
    token: ccHookToken,
    receiver: registry,
    permissions: permissionHold,
    // 常に許可のファイルのルールは、要求の cwd が属する workspace の直下のプロジェクトの中だけ
    ruleContext: { workspaceDir: config.workspaceDir, home: homedir() },
    now,
    log,
  });
  ccHookServer = hookServer;
  const tmux = createTmux({ tmuxPath: ccTmuxPath });
  ccTmux = tmux;
  const panes = new CcPaneResolver({ tmux, parentOf: procParentPid() });
  ccPanes = panes;
  ccSender = new CcSender({
    cfg: config,
    registry,
    panes,
    tmux,
    sends: ccSends,
    sessions: ccSessions,
    notify,
    // Discord から頼んだ送信が届いたら返事の追いかけを始め、貼っている途中に来た Stop を扱う
    onFinished: (row) => ccReplier?.onSendFinished(row),
    // 積んだ直後にチャンネルを作って写し、届け待ち・終わりの印を付ける（CC11。ccChannels は下で作る）
    channels: {
      announce: async (row, guildId) => ccChannels?.announce(row, guildId),
      settled: (row) => ccChannels?.settled(row),
      dialog: (row) => ccChannels?.dialog(row),
    },
    now,
    log,
  });
  // 返事はそのチャンネルの持ち主の Bot で出し、Web UI が有効なら会話に notice（Claude Code のチャンネルは agent）を書く
  // （チャンネルのサーバーは Web で開けるチャンネルと同じ引き方。Claude Code のチャンネルも引く）
  const channelOf = webChannelLookup({ cfg: config, resolveChannel, guildSettings, topicSessions, ccChannels: ccChannelStore });
  ccReplier = new CcReplier({
    cfg: config,
    sessions: ccSessions,
    sends: ccSends,
    replies: ccReplies,
    posts: ownerPosts,
    rcUrl: (sessionId) => {
      const bridge = registry.snapshot().sessions.find((session) => session.sessionId === sessionId)?.bridgeSessionId;
      return bridge === undefined ? undefined : ccRcUrl(bridge);
    },
    // 開いている Claude Code のチャンネルがあれば、返事は常にそこへ（CC11）
    channelFor: (sessionId) => ccChannelStore.openFor(sessionId)?.channelId,
    // 削除されていない cc のチャンネル（そこからの送信では追いかけを立てない）
    isCcChannel: (channelId) => {
      const row = ccChannelStore.get(channelId);
      return row !== undefined && row.state !== "deleted";
    },
    ...history,
    guildOf: (channelId) => channelOf(channelId)?.guildId,
    personaOf: (channelId) => personas.ownerOf(channelId),
    now,
    log,
  });
  // 受け付けを始める前に、再起動で delivering のまま残った送信を unconfirmed に、待ちの上限を過ぎたものを gave_up にする
  ccSender.recover();
  ccStarter = new CcStarter({
    cfg: config,
    // 直下のディレクトリのうち、self-agent の場所と Claude Code の設定の場所に重なるものは起動しない
    places: {
      workspaceDir: config.workspaceDir,
      protectedDirs: [config.workDir, config.dataDir, config.claudeConfigDir, join(homedir(), ".config/self-agent"), join(homedir(), ".claude")],
    },
    claudePath: ccClaudePath,
    registry,
    panes,
    tmux,
    sends: ccSends,
    sessions: ccSessions,
    sender: ccSender,
    // 起動したセッションを一覧で見つけたら、そのチャンネルを作って最初の指示を写す（CC11）
    onBound: (bound) => ccChannels?.started(bound),
    memAvailable: procMemAvailable(),
    now,
    log,
  });
  ccStatusOf = () =>
    ccStatus({ panes, hookListening: () => hookServer.address() !== undefined, store: ccSessions, permissions: ccPermissionStore });
  // 確認は頼んだチャンネルに、その持ち主の Bot で投稿する
  ccTools = createCcTools({
    cfg: config,
    registry,
    panes,
    sender: ccSender,
    starter: ccStarter,
    sends: ccSends,
    starts: ccStarts,
    gateway: ownerPosts,
    log,
  });
  ccRuntime = { sender: ccSender, starter: ccStarter, registry, panes };
  // セッションの Discord のチャンネル（CC10）。作るのは手動の口（Web・/cc open）だけで、発言はまだ届けない（CC11）。投稿は既定の人格の Bot
  ccChannels = new CcChannels({
    cfg: config,
    store: ccChannelStore,
    sends: ccSends,
    sender: () => ccSender,
    // 終わったチャンネルの [起動して続ける]（CC13）
    starter: () => ccStarter,
    sessions: ccSessions,
    // Discord から頼んだ送信・起動は、頼んだチャンネルのサーバーに作る
    guildOf: (channelId) => channelOf(channelId)?.guildId,
    guildSettings,
    registry,
    panes,
    gateway,
    queue: layoutQueue,
    channelOps,
    notify,
    home: homedir(),
    // Web UI が有効なら、発言・写し・届かなかった・終わった・戻ったを会話に書く（CC14）
    ...history,
    now,
    log,
  });
}
// cc_send・cc_start の確認の失効（10 分）。SELF_AGENT_CC が無効でも動かし、再起動の前に出した確認が残っていれば取り消して注記する
const ccConfirmExpirer = new CcConfirmExpirer({
  cfg: config,
  ccSends,
  ccStarts,
  ccSessions,
  ccPosts: ownerPosts,
  ccEnabled: () => ccRuntime !== undefined,
  now,
  log,
});

// GitHub の通知の [対応]（docs/plan/github-notifications.md §5・§6、docs/plan/claude-code-sessions.md §6。SELF_AGENT_GITHUB と SELF_AGENT_CC の両方のときだけ）:
// そのリポジトリの Claude Code のセッションに固定のテンプレートを cc_sends（origin github）で積み、無ければそのディレクトリで起動して積む。
// 地図（~/workspace の remote）を読む git は起動時に PATH から 1 回解決する。無い・ワークスペースが workDir・dataDir と重なるなら [対応] を付けない（§7.2）
if (config.github && ccRegistry !== undefined && ccPanes !== undefined && ccTmux !== undefined && ccSender !== undefined && ccStarter !== undefined) {
  const handoffGitPath = resolveCommandPath("git");
  const workspaceReal = (() => {
    try {
      return realpathSync(config.workspaceDir);
    } catch {
      return undefined;
    }
  })();
  const overlaps = (a: string, b: string): boolean => a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`);
  const dataReal = (() => {
    try {
      return realpathSync(config.dataDir);
    } catch {
      return config.dataDir;
    }
  })();
  if (handoffGitPath === undefined) log("git が見つからないため、#github に [対応] を付けません");
  else if (workspaceReal !== undefined && (overlaps(workspaceReal, realWorkDir) || overlaps(workspaceReal, dataReal))) {
    log("SELF_AGENT_WORKSPACE_DIR が workDir・dataDir と重なるため、#github に [対応] を付けません");
  } else {
    githubHandoff = new GithubHandoff({
      workspaceDir: config.workspaceDir,
      gitPath: handoffGitPath,
      store: githubStore,
      sends: ccSends,
      registry: ccRegistry,
      panes: ccPanes,
      tmux: ccTmux,
      sender: ccSender,
      starter: ccStarter,
      now,
      log,
    });
  }
}

// GitHub の通知（docs/plan/github-notifications.md。SELF_AGENT_GITHUB=1 のときだけ）: 自前のタイマーで gh api の通知を取り、#github に投稿する。
// gh は起動時に PATH から 1 回解決する（無ければ取得せず、#system に 1 回知らせる）。投稿は既定の人格の Bot
const ghPath = config.github ? resolveGhPath() : undefined;
const githubPoller = createGithubPoller({
  cfg: config,
  // [対応] を付ける（SELF_AGENT_CC も有効で、送り込みを準備できたときだけ）
  ...(githubHandoff === undefined ? {} : { handoff: githubHandoff }),
  gh: ghPath === undefined ? undefined : new GhClient({ ghPath }),
  store: githubStore,
  guildSettings,
  gateway,
  notify,
  now,
  log,
});

// 作ったプロジェクトの配信: ポートと公開 URL の両方があるときだけ、127.0.0.1 で待ち受ける（tailnet には tailscale serve で出す）
let staticServer: StaticServer | undefined;
if (config.servePort !== undefined && config.publicBaseUrl !== undefined) {
  mkdirSync(projectsDir, { recursive: true });
  staticServer = createStaticServer({
    host: "127.0.0.1",
    port: config.servePort,
    projectsDir,
    projects,
    allowedLogin: config.serveAllowedLogin,
    timeZone: config.timeZone,
    log,
  });
}

// Web UI（docs/plan/web-ui.md）: ポートとログインの両方があるときだけ、127.0.0.1 で待ち受ける（tailnet には tailscale serve で出す）。
// lifecycle（停止中か）は下で作る（要求のときに読む）
const startedAt = now();
let webServer: WebServer | undefined;
if (config.web && config.webPort !== undefined && config.webAllowedLogin !== undefined) {
  // リマインドとプロジェクトの一覧のチャンネルの表示名（同じものを渡す）
  const webChannelName = webChannelNamer({
    cfg: config,
    guildSettings,
    topicSessions,
    resolveChannel,
    ...(ccChannels === undefined ? {} : { ccChannels: ccChannelStore }),
  });
  // Claude Code のチャンネル（CC14。SELF_AGENT_CC で連携が動くときだけ）: 会話の一覧・/turns に kind cc で出し、送信はそのセッションに積む
  const webCc =
    ccChannels === undefined || ccRegistry === undefined
      ? undefined
      : {
          store: ccChannelStore,
          describe: ccChannelDescriber({
            registry: ccRegistry,
            workspaceDir: config.workspaceDir,
            home: homedir(),
            sends: ccSends,
            permissions: { store: ccPermissionStore, holdSec: config.ccPermissionHoldSec },
            sessions: ccSessions,
            now,
          }),
        };
  // /messages と /api/cc/channels/<id>/close で同じ引き方（Claude Code のチャンネルも通す）
  const webChannelOf = webChannelLookup({
    cfg: config,
    resolveChannel,
    guildSettings,
    topicSessions,
    ...(ccChannels === undefined ? {} : { ccChannels: ccChannelStore }),
  });
  webServer = createWebServer({
    host: "127.0.0.1",
    port: config.webPort,
    allowedLogin: config.webAllowedLogin,
    ...(process.env.SELF_AGENT_WEB_TOKEN === undefined || process.env.SELF_AGENT_WEB_TOKEN === ""
      ? {}
      : { token: process.env.SELF_AGENT_WEB_TOKEN }),
    staticDir: fileURLToPath(new URL("./web/static/", import.meta.url)),
    templateSiteDir: join(WEB_TEMPLATE_DIR, "site"),
    routes: [
      ...statusRoutes({
        cfg: config,
        version: readPackageVersion,
        startedAt,
        stopping: () => lifecycle.stopping(),
        personas,
        ...(guest === undefined ? {} : { guestConnected: () => guest.connected() }),
        shellState: {
          configured: config.shell,
          enabled: () => shellState.enabled(),
          failedItems: () => shellState.failedItems(),
        },
        queue: turnQueue,
        running: () => handler.runningTurns().length,
        serving: () => staticServer?.listening() ?? false,
        ...(githubPoller === undefined ? {} : { githubStatus: () => githubPoller.status() }),
        guildSettings,
        env: process.env,
        ...(ccStatusOf === undefined ? {} : { cc: ccStatusOf }),
      }),
      ...usageRoutes({ cfg: config, usage, attachments, now }),
      ...channelRoutes({
        cfg: config,
        guildSettings,
        topicSessions,
        projects,
        history: historyStore,
        personas,
        resolveChannel,
        ...(webCc === undefined ? {} : { cc: webCc }),
      }),
      ...devlogRoutes({ cfg: config, now }),
      ...turnRoutes({
        cfg: config,
        guildSettings,
        topicSessions,
        resolveChannel,
        handler,
        ...(ccChannels === undefined ? {} : { cc: { store: ccChannelStore, channels: ccChannels, ...(ccRegistry === undefined ? {} : { registry: ccRegistry }) } }),
        now,
        log,
      }),
      ...taskRoutes({ tasks, reminders, log }),
      ...reminderRoutes({
        cfg: config,
        reminders,
        channelName: webChannelName,
        log,
      }),
      ...memoryRoutes({ memories, log }),
      ...noticeRoutes({ notices: noticeStore, guildSettings, now }),
      // GitHub の通知（SELF_AGENT_GITHUB が無効なら 404）とナレッジは読むだけ
      ...githubRoutes({
        cfg: config,
        store: githubStore,
        status: githubPoller === undefined ? undefined : () => githubPoller.status(),
        // [対応]・[起動して送る]（SELF_AGENT_CC も有効なときだけ）
        ...(githubHandoff === undefined ? {} : { handoff: githubHandoff }),
      }),
      ...knowledgeRoutes({ knowledge }),
      // この機械の Claude Code のセッションの一覧と画面の写し（SELF_AGENT_CC が無効なら 404）
      // 送信（/send・/cancel）は SELF_AGENT_CC が有効なときだけ
      ...ccRoutes({
        registry: ccRegistry,
        panes: ccPanes,
        tmux: ccTmux,
        workspaceDir: config.workspaceDir,
        home: homedir(),
        ...(ccSender === undefined ? {} : { sender: ccSender, sends: ccSends }),
        // 起動（/api/cc/projects・POST /api/cc/sessions）
        ...(ccStarter === undefined ? {} : { starter: ccStarter }),
        // 許可の要求（/api/cc/permissions と一覧の permission）
        ...(ccPermissions === undefined
          ? {}
          : {
              permissions: {
                hold: ccPermissions,
                // Web で答えた（関わった）ら、最初の /setup 済みのサーバーにチャンネルを作る（CC11）
                answered: (id: number) => ccPermissionAnswered(id, undefined),
                store: ccPermissionStore,
                holdSec: config.ccPermissionHoldSec,
              },
            }),
        // 返事の追いかけ（一覧の follow・/unfollow）
        ...(ccRegistry === undefined ? {} : { follows: ccSessions, log }),
        // セッションの Discord のチャンネル（一覧の channel・/channel）
        ...(ccChannels === undefined ? {} : { channels: { store: ccChannels, allowedGuildIds: config.allowedGuildIds, lookup: webChannelOf } }),
        now,
      }),
      // 作ったプロジェクトのファイルを読むだけ（配信が無効でも出す）
      ...projectRoutes({
        cfg: config,
        projects,
        projectsDir,
        channelName: webChannelName,
      }),
      // セッションの操作は Discord のコマンドと同じ session-ops.ts を通す。チャンネルを作るのは既定の人格の Bot（/new と同じキュー）、
      // /close の確認と /renew の結果は持ち主の Bot で Discord にも投稿する
      ...sessionRoutes({
        cfg: config,
        resolveChannel,
        gateway,
        defaultConnected: () => gateway.connected(),
        guildSettings,
        topicSessions,
        queue: layoutQueue,
        personas,
        ownerPosts,
        tasks,
        channelOps,
        turnQueue,
        turn,
        projects,
        projectsDir,
        inboxRotator,
        history: historyStore,
        log,
      }),
    ],
    stopping: () => lifecycle.stopping(),
    now,
    log,
  });
} else if (config.webPort !== undefined || config.webAllowedLogin !== undefined) {
  log("Web UI は無効です（SELF_AGENT_WEB_PORT と SELF_AGENT_WEB_ALLOWED_LOGIN の両方が要ります）");
}

// 停止: シグナルで新しい受付と定期処理（リマインドの発火・GitHub の通知のポーリングを含む）を止め、進行中の処理（返信まで）と実行中のチャンネルの移動を最大 shutdownGraceSec 秒待ってから gateway・静的サーバー・Web UI・DB を閉じる
const lifecycle = createShutdown(
  {
    cfg: config,
    // 全人格の Bot とゲスト Bot を止める（1 つが失敗しても残りは止める）
    gateway: {
      stop: async () => {
        const results = await Promise.allSettled([
          ...[gateway, ...personaGateways.map((bot) => bot.gateway)].map((bot) => bot.stop()),
          ...(guest === undefined ? [] : [guest.stop()]),
        ]);
        const failed = results.find((result) => result.status === "rejected");
        if (failed !== undefined) throw failed.reason;
      },
    },
    queues: [turnQueue, layoutQueue, { idle: async () => guest?.idle() }, { idle: async () => ccChannels?.idle() }],
    scheduler,
    reminderScheduler,
    ...(githubPoller === undefined ? {} : { githubPoller }),
    // 実行中のジョブは待たずに中断し（failed / interrupted）、始めていないものは次の起動で入れ直す
    ...(jobs === undefined ? {} : { jobs }),
    channelOps,
    staticServer,
    webServer,
    ...(ccRegistry === undefined ? {} : { ccRegistry }),
    ...(ccSender === undefined ? {} : { ccSender }),
    ...(ccStarter === undefined ? {} : { ccStarter }),
    // 保留中の許可の要求には空の本文を返す（端末・RC のダイアログは残る）
    ...(ccPermissions === undefined ? {} : { ccPermissions }),
    // #system への知らせ（停止の後は新しく出さず、保留をやめた 1 通の書き換えは待つ）
    ...(ccNotifier === undefined ? {} : { ccNotifier }),
    // Claude Code のチャンネルへの許可の要求・判断待ち・写し（同じく）
    ...(ccChannelPosts === undefined ? {} : { ccChannelPosts }),
    ...(ccHookServer === undefined ? {} : { ccHookServer }),
    ccConfirmExpirer,
    ...(ccReplier === undefined ? {} : { ccReplier }),
    closeDb: () => db.close(),
    log,
  },
  // Claude Code のチャンネル（削除されていない cc_channels の行）への発言は、ターンにせずそのセッションに届ける（CC11。連携が動いていなければ黙って捨てる）
  { handleMessage: routeCcChannelMessages(ccChannelStore, () => ccChannels, handler.handleMessage), handleInteraction },
);
const onSignal = (): void => {
  if (lifecycle.stopping()) {
    log("停止中にもう一度シグナルを受けたため、待たずに終了します");
    process.exit(1);
  }
  void lifecycle.shutdown().then(() => process.exit(0));
};
process.on("SIGINT", onSignal);
process.on("SIGTERM", onSignal);

// 起動に失敗しても（ポートの衝突など）Bot は動かし続ける。staticServer.listening() は false のまま
if (staticServer !== undefined) {
  try {
    await staticServer.start();
    log(`ページの配信を始めました（127.0.0.1:${config.servePort}）`);
  } catch (error) {
    log(`ページの配信を始められませんでした: ${error instanceof Error ? error.message : String(error)}`);
  }
}
// Web UI も同じく、起動に失敗しても Bot は動かし続ける
if (webServer !== undefined) {
  try {
    await webServer.start();
    log(`Web UI を始めました（127.0.0.1:${config.webPort}）`);
  } catch (error) {
    log(`Web UI を始められませんでした: ${error instanceof Error ? error.message : String(error)}`);
  }
}
// Claude Code の hook の受け口も同じく、起動に失敗しても Bot は動かし続ける（hooks は connection refused で普段どおり進む）。
// 一覧に無いセッションの許可の要求は保留しないので、受け口を始める前に一覧を 1 回読んでおく（読めなくても始める。周期の読み取りは後の start から）
if (ccHookServer !== undefined) {
  await ccRegistry?.tick();
  try {
    await ccHookServer.start();
    log(`Claude Code の hook の受け口を始めました（127.0.0.1:${config.ccHookPort}）`);
  } catch (error) {
    log(`Claude Code の hook の受け口を始められませんでした: ${error instanceof Error ? error.message : String(error)}`);
  }
}
// 発言を受け付ける前に 1 回診断する（#system への知らせは gateway の起動後、最初の tick で行う）
if (config.shell) await shellState.check();
// 作業ジョブ: 発言・操作を受け付ける前に、再起動で止まった running を failed / interrupted にし（作業場所は kept に）、queued をキューに入れ直す
// （知らせは gateway の起動の後。それまで run は始めない）
await jobs?.recoverState();
await gateway.start(lifecycle.handlers);
await registerCommands({ cfg: config, gateway, commands, log });
// 足した人格の Bot（同じハンドラ。発言は持ち主の Bot の分だけ、操作はどの Bot で受けても処理する）。ログインは待たずに並べて行い、
// できなくても既定の人格は動かし続ける（定期処理・リマインドは先に始める）
void startPersonaGateways(
  personaGateways.map((bot) => ({ id: bot.persona.id, gateway: bot.gateway })),
  lifecycle.handlers,
  log,
  { onSettled: (id) => loginSettled.add(id) },
);
// ゲスト Bot（ゲストのサーバーの /guest と、有効なチャンネルでのメンション・返信に答える）。ログインは待たず、できなくても既定の人格は動かし続ける
void guest?.start(lifecycle.stopping);
logUnconfiguredGuilds({ cfg: config, guildSettings, log });
// 作業ジョブ: 再起動で止まった run の #jobs への知らせを出してから、入れ直した queued を始める
await jobs?.announceRecovered();
// 起動直後に 1 回（止まっていた間に過ぎた分を拾う）、以後は一定間隔で（リマインドは分の境目ごと）。停止を始めていれば何もしない
scheduler.start(TICK_INTERVAL_MS);
reminderScheduler.start();
githubPoller?.start();
ccRegistry?.start();
ccSender?.start();
ccStarter?.start();
// 再起動の前に保留していた要求の 1 通を「時間切れ」に書き換える（チャンネルに出したものと #system に出したものに分ける）
ccChannelPosts?.rewriteRecovered(ccRecoveredPermissions);
ccNotifier?.rewriteRecovered(ccRecoveredPermissions.filter((row) => ccChannelPosts?.owns(row) !== true));
ccNotifier?.start();
ccChannelPosts?.start();
ccConfirmExpirer.start();
ccReplier?.start();
console.log(`self-agent: 起動しました（model=${config.model}）`);
