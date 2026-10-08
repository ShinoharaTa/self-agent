import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as z from "zod";
import type { RunContext } from "../src/agent/runner.ts";
import { SYSTEM_PROMPT } from "../src/agent/system-prompt.ts";
import {
  createProjectToolHandlers,
  createTaskTools,
  PROJECT_OPEN_NOT_AVAILABLE_MESSAGE,
  PROJECT_OPEN_NOT_CONFIGURED_MESSAGE,
  projectNotes,
  type ProjectToolDeps,
  type TextToolResult,
} from "../src/agent/tools.ts";
import { openDb } from "../src/store/db.ts";
import { KnowledgeStore } from "../src/store/knowledge.ts";
import { MemoryStore } from "../src/store/memories.ts";
import { ProjectStore } from "../src/store/projects.ts";
import { TaskStore } from "../src/store/tasks.ts";
import { TopicSessionStore } from "../src/store/topic-sessions.ts";

const NOW = new Date("2026-10-07T00:12:00Z");
const BASE_URL = "https://example.test:9443";
const TOPIC: RunContext = { guildId: "guild-1", channelId: "topic-1", kind: "session" };
const INBOX: RunContext = { guildId: "guild-1", channelId: "inbox-1", kind: "inbox" };
const ARGS = { name: "Kakeibo App", title: "家計簿" };

function setup(t: TestContext, overrides: Partial<ProjectToolDeps> = {}) {
  const dir = mkdtempSync(join(tmpdir(), "self-agent-test-"));
  const db = openDb(join(dir, "self-agent.db"));
  t.after(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const projects = new ProjectStore(db, () => NOW);
  const projectsDir = join(dir, "work", "projects");
  const deps: ProjectToolDeps = { projects, projectsDir, publicBaseUrl: BASE_URL, serving: () => true, ...overrides };
  return {
    db,
    projects,
    projectsDir,
    deps,
    open: (context: RunContext | undefined, args = ARGS) => createProjectToolHandlers(deps, context).projectOpen(args),
  };
}

function parse(result: TextToolResult): unknown {
  assert.equal(result.content.length, 1);
  assert.equal(result.content[0].type, "text");
  return JSON.parse(result.content[0].text);
}

test("project_open: セッションのチャンネルで作り、<slug>/site/ まで mkdir して created と dir・site_dir・url・注意を返す", async (t) => {
  const { projects, projectsDir, open } = setup(t);

  const result = parse(await open(TOPIC));

  const dir = join(projectsDir, "kakeibo-app");
  const url = `${BASE_URL}/p/kakeibo-app/`;
  assert.deepEqual(result, {
    status: "created",
    dir,
    site_dir: join(dir, "site"),
    url,
    notes: projectNotes("kakeibo-app", url),
  });
  assert.ok(statSync(join(dir, "site")).isDirectory());
  const project = projects.getByChannel("topic-1");
  assert.equal(project?.guildId, "guild-1");
  assert.equal(project?.slug, "kakeibo-app");
  assert.equal(project?.title, "家計簿");
});

test("project_open: 注意は 7 項目（dir と site_dir・相対パスと url・localStorage と slug・秘密・ビルド不可・Glob と Grep の path・SPEC.md）", () => {
  assert.deepEqual(projectNotes("kakeibo", "https://example.test:9443/p/kakeibo/"), [
    "ファイルは dir の中に書く。配られるのは site_dir の中だけで、入口は site_dir/index.html",
    "パスは相対で書く（/ で始めない）。ページは https://example.test:9443/p/kakeibo/ で開かれる",
    "localStorage のキーは kakeibo で始める（全プロジェクトが同じオリジン）",
    "API キーや秘密をページに書かない。オーナーのタスク・記憶・ナレッジ・会話の中身は、頼まれない限りページに入れない",
    "ビルドやコマンドの実行はできない。ライブラリは CDN から読む",
    "Glob・Grep は path に dir を指定する",
    "決めた仕様・やり残したことは dir/SPEC.md に短く書いておく。続きを頼まれたら最初に SPEC.md を読む",
  ]);
});

test("project_open: 2 回目は同じプロジェクトを existing で返す（name・title が違っても作らない）。別のチャンネルは別のプロジェクト", async (t) => {
  const { db, projectsDir, open } = setup(t);
  const first = parse(await open(TOPIC));

  const second = parse(await open(TOPIC, { name: "other", title: "別の名前" }));
  assert.deepEqual(second, { ...(first as object), status: "existing" });

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

test("project_open: #inbox・context の無いターンでは not_available を返し、何も作らない", async (t) => {
  const { db, projectsDir, open } = setup(t);

  for (const context of [INBOX, undefined]) {
    assert.deepEqual(parse(await open(context)), { status: "not_available", message: PROJECT_OPEN_NOT_AVAILABLE_MESSAGE });
  }
  assert.equal(PROJECT_OPEN_NOT_AVAILABLE_MESSAGE, "セッションのチャンネルで使います。#inbox では session_open で専用のチャンネルを作ってください");
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM projects").get()?.n, 0);
  assert.equal(existsSync(projectsDir), false);
});

test("project_open: #tasks でも not_available を返し、何も作らない（セッション以外では使えない）", async (t) => {
  const { db, projectsDir, open } = setup(t);

  assert.deepEqual(parse(await open({ guildId: "guild-1", channelId: "tasks-1", kind: "tasks" })), {
    status: "not_available",
    message: PROJECT_OPEN_NOT_AVAILABLE_MESSAGE,
  });
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
  assert.equal(PROJECT_OPEN_NOT_CONFIGURED_MESSAGE, "ページの配信が設定されていません");
  // #inbox なら配信が無効でも not_available
  const { open } = setup(t, { publicBaseUrl: undefined });
  assert.equal((parse(await open(INBOX)) as { status: string }).status, "not_available");
});

function projectOpenDefinition(t: TestContext, context?: RunContext) {
  const { db, deps } = setup(t);
  const tools = createTaskTools(
    new TaskStore(db, () => NOW),
    new TopicSessionStore(db, () => NOW),
    async () => ({ result: "not_available" }),
    {
      knowledge: new KnowledgeStore(db, () => NOW),
      memories: new MemoryStore(db, () => NOW),
      confirmKbDelete: async () => assert.fail("想定外の呼び出し"),
      notifyMemoryChange: async () => assert.fail("想定外の呼び出し"),
      timeZone: "Asia/Tokyo",
    },
    deps,
    context,
  );
  const definition = tools.at(-1);
  assert.equal(definition?.name, "project_open");
  return definition!;
}

test("ツール定義: project_open は最後。説明は使いどころと、コードを貼らずに url を伝えること", (t) => {
  const definition = projectOpenDefinition(t);

  assert.equal(
    definition.description,
    "オーナーが何かを作ってほしい・動くものがほしいと頼んだときに使う。このチャンネルのプロジェクトを作るか、既にあれば返す。" +
      "コードを Discord に貼らず、ファイルを dir に書き、site_dir の index.html から動く状態にして url を伝える。#inbox では使えない。",
  );
  // 使いどころはシステムプロンプトにも書く
  assert.ok(SYSTEM_PROMPT.includes("project_open"));
});

test("ツール定義: project_open の name は 1〜40 字、title は 1〜100 字", (t) => {
  const schema = z.object(projectOpenDefinition(t).inputSchema);
  const ok = (input: unknown): boolean => schema.safeParse(input).success;

  assert.ok(ok({ name: "a", title: "t" }));
  assert.ok(ok({ name: "a".repeat(40), title: "あ".repeat(100) }));
  assert.equal(ok({ name: "", title: "t" }), false);
  assert.equal(ok({ name: "a".repeat(41), title: "t" }), false);
  assert.equal(ok({ name: "a", title: "" }), false);
  assert.equal(ok({ name: "a", title: "あ".repeat(101) }), false);
  assert.equal(ok({ title: "t" }), false);
});

test("ツール: project_open のハンドラはこの run の context で作り、結果を JSON で返す", async (t) => {
  const definition = projectOpenDefinition(t, TOPIC);
  // find の結果は全ツールの union なので、project_open の引数の形に絞って呼ぶ
  const handler = definition.handler as (args: typeof ARGS, extra: unknown) => Promise<TextToolResult>;

  const result = parse(await handler(ARGS, {})) as { status: string; url: string };

  assert.equal(result.status, "created");
  assert.equal(result.url, `${BASE_URL}/p/kakeibo-app/`);
});
