/**
 * cr入稿くん 集計表展開（独立GASプロジェクト版）v3
 * ------------------------------------------------------------
 * 停止くんの共通GASとは別の専用GASプロジェクト（submitCreative_common）として
 * デプロイする。このファイル1本で完結（doPost同梱）。
 * Workerは SUBMIT_GAS_URL でこちらを叩く。反映は「デプロイを管理 → 新バージョン」。
 *
 * 【v3で一般化した点（Notion「📊 集計表 構造仕様」2026-07-06 全21案件実測に基づく）】
 *  - 旧v2は「左端のcr00＝集計内テンプレ／右端のcr00＝集計外テンプレ」という単純な
 *    最左最右ヒューリスティックだった。しかし実測の結果、
 *      ・集計外(パターン子)ゾーンの開始マーカー文言は案件でバラバラ
 *        （集計外CR→ / 集計から除外→ / パターン替え→ / 除外→ / 集計に反映させない→）
 *      ・「認知系→」「店舗別→」「エース→」等の非パターン単独ゾーンにも
 *        予備cr00テンプレが紛れることがある
 *      ・集計内ゾーンにcr00テンプレが存在しない案件がある（hyd等）
 *      ・集計外(パターン子)ゾーン自体が存在しない案件がある（blr等）
 *    と判明したため、マーカー文言とゾーン境界を認識してcr00を選ぶ方式に変更。
 *  - 「子にて判定」を書き込む判定行(旧: 固定5行目)も案件で3〜7行目とばらつくため、
 *    テンプレのメモ列を実際にスキャンして自動検出する（見つからない場合は
 *    フォールバック値+警告を返す。書き込み前に必ずdryRunで確認すること）。
 *  - 未知のマーカー文言の案件は「見つかりません」で安全側に倒す（誤挿入より停止）。
 *    マーカー一覧は下記 SUBMIT_EXCLUDE_MARKERS / SUBMIT_NONPATTERN_MARKERS に追記していく。
 *
 * 【kk_mak 実測（2026-07-06）に基づく仕様（変わらない部分）】
 *  - クリエイティブID行 = crXX が最も多い行（kk_mak=6行目）。ID行のセルにcr名が入る。
 *  - 展開ブロック(unit) = 「cr00列 〜 次のcr-id列の直前」。
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
    if (action === 'submitCreative') {
      // 複数の/cr-inがほぼ同時に走ると（例:「すべての入稿プラン」から連続実行）、
      // 列位置の計算と挿入が交錯してブロックがズレるため、ScriptLockで直列化する
      var lock = LockService.getScriptLock();
      lock.waitLock(90 * 1000); // 先行する挿入の完了を最大90秒待つ
      try {
        return jsonOut(handleSubmitCreative(params));
      } finally {
        lock.releaseLock();
      }
    }
    if (action === 'submitUndo') return jsonOut(handleSubmitUndo(params));
    if (action === 'insertCrThumbnail') return jsonOut(handleInsertCrThumbnail(params));
    if (action === 'submitCheck') return jsonOut(handleSubmitCheck(params)); // 読み取り専用（ロック不要）
    if (action === 'listCrMissingThumbs') return jsonOut(handleListCrMissingThumbs(params)); // 読み取り専用（ロック不要）
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
var SUBMIT_CLASS_ROW = 2;               // 親子分類プルダウンの行（全案件共通・実測でブレなし）
var SUBMIT_JUDGE_ROW_FALLBACK = 5;      // 判定行が自動検出できなかった時のフォールバック
var SUBMIT_JUDGE_ROW_SCAN = [3, 4, 5, 6, 7]; // 判定行の自動検出スキャン範囲（CLASS_ROWは除く）
var SUBMIT_UNDO_KEY_PREFIX = 'submitUndo:';

// 「集計外(パターン子)ゾーン」開始マーカー。案件により文言が違うので候補を列挙（追記可）
var SUBMIT_EXCLUDE_MARKERS = ['集計外CR→', '集計から除外→', 'パターン替え→', '除外→', '集計に反映させない→', 'ナンバリング除外→', '集計除外→'];
// パターン展開の対象外にする非パターン単独ゾーン（ここに紛れ込むcr00は候補から除外）
var SUBMIT_NONPATTERN_MARKERS = [
  '認知系→', '店舗別→', '各店舗→', 'エース→', 'アドセット別→', '展示会→',
  'アーカイブ→', 'LP別→', '認知・リタゲ→', '認知・リタゲなど→', 'テスト別→', '過去テスト→',
  '訴求別→', '当たり→'
];
// 集計内(親)ゾーンの開始マーカー。除外扱いはしないが、直前の非パターンゾーンの
// 境界として認識させるために必要（これが無いと非パターンゾーンが次の除外マーカーまで
// 際限なく広がってしまい、本物のcr00まで除外してしまう）
var SUBMIT_PATTERN_START_MARKERS = ['CR別→', 'cr→', 'CR一覧→'];

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
    // 子（集計外）の重複は真の二重入稿なので中断。親（集計内）は既存でも
    // 「別パターンを後から追加」の正常ケースがある（cr83_01の次にcr83_02を入稿等）ため、
    // 親が既存のときは親ブロックの再挿入だけスキップし、子は挿入する（BUG-32）
    var dupChildren = childIds.filter(function (id) { return existing[id.toLowerCase()]; });
    if (dupChildren.length) return { ok: false, error: '既に集計表に存在します: ' + dupChildren.join(', ') + '（二重入稿防止のため中断）' };
    var parentExists = !!existing[parentId.toLowerCase()];
    if (parentExists && childIds.length === 0) {
      return { ok: false, error: '既に集計表に存在します: ' + parentId + '（二重入稿防止のため中断）' };
    }

    if (lay.cr00.left === null) {
      return { ok: false, error: '集計内(親)ゾーンの cr00 テンプレが見つかりません（この案件は要手動確認。Notion「集計表 構造仕様」の既知の罠を参照）' };
    }
    if (childIds.length && lay.cr00.right === null) {
      return { ok: false, error: '集計外(パターン子)ゾーンの cr00 テンプレが見つかりません（この案件はパターン展開非対応の可能性。親のみで入稿するか要手動確認）' };
    }
    if (childIds.length && lay.cr00.left === lay.cr00.right) {
      return { ok: false, error: 'cr00テンプレが1つしか無く親/子ゾーンを区別できません' };
    }

    var leftTpl = submitUnit_(lay, lay.cr00.left);
    var rightTpl = childIds.length ? submitUnit_(lay, lay.cr00.right) : null;

    // 「子にて判定」等を書く判定行をテンプレのメモ列から自動検出（案件で3〜7行目とばらつく）
    var judge = submitDetectJudgeRow_(sheet, leftTpl.memoCol);

    var hasChildren = childIds.length > 0;
    var plan = [];
    // 親ブロックは既存なら再挿入しない（別パターン追加時）。新規のときだけ挿入
    if (!parentExists) {
      plan.push({ tpl: leftTpl, id: parentId, cls: hasChildren ? '親（子有り）' : '親（子無し）', zone: '集計内' });
    }
    // 子は「後ろから」入れると _01,_02… が左→右の昇順で並ぶ
    for (var i = childIds.length - 1; i >= 0; i--) {
      plan.push({ tpl: rightTpl, id: childIds[i], cls: '子', zone: '集計外' });
    }

    if (req.dryRun) {
      return {
        ok: true, dryRun: true, sheetName: sheet.getName(), idRow: lay.idRow,
        zoneInfo: lay.zoneInfo,
        judgeRow: judge.row, judgeRowGuessed: judge.guessed,
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
    if (judge.guessed) warnings.push('判定行（子にて判定を書く行）を自動検出できませんでした。この案件は判定行が無い構造の可能性があるため「子にて判定」の書込はスキップします');
    plan.slice().sort(function (a, b) { return b.tpl.start - a.tpl.start; }).forEach(function (p) {
      var r = submitInsert_(sheet, lay, p, judge);
      inserted.forEach(function (rec) { if (rec.startCol >= r.startCol) rec.startCol += r.width; });
      inserted.push({ id: r.id, zone: r.zone, startCol: r.startCol, width: r.width });
      if (r.warn) warnings.push(r.warn);
    });

    // 既存の親に子を後から追加した場合、既存親の分類を「親（子有り）」に更新し判定行を子にて判定へ。
    // 子は集計外(右)に挿入され既存親(集計内・左)の列はズレないので、旧レイアウトの列で更新できる（BUG-32）
    if (parentExists && hasChildren) {
      try {
        var pc = null;
        lay.idCells.forEach(function (c) { if (c.id.toLowerCase() === parentId.toLowerCase() && pc === null) pc = c.col; });
        if (pc !== null) {
          var pTpl = submitUnit_(lay, pc);
          if (pTpl.memoCol >= 0) {
            sheet.getRange(SUBMIT_CLASS_ROW, pTpl.memoCol + 1).setValue('親（子有り）');
            // 判定行未検出の案件ではフォールバック行への書込をしない（既存データ破壊防止。BUG-68）
            if (!judge.guessed) {
              var pjc = sheet.getRange(judge.row, pTpl.memoCol + 1);
              if (String(pjc.getValue()).indexOf('子にて判定') < 0) pjc.setValue('子にて判定');
            }
          }
        }
      } catch (eu) { warnings.push('既存親の分類更新に失敗: ' + eu.message); }
    }

    PropertiesService.getScriptProperties().setProperty(
      SUBMIT_UNDO_KEY_PREFIX + req.spreadsheetId + ':' + parentId.toLowerCase(),
      JSON.stringify({ sheetName: sheet.getName(), inserted: inserted, at: new Date().toISOString() })
    );
    // 挿入先の列をA1表記でも返す（BUG-125）。「cr00の直右に入ったか」を後から検証できるようにし、
    // 手動で追加されたブロックに押し出された場合と、ツールの挿入位置ズレを切り分ける。
    return {
      ok: true, sheetName: sheet.getName(), warnings: warnings,
      inserted: inserted.map(function (x) {
        return { id: x.id, zone: x.zone, startCol: x.startCol, startColA1: submitColA1_(x.startCol), width: x.width };
      }),
    };
  } catch (e) {
    return { ok: false, error: String(e && e.message ? e.message : e) };
  }
}

// ------------------------------------------------------------
// crの冒頭サムネ（0:01フレーム）を該当ブロックのセルに「セル内画像」で挿入する（BUG-34）。
// 画像は imageBase64（推奨。GitHub Actions + ffmpeg が抽出したJPGのbase64）か、
// imageUrl（公開URL）のどちらかで渡す。base64は data:URL にして CellImage を構築する
// （サービスアカウントはDriveストレージ容量を持たず公開URL化ができないため、
//  base64直渡し方式を正とする）。
// 挿入先は「cr名(ID)セルの右にある結合セル（サムネ表示用に拡大結合されている）」。
// 案件により列位置が異なるため、ブロック内のcr名より右で最大面積の結合セルを自動選択する。
// req: { spreadsheetId, sheetName?, id, imageBase64?, mimeType?, imageUrl? }
// ------------------------------------------------------------
function handleInsertCrThumbnail(req) {
  try {
    var id = String(req.id || '').trim();
    if (!id) return { ok: false, error: 'id が必要です' };
    if (!req.imageBase64 && !req.imageUrl) return { ok: false, error: 'imageBase64 か imageUrl が必要です' };
    var ss = SpreadsheetApp.openById(req.spreadsheetId);
    var sheet = submitResolveSheet_(ss, req.sheetName);
    var lay = submitLayout_(sheet);
    var idCol = -1;
    lay.idCells.forEach(function (c) { if (c.id.toLowerCase() === id.toLowerCase() && idCol < 0) idCol = c.col; });
    if (idCol < 0) return { ok: false, error: '集計表に「' + id + '」が見つかりません' };

    var unit = submitUnit_(lay, idCol);
    var pos = submitThumbTargetPos_(sheet, lay, idCol, submitMergeInfos_(sheet, unit.start, unit.width));
    var target = sheet.getRange(pos.row, pos.col0 + 1);

    // base64直渡し（推奨）は data:URL、公開URL渡しはそのまま setSourceUrl に渡す
    var srcUrl = req.imageBase64
      ? 'data:' + (req.mimeType || 'image/jpeg') + ';base64,' + String(req.imageBase64)
      : String(req.imageUrl);
    var img = SpreadsheetApp.newCellImage()
      .setSourceUrl(srcUrl)
      .setAltTextTitle(id + ' 冒頭サムネ(0:01)')
      .build();
    target.setValue(img);
    return { ok: true, id: id, cell: submitColA1_(pos.col0) + pos.row, merged: pos.merged };
  } catch (e) {
    return { ok: false, error: String(e && e.message ? e.message : e) };
  }
}

// サムネ表示セルを探す行範囲（BUG-126）。サムネ用の結合セルはID行(1〜8行目)の周辺＝
// ヘッダー帯にしか存在しない。にもかかわらず maxRows（kk_makは1100行超）まで結合レンジを
// 取得すると、日次・月次データ領域の結合セルまで数千件読み込むことになり、これ自体が
// 15秒の走査予算を食い潰して「1ブロックも走査できないまま nextStart=0 を返す」状態に
// なっていた（＝再実行しても永久に先へ進まず「未挿入なし」と誤表示される原因）。
// ヘッダー帯だけに絞ることで高速化し、同時にデータ領域の巨大な結合セルを
// 「最大面積の結合セル」として誤選択する事故も防ぐ。
var SUBMIT_THUMB_HEADER_ROWS = 40;

// 結合レンジを「プレーンなJSオブジェクトの配列」にして返す（BUG-126）。
// Rangeオブジェクトのまま各ブロックで走査すると getColumn()/getNumRows() 等の
// Apps Script呼び出しが (ブロック数 × 結合セル数 × 3) 回発生し、kk_mak規模
// （2190列・140ブロック）では数十万回に達して25秒のWorkerタイムアウトを超える。
// 変換は結合セル数ぶんの1パスだけ行い、以降の判定は純JSで済ませる。
// 行はヘッダー帯（SUBMIT_THUMB_HEADER_ROWS行）に限定する。startCol0/width 省略時は全列。
function submitMergeInfos_(sheet, startCol0, width) {
  var rows = Math.min(SUBMIT_THUMB_HEADER_ROWS, sheet.getMaxRows());
  var rng = (startCol0 === undefined || startCol0 === null)
    ? sheet.getRange(1, 1, rows, sheet.getLastColumn())
    : sheet.getRange(1, startCol0 + 1, rows, width);
  return rng.getMergedRanges().map(function (m) {
    return { row: m.getRow(), col0: m.getColumn() - 1, area: m.getNumRows() * m.getNumColumns() };
  });
}

// サムネ表示セルの位置（row=1-indexed / col0=0-indexed）。cr名より右・ブロック列範囲内で
// 最大面積の結合セルを採用する。結合セルが無いブロックは10列右にフォールバック（merged:false）。
// mergeInfos は submitMergeInfos_ の戻り値（プレーンオブジェクト配列）。
function submitThumbTargetPos_(sheet, lay, idCol, mergeInfos) {
  var unit = submitUnit_(lay, idCol);
  var best = null;
  for (var i = 0; i < mergeInfos.length; i++) {
    var m = mergeInfos[i];
    if (m.col0 <= idCol || m.col0 < unit.start || m.col0 > unit.end) continue;
    if (!best || m.area > best.area) best = m;
  }
  if (best) return { row: best.row, col0: best.col0, merged: true };
  return { row: lay.idRow, col0: Math.min(idCol + 10, sheet.getMaxColumns() - 1), merged: false };
}

// 1回の listCrMissingThumbs で使う時間の上限（ms）。Worker側のGAS応答待ちは25秒で打ち切られ、
// 超えると「GAS応答待ちタイムアウト」になる（BUG-126）。余裕を持って切り上げ、続きは nextStart で返す。
var SUBMIT_THUMB_SCAN_BUDGET_MS = 15000;

// ------------------------------------------------------------
// サムネ未挿入crの列挙（BUG-122の後追いクローリング用・読み取り専用）。最新目印: nextStart
// ID行の各crブロックについて、サムネ表示セルにセル内画像(CellImage)が入っているかを確認し、
// 入っていないidを返す。Workerはこの結果に対しMeta動画サムネを後追い挿入する。
// 結合セルが無いブロックはサムネ表示セルを確実に特定できないため対象外（データセルへの
// 誤挿入を防ぐ安全側の判断。insertCrThumbnailの個別指定なら従来どおりフォールバック挿入可）。
// 巨大シート（kk_mak=2190列/140ブロック）でも時間内に返せるよう、結合セルはプレーン化して
// 1パスで扱い、時間超過時は scanned/nextStart を返して打ち切る（再実行で続きから）。
// req: { spreadsheetId, sheetName?, start? }
// ------------------------------------------------------------
function handleListCrMissingThumbs(req) {
  try {
    var started = new Date().getTime();
    var ss = SpreadsheetApp.openById(req.spreadsheetId);
    var sheet = submitResolveSheet_(ss, req.sheetName);
    var lay = submitLayout_(sheet);
    var blocks = [];
    lay.idCells.forEach(function (c) {
      if (!/^cr\d+/i.test(c.id)) return;
      if (c.id.toLowerCase() === SUBMIT_TEMPLATE_ID) return; // cr00テンプレは対象外
      blocks.push(c);
    });
    var mergeInfos = submitMergeInfos_(sheet); // 全面を1回だけプレーン化
    var start = Math.max(0, Number(req.start || 0));
    var missing = [], skipped = 0, i = start, nextStart = null;
    for (; i < blocks.length; i++) {
      // 予算切れで打ち切る。ただし「1ブロックも進まないまま同じ位置を返す」と再実行しても
      // 永久に前進しないため、最低1ブロックは必ず走査する（i > start の条件。BUG-126）。
      if (i > start && new Date().getTime() - started > SUBMIT_THUMB_SCAN_BUDGET_MS) { nextStart = i; break; }
      var pos = submitThumbTargetPos_(sheet, lay, blocks[i].col, mergeInfos);
      if (!pos.merged) { skipped++; continue; } // 結合セル無し＝表示セル不明のためスキップ（安全側）
      if (!submitIsCellImage_(sheet.getRange(pos.row, pos.col0 + 1).getValue())) missing.push(blocks[i].id);
    }
    return {
      ok: true, missing: missing, total: blocks.length,
      scanned: i - start, skippedNoMergedCell: skipped, nextStart: nextStart,
      elapsedMs: new Date().getTime() - started,
    };
  } catch (e) {
    return { ok: false, error: String(e && e.message ? e.message : e) };
  }
}

/** セル値がセル内画像(CellImage)か。Dateも object なので明示除外する */
function submitIsCellImage_(v) {
  if (!v || typeof v !== 'object' || v instanceof Date) return false;
  if (typeof v.getContentUrl === 'function' || typeof v.getUrl === 'function') return true;
  return String(v).indexOf('CellImage') !== -1;
}

// ------------------------------------------------------------
// 集計表への反映確認（BUG-95）。submitCreativeがWorker側でタイムアウトした後に、
// ID行に指定crが実際に現れたかを読み取り専用でチェックする（挿入はしない）。
// 巨大シートではsubmitCreativeが25秒を超えても正常完了するため、Workerはこれを
// ポーリングして「成功」を確定させる。ロックは取らない（実行中のsubmitと並行可）。
// req: { spreadsheetId, sheetName?, ids: ["cr83","cr83_01",...] }
// ------------------------------------------------------------
function handleSubmitCheck(req) {
  try {
    var ids = (req.ids || []).map(function (s) { return String(s).trim(); }).filter(String);
    if (!ids.length) return { ok: false, error: 'ids が必要です' };
    var ss = SpreadsheetApp.openById(req.spreadsheetId);
    var sheet = submitResolveSheet_(ss, req.sheetName);
    var lay = submitLayout_(sheet);
    var have = {};
    lay.idCells.forEach(function (c) { have[c.id.toLowerCase()] = true; });
    var existing = [], missing = [];
    ids.forEach(function (id) { (have[id.toLowerCase()] ? existing : missing).push(id); });
    return { ok: true, existing: existing, missing: missing };
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

/** ID行・ID行のcrセル一覧・ゾーン別cr00列・1行目ヘッダーを返す */
function submitLayout_(sheet) {
  var lastCol = sheet.getLastColumn();
  var head = sheet.getRange(1, 1, Math.min(SUBMIT_ID_ROW_SEARCH_MAX, sheet.getMaxRows()), lastCol).getDisplayValues();
  var row1 = head[0];

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

  // マーカー走査: 1行目のセルを「集計外開始」「非パターンゾーン開始」に分類
  var markers = [];
  for (var mc = 0; mc < row1.length; mc++) {
    var mv = String(row1[mc] || '').trim();
    if (!mv) continue;
    if (SUBMIT_EXCLUDE_MARKERS.indexOf(mv) >= 0) markers.push({ col: mc, type: 'exclude', text: mv });
    else if (SUBMIT_NONPATTERN_MARKERS.indexOf(mv) >= 0) markers.push({ col: mc, type: 'nonpattern', text: mv });
    else if (SUBMIT_PATTERN_START_MARKERS.indexOf(mv) >= 0) markers.push({ col: mc, type: 'patternstart', text: mv });
  }
  markers.sort(function (a, b) { return a.col - b.col; });

  // ゾーンの境界は「1行目の“→”で終わる全マーカー」で取る（BUG-144）。
  // 以前は上で分類できた既知マーカーだけを境界にしていたため、未知の文言
  // （jdem の「当たりcr→」「追加CR→」「停止CR→」「認知→」等）が境界として効かず、
  // 非パターンゾーン（訴求別→ col39）が次の既知マーカー＝集計外CR→(col1894) まで
  // 際限なく広がり、集計内の本物の cr00（col96台 / 1762）を両方とも除外して
  // 「集計内(親)ゾーンの cr00 テンプレが見つかりません」になっていた。
  // 文言を都度リストへ足す運用では取りこぼすため、境界判定は文言に依存させない。
  var arrowCols = [];
  for (var ac = 0; ac < row1.length; ac++) {
    var av = String(row1[ac] || '').trim();
    if (av && av.charAt(av.length - 1) === '→') arrowCols.push(ac);
  }
  function nextArrowColAfter(col) {
    for (var i = 0; i < arrowCols.length; i++) if (arrowCols[i] > col) return arrowCols[i];
    return Infinity;
  }

  // 非パターンゾーンの除外レンジ（そのマーカー列 〜 次の“→”マーカー列の直前 or 末尾）
  var excludedRanges = [];
  markers.forEach(function (m) {
    if (m.type !== 'nonpattern') return;
    excludedRanges.push([m.col, nextArrowColAfter(m.col)]);
  });
  function isExcludedCol(col) {
    return excludedRanges.some(function (rg) { return col >= rg[0] && col < rg[1]; });
  }
  var excludeMarkerCols = markers.filter(function (m) { return m.type === 'exclude'; }).map(function (m) { return m.col; });
  var excludeZoneStartCol = excludeMarkerCols.length ? Math.min.apply(null, excludeMarkerCols) : null;

  // 集計内(親)ゾーンの開始マーカー（CR別→ 等）が実在する案件では、そこが集計内ゾーンの
  // 先頭なので、それより左のcr00は集計内候補にしない（BUG-144の副作用対策）。
  // 上の“→”境界化だけだと、未知文言の非パターンゾーン（nrn の「新規開業→」「赤字改善→」等）
  // に紛れたcr00が候補に浮上して誤ったブロックへ挿入されてしまうため。
  var patternStartCols = markers
    .filter(function (m) {
      return m.type === 'patternstart' && (excludeZoneStartCol === null || m.col < excludeZoneStartCol);
    })
    .map(function (m) { return m.col; });
  var mainZoneStartCol = patternStartCols.length ? Math.min.apply(null, patternStartCols) : null;

  var cr00Candidates = idCells
    .filter(function (x) { return x.id.toLowerCase() === SUBMIT_TEMPLATE_ID; })
    .map(function (x) { return x.col; })
    .sort(function (a, b) { return a - b; });

  var leftCandidates = cr00Candidates.filter(function (col) {
    if (mainZoneStartCol !== null && col < mainZoneStartCol) return false;
    return (excludeZoneStartCol === null || col < excludeZoneStartCol) && !isExcludedCol(col);
  });
  var rightCandidates = excludeZoneStartCol === null ? [] : cr00Candidates.filter(function (col) {
    return col >= excludeZoneStartCol && !isExcludedCol(col);
  });

  return {
    idRow: idRow, idCells: idCells, row1: row1,
    cr00: { left: leftCandidates.length ? leftCandidates[0] : null, right: rightCandidates.length ? rightCandidates[0] : null },
    lastCol: lastCol,
    zoneInfo: {
      markers: markers.map(function (m) { return { col: m.col, colA1: submitColA1_(m.col), type: m.type, text: m.text }; }),
      excludeZoneStartCol: excludeZoneStartCol === null ? null : excludeZoneStartCol,
      excludeZoneStartColA1: excludeZoneStartCol === null ? null : submitColA1_(excludeZoneStartCol),
    },
  };
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

/**
 * 「子にて判定」を書き込む判定行を自動検出する。
 * メモ列(0-indexed)の候補行を数式(data!M参照)→表示文言の順にスキャンし、
 * 最初に一致した行を採用。見つからなければフォールバック値+guessed:trueを返す。
 */
function submitDetectJudgeRow_(sheet, memoCol0) {
  if (memoCol0 < 0) return { row: SUBMIT_JUDGE_ROW_FALLBACK, guessed: true };
  var col1 = memoCol0 + 1;
  var phraseRe = /停止済|即?停止\?|[0-9]\s*[~〜]\s*[0-9.]+\s*倍|子にて判定|対象外/;
  for (var i = 0; i < SUBMIT_JUDGE_ROW_SCAN.length; i++) {
    var row = SUBMIT_JUDGE_ROW_SCAN[i];
    if (row === SUBMIT_CLASS_ROW) continue;
    var cell = sheet.getRange(row, col1);
    var formula = '';
    try { formula = cell.getFormula() || ''; } catch (e) { formula = ''; }
    if (/data!\$?M/i.test(formula)) return { row: row, guessed: false };
    var val = String(cell.getDisplayValue() || '').trim();
    if (val && phraseRe.test(val)) return { row: row, guessed: false };
  }
  return { row: SUBMIT_JUDGE_ROW_FALLBACK, guessed: true };
}

// ------------------------------------------------------------
// ブロック挿入（cr00 unit を直右に複製 → ID/分類/判定/グループ化を設定）
// ------------------------------------------------------------
/** judgeRow: submitDetectJudgeRow_の戻り値 {row, guessed}。guessed=trueなら子にて判定は書かない */
function submitInsert_(sheet, lay, p, judgeRow) {
  var tpl = p.tpl, width = tpl.width, maxRows = sheet.getMaxRows(), warn = '';

  // グループ深度を控える（copyToでは複製されないため後で再現）
  var depths = [];
  for (var c = tpl.start; c <= tpl.end; c++) depths.push(sheet.getColumnGroupDepth(c + 1));

  // cr00 unit の直右に width 列挿入し、cr00 unit を書式・数式・入力規則ごと複製
  sheet.insertColumnsAfter(tpl.end + 1, width);
  var insStart = tpl.end + 1; // 0-indexed
  sheet.getRange(1, tpl.start + 1, maxRows, width)
    .copyTo(sheet.getRange(1, insStart + 1, maxRows, width), { contentsOnly: false });

  // 列幅を明示的にコピー（BUG-30）: insertColumnsAfterの新列は挿入位置の列
  // （unit末尾＝細いスペーサー列のことがある）の幅を引き継ぎ、copyToは列幅を複製しない。
  // 1列ずつsetColumnWidthすると巨大シートで遅く「集計表展開中」で停止する(BUG-32)ため、
  // テンプレ幅をまとめて読み、連続する同一幅はsetColumnWidthsで一括転写して呼び出し回数を減らす。
  try {
    var widths = [];
    for (var wc = 0; wc < width; wc++) widths.push(sheet.getColumnWidth(tpl.start + 1 + wc));
    var runStart = 0;
    for (var wi = 1; wi <= width; wi++) {
      if (wi === width || widths[wi] !== widths[runStart]) {
        sheet.setColumnWidths(insStart + 1 + runStart, wi - runStart, widths[runStart]);
        runStart = wi;
      }
    }
  } catch (ew) { warn += '列幅コピー失敗:' + ew.message + ' '; }

  // ID行の先頭列にcr名を書く
  sheet.getRange(lay.idRow, insStart + 1).setValue(p.id);

  // 親子分類（row2, メモ列）＋ 親（子有り）は判定行を子にて判定に
  if (tpl.memoCol >= 0) {
    var memoNew = insStart + (tpl.memoCol - tpl.start);
    try {
      var clsCell = sheet.getRange(SUBMIT_CLASS_ROW, memoNew + 1);
      clsCell.setValue(p.cls);
      // 読み戻し検証（BUG-68）: 入力規則のreject等で無言で設定されないケースを警告として可視化する
      var clsGot = String(clsCell.getDisplayValue() || '').trim();
      if (clsGot !== p.cls) {
        warn += '分類プルダウン未反映(' + p.id + '): 「' + p.cls + '」を設定したが表示は「' + clsGot + '」。手動確認要 ';
      }
      if (p.cls === '親（子有り）') {
        // 判定行が自動検出できなかった案件（nrn等、「子にて判定」行の無い構造）では
        // フォールバック行に書くと既存データ（通電%等）を壊すため、書き込まない（BUG-68）
        if (judgeRow && judgeRow.guessed) {
          warn += '判定行が特定できないため「子にて判定」は未設定(' + p.id + ')。必要なら手動設定を ';
        } else {
          var jrow = judgeRow ? judgeRow.row : SUBMIT_JUDGE_ROW_FALLBACK;
          var jc = sheet.getRange(jrow, memoNew + 1);
          if (String(jc.getValue()).indexOf('子にて判定') < 0) jc.setValue('子にて判定');
        }
      }
    } catch (e) { warn += '分類設定失敗(' + p.id + '):' + e.message + ' '; }
  }

  // 列グループ化を再現（深度1のrun単位）し、作成後は折りたたむ（BUG-32: 解放ではなく閉じる）
  try {
    var run = null;
    for (var i = 0; i <= depths.length; i++) {
      var d = i < depths.length ? depths[i] : 0;
      if (d > 0 && run === null) run = i;
      if ((d === 0 || i === depths.length) && run !== null) {
        var grpRange = sheet.getRange(1, insStart + 1 + run, 1, i - run);
        grpRange.shiftColumnGroupDepth(1);
        grpRange.collapseGroups(); // 追加ブロックのグループは閉じた状態にする（山田要望 BUG-32）
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
