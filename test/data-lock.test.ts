import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { acquireDataLock, type DataLockOptions, lockPath } from "../src/store/data-lock.ts";
import { tempDir } from "./helpers/db.ts";

const BOOT = "boot-now";
/** 3 行目（引数）の無い古い lock を書いた前の版の Bot のコマンドライン */
const BOT_CMDLINE = "node --env-file-if-exists=/home/x/.config/self-agent/env src/main.ts";
/** 自分のコマンドラインの argv[0] より後ろ（lock の 3 行目） */
const OWN_ARGS = "src/cli.ts start";

/** 読み手を注入した既定（同じ起動・PID は生きていて・この Bot のプロセス） */
function options(pid: number, overrides: Partial<DataLockOptions> = {}): DataLockOptions {
  return { pid, isAlive: () => true, readBootId: () => BOOT, readCmdline: () => BOT_CMDLINE, readOwnArgs: () => OWN_ARGS, ...overrides };
}

test("acquireDataLock: <dataDir>/lock に PID と boot id と引数の 3 行を置き（無ければディレクトリも作る）、release で消す。release は何度呼んでもよい", (t) => {
  const dataDir = join(tempDir(t), "data");
  const lock = acquireDataLock(dataDir, options(4242));
  assert.equal(readFileSync(lockPath(dataDir), "utf8"), `4242\n${BOOT}\nsrc/cli.ts start\n`);
  assert.equal(statSync(lockPath(dataDir)).mode & 0o777, 0o600);
  // 一時ファイルは残さない
  assert.deepEqual(readdirSync(dataDir), ["lock"]);

  lock.release();
  assert.equal(existsSync(lockPath(dataDir)), false);
  lock.release();

  // 外した後は取り直せる。boot id が読めなければ 2 行目は空
  const again = acquireDataLock(dataDir, options(4243, { readBootId: () => undefined }));
  assert.equal(readFileSync(lockPath(dataDir), "utf8"), "4243\n\nsrc/cli.ts start\n");
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
    { label: "4 行ある", content: `100\n${BOOT}\nsrc/cli.ts start\nx\n`, overrides: {} },
    { label: "自分の PID（前のプロセスと同じ PID）", content: `200\n${BOOT}\n`, overrides: {} },
  ];
  for (const { label, content, overrides } of cases) {
    const dataDir = tempDir(t);
    writeFileSync(lockPath(dataDir), content);
    const lock = acquireDataLock(dataDir, options(200, overrides));
    assert.equal(readFileSync(lockPath(dataDir), "utf8"), `200\n${BOOT}\nsrc/cli.ts start\n`, label);
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
  // テストのプロセス（node --test …）は src/main.ts ではない（3 行目の無い古い lock は src/main.ts の印で比べる）
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

test("acquireDataLock: 3 行目のある lock は、持ち主のコマンドラインがその引数を含めば動いているとみなす（公開物の bin・checkout の src/cli.ts の両方）", (t) => {
  const cases: Array<{ label: string; command: string; cmdline: string }> = [
    {
      label: "npm i -g の bin（shebang 経由）",
      command: "/usr/local/lib/node_modules/@shinoharata/self-agent/bin/self-agent start",
      cmdline: "node /usr/local/lib/node_modules/@shinoharata/self-agent/bin/self-agent start",
    },
    {
      label: "checkout の src/cli.ts（npm start）",
      command: "src/cli.ts start",
      cmdline: "node --env-file-if-exists=/home/x/.config/self-agent/env src/cli.ts start",
    },
  ];
  for (const { label, command, cmdline } of cases) {
    const dataDir = tempDir(t);
    const content = `100\n${BOOT}\n${command}\n`;
    writeFileSync(lockPath(dataDir), content);
    assert.throws(
      () => acquireDataLock(dataDir, options(200, { isAlive: (pid) => pid === 100, readCmdline: () => cmdline })),
      /別の self-agent（PID 100）/,
      label,
    );
    assert.equal(readFileSync(lockPath(dataDir), "utf8"), content, label);
  }
});

test("acquireDataLock: 3 行目のある lock の持ち主のコマンドラインがその引数を含まなければ（Bot でない cli・PID の再利用・前の版の Bot の印だけ）取り直す", (t) => {
  const cases: Array<{ label: string; content: string; cmdline: string }> = [
    { label: "node src/cli.ts devlog（Bot でない）", content: `100\n${BOOT}\nsrc/cli.ts start\n`, cmdline: "node src/cli.ts devlog --last 1" },
    {
      label: "bin の devlog（Bot でない）",
      content: `100\n${BOOT}\n/opt/self-agent/bin/self-agent start\n`,
      cmdline: "node /opt/self-agent/bin/self-agent devlog",
    },
    { label: "別のプログラム", content: `100\n${BOOT}\nsrc/cli.ts start\n`, cmdline: "/usr/sbin/sshd -D" },
    // 3 行目があれば src/main.ts の印では比べない
    { label: "src/main.ts を含むだけ", content: `100\n${BOOT}\n/opt/self-agent/bin/self-agent start\n`, cmdline: BOT_CMDLINE },
  ];
  for (const { label, content, cmdline } of cases) {
    const dataDir = tempDir(t);
    writeFileSync(lockPath(dataDir), content);
    const lock = acquireDataLock(dataDir, options(200, { isAlive: (pid) => pid === 100, readCmdline: () => cmdline }));
    assert.equal(readFileSync(lockPath(dataDir), "utf8"), `200\n${BOOT}\nsrc/cli.ts start\n`, label);
    lock.release();
  }
});

test("acquireDataLock: 3 行目の無い・空の古い lock は src/main.ts の印で比べ、boot id の無い 3 行の lock も読める", (t) => {
  const running: Array<{ label: string; content: string; cmdline: string }> = [
    { label: "2 行（前の版の Bot）", content: `100\n${BOOT}\n`, cmdline: BOT_CMDLINE },
    { label: "3 行目が空", content: `100\n${BOOT}\n\n`, cmdline: BOT_CMDLINE },
    { label: "boot id が空の 3 行", content: "100\n\nsrc/cli.ts start\n", cmdline: "node src/cli.ts start" },
  ];
  for (const { label, content, cmdline } of running) {
    const dataDir = tempDir(t);
    writeFileSync(lockPath(dataDir), content);
    assert.throws(
      () => acquireDataLock(dataDir, options(200, { isAlive: (pid) => pid === 100, readCmdline: () => cmdline })),
      /別の self-agent（PID 100）/,
      label,
    );
  }
  // 2 行の lock で、PID のプロセスが新しい版の cli（src/main.ts を含まない）なら前の版の Bot ではない
  const dataDir = tempDir(t);
  writeFileSync(lockPath(dataDir), `100\n${BOOT}\n`);
  const lock = acquireDataLock(dataDir, options(200, { isAlive: (pid) => pid === 100, readCmdline: () => "node src/cli.ts devlog" }));
  lock.release();
});

test("acquireDataLock: 3 行目は自分のコマンドライン（相対パスのまま）で、相対パスで起動した 2 つ目の Bot（argv[1] は絶対パス）を拒む", (t) => {
  const dataDir = tempDir(t);
  // 1 つ目: `node src/cli.ts start` で起動（process.argv[1] は node が解決した絶対パス）
  const first = acquireDataLock(
    dataDir,
    options(100, { readOwnArgs: () => "src/cli.ts start", argv: ["/home/x/self-agent/src/cli.ts", "start"] }),
  );
  assert.equal(readFileSync(lockPath(dataDir), "utf8"), `100\n${BOOT}\nsrc/cli.ts start\n`);
  // 2 つ目: 1 つ目の /proc/<pid>/cmdline は起動したときの文字列のまま
  assert.throws(
    () =>
      acquireDataLock(
        dataDir,
        options(200, {
          isAlive: (pid) => pid === 100,
          readCmdline: () => "node src/cli.ts start",
          readOwnArgs: () => "src/cli.ts start",
          argv: ["/home/x/self-agent/src/cli.ts", "start"],
        }),
      ),
    /別の self-agent（PID 100）/,
  );
  first.release();
});

test("acquireDataLock: 自分のコマンドラインが読めなければ 3 行目は process.argv.slice(1)（注入した argv）", (t) => {
  const dataDir = tempDir(t);
  const lock = acquireDataLock(dataDir, options(4242, { readOwnArgs: () => undefined, argv: ["/opt/self-agent/bin/self-agent", "start"] }));
  assert.equal(readFileSync(lockPath(dataDir), "utf8"), `4242\n${BOOT}\n/opt/self-agent/bin/self-agent start\n`);
  lock.release();
});

test("acquireDataLock: 自分のコマンドラインの改行は空白にして 1 行で書き、持ち主のコマンドラインも改行を空白にして比べる", (t) => {
  const dataDir = tempDir(t);
  const lock = acquireDataLock(dataDir, options(4242, { readOwnArgs: () => "src/cli.ts start a\nb" }));
  const content = readFileSync(lockPath(dataDir), "utf8");
  assert.equal(content, `4242\n${BOOT}\nsrc/cli.ts start a b\n`);
  assert.throws(
    () => acquireDataLock(dataDir, options(200, { readCmdline: () => "node src/cli.ts start a\nb" })),
    /別の self-agent（PID 4242）/,
  );
  lock.release();
});
