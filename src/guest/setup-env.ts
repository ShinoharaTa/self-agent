// npm run guest-setup（scripts/guest-setup.ts）の純関数。入力の形の検証と env ファイルの中身の書き換え。
// SDK・ネットワーク・ファイルに依存しない。理由の文には値を入れない

/** ゲストの 2 つの変数（docs/plan/guest-mode.md §5） */
export const GUEST_ENV_KEYS = ["SELF_AGENT_GUEST_DISCORD_TOKEN", "SELF_AGENT_GUEST_API_KEY"] as const;

/** v3 で廃止した変数（残っていると起動時に設定エラー。§3.2.1） */
export const GUEST_DEPRECATED_ENV_KEYS = ["SELF_AGENT_GUEST_GUILD_IDS"] as const;

/** 追加するときに 1 回だけ置くコメント */
const APPEND_COMMENT = "# guest mode (npm run guest-setup)";

/** 空白・# ・引用符・\ を含まず、ASCII の印字可能文字だけか。問題があれば理由 */
function plainAscii(value: string): string | undefined {
  if (/[\s#"'`\\]/.test(value)) return "空白・#・引用符・\\ を含められません";
  if (!/^[\x21-\x7e]+$/.test(value)) return "ASCII の文字だけで入力してください";
  return undefined;
}

/** Discord の Bot のトークンの形。問題があれば短い理由 */
export function validateDiscordToken(value: string): string | undefined {
  const token = value.trim();
  if (token === "") return "トークンが空です";
  const plain = plainAscii(token);
  if (plain !== undefined) return plain;
  const parts = token.split(".");
  if (parts.length !== 3 || parts.some((part) => part === "")) {
    return "トークンの形が違います（. で区切られた 3 つの部分）";
  }
  return undefined;
}

/** Claude Platform の API キーの形。問題があれば短い理由 */
export function validateApiKey(value: string): string | undefined {
  const key = value.trim();
  if (key === "") return "API キーが空です";
  const plain = plainAscii(key);
  if (plain !== undefined) return plain;
  if (!key.startsWith("sk-ant-")) return "API キーは sk-ant- で始まります";
  if (key.length < 20) return "API キーが短すぎます";
  return undefined;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** 変数の行の形（先頭の空白と省略可の `export`＋空白・タブを除いて `KEY` で始まり、`=` の前に空白・タブがあってもよい） */
function envLinePattern(key: string): RegExp {
  return new RegExp(`^\\s*(?:export\\s+)?${escapeRegExp(key)}[ \\t]*=`);
}

/**
 * env ファイルの中身に変数を書き込んだ新しい中身。同じ変数の行（先頭の空白と省略可の `export`＋空白・タブを除いて `KEY` で始まり、
 * `=` の前に空白・タブがあってもよい行。Node の --env-file はキーを trim するため）が
 * あれば最初の 1 行を `KEY=value` に置き換え、2 行目以降の同じ変数の行は消す（後の行が勝つため）。無ければ末尾にコメント 1 行の後に足す。
 * ほかの行は変えない。値は引用符で囲まずにそのまま書く（呼び出し側が検証済み）
 */
export function upsertEnvLines(
  text: string,
  entries: ReadonlyArray<readonly [key: string, value: string]>,
): { text: string; replaced: string[]; appended: string[] } {
  const matchers = entries.map(([key, value]) => ({
    key,
    value,
    pattern: envLinePattern(key),
  }));
  const replaced: string[] = [];
  const lines = text === "" ? [] : text.split("\n");
  const kept: string[] = [];
  for (const line of lines) {
    const matcher = matchers.find((candidate) => candidate.pattern.test(line));
    if (matcher === undefined) {
      kept.push(line);
      continue;
    }
    if (replaced.includes(matcher.key)) continue;
    replaced.push(matcher.key);
    kept.push(`${matcher.key}=${matcher.value}`);
  }
  let result = kept.join("\n");
  const toAppend = matchers.filter((matcher) => !replaced.includes(matcher.key));
  if (toAppend.length > 0) {
    if (result !== "" && !result.endsWith("\n")) result += "\n";
    result += `${APPEND_COMMENT}\n`;
    for (const matcher of toAppend) result += `${matcher.key}=${matcher.value}\n`;
  }
  return { text: result, replaced, appended: toAppend.map((matcher) => matcher.key) };
}

/**
 * env ファイルの中身から keys の変数の行（upsertEnvLines と同じ形。`export` 付き・`=` の前の空白を含む）をすべて消した新しい中身と、
 * 消した変数（keys の順）。ほかの行は変えない
 */
export function removeEnvLines(text: string, keys: readonly string[]): { text: string; removed: string[] } {
  const matchers = keys.map((key) => ({ key, pattern: envLinePattern(key) }));
  const found = new Set<string>();
  const kept: string[] = [];
  for (const line of text === "" ? [] : text.split("\n")) {
    const matcher = matchers.find((candidate) => candidate.pattern.test(line));
    if (matcher === undefined) {
      kept.push(line);
      continue;
    }
    found.add(matcher.key);
  }
  return { text: kept.join("\n"), removed: keys.filter((key) => found.has(key)) };
}

/** トークンの最初の部分（base64 の Bot のユーザー ID）を復号した数字の ID。取れなければ undefined（投げない） */
export function extractDiscordBotId(token: string): string | undefined {
  const head = token.trim().split(".")[0] ?? "";
  if (head === "") return undefined;
  for (const encoding of ["base64", "base64url"] as const) {
    try {
      const decoded = Buffer.from(head, encoding).toString("utf8");
      if (/^\d+$/.test(decoded)) return decoded;
    } catch {
      // 次の形を試す
    }
  }
  return undefined;
}
