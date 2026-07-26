// 集計表 当たりの狼煙🌱 自動判定セル生成（sheet-fix / noroshi）
// ------------------------------------------------------------
// CR停止判定（ネガ側）のポジ版として、「CPAが目標を下回る＝当たり予備軍」を
// 当たり判定プルダウンと同じ列（消化金額列）の別行に、表示専用の式で点灯させる。
//
// 点灯条件（CPA効率重視。量型は対象外）:
//   AND(
//     消化{metricRow}      >= {targetCell} * {spendlineCell},   … 十分な消化（データ量ゲート）
//     ISNUMBER(CPA{metricRow}) AND CPA{metricRow} <= {targetCell} * {cpaFactor},  … CPAが目標を下回る
//     実質cv{metricRow}    >= {cvMin}                            … 実数の裏付け
//   ) → "当たりの狼煙🌱" / else ""
//
// 対象ブロックの特定:
//   ラベル行（既定1行目）が「消化金額」の列 かつ ID行（既定6行目）が cr… で始まる
//   ＝実CRの列群先頭。その列群内のラベルから「実質cv」列・「CPA」列を自動特定。
//   adset/集計列など cr-id の無い消化金額列は自動スキップ。
//
// 安全設計（構造仕様§5準拠）:
//   - DRY RUN がデフォルト。--apply 時のみ書き込み
//   - 書き込み先（既定7行目）が空でないセルには書かない（既存内容を壊さない）
//   - 表示専用（当たりプルダウン=5行目 には一切触れない）
//   - DRY RUN では metricRow の実値を読んで「点灯/非点灯」を予測表示（既知当たりでの検証用）
//   - 書き込み前に undo ログ保存、書き込み後に再読取で確認
//
// 実行例:
//   node noroshi.mjs --sheet <id|URL> --tab kk_mak --target-cell W5 --spendline-cell W3
//   node noroshi.mjs --sheet <id|URL> --tab kk_mak --target-cell W5 --spendline-cell W3 --apply
//
// 必要な環境変数: GOOGLE_SERVICE_ACCOUNT_JSON
// ------------------------------------------------------------

import { google } from "googleapis";
import { writeFileSync } from "node:fs";

const args = parseArgs(process.argv.slice(2));
if (!args.sheet || !args.tab || !args.targetCell || !args.spendlineCell) {
  console.error("使い方: node noroshi.mjs --sheet <id|URL> --tab <タブ> --target-cell <目標CPAセル 例W5> --spendline-cell <消化ラインセル 例W3> [--label-row 1] [--id-row 6] [--noroshi-row 7] [--metric-row 1100] [--cpa-factor 1.0] [--cv-min 3] [--apply]");
  process.exit(1);
}
const SPREADSHEET_ID = extractId(args.sheet);
const TAB = args.tab;
const LABEL_ROW = Number(args.labelRow || 1);   // 消化金額/実質cv/CPA のラベル行
const ID_ROW = Number(args.idRow || 6);         // cr識別子の行
const NOROSHI_ROW = Number(args.noroshiRow || 7); // のろしを書く行（空き行）
const METRIC_ROW = Number(args.metricRow || 1100); // 指標の判定参照行
const TARGET = args.targetCell;                 // 目標CPAセル（例 $W$5）→絶対参照化
const SPENDLINE = args.spendlineCell;           // 消化ラインセル（例 $W$3）
const CPA_FACTOR = Number(args.cpaFactor || 1.0);
const CV_MIN = Number(args.cvMin || 3);
const APPLY = args.apply || process.env.APPLY === "1";
const UNDO_OUT = args.undoOut || "undo_log.json";
const HEADER_ROWS = Math.max(ID_ROW, LABEL_ROW, NOROSHI_ROW, 8);
const LABEL = "当たりの狼煙🌱";

const raw = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
if (!raw) { console.error("ERROR: GOOGLE_SERVICE_ACCOUNT_JSON が未設定です。"); process.exit(1); }
const creds = JSON.parse(raw);
console.log(`# 実行中のサービスアカウント: ${creds.client_email}`);
console.log(`# モード: ${APPLY ? "APPLY（書き込みあり）" : "DRY RUN（書き込みなし）"}`);
console.log(`# 対象: ${TAB} / ラベル行=${LABEL_ROW} / ID行=${ID_ROW} / のろし行=${NOROSHI_ROW} / 指標行=${METRIC_ROW}`);
console.log(`# 点灯条件: 消化>=${TARGET}*${SPENDLINE} かつ CPA<=${TARGET}${CPA_FACTOR !== 1 ? `*${CPA_FACTOR}` : ""} かつ 実質cv>=${CV_MIN}`);

const auth = new google.auth.GoogleAuth({
  credentials: creds,
  scopes: [APPLY ? "https://www.googleapis.com/auth/spreadsheets" : "https://www.googleapis.com/auth/spreadsheets.readonly"],
});
const sheets = google.sheets({ version: "v4", auth });

const meta = await sheets.spreadsheets.get({ spreadsheetId: SPREADSHEET_ID, fields: "properties.title,sheets(properties(title))" });
console.log(`# スプレッドシート: ${meta.data.properties.title} (${SPREADSHEET_ID})`);
if (!meta.data.sheets.some((s) => s.properties.title === TAB)) {
  console.error(`ERROR: タブ「${TAB}」が見つかりません。`); process.exit(1);
}

// ヘッダー領域を数式で読む（ラベル・ID・のろし行の現在値）
const headRes = await sheets.spreadsheets.values.get({
  spreadsheetId: SPREADSHEET_ID, range: `'${TAB}'!1:${HEADER_ROWS}`, valueRenderOption: "FORMULA",
});
const rows = headRes.data.values || [];
const labelRow = rows[LABEL_ROW - 1] || [];
const idRow = rows[ID_ROW - 1] || [];
const noroshiRowCur = rows[NOROSHI_ROW - 1] || [];

// ブロック走査：ラベル行が「消化金額」かつ ID行が cr… の列＝実CRブロック先頭
const blocks = [];
const skipped = [];
for (let c = 0; c < labelRow.length; c++) {
  if (String(labelRow[c] ?? "").trim() !== "消化金額") continue;
  const id = String(idRow[c] ?? "").trim();
  if (!/^cr\d/i.test(id)) continue; // adset/集計列などはスキップ
  // ブロック終端＝次の「消化金額」列
  let end = labelRow.length;
  for (let g = c + 1; g < labelRow.length; g++) {
    if (String(labelRow[g] ?? "").trim() === "消化金額") { end = g; break; }
  }
  // ブロック内から 実質cv列・CPA列 を特定
  let cvCol = -1, cpaCol = -1;
  for (let g = c + 1; g < end; g++) {
    const lab = String(labelRow[g] ?? "").trim();
    if (lab === "実質cv" && cvCol < 0) cvCol = g;
    if (lab === "CPA" && cpaCol < 0) cpaCol = g;
  }
  if (cvCol < 0 || cpaCol < 0) { skipped.push({ id, col: colToA1(c), reason: `実質cv/CPA列が見つからない（cv:${cvCol < 0 ? "無" : "有"} cpa:${cpaCol < 0 ? "無" : "有"}）` }); continue; }
  const cur = String(noroshiRowCur[c] ?? "").trim();
  blocks.push({ id, discCol: c, cvCol, cpaCol, cell: `${colToA1(c)}${NOROSHI_ROW}`, current: cur });
}

console.log(`\n===== 対象ブロック =====`);
console.log(`実CRブロック（のろし対象）: ${blocks.length}`);
if (skipped.length) {
  console.log(`スキップ（列特定できず）: ${skipped.length}`);
  for (const s of skipped.slice(0, 10)) console.log(`  - ${s.col} ${s.id}: ${s.reason}`);
}

// 書き込み先が空でないブロックは除外（既存内容を壊さない）
const writable = blocks.filter((b) => b.current === "");
const occupied = blocks.filter((b) => b.current !== "");
if (occupied.length) {
  console.log(`\n⚠ ${NOROSHI_ROW}行目が空でないため除外: ${occupied.length} 件（既存内容を壊さない）`);
  for (const b of occupied.slice(0, 10)) console.log(`  - ${b.cell} ${b.id}: 現在値=${JSON.stringify(b.current)}`);
}
if (writable.length === 0) { console.log("\n書き込み可能なブロックがありません。終了します。"); process.exit(0); }

// のろし式を生成
const targetAbs = toAbs(TARGET), spendAbs = toAbs(SPENDLINE);
for (const b of writable) {
  const disc = `${colToA1(b.discCol)}${METRIC_ROW}`;
  const cv = `${colToA1(b.cvCol)}${METRIC_ROW}`;
  const cpa = `${colToA1(b.cpaCol)}${METRIC_ROW}`;
  const cpaThresh = CPA_FACTOR === 1 ? targetAbs : `${targetAbs}*${CPA_FACTOR}`;
  b.formula = `=IF(AND(N(${disc})>=${targetAbs}*${spendAbs},ISNUMBER(${cpa}),${cpa}<=${cpaThresh},N(${cv})>=${CV_MIN}),"${LABEL}","")`;
}

// DRY RUN：metricRow の実値を読んで点灯予測（既知当たりでの検証）
if (!APPLY) {
  const readRanges = [`'${TAB}'!${toA1(TARGET)}`, `'${TAB}'!${toA1(SPENDLINE)}`];
  for (const b of writable) {
    readRanges.push(`'${TAB}'!${colToA1(b.discCol)}${METRIC_ROW}`, `'${TAB}'!${colToA1(b.cvCol)}${METRIC_ROW}`, `'${TAB}'!${colToA1(b.cpaCol)}${METRIC_ROW}`);
  }
  const vals = await sheets.spreadsheets.values.batchGet({ spreadsheetId: SPREADSHEET_ID, ranges: readRanges, valueRenderOption: "UNFORMATTED_VALUE" });
  const vr = vals.data.valueRanges;
  const target = num(vr[0]?.values?.[0]?.[0]);
  const spend = num(vr[1]?.values?.[0]?.[0]);
  let lit = [];
  for (let i = 0; i < writable.length; i++) {
    const disc = num(vr[2 + i * 3]?.values?.[0]?.[0]);
    const cv = num(vr[3 + i * 3]?.values?.[0]?.[0]);
    const cpaRaw = vr[4 + i * 3]?.values?.[0]?.[0];
    const cpaNum = typeof cpaRaw === "number" ? cpaRaw : (isFiniteNum(cpaRaw) ? Number(cpaRaw) : null);
    const on = disc >= target * spend && cpaNum !== null && cpaNum <= target * CPA_FACTOR && cv >= CV_MIN;
    writable[i]._eval = { disc, cv, cpa: cpaNum, on };
    if (on) lit.push(writable[i]);
  }
  console.log(`\n===== 点灯予測（現在の実データ）: ${lit.length} / ${writable.length} 件が点灯 =====`);
  console.log(`（目標CPA=${target} / 消化ライン倍率=${spend} → 消化ゲート=${target * spend} / CPAしきい=${target * CPA_FACTOR} / cv>=${CV_MIN}）`);
  for (const b of lit) {
    console.log(`  🌱 ${b.cell} ${b.id}: 消化=${b._eval.disc} CPA=${b._eval.cpa} 実質cv=${b._eval.cv}`);
  }
  console.log(`\n----- 生成する式のサンプル（先頭2件）-----`);
  for (const b of writable.slice(0, 2)) console.log(`  ${b.cell} (${b.id}): ${b.formula}`);
  console.log(`\nDRY RUN 完了（${writable.length}セルに式を投入予定 / うち現在点灯 ${lit.length}）。適用するには --apply を付けて再実行してください。`);
  process.exit(0);
}

// APPLY：undo ログ→書き込み→確認
const undoLog = {
  spreadsheetId: SPREADSHEET_ID, title: meta.data.properties.title, tab: TAB,
  noroshiRow: NOROSHI_ROW, metricRow: METRIC_ROW, targetCell: TARGET, spendlineCell: SPENDLINE,
  cpaFactor: CPA_FACTOR, cvMin: CV_MIN, appliedAt: new Date().toISOString(), serviceAccount: creds.client_email,
  edits: writable.map((b) => ({ cell: b.cell, before: "", after: b.formula })),
};
writeFileSync(UNDO_OUT, JSON.stringify(undoLog, null, 2));
console.log(`\n# undo ログを保存: ${UNDO_OUT}（before は空。取り消すには対象セルを空にすればよい）`);

await sheets.spreadsheets.values.batchUpdate({
  spreadsheetId: SPREADSHEET_ID,
  requestBody: { valueInputOption: "USER_ENTERED", data: writable.map((b) => ({ range: `'${TAB}'!${b.cell}`, values: [[b.formula]] })) },
});
console.log(`# ${writable.length} セルにのろし式を書き込みました。反映を再読取で確認します…`);

const verify = await sheets.spreadsheets.values.batchGet({ spreadsheetId: SPREADSHEET_ID, ranges: writable.map((b) => `'${TAB}'!${b.cell}`), valueRenderOption: "FORMULA" });
let mismatch = 0;
for (let i = 0; i < writable.length; i++) {
  const now = String(verify.data.valueRanges[i]?.values?.[0]?.[0] ?? "").replace(/\s/g, "");
  if (now !== writable[i].formula.replace(/\s/g, "")) { mismatch++; if (mismatch <= 5) console.log(`  ⚠ ${writable[i].cell}: 反映不一致（要目視）`); }
}
console.log(`\n===== 適用完了: ${writable.length} セル（要目視確認 ${mismatch} 件） =====`);

// ------------------------------------------------------------
function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--sheet") out.sheet = argv[++i];
    else if (a === "--tab") out.tab = argv[++i];
    else if (a === "--target-cell") out.targetCell = argv[++i];
    else if (a === "--spendline-cell") out.spendlineCell = argv[++i];
    else if (a === "--label-row") out.labelRow = argv[++i];
    else if (a === "--id-row") out.idRow = argv[++i];
    else if (a === "--noroshi-row") out.noroshiRow = argv[++i];
    else if (a === "--metric-row") out.metricRow = argv[++i];
    else if (a === "--cpa-factor") out.cpaFactor = argv[++i];
    else if (a === "--cv-min") out.cvMin = argv[++i];
    else if (a === "--apply") out.apply = true;
    else if (a === "--undo-out") out.undoOut = argv[++i];
  }
  return out;
}
function extractId(s) { const m = String(s).match(/\/d\/([a-zA-Z0-9_-]+)/); return m ? m[1] : s; }
function toAbs(cell) { const m = String(cell).match(/^\$?([A-Z]+)\$?(\d+)$/i); return m ? `$${m[1].toUpperCase()}$${m[2]}` : cell; }
function toA1(cell) { return String(cell).replace(/\$/g, ""); }
function num(v) { if (v == null || v === "") return 0; const n = Number(String(v).replace(/[,¥\s]/g, "")); return Number.isFinite(n) ? n : 0; }
function isFiniteNum(v) { if (v == null || v === "") return false; const n = Number(String(v).replace(/[,¥\s]/g, "")); return Number.isFinite(n); }
function colToA1(n) { let s = ""; n = n + 1; while (n > 0) { const r = (n - 1) % 26; s = String.fromCharCode(65 + r) + s; n = Math.floor((n - 1) / 26); } return s; }
