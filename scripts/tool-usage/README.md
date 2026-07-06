# tool-usage — Claude Code ツール使用カウント → Notion

「誰が」「どのツールを」「何回」使ったかを記録し、Notion DB に貯めていく仕組み。

- Notion DB: **Claude Code ツール使用ログ**
  https://www.notion.so/fbbd34c15274476dbf004e15a073d50b
  （ページ「ClaudeCodeで開発まとめ」配下 / DB ID: `fbbd34c1-5274-476d-bf00-4e15a073d50b`）

## 仕組み（フック連携）

```
[ツール実行]
   └─ PostToolUse フック  → logToolUse.mjs
        → ~/.claude/tool-usage/events/<session>.jsonl に1行追記（高速・オフラインOK）
[ターン終了/セッション終了]
   └─ Stop / SessionEnd フック → syncToNotion.mjs
        → セッション集計の「差分」だけ Notion に追記（競合しない追記方式）
[Notion]
   └─ 人別合計 / ツール別合計 / MCPサーバ別 ビューで集計（回数を合計）
```

- 記録するのは **ツール名と回数のみ**（入力内容・コードは保存しない）。
- ローカル記録は常に成功。Notion 未設定でも壊れず、ローカルには貯まり続ける。
- 差分カーソル（`synced/<session>.json`）で二重計上を防止。Stop は既定120秒に間引き、
  SessionEnd は即時同期。

## セットアップ

### 1. このリポジトリで有効化（既定・チーム共有）
`.claude/settings.json` にフックと `TOOL_USAGE_DB_ID` を同梱済み。clone すれば有効
（Web セッションでも有効）。各自が下記の環境変数だけ設定する。

### 2. 各自が設定する環境変数
| 変数 | 必須 | 用途 |
| --- | --- | --- |
| `CLAUDE_USER` | 推奨 | 「誰が」の表示名（例 `山田`）。未設定時は git email → OSユーザー@host に自動フォールバック |
| `NOTION_TOKEN` | 必須 | Notion Internal Integration Token（既存ツールと同じ） |
| `TOOL_USAGE_DB_ID` | 同梱済 | 追記先DB。settings.json で設定済み（変更時のみ上書き） |
| `TOOL_USAGE_DEBOUNCE_MS` | 任意 | Stop同期の間引き（既定 120000ms） |

- Web（Claude Code on the web）: 環境の Environment 変数に `CLAUDE_USER` と `NOTION_TOKEN` を設定。
- ローカル: `~/.zshrc` 等で `export CLAUDE_USER=...` / `export NOTION_TOKEN=...`。

### 3. Notion Integration を DB に接続（重要）
`NOTION_TOKEN` の Integration を、DB「Claude Code ツール使用ログ」に **Connection として接続**
する（Notion UI: DB右上「…」→ Connections → 追加）。未接続だと REST 書き込みが 404 になる。

### 4. 全プロジェクトで数えたい場合（任意）
このリポジトリ以外でも数えるなら、`.claude/settings.json` の `hooks` と `env` を
各自の `~/.claude/settings.json`（ユーザー設定）にコピーする。`$CLAUDE_PROJECT_DIR` は
このリポジトリのパスに置換するか、スクリプトを固定パスに配置して参照する。

## Notion DB スキーマ

| プロパティ | 型 | 内容 |
| --- | --- | --- |
| 名称 | title | `2026-07-06 山田 / Bash ×5` |
| 実行者 | select | ユーザー |
| ツール | select | ツール名（`Bash` / `mcp__Notion__notion-fetch` 等） |
| 分類 | select | `MCP` / `builtin` |
| サーバ | select | MCPサーバ名（builtinは空） |
| 回数 | number | その差分の回数 |
| 日付 | date | 実行日 |
| セッションID | text | セッション識別子 |
| 環境 | select | `web` / `local` |

集計は各ビューで `回数` 列の計算を **Sum** にすると人別/ツール別の合計が出る。

## テスト

```bash
cd scripts/tool-usage
node --test        # 純粋ロジック(ユーザー解決/分類/集計/差分)の検証
```

手元でフックを試す:
```bash
export CLAUDE_TOOL_USAGE_DIR=$(mktemp -d) CLAUDE_USER=テスト
echo '{"session_id":"s1","tool_name":"Bash"}' | node logToolUse.mjs
cat "$CLAUDE_TOOL_USAGE_DIR/events/s1.jsonl"
```

## 無効化

`.claude/settings.json` の `hooks` を削除するか、該当エントリを空配列にする。
ローカルデータは `~/.claude/tool-usage/` を削除。
