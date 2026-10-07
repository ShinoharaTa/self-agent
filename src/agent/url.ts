// URL の正規化。WebFetch の許可（sdk-runner.ts）とナレッジの url_key（tools.ts）で共通に使う

/**
 * WebFetch の URL の比較用の形。解析できなければ undefined。フラグメントを除き、パスの末尾の / を 1 つ除く。
 * スキームとホストは URL の解析で小文字になる。クエリはそのまま（完全一致で比べる）
 */
export function normalizeUrl(raw: string): string | undefined {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return undefined;
  }
  url.hash = "";
  // http(s) のルートは空にできず / のまま残るので、末尾の / の有無は同じ形になる
  if (url.pathname.endsWith("/")) url.pathname = url.pathname.slice(0, -1);
  return url.href;
}
