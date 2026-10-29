import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { cancelOf, skipNextOf } from "../src/app/reminders-ops.ts";
import type { NewReminder } from "../src/store/reminders.ts";
import { createStores, tempDb } from "./helpers/db.ts";

/** 2026-10-13(火) 9:25 JST */
const NOW = new Date("2026-10-13T00:25:00.000Z");
const TZ = "Asia/Tokyo";

function setup(t: TestContext) {
  const { reminders } = createStores(tempDb(t), () => NOW);
  const add = (overrides: Partial<NewReminder> = {}) =>
    reminders.add({ guildId: "guild-1", channelId: "ch-1", kind: "notify", text: "薬を飲む", nextAt: new Date("2026-10-13T02:00:00.000Z"), ...overrides });
  return { reminders, add };
}

test("skipNextOf: 繰り返しの次の回を飛ばし、飛ばした回とその次の回を返す", (t) => {
  const { reminders, add } = setup(t);
  // 毎週 水・金 8:00。次は 10/14(水)
  const weekly = add({ rule: "weekly:wed,fri@08:00", nextAt: new Date("2026-10-13T23:00:00.000Z") });
  assert.deepEqual(skipNextOf(reminders, weekly.id, TZ), {
    result: "skipped",
    skipped: new Date("2026-10-13T23:00:00.000Z"),
    next: new Date("2026-10-15T23:00:00.000Z"),
  });
  assert.equal(reminders.get(weekly.id)?.nextAt, "2026-10-15T23:00:00.000Z");
});

test("skipNextOf: 無い id は not_found、1 回だけ・active でないものは stale で何も変えない", (t) => {
  const { reminders, add } = setup(t);
  const once = add();
  const weekly = add({ rule: "weekly:wed,fri@08:00", nextAt: new Date("2026-10-13T23:00:00.000Z") });
  reminders.cancel(weekly.id);

  assert.deepEqual(skipNextOf(reminders, 99, TZ), { result: "not_found" });
  assert.deepEqual(skipNextOf(reminders, once.id, TZ), { result: "stale" });
  assert.deepEqual(skipNextOf(reminders, weekly.id, TZ), { result: "stale" });
  assert.equal(reminders.get(once.id)?.nextAt, "2026-10-13T02:00:00.000Z");
  assert.equal(reminders.get(weekly.id)?.nextAt, "2026-10-13T23:00:00.000Z");
});

test("skipNextOf: 書き換えられなかった（その間に変わった）なら stale", (t) => {
  const { reminders, add } = setup(t);
  const weekly = add({ rule: "daily@08:00", nextAt: new Date("2026-10-13T23:00:00.000Z") });
  const store = { get: (id: number) => reminders.get(id), skipNext: () => false };
  assert.deepEqual(skipNextOf(store, weekly.id, TZ), { result: "stale" });
});

test("cancelOf: active を止める。2 回目・止めたものは stale、無い id は not_found", (t) => {
  const { reminders, add } = setup(t);
  const once = add();
  assert.equal(cancelOf(reminders, once.id), "cancelled");
  assert.equal(reminders.get(once.id)?.status, "cancelled");
  assert.equal(cancelOf(reminders, once.id), "stale");
  assert.equal(cancelOf(reminders, 99), "not_found");
  // get の後に止められた
  const other = add();
  assert.equal(cancelOf({ get: (id) => reminders.get(id), cancel: () => false }, other.id), "stale");
});
