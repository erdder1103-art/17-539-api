try { require('dotenv').config(); } catch(e) { console.log('dotenv optional'); }

const express = require('express');
const fetch = require('node-fetch');
const cheerio = require('cheerio');
const fs = require('fs');
const path = require('path');
const { confirmTracking } = require('./trackingService');
const { sendTelegramMessage } = require('./telegram');
const { processLatestDraw, getResultHistory } = require('./resultService');
const { getWeeklyStats, buildWeeklyStatsMessage } = require('./weekStats');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json({ limit: '1mb' }));
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') {
    return res.sendStatus(200);
  }
  next();
});

app.use(express.static('public'));

let cache539 = [];
let cacheTTL = [];
let lastUpdate = null;

function pad2(n) {
  return String(Number(n)).padStart(2, '0');
}

function isValidFive(nums) {
  if (!Array.isArray(nums) || nums.length !== 5) return false;
  const arr = nums.map(n => Number(n));
  if (arr.some(n => !Number.isInteger(n) || n < 1 || n > 39)) return false;
  return new Set(arr).size === 5;
}

function dedupe(list) {
  const map = new Map();
  for (const item of list) {
    const key = `${item.issue}|${item.date}|${item.numbers.join('-')}`;
    if (!map.has(key)) map.set(key, item);
  }
  return Array.from(map.values());
}

async function fetchPage(url) {
  const res = await fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0',
      'Accept-Language': 'zh-TW,zh;q=0.9,en;q=0.8'
    }
  });

  if (!res.ok) throw new Error(`HTTP ${res.status}`);

  const html = await res.text();
  if (!html || html.length < 1000) {
    throw new Error('HTML 過短，疑似未正常抓到頁面');
  }
  return html;
}

function htmlToText(html) {
  const $ = cheerio.load(html);
  return $('body')
    .text()
    .replace(/\r/g, '\n')
    .replace(/\u00a0/g, ' ')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{2,}/g, '\n')
    .trim();
}

function saveDebugFile(name, content) {
  const p = path.join(__dirname, name);
  fs.writeFileSync(p, content, 'utf8');
}

function parse539(html) {
  const text = htmlToText(html);
  const results = [];

  saveDebugFile('debug-539.txt', text);

  const regex = /第\s*(\d+)\s*期[\s\S]{0,120}?(\d{4}-\d{2}-\d{2})[\s\S]{0,80}?落球[\s\S]{0,40}?(\d{1,2})[\s\S]{0,12}?(\d{1,2})[\s\S]{0,12}?(\d{1,2})[\s\S]{0,12}?(\d{1,2})[\s\S]{0,12}?(\d{1,2})[\s\S]{0,40}?大小/g;

  let m;
  while ((m = regex.exec(text)) !== null) {
    const issue = m[1] || '';
    const date = (m[2] || '').replace(/-/g, '/');
    const nums = [m[3], m[4], m[5], m[6], m[7]].map(Number);
    if (!isValidFive(nums)) continue;
    results.push({ issue, date, numbers: nums.map(pad2) });
  }

  return dedupe(results).slice(0, 50);
}

function parseTTL(html) {
  const text = htmlToText(html);
  const results = [];

  saveDebugFile('debug-ttl.txt', text);

  const regex = /第\s*(\d+)\s*期[\s\S]{0,120}?(\d{4}-\d{2}-\d{2})[\s\S]{0,50}?(\d{1,2})[\s\S]{0,12}?(\d{1,2})[\s\S]{0,12}?(\d{1,2})[\s\S]{0,12}?(\d{1,2})[\s\S]{0,12}?(\d{1,2})(?=[\s\S]{0,80}?第\s*\d+\s*期|[\s\S]*$)/g;

  let m;
  while ((m = regex.exec(text)) !== null) {
    const issue = m[1] || '';
    const date = (m[2] || '').replace(/-/g, '/');
    const nums = [m[3], m[4], m[5], m[6], m[7]].map(Number);
    if (!isValidFive(nums)) continue;
    results.push({ issue, date, numbers: nums.map(pad2) });
  }

  return dedupe(results).slice(0, 50);
}

async function update539() {
  for (let i = 0; i < 3; i++) {
    try {
      const html = await fetchPage('https://sc888.net/index.php?s=/LotteryFtn/index');
      const list = parse539(html);
      if (list.length > 0) {
        cache539 = list;
        console.log(`539 更新成功：${list.length} 筆`);
        return;
      }
    } catch (e) {
      console.log(`539 第 ${i + 1} 次更新失敗：`, e.message);
    }
  }
  console.log('539 三次重試後仍失敗，保留舊資料');
}

async function updateTTL() {
  for (let i = 0; i < 3; i++) {
    try {
      const html = await fetchPage('https://sc888.net/index.php?s=/LotteryFan/index');
      const list = parseTTL(html);
      if (list.length > 0) {
        cacheTTL = list;
        console.log(`TTL 更新成功：${list.length} 筆`);
        return;
      }
    } catch (e) {
      console.log(`TTL 第 ${i + 1} 次更新失敗：`, e.message);
    }
  }
  console.log('TTL 三次重試後仍失敗，保留舊資料');
}

async function updateAll() {
  await update539();
  await updateTTL();

  if (cache539[0]) {
    await processLatestDraw('539', cache539[0]);
  }
  if (cacheTTL[0]) {
    await processLatestDraw('ttl', cacheTTL[0]);
  }

  lastUpdate = new Date().toISOString();
  console.log('最後更新：', lastUpdate);
}

app.get('/api/539', (req, res) => {
  res.json({ game: '539', updated: lastUpdate, count: cache539.length, draws: cache539 });
});

app.get('/api/ttl', (req, res) => {
  res.json({ game: 'ttl', updated: lastUpdate, count: cacheTTL.length, draws: cacheTTL });
});

app.get('/api/all', (req, res) => {
  res.json({
    updated: lastUpdate,
    lotto539: { count: cache539.length, draws: cache539 },
    ttl: { count: cacheTTL.length, draws: cacheTTL }
  });
});


app.get('/api/weekly/:type', (req, res) => {
  try {
    const type = req.params.type === 'ttl' ? 'ttl' : '539';
    res.json({
      ok: true,
      type,
      stats: getWeeklyStats(type),
      message: buildWeeklyStatsMessage(type)
    });
  } catch (err) {
    res.status(400).json({ ok: false, message: err.message });
  }
});

app.get('/api/history/:type', (req, res) => {
  try {
    const type = req.params.type === 'ttl' ? 'ttl' : '539';
    res.json({
      ok: true,
      type,
      count: getResultHistory(type).length,
      results: getResultHistory(type)
    });
  } catch (err) {
    res.status(400).json({ ok: false, message: err.message });
  }
});

app.get('/api/health', (req, res) => {
  res.json({ ok: true, updated: lastUpdate });
});

app.post('/api/confirm-tracking', async (req, res) => {
  try {
    const result = await confirmTracking(req.body || {});
    res.json(result);
  } catch (err) {
    console.error('confirm-tracking error:', err.message);
    res.status(400).json({ ok: false, message: err.message });
  }
});

app.post('/api/test-telegram', async (req, res) => {
  try {
    const text = (req.body && req.body.text) || 'TG Bot 測試成功';
    const data = await sendTelegramMessage(text);
    res.json({ ok: true, data });
  } catch (err) {
    res.status(400).json({ ok: false, message: err.message });
  }
});

app.listen(PORT, async () => {
  console.log(`API Server running http://localhost:${PORT}`);
  await updateAll();
  setInterval(updateAll, 120 * 1000);
});
