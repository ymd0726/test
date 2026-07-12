// 集計表 構造ダンプ（読み取り専用）
// ------------------------------------------------------------
// cr入稿くん Phase 0: 対象タブの CR00 テンプレブロック位置・幅・
// 「集計外CR→」マーカー列・クリエイティブID行・メモ列構成・列グループ化を実測する。
//
// 実行例:
//   node inspect_sheet.mjs --sheet 1oEK8JCJg2NcseWmnxLtfNFCe5A7XGJ_DJSj7c2EW1sg --tab meta_kk_mak
//   node inspect_sheet.mjs --sheet <spreadsheetId>            # 全タブ一覧＋cr00を含むタブを自動検出
//
// 必要な環境変数: GOOGLE_SERVICE_ACCOUNT_JSON（ad-analysis と同じサービスアカウント）
// 書き込みは一切行わない（scope: spreadsheets.readonly）。
// ------------------------------------------------------------

import { google } from "googleapis";

const args = parseArgs(process.argv.slice(2));
if (!args.sheet) {
  console.error("使い方: node inspect_sheet.mjs --sheet <spreadsheetId|URL> [--tab <タブ名>] [--json]");
  process.exit(1);
}
const SPREADSHEET_ID = extractId(args.sheet);
const MARKER = "集計外CR→";
const TEMPLATE_ID = "cr00";
// クリエイティブIDが入る行の探索範囲（1-indexed）。通常6行目、案件により7〜8行目（cr停止くん仕様と同じ1〜8行探索）
const ID_ROW_SEARCH = 8;

const raw = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
if (!raw) {
  console.error("ERROR: GOOGLE_SERVICE_ACCOUNT_JSON が未設定です。");
  process.exit(1);
}
const creds = JSON.parse(raw);
console.log(`# 実行中のサービスアカウント: ${creds.client_email}`);
const auth = new google.auth.GoogleAuth({
  credentials: creds,
  scopes: ["https://www.googleapis.com/auth/spreadsheets.readonly"],
});
const sheets = google.sheets({ version: "v4", auth });

// --- タブ一覧＋列グループ化メタデータ ---
const meta = await sheets.spreadsheets.get({
  spreadsheetId: SPREADSHEET_ID,
  fields:
    "properties.title,sheets(properties(sheetId,title,gridProperties(rowCount,columnCount)),columnGroups)",
});
console.log(`# スプレッドシート: ${meta.data.properties.title} (${SPREADSHEET_ID})`);
console.log(`# タブ数: ${meta.data.sheets.length}`);
console.log(`# 全タブ名: ${meta.data.sheets.map((s) => s.properties.title).join(" | ")}`);

const targets = args.tab
  ? meta.data.sheets.filter((s) => s.properties.title === args.tab)
  : meta.data.sheets;
if (args.tab && targets.length === 0) {
  console.error(`ERROR: タブ「${args.tab}」が見つかりません。存在するタブ:`);
  for (const s of meta.data.sheets) console.error(`  - ${s.properties.title}`);
  process.exit(1);
}

const report = { spreadsheetId: SPREADSHEET_ID, title: meta.data.properties.title, tabs: [] };

for (const sheet of targets) {
  const p = sheet.properties;
  // ヘッダー領域（1〜ID_ROW_SEARCH行）だけ読む。列数はタブの実列数まで。
  const range = `'${p.title}'!1:${ID_ROW_SEARCH}`;
  let rows;
  try {
    const res = await sheets.spreadsheets.values.get({
      spreadsheetId: SPREADSHEET_ID,
      range,
      valueRenderOption: "FORMATTED_VALUE",
    });
    rows = res.data.values || [];
  } catch (e) {
    console.log(`\n## タブ: ${p.title} … 読取エラー(${e.message})、スキップ`);
    continue;
  }
  const info = analyzeTab(p, sheet.columnGroups || [], rows);
  if (!args.tab && info.cr00Blocks.length === 0) continue; // 全タブモードではcr00があるタブだけ報告
  report.tabs.push(info);
  printTab(info);

  // --dump: 対象タブの1〜ID行の非空セルを A1:値 で全出力（実構造の目視確認用）
  if (args.tab && args.dump) {
    console.log(`\n--- ${p.title} 非空セルダンプ（1〜${rows.length}行 / A1:値）---`);
    for (let r = 0; r < rows.length; r++) {
      const cells = [];
      for (let c = 0; c < (rows[r] || []).length; c++) {
        const v = String(rows[r][c] ?? "").trim();
        if (v) cells.push(`${colToA1(c)}${r + 1}=${v.slice(0, 30)}`);
      }
      if (cells.length) console.log(`[行${r + 1}] ${cells.join(" | ")}`);
    }
    // cr-idセルの不可視文字検査（BUG-28: 「存在するのに見つからない」原因の切り分け用）。
    // ASCII外・制御・ゼロ幅文字や前後空白を含む cr セルを JSON+コードポイントで晒す
    console.log(`\n--- cr-idセルの文字検査（非ASCII/不可視文字があれば表示）---`);
    let suspicious = 0;
    for (let r = 0; r < rows.length; r++) {
      for (let c = 0; c < (rows[r] || []).length; c++) {
        const raw = String(rows[r][c] ?? "");
        if (!/cr\d/i.test(raw)) continue;
        if (/^[\x20-\x7E]*$/.test(raw) && raw === raw.trim()) continue; // 純ASCII・前後空白なしはOK
        const codes = [...raw].map((ch) => "U+" + ch.codePointAt(0).toString(16).toUpperCase().padStart(4, "0")).join(" ");
        console.log(`${colToA1(c)}${r + 1}: ${JSON.stringify(raw)} [${codes}]`);
        suspicious++;
      }
    }
    console.log(suspicious === 0 ? "→ 問題のあるcr-idセルなし（全て純ASCII）" : `→ ${suspicious}件の要注意セル`);
  }
}

if (args.json) {
  console.log("\n===== JSON =====");
  console.log(JSON.stringify(report, null, 2));
}

// ------------------------------------------------------------
function analyzeTab(props, columnGroups, rows) {
  const colCount = Math.max(...rows.map((r) => r.length), 0);
  const row0 = rows[0] || []; // 0行目（表示上の1行目）: メモ/マーカー行

  // マーカー列
  let markerCol = -1;
  for (let c = 0; c < row0.length; c++) {
    if (String(row0[c]).trim() === MARKER) { markerCol = c; break; }
  }

  // ID行の特定: 1〜8行目のうち "cr" 始まりのセルが最も多い行
  let idRowIdx = -1, best = 0;
  for (let r = 1; r < rows.length; r++) {
    const n = (rows[r] || []).filter((v) => /^cr\d/i.test(String(v).trim())).length;
    if (n > best) { best = n; idRowIdx = r; }
  }
  const idRow = idRowIdx >= 0 ? rows[idRowIdx] : [];

  // メモ列（row0 が「メモ」）＝各ブロックの末尾
  const memoCols = [];
  for (let c = 0; c < row0.length; c++) {
    if (String(row0[c]).trim() === "メモ") memoCols.push(c);
  }

  // ブロック分割: 前のメモ列+1 〜 次のメモ列 を1ブロックとみなす
  const blocks = [];
  let start = 0;
  for (const memoCol of memoCols) {
    const ids = [];
    for (let c = start; c <= memoCol; c++) {
      const v = String(idRow[c] || "").trim();
      if (v) ids.push({ col: c, id: v });
    }
    blocks.push({
      startCol: start,
      endCol: memoCol,
      width: memoCol - start + 1,
      memoCol,
      zone: markerCol >= 0 ? (memoCol < markerCol ? "集計内(左)" : "集計外(右)") : "不明",
      creativeIds: ids,
    });
    start = memoCol + 1;
  }

  const cr00Blocks = blocks.filter((b) =>
    b.creativeIds.some((x) => x.id.toLowerCase() === TEMPLATE_ID)
  );

  return {
    tab: props.title,
    sheetId: props.sheetId,
    gridCols: props.gridProperties?.columnCount,
    usedHeaderCols: colCount,
    markerCol,
    markerColA1: markerCol >= 0 ? colToA1(markerCol) : null,
    idRow: idRowIdx + 1, // 1-indexed
    blockCount: blocks.length,
    memoColCount: memoCols.length,
    cr00Blocks: cr00Blocks.map((b) => ({ ...b, startA1: colToA1(b.startCol), endA1: colToA1(b.endCol) })),
    blocksSample: blocks.slice(0, 5),
    columnGroups: columnGroups.map((g) => ({
      start: g.range?.startIndex,
      end: g.range?.endIndex,
      depth: g.depth,
      collapsed: g.collapsed,
    })),
  };
}

function printTab(t) {
  console.log(`\n## タブ: ${t.tab} (sheetId=${t.sheetId})`);
  console.log(`- 列数: grid=${t.gridCols} / ヘッダー実使用=${t.usedHeaderCols}`);
  console.log(`- 「${MARKER}」マーカー列: ${t.markerCol >= 0 ? `${t.markerCol} (${t.markerColA1})` : "見つからず"}`);
  console.log(`- クリエイティブID行: ${t.idRow}行目`);
  console.log(`- ブロック数(メモ列数): ${t.blockCount}`);
  console.log(`- cr00テンプレブロック: ${t.cr00Blocks.length}個`);
  for (const b of t.cr00Blocks) {
    console.log(`    * ${b.zone} cols ${b.startCol}-${b.endCol} (${b.startA1}:${b.endA1}) 幅${b.width} 列`);
  }
  console.log(`- 列グループ化: ${t.columnGroups.length}個`);
}

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--sheet") out.sheet = argv[++i];
    else if (argv[i] === "--tab") out.tab = argv[++i];
    else if (argv[i] === "--json") out.json = true;
    else if (argv[i] === "--dump") out.dump = true;
  }
  return out;
}

function extractId(s) {
  const m = String(s).match(/\/d\/([a-zA-Z0-9_-]+)/);
  return m ? m[1] : s;
}

function colToA1(n) {
  let s = "";
  n = n + 1;
  while (n > 0) { const r = (n - 1) % 26; s = String.fromCharCode(65 + r) + s; n = Math.floor((n - 1) / 26); }
  return s;
}
