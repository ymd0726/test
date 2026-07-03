/**
 * cr入稿くん 集計表展開（独立GASプロジェクト版）
 * ------------------------------------------------------------
 * 停止くんの共通GASとは別の、専用GASプロジェクト（submitCreative_common）として
 * デプロイする。このファイル1本で完結（doPost同梱）。
 * Workerは SUBMIT_GAS_URL でこちらを叩く（stop/undo/find は従来どおり共通GAS）。
 * 反映は「デプロイを管理 → 新バージョン」（URLを変えないため）。
 *
 * 機能:
 *   CR00テンプレブロックを複製して「CR00の直右」に挿入する。
 *   - 親（または単独CR）→ 集計内ゾーン（「集計外CR→」マーカーの左）のCR00ブロック
 *   - 子（パターン _01, _02…）→ 集計外ゾーン（マーカーの右）のCR00ブロック
 *   書式・数式・入力規則ごと copyTo で複製し、ID行のセルだけ新cr名に書き換える。
 *   メモ列2行目の親子分類プルダウン設定、親（子有り）の判定式ラップ、
 *   列グループ化の再作成（コピーされない既知問題対応）まで行う。
 *
 * リクエスト:
 *   { action:'submitCreative', spreadsheetId, sheetName?, parentId, childIds:[], dryRun }
 *   - parentId: 集計表表記の親ID（例 'cr79_ブライダル訴求'）
 *   - childIds: 集計表表記の子ID配列（例 ['cr79_01_ブライダル訴求', ...]）。無ければ []
 *   - sheetName 省略時は cr00 とマーカーを含むタブを自動検出（複数該当はエラー）
 *
 * ※実行アカウントが対象集計表に編集権限を持つこと（既存stop/undoと同じ）
 */

// ── Web App エンドポイント（このプロジェクト単体で完結）──
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
  return ContentService.createTextOutput(JSON.stringify(obj))
                       .setMimeType(ContentService.MimeType.JSON);
}

var SUBMIT_MARKER = '集計外CR→';
var SUBMIT_TEMPLATE_ID = 'cr00';
var SUBMIT_ID_ROW_SEARCH_MAX = 8; // クリエイティブID行の探索範囲（1〜8行目）
var SUBMIT_UNDO_KEY_PREFIX = 'submitUndo:';

function handleSubmitCreative(req) {
  try {
    var ss = SpreadsheetApp.openById(req.spreadsheetId);
    var sheet = submitResolveSheet_(ss, req.sheetName);
    var layout = submitAnalyzeLayout_(sheet);

    var parentId = String(req.parentId || '').trim();
    var childIds = (req.childIds || []).map(function (s) { return String(s).trim(); }).filter(String);
    if (!parentId) return { ok: false, error: 'parentId が必要です' };

    // 冪等性: 既存IDチェック
    var existing = submitExistingIds_(layout);
    var dup = [parentId].concat(childIds).filter(function (id) { return existing[submitNormId_(id)]; });
    if (dup.length) {
      return { ok: false, error: '既に集計表に存在します: ' + dup.join(', ') + '（二重入稿防止のため中断）' };
    }

    // テンプレブロック（各ゾーンで最もCR00に近い＝ゾーン内の左端のcr00ブロック）
    var tplLeft = submitPickTemplate_(layout, 'left');
    var tplRight = childIds.length ? submitPickTemplate_(layout, 'right') : null;
    if (!tplLeft) return { ok: false, error: '集計内ゾーンに cr00 テンプレブロックが見つかりません' };
    if (childIds.length && !tplRight) {
      return { ok: false, error: '集計外ゾーンに cr00 テンプレブロックが見つかりません' };
    }

    var hasChildren = childIds.length > 0;
    var plan = [];
    // 親: 左ゾーンのcr00直右へ1ブロック
    plan.push({
      zone: 'left', template: tplLeft, id: parentId,
      classification: hasChildren ? '親（子有り）' : '親（子無し）'
    });
    // 子: 右ゾーンのcr00直右へ、childIds順に並ぶよう「後ろから」挿入する
    for (var i = childIds.length - 1; i >= 0; i--) {
      plan.push({ zone: 'right', template: tplRight, id: childIds[i], classification: '子' });
    }

    if (req.dryRun) {
      return {
        ok: true, dryRun: true, sheetName: sheet.getName(),
        layout: submitLayoutSummary_(layout),
        plan: plan.map(function (p) {
          return {
            id: p.id, zone: p.zone, classification: p.classification,
            insertAfterCol: p.template.endCol + 1, width: p.template.width
          };
        })
      };
    }

    // 実挿入。左ゾーンに挿入すると右ゾーンの列番号がずれるため、
    // 「右ゾーン（子）→ 左ゾーン（親）」の順で実行する。
    var inserted = [];
    var warnings = [];
    plan
      .slice()
      .sort(function (a, b) { return b.template.startCol - a.template.startCol; })
      .forEach(function (p) {
        var r = submitInsertBlock_(sheet, layout, p);
        // 今回の挿入位置より右にある記録済みブロックは、挿入分だけ右へずれる（undo位置補正）
        inserted.forEach(function (rec) {
          if (rec.startCol >= r.info.startCol) rec.startCol += r.info.width;
        });
        inserted.push(r.info);
        if (r.warnings.length) warnings = warnings.concat(r.warnings);
      });

    // undo情報（挿入した列範囲を後ろから消せるように記録）
    PropertiesService.getScriptProperties().setProperty(
      SUBMIT_UNDO_KEY_PREFIX + req.spreadsheetId + ':' + submitNormId_(parentId),
      JSON.stringify({ sheetName: sheet.getName(), inserted: inserted, at: new Date().toISOString() })
    );

    return { ok: true, sheetName: sheet.getName(), inserted: inserted, warnings: warnings };
  } catch (e) {
    return { ok: false, error: String(e && e.message ? e.message : e) };
  }
}

/** 入稿undo: 記録済みの挿入列を削除（右の列から順に） */
function handleSubmitUndo(req) {
  try {
    var key = SUBMIT_UNDO_KEY_PREFIX + req.spreadsheetId + ':' + submitNormId_(req.parentId);
    var raw = PropertiesService.getScriptProperties().getProperty(key);
    if (!raw) return { ok: false, error: 'undo情報が見つかりません: ' + req.parentId };
    var info = JSON.parse(raw);
    var ss = SpreadsheetApp.openById(req.spreadsheetId);
    var sheet = ss.getSheetByName(info.sheetName);
    if (!sheet) return { ok: false, error: 'タブが見つかりません: ' + info.sheetName };
    info.inserted
      .slice()
      .sort(function (a, b) { return b.startCol - a.startCol; })
      .forEach(function (blk) {
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
  var hits = [];
  ss.getSheets().forEach(function (s) {
    var lastCol = s.getLastColumn();
    if (lastCol < 5) return;
    var row1 = s.getRange(1, 1, 1, lastCol).getDisplayValues()[0];
    if (row1.indexOf(SUBMIT_MARKER) >= 0) hits.push(s);
  });
  if (hits.length === 0) throw new Error('「' + SUBMIT_MARKER + '」マーカーを含むタブが見つかりません（sheetNameを指定してください）');
  if (hits.length > 1) {
    throw new Error('対象候補タブが複数あります: ' + hits.map(function (s) { return s.getName(); }).join(', ') + '（sheetNameを指定してください）');
  }
  return hits[0];
}

/**
 * ヘッダー領域を解析して { markerCol, idRow, blocks[] } を返す。
 * 列indexはすべて0-indexed、行は1-indexed（GAS Range準拠に+1して使う）。
 */
function submitAnalyzeLayout_(sheet) {
  var lastCol = sheet.getLastColumn();
  var head = sheet.getRange(1, 1, SUBMIT_ID_ROW_SEARCH_MAX, lastCol).getDisplayValues();
  var row1 = head[0];

  var markerCol = -1;
  for (var c = 0; c < row1.length; c++) {
    if (String(row1[c]).trim() === SUBMIT_MARKER) { markerCol = c; break; }
  }

  // ID行: 1〜8行のうち cr\d 始まりのセルが最多の行
  var idRow = -1, best = 0;
  for (var r = 1; r < head.length; r++) {
    var n = head[r].filter(function (v) { return /^cr\d/i.test(String(v).trim()); }).length;
    if (n > best) { best = n; idRow = r + 1; } // 1-indexed
  }
  if (idRow < 0) throw new Error('クリエイティブID行が特定できません（1〜' + SUBMIT_ID_ROW_SEARCH_MAX + '行目にcrXXが見つからない）');
  var idVals = head[idRow - 1];

  // メモ列 = ブロック末尾
  var memoCols = [];
  for (var c2 = 0; c2 < row1.length; c2++) {
    if (String(row1[c2]).trim() === 'メモ') memoCols.push(c2);
  }
  if (memoCols.length === 0) throw new Error('メモ列（ブロック区切り）が見つかりません');

  var blocks = [];
  var start = 0;
  memoCols.forEach(function (memoCol) {
    var ids = [];
    var idCol = -1;
    for (var c3 = start; c3 <= memoCol; c3++) {
      var v = String(idVals[c3] || '').trim();
      if (v) { ids.push(v); if (idCol < 0) idCol = c3; }
    }
    blocks.push({
      startCol: start, endCol: memoCol, width: memoCol - start + 1, memoCol: memoCol,
      idCol: idCol, ids: ids,
      zone: markerCol >= 0 ? (memoCol < markerCol ? 'left' : 'right') : 'left'
    });
    start = memoCol + 1;
  });

  return { sheet: sheet, markerCol: markerCol, idRow: idRow, blocks: blocks, lastCol: lastCol };
}

function submitPickTemplate_(layout, zone) {
  var candidates = layout.blocks.filter(function (b) {
    return b.zone === zone && b.ids.some(function (id) { return submitNormId_(id) === SUBMIT_TEMPLATE_ID; });
  });
  if (!candidates.length) return null;
  candidates.sort(function (a, b) { return a.startCol - b.startCol; });
  return candidates[0]; // ゾーン内で最も左のcr00
}

function submitExistingIds_(layout) {
  var map = {};
  layout.blocks.forEach(function (b) {
    b.ids.forEach(function (id) { map[submitNormId_(id)] = true; });
  });
  return map;
}

function submitNormId_(s) {
  return String(s || '').trim().toLowerCase();
}

function submitLayoutSummary_(layout) {
  return {
    sheetName: layout.sheet.getName(),
    markerCol: layout.markerCol,
    idRow: layout.idRow,
    blockCount: layout.blocks.length,
    cr00Left: layout.blocks.filter(function (b) { return b.zone === 'left' && b.ids.some(function (i) { return submitNormId_(i) === SUBMIT_TEMPLATE_ID; }); }).length,
    cr00Right: layout.blocks.filter(function (b) { return b.zone === 'right' && b.ids.some(function (i) { return submitNormId_(i) === SUBMIT_TEMPLATE_ID; }); }).length
  };
}

// ------------------------------------------------------------
// ブロック挿入
// ------------------------------------------------------------

function submitInsertBlock_(sheet, layout, p) {
  var warnings = [];
  var tpl = p.template;
  var width = tpl.width;
  var maxRows = sheet.getMaxRows();

  // テンプレ各列のグループ深度を控える（挿入後に再現。copyToではコピーされない）
  var depths = [];
  for (var c = tpl.startCol; c <= tpl.endCol; c++) {
    depths.push(sheet.getColumnGroupDepth(c + 1));
  }

  // 1. テンプレ直右に列挿入
  sheet.insertColumnsAfter(tpl.endCol + 1, width);
  var insStart = tpl.endCol + 1; // 0-indexed 挿入開始列

  // 2. テンプレ全行を書式・数式・入力規則ごとコピー
  var src = sheet.getRange(1, tpl.startCol + 1, maxRows, width);
  var dst = sheet.getRange(1, insStart + 1, maxRows, width);
  src.copyTo(dst, { contentsOnly: false });

  // 3. ID行セルを新cr名に書き換え
  var idColOffset = (tpl.idCol >= 0 ? tpl.idCol : tpl.startCol) - tpl.startCol;
  sheet.getRange(layout.idRow, insStart + 1 + idColOffset).setValue(p.id);

  // 4. メモ列2行目: 親子分類（プルダウンはcopyToで複製済み。値だけ設定）
  var memoColNew = insStart + (tpl.memoCol - tpl.startCol); // 0-indexed
  try {
    sheet.getRange(2, memoColNew + 1).setValue(p.classification);
  } catch (e) {
    warnings.push('親子分類の設定失敗(' + p.id + '): ' + e.message);
  }

  // 5. 親（子有り）は3行目の判定式をラップ（cr00テンプレが素の判定式の場合）
  if (p.classification === '親（子有り）') {
    try {
      var cell = sheet.getRange(3, memoColNew + 1);
      var f = cell.getFormula();
      if (f && f.indexOf('子にて判定') < 0) {
        var colA1 = submitColToA1_(memoColNew);
        var inner = f.replace(/^=/, '');
        cell.setFormula('=IF(' + colA1 + '2="親（子有り）","子にて判定",IF(' + colA1 + '2="その他","対象外",' + inner + '))');
      }
    } catch (e2) {
      warnings.push('判定式ラップ失敗(' + p.id + '): ' + e2.message);
    }
  }

  // 6. 列グループ化を再現（深度1のみ対応。連続する深度>0の列run単位でグループ化）
  try {
    var run = null;
    for (var i = 0; i <= depths.length; i++) {
      var d = i < depths.length ? depths[i] : 0;
      if (d > 0 && run === null) run = i;
      if ((d === 0 || i === depths.length) && run !== null) {
        var groupRange = sheet.getRange(1, insStart + 1 + run, 1, i - run);
        groupRange.shiftColumnGroupDepth(1);
        run = null;
      }
    }
  } catch (e3) {
    warnings.push('列グループ化の再作成失敗(' + p.id + '): ' + e3.message);
  }

  return {
    info: { id: p.id, zone: p.zone, startCol: insStart, width: width },
    warnings: warnings
  };
}

function submitColToA1_(colIndex0) {
  var n = colIndex0 + 1, s = '';
  while (n > 0) {
    var r = (n - 1) % 26;
    s = String.fromCharCode(65 + r) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}
