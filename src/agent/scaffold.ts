// project_open がプロジェクトに置く UI の土台（リポジトリの templates/web/）の複製。既にあるファイルは上書きしない
import { constants } from "node:fs";
import { copyFile, lstat, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/** 複製の元（リポジトリの templates/web/）の絶対パス */
export const WEB_TEMPLATE_DIR = fileURLToPath(new URL("../../templates/web/", import.meta.url));

/** 新しいプロジェクト（created）に複製するもの。dir からの相対パスで、この順に複製して返す */
const CREATED_FILES = ["DESIGN.md", "site/base.css", "site/app.css", "site/icons.svg", "site/index.html"];
/** 既にあるプロジェクト（existing）で site/base.css が無いときだけ足すもの */
const EXISTING_FILES = ["DESIGN.md", "site/base.css", "site/icons.svg"];

function hasCode(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}

/**
 * templateDir の土台を dir（`<projectsDir>/<slug>`）に複製し、複製したものの dir からの相対パス（`/` 区切り）を返す。
 * created は 5 つ、existing は `<dir>/site/base.css` が無いときだけ 3 つ（あれば何もしない）。
 * 既にあるファイルは上書きせずに飛ばす。それ以外の失敗は投げる（呼び出し側で扱う）
 */
export async function copyWebScaffold(
  dir: string,
  mode: "created" | "existing",
  templateDir = WEB_TEMPLATE_DIR,
): Promise<string[]> {
  if (mode === "existing") {
    try {
      await lstat(join(dir, "site", "base.css"));
      return [];
    } catch (error) {
      if (!hasCode(error, "ENOENT")) throw error;
    }
  }
  await mkdir(join(dir, "site"), { recursive: true });
  const copied: string[] = [];
  for (const file of mode === "created" ? CREATED_FILES : EXISTING_FILES) {
    try {
      await copyFile(join(templateDir, file), join(dir, file), constants.COPYFILE_EXCL);
      copied.push(file);
    } catch (error) {
      if (!hasCode(error, "EEXIST")) throw error;
    }
  }
  return copied;
}
