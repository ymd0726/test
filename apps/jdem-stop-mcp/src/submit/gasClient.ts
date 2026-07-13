// 共通GAS 呼び出し（action=submitCreative）
// 既存Workerの callGas と同様に「POST→302のLocation→GET」で結果を取得する。
// （GAS WebアプリのPOSTは302で echo にリダイレクトされる既知の挙動）

export interface SheetSubmitRequest {
  action: "submitCreative";
  spreadsheetId: string;
  sheetName?: string;
  /** 親の集計表表記（例: cr79_ブライダル訴求） */
  parentId: string;
  /** 子の集計表表記（例: ["cr79_01_ブライダル訴求", ...]）。パターン無しなら空配列 */
  childIds: string[];
  dryRun: boolean;
}

export interface SheetSubmitResult {
  ok: boolean;
  dryRun?: boolean;
  sheetName?: string;
  plan?: unknown; // dryRun時の展開計画
  inserted?: { id: string; zone: string; startCol: number; width: number }[];
  warnings?: string[];
  error?: string;
}

// GAS応答待ちの上限。長くしすぎるとCloudflareのhop実行上限手前でkillされ、
// 完了通知が出ないまま「止まる」ように見える（BUG-49）。25秒で確実にabortさせ、
// タイムアウト時も後続(notion→done)へ進めて完了通知を必ず出す。
// ※BUG-32でGAS側の列幅コピーを高速化済みのため、再デプロイ後は25秒に十分収まる。
const GAS_TIMEOUT_MS = 25_000;

export async function callSheetSubmit(
  gasUrl: string,
  req: SheetSubmitRequest
): Promise<SheetSubmitResult> {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), GAS_TIMEOUT_MS);
  try {
    const res = await fetch(gasUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(req),
      redirect: "manual",
      signal: ctl.signal,
    });
    if (res.status === 302) {
      const loc = res.headers.get("location");
      if (!loc) throw new Error("GAS 302にLocationがありません");
      const res2 = await fetch(loc, { signal: ctl.signal });
      return (await res2.json()) as SheetSubmitResult;
    }
    return (await res.json()) as SheetSubmitResult;
  } catch (e: any) {
    // タイムアウト中断の場合、GAS側の処理はサーバー側で継続している可能性がある
    // （クライアント切断ではGAS実行は止まらない）。再実行は同名CRの冪等ガードで安全。
    if (e.name === "AbortError" || /abort/i.test(String(e.message))) {
      return {
        ok: false,
        error: `GAS応答待ちタイムアウト（${GAS_TIMEOUT_MS / 1000}秒）。処理自体は完了している可能性があるため集計表を確認してください`,
      };
    }
    return { ok: false, error: `GAS呼び出し失敗: ${e.message}` };
  } finally {
    clearTimeout(t);
  }
}
