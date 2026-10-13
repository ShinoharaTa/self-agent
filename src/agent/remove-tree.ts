// sandbox のコマンドが書ける場所（workDir の中）のものを消す共通の処理。
// Node の fs.rm（recursive）は途中でディレクトリを symlink に差し替えられると外を消しうるので、
// GNU の rm（ディレクトリを fd 基準で開き、symlink をたどらずに消していく）をシェルを通さずに呼ぶ
import { execFile } from "node:child_process";
import { isAbsolute } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/** 呼ぶ rm（PATH は引かない） */
export const RM_PATH = "/usr/bin/rm";

/**
 * path を中身ごと消す（`/usr/bin/rm -rf --one-file-system -- <path>`）。path が symlink ならリンクそのものだけを消す（指す先は消さない）。
 * 無ければ何もしない。path は絶対パスに限る。失敗したら投げる（message にパス・rm の出力は入れない）
 */
export async function removeTree(path: string): Promise<void> {
  if (!isAbsolute(path) || path.endsWith("/")) throw new Error("消す場所は末尾に / の無い絶対パスで指定してください");
  try {
    await execFileAsync(RM_PATH, ["-rf", "--one-file-system", "--", path]);
  } catch (error) {
    const code = typeof error === "object" && error !== null && "code" in error ? String(error.code) : "不明";
    throw new Error(`rm が失敗しました（${code}）`);
  }
}
