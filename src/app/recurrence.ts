// リマインドの繰り返し（毎日・平日・曜日・毎月 n 日・毎月末日と HH:MM）と、タイムゾーン（SELF_AGENT_TZ）の壁時計と UTC の変換。
// DB には正規化した 1 本の文字列（rule）で保存する: daily@08:00 / weekdays@08:00 / weekly:mon,wed@08:00 / monthly:15@09:00 / monthly:last@09:00

import { offsetMs } from "./time.ts";

/** 曜日（getUTCDay の順ではなく mon..sun の順で並べる） */
const WEEKDAYS = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"] as const;
export type Weekday = (typeof WEEKDAYS)[number];
const WEEKDAY_LABELS: Record<Weekday, string> = { mon: "月", tue: "火", wed: "水", thu: "木", fri: "金", sat: "土", sun: "日" };
/** getUTCDay（0 = 日曜）の順の表示 */
const DAY_OF_WEEK_LABELS = ["日", "月", "火", "水", "木", "金", "土"];

/** 次の回を探す日数の上限 */
const SEARCH_DAYS = 400;

const MINUTE_MS = 60_000;
const DAY_MS = 24 * 60 * MINUTE_MS;

export type RuleTime = { hour: number; minute: number };

export type Rule =
  | { repeat: "daily" | "weekdays"; time: RuleTime }
  /** days は mon..sun の順で重複なし、1〜7 個 */
  | { repeat: "weekly"; days: Weekday[]; time: RuleTime }
  /** day は 1〜31 か末日（last）。その月に無い日は末日に寄せる */
  | { repeat: "monthly"; day: number | "last"; time: RuleTime };

export type RuleInput = { repeat?: string; time?: string; on?: string };

/** invalid_args は組み合わせ・repeat・on の誤り、invalid_time は time の形の誤り */
export type ParseRuleResult = { rule: string } | { error: "invalid_args" | "invalid_time"; message: string };

const TIME_PATTERN = /^([01]\d|2[0-3]):([0-5]\d)$/;
const MONTH_DAY_PATTERN = /^([1-9]|[12]\d|3[01])$/;

function parseTime(text: string): RuleTime | undefined {
  const match = TIME_PATTERN.exec(text);
  return match === null ? undefined : { hour: Number(match[1]), minute: Number(match[2]) };
}

function formatTime(time: RuleTime): string {
  return `${String(time.hour).padStart(2, "0")}:${String(time.minute).padStart(2, "0")}`;
}

/** カンマ区切りの曜日を mon..sun の順に並べ、重複を除く。空の要素・知らない曜日があれば undefined */
function parseWeekdays(text: string): Weekday[] | undefined {
  const names = text.split(",").map((name) => name.trim().toLowerCase());
  if (names.some((name) => !(WEEKDAYS as readonly string[]).includes(name))) return undefined;
  return WEEKDAYS.filter((day) => names.includes(day));
}

function parseMonthDay(text: string): number | "last" | undefined {
  if (text === "last") return "last";
  return MONTH_DAY_PATTERN.test(text) ? Number(text) : undefined;
}

/** ツールの repeat・time・on から正規化した rule を作る。daily・weekdays に on があれば invalid_args */
export function parseRule(input: RuleInput): ParseRuleResult {
  const { repeat, on } = input;
  if (repeat !== "daily" && repeat !== "weekdays" && repeat !== "weekly" && repeat !== "monthly") {
    return { error: "invalid_args", message: "repeat は daily・weekdays・weekly・monthly のどれかです" };
  }
  if (input.time === undefined) return { error: "invalid_args", message: "repeat には time（HH:MM）が必要です" };
  const time = parseTime(input.time.trim());
  if (time === undefined) return { error: "invalid_time", message: "time は HH:MM（00:00〜23:59）で指定してください" };
  if (repeat === "daily" || repeat === "weekdays") {
    if (on !== undefined) return { error: "invalid_args", message: `${repeat} には on を付けません` };
    return { rule: formatRule({ repeat, time }) };
  }
  if (on === undefined) return { error: "invalid_args", message: `${repeat} には on が必要です` };
  if (repeat === "weekly") {
    const days = parseWeekdays(on);
    if (days === undefined) return { error: "invalid_args", message: "weekly の on は mon,wed のような曜日のカンマ区切りです" };
    return { rule: formatRule({ repeat, days, time }) };
  }
  const day = parseMonthDay(on.trim().toLowerCase());
  if (day === undefined) return { error: "invalid_args", message: "monthly の on は 1〜31 か last です" };
  return { rule: formatRule({ repeat, day, time }) };
}

/** 正規化した rule の文字列 */
export function formatRule(rule: Rule): string {
  const time = formatTime(rule.time);
  switch (rule.repeat) {
    case "daily":
    case "weekdays":
      return `${rule.repeat}@${time}`;
    case "weekly":
      return `weekly:${WEEKDAYS.filter((day) => rule.days.includes(day)).join(",")}@${time}`;
    case "monthly":
      return `monthly:${rule.day}@${time}`;
  }
}

/** 保存した rule を読む。正規化した形（formatRule の出力）でなければ undefined */
export function decodeRule(text: string): Rule | undefined {
  const match = /^(daily|weekdays|weekly|monthly)(?::([^@]+))?@(.+)$/.exec(text);
  if (match === null) return undefined;
  const [, repeat, on, timeText] = match;
  const parsed = parseRule({ repeat, time: timeText, on });
  if ("error" in parsed || parsed.rule !== text) return undefined;
  const time = parseTime(timeText!)!;
  if (repeat === "daily" || repeat === "weekdays") return { repeat, time };
  if (repeat === "weekly") return { repeat, days: parseWeekdays(on!)!, time };
  return { repeat: "monthly", day: parseMonthDay(on!)!, time };
}

function decodeOrThrow(text: string): Rule {
  const rule = decodeRule(text);
  if (rule === undefined) throw new Error("繰り返しの形が正しくありません");
  return rule;
}

/** 日本語の表示。例: 毎日 8:00 / 平日 8:00 / 毎週 月・水 8:00 / 毎月 15 日 9:00 / 毎月 末日 9:00 */
export function describeRule(text: string): string {
  const rule = decodeOrThrow(text);
  const time = `${rule.time.hour}:${String(rule.time.minute).padStart(2, "0")}`;
  switch (rule.repeat) {
    case "daily":
      return `毎日 ${time}`;
    case "weekdays":
      return `平日 ${time}`;
    case "weekly":
      return `毎週 ${rule.days.map((day) => WEEKDAY_LABELS[day]).join("・")} ${time}`;
    case "monthly":
      return `毎月 ${rule.day === "last" ? "末日" : `${rule.day} 日`} ${time}`;
  }
}

/** その年月の日数（month は 1〜12） */
function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

/** その日付が rule に合うか（dayStart は日付の 0 時を UTC として表したもの） */
function matches(rule: Rule, dayStart: Date): boolean {
  switch (rule.repeat) {
    case "daily":
      return true;
    case "weekdays": {
      const dow = dayStart.getUTCDay();
      return dow >= 1 && dow <= 5;
    }
    case "weekly":
      return rule.days.includes(WEEKDAYS[(dayStart.getUTCDay() + 6) % 7]!);
    case "monthly": {
      const last = daysInMonth(dayStart.getUTCFullYear(), dayStart.getUTCMonth() + 1);
      const day = rule.day === "last" ? last : Math.min(rule.day, last);
      return dayStart.getUTCDate() === day;
    }
  }
}

/**
 * timeZone の壁時計（wallAsUtc は壁時計の値を UTC として表したミリ秒）に当たる時刻。
 * 夏時間で飛ぶ時刻は、飛ぶ前のずれで求める（飛んだ後の壁時計ではずれの差だけ後ろになる）。重なる時刻は早い方
 */
function wallToInstant(wallAsUtc: number, timeZone: string): Date {
  // 前後 1 日のずれを候補にする（切り替えは 1 日に 1 回までとみなす）
  const before = offsetMs(new Date(wallAsUtc - DAY_MS), timeZone);
  const after = offsetMs(new Date(wallAsUtc + DAY_MS), timeZone);
  const valid = [before, after]
    .map((offset) => wallAsUtc - offset)
    .filter((instant) => instant + offsetMs(new Date(instant), timeZone) === wallAsUtc);
  if (valid.length > 0) return new Date(Math.min(...valid));
  return new Date(wallAsUtc - before);
}

const WALL_CLOCK_PATTERN = /^(\d{4})-(\d{2})-(\d{2}) ([01]\d|2[0-3]):([0-5]\d)$/;

/** timeZone の壁時計 "YYYY-MM-DD HH:MM" を UTC の時刻に直す。形が違う・存在しない日付（2026-02-30）・1970 年より前なら undefined */
export function wallClockToUtc(text: string, timeZone: string): Date | undefined {
  const match = WALL_CLOCK_PATTERN.exec(text);
  if (match === null) return undefined;
  const [year, month, day, hour, minute] = match.slice(1).map(Number) as [number, number, number, number, number];
  // Date.UTC は 0〜99 年を 1900 年代に読み替えるので、古い年はまとめて弾く
  if (year < 1970 || month < 1 || month > 12 || day < 1 || day > daysInMonth(year, month)) return undefined;
  return wallToInstant(Date.UTC(year, month - 1, day, hour, minute), timeZone);
}

/** その時刻の timeZone の壁時計を UTC として表したもの（getUTC* で年月日・時分を読む） */
function toWall(at: Date, timeZone: string): Date {
  return new Date(at.getTime() + offsetMs(at, timeZone));
}

/** 表示用の timeZone の日時。例: 2026-10-14(水) 09:00 */
export function formatLocalDateTime(at: Date, timeZone: string): string {
  const wall = toWall(at, timeZone);
  const pad = (n: number): string => String(n).padStart(2, "0");
  return (
    `${wall.getUTCFullYear()}-${pad(wall.getUTCMonth() + 1)}-${pad(wall.getUTCDate())}` +
    `(${DAY_OF_WEEK_LABELS[wall.getUTCDay()]}) ${pad(wall.getUTCHours())}:${pad(wall.getUTCMinutes())}`
  );
}

/**
 * after より厳密に後の最初の回（UTC）。after の timeZone の日付から 1 日ずつ進め、合う日の HH:MM を UTC に直す。
 * 400 日先までに無ければ null。rule が正規化した形でなければ例外
 */
export function nextOccurrence(rule: string, after: Date, timeZone: string): Date | null {
  const decoded = decodeOrThrow(rule);
  const wall = toWall(after, timeZone);
  const firstDay = Date.UTC(wall.getUTCFullYear(), wall.getUTCMonth(), wall.getUTCDate());
  for (let i = 0; i <= SEARCH_DAYS; i++) {
    const dayStart = new Date(firstDay + i * DAY_MS);
    if (!matches(decoded, dayStart)) continue;
    const instant = wallToInstant(
      dayStart.getTime() + (decoded.time.hour * 60 + decoded.time.minute) * MINUTE_MS,
      timeZone,
    );
    if (instant.getTime() > after.getTime()) return instant;
  }
  return null;
}
