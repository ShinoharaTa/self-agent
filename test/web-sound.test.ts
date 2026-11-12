import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

// 画面の音（src/web/static/sound.js の SA.sound.pure。docs/plan/web-ui-sound.md §9）。AudioContext は置かず、純関数だけを見る
type Voice = { t: number; kind: string; f?: number; fc?: number; wave?: string; a?: number; d: number; g: number; drop?: number; glideTo?: number; lp?: number };
type Pattern = { name: string; voices: Voice[] } | null;
type Ev = { event: string; channelId?: string; sessionId?: string; depth?: Record<string, unknown> };
type Mem = unknown;
type Pure = {
  THEMES: Record<string, { label: string; base: number; gain: number; tone: Record<string, unknown>; tick: Record<string, unknown> }>;
  DEFAULTS: Record<string, unknown>;
  VOICE_MAX_S: number;
  EVENT_IDS: string[];
  normalizeSettings: (raw: unknown) => Record<string, unknown>;
  parseSettings: (text: unknown) => Record<string, unknown>;
  serializeSettings: (s: unknown) => string;
  semitonesOf: (n: number) => number;
  normalizeCombo: (raw: unknown) => Record<string, string>;
  pattern: (event: string, depth: Record<string, unknown>, themeId?: string) => Pattern;
  createMemory: () => Mem;
  decideRunning: (detail: unknown, mem: Mem, now: number, front?: string | null) => Ev[];
  expireEnds: (mem: Mem, now: number) => Ev[];
  noteAborted: (mem: Mem, channelId: string, now: number) => void;
  decideTurns: (detail: unknown, mem: Mem, now: number) => Ev[];
  decideCc: (detail: unknown, mem: Mem, now: number) => Ev[];
  filterEvents: (events: Ev[], settings: unknown, view: unknown) => Ev[];
  createPacer: () => unknown;
  coalesce: (events: Ev[], pacer: unknown, now: number) => Ev | null;
  notePlayed: (pacer: unknown, ev: Ev, now: number) => void;
};

function loadSound(): Pure {
  const document = { visibilityState: "visible", addEventListener() {}, removeEventListener() {} };
  const context = { window: {} as Record<string, unknown>, document, Math, JSON, Date, Object, Map, Set, setTimeout };
  vm.runInNewContext(readFileSync(fileURLToPath(new URL("../src/web/static/sound.js", import.meta.url)), "utf8"), context);
  return (context.window as { SA: { sound: { pure: Pure } } }).SA.sound.pure;
}

const pure = loadSound();
// vm の中で作ったものは別の realm なので、JSON で通してから比べる
const plain = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;
const events = (list: Ev[]): string[] => plain(list).map((e) => e.event);

const run = (channelId: string, turnSeq: number, toolCalls = 0, extra: Record<string, unknown> = {}) => ({
  channelId,
  turnSeq,
  toolCalls,
  elapsedMs: 1000,
  label: "読んでいます",
  steps: [],
  ...extra,
});

const RELAY = { start: "relay", tick: "relay", ask: "relay", reply: "relay", fail: "relay" };

test("sound: 既定はオフ・音量 中・手順の音オン・すべての会話・判断待ちはいつも・組み合わせは全部 接点", () => {
  assert.deepEqual(plain(pure.normalizeSettings(null)), { enabled: false, volume: "mid", combo: RELAY, ticks: true, scope: "all", askAlways: true });
  assert.equal(pure.THEMES.relay?.label, "接点");
  assert.deepEqual(Object.keys(pure.THEMES), ["relay", "wood", "drop", "glass", "felt"]);
});

test("sound: 設定の読み書き。形の違う JSON・値・無い id は既定に戻す", () => {
  const s = { enabled: true, volume: "high", combo: { start: "wood", tick: "felt", ask: "glass", reply: "drop", fail: "relay" }, ticks: false, scope: "front", askAlways: false };
  assert.deepEqual(plain(pure.parseSettings(pure.serializeSettings(s))), s);
  const def = plain(pure.normalizeSettings(null));
  for (const text of [null, "", "{", "[]", "1", '"x"', "null"]) assert.deepEqual(plain(pure.parseSettings(text)), def, String(text));
  assert.deepEqual(plain(pure.parseSettings('{"enabled":"yes","volume":"loud","combo":"wood","scope":1,"ticks":0}')), def);
  assert.deepEqual(plain(pure.parseSettings('{"enabled":true}')), { ...def, enabled: true });
  // 組み合わせは事象ごと: 無い id・形の違う値はその事象だけ既定
  assert.deepEqual(plain(pure.normalizeCombo({ start: "wood", tick: "nope", ask: 3, reply: "__proto__", extra: "felt" })), { ...RELAY, start: "wood" });
  assert.deepEqual(plain(pure.normalizeCombo([])), RELAY);
});

test("sound: 全テーマが形を持ち、全事象の 1 音の長さと gain が上限の中", () => {
  const depths = [
    {},
    { toolCalls: 3, count: 1 },
    { toolCalls: 8, count: 3, command: true },
    { toolCalls: 20 },
    { cc: true },
  ];
  for (const themeId of Object.keys(pure.THEMES)) {
    const theme = pure.THEMES[themeId]!;
    assert.equal(typeof theme.label, "string", themeId);
    assert.ok(theme.base > 0 && theme.gain > 0 && theme.gain <= 1, themeId);
    assert.ok(typeof theme.tone.d === "number" && typeof theme.tone.a === "number", themeId);
    assert.ok(typeof theme.tick.d === "number", themeId);
    for (const event of pure.EVENT_IDS) {
      for (const depth of depths) {
        const p = plain(pure.pattern(event, depth, themeId));
        assert.ok(p && p.voices.length > 0, `${themeId} ${event}`);
        for (const v of p.voices) {
          assert.ok(v.kind === "osc" || v.kind === "noise", `${themeId} ${event} kind`);
          const len = (v.a ?? 0.001) + v.d;
          assert.ok(v.d > 0 && len <= pure.VOICE_MAX_S, `${themeId} ${event} len=${len}`);
          assert.ok(v.g > 0 && v.g <= 1, `${themeId} ${event} g=${v.g}`);
          assert.ok(v.t >= 0 && v.t < 1, `${themeId} ${event} t`);
          if (v.kind === "osc") assert.ok((v.f ?? 0) > 20 && (v.f ?? 0) < 20000, `${themeId} ${event} f`);
        }
      }
    }
  }
});

test("sound: pattern は試聴ページと同じ組み立て（深さは移調だけ）", () => {
  assert.equal(pure.semitonesOf(0), 0);
  assert.equal(pure.semitonesOf(1), 0);
  assert.equal(pure.semitonesOf(2), -2);
  assert.equal(pure.semitonesOf(6), -5);
  assert.equal(pure.semitonesOf(16), -7);
  const pat = (event: string, depth: Record<string, unknown>, theme = "relay") => plain(pure.pattern(event, depth, theme))!;
  const mains = (p: { voices: Voice[] }) => p.voices.filter((v) => v.kind === "osc");
  // 接点の start: 880 Hz から 3 半音上へ滑る 1 音
  const start = pat("start", {});
  assert.equal(start.voices.length, 1);
  assert.equal(start.voices[0]!.f, 880);
  assert.ok(Math.abs(start.voices[0]!.glideTo! - 880 * 2 ** (3 / 12)) < 1e-9);
  // 水滴は滑らず落ちる（drop）
  assert.equal(pat("start", {}, "drop").voices[0]!.drop, 12);
  assert.equal(pat("start", {}, "drop").voices[0]!.glideTo, undefined);
  // 木は倍音を足す
  assert.equal(pat("start", {}, "wood").voices.length, 3);
  // ask「ぽぴぽぴん」: 基準・+7・基準・+7 を 0.09 秒おき、最後だけ 0.3 秒で +9 へ滑る
  const ask = mains(pat("ask", {}));
  assert.equal(ask.length, 4);
  assert.deepEqual(ask.map((v) => v.t), [0, 0.09, 0.18, 0.27]);
  assert.deepEqual(ask.map((v) => v.d), [0.07, 0.07, 0.07, 0.3]);
  assert.ok(Math.abs(ask[1]!.f! - 880 * 2 ** (7 / 12)) < 1e-9);
  assert.equal(ask[2]!.f, 880);
  assert.ok(Math.abs(ask[3]!.glideTo! - 880 * 2 ** (9 / 12)) < 1e-9);
  assert.equal(mains(pat("ask", {}, "drop"))[3]!.glideTo, undefined);
  // reply「ピポパッ」: 基準・+4・+7 の 3 音を 0.085 秒おき。深さ・Claude Code・長いターンでも 3 音で余韻は無い
  for (const depth of [{ toolCalls: 0 }, { toolCalls: 10 }, { cc: true }, { toolCalls: 0, elapsedMs: 400000 }]) {
    const r = mains(pat("reply", depth));
    assert.equal(r.length, 3);
    assert.deepEqual(r.map((v) => v.t), [0, 0.085, 0.17]);
    assert.deepEqual(r.map((v) => v.d), [0.07, 0.07, 0.06]);
  }
  const reply = mains(pat("reply", { toolCalls: 0 }));
  assert.ok(Math.abs(reply[1]!.f! - 880 * 2 ** (4 / 12)) < 1e-9);
  assert.ok(Math.abs(reply[2]!.f! - 880 * 2 ** (7 / 12)) < 1e-9);
  assert.ok(Math.abs(reply[2]!.g - 0.8 * 0.8) < 1e-9);
  assert.ok(Math.abs(reply[0]!.g - 0.65 * 0.8) < 1e-9);
  // 移調: 16 手順なら 7 半音下
  const deep = mains(pat("reply", { toolCalls: 16 }))[0]!.f!;
  assert.ok(Math.abs(deep - 880 * 2 ** (-7 / 12)) < 1e-9);
  // tick: 増分 2 以上は「ここっ」、コマンドは 0.67 倍、フェルトは雑音だけ
  assert.equal(pat("tick", { count: 1 }).voices.length, 2);
  assert.equal(pat("tick", { count: 3 }).voices.length, 4);
  assert.ok(Math.abs(pat("tick", { count: 1, command: true }).voices[0]!.f! - 1800 * 0.67) < 1e-9);
  assert.deepEqual(pat("tick", { count: 1 }, "felt").voices.map((v) => v.kind), ["noise"]);
  // fail: 基準の 14 半音下の三角波（深さで移調しない）
  const fail = pat("fail", { toolCalls: 20 }).voices[0]!;
  assert.equal(fail.wave, "triangle");
  assert.ok(Math.abs(fail.f! - 880 * 2 ** (-14 / 12)) < 1e-9);
  // 知らないテーマは既定（接点）、知らない事象は null
  assert.deepEqual(pat("start", {}, "nope"), pat("start", {}, "relay"));
  assert.equal(pure.pattern("nope", {}, "relay"), null);
});

test("sound: decideRunning は始まり・手順・判断待ち・終わりを出し、追いつきでは判断待ちだけ", () => {
  const mem = pure.createMemory();
  assert.deepEqual(events(pure.decideRunning({ prev: [], next: [run("a", 1)], catchUp: false }, mem, 0)), ["start"]);
  const tick = plain(pure.decideRunning({ prev: [run("a", 1)], next: [run("a", 1, 2, { label: "コマンドを実行しています" })], catchUp: false }, mem, 1000));
  assert.deepEqual(tick.map((e) => e.event), ["tick"]);
  assert.equal(tick[0]!.depth!.count, 2);
  assert.equal(tick[0]!.depth!.command, true);
  const reply = plain(pure.decideRunning({ prev: [run("a", 1, 7, { elapsedMs: 90000 })], next: [], catchUp: false }, mem, 2000));
  assert.deepEqual(reply, [{ event: "reply", channelId: "a", depth: { toolCalls: 7 } }]);
  // 同じチャンネルで次のターン: 前の返事と次の始まり
  assert.deepEqual(events(pure.decideRunning({ prev: [run("a", 1)], next: [run("a", 2)], catchUp: false }, mem, 3000)), ["reply", "start"]);
  // 判断待ち（waitingPermission）は無 → 有で 1 回だけ。描き直し（同じ結果）では鳴り直さない
  const waiting = run("b", 5, 1, { waitingPermission: { toolName: "Bash", since: "2026-11-12T00:00:00Z" } });
  assert.deepEqual(events(pure.decideRunning({ prev: [run("b", 5, 1)], next: [waiting], catchUp: false }, mem, 4000)), ["ask"]);
  assert.deepEqual(events(pure.decideRunning({ prev: [waiting], next: [waiting], catchUp: false }, mem, 6000)), []);
  // 追いつき: 始まり・終わりは鳴らさず、その時点の判断待ちだけ
  const mem2 = pure.createMemory();
  assert.deepEqual(events(pure.decideRunning({ prev: [run("x", 1)], next: [run("y", 1), waiting], catchUp: true }, mem2, 0)), ["ask"]);
});

test("sound: Web から送ったチャンネルの次の start は 10 秒抑える", () => {
  const mem = pure.createMemory() as { sentAt: Map<string, number> };
  mem.sentAt.set("a", 0);
  assert.deepEqual(events(pure.decideRunning({ prev: [], next: [run("a", 1)], catchUp: false }, mem, 9000)), []);
  assert.deepEqual(events(pure.decideRunning({ prev: [], next: [run("a", 2)], catchUp: false }, mem, 11000)), ["start"]);
});

test("sound: decideTurns は許可の要求・/close の確認を出し、待っていない終わり方の行では鳴らさない", () => {
  const mem = pure.createMemory();
  const ch = { id: "a", kind: "session", permission: null, closeDraft: null };
  // 前に出ていない会話はすぐ返事にしているので、後から来た行の失敗・手順の上限では鳴らさない（2 回鳴らさない）
  assert.deepEqual(events(pure.decideTurns({ channelId: "a", rows: [{ id: 1, kind: "agent", outcome: "failed" }], before: ch, after: ch, catchUp: false }, mem, 0)), []);
  assert.deepEqual(events(pure.decideTurns({ channelId: "a", rows: [{ id: 4, kind: "agent", outcome: "max_turns" }], before: ch, after: ch, catchUp: false }, mem, 3000)), []);
  // 許可の要求は id で 1 回（追いつきでも保留中なら鳴らす）
  const asking = { ...ch, permission: { id: 9, state: "pending" } };
  assert.deepEqual(events(pure.decideTurns({ channelId: "a", rows: [], before: ch, after: asking, catchUp: true }, mem, 60000)), ["ask"]);
  assert.deepEqual(events(pure.decideTurns({ channelId: "a", rows: [], before: asking, after: asking, catchUp: false }, mem, 90000)), []);
  // /close の確認: 出たら 1 回、消えてまた出たらもう 1 回
  const drafting = { ...ch, closeDraft: { summary: "", tasks: [] } };
  assert.deepEqual(events(pure.decideTurns({ channelId: "a", rows: [], before: ch, after: drafting, catchUp: false }, mem, 120000)), ["ask"]);
  assert.deepEqual(events(pure.decideTurns({ channelId: "a", rows: [], before: drafting, after: drafting, catchUp: false }, mem, 150000)), []);
  pure.decideTurns({ channelId: "a", rows: [], before: drafting, after: ch, catchUp: false }, mem, 160000);
  assert.deepEqual(events(pure.decideTurns({ channelId: "a", rows: [], before: ch, after: drafting, catchUp: false }, mem, 200000)), ["ask"]);
});

test("sound: 前に出ている会話の終わりは /turns の行の outcome で決め、3 秒で来なければ返事", () => {
  const ch = { id: "a", kind: "session", permission: null, closeDraft: null };
  const ended = (mem: Mem, now: number) => events(pure.decideRunning({ prev: [run("a", 1, 3)], next: [], catchUp: false }, mem, now, "a"));
  const rowOf = (mem: Mem, outcome: string, now: number, id = 1) =>
    plain(pure.decideTurns({ channelId: "a", rows: [{ id, kind: "agent", outcome }], before: ch, after: ch, catchUp: false }, mem, now));
  for (const [outcome, want] of [["done", ["reply"]], ["max_turns", ["ask"]], ["aborted", []], ["failed", ["fail"]]] as const) {
    const mem = pure.createMemory();
    assert.deepEqual(ended(mem, 0), [], outcome);
    const got = rowOf(mem, outcome, 1000);
    assert.deepEqual(got.map((e) => e.event), [...want], outcome);
    if (outcome === "done") assert.deepEqual(got[0]!.depth, { toolCalls: 3 });
    // 決めた後は待たない
    assert.deepEqual(events(pure.expireEnds(mem, 10000)), [], outcome);
  }
  // 3 秒で行が来なければ返事。来た後の行では鳴らさない
  const mem = pure.createMemory();
  ended(mem, 0);
  assert.deepEqual(events(pure.expireEnds(mem, 2999)), []);
  assert.deepEqual(plain(pure.expireEnds(mem, 3000)), [{ event: "reply", channelId: "a", depth: { toolCalls: 3 } }]);
  assert.deepEqual(rowOf(mem, "failed", 3500), []);
  // 前に出ていない会話はすぐ返事
  assert.deepEqual(events(pure.decideRunning({ prev: [run("b", 1)], next: [], catchUp: false }, pure.createMemory(), 0, "a")), ["reply"]);
});

test("sound: Web で中断したチャンネルの次の終わりは鳴らさない（その次は鳴らす）", () => {
  const mem = pure.createMemory();
  pure.noteAborted(mem, "b", 0);
  assert.deepEqual(events(pure.decideRunning({ prev: [run("b", 1)], next: [], catchUp: false }, mem, 2000)), []);
  assert.deepEqual(events(pure.decideRunning({ prev: [run("b", 2)], next: [], catchUp: false }, mem, 9000)), ["reply"]);
  // 前に出ている会話でも待たない
  pure.noteAborted(mem, "a", 10000);
  assert.deepEqual(events(pure.decideRunning({ prev: [run("a", 3)], next: [], catchUp: false }, mem, 11000, "a")), []);
  assert.deepEqual(events(pure.expireEnds(mem, 20000)), []);
});

test("sound: 同じ許可の要求を /api/running と /turns の両方から鳴らさない（どちらが先でも）", () => {
  const ch = (permission: unknown) => ({ id: "a", kind: "session", permission, closeDraft: null });
  const waiting = run("a", 1, 0, { waitingPermission: { toolName: "Bash", since: "s1" } });
  const turns = (mem: Mem, permission: unknown, now: number) => events(pure.decideTurns({ channelId: "a", rows: [], before: null, after: ch(permission), catchUp: false }, mem, now));
  // running が先: waitingPermission が消えるまで /turns の pending では鳴らさない（15 秒を過ぎても）
  const mem = pure.createMemory();
  assert.deepEqual(events(pure.decideRunning({ prev: [run("a", 1)], next: [waiting], catchUp: false }, mem, 0)), ["ask"]);
  assert.deepEqual(turns(mem, { id: 3, state: "pending" }, 30000), []);
  // 答えて消えた後の次の要求は鳴る
  pure.decideRunning({ prev: [waiting], next: [run("a", 1)], catchUp: false }, mem, 40000);
  turns(mem, { id: 3, state: "allowed" }, 41000);
  const waiting2 = run("a", 1, 0, { waitingPermission: { toolName: "Bash", since: "s2" } });
  assert.deepEqual(events(pure.decideRunning({ prev: [run("a", 1)], next: [waiting2], catchUp: false }, mem, 42000)), ["ask"]);
  // /turns が先: running 側では鳴らさない
  const mem2 = pure.createMemory();
  assert.deepEqual(turns(mem2, { id: 5, state: "pending" }, 0), ["ask"]);
  assert.deepEqual(events(pure.decideRunning({ prev: [run("a", 1)], next: [waiting], catchUp: false }, mem2, 30000)), []);
});

test("sound: 15 秒の抑えは別の経路だけ。答えた判断待ちは抑えを消し、抑えたときは時刻を進めない", () => {
  const s = (state: string, extra: Record<string, unknown> = {}) => ({ sessionId: "s1", state, since: "t0", permission: null, pending: null, channel: null, ...extra });
  const list = (...sessions: unknown[]) => ({ sessions, starting: [], stale: false, unreadable: false });
  // 一覧の判断待ち（ccwait）を鳴らした直後の許可の要求（別の経路）は 15 秒の中なら鳴らさない
  const mem = pure.createMemory();
  assert.deepEqual(events(pure.decideCc({ prev: list(s("running")), next: list(s("needs_input", { since: "t1" })), catchUp: false }, mem, 0)), ["ask"]);
  assert.deepEqual(
    events(pure.decideCc({ prev: list(s("needs_input", { since: "t1" })), next: list(s("needs_input", { since: "t1", permission: { id: 1, state: "pending" } })), catchUp: false }, mem, 5000)),
    [],
  );
  // 抑えたときは時刻を進めないので、最初の 15 秒が過ぎれば別の新しい要求は鳴る
  assert.deepEqual(
    events(pure.decideCc({ prev: list(s("needs_input", { since: "t1" })), next: list(s("needs_input", { since: "t1", permission: { id: 2, state: "pending" } })), catchUp: false }, mem, 16000)),
    ["ask"],
  );
  // 答えた（判断待ちが消えた）ら抑えを消すので、すぐの次の判断待ちも鳴る
  const mem2 = pure.createMemory();
  pure.decideCc({ prev: list(s("running")), next: list(s("needs_input", { since: "t1" })), catchUp: false }, mem2, 0);
  pure.decideCc({ prev: list(s("needs_input", { since: "t1" })), next: list(s("running")), catchUp: false }, mem2, 2000);
  assert.deepEqual(events(pure.decideCc({ prev: list(s("running")), next: list(s("running", { permission: { id: 3, state: "pending" } })), catchUp: false }, mem2, 4000)), ["ask"]);
  // 同じ経路の別の判断待ちは抑えない
  const ch = { id: "a", kind: "session", permission: null, closeDraft: null };
  const mem3 = pure.createMemory();
  assert.deepEqual(events(pure.decideTurns({ channelId: "a", rows: [], before: null, after: { ...ch, permission: { id: 7, state: "pending" } }, catchUp: false }, mem3, 0)), ["ask"]);
  assert.deepEqual(events(pure.decideTurns({ channelId: "a", rows: [], before: null, after: { ...ch, permission: { id: 8, state: "pending" } }, catchUp: false }, mem3, 1000)), ["ask"]);
});

test("sound: Claude Code の受け付けは同じセッションで 10 秒に 1 回", () => {
  const mem = pure.createMemory();
  const s = (state: string, pending: unknown = null) => ({ sessionId: "s1", state, since: "t0", permission: null, pending, channel: null });
  const list = (...sessions: unknown[]) => ({ sessions, starting: [], stale: false, unreadable: false });
  assert.deepEqual(events(pure.decideCc({ prev: list(s("idle", { id: 1, state: "queued" })), next: list(s("idle", { id: 1, state: "delivered" })), catchUp: false }, mem, 0)), ["start"]);
  assert.deepEqual(events(pure.decideCc({ prev: list(s("idle")), next: list(s("running")), catchUp: false }, mem, 3000)), []);
  assert.deepEqual(events(pure.decideCc({ prev: list(s("idle")), next: list(s("running")), catchUp: false }, mem, 11000)), ["start"]);
});

test("sound: api.js の会話の追いつきはチャンネルごとで、最初の読み取りでも印を消す", () => {
  const js = readFileSync(fileURLToPath(new URL("../src/web/static/api.js", import.meta.url)), "utf8");
  const body = /store\.load\.turns = \(channelId, opts\) =>[\s\S]*?\n {4}\}\);/.exec(js)?.[0] ?? "";
  assert.match(body, /const caught = !turnsCaughtUp\.has\(channelId\);/);
  assert.match(body, /catchUp: caught/);
  // 最初の読み取り（if）と増分（else）の後、try の中で印を消す
  assert.match(body, /\n {8}\}\n {8}turnsCaughtUp\.add\(channelId\);/);
  assert.match(js, /turnsCaughtUp\.clear\(\);/);
});

test("sound: decideTurns の Claude Code のチャンネルは agent の行で返事（同じセッションで 15 秒に 1 回）", () => {
  const mem = pure.createMemory();
  const ch = { id: "c", kind: "cc", cc: { sessionId: "s1", permission: null } };
  const row = (id: number) => ({ channelId: "c", rows: [{ id, kind: "agent", outcome: "done" }], before: ch, after: ch, catchUp: false });
  const first = plain(pure.decideTurns(row(1), mem, 0));
  assert.deepEqual(first, [{ event: "reply", channelId: "c", sessionId: "s1", depth: { cc: true } }]);
  assert.deepEqual(events(pure.decideTurns(row(2), mem, 10000)), []);
  assert.deepEqual(events(pure.decideTurns(row(3), mem, 16000)), ["reply"]);
});

test("sound: decideCc は running の始まり・返事・判断待ち・送れなかったを出す", () => {
  const mem = pure.createMemory();
  const s = (state: string, extra: Record<string, unknown> = {}) => ({ sessionId: "s1", state, since: "t0", permission: null, pending: null, channel: null, ...extra });
  const list = (...sessions: unknown[]) => ({ sessions, starting: [], stale: false, unreadable: false });
  assert.deepEqual(events(pure.decideCc({ prev: list(s("idle")), next: list(s("running")), catchUp: false }, mem, 0)), ["start"]);
  assert.deepEqual(events(pure.decideCc({ prev: list(s("running")), next: list(s("idle")), catchUp: false }, mem, 1000)), ["reply"]);
  // チャンネルの agent の行と 15 秒の中で重ねない
  const ch = { id: "c", kind: "cc", cc: { sessionId: "s1", permission: null } };
  assert.deepEqual(events(pure.decideTurns({ channelId: "c", rows: [{ id: 1, kind: "agent" }], before: ch, after: ch, catchUp: false }, mem, 5000)), []);
  // 判断待ち: sessionId + since で 1 回
  assert.deepEqual(events(pure.decideCc({ prev: list(s("idle")), next: list(s("needs_input", { since: "t1" })), catchUp: false }, mem, 30000)), ["ask"]);
  assert.deepEqual(events(pure.decideCc({ prev: list(s("needs_input", { since: "t1" })), next: list(s("needs_input", { since: "t1" })), catchUp: false }, mem, 60000)), []);
  // 届けた（delivered）は始まり、failed・gave_up は失敗
  assert.deepEqual(
    events(pure.decideCc({ prev: list(s("idle", { pending: { id: 1, state: "queued" } })), next: list(s("idle", { pending: { id: 1, state: "delivered" } })), catchUp: false }, mem, 90000)),
    ["start"],
  );
  assert.deepEqual(
    events(pure.decideCc({ prev: list(s("idle", { pending: { id: 2, state: "queued" } })), next: list(s("idle", { pending: { id: 2, state: "gave_up" } })), catchUp: false }, mem, 120000)),
    ["fail"],
  );
  // 許可の要求（質問も同じ）は id で 1 回。追いつきでも保留中なら鳴らす
  const mem2 = pure.createMemory();
  const asking = s("running", { permission: { id: 7, state: "pending" } });
  assert.deepEqual(events(pure.decideCc({ prev: null, next: list(asking), catchUp: true }, mem2, 0)), ["ask"]);
  assert.deepEqual(events(pure.decideCc({ prev: list(asking), next: list(asking), catchUp: false }, mem2, 30000)), []);
  // 追いつきでは start・reply を鳴らさない
  assert.deepEqual(events(pure.decideCc({ prev: list(s("running")), next: list(s("idle")), catchUp: true }, mem2, 60000)), []);
  // Web から送ったチャンネルのセッションの start は抑える
  const mem3 = pure.createMemory() as { sentAt: Map<string, number> };
  mem3.sentAt.set("c", 0);
  const withCh = (state: string) => s(state, { channel: { channelId: "c" } });
  assert.deepEqual(events(pure.decideCc({ prev: list(withCh("idle")), next: list(withCh("running")), catchUp: false }, mem3, 5000)), []);
  // cc のタブから送った（"cc:" + sessionId）セッションの start も 10 秒抑える
  const mem4 = pure.createMemory() as { sentAt: Map<string, number> };
  mem4.sentAt.set("cc:s1", 0);
  assert.deepEqual(events(pure.decideCc({ prev: list(s("idle")), next: list(s("running")), catchUp: false }, mem4, 5000)), []);
  assert.deepEqual(events(pure.decideCc({ prev: list(s("idle")), next: list(s("running")), catchUp: false }, mem4, 11000)), ["start"]);
});

test("sound: filterEvents は手順を前に出ている会話だけ・隠れていれば鳴らさず、鳴らす会話と判断待ちの設定に従う", () => {
  const evs: Ev[] = [
    { event: "tick", channelId: "a" },
    { event: "tick", channelId: "b" },
    { event: "start", channelId: "b" },
    { event: "ask", channelId: "b" },
    { event: "reply", sessionId: "s1" },
  ];
  const view = { frontChannelId: "a", frontSessionId: null, hidden: false };
  const all = pure.normalizeSettings(null);
  assert.deepEqual(plain(pure.filterEvents(evs, all, view)).map((e) => e.event + (e.channelId || e.sessionId)), ["ticka", "startb", "askb", "replys1"]);
  assert.deepEqual(events(pure.filterEvents(evs, all, { ...view, hidden: true })), ["start", "ask", "reply"]);
  assert.deepEqual(events(pure.filterEvents(evs, { ...all, ticks: false }, view)), ["start", "ask", "reply"]);
  assert.deepEqual(events(pure.filterEvents(evs, { ...all, scope: "front" }, view)), ["tick", "ask"]);
  assert.deepEqual(events(pure.filterEvents(evs, { ...all, scope: "front", askAlways: false }, view)), ["tick"]);
  assert.deepEqual(events(pure.filterEvents(evs, { ...all, scope: "front" }, { ...view, frontSessionId: "s1" })), ["tick", "ask", "reply"]);
});

test("sound: coalesce は優先の高い 1 つを選び、250 ms の間隔・10 秒に 6 回・返事の直後の start で落とす", () => {
  const pick = (list: Ev[], pacer: unknown, now: number) => {
    const ev = pure.coalesce(list, pacer, now);
    if (ev) pure.notePlayed(pacer, ev, now);
    return ev ? plain(ev).event : null;
  };
  const p = pure.createPacer();
  assert.equal(pick([{ event: "tick" }, { event: "start" }, { event: "ask" }, { event: "reply" }, { event: "fail" }], p, 0), "ask");
  assert.equal(pick([{ event: "reply" }, { event: "start" }], p, 1000), "reply");
  // 返事の 1 秒以内の start は鳴らさない
  assert.equal(pick([{ event: "start" }], p, 1500), null);
  assert.equal(pick([{ event: "start" }], p, 2100), "start");
  // 250 ms 以内は同じか低い優先なら捨て、高ければ鳴らす
  assert.equal(pick([{ event: "start" }], p, 2200), null);
  assert.equal(pick([{ event: "fail" }], p, 2250), "fail");
  assert.equal(pick([], p, 5000), null);
  // 10 秒に 6 回を超えたら tick から落とす
  const q = pure.createPacer();
  for (let i = 0; i < 6; i++) assert.equal(pick([{ event: "tick" }], q, i * 1000), "tick");
  assert.equal(pick([{ event: "tick" }], q, 6000), null);
  assert.equal(pick([{ event: "reply" }], q, 6000), "reply");
  assert.equal(pick([{ event: "tick" }], q, 16500), "tick");
});
