// Claude Code のセッションの表示の部品（Web・Discord・ツールで共通。純関数）

/** cwd の表示（`~/workspace/` からの相対。その外で ~ の中なら `~/…`、それ以外はそのまま）。無ければ null */
export function cwdLabel(cwd: string | undefined, workspaceDir: string, home: string): string | null {
  if (cwd === undefined || cwd === "") return null;
  const within = (base: string): string | undefined => {
    const root = base.replace(/\/+$/, "");
    if (root === "") return undefined;
    if (cwd === root) return "";
    return cwd.startsWith(`${root}/`) ? cwd.slice(root.length + 1) : undefined;
  };
  const inWorkspace = within(workspaceDir);
  if (inWorkspace !== undefined && inWorkspace !== "") return inWorkspace;
  const inHome = within(home);
  if (inHome !== undefined) return inHome === "" ? "~" : `~/${inHome}`;
  return cwd;
}
