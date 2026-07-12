// crの冒頭サムネ（0:01フレーム）抽出→Driveアップロード→集計表セルへ挿入（BUG-34）
// ------------------------------------------------------------
// cr入稿くん実行環境（Cloudflare Worker / GAS）は動画デコードができないため、
// ffmpeg が使える GitHub Actions 上でフレーム抽出を行う「基盤」。
//   1. Drive から対象動画をダウンロード（サービスアカウント）
//   2. ffmpeg で 00:00:01 の1フレームを JPG 抽出（0:00はテロップ未表示のため0:01。山田要望）
//   3. JPG を Drive にアップロードし「リンクを知る全員=閲覧可」に（=IMAGE/セル内画像で参照可能に）
//   4. 共通GAS insertCrThumbnail を呼び、該当ブロックの結合セルにセル内画像として挿入
//
// 使い方（GitHub Actions workflow_dispatch から呼ぶ）:
//   node extract_thumbnail.mjs --sheet <spreadsheetId> --tab <タブ名> \
//     --gas <GAS WebApp URL> --sec 1 \
//     --jobs '[{"id":"cr83","fileId":"<cr83_01の動画DriveID>"},{"id":"cr83_01","fileId":"..."}]'
//
// 「親は01」: 親ブロック(cr83)には子cr83_01の動画のフレームを使う → jobsで id=cr83 に _01のfileIdを渡す。
// 必要な環境変数: GOOGLE_SERVICE_ACCOUNT_JSON（Drive読み書き権限）
// ------------------------------------------------------------

import { google } from "googleapis";
import { execFileSync } from "node:child_process";
import { writeFileSync, readFileSync, createReadStream, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const args = parseArgs(process.argv.slice(2));
if (!args.sheet || !args.gas || !args.jobs) {
  console.error("使い方: node extract_thumbnail.mjs --sheet <id> --tab <タブ> --gas <GAS URL> --jobs '<JSON>' [--sec 1]");
  process.exit(1);
}
const SPREADSHEET_ID = extractId(args.sheet);
const SHEET_NAME = args.tab || "";
const GAS_URL = args.gas;
const SEC = args.sec || "1"; // 抽出秒（既定 0:01）
let jobs;
try {
  jobs = JSON.parse(args.jobs);
} catch (e) {
  console.error("--jobs のJSONが不正です: " + e.message);
  process.exit(1);
}
if (!Array.isArray(jobs) || jobs.length === 0) {
  console.error("--jobs は [{id, fileId}, ...] の配列です");
  process.exit(1);
}

const raw = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
if (!raw) {
  console.error("ERROR: GOOGLE_SERVICE_ACCOUNT_JSON が未設定です。");
  process.exit(1);
}
const creds = JSON.parse(raw);
console.log(`# 実行中のサービスアカウント: ${creds.client_email}`);
const auth = new google.auth.GoogleAuth({
  credentials: creds,
  scopes: ["https://www.googleapis.com/auth/drive"],
});
const drive = google.drive({ version: "v3", auth });
const tmp = mkdtempSync(join(tmpdir(), "crthumb-"));

let ok = 0, ng = 0;
for (const job of jobs) {
  const { id, fileId } = job;
  if (!id || !fileId) {
    console.log(`- スキップ（id/fileId不足）: ${JSON.stringify(job)}`);
    ng++;
    continue;
  }
  try {
    // 1. 動画DL
    const videoPath = join(tmp, `${sanitize(id)}.mp4`);
    const res = await drive.files.get({ fileId, alt: "media" }, { responseType: "arraybuffer" });
    writeFileSync(videoPath, Buffer.from(res.data));

    // 2. ffmpegで 0:SEC の1フレームをJPG抽出（-ss を -i の前に置いて高速シーク）
    const jpgPath = join(tmp, `${sanitize(id)}_thumb.jpg`);
    execFileSync("ffmpeg", ["-y", "-ss", String(SEC), "-i", videoPath, "-frames:v", "1", "-q:v", "3", jpgPath], {
      stdio: ["ignore", "ignore", "inherit"],
    });

    // 3. JPGを動画と同じフォルダにアップロードし、リンク公開
    const parents = await getParents(fileId);
    const up = await drive.files.create({
      requestBody: { name: `${id}_thumb01.jpg`, parents: parents.length ? [parents[0]] : undefined },
      media: { mimeType: "image/jpeg", body: createReadStream(jpgPath) },
      fields: "id",
    });
    const imgId = up.data.id;
    await drive.permissions.create({ fileId: imgId, requestBody: { role: "reader", type: "anyone" } });
    // Sheetsのセル内画像/ IMAGE() が参照できる公開サムネURL
    const imageUrl = `https://drive.google.com/thumbnail?id=${imgId}&sz=w1000`;

    // 4. GASでセル内画像として挿入
    const gasRes = await postGas(GAS_URL, {
      action: "insertCrThumbnail",
      spreadsheetId: SPREADSHEET_ID,
      sheetName: SHEET_NAME || undefined,
      id,
      imageUrl,
    });
    if (gasRes && gasRes.ok) {
      console.log(`✅ ${id}: ${gasRes.cell} に挿入（merged=${gasRes.merged}） img=${imgId}`);
      ok++;
    } else {
      console.log(`❌ ${id}: GAS挿入失敗: ${gasRes && gasRes.error}`);
      ng++;
    }
  } catch (e) {
    console.log(`❌ ${id}: ${e.message}`);
    ng++;
  }
}
console.log(`\n# 完了: 成功 ${ok} / 失敗 ${ng}`);
if (ng > 0) process.exit(1);

// ------------------------------------------------------------
async function getParents(fileId) {
  try {
    const r = await drive.files.get({ fileId, fields: "parents" });
    return r.data.parents || [];
  } catch {
    return [];
  }
}

// GASはPOST→302→GET で結果が返る（既存 callGas と同じ挙動）
async function postGas(url, payload) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
    redirect: "follow",
  });
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch {
    return { ok: false, error: `GAS応答をJSON解釈できません: ${text.slice(0, 200)}` };
  }
}

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--sheet") out.sheet = argv[++i];
    else if (a === "--tab") out.tab = argv[++i];
    else if (a === "--gas") out.gas = argv[++i];
    else if (a === "--jobs") out.jobs = argv[++i];
    else if (a === "--sec") out.sec = argv[++i];
  }
  return out;
}
function extractId(s) {
  const m = String(s).match(/\/d\/([a-zA-Z0-9_-]+)/);
  return m ? m[1] : s;
}
function sanitize(s) {
  return String(s).replace(/[^a-zA-Z0-9_-]/g, "_");
}
