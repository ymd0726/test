// チェック用 Meta Graph API 読み取り（副作用なし）
//
// 実行ログに記録された ad id から現在の配信状態をバッチ取得する。
// 広告本体の status/effective_status に加え、上位（adset/campaign）の状態も
// 同じ1リクエストで取る（入稿チェックI1/I2・停止チェックS1で使用）。

const GRAPH = "https://graph.facebook.com/v21.0";

export interface AdInfo {
  id: string;
  name: string;
  /** 広告自身の設定状態（PAUSED/ACTIVE） */
  status: string;
  /** 配信実効状態（ACTIVE/PAUSED/ADSET_PAUSED/CAMPAIGN_PAUSED/DELETED…） */
  effectiveStatus: string;
  adsetId?: string;
  adsetName?: string;
  adsetStatus?: string;
  campaignId?: string;
  campaignName?: string;
  campaignStatus?: string;
}

/**
 * 複数広告の状態を1リクエストで取得（?ids=…）。
 * 見つからないIDは結果に含まれない（削除済み等）。
 */
export async function batchAdInfo(token: string, adIds: string[]): Promise<Map<string, AdInfo>> {
  const out = new Map<string, AdInfo>();
  // ?ids= は50件までが安全圏。チェック対象runの広告数は通常数件
  for (let i = 0; i < adIds.length; i += 50) {
    const chunk = adIds.slice(i, i + 50);
    const fields = "id,name,status,effective_status,adset{id,name,status},campaign{id,name,status}";
    const url = `${GRAPH}/?ids=${encodeURIComponent(chunk.join(","))}&fields=${encodeURIComponent(fields)}&access_token=${encodeURIComponent(token)}`;
    const data = await fetchJsonTimeout(url, 12000);
    if (data.error) {
      // 一部IDの消失で全体がエラーになることがある → 1件ずつ拾い直す
      for (const id of chunk) {
        try {
          const one = await fetchJsonTimeout(`${GRAPH}/${id}?fields=${encodeURIComponent(fields)}&access_token=${encodeURIComponent(token)}`, 12000);
          if (!one.error) out.set(id, toAdInfo(one));
        } catch {
          /* 消失IDはスキップ（チェッカー側で「見つからない」扱い） */
        }
      }
      continue;
    }
    for (const id of chunk) {
      if (data[id]) out.set(id, toAdInfo(data[id]));
    }
  }
  return out;
}

function toAdInfo(a: any): AdInfo {
  return {
    id: String(a.id),
    name: String(a.name || ""),
    status: String(a.status || ""),
    effectiveStatus: String(a.effective_status || ""),
    adsetId: a.adset?.id,
    adsetName: a.adset?.name,
    adsetStatus: a.adset?.status,
    campaignId: a.campaign?.id,
    campaignName: a.campaign?.name,
    campaignStatus: a.campaign?.status,
  };
}

async function fetchJsonTimeout(url: string, ms: number): Promise<any> {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), ms);
  try {
    const res = await fetch(url, { signal: ctl.signal });
    return await res.json();
  } finally {
    clearTimeout(t);
  }
}
