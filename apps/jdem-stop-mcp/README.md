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
MCPエンドポイントは `/<SHARED_SECRET>/sse`（SSE）と `/<SHARED_SECRET>/mcp`（Streamable HTTP）。
シークレット無し/誤りは 401 になることだけ先に確認できる:
```bash
curl -s -o /dev/null -w "%{http_code}\n" https://jdem-stop-mcp.<sub>.workers.dev/wrong/sse   # → 401
```

---

## claude.ai への接続（Web側で設定 → モバイルへ自動同期）

1. claude.ai → **Settings → Connectors → Add custom connector（「+」）**
2. 名前: `jdem 停止` など
3. URL: 下記を入力（`<...>` を自分の値に置換）
   ```
   https://jdem-stop-mcp.<あなたのサブドメイン>.workers.dev/<SHARED_SECRET>/sse
   ```
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
| Claude接続時に 401 | URLの `<SHARED_SECRET>` が `wrangler secret` の値と不一致 |
| ツール実行で `JSON以外が返りました` | GASデプロイの「アクセスできるユーザー」が **全員** でない。要再設定 |
| `クリエイティブが見つかりません` | creativeName または対象タブの不一致（GAS側 CONFIG.SHEET_NAME を確認） |
| ログ確認 | `npx wrangler tail` でリアルタイムログ |
