import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { acquireDataLock, type DataLockOptions, lockPath } from "../src/store/data-lock.ts";
import { tempDir } from "./helpers/db.ts";

const BOOT = "boot-now";
const BOT_CMDLINE = "node --env-file-if-exists=/home/x/.config/self-agent/env src/main.ts";

/** 読み手を注入した既定（同じ起動・PID は生きていて・この Bot のプロセス） */
function options(pid: number, overrides: Partial<DataLockOptions> = {}): DataLockOptions {
  return { pid, isAlive: () => true, readBootId: () => BOOT, readCmdline: () => BOT_CMDLINE, ...overrides };
}

test("acquireDataLock: <dataDir>/lock に PID と boot id を置き（無ければディレクトリも作る）、release で消す。release は何度呼んでもよい", (t) => {
  const dataDir = join(tempDir(t), "data");
  const lock = acquireDataLock(dataDir, options(4242));
  assert.equal(readFileSync(lockPath(dataDir), "utf8"), `4242\n${BOOT}\n`);
  assert.equal(statSync(lockPath(dataDir)).mode & 0o777, 0o600);
  // 一時ファイルは残さない
  assert.deepEqual(readdirSync(dataDir), ["lock"]);

  lock.release();
  assert.equal(existsSync(lockPath(dataDir)), false);
  lock.release();

  // 外した後は取り直せる。boot id が読めなければ PID だけ置く
  const again = acquireDataLock(dataDir, options(4243, { readBootId: () => undefined }));
  assert.equal(readFileSync(lockPath(dataDir), "utf8"), "4243\n");
  again.release();
  assert.equal(existsSync(lockPath(dataDir)), false);
});

test("acquireDataLock: ほかの self-agent が動いていればエラーにし（パスは出さない）、ロックはそのまま", (t) => {
  const cases: Array<{ label: string; content: string; overrides: Partial<DataLockOptions> }> = [
    { label: "同じ起動・生きている・この Bot", content: `100\n${BOOT}\n`, overrides: {} },
    { label: "boot id の無いロック（PID が生きていてこの Bot）", content: "100\n", overrides: {} },
    { label: "今の boot id が読めない", content: "100\nboot-old\n", overrides: { readBootId: () => undefined } },
    // /proc が読めなければ、PID が生きていることだけで判定する
    { label: "コマンドラインが読めない", content: `100\n${BOOT}\n`, overrides: { readCmdline: () => undefined } },
  ];
  for (const { label, content, overrides } of cases) {
    const dataDir = tempDir(t);
    writeFileSync(lockPath(dataDir), content);
    assert.throws(
      () => acquireDataLock(dataDir, options(200, { isAlive: (pid) => pid === 100, ...overrides })),
      (error: unknown) => {
        assert.ok(error instanceof Error, label);
        assert.equal(error.message, "別の self-agent（PID 100）が同じ SELF_AGENT_DATA_DIR を使っているため起動できません", label);
        return true;
      },
      label,
    );
    assert.equal(readFileSync(lockPath(dataDir), "utf8"), content, label);
  }
});

test("acquireDataLock: 古いロック（再起動の前・持ち主が無い・PID の再利用・形が違う・自分の PID）は取り直す", (t) => {
  const cases: Array<{ label: string; content: string; overrides: Partial<DataLockOptions> }> = [
    { label: "boot id が違う（再起動の前。PID は生きている）", content: "100\nboot-old\n", overrides: {} },
    { label: "持ち主が無い", content: `100\n${BOOT}\n`, overrides: { isAlive: () => false } },
    { label: "持ち主が無い（boot id なし・改行なし）", content: "100", overrides: { isAlive: () => false } },
    {
      label: "PID は生きているが別のプログラム",
      content: `100\n${BOOT}\n`,
      overrides: { readCmdline: () => "/usr/sbin/sshd -D" },
    },
    { label: "空", content: "", overrides: {} },
    { label: "PID の形でない", content: "abc\n", overrides: {} },
    { label: "3 行ある", content: "100\nboot\nx\n", overrides: {} },
    { label: "自分の PID（前のプロセスと同じ PID）", content: `200\n${BOOT}\n`, overrides: {} },
  ];
  for (const { label, content, overrides } of cases) {
    const dataDir = tempDir(t);
    writeFileSync(lockPath(dataDir), content);
    const lock = acquireDataLock(dataDir, options(200, overrides));
    assert.equal(readFileSync(lockPath(dataDir), "utf8"), `200\n${BOOT}\n`, label);
    lock.release();
    assert.equal(existsSync(lockPath(dataDir)), false, label);
  }
});

test("release: ロックが別のプロセスのものに置き換わっていれば消さない", (t) => {
  const dataDir = tempDir(t);
  const lock = acquireDataLock(dataDir, options(100));
  writeFileSync(lockPath(dataDir), `300\n${BOOT}\n`);
  lock.release();
  assert.equal(readFileSync(lockPath(dataDir), "utf8"), `300\n${BOOT}\n`);
});

test("acquireDataLock: 既定の読み手では、今の起動の生きている PID でもコマンドラインがこの Bot でなければ古いロック", (t) => {
  // テストのプロセス（node --test …）は src/main.ts ではない
  const dataDir = tempDir(t);
  writeFileSync(lockPath(dataDir), `${process.pid}\n`);
  const lock = acquireDataLock(dataDir, { pid: process.pid + 1 });
  assert.match(readFileSync(lockPath(dataDir), "utf8"), new RegExp(`^${process.pid + 1}\\n`));
  lock.release();

  // コマンドラインがこの Bot なら、既定の生死の判定で生きているものとして拒む
  writeFileSync(lockPath(dataDir), `${process.pid}\n`);
  assert.throws(
    () => acquireDataLock(dataDir, { pid: process.pid + 1, readCmdline: () => BOT_CMDLINE }),
    /PID/,
  );
});
