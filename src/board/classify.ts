// 進行中のプロジェクトの状態の判定（docs/plan/project-board.md §4 PS1）。純関数。LLM は使わない。
// 上から順に working → owner → agent → done → unknown を当て、最初に当たった状態にする。根拠の行は当たったものすべてを並べる（番号と件数だけ。題名は入れない）

/** 状態。working = 作業中、owner = オーナーの対応待ち、agent = やること待ち、done = 一通り完了、unknown = 分からない */
export type BoardState = "working" | "owner" | "agent" | "done" | "unknown";

export const BOARD_STATES: readonly BoardState[] = ["working", "owner", "agent", "done", "unknown"];

/** 自分の PR の CI（check-runs）。none は 0 件、unchecked は引いていない（draft・上限の後・sha が無い） */
export type BoardCi = "success" | "failure" | "pending" | "none" | "unchecked";

/** GitHub の一覧が 1 ページの上限に当たったか（PR 30 件・issue 50 件。それより先は読んでいない） */
export type BoardCapped = { pulls: boolean; issues: boolean };

export const NOT_CAPPED: BoardCapped = { pulls: false, issues: false };

/** PR・issue の 1 件。url は検証した owner・repo・番号から組み立てたもの、title は先頭 200 字で改行を空白にしたもの（信頼しないデータ） */
export type BoardItem = {
  kind: "pr" | "issue";
  number: number;
  title: string;
  url: string;
  /** 作成者が gh のログイン */
  mine: boolean;
  draft: boolean;
  ci: BoardCi;
};

/** git の作業場所の状態。dirty は変更のあるファイルの数（未追跡を含む）、ahead・behind は upstream との差（upstream が無ければ 0） */
export type BoardLocal = {
  branch: string | null;
  dirty: number;
  ahead: number;
  behind: number;
  /** 最後のコミットの時刻（ISO）。コミットが無い・読めなければ null */
  lastCommitAt: string | null;
};

/** そのプロジェクトの Claude Code のセッション（cwd がプロジェクトの dir かその中のもの） */
export type BoardCcSession = {
  sessionId: string;
  state: "needs_input" | "running" | "idle";
  /** 許可の要求を保留している */
  pendingPermission: boolean;
};

/** 根拠の行の上限 */
export const BOARD_MAX_REASONS = 8;

export type ClassifyInput = {
  /** まだ一度も確かめていない（登録した直後） */
  unchecked?: boolean;
  /** remote が無い（GitHub の項目は使わない） */
  noRemote: boolean;
  /** git の作業場所の状態。git が失敗したら null */
  local: BoardLocal | null;
  /** PR・issue（open なもの）。GitHub を一度も取れていなければ null */
  items: readonly BoardItem[] | null;
  /** items が上限に当たったか（省略は当たっていない） */
  capped?: BoardCapped;
  ccSessions: readonly BoardCcSession[];
  /** そのプロジェクトのセッション（sessions.project_dir）のターンが実行中 */
  sessionTurnRunning: boolean;
};

export type Classification = { state: BoardState; reasons: string[] };

export function classifyProject(input: ClassifyInput): Classification {
  const reasons: string[] = [];
  let state: BoardState | undefined;
  const hit = (candidate: BoardState, lines: readonly string[]): void => {
    if (lines.length === 0) return;
    reasons.push(...lines);
    state ??= candidate;
  };

  // 1. working
  const running = input.ccSessions.filter((session) => session.state === "running").length;
  hit("working", [
    ...(running > 0 ? [`Claude Code が作業中（${running}）`] : []),
    ...(input.sessionTurnRunning ? ["self-agent のセッションが作業中"] : []),
  ]);

  // GitHub の項目は remote があり、一度でも取れたときだけ使う
  const items = input.noRemote ? null : input.items;
  const prs = (items ?? []).filter((item) => item.kind === "pr");
  const issues = (items ?? []).filter((item) => item.kind === "issue");

  // 2. owner
  const waiting = input.ccSessions.filter((session) => session.state === "needs_input" || session.pendingPermission).length;
  hit("owner", [
    ...(waiting > 0 ? [`Claude Code が判断を待っています（${waiting}）`] : []),
    ...prs.filter((pr) => pr.mine && !pr.draft && (pr.ci === "success" || pr.ci === "none")).map((pr) => `マージの判断待ちの PR #${pr.number}`),
    ...prs.filter((pr) => !pr.mine).map((pr) => `レビュー待ちの PR #${pr.number}`),
  ]);

  // 未コミット・未 push は、生きている（running・needs_input・許可の要求を保留している）Claude Code のセッションが無いときだけ数える。
  // 待機（idle）のセッションがあれば、その変更はセッションが持っていて次の指示を待っているので owner、1 つも無ければ agent
  const local = input.local;
  const live = input.ccSessions.some((session) => session.state !== "idle" || session.pendingPermission);
  const idle = input.ccSessions.filter((session) => session.state === "idle" && !session.pendingPermission).length;
  const localLines =
    local === null || live
      ? []
      : [
          ...(local.dirty > 0 ? [`未コミットの変更 ${local.dirty} ファイル`] : []),
          ...(local.ahead > 0 ? [`push していないコミット ${local.ahead} 件`] : []),
        ];
  if (localLines.length > 0 && idle > 0) hit("owner", [`Claude Code が次の指示を待っています（${idle}）`, ...localLines]);

  // 3. agent
  const issuesCapped = input.capped?.issues === true;
  hit("agent", [
    ...prs.filter((pr) => pr.mine && pr.ci === "failure").map((pr) => `CI が落ちている PR #${pr.number}`),
    ...prs.filter((pr) => pr.mine && pr.draft && pr.ci !== "failure").map((pr) => `作業途中の draft PR #${pr.number}`),
    ...(issues.length > 0 ? [`手つかずの issue ${issues.length} 件${issuesCapped ? "以上" : ""}`] : []),
    ...(idle === 0 ? localLines : []),
  ]);

  // CI が実行中・確かめていない自分の PR（draft でないもの）は根拠の行だけ足し、状態は決めない
  reasons.push(
    ...prs
      .filter((pr) => pr.mine && !pr.draft && (pr.ci === "pending" || pr.ci === "unchecked"))
      .map((pr) => (pr.ci === "pending" ? `CI 実行中の PR #${pr.number}` : `CI を確かめていない PR #${pr.number}`)),
  );

  // 5. unknown の理由（ほかの状態に当たっても、当たった根拠として並べる）
  const unknownLines = input.unchecked
    ? ["まだ確かめていません"]
    : [
        ...(input.noRemote ? ["remote がありません"] : []),
        ...(!input.noRemote && input.items === null ? ["GitHub をまだ読めていません"] : []),
        ...(local === null ? ["git が失敗しました"] : []),
      ];

  // 4. done（材料がそろっていて、open な PR・issue と未コミット・未 push が無い）
  if (state === undefined && unknownLines.length === 0 && items !== null && local !== null) {
    if (items.length === 0 && local.dirty === 0 && local.ahead === 0) hit("done", ["open な issue・PR はありません"]);
  }

  reasons.push(...unknownLines);
  // どれにも当たらない（CI 実行中の PR だけ・生きているセッションがあって未コミットの変更がある、など）は分からないにする
  if (state === undefined && unknownLines.length === 0) reasons.push("状態を決められません");
  return { state: state ?? "unknown", reasons: reasons.slice(0, BOARD_MAX_REASONS) };
}

/** GET /api/board の並び（owner → agent → working → done → unknown） */
export const BOARD_DISPLAY_ORDER: readonly BoardState[] = ["owner", "agent", "working", "done", "unknown"];
