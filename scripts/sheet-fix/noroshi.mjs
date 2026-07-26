// 集計表 当たり予備軍🌱／当たり候補🔥 自動判定セル生成（sheet-fix / noroshi）
// ------------------------------------------------------------
// CR停止判定（ネガ側）のポジ版として、「CPAが目標を下回る＝当たり予備軍/候補」を
// 当たり判定プルダウンと同じ列（消化金額列）の別行（既定2行目）に、表示専用の式で点灯させる。
//
// 点灯条件（CPA効率重視。量型は対象外）:
//   AND(
//     消化{metricRow}      >= {targetCell} * {spendlineCell},   … 十分な消化（データ量ゲート）
//     ISNUMBER(CPA{metricRow}) AND CPA{metricRow} <= {targetCell} * {cpaFactor},  … CPAが目標を下回る
//     実質cv{metricRow}    >= {cvMin}                            … 実数の裏付け
//   ) → "当たり候補🔥"（高角度）/ "当たり予備軍🌱"（予備軍）/ else ""
//
// 親子対応（この改修の肝）:
//   - 各ブロックのメモ列（ラベル「メモ」）の判定行（既定2行目）に親子区分がある
//       * 「親（子有り）」… 自身の指標は「子にて判定」で使えない
//         → 配下の子ブロック（id が <親id>_NN）のバッジセルを OR 集約
//           （子に1つでも 候補 があれば親も候補、なければ 予備軍 があれば親も予備軍）
//       * それ以外（子／親（子無し）／-／その他）… 自身の指標で判定（従来通り）
//
// 対象ブロックの特定:
//   ラベル行（既定1行目）が「消化金額」の列 かつ ID行（既定6行目）が cr… で始まる列群先頭。
//   その列群内のラベルから「実質cv」列・「CPA」列・「メモ」列を自動特定。
//   adset/集計列など cr-id の無い消化金額列は自動スキップ。
//
// 安全設計（構造仕様§5準拠）:
//   - DRY RUN がデフォルト。--apply 時のみ書き込み
//   - 書き込み先（既定2行目）が 空 / "-"（プレースホルダ）/ 既存の当たり式 のセルのみ書く。
//     それ以外の内容（例: 手動注記「エリア」）は保護して除外・報告する
//   - 表示専用（当たりプルダウン=5行目 には一切触れない）
//   - --clear-old-row 指定時、旧行（例7）の当たり式セルを空にする（行移動用）
//   - DRY RUN では metricRow の実値を読んで段階別に点灯予測（親は子集約で予測）
//   - 書き込み前に undo ログ保存、書き込み後に再読取で確認
//
// 実行例:
//   node noroshi.mjs --sheet <id|URL> --tab kk_kou --target-cell W5 --spendline-cell W3 \
//     --metric-row 1101 --noroshi-row 2 --clear-old-row 7
//   （↑に --apply を付けると書き込み）
//
// 必要な環境変数: GOOGLE_SERVICE_ACCOUNT_JSON
// ------------------------------------------------------------

import { google } from "googleapis";
import { writeFileSync } from "node:fs";

const args = parseArgs(process.argv.slice(2));
if (!args.sheet || !args.tab || !args.targetCell || !args.spendlineCell) {
  console.error("使い方: node noroshi.mjs --sheet <id|URL> --tab <タブ> --target-cell <目標CPAセル 例W5> --spendline-cell <消化ラインセル 例W3> [--metric-row 1101] [--noroshi-row 2] [--clear-old-row 7] [--desig-row 2] [--id-row 6] [--settings-tab data] [--settings-col S] [--apply]");
  process.exit(1);
}
const SPREADSHEET_ID = extractId(args.sheet);
const TAB = args.tab;
const LABEL_ROW = Number(args.labelRow || 1);   // 消化金額/実質cv/CPA/メモ のラベル行
const ID_ROW = Number(args.idRow || 6);         // cr識別子の行
const NOROSHI_ROW = Number(args.noroshiRow || 2); // 当たり判定を書く行（既定2＝親子判定行の消化金額列）
const DESIG_ROW = Number(args.desigRow || NOROSHI_ROW); // 親子区分の行（メモ列）。既定はのろし行と同じ
const CLEAR_OLD_ROW = args.clearOldRow ? Number(args.clearOldRow) : null; // 行移動時に旧行の当たり式を掃除
const METRIC_ROW = Number(args.metricRow || 1100); // 指標の判定参照行
const TARGET = args.targetCell;                 // 目標CPAセル（例 W5・タブ別）→絶対参照化
const SPENDLINE = args.spendlineCell;           // 消化ラインセル（例 W3・タブ別）
// のろし基準は data 設定シートのセルを参照（編集はそこで完結）。既定 data!S2:S5。
const SETTINGS_TAB = args.settingsTab || "data";
const SETTINGS_COL = (args.settingsCol || "S").toUpperCase();
const PRE_CPA_ROW = 2;   // 予備軍🌱 CPA係数
const PRE_CV_ROW = 3;    // 予備軍🌱 実質cv下限
const CAND_CPA_ROW = 4;  // 候補🔥 CPA係数
const CAND_CV_ROW = 5;   // 候補🔥 実質cv下限
const APPLY = args.apply || process.env.APPLY === "1";
const UNDO_OUT = args.undoOut || "undo_log.json";
const HEADER_ROWS = Math.max(ID_ROW, LABEL_ROW, NOROSHI_ROW, DESIG_ROW, CLEAR_OLD_ROW || 0, 8);
const LABEL_PRE = "当たり予備軍🌱";   // 予備軍
const LABEL_CAND = "当たり候補🔥";     // 高角度
const MEMO_LABEL = args.memoLabel || "メモ";
const PARENT_MARK = "親（子有り）";   // メモ列の親子区分がこれなら子集約
// 上書き可能なプレースホルダ（意味を持たない仮置き）
const PLACEHOLDERS = new Set(["", "-"]);
// data設定への絶対参照（クロスタブ）
const sref = (row) => `${SETTINGS_TAB}!$${SETTINGS_COL}$${row}`;
const PRE_CPA = sref(PRE_CPA_ROW), PRE_CV = sref(PRE_CV_ROW), CAND_CPA = sref(CAND_CPA_ROW), CAND_CV = sref(CAND_CV_ROW);

const raw = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
if (!raw) { console.error("ERROR: GOOGLE_SERVICE_ACCOUNT_JSON が未設定です。"); process.exit(1); }
const creds = JSON.parse(raw);
console.log(`# 実行中のサービスアカウント: ${creds.client_email}`);
console.log(`# モード: ${APPLY ? "APPLY（書き込みあり）" : "DRY RUN（書き込みなし）"}`);
console.log(`# 対象: ${TAB} / ラベル行=${LABEL_ROW} / ID行=${ID_ROW} / 当たり判定行=${NOROSHI_ROW} / 親子区分行=${DESIG_ROW} / 指標行=${METRIC_ROW}${CLEAR_OLD_ROW ? ` / 旧行掃除=${CLEAR_OLD_ROW}` : ""}`);
console.log(`# 消化ゲート: 消化>=${TARGET}*${SPENDLINE}`);
console.log(`# 🔥候補: CPA<=${TARGET}*${CAND_CPA} かつ 実質cv>=${CAND_CV}`);
console.log(`# 🌱予備軍: CPA<=${TARGET}*${PRE_CPA} かつ 実質cv>=${PRE_CV}`);
console.log(`# 親（子有り）は配下の子バッジを OR 集約（自身の指標は使わない）`);

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

// ヘッダー領域を数式で読む（ラベル・ID・判定行の現在値）
const headRes = await sheets.spreadsheets.values.get({
  spreadsheetId: SPREADSHEET_ID, range: `'${TAB}'!1:${HEADER_ROWS}`, valueRenderOption: "FORMULA",
});
const rows = headRes.data.values || [];
const labelRow = rows[LABEL_ROW - 1] || [];
const idRow = rows[ID_ROW - 1] || [];
const noroshiRowCur = rows[NOROSHI_ROW - 1] || [];
const desigRowCur = rows[DESIG_ROW - 1] || [];
const clearRowCur = CLEAR_OLD_ROW ? (rows[CLEAR_OLD_ROW - 1] || []) : [];

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
  // ブロック内から 実質cv列・CPA列・メモ列 を特定
  let cvCol = -1, cpaCol = -1, memoCol = -1;
  for (let g = c + 1; g < end; g++) {
    const lab = String(labelRow[g] ?? "").trim();
    if (lab === "実質cv" && cvCol < 0) cvCol = g;
    if (lab === "CPA" && cpaCol < 0) cpaCol = g;
    if (lab === MEMO_LABEL && memoCol < 0) memoCol = g;
  }
  if (cvCol < 0 || cpaCol < 0) { skipped.push({ id, col: colToA1(c), reason: `実質cv/CPA列が見つからない（cv:${cvCol < 0 ? "無" : "有"} cpa:${cpaCol < 0 ? "無" : "有"}）` }); continue; }
  const cur = String(noroshiRowCur[c] ?? "").trim();
  const desig = memoCol >= 0 ? String(desigRowCur[memoCol] ?? "").trim() : "";
  blocks.push({ id, discCol: c, cvCol, cpaCol, memoCol, desig, cell: `${colToA1(c)}${NOROSHI_ROW}`, current: cur });
}

console.log(`\n===== 対象ブロック =====`);
console.log(`実CRブロック（当たり判定対象）: ${blocks.length}`);
if (skipped.length) {
  console.log(`スキップ（列特定できず）: ${skipped.length}`);
  for (const s of skipped.slice(0, 10)) console.log(`  - ${s.col} ${s.id}: ${s.reason}`);
}

// id → ブロック（子検索用）。重複idは配列で保持
const byId = new Map();
for (const b of blocks) {
  if (!byId.has(b.id)) byId.set(b.id, []);
  byId.get(b.id).push(b);
}
// 親（子有り）に子ブロックを紐付け（id が <親id>_NN）
let parentWithKids = 0, parentNoKids = 0;
for (const b of blocks) {
  b.isParent = b.desig.includes(PARENT_MARK);
  if (!b.isParent) continue;
  const re = new RegExp(`^${escapeReg(b.id)}_\\d+$`, "i");
  b.kids = blocks.filter((x) => re.test(x.id));
  if (b.kids.length) parentWithKids++; else parentNoKids++;
}
console.log(`親（子有り）: ${blocks.filter((b) => b.isParent).length} 件（うち子ブロック検出 ${parentWithKids} 件 / 子未検出 ${parentNoKids} 件は自身の指標で判定）`);

// 書き込み可否：空 / "-"（プレースホルダ）/ 既存の当たり式 のみ書込・更新可。
// それ以外（手動注記など）は保護して除外。
const isOurs = (v) => v.includes("当たり予備軍") || v.includes("当たり候補") || v.includes("当たりの狼煙");
const canWrite = (v) => PLACEHOLDERS.has(v) || isOurs(v);
const writable = blocks.filter((b) => canWrite(b.current));
const foreign = blocks.filter((b) => !canWrite(b.current));
const updateCount = writable.filter((b) => isOurs(b.current)).length;
if (updateCount) console.log(`（うち ${updateCount} 件は既存の当たり式の更新）`);
if (foreign.length) {
  console.log(`\n⚠ ${NOROSHI_ROW}行目に保護対象の内容があるため除外: ${foreign.length} 件（既存内容を壊さない）`);
  for (const b of foreign.slice(0, 15)) console.log(`  - ${b.cell} ${b.id}: 現在値=${JSON.stringify(b.current)}`);
}
if (writable.length === 0) { console.log("\n書き込み可能なブロックがありません。終了します。"); process.exit(0); }

// 式の生成
const targetAbs = toAbs(TARGET), spendAbs = toAbs(SPENDLINE);
const writableSet = new Set(writable);
const selfFormula = (b) => {
  const disc = `${colToA1(b.discCol)}${METRIC_ROW}`;
  const cv = `${colToA1(b.cvCol)}${METRIC_ROW}`;
  const cpa = `${colToA1(b.cpaCol)}${METRIC_ROW}`;
  return (
    `=IF(N(${disc})<${targetAbs}*${spendAbs},"",` +
    `IF(AND(ISNUMBER(${cpa}),${cpa}<=${targetAbs}*${CAND_CPA},N(${cv})>=${CAND_CV}),"${LABEL_CAND}",` +
    `IF(AND(ISNUMBER(${cpa}),${cpa}<=${targetAbs}*${PRE_CPA},N(${cv})>=${PRE_CV}),"${LABEL_PRE}","")))`
  );
};
// 親（子有り）: 子のバッジセル（子の discCol × NOROSHI_ROW）を OR 集約
const parentFormula = (b) => {
  const refs = b.kids.map((k) => `${colToA1(k.discCol)}${NOROSHI_ROW}`);
  const orEq = (label) => `OR(${refs.map((r) => `${r}="${label}"`).join(",")})`;
  return `=IF(${orEq(LABEL_CAND)},"${LABEL_CAND}",IF(${orEq(LABEL_PRE)},"${LABEL_PRE}",""))`;
};
for (const b of writable) {
  b.aggregated = b.isParent && b.kids && b.kids.length > 0;
  b.formula = b.aggregated ? parentFormula(b) : selfFormula(b);
}

// DRY RUN：metricRow の実値＋data設定を読んで段階別に点灯予測（親は子集約で予測）
if (!APPLY) {
  const selfBlocks = writable.filter((b) => !b.aggregated);
  const srefRead = (row) => `${SETTINGS_TAB}!${SETTINGS_COL}${row}`; // batchGet 用（$なし）
  const readRanges = [
    `'${TAB}'!${toA1(TARGET)}`, `'${TAB}'!${toA1(SPENDLINE)}`,
    srefRead(PRE_CPA_ROW), srefRead(PRE_CV_ROW), srefRead(CAND_CPA_ROW), srefRead(CAND_CV_ROW),
  ];
  for (const b of selfBlocks) {
    readRanges.push(`'${TAB}'!${colToA1(b.discCol)}${METRIC_ROW}`, `'${TAB}'!${colToA1(b.cvCol)}${METRIC_ROW}`, `'${TAB}'!${colToA1(b.cpaCol)}${METRIC_ROW}`);
  }
  const vals = await sheets.spreadsheets.values.batchGet({ spreadsheetId: SPREADSHEET_ID, ranges: readRanges, valueRenderOption: "UNFORMATTED_VALUE" });
  const vr = vals.data.valueRanges;
  const target = num(vr[0]?.values?.[0]?.[0]);
  const spend = num(vr[1]?.values?.[0]?.[0]);
  const preCpaF = num(vr[2]?.values?.[0]?.[0]);
  const preCvMin = num(vr[3]?.values?.[0]?.[0]);
  const candCpaF = num(vr[4]?.values?.[0]?.[0]);
  const candCvMin = num(vr[5]?.values?.[0]?.[0]);
  const OFF = 6;
  for (let i = 0; i < selfBlocks.length; i++) {
    const b = selfBlocks[i];
    const disc = num(vr[OFF + i * 3]?.values?.[0]?.[0]);
    const cv = num(vr[OFF + 1 + i * 3]?.values?.[0]?.[0]);
    const cpaRaw = vr[OFF + 2 + i * 3]?.values?.[0]?.[0];
    const cpaNum = typeof cpaRaw === "number" ? cpaRaw : (isFiniteNum(cpaRaw) ? Number(cpaRaw) : null);
    const gate = disc >= target * spend && cpaNum !== null;
    let tier = "";
    if (gate && cpaNum <= target * candCpaF && cv >= candCvMin) tier = "cand";
    else if (gate && cpaNum <= target * preCpaF && cv >= preCvMin) tier = "pre";
    b._eval = { disc, cv, cpa: cpaNum, tier };
  }
  // 親の予測 = 子の最上位ティア（子が writable でないと _eval 無し→"" 扱い）
  const rank = { cand: 2, pre: 1, "": 0 };
  const tierName = { 2: "cand", 1: "pre", 0: "" };
  for (const b of writable.filter((x) => x.aggregated)) {
    let best = 0;
    for (const k of b.kids) best = Math.max(best, rank[k._eval?.tier || ""] ?? 0);
    b._eval = { tier: tierName[best], viaKids: b.kids.length };
  }
  const cands = writable.filter((b) => b._eval?.tier === "cand");
  const pres = writable.filter((b) => b._eval?.tier === "pre");
  console.log(`\n# data設定: 予備軍CPA係数=${preCpaF} cv下限=${preCvMin} / 候補CPA係数=${candCpaF} cv下限=${candCvMin}`);
  console.log(`（目標CPA=${target} / 消化ゲート=${target * spend}）`);
  console.log(`\n===== 点灯予測: 🔥候補 ${cands.length}件 / 🌱予備軍 ${pres.length}件 （対象 ${writable.length}）=====`);
  for (const b of cands) console.log(`  🔥 ${b.cell} ${b.id}: ${fmtEval(b)}`);
  for (const b of pres) console.log(`  🌱 ${b.cell} ${b.id}: ${fmtEval(b)}`);
  console.log(`\n----- 生成する式のサンプル -----`);
  const sampleSelf = writable.find((b) => !b.aggregated);
  const sampleParent = writable.find((b) => b.aggregated);
  if (sampleSelf) console.log(`  [自身判定] ${sampleSelf.cell} (${sampleSelf.id}): ${sampleSelf.formula}`);
  if (sampleParent) console.log(`  [親=子集約] ${sampleParent.cell} (${sampleParent.id}, 子${sampleParent.kids.length}件): ${sampleParent.formula}`);
  if (CLEAR_OLD_ROW) {
    const toClear = blocks.filter((b) => isOurs(String(clearRowCur[b.discCol] ?? "").trim()));
    console.log(`\n# 旧行 ${CLEAR_OLD_ROW} の当たり式を空にする対象: ${toClear.length} 件`);
  }
  console.log(`\nDRY RUN 完了（${writable.length}セルに式を投入予定）。適用するには --apply を付けて再実行してください。`);
  process.exit(0);
}

// APPLY：undo ログ→書き込み→確認
const clearTargets = CLEAR_OLD_ROW
  ? blocks.filter((b) => isOurs(String(clearRowCur[b.discCol] ?? "").trim()))
      .map((b) => ({ cell: `${colToA1(b.discCol)}${CLEAR_OLD_ROW}`, before: String(clearRowCur[b.discCol]).trim(), after: "" }))
  : [];
const undoLog = {
  spreadsheetId: SPREADSHEET_ID, title: meta.data.properties.title, tab: TAB,
  noroshiRow: NOROSHI_ROW, metricRow: METRIC_ROW, targetCell: TARGET, spendlineCell: SPENDLINE,
  clearOldRow: CLEAR_OLD_ROW,
  settings: { tab: SETTINGS_TAB, preCpa: PRE_CPA, preCv: PRE_CV, candCpa: CAND_CPA, candCv: CAND_CV },
  appliedAt: new Date().toISOString(), serviceAccount: creds.client_email,
  edits: writable.map((b) => ({ cell: b.cell, before: b.current, after: b.formula })),
  clears: clearTargets,
};
writeFileSync(UNDO_OUT, JSON.stringify(undoLog, null, 2));
console.log(`\n# undo ログを保存: ${UNDO_OUT}（当たり判定セルは空/"-"に戻す。掃除した旧行は元の式を復元）`);

const data = writable.map((b) => ({ range: `'${TAB}'!${b.cell}`, values: [[b.formula]] }));
for (const c of clearTargets) data.push({ range: `'${TAB}'!${c.cell}`, values: [[""]] });
await sheets.spreadsheets.values.batchUpdate({
  spreadsheetId: SPREADSHEET_ID,
  requestBody: { valueInputOption: "USER_ENTERED", data },
});
console.log(`# ${writable.length} セルに当たり判定式を書き込み${clearTargets.length ? `、旧行 ${clearTargets.length} セルを掃除` : ""}しました。反映を再読取で確認します…`);

const verify = await sheets.spreadsheets.values.batchGet({ spreadsheetId: SPREADSHEET_ID, ranges: writable.map((b) => `'${TAB}'!${b.cell}`), valueRenderOption: "FORMULA" });
let mismatch = 0;
for (let i = 0; i < writable.length; i++) {
  const now = String(verify.data.valueRanges[i]?.values?.[0]?.[0] ?? "").replace(/\s/g, "");
  if (now !== writable[i].formula.replace(/\s/g, "")) { mismatch++; if (mismatch <= 5) console.log(`  ⚠ ${writable[i].cell}: 反映不一致（要目視）`); }
}
console.log(`\n===== 適用完了: ${writable.length} セル（要目視確認 ${mismatch} 件）${clearTargets.length ? ` / 旧行掃除 ${clearTargets.length} セル` : ""} =====`);

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
    else if (a === "--desig-row") out.desigRow = argv[++i];
    else if (a === "--clear-old-row") out.clearOldRow = argv[++i];
    else if (a === "--metric-row") out.metricRow = argv[++i];
    else if (a === "--memo-label") out.memoLabel = argv[++i];
    else if (a === "--settings-tab") out.settingsTab = argv[++i];
    else if (a === "--settings-col") out.settingsCol = argv[++i];
    else if (a === "--apply") out.apply = true;
    else if (a === "--undo-out") out.undoOut = argv[++i];
  }
  return out;
}
function fmtEval(b) {
  if (b.aggregated) return `親→子${b._eval.viaKids}件を集約`;
  return `消化=${b._eval.disc} CPA=${b._eval.cpa} 実質cv=${b._eval.cv}`;
}
function escapeReg(s) { return String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }
function extractId(s) { const m = String(s).match(/\/d\/([a-zA-Z0-9_-]+)/); return m ? m[1] : s; }
function toAbs(cell) { const m = String(cell).match(/^\$?([A-Z]+)\$?(\d+)$/i); return m ? `$${m[1].toUpperCase()}$${m[2]}` : cell; }
function toA1(cell) { return String(cell).replace(/\$/g, ""); }
function num(v) { if (v == null || v === "") return 0; const n = Number(String(v).replace(/[,¥\s]/g, "")); return Number.isFinite(n) ? n : 0; }
function isFiniteNum(v) { if (v == null || v === "") return false; const n = Number(String(v).replace(/[,¥\s]/g, "")); return Number.isFinite(n); }
function colToA1(n) { let s = ""; n = n + 1; while (n > 0) { const r = (n - 1) % 26; s = String.fromCharCode(65 + r) + s; n = Math.floor((n - 1) / 26); } return s; }
