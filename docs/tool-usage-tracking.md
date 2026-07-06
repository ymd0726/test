# Claude Code ツール使用カウント（設計メモ）

要望: Claude Code で「誰が」「どのツールを」「何回」使ったかを数え、Notion DB に貯めたい。

## 結論・方式

Claude Code の**フック**＋**Notion DB**で実現。実装は `scripts/tool-usage/`。

- **PostToolUse フック**でツール実行を1件ずつローカル JSONL に高速記録（ネットワーク無し）。
- **Stop / SessionEnd フック**でセッション集計の**差分だけ**を Notion に追記。
- Notion 側は **人別合計 / ツール別合計 / MCPサーバ別** のビューで数える。

Notion DB「Claude Code ツール使用ログ」を作成済み:
https://www.notion.so/fbbd34c15274476dbf004e15a073d50b

## なぜこの設計か

| 論点 | 採用 | 理由 |
| --- | --- | --- |
| 記録の起点 | PostToolUse フック | 全ツール（MCP含む）を漏れなく捕捉できる公式の仕組み |
| 書き込み方式 | ローカル追記→差分同期 | 毎ツールでNotion書き込みすると遅く、レート制限(約3req/s)に当たる。ローカルは即時・オフライン安全 |
| 集計の持ち方 | (実行者×ツール×日付) を追記し、ビューで合計 | 追記のみ＝読み取り→更新の競合が無い。並列セッションでも壊れない |
| 「誰が」 | `CLAUDE_USER` → git email → OSユーザー@host | チームで表記を安定させたい。未設定でも自動フォールバック |
| プライバシー | ツール名と回数のみ | 入力内容・コードは保存しない（機微情報を貯めない） |

### 代替案
- **Google スプレッドシート**（既存GAS資産）でも可。要望通り Notion を採用。将来
  「重い集計・ダッシュボード」が必要ならシート/BigQuery 併用も検討余地あり。
- **即時1行書き込み**方式は実装は単純だが、毎ターン遅延＋レート制限のため非推奨。

## データフロー

```
ツール実行 ─PostToolUse→ logToolUse.mjs ─→ ~/.claude/tool-usage/events/<session>.jsonl
ターン/セッション終了 ─Stop/SessionEnd→ syncToNotion.mjs ─(差分)→ Notion DB へ追記
Notion: 回数をSum集計 → 「誰が何回」「誰がどのツールを何回」
```

## 導入手順（要点 / 詳細は scripts/tool-usage/README.md）

1. clone すれば `.claude/settings.json` のフックで有効（Webセッションも）。
2. 各自 `CLAUDE_USER` と `NOTION_TOKEN` を環境変数に設定。
3. `NOTION_TOKEN` の Integration を DB にコネクション接続（未接続だと404）。
4. 全プロジェクトで数えるなら同設定を各自の `~/.claude/settings.json` にも展開。

## 検証状況

- ✅ 純粋ロジック: `node --test scripts/tool-usage/`（ユーザー解決/ツール分類/集計/差分：10/10）
- ✅ フックE2E（ローカル）: PostToolUse で記録され、NOTION_TOKEN 未設定でも exit 0 で
  グレースフルにスキップ（ローカルには蓄積）を確認
- ✅ Notion DB・3ビュー作成済み
- 🔲 実Notion書き込み: `NOTION_TOKEN` を設定した実環境で 1行反映・差分非重複を確認（要トークン）

## 運用上の注意

- Web セッションのコンテナは揮発するため、`Stop`（毎ターン終了）でも差分同期して取りこぼしを防ぐ。
- `実行者`/`ツール`/`サーバ` の select オプションは初回書き込み時に自動生成される。
- 無効化は `.claude/settings.json` の `hooks` を外すだけ。
