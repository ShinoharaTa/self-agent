// 音（docs/plan/web-ui-sound.md。#335）: エージェントの状態の変化（受け付けた・手順・判断待ち・返事・失敗）を短い音で知らせる。
// api.js・chat.js が SA.events に出す running・turns・cc・sent を受けて、鳴らす事象を純関数（SA.sound.pure）で決め、Web Audio で合成して鳴らす。
// 設定はこのブラウザの localStorage（self-agent-web:sound）だけ。既定はオフで、オンにする操作か画面の操作で AudioContext を作る
"use strict";

(function () {
  const SA = (window.SA = window.SA || {});

  const STORAGE_KEY = "self-agent-web:sound";
  /** マスターの gain（§4 の 5）= 0.3 × 音量の段 */
  const MASTER_GAIN = 0.3;
  const VOLUMES = { low: 0.35, mid: 0.6, high: 1.0 };
  const SCOPES = ["front", "all"];
  const DEFAULTS = { enabled: false, volume: "mid", theme: "relay", ticks: true, scope: "all", askAlways: true };
  /** 手順の label がこれならコマンド（低いこっ。src/agent/sdk-runner.ts の固定の語） */
  const COMMAND_LABEL = "コマンドを実行しています";
  /** §4 の規則 */
  const PRIORITY = { ask: 5, fail: 4, reply: 3, start: 2, tick: 1 };
  const MIN_GAP_MS = 250;
  const RATE_WINDOW_MS = 10000;
  const RATE_MAX = 6;
  const START_AFTER_REPLY_MS = 1000;
  /** Web から送った（202 で鳴らした）チャンネルの次の start を抑える時間 */
  const SENT_SUPPRESS_MS = 10000;
  /** Claude Code の返事（一覧の running → idle と、チャンネルの agent の行）を同じセッションで 1 回にまとめる時間 */
  const CC_REPLY_DEDUPE_MS = 15000;
  /** 同じ会話（セッション）の判断待ちを、別の経路（/api/running と /turns、一覧の判断待ちと許可の要求）で続けて鳴らさない時間 */
  const ASK_SAME_TARGET_MS = 15000;
  /** 覚えておく判断待ちの数（このタブのメモリ。超えたら古いものから忘れる） */
  const ASKED_MAX = 500;
  /** visible に戻ったときの resume がこれで settle しなければ作り直す */
  const RESUME_SETTLE_MS = 1000;
  /** 1 音の長さの上限（秒）。ask は 0.4、reply の最後の音だけ 300 秒超で 0.35（§4 の 6・§5） */
  const VOICE_MAX_S = 0.25;
  const ASK_VOICE_MAX_S = 0.4;
  const LONG_DECAY_MAX_S = 0.35;

  // ===== 音の種類（テーマ）。値は §6.2。表に足せば増やせる =====
  // Voice = { t: 開始（秒）, kind: "tone", f0, f1?（t+a までに滑る先）, a: 立ち上がり, d: 長さ（立ち上がりを含む）, g: 0〜1, wave? }
  //       | { t, kind: "tick", f, d, g, noise?: { fc, q, d, g } }
  // tick・tickDouble は normal（ふつうの手順）と command（コマンドの手順）。reply は notes の先頭から深さの数（2〜4）を使い、
  // 最後の音の長さを lastDecay（300 秒超は longDecay）に、60 秒超なら tail を最後の音の gap 秒後に足す
  const RELAY_TICK = { t: 0, kind: "tick", f: 1800, d: 0.018, g: 0.9, noise: { fc: 2500, q: 4, d: 0.012, g: 0.4 } };
  const RELAY_TICK_COMMAND = Object.assign({}, RELAY_TICK, { f: 1200 });
  const RELAY_PO = { t: 0, kind: "tone", f0: 740, f1: 880, a: 0.008, d: 0.12, g: 0.8 };
  const RELAY_PIN = { t: 0, kind: "tone", f0: 1175, f1: 1109, a: 0.005, d: 0.22, g: 0.7 };
  const THEMES = {
    relay: {
      label: "接点",
      events: {
        start: [RELAY_PO],
        tick: { normal: [RELAY_TICK], command: [RELAY_TICK_COMMAND] },
        tickDouble: {
          normal: [RELAY_TICK, Object.assign({}, RELAY_TICK, { t: 0.07 })],
          command: [RELAY_TICK_COMMAND, Object.assign({}, RELAY_TICK_COMMAND, { t: 0.07 })],
        },
        // ぽ（t 0）+ ぴん（t 0.11。上がって止まる）
        ask: [RELAY_PO, Object.assign({}, RELAY_PIN, { t: 0.11, f1: 1245, d: 0.3 })],
        reply: {
          notes: [
            RELAY_PIN,
            { t: 0.1, kind: "tone", f0: 880, f1: 740, a: 0.008, d: 0.12, g: 0.8 },
            { t: 0.2, kind: "tone", f0: 659, a: 0.008, d: 0.12, g: 0.8 },
            { t: 0.3, kind: "tone", f0: 554, a: 0.008, d: 0.12, g: 0.8 },
          ],
          lastDecay: 0.25,
          longDecay: 0.35,
          tail: { gap: 0.1, voice: { t: 0, kind: "tone", f0: 370, a: 0.008, d: 0.25, g: 0.6 } },
        },
        fail: [{ t: 0, kind: "tone", f0: 220, a: 0.01, d: 0.2, g: 0.6, wave: "triangle" }],
      },
    },
  };
  const THEME_IDS = Object.keys(THEMES);

  // ===== 純関数 =====
  /** 設定の形を整える。形の違うもの（オブジェクトでない・値が違う）は既定 */
  function normalizeSettings(raw) {
    const s = raw !== null && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
    return {
      enabled: typeof s.enabled === "boolean" ? s.enabled : DEFAULTS.enabled,
      volume: Object.prototype.hasOwnProperty.call(VOLUMES, s.volume) ? s.volume : DEFAULTS.volume,
      theme: Object.prototype.hasOwnProperty.call(THEMES, s.theme) ? s.theme : DEFAULTS.theme,
      ticks: typeof s.ticks === "boolean" ? s.ticks : DEFAULTS.ticks,
      scope: SCOPES.includes(s.scope) ? s.scope : DEFAULTS.scope,
      askAlways: typeof s.askAlways === "boolean" ? s.askAlways : DEFAULTS.askAlways,
    };
  }

  /** 保存した文字列から読む（読めない・JSON でない・形の違うものは既定） */
  function parseSettings(text) {
    if (typeof text !== "string") return normalizeSettings(null);
    try {
      return normalizeSettings(JSON.parse(text));
    } catch {
      return normalizeSettings(null);
    }
  }

  function serializeSettings(settings) {
    return JSON.stringify(normalizeSettings(settings));
  }

  /** 手順の数 → 移調の半音（§5） */
  function semitonesOf(toolCalls) {
    const n = typeof toolCalls === "number" && toolCalls > 0 ? toolCalls : 0;
    if (n >= 16) return -7;
    if (n >= 6) return -5;
    if (n >= 2) return -2;
    return 0;
  }

  /** 手順の数 → reply の音数（§5） */
  function replyNotesOf(toolCalls) {
    const n = typeof toolCalls === "number" && toolCalls > 0 ? toolCalls : 0;
    if (n >= 6) return 4;
    if (n >= 2) return 3;
    return 2;
  }

  /** 全部の周波数に 2^(semitones/12) を掛ける */
  function transpose(voices, semitones) {
    const k = Math.pow(2, (semitones || 0) / 12);
    return voices.map((v) => {
      const out = Object.assign({}, v);
      if (typeof v.f0 === "number") out.f0 = v.f0 * k;
      if (typeof v.f1 === "number") out.f1 = v.f1 * k;
      if (typeof v.f === "number") out.f = v.f * k;
      if (v.noise) out.noise = Object.assign({}, v.noise, { fc: v.noise.fc * k });
      return out;
    });
  }

  function themeOf(themeId) {
    return THEMES[themeId] || THEMES[DEFAULTS.theme];
  }

  /**
   * 事象の音のデータ。depth は { toolCalls?, elapsedMs?, count?（tick の増分）, command?（コマンドの手順）, cc?（Claude Code。reply は常に 2 音） }
   */
  function pattern(event, depth, themeId) {
    const d = depth || {};
    const ev = themeOf(themeId).events;
    let voices;
    if (event === "tick") {
      const set = (d.count || 1) >= 2 ? ev.tickDouble : ev.tick;
      voices = (d.command ? set.command : set.normal).map((v) => Object.assign({}, v));
    } else if (event === "reply") {
      const r = ev.reply;
      const n = d.cc ? 2 : replyNotesOf(d.toolCalls);
      voices = r.notes.slice(0, Math.min(n, r.notes.length)).map((v) => Object.assign({}, v));
      voices[voices.length - 1].d = r.lastDecay;
      const elapsed = typeof d.elapsedMs === "number" ? d.elapsedMs : 0;
      if (!d.cc && elapsed > 60000 && r.tail) {
        const last = voices[voices.length - 1];
        voices.push(Object.assign({}, r.tail.voice, { t: last.t + r.tail.gap, d: r.lastDecay }));
      }
      if (!d.cc && elapsed > 300000) voices[voices.length - 1].d = r.longDecay;
    } else if (ev[event]) {
      voices = ev[event].map((v) => Object.assign({}, v));
    } else return null;
    return { name: event, voices: transpose(voices, d.cc ? 0 : semitonesOf(d.toolCalls)) };
  }

  /** 判断待ちを id で 1 回だけにするためのメモリ（このタブ）と、送った時刻・Claude Code の返事の時刻 */
  function createMemory() {
    return { asked: new Set(), sentAt: new Map(), ccReplyAt: new Map(), askAt: new Map() };
  }

  /** 初めての判断待ちなら覚えて true */
  function firstAsk(mem, key) {
    if (mem.asked.has(key)) return false;
    mem.asked.add(key);
    if (mem.asked.size > ASKED_MAX) mem.asked.delete(mem.asked.values().next().value);
    return true;
  }

  /**
   * 初めての判断待ち（key）で、同じ会話（target）に 15 秒以内に別の判断待ちを鳴らしていなければ true。
   * key はどちらでも覚える（許可の要求は /api/running の waitingPermission と /turns の permission の両方から届くため）
   */
  function newAsk(mem, key, target, now) {
    if (!firstAsk(mem, key)) return false;
    const at = mem.askAt.get(target);
    mem.askAt.set(target, now);
    return at === undefined || now - at >= ASK_SAME_TARGET_MS;
  }

  function sentRecently(mem, channelId, now) {
    const at = channelId ? mem.sentAt.get(channelId) : undefined;
    return at !== undefined && now - at < SENT_SUPPRESS_MS;
  }

  /** Claude Code の返事を同じセッションで 15 秒に 1 回 */
  function ccReplyOnce(mem, sessionId, now) {
    const at = mem.ccReplyAt.get(sessionId);
    if (at !== undefined && now - at < CC_REPLY_DEDUPE_MS) return false;
    mem.ccReplyAt.set(sessionId, now);
    return true;
  }

  /** /api/running の差（api.js の applyRunning の前と後）→ 事象 */
  function decideRunning(detail, mem, now) {
    const out = [];
    const prevList = (detail && detail.prev) || [];
    const nextList = (detail && detail.next) || [];
    const catchUp = !!(detail && detail.catchUp);
    const before = new Map(prevList.map((r) => [r.channelId, r]));
    const after = new Map(nextList.map((r) => [r.channelId, r]));
    for (const [channelId, prev] of before) {
      const next = after.get(channelId);
      if (next && next.turnSeq === prev.turnSeq) continue;
      if (!catchUp) out.push({ event: "reply", channelId, depth: { toolCalls: prev.toolCalls, elapsedMs: prev.elapsedMs } });
    }
    for (const [channelId, next] of after) {
      const prev = before.get(channelId);
      const sameTurn = !!prev && prev.turnSeq === next.turnSeq;
      if (!sameTurn) {
        if (!catchUp && !sentRecently(mem, channelId, now)) out.push({ event: "start", channelId, depth: { toolCalls: next.toolCalls } });
      } else if (!catchUp && next.toolCalls > prev.toolCalls) {
        out.push({ event: "tick", channelId, depth: { toolCalls: next.toolCalls, count: next.toolCalls - prev.toolCalls, command: next.label === COMMAND_LABEL } });
      }
      const w = next.waitingPermission;
      if (w && newAsk(mem, "wp:" + channelId + ":" + next.turnSeq + ":" + (w.since || ""), "ch:" + channelId, now)) {
        out.push({ event: "ask", channelId, depth: { toolCalls: next.toolCalls } });
      }
    }
    return out;
  }

  /** 許可の要求（プロジェクトのセッションの channel.permission・Claude Code のチャンネルの cc.permission）が保留中なら id で 1 回 */
  function permissionAsk(mem, p, target, now) {
    return !!(p && p.state === "pending" && p.id !== undefined && newAsk(mem, "perm:" + p.id, target, now));
  }

  /** /turns の増分 → 事象。after は読んだ後のチャンネル（closeDraft・permission・kind・cc） */
  function decideTurns(detail, mem, now) {
    const out = [];
    if (!detail) return out;
    const { channelId, rows, after } = detail;
    const catchUp = !!detail.catchUp;
    const ch = after || null;
    const isCc = !!(ch && ch.kind === "cc");
    const sessionId = isCc && ch.cc && typeof ch.cc.sessionId === "string" ? ch.cc.sessionId : null;
    const base = { channelId };
    if (sessionId) base.sessionId = sessionId;
    const target = sessionId ? "s:" + sessionId : "ch:" + channelId;
    if (ch && (permissionAsk(mem, ch.permission, target, now) || permissionAsk(mem, ch.cc && ch.cc.permission, target, now))) {
      out.push(Object.assign({ event: "ask" }, base));
    }
    const closeKey = "close:" + channelId;
    if (ch && ch.closeDraft) {
      if (newAsk(mem, closeKey, target, now)) out.push(Object.assign({ event: "ask" }, base));
    } else mem.asked.delete(closeKey);
    const agents = (rows || []).filter((row) => row && row.kind === "agent");
    const last = agents[agents.length - 1];
    if (last) {
      if (isCc) {
        if (!catchUp && sessionId && ccReplyOnce(mem, sessionId, now)) out.push(Object.assign({ event: "reply", depth: { cc: true } }, base));
      } else if (last.outcome === "max_turns") {
        if (newAsk(mem, "row:" + last.id, target, now)) out.push(Object.assign({ event: "ask" }, base));
      } else if (last.outcome === "failed" && !catchUp) {
        if (firstAsk(mem, "fail:" + last.id)) out.push(Object.assign({ event: "fail" }, base));
      }
    }
    return out;
  }

  /** Claude Code の一覧の差 → 事象 */
  function decideCc(detail, mem, now) {
    const out = [];
    if (!detail || !detail.next) return out;
    const catchUp = !!detail.catchUp;
    const prevById = new Map(((detail.prev && detail.prev.sessions) || []).map((s) => [s.sessionId, s]));
    for (const s of detail.next.sessions || []) {
      const channelId = s.channel && typeof s.channel.channelId === "string" ? s.channel.channelId : null;
      const base = { sessionId: s.sessionId };
      if (channelId) base.channelId = channelId;
      const target = "s:" + s.sessionId;
      // 同じ結果の 2 つ（判断待ちと許可の要求）は coalesce で 1 つになるので、両方を見る
      const waiting = s.state === "needs_input" && newAsk(mem, "ccwait:" + s.sessionId + ":" + (s.since || ""), target, now);
      const permission = permissionAsk(mem, s.permission, target, now);
      if (waiting || permission) out.push(Object.assign({ event: "ask" }, base));
      const p = prevById.get(s.sessionId);
      if (catchUp || !p) continue;
      const startedRunning = s.state === "running" && (p.state === "idle" || p.state === "needs_input");
      const delivered =
        !!s.pending && s.pending.state === "delivered" && !(p.pending && p.pending.id === s.pending.id && p.pending.state === "delivered");
      if ((startedRunning || delivered) && !sentRecently(mem, channelId, now)) out.push(Object.assign({ event: "start" }, base));
      if (p.state === "running" && s.state === "idle" && ccReplyOnce(mem, s.sessionId, now)) out.push(Object.assign({ event: "reply", depth: { cc: true } }, base));
      const failed = !!s.pending && (s.pending.state === "failed" || s.pending.state === "gave_up");
      if (failed && !(p.pending && p.pending.id === s.pending.id && p.pending.state === s.pending.state)) out.push(Object.assign({ event: "fail" }, base));
    }
    return out;
  }

  /** 前に出ている会話か（channelId か、Claude Code の sessionId で） */
  function isFront(ev, view) {
    return (!!ev.channelId && ev.channelId === view.frontChannelId) || (!!ev.sessionId && ev.sessionId === view.frontSessionId);
  }

  /** 設定と今の画面で絞る。view は { frontChannelId, frontSessionId, hidden } */
  function filterEvents(events, settings, view) {
    const s = normalizeSettings(settings);
    return events.filter((ev) => {
      if (ev.event === "tick") return s.ticks && !view.hidden && isFront(ev, view);
      if (ev.event === "ask" && s.askAlways) return true;
      return s.scope === "all" || isFront(ev, view);
    });
  }

  /** 鳴らした記録（§4 の 1・3 の判定に使う） */
  function createPacer() {
    return { lastAt: -Infinity, lastPriority: 0, lastReplyAt: -Infinity, times: [] };
  }

  /** 同じ結果の事象から 1 つを選び、間隔・上限で落とす。鳴らすものを返す（無ければ null）。記録は notePlayed で */
  function coalesce(events, pacer, now) {
    let chosen = null;
    for (const ev of events) if (!chosen || PRIORITY[ev.event] > PRIORITY[chosen.event]) chosen = ev;
    if (!chosen) return null;
    const pr = PRIORITY[chosen.event];
    if (chosen.event === "start" && now - pacer.lastReplyAt < START_AFTER_REPLY_MS) return null;
    const recent = pacer.times.filter((t) => now - t < RATE_WINDOW_MS).length;
    if (chosen.event === "tick" && recent >= RATE_MAX) return null;
    if (now - pacer.lastAt < MIN_GAP_MS && pr <= pacer.lastPriority) return null;
    return chosen;
  }

  function notePlayed(pacer, ev, now) {
    pacer.lastAt = now;
    pacer.lastPriority = PRIORITY[ev.event];
    if (ev.event === "reply") pacer.lastReplyAt = now;
    pacer.times = pacer.times.filter((t) => now - t < RATE_WINDOW_MS);
    pacer.times.push(now);
  }

  const pure = {
    THEMES,
    DEFAULTS,
    VOLUMES,
    MASTER_GAIN,
    VOICE_MAX_S,
    ASK_VOICE_MAX_S,
    LONG_DECAY_MAX_S,
    normalizeSettings,
    parseSettings,
    serializeSettings,
    semitonesOf,
    replyNotesOf,
    transpose,
    pattern,
    createMemory,
    decideRunning,
    decideTurns,
    decideCc,
    filterEvents,
    createPacer,
    coalesce,
    notePlayed,
  };

  // ===== 設定（このブラウザだけ。読めなくても動く） =====
  function readSettings() {
    try {
      return parseSettings(window.localStorage.getItem(STORAGE_KEY));
    } catch {
      return normalizeSettings(null);
    }
  }

  let settings = readSettings();

  function writeSettings(next) {
    settings = normalizeSettings(next);
    try {
      window.localStorage.setItem(STORAGE_KEY, serializeSettings(settings));
    } catch {
      // 保存できない環境では覚えないだけ
    }
  }

  // ===== 再生（Web Audio） =====
  const audio = { ctx: null, master: null, noise: null, playing: [], armed: false };

  function refreshSettingsView() {
    if (SA.app && typeof SA.app.refresh === "function") SA.app.refresh("settings");
  }

  /** 画面の操作（pointerdown・keydown）の中で呼ぶ。AudioContext を作って resume する */
  function ensureContext() {
    const Ctor = window.AudioContext || window.webkitAudioContext;
    if (!Ctor) return null;
    if (!audio.ctx) {
      try {
        audio.ctx = new Ctor();
      } catch {
        return null;
      }
      audio.master = audio.ctx.createGain();
      audio.master.connect(audio.ctx.destination);
      audio.noise = null;
      audio.ctx.onstatechange = refreshSettingsView;
    }
    if (audio.ctx.state !== "running") {
      try {
        const p = audio.ctx.resume();
        if (p && typeof p.then === "function") p.then(refreshSettingsView, () => {});
      } catch {
        // resume できなければ次の操作で
      }
    }
    return audio.ctx;
  }

  function ready() {
    return !!audio.ctx && audio.ctx.state === "running";
  }

  function onGesture() {
    disarm();
    if (settings.enabled) ensureContext();
  }

  /** 次の画面の操作を 1 回だけ捕まえる */
  function arm() {
    if (audio.armed) return;
    audio.armed = true;
    document.addEventListener("pointerdown", onGesture, true);
    document.addEventListener("keydown", onGesture, true);
  }

  function disarm() {
    if (!audio.armed) return;
    audio.armed = false;
    document.removeEventListener("pointerdown", onGesture, true);
    document.removeEventListener("keydown", onGesture, true);
  }

  /** 戻ったとき: interrupted / suspended なら resume を試し、1 秒で動かなければ捨てて次の操作で作り直す */
  function onVisible() {
    if (document.visibilityState !== "visible" || !settings.enabled) return;
    const ctx = audio.ctx;
    if (!ctx) {
      arm();
      return;
    }
    if (ctx.state === "running") return;
    try {
      const p = ctx.resume();
      if (p && typeof p.then === "function") p.catch(() => {});
    } catch {
      // 下で作り直す
    }
    setTimeout(() => {
      if (audio.ctx !== ctx || ctx.state === "running") return;
      try {
        ctx.close();
      } catch {
        // 閉じられなくても捨てる
      }
      audio.ctx = null;
      audio.master = null;
      audio.noise = null;
      arm();
      refreshSettingsView();
    }, RESUME_SETTLE_MS);
    arm();
  }

  /** 0.1 秒の白色雑音（tick の接点の擦れ） */
  function noiseBuffer(ctx) {
    if (audio.noise) return audio.noise;
    const buf = ctx.createBuffer(1, Math.ceil(ctx.sampleRate * 0.1), ctx.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
    audio.noise = buf;
    return buf;
  }

  const FLOOR = 0.0001;

  /** gain の包絡（立ち上がり a で g に、t+d で消える） */
  function envelope(gain, t, a, d, g) {
    gain.gain.setValueAtTime(FLOOR, t);
    gain.gain.exponentialRampToValueAtTime(Math.max(g, FLOOR), t + a);
    gain.gain.exponentialRampToValueAtTime(FLOOR, t + d);
  }

  /** 同時に鳴るのは 1 つ: 前の音を止める */
  function stopPlaying() {
    for (const node of audio.playing) {
      try {
        node.stop();
      } catch {
        // 終わっている
      }
    }
    audio.playing = [];
  }

  function play(pat, volume) {
    if (!pat || !ready()) return false;
    const ctx = audio.ctx;
    stopPlaying();
    audio.master.gain.setValueAtTime(MASTER_GAIN * (VOLUMES[volume] || VOLUMES[DEFAULTS.volume]), ctx.currentTime);
    const t0 = ctx.currentTime + 0.02;
    for (const v of pat.voices) {
      const t = t0 + v.t;
      if (v.kind === "tone") {
        const osc = ctx.createOscillator();
        osc.type = v.wave || "sine";
        osc.frequency.setValueAtTime(v.f0, t);
        if (typeof v.f1 === "number") osc.frequency.exponentialRampToValueAtTime(v.f1, t + v.a);
        const gain = ctx.createGain();
        envelope(gain, t, v.a, v.d, v.g);
        osc.connect(gain).connect(audio.master);
        osc.start(t);
        osc.stop(t + v.d + 0.02);
        audio.playing.push(osc);
      } else if (v.kind === "tick") {
        const osc = ctx.createOscillator();
        osc.frequency.setValueAtTime(v.f, t);
        const gain = ctx.createGain();
        envelope(gain, t, 0.001, v.d, v.g);
        osc.connect(gain).connect(audio.master);
        osc.start(t);
        osc.stop(t + v.d + 0.02);
        audio.playing.push(osc);
        if (v.noise) {
          const src = ctx.createBufferSource();
          src.buffer = noiseBuffer(ctx);
          const filter = ctx.createBiquadFilter();
          filter.type = "bandpass";
          filter.frequency.setValueAtTime(v.noise.fc, t);
          filter.Q.setValueAtTime(v.noise.q, t);
          const ng = ctx.createGain();
          envelope(ng, t, 0.001, v.noise.d, v.noise.g);
          src.connect(filter).connect(ng).connect(audio.master);
          src.start(t);
          src.stop(t + v.noise.d + 0.02);
          audio.playing.push(src);
        }
      }
    }
    return true;
  }

  // ===== 事象を受けて鳴らす =====
  const mem = createMemory();
  const pacer = createPacer();

  function view() {
    const frontChannelId = SA.chat && typeof SA.chat.activeChannelId === "function" ? SA.chat.activeChannelId() : null;
    let frontSessionId = null;
    const tabId = SA.app && typeof SA.app.activeTabId === "function" ? SA.app.activeTabId() : null;
    if (tabId && tabId.startsWith("cc:")) frontSessionId = tabId.slice(3);
    else {
      const ch = SA.chat && typeof SA.chat.current === "function" ? SA.chat.current() : null;
      if (ch && ch.kind === "cc" && ch.cc && typeof ch.cc.sessionId === "string") frontSessionId = ch.cc.sessionId;
    }
    return { frontChannelId, frontSessionId, hidden: document.visibilityState !== "visible" };
  }

  /** 画面の操作の前（AudioContext が無い・suspended）は捨てる */
  function handle(events) {
    if (!settings.enabled || events.length === 0) return;
    const now = Date.now();
    const chosen = coalesce(filterEvents(events, settings, view()), pacer, now);
    if (!chosen) return;
    if (play(pattern(chosen.event, chosen.depth, settings.theme), settings.volume)) notePlayed(pacer, chosen, now);
  }

  function listen(name, decide) {
    SA.events.on(name, (detail) => {
      // オフの間も判断待ちは覚える（オンにした後に古いものを鳴らさない）
      const events = decide(detail, mem, Date.now());
      handle(events);
    });
  }

  if (SA.events) {
    listen("running", decideRunning);
    listen("turns", decideTurns);
    listen("cc", decideCc);
    SA.events.on("sent", (detail) => {
      const channelId = detail && detail.channelId;
      if (typeof channelId !== "string") return;
      mem.sentAt.set(channelId, Date.now());
      handle([{ event: "start", channelId }]);
    });
  }

  if (settings.enabled) arm();
  document.addEventListener("visibilitychange", onVisible);

  /** オンにする操作（クリックの中）: AudioContext を作り、動いたらぽぴんを 1 回 */
  function setEnabled(on) {
    writeSettings(Object.assign({}, settings, { enabled: !!on }));
    if (!settings.enabled) {
      disarm();
      stopPlaying();
      return;
    }
    const ctx = ensureContext();
    if (!ctx) return;
    whenRunning(ctx, () => play(pattern("ask", {}, settings.theme), settings.volume));
  }

  /** resume が済んだら fn（済まなければ鳴らさない） */
  function whenRunning(ctx, fn) {
    if (ctx.state === "running") {
      fn();
      return;
    }
    try {
      const p = ctx.resume();
      if (p && typeof p.then === "function") p.then(() => ctx.state === "running" && fn(), () => {});
    } catch {
      // 鳴らせない
    }
  }

  /** [試す]（クリックの中）: 設定がオフでも、今の音の種類で鳴らす */
  function test(event, depth) {
    const ctx = ensureContext();
    if (!ctx) return;
    whenRunning(ctx, () => play(pattern(event, depth || {}, settings.theme), settings.volume));
  }

  SA.sound = {
    pure,
    enabled: () => settings.enabled,
    settings: () => Object.assign({}, settings),
    /** 音を鳴らす以外の項目を変える */
    set(patch) {
      const { enabled: _enabled, ...rest } = patch || {};
      writeSettings(Object.assign({}, settings, rest));
    },
    setEnabled,
    toggle: () => setEnabled(!settings.enabled),
    test,
    /** オンなのに、まだ鳴らせない（次の画面の操作を待っている） */
    waitingGesture: () => settings.enabled && !ready(),
    supported: () => !!(window.AudioContext || window.webkitAudioContext),
    themes: () => THEME_IDS.map((id) => ({ id, label: THEMES[id].label })),
  };
})();
