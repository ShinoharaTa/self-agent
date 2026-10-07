// 作って URL で渡すプロジェクトの一覧と削除（docs/plan/build-and-serve.md §3）
import { realpath, rm } from "node:fs/promises";
import { join } from "node:path";
import type { Config } from "../../config.ts";
import type { OutgoingMessage } from "../../discord/gateway.ts";
import type { Project, ProjectStore } from "../../store/projects.ts";
import type { CommandHandler, ComponentHandler } from "../interactions.ts";
import { formatDate } from "../time.ts";
import { STALE_TEXT } from "./delete.ts";
import { fitItems, omittedText } from "./sessions.ts";
import { clip } from "./tasks.ts";

export const NO_PROJECTS_TEXT = "プロジェクトはまだありません";
/** 配信の設定（SELF_AGENT_PUBLIC_BASE_URL）が無いとき、URL の代わりに出す（一覧では括弧で囲む） */
export const NOT_SERVED_TEXT = "配信は未設定";
/** [やめる] を押した後の、確認メッセージの本文 */
export const PROJECT_KEPT_TEXT = "やめました";

/** セレクトに出すプロジェクトの件数の上限（Discord のセレクトの選択肢の上限） */
export const PROJECT_SELECT_LIMIT = 25;

/** ボタン・セレクトの custom_id の名前空間（`proj:pick`、`proj:<action>:<id>`） */
const NAMESPACE = "proj";
const PICK_SELECT_ID = `${NAMESPACE}:pick`;
/** セレクトの選択肢のラベルの上限（Discord は 100 字まで） */
const OPTION_LABEL_MAX_LENGTH = 100;

export type ProjectsDeps = {
  projects: Pick<ProjectStore, "list" | "get" | "markDeleted">;
  /** `<workDir>/projects`。プロジェクトのディレクトリは `<projectsDir>/<slug>` */
  projectsDir: string;
  /** URL の組み立て（publicBaseUrl が無ければ配信は未設定）と、更新日のタイムゾーン（SELF_AGENT_TZ） */
  cfg: Pick<Config, "publicBaseUrl" | "timeZone">;
  log: (message: string) => void;
};

/** プロジェクトの URL（`<publicBaseUrl>/p/<slug>/`）。配信の設定が無ければ undefined */
function projectUrl(publicBaseUrl: string | undefined, slug: string): string | undefined {
  return publicBaseUrl === undefined ? undefined : `${publicBaseUrl}/p/${slug}/`;
}

/** 一覧の 1 行: `**題名** <url>（<#元のチャンネル>・更新 YYYY-MM-DD）`。配信の設定が無ければ url の代わりに「（配信は未設定）」 */
export function projectLine(project: Project, cfg: ProjectsDeps["cfg"]): string {
  const url = projectUrl(cfg.publicBaseUrl, project.slug) ?? `（${NOT_SERVED_TEXT}）`;
  const updated = formatDate(new Date(project.updatedAt), cfg.timeZone);
  return `**${project.title}** ${url}（<#${project.channelId}>・更新 ${updated}）`;
}

/**
 * 削除されていないプロジェクトの一覧（新しく更新した順）と、削除するものを選ぶセレクト（`proj:pick`、新しい順に最大 25 件）。
 * 2000 字を超えるなら末尾から削って「ほか n 件」を足す。0 件なら「プロジェクトはまだありません」だけ
 */
export function projectListMessage(deps: Pick<ProjectsDeps, "projects" | "cfg">): OutgoingMessage {
  const { projects, cfg } = deps;
  const list = projects.list();
  if (list.length === 0) return { text: NO_PROJECTS_TEXT, components: [] };
  const { text } = fitItems(list, (shown, omitted) =>
    [...shown.map((project) => projectLine(project, cfg)), ...(omitted > 0 ? [omittedText(omitted)] : [])].join("\n"),
  );
  return {
    text,
    components: [
      {
        kind: "select",
        select: {
          customId: PICK_SELECT_ID,
          placeholder: "削除するプロジェクトを選ぶ",
          minValues: 1,
          maxValues: 1,
          options: list.slice(0, PROJECT_SELECT_LIMIT).map((project) => ({
            label: clip(project.title, OPTION_LABEL_MAX_LENGTH),
            value: String(project.id),
            description: project.slug,
          })),
        },
      },
    ],
  };
}

/** 削除の確認。[削除する]（`proj:del:<id>`）でディレクトリごと消し、[やめる]（`proj:keep:<id>`）で何もしない */
export function projectDeletePrompt(
  project: Pick<Project, "id" | "slug" | "title">,
  publicBaseUrl: string | undefined,
): OutgoingMessage {
  const { id, slug, title } = project;
  // 配信の設定が無ければ、括弧の中を URL の代わりに「配信は未設定」にする
  const where = projectUrl(publicBaseUrl, slug) ?? NOT_SERVED_TEXT;
  return {
    text: `${title}（${where}）を削除しますか？ ページは開けなくなり、ファイルも消えます`,
    components: [
      {
        kind: "buttons",
        buttons: [
          { customId: `${NAMESPACE}:del:${id}`, label: "削除する", style: "danger" },
          { customId: `${NAMESPACE}:keep:${id}`, label: "やめる" },
        ],
      },
    ],
  };
}

export function projectDeletedText(title: string): string {
  return `削除しました: ${title}`;
}

/** id の文字列（1 以上の整数）。それ以外なら undefined */
function parseId(raw: string | undefined): number | undefined {
  return raw !== undefined && /^[1-9]\d*$/.test(raw) ? Number(raw) : undefined;
}

/** `<projectsDir>/<slug>` の realpath。projectsDir の直下のそのディレクトリそのもの（symlink でない）でなければ・確かめられなければ undefined */
async function verifiedProjectDir(projectsDir: string, slug: string): Promise<string | undefined> {
  try {
    const base = await realpath(projectsDir);
    const real = await realpath(join(projectsDir, slug));
    return real === join(base, slug) ? real : undefined;
  } catch {
    return undefined;
  }
}

/** `<projectsDir>/<slug>` を消す。直下だと確かめられなければ消さずに log。消すのに失敗しても log だけ（slug・パスは出さない） */
async function removeProjectDir(projectsDir: string, slug: string, log: (message: string) => void): Promise<void> {
  const target = await verifiedProjectDir(projectsDir, slug);
  if (target === undefined) {
    log("プロジェクトのディレクトリを確かめられないため消しませんでした");
    return;
  }
  try {
    await rm(target, { recursive: true });
  } catch {
    log("プロジェクトのディレクトリを消せませんでした");
  }
}

/** `/projects`: 作ったプロジェクトの一覧を本人にだけ表示し、セレクトで削除するものを選べるようにする */
export function createProjectsCommand(deps: ProjectsDeps): CommandHandler {
  return {
    def: { name: "projects", description: "作ったページ（プロジェクト）の一覧を表示します（選んで削除できます）" },
    async handle(_interaction, responder) {
      await responder.reply({ ...projectListMessage(deps), ephemeral: true });
    },
  };
}

/**
 * 一覧のセレクト（`proj:pick`）で削除の確認を本人にだけ出し、確認の [削除する]（`proj:del:<id>`）・[やめる]（`proj:keep:<id>`）を受ける。
 * [削除する] は削除済みにしてから `<projectsDir>/<slug>` を消す（消せなくても削除済みのまま）。無い・削除済みなら「古くなっています」。
 * DB の状態で動くので、再起動の後でも押せる
 */
export function createProjectsComponent(deps: ProjectsDeps): ComponentHandler {
  const { projects, projectsDir, cfg, log } = deps;
  return {
    namespace: NAMESPACE,
    async handle(interaction, responder) {
      if (interaction.customId === PICK_SELECT_ID) {
        if (interaction.kind !== "select") throw new Error(`proj の不明な操作です（${interaction.kind} pick）`);
        const id = parseId(interaction.values[0]);
        if (id === undefined) throw new Error("proj:pick の選択に id がありません");
        const project = projects.get(id);
        // 一覧を出した後に別の一覧から削除された
        if (project === undefined || project.deletedAt !== null) {
          await responder.reply({ text: STALE_TEXT, ephemeral: true });
          return;
        }
        await responder.reply({ ...projectDeletePrompt(project, cfg.publicBaseUrl), ephemeral: true });
        return;
      }

      const [, action, rawId] = interaction.customId.split(":");
      const id = parseId(rawId);
      if (id === undefined) throw new Error("proj の custom_id に id がありません");
      if (interaction.kind !== "button" || (action !== "del" && action !== "keep")) {
        throw new Error(`proj の不明な操作です（${interaction.kind} ${action ?? ""}）`);
      }
      if (action === "keep") {
        await responder.update({ text: PROJECT_KEPT_TEXT, components: [] });
        return;
      }
      // ディレクトリを消すのに時間がかかることがあるので先に保留する（確認メッセージはまだ変えない）
      await responder.deferUpdate();
      // 引いてから削除済みにするまで await を挟まない
      const project = projects.get(id);
      if (project === undefined || !projects.markDeleted(id)) {
        await responder.update({ text: STALE_TEXT, components: [] });
        return;
      }
      await removeProjectDir(projectsDir, project.slug, log);
      log("[削除する] でプロジェクトを削除しました");
      await responder.update({ text: projectDeletedText(project.title), components: [] });
    },
  };
}
