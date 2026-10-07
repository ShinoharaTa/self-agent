import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { STALE_TEXT } from "../src/app/commands/delete.ts";
import { HELP_TEXT } from "../src/app/commands/help.ts";
import {
  createProjectsCommand,
  createProjectsComponent,
  NO_PROJECTS_TEXT,
  PROJECT_KEPT_TEXT,
  projectDeletePrompt,
  projectListMessage,
  type ProjectsDeps,
} from "../src/app/commands/projects.ts";
import { MESSAGE_MAX_LENGTH } from "../src/app/commands/sessions.ts";
import type {
  ComponentRow,
  Interaction,
  InteractionResponder,
  ModalDef,
  OutgoingMessage,
} from "../src/discord/gateway.ts";
import { openDb } from "../src/store/db.ts";
import { ProjectStore } from "../src/store/projects.ts";

const BASE_URL = "https://example.ts.net:9443";
const TZ = "Asia/Tokyo";

type ResponderCall =
  | { method: "defer"; ephemeral: boolean }
  | { method: "deferUpdate" }
  | { method: "reply" | "update"; message: OutgoingMessage }
  | { method: "showModal"; modal: ModalDef };

class FakeResponder implements InteractionResponder {
  calls: ResponderCall[] = [];

  async defer(ephemeral: boolean): Promise<void> {
    this.calls.push({ method: "defer", ephemeral });
  }
  async deferUpdate(): Promise<void> {
    this.calls.push({ method: "deferUpdate" });
  }
  async reply(message: OutgoingMessage): Promise<void> {
    this.calls.push({ method: "reply", message });
  }
  async update(message: OutgoingMessage): Promise<void> {
    this.calls.push({ method: "update", message });
  }
  async showModal(modal: ModalDef): Promise<void> {
    this.calls.push({ method: "showModal", modal });
  }
}

const INTERACTION_BASE = {
  guildId: "guild-1",
  channelId: "topic-1",
  userId: "owner-1",
  createdAt: new Date("2026-10-07T00:00:00Z"),
};
const PROJECTS: Extract<Interaction, { kind: "command" }> = {
  ...INTERACTION_BASE,
  kind: "command",
  name: "projects",
  options: {},
};

function pick(values: string[], customId: string = "proj:pick"): Extract<Interaction, { kind: "select" }> {
  return { ...INTERACTION_BASE, kind: "select", customId, values };
}

function press(customId: string): Extract<Interaction, { kind: "button" }> {
  return { ...INTERACTION_BASE, kind: "button", customId, messageId: "message-1" };
}

/**
 * 一時 SQLite と一時ディレクトリ（<dir>/projects）。時計は setNow で進める（初めは 2026-10-07T00:00Z）。
 * add は project_open と同じく `<projectsDir>/<slug>/site/index.html` まで作る
 */
function setup(t: TestContext, options: { publicBaseUrl: string | undefined } = { publicBaseUrl: BASE_URL }) {
  const { publicBaseUrl } = options;
  const dir = mkdtempSync(join(tmpdir(), "self-agent-test-"));
  const db = openDb(join(dir, "self-agent.db"));
  const projectsDir = join(dir, "projects");
  mkdirSync(projectsDir);
  t.after(() => {
    db.close();
    chmodSync(projectsDir, 0o755);
    rmSync(dir, { recursive: true, force: true });
  });
  let now = new Date("2026-10-07T00:00:00Z");
  const projects = new ProjectStore(db, () => now);
  const logs: string[] = [];
  const deps: ProjectsDeps = {
    projects,
    projectsDir,
    cfg: { publicBaseUrl, timeZone: TZ },
    log: (line) => logs.push(line),
  };
  let channels = 0;
  const add = (name: string, title: string = name) => {
    const project = projects.create({ guildId: "guild-1", channelId: `ch-${++channels}`, name, title });
    mkdirSync(join(projectsDir, project.slug, "site"), { recursive: true });
    writeFileSync(join(projectsDir, project.slug, "site", "index.html"), "<p>hi</p>");
    return project;
  };
  const runProjects = async (): Promise<ResponderCall[]> => {
    const responder = new FakeResponder();
    await createProjectsCommand(deps).handle(PROJECTS, responder);
    return responder.calls;
  };
  const component = createProjectsComponent(deps);
  const run = async (interaction: Exclude<Interaction, { kind: "command" }>): Promise<ResponderCall[]> => {
    const responder = new FakeResponder();
    await component.handle(interaction, responder);
    return responder.calls;
  };
  return {
    dir,
    projects,
    projectsDir,
    deps,
    logs,
    add,
    runProjects,
    component,
    run,
    setNow: (iso: string) => {
      now = new Date(iso);
    },
  };
}

function selectRow(options: Array<{ label: string; value: string; description: string }>): ComponentRow {
  return {
    kind: "select",
    select: {
      customId: "proj:pick",
      placeholder: "削除するプロジェクトを選ぶ",
      minValues: 1,
      maxValues: 1,
      options,
    },
  };
}

test("/projects: 削除されていないプロジェクトを更新の新しい順に `**題名** url（<#元のチャンネル>・更新 YYYY-MM-DD）` で並べ、セレクトを付けて ephemeral で返す", async (t) => {
  const { projects, add, runProjects, setNow } = setup(t);
  setNow("2026-10-05T03:00:00Z");
  const kakeibo = add("kakeibo", "家計簿");
  setNow("2026-10-06T03:00:00Z");
  add("todo", "やること");
  const gone = add("gone", "消したもの");
  projects.markDeleted(gone.id);
  // SELF_AGENT_TZ（Asia/Tokyo）では 10 月 7 日
  setNow("2026-10-06T16:30:00Z");
  projects.touch(kakeibo.id);

  const calls = await runProjects();

  assert.deepEqual(calls, [
    {
      method: "reply",
      message: {
        text: [
          `**家計簿** ${BASE_URL}/p/kakeibo/（<#ch-1>・更新 2026-10-07）`,
          `**やること** ${BASE_URL}/p/todo/（<#ch-2>・更新 2026-10-06）`,
        ].join("\n"),
        components: [
          selectRow([
            { label: "家計簿", value: "1", description: "kakeibo" },
            { label: "やること", value: "2", description: "todo" },
          ]),
        ],
        ephemeral: true,
      },
    },
  ]);
});

test("/projects: 0 件（削除済みだけを含む）なら「プロジェクトはまだありません」だけ", async (t) => {
  const { projects, add, runProjects } = setup(t);
  assert.deepEqual(await runProjects(), [
    { method: "reply", message: { text: NO_PROJECTS_TEXT, components: [], ephemeral: true } },
  ]);
  projects.markDeleted(add("gone").id);

  assert.deepEqual(await runProjects(), [
    { method: "reply", message: { text: NO_PROJECTS_TEXT, components: [], ephemeral: true } },
  ]);
  assert.equal(NO_PROJECTS_TEXT, "プロジェクトはまだありません");
});

test("/projects: 配信が未設定（publicBaseUrl が無い）なら url の代わりに「（配信は未設定）」。確認の括弧の中も「配信は未設定」", async (t) => {
  const { add, run, runProjects } = setup(t, { publicBaseUrl: undefined });
  add("kakeibo", "家計簿");

  const calls = await runProjects();

  assert.ok(calls[0]?.method === "reply");
  assert.equal(calls[0].message.text, "**家計簿** （配信は未設定）（<#ch-1>・更新 2026-10-07）");
  const confirm = await run(pick(["1"]));
  assert.ok(confirm[0]?.method === "reply");
  assert.equal(confirm[0].message.text, "家計簿（配信は未設定）を削除しますか？ ページは開けなくなり、ファイルも消えます");
});

test("/projects: 2000 字を超えるなら末尾（古いもの）から削って「ほか n 件」を足す。セレクトは本文とは別に新しい順に 25 件まで", (t) => {
  const { add, deps } = setup(t);
  for (let i = 1; i <= 30; i++) add(`p${i}`, `${"あ".repeat(97)}${String(i).padStart(3, "0")}`);

  const message = projectListMessage(deps);

  assert.ok(message.text.length <= MESSAGE_MAX_LENGTH, `length=${message.text.length}`);
  const lines = message.text.split("\n");
  const shown = lines.filter((line) => line.startsWith("**"));
  assert.ok(shown.length > 0 && shown.length < 30);
  assert.equal(lines.at(-1), `ほか ${30 - shown.length} 件`);
  // 時刻が同じなら id の大きい（新しい）ものから
  assert.ok(shown[0]?.includes("/p/p30/"));
  assert.ok(shown.at(-1)?.includes(`/p/p${31 - shown.length}/`));
  const row = message.components?.[0];
  assert.ok(row?.kind === "select");
  assert.equal(row.select.options.length, 25);
  assert.deepEqual(
    row.select.options.map((option) => option.value),
    Array.from({ length: 25 }, (_, i) => String(30 - i)),
  );
  assert.equal(row.select.options[0]?.description, "p30");
  assert.equal(row.select.options[0]?.label, `${"あ".repeat(97)}030`);
});

test("/projects: セレクトの label は 100 字（UTF-16）までに切る", (t) => {
  const { add, deps } = setup(t);
  add("emoji", "😀".repeat(100));

  const row = projectListMessage(deps).components?.[0];

  assert.ok(row?.kind === "select");
  const label = row.select.options[0]?.label ?? "";
  assert.ok(label.length <= 100, `length=${label.length}`);
  assert.ok(label.endsWith("…"));
});

test("proj:pick: 選んだプロジェクトの削除の確認を本人にだけ出す。[削除する]（proj:del:<id>、danger）[やめる]（proj:keep:<id>）", async (t) => {
  const { add, run } = setup(t);
  add("kakeibo", "家計簿");

  const calls = await run(pick(["1"]));

  const prompt = {
    text: `家計簿（${BASE_URL}/p/kakeibo/）を削除しますか？ ページは開けなくなり、ファイルも消えます`,
    components: [
      {
        kind: "buttons" as const,
        buttons: [
          { customId: "proj:del:1", label: "削除する", style: "danger" as const },
          { customId: "proj:keep:1", label: "やめる" },
        ],
      },
    ],
  };
  assert.deepEqual(calls, [{ method: "reply", message: { ...prompt, ephemeral: true } }]);
  assert.deepEqual(projectDeletePrompt({ id: 1, slug: "kakeibo", title: "家計簿" }, BASE_URL), prompt);
});

test("proj:pick: 選んだ後に削除済み・無いものなら「古くなっています」を本人にだけ出す", async (t) => {
  const { projects, add, run } = setup(t);
  projects.markDeleted(add("kakeibo").id);

  assert.deepEqual(await run(pick(["1"])), [{ method: "reply", message: { text: STALE_TEXT, ephemeral: true } }]);
  assert.deepEqual(await run(pick(["99"])), [{ method: "reply", message: { text: STALE_TEXT, ephemeral: true } }]);
});

test("[削除する]: 削除済みにしてディレクトリを消し、「削除しました: 題名」にしてボタンを外す。2 回目は「古くなっています」", async (t) => {
  const { projects, projectsDir, add, run, logs } = setup(t);
  add("kakeibo", "家計簿");
  add("todo", "やること");

  const calls = await run(press("proj:del:1"));

  assert.deepEqual(calls, [
    { method: "deferUpdate" },
    { method: "update", message: { text: "削除しました: 家計簿", components: [] } },
  ]);
  assert.equal(existsSync(join(projectsDir, "kakeibo")), false);
  assert.notEqual(projects.get(1)?.deletedAt, null);
  assert.equal(projects.getBySlug("kakeibo"), undefined);
  // 他のプロジェクトはそのまま
  assert.ok(existsSync(join(projectsDir, "todo", "site", "index.html")));
  assert.equal(projects.get(2)?.deletedAt, null);
  assert.deepEqual(logs, ["[削除する] でプロジェクトを削除しました"]);

  assert.deepEqual(await run(press("proj:del:1")), [
    { method: "deferUpdate" },
    { method: "update", message: { text: STALE_TEXT, components: [] } },
  ]);
  assert.deepEqual(await run(press("proj:del:99")), [
    { method: "deferUpdate" },
    { method: "update", message: { text: STALE_TEXT, components: [] } },
  ]);
  assert.ok(STALE_TEXT.includes("古くなっています"));
  assert.equal(logs.length, 1);
});

test("[やめる]: 何も消さず「やめました」にしてボタンを外す", async (t) => {
  const { projects, projectsDir, add, run, logs } = setup(t);
  add("kakeibo", "家計簿");

  assert.deepEqual(await run(press("proj:keep:1")), [
    { method: "update", message: { text: PROJECT_KEPT_TEXT, components: [] } },
  ]);
  assert.equal(PROJECT_KEPT_TEXT, "やめました");
  assert.ok(existsSync(join(projectsDir, "kakeibo", "site", "index.html")));
  assert.equal(projects.get(1)?.deletedAt, null);
  assert.deepEqual(logs, []);
});

test("[削除する]: slug のディレクトリが projects の外（や別のプロジェクト）を指す symlink なら、消さずに log。DB は削除済みにする", async (t) => {
  const { dir, projects, projectsDir, add, run, logs } = setup(t);
  const outside = join(dir, "outside");
  mkdirSync(outside);
  writeFileSync(join(outside, "keep.txt"), "keep");
  const linked = projects.create({ guildId: "guild-1", channelId: "ch-linked", name: "linked", title: "外へのリンク" });
  symlinkSync(outside, join(projectsDir, linked.slug));
  add("todo", "やること");
  const sibling = projects.create({ guildId: "guild-1", channelId: "ch-sibling", name: "sibling", title: "隣へのリンク" });
  symlinkSync(join(projectsDir, "todo"), join(projectsDir, sibling.slug));

  const calls = await run(press(`proj:del:${linked.id}`));

  assert.deepEqual(calls.at(-1), { method: "update", message: { text: "削除しました: 外へのリンク", components: [] } });
  assert.ok(existsSync(join(outside, "keep.txt")));
  assert.notEqual(projects.get(linked.id)?.deletedAt, null);

  await run(press(`proj:del:${sibling.id}`));
  assert.ok(existsSync(join(projectsDir, "todo", "site", "index.html")));
  assert.notEqual(projects.get(sibling.id)?.deletedAt, null);

  const refused = "プロジェクトのディレクトリを確かめられないため消しませんでした";
  assert.deepEqual(logs, [refused, "[削除する] でプロジェクトを削除しました", refused, "[削除する] でプロジェクトを削除しました"]);
  // log に slug・パスは出さない
  for (const line of logs) assert.ok(!line.includes("linked") && !line.includes(dir), line);
});

test("[削除する]: ディレクトリを消すのに失敗しても DB は削除済みのまま、log に「プロジェクトのディレクトリを消せませんでした」", async (t) => {
  const { projects, projectsDir, add, run, logs } = setup(t);
  add("kakeibo", "家計簿");
  // projects に書けないと kakeibo 自体を消せない
  chmodSync(projectsDir, 0o555);

  const calls = await run(press("proj:del:1"));

  chmodSync(projectsDir, 0o755);
  assert.deepEqual(calls.at(-1), { method: "update", message: { text: "削除しました: 家計簿", components: [] } });
  assert.ok(existsSync(join(projectsDir, "kakeibo")));
  assert.notEqual(projects.get(1)?.deletedAt, null);
  assert.deepEqual(logs, ["プロジェクトのディレクトリを消せませんでした", "[削除する] でプロジェクトを削除しました"]);
});

test("proj の不明な操作（id 無し・数でない id・知らない action・ボタン以外・セレクト以外の pick）は例外にする", async (t) => {
  const { projects, add, component } = setup(t);
  add("kakeibo");
  const responder = new FakeResponder();

  for (const customId of ["proj:del", "proj:del:", "proj:del:abc", "proj:del:0", "proj:del:-1", "proj:del:1.5", "proj:open:1"]) {
    await assert.rejects(component.handle(press(customId), responder), Error, customId);
  }
  await assert.rejects(component.handle(pick(["1"], "proj:del:1"), responder), /proj の不明な操作です/);
  await assert.rejects(component.handle(press("proj:pick"), responder), /proj の不明な操作です/);
  await assert.rejects(component.handle(pick(["abc"]), responder), /id がありません/);
  assert.deepEqual(responder.calls, []);
  assert.equal(projects.get(1)?.deletedAt, null);
  assert.equal(component.namespace, "proj");
});

test("/help に /projects の説明がある", () => {
  assert.match(HELP_TEXT, /^`\/projects` 作ったページの一覧を表示します（選んで削除できます）$/m);
});
