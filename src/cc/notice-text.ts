// Claude Code の知らせの文面（純関数。docs/plan/claude-code-sessions.md §5.2・docs/plan/claude-code-questions.md §3・§5。Q4 で discord-notice.ts から移した）。
// 出すのは cc/channel-posts.ts（そのセッションの Claude Code のチャンネル）で、#system には出さない。
// - 許可の要求の 1 通（permissionNotice）: 1 行目 [許可][このセッションでは常に許可][拒否]（`cc:perm:allow|always|deny:<id>`。常に許可はルールがあるときだけ）、
//   2 行目 [RC で開く]（リンク。RC の id が分かるときだけ）。終わった 1 通（permissionResolvedMessage）は見出しの後ろを結果の行にしてボタンを外す。
// - 質問（AskUserQuestion。Q2）の 1 通（questionNotice）は 1 問ずつ書き換え（押した処理は app/commands/cc-question.ts）、終わったら答えの行（questionResolvedMessage）。
// - 判断待ちの 1 通（waitingNotice）と、知らせる判断待ちの選び方（dueWaitingViews）・1 時間の上限（CcWaitBudget）。
// 名前・ディレクトリ・要約・ルール・問は hook から来たデータなので、Markdown とメンションを無効にする（要約はコードブロックに入れる）
import { mentionPrefix } from "../discord/convert.ts";
import { escapeDiscordText } from "../discord/escape.ts";
import type { ComponentRow, OutgoingMessage } from "../discord/gateway.ts";
import type { CcPermissionRow, CcPermissionStore } from "../store/cc-permissions.ts";
import type { CcSessionStore } from "../store/cc-sessions.ts";
import { headChars } from "../store/cc-sessions.ts";
import { CC_RC_URL_PREFIX } from "../web/routes/cc.ts";
import { cwdLabel } from "./labels.ts";
import { CC_PERMISSION_SUPPRESS_MS } from "./permission-hold.ts";
import { describeRule, formatRule } from "./permissions.ts";
import { CC_QUESTION_MULTI_SEPARATOR, CC_QUESTION_TOOL, type CcQuestion, type CcQuestionPick, parseQuestionInput } from "./questions.ts";
import type { CcRegistry, CcSessionView } from "./registry.ts";

/** 判断待ちがこの間続いたら知らせる（決定 2） */
export const CC_WAIT_NOTIFY_MS = 60_000;
/** 判断待ちを確かめる周期 */
export const CC_WAIT_CHECK_MS = 10_000;
/** 判断待ちの知らせを数える窓 */
export const CC_WAIT_NOTIFY_WINDOW_MS = 60 * 60_000;
/** 窓の中で出す数（超えた分はチャンネルに短い 1 行だけ。cc/channel-posts.ts） */
export const CC_WAIT_NOTIFY_LIMIT = 10;
/** 常に許可のルールを Discord に出す長さの上限（超えたら Discord では [このセッションでは常に許可] を出さず、Web へ案内する） */
export const CC_DISCORD_RULES_MAX_CHARS = 800;
/** 名前・ディレクトリを出す長さ */
const LABEL_MAX_CHARS = 100;
/** 1 通の上限（Discord） */
const MESSAGE_MAX_CHARS = 2000;

/** 判断待ちの知らせの 1 時間の上限（全部の Claude Code のチャンネルで 1 つで数える。プロセスの中） */
export class CcWaitBudget {
  private times: number[] = [];

  /** 窓の中で CC_WAIT_NOTIFY_LIMIT 件に達していなければ 1 件使って true */
  take(now: number): boolean {
    if (!this.available(now)) return false;
    this.times.push(now);
    return true;
  }

  /** 窓の中で CC_WAIT_NOTIFY_LIMIT 件に達していないか（使わない。チャンネルを作る前に確かめる） */
  available(now: number): boolean {
    this.times = this.times.filter((at) => now - at < CC_WAIT_NOTIFY_WINDOW_MS);
    return this.times.length < CC_WAIT_NOTIFY_LIMIT;
  }
}

/**
 * 知らせる判断待ち: 許可の要求以外の判断待ちが CC_WAIT_NOTIFY_MS 続き、その待ちをまだ知らせていないセッション。保留中か直近 60 秒に
 * 解決した許可の要求（released を除く）のあるセッションは除く。include で絞る（SELF_AGENT_CC_NOTIFY=0 ならチャンネルのあるセッションだけ）
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
  /** ボタンが効く時間（呼び出し側が行で選ぶ: 質問の行は SELF_AGENT_CC_QUESTION_HOLD_SEC、それ以外は SELF_AGENT_CC_PERMISSION_HOLD_SEC） */
  holdSec: number;
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
    return questionNotice(row, parsed.questions, [], session, options);
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

// ---- 質問（AskUserQuestion。docs/plan/claude-code-questions.md §3。Q2）。1 通を 1 問ずつ書き換える ----

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

/** 終わった質問の Web の会話の 1 行（純関数。文字のまま）。答えたものは「質問の答え: …」、それ以外は「質問の結果: …」。pending なら undefined */
export function questionResultHistoryText(
  row: Pick<CcPermissionRow, "state" | "via" | "alwaysRules" | "answers">,
  questions: readonly CcQuestion[],
): string | undefined {
  const line = questionResultLine(row, questions, undefined, false);
  if (line === undefined) return undefined;
  // 答えた・答えなかった（Discord・Web）は「質問の答え」、端末か RC で答えられた・時間切れ・停止は「質問の結果」
  return row.state === "allowed" || row.state === "denied" ? `質問の答え: ${line}` : `質問の結果: ${line}`;
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
