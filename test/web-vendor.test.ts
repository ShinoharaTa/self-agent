import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { staticFileFor } from "../src/web/static.ts";
import { buildVendorFiles, VENDOR_SOURCES, vendorText } from "../scripts/vendor-web.ts";

// Preact + htm の同梱（scripts/vendor-web.ts）と部品の入口（c-lib.js）・見本のページ（gallery.html。docs/plan/web-ui-components.md の K1）
const ROOT = fileURLToPath(new URL("../", import.meta.url));
const STATIC_DIR = join(ROOT, "src/web/static");
const DIRS = { staticDir: STATIC_DIR, templateSiteDir: join(ROOT, "templates/web/site") };
const read = (name: string): string => readFileSync(join(STATIC_DIR, name), "utf8");
const VENDOR_FILES = ["vendor-preact.js", "vendor-preact-hooks.js", "vendor-htm.js"];
const devDependencies = (JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as { devDependencies: Record<string, string> }).devDependencies;

/** node_modules の版。無い（npm ci --omit=dev）・package.json と違うときは、何をすればよいか分かる文で落とす */
function nodeModulesVersion(pkg: "preact" | "htm"): string {
  const file = join(ROOT, "node_modules", pkg, "package.json");
  if (!existsSync(file)) assert.fail(`${pkg} が node_modules に無い（devDependencies。npm ci）`);
  const version = (JSON.parse(readFileSync(file, "utf8")) as { version: string }).version;
  assert.equal(version, devDependencies[pkg], `${pkg}: node_modules が package.json と違う。npm ci をしてから`);
  return version;
}

test("web vendor: src/web/static/ の vendor-* は VENDOR_SOURCES の 3 つだけ（手で足した物を通さない）", () => {
  const names = readdirSync(STATIC_DIR).filter((n) => n.startsWith("vendor-"));
  assert.deepEqual(names.sort(), VENDOR_SOURCES.map((source) => source.out).sort());
  assert.deepEqual([...VENDOR_FILES].sort(), names);
});

test("web vendor: commit した vendor の 3 つが、今の node_modules から scripts/vendor-web.ts で作り直した物とバイトで一致する", () => {
  // 版のずれ・node_modules に無いときは「作り直す」でなく npm ci を促す
  nodeModulesVersion("preact");
  nodeModulesVersion("htm");
  const made = buildVendorFiles(join(ROOT, "node_modules"));
  assert.deepEqual([...made.keys()].sort(), [...VENDOR_FILES].sort());
  for (const [name, text] of made) {
    assert.ok(Buffer.from(text, "utf8").equals(readFileSync(join(STATIC_DIR, name))), `${name}: npm run vendor-web で作り直す`);
  }
});

test("web vendor: 裸の指定・sourceMappingURL・eval・new Function が無く、先頭のコメントに名前・版・ライセンスがある", () => {
  const versions: Record<string, string> = { preact: nodeModulesVersion("preact"), htm: nodeModulesVersion("htm") };
  for (const source of VENDOR_SOURCES) {
    const text = read(source.out);
    assert.doesNotMatch(text, /\b(?:from|import)\s*(["'])(?![./])[^"']*\1/, `${source.out}: 裸の指定`);
    assert.doesNotMatch(text, /sourceMappingURL/, source.out);
    assert.doesNotMatch(text, /\beval\(|new Function\b|\bFunction\(/, source.out);
    const first = text.split("\n")[0] ?? "";
    assert.ok(first.startsWith(`/* ${source.label} ${versions[source.pkg]} — `), `${source.out}: ${first}`);
    assert.ok(first.includes(`${source.copyright.replace(/\.$/, "")}. `), `${source.out}: 著作権の行`);
    assert.match(first, /THIRD_PARTY_LICENSES\.md/);
  }
  assert.match(read("vendor-preact-hooks.js"), /from"\.\/vendor-preact\.js"/);
});

test("web vendor: vendorText は preact の裸の指定を書き換え、同梱の 3 つ以外の指定・動的な import が残れば例外にする", () => {
  const header = { label: "x", version: "1.0.0", license: "MIT", copyright: "Copyright 2000 X" };
  assert.equal(
    vendorText('import{a}from"preact";import "preact";export{a};\n//# sourceMappingURL=x.map\n', header),
    '/* x 1.0.0 — MIT. Copyright 2000 X. THIRD_PARTY_LICENSES.md. npm run vendor-web で作る（手で直さない） */\nimport{a}from"./vendor-preact.js";import "./vendor-preact.js";export{a};\n',
  );
  assert.doesNotThrow(() => vendorText('import{a}from"./vendor-htm.js";export*from"./vendor-preact-hooks.js";', header));
  assert.throws(() => vendorText('import{b}from"preact/hooks";', header), /同梱の 3 つ以外/);
  assert.throws(() => vendorText("import x from 'other';", header), /同梱の 3 つ以外/);
  assert.throws(() => vendorText('import{c}from"./chunk.mjs";', header), /同梱の 3 つ以外/);
  assert.throws(() => vendorText('export*from"x";', header), /同梱の 3 つ以外/);
  assert.throws(() => vendorText('const m=import("x");', header), /動的な import/);
});

test("web vendor: c-lib.js を Node で import でき、html は vnode を返す", async () => {
  // 素の JS で型が無いので、URL を変数にして型の解決を避ける
  const libUrl = new URL("../src/web/static/c-lib.js", import.meta.url).href;
  const lib = (await import(libUrl)) as Record<string, unknown> & {
    html: (strings: TemplateStringsArray, ...values: unknown[]) => { type: unknown; props: Record<string, unknown> };
  };
  const vnode = lib.html`<p class="x">a</p>`;
  assert.equal(vnode.type, "p");
  assert.equal(vnode.props.class, "x");
  for (const name of ["h", "render", "Fragment", "useState", "useEffect", "useLayoutEffect", "useRef", "useMemo", "useCallback"]) {
    assert.ok(lib[name] !== undefined, name);
  }
});

test("web vendor: 部品（c-*.js）は vendor を直に読まず c-lib.js から import し、htm に style= と dangerouslySetInnerHTML を書かない", () => {
  // Preact は style の prop を style.cssText で入れるので CSP（style-src 'self'）では止まらない。決まりとテストで止める
  const parts = readdirSync(STATIC_DIR).filter((n) => /^c-.*\.js$/.test(n) && n !== "c-lib.js");
  assert.ok(parts.length > 0);
  for (const name of parts) {
    const js = read(name);
    assert.doesNotMatch(js, /vendor-/, name);
    assert.match(js, /from "\.\/c-lib\.js"/, name);
    assert.doesNotMatch(js, /\bstyle=/, `${name}: style=`);
    assert.doesNotMatch(js, /dangerouslySetInnerHTML|innerHTML/, name);
  }
});

test("web vendor: gallery.html に inline の script・style・style= と on…= が無く、app.css・shell.css を読まず、指すファイルは配れて実在する", () => {
  const html = read("gallery.html");
  for (const m of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)) {
    assert.match(m[1] ?? "", /\bsrc="/, "src の無い script");
    assert.equal((m[2] ?? "").trim(), "", "script の中身");
  }
  assert.doesNotMatch(html, /<style\b/i);
  assert.doesNotMatch(html, /\sstyle=/i);
  assert.doesNotMatch(html, /\son[a-z]+=/i);
  // c-shell.css は当たらない（名前の頭がスラッシュの物だけ）
  assert.doesNotMatch(html, /\/(?:app|shell)\.css/);
  const refs = [...html.matchAll(/<(?:link|script)\b[^>]*\b(?:href|src)="([^"]+)"/g)].map((m) => m[1] ?? "");
  assert.deepEqual(refs, ["/static/base.css", "/static/tokens.css", "/static/c-atoms.css", "/static/c-sheet.css", "/static/c-list.css", "/static/c-shell.css", "/static/c-talk.css", "/static/c-composer.css", "/static/c-cards.css", "/static/c-hand.css", "/static/c-term.css", "/static/c-deck.css", "/static/c-gallery.css", "/static/c-gallery.js"]);
  for (const ref of refs) {
    const target = staticFileFor(ref, DIRS);
    assert.ok(target !== undefined, `${ref}: 配れない名前`);
    assert.ok(existsSync(target.file), `${ref}: ${target.file} が無い`);
  }
  assert.match(html, /<script type="module" src="\/static\/c-gallery\.js"><\/script>/);
  assert.match(html, /<html lang="ja" data-theme="dark">/);
  assert.match(html, /<meta name="viewport" content="[^"]*viewport-fit=cover/);
  assert.match(html, /<title>部品の見本<\/title>/);
  assert.match(html, /<div class="c-gallery" id="gallery"><\/div>/);
});

test("web vendor: c-gallery.css のセレクタは .c-gallery 始まりだけで、色の値を直に書かない", () => {
  const css = read("c-gallery.css").replace(/\/\*[\s\S]*?\*\//g, "");
  const selectors = [...css.matchAll(/([^{}]+)\{/g)].flatMap((m) => (m[1] ?? "").split(",").map((s) => s.trim()));
  assert.ok(selectors.length > 0);
  for (const selector of selectors) assert.match(selector, /^\.c-gallery(?:-[a-z]+)*(?::[a-z-]+)?$/, selector);
  assert.doesNotMatch(css, /#[0-9a-f]{3,8}\b|rgba?\(|hsla?\(/i);
});

test("web vendor: package.json の実行時の依存は 3 つのまま、preact・htm は devDependencies に exact で", () => {
  const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as { dependencies: Record<string, string>; devDependencies: Record<string, string> };
  assert.equal(Object.keys(pkg.dependencies).length, 3);
  assert.equal(pkg.devDependencies.preact, "11.2.0");
  assert.equal(pkg.devDependencies.htm, "3.1.1");
});

test("web vendor: THIRD_PARTY_LICENSES.md は preact・htm の LICENSE の全文を含み、見出しの版は node_modules の版", () => {
  const text = readFileSync(join(ROOT, "THIRD_PARTY_LICENSES.md"), "utf8");
  for (const pkg of ["preact", "htm"] as const) {
    const version = nodeModulesVersion(pkg);
    assert.ok(text.includes(readFileSync(join(ROOT, "node_modules", pkg, "LICENSE"), "utf8").trimEnd()), `${pkg}: LICENSE の全文`);
    assert.match(text, new RegExp(`^## ${pkg} ${version.replaceAll(".", "\\.")}$`, "m"), `${pkg}: 見出しの版`);
  }
});
