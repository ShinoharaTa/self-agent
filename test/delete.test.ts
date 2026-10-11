import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { ChannelType, DiscordAPIError, RESTJSONErrorCodes } from "discord.js";
import { createChannelResolver } from "../src/app/access.ts";
import {
  ALREADY_HANDLED_TEXT,
  createDeleteComponent,
  deletedText,
  deletePrompt,
  keptText,
  STALE_TEXT,
} from "../src/app/commands/delete.ts";
import { DiscordGateway } from "../src/discord/discord-gateway.ts";
import type { Interaction } from "../src/discord/gateway.ts";
import { createStores, tempDb } from "./helpers/db.ts";
import { FakeGateway } from "./helpers/gateway.ts";
import { RecordingChannelOps } from "./helpers/recording.ts";
import { FakeResponder, type ResponderCall } from "./helpers/responder.ts";

const CLOSED_AT = new Date("2026-09-01T00:00:00.000Z");
const NOW = new Date("2026-10-02T00:12:00.000Z");
const DAY_MS = 24 * 60 * 60 * 1000;

const TOPIC = { channelId: "topic-1", guildId: "guild-1", title: "旅行の計画", categoryId: "done-1" };

/** 確認のボタンを押す。messageId は押した確認のメッセージ（既定は setup で記録した確認、null なら載せない） */
function press(
  action: string,
  channelId: string = "topic-1",
  messageId: string | null = "message-1",
): Extract<Interaction, { kind: "button" }> {
  return {
    kind: "button",
    customId: `del:${action}:${channelId}`,
    guildId: "guild-1",
    channelId: "system-1",
    userId: "owner-1",
    createdAt: NOW,
    ...(messageId === null ? {} : { messageId }),
  };
}

/** 削除の確認（deletePrompt）のボタンを label で押す（custom_id は確認のものを使う） */
function fromPrompt(label: string): Extract<Interaction, { kind: "button" }> {
  const row = deletePrompt({ channelId: "topic-1", title: "旅行の計画" }, 30).components?.[0];
  assert.ok(row?.kind === "buttons");
  const button = row.buttons.find((candidate) => candidate.label === label);
  assert.ok(button !== undefined, label);
  return { ...press("yes"), customId: button.customId };
}

function setup(t: TestContext) {
  const db = tempDb(t);
  const clock = { now: CLOSED_AT };
  const { topicSessions, sessions, seeds } = createStores(db, () => clock.now);
  const gateway = new FakeGateway({ allow: ["deleteChannel"] });
  const channelOps = new RecordingChannelOps();
  const logs: string[] = [];
  const component = createDeleteComponent({
    cfg: { deleteAfterDays: 30 },
    topicSessions,
    sessions,
    seeds,
    gateway,
    channelOps,
    log: (line) => logs.push(line),
  });

  // 9/1 に閉じ、30 日後の tick で確認を投稿したセッション。会話と seed も残っている
  topicSessions.create(TOPIC);
  topicSessions.close("topic-1", "要約");
  topicSessions.setDeletePrompt("topic-1", "message-1");
  sessions.set("topic-1", "sdk-1");
  seeds.set("topic-1", "seed-1");
  // 別のチャンネルの会話と seed は消さない
  sessions.set("topic-2", "sdk-2");
  seeds.set("topic-2", "seed-2");
  gateway.alive.add("topic-1");
  clock.now = NOW;

  const run = async (
    interaction: Exclude<Interaction, { kind: "command" }>,
    responder: FakeResponder = new FakeResponder(),
  ): Promise<ResponderCall[]> => {
    await component.handle(interaction, responder);
    return responder.calls;
  };
  return { db, clock, topicSessions, sessions, seeds, gateway, channelOps, logs, run };
}

test("[削除する]: 完了のままなら保留してチャンネルを削除し（既に無くても）、削除済みにして会話と seed を消し、確認メッセージを書き換えてボタンを外す（要約は残す）", async (t) => {
  for (const label of ["チャンネルがある", "チャンネルが既に無い"]) {
    const env = setup(t);
    // 手で消されていた（Gateway は成功を返す）
    if (label === "チャンネルが既に無い") env.gateway.alive.delete("topic-1");

    const calls = await env.run(fromPrompt("削除する"));

    assert.deepEqual(
      calls,
      [
        { method: "deferUpdate" },
        { method: "update", message: { text: deletedText("旅行の計画"), components: [] } },
      ],
      label,
    );
    assert.deepEqual(env.gateway.deleted, ["topic-1"], label);
    assert.equal(env.gateway.alive.has("topic-1"), false, label);
    const session = env.topicSessions.get("topic-1");
    assert.equal(session?.state, "deleted", label);
    assert.equal(session?.deletedAt, NOW.toISOString(), label);
    assert.equal(session?.summary, "要約", label);
    assert.equal(env.sessions.get("topic-1"), undefined, label);
    assert.equal(env.seeds.get("topic-1"), undefined, label);
    assert.equal(env.sessions.get("topic-2"), "sdk-2", label);
    assert.equal(env.seeds.get("topic-2"), "seed-2", label);
    assert.deepEqual(env.channelOps.cancelled, ["topic-1"], label);
    assert.equal(env.logs.length, 1, label);
    assert.ok(!env.logs[0]!.includes("topic-1"), label);

    // 削除した後は発言を受け付けない
    const resolve = createChannelResolver({ inboxChannelId: undefined }, { get: () => undefined }, env.topicSessions);
    assert.equal(resolve("guild-1", "topic-1"), null, label);
  }
});

const STALE = [{ method: "update", message: { text: STALE_TEXT, components: [] } }];

test("古い確認（進行中・待ちに戻った・閉じ直した後の前の確認・押されたメッセージが分からない・記録と違う・[残す] の後）の [削除する]・[残す] は「この確認は古くなっています」に書き換えてボタンを外すだけ（DB は変えない）", async (t) => {
  /** 状態を作り、押す確認のメッセージ ID を返す */
  const cases: Array<{ label: string; arrange: (env: ReturnType<typeof setup>) => Promise<string | null> }> = [
    {
      // 発言・[続ける] で進行中に戻る（確認の記録も消える）
      label: "進行中に戻った",
      arrange: async (env) => {
        env.topicSessions.setActive("topic-1");
        return "message-1";
      },
    },
    {
      label: "待ちに戻った",
      arrange: async (env) => {
        env.topicSessions.setActive("topic-1");
        env.topicSessions.setWaiting("topic-1");
        return "message-1";
      },
    },
    {
      // 古い確認（message-1）のまま進行中に戻り、閉じ直して 30 日後に新しい確認（message-2）が出た
      label: "閉じ直した後の前の確認",
      arrange: async (env) => {
        env.topicSessions.setActive("topic-1");
        env.topicSessions.close("topic-1", "閉じ直した要約");
        env.clock.now = new Date(NOW.getTime() + 30 * DAY_MS);
        env.topicSessions.setDeletePrompt("topic-1", "message-2");
        return "message-1";
      },
    },
    { label: "押されたメッセージが分からない", arrange: async () => null },
    { label: "記録した確認と違うメッセージ", arrange: async () => "message-9" },
    {
      // [残す] で記録は消えている
      label: "[残す] を押した後の同じ確認",
      arrange: async (env) => {
        await env.run(fromPrompt("残す"));
        return "message-1";
      },
    },
  ];

  for (const { label, arrange } of cases) {
    const env = setup(t);
    const messageId = await arrange(env);
    env.logs.length = 0;
    const before = env.topicSessions.get("topic-1");

    // [削除する] は保留もしない
    for (const action of ["yes", "keep"]) {
      assert.deepEqual(await env.run(press(action, "topic-1", messageId)), STALE, `${label} ${action}`);
    }

    assert.deepEqual(env.gateway.deleted, [], label);
    assert.deepEqual(env.topicSessions.get("topic-1"), before, label);
    assert.equal(env.sessions.get("topic-1"), "sdk-1", label);
    assert.equal(env.seeds.get("topic-1"), "seed-1", label);
    assert.deepEqual(env.channelOps.cancelled, [], label);
    assert.deepEqual(env.logs, [], label);
  }
});

test("[削除する]: 保留の間に進行中に戻った・削除されたら、読み直した状態で判断する", async (t) => {
  const env = setup(t);
  const revived = new FakeResponder();
  revived.afterDeferUpdate = () => env.topicSessions.setActive("topic-1");

  assert.deepEqual(await env.run(press("yes"), revived), [{ method: "deferUpdate" }, ...STALE]);
  assert.deepEqual(env.gateway.deleted, []);
  assert.equal(env.topicSessions.get("topic-1")?.state, "active");

  env.topicSessions.close("topic-1", "要約");
  env.topicSessions.setDeletePrompt("topic-1", "message-1");
  const deleted = new FakeResponder();
  deleted.afterDeferUpdate = () => env.topicSessions.markDeleted("topic-1");

  assert.deepEqual((await env.run(press("yes"), deleted)).at(-1), {
    method: "update",
    message: { text: ALREADY_HANDLED_TEXT, components: [] },
  });
  assert.deepEqual(env.gateway.deleted, []);
});

test("[削除する]: チャンネルの削除に失敗したら何も変えずに投げる（ボタンは残るので押し直せる）", async (t) => {
  const env = setup(t);
  env.gateway.beforeDelete = () => {
    throw new Error("Missing Permissions");
  };
  const responder = new FakeResponder();

  await assert.rejects(env.run(press("yes"), responder), /Missing Permissions/);

  assert.deepEqual(responder.calls, [{ method: "deferUpdate" }]);
  const session = env.topicSessions.get("topic-1");
  assert.equal(session?.state, "done");
  assert.equal(session?.deletedAt, null);
  assert.equal(session?.deletePromptMessageId, "message-1");
  assert.equal(env.sessions.get("topic-1"), "sdk-1");
  assert.equal(env.seeds.get("topic-1"), "seed-1");
  assert.deepEqual(env.channelOps.cancelled, []);
});

test("[削除する]: 削除した後の確認メッセージの書き換えに失敗しても投げずに log に出す", async (t) => {
  const env = setup(t);
  const responder = new FakeResponder();
  responder.beforeUpdate = () => {
    throw new Error("Unknown interaction");
  };

  await env.run(press("yes"), responder);

  assert.equal(env.topicSessions.get("topic-1")?.state, "deleted");
  assert.equal(env.logs.length, 2);
  assert.match(env.logs[1]!, /Unknown interaction/);
});

test("[残す]: 閉じた時刻を今にして確認の記録を消し、30 日後にもう一度確認の対象にする", async (t) => {
  const env = setup(t);

  const calls = await env.run(fromPrompt("残す"));

  assert.deepEqual(calls, [{ method: "update", message: { text: keptText("旅行の計画", 30), components: [] } }]);
  const session = env.topicSessions.get("topic-1");
  assert.equal(session?.state, "done");
  assert.equal(session?.closedAt, NOW.toISOString());
  assert.equal(session?.deletePromptMessageId, null);
  assert.equal(session?.summary, "要約");
  assert.deepEqual(env.gateway.deleted, []);
  assert.equal(env.sessions.get("topic-1"), "sdk-1");
  assert.equal(env.logs.length, 1);
  assert.ok(!env.logs[0]!.includes("topic-1"));

  // 残してから 30 日経つまでは確認しない（at の時刻の tick で確認の対象になるもの）
  const due = (at: number): string[] =>
    env.topicSessions.listDeleteDue(new Date(at - 30 * DAY_MS), 5).map((candidate) => candidate.channelId);
  assert.deepEqual(due(CLOSED_AT.getTime() + 30 * DAY_MS), []);
  assert.deepEqual(due(NOW.getTime() + 30 * DAY_MS - 1), []);
  assert.deepEqual(due(NOW.getTime() + 30 * DAY_MS), ["topic-1"]);
});

test("削除済み・行が無い・別サーバーのセッションの確認は「すでに処理済みです」に書き換えてボタンを外し、何も変えない", async (t) => {
  const env = setup(t);
  env.topicSessions.create({ ...TOPIC, channelId: "topic-9", guildId: "guild-9" });
  env.topicSessions.close("topic-9", "要約");
  const handled = [{ method: "update", message: { text: ALREADY_HANDLED_TEXT, components: [] } }];

  for (const channelId of ["unknown-1", "topic-9"]) {
    for (const action of ["yes", "keep"]) {
      assert.deepEqual(await env.run(press(action, channelId)), handled, `${action} ${channelId}`);
    }
  }
  assert.equal(env.topicSessions.get("topic-9")?.state, "done");

  await env.run(press("yes"));
  assert.deepEqual(env.gateway.deleted, ["topic-1"]);
  const deleted = env.topicSessions.get("topic-1");
  for (const action of ["yes", "keep"]) {
    assert.deepEqual(await env.run(press(action)), handled, action);
  }
  assert.deepEqual(env.gateway.deleted, ["topic-1"]);
  assert.deepEqual(env.topicSessions.get("topic-1"), deleted);
});

test("del の不明な操作（custom_id のチャンネル無し・知らない action・セレクト）は例外にする", async (t) => {
  const env = setup(t);

  await assert.rejects(env.run({ ...press("yes"), customId: "del:yes" }), /チャンネルがありません/);
  await assert.rejects(env.run(press("drop")), /不明な操作です（button drop）/);
  await assert.rejects(
    env.run({ ...press("yes"), kind: "select", values: [] }),
    /不明な操作です（select yes）/,
  );
  assert.deepEqual(env.gateway.deleted, []);
  assert.equal(env.topicSessions.get("topic-1")?.state, "done");
});

/** discord.js の Client に Discord への問い合わせ（channels.fetch）の偽物を差し込む（ログインはしない） */
function discordGateway(t: TestContext, fetch: (channelId: string) => Promise<unknown>): DiscordGateway {
  const gateway = new DiscordGateway(["guild-1"]);
  t.after(() => gateway.stop());
  Object.assign(gateway["client"].channels, { fetch });
  return gateway;
}

function apiError(code: number, message: string): DiscordAPIError {
  return new DiscordAPIError({ code, message }, code, 404, "DELETE", "/channels/topic-1", {});
}

function textChannel(remove: () => Promise<void>) {
  return { type: ChannelType.GuildText, isDMBased: () => false, isThread: () => false, delete: remove };
}

test("DiscordGateway.deleteChannel: 取得・削除のどちらで Unknown Channel になっても（既に無い）成功にする", async (t) => {
  const unknown = apiError(RESTJSONErrorCodes.UnknownChannel, "Unknown Channel");
  let deleted = 0;

  await discordGateway(t, async () => textChannel(async () => void deleted++)).deleteChannel("topic-1");
  assert.equal(deleted, 1);
  await discordGateway(t, async () => {
    throw unknown;
  }).deleteChannel("topic-1");
  await discordGateway(t, async () =>
    textChannel(async () => {
      throw unknown;
    }),
  ).deleteChannel("topic-1");
});

test("DiscordGateway.deleteChannel: それ以外の失敗（権限など）とカテゴリ・取得できないチャンネルは投げる", async (t) => {
  const missingPermissions = apiError(RESTJSONErrorCodes.MissingPermissions, "Missing Permissions");

  await assert.rejects(
    discordGateway(t, async () =>
      textChannel(async () => {
        throw missingPermissions;
      }),
    ).deleteChannel("topic-1"),
    /Missing Permissions/,
  );
  await assert.rejects(
    discordGateway(t, async () => ({ ...textChannel(async () => {}), type: ChannelType.GuildCategory })).deleteChannel(
      "topic-1",
    ),
    /削除できないチャンネルです/,
  );
  await assert.rejects(discordGateway(t, async () => null).deleteChannel("topic-1"), /削除できないチャンネルです/);
});
