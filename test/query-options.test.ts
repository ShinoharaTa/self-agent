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

test("システムプロンプトに、作ってと頼まれたときの行の直後に仕様の検討・見直しを頼まれたときの行（作り始めずに案を出す・頼まれていない機能は候補として 1 行）を含める", () => {
  const { systemPrompt } = buildQueryOptions(cfg, mcpServer);
  assert.ok(
    String(systemPrompt).includes(
      "コードは聞かれたときだけ短く見せる。\n- 仕様の検討や見直しを頼まれたら、作り始めずに案を短く出し、確認してから作る。頼まれていない機能は足さず、候補として 1 行で挙げる。\n",
    ),
  );
});

test("システムプロンプトにスマートフォン前提の行（PC は使えない・表と見出しを使わない・手順を案内せず project_open の URL で渡す）を含める", () => {
  const { systemPrompt } = buildQueryOptions(cfg, mcpServer);
  assert.ok(
    String(systemPrompt).includes(
      "- オーナーはスマートフォンの Discord から使い、PC は使えない。表と見出し（# で始まる行）は使わない。箇条書きは可。ファイルを保存して開く・コマンドを打つといった手順は案内せず、動くものは project_open で作って URL で渡す。",
    ),
  );
});

test("システムプロンプトにアプリの説明（チャンネル・セッション・全コマンド・パネル・無いことは分からないと答える）を含める", () => {
  const { systemPrompt } = buildQueryOptions(cfg, mcpServer);
  const prompt = String(systemPrompt);
  assert.ok(prompt.includes("このアプリについて（使い方を聞かれたら、この範囲で答える）:"));
  for (const word of [
    "- #tasks: タスクの話だけをする場所（登録・一覧・期限や題名の変更・完了・やめる・今日やることの相談）。#system: 完了から日数が経ったセッションを削除するかの確認。",
    "「進行中」「待ち」「完了」",
    "パネルのボタン",
    "- ここに無いことは、分からないと答える。",
  ]) {
    assert.ok(prompt.includes(word), word);
  }
  for (const command of ["new", "close", "wait", "sessions", "tasks", "projects", "usage", "help", "setup"]) {
    assert.ok(prompt.includes(`/${command}（`), command);
  }
});

test("システムプロンプトに #tasks の行（引き継ぎの文・書き分け・やることの 3 行・#tasks の節・アプリの説明）を含め、「まだ役割が無い」を含めない", () => {
  const { systemPrompt } = buildQueryOptions(cfg, mcpServer);
  const prompt = String(systemPrompt);
  for (const line of [
    "「これまでの #inbox の要約:」「これまでの #tasks の要約:」「#inbox からの続き:」",
    "- #inbox と #tasks では短く、基本 1〜3 行（タスクの一覧は 1 件 1 行）。セッションのチャンネル（ヘッダが #inbox・#tasks 以外）では、必要なだけ書いてよい。",
    "- 期限や題名を変える、やめる、終わっていなかったと言われたら task_update を使い、変えた内容を 1 行で伝える。",
    "- 今日やることを聞かれたら task_list の due_by に今日の日付を渡す。何からやるか聞かれたら 1 つだけ選び、理由を 1 行添える。",
    "- 取りかかれないと言われたら、5 分でできる最初の一歩を 1 つだけ提案する。",
    "\n#tasks では（ヘッダが #tasks）:\n" +
      "- タスクの話だけをする。タスク以外の話題（調べもの・相談・作ってほしいもの）は答えずに、#inbox か /new のセッションで話すよう 1 行で案内する。\n" +
      "- 一覧は期限切れ・今日・それ以外の順に出す。10 件を超えるときは今日までのものだけ出し、残りは件数と /tasks を案内する。\n",
    "- #tasks: タスクの話だけをする場所（登録・一覧・期限や題名の変更・完了・やめる・今日やることの相談）。",
  ]) {
    assert.ok(prompt.includes(line), line);
  }
  assert.ok(!prompt.includes("まだ役割が無い"));
  assert.ok(!prompt.includes("- #inbox では短く"));
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
