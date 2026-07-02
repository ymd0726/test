#!/usr/bin/env node
// 🎮 当たりCRシューター用のスコアDBをNotionに作成するワンタイムスクリプト。
//
// 使い方(video-material-matcher のリポジトリ内などで):
//   NOTION_TOKEN=ntn_xxx node game/scripts/create-score-db.mjs "<親ページのURLまたはID>"
//
// 親ページは NOTION_TOKEN のインテグレーションがアクセスできるページを指定すること。
// 成功すると GAME_SCORES_DB_ID に設定すべきIDが表示される。
//
// 依存なし(Node 18+ の global fetch のみ)。

const NOTION_API = 'https://api.notion.com/v1';
const NOTION_VERSION = '2022-06-28';

const token = process.env.NOTION_TOKEN;
const parentArg = process.argv[2];

if (!token || !parentArg) {
  console.error('使い方: NOTION_TOKEN=ntn_xxx node create-score-db.mjs "<親ページのURLまたはID>"');
  process.exit(1);
}

// NotionページURL(末尾32桁hex)またはID文字列からIDを取り出す
function extractPageId(input) {
  const hex = String(input).replace(/-/g, '').match(/[0-9a-f]{32}(?![0-9a-f])/gi);
  if (!hex) {
    console.error(`ページIDを認識できません: ${input}`);
    process.exit(1);
  }
  const raw = hex[hex.length - 1];
  return `${raw.slice(0, 8)}-${raw.slice(8, 12)}-${raw.slice(12, 16)}-${raw.slice(16, 20)}-${raw.slice(20)}`;
}

const parentId = extractPageId(parentArg);

const res = await fetch(`${NOTION_API}/databases`, {
  method: 'POST',
  headers: {
    Authorization: `Bearer ${token}`,
    'Notion-Version': NOTION_VERSION,
    'Content-Type': 'application/json',
  },
  body: JSON.stringify({
    parent: { type: 'page_id', page_id: parentId },
    icon: { type: 'emoji', emoji: '🎮' },
    title: [{ type: 'text', text: { content: '🎮 当たりCRシューター スコアDB' } }],
    properties: {
      'ニックネーム': { title: {} },
      'スコア': { number: { format: 'number' } },
      'ウェーブ': { number: { format: 'number' } },
      '当たり数': { number: { format: 'number' } },
      '小当たり数': { number: { format: 'number' } },
      '型数': { number: { format: 'number' } },
      '停止ボーナス': { number: { format: 'number' } },
      '日付': { date: {} },
      'ツール': {
        select: {
          options: [
            { name: '素材選定くん', color: 'blue' },
            { name: '自動命名くん', color: 'green' },
            { name: 'その他', color: 'gray' },
          ],
        },
      },
    },
  }),
});

if (!res.ok) {
  console.error(`作成失敗 (HTTP ${res.status}):`);
  console.error(await res.text());
  console.error('\nヒント: 404の場合、親ページにインテグレーションが「コネクト」されていない可能性があります。');
  process.exit(1);
}

const db = await res.json();
console.log('✅ スコアDBを作成しました!');
console.log(`   DB URL : ${db.url}`);
console.log(`   DB ID  : ${db.id}`);
console.log('\n次のステップ:');
console.log(`   1. Render > Environment に GAME_SCORES_DB_ID=${db.id} を追加`);
console.log('   2. ローカルの .env にも同じ行を追加(ローカル動作確認用)');
console.log('   3. サーバー再起動後、 /game でスコア保存が有効になります');
