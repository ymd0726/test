// Notion REST 最小クライアント(実行時フック用)。
// リポジトリ既存ツールと同じく Internal Integration Token を使う。
// MCP ではなく素の REST を使うのは、フックが軽量な単発 node プロセスで動くため。

const NOTION = "https://api.notion.com/v1";
const NOTION_VERSION = "2022-06-28";

export async function notionApi(token, path, method, body) {
  const res = await fetch(`${NOTION}/${path}`, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      "notion-version": NOTION_VERSION,
      "content-type": "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`Notion API失敗 (${method} ${path}): ${data.message || res.status}`);
  return data;
}

/**
 * 使用ログ用DBを作成する。親ページ配下に、集計しやすい select/number/date で構成。
 * @returns {Promise<string>} database_id
 */
export async function createUsageDatabase(token, parentPageId) {
  const db = await notionApi(token, "databases", "POST", {
    parent: { type: "page_id", page_id: parentPageId },
    title: [{ type: "text", text: { content: "Claude Code ツール使用ログ" } }],
    description: [
      { type: "text", text: { content: "誰がどのツールを何回使ったかの記録(PostToolUse/Stopフックが自動追記)" } },
    ],
    properties: {
      名称: { title: {} },
      実行者: { select: {} },
      ツール: { select: {} },
      分類: { select: {} }, // MCP / builtin
      サーバ: { select: {} }, // MCPサーバ名(builtinは空)
      回数: { number: {} },
      日付: { date: {} },
      セッションID: { rich_text: {} },
      環境: { select: {} }, // web / local など
    },
  });
  return db.id;
}

/** 使用ログ1行を追記 */
export async function appendUsageRow(token, databaseId, row) {
  const props = {
    名称: { title: [{ text: { content: row.名称 } }] },
    実行者: { select: { name: row.実行者 } },
    ツール: { select: { name: row.ツール } },
    回数: { number: row.回数 },
    日付: { date: { start: row.日付 } },
  };
  if (row.分類) props.分類 = { select: { name: row.分類 } };
  if (row.サーバ) props.サーバ = { select: { name: row.サーバ } };
  if (row.セッションID) props.セッションID = { rich_text: [{ text: { content: row.セッションID } }] };
  if (row.環境) props.環境 = { select: { name: row.環境 } };
  await notionApi(token, "pages", "POST", { parent: { database_id: databaseId }, properties: props });
}
