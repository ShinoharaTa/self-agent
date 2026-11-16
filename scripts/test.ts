// npm test の入口（#401）。/dev/shm（tmpfs）が在って書けるなら、その下に自分の一時ディレクトリを作って TMPDIR に向け、
// 子の `node --test` を走らせる（一時 DB の同期がメモリの上で済むので速い）。SELF_AGENT_TEST_TMP=disk か、作れなければ今までどおり。
// `npm test -- <引数>` の引数は既定の glob の代わりに渡す（`--` で始まるものは node の option として前に置く）。
// 子が終わったら（SIGINT・SIGTERM・SIGHUP で止めたときも、子が終わってから）作ったディレクトリを消し、子の exit code で終わる。
// 出力は子のものだけ（消せなかった・起動できなかったときだけ 1 行）
import { spawn } from "node:child_process";
import { accessSync, constants, mkdtempSync, rmSync, statSync } from "node:fs";

const DEFAULT_GLOB = "test/*.test.ts";

/** 一時ディレクトリを作る場所。disk の指定か、shm がディレクトリで書けなければ undefined（今までどおり） */
export function pickTmpBase(mode: string | undefined, shm = "/dev/shm"): string | undefined {
  if (mode === "disk") return undefined;
  try {
    if (!statSync(shm).isDirectory()) return undefined;
    accessSync(shm, constants.W_OK);
    return shm;
  } catch {
    return undefined;
  }
}

/** `node` に渡す引数。`--` で始まるものは option として前に、ほかは glob の代わりに後ろに */
export function testArgs(args: readonly string[]): string[] {
  const options = args.filter((arg) => arg.startsWith("--"));
  const files = args.filter((arg) => !arg.startsWith("--"));
  return [...options, "--test", ...(files.length > 0 ? files : [DEFAULT_GLOB])];
}

const SIGNAL_CODES = { SIGINT: 130, SIGTERM: 143, SIGHUP: 129 } as const;

if (import.meta.main) {
  const base = pickTmpBase(process.env.SELF_AGENT_TEST_TMP);
  let dir: string | undefined;
  if (base !== undefined) {
    try {
      dir = mkdtempSync(`${base}/self-agent-test-`);
    } catch {
      dir = undefined;
    }
  }
  const env = dir === undefined ? process.env : { ...process.env, TMPDIR: dir };
  const child = spawn(process.execPath, testArgs(process.argv.slice(2)), { stdio: "inherit", env });
  let stoppedBy: keyof typeof SIGNAL_CODES | undefined;
  for (const signal of Object.keys(SIGNAL_CODES) as Array<keyof typeof SIGNAL_CODES>) {
    process.on(signal, () => {
      stoppedBy ??= signal;
      child.kill(signal);
    });
  }
  /** 作ったディレクトリを消す。消せなくても（テストが権限を落としたまま止まった等）子の結果は変えない */
  const cleanup = (): void => {
    if (dir === undefined) return;
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      console.error("npm test: 一時ディレクトリを消せませんでした（/dev/shm の self-agent-test-* を手で消してください）");
    }
  };
  child.on("error", () => {
    cleanup();
    console.error("npm test: node --test を起動できませんでした");
    process.exit(1);
  });
  child.on("exit", (code, signal) => {
    cleanup();
    if (stoppedBy !== undefined) process.exit(SIGNAL_CODES[stoppedBy]);
    process.exit(signal === null ? (code ?? 1) : 1);
  });
}
