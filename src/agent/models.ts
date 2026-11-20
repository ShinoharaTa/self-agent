// 話題を始めるときに選べるモデルの一覧（docs/plan/models.md §2。#451）。SDK の別名（opus など）は渡さず、完全な ID だけを持つ
// （CLI を上げると別名の指す先が動き、進行中の会話が黙って変わるため）。セッションには完全な ID を、場所の既定には key を置く

export type ModelChoice = {
  /** 系列の名前（/new の choices・場所の既定・session_open の引数） */
  key: string;
  /** 画面の字 */
  label: string;
  /** SDK に渡す完全な ID */
  model: string;
};

/** 一覧（この順に出す）。変えるのは年に数回 */
export const MODEL_CHOICES: readonly ModelChoice[] = [
  { key: "opus", label: "Opus 5.5", model: "claude-opus-5-5" },
  { key: "sonnet", label: "Sonnet 5.5", model: "claude-sonnet-5-5" },
  { key: "haiku", label: "Haiku 4.5", model: "claude-haiku-4-5" },
];

/** key（前後の空白を除き、大文字小文字は区別しない）の行。一覧に無ければ undefined。完全な ID では引かない */
export function resolveModelKey(key: string): ModelChoice | undefined {
  const wanted = key.trim().toLowerCase();
  return MODEL_CHOICES.find((choice) => choice.key === wanted);
}

/** 名前の比べ方（空白（全角も）を全部除いて小文字に） */
function nameForm(name: string): string {
  return name.replace(/\s/gu, "").toLowerCase();
}

/**
 * 右腕の session_open の model の名前の行: key・画面の字・完全な ID のどれか（空白と大文字小文字は見ない）。一覧に無ければ undefined。
 * /new・Web・場所の既定は resolveModelKey（key だけ）
 */
export function resolveModelName(name: string): ModelChoice | undefined {
  const wanted = nameForm(name);
  if (wanted === "") return undefined;
  return MODEL_CHOICES.find((choice) => [choice.key, choice.label, choice.model].some((candidate) => nameForm(candidate) === wanted));
}

/** 完全な ID の画面の字。一覧に無ければ ID そのまま */
export function labelOf(id: string): string {
  return MODEL_CHOICES.find((choice) => choice.model === id)?.label ?? id;
}

/** 使える key の一覧（一覧の順） */
export function modelKeys(): string[] {
  return MODEL_CHOICES.map((choice) => choice.key);
}

/** 最初の投稿・取り込みの完了の文に足すモデルの 1 行（句点なし。一覧に無い ID は ID のまま） */
export function modelLine(id: string): string {
  return `モデル: ${labelOf(id)}`;
}
