// dev モードの会話ログ（<SELF_AGENT_DATA_DIR>/devlog/<YYYY-MM-DD>.jsonl）を 1 ターンずつ読みやすく出す。
// npm run devlog -- [--date YYYY-MM-DD] [--kind inbox|tasks|session] [--channel <id>] [--last N]（既定は今日・全部）。
// 読む設定は SELF_AGENT_DATA_DIR と SELF_AGENT_TZ だけ（トークンが無くても動く。既定値は loadConfig と同じ）
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import type { RunContext } from "../src/agent/runner.ts";
import { formatDate } from "../src/app/time.ts";
import { loadDataConfig } from "../src/config.ts";
import { formatDevLogRecord, parseDevLog, selectDevLogRecords } from "../src/devlog/format.ts";
import { devLogDir } from "../src/devlog/log.ts";

const KINDS: readonly RunContext["kind"][] = ["inbox", "tasks", "session"];
const USAGE = "使い方: npm run devlog -- [--date YYYY-MM-DD] [--kind inbox|tasks|session] [--channel <id>] [--last N]";

function fail(message: string): never {
  console.error(message);
  console.error(USAGE);
  process.exit(1);
}

let values: { date?: string; kind?: string; channel?: string; last?: string };
try {
  ({ values } = parseArgs({
    options: {
      date: { type: "string" },
      kind: { type: "string" },
      channel: { type: "string" },
      last: { type: "string" },
    },
  }));
} catch (error) {
  fail(error instanceof Error ? error.message : String(error));
}

if (values.date !== undefined && !/^\d{4}-\d{2}-\d{2}$/.test(values.date)) {
  fail("--date は YYYY-MM-DD で指定してください");
}
const kind = KINDS.find((candidate) => candidate === values.kind);
if (values.kind !== undefined && kind === undefined) {
  fail(`--kind は ${KINDS.join(" / ")} のいずれかで指定してください`);
}
const last = values.last === undefined ? undefined : /^\d+$/.test(values.last) ? Number(values.last) : Number.NaN;
if (last !== undefined && (!Number.isSafeInteger(last) || last < 1)) {
  fail("--last は正の整数で指定してください");
}

const { dataDir, timeZone } = loadDataConfig();
const date = values.date ?? formatDate(new Date(), timeZone);

let text: string;
try {
  text = readFileSync(join(devLogDir(dataDir), `${date}.jsonl`), "utf8");
} catch (error) {
  if (error instanceof Error && "code" in error && error.code === "ENOENT") {
    console.error(`${date} の記録はありません`);
    process.exit(0);
  }
  throw error;
}

const { records, skipped } = parseDevLog(text);
if (skipped > 0) console.error(`読めない行を ${skipped} 行飛ばしました`);
const selected = selectDevLogRecords(records, {
  ...(kind === undefined ? {} : { kind }),
  ...(values.channel === undefined ? {} : { channelId: values.channel }),
  ...(last === undefined ? {} : { last }),
});
if (selected.length === 0) {
  console.error(`${date} に該当する記録はありません`);
} else {
  console.log(selected.map((record) => formatDevLogRecord(record, timeZone)).join("\n\n"));
}
