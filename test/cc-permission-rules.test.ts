import { test } from "node:test";
import assert from "node:assert/strict";
import {
  alwaysRulesOf,
  CC_ALWAYS_RULE_MAX_CHARS,
  describeRule,
  formatRule,
  parseStoredRules,
  sessionRulesUpdate,
} from "../src/cc/permissions.ts";

const WORKSPACE = "/home/owner/workspace";
const CTX = { cwd: `${WORKSPACE}/app`, workspaceDir: WORKSPACE };

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
  for (const content of [undefined, "", "*", " *", ":*", "* :*", "  ", "**"]) {
    assert.equal(bashAllowed(content), false, String(content));
  }
});

test("alwaysRulesOf: Bash の危ない最初の語・git push・シェルの記号は外す", () => {
  for (const content of [
    "rm *",
    "rm:*",
    "rm -rf build",
    "/bin/rm *",
    "sudo apt update",
    "su *",
    "chmod 600 x",
    "chown *",
    "dd *",
    "mkfs *",
    "curl *",
    "wget *",
    "ssh host",
    "scp *",
    "eval *",
    "bash *",
    "sh *",
    "xargs *",
    "systemctl *",
    "kill *",
    "pkill node",
    "git push",
    "git push *",
    "git push --force origin main",
    "git -C x push *",
    // git push を含む接頭辞
    "git *",
    "git:*",
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
  for (const content of ["npm test *", "npm test:*", "npm run lint", "git status *", "git log", "ls -la", "node --test *"]) {
    assert.equal(bashAllowed(content), true, content);
  }
  assert.equal(bashAllowed(`npm test ${"a".repeat(CC_ALWAYS_RULE_MAX_CHARS)}`), false);
});

test("alwaysRulesOf: ファイルのルールは ~/workspace/ の中（cwd からの相対・~/workspace/…）で .. を含まないものだけ", () => {
  const allowed = (toolName: string, ruleContent: string, ctx: { cwd?: string; workspaceDir: string } = CTX) =>
    alwaysRulesOf(toolName, [addRules([{ toolName, ruleContent }])], ctx) !== null;
  assert.equal(allowed("Edit", "src/**"), true);
  assert.equal(allowed("Edit", "./src/x.ts"), true);
  assert.equal(allowed("Read", "~/workspace/app/**"), true);
  assert.equal(allowed("Write", "../other/**"), false);
  assert.equal(allowed("Edit", "src/../../x"), false);
  assert.equal(allowed("Edit", "~/workspace/../.ssh/**"), false);
  assert.equal(allowed("Edit", "~/workspace/"), false);
  assert.equal(allowed("Edit", "~/.ssh/**"), false);
  assert.equal(allowed("Edit", "/etc/**"), false);
  assert.equal(allowed("Edit", "//home/owner/workspace/app/**"), false);
  assert.equal(allowed("Edit", ""), false);
  assert.equal(alwaysRulesOf("Edit", [addRules([{ toolName: "Edit" }])], CTX), null);
  // cwd が ~/workspace の外なら相対のルールは使わない
  assert.equal(allowed("Edit", "src/**", { cwd: "/etc", workspaceDir: WORKSPACE }), false);
  assert.equal(allowed("Edit", "src/**", { cwd: "/home/owner/workspace-other", workspaceDir: WORKSPACE }), false);
  assert.equal(allowed("Edit", "src/**", { workspaceDir: WORKSPACE }), false);
  assert.equal(allowed("Edit", "src/**", { cwd: WORKSPACE, workspaceDir: WORKSPACE }), true);
});

test("alwaysRulesOf: WebFetch は domain:<ホスト名> だけ、MCP は提案どおり、それ以外のツールは外す", () => {
  const rulesOf = (toolName: string, rule: Record<string, unknown>) => alwaysRulesOf(toolName, [addRules([rule])], CTX);
  assert.deepEqual(rulesOf("WebFetch", { toolName: "WebFetch", ruleContent: "domain:example.com" }), [
    { toolName: "WebFetch", ruleContent: "domain:example.com" },
  ]);
  assert.equal(rulesOf("WebFetch", { toolName: "WebFetch" }), null);
  assert.equal(rulesOf("WebFetch", { toolName: "WebFetch", ruleContent: "domain:*" }), null);
  assert.equal(rulesOf("WebFetch", { toolName: "WebFetch", ruleContent: "https://example.com/" }), null);
  assert.deepEqual(rulesOf("mcp__x__y", { toolName: "mcp__x__y" }), [{ toolName: "mcp__x__y" }]);
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
