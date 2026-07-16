# 🔐 従業員オンボーディング＆認証情報（APIキー）管理ガイド

Claude / Claude Code・MCP・各種コネクタを従業員と安全に共有するための運用ルール。
「従業員が各自でAPIキーを発行・共有する」手間とリスクを無くし、退職・担当交代に強い状態を保つのが目的。

## 0. 基本方針（これだけ守れば大丈夫）

> **鍵は配らない。コネクタ（接続URL）を配る。鍵はサーバー側の1か所だけに置く。**

- 生のAPIキー／トークンを人に渡したり、チャットに貼ったりしない。
- 従業員には「接続URL」または「各自のアカウントで接続してもらう」だけ。
- よくある誤解 ⚠️：「GitHubリポジトリを共有すればキー発行の手間が省ける」——**省けません**。
  そもそもリポジトリに鍵は入っていません（＝正しい設計）。鍵の共有と、コードの共有は別物です。
  **キー発行の手間は「鍵を配る」ことではなく「接続URLを配る」ことで無くします。** 御社は既にその形です。

---

## 1. 接続の3系統マップ（混同しやすいので最初にこれ）

| | 系統 | 実体 | 認証のしかた | 誰が持つか | 従業員に渡すもの |
|---|---|---|---|---|---|
| ① | 公式コネクタ | claude.ai のマネージド接続<br>（Meta広告 / Notion / Slack / Google Drive・Calendar / Gmail など） | **各自が自分のアカウントでOAuthログイン** | 従業員 各自 | **なし**（各自で接続。鍵は渡さない） |
| ② | 自作MCP `jdem-stop-mcp` | 自社の Cloudflare Worker（`apps/jdem-stop-mcp/`） | 接続URLの先頭に入る `SHARED_SECRET` | 会社（共有） | **接続URLのみ**（＝パスワード扱い） |
| ③ | 自動実行用トークン | ②のWorkerに保管したシークレット群 | サーバー側に保管（外に出ない） | 会社（Cloudflareの中） | **なし**（誰にも配らない） |

- **①公式コネクタ**：Meta広告データの参照・分析、Notion/Slack/Google操作など。
  従業員が「自分でMeta広告MCPをセットアップ」するのは基本これ。**自作は不要**、設定から追加するだけ。
  各自のアカウントで繋ぐので、その人が持つMetaやNotionの権限がそのまま効く（＝最小権限・個別失効が可能）。
- **②自作MCP**：`stop_creative`（停止）/ `undo_creative`（取消）/ cr入稿くん など、御社固有の業務フロー。
  **もう出来上がっており作り直し不要。** 使わせたい相手に接続URLを渡すだけ（手順は §4）。
- **③自動実行トークン**：毎朝のルーチンやcronがMeta/Notion/Google/Slackを叩くための鍵。
  Cloudflareの中にだけ存在し、人には一切渡らない。

---

## 2. 配ってよいもの / 絶対に配らないもの

**配ってよい**
- ②自作MCPの接続URL（信頼できる社内メンバー限定。実質パスワードなので取り扱い注意）。
- GitHubリポジトリの閲覧／デプロイ権限（鍵は入っていないので、コードを見せても鍵は漏れない）。

**絶対に配らない・チャットに貼らない**
- 生のAPIキー／トークン：Meta アクセストークン、Notion トークン、Google サービスアカウントJSON、Slack Bot Token など。
- `SHARED_SECRET` 単体（URLの一部として以外に渡す必要はない）。
- Cloudflare / GitHub / Render など**秘密ストアの中身**そのもの。

「従業員にAPIキーをどんどん発行させる」必要はありません。①は各自が自分のアカウントで繋ぎ、②はURLを配るだけ。
**鍵の実体を増やす／配る運用は、むしろ管理不能とリスクを増やします。**

---

## 3. 主要シークレット一覧（名前と保管場所だけ。値は絶対に書かない）

> このドキュメントには**値を書きません**。値は各基盤の秘密ストアにだけ存在します。

**Cloudflare Worker secrets**（`apps/jdem-stop-mcp/src/index.ts` の `Env` より。`wrangler secret put <名前>` で登録）
| 名前 | 用途 |
|---|---|
| `SHARED_SECRET` | 接続URL先頭の合言葉。②の入口＆内部署名に使用 |
| `META_ACCESS_TOKEN` | 既定のMetaトークン（株式会社リードBM / ads_management） |
| `META_TOKEN_LOCAL` | 別BM（Local Infomation BM：grm / fpl 案件）用トークン |
| `NOTION_TOKEN` | Notion実行ログ／予算波及／翌朝チェック用の内部インテグレーション |
| `GOOGLE_SERVICE_ACCOUNT_JSON` | Drive/Sheets 読み取り用サービスアカウント（`ads-reader@...`） |
| `SLACK_BOT_TOKEN` / `SLACK_SIGNING_SECRET` | Slack投稿・スラッシュコマンド検証 |
| `BUDGET_TOKEN` | 予算確定→波及くん のリンク用共有シークレット |
| `GAS_WEBAPP_URL` | GAS Web App の `/exec` URL（README参照） |

※ `Env` は `[key: string]: any` を許可しており、案件別トークンを `metaTokenSecret` に書いた**シークレット名**で動的参照する（例：grm/fpl は `META_TOKEN_LOCAL`）。新BMの案件を足すときは、この命名規則でsecretを追加する。

**GitHub Actions secret**
| 名前 | 用途 |
|---|---|
| `CLOUDFLARE_API_TOKEN` | `.github/workflows/deploy-worker.yml` からWorkerをデプロイするため |

**claude.ai コネクタ（ルーチン＝自動実行が使用）**
- Notion / Slack / Google。ルーチン編集画面でどのコネクタが紐づいているかを管理（`docs/operations-runbook.md` §2・§3 参照）。

---

## 4. オンボーディング チェックリスト（新メンバーが入るとき）

- [ ] **公式コネクタ（①）は各自のアカウントで接続してもらう。** 生の鍵は渡さない。
  - Meta広告：本人のMetaアカウントで接続 → 本人のMeta権限の範囲だけ操作できる（最小権限）。
  - Notion / Slack / Google：同様に各自で接続。
- [ ] **自作MCP（②）を使わせる場合のみ、接続URLを1対1で共有**（社内チャットの公開チャンネルに貼らない）。
  1. claude.ai → **Settings → Connectors → Add custom connector（「+」）**
  2. 名前：`jdem 停止` など
  3. URL：`https://jdem-stop-mcp.<サブドメイン>.workers.dev/<SHARED_SECRET>/sse`
  4. 保存すると `stop_creative` / `undo_creative` などが見える（Webで設定すればモバイル/デスクトップに自動同期）。
  - 詳細・トラブルシュートは `apps/jdem-stop-mcp/README.md`。
- [ ] 「生のAPIキーは受け取らない・発行しない・チャットに貼らない」を本人に周知。
- [ ] 誰にどの接続を渡したかを記録（下の管理表を1行追記）。

---

## 5. オフボーディング チェックリスト（退職・担当交代・URL流出のとき）

- [ ] **②の接続URLを無効化**：`SHARED_SECRET` を再設定する。
  ```bash
  cd apps/jdem-stop-mcp
  npx wrangler secret put SHARED_SECRET   # 新しい長いランダム値を入力
  ```
  → 旧URLは即401で無効。**現役メンバー全員へ新URLを配り直す**（§4の手順）。
- [ ] 本人が**各自のアカウントで接続していた公式コネクタ（①）を失効**（本人退職でアカウントごと失効するのが基本だが、共有していないか確認）。
- [ ] 本人の個人トークンで動いていた箇所があれば**別トークンに付け替え**（→ §7 の恒久対策も検討）。
- [ ] **Cloudflare / GitHub の共有アカウント・組織メンバーから外す。**

---

## 6. ローテーション（定期的な鍵の入れ替え）方針

| 対象 | いつ回すか | 方法 |
|---|---|---|
| `SHARED_SECRET` | 定期（例：四半期）＋ 退職・流出時 | `wrangler secret put SHARED_SECRET` → 全員へURL再配布 |
| Metaトークン | 有効期限前・担当交代時 | 個人トークンではなく**BMのシステムユーザートークン**推奨（§7） |
| `NOTION_TOKEN` ほか | 流出疑い時・定期 | 各サービスで再発行 → `wrangler secret put` で差し替え |

---

## 7. 恒久的にラクにする改善（推奨・別タスク候補）

- **属人化の解消**：Cloudflare / GitHub は個人アカウントではなく**会社の共有アカウント／組織**で持つ。担当が辞めても止まらない。
- **Metaは「システムユーザートークン」へ**：個人アカウント紐づきのトークンをやめ、ビジネスマネージャーのシステムユーザー（長期・人に紐づかない）トークンに移行すると、担当交代でトークンが切れない。
- **`.gitignore` の整備**：現在リポジトリ直下に `.gitignore` が無い。ローカル開発で `.dev.vars` / `.env` を使う場合は、**必ず** `.gitignore` に追加して**コミットしない**（Cloudflareの秘密は `wrangler secret`、GitHubの秘密は Actions secrets にだけ置く）。

---

## 8. 誰に何を渡したか（管理表：適宜追記）

| 日付 | 対象者 | 渡したもの | 備考 |
|---|---|---|---|
| YYYY-MM-DD | （例）山田 | jdem停止 接続URL / Meta広告コネクタは本人接続 | |

---

## 付録A. シークレット再発行の"実"手順（つまずき対策込み）

`SHARED_SECRET` を作り直すとき（定期ローテーション・退職・URL流出時）の、実際にやると詰まりやすいポイントをまとめた手順。初めてでも迷わないように。

### 事前準備（ここでよく詰まる）

- **作業フォルダは Google Drive 同期の外に置く。** Google Drive（`~/Library/CloudStorage/GoogleDrive-.../`）配下だと `node_modules` の実行ファイル（シンボリックリンク）が壊れ、`sh: wrangler: command not found` になる。`~/Downloads` や専用の作業フォルダなど**同期外**で作業する。
- **Node.js は v22 以上が必要**（Wranglerの要件）。確認：`node -v`。古ければ https://nodejs.org の **LTS** インストーラー（`.pkg`）を入れて**ターミナルを開き直す**。
- **ターミナルへの貼り付けは1行ずつ**。複数行を一気に貼ると勝手に実行されて出力が混ざる。
- パスに**スペースや日本語**が含まれる場合は `cd ~/"フォル ダ名"` のように**ダブルクォートで囲む**。

### 手順

1. **新しい値を先に作り、パスワード管理ツールに保存する**（← 今回の最大の教訓。Cloudflareは後から値を見られない）。
   ```bash
   openssl rand -hex 16     # 出た値を 1Password/Bitwarden に「Cloudflare SHARED_SECRET (jdem-stop-mcp)」で保存
   ```
2. **`wrangler.jsonc` があるフォルダへ移動**（同期外のコピー）。
   ```bash
   cd <jdem-stop-mcp のフォルダ>
   ls                        # wrangler.jsonc と src が見えればOK
   ```
3. **`wrangler: command not found` が出たら node_modules を作り直す**。
   ```bash
   rm -rf node_modules
   npm install               # 数分。added XXX packages が出れば完了
   ```
4. **Cloudflareにログイン**（初回/期限切れ時のみ）。
   ```bash
   npx wrangler login        # ブラウザで承認 → "Successfully logged in."
   ```
5. **シークレット登録**（値はコマンドに書かず、隠しプロンプトで貼る）。
   ```bash
   npx wrangler secret put SHARED_SECRET
   # Enter a secret value: ← ここで手順1の値を貼り付け（画面には出ない）
   ```
   → `✨ Success! Uploaded secret SHARED_SECRET` が出れば完了。**この瞬間から旧URLは無効。**
6. **新しいURLを組み立てる**。
   ```
   https://jdem-stop-mcp.lead1504.workers.dev/<手順1の値>/sse
   ```
   （サブドメインが不明なら Cloudflareダッシュボード → Workers & Pages → `jdem-stop-mcp` で確認）
7. **各自のコネクタを差し替える**：claude.ai → Settings → Connectors → 対象コネクタのURLを新URLに変更（編集不可なら削除して Add custom connector で再追加）。
8. **動作確認**：Claudeに「list projects で案件一覧を見せて」→ 承認ダイアログを許可 → 案件一覧が返ればOK。
9. **古いコネクタを削除**（旧URLは無効なので残すと紛らわしいだけ）。

### やりがちな失敗と対処

| 症状 | 原因 / 対処 |
|---|---|
| `wrangler requires at least Node.js v22` | Nodeが古い。LTSインストーラーで更新→ターミナル開き直し |
| `sh: wrangler: command not found` | Google Drive同期でnode_modules破損。同期外フォルダで `rm -rf node_modules && npm install` |
| `Required Worker name missing` | `wrangler.jsonc` の無い場所で実行している。正しいフォルダへ `cd` |
| 値を控え忘れた | Cloudflareからは読めない。再度この手順で作り直す（＝今回の発端） |

> ⏰ 切り替えは**静かな時間帯**に（cr入稿くん実行中や毎朝7:30の自動チェック直前を避ける）。

---

### 関連ドキュメント
- `apps/jdem-stop-mcp/README.md` — 自作MCPのセットアップ・接続・`SHARED_SECRET` 再設定・他案件展開（案A/案B）
- `docs/operations-runbook.md` — ルーチン／コネクタの障害一次対応
- `docs/trigger-configs.md` — 各ルーチンの設定
