import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSdkMcpServer } from "@anthropic-ai/claude-agent-sdk";
import { buildQueryOptions, childEnv } from "../src/agent/query-options.ts";

const cfg = { model: "claude-opus-5", workDir: "/srv/work", claudeConfigDir: "/srv/claude", effort: undefined };
const mcpServer = createSdkMcpServer({ name: "selfagent", version: "0.1.0", tools: [] });

test("毎回同じ Options を返す（キャッシュのため）", () => {
  assert.deepEqual(buildQueryOptions(cfg, mcpServer), buildQueryOptions(cfg, mcpServer));
});

test("システムプロンプトに日付や年を含めない", () => {
  const { systemPrompt } = buildQueryOptions(cfg, mcpServer);
  assert.equal(typeof systemPrompt, "string");
  assert.doesNotMatch(String(systemPrompt), /\d{4}|\d{1,2}\s*[/\-月]\s*\d{1,2}/);
});

test("システムプロンプトに改訂の要点（#inbox・<#チャンネルID>・task_list・session_open）を含める", () => {
  const { systemPrompt } = buildQueryOptions(cfg, mcpServer);
  for (const word of ["#inbox", "<#", "task_list", "session_open"]) {
    assert.ok(String(systemPrompt).includes(word), word);
  }
});

test("システムプロンプトに作ってと頼まれたときの行（project_open・コードを貼らない・#inbox では session_open）を含める", () => {
  const { systemPrompt } = buildQueryOptions(cfg, mcpServer);
  assert.ok(
    String(systemPrompt).includes(
      "- 何かを作ってと頼まれたら、コードを返事に貼らない。セッションのチャンネルで project_open を使い、ファイルを書いて動く状態にしてから、URL と使い方を 3〜5 行で伝える。#inbox で頼まれたら session_open で専用のチャンネルを作る。コードは聞かれたときだけ短く見せる。",
    ),
  );
});

test("システムプロンプトに WebSearch と WebFetch の使い方を含める", () => {
  const { systemPrompt } = buildQueryOptions(cfg, mcpServer);
  for (const word of ["WebSearch", "WebFetch"]) {
    assert.ok(String(systemPrompt).includes(word), word);
  }
});

test("組み込みツールは Web の 2 つとファイル操作の 5 つ（この順で固定）。設定ファイルは使わず、自前ツール・Web の 2 つと projects の下の読み書きだけを許可する", () => {
  const options = buildQueryOptions(cfg, mcpServer);
  assert.deepEqual(options.tools, ["WebSearch", "WebFetch", "Read", "Write", "Edit", "Glob", "Grep"]);
  assert.equal(options.permissionMode, "dontAsk");
  assert.deepEqual(options.settingSources, []);
  // 素の Read・Write・Bash は許可しない。Edit のルールは Write にも、Read のルールは Glob・Grep にも効く
  assert.deepEqual(options.allowedTools, [
    "mcp__selfagent__*",
    "WebSearch",
    "WebFetch",
    "Read(//srv/work/projects/**)",
    "Edit(//srv/work/projects/**)",
  ]);
  assert.equal(options.mcpServers?.selfagent, mcpServer);
  assert.equal(options.strictMcpConfig, true);
  assert.equal(options.model, "claude-opus-5");
  assert.equal(options.cwd, "/srv/work");
  // maxTurns・hooks・resume は run ごとに sdk-runner が足す
  assert.equal("maxTurns" in options, false);
  assert.equal(options.resume, undefined);
});

test("allowedTools の projects のルールは workDir の実際の場所（symlink を解いたもの）で書く", (t) => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "self-agent-test-")));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, "real-work"));
  symlinkSync(join(root, "real-work"), join(root, "work"));

  const { allowedTools, cwd } = buildQueryOptions({ ...cfg, workDir: join(root, "work") }, mcpServer);

  const rule = `//${join(root, "real-work", "projects").slice(1)}/**`;
  assert.deepEqual(allowedTools?.slice(3), [`Read(${rule})`, `Edit(${rule})`]);
  assert.equal(cwd, join(root, "work"));
});

test("env に設定ディレクトリと自動メモリ無効を入れる", () => {
  const { env } = buildQueryOptions(cfg, mcpServer);
  assert.equal(env?.CLAUDE_CONFIG_DIR, "/srv/claude");
  assert.equal(env?.CLAUDE_CODE_DISABLE_AUTO_MEMORY, "1");
});

/** 許可した変数（大文字・小文字の proxy を含む）と CLAUDE_CONFIG_DIR・CLAUDE_CODE_DISABLE_AUTO_MEMORY */
const PASSED_KEYS = [
  "PATH",
  "HOME",
  "USER",
  "LANG",
  "LC_ALL",
  "TZ",
  "TMPDIR",
  "NODE_EXTRA_CA_CERTS",
  "HTTPS_PROXY",
  "HTTP_PROXY",
  "NO_PROXY",
  "https_proxy",
  "http_proxy",
  "no_proxy",
  "CLAUDE_CODE_OAUTH_TOKEN",
  "CLAUDE_CONFIG_DIR",
  "CLAUDE_CODE_DISABLE_AUTO_MEMORY",
];

test("childEnv: 許可した変数だけを写し、設定ディレクトリと自動メモリ無効を足す。無い変数は入れない", () => {
  const source = {
    PATH: "/usr/bin",
    HOME: "/home/tester",
    LANG: "ja_JP.UTF-8",
    HTTPS_PROXY: "http://proxy:8080",
    no_proxy: "localhost",
    CLAUDE_CODE_OAUTH_TOKEN: "dummy-oauth-token",
    // 元の値は使わず、引数で上書きする
    CLAUDE_CONFIG_DIR: "/elsewhere",
    DISCORD_TOKEN: "dummy-discord-token",
    SOME_SECRET: "dummy-secret",
    SELF_AGENT_OWNER_ID: "100",
    NODE_OPTIONS: "--inspect",
  };
  assert.deepEqual(childEnv("/srv/claude", source), {
    PATH: "/usr/bin",
    HOME: "/home/tester",
    LANG: "ja_JP.UTF-8",
    HTTPS_PROXY: "http://proxy:8080",
    no_proxy: "localhost",
    CLAUDE_CODE_OAUTH_TOKEN: "dummy-oauth-token",
    CLAUDE_CONFIG_DIR: "/srv/claude",
    CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1",
  });
  assert.deepEqual(Object.keys(childEnv("/srv/claude", {})).sort(), ["CLAUDE_CODE_DISABLE_AUTO_MEMORY", "CLAUDE_CONFIG_DIR"]);
});

test("env には許可リスト外の変数（DISCORD_TOKEN や未知の変数）を渡さない", () => {
  const saved = { DISCORD_TOKEN: process.env.DISCORD_TOKEN, SOME_SECRET: process.env.SOME_SECRET };
  process.env.DISCORD_TOKEN = "dummy-discord-token";
  process.env.SOME_SECRET = "dummy-secret";
  try {
    const { env } = buildQueryOptions(cfg, mcpServer);
    assert.ok(env !== undefined);
    for (const key of Object.keys(env)) {
      assert.ok(PASSED_KEYS.includes(key), key);
    }
    assert.equal(env.DISCORD_TOKEN, undefined);
    assert.equal(env.SOME_SECRET, undefined);
    assert.ok(!JSON.stringify(env).includes("dummy-discord-token"));
    assert.ok(!JSON.stringify(env).includes("dummy-secret"));
    assert.equal(env.PATH, process.env.PATH);
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test("effort は設定したときだけ Options に入る", () => {
  assert.equal("effort" in buildQueryOptions(cfg, mcpServer), false);
  assert.equal(buildQueryOptions({ ...cfg, effort: "medium" }, mcpServer).effort, "medium");
});
