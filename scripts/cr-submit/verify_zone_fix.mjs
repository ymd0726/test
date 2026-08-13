// 集計表ゾーン判定の全案件回帰チェック（読み取り専用・BUG-144）
// ------------------------------------------------------------
// GAS submitLayout_ のゾーン判定ロジックを「旧（既知マーカーのみを境界にする）」と
// 「新（1行目の“→”で終わる全マーカーを境界にする）」の2通りで再現し、
// レジストリ(apps/jdem-stop-mcp/src/index.ts)の全案件・全タブについて
// cr00(集計内/集計外)の選択結果が変わるかどうかを一覧する。
//
// 実行例:
//   node verify_zone_fix.mjs                 # 全案件
//   node verify_zone_fix.mjs --only jdem,ssh # 案件名で絞り込み
//
// 必要な環境変数: GOOGLE_SERVICE_ACCOUNT_JSON（ad-analysis と同じサービスアカウント）
// 書き込みは一切行わない（scope: spreadsheets.readonly）。
// ------------------------------------------------------------

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { google } from "googleapis";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REGISTRY = path.resolve(__dirname, "../../apps/jdem-stop-mcp/src/index.ts");

// --- GAS 側の定数と同じもの（コピー） ---
const TEMPLATE_ID = "cr00";
const ID_ROW_SEARCH_MAX = 8;
const EXCLUDE_MARKERS = ["集計外CR→", "集計から除外→", "パターン替え→", "除外→", "集計に反映させない→", "ナンバリング除外→", "集計除外→"];
const NONPATTERN_MARKERS = [
  "認知系→", "店舗別→", "各店舗→", "エース→", "アドセット別→", "展示会→",
  "アーカイブ→", "LP別→", "認知・リタゲ→", "認知・リタゲなど→", "テスト別→", "過去テスト→",
  "訴求別→", "当たり→",
];
const PATTERN_START_MARKERS = ["CR別→", "cr→", "CR一覧→"];

const args = parseArgs(process.argv.slice(2));
const only = args.only ? String(args.only).split(",").map((s) => s.trim()).filter(Boolean) : null;

const raw = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
if (!raw) {
  console.error("ERROR: GOOGLE_SERVICE_ACCOUNT_JSON が未設定です。");
  process.exit(1);
}
const creds = JSON.parse(raw);
const auth = new google.auth.GoogleAuth({ credentials: creds, scopes: ["https://www.googleapis.com/auth/spreadsheets.readonly"] });
const sheetsApi = google.sheets({ version: "v4", auth });

const targets = parseRegistry(fs.readFileSync(REGISTRY, "utf8")).filter((t) => !only || only.includes(t.project));
console.log(`# 対象: ${targets.length} エントリ（案件×スプレッドシート）`);

const diffs = [];
const errors = [];

for (const t of targets) {
  let tabs;
  try {
    tabs = await resolveTabs(t);
  } catch (e) {
    errors.push({ ...t, error: String(e.message || e) });
    console.log(`\n## ${t.project} / ${t.spreadsheetId} : ERROR ${e.message || e}`);
    continue;
  }
  for (const tab of tabs) {
    let head;
    try {
      head = await readHead(t.spreadsheetId, tab);
    } catch (e) {
      errors.push({ ...t, tab, error: String(e.message || e) });
      console.log(`\n## ${t.project} / ${tab} : ERROR ${e.message || e}`);
      continue;
    }
    const oldLay = layout(head, false);
    const newLay = layout(head, true);
    const changed = oldLay.left !== newLay.left || oldLay.right !== newLay.right;
    const tag = changed ? "CHANGED" : "same";
    console.log(`\n## ${t.project} / ${tab} : ${tag}`);
    console.log(`   idRow=${oldLay.idRow} cr00候補=[${oldLay.cr00Candidates.map(a1).join(", ")}] excludeZone=${oldLay.excludeZoneStartCol === null ? "-" : a1(oldLay.excludeZoneStartCol)}`);
    console.log(`   旧: left=${fmt(oldLay.left)} right=${fmt(oldLay.right)} 除外レンジ=${rangesText(oldLay.excludedRanges)}`);
    console.log(`   新: left=${fmt(newLay.left)} right=${fmt(newLay.right)} 除外レンジ=${rangesText(newLay.excludedRanges)}`);
    if (changed) {
      console.log(`   1行目マーカー: ${oldLay.arrowCols.map((c) => `${a1(c)}:${head[0][c]}`).join(" / ")}`);
      diffs.push({ project: t.project, tab, old: oldLay, next: newLay });
    }
  }
}

console.log("\n================ サマリ ================");
console.log(`変化あり: ${diffs.length} タブ`);
for (const d of diffs) {
  console.log(`  - ${d.project}/${d.tab}: left ${fmt(d.old.left)}→${fmt(d.next.left)} / right ${fmt(d.old.right)}→${fmt(d.next.right)}`);
}
console.log(`読み取り失敗: ${errors.length}`);
for (const e of errors) console.log(`  - ${e.project}/${e.tab || "-"}: ${e.error}`);

// ------------------------------------------------------------
function layout(head, useArrowBoundary) {
  const row1 = head[0] || [];
  let idRow = -1, best = 0;
  for (let r = 1; r < head.length; r++) {
    const n = (head[r] || []).filter((v) => /^cr\d/i.test(String(v).trim())).length;
    if (n > best) { best = n; idRow = r + 1; }
  }
  const idVals = idRow > 0 ? head[idRow - 1] : [];
  const idCells = [];
  for (let c = 0; c < idVals.length; c++) {
    const v = String(idVals[c] || "").trim();
    if (/^cr\d|^cr00$/i.test(v)) idCells.push({ col: c, id: v });
  }

  const markers = [];
  for (let mc = 0; mc < row1.length; mc++) {
    const mv = String(row1[mc] || "").trim();
    if (!mv) continue;
    if (EXCLUDE_MARKERS.includes(mv)) markers.push({ col: mc, type: "exclude", text: mv });
    else if (NONPATTERN_MARKERS.includes(mv)) markers.push({ col: mc, type: "nonpattern", text: mv });
    else if (PATTERN_START_MARKERS.includes(mv)) markers.push({ col: mc, type: "patternstart", text: mv });
  }
  markers.sort((a, b) => a.col - b.col);

  const arrowCols = [];
  for (let ac = 0; ac < row1.length; ac++) {
    const av = String(row1[ac] || "").trim();
    if (av && av.charAt(av.length - 1) === "→") arrowCols.push(ac);
  }
  const nextArrowColAfter = (col) => {
    for (const c of arrowCols) if (c > col) return c;
    return Infinity;
  };

  const excludedRanges = [];
  markers.forEach((m, i) => {
    if (m.type !== "nonpattern") return;
    const nextCol = useArrowBoundary
      ? nextArrowColAfter(m.col)
      : (i + 1 < markers.length ? markers[i + 1].col : Infinity);
    excludedRanges.push([m.col, nextCol]);
  });
  const isExcludedCol = (col) => excludedRanges.some((rg) => col >= rg[0] && col < rg[1]);
  const excludeMarkerCols = markers.filter((m) => m.type === "exclude").map((m) => m.col);
  const excludeZoneStartCol = excludeMarkerCols.length ? Math.min(...excludeMarkerCols) : null;

  const cr00Candidates = idCells.filter((x) => x.id.toLowerCase() === TEMPLATE_ID).map((x) => x.col).sort((a, b) => a - b);
  const leftCandidates = cr00Candidates.filter((col) => (excludeZoneStartCol === null || col < excludeZoneStartCol) && !isExcludedCol(col));
  const rightCandidates = excludeZoneStartCol === null ? [] : cr00Candidates.filter((col) => col >= excludeZoneStartCol && !isExcludedCol(col));

  return {
    idRow, cr00Candidates, excludeZoneStartCol, excludedRanges, arrowCols, markers,
    left: leftCandidates.length ? leftCandidates[0] : null,
    right: rightCandidates.length ? rightCandidates[0] : null,
  };
}

async function resolveTabs(t) {
  if (t.sheetName) return [t.sheetName];
  const meta = await sheetsApi.spreadsheets.get({
    spreadsheetId: t.spreadsheetId,
    fields: "sheets(properties(title,gridProperties(columnCount)))",
  });
  const names = meta.data.sheets.map((s) => s.properties.title);
  const hits = [];
  for (const name of names) {
    const head = await readHead(t.spreadsheetId, name).catch(() => null);
    if (!head) continue;
    if (head.some((r) => (r || []).some((v) => String(v).trim().toLowerCase() === TEMPLATE_ID))) hits.push(name);
  }
  if (hits.length === 0) throw new Error("cr00を含むタブがありません");
  return hits;
}

async function readHead(spreadsheetId, tab) {
  const res = await sheetsApi.spreadsheets.values.get({
    spreadsheetId,
    range: `'${tab.replace(/'/g, "''")}'!1:${ID_ROW_SEARCH_MAX}`,
    majorDimension: "ROWS",
  });
  const rows = res.data.values || [];
  const width = Math.max(0, ...rows.map((r) => r.length));
  return Array.from({ length: ID_ROW_SEARCH_MAX }, (_, i) => {
    const r = rows[i] || [];
    return Array.from({ length: width }, (_, c) => (r[c] === undefined || r[c] === null ? "" : String(r[c])));
  });
}

function parseRegistry(src) {
  const start = src.indexOf("const PROJECTS");
  const body = start >= 0 ? src.slice(start) : src;
  const out = [];
  // 「{ name: "xxx"」の出現位置で区切り、各案件エントリの範囲内の spreadsheetId を拾う
  const nameRe = /\{\s*name:\s*"([a-z0-9_]+)"/g;
  const heads = [];
  let m;
  while ((m = nameRe.exec(body))) heads.push({ project: m[1], at: m.index });
  for (let i = 0; i < heads.length; i++) {
    const chunk = body.slice(heads[i].at, i + 1 < heads.length ? heads[i + 1].at : body.length);
    const sheetRe = /spreadsheetId:\s*"([^"]+)"(?:\s*,\s*sheetName:\s*"([^"]+)")?/g;
    let s;
    while ((s = sheetRe.exec(chunk))) out.push({ project: heads[i].project, spreadsheetId: s[1], sheetName: s[2] || null });
  }
  // 同一 spreadsheetId+tab の重複は1回だけ読む
  const seen = new Set();
  return out.filter((t) => {
    const k = `${t.spreadsheetId}::${t.sheetName || "*"}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

function a1(col0) {
  let n = col0 + 1, s = "";
  while (n > 0) { const r = (n - 1) % 26; s = String.fromCharCode(65 + r) + s; n = Math.floor((n - 1) / 26); }
  return `${s}(${col0})`;
}
function fmt(col0) { return col0 === null ? "なし" : a1(col0); }
function rangesText(rs) {
  if (!rs.length) return "なし";
  return rs.map(([a, b]) => `[${a1(a)}〜${b === Infinity ? "末尾" : a1(b)})`).join(" ");
}
function parseArgs(argv) {
  const o = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const k = a.slice(2);
      const v = argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[++i] : true;
      o[k] = v;
    }
  }
  return o;
}
