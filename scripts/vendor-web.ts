// Web UI の部品が使う Preact と htm の同梱（npm run vendor-web。docs/plan/web-ui-components.md §8・K1）。
// node_modules の ESM（各 package の exports が指すもの）を src/web/static/vendor-*.js に写す。変換は 3 つだけ:
// 裸の指定（from"preact" など）を ./vendor-preact.js に、`//# sourceMappingURL=` の行を消す、先頭に名前・版・ライセンスの 1 行。
// 変換の後に動的な import( か、同梱の 3 つ以外の指定が残れば例外（黙って書かない）。直に走らせたときだけ書き、テストが import したときは書かない
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

type Source = {
  /** 書き出す名前（src/web/static/ の直下） */
  out: string;
  /** 先頭のコメントに出す名前 */
  label: string;
  /** 版とライセンスを読む package（node_modules/<pkg>/package.json） */
  pkg: string;
  /** node_modules からのパス（package.json の exports の import / default が指す ESM） */
  file: string;
  /** 先頭のコメントに出す著作権の行（各 package の LICENSE の文のまま） */
  copyright: string;
};

/** 写すもの。preact は exports["."].default、preact/hooks は exports["./hooks"].default、htm は exports["."].import */
export const VENDOR_SOURCES: readonly Source[] = [
  { out: "vendor-preact.js", label: "preact", pkg: "preact", file: "preact/dist/preact.mjs", copyright: "Copyright (c) 2015-present Jason Miller" },
  { out: "vendor-preact-hooks.js", label: "preact/hooks", pkg: "preact", file: "preact/hooks/dist/hooks.mjs", copyright: "Copyright (c) 2015-present Jason Miller" },
  { out: "vendor-htm.js", label: "htm", pkg: "htm", file: "htm/dist/htm.mjs", copyright: "Copyright 2018 Google Inc." },
];

/** 書き換える裸の指定（`from"preact"`・`from "preact"`・`import"preact"`・`import "preact"`） */
const PREACT_SPECIFIER = /\b(from|import)(\s*)(["'])preact\3/g;
/** 静的な指定（`from "…"`・`import "…"`。`export … from "…"` も from で拾う） */
const STATIC_SPECIFIER = /\b(?:from|import)\s*(["'])([^"']*)\1/g;
/** 動的な import（同梱では解決できないので例外） */
const DYNAMIC_IMPORT = /\bimport\s*\(/;
/** 変換の後に許す指定（同梱の 3 つだけ） */
const ALLOWED_SPECIFIERS: ReadonlySet<string> = new Set(VENDOR_SOURCES.map((source) => `./${source.out}`));
const SOURCE_MAP_LINE = /^\/\/# sourceMappingURL=.*(?:\n|$)/gm;

/** 1 つのファイルの変換（純粋な関数） */
export function vendorText(code: string, header: { label: string; version: string; license: string; copyright: string }): string {
  const body = code.replace(PREACT_SPECIFIER, "$1$2$3./vendor-preact.js$3").replace(SOURCE_MAP_LINE, "");
  const dynamic = DYNAMIC_IMPORT.exec(body);
  if (dynamic !== null) throw new Error(`vendor-web: ${header.label} に動的な import がある: ${dynamic[0]}`);
  for (const m of body.matchAll(STATIC_SPECIFIER)) {
    if (!ALLOWED_SPECIFIERS.has(m[2] ?? "")) throw new Error(`vendor-web: ${header.label} に同梱の 3 つ以外の指定が残っている: ${m[0]}`);
  }
  const comment = `/* ${header.label} ${header.version} — ${header.license}. ${header.copyright.replace(/\.$/, "")}. THIRD_PARTY_LICENSES.md. npm run vendor-web で作る（手で直さない） */\n`;
  return comment + (body.endsWith("\n") ? body : body + "\n");
}

/** node_modules から 3 つのファイルの名前と中身を作る（書かない） */
export function buildVendorFiles(nodeModulesDir: string): Map<string, string> {
  const files = new Map<string, string>();
  for (const source of VENDOR_SOURCES) {
    const pkg = JSON.parse(readFileSync(join(nodeModulesDir, source.pkg, "package.json"), "utf8")) as { version: string; license: string };
    const code = readFileSync(join(nodeModulesDir, source.file), "utf8");
    files.set(source.out, vendorText(code, { label: source.label, version: pkg.version, license: pkg.license, copyright: source.copyright }));
  }
  return files;
}

if (import.meta.main) {
  const nodeModulesDir = fileURLToPath(new URL("../node_modules/", import.meta.url));
  const outDir = fileURLToPath(new URL("../src/web/static/", import.meta.url));
  const files = buildVendorFiles(nodeModulesDir);
  for (const [name, text] of files) writeFileSync(join(outDir, name), text);
  console.log(`vendor-web: ${files.size} 個のファイルを書きました`);
}
