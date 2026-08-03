// 集計表 当たり候補🌱／当たり候補🌱🌱 自動判定セル生成（sheet-fix / noroshi）
// ------------------------------------------------------------
// CR停止判定（ネガ側）のポジ版として、「CPAが目標を下回る＝当たり候補」を
// 当たり判定プルダウンと同じ列（消化金額列）の別行（既定2行目）に、表示専用の式で点灯させる。
// 段階は新芽の数で表現（🌱=1段階目 / 🌱🌱=2段階目・高角度）。
//
// ★式は全ブロックで統一（cr00 を複製すればそのまま動く）★
//   ブロックごとに違う式を書かない。列参照はすべて「自分の列の相対参照」で、
//   親子の判定も式の中で動的に行うため、CR追加・子追加のたびに再生成する必要がない。
//
// 2段構えの理由（循環参照の回避）:
//   表示行（既定2行目）で子を集約しようとすると、子の表示セルも同じ2行目にあるため
//   「2行目が2行目を参照する」＝循環参照になる。そこで判定結果を数値で持つ中間行
//   （--tier-row、既定は指標行の少し下の空き行）を挟む。
//     ・中間行 : 自分の指標だけで 0/1/2 を算出（他ブロックを一切参照しない）
//     ・表示行 : 自分のIDに紐づく子(<id>_*)が存在すれば子の中間行を集約、
//                いなければ自分の中間行を採用してラベル化
//   どちらの式も全ブロックで同一なので、列複製で新CRにもそのまま効く。
//   中間行は必ず消化金額列（ID行と同じ列）に置く。親の集約が ID行×中間行を
//   列で突き合わせて数えるため。表示行だけ --noroshi-col memo でメモ列に出せる。
//
// 判定条件（CPA効率重視。量型は対象外）:
//   消化{metricRow} >= {targetCell}*{spendlineCell}  … 十分な消化（データ量ゲート）
//   かつ CPA{metricRow} <= {targetCell}*係数 かつ 実質cv{metricRow} >= 下限
//     → 2段階目(=2) は data!$S$4/$S$5、1段階目(=1) は data!$S$2/$S$3
//
// 対象ブロックの特定:
//   ラベル行（既定1行目）が「消化金額」の列 かつ ID行（既定6行目）が cr… で始まる列群先頭。
//   その列群内のラベルから「実質cv」列・「CPA」列を自動特定。
//   adset/集計列など cr-id の無い消化金額列は自動スキップ。
//
// 安全設計（構造仕様§5準拠）:
//   - DRY RUN がデフォルト。--apply 時のみ書き込み
//   - 表示行は 空 / "-" / 既存の当たり式 のみ書込。手動注記（エリア/NG素材等）は保護して除外
//   - 中間行は 空 / 既存の中間式 のみ書込。他の内容があれば中止（行の選び直しを促す）
//   - 表示専用（当たりプルダウン=5行目 には一切触れない）
//   - --clear-old-row 指定時、旧行の当たり式を空にする（行移動用）
//   - 書き込み前に undo ログ保存、書き込み後に再読取で確認
//
// 実行例:
//   node noroshi.mjs --sheet <id|URL> --tab kk_kou --target-cell W5 --spendline-cell W3 \
//     --metric-row 1101 --noroshi-row 2 --tier-row 1103
//
// 必要な環境変数: GOOGLE_SERVICE_ACCOUNT_JSON
// ------------------------------------------------------------

import { google } from "googleapis";
import { writeFileSync } from "node:fs";

const args = parseArgs(process.argv.slice(2));
if (!args.sheet || !args.tab || !args.targetCell || !args.spendlineCell || !args.tierRow) {
  console.error("使い方: node noroshi.mjs --sheet <id|URL> --tab <タブ> --target-cell <目標CPAセル 例W5> --spendline-cell <消化ラインセル 例W3> --tier-row <中間行 例1103> [--metric-row 1101] [--noroshi-row 2] [--noroshi-col disc|memo] [--clear-old-row 7] [--id-row 6] [--settings-tab data] [--settings-col S] [--apply]");
  process.exit(1);
}
const SPREADSHEET_ID = extractId(args.sheet);
const TAB = args.tab;
const LABEL_ROW = Number(args.labelRow || 1);   // 消化金額/実質cv/CPA のラベル行
const ID_ROW = Number(args.idRow || 6);         // cr識別子の行
const NOROSHI_ROW = Number(args.noroshiRow || 2); // 当たり判定を表示する行
// 判定テキストを出す列: disc=消化金額列（既定・プルダウンと同じ列）/ memo=各ブロックのメモ列
const NOROSHI_COL = (args.noroshiCol || "disc").toLowerCase();
const MEMO_LABEL = args.memoLabel || "メモ";
const TIER_ROW = Number(args.tierRow);          // 中間行（0/1/2 の判定コード）
// 行移動時の旧行掃除。カンマ区切りで複数指定可（例 "2,1103"）
const CLEAR_OLD_ROWS = args.clearOldRow ? String(args.clearOldRow).split(",").map((x) => Number(x.trim())).filter(Boolean) : [];
const METRIC_ROW = Number(args.metricRow || 1100); // 指標の判定参照行
const TARGET = args.targetCell;                 // 目標CPAセル（例 W5・タブ別）→絶対参照化
const SPENDLINE = args.spendlineCell;           // 消化ラインセル（例 W3・タブ別）
// 判定基準は data 設定シートのセルを参照（編集はそこで完結）。既定 data!S2:S5。
const SETTINGS_TAB = args.settingsTab || "data";
const SETTINGS_COL = (args.settingsCol || "S").toUpperCase();
const PRE_CPA_ROW = 2;   // 1段階目🌱 CPA係数
const PRE_CV_ROW = 3;    // 1段階目🌱 実質cv下限
const CAND_CPA_ROW = 4;  // 2段階目🌱🌱 CPA係数
const CAND_CV_ROW = 5;   // 2段階目🌱🌱 実質cv下限
const APPLY = args.apply || process.env.APPLY === "1";
const UNDO_OUT = args.undoOut || "undo_log.json";
const HEADER_ROWS = Math.max(ID_ROW, LABEL_ROW, NOROSHI_ROW, ...CLEAR_OLD_ROWS, 8);
const LABEL_PRE = "当たり候補🌱";     // 1段階目（新芽1つ）
const LABEL_CAND = "当たり候補🌱🌱";  // 2段階目・高角度（新芽2つ）
// 上書き可能なプレースホルダ（意味を持たない仮置き）
const PLACEHOLDERS = new Set(["", "-"]);
// 文字色: 中間行は補助情報なのでグレー、判定テキストは通常の黒
const TIER_FONT = { red: 0.6, green: 0.6, blue: 0.6 };
const BADGE_FONT = { red: 0, green: 0, blue: 0 };
// data設定への絶対参照（クロスタブ）
const sref = (row) => `${SETTINGS_TAB}!$${SETTINGS_COL}$${row}`;
const PRE_CPA = sref(PRE_CPA_ROW), PRE_CV = sref(PRE_CV_ROW), CAND_CPA = sref(CAND_CPA_ROW), CAND_CV = sref(CAND_CV_ROW);

if (TIER_ROW === NOROSHI_ROW) { console.error("ERROR: --tier-row と --noroshi-row は別の行にしてください（循環参照になります）。"); process.exit(1); }

const raw = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
if (!raw) { console.error("ERROR: GOOGLE_SERVICE_ACCOUNT_JSON が未設定です。"); process.exit(1); }
const creds = JSON.parse(raw);
console.log(`# 実行中のサービスアカウント: ${creds.client_email}`);
console.log(`# モード: ${APPLY ? "APPLY（書き込みあり）" : "DRY RUN（書き込みなし）"}`);
console.log(`# 対象: ${TAB} / ラベル行=${LABEL_ROW} / ID行=${ID_ROW} / 表示行=${NOROSHI_ROW}(${NOROSHI_COL === "memo" ? "メモ列" : "消化金額列"}) / 中間行=${TIER_ROW}(消化金額列) / 指標行=${METRIC_ROW}${CLEAR_OLD_ROWS.length ? ` / 旧行掃除=${CLEAR_OLD_ROWS.join(",")}` : ""}`);
console.log(`# 消化ゲート: 消化>=${TARGET}*${SPENDLINE}`);
console.log(`# ${LABEL_CAND}: CPA<=${TARGET}*${CAND_CPA} かつ 実質cv>=${CAND_CV}`);
console.log(`# ${LABEL_PRE}: CPA<=${TARGET}*${PRE_CPA} かつ 実質cv>=${PRE_CV}`);
console.log(`# 式は全ブロック統一。子(<id>_*)の有無を式内で判定し、いれば子を集約・いなければ自身で判定`);

const auth = new google.auth.GoogleAuth({
  credentials: creds,
  scopes: [APPLY ? "https://www.googleapis.com/auth/spreadsheets" : "https://www.googleapis.com/auth/spreadsheets.readonly"],
});
const sheets = google.sheets({ version: "v4", auth });

const meta = await withRetry("シート情報取得", () => sheets.spreadsheets.get({ spreadsheetId: SPREADSHEET_ID, fields: "properties.title,sheets(properties(title,sheetId))" }));
console.log(`# スプレッドシート: ${meta.data.properties.title} (${SPREADSHEET_ID})`);
const tabProps = meta.data.sheets.find((s) => s.properties.title === TAB)?.properties;
if (!tabProps) {
  console.error(`ERROR: タブ「${TAB}」が見つかりません。`); process.exit(1);
}
const SHEET_ID = tabProps.sheetId;

// ヘッダー領域＋中間行を数式で読む
const [headRes, tierRes] = await Promise.all([
  withRetry("ヘッダー読取", () => sheets.spreadsheets.values.get({ spreadsheetId: SPREADSHEET_ID, range: `'${TAB}'!1:${HEADER_ROWS}`, valueRenderOption: "FORMULA" })),
  withRetry("中間行読取", () => sheets.spreadsheets.values.get({ spreadsheetId: SPREADSHEET_ID, range: `'${TAB}'!${TIER_ROW}:${TIER_ROW}`, valueRenderOption: "FORMULA" })),
]);
const rows = headRes.data.values || [];
const labelRow = rows[LABEL_ROW - 1] || [];
const idRow = rows[ID_ROW - 1] || [];
const noroshiRowCur = rows[NOROSHI_ROW - 1] || [];
const clearRowsCur = new Map(CLEAR_OLD_ROWS.map((r) => [r, rows[r - 1] || []]));
const tierRowCur = (tierRes.data.values || [])[0] || [];

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
  if (NOROSHI_COL === "memo" && memoCol < 0) { skipped.push({ id, col: colToA1(c), reason: `メモ列(${MEMO_LABEL})が見つからない` }); continue; }
  const col = colToA1(c);
  // 判定テキストを出す列。--noroshi-col memo ならメモ列、既定は消化金額列。
  // ※中間コードは常に消化金額列（ID行と同じ列でないと親の COUNTIFS 集約が成立しない）
  const badgeCol = NOROSHI_COL === "memo" ? memoCol : c;
  blocks.push({
    id, discCol: c, cvCol, cpaCol, memoCol, badgeCol, col,
    cell: `${colToA1(badgeCol)}${NOROSHI_ROW}`, current: String(noroshiRowCur[badgeCol] ?? "").trim(),
    tierCell: `${col}${TIER_ROW}`, tierCurrent: String(tierRowCur[c] ?? "").trim(),
  });
}

console.log(`\n===== 対象ブロック =====`);
console.log(`実CRブロック（当たり判定対象）: ${blocks.length}`);
if (skipped.length) {
  console.log(`スキップ（列特定できず）: ${skipped.length}`);
  for (const s of skipped.slice(0, 10)) console.log(`  - ${s.col} ${s.id}: ${s.reason}`);
}

// 子ブロックの紐付け（id が <親id>_… ）※式内の COUNTIF と同じ判定基準
for (const b of blocks) {
  const prefix = `${b.id}_`.toLowerCase();
  b.kids = blocks.filter((x) => x !== b && x.id.toLowerCase().startsWith(prefix));
}
const withKids = blocks.filter((b) => b.kids.length > 0);
console.log(`子を持つブロック（式内で子集約に切り替わる）: ${withKids.length} 件 / 残り ${blocks.length - withKids.length} 件は自身の指標で判定`);

// --- 中間行の書込可否：空 or 自分が生成した式のみ。他の内容があれば中止（行を選び直す）---
// ※行の入れ替え（表示行↔中間行）にも対応するため、表示式・中間式のどちらでも上書き可とする
const isOurTier = (v) => v.includes(`${SETTINGS_TAB}!$${SETTINGS_COL}$`) && v.includes("IF(N(");
const isOurBadge = (v) => v.includes("当たり候補") || v.includes("当たり予備軍") || v.includes("当たりの狼煙");
const isGenerated = (v) => isOurTier(v) || isOurBadge(v);
const tierForeign = blocks.filter((b) => b.tierCurrent !== "" && !isGenerated(b.tierCurrent));
if (tierForeign.length) {
  console.error(`\n✗ 中間行 ${TIER_ROW} に既存の内容があるブロックが ${tierForeign.length} 件あります。別の空き行を --tier-row に指定してください。`);
  for (const b of tierForeign.slice(0, 10)) console.error(`  - ${b.tierCell} ${b.id}: 現在値=${JSON.stringify(b.tierCurrent)}`);
  process.exit(1);
}
console.log(`中間行 ${TIER_ROW}: 全 ${blocks.length} ブロックで書込可（既存の中間式の更新 ${blocks.filter((b) => b.tierCurrent !== "").length} 件）`);

// --- 表示行の書込可否：空 / "-" / 自分が生成した式のみ。手動注記は保護 ---
const isOurs = isOurBadge;
const canWrite = (v) => PLACEHOLDERS.has(v) || isGenerated(v);
const writable = blocks.filter((b) => canWrite(b.current));
const foreign = blocks.filter((b) => !canWrite(b.current));
const updateCount = writable.filter((b) => isGenerated(b.current)).length;
if (updateCount) console.log(`表示行 ${NOROSHI_ROW}: 既存の当たり式の更新 ${updateCount} 件`);
if (foreign.length) {
  console.log(`\n⚠ 表示行 ${NOROSHI_ROW} に保護対象の内容があるため表示は見送り: ${foreign.length} 件（中間行には式を入れるので親の集約には反映されます）`);
  for (const b of foreign.slice(0, 15)) console.log(`  - ${b.cell} ${b.id}: 現在値=${JSON.stringify(b.current)}`);
}
if (writable.length === 0) { console.log("\n表示行に書き込み可能なブロックがありません。終了します。"); process.exit(0); }

// ------------------------------------------------------------
// 式の生成（全ブロック同一。相対参照だけがブロックごとにずれる）
const targetAbs = toAbs(TARGET), spendAbs = toAbs(SPENDLINE);
const idRowRef = `$${ID_ROW}:$${ID_ROW}`;
const tierRowRef = `$${TIER_ROW}:$${TIER_ROW}`;

// 中間行：自分の指標のみで 0/1/2 を返す（他ブロックを参照しない＝循環しない）。
// ※必ず消化金額列に置く。親の集約が ID行(6) と中間行を列で突き合わせて数えるため、
//   cr識別子と同じ列でないと成立しない。
//   （セルに識別子を同梱すれば列を自由にできるが、Cmd+F でcr番号検索に引っかかり
//     普段の業務に支障が出るため採用しない）
const tierFormula = (b) => {
  const disc = `${colToA1(b.discCol)}${METRIC_ROW}`;
  const cv = `${colToA1(b.cvCol)}${METRIC_ROW}`;
  const cpa = `${colToA1(b.cpaCol)}${METRIC_ROW}`;
  return (
    `=IF(N(${disc})<${targetAbs}*${spendAbs},0,` +
    `IF(AND(ISNUMBER(${cpa}),${cpa}<=${targetAbs}*${CAND_CPA},N(${cv})>=${CAND_CV}),2,` +
    `IF(AND(ISNUMBER(${cpa}),${cpa}<=${targetAbs}*${PRE_CPA},N(${cv})>=${PRE_CV}),1,0)))`
  );
};

// 表示行：子(<id>_*)がいれば子の中間セルを集約、いなければ自分の中間セル。全ブロック同一の式。
// 子の判定は中間行だけを見る（"<親id>_*|2" のワイルドカード一致）。
const displayFormula = (b) => {
  const idCell = `${b.col}${ID_ROW}`;
  const myTier = `${b.col}${TIER_ROW}`;
  return (
    `=LET(id,${idCell},kids,COUNTIF(${idRowRef},id&"_*"),` +
    `t,IF(kids>0,` +
    `IF(COUNTIFS(${idRowRef},id&"_*",${tierRowRef},2)>0,2,IF(COUNTIFS(${idRowRef},id&"_*",${tierRowRef},1)>0,1,0)),` +
    `N(${myTier})),` +
    `IF(t=2,"${LABEL_CAND}",IF(t=1,"${LABEL_PRE}","")))`
  );
};

for (const b of blocks) b.tierFormula = tierFormula(b);
for (const b of writable) b.formula = displayFormula(b);

// ------------------------------------------------------------
// DRY RUN：実データで点灯予測（中間行の値を自前で再現し、子集約も同じロジックで検証）
if (!APPLY) {
  const srefRead = (row) => `${SETTINGS_TAB}!${SETTINGS_COL}${row}`; // batchGet 用（$なし）
  const readRanges = [
    `'${TAB}'!${toA1(TARGET)}`, `'${TAB}'!${toA1(SPENDLINE)}`,
    srefRead(PRE_CPA_ROW), srefRead(PRE_CV_ROW), srefRead(CAND_CPA_ROW), srefRead(CAND_CV_ROW),
  ];
  for (const b of blocks) {
    readRanges.push(`'${TAB}'!${colToA1(b.discCol)}${METRIC_ROW}`, `'${TAB}'!${colToA1(b.cvCol)}${METRIC_ROW}`, `'${TAB}'!${colToA1(b.cpaCol)}${METRIC_ROW}`);
  }
  const vr = await batchGetChunked(readRanges, "UNFORMATTED_VALUE");
  const target = num(vr[0]?.values?.[0]?.[0]);
  const spend = num(vr[1]?.values?.[0]?.[0]);
  const preCpaF = num(vr[2]?.values?.[0]?.[0]);
  const preCvMin = num(vr[3]?.values?.[0]?.[0]);
  const candCpaF = num(vr[4]?.values?.[0]?.[0]);
  const candCvMin = num(vr[5]?.values?.[0]?.[0]);
  const OFF = 6;
  // 中間行の値を再現
  for (let i = 0; i < blocks.length; i++) {
    const b = blocks[i];
    const disc = num(vr[OFF + i * 3]?.values?.[0]?.[0]);
    const cv = num(vr[OFF + 1 + i * 3]?.values?.[0]?.[0]);
    const cpaRaw = vr[OFF + 2 + i * 3]?.values?.[0]?.[0];
    const cpaNum = typeof cpaRaw === "number" ? cpaRaw : (isFiniteNum(cpaRaw) ? Number(cpaRaw) : null);
    const gate = disc >= target * spend && cpaNum !== null;
    let tier = 0;
    if (gate && cpaNum <= target * candCpaF && cv >= candCvMin) tier = 2;
    else if (gate && cpaNum <= target * preCpaF && cv >= preCvMin) tier = 1;
    b._self = { disc, cv, cpa: cpaNum, tier };
  }
  // 表示行の値を再現（子がいれば子の最大 tier）
  for (const b of blocks) {
    b._shown = b.kids.length > 0 ? Math.max(0, ...b.kids.map((k) => k._self.tier)) : b._self.tier;
  }
  const shown = writable.filter((b) => b._shown > 0);
  const cands = shown.filter((b) => b._shown === 2);
  const pres = shown.filter((b) => b._shown === 1);
  console.log(`\n# data設定: ${LABEL_PRE} CPA係数=${preCpaF} cv下限=${preCvMin} / ${LABEL_CAND} CPA係数=${candCpaF} cv下限=${candCvMin}`);
  console.log(`（目標CPA=${target} / 消化ゲート=${target * spend}）`);
  console.log(`\n===== 点灯予測: ${LABEL_CAND} ${cands.length}件 / ${LABEL_PRE} ${pres.length}件 （表示対象 ${writable.length}）=====`);
  for (const b of [...cands, ...pres]) {
    const label = b._shown === 2 ? LABEL_CAND : LABEL_PRE;
    const via = b.kids.length > 0 ? `子${b.kids.length}件を集約（${b.kids.filter((k) => k._self.tier > 0).map((k) => k.id).join(",") || "—"}）` : `消化=${b._self.disc} CPA=${b._self.cpa} 実質cv=${b._self.cv}`;
    console.log(`  ${label} ${b.cell} ${b.id}: ${via}`);
  }
  console.log(`\n----- 生成する式（全ブロック同一・相対参照のみ変化）-----`);
  const s = blocks[0];
  console.log(`  [中間行] ${s.tierCell} (${s.id}): ${s.tierFormula}`);
  const d = writable[0];
  console.log(`  [表示行] ${d.cell} (${d.id}): ${d.formula}`);
  const p = writable.find((b) => b.kids.length > 0);
  if (p) console.log(`  [表示行/子あり例] ${p.cell} (${p.id}, 子${p.kids.length}件): ${p.formula}`);
  console.log(`  ※ 子あり・子なしで式は同一。cr00 の列群を複製すれば新CRにもそのまま効く`);
  for (const r of CLEAR_OLD_ROWS) {
    const cur = clearRowsCur.get(r) || [];
    const n = blocks.filter((b) => isGenerated(String(cur[b.discCol] ?? "").trim()) || isGenerated(String(cur[b.badgeCol] ?? "").trim())).length;
    console.log(`\n# 旧行 ${r} の当たり式を空にする対象: ${n} 件`);
  }
  console.log(`\nDRY RUN 完了（中間行 ${blocks.length}セル / 表示行 ${writable.length}セル に式を投入予定）。適用するには --apply を付けて再実行してください。`);
  process.exit(0);
}

// ------------------------------------------------------------
// APPLY：undo ログ→書き込み→確認
const clearTargets = [];
for (const r of CLEAR_OLD_ROWS) {
  const cur = clearRowsCur.get(r) || [];
  for (const b of blocks) {
    for (const cIdx of new Set([b.discCol, b.badgeCol])) {
      const v = String(cur[cIdx] ?? "").trim();
      // 新しく書き込むセル自体は掃除対象にしない
      const cellRef = `${colToA1(cIdx)}${r}`;
      if (cellRef === b.cell || cellRef === b.tierCell) continue;
      if (isGenerated(v)) clearTargets.push({ cell: cellRef, before: v, after: "" });
    }
  }
}
const undoLog = {
  spreadsheetId: SPREADSHEET_ID, title: meta.data.properties.title, tab: TAB,
  noroshiRow: NOROSHI_ROW, tierRow: TIER_ROW, metricRow: METRIC_ROW,
  targetCell: TARGET, spendlineCell: SPENDLINE, clearOldRows: CLEAR_OLD_ROWS,
  settings: { tab: SETTINGS_TAB, preCpa: PRE_CPA, preCv: PRE_CV, candCpa: CAND_CPA, candCv: CAND_CV },
  appliedAt: new Date().toISOString(), serviceAccount: creds.client_email,
  edits: [
    ...blocks.map((b) => ({ cell: b.tierCell, before: b.tierCurrent, after: b.tierFormula })),
    ...writable.map((b) => ({ cell: b.cell, before: b.current, after: b.formula })),
  ],
  clears: clearTargets,
};
writeFileSync(UNDO_OUT, JSON.stringify(undoLog, null, 2));
console.log(`\n# undo ログを保存: ${UNDO_OUT}（表示行は空/"-"に、中間行は空に戻せば取り消せる）`);

const data = [
  ...blocks.map((b) => ({ range: `'${TAB}'!${b.tierCell}`, values: [[b.tierFormula]] })),
  ...writable.map((b) => ({ range: `'${TAB}'!${b.cell}`, values: [[b.formula]] })),
  ...clearTargets.map((c) => ({ range: `'${TAB}'!${c.cell}`, values: [[""]] })),
];
// 大規模タブでも安全に通るよう分割して書き込む（POST本文なのでURL長制限は無いが、
// 1リクエストが巨大だとタイムアウトしやすいため）
for (let i = 0; i < data.length; i += 200) {
  await withRetry("値の書き込み", () => sheets.spreadsheets.values.batchUpdate({
    spreadsheetId: SPREADSHEET_ID,
    requestBody: { valueInputOption: "USER_ENTERED", data: data.slice(i, i + 200) },
  }));
}
console.log(`# 中間行 ${blocks.length}セル / 表示行 ${writable.length}セル に式を書き込み${clearTargets.length ? `、旧行 ${clearTargets.length} セルを掃除` : ""}しました。`);

// 文字色を設定（中間行=グレーの補助情報 / 判定テキスト=黒）
const colorReqs = [
  ...blocks.map((b) => colorRequest(b.discCol, TIER_ROW, TIER_FONT)),
  ...writable.map((b) => colorRequest(b.badgeCol, NOROSHI_ROW, BADGE_FONT)),
];
for (let i = 0; i < colorReqs.length; i += 100) {
  await withRetry("文字色の設定", () => sheets.spreadsheets.batchUpdate({
    spreadsheetId: SPREADSHEET_ID,
    requestBody: { requests: colorReqs.slice(i, i + 100) },
  }));
}
console.log(`# 文字色を設定: 中間行 ${blocks.length}セル=グレー / 表示行 ${writable.length}セル=黒。反映を再読取で確認します…`);

const checks = [...blocks.map((b) => ({ cell: b.tierCell, want: b.tierFormula })), ...writable.map((b) => ({ cell: b.cell, want: b.formula }))];
const verifyRanges = await batchGetChunked(checks.map((c) => `'${TAB}'!${c.cell}`), "FORMULA");
let mismatch = 0;
for (let i = 0; i < checks.length; i++) {
  const now = String(verifyRanges[i]?.values?.[0]?.[0] ?? "").replace(/\s/g, "");
  if (now !== checks[i].want.replace(/\s/g, "")) { mismatch++; if (mismatch <= 5) console.log(`  ⚠ ${checks[i].cell}: 反映不一致（要目視）`); }
}
console.log(`\n===== 適用完了: 中間行 ${blocks.length} / 表示行 ${writable.length} セル（要目視確認 ${mismatch} 件）${clearTargets.length ? ` / 旧行掃除 ${clearTargets.length} セル` : ""} =====`);

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
    else if (a === "--noroshi-col") out.noroshiCol = argv[++i];
    else if (a === "--memo-label") out.memoLabel = argv[++i];
    else if (a === "--tier-row") out.tierRow = argv[++i];
    else if (a === "--clear-old-row") out.clearOldRow = argv[++i];
    else if (a === "--metric-row") out.metricRow = argv[++i];
    else if (a === "--settings-tab") out.settingsTab = argv[++i];
    else if (a === "--settings-col") out.settingsCol = argv[++i];
    else if (a === "--apply") out.apply = true;
    else if (a === "--undo-out") out.undoOut = argv[++i];
  }
  return out;
}
// Google API の一時的な障害（503/500/429）に対する指数バックオフ付きリトライ。
// 大きな集計表では実行中に backendError が出ることがあり、途中で落ちると
// 書き込みが中途半端な状態で終わってしまうため必ず経由させる。
async function withRetry(label, fn, attempts = 5) {
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    try { return await fn(); } catch (e) {
      const code = e?.code || e?.status;
      const retryable = [429, 500, 502, 503, 504].includes(Number(code));
      lastErr = e;
      if (!retryable || i === attempts - 1) throw e;
      const waitMs = 2000 * Math.pow(2, i);
      console.log(`  ⏳ ${label} が ${code} で失敗。${waitMs / 1000}秒後に再試行 (${i + 1}/${attempts - 1})`);
      await new Promise((r) => setTimeout(r, waitMs));
    }
  }
  throw lastErr;
}
// 1セルの文字色を設定する repeatCell リクエストを作る（行・列は0始まり）
function colorRequest(colIdx, row, rgb) {
  return {
    repeatCell: {
      range: { sheetId: SHEET_ID, startRowIndex: row - 1, endRowIndex: row, startColumnIndex: colIdx, endColumnIndex: colIdx + 1 },
      cell: { userEnteredFormat: { textFormat: { foregroundColor: rgb } } },
      fields: "userEnteredFormat.textFormat.foregroundColor",
    },
  };
}
// batchGet は URL に ranges を並べる GET のため、件数が多いと URL 長制限で 400 になる。
// 大規模タブ（nrn: 173ブロック×3セル=519レンジ）でも通るよう分割して読む。
async function batchGetChunked(ranges, valueRenderOption, chunkSize = 100) {
  const out = [];
  for (let i = 0; i < ranges.length; i += chunkSize) {
    const part = ranges.slice(i, i + chunkSize);
    const res = await withRetry("batchGet", () => sheets.spreadsheets.values.batchGet({ spreadsheetId: SPREADSHEET_ID, ranges: part, valueRenderOption }));
    out.push(...(res.data.valueRanges || []));
  }
  return out;
}
function extractId(s) { const m = String(s).match(/\/d\/([a-zA-Z0-9_-]+)/); return m ? m[1] : s; }
function toAbs(cell) { const m = String(cell).match(/^\$?([A-Z]+)\$?(\d+)$/i); return m ? `$${m[1].toUpperCase()}$${m[2]}` : cell; }
function toA1(cell) { return String(cell).replace(/\$/g, ""); }
function num(v) { if (v == null || v === "") return 0; const n = Number(String(v).replace(/[,¥\s]/g, "")); return Number.isFinite(n) ? n : 0; }
function isFiniteNum(v) { if (v == null || v === "") return false; const n = Number(String(v).replace(/[,¥\s]/g, "")); return Number.isFinite(n); }
function colToA1(n) { let s = ""; n = n + 1; while (n > 0) { const r = (n - 1) % 26; s = String.fromCharCode(65 + r) + s; n = Math.floor((n - 1) / 26); } return s; }
