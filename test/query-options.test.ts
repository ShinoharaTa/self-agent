import { test } from "node:test";
import assert from "node:assert/strict";
import { lstatSync, mkdirSync, mkdtempSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSdkMcpServer } from "@anthropic-ai/claude-agent-sdk";
import {
  buildQueryOptions,
  childEnv,
  ensureCwdDir,
  ensureSandboxWriteDirs,
  projectDirName,
  projectDirNameFor,
  SANDBOX_ALLOWED_DOMAINS,
  SANDBOX_DENY_READ_SYSTEM,
  type SandboxHost,
  sandboxPlacesOf,
  sandboxSettings,
} from "../src/agent/query-options.ts";
import { placesOverlap, sandboxReadablePlaces, sandboxSecretPlaces, shellPath } from "../src/agent/sandbox-check.ts";
import { SHELL_SYSTEM_PROMPT, SYSTEM_PROMPT } from "../src/agent/system-prompt.ts";
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

/** プロンプトの中でコマンド名・ツール名の形をしているが、名前ではない語（引数名・ツールの返り値・固有名詞・ディレクトリ名） */
const NOT_A_NAME = new Set(["due_by", "task_id", "not_set_up", "Discord", "Web", "node_modules"]);

/** プロンプトから re に当たる語（グループがあればその中身）を重複なしで取り出す */
function namesIn(prompt: string, re: RegExp): string[] {
  return [...new Set([...prompt.matchAll(re)].map((m) => m[1] ?? m[0]))].filter((name) => !NOT_A_NAME.has(name));
}

test("SYSTEM_PROMPT（シェルが有効なら SHELL_SYSTEM_PROMPT）に出てくるコマンド名・ツール名・組み込みツール名はすべて実在する", () => {
  const commands = new Set(createCommands({} as CommandDeps).map((command) => command.def.name));
  const tools = new Set(createTaskTools({} as never, {} as never, {} as never, {} as never, {} as never, {} as never).map((tool) => tool.name));
  for (const shell of [false, true]) {
    const options = buildQueryOptions({ ...cfg, shell }, mcpServer);
    const prompt = shell ? SHELL_SYSTEM_PROMPT : SYSTEM_PROMPT;
    assert.deepEqual(options.systemPrompt, { type: "custom", prompt, snapshot: false });
    const builtins = new Set(options.tools as string[]);
    const cases = [
      { label: "スラッシュコマンド", re: /(?<![\w/])\/([a-z]+)/g, known: commands },
      { label: "自前のツール", re: /\b[a-z]+(?:_[a-z]+)+\b/g, known: tools },
      { label: "組み込みツール", re: /\b[A-Z][a-z]+(?:[A-Z][a-z]+)*\b/g, known: builtins },
    ];
    for (const { label, re, known } of cases) {
      const names = namesIn(prompt, re);
      assert.ok(names.length > 0, `${label}: 抜き出せていない`);
      for (const name of names) assert.ok(known.has(name), `shell=${shell} ${label}: ${name}`);
    }
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
  assert.equal(options.cwd, "/srv/work/cwd");
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
  assert.equal(cwd, join(root, "work", "cwd"));
});

/** 許可した変数（大文字・小文字の proxy を含む）と CLAUDE_CONFIG_DIR・CLAUDE_CODE_PROJECT_DIR_NAME・CLAUDE_CODE_DISABLE_AUTO_MEMORY */
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
  "CLAUDE_CODE_PROJECT_DIR_NAME",
  "CLAUDE_CODE_DISABLE_AUTO_MEMORY",
];

test("childEnv: 許可した変数だけを写し、設定ディレクトリ・記録のディレクトリ名・自動メモリ無効を足す。無い変数は入れない", () => {
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
  assert.deepEqual(childEnv("/srv/claude", "/srv/work", source), {
    PATH: "/usr/bin",
    HOME: "/home/tester",
    LANG: "ja_JP.UTF-8",
    HTTPS_PROXY: "http://proxy:8080",
    no_proxy: "localhost",
    CLAUDE_CODE_OAUTH_TOKEN: "dummy-oauth-token",
    CLAUDE_CONFIG_DIR: "/srv/claude",
    CLAUDE_CODE_PROJECT_DIR_NAME: projectDirName("/srv/work"),
    CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1",
  });
  assert.deepEqual(Object.keys(childEnv("/srv/claude", "/srv/work", {})).sort(), [
    "CLAUDE_CODE_DISABLE_AUTO_MEMORY",
    "CLAUDE_CODE_PROJECT_DIR_NAME",
    "CLAUDE_CONFIG_DIR",
  ]);
  // 名前にできない（65 字以上の）workDir なら入れない
  assert.equal("CLAUDE_CODE_PROJECT_DIR_NAME" in childEnv("/srv/claude", `/${"w".repeat(64)}`, {}), false);
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
    assert.equal(env.CLAUDE_CODE_PROJECT_DIR_NAME, projectDirName(cfg.workDir));
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

test("既定の Options.env には、親の env にあってもゲストの API キー（ANTHROPIC_API_KEY・SELF_AGENT_GUEST_API_KEY）とゲスト Bot のトークンを入れない（シェルの有無によらない）", (t) => {
  const { host, shellCfg } = shellSetup(t);
  const guestHost: SandboxHost = {
    ...host,
    env: {
      ...host.env,
      ANTHROPIC_API_KEY: "dummy-anthropic-key",
      SELF_AGENT_GUEST_API_KEY: "dummy-guest-api-key",
      SELF_AGENT_GUEST_DISCORD_TOKEN: "dummy-guest-discord-token",
    },
  };
  for (const options of [
    buildQueryOptions(cfg, mcpServer, false, guestHost),
    buildQueryOptions(shellCfg, mcpServer, false, guestHost),
  ]) {
    const env = options.env;
    assert.ok(env !== undefined);
    for (const key of ["ANTHROPIC_API_KEY", "SELF_AGENT_GUEST_API_KEY", "SELF_AGENT_GUEST_DISCORD_TOKEN"]) assert.equal(key in env, false, key);
    const text = JSON.stringify(env);
    for (const secret of ["dummy-anthropic-key", "dummy-guest-api-key", "dummy-guest-discord-token"]) assert.ok(!text.includes(secret), secret);
    assert.equal(env.CLAUDE_CODE_OAUTH_TOKEN, "dummy-oauth-token");
  }
  assert.equal("ANTHROPIC_API_KEY" in childEnv("/srv/claude", "/srv/work", guestHost.env), false);
});

test("effort は設定したときだけ Options に入る", () => {
  assert.equal("effort" in buildQueryOptions(cfg, mcpServer), false);
  assert.equal(buildQueryOptions({ ...cfg, effort: "medium" }, mcpServer).effort, "medium");
});

/** sandbox の場所の一時ディレクトリ。dataDir はホームの外の symlink（実際の場所で書く）、リポジトリと node はホームの外 */
function shellSetup(t: import("node:test").TestContext) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "self-agent-test-")));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const home = join(root, "home");
  const workDir = join(root, "work");
  mkdirSync(join(home, ".config", "self-agent"), { recursive: true });
  mkdirSync(join(root, "real-data"));
  symlinkSync(join(root, "real-data"), join(root, "data"));
  mkdirSync(workDir);
  const host: SandboxHost = {
    execPath: join(root, "node", "v24", "bin", "node"),
    cwd: join(root, "repo"),
    homeDir: home,
    env: {
      PATH: "/usr/bin",
      HOME: home,
      LANG: "ja_JP.UTF-8",
      TMPDIR: "/tmp/host-tmp",
      HTTPS_PROXY: "http://user:dummy-proxy-secret@proxy:8080",
      http_proxy: "http://proxy:8080",
      NO_PROXY: "localhost",
      CLAUDE_CODE_OAUTH_TOKEN: "dummy-oauth-token",
      DISCORD_TOKEN: "dummy-discord-token",
    },
  };
  const shellCfg = { ...cfg, workDir, claudeConfigDir: join(root, "claude"), dataDir: join(root, "data"), shell: true };
  return { root, home, workDir, host, shellCfg };
}

test("buildQueryOptions: SELF_AGENT_SHELL が無ければ今と同じ（ツール 6 個・sandbox なし・SYSTEM_PROMPT）。sandbox を渡しても付けない", () => {
  for (const options of [buildQueryOptions(cfg, mcpServer), buildQueryOptions({ ...cfg, shell: false }, mcpServer, true)]) {
    assert.deepEqual(options.tools, ["WebSearch", "WebFetch", "Read", "Write", "Edit", "Glob"]);
    assert.equal("sandbox" in options, false);
    assert.deepEqual(options.systemPrompt, { type: "custom", prompt: SYSTEM_PROMPT, snapshot: false });
  }
  assert.deepEqual(buildQueryOptions({ ...cfg, shell: false }, mcpServer, true), buildQueryOptions(cfg, mcpServer));
});

test("buildQueryOptions: シェルが有効なら Bash を末尾に足して 7 個。自己診断が通った run（sandbox）だけ §2.2 の Options.sandbox を付け、通らなければ付けない。Bash は sandbox を付ける run だけ許可の末尾に入れる", (t) => {
  const { root, workDir, host, shellCfg } = shellSetup(t);

  const off = buildQueryOptions(shellCfg, mcpServer, false, host);
  const on = buildQueryOptions(shellCfg, mcpServer, true, host);
  for (const options of [off, on]) {
    assert.deepEqual(options.tools, ["WebSearch", "WebFetch", "Read", "Write", "Edit", "Glob", "Bash"]);
    assert.equal(options.permissionMode, "dontAsk");
    assert.deepEqual(options.systemPrompt, { type: "custom", prompt: SHELL_SYSTEM_PROMPT, snapshot: false });
  }
  assert.equal("sandbox" in off, false);
  // sandbox を付けない run では Bash を許可に入れない（hook と dontAsk で拒否される）
  assert.ok(!(off.allowedTools ?? []).some((rule) => rule.startsWith("Bash")));
  // sandbox を付ける run では Bash を許可の末尾に入れる（#135）
  assert.equal(on.allowedTools?.at(-1), "Bash");
  // sandbox の有無と allowedTools の末尾の Bash 以外は同じ
  const { sandbox, ...rest } = on;
  assert.deepEqual({ ...rest, allowedTools: rest.allowedTools?.slice(0, -1) }, off);
  assert.deepEqual(sandbox, {
    enabled: true,
    failIfUnavailable: true,
    autoAllowBashIfSandboxed: true,
    allowUnsandboxedCommands: false,
    network: { allowedDomains: [...SANDBOX_ALLOWED_DOMAINS], strictAllowlist: true },
    filesystem: {
      denyRead: [
        "~",
        "/tmp",
        "/var/tmp",
        "/dev/shm",
        "/run",
        "/var/run",
        "/var/log",
        "/media",
        "/mnt",
        join(root, "real-data"),
        join(root, "claude"),
        join(root, "home", ".config", "self-agent"),
        join(root, "repo"),
        join(workDir, "jobs"),
      ],
      allowRead: [join(workDir, "projects"), join(workDir, ".cache"), join(workDir, ".tmp"), join(workDir, "cwd"), join(root, "node", "v24")],
      allowWrite: [join(workDir, "projects"), join(workDir, ".cache"), join(workDir, ".tmp")],
      denyWrite: [],
    },
    credentials: { envVars: [{ name: "CLAUDE_CODE_OAUTH_TOKEN", mode: "deny" }, { name: "CLAUDE_CODE_MESSAGING_TOKEN", mode: "deny" }] },
  });
  assert.deepEqual(SANDBOX_ALLOWED_DOMAINS, [
    "github.com",
    "codeload.github.com",
    "raw.githubusercontent.com",
    "objects.githubusercontent.com",
    "release-assets.githubusercontent.com",
    "registry.npmjs.org",
  ]);
  // 全 run で同じ値（チャンネルで変わらない）
  assert.deepEqual(buildQueryOptions(shellCfg, mcpServer, true, host), on);
  // dataDir が無ければ作れない
  const { dataDir: _dataDir, ...withoutData } = shellCfg;
  assert.throws(() => buildQueryOptions(withoutData, mcpServer, true, host), /dataDir/);
});

test("buildQueryOptions: sandbox を付ける run（shell かつ sandbox）だけ allowedTools の末尾に Bash を 1 つ足し、既存の許可は順序そのまま（#135）", (t) => {
  const { workDir, host, shellCfg } = shellSetup(t);
  const rule = `//${join(workDir, "projects").slice(1)}/**`;
  const base = ["mcp__selfagent__*", "WebSearch", "WebFetch", `Read(${rule})`, `Edit(${rule})`];

  const on = buildQueryOptions(shellCfg, mcpServer, true, host);
  assert.deepEqual(on.allowedTools, [...base, "Bash"]);
  assert.equal(on.allowedTools?.filter((r) => r === "Bash").length, 1);

  // shell のみ（sandbox なし）と shell でない run では Bash で始まる許可は無い
  for (const options of [
    buildQueryOptions(shellCfg, mcpServer, false, host),
    buildQueryOptions({ ...shellCfg, shell: false }, mcpServer, true, host),
    buildQueryOptions({ ...shellCfg, shell: false }, mcpServer, false, host),
  ]) {
    assert.deepEqual(options.allowedTools, base);
    assert.ok(!(options.allowedTools ?? []).some((r) => r.startsWith("Bash")));
  }
});

test("buildQueryOptions: options.sandbox の有無と allowedTools の Bash の有無は常に同じ", (t) => {
  const { host, shellCfg } = shellSetup(t);
  for (const shell of [true, false]) {
    for (const sandbox of [true, false]) {
      const options = buildQueryOptions({ ...shellCfg, shell }, mcpServer, sandbox, host);
      assert.equal(
        (options.allowedTools ?? []).includes("Bash"),
        "sandbox" in options,
        `shell=${shell} sandbox=${sandbox}`,
      );
      assert.equal("sandbox" in options, shell && sandbox);
    }
  }
});

test("sandboxSettings: denyRead の秘密の場所と allowRead は、自己診断（placesOverlap）と同じ関数（sandboxSecretPlaces・sandboxReadablePlaces）から実際の場所で作る", (t) => {
  const { workDir, host, shellCfg } = shellSetup(t);
  const places = sandboxPlacesOf(shellCfg, host);
  const settings = sandboxSettings(places);
  const denyRead = settings.filesystem?.denyRead ?? [];
  assert.deepEqual(denyRead.slice(0, SANDBOX_DENY_READ_SYSTEM.length), [...SANDBOX_DENY_READ_SYSTEM]);
  assert.deepEqual(
    denyRead.slice(SANDBOX_DENY_READ_SYSTEM.length, -1),
    sandboxSecretPlaces(places).map((place) => realpathOrSelf(place)),
  );
  assert.equal(denyRead.at(-1), join(workDir, "jobs"));
  assert.deepEqual(settings.filesystem?.allowRead, sandboxReadablePlaces(places).map((place) => realpathOrSelf(place)));
  // この場所は重ならない（自己診断の 3 が通る）
  assert.equal(placesOverlap(places), false);
});

/** 実際の場所（無ければそのまま） */
function realpathOrSelf(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

test("childEnv: シェルが有効ならプロキシの変数と TMPDIR をホストから写さず（TMPDIR は <workDir>/.tmp）、PATH を shellPath にして §2.4 の変数を足す。CLI 自身のトークンは渡し、コマンドからは credentials.envVars で消す", (t) => {
  const { workDir, host, shellCfg } = shellSetup(t);
  const env = childEnv(shellCfg.claudeConfigDir, workDir, host.env, { workDir, execPath: host.execPath });
  assert.ok(projectDirName(workDir) !== undefined);
  assert.deepEqual(env, {
    PATH: shellPath(host.execPath),
    HOME: host.homeDir,
    LANG: "ja_JP.UTF-8",
    CLAUDE_CODE_OAUTH_TOKEN: "dummy-oauth-token",
    CLAUDE_CONFIG_DIR: shellCfg.claudeConfigDir,
    CLAUDE_CODE_PROJECT_DIR_NAME: projectDirName(workDir),
    CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1",
    TMPDIR: join(workDir, ".tmp"),
    CLAUDE_CODE_TMPDIR: join(workDir, ".tmp"),
    npm_config_cache: join(workDir, ".cache", "npm"),
    npm_config_update_notifier: "false",
    npm_config_fund: "false",
    npm_config_audit: "false",
    GIT_TERMINAL_PROMPT: "0",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    BASH_DEFAULT_TIMEOUT_MS: "120000",
    BASH_MAX_TIMEOUT_MS: "300000",
    CLAUDE_CODE_DISABLE_BACKGROUND_TASKS: "1",
  });
  assert.ok(!JSON.stringify(env).includes("dummy-proxy-secret"));
  assert.ok(!JSON.stringify(env).includes("dummy-discord-token"));
  // 無効ならプロキシも PATH も今までどおり
  const plain = childEnv(shellCfg.claudeConfigDir, workDir, host.env);
  assert.equal(plain.CLAUDE_CODE_PROJECT_DIR_NAME, projectDirName(workDir));
  assert.equal(plain.HTTPS_PROXY, host.env.HTTPS_PROXY);
  assert.equal(plain.PATH, "/usr/bin");
  assert.equal(plain.TMPDIR, "/tmp/host-tmp");
  assert.equal("CLAUDE_CODE_TMPDIR" in plain, false);
  // buildQueryOptions も同じ env（sandbox の有無によらない）
  assert.deepEqual(buildQueryOptions(shellCfg, mcpServer, false, host).env, env);
  assert.deepEqual(buildQueryOptions(shellCfg, mcpServer, true, host).sandbox?.credentials, {
    envVars: [{ name: "CLAUDE_CODE_OAUTH_TOKEN", mode: "deny" }, { name: "CLAUDE_CODE_MESSAGING_TOKEN", mode: "deny" }],
  });
});

test("ensureSandboxWriteDirs: projects・.cache・.tmp と jobs、cwd を作る。jobs が symlink・ファイルなら作らずに投げる", (t) => {
  const { root, workDir } = shellSetup(t);
  ensureSandboxWriteDirs(workDir);
  for (const name of ["projects", ".cache", ".tmp", "jobs", "cwd"]) assert.ok(lstatSync(join(workDir, name)).isDirectory(), name);
  // もう一度呼んでもよい
  ensureSandboxWriteDirs(workDir);

  rmSync(join(workDir, "jobs"), { recursive: true });
  symlinkSync(root, join(workDir, "jobs"));
  assert.throws(() => ensureSandboxWriteDirs(workDir), /実際のディレクトリ/);
  rmSync(join(workDir, "jobs"));
  writeFileSync(join(workDir, "jobs"), "");
  assert.throws(() => ensureSandboxWriteDirs(workDir), /実際のディレクトリ/);
});

test("projectDirName: workDir のパスの英数字以外を - にした名前（CLI が cwd から作る記録のディレクトリ名と同じ）。1〜64 字でなければ undefined", () => {
  assert.equal(projectDirName("/home/u/.local/share/self-agent/work"), "-home-u--local-share-self-agent-work");
  assert.equal(projectDirName(`/${"w".repeat(63)}`), `-${"w".repeat(63)}`);
  assert.equal(projectDirName(`/${"w".repeat(64)}`), undefined);
  assert.equal(projectDirName(""), undefined);
});

test("ensureCwdDir: <workDir>/cwd が無ければ 700 で作り、あれば何もしない。symlink・ファイルなら投げる", (t) => {
  const { root, workDir } = shellSetup(t);
  const cwd = join(workDir, "cwd");
  assert.equal(ensureCwdDir(workDir), cwd);
  assert.ok(lstatSync(cwd).isDirectory());
  assert.equal(statSync(cwd).mode & 0o777, 0o700);
  // 既にあれば何もしない（中身も権限も変えない）
  writeFileSync(join(cwd, "keep"), "");
  assert.equal(ensureCwdDir(workDir), cwd);
  assert.ok(lstatSync(join(cwd, "keep")).isFile());

  rmSync(cwd, { recursive: true });
  symlinkSync(root, cwd);
  assert.throws(() => ensureCwdDir(workDir), /実際のディレクトリ/);
  rmSync(cwd);
  writeFileSync(cwd, "");
  assert.throws(() => ensureCwdDir(workDir), /実際のディレクトリ/);
});

test("projectDirNameFor: 末尾の / ・symlink を解いた実際の場所から名前を作る（CLI が cwd から作る名前と同じ）", (t) => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "self-agent-test-")));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, "real-work"));
  symlinkSync(join(root, "real-work"), join(root, "work"));
  const expected = projectDirName(join(root, "real-work"));
  assert.ok(expected !== undefined);
  assert.equal(projectDirNameFor(join(root, "work")), expected);
  assert.equal(projectDirNameFor(`${join(root, "real-work")}/`), expected);
  assert.equal(childEnv("/srv/claude", join(root, "work"), {}).CLAUDE_CODE_PROJECT_DIR_NAME, expected);
});
