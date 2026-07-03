/**
 * クリエイティブ停止処理【共通GAS / 全案件1つで対応】
 * ----------------------------------------------------------
 * スタンドアロンのGASとして1つだけデプロイする。各案件のスプレッドシートには
 * 設置しない。doPost が受け取る spreadsheetId で対象シートを openById して操作する。
 *
 * 【重要・前提】
 *  - このスクリプトを実行するGoogleアカウントが、各案件の集計表に「編集権限」を持つこと
 *  - 初回実行時に「スプレッドシートの管理」権限の承認を求められる（1回だけ承認）
 *  - スタンドアロンには DocumentProperties が無いため、undo情報は ScriptProperties に
 *    「UNDO_<spreadsheetId>_<creativeName>」キーで保存（案件をまたいでも衝突しない）
 *
 * リクエスト:
 *   stop : {"action":"stop","spreadsheetId":"<id>","creativeName":"cr45","stopDate":"6/14"}
 *   undo : {"action":"undo","spreadsheetId":"<id>","creativeName":"cr45","memoMode":"tag"}
 *   find : {"action":"find","spreadsheetId":"<id>","creativeName":"cr45"}
 *
 * 集計表タブ名は基本 "meta_total"（違っても候補追加 or 構造で自動検出）。
 */

var CONFIG = {
  SHEET_NAME: 'meta_total',
  SHEET_NAME_CANDIDATES: [],
  HEADER_ROW: 6,
  LABEL_ROW: 1,
  CHECKBOX_SEARCH_ROWS: [4, 5, 6],
  PAINT_START_ROW: 1,
  PAINT_END_ROW: 6,
  GRAY_COLOR: '#999999',
  LEFT_LABEL: '消化金額',
  RIGHT_LABEL: 'メモ',
  DAILY_DATE_COL: 1,
  DAILY_LABEL: 'daily',
  MONTHLY_LABEL: 'monthly',
  MEMO_SUFFIX: '_停止'
};

var UNDO_KEY_PREFIX = 'UNDO_';

// ============================================================
// Web App エンドポイント
// ============================================================
function doPost(e) {
  try {
    var params = JSON.parse(e.postData.contents);
    var action = params.action || 'stop';
    var ssId = params.spreadsheetId;
    if (!ssId) return jsonOut({ success: false, message: 'spreadsheetId がありません' });

    var sheetName = params.sheetName; // 任意。指定時はそのタブを直接使う（複数タブ案件用）
    var result;
    if (action === 'stop') {
      result = stopCreative(ssId, sheetName, params.creativeName, params.stopDate);
    } else if (action === 'undo') {
      result = undoCreative(ssId, params.creativeName, params.memoMode || 'full');
    } else if (action === 'find') {
      result = findCreative(ssId, sheetName, params.creativeName);
    } else if (action === 'budget_propagate') {
      result = budgetPropagate(ssId, sheetName, params);
    } else {
      result = { success: false, message: '不明なaction: ' + action };
    }
    return jsonOut(result);
  } catch (err) {
    return jsonOut({ success: false, message: 'エラー: ' + err });
  }
}

function jsonOut(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj))
                       .setMimeType(ContentService.MimeType.JSON);
}

function openSS(ssId) {
  return SpreadsheetApp.openById(ssId);
}

// ============================================================
// 集計表タブの解決（meta_total 基本 → 候補 → 構造で自動検出）
// ============================================================
function resolveSheet(ss, sheetName) {
  // タブ名が明示されていれば最優先（複数集計タブの案件用）
  if (sheetName) { var sp = ss.getSheetByName(sheetName); if (sp) return sp; }
  var sheet = ss.getSheetByName(CONFIG.SHEET_NAME);
  if (sheet) return sheet;
  for (var i = 0; i < CONFIG.SHEET_NAME_CANDIDATES.length; i++) {
    sheet = ss.getSheetByName(CONFIG.SHEET_NAME_CANDIDATES[i]);
    if (sheet) return sheet;
  }
  var all = ss.getSheets();
  for (var j = 0; j < all.length; j++) {
    var s = all[j];
    var lastCol = s.getLastColumn();
    if (lastCol < 1) continue;
    var labels = s.getRange(CONFIG.LABEL_ROW, 1, 1, lastCol).getValues()[0];
    var hasLeft = false, hasRight = false;
    for (var c = 0; c < labels.length; c++) {
      var lv = String(labels[c]).trim();
      if (lv === CONFIG.LEFT_LABEL) hasLeft = true;
      if (lv === CONFIG.RIGHT_LABEL) hasRight = true;
    }
    if (hasLeft && hasRight) return s;
  }
  return null;
}

// ============================================================
// 探索（読み取り専用・副作用なし）
// ============================================================
// クリエイティブ名の列を探す。ヘッダーブロック(1〜HEADER_ROW行)全体から探すので
// 行6固定でも、結合セル(値が上の行に入る)でも拾える。見つかった列(1-based)を返す。
function findNameCol(sheet, creativeName) {
  var lastCol = sheet.getLastColumn();
  if (lastCol < 1) return -1;
  // クリエイティブ名は基本6行目だが、案件により7・8行目のこともある(ssh等)。
  // 1〜8行のヘッダーブロック全体から探す（cr名の完全一致なので誤検出しない）。
  var nameRows = Math.min(8, sheet.getLastRow());
  var block = sheet.getRange(1, 1, nameRows, lastCol).getValues();
  var target = String(creativeName).trim().toLowerCase();
  for (var r = 0; r < block.length; r++) {
    for (var c = 0; c < block[r].length; c++) {
      if (String(block[r][c]).trim().toLowerCase() === target) return c + 1;
    }
  }
  return -1;
}

function findCreative(ssId, sheetName, creativeName) {
  var sheet = resolveSheet(openSS(ssId), sheetName);
  if (!sheet) return { success: true, found: false };
  if (findNameCol(sheet, creativeName) !== -1) {
    return { success: true, found: true, sheet: sheet.getName(), creativeName: creativeName };
  }
  return { success: true, found: false, creativeName: creativeName };
}

// ============================================================
// 停止
// ============================================================
function stopCreative(ssId, sheetName, creativeName, stopDate) {
  var sheet = resolveSheet(openSS(ssId), sheetName);
  if (!sheet) return { success: false, message: '集計表タブが見つかりません(' + (sheetName || 'meta_total') + ' 等)' };
  var lastCol = sheet.getLastColumn();

  var nameCol = findNameCol(sheet, creativeName); // 結合セル対応（1〜HEADER_ROW行を走査）
  if (nameCol === -1) return { success: false, message: 'クリエイティブが見つかりません: ' + creativeName };

  var labelValues = sheet.getRange(CONFIG.LABEL_ROW, 1, 1, lastCol).getValues()[0];
  var leftCol = -1;
  for (var c = nameCol; c >= 1; c--) { if (String(labelValues[c - 1]).trim() === CONFIG.LEFT_LABEL) { leftCol = c; break; } }
  var rightCol = -1;
  for (var c = nameCol; c <= labelValues.length; c++) { if (String(labelValues[c - 1]).trim() === CONFIG.RIGHT_LABEL) { rightCol = c; break; } }
  if (leftCol === -1 || rightCol === -1) return { success: false, message: '列群の範囲(消化金額〜メモ)を特定できません' };
  var numCols = rightCol - leftCol + 1;
  var memoCol = rightCol;

  var note = stopDate + CONFIG.MEMO_SUFFIX;
  var undo = { creativeName: creativeName, sheetName: sheet.getName(), note: note, checkbox: null, paint: null, memoDaily: null, memoMonthly: null };

  var checkboxSet = false;
  for (var i = 0; i < CONFIG.CHECKBOX_SEARCH_ROWS.length; i++) {
    var row = CONFIG.CHECKBOX_SEARCH_ROWS[i];
    var cell = sheet.getRange(row, memoCol);
    var rule = cell.getDataValidation();
    var isCheckbox = rule && rule.getCriteriaType() === SpreadsheetApp.DataValidationCriteria.CHECKBOX;
    var val = cell.getValue();
    if (isCheckbox || val === false || val === 'FALSE' || val === true || val === 'TRUE') {
      undo.checkbox = { row: row, col: memoCol, value: val };
      cell.setValue(true); checkboxSet = true; break;
    }
  }

  var paintNumRows = CONFIG.PAINT_END_ROW - CONFIG.PAINT_START_ROW + 1;
  var paintRange = sheet.getRange(CONFIG.PAINT_START_ROW, leftCol, paintNumRows, numCols);
  undo.paint = { row: CONFIG.PAINT_START_ROW, col: leftCol, numRows: paintNumRows, numCols: numCols, backgrounds: paintRange.getBackgrounds() };
  paintRange.setBackground(CONFIG.GRAY_COLOR);

  var memoDailyResult = 'Daily日付行が見つからず未記載';
  var memoMonthlyResult = 'Monthly月次行が見つからず未記載';
  if (stopDate) {
    var info = findDailyAndMonthlyRow(sheet, stopDate);
    if (info.dailyRow !== -1) {
      var dCell = sheet.getRange(info.dailyRow, memoCol);
      var dExisting = String(dCell.getValue()).trim();
      undo.memoDaily = { row: info.dailyRow, col: memoCol, value: dCell.getValue() };
      dCell.setValue(dExisting ? dExisting + ' / ' + note : note);
      memoDailyResult = columnToLetter(memoCol) + info.dailyRow + 'に「' + note + '」を記載';
    }
    if (info.monthlyRow !== -1) {
      var mCell = sheet.getRange(info.monthlyRow, memoCol);
      var mExisting = String(mCell.getValue()).trim();
      undo.memoMonthly = { row: info.monthlyRow, col: memoCol, value: mCell.getValue() };
      mCell.setValue(mExisting ? mExisting + ' / ' + note : note);
      memoMonthlyResult = columnToLetter(memoCol) + info.monthlyRow + 'に「' + note + '」を記載';
    }
  }

  PropertiesService.getScriptProperties().setProperty(UNDO_KEY_PREFIX + ssId + '_' + creativeName, JSON.stringify(undo));

  return { success: true, message: '停止処理完了: ' + creativeName, creativeName: creativeName, sheet: sheet.getName(),
    columns: columnToLetter(leftCol) + '〜' + columnToLetter(rightCol), checkboxSet: checkboxSet, memoDaily: memoDailyResult, memoMonthly: memoMonthlyResult };
}

// ============================================================
// 取り消し
// ============================================================
function undoCreative(ssId, creativeName, memoMode) {
  var key = UNDO_KEY_PREFIX + ssId + '_' + creativeName;
  var raw = PropertiesService.getScriptProperties().getProperty(key);
  if (!raw) return { success: false, message: '取り消し情報がありません: ' + creativeName + '(未停止、または既に取り消し済み)' };
  var undo = JSON.parse(raw);
  var sheet = openSS(ssId).getSheetByName(undo.sheetName);
  if (!sheet) return { success: false, message: 'シートが見つかりません: ' + undo.sheetName };

  var log = [];
  if (undo.checkbox) { sheet.getRange(undo.checkbox.row, undo.checkbox.col).setValue(undo.checkbox.value); log.push('チェック復元 ' + columnToLetter(undo.checkbox.col) + undo.checkbox.row); }
  if (undo.paint) { sheet.getRange(undo.paint.row, undo.paint.col, undo.paint.numRows, undo.paint.numCols).setBackgrounds(undo.paint.backgrounds); log.push('背景色復元'); }
  if (undo.memoDaily) { restoreMemo(sheet, undo.memoDaily, undo.note, memoMode); log.push('Dailyメモ' + (memoMode === 'tag' ? 'タグ削除' : '復元')); }
  if (undo.memoMonthly) { restoreMemo(sheet, undo.memoMonthly, undo.note, memoMode); log.push('Monthlyメモ' + (memoMode === 'tag' ? 'タグ削除' : '復元')); }

  PropertiesService.getScriptProperties().deleteProperty(key);
  return { success: true, message: '取り消し完了: ' + creativeName + ' (memoMode=' + memoMode + ')', creativeName: creativeName, detail: log };
}

function restoreMemo(sheet, memoInfo, note, memoMode) {
  var cell = sheet.getRange(memoInfo.row, memoInfo.col);
  if (memoMode === 'tag') { cell.setValue(removeTag(String(cell.getValue()), note)); } else { cell.setValue(memoInfo.value); }
}

function removeTag(text, tag) {
  var segs = String(text).split(' / ');
  var kept = [];
  for (var i = 0; i < segs.length; i++) { if (segs[i].trim() !== tag.trim()) kept.push(segs[i]); }
  return kept.join(' / ').trim();
}

function findDailyAndMonthlyRow(sheet, dateStr) {
  var result = { dailyRow: -1, monthlyRow: -1 };
  var lastRow = sheet.getLastRow();
  if (lastRow < 1) return result;
  var ymd = parseDateStr(dateStr);
  var values = sheet.getRange(1, CONFIG.DAILY_DATE_COL, lastRow, 1).getValues();
  var dailyHeaderRow = -1, monthlyHeaderRow = -1;
  for (var i = 0; i < values.length; i++) {
    var s = String(values[i][0]).trim().toLowerCase();
    if (dailyHeaderRow === -1 && s === CONFIG.DAILY_LABEL) dailyHeaderRow = i + 1;
    if (monthlyHeaderRow === -1 && s === CONFIG.MONTHLY_LABEL) monthlyHeaderRow = i + 1;
  }
  var dailyStart = (dailyHeaderRow !== -1) ? dailyHeaderRow : 1;
  var dailyEnd = (monthlyHeaderRow !== -1) ? monthlyHeaderRow - 1 : lastRow;
  var monthlyStart = (monthlyHeaderRow !== -1) ? monthlyHeaderRow : -1;
  for (var i = dailyStart - 1; i < dailyEnd; i++) {
    var v = values[i][0];
    if (v instanceof Date && v.getFullYear() === ymd.year && (v.getMonth() + 1) === ymd.month && v.getDate() === ymd.day) { result.dailyRow = i + 1; break; }
  }
  if (monthlyStart !== -1) {
    for (var i = monthlyStart - 1; i < values.length; i++) {
      var v = values[i][0];
      if (v instanceof Date && v.getFullYear() === ymd.year && (v.getMonth() + 1) === ymd.month) { result.monthlyRow = i + 1; break; }
    }
  }
  return result;
}

function parseDateStr(dateStr) {
  var parts = String(dateStr).split('/').map(function(s){ return parseInt(s, 10); });
  if (parts.length === 3) return { year: parts[0], month: parts[1], day: parts[2] };
  var now = new Date();
  return { year: now.getFullYear(), month: parts[0], day: parts[1] };
}

function columnToLetter(col) {
  var letter = '';
  while (col > 0) { var rem = (col - 1) % 26; letter = String.fromCharCode(65 + rem) + letter; col = Math.floor((col - 1) / 26); }
  return letter;
}

// ============================================================
// 予算確定→波及くん : 集計表 monthly ブロックへ予算波及
//   - リクエスト予算欄（列「リクエスト予算」= 通常AA）対象月行 を 変更後予算で更新
//   - メモ欄（列「メモ」= 通常Z）に変更ログ(memoText)を追記
// 検出規約は install_budget_alert.py / propagate_budget.py と統一。
//   params: { targetYear, targetMonth(1-12), requestBudget(number),
//             memoText(string), prevBudget(number|null), dryRun(bool) }
// ============================================================
function budgetPropagate(ssId, sheetName, params) {
  var sheet = resolveSheet(openSS(ssId), sheetName);
  if (!sheet) return { success: false, message: '集計表タブが見つかりません(' + (sheetName || 'meta_total') + ' 等)' };

  var now = new Date();
  var year = parseInt(params.targetYear, 10) || now.getFullYear();
  var month = parseInt(params.targetMonth, 10) || (now.getMonth() + 1);
  var budget = Number(params.requestBudget);
  var memoText = params.memoText ? String(params.memoText) : '';
  var dryRun = (params.dryRun === true || params.dryRun === 'true');

  if (!(budget > 0)) {
    return { success: false, message: 'requestBudget が正の数ではありません: ' + params.requestBudget };
  }

  // リクエスト予算列 / メモ列（ラベル行=CONFIG.LABEL_ROW の最初の一致＝訴求サマリ列）
  var lastCol = sheet.getLastColumn();
  var labels = sheet.getRange(CONFIG.LABEL_ROW, 1, 1, lastCol).getValues()[0];
  var budCol = -1, memoCol = -1;
  for (var c = 0; c < labels.length; c++) {
    var lv = String(labels[c]).trim();
    if (budCol === -1 && lv === 'リクエスト予算') budCol = c + 1;
    if (memoCol === -1 && lv === CONFIG.RIGHT_LABEL) memoCol = c + 1; // 'メモ'
  }
  if (budCol === -1) return { success: false, message: '「リクエスト予算」列が見つかりません' };
  if (memoCol === -1) memoCol = budCol - 1;

  // 対象月行（monthly ブロック内の Date 一致。文字列 "YY年MM月" も許容）
  var monthlyRow = findMonthlyRowByYM(sheet, year, month);
  if (monthlyRow === -1) {
    return { success: false, message: '対象月行が見つかりません: ' + year + '/' + month };
  }

  var budCell = sheet.getRange(monthlyRow, budCol);
  var memoCell = sheet.getRange(monthlyRow, memoCol);
  var currentBudget = budCell.getValue();
  var currentMemo = String(memoCell.getValue());
  var newMemo = (currentMemo.trim() && memoText) ? (currentMemo + '\n' + memoText)
              : (memoText || currentMemo);

  var out = {
    success: true, dryRun: dryRun, sheet: sheet.getName(),
    targetMonth: year + '年' + ('0' + month).slice(-2) + '月', targetRow: monthlyRow,
    budgetCell: columnToLetter(budCol) + monthlyRow, currentBudget: currentBudget, newBudget: budget,
    memoCell: columnToLetter(memoCol) + monthlyRow, currentMemo: currentMemo, memoAppended: memoText,
    wrote: false
  };
  if (dryRun) return out;

  budCell.setValue(budget);
  if (memoText) memoCell.setValue(newMemo);
  out.wrote = true;
  return out;
}

// monthly ブロック内で 指定年月 に一致する行(1-based)を返す。無ければ -1。
function findMonthlyRowByYM(sheet, year, month) {
  var lastRow = sheet.getLastRow();
  if (lastRow < 1) return -1;
  var col = sheet.getRange(1, CONFIG.DAILY_DATE_COL, lastRow, 1).getValues();
  // 'monthly' ラベル行以降を対象（無ければ全体）
  var monthlyStart = 1;
  for (var i = 0; i < col.length; i++) {
    if (String(col[i][0]).trim().toLowerCase() === CONFIG.MONTHLY_LABEL) { monthlyStart = i + 2; break; }
  }
  var yy = ('0' + (year % 100)).slice(-2);
  var mm = ('0' + month).slice(-2);
  var labelText = yy + '年' + mm + '月';
  for (var i = monthlyStart - 1; i < col.length; i++) {
    var v = col[i][0];
    if (v instanceof Date) {
      if (v.getFullYear() === year && (v.getMonth() + 1) === month) return i + 1;
    } else if (String(v).trim() === labelText) {
      return i + 1;
    }
  }
  return -1;
}

// ============================================================
// 手動テスト用（spreadsheetId を自分の集計表IDに変えて実行）
// ============================================================
function testFind_run() {
  Logger.log(JSON.stringify(findCreative('11ZkSchmHPDeaDLo6h3EfyNYW9pHisxw6ErH5KlU7-EI', null, 'cr45'), null, 2)); // jdemで例
}

// 予算波及 DRY-RUN テスト（grm_集計 / 当月）。書込まず対象セルだけ確認。
function testBudget_run() {
  var res = budgetPropagate('1Ug7qBDUUhLutvDLlBbQNiKvIhVbwOhxlOOYm-zPpwG0', null, {
    targetYear: 2026, targetMonth: 6, requestBudget: 300000,
    memoText: '6/21_予算UP25万→30万', dryRun: true
  });
  Logger.log(JSON.stringify(res, null, 2));
}
