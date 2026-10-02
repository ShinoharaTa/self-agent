// 配線だけ: config → store → runner → gateway → handler
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { SdkAgentRunner } from "./agent/sdk-runner.ts";
import { createTaskMcpServer } from "./agent/tools.ts";
import { createChannelResolver, logUnconfiguredGuilds } from "./app/access.ts";
import { ChannelOpsQueue } from "./app/channel-ops.ts";
import { createHandler } from "./app/handler.ts";
import { createCommands, createComponents, createInteractionHandler, registerCommands } from "./app/interactions.ts";
import { KeyedSerialQueue } from "./app/queue.ts";
import { loadConfig, missingForStart } from "./config.ts";
import { DiscordGateway } from "./discord/discord-gateway.ts";
import { ChannelSeedStore } from "./store/channel-seeds.ts";
import { openDb } from "./store/db.ts";
import { GuildSettingsStore } from "./store/guild-settings.ts";
import { SessionStore } from "./store/sessions.ts";
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
const sessions = new SessionStore(db, now);
const usage = new UsageStore(db, now);
const guildSettings = new GuildSettingsStore(db, now);
const topicSessions = new TopicSessionStore(db, now);
const seeds = new ChannelSeedStore(db, now);
const log = (message: string): void => console.error(message);

// ツールのハンドラには run ごとのチャンネル（context）を渡す。ツール定義は毎回同じ
const runner = new SdkAgentRunner(config, (context) => createTaskMcpServer(tasks, topicSessions, context));
const gateway = new DiscordGateway(config.allowedGuildIds);
// 発言と /close のターンのキュー（key は channelId）
const turnQueue = new KeyedSerialQueue(config.maxConcurrentTurns);
const turn = { runner, sessions, seeds, topicSessions, usage, log };
const channelOps = new ChannelOpsQueue({
  gateway,
  guildSettings,
  topicSessions,
  gapMs: config.channelOpGapMs,
  log,
});
const handle = createHandler({
  cfg: config,
  resolveChannel: createChannelResolver(config, guildSettings, topicSessions),
  gateway,
  ...turn,
  queue: turnQueue,
});
const commands = createCommands({
  gateway,
  guildSettings,
  topicSessions,
  // /setup・/new 専用のキュー（ターンの同時実行枠とは分ける）
  queue: new KeyedSerialQueue(1),
  channelOps,
  tasks,
  turnQueue,
  turn,
  log,
});
const handleInteraction = createInteractionHandler({
  cfg: config,
  commands,
  components: createComponents({ topicSessions, tasks, channelOps, log }),
  log,
});

const shutdown = async (): Promise<void> => {
  await gateway.stop();
  db.close();
  process.exit(0);
};
process.once("SIGINT", () => void shutdown());
process.once("SIGTERM", () => void shutdown());

await gateway.start({
  onMessage: (message) => {
    void handle(message);
  },
  onInteraction: (interaction, responder) => {
    void handleInteraction(interaction, responder);
  },
});
await registerCommands({ cfg: config, gateway, commands, log });
logUnconfiguredGuilds({ cfg: config, guildSettings, log });
console.log(`self-agent: 起動しました（model=${config.model}）`);
