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
