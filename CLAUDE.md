# CLAUDE.md

## 集計表（Google Sheets）を触るとき

- 集計表スプレッドシート自体への修正依頼（セル・数式の修正）が来たら、
  **必ず `.claude/skills/sheet-fix` スキルの手順に従う**（正本仕様の参照 → Actions で実測 →
  パッチプラン承認 → dry-run → apply）。
- 「当たり候補🌱／🌱🌱」の自動判定の導入・横展開・基準変更は
  **`.claude/skills/atari-kouho` スキル**に従う（式の設計・仕様が確定済み。勝手に変えない）。
- 構造仕様の正本は Notion「📊 集計表 構造仕様（全ツール共通リファレンス）」:
  https://app.notion.com/p/39535c2adb568196a433dae934418ea1
  repo 内の `docs/cr-submit/sheet-structure-*.md` は作業ログであり正本ではない。
- セッション環境に Google 認証は無い。読み取りは `inspect-sheet.yml`、書き込みは
  `sheet-fix.yml`（いずれも workflow_dispatch、Secrets の `GOOGLE_SERVICE_ACCOUNT_JSON` を使用）。

## Cloudflare Worker `jdem-stop-mcp` を触るとき（cr入稿くん / cr停止くん 共通）

**この1つのWorkerに cr入稿くん（`/cr-in`）と cr停止くん（`/cr-stop`）の両方が入っている。**
`apps/jdem-stop-mcp/wrangler.jsonc` の name は1つしか無いので、どのブランチからデプロイしても
同じ本番を上書きする。

- **枝はデフォルトブランチ（`claude/context-aggregation-design-a2h570`）から切る。**
  他のツールのブランチから切らない。
- **デプロイはデフォルトブランチから行う。** 機能ブランチを直接 workflow_dispatch しない
  （自分の変更しか入っていないので、もう一方のツールが丸ごと巻き戻る）。
  手順: 機能ブランチで直す → PR → デフォルトへマージ → **デフォルトブランチを選んで
  `deploy-worker.yml` を実行**。

### なぜこのルールがあるか（2026-08-21 の事故）

cr入稿くんとcr停止くんが別ブランチで開発され、機能ブランチから直接デプロイしていたため、
2026-08-15〜08-21 の間、停止くん系のデプロイが **cr入稿くんの修正41件（BUG-49〜BUG-144）を
本番から巻き戻していた**。nrn の `/cr-in` が「コピー元広告が video_data 形式ではありません」
（BUG-55 で削除済みのはずの旧エラー文言）で失敗して発覚した。

### 巻き戻しガード

`deploy-worker.yml` は前回デプロイ成功時の commit を `deployed-worker` タグに記録し、
デプロイ前に祖先判定する。**それを含まない ref のデプロイは「本番から消える commit 一覧」を
表示してジョブが失敗する。** 上のルールを守っていれば発動しない。

- 止まったら＝相手のツールを巻き戻そうとしている。デフォルトブランチをマージしてやり直す。
- 意図的な緊急ロールバックのみ workflow_dispatch 入力 `allowRollback=true` で強制できる。
- 現在の本番 sha は `deployed-worker` タグを見れば分かる（`git ls-remote origin refs/tags/deployed-worker`）。

### GAS は別系統

`gas/submitCreative_common.gs`（入稿）と `gas/stopCreative_common.gs`（停止）は別々の
Apps Script プロジェクトで、**Worker のデプロイでは反映されない**（手動で貼り付けて新バージョン）。
コードを変えたら「GAS再デプロイが必要か」を必ず明示すること。
