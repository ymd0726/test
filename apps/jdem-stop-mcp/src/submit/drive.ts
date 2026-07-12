// Google Drive 読み取り（サービスアカウントJWT / WebCrypto RS256）
// Workerから動画ファイルの一覧取得・メタデータ取得・Range取得を行う。
// 集計表と同じサービスアカウント（ads-reader@...）に cr フォルダの閲覧権限を付けておくこと。

interface ServiceAccount {
  client_email: string;
  private_key: string;
}

let cachedToken: { token: string; exp: number } | null = null;

export async function driveAccessToken(saJson: string): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  if (cachedToken && cachedToken.exp - 60 > now) return cachedToken.token;

  if (!saJson) {
    throw new Error("GOOGLE_SERVICE_ACCOUNT_JSON が未設定です（Cloudflare → Settings → Variables and Secrets で追加してください）");
  }
  let sa: ServiceAccount;
  try {
    sa = JSON.parse(saJson.replace(/^﻿/, "").trim());
  } catch {
    const head = saJson.slice(0, 12).replace(/[\r\n]/g, "⏎");
    throw new Error(
      `GOOGLE_SERVICE_ACCOUNT_JSON がJSONとして読めません（先頭: "${head}…" / 長さ${saJson.length}文字）。` +
        `JSON鍵ファイルの中身を「{」から「}」まで丸ごと貼り直してください`
    );
  }
  if (!sa.client_email || !sa.private_key) {
    throw new Error("GOOGLE_SERVICE_ACCOUNT_JSON に client_email / private_key がありません。サービスアカウントのJSON鍵か確認してください");
  }
  const header = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const claims = b64url(
    JSON.stringify({
      iss: sa.client_email,
      scope: "https://www.googleapis.com/auth/drive.readonly",
      aud: "https://oauth2.googleapis.com/token",
      iat: now,
      exp: now + 3600,
    })
  );
  const signingInput = `${header}.${claims}`;
  const key = await importPkcs8(sa.private_key);
  const sig = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, new TextEncoder().encode(signingInput));
  const jwt = `${signingInput}.${b64urlBytes(new Uint8Array(sig))}`;

  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: `grant_type=${encodeURIComponent("urn:ietf:params:oauth:grant-type:jwt-bearer")}&assertion=${jwt}`,
  });
  if (!res.ok) throw new Error(`Drive token取得失敗: ${res.status} ${await res.text()}`);
  const data = (await res.json()) as { access_token: string; expires_in: number };
  cachedToken = { token: data.access_token, exp: now + data.expires_in };
  return data.access_token;
}

export interface DriveFile {
  id: string;
  name: string;
  mimeType: string;
  size: number;
}

/** フォルダIDまたはフォルダ名からフォルダIDを解決 */
export async function resolveFolderId(
  token: string,
  opts: { folderId?: string; folderName?: string }
): Promise<string> {
  if (opts.folderId) return opts.folderId;
  if (!opts.folderName) throw new Error("driveFolderId / driveFolderName のどちらかが必要です");
  const q = encodeURIComponent(
    `name = '${opts.folderName.replace(/'/g, "\\'")}' and mimeType = 'application/vnd.google-apps.folder' and trashed = false`
  );
  const res = await driveApi(token, `files?q=${q}&fields=files(id,name)&pageSize=5&supportsAllDrives=true&includeItemsFromAllDrives=true&corpora=allDrives`);
  const files = res.files || [];
  if (files.length === 0) throw new Error(`Driveフォルダ「${opts.folderName}」が見つかりません`);
  if (files.length > 1) throw new Error(`Driveフォルダ「${opts.folderName}」が複数(${files.length})あります。driveFolderId を指定してください`);
  return files[0].id;
}

/** フォルダ配下（サブフォルダ1階層含む）から名前が prefix で始まる動画/画像ファイルを列挙 */
export async function listCreativeFiles(token: string, folderId: string, prefix: string): Promise<DriveFile[]> {
  // 直下ファイル + 直下サブフォルダ（親フォルダ名=親CR名の運用があるため1階層だけ潜る）
  const out: DriveFile[] = [];
  const children = await listChildren(token, folderId);
  const subfolders: string[] = [];
  for (const f of children) {
    if (f.mimeType === "application/vnd.google-apps.folder") {
      // 親CR名のフォルダなら潜る
      if (f.name.startsWith(prefix)) subfolders.push(f.id);
    } else if (f.name.startsWith(prefix)) {
      out.push(f);
    }
  }
  for (const sub of subfolders) {
    for (const f of await listChildren(token, sub)) {
      if (f.mimeType !== "application/vnd.google-apps.folder" && f.name.startsWith(prefix)) out.push(f);
    }
  }
  return out.filter((f) => /video|image/.test(f.mimeType));
}

async function listChildren(token: string, folderId: string): Promise<DriveFile[]> {
  const files: DriveFile[] = [];
  let pageToken = "";
  do {
    const q = encodeURIComponent(`'${folderId}' in parents and trashed = false`);
    const res = await driveApi(
      token,
      `files?q=${q}&fields=nextPageToken,files(id,name,mimeType,size)&pageSize=200&supportsAllDrives=true&includeItemsFromAllDrives=true` +
        (pageToken ? `&pageToken=${pageToken}` : "")
    );
    for (const f of res.files || []) {
      files.push({ id: f.id, name: f.name, mimeType: f.mimeType, size: Number(f.size || 0) });
    }
    pageToken = res.nextPageToken || "";
  } while (pageToken);
  return files;
}

/** ファイルの一部（Range）を取得。Meta chunked upload へ順送りする */
export async function fetchFileRange(
  token: string,
  fileId: string,
  start: number,
  endInclusive: number
): Promise<ArrayBuffer> {
  const res = await fetch(
    `https://www.googleapis.com/drive/v3/files/${fileId}?alt=media&supportsAllDrives=true`,
    { headers: { authorization: `Bearer ${token}`, range: `bytes=${start}-${endInclusive}` } }
  );
  if (!res.ok && res.status !== 206) {
    throw new Error(`Drive Range取得失敗 (${res.status}): ${await res.text()}`);
  }
  return await res.arrayBuffer();
}

async function driveApi(token: string, path: string): Promise<any> {
  const res = await fetch(`https://www.googleapis.com/drive/v3/${path}`, {
    headers: { authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new Error(`Drive API失敗 (${res.status}): ${await res.text()}`);
  return await res.json();
}

// ---- helpers ----
async function importPkcs8(pem: string): Promise<CryptoKey> {
  const body = pem.replace(/-----[A-Z ]+-----/g, "").replace(/\s+/g, "");
  const der = Uint8Array.from(atob(body), (c) => c.charCodeAt(0));
  return crypto.subtle.importKey(
    "pkcs8",
    der.buffer,
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"]
  );
}

function b64url(s: string): string {
  return b64urlBytes(new TextEncoder().encode(s));
}
function b64urlBytes(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
