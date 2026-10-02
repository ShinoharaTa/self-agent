// ターンごとの prompt。日時はシステムプロンプトではなく、ここ（ユーザーメッセージの先頭）にだけ入れる

/** 例: `[2026-10-02(金) 09:12 JST #inbox]\n<content>` */
export function buildTurnPrompt(content: string, at: Date, timeZone: string, channelName: string = "inbox"): string {
  const parts = new Intl.DateTimeFormat("ja-JP", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
    timeZoneName: "short",
  }).formatToParts(at);
  const part = (type: Intl.DateTimeFormatPartTypes): string => parts.find((p) => p.type === type)?.value ?? "";
  const header =
    `${part("year")}-${part("month")}-${part("day")}(${part("weekday")}) ` +
    `${part("hour")}:${part("minute")} ${part("timeZoneName")} #${channelName}`;
  return `[${header}]\n${content}`;
}
