// 純粋ロジックの検証(node:test)。ネットワーク/フック非依存。
// 実行: node --test scripts/tool-usage/
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  resolveUser, categorizeTool, parseEvents, aggregateCounts, computeDelta, ymd, sanitize,
} from "./lib.mjs";

test("resolveUser: CLAUDE_USER 最優先", () => {
  assert.equal(resolveUser({ CLAUDE_USER: "山田", USER: "ym" }, "a@b.com"), "山田");
});
test("resolveUser: 次に git email", () => {
  assert.equal(resolveUser({ USER: "ym" }, "yamada@example.com"), "yamada@example.com");
});
test("resolveUser: 最後に USER@HOST", () => {
  assert.equal(resolveUser({ USER: "ym", HOSTNAME: "mac" }, null), "ym@mac");
  assert.equal(resolveUser({ USER: "ym" }, ""), "ym");
  assert.equal(resolveUser({}, null), "unknown");
});

test("categorizeTool: MCPはサーバ名を抽出、他はbuiltin", () => {
  assert.deepEqual(categorizeTool("mcp__Notion__notion-fetch"), { category: "MCP", server: "Notion" });
  assert.deepEqual(categorizeTool("mcp__Google_Drive__search_files"), { category: "MCP", server: "Google_Drive" });
  assert.deepEqual(categorizeTool("Bash"), { category: "builtin", server: null });
  assert.deepEqual(categorizeTool("Read"), { category: "builtin", server: null });
});

test("parseEvents: 壊れた行を無視して復元", () => {
  const text = '{"tool":"Bash"}\n\nnot-json\n{"tool":"Read"}\n';
  const ev = parseEvents(text);
  assert.deepEqual(ev.map((e) => e.tool), ["Bash", "Read"]);
});

test("aggregateCounts: tool→回数", () => {
  const ev = [{ tool: "Bash" }, { tool: "Bash" }, { tool: "Read" }, { tool: "" }, {}];
  assert.deepEqual(aggregateCounts(ev), { Bash: 2, Read: 1 });
});

test("computeDelta: 正の増分のみ返す", () => {
  assert.deepEqual(computeDelta({ Bash: 5, Read: 3, Edit: 2 }, { Bash: 5, Read: 1 }), { Read: 2, Edit: 2 });
  assert.deepEqual(computeDelta({ Bash: 2 }, { Bash: 2 }), {}); // 差分なし
});

test("computeDelta: synced欠損でも全件が差分", () => {
  assert.deepEqual(computeDelta({ Bash: 3 }), { Bash: 3 });
});

test("ymd: ローカル日付をYYYY-MM-DD", () => {
  assert.equal(ymd(new Date(2026, 6, 6)), "2026-07-06"); // 月は0始まり=6→07
});

test("sanitize: セッションIDをファイル名安全化", () => {
  assert.equal(sanitize("abc/../x y"), "abc_.._x_y");
  assert.equal(sanitize(""), "unknown");
});
