// 画面写し（npm run ui-shots。#386）のデータとサーバー。一時ディレクトリに DB を作って作り物のデータを入れ、
// 本物の Web サーバー（createWebServer と本物のルート）を 127.0.0.1 の空きポートで立てる。
// データは全部作り物（実在の名前・ID・トークンを入れない。test/ui-shots-fixture.test.ts が数字の長い ID とメールを探す）。
// Discord・Claude・GitHub には出ない（Gateway・Runner は空の偽物、送信は busy を返す）。env ファイル・本番の DB は読まない
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createChannelResolver } from "../src/app/access.ts";
import type { RunningTurn, SubmitTextResult } from "../src/app/handler.ts";
import { PersonaRouter } from "../src/app/personas.ts";
import type { AgentRunner } from "../src/agent/runner.ts";
import type { CcAnswerResult } from "../src/cc/permission-hold.ts";
import type { CcSessionView } from "../src/cc/registry.ts";
import type { CcCancelResult } from "../src/cc/sender.ts";
import type { Gateway } from "../src/discord/gateway.ts";
import type { TmuxPane } from "../src/tmux/tmux.ts";
import { AttachmentStore } from "../src/store/attachments.ts";
import { CcChannelStore } from "../src/store/cc-channels.ts";
import { CcPermissionStore } from "../src/store/cc-permissions.ts";
import { CcSendStore } from "../src/store/cc-sends.ts";
import { CcStartStore } from "../src/store/cc-starts.ts";
import { openDb } from "../src/store/db.ts";
import { GuildSettingsStore } from "../src/store/guild-settings.ts";
import { HistoryStore } from "../src/store/history.ts";
import { KnowledgeStore } from "../src/store/knowledge.ts";
import { MemoryStore } from "../src/store/memories.ts";
import { NoticeStore } from "../src/store/notices.ts";
import { ProjectStore } from "../src/store/projects.ts";
import { ReminderStore } from "../src/store/reminders.ts";
import { SdkSessionStore } from "../src/store/sdk-sessions.ts";
import { TaskStore } from "../src/store/tasks.ts";
import { TopicReadStore } from "../src/store/topic-reads.ts";
import { TopicSessionStore } from "../src/store/topic-sessions.ts";
import { UsageStore } from "../src/store/usage.ts";
import { CC_STATUS_DISABLED, ccChannelDescriber, ccRoutes } from "../src/web/routes/cc.ts";
import { channelRoutes, webChannelLookup } from "../src/web/routes/channels.ts";
import { knowledgeRoutes } from "../src/web/routes/knowledge.ts";
import { memoryRoutes } from "../src/web/routes/memories.ts";
import { noticeRoutes } from "../src/web/routes/notices.ts";
import { projectRoutes } from "../src/web/routes/projects.ts";
import { reminderRoutes } from "../src/web/routes/reminders.ts";
import { statusRoutes } from "../src/web/routes/status.ts";
import { taskRoutes } from "../src/web/routes/tasks.ts";
import { createTopicCollector, topicRoutes } from "../src/web/routes/topics.ts";
import { turnRoutes } from "../src/web/routes/turns.ts";
import { usageRoutes } from "../src/web/routes/usage.ts";
import { createWebServer } from "../src/web/server.ts";

/** Tailscale-User-Login に付ける作り物のログイン */
export const FIXTURE_LOGIN = "shots@example.test";
/** 作り物のサーバー ID（Discord の ID の形にしない） */
const GUILD = "9001";
const INBOX = "100";
const TASKS = "101";

export type FixtureServer = {
  /** http://127.0.0.1:<port> */
  url: string;
  login: string;
  /** 一時ディレクトリ（DB・ワークスペース。close で消える） */
  dir: string;
  /** 作り物の時計の今の値（進めない。入れ終わった後は今の時刻） */
  clockNow: () => Date;
  /** 撮る画面の話題のチャンネル ID（open: 長い返事・perm: 許可の要求・q: 質問・talk: 吹き出しの確かめ・long: 長い会話・run: 実行中） */
  topics: { open: string; perm: string; q: string; talk: string; long: string; run: string };
  /**
   * Claude Code のチャンネル（cc: true で立てたときだけ）。queue: 届け待ちの送りが在る・ask: 許可の要求が在る・ended: 一覧に居ないセッション（終わった）。
   * reset は queue の届け待ちと ask の保留中の許可を新しく 1 行ずつにする（前の届け待ちは取り消し、前の保留は終わらせる。同じ段を幅ごとに繰り返すため）
   */
  cc?: { queue: string; ask: string; ended: string; reset: () => void };
  /** サーバーを閉じ、DB を閉じて一時ディレクトリを消す（2 回目以降は同じ Promise を返す） */
  close: () => Promise<void>;
};

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));

const LONG_REPLY = `## 家計簿アプリの集計の直し方

月ごとの合計がずれていた原因は、**タイムゾーン**の扱いでした。\`2026-10-31T23:30:00+09:00\` のような記録が UTC で 10 月 31 日 14:30 になり、境目の日付で別の月に入っていました。

### 直した所

- 集計の関数 \`sumByMonth\` で、日付を \`Asia/Tokyo\` の暦日に直してから月を取る
- 既存の記録は書き換えない（読むときに直す）
- テストに月末 23 時台の記録を 3 件足した
  - 10 月 31 日 23:30
  - 11 月 30 日 23:59
  - 12 月 31 日 23:00

### コード

\`\`\`ts
export function monthKeyOf(iso: string, timeZone = "Asia/Tokyo"): string {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit" }).formatToParts(new Date(iso));
  const year = parts.find((p) => p.type === "year")?.value;
  const month = parts.find((p) => p.type === "month")?.value;
  return \`\${year}-\${month}\`;
}
\`\`\`

### 結果

| 月 | 直す前 | 直した後 | 差 |
|---|---:|---:|---:|
| 2026-09 | 182,400 円 | 182,400 円 | 0 |
| 2026-10 | 201,950 円 | 204,330 円 | +2,380 |
| 2026-11 | 97,120 円 | 94,740 円 | -2,380 |

参考にしたページ: https://developer.mozilla.org/ja/docs/Web/JavaScript/Reference/Global_Objects/Intl/DateTimeFormat/formatToParts#very-long-anchor-to-check-wrapping-of-urls-in-the-chat-bubble

> 注意: 既に出した 10 月のレポートの PDF は古い数字のままです。作り直すなら言ってください。

1. テストは全部通りました（42 件）
2. 型チェックも通りました
3. まだ commit はしていません`;

/** 吹き出しの確かめの返事: 400 字の URL・行の中のコード・1 行 200 字のコードの段・箇条書き */
const TALK_WIDE_REPLY = `記録は \`data/watering.csv\` にあります。

https://example.com/garden/watering/${"a".repeat(364)}

\`\`\`
${"watering,".repeat(22)}xx
\`\`\`

- 朝 7 時に 200 ml
- 夕方 18 時に 150 ml`;

/** 吹き出しの確かめのオーナーの 600 字の発言（空白の無い 80 字の語を含む） */
const TALK_LONG_OWNER = `${"ベランダの鉢の水やりについて、季節ごとの量と時刻を見直したいです。".repeat(8)} ${"x".repeat(80)} ${"夏は朝と夕方の二回、冬は昼に一回にしたい。".repeat(12)}`.slice(0, 600);

/** Claude Code のセッション（作り物の UUID。数字の長い並びにしない）。A は作業中・B は判断待ち・C は一覧に居ない（終わった） */
const CC_A = "c0de0a01-0000-4000-8000-0000000000a1";
const CC_B = "c0de0b02-0000-4000-8000-0000000000b2";
const CC_C = "c0de0c03-0000-4000-8000-0000000000c3";
/** 画面の写し（tmux の capture-pane の代わりに返す数行） */
const CC_SCREEN = "見本の作業をしています\n\n> 次の指示を待っています\n";

/**
 * 作り物のデータの DB と本物の Web サーバーを立てる。log はサーバーの log の行（既定は捨てる）。
 * cc なら Claude Code の連携が動くとして、セッション 2 つ（一覧）と Claude Code のチャンネル 3 つ・届け待ち・許可の要求を足す（無ければ今までどおり何も足さない）
 */
export async function startFixtureServer(options: { log?: (line: string) => void; cc?: boolean } = {}): Promise<FixtureServer> {
  const log = options.log ?? (() => undefined);
  const tmp = mkdtempSync(join(tmpdir(), "self-agent-ui-shots-"));
  let db: ReturnType<typeof openDb> | undefined;
  let closeServer: (() => Promise<void>) | undefined;
  let closing: Promise<void> | undefined;
  const close = (): Promise<void> =>
    (closing ??= (async () => {
      try {
        await closeServer?.();
      } finally {
        try {
          db?.close();
        } finally {
          rmSync(tmp, { recursive: true, force: true });
        }
      }
    })());
  // 入れるときの時計: 2 時間前から 1 件ごとに 30 秒進める（240 件まで今より前に収まる）。入れ終わったら今の時刻
  let seeding: number | null = Date.now() - 2 * 3600_000;
  const now = (): Date => {
    if (seeding === null) return new Date();
    seeding += 30_000;
    return new Date(seeding);
  };
  const clockNow = (): Date => (seeding === null ? new Date() : new Date(seeding));
  try {
    const workspace = join(tmp, "workspace");
    for (const name of ["kakeibo-app", "garden-sensor", "blog-site", "General"]) mkdirSync(join(workspace, name), { recursive: true });
    mkdirSync(join(tmp, "projects"), { recursive: true });

    db = openDb(join(tmp, "self-agent.db"));
    const guildSettings = new GuildSettingsStore(db, now);
    const topicSessions = new TopicSessionStore(db, now);
    const history = new HistoryStore(db, now);
    const sessions = new SdkSessionStore(db, now);
    const permissions = new CcPermissionStore(db, now);
    const reads = new TopicReadStore(db, now);
    const projects = new ProjectStore(db, now);
    const tasks = new TaskStore(db, now);
    const reminders = new ReminderStore(db, now);
    const knowledge = new KnowledgeStore(db, now);
    const memories = new MemoryStore(db, now);
    const notices = new NoticeStore(db, now);
    const usage = new UsageStore(db, now);
    const attachments = new AttachmentStore(db, now);

    guildSettings.setChannel(GUILD, "inboxChannelId", INBOX);
    guildSettings.setChannel(GUILD, "tasksChannelId", TASKS);

    let nextId = 200;
    const say = (
      channelId: string,
      kind: "owner" | "agent" | "notice" | "divider",
      text: string,
      extra: { steps?: string[]; toolCalls?: number; durationMs?: number; outcome?: "done" | "max_turns" | "aborted" | "failed" } = {},
    ): void => {
      history.add({ guildId: GUILD, channelId, kind, source: kind === "owner" ? "web" : "system", text, ...(kind === "agent" ? { outcome: "done" } : {}), ...extra });
    };
    /** プロジェクトの話題の SDK セッション ID（作り物の UUID） */
    const sessionIdOf = (channelId: string): string => `${channelId.padStart(8, "0")}-0000-4000-8000-000000000000`;
    const topic = (title: string, project?: string): string => {
      const id = String(nextId++);
      topicSessions.create({ channelId: id, guildId: GUILD, title, categoryId: "c" });
      if (project !== undefined) {
        topicSessions.setProject(id, project, "default");
        sessions.set(id, sessionIdOf(id));
      }
      return id;
    };

    // プロジェクト: kakeibo-app（4 と完了 1）・garden-sensor（3）・blog-site（2）、General（2）
    const tOpen = topic("月ごとの集計がずれる", "kakeibo-app");
    say(tOpen, "owner", "10 月の合計が明細の足し算と合わない。原因を調べて直して");
    say(tOpen, "notice", "プロジェクト kakeibo-app で始めました");
    say(tOpen, "agent", "調べます。まず集計の関数と、10 月末の記録を見ます。");
    say(tOpen, "owner", "お願い。テストも足しておいて");
    say(tOpen, "agent", LONG_REPLY, { steps: ["Read src/summary.ts", "Grep sumByMonth", "Edit src/summary.ts", "Bash npm test"], toolCalls: 4, durationMs: 83_000 });
    say(tOpen, "owner", "ありがとう。commit して");
    const tPerm = topic("レシートの読み取りを OCR に置き換えるための下調べと、費用の見積もりと、移行の手順をまとめる", "kakeibo-app");
    say(tPerm, "owner", "OCR のライブラリを比べて、試しに 1 つ入れてみて");
    say(tPerm, "agent", "候補を 3 つ見つけました。試しに入れるので許可をください。");
    const tK3 = topic("CSV の書き出し", "kakeibo-app");
    say(tK3, "owner", "CSV で書き出せるようにして");
    say(tK3, "agent", "書き出しのボタンを足しました。");
    const tK4 = topic("カテゴリの色", "kakeibo-app");
    say(tK4, "owner", "カテゴリごとに色を付けたい");
    say(tK4, "agent", "8 色の案を出しました。");
    // 完了の話題（kakeibo-app の群に「完了（1）」を出す。見本の一覧と同じ、完了の在る群）
    const tKDone = topic("古い明細の取り込み", "kakeibo-app");
    say(tKDone, "owner", "去年の明細を取り込んで");
    say(tKDone, "agent", "取り込みました。");
    topicSessions.close(tKDone, "去年の明細を取り込んだ");
    const tQ = topic("センサーの送信間隔", "garden-sensor");
    say(tQ, "owner", "電池が早く減る。送信の間隔を見直して");
    say(tQ, "agent", "間隔の案が 2 つあります。どちらにするか選んでください。");
    const tRun = topic("土の湿り気のグラフ", "garden-sensor");
    say(tRun, "owner", "直近 1 週間の湿り気をグラフにして");
    const tG3 = topic("ファームウェアの更新手順を README に書く。古い手順は消して、写真も撮り直す前提で", "garden-sensor");
    say(tG3, "owner", "README に更新の手順を書いて");
    say(tG3, "agent", "書きました。写真の場所は空けてあります。");
    const tB1 = topic("記事の下書き", "blog-site");
    say(tB1, "owner", "秋の家庭菜園の記事の下書きを作って");
    say(tB1, "agent", "見出しを 5 つ立てて下書きを作りました。");
    const tB2 = topic("RSS", "blog-site");
    say(tB2, "owner", "RSS を出せるようにして");
    say(tB2, "agent", "feed.xml を作るようにしました。");
    const tGen1 = topic("週末の買い物");
    say(tGen1, "owner", "週末に買う物をまとめて");
    say(tGen1, "agent", "牛乳、卵、電池（単三 4 本）、腐葉土 1 袋です。");
    const tGen2 = topic("引っ越しの段取り");
    say(tGen2, "owner", "来月の引っ越しでやることを並べて");
    say(tGen2, "agent", "役所の手続き・電気とガス・ネットの移転・荷造りの順に並べました。");

    // 右腕（#inbox）
    say(INBOX, "owner", "今日の予定を教えて");
    say(INBOX, "agent", "今日は 14 時に歯医者、19 時に読書会です。");
    say(INBOX, "owner", "家計簿の話題はどこまで進んだ？");
    say(INBOX, "agent", "「月ごとの集計がずれる」で原因が分かり、直してテストも通っています。commit の指示を待っています。");
    say(INBOX, "owner", "ありがとう");
    say(INBOX, "agent", "どういたしまして。ほかにあれば言ってください。");

    // 既読: 未読を 2 つ（tK3・tB2）残し、ほかは読んだことにする
    for (const channelId of [tOpen, tPerm, tK4, tKDone, tQ, tRun, tG3, tB1, tGen1, tGen2, INBOX]) {
      const rows = history.list(channelId, { limit: 200 });
      reads.advance(channelId, Math.max(0, ...rows.map((row) => row.id)));
    }

    // タスク・ナレッジ・記憶・知らせ
    tasks.add({ title: "図書館の本を返す", due: "2026-11-20" });
    tasks.add({ title: "自転車のタイヤに空気を入れる" });
    tasks.add({ title: "年賀状の住所録を見直す。去年の分から引っ越した人を直して、ラベルの印刷までやる", due: "2026-12-10" });
    knowledge.add({
      url: "https://example.com/css-container",
      urlKey: "https://example.com/css-container",
      title: "CSS の container queries",
      summary: "要素の幅でレイアウトを切り替える。@container と container-type。",
      body: "## container queries\n\n親に `container-type: inline-size` を付け、子で `@container (min-width: 400px)` と書く。\n\n- 幅はコンテナの幅\n- メディアクエリと併用できる",
      tags: "CSS web",
    });
    knowledge.add({ title: "家庭菜園の土の配合", summary: "赤玉土 6・腐葉土 3・バーミキュライト 1", body: "秋植えの葉物は水はけを良くする。" });
    knowledge.add({ title: "Node の sqlite", summary: "DatabaseSync で同期の API", body: "node:sqlite は 22.5 から。" });
    memories.add("オーナーは朝 7 時に起きる");
    memories.add("返事は短めが好き");
    notices.add({ guildId: GUILD, level: "info", text: "再起動しました" });

    // 吹き出しの確かめ（General）。区切り・知らせ・長い URL・コードの段・失敗・中断・長い発言・手順 4 の返事（最後の行）
    const tTalk = topic("吹き出しの確かめ");
    say(tTalk, "owner", "庭の水やりの記録を見せて");
    say(tTalk, "agent", "見せます。");
    say(tTalk, "divider", "会話を新しくしました");
    say(tTalk, "notice", "記録のファイルを読み直しました");
    say(tTalk, "agent", TALK_WIDE_REPLY, { steps: ["Read data/watering.csv"], toolCalls: 1, durationMs: 21_000 });
    say(tTalk, "agent", "記録のファイルを開けませんでした。", { outcome: "failed" });
    say(tTalk, "agent", "途中で止めました。", { outcome: "aborted", steps: ["Read data/watering.csv", "Grep moisture"], toolCalls: 2, durationMs: 9_000 });
    say(tTalk, "owner", TALK_LONG_OWNER);
    say(tTalk, "agent", "水やりの間隔を 2 日ごとに直し、記録の表に列を 1 つ足しました。", {
      steps: ["Read data/watering.csv", "Edit data/watering.csv", "Edit src/schedule.ts", "Bash npm test"],
      toolCalls: 4,
      durationMs: 64_000,
    });
    // 長い会話（General）。60 行で、最初に出るのは後ろの 50 行。最後は手順の上限で止まった返事
    const tLong = topic("長い会話");
    for (let i = 1; i < 60; i += 2) {
      say(tLong, "owner", `${i} 番目の質問です。鉢の数はいくつ？`);
      if (i < 59) say(tLong, "agent", `${i + 1} 番目の返事です。鉢は ${(i % 7) + 2} つです。`);
    }
    say(tLong, "agent", "鉢の配置の案を作っている途中です。", {
      outcome: "max_turns",
      steps: ["Read data/pots.csv", "Edit data/pots.csv", "Bash npm run layout"],
      toolCalls: 40,
      durationMs: 12 * 60_000,
    });
    for (const channelId of [tTalk, tLong]) {
      const rows = history.list(channelId, { limit: 200 });
      reads.advance(channelId, Math.max(0, ...rows.map((row) => row.id)));
    }

    // 許可の要求（tPerm）と質問（tQ）は今の時刻で入れる（保留の秒数の中に入るように）
    if (seeding > Date.now()) throw new Error("作り物の時計が今を越えた（入れる件数に対して刻みが大きい）");
    seeding = null;
    permissions.add({ sessionId: sessionIdOf(tPerm), requestHash: "h1", toolName: "Bash", summary: "npm install tesseract.js@5.1.1", permissionMode: "default", state: "pending", origin: "sdk" });
    permissions.add({
      sessionId: sessionIdOf(tQ),
      requestHash: "h2",
      toolName: "AskUserQuestion",
      summary: "質問 1 問: 送信の間隔は？",
      permissionMode: "default",
      state: "pending",
      origin: "sdk",
      questionInput: JSON.stringify({
        questions: [
          {
            question: "送信の間隔はどちらにしますか？",
            header: "間隔",
            options: [
              { label: "10 分", description: "電池は 2 か月" },
              { label: "30 分", description: "電池は 5 か月" },
            ],
            multiSelect: false,
          },
        ],
      }),
    });

    // Claude Code（cc: true のときだけ）。入れるのは今の時刻（許可の要求が保留の秒数の中に入るように）
    const cc = options.cc === true ? seedCc(db, workspace, history, reads, () => String(nextId++)) : undefined;

    // 実行中のターン（tRun）。送信は受け付けず、[中断]・[続ける] は何もしない（LLM に出さない）
    const startedAt = new Date(Date.now() - 95_000).toISOString();
    const running = [
      {
        guildId: GUILD,
        channelId: tRun,
        turnSeq: 1,
        startedAt,
        toolCalls: 5,
        label: "Bash npm run chart",
        steps: ["Read data/moisture.csv", "Grep moisture", "Write src/chart.ts", "Edit src/chart.ts", "Bash npm run chart"],
        source: "web",
        abortable: true,
      } as RunningTurn,
    ];
    const handler = {
      runningTurns: (): RunningTurn[] => running,
      submitText: async (): Promise<SubmitTextResult> => ({ result: "not_accepted" }),
      abortTurn: (): boolean => false,
      continueTurn: async (): Promise<void> => undefined,
    };
    const personas = new PersonaRouter({
      personas: [{ id: "default", name: "default", engine: "claude", runner: {} as AgentRunner, gateway: {} as Gateway, connected: () => true }],
      guildSettings,
      topicSessions,
    });
    const cfg = {
      allowedGuildIds: [GUILD],
      personas: [],
      publicBaseUrl: undefined,
      inboxChannelId: undefined,
      workspaceDir: workspace,
      timeZone: "Asia/Tokyo",
      servePort: undefined,
      devMode: false,
      github: false,
      jobs: false,
      guest: false,
    };
    const resolveChannel = createChannelResolver(cfg, guildSettings, topicSessions);
    const places = { workspaceDir: workspace, protectedDirs: [], generalDir: "General" };
    // 既読・/messages と同じ引き方（Claude Code のチャンネルも通すのは cc のときだけ。本体の配線と同じ）
    const lookup = webChannelLookup({ cfg, resolveChannel, guildSettings, topicSessions, ...(cc === undefined ? {} : { ccChannels: cc.store }) });
    const projectPermissions = { store: permissions, sessions, holdSec: 3600, questionHoldSec: 3600 };
    const topicDeps = {
      cfg,
      guildSettings,
      topicSessions,
      history,
      personas,
      handler,
      places,
      home: "/home/owner",
      workspaceRoot: workspace,
      projectPermissions,
      reads: { store: reads, lookup },
      now,
      ...(cc === undefined ? {} : { cc: cc.topics }),
    };
    const noLog = (): void => undefined;
    const channelName = (id: string): string | null => topicSessions.get(id)?.title ?? (id === INBOX ? "#inbox" : null);
    const routes = [
      ...statusRoutes({
        cfg,
        version: () => "0.0.0-shots",
        startedAt: new Date(Date.now() - 3600_000),
        stopping: () => false,
        personas,
        shellState: { configured: false, enabled: () => false, failedItems: () => [] },
        queue: { runningSessionJobs: () => 0 },
        running: () => running.length,
        serving: () => false,
        guildSettings,
        env: {},
        ...(cc === undefined ? {} : { cc: cc.status }),
      }),
      ...usageRoutes({ cfg, usage, attachments, now }),
      ...channelRoutes({
        cfg,
        guildSettings,
        topicSessions,
        projects,
        history,
        personas,
        resolveChannel,
        reads,
        projectPermissions: { ...projectPermissions, now },
        ...(cc === undefined ? {} : { cc: cc.channels }),
      }),
      ...topicRoutes({ ...topicDeps, collect: createTopicCollector(topicDeps) }),
      ...turnRoutes({ cfg, guildSettings, topicSessions, resolveChannel, handler, now, log: noLog, ...(cc === undefined ? {} : { cc: cc.turns }) }),
      ...(cc === undefined ? [] : ccRoutes(cc.routes(lookup))),
      ...taskRoutes({ tasks, reminders, log: noLog }),
      ...reminderRoutes({ cfg, reminders, channelName, log: noLog }),
      ...memoryRoutes({ memories, log: noLog }),
      ...noticeRoutes({ notices, guildSettings, now }),
      ...knowledgeRoutes({ knowledge }),
      ...projectRoutes({ cfg, projects, projectsDir: join(tmp, "projects"), channelName, workspace: places }),
    ];
    const server = createWebServer({
      host: "127.0.0.1",
      port: 0,
      allowedLogin: FIXTURE_LOGIN,
      staticDir: join(REPO_ROOT, "src/web/static"),
      templateSiteDir: join(REPO_ROOT, "templates/web/site"),
      routes,
      stopping: () => false,
      now,
      log,
    });
    await server.start();
    closeServer = () => server.close();
    const port = server.address()?.port;
    if (port === undefined) throw new Error("Web サーバーが待ち受けていない");
    return {
      url: `http://127.0.0.1:${port}`,
      login: FIXTURE_LOGIN,
      dir: tmp,
      clockNow,
      topics: { open: tOpen, perm: tPerm, q: tQ, talk: tTalk, long: tLong, run: tRun },
      ...(cc === undefined ? {} : { cc: cc.fixture }),
      close,
    };
  } catch (error) {
    await close();
    throw error;
  }
}

/** Claude Code のセッションの一覧の 1 行（作り物。claude agents --json の代わり） */
function ccView(sessionId: string, name: string, cwd: string, state: "running" | "needs_input", pid: number): CcSessionView {
  const at = Date.now() - 4 * 60_000;
  return {
    sessionId,
    status: state === "running" ? "busy" : "waiting",
    pendingPermission: state === "needs_input",
    waitingKind: null,
    waitingSince: state === "needs_input" ? at : undefined,
    lastPromptAt: at,
    lastEventAt: at,
    transcriptLastAt: at,
    startedAt: at - 30 * 60_000,
    state,
    pid,
    name,
    cwd,
    kind: undefined,
    waitingFor: state === "needs_input" ? "permission" : undefined,
    lastPromptText: null,
    permissionMode: "default",
    lastActivityAt: at,
    bridgeSessionId: undefined,
    tmux: `tmux-shots/default,${pid},0`,
    startedBy: "web",
    trustPending: false,
    permission: undefined,
  };
}

/** tmux のペイン（作り物。一覧の pid ごとに 1 つ） */
function ccPane(pid: number, cwd: string): TmuxPane {
  return {
    sessionName: `shots-${pid}`,
    windowIndex: 0,
    paneIndex: 0,
    paneId: `%${pid}`,
    windowActive: true,
    paneActive: true,
    currentPath: cwd,
    currentCommand: "claude",
    inMode: false,
    dead: false,
    panePid: pid,
  };
}

/**
 * Claude Code の作り物（cc: true）。一覧・ペイン・画面の写し・送信の取り消し・許可の応答は偽物（行の状態を変えるだけ。tmux にも hook にも出ない）。
 * 表（cc_channels・cc_sends・cc_permissions）と、それを読むルートは本物
 */
function seedCc(
  db: ReturnType<typeof openDb>,
  workspace: string,
  history: HistoryStore,
  reads: TopicReadStore,
  nextChannelId: () => string,
) {
  const holdSec = 3600;
  const channelStore = new CcChannelStore(db);
  const sends = new CcSendStore(db);
  const permissions = new CcPermissionStore(db);
  const starts = new CcStartStore(db);
  const cwdA = join(workspace, "kakeibo-app");
  const cwdB = join(workspace, "garden-sensor");
  const cwdC = join(workspace, "blog-site");
  const views = [ccView(CC_A, "見本の作業", cwdA, "running", 4101), ccView(CC_B, "見本の確認", cwdB, "needs_input", 4102)];
  const registry = {
    snapshot: () => ({ sessions: views, stale: false, unreadable: false, fetchedAt: Date.now() }),
    touch: () => undefined,
  };
  const queue = nextChannelId();
  const ask = nextChannelId();
  const ended = nextChannelId();
  channelStore.create({ channelId: queue, guildId: GUILD, sessionId: CC_A, name: "cc-見本の作業", cwd: cwdA, origin: "web" });
  channelStore.create({ channelId: ask, guildId: GUILD, sessionId: CC_B, name: "cc-見本の確認", cwd: cwdB, origin: "permission" });
  channelStore.create({ channelId: ended, guildId: GUILD, sessionId: CC_C, name: "cc-見本の下書き", cwd: cwdC, origin: "web" });
  channelStore.setState(ended, "ended");
  const say = (channelId: string, kind: "owner" | "agent", text: string): void => {
    history.add({ guildId: GUILD, channelId, kind, source: kind === "owner" ? "web" : "system", text, ...(kind === "agent" ? { outcome: "done" } : {}) });
  };
  say(queue, "owner", "集計のテストを足して");
  say(queue, "agent", "テストを 3 件足しました。全部通っています。");
  say(queue, "owner", "README にも書いて");
  say(ask, "owner", "依存を新しくして");
  say(ask, "agent", "npm の依存を確かめます。");
  say(ended, "owner", "秋の記事の見出しを考えて");
  say(ended, "agent", "見出しを 5 つ考えました。");
  say(ended, "owner", "ありがとう");
  for (const channelId of [queue, ask, ended]) {
    const rows = history.list(channelId, { limit: 200 });
    reads.advance(channelId, Math.max(0, ...rows.map((row) => row.id)));
  }

  const reset = (): void => {
    for (const row of sends.listQueuedFor(CC_A)) sends.transition(row.id, ["queued"], "cancelled");
    sends.add({ sessionId: CC_A, text: "README にも書いて", origin: "web", state: "queued", channelId: queue });
    for (const row of permissions.listPending()) if (row.sessionId === CC_B) permissions.resolve(row.id, "expired", null);
    permissions.add({ sessionId: CC_B, requestHash: "shots-h1", toolName: "Bash", summary: "npm update --save", permissionMode: "default", state: "pending" });
  };
  reset();

  const hold = {
    answer: (id: number, decision: "allow" | "always" | "deny", via: "web" | "discord", requestHash?: string): CcAnswerResult => {
      const row = permissions.get(id);
      if (row === undefined) return { ok: false, reason: "not_found" };
      if (row.state !== "pending" || (requestHash !== undefined && requestHash !== row.requestHash)) return { ok: false, reason: "stale" };
      if (row.questionInput !== null && decision !== "deny") return { ok: false, reason: "stale" };
      if (decision === "always" && (row.alwaysRules === null || row.alwaysRules.length === 0)) return { ok: false, reason: "stale" };
      const to = decision === "deny" ? "denied" : decision === "always" ? "allowed_always" : "allowed";
      return permissions.resolve(id, to, via) ? { ok: true, state: to } : { ok: false, reason: "stale" };
    },
    // 質問の要求は入れていない
    answerQuestion: () => ({ ok: false as const, reason: "stale" as const }),
  };
  const sender = {
    submit: async () => ({ ok: false as const, reason: "stopped" as const }),
    cancel: (id: number): CcCancelResult => {
      if (sends.get(id) === undefined) return "not_found";
      return sends.transition(id, ["queued", "awaiting_confirm"], "cancelled") ? "cancelled" : "stale";
    },
  };
  const panes = {
    lookup: async () => {
      const byTmux = new Map(views.map((view) => [view.tmux, ccPane(view.pid, view.cwd ?? workspace)]));
      return {
        ok: true as const,
        find: (target: { pid: number; tmux: string | undefined }) => byTmux.get(target.tmux),
        sendable: () => ({ ok: false as const, reason: "not_in_tmux" as const }),
        pane: () => undefined,
      };
    },
  };
  const tmux = { capturePane: async () => ({ ok: true as const, value: CC_SCREEN }) };
  const hostChannels = {
    openChannel: async () => ({ ok: false as const, reason: "not_found" as const }),
    channelOf: (sessionId: string) => {
      const row = [queue, ask, ended].map((id) => channelStore.get(id)).find((r) => r !== undefined && r.sessionId === sessionId);
      return row;
    },
    defaultGuild: () => GUILD,
    close: () => ({ result: "ended" as const }),
    postClosed: () => undefined,
  };
  const permissionDeps = { store: permissions, holdSec, questionHoldSec: holdSec };
  // ~ は一時ディレクトリの作業場所にする（cwd はどれも作業場所の中で、相対で出る）
  const describe = ccChannelDescriber({ registry, workspaceDir: workspace, home: workspace, sends, permissions: permissionDeps });
  return {
    store: channelStore,
    fixture: { queue, ask, ended, reset },
    status: () => ({ ...CC_STATUS_DISABLED, enabled: true, hookPort: true, tmux: "ok" as const, multilineOk: true, pendingPermissions: permissions.countPending("hook") }),
    topics: { registry, channels: channelStore, permissions, sends, starts, holdSec, questionHoldSec: holdSec },
    channels: { store: channelStore, describe },
    turns: { store: channelStore, channels: { submitWeb: async () => ({ ok: false as const, reason: "stopped" as const }) }, registry },
    routes: (lookup: ReturnType<typeof webChannelLookup>): Parameters<typeof ccRoutes>[0] => ({
      registry,
      panes,
      tmux,
      workspaceDir: workspace,
      home: workspace,
      sender,
      sends,
      permissions: { hold, ...permissionDeps },
      channels: { store: hostChannels, allowedGuildIds: [GUILD], lookup },
    }),
  };
}
