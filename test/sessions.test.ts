import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HELP_TEXT } from "../src/app/commands/help.ts";
import {
  createSessionsCommand,
  fitItems,
  formatElapsed,
  MESSAGE_MAX_LENGTH,
  sessionListText,
} from "../src/app/commands/sessions.ts";
import type { Interaction, InteractionResponder, ModalDef, OutgoingMessage } from "../src/discord/gateway.ts";
import { openDb } from "../src/store/db.ts";
import { TopicSessionStore } from "../src/store/topic-sessions.ts";

const NOW = new Date("2026-10-02T00:12:00Z");
const HOUR = 60 * 60 * 1000;

type ResponderCall =
  | { method: "defer"; ephemeral: boolean }
  | { method: "deferUpdate" }
  | { method: "reply" | "update"; message: OutgoingMessage }
  | { method: "showModal"; modal: ModalDef };

class FakeResponder implements InteractionResponder {
  calls: ResponderCall[] = [];

  async defer(ephemeral: boolean): Promise<void> {
    this.calls.push({ method: "defer", ephemeral });
  }
  async deferUpdate(): Promise<void> {
    this.calls.push({ method: "deferUpdate" });
  }
  async reply(message: OutgoingMessage): Promise<void> {
    this.calls.push({ method: "reply", message });
  }
  async update(message: OutgoingMessage): Promise<void> {
    this.calls.push({ method: "update", message });
  }
  async showModal(modal: ModalDef): Promise<void> {
    this.calls.push({ method: "showModal", modal });
  }
}

const SESSIONS: Extract<Interaction, { kind: "command" }> = {
  kind: "command",
  name: "sessions",
  options: {},
  guildId: "guild-1",
  channelId: "inbox-1",
  userId: "owner-1",
  createdAt: NOW,
};

function hoursAgo(hours: number): Date {
  return new Date(NOW.getTime() - hours * HOUR);
}

function setup(t: TestContext) {
  const dir = mkdtempSync(join(tmpdir(), "self-agent-test-"));
  const db = openDb(join(dir, "self-agent.db"));
  t.after(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const clock = { now: NOW };
  const topicSessions = new TopicSessionStore(db, () => clock.now);

  /** 最終発言が lastActivity のセッションを作り、state にする（完了は closedAt に閉じる） */
  const add = (
    channelId: string,
    title: string,
    state: "active" | "waiting" | "done" | "deleted",
    lastActivity: Date,
    closedAt: Date = lastActivity,
    guildId: string = "guild-1",
  ): void => {
    clock.now = lastActivity;
    topicSessions.create({ channelId, guildId, title, categoryId: "category-1" });
    if (state === "waiting") topicSessions.setWaiting(channelId);
    if (state === "done" || state === "deleted") {
      clock.now = closedAt;
      topicSessions.close(channelId, "要約");
    }
    if (state === "deleted") db.prepare("UPDATE sessions SET state = 'deleted' WHERE channel_id = ?").run(channelId);
    clock.now = NOW;
  };

  const runSessions = async (): Promise<ResponderCall[]> => {
    const responder = new FakeResponder();
    await createSessionsCommand({ topicSessions }).handle(SESSIONS, responder);
    return responder.calls;
  };
  return { topicSessions, add, runSessions };
}

test("formatElapsed: 1 時間未満は「1 時間以内」、24 時間未満は「n 時間前」、それ以上は「n 日前」（切り捨て）", () => {
  const at = (ms: number): string => new Date(NOW.getTime() - ms).toISOString();
  assert.equal(formatElapsed(at(0), NOW), "1 時間以内");
  assert.equal(formatElapsed(at(HOUR - 1), NOW), "1 時間以内");
  assert.equal(formatElapsed(at(HOUR), NOW), "1 時間前");
  assert.equal(formatElapsed(at(24 * HOUR - 1), NOW), "23 時間前");
  assert.equal(formatElapsed(at(24 * HOUR), NOW), "1 日前");
  assert.equal(formatElapsed(at(48 * HOUR - 1), NOW), "1 日前");
  assert.equal(formatElapsed(at(48 * HOUR), NOW), "2 日前");
  assert.equal(formatElapsed(at(40 * 24 * HOUR), NOW), "40 日前");
  // 時計のずれで未来の時刻になっていても負にしない
  assert.equal(formatElapsed(at(-5 * HOUR), NOW), "1 時間以内");
});

test("TopicSessionStore.listByState: そのサーバーのその状態だけを、進行中・待ちは最終発言、完了は閉じた時刻の新しい順に limit 件まで", (t) => {
  const { topicSessions, add } = setup(t);
  add("a-old", "古い", "active", hoursAgo(30));
  add("a-new", "新しい", "active", hoursAgo(2));
  add("a-mid", "中間", "active", hoursAgo(5));
  add("a-other", "別サーバー", "active", hoursAgo(1), undefined, "guild-2");
  add("w-1", "待ち", "waiting", hoursAgo(3));
  // 完了は閉じた順。最終発言の順とは逆にする
  add("d-closed-early", "先に閉じた", "done", hoursAgo(1), hoursAgo(10));
  add("d-closed-late", "後で閉じた", "done", hoursAgo(20), hoursAgo(3));
  add("x-deleted", "削除済み", "deleted", hoursAgo(1), hoursAgo(1));

  const ids = (state: "active" | "waiting" | "done", limit: number = 25): string[] =>
    topicSessions.listByState("guild-1", state, limit).map((session) => session.channelId);

  assert.deepEqual(ids("active"), ["a-new", "a-mid", "a-old"]);
  assert.deepEqual(ids("active", 2), ["a-new", "a-mid"]);
  assert.deepEqual(ids("waiting"), ["w-1"]);
  assert.deepEqual(ids("done"), ["d-closed-late", "d-closed-early"]);
});

test("/sessions: 状態ごとの見出しに <#id> 題名（最終 n 時間前 / n 日前）を並べ、0 件は「なし」、削除済みは出さない。ephemeral で返す", async (t) => {
  const { add, runSessions } = setup(t);
  add("a-1", "旅行の計画", "active", hoursAgo(3));
  add("a-2", "設計レビュー", "active", hoursAgo(0.5));
  add("d-1", "引っ越し", "done", hoursAgo(50), hoursAgo(49));
  add("x-1", "削除済み", "deleted", hoursAgo(1), hoursAgo(1));
  add("a-other", "別サーバー", "active", hoursAgo(1), undefined, "guild-2");

  const calls = await runSessions();

  assert.deepEqual(calls, [
    {
      method: "reply",
      message: {
        text: [
          "**進行中**",
          "<#a-2> 設計レビュー（最終 1 時間以内）",
          "<#a-1> 旅行の計画（最終 3 時間前）",
          "",
          "**待ち**",
          "なし",
          "",
          "**完了**",
          "<#d-1> 引っ越し（最終 2 日前）",
        ].join("\n"),
        ephemeral: true,
      },
    },
  ]);
});

test("/sessions: 進行中・待ちは 25 件、完了は 10 件まで（新しいものから）", async (t) => {
  const { add, runSessions } = setup(t);
  for (let i = 0; i < 26; i++) add(`a${i}`, "x", "active", hoursAgo(i + 1));
  for (let i = 0; i < 26; i++) add(`w${i}`, "x", "waiting", hoursAgo(i + 1));
  for (let i = 0; i < 11; i++) add(`d${i}`, "x", "done", hoursAgo(100), hoursAgo(i + 1));

  const [call] = await runSessions();

  assert.ok(call?.method === "reply");
  const lines = call.message.text.split("\n");
  const shown = (prefix: string): string[] => lines.filter((line) => line.startsWith(`<#${prefix}`));
  assert.equal(shown("a").length, 25);
  assert.equal(shown("w").length, 25);
  assert.equal(shown("d").length, 10);
  // 一番古い 1 件ずつが外れる
  assert.ok(!lines.includes("<#a25> x（最終 1 日前）"));
  assert.ok(!lines.some((line) => line.startsWith("<#w25>")));
  assert.ok(!lines.some((line) => line.startsWith("<#d10>")));
  assert.ok(call.message.text.length <= MESSAGE_MAX_LENGTH);
  assert.doesNotMatch(call.message.text, /ほか/);
});

test("/sessions: 2000 字を超えるなら末尾から削って「ほか n 件」を足す。削って空になった見出しは出さない", async (t) => {
  const { add, runSessions } = setup(t);
  const long = "長".repeat(100);
  for (let i = 0; i < 25; i++) add(`a${String(i).padStart(2, "0")}`, long, "active", hoursAgo(i + 1));
  for (let i = 0; i < 3; i++) add(`d${i}`, long, "done", hoursAgo(100), hoursAgo(i + 1));

  const [call] = await runSessions();

  assert.ok(call?.method === "reply");
  const text = call.message.text;
  assert.ok(text.length <= MESSAGE_MAX_LENGTH, `length=${text.length}`);
  const lines = text.split("\n");
  const shown = lines.filter((line) => line.startsWith("<#")).length;
  const omitted = Number(/\nほか (\d+) 件$/.exec(text)?.[1]);
  assert.equal(shown + omitted, 28);
  // 進行中の古いものから削られ、完了は丸ごと消える（待ちは元から 0 件なので「なし」のまま）
  assert.ok(omitted > 3);
  assert.ok(!lines.includes("**完了**"));
  assert.ok(text.includes("**待ち**\nなし"));
  assert.ok(lines.includes(`<#a00> ${long}（最終 1 時間前）`));
  // 削りすぎていない（もう 1 行分の余裕は無い）
  assert.ok(text.length + `\n<#a00> ${long}（最終 1 時間前）`.length > MESSAGE_MAX_LENGTH);
});

test("sessionListText: 待ちだけの一覧（ホームパネルの [待ちのセッション]）", (t) => {
  const { topicSessions, add } = setup(t);
  add("a-1", "進行中", "active", hoursAgo(1));
  add("w-1", "返事待ち", "waiting", hoursAgo(30));

  assert.equal(sessionListText(topicSessions, "guild-1", ["waiting"], NOW), "**待ち**\n<#w-1> 返事待ち（最終 1 日前）");
  assert.equal(sessionListText(topicSessions, "guild-2", ["waiting"], NOW), "**待ち**\nなし");
});

test("fitItems: 収まれば全部、超えるなら末尾から削って削った件数を render に渡す", () => {
  const render = (shown: readonly string[], omitted: number): string =>
    [...shown, ...(omitted > 0 ? [`ほか ${omitted} 件`] : [])].join("\n");

  assert.deepEqual(fitItems(["aaa", "bbb"], render, 7), { text: "aaa\nbbb", shown: ["aaa", "bbb"] });
  assert.deepEqual(fitItems(["aaa", "bbb", "ccc"], render, 10), { text: "aaa\nほか 2 件", shown: ["aaa"] });
  assert.deepEqual(fitItems([], render, 10), { text: "", shown: [] });
});

test("/help に /sessions /tasks /usage とホームパネルの説明がある", () => {
  assert.match(HELP_TEXT, /^`\/sessions` /m);
  assert.match(HELP_TEXT, /^`\/tasks` /m);
  assert.match(HELP_TEXT, /^`\/usage` /m);
  assert.match(HELP_TEXT, /ホームパネル/);
});
