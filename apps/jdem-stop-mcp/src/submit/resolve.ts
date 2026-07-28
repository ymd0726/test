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

/**
 * cr名検索でCRDBページ候補が複数残ったときに投げる（BUG-27）。
 * command.ts がcatchしてSlackにページ選択ボタンを表示する。
 */
export class CrPageAmbiguousError extends Error {
  candidates: { pageId: string; name: string }[];
  /** パターン指定（例 ["07","08"]）。ページ選択後の再解決でも維持するため持ち回る（BUG-101） */
  patterns: string[];
  /** 集計表だけモード（BUG-110）。ページ選択後の再解決でも維持する */
  sheetOnly: boolean;
  constructor(
    key: string,
    candidates: { pageId: string; name: string }[],
    patterns: string[] = [],
    sheetOnly = false
  ) {
    super(
      `Notion CRDBに「${key}」の候補が複数あります:\n${candidates.map((c) => `・${c.name}`).join("\n")}`
    );
    this.candidates = candidates;
    this.patterns = patterns;
    this.sheetOnly = sheetOnly;
  }
}

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
  // パターン指定（BUG-99）: 「cr47_07」「cr47 06 07」「cr47_06,07」「<NotionURL> 06」の形式で
  // 入稿対象パターンを絞り込める。省略時は従来どおりDriveで見つかった全パターンを入稿。
  // （実例: /cr-in hyd_cr47_07 と打ったのに全9パターンがプランに並んだ→_07だけにしたい）
  const tokens = input.text.trim().split(/[\s,、]+/).filter(Boolean);
  let arg = tokens[0] || "";
  if (!arg)
    throw new Error(
      "使い方: `/cr-in <cr名 または NotionページURL> [パターン番号…] [集計表]`（例: `/cr-in cr79` ／ 特定パターンのみ: `/cr-in cr79_06` や `/cr-in cr79 06 07` ／ 集計表だけ展開: `/cr-in cr79 集計表`）"
    );
  const selPatterns = new Set<string>();
  // 集計表だけモード（BUG-110）: 追加トークンに「集計表/シート/sheet」等があれば、
  // Meta入稿をスキップして集計表の展開だけ行う（Meta側は既に手動等で入稿済みのケース）。
  let sheetOnly = false;
  for (const t of tokens.slice(1)) {
    const pm = t.match(/^_?(\d{1,2})$/);
    if (pm) {
      selPatterns.add(pm[1].padStart(2, "0"));
      continue;
    }
    if (/^(集計表|集計|シート|sheet|sheetonly|シートのみ|集計表のみ)$/i.test(t)) sheetOnly = true;
  }
  if (!/notion\.(so|com)|app\.notion\.com|^[0-9a-f-]{32,36}$/i.test(arg)) {
    // cr名末尾の _NN はパターン指定として扱い、CRDB検索キーからは外す（cr47_07 / 47_07 両対応）
    const suf = arg.match(/^(.*?(?:cr)?\d+)_(\d{2})$/i);
    if (suf) {
      selPatterns.add(suf[2]);
      arg = suf[1];
    }
  }

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
    // CRDBは全案件共通DBのため、cr番号だけの検索では他案件の同番号crと衝突する。
    // チャンネル=案件が確定しているので「{案件プレフィックス}_{cr番号}」で検索して絞り込む
    // （cr停止くんと同じチャンネル=案件方式）。cr79/cr790 の混同は末尾条件(_|$|数字以外)で防ぐ。
    const prefixes = project.crdbNamePrefixes?.length ? project.crdbNamePrefixes : [project.name];
    const keyEnd = `${escapeReg(key)}(_|$|[^0-9])`;
    const byId = new Map<string, CrPageInfo>();
    for (const pre of prefixes) {
      const hits = await findCrPageByName(env.NOTION_TOKEN, project.crdbDataSourceId, `${pre}_${key}`);
      for (const h of hits) byId.set(h.pageId, h);
    }
    let exact = [...byId.values()].filter((h) =>
      prefixes.some((pre) => new RegExp(`^${escapeReg(pre)}_${keyEnd}`, "i").test(h.name))
    );
    if (exact.length === 0) {
      // 案件プレフィックス無しの旧命名ページ用フォールバック: 素のcr番号で検索（従来動作）
      const hits = await findCrPageByName(env.NOTION_TOKEN, project.crdbDataSourceId, key);
      exact = hits.filter((h) => new RegExp(keyEnd, "i").test(h.name));
    }
    if (exact.length === 0)
      throw new Error(
        `Notion CRDBに「${prefixes.map((p) => `${p}_${key}`).join(" / ")}」のページが見つかりません`
      );
    // 変則ページ（冒頭替え/パターン替え/Nパターン等）は入稿対象から除外する（BUG-23）。
    // 除外の結果1件に絞れればそのまま採用。全て変則ページだった場合は誤入稿せず明示エラー。
    // URL直指定（上の分岐）は除外しない＝変則ページを意図的に入稿したい場合はURLで指定する。
    const submittable = exact.filter((h) => isSubmittableCrName(h.name));
    if (submittable.length === 0)
      throw new Error(
        `「${key}」のCRDBページは変則ページ（冒頭替え/パターン替え/Nパターン等）のみでした:\n${exact.map((h) => `・${h.name}`).join("\n")}\n入稿対象のページをNotionページURLで指定してください`
      );
    if (submittable.length > 1)
      // 候補複数はSlack側でページ選択ボタンを出す（BUG-27）。command.tsがこの型をcatchして分岐
      throw new CrPageAmbiguousError(
        key,
        submittable.map((h) => ({ pageId: h.pageId, name: h.name })),
        [...selPatterns],
        sheetOnly
      );
    crPage = submittable[0];
  }

  const parentName = crPage.name; // 例: jde_mak_cr79_ブライダル訴求
  const crKey = extractCrKey(parentName); // cr79
  if (!crKey) throw new Error(`CRページ名からcr番号を特定できません: ${parentName}`);

  // 2. Drive ファイル
  const driveToken = await driveAccessToken(env.GOOGLE_SERVICE_ACCOUNT_JSON);
  // 親名の先頭部分（説明を除いた {案件}_{crKey}）でも拾えるように2段で検索
  const prefix = parentName.split(crKey)[0] + crKey; // 例: jde_mak_cr79

  let folderId: string;
  let all: DriveFile[];
  const sheetFolders = project.sheets.filter((s) => s.driveFolderId || s.driveFolderName);
  if (sheetFolders.length > 0) {
    // sheet単位のDriveフォルダ上書きがある案件（例: bla の face/body）。
    // 各フォルダでprefix検索し、一致したフォルダが複数あれば「別部位の同名cr」の誤爆を避けて中断する。
    const resolved = await Promise.all(
      sheetFolders.map(async (s) => {
        const fid = await resolveFolderId(driveToken, { folderId: s.driveFolderId, folderName: s.driveFolderName });
        const files = await listCreativeFiles(driveToken, fid, prefix);
        return { sheetName: s.sheetName || fid, folderId: fid, files };
      })
    );
    const withMatches = resolved.filter((r) => r.files.length > 0);
    if (withMatches.length > 1) {
      throw new Error(
        `複数のDriveフォルダ（${withMatches.map((w) => w.sheetName).join(" / ")}）で「${prefix}」が見つかりました。` +
          `あいまいなため中断します（NotionページURLで指定するか、sheet別Driveフォルダ設定を確認してください）`
      );
    }
    if (withMatches.length === 1) {
      folderId = withMatches[0].folderId;
      all = withMatches[0].files;
    } else {
      folderId = resolved[0]?.folderId || "";
      all = [];
    }
  } else {
    // 既存: project単位の単一Driveフォルダ。
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
    folderId = await resolveFolderId(driveToken, {
      folderId: configuredFolderId,
      folderName: project.driveFolderName,
    });
    all = await listCreativeFiles(driveToken, folderId, prefix);
  }
  const childPattern = new RegExp(`${escapeReg(crKey)}_(\\d{2})`, "i");
  let children = all
    .filter((f) => childPattern.test(f.name))
    .sort((a, b) => a.name.localeCompare(b.name, "ja"));
  const parent = all.find((f) => !childPattern.test(f.name));
  if (all.length === 0) {
    throw new Error(`Driveフォルダに「${prefix}」で始まる完成ファイルが見つかりません`);
  }
  if (!parent && children.length === 0) {
    throw new Error(`入稿対象ファイルを特定できません（検出: ${all.map((f) => f.name).join(", ")}）`);
  }
  // パターン指定があれば対象を絞り込む（BUG-99）。指定分が見つからなければ誤入稿せず明示エラー
  if (selPatterns.size > 0) {
    const want = [...selPatterns].sort();
    const nnOf = (f: DriveFile) => f.name.match(childPattern)?.[1];
    const filtered = children.filter((f) => selPatterns.has(nnOf(f) || ""));
    const foundNN = new Set(filtered.map((f) => nnOf(f)!));
    const missing = want.filter((n) => !foundNN.has(n));
    if (missing.length > 0) {
      throw new Error(
        `指定パターン（_${missing.join(", _")}）の完成ファイルがDriveに見つかりません` +
          (children.length
            ? `。検出済み: ${children.map((f) => f.name).join(", ")}`
            : `。この crにはパターンファイル（${crKey}_NN）がありません`)
      );
    }
    children = filtered;
    warnings.push(`ℹ️ パターン指定: _${want.join(", _")} のみを入稿します（他のパターンは対象外）`);
  }

  // 3. プラン組み立て（実際に入稿する動画 = 子があれば子、無ければ親）
  const dtargets: DriveFile[] = children.length > 0 ? children : parent ? [parent] : [];
  const videos: PlannedVideo[] = dtargets.map((f) => {
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

  // 集計表だけモード（BUG-110）: Meta候補の探索・広告セット選択を全てスキップし、
  // 集計表展開だけのプランを返す。metaAdAccountI未設定の案件でも集計表展開はできる。
  if (sheetOnly) {
    outcome.plan = {
      ...planBase,
      sheetOnly: true,
      adsetId: "",
      adsetName: "",
      campaignName: "",
      sourceAdId: "",
      sourceAdName: "",
    };
    return outcome;
  }

  // 4. Meta 広告セット候補
  if (!project.metaAdAccountId) throw new Error(`案件「${project.name}」にmetaAdAccountIdが未設定です`);
  const candidates = await listAdsetCandidates(project.metaAdAccountId, metaToken, project.adsetAllowlist);
  const usable = candidates.filter((c) => c.latestAd);
  if (usable.length === 0) {
    throw new Error(
      "コピー元にできる直近cr広告を持つ広告セットが見つかりません（直近7日間に消化のあるセット、無ければACTIVE全セットを探索）"
    );
  }

  // 冪等性チェック: 同名広告が既にあれば警告
  const dup = await findAdsByExactName(
    project.metaAdAccountId,
    metaToken,
    videos.map((v) => v.adName)
  );
  if (dup.length > 0) warnings.push(`⚠️ 同名の広告が既に存在します: ${dup.join(", ")}`);

  if (usable.length === 1) {
    const c = usable[0];
    outcome.plan = {
      ...planBase,
      adsetId: c.id,
      adsetName: c.name,
      campaignName: c.campaignName,
      sourceAdId: c.latestAd!.id,
      sourceAdName: c.latestAd!.name,
    };
  } else {
    // 複数広告セット → Slackで選択させる（選択後に同じplanBaseへ確定値を埋める）
    outcome.plan = { ...planBase, adsetId: "", adsetName: "", campaignName: "", sourceAdId: "", sourceAdName: "" };
    outcome.adsetCandidates = usable;
  }
  return outcome;
}

// ---- 命名ヘルパー ----

/**
 * CRDBページ名がcr名検索の入稿対象になるか（BUG-23）。
 * 「冒頭替え」「パターン替え」「3パターン」等の変則・派生案内ページは対象外にする。
 * 新しい変則表記が見つかったらここに追記していく。
 */
const CRDB_NAME_EXCLUDES: RegExp[] = [
  /冒頭替え/,
  /パターン替え/,
  /[0-9０-９]+\s*パターン/, // 例: 3パターン / ３パターン
  /[nｎN]\s*パターン/, // 例: nパターン（数の伏せ字表記）
];

export function isSubmittableCrName(name: string): boolean {
  return !CRDB_NAME_EXCLUDES.some((re) => re.test(name));
}

/** Meta広告名: 案件の慣習に合わせる（jde_mak系はフル名称） */
function adNameFor(project: SubmitProject, fileBaseName: string): string {
  if (project.adNameStyle === "short") {
    const m = fileBaseName.match(/cr\d+(?:_\d{2})?/i);
    return m ? m[0] : fileBaseName;
  }
  return fileBaseName; // full（既定）: Driveファイル名=Notionページ名 そのまま
}

/** 集計表表記: cr番号（+パターン番号）のみ。例 cr82 / cr79_01。説明は付けない（jde_mak要望 2026-07-06） */
function sheetIdFor(fileBaseName: string): string {
  const m = fileBaseName.match(/cr\d+(?:_\d{2})?/i);
  return m ? m[0].toLowerCase() : fileBaseName;
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
