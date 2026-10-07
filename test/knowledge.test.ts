import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { MIGRATIONS, openDb } from "../src/store/db.ts";
import { GuildSettingsStore } from "../src/store/guild-settings.ts";
import { InboxSummaryStore } from "../src/store/inbox-summaries.ts";
import { KnowledgeStore } from "../src/store/knowledge.ts";
import { MemoryStore } from "../src/store/memories.ts";
import { TaskStore } from "../src/store/tasks.ts";

function tempDir(t: TestContext): string {
  const dir = mkdtempSync(join(tmpdir(), "self-agent-test-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** 呼ぶたびに 1 分進む時計 */
function clock(): () => Date {
  let minutes = 0;
  return () => new Date(Date.UTC(2026, 9, 7, 0, minutes++));
}

function setup(t: TestContext): { db: DatabaseSync; store: KnowledgeStore } {
  const db = openDb(join(tempDir(t), "self-agent.db"));
  t.after(() => db.close());
  return { db, store: new KnowledgeStore(db, clock()) };
}

function titles(store: KnowledgeStore, query: string, limit?: number): string[] {
  return store.search(query, limit).entries.map((entry) => entry.title);
}

/** 外部コンテンツの kb_fts が kb_entries と食い違っていればエラーを投げる */
function checkFtsIntegrity(db: DatabaseSync): void {
  db.exec("INSERT INTO kb_fts (kb_fts) VALUES ('integrity-check')");
}

test("openDb: v11 の DB を v12 に上げても既存のデータは残り、ナレッジと記憶を保存できる", (t) => {
  const path = join(tempDir(t), "self-agent.db");

  // ナレッジと記憶より前（v11）の DB を作る
  const v11 = new DatabaseSync(path);
  for (const migration of MIGRATIONS.slice(0, 11)) v11.exec(migration);
  v11.exec("PRAGMA user_version = 11");
  v11.prepare("INSERT INTO tasks (title, status, created_at) VALUES ('残る', 'open', '2026-10-01T00:00:00.000Z')").run();
  v11.prepare(
    "INSERT INTO guild_settings (guild_id, inbox_channel_id, inbox_rotated_date, inbox_rotated_at, created_at, updated_at) " +
      "VALUES ('guild-1', 'inbox-1', '2026-10-01', '2026-09-30T19:00:00.000Z', '2026-10-01T00:00:00.000Z', '2026-10-01T00:00:00.000Z')",
  ).run();
  v11.prepare(
    "INSERT INTO inbox_summaries (guild_id, date, summary, created_at) VALUES ('guild-1', '2026-10-01', '- 要約', '2026-09-30T19:00:00.000Z')",
  ).run();
  v11.close();

  const db = openDb(path);
  t.after(() => db.close());

  assert.equal(db.prepare("PRAGMA user_version").get()?.user_version, MIGRATIONS.length);
  assert.ok(MIGRATIONS.length >= 12);
  assert.deepEqual(
    new TaskStore(db).list({ status: "open", limit: 20 }).map((task) => task.title),
    ["残る"],
  );
  assert.equal(new GuildSettingsStore(db).get("guild-1")?.inboxRotatedAt, "2026-09-30T19:00:00.000Z");
  assert.equal(new InboxSummaryStore(db).latest("guild-1")?.summary, "- 要約");

  const knowledge = new KnowledgeStore(db, clock());
  knowledge.add({ title: "SQLite の全文検索", summary: "FTS5 の trigram で日本語も探せる" });
  assert.deepEqual(titles(knowledge, "全文検索"), ["SQLite の全文検索"]);
  const memories = new MemoryStore(db, clock());
  memories.add("住んでいる地域: 東京都練馬区");
  assert.equal(memories.countActive(), 1);
});

test("KnowledgeStore: 追加・取得。タグは英字を小文字にし、重複を除き、1 個 20 字・5 個までにする", (t) => {
  const { store } = setup(t);
  const entry = store.add({
    url: "https://example.com/sqlite/#fts",
    urlKey: "https://example.com/sqlite",
    title: "SQLite の全文検索",
    summary: "FTS5 の trigram で日本語も探せる",
    body: "- 3 文字未満は LIKE で補う",
    tags: "SQLite\u3000sqlite  FTS5 全文検索 abcdefghijklmnopqrstuvwxyz 日本語 あふれる",
    channelId: "inbox-1",
  });
  assert.deepEqual(entry, {
    id: 1,
    url: "https://example.com/sqlite/#fts",
    urlKey: "https://example.com/sqlite",
    title: "SQLite の全文検索",
    summary: "FTS5 の trigram で日本語も探せる",
    body: "- 3 文字未満は LIKE で補う",
    tags: ["sqlite", "fts5", "全文検索", "abcdefghijklmnopqrst", "日本語"],
    channelId: "inbox-1",
    createdAt: "2026-10-07T00:00:00.000Z",
    updatedAt: "2026-10-07T00:00:00.000Z",
  });
  assert.deepEqual(store.get(1), entry);
  assert.deepEqual(store.getByUrlKey("https://example.com/sqlite"), entry);
  assert.equal(store.get(2), undefined);
  assert.equal(store.getByUrlKey("https://example.com/other"), undefined);

  // URL もタグも本文も無いメモ
  assert.deepEqual(store.add({ title: "メモ", summary: "会話のまとめ" }), {
    id: 2,
    url: null,
    urlKey: null,
    title: "メモ",
    summary: "会話のまとめ",
    body: "",
    tags: [],
    channelId: null,
    createdAt: "2026-10-07T00:01:00.000Z",
    updatedAt: "2026-10-07T00:01:00.000Z",
  });
});

test("KnowledgeStore: url_key は UNIQUE（同じ値は追加も更新もできない）。URL 無しのメモはいくつでも作れる", (t) => {
  const { db, store } = setup(t);
  store.add({ url: "https://example.com/a", urlKey: "https://example.com/a", title: "A", summary: "a" });
  assert.throws(
    () => store.add({ url: "https://example.com/a/", urlKey: "https://example.com/a", title: "A2", summary: "a2" }),
    /UNIQUE/,
  );
  const b = store.add({ url: "https://example.com/b", urlKey: "https://example.com/b", title: "B", summary: "b" });
  assert.throws(
    () => store.update(b.id, { url: "https://example.com/a", urlKey: "https://example.com/a", title: "B", summary: "b" }),
    /UNIQUE/,
  );

  store.add({ title: "メモ 1", summary: "URL 無し" });
  store.add({ title: "メモ 2", summary: "URL 無し" });
  assert.deepEqual(titles(store, ""), ["メモ 2", "メモ 1", "B", "A"]);
  assert.equal(store.get(b.id)?.urlKey, "https://example.com/b");
  checkFtsIntegrity(db);
});

test("KnowledgeStore.search: 3 文字以上の語は FTS（bm25 の順）、3 文字未満の語は LIKE（新しい順）、混ざると AND", (t) => {
  const { store } = setup(t);
  store.add({ title: "SQLite の全文検索", summary: "FTS5 の trigram", tags: "sqlite" });
  store.add({ title: "東京の天気", summary: "練馬区の地域の予報を見る", body: "全文検索とは関係ない" });
  store.add({ title: "引っ越しの地域", summary: "東京都内で探す" });

  // 3 文字以上: 題名に含むものが本文に含むもの（より新しい）より上に来る
  assert.deepEqual(titles(store, "全文検索"), ["SQLite の全文検索", "東京の天気"]);
  // 英字は大文字小文字を区別しない
  assert.deepEqual(titles(store, "TRIGRAM"), ["SQLite の全文検索"]);
  // 2 文字: どの列に含むかによらず新しい順
  assert.deepEqual(titles(store, "地域"), ["引っ越しの地域", "東京の天気"]);
  assert.deepEqual(titles(store, "東京"), ["引っ越しの地域", "東京の天気"]);
  // 混ざった AND（全角の空白でも区切る）
  assert.deepEqual(titles(store, "全文検索 地域"), ["東京の天気"]);
  assert.deepEqual(titles(store, "東京\u3000練馬区"), ["東京の天気"]);
  assert.deepEqual(titles(store, "全文検索 天気予報"), []);
  assert.deepEqual(titles(store, "地域 sq"), []);
  // 1 文字も LIKE
  assert.deepEqual(titles(store, "都"), ["引っ越しの地域"]);
});

test("KnowledgeStore.search: 重複を除いた先頭 5 語まで、1 語 50 字までを使う", (t) => {
  const { store } = setup(t);
  store.add({ title: `${"あ".repeat(50)}い`, summary: "長い題名" });

  // 重複した語は 1 語に数える（重複を除いてから 5 語を選ぶので、5 語目の「含まれない」も使う）
  assert.equal(titles(store, "長い 長い 長い 題名 題名 あああ 題名 長い題名 含まれない").length, 0);
  // 6 語目（どれにも含まれない語）は使わない
  assert.deepEqual(titles(store, "長い 長い 題名 あああ 長い題名 長い 題名 名 含まれない"), [`${"あ".repeat(50)}い`]);
  // 51 字目以降は切る
  assert.deepEqual(titles(store, `${"あ".repeat(50)}う`), [`${"あ".repeat(50)}い`]);
});

test('KnowledgeStore.search: " % _ \\ や FTS の演算子を含む query でも壊れず、文字どおりに探す', (t) => {
  const { store } = setup(t);
  store.add({ title: '引用 "quote" の例', summary: "100% の確率" });
  store.add({ title: "snake_case の名前", summary: "C:\\path\\to の書き方" });
  store.add({ title: "どれにも当たらない", summary: "記号なし" });

  assert.deepEqual(titles(store, '"'), ['引用 "quote" の例']);
  assert.deepEqual(titles(store, '"quote"'), ['引用 "quote" の例']);
  assert.deepEqual(titles(store, '"quote'), ['引用 "quote" の例']);
  assert.deepEqual(titles(store, "%"), ['引用 "quote" の例']);
  assert.deepEqual(titles(store, "0%"), ['引用 "quote" の例']);
  assert.deepEqual(titles(store, "100%"), ['引用 "quote" の例']);
  assert.deepEqual(titles(store, "_"), ["snake_case の名前"]);
  assert.deepEqual(titles(store, "e_"), ["snake_case の名前"]);
  assert.deepEqual(titles(store, "\\"), ["snake_case の名前"]);
  assert.deepEqual(titles(store, "C:\\path"), ["snake_case の名前"]);
  assert.deepEqual(titles(store, "%_"), []);
  assert.deepEqual(titles(store, "\\%"), []);
  for (const query of ["AND", "OR NOT", "NEAR(a b)", "title:引用", "^引用", "引用*", "(", ")", "*", "-", "''", '""', '"""']) {
    assert.doesNotThrow(() => store.search(query), query);
  }
});

test("KnowledgeStore: 更新・削除は FTS に反映される。更新しても作成日時と登録したチャンネルは変えない", (t) => {
  const { db, store } = setup(t);
  const entry = store.add({
    url: "https://example.com/old",
    urlKey: "https://example.com/old",
    title: "古い題名",
    summary: "古い要約",
    body: "古い本文",
    tags: "old",
    channelId: "inbox-1",
  });
  store.add({ title: "残る項目", summary: "題名だけ" });

  const updated = store.update(entry.id, { title: "新しい題名", summary: "新しい要約", tags: "NEW" });
  assert.deepEqual(updated, {
    id: entry.id,
    url: null,
    urlKey: null,
    title: "新しい題名",
    summary: "新しい要約",
    body: "",
    tags: ["new"],
    channelId: "inbox-1",
    createdAt: "2026-10-07T00:00:00.000Z",
    updatedAt: "2026-10-07T00:02:00.000Z",
  });
  assert.deepEqual(store.get(entry.id), updated);
  assert.deepEqual(titles(store, "古い題名"), []);
  assert.deepEqual(titles(store, "古い本文"), []);
  assert.deepEqual(titles(store, "example.com"), []);
  assert.deepEqual(titles(store, "新しい題名"), ["新しい題名"]);
  assert.deepEqual(titles(store, "new"), ["新しい題名"]);
  assert.equal(store.getByUrlKey("https://example.com/old"), undefined);
  // 更新したものが新しい順の先頭に来る
  assert.deepEqual(titles(store, ""), ["新しい題名", "残る項目"]);
  assert.equal(store.update(99, { title: "無い", summary: "無い" }), undefined);
  checkFtsIntegrity(db);

  assert.deepEqual(store.delete(entry.id), updated);
  assert.equal(store.get(entry.id), undefined);
  assert.deepEqual(titles(store, "新しい題名"), []);
  assert.deepEqual(titles(store, "題名"), ["残る項目"]);
  assert.equal(store.delete(entry.id), undefined);
  checkFtsIntegrity(db);
});

test("KnowledgeStore.search: 空の query は新しい順（updated_at）の一覧。limit+1 件を引いて more を出す", (t) => {
  const { store } = setup(t);
  for (let i = 1; i <= 12; i++) store.add({ title: `項目 ${i}`, summary: "共通の要約" });
  store.update(3, { title: "項目 3", summary: "共通の要約" });

  assert.deepEqual(store.search(""), {
    entries: store.search("  \u3000 ").entries,
    more: true,
  });
  assert.deepEqual(titles(store, ""), ["項目 3", "項目 12", "項目 11", "項目 10", "項目 9"]);
  assert.equal(store.search("").more, true);
  // 本文は返さない
  assert.equal("body" in store.search("").entries[0]!, false);

  // limit は 1〜10
  assert.equal(store.search("", 10).entries.length, 10);
  assert.equal(store.search("", 10).more, true);
  assert.equal(store.search("", 100).entries.length, 10);
  assert.equal(store.search("", 0).entries.length, 1);
  assert.equal(store.search("", 2.5).entries.length, 5);

  // ちょうど limit 件なら more は false
  assert.equal(store.search("共通の要約", 10).more, true);
  for (let id = 1; id <= 3; id++) store.delete(id);
  const all = store.search("共通の要約", 10);
  assert.equal(all.entries.length, 9);
  assert.equal(all.more, false);
  const exact = store.search("項目", 9);
  assert.equal(exact.entries.length, 9);
  assert.equal(exact.more, false);
  const fewer = store.search("項目", 8);
  assert.equal(fewer.entries.length, 8);
  assert.equal(fewer.more, true);
});

test("KnowledgeStore: 一番大きい id を消しても、次の追加で同じ id を使い回さない（古い削除確認のボタンが別の項目を消さないため）", (t) => {
  const { store } = setup(t);
  const first = store.add({ title: "一つ目", summary: "a" });
  const second = store.add({ title: "二つ目", summary: "b" });
  store.delete(second.id);
  const third = store.add({ title: "三つ目", summary: "c" });
  assert.ok(third.id > second.id, `id ${third.id} は ${second.id} より大きいこと`);
  assert.equal(store.get(second.id), undefined);
  assert.equal(store.get(first.id)?.title, "一つ目");
  // 全文検索も新しい id で引ける
  assert.deepEqual(titles(store, "三つ目"), ["三つ目"]);
});
