// self-agent コマンドの env ファイルの読み込み（docs/plan/distribution.md §4.3）。npm run * では node の --env-file-if-exists が先に読み、
// ここでは既にある変数を上書きしないので、二重に読んでも結果は同じ
import { homedir } from "node:os";
import { join } from "node:path";

/** 読む env ファイルの場所を変える変数（self-agent コマンドのときだけ効く） */
export const ENV_FILE_VAR = "SELF_AGENT_ENV_FILE";

/** 読む env ファイル。SELF_AGENT_ENV_FILE があれば（空は無いものとする）それ、無ければ ~/.config/self-agent/env */
export function envFilePath(env: NodeJS.ProcessEnv = process.env, homeDir: string = homedir()): string {
  const path = env[ENV_FILE_VAR];
  return path === undefined || path === "" ? join(homeDir, ".config", "self-agent", "env") : path;
}

/** loaded: 読んだ、missing: ファイルが無い（何もしない）、failed: それ以外の理由で読めなかった */
export type LoadEnvResult = "loaded" | "missing" | "failed";

/** path の env ファイルを読む（load の既定は process.loadEnvFile。既にある変数は上書きしない）。例外は投げず結果で返す */
export function loadEnv(path: string, load: (path: string) => void = process.loadEnvFile): LoadEnvResult {
  try {
    load(path);
    return "loaded";
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return "missing";
    return "failed";
  }
}
