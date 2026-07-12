// 翌日自動チェックくん（TOOL-40） 型定義
//
// cr入稿くん・cr停止くんが統一「ツール実行ログDB」に書いた前日分の実行記録を、
// 毎朝7:30(JST)に Meta / 集計表 / Notion の実態と照合する。
// 将来ツールの追加は「①実行時にログDBへ書く ②checkers.ts のレジストリに1つ足す」の2点のみ。

/** 実行ログDBの1レコード（Notionプロパティをパースしたもの） */
export interface RunLogRecord {
  pageId: string;
  url: string;
  /** ツール名（チェッカー選択キー。例: cr入稿くん / cr停止くん） */
  tool: string;
  action: string; // 入稿 / 停止 / 取消
  project: string;
  crName: string;
  userName: string;
  userId: string; // Slackユーザー ID（<@U…>メンション用）
  status: string; // 実行中 / 完了 / 一部失敗 / 失敗
  metaResult: string;
  sheetResult: string;
  notionResult: string;
  adIds: string[];
  adsetIds: string[];
  sheetTabs: string[];
  notionCrPageId: string;
  detail: Record<string, any>; // 詳細JSON
  checkResult: string; // 未チェック / OK / 警告 / NG
  checkDetail: Record<string, any>; // チェック詳細（filedBugs等）
  createdIso: string;
}

/** チェック1項目の結果 */
export interface CheckItem {
  /** 機械可読キー（BUG dedupeに使う。例: meta_ad_active） */
  key: string;
  /** 日本語の項目名（Slack/BUG表示用） */
  label: string;
  status: "OK" | "NG" | "WARN" | "SKIP";
  severity: "高" | "中" | "低";
  /** NG/WARN時の説明（期待と実際） */
  message?: string;
  expected?: unknown;
  actual?: unknown;
}

/** チェッカーに渡すコンテキスト（PROJECTS等は index.ts から注入。循環import回避） */
export interface CheckContext {
  env: CheckEnv;
  project?: CheckProject;
  metaToken?: string;
}

/** index.ts の Project のうちチェックに必要な部分（構造的部分型） */
export interface CheckProject {
  name: string;
  channelId: string;
  sheets: { spreadsheetId: string; sheetName?: string }[];
  metaAdAccountId?: string;
  metaTokenSecret?: string;
}

export interface CheckDeps {
  projects: CheckProject[];
  metaTokenFor: (p: CheckProject) => string | undefined;
}

export interface CheckEnv {
  NOTION_TOKEN?: string;
  SLACK_BOT_TOKEN?: string;
  SHARED_SECRET: string;
  GOOGLE_SERVICE_ACCOUNT_JSON?: string;
  /** 朝チェック結果を投稿する管理チャンネル（wrangler vars） */
  CHECK_SLACK_CHANNEL_ID?: string;
  SELF_WORKER?: { fetch: (input: Request | string, init?: RequestInit) => Promise<Response> };
  SELF_URL?: string;
  [key: string]: any;
}

/** self-chaining continuation の状態（/internal/check/continue で持ち回る） */
export interface CheckState {
  /** チェック対象日（JSTのYYYY-MM-DD。通常は昨日） */
  dateJst: string;
  /** dryRun: BUG起票・チェック結果書き戻しをしない（Slack投稿のみ） */
  dryRun: boolean;
  /** alwaysNotify: 正常時（異常なし・0件）でもSlackへ投稿する（BUG-47。既定は false＝異常時のみ投稿） */
  alwaysNotify: boolean;
  /** 投稿先チャンネル（省略時は CHECK_SLACK_CHANNEL_ID） */
  channelId: string;
  runIds: string[];
  cursor: number;
  startedAt: number;
  summary: CheckSummary;
}

export interface CheckSummary {
  ok: number;
  warn: number;
  ng: number;
  /** チェッカー未登録ツールのrun（黙って無視しない） */
  unknownTool: string[];
  /** NG run の表示行（メンション・BUGリンク込み） */
  ngLines: string[];
  /** 警告 run の表示行 */
  warnLines: string[];
  /** OK run の短い表示（[入稿] jdem/cr79 等） */
  okLines: string[];
  /** run単位でチェック処理自体が失敗したもの */
  errors: string[];
}
