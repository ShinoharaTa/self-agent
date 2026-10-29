// 配線だけ: config → store → runner → gateway → handler
import { mkdirSync, realpathSync } from "node:fs";
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
import { createConfirmKbDelete } from "./app/commands/kb-delete.ts";
import { createNotifyMemoryChange } from "./app/commands/memory-undo.ts";
import { createCommands, createComponents, createInteractionHandler, registerCommands } from "./app/interactions.ts";
import { createTurnQueue, KeyedSerialQueue } from "./app/queue.ts";
import { ReminderScheduler } from "./app/reminders.ts";
import { Scheduler, TICK_INTERVAL_MS } from "./app/scheduler.ts";
import { PersonaStatus, startPersonaGateways } from "./app/persona-status.ts";
import { PersonaRouter, type PersonaRuntime } from "./app/personas.ts";
import { createOpenSession } from "./app/session-open.ts";
import { createShutdown } from "./app/shutdown.ts";
import { ShellState, shellRefresher } from "./app/shell-state.ts";
import { formatDate, startOfLocalDay } from "./app/time.ts";
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
import { backupBeforeMigration, openDb } from "./store/db.ts";
import { GuildSettingsStore } from "./store/guild-settings.ts";
import { HistoryStore } from "./store/history.ts";
import { InboxSummaryStore } from "./store/inbox-summaries.ts";
import { JobStore } from "./store/jobs.ts";
import { KnowledgeStore } from "./store/knowledge.ts";
import { MemoryStore } from "./store/memories.ts";
import { ProjectStore } from "./store/projects.ts";
import { ReminderStore } from "./store/reminders.ts";
import { RoutineRecordStore } from "./store/routine-records.ts";
import { RoutineStore } from "./store/routines.ts";
import { SdkSessionStore } from "./store/sdk-sessions.ts";
import { TaskStore } from "./store/tasks.ts";
import { TopicSessionStore } from "./store/topic-sessions.ts";
import { UsageStore } from "./store/usage.ts";
import { channelRoutes, webChannelNamer } from "./web/routes/channels.ts";
import { devlogRoutes } from "./web/routes/devlog.ts";
import { memoryRoutes } from "./web/routes/memories.ts";
import { reminderRoutes } from "./web/routes/reminders.ts";
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
// bwrap・socat がある run だけに付ける。shellAvailable は run の前に呼ぶ）。openSession・kbMemory・shellState は下で作る（run のときに読む）
const createMcpServer = (context?: RunContext) =>
  createTaskMcpServer(tasks, topicSessions, openSession, kbMemory, projectTools, reminderTools, context);
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
      guildSettings,
      adminGateway: personas.admin,
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
  log,
});
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
    // #jobs のボタンとモーダル（SELF_AGENT_JOBS=1 のときだけ）
    ...(jobs === undefined ? {} : { jobs }),
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
  guildSettings,
  gateway,
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
        guildSettings,
        gateway,
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
  // 待ちに移した知らせの行（Web UI が有効なときだけ）
  ...history,
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

// GitHub の通知（docs/plan/github-notifications.md。SELF_AGENT_GITHUB=1 のときだけ）: 自前のタイマーで gh api の通知を取り、#github に投稿する。
// gh は起動時に PATH から 1 回解決する（無ければ取得せず、#system に 1 回知らせる）。投稿は既定の人格の Bot
const ghPath = config.github ? resolveGhPath() : undefined;
const githubPoller = createGithubPoller({
  cfg: config,
  gh: ghPath === undefined ? undefined : new GhClient({ ghPath }),
  store: new GithubStore(db, now),
  guildSettings,
  gateway,
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
        guildSettings,
        env: process.env,
      }),
      ...usageRoutes({ cfg: config, usage, attachments, now }),
      ...channelRoutes({ cfg: config, guildSettings, topicSessions, projects, history: historyStore, personas, resolveChannel }),
      ...devlogRoutes({ cfg: config, now }),
      ...turnRoutes({ cfg: config, guildSettings, topicSessions, resolveChannel, handler, now, log }),
      ...taskRoutes({ tasks, reminders, log }),
      ...reminderRoutes({
        cfg: config,
        reminders,
        channelName: webChannelNamer({ cfg: config, guildSettings, topicSessions, resolveChannel }),
        log,
      }),
      ...memoryRoutes({ memories, log }),
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
    queues: [turnQueue, layoutQueue, { idle: async () => guest?.idle() }],
    scheduler,
    reminderScheduler,
    ...(githubPoller === undefined ? {} : { githubPoller }),
    // 実行中のジョブは待たずに中断し（failed / interrupted）、始めていないものは次の起動で入れ直す
    ...(jobs === undefined ? {} : { jobs }),
    channelOps,
    staticServer,
    webServer,
    closeDb: () => db.close(),
    log,
  },
  { handleMessage: handler.handleMessage, handleInteraction },
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
console.log(`self-agent: 起動しました（model=${config.model}）`);
