// GET /api/projects・/api/projects/<slug>/files・/api/projects/<slug>/file?path=（docs/plan/web-ui.md §7.4）。作ったプロジェクトの一覧と、
// ファイルの一覧・中身を読むだけ（agent/project-listing.ts）。slug は削除されていないプロジェクトのものだけ。配信が無効でも一覧は出す（url は null）。
// ページは別のオリジン（静的サーバー）なので画面は埋め込まずリンクにする。log にパス・slug・中身は出さない
import { listProjectFiles, readProjectFile, type ProjectListingHooks, type ReadProjectFileResult } from "../../agent/project-listing.ts";
import type { Config } from "../../config.ts";
import type { Project, ProjectStore } from "../../store/projects.ts";
import type { Route, RouteResult } from "../server.ts";

export type ProjectRouteDeps = {
  cfg: Pick<Config, "publicBaseUrl">;
  projects: Pick<ProjectStore, "list" | "getBySlug">;
  /** `<realpath(workDir)>/projects` */
  projectsDir: string;
  /** チャンネルの表示名（セッションは題名、入口は #<名前>）。分からなければ null */
  channelName: (channelId: string) => string | null;
  /** テスト用（project-listing.ts の beforeOpen） */
  hooks?: ProjectListingHooks;
};

const NOT_FOUND: RouteResult = { status: 404, json: { error: "not_found" } };

/** readProjectFile の失敗 → 応答 */
const READ_FAILURES: Readonly<Record<Exclude<ReadProjectFileResult, { text: string }>, RouteResult>> = {
  not_found: NOT_FOUND,
  invalid_path: { status: 400, json: { error: "invalid_path" } },
  too_large: { status: 413, json: { error: "too_large" } },
  binary: { status: 415, json: { error: "binary" } },
};

/** slug の形（store/projects.ts の toSlug: 英小文字・数字・`-`、30 字まで） */
const SLUG = "([a-z0-9-]{1,30})";

export function projectRoutes(deps: ProjectRouteDeps): Route[] {
  const { cfg, projects, projectsDir, channelName, hooks } = deps;

  const projectOf = (project: Project) => ({
    slug: project.slug,
    title: project.title,
    channelId: project.channelId,
    channelTitle: channelName(project.channelId),
    updatedAt: project.updatedAt,
    url: cfg.publicBaseUrl === undefined ? null : `${cfg.publicBaseUrl}/p/${project.slug}/`,
  });

  return [
    {
      method: "GET",
      pattern: /^\/api\/projects$/,
      handle: async () => ({ status: 200, json: { projects: projects.list().map(projectOf) } }),
    },
    {
      method: "GET",
      pattern: new RegExp(`^/api/projects/${SLUG}/files$`),
      handle: async ({ params }) => {
        const project = projects.getBySlug(params[0] ?? "");
        if (project === undefined) return NOT_FOUND;
        const listed = await listProjectFiles(projectsDir, project.slug);
        if (listed === undefined) return NOT_FOUND;
        return { status: 200, json: { files: listed.files, truncated: listed.truncated } };
      },
    },
    {
      method: "GET",
      pattern: new RegExp(`^/api/projects/${SLUG}/file$`),
      handle: async ({ params, query }) => {
        const project = projects.getBySlug(params[0] ?? "");
        if (project === undefined) return NOT_FOUND;
        const path = query.get("path");
        if (path === null) return READ_FAILURES.invalid_path;
        const result = await readProjectFile(projectsDir, project.slug, path, hooks);
        if (typeof result === "string") return READ_FAILURES[result];
        return { status: 200, json: { path, text: result.text } };
      },
    },
  ];
}
