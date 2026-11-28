import type { DatabaseSync, SQLOutputValue } from "node:sqlite";

/**
 * 話題（sessions）と入口（persona_channels）の場所（列 place。docs/plan/personas-web-antigravity.md §3.1）。
 * discord は Discord のチャンネル、local は Web だけの人格の、Discord に何も作らない場所。番号の形や設定では決めない
 */
export type ChannelPlace = "discord" | "local";

const PLACES: readonly ChannelPlace[] = ["discord", "local"];

/** DB の place の値を読む。決めた語でなければ投げる（CHECK で入らないはずの値） */
export function toChannelPlace(value: SQLOutputValue | undefined, column: string): ChannelPlace {
  const place = PLACES.find((candidate) => candidate === value);
  if (place === undefined) throw new Error(`${column} が不正です: ${String(value)}`);
  return place;
}

/** ローカルの番号の、先頭の 1 の後ろの桁数（連番を 0 で埋める） */
const LOCAL_ID_SEQUENCE_DIGITS = 20;

/**
 * ローカルの番号（チャンネルにもメッセージにも同じ連番を使う）。先頭が 1 の数字 21 桁で、Discord の ID（20 桁まで）と重ならない。
 * 連番は local_ids の AUTOINCREMENT（取った行はすぐ消す）。番号を使い直さないのは、トランザクションの外で取ったときだけ
 * （中で取って巻き戻ると、同じ番号がもう一度出る）。なので next はトランザクションの中では投げる
 */
export class LocalIdStore {
  private readonly db: DatabaseSync;

  constructor(db: DatabaseSync) {
    this.db = db;
  }

  /** 新しい番号を 1 つ取る。続けて取ると違う値。トランザクションの中で呼ぶと投げる */
  next(): string {
    if (this.db.isTransaction) throw new Error("ローカルの番号はトランザクションの外で取ってください");
    const row = this.db.prepare("INSERT INTO local_ids DEFAULT VALUES RETURNING id").get();
    const id = Number(row!.id);
    this.db.prepare("DELETE FROM local_ids WHERE id = ?").run(id);
    return `1${String(id).padStart(LOCAL_ID_SEQUENCE_DIGITS, "0")}`;
  }
}
