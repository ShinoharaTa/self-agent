// タイムゾーン（SELF_AGENT_TZ）での日付の計算。/usage・#inbox の切り替え・session_open の 1 日の上限・リマインドの繰り返しで使う

type LocalDate = { year: number; month: number; day: number };

// Intl.DateTimeFormat は作るのが重い（リマインドの次の回の計算で何百回も呼ぶ）ので、タイムゾーンごとに使い回す
const dateFormatters = new Map<string, Intl.DateTimeFormat>();
const dateTimeFormatters = new Map<string, Intl.DateTimeFormat>();

function cached(cache: Map<string, Intl.DateTimeFormat>, timeZone: string, make: () => Intl.DateTimeFormat): Intl.DateTimeFormat {
  let formatter = cache.get(timeZone);
  if (formatter === undefined) {
    formatter = make();
    cache.set(timeZone, formatter);
  }
  return formatter;
}

/** その時刻の、timeZone での日付 */
function localDate(at: Date, timeZone: string): LocalDate {
  const parts = cached(dateFormatters, timeZone, () =>
    new Intl.DateTimeFormat("en-US", { timeZone, year: "numeric", month: "numeric", day: "numeric" }),
  ).formatToParts(at);
  const part = (type: Intl.DateTimeFormatPartTypes): number => Number(parts.find((p) => p.type === type)?.value);
  return { year: part("year"), month: part("month"), day: part("day") };
}

/** timeZone の UTC からのずれ（ミリ秒、その時刻での値） */
export function offsetMs(at: Date, timeZone: string): number {
  const parts = cached(dateTimeFormatters, timeZone, () =>
    new Intl.DateTimeFormat("en-US", {
      timeZone,
      hourCycle: "h23",
      year: "numeric",
      month: "numeric",
      day: "numeric",
      hour: "numeric",
      minute: "numeric",
      second: "numeric",
    }),
  ).formatToParts(at);
  const part = (type: Intl.DateTimeFormatPartTypes): number => Number(parts.find((p) => p.type === type)?.value);
  const wall = Date.UTC(part("year"), part("month") - 1, part("day"), part("hour"), part("minute"), part("second"));
  return wall - Math.floor(at.getTime() / 1000) * 1000;
}

/** timeZone でのその日の 0 時（daysBefore 日前の日付にずらせる）。夏時間でずれが変わる日も、0 時のずれで求め直す */
export function startOfLocalDay(at: Date, timeZone: string, daysBefore: number = 0): Date {
  const { year, month, day } = localDate(at, timeZone);
  // 月・年をまたぐ日付の繰り下がりは Date.UTC に任せる
  const midnightAsUtc = Date.UTC(year, month - 1, day - daysBefore);
  const first = midnightAsUtc - offsetMs(new Date(midnightAsUtc), timeZone);
  return new Date(midnightAsUtc - offsetMs(new Date(first), timeZone));
}

/** その時刻の、timeZone での日付（YYYY-MM-DD） */
export function formatDate(at: Date, timeZone: string): string {
  const { year, month, day } = localDate(at, timeZone);
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}
