import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
import type { Gateway, Interaction, InteractionResponder, ModalDef, OutgoingMessage } from "../src/discord/gateway.ts";
import { ChannelSeedStore } from "../src/store/channel-seeds.ts";
import { openDb } from "../src/store/db.ts";
import { SdkSessionStore } from "../src/store/sdk-sessions.ts";
import { TopicSessionStore } from "../src/store/topic-sessions.ts";

const CLOSED_AT = new Date("2026-09-01T00:00:00.000Z");
const NOW = new Date("2026-10-02T00:12:00.000Z");
const DAY_MS = 24 * 60 * 60 * 1000;

type ResponderCall =
  | { method: "defer"; ephemeral: boolean }
  | { method: "deferUpdate" }
  | { method: "reply" | "update"; message: OutgoingMessage }
  | { method: "showModal"; modal: ModalDef };

class FakeResponder implements InteractionResponder {
  calls: ResponderCall[] = [];
  /** deferUpdate の直後に呼ばれる（保留の間に状態が変わったことにする） */
  afterDeferUpdate: () => void = () => {};
  /** update の直前に呼ばれる。投げればその更新は失敗する */
  beforeUpdate: () => void = () => {};

  async defer(ephemeral: boolean): Promise<void> {
    this.calls.push({ method: "defer", ephemeral });
  }
  async deferUpdate(): Promise<void> {
    this.calls.push({ method: "deferUpdate" });
    this.afterDeferUpdate();
  }
  async reply(message: OutgoingMessage): Promise<void> {
    this.calls.push({ method: "reply", message });
  }
  async update(message: OutgoingMessage): Promise<void> {
    this.beforeUpdate();
    this.calls.push({ method: "update", message });
  }
  async showModal(modal: ModalDef): Promise<void> {
    this.calls.push({ method: "showModal", modal });
  }
}

/** Discord 上にあるチャンネルを覚えておく。既に無いチャンネルの削除は（Gateway の約束どおり）成功にする */
class FakeGateway implements Pick<Gateway, "deleteChannel"> {
  /** deleteChannel を呼ばれたチャンネル */
  calls: string[] = [];
  readonly alive = new Set<string>();
  /** deleteChannel の直前に呼ばれる。投げればその削除は失敗する */
  beforeDelete: (channelId: string) => void = () => {};

  async deleteChannel(channelId: string): Promise<void> {
    this.calls.push(channelId);
    this.beforeDelete(channelId);
    this.alive.delete(channelId);
  }
}

class RecordingChannelOps {
  cancelled: string[] = [];

  cancel(channelId: string): void {
    this.cancelled.push(channelId);
  }
}

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

function setup(t: TestContext) {
  const dir = mkdtempSync(join(tmpdir(), "self-agent-test-"));
  const db = openDb(join(dir, "self-agent.db"));
  t.after(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const clock = { now: CLOSED_AT };
  const topicSessions = new TopicSessionStore(db, () => clock.now);
  const sessions = new SdkSessionStore(db, () => clock.now);
  const seeds = new ChannelSeedStore(db, () => clock.now);
  const gateway = new FakeGateway();
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

test("削除の確認: 題名とリンク・日数の文面に、[削除する]（del:yes・danger）と [残す]（del:keep）を付ける", () => {
  assert.deepEqual(deletePrompt({ channelId: "topic-1", title: "旅行の計画" }, 30), {
    text: "<#topic-1>（旅行の計画）は完了から 30 日経ちました。チャンネルを削除しますか？要約は残ります。",
    components: [
      {
        kind: "buttons",
        buttons: [
          { customId: "del:yes:topic-1", label: "削除する", style: "danger" },
          { customId: "del:keep:topic-1", label: "残す" },
        ],
      },
    ],
  });
  assert.equal(deletedText("旅行の計画"), "旅行の計画 を削除しました（要約は残っています）");
  assert.equal(keptText("旅行の計画", 30), "旅行の計画 を残しました。30 日後にもう一度確認します");
  assert.equal(STALE_TEXT, "この確認は古くなっています");
  assert.equal(ALREADY_HANDLED_TEXT, "すでに処理済みです");
});

test("[削除する]: 完了のままなら保留してチャンネルを削除し、削除済みにして会話と seed を消し、確認メッセージを書き換えてボタンを外す（要約は残す）", async (t) => {
  const env = setup(t);

  const calls = await env.run(press("yes"));

  assert.deepEqual(calls, [
    { method: "deferUpdate" },
    { method: "update", message: { text: deletedText("旅行の計画"), components: [] } },
  ]);
  assert.deepEqual(env.gateway.calls, ["topic-1"]);
  assert.equal(env.gateway.alive.has("topic-1"), false);
  const session = env.topicSessions.get("topic-1");
  assert.equal(session?.state, "deleted");
  assert.equal(session?.deletedAt, NOW.toISOString());
  assert.equal(session?.summary, "要約");
  assert.equal(env.sessions.get("topic-1"), undefined);
  assert.equal(env.seeds.get("topic-1"), undefined);
  assert.equal(env.sessions.get("topic-2"), "sdk-2");
  assert.equal(env.seeds.get("topic-2"), "seed-2");
  assert.deepEqual(env.channelOps.cancelled, ["topic-1"]);
  assert.deepEqual(env.logs, ["セッションのチャンネルを削除しました（guild=guild-1）"]);

  // 削除した後は発言を受け付けない
  const resolve = createChannelResolver({ inboxChannelId: undefined }, { get: () => undefined }, env.topicSessions);
  assert.equal(resolve("guild-1", "topic-1"), null);
});

test("[削除する]: チャンネルが既に無くても（Gateway は成功を返す）削除済みにする", async (t) => {
  const env = setup(t);
  // 手で消されていた
  env.gateway.alive.delete("topic-1");

  const calls = await env.run(press("yes"));

  assert.deepEqual(calls.at(-1), { method: "update", message: { text: deletedText("旅行の計画"), components: [] } });
  assert.equal(env.topicSessions.get("topic-1")?.state, "deleted");
  assert.equal(env.sessions.get("topic-1"), undefined);
});

const STALE = [{ method: "update", message: { text: STALE_TEXT, components: [] } }];

test("進行中・待ちに戻ったら、確認の [削除する]・[残す] は「この確認は古くなっています」に書き換えてボタンを外すだけ（DB は変えない）", async (t) => {
  for (const state of ["active", "waiting"] as const) {
    await t.test(state, async (t) => {
      const env = setup(t);
      // 発言・[続ける] で進行中に戻る（確認の記録も消える）
      env.topicSessions.setActive("topic-1");
      if (state === "waiting") env.topicSessions.setWaiting("topic-1");
      const before = env.topicSessions.get("topic-1");
      assert.equal(before?.deletePromptMessageId, null);

      for (const action of ["yes", "keep"]) {
        assert.deepEqual(await env.run(press(action)), STALE, action);
      }

      assert.deepEqual(env.gateway.calls, []);
      assert.deepEqual(env.topicSessions.get("topic-1"), before);
      assert.equal(env.sessions.get("topic-1"), "sdk-1");
      assert.equal(env.seeds.get("topic-1"), "seed-1");
      assert.deepEqual(env.channelOps.cancelled, []);
      assert.deepEqual(env.logs, []);
    });
  }
});

test("閉じ直して新しい確認が出た後に古い確認を押しても、削除・延長しない。新しい確認は動く", async (t) => {
  const env = setup(t);
  // 古い確認（message-1）のまま進行中に戻り、閉じ直して 30 日後に新しい確認（message-2）が出た
  env.topicSessions.setActive("topic-1");
  env.topicSessions.close("topic-1", "閉じ直した要約");
  env.clock.now = new Date(NOW.getTime() + 30 * DAY_MS);
  env.topicSessions.setDeletePrompt("topic-1", "message-2");
  const before = env.topicSessions.get("topic-1");

  // 古い確認の [削除する]・[残す] は何もしない（[削除する] は保留もしない）
  for (const action of ["yes", "keep"]) {
    assert.deepEqual(await env.run(press(action, "topic-1", "message-1")), STALE, action);
  }
  assert.deepEqual(env.gateway.calls, []);
  assert.deepEqual(env.topicSessions.get("topic-1"), before);

  // 新しい確認の [削除する] は削除する
  const calls = await env.run(press("yes", "topic-1", "message-2"));

  assert.deepEqual(calls, [
    { method: "deferUpdate" },
    { method: "update", message: { text: deletedText("旅行の計画"), components: [] } },
  ]);
  assert.deepEqual(env.gateway.calls, ["topic-1"]);
  const deleted = env.topicSessions.get("topic-1");
  assert.equal(deleted?.state, "deleted");
  assert.equal(deleted?.summary, "閉じ直した要約");
});

test("閉じ直した後の新しい確認の [残す] は延長し、その確認はもう押しても古い", async (t) => {
  const env = setup(t);
  env.topicSessions.setActive("topic-1");
  env.topicSessions.close("topic-1", "要約");
  env.clock.now = new Date(NOW.getTime() + 30 * DAY_MS);
  env.topicSessions.setDeletePrompt("topic-1", "message-2");

  assert.deepEqual(await env.run(press("keep", "topic-1", "message-2")), [
    { method: "update", message: { text: keptText("旅行の計画", 30), components: [] } },
  ]);
  assert.equal(env.topicSessions.get("topic-1")?.closedAt, env.clock.now.toISOString());

  // 同じ確認をもう一度押しても（記録は消えている）何もしない
  for (const action of ["yes", "keep"]) {
    assert.deepEqual(await env.run(press(action, "topic-1", "message-2")), STALE, action);
  }
  assert.deepEqual(env.gateway.calls, []);
  assert.equal(env.topicSessions.get("topic-1")?.state, "done");
});

test("押されたメッセージが分からない・記録した確認と違うボタンは、完了でも古いとみなす", async (t) => {
  const env = setup(t);
  const before = env.topicSessions.get("topic-1");

  for (const messageId of [null, "message-9"]) {
    for (const action of ["yes", "keep"]) {
      assert.deepEqual(await env.run(press(action, "topic-1", messageId)), STALE, `${action} ${messageId}`);
    }
  }
  assert.deepEqual(env.gateway.calls, []);
  assert.deepEqual(env.topicSessions.get("topic-1"), before);
});

test("[削除する]: 保留の間に進行中に戻った・削除されたら、読み直した状態で判断する", async (t) => {
  const env = setup(t);
  const revived = new FakeResponder();
  revived.afterDeferUpdate = () => env.topicSessions.setActive("topic-1");

  assert.deepEqual(await env.run(press("yes"), revived), [{ method: "deferUpdate" }, ...STALE]);
  assert.deepEqual(env.gateway.calls, []);
  assert.equal(env.topicSessions.get("topic-1")?.state, "active");

  env.topicSessions.close("topic-1", "要約");
  env.topicSessions.setDeletePrompt("topic-1", "message-1");
  const deleted = new FakeResponder();
  deleted.afterDeferUpdate = () => env.topicSessions.markDeleted("topic-1");

  assert.deepEqual((await env.run(press("yes"), deleted)).at(-1), {
    method: "update",
    message: { text: ALREADY_HANDLED_TEXT, components: [] },
  });
  assert.deepEqual(env.gateway.calls, []);
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
  assert.deepEqual(env.logs, [
    "セッションのチャンネルを削除しました（guild=guild-1）",
    "削除の確認メッセージの更新に失敗しました: Unknown interaction",
  ]);
});

test("[残す]: 閉じた時刻を今にして確認の記録を消し、30 日後にもう一度確認の対象にする", async (t) => {
  const env = setup(t);

  const calls = await env.run(press("keep"));

  assert.deepEqual(calls, [{ method: "update", message: { text: keptText("旅行の計画", 30), components: [] } }]);
  const session = env.topicSessions.get("topic-1");
  assert.equal(session?.state, "done");
  assert.equal(session?.closedAt, NOW.toISOString());
  assert.equal(session?.deletePromptMessageId, null);
  assert.equal(session?.summary, "要約");
  assert.deepEqual(env.gateway.calls, []);
  assert.equal(env.sessions.get("topic-1"), "sdk-1");
  assert.deepEqual(env.logs, ["[残す] でセッションのチャンネルを残しました（guild=guild-1）"]);

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
  assert.deepEqual(env.gateway.calls, ["topic-1"]);
  const deleted = env.topicSessions.get("topic-1");
  for (const action of ["yes", "keep"]) {
    assert.deepEqual(await env.run(press(action)), handled, action);
  }
  assert.deepEqual(env.gateway.calls, ["topic-1"]);
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
  assert.deepEqual(env.gateway.calls, []);
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
