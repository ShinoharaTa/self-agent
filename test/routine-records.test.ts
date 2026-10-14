import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import {
  ROUTINE_RECORD_LIST_MAX_LIMIT,
  validateRecordFields,
  type RecordListOptions,
  type RoutineRecordStore,
} from "../src/store/routine-records.ts";
import { createStores, tempDb } from "./helpers/db.ts";

/** 2026-10-14T00:<minute>:00.000Z */
function at(minute: number): Date {
  return new Date(Date.UTC(2026, 9, 14, 0, minute));
}

/** setMinute で進める時計を持つストア（初めは 00:00） */
function tempStore(t: TestContext): { store: RoutineRecordStore; setMinute: (minute: number) => void } {
  let minute = 0;
  const { routineRecords: store } = createStores(tempDb(t), () => at(minute));
  return {
    store,
    setMinute: (value) => {
      minute = value;
    },
  };
}

/** add して id を返す（失敗ならテストを落とす） */
function add(store: RoutineRecordStore, channelId: string, date: string | null, fields: Record<string, string | number>): number {
  const result = store.add({ channelId, date, fields });
  assert.equal(result.result, "added");
  return result.result === "added" ? result.record.id : 0;
}

test("RoutineRecordStore: 追加・取得。fields は JSON で残り、ほかのチャンネルの id は取れない", (t) => {
  const { store } = tempStore(t);
  const result = store.add({ channelId: "rt-1", date: "2026-10-14", fields: { store: "喫茶店", amount: 1280 } });
  assert.deepEqual(result, {
    result: "added",
    record: {
      id: 1,
      channelId: "rt-1",
      date: "2026-10-14",
      fields: { store: "喫茶店", amount: 1280 },
      status: "active",
      createdAt: at(0).toISOString(),
      updatedAt: at(0).toISOString(),
    },
  });
  assert.deepEqual(store.get("rt-1", 1), result.result === "added" ? result.record : undefined);
  assert.equal(store.get("rt-2", 1), undefined);
  assert.equal(store.get("rt-1", 2), undefined);
  // 日付は無くてもよい
  const noDate = store.add({ channelId: "rt-1", fields: { memo: "日付なし" } });
  assert.equal(noDate.result === "added" ? noDate.record.date : "x", null);
});

test("validateRecordFields: オブジェクト・30 キー・空でないキー・文字列か有限の数・JSON で 2,000 字まで", () => {
  const many = (n: number) => Object.fromEntries(Array.from({ length: n }, (_, i) => [`k${i}`, i]));
  const cases: Array<[label: string, fields: unknown, ok: boolean]> = [
    ["空のオブジェクト", {}, true],
    ["文字列と数", { a: "x", b: 1.5, c: -3 }, true],
    ["30 キー", many(30), true],
    ["31 キー", many(31), false],
    ["配列", ["x"], false],
    ["null", null, false],
    ["文字列", "x", false],
    ["空のキー", { " ": "x" }, false],
    ["__proto__ のキー（JSON から）", JSON.parse('{"__proto__": "x"}'), false],
    ["constructor のキー", { constructor: "x" }, false],
    ["prototype のキー", { prototype: "x" }, false],
    ["真偽値", { a: true }, false],
    ["null の値", { a: null }, false],
    ["入れ子", { a: { b: 1 } }, false],
    ["NaN", { a: Number.NaN }, false],
    ["Infinity", { a: Number.POSITIVE_INFINITY }, false],
    ["2,000 字ちょうど", { a: "あ".repeat(2000 - '{"a":""}'.length) }, true],
    ["2,001 字", { a: "あ".repeat(2001 - '{"a":""}'.length) }, false],
  ];
  for (const [label, fields, ok] of cases) {
    assert.equal(validateRecordFields(fields) === null, ok, label);
  }
});

test("RoutineRecordStore: 保存できない fields の add は invalid_fields で、何も残さない", (t) => {
  const { store } = tempStore(t);
  const result = store.add({ channelId: "rt-1", fields: { a: true } as unknown as Record<string, string> });
  assert.equal(result.result, "invalid_fields");
  assert.equal(store.list("rt-1", { status: "active" }).count + store.list("rt-1", { status: "void" }).count, 0);
});

test("RoutineRecordStore: list は期間・部分一致・状態で絞り、新しい日付の順（日付なしは後ろ）に並べる", (t) => {
  const { store } = tempStore(t);
  const ids = {
    sep: add(store, "rt-1", "2026-09-30", { store: "本屋", amount: 1500 }),
    oct1: add(store, "rt-1", "2026-10-01", { store: "Cafe 100%", amount: 1280, category: "会議費" }),
    noDate: add(store, "rt-1", null, { store: "メモ" }),
    oct31: add(store, "rt-1", "2026-10-31", { store: "駅", amount: 210 }),
    nov: add(store, "rt-1", "2026-11-01", { store: "文具店", amount: 980 }),
    oct15: add(store, "rt-1", "2026-10-15", { store: "cafe_b", amount: 640 }),
    other: add(store, "rt-2", "2026-10-10", { store: "本屋", amount: 1 }),
  };
  store.markVoid("rt-1", ids.oct15);
  const cases: Array<[label: string, options: RecordListOptions, expected: number[]]> = [
    ["既定は active をすべて", {}, [ids.nov, ids.oct31, ids.oct1, ids.sep, ids.noDate]],
    ["期間（両端を含み、日付なしは除く）", { dateFrom: "2026-10-01", dateTo: "2026-10-31" }, [ids.oct31, ids.oct1]],
    ["開始だけ", { dateFrom: "2026-10-31" }, [ids.nov, ids.oct31]],
    ["終わりだけ", { dateTo: "2026-09-30" }, [ids.sep]],
    ["部分一致は値だけ（キーは見ない）", { query: "store" }, []],
    ["部分一致（英字の大文字・小文字は区別しない）", { query: "CAFE" }, [ids.oct1]],
    ["数も文字列にして見る", { query: "128" }, [ids.oct1]],
    ["% は文字として", { query: "100%" }, [ids.oct1]],
    ["% はワイルドカードにしない", { query: "e%1" }, []],
    ["_ はワイルドカードにしない", { query: "e_1" }, []],
    ["void だけ", { status: "void" }, [ids.oct15]],
    ["void の部分一致", { status: "void", query: "cafe" }, [ids.oct15]],
    ["空の部分一致は絞らない", { query: "", dateTo: "2026-09-30" }, [ids.sep]],
  ];
  for (const [label, options, expected] of cases) {
    const result = store.list("rt-1", options);
    assert.deepEqual(result.records.map((record) => record.id), expected, label);
    assert.equal(result.count, expected.length, label);
    assert.equal(result.total, undefined, label);
  }
});

test("RoutineRecordStore: list の sum は条件に合うすべての数の値だけを足し、件数と合計は limit で切る前を数える", (t) => {
  const { store } = tempStore(t);
  add(store, "rt-1", "2026-10-01", { amount: 1280 });
  add(store, "rt-1", "2026-10-02", { amount: "1,280" });
  add(store, "rt-1", "2026-10-03", { amount: 0.5 });
  add(store, "rt-1", "2026-10-04", { title: "金額なし" });
  const voided = add(store, "rt-1", "2026-10-05", { amount: 9999 });
  store.markVoid("rt-1", voided);
  add(store, "rt-1", "2026-11-01", { amount: 300 });

  // summed は total に足した記録の数（文字列の "1,280"・項目の無い記録は除く）
  const cases: Array<[label: string, options: RecordListOptions, records: number, count: number, total: number, summed: number]> = [
    ["文字列・項目の無い記録・void は数えない", { sum: "amount" }, 5, 5, 1580.5, 3],
    ["期間で絞った合計", { sum: "amount", dateFrom: "2026-10-01", dateTo: "2026-10-31" }, 4, 4, 1280.5, 2],
    ["limit で切っても件数・合計はすべて", { sum: "amount", limit: 2 }, 2, 5, 1580.5, 3],
    ["どれにも無い項目は 0", { sum: "tax" }, 5, 5, 0, 0],
    ["void だけの合計", { sum: "amount", status: "void" }, 1, 1, 9999, 1],
  ];
  for (const [label, options, records, count, total, summed] of cases) {
    const result = store.list("rt-1", options);
    assert.deepEqual(
      [result.records.length, result.count, result.total, result.summed],
      [records, count, total, summed],
      label,
    );
  }
});

test("RoutineRecordStore: 絞らない list は直近の 30 件（新しい日付の順、同じ日付は新しい id の順、日付なしは後ろ）で、件数と合計はすべて", (t) => {
  const { store } = tempStore(t);
  // 2026-10-01〜2026-10-20 に 2 件ずつ（各日の 1 件目、2 件目の順に追加）と、日付なしを 3 件
  for (let day = 1; day <= 20; day++) {
    const date = `2026-10-${String(day).padStart(2, "0")}`;
    add(store, "rt-1", date, { label: `${day}-a`, amount: 1 });
    add(store, "rt-1", date, { label: `${day}-b`, amount: 1 });
  }
  for (const label of ["x", "y", "z"]) add(store, "rt-1", null, { label, amount: 1 });

  const result = store.list("rt-1", { sum: "amount" });
  const expected = Array.from({ length: 15 }, (_, i) => [`${20 - i}-b`, `${20 - i}-a`]).flat();
  assert.deepEqual(result.records.map((record) => record.fields.label), expected);
  assert.equal(result.count, 43);
  assert.equal(result.total, 43);
  // 日付なしは日付のあるものの後ろで、新しい id の順
  assert.deepEqual(
    store.list("rt-1", { limit: 100 }).records.slice(-4).map((record) => record.fields.label),
    ["1-a", "z", "y", "x"],
  );
});

test("RoutineRecordStore: list の limit は既定 30、1〜100 に収める", (t) => {
  const { store } = tempStore(t);
  for (let i = 0; i < 120; i++) add(store, "rt-1", null, { n: i });
  const cases: Array<[label: string, limit: number | undefined, expected: number]> = [
    ["既定", undefined, 30],
    ["指定", 5, 5],
    ["上限を超える", 500, ROUTINE_RECORD_LIST_MAX_LIMIT],
    ["0 は 1", 0, 1],
    ["負は 1", -3, 1],
    ["小数は切り捨て", 2.9, 2],
    ["NaN は既定", Number.NaN, 30],
    ["Infinity は既定", Number.POSITIVE_INFINITY, 30],
    ["-Infinity は既定", Number.NEGATIVE_INFINITY, 30],
  ];
  for (const [label, limit, expected] of cases) {
    const result = store.list("rt-1", { limit });
    assert.equal(result.records.length, expected, label);
    assert.equal(result.count, 120, label);
  }
  // 同じ日付（日付なし）は新しい id の順
  assert.deepEqual(store.list("rt-1", { limit: 3 }).records.map((record) => record.fields.n), [119, 118, 117]);
});

test("RoutineRecordStore: update は指定したキーだけ変え、null でキーを消し、日付を外せる。変わらなければ no_change", (t) => {
  const { store, setMinute } = tempStore(t);
  const id = add(store, "rt-1", "2026-10-14", { store: "喫茶店", amount: 1280, memo: "打ち合わせ" });
  setMinute(7);
  const cases: Array<[label: string, run: () => ReturnType<RoutineRecordStore["update"]>, result: string, after?: object]> = [
    [
      "キーを変えて足して消す",
      () => store.update("rt-1", id, { fields: { amount: 1380, category: "会議費", memo: null } }),
      "updated",
      { date: "2026-10-14", fields: { store: "喫茶店", amount: 1380, category: "会議費" }, status: "active" },
    ],
    ["同じ値・無いキーを消す", () => store.update("rt-1", id, { fields: { amount: 1380, nothing: null } }), "no_change"],
    ["何も指定しない", () => store.update("rt-1", id, {}), "no_change"],
    [
      "日付を外す",
      () => store.update("rt-1", id, { date: null }),
      "updated",
      { date: null, fields: { store: "喫茶店", amount: 1380, category: "会議費" }, status: "active" },
    ],
    [
      "日付を付けて void にする",
      () => store.update("rt-1", id, { date: "2026-10-13", status: "void" }),
      "updated",
      { date: "2026-10-13", fields: { store: "喫茶店", amount: 1380, category: "会議費" }, status: "void" },
    ],
    ["ほかのチャンネルからは not_found", () => store.update("rt-2", id, { fields: { amount: 1 } }), "not_found"],
    ["無い id は not_found", () => store.update("rt-1", 999, { fields: { amount: 1 } }), "not_found"],
    ["保存できない値は invalid_fields", () => store.update("rt-1", id, { fields: { amount: Number.NaN } }), "invalid_fields"],
  ];
  for (const [label, run, result, after] of cases) {
    const outcome = run();
    assert.equal(outcome.result, result, label);
    if (outcome.result === "updated") {
      const { date, fields, status } = outcome.after;
      assert.deepEqual({ date, fields, status }, after, label);
      assert.equal(outcome.after.updatedAt, at(7).toISOString(), label);
      assert.equal(outcome.after.createdAt, at(0).toISOString(), label);
    }
  }
  // invalid_fields では何も変えない
  assert.equal(store.get("rt-1", id)?.fields.amount, 1380);
});

test("RoutineRecordStore: update の結果は変える前と後を返し、31 キー目になる追加は invalid_fields", (t) => {
  const { store } = tempStore(t);
  const id = add(store, "rt-1", null, Object.fromEntries(Array.from({ length: 30 }, (_, i) => [`k${i}`, i])));
  assert.equal(store.update("rt-1", id, { fields: { k30: 30 } }).result, "invalid_fields");
  // 1 つ消して 1 つ足すのはよい
  const outcome = store.update("rt-1", id, { fields: { k0: null, k30: 30 } });
  assert.equal(outcome.result, "updated");
  if (outcome.result === "updated") {
    assert.equal(outcome.before.fields.k0, 0);
    assert.equal(outcome.after.fields.k0, undefined);
    assert.equal(outcome.after.fields.k30, 30);
  }
});

test("RoutineRecordStore: markVoid・restore は状態だけを変え、同じ状態なら no_change、ほかのチャンネルは not_found", (t) => {
  const { store } = tempStore(t);
  const id = add(store, "rt-1", "2026-10-14", { amount: 1 });
  const cases: Array<[label: string, run: () => ReturnType<RoutineRecordStore["update"]>, result: string, status: string]> = [
    ["void にする", () => store.markVoid("rt-1", id), "updated", "void"],
    ["もう一度 void", () => store.markVoid("rt-1", id), "no_change", "void"],
    ["ほかのチャンネルから restore", () => store.restore("rt-2", id), "not_found", "void"],
    ["戻す", () => store.restore("rt-1", id), "updated", "active"],
    ["もう一度戻す", () => store.restore("rt-1", id), "no_change", "active"],
  ];
  for (const [label, run, result, status] of cases) {
    assert.equal(run().result, result, label);
    assert.equal(store.get("rt-1", id)?.status, status, label);
  }
  assert.deepEqual(store.get("rt-1", id)?.fields, { amount: 1 });
});

test("RoutineRecordStore: 日付は実在する YYYY-MM-DD だけで、それ以外の add・update は invalid_date で何も変えない", (t) => {
  const { store } = tempStore(t);
  const id = add(store, "rt-1", "2026-10-14", { amount: 1 });
  const cases: Array<[label: string, date: string | null, ok: boolean]> = [
    ["実在する日付", "2026-10-15", true],
    ["うるう日", "2028-02-29", true],
    ["日付なし", null, true],
    ["うるう年でない 2 月 29 日", "2026-02-29", false],
    ["2 月 30 日", "2026-02-30", false],
    ["13 月", "2026-13-01", false],
    ["0 日", "2026-10-00", false],
    ["ゼロ埋めなし", "2026-1-5", false],
    ["スラッシュ", "2026/10/14", false],
    ["時刻付き", "2026-10-14T00:00:00Z", false],
    ["空", "", false],
  ];
  for (const [label, date, ok] of cases) {
    const added = store.add({ channelId: "rt-1", date, fields: { amount: 2 } });
    assert.equal(added.result, ok ? "added" : "invalid_date", label);
    const before = store.get("rt-1", id);
    const updated = store.update("rt-1", id, { date });
    if (ok) assert.notEqual(updated.result, "invalid_date", label);
    else {
      assert.equal(updated.result, "invalid_date", label);
      assert.deepEqual(store.get("rt-1", id), before, label);
    }
  }
  // 無い記録は日付より先に not_found
  assert.equal(store.update("rt-1", 999, { date: "x" }).result, "not_found");
});

test("RoutineRecordStore: update で __proto__・constructor・prototype のキーは invalid_fields で、何も変えず prototype も変えない", (t) => {
  const { store } = tempStore(t);
  const id = add(store, "rt-1", null, { amount: 1 });
  for (const key of ["__proto__", "constructor", "prototype"]) {
    const changes = JSON.parse(`{"${key}": {"polluted": 1}}`) as Record<string, string>;
    assert.equal(store.update("rt-1", id, { fields: changes }).result, "invalid_fields", key);
    const nullChange = JSON.parse(`{"${key}": null}`) as Record<string, null>;
    assert.equal(store.update("rt-1", id, { fields: nullChange }).result, "invalid_fields", key);
  }
  const record = store.get("rt-1", id)!;
  assert.deepEqual(record.fields, { amount: 1 });
  assert.equal(Object.getPrototypeOf(record.fields), Object.prototype);
  assert.equal(({} as Record<string, unknown>).polluted, undefined);
});
