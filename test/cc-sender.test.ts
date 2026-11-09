import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { CcPaneResolver } from "../src/cc/panes.ts";
import type { CcSessionView, CcSnapshot } from "../src/cc/registry.ts";
import {
  CC_ENTER_CHECK_DELAY_MS,
  CC_MULTILINE_OFF_NOTICE,
  CC_PASTE_CHECK_DELAY_MS,
  CC_SEND_MAX_CHARS,
  CcSender,
  normalizeSendText,
} from "../src/cc/sender.ts";
import { CcSendStore, type CcSendRow } from "../src/store/cc-sends.ts";
import { CcSessionStore } from "../src/store/cc-sessions.ts";
import { createTmux, type RunCommand } from "../src/tmux/tmux.ts";
import { tempDb } from "./helpers/db.ts";

const BASE = Date.parse("2026-11-01T00:00:00.000Z");
const S1 = "11111111-1111-4111-8111-111111111111";
const S2 = "22222222-2222-4222-8222-222222222222";
const TMUX = "/usr/bin/tmux";

// 画面（pane-state.test.ts の fixture と同じ形。文字は置き換えたもの）
const RULE = "─".repeat(80);
const PROMPT = "❯\u00a0";
const HISTORY = ["● 返答の本文（置き換え）", ""];
const FOOTER = ["  ⏵⏵ auto mode on (shift+tab to cycle)"];
const BUSY_FOOTER = ["  ⏵⏵ auto mode on (shift+tab to cycle) · esc to interrupt"];
function screen(input: string[], options: { above?: string[]; footer?: string[] } = {}): string {
  return [...(options.above ?? HISTORY), RULE, ...input, RULE, ...(options.footer ?? FOOTER), "", ""].join("\n");
}
const EMPTY = screen([PROMPT]);
const BUSY = screen([PROMPT], { footer: BUSY_FOOTER });

/** list-panes の 1 行（PANE_FORMAT の順） */
function paneLine(paneId: string, panePid: number, command = "claude"): string {
  return ["work", "0", paneId.slice(1), paneId, "1", "1", "/w/a", command, "0", "0", String(panePid)].join("\t");
}

function view(sessionId: string, pid: number): CcSessionView {
  return {
    sessionId,
    status: "idle",
    pendingPermission: false,
    waitingKind: null,
    waitingSince: undefined,
    lastPromptAt: undefined,
    lastEventAt: undefined,
    transcriptMtime: undefined,
    startedAt: BASE,
    state: "idle",
    pid,
    name: "a",
    cwd: "/w/a",
    kind: "interactive",
    waitingFor: undefined,
    lastPromptText: null,
    permissionMode: null,
    lastActivityAt: undefined,
    bridgeSessionId: undefined,
    tmux: undefined,
    permission: undefined,
    startedBy: "owner",
    trustPending: false,
  };
}

type Phase = "before" | "pasted" | "entered";

/**
 * 本物の CcSender・CcPaneResolver・createTmux（偽の execFile）・一時 SQLite。claude（S1 の pid 500）の親 400 が %1 の pane_pid。
 * capture-pane は phase（貼る前・貼った後・Enter の後）ごとに screens の画面を返す
 */
function setup(t: TestContext) {
  const db = tempDb(t);
  const clock = { now: BASE };
  const now = (): Date => new Date(clock.now);
  const sends = new CcSendStore(db, now);
  const sessions = new CcSessionStore(db, now);
  const env = {
    panes: [paneLine("%1", 400), paneLine("%2", 410)].join("\n"),
    noServer: false,
    phase: "before" as Phase,
    screens: { before: EMPTY, pasted: EMPTY, entered: BUSY } as Record<Phase, string>,
  };
  const commands: string[][] = [];
  const inputs: string[] = [];
  const run: RunCommand = async (_file, args, options) => {
    commands.push([...args]);
    if (env.noServer) return { code: 1, stdout: "", stderr: "no server running on /tmp/tmux-1000/default\n" };
    switch (args[0]) {
      case "list-panes":
        return { code: 0, stdout: env.panes, stderr: "" };
      case "capture-pane":
        return { code: 0, stdout: env.screens[env.phase], stderr: "" };
      case "load-buffer":
        inputs.push(options.input ?? "");
        return { code: 0, stdout: "", stderr: "" };
      case "paste-buffer":
        env.phase = "pasted";
        return { code: 0, stdout: "", stderr: "" };
      case "send-keys":
        env.phase = "entered";
        return { code: 0, stdout: "", stderr: "" };
      default:
        return { code: 0, stdout: "", stderr: "" };
    }
  };
  const tmux = createTmux({ tmuxPath: TMUX, run });
  const parents: Record<number, number> = { 500: 400, 600: 410, 400: 1, 410: 1 };
  const panes = new CcPaneResolver({ tmux, parentOf: (pid) => parents[pid] });
  const snapshot: CcSnapshot = { sessions: [view(S1, 500), view(S2, 600)], stale: false, unreadable: false, fetchedAt: BASE };
  const registry = { snapshot: () => snapshot };
  const notices: Array<{ guildId: string; text: string; level: string }> = [];
  const logs: string[] = [];
  const sleeps: number[] = [];
  /** 貼っている途中から終わった送信（onFinished。CC8） */
  const finished: CcSendRow[] = [];
  /** 印の付け替え（channels.settled）に渡った送信の id と状態 */
  const settled: Array<[number, string]> = [];
  /** sleep の中で呼ぶもの（Enter の後の確かめの待ちの間に hook の事象を入れる） */
  const hooks: { onSleep?: (ms: number) => void } = {};
  const sender = new CcSender({
    cfg: { ccSendWaitMin: 120, allowedGuildIds: ["g1", "g2"] },
    registry,
    panes,
    tmux,
    sends,
    sessions,
    notify: async (guildId, message, options) => {
      notices.push({ guildId, text: message.text, level: options.level });
      return "m1";
    },
    now,
    sleep: async (ms) => {
      sleeps.push(ms);
      hooks.onSleep?.(ms);
    },
    timers: { after: () => () => undefined },
    onFinished: (row) => void finished.push(row),
    channels: {
      announce: async () => undefined,
      settled: (row) => void settled.push([row.id, row.state]),
      dialog: () => undefined,
    },
    log: (message) => logs.push(message),
  });
  /** 送り込みの操作（load・paste・Enter）だけ */
  const actions = () => commands.filter((args) => ["load-buffer", "paste-buffer", "send-keys"].includes(args[0]!)).map((args) => args[0]);
  return { db, clock, sends, sessions, env, commands, inputs, snapshot, sender, notices, logs, sleeps, actions, finished, settled, hooks };
}

/** 貼った文字が入力欄に見える画面 */
function shown(text: string): string {
  const [first, ...rest] = text.split("\n");
  return screen([`${PROMPT}${first}`, ...rest.map((line) => `  ${line}`)]);
}

test("normalizeSendText: 末尾の改行を落とし、LF 以外の制御文字（CR・ESC・TAB）は断り、4,001 字は too_long", () => {
  assert.deepEqual(normalizeSendText("1 行目\n2 行目\n\n"), { ok: true, text: "1 行目\n2 行目" });
  assert.deepEqual(normalizeSendText("  前の空白は残す"), { ok: true, text: "  前の空白は残す" });
  for (const raw of [undefined, 1, "", "\n\n", "   "]) assert.deepEqual(normalizeSendText(raw), { ok: false, reason: "empty" });
  for (const raw of ["a\rb", "a\r\nb", "a\x1b[2Jb", "a\tb", "a\x7fb", "a\u009bb"]) {
    assert.deepEqual(normalizeSendText(raw), { ok: false, reason: "invalid_text" });
  }
  assert.deepEqual(normalizeSendText("字".repeat(CC_SEND_MAX_CHARS + 1)), { ok: false, reason: "too_long" });
  assert.equal(normalizeSendText("字".repeat(CC_SEND_MAX_CHARS)).ok, true);
});

test("idle なら load → paste → 確かめ → Enter の順に 1 回だけ。LF 入りの本文は 1 回の paste で貼る", async (t) => {
  const { env, sender, sends, inputs, actions, sleeps, commands, logs } = setup(t);
  const text = "1 行目の指示はこれです。\n2 行目\n\n4 行目";
  env.screens.pasted = screen([`${PROMPT}[Pasted text #1 +3 lines]`]);
  const result = await sender.submit({ sessionId: S1, text, origin: "web" });
  assert.ok(result.ok && !result.duplicate);
  assert.equal(result.send.state, "queued");
  await sender.idle();
  const row = sends.get(result.send.id)!;
  assert.deepEqual([row.state, row.paneId, row.deliveredAt !== null], ["delivered", "%1", true]);
  assert.deepEqual(actions(), ["load-buffer", "paste-buffer", "send-keys"]);
  assert.deepEqual(inputs, [text]);
  // ブラケット貼り付け（-p）で名前付きのバッファから、Enter は %1 に
  assert.ok(commands.some((args) => args.join(" ") === `paste-buffer -p -d -b self-agent-${row.id} -t %1`));
  assert.ok(commands.some((args) => args.join(" ") === "send-keys -t %1 Enter"));
  // idle を 2 回確かめ（1.5 秒）、貼ってから 0.5 秒、Enter から 2 秒
  assert.deepEqual(sleeps, [1500, CC_PASTE_CHECK_DELAY_MS, CC_ENTER_CHECK_DELAY_MS]);
  assert.deepEqual(logs, [`Claude Code: 送りました（#${row.id}、queued）`, `Claude Code: 送りました（#${row.id}、delivered）`]);
  // 本文・ペイン id・sessionId は log に出さない
  assert.ok(logs.every((line) => !line.includes("1 行目") && !line.includes("%1") && !line.includes(S1)));
});

test("idle でなければ積んだまま（30 秒ごとに試す）で、入力待ちになったら届ける", async (t) => {
  const { env, sender, sends, actions } = setup(t);
  env.screens.before = BUSY;
  const result = await sender.submit({ sessionId: S1, text: "作業が終わったら", origin: "web" });
  assert.ok(result.ok);
  await sender.idle();
  let row = sends.get(result.send.id)!;
  assert.deepEqual([row.state, row.attempts, row.lastPaneState], ["queued", 1, "busy"]);
  assert.deepEqual(actions(), []);
  // 書きかけ（オーナーが打っている）も積む
  env.screens.before = screen([`${PROMPT}書きかけ`]);
  await sender.kick();
  row = sends.get(result.send.id)!;
  assert.deepEqual([row.state, row.attempts, row.lastPaneState], ["queued", 2, "draft"]);
  env.screens.before = EMPTY;
  env.screens.pasted = shown("作業が終わったら");
  await sender.kick();
  assert.equal(sends.get(result.send.id)?.state, "delivered");
  assert.deepEqual(actions(), ["load-buffer", "paste-buffer", "send-keys"]);
});

test("onEvent: Stop を受けたら待ち行列を 1 回回し、作業中に積んだ送信を周期を待たずに届ける。Stop 以外では回さない", async (t) => {
  const { env, sender, sends, actions } = setup(t);
  env.screens.before = BUSY;
  const result = await sender.submit({ sessionId: S1, text: "作業が終わったら", origin: "web" });
  assert.ok(result.ok);
  await sender.idle();
  assert.equal(sends.get(result.send.id)?.state, "queued");
  env.screens.before = EMPTY;
  env.screens.pasted = shown("作業が終わったら");
  for (const event of ["UserPromptSubmit", "Notification", "PermissionRequest"] as const) {
    sender.onEvent({ event });
    await sender.idle();
    assert.equal(sends.get(result.send.id)?.state, "queued", event);
  }
  assert.deepEqual(actions(), []);
  sender.onEvent({ event: "Stop" });
  await sender.idle();
  assert.equal(sends.get(result.send.id)?.state, "delivered");
  assert.deepEqual(actions(), ["load-buffer", "paste-buffer", "send-keys"]);
});

test("貼れたか確かめられなければ Enter を送らず unconfirmed にし、やり直さない", async (t) => {
  const { env, sender, sends, actions, logs } = setup(t);
  // 貼った後も入力欄が空のまま
  env.screens.pasted = EMPTY;
  const result = await sender.submit({ sessionId: S1, text: "1 行目\n2 行目\n3 行目\n4 行目", origin: "web" });
  assert.ok(result.ok);
  await sender.idle();
  assert.deepEqual([sends.get(result.send.id)?.state, sends.get(result.send.id)?.lastPaneState], ["unconfirmed", "paste_unconfirmed"]);
  assert.deepEqual(actions(), ["load-buffer", "paste-buffer"]);
  // +1 lines の印（別の短い貼り付け）は 4 行の貼り付けの証拠にしない
  const second = await sender.submit({ sessionId: S2, text: "1 行目\n2 行目\n3 行目\n4 行目", origin: "web" });
  assert.ok(second.ok);
  env.phase = "before";
  env.screens.pasted = screen([`${PROMPT}[Pasted text #1 +1 lines]`]);
  await sender.idle();
  assert.equal(sends.get(second.send.id)?.state, "unconfirmed");
  assert.equal(actions().filter((action) => action === "send-keys").length, 0);
  await sender.kick();
  assert.equal(actions().length, 4);
  assert.ok(logs.includes(`Claude Code: 送りました（#${result.send.id}、unconfirmed）`));
});

test("Enter の後に入力欄に残っていれば unconfirmed（送信を確かめられない）", async (t) => {
  const { env, sender, sends } = setup(t);
  env.screens.pasted = shown("残る本文");
  env.screens.entered = shown("残る本文");
  const result = await sender.submit({ sessionId: S1, text: "残る本文", origin: "web" });
  assert.ok(result.ok);
  await sender.idle();
  assert.deepEqual([sends.get(result.send.id)?.state, sends.get(result.send.id)?.lastPaneState], ["unconfirmed", "enter_unconfirmed"]);
});

test("tmux の外・tmux のサーバーが無いなら積まず、絶対に送らない", async (t) => {
  const { env, sender, sends, actions, snapshot } = setup(t);
  env.panes = [paneLine("%1", 400, "bash"), paneLine("%2", 410)].join("\n");
  snapshot.sessions.push(view("33333333-3333-4333-8333-333333333333", 900));
  assert.deepEqual(await sender.submit({ sessionId: "33333333-3333-4333-8333-333333333333", text: "x", origin: "web" }), {
    ok: false,
    reason: "not_in_tmux",
  });
  assert.deepEqual(await sender.submit({ sessionId: "44444444-4444-4444-8444-444444444444", text: "x", origin: "web" }), {
    ok: false,
    reason: "not_found",
  });
  env.noServer = true;
  assert.deepEqual(await sender.submit({ sessionId: S2, text: "x", origin: "web" }), { ok: false, reason: "no_server" });
  assert.equal(sends.countActive(), 0);
  assert.deepEqual(actions(), []);
});

test("前面が claude でないペイン（コマンド実行中）には積んで待ち、前面が claude に戻って入力待ちになったら貼る（#284）", async (t) => {
  const { env, sender, sends, actions } = setup(t);
  env.panes = [paneLine("%1", 400, "bash"), paneLine("%2", 410)].join("\n");
  const result = await sender.submit({ sessionId: S1, text: "後で", origin: "web" });
  assert.ok(result.ok);
  await sender.idle();
  assert.deepEqual([sends.get(result.send.id)?.state, sends.get(result.send.id)?.lastPaneState], ["queued", "not_claude"]);
  assert.deepEqual(actions(), []);
  env.panes = [paneLine("%1", 400), paneLine("%2", 410)].join("\n");
  env.screens.pasted = shown("後で");
  await sender.kick();
  await sender.idle();
  assert.equal(sends.get(result.send.id)?.state, "delivered");
  assert.ok(actions().length > 0);
});

test("積んだ後に送り先が一覧から消えたら failed にして送らない（前面が claude でないだけなら待つ）", async (t) => {
  const { env, sender, sends, actions, snapshot } = setup(t);
  env.screens.before = BUSY;
  const first = await sender.submit({ sessionId: S1, text: "a", origin: "web" });
  const second = await sender.submit({ sessionId: S2, text: "b", origin: "web" });
  assert.ok(first.ok && second.ok);
  await sender.idle();
  env.screens.before = EMPTY;
  env.panes = [paneLine("%1", 400, "bash"), paneLine("%2", 410)].join("\n");
  snapshot.sessions.splice(1, 1);
  await sender.kick();
  assert.deepEqual([sends.get(first.send.id)?.state, sends.get(first.send.id)?.lastPaneState], ["queued", "not_claude"]);
  assert.deepEqual([sends.get(second.send.id)?.state, sends.get(second.send.id)?.lastPaneState], ["failed", "gone"]);
  assert.deepEqual(actions(), []);
});

test("一覧をまだ読めていない・読めない間は試さない（送り先が無いと取り違えない）", async (t) => {
  const { env, sender, sends, snapshot } = setup(t);
  env.screens.before = BUSY;
  const result = await sender.submit({ sessionId: S1, text: "a", origin: "web" });
  assert.ok(result.ok);
  await sender.idle();
  snapshot.sessions.length = 0;
  snapshot.unreadable = true;
  await sender.kick();
  snapshot.unreadable = false;
  snapshot.fetchedAt = undefined;
  await sender.kick();
  assert.equal(sends.get(result.send.id)?.state, "queued");
});

test("1 セッション 1 件（already_queued）。同じ本文は 5 秒以内なら前の送信を返す", async (t) => {
  const { env, clock, sender } = setup(t);
  env.screens.before = BUSY;
  const first = await sender.submit({ sessionId: S1, text: "同じ本文", origin: "web" });
  assert.ok(first.ok);
  const again = await sender.submit({ sessionId: S1, text: "同じ本文", origin: "web" });
  assert.ok(again.ok && again.duplicate);
  assert.equal(again.send.id, first.send.id);
  assert.deepEqual(await sender.submit({ sessionId: S1, text: "別の本文", origin: "web" }), { ok: false, reason: "already_queued" });
  clock.now = BASE + 5_001;
  assert.deepEqual(await sender.submit({ sessionId: S1, text: "同じ本文", origin: "web" }), { ok: false, reason: "already_queued" });
  // 別のセッションには積める
  const other = await sender.submit({ sessionId: S2, text: "同じ本文", origin: "web" });
  assert.ok(other.ok && !other.duplicate);
  await sender.idle();
});

test("同時に来た同じ要求は 1 件だけ積む", async (t) => {
  const { env, sender, sends } = setup(t);
  env.screens.before = BUSY;
  const results = await Promise.all([
    sender.submit({ sessionId: S1, text: "x", origin: "web" }),
    sender.submit({ sessionId: S1, text: "x", origin: "web" }),
  ]);
  assert.ok(results.every((result) => result.ok));
  assert.equal(sends.countActive(), 1);
  await sender.idle();
});

test("取り消し: queued は cancelled、2 回目・届けたもの・無い id は断る", async (t) => {
  const { env, sender, sends } = setup(t);
  env.screens.before = BUSY;
  const result = await sender.submit({ sessionId: S1, text: "a", origin: "web" });
  assert.ok(result.ok);
  await sender.idle();
  assert.equal(sender.cancel(result.send.id), "cancelled");
  assert.equal(sends.get(result.send.id)?.state, "cancelled");
  assert.equal(sender.cancel(result.send.id), "stale");
  assert.equal(sender.cancel(999), "not_found");
  // 取り消したものは試さない
  env.screens.before = EMPTY;
  await sender.kick();
  assert.equal(sends.get(result.send.id)?.state, "cancelled");
});

test("再起動: delivering のまま残った行は unconfirmed（やり直さない）。queued は続ける", async (t) => {
  const { sender, sends } = setup(t);
  const delivering = sends.add({ sessionId: S1, text: "a", origin: "web", state: "queued" });
  sends.transition(delivering.id, ["queued"], "delivering");
  const queued = sends.add({ sessionId: S2, text: "b", origin: "web", state: "queued" });
  sender.recover();
  assert.equal(sends.get(delivering.id)?.state, "unconfirmed");
  assert.equal(sends.get(queued.id)?.state, "queued");
});

test("SELF_AGENT_CC_SEND_WAIT_MIN（120 分）を過ぎた queued は gave_up", async (t) => {
  const { env, clock, sender, sends, logs } = setup(t);
  env.screens.before = BUSY;
  const result = await sender.submit({ sessionId: S1, text: "a", origin: "web" });
  assert.ok(result.ok);
  await sender.idle();
  clock.now = BASE + 120 * 60_000;
  await sender.kick();
  assert.equal(sends.get(result.send.id)?.state, "queued");
  clock.now = BASE + 120 * 60_000 + 1;
  await sender.kick();
  assert.equal(sends.get(result.send.id)?.state, "gave_up");
  assert.ok(logs.includes(`Claude Code: 送信待ちを諦めました（#${result.send.id}）`));
  // 起動時（recover）も同じ
  const old = sends.add({ sessionId: S2, text: "b", origin: "web", state: "queued" });
  clock.now += 121 * 60_000;
  sender.recover();
  assert.equal(sends.get(old.id)?.state, "gave_up");
});

test("1 行目で送信されたように見えるのが別の送信で 2 回続いたら multiline_ok = false・#system に 1 行。以後は改行を空白に置き換えて送る", async (t) => {
  const { env, sender, sends, sessions, notices, inputs, actions, logs } = setup(t);
  const text = "最初の行はここにあります\n2 行目は後ろに\n3 行目";
  const submitted = screen([`${PROMPT}2 行目は後ろに 3 行目`], {
    above: [...HISTORY, "❯ 最初の行はここにあります", "✶ Working… (1s)", ""],
    footer: BUSY_FOOTER,
  });
  env.screens.pasted = submitted;
  const first = await sender.submit({ sessionId: S1, text, origin: "web" });
  assert.ok(first.ok);
  await sender.idle();
  assert.deepEqual([sends.get(first.send.id)?.state, sends.get(first.send.id)?.lastPaneState], ["unconfirmed", "submitted_early"]);
  assert.deepEqual(actions(), ["load-buffer", "paste-buffer"]);
  // 1 回目では止めない
  assert.equal(sessions.multilineOk(), true);
  assert.deepEqual(notices, []);
  assert.ok(logs.includes("Claude Code: 複数行の貼り付けが 1 行目で送信されたように見えました（1/2）"));

  env.phase = "before";
  const second = await sender.submit({ sessionId: S2, text, origin: "web" });
  assert.ok(second.ok);
  await sender.idle();
  assert.equal(sends.get(second.send.id)?.lastPaneState, "submitted_early");
  assert.equal(sessions.multilineOk(), false);
  assert.deepEqual(notices, [
    { guildId: "g1", text: CC_MULTILINE_OFF_NOTICE, level: "warning" },
    { guildId: "g2", text: CC_MULTILINE_OFF_NOTICE, level: "warning" },
  ]);

  env.phase = "before";
  env.screens.pasted = shown("1 行目 2 行目");
  const third = await sender.submit({ sessionId: S1, text: "1 行目\n2 行目", origin: "web" });
  assert.ok(third.ok);
  await sender.idle();
  assert.equal(sends.get(third.send.id)?.state, "delivered");
  assert.deepEqual(inputs, [text, text, "1 行目 2 行目"]);
  assert.equal(notices.length, 2);
});

test("1 行目で送信されたように見えた後でも、複数行がそのまま貼れたら数え直す（続けて 2 回でなければ止めない）", async (t) => {
  const { env, sender, sessions } = setup(t);
  const text = "最初の行はここにあります\n2 行目は後ろに\n3 行目";
  const submitted = screen([`${PROMPT}2 行目は後ろに 3 行目`], {
    above: [...HISTORY, "❯ 最初の行はここにあります", "✶ Working… (1s)", ""],
    footer: BUSY_FOOTER,
  });
  const run = async (sessionId: string, pasted: string) => {
    env.phase = "before";
    env.screens.pasted = pasted;
    const result = await sender.submit({ sessionId, text, origin: "web" });
    assert.ok(result.ok);
    await sender.idle();
  };
  await run(S1, submitted);
  await run(S2, screen([`${PROMPT}[Pasted text #1 +2 lines]`]));
  await run(S1, submitted);
  assert.equal(sessions.multilineOk(), true);
});

test("一覧の直近の読み取りに失敗している（stale）間は試さない", async (t) => {
  const { env, sender, sends, snapshot, actions } = setup(t);
  env.screens.before = BUSY;
  const result = await sender.submit({ sessionId: S1, text: "a", origin: "web" });
  assert.ok(result.ok);
  await sender.idle();
  env.screens.before = EMPTY;
  snapshot.stale = true;
  await sender.kick();
  assert.deepEqual([sends.get(result.send.id)?.state, sends.get(result.send.id)?.attempts], ["queued", 1]);
  assert.deepEqual(actions(), []);
  snapshot.stale = false;
  env.screens.pasted = shown("a");
  await sender.kick();
  assert.equal(sends.get(result.send.id)?.state, "delivered");
});

test("loadBuffer が本文の形で断った（何も貼っていない）ら failed", async (t) => {
  const { sender, sends, actions } = setup(t);
  // 検証を通らない本文の行（DB の手直しなど）
  const row = sends.add({ sessionId: S1, text: "a\tb", origin: "web", state: "queued" });
  await sender.kick();
  assert.deepEqual([sends.get(row.id)?.state, sends.get(row.id)?.lastPaneState], ["failed", "invalid_text"]);
  assert.deepEqual(actions(), []);
});

test("取り消した後に同じ本文を送ると、5 秒以内でも新しい送信になる", async (t) => {
  const { env, sender } = setup(t);
  env.screens.before = BUSY;
  const first = await sender.submit({ sessionId: S1, text: "同じ本文", origin: "web" });
  assert.ok(first.ok);
  await sender.idle();
  assert.equal(sender.cancel(first.send.id), "cancelled");
  const again = await sender.submit({ sessionId: S1, text: "同じ本文", origin: "web" });
  assert.ok(again.ok && !again.duplicate);
  assert.notEqual(again.send.id, first.send.id);
  await sender.idle();
});

test("stop の後は受け付けず、試さない", async (t) => {
  const { sender, sends } = setup(t);
  sender.stop();
  assert.deepEqual(await sender.submit({ sessionId: S1, text: "a", origin: "web" }), { ok: false, reason: "stopped" });
  const row = sends.add({ sessionId: S1, text: "a", origin: "web", state: "queued" });
  await sender.kick();
  assert.equal(sends.get(row.id)?.state, "queued");
});

// 許可のダイアログ（入力欄の代わりに出る）
const PERMISSION_DIALOG = [...HISTORY, RULE, " Bash command", "", "   date", "", " Do you want to proceed?", " ❯ 1. Yes", "   2. No", "", " Esc to cancel", "", ""].join("\n");

test("Enter の後にダイアログが出ても、貼った文字が入力欄から消えていれば delivered（dialog）。入力欄に残っていれば unconfirmed", async (t) => {
  const { env, sender, sends, finished } = setup(t);
  env.screens.pasted = shown("許可が要る指示");
  env.screens.entered = PERMISSION_DIALOG;
  const result = await sender.submit({ sessionId: S1, text: "許可が要る指示", origin: "web" });
  assert.ok(result.ok);
  await sender.idle();
  assert.deepEqual([sends.get(result.send.id)?.state, sends.get(result.send.id)?.lastPaneState], ["delivered", "dialog"]);
  assert.deepEqual([finished.at(-1)?.state, finished.at(-1)?.replyState], ["delivered", "waiting"]);
  // 入力欄が残っていて、その上にダイアログの印がある（貼った文字が残っている）
  env.phase = "before";
  env.screens.pasted = shown("残る指示");
  env.screens.entered = screen([`${PROMPT}残る指示`], { above: ["Do you want to proceed?", ""] });
  const second = await sender.submit({ sessionId: S2, text: "残る指示", origin: "web" });
  assert.ok(second.ok);
  await sender.idle();
  assert.deepEqual([sends.get(second.send.id)?.state, sends.get(second.send.id)?.lastPaneState], ["unconfirmed", "enter_unconfirmed"]);
});

test("unconfirmed の送信は、30 秒以内に本文が同じ UserPromptSubmit を受けたら delivered に直し、印を付け替えて onFinished に渡す", async (t) => {
  const { env, clock, sender, sends, finished, settled, logs } = setup(t);
  env.screens.pasted = shown("確かめられない 指示");
  env.screens.entered = shown("確かめられない 指示");
  const result = await sender.submit({ sessionId: S1, text: "確かめられない\n指示", origin: "web" });
  assert.ok(result.ok);
  await sender.idle();
  const id = result.send.id;
  assert.equal(sends.get(id)?.state, "unconfirmed");
  // 別のセッション・別の本文では直さない
  clock.now += 10_000;
  sender.onEvent({ event: "UserPromptSubmit", sessionId: S2, prompt: "確かめられない 指示", receivedAt: new Date(clock.now) });
  sender.onEvent({ event: "UserPromptSubmit", sessionId: S1, prompt: "ほかの指示", receivedAt: new Date(clock.now) });
  assert.equal(sends.get(id)?.state, "unconfirmed");
  // 空白・改行の違いは同じとみなす
  sender.onEvent({ event: "UserPromptSubmit", sessionId: S1, prompt: "  確かめられない   指示 ", receivedAt: new Date(clock.now) });
  await sender.idle();
  const row = sends.get(id)!;
  assert.deepEqual([row.state, row.lastPaneState, row.deliveredAt !== null, row.replyState], ["delivered", "prompt_submit", true, "waiting"]);
  assert.deepEqual(settled.slice(-2), [
    [id, "unconfirmed"],
    [id, "delivered"],
  ]);
  assert.deepEqual([finished.at(-1)?.id, finished.at(-1)?.state], [id, "delivered"]);
  assert.ok(logs.every((line) => !line.includes("確かめられない")));

  // 30 秒を過ぎてから来たものでは直さない
  env.phase = "before";
  env.screens.pasted = shown("遅い指示");
  env.screens.entered = shown("遅い指示");
  const late = await sender.submit({ sessionId: S2, text: "遅い指示", origin: "web" });
  assert.ok(late.ok);
  await sender.idle();
  clock.now += 30_001;
  sender.onEvent({ event: "UserPromptSubmit", sessionId: S2, prompt: "遅い指示", receivedAt: new Date(clock.now) });
  assert.equal(sends.get(late.send.id)?.state, "unconfirmed");
});

test("Enter の後の確かめを待っている間に本文が同じ UserPromptSubmit を受けていれば、確かめられなくても delivered（prompt_submit）", async (t) => {
  const { env, clock, sender, sends, hooks } = setup(t);
  env.screens.pasted = shown("先に届いた指示");
  env.screens.entered = shown("先に届いた指示");
  // 貼る前に受けた同じ本文（オーナーが前に打ったもの）は証拠にしない
  sender.onEvent({ event: "UserPromptSubmit", sessionId: S1, prompt: "先に届いた指示", receivedAt: new Date(clock.now - 1000) });
  const result = await sender.submit({ sessionId: S1, text: "先に届いた指示", origin: "web" });
  assert.ok(result.ok);
  await sender.idle();
  assert.equal(sends.get(result.send.id)?.state, "unconfirmed");

  hooks.onSleep = (ms) => {
    if (ms === CC_ENTER_CHECK_DELAY_MS) sender.onEvent({ event: "UserPromptSubmit", sessionId: S2, prompt: "待つ間に届いた指示", receivedAt: new Date(clock.now) });
  };
  env.phase = "before";
  env.screens.pasted = shown("待つ間に届いた指示");
  env.screens.entered = shown("待つ間に届いた指示");
  const second = await sender.submit({ sessionId: S2, text: "待つ間に届いた指示", origin: "web" });
  assert.ok(second.ok);
  await sender.idle();
  assert.deepEqual([sends.get(second.send.id)?.state, sends.get(second.send.id)?.lastPaneState], ["delivered", "prompt_submit"]);
});

test("onFinished: 届けたら delivered の行（返事の印は waiting）を渡す。貼れたか確かめられないものは unconfirmed で渡し、返事の印は waiting（最初の返事を発言への返信にする）", async (t) => {
  const { env, sender, finished } = setup(t);
  env.screens.pasted = shown("届ける本文");
  const result = await sender.submit({ sessionId: S1, text: "届ける本文", origin: "web" });
  assert.ok(result.ok);
  await sender.idle();
  assert.deepEqual(
    finished.map((row) => [row.id, row.state, row.replyState]),
    [[result.send.id, "delivered", "waiting"]],
  );

  env.phase = "before";
  env.screens.pasted = EMPTY;
  const second = await sender.submit({ sessionId: S2, text: "貼れない本文", origin: "web" });
  assert.ok(second.ok);
  await sender.idle();
  assert.deepEqual(finished.at(-1) && [finished.at(-1)!.id, finished.at(-1)!.state, finished.at(-1)!.replyState], [second.send.id, "unconfirmed", "waiting"]);
});
