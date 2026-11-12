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
  const DEFAULTS = {
    enabled: false,
    volume: "mid",
    // 事象ごとの音の種類（オーナーの選んだ組み合わせが来たら差し替える）
    combo: { start: "relay", tick: "relay", ask: "relay", reply: "relay", fail: "relay" },
    ticks: true,
    scope: "all",
    askAlways: true,
  };
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
  /** 前に出ている会話の消えたターンの終わり方（/turns の agent の行）を待つ時間。来なければ返事として鳴らす */
  const END_WAIT_MS = 3000;
  /** Web の [中断] の後、そのチャンネルの次の終わりを鳴らさない（この時間を過ぎた印は使わない） */
  const ABORT_SUPPRESS_MS = 60000;
  /** Claude Code の受け付けを同じセッションで鳴らす間隔 */
  const CC_START_GAP_MS = 10000;
  /** 覚えておく判断待ちの数（このタブのメモリ。超えたら古いものから忘れる） */
  const ASKED_MAX = 500;
  /** visible に戻ったときの resume がこれで settle しなければ作り直す */
  const RESUME_SETTLE_MS = 1000;
  /** 1 音（立ち上がり + 減衰）の長さの上限（秒）。試聴ページの音（硝子の 0.28 秒・判断待ちの最後の 0.3 秒）に合わせて 0.4 秒 */
  const VOICE_MAX_S = 0.4;
  /** 事象（docs/plan/web-ui-sound.md §3）。組み合わせ（combo）はこの事象ごとに音の種類を選ぶ */
  const EVENT_IDS = ["start", "tick", "ask", "reply", "fail"];

  // ===== 音の種類（テーマ）。値と組み立て（pattern）は、オーナーに渡した試聴ページ（sound-audition.html）と同じ音になるようにしている =====
  // base は基準の高さ（Hz）、gain はテーマの強さ、tone は 1 音の作り方（wave・a 立ち上がり・d 減衰・partials [倍率, 強さ, 長さ]・
  // drop（半音上から dropT 秒で落ちる）・lp（low-pass の Hz））、tick は手順の音（f・d・g・partials・drop・noise（f の音に足す雑音）・
  // noiseOnly（雑音だけ））。表に足せば増やせる
  const THEMES = {
    relay: {
      label: "接点",
      base: 880,
      gain: 0.8,
      tone: { wave: "sine", a: 0.006, d: 0.13 },
      tick: { f: 1800, d: 0.018, g: 0.55, noise: { fc: 2500, q: 4, d: 0.012, g: 0.35 } },
    },
    wood: {
      label: "木",
      base: 620,
      gain: 0.85,
      tone: { wave: "sine", a: 0.002, d: 0.16, partials: [[3.93, 0.22, 0.25], [9.2, 0.05, 0.12]] },
      tick: { f: 950, d: 0.03, g: 0.5, partials: [[3.93, 0.2, 0.3]] },
    },
    drop: {
      label: "水滴",
      base: 700,
      gain: 0.8,
      tone: { wave: "sine", a: 0.003, d: 0.11, drop: 12, dropT: 0.035 },
      tick: { f: 1500, d: 0.022, g: 0.45, drop: 7, dropT: 0.012 },
    },
    glass: {
      label: "硝子",
      base: 1046,
      gain: 0.5,
      tone: { wave: "sine", a: 0.004, d: 0.28, partials: [[2.76, 0.18, 0.35], [5.4, 0.06, 0.2]] },
      tick: { f: 2600, d: 0.012, g: 0.3 },
    },
    felt: {
      label: "フェルト",
      base: 392,
      gain: 1.0,
      tone: { wave: "triangle", a: 0.018, d: 0.22, lp: 1300 },
      tick: { f: 700, d: 0.03, g: 0.55, noiseOnly: { fc: 900, q: 1.2, d: 0.03, g: 0.6 } },
    },
  };
  const THEME_IDS = Object.keys(THEMES);
  const DEFAULT_THEME = "relay";

  // ===== 純関数 =====
  /** 事象ごとの音の種類。形の違う値・無い id は既定 */
  function normalizeCombo(raw) {
    const c = raw !== null && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
    const out = {};
    for (const id of EVENT_IDS) out[id] = Object.prototype.hasOwnProperty.call(THEMES, c[id]) ? c[id] : DEFAULTS.combo[id];
    return out;
  }

  /** 設定の形を整える。形の違うもの（オブジェクトでない・値が違う）は既定 */
  function normalizeSettings(raw) {
    const s = raw !== null && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
    return {
      enabled: typeof s.enabled === "boolean" ? s.enabled : DEFAULTS.enabled,
      volume: Object.prototype.hasOwnProperty.call(VOLUMES, s.volume) ? s.volume : DEFAULTS.volume,
      combo: normalizeCombo(s.combo),
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

  const semi = (f, s) => f * Math.pow(2, s / 12);

  function themeOf(themeId) {
    return THEMES[themeId] || THEMES[DEFAULT_THEME];
  }

  // 再生の単位（play がそのまま組む）:
  //   { t, kind: "osc", f, wave, a, d, g, drop?（半音）, dropT?, glideTo?（Hz）, glideT?, lp? }  包絡は t から a で g、t+a+d で消える
  //   { t, kind: "noise", fc, q, d, g }  0.1 秒の白色雑音を band-pass に通す（立ち上がり 0.001）
  /** テーマの 1 音（tone と倍音） */
  function toneVoices(th, t, f, g, d, opts) {
    const T = th.tone;
    const dd = d === undefined ? T.d : d;
    const peak = g * th.gain;
    const main = { t, kind: "osc", f, wave: T.wave, a: T.a, d: dd, g: peak };
    if (T.lp) main.lp = T.lp;
    if (T.drop) {
      main.drop = T.drop;
      main.dropT = T.dropT;
    }
    Object.assign(main, opts || {});
    const out = [main];
    for (const [ratio, pg, pd] of T.partials || []) out.push({ t, kind: "osc", f: f * ratio, wave: "sine", a: T.a, d: Math.min(dd, pd), g: peak * pg });
    return out;
  }

  function tickVoices(th, t, shift, command) {
    const k = th.tick;
    if (k.noiseOnly) return [{ t, kind: "noise", fc: semi(k.noiseOnly.fc, shift), q: k.noiseOnly.q, d: k.noiseOnly.d, g: k.noiseOnly.g }];
    const f = semi(k.f * (command ? 0.67 : 1), shift);
    const main = { t, kind: "osc", f, wave: "sine", a: 0.001, d: k.d, g: k.g * th.gain };
    if (k.drop) {
      main.drop = k.drop;
      main.dropT = k.dropT;
    }
    const out = [main];
    for (const [ratio, pg, pd] of k.partials || []) out.push({ t, kind: "osc", f: f * ratio, wave: "sine", a: 0.001, d: Math.min(k.d, pd), g: k.g * th.gain * pg });
    if (k.noise) out.push({ t, kind: "noise", fc: k.noise.fc, q: k.noise.q, d: k.noise.d, g: k.noise.g });
    return out;
  }

  /**
   * 事象の音のデータ。depth は { toolCalls?（移調）, count?（tick の増分。2 以上で「ここっ」）, command?（コマンドの手順）, cc?（Claude Code。移調なし） }
   */
  function pattern(event, depth, themeId) {
    const d = depth || {};
    const th = themeOf(themeId);
    const sh = d.cc ? 0 : semitonesOf(d.toolCalls);
    const B = semi(th.base, sh);
    const glide = (to, gt) => (th.tone.drop ? {} : { glideTo: to, glideT: gt });
    let voices;
    switch (event) {
      case "start":
        voices = toneVoices(th, 0, B, 0.8, undefined, glide(semi(B, 3), 0.012));
        break;
      case "tick":
        voices = tickVoices(th, 0, sh, !!d.command);
        if ((d.count || 1) >= 2) voices = voices.concat(tickVoices(th, 0.07, sh, !!d.command));
        break;
      case "ask":
        // ぽ・ぴ・ぽ・ぴん: 低い・高いを 2 回。最後の「ぴん」だけ少し上がって残る
        voices = toneVoices(th, 0, B, 0.75, 0.07)
          .concat(toneVoices(th, 0.09, semi(B, 7), 0.7, 0.07))
          .concat(toneVoices(th, 0.18, B, 0.75, 0.07))
          .concat(toneVoices(th, 0.27, semi(B, 7), 0.75, 0.3, glide(semi(B, 9), 0.06)));
        break;
      case "reply":
        // ピ・ポ・パッ: 3 音で上がり、最後は短く切る。深さは高さ（移調）だけで表す
        voices = [];
        [0, 4, 7].forEach((st, i) => {
          const last = i === 2;
          voices = voices.concat(toneVoices(th, i * 0.085, semi(B, st), last ? 0.8 : 0.65, last ? 0.06 : 0.07));
        });
        break;
      case "fail":
        voices = [{ t: 0, kind: "osc", f: semi(th.base, -14), wave: "triangle", a: 0.01, d: 0.2, g: 0.6 * th.gain, lp: th.tone.lp || 1800 }];
        break;
      default:
        return null;
    }
    return { name: event, voices };
  }

  /**
   * このタブのメモリ（純関数の判定が読み書きする）。asked は鳴らした（か、同じ要求を別の経路で鳴らした）判断待ちの key、
   * askAt は会話（target）ごとに今出ている判断待ちを鳴らした時刻と経路、sentAt は Web から送った時刻、ccReplyAt・ccStartAt は
   * Claude Code の返事・受け付けを鳴らした時刻、pendingEnds は前に出ている会話の終わり方を待っているターン、abortedAt は Web の [中断]、
   * wpChannels・permChannels は同じ許可の要求を /api/running と /turns のどちらで鳴らしたか（もう一方では鳴らさない）
   */
  function createMemory() {
    return {
      asked: new Set(),
      askAt: new Map(),
      sentAt: new Map(),
      ccReplyAt: new Map(),
      ccStartAt: new Map(),
      pendingEnds: new Map(),
      abortedAt: new Map(),
      wpChannels: new Set(),
      permChannels: new Set(),
    };
  }

  /** 初めての key なら覚えて true */
  function firstAsk(mem, key) {
    if (mem.asked.has(key)) return false;
    mem.asked.add(key);
    if (mem.asked.size > ASKED_MAX) mem.asked.delete(mem.asked.values().next().value);
    return true;
  }

  /**
   * 初めての判断待ち（key）を鳴らすか。同じ会話（target）の判断待ちを別の経路（path）で 15 秒以内に鳴らしていれば鳴らさない
   * （同じ要求を別の経路から見たとき。抑えたときは askAt を進めない）。key はどちらでも覚える
   */
  function newAsk(mem, key, target, path, now) {
    if (!firstAsk(mem, key)) return false;
    const at = mem.askAt.get(target);
    if (at && at.path !== path && now - at.at < ASK_SAME_TARGET_MS) return false;
    mem.askAt.set(target, { at: now, path });
    return true;
  }

  /** 答えた・消えた判断待ち: その会話のその経路の askAt を消す */
  function clearAsk(mem, target, path) {
    const at = mem.askAt.get(target);
    if (at && at.path === path) mem.askAt.delete(target);
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

  /** Claude Code の受け付けを同じセッションで 10 秒に 1 回 */
  function ccStartOnce(mem, sessionId, now) {
    const at = mem.ccStartAt.get(sessionId);
    if (at !== undefined && now - at < CC_START_GAP_MS) return false;
    mem.ccStartAt.set(sessionId, now);
    return true;
  }

  /** 終わり方を待つ時間を過ぎたターンは返事として鳴らす */
  function expireEnds(mem, now) {
    const out = [];
    for (const [channelId, p] of mem.pendingEnds) {
      if (now - p.at < END_WAIT_MS) continue;
      mem.pendingEnds.delete(channelId);
      out.push({ event: "reply", channelId, depth: p.depth });
    }
    return out;
  }

  /** Web の [中断] を押した: そのチャンネルの次の終わりでは鳴らさない */
  function noteAborted(mem, channelId, now) {
    mem.abortedAt.set(channelId, now);
  }

  /**
   * /api/running の差（api.js の applyRunning の前と後）→ 事象。front は前に出ている会話（/turns を読んでいるチャンネル。隠れていれば null）。
   * 消えたターンは、Web で中断したなら鳴らさず、前に出ている会話なら次の /turns の agent の行を最大 3 秒待ち（pendingEnds）、それ以外はすぐ返事
   */
  function decideRunning(detail, mem, now, front) {
    const out = [];
    const prevList = (detail && detail.prev) || [];
    const nextList = (detail && detail.next) || [];
    const catchUp = !!(detail && detail.catchUp);
    const before = new Map(prevList.map((r) => [r.channelId, r]));
    const after = new Map(nextList.map((r) => [r.channelId, r]));
    for (const [channelId, prev] of before) {
      const next = after.get(channelId);
      if (next && next.turnSeq === prev.turnSeq) continue;
      const aborted = mem.abortedAt.get(channelId);
      mem.abortedAt.delete(channelId);
      if (catchUp || (aborted !== undefined && now - aborted < ABORT_SUPPRESS_MS)) continue;
      const depth = { toolCalls: prev.toolCalls };
      if (front && channelId === front) mem.pendingEnds.set(channelId, { at: now, depth });
      else out.push({ event: "reply", channelId, depth });
    }
    for (const [channelId, next] of after) {
      const prev = before.get(channelId);
      const sameTurn = !!prev && prev.turnSeq === next.turnSeq;
      if (!sameTurn) {
        if (!catchUp && !sentRecently(mem, channelId, now)) out.push({ event: "start", channelId, depth: { toolCalls: next.toolCalls } });
      } else if (!catchUp && next.toolCalls > prev.toolCalls) {
        out.push({ event: "tick", channelId, depth: { toolCalls: next.toolCalls, count: next.toolCalls - prev.toolCalls, command: next.label === COMMAND_LABEL } });
      }
    }
    // 許可を待っている（プロジェクトのセッション）。同じ要求を /turns の permission で鳴らしていれば鳴らさない
    for (const channelId of new Set([...before.keys(), ...after.keys()])) {
      const next = after.get(channelId);
      const w = next && next.waitingPermission;
      const target = "ch:" + channelId;
      if (!w) {
        mem.wpChannels.delete(channelId);
        clearAsk(mem, target, "wp");
        continue;
      }
      const key = "wp:" + channelId + ":" + next.turnSeq + ":" + (w.since || "");
      if (mem.permChannels.has(channelId)) {
        firstAsk(mem, key);
        continue;
      }
      if (newAsk(mem, key, target, "wp", now)) {
        mem.wpChannels.add(channelId);
        out.push({ event: "ask", channelId, depth: { toolCalls: next.toolCalls } });
      }
    }
    return out;
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
    // 許可の要求: プロジェクトのセッションは channel.permission（/api/running の waitingPermission と同じ要求）、Claude Code のチャンネルは cc.permission
    const p = ch ? (isCc ? ch.cc && ch.cc.permission : ch.permission) : null;
    if (p && p.state === "pending" && p.id !== undefined) {
      const key = "perm:" + p.id;
      if (!isCc && mem.wpChannels.has(channelId)) firstAsk(mem, key);
      else if (newAsk(mem, key, target, "perm", now)) {
        if (!isCc) mem.permChannels.add(channelId);
        out.push(Object.assign({ event: "ask" }, base));
      }
    } else if (ch) {
      if (!isCc) mem.permChannels.delete(channelId);
      clearAsk(mem, target, "perm");
    }
    const closeKey = "close:" + channelId;
    if (ch && ch.closeDraft) {
      if (newAsk(mem, closeKey, target, "close", now)) out.push(Object.assign({ event: "ask" }, base));
    } else if (ch) {
      mem.asked.delete(closeKey);
      clearAsk(mem, target, "close");
    }
    const agents = (rows || []).filter((row) => row && row.kind === "agent");
    const last = agents[agents.length - 1];
    if (isCc) {
      if (last && !catchUp && sessionId && ccReplyOnce(mem, sessionId, now)) out.push(Object.assign({ event: "reply", depth: { cc: true } }, base));
      return out;
    }
    // 前に出ている会話の終わり方（decideRunning が待っているもの）だけを行の outcome で決める。待っていなければ鳴らさない（2 回鳴らさない）
    const pending = mem.pendingEnds.get(channelId);
    if (pending && last) {
      mem.pendingEnds.delete(channelId);
      if (last.outcome === "max_turns") {
        if (newAsk(mem, "row:" + last.id, target, "row", now)) out.push(Object.assign({ event: "ask" }, base));
      } else if (last.outcome === "failed") out.push(Object.assign({ event: "fail" }, base));
      else if (last.outcome !== "aborted") out.push(Object.assign({ event: "reply", depth: pending.depth }, base));
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
      let waiting = false;
      if (s.state === "needs_input") waiting = newAsk(mem, "ccwait:" + s.sessionId + ":" + (s.since || ""), target, "ccwait", now);
      else clearAsk(mem, target, "ccwait");
      let permission = false;
      if (s.permission && s.permission.state === "pending" && s.permission.id !== undefined) {
        permission = newAsk(mem, "perm:" + s.permission.id, target, "perm", now);
      } else clearAsk(mem, target, "perm");
      if (waiting || permission) out.push(Object.assign({ event: "ask" }, base));
      const p = prevById.get(s.sessionId);
      if (catchUp || !p) continue;
      const startedRunning = s.state === "running" && (p.state === "idle" || p.state === "needs_input");
      const delivered =
        !!s.pending && s.pending.state === "delivered" && !(p.pending && p.pending.id === s.pending.id && p.pending.state === "delivered");
      // Web から送った（会話のタブはチャンネル、cc のタブは "cc:" + sessionId の key）なら 10 秒は鳴らさない
      const sent = sentRecently(mem, channelId, now) || sentRecently(mem, "cc:" + s.sessionId, now);
      if ((startedRunning || delivered) && !sent && ccStartOnce(mem, s.sessionId, now)) out.push(Object.assign({ event: "start" }, base));
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
    EVENT_IDS,
    normalizeSettings,
    parseSettings,
    serializeSettings,
    semitonesOf,
    normalizeCombo,
    pattern,
    createMemory,
    expireEnds,
    noteAborted,
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

  /** 設定の節の注記（「次に画面を操作したときから鳴ります。」）が変わったときだけ描き直す（[試す] の焦点を保つ） */
  let shownWaiting = null;
  function refreshSettingsView() {
    const waiting = settings.enabled && !ready();
    if (waiting === shownWaiting) return;
    shownWaiting = waiting;
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

  /** 解除に使う画面の操作（ブラウザによって resume を許す事象が違うので、どれでも試す） */
  const GESTURE_EVENTS = ["pointerdown", "pointerup", "touchend", "click", "keydown"];

  /** 画面の操作の中で resume し、動いたら（ctx.state が running）待つのをやめる */
  function onGesture() {
    if (!settings.enabled) {
      disarm();
      return;
    }
    const ctx = ensureContext();
    if (!ctx) {
      disarm();
      return;
    }
    if (ctx.state === "running") {
      disarm();
      return;
    }
    try {
      const p = ctx.resume();
      if (p && typeof p.then === "function") p.then(() => ctx.state === "running" && disarm(), () => {});
    } catch {
      // 次の操作で
    }
  }

  /** 動くまで画面の操作を捕まえる */
  function arm() {
    if (audio.armed) return;
    audio.armed = true;
    for (const type of GESTURE_EVENTS) document.addEventListener(type, onGesture, true);
  }

  function disarm() {
    if (!audio.armed) return;
    audio.armed = false;
    for (const type of GESTURE_EVENTS) document.removeEventListener(type, onGesture, true);
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

  /** gain の包絡（試聴ページと同じ: t から a で peak、t+a+d で消える） */
  function envelope(gain, t, a, d, peak) {
    gain.gain.setValueAtTime(0.0001, t);
    gain.gain.exponentialRampToValueAtTime(Math.max(peak, 0.0002), t + a);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + a + d);
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

  function playOsc(ctx, t, v) {
    const o = ctx.createOscillator();
    o.type = v.wave || "sine";
    if (v.drop) {
      o.frequency.setValueAtTime(semi(v.f, v.drop), t);
      o.frequency.exponentialRampToValueAtTime(v.f, t + v.dropT);
    } else if (v.glideTo) {
      o.frequency.setValueAtTime(v.f, t);
      o.frequency.exponentialRampToValueAtTime(v.glideTo, t + (v.glideT || 0.04));
    } else o.frequency.setValueAtTime(v.f, t);
    const g = ctx.createGain();
    envelope(g, t, v.a, v.d, v.g);
    let node = o;
    if (v.lp) {
      const lp = ctx.createBiquadFilter();
      lp.type = "lowpass";
      lp.frequency.setValueAtTime(v.lp, t);
      o.connect(lp);
      node = lp;
    }
    node.connect(g);
    g.connect(audio.master);
    o.start(t);
    o.stop(t + v.a + v.d + 0.05);
    audio.playing.push(o);
  }

  function playNoise(ctx, t, v) {
    const src = ctx.createBufferSource();
    src.buffer = noiseBuffer(ctx);
    const bp = ctx.createBiquadFilter();
    bp.type = "bandpass";
    bp.frequency.setValueAtTime(v.fc, t);
    bp.Q.setValueAtTime(v.q, t);
    const g = ctx.createGain();
    envelope(g, t, 0.001, v.d, v.g);
    src.connect(bp);
    bp.connect(g);
    g.connect(audio.master);
    src.start(t);
    src.stop(t + v.d + 0.05);
    audio.playing.push(src);
  }

  function play(pat, volume) {
    if (!pat || !ready()) return false;
    const ctx = audio.ctx;
    stopPlaying();
    audio.master.gain.setValueAtTime(MASTER_GAIN * (VOLUMES[volume] || VOLUMES[DEFAULTS.volume]), ctx.currentTime);
    const t0 = ctx.currentTime + 0.03;
    for (const v of pat.voices) {
      if (v.kind === "osc") playOsc(ctx, t0 + v.t, v);
      else if (v.kind === "noise") playNoise(ctx, t0 + v.t, v);
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
    if (play(pattern(chosen.event, chosen.depth, settings.combo[chosen.event]), settings.volume)) notePlayed(pacer, chosen, now);
  }

  /** 終わり方を待っているターンがあれば、待つ時間の後に一度だけ確かめる */
  let endTimer = null;
  function scheduleEnds() {
    if (endTimer !== null || mem.pendingEnds.size === 0) return;
    endTimer = setTimeout(() => {
      endTimer = null;
      handle(expireEnds(mem, Date.now()));
      scheduleEnds();
    }, END_WAIT_MS + 50);
  }

  function listen(name, decide) {
    SA.events.on(name, (detail) => {
      // オフの間も判断待ちは覚える（オンにした後に古いものを鳴らさない）
      const now = Date.now();
      const v = view();
      const events = expireEnds(mem, now).concat(decide(detail, mem, now, v.hidden ? null : v.frontChannelId));
      handle(events);
      scheduleEnds();
    });
  }

  if (SA.events) {
    listen("running", decideRunning);
    // Web の [中断]（chat.js）: そのチャンネルの次の終わりでは鳴らさない
    SA.events.on("aborted", (detail) => {
      if (detail && typeof detail.channelId === "string") noteAborted(mem, detail.channelId, Date.now());
    });
    SA.events.on("abortFailed", (detail) => {
      if (detail && typeof detail.channelId === "string") mem.abortedAt.delete(detail.channelId);
    });
    listen("turns", decideTurns);
    listen("cc", decideCc);
    SA.events.on("sent", (detail) => {
      const channelId = detail && detail.channelId;
      if (typeof channelId !== "string") return;
      mem.sentAt.set(channelId, Date.now());
      // cc のタブ（views.js）は "cc:" + sessionId で届く
      handle([channelId.startsWith("cc:") ? { event: "start", sessionId: channelId.slice(3) } : { event: "start", channelId }]);
    });
  }

  if (settings.enabled) arm();
  document.addEventListener("visibilitychange", onVisible);

  /** オンにする操作（クリックの中）: AudioContext を作り、動いたら判断待ちの音を 1 回 */
  function setEnabled(on) {
    writeSettings(Object.assign({}, settings, { enabled: !!on }));
    if (!settings.enabled) {
      disarm();
      stopPlaying();
      return;
    }
    // 見えている間も Claude Code の一覧を読み始める（api.js の polling。音がオンなら会話の一覧を出していなくても読む）
    if (SA.poll && typeof SA.poll.kickCc === "function") SA.poll.kickCc();
    const ctx = ensureContext();
    if (!ctx) return;
    whenRunning(ctx, () => play(pattern("ask", {}, settings.combo.ask), settings.volume));
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

  /** [試す]（クリックの中）: 設定がオフでも、今の組み合わせ（その事象の音の種類）で鳴らす */
  function test(event, depth) {
    const ctx = ensureContext();
    if (!ctx) return;
    whenRunning(ctx, () => play(pattern(event, depth || {}, settings.combo[event]), settings.volume));
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
    /** 事象（start・tick・ask・reply・fail）の音の種類を変える */
    setCombo(event, themeId) {
      writeSettings(Object.assign({}, settings, { combo: Object.assign({}, settings.combo, { [event]: themeId }) }));
    },
    test,
    /** オンなのに、まだ鳴らせない（次の画面の操作を待っている） */
    waitingGesture: () => settings.enabled && !ready(),
    supported: () => !!(window.AudioContext || window.webkitAudioContext),
    themes: () => THEME_IDS.map((id) => ({ id, label: THEMES[id].label })),
  };
})();
