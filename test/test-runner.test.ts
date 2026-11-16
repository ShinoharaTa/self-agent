import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { pickTmpBase, testArgs } from "../scripts/test.ts";

// npm test の入口（scripts/test.ts。#401）: 一時ディレクトリの場所の判断・node に渡す引数・子の exit code と後始末
const ROOT = fileURLToPath(new URL("../", import.meta.url));

test("test runner: pickTmpBase は disk の指定・無い・ディレクトリでない場所では undefined、書けるディレクトリならそれを返す", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "self-agent-test-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const shm = join(dir, "shm");
  mkdirSync(shm);
  writeFileSync(join(dir, "file"), "x");
  assert.equal(pickTmpBase(undefined, shm), shm);
  assert.equal(pickTmpBase("", shm), shm);
  assert.equal(pickTmpBase("disk", shm), undefined);
  assert.equal(pickTmpBase(undefined, join(dir, "missing")), undefined);
  assert.equal(pickTmpBase(undefined, join(dir, "file")), undefined);
});

test("test runner: testArgs は引数が無ければ既定の glob、在ればその代わりに。-- で始まるものは --test より前", () => {
  assert.deepEqual(testArgs([]), ["--test", "test/*.test.ts"]);
  assert.deepEqual(testArgs(["test/config.test.ts"]), ["--test", "test/config.test.ts"]);
  assert.deepEqual(testArgs(["--test-name-pattern=x"]), ["--test-name-pattern=x", "--test", "test/*.test.ts"]);
  assert.deepEqual(testArgs(["a.test.ts", "--test-name-pattern=x"]), ["--test-name-pattern=x", "--test", "a.test.ts"]);
});

test("test runner: 子の exit code で終わり、終わった後に作った一時ディレクトリが残らない", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "self-agent-test-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, "fail.test.ts");
  writeFileSync(
    file,
    'import { test } from "node:test";\ntest("x", () => { console.log(`TMPDIR=${process.env.TMPDIR}`); throw new Error("fail"); });\n',
  );
  // 外の node --test が渡す NODE_TEST_CONTEXT を外す（在ると子は結果を外へ渡す形で走り、exit code が 0 になる）
  const { NODE_TEST_CONTEXT: _, ...env } = process.env;
  const result = spawnSync(process.execPath, ["scripts/test.ts", file], { cwd: ROOT, encoding: "utf8", env });
  assert.equal(result.status, 1);
  const used = /TMPDIR=(\S+)/.exec(result.stdout)?.[1];
  assert.ok(used !== undefined, "子の TMPDIR が出ていない");
  // /dev/shm を使えた機械では自分のディレクトリを作っている。それが消えている事
  if (pickTmpBase(process.env.SELF_AGENT_TEST_TMP) !== undefined) {
    assert.match(used, /^\/dev\/shm\/self-agent-test-/);
    assert.equal(existsSync(used), false);
  }
});
