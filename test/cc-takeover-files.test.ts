import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { appendFileSync, mkdirSync, readdirSync, readFileSync, statSync, symlinkSync, truncateSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { copyTranscript, inspectSource, prepareTarget, readAppended, takeoverPaths } from "../src/cc/takeover-files.ts";
import { TAKEOVER_MAX_BYTES } from "../src/cc/takeover-rules.ts";
import { tempDir } from "./helpers/db.ts";

const S1 = "11111111-1111-4111-8111-111111111111";
const CWD = "/home/u/workspace/alpha";

function setup(t: TestContext) {
  const root = tempDir(t);
  const home = join(root, "home");
  const configDir = join(root, "config");
  const paths = takeoverPaths(home, configDir, CWD, S1)!;
  mkdirSync(join(home, ".claude", "projects", "-home-u-workspace-alpha"), { recursive: true });
  const projectsRoot = join(configDir, "projects");
  const srcDir = dirname(paths.src);
  const prepare = () => prepareTarget(paths.dstDir, projectsRoot, srcDir);
  return { root, home, configDir, paths, projectsRoot, srcDir, prepare };
}

test("takeoverPaths: ~/.claude と CLAUDE_CONFIG_DIR の projects/<cwd を - に>/<id>.jsonl。UUID でなければ undefined", () => {
  const paths = takeoverPaths("/h", "/c", CWD, S1);
  assert.deepEqual(paths, {
    src: `/h/.claude/projects/-home-u-workspace-alpha/${S1}.jsonl`,
    dstDir: "/c/projects/-home-u-workspace-alpha",
    dst: `/c/projects/-home-u-workspace-alpha/${S1}.jsonl`,
  });
  assert.equal(takeoverPaths("/h", "/c", CWD, "../../etc/passwd"), undefined);
});

test("inspectSource: 通常ファイルは大きさと mtime。無い・symlink・ディレクトリは no_transcript、上限超えは too_large", (t) => {
  const { root, paths } = setup(t);
  assert.deepEqual(inspectSource(paths.src), { ok: false, reason: "no_transcript" });
  writeFileSync(paths.src, '{"type":"user"}\n');
  const inspected = inspectSource(paths.src);
  assert.equal(inspected.ok, true);
  assert.equal(inspected.ok && inspected.size, 16);
  const real = join(root, "real.jsonl");
  writeFileSync(real, "x");
  const link = join(root, "link.jsonl");
  symlinkSync(real, link);
  assert.deepEqual(inspectSource(link), { ok: false, reason: "no_transcript" });
  assert.deepEqual(inspectSource(root), { ok: false, reason: "no_transcript" });
  const big = join(root, "big.jsonl");
  writeFileSync(big, "");
  truncateSync(big, TAKEOVER_MAX_BYTES + 1);
  assert.deepEqual(inspectSource(big), { ok: false, reason: "too_large" });
  truncateSync(big, TAKEOVER_MAX_BYTES);
  assert.equal(inspectSource(big).ok, true);
});

test("prepareTarget: mkdir -p で mode 700 の ready。あれば ready、作れなければ invalid", (t) => {
  const { root, paths, projectsRoot, srcDir, prepare } = setup(t);
  assert.equal(prepare(), "ready");
  assert.equal(statSync(paths.dstDir).mode & 0o777, 0o700);
  assert.equal(prepare(), "ready");
  const file = join(root, "file");
  writeFileSync(file, "");
  assert.equal(prepareTarget(join(file, "sub"), projectsRoot, srcDir), "invalid");
});

test("prepareTarget: projects の下の symlink が外を指せば invalid", (t) => {
  const { root, paths, projectsRoot } = setup(t);
  const outside = join(root, "outside");
  mkdirSync(outside);
  mkdirSync(projectsRoot, { recursive: true });
  symlinkSync(outside, paths.dstDir);
  assert.equal(prepareTarget(paths.dstDir, projectsRoot, join(root, "elsewhere")), "invalid");
});

test("prepareTarget: 元と同じ実体なら shared", (t) => {
  const { paths, projectsRoot, srcDir, prepare } = setup(t);
  mkdirSync(projectsRoot, { recursive: true });
  symlinkSync(srcDir, paths.dstDir);
  assert.equal(prepare(), "shared");
});

test("copyTranscript: 写した先は同じ中身で mode 600。一時ファイルは残らない", (t) => {
  const { paths, prepare } = setup(t);
  writeFileSync(paths.src, '{"type":"user"}\n{"type":"assistant"}\n', { mode: 0o644 });
  prepare();
  assert.equal(copyTranscript({ src: paths.src, dst: paths.dst, hasMapping: false }), "copied");
  assert.equal(readFileSync(paths.dst, "utf8"), readFileSync(paths.src, "utf8"));
  assert.equal(statSync(paths.dst).mode & 0o777, 0o600);
  assert.deepEqual(readdirSync(paths.dstDir), [`${S1}.jsonl`]);
});

test("copyTranscript: 元が symlink なら例外で写さない", (t) => {
  const { root, paths, prepare } = setup(t);
  prepare();
  const real = join(root, "real.jsonl");
  writeFileSync(real, "{}\n");
  symlinkSync(real, paths.src);
  assert.throws(() => copyTranscript({ src: paths.src, dst: paths.dst, hasMapping: false }));
  assert.deepEqual(readdirSync(paths.dstDir), []);
});

test("copyTranscript: 元が上限を超えれば例外で写さない", (t) => {
  const { paths, prepare } = setup(t);
  prepare();
  writeFileSync(paths.src, "");
  truncateSync(paths.src, TAKEOVER_MAX_BYTES + 1);
  assert.throws(() => copyTranscript({ src: paths.src, dst: paths.dst, hasMapping: false }));
  assert.deepEqual(readdirSync(paths.dstDir), []);
});

test("copyTranscript: 写し先に同じ名前があり channel_sessions に行があれば already_taken で触らない", (t) => {
  const { paths, prepare } = setup(t);
  writeFileSync(paths.src, "new\n");
  prepare();
  writeFileSync(paths.dst, "old\n");
  assert.equal(copyTranscript({ src: paths.src, dst: paths.dst, hasMapping: true }), "already_taken");
  assert.equal(readFileSync(paths.dst, "utf8"), "old\n");
  assert.deepEqual(readdirSync(paths.dstDir), [`${S1}.jsonl`]);
});

test("copyTranscript: 写し先に同じ名前があり行が無ければ、古い方を .old に退けてから写す。.old は 2 回目で増えない", (t) => {
  const { paths, prepare } = setup(t);
  writeFileSync(paths.src, "new\n");
  prepare();
  writeFileSync(paths.dst, "old\n");
  assert.equal(copyTranscript({ src: paths.src, dst: paths.dst, hasMapping: false }), "copied");
  assert.equal(readFileSync(paths.dst, "utf8"), "new\n");
  assert.equal(readFileSync(`${paths.dst}.old`, "utf8"), "old\n");
  writeFileSync(paths.src, "newer\n");
  assert.equal(copyTranscript({ src: paths.src, dst: paths.dst, hasMapping: false }), "copied");
  assert.equal(readFileSync(paths.dst, "utf8"), "newer\n");
  assert.equal(readFileSync(`${paths.dst}.old`, "utf8"), "new\n");
  assert.deepEqual(readdirSync(paths.dstDir).sort(), [`${S1}.jsonl`, `${S1}.jsonl.old`]);
});

test("copyTranscript: 元と写し先のディレクトリの実体が同じなら shared で写さない", (t) => {
  const { home, configDir, paths } = setup(t);
  writeFileSync(paths.src, "same\n");
  mkdirSync(join(configDir, "projects"), { recursive: true });
  symlinkSync(join(home, ".claude", "projects", "-home-u-workspace-alpha"), paths.dstDir);
  assert.equal(copyTranscript({ src: paths.src, dst: paths.dst, hasMapping: true }), "shared");
  assert.equal(readFileSync(paths.src, "utf8"), "same\n");
});

test("readAppended: fromSize から後ろの空でない行。小さくなった・無い・symlink は undefined", (t) => {
  const { root, paths } = setup(t);
  writeFileSync(paths.src, '{"type":"summary"}\n');
  const size = statSync(paths.src).size;
  assert.deepEqual(readAppended(paths.src, size), []);
  appendFileSync(paths.src, '{"type":"user"}\n\n{"type":"assistant"}\n');
  assert.deepEqual(readAppended(paths.src, size), ['{"type":"user"}', '{"type":"assistant"}']);
  assert.equal(readAppended(paths.src, size + 1000), undefined);
  assert.equal(readAppended(paths.src, -1), undefined);
  assert.equal(readAppended(join(root, "missing"), 0), undefined);
  const link = join(root, "link.jsonl");
  symlinkSync(paths.src, link);
  assert.equal(readAppended(link, 0), undefined);
});
