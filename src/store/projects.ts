import type { DatabaseSync, SQLOutputValue } from "node:sqlite";

/** slug の文字数の上限（重複を避けて付ける `-2` などを含む） */
export const PROJECT_SLUG_MAX_LENGTH = 30;
/** slug の文字数の下限。作った結果がこれより短ければ FALLBACK_SLUG にする */
const PROJECT_SLUG_MIN_LENGTH = 3;
const FALLBACK_SLUG = "app";
/** 題名の文字数の上限 */
export const PROJECT_TITLE_MAX_LENGTH = 100;

/** 作って URL で渡すプロジェクト（projects） */
export type Project = {
  id: number;
  guildId: string;
  /** 作ったセッションのチャンネル */
  channelId: string;
  /** URL とディレクトリの名前（英小文字・数字・`-`）。削除済みのものとも重ならない */
  slug: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  /** 削除した時刻。削除されていなければ null */
  deletedAt: string | null;
};

export type NewProject = {
  guildId: string;
  channelId: string;
  /** slug の元にする名前（toSlug で変換する） */
  name: string;
  /** 前後の空白を除いて PROJECT_TITLE_MAX_LENGTH 字まで。空なら slug */
  title: string;
};

/** 先頭から length 文字（コードポイント）まで */
function truncate(text: string, length: number): string {
  const chars = [...text];
  return chars.length > length ? chars.slice(0, length).join("") : text;
}

/**
 * 名前から slug を作る。小文字にし、英小文字・数字以外を `-` にし、連続する `-` を 1 つに、前後の `-` を除き、
 * PROJECT_SLUG_MAX_LENGTH 字に切る（切った末尾の `-` も除く）。3 字未満なら `app`
 */
export function toSlug(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, PROJECT_SLUG_MAX_LENGTH)
    .replace(/-$/, "");
  return slug.length < PROJECT_SLUG_MIN_LENGTH ? FALLBACK_SLUG : slug;
}

function nullableString(value: SQLOutputValue | undefined): string | null {
  return value === null || value === undefined ? null : String(value);
}

function toProject(row: Record<string, SQLOutputValue>): Project {
  return {
    id: Number(row.id),
    guildId: String(row.guild_id),
    channelId: String(row.channel_id),
    slug: String(row.slug),
    title: String(row.title),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
    deletedAt: nullableString(row.deleted_at),
  };
}

/** 作って URL で渡すプロジェクト。消すときは論理削除にし、slug は削除後も使わない */
export class ProjectStore {
  private readonly db: DatabaseSync;
  private readonly now: () => Date;

  constructor(db: DatabaseSync, now: () => Date = () => new Date()) {
    this.db = db;
    this.now = now;
  }

  /**
   * name から slug を作って保存する。slug が既にあれば（削除済みを含む）、本体を切り詰めて `-2`、`-3`… を付ける。
   * そのチャンネルに削除されていないプロジェクトがあれば UNIQUE 制約のエラーを投げる（呼び出し側が先に getByChannel で確かめる）
   */
  create(project: NewProject): Project {
    const slug = this.uniqueSlug(toSlug(project.name));
    const title = truncate(project.title.trim(), PROJECT_TITLE_MAX_LENGTH);
    const at = this.now().toISOString();
    const row = this.db
      .prepare(
        "INSERT INTO projects (guild_id, channel_id, slug, title, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?) RETURNING *",
      )
      .get(project.guildId, project.channelId, slug, title === "" ? slug : title, at, at);
    return toProject(row!);
  }

  /** そのチャンネルの削除されていないプロジェクト */
  getByChannel(channelId: string): Project | undefined {
    const row = this.db.prepare("SELECT * FROM projects WHERE channel_id = ? AND deleted_at IS NULL").get(channelId);
    return row === undefined ? undefined : toProject(row);
  }

  /** その slug の削除されていないプロジェクト */
  getBySlug(slug: string): Project | undefined {
    const row = this.db.prepare("SELECT * FROM projects WHERE slug = ? AND deleted_at IS NULL").get(slug);
    return row === undefined ? undefined : toProject(row);
  }

  /** 削除済みも返す */
  get(id: number): Project | undefined {
    const row = this.db.prepare("SELECT * FROM projects WHERE id = ?").get(id);
    return row === undefined ? undefined : toProject(row);
  }

  /** 削除されていないプロジェクトを新しく更新した順に */
  list(): Project[] {
    return this.db
      .prepare("SELECT * FROM projects WHERE deleted_at IS NULL ORDER BY updated_at DESC, id DESC")
      .all()
      .map(toProject);
  }

  /** 更新日時を今にする。削除済みなら何もしない */
  touch(id: number): void {
    this.db
      .prepare("UPDATE projects SET updated_at = ? WHERE id = ? AND deleted_at IS NULL")
      .run(this.now().toISOString(), id);
  }

  /** 削除済みにする。無い id・既に削除済みなら何もせず false */
  markDeleted(id: number): boolean {
    const result = this.db
      .prepare("UPDATE projects SET deleted_at = ? WHERE id = ? AND deleted_at IS NULL")
      .run(this.now().toISOString(), id);
    return Number(result.changes) > 0;
  }

  /** base がまだ使われていなければ base、使われていれば（削除済みを含む）`-2` から順に空いているものを付ける */
  private uniqueSlug(base: string): string {
    const exists = this.db.prepare("SELECT 1 FROM projects WHERE slug = ?");
    if (exists.get(base) === undefined) return base;
    for (let n = 2; ; n++) {
      const suffix = `-${n}`;
      const candidate = base.slice(0, PROJECT_SLUG_MAX_LENGTH - suffix.length).replace(/-$/, "") + suffix;
      if (exists.get(candidate) === undefined) return candidate;
    }
  }
}
