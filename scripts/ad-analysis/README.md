# 継続分析エージェント（GitHub Actions 版）

集計表(Google Sheets)を読み → Claude で分析 → Notion「広告分析ログDB」へ **upsert** する定期実行ジョブです。
GitHub のサーバー上でスケジュール実行されるため、**セッション不要・7日制限なし・GASのような回数上限なし**で常設できます。

- 週次: 毎週月曜 07:07 JST（`.github/workflows/weekly-ad-analysis.yml`）… `分析頻度=週次` の案件（予算200万↑）
- 月次: 毎月2日 07:10 JST（`.github/workflows/monthly-ad-analysis.yml`）… `分析頻度=月次` の案件（予算50〜200万）
- 頻度は Notion CLDB の formula 列 `分析頻度`（`合計予算目安` から自動判定）で決まります。

## しくみ
1. Notion CLDB(`案件別のDB`) から `分析頻度` が対象の案件を取得
2. 各案件の `集計表URL`(gid付き) をサービスアカウントで読む
3. 対象期間のシート内容を Claude に渡し、KPI抽出＋分析本文を生成
4. 広告分析ログDB へ upsert（同一 `案件 × 対象期間 × 粒度` は**更新**＝育てる/二重作成しない）
5. Slack に結果を通知（任意）

作成レコードは常に `ステータス=下書き`。人が確認して「完了」に上げる運用です。

---

## セットアップ（初回のみ）

### 1. Notion インテグレーション（トークン）
1. https://www.notion.so/my-integrations で「内部インテグレーション」を作成 → トークン取得（`secret_...`）
2. 以下の2つのDBを、そのインテグレーションに**共有**（各DB右上「•••」→「コネクトの追加」）
   - CLDB(案件別のDB)
   - 広告分析ログDB
   - ※ CLDB配下の案件ページ(リレーション先)も共有対象に含まれるようにしてください

### 2. Google サービスアカウント（集計表の読み取り）
1. Google Cloud で**サービスアカウント**を作成し、**JSON鍵**をダウンロード
2. Google Sheets API を有効化
3. 対象の集計表スプレッドシートを、そのサービスアカウントのメール(`xxx@xxx.iam.gserviceaccount.com`)に**閲覧者で共有**
   - jde等が入っている大型ブックを共有すれば、gid別タブ(mak/kou等)も読めます

### 3. Anthropic APIキー
- https://console.anthropic.com でAPIキーを取得

### 4. GitHub Secrets / Variables 登録
リポジトリ **Settings → Secrets and variables → Actions** で登録：

| 種別 | 名前 | 値 |
|---|---|---|
| Secret | `NOTION_TOKEN` | Notionインテグレーションのトークン |
| Secret | `ANTHROPIC_API_KEY` | Anthropic APIキー |
| Secret | `GOOGLE_SERVICE_ACCOUNT_JSON` | サービスアカウントJSONの**中身まるごと** |
| Secret | `SLACK_WEBHOOK_URL` | （任意）Slack Incoming Webhook URL |
| Variable | `ANTHROPIC_MODEL` | （任意）既定 `claude-sonnet-5`。変えたい時だけ |

---

## テスト実行（手動）
1. リポジトリ **Actions** タブ → 「週次 広告分析エージェント」→ **Run workflow**
2. `dry_run` を `true` にすると **Notionへ書き込まず**、抽出結果だけログに出ます（まず`true`で確認推奨）
3. 問題なければ `dry_run=false` で本実行 → 広告分析ログDBに `下書き` が作られます

## 動作の調整ポイント
- `run.mjs` 冒頭の定数（DB ID / モデル / シート文字数上限）
- KPI抽出の精度はプロンプト（`analyzeWithClaude`）で調整可能
- 集計表のレイアウトが特殊な案件は、Claudeが対象期間を拾えずスキップされることがあります（ログにスキップ理由が出ます）

## コスト・上限
- GitHub Actions: パブリック無料枠/プライベートも月2,000分無料。週次+月次で消費はごく僅か
- Anthropic API: 案件数×1回の分析コールのみ。Slack/Notion/Sheetsは無料枠内

## キャンセル/停止
- ワークフローを止めたい場合は各 `.yml` の `on.schedule` をコメントアウト、または Actions で無効化
