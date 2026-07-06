/**
 * cr入稿くん 集計表展開（独立GASプロジェクト版）v2
 * ------------------------------------------------------------
 * 停止くんの共通GASとは別の専用GASプロジェクト（submitCreative_common）として
 * デプロイする。このファイル1本で完結（doPost同梱）。
 * Workerは SUBMIT_GAS_URL でこちらを叩く。反映は「デプロイを管理 → 新バージョン」。
 *
 * 【kk_mak 実測（2026-07-06）に基づく仕様】
 *  - クリエイティブID行 = crXX が最も多い行（kk_mak=6行目）。ID行のセルにcr名が入る。
 *  - cr00テンプレは2つ: 左=集計内ゾーン（cr→マーカー配下 / 親・単独CR / 例 CD列）、
 *    右=集計外ゾーン（集計から除外→配下 / パターン子CR / 例 AGE列）。
 *  - 展開ブロック(unit) = 「cr00列 〜 次のcr-id列の直前」。
 *    集計内なら CD〜CU（CD:CT本体＋CU余白1列）。先頭のcr→や余白列は含めない。
 *  - 挿入は cr00 の直右（＝各ゾーンの先頭側。新しいCRほどcr00寄り）。
 *  - 単独/親CR → 集計内ゾーンへ1ブロック（子有りなら分類=親（子有り）＆判定=子にて判定）。
 *    パターン子CR → 集計外ゾーンへ子の数だけ。子が無ければ集計外は触らない。
 *  - ID行に書くcr名は Worker側で「cr82」「cr79_01」等の短縮形にして渡される。
 */

function doPost(e) {
  try {
    var params = JSON.parse(e.postData.contents);
    var action = params.action || '';
    if (!params.spreadsheetId) return jsonOut({ ok: false, error: 'spreadsheetId がありません' });
    if (action === 'submitCreative') return jsonOut(handleSubmitCreative(params));
    if (action === 'submitUndo') return jsonOut(handleSubmitUndo(params));
    return jsonOut({ ok: false, error: '不明なaction: ' + action });
  } catch (err) {
    return jsonOut({ ok: false, error: 'エラー: ' + err });
  }
}

function jsonOut(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

var SUBMIT_TEMPLATE_ID = 'cr00';
var SUBMIT_ID_ROW_SEARCH_MAX = 8;       // クリエイティブID行の探索範囲（1〜8行目）
var SUBMIT_CLASS_ROW = 2;               // 親子分類プルダウンの行
var SUBMIT_JUDGE_ROW = 5;               // 停止判定（子にて判定 等）の行
var SUBMIT_UNDO_KEY_PREFIX = 'submitUndo:';

// ------------------------------------------------------------
function handleSubmitCreative(req) {
  try {
    var ss = SpreadsheetApp.openById(req.spreadsheetId);
    var sheet = submitResolveSheet_(ss, req.sheetName);
    var lay = submitLayout_(sheet);

    var parentId = String(req.parentId || '').trim();
    var childIds = (req.childIds || []).map(function (s) { return String(s).trim(); }).filter(String);
    if (!parentId) return { ok: false, error: 'parentId が必要です' };

    // 冪等性: 既存IDチェック（大小無視）
    var existing = {};
    lay.idCells.forEach(function (c) { existing[c.id.toLowerCase()] = true; });
    var dup = [parentId].concat(childIds).filter(function (id) { return existing[id.toLowerCase()]; });
    if (dup.length) return { ok: false, error: '既に集計表に存在します: ' + dup.join(', ') + '（二重入稿防止のため中断）' };

    var leftTpl = submitUnit_(lay, lay.cr00.left);                        // 集計内（親/単独）
    var rightTpl = childIds.length ? submitUnit_(lay, lay.cr00.right) : null; // 集計外（子）
    if (!leftTpl) return { ok: false, error: '集計内ゾーンの cr00 テンプレが見つかりません' };
    if (childIds.length && !rightTpl) return { ok: false, error: '集計外ゾーンの cr00 テンプレが見つかりません' };
    if (childIds.length && lay.cr00.left === lay.cr00.right) {
      return { ok: false, error: 'cr00テンプレが1つしか無く親/子ゾーンを区別できません' };
    }

    var hasChildren = childIds.length > 0;
    var plan = [];
    plan.push({ tpl: leftTpl, id: parentId, cls: hasChildren ? '親（子有り）' : '親（子無し）', zone: '集計内' });
    // 子は「後ろから」入れると _01,_02… が左→右の昇順で並ぶ
    for (var i = childIds.length - 1; i >= 0; i--) {
      plan.push({ tpl: rightTpl, id: childIds[i], cls: '子', zone: '集計外' });
    }

    if (req.dryRun) {
      return {
        ok: true, dryRun: true, sheetName: sheet.getName(), idRow: lay.idRow,
        plan: plan.map(function (p) {
          return {
            id: p.id, zone: p.zone, classification: p.cls,
            copyCols: submitColA1_(p.tpl.start) + ':' + submitColA1_(p.tpl.end),
            width: p.tpl.width, insertAfter: submitColA1_(p.tpl.end)
          };
        })
      };
    }

    // 実挿入: 右のゾーンから先に（左に挿入すると右の列番号がずれるため）
    var inserted = [];
    var warnings = [];
    plan.slice().sort(function (a, b) { return b.tpl.start - a.tpl.start; }).forEach(function (p) {
      var r = submitInsert_(sheet, lay, p);
      inserted.forEach(function (rec) { if (rec.startCol >= r.startCol) rec.startCol += r.width; });
      inserted.push({ id: r.id, zone: r.zone, startCol: r.startCol, width: r.width });
      if (r.warn) warnings.push(r.warn);
    });

    PropertiesService.getScriptProperties().setProperty(
      SUBMIT_UNDO_KEY_PREFIX + req.spreadsheetId + ':' + parentId.toLowerCase(),
      JSON.stringify({ sheetName: sheet.getName(), inserted: inserted, at: new Date().toISOString() })
    );
    return { ok: true, sheetName: sheet.getName(), inserted: inserted, warnings: warnings };
  } catch (e) {
    return { ok: false, error: String(e && e.message ? e.message : e) };
  }
}

function handleSubmitUndo(req) {
  try {
    var key = SUBMIT_UNDO_KEY_PREFIX + req.spreadsheetId + ':' + String(req.parentId).toLowerCase();
    var raw = PropertiesService.getScriptProperties().getProperty(key);
    if (!raw) return { ok: false, error: 'undo情報が見つかりません: ' + req.parentId };
    var info = JSON.parse(raw);
    var ss = SpreadsheetApp.openById(req.spreadsheetId);
    var sheet = ss.getSheetByName(info.sheetName);
    if (!sheet) return { ok: false, error: 'タブが見つかりません: ' + info.sheetName };
    info.inserted.slice().sort(function (a, b) { return b.startCol - a.startCol; }).forEach(function (blk) {
      sheet.deleteColumns(blk.startCol + 1, blk.width); // startColは0-indexed
    });
    PropertiesService.getScriptProperties().deleteProperty(key);
    return { ok: true, removed: info.inserted };
  } catch (e) {
    return { ok: false, error: String(e && e.message ? e.message : e) };
  }
}

// ------------------------------------------------------------
// レイアウト解析
// ------------------------------------------------------------
function submitResolveSheet_(ss, sheetName) {
  if (sheetName) {
    var s = ss.getSheetByName(sheetName);
    if (!s) throw new Error('タブが見つかりません: ' + sheetName);
    return s;
  }
  // sheetName省略時: cr00をID行に含むタブを自動検出
  var hits = [];
  ss.getSheets().forEach(function (s) {
    if (s.getLastColumn() < 5) return;
    var rows = s.getRange(1, 1, Math.min(SUBMIT_ID_ROW_SEARCH_MAX, s.getMaxRows()), s.getLastColumn()).getDisplayValues();
    var found = rows.some(function (r) { return r.some(function (v) { return String(v).trim().toLowerCase() === SUBMIT_TEMPLATE_ID; }); });
    if (found) hits.push(s);
  });
  if (hits.length === 0) throw new Error('cr00を含むタブが見つかりません（sheetNameを指定してください）');
  if (hits.length > 1) throw new Error('対象候補タブが複数あります: ' + hits.map(function (s) { return s.getName(); }).join(', '));
  return hits[0];
}

/** ID行・ID行のcrセル一覧・cr00の左右列・1行目ヘッダーを返す */
function submitLayout_(sheet) {
  var lastCol = sheet.getLastColumn();
  var head = sheet.getRange(1, 1, Math.min(SUBMIT_ID_ROW_SEARCH_MAX, sheet.getMaxRows()), lastCol).getDisplayValues();

  var idRow = -1, best = 0;
  for (var r = 1; r < head.length; r++) {
    var n = head[r].filter(function (v) { return /^cr\d/i.test(String(v).trim()); }).length;
    if (n > best) { best = n; idRow = r + 1; } // 1-indexed
  }
  if (idRow < 0) throw new Error('クリエイティブID行が特定できません（1〜' + SUBMIT_ID_ROW_SEARCH_MAX + '行にcrXXなし）');

  var idVals = head[idRow - 1];
  var idCells = [];
  for (var c = 0; c < idVals.length; c++) {
    var v = String(idVals[c] || '').trim();
    if (/^cr\d|^cr00$/i.test(v)) idCells.push({ col: c, id: v });
  }
  var cr00 = idCells.filter(function (x) { return x.id.toLowerCase() === SUBMIT_TEMPLATE_ID; }).map(function (x) { return x.col; }).sort(function (a, b) { return a - b; });
  if (!cr00.length) throw new Error('cr00テンプレがID行に見つかりません');

  return { idRow: idRow, idCells: idCells, row1: head[0], cr00: { left: cr00[0], right: cr00[cr00.length - 1] }, lastCol: lastCol };
}

/** テンプレのunit範囲: cr00列 〜 次のcr-id列の直前（無ければメモ列+1）。memoColも返す */
function submitUnit_(lay, tplCol) {
  var next = null;
  lay.idCells.forEach(function (x) { if (x.col > tplCol && (next === null || x.col < next)) next = x.col; });
  var end;
  if (next !== null) {
    end = next - 1;
  } else {
    var memo = -1;
    for (var c = tplCol; c < lay.row1.length; c++) { if (String(lay.row1[c]).trim() === 'メモ') { memo = c; break; } }
    end = memo >= 0 ? memo + 1 : tplCol;
  }
  var memoCol = -1;
  for (var c2 = tplCol; c2 <= end && c2 < lay.row1.length; c2++) { if (String(lay.row1[c2]).trim() === 'メモ') { memoCol = c2; break; } }
  return { start: tplCol, end: end, width: end - tplCol + 1, memoCol: memoCol };
}

// ------------------------------------------------------------
// ブロック挿入（cr00 unit を直右に複製 → ID/分類/判定/グループ化を設定）
// ------------------------------------------------------------
function submitInsert_(sheet, lay, p) {
  var tpl = p.tpl, width = tpl.width, maxRows = sheet.getMaxRows(), warn = '';

  // グループ深度を控える（copyToでは複製されないため後で再現）
  var depths = [];
  for (var c = tpl.start; c <= tpl.end; c++) depths.push(sheet.getColumnGroupDepth(c + 1));

  // cr00 unit の直右に width 列挿入し、cr00 unit を書式・数式・入力規則ごと複製
  sheet.insertColumnsAfter(tpl.end + 1, width);
  var insStart = tpl.end + 1; // 0-indexed
  sheet.getRange(1, tpl.start + 1, maxRows, width)
    .copyTo(sheet.getRange(1, insStart + 1, maxRows, width), { contentsOnly: false });

  // ID行の先頭列にcr名を書く
  sheet.getRange(lay.idRow, insStart + 1).setValue(p.id);

  // 親子分類（row2, メモ列）＋ 親（子有り）は判定(row5)を子にて判定に
  if (tpl.memoCol >= 0) {
    var memoNew = insStart + (tpl.memoCol - tpl.start);
    try {
      sheet.getRange(SUBMIT_CLASS_ROW, memoNew + 1).setValue(p.cls);
      if (p.cls === '親（子有り）') {
        var jc = sheet.getRange(SUBMIT_JUDGE_ROW, memoNew + 1);
        if (String(jc.getValue()).indexOf('子にて判定') < 0) jc.setValue('子にて判定');
      }
    } catch (e) { warn += '分類設定失敗(' + p.id + '):' + e.message + ' '; }
  }

  // 列グループ化を再現（深度1のrun単位）
  try {
    var run = null;
    for (var i = 0; i <= depths.length; i++) {
      var d = i < depths.length ? depths[i] : 0;
      if (d > 0 && run === null) run = i;
      if ((d === 0 || i === depths.length) && run !== null) {
        sheet.getRange(1, insStart + 1 + run, 1, i - run).shiftColumnGroupDepth(1);
        run = null;
      }
    }
  } catch (e2) { warn += 'グループ化失敗:' + e2.message; }

  return { id: p.id, zone: p.zone, startCol: insStart, width: width, warn: warn };
}

function submitColA1_(colIndex0) {
  var n = colIndex0 + 1, s = '';
  while (n > 0) { var r = (n - 1) % 26; s = String.fromCharCode(65 + r) + s; n = Math.floor((n - 1) / 26); }
  return s;
}
