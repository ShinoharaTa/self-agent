import { test } from "node:test";
import assert from "node:assert/strict";
import { extractUrls, MAX_URLS } from "../src/app/urls.ts";

test("extractUrls: http(s) の URL を出現順に取り出す", () => {
  assert.deepEqual(extractUrls("これ読んで https://example.com/a?q=1 と http://example.org/b"), [
    "https://example.com/a?q=1",
    "http://example.org/b",
  ]);
  assert.deepEqual(extractUrls("https://example.com/a\nhttps://example.com/b"), [
    "https://example.com/a",
    "https://example.com/b",
  ]);
});

test("extractUrls: 末尾の句読点・括弧・引用符を除く", () => {
  assert.deepEqual(
    extractUrls(
      [
        "https://example.com/1.",
        "https://example.com/2,",
        "https://example.com/3!?",
        "(https://example.com/4)",
        "[リンク](https://example.com/5)",
        "「https://example.com/6」",
        "https://example.com/7。",
        "https://example.com/8、",
        "（https://example.com/9）",
        '"https://example.com/10"',
      ].join(" "),
    ),
    Array.from({ length: 10 }, (_, index) => `https://example.com/${index + 1}`),
  );
  // 途中の句読点（クエリ・パス）は残す
  assert.deepEqual(extractUrls("https://example.com/a.html?x=1,2."), ["https://example.com/a.html?x=1,2"]);
});

test("extractUrls: Discord の <url> 形式は < > を含めない", () => {
  assert.deepEqual(extractUrls("埋め込み無しで <https://example.com/a> を貼った"), ["https://example.com/a"]);
  assert.deepEqual(extractUrls("<https://example.com/a>。"), ["https://example.com/a"]);
});

test("extractUrls: 同じ URL は 1 つにする", () => {
  assert.deepEqual(extractUrls("https://example.com/a <https://example.com/a> https://example.com/a。 https://example.com/b"), [
    "https://example.com/a",
    "https://example.com/b",
  ]);
});

test("extractUrls: 最大 10 件（先に出てきたものから）", () => {
  const urls = Array.from({ length: 12 }, (_, index) => `https://example.com/${index}`);
  assert.equal(MAX_URLS, 10);
  assert.deepEqual(extractUrls(urls.join(" ")), urls.slice(0, 10));
  // 重複は数えない
  assert.deepEqual(extractUrls([urls[0], ...urls].join(" ")), urls.slice(0, 10));
});

test("extractUrls: URL が無ければ空。http(s) 以外と scheme だけのものは取らない", () => {
  assert.deepEqual(extractUrls("明日買い物に行く"), []);
  assert.deepEqual(extractUrls(""), []);
  assert.deepEqual(extractUrls("ftp://example.com/a example.com/b www.example.com"), []);
  assert.deepEqual(extractUrls("https:// と http://。"), []);
});

test("extractUrls: URL の直後に空白なしで日本語が続いても、日本語の手前までを候補に入れる", () => {
  assert.deepEqual(extractUrls("https://example.com/pageを見て"), [
    "https://example.com/pageを見て",
    "https://example.com/page",
  ]);
  // 日本語の手前の句読点も除く
  assert.deepEqual(extractUrls("これhttps://example.com/a.を要約"), ["https://example.com/a.を要約", "https://example.com/a"]);
  // 日本語のパスを含む URL もそのまま候補に残る
  assert.deepEqual(extractUrls("https://ja.wikipedia.org/wiki/東京 を読んで"), [
    "https://ja.wikipedia.org/wiki/東京",
    "https://ja.wikipedia.org/wiki/",
  ]);
});

test("extractUrls: 括弧の対応が取れている末尾の ) は残した候補も作る", () => {
  assert.deepEqual(extractUrls("https://en.wikipedia.org/wiki/Foo_(bar) を見て"), [
    "https://en.wikipedia.org/wiki/Foo_(bar",
    "https://en.wikipedia.org/wiki/Foo_(bar)",
  ]);
  // 文の括弧で囲んだだけなら ) は残さない
  assert.deepEqual(extractUrls("(https://example.com/4)"), ["https://example.com/4"]);
});
