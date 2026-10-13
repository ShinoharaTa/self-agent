import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as z from "zod";
import type { RunContext } from "../src/agent/runner.ts";
import { WEB_TEMPLATE_DIR } from "../src/agent/scaffold.ts";
import {
  createProjectToolHandlers,
  createTaskTools,
  PROJECT_OPEN_NOT_AVAILABLE_MESSAGE,
  PROJECT_DESIGN_NOTE,
  PROJECT_OPEN_NOT_CONFIGURED_MESSAGE,
  projectNotes,
  type ProjectToolDeps,
  type TextToolResult,
} from "../src/agent/tools.ts";
import { ProjectStore } from "../src/store/projects.ts";
import { createStores, tempDb, tempDir } from "./helpers/db.ts";

const NOW = new Date("2026-10-07T00:12:00Z");
const BASE_URL = "https://example.test:9443";
const TOPIC: RunContext = { guildId: "guild-1", channelId: "topic-1", kind: "session" };
const INBOX: RunContext = { guildId: "guild-1", channelId: "inbox-1", kind: "inbox" };
const ARGS = { name: "Kakeibo App", title: "家計簿" };
/** created で複製する UI の土台（この順で scaffold に入る） */
const CREATED_SCAFFOLD = ["DESIGN.md", "site/base.css", "site/app.css", "site/icons.svg", "site/index.html"];
/** existing で site/base.css が無いときだけ足す UI の土台 */
const EXISTING_SCAFFOLD = ["DESIGN.md", "site/base.css", "site/icons.svg"];

function setup(t: TestContext, overrides: Partial<ProjectToolDeps> = {}) {
  const db = tempDb(t);
  const { projects } = createStores(db, () => NOW);
  const projectsDir = join(tempDir(t), "work", "projects");
  const logs: string[] = [];
  const deps: ProjectToolDeps = {
    projects,
    projectsDir,
    publicBaseUrl: BASE_URL,
    serving: () => true,
    log: (message) => logs.push(message),
    ...overrides,
  };
  return {
    db,
    projects,
    projectsDir,
    logs,
    deps,
    open: (context: RunContext | undefined, args = ARGS) => createProjectToolHandlers(deps, context).projectOpen(args),
  };
}

function parse(result: TextToolResult): unknown {
  assert.equal(result.content.length, 1);
  assert.equal(result.content[0].type, "text");
  return JSON.parse(result.content[0].text);
}

/** dir の file（`/` 区切りの相対パス）が templates/web/ の同じファイルと同じ中身か */
function assertSameAsTemplate(dir: string, file: string): void {
  assert.equal(readFileSync(join(dir, file), "utf8"), readFileSync(join(WEB_TEMPLATE_DIR, file), "utf8"), file);
}

/** projects.create だけでプロジェクトを作り（project_open を通さない）、そのディレクトリを返す */
function createWithoutScaffold(projects: ProjectStore, projectsDir: string, files: Record<string, string>): string {
  const project = projects.create({ guildId: TOPIC.guildId, channelId: TOPIC.channelId, name: ARGS.name, title: ARGS.title });
  const dir = join(projectsDir, project.slug);
  mkdirSync(join(dir, "site"), { recursive: true });
  for (const [file, content] of Object.entries(files)) writeFileSync(join(dir, file), content);
  return dir;
}

test("project_open: セッションのチャンネルで作り、<slug>/site/ まで mkdir して created と dir・site_dir・url・scaffold・注意を返す。UI の土台の 5 つを templates/web/ から複製する", async (t) => {
  const { projects, projectsDir, logs, open } = setup(t);

  const result = parse(await open(TOPIC));

  const dir = join(projectsDir, "kakeibo-app");
  const url = `${BASE_URL}/p/kakeibo-app/`;
  assert.deepEqual(result, {
    status: "created",
    dir,
    site_dir: join(dir, "site"),
    url,
    scaffold: CREATED_SCAFFOLD,
    notes: projectNotes("kakeibo-app", url, true),
  });
  // キーの順も決めている
  assert.deepEqual(Object.keys(result as object), ["status", "dir", "site_dir", "url", "scaffold", "notes"]);
  assert.ok(statSync(join(dir, "site")).isDirectory());
  for (const file of CREATED_SCAFFOLD) assertSameAsTemplate(dir, file);
  const project = projects.getByChannel("topic-1");
  assert.equal(project?.guildId, "guild-1");
  assert.equal(project?.slug, "kakeibo-app");
  assert.equal(project?.title, "家計簿");
  assert.deepEqual(logs, []);
});

test("project_open: 土台は無いものだけ複製し、既にあるファイル（DESIGN.md を含む）は変えない。existing は site/base.css があれば何もしない。DESIGN.md と base.css が揃わなければ注意に土台の使い方を入れない", async (t) => {
  const cases: Array<{
    label: string;
    /** 呼ぶ前のプロジェクトのディレクトリ。row が false ならプロジェクトの行は作らない */
    before: Record<string, string>;
    row: boolean;
    status: string;
    scaffold: string[];
    absent: string[];
    withDesign: boolean;
  }> = [
    {
      label: "existing・base.css 無し",
      before: { "site/index.html": "<p>前からある</p>", "site/app.css": "body { color: red; }", "SPEC.md": "仕様" },
      row: true,
      status: "existing",
      scaffold: EXISTING_SCAFFOLD,
      absent: [],
      withDesign: true,
    },
    {
      label: "existing・base.css あり",
      before: { "site/base.css": "/* 自分で書いた */" },
      row: true,
      status: "existing",
      scaffold: [],
      absent: ["DESIGN.md", "site/icons.svg", "site/index.html"],
      withDesign: false,
    },
    {
      label: "existing・DESIGN.md あり・base.css 無し",
      before: { "DESIGN.md": "前からある" },
      row: true,
      status: "existing",
      scaffold: ["site/base.css", "site/icons.svg"],
      absent: [],
      withDesign: true,
    },
    {
      label: "created・プロジェクトのディレクトリに DESIGN.md が先に残っていた",
      before: { "DESIGN.md": "前からある" },
      row: false,
      status: "created",
      scaffold: ["site/base.css", "site/app.css", "site/icons.svg", "site/index.html"],
      absent: [],
      withDesign: true,
    },
  ];
  for (const { label, before, row, status, scaffold, absent, withDesign } of cases) {
    const { projects, projectsDir, logs, open } = setup(t);
    let dir = join(projectsDir, "kakeibo-app");
    if (row) {
      dir = createWithoutScaffold(projects, projectsDir, before);
    } else {
      mkdirSync(dir, { recursive: true });
      for (const [file, content] of Object.entries(before)) writeFileSync(join(dir, file), content);
    }

    const result = parse(await open(TOPIC)) as { status: string; url: string; scaffold: string[]; notes: string[] };

    assert.equal(result.status, status, label);
    assert.deepEqual(result.scaffold, scaffold, label);
    for (const file of scaffold) assertSameAsTemplate(dir, file);
    for (const [file, content] of Object.entries(before)) assert.equal(readFileSync(join(dir, file), "utf8"), content, `${label} ${file}`);
    for (const file of absent) assert.equal(existsSync(join(dir, file)), false, `${label} ${file}`);
    assert.deepEqual(result.notes, projectNotes("kakeibo-app", result.url, withDesign), label);
    assert.deepEqual(logs, [], label);
  }
});

test("project_open: 土台の複製に失敗しても created・existing を返し、scaffold は複製できた分だけ。log はパス・例外の中身を出さない。注意に土台の使い方を入れない", async (t) => {
  // DESIGN.md と site/app.css だけがある複製の元
  const partial = mkdtempSync(join(tmpdir(), "self-agent-test-template-"));
  t.after(() => rmSync(partial, { recursive: true, force: true }));
  mkdirSync(join(partial, "site"));
  writeFileSync(join(partial, "DESIGN.md"), "決まり");
  writeFileSync(join(partial, "site", "app.css"), "/* app */");
  const cases: Array<{ label: string; templateDir: string; created: string[]; existing: string[] }> = [
    { label: "複製の元が無い", templateDir: join(tmpdir(), "self-agent-test-no-such-template"), created: [], existing: [] },
    { label: "一部だけ複製できる", templateDir: partial, created: ["DESIGN.md", "site/app.css"], existing: [] },
  ];

  for (const { label, templateDir, created, existing } of cases) {
    const { projectsDir, logs, open } = setup(t, { templateDir });

    const first = parse(await open(TOPIC)) as { status: string; site_dir: string; url: string; scaffold: string[]; notes: string[] };
    const second = parse(await open(TOPIC)) as { status: string; scaffold: string[]; notes: string[] };

    assert.equal(first.status, "created", label);
    assert.deepEqual(first.scaffold, created, label);
    assert.ok(statSync(first.site_dir).isDirectory(), label);
    assert.equal(second.status, "existing", label);
    assert.deepEqual(second.scaffold, existing, label);
    assert.deepEqual(first.notes, projectNotes("kakeibo-app", first.url, false), label);
    assert.deepEqual(second.notes, first.notes, label);
    assert.equal(logs.length, 2, label);
    for (const line of logs) {
      for (const secret of [projectsDir, templateDir, "ENOENT"]) assert.ok(!line.includes(secret), `${label} ${line}`);
    }
  }
});

test("projectNotes: withDesign なら 10 項目で DESIGN.md の項目を含み、そうでなければそれだけを除いた 9 項目", () => {
  const url = "https://example.test:9443/p/kakeibo/";
  const withDesign = projectNotes("kakeibo", url, true);
  const withoutDesign = projectNotes("kakeibo", url, false);

  assert.equal(withDesign.length, 10);
  assert.ok(withDesign.includes(PROJECT_DESIGN_NOTE));
  assert.equal(withoutDesign.length, 9);
  assert.deepEqual(withoutDesign, withDesign.filter((note) => note !== PROJECT_DESIGN_NOTE));
});

test("project_open: 2 回目は同じプロジェクトを existing で返す（name・title が違っても作らない）。別のチャンネルは別のプロジェクト", async (t) => {
  const { db, projectsDir, open } = setup(t);
  const first = parse(await open(TOPIC));

  const second = parse(await open(TOPIC, { name: "other", title: "別の名前" }));
  // 土台は 1 回目で置いたので、2 回目は何も複製しない
  assert.deepEqual(second, { ...(first as object), status: "existing", scaffold: [] });

  const other = parse(await open({ guildId: "guild-1", channelId: "topic-2", kind: "session" }));
  assert.equal((other as { status: string }).status, "created");
  assert.equal((other as { dir: string }).dir, join(projectsDir, "kakeibo-app-2"));
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM projects").get()?.n, 2);
});

test("project_open: 同じターンで並べて呼ばれても 1 つしか作らない", async (t) => {
  const { db, open } = setup(t);

  const results = (await Promise.all([open(TOPIC), open(TOPIC)])).map(parse) as Array<{ status: string }>;

  assert.deepEqual(results.map((result) => result.status).sort(), ["created", "existing"]);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM projects").get()?.n, 1);
});

test("project_open: #inbox・#tasks・context の無いターンでは not_available を返し、何も作らない（セッション以外では使えない）", async (t) => {
  const { db, projectsDir, open } = setup(t);

  for (const context of [INBOX, { guildId: "guild-1", channelId: "tasks-1", kind: "tasks" } as const, undefined]) {
    assert.deepEqual(
      parse(await open(context)),
      { status: "not_available", message: PROJECT_OPEN_NOT_AVAILABLE_MESSAGE },
      context?.kind ?? "context なし",
    );
  }
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM projects").get()?.n, 0);
  assert.equal(existsSync(projectsDir), false);
});

test("project_open: 配信が無効（公開 URL が無い・静的サーバーが待ち受けていない）なら not_configured を返し、何も作らない", async (t) => {
  for (const overrides of [{ publicBaseUrl: undefined }, { serving: () => false }]) {
    const { db, projectsDir, open } = setup(t, overrides);
    assert.deepEqual(parse(await open(TOPIC)), { status: "not_configured", message: PROJECT_OPEN_NOT_CONFIGURED_MESSAGE });
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM projects").get()?.n, 0);
    assert.equal(existsSync(projectsDir), false);
  }
  // #inbox なら配信が無効でも not_available
  const { open } = setup(t, { publicBaseUrl: undefined });
  assert.equal((parse(await open(INBOX)) as { status: string }).status, "not_available");
});

test("ツール定義: project_open の name は 1〜40 字、title は 1〜100 字", (t) => {
  const { db, deps } = setup(t);
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
  const definition = tools.find((candidate) => candidate.name === "project_open")!;
  const schema = z.object(definition.inputSchema);
  const ok = (input: unknown): boolean => schema.safeParse(input).success;

  assert.ok(ok({ name: "a", title: "t" }));
  assert.ok(ok({ name: "a".repeat(40), title: "あ".repeat(100) }));
  assert.equal(ok({ name: "", title: "t" }), false);
  assert.equal(ok({ name: "a".repeat(41), title: "t" }), false);
  assert.equal(ok({ name: "a", title: "" }), false);
  assert.equal(ok({ name: "a", title: "あ".repeat(101) }), false);
  assert.equal(ok({ title: "t" }), false);
});
