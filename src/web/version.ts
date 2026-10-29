// package.json の版（Web UI の状態に出す）
import { readFileSync } from "node:fs";

const PACKAGE_JSON = new URL("../../package.json", import.meta.url);

/** package.json の version。読めない・version が文字列でなければ null。url はテスト用 */
export function readPackageVersion(url: URL = PACKAGE_JSON): string | null {
  try {
    const parsed: unknown = JSON.parse(readFileSync(url, "utf8"));
    if (typeof parsed !== "object" || parsed === null) return null;
    const { version } = parsed as Record<string, unknown>;
    return typeof version === "string" ? version : null;
  } catch {
    return null;
  }
}
