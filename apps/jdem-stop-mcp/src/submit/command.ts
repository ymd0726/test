// /cr-in コマンド受付とSlack確認UI
//
// 既存Workerの /slack/command ルーティングから command === "/cr-in" のとき
// handleCrInCommand() を呼ぶ。Interactivity は action_id プレフィックス "crin_" で
// handleCrInInteraction() に振り分ける（既存 /slack/interact に追記）。
//
// 確認ボタンの value には「引数＋選択した広告セット」だけを持たせ、
// 承認時に再度 resolve してから実行する（Slackのvalue 2000字制限対策＋常に最新状態で実行）。

import { SubmitProject, SubmitEnv } from "./types";
import { resolveSubmit } from "./resolve";
import { startExecution, postProgress } from "./continuation";

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

    if (outcome.adsetCandidates) {
      // 広告セット複数 → セットごとに実行ボタン
      blocks.push({
        type: "section",
        text: { type: "mrkdwn", text: "入稿先の広告セットを選んでください（コピー元=各セットの直近cr広告）:" },
      });
      const buttons = outcome.adsetCandidates.slice(0, 5).map((c, i) => ({
        type: "button",
        text: { type: "plain_text", text: truncate(c.campaignName ? `${c.campaignName} / ${c.name}` : c.name, 74) },
        action_id: `crin_exec_${i}`,
        value: JSON.stringify({ a: payload.text.trim(), ad: c.id, s: c.latestAd!.id }),
        confirm: confirmDialog(plan.parentName, `${c.campaignName || ""} / ${c.name}`, c.latestAd!.name),
      }));
      blocks.push({ type: "actions", elements: [...buttons, cancelButton()] });
      if (outcome.adsetCandidates.length > 5) {
        blocks.push({
          type: "context",
          elements: [{ type: "mrkdwn", text: `他 ${outcome.adsetCandidates.length - 5} セットは省略。adsetAllowlistで絞ってください` }],
        });
      }
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

  if (action.action_id.startsWith("crin_exec_")) {
    if (!project) {
      ctx.waitUntil(respond(responseUrl, { text: "案件が特定できません", replace_original: true }));
      return new Response("", { status: 200 });
    }
    const v = JSON.parse(action.value) as { a: string; ad: string; s: string };
    ctx.waitUntil(
      confirmAndRun(v, interaction, project, env, ctx, metaTokenFor(project), gasTargetsFor(project))
    );
    return new Response("", { status: 200 });
  }
  return new Response("", { status: 200 });
}

async function confirmAndRun(
  v: { a: string; ad: string; s: string },
  interaction: any,
  project: SubmitProject,
  env: SubmitEnv,
  ctx: ExecutionContext,
  metaToken: string,
  gasTargets: { spreadsheetId: string; sheetName?: string }[]
): Promise<void> {
  const responseUrl = interaction.response_url;
  try {
    await respond(responseUrl, { text: "🔎 最新状態を確認して実行します…", replace_original: true });
    // 承認時に再解決（ボタン表示中に状況が変わっていても最新で実行）
    const outcome = await resolveSubmit(project, env, metaToken, {
      text: v.a,
      channelId: interaction.channel?.id || interaction.container?.channel_id || "",
      userId: interaction.user?.id || "",
      responseUrl,
    });
    const plan = outcome.plan!;
    plan.adsetId = v.ad;
    const chosen = (outcome.adsetCandidates || []).find((c) => c.id === v.ad);
    if (chosen) {
      plan.adsetName = chosen.name;
      plan.campaignName = chosen.campaignName;
      plan.sourceAdId = chosen.latestAd!.id;
      plan.sourceAdName = chosen.latestAd!.name;
    } else if (!plan.sourceAdId) {
      plan.sourceAdId = v.s;
      plan.sourceAdName = "(直近cr広告)";
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
      `❌ 実行開始に失敗しました: ${e.message}`
    );
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
