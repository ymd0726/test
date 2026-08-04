// /cr-in コマンド受付とSlack確認UI
//
// 既存Workerの /slack/command ルーティングから command === "/cr-in" のとき
// handleCrInCommand() を呼ぶ。Interactivity は action_id プレフィックス "crin_" で
// handleCrInInteraction() に振り分ける（既存 /slack/interact に追記）。
//
// 確認ボタンの value には「引数＋選択した広告セット」だけを持たせ、
// 承認時に再度 resolve してから実行する（Slackのvalue 2000字制限対策＋常に最新状態で実行）。

import { SubmitProject, SubmitEnv } from "./types";
import { resolveSubmit, CrPageAmbiguousError, parseThumbRequest } from "./resolve";
import { startExecution, postProgress, runThumbBackfill } from "./continuation";
import { setEntityStatus } from "./meta";

interface SlashPayload {
  text: string;
  channel_id: string;
  user_id: string;
  response_url: string;
}

/** スラッシュコマンド本体。即時ACK用のレスポンスを返し、解決処理はwaitUntilで継続 */
export function handleCrInCommand(
  payload: SlashPayload,
  project: SubmitProject | undefined,
  env: SubmitEnv,
  ctx: ExecutionContext,
  metaTokenFor: (p: SubmitProject) => string
): Response {
  if (!project) {
    return slackEphemeral("このチャンネルは案件レジストリに未登録です（PROJECTSに追加してください）");
  }
  if (project.submitBlocked) {
    return slackEphemeral(`⚠️ この案件は cr入稿くん が未対応です: ${project.submitBlocked}`);
  }
  ctx.waitUntil(resolveAndAsk(payload, project, env, metaTokenFor(project)));
  return slackEphemeral(`🔎 \`${payload.text.trim()}\` の入稿プランを組み立て中…`);
}

async function resolveAndAsk(
  payload: SlashPayload,
  project: SubmitProject,
  env: SubmitEnv,
  metaToken: string
): Promise<void> {
  try {
    // サムネ後追いモード（BUG-121/122/124）: 通常フローの解決（Notion/Drive/広告セット）は
    // 不要なので先に分岐する。実行はボタン承認後（confirmAndRunのthブランチ）。
    const thumbReq = parseThumbRequest(payload.text);
    if (thumbReq) {
      const desc =
        thumbReq.mode === "one"
          ? `*${thumbReq.crKey}* の親+全パターン子のサムネを、Meta広告の動画から取得して集計表セルへ挿入します（既存サムネは上書き）`
          : "集計表をスキャンし、サムネ未挿入のcrブロックへ一括挿入します（1回で最大10件・再実行で続きから）";
      const blocks: any[] = [
        {
          type: "section",
          text: { type: "mrkdwn", text: `🖼️ *サムネのみ対応*（ブロック追加・Metaへの入稿はしません）\n${desc}` },
        },
        {
          type: "actions",
          elements: [
            {
              type: "button",
              style: "primary",
              text: { type: "plain_text", text: "🖼️ サムネを挿入する" },
              action_id: "crin_exec_0",
              value: JSON.stringify({ a: payload.text.trim(), th: 1 }),
            },
            cancelButton(),
          ],
        },
      ];
      await respond(payload.response_url, { blocks, response_type: "in_channel" });
      return;
    }
    const outcome = await resolveSubmit(project, env, metaToken, {
      text: payload.text,
      channelId: payload.channel_id,
      userId: payload.user_id,
      responseUrl: payload.response_url,
    });
    const plan = outcome.plan!;
    const fileLines = plan.videos
      .map((v) => `・${v.driveFileName}（${(v.fileSizeBytes / 1024 / 1024).toFixed(1)}MB）`)
      .join("\n");
    const overrideLine = summarizeOverrides(plan.overrides);
    const head =
      `📤 *入稿プラン: ${plan.parentName}*\n` +
      `${plan.hasChildren ? `パターン ${plan.videos.length} 本（親はMeta未入稿・集計表のみ）` : "単独CR 1本"}\n` +
      `${fileLines}\n` +
      `テキスト類: ${overrideLine}\n` +
      (outcome.warnings.length ? `\n${outcome.warnings.join("\n")}\n` : "");

    const blocks: any[] = [{ type: "section", text: { type: "mrkdwn", text: head } }];

    if (plan.sheetOnly) {
      // 集計表だけモード（BUG-110）: Meta入稿はスキップし、集計表の展開だけ行う
      const childIds = plan.videos.map((v) => v.sheetId).filter((sid) => /cr\d+_\d{2}/i.test(sid));
      const sheetPlanText =
        `📊 *集計表だけ展開します（Metaへの入稿はしません）*\n` +
        `親: *${plan.crKey}*` +
        (childIds.length ? `\n子: ${childIds.join(", ")}` : "（子パターンなし＝親ブロックのみ）");
      blocks.push({ type: "section", text: { type: "mrkdwn", text: sheetPlanText } });
      blocks.push({
        type: "actions",
        elements: [
          {
            type: "button",
            style: "primary",
            text: { type: "plain_text", text: "📊 集計表だけ展開する" },
            action_id: "crin_exec_0",
            value: JSON.stringify({ a: payload.text.trim(), sheet: 1 }),
            confirm: {
              title: { type: "plain_text", text: "集計表の展開" },
              text: { type: "mrkdwn", text: `*${plan.crKey}* を集計表に展開します（Metaへの入稿はしません）。` },
              confirm: { type: "plain_text", text: "展開する" },
              deny: { type: "plain_text", text: "やめる" },
            },
          },
          cancelButton(),
        ],
      });
      await respond(payload.response_url, { blocks, response_type: "in_channel" });
      return;
    }

    if (outcome.adsetCandidates) {
      // 広告セット複数 → セットごとに実行ボタン。
      // 候補は「直近7日間に消化のあったセット」に絞られている（listAdsetCandidates）。
      // 🟢=配信中(ACTIVE) / ⏸=停止中。消化額の大きい順。
      blocks.push({
        type: "section",
        text: { type: "mrkdwn", text: "入稿先の広告セットを選んでください（コピー元=各セットの直近cr広告）:" },
      });
      // キャンペーン名/広告セット名は section の mrkdwn 本文に置いて全文表示する（BUG-100）。
      // 以前はボタンのlabel（plain_text・1行）に入れていたため、名前が長いとスマホ等で
      // 見切れていた。sectionのmrkdwnは折り返して全文表示され、ボタンは短い固定ラベルにする。
      outcome.adsetCandidates.slice(0, 5).forEach((c, i) => {
        const full = c.campaignName ? `${c.campaignName} / ${c.name}` : c.name;
        blocks.push({
          type: "section",
          text: { type: "mrkdwn", text: `${c.effectiveStatus === "ACTIVE" ? "🟢" : "⏸"} *${full}*` },
          accessory: {
            type: "button",
            text: { type: "plain_text", text: "このセットに入稿", emoji: true },
            action_id: `crin_exec_${i}`,
            value: JSON.stringify({ a: payload.text.trim(), ad: c.id, s: c.latestAd!.id }),
            confirm: confirmDialog(plan.parentName, full, c.latestAd!.name),
          },
        });
      });
      // 店舗ごとに広告セットが分かれる案件（ssh等）向けの複数選択（BUG-135）。
      // 従来は「上位5セットを個別」か「全セットへ一括」の二択しかなく、
      // 「この店舗とこの店舗だけ」という選び方ができなかった。
      // Slackのmulti_static_selectは最大100件。選択値はボタン押下時の state.values から読む
      // （ボタンvalueは2000字制限があり、数十件のIDを詰め込めないため）。
      if (outcome.adsetCandidates.length >= 2) {
        const options = outcome.adsetCandidates.slice(0, ADSET_SELECT_MAX).map((c) => ({
          text: {
            type: "plain_text",
            text: truncate(
              `${c.effectiveStatus === "ACTIVE" ? "🟢" : "⏸"} ${c.campaignName ? `${c.campaignName} / ` : ""}${c.name}`,
              75
            ),
            emoji: true,
          },
          value: c.id,
        }));
        blocks.push({
          type: "section",
          block_id: ADSET_SELECT_BLOCK,
          text: { type: "mrkdwn", text: "*複数の広告セットに入稿する場合はこちらで選択:*" },
          accessory: {
            type: "multi_static_select",
            action_id: ADSET_SELECT_ACTION,
            placeholder: { type: "plain_text", text: "広告セットを選ぶ（複数可）", emoji: true },
            options,
          },
        });
      }
      // 表示中の全セットへ同時入稿するボタン（BUG-31）。テキスト類は各セットの直近cr広告からコピー
      const actionEls: any[] = [];
      if (outcome.adsetCandidates.length >= 2) {
        actionEls.push({
          type: "button",
          style: "primary",
          text: { type: "plain_text", text: "🎯 選択したセットに入稿" },
          action_id: "crin_exec_sel",
          value: JSON.stringify({ a: payload.text.trim(), sel: 1 }),
          confirm: confirmDialog(plan.parentName, "上で選択した広告セット", "各セットの直近cr広告"),
        });
        const allNames = outcome.adsetCandidates.map((c) => c.name).join(" / ");
        actionEls.push({
          type: "button",
          text: { type: "plain_text", text: `🚀 すべてに入稿（${outcome.adsetCandidates.length}セット）` },
          action_id: "crin_exec_all",
          value: JSON.stringify({ a: payload.text.trim(), all: 1 }),
          confirm: confirmDialog(plan.parentName, truncate(allNames, 120), "各セットの直近cr広告"),
        });
      }
      actionEls.push(cancelButton());
      blocks.push({ type: "actions", elements: actionEls });
      const filteredBySpend = outcome.adsetCandidates.some((c) => (c.spend7d ?? 0) > 0);
      const notes: string[] = [
        filteredBySpend
          ? "🟢=配信中 / ⏸=停止中。直近7日間に消化があった広告セットのみ・消化額順"
          : "直近7日間に消化のある広告セットが無いため、ACTIVEな全セットを表示",
      ];
      if (outcome.adsetCandidates.length > 5)
        notes.push(
          `個別ボタンは上位5セットのみ表示（他 ${outcome.adsetCandidates.length - 5} セット）。` +
            "店舗ごとに選んで入稿する場合は上の選択メニューを使ってください"
        );
      if (outcome.adsetCandidates.length > ADSET_SELECT_MAX)
        notes.push(`⚠️ 選択メニューは${ADSET_SELECT_MAX}セットまで表示（候補${outcome.adsetCandidates.length}セット）`);
      blocks.push({
        type: "context",
        elements: [{ type: "mrkdwn", text: notes.join("\n") }],
      });
    } else {
      blocks.push({
        type: "section",
        text: {
          type: "mrkdwn",
          text: `📣 キャンペーン: *${plan.campaignName || "(不明)"}*\n🎯 広告セット: *${plan.adsetName}*\nコピー元: ${plan.sourceAdName}`,
        },
      });
      blocks.push({
        type: "actions",
        elements: [
          {
            type: "button",
            style: "primary",
            text: { type: "plain_text", text: "🚀 入稿を実行（広告はPAUSEDで作成）" },
            action_id: "crin_exec_0",
            value: JSON.stringify({ a: payload.text.trim(), ad: plan.adsetId, s: plan.sourceAdId }),
            confirm: confirmDialog(plan.parentName, plan.adsetName, plan.sourceAdName),
          },
          cancelButton(),
        ],
      });
    }
    await respond(payload.response_url, { blocks, response_type: "in_channel" });
  } catch (e: any) {
    if (e instanceof CrPageAmbiguousError) {
      // CRDB候補が複数 → エラーで止めず、ページ選択ボタンを出す（BUG-27）。
      // 選択後は pageId で再解決するので、以降は通常フローと同じ。
      // ページ名は section の mrkdwn に置いて全文表示（BUG-100。長い名前がボタンlabelで見切れるのを防ぐ）
      const blocks: any[] = [
        {
          type: "section",
          text: { type: "mrkdwn", text: `🔀 Notion CRDBに \`${payload.text.trim()}\` の候補が複数あります。入稿対象を選んでください:` },
        },
      ];
      // パターン指定（例 07,08）はページ選択後の再解決でも維持する（BUG-101）。
      // hydのcr47のようにCRDB候補が複数だと必ずこのpickを通るため、ここで落とすと
      // /cr-in cr47_07 08 の絞り込みが効かなくなる。ボタンvalueにpatを載せて持ち回る。
      const pat = e.patterns && e.patterns.length ? e.patterns : undefined;
      const sh = e.sheetOnly ? 1 : undefined; // 集計表だけモードも維持（BUG-110）
      const modeNote = `${pat ? `　（_${pat.join(", _")} のみ）` : ""}${sh ? "　（集計表だけ）" : ""}`;
      e.candidates.slice(0, 5).forEach((c, i) => {
        blocks.push({
          type: "section",
          text: { type: "mrkdwn", text: `*${c.name || "(無題)"}*${modeNote}` },
          accessory: {
            type: "button",
            text: { type: "plain_text", text: sh ? "このページ（集計表）" : "このページ" },
            action_id: `crin_pick_${i}`,
            value: JSON.stringify({ p: c.pageId, pat, sh }),
          },
        });
      });
      // 全候補をまとめて入稿したいケース（cr83_01/cr83_02のような兄弟ページ。BUG-31続報）:
      // 各ページの入稿プランを順に表示する。実行ボタンはプランごとに出るので誤爆しない
      const pickActions: any[] = [];
      if (e.candidates.length >= 2) {
        pickActions.push({
          type: "button",
          style: "primary",
          text: { type: "plain_text", text: `📤 すべての入稿プランを表示（${Math.min(e.candidates.length, 5)}件）` },
          action_id: "crin_pick_all",
          value: JSON.stringify({ ps: e.candidates.slice(0, 5).map((c) => c.pageId), pat, sh }),
        });
      }
      pickActions.push(cancelButton());
      blocks.push(
        { type: "actions", elements: pickActions },
        {
          type: "context",
          elements: [
            {
              type: "mrkdwn",
              text:
                (e.candidates.length > 5 ? `他 ${e.candidates.length - 5} 件は省略（NotionページURL指定で対応）。` : "") +
                "「すべての入稿プランを表示」は候補ごとにプラン確認→実行ボタンを出します。不要な重複ページをNotion側で削除/リネームすると、次回からこの選択は不要になります",
            },
          ],
        },
      );
      await respond(payload.response_url, { blocks, response_type: "ephemeral" });
      return;
    }
    await respond(payload.response_url, {
      text: `❌ ${e.message}`,
      response_type: "ephemeral",
    });
  }
}

/**
 * Interactivity（action_id が crin_ で始まるもの）。
 * 既存 /slack/interact は即200ACK＋response_url表示の方式なので、それに合わせる。
 */
/** 広告セット複数選択メニュー（BUG-135）。選択値は state.values[block][action] から読む */
const ADSET_SELECT_BLOCK = "crin_adsets_block";
const ADSET_SELECT_ACTION = "crin_adsets_select";
/** Slackのmulti_static_selectのオプション上限は100件 */
const ADSET_SELECT_MAX = 100;

/** 複数選択メニューで選ばれた広告セットIDを block_actions の state から取り出す（BUG-135） */
function selectedAdsetIds(interaction: any): string[] {
  const sel = interaction?.state?.values?.[ADSET_SELECT_BLOCK]?.[ADSET_SELECT_ACTION]?.selected_options;
  return Array.isArray(sel) ? sel.map((o: any) => String(o.value)).filter(Boolean) : [];
}

export function handleCrInInteraction(
  interaction: any,
  project: SubmitProject | undefined,
  env: SubmitEnv,
  ctx: ExecutionContext,
  metaTokenFor: (p: SubmitProject) => string,
  gasTargetsFor: (p: SubmitProject) => { spreadsheetId: string; sheetName?: string }[]
): Response {
  const action = interaction.actions?.[0];
  const responseUrl = interaction.response_url;
  if (!action) return new Response("", { status: 200 });

  if (action.action_id === "crin_cancel") {
    ctx.waitUntil(respond(responseUrl, { text: "キャンセルしました", replace_original: true }));
    return new Response("", { status: 200 });
  }

  // 複数選択メニューの操作自体は「選んだだけ」なので何もしない（200 ACKのみ）。
  // ACKしないとSlackがエラー表示するため、実行ボタンとは別に握りつぶす（BUG-135）
  if (action.action_id === ADSET_SELECT_ACTION) {
    return new Response("", { status: 200 });
  }

  if (action.action_id.startsWith("crin_exec_")) {
    if (!project) {
      ctx.waitUntil(respond(responseUrl, { text: "案件が特定できません", replace_original: true }));
      return new Response("", { status: 200 });
    }
    const v = JSON.parse(action.value) as {
      a: string;
      ad?: string;
      s?: string;
      all?: number;
      sel?: number;
      sheet?: number;
      th?: number;
    };
    // 「選択したセットに入稿」は押した瞬間の選択状態を state から取り出して渡す（BUG-135）
    const picked = v.sel ? selectedAdsetIds(interaction) : [];
    ctx.waitUntil(
      confirmAndRun(v, interaction, project, env, ctx, metaTokenFor(project), gasTargetsFor(project), picked)
    );
    return new Response("", { status: 200 });
  }

  if (action.action_id === "crin_actparent") {
    // 停止中の広告セット/キャンペーンをON（BUG-33）。確認ダイアログ通過後にここへ来る
    if (!project) {
      ctx.waitUntil(respond(responseUrl, { text: "案件が特定できません", replace_original: true }));
      return new Response("", { status: 200 });
    }
    const va = JSON.parse(action.value) as { p: { a: string; c: string }[] };
    ctx.waitUntil(activateParents(va.p, project, env, metaTokenFor(project), responseUrl));
    return new Response("", { status: 200 });
  }

  if (action.action_id === "crin_pick_all") {
    // CRDB候補の全ページ入稿（BUG-31続報）: 各ページの入稿プランを順に組み立てて表示する。
    // 実行ボタンはプランごとに出るため、ユーザーが1件ずつ確認して実行する
    if (!project) {
      ctx.waitUntil(respond(responseUrl, { text: "案件が特定できません", replace_original: true }));
      return new Response("", { status: 200 });
    }
    if (project.submitBlocked) {
      ctx.waitUntil(
        respond(responseUrl, { text: `⚠️ この案件は cr入稿くん が未対応です: ${project.submitBlocked}`, replace_original: true })
      );
      return new Response("", { status: 200 });
    }
    const va = JSON.parse(action.value) as { ps: string[]; pat?: string[]; sh?: number };
    const patSuffix =
      (va.pat && va.pat.length ? " " + va.pat.join(" ") : "") + (va.sh ? " 集計表" : ""); // パターン/集計表モードを維持（BUG-101/110）
    const base = {
      channel_id: interaction.channel?.id || interaction.container?.channel_id || "",
      user_id: interaction.user?.id || "",
      response_url: responseUrl,
    };
    ctx.waitUntil(
      (async () => {
        await respond(responseUrl, { text: `🔎 ${va.ps.length}件の入稿プランを順に組み立て中…`, replace_original: true });
        for (const p of va.ps) {
          await resolveAndAsk({ ...base, text: p + patSuffix }, project, env, metaTokenFor(project));
        }
      })()
    );
    return new Response("", { status: 200 });
  }

  if (action.action_id.startsWith("crin_pick_")) {
    // CRDB候補選択（BUG-27）: 選んだpageIdを引数にして通常の解決フローへ入り直す
    if (!project) {
      ctx.waitUntil(respond(responseUrl, { text: "案件が特定できません", replace_original: true }));
      return new Response("", { status: 200 });
    }
    if (project.submitBlocked) {
      ctx.waitUntil(
        respond(responseUrl, { text: `⚠️ この案件は cr入稿くん が未対応です: ${project.submitBlocked}`, replace_original: true })
      );
      return new Response("", { status: 200 });
    }
    const v = JSON.parse(action.value) as { p: string; pat?: string[]; sh?: number };
    // pageId の後ろにパターン番号・集計表キーワードを付けて再解決に渡す（BUG-101/110）。
    // resolveSubmitは先頭トークンをNotionID直指定、残りトークンをパターン/モード指定として拾う。
    const pickText =
      v.p + (v.pat && v.pat.length ? " " + v.pat.join(" ") : "") + (v.sh ? " 集計表" : "");
    const payload: SlashPayload = {
      text: pickText,
      channel_id: interaction.channel?.id || interaction.container?.channel_id || "",
      user_id: interaction.user?.id || "",
      response_url: responseUrl,
    };
    ctx.waitUntil(
      respond(responseUrl, { text: "🔎 選択したページで入稿プランを組み立て中…", replace_original: true }).then(() =>
        resolveAndAsk(payload, project, env, metaTokenFor(project))
      )
    );
    return new Response("", { status: 200 });
  }
  return new Response("", { status: 200 });
}

async function confirmAndRun(
  v: { a: string; ad?: string; s?: string; all?: number; sel?: number; sheet?: number; th?: number },
  interaction: any,
  project: SubmitProject,
  env: SubmitEnv,
  ctx: ExecutionContext,
  metaToken: string,
  gasTargets: { spreadsheetId: string; sheetName?: string }[],
  /** 複数選択メニューで選ばれた広告セットID（v.sel のときのみ使う。BUG-135） */
  pickedAdsetIds: string[] = []
): Promise<void> {
  const responseUrl = interaction.response_url;
  try {
    if (project.submitBlocked) throw new Error(`この案件は cr入稿くん が未対応です: ${project.submitBlocked}`);
    if (v.th) {
      // サムネ後追いモード（BUG-121/122/124）: resolve（Notion/Drive/広告セット）を踏まず直接実行
      const tb = parseThumbRequest(v.a);
      await respond(responseUrl, { text: "🖼️ サムネ挿入を実行します…", replace_original: true });
      await runThumbBackfill(env, project, metaToken, gasTargets, {
        crKey: tb && tb.mode === "one" ? tb.crKey : undefined,
        channelId: interaction.channel?.id || interaction.container?.channel_id || "",
        userId: interaction.user?.id || "",
        userName: interaction.user?.username || interaction.user?.name || "",
        responseUrl,
      });
      return;
    }
    await respond(responseUrl, { text: "🔎 最新状態を確認して実行します…", replace_original: true });
    // 承認時に再解決（ボタン表示中に状況が変わっていても最新で実行）
    const outcome = await resolveSubmit(project, env, metaToken, {
      text: v.a,
      channelId: interaction.channel?.id || interaction.container?.channel_id || "",
      userId: interaction.user?.id || "",
      responseUrl,
    });
    const plan = outcome.plan!;
    plan.userName = interaction.user?.username || interaction.user?.name || ""; // 実行ログDB用（TOOL-40）
    if (plan.sheetOnly) {
      // 集計表だけモード（BUG-110）: Metaステップは踏まず sheet から実行する。
      // metaAdAccountId未設定の案件でも動くよう、accountIdは空で渡す（sheetステップは使わない）
      await startExecution(plan, env, ctx, metaToken, project.metaAdAccountId || "", gasTargets);
      return;
    }
    const cands = (outcome.adsetCandidates || []).filter((c) => c.latestAd);
    if (v.all || v.sel) {
      // 「すべてに入稿」（BUG-31）: 表示された全候補セットをターゲットにする。
      // 「選択したセットに入稿」（BUG-135）: 選ばれたIDだけに絞る（店舗ごとの複数選択）。
      // 再解決の結果1セットに減っていた場合はそのまま単一入稿になる
      if (cands.length === 0 && !plan.adsetId)
        throw new Error("入稿先の広告セット候補が見つかりません（状況が変わった可能性）。もう一度 /cr-in を実行してください");
      let picked = cands;
      if (v.sel) {
        if (pickedAdsetIds.length === 0)
          throw new Error(
            "広告セットが選択されていません。選択メニューで入稿先の広告セットを選んでから「🎯 選択したセットに入稿」を押してください"
          );
        const wanted = new Set(pickedAdsetIds);
        picked = cands.filter((c) => wanted.has(c.id));
        if (picked.length === 0)
          throw new Error(
            "選択した広告セットが候補に見つかりませんでした（状況が変わった可能性）。もう一度 /cr-in を実行してください"
          );
      }
      if (picked.length > 0) {
        plan.targets = picked.map((c) => ({
          adsetId: c.id,
          adsetName: c.name,
          campaignName: c.campaignName,
          sourceAdId: c.latestAd!.id,
          sourceAdName: c.latestAd!.name,
        }));
        const first = plan.targets[0];
        plan.adsetId = first.adsetId;
        plan.adsetName = first.adsetName;
        plan.campaignName = first.campaignName;
        plan.sourceAdId = first.sourceAdId;
        plan.sourceAdName = first.sourceAdName;
      }
    } else {
      plan.adsetId = v.ad!;
      const chosen = cands.find((c) => c.id === v.ad);
      if (chosen) {
        plan.adsetName = chosen.name;
        plan.campaignName = chosen.campaignName;
        plan.sourceAdId = chosen.latestAd!.id;
        plan.sourceAdName = chosen.latestAd!.name;
      } else if (!plan.sourceAdId) {
        plan.sourceAdId = v.s!;
        plan.sourceAdName = "(直近cr広告)";
      }
    }
    if (!project.metaAdAccountId) throw new Error("metaAdAccountId未設定");
    await startExecution(plan, env, ctx, metaToken, project.metaAdAccountId, gasTargets);
  } catch (e: any) {
    await postProgress(
      env,
      {
        channelId: interaction.channel?.id || interaction.container?.channel_id,
        userId: interaction.user?.id,
        responseUrl,
      },
      `❌ 実行開始に失敗しました: ${e.message}`,
      true
    );
  }
}

/**
 * 停止中の広告セット/キャンペーンをONにする（BUG-33）。キャンペーン→広告セットの順（上位から）。
 * 同じIDは1回だけ。結果をresponse_urlで返す。
 */
async function activateParents(
  pairs: { a: string; c: string }[],
  project: SubmitProject,
  env: SubmitEnv,
  metaToken: string,
  responseUrl: string
): Promise<void> {
  try {
    const campaigns = [...new Set(pairs.map((p) => p.c).filter(Boolean))];
    const adsets = [...new Set(pairs.map((p) => p.a).filter(Boolean))];
    const done: string[] = [];
    const failed: string[] = [];
    for (const c of campaigns) {
      try { await setEntityStatus(c, metaToken, "ACTIVE"); done.push(`cp:${c}`); }
      catch (e: any) { failed.push(`cp:${c}(${e.message})`); }
    }
    for (const a of adsets) {
      try { await setEntityStatus(a, metaToken, "ACTIVE"); done.push(`adset:${a}`); }
      catch (e: any) { failed.push(`adset:${a}(${e.message})`); }
    }
    const parts: string[] = [];
    if (done.length) parts.push(`✅ ONにしました: ${done.join(" / ")}`);
    if (failed.length) parts.push(`❌ 失敗: ${failed.join(" / ")}`);
    await respond(responseUrl, { text: parts.join("\n") || "対象がありませんでした", replace_original: true });
  } catch (e: any) {
    await respond(responseUrl, { text: `❌ 上位のON化に失敗しました: ${e.message}`, replace_original: true });
  }
}

// ---- UI部品 ----

function confirmDialog(cr: string, adset: string, sourceAd: string) {
  return {
    title: { type: "plain_text", text: "入稿の確認" },
    text: {
      type: "mrkdwn",
      text: `*${cr}* を広告セット「${adset}」へ入稿します。\nテキスト類のコピー元: ${sourceAd}\n広告はPAUSEDで作成されます。`,
    },
    confirm: { type: "plain_text", text: "実行する" },
    deny: { type: "plain_text", text: "やめる" },
  };
}

function cancelButton() {
  return {
    type: "button",
    text: { type: "plain_text", text: "キャンセル" },
    action_id: "crin_cancel",
    value: "cancel",
  };
}

function slackEphemeral(text: string): Response {
  return new Response(JSON.stringify({ response_type: "ephemeral", text }), {
    headers: { "content-type": "application/json" },
  });
}

async function respond(responseUrl: string, payload: any): Promise<void> {
  await fetch(responseUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
}

function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n - 1) + "…" : s;
}

function summarizeOverrides(o: { message?: string; title?: string; linkUrl?: string }): string {
  const parts: string[] = [];
  if (o.message) parts.push("メインテキスト=Notion指定");
  if (o.title) parts.push("見出し=Notion指定");
  if (o.linkUrl) parts.push("URL=Notion指定");
  return parts.length ? parts.join(" / ") : "コピー元広告から引き継ぎ（cr=パラメータのみ自動更新）";
}
