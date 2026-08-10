/**
 * クリエイティブ停止 実行ハブ (Cloudflare Worker)
 * ------------------------------------------------------------------
 * 2つの入口から同じ実行ロジックを叩く:
 *   (1) claude.ai / モバイル … MCP (/mcp, /sse)  ← Claude が判断して呼ぶ
 *   (2) Slack スラッシュコマンド … /slack/command, /slack/interact  ← Claude を挟まない
 *
 * 「停止」が行う2つの実体:
 *   A. Meta実停止 … 案件のMeta広告アカウント内で cr名にマッチする広告を全件 status=PAUSED
 *   B. 集計表記録 … GAS Web App(doPost stop) でチェック/グレー/メモ記載
 * undo は A=ACTIVE復帰（集計表undoが成功した時のみ）/ B=GAS undo。
 *
 * ルーティング:
 *   - Slack: channel_id → 案件（cr名は案件をまたいで重複するためチャンネルで確定）
 *   - MCP  : project 引数があればそれ、無ければ find で全案件を探索（1件のみ採用）
 *
 * 認証:
 *   - MCP : URLパス先頭の共有シークレット(SHARED_SECRET)。非該当パスは404（OAuth誤認回避）
 *   - Slack: 署名検証(SLACK_SIGNING_SECRET)
 */

import { McpAgent } from "agents/mcp";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

// ── cr入稿くん（/cr-in）──
import { handleCrInCommand, handleCrInInteraction } from "./submit/command";
import { handleContinue, CONTINUE_PATH } from "./submit/continuation";
import type { SubmitEnv, SubmitProject } from "./submit/types";

// ── 翌日自動チェックくん（TOOL-40）──
import { startDailyCheck, handleCheckContinue, handleCheckRun, CHECK_CONTINUE_PATH } from "./check";
import { createRunLog, updateRunLog } from "./check/runlog";
import type { CheckDeps, CheckEnv } from "./check/types";

const GRAPH = "v21.0"; // Meta Graph API バージョン（古くなったらここを上げる）

interface Env {
  MCP_OBJECT: DurableObjectNamespace;
  SHARED_SECRET: string;
  SLACK_SIGNING_SECRET: string;
  SLACK_BOT_TOKEN: string;
  META_ACCESS_TOKEN: string; // 既定のMetaトークン(株式会社リードBM, ads_management)
  META_TOKEN_LOCAL?: string; // Local Infomation BM 用トークン(grm等)
  NOTION_TOKEN?: string;     // Notionログ用 内部インテグレーショントークン（予算波及でも使用）
  BUDGET_TOKEN?: string;     // 予算確定→波及くん リンク用 共有シークレット
  GOOGLE_SERVICE_ACCOUNT_JSON?: string; // cr入稿くん: Drive読み取り用SA（ads-reader@... を流用）
  SELF_URL?: string;         // cr入稿くん: continuation self-fetch用（未設定時はリクエストのoriginを使用）
  [key: string]: any; // 案件別トークンを secret名で動的参照するため
}

// cr入稿くん用の環境ビュー（GAS URLは本ファイルの定数を注入）
function submitEnvOf(env: Env, origin: string): SubmitEnv {
  return { ...env, COMMON_GAS_URL, SUBMIT_GAS_URL, SELF_URL: env.SELF_URL || origin } as unknown as SubmitEnv;
}

// 共通GAS（スタンドアロン・openById）。全案件これ1つを spreadsheetId 付きで叩く。
// 2026-06-21: budget_propagate アクション追加に伴い新デプロイへ更新（stop/undo/find も含むフルセット）。
const COMMON_GAS_URL = "https://script.google.com/macros/s/AKfycbzQhKd3V7EGnspdrZUSLqYRW0Ruquw-SXEM-8X_Bj-YVK-2e4otn7enf9NcVrQNxLU/exec";

// cr入稿くん専用GAS（独立プロジェクト submitCreative_common / 2026-07-03 山田デプロイ）。
// 集計表のCR00ブロック展開(action=submitCreative/submitUndo)はこちらを叩く。
const SUBMIT_GAS_URL = "https://script.google.com/macros/s/AKfycbzUq6Sa_4-TLsmtCfgKwT_WK9FvmJfEUm_DkMSgd7J7s0WXtAjzNziaAIxqu87DLjCW/exec";

// Notion 実行ログDB（誰が何回停止したかの記録）
const NOTION_LOG_DB_ID = "095cdb118eb34379ae8c5fc372d9e4b1";

// ── 案件レジストリ ──
// sheets: 集計表の対象（複数タブ/複数スプレッドシート対応）。sheetName省略時は meta_total/自動検出。
interface SheetTarget {
  spreadsheetId: string;
  sheetName?: string;
  // cr入稿くん: sheet単位のDriveフォルダ上書き（例: bla の face/body）
  driveFolderId?: string;
  driveFolderName?: string;
}
interface Project {
  name: string;
  channelId: string;
  sheets: SheetTarget[];     // 1件＝複数の集計対象を持てる（cr名でどれか自動判定）
  metaAdAccountId?: string;  // 数字のみ。未設定はMeta実停止スキップ（集計表のみ）
  metaTokenSecret?: string;  // 別BMの案件のトークンsecret名。省略時は META_ACCESS_TOKEN
  // ── cr入稿くん（/cr-in）用。設定した案件だけ入稿可能 ──
  cldbPageId?: string;       // CLDB案件ページID（設定時はcr倉庫フォルダを実行時解決。最優先）
  driveFolderId?: string;    // 完成動画フォルダのDrive ID（確実。名前検索より優先）
  driveFolderName?: string;  // または名前検索（例 "cr_jde"。同名複数あるとエラー）
  crdbDataSourceId?: string; // Notion CRDB（cr指示ページの検索先）
  crdbNamePrefixes?: string[]; // CRDBページ名の案件プレフィックス（省略時はname。jdekmak→jde_mak等の上書き用）
  adNameStyle?: "full" | "short"; // Meta広告名: full=ファイル名そのまま / short=cr番号のみ
  adsetAllowlist?: string[]; // 入稿先候補にする広告セットID（省略時はACTIVE全セット）
  submitBlocked?: string;   // 設定時は/cr-inをこの理由で即エラー終了（既知の未解決事項がある案件）
}

// 案件に対応するMetaトークンを返す（BMが違う案件は別secretを使う）
function metaToken(env: Env, p: Project): string | undefined {
  return env[p.metaTokenSecret || "META_ACCESS_TOKEN"];
}

// cr入稿くん driveFolderId は CLDB「cr倉庫_(GoogleDrive) #納品先」を2026-07-06に一括照合して抽出
// （collection://6ca19ba4-11c6-4d40-ad66-990c678b2b0d）。集計表構造の案件差は
// Notion「📊 集計表 構造仕様（全ツール共通リファレンス）」参照。
//
// crdbDataSourceId は全案件で同一値（3adda07df1cd407fac365e81c6da2582 = CRDB #クリエイティブdb）。
// 2026-07-07に実地確認: このCRDBはjde専用ではなく「アイデア〜企画〜指示ファイルまで」を横断参照する
// 全案件共通のDBで、各レコードはCLDB(案件)リレーションで案件に紐づく（例: pom_cr06_…もこのDB内に実在）。
// cr名検索は「{案件プレフィックス}_{cr番号}」(例 "hyd_cr50")で前方一致検索する（2026-07-08〜）。
// チャンネル=案件が確定しているため他案件の同番号crとは衝突しない（cr停止くんと同じ方式）。
// プレフィックスは省略時 project.name。jdekmak/jdekkou のようにSlack案件キーとページ名が
// 異なる案件は crdbNamePrefixes で上書きする。プレフィックス付きで0件の場合は旧命名
// （プレフィックス無し）ページ用に素のcr番号検索へフォールバックする。
const CRDB_DATA_SOURCE_ID = "3adda07df1cd407fac365e81c6da2582"; // CRDB #クリエイティブdb（全案件共通）
const PROJECTS: Project[] = [
  // ── 株式会社リードBM（既定トークン）・Meta連携あり ──
  { name: "jdem", channelId: "C06K15R5PLM", sheets: [{ spreadsheetId: "11ZkSchmHPDeaDLo6h3EfyNYW9pHisxw6ErH5KlU7-EI" }], metaAdAccountId: "376611118470846",
    driveFolderId: "1NLdIeoFXs7-fZ1ZLVQmNiwnuHFjCd5TC", crdbDataSourceId: CRDB_DATA_SOURCE_ID },
  // hyd: 認証は ads-reader ではなく ad-analysis-bot@ad-analysis-bot.iam.gserviceaccount.com
  // （Googleグループ lead_div1 経由で共有済み）。マーカーは「CR一覧→」(パターン開始/集計内)
  // と「集計除外→」(集計外開始)。2026-07-08 ユーザーが集計内(親)ゾーンにcr00テンプレ(FD6)を
  // 手動追加し、再実測でcr00ブロック数が1→2・マーカー直後に正しく配置されたことを確認したため
  // submitBlockedを解除。
  { name: "hyd",  channelId: "C05K6A1AYAX", sheets: [{ spreadsheetId: "1SkCSTuegQoZhNd3keYFOEZw2YIWOnbiRAe0rY-g22bY" }], metaAdAccountId: "240479525112751",
    driveFolderId: "1ZvE0rGBtOsZAnae8OfO3Uz-5XO9FcagA", crdbDataSourceId: CRDB_DATA_SOURCE_ID },
  { name: "blr", channelId: "C08DWV6TNVD", sheets: [{ spreadsheetId: "1sml0bP7vPwkADT820q4Vw9hwmY1vS1VKeYx4HJrmCs4" }], metaAdAccountId: "1478950736840563",
    driveFolderId: "1N2u8z8MrDEo7ApgrPpphz9hrmdyUs7Uh", crdbDataSourceId: CRDB_DATA_SOURCE_ID }, // 集計外(パターン子)ゾーンの存在は未確認。子ありcrはGASが明示エラーで停止する想定（親単独は動作可）
  { name: "rcl",  channelId: "C0ASMD3EV5W", sheets: [{ spreadsheetId: "1J1BxvhD7EdfK6iDErRSmwBBXGq56QESnLIAhgfROCB4" }], metaAdAccountId: "961684439806754",
    driveFolderId: "1F1GW6mlvpvl4Ct9F5T2f74-9UYOw3XWN", crdbDataSourceId: CRDB_DATA_SOURCE_ID },
  { name: "nrn",  channelId: "C090XM34R8C", sheets: [{ spreadsheetId: "1Q7iph8TxZ5C5ouBb3vjvyNMNgLUmP-Uj1stCO9TewFA" }], metaAdAccountId: "1193318218072212",
    driveFolderId: "1yppVlZaoAFwNJxeeFx2Oe6yIU4qQgrtL", crdbDataSourceId: CRDB_DATA_SOURCE_ID },
  { name: "ssh",  channelId: "C089212DETU", sheets: [{ spreadsheetId: "1FkJIJOyYykyHV66I4VLpxHXbkVf_bswK5Y9NojDpOeI" }], metaAdAccountId: "3751573135086293",
    driveFolderId: "154PB5vb2qEgmKJTIda2DSRay3PyvmhzY", crdbDataSourceId: CRDB_DATA_SOURCE_ID }, // ID行=7行目（他案件と異なる。GASの1〜8行探索で自動対応済み）
  { name: "brm",  channelId: "C07KJES7LHW", sheets: [{ spreadsheetId: "1MSJ6sLNWIbZnYy1CbDUNg86KUWq9fX_MlFENKGdGKH8" }], metaAdAccountId: "825363383075510",
    driveFolderId: "1g2t0BOjVesJ2laFH3lnWZzyjtLNBWd-L", crdbDataSourceId: CRDB_DATA_SOURCE_ID },
  // ── 複数集計対象の案件 ──
  { name: "una",  channelId: "C08DV6STNER", metaAdAccountId: "1063670028480764", sheets: [
      { spreadsheetId: "1J_T8FurvLgRd6IhxjqE0AqGS8NfQPRanXp55dy9o5gI", sheetName: "meta_total" },        // 本店
      { spreadsheetId: "1icFYUtazAwq8yDGx6ySC04KvLw8Q3WQ6i_HvIhqE20k", sheetName: "meta_total_銀座店" }, // 銀座店（別スプレッド）
    ],
    // 本店フォルダのみ登録（銀座店はCLDB未登録）。銀座店のcrを入稿すると本店フォルダで
    // ファイルが見つからずエラーになる想定（誤爆ではなく安全側の失敗）。銀座店対応時はCLDBに登録を
    driveFolderId: "1x7msuyaB8oaGkht3mKMYI3rE4j5g-zzr", crdbDataSourceId: CRDB_DATA_SOURCE_ID },
  { name: "bla",  channelId: "C09FYGDAFEX", metaAdAccountId: "1612534536164262", sheets: [
      // face/bodyでcr番号が独立採番のためDriveフォルダも分かれる（CLDB確認済）。
      // resolve.tsがsheet単位のdriveFolderIdで両方検索し、一致した方だけを採用する
      { spreadsheetId: "1s7wI_d9CFRv0pGeNJXVoSg1Ux6VwKznpkf10qTjVgRw", sheetName: "meta_face", driveFolderId: "1W9eVd0Goj9GnZTpAogU7stWi-uBJU4yE" },
      { spreadsheetId: "1s7wI_d9CFRv0pGeNJXVoSg1Ux6VwKznpkf10qTjVgRw", sheetName: "meta_body", driveFolderId: "1HowqtJktuljTF37MWrOukhXBOtXlZjMV" },
    ],
    crdbDataSourceId: CRDB_DATA_SOURCE_ID },
  { name: "jdek", channelId: "C092WQSSPUL", metaAdAccountId: "1533513563939156", sheets: [ // #z-n22_jde_all（両訴求 自動判定）
      { spreadsheetId: "1oEK8JCJg2NcseWmnxLtfNFCe5A7XGJ_DJSj7c2EW1sg", sheetName: "kk_mak" },
      { spreadsheetId: "1oEK8JCJg2NcseWmnxLtfNFCe5A7XGJ_DJSj7c2EW1sg", sheetName: "kk_kou" },
  ] },
  { name: "jdekmak", channelId: "C09S1F9TXSP", metaAdAccountId: "1533513563939156", sheets: [ // #z-n22_jde_kk_mak（巻き肩）
      { spreadsheetId: "1oEK8JCJg2NcseWmnxLtfNFCe5A7XGJ_DJSj7c2EW1sg", sheetName: "kk_mak" },
    ],
    // ── cr入稿くん（初期スコープ案件・実運用検証済）──
    cldbPageId: "2a835c2adb56809b9953ee99115cc560", // CLDB「n22_jde_kk_mak」→ cr倉庫_(GoogleDrive)を実行時解決
    driveFolderId: "1M0Cc9_R_S-h_dm4SoZJ_Tigr8gWVrMck", // フォールバック: cr_jde_mak_巻き肩
    crdbDataSourceId: "3adda07df1cd407fac365e81c6da2582", // CRDB #クリエイティブdb（database_id。要: cr-stop-workerインテグレーションへの共有）
    crdbNamePrefixes: ["jde_mak"], // CRDBページ名は jde_mak_cr79_…（Slack案件キーjdekmakと異なる）
    adNameStyle: "full", // jde系は広告名フル名称（jde_mak_cr84_… 実測済）
    adsetAllowlist: ["120246843077960183"], // mak本体広告セット（cr81/82/84の直近入稿先）
  },
  { name: "jdekkou", channelId: "C092NPS16P3", metaAdAccountId: "1533513563939156", sheets: [ // #z-n22_jde_kk_kou（甲剥がし）
      { spreadsheetId: "1oEK8JCJg2NcseWmnxLtfNFCe5A7XGJ_DJSj7c2EW1sg", sheetName: "kk_kou" },
    ],
    driveFolderId: "1i0xy_jjhzLY4RE6K22ahxxmm-vrHUNNM", // CLDB「n22_jde_kk_kou」
    crdbDataSourceId: CRDB_DATA_SOURCE_ID,
    crdbNamePrefixes: ["jde_kou"], // CRDBページ名は jde_kou_cr…（Slack案件キーjdekkouと異なる）
    adNameStyle: "full" },
  // ── 株式会社リードBM（2026-07-07 Meta Ads MCPで広告名実測してアカウントID確定）──
  { name: "bbt",  channelId: "C0B3J7U8Q5N", sheets: [{ spreadsheetId: "1IoFvL9ZmbhoNRlFl_rvza8VwC0_bA1mJAT5z98-gGf8" }],
    metaAdAccountId: "1616783749463582", crdbDataSourceId: CRDB_DATA_SOURCE_ID }, // bbt_cr05_...で稼働確認済。Drive倉庫はCLDB未登録のため要登録
  // BUG-139: 集計表が n26_lcl/n44_rjf 共有スプレッドシートで、既定の"meta_total"タブは
  // 集計サマリのみ(cr-idブロック0個)。実際のcr別ブロックは"meta_body_n26_lcl"タブ側にある
  // (2026-08-08 構造ダンプでcr13/cr15/cr20/cr22等の実在を確認)。sheetName未指定だとGAS側
  // resolveSheet()が既定のmeta_totalを掴んでしまい、Meta側停止は成功するのに集計表側は
  // 常に「クリエイティブが見つかりません」になっていた(pom/rof/rob/fpと同型の原因)。
  { name: "lcl",  channelId: "C08SNLK4CMP", sheets: [{ spreadsheetId: "12WYKgq0i53_ZZXlO7rLZ5zWGLzN7fbPZrGGfeB9kIT0", sheetName: "meta_body_n26_lcl" }],
    driveFolderId: "1K7oUiBfIYZQozePFO_g3h0z8hfeOUy8I", metaAdAccountId: "2261332077579401", crdbDataSourceId: CRDB_DATA_SOURCE_ID }, // lcl_cr24_...で稼働確認済
  { name: "aty",  channelId: "C07MTDU23A9", sheets: [{ spreadsheetId: "1Z3OIaJQgr2Nd8ElN0dB_lJ2a8Cls_J9756zaeGoJu9U" }],
    driveFolderId: "1dHweykRQzMHD-tYNZaDTVebvFACbZvdi", metaAdAccountId: "780374144048761", crdbDataSourceId: CRDB_DATA_SOURCE_ID }, // aty_cr07_...で稼働確認済
  { name: "pom",  channelId: "C07K1AQ15T5", sheets: [{ spreadsheetId: "1WmFGDm4vJxJrB_wi4fH27Dq1Xyzj9BTiZv0D9boU6KA", sheetName: "meta_total_02" }],
    driveFolderId: "132T3oZCEWlPDnihFYOqmZn4eZ5VbwZbV", metaAdAccountId: "487263213795383", crdbDataSourceId: CRDB_DATA_SOURCE_ID }, // cr01/cr02_01-04等の命名一致確認済（現在は全PAUSED）
  // rof/rob: 2026-07-07 構造ダンプで判明— 実は同一の共有スプレッドシート
  // 「n03_rob&n08_rof_rose_集計表_2601-」(旧CLDB記載のrofのIDは古い別シートで404相当)。
  // Metaも「【リード】01：ROSE」(Buzzmode, 1348469442433184)を両部位で共用（rob_cr2_XX/face系で稼働確認済）。
  { name: "rof",  channelId: "C060E2R6AMR", sheets: [{ spreadsheetId: "1Ww2jaG_0lsQ4-lq8SS3WCSGpcVuIaoqshR2RzztrbDk", sheetName: "meta_CR_FACE" }],
    // meta_CR_FACE: ID行=6行目・cr00×2確認(AB6/PZ6)・除外マーカーは「ナンバリング除外→」(新規発見、GAS側に追加済)。
    // メモ列(親子分類プルダウン)は無い案件のため分類書込みはスキップされる想定（構造上問題なし）
    metaAdAccountId: "1348469442433184", crdbDataSourceId: CRDB_DATA_SOURCE_ID,
    driveFolderId: "1_ZAEE4rBLIPR9CeKrw5eWWykbJQcZgwS" }, // rob側Driveフォルダを暫定共用（face専用フォルダ未確認・要検証）
  { name: "rob",  channelId: "C05BQ9GPF9C", sheets: [{ spreadsheetId: "1Ww2jaG_0lsQ4-lq8SS3WCSGpcVuIaoqshR2RzztrbDk", sheetName: "meta_CR_BODY" }],
    metaAdAccountId: "1348469442433184", crdbDataSourceId: CRDB_DATA_SOURCE_ID,
    driveFolderId: "1_ZAEE4rBLIPR9CeKrw5eWWykbJQcZgwS",
    // meta_CR_BODYは実タブ名まで判明したが、1〜8行にID行が見つからない（店舗別サマリー構造に見える）。
    // 実際のCRブロックが別行/別タブにある可能性があり要追加調査。解決までブロック
    submitBlocked: "実タブ名は meta_CR_BODY と判明したが、1〜8行にID行(cr00等)が見つからない。実際のCRブロック位置の追加調査が必要" },
  // ── Local Infomation BM（META_TOKEN_LOCAL）── grm/fplは既定Meta Ads MCP接続とは別ビジネスのため
  // アカウント一覧に出てこない。fplのmetaAdAccountIdはLocal BM側で別途確認が必要
  { name: "grm",  channelId: "C09GWM75YV6", sheets: [{ spreadsheetId: "1Ug7qBDUUhLutvDLlBbQNiKvIhVbwOhxlOOYm-zPpwG0" }], metaAdAccountId: "1252444372845762", metaTokenSecret: "META_TOKEN_LOCAL",
    driveFolderId: "1TrGMy-Z6MQKN3w2Dht0FG8zEeYi0QSMZ", crdbDataSourceId: CRDB_DATA_SOURCE_ID },
  { name: "fpl",  channelId: "C09NP3CE316", sheets: [{ spreadsheetId: "1fPuoBFCp4LoC8GVr84M9JWMoWwgr6tDzAGZEPEhz-VU" }], metaTokenSecret: "META_TOKEN_LOCAL",
    driveFolderId: "1p5FLvojnRZ8Smoymuz4hY50NLh9wsWa1", crdbDataSourceId: CRDB_DATA_SOURCE_ID,
    submitBlocked: "Local Infomation BM配下のMeta広告アカウントIDが未確認（既定のMeta Ads MCP接続では不可視）。要手動確認" },
  // ── n10_fp（フローズンフィリップ）2026-07-07 新規登録 ──
  { name: "fp",   channelId: "C068ESLAU03", sheets: [{ spreadsheetId: "145RGJ9yeCnR8vJexXVyO_LsDTMYVQPBehYkyAim9be8", sheetName: "meta_total" }],
    metaAdAccountId: "767158244897727", driveFolderId: "16GyZta2Li0U74zIHrQuMn59o75anNrA9", crdbDataSourceId: CRDB_DATA_SOURCE_ID }, // cr44/cr45/cr46で稼働確認済
];

// cr名がどの集計対象(タブ/スプレッド)にあるかを判定して返す（複数対象案件のルーティング）
async function pickSheet(p: Project, creative: string): Promise<SheetTarget | null> {
  if (p.sheets.length === 1) return p.sheets[0];
  const checks = await Promise.all(
    p.sheets.map(async (t) => {
      try { const r = await callGas(t, { action: "find", creativeName: creative }); return r && r.found ? t : null; }
      catch { return null; }
    }),
  );
  const matches = checks.filter((t): t is SheetTarget => !!t);
  return matches.length === 1 ? matches[0] : null; // 0件 or 複数一致は null（曖昧）
}

const projectByName = (n: string) =>
  PROJECTS.find((p) => p.name.toLowerCase() === String(n).toLowerCase());
const projectByChannel = (c: string) => PROJECTS.find((p) => p.channelId === c);

// ============================================================
// GAS 呼び出し（302→Location→GET）
// ============================================================
type GasPayload =
  | { action: "stop"; creativeName: string; stopDate: string }
  | { action: "undo"; creativeName: string; memoMode: "full" | "tag" }
  | { action: "find"; creativeName: string }
  | { action: "budget_propagate"; targetYear: number; targetMonth: number; requestBudget: number; memoText: string; prevBudget: number | null; dryRun: boolean }
  // BUG-112: 子CR(crN_NN)を停止した直後の親子連動チェック。兄弟の子が全員停止済みなら親(crN)も停止する
  | { action: "cascade_check"; creativeName: string; stopDate: string }
  // BUG-112: 導入前からある「子が全員停止済みなのに親が未停止」を一括検出・停止（dryRun=trueは検出のみ）
  | { action: "cascade_audit"; stopDate: string; dryRun: boolean }
  // BUG-113: チェックボックスはON(停止済み)なのに背景が未グレー化のCRを検出・再グレー化（dryRun=trueは検出のみ）
  | { action: "regray_check"; dryRun: boolean };

interface CascadeResult {
  triggered: boolean;
  reason?: string;
  parentId?: string;
  childIds?: string[];
  stopResult?: any;
}

// BUG-113: 親CR自動停止のSlack通知に「どの子CRが全て停止したから」を明記する
// （従来は親の番号だけで、何が引き金になったか分からなかった）。
function cascadeNotifyLine(cascade: CascadeResult | undefined, bold: (s: string) => string): string | null {
  if (!cascade?.triggered || !cascade.parentId) return null;
  const children = cascade.childIds?.length ? cascade.childIds.join("、") : "（子CR一覧取得失敗）";
  return `👨‍👧 親CR ${bold(cascade.parentId)} も自動停止しました（子CR ${children} が全て停止／メモ:「子供が全て停止」）`;
}

async function callGas(target: SheetTarget, payload: GasPayload): Promise<any> {
  // ハング防止: 各fetchに25秒タイムアウト（GASが重い/固まっても無限に待たない）
  const withTimeout = async (url: string, init?: RequestInit) => {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), 25000);
    try { return await fetch(url, { ...init, signal: ctl.signal }); } finally { clearTimeout(t); }
  };
  const res = await withTimeout(COMMON_GAS_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ...payload, spreadsheetId: target.spreadsheetId, sheetName: target.sheetName }),
    redirect: "manual",
  });
  let bodyText: string;
  if (res.status >= 300 && res.status < 400) {
    const loc = res.headers.get("location");
    if (!loc) return { success: false, message: "リダイレクト先(Location)なし", status: res.status };
    const echo = await withTimeout(loc);
    bodyText = await echo.text();
  } else {
    bodyText = await res.text();
  }
  try {
    return JSON.parse(bodyText);
  } catch {
    return { success: false, message: "GASからJSON以外（権限=全員 を確認）", rawPreview: bodyText.slice(0, 200) };
  }
}

// project未指定時に find で案件を探索（MCP用）
async function findProjects(creativeName: string): Promise<Project[]> {
  const checks = await Promise.all(
    PROJECTS.map(async (p) => {
      try {
        for (const t of p.sheets) {
          const r = await callGas(t, { action: "find", creativeName });
          if (r && r.found) return p;
        }
        return null;
      } catch {
        return null;
      }
    }),
  );
  return checks.filter((p): p is Project => !!p);
}

// ============================================================
// Meta Graph API（広告の検索 / 状態変更）
// ============================================================
function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
// cr名が区切り(先頭/末尾/英数字以外)で独立しているか厳密判定（cr45 が cr450 を誤マッチしない）
function adNameMatches(adName: string, creative: string): boolean {
  const re = new RegExp(`(^|[^a-z0-9])${escapeRegex(creative.toLowerCase())}([^a-z0-9]|$)`);
  return re.test(String(adName).toLowerCase());
}

interface MetaAd { id: string; name: string; effective_status: string; adsetName?: string; campaignName?: string }

// タイムアウト付き fetch→json（ハング防止）
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

// タイムアウト付き fetch（ハング防止・レスポンスは呼び出し側で読む）。
// BUG-141: notifySlack/logToNotion/postResponse は元々このガードが無く、Slack/Notion側が
// 応答を返さないまま固まると fetch の await が永遠に解決せず、後続の postResponse（完了通知）や
// updateRunLog（実行ログの「実行中」解除）まで一切到達しなかった（=呼び出し元のtry/catchも無力。
// 何も throw されないため）。ctx.waitUntil() 全体がCloudflare側のタイムアウトで強制終了されるまで
// Slackの「⏳ 停止実行中…」が置き換わらず「途中でSlackが止まっていました」という見え方になっていた。
async function fetchTimeout(url: string, init: RequestInit, ms: number): Promise<Response> {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), ms);
  try {
    return await fetch(url, { ...init, signal: ctl.signal });
  } finally {
    clearTimeout(t);
  }
}

async function metaFindAds(token: string, adAccountId: string, creative: string): Promise<MetaAd[]> {
  // ① cr番号だけ(例 cr60_11_01→cr60)で軽く検索（id/name/statusのみ＝速い・重くならない）。
  //    MetaのCONTAINは下線複数の長い文字列で0件を返す癖があるため番号で広く取る。
  //    creativeが案件プレフィックス付き(lcl_cr15_01等、CRDBページ名そのまま)だと、先頭セグメントを
  //    素朴に取ると案件名側("lcl")を拾ってしまい、CONTAINが広がりすぎて件数の多い案件では
  //    古い広告が limit=300/500 の取得範囲外に押し出され0件化する（BUG-108）。"cr"+数字のトークンを優先的に抽出する。
  const crToken = String(creative).match(/cr\d+/i)?.[0];
  const broad = crToken || String(creative).split("_")[0] || creative;
  const filtering = encodeURIComponent(JSON.stringify([{ field: "name", operator: "CONTAIN", value: broad }]));
  const url = `https://graph.facebook.com/${GRAPH}/act_${adAccountId}/ads?fields=id,name,effective_status&filtering=${filtering}&limit=300&access_token=${encodeURIComponent(token)}`;
  const data = await fetchJsonTimeout(url, 12000);
  if (data.error) throw new Error(`Meta検索失敗: ${data.error.message}`);

  // ② 手元で厳密一致（cr60 が cr600 を、cr60_11_01 が cr60_11_010 を誤マッチしない）
  let matched: MetaAd[] = (data.data || [])
    .filter((a: any) => adNameMatches(a.name, creative))
    .map((a: any) => ({ id: a.id, name: a.name, effective_status: a.effective_status }));

  // ②' CONTAINが0件を返す癖への保険（BUG-28: rclで実在広告 rcl_cr01_01 が0件になった）:
  //     フィルタ無しで直近500件を取得し、手元の厳密一致だけで拾い直す
  if (matched.length === 0) {
    const url2 = `https://graph.facebook.com/${GRAPH}/act_${adAccountId}/ads?fields=id,name,effective_status&limit=500&access_token=${encodeURIComponent(token)}`;
    const d2 = await fetchJsonTimeout(url2, 12000);
    if (!d2.error) {
      matched = (d2.data || [])
        .filter((a: any) => adNameMatches(a.name, creative))
        .map((a: any) => ({ id: a.id, name: a.name, effective_status: a.effective_status }));
    }
  }

  // ③ 一致した広告だけ CP名/AS名 を取得（軽量・表示用）
  if (matched.length) {
    try {
      const ids = matched.map((m) => m.id).join(",");
      const u2 = `https://graph.facebook.com/${GRAPH}/?ids=${encodeURIComponent(ids)}&fields=adset{name},campaign{name}&access_token=${encodeURIComponent(token)}`;
      const d2 = await fetchJsonTimeout(u2, 8000);
      matched = matched.map((m) => ({ ...m, adsetName: d2?.[m.id]?.adset?.name, campaignName: d2?.[m.id]?.campaign?.name }));
    } catch {
      /* CP/AS名は表示用なので取れなくても続行 */
    }
  }
  return matched;
}

async function metaSetStatus(token: string, adId: string, status: "PAUSED" | "ACTIVE"): Promise<void> {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), 12000); // 1広告12秒でタイムアウト（ハング防止）
  try {
    const res = await fetch(`https://graph.facebook.com/${GRAPH}/${adId}`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ status, access_token: token }),
      signal: ctl.signal,
    });
    const data: any = await res.json();
    if (data.error) throw new Error(`Meta更新失敗(${adId}): ${data.error.message}`);
  } finally {
    clearTimeout(t);
  }
}
// 複数広告を並列で更新（直列だと多数で固まる）。成功件数と、失敗があれば実際のGraph APIエラー文言を返す
// （BUG-109: 従来は失敗件数しか分からず「トークン/権限を確認してください」としか案内できなかった）。
interface SetAdsStatusResult { success: number; errors: string[] }
async function setAdsStatus(token: string, ids: string[], status: "PAUSED" | "ACTIVE"): Promise<SetAdsStatusResult> {
  const r = await Promise.allSettled(ids.map((id) => metaSetStatus(token, id, status)));
  const success = r.filter((x) => x.status === "fulfilled").length;
  const errors = r.filter((x): x is PromiseRejectedResult => x.status === "rejected").map((x) => String(x.reason?.message || x.reason));
  return { success, errors };
}
const pauseAds = (token: string, ids: string[]) => setAdsStatus(token, ids, "PAUSED");
const resumeAds = (token: string, ids: string[]) => setAdsStatus(token, ids, "ACTIVE");

// ============================================================
// 実行ロジック（停止 / 取消）— MCP・Slack 共通
// ============================================================
interface StopResult {
  alreadyStopped?: boolean;
  meta?: { configured: boolean; found: number; paused?: number; adNames?: string[]; adIds?: string[]; errors?: string[] };
  sheet?: any;
  cascade?: CascadeResult;
}

// BUG-112: 子CR(crN_NN)の集計表停止が成功した直後に呼ぶ。兄弟の子が全員停止済みになっていれば
// GAS側が親(crN)も集計表停止する（メモ「子供が全て停止」）。親は「子持ち親はMeta未入稿」が原則だが、
// 命名規則の例外（実は親にも広告がある）に備え、triggeredの場合はここでMeta側も念のため探して止める。
async function cascadeCheckAndStopParent(env: Env, p: Project, target: SheetTarget, childCreative: string, date: string): Promise<CascadeResult | undefined> {
  let cascade: CascadeResult;
  try {
    cascade = await callGas(target, { action: "cascade_check", creativeName: childCreative, stopDate: date });
  } catch (e) {
    return { triggered: false, reason: `cascade_check失敗: ${e}` };
  }
  if (!cascade?.triggered || !cascade.parentId) return cascade;

  const token = metaToken(env, p);
  if (token && p.metaAdAccountId) {
    try {
      const ads = await metaFindAds(token, p.metaAdAccountId, cascade.parentId);
      const active = ads.filter((a) => a.effective_status !== "PAUSED");
      if (active.length) {
        const r = await setAdsStatus(token, active.map((a) => a.id), "PAUSED");
        (cascade as any).meta = { found: ads.length, paused: r.success, errors: r.errors };
      }
    } catch (e) {
      (cascade as any).meta = { error: String(e) };
    }
  }
  return cascade;
}

async function doStop(env: Env, p: Project, creative: string, date: string): Promise<StopResult> {
  const out: StopResult = {};
  const token = metaToken(env, p);

  // A. Meta実停止
  if (token && p.metaAdAccountId) {
    const ads = await metaFindAds(token, p.metaAdAccountId, creative);
    if (ads.length === 0) {
      out.meta = { configured: true, found: 0 };
    } else {
      const active = ads.filter((a) => a.effective_status !== "PAUSED");
      if (active.length === 0) {
        // 全広告が既にPAUSE済 → 二重処理せずアラート（集計表も触らない）
        out.alreadyStopped = true;
        out.meta = { configured: true, found: ads.length, paused: 0, adNames: ads.map((a) => a.name) };
        return out;
      }
      // BUG-109: 直列awaitで無防備にthrowすると1件失敗しただけでB.集計表記録まで
      // 到達できず（claude.ai/MCP経由のstop_creativeで発生）、失敗理由も分からなかった。
      // setAdsStatus（Promise.allSettled）で並列実行しつつ成功件数と実際のエラー文言を取得する。
      const r = await setAdsStatus(token, active.map((a) => a.id), "PAUSED");
      out.meta = { configured: true, found: ads.length, paused: r.success, adNames: active.map((a) => a.name), adIds: active.map((a) => a.id), errors: r.errors };
    }
  } else {
    out.meta = { configured: false, found: 0 };
  }

  // B. 集計表記録（複数集計対象の案件は cr名で対象タブを判定）。Metaが一部/全部失敗しても必ず実行する。
  const target = await pickSheet(p, creative);
  out.sheet = target
    ? await callGas(target, { action: "stop", creativeName: creative, stopDate: date })
    : { success: false, message: "集計表に該当crが見つかりません(複数対象)" };

  // C. 親子連動チェック（BUG-112）。集計表停止が成功した場合のみ・失敗しても本処理は止めない
  if (target && out.sheet?.success) {
    try { out.cascade = await cascadeCheckAndStopParent(env, p, target, creative, date); } catch { /* ベストエフォート */ }
  }
  return out;
}

async function doUndo(env: Env, p: Project, creative: string, memoMode: "full" | "tag") {
  const out: any = { meta: null, sheet: null };
  // B. 集計表undo（先に実行。これが成功＝我々が停止した証拠）
  const target = await pickSheet(p, creative);
  out.sheet = target
    ? await callGas(target, { action: "undo", creativeName: creative, memoMode })
    : { success: false, message: "集計表に該当crが見つかりません(複数対象)" };
  // A. 集計表undoが成功した時のみMeta広告をACTIVEに戻す（無関係なPAUSE広告を誤って動かさない）
  const token = metaToken(env, p);
  if (out.sheet?.success && token && p.metaAdAccountId) {
    const ads = await metaFindAds(token, p.metaAdAccountId, creative);
    const paused = ads.filter((a) => a.effective_status === "PAUSED");
    const r = await setAdsStatus(token, paused.map((a) => a.id), "ACTIVE");
    out.meta = { resumed: r.success, adNames: paused.map((a) => a.name), adIds: paused.map((a) => a.id), errors: r.errors };
  }
  return out;
}

// 結果を1行メッセージへ
function fmtStop(out: StopResult, creative: string, date: string): string {
  if (out.alreadyStopped) {
    return `⚠️ ${creative} は既に停止済みです（Meta広告は全てPAUSE済）`;
  }
  const parts: string[] = [];
  if (out.meta?.configured) {
    parts.push(out.meta.found === 0 ? "⚠️Meta広告が見つかりません" : `Meta ${out.meta.paused}件停止`);
    if (out.meta.errors?.length) parts.push(`⚠️Meta失敗理由: ${out.meta.errors.join(" / ")}`);
  } else {
    parts.push("Meta未連携");
  }
  parts.push(out.sheet?.success ? `集計表 記録(${date})` : `集計表 失敗:${out.sheet?.message || "?"}`);
  { const line = cascadeNotifyLine(out.cascade, (s) => `「${s}」`); if (line) parts.push(line); }
  return `✅ ${creative} を停止しました｜${parts.join(" / ")}`;
}
function fmtUndo(out: any, creative: string, memoMode: string): string {
  if (!out.sheet?.success) return `⚠️ ${creative}: ${out.sheet?.message || "取消情報なし"}`;
  const parts: string[] = [];
  if (out.meta) {
    parts.push(`Meta ${out.meta.resumed}件再開`);
    if (out.meta.errors?.length) parts.push(`⚠️Meta失敗理由: ${out.meta.errors.join(" / ")}`);
  }
  parts.push(`集計表 復元(${memoMode})`);
  return `✅ ${creative} の停止を取り消しました｜${parts.join(" / ")}`;
}

// 全員表示用の詳細通知（チャンネルへ chat.postMessage）
function fmtPublicStop(out: StopResult, creative: string, date: string, by: string): string {
  const lines = [`🛑 *${creative}* を停止しました　${by}`];
  if (out.meta?.configured) {
    lines.push(out.meta.found === 0 ? "⚠️ Meta広告: 該当広告なし" : `✅ Meta広告: ${out.meta.paused}件 停止（PAUSE）`);
  } else {
    lines.push("・Meta: 未連携");
  }
  lines.push(out.sheet?.success ? `✅ 集計表: 記録・グレー化（${date}）` : `❌ 集計表: ${out.sheet?.message || "失敗"}`);
  { const line = cascadeNotifyLine(out.cascade, (s) => `*${s}*`); if (line) lines.push(line); }
  return lines.join("\n");
}
function fmtPublicUndo(out: any, creative: string, memoMode: string, by: string): string {
  const lines = [`↩️ *${creative}* の停止を取り消しました　${by}`];
  if (out.meta) lines.push(`✅ Meta広告: ${out.meta.resumed}件 再開（ACTIVE）`);
  lines.push(`✅ 集計表: 復元（${memoMode}）`);
  return lines.join("\n");
}

// Slackへ通知（全員表示）。成功可否を返す（失敗は操作者に警告表示するため）
async function notifySlack(env: Env, channelId: string, text: string): Promise<{ ok: boolean; error?: string }> {
  if (!env.SLACK_BOT_TOKEN || !channelId) return { ok: false, error: "no token/channel" };
  try {
    const post = async () => {
      const res = await fetchTimeout(
        "https://slack.com/api/chat.postMessage",
        {
          method: "POST",
          headers: { "Content-Type": "application/json; charset=utf-8", Authorization: `Bearer ${env.SLACK_BOT_TOKEN}` },
          body: JSON.stringify({ channel: channelId, text }),
        },
        15000,
      );
      return (await res.json()) as any;
    };
    let data = await post();
    if (!data.ok && data.error === "not_in_channel") {
      // Bot未参加チャンネル（BUG-29: rcl）→ publicなら参加を試みて1回だけ再送
      const j = await fetchTimeout(
        "https://slack.com/api/conversations.join",
        {
          method: "POST",
          headers: { "Content-Type": "application/json; charset=utf-8", Authorization: `Bearer ${env.SLACK_BOT_TOKEN}` },
          body: JSON.stringify({ channel: channelId }),
        },
        15000,
      );
      const jd: any = await j.json();
      if (jd.ok) data = await post();
    }
    return data.ok ? { ok: true } : { ok: false, error: data.error };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

function todayJST(): string {
  const jst = new Date(Date.now() + 9 * 60 * 60 * 1000);
  return `${jst.getUTCMonth() + 1}/${jst.getUTCDate()}`;
}

// Notion 実行ログDBへ1行追加（誰が何回停止したかの記録）。失敗は本処理を止めない。
interface LogEntry { creative: string; user: string; userId: string; action: "停止" | "取消"; project: string; route: "Slack" | "Claude"; metaCount: number; sheetResult: "成功" | "失敗" | "対象なし" }
async function logToNotion(env: Env, e: LogEntry): Promise<void> {
  if (!env.NOTION_TOKEN) return;
  try {
    await fetchTimeout(
      "https://api.notion.com/v1/pages",
      {
        method: "POST",
        headers: { Authorization: `Bearer ${env.NOTION_TOKEN}`, "Notion-Version": "2022-06-28", "Content-Type": "application/json" },
        body: JSON.stringify({
          parent: { database_id: NOTION_LOG_DB_ID },
          properties: {
            "クリエイティブ": { title: [{ text: { content: e.creative } }] },
            "実行者": { rich_text: [{ text: { content: e.user } }] },
            "実行者ID": { rich_text: [{ text: { content: e.userId } }] },
            "アクション": { select: { name: e.action } },
            "案件": { select: { name: e.project } },
            "経路": { select: { name: e.route } },
            "Meta件数": { number: e.metaCount },
            "集計表結果": { select: { name: e.sheetResult } },
          },
        }),
      },
      15000,
    );
  } catch {
    /* ログ失敗は本処理を止めない */
  }
}
function sheetResultLabel(sheet: any): "成功" | "失敗" | "対象なし" {
  if (sheet?.success) return "成功";
  if (/該当cr/.test(String(sheet?.message || ""))) return "対象なし";
  return "失敗";
}

// ── 統一「ツール実行ログDB」への結果マッピング（TOOL-40 翌日自動チェックくん）──
// 旧ログ(logToNotion=停止カウンター)は当面併記し、新DBには翌朝チェックに必要な
// ad id・タブ名まで記録する。ログ失敗は本処理を止めない（createRunLogがnullを返すだけ）。
function stopRunPatch(out: StopResult) {
  const metaResult = !out.meta?.configured
    ? "未実行"
    : out.alreadyStopped || out.meta.found === 0
      ? "対象なし"
      : (out.meta.paused || 0) > 0
        ? "成功"
        : "失敗";
  const sheetResult = out.alreadyStopped ? "未実行" : sheetResultLabel(out.sheet);
  const ok = metaResult !== "失敗" && sheetResult !== "失敗";
  return {
    status: ok ? "完了" : "一部失敗",
    metaResult,
    sheetResult,
    adIds: out.meta?.adIds || [],
    sheetTabs: out.sheet?.sheet ? [String(out.sheet.sheet)] : [],
    detail: out.meta?.errors?.length ? { metaError: out.meta.errors } : undefined,
  };
}
function undoRunPatch(out: any) {
  const sheetResult = sheetResultLabel(out.sheet);
  return {
    status: sheetResult !== "失敗" ? "完了" : "一部失敗",
    metaResult: out.meta ? "成功" : "未実行",
    sheetResult,
    adIds: out.meta?.adIds || [],
    detail: out.meta?.errors?.length ? { metaError: out.meta.errors } : undefined,
  };
}

// ============================================================
// 予算確定→波及くん（Notionボタン「リンクを開く」→ /budget）
//   Notion予算変更DBレコード → 集計表(monthly)へ予算波及 + Slack通知
//   桁数ミス警戒の運用文化に合わせ「人が確定確認 → 結果ページで確認」する安全設計。
// ============================================================

// 案件名(正式な)/別名 → Worker PROJECTS の短縮名 に寄せるための別名表。
// propagate_budget.yaml と思想は同じ（将来はCLDB rollupへ寄せる）。?case= で明示も可。
const BUDGET_CASE_ALIASES: Record<string, string> = {
  "グルーミング": "grm", "grm_集計": "grm", "n33_grm": "grm",
  "n11_jdem": "jdem",
  // jde（じぶんdeエステ）。集計表は kk_mak/kk_kou で「リクエスト予算」列は別セッションで追加予定。
  "じぶんdeエステ": "jdekmak",
};
const BUDGET_TAG_LABEL: Record<string, string> = {
  "予算UP": "予算UP", "予算DOWN": "予算DOWN", "停止": "停止", "再開": "再開",
  "一部cp(adset)の予算修正": "一部cp(adset)の予算修正",
};

// 円→万表記（末尾.0除去）。例 250000→"25", 125000→"12.5"
function manText(yen: number | null): string {
  if (yen == null || isNaN(yen)) return "?";
  const v = yen / 10000;
  return (Math.round(v * 10) / 10).toString();
}

// 桁数ミス警戒チェック。極端な乖離/桁外れを理由付きで返す。
function budgetAnomaly(before: number | null, after: number): string[] {
  const reasons: string[] = [];
  if (!(after > 0)) reasons.push("変更後予算が0以下");
  if (after > 0 && after < 10000) reasons.push(`変更後予算が1万円未満（${after.toLocaleString()}円）— 万→円の換算漏れの可能性`);
  if (after > 100_000_000) reasons.push(`変更後予算が1億円超（${after.toLocaleString()}円）— 桁過剰の可能性`);
  if (before && before > 0) {
    const r = after / before;
    if (r >= 5) reasons.push(`前比 ${r.toFixed(1)}倍（急増）`);
    else if (r <= 0.2) reasons.push(`前比 ${r.toFixed(2)}倍（急減）`);
  }
  return reasons;
}

// Notion レコード取得（予算変更DB）。必要プロパティを素直に抽出。
interface BudgetRecord {
  caseName: string; name: string; before: number | null; after: number; tag: string;
  changeDate: Date | null; messageText: string;
}
async function notionGetBudgetRecord(env: Env, pageId: string): Promise<BudgetRecord> {
  const res = await fetch(`https://api.notion.com/v1/pages/${pageId}`, {
    headers: { Authorization: `Bearer ${env.NOTION_TOKEN}`, "Notion-Version": "2022-06-28" },
  });
  const data: any = await res.json();
  if (data.object === "error") throw new Error(`Notion取得失敗: ${data.message}`);
  const props = data.properties || {};
  const numberOf = (p: any): number | null => (p && typeof p.number === "number" ? p.number : null);
  const textOf = (p: any): string => {
    const arr = p?.rich_text || p?.title || [];
    return Array.isArray(arr) ? arr.map((t: any) => t.plain_text || "").join("") : "";
  };
  const formulaText = (p: any): string => (p?.formula?.string || "");
  const tags: string[] = (props["Tags"]?.multi_select || []).map((o: any) => o.name);
  const dateStr: string = props["変更日"]?.date?.start || "";
  return {
    caseName: textOf(props["案件名(正式な)"]) || "",
    name: textOf(props["Name"]) || "",
    before: numberOf(props["変更前予算_月"]),
    after: numberOf(props["変更後予算_月"]) ?? NaN,
    tag: tags[0] || "予算変更",
    changeDate: dateStr ? new Date(dateStr) : null,
    messageText: formulaText(props["メッセージ(コピペ用)"]),
  };
}

// 案件名→Project解決。誤案件への書込を防ぐため、曖昧一致(startsWith等)は使わず
// 「?case= → 別名表 → レコード名先頭コードの“完全一致” → 案件名に短縮名包含」の順で安全側に倒す。
function resolveBudgetProject(caseName: string, caseParam: string, recordName: string): Project | undefined {
  if (caseParam) { const p = projectByName(caseParam); if (p) return p; }
  for (const [k, v] of Object.entries(BUDGET_CASE_ALIASES)) {
    if (caseName.includes(k) || recordName.includes(k)) { const p = projectByName(v); if (p) return p; }
  }
  // レコード名の先頭トークン（"una_銀座_予算ダウン"→"una"）が案件短縮名と“完全一致”した時だけ採用
  const token = (recordName.toLowerCase().match(/^[a-z0-9]+/) || [""])[0];
  if (token) { const p = projectByName(token); if (p) return p; }
  return PROJECTS.find((p) => caseName.toLowerCase().includes(p.name.toLowerCase()));
}

function budgetMemoLine(applyMD: string, tagLabel: string, before: number | null, after: number): string {
  return `${applyMD}_${tagLabel}${manText(before)}万→${manText(after)}万`;
}

// 結果HTML（人が確認する安全設計の結果ページ）
function budgetHtml(title: string, rows: [string, string][], note: string): Response {
  const trs = rows.map(([k, v]) => `<tr><th style="text-align:left;padding:6px 12px;color:#555">${k}</th><td style="padding:6px 12px;font-weight:600">${v}</td></tr>`).join("");
  const html = `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<div style="font-family:-apple-system,sans-serif;max-width:560px;margin:32px auto;padding:0 16px">
<h2 style="margin:0 0 4px">${title}</h2>
<table style="border-collapse:collapse;width:100%;background:#fafafa;border:1px solid #eee;border-radius:8px">${trs}</table>
<p style="color:#666;margin-top:16px;white-space:pre-wrap">${note}</p>
<p style="color:#999;font-size:12px">予算確定→波及くん / このタブは閉じて構いません。</p></div>`;
  return new Response(html, { headers: { "Content-Type": "text/html; charset=utf-8" } });
}

function handleBudget(env: Env, ctx: ExecutionContext, url: URL): Response | Promise<Response> {
  const token = url.searchParams.get("token") || "";
  if (!env.BUDGET_TOKEN || token !== env.BUDGET_TOKEN) {
    return budgetHtml("⛔ 認証エラー", [["理由", "token不一致"]], "リンクのtokenを確認してください。");
  }
  const recordId = url.searchParams.get("recordId") || "";
  if (!recordId) return budgetHtml("⛔ パラメータ不足", [["recordId", "なし"]], "");
  if (!env.NOTION_TOKEN) return budgetHtml("⛔ 設定不足", [["NOTION_TOKEN", "未設定"]], "wrangler secret put NOTION_TOKEN が必要です。");

  const dry = url.searchParams.get("dry") === "1";
  const caseParam = url.searchParams.get("case") || "";
  const monthParam = url.searchParams.get("month") || ""; // YYYY-MM 明示時

  return (async () => {
    try {
      const rec = await notionGetBudgetRecord(env, recordId);
      const project = resolveBudgetProject(rec.caseName, caseParam, rec.name);
      if (!project) return budgetHtml("⚠️ 案件解決できず", [["案件名", rec.caseName || "(空)"], ["レコード名", rec.name || "(空)"]],
        "?case=<短縮名> を付けるか、BUDGET_CASE_ALIASES に追加してください。");

      // 対象月：?month= 明示 → 変更日の月 → 当月
      const base = rec.changeDate || new Date(Date.now() + 9 * 3600 * 1000);
      let year = base.getFullYear(), month = base.getMonth() + 1;
      const mm = monthParam.match(/^(\d{4})-(\d{2})$/);
      if (mm) { year = +mm[1]; month = +mm[2]; }
      const applyMD = `${base.getMonth() + 1}/${base.getDate()}`;
      const tagLabel = BUDGET_TAG_LABEL[rec.tag] || rec.tag;
      const memoLine = budgetMemoLine(applyMD, tagLabel, rec.before, rec.after);
      const reasons = budgetAnomaly(rec.before, rec.after);
      const target = project.sheets[0]; // MVP: 先頭タブ（複数集計対象は次フェーズ）

      const slackText = rec.messageText
        ? rec.messageText
        : `💰 *${project.name}* 予算変更（${applyMD}）\n${manText(rec.before)}万 → *${manText(rec.after)}万*（${tagLabel}）\n対象月: ${year}年${("0" + month).slice(-2)}月`;

      // 桁数異常 or dry → 書込まずプレビュー
      if (dry || reasons.length) {
        const gas = await callGas(target, { action: "budget_propagate", targetYear: year, targetMonth: month, requestBudget: rec.after, memoText: memoLine, prevBudget: rec.before, dryRun: true });
        // GAS側で検出に失敗（例: 集計表に「リクエスト予算」列が無い案件）→ 理由を明示
        if (gas.success === false) {
          return budgetHtml("⚠️ 集計表の準備が未完了（書込していません）", [
            ["案件", project.name], ["対象月", `${year}年${("0" + month).slice(-2)}月`],
            ["理由", gas.message || "集計表の対象セルを特定できません"],
          ], `この案件の集計表は本ツールの想定（meta_total に「リクエスト予算」列・monthly月次行）と異なります。\n` +
             `「リクエスト予算」列の整備後に再実行してください。\n\nSlack下書き（参考）:\n${slackText}`);
        }
        return budgetHtml(reasons.length ? "⚠️ 確認が必要です（書込していません）" : "👀 プレビュー（DRY-RUN）", [
          ["案件", project.name], ["対象月", `${year}年${("0" + month).slice(-2)}月`],
          ["リクエスト予算", `${gas.currentBudget ?? "?"} → ${rec.after.toLocaleString()}（${manText(rec.before)}万→${manText(rec.after)}万）`],
          ["書込先セル", `${gas.budgetCell || "?"} / メモ ${gas.memoCell || "?"}`],
          ["メモ追記", memoLine],
        ], (reasons.length ? `⛔ 桁数/乖離アラート:\n・${reasons.join("\n・")}\n\n` : "") +
          `Slack下書き:\n${slackText}\n\nこの内容で問題なければ、ボタンのURLから dry=1 を外して（または通常ボタンで）再実行してください。`);
      }

      // 本実行：集計表書込 → Slack通知 → Notionチェック更新
      const gas = await callGas(target, { action: "budget_propagate", targetYear: year, targetMonth: month, requestBudget: rec.after, memoText: memoLine, prevBudget: rec.before, dryRun: false });
      if (!gas.success) return budgetHtml("❌ 集計表書込に失敗", [["メッセージ", gas.message || "?"]], JSON.stringify(gas));

      const slack = await notifySlack(env, project.channelId, slackText);
      ctx.waitUntil(notionMarkBudgetDone(env, recordId)); // チェックボックス更新（失敗は止めない）

      return budgetHtml("✅ 波及しました", [
        ["案件", project.name], ["対象月", gas.targetMonth],
        ["リクエスト予算", `${gas.budgetCell} = ${rec.after.toLocaleString()}（${manText(rec.after)}万）`],
        ["メモ", `${gas.memoCell} に「${memoLine}」`],
        ["Slack通知", slack.ok ? "✅ 送信済" : `⚠️ 失敗（${slack.error}）`],
      ], `集計表（${project.name}）の${gas.targetMonth} リクエスト予算欄とメモを更新しました。`);
    } catch (e) {
      return budgetHtml("❌ エラー", [["内容", String(e)]], "");
    }
  })();
}

// 波及完了後、レコードの確認チェックボックスをON（集計表記載した?）。失敗は無視。
async function notionMarkBudgetDone(env: Env, pageId: string): Promise<void> {
  if (!env.NOTION_TOKEN) return;
  try {
    await fetch(`https://api.notion.com/v1/pages/${pageId}`, {
      method: "PATCH",
      headers: { Authorization: `Bearer ${env.NOTION_TOKEN}`, "Notion-Version": "2022-06-28", "Content-Type": "application/json" },
      body: JSON.stringify({ properties: { "集計表記載した？": { checkbox: true } } }),
    });
  } catch { /* ログ同様、本処理を止めない */ }
}

// ============================================================
// MCP サーバー（claude.ai / モバイル用）
// ============================================================
export class CreativeStopMCP extends McpAgent<Env> {
  server = new McpServer({ name: "creative-stop-hub", version: "3.0.0" });

  async init() {
    const env = this.env;
    const asText = (o: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(o, null, 2) }] });
    const resolve = async (creativeName: string, project?: string): Promise<Project[]> =>
      project ? ([projectByName(project)].filter(Boolean) as Project[]) : await findProjects(creativeName);

    this.server.tool(
      "stop_creative",
      "クリエイティブを停止（Meta広告を実PAUSE＋集計表に記録）。project省略時はfindで案件自動判定（複数一致はエラー）。stopDate省略時は今日(JST)。",
      {
        creativeName: z.string().describe("クリエイティブ名。例: cr45"),
        project: z.string().optional().describe("案件名 jdem/hyd/grm。省略可"),
        stopDate: z.string().optional().describe('"M/D"。省略時は今日'),
      },
      async ({ creativeName, project, stopDate }) => {
        const date = stopDate || todayJST();
        const targets = await resolve(creativeName, project);
        if (targets.length === 0) return asText({ success: false, message: `該当案件なし: ${creativeName}` });
        if (targets.length > 1) return asText({ success: false, message: `複数案件に存在(${targets.map((t) => t.name).join(",")})。projectを指定してください` });
        const p = targets[0];
        const runLogId = await createRunLog(env.NOTION_TOKEN, { tool: "cr停止くん", action: "停止", project: p.name, crName: creativeName, userName: "claude.ai", userId: "", route: "Claude" });
        const out = await doStop(env, p, creativeName, date);
        if (!out.alreadyStopped && out.sheet?.success) await notifySlack(env, p.channelId, fmtPublicStop(out, creativeName, date, "via Claude"));
        await logToNotion(env, { creative: creativeName, user: "claude.ai", userId: "", action: "停止", project: p.name, route: "Claude", metaCount: out.meta?.paused || 0, sheetResult: out.alreadyStopped ? "対象なし" : sheetResultLabel(out.sheet) });
        await updateRunLog(env.NOTION_TOKEN, runLogId, stopRunPatch(out));
        return asText({ project: p.name, message: fmtStop(out, creativeName, date), ...out });
      },
    );

    this.server.tool(
      "undo_creative",
      "クリエイティブ停止を取り消す（Meta広告をACTIVE復帰＋集計表undo）。memoMode: full=セルごと復元 / tag=停止タグのみ削除。",
      {
        creativeName: z.string(),
        project: z.string().optional(),
        memoMode: z.enum(["full", "tag"]).default("full"),
      },
      async ({ creativeName, project, memoMode }) => {
        const targets = await resolve(creativeName, project);
        if (targets.length === 0) return asText({ success: false, message: `該当案件なし: ${creativeName}` });
        if (targets.length > 1) return asText({ success: false, message: `複数案件に存在(${targets.map((t) => t.name).join(",")})。projectを指定してください` });
        const p = targets[0];
        const runLogId = await createRunLog(env.NOTION_TOKEN, { tool: "cr停止くん", action: "取消", project: p.name, crName: creativeName, userName: "claude.ai", userId: "", route: "Claude" });
        const out = await doUndo(env, p, creativeName, memoMode);
        if (out.sheet?.success) await notifySlack(env, p.channelId, fmtPublicUndo(out, creativeName, memoMode, "via Claude"));
        await logToNotion(env, { creative: creativeName, user: "claude.ai", userId: "", action: "取消", project: p.name, route: "Claude", metaCount: out.meta?.resumed || 0, sheetResult: sheetResultLabel(out.sheet) });
        await updateRunLog(env.NOTION_TOKEN, runLogId, undoRunPatch(out));
        return asText({ project: p.name, message: fmtUndo(out, creativeName, memoMode), ...out });
      },
    );

    this.server.tool("list_projects", "登録済み案件の一覧", {}, async () =>
      asText(PROJECTS.map((p) => ({ name: p.name, channelId: p.channelId, metaConnected: !!p.metaAdAccountId }))),
    );

    // BUG-112: 「子供のクリエイティブが全て止まった時に親のクリエイティブも停止」を、機能導入前から
    // 既にその状態になっているデータへ一括適用するための監査ツール。dryRun=trueがデフォルト
    // （まず検出結果を確認してから dryRun=false で実行する運用を想定。cr停止くん本体は今後、
    // 子CRを止めるたびにこの判定を自動実行する＝ここでの一括適用は主に既存データの棚卸し用）。
    this.server.tool(
      "cascade_audit_parents",
      "「子CRが全員停止済みなのに親CRが未停止」の組を検出し、該当すれば親も停止（集計表メモ「子供が全て停止」＋Meta実停止を試行）。dryRun=true(既定)は検出のみで書き込みしない。",
      {
        project: z.string().describe("案件名。例: jdek（jde両訴求）/ jdekmak / jdekkou"),
        dryRun: z.boolean().default(true).describe("true=検出のみ（既定）。false=実際に親を停止する"),
        stopDate: z.string().optional().describe('メモに使う日付"M/D"。省略時は今日（実際にはcustomNote「子供が全て停止」を書くため通常は未使用）'),
      },
      async ({ project, dryRun, stopDate }) => {
        const p = projectByName(project);
        if (!p) return asText({ success: false, message: `案件不明: ${project}` });
        const date = stopDate || todayJST();
        const perSheet: any[] = [];
        for (const target of p.sheets) {
          let audit: any;
          try {
            audit = await callGas(target, { action: "cascade_audit", stopDate: date, dryRun });
          } catch (e) {
            perSheet.push({ sheetName: target.sheetName || "meta_total", error: String(e) });
            continue;
          }
          // dryRun=falseで実際に親が停止された場合、Meta側も念のため探して止める（子持ち親は通常Meta未入稿）
          if (!dryRun && audit?.results?.length) {
            const token = metaToken(env, p);
            for (const r of audit.results) {
              if (!r?.stopResult?.success || !token || !p.metaAdAccountId) continue;
              try {
                const ads = await metaFindAds(token, p.metaAdAccountId, r.parentId);
                const active = ads.filter((a) => a.effective_status !== "PAUSED");
                if (active.length) {
                  const mr = await setAdsStatus(token, active.map((a) => a.id), "PAUSED");
                  r.meta = { found: ads.length, paused: mr.success, errors: mr.errors };
                }
              } catch (e) { r.meta = { error: String(e) }; }
            }
            if (audit.results.length) {
              await notifySlack(env, p.channelId, `👨‍👧 親子連動停止（監査）: ${audit.results.map((r: any) => r.parentId).join(", ")} を「子供が全て停止」で自動停止しました（via Claude）`);
            }
          }
          perSheet.push({ sheetName: target.sheetName || audit?.sheet || "meta_total", ...audit });
        }
        return asText({ project: p.name, dryRun, sheets: perSheet });
      },
    );

    // BUG-113: 「チェックボックスはON(停止済み)なのに集計表がグレー化されていない」CRの調査で判明した、
    // cr停止くん経由でない（手動チェック等の）過去の停止記録を一括是正するための棚卸しツール。
    // チェックボックス・メモ文言は一切変更せず、背景色（グレー化）のみを対象範囲に再適用する。
    this.server.tool(
      "regray_stopped_creatives",
      "チェックボックスがON(停止済み)なのに列群が未グレー化のCRを検出し、背景をグレー化する（チェック・メモは変更しない）。dryRun=true(既定)は検出のみ。",
      {
        project: z.string().describe("案件名。例: jdek（jde両訴求）/ jdekmak / jdekkou"),
        dryRun: z.boolean().default(true).describe("true=検出のみ（既定）。false=実際にグレー化する"),
      },
      async ({ project, dryRun }) => {
        const p = projectByName(project);
        if (!p) return asText({ success: false, message: `案件不明: ${project}` });
        const perSheet: any[] = [];
        for (const target of p.sheets) {
          try {
            const r = await callGas(target, { action: "regray_check", dryRun });
            perSheet.push({ sheetName: target.sheetName || r?.sheet || "meta_total", ...r });
          } catch (e) {
            perSheet.push({ sheetName: target.sheetName || "meta_total", error: String(e) });
          }
        }
        return asText({ project: p.name, dryRun, sheets: perSheet });
      },
    );
  }
}

// ============================================================
// Slack 署名検証
// ============================================================
const enc = new TextEncoder();
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
async function verifySlack(request: Request, signingSecret: string, bodyText: string): Promise<boolean> {
  const ts = request.headers.get("x-slack-request-timestamp");
  const sig = request.headers.get("x-slack-signature");
  if (!ts || !sig || !signingSecret) return false;
  if (Math.abs(Date.now() / 1000 - Number(ts)) > 300) return false;
  const key = await crypto.subtle.importKey("raw", enc.encode(signingSecret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = await crypto.subtle.sign("HMAC", key, enc.encode(`v0:${ts}:${bodyText}`));
  const hex = [...new Uint8Array(mac)].map((b) => b.toString(16).padStart(2, "0")).join("");
  return timingSafeEqual(`v0=${hex}`, sig);
}

// ============================================================
// Slack ハンドラ
// ============================================================
function slackJson(obj: unknown): Response {
  return new Response(JSON.stringify(obj), { headers: { "Content-Type": "application/json" } });
}
function parseArgs(text: string): { creative: string; date: string } {
  const toks = String(text || "").trim().split(/[\s,]+/).filter(Boolean);
  return { creative: toks[0] ? toks[0].toLowerCase() : "", date: toks[1] || "" };
}
function adLine(a: MetaAd): string {
  const tag = a.effective_status === "PAUSED" ? "（既に停止済）" : a.effective_status === "ACTIVE" ? "（配信中）" : `（${a.effective_status}）`;
  return `*${a.name}* ${tag}\n　CP: ${a.campaignName || "?"} ／ AS: ${a.adsetName || "?"}`;
}

// Meta連携あり: 検索結果から停止確認ブロックを組む（2件以上は広告ごと個別選択）
function buildStopBlocks(project: string, creative: string, date: string, ads: MetaAd[]) {
  // 集計表だけ記録（Metaは触らない）ボタン共通
  const sheetOnlyBtn = { type: "button", text: { type: "plain_text", text: "集計表だけ記録" }, action_id: "do_stop_sheet", value: JSON.stringify({ a: "stop", p: project, c: creative, d: date, ad: [] }) };
  const cancelBtn = { type: "button", text: { type: "plain_text", text: "キャンセル" }, action_id: "cancel", value: JSON.stringify({ a: "cancel" }) };

  if (ads.length === 0) {
    // Metaに該当広告なし（命名違い/削除済/集計表のみ運用 等）→ 集計表だけ記録できる
    return {
      response_type: "ephemeral",
      blocks: [
        { type: "section", text: { type: "mrkdwn", text: `⚠️ *${creative}* に一致するMeta広告が見つかりません。\n（Metaの広告名が違う/削除済 等の可能性）。集計表にだけ記録しますか？` } },
        { type: "actions", elements: [sheetOnlyBtn, cancelBtn] },
      ],
    };
  }
  const active = ads.filter((a) => a.effective_status !== "PAUSED");

  if (active.length === 0) {
    // Meta は既に全て停止済み → Metaは触らず集計表だけ記録できる
    return {
      response_type: "ephemeral",
      blocks: [
        { type: "section", text: { type: "mrkdwn", text: `⚠️ *${creative}* は Meta広告が既に全て停止済みです（${ads.length}件）。\n集計表にだけ記録しますか？` } },
        { type: "actions", elements: [sheetOnlyBtn, cancelBtn] },
      ],
    };
  }

  if (ads.length === 1) {
    const a = ads[0];
    return {
      response_type: "ephemeral",
      blocks: [
        { type: "section", text: { type: "mrkdwn", text: `*${project}* で以下を停止します（${date}）。よろしいですか？\n${adLine(a)}` } },
        { type: "actions", elements: [
          { type: "button", style: "danger", text: { type: "plain_text", text: "停止する" }, action_id: "do_stop", value: JSON.stringify({ a: "stop", p: project, c: creative, d: date, ad: [a.id] }) },
          sheetOnlyBtn,
          cancelBtn,
        ] },
      ],
    };
  }

  // 2件以上 → 広告ごとに個別選択（別キャンペーンの巻き込み事故を防ぐ）
  const blocks: any[] = [
    { type: "section", text: { type: "mrkdwn", text: `⚠️ *${project}* で *${creative}* に一致する広告が *${ads.length}件* あります（${date}）。\n止めたい広告を選んでください。` } },
    { type: "divider" },
  ];
  for (const a of ads) {
    const sec: any = { type: "section", text: { type: "mrkdwn", text: adLine(a) } };
    if (a.effective_status !== "PAUSED") {
      sec.accessory = { type: "button", style: "danger", text: { type: "plain_text", text: "この広告を停止" }, action_id: `do_stop_${a.id}`, value: JSON.stringify({ a: "stop", p: project, c: creative, d: date, ad: [a.id] }) };
    }
    blocks.push(sec);
  }
  blocks.push({ type: "divider" });
  blocks.push({ type: "actions", elements: [
    { type: "button", style: "danger", text: { type: "plain_text", text: `配信中をすべて停止 (${active.length}件)` }, action_id: "do_stop_all", value: JSON.stringify({ a: "stop", p: project, c: creative, d: date, ad: active.map((x) => x.id) }) },
    sheetOnlyBtn,
    cancelBtn,
  ] });
  return { response_type: "ephemeral", blocks };
}

// Meta連携あり: 取消確認（PAUSED広告を個別/全件でACTIVE復帰、集計表はtagで取消）
function buildUndoBlocks(project: string, creative: string, ads: MetaAd[]) {
  const paused = ads.filter((a) => a.effective_status === "PAUSED");
  if (paused.length === 0) {
    return {
      response_type: "ephemeral",
      blocks: [
        { type: "section", text: { type: "mrkdwn", text: `再開対象(PAUSED)のMeta広告がありません。集計表のメモだけ取り消しますか？` } },
        { type: "actions", elements: [
          { type: "button", text: { type: "plain_text", text: "集計表のみ取消(tag)" }, action_id: "do_undo", value: JSON.stringify({ a: "undo", p: project, c: creative, m: "tag", ad: [] }) },
          { type: "button", text: { type: "plain_text", text: "キャンセル" }, action_id: "cancel", value: JSON.stringify({ a: "cancel" }) },
        ] },
      ],
    };
  }
  if (paused.length === 1) {
    const a = paused[0];
    return {
      response_type: "ephemeral",
      blocks: [
        { type: "section", text: { type: "mrkdwn", text: `*${project}* で以下を再開します。よろしいですか？\n${adLine(a)}` } },
        { type: "actions", elements: [
          { type: "button", style: "primary", text: { type: "plain_text", text: "再開する" }, action_id: "do_undo", value: JSON.stringify({ a: "undo", p: project, c: creative, m: "tag", ad: [a.id] }) },
          { type: "button", text: { type: "plain_text", text: "キャンセル" }, action_id: "cancel", value: JSON.stringify({ a: "cancel" }) },
        ] },
      ],
    };
  }
  const blocks: any[] = [
    { type: "section", text: { type: "mrkdwn", text: `*${project}* で *${creative}* の停止中広告が *${paused.length}件* あります。\n再開したい広告を選んでください。` } },
    { type: "divider" },
  ];
  for (const a of paused) {
    blocks.push({ type: "section", text: { type: "mrkdwn", text: adLine(a) }, accessory: { type: "button", style: "primary", text: { type: "plain_text", text: "この広告を再開" }, action_id: `do_undo_${a.id}`, value: JSON.stringify({ a: "undo", p: project, c: creative, m: "tag", ad: [a.id] }) } });
  }
  blocks.push({ type: "divider" });
  blocks.push({ type: "actions", elements: [
    { type: "button", style: "primary", text: { type: "plain_text", text: `すべて再開 (${paused.length}件)` }, action_id: "do_undo_all", value: JSON.stringify({ a: "undo", p: project, c: creative, m: "tag", ad: paused.map((x) => x.id) }) },
    { type: "button", text: { type: "plain_text", text: "キャンセル" }, action_id: "cancel", value: JSON.stringify({ a: "cancel" }) },
  ] });
  return { response_type: "ephemeral", blocks };
}

// Meta未連携(grm等): 集計表のみの確認
function simpleStopConfirm(project: string, creative: string, date: string) {
  return { response_type: "ephemeral", blocks: [
    { type: "section", text: { type: "mrkdwn", text: `*${project}* の *${creative}* を *${date}* で停止しますか？（Meta未連携＝集計表のみ）` } },
    { type: "actions", elements: [
      { type: "button", style: "danger", text: { type: "plain_text", text: "停止する" }, action_id: "do_stop", value: JSON.stringify({ a: "stop", p: project, c: creative, d: date, ad: [] }) },
      { type: "button", text: { type: "plain_text", text: "キャンセル" }, action_id: "cancel", value: JSON.stringify({ a: "cancel" }) },
    ] },
  ] };
}
function simpleUndoConfirm(project: string, creative: string) {
  return { response_type: "ephemeral", blocks: [
    { type: "section", text: { type: "mrkdwn", text: `*${project}* の *${creative}* の停止を取り消します（Meta未連携＝集計表のみ）。どちらで？` } },
    { type: "actions", elements: [
      { type: "button", text: { type: "plain_text", text: "タグのみ削除" }, action_id: "do_undo_tag", value: JSON.stringify({ a: "undo", p: project, c: creative, m: "tag", ad: [] }) },
      { type: "button", style: "danger", text: { type: "plain_text", text: "丸ごと復元" }, action_id: "do_undo_full", value: JSON.stringify({ a: "undo", p: project, c: creative, m: "full", ad: [] }) },
      { type: "button", text: { type: "plain_text", text: "キャンセル" }, action_id: "cancel", value: JSON.stringify({ a: "cancel" }) },
    ] },
  ] };
}

// 実行結果メッセージ（Slack専用・明示ID版）
function stopLines(creative: string, date: string, paused: number, sheet: any, metaOn: boolean, by: string, cascade?: CascadeResult): string {
  const lines = [`🛑 *${creative}* を停止しました${by ? `　${by}` : ""}`];
  lines.push(!metaOn ? "・Meta: 未連携" : paused > 0 ? `✅ Meta広告: ${paused}件 停止（PAUSE）` : "・Meta広告: 変更なし（集計表のみ）");
  lines.push(sheet?.success ? `✅ 集計表: 記録・グレー化（${date}）` : `❌ 集計表: ${sheet?.message || "失敗"}`);
  { const line = cascadeNotifyLine(cascade, (s) => `*${s}*`); if (line) lines.push(line); }
  return lines.join("\n");
}
function undoLines(creative: string, memoMode: string, resumed: number, sheet: any, metaOn: boolean, by: string): string {
  const lines = [`↩️ *${creative}* の停止を取り消しました${by ? `　${by}` : ""}`];
  if (metaOn) lines.push(`✅ Meta広告: ${resumed}件 再開（ACTIVE）`);
  lines.push(sheet?.success ? `✅ 集計表: 復元（${memoMode}）` : `⚠️ 集計表: ${sheet?.message || "取消情報なし"}`);
  return lines.join("\n");
}

function handleSlackCommand(env: Env, ctx: ExecutionContext, bodyText: string, senv: SubmitEnv): Response {
  const params = new URLSearchParams(bodyText);
  const command = params.get("command");
  const text = params.get("text") || "";
  const channelId = params.get("channel_id") || "";
  const responseUrl = params.get("response_url") || "";
  const project = projectByChannel(channelId);
  if (!project) {
    return slackJson({ response_type: "ephemeral", text: `このチャンネルは案件未登録です（channel_id=${channelId}）。Workerのレジストリに追加が必要です。` });
  }

  // ── cr入稿くん: /cr-in <cr名 or NotionページURL> ──
  if (command === "/cr-in") {
    if (!metaToken(env, project) || !project.metaAdAccountId) {
      return slackJson({ response_type: "ephemeral", text: `この案件（${project.name}）はMeta未連携のため入稿できません。` });
    }
    if (!project.crdbDataSourceId && !/notion|^[0-9a-f-]{32,36}$/i.test(text.trim())) {
      return slackJson({ response_type: "ephemeral", text: `この案件（${project.name}）は入稿未対応です（crdbDataSourceId未設定）。NotionページURLでの指定なら可能です。` });
    }
    return handleCrInCommand(
      { text, channel_id: channelId, user_id: params.get("user_id") || "", response_url: responseUrl },
      project as SubmitProject,
      senv,
      ctx,
      (p) => metaToken(env, p as Project)!,
    );
  }
  const { creative, date } = parseArgs(text);
  if (!creative) return slackJson({ response_type: "ephemeral", text: "使い方: `/cr-stop <cr名> [M/D]`（日付省略で今日）" });
  const stopDate = date || todayJST();
  const token = metaToken(env, project);

  // Meta未連携(grm等) → 集計表のみの確認（同期応答）
  if (!token || !project.metaAdAccountId) {
    if (command === "/cr-stop") return slackJson(simpleStopConfirm(project.name, creative, stopDate));
    if (command === "/cr-undo") return slackJson(simpleUndoConfirm(project.name, creative));
    return slackJson({ response_type: "ephemeral", text: `未知のコマンド: ${command}` });
  }

  // Meta連携あり → 広告を検索してから一覧確認（重いのでdeferred）
  ctx.waitUntil(
    (async () => {
      try {
        await postResponse(responseUrl, { response_type: "ephemeral", text: `🔎 *${creative}* のMeta広告を検索中…` });
        const ads = await metaFindAds(token, project.metaAdAccountId!, creative);
        const blocks = command === "/cr-undo" ? buildUndoBlocks(project.name, creative, ads) : buildStopBlocks(project.name, creative, stopDate, ads);
        await postResponse(responseUrl, blocks);
      } catch (e) {
        await postResponse(responseUrl, { response_type: "ephemeral", text: `❌ Meta検索エラー: ${e}` });
      }
    })(),
  );
  return new Response("", { status: 200 });
}

async function postResponse(url: string, body: unknown): Promise<void> {
  if (!url) return;
  try {
    await fetchTimeout(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }, 15000);
  } catch {
    /* response_urlへの通知失敗は本処理を止めない（呼び出し元でnotifySlack等の後続処理を続行させるため） */
  }
}

function handleSlackInteract(env: Env, ctx: ExecutionContext, bodyText: string, senv: SubmitEnv): Response {
  const params = new URLSearchParams(bodyText);
  let payload: any = {};
  try { payload = JSON.parse(params.get("payload") || "{}"); } catch {}
  const responseUrl: string = payload.response_url;
  const userId: string = payload.user?.id || "";
  const userName: string = payload.user?.username || payload.user?.name || userId;

  // ── cr入稿くん: action_id が crin_ で始まるものは submit 側で処理 ──
  const actionId: string = payload.actions?.[0]?.action_id || "";
  if (actionId.startsWith("crin_")) {
    const ch = payload.channel?.id || payload.container?.channel_id || "";
    const p = projectByChannel(ch);
    return handleCrInInteraction(
      payload,
      p as SubmitProject | undefined,
      senv,
      ctx,
      (pr) => metaToken(env, pr as Project)!,
      (pr) => pr.sheets,
    );
  }

  let v: any = {};
  try { v = JSON.parse(payload.actions?.[0]?.value || "{}"); } catch {}

  // キャンセルも cold-start 耐性のため即200ACK＋response_url で確実に更新（同期応答だと押下無反応になることがある）
  if (v.a === "cancel") {
    ctx.waitUntil(postResponse(responseUrl, { replace_original: true, text: "✖️ キャンセルしました（停止・取消は実行していません）。もう一度操作する場合は再度コマンドを入力してください。" }));
    return new Response("", { status: 200 });
  }

  const project = projectByName(v.p);
  if (!project) return slackJson({ replace_original: true, text: `案件不明: ${v.p}` });
  const token = metaToken(env, project);
  const metaOn = !!(token && project.metaAdAccountId);
  const ids: string[] = Array.isArray(v.ad) ? v.ad : [];

  // 即ACK（cold-start耐性）。進捗・結果は response_url 経由。
  ctx.waitUntil(
    (async () => {
      try {
        await postResponse(responseUrl, { replace_original: true, text: `⏳ *${v.c}* を${v.a === "undo" ? "取消" : "停止"}実行中…` });
        const inviteNote = (err?: string) => `\n⚠️ チャンネルへの全員通知に失敗（${err}）。このチャンネルで \`/invite @cr停止\` を実行してください。`;
        // 実行ログDB（TOOL-40）: 開始時に「実行中」で作成。途中死してもチェッカーが検出できる
        const runLogId = await createRunLog(env.NOTION_TOKEN, { tool: "cr停止くん", action: v.a === "undo" ? "取消" : "停止", project: project.name, crName: v.c, userName, userId, route: "Slack" });
        const runLogWarn = !runLogId && env.NOTION_TOKEN ? "\n⚠️ 実行ログの記録に失敗（翌日自動チェックの対象外になります）" : "";
        // Meta失敗は集計表を止めない（権限不足等でも集計表記録は実行し、Metaエラーは併記）
        let metaErr = "";
        // 実際のGraph APIエラー文言（BUG-109: 従来は件数しか分からず原因切り分けができなかった）
        let metaErrDetail: string[] = [];
        const target = await pickSheet(project, v.c); // 複数集計対象の案件は cr名で対象タブを判定
        if (v.a === "stop") {
          let paused = 0;
          if (metaOn && ids.length) {
            try {
              const r = await pauseAds(token!, ids);
              paused = r.success;
              if (paused < ids.length) { metaErr = `${ids.length - paused}件の停止に失敗`; metaErrDetail = r.errors; }
            } catch (e) { metaErr = String(e); metaErrDetail = [String(e)]; }
          }
          const sheet = target ? await callGas(target, { action: "stop", creativeName: v.c, stopDate: v.d }) : { success: false, message: "集計表に該当crなし(複数対象)" };
          // BUG-112: 子CRの集計表停止が成功したら、兄弟の子が全員停止済みかチェックし、
          // 該当すれば親CRも自動停止する（失敗しても本処理は止めない）
          let cascade: CascadeResult | undefined;
          if (target && sheet?.success) {
            try { cascade = await cascadeCheckAndStopParent(env, project as Project, target, v.c, v.d); } catch { /* ベストエフォート */ }
          }
          const extra = (metaErr ? `\n⚠️ Meta停止に失敗（${metaErr}）：${metaErrDetail.join(" / ") || "詳細不明"}` : "");
          let note = extra + runLogWarn;
          if (paused || sheet?.success) {
            const r = await notifySlack(env, project.channelId, stopLines(v.c, v.d, paused, sheet, metaOn, `by <@${userId}>`, cascade) + extra);
            if (!r.ok) note += inviteNote(r.error);
          }
          await postResponse(responseUrl, { replace_original: true, text: stopLines(v.c, v.d, paused, sheet, metaOn, "", cascade) + note });
          await logToNotion(env, { creative: v.c, user: userName, userId, action: "停止", project: project.name, route: "Slack", metaCount: paused, sheetResult: sheetResultLabel(sheet) });
          await updateRunLog(env.NOTION_TOKEN, runLogId, {
            status: !metaErr && sheetResultLabel(sheet) !== "失敗" ? "完了" : "一部失敗",
            metaResult: !metaOn ? "未実行" : ids.length === 0 ? "対象なし" : metaErr ? "失敗" : "成功",
            sheetResult: sheetResultLabel(sheet),
            adIds: ids,
            sheetTabs: sheet?.sheet ? [String(sheet.sheet)] : target?.sheetName ? [target.sheetName] : [],
            detail: metaErrDetail.length || cascade?.triggered ? { metaError: metaErrDetail, cascade: cascade?.triggered ? cascade : undefined } : undefined,
          });
        } else {
          let resumed = 0;
          if (metaOn && ids.length) {
            try {
              const r = await resumeAds(token!, ids);
              resumed = r.success;
              if (resumed < ids.length) { metaErr = `${ids.length - resumed}件の再開に失敗`; metaErrDetail = r.errors; }
            } catch (e) { metaErr = String(e); metaErrDetail = [String(e)]; }
          }
          const sheet = target ? await callGas(target, { action: "undo", creativeName: v.c, memoMode: v.m || "tag" }) : { success: false, message: "集計表に該当crなし(複数対象)" };
          const extra = (metaErr ? `\n⚠️ Meta再開に失敗（${metaErr}）：${metaErrDetail.join(" / ") || "詳細不明"}` : "");
          let note = extra + runLogWarn;
          if (resumed || sheet?.success) {
            const r = await notifySlack(env, project.channelId, undoLines(v.c, v.m || "tag", resumed, sheet, metaOn, `by <@${userId}>`) + extra);
            if (!r.ok) note += inviteNote(r.error);
          }
          await postResponse(responseUrl, { replace_original: true, text: undoLines(v.c, v.m || "tag", resumed, sheet, metaOn, "") + note });
          await logToNotion(env, { creative: v.c, user: userName, userId, action: "取消", project: project.name, route: "Slack", metaCount: resumed, sheetResult: sheetResultLabel(sheet) });
          await updateRunLog(env.NOTION_TOKEN, runLogId, {
            status: !metaErr && sheetResultLabel(sheet) !== "失敗" ? "完了" : "一部失敗",
            metaResult: !metaOn ? "未実行" : ids.length === 0 ? "対象なし" : metaErr ? "失敗" : "成功",
            sheetResult: sheetResultLabel(sheet),
            adIds: ids,
            sheetTabs: target?.sheetName ? [target.sheetName] : [],
            detail: metaErrDetail.length ? { metaError: metaErrDetail } : undefined,
          });
        }
      } catch (e) {
        await postResponse(responseUrl, { replace_original: true, text: `❌ エラー: ${e}` });
      }
    })(),
  );

  return new Response("", { status: 200 });
}

// ============================================================
// ルーター
// ============================================================
export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    // --- Slack（署名検証で保護。秘密パス不要）---
    if (url.pathname === "/slack/command" || url.pathname === "/slack/interact") {
      const bodyText = await request.text();
      if (!(await verifySlack(request, env.SLACK_SIGNING_SECRET, bodyText))) {
        return new Response("invalid signature", { status: 401 });
      }
      const senv = submitEnvOf(env, url.origin);
      return url.pathname === "/slack/command" ? handleSlackCommand(env, ctx, bodyText, senv) : handleSlackInteract(env, ctx, bodyText, senv);
    }

    // --- cr入稿くん: continuation（HMAC署名で自己検証。Slack署名不要）---
    if (url.pathname === CONTINUE_PATH && request.method === "POST") {
      return handleContinue(
        request,
        submitEnvOf(env, url.origin),
        ctx,
        (name) => metaToken(env, projectByName(name)!)!,
        (name) => projectByName(name)!.sheets,
        (name) => projectByName(name)!.metaAdAccountId!,
      );
    }

    // --- 予算確定→波及くん（Notionボタン「リンクを開く」→ GET /budget）---
    if (url.pathname === "/budget") {
      return handleBudget(env, ctx, url);
    }

    // --- 翌日自動チェックくん（TOOL-40）---
    if (url.pathname === CHECK_CONTINUE_PATH && request.method === "POST") {
      return handleCheckContinue(request, env as unknown as CheckEnv, ctx, checkDeps(env));
    }
    if (url.pathname === "/check/run") {
      // 手動起動（cronを待たずにテスト）: ?token=<SHARED_SECRET>&dryRun=1&date=YYYY-MM-DD&channel=CXXXX&force=1
      return handleCheckRun(url, env as unknown as CheckEnv, ctx, checkDeps(env));
    }

    // --- MCP（共有シークレットをフルパスで保持）---
    const base = `/${env.SHARED_SECRET}`;
    if (url.pathname === `${base}/sse` || url.pathname === `${base}/sse/message`) {
      return CreativeStopMCP.serveSSE(`${base}/sse`).fetch(request, env, ctx);
    }
    if (url.pathname === `${base}/mcp`) {
      return CreativeStopMCP.serve(`${base}/mcp`).fetch(request, env, ctx);
    }

    return new Response("Not found", { status: 404 });
  },

  // 毎朝 7:30 JST（= 22:30 UTC。wrangler.jsonc triggers.crons）に前日分をチェック
  async scheduled(_event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(
      startDailyCheck(env as unknown as CheckEnv, checkDeps(env)).catch((e) => console.log(`daily check failed: ${e}`))
    );
  },
};

// チェックモジュールへ注入する依存（PROJECTSレジストリ・トークン解決。循環import回避のためここで束ねる）
function checkDeps(env: Env): CheckDeps {
  return {
    projects: PROJECTS,
    metaTokenFor: (p) => metaToken(env, p as Project),
  };
}
