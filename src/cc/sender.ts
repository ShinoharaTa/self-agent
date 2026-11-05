// Claude Code のセッションへの送信（docs/plan/claude-code-sessions.md §3.2・§7 の 2〜4・6。CC3）。Web の composer（routes/cc.ts）が submit で
// cc_sends に queued で積み、待ち行列（起動後は CC_SEND_RETRY_MS ごと。積んだときはすぐ）が古い順に 1 件ずつ試す（アプリ全体で同時に 1 つ）。
// SDK のツール cc_send（CC7）は propose で Discord の確認待ち（awaiting_confirm）の行を作り、[送る]（confirm）で queued にする。
// 試すたびに一覧（registry）の pid から送り先のペインを引き直し（祖先の関係で当たり pane_current_command が claude のものだけ。panes.ts の
// findSendablePane）、probePaneState が idle（2 回）のときだけ load-buffer → paste-buffer -p -d → 0.5 秒後に pasteLanded → Enter → 2 秒後に確かめる。
// 貼れたか確かめられなければ Enter を押さず unconfirmed（やり直さない）。複数行が 1 行目で送信されたように見えるのが別の送信で
// CC_MULTILINE_DETECT_LIMIT 回続いたら cc_state.multiline_ok を false にして #system に 1 行、以後は改行を空白に置き換えて送る
// （戻すのは npm run cc-dry-run -- --reset-multiline）。idle でなければ積んだまま待ち、SELF_AGENT_CC_SEND_WAIT_MIN 分で gave_up。
// 起動の最初の指示（origin start。cc/starter.ts）はペイン宛てに積まれ、そのペインに一覧のセッションが現れたら session_id を結びつけてから同じ経路で送る
// （結びつけるのは claude agents --json の cwd が起動したディレクトリ（cc_sends.start_dir）と同じものだけ。それまでは積んだまま。ペインが無くなれば gone、
// CC_START_BIND_GRACE_MS 経ってもペインが claude でなければ not_claude、そのペインの claude の cwd が違えば cwd_mismatch）。
// 再起動で delivering のまま残った行は unconfirmed（recover）。log は送信の番号・状態・理由の種類だけ（本文・名前・ペイン id・sessionId は出さない）。
// Claude Code のチャンネル（docs/plan/claude-code-channels.md §3.3。CC11）: チャンネルへのオーナーの発言は origin discord で確認なしに積み、同じセッションに
// CC_CHANNEL_QUEUE_MAX 件まで積める（Web・ツール・GitHub の送信は今までどおり、まだ終わっていない行があれば already_queued）。同じセッションに貼った pass では、
// そのセッションの次の queued を試さない（次の Stop か CC_SEND_RETRY_MS 後の pass で試す）。積んだ直後・終わったとき・ダイアログで待っているときは channels に渡す
// （チャンネルを作る・写す・印を付ける）
// Enter の後の確かめで、許可などのダイアログが出ていても貼った文字が入力欄から消えていれば届いたとみなす。unconfirmed の送信は、貼り始めてから
// （終わった後は CC_PROMPT_CONFIRM_WINDOW_MS 以内に）そのセッションの UserPromptSubmit の本文が同じ（promptKey）なら delivered に直す（§3.3）
import { setTimeout as sleepMs } from "node:timers/promises";
import type { SystemNotifier } from "../app/system-notice.ts";
import type { Config } from "../config.ts";
import type { CcSendOrigin, CcSendRow, CcSendStore } from "../store/cc-sends.ts";
import { CC_PROMPT_MAX_CHARS, type CcSessionStore, headChars } from "../store/cc-sessions.ts";
import { classifyScreen, pasteCleared, pasteLanded, pasteSubmittedEarly, probePaneState } from "../tmux/pane-state.ts";
import type { Tmux } from "../tmux/tmux.ts";
import type { CcHookEvent } from "./hook-server.ts";
import { sessionOnStartedPane, type CcPaneResolver } from "./panes.ts";
import type { CcRegistry, CcTimers } from "./registry.ts";

/** 送る本文の上限（コードポイント。§3.2。Web の composer は 2,000 字で止める） */
export const CC_SEND_MAX_CHARS = 4000;
/** 待ち行列を試す間隔 */
export const CC_SEND_RETRY_MS = 30_000;
/** 同じセッション・同じ本文をこの間に受けたら、前の送信を返す（§3.2 の二重送信の 1） */
export const CC_SEND_DUPLICATE_MS = 5_000;
/** 貼ってから貼れたかを撮るまで */
export const CC_PASTE_CHECK_DELAY_MS = 500;
/** Enter を押してから送信できたかを撮るまで */
export const CC_ENTER_CHECK_DELAY_MS = 2_000;
/** ペイン宛ての送信（起動の最初の指示）で、作ってからこの間はペインが claude でなくても待つ（起動の途中はシェルのことがある） */
export const CC_START_BIND_GRACE_MS = 60_000;

/** Claude Code のチャンネルから同じセッションに積める、オーナーの発言（origin discord）の queued の数（§3.3） */
export const CC_CHANNEL_QUEUE_MAX = 5;

/** unconfirmed にした送信を、この間に来た UserPromptSubmit（本文が同じ）で delivered に直す（docs/plan/claude-code-channels.md §3.3） */
export const CC_PROMPT_CONFIRM_WINDOW_MS = 30_000;

/** 複数行が 1 行目で送信されたように見えるのが、別の送信でこの回数続いたら複数行を止める（数えるのはプロセスの中だけ） */
export const CC_MULTILINE_DETECT_LIMIT = 2;

/** 改行（LF）以外の制御文字（C0・DEL・C1） */
const CONTROL_EXCEPT_LF = /[\u0000-\u0009\u000b-\u001f\u007f-\u009f]/;

export type CcTextCheck = { ok: true; text: string } | { ok: false; reason: "empty" | "too_long" | "invalid_text" };

/**
 * 送る本文の検証（純関数。§3.2）: 文字列で、末尾の改行を落として空白だけでなく、LF 以外の制御文字（CR・TAB・ESC など）が無く、
 * CC_SEND_MAX_CHARS 字以内。通れば末尾の改行を落としたもの
 */
export function normalizeSendText(raw: unknown): CcTextCheck {
  if (typeof raw !== "string") return { ok: false, reason: "empty" };
  const text = raw.replace(/\n+$/, "");
  if (text.trim() === "") return { ok: false, reason: "empty" };
  if (CONTROL_EXCEPT_LF.test(text)) return { ok: false, reason: "invalid_text" };
  if ([...text].length > CC_SEND_MAX_CHARS) return { ok: false, reason: "too_long" };
  return { ok: true, text };
}

/** 複数行を止めているときの本文（改行を空白に置き換える。§3.2） */
export function singleLine(text: string): string {
  return text.replace(/\n/g, " ");
}

/**
 * UserPromptSubmit の prompt と送った本文を比べるための形（純関数。空白（改行を含む）の連なりを 1 つの空白にして前後を除き、先頭 CC_PROMPT_MAX_CHARS 字）。
 * 送った本文は貼ったときの形（singleLine の後）を渡す
 */
export function promptKey(text: string): string {
  return headChars(text.replace(/\s+/g, " ").trim(), CC_PROMPT_MAX_CHARS);
}

/** multiline_ok を false にしたときの #system の 1 行（名前・本文は入れない） */
export const CC_MULTILINE_OFF_NOTICE =
  "Claude Code: 複数行の貼り付けが続けて 1 行目で送信されたため、以後は改行を空白に置き換えて送ります（ブラケット貼り付けが効いていません。確かめたら npm run cc-dry-run -- --reset-multiline で戻せます）";

/** submit の結果。channelId は送り先のセッションの開いている Claude Code のチャンネル（あれば。返事はそこに出る） */
export type CcSubmitResult =
  | { ok: true; send: CcSendRow; duplicate: boolean; channelId?: string }
  | { ok: false; reason: "not_found" | "already_queued" | "queue_full" | "not_in_tmux" | "not_claude" | "no_server" | "tmux_failed" | "stopped" };

/** Claude Code のチャンネル（cc/channels.ts。CC11）に渡すもの。どれも投げても送信の処理は止めない */
export type CcSenderChannels = {
  /**
   * 送信を queued にした直後（貼る前）。外から積んだ送信（web・tool・github）ならチャンネルを作り（作れなければそのまま）写しを出し、
   * 届け待ちの印を付ける。guildId は作るサーバー（Discord で押した [対応] のサーバー。DB には入れない）。送り先のセッションの開いているチャンネルの ID を返す
   */
  announce(row: CcSendRow, guildId?: string): Promise<string | undefined>;
  /** 送信が終わった（delivered・unconfirmed・failed・gave_up・cancelled）。印を付け替える */
  settled(row: CcSendRow): void;
  /** 送り先のダイアログ（dialog）で待っている */
  dialog(row: CcSendRow): void;
};

export type CcCancelResult = "cancelled" | "not_found" | "stale";

/** 送り先を確かめられなかった理由（submit・propose で共通） */
export type CcTargetFailure = "not_found" | "not_in_tmux" | "not_claude" | "no_server" | "tmux_failed" | "stopped";

/** Discord の確認待ちの送信を作った結果（cc_send。CC7） */
export type CcProposeResult = { ok: true; send: CcSendRow } | { ok: false; reason: CcTargetFailure | "already_queued" };

/** [送る] の結果（queued にした・行が無い・確認待ちでない） */
export type CcConfirmResult = "queued" | "not_found" | "stale";

export type CcSenderDeps = {
  cfg: Pick<Config, "ccSendWaitMin" | "allowedGuildIds">;
  registry: Pick<CcRegistry, "snapshot">;
  panes: Pick<CcPaneResolver, "lookup">;
  tmux: Pick<Tmux, "listPanes" | "listClients" | "capturePane" | "loadBuffer" | "pasteBuffer" | "deleteBuffer" | "sendEnter">;
  sends: Pick<
    CcSendStore,
    | "add"
    | "get"
    | "findRecentSame"
    | "activeFor"
    | "listQueued"
    | "transition"
    | "noteAttempt"
    | "recoverDelivering"
    | "giveUpOlderThan"
    | "bindSession"
    | "confirm"
    | "countQueuedDiscord"
    | "listDelivering"
    | "listUnconfirmedSince"
    | "confirmUnconfirmed"
  >;
  sessions: Pick<CcSessionStore, "multilineOk" | "setMultilineOk">;
  /** #system への知らせ（無ければ log だけ） */
  notify?: SystemNotifier;
  /**
   * 貼っている途中（delivering）から終わりの状態（delivered・unconfirmed・failed）に移した後に、移した後の行を渡す（返事を Discord に戻す
   * cc/replies.ts の追いかけ。CC8）。投げても送信の処理は止めない
   */
  onFinished?: (row: CcSendRow) => void;
  /** Claude Code のチャンネル（CC11。SELF_AGENT_CC=1 のときだけ）。無ければチャンネルには何もしない */
  channels?: CcSenderChannels;
  now: () => Date;
  /** 既定は timers/promises の setTimeout */
  sleep?: (ms: number) => Promise<void>;
  timers?: CcTimers;
  log: (message: string) => void;
};

const REAL_TIMERS: CcTimers = {
  after: (fn, ms) => {
    const timer = setTimeout(fn, ms);
    return () => clearTimeout(timer);
  },
};

/** 一覧のすべての pid（入れ子の claude を打ち切るため。panes.ts） */
function sessionPids(sessions: ReadonlyArray<{ pid: number }>): ReadonlySet<number> {
  return new Set(sessions.map((session) => session.pid));
}

function errorKind(error: unknown): string {
  return error instanceof Error ? error.name : typeof error;
}

export class CcSender {
  private readonly deps: CcSenderDeps;
  private readonly timers: CcTimers;
  private readonly sleep: (ms: number) => Promise<void>;
  private cancelTimer: (() => void) | undefined;
  private started = false;
  private stopped = false;
  private running: Promise<void> | undefined;
  private rerun = false;
  /** 複数行が 1 行目で送信されたように見えた送信が続いた数（複数行が貼れたら 0 に戻す） */
  private earlySubmits = 0;
  /** 再起動の前に貼っていて unconfirmed にした送信と、待ちの上限を過ぎて gave_up にした送信（Discord につないだ後の start で印を付ける） */
  private recovered: number[] = [];
  /** 直近 CC_PROMPT_CONFIRM_WINDOW_MS に受けた UserPromptSubmit（セッションごとの promptKey と受けた時刻。プロセスの中だけ） */
  private readonly prompts = new Map<string, Array<{ key: string; at: number }>>();
  /** 貼っている途中の送信の、貼り始めた時刻（それより後の UserPromptSubmit だけを届いた証拠にする） */
  private readonly deliveringSince = new Map<number, number>();

  constructor(deps: CcSenderDeps) {
    this.deps = deps;
    this.timers = deps.timers ?? REAL_TIMERS;
    this.sleep = deps.sleep ?? ((ms: number) => sleepMs(ms).then(() => undefined));
  }

  /** 起動時（受け付けを始める前）に 1 回: delivering のまま残った行を unconfirmed に、待ちの上限を過ぎた queued を gave_up にする */
  recover(): void {
    this.recovered = this.deps.sends.listDelivering().map((row) => row.id);
    const recovered = this.deps.sends.recoverDelivering();
    if (recovered > 0) this.deps.log(`Claude Code: 再起動の前に貼っていた送信 ${recovered} 件を確かめられないものにしました`);
    // まだ Discord につないでいないので、諦めた送信の印は start で付ける
    this.recovered.push(...this.expire(false));
  }

  /** 直後に 1 回試し、以後は CC_SEND_RETRY_MS ごと。stop の後・2 回目は何もしない */
  start(): void {
    if (this.started || this.stopped) return;
    this.started = true;
    // Discord につないだ後なので、再起動の前に貼っていた送信の印をここで付け直す
    for (const id of this.recovered) this.settled(id);
    this.recovered = [];
    this.loop();
  }

  /** 以後は試さない（実行中の 1 件は idle で待つ） */
  stop(): void {
    this.stopped = true;
    this.cancelTimer?.();
    this.cancelTimer = undefined;
  }

  async idle(): Promise<void> {
    await this.running;
  }

  /**
   * 送信を受け付ける（§3.2）。text は normalizeSendText を通したもの。送り先のペインを確かめてから（tmux の外・claude でない・サーバーが無いなら積まない）、
   * 同じセッション・同じ本文の CC_SEND_DUPLICATE_MS 以内の行があればそれを、そのセッションにまだ終わっていない行があれば already_queued を返し、
   * それ以外は queued で積んで待ち行列をすぐ回す。notificationId は GitHub の [対応]（origin github。CC6）のときだけ。
   * origin discord（Claude Code のチャンネルへのオーナーの発言。channelId・messageId はその発言）は、まだ終わっていない行があっても
   * そのセッションの origin discord の queued が CC_CHANNEL_QUEUE_MAX 件未満なら積む（それ以上は queue_full）。
   * 積んだら channels の announce（チャンネルを作る・写す・印）を待ってから待ち行列を回す（作る → 写す → 積む の順）
   */
  async submit(input: {
    sessionId: string;
    text: string;
    origin: CcSendOrigin;
    notificationId?: number;
    channelId?: string;
    messageId?: string;
    /** Claude Code のチャンネルを作るサーバー（Discord の [対応] の押したサーバー。DB には入れず announce に渡すだけ） */
    guildId?: string;
  }): Promise<CcSubmitResult> {
    const { sends, now, log } = this.deps;
    const checked = await this.checkTarget(input.sessionId);
    if (checked !== undefined) return { ok: false, reason: checked };
    // ここから行を作るまで await しない（同時に来た 2 つの要求でも二重に積まない）
    const same = sends.findRecentSame(input.sessionId, input.text, new Date(now().getTime() - CC_SEND_DUPLICATE_MS));
    if (same !== undefined) return { ok: true, send: same, duplicate: true };
    if (input.origin === "discord") {
      if (sends.countQueuedDiscord(input.sessionId) >= CC_CHANNEL_QUEUE_MAX) return { ok: false, reason: "queue_full" };
    } else if (sends.activeFor(input.sessionId) !== undefined) {
      return { ok: false, reason: "already_queued" };
    }
    const send = sends.add({
      sessionId: input.sessionId,
      text: input.text,
      origin: input.origin,
      state: "queued",
      ...(input.notificationId === undefined ? {} : { notificationId: input.notificationId }),
      ...(input.channelId === undefined ? {} : { channelId: input.channelId }),
      ...(input.messageId === undefined ? {} : { messageId: input.messageId }),
    });
    log(`Claude Code: 送りました（#${send.id}、queued）`);
    const channelId = await this.announce(send.id, input.guildId);
    void this.kick();
    return { ok: true, send: sends.get(send.id) ?? send, duplicate: false, ...(channelId === undefined ? {} : { channelId }) };
  }

  /**
   * 積んだ直後の送信を channels に渡す（チャンネルを作る・写す・届け待ちの印。submit と、[送る]（confirm）の後に cc-confirm.ts が呼ぶ）。
   * 送り先のセッションの開いている Claude Code のチャンネルの ID を返す。reject しない
   */
  async announce(id: number, guildId?: string): Promise<string | undefined> {
    const { channels, sends, log } = this.deps;
    const row = sends.get(id);
    if (channels === undefined || row === undefined) return undefined;
    try {
      return await channels.announce(row, guildId);
    } catch (error) {
      log(`Claude Code: 送信をチャンネルに渡せませんでした（#${id}、${errorKind(error)}）`);
      return undefined;
    }
  }

  /** 終わった送信を channels に渡す（印の付け替え）。投げても止めない */
  private settled(id: number): void {
    const { channels, sends, log } = this.deps;
    if (channels === undefined) return;
    try {
      const row = sends.get(id);
      if (row !== undefined) channels.settled(row);
    } catch (error) {
      log(`Claude Code: 送信の印を付け替えられませんでした（#${id}、${errorKind(error)}）`);
    }
  }

  /**
   * Discord の確認待ちの送信を作る（cc_send。§5.3）。送り先を submit と同じく確かめ、そのセッションにまだ終わっていない行があれば already_queued、
   * それ以外は awaiting_confirm（origin tool）で作る。送るのは [送る]（confirm）の後。text は normalizeSendText を通したもの
   */
  async propose(input: { sessionId: string; text: string; channelId: string }): Promise<CcProposeResult> {
    const checked = await this.checkTarget(input.sessionId);
    if (checked !== undefined) return { ok: false, reason: checked };
    // ここから行を作るまで await しない
    if (this.deps.sends.activeFor(input.sessionId) !== undefined) return { ok: false, reason: "already_queued" };
    const send = this.deps.sends.add({
      sessionId: input.sessionId,
      text: input.text,
      origin: "tool",
      state: "awaiting_confirm",
      channelId: input.channelId,
    });
    return { ok: true, send };
  }

  /** [送る]: 確認待ちの送信を queued にする（待ち行列を回すのは呼び出し側の kick）。確認待ちでなければ stale */
  confirm(id: number): CcConfirmResult {
    if (this.deps.sends.get(id) === undefined) return "not_found";
    if (!this.deps.sends.confirm(id)) return "stale";
    this.deps.log(`Claude Code: 送りました（#${id}、queued）`);
    return "queued";
  }

  /** 送り先を確かめる（一覧に居る・tmux の claude のペインに当たる）。通れば undefined */
  private async checkTarget(sessionId: string): Promise<CcTargetFailure | undefined> {
    const { registry, panes } = this.deps;
    if (this.stopped) return "stopped";
    const { sessions } = registry.snapshot();
    const view = sessions.find((session) => session.sessionId === sessionId);
    if (view === undefined) return "not_found";
    const lookup = await panes.lookup(sessionPids(sessions));
    if (!lookup.ok) return lookup.reason === "no_server" ? "no_server" : "tmux_failed";
    const target = lookup.sendable({ pid: view.pid, tmux: view.tmux });
    if (!target.ok) return target.reason;
    if (this.stopped) return "stopped";
    return undefined;
  }

  /** queued（と Discord の確認待ち）の送信を取り消す。貼っている途中・終わったものは stale */
  cancel(id: number): CcCancelResult {
    const row = this.deps.sends.get(id);
    if (row === undefined) return "not_found";
    if (!this.deps.sends.transition(id, ["queued", "awaiting_confirm"], "cancelled")) return "stale";
    this.deps.log(`Claude Code: 送信を取り消しました（#${id}）`);
    this.settled(id);
    return "cancelled";
  }

  /**
   * 採った hook の事象（registry の onEvent）。Stop ならターンが終わったので、作業中に積んだ送信を CC_SEND_RETRY_MS の周期を待たずに試す。
   * UserPromptSubmit なら覚えておき（貼っている途中の送信が unconfirmed で終わったときに比べる）、CC_PROMPT_CONFIRM_WINDOW_MS 以内に unconfirmed に
   * したそのセッションの送信で本文が同じものがあれば delivered に直す
   */
  onEvent(event: Pick<CcHookEvent, "event"> & Partial<Pick<CcHookEvent, "sessionId" | "prompt" | "receivedAt">>): void {
    if (event.event === "Stop") void this.kick();
    if (event.event !== "UserPromptSubmit" || event.sessionId === undefined || event.prompt === undefined || event.prompt === "") return;
    try {
      const at = (event.receivedAt ?? this.deps.now()).getTime();
      const key = promptKey(event.prompt);
      const kept = (this.prompts.get(event.sessionId) ?? []).filter((prompt) => at - prompt.at < CC_PROMPT_CONFIRM_WINDOW_MS);
      kept.push({ key, at });
      this.prompts.set(event.sessionId, kept);
      const since = new Date(at - CC_PROMPT_CONFIRM_WINDOW_MS);
      const match = this.deps.sends.listUnconfirmedSince(event.sessionId, since).find((row) => this.sentKey(row) === key);
      if (match !== undefined) this.confirmByPrompt(match.id);
    } catch (error) {
      this.deps.log(`Claude Code: 送信の指示の届きを確かめられませんでした（${errorKind(error)}）`);
    }
  }

  /** 送った本文の promptKey（singleLine を当てる。promptKey が空白を 1 つにするので、複数行のまま貼ったものでも同じ形になる） */
  private sentKey(row: CcSendRow): string {
    return promptKey(singleLine(row.text));
  }

  /** since 以後に受けた、そのセッションの本文が同じ UserPromptSubmit があるか */
  private promptSeen(row: CcSendRow, since: number): boolean {
    if (row.sessionId === null) return false;
    const key = this.sentKey(row);
    return (this.prompts.get(row.sessionId) ?? []).some((prompt) => prompt.at >= since && prompt.key === key);
  }

  /** unconfirmed の送信を delivered に直し、印を付け替えて onFinished に渡す */
  private confirmByPrompt(id: number): void {
    if (!this.deps.sends.confirmUnconfirmed(id, "prompt_submit")) return;
    this.deps.log(`Claude Code: 送りました（#${id}、delivered。指示を受けたことを確かめました）`);
    this.settled(id);
    this.finished(id);
  }

  /** 待ち行列を 1 回回す。回している途中なら、終わった後にもう 1 回回す。reject しない */
  kick(): Promise<void> {
    if (this.stopped) return Promise.resolve();
    if (this.running !== undefined) {
      this.rerun = true;
      return this.running;
    }
    const running = (async () => {
      do {
        this.rerun = false;
        await this.pass();
      } while (this.rerun && !this.stopped);
    })().finally(() => {
      this.running = undefined;
    });
    this.running = running;
    return running;
  }

  private loop(): void {
    if (this.stopped) return;
    void this.kick().then(() => {
      if (this.stopped) return;
      this.cancelTimer = this.timers.after(() => {
        this.cancelTimer = undefined;
        this.loop();
      }, CC_SEND_RETRY_MS);
    });
  }

  /** 待ちの上限を過ぎた queued を gave_up にし、その id を返す。mark なら印も付ける（起動時の recover は Discord につなぐ前なので付けない） */
  private expire(mark = true): number[] {
    const cutoff = new Date(this.deps.now().getTime() - this.deps.cfg.ccSendWaitMin * 60_000);
    const ids = this.deps.sends.giveUpOlderThan(cutoff);
    for (const id of ids) {
      this.deps.log(`Claude Code: 送信待ちを諦めました（#${id}）`);
      if (mark) this.settled(id);
    }
    return ids;
  }

  private async pass(): Promise<void> {
    try {
      this.expire();
      const snapshot = this.deps.registry.snapshot();
      // 一覧をまだ読めていない・直近の読み取りに失敗している間は試さない（古い pid で送り先を取り違えない・送り先が無いと取り違えない）
      if (snapshot.fetchedAt === undefined || snapshot.unreadable || snapshot.stale) return;
      // この pass で貼ったセッション（貼った直後の画面がまだ idle に見えても、同じセッションの次の queued は続けて貼らない。§3.3）
      const pasted = new Set<string>();
      for (const row of this.deps.sends.listQueued()) {
        if (this.stopped) return;
        if (row.sessionId !== null && pasted.has(row.sessionId)) continue;
        await this.attempt(row.id);
        const after = this.deps.sends.get(row.id);
        if (after !== undefined && after.sessionId !== null && (after.state === "delivered" || after.state === "unconfirmed")) pasted.add(after.sessionId);
      }
    } catch (error) {
      this.deps.log(`Claude Code: 送信の待ち行列を回せませんでした（${errorKind(error)}）`);
    }
  }

  /** 送れない（やり直さない）にして log */
  private fail(id: number, reason: string): void {
    if (this.deps.sends.transition(id, ["queued"], "failed", { lastPaneState: reason })) {
      this.deps.log(`Claude Code: 送れませんでした（#${id}、${reason}）`);
      this.settled(id);
    }
  }

  private async attempt(id: number): Promise<void> {
    const { registry, panes, sends, tmux, now } = this.deps;
    const row = sends.get(id);
    if (row === undefined || row.state !== "queued") return;
    if (row.sessionId === null && row.paneId === null) {
      this.fail(id, "gone");
      return;
    }
    const snapshot = registry.snapshot();
    if (snapshot.unreadable || snapshot.stale) return;
    let view = row.sessionId === null ? undefined : snapshot.sessions.find((session) => session.sessionId === row.sessionId);
    if (row.sessionId !== null && view === undefined) {
      this.fail(id, "gone");
      return;
    }
    // 送るたびに送り先を引き直す（§7 の 2）
    const lookup = await panes.lookup(sessionPids(snapshot.sessions));
    if (!lookup.ok) {
      sends.noteAttempt(id, lookup.reason);
      return;
    }
    if (view === undefined) {
      // ペイン宛て（起動の最初の指示。§4.2）: そのペインを送り先にし、cwd が起動したディレクトリの一覧のセッションが現れたら結びつける。
      // 送る経路はセッション宛てと同じ
      const paneId = row.paneId!;
      const bound = sessionOnStartedPane(lookup, snapshot.sessions, paneId, row.startDir);
      view = bound.found;
      if (view === undefined) {
        const pane = lookup.pane(paneId);
        const late = now().getTime() - Date.parse(row.createdAt) >= CC_START_BIND_GRACE_MS;
        if (pane === undefined || pane.dead) this.fail(id, "gone");
        else if (late && pane.currentCommand !== "claude") this.fail(id, "not_claude");
        else if (late && !bound.found && bound.reason === "mismatch") this.fail(id, "cwd_mismatch");
        else sends.noteAttempt(id, "starting");
        return;
      }
      sends.bindSession(id, view.sessionId);
    }
    const target = lookup.sendable({ pid: view.pid, tmux: view.tmux });
    if (!target.ok) {
      this.fail(id, target.reason);
      return;
    }
    const probe = await probePaneState({ tmux, paneId: target.pane.paneId, now: () => now().getTime(), sleep: this.sleep });
    if (!probe.ok) {
      sends.noteAttempt(id, probe.reason);
      return;
    }
    if (probe.state === "gone" || probe.state === "not_claude") {
      this.fail(id, probe.state);
      return;
    }
    if (probe.state !== "idle") {
      sends.noteAttempt(id, probe.state);
      if (probe.state === "dialog" && this.deps.channels !== undefined) {
        try {
          this.deps.channels.dialog(row);
        } catch (error) {
          this.deps.log(`Claude Code: ダイアログで待っていることを知らせられませんでした（#${id}、${errorKind(error)}）`);
        }
      }
      return;
    }
    await this.deliver(row, target.pane.paneId);
  }

  /**
   * delivering から終わりの状態に移して log。unconfirmed でも、貼り始めた後に本文が同じ UserPromptSubmit を受けていれば delivered（prompt_submit）にする
   */
  private finish(id: number, state: "delivered" | "unconfirmed" | "failed", reason: string): void {
    const since = this.deliveringSince.get(id);
    this.deliveringSince.delete(id);
    if (state === "unconfirmed" && since !== undefined) {
      const row = this.deps.sends.get(id);
      if (row !== undefined && this.promptSeen(row, since)) {
        state = "delivered";
        reason = "prompt_submit";
      }
    }
    if (!this.deps.sends.transition(id, ["delivering"], state, { lastPaneState: reason })) return;
    if (state === "failed") this.deps.log(`Claude Code: 送れませんでした（#${id}、${reason}）`);
    else this.deps.log(`Claude Code: 送りました（#${id}、${state}）`);
    this.settled(id);
    this.finished(id);
  }

  /** 終わった送信を onFinished に渡す（投げても止めない） */
  private finished(id: number): void {
    const { onFinished } = this.deps;
    if (onFinished === undefined) return;
    try {
      const row = this.deps.sends.get(id);
      if (row !== undefined) onFinished(row);
    } catch (error) {
      this.deps.log(`Claude Code: 送信の後の処理に失敗しました（#${id}、${errorKind(error)}）`);
    }
  }

  /** 貼る前に止まった（何も貼っていない）ので queued に戻す */
  private requeue(id: number, reason: string): void {
    this.deliveringSince.delete(id);
    this.deps.sends.transition(id, ["delivering"], "queued", { lastPaneState: reason });
  }

  /** idle を確かめたペインに貼って Enter を押す（§3.2）。取り消されていれば何もしない */
  private async deliver(row: CcSendRow, paneId: string): Promise<void> {
    const { sends, sessions, tmux } = this.deps;
    const startedAt = this.deps.now().getTime();
    if (!sends.transition(row.id, ["queued"], "delivering", { paneId })) return;
    this.deliveringSince.set(row.id, startedAt);
    try {
      const multiline = sessions.multilineOk();
      const text = multiline ? row.text : singleLine(row.text);
      const before = await tmux.capturePane(paneId);
      if (!before.ok) {
        this.requeue(row.id, "capture_failed");
        return;
      }
      // 確かめてから撮るまでの間にオーナーが打ち始めたなど
      const beforeState = classifyScreen(before.value);
      if (beforeState !== "idle") {
        this.requeue(row.id, beforeState);
        return;
      }
      let loaded;
      try {
        loaded = await tmux.loadBuffer(row.id, text, { multiline, maxChars: CC_SEND_MAX_CHARS });
      } catch {
        // 本文の形で断られた（何も貼っていない）。やり直しても同じなので送れない
        this.finish(row.id, "failed", "invalid_text");
        return;
      }
      if (!loaded.ok) {
        await tmux.deleteBuffer(row.id);
        this.requeue(row.id, "load_failed");
        return;
      }
      const pasted = await tmux.pasteBuffer(row.id, paneId);
      if (!pasted.ok) {
        // 途中まで貼れたかもしれないので、やり直さない
        this.finish(row.id, "unconfirmed", "paste_failed");
        return;
      }
      await this.sleep(CC_PASTE_CHECK_DELAY_MS);
      const after = await tmux.capturePane(paneId);
      if (!after.ok) {
        this.finish(row.id, "unconfirmed", "paste_unconfirmed");
        return;
      }
      if (!pasteLanded(before.value, after.value, text)) {
        if (multiline && pasteSubmittedEarly(before.value, after.value, text)) {
          this.finish(row.id, "unconfirmed", "submitted_early");
          this.earlySubmitted();
        } else {
          this.finish(row.id, "unconfirmed", "paste_unconfirmed");
        }
        return;
      }
      // 複数行がそのまま貼れたら、続けて数えた分を戻す
      if (multiline && text.includes("\n")) this.earlySubmits = 0;
      const entered = await tmux.sendEnter(paneId);
      if (!entered.ok) {
        this.finish(row.id, "unconfirmed", "enter_failed");
        return;
      }
      await this.sleep(CC_ENTER_CHECK_DELAY_MS);
      const check = await tmux.capturePane(paneId);
      const state = check.ok ? classifyScreen(check.value) : undefined;
      // 入力欄が空（idle）か作業中なら届いた。Enter の直後に出たダイアログ（許可・案内）は、貼った文字が入力欄から消えていれば届いた。
      // 貼った文字が残っていれば（draft など）確かめられない
      if (state === "busy" || state === "idle") this.finish(row.id, "delivered", state);
      else if (state === "dialog" && check.ok && pasteCleared(check.value, text)) this.finish(row.id, "delivered", "dialog");
      else this.finish(row.id, "unconfirmed", "enter_unconfirmed");
    } catch (error) {
      this.deps.log(`Claude Code: 送信の途中で失敗しました（#${row.id}、${errorKind(error)}）`);
      this.finish(row.id, "unconfirmed", "error");
    }
  }

  /** 複数行が 1 行目で送信されたように見えた。別の送信で CC_MULTILINE_DETECT_LIMIT 回続いたら複数行を止める */
  private earlySubmitted(): void {
    this.earlySubmits++;
    if (this.earlySubmits < CC_MULTILINE_DETECT_LIMIT) {
      this.deps.log(`Claude Code: 複数行の貼り付けが 1 行目で送信されたように見えました（${this.earlySubmits}/${CC_MULTILINE_DETECT_LIMIT}）`);
      return;
    }
    this.earlySubmits = 0;
    this.multilineOff();
  }

  /** 複数行を止め（cc_state.multiline_ok = false）、変わったときだけ log と /setup 済みのサーバーの #system に 1 行 */
  private multilineOff(): void {
    const { sessions, notify, cfg, log } = this.deps;
    if (!sessions.setMultilineOk(false)) return;
    log("Claude Code: 複数行の貼り付けが効いていないため、以後は改行を空白に置き換えて送ります");
    if (notify === undefined) return;
    for (const guildId of cfg.allowedGuildIds) {
      void notify(guildId, { text: CC_MULTILINE_OFF_NOTICE }, { level: "warning" }).catch((error: unknown) => {
        log(`Claude Code: #system への知らせに失敗しました（guild=${guildId}、${errorKind(error)}）`);
      });
    }
  }
}
