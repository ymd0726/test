// 統一「ツール実行ログDB」クライアント（TOOL-40）
//
// cr入稿くん・cr停止くんが実行のたびに1ページ書き、翌日自動チェックくんが照合する。
// - ページは実行「開始時」に ステータス=実行中 で作成し、各ステップ完了で update する。
//   途中でWorkerが死んだrunは「実行中」のまま残り、チェッカーが未完走として検出できる。
// - DB本体は TOOL-40 ページ配下に Worker が自動作成する（初回のみ）。以後は子ブロック
//   走査で自動検出するため、DB IDの手動設定・再デプロイは不要。
// - すべての関数は失敗しても throw しない（ログが本体処理を絶対に壊さない）。
//   作成失敗時は null を返すので、呼び元は完了通知に警告行を足せる。

const NOTION = "https://api.notion.com/v1";
const NOTION_VERSION = "2022-06-28";

/** DBの親ページ = Notion「cr入稿くん、cr停止くんを翌日自動チェックくん」(TOOL-40) */
export const RUNLOG_PARENT_PAGE_ID = "39935c2a-db56-8000-bdb5-fd236cbb0e6b";
/** 自動作成するDBのタイトル（前方一致で検出する） */
export const RUNLOG_DB_TITLE = "ツール実行ログ #全ツール共通";
/** ClaudeToolのバグ報告DB（BUGリレーション先） */
export const BUG_DB_ID = "38835c2a-db56-80b9-88e8-d872c1fac992";

export interface RunLogInit {
  tool: string; // 例: cr入稿くん / cr停止くん
  action: string; // 入稿 / 停止 / 取消
  project: string;
  crName: string;
  userName?: string;
  userId?: string;
  route?: string; // Slack / Claude
  adsetIds?: string[];
  sheetTabs?: string[];
  notionCrPageId?: string;
  detail?: Record<string, any>;
}

export interface RunLogPatch {
  status?: string; // 実行中 / 完了 / 一部失敗 / 失敗
  metaResult?: string; // 成功 / 失敗 / 対象なし / 未実行
  sheetResult?: string;
  notionResult?: string;
  adIds?: string[];
  adsetIds?: string[];
  sheetTabs?: string[];
  notionCrPageId?: string;
  detail?: Record<string, any>;
}

// isolateごとのDB IDキャッシュ（コールドスタート時のみ子ブロック走査が走る）
let cachedDbId: string | null = null;

/** TOOL-40ページ配下の実行ログDBを検出。無ければ作成して返す。失敗時は null。 */
export async function ensureRunlogDb(token: string | undefined): Promise<string | null> {
  if (!token) return null;
  if (cachedDbId) return cachedDbId;
  try {
    const found = await findRunlogDb(token);
    if (found) return (cachedDbId = found);
    const created = await createRunlogDb(token);
    if (created) {
      // 同時実行で二重作成された場合に備え、ブロック順で先頭のDBを正とする
      // （全isolateが同じ結論になり、負けた側の空DBは使われないだけで済む）
      const canonical = await findRunlogDb(token);
      return (cachedDbId = canonical || created);
    }
  } catch {
    /* 検出/作成失敗 → null（呼び元が警告表示） */
  }
  return null;
}

async function findRunlogDb(token: string): Promise<string | null> {
  let cursor: string | undefined;
  for (let i = 0; i < 5; i++) {
    const q = cursor ? `?start_cursor=${cursor}&page_size=100` : "?page_size=100";
    const res = await notionApi(token, `blocks/${RUNLOG_PARENT_PAGE_ID}/children${q}`, "GET");
    for (const b of res.results || []) {
      if (b.type === "child_database" && String(b.child_database?.title || "").startsWith(RUNLOG_DB_TITLE)) {
        return b.id;
      }
    }
    if (!res.has_more) break;
    cursor = res.next_cursor;
  }
  return null;
}

async function createRunlogDb(token: string): Promise<string | null> {
  const select = (opts: [string, string][]) => ({ select: { options: opts.map(([name, color]) => ({ name, color })) } });
  const resultSelect = select([["成功", "green"], ["失敗", "red"], ["対象なし", "gray"], ["未実行", "default"]]);
  const res = await notionApi(token, "databases", "POST", {
    parent: { type: "page_id", page_id: RUNLOG_PARENT_PAGE_ID },
    title: [{ type: "text", text: { content: `${RUNLOG_DB_TITLE} #翌日自動チェックくん` } }],
    properties: {
      "cr名": { title: {} },
      "ツール": select([["cr入稿くん", "blue"], ["cr停止くん", "red"]]),
      "アクション": select([["入稿", "blue"], ["停止", "red"], ["取消", "gray"]]),
      "案件": { select: {} },
      "経路": select([["Slack", "green"], ["Claude", "purple"]]),
      "実行者名": { rich_text: {} },
      "実行者ID": { rich_text: {} },
      "ステータス": select([["実行中", "yellow"], ["完了", "green"], ["一部失敗", "orange"], ["失敗", "red"]]),
      "結果_Meta": resultSelect,
      "結果_集計表": resultSelect,
      "結果_Notion": resultSelect,
      "Meta広告ID": { rich_text: {} },
      "広告セットID": { rich_text: {} },
      "集計表タブ": { rich_text: {} },
      "NotionCRページID": { rich_text: {} },
      "詳細JSON": { rich_text: {} },
      "チェック結果": select([["未チェック", "default"], ["OK", "green"], ["警告", "yellow"], ["NG", "red"]]),
      "チェック日時": { date: {} },
      "チェック詳細": { rich_text: {} },
      "BUG": { relation: { database_id: BUG_DB_ID, single_property: {} } },
    },
  });
  return res?.id || null;
}

/** 実行開始時に「実行中」でページ作成。pageIdを返す（失敗はnull） */
export async function createRunLog(token: string | undefined, init: RunLogInit): Promise<string | null> {
  try {
    const dbId = await ensureRunlogDb(token);
    if (!dbId || !token) return null;
    const props: any = {
      "cr名": { title: [{ text: { content: init.crName.slice(0, 200) } }] },
      "ツール": { select: { name: init.tool } },
      "アクション": { select: { name: init.action } },
      "案件": { select: { name: init.project } },
      "ステータス": { select: { name: "実行中" } },
      "チェック結果": { select: { name: "未チェック" } },
      "実行者名": { rich_text: toRichText(init.userName || "") },
      "実行者ID": { rich_text: toRichText(init.userId || "") },
    };
    if (init.route) props["経路"] = { select: { name: init.route } };
    if (init.adsetIds?.length) props["広告セットID"] = { rich_text: toRichText(JSON.stringify(init.adsetIds)) };
    if (init.sheetTabs?.length) props["集計表タブ"] = { rich_text: toRichText(init.sheetTabs.join(" / ")) };
    if (init.notionCrPageId) props["NotionCRページID"] = { rich_text: toRichText(init.notionCrPageId) };
    if (init.detail) props["詳細JSON"] = { rich_text: toRichText(JSON.stringify(init.detail)) };
    const res = await notionApi(token, "pages", "POST", { parent: { database_id: dbId }, properties: props });
    return res?.id || null;
  } catch {
    return null;
  }
}

/** ステップ完了時の更新。失敗しても本体処理は続行。 */
export async function updateRunLog(token: string | undefined, pageId: string | null | undefined, patch: RunLogPatch): Promise<void> {
  if (!token || !pageId) return;
  try {
    const props: any = {};
    if (patch.status) props["ステータス"] = { select: { name: patch.status } };
    if (patch.metaResult) props["結果_Meta"] = { select: { name: patch.metaResult } };
    if (patch.sheetResult) props["結果_集計表"] = { select: { name: patch.sheetResult } };
    if (patch.notionResult) props["結果_Notion"] = { select: { name: patch.notionResult } };
    if (patch.adIds) props["Meta広告ID"] = { rich_text: toRichText(JSON.stringify(patch.adIds)) };
    if (patch.adsetIds) props["広告セットID"] = { rich_text: toRichText(JSON.stringify(patch.adsetIds)) };
    if (patch.sheetTabs) props["集計表タブ"] = { rich_text: toRichText(patch.sheetTabs.join(" / ")) };
    if (patch.notionCrPageId) props["NotionCRページID"] = { rich_text: toRichText(patch.notionCrPageId) };
    if (patch.detail) props["詳細JSON"] = { rich_text: toRichText(JSON.stringify(patch.detail)) };
    if (Object.keys(props).length === 0) return;
    await notionApi(token, `pages/${pageId}`, "PATCH", { properties: props });
  } catch {
    /* ログ更新失敗は本処理を止めない */
  }
}

/** チェッカーの書き戻し（チェック結果/詳細/BUGリレーション） */
export async function writeCheckResult(
  token: string,
  pageId: string,
  result: { checkResult: "OK" | "警告" | "NG"; checkDetail: Record<string, any>; bugPageIds?: string[] }
): Promise<void> {
  try {
    const props: any = {
      "チェック結果": { select: { name: result.checkResult } },
      "チェック日時": { date: { start: new Date().toISOString() } },
      "チェック詳細": { rich_text: toRichText(JSON.stringify(result.checkDetail)) },
    };
    if (result.bugPageIds?.length) props["BUG"] = { relation: result.bugPageIds.map((id) => ({ id })) };
    await notionApi(token, `pages/${pageId}`, "PATCH", { properties: props });
  } catch {
    /* 書き戻し失敗はチェック続行（次回また未チェックとして拾われる） */
  }
}

/**
 * 対象日(JST)の実行ログを列挙。
 * デフォルトは「チェック結果=未チェック or 未設定」のみ（再実行時の二重処理防止）。
 */
export async function queryRunsForDate(
  token: string,
  dateJst: string,
  opts?: { includeChecked?: boolean }
): Promise<{ pageId: string }[]> {
  const dbId = await ensureRunlogDb(token);
  if (!dbId) throw new Error("実行ログDBが見つかりません（TOOL-40ページへのintegration共有を確認）");
  const start = `${dateJst}T00:00:00+09:00`;
  const end = `${nextDate(dateJst)}T00:00:00+09:00`;
  const and: any[] = [
    { timestamp: "created_time", created_time: { on_or_after: start } },
    { timestamp: "created_time", created_time: { before: end } },
  ];
  if (!opts?.includeChecked) {
    and.push({
      or: [
        { property: "チェック結果", select: { equals: "未チェック" } },
        { property: "チェック結果", select: { is_empty: true } },
      ],
    });
  }
  const out: { pageId: string }[] = [];
  let cursor: string | undefined;
  for (let i = 0; i < 10; i++) {
    const body: any = { filter: { and }, page_size: 100 };
    if (cursor) body.start_cursor = cursor;
    const res = await notionApi(token, `databases/${dbId}/query`, "POST", body);
    for (const p of res.results || []) out.push({ pageId: p.id });
    if (!res.has_more) break;
    cursor = res.next_cursor;
  }
  return out;
}

/** 進捗確認（BUG-143）で表示する1件分。ページ再取得を避けるためqueryの結果から直接組み立てる */
export interface RecentRun {
  pageId: string;
  url: string;
  crName: string;
  action: string;
  status: string;
  metaResult: string;
  sheetResult: string;
  notionResult: string;
  userName: string;
  createdIso: string;
  detail: Record<string, any>;
}

/**
 * 案件の直近の実行ログを新しい順に取得する（BUG-143 進捗確認用）。
 * query応答に含まれるプロパティをその場でパースするので、件数ぶんのページ取得は不要。
 */
export async function queryRecentRunsForProject(
  token: string,
  project: string,
  limit = 5
): Promise<RecentRun[]> {
  const dbId = await ensureRunlogDb(token);
  if (!dbId) throw new Error("実行ログDBが見つかりません（TOOL-40ページへのintegration共有を確認）");
  const res = await notionApi(token, `databases/${dbId}/query`, "POST", {
    filter: { property: "案件", select: { equals: project } },
    sorts: [{ timestamp: "created_time", direction: "descending" }],
    page_size: Math.max(1, Math.min(limit, 20)),
  });
  return (res.results || []).map((p: any) => {
    const props = p.properties || {};
    const text = (name: string): string => {
      const arr = props[name]?.rich_text || props[name]?.title || [];
      return Array.isArray(arr) ? arr.map((t: any) => t.plain_text || "").join("") : "";
    };
    const sel = (name: string): string => props[name]?.select?.name || "";
    let detail: Record<string, any> = {};
    try {
      const v = JSON.parse(text("詳細JSON"));
      if (v && typeof v === "object") detail = v;
    } catch {
      /* 詳細JSONが壊れていても進捗表示は続行する */
    }
    return {
      pageId: p.id,
      url: p.url || "",
      crName: text("cr名"),
      action: sel("アクション"),
      status: sel("ステータス"),
      metaResult: sel("結果_Meta"),
      sheetResult: sel("結果_集計表"),
      notionResult: sel("結果_Notion"),
      userName: text("実行者名"),
      createdIso: p.created_time || "",
      detail,
    };
  });
}

/** ページ1件を取得してパース */
export async function fetchRunLog(token: string, pageId: string): Promise<import("./types").RunLogRecord> {
  const page = await notionApi(token, `pages/${pageId}`, "GET");
  const props = page.properties || {};
  const text = (name: string): string => {
    const arr = props[name]?.rich_text || props[name]?.title || [];
    return Array.isArray(arr) ? arr.map((t: any) => t.plain_text || "").join("") : "";
  };
  const sel = (name: string): string => props[name]?.select?.name || "";
  const jsonArr = (s: string): string[] => {
    try { const v = JSON.parse(s); return Array.isArray(v) ? v.map(String) : []; } catch { return []; }
  };
  const jsonObj = (s: string): Record<string, any> => {
    try { const v = JSON.parse(s); return v && typeof v === "object" ? v : {}; } catch { return {}; }
  };
  return {
    pageId: page.id,
    url: page.url || "",
    tool: sel("ツール"),
    action: sel("アクション"),
    project: sel("案件"),
    crName: text("cr名"),
    userName: text("実行者名"),
    userId: text("実行者ID"),
    status: sel("ステータス"),
    metaResult: sel("結果_Meta"),
    sheetResult: sel("結果_集計表"),
    notionResult: sel("結果_Notion"),
    adIds: jsonArr(text("Meta広告ID")),
    adsetIds: jsonArr(text("広告セットID")),
    sheetTabs: text("集計表タブ").split(" / ").map((s) => s.trim()).filter(Boolean),
    notionCrPageId: text("NotionCRページID"),
    detail: jsonObj(text("詳細JSON")),
    checkResult: sel("チェック結果"),
    checkDetail: jsonObj(text("チェック詳細")),
    createdIso: page.created_time || "",
  };
}

// ---- helpers ----

/** rich_text は1要素2000字制限があるため分割する */
export function toRichText(s: string): any[] {
  const out: any[] = [];
  const str = String(s);
  for (let i = 0; i < str.length && out.length < 90; i += 1900) {
    out.push({ text: { content: str.slice(i, i + 1900) } });
  }
  if (out.length === 0) out.push({ text: { content: "" } });
  return out;
}

function nextDate(ymd: string): string {
  const d = new Date(`${ymd}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

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
