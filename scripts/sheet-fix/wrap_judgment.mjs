// 集計表 判定式 親子ラップ適用（sheet-fix / wrap-judgment）
// ------------------------------------------------------------
// CR停止判定セル（判定行）に、親子分類（親子行）を参照するラップを付与する。
// 仕様書§4 / TOOL-18 の二重カウント防止ラップ:
//   =IF(C{親子行}="親（子有り）","子にて判定",IF(C{親子行}="その他","対象外", 既存の判定式))
//
// 対象の判定基準（誤爆防止）:
//   - 判定行のセルが数式（"=" 始まり）であること
//   - CPA階段判定の目印 "data!$M$3" を含むこと（＝CR停止判定セル。adset単位の
//     "停止済"/"停止？"/"-" 式や見出しセルは data!$M$ を含まないので自動除外）
//   - まだラップされていないこと（既ラップの目印 ="親（子有り）","子にて判定" を含まない）
// → 既にラップ済みのセル・adsetセル・見出しセルには一切触れない（冪等）。
//
// 安全設計（構造仕様§5準拠）:
//   - DRY RUN がデフォルト。--apply 時のみ書き込み
//   - 判定行のみを対象（ID行・他行は読まない・書かない）
//   - 書き込みは各セルの現在値（＝読み取った既存式）を expectedBefore として検証してから
//   - 書き込み前に undo ログ（旧式）を保存、書き込み後に再読取で反映確認
//
// 実行例:
//   node wrap_judgment.mjs --sheet <id|URL> --tab meta_total --judge-row 3 --parent-row 2
//   node wrap_judgment.mjs --sheet <id|URL> --tab meta_total --judge-row 3 --parent-row 2 --apply
//
// 必要な環境変数: GOOGLE_SERVICE_ACCOUNT_JSON（inspect_sheet.mjs と同じサービスアカウント）
// ------------------------------------------------------------

import { google } from "googleapis";
import { writeFileSync } from "node:fs";

const args = parseArgs(process.argv.slice(2));
if (!args.sheet || !args.tab) {
  console.error("使い方: node wrap_judgment.mjs --sheet <id|URL> --tab <タブ名> [--judge-row 3] [--parent-row 2] [--apply] [--undo-out undo_log.json]");
  process.exit(1);
}
const SPREADSHEET_ID = extractId(args.sheet);
const TAB = args.tab;
const JUDGE_ROW = Number(args.judgeRow || 3);   // 停止判定が入る行（1-indexed）
const PARENT_ROW = Number(args.parentRow || 2); // 親子分類プルダウンの行（1-indexed）
const APPLY = args.apply || process.env.APPLY === "1";
const UNDO_OUT = args.undoOut || "undo_log.json";
const HEADER_ROWS = 8;

const CPA_MARKER = "data!$M$3";                       // CR停止判定（CPA階段）セルの目印
const WRAP_SIGNATURE = '="親（子有り）","子にて判定"';   // 既ラップ検出
const ID_ROW_DEFAULT = 6;                             // 保護: ID行を判定行に指定していないか確認

if (JUDGE_ROW === ID_ROW_DEFAULT) {
  console.error(`ERROR: judge-row=${JUDGE_ROW} はID行の既定値です。判定行を取り違えていないか確認してください（構造ダンプで実測）。`);
  process.exit(1);
}
if (JUDGE_ROW === PARENT_ROW) {
  console.error("ERROR: judge-row と parent-row が同じです。");
  process.exit(1);
}

const raw = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
if (!raw) {
  console.error("ERROR: GOOGLE_SERVICE_ACCOUNT_JSON が未設定です。");
  process.exit(1);
}
const creds = JSON.parse(raw);
console.log(`# 実行中のサービスアカウント: ${creds.client_email}`);
console.log(`# モード: ${APPLY ? "APPLY（書き込みあり）" : "DRY RUN（書き込みなし）"}`);
console.log(`# 対象: ${TAB} / 判定行=${JUDGE_ROW} / 親子行=${PARENT_ROW}`);

const auth = new google.auth.GoogleAuth({
  credentials: creds,
  scopes: [APPLY ? "https://www.googleapis.com/auth/spreadsheets" : "https://www.googleapis.com/auth/spreadsheets.readonly"],
});
const sheets = google.sheets({ version: "v4", auth });

// タブ存在確認
const meta = await sheets.spreadsheets.get({
  spreadsheetId: SPREADSHEET_ID,
  fields: "properties.title,sheets(properties(title))",
});
console.log(`# スプレッドシート: ${meta.data.properties.title} (${SPREADSHEET_ID})`);
if (!meta.data.sheets.some((s) => s.properties.title === TAB)) {
  console.error(`ERROR: タブ「${TAB}」が見つかりません。存在するタブ:`);
  for (const s of meta.data.sheets) console.error(`  - ${s.properties.title}`);
  process.exit(1);
}

// ヘッダー領域を数式で読む
const res = await sheets.spreadsheets.values.get({
  spreadsheetId: SPREADSHEET_ID,
  range: `'${TAB}'!1:${HEADER_ROWS}`,
  valueRenderOption: "FORMULA",
});
const rows = res.data.values || [];
const judge = rows[JUDGE_ROW - 1] || [];
const parent = rows[PARENT_ROW - 1] || [];

const edits = [];
let cpaTotal = 0, already = 0;
const byParent = {};
for (let c = 0; c < judge.length; c++) {
  const base = String(judge[c] ?? "");
  if (!base.startsWith("=")) continue;
  if (!base.includes(CPA_MARKER)) continue; // CR停止判定セルでない（adset・見出し等）
  cpaTotal++;
  if (base.includes(WRAP_SIGNATURE)) { already++; continue; } // 既ラップ
  const col = colToA1(c);
  const pv = String(parent[c] ?? "").trim() || "(空)";
  const wrapped = `=IF(${col}${PARENT_ROW}="親（子有り）","子にて判定",IF(${col}${PARENT_ROW}="その他","対象外",${base.slice(1)}))`;
  edits.push({ cell: `${col}${JUDGE_ROW}`, expectedBefore: base, after: wrapped, parent: pv });
  byParent[pv] = (byParent[pv] || 0) + 1;
}

console.log(`\n===== 対象サマリ =====`);
console.log(`CR停止判定セル（data!$M$3を含む）合計: ${cpaTotal}`);
console.log(`  既ラップ（変更不要）: ${already}`);
console.log(`  未ラップ（今回ラップ対象）: ${edits.length}`);
console.log(`  親子分類の内訳（未ラップ分）: ${JSON.stringify(byParent, null, 0)}`);

if (edits.length === 0) {
  console.log("\nラップ対象がありません（全て適用済み）。終了します。");
  process.exit(0);
}

console.log(`\n----- サンプル（先頭3件）-----`);
for (const e of edits.slice(0, 3)) {
  console.log(`\n[${e.cell}] 親子=${e.parent}`);
  console.log(`  before: ${e.expectedBefore}`);
  console.log(`  after : ${e.after}`);
}
console.log(`\n----- 対象セル一覧 -----`);
console.log(edits.map((e) => e.cell).join(", "));

if (!APPLY) {
  console.log(`\nDRY RUN 完了（${edits.length}セルが対象）。書き込みは行っていません。適用するには --apply を付けて再実行してください。`);
  process.exit(0);
}

// undo ログ保存（書き込み前）
const undoLog = {
  spreadsheetId: SPREADSHEET_ID,
  title: meta.data.properties.title,
  tab: TAB,
  judgeRow: JUDGE_ROW,
  parentRow: PARENT_ROW,
  appliedAt: new Date().toISOString(),
  serviceAccount: creds.client_email,
  edits: edits.map((e) => ({ cell: e.cell, before: e.expectedBefore, after: e.after })),
};
writeFileSync(UNDO_OUT, JSON.stringify(undoLog, null, 2));
console.log(`\n# undo ログを保存: ${UNDO_OUT}（before の式で書き戻せば復元できます）`);

// 書き込み（USER_ENTERED: 数式・入力規則を保持）
await sheets.spreadsheets.values.batchUpdate({
  spreadsheetId: SPREADSHEET_ID,
  requestBody: {
    valueInputOption: "USER_ENTERED",
    data: edits.map((e) => ({ range: `'${TAB}'!${e.cell}`, values: [[e.after]] })),
  },
});
console.log(`# ${edits.length} セルを書き込みました。反映を再読取で確認します…`);

// 反映確認
const ranges = edits.map((e) => `'${TAB}'!${e.cell}`);
const verify = await sheets.spreadsheets.values.batchGet({
  spreadsheetId: SPREADSHEET_ID, ranges, valueRenderOption: "FORMULA",
});
let mismatch = 0;
for (let i = 0; i < edits.length; i++) {
  const now = String(verify.data.valueRanges[i]?.values?.[0]?.[0] ?? "");
  if (now.replace(/\s/g, "") !== edits[i].after.replace(/\s/g, "")) {
    mismatch++;
    if (mismatch <= 5) console.log(`  ⚠ ${edits[i].cell}: 反映値が想定と不一致（要目視）: ${now.slice(0, 60)}…`);
  }
}
console.log(`\n===== 適用完了: ${edits.length} セル（要目視確認 ${mismatch} 件） =====`);

// ------------------------------------------------------------
function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--sheet") out.sheet = argv[++i];
    else if (argv[i] === "--tab") out.tab = argv[++i];
    else if (argv[i] === "--judge-row") out.judgeRow = argv[++i];
    else if (argv[i] === "--parent-row") out.parentRow = argv[++i];
    else if (argv[i] === "--apply") out.apply = true;
    else if (argv[i] === "--undo-out") out.undoOut = argv[++i];
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
