# 🎮 当たりCRシューター — 導入手順書

社内ツール(素材選定くん・自動命名くん)のページに埋め込めるミニシューティングゲームです。

- **スコアの重み付けは「当たりCR判定基準グランドルール」の評価点に連動**
  - 🐣 小当たりCR(消化5〜29%・評価点1〜2)= 100・200点
  - 🎉 当たりCR(消化30%以上・評価点3〜5)= 300〜500点
  - 👑 当たりCRの型(評価点9)= 900点
  - 💸 危険CR = CPA停止ルールのミラー。消化判定ライン(目標CPA×2)→🟡許容CPAライン(+10%)→🔴即停止ライン(+20%)と悪化。🟡のうちに撃破すると**停止判断ボーナス**、🔴放置は減点+被弾
- **WAVEが進むほど当たりCRの出現率と倍率がUP(最大×3)**、連続撃破コンボで最大×2
- スコアは**ニックネーム付きでNotionのスコアDBに保存**され、ゲーム内にチームランキング(全期間/今週)を表示
- サーバーに繋がらない環境では自動でローカル保存(localStorage)にフォールバック

## 1. ファイル構成(コピー元 → コピー先)

`video-material-matcher` リポジトリに以下の2ファイルをコピーするだけです。

| このリポジトリ(ymd0726/test) | video-material-matcher のコピー先 |
|---|---|
| `game/server/routes/game.cjs` | `server/routes/game.cjs` |
| `game/server/public/game.html` | `server/public/game.html` (publicフォルダが無ければ作成) |
| `game/scripts/create-score-db.mjs` | どこでもOK(DB作成に1回使うだけ) |

コピー後、いつも通り GitHub Desktop でコミット & main に push すれば Render が自動デプロイします。

> ⚠️ `game.cjs` は拡張子が `.cjs` です。サーバー本体が CommonJS でも ESM でも動くようにしてあるので、`.js` にリネームしないでください。

## 2. server/app.js に2行追記

**CommonJS の場合**(`require(...)` が並んでいる場合):

```js
// 既存の naming ルートのマウントの近くに追加
app.use(require('./routes/game.cjs'));
```

**ESM の場合**(`import ... from ...` が並んでいる場合):

```js
import gameRouter from './routes/game.cjs'; // ファイル先頭のimport群に追加
app.use(gameRouter);                        // 既存ルートのマウントの近くに追加
```

> 🚨 **重要**: SPA用の catch-all(`app.get('*', ...)` や `app.use(express.static(...))` の後の全件フォールバック)より**前**に書いてください。後ろに書くと `/game` がReact側に吸われて404/白画面になります。迷ったら「既存の `app.use(...naming...)` のすぐ隣」が安全です。

## 3. スコアDB(Notion)の作成 — 1回だけ

### 方法A: 同梱スクリプトで作成(おすすめ)

ローカルの video-material-matcher リポジトリで:

```bash
NOTION_TOKEN=ntn_xxx node game/scripts/create-score-db.mjs "<親ページのURL>"
```

- `NOTION_TOKEN` は `.env` にある既存のものを使用
- 親ページは**インテグレーションがコネクトされているページ**を指定(例: 「ClaudeCodeで開発まとめ」ページのURL)
- 成功すると `GAME_SCORES_DB_ID=xxxx` と表示されるのでコピー

### 方法B: Notion上で手動作成

新規データベースを作り、プロパティ名を**完全一致**で設定:

| プロパティ名 | 種類 |
|---|---|
| ニックネーム | タイトル |
| スコア | 数値 |
| ウェーブ | 数値 |
| 当たり数 | 数値 |
| 小当たり数 | 数値 |
| 型数 | 数値 |
| 停止ボーナス | 数値 |
| 日付 | 日付 |
| ツール | セレクト(素材選定くん / 自動命名くん / その他) |

作成後、DBページの「…」→「コネクト」で既存インテグレーション(NOTION_TOKENのもの)を追加し、DBのURLから32桁のIDを控える。

> DBには「スコア降順」のビューを1つ作っておくと、Notion上がそのままチームランキング表になります📊

## 4. 環境変数の追加

**Render**(Dashboard → video-material-matcher → Environment):

```
GAME_SCORES_DB_ID=<手順3で取得したID>
```

**ローカル** `.env` にも同じ行を追加(ローカル動作確認用)。

- `NOTION_TOKEN` は既存のものを流用(追加作業なし)
- `SLACK_WEBHOOK_URL` が設定済みなら、**トップ3更新時に自動でSlack通知**が飛びます(未設定ならスキップ、任意)

## 5. 動作確認

1. ローカル: `npm start` → http://localhost:3000/game を開く
   - 画面上部に「📴 オフラインモード」が**出ていなければ** Notion 接続OK
   - 1プレイしてスコア保存 → NotionのスコアDBに行が増えることを確認
2. 本番: main に push → https://video-material-matcher.onrender.com/game
   - Freeプランはスリープ後の初回アクセスに30〜50秒かかります(ゲーム側に「起動中…」表示あり)

## 6. Notion / ツールページへの埋め込み

- **Notion埋め込み**: 既存ツールと同じく `/embed` → `https://video-material-matcher.onrender.com/game` を貼る。Basic認証は既存ツール同様ブラウザのプロンプトで入力
- **どのツールから遊ばれたか記録したい場合**はURLパラメータを付ける:
  - 素材選定くんのページ: `.../game?tool=matcher`
  - 自動命名くんのページ: `.../game?tool=naming`
- **Reactクライアントにリンクを置きたい場合**(任意)、ヘッダー等に:

```jsx
<a href="/game" target="_blank" rel="noreferrer" title="当たりCRシューター">🎮</a>
```

## 7. トラブルシュート

| 症状 | 原因と対処 |
|---|---|
| `/game` が404 or Reactの画面になる | app.jsのマウント位置がcatch-allより後ろ → 手順2の警告参照 |
| ゲームは動くが「📴 オフラインモード」が出る | `GAME_SCORES_DB_ID` 未設定、またはRenderに反映前 → 手順4 |
| スコア保存で `notion_error` | インテグレーションがスコアDBに**コネクトされていない** → 手順3 |
| 保存時に429 | スパム対策(1人あたり10分に5回まで)。少し待つ |
| ランキングが1分古い | 仕様(Notionレート制限対策で60秒キャッシュ) |

## 8. 今後のアイデア(未実装・v2候補)

- **月間シーズン制**: 月初にランキングをリセットし、月間MVPを表彰(日付プロパティで集計するだけなので実装は軽い)
- **デイリーボーナス**: その日の初プレイはスコア×1.2
- **実績バッジ**: 「型ハンター(👑を累計10体)」「停止職人(停止ボーナス累計20回)」などをNotion DBから集計
- **ツール連携ボーナス**: 素材選定くんでマッチング実行した日はゲーム内で当たり出現率+5%(APIに1フラグ追加)
- **社内トーナメント**: 週次ランキング上位でSlackに自動で組み合わせ発表

---
*スコアAPI仕様: `GET /api/game/scores?limit=10&period=all|week` / `POST /api/game/scores {nickname, score, wave, atari, koatari, kata, stopBonus, tool}` — 詳細は `server/routes/game.cjs` のコメント参照*
