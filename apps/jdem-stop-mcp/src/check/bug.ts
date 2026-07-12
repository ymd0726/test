// ClaudeToolのバグ報告DBへの自動起票（TOOL-40）
//
// チェックNGの1項目 = 1 BUGページ。詳細メモに機械可読JSONブロックを含め、
// 将来の「バグ自動改修ツール」がそのままparseできる形にする。
// dedupeは呼び元（checkers→orchestrator）が実行ログページの チェック詳細.filedBugs で行う。

import { toRichText, BUG_DB_ID } from "./runlog";
import type { CheckItem, RunLogRecord } from "./types";

const NOTION = "https://api.notion.com/v1";
const NOTION_VERSION = "2022-06-28";

/** 関連ツール（開発ツール・仕様マスターDB）のページID */
const TOOL_PAGE_IDS: Record<string, string> = {
  "cr入稿くん": "39535c2a-db56-816b-ae6c-f903a8be7764", // TOOL-33
  "cr停止くん": "38535c2a-db56-81cb-b793-d6ac3d25837b", // TOOL-16
};

export interface CreatedBug {
  pageId: string;
  url: string;
}

/** NG項目1件をバグ報告DBに起票。失敗時は null（チェック自体は続行） */
export async function createBugPage(
  token: string,
  run: RunLogRecord,
  item: CheckItem,
  dateJst: string
): Promise<CreatedBug | null> {
  try {
    const name = `【自動検知】[${run.tool}] ${run.project}/${run.crName} — ${item.label}（${dateJst}実行分）`;
    const machine = {
      detector: "yokujitsu-check/v1",
      tool: run.tool,
      action: run.action,
      project: run.project,
      crName: run.crName,
      runPageId: run.pageId,
      runPageUrl: run.url,
      checkKey: item.key,
      severity: item.severity,
      expected: item.expected ?? null,
      actual: item.actual ?? null,
      adIds: run.adIds,
      executorSlackId: run.userId,
      executedAt: run.createdIso,
    };
    const detail =
      `翌日自動チェックくん（TOOL-40）が検出した不整合です。\n` +
      `${item.message || item.label}\n\n` +
      `--- 機械可読ブロック（自動改修ツール用） ---\n` +
      JSON.stringify(machine, null, 2);
    const repro =
      `${fmtJst(run.createdIso)} に ${run.userName || run.userId || "(不明)"} が ${run.tool}（${run.action}）を実行` +
      `（案件=${run.project} / cr=${run.crName}）。実行ログ: ${run.url}`;

    const props: any = {
      Name: { title: [{ text: { content: name.slice(0, 200) } }] },
      "種別": { select: { name: "バグ" } },
      "影響度": { select: { name: item.severity } },
      "詳細メモ": { rich_text: toRichText(detail) },
      "再現手順": { rich_text: toRichText(repro) },
    };
    const toolPageId = TOOL_PAGE_IDS[run.tool];
    if (toolPageId) props["関連ツール"] = { relation: [{ id: toolPageId }] };

    const res = await notionApi(token, "pages", "POST", {
      parent: { database_id: BUG_DB_ID },
      properties: props,
    });
    return res?.id ? { pageId: res.id, url: res.url || "" } : null;
  } catch {
    return null;
  }
}

function fmtJst(iso: string): string {
  if (!iso) return "(日時不明)";
  try {
    const d = new Date(new Date(iso).getTime() + 9 * 3600 * 1000);
    return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())} JST`;
  } catch {
    return iso;
  }
}
const pad = (n: number) => String(n).padStart(2, "0");

async function notionApi(token: string, path: string, method: string, body?: any): Promise<any> {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), 15000);
  try {
    const res = await fetch(`${NOTION}/${path}`, {
      method,
      headers: { authorization: `Bearer ${token}`, "notion-version": NOTION_VERSION, "content-type": "application/json" },
      body: body ? JSON.stringify(body) : undefined,
      signal: ctl.signal,
    });
    const data = (await res.json()) as any;
    if (!res.ok) throw new Error(`Notion API失敗 (${path}): ${data.message || res.status}`);
    return data;
  } finally {
    clearTimeout(t);
  }
}
