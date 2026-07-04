// Meta Graph API まわり（動画アップロード / creative specコピー / 広告作成）
//
// 動画アップロードは chunked upload（start→transfer→finish）を使い、
// Drive から UPLOAD_CHUNK_BYTES ずつ Range 取得して順送りする。
// Worker のメモリ(128MB)に全量を載せない。

import { GRAPH, UPLOAD_CHUNK_BYTES, CreativeTextOverrides } from "./types";
import { fetchFileRange } from "./drive";

// ---------- 動画アップロード ----------

export interface UploadSession {
  uploadSessionId: string;
  videoId: string;
  startOffset: number;
  endOffset: number;
  fileSize: number;
}

export async function startVideoUpload(
  accountId: string,
  token: string,
  fileSize: number
): Promise<UploadSession> {
  const res = await graphPost(`act_${accountId}/advideos`, token, {
    upload_phase: "start",
    file_size: String(fileSize),
  });
  return {
    uploadSessionId: res.upload_session_id,
    videoId: res.video_id,
    startOffset: Number(res.start_offset),
    endOffset: Number(res.end_offset),
    fileSize,
  };
}

/**
 * 1チャンク転送。Metaが返す新しい offset を反映したセッションを返す。
 * 呼び出し側は startOffset >= fileSize になるまで繰り返し、その後 finish を呼ぶ。
 */
export async function transferVideoChunk(
  accountId: string,
  token: string,
  session: UploadSession,
  driveToken: string,
  driveFileId: string
): Promise<UploadSession> {
  // Metaが要求しているオフセット範囲をDriveから取得（end_offsetは排他的な場合があるため-1）
  const start = session.startOffset;
  const end = Math.min(start + UPLOAD_CHUNK_BYTES, session.fileSize) - 1;
  const bytes = await fetchFileRange(driveToken, driveFileId, start, end);

  const form = new FormData();
  form.set("upload_phase", "transfer");
  form.set("upload_session_id", session.uploadSessionId);
  form.set("start_offset", String(start));
  form.set("video_file_chunk", new Blob([bytes]), "chunk.bin");
  form.set("access_token", token);

  const res = await fetch(`${GRAPH}/act_${accountId}/advideos`, { method: "POST", body: form });
  const data = (await res.json()) as any;
  if (!res.ok || data.error) throw new Error(`動画チャンク転送失敗: ${JSON.stringify(data.error || data)}`);
  return {
    ...session,
    startOffset: Number(data.start_offset),
    endOffset: Number(data.end_offset),
  };
}

export async function finishVideoUpload(
  accountId: string,
  token: string,
  session: UploadSession,
  title: string
): Promise<void> {
  await graphPost(`act_${accountId}/advideos`, token, {
    upload_phase: "finish",
    upload_session_id: session.uploadSessionId,
    title,
  });
}

/** 動画の処理状況。ready / processing / error */
export async function videoStatus(videoId: string, token: string): Promise<string> {
  const res = await graphGet(`${videoId}?fields=status`, token);
  return res.status?.video_status || "unknown";
}

/**
 * 動画のサムネイルURL（Meta自動生成）を取得。
 * 動画広告のcreativeには image_url/image_hash の指定が必須（error_subcode 1443226）のため、
 * ready後に自動生成されたサムネイルを使う。生成直後は空のことがあるので数回リトライ。
 */
export async function getVideoThumbnailUrl(videoId: string, token: string): Promise<string | null> {
  for (let i = 0; i < 5; i++) {
    const res = await graphGet(`${videoId}/thumbnails?fields=uri,is_preferred`, token);
    const list: any[] = res.data || [];
    if (list.length) {
      const pref = list.find((t) => t.is_preferred) || list[0];
      if (pref?.uri) return pref.uri;
    }
    await new Promise((r) => setTimeout(r, 3000));
  }
  return null;
}

// ---------- creative spec コピー ----------

/** コピー元広告の creative から、新規作成に使える spec を取得 */
export async function getSourceCreativeSpec(adId: string, token: string): Promise<any> {
  const fields =
    "name,creative{object_story_spec,url_tags,degrees_of_freedom_spec,contextual_multi_ads,asset_feed_spec}";
  const res = await graphGet(`${adId}?fields=${encodeURIComponent(fields)}`, token);
  if (!res.creative) throw new Error(`コピー元広告 ${adId} のcreativeが取得できません`);
  return res.creative;
}

/**
 * コピー元 creative spec をベースに、新しい video_id・広告名・テキスト類を差し替えた
 * adcreatives 作成パラメータを組み立てる。
 * - エンハンス（standard_enhancements）と関連メディア（contextual_multi_ads）は明示的にOFF固定
 * - link_url / url_tags 内の cr= パラメータは新cr名へ置換
 */
export function buildCreativeParams(
  source: any,
  opts: {
    adName: string;
    videoId: string;
    /** 新動画のサムネイルURL（必須。Metaは動画creativeにimage_url/image_hash必須） */
    thumbnailUrl: string;
    crParam: string; // URLパラメータに入れるcr名（例: cr79_01）
    overrides: CreativeTextOverrides;
  }
): Record<string, string> {
  const story = JSON.parse(JSON.stringify(source.object_story_spec || {}));
  const video = story.video_data;
  if (!video) {
    throw new Error(
      "コピー元広告が video_data 形式ではありません（画像広告・asset_feed形式は未対応。コピー元に動画広告を選んでください）"
    );
  }

  video.video_id = opts.videoId;
  // サムネイルは新動画の自動生成サムネイルに差し替え（旧動画のものを引き継ぐと不整合）
  delete video.image_hash;
  video.image_url = opts.thumbnailUrl;

  if (opts.overrides.message) video.message = opts.overrides.message;
  if (opts.overrides.title && video.title !== undefined) video.title = opts.overrides.title;

  // 遷移先URL: call_to_action.value.link 置換 + cr=パラメータ更新
  const cta = video.call_to_action;
  if (cta?.value?.link) {
    let link: string = opts.overrides.linkUrl || cta.value.link;
    link = replaceCrParam(link, opts.crParam);
    cta.value.link = link;
  }
  if (opts.overrides.title && cta?.value?.link_caption !== undefined) {
    // link_captionを見出しに使う構成の案件向け（存在する場合のみ）
    cta.value.link_caption = opts.overrides.title;
  }

  const params: Record<string, string> = {
    name: opts.adName,
    object_story_spec: JSON.stringify(story),
    // エンハンス系を明示OFF（手動運用の「エンハンス0件」を再現）
    degrees_of_freedom_spec: JSON.stringify({
      creative_features_spec: { standard_enhancements: { enroll_status: "OPT_OUT" } },
    }),
    // 関連メディアOFF
    contextual_multi_ads: JSON.stringify({ enroll_status: "OPT_OUT" }),
  };
  if (source.url_tags) {
    params.url_tags = replaceCrParam(source.url_tags, opts.crParam);
  }
  return params;
}

export function replaceCrParam(s: string, crName: string): string {
  if (/([?&]cr=)[^&]*/.test(s)) return s.replace(/([?&]cr=)[^&]*/g, `$1${encodeURIComponent(crName)}`);
  return s; // cr=パラメータを使っていない案件はそのまま
}

export async function createCreative(
  accountId: string,
  token: string,
  params: Record<string, string>
): Promise<string> {
  const res = await graphPost(`act_${accountId}/adcreatives`, token, params);
  return res.id;
}

export async function createAd(
  accountId: string,
  token: string,
  opts: { name: string; adsetId: string; creativeId: string }
): Promise<string> {
  const res = await graphPost(`act_${accountId}/ads`, token, {
    name: opts.name,
    adset_id: opts.adsetId,
    creative: JSON.stringify({ creative_id: opts.creativeId }),
    status: "PAUSED", // 必ず一時停止で作成。ONは人が行う
  });
  return res.id;
}

// ---------- 解決フェーズ用の読み取り ----------

export interface AdsetCandidate {
  id: string;
  name: string;
  campaignName: string;
  latestAd?: { id: string; name: string; createdTime: string };
}

/** ACTIVEな広告セット一覧と、各セットの直近cr広告（コピー元候補）を取得 */
export async function listAdsetCandidates(
  accountId: string,
  token: string,
  allowlist?: string[]
): Promise<AdsetCandidate[]> {
  const res = await graphGet(
    `act_${accountId}/adsets?fields=${encodeURIComponent(
      "id,name,effective_status,campaign{name},ads.limit(50){id,name,created_time}"
    )}&limit=50`,
    token
  );
  const out: AdsetCandidate[] = [];
  for (const s of res.data || []) {
    if (s.effective_status !== "ACTIVE") continue;
    if (allowlist && allowlist.length > 0 && !allowlist.includes(s.id)) continue;
    const ads: any[] = s.ads?.data || [];
    const crAds = ads
      .filter((a) => /cr\d/i.test(a.name))
      .sort((a, b) => String(b.created_time).localeCompare(String(a.created_time)));
    out.push({
      id: s.id,
      name: s.name,
      campaignName: s.campaign?.name || "",
      latestAd: crAds[0]
        ? { id: crAds[0].id, name: crAds[0].name, createdTime: crAds[0].created_time }
        : undefined,
    });
  }
  return out;
}

/** 同名広告の存在チェック（冪等性: 二重入稿防止） */
export async function findAdsByExactName(
  accountId: string,
  token: string,
  names: string[]
): Promise<string[]> {
  // cr番号で広く検索→手元で厳密一致（cr停止くんと同じ3段方式。MetaのCONTAIN癖対策）
  const key = names[0]?.match(/cr\d+/i)?.[0];
  if (!key) return [];
  const filtering = encodeURIComponent(
    JSON.stringify([{ field: "name", operator: "CONTAIN", value: key }])
  );
  const res = await graphGet(`act_${accountId}/ads?fields=name&filtering=${filtering}&limit=200`, token);
  const existing = new Set((res.data || []).map((a: any) => a.name));
  return names.filter((n) => existing.has(n));
}

// ---------- 低レベル ----------

const META_TIMEOUT_MS = 25_000;

async function graphGet(path: string, token: string): Promise<any> {
  const sep = path.includes("?") ? "&" : "?";
  const res = await fetchWithTimeout(`${GRAPH}/${path}${sep}access_token=${encodeURIComponent(token)}`);
  const data = (await res.json()) as any;
  if (data.error) throw new Error(`Meta API失敗: ${JSON.stringify(data.error)}`);
  return data;
}

async function graphPost(path: string, token: string, params: Record<string, string>): Promise<any> {
  const body = new URLSearchParams({ ...params, access_token: token });
  const res = await fetchWithTimeout(`${GRAPH}/${path}`, { method: "POST", body });
  const data = (await res.json()) as any;
  if (data.error) throw new Error(`Meta API失敗 (${path}): ${JSON.stringify(data.error)}`);
  return data;
}

async function fetchWithTimeout(url: string, init?: RequestInit): Promise<Response> {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), META_TIMEOUT_MS);
  try {
    return await fetch(url, { ...init, signal: ctl.signal });
  } finally {
    clearTimeout(t);
  }
}
