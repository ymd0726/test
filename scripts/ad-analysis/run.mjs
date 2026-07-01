// 継続分析エージェント（GitHub Actions 版）
// ------------------------------------------------------------
// 流れ:
//   1. Notion CLDB から『分析頻度』が対象(週次/月次)の案件を取得
//   2. 各案件の『集計表URL』(Google Sheets) をサービスアカウントで読む
//   3. 対象期間のシート内容を Claude に渡し、KPI抽出＋分析本文を生成
//   4. Notion「広告分析ログDB」へ upsert（同一 案件×期間×粒度 は更新＝育てる/二重作成しない）
//   5. Slack に結果を通知
//
// 実行: node run.mjs weekly   |   node run.mjs monthly
// 必要な環境変数は README.md を参照。
// ------------------------------------------------------------

import { google } from "googleapis";

// ---- 固定設定（対象DB）--------------------------------------
const CLDB_DATABASE_ID = "a0fdb84adf024e668fc847df0c44dcee"; // CLDB(案件別のDB)
const ANALYSIS_DB_ID = "75d963602bf24c4fbb6b4fbcd3ef02be"; // 広告分析ログ
const NOTION_VERSION = "2022-06-28";
const MODEL = process.env.ANTHROPIC_MODEL || "claude-sonnet-5";
const DRY_RUN = String(process.env.DRY_RUN || "").toLowerCase() === "true";
const SHEET_CHAR_BUDGET = 60000; // Claude へ渡すシート本文の上限（トークン節約）

// ---- 環境変数 ------------------------------------------------
const NOTION_TOKEN = req("NOTION_TOKEN");
const ANTHROPIC_API_KEY = req("ANTHROPIC_API_KEY");
const GOOGLE_SERVICE_ACCOUNT_JSON = req("GOOGLE_SERVICE_ACCOUNT_JSON");
const SLACK_WEBHOOK_URL = process.env.SLACK_WEBHOOK_URL || "";

function req(name) {
  const v = process.env[name];
  if (!v) {
    console.error(`ERROR: 環境変数 ${name} が未設定です。`);
    process.exit(1);
  }
  return v;
}

// ---- メイン --------------------------------------------------
const MODE = (process.argv[2] || "weekly").toLowerCase(); // weekly | monthly
if (!["weekly", "monthly"].includes(MODE)) {
  console.error(`不明なモード: ${MODE}（weekly か monthly）`);
  process.exit(1);
}
const GRAN = MODE === "weekly" ? "週次" : "月次";

const period = MODE === "weekly" ? lastWeekJST() : lastMonthJST();
console.log(`[start] mode=${MODE} 対象頻度=${GRAN} 期間=${period.start}〜${period.end} DRY_RUN=${DRY_RUN}`);

const sheetsApi = await makeSheetsClient();

const clients = await fetchDueClients(GRAN);
console.log(`[clients] 対象案件 ${clients.length} 件`);

const results = { created: [], updated: [], skipped: [] };

for (const c of clients) {
  try {
    if (!c.sheetUrl) {
      results.skipped.push(`${c.name}（集計表URL未設定）`);
      continue;
    }
    const parsed = parseSheetUrl(c.sheetUrl);
    if (!parsed) {
      results.skipped.push(`${c.name}（集計表URL解析不可）`);
      continue;
    }
    const sheetText = await readSheet(parsed.spreadsheetId, parsed.gid, c.tabName);
    if (!sheetText) {
      results.skipped.push(`${c.name}（シート読取不可/空）`);
      continue;
    }

    const analysis = await analyzeWithClaude(c.name, period, sheetText);
    if (!analysis || analysis.found === false) {
      results.skipped.push(`${c.name}（${analysis?.reason || "対象期間のデータ無し"}）`);
      continue;
    }

    const title = `${abbr(c.name)}_${period.tag}_${GRAN}`;
    const existing = await findExisting(c.pageId, period.start);

    if (DRY_RUN) {
      console.log(`[dry-run] ${existing ? "UPDATE" : "CREATE"} ${title}`, JSON.stringify(analysis.kpi));
      (existing ? results.updated : results.created).push(title);
      continue;
    }

    if (existing) {
      await updateRecord(existing.id, c, period, title, analysis);
      results.updated.push(title);
    } else {
      await createRecord(c, period, title, analysis);
      results.created.push(title);
    }
    console.log(`[ok] ${existing ? "updated" : "created"} ${title}`);
  } catch (e) {
    console.error(`[err] ${c.name}:`, e.message);
    results.skipped.push(`${c.name}（エラー: ${e.message}）`);
  }
}

const summary =
  `【${GRAN} 広告分析】期間 ${period.start}〜${period.end}\n` +
  `作成 ${results.created.length} / 更新 ${results.updated.length} / スキップ ${results.skipped.length}\n` +
  (results.created.length ? `作成: ${results.created.join(", ")}\n` : "") +
  (results.updated.length ? `更新: ${results.updated.join(", ")}\n` : "") +
  (results.skipped.length ? `スキップ: ${results.skipped.join(" / ")}` : "");

console.log("\n" + summary);
await notifySlack(summary);

// ============================================================
// Notion
// ============================================================
async function notion(path, method = "GET", body) {
  const r = await fetch(`https://api.notion.com/v1${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${NOTION_TOKEN}`,
      "Notion-Version": NOTION_VERSION,
      "Content-Type": "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const j = await r.json();
  if (!r.ok) throw new Error(`Notion ${method} ${path} -> ${r.status} ${j.message || ""}`);
  return j;
}

// CLDB から 分析頻度=対象 の案件を集める（formula文字列で判定）
async function fetchDueClients(gran) {
  const out = [];
  let cursor;
  do {
    const j = await notion(`/databases/${CLDB_DATABASE_ID}/query`, "POST", {
      page_size: 100,
      start_cursor: cursor,
    });
    for (const p of j.results) {
      const props = p.properties;
      const freq = props["分析頻度"]?.formula?.string || "";
      if (freq !== gran) continue;
      out.push({
        pageId: p.id,
        name: plainText(props["案件名"]?.title) || "(無題)",
        sheetUrl: props["集計表URL"]?.url || "",
        tabName: plainText(props["集計表タブ名"]?.rich_text) || "",
      });
    }
    cursor = j.has_more ? j.next_cursor : undefined;
  } while (cursor);
  return out;
}

async function findExisting(clPageId, startISO) {
  const j = await notion(`/databases/${ANALYSIS_DB_ID}/query`, "POST", {
    page_size: 1,
    filter: {
      and: [
        { property: "案件", relation: { contains: clPageId } },
        { property: "分析粒度", select: { equals: GRAN } },
        { property: "対象期間_開始", date: { equals: startISO } },
      ],
    },
  });
  return j.results[0] || null;
}

function buildProps(c, period, title, a) {
  const props = {
    "タイトル": { title: [{ text: { content: title } }] },
    "案件": { relation: [{ id: c.pageId }] },
    "レコード種別": { select: { name: "時系列ログ" } },
    "分析粒度": { select: { name: GRAN } },
    "対象期間_開始": { date: { start: period.start } },
    "対象期間_終了": { date: { start: period.end } },
    "分析日": { date: { start: todayISO() } },
    "ステータス": { select: { name: "下書き" } },
    "データソース": { multi_select: [{ name: "集計表" }] },
    "集計表リンク": { url: c.sheetUrl },
    "AI生成フラグ": { checkbox: true },
  };
  const k = a.kpi || {};
  setNum(props, "消化金額", k["消化金額"]);
  setNum(props, "実質CPA", k["実質CPA"]);
  setNum(props, "目標CPA", k["目標CPA"]);
  setNum(props, "CVR", k["CVR"]);
  setNum(props, "来店率", k["来店率"]);
  setNum(props, "成約率", k["成約率"]);
  if (a["総合評価"]) props["総合評価"] = { select: { name: a["総合評価"] } };
  if (Array.isArray(a["主要課題タグ"]) && a["主要課題タグ"].length)
    props["主要課題タグ"] = { multi_select: a["主要課題タグ"].map((n) => ({ name: n })) };
  return props;
}

async function createRecord(c, period, title, a) {
  await notion(`/pages`, "POST", {
    parent: { database_id: ANALYSIS_DB_ID },
    properties: buildProps(c, period, title, a),
    children: mdToBlocks(a.body_markdown || ""),
  });
}

async function updateRecord(pageId, c, period, title, a) {
  // 育てる: プロパティを最新値で上書き。本文は初回のものを尊重し、追記ログだけ足す。
  await notion(`/pages/${pageId}`, "PATCH", { properties: buildProps(c, period, title, a) });
  await notion(`/blocks/${pageId}/children`, "PATCH", {
    children: [para(`🔄 ${todayISO()} 自動再分析で数値・評価を更新（GitHub Actions）。`)],
  });
}

// ============================================================
// Google Sheets
// ============================================================
async function makeSheetsClient() {
  const creds = JSON.parse(GOOGLE_SERVICE_ACCOUNT_JSON);
  const auth = new google.auth.GoogleAuth({
    credentials: creds,
    scopes: ["https://www.googleapis.com/auth/spreadsheets.readonly"],
  });
  return google.sheets({ version: "v4", auth });
}

// 集計表URL から spreadsheetId と gid を取り出す
function parseSheetUrl(url) {
  const idm = url.match(/\/spreadsheets\/d\/([a-zA-Z0-9-_]+)/);
  if (!idm) return null;
  const gm = url.match(/[?#&]gid=(\d+)/);
  return { spreadsheetId: idm[1], gid: gm ? gm[1] : null };
}

// gid（無ければタブ名、無ければ先頭タブ）のシートを読み、CSV風テキストにして返す
async function readSheet(spreadsheetId, gid, tabName) {
  const meta = await sheetsApi.spreadsheets.get({ spreadsheetId });
  const all = meta.data.sheets || [];
  let sheet = null;
  if (gid != null) sheet = all.find((s) => String(s.properties.sheetId) === String(gid));
  if (!sheet && tabName) {
    const first = tabName.split(/\r?\n/)[0].trim();
    sheet = all.find((s) => s.properties.title === first);
  }
  if (!sheet) sheet = all[0];
  if (!sheet) return "";
  const title = sheet.properties.title;
  const res = await sheetsApi.spreadsheets.values.get({
    spreadsheetId,
    range: `'${title}'`,
    valueRenderOption: "FORMATTED_VALUE", // 日付を読める形式(例 6/22)で取得
    dateTimeRenderOption: "FORMATTED_STRING",
  });
  const rows = res.data.values || [];
  if (!rows.length) return "";
  const toLine = (r) => r.map((c) => (c == null ? "" : String(c))).join("\t");
  // 直近の実績は末尾にあることが多い。「先頭(見出し/サマリー)＋末尾(直近)」を渡す。
  const headN = Math.min(20, rows.length);
  let text = `# tab: ${title}（先頭=見出し/サマリー, 末尾=直近データ。対象期間の行は末尾側から探すこと）\n`;
  text += `## 先頭 ${headN} 行\n` + rows.slice(0, headN).map(toLine).join("\n") + "\n## 末尾(直近)\n";
  const tail = [];
  let used = text.length;
  for (let i = rows.length - 1; i >= headN; i--) {
    const line = toLine(rows[i]);
    if (used + line.length + 1 > SHEET_CHAR_BUDGET) break;
    tail.push(line);
    used += line.length + 1;
  }
  text += tail.reverse().join("\n");
  return text;
}

// ============================================================
// Claude
// ============================================================
async function analyzeWithClaude(clientName, period, sheetText) {
  const prompt =
`あなたは広告運用の分析アシスタントです。以下は案件「${clientName}」の集計表(タブ抽出・タブ区切り)です。
対象期間: ${period.start} 〜 ${period.end}（${GRAN}）。この期間の実績を集計表から読み取ってください。
ヒント: 日付は「6/22」等の形式のことがあります。対象期間の行は「末尾(直近)」側にあることが多いので、そこから探してください。${GRAN}の場合は日次行を対象期間で合算/該当行から算出してよいです。

出力は次のJSONだけを返してください（前後に文章やコードフェンスを付けない）:
{
  "found": true/false,               // 対象期間の実績が読み取れたか
  "reason": "found=falseの理由(あれば)",
  "kpi": {
    "消化金額": 数値(円) or null,
    "実質CPA": 数値(円, =消化÷媒体CV) or null,
    "媒体CV": 数値 or null,
    "実質CV": 数値 or null,
    "CVR": 数値(%, 例2.3) or null,
    "来店": 数値 or null,
    "来店率": 数値(%) or null,
    "成約": 数値 or null,
    "成約率": 数値(%, 対来店) or null,
    "目標CPA": 数値(円) or null
  },
  "総合評価": "🟢良好" | "🟡注意" | "🔴要対応" | "⚪️参考",
  "主要課題タグ": ["CPA超過"|"CVR低下"|"計測ズレ"|"CR疲弊"|"来店率低下"|"成約率低下"|"CPM高騰"|"予算消化問題"のうち該当],
  "body_markdown": "## エグゼクティブサマリー\\n(3行以内)\\n\\n## KPIサマリー\\n- 消化金額: …\\n- 実質CPA: …(目標比)\\n- CVR: …\\n\\n## トレンド(前${MODE==="weekly"?"週":"月"}比)\\n- …\\n\\n## 課題と打ち手\\n- …"
}

注意:
- 数値は必ず集計表の実数を使い、推測しない。読めない値は null。
- body_markdown は見出し(##)と箇条書き(-)のみ。表は使わない。
- 媒体CVが0/空で実質CPAが出せない場合は実質CPA=null、主要課題タグに"計測ズレ"を含める。

--- 集計表ここから ---
${sheetText}
--- 集計表ここまで ---`;

  const r = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 2000,
      messages: [{ role: "user", content: prompt }],
    }),
  });
  const j = await r.json();
  if (!r.ok) throw new Error(`Anthropic -> ${r.status} ${j.error?.message || ""}`);
  const text = j.content?.map((b) => b.text || "").join("") || "";
  return parseJson(text);
}

function parseJson(text) {
  let t = text.trim();
  const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) t = fence[1].trim();
  const s = t.indexOf("{");
  const e = t.lastIndexOf("}");
  if (s === -1 || e === -1) throw new Error("Claude応答からJSONを抽出できません");
  return JSON.parse(t.slice(s, e + 1));
}

// ============================================================
// Slack
// ============================================================
async function notifySlack(text) {
  if (!SLACK_WEBHOOK_URL) return;
  try {
    await fetch(SLACK_WEBHOOK_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text }),
    });
  } catch (e) {
    console.error("[slack] 通知失敗:", e.message);
  }
}

// ============================================================
// helpers
// ============================================================
function plainText(rich) {
  if (!Array.isArray(rich)) return "";
  return rich.map((t) => t.plain_text || t.text?.content || "").join("");
}
function setNum(props, key, v) {
  if (v === null || v === undefined || v === "" || Number.isNaN(Number(v))) return;
  props[key] = { number: Number(v) };
}
function abbr(name) {
  return String(name)
    .replace(/^フィルタ用_/, "")
    .replace(/^[a-zA-Z]?\d+_/, "")
    .split(/[\s(（]/)[0] || name;
}
function para(text) {
  return { object: "block", type: "paragraph", paragraph: { rich_text: [{ type: "text", text: { content: text.slice(0, 1900) } }] } };
}
function mdToBlocks(md) {
  const blocks = [];
  for (const raw of String(md).split(/\r?\n/)) {
    const line = raw.trimEnd();
    if (!line.trim()) continue;
    if (line.startsWith("### ")) blocks.push(heading(3, line.slice(4)));
    else if (line.startsWith("## ")) blocks.push(heading(2, line.slice(3)));
    else if (line.startsWith("# ")) blocks.push(heading(2, line.slice(2)));
    else if (/^[-*] /.test(line)) blocks.push(bullet(line.replace(/^[-*] /, "")));
    else if (line.startsWith("> ")) blocks.push(quote(line.slice(2)));
    else blocks.push(para(line));
    if (blocks.length >= 90) break; // Notion children 上限保護
  }
  return blocks.length ? blocks : [para("(分析本文なし)")];
}
function heading(n, text) {
  const type = `heading_${n}`;
  return { object: "block", type, [type]: { rich_text: [{ type: "text", text: { content: text.slice(0, 1900) } }] } };
}
function bullet(text) {
  return { object: "block", type: "bulleted_list_item", bulleted_list_item: { rich_text: [{ type: "text", text: { content: text.slice(0, 1900) } }] } };
}
function quote(text) {
  return { object: "block", type: "quote", quote: { rich_text: [{ type: "text", text: { content: text.slice(0, 1900) } }] } };
}

// ---- 期間計算（JST基準）------------------------------------
function jstParts() {
  const j = new Date(Date.now() + 9 * 3600 * 1000);
  return { Y: j.getUTCFullYear(), M: j.getUTCMonth(), D: j.getUTCDate(), dow: j.getUTCDay() };
}
function iso(d) {
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}
function pad(n) {
  return String(n).padStart(2, "0");
}
function todayISO() {
  const { Y, M, D } = jstParts();
  return `${Y}-${pad(M + 1)}-${pad(D)}`;
}
function lastWeekJST() {
  const { Y, M, D, dow } = jstParts();
  const base = Date.UTC(Y, M, D);
  const sinceMon = (dow + 6) % 7; // 月曜からの経過日数
  const lastMon = new Date(base - (sinceMon + 7) * 86400000);
  const lastSun = new Date(base - (sinceMon + 1) * 86400000);
  return { start: iso(lastMon), end: iso(lastSun), tag: `${String(lastMon.getUTCFullYear()).slice(2)}W${pad(isoWeek(lastMon))}` };
}
function lastMonthJST() {
  const { Y, M } = jstParts();
  const y = M === 0 ? Y - 1 : Y;
  const m = M === 0 ? 11 : M - 1; // 0-index
  const start = new Date(Date.UTC(y, m, 1));
  const end = new Date(Date.UTC(y, m + 1, 0));
  return { start: iso(start), end: iso(end), tag: `${String(y).slice(2)}${pad(m + 1)}` };
}
function isoWeek(d) {
  const t = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const day = (t.getUTCDay() + 6) % 7;
  t.setUTCDate(t.getUTCDate() - day + 3); // 木曜へ
  const firstThu = new Date(Date.UTC(t.getUTCFullYear(), 0, 4));
  const fday = (firstThu.getUTCDay() + 6) % 7;
  firstThu.setUTCDate(firstThu.getUTCDate() - fday + 3);
  return 1 + Math.round((t - firstThu) / (7 * 86400000));
}
