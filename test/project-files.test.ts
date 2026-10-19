import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as z from "zod";
import { FILE_WRITE_DENIED_REASON } from "../src/agent/file-access.ts";
import { removeTree } from "../src/agent/remove-tree.ts";
import {
  formatTrashId,
  PROJECT_DIR_MISSING_MESSAGE,
  PROJECT_FILES_MAX_PATHS,
  pruneProjectTrash,
  runProjectFiles,
  TRASH_DIR_NAME,
  TRASH_ID_PATTERN,
  TRASH_RETENTION_DAYS,
  TRASH_UNAVAILABLE_MESSAGE,
  type ProjectFilesArgs,
} from "../src/agent/project-files.ts";
import type { RunContext } from "../src/agent/runner.ts";
import {
  createProjectToolHandlers,
  createTaskTools,
  PROJECT_DIR_UNVERIFIED_MESSAGE,
  type ProjectToolDeps,
  type TextToolResult,
} from "../src/agent/tools.ts";
import { createStores, tempDb } from "./helpers/db.ts";

const NOW = new Date("2026-10-11T01:36:00.123Z");
/** NOW の trash_id */
const ID = "20261011T013600Z";
const DAY_MS = 24 * 60 * 60 * 1000;
/** clear で置き直す UI の土台（created の 5 つ） */
const CREATED_SCAFFOLD = ["DESIGN.md", "site/base.css", "site/app.css", "site/icons.svg", "site/index.html"];
const TOPIC: RunContext = { guildId: "guild-1", channelId: "topic-1", kind: "session" };

/** dir の中身。ファイルは中身、symlink は `-> 先`、空のディレクトリは `<名前>/` のキーで表す。symlink はたどらない */
function tree(dir: string, prefix = ""): Record<string, string> {
  const out: Record<string, string> = {};
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const rel = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
    const path = join(dir, entry.name);
    if (entry.isSymbolicLink()) {
      out[rel] = `-> ${readlinkSync(path)}`;
    } else if (entry.isDirectory()) {
      const sub = tree(path, rel);
      if (Object.keys(sub).length === 0) out[`${rel}/`] = "";
      else Object.assign(out, sub);
    } else {
      out[rel] = readFileSync(path, "utf8");
    }
  }
  return out;
}

/** tree から .trash の分を除いたもの */
function outsideTrash(dir: string): Record<string, string> {
  return Object.fromEntries(Object.entries(tree(dir)).filter(([rel]) => !rel.startsWith(`${TRASH_DIR_NAME}/`)));
}

/**
 * 一時ディレクトリに `<root>/work/projects/kakeibo`（プロジェクトの dir）を作り、ファイルを置く。
 * プロジェクトの外に `<root>/outside/secret.txt` を置く
 */
function setup(t: TestContext) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "self-agent-test-")));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const projectsDir = join(root, "work", "projects");
  const dir = join(projectsDir, "kakeibo");
  const files: Record<string, string> = {
    "SPEC.md": "仕様",
    "site/index.html": "<p>前の</p>",
    "site/app.js": "console.log(1);",
    "notes/a.md": "a",
    "notes/b.md": "b",
  };
  for (const [file, content] of Object.entries(files)) {
    mkdirSync(join(dir, file, ".."), { recursive: true });
    writeFileSync(join(dir, file), content);
  }
  mkdirSync(join(root, "outside"));
  writeFileSync(join(root, "outside", "secret.txt"), "secret");
  const logs: string[] = [];
  const run = (args: ProjectFilesArgs, now: Date = NOW) => runProjectFiles(dir, args, { now, log: (line) => logs.push(line) });
  return { root, projectsDir, dir, files, logs, run };
}

test("trash → restore: paths を .trash/<trash_id>/ の同じ相対パスに移し、restore で元どおりに戻して .trash/<trash_id> を消す", async (t) => {
  const { dir, files, run } = setup(t);

  assert.deepEqual(await run({ action: "trash", paths: ["site/index.html", "notes"] }), {
    result: "trashed",
    trash_id: ID,
    moved: ["site/index.html", "notes"],
    missing: [],
  });
  assert.equal(existsSync(join(dir, "site", "index.html")), false);
  assert.equal(existsSync(join(dir, "notes")), false);
  assert.deepEqual(tree(join(dir, TRASH_DIR_NAME, ID)), {
    "notes/a.md": "a",
    "notes/b.md": "b",
    "site/index.html": "<p>前の</p>",
  });

  assert.deepEqual(await run({ action: "restore" }), { result: "list", trashes: [{ trash_id: ID, files: 3 }] });
  assert.deepEqual(await run({ action: "restore", trash_id: ID }), {
    result: "restored",
    trash_id: ID,
    restored: ["notes/a.md", "notes/b.md", "site/index.html"],
  });
  assert.deepEqual(outsideTrash(dir), files);
  assert.equal(existsSync(join(dir, TRASH_DIR_NAME, ID)), false);
  assert.deepEqual(await run({ action: "restore" }), { result: "list", trashes: [] });
});

test("restore: 戻した後に .trash/<trash_id> の空のディレクトリを消せなくても（rmdir の失敗）restored を返し、残して log だけ（パスは出さない）", async (t) => {
  const { root, dir, files, logs, run } = setup(t);
  await run({ action: "trash", paths: ["site/index.html"] });
  const trashDir = join(dir, TRASH_DIR_NAME, ID);
  // site/ は消せるが、trashDir の中の site/ を rmdir できない（trashDir に書けない）
  chmodSync(trashDir, 0o500);
  try {
    assert.deepEqual(await run({ action: "restore", trash_id: ID }), {
      result: "restored",
      trash_id: ID,
      restored: ["site/index.html"],
    });
  } finally {
    chmodSync(trashDir, 0o700);
  }
  assert.deepEqual(outsideTrash(dir), files);
  assert.deepEqual(tree(trashDir), { "site/": "" });
  const failed = logs.filter((line) => line.includes(".trash を消せませんでした"));
  assert.equal(failed.length, 1);
  assert.ok(!failed[0]!.includes(root) && !failed[0]!.includes(ID));
});

test("trash: 無いものは missing に入れて続ける。同じパスの重複（書き方が違っても同じ相対パス）は最初の 1 つにまとめる", async (t) => {
  const { dir, run } = setup(t);

  assert.deepEqual(await run({ action: "trash", paths: ["nope.txt", "SPEC.md", "./SPEC.md", "nope.txt", "SPEC.md"] }), {
    result: "trashed",
    trash_id: ID,
    moved: ["SPEC.md"],
    missing: ["nope.txt"],
  });
  assert.deepEqual(tree(join(dir, TRASH_DIR_NAME, ID)), { "SPEC.md": "仕様" });
});

test("trash: 親子が重なる paths は順によらず親ごと移し（子 → 親でも ENOTEMPTY にならない）、子も moved（親の中に無かったものは missing）。並びは入力の順。restore で元どおり", async (t) => {
  const cases: Array<{ label: string; paths: string[]; moved: string[]; missing: string[]; trashed: string[] }> = [
    {
      label: "親 → 子",
      paths: ["site", "notes/a.md", "site/index.html", "site/nope.html", "notes"],
      moved: ["site", "notes/a.md", "site/index.html", "notes"],
      missing: ["site/nope.html"],
      trashed: ["notes/a.md", "notes/b.md", "site/app.js", "site/index.html"],
    },
    {
      label: "子 → 親",
      paths: ["site/index.html", "site/app.js", "site", "SPEC.md"],
      moved: ["site/index.html", "site/app.js", "site", "SPEC.md"],
      missing: [],
      trashed: ["SPEC.md", "site/app.js", "site/index.html"],
    },
    // 間の親は paths に無い
    { label: "孫 → 祖父", paths: ["notes/a.md", "notes"], moved: ["notes/a.md", "notes"], missing: [], trashed: ["notes/a.md", "notes/b.md"] },
  ];
  for (const { label, paths, moved, missing, trashed } of cases) {
    const { dir, files, run } = setup(t);

    assert.deepEqual(await run({ action: "trash", paths }), { result: "trashed", trash_id: ID, moved, missing }, label);
    assert.deepEqual(Object.keys(tree(join(dir, TRASH_DIR_NAME, ID))).sort(), trashed, label);
    await run({ action: "restore", trash_id: ID });
    assert.deepEqual(outsideTrash(dir), files, label);
  }
});

test("trash: 1 つも移さなければ（無い・祖先が無い）trash_id は null で、.trash も作らない", async (t) => {
  const { dir, files, run } = setup(t);

  for (const paths of [
    ["nope.txt", "site/nope/a.js"],
    ["gone/a.txt", "gone", "gone/b/c.txt"],
  ]) {
    assert.deepEqual(await run({ action: "trash", paths }), { result: "trashed", trash_id: null, moved: [], missing: paths });
  }
  assert.equal(existsSync(join(dir, TRASH_DIR_NAME)), false);
  assert.deepEqual(tree(dir), files);
});

test("trash_id: UTC の YYYYMMDDTHHmmssZ（ミリ秒は落とす）。同じ秒の trash_id が既にあれば -2、-3 を付ける。形は TRASH_ID_PATTERN に合う", async (t) => {
  const { dir, run } = setup(t);
  assert.equal(formatTrashId(new Date("2026-01-02T03:04:05.999Z")), "20260102T030405Z");
  for (const id of ["", "20261011T013600", "20261011-013600Z", `${ID}-`, `${ID}-x`, `../${ID}`, `${ID}/x`]) {
    assert.equal(TRASH_ID_PATTERN.test(id), false, id);
  }

  const ids = [];
  for (const path of ["SPEC.md", "notes/a.md", "notes/b.md"]) {
    ids.push(((await run({ action: "trash", paths: [path] })) as { trash_id: string }).trash_id);
  }
  assert.deepEqual(ids, [ID, `${ID}-2`, `${ID}-3`]);
  for (const id of ids) assert.ok(TRASH_ID_PATTERN.test(id), id);
  assert.equal(readFileSync(join(dir, TRASH_DIR_NAME, `${ID}-3`, "notes", "b.md"), "utf8"), "b");
  // 次の秒は付けない
  const next = await run({ action: "trash", paths: ["site/app.js"] }, new Date(NOW.getTime() + 1000));
  assert.equal((next as { trash_id: string }).trash_id, "20261011T013601Z");
});

test("trash: symlink はたどらず、symlink そのものを移す", async (t) => {
  const { dir, run } = setup(t);
  symlinkSync("index.html", join(dir, "site", "link.html"));

  assert.deepEqual(await run({ action: "trash", paths: ["site/link.html"] }), {
    result: "trashed",
    trash_id: ID,
    moved: ["site/link.html"],
    missing: [],
  });
  assert.equal(readFileSync(join(dir, "site", "index.html"), "utf8"), "<p>前の</p>");
  assert.ok(lstatSync(join(dir, TRASH_DIR_NAME, ID, "site", "link.html")).isSymbolicLink());

  await run({ action: "restore", trash_id: ID });
  assert.equal(readlinkSync(join(dir, "site", "link.html")), "index.html");
});

test("move: paths の 1 つを to に移す（改名を含む。to の親は作る）", async (t) => {
  const { dir, run } = setup(t);

  assert.deepEqual(await run({ action: "move", paths: ["site/app.js"], to: "site/js/main.js" }), {
    result: "moved",
    from: "site/app.js",
    to: "site/js/main.js",
  });
  assert.equal(existsSync(join(dir, "site", "app.js")), false);
  assert.equal(readFileSync(join(dir, "site", "js", "main.js"), "utf8"), "console.log(1);");
  // ディレクトリごと
  assert.deepEqual(await run({ action: "move", paths: ["notes"], to: "docs" }), { result: "moved", from: "notes", to: "docs" });
  assert.deepEqual(tree(join(dir, "docs")), { "a.md": "a", "b.md": "b" });
  assert.equal(existsSync(join(dir, TRASH_DIR_NAME)), false);
});

test("move: to が既にあれば上書きせず exists、paths[0] が無ければ missing、to が paths[0] の中・末尾が /（名前が無い）なら invalid_path。どれも何も変えない", async (t) => {
  const { dir, files, run } = setup(t);
  const cases: Array<[from: string, to: string, expected: object]> = [
    ["SPEC.md", "site/index.html", { result: "exists", path: "site/index.html" }],
    ["notes", "site", { result: "exists", path: "site" }],
    ["nope.txt", "new.txt", { result: "missing", path: "nope.txt" }],
    ["site", "site/old", { result: "invalid_path", path: "site/old" }],
    ["site/", "./site/old/x", { result: "invalid_path", path: "./site/old/x" }],
    ...["docs/", "site/", "site/js/", "docs//"].map((to): [string, string, object] => ["SPEC.md", to, { result: "invalid_path", path: to }]),
  ];

  for (const [from, to, expected] of cases) {
    assert.deepEqual(await run({ action: "move", paths: [from], to }), expected, `${from} → ${to}`);
  }
  assert.deepEqual(tree(dir), files);
  // paths の末尾の / はよい（移すものは名前で決まる）
  assert.deepEqual(await run({ action: "move", paths: ["notes/"], to: "docs" }), { result: "moved", from: "notes/", to: "docs" });
});

test(".trash が実際のディレクトリでない（中・外への symlink、ファイル）なら、trash・clear・restore（一覧も）は何もせず trash_unavailable。move は使える", async (t) => {
  const unavailable = { result: "trash_unavailable", message: TRASH_UNAVAILABLE_MESSAGE };
  for (const kind of ["site", "outside", "file"] as const) {
    const { root, dir, run } = setup(t);
    mkdirSync(join(root, "outside", ID), { recursive: true });
    writeFileSync(join(root, "outside", ID, "keep.txt"), "keep");
    const trash = join(dir, TRASH_DIR_NAME);
    if (kind === "site") symlinkSync(join(dir, "site"), trash);
    else if (kind === "outside") symlinkSync(join(root, "outside"), trash);
    else writeFileSync(trash, "ファイル");
    const before = tree(dir);
    const outside = tree(join(root, "outside"));

    for (const args of [
      { action: "trash", paths: ["SPEC.md"] },
      { action: "clear" },
      { action: "restore" },
      { action: "restore", trash_id: ID },
    ] satisfies ProjectFilesArgs[]) {
      assert.deepEqual(await run(args), unavailable, `${kind} ${JSON.stringify(args)}`);
    }
    assert.deepEqual(tree(dir), before, kind);
    assert.deepEqual(tree(join(root, "outside")), outside, kind);

    assert.deepEqual(await run({ action: "move", paths: ["SPEC.md"], to: "docs/SPEC.md" }), {
      result: "moved",
      from: "SPEC.md",
      to: "docs/SPEC.md",
    });
  }
});

test("trash・move: プロジェクトの dir が無い・ファイル・解決できないなら not_available で、何も作らない。clear・restore は今どおり", async (t) => {
  const { root, projectsDir } = setup(t);
  const notAvailable = { result: "not_available", message: PROJECT_DIR_MISSING_MESSAGE };
  writeFileSync(join(projectsDir, "file"), "ファイル");
  symlinkSync(join(root, "no-such"), join(projectsDir, "broken"));
  const runIn = (name: string, args: ProjectFilesArgs) =>
    runProjectFiles(join(projectsDir, name), args, { now: NOW, log: () => assert.fail("想定外の log") });

  for (const name of ["missing", "file", "broken"]) {
    assert.deepEqual(await runIn(name, { action: "trash", paths: ["SPEC.md"] }), notAvailable, name);
    assert.deepEqual(await runIn(name, { action: "move", paths: ["SPEC.md"], to: "x.md" }), notAvailable, name);
  }
  assert.equal(existsSync(join(projectsDir, "missing")), false);
  assert.equal(existsSync(join(root, "no-such")), false);
  // 引数の検証が先
  assert.equal(((await runIn("missing", { action: "trash" })) as { result: string }).result, "invalid_args");

  assert.deepEqual(await runIn("missing", { action: "restore" }), { result: "list", trashes: [] });
  assert.deepEqual(await runIn("missing", { action: "restore", trash_id: ID }), { result: "not_found", trash_id: ID });
  assert.deepEqual(await runIn("missing", { action: "clear" }), { result: "cleared", trash_id: null, scaffold: CREATED_SCAFFOLD });
});

test("clear: .trash 以外をすべて .trash/<trash_id>/ に移し、UI の土台を置き直す。中身が無ければ trash_id は null", async (t) => {
  const { dir, files, run } = setup(t);

  assert.deepEqual(await run({ action: "clear" }), { result: "cleared", trash_id: ID, scaffold: CREATED_SCAFFOLD });

  assert.deepEqual(readdirSync(dir).sort(), [TRASH_DIR_NAME, "DESIGN.md", "site"]);
  assert.deepEqual(Object.keys(outsideTrash(dir)).sort(), [...CREATED_SCAFFOLD].sort());
  assert.deepEqual(tree(join(dir, TRASH_DIR_NAME, ID)), files);

  // 土台だけになった後でもう一度: 土台を .trash に移して置き直す
  const again = await run({ action: "clear" }, new Date(NOW.getTime() + 1000));
  assert.deepEqual(again, { result: "cleared", trash_id: "20261011T013601Z", scaffold: CREATED_SCAFFOLD });
  // 前の .trash はそのまま
  assert.deepEqual(tree(join(dir, TRASH_DIR_NAME, ID)), files);

  // 中身が無い（dir も無い）
  const empty = join(dir, "..", "empty");
  assert.deepEqual(await runProjectFiles(empty, { action: "clear" }, { now: NOW, log: () => assert.fail("想定外の log") }), {
    result: "cleared",
    trash_id: null,
    scaffold: CREATED_SCAFFOLD,
  });
  assert.equal(existsSync(join(empty, TRASH_DIR_NAME)), false);
});

test("restore の conflict: 途中の要素がファイル・clear の後の土台と重なる、なら何も戻さない。conflict のパスを trash してから restore すると戻る", async (t) => {
  // 途中の要素がファイル
  {
    const { dir, run } = setup(t);
    await run({ action: "trash", paths: ["notes"] });
    writeFileSync(join(dir, "notes"), "ファイル");

    assert.deepEqual(await run({ action: "restore", trash_id: ID }), { result: "conflict", paths: ["notes"] });
  }

  const { dir, files, run } = setup(t);
  await run({ action: "clear" });
  const scaffolded = outsideTrash(dir);

  assert.deepEqual(await run({ action: "restore", trash_id: ID }), { result: "conflict", paths: ["site/index.html"] });
  assert.deepEqual(outsideTrash(dir), scaffolded);
  assert.deepEqual(tree(join(dir, TRASH_DIR_NAME, ID)), files);

  assert.deepEqual(await run({ action: "trash", paths: ["site/index.html"] }), {
    result: "trashed",
    trash_id: `${ID}-2`,
    moved: ["site/index.html"],
    missing: [],
  });
  assert.deepEqual(await run({ action: "restore", trash_id: ID }), {
    result: "restored",
    trash_id: ID,
    restored: ["SPEC.md", "notes/a.md", "notes/b.md", "site/app.js", "site/index.html"],
  });
  const { "site/index.html": _replaced, ...scaffoldKept } = scaffolded;
  assert.deepEqual(outsideTrash(dir), { ...scaffoldKept, ...files });
  assert.equal(existsSync(join(dir, TRASH_DIR_NAME, ID)), false);
});

test("restore: 一覧は新しい順（同じ秒は番号の大きい順）でファイルの数（再帰）を返し、形に合わない名前・ディレクトリでないものは出さない", async (t) => {
  const { root, dir, run } = setup(t);
  const trash = join(dir, TRASH_DIR_NAME);
  await run({ action: "trash", paths: ["SPEC.md"] }, new Date("2026-10-10T00:00:00Z"));
  await run({ action: "trash", paths: ["notes"] });
  await run({ action: "trash", paths: ["site/app.js"] });
  mkdirSync(join(trash, `${ID}-10`, "x", "y"), { recursive: true });
  writeFileSync(join(trash, `${ID}-10`, "x", "y", "z.txt"), "z");
  mkdirSync(join(trash, "junk"));
  writeFileSync(join(trash, "20200101T000000Z"), "ファイル");
  symlinkSync(join(root, "outside"), join(trash, "20200102T000000Z"));

  assert.deepEqual(await run({ action: "restore" }), {
    result: "list",
    trashes: [
      { trash_id: `${ID}-10`, files: 1 },
      { trash_id: `${ID}-2`, files: 1 },
      { trash_id: ID, files: 2 },
      { trash_id: "20261010T000000Z", files: 1 },
    ],
  });
});

test("restore: 無い trash_id・形に合わない trash_id は not_found で、何も変えない", async (t) => {
  const { root, dir, run } = setup(t);
  await run({ action: "trash", paths: ["SPEC.md"] });
  mkdirSync(join(dir, TRASH_DIR_NAME, "junk"));
  writeFileSync(join(dir, TRASH_DIR_NAME, "junk", "a.txt"), "a");
  symlinkSync(join(root, "outside"), join(dir, TRASH_DIR_NAME, "20200102T000000Z"));
  const before = tree(dir);

  for (const id of ["20991231T000000Z", "junk", "", "../outside", `${ID}/..`, "20200102T000000Z"]) {
    assert.deepEqual(await run({ action: "restore", trash_id: id }), { result: "not_found", trash_id: id }, id);
  }
  assert.deepEqual(tree(dir), before);
  assert.equal(readFileSync(join(root, "outside", "secret.txt"), "utf8"), "secret");
});

test("invalid_path: 空・絶対・`..`・`.`・.trash・dir の外への symlink を通るものは、何もせずにそのパスを返す", async (t) => {
  const { root, dir, files, run } = setup(t);
  symlinkSync(join(root, "outside"), join(dir, "out"));
  mkdirSync(join(dir, TRASH_DIR_NAME));
  symlinkSync(join(dir, TRASH_DIR_NAME), join(dir, "site", "t"));
  const before = tree(dir);

  for (const path of [
    "",
    "/etc/passwd",
    join(dir, "SPEC.md"),
    "..",
    "../kakeibo/SPEC.md",
    "site/../SPEC.md",
    ".",
    "./",
    "./.",
    TRASH_DIR_NAME,
    `${TRASH_DIR_NAME}/x`,
    `./${TRASH_DIR_NAME}/x`,
    "out",
    "out/secret.txt",
    "site/t",
    "site/t/x",
    "SPEC.md/x",
  ]) {
    assert.deepEqual(await run({ action: "trash", paths: [path] }), { result: "invalid_path", path }, `trash ${path}`);
    assert.deepEqual(await run({ action: "move", paths: [path], to: "new.txt" }), { result: "invalid_path", path }, `move ${path}`);
    assert.deepEqual(await run({ action: "move", paths: ["SPEC.md"], to: path }), { result: "invalid_path", path }, `to ${path}`);
  }
  // 1 つでもだめなら、前の正しいパスも移さない
  assert.deepEqual(await run({ action: "trash", paths: ["SPEC.md", "site/index.html", "../x"] }), {
    result: "invalid_path",
    path: "../x",
  });
  assert.deepEqual(tree(dir), before);
  assert.deepEqual(outsideTrash(dir), { ...files, out: `-> ${join(root, "outside")}`, "site/t": `-> ${join(dir, TRASH_DIR_NAME)}` });
  assert.equal(readFileSync(join(root, "outside", "secret.txt"), "utf8"), "secret");
});

test("invalid_args: 引数が足りない・余計・action が無いものなら、何もせずに invalid_args を返す", async (t) => {
  const { dir, files, run } = setup(t);
  const tooMany = Array.from({ length: PROJECT_FILES_MAX_PATHS + 1 }, (_, i) => `f${i}.txt`);

  const cases: Array<[label: string, ProjectFilesArgs]> = [
    ["trash に paths が無い", { action: "trash" }],
    ["trash の paths が空", { action: "trash", paths: [] }],
    ["trash の paths が多すぎる", { action: "trash", paths: tooMany }],
    ["trash に to", { action: "trash", paths: ["SPEC.md"], to: "x" }],
    ["trash に trash_id", { action: "trash", paths: ["SPEC.md"], trash_id: ID }],
    ["move に paths が無い", { action: "move", to: "x" }],
    ["move の paths が 2 件", { action: "move", paths: ["SPEC.md", "notes"], to: "x" }],
    ["move に to が無い", { action: "move", paths: ["SPEC.md"] }],
    ["move に trash_id", { action: "move", paths: ["SPEC.md"], to: "x", trash_id: ID }],
    ["clear に paths", { action: "clear", paths: ["SPEC.md"] }],
    ["clear に to・trash_id", { action: "clear", to: "x", trash_id: ID }],
    ["restore に paths", { action: "restore", paths: ["SPEC.md"] }],
    ["restore に to", { action: "restore", to: "x", trash_id: ID }],
    ["action が無い", { action: "delete" } as unknown as ProjectFilesArgs],
  ];
  for (const [label, args] of cases) {
    assert.equal(((await run(args)) as { result: string }).result, "invalid_args", label);
  }
  assert.deepEqual(tree(dir), files);
});

test("clear: UI の土台の複製に失敗しても cleared を返し、scaffold は空。log は決めた文言だけ（パス・例外の中身は出さない）", async (t) => {
  const { dir, files } = setup(t);
  const logs: string[] = [];

  const result = await runProjectFiles(
    dir,
    { action: "clear" },
    { now: NOW, templateDir: join(tmpdir(), "self-agent-test-no-such-template"), log: (line) => logs.push(line) },
  );

  assert.deepEqual(result, { result: "cleared", trash_id: ID, scaffold: [] });
  assert.deepEqual(tree(join(dir, TRASH_DIR_NAME, ID)), files);
  assert.equal(logs.length, 1);
  for (const secret of [dir, "self-agent-test-no-such-template", "ENOENT"]) assert.ok(!logs[0]!.includes(secret), secret);
});

test("pruneProjectTrash: 消す前に同期で .purging-<trash_id> に名前を変える（その間 restore・一覧には出ない）。前に残った .purging-* も消す", async (t) => {
  const { dir, projectsDir, run } = setup(t);
  const now = new Date("2026-10-11T00:00:00Z");
  const old = formatTrashId(new Date(now.getTime() - (TRASH_RETENTION_DAYS + 1) * DAY_MS));
  const recent = formatTrashId(new Date(now.getTime() - DAY_MS));
  const trash = join(dir, TRASH_DIR_NAME);
  for (const name of [old, recent, ".purging-20200101T000000Z"]) {
    mkdirSync(join(trash, name, "site"), { recursive: true });
    writeFileSync(join(trash, name, "site", "index.html"), "x");
  }

  // 消す処理を止めておき、その間の様子を見る
  let release = (): void => {};
  const blocked = new Promise<void>((resolve) => (release = resolve));
  const removing: string[] = [];
  const pruning = pruneProjectTrash(projectsDir, now, TRASH_RETENTION_DAYS, async (path) => {
    removing.push(path);
    await blocked;
    await removeTree(path);
  });
  await new Promise((resolve) => setImmediate(resolve));

  // 消す前に名前を変えてある。.purging-* は一覧に出ず、restore でも not_found
  assert.deepEqual(readdirSync(trash).sort(), [`.purging-${old}`, ".purging-20200101T000000Z", recent].sort());
  assert.deepEqual(removing, [join(trash, ".purging-20200101T000000Z")]);
  assert.deepEqual(await run({ action: "restore" }, now), { result: "list", trashes: [{ trash_id: recent, files: 1 }] });
  assert.deepEqual(await run({ action: "restore", trash_id: old }, now), { result: "not_found", trash_id: old });
  release();
  await pruning;

  assert.deepEqual(removing, [join(trash, ".purging-20200101T000000Z"), join(trash, `.purging-${old}`)]);
  assert.deepEqual(readdirSync(trash), [recent]);
});

test("restore: .purging-* は一覧に出さず、trash_id に渡しても not_found", async (t) => {
  const { dir, run } = setup(t);
  const purging = `.purging-${ID}`;
  mkdirSync(join(dir, TRASH_DIR_NAME, purging, "site"), { recursive: true });
  writeFileSync(join(dir, TRASH_DIR_NAME, purging, "site", "index.html"), "x");

  assert.equal(TRASH_ID_PATTERN.test(purging), false);
  assert.deepEqual(await run({ action: "restore" }), { result: "list", trashes: [] });
  assert.deepEqual(await run({ action: "restore", trash_id: purging }), { result: "not_found", trash_id: purging });
  assert.ok(existsSync(join(dir, TRASH_DIR_NAME, purging, "site", "index.html")));
});

test("pruneProjectTrash: 1 つ消せなくても残りのプロジェクトの古い .trash は消し、最後に 1 回だけ投げる（パスは出さない）", async (t) => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "self-agent-test-")));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const projectsDir = join(root, "projects");
  const now = new Date("2026-10-11T00:00:00Z");
  const old = formatTrashId(new Date(now.getTime() - (TRASH_RETENTION_DAYS + 1) * DAY_MS));
  for (const project of ["a-locked", "b-plain", "c-plain"]) mkdirSync(join(projectsDir, project, TRASH_DIR_NAME, old, "site"), { recursive: true });
  // a-locked の .trash に書けないので、その中の old は消せない
  const lockedTrash = join(projectsDir, "a-locked", TRASH_DIR_NAME);
  chmodSync(lockedTrash, 0o500);
  try {
    await assert.rejects(pruneProjectTrash(projectsDir, now), (error: Error) => !error.message.includes(root));
  } finally {
    chmodSync(lockedTrash, 0o700);
  }
  assert.deepEqual(readdirSync(lockedTrash), [old]);
  assert.deepEqual(readdirSync(join(projectsDir, "b-plain", TRASH_DIR_NAME)), []);
  assert.deepEqual(readdirSync(join(projectsDir, "c-plain", TRASH_DIR_NAME)), []);
});

test("pruneProjectTrash: 名前の時刻から 30 日（days で変えられる）を過ぎた .trash/<trash_id> だけを消し、形に合わない名前・ディレクトリでないもの・symlink の先は触らない。projectsDir が無くても例外にならない", async (t) => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "self-agent-test-")));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const projectsDir = join(root, "projects");
  const now = new Date("2026-10-11T00:00:00Z");
  const old = formatTrashId(new Date(now.getTime() - TRASH_RETENTION_DAYS * DAY_MS - 1000));
  const exact = formatTrashId(new Date(now.getTime() - TRASH_RETENTION_DAYS * DAY_MS));
  const recent = formatTrashId(new Date(now.getTime() - TRASH_RETENTION_DAYS * DAY_MS + 1000));
  const trash = join(projectsDir, "kakeibo", TRASH_DIR_NAME);
  for (const name of [old, `${old}-2`, exact, recent, "junk-20200101T000000Z", "20200101"]) {
    mkdirSync(join(trash, name, "site"), { recursive: true });
    writeFileSync(join(trash, name, "site", "index.html"), "x");
  }
  writeFileSync(join(trash, "20200101T000000Z"), "ファイル");
  mkdirSync(join(root, "outside", "20200101T000000Z"), { recursive: true });
  writeFileSync(join(root, "outside", "20200101T000000Z", "keep.txt"), "keep");
  symlinkSync(join(root, "outside", "20200101T000000Z"), join(trash, "20200102T000000Z"));
  mkdirSync(join(projectsDir, "other", TRASH_DIR_NAME, old), { recursive: true });
  // .trash の無いプロジェクト・.trash が symlink のプロジェクト・ディレクトリでないもの
  mkdirSync(join(projectsDir, "plain", "site"), { recursive: true });
  mkdirSync(join(projectsDir, "linked"));
  symlinkSync(join(root, "outside"), join(projectsDir, "linked", TRASH_DIR_NAME));
  symlinkSync(join(projectsDir, "kakeibo"), join(projectsDir, "alias"));
  writeFileSync(join(projectsDir, "notes.txt"), "x");

  await pruneProjectTrash(projectsDir, now);

  assert.deepEqual(readdirSync(trash).sort(), [exact, recent, "20200101", "20200101T000000Z", "20200102T000000Z", "junk-20200101T000000Z"].sort());
  assert.deepEqual(readdirSync(join(projectsDir, "other", TRASH_DIR_NAME)), []);
  assert.equal(readFileSync(join(root, "outside", "20200101T000000Z", "keep.txt"), "utf8"), "keep");
  assert.ok(existsSync(join(projectsDir, "plain", "site")));

  // days を変えられる
  const short = join(projectsDir, "short", TRASH_DIR_NAME);
  mkdirSync(join(short, "20261009T235959Z"), { recursive: true });
  mkdirSync(join(short, "20261010T000001Z"), { recursive: true });
  await pruneProjectTrash(projectsDir, now, 1);
  assert.deepEqual(readdirSync(short), ["20261010T000001Z"]);

  // projectsDir が無くても例外にならず、作らない
  await pruneProjectTrash(join(root, "no-such-projects"), now);
  assert.equal(existsSync(join(root, "no-such-projects")), false);
});

/** createProjectToolHandlers を、touch を記録するストアと一時ディレクトリで作る。TOPIC のチャンネルにはプロジェクトがある */
function setupTool(t: TestContext) {
  const env = setup(t);
  const db = tempDb(t);
  const { projects: store } = createStores(db, () => NOW);
  const project = store.create({ guildId: TOPIC.guildId, channelId: TOPIC.channelId, name: "kakeibo", title: "家計簿" });
  assert.equal(project.slug, "kakeibo");
  const touched: number[] = [];
  const deps: ProjectToolDeps = {
    projects: {
      getByChannel: (channelId) => store.getByChannel(channelId),
      create: (input) => store.create(input),
      touch: (id) => {
        touched.push(id);
        store.touch(id);
      },
    },
    projectsDir: env.projectsDir,
    publicBaseUrl: "https://example.test:9443",
    serving: () => true,
    log: (line) => env.logs.push(line),
    now: () => NOW,
  };
  const callFiles = (context: RunContext | undefined, args: ProjectFilesArgs) =>
    createProjectToolHandlers(deps, context).projectFiles(args).then(parse);
  return { ...env, db, store, project, touched, deps, callFiles };
}

function parse(result: TextToolResult): unknown {
  assert.equal(result.content.length, 1);
  assert.equal(result.content[0].type, "text");
  return JSON.parse(result.content[0].text);
}

test("project_files: #inbox・#tasks・context の無いターン・プロジェクトの無いセッション・削除したプロジェクトでは not_available を返し、何も変えない", async (t) => {
  const { dir, files, store, project, touched, logs, callFiles: call } = setupTool(t);
  const notAvailable = { result: "not_available", message: FILE_WRITE_DENIED_REASON };

  for (const context of [
    { guildId: "guild-1", channelId: "inbox-1", kind: "inbox" } as const,
    { guildId: "guild-1", channelId: "tasks-1", kind: "tasks" } as const,
    // #inbox・#tasks のチャンネルにプロジェクトの行があっても使わない
    { ...TOPIC, kind: "inbox" } as const,
    undefined,
    { guildId: "guild-1", channelId: "topic-2", kind: "session" } as const,
  ]) {
    assert.deepEqual(await call(context, { action: "clear" }), notAvailable, JSON.stringify(context));
    assert.deepEqual(await call(context, { action: "trash", paths: ["SPEC.md"] }), notAvailable);
  }
  store.markDeleted(project.id);
  assert.deepEqual(await call(TOPIC, { action: "clear" }), notAvailable);

  assert.deepEqual(tree(dir), files);
  assert.deepEqual(touched, []);
  assert.deepEqual(logs, []);
});

test("project_files: ファイルを変えたら（trashed で 1 件以上・moved・cleared・restored）更新日時を今にし、操作と件数だけを log に出す", async (t) => {
  const { dir, project, touched, logs, callFiles: call } = setupTool(t);

  // 変えないもの: 一覧・1 つも移さない trash・invalid_path・invalid_args・exists・missing・not_found
  await call(TOPIC, { action: "restore" });
  await call(TOPIC, { action: "trash", paths: ["nope.txt"] });
  await call(TOPIC, { action: "trash", paths: ["../outside"] });
  await call(TOPIC, { action: "trash" });
  await call(TOPIC, { action: "move", paths: ["SPEC.md"], to: "site/index.html" });
  await call(TOPIC, { action: "move", paths: ["nope.txt"], to: "x.txt" });
  await call(TOPIC, { action: "restore", trash_id: "20991231T000000Z" });
  assert.deepEqual(touched, []);
  assert.equal(logs.length, 0);

  const trashed = (await call(TOPIC, { action: "trash", paths: ["site/index.html", "notes", "nope.txt"] })) as { trash_id: string };
  assert.equal(trashed.trash_id, ID);
  assert.deepEqual(await call(TOPIC, { action: "move", paths: ["SPEC.md"], to: "docs/SPEC.md" }), {
    result: "moved",
    from: "SPEC.md",
    to: "docs/SPEC.md",
  });
  assert.deepEqual(await call(TOPIC, { action: "restore", trash_id: ID }), {
    result: "restored",
    trash_id: ID,
    restored: ["notes/a.md", "notes/b.md", "site/index.html"],
  });
  const cleared = (await call(TOPIC, { action: "clear" })) as { result: string; trash_id: string };
  assert.equal(cleared.result, "cleared");
  // clear の後の restore は土台と重なる（変えない）
  assert.equal(((await call(TOPIC, { action: "restore", trash_id: cleared.trash_id })) as { result: string }).result, "conflict");

  assert.deepEqual(touched, [project.id, project.id, project.id, project.id]);
  // 操作と件数が分かること
  assert.deepEqual(
    logs.map((line) => line.match(/(trash|move|restore|clear)\D*(\d+) 件/)?.slice(1)),
    [
      ["trash", "2"],
      ["move", "1"],
      ["restore", "3"],
      ["clear", "1"],
    ],
  );
  for (const line of logs) {
    for (const secret of [dir, "site", "index", "notes", "SPEC", ID, "kakeibo"]) assert.ok(!line.includes(secret), `${line} ${secret}`);
  }
});

test("project_files: 操作が例外で終わったら投げたまま（ツールの呼び出しの失敗になる）。log は出さず、更新日時も変えない", async (t) => {
  if (process.getuid?.() === 0) {
    t.skip("root では書き込みの権限で失敗させられない");
    return;
  }
  const { dir, touched, logs, callFiles: call } = setupTool(t);
  const site = join(dir, "site");
  // 一時ディレクトリの後始末（t.after）より前に戻す
  chmodSync(site, 0o500);
  try {
    await assert.rejects(call(TOPIC, { action: "trash", paths: ["site/index.html"] }), { code: "EACCES" });
  } finally {
    chmodSync(site, 0o700);
  }
  assert.equal(readFileSync(join(site, "index.html"), "utf8"), "<p>前の</p>");
  assert.deepEqual(touched, []);
  assert.equal(logs.length, 0);
});

test("ツール定義: project_files は project_open の直後。引数は action（4 つ）・paths（1〜50 件、空文字は不可）・to（空文字は不可）・trash_id", (t) => {
  const { db, deps } = setupTool(t);
  const { tasks, topicSessions, knowledge, memories, reminders } = createStores(db, () => NOW);
  const tools = createTaskTools(
    tasks,
    topicSessions,
    async () => ({ result: "not_available" }),
    {
      knowledge,
      memories,
      confirmKbDelete: async () => assert.fail("想定外の呼び出し"),
      notifyMemoryChange: async () => assert.fail("想定外の呼び出し"),
      timeZone: "Asia/Tokyo",
    },
    deps,
    { reminders, log: () => {} },
  );
  const names = tools.map((definition) => definition.name);
  assert.equal(names.indexOf("project_files"), names.indexOf("project_open") + 1);
  const schema = z.object(tools.find((definition) => definition.name === "project_files")!.inputSchema);
  const ok = (input: unknown): boolean => schema.safeParse(input).success;

  for (const action of ["trash", "move", "clear", "restore"]) assert.ok(ok({ action }), action);
  assert.ok(ok({ action: "trash", paths: Array.from({ length: 50 }, (_, i) => `f${i}`) }));
  assert.ok(ok({ action: "move", paths: ["a"], to: "b" }));
  assert.ok(ok({ action: "restore", trash_id: ID }));
  assert.equal(ok({ action: "delete" }), false);
  assert.equal(ok({}), false);
  assert.equal(ok({ action: "trash", paths: [] }), false);
  assert.equal(ok({ action: "trash", paths: Array.from({ length: 51 }, (_, i) => `f${i}`) }), false);
  assert.equal(ok({ action: "trash", paths: [""] }), false);
  assert.equal(ok({ action: "move", paths: ["a"], to: "" }), false);
});

test("project_files: プロジェクトの dir（slug）や projects が外を指す symlink にすり替えられていたら、どの action も not_available で外を何も触らない（sandbox の Bash が projects に書けるため）", async (t) => {
  const actions: ProjectFilesArgs[] = [
    { action: "trash", paths: ["secret.txt"] },
    { action: "move", paths: ["secret.txt"], to: "moved.txt" },
    { action: "clear" },
    { action: "restore" },
    { action: "restore", trash_id: ID },
  ];
  const notAvailable = { result: "not_available", message: PROJECT_DIR_UNVERIFIED_MESSAGE };
  for (const swap of ["slug", "projects"] as const) {
    const { root, projectsDir, dir, touched, logs, callFiles: call } = setupTool(t);
    const outside = join(root, "outside");
    mkdirSync(join(outside, ".trash", ID), { recursive: true });
    writeFileSync(join(outside, ".trash", ID, "x.txt"), "x");
    if (swap === "slug") {
      rmSync(dir, { recursive: true });
      symlinkSync(outside, dir);
    } else {
      // projects そのものを外への symlink に（中に同じ名前の slug を置く）
      mkdirSync(join(root, "elsewhere", "kakeibo"), { recursive: true });
      writeFileSync(join(root, "elsewhere", "kakeibo", "secret.txt"), "secret");
      rmSync(projectsDir, { recursive: true });
      symlinkSync(join(root, "elsewhere"), projectsDir);
    }
    const before = { outside: tree(outside), elsewhere: existsSync(join(root, "elsewhere")) ? tree(join(root, "elsewhere")) : {} };

    for (const args of actions) assert.deepEqual(await call(TOPIC, args), notAvailable, `${swap} ${args.action}`);

    assert.deepEqual(tree(outside), before.outside, swap);
    if (swap === "projects") assert.deepEqual(tree(join(root, "elsewhere")), before.elsewhere);
    assert.deepEqual(touched, []);
    assert.equal(logs.length, actions.length);
    for (const line of logs) assert.ok(!line.includes(root), line);
  }
});
