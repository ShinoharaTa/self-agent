import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { STALE_TEXT } from "../src/app/commands/delete.ts";
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
import { KeyedSerialQueue } from "../src/app/queue.ts";
import { MAINTENANCE_QUEUE_KEY } from "../src/app/scheduler.ts";
import type { ComponentRow, Interaction } from "../src/discord/gateway.ts";
import { createStores, tempDb } from "./helpers/db.ts";
import { FakeResponder, type ResponderCall } from "./helpers/responder.ts";

const BASE_URL = "https://example.ts.net:9443";
const TZ = "Asia/Tokyo";

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
 * add は project_open と同じく `<projectsDir>/<slug>/site/index.html` まで作る。
 * ターンのキューは本物（シェルが有効なときと同じくセッションのジョブは 1 つずつ）で、入れたジョブの key と種類を queued に残す
 */
function setup(t: TestContext, options: { publicBaseUrl: string | undefined; shell?: boolean } = { publicBaseUrl: BASE_URL }) {
  const { publicBaseUrl, shell = false } = options;
  const turnQueue = new KeyedSerialQueue(3, { maxSessions: 1 });
  const queued: Array<{ key: string; session: boolean }> = [];
  const db = tempDb(t);
  const dir = mkdtempSync(join(tmpdir(), "self-agent-test-"));
  const projectsDir = join(dir, "projects");
  mkdirSync(projectsDir);
  t.after(() => {
    chmodSync(projectsDir, 0o755);
    rmSync(dir, { recursive: true, force: true });
  });
  let now = new Date("2026-10-07T00:00:00Z");
  const { projects } = createStores(db, () => now);
  const logs: string[] = [];
  const deps: ProjectsDeps = {
    projects,
    projectsDir,
    cfg: { publicBaseUrl, timeZone: TZ, shell },
    turnQueue: {
      run: (key, fn, runOptions) => {
        queued.push({ key, session: runOptions?.session === true });
        return turnQueue.run(key, fn, runOptions);
      },
    },
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
    turnQueue,
    queued,
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

/** proj:pick で id のプロジェクトを選び、出た確認のボタンを label で押す（custom_id は確認のものを使う） */
async function confirmButton(
  run: (interaction: Exclude<Interaction, { kind: "command" }>) => Promise<ResponderCall[]>,
  id: number,
  label: string,
): Promise<Extract<Interaction, { kind: "button" }>> {
  const [reply] = await run(pick([String(id)]));
  assert.ok(reply?.method === "reply");
  const row = reply.message.components?.[0];
  assert.ok(row?.kind === "buttons");
  const button = row.buttons.find((candidate) => candidate.label === label);
  assert.ok(button !== undefined, label);
  return press(button.customId);
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
});

test("/projects: 配信が未設定（publicBaseUrl が無い）なら url の代わりに「（配信は未設定）」。確認の括弧の中も「配信は未設定」", async (t) => {
  const { add, run, runProjects } = setup(t, { publicBaseUrl: undefined });
  add("kakeibo", "家計簿");

  const calls = await runProjects();

  assert.ok(calls[0]?.method === "reply");
  assert.ok(calls[0].message.text.includes("配信は未設定"));
  assert.ok(!calls[0].message.text.includes("/p/"));
  const confirm = await run(pick(["1"]));
  assert.ok(confirm[0]?.method === "reply");
  assert.ok(confirm[0].message.text.includes("家計簿（配信は未設定）"));
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

test("proj:pick: 選んだプロジェクトの削除の確認（[削除する][やめる]）を本人にだけ出す", async (t) => {
  const { add, run } = setup(t);
  add("kakeibo", "家計簿");

  const calls = await run(pick(["1"]));

  assert.deepEqual(calls, [
    {
      method: "reply",
      message: { ...projectDeletePrompt({ id: 1, slug: "kakeibo", title: "家計簿" }, BASE_URL), ephemeral: true },
    },
  ]);
  assert.ok(calls[0]?.method === "reply");
  assert.ok(calls[0].message.text.includes(`${BASE_URL}/p/kakeibo/`));
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

  const calls = await run(await confirmButton(run, 1, "削除する"));

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
  assert.equal(logs.length, 1);

  assert.deepEqual(await run(press("proj:del:1")), [
    { method: "deferUpdate" },
    { method: "update", message: { text: STALE_TEXT, components: [] } },
  ]);
  assert.deepEqual(await run(press("proj:del:99")), [
    { method: "deferUpdate" },
    { method: "update", message: { text: STALE_TEXT, components: [] } },
  ]);
  assert.equal(logs.length, 1);
});

test("[削除する]: シェルが有効なら、ディレクトリはターンのキューのセッションのジョブ（key は掃除と同じ maintenance）の中で消す。実行中のセッションのターンが終わるまで消さない（結果は先に出す）", async (t) => {
  const { projects, projectsDir, turnQueue, queued, add, component } = setup(t, { publicBaseUrl: BASE_URL, shell: true });
  add("kakeibo", "家計簿");
  // 実行中のセッションのターン（Bash が動いている）
  let finishTurn = (): void => {};
  const turn = turnQueue.run("topic-1", () => new Promise<void>((resolve) => (finishTurn = resolve)), { session: true });

  const responder = new FakeResponder();
  const pressed = component.handle(press("proj:del:1"), responder);
  // 結果はキューを待たずに出し、ページはここで開けなくなる
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(responder.calls, [
    { method: "deferUpdate" },
    { method: "update", message: { text: "削除しました: 家計簿", components: [] } },
  ]);
  assert.equal(projects.getBySlug("kakeibo"), undefined);
  assert.ok(existsSync(join(projectsDir, "kakeibo", "site", "index.html")));

  finishTurn();
  await turn;
  await pressed;
  assert.equal(existsSync(join(projectsDir, "kakeibo")), false);
  assert.deepEqual(queued, [{ key: MAINTENANCE_QUEUE_KEY, session: true }]);
});

test("[削除する]: シェルが無効なら、キューに入れずにその場で消してから結果を出す", async (t) => {
  const { projectsDir, turnQueue, queued, add, component } = setup(t);
  add("kakeibo", "家計簿");
  // 実行中のセッションのターンがあっても待たない
  let finishTurn = (): void => {};
  const turn = turnQueue.run("topic-1", () => new Promise<void>((resolve) => (finishTurn = resolve)), { session: true });
  queued.length = 0;

  const responder = new FakeResponder();
  await component.handle(press("proj:del:1"), responder);
  assert.equal(existsSync(join(projectsDir, "kakeibo")), false);
  assert.deepEqual(responder.calls.at(-1), { method: "update", message: { text: "削除しました: 家計簿", components: [] } });
  assert.deepEqual(queued, []);
  finishTurn();
  await turn;
});

test("[やめる]: 何も消さず「やめました」にしてボタンを外す", async (t) => {
  const { projects, projectsDir, add, run, logs } = setup(t);
  add("kakeibo", "家計簿");

  assert.deepEqual(await run(await confirmButton(run, 1, "やめる")), [
    { method: "update", message: { text: PROJECT_KEPT_TEXT, components: [] } },
  ]);
  assert.ok(existsSync(join(projectsDir, "kakeibo", "site", "index.html")));
  assert.equal(projects.get(1)?.deletedAt, null);
  assert.deepEqual(logs, []);
});
test("[削除する]: ディレクトリを消せない・消してはいけない（projects の外や別のプロジェクトを指す symlink・projects そのものが symlink・消すのに失敗）ときは残して log に出し、DB は削除済みにする", async (t) => {
  const cases: Array<{
    label: string;
    /** 消すプロジェクトを用意し、その id と、残っているべきファイルを返す */
    arrange: (env: ReturnType<typeof setup>) => { id: number; title: string; kept: string };
  }> = [
    {
      label: "projects の外への symlink",
      arrange: ({ dir, projects, projectsDir }) => {
        const outside = join(dir, "outside");
        mkdirSync(outside);
        writeFileSync(join(outside, "keep.txt"), "keep");
        const linked = projects.create({ guildId: "guild-1", channelId: "ch-linked", name: "linked", title: "外へのリンク" });
        symlinkSync(outside, join(projectsDir, linked.slug));
        return { id: linked.id, title: linked.title, kept: join(outside, "keep.txt") };
      },
    },
    {
      label: "別のプロジェクトへの symlink",
      arrange: ({ projects, projectsDir, add }) => {
        add("todo", "やること");
        const sibling = projects.create({ guildId: "guild-1", channelId: "ch-sibling", name: "linked", title: "隣へのリンク" });
        symlinkSync(join(projectsDir, "todo"), join(projectsDir, sibling.slug));
        return { id: sibling.id, title: sibling.title, kept: join(projectsDir, "todo", "site", "index.html") };
      },
    },
    {
      label: "projects そのものが外への symlink",
      arrange: ({ dir, projectsDir, add }) => {
        const project = add("linked", "家計簿");
        const moved = join(dir, "elsewhere");
        renameSync(projectsDir, moved);
        symlinkSync(moved, projectsDir);
        return { id: project.id, title: project.title, kept: join(moved, project.slug, "site", "index.html") };
      },
    },
    {
      label: "消すのに失敗",
      arrange: ({ projectsDir, add }) => {
        const project = add("linked", "家計簿");
        // projects に書けないと linked 自体を消せない（setup の後始末で戻す）
        chmodSync(projectsDir, 0o555);
        return { id: project.id, title: project.title, kept: join(projectsDir, "linked") };
      },
    },
  ];

  for (const { label, arrange } of cases) {
    const env = setup(t);
    const { id, title, kept } = arrange(env);

    const calls = await env.run(press(`proj:del:${id}`));

    chmodSync(env.projectsDir, 0o755);
    assert.deepEqual(calls.at(-1), { method: "update", message: { text: `削除しました: ${title}`, components: [] } }, label);
    assert.ok(existsSync(kept), label);
    assert.notEqual(env.projects.get(id)?.deletedAt, null, label);
    // 消さなかったことと、削除したことの 2 行。slug・パスは出さない
    assert.equal(env.logs.length, 2, label);
    for (const line of env.logs) assert.ok(!line.includes("linked") && !line.includes(env.dir), `${label}: ${line}`);
  }
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
