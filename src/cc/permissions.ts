// Claude Code の許可の要求の「このセッションでは常に許可」の線引き（docs/plan/claude-code-sessions.md §3.4・決定 11・18。CC5b。純関数）。
// 元にするのは要求の permission_suggestions の type: "addRules" で behavior が "allow"（か無い）のものの rules だけで、提案に無いルールは作らない。
// この線引きはオーナーがボタンの文面（ルールそのもの）を読むことの後ろ盾で、境界ではない。迷うものは外す（ボタンを出さない）。
// rules は toolName が要求の tool_name と同じものだけ残し、さらに次の線引きを通ったものだけを候補にする:
// - Bash: ruleContent の末尾の ` *`・`:*` を接頭辞の印として外し、語が無い・`*` が残る・シェルの記号（CC_ALWAYS_BASH_DENIED_CHARS）を含む・
//   最初の語にクォート・`\` がある・最初の語（パスなら名前）が CC_ALWAYS_BASH_DENIED_WORDS（危ない語・包み語・任意のコードを実行できる入口）にある・
//   npm で `npm test`・`npm run <名前>` の形でない・git で最初の語の次がサブコマンドでないか CC_ALWAYS_BASH_DENIED_PHRASES の語を含む・
//   find で接頭辞の印があるか -exec などを含むものは外す
// - ファイルのツール（Edit・Write など）: 要求の cwd が属する <workspaceDir>/<直下> の中のパスだけ（cwd からの相対・`~/…`・`//<絶対パス>`）で、`..` を含まないもの
// - WebFetch: `domain:<ホスト名>` だけ。MCP のツール（mcp__…）は提案どおり。それ以外のツールは外す
// 返す決定は destination が必ず "session" の addRules 1 件だけ（提案の destination（localSettings など）は使わず、設定ファイルには書かない）
import { posix } from "node:path";

/** 常に許可のルール 1 つ（Claude Code の permission_suggestions の rules の要素の形） */
export type CcRule = { toolName: string; ruleContent?: string };

/** ファイルのルールの線引きに使う場所。workspaceDir（SELF_AGENT_WORKSPACE_DIR）・home が無ければファイルのルールは外す */
export type CcRuleContext = { cwd?: string; workspaceDir?: string; home?: string };

/**
 * Bash のルールで、最初の語（パスなら名前）がこれなら常に許可の候補から外す（決定 18。緩めるならここから語を消す）。
 * 危ない語・ほかのコマンドを包む語・任意のコードを実行できる入口
 */
export const CC_ALWAYS_BASH_DENIED_WORDS: readonly string[] = [
  // 危ない語
  "rm",
  "sudo",
  "su",
  "doas",
  "chmod",
  "chown",
  "dd",
  "mkfs",
  "curl",
  "wget",
  "ssh",
  "scp",
  "systemctl",
  "kill",
  "pkill",
  // 包み語
  "env",
  "exec",
  "command",
  "builtin",
  "nohup",
  "timeout",
  "nice",
  "time",
  "busybox",
  "setsid",
  "xargs",
  "bash",
  "sh",
  "zsh",
  "eval",
  "source",
  ".",
  // 任意のコードを実行できる入口（npm は下の形だけ通す）
  "npx",
  "node",
  "python",
  "python3",
  "perl",
  "ruby",
  "make",
  "deno",
  "bun",
];
/** Bash のルールで、最初の語（head）の後ろにこの語のどれかがあれば外す */
export const CC_ALWAYS_BASH_DENIED_PHRASES: readonly { head: string; after: readonly string[] }[] = [
  { head: "git", after: ["reset", "clean", "checkout", "restore", "branch", "stash", "rebase", "push", "filter-branch"] },
  { head: "find", after: ["-exec", "-delete", "-execdir"] },
];
/** Bash の接頭辞に含まれていれば外す文字（パイプ・連結・リダイレクト・背景・置換・サブシェル・波括弧・改行） */
export const CC_ALWAYS_BASH_DENIED_CHARS: readonly string[] = ["|", ";", "&", ">", "<", "`", "$", "(", ")", "{", "}", "\n", "\r"];
/** 最初の語に含まれていれば外す文字（クォート・エスケープで語を飾ったもの） */
const BASH_FIRST_WORD_DENIED_CHARS: readonly string[] = ['"', "'", "\\"];
/** `npm run <名前>` の名前 */
const NPM_SCRIPT_PATTERN = /^[A-Za-z0-9][A-Za-z0-9:_.-]*$/;
/** ファイルのルールを許すツール */
const FILE_RULE_TOOLS: ReadonlySet<string> = new Set(["Edit", "Write", "MultiEdit", "Read", "Glob", "Grep", "NotebookEdit"]);
/** 1 つの ruleContent の長さの上限（これより長い提案は外す） */
export const CC_ALWAYS_RULE_MAX_CHARS = 200;
/** 候補にするルールの数の上限 */
export const CC_ALWAYS_RULES_MAX = 10;
const TOOL_NAME_PATTERN = /^[A-Za-z0-9_.:-]{1,128}$/;
const WEB_FETCH_RULE_PATTERN = /^domain:[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)+$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Bash の ruleContent を接頭辞と印に分ける（末尾の ` *` か `:*` があれば wildcard） */
function splitBashRule(ruleContent: string): { prefix: string; wildcard: boolean } {
  if (ruleContent.endsWith(" *") || ruleContent.endsWith(":*")) return { prefix: ruleContent.slice(0, -2).trim(), wildcard: true };
  return { prefix: ruleContent.trim(), wildcard: false };
}

/** Bash のルールが常に許可の候補になるか（決定 18） */
function bashRuleAllowed(ruleContent: string | undefined): boolean {
  // ruleContent が無い Bash のルールはすべてのコマンドを通す
  if (ruleContent === undefined) return false;
  const { prefix, wildcard } = splitBashRule(ruleContent);
  if (prefix.includes("*")) return false;
  if (CC_ALWAYS_BASH_DENIED_CHARS.some((char) => prefix.includes(char))) return false;
  const words = prefix.split(/\s+/).filter((word) => word !== "");
  if (words.length === 0) return false;
  if (BASH_FIRST_WORD_DENIED_CHARS.some((char) => words[0]!.includes(char))) return false;
  const first = posix.basename(words[0]!);
  if (CC_ALWAYS_BASH_DENIED_WORDS.includes(first)) return false;
  const rest = words.slice(1);
  // npm は `npm test …` と `npm run <名前> …` だけ（npm exec・`npm run *` などは外す）
  if (first === "npm") {
    return rest[0] === "test" || (rest[0] === "run" && rest[1] !== undefined && NPM_SCRIPT_PATTERN.test(rest[1]));
  }
  for (const phrase of CC_ALWAYS_BASH_DENIED_PHRASES) {
    if (first === phrase.head && rest.some((word) => phrase.after.includes(word))) return false;
  }
  // git は最初の語の次がサブコマンドのものだけ（`git *`・`git -C x *` は git push などを含む）
  if (first === "git" && (rest[0] === undefined || rest[0].startsWith("-"))) return false;
  // find の接頭辞の印は -exec・-delete を後ろに付けられる
  if (first === "find" && wildcard) return false;
  return true;
}

/** パスの要素に `..` が無いか */
function noParent(path: string): boolean {
  return !path.split("/").includes("..");
}

/** 末尾の `/` を除く（`/` だけなら空） */
function trimSlash(path: string): string {
  return path.replace(/\/+$/, "");
}

/** ファイルのルールが、要求の cwd が属する <workspaceDir>/<直下> の中か */
function fileRuleAllowed(ruleContent: string | undefined, ctx: CcRuleContext): boolean {
  if (ruleContent === undefined || ruleContent === "" || ruleContent.includes("\0") || !noParent(ruleContent)) return false;
  const { cwd, workspaceDir, home } = ctx;
  if (cwd === undefined || workspaceDir === undefined || !cwd.startsWith("/") || !noParent(cwd)) return false;
  const base = trimSlash(workspaceDir);
  if (base === "" || !base.startsWith("/") || !cwd.startsWith(`${base}/`)) return false;
  // cwd の属するプロジェクト（workspaceDir の直下）
  const project = cwd.slice(base.length + 1).split("/")[0]!;
  if (project === "") return false;
  const projectDir = `${base}/${project}`;
  let absolute: string;
  if (ruleContent.startsWith("//")) absolute = ruleContent.slice(1);
  else if (ruleContent.startsWith("~/")) {
    if (home === undefined || !home.startsWith("/") || !noParent(home)) return false;
    absolute = `${trimSlash(home)}${ruleContent.slice(1)}`;
  } else if (ruleContent.startsWith("/") || ruleContent.startsWith("~")) {
    // `/` は設定ファイルからの相対、ほかの `~` は使わない
    return false;
  } else absolute = `${trimSlash(cwd)}/${ruleContent}`;
  const normalized = posix.normalize(absolute);
  // プロジェクトそのもの・workspace 全体（`~/workspace/**`・`~/workspace/*/**`）・ほかのプロジェクトは外す
  return normalized.startsWith(`${projectDir}/`) && normalized.length > projectDir.length + 1;
}

/** 1 つのルールが常に許可の候補になるか */
function ruleAllowed(rule: CcRule, ctx: CcRuleContext): boolean {
  if (rule.ruleContent !== undefined && rule.ruleContent.length > CC_ALWAYS_RULE_MAX_CHARS) return false;
  if (rule.toolName === "Bash") return bashRuleAllowed(rule.ruleContent);
  if (FILE_RULE_TOOLS.has(rule.toolName)) return fileRuleAllowed(rule.ruleContent, ctx);
  if (rule.toolName === "WebFetch") return rule.ruleContent !== undefined && WEB_FETCH_RULE_PATTERN.test(rule.ruleContent);
  // MCP は toolName が要求の tool_name と完全一致するものだけ（alwaysRulesOf で比べる。`mcp__server` のようなサーバー全体のルールは落ちる）
  if (rule.toolName.startsWith("mcp__")) return true;
  return false;
}

/** rules の要素を読む（形が違えば undefined） */
function readRule(value: unknown): CcRule | undefined {
  if (!isRecord(value) || typeof value.toolName !== "string" || !TOOL_NAME_PATTERN.test(value.toolName)) return undefined;
  if (value.ruleContent === undefined || value.ruleContent === null) return { toolName: value.toolName };
  if (typeof value.ruleContent !== "string") return undefined;
  return { toolName: value.toolName, ruleContent: value.ruleContent };
}

/**
 * 要求の permission_suggestions から、常に許可にできるルールを選ぶ（§3.4）。残らなければ null（= [常に許可] を出さない）。
 * ctx.cwd は要求の cwd、ctx.workspaceDir は SELF_AGENT_WORKSPACE_DIR（~/workspace）、ctx.home はホーム（`~/…` のルールの展開）
 */
export function alwaysRulesOf(toolName: string, suggestions: unknown, ctx: CcRuleContext): CcRule[] | null {
  if (!Array.isArray(suggestions)) return null;
  const picked = new Map<string, CcRule>();
  for (const suggestion of suggestions) {
    if (!isRecord(suggestion) || suggestion.type !== "addRules") continue;
    if (suggestion.behavior !== undefined && suggestion.behavior !== "allow") continue;
    if (!Array.isArray(suggestion.rules)) continue;
    for (const value of suggestion.rules) {
      const rule = readRule(value);
      if (rule === undefined || rule.toolName !== toolName || !ruleAllowed(rule, ctx)) continue;
      const key = formatRule(rule);
      if (!picked.has(key) && picked.size < CC_ALWAYS_RULES_MAX) picked.set(key, rule);
    }
  }
  return picked.size === 0 ? null : [...picked.values()];
}

/** 表示の形（`Bash(npm test *)`。ruleContent が無ければツール名だけ） */
export function formatRule(rule: CcRule): string {
  return rule.ruleContent === undefined ? rule.toolName : `${rule.toolName}(${rule.ruleContent})`;
}

/** ルールの意味の添え書き（Bash だけ）: 末尾が ` *`・`:*` なら「「npm test」で始まるコマンド」、無ければ「このコマンドだけ」 */
export function describeRule(rule: CcRule): string | null {
  if (rule.toolName !== "Bash" || rule.ruleContent === undefined) return null;
  const { prefix, wildcard } = splitBashRule(rule.ruleContent);
  return wildcard ? `「${prefix}」で始まるコマンド` : "このコマンドだけ";
}

/** 常に許可の決定の updatedPermissions（§3.4）。3 つの欄を明示し、behavior は allow・destination は session に固定する */
export function sessionRulesUpdate(rules: readonly CcRule[]): Array<{
  type: "addRules";
  rules: CcRule[];
  behavior: "allow";
  destination: "session";
}> {
  const copied = rules.map((rule) => (rule.ruleContent === undefined ? { toolName: rule.toolName } : { toolName: rule.toolName, ruleContent: rule.ruleContent }));
  return [{ type: "addRules", rules: copied, behavior: "allow", destination: "session" }];
}

/** DB に残したルールの JSON を読む（形が違えば null） */
export function parseStoredRules(json: string | null): CcRule[] | null {
  if (json === null) return null;
  let value: unknown;
  try {
    value = JSON.parse(json);
  } catch {
    return null;
  }
  if (!Array.isArray(value) || value.length === 0) return null;
  const rules = value.map(readRule);
  return rules.every((rule): rule is CcRule => rule !== undefined) ? rules : null;
}
