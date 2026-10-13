import { test } from "node:test";
import assert from "node:assert/strict";
import {
  decodeRule,
  describeRule,
  formatLocalDateTime,
  formatRule,
  nextOccurrence,
  parseRule,
  wallClockToUtc,
  type RuleInput,
} from "../src/app/recurrence.ts";

const TOKYO = "Asia/Tokyo";
const NEW_YORK = "America/New_York";

/** オフセット付きの時刻を UTC の ISO に */
function iso(text: string): string {
  return new Date(text).toISOString();
}

test("parseRule: repeat・time・on を正規化した rule にする", () => {
  const cases: Array<[input: RuleInput, rule: string]> = [
    [{ repeat: "daily", time: "08:00" }, "daily@08:00"],
    [{ repeat: "weekdays", time: "23:59" }, "weekdays@23:59"],
    // 曜日は mon..sun の順に並べ、重複を除く。前後の空白と大文字は許す
    [{ repeat: "weekly", time: "08:00", on: "fri,mon,wed,mon" }, "weekly:mon,wed,fri@08:00"],
    [{ repeat: "weekly", time: "00:00", on: " Sun , MON " }, "weekly:mon,sun@00:00"],
    [{ repeat: "monthly", time: "09:00", on: "1" }, "monthly:1@09:00"],
    [{ repeat: "monthly", time: "09:00", on: "31" }, "monthly:31@09:00"],
    [{ repeat: "monthly", time: "09:00", on: "last" }, "monthly:last@09:00"],
  ];
  for (const [input, rule] of cases) assert.deepEqual(parseRule(input), { rule }, JSON.stringify(input));
});

test("parseRule: 壊れた形はエラーの種類を返す", () => {
  const cases: Array<[input: RuleInput, error: string]> = [
    [{}, "invalid_args"],
    [{ repeat: "yearly", time: "08:00" }, "invalid_args"],
    [{ repeat: "daily" }, "invalid_args"],
    [{ repeat: "daily", time: "08:00", on: "mon" }, "invalid_args"],
    [{ repeat: "weekly", time: "08:00" }, "invalid_args"],
    ...["", "mon,,wed", "monday", "月"].map((on): [RuleInput, string] => [{ repeat: "weekly", time: "08:00", on }, "invalid_args"]),
    ...["0", "32", "01", "last day", "1,15"].map((on): [RuleInput, string] => [{ repeat: "monthly", time: "09:00", on }, "invalid_args"]),
    ...["8:00", "24:00", "08:60", "0800", ""].map((time): [RuleInput, string] => [{ repeat: "daily", time }, "invalid_time"]),
  ];
  for (const [input, error] of cases) {
    const result = parseRule(input);
    assert.ok("error" in result && result.error === error, `${JSON.stringify(input)}: ${JSON.stringify(result)}`);
  }
});

test("decodeRule: 正規化した形だけを読み、formatRule で元に戻る", () => {
  for (const rule of ["daily@08:00", "weekdays@07:30", "weekly:mon,wed,fri@08:00", "weekly:sun@00:00", "monthly:15@09:00", "monthly:last@09:00"]) {
    const decoded = decodeRule(rule);
    assert.ok(decoded !== undefined, rule);
    assert.equal(formatRule(decoded), rule);
  }
  for (const rule of ["", "daily@8:00", "Daily@08:00", "daily:mon@08:00", "weekly@08:00", "weekly:wed,mon@08:00", "weekly:mon,mon@08:00", "weekly: mon@08:00", "monthly:01@09:00", "monthly:0@09:00", "hourly@08:00", "daily@08:00 "]) {
    assert.equal(decodeRule(rule), undefined, JSON.stringify(rule));
  }
});

test("describeRule: 日本語の表示", () => {
  const cases: Array<[rule: string, text: string]> = [
    ["daily@08:00", "毎日 8:00"],
    ["weekdays@08:05", "平日 8:05"],
    ["weekly:mon,wed@08:00", "毎週 月・水 8:00"],
    ["monthly:15@09:00", "毎月 15 日 9:00"],
    ["monthly:last@21:30", "毎月 末日 21:30"],
  ];
  for (const [rule, text] of cases) assert.equal(describeRule(rule), text, rule);
});

test("nextOccurrence: after より厳密に後の最初の回", () => {
  const cases: Array<[label: string, rule: string, timeZone: string, after: string, next: string]> = [
    ["daily: 当日のまだ先", "daily@08:00", TOKYO, "2026-10-13T07:00+09:00", "2026-10-13T08:00+09:00"],
    ["daily: 過ぎた時刻は翌日", "daily@08:00", TOKYO, "2026-10-13T09:00+09:00", "2026-10-14T08:00+09:00"],
    ["daily: ちょうど同じ時刻は翌日", "daily@08:00", TOKYO, "2026-10-13T08:00+09:00", "2026-10-14T08:00+09:00"],
    ["daily: UTC では前日でも timeZone の日付で数える", "daily@08:00", TOKYO, "2026-10-12T23:30Z", "2026-10-14T08:00+09:00"],
    ["weekdays: 木曜の後は金曜", "weekdays@08:00", TOKYO, "2026-10-15T09:00+09:00", "2026-10-16T08:00+09:00"],
    ["weekdays: 金曜の夜 → 月曜", "weekdays@08:00", TOKYO, "2026-10-16T20:00+09:00", "2026-10-19T08:00+09:00"],
    ["weekly: 火曜 → 水曜", "weekly:mon,wed@08:00", TOKYO, "2026-10-13T12:00+09:00", "2026-10-14T08:00+09:00"],
    ["weekly: 同じ日の後の時刻", "weekly:mon,wed@08:00", TOKYO, "2026-10-14T07:00+09:00", "2026-10-14T08:00+09:00"],
    ["weekly: 水曜の後は翌週の月曜", "weekly:mon,wed@08:00", TOKYO, "2026-10-14T09:00+09:00", "2026-10-19T08:00+09:00"],
    ["monthly: 15 日", "monthly:15@09:00", TOKYO, "2026-10-13T12:00+09:00", "2026-10-15T09:00+09:00"],
    ["monthly: 過ぎたら翌月", "monthly:15@09:00", TOKYO, "2026-10-15T09:00+09:00", "2026-11-15T09:00+09:00"],
    ["monthly: 31 日 → 2 月 28 日", "monthly:31@09:00", TOKYO, "2026-01-31T10:00+09:00", "2026-02-28T09:00+09:00"],
    ["monthly: 31 日 → 閏年の 2 月 29 日", "monthly:31@09:00", TOKYO, "2028-01-31T10:00+09:00", "2028-02-29T09:00+09:00"],
    ["monthly: 31 日 → 4 月 30 日", "monthly:31@09:00", TOKYO, "2026-03-31T10:00+09:00", "2026-04-30T09:00+09:00"],
    ["monthly: last", "monthly:last@09:00", TOKYO, "2026-10-13T12:00+09:00", "2026-10-31T09:00+09:00"],
    ["monthly: last の次は翌月の末日", "monthly:last@09:00", TOKYO, "2026-10-31T09:00+09:00", "2026-11-30T09:00+09:00"],
    ["monthly: 年またぎ", "monthly:15@09:00", TOKYO, "2026-12-20T09:00+09:00", "2027-01-15T09:00+09:00"],
    ["daily: 年またぎ", "daily@00:00", TOKYO, "2026-12-31T00:00+09:00", "2027-01-01T00:00+09:00"],
    ["New York: 夏時間をまたいでも同じ壁時計", "daily@08:00", NEW_YORK, "2026-03-07T09:00-05:00", "2026-03-08T08:00-04:00"],
    ["New York: 飛ぶ時刻は飛んだ後（ずれの差だけ後ろ）", "daily@02:30", NEW_YORK, "2026-03-07T12:00-05:00", "2026-03-08T03:30-04:00"],
    ["New York: 飛んだ日の次", "daily@02:30", NEW_YORK, "2026-03-08T03:30-04:00", "2026-03-09T02:30-04:00"],
    ["New York: 重なる時刻は早い方", "daily@01:30", NEW_YORK, "2026-10-31T12:00-04:00", "2026-11-01T01:30-04:00"],
    ["New York: 重なる時刻の遅い方では出さず翌日", "daily@01:30", NEW_YORK, "2026-11-01T01:30-04:00", "2026-11-02T01:30-05:00"],
  ];
  for (const [label, rule, timeZone, after, next] of cases) {
    assert.equal(nextOccurrence(rule, new Date(after), timeZone)?.toISOString(), iso(next), label);
  }
  assert.throws(() => nextOccurrence("weekly:wed,mon@08:00", new Date(), TOKYO));
});

test("wallClockToUtc: timeZone の壁時計を UTC に。形が違う・存在しない日付は undefined", () => {
  const cases: Array<[text: string, timeZone: string, utc: string | undefined]> = [
    ["2026-10-14 09:00", TOKYO, "2026-10-14T09:00+09:00"],
    ["2028-02-29 00:00", TOKYO, "2028-02-29T00:00+09:00"],
    ["2026-03-08 02:30", NEW_YORK, "2026-03-08T03:30-04:00"],
    ["2026-11-01 01:30", NEW_YORK, "2026-11-01T01:30-04:00"],
    ["2026-02-30 09:00", TOKYO, undefined],
    ["2026-04-31 09:00", TOKYO, undefined],
    ["2026-13-01 09:00", TOKYO, undefined],
    ["2026-10-14 24:00", TOKYO, undefined],
    ["2026-10-14 9:00", TOKYO, undefined],
    ["2026/10/14 09:00", TOKYO, undefined],
    ["2026-10-14T09:00", TOKYO, undefined],
  ];
  for (const [text, timeZone, utc] of cases) {
    assert.equal(wallClockToUtc(text, timeZone)?.toISOString(), utc === undefined ? undefined : iso(utc), text);
  }
});

test("formatLocalDateTime: timeZone の曜日付きの日時", () => {
  const cases: Array<[at: string, timeZone: string, text: string]> = [
    ["2026-10-14T00:00Z", TOKYO, "2026-10-14(水) 09:00"],
    ["2026-10-12T15:00Z", TOKYO, "2026-10-13(火) 00:00"],
    ["2026-11-01T06:30Z", NEW_YORK, "2026-11-01(日) 01:30"],
  ];
  for (const [at, timeZone, text] of cases) assert.equal(formatLocalDateTime(new Date(at), timeZone), text, at);
});
