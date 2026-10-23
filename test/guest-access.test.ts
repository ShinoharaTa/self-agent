import { test } from "node:test";
import assert from "node:assert/strict";
import { acceptsGuestMessage, type GuestAccessInput } from "../src/guest/access.ts";
import type { GuestChannel } from "../src/store/guest.ts";

const CHANNEL: GuestChannel = {
  guildId: "g-guest",
  channelId: "c-guest",
  enabledAt: "2026-10-23T00:00:00.000Z",
  disabledAt: null,
  disabledReason: null,
  sessionStartedAt: null,
  sessionTurns: 0,
};

/** 5 つの条件をすべて満たす発言（メンション） */
function input(overrides: { message?: Partial<GuestAccessInput["message"]> } & Partial<Omit<GuestAccessInput, "message">> = {}): GuestAccessInput {
  return {
    guestGuildIds: ["g-guest"],
    channel: CHANNEL,
    botUserId: "bot-guest",
    ...overrides,
    message: {
      guildId: "g-guest",
      channelId: "c-guest",
      authorIsBot: false,
      isWebhook: false,
      persona: "guest",
      mentionsMe: true,
      ...overrides.message,
    },
  };
}

test("acceptsGuestMessage: 5 つの条件をすべて満たすときだけ true（メンションか、ゲスト Bot の発言への返信）", () => {
  assert.equal(acceptsGuestMessage(input()), true);
  assert.equal(acceptsGuestMessage(input({ message: { mentionsMe: false, replyToAuthorId: "bot-guest" } })), true);
  assert.equal(acceptsGuestMessage(input({ message: { mentionsMe: undefined, replyToAuthorId: "bot-guest" } })), true);
});

test("acceptsGuestMessage: (1) サーバーが SELF_AGENT_GUEST_GUILD_IDS に無い・DM なら false（行が残っていても）", () => {
  assert.equal(acceptsGuestMessage(input({ guestGuildIds: [] })), false);
  assert.equal(acceptsGuestMessage(input({ guestGuildIds: ["other"] })), false);
  assert.equal(acceptsGuestMessage(input({ message: { guildId: null } })), false);
});

test("acceptsGuestMessage: (2) 有効な行が無い・無効・別のチャンネルやサーバーの行なら false", () => {
  assert.equal(acceptsGuestMessage(input({ channel: undefined })), false);
  assert.equal(
    acceptsGuestMessage(input({ channel: { ...CHANNEL, disabledAt: "2026-10-23T01:00:00.000Z", disabledReason: "command" } })),
    false,
  );
  assert.equal(acceptsGuestMessage(input({ channel: { ...CHANNEL, channelId: "other" } })), false);
  assert.equal(acceptsGuestMessage(input({ channel: { ...CHANNEL, guildId: "other" } })), false);
});

test("acceptsGuestMessage: (3) ゲスト Bot の Gateway 以外（既定の人格・足した人格）から届いた発言なら false", () => {
  assert.equal(acceptsGuestMessage(input({ message: { persona: undefined } })), false);
  assert.equal(acceptsGuestMessage(input({ message: { persona: "default" } })), false);
  assert.equal(acceptsGuestMessage(input({ message: { persona: "alice" } })), false);
});

test("acceptsGuestMessage: (4) Bot・Webhook の発言なら false", () => {
  assert.equal(acceptsGuestMessage(input({ message: { authorIsBot: true } })), false);
  assert.equal(acceptsGuestMessage(input({ message: { isWebhook: true } })), false);
});

test("acceptsGuestMessage: (5) メンションでも、ゲスト Bot の発言への返信でもなければ false", () => {
  assert.equal(acceptsGuestMessage(input({ message: { mentionsMe: false } })), false);
  assert.equal(acceptsGuestMessage(input({ message: { mentionsMe: undefined } })), false);
  // 他の人の発言への返信
  assert.equal(acceptsGuestMessage(input({ message: { mentionsMe: false, replyToAuthorId: "someone" } })), false);
  // 自分の ID が分からなければ返信とはみなさない
  assert.equal(
    acceptsGuestMessage(input({ botUserId: undefined, message: { mentionsMe: false, replyToAuthorId: "bot-guest" } })),
    false,
  );
});
