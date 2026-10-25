// ゲスト利用の 2 つの変数（ゲスト Bot のトークンと API キー）を端末で対話式に訊き、~/.config/self-agent/env に書く（npm run guest-setup [-- --skip-check]。#151）。
// v3 で廃止した SELF_AGENT_GUEST_GUILD_IDS の行が env にあれば、消すか確認する（docs/plan/guest-mode.md §3.2.1・§5）。
// 書く前に Discord と Claude に実際に通るか確かめ（--skip-check で飛ばす）、元のファイルの控えを env.bak に取ってから一時ファイル → rename で置き換える。
// 途中で中止・確認に失敗したら何も書かない。反映は Bot の再起動。
// トークン・API キー・サーバー ID・Bot の id・例外のメッセージは画面に出さない（出すのは Bot の名前・件数・変数名・HTTP の status・env と控え・一時ファイルのパスだけ）
import { chmod, lstat, mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline/promises";
import { StringDecoder } from "node:string_decoder";
import { parseArgs } from "node:util";
import { DEFAULT_GUEST_MODEL } from "../src/config.ts";
import {
  extractDiscordBotId,
  GUEST_DEPRECATED_ENV_KEYS,
  GUEST_ENV_KEYS,
  removeEnvLines,
  upsertEnvLines,
  validateApiKey,
  validateDiscordToken,
} from "../src/guest/setup-env.ts";

const USAGE = "使い方: npm run guest-setup [-- --skip-check]";
const HELP = [
  USAGE,
  "ゲスト Bot のトークンと Claude Platform の API キーの 2 つを訊き、~/.config/self-agent/env に書きます（反映は Bot の再起動）。",
  "サーバーの許可は認証コードで行うので、サーバー ID は訊きません。廃止した SELF_AGENT_GUEST_GUILD_IDS の行があれば消すか訊きます。",
  "--skip-check: 書く前の Discord・Claude への接続の確認を飛ばす",
].join("\n");
/** 1 回の fetch の上限 */
const FETCH_TIMEOUT_MS = 10_000;
/** 各項目で空の Enter がこの回数続いたら中止する */
const MAX_EMPTY_ANSWERS = 3;
/** 伏せ字の入力が \r で確定した後、別に届く \n を読み捨てる猶予 */
const STRAY_LF_WINDOW_MS = 50;
const DISCORD_API = "https://discord.com/api/v10";
const DISCORD_USER_AGENT = "DiscordBot (https://github.com/ShinoharaTa/self-agent, 0)";
const ANTHROPIC_API = "https://api.anthropic.com/v1";
const [TOKEN_KEY, API_KEY_KEY] = GUEST_ENV_KEYS;

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

/** 端末を戻して中止する（Ctrl-C は 130、それ以外は 1）。何も書かない */
function abort(code: 1 | 130): never {
  restoreTerminal();
  console.error("中止しました");
  process.exit(code);
}

function restoreTerminal(): void {
  if (process.stdin.isTTY && process.stdin.isRaw) process.stdin.setRawMode(false);
}

let values: { "skip-check"?: boolean; help?: boolean };
try {
  ({ values } = parseArgs({ options: { "skip-check": { type: "boolean" }, help: { type: "boolean" } } }));
} catch {
  fail(USAGE);
}
if (values.help === true) {
  console.log(HELP);
  process.exit(0);
}

if (!(process.stdin.isTTY && process.stdout.isTTY)) fail("端末で実行してください");
process.on("exit", restoreTerminal);

/** 表示ありの 1 行。Ctrl-C は中止、Ctrl-D（EOF）は null。都度 interface を作って閉じる（stdin のリスナーを残さない） */
async function readVisible(prompt: string): Promise<string | null> {
  const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
  let interrupted = false;
  rl.on("SIGINT", () => {
    interrupted = true;
    rl.close();
  });
  try {
    return await new Promise<string | null>((resolve) => {
      rl.question(prompt).then(resolve, () => resolve(null));
      rl.once("close", () => resolve(null));
    });
  } finally {
    rl.close();
    if (interrupted) {
      process.stdout.write("\n");
      abort(130);
    }
  }
}

/**
 * 伏せ字の 1 行（raw mode で 1 文字ずつ読み、1 文字ごとに * を出す）。Enter で確定、Backspace で 1 文字消す、Ctrl-C で中止、
 * 空のときの Ctrl-D は null。貼り付けで複数文字が一度に来ても文字ごとに扱い、Enter の後の残り（\r\n の \n など）は捨てる。
 * \r が chunk の最後で確定したら、確定から STRAY_LF_WINDOW_MS の間に次に届く chunk の先頭の \n を 1 つだけ捨て、残りは stdin に戻す
 * （\r と \n が別の chunk で来る貼り付けで、次の入力の空の Enter にしない）。矢印キーなどのエスケープシーケンスは読み飛ばす
 */
function readHidden(prompt: string): Promise<string | null> {
  const stdin = process.stdin;
  return new Promise((resolve) => {
    const decoder = new StringDecoder("utf8");
    let buffer = "";
    // 0: 通常、1: ESC の直後、2: CSI / SS3 の中（終わりの文字まで読み飛ばす）
    let escape = 0;
    const finish = (value: string | null, awaitStrayLf = false): void => {
      stdin.removeListener("data", onData);
      process.stdout.write("\n");
      const done = (): void => {
        stdin.setRawMode(false);
        stdin.pause();
        resolve(value);
      };
      if (!awaitStrayLf) {
        done();
        return;
      }
      const onStray = (chunk: Buffer | string): void => {
        clearTimeout(timer);
        stdin.removeListener("data", onStray);
        stdin.pause();
        const raw = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
        const rest = raw[0] === 0x0a ? raw.subarray(1) : raw;
        if (rest.length > 0) stdin.unshift(rest);
        done();
      };
      const timer = setTimeout(() => {
        stdin.removeListener("data", onStray);
        done();
      }, STRAY_LF_WINDOW_MS);
      stdin.on("data", onStray);
    };
    const onData = (chunk: Buffer | string): void => {
      const text = typeof chunk === "string" ? chunk : decoder.write(chunk);
      let offset = 0;
      for (const char of text) {
        offset += char.length;
        const code = char.codePointAt(0) ?? 0;
        if (escape === 1) {
          escape = char === "[" || char === "O" ? 2 : 0;
          continue;
        }
        if (escape === 2) {
          if (code >= 0x40 && code <= 0x7e) escape = 0;
          continue;
        }
        if (char === "\r" || char === "\n") {
          finish(buffer, char === "\r" && offset === text.length);
          return;
        }
        if (char === "\x03") {
          stdin.removeListener("data", onData);
          process.stdout.write("\n");
          abort(130);
        }
        if (char === "\x04") {
          if (buffer === "") {
            finish(null);
            return;
          }
          continue;
        }
        if (char === "\x7f" || char === "\b") {
          if (buffer !== "") {
            buffer = [...buffer].slice(0, -1).join("");
            process.stdout.write("\b \b");
          }
          continue;
        }
        if (char === "\x1b") {
          escape = 1;
          continue;
        }
        if (code < 0x20) continue;
        buffer += char;
        process.stdout.write("*");
      }
    };
    process.stdout.write(prompt);
    stdin.setRawMode(true);
    stdin.on("data", onData);
    stdin.resume();
  });
}

/** [y/N] の確認。y（大文字小文字を問わない）だけが true。Ctrl-C は中止 */
async function confirm(prompt: string): Promise<boolean> {
  const answer = await readVisible(`${prompt} [y/N] `);
  return answer !== null && answer.trim().toLowerCase() === "y";
}

/** 形が通るまで訊き直す。Ctrl-D・空の Enter 3 回で中止（exit 1）。返すのは trim した値 */
async function ask(
  prompt: string,
  read: (prompt: string) => Promise<string | null>,
  check: (value: string) => string | undefined,
): Promise<string> {
  let empty = 0;
  for (;;) {
    const answer = await read(prompt);
    if (answer === null) abort(1);
    const value = answer.trim();
    if (value === "") {
      empty += 1;
      if (empty >= MAX_EMPTY_ANSWERS) abort(1);
      console.error("入力してください（空の Enter が 3 回続くと中止します）");
      continue;
    }
    const reason = check(value);
    if (reason === undefined) return value;
    console.error(reason);
  }
}

function envList(value: string | undefined): string[] {
  return (value ?? "")
    .split(",")
    .map((item) => item.trim())
    .filter((item) => item !== "");
}

// ---- env ファイルの場所と今の中身 ----
const envPath = join(process.env.HOME ?? homedir(), ".config", "self-agent", "env");
const backupPath = `${envPath}.bak`;

let original: string | undefined;
let originalMode: number | undefined;
try {
  const stat = await lstat(envPath);
  if (!stat.isFile()) fail("env が通常のファイルではありません");
  originalMode = stat.mode & 0o777;
  original = await readFile(envPath, "utf8");
} catch (error) {
  // ディレクトリが無いときも ENOENT（無い）として扱う。作るのは書き込みの確認の後
  if ((error as NodeJS.ErrnoException).code !== "ENOENT") fail(`${envPath} を読めませんでした`);
}
if (original === undefined) console.log(`${envPath} はまだ無いので新しく作ります`);
else console.log(`env: ${envPath}`);

const present = GUEST_ENV_KEYS.filter((key) => process.env[key] !== undefined);
if (present.length > 0) {
  if (!(await confirm(`既に設定されています（${present.join(", ")}）。上書きしますか？`))) {
    console.log("何も書きませんでした");
    process.exit(0);
  }
}

// ---- 入力 ----
const otherTokens: Array<[string, string | undefined]> = [
  ["DISCORD_TOKEN", process.env.DISCORD_TOKEN?.trim()],
  ...envList(process.env.SELF_AGENT_PERSONAS).map((id): [string, string | undefined] => {
    const name = `SELF_AGENT_PERSONA_${id.toUpperCase()}_DISCORD_TOKEN`;
    return [name, process.env[name]?.trim()];
  }),
];
const token = await ask("ゲスト Bot のトークン（伏せ字）: ", readHidden, (value) => {
  const reason = validateDiscordToken(value);
  if (reason !== undefined) return reason;
  const same = otherTokens.find(([, other]) => other !== undefined && other !== "" && other === value);
  if (same !== undefined) return `${same[0]} と同じトークンです。ゲスト専用の Bot のトークンを入れてください`;
  return undefined;
});

const apiKey = await ask("Claude Platform の API キー（伏せ字）: ", readHidden, validateApiKey);

// ---- 接続の確認 ----
/** 1 回の GET。投げたら（時間切れ・DNS など）相手の名前だけを出して止める */
async function get(url: string, headers: Record<string, string>, peer: string): Promise<Response> {
  try {
    return await fetch(url, { headers, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  } catch {
    fail(`${peer} に接続できませんでした`);
  }
}

/** 応答の JSON。読めなければ undefined（投げない） */
async function readJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return undefined;
  }
}

function discard(response: Response): void {
  void response.body?.cancel().catch(() => {});
}

if (values["skip-check"] === true) {
  console.log("接続の確認を飛ばします（--skip-check）");
} else {
  const discordHeaders = { Authorization: `Bot ${token}`, "User-Agent": DISCORD_USER_AGENT };

  const me = await get(`${DISCORD_API}/users/@me`, discordHeaders, "Discord");
  if (me.status === 429) {
    discard(me);
    fail("Discord のレート制限です（HTTP 429）。少し待って再実行してください");
  }
  if (me.status !== 200) {
    discard(me);
    fail(`Discord がトークンを受け付けませんでした（HTTP ${me.status}）`);
  }
  const meBody = await readJson(me);
  if (typeof meBody !== "object" || meBody === null) fail("Discord の応答の形が想定と違います");
  const { username, id } = meBody as { username?: unknown; id?: unknown };
  const expectedId = extractDiscordBotId(token);
  if (expectedId !== undefined && id !== expectedId) {
    console.warn("警告: トークンの先頭から読んだ Bot の id が /users/@me の応答と合いません（トークンの形が変わった可能性があります）");
  }
  if (typeof username === "string") {
    // 制御文字（端末の制御を含む）を落として 32 字まで
    console.log(`ゲスト Bot: ${[...username.replace(/\p{C}/gu, "")].slice(0, 32).join("")}`);
  }

  const guilds = await get(`${DISCORD_API}/users/@me/guilds`, discordHeaders, "Discord");
  const guildsBody = guilds.status === 200 ? await readJson(guilds) : undefined;
  if (guilds.status !== 200) discard(guilds);
  if (guilds.status !== 200 || !Array.isArray(guildsBody)) {
    console.warn(`警告: サーバーの一覧を取れませんでした（HTTP ${guilds.status}）`);
  } else {
    console.log(`参加しているサーバー: ${guildsBody.length} 件`);
  }

  const model = process.env.SELF_AGENT_GUEST_MODEL?.trim() || DEFAULT_GUEST_MODEL;
  const models = await get(
    `${ANTHROPIC_API}/models/${encodeURIComponent(model)}`,
    { "x-api-key": apiKey, "anthropic-version": "2023-06-01" },
    "Claude（api.anthropic.com）",
  );
  discard(models);
  if (models.status === 200) console.log(`API キー: OK（${model}）`);
  else if (models.status === 429) fail("Claude のレート制限です（HTTP 429）。少し待って再実行してください");
  else if (models.status === 401 || models.status === 403) {
    fail(`Claude が API キーを受け付けませんでした（HTTP ${models.status}）`);
  } else if (models.status === 404) console.warn(`警告: API キーは通りましたが、モデル ${model} が見つかりません`);
  else fail(`確認できませんでした（HTTP ${models.status}）`);
}

// ---- 書き込み ----
// v3 で廃止した行（残っていると起動時に設定エラー）。消すかは確認する
let base = original ?? "";
let removed: string[] = [];
const deprecated = removeEnvLines(base, GUEST_DEPRECATED_ENV_KEYS);
if (deprecated.removed.length > 0) {
  if (await confirm(`v3 で廃止された行があります（${deprecated.removed.join(", ")}）。消しますか？`)) {
    base = deprecated.text;
    removed = deprecated.removed;
  } else {
    console.warn(`残します。${deprecated.removed.join(", ")} が残っていると、起動時に設定エラーになります`);
  }
}
const update = upsertEnvLines(base, [
  [TOKEN_KEY, token],
  [API_KEY_KEY, apiKey],
]);
const changes = [
  update.replaced.length > 0 ? `置き換え: ${update.replaced.join(", ")}` : undefined,
  update.appended.length > 0 ? `追加: ${update.appended.join(", ")}` : undefined,
  removed.length > 0 ? `削除: ${removed.join(", ")}` : undefined,
].filter((item) => item !== undefined);
const backupNote = original === undefined ? "新しいファイルを作ります" : `控えを ${backupPath} に取ります`;
if (
  !(await confirm(
    `${envPath} に次の変数を書きます: ${GUEST_ENV_KEYS.join(", ")}（${changes.join("／")}）。${backupNote}。よろしいですか？`,
  ))
) {
  console.log("何も書きませんでした");
  process.exit(0);
}

/**
 * 一時ファイル（`<target>.tmp-<pid>`。wx・600）に書いてから rename で target を置き換える。前回の一時ファイルが残っていれば
 * それには触らずに止める。それ以外の失敗は一時ファイルを消してから止める
 */
async function replaceFile(target: string, text: string, failMessage: string): Promise<void> {
  const tmpPath = `${target}.tmp-${process.pid}`;
  try {
    // wx: 既にあるもの（symlink を含む）には書かない
    await writeFile(tmpPath, text, { mode: 0o600, flag: "wx" });
    await chmod(tmpPath, 0o600);
    await rename(tmpPath, target);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      fail(`前回の一時ファイルが残っています: ${tmpPath}。消してから再実行してください`);
    }
    await unlink(tmpPath).catch(() => {});
    fail(failMessage);
  }
}

try {
  await mkdir(dirname(envPath), { recursive: true, mode: 0o700 });
} catch {
  fail(`${dirname(envPath)} を作れませんでした`);
}

if (original !== undefined) {
  // 控えの場所が symlink などなら止める
  try {
    const stat = await lstat(backupPath);
    if (!stat.isFile()) fail(`${backupPath} が通常のファイルではないため、控えを取れません。何も書きませんでした`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") fail(`${backupPath} を確かめられませんでした。何も書きませんでした`);
  }
  // 読んである元の中身を書く（既存の控えの inode には書かない）
  await replaceFile(backupPath, original, `控えを ${backupPath} に取れませんでした。何も書きませんでした`);
}

await replaceFile(envPath, update.text, `${envPath} に書けませんでした`);

if (originalMode !== undefined && originalMode !== 0o600) {
  console.log(`元の env の権限は ${originalMode.toString(8)} でした。新しい env は 600 です`);
}
console.log(
  "書き込みました。反映には Bot の再起動が必要です: `systemctl --user stop self-agent` の後、README の手順で起動し直してください。" +
    "起動ログに `discord(guest):` の接続の行が出れば動いています",
);
