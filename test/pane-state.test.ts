import { test } from "node:test";
import assert from "node:assert/strict";
import {
  classifyPane,
  classifyScreen,
  OWNER_ACTIVE_MS,
  probePaneState,
  SECOND_CAPTURE_DELAY_MS,
  stripAnsi,
  type PaneMeta,
} from "../src/tmux/pane-state.ts";
import type { Tmux, TmuxClient, TmuxPane, TmuxResult } from "../src/tmux/tmux.ts";

// fixture は Claude Code 2.1.296 の capture-pane -p -e の形を写し、文字は置き換えたもの（本文・パス・URL を含めない）
const ESC = "\x1b";
const NBSP = " ";
const sgr = (params: string): string => `${ESC}[${params}m`;
const link = (url: string, text: string): string => `${ESC}]8;id=x;${url}${ESC}\\${text}${ESC}]8;;${ESC}\\`;
// SGR の色は次の行の先頭で戻る（tmux は状態を行をまたいで出す）
const RULE = `${sgr("38;5;244")}${"─".repeat(80)}`;
const FOOTER = [
  `${sgr("39")}  ${sgr("38;5;220")}⏵⏵${sgr("39")} ${sgr("38;5;220")}auto mode on${sgr("38;5;246")} (shift+tab to cycle)${sgr("39")}`,
  `${" ".repeat(60)}${sgr("38;5;114")}${link("https://example.invalid/s", "/rc")}${sgr("39")}`,
];
const BUSY_FOOTER = [
  `${sgr("39")}  ${sgr("38;5;220")}⏵⏵ auto mode on${sgr("38;5;246")} (shift+tab to cycle) · ${sgr("38;5;246")}esc${sgr("39")} ${sgr("38;5;246")}to${sgr("39")} ${sgr("38;5;246")}interrupt${sgr("39")}`,
];
const HISTORY = [`${sgr("1")}● 返答の本文（置き換え）${sgr("0")}`, ""];

/** 履歴・入力欄（1 行以上）・フッター・末尾の空行を並べた画面 */
function screen(input: string[], options: { above?: string[]; footer?: string[]; blank?: number } = {}): string {
  return [...(options.above ?? HISTORY), RULE, ...input, RULE, ...(options.footer ?? FOOTER), ...Array(options.blank ?? 6).fill("")].join(
    "\n",
  );
}

const PROMPT = `${sgr("39")}❯${NBSP}`;
const EMPTY = screen([PROMPT]);
const PLACEHOLDER = screen([`${PROMPT}${sgr("2")}Try${sgr("0")} ${sgr("2")}"placeholder text..."${sgr("0")}`]);
const DRAFT = screen([`${PROMPT}書きかけの文`]);
const SPINNER = screen([PROMPT], { above: [...HISTORY, `${sgr("38;5;174")}✶${sgr("39")} Working… (12s · ↓ 1.2k tokens)`, ""] });
const DONE = screen([PROMPT], { above: [...HISTORY, `${sgr("38;5;174")}✻${sgr("39")} Worked for 9s`] });
const BUSY = screen([`${sgr("38;5;246")}❯${NBSP}${sgr("39")}`], { above: ["! command", "  ⎿  Running…"], footer: BUSY_FOOTER });
const DIALOG = [
  RULE,
  `${sgr("39")} ${sgr("1")}${sgr("38;5;220")}Title${sgr("0")}`,
  "",
  ` ${sgr("38;5;153")}❯${sgr("39")} ${sgr("38;5;153")}1. Yes${sgr("39")}`,
  "   2. No",
  "",
  ` ${sgr("38;5;246")}Enter${sgr("39")} ${sgr("38;5;246")}to${sgr("39")} ${sgr("38;5;246")}confirm${sgr("39")} ${sgr("38;5;246")}·${sgr("39")} ${sgr("38;5;246")}Esc${sgr("39")} ${sgr("38;5;246")}to${sgr("39")} ${sgr("38;5;246")}cancel${sgr("39")}`,
  "",
].join("\n");
const MULTI_LINE = screen([`${PROMPT}1 行目`, "  2 行目"]);

function pane(overrides: Partial<TmuxPane> = {}): TmuxPane {
  return {
    sessionName: "work",
    windowIndex: 0,
    paneIndex: 0,
    paneId: "%1",
    windowActive: true,
    paneActive: true,
    currentPath: "/home/u/workspace/a",
    currentCommand: "claude",
    inMode: false,
    dead: false,
    ...overrides,
  };
}

const NOW = 1_760_000_000_000;
const META: PaneMeta = { pane: pane() };

test("stripAnsi: SGR・OSC（ハイパーリンク）を落とす", () => {
  assert.equal(stripAnsi(`a${sgr("2")}b${sgr("")}c${link("https://example.invalid", "d")}`), "abcd");
  assert.equal(stripAnsi(FOOTER[1]!).trim(), "/rc");
});

test("classifyScreen: §5.3 の表の画面の状態", () => {
  const cases: Array<[string, string, string]> = [
    ["空の入力欄", EMPTY, "idle"],
    ["dim の候補だけ", PLACEHOLDER, "idle"],
    ["書きかけ", DRAFT, "draft"],
    ["作業中のスピナー（入力欄の直前の行）", SPINNER, "busy"],
    ["作業が終わった後の行（… が無い）", DONE, "idle"],
    ["esc to interrupt", BUSY, "busy"],
    ["ダイアログ", DIALOG, "dialog"],
    ["入力が複数行", MULTI_LINE, "no_prompt"],
    ["シェルの画面", "user@host:~$ ls\nfile\nuser@host:~$ \n\n", "no_prompt"],
    ["末尾の空行が無い", screen([PROMPT], { blank: 0 }), "idle"],
  ];
  for (const [name, raw, expected] of cases) assert.equal(classifyScreen(raw), expected, name);
});

test("classifyScreen: 入力欄の形と dim の読み方", () => {
  // 入力欄が下から 8 行より上にある（フッターが長い）
  const tall = screen([PROMPT], { footer: [...FOOTER, ...Array(6).fill("footer")] });
  assert.equal(classifyScreen(tall), "no_prompt");
  // ❯ の後ろが U+00A0 でない
  assert.equal(classifyScreen(screen([`${sgr("39")}❯ text`])), "no_prompt");
  // 短い罫線は入力欄の枠とみなさない
  assert.equal(classifyScreen(screen([PROMPT]).replaceAll("─".repeat(80), "─".repeat(10))), "no_prompt");
  // dim は前の行から続き、22・0・空の SGR で戻る
  assert.equal(classifyScreen(screen([`${sgr("2")}❯${NBSP}候補`])), "idle");
  assert.equal(classifyScreen(screen([`${PROMPT}${sgr("2")}候補${sgr("22")}本文`])), "draft");
  assert.equal(classifyScreen(screen([`${PROMPT}${sgr("2")}候補${sgr("")}本文`])), "draft");
  // 2;37 のように混ざっていても dim。38;2;r;g;b の 2 は dim ではない
  assert.equal(classifyScreen(screen([`${PROMPT}${sgr("2;37")}候補`])), "idle");
  assert.equal(classifyScreen(screen([`${PROMPT}${sgr("38;2;2;2;2")}本文`])), "draft");
  assert.equal(classifyScreen(screen([`${PROMPT}${sgr("38;5;2")}本文`])), "draft");
  // 空白（U+00A0 を含む）だけなら空
  assert.equal(classifyScreen(screen([`${PROMPT}   ${NBSP}`])), "idle");
});

test("classifyPane: 画面を見る前の状態（gone・not_claude・copy_mode・owner_active）", () => {
  assert.equal(classifyPane({ pane: undefined }, EMPTY, EMPTY, NOW), "gone");
  assert.equal(classifyPane({ pane: pane({ dead: true }) }, EMPTY, EMPTY, NOW), "gone");
  assert.equal(classifyPane({ pane: pane({ currentCommand: "bash" }) }, EMPTY, EMPTY, NOW), "not_claude");
  assert.equal(classifyPane({ pane: pane({ inMode: true }) }, EMPTY, EMPTY, NOW), "copy_mode");
  assert.equal(classifyPane({ pane: pane(), lastClientActivityAt: NOW - OWNER_ACTIVE_MS + 1000 }, EMPTY, EMPTY, NOW), "owner_active");
  assert.equal(classifyPane({ pane: pane(), lastClientActivityAt: NOW - OWNER_ACTIVE_MS }, EMPTY, EMPTY, NOW), "idle");
  // シェルのペインは画面が入力欄に見えても not_claude
  assert.equal(classifyPane({ pane: pane({ currentCommand: "bash" }) }, EMPTY, undefined, NOW), "not_claude");
});

test("classifyPane: 2 回撮る。2 回目で変化があれば busy、2 回目が idle でなければその状態", () => {
  assert.equal(classifyPane(META, EMPTY, EMPTY, NOW), "idle");
  assert.equal(classifyPane(META, PLACEHOLDER, PLACEHOLDER, NOW), "idle");
  // 色だけ変わったものは変化とみなさない
  assert.equal(classifyPane(META, EMPTY, EMPTY.replaceAll(sgr("38;5;244"), sgr("38;5;245")), NOW), "idle");
  const ticking = screen([PROMPT], { above: [...HISTORY, "  ⎿  agent (12s)"] });
  assert.equal(classifyPane(META, ticking, ticking.replace("12s", "13s"), NOW), "busy");
  assert.equal(classifyPane(META, EMPTY, DRAFT, NOW), "draft");
  assert.equal(classifyPane(META, EMPTY, DIALOG, NOW), "dialog");
  // 1 回目が idle でなければ 2 回目は見ない
  assert.equal(classifyPane(META, DRAFT, EMPTY, NOW), "draft");
  // 2 回目が無ければ 1 回目だけ
  assert.equal(classifyPane(META, EMPTY, undefined, NOW), "idle");
});

/** 画面を順に返す偽の Tmux。captures の要素が undefined ならペインが無い（not_found） */
function fakeTmux(options: { panes?: TmuxResult<TmuxPane[]>; clients?: TmuxClient[]; captures: Array<string | undefined> }) {
  const calls: string[] = [];
  const captures = [...options.captures];
  const tmux: Tmux = {
    async listPanes() {
      calls.push("list-panes");
      return options.panes ?? { ok: true, value: [pane({ paneId: "%2", currentCommand: "bash" }), pane()] };
    },
    async listClients() {
      calls.push("list-clients");
      return { ok: true, value: options.clients ?? [] };
    },
    async capturePane(paneId) {
      calls.push(`capture ${paneId}`);
      const raw = captures.shift();
      return raw === undefined ? { ok: false, reason: "not_found" } : { ok: true, value: raw };
    },
    loadBuffer: () => assert.fail("送らない"),
    pasteBuffer: () => assert.fail("送らない"),
    sendEnter: () => assert.fail("送らない"),
  };
  return { tmux, calls };
}

test("probePaneState: idle なら 1.5 秒待って撮り直して確定する", async () => {
  const sleeps: number[] = [];
  const { tmux, calls } = fakeTmux({ captures: [EMPTY, EMPTY] });
  const result = await probePaneState({ tmux, paneId: "%1", now: () => NOW, sleep: async (ms) => void sleeps.push(ms) });
  assert.deepEqual(result, { ok: true, state: "idle" });
  assert.deepEqual(sleeps, [SECOND_CAPTURE_DELAY_MS]);
  assert.deepEqual(calls, ["list-panes", "list-clients", "capture %1", "list-panes", "list-clients", "capture %1"]);
});

test("probePaneState: 2 回目で変化があれば busy・2 回目が idle でなければその状態。1 回目が idle でなければ待たない", async () => {
  const ticking = screen([PROMPT], { above: [...HISTORY, "  ⎿  agent (12s)"] });
  const changed = fakeTmux({ captures: [ticking, ticking.replace("12s", "13s")] });
  assert.deepEqual(await probePaneState({ tmux: changed.tmux, paneId: "%1", now: () => NOW, sleep: async () => {} }), {
    ok: true,
    state: "busy",
  });
  const typed = fakeTmux({ captures: [EMPTY, DRAFT] });
  assert.deepEqual(await probePaneState({ tmux: typed.tmux, paneId: "%1", now: () => NOW, sleep: async () => {} }), {
    ok: true,
    state: "draft",
  });
  const sleeps: number[] = [];
  const busy = fakeTmux({ captures: [SPINNER] });
  const result = await probePaneState({ tmux: busy.tmux, paneId: "%1", now: () => NOW, sleep: async (ms) => void sleeps.push(ms) });
  assert.deepEqual(result, { ok: true, state: "busy" });
  assert.deepEqual(sleeps, []);
  assert.equal(busy.calls.filter((call) => call.startsWith("capture")).length, 1);
});

test("probePaneState: 撮らずに決まる状態・ペインが無い・サーバーが無い", async () => {
  const sleep = async (): Promise<void> => {};
  const shell = fakeTmux({ captures: [EMPTY] });
  assert.deepEqual(await probePaneState({ tmux: shell.tmux, paneId: "%2", now: () => NOW, sleep }), { ok: true, state: "not_claude" });
  assert.ok(!shell.calls.some((call) => call.startsWith("capture")));
  const missing = fakeTmux({ captures: [] });
  assert.deepEqual(await probePaneState({ tmux: missing.tmux, paneId: "%9", now: () => NOW, sleep }), { ok: true, state: "gone" });
  const vanished = fakeTmux({ captures: [EMPTY, undefined] });
  assert.deepEqual(await probePaneState({ tmux: vanished.tmux, paneId: "%1", now: () => NOW, sleep }), { ok: true, state: "gone" });
  const typing = fakeTmux({ captures: [EMPTY], clients: [{ sessionName: "work", activityAt: NOW - 5000 }, { sessionName: "other", activityAt: NOW }] });
  assert.deepEqual(await probePaneState({ tmux: typing.tmux, paneId: "%1", now: () => NOW, sleep }), { ok: true, state: "owner_active" });
  const elsewhere = fakeTmux({ captures: [EMPTY, EMPTY], clients: [{ sessionName: "other", activityAt: NOW }] });
  assert.deepEqual(await probePaneState({ tmux: elsewhere.tmux, paneId: "%1", now: () => NOW, sleep }), { ok: true, state: "idle" });
  const noServer = fakeTmux({ panes: { ok: false, reason: "no_server" }, captures: [] });
  assert.deepEqual(await probePaneState({ tmux: noServer.tmux, paneId: "%1", now: () => NOW, sleep }), { ok: false, reason: "no_server" });
});
