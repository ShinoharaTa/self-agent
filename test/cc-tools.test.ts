import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import * as z from "zod";
import {
  CC_DISABLED_MESSAGE,
  CC_LIST_NOTICE,
  CC_NOT_AVAILABLE_MESSAGE,
  createCcToolHandlers,
  createTaskTools,
  type CcToolDeps,
  type TextToolResult,
} from "../src/agent/tools.ts";
import type { RunContext } from "../src/agent/runner.ts";
import { createCcTools, CC_LIST_MAX, CONFIRM_TOO_LONG_MESSAGE } from "../src/app/cc-tools.ts";
import {
  CC_CONFIRM_MAX_PAGES,
  CC_CONFIRM_PAGE_CHARS,
  CC_CONFIRM_TTL_MS,
  CC_DISABLED_NOTE,
  CcConfirmExpirer,
  ccSendPrompt,
  fitsConfirm,
  splitConfirmBody,
  type CcConfirmRuntime,
} from "../src/app/commands/cc-confirm.ts";
import { createCcComponent } from "../src/app/commands/cc.ts";
import { STALE_TEXT } from "../src/app/commands/delete.ts";
import { CcPaneResolver } from "../src/cc/panes.ts";
import type { CcSessionView, CcSnapshot } from "../src/cc/registry.ts";
import { CcSender } from "../src/cc/sender.ts";
import type { CcStartCheck, CcStartInput, CcStartResult as LaunchResult } from "../src/cc/starter.ts";
import type { Interaction, OutgoingMessage } from "../src/discord/gateway.ts";
import { CcSendStore } from "../src/store/cc-sends.ts";
import { CcSessionStore } from "../src/store/cc-sessions.ts";
import { CcStartStore } from "../src/store/cc-starts.ts";
import { MIGRATIONS, openDb } from "../src/store/db.ts";
import { createTmux, type RunCommand } from "../src/tmux/tmux.ts";
import { tempDb, tempDir } from "./helpers/db.ts";
import { FakeResponder, type ResponderCall } from "./helpers/responder.ts";

const BASE = Date.parse("2026-11-01T00:00:00.000Z");
const S1 = "11111111-1111-4111-8111-111111111111";
const S2 = "22222222-2222-4222-8222-222222222222";
const S3 = "33333333-3333-4333-8333-333333333333";
const CHANNEL = "topic-1";
const CONTEXT: RunContext = { guildId: "guild-1", channelId: CHANNEL, kind: "inbox" };
const SECRET_NAME = "secret-session-name";
const SECRET_TEXT = "本文の中身（ログに出さない）";

// 画面（cc-sender.test.ts と同じ形。文字は置き換えたもの）。作業中なので貼らずに積んだまま
const RULE = "─".repeat(80);
const BUSY = ["● 返答の本文（置き換え）", "", RULE, "❯ ", RULE, "  ⏵⏵ auto mode on (shift+tab to cycle) · esc to interrupt", "", ""].join("\n");

function view(sessionId: string, pid: number, overrides: Partial<CcSessionView> = {}): CcSessionView {
  return {
    sessionId,
    status: "idle",
    pendingPermission: false,
    waitingKind: null,
    waitingSince: undefined,
    lastPromptAt: undefined,
    transcriptMtime: undefined,
    startedAt: BASE,
    state: "idle",
    pid,
    name: SECRET_NAME,
    cwd: "/w/alpha",
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
    ...overrides,
  };
}

function paneLine(paneId: string, panePid: number, command = "claude"): string {
  return ["work", "0", paneId.slice(1), paneId, "1", "1", "/w/a", command, "0", "0", String(panePid)].join("\t");
}

function parse(result: TextToolResult): Record<string, unknown> {
  return JSON.parse(result.content[0].text) as Record<string, unknown>;
}

function press(customId: string): Extract<Interaction, { kind: "button" }> {
  return { kind: "button", customId, guildId: "guild-1", channelId: CHANNEL, userId: "owner-1", createdAt: new Date(BASE), messageId: "m-1" };
}

/** メッセージのボタンを label で押す custom_id */
function buttonId(message: OutgoingMessage, label: string): string {
  const row = message.components?.[0];
  assert.ok(row?.kind === "buttons");
  const button = row.buttons.find((candidate) => candidate.label === label);
  assert.ok(button !== undefined, label);
  return button.customId;
}

/**
 * 本物の CcSender（偽の tmux。S1 は %1 の claude で作業中、S2 は %2 のシェル、S3 は tmux の外）・ストア・一時 SQLite と、
 * 偽の starter（check・launch を記録）・偽の Bot（投稿・書き換えを記録）
 */
function setup(t: TestContext) {
  const db = tempDb(t);
  const clock = { now: BASE };
  const now = (): Date => new Date(clock.now);
  const sends = new CcSendStore(db, now);
  const starts = new CcStartStore(db, now);
  const sessions = new CcSessionStore(db, now);
  sessions.upsertSeen([
    { sessionId: S1, cwd: "/w/alpha", name: SECRET_NAME, pid: 500 },
    { sessionId: S2, cwd: "/w/beta", name: "b", pid: 600 },
  ]);
  const commands: string[][] = [];
  const tmuxEnv = { noServer: false };
  const run: RunCommand = async (_file, args) => {
    commands.push([...args]);
    if (tmuxEnv.noServer) return { code: 1, stdout: "", stderr: "no server running on /tmp/tmux-1000/default\n" };
    switch (args[0]) {
      case "list-panes":
        return { code: 0, stdout: [paneLine("%1", 400), paneLine("%2", 410, "bash")].join("\n"), stderr: "" };
      case "capture-pane":
        return { code: 0, stdout: BUSY, stderr: "" };
      default:
        return { code: 0, stdout: "", stderr: "" };
    }
  };
  const tmux = createTmux({ tmuxPath: "/usr/bin/tmux", run });
  const parents: Record<number, number> = { 500: 400, 600: 410, 400: 1, 410: 1, 700: 1 };
  const panes = new CcPaneResolver({ tmux, parentOf: (pid) => parents[pid] });
  const snapshot: CcSnapshot = {
    sessions: [
      view(S1, 500, { status: "waiting", state: "needs_input", waitingFor: "permission prompt", waitingSince: BASE - 60_000, lastPromptText: "前の指示", bridgeSessionId: "session_abc" }),
      view(S2, 600, { status: "busy", state: "running", name: "b", cwd: "/w/beta" }),
      view(S3, 700, { name: "c", cwd: "/elsewhere" }),
    ],
    stale: false,
    unreadable: false,
    fetchedAt: BASE,
  };
  const registry = { snapshot: () => snapshot };
  const logs: string[] = [];
  const log = (message: string): void => void logs.push(message);
  const sender = new CcSender({
    cfg: { ccSendWaitMin: 120, allowedGuildIds: [] },
    registry,
    panes,
    tmux,
    sends,
    sessions,
    now,
    sleep: async () => undefined,
    timers: { after: () => () => undefined },
    log,
  });
  const checks: unknown[] = [];
  const launches: CcStartInput[] = [];
  const starter = {
    checkResult: undefined as CcStartCheck | undefined,
    launchResult: { ok: true, tmuxSession: "alpha", paneId: "%9", sendId: undefined } as LaunchResult,
    async check(input: unknown): Promise<CcStartCheck> {
      checks.push(input);
      const i = input as { project: string; title: string; text?: string; permissionMode?: string };
      return this.checkResult ?? { ok: true, project: i.project, title: i.title.trim(), mode: i.permissionMode, text: i.text };
    },
    async launch(input: CcStartInput): Promise<LaunchResult> {
      launches.push(input);
      return this.launchResult;
    },
  };
  const posted: Array<{ channelId: string; message: OutgoingMessage }> = [];
  const edited: Array<{ channelId: string; messageId: string; message: OutgoingMessage }> = [];
  const bot = {
    failPost: false,
    /** これまでに投稿した数がこれになったら次の投稿に失敗する（undefined なら失敗しない） */
    failAfter: undefined as number | undefined,
    async sendMessage(channelId: string, message: OutgoingMessage): Promise<string> {
      if (this.failPost || this.failAfter === posted.length) throw new Error("Missing Access");
      posted.push({ channelId, message });
      return `m-${posted.length}`;
    },
    async editMessage(channelId: string, messageId: string, message: OutgoingMessage): Promise<void> {
      edited.push({ channelId, messageId, message });
    },
  };
  const cfg = { workspaceDir: "/w", timeZone: "Asia/Tokyo" };
  const cc = createCcTools({ cfg, registry, panes, sender, starter, sends, starts, gateway: bot, home: "/home/owner", log });
  const runtime: { value: CcConfirmRuntime | undefined } = { value: { sender, starter, registry, panes } };
  const component = createCcComponent({
    cfg,
    ccSends: sends,
    ccStarts: starts,
    ccSessions: sessions,
    ccRuntime: () => runtime.value,
    ccPosts: bot,
    gateway: bot,
    now,
    home: "/home/owner",
    log,
  });
  const pressButton = async (customId: string): Promise<ResponderCall[]> => {
    const responder = new FakeResponder();
    await component.handle(press(customId), responder);
    return responder.calls;
  };
  const handlers = (context: RunContext = CONTEXT) => createCcToolHandlers(cc, context);
  return { tmuxEnv, db, clock, sends, starts, sessions, commands, snapshot, sender, starter, checks, launches, bot, posted, edited, cc, runtime, logs, pressButton, handlers };
}

const pasteOps = (commands: string[][]) => commands.filter((args) => ["load-buffer", "paste-buffer", "send-keys"].includes(args[0]!));

/** 最後の update の本文 */
function updated(calls: ResponderCall[]): OutgoingMessage {
  const call = calls.findLast((candidate) => candidate.method === "update");
  assert.ok(call !== undefined && call.method === "update");
  return call.message;
}

test("openDb: CC7 の移行で cc_starts と cc_sends の channel_id・message_id、cc_sessions の channel_id ができる。state は決まった語だけ", (t) => {
  const path = join(tempDir(t), "self-agent.db");
  // CC7 の 1 つ前の版から上げる（版の番号には依らない）
  const before = new DatabaseSync(path);
  for (const migration of MIGRATIONS.slice(0, -1)) before.exec(migration);
  before.exec(`PRAGMA user_version = ${MIGRATIONS.length - 1}`);
  before.close();
  const db = openDb(path);
  t.after(() => db.close());
  assert.equal(db.prepare("PRAGMA user_version").get()?.user_version, MIGRATIONS.length);
  const columns = (table: string) => db.prepare(`PRAGMA table_info(${table})`).all().map((row) => String(row.name));
  assert.ok(columns("cc_sends").includes("channel_id") && columns("cc_sends").includes("message_id"));
  assert.ok(columns("cc_sessions").includes("channel_id"));
  assert.ok(["project", "title", "text", "permission_mode", "channel_id", "message_id", "state", "tmux_session", "pane_id", "send_id"].every((name) => columns("cc_starts").includes(name)));
  const insert = (state: string) =>
    db.prepare("INSERT INTO cc_starts (project, title, channel_id, state, created_at, updated_at) VALUES ('a', 'b', 'c', ?, 'x', 'x')").run(state);
  assert.throws(() => insert("queued"));
  insert("awaiting_confirm");
});

test("CcStartStore: add・message_id・compare-and-set・確認待ちの失効の一覧・prune は確認待ちを残す", (t) => {
  const db = tempDb(t);
  const clock = { now: BASE };
  const starts = new CcStartStore(db, () => new Date(clock.now));
  const row = starts.add({ project: "alpha", title: "fix", channelId: CHANNEL });
  assert.deepEqual([row.state, row.text, row.permissionMode, row.messageId], ["awaiting_confirm", null, null, null]);
  starts.setMessageId(row.id, "m-1");
  assert.equal(starts.get(row.id)!.messageId, "m-1");
  const other = starts.add({ project: "beta", title: "b", text: "t", permissionMode: "plan", channelId: CHANNEL });
  clock.now += CC_CONFIRM_TTL_MS;
  assert.deepEqual(
    starts.listAwaitingConfirmBefore(new Date(clock.now - CC_CONFIRM_TTL_MS + 1)).map((r) => r.id),
    [row.id, other.id],
  );
  assert.equal(starts.transition(row.id, ["awaiting_confirm"], "started"), true);
  assert.equal(starts.transition(row.id, ["awaiting_confirm"], "cancelled"), false);
  assert.equal(starts.transition(row.id, ["started"], "started", { tmuxSession: "alpha", paneId: "%9", sendId: 3 }), true);
  assert.deepEqual([starts.get(row.id)!.tmuxSession, starts.get(row.id)!.paneId, starts.get(row.id)!.sendId], ["alpha", "%9", 3]);
  assert.equal(starts.prune(new Date(clock.now + 1)), 1);
  assert.notEqual(starts.get(other.id), undefined);
});

test("ツール定義: cc_list・cc_send・cc_start は末尾にあり、Claude Code の連携の有無・context で定義が変わらない", (t) => {
  const s = setup(t);
  const definitions = (cc: CcToolDeps | undefined, context: RunContext | undefined) =>
    createTaskTools({} as never, {} as never, {} as never, {} as never, {} as never, {} as never, context, cc).map((definition) => ({
      name: definition.name,
      description: definition.description,
      inputSchema: z.toJSONSchema(z.object(definition.inputSchema)),
    }));
  const base = definitions(undefined, undefined);
  assert.deepEqual(base.slice(-3).map((definition) => definition.name), ["cc_list", "cc_send", "cc_start"]);
  assert.deepEqual(definitions(s.cc, CONTEXT), base);
  const send = createTaskTools({} as never, {} as never, {} as never, {} as never, {} as never, {} as never).find((d) => d.name === "cc_send")!;
  const schema = z.object(send.inputSchema);
  assert.equal(schema.safeParse({ session_id: S1, text: "a".repeat(4000) }).success, true);
  assert.equal(schema.safeParse({ session_id: S1, text: "a".repeat(4001) }).success, false);
  assert.equal(schema.safeParse({ session_id: S1, text: "" }).success, false);
});

test("not_available: 予約した依頼・/close・context の無いターンと、Claude Code の連携が無効なときは何もしない", async (t) => {
  const s = setup(t);
  const contexts: Array<RunContext | undefined> = [{ ...CONTEXT, scheduled: true }, { ...CONTEXT, kind: "session", purpose: "close" }, undefined];
  for (const context of contexts) {
    const h = createCcToolHandlers(s.cc, context);
    for (const result of [await h.ccList({}), await h.ccSend({ session_id: S1, text: "x" }), await h.ccStart({ project: "alpha", title: "a" })]) {
      assert.deepEqual(parse(result), { result: "not_available", message: CC_NOT_AVAILABLE_MESSAGE });
    }
  }
  const disabled = createCcToolHandlers(undefined, CONTEXT);
  for (const result of [await disabled.ccList({}), await disabled.ccSend({ session_id: S1, text: "x" }), await disabled.ccStart({ project: "alpha", title: "a" })]) {
    assert.deepEqual(parse(result), { result: "not_available", message: CC_DISABLED_MESSAGE });
  }
  assert.deepEqual(s.posted, []);
  assert.equal(s.sends.get(1), undefined);
  assert.equal(s.starts.get(1), undefined);
  assert.equal(s.checks.length, 0);
  // セッションのチャンネル・#tasks のオーナーの発言のターンでは使える
  assert.equal(parse(await s.handlers({ ...CONTEXT, kind: "session" }).ccList({})).注意, CC_LIST_NOTICE);
});

test("cc_list: §2.2 の順で「従わない」の注意付き。state で絞り、in_tmux・dir・時刻・RC のリンクを付ける", async (t) => {
  const s = setup(t);
  const all = parse(await s.handlers().ccList({}));
  assert.equal(all.注意, CC_LIST_NOTICE);
  assert.deepEqual([all.more, all.stale], [0, false]);
  const sessions = all.sessions as Array<Record<string, unknown>>;
  assert.deepEqual(sessions.map((entry) => entry.session_id), [S1, S2, S3]);
  assert.deepEqual(sessions[0], {
    session_id: S1,
    name: SECRET_NAME,
    dir: "alpha",
    state: "needs_input",
    waiting_for: "permission prompt",
    since: "2026-11-01 08:59",
    last_prompt_at: null,
    last_prompt: "前の指示",
    in_tmux: true,
    permission_mode: null,
    rc_url: "https://claude.ai/code/session_abc",
  });
  assert.equal(sessions[2]!.in_tmux, false);
  assert.equal(sessions[2]!.dir, "/elsewhere");
  // 出すものが無ければ tmux を読まない
  const listsBefore = s.commands.filter((args) => args[0] === "list-panes").length;
  s.snapshot.sessions = s.snapshot.sessions.filter((entry) => entry.state !== "running");
  assert.deepEqual((parse(await s.handlers().ccList({ state: "running" })).sessions as unknown[]).length, 0);
  assert.equal(s.commands.filter((args) => args[0] === "list-panes").length, listsBefore);
  s.snapshot.sessions.splice(1, 0, view(S2, 600, { status: "busy", state: "running", name: "b", cwd: "/w/beta" }));
  const running = parse(await s.handlers().ccList({ state: "running" }));
  assert.deepEqual((running.sessions as Array<Record<string, unknown>>).map((entry) => entry.session_id), [S2]);
  // 最大 CC_LIST_MAX 件。残りは more
  s.snapshot.sessions = Array.from({ length: CC_LIST_MAX + 2 }, (_, i) => view(`aaaaaaaa-aaaa-4aaa-8aaa-${String(i).padStart(12, "0")}`, 1000 + i));
  const many = parse(await s.handlers().ccList({}));
  assert.deepEqual([(many.sessions as unknown[]).length, many.more], [CC_LIST_MAX, 2]);
  assert.deepEqual(s.logs, []);
});

test("cc_send: 確認を投稿して cc_sends に awaiting_confirm で作るだけで、tmux には貼らない。log に本文・名前が無い", async (t) => {
  const s = setup(t);
  const result = parse(await s.handlers().ccSend({ session_id: S1, text: SECRET_TEXT }));
  assert.deepEqual(result, { result: "confirmation_posted", send_id: 1 });
  const row = s.sends.get(1)!;
  assert.deepEqual([row.sessionId, row.origin, row.state, row.text, row.channelId, row.messageId], [S1, "tool", "awaiting_confirm", SECRET_TEXT, CHANNEL, "m-1"]);
  assert.equal(s.posted.length, 1);
  assert.equal(s.posted[0]!.channelId, CHANNEL);
  const text = s.posted[0]!.message.text;
  assert.ok(text.startsWith(`Claude Code の ${SECRET_NAME.replace(/-/g, "\\-")}（alpha）に送りますか？`), text);
  assert.ok(text.includes(`\`\`\`\n${SECRET_TEXT}\n\`\`\``));
  assert.deepEqual(
    [buttonId(s.posted[0]!.message, "送る"), buttonId(s.posted[0]!.message, "やめる")],
    ["cc:send:1", "cc:keep:send:1"],
  );
  assert.deepEqual(pasteOps(s.commands), []);
  assert.deepEqual(s.logs, ["Claude Code: cc_send の確認を出しました（#1）"]);
  // 確認待ちがある間は同じセッションに出さない
  assert.deepEqual(parse(await s.handlers().ccSend({ session_id: S1, text: "別" })), { result: "already_queued" });
  // 一覧に無い・UUID でない・シェルのペイン・tmux の外
  assert.deepEqual(parse(await s.handlers().ccSend({ session_id: "99999999-9999-4999-8999-999999999999", text: "x" })), { result: "not_found" });
  assert.deepEqual(parse(await s.handlers().ccSend({ session_id: "x", text: "x" })), { result: "not_found" });
  assert.deepEqual(parse(await s.handlers().ccSend({ session_id: S2, text: "x" })), { result: "not_in_tmux" });
  assert.deepEqual(parse(await s.handlers().ccSend({ session_id: S3, text: "x" })), { result: "not_in_tmux" });
  assert.equal(parse(await s.handlers().ccSend({ session_id: S1, text: "a\tb" })).result, "invalid_args");
  s.tmuxEnv.noServer = true;
  assert.deepEqual(parse(await s.handlers().ccSend({ session_id: S2, text: "x" })), { result: "not_available", message: "tmux のサーバーがありません" });
  s.tmuxEnv.noServer = false;
  const logs = s.logs.join("\n");
  assert.ok(!logs.includes(SECRET_TEXT) && !logs.includes(SECRET_NAME) && !logs.includes(CHANNEL) && !logs.includes(S1));
});

test("cc_send: 投稿に失敗したら行を取り消して投げる（送らない）", async (t) => {
  const s = setup(t);
  s.bot.failPost = true;
  await assert.rejects(s.handlers().ccSend({ session_id: S1, text: "x" }), /Missing Access/);
  assert.equal(s.sends.get(1)!.state, "cancelled");
});

/** 投稿の各通のコードブロックの中身をつないだもの（ゼロ幅の空白は除く） */
function shownBody(messages: readonly OutgoingMessage[]): string {
  return messages
    .map((message) => /```\n([\s\S]*)\n```$/.exec(message.text)?.[1] ?? "")
    .join("")
    .replace(/\u200b/g, "");
}

test("確認の本文: 全文を 1 通 1,800 字ずつ最大 3 通に分け、ボタンは最後の 1 通だけ。どの通も 2,000 字以内で、``` は閉じない", () => {
  const target = { name: "a", dir: "alpha" };
  const one = ccSendPrompt(1, target, "あ".repeat(CC_CONFIRM_PAGE_CHARS));
  assert.equal(one.length, 1);
  assert.equal(shownBody(one), "あ".repeat(1800));
  assert.ok(!one[0]!.text.includes("ほか"));
  // 1,801 字は 2 通（切らない）
  const two = ccSendPrompt(1, target, "あ".repeat(1801));
  assert.equal(two.length, 2);
  assert.equal(shownBody(two), "あ".repeat(1801));
  assert.ok(two[0]!.text.startsWith("Claude Code の a（alpha）に送りますか？\n（1/2）\n```"));
  assert.ok(two[1]!.text.startsWith("（続き 2/2）\n```"));
  assert.deepEqual(two.map((message) => message.components !== undefined), [false, true]);
  // 4,000 字（上限）は 3 通。長い名前でも各通は 2,000 字以内
  const text = Array.from({ length: 4000 }, (_, i) => "いろはにほへと\n"[i % 8]).join("");
  const three = ccSendPrompt(1, { name: "_".repeat(200), dir: "*".repeat(200) }, text);
  assert.equal(three.length, CC_CONFIRM_MAX_PAGES);
  assert.equal(shownBody(three), text);
  for (const message of three) assert.ok([...message.text].length <= 2000, String([...message.text].length));
  // ``` を崩すと長くなるが、1 通の中で切らずに次の通へ送る。崩した後もブロックは閉じない
  const ticks = "a```b\n".repeat(600);
  const pages = splitConfirmBody(ticks);
  assert.equal(pages.join("").replace(/\u200b/g, ""), ticks);
  for (const page of pages) {
    assert.ok([...page].length <= CC_CONFIRM_PAGE_CHARS);
    assert.ok(!page.includes("```"));
  }
  const tickMessages = ccSendPrompt(1, target, ticks);
  for (const message of tickMessages) assert.equal(message.text.split("```").length, 3, message.text.slice(0, 40));
  // 3 通に出しきれない本文は確認を出さない
  assert.equal(fitsConfirm("`".repeat(4000)), false);
  assert.equal(fitsConfirm("a".repeat(4000)), true);
});

test("cc_send: 長い本文は 3 通に分けて投稿し、ボタンの付いた最後の通を記録する。[送る]・失効で書き換えるのは最後の通だけ", async (t) => {
  const s = setup(t);
  const text = "x".repeat(3900);
  assert.deepEqual(parse(await s.handlers().ccSend({ session_id: S1, text })), { result: "confirmation_posted", send_id: 1 });
  assert.equal(s.posted.length, 3);
  assert.deepEqual(s.posted.map((post) => post.message.components !== undefined), [false, false, true]);
  assert.equal(shownBody(s.posted.map((post) => post.message)), text);
  assert.equal(s.sends.get(1)!.messageId, "m-3");
  const message = updated(await s.pressButton(buttonId(s.posted[2]!.message, "送る")));
  assert.ok(message.text.startsWith("Claude Code の"), message.text.slice(0, 40));
  assert.ok(message.text.includes("（続き 3/3）"));
  assert.ok([...message.text].length <= 2000);
  // 失効の書き換えも最後の通だけ
  const expirer = new CcConfirmExpirer({
    cfg: { workspaceDir: "/w" },
    ccSends: s.sends,
    ccStarts: s.starts,
    ccSessions: s.sessions,
    ccPosts: s.bot,
    ccEnabled: () => true,
    now: () => new Date(s.clock.now),
    log: () => undefined,
  });
  await s.handlers().ccStart({ project: "alpha", title: "fix", text: "z".repeat(2000) });
  assert.deepEqual(s.posted.slice(3).map((post) => post.message.components !== undefined), [false, true]);
  s.clock.now += CC_CONFIRM_TTL_MS;
  await expirer.sweep();
  assert.deepEqual(s.edited.map((edit) => edit.messageId), ["m-5"]);
  assert.ok(s.edited[0]!.message.text.includes("`alpha` で起動しませんでした"));
});

test("cc_send: 途中の通の投稿に失敗したら行を取り消して投げる。3 通に出しきれない本文は投稿しない", async (t) => {
  const s = setup(t);
  s.bot.failAfter = 1;
  await assert.rejects(s.handlers().ccSend({ session_id: S1, text: "x".repeat(3000) }), /Missing Access/);
  assert.equal(s.sends.get(1)!.state, "cancelled");
  assert.equal(s.sends.get(1)!.messageId, null);
  s.bot.failAfter = undefined;
  const before = s.posted.length;
  assert.deepEqual(parse(await s.handlers().ccSend({ session_id: S1, text: "`".repeat(4000) })), {
    result: "invalid_args",
    message: CONFIRM_TOO_LONG_MESSAGE,
  });
  assert.equal(s.posted.length, before);
  assert.equal(s.sends.get(2), undefined);
});

test("[送る]: queued にして待ち行列を回す。入力待ちでなければ積んだまま「入力待ちになったら届けます」に書き換え、ボタンを外す", async (t) => {
  const s = setup(t);
  await s.handlers().ccSend({ session_id: S1, text: SECRET_TEXT });
  s.clock.now += 60_000;
  const calls = await s.pressButton("cc:send:1");
  assert.equal(calls[0]!.method, "deferUpdate");
  const row = s.sends.get(1)!;
  assert.equal(row.state, "queued");
  // 送信の待ちの上限は [送る] から数える
  assert.equal(row.createdAt, new Date(BASE + 60_000).toISOString());
  assert.equal(row.lastPaneState, "busy");
  assert.deepEqual(pasteOps(s.commands), []);
  const message = updated(calls);
  assert.deepEqual(message.components, []);
  assert.ok(message.text.includes("送ります。入力待ちになったら届けます"), message.text);
  assert.ok(message.text.includes(SECRET_TEXT));
  assert.equal(s.sessions.get(S1)!.channelId, CHANNEL);
  // 二度目は古い（メッセージは変えない）
  const again = await s.pressButton("cc:send:1");
  assert.deepEqual(again, [{ method: "reply", message: { text: STALE_TEXT, ephemeral: true } }]);
  assert.ok(!s.logs.join("\n").includes(SECRET_TEXT));
});

test("[送る]: 届いたら「送りました」とペインと RC のリンク", async (t) => {
  const s = setup(t);
  await s.handlers().ccSend({ session_id: S1, text: "x" });
  s.runtime.value = {
    ...s.runtime.value!,
    sender: {
      confirm: (id) => s.sender.confirm(id),
      kick: async () => {
        s.sends.transition(1, ["queued"], "delivering");
        s.sends.transition(1, ["delivering"], "delivered");
      },
    },
  };
  const text = updated(await s.pressButton("cc:send:1")).text;
  assert.ok(text.includes("に送りました（work\\:0.1・RC: <https://claude.ai/code/session_abc>）"), text);
});

test("[やめる]・10 分の放置: cancelled にしてボタンを外し「送りませんでした」。失効は押したときにも確かめる", async (t) => {
  const s = setup(t);
  await s.handlers().ccSend({ session_id: S1, text: "x" });
  const kept = updated(await s.pressButton("cc:keep:send:1"));
  assert.ok(kept.text.includes("に送りませんでした"), kept.text);
  assert.deepEqual(kept.components, []);
  assert.equal(s.sends.get(1)!.state, "cancelled");
  assert.deepEqual(await s.pressButton("cc:send:1"), [{ method: "reply", message: { text: STALE_TEXT, ephemeral: true } }]);

  // 10 分経ってから [送る] を押しても送らない
  await s.handlers().ccSend({ session_id: S1, text: "y" });
  s.clock.now += CC_CONFIRM_TTL_MS;
  const late = updated(await s.pressButton("cc:send:2"));
  assert.ok(late.text.includes("に送りませんでした"));
  assert.equal(s.sends.get(2)!.state, "cancelled");
  assert.deepEqual(pasteOps(s.commands), []);
});

test("CcConfirmExpirer: 10 分経った確認待ちの送信・起動を cancelled にし、確認のメッセージのボタンを外して書き換える", async (t) => {
  const s = setup(t);
  await s.handlers().ccSend({ session_id: S1, text: SECRET_TEXT });
  await s.handlers().ccStart({ project: "alpha", title: "fix" });
  const expirer = new CcConfirmExpirer({
    cfg: { workspaceDir: "/w" },
    ccSends: s.sends,
    ccStarts: s.starts,
    ccSessions: s.sessions,
    ccPosts: s.bot,
    ccEnabled: () => true,
    now: () => new Date(s.clock.now),
    home: "/home/owner",
    log: (message) => s.logs.push(message),
  });
  s.clock.now += CC_CONFIRM_TTL_MS - 1;
  await expirer.sweep();
  assert.equal(s.sends.get(1)!.state, "awaiting_confirm");
  assert.equal(s.starts.get(1)!.state, "awaiting_confirm");
  s.clock.now += 1;
  await expirer.sweep();
  assert.equal(s.sends.get(1)!.state, "cancelled");
  assert.equal(s.starts.get(1)!.state, "cancelled");
  assert.deepEqual(
    s.edited.map((edit) => [edit.channelId, edit.messageId, edit.message.components]),
    [
      [CHANNEL, "m-1", []],
      [CHANNEL, "m-2", []],
    ],
  );
  assert.ok(s.edited[0]!.message.text.includes("に送りませんでした"));
  assert.ok(s.edited[1]!.message.text.includes("で起動しませんでした"));
  assert.ok(s.logs.includes("Claude Code: 確認の期限が過ぎたため送りませんでした（#1）"));
  assert.ok(!s.logs.join("\n").includes(SECRET_TEXT));
  // もう押せない
  assert.deepEqual(await s.pressButton("cc:send:1"), [{ method: "reply", message: { text: STALE_TEXT, ephemeral: true } }]);
});

test("cc_start: 確かめてから確認を投稿し cc_starts に awaiting_confirm で作るだけ。[起動する] で tool として起動し、[やめる] で起動しない", async (t) => {
  const s = setup(t);
  const result = parse(await s.handlers().ccStart({ project: "alpha", title: "fix login", text: SECRET_TEXT, permission_mode: "plan" }));
  assert.deepEqual(result, { result: "confirmation_posted", start_id: 1 });
  const row = s.starts.get(1)!;
  assert.deepEqual([row.project, row.title, row.text, row.permissionMode, row.channelId, row.messageId, row.state], ["alpha", "fix login", SECRET_TEXT, "plan", CHANNEL, "m-1", "awaiting_confirm"]);
  assert.equal(s.launches.length, 0);
  const prompt = s.posted[0]!.message;
  assert.ok(prompt.text.startsWith("`alpha` で Claude Code の新しいセッションを起動しますか？\n題名: `fix login`\n権限モード: plan\n最初の指示:\n```"), prompt.text);
  assert.ok(prompt.text.includes(SECRET_TEXT));
  assert.deepEqual([buttonId(prompt, "起動する"), buttonId(prompt, "やめる")], ["cc:start:1", "cc:keep:start:1"]);

  const calls = await s.pressButton("cc:start:1");
  assert.equal(calls[0]!.method, "deferUpdate");
  assert.equal(s.launches.length, 1);
  assert.deepEqual(
    { ...s.launches[0]!, onTrustPending: typeof s.launches[0]!.onTrustPending },
    { project: "alpha", title: "fix login", text: SECRET_TEXT, permissionMode: "plan", startedBy: "tool", channelId: CHANNEL, onTrustPending: "function" },
  );
  const after = s.starts.get(1)!;
  assert.deepEqual([after.state, after.tmuxSession, after.paneId], ["started", "alpha", "%9"]);
  const message = updated(calls);
  assert.ok(message.text.startsWith("`alpha` で起動しました（tmux: alpha）"), message.text);
  assert.deepEqual(message.components, []);
  // 起動の後に trust の確認待ちなら、確認のメッセージをその旨に書き換える
  s.launches[0]!.onTrustPending!();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(s.edited.length, 1);
  assert.ok(s.edited[0]!.message.text.includes("trust の確認を待っています"));
  // 二度押しでは起動しない
  assert.deepEqual(await s.pressButton("cc:start:1"), [{ method: "reply", message: { text: STALE_TEXT, ephemeral: true } }]);
  assert.equal(s.launches.length, 1);

  await s.handlers().ccStart({ project: "beta", title: "b" });
  const kept = updated(await s.pressButton("cc:keep:start:2"));
  assert.ok(kept.text.startsWith("`beta` で起動しませんでした"), kept.text);
  assert.equal(s.starts.get(2)!.state, "cancelled");
  assert.equal(s.launches.length, 1);
  assert.ok(!s.logs.join("\n").includes(SECRET_TEXT) && !s.logs.join("\n").includes("alpha"));
});

test("cc_start: 確かめられなければ確認を出さない。[起動する] で起動できなければ failed と理由", async (t) => {
  const s = setup(t);
  for (const [reason, expected] of [
    ["invalid_project", "invalid_project"],
    ["limit", "limit"],
    ["low_memory", "limit"],
    ["no_server", "no_server"],
    ["invalid_title", "invalid_args"],
    ["not_ready", "not_available"],
  ] as const) {
    s.starter.checkResult = { ok: false, reason };
    assert.equal(parse(await s.handlers().ccStart({ project: "x", title: "a" })).result, expected, reason);
  }
  assert.deepEqual(s.posted, []);
  s.starter.checkResult = undefined;
  await s.handlers().ccStart({ project: "alpha", title: "a" });
  s.starter.launchResult = { ok: false, reason: "tmux_failed" };
  const message = updated(await s.pressButton("cc:start:1"));
  assert.ok(message.text.startsWith("`alpha` で起動できませんでした（tmux を使えませんでした）"), message.text);
  assert.deepEqual(message.components, []);
  assert.equal(s.starts.get(1)!.state, "failed");
});

test("[起動する]: 一時的な理由（too_soon・limit・low_memory・no_server）で起動できなければ確認待ちに戻してボタンを残し、もう一度押せる", async (t) => {
  const s = setup(t);
  await s.handlers().ccStart({ project: "alpha", title: "a" });
  for (const [reason, text] of [
    ["too_soon", "前の起動から 1 分経っていません"],
    ["limit", "セッションの数が上限です"],
    ["low_memory", "メモリが足りません"],
    ["no_server", "tmux のサーバーがありません"],
  ] as const) {
    s.starter.launchResult = { ok: false, reason };
    const message = updated(await s.pressButton("cc:start:1"));
    assert.ok(message.text.startsWith(`\`alpha\` で起動できませんでした（${text}）。少し待ってもう一度押してください`), message.text);
    assert.equal(buttonId(message, "起動する"), "cc:start:1");
    assert.equal(s.starts.get(1)!.state, "awaiting_confirm");
  }
  s.starter.launchResult = { ok: true, tmuxSession: "alpha", paneId: "%9", sendId: undefined };
  const started = updated(await s.pressButton("cc:start:1"));
  assert.ok(started.text.startsWith("`alpha` で起動しました"), started.text);
  assert.equal(s.starts.get(1)!.state, "started");
  assert.equal(s.launches.length, 5);
});

test("CcConfirmExpirer: Claude Code の連携が無効なら、残っている確認待ちを時間を待たずに取り消して注記する", async (t) => {
  const s = setup(t);
  await s.handlers().ccSend({ session_id: S1, text: "x" });
  await s.handlers().ccStart({ project: "alpha", title: "a" });
  const enabled = { value: true };
  const expirer = new CcConfirmExpirer({
    cfg: { workspaceDir: "/w" },
    ccSends: s.sends,
    ccStarts: s.starts,
    ccSessions: s.sessions,
    ccPosts: s.bot,
    ccEnabled: () => enabled.value,
    now: () => new Date(s.clock.now),
    log: (message) => s.logs.push(message),
  });
  await expirer.sweep();
  assert.deepEqual([s.sends.get(1)!.state, s.starts.get(1)!.state], ["awaiting_confirm", "awaiting_confirm"]);
  enabled.value = false;
  await expirer.sweep();
  assert.deepEqual([s.sends.get(1)!.state, s.starts.get(1)!.state], ["cancelled", "cancelled"]);
  assert.ok(s.edited[0]!.message.text.includes(`送りませんでした${CC_DISABLED_NOTE}`));
  assert.ok(s.edited[1]!.message.text.includes(`起動しませんでした${CC_DISABLED_NOTE}`));
  assert.ok(s.logs.includes("Claude Code: 連携が無効なため送りませんでした（#1）"));
});

test("Claude Code の連携が無効な間に押された確認は取り消す", async (t) => {
  const s = setup(t);
  await s.handlers().ccSend({ session_id: S1, text: "x" });
  await s.handlers().ccStart({ project: "alpha", title: "a" });
  s.runtime.value = undefined;
  assert.ok(updated(await s.pressButton("cc:send:1")).text.includes("送りませんでした（Claude Code の連携が無効です）"));
  assert.ok(updated(await s.pressButton("cc:start:1")).text.includes("起動しませんでした（Claude Code の連携が無効です）"));
  assert.deepEqual([s.sends.get(1)!.state, s.starts.get(1)!.state], ["cancelled", "cancelled"]);
});

test("cc: の custom_id の形が違えば投げる（振り分けの失敗の応答になる）", async (t) => {
  const s = setup(t);
  for (const id of ["cc:send:x", "cc:send:1:2", "cc:keep:1", "cc:keep:other:1", "cc:unknown:1"]) {
    await assert.rejects(s.pressButton(id), Error, id);
  }
});
