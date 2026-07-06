// BUG-13 対応: Notion「素材URL：」callout を、リンク文字列＋インラインプレビューに更新する
// オーケストレーション。video-material-matcher の notion.js(/api/write)へのドロップイン参照実装。
//
// 既存挙動:
//   PATCH /blocks/{callout_id}  で rich_text を "生URL" に上書きするだけ。
// 変更後の挙動(冪等):
//   1. callout の rich_text を「素材URL：<ファイル名>(リンク)」に更新
//   2. callout 直下に前回このツールが入れた embed/bookmark 子ブロックがあれば削除
//   3. 新しい embed(/preview) または bookmark 子ブロックを追加
//
// これにより「特に編集しないで埋め込め、埋め込むと何の素材か分かる」状態になる。

import { buildMaterialBlocks, materialRichText, parseDriveFileId, kindEmoji } from "./driveEmbed.mjs";

const NOTION = "https://api.notion.com/v1";
const NOTION_VERSION = "2022-06-28";

async function notionApi(token, path, method, body) {
  const res = await fetch(`${NOTION}/${path}`, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      "notion-version": NOTION_VERSION,
      "content-type": "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json();
  if (!res.ok) throw new Error(`Notion API失敗 (${method} ${path}): ${data.message || res.status}`);
  return data;
}

/** callout 直下の子ブロックのうち、Driveの embed/bookmark を返す(前回投入分の掃除用) */
async function listDriveChildBlocks(token, calloutId) {
  const out = [];
  let cursor = "";
  do {
    const q = cursor ? `?start_cursor=${cursor}&page_size=100` : "?page_size=100";
    const res = await notionApi(token, `blocks/${calloutId}/children${q}`, "GET");
    for (const b of res.results || []) {
      const isEmbed = b.type === "embed" && /drive\.google\.com|docs\.google\.com/.test(b.embed?.url || "");
      const isBookmark = b.type === "bookmark" && /drive\.google\.com|docs\.google\.com/.test(b.bookmark?.url || "");
      if (isEmbed || isBookmark) out.push(b.id);
    }
    cursor = res.has_more ? res.next_cursor : "";
  } while (cursor);
  return out;
}

/**
 * 1つの callout に対して素材プレビューを同期する(冪等)。
 * @param {string} token       Notion Internal Integration Token
 * @param {string} calloutId   「素材URL：」callout のブロックID
 * @param {{url:string, name?:string, mimeType?:string, folderPath?:string, cut?:string}} material
 * @returns {Promise<{fileId:string|null, previewUrl:string|null, action:string}>}
 */
export async function syncMaterialPreview(token, calloutId, material) {
  const fileId = parseDriveFileId(material.url);
  const viewUrl = fileId
    ? `https://drive.google.com/file/d/${fileId}/view`
    : material.url;

  // 1. callout 本体を「ファイル名リンク」に更新(アイコンも素材種別に)
  await notionApi(token, `blocks/${calloutId}`, "PATCH", {
    callout: {
      rich_text: materialRichText({ name: material.name, viewUrl, folderPath: material.folderPath }),
      icon: { type: "emoji", emoji: kindEmoji(material.mimeType) },
    },
  });

  // 2. 前回このツールが入れた Drive 子ブロックを削除(再実行時の重複防止)
  const stale = await listDriveChildBlocks(token, calloutId);
  for (const id of stale) {
    await notionApi(token, `blocks/${id}`, "DELETE");
  }

  // 3. 新しいプレビューブロックを追加
  const { blocks, previewUrl } = buildMaterialBlocks(material);
  if (blocks.length) {
    await notionApi(token, `blocks/${calloutId}/children`, "PATCH", { children: blocks });
  }

  return { fileId, previewUrl, action: stale.length ? "replaced" : "created" };
}
