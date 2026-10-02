import type { SessionState } from "../../store/guild-settings.ts";
import type { TopicSession, TopicSessionStore } from "../../store/topic-sessions.ts";
import type { CommandHandler } from "../interactions.ts";
import { stateCategoryName } from "./setup.ts";

/** Discord の 1 メッセージの文字数の上限 */
export const MESSAGE_MAX_LENGTH = 2000;
/** 0 件の見出しの下に出す */
export const EMPTY_SECTION_TEXT = "なし";

/** 一覧に出す件数の上限（進行中・待ちは最終発言、完了は閉じた時刻の新しい順） */
export const SESSION_LIST_LIMITS: Readonly<Record<SessionState, number>> = { active: 25, waiting: 25, done: 10 };

const HOUR_MS = 60 * 60 * 1000;

export type SessionsDeps = {
  topicSessions: Pick<TopicSessionStore, "listByState">;
};

/**
 * 本文が limit 字を超えるなら、末尾の項目から削って「ほか n 件」を足す（render の omitted に削った件数を渡す）。
 * 本文と、削らずに残った項目を返す
 */
export function fitItems<T>(
  items: readonly T[],
  render: (shown: readonly T[], omitted: number) => string,
  limit: number = MESSAGE_MAX_LENGTH,
): { text: string; shown: T[] } {
  const shown = [...items];
  let text = render(shown, 0);
  while (text.length > limit && shown.length > 0) {
    shown.pop();
    text = render(shown, items.length - shown.length);
  }
  return { text, shown };
}

export function omittedText(omitted: number): string {
  return `ほか ${omitted} 件`;
}

/** 経過時間の表示。1 時間未満は「1 時間以内」、24 時間未満は「n 時間前」、それ以上は「n 日前」（切り捨て） */
export function formatElapsed(fromIso: string, now: Date): string {
  const hours = Math.floor(Math.max(0, now.getTime() - new Date(fromIso).getTime()) / HOUR_MS);
  if (hours < 1) return "1 時間以内";
  if (hours < 24) return `${hours} 時間前`;
  return `${Math.floor(hours / 24)} 日前`;
}

/** 一覧の 1 行: `<#id> 題名（最終 n 時間前）` */
export function sessionLine(session: TopicSession, now: Date): string {
  return `<#${session.channelId}> ${session.title}（最終 ${formatElapsed(session.lastActivityAt, now)}）`;
}

/**
 * 状態ごとの見出しの下にセッションを並べた本文（/sessions、ホームパネルの [待ちのセッション]）。0 件の見出しには「なし」。
 * 2000 字を超えるなら末尾から削って「ほか n 件」を足す（削って空になった見出しは出さない）
 */
export function sessionListText(
  topicSessions: SessionsDeps["topicSessions"],
  guildId: string,
  states: readonly SessionState[],
  now: Date,
): string {
  const lists = states.map((state) => ({
    state,
    sessions: topicSessions.listByState(guildId, state, SESSION_LIST_LIMITS[state]),
  }));
  const items = lists.flatMap(({ state, sessions }) => sessions.map((session) => ({ state, session })));
  return fitItems(items, (shown, omitted) => {
    const blocks: string[] = [];
    for (const { state, sessions } of lists) {
      const lines = shown.filter((item) => item.state === state).map((item) => sessionLine(item.session, now));
      // 削って空になった見出しは出さない（元から 0 件なら「なし」）
      if (lines.length === 0 && sessions.length > 0) continue;
      blocks.push([`**${stateCategoryName(state)}**`, ...(lines.length === 0 ? [EMPTY_SECTION_TEXT] : lines)].join("\n"));
    }
    if (omitted > 0) blocks.push(omittedText(omitted));
    return blocks.join("\n\n");
  }).text;
}

/** `/sessions`: 進行中・待ち・完了（最近の分）のセッションをリンク付きで本人にだけ表示する */
export function createSessionsCommand(deps: SessionsDeps): CommandHandler {
  const { topicSessions } = deps;
  return {
    def: { name: "sessions", description: "進行中・待ち・完了（最近の分）のセッションの一覧を表示します" },
    async handle(interaction, responder) {
      // 許可サーバー以外（DM を含む）は interactions.ts で弾いている
      const guildId = interaction.guildId;
      if (guildId === null) throw new Error("サーバー外で /sessions が呼ばれました");
      const text = sessionListText(topicSessions, guildId, ["active", "waiting", "done"], interaction.createdAt);
      await responder.reply({ text, ephemeral: true });
    },
  };
}
