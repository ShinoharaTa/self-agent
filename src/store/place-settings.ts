import type { DatabaseSync, SQLOutputValue } from "node:sqlite";

/**
 * 場所ごとの担当の表示名と既定のモデル（place_settings。v47。docs/plan/models.md §4）。
 * place は `general` か `p:<名前>`（プロジェクトは SELF_AGENT_WORKSPACE_DIR の直下の名前）。model は agent/models.ts の key（完全な ID ではない）。
 * 形の検証は呼び出し側
 */
export type PlaceSetting = {
  place: string;
  /** 担当の表示名。無ければ null */
  label: string | null;
  /** 既定のモデルの key。無ければ null（全体の既定に従う） */
  model: string | null;
  updatedAt: string;
};

function nullableString(value: SQLOutputValue | undefined): string | null {
  return value === null || value === undefined ? null : String(value);
}

function toSetting(row: Record<string, SQLOutputValue>): PlaceSetting {
  return {
    place: String(row.place),
    label: nullableString(row.label),
    model: nullableString(row.model),
    updatedAt: String(row.updated_at),
  };
}

export class PlaceSettingStore {
  private readonly db: DatabaseSync;
  private readonly now: () => Date;

  constructor(db: DatabaseSync, now: () => Date = () => new Date()) {
    this.db = db;
    this.now = now;
  }

  /** その場所の設定。行が無ければ undefined */
  get(place: string): PlaceSetting | undefined {
    const row = this.db.prepare("SELECT * FROM place_settings WHERE place = ?").get(place);
    return row === undefined ? undefined : toSetting(row);
  }

  /** その場所の表示名と既定のモデルを置き換える（無ければ足す。null は「無し」）。更新日時は今 */
  set(place: string, setting: { label: string | null; model: string | null }): PlaceSetting {
    const row = this.db
      .prepare(
        "INSERT INTO place_settings (place, label, model, updated_at) VALUES (?, ?, ?, ?) " +
          "ON CONFLICT(place) DO UPDATE SET label = excluded.label, model = excluded.model, updated_at = excluded.updated_at RETURNING *",
      )
      .get(place, setting.label, setting.model, this.now().toISOString());
    return toSetting(row!);
  }

  /** 全部の行（place の順） */
  list(): PlaceSetting[] {
    return this.db.prepare("SELECT * FROM place_settings ORDER BY place").all().map(toSetting);
  }
}
