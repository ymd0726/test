// ツール別チェッカー（TOOL-40）
//
// 拡張手順: 新ツールは (1) 実行時に統一ログDBへ書く (2) ここに checker を1つ足す、の2点のみ。
// checker は run 1件を検証して CheckItem[] を返す（throwしたら orchestrator が「チェック失敗」として扱う）。

import type { CheckContext, CheckItem, RunLogRecord } from "./types";
import { batchAdInfo } from "./meta";
import { sheetsToken, resolveTab, readRows, findCrColumn, checkStopMarks } from "./sheets";

export interface Checker {
  check(run: RunLogRecord, ctx: CheckContext): Promise<CheckItem[]>;
}

export const CHECKERS: Record<string, Checker> = {
  "cr停止くん": { check: checkCrStop },
  "cr入稿くん": { check: checkCrSubmit },
};

// ============================================================
// 共通: run自体の整合（全ツール共通の前提チェック）
// ============================================================
function checkRunIntegrity(run: RunLogRecord): CheckItem[] {
  const items: CheckItem[] = [];
  if (run.status === "実行中") {
    items.push({
      key: "run_incomplete",
      label: "実行が完了していない（実行中のまま）",
      status: "NG",
      severity: "高",
      message: `実行ログのステータスが「実行中」のまま残っています。処理が途中で停止した可能性があります（各システムの実態を確認してください）`,
      expected: "完了",
      actual: run.status,
    });
  } else if (run.status === "失敗") {
    items.push({
      key: "run_failed",
      label: "実行がエラーで失敗している",
      status: "NG",
      severity: "高",
      message: `実行ログのステータスが「失敗」です${run.detail?.lastError ? `（${String(run.detail.lastError).slice(0, 300)}）` : ""}`,
      expected: "完了",
      actual: run.status,
    });
  }
  return items;
}

// ============================================================
// cr停止くん（停止 / 取消）
// ============================================================
async function checkCrStop(run: RunLogRecord, ctx: CheckContext): Promise<CheckItem[]> {
  const items: CheckItem[] = [...checkRunIntegrity(run)];
  const isUndo = run.action === "取消";

  // S1: Meta広告が実際に PAUSED（取消なら ACTIVE 復帰）か
  if (!ctx.metaToken || !ctx.project?.metaAdAccountId) {
    items.push({ key: "meta_status", label: "Meta状態確認", status: "SKIP", severity: "低", message: "Meta未連携の案件" });
  } else if (run.adIds.length === 0) {
    if (run.metaResult === "成功") {
      // 停止したはずなのに広告IDが未記録（旧バージョンのログ等）
      items.push({ key: "meta_status", label: "Meta状態確認", status: "WARN", severity: "低", message: "広告IDが未記録のためMeta実態は未確認（ログ形式が古い可能性）" });
    } else {
      items.push({ key: "meta_status", label: "Meta状態確認", status: "SKIP", severity: "低", message: "Meta対象なしのrun（集計表のみ記録）" });
    }
  } else {
    const infos = await batchAdInfo(ctx.metaToken, run.adIds);
    const missing = run.adIds.filter((id) => !infos.has(id));
    const expectStatus = isUndo ? "ACTIVE" : "PAUSED";
    const wrong = [...infos.values()].filter((a) => a.status !== expectStatus);
    if (wrong.length > 0) {
      const stillDelivering = wrong.filter((a) => a.effectiveStatus === "ACTIVE");
      items.push({
        key: isUndo ? "meta_ad_not_resumed" : "meta_ad_still_active",
        label: isUndo ? "Meta広告が再開されていない" : "Meta広告が停止されていない",
        status: "NG",
        severity: stillDelivering.length > 0 || !isUndo ? "高" : "中",
        message: `${wrong.map((a) => `${a.name}(status=${a.status}/effective=${a.effectiveStatus})`).join(", ")}`,
        expected: { status: expectStatus },
        actual: wrong.map((a) => ({ id: a.id, status: a.status, effective_status: a.effectiveStatus })),
      });
    } else {
      items.push({ key: "meta_status", label: `Meta広告 ${expectStatus === "PAUSED" ? "停止" : "再開"}確認`, status: "OK", severity: "低" });
    }
    if (missing.length > 0) {
      items.push({
        key: "meta_ad_missing",
        label: "Meta広告が見つからない（削除済み？）",
        status: "WARN",
        severity: "中",
        message: `広告ID ${missing.join(", ")} がMetaで取得できません`,
        actual: { missing },
      });
    }
  }

  // S2: 集計表の停止マーク（チェックON・グレー塗り）。取消は「グレーが残っていない」ことを確認。
  // 実行時に「失敗」と記録されていても実物を照合する（GASタイムアウト後に完了しているケースがあるため、
  // ログではなく実態で判定する）。実物も欠けていれば下のcr列/チェック/グレー判定が拾う。
  const sheetWriteFailed = run.sheetResult === "失敗";
  if (run.sheetResult === "対象なし") {
    items.push({ key: "sheet_marks", label: "集計表確認", status: "SKIP", severity: "低", message: "実行時に集計表対象なし" });
  } else if (!ctx.env.GOOGLE_SERVICE_ACCOUNT_JSON || !ctx.project) {
    items.push(
      sheetWriteFailed
        ? { key: "sheet_write_failed", label: "集計表の記録が失敗したまま", status: "NG", severity: "中", message: "実行時に集計表への記録が失敗しています（実物の照合もできないため要手動確認）" }
        : { key: "sheet_marks", label: "集計表確認", status: "SKIP", severity: "低", message: "Sheets読み取り設定なし" }
    );
  } else {
    const target = await pickSheetTarget(ctx, run);
    if (!target) {
      items.push({ key: "sheet_marks", label: "集計表確認", status: "WARN", severity: "低", message: "対象タブを特定できずスキップ" });
    } else {
      const token = await sheetsToken(ctx.env.GOOGLE_SERVICE_ACCOUNT_JSON);
      const marks = await checkStopMarks(token, target.spreadsheetId, target.tab, run.crName);
      if (!marks.found) {
        items.push({
          key: "sheet_cr_missing",
          label: "集計表にcr列が見つからない",
          status: isUndo ? "WARN" : "NG",
          severity: "中",
          message: `タブ「${target.tab}」の1〜8行に ${run.crName} が見つかりません`,
          expected: { tab: target.tab, cr: run.crName },
        });
      } else if (!marks.blockResolved) {
        items.push({ key: "sheet_marks", label: "集計表確認", status: "WARN", severity: "低", message: marks.note });
      } else if (isUndo) {
        // 取消: グレーが残っていたら復元漏れ
        if (marks.grayed) {
          items.push({
            key: "sheet_gray_remains",
            label: "集計表のグレー塗りが残っている（取消の復元漏れ）",
            status: "WARN",
            severity: "低",
            message: `タブ「${target.tab}」の ${run.crName} ブロックにグレー塗りが残っています`,
          });
        } else {
          items.push({ key: "sheet_marks", label: "集計表 復元確認", status: "OK", severity: "低" });
        }
      } else {
        // 停止: チェックON＋グレー
        if (!marks.checkboxOn) {
          items.push({
            key: "sheet_checkbox_off",
            label: "集計表の停止チェックが入っていない",
            status: "NG",
            severity: "中",
            message: `タブ「${target.tab}」の ${run.crName} メモ列のチェックボックスがOFFです`,
            expected: { checkbox: true },
            actual: { checkbox: false, tab: target.tab },
          });
        }
        if (!marks.grayed) {
          items.push({
            key: "sheet_gray_missing",
            label: "集計表のグレー塗りがされていない",
            status: marks.note ? "WARN" : "NG",
            severity: "中",
            message: marks.note || `タブ「${target.tab}」の ${run.crName} ブロックがグレー化されていません`,
            expected: { gray: "#999999" },
          });
        }
        if (marks.checkboxOn && marks.grayed) {
          items.push({ key: "sheet_marks", label: "集計表 停止マーク確認", status: "OK", severity: "低" });
        }
      }
    }
  }

  return items;
}

// ============================================================
// cr入稿くん（入稿）
// ============================================================
async function checkCrSubmit(run: RunLogRecord, ctx: CheckContext): Promise<CheckItem[]> {
  const items: CheckItem[] = [...checkRunIntegrity(run)];

  // I1/I2: Meta広告が存在しON（v1.16 一気通貫ON後の実態）＋上位のON状態
  if (!ctx.metaToken) {
    items.push({ key: "meta_ad_active", label: "Meta状態確認", status: "SKIP", severity: "低", message: "Metaトークンなし" });
  } else if (run.adIds.length === 0) {
    items.push({
      key: "meta_ad_missing",
      label: "作成された広告IDが記録されていない",
      status: run.status === "完了" ? "NG" : "WARN",
      severity: "高",
      message: "入稿runなのにMeta広告IDがログにありません（広告が作成されていない可能性）",
    });
  } else {
    const infos = await batchAdInfo(ctx.metaToken, run.adIds);
    const missing = run.adIds.filter((id) => !infos.has(id));
    if (missing.length > 0) {
      items.push({
        key: "meta_ad_missing",
        label: "入稿したはずのMeta広告が存在しない",
        status: "NG",
        severity: "高",
        message: `広告ID ${missing.join(", ")} がMetaで見つかりません（削除された可能性）`,
        actual: { missing },
      });
    }
    const paused = [...infos.values()].filter((a) => a.status !== "ACTIVE");
    if (paused.length > 0) {
      items.push({
        key: "meta_ad_not_on",
        label: "Meta広告がONになっていない",
        status: "NG",
        severity: "高",
        message: `${paused.map((a) => `${a.name}(status=${a.status})`).join(", ")}（一気通貫ONが完了していません）`,
        expected: { status: "ACTIVE" },
        actual: paused.map((a) => ({ id: a.id, status: a.status })),
      });
    }
    // I2: 上位（adset/campaign）がOFFのままなら警告（仕様上auto-ONしないため）
    const offParents = [...infos.values()].filter(
      (a) => (a.adsetStatus && a.adsetStatus !== "ACTIVE") || (a.campaignStatus && a.campaignStatus !== "ACTIVE")
    );
    if (offParents.length > 0) {
      const seen = new Set<string>();
      const desc = offParents
        .filter((a) => { const k = a.adsetId || a.id; if (seen.has(k)) return false; seen.add(k); return true; })
        .map((a) => `${a.campaignStatus !== "ACTIVE" ? `cp「${a.campaignName}」` : ""}${a.adsetStatus !== "ACTIVE" ? `adset「${a.adsetName}」` : ""}（OFF）`)
        .join(" / ");
      items.push({
        key: "meta_parent_off",
        label: "上位（広告セット/キャンペーン）が停止中で配信されない",
        status: "WARN",
        severity: "中",
        message: `${desc}。このままでは配信されません（意図的なら対応不要）`,
      });
    }
    if (missing.length === 0 && paused.length === 0) {
      items.push({ key: "meta_ad_active", label: "Meta広告 作成・ON確認", status: "OK", severity: "低" });
    }
  }

  // I3: 集計表にCRブロックが展開されているか（親crキー＋パターン子）。
  // 実行時に「失敗」記録でも実物を照合する（GASタイムアウト後に完了するケースがあるため）
  const submitSheetFailed = run.sheetResult === "失敗";
  if (!ctx.env.GOOGLE_SERVICE_ACCOUNT_JSON || !ctx.project) {
    items.push(
      submitSheetFailed
        ? { key: "sheet_write_failed", label: "集計表のCRブロック展開が失敗したまま", status: "NG", severity: "中", message: "実行時に集計表への展開が失敗しています（実物の照合もできないため要手動確認）" }
        : { key: "sheet_block", label: "集計表確認", status: "SKIP", severity: "低", message: "Sheets読み取り設定なし" }
    );
  } else {
    const target = await pickSheetTarget(ctx, run);
    if (!target) {
      items.push({ key: "sheet_block", label: "集計表確認", status: "WARN", severity: "低", message: "対象タブを特定できずスキップ" });
    } else {
      const token = await sheetsToken(ctx.env.GOOGLE_SERVICE_ACCOUNT_JSON);
      const headerRows = await readRows(token, target.spreadsheetId, target.tab, "1:8");
      // 親は cr番号のみ（BUG-32）。詳細JSONに記録があればそれを使い、無ければcr名から抽出
      const parentId: string = run.detail?.parentSheetId || (run.crName.match(/cr\d+/i)?.[0] ?? run.crName).toLowerCase();
      const childIds: string[] = Array.isArray(run.detail?.childSheetIds) ? run.detail.childSheetIds : [];
      const missing: string[] = [];
      if (findCrColumn(headerRows, parentId) === -1) missing.push(parentId);
      for (const cid of childIds) if (findCrColumn(headerRows, cid) === -1) missing.push(cid);
      if (missing.length > 0) {
        items.push({
          key: "sheet_block_missing",
          label: "集計表にCRブロックが見つからない",
          status: "NG",
          severity: "中",
          message: `タブ「${target.tab}」に ${missing.join(", ")} の列が見つかりません${submitSheetFailed ? "（実行時も展開失敗の記録あり。手動での追加が必要）" : ""}`,
          expected: { tab: target.tab, ids: [parentId, ...childIds] },
          actual: { missing },
        });
      } else {
        items.push({
          key: "sheet_block",
          label: "集計表 CRブロック確認",
          status: "OK",
          severity: "低",
          message: submitSheetFailed ? "実行時ログは失敗だが実物は存在（GASタイムアウト後に完了した可能性）" : undefined,
        });
      }
    }
  }

  // I4: Notion CRページのステータス=入稿済み
  if (!run.notionCrPageId) {
    items.push({ key: "notion_status", label: "Notionステータス確認", status: "SKIP", severity: "低", message: "CRページID未記録（URL直指定なし等）" });
  } else if (ctx.env.NOTION_TOKEN) {
    try {
      const page = await notionGetPage(ctx.env.NOTION_TOKEN, run.notionCrPageId);
      const st = page.properties?.["ステータス"];
      const name = st?.status?.name || st?.select?.name || "";
      if (name === "入稿済み") {
        items.push({ key: "notion_status", label: "Notionステータス確認", status: "OK", severity: "低" });
      } else {
        items.push({
          key: "notion_status_not_submitted",
          label: "NotionCRページが「入稿済み」になっていない",
          status: "NG",
          severity: "中",
          message: `現在のステータス: ${name || "(未設定/プロパティなし)"}`,
          expected: "入稿済み",
          actual: name,
        });
      }
    } catch (e: any) {
      items.push({ key: "notion_status", label: "Notionステータス確認", status: "WARN", severity: "低", message: `取得失敗: ${e.message}` });
    }
  }

  // I5: 集計表のセル内スクショ（BUG-34基盤）は Phase 2（Sheets APIでセル内画像を読めないためGAS拡張が必要）
  items.push({ key: "sheet_screenshot", label: "集計表スクショ貼付確認", status: "SKIP", severity: "低", message: "Phase 2で対応予定" });

  return items;
}

// ============================================================
// helpers
// ============================================================

/** runの集計表タブ記録とPROJECTS設定から対象（spreadsheetId+タブ）を決める */
async function pickSheetTarget(
  ctx: CheckContext,
  run: RunLogRecord
): Promise<{ spreadsheetId: string; tab: string } | null> {
  const p = ctx.project!;
  const recorded = run.sheetTabs[0];
  // 記録されたタブ名がPROJECTSのどれかと一致すればそれ
  for (const s of p.sheets) {
    if (recorded && s.sheetName === recorded) return { spreadsheetId: s.spreadsheetId, tab: recorded };
  }
  // 単一シート案件: タブ名が未記録でも spreadsheetId は確定 → タブは実測 or meta_total
  if (p.sheets.length === 1) {
    const s = p.sheets[0];
    if (recorded) return { spreadsheetId: s.spreadsheetId, tab: recorded };
    if (s.sheetName) return { spreadsheetId: s.spreadsheetId, tab: s.sheetName };
    if (!ctx.env.GOOGLE_SERVICE_ACCOUNT_JSON) return null;
    const token = await sheetsToken(ctx.env.GOOGLE_SERVICE_ACCOUNT_JSON);
    const tab = await resolveTab(token, s.spreadsheetId);
    return tab ? { spreadsheetId: s.spreadsheetId, tab } : null;
  }
  // 複数シート案件でタブ記録なし → 特定不能（呼び元でWARN表示）
  return null;
}

async function notionGetPage(token: string, pageIdOrUrl: string): Promise<any> {
  const m = String(pageIdOrUrl).match(/([0-9a-f]{32})|([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i);
  if (!m) throw new Error(`NotionページIDとして解釈できません: ${pageIdOrUrl}`);
  const raw = m[0].replace(/-/g, "");
  const id = `${raw.slice(0, 8)}-${raw.slice(8, 12)}-${raw.slice(12, 16)}-${raw.slice(16, 20)}-${raw.slice(20)}`;
  const res = await fetch(`https://api.notion.com/v1/pages/${id}`, {
    headers: { authorization: `Bearer ${token}`, "notion-version": "2022-06-28" },
  });
  const data = (await res.json()) as any;
  if (!res.ok) throw new Error(`Notion API失敗: ${data.message || res.status}`);
  return data;
}
