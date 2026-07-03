# 🛠️ note集客ネタ企画 セットアップ用プロンプト（コピペ用・1回だけ実行）

`notion-create-database`（プロパティ付きDB新規作成）だけがMCP承認を要するため、
自動セッションでは実行できない（トリガー設定時と同じ制約）。
**このリポジトリ（ymd0726/test）を開いた対話セッション**に下記プロンプトを貼り付けて実行し、
DB作成の許可リクエストが出たら「許可」する。所要は1回・数分。

実行後にできるもの:
- 💡 山田アイデアDB（スキーマ付き）＋ 質問50問（未回答）
- 📝 noteネタDB（スキーマ付き・アイデアDBへのrelation）＋ サンプルネタ50本（候補）

---

```
あなたはリード社の「note集客ネタ企画」のセットアップ担当。以下を順に実行せよ。

【準備】
ToolSearchで Notion ツールを読み込む: notion-create-database / notion-create-pages / notion-fetch / notion-query-data-sources / notion-update-page。
リポジトリの docs/note-salon-questions.md と docs/note-salon-topics.md を読む。

【STEP1 💡山田アイデアDBの作成】
notion-create-database を実行（承認が求められたら許可してもらう）:
- parent: page_id = 39235c2adb5681ca9566dbae7b09d31a（DB置き場db内「💡 山田アイデアDB（note集客ネタ）」行ページ）
- title: 💡 山田アイデアDB（note集客ネタ）
- schema:
CREATE TABLE ("Name" TITLE, "No" NUMBER, "カテゴリ" SELECT('ホットペッパー依存脱却':red, 'Instagram・SNS運用':pink, 'LINE公式・リピート導線':green, 'MEO・Googleマップ':blue, 'Meta広告・リスティング':purple, '口コミ・紹介':orange, 'リピート率・LTV':yellow, '客単価・メニュー設計':brown, 'カウンセリング・成約率':gray, '予約管理・業務効率化':default, '戦略・その他':blue), "ステータス" SELECT('未回答':gray, '回答済':blue, 'ネタ化済':green), "回答日" DATE)
- 返ってきた data source ID（collection://…）を控える。以後 <アイデアDS> と呼ぶ。
※親ページが見つからない等で失敗する場合は、DB保管ページ（page_id=22235c2adb5680dc8468eb186d0c69eb）直下に作成してから notion-move-pages で上記行ページへ移動する。

【STEP2 📝noteネタDBの作成】
notion-create-database を実行:
- parent: page_id = 39235c2adb5681d99d4cfd00d18d998e（DB置き場db内「📝 noteネタDB（エステサロン集客）」行ページ）
- title: 📝 noteネタDB（エステサロン集客）
- schema（<アイデアDS> はSTEP1のdata source IDに置換すること）:
CREATE TABLE ("Name" TITLE, "ペルソナ" SELECT('開業準備〜1年目':blue, '伸び悩み個人サロン':red, '小規模店(スタッフ数名)':green, '多店舗展開期':purple), "カテゴリ" SELECT('ホットペッパー依存脱却':red, 'Instagram・SNS運用':pink, 'LINE公式・リピート導線':green, 'MEO・Googleマップ':blue, 'Meta広告・リスティング':purple, '口コミ・紹介':orange, 'リピート率・LTV':yellow, '客単価・メニュー設計':brown, 'カウンセリング・成約率':gray, '予約管理・業務効率化':default, '戦略・その他':blue), "切り口" SELECT('How-to':blue, '事例':green, 'NG集':red, 'チェックリスト・テンプレ':yellow, 'データ・トレンド':purple, '比較・選び方':orange, 'Q&A':pink, '季節・イベント':brown), "ステータス" SELECT('候補':gray, '山田OK':blue, '企画確定':green, '執筆済':purple, '投稿済':yellow, '見送り':red), "優先度" SELECT('高':red, '中':yellow, '低':gray), "季節性" SELECT('通年':gray, '1月':blue, '2月':blue, '3月':pink, '4月':pink, '5月':green, '6月':green, '7月':orange, '8月':orange, '9月':brown, '10月':brown, '11月':purple, '12月':purple), "元アイデア" RELATION('<アイデアDS>'), "狙い・メモ" RICH_TEXT)
- 返ってきた data source ID を控える。以後 <ネタDS> と呼ぶ。

【STEP3 初期データ投入】
1. docs/note-salon-questions.md の表50行を、notion-create-pages で <アイデアDS> へ登録（50件、1〜2回に分けてよい）。
   properties: Name=質問文 / No=番号 / カテゴリ=表のカテゴリ / ステータス=未回答。回答日は空。
2. docs/note-salon-topics.md の表50行を、notion-create-pages で <ネタDS> へ登録。
   properties: Name=仮タイトル / ペルソナ（①→開業準備〜1年目、②→伸び悩み個人サロン、③→小規模店(スタッフ数名)、④→多店舗展開期）/ カテゴリ / 切り口 / ステータス=候補 / 優先度 / 季節性 / 狙い・メモ=狙い列。

【STEP4 後片付けと検証】
1. 各行ページ本文の案内文「（docs/note-salon-setup-prompt.md の実行時に〜）」を削除する（notion-update-page）。
2. notion-query-data-sources で件数検証: <アイデアDS> のCOUNT=50（全て未回答）、<ネタDS> のCOUNT=50（全て候補）。カテゴリ別件数も出力する。
3. 最後に <アイデアDS>・<ネタDS> のdata source IDとDB URLを一覧出力し、リポジトリの docs/note-salon-topic-plan.md 内の「（セットアップ後に確定）」箇所を実IDへ更新してコミット・プッシュする（ブランチ: claude/note-auto-post-salon-ofbbek）。
```
