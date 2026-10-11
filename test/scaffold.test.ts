import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { copyWebScaffold, hasWebScaffold, WEB_TEMPLATE_DIR } from "../src/agent/scaffold.ts";

const CREATED = ["DESIGN.md", "site/base.css", "site/app.css", "site/icons.svg", "site/index.html"];
const EXISTING = ["DESIGN.md", "site/base.css", "site/icons.svg"];

/** 一時ディレクトリ（root）と、その中のプロジェクトのディレクトリ（dir。まだ作らない） */
function setup(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), "self-agent-test-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return { root, dir: join(root, "projects", "kakeibo") };
}

test("copyWebScaffold: 宛先のファイルが symlink（有効・dangling）なら上書きせず、リンク先も変えない", async (t) => {
  const { root, dir } = setup(t);
  mkdirSync(join(dir, "site"), { recursive: true });
  const target = join(root, "outside.html");
  writeFileSync(target, "外のファイル");
  symlinkSync(target, join(dir, "site", "index.html"));
  const dangling = join(root, "nowhere.md");
  symlinkSync(dangling, join(dir, "DESIGN.md"));

  const result = await copyWebScaffold(dir, "created");

  assert.deepEqual(result, { copied: ["site/base.css", "site/app.css", "site/icons.svg"], failed: false });
  assert.ok(lstatSync(join(dir, "site", "index.html")).isSymbolicLink());
  assert.equal(readFileSync(target, "utf8"), "外のファイル");
  assert.ok(lstatSync(join(dir, "DESIGN.md")).isSymbolicLink());
  assert.equal(existsSync(dangling), false);
});

test("copyWebScaffold: site が dir の外への symlink なら何も書かず failed（created でも existing でも）", async (t) => {
  for (const mode of ["created", "existing"] as const) {
    const { root, dir } = setup(t);
    mkdirSync(dir, { recursive: true });
    const outside = join(root, "outside-site");
    mkdirSync(outside);
    symlinkSync(outside, join(dir, "site"));

    assert.deepEqual(await copyWebScaffold(dir, mode), { copied: [], failed: true }, mode);
    assert.deepEqual(readdirSync(outside), [], mode);
    assert.deepEqual(readdirSync(dir), ["site"], mode);
  }
});

test("copyWebScaffold: 一部のファイルの複製に失敗しても残りを複製し、複製できた分と failed を返す", async (t) => {
  const { root, dir } = setup(t);
  // site/base.css と site/index.html だけが無い複製の元
  const templateDir = join(root, "template");
  mkdirSync(join(templateDir, "site"), { recursive: true });
  for (const file of ["DESIGN.md", "site/app.css", "site/icons.svg"]) writeFileSync(join(templateDir, file), file);

  const result = await copyWebScaffold(dir, "created", templateDir);

  assert.deepEqual(result, { copied: ["DESIGN.md", "site/app.css", "site/icons.svg"], failed: true });
  for (const file of result.copied) assert.equal(readFileSync(join(dir, file), "utf8"), file);
  assert.equal(existsSync(join(dir, "site", "base.css")), false);
  assert.equal(await hasWebScaffold(dir), false);
});

test("copyWebScaffold: existing で dir ごと無ければ作り直して 3 つ置く", async (t) => {
  const { dir } = setup(t);

  const result = await copyWebScaffold(dir, "existing");

  assert.deepEqual(result, { copied: EXISTING, failed: false });
  for (const file of EXISTING) {
    assert.equal(readFileSync(join(dir, file), "utf8"), readFileSync(join(WEB_TEMPLATE_DIR, file), "utf8"), file);
  }
  assert.equal(existsSync(join(dir, "site", "index.html")), false);
  assert.equal(await hasWebScaffold(dir), true);
});

test("copyWebScaffold: existing の判定に失敗したら（site がファイル）何もせず failed", async (t) => {
  const { dir } = setup(t);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "site"), "ファイル");

  assert.deepEqual(await copyWebScaffold(dir, "existing"), { copied: [], failed: true });
  assert.deepEqual(await copyWebScaffold(dir, "created"), { copied: [], failed: true });
  assert.deepEqual(readdirSync(dir), ["site"]);
});

test("copyWebScaffold: created は 5 つを順に複製し、2 回目は何も複製しない", async (t) => {
  const { dir } = setup(t);

  assert.deepEqual(await copyWebScaffold(dir, "created"), { copied: CREATED, failed: false });
  assert.deepEqual(await copyWebScaffold(dir, "created"), { copied: [], failed: false });
  assert.equal(await hasWebScaffold(dir), true);
});
