// 純粋関数の検証(node:test)。ネットワーク不要。
// 実行: node --test scripts/match-sort/
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseCutNumber, cutOrderKey, sortMatchesByCut, sortMatches } from "./matchSort.mjs";

test("parseCutNumber: 各種表記からカット番号を抽出", () => {
  assert.equal(parseCutNumber("カット03"), 3);
  assert.equal(parseCutNumber("カット3"), 3);
  assert.equal(parseCutNumber("cut03"), 3);
  assert.equal(parseCutNumber("cut 12"), 12);
  assert.equal(parseCutNumber("C07"), 7);
  assert.equal(parseCutNumber("#5"), 5);
  assert.equal(parseCutNumber("16カット目"), 16);
  assert.equal(parseCutNumber("なし"), null);
  assert.equal(parseCutNumber(null), null);
});

test("cutOrderKey: 数値フィールド優先、無ければラベル抽出", () => {
  assert.equal(cutOrderKey({ cutIndex: 4, cut: "カット99" }), 4); // 数値優先
  assert.equal(cutOrderKey({ cut: "カット09" }), 9);
  assert.equal(cutOrderKey({ label: "cut 11" }), 11);
  assert.equal(cutOrderKey({ foo: "bar" }), Number.POSITIVE_INFINITY);
});

test("sortMatchesByCut: カット1→Nの順に並ぶ", () => {
  const input = [
    { cut: "カット07", confidence: 0.2 },
    { cut: "カット01", confidence: 0.9 },
    { cut: "カット03", confidence: 0.5 },
    { cut: "カット02", confidence: 0.95 },
  ];
  const out = sortMatchesByCut(input);
  assert.deepEqual(out.map((m) => m.cut), ["カット01", "カット02", "カット03", "カット07"]);
});

test("sortMatchesByCut: 元配列を破壊しない", () => {
  const input = [{ cut: "カット02" }, { cut: "カット01" }];
  const snapshot = input.map((m) => m.cut);
  sortMatchesByCut(input);
  assert.deepEqual(input.map((m) => m.cut), snapshot);
});

test("sortMatchesByCut: 番号不明は末尾・元順を保つ(安定)", () => {
  const input = [
    { cut: "カット02", id: "a" },
    { cut: "不明X", id: "b" },
    { cut: "カット01", id: "c" },
    { cut: "不明Y", id: "d" },
  ];
  const out = sortMatchesByCut(input);
  assert.deepEqual(out.map((m) => m.id), ["c", "a", "b", "d"]);
});

test("sortMatchesByCut: 二桁カットで文字列ソートにならない(2 < 10)", () => {
  const input = [{ cut: "カット10" }, { cut: "カット2" }, { cut: "カット1" }];
  const out = sortMatchesByCut(input);
  assert.deepEqual(out.map((m) => m.cut), ["カット1", "カット2", "カット10"]);
});

test("sortMatches(mode=review): 低信頼度先頭、同信頼度はカット順", () => {
  const input = [
    { cut: "カット01", confidence: 0.9 },
    { cut: "カット05", confidence: 0.3 },
    { cut: "カット02", confidence: 0.3 },
  ];
  const out = sortMatches(input, "review");
  assert.deepEqual(out.map((m) => m.cut), ["カット02", "カット05", "カット01"]);
});

test("sortMatches 既定は cut モード", () => {
  const input = [{ cut: "カット03" }, { cut: "カット01" }];
  assert.deepEqual(sortMatches(input).map((m) => m.cut), ["カット01", "カット03"]);
});
