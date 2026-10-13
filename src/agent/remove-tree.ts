// sandbox のコマンドが書ける場所（workDir の中）のものを消す共通の処理。
// Node の fs.rm（recursive）は途中でディレクトリを symlink に差し替えられると外を消しうるので、
// GNU の rm・find（ディレクトリを fd 基準で開き、symlink をたどらずに消していく）をシェルを通さずに呼ぶ
import { spawn } from "node:child_process";
import { isAbsolute } from "node:path";

/** 呼ぶ rm（PATH は引かない） */
export const RM_PATH = "/usr/bin/rm";
/** 呼ぶ find（PATH は引かない） */
export const FIND_PATH = "/usr/bin/find";

/**
 * file を args で実行し、終了コード 0 なら resolve する。シェルは通さず、出力は受け取らない（stdio は捨てる。大量の出力で止まらない）。
 * 0 以外・シグナルで終わった・起動できなければ `<name> が失敗しました（<コード>）` で reject する（message にパス・出力は入れない）
 */
export function runQuiet(name: string, file: string, args: readonly string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, { stdio: "ignore" });
    child.once("error", (error) => {
      const code = "code" in error ? String(error.code) : "不明";
      reject(new Error(`${name} が失敗しました（${code}）`));
    });
    child.once("close", (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(`${name} が失敗しました（${code ?? signal ?? "不明"}）`));
    });
  });
}

/**
 * path を中身ごと消す（`/usr/bin/rm -rf --one-file-system -- <path>`）。path が symlink ならリンクそのものだけを消す（指す先は消さない）。
 * 無ければ何もしない。path は絶対パスに限る。失敗したら投げる（message にパス・rm の出力は入れない）
 */
export async function removeTree(path: string): Promise<void> {
  if (!isAbsolute(path) || path.endsWith("/")) throw new Error("消す場所は末尾に / の無い絶対パスで指定してください");
  await runQuiet("rm", RM_PATH, ["-rf", "--one-file-system", "--", path]);
}
