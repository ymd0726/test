// 朝のチェック結果 Slack レポート（TOOL-40）

import type { CheckState, CheckSummary } from "./types";

/**
 * 投稿すべき「異常」があるか（BUG-47: 正常時はSlack投稿しない）。
 * NG / 警告 / チェッカー未登録run / チェック処理自体の失敗 のいずれかがあれば true。
 * チェッカー自体の起動・実行エラー（🚨）は呼び元の catch で別途投稿する。
 */
export function hasAbnormality(s: CheckSummary): boolean {
  return s.ng > 0 || s.warn > 0 || s.unknownTool.length > 0 || s.errors.length > 0;
}

/** サマリ本文を組み立てる（1通・管理チャンネル向け） */
export function buildSummaryText(state: CheckState, tookMs: number): string {
  const s = state.summary;
  const total = s.ok + s.warn + s.ng;
  const lines: string[] = [];
  lines.push(`🌅 *翌日自動チェックくん — ${state.dateJst} 実行分の結果*${state.dryRun ? "（dryRun: 起票・書き戻しなし）" : ""}`);

  if (total === 0 && s.unknownTool.length === 0 && s.errors.length === 0) {
    lines.push(`✅ ${state.dateJst} のツール実行はありませんでした（チェッカーは正常稼働）`);
    return lines.join("\n");
  }

  lines.push(`対象: ${total}件　結果: ✅ OK ${s.ok} / ⚠️ 警告 ${s.warn} / ❌ NG ${s.ng}`);
  if (s.ng > 0) {
    lines.push("", "❌ *NG（要対応）*");
    lines.push(...s.ngLines);
  }
  if (s.warn > 0) {
    lines.push("", "⚠️ *警告*");
    lines.push(...s.warnLines);
  }
  if (s.ok > 0) {
    lines.push("", `✅ OK（${s.ok}件）: ${s.okLines.join(" ・ ")}`);
  }
  if (s.unknownTool.length > 0) {
    lines.push("", `❓ チェッカー未登録ツールのrun（未チェック）: ${s.unknownTool.join(", ")}`);
  }
  if (s.errors.length > 0) {
    lines.push("", `🚨 チェック処理自体が失敗したrun:`);
    lines.push(...s.errors.map((e) => `• ${e}`));
  }
  lines.push("", `ℹ️ スクショ貼付チェックは未対応（Phase 2）　処理時間 ${Math.round(tookMs / 1000)}s`);
  return lines.join("\n");
}

/** チャンネルへ投稿（Bot未参加ならpublicチャンネルに限り参加を試みて1回再送。BUG-29と同じ） */
export async function postSlack(
  env: { SLACK_BOT_TOKEN?: string },
  channelId: string | undefined,
  text: string
): Promise<{ ok: boolean; error?: string }> {
  if (!env.SLACK_BOT_TOKEN || !channelId) return { ok: false, error: "no token/channel" };
  try {
    const post = async () => {
      const res = await fetch("https://slack.com/api/chat.postMessage", {
        method: "POST",
        headers: { "content-type": "application/json; charset=utf-8", authorization: `Bearer ${env.SLACK_BOT_TOKEN}` },
        body: JSON.stringify({ channel: channelId, text, unfurl_links: false }),
      });
      return (await res.json()) as any;
    };
    let data = await post();
    if (!data.ok && data.error === "not_in_channel") {
      const j = await fetch("https://slack.com/api/conversations.join", {
        method: "POST",
        headers: { "content-type": "application/json; charset=utf-8", authorization: `Bearer ${env.SLACK_BOT_TOKEN}` },
        body: JSON.stringify({ channel: channelId }),
      });
      if (((await j.json()) as any).ok) data = await post();
    }
    return data.ok ? { ok: true } : { ok: false, error: data.error };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}
