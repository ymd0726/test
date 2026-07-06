// BUG-14 対応: マッチング結果をカット番号順(カット1→N)で並べる純粋関数群。
//
// 課題:
//   素材選定くん(TOOL-24) v1.1 は「低信頼度を先頭ソート」を入れたため、
//   マッチング結果一覧の並び順が "カット順" から "信頼度昇順" に置き換わった。
//   → 山田さんの要望「カット1から順番に並べてほしい」に反する。
//
// 方針:
//   - 既定の表示順を「カット番号昇順」に戻す(sortMatchesByCut)。
//   - v1.1 の「低信頼度を先に確認したい」利点は失わないよう、
//     並びは崩さず "要確認バッジ/色" で強調する運用に寄せる(論点C=パターンB)。
//   - どうしても低信頼度先頭を使いたい画面向けに mode 切替も用意(sortMatches)。
//
// ネットワークに触れない純粋関数のみ(テスト可能)。

/**
 * ラベル文字列からカット番号を抽出する。
 * 対応: "カット03" "カット3" "cut03" "cut 3" "C03" "#3" "3カット目" など。
 * @param {unknown} label
 * @returns {number|null}
 */
export function parseCutNumber(label) {
  if (label == null) return null;
  const s = String(label);
  // 接頭辞つき(カット/cut/c/#)を優先
  const m = s.match(/(?:カット|cut|c|#)\s*0*(\d+)/i);
  if (m) return Number(m[1]);
  // フォールバック: 最初に現れる数字
  const m2 = s.match(/0*(\d+)/);
  return m2 ? Number(m2[1]) : null;
}

/**
 * マッチ1件からソートキー(カット番号)を得る。
 * 数値フィールドがあれば最優先、無ければラベル類から抽出。
 * 不明な場合は +Infinity(末尾へ)。
 * @param {Record<string, unknown>} match
 * @returns {number}
 */
export function cutOrderKey(match) {
  if (match && typeof match === "object") {
    for (const k of ["cutIndex", "cutNo", "cutNumber", "index", "order"]) {
      const v = match[k];
      if (typeof v === "number" && Number.isFinite(v)) return v;
    }
    for (const k of ["cut", "cutLabel", "label", "name", "title"]) {
      const n = parseCutNumber(match[k]);
      if (n != null) return n;
    }
  }
  return Number.POSITIVE_INFINITY;
}

/**
 * マッチング結果をカット番号昇順で並べる(安定ソート)。
 * 同番号・不明は元の順序を保つ。元配列は変更しない。
 * @template T
 * @param {T[]} matches
 * @returns {T[]}
 */
export function sortMatchesByCut(matches) {
  if (!Array.isArray(matches)) return [];
  return matches
    .map((m, i) => ({ m, i }))
    .sort((a, b) => {
      const ka = cutOrderKey(a.m);
      const kb = cutOrderKey(b.m);
      if (ka !== kb) return ka - kb;
      return a.i - b.i; // 安定化(タイブレーク)
    })
    .map((x) => x.m);
}

/**
 * 数値信頼度を 0..1 に正規化(0..100 表記も許容)。無ければ +Infinity 扱い。
 * @param {Record<string, unknown>} match
 * @returns {number}
 */
function confidenceKey(match) {
  const v = match?.confidence ?? match?.score ?? match?.conf;
  if (typeof v !== "number" || !Number.isFinite(v)) return Number.POSITIVE_INFINITY;
  return v > 1 ? v / 100 : v;
}

/**
 * 表示用ソートのエントリポイント。
 * - mode="cut"(既定): カット番号順(BUG-14の要望)
 * - mode="review": 低信頼度先頭(旧v1.1挙動)。同信頼度内はカット順で安定化。
 * @template T
 * @param {T[]} matches
 * @param {"cut"|"review"} [mode]
 * @returns {T[]}
 */
export function sortMatches(matches, mode = "cut") {
  if (!Array.isArray(matches)) return [];
  if (mode === "review") {
    return matches
      .map((m, i) => ({ m, i }))
      .sort((a, b) => {
        const ca = confidenceKey(a.m);
        const cb = confidenceKey(b.m);
        if (ca !== cb) return ca - cb; // 低信頼度が先頭
        const ka = cutOrderKey(a.m);
        const kb = cutOrderKey(b.m);
        if (ka !== kb) return ka - kb; // 同信頼度はカット順
        return a.i - b.i;
      })
      .map((x) => x.m);
  }
  return sortMatchesByCut(matches);
}
