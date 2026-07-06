// 純粋関数の検証(node:test)。ネットワーク不要。
// 実行: node --test scripts/notion-drive-embed/
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  parseDriveFileId,
  drivePreviewUrl,
  driveViewUrl,
  isPreviewable,
  kindEmoji,
  materialRichText,
  buildMaterialBlocks,
} from "./driveEmbed.mjs";

test("parseDriveFileId: 各種URL形からIDを抽出", () => {
  const id = "1A2b3C4d5E6f7G8h9I0jKLMNOPqrstuv";
  assert.equal(parseDriveFileId(`https://drive.google.com/file/d/${id}/view?usp=drivesdk`), id);
  assert.equal(parseDriveFileId(`https://drive.google.com/file/d/${id}/preview`), id);
  assert.equal(parseDriveFileId(`https://drive.google.com/open?id=${id}`), id);
  assert.equal(parseDriveFileId(`https://drive.google.com/uc?id=${id}&export=download`), id);
  assert.equal(parseDriveFileId(`https://docs.google.com/document/d/${id}/edit`), id);
  assert.equal(parseDriveFileId(id), id);
});

test("parseDriveFileId: 不正入力は null", () => {
  assert.equal(parseDriveFileId(""), null);
  assert.equal(parseDriveFileId(null), null);
  assert.equal(parseDriveFileId("https://example.com/not-a-drive-link"), null);
  assert.equal(parseDriveFileId("short"), null);
});

test("drivePreviewUrl は /view でなく /preview を使う", () => {
  const id = "1A2b3C4d5E6f7G8h9I0jKLMNOPqrstuv";
  assert.equal(drivePreviewUrl(id), `https://drive.google.com/file/d/${id}/preview`);
  assert.equal(drivePreviewUrl(id, "video/mp4"), `https://drive.google.com/file/d/${id}/preview`);
  assert.equal(
    drivePreviewUrl(id, "application/vnd.google-apps.document"),
    `https://docs.google.com/document/d/${id}/preview`
  );
});

test("driveViewUrl は人間閲覧用リンク", () => {
  const id = "1A2b3C4d5E6f7G8h9I0jKLMNOPqrstuv";
  assert.equal(driveViewUrl(id), `https://drive.google.com/file/d/${id}/view`);
  assert.equal(
    driveViewUrl(id, "application/vnd.google-apps.spreadsheet"),
    `https://docs.google.com/spreadsheets/d/${id}/edit`
  );
});

test("isPreviewable: 動画/画像/PDF/Docs系は true", () => {
  assert.equal(isPreviewable("video/mp4"), true);
  assert.equal(isPreviewable("image/png"), true);
  assert.equal(isPreviewable("application/pdf"), true);
  assert.equal(isPreviewable("application/vnd.google-apps.presentation"), true);
  assert.equal(isPreviewable("application/zip"), false);
  assert.equal(isPreviewable(undefined), true); // 素材=動画前提で試行
});

test("kindEmoji: 種別ごとの絵文字", () => {
  assert.equal(kindEmoji("video/mp4"), "🎬");
  assert.equal(kindEmoji("image/jpeg"), "🖼️");
  assert.equal(kindEmoji("application/pdf"), "📄");
  assert.equal(kindEmoji("application/zip"), "📎");
});

test("materialRichText: 生URLでなくファイル名リンクになる", () => {
  const rt = materialRichText({
    name: "cut03_リード撮影.mp4",
    viewUrl: "https://drive.google.com/file/d/ID/view",
    folderPath: "2510_リード撮影/A",
  });
  assert.equal(rt[0].text.content, "素材URL：");
  assert.equal(rt[1].text.content, "cut03_リード撮影.mp4");
  assert.equal(rt[1].text.link.url, "https://drive.google.com/file/d/ID/view");
  assert.ok(rt[2].text.content.includes("2510_リード撮影/A"));
});

test("buildMaterialBlocks: 動画は embed(/preview) ブロック", () => {
  const id = "1A2b3C4d5E6f7G8h9I0jKLMNOPqrstuv";
  const { blocks, fileId, previewUrl } = buildMaterialBlocks({
    url: `https://drive.google.com/file/d/${id}/view?usp=drivesdk`,
    name: "cut03.mp4",
    mimeType: "video/mp4",
    folderPath: "grm/A",
    cut: "カット03",
  });
  assert.equal(fileId, id);
  assert.equal(previewUrl, `https://drive.google.com/file/d/${id}/preview`);
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0].type, "embed");
  assert.equal(blocks[0].embed.url, `https://drive.google.com/file/d/${id}/preview`);
  assert.ok(blocks[0].embed.caption[0].text.content.includes("カット03"));
});

test("buildMaterialBlocks: 非プレビュー系は bookmark", () => {
  const id = "1A2b3C4d5E6f7G8h9I0jKLMNOPqrstuv";
  const { blocks, previewUrl } = buildMaterialBlocks({
    url: `https://drive.google.com/file/d/${id}/view`,
    name: "assets.zip",
    mimeType: "application/zip",
  });
  assert.equal(previewUrl, null);
  assert.equal(blocks[0].type, "bookmark");
});

test("buildMaterialBlocks: Drive以外URLは壊さず bookmark で返す", () => {
  const { blocks, fileId } = buildMaterialBlocks({ url: "https://example.com/x" });
  assert.equal(fileId, null);
  assert.equal(blocks[0].type, "bookmark");
  assert.equal(blocks[0].bookmark.url, "https://example.com/x");
});
