# jdem-stop-mcp — クリエイティブ停止 MCP サーバー

claude.ai / Claudeモバイルアプリ から自然言語で Meta広告クリエイティブの
**停止 / 取り消し** を実行するための、Cloudflare Worker 製リモートMCPサーバー。

```
[claude.ai / スマホアプリ] --(MCP)--> [このWorker] --(HTTP)--> [GAS Web App] --> [スプレッドシート meta_total]
```

- 既存の GAS Web App は **無改造**。本Workerが GAS の「302→echoへGET」を内部処理する。
- 公開URLになるため **共有シークレットをURLパス先頭で要求**して匿名アクセスを遮断する。
- 公開ツール: `stop_creative(creativeName, stopDate)` / `undo_creative(creativeName, memoMode)`

---

## 前提

- Node.js 18+ がインストール済み
- Cloudflare アカウント（無料プランで可。Durable Objects も無料枠で動く）

---

## セットアップ手順

### 1. 依存をインストール
```bash
cd jdem-stop-mcp
npm install
```

### 2. Cloudflare にログイン
```bash
npx wrangler login
```
ブラウザが開くので承認する。

### 3. シークレットを2つ登録
```bash
# デプロイ済み GAS Web App の /exec URL
npx wrangler secret put GAS_WEBAPP_URL
# 入力プロンプトに貼り付け:
# https://script.google.com/macros/s/AKfycbzKsvdgS4kI-HKL0cuEFKJfeNMHgcKoxczy47F6gA5Hd4b4GagdHXg2sWgbkRTkikWk/exec

# 接続URLのパス先頭で要求する共有シークレット（長いランダム文字列を推奨）
npx wrangler secret put SHARED_SECRET
# 例: 32文字程度のランダム英数字。生成例 →  openssl rand -hex 16
```
> ⚠️ `SHARED_SECRET` はこの後の接続URLに入る合言葉。第三者に知られると停止操作を実行されるので、
> 推測されない長い文字列にする。漏れたら `wrangler secret put SHARED_SECRET` で再設定すれば即無効化できる。

### 4. デプロイ
```bash
npm run deploy
```
完了すると次のようなURLが表示される:
```
https://jdem-stop-mcp.<あなたのサブドメイン>.workers.dev
```

### 5. 動作確認（任意・ローカルから）
MCPエンドポイントは `/<SHARED_SECRET>/mcp`（Streamable HTTP。**claude.ai接続はこちらを使う**）と
`/<SHARED_SECRET>/sse`（SSE。旧方式）。シークレット無し/誤りは **404** になることを先に確認できる:
```bash
# 誤ったシークレット → 404
curl -s -o /dev/null -w "%{http_code}\n" -m 5 https://jdem-stop-mcp.<sub>.workers.dev/wrong/mcp    # → 404
# 正しいシークレット → 404 以外（接続が続くため 000/405 等になる）
curl -s -o /dev/null -w "%{http_code}\n" -m 5 https://jdem-stop-mcp.<sub>.workers.dev/<SHARED_SECRET>/mcp
```
> この2つを見比べると「シークレットが合っているか」を確実に切り分けられる（両方 404 なら値が不一致）。

---

## claude.ai への接続（Web側で設定 → モバイルへ自動同期）

1. claude.ai → **Settings → Connectors → Add custom connector（「+」）**
2. 名前: `jdem 停止` など
3. URL: 下記を入力（`<...>` を自分の値に置換）
   ```
   https://jdem-stop-mcp.<あなたのサブドメイン>.workers.dev/<SHARED_SECRET>/mcp
   ```
   > ⚠️ **末尾は `/mcp`**。`/sse`（旧方式）だと claude.ai は接続できず、
   > 「サインインサービスに登録できませんでした／OAuth Client IDを追加してください」という
   > **紛らわしいエラー**になる（OAuthの設定不足ではない。2026-07-17 に確認）。
4. 保存すると `stop_creative` / `undo_creative` がツールとして見えるようになる。
   設定はWeb側で行えば **モバイル / デスクトップ / Web に自動同期**される（モバイル単体では追加不可）。

### 使い方（Claudeへの指示例）
- 「**cr45 を 6/14 で停止して**」 → `stop_creative` が呼ばれる
- 「**さっきの cr45 の停止を取り消して。手書きメモは残したい**」 → `undo_creative`（memoMode=tag）
  - full / tag が曖昧なときは Claude が確認するよう、ツール説明に明記済み

---

## 他案件への展開

現状は GAS Web App 1件（jdem / meta_total）に固定。複数案件に広げる場合は:

- **案A（推奨・疎結合）**: 案件ごとに GAS をデプロイし、`src/index.ts` の `callGas` を
  「creativeName または project 引数 → Web App URL」のマップ参照に変更。シークレットで案件別Workerに分けても良い。
- **案B**: 案件ごとにこのWorkerを別名デプロイ（`wrangler.jsonc` の `name` と `GAS_WEBAPP_URL` を変える）。

クリエイティブ名は案件横断で重複しない前提（引き継ぎメモのB案）なので、案Aで creativeName からルーティング可能。

---

## トラブルシュート

| 症状 | 原因 / 対処 |
|---|---|
| 「サインインサービスに登録できませんでした / OAuth Client IDを追加してください」 | **OAuthの問題ではない**。①URL末尾が `/sse` になっている（→ `/mcp` に直す） ②`<SHARED_SECRET>` が現在値と不一致。上記 curl の2本比較で切り分ける |
| Claude接続時に 404 / つながらない | URLの `<SHARED_SECRET>` が `wrangler secret` の値と不一致（本Workerは非該当パスを404で返す） |
| `wrangler: command not found` | 作業フォルダが Google Drive 同期内で `node_modules` 破損。同期外へコピーし `rm -rf node_modules && npm install` |
| `Wrangler requires at least Node.js v22` | Node が古い。nodejs.org の LTS を入れてターミナルを開き直す |
| ツール実行で `JSON以外が返りました` | GASデプロイの「アクセスできるユーザー」が **全員** でない。要再設定 |
| `クリエイティブが見つかりません` | creativeName または対象タブの不一致（GAS側 CONFIG.SHEET_NAME を確認） |
| ログ確認 | `npx wrangler tail` でリアルタイムログ |

## 翌日自動チェックくん（TOOL-40）

毎朝 **7:30 JST**（Cron `30 22 * * *` UTC）に、前日実行された cr入稿くん / cr停止くん の結果を
Meta / 集計表 / Notion の実態と照合する。**異常（NG/警告/未登録/エラー）があるときだけ** Slack管理
チャンネルへサマリを1通投稿する（BUG-47: 正常稼働・0件の日は投稿しない）。チェッカー自体の起動・実行
エラーは 🚨 で投稿するため、"異常なのに沈黙" にはならない。
NG は ClaudeTool のバグ報告DBへ自動起票（機械可読JSON付き、実行者メンション付き通知）。

- 実行記録: 両ツールが実行開始時に統一「ツール実行ログDB」へ書き込む（`src/check/runlog.ts`）。
  DB本体は Notion TOOL-40 ページ配下に **Worker が初回に自動作成**する（手動作成・ID設定は不要。
  Workerの Notion インテグレーションが TOOL-40 ページを参照できる必要あり）。
- チェック本体: `src/check/`（orchestrator=index.ts / checkers.ts / meta.ts / sheets.ts / bug.ts / report.ts）。
  実処理は `/internal/check/continue` の自己連鎖（cr入稿くんと同じ SELF_WORKER 方式）。
- 集計表の検証は Sheets API の読み取り専用（GASの再デプロイ不要）。SAは Drive 用の
  `GOOGLE_SERVICE_ACCOUNT_JSON` を流用（drive.readonly スコープはSheets読取にも有効）。
- 設定: `wrangler.jsonc` の `vars.CHECK_SLACK_CHANNEL_ID` に管理チャンネルIDを入れる
  （空のままでもチェック・起票は動くが、Slack投稿だけされない）。
- 手動テスト:
  `GET https://jdem-stop-mcp.lead1504.workers.dev/check/run?token=<SHARED_SECRET>&dryRun=1&channel=CXXXX`
  （`dryRun=1`=起票・書き戻しなし / `date=YYYY-MM-DD` 対象日指定 / `force=1` チェック済みも再チェック /
  `always=1` 正常時もサマリを投稿＝動作確認・死活監視用）
- 拡張: 新ツールは (1) 実行時に `createRunLog`/`updateRunLog` で記録 (2) `src/check/checkers.ts` の
  `CHECKERS` にチェッカーを1つ追加、の2点で翌朝チェックの対象になる。
