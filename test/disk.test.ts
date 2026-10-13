import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, lstatSync, lutimesSync, mkdirSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  DISK_LIMIT_REASON,
  DiskQuota,
  NODE_MODULES_MAX_DEPTH,
  PROJECT_MAX_BYTES,
  PROJECT_SIZE_CACHE_MS,
  pruneWorkDir,
  removeNodeModules,
  treeSize,
  WORK_CACHE_MAX_BYTES,
  WORK_TMP_MAX_AGE_MS,
  WORKDIR_MIN_FREE_BYTES,
} from "../src/agent/disk.ts";
import { tempDir } from "./helpers/db.ts";

const MIB = 1024 * 1024;
const GIB = 1024 * MIB;
const NOW = new Date("2026-10-13T03:00:00Z");
const PLENTY = { bavail: GIB / 4096, bsize: 4096 };

/** path の lstat の blocks × 512（treeSize が 1 つのものに数える大きさ） */
function used(path: string): number {
  return lstatSync(path).blocks * 512;
}

test("上限の値", () => {
  assert.equal(WORKDIR_MIN_FREE_BYTES, 512 * MIB);
  assert.equal(PROJECT_MAX_BYTES, GIB);
  assert.equal(PROJECT_SIZE_CACHE_MS, 60 * 1000);
  assert.equal(WORK_TMP_MAX_AGE_MS, 24 * 60 * 60 * 1000);
  assert.equal(WORK_CACHE_MAX_BYTES, GIB);
  assert.equal(NODE_MODULES_MAX_DEPTH, 3);
  assert.ok(DISK_LIMIT_REASON.startsWith("容量の上限を超えています"));
  assert.ok(DISK_LIMIT_REASON.includes("project_files") && DISK_LIMIT_REASON.includes("オーナーに伝えて"));
});

test("treeSize: 中の全部を lstat で数え、symlink はたどらない（リンクそのものだけ）。無ければ 0。stopAbove を超えたらそこでやめる", (t) => {
  const root = tempDir(t);
  const dir = join(root, "project");
  mkdirSync(join(dir, "site"), { recursive: true });
  writeFileSync(join(dir, "site", "a.bin"), Buffer.alloc(64 * 1024));
  // 外の大きなファイルとディレクトリを指す symlink
  const outside = join(root, "outside");
  mkdirSync(outside);
  writeFileSync(join(outside, "big.bin"), Buffer.alloc(512 * 1024));
  symlinkSync(join(outside, "big.bin"), join(dir, "link-file"));
  symlinkSync(outside, join(dir, "link-dir"));

  const expected =
    used(dir) + used(join(dir, "site")) + used(join(dir, "site", "a.bin")) + used(join(dir, "link-file")) + used(join(dir, "link-dir"));
  assert.equal(treeSize(dir), expected);
  assert.ok(treeSize(dir) < 512 * 1024);
  assert.equal(treeSize(join(root, "missing")), 0);
  // 途中でやめても、返す値は stopAbove より大きい
  assert.ok(treeSize(dir, 1) > 1);
  assert.ok(treeSize(dir, 1) <= expected);
  // skipTopLevel は直下の名前だけ数えない（下の階層の同じ名前は数える）
  mkdirSync(join(dir, "site", "site"));
  assert.equal(treeSize(dir, undefined, ["site"]), used(dir) + used(join(dir, "link-file")) + used(join(dir, "link-dir")));
});

test("DiskQuota: プロジェクトの大きさ（直下の .trash は除く）を 60 秒キャッシュし、過ぎたら数え直す。プロジェクトごとに別", (t) => {
  const workDir = tempDir(t);
  const projectsDir = join(workDir, "projects");
  mkdirSync(join(projectsDir, "kakeibo", ".trash", "20261001T000000Z"), { recursive: true });
  mkdirSync(join(projectsDir, "kakeibo", "site", ".trash"), { recursive: true });
  mkdirSync(join(projectsDir, "other"), { recursive: true });
  writeFileSync(join(projectsDir, "kakeibo", ".trash", "20261001T000000Z", "old.bin"), Buffer.alloc(512 * 1024));
  // 直下でない .trash は普通のディレクトリとして数える
  writeFileSync(join(projectsDir, "kakeibo", "site", ".trash", "page.bin"), Buffer.alloc(64 * 1024));
  const clock = { now: NOW };
  const quota = new DiskQuota({ workDir, projectsDir, now: () => clock.now, statfs: () => PLENTY });

  const first = quota.projectBytes("kakeibo");
  assert.equal(first, treeSize(join(projectsDir, "kakeibo"), undefined, [".trash"]));
  assert.ok(first >= 64 * 1024 && first < 512 * 1024);

  writeFileSync(join(projectsDir, "kakeibo", "new.bin"), Buffer.alloc(128 * 1024));
  clock.now = new Date(NOW.getTime() + PROJECT_SIZE_CACHE_MS - 1);
  assert.equal(quota.projectBytes("kakeibo"), first);
  // 別のプロジェクトはキャッシュを使わない
  assert.equal(quota.projectBytes("other"), treeSize(join(projectsDir, "other")));

  clock.now = new Date(NOW.getTime() + PROJECT_SIZE_CACHE_MS);
  assert.equal(quota.projectBytes("kakeibo"), treeSize(join(projectsDir, "kakeibo"), undefined, [".trash"]));
  assert.ok(quota.projectBytes("kakeibo") >= first + 128 * 1024);
});

test("DiskQuota.check: workDir の空きが 512 MB 未満、またはプロジェクト（直下の .trash を除く）が上限を超えたら拒否する。statfs は workDir に対して毎回呼ぶ", (t) => {
  const workDir = tempDir(t);
  const projectsDir = join(workDir, "projects");
  mkdirSync(join(projectsDir, "kakeibo", "site"), { recursive: true });
  mkdirSync(join(projectsDir, "kakeibo", ".trash", "20261001T000000Z"), { recursive: true });
  writeFileSync(join(projectsDir, "kakeibo", "site", "x.bin"), Buffer.alloc(64 * 1024));
  // 大きな .trash は数えない
  writeFileSync(join(projectsDir, "kakeibo", ".trash", "20261001T000000Z", "big.bin"), Buffer.alloc(1024 * 1024));
  const size = treeSize(join(projectsDir, "kakeibo"), undefined, [".trash"]);
  assert.ok(size < 1024 * 1024);
  const denied = { allowed: false, reason: DISK_LIMIT_REASON };

  const cases: Array<{ label: string; free: number; projectMaxBytes: number; expected: unknown }> = [
    { label: "どちらも内", free: 600 * MIB, projectMaxBytes: size, expected: { allowed: true } },
    { label: "空きがちょうど 512 MB", free: WORKDIR_MIN_FREE_BYTES, projectMaxBytes: size, expected: { allowed: true } },
    { label: "空きが 512 MB 未満", free: WORKDIR_MIN_FREE_BYTES - 4096, projectMaxBytes: size, expected: denied },
    { label: "プロジェクトが上限を超える", free: 600 * MIB, projectMaxBytes: size - 1, expected: denied },
    { label: ".trash の分を足すと上限を超えるが、数えない", free: 600 * MIB, projectMaxBytes: size + 4096, expected: { allowed: true } },
    { label: ".trash を除けば上限の内でも、空きが 512 MB 未満", free: WORKDIR_MIN_FREE_BYTES - 1, projectMaxBytes: size, expected: denied },
  ];
  for (const item of cases) {
    const paths: string[] = [];
    const quota = new DiskQuota({
      workDir,
      projectsDir,
      now: () => NOW,
      statfs: (path) => {
        paths.push(path);
        return { bavail: item.free / 4096, bsize: 4096 };
      },
      projectMaxBytes: item.projectMaxBytes,
    });
    assert.deepEqual(quota.check("kakeibo"), item.expected, item.label);
    assert.deepEqual(quota.check("kakeibo"), item.expected, item.label);
    assert.deepEqual(paths, [workDir, workDir], item.label);
  }

  // まだ無いプロジェクトは 0 として数える
  const quota = new DiskQuota({ workDir, projectsDir, now: () => NOW, statfs: () => PLENTY, projectMaxBytes: 0 });
  assert.deepEqual(quota.check("missing"), { allowed: true });
  // statfs の失敗はそのまま投げる（hook が拒否する）
  const broken = new DiskQuota({
    workDir,
    projectsDir,
    now: () => NOW,
    statfs: () => {
      throw new Error("ENOENT");
    },
  });
  assert.throws(() => broken.check("kakeibo"));
});

test("pruneWorkDir: .tmp の直下で更新から 1 日を過ぎたものだけ消し（symlink はリンクだけ）、上限を超えた .cache を丸ごと消す", (t) => {
  const root = tempDir(t);
  const workDir = join(root, "work");
  const tmp = join(workDir, ".tmp");
  const cache = join(workDir, ".cache");
  mkdirSync(join(tmp, "old-dir", "nested"), { recursive: true });
  writeFileSync(join(tmp, "old-dir", "nested", "x"), "x");
  writeFileSync(join(tmp, "old-file"), "x");
  writeFileSync(join(tmp, "new-file"), "x");
  const outside = join(root, "outside");
  mkdirSync(outside);
  writeFileSync(join(outside, "keep"), "x");
  symlinkSync(outside, join(tmp, "old-link"));
  const old = new Date(NOW.getTime() - WORK_TMP_MAX_AGE_MS - 1000);
  const recent = new Date(NOW.getTime() - WORK_TMP_MAX_AGE_MS + 60 * 1000);
  utimesSync(join(tmp, "old-dir"), old, old);
  utimesSync(join(tmp, "old-file"), old, old);
  utimesSync(join(tmp, "new-file"), recent, recent);
  lutimesSync(join(tmp, "old-link"), old, old);
  mkdirSync(join(cache, "npm"), { recursive: true });
  writeFileSync(join(cache, "npm", "pkg.tgz"), Buffer.alloc(64 * 1024));
  const cacheSize = treeSize(cache);

  // 上限の内なら .cache は残す
  pruneWorkDir(workDir, NOW, cacheSize);
  assert.ok(!existsSync(join(tmp, "old-dir")));
  assert.ok(!existsSync(join(tmp, "old-file")));
  assert.ok(!existsSync(join(tmp, "old-link")));
  assert.ok(existsSync(join(tmp, "new-file")));
  assert.ok(existsSync(join(outside, "keep")));
  assert.ok(existsSync(tmp));
  assert.ok(existsSync(join(cache, "npm", "pkg.tgz")));

  pruneWorkDir(workDir, NOW, cacheSize - 1);
  assert.ok(!existsSync(cache));
  assert.ok(existsSync(join(tmp, "new-file")));
});

test("pruneWorkDir: .tmp・.cache が無い・symlink なら何もしない（指す先は消さない）", (t) => {
  const root = tempDir(t);
  const workDir = join(root, "work");
  mkdirSync(workDir);
  pruneWorkDir(workDir, NOW, 0);
  pruneWorkDir(join(root, "missing"), NOW, 0);

  const outside = join(root, "outside");
  mkdirSync(outside);
  writeFileSync(join(outside, "keep"), Buffer.alloc(64 * 1024));
  const old = new Date(NOW.getTime() - 2 * WORK_TMP_MAX_AGE_MS);
  utimesSync(join(outside, "keep"), old, old);
  symlinkSync(outside, join(workDir, ".tmp"));
  symlinkSync(outside, join(workDir, ".cache"));

  pruneWorkDir(workDir, NOW, 0);

  assert.ok(existsSync(join(outside, "keep")));
  assert.ok(lstatSync(join(workDir, ".tmp")).isSymbolicLink());
  assert.ok(lstatSync(join(workDir, ".cache")).isSymbolicLink());
});

test("removeNodeModules: 深さ 3 までの node_modules を消し、4 より深いもの・.trash の中・symlink のディレクトリの先には入らない。symlink の node_modules はリンクだけ消す", async (t) => {
  const root = tempDir(t);
  const dir = join(root, "project");
  const outside = join(root, "outside");
  mkdirSync(join(outside, "node_modules", "pkg"), { recursive: true });
  writeFileSync(join(outside, "node_modules", "pkg", "index.js"), "x");

  const removedPaths = ["node_modules", "a/node_modules", "a/b/node_modules", "site/node_modules"];
  const keptPaths = ["a/b/c/node_modules", ".trash/20261001T000000Z/node_modules"];
  for (const rel of [...removedPaths, ...keptPaths]) {
    mkdirSync(join(dir, rel, "pkg", "node_modules", "deep"), { recursive: true });
    writeFileSync(join(dir, rel, "pkg", "index.js"), "x");
  }
  // node_modules の中の symlink（.bin など）はたどらない
  symlinkSync(join(outside, "node_modules", "pkg"), join(dir, "node_modules", "linked-pkg"));
  // 外を指す symlink の node_modules（リンクだけ消す）と、外を指す symlink のディレクトリ（入らない）
  mkdirSync(join(dir, "linked"), { recursive: true });
  symlinkSync(join(outside, "node_modules"), join(dir, "linked", "node_modules"));
  symlinkSync(outside, join(dir, "outside-link"));
  // node_modules という名前のファイルは消さない
  mkdirSync(join(dir, "docs"), { recursive: true });
  writeFileSync(join(dir, "docs", "node_modules"), "x");
  writeFileSync(join(dir, "package.json"), "{}");

  const removed = await removeNodeModules(dir);

  assert.equal(removed, removedPaths.length + 1);
  for (const rel of removedPaths) assert.ok(!existsSync(join(dir, rel)), rel);
  for (const rel of keptPaths) assert.ok(existsSync(join(dir, rel, "pkg", "index.js")), rel);
  assert.ok(!existsSync(join(dir, "linked", "node_modules")));
  assert.ok(existsSync(join(dir, "linked")));
  assert.ok(existsSync(join(outside, "node_modules", "pkg", "index.js")));
  assert.ok(lstatSync(join(dir, "outside-link")).isSymbolicLink());
  assert.ok(existsSync(join(dir, "docs", "node_modules")));
  assert.ok(existsSync(join(dir, "package.json")));

  // 2 回目は消すものが無い。dir が無ければ 0
  assert.equal(await removeNodeModules(dir), 0);
  assert.equal(await removeNodeModules(join(root, "missing")), 0);
});
