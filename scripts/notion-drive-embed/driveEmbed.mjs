// BUG-13 対応: GoogleドライブURLをNotionで「一目で分かる」形に変換するための純粋関数群。
//
// 課題:
//   1分動画素材選定くん(TOOL-24)は、マッチングした素材の Drive 共有URL
//   (例: https://drive.google.com/file/d/XXXX/view?usp=drivesdk) を
//   Notionの「素材URL：」callout に "生のURL文字列" として書き込んでいた。
//   生URLは青いリンク文字列でしかなく、サムネイルもファイル名も出ないため
//   「パッと見て何の素材か分からない」。
//
// 方針:
//   - Drive の /preview エンドポイントを使った `embed` ブロックを併記し、
//     動画/画像/PDFがNotion内でインラインプレビュー(再生・表示)される状態にする。
//   - callout本体のリンク文字列は「生URL」ではなく「ファイル名(リンク付き)」にして
//     人間が読めるようにする。
//
// このファイルはネットワークに触れない純粋関数だけを持つ(テスト可能)。
// Notionへの書き込みオーケストレーションは notionWrite.mjs 側。

/**
 * 各種 Google Drive URL からファイルIDを抽出する。
 * 対応形:
 *   https://drive.google.com/file/d/<ID>/view?usp=drivesdk
 *   https://drive.google.com/file/d/<ID>/preview
 *   https://drive.google.com/open?id=<ID>
 *   https://drive.google.com/uc?id=<ID>&export=download
 *   https://docs.google.com/document/d/<ID>/edit  など Docs/Sheets/Slides
 *   <ID> 単体(44文字前後の英数/-/_)
 * @param {string} urlOrId
 * @returns {string|null}
 */
export function parseDriveFileId(urlOrId) {
  if (!urlOrId) return null;
  const s = String(urlOrId).trim();

  // /d/<ID>  (file/d/, document/d/, spreadsheets/d/, presentation/d/ 全部これ)
  const dMatch = s.match(/\/d\/([a-zA-Z0-9_-]{20,})/);
  if (dMatch) return dMatch[1];

  // ?id=<ID> / &id=<ID>
  const idParam = s.match(/[?&]id=([a-zA-Z0-9_-]{20,})/);
  if (idParam) return idParam[1];

  // ID単体
  if (/^[a-zA-Z0-9_-]{20,}$/.test(s)) return s;

  return null;
}

/**
 * Google Workspace ネイティブ形式(Docs/Sheets/Slides)は /file/d/ ではなく
 * それぞれ専用URLのため、mimeType から適切なパスセグメントを返す。
 * 通常のアップロードファイル(動画/画像/PDF)は "file"。
 * @param {string} mimeType
 * @returns {"document"|"spreadsheets"|"presentation"|"file"}
 */
function driveDocKind(mimeType) {
  switch (mimeType) {
    case "application/vnd.google-apps.document":
      return "document";
    case "application/vnd.google-apps.spreadsheet":
      return "spreadsheets";
    case "application/vnd.google-apps.presentation":
      return "presentation";
    default:
      return "file";
  }
}

/**
 * Notion(iframe)内でインライン表示させるためのプレビューURL。
 * /view ではなく /preview を使うのが要点(/view はX-Frame-Optionsで埋め込み拒否される場合がある)。
 * @param {string} fileId
 * @param {string} [mimeType]
 * @returns {string}
 */
export function drivePreviewUrl(fileId, mimeType) {
  const kind = driveDocKind(mimeType);
  if (kind === "file") return `https://drive.google.com/file/d/${fileId}/preview`;
  // Docs系は /preview が使えるものと /pub のものがあるが、/preview で概ね埋め込み可能
  return `https://docs.google.com/${kind}/d/${fileId}/preview`;
}

/**
 * 人間がクリックして開く用の閲覧URL(新規タブで開く想定)。
 * @param {string} fileId
 * @param {string} [mimeType]
 * @returns {string}
 */
export function driveViewUrl(fileId, mimeType) {
  const kind = driveDocKind(mimeType);
  if (kind === "file") return `https://drive.google.com/file/d/${fileId}/view`;
  return `https://docs.google.com/${kind}/d/${fileId}/edit`;
}

/**
 * mimeType がインラインプレビュー(embed)に向くか。
 * 動画/画像/PDF/Google Docs系は embed が有効。それ以外(zip等)は bookmark にフォールバック。
 * @param {string} mimeType
 * @returns {boolean}
 */
export function isPreviewable(mimeType) {
  if (!mimeType) return true; // 不明時は embed を試す(素材は動画である前提のため)
  return (
    /^video\//.test(mimeType) ||
    /^image\//.test(mimeType) ||
    mimeType === "application/pdf" ||
    /^application\/vnd\.google-apps\.(document|spreadsheet|presentation)$/.test(mimeType)
  );
}

/**
 * ファイル種別を表す絵文字(callout のアイコンやラベルに使用)。
 * @param {string} mimeType
 * @returns {string}
 */
export function kindEmoji(mimeType) {
  if (!mimeType) return "🎦";
  if (/^video\//.test(mimeType)) return "🎬";
  if (/^image\//.test(mimeType)) return "🖼️";
  if (mimeType === "application/pdf") return "📄";
  return "📎";
}

/**
 * Notion rich_text 配列を作る。callout本体に入れる
 * 「素材URL：<ファイル名>(リンク)」＋（あれば）フォルダ情報。
 * @param {{name:string, viewUrl:string, folderPath?:string}} m
 * @returns {object[]}
 */
export function materialRichText({ name, viewUrl, folderPath }) {
  const rt = [
    { type: "text", text: { content: "素材URL：" } },
    { type: "text", text: { content: name || "(名称不明)", link: { url: viewUrl } } },
  ];
  if (folderPath) {
    rt.push({
      type: "text",
      text: { content: `  〔${folderPath}〕` },
      annotations: { color: "gray" },
    });
  }
  return rt;
}

/**
 * 素材1件を「一目で分かる」ブロック群に変換する。
 * - previewable なら embed(/preview) ブロック(インライン再生/表示)
 * - それ以外は bookmark ブロック(カード型に自動アンファール)
 * どちらもファイル名/フォルダを caption に入れて文脈を残す。
 *
 * @param {{
 *   url: string,            // Driveの共有URL または fileId
 *   name?: string,          // ファイル名
 *   mimeType?: string,      // 例 video/mp4
 *   folderPath?: string,    // 例 2510_リード撮影/A
 *   cut?: string            // 例 カット03
 * }} material
 * @returns {{ blocks: object[], fileId: string|null, previewUrl: string|null }}
 */
export function buildMaterialBlocks(material) {
  const { url, name, mimeType, folderPath, cut } = material;
  const fileId = parseDriveFileId(url);
  if (!fileId) {
    // Drive URLとして解釈できない場合は、生URLの bookmark だけ返す(壊さない)
    return {
      blocks: url ? [{ object: "block", type: "bookmark", bookmark: { url } }] : [],
      fileId: null,
      previewUrl: null,
    };
  }

  const previewUrl = drivePreviewUrl(fileId, mimeType);
  const captionParts = [];
  if (cut) captionParts.push(cut);
  if (name) captionParts.push(name);
  if (folderPath) captionParts.push(`〔${folderPath}〕`);
  const caption = captionParts.length
    ? [{ type: "text", text: { content: captionParts.join(" ／ ") } }]
    : [];

  if (isPreviewable(mimeType)) {
    return {
      blocks: [{ object: "block", type: "embed", embed: { url: previewUrl, caption } }],
      fileId,
      previewUrl,
    };
  }

  // 非プレビュー系はカード表示(生URLよりは何かは分かる)
  return {
    blocks: [{ object: "block", type: "bookmark", bookmark: { url: driveViewUrl(fileId, mimeType), caption } }],
    fileId,
    previewUrl: null,
  };
}
