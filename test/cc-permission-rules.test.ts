import { test } from "node:test";
import assert from "node:assert/strict";
import {
  alwaysRulesOf,
  CC_ALWAYS_RULE_MAX_CHARS,
  type CcRuleContext,
  describeRule,
  formatRule,
  parseStoredRules,
  sessionRulesUpdate,
} from "../src/cc/permissions.ts";

const HOME = "/home/owner";
const WORKSPACE = `${HOME}/workspace`;
const CTX: CcRuleContext = { cwd: `${WORKSPACE}/app`, workspaceDir: WORKSPACE, home: HOME };

/** 実機で来た形の提案（addRules・destination localSettings） */
function addRules(rules: unknown[], extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { type: "addRules", rules, behavior: "allow", destination: "localSettings", ...extra };
}

/** Bash の ruleContent 1 つが候補に残るか */
function bashAllowed(ruleContent: string | undefined): boolean {
  const rule = ruleContent === undefined ? { toolName: "Bash" } : { toolName: "Bash", ruleContent };
  return alwaysRulesOf("Bash", [addRules([rule])], CTX) !== null;
}

test("alwaysRulesOf: 実機の形（npm test *・localSettings）は残り、destination は使わない", () => {
  const rules = alwaysRulesOf("Bash", [addRules([{ toolName: "Bash", ruleContent: "npm test *" }])], CTX);
  assert.deepEqual(rules, [{ toolName: "Bash", ruleContent: "npm test *" }]);
  // 古い形の :* も同じ
  assert.deepEqual(alwaysRulesOf("Bash", [addRules([{ toolName: "Bash", ruleContent: "npm test:*" }])], CTX), [
    { toolName: "Bash", ruleContent: "npm test:*" },
  ]);
  // behavior が無い提案も使う
  assert.deepEqual(
    alwaysRulesOf("Bash", [{ type: "addRules", rules: [{ toolName: "Bash", ruleContent: "npm run lint" }], destination: "userSettings" }], CTX),
    [{ toolName: "Bash", ruleContent: "npm run lint" }],
  );
});

test("alwaysRulesOf: addRules で allow のものだけ。deny・addDirectories・setMode・空・形の違うものは使わない", () => {
  assert.equal(alwaysRulesOf("Bash", [addRules([{ toolName: "Bash", ruleContent: "npm test *" }], { behavior: "deny" })], CTX), null);
  assert.equal(alwaysRulesOf("Bash", [addRules([{ toolName: "Bash", ruleContent: "npm test *" }], { behavior: "ask" })], CTX), null);
  // touch・echo の実機の提案（addDirectories・setMode だけ）
  assert.equal(
    alwaysRulesOf(
      "Bash",
      [
        { type: "addDirectories", directories: ["/tmp/x"], destination: "session" },
        { type: "setMode", mode: "acceptEdits", destination: "session" },
      ],
      CTX,
    ),
    null,
  );
  assert.equal(alwaysRulesOf("Bash", [], CTX), null);
  assert.equal(alwaysRulesOf("Bash", undefined, CTX), null);
  assert.equal(alwaysRulesOf("Bash", { type: "addRules" }, CTX), null);
  assert.equal(alwaysRulesOf("Bash", [addRules([{ toolName: 1, ruleContent: "npm test *" }])], CTX), null);
  assert.equal(alwaysRulesOf("Bash", [addRules([{ toolName: "Bash", ruleContent: 3 }])], CTX), null);
  assert.equal(alwaysRulesOf("Bash", [{ type: "addRules", rules: "Bash(npm test *)" }], CTX), null);
});

test("alwaysRulesOf: toolName が要求の tool_name と違う rules は落ちる。同じルールは 1 つにまとめる", () => {
  const rules = alwaysRulesOf(
    "Bash",
    [
      addRules([
        { toolName: "Read", ruleContent: "src/**" },
        { toolName: "Bash", ruleContent: "npm test *" },
      ]),
      addRules([{ toolName: "Bash", ruleContent: "npm test *" }]),
    ],
    CTX,
  );
  assert.deepEqual(rules, [{ toolName: "Bash", ruleContent: "npm test *" }]);
  assert.equal(alwaysRulesOf("Edit", [addRules([{ toolName: "Bash", ruleContent: "npm test *" }])], CTX), null);
});

test("alwaysRulesOf: Bash の語の無い・広いルールは外す", () => {
  for (const content of [undefined, "", "*", " *", ":*", "* :*", "  ", "**", "( *", "{ *"]) {
    assert.equal(bashAllowed(content), false, String(content));
  }
});

test("alwaysRulesOf: Bash の危ない最初の語・シェルの記号は外す", () => {
  for (const content of [
    "rm *",
    "rm:*",
    "rm -rf build",
    "/bin/rm *",
    "sudo apt update",
    "su *",
    "doas *",
    "chmod 600 x",
    "chown *",
    "dd *",
    "mkfs *",
    "curl *",
    "wget *",
    "ssh host",
    "scp *",
    "systemctl *",
    "kill *",
    "pkill node",
    "npm test | tee *",
    "npm test; ls",
    "npm test && ls",
    "npm test > out",
    "npm test < in",
    "npm test & *",
    "echo $HOME",
    "echo `id`",
    "npm test\nls",
    // 途中の * は「で始まる」の意味にならない
    "npm * test",
    "npm test*",
  ]) {
    assert.equal(bashAllowed(content), false, content);
  }
  assert.equal(bashAllowed(`npm test ${"a".repeat(CC_ALWAYS_RULE_MAX_CHARS)}`), false);
});

test("alwaysRulesOf: Bash の最初の語のクォート・エスケープ（飾り）は外す", () => {
  for (const content of ['"rm" -rf x', "'rm' *", "r\\m *", "\\rm *", '"npm" test *', "'/bin/rm' *", "ls\\ *"]) {
    assert.equal(bashAllowed(content), false, content);
  }
});

test("alwaysRulesOf: Bash の最初の語に / があるもの（パスで指したコマンド・スクリプト）は外す", () => {
  for (const content of [
    "./script.sh *",
    "./script.sh",
    "bin/x *",
    "/usr/bin/foo *",
    "/usr/bin/git status *",
    "/bin/ls",
    "node_modules/.bin/tsc *",
    "~/bin/x *",
    "../x *",
  ]) {
    assert.equal(bashAllowed(content), false, content);
  }
  // 後ろの語の / は構わない
  assert.equal(bashAllowed("ls src/ *"), true);
  assert.equal(bashAllowed("cat docs/plan/x.md"), true);
});

test("alwaysRulesOf: Bash のサブシェル・波括弧は外す", () => {
  for (const content of ["(rm -rf x)", "ls (x) *", "{ rm x; }", "echo {a,b} *", "ls )"]) {
    assert.equal(bashAllowed(content), false, content);
  }
});

test("alwaysRulesOf: Bash の包み語は外す", () => {
  for (const word of [
    "env",
    "exec",
    "command",
    "builtin",
    "nohup",
    "timeout",
    "nice",
    "time",
    "doas",
    "busybox",
    "setsid",
    "xargs",
    "bash",
    "sh",
    "zsh",
    "eval",
    "source",
    ".",
  ]) {
    assert.equal(bashAllowed(`${word} npm test *`), false, word);
    assert.equal(bashAllowed(`${word} *`), false, word);
  }
  assert.equal(bashAllowed("/usr/bin/env rm *"), false);
  assert.equal(bashAllowed(". ./script.sh"), false);
});

test("alwaysRulesOf: Bash の任意のコードを実行できる入口は外す。npm は npm test・npm run <名前> だけ", () => {
  for (const content of [
    "npx *",
    "npx tsc --noEmit",
    "node *",
    "node --test *",
    "node scripts/x.ts",
    "python *",
    "python3 -c x",
    "perl *",
    "ruby *",
    "make *",
    "make test",
    "deno *",
    "bun *",
    "bun test",
    "npm *",
    "npm:*",
    "npm exec *",
    "npm exec x",
    "npm run *",
    "npm run",
    "npm run -s *",
    "npm install *",
    "npm i x",
    "npm t",
  ]) {
    assert.equal(bashAllowed(content), false, content);
  }
  for (const content of ["npm test *", "npm test:*", "npm test", "npm test -- --watch", "npm run lint", "npm run lint *", "npm run test:integration *"]) {
    assert.equal(bashAllowed(content), true, content);
  }
});

test("alwaysRulesOf: git の書き換える・消すサブコマンド、find の -exec・-delete は外す", () => {
  for (const sub of ["reset", "clean", "checkout", "restore", "branch", "stash", "rebase", "push", "filter-branch"]) {
    assert.equal(bashAllowed(`git ${sub} *`), false, sub);
    assert.equal(bashAllowed(`git ${sub}`), false, sub);
  }
  for (const content of [
    "git push --force origin main",
    "git -C x push *",
    "git -C x status *",
    // git push などを後ろに付けられる
    "git *",
    "git:*",
    "git",
    "find . -exec rm {} ;",
    "find . -delete",
    "find . -name x -execdir y",
    // find の接頭辞の印は -exec・-delete を後ろに付けられる
    "find . *",
    "find src -name x *",
  ]) {
    assert.equal(bashAllowed(content), false, content);
  }
  for (const content of ["git status *", "git log", "git diff *", "git status", "find . -name x", "ls -la", "ls *", "cat README.md"]) {
    assert.equal(bashAllowed(content), true, content);
  }
});

test("alwaysRulesOf: ファイルのルールは要求の cwd が属する ~/workspace/<直下> の中で .. を含まないものだけ", () => {
  const allowed = (toolName: string, ruleContent: string, ctx: CcRuleContext = CTX) =>
    alwaysRulesOf(toolName, [addRules([{ toolName, ruleContent }])], ctx) !== null;
  assert.equal(allowed("Edit", "src/**"), true);
  assert.equal(allowed("Edit", "./src/x.ts"), true);
  assert.equal(allowed("Edit", "**"), true);
  assert.equal(allowed("Read", "~/workspace/app/**"), true);
  assert.equal(allowed("Read", "~/workspace/app/src/x.ts"), true);
  assert.equal(allowed("Write", "//home/owner/workspace/app/src/**"), true);
  // cwd がプロジェクトの下のディレクトリでも、そのプロジェクトの中なら通す
  assert.equal(allowed("Edit", "~/workspace/app/docs/**", { ...CTX, cwd: `${WORKSPACE}/app/src` }), true);
  assert.equal(allowed("Edit", "x.ts", { ...CTX, cwd: `${WORKSPACE}/app/src` }), true);
  // workspace 全体・ほかのプロジェクト・プロジェクトそのもの
  assert.equal(allowed("Edit", "~/workspace/**"), false);
  assert.equal(allowed("Edit", "~/workspace/*/**"), false);
  assert.equal(allowed("Edit", "~/workspace/other/**"), false);
  assert.equal(allowed("Edit", "~/workspace/app"), false);
  assert.equal(allowed("Edit", "~/workspace/app/"), false);
  assert.equal(allowed("Edit", "~/workspace/"), false);
  assert.equal(allowed("Edit", "//home/owner/workspace/**"), false);
  assert.equal(allowed("Edit", "//home/owner/workspace/other/x"), false);
  assert.equal(allowed("Edit", "//home/owner/workspace/application/x"), false);
  // .. ・ほかの場所
  assert.equal(allowed("Write", "../other/**"), false);
  assert.equal(allowed("Edit", "src/../../x"), false);
  assert.equal(allowed("Edit", "~/workspace/app/../other/**"), false);
  assert.equal(allowed("Edit", "~/.ssh/**"), false);
  assert.equal(allowed("Edit", "~other/x"), false);
  assert.equal(allowed("Edit", "/etc/**"), false);
  assert.equal(allowed("Edit", "/src/**"), false);
  assert.equal(allowed("Edit", ""), false);
  assert.equal(alwaysRulesOf("Edit", [addRules([{ toolName: "Edit" }])], CTX), null);
  // cwd が workspace の直下のプロジェクトの中でなければ使わない
  assert.equal(allowed("Edit", "src/**", { ...CTX, cwd: WORKSPACE }), false);
  assert.equal(allowed("Edit", "src/**", { ...CTX, cwd: `${WORKSPACE}/` }), false);
  assert.equal(allowed("Edit", "src/**", { ...CTX, cwd: "/etc" }), false);
  assert.equal(allowed("Edit", "src/**", { ...CTX, cwd: "/home/owner/workspace-other/app" }), false);
  assert.equal(allowed("Edit", "src/**", { ...CTX, cwd: `${WORKSPACE}/app/../other` }), false);
  assert.equal(allowed("Edit", "src/**", { workspaceDir: WORKSPACE, home: HOME }), false);
  // workspaceDir・home が渡されなければ使わない
  assert.equal(allowed("Edit", "src/**", { cwd: `${WORKSPACE}/app` }), false);
  assert.equal(allowed("Edit", "~/workspace/app/**", { cwd: `${WORKSPACE}/app`, workspaceDir: WORKSPACE }), false);
  // SELF_AGENT_WORKSPACE_DIR が ~/workspace でないとき
  const custom = { cwd: "/srv/code/app", workspaceDir: "/srv/code/", home: HOME };
  assert.equal(allowed("Edit", "src/**", custom), true);
  assert.equal(allowed("Edit", "//srv/code/app/x", custom), true);
  assert.equal(allowed("Edit", "~/workspace/app/**", custom), false);
});

test("alwaysRulesOf: WebFetch は domain:<ホスト名> だけ、MCP は tool_name と完全一致するものだけ、それ以外のツールは外す", () => {
  const rulesOf = (toolName: string, rule: Record<string, unknown>) => alwaysRulesOf(toolName, [addRules([rule])], CTX);
  assert.deepEqual(rulesOf("WebFetch", { toolName: "WebFetch", ruleContent: "domain:example.com" }), [
    { toolName: "WebFetch", ruleContent: "domain:example.com" },
  ]);
  assert.equal(rulesOf("WebFetch", { toolName: "WebFetch" }), null);
  assert.equal(rulesOf("WebFetch", { toolName: "WebFetch", ruleContent: "domain:*" }), null);
  assert.equal(rulesOf("WebFetch", { toolName: "WebFetch", ruleContent: "https://example.com/" }), null);
  assert.deepEqual(rulesOf("mcp__x__y", { toolName: "mcp__x__y" }), [{ toolName: "mcp__x__y" }]);
  // サーバー全体のルールは tool_name と一致しない
  assert.equal(rulesOf("mcp__x__y", { toolName: "mcp__x" }), null);
  assert.equal(rulesOf("WebSearch", { toolName: "WebSearch" }), null);
  assert.equal(rulesOf("Task", { toolName: "Task", ruleContent: "x" }), null);
});

test("formatRule・describeRule: Bash(npm test *) と「npm test」で始まるコマンド / このコマンドだけ", () => {
  assert.equal(formatRule({ toolName: "Bash", ruleContent: "npm test *" }), "Bash(npm test *)");
  assert.equal(formatRule({ toolName: "mcp__x__y" }), "mcp__x__y");
  assert.equal(describeRule({ toolName: "Bash", ruleContent: "npm test *" }), "「npm test」で始まるコマンド");
  assert.equal(describeRule({ toolName: "Bash", ruleContent: "npm test:*" }), "「npm test」で始まるコマンド");
  assert.equal(describeRule({ toolName: "Bash", ruleContent: "npm run lint" }), "このコマンドだけ");
  assert.equal(describeRule({ toolName: "Edit", ruleContent: "src/**" }), null);
});

test("sessionRulesUpdate: addRules・behavior allow・destination session の 1 件だけ", () => {
  const update = sessionRulesUpdate([{ toolName: "Bash", ruleContent: "npm test *" }]);
  assert.deepEqual(update, [
    { type: "addRules", rules: [{ toolName: "Bash", ruleContent: "npm test *" }], behavior: "allow", destination: "session" },
  ]);
  // 余計な欄（提案の destination など）を持ち込まない
  const extra = sessionRulesUpdate([{ toolName: "Bash", ruleContent: "npm test *", destination: "userSettings" } as never]);
  assert.deepEqual(extra[0]!.rules, [{ toolName: "Bash", ruleContent: "npm test *" }]);
});

test("parseStoredRules: 形の違う JSON・空の配列は null", () => {
  assert.deepEqual(parseStoredRules('[{"toolName":"Bash","ruleContent":"npm test *"}]'), [{ toolName: "Bash", ruleContent: "npm test *" }]);
  assert.equal(parseStoredRules(null), null);
  assert.equal(parseStoredRules("[]"), null);
  assert.equal(parseStoredRules("{"), null);
  assert.equal(parseStoredRules('[{"toolName":1}]'), null);
  assert.equal(parseStoredRules('{"toolName":"Bash"}'), null);
});
