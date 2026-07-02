/**
 * クリエイティブ停止処理【マルチ案件対応版 / 全案件共通ソース】
 * ----------------------------------------------------------
 * jdem も hyd も、その他の案件も「このソースそのまま」で動く。
 * 集計表タブ名は基本 "meta_total"。違う場合だけ下記のいずれかで対応：
 *   ・CONFIG.SHEET_NAME_CANDIDATES に名前を1行足す、または
 *   ・自動検出に任せる（ラベル行に「消化金額」と「メモ」を持つタブを集計表とみなす）
 *
 * Web App(doPost)経由で stop / undo / find を実行できる。
 *
 * ■ 停止 (action=stop)
 *   {"action":"stop","creativeName":"cr45","stopDate":"6/14"}
 *     1. チェックボックスをON
 *     2. ヘッダー部(列群)をグレーで塗る
 *     3. メモ列の Daily行(年月日一致) に「M/D_停止」を記載
 *     4. メモ列の Monthly行(年月一致) にも「M/D_停止」を記載
 *   → 変更前の状態を「クリエイティブ名ごと」に保存(複数停止しても個別に戻せる)
 *
 * ■ 取り消し (action=undo)
 *   {"action":"undo","creativeName":"cr45","memoMode":"full"}  ← メモをセルごと停止前に戻す
 *   {"action":"undo","creativeName":"cr45","memoMode":"tag"}   ← 「M/D_停止」タグと区切りだけ消す
 *   ※ memoMode 省略時は "full"
 *
 * ■ 探索 (action=find)  ★マルチ案件ルーティング用
 *   {"action":"find","creativeName":"cr45"}
 *     このスプレッドシートの集計表にクリエイティブが存在するかを
 *     副作用なし(読み取り専用)で返す。Worker が全案件のGASに find を投げ、
 *     found:true の案件にだけ stop/undo を送る。
 *
 * ■ Daily / Monthly の領域分離
 *   A列の "daily" / "monthly" 見出しを境界に領域を分ける。
 *   停止日が「○/1」でも Daily行 と Monthly行 を取り違えない。
 *
 * ■ 手動テスト
 *   testStop_run() … cr45 を 6/14 で停止
 *   testUndo_full() / testUndo_tag() … cr45 の停止を取り消し
 *   testFind_run() … cr45 の存在確認 / testResolveSheet() … 解決タブ名の確認
 */

// ===== 共通設定（基本は触らない）=====
var CONFIG = {
  SHEET_NAME: 'meta_total',          // 基本のタブ名（全案件これでOK）
  SHEET_NAME_CANDIDATES: [],         // 例外案件のタブ名をここに足す 例: ['meta_total_2','集計']
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

// undo情報はクリエイティブ名ごとに保存(キー: UNDO_<creativeName>)
var UNDO_KEY_PREFIX = 'UNDO_';

// ============================================================
// Web App エンドポイント
// ============================================================
function doPost(e) {
  try {
    var params = JSON.parse(e.postData.contents);
    var action = params.action || 'stop';
    var result;

    if (action === 'stop') {
      result = stopCreative(params.creativeName, params.stopDate);
    } else if (action === 'undo') {
      result = undoCreative(params.creativeName, params.memoMode || 'full');
    } else if (action === 'find') {
      result = findCreative(params.creativeName);
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

// ============================================================
// 集計表タブの解決（meta_total 基本 → 候補 → 構造で自動検出）
// ============================================================
function resolveSheet() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();

  // 1) 既定タブ名（基本 meta_total）
  var sheet = ss.getSheetByName(CONFIG.SHEET_NAME);
  if (sheet) return sheet;

  // 2) 候補タブ名（例外案件はここに足すだけ）
  for (var i = 0; i < CONFIG.SHEET_NAME_CANDIDATES.length; i++) {
    sheet = ss.getSheetByName(CONFIG.SHEET_NAME_CANDIDATES[i]);
    if (sheet) return sheet;
  }

  // 3) 構造で自動検出：ラベル行に「消化金額」と「メモ」を両方持つタブ＝集計表
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
// 探索処理（読み取り専用・副作用なし）★マルチ案件ルーティング用
// ============================================================
function findCreative(creativeName) {
  var sheet = resolveSheet();
  if (!sheet) return { success: true, found: false };

  var lastCol = sheet.getLastColumn();
  var headerValues = sheet.getRange(CONFIG.HEADER_ROW, 1, 1, lastCol).getValues()[0];
  for (var c = 0; c < headerValues.length; c++) {
    if (String(headerValues[c]).trim().toLowerCase() === String(creativeName).toLowerCase()) {
      return { success: true, found: true, sheet: sheet.getName(), creativeName: creativeName };
    }
  }
  return { success: true, found: false, creativeName: creativeName };
}

// ============================================================
// 停止処理
// ============================================================
function stopCreative(creativeName, stopDate) {
  var sheet = resolveSheet();
  if (!sheet) {
    return { success: false, message: '集計表タブが見つかりません(meta_total 等)' };
  }

  var lastCol = sheet.getLastColumn();

  // --- 1. クリエイティブ名の列を探す ---
  var headerValues = sheet.getRange(CONFIG.HEADER_ROW, 1, 1, lastCol).getValues()[0];
  var nameCol = -1;
  for (var c = 0; c < headerValues.length; c++) {
    var v = String(headerValues[c]).trim();
    if (v === creativeName || v.toLowerCase() === String(creativeName).toLowerCase()) {
      nameCol = c + 1;
      break;
    }
  }
  if (nameCol === -1) {
    return { success: false, message: 'クリエイティブが見つかりません: ' + creativeName };
  }

  // --- 2. 「消化金額」〜「メモ」で列群の範囲を確定 ---
  var labelValues = sheet.getRange(CONFIG.LABEL_ROW, 1, 1, lastCol).getValues()[0];
  var leftCol = -1;
  for (var c = nameCol; c >= 1; c--) {
    if (String(labelValues[c - 1]).trim() === CONFIG.LEFT_LABEL) { leftCol = c; break; }
  }
  var rightCol = -1;
  for (var c = nameCol; c <= labelValues.length; c++) {
    if (String(labelValues[c - 1]).trim() === CONFIG.RIGHT_LABEL) { rightCol = c; break; }
  }
  if (leftCol === -1 || rightCol === -1) {
    return { success: false, message: '列群の範囲(消化金額〜メモ)を特定できません' };
  }
  var numCols = rightCol - leftCol + 1;
  var memoCol = rightCol;

  // === undo用: 変更前の状態を記録 ===
  var note = stopDate + CONFIG.MEMO_SUFFIX;
  var undo = {
    creativeName: creativeName,
    sheetName: sheet.getName(),
    note: note,            // 付与したタグ(tag削除で使う)
    checkbox: null,
    paint: null,
    memoDaily: null,
    memoMonthly: null
  };

  // --- 3. チェックボックスをTRUEに ---
  var checkboxSet = false;
  for (var i = 0; i < CONFIG.CHECKBOX_SEARCH_ROWS.length; i++) {
    var row = CONFIG.CHECKBOX_SEARCH_ROWS[i];
    var cell = sheet.getRange(row, memoCol);
    var rule = cell.getDataValidation();
    var isCheckbox = rule && rule.getCriteriaType() === SpreadsheetApp.DataValidationCriteria.CHECKBOX;
    var val = cell.getValue();
    if (isCheckbox || val === false || val === 'FALSE' || val === true || val === 'TRUE') {
      undo.checkbox = { row: row, col: memoCol, value: val };
      cell.setValue(true);
      checkboxSet = true;
      break;
    }
  }

  // --- 4. 列群をグレーで塗る ---
  var paintNumRows = CONFIG.PAINT_END_ROW - CONFIG.PAINT_START_ROW + 1;
  var paintRange = sheet.getRange(CONFIG.PAINT_START_ROW, leftCol, paintNumRows, numCols);
  undo.paint = {
    row: CONFIG.PAINT_START_ROW,
    col: leftCol,
    numRows: paintNumRows,
    numCols: numCols,
    backgrounds: paintRange.getBackgrounds()
  };
  paintRange.setBackground(CONFIG.GRAY_COLOR);

  // --- 5. メモ記載(Daily + Monthly) ---
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

  // === undo情報をクリエイティブ名ごとに保存 ===
  PropertiesService.getDocumentProperties()
    .setProperty(UNDO_KEY_PREFIX + creativeName, JSON.stringify(undo));

  return {
    success: true,
    message: '停止処理完了: ' + creativeName,
    creativeName: creativeName,
    sheet: sheet.getName(),
    columns: columnToLetter(leftCol) + '〜' + columnToLetter(rightCol),
    checkboxSet: checkboxSet,
    memoDaily: memoDailyResult,
    memoMonthly: memoMonthlyResult
  };
}

// ============================================================
// 取り消し処理
//   memoMode = 'full' : メモセルを停止前の状態に戻す
//   memoMode = 'tag'  : 「M/D_停止」タグと区切りだけを除去し、他は残す
// ============================================================
function undoCreative(creativeName, memoMode) {
  var key = UNDO_KEY_PREFIX + creativeName;
  var raw = PropertiesService.getDocumentProperties().getProperty(key);
  if (!raw) {
    return { success: false, message: '取り消し情報がありません: ' + creativeName +
                                      '(未停止、または既に取り消し済み)' };
  }
  var undo = JSON.parse(raw);
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(undo.sheetName);
  if (!sheet) {
    return { success: false, message: 'シートが見つかりません: ' + undo.sheetName };
  }

  var log = [];

  // チェックボックス復元
  if (undo.checkbox) {
    sheet.getRange(undo.checkbox.row, undo.checkbox.col).setValue(undo.checkbox.value);
    log.push('チェック復元 ' + columnToLetter(undo.checkbox.col) + undo.checkbox.row);
  }
  // 背景色復元
  if (undo.paint) {
    sheet.getRange(undo.paint.row, undo.paint.col, undo.paint.numRows, undo.paint.numCols)
         .setBackgrounds(undo.paint.backgrounds);
    log.push('背景色復元');
  }
  // メモ復元(Daily)
  if (undo.memoDaily) {
    restoreMemo(sheet, undo.memoDaily, undo.note, memoMode);
    log.push('Dailyメモ' + (memoMode === 'tag' ? 'タグ削除' : '復元') +
             ' ' + columnToLetter(undo.memoDaily.col) + undo.memoDaily.row);
  }
  // メモ復元(Monthly)
  if (undo.memoMonthly) {
    restoreMemo(sheet, undo.memoMonthly, undo.note, memoMode);
    log.push('Monthlyメモ' + (memoMode === 'tag' ? 'タグ削除' : '復元') +
             ' ' + columnToLetter(undo.memoMonthly.col) + undo.memoMonthly.row);
  }

  // 取り消したら保存情報を削除
  PropertiesService.getDocumentProperties().deleteProperty(key);

  return {
    success: true,
    message: '取り消し完了: ' + creativeName + ' (memoMode=' + memoMode + ')',
    creativeName: creativeName,
    detail: log
  };
}

/**
 * メモセルを復元する
 *   full : 保存していた停止前の値に戻す
 *   tag  : 現在の値から「note(=M/D_停止)」と区切り( / )だけを除去
 */
function restoreMemo(sheet, memoInfo, note, memoMode) {
  var cell = sheet.getRange(memoInfo.row, memoInfo.col);
  if (memoMode === 'tag') {
    var current = String(cell.getValue());
    cell.setValue(removeTag(current, note));
  } else {
    // full
    cell.setValue(memoInfo.value);
  }
}

/**
 * 文字列から特定タグと、その前後の区切り( / )を除去する
 *   'A / 6/14_停止'      → 'A'
 *   '6/14_停止 / B'      → 'B'
 *   'A / 6/14_停止 / B'  → 'A / B'
 *   '6/14_停止'          → ''
 */
function removeTag(text, tag) {
  // メモは " / "(前後スペース付きスラッシュ)で連結されるため、
  // 日付内の "6/14" を割らずに " / " 区切りでトークン化して一致タグを除く
  var segs = String(text).split(' / ');
  var kept = [];
  for (var i = 0; i < segs.length; i++) {
    if (segs[i].trim() !== tag.trim()) {
      kept.push(segs[i]);
    }
  }
  return kept.join(' / ').trim();
}

// ============================================================
// Daily / Monthly 行の特定(A列1回読み・領域分離)
// ============================================================
function findDailyAndMonthlyRow(sheet, dateStr) {
  var result = { dailyRow: -1, monthlyRow: -1 };
  var lastRow = sheet.getLastRow();
  if (lastRow < 1) return result;

  var ymd = parseDateStr(dateStr);
  var values = sheet.getRange(1, CONFIG.DAILY_DATE_COL, lastRow, 1).getValues();

  // 見出し行(daily / monthly)を特定
  var dailyHeaderRow = -1, monthlyHeaderRow = -1;
  for (var i = 0; i < values.length; i++) {
    var s = String(values[i][0]).trim().toLowerCase();
    if (dailyHeaderRow === -1 && s === CONFIG.DAILY_LABEL) dailyHeaderRow = i + 1;
    if (monthlyHeaderRow === -1 && s === CONFIG.MONTHLY_LABEL) monthlyHeaderRow = i + 1;
  }

  var dailyStart   = (dailyHeaderRow !== -1) ? dailyHeaderRow : 1;
  var dailyEnd     = (monthlyHeaderRow !== -1) ? monthlyHeaderRow - 1 : lastRow;
  var monthlyStart = (monthlyHeaderRow !== -1) ? monthlyHeaderRow : -1;

  // Daily領域: 年・月・日 一致
  for (var i = dailyStart - 1; i < dailyEnd; i++) {
    var v = values[i][0];
    if (v instanceof Date &&
        v.getFullYear() === ymd.year &&
        (v.getMonth() + 1) === ymd.month &&
        v.getDate() === ymd.day) {
      result.dailyRow = i + 1;
      break;
    }
  }

  // Monthly領域: 年・月 一致
  if (monthlyStart !== -1) {
    for (var i = monthlyStart - 1; i < values.length; i++) {
      var v = values[i][0];
      if (v instanceof Date &&
          v.getFullYear() === ymd.year &&
          (v.getMonth() + 1) === ymd.month) {
        result.monthlyRow = i + 1;
        break;
      }
    }
  }

  return result;
}

function parseDateStr(dateStr) {
  var parts = String(dateStr).split('/').map(function(s){ return parseInt(s, 10); });
  if (parts.length === 3) {
    return { year: parts[0], month: parts[1], day: parts[2] };
  }
  var now = new Date();
  return { year: now.getFullYear(), month: parts[0], day: parts[1] };
}

function columnToLetter(col) {
  var letter = '';
  while (col > 0) {
    var rem = (col - 1) % 26;
    letter = String.fromCharCode(65 + rem) + letter;
    col = Math.floor((col - 1) / 26);
  }
  return letter;
}

// ============================================================
// 手動テスト用
// ============================================================
function testStop_run() {
  Logger.log(JSON.stringify(stopCreative('cr45', '6/14'), null, 2));
}
function testUndo_full() {
  Logger.log(JSON.stringify(undoCreative('cr45', 'full'), null, 2));
}
function testUndo_tag() {
  Logger.log(JSON.stringify(undoCreative('cr45', 'tag'), null, 2));
}
function testFind_run() {
  Logger.log(JSON.stringify(findCreative('cr45'), null, 2));
}
function testResolveSheet() {
  var s = resolveSheet();
  Logger.log(s ? ('解決したタブ: ' + s.getName()) : '集計表タブが見つかりません');
}
