// チェック用 Google Sheets 読み取り（副作用なし・GAS不要）
//
// 停止GAS(stopCreative_common.gs)のシート構造前提を読み取り専用で再現する:
//   - ID行: 1〜8行のどこか（案件差: rcl=5 / 通常6 / ssh=7）。cr名は正規化して完全一致
//   - ラベル行(1行目): cr列から左へ「消化金額」・右へ「メモ」でブロック範囲を特定
//   - 停止マーク: メモ列の4〜6行にチェックボックスTRUE ＋ ブロックのグレー塗り(#999999)
// 認証は cr入稿くんのDrive用SA(JWT)を流用（drive.readonly スコープはSheets読取にも有効）。

import { driveAccessToken } from "../submit/drive";

const SHEETS = "https://sheets.googleapis.com/v4/spreadsheets";

export async function sheetsToken(googleServiceAccountJson: string): Promise<string> {
  return driveAccessToken(googleServiceAccountJson);
}

/** GASのnormCrNameと同じ正規化（ゼロ幅文字除去・全角空白→半角・trim・小文字化） */
export function normCrName(s: unknown): string {
  return String(s ?? "")
    .replace(/[\u200B-\u200D\uFEFF]/g, "") // ゼロ幅スペース/接合子/BOM
    .replace(/[\u00A0\u3000]/g, " ") // NBSP・全角空白 → 半角空白
    .trim()
    .toLowerCase();
}

/** タブ名が不明なときの解決: 1行目に「消化金額」と「メモ」の両方があるタブ（GAS resolveSheetと同思想） */
export async function resolveTab(token: string, spreadsheetId: string, preferred?: string): Promise<string | null> {
  const meta = await sheetsGet(token, `${spreadsheetId}?fields=sheets.properties.title`);
  const titles: string[] = (meta.sheets || []).map((s: any) => s.properties?.title).filter(Boolean);
  if (preferred && titles.includes(preferred)) return preferred;
  if (titles.includes("meta_total")) return "meta_total";
  for (const t of titles) {
    try {
      const rows = await readRows(token, spreadsheetId, t, "1:1");
      const labels = (rows[0] || []).map((v) => String(v).trim());
      if (labels.includes("消化金額") && labels.includes("メモ")) return t;
    } catch {
      /* 読めないタブはスキップ */
    }
  }
  return titles[0] || null;
}

/** 指定行範囲の値を読む（例 range="1:8"） */
export async function readRows(token: string, spreadsheetId: string, tab: string, range: string): Promise<any[][]> {
  const data = await sheetsGet(token, `${spreadsheetId}/values/${encodeURIComponent(`'${tab}'!${range}`)}`);
  return data.values || [];
}

/** 1〜8行のヘッダーブロックから cr名の列を探す（1-based。見つからなければ -1） */
export function findCrColumn(headerRows: any[][], crName: string): number {
  const target = normCrName(crName);
  if (!target) return -1;
  for (const row of headerRows) {
    for (let c = 0; c < row.length; c++) {
      if (normCrName(row[c]) === target) return c + 1;
    }
  }
  return -1;
}

export interface StopMarkResult {
  found: boolean; // cr列が存在するか
  checkboxOn?: boolean; // メモ列4〜6行のチェックボックスがTRUEか
  grayed?: boolean; // ブロック(1〜6行)にグレー塗り(#999999近傍)があるか
  blockResolved?: boolean; // 消化金額〜メモの列群を特定できたか
  note?: string;
}

/** 停止マーク（チェックON・グレー塗り）を読み取り専用で検証する */
export async function checkStopMarks(
  token: string,
  spreadsheetId: string,
  tab: string,
  crName: string
): Promise<StopMarkResult> {
  const headerRows = await readRows(token, spreadsheetId, tab, "1:8");
  const nameCol = findCrColumn(headerRows, crName);
  if (nameCol === -1) return { found: false };

  // ラベル行(1行目)から列群範囲（消化金額〜メモ）を特定
  const labels = (headerRows[0] || []).map((v) => String(v).trim());
  let leftCol = -1;
  for (let c = nameCol; c >= 1; c--) if (labels[c - 1] === "消化金額") { leftCol = c; break; }
  let rightCol = -1;
  for (let c = nameCol; c <= labels.length; c++) if (labels[c - 1] === "メモ") { rightCol = c; break; }
  if (leftCol === -1 || rightCol === -1) {
    return { found: true, blockResolved: false, note: "列群(消化金額〜メモ)を特定できず、チェック/グレーは未判定" };
  }

  // チェックボックス（メモ列の4〜6行）
  let checkboxOn = false;
  for (const row of [4, 5, 6]) {
    const v = headerRows[row - 1]?.[rightCol - 1];
    if (v === true || v === "TRUE" || v === "true") { checkboxOn = true; break; }
  }

  // グレー塗り（ブロック1〜6行の背景色に #999999 近傍があるか）
  let grayed = false;
  try {
    const range = `'${tab}'!${colLetter(leftCol)}1:${colLetter(rightCol)}6`;
    const data = await sheetsGet(
      token,
      `${spreadsheetId}?ranges=${encodeURIComponent(range)}&includeGridData=true&fields=${encodeURIComponent("sheets.data.rowData.values.effectiveFormat.backgroundColor")}`
    );
    const rows = data.sheets?.[0]?.data?.[0]?.rowData || [];
    outer: for (const r of rows) {
      for (const cell of r.values || []) {
        const bg = cell.effectiveFormat?.backgroundColor;
        if (bg && isGray(bg.red ?? 1, bg.green ?? 1, bg.blue ?? 1)) { grayed = true; break outer; }
      }
    }
  } catch {
    return { found: true, blockResolved: true, checkboxOn, note: "背景色の取得に失敗（グレー判定は未実施）" };
  }
  return { found: true, blockResolved: true, checkboxOn, grayed };
}

// GASのGRAY_COLOR='#999999'（0.6,0.6,0.6）。手動塗りの近似色も許容する
function isGray(r: number, g: number, b: number): boolean {
  const near = (v: number) => v > 0.45 && v < 0.75;
  const flat = Math.max(r, g, b) - Math.min(r, g, b) < 0.05;
  return near(r) && near(g) && near(b) && flat;
}

function colLetter(n: number): string {
  let s = "";
  while (n > 0) { const m = (n - 1) % 26; s = String.fromCharCode(65 + m) + s; n = Math.floor((n - 1) / 26); }
  return s;
}

async function sheetsGet(token: string, pathAndQuery: string): Promise<any> {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), 20000);
  try {
    const res = await fetch(`${SHEETS}/${pathAndQuery}`, { headers: { authorization: `Bearer ${token}` }, signal: ctl.signal });
    const data = (await res.json()) as any;
    if (!res.ok) throw new Error(`Sheets API失敗: ${data.error?.message || res.status}`);
    return data;
  } finally {
    clearTimeout(t);
  }
}
