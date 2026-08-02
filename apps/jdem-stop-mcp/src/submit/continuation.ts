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

import { ContinuationState, SubmitEnv, SubmitPlan, MAX_READY_ATTEMPTS, UPLOAD_CHUNK_BYTES, UPLOAD_CHUNKS_PER_HOP } from "./types";
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
  findCrAdsWithVideos,
  CrAdVideo,
} from "./meta";
import { callSheetSubmit, callSheetCheck, callSheetThumbnail, callSheetThumbList } from "./gasClient";
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
  // 集計表だけモード（BUG-110）はMetaステップ(upload/create_ads/activate)を全てスキップしsheetから開始
  const state: ContinuationState = {
    step: plan.sheetOnly ? "sheet" : "upload",
    index: 0,
    attempts: 0,
    plan,
    startedAt: Date.now(),
  };
  // 実行ログDB（TOOL-40）: 開始時に「実行中」で作成。翌朝チェックの照合キー（親cr/子cr/入稿先）も先に記録する
  const runDetail = {
    parentSheetId: sheetParentId(plan),
    childSheetIds: plan.videos.map((v) => v.sheetId).filter((sid) => /cr\d+_\d{2}/i.test(sid)),
  };
  (plan as any)._runDetail = runDetail;
  plan.runLogPageId = await createRunLog(env.NOTION_TOKEN, {
    tool: "cr入稿くん",
    action: plan.sheetOnly ? "集計表展開" : "入稿",
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
  await postProgress(
    env,
    plan,
    plan.sheetOnly
      ? `📊 集計表だけ展開します: *${plan.parentName}*（Metaへの入稿はしません）${logWarn}`
      : `🚀 入稿を開始します: *${plan.parentName}*（動画 ${plan.videos.length} 本）${logWarn}`
  );
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
        const driveToken = await driveAccessToken(env.GOOGLE_SERVICE_ACCOUNT_JSON);
        // BUG-119: 大きな動画（blaの1分動画は約70MB=約9チャンク）を1ホップで全チャンク送ると
        // 単一ホップの実行時間/CPU上限を超え、Workerがcatchを通らずサイレント終了する
        // （runは「実行中」のまま残り、通知も出ない）。1ホップ最大 UPLOAD_CHUNKS_PER_HOP 個ずつ
        // 送り、未完ならセッションを保存して同じuploadステップへ連鎖して継続する。
        let session = state.uploadSession || (await startVideoUpload(accountId, metaToken, v.fileSizeBytes));
        const totalChunks = Math.max(1, Math.ceil(v.fileSizeBytes / UPLOAD_CHUNK_BYTES));
        const doneBefore = Math.floor(session.startOffset / UPLOAD_CHUNK_BYTES);
        await postProgress(
          env,
          plan,
          `⏳ ${v.adName} をアップロード中… (${state.index + 1}/${plan.videos.length} 本, ${Math.min(doneBefore + 1, totalChunks)}/${totalChunks} ブロック)`
        );
        let sent = 0;
        while (session.startOffset < v.fileSizeBytes && sent < UPLOAD_CHUNKS_PER_HOP) {
          const prevOffset = session.startOffset;
          session = await transferVideoChunk(accountId, metaToken, session, driveToken, v.driveFileId);
          sent += 1;
          // オフセットが進まない場合は無限ループ防止のため明示エラー（通常Metaが必ず前進させる）
          if (session.startOffset <= prevOffset) {
            throw new Error(`動画 ${v.adName} のアップロードが進みません (offset=${session.startOffset}/${v.fileSizeBytes})`);
          }
        }
        if (session.startOffset < v.fileSizeBytes) {
          // まだ残りがある → セッションを保存し、同じ動画のuploadを次ホップで継続（fresh budget）
          state.uploadSession = session;
          break; // step/index はそのまま。chainNextで同じuploadステップへ
        }
        await finishVideoUpload(accountId, metaToken, session, v.adName);
        v.videoId = session.videoId;
        state.uploadSession = undefined;
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
          // 集計表は生のスプレッドシートID（長い）ではなくSlackリンクで表示する（BUG-105）。
          // 表示名はタブ名（GASが返す実タブ名を優先）。gid未取得なので/editでシートを開く。
          const tabName = t.sheetName || r.sheetName || "集計表";
          const label = sheetLink(t.spreadsheetId, tabName);
          // GASからの警告（分類プルダウン未反映・判定行未検出等）は完了通知に必ず表示する。
          // 以前は握りつぶしていたため、集計表側の設定漏れに気づけなかった（BUG-68）。
          // ただし判定行が構造的に無い案件（nrc等 noJudgeRow）では、判定行未検出は「正常」なので
          // ⚠️警告ではなく ℹ️案内にトーンダウンする（BUG-115）。他の警告は従来どおり⚠️で顕在化。
          let warnSuffix = "";
          if (r.ok && r.warnings?.length) {
            const judgeWarns: string[] = [];
            const otherWarns: string[] = [];
            for (const w of r.warnings) {
              if (plan.noJudgeRow && /判定行/.test(w)) judgeWarns.push(w);
              else otherWarns.push(w);
            }
            const parts: string[] = [];
            if (otherWarns.length) parts.push(`⚠️ ${otherWarns.join(" / ")}`);
            if (judgeWarns.length) parts.push("ℹ️ この案件は判定行が無い構造のため「子にて判定」は元々不要です（正常）");
            if (parts.length) warnSuffix = ` ${parts.join(" ")}`;
          }
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
        // 集計表だけモード（BUG-110）: Meta関連の行を出さず、集計表結果に絞った完了通知にする
        if (plan.sheetOnly) {
          const childIds = plan.videos.map((v) => v.sheetId).filter((sid) => /cr\d+_\d{2}/i.test(sid));
          const lines = [
            `:bar_chart: 集計表の展開が完了しました: ${plan.parentName}`,
            "",
            `:white_check_mark: 親： ${sheetParentId(plan)}${childIds.length ? ` ／ 子： ${childIds.join(", ")}` : "（親ブロックのみ）"}`,
            `:white_check_mark: 集計表： ${sheetNames}`,
            // 集計表のみ対応であることを明記（BUG-124）: 通常入稿と見分けがつかず
            // 「Metaにも入稿された」と誤解されるのを防ぐ
            `:information_source: Metaには入稿していません（集計表のみ対応）`,
          ];
          // サムネ: Metaに動画が無い(=videoIdなし)ため、ffmpeg(Actions/Drive)経路のみ対応。トークンありなら起動
          if (!sheetNames.includes("❌") && env.GITHUB_DISPATCH_TOKEN) {
            try {
              const tr = await triggerThumbnailWorkflow(env, plan, gasTargets);
              if (tr === "ok") lines.push(":frame_with_picture: サムネ： 集計表へ0:01フレームを自動挿入中（30秒〜1分半後に反映）");
            } catch { /* サムネ失敗は致命ではない */ }
          }
          await updateRunLog(env.NOTION_TOKEN, plan.runLogPageId, {
            status: sheetNames.includes("❌") || sheetNames.includes("確認できませんでした") ? "一部失敗" : "完了",
            sheetResult: sheetNames.includes("❌") ? "失敗" : "成功",
          });
          const posted = await postPublic(env, plan.channelId, lines.join("\n"));
          if (!posted) await postProgress(env, plan, lines.join("\n"), true);
          return;
        }
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
              const r = await insertMetaThumbnails(env, plan, metaToken, gasTargets);
              if (r.inserted > 0) lines.push(`:frame_with_picture: サムネ： 集計表に挿入しました（${r.inserted}件）`);
              // 失敗を握りつぶさず可視化する（BUG-121: サムネ欠落が黙って発生し原因が追えなかった）
              if (r.failures.length > 0)
                lines.push(
                  `:warning: サムネ挿入 失敗${r.failures.length}件: ${r.failures.slice(0, 5).join(" / ")}${r.failures.length > 5 ? " …" : ""}` +
                    `（\`/cr-in ${plan.crKey} サムネ\` で後追い挿入できます）`
                );
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
 * 失敗は握りつぶさず理由付きで返す（BUG-121: サムネ欠落が黙って起きると原因が追えない）。
 */
async function insertMetaThumbnails(
  env: SubmitEnv,
  plan: SubmitPlan,
  metaToken: string,
  gasTargets: { spreadsheetId: string; sheetName?: string }[]
): Promise<{ inserted: number; failures: string[] }> {
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
  const failures: string[] = [];
  let inserted = 0;
  if (items.length === 0) return { inserted, failures };

  const gasUrl = env.SUBMIT_GAS_URL || env.COMMON_GAS_URL;
  for (const it of items) {
    // サムネURL（create_adsで取得済み。再実行等で未取得なら取り直す）
    const img = await fetchThumbBase64(it.videoId, metaToken, it.thumbUrl);
    if (!img.data) {
      failures.push(`${it.id}(${img.reason})`);
      continue;
    }
    for (const t of gasTargets) {
      const res = await callSheetThumbnail(gasUrl, {
        spreadsheetId: t.spreadsheetId,
        sheetName: t.sheetName,
        id: it.id,
        imageBase64: img.data.b64,
        mimeType: img.data.mime,
      });
      if (res.ok) inserted++;
      else failures.push(`${it.id}(GAS: ${res.error || "不明"})`);
    }
  }
  return { inserted, failures };
}

/**
 * Meta動画の自動生成サムネを取得してbase64化する（insertMetaThumbnails / サムネ後追いの共通部）。
 * 失敗時は data=null と理由を返す（呼び出し側が失敗一覧に載せる）。
 */
async function fetchThumbBase64(
  videoId: string,
  metaToken: string,
  knownUrl?: string
): Promise<{ data: { b64: string; mime: string } | null; reason: string }> {
  let url = knownUrl;
  try {
    if (!url) url = (await getVideoThumbnailUrl(videoId, metaToken)) || undefined;
  } catch (e: any) {
    return { data: null, reason: `サムネURL取得失敗: ${String(e.message || e).slice(0, 80)}` };
  }
  if (!url) return { data: null, reason: "サムネ未生成" };
  try {
    const r = await fetch(url);
    if (!r.ok) return { data: null, reason: `画像取得HTTP ${r.status}` };
    const mime = r.headers.get("content-type") || "image/jpeg";
    const b64 = abToBase64(await r.arrayBuffer());
    if (!b64) return { data: null, reason: "画像が空" };
    return { data: { b64, mime }, reason: "" };
  } catch {
    return { data: null, reason: "画像取得失敗" };
  }
}

// 1回のサムネ後追い実行で処理する最大件数（Worker実行上限対策）。挿入済みは次回スキャンの
// missingから消えるため、再実行すれば続きから自然に進む（チェーン不要の冪等設計）。
const THUMB_BACKFILL_MAX_IDS = 10;

/**
 * サムネ後追い挿入（BUG-121/122/124）。サムネ挿入は入稿フローが最後まで成功した
 * doneステップでしか走らないため、途中失敗・再実行・旧バージョン入稿分のcrはセルが
 * 空のまま残る事象が繰り返し起きていた。入稿フローとは独立に、既存Meta広告の動画
 * サムネを集計表へ挿入し直す。
 * - crKey指定（/cr-in cr93 サムネ）: そのcrの親+全パターン子へ上書き挿入（冪等）
 * - crKey省略（/cr-in サムネ一括）: GAS listCrMissingThumbs で未挿入crを列挙して挿入。
 *   デプロイ済みGASが古い場合は再デプロイ案内を出して安全に終了する。
 */
export async function runThumbBackfill(
  env: SubmitEnv,
  project: { name: string; metaAdAccountId?: string },
  metaToken: string,
  gasTargets: { spreadsheetId: string; sheetName?: string }[],
  req: { crKey?: string; channelId: string; userId: string; userName?: string; responseUrl: string }
): Promise<void> {
  const slackCtx = { channelId: req.channelId, userId: req.userId, responseUrl: req.responseUrl } as any;
  try {
    if (!project.metaAdAccountId)
      throw new Error(`案件「${project.name}」にmetaAdAccountIdが未設定のため、Metaからサムネを取得できません`);
    const accountId = project.metaAdAccountId;
    const gasUrl = env.SUBMIT_GAS_URL || env.COMMON_GAS_URL;
    await postProgress(
      env,
      slackCtx,
      req.crKey ? `🖼️ ${req.crKey} のサムネ挿入を開始します…` : "🖼️ 集計表のサムネ未挿入crをスキャンしています…"
    );
    const runLogPageId = await createRunLog(env.NOTION_TOKEN, {
      tool: "cr入稿くん",
      action: "サムネ挿入",
      project: project.name,
      crName: req.crKey || "サムネ一括",
      userName: req.userName,
      userId: req.userId,
      route: "Slack",
      sheetTabs: gasTargets.map((t) => t.sheetName || "").filter(Boolean),
    });

    // 対象 (集計表タブ, id) を集める
    type Job = { target: { spreadsheetId: string; sheetName?: string }; id: string };
    let jobs: Job[] = [];
    let remaining = 0;
    let needGasRedeploy = false;
    if (req.crKey) {
      // 指定crモード: Meta広告から実在パターンを列挙し、親+子を全タブへ上書き挿入（冪等）
      const ads = await findCrAdsWithVideos(accountId, metaToken, req.crKey);
      if (ads.length === 0)
        throw new Error(
          `Meta広告アカウントに「${req.crKey}」の広告が見つかりません（集計表のみ運用のcrはMetaにサムネ取得元が無いため対象外です）`
        );
      const ids = [req.crKey, ...[...new Set(ads.filter((a) => a.pattern).map((a) => `${req.crKey}_${a.pattern}`))].sort()];
      for (const t of gasTargets) for (const id of ids) jobs.push({ target: t, id });
    } else {
      // 一括モード: GASでサムネ未挿入crを列挙（新action。古いGASデプロイでは「不明なaction」）
      for (const t of gasTargets) {
        const res = await callSheetThumbList(gasUrl, { spreadsheetId: t.spreadsheetId, sheetName: t.sheetName });
        if (!res.ok) {
          if (/不明なaction/.test(res.error || "")) {
            needGasRedeploy = true;
            continue;
          }
          throw new Error(`集計表スキャン失敗（${t.sheetName || t.spreadsheetId}）: ${res.error}`);
        }
        for (const id of res.missing || []) jobs.push({ target: t, id });
      }
      if (needGasRedeploy && jobs.length === 0) {
        await postProgress(
          env,
          slackCtx,
          "⚠️ 入稿GASが古く、サムネ未挿入スキャン（listCrMissingThumbs）に未対応です。入稿GASの再デプロイをお願いします（最新目印: listCrMissingThumbs）。個別の `/cr-in <cr名> サムネ` はGAS再デプロイ無しで使えます",
          true
        );
        await updateRunLog(env.NOTION_TOKEN, runLogPageId, { status: "失敗", detail: { reason: "GAS未対応(listCrMissingThumbs)" } });
        return;
      }
      if (jobs.length > THUMB_BACKFILL_MAX_IDS) {
        remaining = jobs.length - THUMB_BACKFILL_MAX_IDS;
        jobs = jobs.slice(0, THUMB_BACKFILL_MAX_IDS);
      }
      if (jobs.length === 0 && !needGasRedeploy) {
        await postProgress(env, slackCtx, "✅ サムネ未挿入のcrはありませんでした（全ブロック挿入済み）", true);
        await updateRunLog(env.NOTION_TOKEN, runLogPageId, { status: "完了", detail: { inserted: [] } });
        return;
      }
    }

    // cr番号ごとにMeta検索を1回にまとめて処理する
    const byCr = new Map<string, Job[]>();
    for (const j of jobs) {
      const key = (j.id.match(/cr\d+/i)?.[0] || j.id).toLowerCase();
      if (!byCr.has(key)) byCr.set(key, []);
      byCr.get(key)!.push(j);
    }
    const done: string[] = [];
    const failed: string[] = [];
    const b64Cache = new Map<string, { b64: string; mime: string } | null>();
    for (const [crKey, crJobs] of byCr) {
      let ads: CrAdVideo[] = [];
      try {
        ads = await findCrAdsWithVideos(accountId, metaToken, crKey);
      } catch (e: any) {
        for (const j of crJobs) failed.push(`${j.id}(Meta検索失敗)`);
        continue;
      }
      for (const j of crJobs) {
        // 子(_NN)はパターン一致、親は_01優先（「親は01」運用）、無ければ単独広告の動画を使う
        const nn = j.id.match(/cr\d+_(\d{2})/i)?.[1];
        const ad = nn
          ? ads.find((a) => a.pattern === nn && a.videoId)
          : ads.find((a) => a.pattern === "01" && a.videoId) ||
            ads.find((a) => !a.pattern && a.videoId) ||
            ads.find((a) => a.videoId);
        if (!ad?.videoId) {
          failed.push(`${j.id}(Metaに対応する動画広告なし)`);
          continue;
        }
        let img = b64Cache.get(ad.videoId);
        if (img === undefined) {
          const r = await fetchThumbBase64(ad.videoId, metaToken);
          img = r.data;
          b64Cache.set(ad.videoId, img);
          if (!img) {
            failed.push(`${j.id}(${r.reason})`);
            continue;
          }
        }
        if (!img) {
          failed.push(`${j.id}(サムネ取得失敗)`);
          continue;
        }
        const res = await callSheetThumbnail(gasUrl, {
          spreadsheetId: j.target.spreadsheetId,
          sheetName: j.target.sheetName,
          id: j.id,
          imageBase64: img.b64,
          mimeType: img.mime,
        });
        if (res.ok) done.push(j.id);
        else failed.push(`${j.id}(GAS: ${res.error || "不明"})`);
      }
    }

    // 完了通知: サムネのみ対応であること（ブロック追加・Meta入稿なし）を明記する（BUG-124）
    const lines = [
      `🖼️ サムネのみ対応が完了しました${req.crKey ? `: ${req.crKey}` : "（一括スキャン）"}（ブロック追加・Metaへの入稿はしていません）`,
      done.length ? `✅ 挿入: ${done.join(", ")}` : "✅ 挿入: 0件",
    ];
    if (failed.length)
      lines.push(`⚠️ 失敗: ${failed.slice(0, 8).join(" / ")}${failed.length > 8 ? ` 他${failed.length - 8}件` : ""}`);
    if (remaining > 0)
      lines.push(`⏭ 未処理が残り${remaining}件あります。もう一度 \`/cr-in サムネ一括\` を実行すると続きから処理されます`);
    if (needGasRedeploy)
      lines.push("⚠️ 一部タブは入稿GASが古くスキャンできませんでした（要GAS再デプロイ。最新目印: listCrMissingThumbs）");
    const posted = await postPublic(env, req.channelId, lines.join("\n"));
    if (!posted) await postProgress(env, slackCtx, lines.join("\n"), true);
    await updateRunLog(env.NOTION_TOKEN, runLogPageId, {
      status: failed.length ? "一部失敗" : "完了",
      sheetResult: failed.length ? "失敗" : "成功",
      detail: { inserted: done, failed: failed.slice(0, 20), remaining },
    });
  } catch (e: any) {
    await postProgress(env, slackCtx, `❌ サムネ挿入に失敗しました: ${e.message}`, true);
  }
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

/** 集計表をSlackのクリック可能リンクで表示（BUG-105。生のスプレッドシートIDは長いため） */
function sheetLink(spreadsheetId: string, text: string): string {
  const url = `https://docs.google.com/spreadsheets/d/${spreadsheetId}/edit`;
  // Slackリンクのtext内で | と > はエスケープ（表示崩れ防止）
  const safe = String(text).replace(/[|>]/g, " ").trim() || "集計表";
  return `<${url}|${safe}>`;
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
