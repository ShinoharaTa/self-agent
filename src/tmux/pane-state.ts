// Claude Code のペインが入力待ちか（docs/plan/github-notifications.md §5.3）。送ってよいのは idle のときだけ。
// 判定は純関数（classifyPane）で、撮るのは probePaneState。idle を得たら 1.5 秒後にもう一度撮り、画面が 1 文字も変わらず、また idle なら確定
import { setTimeout as sleepMs } from "node:timers/promises";
import type { Tmux, TmuxPane } from "./tmux.ts";

/** 状態（§5.3 の表の上から順に判定する） */
export type PaneState = "gone" | "not_claude" | "copy_mode" | "owner_active" | "dialog" | "busy" | "no_prompt" | "draft" | "idle";

/** 画面だけで決まる状態 */
export type ScreenState = Extract<PaneState, "dialog" | "busy" | "no_prompt" | "draft" | "idle">;

/** Claude Code が動いているペインの pane_current_command */
export const CLAUDE_COMMAND = "claude";
/** クライアントの最後の活動からこの時間（ミリ秒）の間は、オーナーが打っている最中とみなす */
export const OWNER_ACTIVE_MS = 60_000;
/** 2 回目を撮るまでのミリ秒 */
export const SECOND_CAPTURE_DELAY_MS = 1500;
/** 入力欄を探す範囲（下から何行。末尾の空行は数えない） */
export const PROMPT_SEARCH_LINES = 8;

/** 入力欄の上のスピナーを探す範囲（上の `─` の行から上に何行） */
export const SPINNER_SEARCH_LINES = 10;
/** 入力欄を上の `─` から下の `─` まで探す上限の行数（pasteLanded） */
export const INPUT_BOX_MAX_LINES = 20;
/** 貼れたかを確かめるのに使うテンプレートの先頭の文字数（§5.4 の 4） */
export const PASTE_CHECK_CHARS = 24;

/** ダイアログ・重なった表示の文言（plain に大文字小文字を問わず含まれていれば dialog）。主の守りは入力欄の形（no_prompt）で、これは補助 */
export const DIALOG_MARKERS: readonly string[] = [
  "Enter to select",
  "Enter to confirm",
  "Esc to cancel",
  "Esc to exit",
  "Esc to go back",
  "to navigate",
  "Do you want to",
  "Would you like to",
  "Do you trust",
  "Press Enter",
  // ? のショートカットの一覧
  "for bash mode",
];
/** 長い貼り付けがまとめられたときの印 */
export const PASTED_TEXT_MARKER = "[Pasted text";
/** 入力欄に貼り付け・画像がまとめて入っている印（dim でも書きかけとみなす） */
export const INPUT_MARKERS: readonly string[] = [PASTED_TEXT_MARKER, "[Image #"];

const BUSY_TEXT = /esc to interrupt/i;
// スピナーの記号 + 文 + 「…」か経過秒数（「(12s」「(1m 3s」）。終わった後の「✻ Worked for 9s」は当たらない
const SPINNER_LINE = /^[·✢✳✶✻✽*]\s+\S.*(…|\((\d+m )?\d+s\b)/;
// vim のノーマル・ビジュアルモード（貼った文字が入力にならないかもしれない）
const VIM_NOT_INSERT = /-- (NORMAL|VISUAL)/;
// 入力欄の dim の文字のうち、候補（プレースホルダ）とみなすもの。前の返答からの提案など、それ以外の dim は書きかけとみなす
const PLACEHOLDER = /^Try "/;
const RULE_LINE = /^─{20,}$/;
const PROMPT_PREFIX = "❯ ";

/** classifyPane に渡すペインの情報 */
export type PaneMeta = {
  /** list-panes で見つからなければ undefined */
  pane: TmuxPane | undefined;
  /** そのセッションに付いているクライアントの最後の活動（ミリ秒）のうち最も新しいもの。クライアントが無ければ undefined */
  lastClientActivityAt?: number;
};

type Token = { kind: "text"; text: string } | { kind: "sgr"; params: string } | { kind: "other" };

/** raw を文字列と制御シーケンスに分ける（CSI・OSC・その他の ESC。SGR だけ中身を残す） */
function tokenize(raw: string): Token[] {
  const tokens: Token[] = [];
  let text = "";
  const flush = (): void => {
    if (text !== "") tokens.push({ kind: "text", text });
    text = "";
  };
  let i = 0;
  while (i < raw.length) {
    const ch = raw[i]!;
    if (ch !== "\x1b") {
      text += ch;
      i += 1;
      continue;
    }
    flush();
    const next = raw[i + 1];
    if (next === "[") {
      // CSI: パラメータと中間のバイトの後、0x40〜0x7e の終端
      let j = i + 2;
      while (j < raw.length && !/[\x40-\x7e]/.test(raw[j]!)) j += 1;
      if (raw[j] === "m") tokens.push({ kind: "sgr", params: raw.slice(i + 2, j) });
      else tokens.push({ kind: "other" });
      i = j + 1;
    } else if (next === "]") {
      // OSC（ハイパーリンクなど）: BEL か ESC \ まで
      let j = i + 2;
      while (j < raw.length && raw[j] !== "\x07" && !(raw[j] === "\x1b" && raw[j + 1] === "\\")) j += 1;
      tokens.push({ kind: "other" });
      i = raw[j] === "\x07" ? j + 1 : j + 2;
    } else {
      // それ以外: 中間のバイト（0x20〜0x2f）と終端の 1 文字
      let j = i + 1;
      while (j < raw.length && /[\x20-\x2f]/.test(raw[j]!)) j += 1;
      tokens.push({ kind: "other" });
      i = j + 1;
    }
  }
  flush();
  return tokens;
}

/** SGR を適用した後の dim（SGR 2）の状態。38/48/58 の後ろの色の指定（5;n・2;r;g;b）は読み飛ばす */
function applySgr(dim: boolean, params: string): boolean {
  const list = params === "" ? ["0"] : params.split(";");
  for (let k = 0; k < list.length; k += 1) {
    const param = list[k]!;
    if (param.includes(":")) continue;
    const value = param === "" ? 0 : Number(param);
    if (value === 0 || value === 22) dim = false;
    else if (value === 2) dim = true;
    else if (value === 38 || value === 48 || value === 58) {
      if (list[k + 1] === "5") k += 2;
      else if (list[k + 1] === "2") k += 4;
    }
  }
  return dim;
}

/** 制御シーケンスを落とした文字列 */
export function stripAnsi(raw: string): string {
  return tokenize(raw)
    .map((token) => (token.kind === "text" ? token.text : ""))
    .join("");
}

/** raw を行に分け、各文字に dim かどうかを付ける（SGR の状態は行をまたいで続く） */
function styledLines(raw: string): Array<Array<{ ch: string; dim: boolean }>> {
  const lines: Array<Array<{ ch: string; dim: boolean }>> = [[]];
  let dim = false;
  for (const token of tokenize(raw)) {
    if (token.kind === "sgr") dim = applySgr(dim, token.params);
    if (token.kind !== "text") continue;
    for (const ch of token.text) {
      if (ch === "\n") lines.push([]);
      else lines[lines.length - 1]!.push({ ch, dim });
    }
  }
  return lines;
}

/** 入力欄の行（`─` の行 / `❯`+U+00A0 の行 / `─` の行 の真ん中）の位置。下から PROMPT_SEARCH_LINES 行以内に無ければ undefined */
function findPromptLine(lines: string[]): number | undefined {
  let end = lines.length;
  while (end > 0 && lines[end - 1]!.trim() === "") end -= 1;
  const start = Math.max(0, end - PROMPT_SEARCH_LINES);
  for (let i = end - 2; i - 1 >= start; i -= 1) {
    if (RULE_LINE.test(lines[i - 1]!.trim()) && lines[i]!.startsWith(PROMPT_PREFIX) && RULE_LINE.test(lines[i + 1]!.trim())) return i;
  }
  return undefined;
}

/**
 * 画面（capture-pane -e の出力）だけで判定する。
 * - dialog: DIALOG_MARKERS のどれか（大文字小文字を問わない）
 * - busy: `esc to interrupt`、または入力欄の上の SPINNER_SEARCH_LINES 行にスピナーの行（TODO の一覧・Tip が間にあってもよい）
 * - no_prompt: vim のノーマル・ビジュアルモード、または入力欄の形（§5.3）が下から PROMPT_SEARCH_LINES 行以内に無い
 * - draft: 入力行に `[Pasted text`・`[Image #` がある、dim でない見える文字がある、dim の文字が候補（`Try "`）の形でない
 */
export function classifyScreen(raw: string): ScreenState {
  const plain = stripAnsi(raw);
  const lower = plain.toLowerCase();
  if (DIALOG_MARKERS.some((marker) => lower.includes(marker.toLowerCase()))) return "dialog";
  if (BUSY_TEXT.test(plain)) return "busy";
  const lines = plain.split("\n");
  const prompt = findPromptLine(lines);
  if (prompt !== undefined) {
    for (let i = prompt - 2; i >= Math.max(0, prompt - 1 - SPINNER_SEARCH_LINES); i -= 1) {
      if (SPINNER_LINE.test(lines[i]!.trim())) return "busy";
    }
  }
  if (VIM_NOT_INSERT.test(plain)) return "no_prompt";
  if (prompt === undefined) return "no_prompt";
  if (INPUT_MARKERS.some((marker) => lines[prompt]!.includes(marker))) return "draft";
  // 入力行の ❯+U+00A0 の後に dim でない見える文字があれば書きかけ。dim の文字は候補の形のときだけ空とみなす
  const cells = styledLines(raw)[prompt] ?? [];
  const rest = cells.slice([...PROMPT_PREFIX].length);
  if (rest.some((cell) => !cell.dim && cell.ch.trim() !== "")) return "draft";
  // ここでは見える文字はすべて dim（候補の語の間の空白は dim でないことがある）
  const dimText = rest
    .map((cell) => cell.ch)
    .join("")
    .trim();
  if (dimText !== "" && !PLACEHOLDER.test(dimText)) return "draft";
  return "idle";
}

/**
 * 入力欄の文字（下の `─` の行と、その上で `❯`+U+00A0 の行のすぐ上にある `─` の行の間の行を、❯ を除いて空白なしでつないだもの）。
 * 下の `─` は下から PROMPT_SEARCH_LINES 行以内、入力欄は INPUT_BOX_MAX_LINES 行まで（貼った文字が折り返して複数行になってもよい）。無ければ undefined
 */
export function inputBoxText(raw: string): string | undefined {
  const lines = stripAnsi(raw).split("\n");
  let end = lines.length;
  while (end > 0 && lines[end - 1]!.trim() === "") end -= 1;
  for (let bottom = end - 1; bottom >= Math.max(0, end - PROMPT_SEARCH_LINES); bottom -= 1) {
    if (!RULE_LINE.test(lines[bottom]!.trim())) continue;
    for (let top = bottom - 2; top >= Math.max(0, bottom - 1 - INPUT_BOX_MAX_LINES); top -= 1) {
      if (!RULE_LINE.test(lines[top]!.trim())) continue;
      if (!lines[top + 1]!.startsWith(PROMPT_PREFIX)) return undefined;
      const text = lines.slice(top + 1, bottom).join("").slice([...PROMPT_PREFIX].length);
      return text.replace(/\s/g, "");
    }
    return undefined;
  }
  return undefined;
}

/**
 * 貼り付けが入力欄に届いたか（§5.4 の 4。G4 が Enter を押す前に使う）。before は貼る前に撮った画面、after は貼った後に撮った画面、text は貼った文字。
 * before の入力欄が見つかり、そこに `[Pasted text` も text の先頭 PASTE_CHECK_CHARS 字も無く（前からあった印を貼れた証拠と取り違えない）、
 * after の入力欄に text の先頭 PASTE_CHECK_CHARS 字（空白を除いて比べる）か `[Pasted text` があるときだけ true。false なら Enter を押さない
 */
export function pasteLanded(beforeRaw: string, afterRaw: string, text: string): boolean {
  // inputBoxText は空白を除くので、比べるものも空白を除く
  const head = [...text.replace(/\s/g, "")].slice(0, PASTE_CHECK_CHARS).join("");
  const marker = PASTED_TEXT_MARKER.replace(/\s/g, "");
  if (head === "") return false;
  const before = inputBoxText(beforeRaw);
  if (before === undefined || before.includes(marker) || before.includes(head)) return false;
  const after = inputBoxText(afterRaw);
  return after !== undefined && (after.includes(head) || after.includes(marker));
}

/** 画面を撮らずに決まる状態（gone・not_claude・copy_mode・owner_active）。どれでもなければ undefined */
export function classifyMeta(meta: PaneMeta, now: number): PaneState | undefined {
  const { pane } = meta;
  if (pane === undefined || pane.dead) return "gone";
  if (pane.currentCommand !== CLAUDE_COMMAND) return "not_claude";
  if (pane.inMode) return "copy_mode";
  if (meta.lastClientActivityAt !== undefined && now - meta.lastClientActivityAt < OWNER_ACTIVE_MS) return "owner_active";
  return undefined;
}

/**
 * ペインの状態（§5.3）。raw2 は 1.5 秒後に撮ったもの。raw2 が無ければ 1 回目だけで判定する（idle は確定ではない）。
 * raw2 があれば、2 回目も idle で、制御シーケンスを落とした画面が 1 文字も変わっていないときだけ idle。変わっていれば busy
 */
export function classifyPane(meta: PaneMeta, raw1: string, raw2: string | undefined, now: number): PaneState {
  const byMeta = classifyMeta(meta, now);
  if (byMeta !== undefined) return byMeta;
  const first = classifyScreen(raw1);
  if (first !== "idle" || raw2 === undefined) return first;
  const second = classifyScreen(raw2);
  if (second !== "idle") return second;
  return stripAnsi(raw1) === stripAnsi(raw2) ? "idle" : "busy";
}

export type ProbeResult = { ok: true; state: PaneState } | { ok: false; reason: "no_server" | "failed" };

export type ProbeOptions = {
  tmux: Tmux;
  paneId: string;
  /** 既定は Date.now */
  now?: () => number;
  /** 既定は timers/promises の setTimeout */
  sleep?: (ms: number) => Promise<void>;
};

/** ペインの情報とクライアントの活動を取る */
async function readMeta(tmux: Tmux, paneId: string): Promise<{ ok: true; meta: PaneMeta } | { ok: false; reason: "no_server" | "failed" }> {
  const panes = await tmux.listPanes();
  if (!panes.ok) return { ok: false, reason: panes.reason === "no_server" ? "no_server" : "failed" };
  const pane = panes.value.find((candidate) => candidate.paneId === paneId);
  if (pane === undefined) return { ok: true, meta: { pane } };
  const clients = await tmux.listClients();
  if (!clients.ok) return { ok: false, reason: clients.reason === "no_server" ? "no_server" : "failed" };
  const times = clients.value.filter((client) => client.sessionName === pane.sessionName).map((client) => client.activityAt);
  return { ok: true, meta: times.length === 0 ? { pane } : { pane, lastClientActivityAt: Math.max(...times) } };
}

/**
 * ペインを撮って状態を返す。1 回目が idle なら SECOND_CAPTURE_DELAY_MS 後にペインの情報と画面を取り直して確定する。
 * ペインが撮る前・撮る間に無くなれば gone。tmux のサーバーが無ければ no_server、それ以外の失敗は failed
 */
export async function probePaneState(options: ProbeOptions): Promise<ProbeResult> {
  const { tmux, paneId } = options;
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? ((ms: number) => sleepMs(ms).then(() => undefined));
  const capture = async (): Promise<{ ok: true; raw: string | undefined } | { ok: false; reason: "no_server" | "failed" }> => {
    const result = await tmux.capturePane(paneId);
    if (result.ok) return { ok: true, raw: result.value };
    if (result.reason === "not_found") return { ok: true, raw: undefined };
    return { ok: false, reason: result.reason };
  };

  const first = await readMeta(tmux, paneId);
  if (!first.ok) return first;
  const byMeta = classifyMeta(first.meta, now());
  if (byMeta !== undefined) return { ok: true, state: byMeta };
  const shot1 = await capture();
  if (!shot1.ok) return shot1;
  if (shot1.raw === undefined) return { ok: true, state: "gone" };
  const state1 = classifyPane(first.meta, shot1.raw, undefined, now());
  if (state1 !== "idle") return { ok: true, state: state1 };

  await sleep(SECOND_CAPTURE_DELAY_MS);
  const second = await readMeta(tmux, paneId);
  if (!second.ok) return second;
  const byMeta2 = classifyMeta(second.meta, now());
  if (byMeta2 !== undefined) return { ok: true, state: byMeta2 };
  const shot2 = await capture();
  if (!shot2.ok) return shot2;
  if (shot2.raw === undefined) return { ok: true, state: "gone" };
  return { ok: true, state: classifyPane(second.meta, shot1.raw, shot2.raw, now()) };
}
