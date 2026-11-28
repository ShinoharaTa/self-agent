import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { projectLine, projectListMessage } from "../src/app/commands/projects.ts";
import { reminderDetailMessage, reminderLine, reminderListMessage } from "../src/app/commands/reminders.ts";
import { sessionLine, sessionListText } from "../src/app/commands/sessions.ts";
import { createLead, isLeadText, type LeadCounts, type LeadDeps, leadText, type TurnEndEvent } from "../src/app/lead.ts";
import { channelPlaceOf, createPlaceRefs } from "../src/app/place-refs.ts";
import type { ProgressTimers } from "../src/app/progress.ts";
import type { OutgoingMessage } from "../src/discord/gateway.ts";
import { HistoryStore } from "../src/store/history.ts";
import { createStores, tempDb } from "./helpers/db.ts";

const NOW = new Date("2026-10-13T00:25:00.000Z");
const GUILD = "900";
const INBOX = "500";
const OWNER = "700";
/** Discord の話題 */
const DISCORD_TOPIC = "111";
/** ローカルの話題（足した人格 mika）。番号は LocalIdStore と同じ形 */
const LOCAL_TOPIC = "100000000000000000001";
/** ローカルの入口（mika の #<NAME>） */
const LOCAL_ENTRY = "100000000000000000002";
/** ローカルの入口（設定に無い人格） */
const LOCAL_ENTRY_GONE = "100000000000000000003";
/** 記号入りの題名（Discord の Markdown・チャンネルの参照の字を含む） */
const LOCAL_TITLE = "<#999> 家計簿_*の話";
const LOCAL_TITLE_ESCAPED = "\\<\\#999\\> 家計簿\\_\\*の話";
const LOCAL_REF = `「${LOCAL_TITLE_ESCAPED}」（Web）`;

function setup(t: TestContext) {
  const db = tempDb(t);
  const stores = createStores(db, () => NOW);
  const { guildSettings, topicSessions } = stores;
  guildSettings.setPersonaInbox(GUILD, "default", INBOX);
  guildSettings.setPersonaInbox(GUILD, "mika", LOCAL_ENTRY, "local");
  guildSettings.setPersonaInbox(GUILD, "gone", LOCAL_ENTRY_GONE, "local");
  topicSessions.create({ channelId: DISCORD_TOPIC, guildId: GUILD, title: "Discord の話題", categoryId: "category-1", persona: "mika" });
  topicSessions.create({ channelId: LOCAL_TOPIC, guildId: GUILD, title: LOCAL_TITLE, categoryId: "local", persona: "mika", place: "local" });
  const names: Record<string, string> = { mika: "ミカ" };
  const placeRefs = createPlaceRefs({ guildSettings, topicSessions, personaName: (id) => names[id] });
  const history = new HistoryStore(db);
  return { db, ...stores, placeRefs, history };
}

// ---- 場所の引き方（T1・T2） ----

test("channelPlaceOf: ローカルの入口・ローカルの話題は local、Discord の入口・話題・どちらにも無い番号は discord", (t) => {
  const env = setup(t);
  assert.equal(channelPlaceOf(env, LOCAL_ENTRY), "local");
  assert.equal(channelPlaceOf(env, LOCAL_TOPIC), "local");
  assert.equal(channelPlaceOf(env, INBOX), "discord");
  assert.equal(channelPlaceOf(env, DISCORD_TOPIC), "discord");
  assert.equal(channelPlaceOf(env, "424242"), "discord");
  for (const id of [LOCAL_ENTRY, LOCAL_TOPIC]) assert.equal(env.placeRefs.isLocal(id), true, id);
  for (const id of [INBOX, DISCORD_TOPIC, "424242"]) assert.equal(env.placeRefs.isLocal(id), false, id);
});

test("refOf: Discord の場所は <#ID>。ローカルの話題は「題名」（Web）、ローカルの入口は「人格の表示名」（Web）（引けなければ id）。記号入りでも <# が出ない", (t) => {
  const env = setup(t);
  assert.equal(env.placeRefs.refOf(INBOX), `<#${INBOX}>`);
  assert.equal(env.placeRefs.refOf(DISCORD_TOPIC), `<#${DISCORD_TOPIC}>`);
  assert.equal(env.placeRefs.refOf("424242"), "<#424242>");
  assert.equal(env.placeRefs.refOf(LOCAL_TOPIC), LOCAL_REF);
  assert.equal(env.placeRefs.refOf(LOCAL_ENTRY), "「ミカ」（Web）");
  assert.equal(env.placeRefs.refOf(LOCAL_ENTRY_GONE), "「gone」（Web）");
  assert.ok(!env.placeRefs.refOf(LOCAL_TOPIC).includes("<#"));
  // 表示名の記号も逃がす
  const symbols = createPlaceRefs({ guildSettings: env.guildSettings, topicSessions: env.topicSessions, personaName: () => "<#1>_ミカ" });
  assert.equal(symbols.refOf(LOCAL_ENTRY), "「\\<\\#1\\>\\_ミカ」（Web）");
});

// ---- まとめ（T3〜T7） ----

function event(channelId: string, over: Partial<TurnEndEvent> = {}): TurnEndEvent {
  return { guildId: GUILD, channelId, durationMs: 4 * 60_000, outcome: "done", byRightHand: false, pinged: false, ...over };
}

/** after だけを手で進める偽のタイマー */
function fakeTimers() {
  const pending: Array<() => void> = [];
  const timers: ProgressTimers = {
    after(fn) {
      pending.push(fn);
      return () => {};
    },
    every() {
      throw new Error("every は使わない");
    },
  };
  return { timers, fire: () => pending.splice(0).forEach((fn) => fn()) };
}

function leadSetup(t: TestContext, over: Partial<LeadDeps> = {}) {
  const env = setup(t);
  const clock = fakeTimers();
  const posts: Array<{ channelId: string; message: OutgoingMessage }> = [];
  const logs: string[] = [];
  const lead = createLead({
    settings: () => ({ ring: "long", scope: "all" }),
    ownerUserId: OWNER,
    inboxOf: () => INBOX,
    post: async (channelId, message) => {
      posts.push({ channelId, message });
      return "m1";
    },
    counts: () => ({ running: 1, queued: 0, yourTurn: 1 }),
    history: env.history,
    timers: clock.timers,
    log: (message) => logs.push(message),
    refOf: env.placeRefs.refOf,
    ...over,
  });
  const run = async (events: readonly TurnEndEvent[]) => {
    for (const e of events) lead.onTurnEnd(e);
    clock.fire();
    await lead.idle();
  };
  const rows = () => env.history.list(INBOX, { limit: 50 });
  return { env, lead, run, posts, logs, rows };
}

test("leadText: 引数なしと既定の書き方（<#ID>）・Discord の場所だけの refOf の出力は、今の期待値と同じ", (t) => {
  const env = setup(t);
  const events = [
    event("111"),
    event("444", { outcome: "aborted" }),
    event("222", { outcome: "failed" }),
    event("333", { outcome: "max_turns" }),
    event("555", { outcome: "failed" }),
    event("666", { durationMs: 59_999 }),
    event("777", { durationMs: 60_000 }),
  ];
  const counts: LeadCounts = { running: 1, queued: 2, yourTurn: 1 };
  const expected = [
    "止まりました: <#333>（上限。［続ける］が要ります）",
    "止まりました: <#222>（失敗）",
    "止まりました: <#555>（失敗）",
    "止まりました: <#444>（中断）",
    "終わりました: <#111>（4 分）",
    "終わりました: <#666>（1 分未満）",
    "終わりました: <#777>（1 分）",
    "残り: 動いている 1・順番待ち 2・あなたの番 1",
  ].join("\n");
  assert.equal(leadText(events, counts), expected);
  assert.equal(leadText(events, counts, (id) => `<#${id}>`), expected);
  assert.equal(leadText(events, counts, env.placeRefs.refOf), expected);
  assert.equal(leadText([event("111")], null, env.placeRefs.refOf), "終わりました: <#111>（4 分）");
});

test("まとめ: ローカルの話題 + Discord の話題。Discord に投げる文はローカルの行に <# が無く題名が在り、履歴の行は 2 行とも <#ID>", async (t) => {
  const { run, posts, rows } = leadSetup(t);
  await run([event(LOCAL_TOPIC), event(DISCORD_TOPIC)]);
  assert.equal(posts.length, 1);
  assert.equal(posts[0]!.channelId, INBOX);
  const [localLine, discordLine] = posts[0]!.message.text.split("\n");
  assert.equal(localLine, `終わりました: ${LOCAL_REF}（4 分）`);
  assert.ok(!localLine!.includes("<#"));
  assert.ok(localLine!.includes("家計簿"));
  assert.equal(discordLine, `終わりました: <#${DISCORD_TOPIC}>（4 分）`);
  const history = rows();
  assert.equal(history.length, 1);
  const text = history[0]!.text;
  assert.ok(text.startsWith("終わりました: <#"));
  assert.equal(isLeadText(text), true);
  assert.equal(
    text,
    [`終わりました: <#${LOCAL_TOPIC}>（4 分）`, `終わりました: <#${DISCORD_TOPIC}>（4 分）`, "残り: 動いている 1・あなたの番 1"].join("\n"),
  );
});

test("まとめ: Discord の話題だけなら、Discord に投げる文と履歴の文が同じ。refOf を渡さなくても同じ", async (t) => {
  const withRefs = leadSetup(t);
  await withRefs.run([event(DISCORD_TOPIC), event("222", { outcome: "failed" })]);
  const without = leadSetup(t, { refOf: undefined });
  await without.run([event(DISCORD_TOPIC), event("222", { outcome: "failed" })]);
  assert.equal(withRefs.posts.length, 1);
  assert.equal(withRefs.posts[0]!.message.text, withRefs.rows()[0]!.text);
  assert.deepEqual(withRefs.posts, without.posts);
  assert.equal(without.posts[0]!.message.text, without.rows()[0]!.text);
});

test("まとめ: ローカルの話題入りで投稿が reject → 履歴 0 行・log 1 行", async (t) => {
  const { run, logs, rows } = leadSetup(t, {
    post: async () => {
      throw new Error("boom");
    },
  });
  await run([event(LOCAL_TOPIC), event(DISCORD_TOPIC)]);
  assert.equal(rows().length, 0);
  assert.deepEqual(logs, ["まとめの投稿に失敗しました: boom"]);
});

test("まとめ: ローカルの話題が混ざっても、並び（止まった物が先）・「ほか n 件」・mention の有無は refOf 無しと同じ（違うのは場所の字だけ）", async (t) => {
  const events = [
    event(LOCAL_TOPIC, { durationMs: 1000 }),
    ...Array.from({ length: 9 }, (_, i) => event(String(200 + i), { durationMs: 1000 })),
    event("333", { outcome: "failed" }),
  ];
  const withRefs = leadSetup(t, { counts: () => null });
  await withRefs.run(events);
  const without = leadSetup(t, { counts: () => null, refOf: undefined });
  await without.run(events);
  const posted = withRefs.posts[0]!.message;
  const plain = without.posts[0]!.message;
  const lines = posted.text.split("\n");
  assert.equal(lines.length, 10);
  assert.equal(lines[0], "止まりました: <#333>（失敗）");
  assert.equal(lines[1], `終わりました: ${LOCAL_REF}（1 分未満）`);
  assert.equal(lines[9], "ほか 2 件");
  assert.equal(posted.text.replace(LOCAL_REF, `<#${LOCAL_TOPIC}>`), plain.text);
  assert.equal(posted.mentionUserId, OWNER);
  assert.equal(plain.mentionUserId, OWNER);
  // 鳴らす物が無ければ、ローカルの話題入りでも mention は付かない
  const quiet = leadSetup(t);
  await quiet.run([event(LOCAL_TOPIC, { durationMs: 1000 })]);
  assert.equal("mentionUserId" in quiet.posts[0]!.message, false);
});

test("まとめ: refOf が投げても落とさない。投稿は 1 回で文は履歴の文（<#ID>）と同じ・履歴 1 行・log 1 行", async (t) => {
  const { run, posts, rows, logs } = leadSetup(t, {
    refOf: () => {
      throw new Error("引けません");
    },
  });
  await run([event(LOCAL_TOPIC), event(DISCORD_TOPIC)]);
  assert.equal(posts.length, 1);
  const history = rows();
  assert.equal(history.length, 1);
  assert.equal(posts[0]!.message.text, history[0]!.text);
  assert.ok(posts[0]!.message.text.includes(`<#${DISCORD_TOPIC}>`));
  assert.deepEqual(logs, ["まとめの場所の書き方を引けませんでした"]);
});

// ---- 一覧（T8・T9） ----

test("sessionLine: ローカルの話題は <# が無く、題名と「Web・」が在る。Discord の話題は今と同じ字", (t) => {
  const env = setup(t);
  const local = env.topicSessions.get(LOCAL_TOPIC)!;
  const discord = env.topicSessions.get(DISCORD_TOPIC)!;
  assert.equal(sessionLine(local, NOW, "ミカ"), `${LOCAL_TITLE_ESCAPED}（ミカ・Web・最終 1 時間以内）`);
  assert.equal(sessionLine(local, NOW), `${LOCAL_TITLE_ESCAPED}（Web・最終 1 時間以内）`);
  // 行頭に来る題名の見出し・引用・箇条書き・チャンネルの参照の字は逃がす
  for (const [title, escaped] of [
    ["# 見出し", "\\# 見出し"],
    ["> 引用", "\\> 引用"],
    ["- 箇条", "\\- 箇条"],
    ["<#999> 参照", "\\<\\#999\\> 参照"],
  ] as const) {
    assert.equal(sessionLine({ ...local, title }, NOW, "ミカ"), `${escaped}（ミカ・Web・最終 1 時間以内）`, title);
  }
  // Discord の行の題名は今と同じく逃がさない
  assert.equal(sessionLine({ ...discord, title: "# 見出し" }, NOW), `<#${DISCORD_TOPIC}> # 見出し（最終 1 時間以内）`);
  assert.equal(sessionLine(discord, NOW, "ミカ"), `<#${DISCORD_TOPIC}> Discord の話題（ミカ・最終 1 時間以内）`);
  assert.equal(sessionLine(discord, NOW), `<#${DISCORD_TOPIC}> Discord の話題（最終 1 時間以内）`);
  // /sessions とホームパネルの本文（sessionListText）も同じ行
  const text = sessionListText(env.topicSessions, GUILD, ["active"], NOW, [{ id: "mika", name: "ミカ" }]);
  assert.ok(text.includes(`\n${LOCAL_TITLE_ESCAPED}（ミカ・Web・最終 1 時間以内）`));
  assert.ok(text.includes(`\n<#${DISCORD_TOPIC}> Discord の話題（ミカ・最終 1 時間以内）`));
  assert.ok(!text.includes(`<#${LOCAL_TOPIC}>`));
});

test("reminderLine・projectLine: ローカルの場所は refOf の字。refOf 無しと、Discord の場所は今と同じ字", (t) => {
  const env = setup(t);
  const tz = "Asia/Tokyo";
  const at = new Date("2026-10-14T00:00:00.000Z");
  const local = env.reminders.add({ guildId: GUILD, channelId: LOCAL_ENTRY, kind: "prompt", text: "今日のタスクを出す", nextAt: at });
  const discord = env.reminders.add({ guildId: GUILD, channelId: DISCORD_TOPIC, kind: "notify", text: "洗濯物", nextAt: at });
  const refOf = env.placeRefs.refOf;
  assert.equal(reminderLine(local, tz, refOf), `#${local.id} 10/14(水) 9:00 今日のタスクを出す（依頼・「ミカ」（Web））`);
  assert.equal(reminderLine(local, tz), `#${local.id} 10/14(水) 9:00 今日のタスクを出す（依頼・<#${LOCAL_ENTRY}>）`);
  assert.equal(reminderLine(discord, tz, refOf), `#${discord.id} 10/14(水) 9:00 洗濯物（<#${DISCORD_TOPIC}>）`);
  assert.equal(reminderLine(discord, tz, refOf), reminderLine(discord, tz));
  // 一覧と詳細も同じ書き方
  const deps = { reminders: env.reminders, cfg: { timeZone: tz } };
  assert.ok(reminderListMessage({ ...deps, refOf }).text.includes("（依頼・「ミカ」（Web））"));
  assert.ok(reminderListMessage(deps).text.includes(`（依頼・<#${LOCAL_ENTRY}>）`));
  assert.equal(reminderDetailMessage(local, tz, refOf).text, reminderLine(local, tz, refOf));
  assert.equal(reminderDetailMessage(local, tz).text, reminderLine(local, tz));

  const page = env.projects.create({ guildId: GUILD, channelId: LOCAL_TOPIC, name: "kakeibo", title: "家計簿" });
  const other = env.projects.create({ guildId: GUILD, channelId: DISCORD_TOPIC, name: "notes", title: "メモ" });
  const cfg = { publicBaseUrl: undefined, timeZone: tz };
  assert.equal(projectLine(page, cfg, refOf), `**家計簿** （配信は未設定）（${LOCAL_REF}・更新 2026-10-13）`);
  assert.equal(projectLine(page, cfg), `**家計簿** （配信は未設定）（<#${LOCAL_TOPIC}>・更新 2026-10-13）`);
  assert.equal(projectLine(other, cfg, refOf), `**メモ** （配信は未設定）（<#${DISCORD_TOPIC}>・更新 2026-10-13）`);
  assert.equal(projectLine(other, cfg, refOf), projectLine(other, cfg));
  assert.ok(projectListMessage({ projects: env.projects, cfg, refOf }).text.includes(`（${LOCAL_REF}・`));
  assert.ok(projectListMessage({ projects: env.projects, cfg }).text.includes(`（<#${LOCAL_TOPIC}>・`));
});

// ---- 配線の見張り（T10） ----

test("見張り: main.ts は placeRefs を 1 つだけ reminderTools より前に作り、createLead・/reminders・/projects（コマンドと詳細のセレクト）に同じ refOf を渡す", () => {
  const source = readFileSync(new URL("../src/main.ts", import.meta.url), "utf8");
  assert.equal(source.match(/createPlaceRefs\(/g)?.length, 1);
  const made = source.indexOf("const placeRefs = createPlaceRefs({");
  assert.ok(made >= 0);
  assert.ok(made < source.indexOf("const reminderTools = "));
  const lead = source.match(/const lead = config\.leadNotify\n {2}\? createLead\(\{[\s\S]*?\n {4}\}\)\n {2}: undefined;/)?.[0];
  assert.ok(lead !== undefined);
  assert.match(lead, /\n {6}refOf: placeRefs\.refOf,\n/);
  const commands = source.match(/const commands = createCommands\(\{[\s\S]*?\n\}\);/)?.[0];
  assert.ok(commands !== undefined);
  assert.match(commands, /\n {2}refOf: placeRefs\.refOf,\n/);
  const components = source.match(/components: createComponents\(\{[\s\S]*?\n {2}\}\)/)?.[0];
  assert.ok(components !== undefined);
  assert.match(components, /\n {4}refOf: placeRefs\.refOf,\n/);
});
