// プロジェクトのセッションの共有の link（docs/plan/unify.md §5.3 (ii)・§6.1 の 8。U1b）。Bot 専用の CLAUDE_CONFIG_DIR の skills・agents を
// ~/.claude の同じ名前への symlink にして、Claude Code と同じ skills・サブエージェントを読ませる。CLAUDE.md は link しない
// （~/.claude/CLAUDE.md は CONFIG_DIR によらず読まれる。U0）。link を作るのはオーナー（npm run unify-setup -- --print の行）で、self-agent は
// 起動時に有無と向きを確かめるだけ（~/.claude にも CONFIG_DIR にも書かない）
import { existsSync, lstatSync, realpathSync } from "node:fs";
import { join } from "node:path";

/** 共有する名前（CONFIG_DIR と ~/.claude の直下） */
export const UNIFY_SHARED_LINKS: readonly string[] = ["skills", "agents"];

/**
 * 1 つの link の状態。ok: symlink で realpath が ~/.claude/<名前> の realpath と同じ。missing: 何も無い。not_symlink: symlink 以外がある。
 * wrong_target: symlink だが向きが違う（先が無いものを含む）。no_source: ~/.claude/<名前> が無い
 */
export type SharedLinkState = "ok" | "missing" | "not_symlink" | "wrong_target" | "no_source";

export type SharedLink = { name: string; link: string; target: string; state: SharedLinkState };

export type SharedLinksCheck = { ok: boolean; links: SharedLink[] };

function realOrUndefined(path: string): string | undefined {
  try {
    return realpathSync(path);
  } catch {
    return undefined;
  }
}

/** CONFIG_DIR の skills・agents が ~/.claude の同じ名前への symlink か（読むだけ。例外は投げない） */
export function checkSharedLinks(claudeConfigDir: string, home: string): SharedLinksCheck {
  const links = UNIFY_SHARED_LINKS.map((name): SharedLink => {
    const link = join(claudeConfigDir, name);
    const target = join(home, ".claude", name);
    const realTarget = realOrUndefined(target);
    let state: SharedLinkState;
    let isLink: boolean;
    try {
      isLink = lstatSync(link).isSymbolicLink();
    } catch {
      return { name, link, target, state: realTarget === undefined ? "no_source" : "missing" };
    }
    if (!isLink) state = "not_symlink";
    else if (realTarget === undefined) state = "no_source";
    else state = realOrUndefined(link) === realTarget ? "ok" : "wrong_target";
    return { name, link, target, state };
  });
  return { ok: links.every((link) => link.state === "ok"), links };
}

/** その場所に何かあるか（symlink はたどらない） */
function lexists(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
}

/** シェルの単引用符で囲む */
function quote(path: string): string {
  return `'${path.replaceAll("'", "'\\''")}'`;
}

/**
 * npm run unify-setup -- --print の行（純関数に近い。CONFIG_DIR と link の場所に何かあるかだけ見る）。無いものは `ln -s` の行（CONFIG_DIR が無ければ先に mkdir -p）、
 * ~/.claude/<名前> が無ければ（no_source）先にそれを mkdir -p してから続ける（link の場所に既に何かあれば、作った後にもう一度実行する案内）。
 * 済んだものは「済」、それ以外は理由の文（コメントの行。消す・退けるコマンドは出さない）
 */
export function unifySetupLines(claudeConfigDir: string, home: string, check: SharedLinksCheck = checkSharedLinks(claudeConfigDir, home)): string[] {
  const lines: string[] = [];
  const linkAbsent = (link: SharedLink): boolean => !lexists(link.link);
  if (check.links.some((link) => (link.state === "missing" || link.state === "no_source") && linkAbsent(link)) && !existsSync(claudeConfigDir)) {
    lines.push(`mkdir -p ${quote(claudeConfigDir)}`);
  }
  for (const link of check.links) {
    switch (link.state) {
      case "ok":
        lines.push(`# ${link.name}: 済`);
        break;
      case "missing":
        lines.push(`ln -s ${quote(link.target)} ${quote(link.link)}`);
        break;
      case "not_symlink":
        lines.push(`# ${link.name} が symlink ではありません。退けてから作ってください`);
        break;
      case "wrong_target":
        lines.push(`# ${link.name} の symlink の向きが ~/.claude/${link.name} ではありません。消してから作ってください`);
        break;
      case "no_source":
        lines.push(`mkdir -p ${quote(link.target)}`);
        if (linkAbsent(link)) lines.push(`ln -s ${quote(link.target)} ${quote(link.link)}`);
        else lines.push(`# ${link.name}: ~/.claude/${link.name} を作った後に、もう一度実行してください`);
        break;
    }
  }
  return lines;
}
