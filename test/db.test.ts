import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { DB_BUSY_TIMEOUT_MS, rollbackIfOpen } from "../src/store/db.ts";

test("busy timeout は 5000 ミリ秒（openDb と CLI が共有する）", () => {
  assert.equal(DB_BUSY_TIMEOUT_MS, 5000);
});

test("rollbackIfOpen はトランザクションが無いときに呼んでも投げない", () => {
  const db = new DatabaseSync(":memory:");
  assert.equal(db.isTransaction, false);
  assert.doesNotThrow(() => rollbackIfOpen(db));
  // 素の ROLLBACK は投げる（元の例外を上書きしていた理由）
  assert.throws(() => db.exec("ROLLBACK"), /no transaction is active/);
  db.close();
});

test("rollbackIfOpen はトランザクションがあれば ROLLBACK する", () => {
  const db = new DatabaseSync(":memory:");
  db.exec("CREATE TABLE t (x INTEGER)");
  db.exec("BEGIN");
  db.exec("INSERT INTO t VALUES (1)");
  assert.equal(db.isTransaction, true);
  rollbackIfOpen(db);
  assert.equal(db.isTransaction, false);
  assert.equal(Number(db.prepare("SELECT count(*) AS n FROM t").get()?.n), 0);
  db.close();
});

test("rollbackIfOpen は SQLite が自動で rollback した後でも元の例外を残す", () => {
  const db = new DatabaseSync(":memory:");
  db.exec("CREATE TABLE t (x INTEGER)");
  // RAISE(ROLLBACK) はトランザクションごと自動で rollback する
  db.exec("CREATE TRIGGER t_fail BEFORE INSERT ON t WHEN NEW.x = 2 BEGIN SELECT RAISE(ROLLBACK, 'boom'); END");
  const run = (): void => {
    db.exec("BEGIN");
    try {
      db.exec("INSERT INTO t VALUES (1)");
      db.exec("INSERT INTO t VALUES (2)");
      db.exec("COMMIT");
    } catch (error) {
      rollbackIfOpen(db);
      throw error;
    }
  };
  assert.throws(run, /boom/);
  assert.equal(db.isTransaction, false);
  assert.equal(Number(db.prepare("SELECT count(*) AS n FROM t").get()?.n), 0);
  db.close();
});
