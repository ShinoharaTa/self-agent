// usage_log（ターンごとのトークン）を 1 ターン 1 行で出す。プロンプトキャッシュが効いているか（読み・書き）を見るためのもの。
// npm run usage -- [--date YYYY-MM-DD] [--last N] [--kind <種類>] [--steps]（既定は今日・最後の 20 件・全部）。
// 読む設定は SELF_AGENT_DATA_DIR と SELF_AGENT_TZ だけ（トークンが無くても動く）。
// DB は動いているボットのものなので、読み取り専用で開いてマイグレーションしない（openDb は使わない）
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { parseArgs } from "node:util";
import { formatDate, offsetMs, startOfLocalDay } from "../app/time.ts";
import { formatUsageEntry, formatUsageSteps, formatUsageTotals } from "../app/usage-report.ts";
import { loadDataConfig } from "../config.ts";
import { UsageStore } from "../store/usage.ts";

/** usage_log に種類・steps の列ができた user_version */
const REQUIRED_USER_VERSION = 17;
const DEFAULT_LAST = 20;
const USAGE = "使い方: npm run usage -- [--date YYYY-MM-DD] [--last N] [--kind <種類>] [--steps] [--help]";

function fail(message: string): number {
  console.error(message);
  console.error(USAGE);
  return 1;
}

export async function main(argv: readonly string[]): Promise<number> {
  let values: { date?: string; last?: string; kind?: string; steps?: boolean; help?: boolean };
  try {
    ({ values } = parseArgs({
      args: [...argv],
      options: {
        date: { type: "string" },
        last: { type: "string" },
        kind: { type: "string" },
        steps: { type: "boolean" },
        help: { type: "boolean" },
      },
    }));
  } catch (error) {
    return fail(error instanceof Error ? error.message : String(error));
  }

  if (values.help === true) {
    console.log(USAGE);
    return 0;
  }
  if (values.date !== undefined && !/^\d{4}-\d{2}-\d{2}$/.test(values.date)) {
    return fail("--date は YYYY-MM-DD で指定してください");
  }
  const last = values.last === undefined ? DEFAULT_LAST : /^\d+$/.test(values.last) ? Number(values.last) : Number.NaN;
  if (!Number.isSafeInteger(last) || last < 1) {
    return fail("--last は正の整数で指定してください");
  }

  const { dataDir, timeZone } = loadDataConfig();
  const date = values.date ?? formatDate(new Date(), timeZone);

  // その日（timeZone）の正午の時刻から、その日の 0 時と翌日の 0 時を求める
  const [year, month, day] = date.split("-").map(Number) as [number, number, number];
  const noonAsUtc = Date.UTC(year, month - 1, day, 12);
  const noon = new Date(noonAsUtc - offsetMs(new Date(noonAsUtc), timeZone));
  if (formatDate(noon, timeZone) !== date) {
    return fail("--date が正しい日付ではありません");
  }
  const since = startOfLocalDay(noon, timeZone);
  const until = startOfLocalDay(noon, timeZone, -1);

  const path = join(dataDir, "self-agent.db");
  let db: DatabaseSync;
  try {
    db = new DatabaseSync(path, { readOnly: true });
  } catch (error) {
    console.error(`DB を開けませんでした（${path}）: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
  const userVersion = Number(db.prepare("PRAGMA user_version").get()?.user_version ?? 0);
  if (userVersion < REQUIRED_USER_VERSION) {
    console.error(`DB が古いので、ボットを再起動してから使ってください（user_version=${userVersion}）`);
    db.close();
    return 1;
  }

  const entries = new UsageStore(db).listRecent({
    since,
    until,
    ...(values.kind === undefined ? {} : { kind: values.kind }),
    limit: last,
  });
  db.close();

  if (entries.length === 0) {
    console.error(`${date} に該当する記録はありません`);
  } else {
    const lines: string[] = [];
    for (const entry of entries) {
      lines.push(formatUsageEntry(entry, timeZone));
      if (values.steps === true && entry.steps !== null) lines.push(...formatUsageSteps(entry.steps));
    }
    lines.push(formatUsageTotals(entries));
    console.log(lines.join("\n"));
  }
  return 0;
}
