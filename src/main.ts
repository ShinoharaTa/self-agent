// 配線だけ: config → store → runner → gateway → handler
import { mkdirSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { SdkAgentRunner } from "./agent/sdk-runner.ts";
import { createTaskMcpServer } from "./agent/tools.ts";
import { createChannelResolver, logUnconfiguredGuilds } from "./app/access.ts";
import { ChannelOpsQueue } from "./app/channel-ops.ts";
import { createHandler } from "./app/handler.ts";
import { InboxRotator } from "./app/inbox-rotate.ts";
import { createConfirmKbDelete } from "./app/commands/kb-delete.ts";
import { createNotifyMemoryChange } from "./app/commands/memory-undo.ts";
import { createCommands, createComponents, createInteractionHandler, registerCommands } from "./app/interactions.ts";
import { KeyedSerialQueue } from "./app/queue.ts";
import { Scheduler, TICK_INTERVAL_MS } from "./app/scheduler.ts";
import { createOpenSession } from "./app/session-open.ts";
import { createShutdown } from "./app/shutdown.ts";
import { loadConfig, missingForStart } from "./config.ts";
import { DiscordGateway } from "./discord/discord-gateway.ts";
import { createStaticServer, type StaticServer } from "./serve/static-server.ts";
import { ChannelSeedStore } from "./store/channel-seeds.ts";
import { openDb } from "./store/db.ts";
import { GuildSettingsStore } from "./store/guild-settings.ts";
import { InboxSummaryStore } from "./store/inbox-summaries.ts";
import { KnowledgeStore } from "./store/knowledge.ts";
import { MemoryStore } from "./store/memories.ts";
import { ProjectStore } from "./store/projects.ts";
import { SdkSessionStore } from "./store/sdk-sessions.ts";
import { TaskStore } from "./store/tasks.ts";
import { TopicSessionStore } from "./store/topic-sessions.ts";
import { UsageStore } from "./store/usage.ts";

const config = loadConfig();

const missing = missingForStart(config);
if (missing.length > 0) {
  console.error(`起動に必要な環境変数が設定されていません: ${missing.join(", ")}`);
  process.exit(1);
}

mkdirSync(config.workDir, { recursive: true });
mkdirSync(config.claudeConfigDir, { recursive: true });

const now = (): Date => new Date();
const db = openDb(join(config.dataDir, "self-agent.db"));
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
const log = (message: string): void => console.error(message);

// 作ったプロジェクトの場所。権限ルール（<realpath(workDir)>/projects）と同じ実際の場所にする
const projectsDir = join(realpathSync(config.workDir), "projects");

const gateway = new DiscordGateway(config.allowedGuildIds);
const resolveChannel = createChannelResolver(config, guildSettings, topicSessions);
// /setup・/new・session_open 専用のキュー（ターンの同時実行枠とは分ける）
const layoutQueue = new KeyedSerialQueue(1);
// #inbox の session_open: /new と同じキュー（layoutQueue）で作る
const openSession = createOpenSession({
  cfg: config,
  resolveChannel,
  gateway,
  guildSettings,
  topicSessions,
  seeds,
  queue: layoutQueue,
  now,
  log,
});
// ナレッジベースと記憶のツール: kb_delete の確認と記憶の変更の知らせは run のチャンネルに投稿する
const kbMemory = {
  knowledge,
  memories,
  confirmKbDelete: createConfirmKbDelete({ gateway }),
  notifyMemoryChange: createNotifyMemoryChange({ gateway, log }),
  timeZone: config.timeZone,
};
// project_open: 配信が無効（設定が無い・待ち受けに失敗した）なら not_configured（staticServer は下で作る）
const projectTools = {
  projects,
  projectsDir,
  publicBaseUrl: config.publicBaseUrl,
  serving: () => staticServer?.listening() ?? false,
};
// ツールのハンドラには run ごとのチャンネル（context）を渡す。ツール定義は毎回同じ。
// ファイル操作は run ごとの hook で <workDir>/projects の中（書き込みはそのチャンネルのプロジェクトの中）に絞る
const runner = new SdkAgentRunner(
  config,
  (context) => createTaskMcpServer(tasks, topicSessions, openSession, kbMemory, projectTools, context),
  { projects, projectsDir },
  log,
);
// 発言と /close のターンのキュー（key は channelId）
const turnQueue = new KeyedSerialQueue(config.maxConcurrentTurns);
const turn = { runner, sessions, seeds, topicSessions, inboxSummaries, memories, usage, log };
const channelOps = new ChannelOpsQueue({
  gateway,
  guildSettings,
  topicSessions,
  gapMs: config.channelOpGapMs,
  log,
});
// セッションのチャンネルのターンには途中経過と [中断] を付け、手順の上限で止まったら [続ける] を付ける
const handler = createHandler({
  cfg: config,
  resolveChannel,
  gateway,
  ...turn,
  channelOps,
  queue: turnQueue,
  now,
});
const commands = createCommands({
  cfg: config,
  gateway,
  guildSettings,
  topicSessions,
  queue: layoutQueue,
  channelOps,
  tasks,
  usage,
  projects,
  projectsDir,
  turnQueue,
  turn,
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
    log,
  }),
  log,
});
// #inbox の切り替え: 要約のターンは発言と同じキュー（turnQueue、key は #inbox の channelId）で行う
const inboxRotator = new InboxRotator({
  cfg: config,
  guildSettings,
  inboxSummaries,
  turnQueue,
  turn,
  gateway,
  now,
  log,
});
// 定期処理: セッションの状態と Discord の親カテゴリのずれを直し、発言の無い進行中のセッションを待ちに移し、
// 完了から日数の経ったセッションの削除を #system で確認し、#inbox の会話を切り替える
const scheduler = new Scheduler({
  cfg: config,
  topicSessions,
  guildSettings,
  sessions,
  seeds,
  channelOps,
  gateway,
  inboxRotator,
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

// 停止: シグナルで新しい受付と定期処理を止め、進行中の処理（返信まで）と実行中のチャンネルの移動を最大 shutdownGraceSec 秒待ってから gateway・静的サーバー・DB を閉じる
const lifecycle = createShutdown(
  {
    cfg: config,
    gateway,
    queues: [turnQueue, layoutQueue],
    scheduler,
    channelOps,
    staticServer,
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
await gateway.start(lifecycle.handlers);
await registerCommands({ cfg: config, gateway, commands, log });
logUnconfiguredGuilds({ cfg: config, guildSettings, log });
// 起動直後に 1 回（止まっていた間に過ぎた分を拾う）、以後は一定間隔で。停止を始めていれば何もしない
scheduler.start(TICK_INTERVAL_MS);
console.log(`self-agent: 起動しました（model=${config.model}）`);
