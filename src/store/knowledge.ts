import type { DatabaseSync, SQLInputValue, SQLOutputValue } from "node:sqlite";

/** 題名の文字数の上限 */
export const KB_TITLE_MAX_LENGTH = 100;
/** 要約の文字数の上限 */
export const KB_SUMMARY_MAX_LENGTH = 300;
/** 本文（要点・自分のメモ）の文字数の上限 */
export const KB_BODY_MAX_LENGTH = 4000;
/** タグの個数の上限（超えた分は保存しない） */
export const KB_TAGS_MAX = 5;
/** タグ 1 個の文字数の上限（超えた分は切る） */
export const KB_TAG_MAX_LENGTH = 20;
/** 検索の件数の既定値 */
export const KB_SEARCH_DEFAULT_LIMIT = 5;
/** 検索の件数の上限 */
export const KB_SEARCH_MAX_LIMIT = 10;
/** 検索に使う語の数の上限（重複を除いた先頭から） */
const QUERY_MAX_TERMS = 5;
/** 検索の 1 語の文字数の上限（超えた分は切る） */
const QUERY_TERM_MAX_LENGTH = 50;
/** これ以上の文字数の語は FTS（trigram）で、未満の語は LIKE で探す */
const FTS_MIN_TERM_LENGTH = 3;
/** LIKE で探す列（kb_fts と同じ列） */
const LIKE_COLUMNS = ["title", "summary", "body", "tags", "url"] as const;
/** 検索の並び順。bm25 の重みは kb_fts の列の順（題名・要約・本文・タグ・URL）で、題名とタグを重くする */
const BM25_ORDER = "bm25(kb_fts, 4, 2, 1, 3, 0.5)";
/** 検索で返す列（本文は返さない） */
const SEARCH_COLUMNS = "e.id, e.url, e.url_key, e.title, e.summary, e.tags, e.channel_id, e.created_at, e.updated_at";

/** ナレッジベースの 1 件（kb_entries） */
export type KbEntry = {
  id: number;
  /** URL 無しのメモは null */
  url: string | null;
  /** 呼び出し側が正規化した URL（同じ URL の判定に使う）。URL 無しのメモは null */
  urlKey: string | null;
  title: string;
  summary: string;
  /** 要点・自分のメモ。無ければ空 */
  body: string;
  /** 正規化したタグ（英字は小文字、重複なし） */
  tags: string[];
  /** 登録したチャンネル */
  channelId: string | null;
  createdAt: string;
  updatedAt: string;
};

/** 検索の 1 件。本文は含まない */
export type KbSearchEntry = Omit<KbEntry, "body">;

export type KbSearchResult = {
  entries: KbSearchEntry[];
  /** limit 件より多く見つかったか */
  more: boolean;
};

/** 保存する中身。url と urlKey は一緒に渡す（URL 無しのメモはどちらも省略する） */
export type KbEntryInput = {
  url?: string;
  /** url を呼び出し側が正規化したもの。store は URL の規則を持たない */
  urlKey?: string;
  title: string;
  summary: string;
  /** 省略すれば空 */
  body?: string;
  /** スペース（全角を含む）区切り。英字を小文字にし、重複を除き、1 個 KB_TAG_MAX_LENGTH 字・KB_TAGS_MAX 個までにして保存する */
  tags?: string;
};

export type NewKbEntry = KbEntryInput & {
  /** 登録したチャンネル */
  channelId?: string;
};

function nullableString(value: SQLOutputValue | undefined): string | null {
  return value === null || value === undefined ? null : String(value);
}

/** 先頭から length 文字（コードポイント）まで */
function truncate(text: string, length: number): string {
  const chars = [...text];
  return chars.length > length ? chars.slice(0, length).join("") : text;
}

function splitWords(text: string): string[] {
  return text.split(/\s+/u).filter((word) => word !== "");
}

function normalizeTags(tags: string | undefined): string {
  if (tags === undefined) return "";
  const normalized = splitWords(tags).map((tag) => truncate(tag.toLowerCase(), KB_TAG_MAX_LENGTH));
  return [...new Set(normalized)].slice(0, KB_TAGS_MAX).join(" ");
}

/** LIKE の \ % _ をエスケープする（ESCAPE '\' と一緒に使う） */
function escapeLike(term: string): string {
  return term.replace(/[\\%_]/g, (char) => `\\${char}`);
}

function toSearchEntry(row: Record<string, SQLOutputValue>): KbSearchEntry {
  const tags = String(row.tags);
  return {
    id: Number(row.id),
    url: nullableString(row.url),
    urlKey: nullableString(row.url_key),
    title: String(row.title),
    summary: String(row.summary),
    tags: tags === "" ? [] : tags.split(" "),
    channelId: nullableString(row.channel_id),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

function toEntry(row: Record<string, SQLOutputValue>): KbEntry {
  return { ...toSearchEntry(row), body: String(row.body) };
}

/** ナレッジベース（kb_entries と全文検索の kb_fts）。サーバーで分けず全体で 1 つ */
export class KnowledgeStore {
  private readonly db: DatabaseSync;
  private readonly now: () => Date;

  constructor(db: DatabaseSync, now: () => Date = () => new Date()) {
    this.db = db;
    this.now = now;
  }

  /** 同じ urlKey が既にあれば UNIQUE 制約のエラーを投げる（呼び出し側が先に getByUrlKey で確かめる） */
  add(entry: NewKbEntry): KbEntry {
    const at = this.now().toISOString();
    const row = this.db
      .prepare(
        "INSERT INTO kb_entries (url, url_key, title, summary, body, tags, channel_id, created_at, updated_at) " +
          "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING *",
      )
      .get(
        entry.url ?? null,
        entry.urlKey ?? null,
        entry.title,
        entry.summary,
        entry.body ?? "",
        normalizeTags(entry.tags),
        entry.channelId ?? null,
        at,
        at,
      );
    return toEntry(row!);
  }

  /**
   * 中身をすべて置き換える（省略した url・body・tags は空になる）。created_at と channel_id は変えず、updated_at だけ更新する。
   * 無い id なら undefined。他の項目と同じ urlKey にすると UNIQUE 制約のエラーを投げる
   */
  update(id: number, entry: KbEntryInput): KbEntry | undefined {
    const row = this.db
      .prepare(
        "UPDATE kb_entries SET url = ?, url_key = ?, title = ?, summary = ?, body = ?, tags = ?, updated_at = ? " +
          "WHERE id = ? RETURNING *",
      )
      .get(
        entry.url ?? null,
        entry.urlKey ?? null,
        entry.title,
        entry.summary,
        entry.body ?? "",
        normalizeTags(entry.tags),
        this.now().toISOString(),
        id,
      );
    return row === undefined ? undefined : toEntry(row);
  }

  get(id: number): KbEntry | undefined {
    const row = this.db.prepare("SELECT * FROM kb_entries WHERE id = ?").get(id);
    return row === undefined ? undefined : toEntry(row);
  }

  getByUrlKey(urlKey: string): KbEntry | undefined {
    const row = this.db.prepare("SELECT * FROM kb_entries WHERE url_key = ?").get(urlKey);
    return row === undefined ? undefined : toEntry(row);
  }

  /** 消した項目を返す。無い id なら undefined */
  delete(id: number): KbEntry | undefined {
    const row = this.db.prepare("DELETE FROM kb_entries WHERE id = ? RETURNING *").get(id);
    return row === undefined ? undefined : toEntry(row);
  }

  /**
   * query を空白（全角を含む）で区切った語をすべて含む項目を探す（AND）。重複を除いた先頭 5 語まで、1 語 50 字まで。
   * 3 文字以上の語は kb_fts のフレーズ検索、3 文字未満の語は各列の LIKE で絞る。
   * フレーズ検索の語があれば bm25 の順、無ければ新しい順（updated_at）。query に語が無ければ新しい順の一覧。
   * limit は 1〜KB_SEARCH_MAX_LIMIT（整数でなければ既定値）。本文は返さない
   */
  search(query: string, limit: number = KB_SEARCH_DEFAULT_LIMIT): KbSearchResult {
    const count = Number.isInteger(limit) ? Math.min(Math.max(limit, 1), KB_SEARCH_MAX_LIMIT) : KB_SEARCH_DEFAULT_LIMIT;
    const terms = [...new Set(splitWords(query).map((term) => truncate(term, QUERY_TERM_MAX_LENGTH)))].slice(
      0,
      QUERY_MAX_TERMS,
    );
    const phrases = terms
      .filter((term) => [...term].length >= FTS_MIN_TERM_LENGTH)
      .map((term) => `"${term.replaceAll('"', '""')}"`);
    const shortTerms = terms.filter((term) => [...term].length < FTS_MIN_TERM_LENGTH);

    const conditions: string[] = [];
    const params: SQLInputValue[] = [];
    if (phrases.length > 0) {
      conditions.push("kb_fts MATCH ?");
      params.push(phrases.join(" AND "));
    }
    for (const term of shortTerms) {
      conditions.push(`(${LIKE_COLUMNS.map((column) => `e.${column} LIKE ? ESCAPE '\\'`).join(" OR ")})`);
      const pattern = `%${escapeLike(term)}%`;
      params.push(...LIKE_COLUMNS.map(() => pattern));
    }

    const useFts = phrases.length > 0;
    const sql =
      `SELECT ${SEARCH_COLUMNS} FROM ` +
      (useFts ? "kb_fts JOIN kb_entries e ON e.id = kb_fts.rowid" : "kb_entries e") +
      (conditions.length > 0 ? ` WHERE ${conditions.join(" AND ")}` : "") +
      ` ORDER BY ${useFts ? `${BM25_ORDER}, ` : ""}e.updated_at DESC, e.id DESC LIMIT ?`;
    const rows = this.db.prepare(sql).all(...params, count + 1);
    return { entries: rows.slice(0, count).map(toSearchEntry), more: rows.length > count };
  }
}
