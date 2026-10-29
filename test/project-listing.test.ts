import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  listProjectFiles,
  PROJECT_FILE_MAX_BYTES,
  PROJECT_LIST_MAX_FILES,
  readProjectFile,
} from "../src/agent/project-listing.ts";
import { tempDir } from "./helpers/db.ts";

function write(path: string, content: string | Buffer): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}

/**
 * `<base>/projects/kakeibo` にファイルを置く。プロジェクトの外（`<base>/secret.txt`・`<base>/outside/`）と、
 * 一覧に出さないもの（ドットファイル・.trash・.git・node_modules・symlink）も置く
 */
function setup(t: TestContext) {
  const base = realpathSync(tempDir(t));
  const projectsDir = join(base, "projects");
  const dir = join(projectsDir, "kakeibo");
  write(join(base, "secret.txt"), "SECRET");
  write(join(base, "outside", "index.html"), "OUTSIDE");
  write(join(dir, "DESIGN.md"), "# design");
  write(join(dir, "site", "index.html"), "<!doctype html>\n<p>家計簿</p>\n");
  write(join(dir, "site", "app.js"), "console.log(1);");
  write(join(dir, "site", "sub", "a.txt"), "a");
  write(join(dir, "site", ".env"), "SECRET=1");
  write(join(dir, ".trash", "20261029T051200Z", "site", "old.html"), "old");
  write(join(dir, ".git", "config"), "[core]");
  write(join(dir, "node_modules", "x", "index.js"), "module.exports = 1;");
  write(join(dir, "site", "node_modules", "y.js"), "y");
  symlinkSync(join(base, "secret.txt"), join(dir, "site", "link.txt"));
  symlinkSync(join(base, "outside"), join(dir, "site", "outdir"));
  symlinkSync(join(dir, "site", "app.js"), join(dir, "site", "alias.js"));
  symlinkSync(join(dir, ".trash", "20261029T051200Z", "site", "old.html"), join(dir, "site", "trash-link.html"));
  return { base, projectsDir, dir };
}

test("listProjectFiles: 通常のファイルを名前の順に。symlink・ドットで始まるもの（.trash・.git）・node_modules は出さない", async (t) => {
  const { projectsDir } = setup(t);
  const listed = await listProjectFiles(projectsDir, "kakeibo");
  assert.ok(listed !== undefined);
  assert.deepEqual(
    listed.files.map((f) => f.path),
    ["DESIGN.md", "site/app.js", "site/index.html", "site/sub/a.txt"],
  );
  assert.equal(listed.truncated, false);
  const index = listed.files.find((f) => f.path === "site/index.html")!;
  assert.equal(index.size, Buffer.byteLength("<!doctype html>\n<p>家計簿</p>\n"));
  assert.match(index.mtime, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
});

test("listProjectFiles: 500 件で止めて truncated。ちょうど 500 件なら truncated でない", async (t) => {
  const { projectsDir, dir } = setup(t);
  rmSync(join(dir, "site"), { recursive: true });
  rmSync(join(dir, "DESIGN.md"));
  for (let i = 0; i < PROJECT_LIST_MAX_FILES; i++) write(join(dir, "many", `f${String(i).padStart(4, "0")}.txt`), "x");
  const full = await listProjectFiles(projectsDir, "kakeibo");
  assert.equal(full?.files.length, PROJECT_LIST_MAX_FILES);
  assert.equal(full?.truncated, false);
  write(join(dir, "many", "z.txt"), "x");
  const over = await listProjectFiles(projectsDir, "kakeibo");
  assert.equal(over?.files.length, PROJECT_LIST_MAX_FILES);
  assert.equal(over?.truncated, true);
  assert.equal(over?.files.some((f) => f.path === "many/z.txt"), false);
});

test("listProjectFiles: 深さ 6 まで。それより深いものは出さずに truncated", async (t) => {
  const { projectsDir, dir } = setup(t);
  write(join(dir, "a", "b", "c", "d", "e", "six.txt"), "6");
  const ok = await listProjectFiles(projectsDir, "kakeibo");
  assert.ok(ok?.files.some((f) => f.path === "a/b/c/d/e/six.txt"));
  assert.equal(ok?.truncated, false);
  write(join(dir, "a", "b", "c", "d", "e", "f", "seven.txt"), "7");
  const deep = await listProjectFiles(projectsDir, "kakeibo");
  assert.ok(deep?.files.some((f) => f.path === "a/b/c/d/e/six.txt"));
  assert.equal(deep?.files.some((f) => f.path.endsWith("seven.txt")), false);
  assert.equal(deep?.truncated, true);
  // 深さで止めても、同じディレクトリの後ろの名前は出す
  assert.ok(deep?.files.some((f) => f.path === "site/index.html"));
});

test("listProjectFiles: verifiedProjectDir を通らなければ undefined（無い・slug が symlink・ファイル・projects が symlink）", async (t) => {
  const { base, projectsDir } = setup(t);
  assert.equal(await listProjectFiles(projectsDir, "missing"), undefined);
  symlinkSync(join(base, "outside"), join(projectsDir, "linked"));
  assert.equal(await listProjectFiles(projectsDir, "linked"), undefined);
  write(join(projectsDir, "afile"), "x");
  assert.equal(await listProjectFiles(projectsDir, "afile"), undefined);
  symlinkSync(projectsDir, join(base, "projects-link"));
  assert.equal(await listProjectFiles(join(base, "projects-link"), "kakeibo"), undefined);
  assert.ok(await listProjectFiles(projectsDir, "kakeibo"));
});

test("readProjectFile: プロジェクトの中のテキストを返す（中を指す symlink は実際のパスで読む）", async (t) => {
  const { projectsDir } = setup(t);
  assert.deepEqual(await readProjectFile(projectsDir, "kakeibo", "site/index.html"), { text: "<!doctype html>\n<p>家計簿</p>\n" });
  assert.deepEqual(await readProjectFile(projectsDir, "kakeibo", "DESIGN.md"), { text: "# design" });
  assert.deepEqual(await readProjectFile(projectsDir, "kakeibo", "site/alias.js"), { text: "console.log(1);" });
});

test("readProjectFile: ..・絶対パス・空の要素・ドットで始まる要素（.trash・.env・.git）・NUL は invalid_path", async (t) => {
  const { projectsDir } = setup(t);
  for (const path of [
    "",
    "..",
    "../kakeibo/DESIGN.md",
    "site/../DESIGN.md",
    "site/../../../secret.txt",
    "/etc/passwd",
    `${projectsDir}/kakeibo/DESIGN.md`,
    "site//index.html",
    "site/",
    "./DESIGN.md",
    ".trash/20261029T051200Z/site/old.html",
    "site/.env",
    ".git/config",
    "site/index.html\0",
    "x".repeat(1025),
  ]) {
    assert.equal(await readProjectFile(projectsDir, "kakeibo", path), "invalid_path", JSON.stringify(path.slice(0, 40)));
  }
});

test("readProjectFile: 外・.trash を指す symlink は invalid_path（中身を返さない）", async (t) => {
  const { projectsDir } = setup(t);
  assert.equal(await readProjectFile(projectsDir, "kakeibo", "site/link.txt"), "invalid_path");
  assert.equal(await readProjectFile(projectsDir, "kakeibo", "site/outdir/index.html"), "invalid_path");
  assert.equal(await readProjectFile(projectsDir, "kakeibo", "site/trash-link.html"), "invalid_path");
});

test("readProjectFile: 無い・ディレクトリ・FIFO は not_found。プロジェクトが verifiedProjectDir を通らなければ not_found", async (t) => {
  const { base, projectsDir, dir } = setup(t);
  assert.equal(await readProjectFile(projectsDir, "kakeibo", "site/missing.html"), "not_found");
  assert.equal(await readProjectFile(projectsDir, "kakeibo", "site"), "not_found");
  assert.equal(await readProjectFile(projectsDir, "kakeibo", "site/sub"), "not_found");
  execFileSync("mkfifo", [join(dir, "site", "pipe")]);
  assert.equal(await readProjectFile(projectsDir, "kakeibo", "site/pipe"), "not_found");
  symlinkSync(join(base, "outside"), join(projectsDir, "linked"));
  assert.equal(await readProjectFile(projectsDir, "linked", "index.html"), "not_found");
  assert.equal(await readProjectFile(projectsDir, "missing", "index.html"), "not_found");
});

test("readProjectFile: 256 KB を超えれば too_large、先頭 8 KB に NUL か UTF-8 として読めなければ binary", async (t) => {
  const { projectsDir, dir } = setup(t);
  write(join(dir, "limit.txt"), Buffer.alloc(PROJECT_FILE_MAX_BYTES, "a"));
  const limit = await readProjectFile(projectsDir, "kakeibo", "limit.txt");
  assert.equal(typeof limit === "object" ? limit.text.length : limit, PROJECT_FILE_MAX_BYTES);
  write(join(dir, "big.txt"), Buffer.alloc(PROJECT_FILE_MAX_BYTES + 1, "a"));
  assert.equal(await readProjectFile(projectsDir, "kakeibo", "big.txt"), "too_large");
  write(join(dir, "image.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00]));
  assert.equal(await readProjectFile(projectsDir, "kakeibo", "image.png"), "binary");
  write(join(dir, "latin1.txt"), Buffer.from([0x63, 0x61, 0x66, 0xe9]));
  assert.equal(await readProjectFile(projectsDir, "kakeibo", "latin1.txt"), "binary");
});

test("readProjectFile: 判定の後・開く前に symlink にすり替えられても外を返さない（最後の要素は O_NOFOLLOW、途中は開いた fd の実際のパス）", async (t) => {
  const { base, projectsDir, dir } = setup(t);
  const site = join(dir, "site");
  // 最後の要素を外を指す symlink にすり替える
  const swapFile = async (): Promise<void> => {
    rmSync(join(site, "index.html"));
    symlinkSync(join(base, "secret.txt"), join(site, "index.html"));
  };
  assert.equal(await readProjectFile(projectsDir, "kakeibo", "site/index.html", { beforeOpen: swapFile }), "invalid_path");

  // 途中の要素（ディレクトリ）を外を指す symlink にすり替える（外に同じ名前のファイルを置く）
  write(join(base, "outside", "a.txt"), "OUTSIDE-A");
  const swapDir = async (): Promise<void> => {
    renameSync(join(site, "sub"), join(dir, "sub-moved"));
    symlinkSync(join(base, "outside"), join(site, "sub"));
  };
  assert.equal(await readProjectFile(projectsDir, "kakeibo", "site/sub/a.txt", { beforeOpen: swapDir }), "invalid_path");

  // .trash の中を指す symlink にすり替える
  write(join(dir, "plain.txt"), "plain");
  const swapTrash = async (): Promise<void> => {
    rmSync(join(dir, "plain.txt"));
    symlinkSync(join(dir, ".trash", "20261029T051200Z", "site", "old.html"), join(dir, "plain.txt"));
  };
  assert.equal(await readProjectFile(projectsDir, "kakeibo", "plain.txt", { beforeOpen: swapTrash }), "invalid_path");

  // ファイルを FIFO にすり替えても止まらない
  write(join(dir, "fifo.txt"), "x");
  const swapFifo = async (): Promise<void> => {
    rmSync(join(dir, "fifo.txt"));
    execFileSync("mkfifo", [join(dir, "fifo.txt")]);
  };
  assert.equal(await readProjectFile(projectsDir, "kakeibo", "fifo.txt", { beforeOpen: swapFifo }), "not_found");
});

test("listProjectFiles: ディレクトリを開く前に symlink にすり替えられても、外は一覧しない（最後の要素は O_NOFOLLOW、途中は開いた fd の実際のパス）", async (t) => {
  const { base, projectsDir, dir } = setup(t);
  write(join(base, "outside", "sub", "leak.txt"), "LEAK");
  // 最後の要素（site/sub）を外を指す symlink にすり替える
  const swapLast = async (path: string): Promise<void> => {
    if (path !== join(dir, "site", "sub")) return;
    renameSync(path, join(dir, "sub-moved"));
    symlinkSync(join(base, "outside", "sub"), path);
  };
  const last = await listProjectFiles(projectsDir, "kakeibo", { beforeOpen: swapLast });
  assert.equal(last?.files.some((f) => f.path.startsWith("site/sub/")), false);

  // 途中の要素（site）を、同じ名前の sub を持つ外のディレクトリへの symlink にすり替える
  rmSync(join(dir, "site", "sub"));
  renameSync(join(dir, "sub-moved"), join(dir, "site", "sub"));
  const swapMiddle = async (path: string): Promise<void> => {
    if (path !== join(dir, "site", "sub")) return;
    renameSync(join(dir, "site"), join(dir, "site-moved"));
    symlinkSync(join(base, "outside"), join(dir, "site"));
  };
  const middle = await listProjectFiles(projectsDir, "kakeibo", { beforeOpen: swapMiddle });
  assert.equal(middle?.files.some((f) => f.path.includes("leak.txt")), false);
});
