// Notion 連携（CRページ解決 / ステータス更新 / 実行ログ）

const NOTION = "https://api.notion.com/v1";
const NOTION_VERSION = "2022-06-28";

export interface CrPageInfo {
  pageId: string;
  name: string; // 例: jde_mak_cr79_ブライダル訴求
  overrides: { message?: string; title?: string; linkUrl?: string };
}

/** NotionページURL/IDから直接取得 */
export async function fetchCrPage(token: string, pageIdOrUrl: string): Promise<CrPageInfo> {
  const pageId = extractPageId(pageIdOrUrl);
  const res = await notionApi(token, `pages/${pageId}`, "GET");
  return toCrPageInfo(res);
}

/** CRDB data source を cr名（部分一致）で検索。0件/複数件はエラーにして呼び元でSlack表示 */
export async function findCrPageByName(
  token: string,
  dataSourceId: string,
  crQuery: string
): Promise<CrPageInfo[]> {
  const res = await notionApi(token, `databases/${dataSourceId}/query`, "POST", {
    filter: { property: "title", title: { contains: crQuery } },
    page_size: 10,
  });
  return (res.results || []).map(toCrPageInfo);
}

function toCrPageInfo(page: any): CrPageInfo {
  const props = page.properties || {};
  const name = plainTitle(props);
  return {
    pageId: page.id,
    name,
    overrides: {
      message: plainRichText(props["メインテキスト"]) || undefined,
      title: plainRichText(props["見出し"]) || undefined,
      linkUrl: props["遷移先URL"]?.url || undefined,
    },
  };
}

/** CRページのステータスを「入稿済み」に更新（プロパティが無い/型違いは警告扱いで無視） */
export async function markSubmitted(token: string, pageId: string): Promise<string | null> {
  try {
    await notionApi(token, `pages/${pageId}`, "PATCH", {
      properties: { ステータス: { status: { name: "入稿済み" } } },
    });
    return null;
  } catch (e1) {
    try {
      // select型のDBもあるためフォールバック
      await notionApi(token, `pages/${pageId}`, "PATCH", {
        properties: { ステータス: { select: { name: "入稿済み" } } },
      });
      return null;
    } catch (e2: any) {
      return `Notionステータス更新失敗: ${e2.message}`;
    }
  }
}

/** 実行ログDB（クリエイティブ停止 実行ログと同じDB）に「入稿」アクションで記録 */
export async function writeSubmitLog(
  token: string,
  logDataSourceId: string,
  row: {
    creative: string;
    userName: string;
    userId: string;
    project: string;
    route: string;
    metaCount: number;
    sheetResult: string;
  }
): Promise<void> {
  await notionApi(token, "pages", "POST", {
    parent: { database_id: logDataSourceId },
    properties: {
      クリエイティブ: { title: [{ text: { content: row.creative } }] },
      実行者: { rich_text: [{ text: { content: row.userName } }] },
      実行者ID: { rich_text: [{ text: { content: row.userId } }] },
      アクション: { select: { name: "入稿" } },
      案件: { select: { name: row.project } },
      経路: { select: { name: row.route } },
      Meta件数: { number: row.metaCount },
      集計表結果: { select: { name: row.sheetResult } },
      日時: { date: { start: new Date().toISOString() } },
    },
  });
}

/**
 * CLDB案件ページの「cr倉庫_(GoogleDrive) #納品先」プロパティからDriveフォルダIDを取得。
 * プロパティ名は前方一致「cr倉庫」で探す（末尾のタグ表記ゆれに耐える）。未設定ならnull。
 */
export async function fetchCldbCrFolderId(token: string, cldbPageId: string): Promise<string | null> {
  const page = await notionApi(token, `pages/${extractPageId(cldbPageId)}`, "GET");
  const props = page.properties || {};
  for (const key of Object.keys(props)) {
    if (!key.startsWith("cr倉庫")) continue;
    const url: string = props[key]?.url || "";
    if (!url) return null;
    const m = url.match(/[?&]id=([\w-]{20,})/) || url.match(/folders\/([\w-]{20,})/);
    return m ? m[1] : null;
  }
  return null;
}

export function extractPageId(s: string): string {
  const m = String(s).match(/([0-9a-f]{32})|([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i);
  if (!m) throw new Error(`NotionページID/URLとして解釈できません: ${s}`);
  const raw = m[0].replace(/-/g, "");
  return `${raw.slice(0, 8)}-${raw.slice(8, 12)}-${raw.slice(12, 16)}-${raw.slice(16, 20)}-${raw.slice(20)}`;
}

function plainTitle(props: any): string {
  for (const key of Object.keys(props)) {
    if (props[key]?.type === "title") {
      return (props[key].title || []).map((t: any) => t.plain_text).join("");
    }
  }
  return "";
}

function plainRichText(prop: any): string {
  if (!prop) return "";
  const arr = prop.rich_text || [];
  return arr.map((t: any) => t.plain_text).join("").trim();
}

async function notionApi(token: string, path: string, method: string, body?: any): Promise<any> {
  const res = await fetch(`${NOTION}/${path}`, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      "notion-version": NOTION_VERSION,
      "content-type": "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = (await res.json()) as any;
  if (!res.ok) throw new Error(`Notion API失敗 (${path}): ${data.message || res.status}`);
  return data;
}
