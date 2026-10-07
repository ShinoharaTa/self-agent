// オーナーの発言に貼られた URL。そのターンで WebFetch に取得を許す URL になる

/** 1 回の発言から取り出す URL の上限（貼られた URL の数。1 つの URL から作る候補はこれとは別に数える） */
export const MAX_URLS = 10;

/** http(s) で始まり、空白か < > の手前まで（Discord の <url> 形式の括りを含めない） */
const URL_PATTERN = /https?:\/\/[^\s<>]+/gi;

/** URL の末尾から除く文字（文の句読点・閉じ括弧・引用符） */
const TRAILING_PATTERN = /[.,;:!?'")\]}>、。，．！？：；」』）】〕］｝〉》”’]+$/u;

/** ASCII 以外の文字（日本語など） */
const NON_ASCII = /[^\x00-\x7f]/u;

function count(text: string, char: string): number {
  return text.split(char).length - 1;
}

/**
 * 貼られた 1 つの URL から、取得を許す候補を作る。日本語の文は URL の直後に空白なしで続くことが多い
 * （「https://example.comを見て」）ので、URL の形だけでは区切りを決められない。候補を複数作り、
 * モデルがどれを取得しても許可と一致するようにする（候補はどれもオーナーが貼った文字列の先頭部分なので、
 * 別の URL に情報を送る経路にはならない）。
 * - 末尾の句読点・括弧を除いたもの
 * - 括弧の対応が取れていれば、末尾の `)` を残したもの（`.../Foo_(bar)`）
 * - ASCII 以外の文字の手前で切ったもの（「…comを見て」→「…com」。日本語のパスを含む URL も上の候補で残る）
 */
function candidatesOf(raw: string): string[] {
  const stripped = raw.replace(TRAILING_PATTERN, "");
  const candidates = [stripped];
  const withParen = raw.slice(0, stripped.length + 1);
  if (withParen.endsWith(")") && count(withParen, "(") === count(withParen, ")") && count(stripped, "(") > count(stripped, ")")) {
    candidates.push(withParen);
  }
  const nonAscii = stripped.search(NON_ASCII);
  if (nonAscii > 0) candidates.push(stripped.slice(0, nonAscii).replace(TRAILING_PATTERN, ""));
  // 末尾を除いて scheme だけ残ったものは捨てる
  return candidates.filter((url) => /^https?:\/\/./i.test(url));
}

/** 発言の本文から http(s) の URL（取得を許す候補）を出現順に取り出す。重複を除き、貼られた URL は最大 MAX_URLS 件 */
export function extractUrls(text: string): string[] {
  const urls: string[] = [];
  let pasted = 0;
  for (const match of text.matchAll(URL_PATTERN)) {
    const candidates = candidatesOf(match[0]).filter((url) => !urls.includes(url));
    if (candidates.length === 0) continue;
    urls.push(...new Set(candidates));
    pasted++;
    if (pasted === MAX_URLS) break;
  }
  return urls;
}
