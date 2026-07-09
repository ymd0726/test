// 実行フェーズ（self-chaining continuation）
//
// 動画アップロード＋Meta処理待ちは数分かかり得るため、1リクエスト内で完結させず
// 「1ホップ=1単位の仕事」をして、残りの状態を署名付きペイロードで
// 自分自身の /internal/cr-in/continue へ POST して繋ぐ。
// 進捗は Slack response_url で随時更新する。
//
// ステップ遷移:
//   upload(i)      … videos[i] をDrive→Metaへチャンク転送（1ホップで1本まるごと。
//                     チャンクループ自体はI/O待ちが支配的でCPU時間は小さい）
//   wait_ready(i)  … videos[i] の処理完了をポーリング（1ホップ=1チェック、5秒待ち）
//   create_ads     … コピー元specを取得し、全動画分の creative+ad(PAUSED) を作成
//   sheet          … 共通GASで集計表にCR00ブロック展開（親+子）
//   notion         … CRページのステータス更新＋実行ログ
//   done           … 結果サマリーをSlackへ

import { ContinuationState, SubmitEnv, SubmitPlan, MAX_READY_ATTEMPTS } from "./types";
import { driveAccessToken } from "./drive";
import {
  startVideoUpload,
  transferVideoChunk,
  finishVideoUpload,
  videoStatus,
  getVideoThumbnailUrl,
  getSourceCreativeSpec,
  getOrCreatePageBackedIg,
  buildCreativeParams,
  createCreative,
  createAd,
} from "./meta";
import { callSheetSubmit } from "./gasClient";
import { markSubmitted } from "./notion";

export const CONTINUE_PATH = "/internal/cr-in/continue";

/** 実行開始（確認ボタン押下後に呼ぶ） */
export async function startExecution(
  plan: SubmitPlan,
  env: SubmitEnv,
  ctx: ExecutionContext,
  metaToken: string,
  projectAccountId: string,
  gasTargets: { spreadsheetId: string; sheetName?: string }[]
): Promise<void> {
  const state: ContinuationState = { step: "upload", index: 0, attempts: 0, plan, startedAt: Date.now() };
  await postProgress(env, plan, `🚀 入稿を開始します: *${plan.parentName}*（動画 ${plan.videos.length} 本）`);
  ctx.waitUntil(runHop(state, env, metaToken, projectAccountId, gasTargets));
}

/** /internal/cr-in/continue のハンドラ */
export async function handleContinue(
  request: Request,
  env: SubmitEnv,
  ctx: ExecutionContext,
  resolveMetaToken: (project: string) => string,
  resolveGasTargets: (project: string) => { spreadsheetId: string; sheetName?: string }[],
  resolveAccountId: (project: string) => string
): Promise<Response> {
  const body = await request.text();
  const sig = request.headers.get("x-continuation-signature") || "";
  if (!(await verifyHmac(env.SHARED_SECRET, body, sig))) {
    return new Response("forbidden", { status: 403 });
  }
  const state = JSON.parse(body) as ContinuationState;
  ctx.waitUntil(
    runHop(
      state,
      env,
      resolveMetaToken(state.plan.project),
      resolveAccountId(state.plan.project),
      resolveGasTargets(state.plan.project)
    )
  );
  return new Response("ok");
}

// ---- 1ホップ分の実行 ----

async function runHop(
  state: ContinuationState,
  env: SubmitEnv,
  metaToken: string,
  accountId: string,
  gasTargets: { spreadsheetId: string; sheetName?: string }[]
): Promise<void> {
  const { plan } = state;
  try {
    switch (state.step) {
      case "upload": {
        const v = plan.videos[state.index];
        await postProgress(env, plan, `⏳ ${v.adName} をアップロード中… (${state.index + 1}/${plan.videos.length})`);
        const driveToken = await driveAccessToken(env.GOOGLE_SERVICE_ACCOUNT_JSON);
        let session = await startVideoUpload(accountId, metaToken, v.fileSizeBytes);
        while (session.startOffset < v.fileSizeBytes) {
          session = await transferVideoChunk(accountId, metaToken, session, driveToken, v.driveFileId);
        }
        await finishVideoUpload(accountId, metaToken, session, v.adName);
        v.videoId = session.videoId;
        state.step = "wait_ready";
        state.attempts = 0;
        break;
      }

      case "wait_ready": {
        // 1ホップで最大4回チェック（5秒間隔）。連鎖ホップ数を抑える（Service Bindingのネスト上限対策）
        const v = plan.videos[state.index];
        let status = "";
        for (let i = 0; i < 4; i++) {
          status = await videoStatus(v.videoId!, metaToken);
          state.attempts += 1;
          if (status === "ready" || status === "error") break;
          if (state.attempts > MAX_READY_ATTEMPTS) {
            throw new Error(`動画 ${v.adName} の処理待ちがタイムアウトしました (video_id=${v.videoId})`);
          }
          await sleep(5000);
        }
        if (status === "error") {
          throw new Error(`動画 ${v.adName} の処理がMeta側でエラーになりました (video_id=${v.videoId})`);
        }
        if (status === "ready") {
          if (state.index + 1 < plan.videos.length) {
            state.index += 1;
            state.step = "upload";
          } else {
            state.step = "create_ads";
          }
        }
        break;
      }

      case "create_ads": {
        await postProgress(env, plan, `🛠️ 広告を作成中…（コピー元: ${plan.sourceAdName}）`);
        const source = await getSourceCreativeSpec(plan.sourceAdId, metaToken);
        let igActorId: string | undefined; // 1815199リトライで解決したPBIAを2本目以降にも使い回す
        for (const v of plan.videos) {
          if (v.adId) continue; // 再実行時のスキップ
          const thumbnailUrl = await getVideoThumbnailUrl(v.videoId!, metaToken);
          if (!thumbnailUrl) {
            throw new Error(`動画 ${v.adName} のサムネイルがまだ生成されていません（video_id=${v.videoId}）。少し待って同じ /cr-in を再実行してください`);
          }
          const crParam = v.sheetId.match(/cr\d+(?:_\d{2})?/i)?.[0] || plan.crKey;
          const buildParams = (ig?: string) =>
            buildCreativeParams(source, {
              adName: v.adName,
              videoId: v.videoId!,
              thumbnailUrl,
              crParam,
              overrides: plan.overrides,
              instagramActorId: ig,
            });
          try {
            v.creativeId = await createCreative(accountId, metaToken, buildParams(igActorId));
          } catch (e: any) {
            // IGアクセス権エラー(1815199) → ページ由来IG(PBIA)のIDを取得して明示指定でリトライ
            if (!/1815199/.test(String(e.message)) ) throw e;
            const pageId = source.object_story_spec?.page_id;
            if (!pageId) throw e;
            await postProgress(env, plan, `ℹ️ IG権限エラーのため、ページ由来IG（PBIA）を取得して再試行します…（page_id=${pageId}）`);
            igActorId = await getOrCreatePageBackedIg(String(pageId), metaToken);
            await postProgress(env, plan, `ℹ️ PBIA取得: ${igActorId}。再試行中…`);
            v.creativeId = await createCreative(accountId, metaToken, buildParams(igActorId));
          }
          v.adId = await createAd(accountId, metaToken, {
            name: v.adName,
            adsetId: plan.adsetId,
            creativeId: v.creativeId,
          });
        }
        state.step = "sheet";
        break;
      }

      case "sheet": {
        await postProgress(env, plan, "📊 集計表にCR00ブロックを展開中…");
        const parentSheetId = sheetParentId(plan);
        const childIds = plan.hasChildren ? plan.videos.map((v) => v.sheetId) : [];
        const results: string[] = [];
        for (const t of gasTargets) {
          const r = await callSheetSubmit(env.SUBMIT_GAS_URL || env.COMMON_GAS_URL, {
            action: "submitCreative",
            spreadsheetId: t.spreadsheetId,
            sheetName: t.sheetName,
            parentId: parentSheetId,
            childIds,
            dryRun: false,
          });
          results.push(r.ok ? `${t.sheetName || t.spreadsheetId}` : `${t.sheetName || t.spreadsheetId} ❌ ${r.error}`);
        }
        (plan as any)._sheetResults = results;
        state.step = "notion";
        break;
      }

      case "notion": {
        let notionWarn: string | null = null;
        if (plan.notionPageId) {
          notionWarn = await markSubmitted(env.NOTION_TOKEN, plan.notionPageId);
        }
        (plan as any)._notionWarn = notionWarn;
        state.step = "done";
        break;
      }

      case "done": {
        const sheetNames = ((plan as any)._sheetResults || []).join(" / ") || "対象なし";
        const notionLine = (plan as any)._notionWarn
          ? `:warning: Notion： ${(plan as any)._notionWarn}`
          : ":white_check_mark: Notion： 入稿済み";
        const lines = [
          `:mega: 入稿が完了しました: ${plan.parentName}`,
          "",
          `:white_check_mark: cp　：${plan.campaignName || "(不明)"}`,
          `:white_check_mark: adset：${plan.adsetName || "(不明)"}`,
          ...plan.videos.map((v) => `:white_check_mark: cr　：${v.adName}（*PAUSED*）`),
          `:white_check_mark: 集計表： ${sheetNames}`,
          notionLine,
          "",
          ":point_right: 最終確認のうえ、広告マネージャで広告をONにしてください。",
        ];
        // 完了通知はチャンネル向け1通のみ（BUG-24: ephemeralとの2重投稿をやめる。
        // ephemeralは進捗・エラー用）。public投稿に失敗した場合だけephemeralで代替する。
        const posted = await postPublic(env, plan.channelId, lines.join("\n"));
        if (!posted) await postProgress(env, plan, lines.join("\n"));
        return; // 連鎖終了
      }
    }
    await chainNext(state, env);
  } catch (e: any) {
    await postProgress(
      env,
      plan,
      `❌ 入稿処理でエラーが発生しました（step=${state.step}）: ${e.message}\n` +
        `ここまでの作成物: ${plan.videos
          .filter((v) => v.videoId)
          .map((v) => `${v.adName}(video:${v.videoId}${v.adId ? `, ad:${v.adId}` : ""})`)
          .join(", ") || "なし"}\n再実行する場合は同じ \`/cr-in\` を実行してください（作成済みはスキップされます）。`
    );
  }
}

/**
 * 次のホップを自分自身へPOST（署名付き）。
 * Workerは自分の公開URLをfetchできない（edgeが404を返す）ため、
 * Service Binding（SELF_WORKER）経由で内部直結する。バインディング未設定時のみ公開URLを試す。
 */
async function chainNext(state: ContinuationState, env: SubmitEnv): Promise<void> {
  const body = JSON.stringify(state);
  const sig = await signHmac(env.SHARED_SECRET, body);
  const init: RequestInit = {
    method: "POST",
    headers: { "content-type": "application/json", "x-continuation-signature": sig },
    body,
  };
  const res = env.SELF_WORKER
    ? await env.SELF_WORKER.fetch(`https://self${CONTINUE_PATH}`, init)
    : await fetch(`${env.SELF_URL}${CONTINUE_PATH}`, init);
  if (!res.ok) throw new Error(`continuation連鎖失敗: ${res.status}`);
}

function sheetParentId(plan: SubmitPlan): string {
  // 親の集計表表記: cr79_説明（ファイル名から案件コードを除いたもの。子しか無い場合は子から親名を導出）
  const i = plan.parentName.search(/cr\d/i);
  return i >= 0 ? plan.parentName.slice(i) : plan.parentName;
}

/**
 * 進捗表示。Slackのresponse_urlは「30分以内・5回まで」の制限があり、
 * 進捗が多いと途中から黙って捨てられる（実際に発生）。
 * そのためBotトークンでのephemeral投稿を優先し、失敗時のみresponse_urlに落とす。
 */
export async function postProgress(
  env: { SLACK_BOT_TOKEN?: string },
  to: { channelId?: string; userId?: string; responseUrl: string },
  text: string
): Promise<void> {
  if (env.SLACK_BOT_TOKEN && to.channelId && to.userId) {
    try {
      const res = await fetch("https://slack.com/api/chat.postEphemeral", {
        method: "POST",
        headers: { "content-type": "application/json; charset=utf-8", authorization: `Bearer ${env.SLACK_BOT_TOKEN}` },
        body: JSON.stringify({ channel: to.channelId, user: to.userId, text }),
      });
      const data: any = await res.json();
      if (data.ok) return;
    } catch {
      /* fallthrough */
    }
  }
  try {
    await fetch(to.responseUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text, response_type: "ephemeral", replace_original: false }),
    });
  } catch {
    // 進捗表示の失敗は本処理を止めない
  }
}

/**
 * チャンネル全員向けの通知（完了サマリー用。停止くんのnotifySlackと同挙動）。
 * 成功したかを返す（失敗時は呼び出し側がephemeralで代替できるように）。
 */
async function postPublic(env: { SLACK_BOT_TOKEN?: string }, channelId: string, text: string): Promise<boolean> {
  if (!env.SLACK_BOT_TOKEN || !channelId) return false;
  try {
    const res = await fetch("https://slack.com/api/chat.postMessage", {
      method: "POST",
      headers: { "content-type": "application/json; charset=utf-8", authorization: `Bearer ${env.SLACK_BOT_TOKEN}` },
      body: JSON.stringify({ channel: channelId, text }),
    });
    const data: any = await res.json();
    return !!data.ok;
  } catch {
    return false; // 通知失敗は本処理を止めない
  }
}

// ---- HMAC ----
async function hmacKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"]
  );
}
export async function signHmac(secret: string, body: string): Promise<string> {
  const sig = await crypto.subtle.sign("HMAC", await hmacKey(secret), new TextEncoder().encode(body));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
export async function verifyHmac(secret: string, body: string, hex: string): Promise<boolean> {
  if (!hex) return false;
  const expected = await signHmac(secret, body);
  // 比較長一定
  if (expected.length !== hex.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ hex.charCodeAt(i);
  return diff === 0;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
