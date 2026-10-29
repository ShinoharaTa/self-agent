import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type CliDeps, DEV_VERSION, packageVersion, runCli, type SubcommandName } from "../src/cli.ts";
import { ENV_FILE_VAR, envFilePath, loadEnv } from "../src/cli/env.ts";
import { tempDir } from "./helpers/db.ts";

const SUBCOMMANDS: SubcommandName[] = [
  "start",
  "devlog",
  "usage",
  "guest-setup",
  "github-dry-run",
  "shell-check",
  "job-dry-run",
  "measure",
];

/** 出力・env・本体の呼び出しを記録する偽物 */
function fakes(overrides: Partial<CliDeps> = {}) {
  const calls: string[] = [];
  const out: string[] = [];
  const err: string[] = [];
  const runs: Array<{ name: SubcommandName; argv: readonly string[] }> = [];
  const deps: CliDeps = {
    out: (text) => out.push(text),
    err: (text) => err.push(text),
    loadEnv: () => {
      calls.push("env");
      return "loaded";
    },
    run: async (name, argv) => {
      calls.push("run");
      runs.push({ name, argv });
      return 7;
    },
    version: () => "9.9.9",
    ...overrides,
  };
  return { deps, calls, out, err, runs };
}

test("runCli: サブコマンドが無い・知らない名前は使い方を標準エラーに出して 2（env も本体も動かさない）。setup・service はまだ無い", async () => {
  for (const argv of [[], ["nope"], ["setup"], ["service", "install"], ["-h"], ["START"]]) {
    const f = fakes();
    assert.equal(await runCli(argv, f.deps), 2, argv.join(" "));
    assert.deepEqual(f.out, [], argv.join(" "));
    assert.match(f.err.join("\n"), /使い方: self-agent <サブコマンド>/, argv.join(" "));
    assert.deepEqual(f.calls, [], argv.join(" "));
  }
});

test("runCli: start は引数があれば（--help を含む）使い方を標準エラーに出して 2 で、env も本体も動かさない", async () => {
  for (const argv of [["start", "--help"], ["start", "x"]]) {
    const f = fakes();
    assert.equal(await runCli(argv, f.deps), 2, argv.join(" "));
    assert.deepEqual(f.out, [], argv.join(" "));
    assert.equal(f.err[0], "start は引数を取りません", argv.join(" "));
    assert.match(f.err.join("\n"), /使い方: self-agent <サブコマンド>/, argv.join(" "));
    assert.deepEqual(f.calls, [], argv.join(" "));
  }
});

test("runCli: --help は使い方（8 つのサブコマンド。setup・service は出さない）を標準出力に出して 0、--version は版を出して 0", async () => {
  const help = fakes();
  assert.equal(await runCli(["--help"], help.deps), 0);
  assert.deepEqual(help.err, []);
  assert.deepEqual(help.calls, []);
  const text = help.out.join("\n");
  for (const name of SUBCOMMANDS) assert.match(text, new RegExp(`^  ${name} `, "m"), name);
  assert.doesNotMatch(text, /^ {2}(setup|service) /m);

  const version = fakes();
  assert.equal(await runCli(["--version"], version.deps), 0);
  assert.deepEqual(version.out, ["9.9.9"]);
  assert.deepEqual(version.calls, []);
});

test("runCli: サブコマンドは env ファイルを読んでから本体に残りの引数を渡し、その結果を返す", async () => {
  for (const name of SUBCOMMANDS) {
    const argv = name === "start" ? [] : ["--last", "1"];
    const f = fakes();
    assert.equal(await runCli([name, ...argv], f.deps), 7, name);
    assert.deepEqual(f.calls, ["env", "run"], name);
    assert.deepEqual(f.runs, [{ name, argv }], name);
  }
  // start は本体が自分で終わる（undefined）
  const start = fakes({ run: async () => undefined });
  assert.equal(await runCli(["start"], start.deps), undefined);
  // env ファイルが無いのはよい
  const missing = fakes({ loadEnv: () => "missing" });
  assert.equal(await runCli(["devlog"], missing.deps), 7);
});

test("runCli: env ファイルを読めなければ（無いのを除く）パスを出さずに 1 で、本体は動かさない", async () => {
  const f = fakes({ loadEnv: () => "failed" });
  assert.equal(await runCli(["start"], f.deps), 1);
  assert.deepEqual(f.err, ["env ファイルを読めませんでした"]);
  assert.deepEqual(f.runs, []);
});

test("packageVersion: package.json の version、無い・空・読めなければ 0.0.0-dev。既定はパッケージの直下の package.json", (t) => {
  const dir = tempDir(t);
  const path = join(dir, "package.json");
  writeFileSync(path, JSON.stringify({ name: "self-agent", version: "1.2.3" }));
  assert.equal(packageVersion(path), "1.2.3");
  writeFileSync(path, JSON.stringify({ name: "self-agent" }));
  assert.equal(packageVersion(path), DEV_VERSION);
  writeFileSync(path, JSON.stringify({ name: "self-agent", version: "" }));
  assert.equal(packageVersion(path), DEV_VERSION);
  assert.equal(packageVersion(join(dir, "missing.json")), DEV_VERSION);
  assert.equal(DEV_VERSION, "0.0.0-dev");

  const real = packageVersion();
  assert.ok(real === DEV_VERSION || /^\d+\.\d+\.\d+/.test(real));
});

test("envFilePath: SELF_AGENT_ENV_FILE があればそれ（空は無いものとする）、無ければ ~/.config/self-agent/env", () => {
  assert.equal(envFilePath({}, "/home/x"), "/home/x/.config/self-agent/env");
  assert.equal(envFilePath({ [ENV_FILE_VAR]: "" }, "/home/x"), "/home/x/.config/self-agent/env");
  assert.equal(envFilePath({ [ENV_FILE_VAR]: "/srv/env" }, "/home/x"), "/srv/env");
});

test("loadEnv: 無いファイルでは何もせず missing、既にある変数は上書きしない、SELF_AGENT_ENV_FILE の場所を読む、読めなければ failed", (t) => {
  const dir = tempDir(t);
  const keys = ["SELF_AGENT_CLI_TEST_PRESET", "SELF_AGENT_CLI_TEST_NEW"];
  t.after(() => {
    for (const key of keys) delete process.env[key];
  });
  const before = { ...process.env };
  assert.equal(loadEnv(join(dir, "missing")), "missing");
  assert.deepEqual({ ...process.env }, before);

  const path = join(dir, "custom-env");
  writeFileSync(path, "SELF_AGENT_CLI_TEST_PRESET=from-file\nSELF_AGENT_CLI_TEST_NEW=from-file\n");
  process.env.SELF_AGENT_CLI_TEST_PRESET = "preset";
  assert.equal(loadEnv(envFilePath({ [ENV_FILE_VAR]: path }, join(dir, "home"))), "loaded");
  assert.equal(process.env.SELF_AGENT_CLI_TEST_PRESET, "preset");
  assert.equal(process.env.SELF_AGENT_CLI_TEST_NEW, "from-file");

  // ディレクトリ（EISDIR）・注入した読み手の ENOENT 以外の例外は failed
  const notFile = join(dir, "dir");
  mkdirSync(notFile);
  assert.equal(loadEnv(notFile), "failed");
  const denied = Object.assign(new Error("denied"), { code: "EACCES" });
  assert.equal(loadEnv("/x", () => {
    throw denied;
  }), "failed");
  const seen: string[] = [];
  assert.equal(loadEnv("/y", (p) => void seen.push(p)), "loaded");
  assert.deepEqual(seen, ["/y"]);
});
