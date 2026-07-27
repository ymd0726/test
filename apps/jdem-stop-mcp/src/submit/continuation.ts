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
  getAdsetAdsByName,
} from "./meta";
import { callSheetSubmit, callSheetCheck, callSheetThumbnail } from "./gasClient";
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
        // 再実行時の二重作成防止（BUG-57）: 各入稿先の既存広告(name→id)を取得し、
        // 同名広告が既にあれば「作成済み」として adIdsByAdset に反映しておく。
        // continuationのstateは1連鎖内しか覚えていないため、別コマンドで再実行すると
        // 同名広告をMetaに重複作成していた（エラー時の再実行案内と挙動が矛盾していた）。
        for (const t of targets) {
          let existing: Map<string, string>;
          try {
            existing = await getAdsetAdsByName(t.adsetId, metaToken);
          } catch {
            existing = new Map(); // 取得失敗時は従来どおり（重複作成のリスクは残るが処理は続行）
          }
          for (const v of plan.videos) {
            v.adIdsByAdset = v.adIdsByAdset || {};
            const hit = existing.get(v.adName);
            if (hit && !v.adIdsByAdset[t.adsetId]) {
              v.adIdsByAdset[t.adsetId] = hit;
              if (!v.adId) v.adId = hit;
            }
          }
        }
        // サムネイルは動画ごとに1回だけ取得してターゲット間で使い回す。
        // 作成が必要な(video,adset)ペアが1つも無い動画はサムネ取得も不要（既存スキップ時に
        // サムネ未生成で無駄に失敗しないようにする）。
        const needThumb = new Set<string>();
        for (const t of targets) {
          for (const v of plan.videos) {
            if (!v.adIdsByAdset || !v.adIdsByAdset[t.adsetId]) needThumb.add(v.videoId!);
          }
        }
        const thumbs = new Map<string, string>();
        for (const v of plan.videos) {
          if (!needThumb.has(v.videoId!)) continue;
          const thumbnailUrl = await getVideoThumbnailUrl(v.videoId!, metaToken);
          if (!thumbnailUrl) {
            throw new Error(`動画 ${v.adName} のサムネイルがまだ生成されていません（video_id=${v.videoId}）。少し待って同じ /cr-in を再実行してください`);
          }
          thumbs.set(v.videoId!, thumbnailUrl);
          v.thumbUrl = thumbnailUrl; // ゼロ設定サムネ挿入（BUG-104）で done から使う
        }
        let igActorId: string | undefined; // 1815199リトライで解決したPBIAを2本目以降にも使い回す
        for (const t of targets) {
          // この入稿先で作成が必要な動画が無ければ（全て既存でスキップ）spec取得も省く
          if (plan.videos.every((v) => v.adIdsByAdset && v.adIdsByAdset[t.adsetId])) continue;
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
        const pending: { idx: number; spreadsheetId: string; sheetName?: string; label: string }[] = [];
        for (const t of gasTargets) {
          const r = await callSheetSubmit(env.SUBMIT_GAS_URL || env.COMMON_GAS_URL, {
            action: "submitCreative",
            spreadsheetId: t.spreadsheetId,
            sheetName: t.sheetName,
            parentId: parentSheetId,
            childIds,
            dryRun: false,
          });
          const label = t.sheetName || t.spreadsheetId;
          // GASからの警告（分類プルダウン未反映・判定行未検出等）は完了通知に必ず表示する。
          // 以前は握りつぶしていたため、集計表側の設定漏れに気づけなかった（BUG-68）
          const warnSuffix = r.ok && r.warnings?.length ? ` ⚠️ ${r.warnings.join(" / ")}` : "";
          if (r.ok) {
            results.push(`${label}${warnSuffix}`);
          } else if (/タイムアウト/.test(r.error || "")) {
            // タイムアウトはGAS側で処理継続中の可能性が高い（クライアント切断ではGASは止まらない）。
            // 巨大シート(kk_kou等)ではほぼ毎回25秒を超え、実際は成功しているのに❌表示になっていた
            // （BUG-95）。失敗と断定せず、sheet_verifyでID行への反映を確認してから結果を出す。
            results.push(`${label}（確認中）`);
            pending.push({ idx: results.length - 1, spreadsheetId: t.spreadsheetId, sheetName: t.sheetName, label });
          } else {
            results.push(`${label} ❌ ${r.error}`);
          }
        }
        (plan as any)._sheetResults = results;
        if (pending.length > 0) {
          (plan as any)._sheetPending = pending;
          (plan as any)._sheetCheckIds = [parentSheetId, ...childIds];
          state.step = "sheet_verify";
          state.attempts = 0;
          break;
        }
        // 実行ログ: 集計表段階の結果
        await updateRunLog(env.NOTION_TOKEN, plan.runLogPageId, {
          sheetResult: results.some((r) => r.includes("❌")) ? "失敗" : "成功",
          sheetTabs: gasTargets.map((t) => t.sheetName || "").filter(Boolean),
        });
        state.step = "notion";
        break;
      }

      case "sheet_verify": {
        // GASタイムアウト後の反映確認（BUG-95）: 集計表のID行に親/子crが現れたかを
        // 読み取り専用のsubmitCheckで軽量確認する。確認できたら通常の成功表記にする。
        // GAS本体の実行はサーバー側で続いているため、5秒間隔で最大12ホップ（約1〜1.5分）待つ。
        const ids: string[] = (plan as any)._sheetCheckIds || [];
        const results: string[] = (plan as any)._sheetResults || [];
        const pending: { idx: number; spreadsheetId: string; sheetName?: string; label: string }[] =
          (plan as any)._sheetPending || [];
        if (state.attempts === 0) {
          await postProgress(env, plan, "📊 GASの応答が遅いため、集計表への反映を確認しています…（最大1分半）");
        }
        const MAX_SHEET_VERIFY_ATTEMPTS = 12;
        const still: typeof pending = [];
        for (const p of pending) {
          const r = await callSheetCheck(env.SUBMIT_GAS_URL || env.COMMON_GAS_URL, {
            spreadsheetId: p.spreadsheetId,
            sheetName: p.sheetName,
            ids,
          });
          if (r.ok && (r.missing || []).length === 0) {
            results[p.idx] = p.label; // 反映を確認できた＝通常の成功表記
          } else if (!r.ok && /不明なaction/.test(r.error || "")) {
            // 入稿GASが旧版（submitCheck未実装）→ ポーリングしても無駄なので即確定
            results[p.idx] = `${p.label} ⚠️ GAS応答待ちタイムアウト（入稿GASが旧版のため自動確認不可。GAS再デプロイ後は自動確認されます）。集計表を目視確認してください`;
          } else {
            still.push(p);
          }
        }
        state.attempts += 1;
        if (still.length > 0 && state.attempts < MAX_SHEET_VERIFY_ATTEMPTS) {
          (plan as any)._sheetPending = still;
          (plan as any)._sheetResults = results;
          await sleep(5000);
          break; // chainNextで次ホップへ（確認を継続）
        }
        for (const p of still) {
          results[p.idx] = `${p.label} ⚠️ GAS応答待ちタイムアウト後、約1分半待っても反映を確認できませんでした。集計表を確認し、無ければ同じ /cr-in を再実行してください（作成済みはスキップされます）`;
        }
        (plan as any)._sheetResults = results;
        (plan as any)._sheetPending = [];
        await updateRunLog(env.NOTION_TOKEN, plan.runLogPageId, {
          sheetResult: results.some((r) => r.includes("❌") || r.includes("確認できませんでした")) ? "失敗" : "成功",
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
        // crサムネ（0:01フレーム）を集計表セルに自動挿入（BUG-103）。ffmpegが要るためWorker/GASでは
        // デコードできず、GitHub Actions(cr-thumbnail.yml)へworkflow_dispatchで委譲する。
        // 集計表にブロックが入った後（=このdone時点）に起動し、Actions側でDrive→ffmpeg→GAS挿入する。
        if (!sheetNames.includes("❌")) {
          try {
            if (env.GITHUB_DISPATCH_TOKEN) {
              // トークンあり: ffmpegで正確な0:01フレームを抽出（Actions委譲）
              const tr = await triggerThumbnailWorkflow(env, plan, gasTargets);
              if (tr === "ok") lines.push(":frame_with_picture: サムネ： 集計表へ0:01フレームを自動挿入中（30秒〜1分半後に反映されます）");
            } else {
              // トークン無し（ゼロ設定）: Metaの自動生成サムネをWorkerが取得しbase64でセル挿入（BUG-104）
              const n = await insertMetaThumbnails(env, plan, metaToken, gasTargets);
              if (n > 0) lines.push(`:frame_with_picture: サムネ： 集計表に挿入しました（${n}件）`);
            }
          } catch (e: any) {
            lines.push(`:warning: サムネ挿入に失敗: ${e.message}（集計表のサムネは後で手動でも入れられます）`);
          }
        }
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
        // 完了通知はチャンネル向け1通のみ（BUG-24）。public投稿に失敗した場合だけephemeral/
        // response_urlで代替する（完了通知だけは response_url 枠を使ってよい＝BUG-49）。
        const posted = await postPublic(env, plan.channelId, lines.join("\n"));
        if (!posted) await postProgress(env, plan, lines.join("\n"), true);
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
    // エラー通知は必ず届けたいので response_url フォールバックを許可（BUG-49）
    await postProgress(
      env,
      plan,
      `❌ 入稿処理でエラーが発生しました（step=${state.step}）: ${e.message}\n` +
        `ここまでの作成物: ${plan.videos
          .filter((v) => v.videoId)
          .map((v) => `${v.adName}(video:${v.videoId}${v.adId ? `, ad:${v.adId}` : ""})`)
          .join(", ") || "なし"}\n再実行する場合は同じ \`/cr-in\` を実行してください（作成済みはスキップされます）。`,
      true
    );
  }
}

/**
 * ゼロ設定サムネ挿入（BUG-104）。GitHubトークンが無くても、Metaが動画アップロード時に
 * 自動生成したサムネ画像をWorkerが取得→base64化→GAS insertCrThumbnailでセル内画像として
 * 挿入する。ffmpeg不要・GitHubトークン不要・ユーザー作業ゼロ。フレームはMetaの自動選択
 * （厳密な0:01ではない）だが、base64埋め込みなのでURL失効の心配はなく恒久的。
 * 「親は01」運用に合わせ、親ブロックは _01 の動画サムネを使う（_01が今回に無ければ親はスキップ）。
 * 戻り値: 挿入できたセル数。
 */
async function insertMetaThumbnails(
  env: SubmitEnv,
  plan: SubmitPlan,
  metaToken: string,
  gasTargets: { spreadsheetId: string; sheetName?: string }[]
): Promise<number> {
  const parentId = sheetParentId(plan);
  const childVids = plan.videos.filter((v) => /cr\d+_\d{2}/i.test(v.sheetId) && v.videoId);
  // (集計表ID, 動画) のペアを作る
  const items: { id: string; videoId: string; thumbUrl?: string }[] = [];
  if (childVids.length > 0) {
    const rep01 = childVids.find((v) => /_01$/i.test(v.sheetId));
    if (rep01) items.push({ id: parentId, videoId: rep01.videoId!, thumbUrl: rep01.thumbUrl });
    for (const v of childVids) items.push({ id: v.sheetId, videoId: v.videoId!, thumbUrl: v.thumbUrl });
  } else if (plan.videos[0]?.videoId) {
    items.push({ id: parentId, videoId: plan.videos[0].videoId!, thumbUrl: plan.videos[0].thumbUrl });
  }
  if (items.length === 0) return 0;

  const gasUrl = env.SUBMIT_GAS_URL || env.COMMON_GAS_URL;
  let inserted = 0;
  for (const it of items) {
    // サムネURL（create_adsで取得済み。再実行等で未取得なら取り直す）
    let url = it.thumbUrl;
    if (!url) url = (await getVideoThumbnailUrl(it.videoId, metaToken)) || undefined;
    if (!url) continue;
    // Metaサムネ画像のバイトを取得しbase64化（数十KB程度のJPEG）
    let b64 = "";
    let mime = "image/jpeg";
    try {
      const r = await fetch(url);
      if (!r.ok) continue;
      mime = r.headers.get("content-type") || "image/jpeg";
      b64 = abToBase64(await r.arrayBuffer());
    } catch {
      continue;
    }
    if (!b64) continue;
    for (const t of gasTargets) {
      const res = await callSheetThumbnail(gasUrl, {
        spreadsheetId: t.spreadsheetId,
        sheetName: t.sheetName,
        id: it.id,
        imageBase64: b64,
        mimeType: mime,
      });
      if (res.ok) inserted++;
    }
  }
  return inserted;
}

/** ArrayBuffer → base64（Meta自動サムネは小さいので単純ループで十分） */
function abToBase64(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let bin = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode.apply(null, Array.from(bytes.subarray(i, i + CHUNK)) as any);
  }
  return btoa(bin);
}

/**
 * crサムネ（0:01フレーム）を集計表へ自動挿入するため、GitHub Actions cr-thumbnail.yml を
 * workflow_dispatch で起動する（BUG-103）。Worker/GASは動画デコード不可のためActionsに委譲。
 * jobs = 各cr(集計表ID) → 動画DriveファイルID。親ブロックは _01（無ければ最小番号）のフレームを使う。
 * トークン未設定なら "no-token" を返し、呼び出し側は従来どおり手動運用の案内にする。
 */
async function triggerThumbnailWorkflow(
  env: SubmitEnv,
  plan: SubmitPlan,
  gasTargets: { spreadsheetId: string; sheetName?: string }[]
): Promise<"ok" | "no-token" | "skip"> {
  if (!env.GITHUB_DISPATCH_TOKEN) return "no-token";
  const parentId = sheetParentId(plan);
  const childVids = plan.videos.filter((v) => /cr\d+_\d{2}/i.test(v.sheetId) && v.driveFileId);
  const jobs: { id: string; fileId: string }[] = [];
  if (childVids.length > 0) {
    // 親ブロックは _01 のフレーム（「親は01」運用）。今回の入稿に _01 が含まれるときだけ親を更新する。
    // 例: /cr-in cr47_07 08 のような部分入稿では親(cr47)の既存01サムネを非01で上書きしない。
    const rep01 = childVids.find((v) => /_01$/i.test(v.sheetId));
    if (rep01) jobs.push({ id: parentId, fileId: rep01.driveFileId });
    for (const v of childVids) jobs.push({ id: v.sheetId, fileId: v.driveFileId });
  } else if (plan.videos[0]?.driveFileId) {
    // 単独cr（パターン無し）: 親ブロックにその動画のフレームを入れる
    jobs.push({ id: parentId, fileId: plan.videos[0].driveFileId });
  }
  if (jobs.length === 0) return "skip";

  const repo = env.GITHUB_REPO || "ymd0726/test";
  const ref = env.GITHUB_WORKFLOW_REF || "claude/creative-submission-tool-z5vq8t";
  let dispatched = false;
  for (const t of gasTargets) {
    const res = await fetch(
      `https://api.github.com/repos/${repo}/actions/workflows/cr-thumbnail.yml/dispatches`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${env.GITHUB_DISPATCH_TOKEN}`,
          accept: "application/vnd.github+json",
          "content-type": "application/json",
          "user-agent": "cr-nyukoukun",
        },
        body: JSON.stringify({
          ref,
          inputs: { sheet: t.spreadsheetId, tab: t.sheetName || "", sec: "1", jobs: JSON.stringify(jobs) },
        }),
      }
    );
    // 204 No Content が成功。それ以外はエラー本文を投げて呼び出し側で通知
    if (res.status === 204) dispatched = true;
    else throw new Error(`workflow_dispatch失敗 (${res.status}): ${(await res.text()).slice(0, 200)}`);
  }
  return dispatched ? "ok" : "skip";
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
 *
 * BUG-49: 進捗メッセージがresponse_url枠(5通)を食い潰し、最後の完了通知だけ
 * ドロップして「止まる」ように見える事象があった（Bot未参加/privateチャンネルで
 * ephemeralが使えず response_url に落ちる案件で顕著）。対策として、
 * 進捗(interim)は ephemeral 専用にし response_url には落とさない（届かなくても実害小）。
 * response_url枠は useResponseUrl=true を渡す完了通知・エラー通知のためだけに温存する。
 */
export async function postProgress(
  env: { SLACK_BOT_TOKEN?: string },
  to: { channelId?: string; userId?: string; responseUrl: string },
  text: string,
  useResponseUrl = false
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
        // conversations.joinはpublicチャンネルのみ有効。失敗時は（許可されていれば）response_urlへ
        if (await joinChannel(env.SLACK_BOT_TOKEN, to.channelId)) data = await post();
      }
      if (data.ok) return;
    } catch {
      /* fallthrough */
    }
  }
  // 進捗(interim)は response_url を使わない＝完了/エラー通知の枠を温存する（BUG-49）
  if (!useResponseUrl) return;
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
