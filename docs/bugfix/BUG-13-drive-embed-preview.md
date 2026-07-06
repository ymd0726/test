# BUG-13 GoogleドライブURLがNotionで一目で分からない

- 報告者: 山田 ／ 報告日: 2026-07-06
- 対象ツール: 🎬 1分動画素材選定くん（TOOL-24 / `ymd0726/video-material-matcher`）
- Notion: https://www.notion.so/39535c2adb56805f93bae1886fc36b8f
- 実装（本リポジトリ）: `scripts/notion-drive-embed/`

## 1. 要望の要旨

> GoogleドライブのURLをNotionに貼り付けた時に、パッと見てその素材が分かりづらい。
> 特に編集しないで埋め込めて、埋め込むと素材が何なのか分かりやすいようにしたい。

「素材選定くん」がマッチング結果をNotionの「素材URL：」calloutに書き戻すが、
**書き戻された内容が生のDrive URL文字列**なので、開くまで中身が分からない。

## 2. 原因の特定

TOOL-24 の書き込み処理（`/api/write` → `notion.js`）は、対象calloutに対して
`PATCH /blocks/{callout_id}` で **`rich_text` を素材の共有URL文字列で上書き**している
（仕様: 「PATCH /blocks/{callout_id} で rich_text のみ上書き」）。

書き込まれる値は Drive の共有URL、例:

```
https://drive.google.com/file/d/1A2b.../view?usp=drivesdk
```

Notionでは、これは **青いリンク文字列**としてしか描画されない。つまり、

- サムネイル（動画の1コマ・画像）が出ない
- ファイル名すら出ない（URLに名前情報が無い）
- インライン再生／表示ができない（クリックしてDriveに飛んで初めて分かる）

**根本原因は「素材を『生URLテキスト』として書いている」こと**。素材の視認性に必要な
サムネイル／ファイル名／インラインプレビューのいずれもURL文字列には含まれない。

## 3. 修正方法

Notionの `embed` ブロックを使い、**Driveの `/preview` エンドポイント**で
動画・画像・PDFをページ内にインライン表示する。あわせてcalloutのリンク文字列を
「生URL」から「ファイル名（リンク付き）」に変えて人間が読めるようにする。

### 3-1. 要点：`/view` ではなく `/preview`

| URL | iframe(=Notion embed)での挙動 |
| --- | --- |
| `.../file/d/<ID>/view` | `X-Frame-Options` で埋め込み拒否される場合がある |
| `.../file/d/<ID>/preview` | **埋め込み専用**。動画プレーヤー／画像／PDFがインライン表示される |

### 3-2. 書き込み後のcalloutの姿（変更前→変更後）

```
変更前:  🎦 素材URL：https://drive.google.com/file/d/1A2b.../view?usp=drivesdk

変更後:  🎬 素材URL：cut03_リード撮影.mp4  〔2510_リード撮影/A〕
         └─[ ▶ 動画がインライン再生されるembedブロック ]
```

「特に編集しないで埋め込め」て、「埋め込むと何の素材か分かる」状態になる。

### 3-3. 実装（本リポジトリに同梱・テスト済み）

`scripts/notion-drive-embed/` にドロップイン実装を用意した。

- `driveEmbed.mjs` … 純粋関数（URL→fileId抽出 / `/preview`URL生成 / ブロック生成）
- `notionWrite.mjs` … `syncMaterialPreview()`（callout更新＋子embed同期・**冪等**）
- `driveEmbed.test.mjs` … `node --test` で10ケース通過

TOOL-24 の `notion.js` の書き込み箇所を次のように置換するだけ:

```js
import { syncMaterialPreview } from "./notion-drive-embed/notionWrite.mjs";

await syncMaterialPreview(NOTION_TOKEN, calloutId, {
  url: file.webViewLink,
  name: file.name,
  mimeType: file.mimeType, // drive.js の fields に mimeType 追加が必要
  folderPath: file.folderPath, // 任意（論点Aの拡張と整合）
  cut: cut.label,              // 任意
});
```

冪等性: 再実行時は前回このツールが入れたDriveの `embed`/`bookmark` 子ブロックを
削除してから追加するため、重複しない。

### 3-4. 運用上の必須条件（共有権限）

`embed`（`/preview`）が**全社員のブラウザ**で表示されるには、素材ファイルが
閲覧者のGoogleアカウントで見られる状態である必要がある。サービスアカウントにしか
共有していないと、プレビュー枠がGoogleログイン壁になる。

→ **CR倉庫フォルダを社内ドメインに「リンクを知っている全員（閲覧者）」で共有**しておく。
これは1回の設定で足りる（TOOL-24が全社員配布を目指す方針＝Notion Embed運用と整合）。

## 4. 改修・改善案

1. **サムネイルの永続化（発展）**
   `/preview` はログイン前提のため、非ログイン閲覧も想定するなら Drive API の
   `thumbnailLink` を取得して `image` ブロックとして貼る手もある。ただし
   `thumbnailLink` は短命・認証付きURLで永続性が弱い。まずは `/preview` embed を推奨、
   要件が出たらサムネイルの定期リフレッシュ運用を検討。

2. **callout構造の維持**
   本修正はcallout本体（`# 📌 参考&編集の指示` 配下、yellow_bg）はそのまま使い、
   子ブロックとしてembedを足す方式。ページ全体・台本部分には触れないため安全。

3. **fallback設計**
   Drive URLとして解釈できない値が来ても壊さず `bookmark` で返す。zip等の
   非プレビュー素材も `bookmark`（カード表示）にフォールバックする。

## 5. アイデア・機能追加への対応策

- **confidenceバッジの併記**: 既にmatcherは信頼度を返す（v1.1の色分け）。embedの
  caption に `カット03 ／ 信頼度62%` のように出せば、Notion上でも要確認素材が一目で分かる。
- **論点Aとの合流**: 素材マッチングに `folderPath`（撮影回・種別）を使う拡張が予定されて
  いる。`folderPath` は本モジュールのcaption/ラベルにもそのまま流用できる（実装済み引数）。
- **一覧ギャラリー化**: 将来、カット×素材を Notion のギャラリービュー等でまとめて
  サムネイル一覧にすると、動画全体の素材を俯瞰しやすい（Phase3向け）。

## 6. 検証状況

- ✅ 純粋ロジック: `node --test scripts/notion-drive-embed/`（10/10 pass）
- 🔲 実Notion E2E: TOOL-24 のテスト用CRDBページで、書き込み後に動画がインライン
  再生されること・再実行で重複しないことを確認（対象リポジトリ側で実施）
