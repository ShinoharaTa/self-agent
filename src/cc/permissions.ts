// Claude Code の許可の要求の「このセッションでは常に許可」の線引き（docs/plan/claude-code-sessions.md §3.4・決定 11・18。CC5b。純関数）。
// 元にするのは要求の permission_suggestions の type: "addRules" で behavior が "allow"（か無い）のものの rules だけで、提案に無いルールは作らない。
// rules は toolName が要求の tool_name と同じものだけ残し、さらに次の線引きを通ったものだけを候補にする:
// - Bash: ruleContent の末尾の ` *`・`:*` を接頭辞の印として外し、語が無い・`*` が残る・シェルの記号（| ; & > < ` $ と改行）を含む・
//   最初の語（パスなら名前）が CC_ALWAYS_BASH_DENIED_WORDS にある・CC_ALWAYS_BASH_DENIED_PHRASES（git push）にかかるものは外す
// - ファイルのツール（Edit・Write など）: ruleContent が ~/workspace/ の中（`~/workspace/…` か、cwd が ~/workspace の中のときの cwd からの相対）で `..` を含まないものだけ
// - WebFetch: `domain:<ホスト名>` だけ。MCP のツール（mcp__…）は提案どおり。それ以外のツールは外す
// 返す決定は destination が必ず "session" の addRules 1 件だけ（提案の destination（localSettings など）は使わず、設定ファイルには書かない）
import { posix } from "node:path";

/** 常に許可のルール 1 つ（Claude Code の permission_suggestions の rules の要素の形） */
export type CcRule = { toolName: string; ruleContent?: string };

/** Bash のルールで、最初の語（パスなら名前）がこれなら常に許可の候補から外す（決定 18。緩めるならここから語を消す） */
export const CC_ALWAYS_BASH_DENIED_WORDS: readonly string[] = [
  "rm",
  "sudo",
  "su",
  "chmod",
  "chown",
  "dd",
  "mkfs",
  "curl",
  "wget",
  "ssh",
  "scp",
  "eval",
  "bash",
  "sh",
  "xargs",
  "systemctl",
  "kill",
  "pkill",
];
/** Bash のルールで、この語の並びを含む（`git push --force` も）か、接頭辞がこの並びの手前で終わる（`git *` は git push を含む）なら外す */
export const CC_ALWAYS_BASH_DENIED_PHRASES: readonly (readonly string[])[] = [["git", "push"]];
/** Bash の接頭辞に含まれていれば外す文字（パイプ・連結・リダイレクト・背景・置換・改行） */
export const CC_ALWAYS_BASH_DENIED_CHARS: readonly string[] = ["|", ";", "&", ">", "<", "`", "$", "\n", "\r"];
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
  const first = posix.basename(words[0]!);
  if (CC_ALWAYS_BASH_DENIED_WORDS.includes(first)) return false;
  const named = [first, ...words.slice(1)];
  for (const phrase of CC_ALWAYS_BASH_DENIED_PHRASES) {
    if (named[0] !== phrase[0]) continue;
    // git … push … を含む
    if (phrase.slice(1).every((word) => named.slice(1).includes(word))) return false;
    // `git *` のように並びの手前で終わる接頭辞
    if (wildcard && named.length < phrase.length && named.every((word, i) => word === phrase[i])) return false;
  }
  return true;
}

/** パスの要素に `..` が無いか */
function noParent(path: string): boolean {
  return !path.split("/").includes("..");
}

/** ファイルのルールが ~/workspace/ の中か */
function fileRuleAllowed(ruleContent: string | undefined, ctx: { cwd?: string; workspaceDir: string }): boolean {
  if (ruleContent === undefined || ruleContent === "" || !noParent(ruleContent)) return false;
  if (ruleContent.startsWith("~/workspace/")) return ruleContent.length > "~/workspace/".length;
  // 絶対パス（`/` は設定ファイルからの相対、`//` は絶対）・ほかの `~` は使わない
  if (ruleContent.startsWith("/") || ruleContent.startsWith("~")) return false;
  const cwd = ctx.cwd;
  if (cwd === undefined || !cwd.startsWith("/") || !noParent(cwd)) return false;
  const base = ctx.workspaceDir.replace(/\/+$/, "");
  const normalized = cwd.replace(/\/+$/, "");
  return normalized === base || normalized.startsWith(`${base}/`);
}

/** 1 つのルールが常に許可の候補になるか */
function ruleAllowed(rule: CcRule, ctx: { cwd?: string; workspaceDir: string }): boolean {
  if (rule.ruleContent !== undefined && rule.ruleContent.length > CC_ALWAYS_RULE_MAX_CHARS) return false;
  if (rule.toolName === "Bash") return bashRuleAllowed(rule.ruleContent);
  if (FILE_RULE_TOOLS.has(rule.toolName)) return fileRuleAllowed(rule.ruleContent, ctx);
  if (rule.toolName === "WebFetch") return rule.ruleContent !== undefined && WEB_FETCH_RULE_PATTERN.test(rule.ruleContent);
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
 * ctx.cwd は要求の cwd、ctx.workspaceDir は ~/workspace の実際のパス
 */
export function alwaysRulesOf(
  toolName: string,
  suggestions: unknown,
  ctx: { cwd?: string; workspaceDir: string },
): CcRule[] | null {
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
