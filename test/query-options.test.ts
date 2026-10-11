import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSdkMcpServer } from "@anthropic-ai/claude-agent-sdk";
import { buildQueryOptions, childEnv } from "../src/agent/query-options.ts";
import { SYSTEM_PROMPT } from "../src/agent/system-prompt.ts";
import { createTaskTools } from "../src/agent/tools.ts";
import { type CommandDeps, createCommands } from "../src/app/interactions.ts";

const cfg = { model: "claude-opus-5", workDir: "/srv/work", claudeConfigDir: "/srv/claude", effort: undefined };
const mcpServer = createSdkMcpServer({ name: "selfagent", version: "0.1.0", tools: [] });

/** buildQueryOptions のシステムプロンプトの本文 */
function promptText(): string {
  const { systemPrompt } = buildQueryOptions(cfg, mcpServer);
  assert.ok(typeof systemPrompt === "object" && !Array.isArray(systemPrompt) && systemPrompt.type === "custom");
  return String(systemPrompt.prompt);
}

test("毎回同じ Options を返す（キャッシュのため）", () => {
  assert.deepEqual(buildQueryOptions(cfg, mcpServer), buildQueryOptions(cfg, mcpServer));
});

test("システムプロンプトは記録させずに毎回送る（snapshot: false。直したプロンプトが既存のセッションにも届く）", () => {
  assert.deepEqual(buildQueryOptions(cfg, mcpServer).systemPrompt, { type: "custom", prompt: SYSTEM_PROMPT, snapshot: false });
});

test("システムプロンプトに日付や年を含めない", () => {
  const systemPrompt = promptText();
  assert.doesNotMatch(String(systemPrompt), /\d{4}|\d{1,2}\s*[/\-月]\s*\d{1,2}/);
});

/** プロンプトの中でコマンド名・ツール名の形をしているが、名前ではない語（引数名・ツールの返り値・固有名詞） */
const NOT_A_NAME = new Set(["due_by", "not_set_up", "Discord", "Web"]);

/** プロンプトから re に当たる語（グループがあればその中身）を重複なしで取り出す */
function namesIn(prompt: string, re: RegExp): string[] {
  return [...new Set([...prompt.matchAll(re)].map((m) => m[1] ?? m[0]))].filter((name) => !NOT_A_NAME.has(name));
}

test("SYSTEM_PROMPT に出てくるコマンド名・ツール名・組み込みツール名はすべて実在する", () => {
  const commands = new Set(createCommands({} as CommandDeps).map((command) => command.def.name));
  const tools = new Set(createTaskTools({} as never, {} as never, {} as never, {} as never, {} as never).map((tool) => tool.name));
  const builtins = new Set(buildQueryOptions(cfg, mcpServer).tools as string[]);
  const cases = [
    { label: "スラッシュコマンド", re: /(?<![\w/])\/([a-z]+)/g, known: commands },
    { label: "自前のツール", re: /\b[a-z]+(?:_[a-z]+)+\b/g, known: tools },
    { label: "組み込みツール", re: /\b[A-Z][a-z]+(?:[A-Z][a-z]+)*\b/g, known: builtins },
  ];
  for (const { label, re, known } of cases) {
    const names = namesIn(SYSTEM_PROMPT, re);
    assert.ok(names.length > 0, `${label}: 抜き出せていない`);
    for (const name of names) assert.ok(known.has(name), `${label}: ${name}`);
  }
});

test("組み込みツールは Web の 2 つとファイル操作の 4 つ（この順で固定。Grep は無い）。設定ファイルは使わず、自前ツール・Web の 2 つと projects の下の読み書きだけを許可する", () => {
  const options = buildQueryOptions(cfg, mcpServer);
  assert.deepEqual(options.tools, ["WebSearch", "WebFetch", "Read", "Write", "Edit", "Glob"]);
  assert.equal(options.permissionMode, "dontAsk");
  assert.deepEqual(options.settingSources, []);
  // 素の Read・Write・Bash は許可しない。Edit のルールは Write にも、Read のルールは Glob にも効く
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

test("env には設定ディレクトリと自動メモリ無効を入れ、許可リスト外の変数（DISCORD_TOKEN や未知の変数）を渡さない", () => {
  const saved = { DISCORD_TOKEN: process.env.DISCORD_TOKEN, SOME_SECRET: process.env.SOME_SECRET };
  process.env.DISCORD_TOKEN = "dummy-discord-token";
  process.env.SOME_SECRET = "dummy-secret";
  try {
    const { env } = buildQueryOptions(cfg, mcpServer);
    assert.ok(env !== undefined);
    assert.equal(env.CLAUDE_CONFIG_DIR, "/srv/claude");
    assert.equal(env.CLAUDE_CODE_DISABLE_AUTO_MEMORY, "1");
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
