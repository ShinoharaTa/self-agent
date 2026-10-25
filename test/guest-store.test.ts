import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { backupBeforeMigration, backupPath, MIGRATIONS, openDb } from "../src/store/db.ts";
import { generateInviteCode, hashInviteCode } from "../src/guest/invite-code.ts";
import { GuestStore } from "../src/store/guest.ts";
import { GuestGuildStore } from "../src/store/guest-guilds.ts";
import { GuestInviteStore } from "../src/store/guest-invites.ts";
import { JobStore } from "../src/store/jobs.ts";
import { TaskStore } from "../src/store/tasks.ts";
import { tempDb, tempDir } from "./helpers/db.ts";

/** 2026-10-23T00:<minute>:00.000Z */
function at(minute: number): Date {
  return new Date(Date.UTC(2026, 9, 23, 0, minute));
}

function tempStore(t: TestContext): { store: GuestStore; setNow: (date: Date) => void } {
  let now = at(0);
  return {
    store: new GuestStore(tempDb(t), () => now),
    setNow: (date) => {
      now = date;
    },
  };
}

test("openDb: v22 の DB を v23 に上げても既存のデータは残り、ゲストの表は空で使える。移行の前に v22 の控えを取る", async (t) => {
  const dir = tempDir(t);
  const path = join(dir, "self-agent.db");
  const v22 = new DatabaseSync(path);
  v22.exec("PRAGMA journal_mode=WAL");
  for (const migration of MIGRATIONS.slice(0, 22)) v22.exec(migration);
  v22.exec("PRAGMA user_version = 22");
  const created = "2026-10-01T00:00:00.000Z";
  v22.prepare("INSERT INTO tasks (title, status, created_at) VALUES ('残る', 'open', ?)").run(created);
  v22.close();

  const logs: string[] = [];
  await backupBeforeMigration(path, (message) => logs.push(message));
  assert.ok(existsSync(backupPath(path, 22)));
  assert.deepEqual(logs, ["DB を移行する前に控えを取りました（v22）"]);

  const db = openDb(path);
  t.after(() => db.close());
  assert.equal(db.prepare("PRAGMA user_version").get()?.user_version, MIGRATIONS.length);
  assert.ok(MIGRATIONS.length >= 23);
  assert.deepEqual(new TaskStore(db).list({ status: "open", limit: 20 }).map((task) => task.title), ["残る"]);
  assert.equal(new JobStore(db).countOpen(), 0);

  const store = new GuestStore(db, () => at(0));
  assert.equal(store.countActive("g"), 0);
  assert.equal(store.get("c"), undefined);
  assert.equal(store.countTurns("g", "2026-10-23"), 0);
  assert.equal(store.enable("g", "c").result, "enabled");
});

test("GuestStore.enable: 作る・既に有効なら already_enabled・無効な行は開き直して SDK セッションの数を戻す", (t) => {
  const { store, setNow } = tempStore(t);
  const first = store.enable("g", "c1");
  assert.deepEqual(first, {
    result: "enabled",
    active: 1,
    channel: {
      guildId: "g",
      channelId: "c1",
      enabledAt: at(0).toISOString(),
      disabledAt: null,
      disabledReason: null,
      sessionStartedAt: null,
      sessionTurns: 0,
    },
  });
  assert.equal(store.enable("g", "c1").result, "already_enabled");

  setNow(at(1));
  store.bumpSession("c1");
  store.bumpSession("c1");
  assert.equal(store.get("c1")?.sessionTurns, 2);
  assert.equal(store.get("c1")?.sessionStartedAt, at(1).toISOString());

  setNow(at(2));
  assert.equal(store.disable("c1", "command"), true);
  assert.equal(store.disable("c1", "command"), false);
  assert.equal(store.disable("missing", "command"), false);
  assert.equal(store.get("c1")?.disabledAt, at(2).toISOString());
  assert.equal(store.get("c1")?.disabledReason, "command");
  assert.equal(store.countActive("g"), 0);

  setNow(at(3));
  const reopened = store.enable("g", "c1");
  assert.equal(reopened.result, "enabled");
  assert.deepEqual(store.get("c1"), {
    guildId: "g",
    channelId: "c1",
    enabledAt: at(3).toISOString(),
    disabledAt: null,
    disabledReason: null,
    sessionStartedAt: null,
    sessionTurns: 0,
  });
});

test("GuestStore.enable: サーバーごとの有効なチャンネルが上限なら limit で何も変えない（無効な行・ほかのサーバーは数えない）", (t) => {
  const { store } = tempStore(t);
  for (let index = 1; index <= 5; index++) assert.equal(store.enable("g", `c${index}`).result, "enabled");
  assert.deepEqual(store.enable("g", "c6"), { result: "limit" });
  assert.equal(store.get("c6"), undefined);
  // 既に有効なものは上限でも already_enabled
  assert.equal(store.enable("g", "c1").result, "already_enabled");
  // ほかのサーバーは別に数える
  assert.equal(store.enable("other", "o1").result, "enabled");
  // 1 つ無効にすれば、無効な行の開き直しも新しい行も通る
  store.disable("c5", "command");
  const sixth = store.enable("g", "c6");
  assert.equal(sixth.result, "enabled");
  assert.equal(sixth.result === "enabled" ? sixth.active : undefined, 5);
  assert.equal(store.enable("g", "c5").result, "limit");
  assert.equal(store.countActive("g"), 5);
  // limit は引数で変えられる
  assert.equal(store.enable("h", "h1", 1).result, "enabled");
  assert.equal(store.enable("h", "h2", 1).result, "limit");
});

test("GuestStore.disableGuild: そのサーバーの有効な行だけを理由付きで無効にし、数を返す", (t) => {
  const { store, setNow } = tempStore(t);
  store.enable("g", "c1");
  setNow(at(1));
  store.enable("g", "c2");
  store.enable("g", "c3");
  store.enable("other", "o1");
  store.disable("c3", "command");
  assert.deepEqual(
    store.listActive("g").map((channel) => channel.channelId),
    ["c1", "c2"],
  );
  setNow(at(5));
  assert.equal(store.disableGuild("g", "left"), 2);
  assert.equal(store.disableGuild("g", "left"), 0);
  assert.equal(store.get("c1")?.disabledReason, "left");
  assert.equal(store.get("c2")?.disabledAt, at(5).toISOString());
  // 先に無効にしたものは変えない
  assert.equal(store.get("c3")?.disabledReason, "command");
  assert.equal(store.countActive("g"), 0);
  assert.equal(store.countActive("other"), 1);
  assert.equal(store.disableGuild("other", "startup"), 1);
  assert.equal(store.get("o1")?.disabledReason, "startup");
});

test("GuestStore: bumpSession・resetSession は今の SDK セッションの始めた時刻とターン数を進める・戻す", (t) => {
  const { store, setNow } = tempStore(t);
  store.enable("g", "c1");
  setNow(at(10));
  store.bumpSession("c1");
  setNow(at(20));
  store.bumpSession("c1");
  assert.equal(store.get("c1")?.sessionStartedAt, at(10).toISOString());
  assert.equal(store.get("c1")?.sessionTurns, 2);
  store.resetSession("c1");
  assert.equal(store.get("c1")?.sessionStartedAt, null);
  assert.equal(store.get("c1")?.sessionTurns, 0);
});

test("GuestStore: 1 日のターン数をサーバー・ユーザーごとに数え、pruneTurns は指定の日より前を消す", (t) => {
  const { store } = tempStore(t);
  store.recordTurn("g", "u1", "2026-10-15");
  store.recordTurn("g", "u1", "2026-10-23");
  store.recordTurn("g", "u1", "2026-10-23");
  store.recordTurn("g", "u2", "2026-10-23");
  store.recordTurn("other", "u1", "2026-10-23");
  assert.equal(store.countTurns("g", "2026-10-23"), 3);
  assert.equal(store.countTurns("g", "2026-10-22"), 0);
  assert.equal(store.countUserTurns("g", "u1", "2026-10-23"), 2);
  assert.equal(store.countUserTurns("g", "u2", "2026-10-23"), 1);
  assert.equal(store.countUserTurns("g", "u3", "2026-10-23"), 0);
  assert.equal(store.countUserTurns("other", "u1", "2026-10-23"), 1);

  assert.equal(store.pruneTurns("2026-10-16"), 1);
  assert.equal(store.countTurns("g", "2026-10-15"), 0);
  assert.equal(store.countTurns("g", "2026-10-23"), 3);
  assert.equal(store.pruneTurns("2026-10-16"), 0);
});

// ---- guest_guilds・guest_invites（v24。docs/plan/guest-mode.md §4） ----

const INVITE_PATTERN = /^guest(-[0-9a-hjkmnp-tv-z]{4}){6}$/;

function inviteStores(t: TestContext, randomBytes?: (size: number) => Uint8Array) {
  const db = tempDb(t);
  const channels = new GuestStore(db, () => at(0));
  const guilds = new GuestGuildStore(db);
  const invites = new GuestInviteStore(db, { guilds, channels, ...(randomBytes === undefined ? {} : { randomBytes }) });
  return { db, channels, guilds, invites };
}

test("openDb: v23 の DB を v24 に上げると、有効なチャンネルのあるサーバーだけ許可済みで guest_guilds に入り、allowed_at は最初の enabled_at", (t) => {
  const dir = tempDir(t);
  const path = join(dir, "self-agent.db");
  const v23 = new DatabaseSync(path);
  v23.exec("PRAGMA journal_mode=WAL");
  for (const migration of MIGRATIONS.slice(0, 23)) v23.exec(migration);
  v23.exec("PRAGMA user_version = 23");
  const insert = v23.prepare(
    "INSERT INTO guest_channels (guild_id, channel_id, enabled_at, disabled_at, disabled_reason) VALUES (?, ?, ?, ?, ?)",
  );
  insert.run("g-active", "c1", at(5).toISOString(), null, null);
  insert.run("g-active", "c2", at(3).toISOString(), null, null);
  // 無効な行は数えない（最初の enabled_at は有効な行の中で）
  insert.run("g-active", "c3", at(1).toISOString(), at(2).toISOString(), "command");
  insert.run("g-disabled", "c4", at(1).toISOString(), at(2).toISOString(), "left");
  v23.close();

  const db = openDb(path);
  t.after(() => db.close());
  assert.equal(db.prepare("PRAGMA user_version").get()?.user_version, MIGRATIONS.length);
  assert.ok(MIGRATIONS.length >= 24);
  const guilds = new GuestGuildStore(db);
  assert.deepEqual(guilds.list(), [
    {
      guildId: "g-active",
      joinedAt: at(3).toISOString(),
      allowedAt: at(3).toISOString(),
      revokedAt: null,
      revokedReason: null,
      noticeChannelId: null,
      noticeMessageId: null,
      noticePostedAt: null,
    },
  ]);
  assert.equal(guilds.isAllowed("g-active"), true);
  assert.equal(guilds.isAllowed("g-disabled"), false);
  // guest_channels は変えない
  assert.equal(new GuestStore(db).countActive("g-active"), 2);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM guest_invites").get()?.count, 0);
});

test("GuestGuildStore.upsertJoined: 行が無ければ joined_at だけで作り（未許可）、あれば何も変えない", (t) => {
  const { guilds } = inviteStores(t);
  assert.equal(guilds.get("g"), undefined);
  assert.equal(guilds.isAllowed("g"), false);
  const created = guilds.upsertJoined("g", at(1));
  assert.deepEqual(created, {
    guildId: "g",
    joinedAt: at(1).toISOString(),
    allowedAt: null,
    revokedAt: null,
    revokedReason: null,
    noticeChannelId: null,
    noticeMessageId: null,
    noticePostedAt: null,
  });
  assert.equal(guilds.isAllowed("g"), false);
  guilds.allow("g", at(2));
  guilds.setNotice("g", "c", "m", at(3));
  const before = guilds.get("g");
  assert.deepEqual(guilds.upsertJoined("g", at(9)), before);
  assert.equal(before?.joinedAt, at(1).toISOString());
});

test("GuestGuildStore.revoke: 許可済みだけ取り消して isAllowed が false に。allow で再許可すると true に戻り revoked_* が NULL。未許可・行なしは false で何も書かない", (t) => {
  const { guilds } = inviteStores(t);
  guilds.allow("g", at(1));
  assert.equal(guilds.isAllowed("g"), true);
  assert.equal(guilds.get("g")?.joinedAt, at(1).toISOString());
  assert.equal(guilds.revoke("g", "revoke", at(2)), true);
  assert.equal(guilds.isAllowed("g"), false);
  assert.equal(guilds.get("g")?.revokedAt, at(2).toISOString());
  assert.equal(guilds.get("g")?.revokedReason, "revoke");
  // 取り消し済みにもう一度は false（時刻・理由は変えない）
  assert.equal(guilds.revoke("g", "left", at(3)), false);
  assert.equal(guilds.get("g")?.revokedReason, "revoke");

  guilds.allow("g", at(4));
  assert.equal(guilds.isAllowed("g"), true);
  const again = guilds.get("g")!;
  assert.equal(again.allowedAt, at(4).toISOString());
  assert.equal(again.revokedAt, null);
  assert.equal(again.revokedReason, null);
  assert.equal(again.joinedAt, at(1).toISOString());

  guilds.upsertJoined("g-unallowed", at(1));
  assert.equal(guilds.revoke("g-unallowed", "left", at(2)), false);
  assert.equal(guilds.get("g-unallowed")?.revokedAt, null);
  assert.equal(guilds.get("g-unallowed")?.revokedReason, null);
  assert.equal(guilds.revoke("g-none", "left", at(2)), false);
  assert.equal(guilds.get("g-none"), undefined);
});

test("GuestGuildStore.clearNotice: notice_* の 3 列が NULL になり、joined_at・allowed_at は変わらない", (t) => {
  const { guilds } = inviteStores(t);
  guilds.upsertJoined("g", at(1));
  guilds.allow("g", at(2));
  guilds.setNotice("g", "c-notice", "m-notice", at(3));
  assert.deepEqual(
    [guilds.get("g")?.noticeChannelId, guilds.get("g")?.noticeMessageId, guilds.get("g")?.noticePostedAt],
    ["c-notice", "m-notice", at(3).toISOString()],
  );
  guilds.clearNotice("g");
  const row = guilds.get("g")!;
  assert.deepEqual([row.noticeChannelId, row.noticeMessageId, row.noticePostedAt], [null, null, null]);
  assert.equal(row.joinedAt, at(1).toISOString());
  assert.equal(row.allowedAt, at(2).toISOString());
  assert.equal(guilds.isAllowed("g"), true);
});

test("generateInviteCode: 15 バイトを小文字の Crockford base32 で 24 文字にし、4 文字ずつ区切る（i l o u を使わない）", () => {
  assert.equal(generateInviteCode(() => new Uint8Array(15)), "guest-0000-0000-0000-0000-0000-0000");
  assert.equal(generateInviteCode(() => new Uint8Array(15).fill(255)), "guest-zzzz-zzzz-zzzz-zzzz-zzzz-zzzz");
  for (let index = 0; index < 50; index++) {
    const code = generateInviteCode(randomBytes);
    assert.match(code, INVITE_PATTERN);
    assert.equal(code.length, 35);
  }
  assert.throws(() => generateInviteCode(() => new Uint8Array(14)));
  assert.equal(hashInviteCode("guest-0000-0000-0000-0000-0000-0000").length, 64);
});

test("GuestInviteStore.issue: コードは形に合い、DB にはその sha256 だけ（平文の部分文字列が無い）。2 回目で前の行に superseded_at が付き、生きている行は常に 1 つ", (t) => {
  const { db, invites } = inviteStores(t);
  const first = invites.issue("g", at(0));
  assert.match(first.code, INVITE_PATTERN);
  assert.equal(first.replaced, false);
  assert.equal(first.expiresAt, new Date(at(0).getTime() + 24 * 3_600_000).toISOString());
  const rows = (): Array<Record<string, unknown>> => db.prepare("SELECT * FROM guest_invites ORDER BY id").all();
  assert.equal(rows()[0]!.code_hash, createHash("sha256").update(first.code).digest("hex"));
  const dump = JSON.stringify(rows());
  // 平文（区切りあり・なし。ランダムな 4 文字の偶然の一致で揺れないよう、2 組以上つないだもので見る）
  const body = first.code.split("-").slice(1);
  for (const part of [first.code, body.join("-"), body.join(""), body.slice(0, 2).join("-"), body.slice(4).join("-")]) {
    assert.ok(!dump.includes(part));
  }
  assert.equal(invites.activeFor("g", at(1))?.id, 1);

  const second = invites.issue("g", at(1));
  assert.equal(second.replaced, true);
  assert.notEqual(second.code, first.code);
  const [old, current] = rows();
  assert.equal(old!.superseded_at, at(1).toISOString());
  assert.equal(current!.superseded_at, null);
  assert.equal(invites.activeFor("g", at(2))?.id, current!.id);
  // ほかのサーバーのコードは置き換えない
  const other = invites.issue("g-other", at(2));
  assert.equal(other.replaced, false);
  assert.equal(invites.activeFor("g", at(2))?.id, current!.id);
  assert.equal(
    db.prepare(`SELECT COUNT(*) AS count FROM guest_invites WHERE guild_id = 'g' AND superseded_at IS NULL AND used_at IS NULL`).get()
      ?.count,
    1,
  );
});

test("GuestInviteStore.redeem: 正しいコードは ok で used_* が入り、サーバーが許可済み・チャンネルが有効に。同じコードをもう一度は used", (t) => {
  const { db, channels, guilds, invites } = inviteStores(t);
  guilds.upsertJoined("g", at(0));
  const { code } = invites.issue("g", at(0));
  const hash = hashInviteCode(code);
  const result = invites.redeem(hash, "g", at(10), "user-1", "c1");
  assert.equal(result.result, "ok");
  assert.ok(result.result === "ok" && result.enable.result === "enabled" && result.enable.active === 1);
  const row = db.prepare("SELECT * FROM guest_invites WHERE code_hash = ?").get(hash)!;
  assert.equal(row.used_at, at(10).toISOString());
  assert.equal(row.used_by_user_id, "user-1");
  assert.equal(row.used_channel_id, "c1");
  assert.equal(guilds.isAllowed("g"), true);
  assert.equal(guilds.get("g")?.allowedAt, at(10).toISOString());
  assert.equal(guilds.get("g")?.joinedAt, at(0).toISOString());
  assert.equal(channels.get("c1")?.disabledAt, null);
  assert.equal(invites.activeFor("g", at(11)), undefined);

  assert.deepEqual(invites.redeem(hash, "g", at(11), "user-2", "c2"), { result: "used" });
  assert.equal(channels.get("c2"), undefined);
});

test("GuestInviteStore.redeem: 期限（24 時間）を 1 秒過ぎたら expired、別のサーバーなら wrong_guild、置き換えられたら superseded、知らないハッシュは not_found。どれも何も変えない", (t) => {
  const { db, channels, guilds, invites } = inviteStores(t);
  const issuedAt = at(0);
  const { code, expiresAt } = invites.issue("g", issuedAt);
  const hash = hashInviteCode(code);
  const unchanged = (): void => {
    assert.equal(guilds.isAllowed("g"), false);
    assert.equal(guilds.get("g-other"), undefined);
    assert.equal(channels.get("c1"), undefined);
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM guest_invites WHERE used_at IS NOT NULL").get()?.count, 0);
  };
  const lateBy = (ms: number): Date => new Date(new Date(expiresAt).getTime() + ms);
  assert.deepEqual(invites.redeem(hash, "g", lateBy(1000), "user-1", "c1"), { result: "expired" });
  assert.deepEqual(invites.redeem(hash, "g", lateBy(0), "user-1", "c1"), { result: "expired" });
  unchanged();
  assert.deepEqual(invites.redeem(hash, "g-other", at(1), "user-1", "c1"), { result: "wrong_guild" });
  unchanged();
  assert.deepEqual(invites.redeem(hashInviteCode("guest-0000-0000-0000-0000-0000-0000"), "g", at(1), "user-1", "c1"), {
    result: "not_found",
  });
  unchanged();
  invites.issue("g", at(2));
  assert.deepEqual(invites.redeem(hash, "g", at(3), "user-1", "c1"), { result: "superseded" });
  unchanged();
  // 期限の 1 秒前は通る
  const fresh = invites.issue("g", at(4));
  const okAt = new Date(new Date(fresh.expiresAt).getTime() - 1000);
  assert.equal(invites.redeem(hashInviteCode(fresh.code), "g", okAt, "user-1", "c1").result, "ok");
});

test("GuestInviteStore.redeem: そのサーバーの有効なチャンネルが上限なら許可とコードの使用は成立し、enable は limit", (t) => {
  const { channels, guilds, invites } = inviteStores(t);
  for (const channelId of ["c1", "c2", "c3", "c4", "c5"]) channels.enable("g", channelId);
  const { code } = invites.issue("g", at(0));
  const result = invites.redeem(hashInviteCode(code), "g", at(1), "user-1", "c6");
  assert.deepEqual(result, { result: "ok", enable: { result: "limit" } });
  assert.equal(guilds.isAllowed("g"), true);
  assert.equal(channels.get("c6"), undefined);
  assert.equal(invites.activeFor("g", at(2)), undefined);
});

test("GuestInviteStore.redeem: 有効化が投げたら、サーバーの許可もコードの使用も戻る（1 トランザクション）", (t) => {
  const db = tempDb(t);
  const guilds = new GuestGuildStore(db);
  const invites = new GuestInviteStore(db, {
    guilds,
    channels: {
      enable: () => {
        throw new Error("enable failed");
      },
    },
  });
  guilds.upsertJoined("g", at(0));
  const { code } = invites.issue("g", at(0));
  const hash = hashInviteCode(code);
  assert.throws(() => invites.redeem(hash, "g", at(1), "user-1", "c1"), /enable failed/);
  assert.equal(guilds.isAllowed("g"), false);
  assert.equal(guilds.get("g")?.allowedAt, null);
  const row = db.prepare("SELECT * FROM guest_invites WHERE code_hash = ?").get(hash)!;
  assert.equal(row.used_at, null);
  assert.equal(row.used_by_user_id, null);
  assert.equal(invites.activeFor("g", at(2))?.id, Number(row.id));
  // トランザクションの外の enable はそのまま使える
  assert.equal(new GuestStore(db, () => at(0)).enable("g", "c1").result, "enabled");
});

test("GuestInviteStore.supersedeAll: そのサーバーの生きているコードを無効にし数を返す（使用済み・期限切れ・ほかのサーバーは数えない）", (t) => {
  const { invites } = inviteStores(t);
  invites.issue("g", at(0));
  invites.issue("g-other", at(0));
  assert.equal(invites.supersedeAll("g", at(1)), 1);
  assert.equal(invites.activeFor("g", at(2)), undefined);
  assert.notEqual(invites.activeFor("g-other", at(2)), undefined);
  assert.equal(invites.supersedeAll("g", at(2)), 0);
  // 期限切れは生きていない
  invites.issue("g", at(3));
  assert.equal(invites.supersedeAll("g", new Date(at(3).getTime() + 25 * 3_600_000)), 0);
});
