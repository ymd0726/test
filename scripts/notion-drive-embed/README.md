# notion-drive-embed（BUG-13 対応モジュール）

GoogleドライブのURLをNotionに書き込む際、**生URL文字列**ではなく
**インラインプレビュー（動画再生／画像表示）＋ファイル名リンク**に変換するヘルパー。

> 対象ツール: 🎬 1分動画素材選定くん（TOOL-24 / `video-material-matcher`）
> 対象箇所: `/api/write`（Notionの「素材URL：」calloutへの書き込み）

## なぜ必要か（BUG-13）

現状は Drive の共有URL（`https://drive.google.com/file/d/XXXX/view?usp=drivesdk`）を
calloutの `rich_text` にそのまま上書きしている。生URLは青いリンク文字列でしかなく、
**サムネイルもファイル名も出ないため「パッと見て何の素材か分からない」**。

## 何をするか

`syncMaterialPreview()` を1回呼ぶと、対象calloutに対して冪等に次を行う:

1. callout本体を `素材URL：<ファイル名>（リンク）` に更新（アイコンも素材種別絵文字に）
2. 前回このツールが入れた Drive の `embed`/`bookmark` 子ブロックを削除（再実行時の重複防止）
3. `embed`（`/preview`）子ブロックを追加 → **Notion内で動画がインライン再生／画像が表示される**
   - 動画・画像・PDF・Google Docs系 → `embed`（インラインプレビュー）
   - それ以外（zip等） → `bookmark`（カード表示）

要点は **`/view` ではなく `/preview` URL を embed に使う**こと。
`/view` は `X-Frame-Options` により iframe 埋め込みが拒否される場合があるが、
`/preview` は埋め込み専用エンドポイントのため確実にインライン表示される。

## 組み込み方（video-material-matcher の notion.js）

```js
import { syncMaterialPreview } from "./notion-drive-embed/notionWrite.mjs";

// 従来: PATCH /blocks/{callout_id} で rich_text に生URLを上書きしていた箇所を置換
await syncMaterialPreview(NOTION_TOKEN, calloutId, {
  url: file.webViewLink,   // または file.id
  name: file.name,         // 例: cut03_リード撮影.mp4
  mimeType: file.mimeType, // 例: video/mp4（drive.js の fields に mimeType を追加）
  folderPath: file.folderPath, // v2で追加予定の親フォルダ名（任意）
  cut: cut.label,          // 例: カット03（任意・captionに出す）
});
```

`drive.js` の Files.list `fields` に `mimeType` を含めておくこと
（`files(id,name,mimeType,webViewLink,...)`）。`folderPath` はBUG別要望（論点A）で
追加予定の項目で、無くても動作する。

## 前提・運用上の注意（重要）

- **共有権限**: `embed`（`/preview`）が全社員のブラウザで表示されるには、素材ファイルが
  **閲覧者のGoogleアカウントで見られる状態**である必要がある。
  サービスアカウントにしか共有されていないファイルはプレビューがログイン壁になる。
  → CR倉庫フォルダを社内ドメインに「リンクを知っている全員（閲覧者）」で共有しておく。
- Notion側は追加設定不要。`embed` ブロックはInternal Integration Tokenで作成できる。

## テスト

```bash
cd scripts/notion-drive-embed
node --test        # 純粋関数(parse/preview URL/ブロック生成)の検証
```

`notionWrite.mjs` は実Notionへの書き込みを行うため、E2Eは対象ツール側の
テスト用CRDBページで確認すること。
