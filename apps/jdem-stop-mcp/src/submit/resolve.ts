// 解決フェーズ: /cr-in の引数から「実行プラン」を組み立て、Slack確認UIを返す
//
// 1. Notion CRページ特定（URL直指定 or CRDB検索）
// 2. Drive から完成ファイル特定（親 + _NN パターン子）
// 3. Meta 広告セット候補と各セットの直近cr広告（コピー元）取得
// 4. 実行プランを組んでSlackに確認ボタン表示（広告セットが複数なら選択UI）

import { SubmitProject, SubmitPlan, PlannedVideo, SubmitEnv } from "./types";
import { driveAccessToken, resolveFolderId, listCreativeFiles, DriveFile } from "./drive";
import { fetchCrPage, findCrPageByName, fetchCldbCrFolderId, CrPageInfo } from "./notion";
import { listAdsetCandidates, findAdsByExactName, AdsetCandidate } from "./meta";

export interface ResolveInput {
  text: string; // /cr-in の引数
  channelId: string;
  userId: string;
  responseUrl: string;
}

export interface ResolveOutcome {
  /** 確認UIに使うプラン（adset未確定の場合は candidates から選ばせる） */
  plan?: SubmitPlan;
  adsetCandidates?: AdsetCandidate[];
  crPage: CrPageInfo;
  files: { parent?: DriveFile; children: DriveFile[] };
  warnings: string[];
}

export async function resolveSubmit(
  project: SubmitProject,
  env: SubmitEnv,
  metaToken: string,
  input: ResolveInput
): Promise<ResolveOutcome> {
  const warnings: string[] = [];
  const arg = input.text.trim();
  if (!arg) throw new Error("使い方: `/cr-in <cr名 または NotionページURL>`（例: `/cr-in cr79`）");

  // 1. Notion CRページ
  let crPage: CrPageInfo;
  if (/notion\.(so|com)|app\.notion\.com|^[0-9a-f-]{32,36}$/i.test(arg)) {
    crPage = await fetchCrPage(env.NOTION_TOKEN, arg);
  } else {
    if (!project.crdbDataSourceId) {
      throw new Error(
        `案件「${project.name}」に crdbDataSourceId が未設定です。NotionページURLで指定してください`
      );
    }
    const key = normalizeCrKey(arg); // "cr79" / "79" → "cr79"
    const hits = await findCrPageByName(env.NOTION_TOKEN, project.crdbDataSourceId, key);
    // 前方一致で cr79 と cr790 を区別（cr79_ / cr79末尾のみ許容）
    const exact = hits.filter((h) => new RegExp(`${key}(_|$|[^0-9])`).test(h.name));
    if (exact.length === 0) throw new Error(`Notion CRDBに「${key}」のページが見つかりません`);
    if (exact.length > 1)
      throw new Error(
        `Notion CRDBに「${key}」が複数あります:\n${exact.map((h) => `・${h.name}`).join("\n")}\nNotionページURLで指定してください`
      );
    crPage = exact[0];
  }

  const parentName = crPage.name; // 例: jde_mak_cr79_ブライダル訴求
  const crKey = extractCrKey(parentName); // cr79
  if (!crKey) throw new Error(`CRページ名からcr番号を特定できません: ${parentName}`);

  // 2. Drive ファイル
  // crフォルダは CLDB「cr倉庫_(GoogleDrive) #納品先」を最優先で実行時解決（フォルダ移動にデプロイ不要）。
  // CLDB未設定・未共有・プロパティ空のときはWorker設定値にフォールバック。
  let configuredFolderId = project.driveFolderId;
  if (project.cldbPageId) {
    try {
      const cldbFolderId = await fetchCldbCrFolderId(env.NOTION_TOKEN, project.cldbPageId);
      if (cldbFolderId) {
        configuredFolderId = cldbFolderId;
      } else {
        warnings.push("ℹ️ CLDBのcr倉庫プロパティが未設定のため、Worker設定のフォルダを使用");
      }
    } catch (e: any) {
      warnings.push(`ℹ️ CLDB参照失敗（${e.message}）。Worker設定のフォルダを使用`);
    }
  }
  const driveToken = await driveAccessToken(env.GOOGLE_SERVICE_ACCOUNT_JSON);
  const folderId = await resolveFolderId(driveToken, {
    folderId: configuredFolderId,
    folderName: project.driveFolderName,
  });
  // 親名の先頭部分（説明を除いた {案件}_{crKey}）でも拾えるように2段で検索
  const prefix = parentName.split(crKey)[0] + crKey; // 例: jde_mak_cr79
  const all = await listCreativeFiles(driveToken, folderId, prefix);
  const childPattern = new RegExp(`${escapeReg(crKey)}_(\\d{2})`, "i");
  const children = all
    .filter((f) => childPattern.test(f.name))
    .sort((a, b) => a.name.localeCompare(b.name, "ja"));
  const parent = all.find((f) => !childPattern.test(f.name));
  if (all.length === 0) {
    throw new Error(`Driveフォルダに「${prefix}」で始まる完成ファイルが見つかりません`);
  }
  if (!parent && children.length === 0) {
    throw new Error(`入稿対象ファイルを特定できません（検出: ${all.map((f) => f.name).join(", ")}）`);
  }

  // 3. Meta 広告セット候補
  if (!project.metaAdAccountId) throw new Error(`案件「${project.name}」にmetaAdAccountIdが未設定です`);
  const candidates = await listAdsetCandidates(project.metaAdAccountId, metaToken, project.adsetAllowlist);
  const usable = candidates.filter((c) => c.latestAd);
  if (usable.length === 0) {
    throw new Error("コピー元にできる直近cr広告を持つACTIVEな広告セットが見つかりません");
  }

  // 4. プラン組み立て（実際に入稿する動画 = 子があれば子、無ければ親）
  const targets: DriveFile[] = children.length > 0 ? children : parent ? [parent] : [];
  const videos: PlannedVideo[] = targets.map((f) => {
    const base = stripExt(f.name);
    return {
      adName: adNameFor(project, base),
      sheetId: sheetIdFor(base), // 集計表表記: 案件コードを除いた cr79_01_説明
      driveFileId: f.id,
      driveFileName: f.name,
      fileSizeBytes: f.size,
      mimeType: f.mimeType,
    };
  });

  // 冪等性チェック: 同名広告が既にあれば警告
  const dup = await findAdsByExactName(
    project.metaAdAccountId,
    metaToken,
    videos.map((v) => v.adName)
  );
  if (dup.length > 0) warnings.push(`⚠️ 同名の広告が既に存在します: ${dup.join(", ")}`);

  const outcome: ResolveOutcome = {
    crPage,
    files: { parent, children },
    warnings,
  };

  const planBase: Omit<SubmitPlan, "adsetId" | "adsetName" | "sourceAdId" | "sourceAdName"> = {
    project: project.name,
    parentName,
    crKey,
    notionPageId: crPage.pageId,
    overrides: crPage.overrides,
    videos,
    hasChildren: children.length > 0,
    channelId: input.channelId,
    responseUrl: input.responseUrl,
    userId: input.userId,
  };

  if (usable.length === 1) {
    const c = usable[0];
    outcome.plan = {
      ...planBase,
      adsetId: c.id,
      adsetName: c.name,
      sourceAdId: c.latestAd!.id,
      sourceAdName: c.latestAd!.name,
    };
  } else {
    // 複数広告セット → Slackで選択させる（選択後に同じplanBaseへ確定値を埋める）
    outcome.plan = { ...planBase, adsetId: "", adsetName: "", sourceAdId: "", sourceAdName: "" };
    outcome.adsetCandidates = usable;
  }
  return outcome;
}

// ---- 命名ヘルパー ----

/** Meta広告名: 案件の慣習に合わせる（jde_mak系はフル名称） */
function adNameFor(project: SubmitProject, fileBaseName: string): string {
  if (project.adNameStyle === "short") {
    const m = fileBaseName.match(/cr\d+(?:_\d{2})?/i);
    return m ? m[0] : fileBaseName;
  }
  return fileBaseName; // full（既定）: Driveファイル名=Notionページ名 そのまま
}

/** 集計表表記: 先頭の案件コードを除去した cr{N}[_{XX}]_{説明} */
function sheetIdFor(fileBaseName: string): string {
  const i = fileBaseName.search(/cr\d/i);
  return i >= 0 ? fileBaseName.slice(i) : fileBaseName;
}

export function normalizeCrKey(s: string): string {
  const m = s.match(/(?:cr)?[_ ]?(\d+)/i);
  if (!m) throw new Error(`cr名として解釈できません: ${s}`);
  return `cr${m[1]}`;
}

function extractCrKey(name: string): string | null {
  const m = name.match(/cr\d+/i);
  return m ? m[0].toLowerCase() : null;
}

function stripExt(name: string): string {
  return name.replace(/\.[a-z0-9]+$/i, "");
}

function escapeReg(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
