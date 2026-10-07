import { test } from "node:test";
import assert from "node:assert/strict";
import type { ChannelKind } from "../src/app/access.ts";
import {
  abortTurnButton,
  continueTurnButton,
  createTurnControlsComponent,
  MAX_TURNS_REPLY,
  STALE_TURN_REPLY,
} from "../src/app/commands/turn-controls.ts";
import { MAX_TURNS_REPLY as HANDLER_MAX_TURNS_REPLY } from "../src/app/handler.ts";
import type { Interaction, InteractionResponder, ModalDef, OutgoingMessage } from "../src/discord/gateway.ts";

const NOW = new Date("2026-10-02T00:12:00Z");

type ResponderCall = { method: "deferUpdate" } | { method: "reply" | "update"; message: OutgoingMessage };

class FakeResponder implements InteractionResponder {
  calls: ResponderCall[] = [];

  async defer(): Promise<void> {
    throw new Error("想定外の呼び出し");
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
  async showModal(_modal: ModalDef): Promise<void> {
    throw new Error("想定外の呼び出し");
  }
}

/** 中断と [続ける] の呼び出しを記録する。running のチャンネルの、その番号のターンだけ中断できる */
function setup(channels: Record<string, ChannelKind> = {}, running: Record<string, number> = {}) {
  const aborted: Array<{ channelId: string; turnSeq: number }> = [];
  const continued: Array<{ guildId: string; channelId: string; at: Date }> = [];
  const logs: string[] = [];
  const component = createTurnControlsComponent({
    resolveChannel: (_guildId, channelId) => channels[channelId] ?? null,
    turns: {
      abortTurn: (channelId, turnSeq) => {
        if (running[channelId] !== turnSeq) return false;
        aborted.push({ channelId, turnSeq });
        return true;
      },
      continueTurn: async (guildId, channelId, at) => {
        continued.push({ guildId, channelId, at });
      },
    },
    log: (line) => logs.push(line),
  });
  const press = async (interaction: Exclude<Interaction, { kind: "command" }>): Promise<ResponderCall[]> => {
    const responder = new FakeResponder();
    await component.handle(interaction, responder);
    return responder.calls;
  };
  return { component, aborted, continued, logs, press };
}

/** ボタンが押されたチャンネル（interaction.channelId）は custom_id のチャンネルと別にしておく */
function button(customId: string): Extract<Interaction, { kind: "button" }> {
  return { kind: "button", customId, guildId: "guild-1", channelId: "elsewhere-1", userId: "owner-1", createdAt: NOW };
}

test("turn のボタン: [中断] は turn:abort:<channelId>:<turnSeq>（danger）、[続ける] は turn:continue:<channelId>", () => {
  assert.deepEqual(abortTurnButton("topic-1", 3), { customId: "turn:abort:topic-1:3", label: "中断", style: "danger" });
  assert.deepEqual(continueTurnButton("topic-1"), { customId: "turn:continue:topic-1", label: "続ける" });
  // handler の MAX_TURNS_REPLY と同じもの
  assert.equal(HANDLER_MAX_TURNS_REPLY, MAX_TURNS_REPLY);
});

test("[中断]: custom_id のチャンネルの、その番号のターンを中断して deferUpdate する。実行中でない・番号が違う・番号が無ければ本人にだけ古いと返す", async () => {
  const env = setup({}, { "topic-1": 3 });
  const stale = [{ method: "reply", message: { text: STALE_TURN_REPLY, ephemeral: true } }];

  assert.deepEqual(await env.press(button("turn:abort:topic-1:3")), [{ method: "deferUpdate" }]);
  assert.deepEqual(await env.press(button("turn:abort:topic-2:3")), stale);
  // 前のターンのボタン
  assert.deepEqual(await env.press(button("turn:abort:topic-1:2")), stale);
  // 番号の無い（このバージョンより前の）ボタン・数字でない番号
  assert.deepEqual(await env.press(button("turn:abort:topic-1")), stale);
  assert.deepEqual(await env.press(button("turn:abort:topic-1:")), stale);
  assert.deepEqual(await env.press(button("turn:abort:topic-1:3x")), stale);
  assert.deepEqual(env.aborted, [{ channelId: "topic-1", turnSeq: 3 }]);
  assert.deepEqual(env.logs, ["[中断] でターンを中断しました（guild=guild-1）"]);
});

test("[続ける]: 受け付けるセッションならボタンを外してから、押した時刻でターンを入れる。それ以外は本人にだけ古いと返す", async () => {
  const env = setup({ "topic-1": "session", "inbox-1": "inbox" });

  assert.deepEqual(await env.press(button("turn:continue:topic-1")), [
    { method: "update", message: { text: MAX_TURNS_REPLY, components: [] } },
  ]);
  assert.deepEqual(env.continued, [{ guildId: "guild-1", channelId: "topic-1", at: NOW }]);

  const stale = [{ method: "reply", message: { text: STALE_TURN_REPLY, ephemeral: true } }];
  assert.deepEqual(await env.press(button("turn:continue:inbox-1")), stale);
  assert.deepEqual(await env.press(button("turn:continue:topic-9")), stale);
  assert.equal(env.continued.length, 1);
  assert.deepEqual(env.logs, ["[続ける] でターンを続けます（guild=guild-1）"]);
});

test("turn の不明な操作（custom_id のチャンネル無し・知らない action・セレクト）は例外にする", async () => {
  const env = setup({ "topic-1": "session" }, { "topic-1": 1 });

  await assert.rejects(env.press(button("turn:abort")), /チャンネルがありません/);
  await assert.rejects(env.press(button("turn:abort:")), /チャンネルがありません/);
  await assert.rejects(env.press(button("turn:stop:topic-1:1")), /不明な操作/);
  await assert.rejects(
    env.press({ ...button("turn:abort:topic-1:1"), kind: "select", values: ["1"] }),
    /不明な操作/,
  );
  assert.deepEqual(env.aborted, []);
});
