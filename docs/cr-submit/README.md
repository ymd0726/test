# cr入稿くん（クリエイティブ入稿 自動化）設計・導入ガイド

> Slack `/cr-in <cr名 or NotionページURL>` 一発で
> **Drive動画→Metaメディアライブラリにアップ（動画ID取得）→ 広告クリエイティブ＋広告(PAUSED)作成 → 集計表CR00ブロック展開（親＋パターン子）→ Notionステータス更新 → Slack通知**
> まで自動化する。最後の「広告ON」だけ人が行う。
> 既存「cr停止くん」（Cloudflare Worker `jdem-stop-mcp` ＋ 共通GAS ＋ Slackアプリ「cr停止」）の拡張。

## 全体アーキテクチャ

```
① Slack /cr-in cr79   （チャンネル=案件を自動判定。/cr-stopと同じ）
      ↓ 署名検証・即ACK
② Cloudflare Worker jdem-stop-mcp（決定論的・LLMなし）
   [解決フェーズ]
     Notion CRDBからCRページ特定 → Drive cr_フォルダから完成ファイル列挙(親+_NNパターン)
     → Meta広告セット候補＋各セットの直近cr広告(コピー元)取得
     → Slackに実行プラン確認ボタン（広告セット複数なら選択ボタン）
   [実行フェーズ]（self-chaining continuation で長時間処理を分割）
     a. Drive→Meta 動画チャンク転送（/advideos start/transfer/finish。メモリに全量を載せない）
     b. 動画status ポーリング → ready
     c. コピー元広告のcreative specをdeep copy
        （video_id/広告名/テキスト差替、cr=パラメータ自動更新、エンハンス・関連メディア明示OFF）
        → POST /adcreatives → POST /ads (status=PAUSED)  ※パターンごと
     d. 共通GAS action=submitCreative → CR00ブロック複製挿入（親=集計内 / 子=集計外）
     e. Notion: CRページのステータス=入稿済み ＋ 実行ログDB記録
     f. Slack: 結果サマリー（video_id・ad_id・集計表結果）
③ バックエンド: Meta Graph API / 共通GAS / Notion API / Google Drive API
```

## リポジトリ内の成果物

| パス | 内容 |
|---|---|
| `apps/jdem-stop-mcp/src/submit/` | Worker追加モジュール（TypeScript）。既存index.tsへの結合は `integration.md` 参照 |
| `apps/jdem-stop-mcp/gas/submitCreative_common.gs` | 共通GASへ追加する集計表展開（action=submitCreative / submitUndo） |
| `scripts/cr-submit/inspect_sheet.mjs` | 集計表構造の読み取り専用ダンプ（Phase 0調査） |
| `.github/workflows/inspect-sheet.yml` | 上記をGitHub Actionsで実行（既存 `GOOGLE_SERVICE_ACCOUNT_JSON` シークレット使用） |
| `docs/cr-submit/integration.md` | 既存Worker index.ts への結合手順 |
| `docs/cr-submit/sheet-structure-jde_mak.md` | jde_mak集計表の実測結果（Phase 0） |

## 前提（ユーザー作業）

1. **既存Workerソースの取り込み**: `auto_report/jdem-stop-mcp/` 一式（`src/index.ts`, `wrangler.toml` 等）を
   このリポジトリの `apps/jdem-stop-mcp/` へコミットする。`gas/stopCreative_common.gs` も `gas/` へ。
   → 取り込み後、`integration.md` の手順で結合（数十行の追記）。
2. **Slackアプリ「cr停止」にコマンド追加**: `/cr-in`（Request URL は既存と同じ `https://jdem-stop-mcp.lead1504.workers.dev/slack/command`）
3. **Workerシークレット追加**:
   - `GOOGLE_SERVICE_ACCOUNT_JSON` … Drive読み取り用。ad-analysisと同じ `ads-reader@gtm-ppzfmhfm-nty3y.iam.gserviceaccount.com` を流用可。
     **対象のDrive crフォルダ（例: 運用代行業/n22_jde/cr_jde…）をこのSAに閲覧共有すること**
   - `SELF_URL` … Worker自身のURL（continuation self-fetch用）: `https://jdem-stop-mcp.lead1504.workers.dev`
   - （`SHARED_SECRET` / `META_ACCESS_TOKEN` / `NOTION_TOKEN` / `COMMON_GAS_URL` は既存を流用）
4. **共通GASに `submitCreative_common.gs` を追加**して doPost ルーティングに2行追記 → 「デプロイを管理 → 新バージョン」でデプロイ（URL維持）
5. **PROJECTSレジストリに入稿用フィールドを追記**（対象案件のみ）:

```ts
// 例: jde_mak（#z-n22_jde_kk_mak）
{
  name: "jdekmak",
  channelId: "C09S1F9TXSP",
  sheets: [{ spreadsheetId: "1oEK8JCJg2NcseWmnxLtfNFCe5A7XGJ_DJSj7c2EW1sg", sheetName: "<jde_makのタブ名>" }],
  metaAdAccountId: "1533513563939156",   // n22_jdes（jde_mak/jde_kouが同居）
  // ---- cr入稿くん用 ----
  driveFolderName: "cr_jde",             // または driveFolderId 直指定
  crdbDataSourceId: "2c155406-c36d-4d7d-9d2a-22aefd4f17cf", // CRDB
  adNameStyle: "full",                   // jde系はフル名称（jde_mak_cr84_バナー動画_… を実測確認済み）
  adsetAllowlist: ["120246843077960183"], // mak本体の広告セット（候補を絞る場合）
}
```

## 動作仕様の要点

### 命名（CR名の命名規則 #入稿ルール に準拠）
- Notionページ名 = Driveファイル名 = `{案件}_cr{N}_{説明}`。パターン子は `{案件}_cr{N}_{XX}_{説明}`
- **Meta広告名**: `adNameStyle: "full"` ならファイル名そのまま（jde系の実測慣習）。`"short"` なら `cr{N}` / `cr{N}_{XX}`
- **集計表表記**: 案件コードを除いた `cr{N}_{説明}` / `cr{N}_{XX}_{説明}`
- URLパラメータ `cr=` はコピー元のリンクから新cr名に自動置換

### テキスト類（メインテキスト/見出し/遷移先URL）
- 基本は**同一広告セットの直近cr広告からコピー**（手動の「クイック複製」と同じ安全性）
- Notion CRページに `メインテキスト` / `見出し` / `遷移先URL` プロパティがあれば**その項目だけ上書き**
- エンハンス（standard_enhancements）= OPT_OUT、関連メディア（contextual_multi_ads）= OPT_OUT を**常に明示設定**

### 集計表展開（CR00複製）
- 親（または単独CR）→ 集計内ゾーン（`集計外CR→`マーカー左）のcr00ブロックの**直右**に挿入
- パターン子 → 集計外ゾーン（マーカー右）のcr00ブロックの**直右**に `_01, _02…` 順で挿入
- 書式・数式・入力規則ごと複製し、ID行セルだけ書き換え
- メモ列2行目の親子分類を自動設定（`親（子有り）`/`親（子無し）`/`子`）。親（子有り）は3行目判定式を「子にて判定」でラップ
- **列グループ化はcopyToでコピーされないため明示的に再作成**（既知問題対応）
- 既に同名IDが存在する場合は中断（二重入稿防止）。`submitUndo` で挿入列の削除が可能

### 冪等性・安全設計
- 実行前に Meta 同名広告の存在チェック（あれば警告表示）／集計表側も既存IDチェックで中断
- 実行は**確認ボタン**（confirmダイアログ付き）を経てから。広告は必ず **PAUSED** で作成
- 途中失敗時は「どこまで作成済みか（video_id / ad_id）」をSlackに明示。再実行時は作成済みをスキップ
- Meta API 25秒 / GAS 25秒タイムアウト（cr停止くんと同じ思想）

### Worker実行時間の制約対策（本設計の技術的要点）
動画アップロード＋Meta処理待ちは数分かかり得るため、
**1リクエスト=1単位の仕事**（動画1本のアップロード、statusチェック1回など）にし、
残りの状態をHMAC署名付きJSONで `POST {SELF_URL}/internal/cr-in/continue` に送って連鎖する。
進捗は Slack response_url で随時更新（「⏳ cr79_01 アップロード中(2/4)…」）。
> 運用でアップロードが30秒制限等に当たる場合は、チャンク単位を1ホップに分割 or Cloudflare Queues への移行を検討。

## Phase 0 調査（実装結合前に実行）

1. GitHub Actions →「集計表 構造ダンプ（cr入稿くん Phase 0）」→ Run workflow
   - sheet: `1oEK8JCJg2NcseWmnxLtfNFCe5A7XGJ_DJSj7c2EW1sg`（jde集計）
   - tab: 空（cr00を含むタブを自動検出）
2. ログの実測結果を `docs/cr-submit/sheet-structure-jde_mak.md` に反映
3. GAS `dryRun: true` で展開計画が実測と一致することを確認してから本実行

## 検証手順（jde_makでE2E）

1. **構造検証**: inspect実測 ↔ GAS dryRunの計画が一致
2. **Slackフロー**: `/cr-in cr79` → プラン表示（ファイル・パターン数・テキスト出所・警告）→ 広告セット選択/確認 → 実行
3. **Meta検証**: video_idが発行され、creative/adがPAUSEDで作成。広告マネージャで
   エンハンス0件・関連メディアOFF・URLパラメータ`cr=`一致 を目視確認
4. **集計表検証**: 親子ブロックがcr00直右に正しい幅・書式・プルダウン・グループ化付きで挿入。
   挿入前後で既存の主要集計セルが壊れていないこと
5. **Notion/ログ**: CRページ ステータス=入稿済み、実行ログDBに「入稿」行
6. **冪等性**: 同じ `/cr-in` を2回 → 2回目は集計表側で中断、Meta側は同名警告
7. **本番**: 次回の実入稿1件を本ツールで実施 → 人が広告ONにするまでの一連を確認

## 制限事項・今後

- コピー元広告が `video_data` 形式（動画広告）であること。画像/カルーセル/asset_feedのコピー元は未対応（エラーで案内）
- 列グループ化の再現は深度1のみ対応
- ファーストカットのサムネイル画像セル挿入は未対応（Driveサムネイル `=IMAGE()` 参照が実現候補）
- daily/weekly/monthlyタブへの同時展開は `gasTargetsFor()` に対象を足せば可能（初期はmeta系1タブのみ）
- 実行ログDBのアクション選択肢に「入稿」を追加しておくこと
- **crフォルダのCLDB管理（横展開時のTODO・山田提案 2026-07-04）**:
  現在はWorkerレジストリに `driveFolderId` を直書き（案件追加のたびにデプロイが必要）。
  案件ごとにフォルダ位置が異なるため、横展開時はCLDBに「crフォルダ」プロパティ（DriveフォルダURL）を追加し、
  Workerが解決フェーズでCLDBから読む方式へ切替える（コードは folderId/folderName 両対応済みのため、
  CLDB読取関数を1つ足して resolveFolderId に渡すだけで移行可能）。マッピング管理が現場で完結しデプロイ不要になる。
