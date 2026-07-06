# match-sort（BUG-14 対応モジュール）

マッチング結果を**カット番号順（カット1→N）**で並べるヘルパー。

> 対象ツール: 🎬 1分動画素材選定くん（TOOL-24 / `video-material-matcher`）
> 対象箇所: マッチング結果一覧の**表示ソート**（v1.1 UI）

## なぜ必要か（BUG-14）

v1.1 で「confidence 色分け＋**低信頼度を先頭ソート**」を入れた結果、結果一覧の並びが
*カット順* から *信頼度昇順* に置き換わり、「カット07（赤）が一番上、カット01が下…」の
ように**カット順がバラバラ**になった。山田さんの要望は「カット1から順番に並べてほしい」。

## 何をするか

- `sortMatchesByCut(matches)` … カット番号昇順の**安定ソート**（同番号/不明は元順維持・元配列不変）
- `sortMatches(matches, mode)` … `mode="cut"`（既定＝カット順）/ `mode="review"`（旧v1.1の低信頼度先頭）
- `parseCutNumber(label)` / `cutOrderKey(match)` … "カット03"/"cut 3"/"C07"/数値フィールド等からカット番号を解決

二桁カットでも文字列ソートにならない（`カット2 < カット10`）。

## 組み込み方（video-material-matcher のフロント）

結果を描画する直前のソートを差し替える:

```js
import { sortMatches } from "./match-sort/matchSort.mjs";

// 変更前: results.sort((a,b) => a.confidence - b.confidence)   // 低信頼度先頭
// 変更後(既定): カット順で表示
const view = sortMatches(results, orderMode); // orderMode: "cut"(既定) | "review"
```

`matcher.js` が返す各要素に `cut`（例 "カット03"）か数値 `cutIndex` があれば自動で並ぶ。
どちらも無い場合は `label`/`name` から番号を推定し、不明分は末尾に安定配置する。

## v1.1 の利点を失わない設計（推奨）

低信頼度を先に確認したい狙い（論点C）は、**並び替えではなく強調で担保**する:

- 既定は `mode="cut"`（カット順）で常に表示
- 低信頼度カットは**赤色＋「要確認」バッジ**で目立たせる（色分けは v1.1 で実装済み）
- 画面上部に **[カット順 ⇄ 要確認順]** トグルを置き、必要時だけ `mode="review"` に切替

## テスト

```bash
cd scripts/match-sort
node --test        # 8ケース（番号抽出・安定性・二桁・review切替 等）
```
