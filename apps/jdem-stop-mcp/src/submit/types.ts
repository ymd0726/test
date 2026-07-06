// cr入稿くん 型定義
// 既存 jdem-stop-mcp の PROJECTS レジストリを拡張して使う。
// 既存エントリ（name / channelId / sheets[] / metaAdAccountId? / metaTokenSecret?）に
// 入稿用の追加フィールドを足したもの。

export interface ProjectSheet {
  spreadsheetId: string;
  sheetName?: string;
}

export interface SubmitProject {
  /** 案件キー（例: jdekmak）。既存PROJECTSのnameと同じ */
  name: string;
  /** Slack channel_id（チャンネル=案件） */
  channelId: string;
  /** 集計表（既存と共通） */
  sheets: ProjectSheet[];
  /** Meta広告アカウントID（act_なし数値） */
  metaAdAccountId?: string;
  /** BM別トークンを使う場合のシークレット名（既存と共通） */
  metaTokenSecret?: string;

  // ---- 入稿用の追加フィールド ----
  /** CLDB案件ページID。設定時は「cr倉庫_(GoogleDrive) #納品先」プロパティからcrフォルダを実行時解決（最優先） */
  cldbPageId?: string;
  /** Google Drive のcrフォルダID（CLDB未設定/読取失敗時のフォールバック） */
  driveFolderId?: string;
  /** Drive フォルダを名前検索する場合のフォルダ名（例: "cr_grm"） */
  driveFolderName?: string;
  /** Notion CRDB の data source ID（クリエイティブ指示ページの検索先） */
  crdbDataSourceId?: string;
  /** Meta広告名の慣習: "full"=Notionページ名そのまま / "short"=cr{N}のみ */
  adNameStyle?: "full" | "short";
  /** 入稿先として提示する広告セットを限定したい場合のID配列（省略時はアカウント内のACTIVEな広告セットを列挙） */
  adsetAllowlist?: string[];
  /**
   * 設定時は /cr-in をこの理由で即エラー終了させる（既知の未解決事項がある案件用）。
   * 例: 集計表タブ名がCLDB記載と不一致・ID行未特定・複数Driveフォルダで1件に決め打てない等。
   * 解決したら削除してcr入稿くんを有効化する。
   */
  submitBlocked?: string;
}

/** /cr-in 解決フェーズの結果（確認ボタンに埋め込む実行プラン） */
export interface SubmitPlan {
  project: string;
  /** 親cr名（Notionページ名 = Driveファイル名ベース。例: jde_mak_cr79_ブライダル訴求） */
  parentName: string;
  /** cr番号部分（例: cr79） */
  crKey: string;
  /** NotionページID（ステータス更新用） */
  notionPageId?: string;
  /** Notionから拾った上書き値（無ければ直近広告からコピー） */
  overrides: CreativeTextOverrides;
  /** 入稿する動画ファイル（パターン無しなら親1件、パターン有りなら子のみ） */
  videos: PlannedVideo[];
  /** パターン（子）があるか。集計表の親子展開に使う */
  hasChildren: boolean;
  /** 入稿先広告セット */
  adsetId: string;
  adsetName: string;
  /** 入稿先キャンペーン名（完了通知の表示用） */
  campaignName?: string;
  /** テキスト類のコピー元広告 */
  sourceAdId: string;
  sourceAdName: string;
  /** Slack返信先 */
  channelId: string;
  responseUrl: string;
  userId: string;
}

export interface PlannedVideo {
  /** Meta広告名（例: jde_mak_cr79_01_ブライダル訴求 or cr79_01） */
  adName: string;
  /** 集計表に記載するID（例: cr79_01_ブライダル訴求 / 親は cr79_ブライダル訴求） */
  sheetId: string;
  /** Drive file */
  driveFileId: string;
  driveFileName: string;
  fileSizeBytes: number;
  mimeType: string;
  /** 実行中に埋まる */
  videoId?: string;
  creativeId?: string;
  adId?: string;
}

export interface CreativeTextOverrides {
  message?: string; // メインテキスト
  title?: string; // 見出し
  linkUrl?: string; // 遷移先URL（パラメータ含む）
}

/** self-chaining continuation の状態 */
export interface ContinuationState {
  step: "upload" | "wait_ready" | "create_ads" | "sheet" | "notion" | "done";
  /** videos[] のうち現在処理中のindex（upload/wait_ready用） */
  index: number;
  /** wait_ready の試行回数（バックオフ・上限用） */
  attempts: number;
  plan: SubmitPlan;
  startedAt: number;
}

export interface SubmitEnv {
  // 既存Workerと共通のシークレット
  SLACK_BOT_TOKEN: string;
  SLACK_SIGNING_SECRET: string;
  META_ACCESS_TOKEN: string;
  META_TOKEN_LOCAL?: string;
  NOTION_TOKEN: string;
  COMMON_GAS_URL: string;
  /** 入稿専用GAS（独立プロジェクト）。未設定時はCOMMON_GAS_URLにフォールバック */
  SUBMIT_GAS_URL?: string;
  // 入稿用に追加するシークレット
  GOOGLE_SERVICE_ACCOUNT_JSON: string; // Drive読み取り（ads-reader@... を流用可）
  /** continuation の署名・self-fetch 用（SHARED_SECRETを流用してもよい） */
  SHARED_SECRET: string;
  /** 自分自身のURL（continuation self-fetch用）例: https://jdem-stop-mcp.lead1504.workers.dev */
  SELF_URL: string;
  /** 自分自身へのService Binding（wrangler.jsonc services）。公開URL経由の自己fetchはCloudflareが404にするため必須 */
  SELF_WORKER?: { fetch: (input: Request | string, init?: RequestInit) => Promise<Response> };
}

export const GRAPH = "https://graph.facebook.com/v21.0";

/** Meta動画チャンクサイズ（Workerメモリに載せる単位。Drive Range取得と一致させる） */
export const UPLOAD_CHUNK_BYTES = 8 * 1024 * 1024; // 8MB

/** wait_ready ポーリング上限（1hop=1回チェック、Slack進捗を出しつつ最大N回） */
export const MAX_READY_ATTEMPTS = 60; // ~5分相当（5秒間隔×60）
