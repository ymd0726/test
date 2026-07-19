// 集計表 セル修正パッチ適用（sheet-fix v1）
// ------------------------------------------------------------
// plans/*.json のパッチプランを検証付きで集計表へ適用する。
//
// 安全設計（集計表 構造仕様 §5「既知の罠」準拠）:
//   - DRY RUN がデフォルト。--apply（または APPLY=1）指定時のみ書き込む
//   - expectedBefore 検証: 各セルの現在値（数式レンダー/表示値のどちらか）と
//     一致しない編集が1件でもあれば「全編集を中止」（列ズレ事故防止・all-or-nothing）
//   - ID行保護: cr-id（cr00/cr84/cr79_01…）が入っているセルを空にする編集は拒否
//   - 対象は単一セルのみ（行・範囲指定は受け付けない）
//   - 書き込み前に undo ログ（旧値）を JSON 保存、書き込み後に再読取で反映確認
//
// v1 スコープ: セル値・数式の修正のみ。列挿入・ブロック複製などの構造操作は
// cr入稿くんGAS の領分（このスクリプトでは扱わない）。
//
// 実行例:
//   node apply.mjs --plan plans/2026-07-19_jdem_判定式修正.json            # dry-run
//   node apply.mjs --plan plans/2026-07-19_jdem_判定式修正.json --apply    # 本適用
//
// 必要な環境変数: GOOGLE_SERVICE_ACCOUNT_JSON（inspect_sheet.mjs と同じサービスアカウント）
// ------------------------------------------------------------

import { google } from "googleapis";
import { readFileSync, writeFileSync } from "node:fs";

const args = parseArgs(process.argv.slice(2));
if (!args.plan) {
  console.error("使い方: node apply.mjs --plan <プランJSONパス> [--apply] [--undo-out <パス>]");
  process.exit(1);
}
const APPLY = args.apply || process.env.APPLY === "1";
const UNDO_OUT = args.undoOut || "undo_log.json";
const CELL_RE = /^[A-Z]{1,3}[1-9][0-9]*$/;
const CR_ID_RE = /^cr\d/i;

// --- プラン読み込み・検証 ---
const plan = JSON.parse(readFileSync(args.plan, "utf8"));
const errors = [];
if (!plan.sheet) errors.push("plan.sheet（スプレッドシートID or URL）がありません");
if (!plan.tab) errors.push("plan.tab（タブ名）がありません");
if (!Array.isArray(plan.edits) || plan.edits.length === 0) errors.push("plan.edits が空です");
const seen = new Set();
for (const [i, e] of (plan.edits || []).entries()) {
  const label = `edits[${i}]`;
  if (!e.cell || !CELL_RE.test(String(e.cell))) errors.push(`${label}: cell は単一セルのA1表記（例 CD5）で指定してください: ${e.cell}`);
  if (typeof e.after !== "string") errors.push(`${label}: after は文字列で指定してください（数式は "=..." のまま）`);
  if (typeof e.expectedBefore !== "string" && e.allowAnyBefore !== true)
    errors.push(`${label}: expectedBefore がありません（現在値が不明なまま書くなら allowAnyBefore: true を明示）`);
  if (seen.has(e.cell)) errors.push(`${label}: セル ${e.cell} が重複しています`);
  seen.add(e.cell);
}
if (errors.length) {
  console.error("ERROR: プランの形式が不正です:");
  for (const e of errors) console.error(`  - ${e}`);
  process.exit(1);
}
const SPREADSHEET_ID = extractId(plan.sheet);

const raw = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
if (!raw) {
  console.error("ERROR: GOOGLE_SERVICE_ACCOUNT_JSON が未設定です。");
  process.exit(1);
}
const creds = JSON.parse(raw);
console.log(`# 実行中のサービスアカウント: ${creds.client_email}`);
console.log(`# モード: ${APPLY ? "APPLY（書き込みあり）" : "DRY RUN（書き込みなし）"}`);
console.log(`# プラン: ${args.plan}${plan.note ? ` … ${plan.note}` : ""}`);

const auth = new google.auth.GoogleAuth({
  credentials: creds,
  scopes: [APPLY ? "https://www.googleapis.com/auth/spreadsheets" : "https://www.googleapis.com/auth/spreadsheets.readonly"],
});
const sheets = google.sheets({ version: "v4", auth });

// --- タブ存在確認 ---
const meta = await sheets.spreadsheets.get({
  spreadsheetId: SPREADSHEET_ID,
  fields: "properties.title,sheets(properties(title))",
});
console.log(`# スプレッドシート: ${meta.data.properties.title} (${SPREADSHEET_ID})`);
if (!meta.data.sheets.some((s) => s.properties.title === plan.tab)) {
  console.error(`ERROR: タブ「${plan.tab}」が見つかりません。存在するタブ:`);
  for (const s of meta.data.sheets) console.error(`  - ${s.properties.title}`);
  process.exit(1);
}

// --- 現在値の取得（数式レンダーと表示値の両方） ---
const ranges = plan.edits.map((e) => `'${plan.tab}'!${e.cell}`);
const [formulaRes, formattedRes] = await Promise.all([
  sheets.spreadsheets.values.batchGet({ spreadsheetId: SPREADSHEET_ID, ranges, valueRenderOption: "FORMULA" }),
  sheets.spreadsheets.values.batchGet({ spreadsheetId: SPREADSHEET_ID, ranges, valueRenderOption: "FORMATTED_VALUE" }),
]);
const currentOf = (res, i) => String(res.data.valueRanges[i]?.values?.[0]?.[0] ?? "");

// --- 編集ごとの検証 ---
let ok = 0, ng = 0;
const results = [];
for (const [i, e] of plan.edits.entries()) {
  const curFormula = currentOf(formulaRes, i).trim();
  const curFormatted = currentOf(formattedRes, i).trim();
  const expected = typeof e.expectedBefore === "string" ? e.expectedBefore.trim() : null;
  let status = "OK";
  let reason = "";

  if (CR_ID_RE.test(curFormula) && e.after.trim() === "") {
    status = "拒否";
    reason = `cr-id セル（現在値=${curFormula}）を空にする編集は禁止（ID行クリア厳禁）`;
  } else if (expected !== null && expected !== curFormula && expected !== curFormatted) {
    status = "拒否";
    reason = `expectedBefore 不一致（期待=${JSON.stringify(expected)} / 数式=${JSON.stringify(curFormula)} / 表示=${JSON.stringify(curFormatted)}）`;
  } else if (expected === null) {
    reason = "⚠ allowAnyBefore（現在値検証をスキップ）";
  }

  status === "OK" ? ok++ : ng++;
  results.push({ cell: e.cell, status, reason, before: curFormula, after: e.after, note: e.note || "" });
  console.log(`\n[${status}] ${plan.tab}!${e.cell}${e.note ? ` … ${e.note}` : ""}`);
  console.log(`  現在値: ${JSON.stringify(curFormula)}${curFormatted !== curFormula ? `（表示: ${JSON.stringify(curFormatted)}）` : ""}`);
  console.log(`  変更後: ${JSON.stringify(e.after)}`);
  if (reason) console.log(`  → ${reason}`);
}

console.log(`\n===== 検証結果: OK ${ok} / 拒否 ${ng} =====`);
if (ng > 0) {
  console.error("拒否された編集があるため、全編集を中止します（プランを実態に合わせて修正してください）。");
  process.exit(1);
}
if (!APPLY) {
  console.log("DRY RUN 完了。書き込みは行っていません。適用するには --apply を付けて再実行してください。");
  process.exit(0);
}

// --- undo ログ保存（書き込み前） ---
const undoLog = {
  spreadsheetId: SPREADSHEET_ID,
  title: meta.data.properties.title,
  tab: plan.tab,
  plan: args.plan,
  appliedAt: new Date().toISOString(),
  serviceAccount: creds.client_email,
  edits: results.map((r) => ({ cell: r.cell, before: r.before, after: r.after })),
};
writeFileSync(UNDO_OUT, JSON.stringify(undoLog, null, 2));
console.log(`# undo ログを保存: ${UNDO_OUT}（before の値で書き戻せば復元できます）`);

// --- 書き込み（USER_ENTERED: 数式・入力規則を保持） ---
await sheets.spreadsheets.values.batchUpdate({
  spreadsheetId: SPREADSHEET_ID,
  requestBody: {
    valueInputOption: "USER_ENTERED",
    data: plan.edits.map((e) => ({ range: `'${plan.tab}'!${e.cell}`, values: [[e.after]] })),
  },
});
console.log(`# ${plan.edits.length} セルを書き込みました。反映を再読取で確認します…`);

// --- 反映確認 ---
const verifyRes = await sheets.spreadsheets.values.batchGet({
  spreadsheetId: SPREADSHEET_ID, ranges, valueRenderOption: "FORMULA",
});
let mismatch = 0;
for (const [i, e] of plan.edits.entries()) {
  const now = currentOf(verifyRes, i).trim();
  // USER_ENTERED は数値・日付等を型変換するので、完全一致しない場合は目視確認を促すだけにする
  const same = now === e.after.trim();
  console.log(`  ${e.cell}: ${same ? "反映OK" : `反映値=${JSON.stringify(now)}（入力=${JSON.stringify(e.after)}。型変換の可能性、要目視確認）`}`);
  if (!same) mismatch++;
}
console.log(`\n===== 適用完了: ${plan.edits.length} セル（要目視確認 ${mismatch} 件） =====`);

// ------------------------------------------------------------
function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--plan") out.plan = argv[++i];
    else if (argv[i] === "--apply") out.apply = true;
    else if (argv[i] === "--undo-out") out.undoOut = argv[++i];
  }
  return out;
}

function extractId(s) {
  const m = String(s).match(/\/d\/([a-zA-Z0-9_-]+)/);
  return m ? m[1] : s;
}
