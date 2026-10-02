// 配線だけ: config → store → runner → gateway → handler
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { SdkAgentRunner } from "./agent/sdk-runner.ts";
import { createTaskMcpServer } from "./agent/tools.ts";
import { createChannelResolver, logUnconfiguredGuilds } from "./app/access.ts";
import { createHandler } from "./app/handler.ts";
import { COMPONENTS, createCommands, createInteractionHandler, registerCommands } from "./app/interactions.ts";
import { KeyedSerialQueue } from "./app/queue.ts";
import { loadConfig, missingForStart } from "./config.ts";
import { DiscordGateway } from "./discord/discord-gateway.ts";
import { openDb } from "./store/db.ts";
import { GuildSettingsStore } from "./store/guild-settings.ts";
import { SessionStore } from "./store/sessions.ts";
import { TaskStore } from "./store/tasks.ts";
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
const log = (message: string): void => console.error(message);

const runner = new SdkAgentRunner(config, () => createTaskMcpServer(tasks));
const gateway = new DiscordGateway(config.allowedGuildIds);
const handle = createHandler({
  cfg: config,
  resolveChannel: createChannelResolver(config, guildSettings),
  gateway,
  runner,
  sessions,
  usage,
  queue: new KeyedSerialQueue(config.maxConcurrentTurns),
  log,
});
// /setup 専用のキュー（ターンの同時実行枠とは分ける）
const commands = createCommands({ gateway, guildSettings, queue: new KeyedSerialQueue(1), log });
const handleInteraction = createInteractionHandler({
  cfg: config,
  commands,
  components: COMPONENTS,
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
