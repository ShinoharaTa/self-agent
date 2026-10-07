import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { request, type IncomingHttpHeaders } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createStaticServer, type StaticServer } from "../src/serve/static-server.ts";
import { openDb } from "../src/store/db.ts";
import { ProjectStore } from "../src/store/projects.ts";

const NOW = new Date("2026-10-07T00:12:00Z");
const HOST = "127.0.0.1";
const INDEX_HTML = "<!doctype html><title>家計簿</title>";

type Response = { status: number; headers: IncomingHttpHeaders; body: string };

/** path はそのまま送る（`..` や `%2e%2e` を畳まない） */
function fetchRaw(
  server: StaticServer,
  path: string,
  options: { method?: string; headers?: Record<string, string> } = {},
): Promise<Response> {
  return new Promise((resolve, reject) => {
    const req = request(
      { host: HOST, port: server.address()!.port, path, method: options.method ?? "GET", headers: options.headers },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () =>
          resolve({ status: res.statusCode!, headers: res.headers, body: Buffer.concat(chunks).toString("utf8") }),
        );
        res.on("error", reject);
      },
    );
    req.on("error", reject);
    req.end();
  });
}

function write(path: string, content: string): void {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, content);
}

/**
 * 一時ディレクトリと一時 SQLite に、プロジェクトを 2 つ（kakeibo と、削除済みの old）作る。
 * kakeibo の site には index.html・sub/index.html・ドットファイル・site の外を指す symlink などを置く
 */
async function setup(t: TestContext, allowedLogin?: string) {
  const dir = mkdtempSync(join(tmpdir(), "self-agent-test-"));
  const db = openDb(join(dir, "self-agent.db"));
  const projectsDir = join(dir, "projects");
  const projects = new ProjectStore(db, () => NOW);
  const kakeibo = projects.create({ guildId: "guild-1", channelId: "topic-1", name: "kakeibo", title: `<b>家計簿</b> & "メモ"` });
  const old = projects.create({ guildId: "guild-1", channelId: "topic-2", name: "old", title: "古いページ" });
  projects.markDeleted(old.id);

  const site = join(projectsDir, kakeibo.slug, "site");
  write(join(site, "index.html"), INDEX_HTML);
  write(join(site, "app.js"), "console.log(1);");
  write(join(site, "sub", "index.html"), "<p>sub</p>");
  write(join(site, "hello.txt"), "hello");
  write(join(site, ".env"), "SECRET=1");
  write(join(site, ".hidden", "a.txt"), "hidden");
  write(join(site, "empty.txt"), "");
  // site の外（プロジェクトのソース）
  write(join(projectsDir, kakeibo.slug, "secret.txt"), "secret");
  symlinkSync(join(projectsDir, kakeibo.slug, "secret.txt"), join(site, "link.txt"));
  symlinkSync(join(projectsDir, kakeibo.slug), join(site, "outside"));
  // site の中を指す symlink は配る
  symlinkSync(join(site, "hello.txt"), join(site, "alias.txt"));
  write(join(projectsDir, old.slug, "site", "index.html"), "old");

  const logs: string[] = [];
  const server = createStaticServer({
    host: HOST,
    port: 0,
    projectsDir,
    projects,
    allowedLogin,
    timeZone: "Asia/Tokyo",
    log: (line) => logs.push(line),
  });
  await server.start();
  t.after(async () => {
    await server.close();
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });
  return { server, site, logs, projects, projectsDir };
}

test("site のファイルを拡張子の Content-Type と共通のヘッダで返す。CSP は付けない", async (t) => {
  const { server } = await setup(t);

  const res = await fetchRaw(server, "/p/kakeibo/app.js");

  assert.equal(res.status, 200);
  assert.equal(res.body, "console.log(1);");
  assert.equal(res.headers["content-type"], "text/javascript; charset=utf-8");
  assert.equal(res.headers["content-length"], String(Buffer.byteLength("console.log(1);")));
  assert.equal(res.headers["x-content-type-options"], "nosniff");
  assert.equal(res.headers["referrer-policy"], "no-referrer");
  assert.equal(res.headers["cache-control"], "no-cache");
  assert.equal(res.headers["content-security-policy"], undefined);
});

test("Content-Type は拡張子から決める（大文字も同じ）。知らない拡張子は application/octet-stream", async (t) => {
  const { server, site } = await setup(t);
  const expected: Record<string, string> = {
    html: "text/html; charset=utf-8",
    css: "text/css; charset=utf-8",
    js: "text/javascript; charset=utf-8",
    mjs: "text/javascript; charset=utf-8",
    json: "application/json",
    svg: "image/svg+xml",
    png: "image/png",
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    gif: "image/gif",
    webp: "image/webp",
    ico: "image/x-icon",
    txt: "text/plain; charset=utf-8",
    map: "application/json",
    wasm: "application/wasm",
    woff: "font/woff",
    woff2: "font/woff2",
    PNG: "image/png",
    bin: "application/octet-stream",
  };
  for (const ext of Object.keys(expected)) write(join(site, "types", `file.${ext}`), "x");

  for (const [ext, type] of Object.entries(expected)) {
    const res = await fetchRaw(server, `/p/kakeibo/types/file.${ext}`);
    assert.equal(res.status, 200, ext);
    assert.equal(res.headers["content-type"], type, ext);
  }
  write(join(site, "types", "README"), "x");
  const noExt = await fetchRaw(server, "/p/kakeibo/types/README");
  assert.equal(noExt.status, 200);
  assert.equal(noExt.headers["content-type"], "application/octet-stream");
});

test("ディレクトリなら index.html を返す。パスはデコードしてから探す。空のファイルも返す", async (t) => {
  const { server, site } = await setup(t);
  write(join(site, "my page", "index.html"), "<p>space</p>");

  const top = await fetchRaw(server, "/p/kakeibo/");
  assert.equal(top.status, 200);
  assert.equal(top.body, INDEX_HTML);
  assert.equal(top.headers["content-type"], "text/html; charset=utf-8");

  const sub = await fetchRaw(server, "/p/kakeibo/sub/");
  assert.equal(sub.status, 200);
  assert.equal(sub.body, "<p>sub</p>");

  const encoded = await fetchRaw(server, "/p/kakeibo/my%20page/");
  assert.equal(encoded.status, 200);
  assert.equal(encoded.body, "<p>space</p>");

  const query = await fetchRaw(server, "/p/kakeibo/hello.txt?v=2");
  assert.equal(query.status, 200);
  assert.equal(query.body, "hello");

  const empty = await fetchRaw(server, "/p/kakeibo/empty.txt");
  assert.equal(empty.status, 200);
  assert.equal(empty.headers["content-length"], "0");
  assert.equal(empty.body, "");

  // site の中を指す symlink
  const alias = await fetchRaw(server, "/p/kakeibo/alias.txt");
  assert.equal(alias.status, 200);
  assert.equal(alias.body, "hello");
});

test("末尾 / なしのディレクトリは <そのパス>/ へ 301（クエリ・エンコードは保つ）。index.html の無いディレクトリ・site の外のディレクトリは 404", async (t) => {
  const { server, site } = await setup(t);
  write(join(site, "my page", "index.html"), "<p>space</p>");
  write(join(site, "a", "b", "index.html"), "<p>b</p>");
  mkdirSync(join(site, "noindex"));

  for (const [path, location] of [
    ["/p/kakeibo/sub", "/p/kakeibo/sub/"],
    ["/p/kakeibo/sub?x=1&y=2", "/p/kakeibo/sub/?x=1&y=2"],
    ["/p/kakeibo/my%20page", "/p/kakeibo/my%20page/"],
    ["/p/kakeibo/a/b", "/p/kakeibo/a/b/"],
    ["/p/kakeibo/noindex", "/p/kakeibo/noindex/"],
  ] as const) {
    const res = await fetchRaw(server, path);
    assert.equal(res.status, 301, path);
    assert.equal(res.headers.location, location, path);
  }
  const head = await fetchRaw(server, "/p/kakeibo/sub", { method: "HEAD" });
  assert.equal(head.status, 301);
  assert.equal(head.headers.location, "/p/kakeibo/sub/");

  const nested = await fetchRaw(server, "/p/kakeibo/a/b/");
  assert.equal(nested.status, 200);
  assert.equal(nested.body, "<p>b</p>");
  for (const path of ["/p/kakeibo/noindex/", "/p/kakeibo/outside", "/p/kakeibo/outside/"]) {
    const res = await fetchRaw(server, path);
    assert.equal(res.status, 404, path);
  }
});

test("/p/<slug> は /p/<slug>/ へ 301（クエリは保つ）", async (t) => {
  const { server } = await setup(t);

  const plain = await fetchRaw(server, "/p/kakeibo");
  assert.equal(plain.status, 301);
  assert.equal(plain.headers.location, "/p/kakeibo/");

  const withQuery = await fetchRaw(server, "/p/kakeibo?a=1&b=2");
  assert.equal(withQuery.status, 301);
  assert.equal(withQuery.headers.location, "/p/kakeibo/?a=1&b=2");
});

test("GET / HEAD 以外は 405（Allow: GET, HEAD）", async (t) => {
  const { server } = await setup(t);

  for (const [method, path] of [
    ["POST", "/p/kakeibo/"],
    ["PUT", "/p/kakeibo/hello.txt"],
    ["DELETE", "/"],
    ["OPTIONS", "/p/nope/"],
  ] as const) {
    const res = await fetchRaw(server, path, { method });
    assert.equal(res.status, 405, `${method} ${path}`);
    assert.equal(res.headers.allow, "GET, HEAD", `${method} ${path}`);
  }
});

test("..・%2e%2e・ドットファイル・NUL・デコードできないパス・site の外を指す symlink・無いファイルは 404", async (t) => {
  const { server } = await setup(t);

  for (const path of [
    "/p/kakeibo/../secret.txt",
    "/p/kakeibo/%2e%2e/secret.txt",
    "/p/kakeibo/%2E%2E/secret.txt",
    "/p/kakeibo/%2e%2e%2fsecret.txt",
    "/p/kakeibo/sub/../../secret.txt",
    "/p/kakeibo/sub/..",
    "/p/kakeibo/sub/%2e%2e/hello.txt",
    "/p/kakeibo/%2e%2e",
    "/p/kakeibo/..hidden.js",
    "/p/kakeibo/.env",
    "/p/kakeibo/%2eenv",
    "/p/kakeibo/.hidden/a.txt",
    "/p/kakeibo/./hello.txt",
    "/p/kakeibo/hello.txt%00",
    "/p/kakeibo/%E0%A4%A",
    "/p/kakeibo/link.txt",
    "/p/kakeibo/outside/secret.txt",
    "/p/kakeibo/missing.html",
  ]) {
    const res = await fetchRaw(server, path);
    assert.equal(res.status, 404, path);
    assert.ok(!res.body.includes("secret"), path);
  }
});

test("site 自体が symlink なら 404（realpath が <projectsDir>/<slug>/site の外）", async (t) => {
  const { server, site, projects, projectsDir } = await setup(t);
  const linked = projects.create({ guildId: "guild-1", channelId: "topic-3", name: "linked", title: "リンク" });
  mkdirSync(join(projectsDir, linked.slug));
  symlinkSync(site, join(projectsDir, linked.slug, "site"));

  for (const path of ["/p/linked/", "/p/linked/hello.txt"]) {
    const res = await fetchRaw(server, path);
    assert.equal(res.status, 404, path);
  }
});

test("要素が .. でなければ .. を含む名前は通す（a..b.js・x..y/）", async (t) => {
  const { server, site } = await setup(t);
  write(join(site, "a..b.js"), "ab");
  write(join(site, "x..y", "index.html"), "<p>xy</p>");

  const file = await fetchRaw(server, "/p/kakeibo/a..b.js");
  assert.equal(file.status, 200);
  assert.equal(file.body, "ab");
  assert.equal(file.headers["content-type"], "text/javascript; charset=utf-8");

  const dir = await fetchRaw(server, "/p/kakeibo/x..y/");
  assert.equal(dir.status, 200);
  assert.equal(dir.body, "<p>xy</p>");
});

test("削除済みの slug・無い slug・/p/ 以外のパスは 404（ファイルがあっても）", async (t) => {
  const { server } = await setup(t);

  for (const path of ["/p/old/", "/p/old/index.html", "/p/old", "/p/nope/", "/p/nope", "/p/", "/p", "/other", "/index.html", "/p/%ZZ/"]) {
    const res = await fetchRaw(server, path);
    assert.equal(res.status, 404, path);
  }
});

test("HEAD は本文なしでヘッダ（Content-Length を含む）だけ返す", async (t) => {
  const { server } = await setup(t);

  const file = await fetchRaw(server, "/p/kakeibo/", { method: "HEAD" });
  assert.equal(file.status, 200);
  assert.equal(file.headers["content-length"], String(Buffer.byteLength(INDEX_HTML)));
  assert.equal(file.headers["content-type"], "text/html; charset=utf-8");
  assert.equal(file.body, "");

  const index = await fetchRaw(server, "/", { method: "HEAD" });
  assert.equal(index.status, 200);
  assert.ok(Number(index.headers["content-length"]) > 0);
  assert.equal(index.body, "");

  const missing = await fetchRaw(server, "/p/nope/", { method: "HEAD" });
  assert.equal(missing.status, 404);
  assert.equal(missing.body, "");
});

test("allowedLogin があれば Tailscale-User-Login が完全一致しない要求は 403、一致すれば 200", async (t) => {
  const { server } = await setup(t, "owner@example.com");

  const rejected: Array<Record<string, string>> = [
    {},
    { "Tailscale-User-Login": "other@example.com" },
    { "Tailscale-User-Login": "OWNER@example.com" },
  ];
  for (const headers of rejected) {
    for (const path of ["/p/kakeibo/", "/"]) {
      const res = await fetchRaw(server, path, { headers });
      assert.equal(res.status, 403, `${JSON.stringify(headers)} ${path}`);
      assert.equal(res.headers["x-content-type-options"], "nosniff");
    }
  }
  const post = await fetchRaw(server, "/p/kakeibo/", { method: "POST" });
  assert.equal(post.status, 403);

  const ok = await fetchRaw(server, "/p/kakeibo/", { headers: { "Tailscale-User-Login": "owner@example.com" } });
  assert.equal(ok.status, 200);
  assert.equal(ok.body, INDEX_HTML);
  const list = await fetchRaw(server, "/", { headers: { "Tailscale-User-Login": "owner@example.com" } });
  assert.equal(list.status, 200);
});

test("/ は削除されていないプロジェクトの一覧（題名は HTML エスケープ・更新日時・/p/<slug>/ へのリンク・viewport）", async (t) => {
  const { server } = await setup(t);

  const res = await fetchRaw(server, "/?from=home");

  assert.equal(res.status, 200);
  assert.equal(res.headers["content-type"], "text/html; charset=utf-8");
  assert.equal(res.headers["x-content-type-options"], "nosniff");
  assert.equal(res.headers["content-length"], String(Buffer.byteLength(res.body)));
  assert.ok(res.body.includes('<meta name="viewport" content="width=device-width, initial-scale=1">'));
  assert.ok(res.body.includes('<a href="/p/kakeibo/">&lt;b&gt;家計簿&lt;/b&gt; &amp; &quot;メモ&quot;</a>'));
  assert.ok(!res.body.includes("<b>家計簿</b>"));
  // 2026-10-07T00:12:00Z は Asia/Tokyo で 09:12
  assert.ok(res.body.includes("2026-10-07 09:12"));
  assert.ok(!res.body.includes("古いページ"));
  assert.ok(!res.body.includes("/p/old/"));
});

test("プロジェクトが無ければ一覧に「まだありません」", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "self-agent-test-"));
  const db = openDb(join(dir, "self-agent.db"));
  const server = createStaticServer({
    host: HOST,
    port: 0,
    projectsDir: join(dir, "projects"),
    projects: new ProjectStore(db, () => NOW),
    timeZone: "Asia/Tokyo",
    log: () => {},
  });
  await server.start();
  t.after(async () => {
    await server.close();
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const res = await fetchRaw(server, "/");

  assert.equal(res.status, 200);
  assert.ok(res.body.includes("まだありません"));
});

test("start で待ち受け、close で止める。ポートが使われていれば start は reject し listening() は false のまま", async (t) => {
  const { server, logs } = await setup(t);
  assert.equal(server.listening(), true);

  const projects = { getBySlug: () => undefined, list: () => [] };
  const second = createStaticServer({
    host: HOST,
    port: server.address()!.port,
    projectsDir: "/nonexistent",
    projects,
    timeZone: "Asia/Tokyo",
    log: () => {},
  });
  await assert.rejects(second.start(), { code: "EADDRINUSE" });
  assert.equal(second.listening(), false);
  assert.equal(second.address(), undefined);
  // 待ち受けていないサーバーの close は何もしない
  await second.close();

  await server.close();
  assert.equal(server.listening(), false);
  assert.equal(server.address(), undefined);
  // 2 回目の close も reject しない
  await server.close();
  assert.deepEqual(logs, []);
});
