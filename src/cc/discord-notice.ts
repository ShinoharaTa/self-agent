// Claude Code の Discord（#system）への知らせ（docs/plan/claude-code-sessions.md §5.2。CC5c）。SELF_AGENT_CC_NOTIFY が 1 のときだけ main が作る
// （0 なら作らず、許可の要求は Web と端末・RC だけで答える。保留の長さは変わらない）。
// - 許可の要求: 保留を始めたら（permission-hold.ts の listen）1 通（warning・オーナーだけをメンション）。1 行目 [許可][このセッションでは常に許可][拒否]
//   （`cc:perm:allow|always|deny:<id>`。常に許可はルールがあるときだけ）、2 行目 [RC で開く]（リンク。RC の id が分かるときだけ）。
//   終わったら（Web で押された・他で答えられた・時間切れ・停止・再起動の前に残った）その 1 通の見出しの後ろを結果の行にしてボタンを外す
//   （[RC で開く] は残す）。Discord で押されたものは app/commands/cc.ts が応答で書き換えるので、ここでは書き換えない。
//   質問（AskUserQuestion。docs/plan/claude-code-questions.md §3。Q2）の行は、選択肢のボタン・セレクトの 1 通（questionNotice）を 1 問ずつ書き換える
//   （押した処理は app/commands/cc-question.ts）。終わった 1 通は答えの行（questionResolvedMessage）。Q4 で #system をやめ、文面は notice-text.ts に移す。
// - 判断待ち: 許可の要求以外の判断待ち（registry の needs_input）が CC_WAIT_NOTIFY_MS 続いたら 1 回（待ちごとに 1 回。cc_sessions.notified_at）。
//   1 時間に CC_WAIT_NOTIFY_LIMIT 件までで、超えた分は「ほか n 件」の 1 通にまとめて書き換える。保留中か直近 60 秒に解決した許可の要求
//   （released を除く。released は 1 通を出していない）のあるセッションには出さない（保留中でも 6 秒で来る permission_prompt のため）。
// - 終了: self-agent が起動したセッション（started_by が owner でない）が claude agents --json の一覧から消えたら info で 1 行
//   （1 セッション 1 回。プロセスの中。SessionEnd の hook は根拠にしない）。
// 投稿先は SELF_AGENT_ALLOWED_GUILD_IDS の順で最初の、#system のあるサーバー（1 通だけ出すため）。
// Claude Code のチャンネル（docs/plan/claude-code-channels.md §3.5。CC12）が開いているセッションの許可の要求・判断待ちは cc/channel-posts.ts が
// そのチャンネルに出すので、ここでは出さない（許可の要求は permission-hold.ts が先に channel-posts に尋ね、引き受けたものはここに来ない。
// 判断待ちは hasChannel で除く。1 時間の上限は CcWaitBudget を channel-posts と共有して 1 つで数える）。終了はチャンネルがあれば cc/channels.ts の ccEndedHandler が出さない。
// 名前・ディレクトリ・要約・ルールは hook から来たデータなので、Markdown とメンションを無効にする（要約はコードブロックに入れる）。
// log は id と件数・失敗の種類だけ（名前・cwd・ツール名・要約・セッションの ID は出さない）
import type { SystemNotifier } from "../app/system-notice.ts";
import type { Config } from "../config.ts";
import { mentionPrefix } from "../discord/convert.ts";
import { escapeDiscordText } from "../discord/escape.ts";
import type { ComponentRow, Gateway, OutgoingMessage } from "../discord/gateway.ts";
import type { CcPermissionRow, CcPermissionStore } from "../store/cc-permissions.ts";
import type { CcSessionRow, CcSessionStore } from "../store/cc-sessions.ts";
import { headChars } from "../store/cc-sessions.ts";
import type { GuildSettingsStore } from "../store/guild-settings.ts";
import { CC_RC_URL_PREFIX } from "../web/routes/cc.ts";
import { cwdLabel } from "./labels.ts";
import { CC_PERMISSION_SUPPRESS_MS, type CcPermissionListener } from "./permission-hold.ts";
import { describeRule, formatRule } from "./permissions.ts";
import { CC_QUESTION_MULTI_SEPARATOR, CC_QUESTION_TOOL, type CcQuestion, type CcQuestionPick, parseQuestionInput } from "./questions.ts";
import type { CcRegistry, CcSessionView, CcTimers } from "./registry.ts";

/** 判断待ちがこの間続いたら知らせる（決定 2） */
export const CC_WAIT_NOTIFY_MS = 60_000;
/** 判断待ちを確かめる周期 */
export const CC_WAIT_CHECK_MS = 10_000;
/** 判断待ちの知らせを数える窓 */
export const CC_WAIT_NOTIFY_WINDOW_MS = 60 * 60_000;
/** 窓の中で 1 通ずつ出す数（超えた分は「ほか n 件」） */
export const CC_WAIT_NOTIFY_LIMIT = 10;
/** 常に許可のルールを Discord に出す長さの上限（超えたら Discord では [このセッションでは常に許可] を出さず、Web へ案内する） */
export const CC_DISCORD_RULES_MAX_CHARS = 800;
/** 名前・ディレクトリを出す長さ */
const LABEL_MAX_CHARS = 100;
/** 1 通の上限（Discord） */
const MESSAGE_MAX_CHARS = 2000;
/** 終了を知らせたセッションを覚えておく数（超えたら古いものから忘れる） */
const ENDED_MEMORY = 1000;

/** 判断待ちの知らせの 1 時間の上限（#system と Claude Code のチャンネルで共有して 1 つで数える。プロセスの中） */
export class CcWaitBudget {
  private times: number[] = [];

  /** 窓の中で CC_WAIT_NOTIFY_LIMIT 件に達していなければ 1 件使って true */
  take(now: number): boolean {
    this.times = this.times.filter((at) => now - at < CC_WAIT_NOTIFY_WINDOW_MS);
    if (this.times.length >= CC_WAIT_NOTIFY_LIMIT) return false;
    this.times.push(now);
    return true;
  }
}

/**
 * 知らせる判断待ち: 許可の要求以外の判断待ちが CC_WAIT_NOTIFY_MS 続き、その待ちをまだ知らせていないセッション。保留中か直近 60 秒に
 * 解決した許可の要求（released を除く）のあるセッションは除く。include で絞る（#system とチャンネルで分ける）
 */
export function dueWaitingViews(
  deps: {
    registry: Pick<CcRegistry, "snapshot">;
    permissions: Pick<CcPermissionStore, "sessionsAnsweredSince">;
    sessions: Pick<CcSessionStore, "get">;
  },
  now: number,
  include: (sessionId: string) => boolean,
): CcSessionView[] {
  const views = deps.registry
    .snapshot()
    .sessions.filter((view) => view.state === "needs_input" && !view.pendingPermission && include(view.sessionId));
  if (views.length === 0) return [];
  const answered = deps.permissions.sessionsAnsweredSince(new Date(now - CC_PERMISSION_SUPPRESS_MS));
  return views.filter((view) => {
    if (answered.has(view.sessionId) || view.waitingSince === undefined || now - view.waitingSince < CC_WAIT_NOTIFY_MS) return false;
    const notifiedAt = Date.parse(deps.sessions.get(view.sessionId)?.notifiedAt ?? "");
    return !(Number.isFinite(notifiedAt) && notifiedAt >= view.waitingSince);
  });
}

/** 表示に使うセッションの情報（DB の行。生きていれば一覧の RC の id も）。どちらにも無ければ undefined */
export function noticeSessionOf(
  sessions: Pick<CcSessionStore, "get">,
  registry: Pick<CcRegistry, "snapshot">,
  sessionId: string,
): CcNoticeSession | undefined {
  const row = sessions.get(sessionId);
  const view = registry.snapshot().sessions.find((candidate) => candidate.sessionId === sessionId);
  if (row === undefined && view === undefined) return undefined;
  return { name: row?.name ?? view?.name ?? null, cwd: row?.cwd ?? view?.cwd ?? null, bridgeSessionId: view?.bridgeSessionId };
}

/** 許可の要求のボタンの custom_id（`cc:perm:<action>:<id>`。app/commands/cc.ts が受ける） */
export function permissionCustomId(action: "allow" | "always" | "deny", id: number): string {
  return `cc:perm:${action}:${id}`;
}

/** 1 行の表示（制御文字を空白にし、Markdown とメンションを無効にする） */
function plain(text: string, max = LABEL_MAX_CHARS): string {
  return escapeDiscordText(headChars(text.replace(/[\u0000-\u001f\u007f]/g, " "), max));
}

/** コードブロック（中の ``` を崩して閉じられないようにする） */
function codeBlock(text: string): string {
  return `\`\`\`\n${text.replace(/`{3,}/g, (run) => [...run].join("​"))}\n\`\`\``;
}

/** インラインのコード（` を含めば別の字に置き換える） */
function inlineCode(text: string): string {
  return `\`${text.replace(/[`\r\n]/g, (char) => (char === "`" ? "ˋ" : " "))}\``;
}

/** 秒の表示（60 で割り切れれば分） */
function duration(sec: number): string {
  return sec % 60 === 0 ? `${sec / 60} 分` : `${sec} 秒`;
}

/** 表示に使うセッションの情報（cc_sessions の行と、生きていれば一覧の RC の id） */
export type CcNoticeSession = { name: string | null; cwd: string | null; bridgeSessionId?: string | undefined };

/** 名前（ディレクトリ・mode）。無いものは省く */
function sessionLabel(session: CcNoticeSession | undefined, mode: string | null, places: { workspaceDir: string; home: string }): string {
  const name = session?.name === null || session?.name === undefined || session.name === "" ? "（名前なし）" : plain(session.name);
  const dir = cwdLabel(session?.cwd ?? undefined, places.workspaceDir, places.home);
  const parts = [dir === null || dir === "" ? undefined : plain(dir), mode === null ? undefined : plain(mode, 32)].filter(
    (part): part is string => part !== undefined,
  );
  return parts.length === 0 ? name : `${name}（${parts.join("・")}）`;
}

/** RC のリンク（RC の id が分かるときだけ） */
function rcUrlOf(session: CcNoticeSession | undefined): string | undefined {
  return session?.bridgeSessionId === undefined ? undefined : `${CC_RC_URL_PREFIX}${session.bridgeSessionId}`;
}

/** 常に許可のルールの表示（`Bash(npm test *)` を改行でつなぐ）。無ければ undefined、長すぎれば null */
function rulesText(row: Pick<CcPermissionRow, "alwaysRules">): string | null | undefined {
  if (row.alwaysRules === null || row.alwaysRules.length === 0) return undefined;
  const text = row.alwaysRules.map(formatRule).join("\n");
  return [...text].length > CC_DISCORD_RULES_MAX_CHARS ? null : text;
}

/** 許可の要求の見出し（何を・どのセッションで） */
function permissionHead(
  row: Pick<CcPermissionRow, "toolName" | "summary" | "permissionMode">,
  session: CcNoticeSession | undefined,
  places: { workspaceDir: string; home: string },
): string {
  return `Claude Code が許可を待っています: ${sessionLabel(session, row.permissionMode, places)}\n${plain(row.toolName, 128)}:\n${codeBlock(row.summary)}`;
}

export type CcPermissionNoticeOptions = {
  workspaceDir: string;
  home: string;
  /** SELF_AGENT_CC_PERMISSION_HOLD_SEC（ボタンが効く時間） */
  holdSec: number;
  /** SELF_AGENT_CC_QUESTION_HOLD_SEC（質問のボタンが効く時間）。無ければ holdSec */
  questionHoldSec?: number | undefined;
  ownerUserId?: string | undefined;
};

/** 読めない形の AskUserQuestion（question_input が無い）の許可の 1 通に足す注記（docs/plan/claude-code-questions.md §3.2） */
export const CC_QUESTION_UNREADABLE_NOTE = "質問の形を読めませんでした。端末か RC で答えてください";

/**
 * 許可の要求の 1 通（§5.2。純関数）。質問の行（question_input が読める）は 1 問目の質問の 1 通（questionNotice）、
 * 読めない形の AskUserQuestion は許可の 1 通に注記を足す
 */
export function permissionNotice(row: CcPermissionRow, session: CcNoticeSession | undefined, options: CcPermissionNoticeOptions): OutgoingMessage {
  const parsed = parseQuestionInput(row.questionInput);
  if (parsed !== undefined) {
    return questionNotice(row, parsed.questions, [], session, { ...options, holdSec: options.questionHoldSec ?? options.holdSec });
  }
  const rules = rulesText(row);
  const lines = [permissionHead(row, session, options)];
  if (row.toolName === CC_QUESTION_TOOL) lines.push(CC_QUESTION_UNREADABLE_NOTE);
  if (typeof rules === "string") {
    const notes = (row.alwaysRules ?? []).map(describeRule).filter((note): note is string => note !== null);
    lines.push(`常に許可にすると:\n${codeBlock(rules)}${notes.length === 0 ? "" : `\n${plain(notes.join("、"), 300)}`}`);
  } else if (rules === null) {
    lines.push("常に許可のルールが長いため、[このセッションでは常に許可] は Web で押してください");
  } else {
    lines.push("（[このセッションでは常に許可] は Claude Code が規則を提案したときだけ出ます）");
  }
  lines.push(`端末や RC のダイアログでも答えられます（ボタンは ${duration(options.holdSec)}効きます）`);
  const buttons: ComponentRow = {
    kind: "buttons",
    buttons: [
      { customId: permissionCustomId("allow", row.id), label: "許可", style: "success" },
      ...(typeof rules === "string" ? [{ customId: permissionCustomId("always", row.id), label: "このセッションでは常に許可" }] : []),
      { customId: permissionCustomId("deny", row.id), label: "拒否", style: "danger" },
    ],
  };
  const rcUrl = rcUrlOf(session);
  const limit = MESSAGE_MAX_CHARS - (options.ownerUserId === undefined ? 0 : mentionPrefix(options.ownerUserId).length);
  return {
    text: fit(lines.join("\n"), limit),
    components: rcUrl === undefined ? [buttons] : [buttons, { kind: "links", links: [{ label: "RC で開く", url: rcUrl }] }],
    ...(options.ownerUserId === undefined ? {} : { mentionUserId: options.ownerUserId }),
  };
}

/** 上限を超えたら末尾を落とす（要約は 500 字・ルールは 800 字までなので、普通は超えない） */
function fit(text: string, max: number): string {
  const chars = [...text];
  return chars.length <= max ? text : `${chars.slice(0, max - 1).join("")}…`;
}

/** 終わった許可の要求の結果の行（§5.2。純関数）。pending なら undefined */
export function permissionResultLine(row: Pick<CcPermissionRow, "state" | "via" | "alwaysRules">, rcUrl: string | undefined): string | undefined {
  const via = row.via === "discord" ? "Discord" : row.via === "web" ? "Web" : undefined;
  const link = rcUrl === undefined ? "" : ` <${rcUrl}>`;
  switch (row.state) {
    case "pending":
      return undefined;
    case "allowed":
      return `許可（${via ?? "?"}）`;
    case "allowed_always": {
      const rules = rulesText(row);
      const shown = typeof rules === "string" ? rules.split("\n").map(inlineCode).join("、") : `ルール ${row.alwaysRules?.length ?? 0} 件`;
      return `常に許可（${shown}）（${via ?? "?"}）`;
    }
    case "denied":
      return `拒否（${via ?? "?"}）`;
    case "answered_elsewhere":
      return "端末か RC で答えられました";
    case "expired":
      return `時間切れ。端末か RC で答えてください${link}`;
    case "released":
      return `self-agent が止まるため受け付けをやめました。端末か RC で答えてください${link}`;
  }
}

/**
 * 終わった許可の要求の 1 通（見出し + 結果の行。押すボタンは外し、[RC で開く] は RC のリンクが分かれば残す。純関数）。
 * 質問の行は questionResolvedMessage
 */
export function permissionResolvedMessage(
  row: CcPermissionRow,
  session: CcNoticeSession | undefined,
  places: { workspaceDir: string; home: string },
): OutgoingMessage {
  const parsed = parseQuestionInput(row.questionInput);
  if (parsed !== undefined) return questionResolvedMessage(row, parsed.questions, session, places);
  const rcUrl = rcUrlOf(session);
  return {
    text: fit(`${permissionHead(row, session, places)}\n${permissionResultLine(row, rcUrl) ?? ""}`, MESSAGE_MAX_CHARS),
    components: rcUrl === undefined ? [] : [{ kind: "links", links: [{ label: "RC で開く", url: rcUrl }] }],
  };
}

// ---- 質問（AskUserQuestion。docs/plan/claude-code-questions.md §3。Q2）。1 通を 1 問ずつ書き換える。Q4 で notice-text.ts に移す ----

/** ボタンで出す選択肢の数の上限（これを超える・複数選択はセレクト + [決める]） */
export const CC_QUESTION_BUTTON_MAX_OPTIONS = 4;
/** ボタンの label の上限（Discord は 80 字） */
const QUESTION_BUTTON_LABEL_MAX = 80;
/** セレクトの選択肢の label・description の上限（Discord は 100 字） */
const QUESTION_SELECT_TEXT_MAX = 100;
/** 本文に出す問の文・選択肢の label・description・答えの長さ（字） */
const QUESTION_TEXT_MAX = 1000;
const QUESTION_OPTION_LABEL_MAX = 80;
const QUESTION_OPTION_DESCRIPTION_MAX = 100;
const QUESTION_ANSWER_MAX = 200;
/** 本文を収めるために問の文を削っても残す長さ（字） */
const QUESTION_TEXT_MIN = 40;
/** モーダルの title の header の長さ（Discord の title は 45 字。「その他（」と「）」で 5 字） */
const QUESTION_MODAL_HEADER_MAX = 40;
/** 「その他」のモーダルのテキスト入力の customId */
export const CC_QUESTION_TEXT_INPUT_ID = "text";

/** 質問の操作の種類（`cc:q:<action>:…`。app/commands/cc-question.ts が受ける） */
export type CcQuestionAction = "pick" | "other" | "text" | "sel" | "ok" | "drop";

/**
 * 質問のボタン・セレクト・モーダルの custom_id: `cc:q:drop:<id>`・`cc:q:<other|text|sel|ok>:<id>:<問>`・`cc:q:pick:<id>:<問>:<選択肢>`
 * （問・選択肢は 0 始まりの添字。100 字に収まる）
 */
export function questionCustomId(action: CcQuestionAction, id: number, question?: number, option?: number): string {
  return ["cc", "q", action, String(id), ...(question === undefined ? [] : [String(question)]), ...(option === undefined ? [] : [String(option)])].join(":");
}

/** 制御文字を空白にして max 字に切る（切ったら末尾を「…」に。Markdown のエスケープはしない。ボタン・セレクトの文字） */
function clipPlain(text: string, max: number): string {
  const chars = [...text.replace(/[\u0000-\u001f\u007f]/g, " ")];
  return chars.length <= max ? chars.join("") : `${chars.slice(0, max - 1).join("")}…`;
}

/** 改行を残した表示（改行以外の制御文字を空白にし、max 字で切って「…」、Markdown とメンションを無効にする） */
function block(text: string, max: number): string {
  const chars = [...text.replace(/[\u0000-\u0009\u000b-\u001f\u007f]/g, " ")];
  return escapeDiscordText(chars.length <= max ? chars.join("") : `${chars.slice(0, max - 1).join("")}…`);
}

/** 1 問の答えの文（複数選択は ", " でつなぐ。「その他」は打った文字列） */
export function questionPickText(pick: CcQuestionPick): string {
  return "labels" in pick ? pick.labels.join(CC_QUESTION_MULTI_SEPARATOR) : pick.other;
}

/** 問の見出し（header があれば「<header>」、無ければ空） */
function headerLabel(question: CcQuestion): string {
  return question.header.trim() === "" ? "" : `「${plain(question.header)}」`;
}

/** 答えた問の 1 行（`1. 「<header>」<答え>`） */
function answerLine(index: number, question: CcQuestion, value: string, max = QUESTION_ANSWER_MAX): string {
  return `${index + 1}. ${headerLabel(question)}${plain(value, max)}`;
}

/** 質問の 1 通の見出し（何問・どのセッションで） */
function questionHead(
  row: Pick<CcPermissionRow, "permissionMode">,
  questions: readonly CcQuestion[],
  session: CcNoticeSession | undefined,
  places: { workspaceDir: string; home: string },
): string {
  return `Claude Code が質問しています（${questions.length} 問）: ${sessionLabel(session, row.permissionMode, places)}`;
}

/** 今の問をボタンで出すか（1 つ選ぶ・選択肢 4 つまで）。それ以外はセレクト + [決める] */
export function questionUsesButtons(question: CcQuestion): boolean {
  return !question.multiSelect && question.options.length <= CC_QUESTION_BUTTON_MAX_OPTIONS;
}

/**
 * 質問の 1 通（§3.2。純関数）。picks は答えた問の答え（問の順）で、次の問（picks.length 番目）を出す。本文は見出し・答えた問（1 問 1 行）・
 * 今の問（header・問の文・選択肢の label と description）・ボタンの効く時間。名前・問・選択肢は hook から来たデータなので Markdown とメンションを
 * 無効にする。2,000 字（メンションの分を引く）に収まるまで description を落とし、それでも長ければ問の文を削る。
 * 部品は、1 つ選ぶ・4 択までは [1. <label>]…[その他] の行と [やめる] の行、それ以外はセレクトの行と [決める][その他][やめる] の行、
 * 最後に [RC で開く]（RC の id が分かるときだけ）。全部の問に答えていれば（picks が足りている）最後の問を出す
 */
export function questionNotice(
  row: Pick<CcPermissionRow, "id" | "permissionMode">,
  questions: readonly CcQuestion[],
  picks: readonly CcQuestionPick[],
  session: CcNoticeSession | undefined,
  options: { workspaceDir: string; home: string; holdSec: number; ownerUserId?: string | undefined },
): OutgoingMessage {
  const step = Math.min(picks.length, questions.length - 1);
  const question = questions[step]!;
  const buttons = questionUsesButtons(question);
  const head = questionHead(row, questions, session, options);
  const title = `質問 ${step + 1}/${questions.length}${headerLabel(question)}`;
  const hint = buttons ? undefined : question.multiSelect ? "（いくつでも選べます。選んでから [決める] を押してください）" : "（選んでから [決める] を押してください）";
  const footer = `端末や RC のダイアログでも答えられます（ボタンは ${duration(options.holdSec)}効きます）`;
  type Sizes = { questionMax: number; withDescription: boolean; answerMax: number; labelMax: number };
  const compose = (sizes: Sizes): string => {
    const answered = picks.slice(0, step).map((pick, index) => answerLine(index, questions[index]!, questionPickText(pick), sizes.answerMax));
    const optionLines = question.options.map((option, index) => {
      const description =
        sizes.withDescription && option.description.trim() !== "" ? ` — ${plain(option.description, QUESTION_OPTION_DESCRIPTION_MAX)}` : "";
      return `${index + 1}. ${plain(option.label, sizes.labelMax)}${description}`;
    });
    return [
      head,
      ...(answered.length === 0 ? [] : ["答え済み:", ...answered]),
      title,
      block(question.question, sizes.questionMax),
      ...optionLines,
      ...(hint === undefined ? [] : [hint]),
      footer,
    ].join("\n");
  };
  const limit = MESSAGE_MAX_CHARS - (options.ownerUserId === undefined ? 0 : mentionPrefix(options.ownerUserId).length);
  const over = (text: string): number => [...text].length - limit;
  // 収まるまで、description を落とす → 問の文を削る → 答えた問の値と選択肢の label を短くする
  let sizes: Sizes = { questionMax: QUESTION_TEXT_MAX, withDescription: true, answerMax: QUESTION_ANSWER_MAX, labelMax: QUESTION_OPTION_LABEL_MAX };
  let text = compose(sizes);
  if (over(text) > 0) text = compose((sizes = { ...sizes, withDescription: false }));
  while (over(text) > 0 && sizes.questionMax > QUESTION_TEXT_MIN) {
    // エスケープで伸びる分もあるので、収まるまで縮める
    sizes = { ...sizes, questionMax: Math.max(QUESTION_TEXT_MIN, sizes.questionMax - over(text)) };
    text = compose(sizes);
  }
  if (over(text) > 0) text = compose((sizes = { ...sizes, answerMax: QUESTION_TEXT_MIN, labelMax: QUESTION_TEXT_MIN }));

  const rows: ComponentRow[] = [];
  const other = { customId: questionCustomId("other", row.id, step), label: "その他" };
  const drop = { customId: questionCustomId("drop", row.id), label: "やめる" };
  if (buttons) {
    rows.push({
      kind: "buttons",
      buttons: [
        ...question.options.map((option, index) => ({
          customId: questionCustomId("pick", row.id, step, index),
          label: clipPlain(`${index + 1}. ${option.label}`, QUESTION_BUTTON_LABEL_MAX),
          style: "primary" as const,
        })),
        other,
      ],
    });
    rows.push({ kind: "buttons", buttons: [drop] });
  } else {
    rows.push({
      kind: "select",
      select: {
        customId: questionCustomId("sel", row.id, step),
        placeholder: question.multiSelect ? "選んでください（いくつでも）" : "選んでください",
        minValues: 1,
        maxValues: question.multiSelect ? question.options.length : 1,
        options: question.options.map((option, index) => ({
          label: clipPlain(`${index + 1}. ${option.label}`, QUESTION_SELECT_TEXT_MAX),
          value: String(index),
          ...(option.description.trim() === "" ? {} : { description: clipPlain(option.description, QUESTION_SELECT_TEXT_MAX) }),
        })),
      },
    });
    rows.push({ kind: "buttons", buttons: [{ customId: questionCustomId("ok", row.id, step), label: "決める", style: "primary" }, other, drop] });
  }
  const rcUrl = rcUrlOf(session);
  if (rcUrl !== undefined) rows.push({ kind: "links", links: [{ label: "RC で開く", url: rcUrl }] });
  return {
    text: fit(text, limit),
    components: rows,
    ...(options.ownerUserId === undefined ? {} : { mentionUserId: options.ownerUserId }),
  };
}

/** 「その他」のモーダルの title（header があれば「その他（<header の 40 字>）」。45 字に収まる） */
export function questionModalTitle(question: CcQuestion): string {
  return question.header.trim() === "" ? "その他" : `その他（${clipPlain(question.header, QUESTION_MODAL_HEADER_MAX)}）`;
}

/**
 * 終わった質問の結果の行（純関数）。allowed は「答えました（Discord | Web）:」と答えた問の行、denied は「答えませんでした（…）」、
 * それ以外は許可の要求と同じ（端末か RC で答えられました・時間切れ…）。escape が false なら Markdown のエスケープをしない（Web の会話）
 */
export function questionResultLine(
  row: Pick<CcPermissionRow, "state" | "via" | "alwaysRules" | "answers">,
  questions: readonly CcQuestion[],
  rcUrl: string | undefined,
  escape = true,
): string | undefined {
  const via = row.via === "discord" ? "Discord" : row.via === "web" ? "Web" : "?";
  if (row.state === "denied") return `答えませんでした（${via}）`;
  if (row.state !== "allowed") return permissionResultLine(row, rcUrl);
  const answers = row.answers ?? {};
  const lines = questions.flatMap((question, index) => {
    const value = answers[question.question];
    if (value === undefined) return [];
    if (escape) return [answerLine(index, question, value)];
    const header = question.header.trim() === "" ? "" : `「${question.header}」`;
    return [`${index + 1}. ${header}${headChars(value, QUESTION_ANSWER_MAX)}`];
  });
  return lines.length === 0 ? `答えました（${via}）` : `答えました（${via}）:\n${lines.join("\n")}`;
}

/** 終わった質問の 1 通（見出し + 結果の行。押すボタンは外し、[RC で開く] は残す。純関数） */
export function questionResolvedMessage(
  row: CcPermissionRow,
  questions: readonly CcQuestion[],
  session: CcNoticeSession | undefined,
  places: { workspaceDir: string; home: string },
): OutgoingMessage {
  const rcUrl = rcUrlOf(session);
  return {
    text: fit(`${questionHead(row, questions, session, places)}\n${questionResultLine(row, questions, rcUrl) ?? ""}`, MESSAGE_MAX_CHARS),
    components: rcUrl === undefined ? [] : [{ kind: "links", links: [{ label: "RC で開く", url: rcUrl }] }],
  };
}

/** 質問を出したときの Web の会話の 1 行（純関数。文字のまま）: 「質問: 「<header>」<最初の問の文の 200 字>…（n 問）」 */
export function questionHistoryText(questions: readonly CcQuestion[]): string {
  const first = questions[0]!;
  const header = first.header.trim() === "" ? "" : `「${first.header}」`;
  const body = [...first.question].length > 200 ? `${headChars(first.question, 200)}…` : first.question;
  return `質問: ${header}${body}（${questions.length} 問）`;
}

/** 終わった質問の Web の会話の 1 行（純関数。文字のまま）。pending なら undefined */
export function questionResultHistoryText(
  row: Pick<CcPermissionRow, "state" | "via" | "alwaysRules" | "answers">,
  questions: readonly CcQuestion[],
): string | undefined {
  const line = questionResultLine(row, questions, undefined, false);
  return line === undefined ? undefined : `質問の答え: ${line}`;
}

/** 判断待ちの理由（claude agents --json の waitingFor か、hook の Notification の種類） */
const WAITING_KIND_LABEL: Readonly<Record<string, string>> = {
  permission_prompt: "許可のダイアログ",
  elicitation_dialog: "質問のダイアログ",
  elicitation_url_dialog: "URL の確認のダイアログ",
  agent_needs_input: "入力",
};

/** 判断待ちの 1 通（純関数） */
export function waitingNotice(
  view: Pick<CcSessionView, "name" | "cwd" | "permissionMode" | "waitingFor" | "waitingKind" | "bridgeSessionId">,
  options: { workspaceDir: string; home: string; ownerUserId?: string | undefined },
): OutgoingMessage {
  const session: CcNoticeSession = { name: view.name ?? null, cwd: view.cwd ?? null, bridgeSessionId: view.bridgeSessionId };
  const reason =
    view.waitingFor !== undefined && view.waitingFor !== ""
      ? plain(view.waitingFor)
      : view.waitingKind !== null
        ? (WAITING_KIND_LABEL[view.waitingKind] ?? "判断")
        : "判断";
  const rcUrl = rcUrlOf(session);
  return {
    text: `Claude Code が判断を待っています（${duration(CC_WAIT_NOTIFY_MS / 1000)}以上）: ${sessionLabel(session, view.permissionMode, options)}\n${reason}`,
    ...(rcUrl === undefined ? {} : { components: [{ kind: "links", links: [{ label: "RC で開く", url: rcUrl }] }] }),
    ...(options.ownerUserId === undefined ? {} : { mentionUserId: options.ownerUserId }),
  };
}

/** 判断待ちの知らせの上限を超えた分の 1 通（純関数） */
export function waitingOverflowText(count: number): string {
  return `Claude Code: ほかに判断待ちが ${count} 件あります（知らせるのは 1 時間に ${CC_WAIT_NOTIFY_LIMIT} 件までです。Web で確かめてください）`;
}

/** self-agent が起動したセッションの終了の 1 行（純関数） */
export function endedNotice(session: CcNoticeSession, places: { workspaceDir: string; home: string }): string {
  return `Claude Code のセッションが終わりました: ${sessionLabel(session, null, places)}`;
}

export type CcDiscordNotifierDeps = {
  cfg: Pick<Config, "allowedGuildIds" | "ownerUserId" | "workspaceDir" | "ccPermissionHoldSec" | "ccQuestionHoldSec">;
  /** 投稿先（#system）を選ぶ */
  guildSettings: Pick<GuildSettingsStore, "get">;
  /** #system への投稿（app/system-notice.ts） */
  notify: SystemNotifier;
  /** 書き換え（既定の人格の Bot。notify と同じ） */
  gateway: Pick<Gateway, "editMessage">;
  permissions: Pick<CcPermissionStore, "get" | "setMessage" | "sessionsAnsweredSince">;
  sessions: Pick<CcSessionStore, "get" | "setNotifiedAt">;
  registry: Pick<CcRegistry, "snapshot">;
  /** Claude Code のチャンネルが開いているセッションか（判断待ちはそちらに出すので、ここでは出さない。CC12）。無ければどれも無い */
  hasChannel?: (sessionId: string) => boolean;
  /** 判断待ちの知らせの 1 時間の上限（cc/channel-posts.ts と共有する。無ければ自分だけで数える） */
  waitBudget?: CcWaitBudget;
  /** ~ の場所（ディレクトリの表示） */
  home: string;
  now: () => Date;
  timers?: CcTimers;
  log: (message: string) => void;
};

const REAL_TIMERS: CcTimers = {
  after: (fn, ms) => {
    const timer = setTimeout(fn, ms);
    return () => clearTimeout(timer);
  },
};

function errorKind(error: unknown): string {
  return error instanceof Error ? error.name : typeof error;
}

/** 判断待ちの知らせの「ほか n 件」の 1 通（窓ごとに 1 つ） */
type Overflow = { count: number; shown: number; guildId: string; channelId: string; messageId: string | undefined; busy: boolean };

export class CcDiscordNotifier implements CcPermissionListener {
  private readonly deps: CcDiscordNotifierDeps;
  private readonly timers: CcTimers;
  private cancelTimer: (() => void) | undefined;
  private started = false;
  private stopped = false;
  private readonly inFlight = new Set<Promise<void>>();
  /** 判断待ちの知らせの 1 時間の上限 */
  private readonly waitBudget: CcWaitBudget;
  private overflow: Overflow | undefined;
  /** 終了を知らせたセッション（古い順） */
  private readonly endedIds = new Set<string>();
  /** #system が無くて出せなかったことを log に出したか（変わったときだけ出す） */
  private loggedNoTarget = false;

  constructor(deps: CcDiscordNotifierDeps) {
    this.deps = deps;
    this.timers = deps.timers ?? REAL_TIMERS;
    this.waitBudget = deps.waitBudget ?? new CcWaitBudget();
  }

  /** 判断待ちを CC_WAIT_CHECK_MS ごとに確かめ始める。stop の後・2 回目は何もしない */
  start(): void {
    if (this.started || this.stopped) return;
    this.started = true;
    this.schedule();
  }

  /** 以後は新しく投稿しない（判断待ち・終了・許可の要求の 1 通）。終わった許可の要求の書き換え（停止の released を含む）は続ける */
  stop(): void {
    this.stopped = true;
    this.cancelTimer?.();
    this.cancelTimer = undefined;
  }

  /** 投稿・書き換えの途中のものを待つ */
  async idle(): Promise<void> {
    while (this.inFlight.size > 0) await Promise.all([...this.inFlight]);
  }

  /** 保留を始めた許可の要求（permission-hold.ts）: #system に 1 通 */
  held(row: CcPermissionRow): void {
    if (this.stopped) return;
    this.track(this.postPermission(row));
  }

  /** 終わった許可の要求（permission-hold.ts）: 1 通を書き換えてボタンを外す。Discord で押したものは応答で書き換える。投稿の途中なら投稿の後に書き換える */
  resolved(row: CcPermissionRow): void {
    if (row.via === "discord" || row.messageId === null || row.messageChannelId === null) return;
    this.track(this.editResolved(row));
  }

  /**
   * Discord のボタンで終えた要求の書き換え後の 1 通と、それを出した場所（app/commands/cc.ts の応答。応答に失敗したらその場所を書き換える）。
   * 行が無ければ undefined
   */
  resolvedMessage(id: number): { message: OutgoingMessage; channelId: string | null; messageId: string | null } | undefined {
    const row = this.deps.permissions.get(id);
    if (row === undefined) return undefined;
    return {
      message: permissionResolvedMessage(row, this.sessionOf(row.sessionId), this.places()),
      channelId: row.messageChannelId,
      messageId: row.messageId,
    };
  }

  /** 再起動の前に保留していて expired にした行（permission-hold.ts の recover）の 1 通を「時間切れ」に書き換える。Discord につないだ後に呼ぶ */
  rewriteRecovered(rows: readonly CcPermissionRow[]): void {
    for (const row of rows) if (row.messageId !== null && row.messageChannelId !== null) this.track(this.editResolved(row));
  }

  /** セッションが一覧から消えた（registry.ts の ended）: self-agent が起動したものだけ info で 1 行 */
  ended(session: CcSessionRow): void {
    if (this.stopped || session.startedBy === "owner" || this.endedIds.has(session.sessionId)) return;
    this.endedIds.add(session.sessionId);
    if (this.endedIds.size > ENDED_MEMORY) {
      const oldest = this.endedIds.values().next().value;
      if (oldest !== undefined) this.endedIds.delete(oldest);
    }
    const target = this.target();
    if (target === undefined) return;
    const text = endedNotice({ name: session.name, cwd: session.cwd }, this.places());
    this.track(
      this.deps.notify(target.guildId, { text }, { level: "info" }).then(
        () => {
          this.deps.log("Claude Code: セッションの終了を知らせました");
        },
        (error: unknown) => {
          this.deps.log(`Claude Code: セッションの終了を知らせられませんでした（${errorKind(error)}）`);
        },
      ),
    );
  }

  /** 判断待ちを 1 回確かめる（周期のほか、テストから呼ぶ） */
  checkWaiting(): void {
    if (this.stopped) return;
    const { sessions, hasChannel } = this.deps;
    const now = this.deps.now().getTime();
    // 許可の要求で 1 通出しているセッション（保留中か、直近に解決した行がある）と、Claude Code のチャンネルのあるセッションには出さない
    const due = dueWaitingViews(this.deps, now, (sessionId) => hasChannel?.(sessionId) !== true);
    if (due.length === 0) return;
    const target = this.target();
    if (target === undefined) return;
    for (const view of due) {
      // 出せなくてもやり直さない（待ちごとに 1 回）
      sessions.setNotifiedAt(view.sessionId, new Date(now));
      if (this.waitBudget.take(now)) {
        this.overflow = undefined;
        const message = waitingNotice(view, { ...this.places(), ownerUserId: this.deps.cfg.ownerUserId });
        this.track(
          this.deps.notify(target.guildId, message, { level: "warning" }).then(
            () => {
              this.deps.log("Claude Code: 判断待ちを知らせました");
            },
            (error: unknown) => {
              this.deps.log(`Claude Code: 判断待ちを知らせられませんでした（${errorKind(error)}）`);
            },
          ),
        );
      } else {
        if (this.overflow === undefined) {
          this.overflow = { count: 0, shown: 0, guildId: target.guildId, channelId: target.channelId, messageId: undefined, busy: false };
        }
        this.overflow.count++;
        this.track(this.flushOverflow(this.overflow));
      }
    }
  }

  private schedule(): void {
    if (this.stopped) return;
    this.cancelTimer = this.timers.after(() => {
      this.cancelTimer = undefined;
      try {
        this.checkWaiting();
      } catch (error) {
        this.deps.log(`Claude Code: 判断待ちの確認に失敗しました（${errorKind(error)}）`);
      }
      this.schedule();
    }, CC_WAIT_CHECK_MS);
  }

  private track(promise: Promise<void>): void {
    const settled = promise.catch((error: unknown) => {
      this.deps.log(`Claude Code: #system への知らせに失敗しました（${errorKind(error)}）`);
    });
    this.inFlight.add(settled);
    void settled.then(() => this.inFlight.delete(settled));
  }

  private places(): { workspaceDir: string; home: string } {
    return { workspaceDir: this.deps.cfg.workspaceDir, home: this.deps.home };
  }

  /** 投稿先: SELF_AGENT_ALLOWED_GUILD_IDS の順で最初の、#system のあるサーバー */
  private target(): { guildId: string; channelId: string } | undefined {
    for (const guildId of this.deps.cfg.allowedGuildIds) {
      const channelId = this.deps.guildSettings.get(guildId)?.systemChannelId ?? null;
      if (channelId !== null) {
        this.loggedNoTarget = false;
        return { guildId, channelId };
      }
    }
    if (!this.loggedNoTarget) {
      this.loggedNoTarget = true;
      this.deps.log("Claude Code: #system が無いため Discord に知らせていません");
    }
    return undefined;
  }

  /** 表示に使うセッションの情報（DB の行。生きていれば一覧の RC の id も） */
  private sessionOf(sessionId: string): CcNoticeSession | undefined {
    return noticeSessionOf(this.deps.sessions, this.deps.registry, sessionId);
  }

  private async postPermission(row: CcPermissionRow): Promise<void> {
    const { notify, permissions, cfg, log } = this.deps;
    const target = this.target();
    if (target === undefined) return;
    const message = permissionNotice(row, this.sessionOf(row.sessionId), {
      ...this.places(),
      // 質問（question_input のある行）は質問の保留の長さ（permissionExpiresAt と同じ分岐）
      holdSec: row.questionInput !== null ? cfg.ccQuestionHoldSec : cfg.ccPermissionHoldSec,
      ownerUserId: cfg.ownerUserId,
    });
    let messageId: string | undefined;
    try {
      messageId = await notify(target.guildId, message, { level: "warning" });
    } catch (error) {
      log(`Claude Code: 許可の要求（#${row.id}）を #system に出せませんでした（${errorKind(error)}）`);
      return;
    }
    if (messageId === undefined) return;
    permissions.setMessage(row.id, target.channelId, messageId);
    // 投稿の間に終わっていれば（Web・他で答えられた・時間切れ）書き換える
    const latest = permissions.get(row.id);
    if (latest !== undefined && latest.state !== "pending" && latest.via !== "discord") await this.editResolved(latest);
  }

  private async editResolved(row: CcPermissionRow): Promise<void> {
    if (row.messageId === null || row.messageChannelId === null) return;
    const message = permissionResolvedMessage(row, this.sessionOf(row.sessionId), this.places());
    try {
      await this.deps.gateway.editMessage(row.messageChannelId, row.messageId, message);
    } catch (error) {
      this.deps.log(`Claude Code: 許可の要求（#${row.id}）の知らせを書き換えられませんでした（${errorKind(error)}）`);
    }
  }

  /** 「ほか n 件」の 1 通を今の数に合わせる（無ければ投稿し、あれば書き換える）。途中で数が増えたら合わせ直す */
  private async flushOverflow(overflow: Overflow): Promise<void> {
    if (overflow.busy) return;
    overflow.busy = true;
    try {
      while (overflow.shown !== overflow.count) {
        const count = overflow.count;
        const text = waitingOverflowText(count);
        if (overflow.messageId === undefined) {
          const messageId = await this.deps.notify(overflow.guildId, { text }, { level: "info" });
          if (messageId === undefined) return;
          overflow.messageId = messageId;
        } else {
          await this.deps.gateway.editMessage(overflow.channelId, overflow.messageId, { text });
        }
        overflow.shown = count;
      }
      this.deps.log(`Claude Code: 判断待ちの知らせを上限のためまとめました（${overflow.count} 件）`);
    } catch (error) {
      this.deps.log(`Claude Code: 判断待ちの知らせをまとめられませんでした（${errorKind(error)}）`);
    } finally {
      overflow.busy = false;
    }
  }
}
