// GET /api/devlog/days・/api/devlog（docs/plan/web-ui.md §3.4）。dev モードの会話ログ（<dataDir>/devlog/<YYYY-MM-DD>.jsonl）を
// npm run devlog と同じ形で読む。dev モードでなければどちらも 404。記録は本文・チャンネル ID を含むので log には出さない
import { closeSync, constants, fstatSync, openSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { RunContext } from "../../agent/runner.ts";
import { formatDate } from "../../app/time.ts";
import { type Config, DEFAULT_PERSONA_ID } from "../../config.ts";
import { formatDevLogRecord, parseDevLog, selectDevLogRecords } from "../../devlog/format.ts";
import { devLogDir, type DevLogRecord } from "../../devlog/log.ts";
import type { Route, RouteResult } from "../server.ts";

/** /api/devlog の last の既定と上限 */
export const DEVLOG_DEFAULT_LAST = 20;
export const DEVLOG_MAX_LAST = 200;

const KINDS: readonly RunContext["kind"][] = ["inbox", "tasks", "session"];
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const FILE_PATTERN = /^(\d{4}-\d{2}-\d{2})\.jsonl$/;

export type DevlogRouteDeps = {
  cfg: Pick<Config, "devMode" | "dataDir" | "timeZone">;
  now: () => Date;
};

const BAD_REQUEST: RouteResult = { status: 400, json: { error: "bad_request" } };
const NOT_FOUND: RouteResult = { status: 404, json: { error: "not_found" } };

/** 読めない記録の text（形は合っているが npm run devlog の整形で投げた行） */
export const DEVLOG_UNREADABLE_TEXT = "（読めない記録）";

/**
 * 通常のファイルなら中身。無い・通常のファイルでない（ディレクトリ・symlink・FIFO など。/days が数えないもの）なら undefined。
 * symlink はたどらず、FIFO で待たないよう O_NOFOLLOW・O_NONBLOCK で開いてから確かめる
 */
function readIfExists(path: string): string | undefined {
  let fd: number;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ELOOP" || code === "ENOTDIR") return undefined;
    throw error;
  }
  try {
    if (!fstatSync(fd).isFile()) return undefined;
    return readFileSync(fd, "utf8");
  } finally {
    closeSync(fd);
  }
}

/** npm run devlog と同じ text。整形で投げたら（steps の要素が壊れているなど）DEVLOG_UNREADABLE_TEXT */
function formatOrUnreadable(record: DevLogRecord, timeZone: string): string {
  try {
    return formatDevLogRecord(record, timeZone);
  } catch {
    return DEVLOG_UNREADABLE_TEXT;
  }
}

/** 空でない行の数 */
function countLines(text: string): number {
  return text.split("\n").filter((line) => line.trim() !== "").length;
}

/** 表示に要る項目がそろった記録か（壊れた行で 500 にしない） */
function isRecord(record: DevLogRecord): boolean {
  return (
    typeof record === "object" &&
    record !== null &&
    typeof record.at === "string" &&
    typeof record.prompt === "string" &&
    Array.isArray(record.steps) &&
    typeof record.result === "object" &&
    record.result !== null
  );
}

export function devlogRoutes(deps: DevlogRouteDeps): Route[] {
  const { cfg, now } = deps;
  const dir = devLogDir(cfg.dataDir);
  return [
    {
      method: "GET",
      pattern: /^\/api\/devlog\/days$/,
      handle: async () => {
        if (!cfg.devMode) return NOT_FOUND;
        let entries;
        try {
          entries = readdirSync(dir, { withFileTypes: true });
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "ENOENT") return { status: 200, json: [] };
          throw error;
        }
        // 新しい日から。件数は行数（壊れた行も数える）
        const days = entries
          .filter((entry) => entry.isFile() && FILE_PATTERN.test(entry.name))
          .map((entry) => entry.name.slice(0, -".jsonl".length))
          .sort()
          .reverse()
          .map((date) => ({ date, count: countLines(readIfExists(join(dir, `${date}.jsonl`)) ?? "") }));
        return { status: 200, json: days };
      },
    },
    {
      method: "GET",
      pattern: /^\/api\/devlog$/,
      handle: async ({ query }) => {
        if (!cfg.devMode) return NOT_FOUND;
        const date = query.get("date") ?? formatDate(now(), cfg.timeZone);
        const kindText = query.get("kind") ?? "";
        const kind = KINDS.find((candidate) => candidate === kindText);
        const channel = query.get("channel") ?? "";
        const persona = query.get("persona") ?? "";
        const lastText = query.get("last");
        const last = lastText === null ? DEVLOG_DEFAULT_LAST : /^\d{1,4}$/.test(lastText) ? Number(lastText) : 0;
        if (
          !DATE_PATTERN.test(date) ||
          (kindText !== "" && kind === undefined) ||
          (channel !== "" && !/^\d{1,25}$/.test(channel)) ||
          (persona !== "" && !/^[a-z0-9]{1,12}$/.test(persona)) ||
          last < 1 ||
          last > DEVLOG_MAX_LAST
        ) {
          return BAD_REQUEST;
        }
        const text = readIfExists(join(dir, `${date}.jsonl`));
        if (text === undefined) return { status: 200, json: { date, records: [] } };
        const selected = selectDevLogRecords(parseDevLog(text).records.filter(isRecord), {
          ...(kind === undefined ? {} : { kind }),
          ...(channel === "" ? {} : { channelId: channel }),
          ...(persona === "" ? {} : { persona }),
          last,
        });
        // 古い順（ファイルの順。npm run devlog と同じ）
        const records = selected.map((record) => ({
          at: record.at,
          kind: record.kind,
          channelId: record.channelId,
          persona: record.persona ?? DEFAULT_PERSONA_ID,
          ok: record.result.ok,
          durationMs: record.durationMs,
          toolCalls: record.result.toolCalls,
          text: formatOrUnreadable(record, cfg.timeZone),
        }));
        return { status: 200, json: { date, records } };
      },
    },
  ];
}
