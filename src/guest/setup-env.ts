// npm run guest-setup（scripts/guest-setup.ts）の純関数。入力の形の検証と env ファイルの中身の書き換え。
// SDK・ネットワーク・ファイルに依存しない。理由の文には値を入れない

/** ゲストの 3 つの変数（docs/plan/guest-mode.md §5） */
export const GUEST_ENV_KEYS = [
  "SELF_AGENT_GUEST_DISCORD_TOKEN",
  "SELF_AGENT_GUEST_GUILD_IDS",
  "SELF_AGENT_GUEST_API_KEY",
] as const;

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

/** ゲストのサーバー ID（カンマ区切り）。各要素は 17〜20 桁の数字で、SELF_AGENT_ALLOWED_GUILD_IDS と重ならない */
export function validateGuildIds(
  value: string,
  allowedGuildIds: readonly string[],
): { ok: true; ids: string[] } | { ok: false; reason: string } {
  const items = value
    .split(",")
    .map((item) => item.trim())
    .filter((item) => item !== "");
  if (items.length === 0) return { ok: false, reason: "サーバー ID を 1 つ以上入れてください" };
  if (items.some((item) => !/^\d{17,20}$/.test(item))) {
    return { ok: false, reason: "サーバー ID は 17〜20 桁の数字をカンマ区切りで入れてください" };
  }
  const ids = [...new Set(items)];
  if (ids.some((id) => allowedGuildIds.includes(id))) {
    return { ok: false, reason: "SELF_AGENT_ALLOWED_GUILD_IDS と重なっています（ゲスト専用のサーバーを入れてください）" };
  }
  return { ok: true, ids };
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
    pattern: new RegExp(`^\\s*(?:export\\s+)?${escapeRegExp(key)}[ \\t]*=`),
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
