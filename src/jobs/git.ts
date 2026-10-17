// 作業ジョブの host 側の git（docs/plan/coding-jobs.md §5.3・§6.1・§6.2）。アプリ（node）の特権の操作で、LLM のツールではない。
// execFile で起動時に解決した絶対パスの git を呼び、シェルを通さない。引数は固定の形。LLM が書けた作業場所の `.git` の上では
// git を動かさない: 作業場所からは objects とブランチの先端だけを隔離の場所に写し（設定・hooks・alternates は写さない）、
// アプリが作った bare に fetch してから、その bare の上で検査して push する。push 先は `refs/heads/self-agent/*` だけ・--force なし。
// 失敗は固定の語で返し、log・例外の message にリポジトリ名・URL・ブランチ名・パス・stderr を入れない
import { copyFileSync, lstatSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { removeTree } from "../agent/remove-tree.ts";
import { execFileRun, isOwner, isRepo, type RunCommand, type RunResult } from "../github/gh.ts";

/** ネットの操作（github.com への clone・fetch・push）の時間の上限（§5.3） */
export const GIT_NET_TIMEOUT_MS = 300_000;
/** それ以外の操作の時間の上限（§5.3） */
export const GIT_LOCAL_TIMEOUT_MS = 60_000;
/** 出力の上限（rev-list --objects の一覧が入る大きさ） */
export const GIT_MAX_BUFFER = 64 * 1024 * 1024;
/** 子の PATH（§5.3。git 自身は起動時に解決した絶対パスで呼ぶ） */
export const GIT_CHILD_PATH = "/usr/local/bin:/usr/bin:/bin";
/** 取り込みで写す objects の合計の上限（§5.3） */
export const IMPORT_MAX_BYTES = 1024 * 1024 * 1024;
/** push の前の検査で許す blob の大きさの上限（§6.1） */
export const BLOB_MAX_BYTES = 50 * 1024 * 1024;
/** ジョブのブランチの接頭辞（§6.2。push 先はこの下だけ） */
export const JOB_BRANCH_PREFIX = "self-agent/";

/** ref のファイル・packed-refs の読む大きさの上限 */
const LOOSE_REF_MAX_BYTES = 4096;
const PACKED_REFS_MAX_BYTES = 64 * 1024 * 1024;

/**
 * 失敗の固定の語（§13・§10）。clone_failed は準備の clone・fetch の失敗、branch_missing は続きでジョブのブランチがリモートに無い、
 * import_failed は取り込み（と、取り込んだものの上の検査の git が動かなかったとき）、not_fast_forward〜too_large は §6.1 の検査、
 * push_rejected・push_auth・push_failed は §6.2 の push（拒否・認証・それ以外）
 */
export type GitFailure =
  | "clone_failed"
  | "branch_missing"
  | "import_failed"
  | "not_fast_forward"
  | "no_commits"
  | "forbidden_path"
  | "bad_author"
  | "too_large"
  | "push_rejected"
  | "push_auth"
  | "push_failed";

export type GitOutcome<T = Record<never, never>> = ({ ok: true } & T) | { ok: false; failure: GitFailure };

/** 全コマンドに付ける設定（§5.3）。hooks を使わず、使えるプロトコルを https と file に絞る */
export const GIT_BASE_CONFIG_ARGS: readonly string[] = [
  "-c",
  "core.hooksPath=/dev/null",
  "-c",
  "protocol.allow=never",
  "-c",
  "protocol.https.allow=always",
  "-c",
  "protocol.file.allow=always",
];

/** credential helper の `!<gh> auth git-credential` に入れてよい gh のパス（git はこれをシェルで実行するので、空白・記号を含めない） */
const SAFE_GH_PATH_PATTERN = /^\/[A-Za-z0-9._/-]+$/;

export function isSafeGhPathForHelper(path: string): boolean {
  return SAFE_GH_PATH_PATTERN.test(path) && !path.split("/").includes("..");
}

/** 認証が要る操作（clone・fetch・push）だけに付ける設定（§5.3）。先に空にしてから gh を helper にする */
export function gitCredentialArgs(ghPath: string): string[] {
  if (!isSafeGhPathForHelper(ghPath)) throw new Error("gh のパスに使えない文字があります");
  return ["-c", "credential.https://github.com.helper=", "-c", `credential.https://github.com.helper=!${ghPath} auth git-credential`];
}

/**
 * git の子の env（§5.3。許可方式）。HOME（credential helper の gh が ~/.config/gh を読む）だけを写し、残りは固定の値。
 * system・global の設定を読まず、置き換えのオブジェクトを使わず、端末で尋ねない。トークン類・プロキシの変数は写さない
 */
export function gitChildEnv(source: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const env: Record<string, string> = {};
  if (source.HOME !== undefined) env.HOME = source.HOME;
  env.PATH = GIT_CHILD_PATH;
  env.LANG = "C.UTF-8";
  env.GIT_TERMINAL_PROMPT = "0";
  env.GIT_CONFIG_NOSYSTEM = "1";
  env.GIT_CONFIG_GLOBAL = "/dev/null";
  env.GIT_NO_REPLACE_OBJECTS = "1";
  env.GH_PROMPT_DISABLED = "1";
  return env;
}

const SHA_PATTERN = /^[0-9a-f]{40}$/;
const BRANCH_SEGMENT_PATTERN = /^[A-Za-z0-9_][A-Za-z0-9._-]*$/;

export function isSha(value: string): boolean {
  return SHA_PATTERN.test(value);
}

/**
 * ブランチ名として扱ってよい形か（`git check-ref-format --branch` で通る形のうち、英数字と `._-` と `/` の区切りだけ）。
 * 要素は `.`・`-` で始まらず、`.lock`・`.` で終わらず、`..` を含まない。base（既定のブランチ・PR の head）にも使う
 */
export function isBranchName(value: string): boolean {
  if (value.length === 0 || value.length > 255 || value.includes("..")) return false;
  return value.split("/").every((part) => BRANCH_SEGMENT_PATTERN.test(part) && !part.endsWith(".lock") && !part.endsWith("."));
}

/** ジョブのブランチか（§6.2）: `self-agent/` の下で、isBranchName を満たす */
export function isJobBranch(value: string): boolean {
  return value.startsWith(JOB_BRANCH_PREFIX) && value.length > JOB_BRANCH_PREFIX.length && isBranchName(value);
}

/** ジョブのブランチ名（§6.2。アプリが決める。第三者・LLM の文字列は入れない） */
export function jobBranch(jobId: number): string {
  if (!Number.isSafeInteger(jobId) || jobId <= 0) throw new Error("ジョブの id の形が違います");
  return `${JOB_BRANCH_PREFIX}job-${jobId}`;
}

/** 取り込んだ先端を置く bare の ref（§5.3） */
export function stagedRef(runId: number): string {
  if (!Number.isSafeInteger(runId) || runId <= 0) throw new Error("run の id の形が違います");
  return `refs/self-agent/staged/${runId}`;
}

/** github.com のリポジトリの URL（§5.3。owner・repo は gh.ts と同じ形だけ） */
export function githubRemoteUrl(owner: string, repo: string): string {
  if (!isOwner(owner) || !isRepo(repo)) throw new Error("リポジトリの名前の形が違います");
  return `https://github.com/${owner}/${repo}.git`;
}

const GITHUB_REMOTE_PATTERN = /^https:\/\/github\.com\/([^/]+)\/([^/]+)\.git$/;
const LOCAL_REMOTE_PATTERN = /^\/[A-Za-z0-9._/-]+$/;

/** リモートとして渡してよい形か: githubRemoteUrl の形か、記号の無い絶対パス（テスト・ローカルの bare） */
export function isAllowedRemote(remote: string): boolean {
  const match = GITHUB_REMOTE_PATTERN.exec(remote);
  if (match !== null) return isOwner(match[1]!) && isRepo(match[2]!);
  return LOCAL_REMOTE_PATTERN.test(remote) && !remote.split("/").includes("..");
}

function assertRemote(remote: string): void {
  if (!isAllowedRemote(remote)) throw new Error("リモートの形が違います");
}

function assertDir(path: string): void {
  if (!isAbsolute(path) || path.endsWith("/") || path.split("/").includes("..")) throw new Error("場所は末尾に / の無い絶対パスで指定してください");
}

function assertBranch(branch: string): void {
  if (!isBranchName(branch)) throw new Error("ブランチ名の形が違います");
}

/**
 * push の引数（§6.2）。送り元は 40 桁の sha、送り先は `refs/heads/self-agent/…` だけ。`--force` 系・`+`・`--mirror`・`--delete` は作らない。
 * 形が違えば実行せずに投げる（assertSafePushArgs でも同じことを確かめる）
 */
export function buildPushArgs(remote: string, sha: string, branch: string): string[] {
  assertRemote(remote);
  if (!isSha(sha)) throw new Error("push する先端の形が違います");
  if (!isJobBranch(branch)) throw new Error("push できるのは self-agent/ の下のブランチだけです");
  const args = ["push", "--porcelain", "--no-verify", remote, `${sha}:refs/heads/${branch}`];
  assertSafePushArgs(args);
  return args;
}

const FORBIDDEN_PUSH_OPTIONS = [
  "--force",
  "--force-with-lease",
  "--force-if-includes",
  "--mirror",
  "--delete",
  "--all",
  "--tags",
  "--prune",
  "-f",
  "-d",
];

/** push の引数が安全な形か（§6.2）。違えば投げる */
export function assertSafePushArgs(args: readonly string[]): void {
  if (args[0] !== "push") throw new Error("push の引数の形が違います");
  for (const arg of args) {
    if (FORBIDDEN_PUSH_OPTIONS.some((option) => arg === option || arg.startsWith(`${option}=`))) throw new Error("push に使えない引数です");
  }
  const refspecs = args.slice(1).filter((arg) => !arg.startsWith("-"));
  // [remote, refspec] の 2 つだけ
  if (refspecs.length !== 2) throw new Error("push の引数の形が違います");
  const refspec = refspecs[1]!;
  const colon = refspec.indexOf(":");
  if (refspec.startsWith("+") || colon === -1) throw new Error("push の送り先の形が違います");
  const destination = refspec.slice(colon + 1);
  if (!isSha(refspec.slice(0, colon))) throw new Error("push する先端の形が違います");
  if (!destination.startsWith("refs/heads/") || !isJobBranch(destination.slice("refs/heads/".length))) {
    throw new Error("push できるのは self-agent/ の下のブランチだけです");
  }
}

/** 写す objects の名前（ルーズオブジェクトとパック。info/（alternates・http-alternates・commit-graph など）は写さない） */
const LOOSE_DIR_PATTERN = /^[0-9a-f]{2}$/;
const LOOSE_FILE_PATTERN = /^[0-9a-f]{38}$/;
const PACK_FILE_PATTERN = /^pack-[0-9a-f]{40}\.(pack|idx)$/;

export type CopyObjectsResult =
  | { ok: true; files: number; bytes: number; skipped: number }
  | { ok: false; reason: "too_large" | "error" };

/**
 * 作業場所の `.git/objects` を隔離の場所の objects に写す（§5.3）。実際のファイル・ディレクトリだけで、symlink・FIFO などと
 * 決まった名前（`<2 桁>/<38 桁>`・`pack/pack-<40 桁>.pack|idx`）以外は飛ばして数える。合計が maxBytes を超えたら止める。
 * sandbox の中のプロセスが無いとき（I1）に呼ぶ前提なので、lstat と写すまでの間に差し替えられることは考えない
 */
export function copyObjects(sourceObjects: string, destinationObjects: string, maxBytes = IMPORT_MAX_BYTES): CopyObjectsResult {
  let files = 0;
  let bytes = 0;
  let skipped = 0;
  try {
    for (const name of readdirSync(sourceObjects)) {
      const source = join(sourceObjects, name);
      const stat = lstatSync(source);
      const isLooseDir = LOOSE_DIR_PATTERN.test(name);
      if (!stat.isDirectory() || (!isLooseDir && name !== "pack")) {
        skipped += 1;
        continue;
      }
      const filePattern = isLooseDir ? LOOSE_FILE_PATTERN : PACK_FILE_PATTERN;
      const destinationDir = join(destinationObjects, name);
      mkdirSync(destinationDir, { recursive: true });
      for (const fileName of readdirSync(source)) {
        const file = join(source, fileName);
        const fileStat = lstatSync(file);
        if (!fileStat.isFile() || !filePattern.test(fileName)) {
          skipped += 1;
          continue;
        }
        bytes += fileStat.size;
        if (bytes > maxBytes) return { ok: false, reason: "too_large" };
        copyFileSync(file, join(destinationDir, fileName));
        files += 1;
      }
    }
  } catch {
    return { ok: false, reason: "error" };
  }
  return { ok: true, files, bytes, skipped };
}

/** path が実際のディレクトリか（symlink はたどらない） */
function isRealDir(path: string): boolean {
  try {
    return lstatSync(path).isDirectory();
  } catch {
    return false;
  }
}

/**
 * 作業場所の `.git` からブランチの先端を読む（§5.3。git は使わない）。`refs/heads/<branch>` のファイル（途中の要素はどれも実際の
 * ディレクトリ、最後は実際のファイル）か、無ければ `packed-refs` の該当行から 40 桁の 16 進だけを読む。symbolic ref・形の違うもの・
 * 無いものは undefined（HEAD は見ない）
 */
export function readBranchTip(gitDir: string, branch: string): string | undefined {
  assertBranch(branch);
  const parts = ["refs", "heads", ...branch.split("/")];
  let path = gitDir;
  let loose: "missing" | "found" = "found";
  for (const [index, part] of parts.entries()) {
    path = join(path, part);
    let stat;
    try {
      stat = lstatSync(path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        loose = "missing";
        break;
      }
      return undefined;
    }
    const last = index === parts.length - 1;
    if (last ? !stat.isFile() : !stat.isDirectory()) return undefined;
    if (last && stat.size > LOOSE_REF_MAX_BYTES) return undefined;
  }
  if (loose === "found") {
    const match = /^([0-9a-f]{40})\n?$/.exec(readText(path) ?? "");
    return match === null ? undefined : match[1];
  }
  const packed = join(gitDir, "packed-refs");
  let stat;
  try {
    stat = lstatSync(packed);
  } catch {
    return undefined;
  }
  if (!stat.isFile() || stat.size > PACKED_REFS_MAX_BYTES) return undefined;
  const name = `refs/heads/${branch}`;
  for (const line of (readText(packed) ?? "").split("\n")) {
    const match = /^([0-9a-f]{40}) (\S+)$/.exec(line);
    if (match !== null && match[2] === name) return match[1];
  }
  return undefined;
}

function readText(path: string): string | undefined {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
}

/** diff-tree の 1 つのパスが `.github/` を変えたものか（§6.1。大文字小文字を問わない） */
export function isForbiddenPath(path: string): boolean {
  const lower = path.toLowerCase();
  return lower === ".github" || lower.startsWith(".github/");
}

export type GitClientOptions = {
  /** 起動時に解決した git の絶対パス */
  gitPath: string;
  /** 起動時に解決した gh の絶対パス（credential helper に使う。空白・記号を含まないこと） */
  ghPath: string;
  run?: RunCommand;
  /** 子の env の元（既定 process.env）。gitChildEnv で許可したものだけを渡す */
  sourceEnv?: NodeJS.ProcessEnv;
  /** 失敗の 1 行（操作と種類だけ）。既定は何もしない */
  log?: (message: string) => void;
  /** 隔離の場所を消す（既定 removeTree） */
  removeTree?: (path: string) => Promise<void>;
};

type GitCall = {
  /** log に出す操作の名前（固定の語） */
  op: string;
  args: readonly string[];
  /** 認証が要るネットの操作（credential の設定を付け、時間の上限を長くする） */
  network?: boolean;
  /** `-C` で移る場所（既定 `/`。リポジトリの場所は --git-dir で渡すので、親の作業ディレクトリのリポジトリを読まない） */
  cwd?: string;
  input?: string;
};

/** 作業ジョブの host 側の git。どれも reject せず、失敗は GitFailure で返す（引数の形が違うときだけ実行せずに投げる） */
export class GitClient {
  private readonly gitPath: string;
  private readonly credentialArgs: readonly string[];
  private readonly run: RunCommand;
  private readonly env: Record<string, string>;
  private readonly log: (message: string) => void;
  private readonly removeTree: (path: string) => Promise<void>;

  constructor(options: GitClientOptions) {
    if (!isAbsolute(options.gitPath)) throw new Error("git のパスは絶対パスにしてください");
    this.gitPath = options.gitPath;
    this.credentialArgs = gitCredentialArgs(options.ghPath);
    this.run = options.run ?? execFileRun;
    this.env = gitChildEnv(options.sourceEnv);
    this.log = options.log ?? (() => {});
    this.removeTree = options.removeTree ?? removeTree;
  }

  /** 実行して結果を返す。0 で終わらなければ log に操作と種類を 1 行 */
  private async git(call: GitCall): Promise<RunResult> {
    const args = ["-C", call.cwd ?? "/", ...GIT_BASE_CONFIG_ARGS, ...(call.network === true ? this.credentialArgs : []), ...call.args];
    const result = await this.run(this.gitPath, args, {
      env: { ...this.env },
      timeoutMs: call.network === true ? GIT_NET_TIMEOUT_MS : GIT_LOCAL_TIMEOUT_MS,
      maxBuffer: GIT_MAX_BUFFER,
      ...(call.input === undefined ? {} : { input: call.input }),
    });
    if (result.kind !== "exited" || result.code !== 0) this.log(`ジョブの git が失敗しました（${call.op}・${describe(result)}）`);
    return result;
  }

  /** 準備（初回）: リモートの base だけを bare に clone する（§5.3 の 1） */
  async cloneBare(input: { remote: string; base: string; bareDir: string }): Promise<GitOutcome> {
    assertRemote(input.remote);
    assertBranch(input.base);
    assertDir(input.bareDir);
    const result = await this.git({
      op: "clone",
      network: true,
      args: ["clone", "--bare", "--single-branch", "--branch", input.base, "--no-tags", "--template=", "--", input.remote, input.bareDir],
    });
    return succeeded(result) ? { ok: true } : { ok: false, failure: "clone_failed" };
  }

  /**
   * 準備（続き）: 同じ bare にリモートの base とジョブのブランチを取り直す（§5.3 の 1・§10）。bare は clone と同じく
   * `refs/heads/<名前>` にリモートの先端を持つ（作業用の clone がそのまま --branch で使えるように）。ジョブのブランチが
   * リモートに無ければ branch_missing
   */
  async fetchBare(input: { remote: string; base: string; branch: string; bareDir: string }): Promise<GitOutcome> {
    assertRemote(input.remote);
    assertBranch(input.base);
    if (!isJobBranch(input.branch)) throw new Error("ジョブのブランチの形が違います");
    assertDir(input.bareDir);
    const result = await this.git({
      op: "fetch",
      network: true,
      args: [
        `--git-dir=${input.bareDir}`,
        "fetch",
        "--no-tags",
        "--no-write-fetch-head",
        "--",
        input.remote,
        `+refs/heads/${input.base}:refs/heads/${input.base}`,
        `+refs/heads/${input.branch}:refs/heads/${input.branch}`,
      ],
    });
    if (succeeded(result)) return { ok: true };
    const missing = result.kind === "exited" && /couldn't find remote ref refs\/heads\//.test(result.stderr) && result.stderr.includes(input.branch);
    return { ok: false, failure: missing ? "branch_missing" : "clone_failed" };
  }

  /**
   * 準備: bare から作業用の clone を作る（§5.3 の 1）。checkout（base かジョブのブランチ）を取り出し、newBranch があれば
   * そこから作って切り替える。origin を消し、commit の author を `git config --local` に書く。作業場所がまだ LLM に
   * 渡っていないときに呼ぶ
   */
  async prepareWorkspace(input: {
    bareDir: string;
    repoDir: string;
    checkout: string;
    newBranch?: string;
    author: { name: string; email: string };
  }): Promise<GitOutcome> {
    assertDir(input.bareDir);
    assertDir(input.repoDir);
    assertBranch(input.checkout);
    if (input.newBranch !== undefined && !isJobBranch(input.newBranch)) throw new Error("ジョブのブランチの形が違います");
    assertAuthor(input.author);
    const steps: GitCall[] = [
      {
        op: "clone",
        args: ["clone", "--no-local", "--no-tags", "--template=", "--branch", input.checkout, "--", input.bareDir, input.repoDir],
      },
      ...(input.newBranch === undefined ? [] : [{ op: "switch", cwd: input.repoDir, args: ["switch", "--no-track", "-c", input.newBranch] }]),
      { op: "remote", cwd: input.repoDir, args: ["remote", "remove", "origin"] },
      { op: "config", cwd: input.repoDir, args: ["config", "--local", "user.name", input.author.name] },
      { op: "config", cwd: input.repoDir, args: ["config", "--local", "user.email", input.author.email] },
    ];
    for (const step of steps) {
      if (!succeeded(await this.git(step))) return { ok: false, failure: "clone_failed" };
    }
    return { ok: true };
  }

  /**
   * 取り込み（§5.3 の 3）。repoDir・`.git`・`.git/objects` が実際のディレクトリか確かめ、ブランチの先端をファイルから読み、
   * 隔離の場所（quarantineDir。あれば先に消す）を `git init --bare --template=` で作って objects を写し、先端を
   * `refs/heads/out` に書いて、bare に transfer.fsckObjects で fetch する（`refs/self-agent/staged/<runId>`）。隔離の場所は
   * 最後に消す。どこで失敗しても import_failed
   */
  async importWork(input: {
    repoDir: string;
    branch: string;
    quarantineDir: string;
    bareDir: string;
    runId: number;
  }): Promise<GitOutcome<{ sha: string; ref: string }>> {
    assertDir(input.repoDir);
    if (!isJobBranch(input.branch)) throw new Error("ジョブのブランチの形が違います");
    assertDir(input.quarantineDir);
    assertDir(input.bareDir);
    const ref = stagedRef(input.runId);
    const gitDir = join(input.repoDir, ".git");
    const objects = join(gitDir, "objects");
    const fail = (reason: string): GitOutcome<{ sha: string; ref: string }> => {
      this.log(`ジョブの git が失敗しました（import・${reason}）`);
      return { ok: false, failure: "import_failed" };
    };
    if (!isRealDir(input.repoDir) || !isRealDir(gitDir) || !isRealDir(objects)) return fail("not_directory");
    const sha = readBranchTip(gitDir, input.branch);
    if (sha === undefined) return fail("no_branch");
    try {
      // 前に残ったものがあれば消す（無ければ何もしない）
      await this.removeTree(input.quarantineDir);
      if (!succeeded(await this.git({ op: "init", args: ["init", "--bare", "--quiet", "--template=", "--", input.quarantineDir] }))) {
        return { ok: false, failure: "import_failed" };
      }
      const copied = copyObjects(objects, join(input.quarantineDir, "objects"));
      if (!copied.ok) return fail(copied.reason);
      const quarantine = `--git-dir=${input.quarantineDir}`;
      if (!succeeded(await this.git({ op: "update-ref", args: [quarantine, "update-ref", "refs/heads/out", sha] }))) {
        return { ok: false, failure: "import_failed" };
      }
      const fetched = await this.git({
        op: "fetch",
        args: [
          `--git-dir=${input.bareDir}`,
          "-c",
          "transfer.fsckObjects=true",
          "fetch",
          "--no-tags",
          "--no-write-fetch-head",
          "--",
          input.quarantineDir,
          `refs/heads/out:${ref}`,
        ],
      });
      if (!succeeded(fetched)) return { ok: false, failure: "import_failed" };
      const staged = await this.revParse(input.bareDir, ref);
      if (staged !== sha) return fail("mismatch");
      return { ok: true, sha, ref };
    } finally {
      try {
        await this.removeTree(input.quarantineDir);
      } catch {
        this.log("ジョブの git が失敗しました（import・cleanup）");
      }
    }
  }

  /** bare の ref（か sha）の指すコミットの sha。無ければ undefined */
  async revParse(bareDir: string, ref: string): Promise<string | undefined> {
    assertDir(bareDir);
    if (!isSha(ref) && !/^refs\/[A-Za-z0-9._/-]+$/.test(ref)) throw new Error("ref の形が違います");
    const result = await this.git({
      op: "rev-parse",
      args: [`--git-dir=${bareDir}`, "rev-parse", "--verify", "--quiet", "--end-of-options", `${ref}^{commit}`],
    });
    if (!succeeded(result)) return undefined;
    const sha = result.stdout.trim();
    return isSha(sha) ? sha : undefined;
  }

  /**
   * push の前の検査（§6.1。bare の上だけ）。上から順に: staged が base を祖先に持つ（not_fast_forward）、base..staged のコミットが
   * 1 つ以上（no_commits）、どのコミットも `.github/` を変えていない（forbidden_path。マージは各親との差分で見る）、author・committer の
   * email がすべて authorEmail（bad_author）、新しいオブジェクトに BLOB_MAX_BYTES を超える blob が無い（too_large）。
   * 検査の git が動かなければ import_failed
   */
  async inspect(input: { bareDir: string; base: string; staged: string; authorEmail: string }): Promise<GitOutcome<{ commits: number }>> {
    assertDir(input.bareDir);
    if (!isSha(input.base) || !isSha(input.staged)) throw new Error("検査する先端の形が違います");
    const gitDir = `--git-dir=${input.bareDir}`;
    const range = `${input.base}..${input.staged}`;
    const broken: GitOutcome<{ commits: number }> = { ok: false, failure: "import_failed" };

    const ancestor = await this.git({ op: "merge-base", args: [gitDir, "merge-base", "--is-ancestor", input.base, input.staged] });
    if (ancestor.kind !== "exited" || (ancestor.code !== 0 && ancestor.code !== 1)) return broken;
    if (ancestor.code === 1) return { ok: false, failure: "not_fast_forward" };

    const list = await this.git({ op: "rev-list", args: [gitDir, "rev-list", range] });
    if (!succeeded(list)) return broken;
    const commits = list.stdout.split("\n").filter((line) => line !== "");
    if (!commits.every(isSha)) return broken;
    if (commits.length === 0) return { ok: false, failure: "no_commits" };

    const paths = await this.git({
      op: "diff-tree",
      args: [
        gitDir,
        "diff-tree",
        "--stdin",
        "-r",
        "-m",
        "--root",
        "-z",
        "--name-only",
        "--no-renames",
        "--no-ext-diff",
        "--no-textconv",
        "--no-commit-id",
      ],
      input: `${commits.join("\n")}\n`,
    });
    if (!succeeded(paths)) return broken;
    if (paths.stdout.split("\0").some((path) => path !== "" && isForbiddenPath(path))) return { ok: false, failure: "forbidden_path" };

    const idents = await this.git({ op: "rev-list", args: [gitDir, "rev-list", "--no-commit-header", "--format=%ae%x00%ce", range] });
    if (!succeeded(idents)) return broken;
    const emails = idents.stdout.split("\n").filter((line) => line !== "").flatMap((line) => line.split("\0"));
    if (emails.length !== commits.length * 2) return broken;
    if (emails.some((email) => email !== input.authorEmail)) return { ok: false, failure: "bad_author" };

    const objects = await this.git({
      op: "rev-list",
      args: [gitDir, "rev-list", "--objects", "--no-object-names", `--filter=blob:limit=${BLOB_MAX_BYTES + 1}`, "--filter-print-omitted", range],
    });
    if (!succeeded(objects)) return broken;
    if (objects.stdout.split("\n").some((line) => line.startsWith("~"))) return { ok: false, failure: "too_large" };

    return { ok: true, commits: commits.length };
  }

  /**
   * push（§6.2）。bare から `<sha>:refs/heads/<branch>`（branch は self-agent/ の下だけ）。--force なし・hooks なし。
   * 拒否（porcelain の `!` の行）は push_rejected、認証の失敗は push_auth、それ以外は push_failed
   */
  async push(input: { bareDir: string; remote: string; sha: string; branch: string }): Promise<GitOutcome> {
    assertDir(input.bareDir);
    const pushArgs = buildPushArgs(input.remote, input.sha, input.branch);
    const result = await this.git({ op: "push", network: true, args: [`--git-dir=${input.bareDir}`, ...pushArgs] });
    if (succeeded(result)) return { ok: true };
    if (result.kind !== "exited") return { ok: false, failure: "push_failed" };
    if (result.stdout.split("\n").some((line) => line.startsWith("!\t"))) return { ok: false, failure: "push_rejected" };
    if (AUTH_FAILURE_PATTERN.test(result.stderr)) return { ok: false, failure: "push_auth" };
    return { ok: false, failure: "push_failed" };
  }
}

/** push の stderr のうち認証・権限の失敗の文 */
const AUTH_FAILURE_PATTERN = /Authentication failed|could not read Username|terminal prompts disabled|Permission to \S+ denied|returned error: 403/i;

function succeeded(result: RunResult): result is { kind: "exited"; code: 0; stdout: string; stderr: string } {
  return result.kind === "exited" && result.code === 0;
}

function describe(result: RunResult): string {
  if (result.kind === "exited") return result.code === null ? "signal" : `exit ${result.code}`;
  if (result.kind === "too_large") return "output_too_large";
  if (result.kind === "error") return "spawn";
  return "timeout";
}

/** commit の author（noreply）として config に書いてよい形か。改行などの制御文字と `<>` を含めない */
function assertAuthor(author: { name: string; email: string }): void {
  const ok = (value: string) => value.length > 0 && value.length <= 256 && !/[\u0000-\u001f\u007f<>]/.test(value);
  if (!ok(author.name) || !ok(author.email) || !author.email.includes("@")) throw new Error("commit の author の形が違います");
}
