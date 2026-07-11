// 翌日自動チェックくん（TOOL-40） オーケストレータ
//
// 毎朝 7:30 JST（Cron "30 22 * * *" UTC）に前日分の実行ログを照合する。
// scheduled() はチェックの起動のみ行い、実処理は /internal/check/continue への
// self-chaining（cr入稿くんと同じ SELF_WORKER 方式）で数runずつ進める。
// 完了時に管理チャンネルへサマリを1通投稿（0件の日も必ず投稿＝沈黙させない）。
// チェッカー自体の異常も catch して 🚨 を投稿する。

import type { CheckDeps, CheckEnv, CheckState, CheckSummary, RunLogRecord, CheckItem } from "./types";
import { queryRunsForDate, fetchRunLog, writeCheckResult } from "./runlog";
import { CHECKERS } from "./checkers";
import { createBugPage } from "./bug";
import { buildSummaryText, postSlack } from "./report";
import { signHmac, verifyHmac } from "../submit/continuation";

export const CHECK_CONTINUE_PATH = "/internal/check/continue";

/** 1ホップで処理するrun数（1runあたりMeta1〜3+Sheets1〜3+Notion2〜4リクエスト） */
const RUNS_PER_HOP = 3;

export interface CheckRunOptions {
  dryRun?: boolean;
  /** YYYY-MM-DD (JST)。省略時は昨日 */
  date?: string;
  /** 投稿先チャンネル上書き（テスト用） */
  channel?: string;
  /** チェック済みrunも再チェックする（BUGはfiledBugsでdedupe） */
  force?: boolean;
}

/** チェック開始（cron / 手動 /check/run 共通の入口） */
export async function startDailyCheck(env: CheckEnv, deps: CheckDeps, opts: CheckRunOptions = {}): Promise<string> {
  const dateJst = opts.date || yesterdayJst();
  const channelId = opts.channel || env.CHECK_SLACK_CHANNEL_ID || "";
  if (!env.NOTION_TOKEN) throw new Error("NOTION_TOKEN未設定のためチェックできません");
  try {
    const runs = await queryRunsForDate(env.NOTION_TOKEN, dateJst, { includeChecked: !!opts.force });
    const state: CheckState = {
      dateJst,
      dryRun: !!opts.dryRun,
      channelId,
      runIds: runs.map((r) => r.pageId),
      cursor: 0,
      startedAt: Date.now(),
      summary: { ok: 0, warn: 0, ng: 0, unknownTool: [], ngLines: [], warnLines: [], okLines: [], errors: [] },
    };
    if (state.runIds.length === 0) {
      const r = await postSlack(env, channelId, buildSummaryText(state, Date.now() - state.startedAt));
      return r.ok ? `0件（投稿済み）` : `0件（Slack投稿失敗: ${r.error}）`;
    }
    await chainNext(state, env);
    return `${state.runIds.length}件のチェックを開始しました（${dateJst}）`;
  } catch (e: any) {
    await postSlack(env, channelId, `🚨 翌日自動チェックくんが起動に失敗しました: ${e.message}`);
    throw e;
  }
}

/** /internal/check/continue ハンドラ */
export async function handleCheckContinue(
  request: Request,
  env: CheckEnv,
  ctx: ExecutionContext,
  deps: CheckDeps
): Promise<Response> {
  const body = await request.text();
  const sig = request.headers.get("x-continuation-signature") || "";
  if (!(await verifyHmac(env.SHARED_SECRET, body, sig))) {
    return new Response("forbidden", { status: 403 });
  }
  const state = JSON.parse(body) as CheckState;
  ctx.waitUntil(runCheckHop(state, env, deps));
  return new Response("ok");
}

/** 手動起動 GET /check/run?token=<SHARED_SECRET>&dryRun=1&date=YYYY-MM-DD&channel=CXXX&force=1 */
export async function handleCheckRun(url: URL, env: CheckEnv, ctx: ExecutionContext, deps: CheckDeps): Promise<Response> {
  if (!env.SHARED_SECRET || url.searchParams.get("token") !== env.SHARED_SECRET) {
    return new Response("forbidden", { status: 403 });
  }
  const opts: CheckRunOptions = {
    dryRun: url.searchParams.get("dryRun") === "1",
    date: url.searchParams.get("date") || undefined,
    channel: url.searchParams.get("channel") || undefined,
    force: url.searchParams.get("force") === "1",
  };
  try {
    const msg = await startDailyCheck(env, deps, opts);
    return json({ ok: true, message: msg, dryRun: !!opts.dryRun });
  } catch (e: any) {
    return json({ ok: false, error: e.message }, 500);
  }
}

// ---- 1ホップ分の実行 ----

async function runCheckHop(state: CheckState, env: CheckEnv, deps: CheckDeps): Promise<void> {
  try {
    const end = Math.min(state.cursor + RUNS_PER_HOP, state.runIds.length);
    for (; state.cursor < end; state.cursor++) {
      const pageId = state.runIds[state.cursor];
      try {
        await checkOneRun(pageId, state, env, deps);
      } catch (e: any) {
        state.summary.errors.push(`${pageId.slice(0, 8)}…: ${String(e.message || e).slice(0, 200)}`);
      }
    }
    if (state.cursor >= state.runIds.length) {
      const r = await postSlack(env, state.channelId, buildSummaryText(state, Date.now() - state.startedAt));
      if (!r.ok) console.log(`check summary post failed: ${r.error}`);
      return; // 連鎖終了
    }
    await chainNext(state, env);
  } catch (e: any) {
    // チェッカー自体の異常（沈黙させない）
    await postSlack(env, state.channelId, `🚨 翌日自動チェックくん自体がエラーで停止しました（${state.cursor}/${state.runIds.length}件処理時点）: ${e.message}`);
  }
}

async function checkOneRun(pageId: string, state: CheckState, env: CheckEnv, deps: CheckDeps): Promise<void> {
  const run = await fetchRunLog(env.NOTION_TOKEN!, pageId);
  const s = state.summary;

  const checker = CHECKERS[run.tool];
  if (!checker) {
    s.unknownTool.push(`${run.tool || "(ツール名なし)"}: ${run.project}/${run.crName}`);
    return;
  }
  const project = deps.projects.find((p) => p.name.toLowerCase() === run.project.toLowerCase());
  const metaToken = project ? deps.metaTokenFor(project) : undefined;
  const items = await checker.check(run, { env, project, metaToken });

  const ngs = items.filter((i) => i.status === "NG");
  const warns = items.filter((i) => i.status === "WARN");
  const overall: "OK" | "警告" | "NG" = ngs.length ? "NG" : warns.length ? "警告" : "OK";

  // BUG起票（NGのみ・dedupe: 過去に同runで起票済みのcheckKeyはスキップ）
  const filedBefore: string[] = Array.isArray(run.checkDetail?.filedBugs) ? run.checkDetail.filedBugs : [];
  const bugPageIds: string[] = [];
  const bugUrls: string[] = [];
  const filedNow: string[] = [...filedBefore];
  if (!state.dryRun) {
    for (const item of ngs) {
      if (filedBefore.includes(item.key)) continue;
      const bug = await createBugPage(env.NOTION_TOKEN!, run, item, state.dateJst);
      if (bug) {
        bugPageIds.push(bug.pageId);
        bugUrls.push(bug.url);
        filedNow.push(item.key);
      }
    }
    await writeCheckResult(env.NOTION_TOKEN!, run.pageId, {
      checkResult: overall,
      checkDetail: {
        checkedAt: new Date().toISOString(),
        items: items.map((i) => ({ key: i.key, status: i.status, message: i.message || "" })),
        filedBugs: filedNow,
      },
      bugPageIds,
    });
  }

  // サマリ行の組み立て
  const head = `• [${run.tool}] ${run.project} / ${run.crName}`;
  const mention = run.userId ? `<@${run.userId}>` : run.userName || "(実行者不明)";
  if (overall === "NG") {
    s.ng++;
    const msgs = ngs.map((i) => `  ${i.message ? `${i.label}: ${i.message}` : i.label}`).join("\n");
    const links = [
      bugUrls.length ? `🐛 BUG: ${bugUrls.join(" , ")}` : state.dryRun ? "🐛 BUG: (dryRunのため未起票)" : "",
      run.url ? `📋 実行ログ: ${run.url}` : "",
    ].filter(Boolean).join("　");
    s.ngLines.push(`${head}\n${msgs}\n  実行者: ${mention} さん、ご確認ください 🙏${links ? `\n  ${links}` : ""}`);
  } else if (overall === "警告") {
    s.warn++;
    const msgs = warns.map((i) => `  ${i.message ? `${i.label}: ${i.message}` : i.label}`).join("\n");
    s.warnLines.push(`${head}\n${msgs}\n  実行者: ${mention}${run.url ? `　📋 ${run.url}` : ""}`);
  } else {
    s.ok++;
    s.okLines.push(`[${run.action}] ${run.project}/${run.crName}`);
  }
}

// ---- 連鎖・ユーティリティ ----

async function chainNext(state: CheckState, env: CheckEnv): Promise<void> {
  const body = JSON.stringify(state);
  const sig = await signHmac(env.SHARED_SECRET, body);
  const init: RequestInit = {
    method: "POST",
    headers: { "content-type": "application/json", "x-continuation-signature": sig },
    body,
  };
  const res = env.SELF_WORKER
    ? await env.SELF_WORKER.fetch(`https://self${CHECK_CONTINUE_PATH}`, init)
    : await fetch(`${env.SELF_URL}${CHECK_CONTINUE_PATH}`, init);
  if (!res.ok) throw new Error(`checkチェーン連鎖失敗: ${res.status}`);
}

/** 昨日(JST)の YYYY-MM-DD */
export function yesterdayJst(): string {
  const jst = new Date(Date.now() + 9 * 3600 * 1000);
  jst.setUTCDate(jst.getUTCDate() - 1);
  return jst.toISOString().slice(0, 10);
}

function json(obj: unknown, status = 200): Response {
  return new Response(JSON.stringify(obj, null, 2), { status, headers: { "content-type": "application/json" } });
}
