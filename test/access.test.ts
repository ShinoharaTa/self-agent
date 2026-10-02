import { test } from "node:test";
import assert from "node:assert/strict";
import { isAccepted } from "../src/app/access.ts";
import type { IncomingMessage } from "../src/discord/gateway.ts";

const cfg = { guildId: "guild-1", inboxChannelId: "inbox-1", ownerUserId: "owner-1" };

const accepted: IncomingMessage = {
  id: "message-1",
  channelId: "inbox-1",
  guildId: "guild-1",
  authorId: "owner-1",
  authorIsBot: false,
  isWebhook: false,
  content: "明日買い物に行く",
  createdAt: new Date("2026-10-02T00:12:00Z"),
};

test("すべての条件を満たす発言は受け付ける", () => {
  assert.equal(isAccepted(accepted, cfg), true);
});

test("条件を 1 つでも外れる発言は弾く", () => {
  const cases: Array<[string, Partial<IncomingMessage>]> = [
    ["別ギルド", { guildId: "guild-2" }],
    ["DM", { guildId: null }],
    ["別チャンネル", { channelId: "other-1" }],
    ["オーナー以外", { authorId: "someone-else" }],
    ["bot", { authorIsBot: true }],
    ["Webhook", { isWebhook: true }],
    ["空の本文", { content: "" }],
    ["空白だけの本文", { content: " \n\t " }],
  ];
  for (const [name, override] of cases) {
    assert.equal(isAccepted({ ...accepted, ...override }, cfg), false, name);
  }
});

test("設定が欠けていれば何も受け付けない", () => {
  assert.equal(isAccepted(accepted, { ...cfg, guildId: undefined }), false);
  assert.equal(isAccepted(accepted, { ...cfg, inboxChannelId: undefined }), false);
  assert.equal(isAccepted(accepted, { ...cfg, ownerUserId: undefined }), false);
});
