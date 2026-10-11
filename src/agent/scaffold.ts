// project_open がプロジェクトに置く UI の土台（リポジトリの templates/web/）の複製。既にあるファイルは上書きしない
import { constants } from "node:fs";
import { copyFile, lstat, mkdir, realpath, stat } from "node:fs/promises";
import { join, sep } from "node:path";
import { fileURLToPath } from "node:url";

/** 複製の元（リポジトリの templates/web/）の絶対パス */
export const WEB_TEMPLATE_DIR = fileURLToPath(new URL("../../templates/web/", import.meta.url));

/** 新しいプロジェクト（created）に複製するもの。dir からの相対パスで、この順に複製して返す */
const CREATED_FILES = ["DESIGN.md", "site/base.css", "site/app.css", "site/icons.svg", "site/index.html"];
/** 既にあるプロジェクト（existing）で site/base.css が無いときだけ足すもの */
const EXISTING_FILES = ["DESIGN.md", "site/base.css", "site/icons.svg"];

/** 複製の結果。copied は複製できたものの dir からの相対パス（`/` 区切り）、failed は既にある以外の理由で複製できなかったものがあるか */
export type ScaffoldResult = { copied: string[]; failed: boolean };

function hasCode(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}

/** `<dir>/site` の realpath が realpath(dir) の中か（site が外への symlink なら false） */
async function siteInsideDir(dir: string): Promise<boolean> {
  const base = await realpath(dir);
  const site = await realpath(join(dir, "site"));
  return site.startsWith(base + sep);
}

/**
 * templateDir の土台を dir（`<projectsDir>/<slug>`）に複製する。
 * created は 5 つ、existing は `<dir>/site/base.css` が無いときだけ 3 つ（あれば何もしない。dir ごと無ければ作り直して 3 つ置く）。
 * 既にあるファイル（symlink を含む）は上書きせずに飛ばす。それ以外の失敗はそのファイルだけ飛ばして続け、failed にする。
 * existing の判定・mkdir に失敗したとき、site が dir の外への symlink のときは何も複製せず failed
 */
export async function copyWebScaffold(
  dir: string,
  mode: "created" | "existing",
  templateDir = WEB_TEMPLATE_DIR,
): Promise<ScaffoldResult> {
  if (mode === "existing") {
    try {
      await lstat(join(dir, "site", "base.css"));
      return { copied: [], failed: false };
    } catch (error) {
      if (!hasCode(error, "ENOENT")) return { copied: [], failed: true };
    }
  }
  try {
    await mkdir(join(dir, "site"), { recursive: true });
    if (!(await siteInsideDir(dir))) return { copied: [], failed: true };
  } catch {
    return { copied: [], failed: true };
  }
  const copied: string[] = [];
  let failed = false;
  for (const file of mode === "created" ? CREATED_FILES : EXISTING_FILES) {
    try {
      await copyFile(join(templateDir, file), join(dir, file), constants.COPYFILE_EXCL);
      copied.push(file);
    } catch (error) {
      if (!hasCode(error, "EEXIST")) failed = true;
    }
  }
  return { copied, failed };
}

/** `<dir>/DESIGN.md` と `<dir>/site/base.css` が両方あるか（project_open の注意で DESIGN.md を読ませてよいか） */
export async function hasWebScaffold(dir: string): Promise<boolean> {
  try {
    await stat(join(dir, "DESIGN.md"));
    await stat(join(dir, "site", "base.css"));
    return true;
  } catch {
    return false;
  }
}
