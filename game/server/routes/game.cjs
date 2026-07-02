'use strict';
// 🎮 当たりCRシューター — スコアAPI & ゲーム配信ルーター
//
// video-material-matcher の server/routes/ にコピーして app.use() でマウントする。
// .cjs 拡張子なので、アプリ本体が CommonJS でも ESM でもそのまま読み込める。
//   CJS: app.use(require('./routes/game.cjs'));
//   ESM: import gameRouter from './routes/game.cjs'; app.use(gameRouter);
//
// 必要な環境変数:
//   NOTION_TOKEN          … 既存のものを流用
//   GAME_SCORES_DB_ID     … スコアDBのID(game/scripts/create-score-db.mjs で作成・取得)
//   SLACK_WEBHOOK_URL     … (任意)トップ3更新時の通知。未設定ならスキップ
//
// 依存: express のみ(アプリに既存)。Notion へは Node 18+ の global fetch で直接アクセス。

const express = require('express');
const path = require('path');

const router = express.Router();

const NOTION_API = 'https://api.notion.com/v1';
const NOTION_VERSION = '2022-06-28';
const DB_ID = (process.env.GAME_SCORES_DB_ID || '').trim();

const CACHE_TTL_MS = 60 * 1000; // Notionのレート制限(~3rps)対策
const POST_LIMIT = 5; // 1IPあたり
const POST_WINDOW_MS = 10 * 60 * 1000; // 10分
const MAX_NUM = 999999;
const MAX_WAVE = 99;
const MAX_SCORE_PER_WAVE = 25000; // 妥当性チェック: score <= wave * 25000
const TOOLS = ['素材選定くん', '自動命名くん', 'その他'];

// ---------------------------------------------------------------- utilities

function isConfigured() {
  return Boolean(DB_ID && process.env.NOTION_TOKEN);
}

// JSTの「今日」(YYYY-MM-DD)
function jstToday() {
  return new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 10);
}

// JSTで直近の月曜日(YYYY-MM-DD)。「今週」ランキングの起点
function jstWeekStart() {
  const now = new Date(Date.now() + 9 * 3600 * 1000);
  const sinceMonday = (now.getUTCDay() + 6) % 7; // 月曜=0
  const monday = new Date(now.getTime() - sinceMonday * 24 * 3600 * 1000);
  return monday.toISOString().slice(0, 10);
}

function clampInt(value, min, max) {
  const n = Math.round(Number(value));
  if (!Number.isFinite(n)) return null;
  return Math.max(min, Math.min(max, n));
}

async function notionFetch(pathname, body, method = 'POST') {
  const res = await fetch(NOTION_API + pathname, {
    method,
    headers: {
      Authorization: `Bearer ${process.env.NOTION_TOKEN}`,
      'Notion-Version': NOTION_VERSION,
      'Content-Type': 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    const err = new Error(`Notion API ${res.status}: ${text.slice(0, 300)}`);
    err.status = res.status;
    throw err;
  }
  return res.json();
}

function pageToScore(page) {
  const p = page.properties || {};
  const title = ((p['ニックネーム'] || {}).title || [])
    .map((t) => t.plain_text || '')
    .join('');
  return {
    nickname: title || '???',
    score: (p['スコア'] || {}).number || 0,
    wave: (p['ウェーブ'] || {}).number || 0,
    date: (((p['日付'] || {}).date) || {}).start || '',
  };
}

// スコア上位100件を取得(period: 'all' | 'week')
async function queryScores(period) {
  const body = {
    page_size: 100,
    sorts: [{ property: 'スコア', direction: 'descending' }],
  };
  if (period === 'week') {
    body.filter = { property: '日付', date: { on_or_after: jstWeekStart() } };
  }
  const data = await notionFetch(`/databases/${DB_ID}/query`, body);
  return (data.results || []).map(pageToScore);
}

// ------------------------------------------------------------------- cache

const cache = new Map(); // period -> { at, scores }

async function cachedScores(period) {
  const hit = cache.get(period);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.scores;
  const scores = await queryScores(period);
  cache.set(period, { at: Date.now(), scores });
  return scores;
}

// -------------------------------------------------------------- rate limit

const postLog = new Map(); // ip -> [timestamps]

function rateLimited(ip) {
  const now = Date.now();
  const log = (postLog.get(ip) || []).filter((t) => now - t < POST_WINDOW_MS);
  if (log.length >= POST_LIMIT) {
    postLog.set(ip, log);
    return true;
  }
  log.push(now);
  postLog.set(ip, log);
  // Map肥大化防止
  if (postLog.size > 1000) {
    for (const [k, v] of postLog) {
      if (!v.length || now - v[v.length - 1] > POST_WINDOW_MS) postLog.delete(k);
    }
  }
  return false;
}

function clientIp(req) {
  const fwd = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
  return fwd || req.ip || req.socket.remoteAddress || 'unknown';
}

// ------------------------------------------------------------------ routes

// ゲーム本体(自己完結HTML)。SPAのcatch-allより先にマウントすること!
router.get('/game', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'game.html'));
});

router.use('/api/game', express.json({ limit: '10kb' }));

// GET /api/game/scores?limit=10&period=all|week
router.get('/api/game/scores', async (req, res) => {
  const period = req.query.period === 'week' ? 'week' : 'all';
  const limit = clampInt(req.query.limit, 1, 25) || 10;
  if (!isConfigured()) {
    return res.json({ scores: [], period, offline: true });
  }
  try {
    const scores = await cachedScores(period);
    res.json({ scores: scores.slice(0, limit), period });
  } catch (err) {
    console.error('[game] leaderboard error:', err.message);
    res.status(502).json({ error: 'notion_error' });
  }
});

// POST /api/game/scores
// body: { nickname, score, wave, atari, koatari, kata, stopBonus, tool }
router.post('/api/game/scores', async (req, res) => {
  if (!isConfigured()) {
    return res
      .status(503)
      .json({ error: 'score_storage_not_configured', offline: true });
  }
  if (rateLimited(clientIp(req))) {
    return res.status(429).json({ error: 'too_many_requests' });
  }

  const body = req.body || {};
  const nickname = String(body.nickname || '')
    .replace(/[\u0000-\u001F\u007F]/g, "")
    .trim()
    .slice(0, 20);
  if (!nickname) {
    return res.status(400).json({ error: 'invalid_nickname' });
  }

  const score = clampInt(body.score, 0, MAX_NUM);
  const wave = clampInt(body.wave, 1, MAX_WAVE);
  if (score === null || wave === null) {
    return res.status(400).json({ error: 'invalid_score' });
  }
  if (score > wave * MAX_SCORE_PER_WAVE) {
    return res.status(400).json({ error: 'implausible_score' });
  }
  const counts = {};
  for (const key of ['atari', 'koatari', 'kata', 'stopBonus']) {
    counts[key] = clampInt(body[key], 0, MAX_NUM) || 0;
  }
  const tool = TOOLS.includes(body.tool) ? body.tool : 'その他';

  try {
    await notionFetch('/pages', {
      parent: { database_id: DB_ID },
      icon: { type: 'emoji', emoji: '🎮' },
      properties: {
        'ニックネーム': { title: [{ text: { content: nickname } }] },
        'スコア': { number: score },
        'ウェーブ': { number: wave },
        '当たり数': { number: counts.atari },
        '小当たり数': { number: counts.koatari },
        '型数': { number: counts.kata },
        '停止ボーナス': { number: counts.stopBonus },
        '日付': { date: { start: jstToday() } },
        'ツール': { select: { name: tool } },
      },
    });

    cache.clear();
    let rank = null;
    try {
      const all = await cachedScores('all');
      rank = all.filter((s) => s.score > score).length + 1;
    } catch (_) {
      /* rankは取れなくても保存は成功扱い */
    }

    if (rank !== null && rank <= 3 && process.env.SLACK_WEBHOOK_URL) {
      const medal = ['🥇', '🥈', '🥉'][rank - 1];
      fetch(process.env.SLACK_WEBHOOK_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          text: `🎮 当たりCRシューター: ${medal} *${nickname}* が ${score.toLocaleString('ja-JP')}点(WAVE ${wave})で全体${rank}位にランクイン!`,
        }),
      }).catch((err) => console.error('[game] slack notify failed:', err.message));
    }

    res.status(201).json({ ok: true, rank });
  } catch (err) {
    console.error('[game] save error:', err.message);
    res.status(502).json({ error: 'notion_error' });
  }
});

module.exports = router;
