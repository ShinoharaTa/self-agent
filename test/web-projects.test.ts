import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { request } from "node:http";
import { mkdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { PROJECT_FILE_MAX_BYTES } from "../src/agent/project-listing.ts";
import { projectRoutes } from "../src/web/routes/projects.ts";
import { createWebServer, type Route, type WebServer } from "../src/web/server.ts";
import { createStores, tempDb, tempDir } from "./helpers/db.ts";

const LOGIN = "owner@example.com";
const NOW = new Date("2026-10-29T05:00:00.000Z");

type Response = { status: number; json: Record<string, unknown> };

function get(server: WebServer, path: string): Promise<Response> {
  return new Promise((resolve, reject) => {
    const req = request(
      { host: "127.0.0.1", port: server.address()!.port, method: "GET", path, headers: { "tailscale-user-login": LOGIN } },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () => resolve({ status: res.statusCode!, json: JSON.parse(Buffer.concat(chunks).toString("utf8")) }));
        res.on("error", reject);
      },
    );
    req.on("error", reject);
    req.end();
  });
}

async function serve(t: TestContext, routes: Route[]): Promise<WebServer> {
  const server = createWebServer({
    host: "127.0.0.1",
    port: 0,
    allowedLogin: LOGIN,
    staticDir: tempDir(t),
    templateSiteDir: tempDir(t),
    routes,
    stopping: () => false,
    now: () => NOW,
    log: () => undefined,
  });
  await server.start();
  t.after(() => server.close());
  return server;
}

function write(path: string, content: string | Buffer): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}

/** kakeibo（ファイルあり）・nodir（ディレクトリが無い）・削除済みの old を作る */
async function setup(t: TestContext, cfg: { publicBaseUrl: string | undefined } = { publicBaseUrl: "https://host.example/9443" }) {
  const base = realpathSync(tempDir(t));
  const projectsDir = join(base, "projects");
  const { projects } = createStores(tempDb(t), () => NOW);
  const kakeibo = projects.create({ guildId: "guild-1", channelId: "100", name: "kakeibo", title: "家計簿" });
  const nodir = projects.create({ guildId: "guild-1", channelId: "200", name: "nodir", title: "nodir" });
  const old = projects.create({ guildId: "guild-1", channelId: "300", name: "old", title: "古い" });
  projects.markDeleted(old.id);
  const dir = join(projectsDir, kakeibo.slug);
  write(join(dir, "DESIGN.md"), "# design");
  write(join(dir, "site", "index.html"), "<p>家計簿</p>");
  write(join(dir, "site", ".env"), "SECRET=1");
  write(join(dir, ".trash", "20261029T051200Z", "old.html"), "old");
  write(join(dir, "node_modules", "x.js"), "x");
  write(join(dir, "big.txt"), Buffer.alloc(PROJECT_FILE_MAX_BYTES + 1, "a"));
  write(join(dir, "image.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x00]));
  write(join(base, "secret.txt"), "SECRET");
  symlinkSync(join(base, "secret.txt"), join(dir, "site", "link.txt"));
  write(join(projectsDir, old.slug, "index.html"), "old");
  const channelName = (channelId: string): string | null => (channelId === "100" ? "家計簿のセッション" : null);
  const server = await serve(t, projectRoutes({ cfg, projects, projectsDir, channelName }));
  return { server, projects, projectsDir, dir, base, nodir };
}

test("GET /api/projects: 削除されていないプロジェクトを新しく更新した順に、チャンネルの表示名と公開 URL 付きで", async (t) => {
  const { server } = await setup(t);
  const res = await get(server, "/api/projects");
  assert.equal(res.status, 200);
  assert.deepEqual(res.json, {
    projects: [
      {
        slug: "nodir",
        title: "nodir",
        channelId: "200",
        channelTitle: null,
        updatedAt: NOW.toISOString(),
        url: "https://host.example/9443/p/nodir/",
      },
      {
        slug: "kakeibo",
        title: "家計簿",
        channelId: "100",
        channelTitle: "家計簿のセッション",
        updatedAt: NOW.toISOString(),
        url: "https://host.example/9443/p/kakeibo/",
      },
    ],
  });
});

test("GET /api/projects: 配信が無効（公開 URL が無い）でも一覧は出し、url は null", async (t) => {
  const { server } = await setup(t, { publicBaseUrl: undefined });
  const res = await get(server, "/api/projects");
  assert.equal(res.status, 200);
  const projects = res.json.projects as { url: string | null }[];
  assert.equal(projects.length, 2);
  assert.ok(projects.every((p) => p.url === null));
});

test("GET /api/projects/<slug>/files: 通常のファイルだけ（ドットで始まるもの・node_modules・symlink は出さない）", async (t) => {
  const { server } = await setup(t);
  const res = await get(server, "/api/projects/kakeibo/files");
  assert.equal(res.status, 200);
  assert.equal(res.json.truncated, false);
  assert.deepEqual(
    (res.json.files as { path: string }[]).map((f) => f.path),
    ["DESIGN.md", "big.txt", "image.png", "site/index.html"],
  );
});

test("GET /api/projects/<slug>/files: 無い slug・削除済み・ディレクトリが無い・slug が symlink・形が違う slug は 404", async (t) => {
  const { server, projects, projectsDir, base } = await setup(t);
  assert.deepEqual(await get(server, "/api/projects/missing/files"), { status: 404, json: { error: "not_found" } });
  assert.deepEqual(await get(server, "/api/projects/old/files"), { status: 404, json: { error: "not_found" } });
  assert.deepEqual(await get(server, "/api/projects/nodir/files"), { status: 404, json: { error: "not_found" } });
  const linked = projects.create({ guildId: "guild-1", channelId: "400", name: "linked", title: "linked" });
  symlinkSync(base, join(projectsDir, linked.slug));
  assert.deepEqual(await get(server, "/api/projects/linked/files"), { status: 404, json: { error: "not_found" } });
  assert.equal((await get(server, "/api/projects/..%2Fkakeibo/files")).status, 404);
  assert.equal((await get(server, "/api/projects/Kakeibo/files")).status, 404);
});

test("GET /api/projects/<slug>/file?path=: 中身を text で。失敗は 404・400・413・415", async (t) => {
  const { server } = await setup(t);
  assert.deepEqual(await get(server, "/api/projects/kakeibo/file?path=site%2Findex.html"), {
    status: 200,
    json: { path: "site/index.html", text: "<p>家計簿</p>" },
  });
  assert.deepEqual(await get(server, "/api/projects/kakeibo/file?path=site/missing.html"), { status: 404, json: { error: "not_found" } });
  assert.deepEqual(await get(server, "/api/projects/kakeibo/file?path=site"), { status: 404, json: { error: "not_found" } });
  for (const path of [
    "..%2F..%2Fsecret.txt",
    "site%2F..%2F..%2F..%2Fsecret.txt",
    "%2Fetc%2Fpasswd",
    ".trash%2F20261029T051200Z%2Fold.html",
    "site%2F.env",
    "site%2Flink.txt",
    "",
  ]) {
    assert.deepEqual(await get(server, `/api/projects/kakeibo/file?path=${path}`), { status: 400, json: { error: "invalid_path" } }, path);
  }
  assert.deepEqual(await get(server, "/api/projects/kakeibo/file"), { status: 400, json: { error: "invalid_path" } });
  assert.deepEqual(await get(server, "/api/projects/kakeibo/file?path=big.txt"), { status: 413, json: { error: "too_large" } });
  assert.deepEqual(await get(server, "/api/projects/kakeibo/file?path=image.png"), { status: 415, json: { error: "binary" } });
  assert.deepEqual(await get(server, "/api/projects/old/file?path=index.html"), { status: 404, json: { error: "not_found" } });
  assert.deepEqual(await get(server, "/api/projects/nodir/file?path=index.html"), { status: 404, json: { error: "not_found" } });
});

test("GET /api/projects/<slug>/file: プロジェクトのディレクトリが消えた後は 404", async (t) => {
  const { server, dir } = await setup(t);
  rmSync(dir, { recursive: true });
  assert.deepEqual(await get(server, "/api/projects/kakeibo/file?path=DESIGN.md"), { status: 404, json: { error: "not_found" } });
  assert.deepEqual(await get(server, "/api/projects/kakeibo/files"), { status: 404, json: { error: "not_found" } });
});
