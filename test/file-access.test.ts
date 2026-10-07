import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  FILE_NO_CONTEXT_REASON,
  FILE_READ_DENIED_REASON,
  FILE_WRITE_DENIED_REASON,
  judgeFileAccess,
  resolveRealPath,
  type FileAccessRequest,
} from "../src/agent/file-access.ts";
import type { RunContext } from "../src/agent/runner.ts";

const TOPIC: RunContext = { guildId: "guild-1", channelId: "topic-1", kind: "session" };
const INBOX: RunContext = { guildId: "guild-1", channelId: "inbox-1", kind: "inbox" };

const ALLOWED = { allowed: true };
const WRITE_DENIED = { allowed: false, reason: FILE_WRITE_DENIED_REASON };
const READ_DENIED = { allowed: false, reason: FILE_READ_DENIED_REASON };
const NO_CONTEXT = { allowed: false, reason: FILE_NO_CONTEXT_REASON };

/**
 * 一時ディレクトリに workDir を作る。projects/kakeibo（このチャンネルのプロジェクト）と projects/other（別のチャンネルのもの）、
 * projects の外の secret.txt を置く
 */
function setup(t: TestContext) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "self-agent-test-")));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const workDir = join(root, "work");
  const projectsDir = join(workDir, "projects");
  mkdirSync(join(projectsDir, "kakeibo", "site"), { recursive: true });
  mkdirSync(join(projectsDir, "other", "site"), { recursive: true });
  writeFileSync(join(projectsDir, "kakeibo", "site", "index.html"), "<p>kakeibo</p>");
  writeFileSync(join(projectsDir, "other", "site", "index.html"), "<p>other</p>");
  writeFileSync(join(root, "secret.txt"), "secret");
  const judge = (
    toolName: string,
    toolInput: unknown,
    overrides: Partial<Omit<FileAccessRequest, "toolName" | "toolInput">> = {},
  ) =>
    judgeFileAccess({
      toolName,
      toolInput,
      cwd: workDir,
      context: TOPIC,
      projectsDir,
      project: { slug: "kakeibo" },
      ...overrides,
    });
  return { root, workDir, projectsDir, judge };
}

test("Write・Edit: このチャンネルのプロジェクトの中なら許す（まだ無いファイル・ディレクトリへの Write も、相対パスも）", (t) => {
  const { projectsDir, judge } = setup(t);
  const project = join(projectsDir, "kakeibo");

  assert.deepEqual(judge("Write", { file_path: join(project, "site", "index.html"), content: "" }), ALLOWED);
  assert.deepEqual(judge("Write", { file_path: join(project, "site", "app.js"), content: "" }), ALLOWED);
  assert.deepEqual(judge("Write", { file_path: join(project, "src", "lib", "util.js"), content: "" }), ALLOWED);
  assert.deepEqual(judge("Edit", { file_path: join(project, "site", "index.html"), old_string: "a", new_string: "b" }), ALLOWED);
  // cwd（workDir）からの相対パス
  assert.deepEqual(judge("Write", { file_path: "projects/kakeibo/site/style.css", content: "" }), ALLOWED);
  // `..` を含む名前（要素が `..` ではない）は通す
  assert.deepEqual(judge("Write", { file_path: join(project, "site", "a..b.js"), content: "" }), ALLOWED);
});

test("Write・Edit: `..` で外に出る・別のチャンネルのプロジェクト・projects の外・プロジェクトのディレクトリそのものは拒否する", (t) => {
  const { root, workDir, projectsDir, judge } = setup(t);
  const project = join(projectsDir, "kakeibo");

  assert.deepEqual(judge("Write", { file_path: join(project, "..", "other", "site", "index.html"), content: "" }), WRITE_DENIED);
  assert.deepEqual(judge("Write", { file_path: join(project, "..", "..", "..", "secret.txt"), content: "" }), WRITE_DENIED);
  assert.deepEqual(judge("Write", { file_path: "projects/kakeibo/../../../secret.txt", content: "" }), WRITE_DENIED);
  assert.deepEqual(judge("Edit", { file_path: join(projectsDir, "other", "site", "index.html") }), WRITE_DENIED);
  assert.deepEqual(judge("Write", { file_path: join(projectsDir, "new.txt"), content: "" }), WRITE_DENIED);
  assert.deepEqual(judge("Write", { file_path: join(workDir, "notes.txt"), content: "" }), WRITE_DENIED);
  assert.deepEqual(judge("Write", { file_path: join(root, "secret.txt"), content: "" }), WRITE_DENIED);
  assert.deepEqual(judge("Write", { file_path: "/etc/passwd", content: "" }), WRITE_DENIED);
  assert.deepEqual(judge("Write", { file_path: project, content: "" }), WRITE_DENIED);
  // 名前の前半が同じ別のディレクトリ（kakeibo-2）は中ではない
  assert.deepEqual(judge("Write", { file_path: join(projectsDir, "kakeibo-2", "a.txt"), content: "" }), WRITE_DENIED);
});

test("Write・Edit: symlink で外に出るものは拒否する（ファイル・ディレクトリ・壊れた symlink）", (t) => {
  const { root, projectsDir, judge } = setup(t);
  const site = join(projectsDir, "kakeibo", "site");
  symlinkSync(join(root, "secret.txt"), join(site, "link.txt"));
  symlinkSync(root, join(site, "outside"));
  symlinkSync(join(projectsDir, "other"), join(site, "other"));
  symlinkSync(join(root, "not-yet.txt"), join(site, "dangling.txt"));

  assert.deepEqual(judge("Write", { file_path: join(site, "link.txt"), content: "" }), WRITE_DENIED);
  assert.deepEqual(judge("Edit", { file_path: join(site, "link.txt"), old_string: "a", new_string: "b" }), WRITE_DENIED);
  assert.deepEqual(judge("Write", { file_path: join(site, "outside", "new.txt"), content: "" }), WRITE_DENIED);
  assert.deepEqual(judge("Write", { file_path: join(site, "other", "site", "index.html"), content: "" }), WRITE_DENIED);
  assert.deepEqual(judge("Write", { file_path: join(site, "dangling.txt"), content: "" }), WRITE_DENIED);
});

test("パスの要素に `..` があれば、resolve・realpath の前に拒否する（中に戻るものも、symlink の後ろの `..` も）", (t) => {
  const { root, projectsDir, judge } = setup(t);
  const project = join(projectsDir, "kakeibo");
  // site/deep は projects の外の <root>/a/b を指す。site/deep/../../secret.txt の実際の場所は <root>/secret.txt だが、
  // 字面で畳むと projects/kakeibo/secret.txt（中）になる
  mkdirSync(join(root, "a", "b"), { recursive: true });
  symlinkSync(join(root, "a", "b"), join(project, "site", "deep"));
  const escaped = `${project}/site/deep/../../secret.txt`;

  assert.deepEqual(judge("Write", { file_path: escaped, content: "" }), WRITE_DENIED);
  assert.deepEqual(judge("Edit", { file_path: escaped, old_string: "a", new_string: "b" }), WRITE_DENIED);
  assert.deepEqual(judge("Read", { file_path: escaped }), READ_DENIED);
  assert.deepEqual(judge("Glob", { pattern: "*", path: `${project}/site/deep/../..` }), READ_DENIED);
  assert.deepEqual(judge("Grep", { pattern: "a", path: `${project}/site/deep/../..` }), READ_DENIED);
  // 中に戻るだけの `..` も拒否する（相対パス・末尾の `..` も）
  assert.deepEqual(judge("Write", { file_path: `${project}/src/../site/a.js`, content: "" }), WRITE_DENIED);
  assert.deepEqual(judge("Read", { file_path: "projects/kakeibo/src/../site/index.html" }), READ_DENIED);
  assert.deepEqual(judge("Glob", { pattern: "*", path: `${project}/site/..` }), READ_DENIED);
  assert.deepEqual(judge("Grep", { pattern: "a", path: "../work/projects/kakeibo" }), READ_DENIED);
  // `..` を含む名前は要素が `..` ではないので通す
  assert.deepEqual(judge("Read", { file_path: `${project}/site/a..b.js` }), ALLOWED);
  assert.deepEqual(judge("Grep", { pattern: "a", path: `${project}/site..old` }), ALLOWED);
});

test("Write・Edit: #inbox・プロジェクトの無いチャンネルでは、プロジェクトの中を指しても拒否する", (t) => {
  const { projectsDir, judge } = setup(t);
  const file = join(projectsDir, "kakeibo", "site", "index.html");

  assert.deepEqual(judge("Write", { file_path: file, content: "" }, { context: INBOX }), WRITE_DENIED);
  assert.deepEqual(judge("Edit", { file_path: file }, { context: INBOX, project: undefined }), WRITE_DENIED);
  assert.deepEqual(judge("Write", { file_path: file, content: "" }, { project: undefined }), WRITE_DENIED);
});

test("Read・Glob・Grep: projects の中なら許す（別のチャンネルのプロジェクト・#inbox でも）。外は拒否する", (t) => {
  const { root, workDir, projectsDir, judge } = setup(t);

  assert.deepEqual(judge("Read", { file_path: join(projectsDir, "kakeibo", "site", "index.html") }), ALLOWED);
  assert.deepEqual(judge("Read", { file_path: join(projectsDir, "other", "site", "index.html") }), ALLOWED);
  assert.deepEqual(judge("Read", { file_path: join(projectsDir, "other", "site", "index.html") }, { context: INBOX }), ALLOWED);
  assert.deepEqual(judge("Glob", { pattern: "**/*.html", path: join(projectsDir, "kakeibo") }), ALLOWED);
  assert.deepEqual(judge("Grep", { pattern: "kakeibo", path: "projects/kakeibo/site" }), ALLOWED);

  assert.deepEqual(judge("Read", { file_path: join(root, "secret.txt") }), READ_DENIED);
  assert.deepEqual(judge("Read", { file_path: join(projectsDir, "kakeibo", "..", "..", "..", "secret.txt") }), READ_DENIED);
  assert.deepEqual(judge("Read", { file_path: join(workDir, "notes.txt") }), READ_DENIED);
  assert.deepEqual(judge("Read", { file_path: "/etc/passwd" }), READ_DENIED);
  // path が無ければ cwd（workDir）が対象なので拒否する
  assert.deepEqual(judge("Glob", { pattern: "**/*" }), READ_DENIED);
  assert.deepEqual(judge("Grep", { pattern: "TOKEN" }), READ_DENIED);
  assert.deepEqual(judge("Grep", { pattern: "TOKEN", path: root }), READ_DENIED);
  // projects そのもの
  assert.deepEqual(judge("Glob", { pattern: "*", path: projectsDir }), READ_DENIED);
});

test("Read・Glob・Grep: symlink で外に出るものは拒否する", (t) => {
  const { root, projectsDir, judge } = setup(t);
  const site = join(projectsDir, "kakeibo", "site");
  symlinkSync(join(root, "secret.txt"), join(site, "link.txt"));
  symlinkSync(root, join(site, "outside"));

  assert.deepEqual(judge("Read", { file_path: join(site, "link.txt") }), READ_DENIED);
  assert.deepEqual(judge("Read", { file_path: join(site, "outside", "secret.txt") }), READ_DENIED);
  assert.deepEqual(judge("Grep", { pattern: "secret", path: join(site, "outside") }), READ_DENIED);
  assert.deepEqual(judge("Glob", { pattern: "*", path: join(site, "outside") }), READ_DENIED);
});

test("Glob の pattern・Grep の glob: 絶対パス（/ か ~ で始まる）か、部分文字列 .. を含めば、path が中でも拒否する", (t) => {
  const { projectsDir, judge } = setup(t);
  const path = join(projectsDir, "kakeibo");

  for (const pattern of [
    "/etc/*",
    "~/.ssh/*",
    "~",
    "../*",
    "../../**/*",
    "site/../../other/**",
    "**/..",
    "..",
    // 波括弧で `..` の要素を作る書き方
    "{..,x}/*",
    "{x,..}/secret.txt",
    // 要素ではない `..` も含めて拒否する
    "a..b.js",
    "...",
  ]) {
    assert.deepEqual(judge("Glob", { pattern, path }), READ_DENIED, pattern);
    assert.deepEqual(judge("Grep", { pattern: "a", path, glob: pattern }), READ_DENIED, pattern);
  }
  // 中だけを指すもの（ドットファイル・`./`）は通す
  for (const pattern of ["**/*.html", "site/*", "*.{js,css}", "**/.env", "./site/*"]) {
    assert.deepEqual(judge("Glob", { pattern, path }), ALLOWED, pattern);
    assert.deepEqual(judge("Grep", { pattern: "a", path, glob: pattern }), ALLOWED, pattern);
  }
  // Grep の pattern（正規表現）は対象のパスではないので見ない
  assert.deepEqual(judge("Grep", { pattern: "/etc/../passwd", path }), ALLOWED);
});

test("context が無いターンではファイル操作をすべて拒否する。パスが無い・形が違う入力も拒否する。ファイル操作以外は判定しない", (t) => {
  const { projectsDir, judge } = setup(t);
  const file = join(projectsDir, "kakeibo", "site", "index.html");

  for (const toolName of ["Read", "Write", "Edit", "Glob", "Grep"]) {
    assert.deepEqual(judge(toolName, { file_path: file, path: file }, { context: undefined, project: undefined }), NO_CONTEXT);
  }
  assert.deepEqual(judge("Read", {}), READ_DENIED);
  assert.deepEqual(judge("Read", { file_path: 42 }), READ_DENIED);
  assert.deepEqual(judge("Write", null), WRITE_DENIED);
  assert.deepEqual(judge("Grep", { pattern: "a", path: 42 }), READ_DENIED);
  assert.deepEqual(judge("WebSearch", { query: "a" }, { context: undefined }), ALLOWED);
});

test("resolveRealPath: 存在する一番深い親の realpath に残りを足す。壊れた symlink は解決しない", (t) => {
  const { root, projectsDir } = setup(t);
  const site = join(projectsDir, "kakeibo", "site");
  symlinkSync(root, join(site, "outside"));
  symlinkSync(join(root, "not-yet.txt"), join(site, "dangling.txt"));

  assert.equal(resolveRealPath(join(site, "index.html")), join(site, "index.html"));
  assert.equal(resolveRealPath(join(site, "a", "b.txt")), join(site, "a", "b.txt"));
  assert.equal(resolveRealPath(join(site, "outside", "new", "x.txt")), join(root, "new", "x.txt"));
  assert.equal(resolveRealPath(join(site, "dangling.txt")), undefined);
  assert.equal(resolveRealPath(join(site, "dangling.txt", "x")), undefined);
  // 途中がファイル
  assert.equal(resolveRealPath(join(site, "index.html", "x")), undefined);
});
