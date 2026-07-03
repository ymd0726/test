/**
 * マルチ案件ルーティング用の追加スニペット
 * ----------------------------------------------------------
 * 各案件の集計表に設置済みの stopCreative_final_*.gs に、以下2つを追記する。
 * これにより Worker が「このクリエイティブはこの案件にある？」を
 * 副作用なし(読み取り専用)で問い合わせできるようになる。
 *
 * 案件ごとにやること:
 *   1) スクリプトを設置（jdem版をコピー）
 *   2) CONFIG.SHEET_NAME をその案件の集計表タブ名に変更
 *   3) 下記2点を追記
 *   4) Web App としてデプロイ（アクセス=全員 / 実行=自分）→ /exec URL を控える
 */

// ── (1) doPost の action 分岐に、この else if を1つ追加 ──
//
//   } else if (action === 'undo') {
//     result = undoCreative(params.creativeName, params.memoMode || 'full');
//   } else if (action === 'find') {              // ★追加
//     result = findCreative(params.creativeName); // ★追加
//   } else {
//     ...

// ── (2) 末尾に関数を1つ追加（読み取り専用・副作用なし）──
function findCreative(creativeName) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(CONFIG.SHEET_NAME);
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
