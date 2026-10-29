// GET /api/usage・/api/usage/days（docs/plan/web-ui.md §3.4）。日付（SELF_AGENT_TZ）ごとのターンの行と人格ごとの合計、日ごとのターン数と入力
import { type Config, DEFAULT_PERSONA_ID } from "../../config.ts";
import { GUEST_BOT_NAME, GUEST_PERSONA_ID } from "../../guest/constants.ts";
import type { AttachmentStore } from "../../store/attachments.ts";
import type { UsageEntry, UsageStore } from "../../store/usage.ts";
import { DEFAULT_PERSONA_LABEL } from "../../app/personas.ts";
import { formatDate, offsetMs, startOfLocalDay } from "../../app/time.ts";
import type { Route, RouteResult } from "../server.ts";

/** /api/usage の last の既定と上限 */
export const USAGE_DEFAULT_LAST = 20;
export const USAGE_MAX_LAST = 200;
/** /api/usage/days の n の既定と上限 */
export const USAGE_DEFAULT_DAYS = 30;
export const USAGE_MAX_DAYS = 366;

export type UsageRouteDeps = {
  cfg: Pick<Config, "timeZone" | "personas" | "guest">;
  usage: Pick<UsageStore, "listRecent" | "summarize" | "sumOutputTokens" | "listDays">;
  attachments: Pick<AttachmentStore, "totals">;
  now: () => Date;
};

const BAD_REQUEST: RouteResult = { status: 400, json: { error: "bad_request" } };

/** 1〜max の整数。省略は fallback、それ以外の形は undefined */
function boundedInt(value: string | null, fallback: number, max: number): number | undefined {
  if (value === null) return fallback;
  if (!/^\d+$/.test(value)) return undefined;
  const parsed = Number(value);
  return parsed >= 1 && parsed <= max ? parsed : undefined;
}

/** YYYY-MM-DD（timeZone の日付）のその日の 0 時と翌日の 0 時。形が違う・無い日付なら undefined（npm run usage と同じ求め方） */
export function localDayRange(date: string, timeZone: string): { since: Date; until: Date } | undefined {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return undefined;
  const [year, month, day] = date.split("-").map(Number) as [number, number, number];
  const noonAsUtc = Date.UTC(year, month - 1, day, 12);
  const noon = new Date(noonAsUtc - offsetMs(new Date(noonAsUtc), timeZone));
  if (formatDate(noon, timeZone) !== date) return undefined;
  return { since: startOfLocalDay(noon, timeZone), until: startOfLocalDay(noon, timeZone, -1) };
}

/** 行から steps（ステップごとの内訳）を除いたもの */
function withoutSteps(entry: UsageEntry): Omit<UsageEntry, "steps"> {
  const { steps: _steps, ...rest } = entry;
  return rest;
}

export function usageRoutes(deps: UsageRouteDeps): Route[] {
  const { cfg, usage, attachments, now } = deps;
  return [
    {
      method: "GET",
      pattern: /^\/api\/usage$/,
      handle: async ({ query }) => {
        const date = query.get("date") ?? formatDate(now(), cfg.timeZone);
        const range = localDayRange(date, cfg.timeZone);
        const last = boundedInt(query.get("last"), USAGE_DEFAULT_LAST, USAGE_MAX_LAST);
        if (range === undefined || last === undefined) return BAD_REQUEST;
        const kind = query.get("kind") ?? "";
        const rows = usage
          .listRecent({ since: range.since, until: range.until, ...(kind === "" ? {} : { kind }), limit: last })
          .map(withoutSteps);
        // 既定の人格 → 足した人格 → ゲスト（有効なとき）の順
        const personas = [
          { persona: DEFAULT_PERSONA_ID, name: DEFAULT_PERSONA_LABEL },
          ...cfg.personas.map((persona) => ({ persona: persona.id, name: persona.name })),
          ...(cfg.guest ? [{ persona: GUEST_PERSONA_ID, name: GUEST_BOT_NAME }] : []),
        ];
        const totals = personas.map(({ persona, name }) => ({
          persona,
          name,
          summary: usage.summarize(range.since, persona, range.until),
          outputTokens: usage.sumOutputTokens(range.since, persona, range.until),
        }));
        return { status: 200, json: { date, rows, totals, attachments: attachments.totals() } };
      },
    },
    {
      method: "GET",
      pattern: /^\/api\/usage\/days$/,
      handle: async ({ query }) => {
        const n = boundedInt(query.get("n"), USAGE_DEFAULT_DAYS, USAGE_MAX_DAYS);
        if (n === undefined) return BAD_REQUEST;
        const at = now();
        // 今日を含めた n 日。記録の無い日は 0 で埋め、古い順に
        const recorded = new Map(usage.listDays(startOfLocalDay(at, cfg.timeZone, n - 1), cfg.timeZone).map((day) => [day.date, day]));
        const days = [];
        for (let i = n - 1; i >= 0; i--) {
          const date = formatDate(startOfLocalDay(at, cfg.timeZone, i), cfg.timeZone);
          days.push(recorded.get(date) ?? { date, turns: 0, inputTokens: 0 });
        }
        return { status: 200, json: days };
      },
    },
  ];
}
