import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { acquireDataLock, lockPath } from "../src/store/data-lock.ts";
import { tempDir } from "./helpers/db.ts";

test("acquireDataLock: <dataDir>/lock に PID を置き（無ければディレクトリも作る）、release で消す。release は何度呼んでもよい", (t) => {
  const dataDir = join(tempDir(t), "data");
  const lock = acquireDataLock(dataDir, { pid: 4242, isAlive: () => true });
  assert.equal(readFileSync(lockPath(dataDir), "utf8"), "4242\n");
  assert.equal(statSync(lockPath(dataDir)).mode & 0o777, 0o600);
  // 一時ファイルは残さない
  assert.deepEqual(readdirSync(dataDir), ["lock"]);

  lock.release();
  assert.equal(existsSync(lockPath(dataDir)), false);
  lock.release();

  // 外した後は取り直せる
  acquireDataLock(dataDir, { pid: 4243, isAlive: () => true }).release();
});

test("acquireDataLock: ほかの生きているプロセスが持っていればエラーにし、ロックはそのまま", (t) => {
  const dataDir = tempDir(t);
  acquireDataLock(dataDir, { pid: 100, isAlive: () => true });
  assert.throws(
    () => acquireDataLock(dataDir, { pid: 200, isAlive: (pid) => pid === 100 }),
    /別の self-agent（PID 100）が同じ SELF_AGENT_DATA_DIR を使っているため起動できません/,
  );
  assert.equal(readFileSync(lockPath(dataDir), "utf8"), "100\n");
});

test("acquireDataLock: 持ち主のプロセスが無い・中身が PID の形でない・自分の PID のロックは古いものとして取り直す", (t) => {
  const cases = [
    { label: "持ち主が無い", content: "100\n" },
    { label: "改行なし", content: "100" },
    { label: "空", content: "" },
    { label: "PID の形でない", content: "abc\n" },
    { label: "自分の PID（前のプロセスと同じ PID）", content: "200\n" },
  ];
  for (const { label, content } of cases) {
    const dataDir = tempDir(t);
    writeFileSync(lockPath(dataDir), content);
    const isAliveCalls: number[] = [];
    const lock = acquireDataLock(dataDir, {
      pid: 200,
      isAlive: (pid) => {
        isAliveCalls.push(pid);
        return false;
      },
    });
    assert.equal(readFileSync(lockPath(dataDir), "utf8"), "200\n", label);
    lock.release();
    assert.equal(existsSync(lockPath(dataDir)), false, label);
    // 自分の PID と PID の形でないものは生死を確かめない
    assert.deepEqual(isAliveCalls, content.startsWith("100") ? [100] : [], label);
  }
});

test("release: ロックが別のプロセスのものに置き換わっていれば消さない", (t) => {
  const dataDir = tempDir(t);
  const lock = acquireDataLock(dataDir, { pid: 100, isAlive: () => false });
  writeFileSync(lockPath(dataDir), "300\n");
  lock.release();
  assert.equal(readFileSync(lockPath(dataDir), "utf8"), "300\n");
});

test("acquireDataLock: 既定の生死の判定では、今のプロセスの PID のロックは生きているものとして拒む", (t) => {
  const dataDir = tempDir(t);
  writeFileSync(lockPath(dataDir), `${process.pid}\n`);
  assert.throws(() => acquireDataLock(dataDir, { pid: process.pid + 1 }), /PID/);
});
