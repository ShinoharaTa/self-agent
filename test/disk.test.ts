import { test } from "node:test";
import assert from "node:assert/strict";
import {
  chmodSync,
  existsSync,
  lstatSync,
  lutimesSync,
  mkdirSync,
  readFileSync,
  renameSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import {
  DISK_FREE_REASON,
  DiskQuota,
  PROJECT_SIZE_CACHE_MS,
  PROJECT_SIZE_REASON,
  pruneWorkDir,
  removeNodeModules,
  treeSize,
  WORK_TMP_MAX_AGE_MS,
  WORKDIR_MIN_FREE_BYTES,
} from "../src/agent/disk.ts";
import { removeTree } from "../src/agent/remove-tree.ts";
import { tempDir } from "./helpers/db.ts";

const MIB = 1024 * 1024;
const GIB = 1024 * MIB;
const NOW = new Date("2026-10-13T03:00:00Z");
const PLENTY = { bavail: GIB / 4096, bsize: 4096 };
// .tmp の掃除は find がシステムの時計で判定するので、今の時刻を基準にする
const OLD = new Date(Date.now() - 2 * WORK_TMP_MAX_AGE_MS);
const RECENT = new Date(Date.now() - WORK_TMP_MAX_AGE_MS + 60 * 60 * 1000);

/** path の lstat の blocks × 512（treeSize が 1 つのものに数える大きさ） */
function used(path: string): number {
  return lstatSync(path).blocks * 512;
}

/** 読み書きできないディレクトリを作り、戻す関数を返す（一時ディレクトリを消す前に戻す） */
function lockedDir(path: string): () => void {
  mkdirSync(join(path, "inner"), { recursive: true });
  chmodSync(path, 0o000);
  return () => chmodSync(path, 0o700);
}

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


test("DiskQuota: 上限を超えた結果はキャッシュしない（.trash に移したら次の判定で数え直して許す）。上限の内の結果は 60 秒キャッシュする", (t) => {
  const workDir = tempDir(t);
  const projectsDir = join(workDir, "projects");
  const dir = join(projectsDir, "kakeibo");
  mkdirSync(join(dir, "site"), { recursive: true });
  mkdirSync(join(dir, ".trash", "20261013T030000Z"), { recursive: true });
  writeFileSync(join(dir, "site", "big.bin"), Buffer.alloc(256 * 1024));
  const limit = treeSize(dir, undefined, [".trash"]) - 128 * 1024;
  const clock = { now: NOW };
  const quota = new DiskQuota({ workDir, projectsDir, now: () => clock.now, statfs: () => PLENTY, projectMaxBytes: limit });

  assert.equal(quota.check("kakeibo").allowed, false);
  // 60 秒以内でも、上限を超えた結果は使わずに数え直す
  renameSync(join(dir, "site", "big.bin"), join(dir, ".trash", "20261013T030000Z", "big.bin"));
  clock.now = new Date(NOW.getTime() + 1000);
  assert.deepEqual(quota.check("kakeibo"), { allowed: true });

  // 上限の内の結果はキャッシュするので、60 秒以内に大きくなっても許す
  writeFileSync(join(dir, "site", "again.bin"), Buffer.alloc(256 * 1024));
  clock.now = new Date(NOW.getTime() + 1000 + PROJECT_SIZE_CACHE_MS - 1);
  assert.deepEqual(quota.check("kakeibo"), { allowed: true });
  clock.now = new Date(NOW.getTime() + 1000 + PROJECT_SIZE_CACHE_MS);
  assert.equal(quota.check("kakeibo").allowed, false);
});

test("DiskQuota.check: 空きが 512 MB 未満なら free（.trash に移すよう勧めない）、プロジェクト（直下の .trash を除く）が上限を超えたら project で拒否する。statfs は workDir に対して毎回呼ぶ", (t) => {
  const workDir = tempDir(t);
  const projectsDir = join(workDir, "projects");
  mkdirSync(join(projectsDir, "kakeibo", "site"), { recursive: true });
  mkdirSync(join(projectsDir, "kakeibo", ".trash", "20261001T000000Z"), { recursive: true });
  writeFileSync(join(projectsDir, "kakeibo", "site", "x.bin"), Buffer.alloc(64 * 1024));
  // 大きな .trash は数えない
  writeFileSync(join(projectsDir, "kakeibo", ".trash", "20261001T000000Z", "big.bin"), Buffer.alloc(1024 * 1024));
  const size = treeSize(join(projectsDir, "kakeibo"), undefined, [".trash"]);
  assert.ok(size < 1024 * 1024);
  const free = { allowed: false, kind: "free", reason: DISK_FREE_REASON };
  const project = { allowed: false, kind: "project", reason: PROJECT_SIZE_REASON };

  const cases: Array<{ label: string; free: number; projectMaxBytes: number; expected: unknown }> = [
    { label: "どちらも内", free: 600 * MIB, projectMaxBytes: size, expected: { allowed: true } },
    { label: "空きがちょうど 512 MB", free: WORKDIR_MIN_FREE_BYTES, projectMaxBytes: size, expected: { allowed: true } },
    { label: "空きが 512 MB 未満", free: WORKDIR_MIN_FREE_BYTES - 4096, projectMaxBytes: size, expected: free },
    { label: "空きが足りず、プロジェクトも超える（空きを先に見る）", free: 0, projectMaxBytes: 0, expected: free },
    { label: "プロジェクトが上限を超える", free: 600 * MIB, projectMaxBytes: size - 1, expected: project },
    { label: ".trash の分を足すと上限を超えるが、数えない", free: 600 * MIB, projectMaxBytes: size + 4096, expected: { allowed: true } },
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
  assert.ok(!DISK_FREE_REASON.includes("project_files") && DISK_FREE_REASON.includes("オーナー"));
  assert.ok(PROJECT_SIZE_REASON.includes("project_files") && PROJECT_SIZE_REASON.includes(".trash"));

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

test("pruneWorkDir: .tmp はファイルごとの更新で判定する（古いディレクトリの中の新しいファイルは残す）。空になった古いディレクトリは下から消し、symlink はリンクだけ消す", async (t) => {
  const root = tempDir(t);
  const workDir = join(root, "work");
  const tmp = join(workDir, ".tmp");
  const outside = join(root, "outside");
  mkdirSync(outside, { recursive: true });
  writeFileSync(join(outside, "keep"), "x");
  utimesSync(join(outside, "keep"), OLD, OLD);
  // 古いディレクトリの中に、古いファイルと新しいファイル
  mkdirSync(join(tmp, "mixed", "deep"), { recursive: true });
  writeFileSync(join(tmp, "mixed", "old.txt"), "x");
  writeFileSync(join(tmp, "mixed", "deep", "new.txt"), "x");
  utimesSync(join(tmp, "mixed", "old.txt"), OLD, OLD);
  utimesSync(join(tmp, "mixed", "deep", "new.txt"), RECENT, RECENT);
  // 古いものだけのディレクトリ（中ごと消える）・新しい空のディレクトリ（残る）
  mkdirSync(join(tmp, "stale", "a", "b"), { recursive: true });
  writeFileSync(join(tmp, "stale", "a", "b", "old.txt"), "x");
  utimesSync(join(tmp, "stale", "a", "b", "old.txt"), OLD, OLD);
  mkdirSync(join(tmp, "fresh-empty"));
  // 古い symlink（外のディレクトリを指す）
  symlinkSync(outside, join(tmp, "old-link"));
  lutimesSync(join(tmp, "old-link"), OLD, OLD);
  writeFileSync(join(tmp, "new-file"), "x");
  writeFileSync(join(tmp, "old-file"), "x");
  utimesSync(join(tmp, "old-file"), OLD, OLD);
  // ディレクトリの mtime は中を作った後に古くする
  for (const dir of ["mixed/deep", "mixed", "stale/a/b", "stale/a", "stale"]) utimesSync(join(tmp, dir), OLD, OLD);
  utimesSync(join(tmp, "fresh-empty"), RECENT, RECENT);

  await pruneWorkDir(workDir);

  assert.ok(!existsSync(join(tmp, "mixed", "old.txt")));
  assert.ok(existsSync(join(tmp, "mixed", "deep", "new.txt")));
  assert.ok(!existsSync(join(tmp, "stale")));
  assert.ok(existsSync(join(tmp, "fresh-empty")));
  assert.ok(!existsSync(join(tmp, "old-link")));
  assert.equal(readFileSync(join(outside, "keep"), "utf8"), "x");
  assert.ok(existsSync(join(tmp, "new-file")));
  assert.ok(!existsSync(join(tmp, "old-file")));
  assert.ok(existsSync(tmp));
});

test("pruneWorkDir: .tmp の中で消せないもの（読めないディレクトリ）があっても残りを消してから 1 回だけ投げる（パスは出さない）。workDir 直下の読めない lost+found は見ない", async (t) => {
  const root = tempDir(t);
  const workDir = join(root, "work");
  const tmp = join(workDir, ".tmp");
  mkdirSync(tmp, { recursive: true });
  const unlocks = [lockedDir(join(workDir, "lost+found"))];
  try {
    writeFileSync(join(tmp, "old-file"), "x");
    utimesSync(join(tmp, "old-file"), OLD, OLD);

    // lost+found だけなら失敗しない
    await pruneWorkDir(workDir);
    assert.ok(!existsSync(join(tmp, "old-file")));

    unlocks.push(lockedDir(join(tmp, "locked")));
    writeFileSync(join(tmp, "z-old-file"), "x");
    utimesSync(join(tmp, "z-old-file"), OLD, OLD);
    await assert.rejects(pruneWorkDir(workDir), (error: Error) => !error.message.includes(root));
    assert.ok(!existsSync(join(tmp, "z-old-file")));
  } finally {
    for (const unlock of unlocks) unlock();
  }
});

test("pruneWorkDir: 上限を超えた .cache を丸ごと消す。.tmp・.cache が無い・symlink なら何もしない（指す先は消さない）", async (t) => {
  const root = tempDir(t);
  const workDir = join(root, "work");
  const cache = join(workDir, ".cache");
  mkdirSync(join(cache, "npm"), { recursive: true });
  writeFileSync(join(cache, "npm", "pkg.tgz"), Buffer.alloc(64 * 1024));
  const cacheSize = treeSize(cache);

  await pruneWorkDir(workDir, cacheSize);
  assert.ok(existsSync(join(cache, "npm", "pkg.tgz")));
  await pruneWorkDir(workDir, cacheSize - 1);
  assert.ok(!existsSync(cache));
  await pruneWorkDir(join(root, "missing"), 0);

  const outside = join(root, "outside");
  mkdirSync(outside);
  writeFileSync(join(outside, "keep"), Buffer.alloc(64 * 1024));
  utimesSync(join(outside, "keep"), OLD, OLD);
  symlinkSync(outside, join(workDir, ".tmp"));
  symlinkSync(outside, join(workDir, ".cache"));

  await pruneWorkDir(workDir, 0);

  assert.ok(existsSync(join(outside, "keep")));
  assert.ok(lstatSync(join(workDir, ".tmp")).isSymbolicLink());
  assert.ok(lstatSync(join(workDir, ".cache")).isSymbolicLink());
});

test("removeNodeModules: 深さ 3 までの node_modules を消し、4 より深いもの・直下の .trash と site の中・symlink のディレクトリの先には入らない。symlink の node_modules はリンクだけ消す", async (t) => {
  const root = tempDir(t);
  const projectsDir = join(root, "projects");
  const dir = join(projectsDir, "kakeibo");
  const outside = join(root, "outside");
  mkdirSync(join(outside, "node_modules", "pkg"), { recursive: true });
  writeFileSync(join(outside, "node_modules", "pkg", "index.js"), "x");

  const removedPaths = ["node_modules", "a/node_modules", "a/b/node_modules", "app/site/node_modules"];
  const keptPaths = ["a/b/c/node_modules", ".trash/20261001T000000Z/node_modules", "site/node_modules", "site/vendor/node_modules"];
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

  const removed = await removeNodeModules(projectsDir, "kakeibo");

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
  assert.equal(await removeNodeModules(projectsDir, "kakeibo"), 0);
  assert.equal(await removeNodeModules(projectsDir, "missing"), 0);
});

test("removeNodeModules: プロジェクトの dir が projectsDir の直下のディレクトリそのものでない（外を指す symlink）・projectsDir が symlink か realpath でないなら、何も消さずに undefined", async (t) => {
  const root = tempDir(t);
  const projectsDir = join(root, "projects");
  const outside = join(root, "outside");
  mkdirSync(join(outside, "node_modules", "pkg"), { recursive: true });
  mkdirSync(join(outside, "a", "node_modules"), { recursive: true });
  writeFileSync(join(outside, "node_modules", "pkg", "index.js"), "x");
  mkdirSync(projectsDir);
  symlinkSync(outside, join(projectsDir, "kakeibo"));
  // 別のプロジェクトを指す symlink も同じ
  mkdirSync(join(projectsDir, "other", "node_modules"), { recursive: true });
  symlinkSync(join(projectsDir, "other"), join(projectsDir, "alias"));

  assert.equal(await removeNodeModules(projectsDir, "kakeibo"), undefined);
  assert.equal(await removeNodeModules(projectsDir, "alias"), undefined);

  // projects そのものが外への symlink・realpath でない（symlink を通った）パスでも何も消さない
  const work = join(root, "work");
  mkdirSync(work);
  symlinkSync(outside, join(work, "projects"));
  mkdirSync(join(outside, "kakeibo", "node_modules"), { recursive: true });
  assert.equal(await removeNodeModules(join(work, "projects"), "kakeibo"), undefined);
  symlinkSync(root, join(work, "via-link"));
  mkdirSync(join(projectsDir, "real", "node_modules"), { recursive: true });
  assert.equal(await removeNodeModules(join(work, "via-link", "projects"), "real"), undefined);
  assert.ok(existsSync(join(outside, "kakeibo", "node_modules")));
  assert.ok(existsSync(join(projectsDir, "real", "node_modules")));
  // 同じものを本来のパスで渡せば消す
  assert.equal(await removeNodeModules(projectsDir, "real"), 1);

  assert.ok(existsSync(join(outside, "node_modules", "pkg", "index.js")));
  assert.ok(existsSync(join(outside, "a", "node_modules")));
  assert.ok(existsSync(join(projectsDir, "other", "node_modules")));
  assert.ok(lstatSync(join(projectsDir, "kakeibo")).isSymbolicLink());
});

test("removeTree: 中身ごと消す。symlink を渡すとリンクだけを消し、指す先（ディレクトリ・ファイル）は消さない。無ければ何もしない。絶対パスでなければ投げる", async (t) => {
  const root = tempDir(t);
  const outside = join(root, "outside");
  mkdirSync(join(outside, "sub"), { recursive: true });
  writeFileSync(join(outside, "sub", "keep.txt"), "keep");
  const work = join(root, "work");
  mkdirSync(join(work, "tree", "a", "b"), { recursive: true });
  writeFileSync(join(work, "tree", "a", "b", "x.txt"), "x");
  symlinkSync(outside, join(work, "tree", "a", "to-outside"));
  symlinkSync(outside, join(work, "dir-link"));
  symlinkSync(join(outside, "sub", "keep.txt"), join(work, "file-link"));

  await removeTree(join(work, "tree"));
  await removeTree(join(work, "dir-link"));
  await removeTree(join(work, "file-link"));
  await removeTree(join(work, "missing"));

  assert.ok(!existsSync(join(work, "tree")));
  assert.throws(() => lstatSync(join(work, "dir-link")));
  assert.throws(() => lstatSync(join(work, "file-link")));
  assert.equal(readFileSync(join(outside, "sub", "keep.txt"), "utf8"), "keep");
  // 消せなければ（親に書けない）終了コードだけで投げる
  const locked = join(root, "locked");
  mkdirSync(join(locked, "child"), { recursive: true });
  chmodSync(locked, 0o500);
  try {
    await assert.rejects(removeTree(join(locked, "child")), (error: Error) => error.message === "rm が失敗しました（1）");
  } finally {
    chmodSync(locked, 0o700);
  }
  assert.ok(existsSync(join(locked, "child")));
  await assert.rejects(removeTree("relative/path"));
  await assert.rejects(removeTree(`${join(work, "dir-link")}/`));
});
