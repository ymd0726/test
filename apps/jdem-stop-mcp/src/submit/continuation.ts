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
  setEntityStatus,
  getAdsetParentStatus,
} from "./meta";
import { callSheetSubmit } from "./gasClient";
import { markSubmitted } from "./notion";
import { createRunLog, updateRunLog } from "../check/runlog";

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
  // 実行ログDB（TOOL-40）: 開始時に「実行中」で作成。翌朝チェックの照合キー（親cr/子cr/入稿先）も先に記録する
  const runDetail = {
    parentSheetId: sheetParentId(plan),
    childSheetIds: plan.videos.map((v) => v.sheetId).filter((sid) => /cr\d+_\d{2}/i.test(sid)),
  };
  (plan as any)._runDetail = runDetail;
  plan.runLogPageId = await createRunLog(env.NOTION_TOKEN, {
    tool: "cr入稿くん",
    action: "入稿",
    project: plan.project,
    crName: plan.parentName,
    userName: plan.userName,
    userId: plan.userId,
    route: "Slack",
    adsetIds: plan.targets?.length ? plan.targets.map((t) => t.adsetId) : [plan.adsetId],
    sheetTabs: gasTargets.map((t) => t.sheetName || "").filter(Boolean),
    notionCrPageId: plan.notionPageId,
    detail: runDetail,
  });
  const logWarn = !plan.runLogPageId && env.NOTION_TOKEN ? "\n⚠️ 実行ログの記録に失敗（翌日自動チェックの対象外になります）" : "";
  await postProgress(env, plan, `🚀 入稿を開始します: *${plan.parentName}*（動画 ${plan.videos.length} 本）${logWarn}`);
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
        // 入稿先ターゲット（複数広告セット同時入稿=BUG-31 対応。未設定時は従来の単一入稿）
        const targets = plan.targets?.length
          ? plan.targets
          : [{ adsetId: plan.adsetId, adsetName: plan.adsetName, campaignName: plan.campaignName, sourceAdId: plan.sourceAdId, sourceAdName: plan.sourceAdName }];
        await postProgress(
          env,
          plan,
          targets.length > 1
            ? `🛠️ 広告を作成中…（${targets.length}セットに入稿: ${targets.map((t) => t.adsetName).join(" / ")}）`
            : `🛠️ 広告を作成中…（コピー元: ${plan.sourceAdName}）`
        );
        // サムネイルは動画ごとに1回だけ取得してターゲット間で使い回す
        const thumbs = new Map<string, string>();
        for (const v of plan.videos) {
          const thumbnailUrl = await getVideoThumbnailUrl(v.videoId!, metaToken);
          if (!thumbnailUrl) {
            throw new Error(`動画 ${v.adName} のサムネイルがまだ生成されていません（video_id=${v.videoId}）。少し待って同じ /cr-in を再実行してください`);
          }
          thumbs.set(v.videoId!, thumbnailUrl);
        }
        let igActorId: string | undefined; // 1815199リトライで解決したPBIAを2本目以降にも使い回す
        for (const t of targets) {
          // テキスト類は「そのセットの直近cr広告」からコピー（セットごとにspec取得）
          const source = await getSourceCreativeSpec(t.sourceAdId, metaToken);
          for (const v of plan.videos) {
            v.adIdsByAdset = v.adIdsByAdset || {};
            if (v.adIdsByAdset[t.adsetId]) continue; // 再実行時のスキップ（作成済みペア）
            const crParam = v.sheetId.match(/cr\d+(?:_\d{2})?/i)?.[0] || plan.crKey;
            const buildParams = (ig?: string) =>
              buildCreativeParams(source, {
                adName: v.adName,
                videoId: v.videoId!,
                thumbnailUrl: thumbs.get(v.videoId!)!,
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
            const adId = await createAd(accountId, metaToken, {
              name: v.adName,
              adsetId: t.adsetId,
              creativeId: v.creativeId,
            });
            v.adIdsByAdset[t.adsetId] = adId;
            if (!v.adId) v.adId = adId;
          }
        }
        state.step = "activate";
        break;
      }

      case "activate": {
        // 一気通貫: 作成した広告を全てONにする（BUG-33）。広告セット/キャンペーンは勝手にONにしない。
        const adIds: string[] = [];
        for (const v of plan.videos) {
          for (const k of Object.keys(v.adIdsByAdset || {})) adIds.push(v.adIdsByAdset![k]);
        }
        await postProgress(env, plan, `▶️ 作成した広告 ${adIds.length}件をONにしています…`);
        for (const id of adIds) {
          try {
            await setEntityStatus(id, metaToken, "ACTIVE");
          } catch (e: any) {
            (plan as any)._activateWarn = ((plan as any)._activateWarn || "") + `広告${id}のON化失敗: ${e.message}; `;
          }
        }
        // 入稿先の広告セット/キャンペーンがOFFなら、完了時に「ONにするか」確認ボタンを出す
        const targets = plan.targets?.length
          ? plan.targets
          : [{ adsetId: plan.adsetId, adsetName: plan.adsetName, campaignName: plan.campaignName, sourceAdId: plan.sourceAdId, sourceAdName: plan.sourceAdName }];
        const seenAdsets = new Set<string>();
        const offParents: any[] = [];
        for (const t of targets) {
          if (seenAdsets.has(t.adsetId)) continue;
          seenAdsets.add(t.adsetId);
          try {
            const st = await getAdsetParentStatus(t.adsetId, metaToken);
            const adsetOff = st.adsetStatus !== "ACTIVE";
            const campOff = !!st.campaignStatus && st.campaignStatus !== "ACTIVE";
            if (adsetOff || campOff) {
              offParents.push({
                adsetId: t.adsetId,
                adsetName: st.adsetName || t.adsetName,
                adsetOff,
                campaignId: st.campaignId,
                campaignName: st.campaignName || t.campaignName,
                campOff,
              });
            }
          } catch {
            /* 状態取得失敗は致命ではない。確認ボタンを出さず完了する */
          }
        }
        (plan as any)._offParents = offParents;
        // 実行ログ: Meta段階の結果（作成した全広告ID・ON化警告）を記録
        await updateRunLog(env.NOTION_TOKEN, plan.runLogPageId, {
          metaResult: (plan as any)._activateWarn ? "失敗" : "成功",
          adIds,
        });
        state.step = "sheet";
        break;
      }

      case "sheet": {
        await postProgress(env, plan, "📊 集計表にCR00ブロックを展開中…");
        // 集計内(親)ブロックは常に cr番号のみ（例 cr83）。パターン番号(_01/_02)や説明は付けない（BUG-32）。
        // パターン番号を持つ動画は集計外(子)ブロックとして展開する。単独入稿でも cr83_01 は
        // 「親cr83 / 子cr83_01」になる。パターン無し(cr82等)は親ブロックのみ（子なし単独CR）。
        const parentSheetId = sheetParentId(plan);
        const childIds = plan.videos.map((v) => v.sheetId).filter((sid) => /cr\d+_\d{2}/i.test(sid));
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
        // 実行ログ: 集計表段階の結果
        await updateRunLog(env.NOTION_TOKEN, plan.runLogPageId, {
          sheetResult: results.some((r) => r.includes("❌")) ? "失敗" : "成功",
          sheetTabs: gasTargets.map((t) => t.sheetName || "").filter(Boolean),
        });
        state.step = "notion";
        break;
      }

      case "notion": {
        let notionWarn: string | null = null;
        if (plan.notionPageId) {
          notionWarn = await markSubmitted(env.NOTION_TOKEN, plan.notionPageId);
        }
        (plan as any)._notionWarn = notionWarn;
        await updateRunLog(env.NOTION_TOKEN, plan.runLogPageId, {
          notionResult: !plan.notionPageId ? "対象なし" : notionWarn ? "失敗" : "成功",
        });
        state.step = "done";
        break;
      }

      case "done": {
        const sheetNames = ((plan as any)._sheetResults || []).join(" / ") || "対象なし";
        const notionLine = (plan as any)._notionWarn
          ? `:warning: Notion： ${(plan as any)._notionWarn}`
          : ":white_check_mark: Notion： 入稿済み";
        const multi = plan.targets && plan.targets.length > 1 ? plan.targets : null;
        const cpLine = multi
          ? [...new Set(multi.map((t) => t.campaignName).filter(Boolean))].join(" / ")
          : plan.campaignName;
        const adsetLine = multi ? multi.map((t) => t.adsetName).join(" / ") : plan.adsetName;
        const activateWarn: string = (plan as any)._activateWarn || "";
        const offParents: any[] = (plan as any)._offParents || [];
        // 一気通貫ON（BUG-33）: 広告はON化済み。ON化に失敗した広告があれば警告表示
        const crSuffix = activateWarn
          ? multi ? `（一部ON化失敗×${multi.length}セット）` : "（一部ON化失敗）"
          : multi ? `（*ON*×${multi.length}セット）` : "（*ON*）";
        const lines = [
          `:mega: 入稿が完了しました: ${plan.parentName}`,
          "",
          `:white_check_mark: cp　：${cpLine || "(不明)"}`,
          `:white_check_mark: adset：${adsetLine || "(不明)"}${multi ? `（${multi.length}セット同時入稿）` : ""}`,
          ...plan.videos.map((v) => `:white_check_mark: cr　：${v.adName}${crSuffix}`),
          `:white_check_mark: 集計表： ${sheetNames}`,
          notionLine,
        ];
        if (activateWarn) lines.push(`:warning: ${activateWarn}`);
        if (offParents.length === 0) {
          lines.push("", ":rocket: 広告はONにしました。配信が開始されます（最終確認をお願いします）。");
        } else {
          // 広告セット/キャンペーンがOFF → 勝手にONにしない。確認ボタンで許可を取る（BUG-33）
          const names = offParents
            .map((p) => `・${p.campOff ? `cp「${p.campaignName || p.campaignId}」` : ""}${p.adsetOff ? `${p.campOff ? " / " : ""}adset「${p.adsetName}」` : ""}（OFF）`)
            .join("\n");
          lines.push(
            "",
            ":warning: 広告はONにしましたが、上位が停止中のため *このままでは配信されません* :",
            names
          );
        }
        // 実行ログ: 最終ステータス（どこかで警告/失敗があれば一部失敗）
        await updateRunLog(env.NOTION_TOKEN, plan.runLogPageId, {
          status: activateWarn || (plan as any)._notionWarn || sheetNames.includes("❌") ? "一部失敗" : "完了",
        });
        if (!plan.runLogPageId && env.NOTION_TOKEN) {
          lines.push(":warning: 実行ログの記録に失敗（翌日自動チェックの対象外になります）");
        }
        // 完了通知はチャンネル向け1通のみ（BUG-24）。public投稿に失敗した場合だけephemeralで代替する。
        const posted = await postPublic(env, plan.channelId, lines.join("\n"));
        if (!posted) await postProgress(env, plan, lines.join("\n"));
        // OFF親があれば、操作者にだけ「ONにするか」の確認ボタンを出す（勝手にONにしない）
        if (offParents.length > 0) {
          await postParentActivatePrompt(env, plan, offParents);
        }
        return; // 連鎖終了
      }
    }
    await chainNext(state, env);
  } catch (e: any) {
    // 実行ログ: 失敗で確定（どのステップで死んだかを機械可読で残す→翌朝チェック/自動改修の入力）
    await updateRunLog(env.NOTION_TOKEN, plan.runLogPageId, {
      status: "失敗",
      detail: { ...((plan as any)._runDetail || {}), failedStep: state.step, lastError: String(e.message || e).slice(0, 500) },
    });
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
 * 広告セット/キャンペーンがOFFのとき、操作者にだけ「ONにするか」の確認ボタンを出す（BUG-33）。
 * 勝手にはONにしない。ボタン押下（+確認ダイアログ）で crin_actparent アクションが発火する。
 */
async function postParentActivatePrompt(
  env: SubmitEnv,
  plan: SubmitPlan,
  offParents: any[]
): Promise<void> {
  if (!env.SLACK_BOT_TOKEN || !plan.channelId || !plan.userId) return;
  // ボタンvalueはSlackの2000字制限に収めるため最小限（adsetId/campaignIdのみ）
  const payload = offParents.map((p) => ({
    a: p.adsetOff ? p.adsetId : "",
    c: p.campOff ? p.campaignId : "",
  }));
  const summary = offParents
    .map((p) => `${p.campOff ? `cp「${p.campaignName || p.campaignId}」` : ""}${p.adsetOff ? `${p.campOff ? "／" : ""}adset「${p.adsetName}」` : ""}`)
    .join("、");
  const blocks = [
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: `⚠️ 停止中の上位（${summary}）をONにしますか？\nONにすると配信が開始され予算が動きます。広告セット/キャンペーンは自動ではONにしていません。`,
      },
    },
    {
      type: "actions",
      elements: [
        {
          type: "button",
          style: "primary",
          text: { type: "plain_text", text: "▶️ 上位もONにする" },
          action_id: "crin_actparent",
          value: JSON.stringify({ p: payload }),
          confirm: {
            title: { type: "plain_text", text: "上位のON化" },
            text: { type: "mrkdwn", text: `${summary} をONにします。配信が開始され予算が動きます。よろしいですか？` },
            confirm: { type: "plain_text", text: "ONにする" },
            deny: { type: "plain_text", text: "やめる" },
          },
        },
        { type: "button", text: { type: "plain_text", text: "そのまま（OFFのまま）" }, action_id: "crin_cancel", value: "cancel" },
      ],
    },
  ];
  try {
    await fetch("https://slack.com/api/chat.postEphemeral", {
      method: "POST",
      headers: { "content-type": "application/json; charset=utf-8", authorization: `Bearer ${env.SLACK_BOT_TOKEN}` },
      body: JSON.stringify({ channel: plan.channelId, user: plan.userId, blocks, text: "停止中の上位をONにしますか？" }),
    });
  } catch {
    /* 確認ボタンの投稿失敗は致命ではない */
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
  // 集計内(親)ブロックの表記は cr番号のみ（例 cr83）。パターン番号(_01/_02)も説明も付けない（BUG-32）。
  // plan.crKey は resolve.ts で抽出済みの「cr83」なのでそれを使う。
  const m = plan.crKey.match(/cr\d+/i);
  return m ? m[0].toLowerCase() : plan.crKey.toLowerCase();
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
      const post = () =>
        fetch("https://slack.com/api/chat.postEphemeral", {
          method: "POST",
          headers: { "content-type": "application/json; charset=utf-8", authorization: `Bearer ${env.SLACK_BOT_TOKEN}` },
          body: JSON.stringify({ channel: to.channelId, user: to.userId, text }),
        }).then((r) => r.json() as Promise<any>);
      let data = await post();
      if (!data.ok && data.error === "not_in_channel") {
        // Botが未参加のチャンネル（BUG-29: rclで進捗が全滅した）→ 参加を試みて1回だけ再送。
        // conversations.joinはpublicチャンネルのみ有効。失敗時はresponse_urlへフォールバック
        if (await joinChannel(env.SLACK_BOT_TOKEN, to.channelId)) data = await post();
      }
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

/** Botをpublicチャンネルへ参加させる（not_in_channel対策）。成功可否を返す */
async function joinChannel(botToken: string, channelId: string): Promise<boolean> {
  try {
    const res = await fetch("https://slack.com/api/conversations.join", {
      method: "POST",
      headers: { "content-type": "application/json; charset=utf-8", authorization: `Bearer ${botToken}` },
      body: JSON.stringify({ channel: channelId }),
    });
    const data: any = await res.json();
    return !!data.ok;
  } catch {
    return false;
  }
}

/**
 * チャンネル全員向けの通知（完了サマリー用。停止くんのnotifySlackと同挙動）。
 * 成功したかを返す（失敗時は呼び出し側がephemeralで代替できるように）。
 */
async function postPublic(env: { SLACK_BOT_TOKEN?: string }, channelId: string, text: string): Promise<boolean> {
  if (!env.SLACK_BOT_TOKEN || !channelId) return false;
  try {
    const post = () =>
      fetch("https://slack.com/api/chat.postMessage", {
        method: "POST",
        headers: { "content-type": "application/json; charset=utf-8", authorization: `Bearer ${env.SLACK_BOT_TOKEN}` },
        body: JSON.stringify({ channel: channelId, text }),
      }).then((r) => r.json() as Promise<any>);
    let data = await post();
    if (!data.ok && data.error === "not_in_channel") {
      // Bot未参加チャンネル → 参加を試みて1回だけ再送（BUG-29）
      if (await joinChannel(env.SLACK_BOT_TOKEN, channelId)) data = await post();
    }
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
