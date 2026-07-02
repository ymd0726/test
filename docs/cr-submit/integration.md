# 既存Worker（jdem-stop-mcp）への結合手順

既存 `src/index.ts` に以下を追記する（既存構造に合わせて調整。追記は3箇所＋レジストリ拡張のみ）。

## 1. import

```ts
import { handleCrInCommand, handleCrInInteraction } from "./submit/command";
import { handleContinue, CONTINUE_PATH } from "./submit/continuation";
import type { SubmitProject, SubmitEnv } from "./submit/types";
```

## 2. /slack/command のルーティングに追加

既存のスラッシュコマンド分岐（`/cr-stop` / `/cr-undo`）に1分岐追加:

```ts
if (form.get("command") === "/cr-in") {
  const project = findProjectByChannel(form.get("channel_id")); // 既存のchannel→案件解決を流用
  return handleCrInCommand(
    {
      text: String(form.get("text") || ""),
      channel_id: String(form.get("channel_id")),
      user_id: String(form.get("user_id")),
      response_url: String(form.get("response_url")),
    },
    project as SubmitProject,
    env as unknown as SubmitEnv,
    ctx,
    (p) => metaTokenFor(p) // 既存: metaTokenSecret があれば env[それ]、無ければ META_ACCESS_TOKEN
  );
}
```

## 3. /slack/interact のルーティングに追加

既存の即200ACK＋response_url方式のまま、`action_id` プレフィックスで振り分け:

```ts
const actionId = payload.actions?.[0]?.action_id || "";
if (actionId.startsWith("crin_")) {
  const channelId = payload.channel?.id || payload.container?.channel_id;
  const project = findProjectByChannel(channelId);
  return handleCrInInteraction(
    payload,
    project as SubmitProject,
    env as unknown as SubmitEnv,
    ctx,
    (p) => metaTokenFor(p),
    (p) => p.sheets // gasTargetsFor: 初期はmeta系1タブのみ（sheets[]をそのまま）
  );
}
```

## 4. continuation エンドポイント

fetchハンドラのルーティングに追加（Slack署名は不要。HMAC署名で自己検証する）:

```ts
if (url.pathname === CONTINUE_PATH && request.method === "POST") {
  return handleContinue(
    request,
    env as unknown as SubmitEnv,
    ctx,
    (projectName) => metaTokenFor(findProjectByName(projectName)),
    (projectName) => findProjectByName(projectName).sheets,
    (projectName) => findProjectByName(projectName).metaAdAccountId!
  );
}
```

## 5. PROJECTS レジストリの拡張

対象案件のエントリに入稿用フィールドを追加（`SubmitProject` 型）:

```ts
driveFolderName: "cr_jde",          // または driveFolderId
crdbDataSourceId: "2c155406-c36d-4d7d-9d2a-22aefd4f17cf",
adNameStyle: "full",
adsetAllowlist: ["<入稿先候補にする広告セットID>"], // 省略可（省略時はACTIVE全セットが候補）
```

## 6. シークレット追加とデプロイ

```bash
wrangler secret put GOOGLE_SERVICE_ACCOUNT_JSON   # ads-reader@... のJSON全文
wrangler secret put SELF_URL                      # https://jdem-stop-mcp.lead1504.workers.dev
npm run deploy
```

## 7. 共通GAS

`gas/submitCreative_common.gs` をGASプロジェクトに追加し、既存doPostに追記:

```js
if (req.action === 'submitCreative') return jsonOut(handleSubmitCreative(req));
if (req.action === 'submitUndo')     return jsonOut(handleSubmitUndo(req));
```

→ **「デプロイを管理 → 新バージョン」**でデプロイ（新規デプロイにするとURLが変わるので注意。既知のハマりどころ）

## 8. Slackアプリ

アプリ「cr停止」→ Slash Commands → `/cr-in` を追加（Request URL: `https://jdem-stop-mcp.lead1504.workers.dev/slack/command`）。
対象チャンネル（例: #z-n22_jde_kk_mak）にBotが招待済みであることを確認。
