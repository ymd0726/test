// Claude Code ツール使用カウント: 純粋ロジック(テスト可能・ネットワーク非依存)。
//
// 設計:
//   - PostToolUse フックが 1イベント = {ts, user, session, tool} を
//     ~/.claude/tool-usage/events/<session>.jsonl に追記(高速・オフライン安全)。
//   - Stop/SessionEnd フックがセッション単位で現在の集計を出し、
//     前回同期済み(synced/<session>.json)との「差分」だけ Notion に追記。
//   - Notion 側は (実行者×ツール×日付) の行を合計ビューで数える(競合しない追記方式)。

import os from "node:os";
import path from "node:path";
import fs from "node:fs";

/** データ保存ルート(リポジトリ外・ユーザー単位)。CLAUDE_TOOL_USAGE_DIR で上書き可 */
export function baseDir(env = process.env) {
  return env.CLAUDE_TOOL_USAGE_DIR || path.join(os.homedir(), ".claude", "tool-usage");
}

export function eventsFile(session, env = process.env) {
  return path.join(baseDir(env), "events", `${sanitize(session)}.jsonl`);
}
export function syncedFile(session, env = process.env) {
  return path.join(baseDir(env), "synced", `${sanitize(session)}.json`);
}
export function dbCacheFile(env = process.env) {
  return path.join(baseDir(env), "db.json");
}

/** ファイル名に使えない文字を除去(session_id はUUID想定だが念のため) */
export function sanitize(s) {
  return String(s || "unknown").replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 120);
}

/**
 * 「誰が」を解決する。優先度: CLAUDE_USER → git email → OSユーザー@host。
 * gitEmail は副作用を避けるため呼び元から渡す(未取得なら null)。
 * @param {Record<string,string|undefined>} env
 * @param {string|null} gitEmail
 * @returns {string}
 */
export function resolveUser(env = process.env, gitEmail = null) {
  const explicit = (env.CLAUDE_USER || "").trim();
  if (explicit) return explicit;
  const email = (gitEmail || "").trim();
  if (email) return email;
  const user = (env.USER || env.USERNAME || "unknown").trim();
  const host = (env.HOSTNAME || "").trim();
  return host ? `${user}@${host}` : user;
}

/**
 * ツール名を分類する。MCPツールはサーバ単位に、それ以外は builtin。
 * 例: mcp__Notion__notion-fetch → {category:"MCP", server:"Notion"}
 * @param {string} tool
 * @returns {{category:"MCP"|"builtin", server:string|null}}
 */
export function categorizeTool(tool) {
  const m = String(tool || "").match(/^mcp__([^_]+(?:_[^_]+)*?)__/);
  if (m) return { category: "MCP", server: m[1] };
  return { category: "builtin", server: null };
}

/** JSONL を1行=1イベントで読む。壊れた行は無視。存在しなければ [] */
export function readEvents(file) {
  let text;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch {
    return [];
  }
  return parseEvents(text);
}

/** @param {string} text JSONL本文 */
export function parseEvents(text) {
  const out = [];
  for (const line of String(text).split("\n")) {
    const t = line.trim();
    if (!t) continue;
    try {
      out.push(JSON.parse(t));
    } catch {
      /* 壊れた行はスキップ */
    }
  }
  return out;
}

/**
 * イベント配列を tool名 → 回数 に集計。
 * @param {Array<{tool:string}>} events
 * @returns {Record<string, number>}
 */
export function aggregateCounts(events) {
  const counts = {};
  for (const e of events) {
    const t = e && e.tool;
    if (!t) continue;
    counts[t] = (counts[t] || 0) + 1;
  }
  return counts;
}

/**
 * 現在集計と同期済みの差分(正の増分のみ)を返す。
 * @param {Record<string, number>} current
 * @param {Record<string, number>} synced
 * @returns {Record<string, number>}
 */
export function computeDelta(current, synced = {}) {
  const delta = {};
  for (const tool of Object.keys(current)) {
    const d = current[tool] - (synced[tool] || 0);
    if (d > 0) delta[tool] = d;
  }
  return delta;
}

/** YYYY-MM-DD(ローカル日付)。テスト用に Date を注入可能 */
export function ymd(date = new Date()) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}
