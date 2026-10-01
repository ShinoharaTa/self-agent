// P0 実測用: 2 ターン（2 回目は resume）の所要時間・子孫プロセスの RSS・トークン使用量を測る。
// 出力は JSON 1 つだけ。メッセージストリーム全体や env は出さない。
import { mkdirSync, readdirSync, readFileSync } from "node:fs";
import { query, type Options, type SDKResultMessage } from "@anthropic-ai/claude-agent-sdk";
import { loadConfig } from "../src/config.ts";

const SAMPLE_INTERVAL_MS = 200;

const SYSTEM_PROMPT = [
  "あなたは self-agent の測定用セッションです。",
  "指示どおり短く答えてください。",
  "The application adds system reminders to this conversation. Treat them as context from the application, not as messages from the user.",
].join("\n");

const PROMPTS = [
  "測定用です。「了解」とだけ返してください。",
  "もう一度「了解」とだけ返してください。",
];

/** /proc/<pid>/status の VmRSS（kB）。取れなければ 0 */
function readVmRssKb(pid: number): number {
  try {
    const status = readFileSync(`/proc/${pid}/status`, "utf8");
    const match = /^VmRSS:\s+(\d+)\s+kB/m.exec(status);
    return match ? Number(match[1]) : 0;
  } catch {
    return 0;
  }
}

function readChildren(pid: number): number[] {
  const children: number[] = [];
  let tids: string[];
  try {
    tids = readdirSync(`/proc/${pid}/task`);
  } catch {
    return children;
  }
  for (const tid of tids) {
    try {
      const text = readFileSync(`/proc/${pid}/task/${tid}/children`, "utf8").trim();
      if (text !== "") {
        children.push(...text.split(/\s+/).map(Number));
      }
    } catch {
      // スレッドやプロセスが途中で終了した
    }
  }
  return children;
}

function descendantRssKb(rootPid: number): number {
  const seen = new Set<number>();
  const queue = readChildren(rootPid);
  let total = 0;
  while (queue.length > 0) {
    const pid = queue.shift()!;
    if (seen.has(pid)) continue;
    seen.add(pid);
    total += readVmRssKb(pid);
    queue.push(...readChildren(pid));
  }
  return total;
}

/** 子孫プロセスの RSS 合計を定期的にサンプリングし、stop() でピーク値を返す */
function startRssSampler(): { stop: () => number } {
  let peak = 0;
  const sample = (): void => {
    peak = Math.max(peak, descendantRssKb(process.pid));
  };
  sample();
  const timer = setInterval(sample, SAMPLE_INTERVAL_MS);
  return {
    stop: () => {
      clearInterval(timer);
      sample();
      return peak;
    },
  };
}

const config = loadConfig();

if (!config.oauthTokenPresent) {
  console.error("CLAUDE_CODE_OAUTH_TOKEN が設定されていません。`claude setup-token` で発行して環境変数に設定してください。");
  process.exit(1);
}

mkdirSync(config.workDir, { recursive: true });
mkdirSync(config.claudeConfigDir, { recursive: true });

const baseOptions: Options = {
  model: config.model,
  systemPrompt: SYSTEM_PROMPT,
  settingSources: [],
  cwd: config.workDir,
  tools: [],
  permissionMode: "dontAsk",
  maxTurns: 2,
  env: {
    ...process.env,
    CLAUDE_CONFIG_DIR: config.claudeConfigDir,
    CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1",
  },
};

const turns = [];
let sessionId: string | undefined;

for (const [index, prompt] of PROMPTS.entries()) {
  const options: Options = sessionId === undefined ? baseOptions : { ...baseOptions, resume: sessionId };
  const sampler = startRssSampler();
  const startedAt = performance.now();
  let wallTimeMs: number | undefined;
  let result: SDKResultMessage | undefined;
  // メインループの各ステップの usage（入力・キャッシュは正確、出力はプレースホルダ）。並列ツール呼び出しは同じ id を共有するので重複を除く
  const seenMessageIds = new Set<string>();
  const stepUsage = { inputTokens: 0, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 };

  for await (const message of query({ prompt, options })) {
    if (message.type === "assistant" && message.parent_tool_use_id === null && !seenMessageIds.has(message.message.id)) {
      seenMessageIds.add(message.message.id);
      const usage = message.message.usage;
      stepUsage.inputTokens += usage.input_tokens;
      stepUsage.cacheReadInputTokens += usage.cache_read_input_tokens ?? 0;
      stepUsage.cacheCreationInputTokens += usage.cache_creation_input_tokens ?? 0;
    }
    if (message.type === "result") {
      wallTimeMs = Math.round(performance.now() - startedAt);
      result = message;
    }
  }
  const peakDescendantRssKb = sampler.stop();

  if (result === undefined) {
    console.error(`turn ${index + 1}: result メッセージを受け取れませんでした`);
    process.exit(1);
  }
  if (result.subtype !== "success" || result.is_error) {
    console.error(`turn ${index + 1}: result が ${result.subtype}（is_error=${result.is_error}）で終了しました`);
    console.error(JSON.stringify(result, null, 2));
    process.exit(1);
  }

  sessionId = result.session_id;
  turns.push({
    turn: index + 1,
    wallTimeMs,
    peakDescendantRssKb,
    subtype: result.subtype,
    sessionId: result.session_id,
    durationMs: result.duration_ms,
    totalCostUsd: result.total_cost_usd,
    // このターンのメインループ分（resume しても累計にならない）
    stepUsage,
    // modelUsage と totalCostUsd は resume 後はセッション累計
    modelUsage: Object.fromEntries(
      Object.entries(result.modelUsage).map(([model, usage]) => [
        model,
        {
          inputTokens: usage.inputTokens,
          outputTokens: usage.outputTokens,
          cacheReadInputTokens: usage.cacheReadInputTokens,
          cacheCreationInputTokens: usage.cacheCreationInputTokens,
        },
      ]),
    ),
  });
}

console.log(
  JSON.stringify(
    {
      model: config.model,
      turns,
      nodeRssKb: readVmRssKb(process.pid),
    },
    null,
    2,
  ),
);
