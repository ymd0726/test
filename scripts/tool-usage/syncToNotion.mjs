#!/usr/bin/env node
// Stop / SessionEnd フック本体。セッションのローカル集計と「同期済み」の差分だけを
// Notion DB に追記する(競合しない追記方式)。常に exit 0(フックを壊さない)。
//
// 必要な環境変数:
//   NOTION_TOKEN               … Notion Internal Integration Token(必須)
//   TOOL_USAGE_DB_ID           … 追記先DB(未設定なら親ページから自動作成)
//   TOOL_USAGE_PARENT_PAGE_ID  … DB自動作成時の親ページID(DB_ID未設定時に使用)
// 未設定なら Notion 同期はスキップ(ローカル記録は継続)。
//
// デバウンス: Stop は毎ターン発火するため、既定120秒に1回に間引く。
//   SessionEnd(hook_event_name)または引数 --force の時は即時同期。

import fs from "node:fs";
import path from "node:path";
import {
  baseDir, eventsFile, syncedFile, dbCacheFile,
  readEvents, aggregateCounts, computeDelta, categorizeTool, ymd,
} from "./lib.mjs";
import { createUsageDatabase, appendUsageRow } from "./notionClient.mjs";

const DEBOUNCE_MS = Number(process.env.TOOL_USAGE_DEBOUNCE_MS || 120000);

function readStdin() {
  try { return fs.readFileSync(0, "utf8"); } catch { return ""; }
}
function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return fallback; }
}
function logErr(e) {
  try { fs.appendFileSync(path.join(baseDir(), "errors.log"), `[sync ${new Date().toISOString()}] ${e}\n`); } catch { /* noop */ }
}

async function resolveDbId(token) {
  if (process.env.TOOL_USAGE_DB_ID) return process.env.TOOL_USAGE_DB_ID;
  const cached = readJson(dbCacheFile(), null);
  if (cached && cached.databaseId) return cached.databaseId;
  const parent = process.env.TOOL_USAGE_PARENT_PAGE_ID;
  if (!parent) return null; // 作成先不明 → スキップ
  const id = await createUsageDatabase(token, parent);
  try {
    fs.mkdirSync(baseDir(), { recursive: true });
    fs.writeFileSync(dbCacheFile(), JSON.stringify({ databaseId: id, createdAt: new Date().toISOString() }, null, 2));
  } catch (e) { logErr(e); }
  return id;
}

async function main() {
  const input = JSON.parse(readStdin() || "{}");
  const forced = process.argv.includes("--force") || input.hook_event_name === "SessionEnd";
  const session = input.session_id;
  if (!session) return;

  const events = readEvents(eventsFile(session));
  if (events.length === 0) return;

  const synced = readJson(syncedFile(session), { counts: {}, lastSyncTs: 0, user: null, env: null });

  // デバウンス(SessionEnd/強制時は無視)
  if (!forced && Date.now() - (synced.lastSyncTs || 0) < DEBOUNCE_MS) return;

  const current = aggregateCounts(events);
  const delta = computeDelta(current, synced.counts || {});
  const tools = Object.keys(delta);
  if (tools.length === 0) return;

  const token = process.env.NOTION_TOKEN;
  if (!token) { logErr("NOTION_TOKEN 未設定のため同期スキップ"); return; }

  const dbId = await resolveDbId(token);
  if (!dbId) { logErr("DB未設定(TOOL_USAGE_DB_ID / TOOL_USAGE_PARENT_PAGE_ID)のため同期スキップ"); return; }

  const user = events[events.length - 1].user || "unknown";
  const env = events[events.length - 1].env || "";
  const date = ymd();

  for (const tool of tools) {
    const { category, server } = categorizeTool(tool);
    await appendUsageRow(token, dbId, {
      名称: `${date} ${user} / ${tool} ×${delta[tool]}`,
      実行者: user,
      ツール: tool,
      分類: category,
      サーバ: server || "",
      回数: delta[tool],
      日付: date,
      セッションID: session,
      環境: env,
    });
  }

  // 同期済みを更新(次回はここからの差分だけ送る)
  fs.mkdirSync(path.dirname(syncedFile(session)), { recursive: true });
  fs.writeFileSync(
    syncedFile(session),
    JSON.stringify({ counts: current, lastSyncTs: Date.now(), user, env }, null, 2)
  );
}

main().catch(logErr).finally(() => process.exit(0));
