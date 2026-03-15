try { require('dotenv').config(); } catch(e) { console.log('dotenv optional'); }

const express = require('express');
const fetch = require('node-fetch');
const cheerio = require('cheerio');
const fs = require('fs');
const path = require('path');
const { confirmTracking } = require('./trackingService');
const { sendTelegramMessage } = require('./telegram');
const { getActiveTracking } = require('./trackingStore');
const { processTrackingResult, getResultHistory } = require('./resultService');
const { getWeights, summarizeWeights } = require('./learningEngine');
const { buildWeeklySummaryText, getWeeklyStats, getWeeklyByWeek, listWeeklyHistory } = require('./weekStats');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json({ limit: '1mb' }));
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
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
  if (!html || html.length < 1000) throw new Error('HTML 過短，疑似未正常抓到頁面');
  return html;
}

function htmlToText(html) {
  const $ = cheerio.load(html);
  return $('body').text()
    .replace(/\r/g, '\n')
    .replace(/\u00a0/g, ' ')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{2,}/g, '\n')
    .trim();
}

function saveDebugFile(name, content) {
  fs.writeFileSync(path.join(__dirname, name), content, 'utf8');
}

function parse539(html) {
  const text = htmlToText(html);
  saveDebugFile('debug-539.txt', text);
  const results = [];
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
  saveDebugFile('debug-ttl.txt', text);
  const results = [];
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

async function handleAutoCheck(type, title, list) {
  if (!Array.isArray(list) || !list.length) return;
  const latest = list[0];
  const tracking = getActiveTracking(type);
  if (!tracking) return;

  try {
    const issueKey = `${latest.issue}|${latest.date}|${latest.numbers.join('-')}`;
    await processTrackingResult(type, title, latest.numbers, tracking, issueKey);
    console.log(`${title} 自動核對完成：${issueKey}`);
  } catch (err) {
    console.error(`${title} 自動核對失敗：`, err.message);
  }
}

async function update539() {
  for (let i = 0; i < 3; i++) {
    try {
      const html = await fetchPage('https://sc888.net/index.php?s=/LotteryFtn/index');
      const list = parse539(html);
      if (list.length > 0) {
        const oldIssue = cache539[0] ? `${cache539[0].issue}|${cache539[0].date}|${cache539[0].numbers.join('-')}` : null;
        const newIssue = `${list[0].issue}|${list[0].date}|${list[0].numbers.join('-')}`;
        cache539 = list;
        console.log(`539 更新成功：${list.length} 筆`);
        if (oldIssue !== newIssue) await handleAutoCheck('539', '539', list);
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
        const oldIssue = cacheTTL[0] ? `${cacheTTL[0].issue}|${cacheTTL[0].date}|${cacheTTL[0].numbers.join('-')}` : null;
        const newIssue = `${list[0].issue}|${list[0].date}|${list[0].numbers.join('-')}`;
        cacheTTL = list;
        console.log(`TTL 更新成功：${list.length} 筆`);
        if (oldIssue !== newIssue) await handleAutoCheck('ttl', '天天樂', list);
        return;
      }
    } catch (e) {
      console.log(`TTL 第 ${i + 1} 次更新失敗：`, e.message);
    }
  }
  console.log('TTL 三次重試後仍失敗，保留舊資料');
}

async function updateAll() {
  await Promise.all([update539(), updateTTL()]);
  lastUpdate = new Date().toISOString();
  console.log('最後更新：', lastUpdate);
}

app.get('/api/539', (req, res) => res.json({ game: '539', updated: lastUpdate, count: cache539.length, draws: cache539 }));
app.get('/api/ttl', (req, res) => res.json({ game: 'ttl', updated: lastUpdate, count: cacheTTL.length, draws: cacheTTL }));
app.get('/api/all', (req, res) => res.json({ updated: lastUpdate, lotto539: { count: cache539.length, draws: cache539 }, ttl: { count: cacheTTL.length, draws: cacheTTL } }));
app.get('/api/health', (req, res) => res.json({ ok: true, updated: lastUpdate }));
app.get('/api/weekly/539', (req, res) => res.json({ ok: true, weekly: getWeeklyStats('539'), text: buildWeeklySummaryText('539') }));
app.get('/api/weekly/ttl', (req, res) => res.json({ ok: true, weekly: getWeeklyStats('ttl'), text: buildWeeklySummaryText('ttl') }));

app.get('/api/weekly-history/:type', (req, res) => {
  const type = req.params.type === 'ttl' ? 'ttl' : '539';
  res.json({ ok: true, weeks: listWeeklyHistory(type) });
});

app.get('/api/weekly/:type/:week', (req, res) => {
  const type = req.params.type === 'ttl' ? 'ttl' : '539';
  const weekly = getWeeklyByWeek(type, req.params.week);
  if (!weekly) return res.status(404).json({ ok: false, message: '找不到指定週別資料' });
  res.json({ ok: true, weekly, text: buildWeeklySummaryText(type, weekly) });
});

app.get('/api/history/539', (req, res) => res.json({ ok: true, rows: getResultHistory('539') }));
app.get('/api/history/ttl', (req, res) => res.json({ ok: true, rows: getResultHistory('ttl') }));

app.get('/api/learning/:type', (req, res) => {
  const type = req.params.type === 'ttl' ? 'ttl' : '539';
  res.json({ ok: true, weights: getWeights(type), summary: summarizeWeights(type) });
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
    const data = await sendTelegramMessage(text, { timeoutMs: 8000 });
    res.json({ ok: true, data });
  } catch (err) {
    res.status(400).json({ ok: false, message: err.message });
  }
});

app.post('/api/notify-weekly/:type', async (req, res) => {
  try {
    const type = req.params.type === 'ttl' ? 'ttl' : '539';
    const weekly = req.body && req.body.week ? getWeeklyByWeek(type, req.body.week) : getWeeklyStats(type);
    if (!weekly) throw new Error('找不到指定週別資料');
    const text = buildWeeklySummaryText(type, weekly);
    await sendTelegramMessage(text, { timeoutMs: 8000 });
    res.json({ ok: true, text });
  } catch (err) {
    res.status(400).json({ ok: false, message: err.message });
  }
});

app.post('/api/notify-weekly/all', async (req, res) => {
  try {
    const text539 = buildWeeklySummaryText('539');
    const textTtl = buildWeeklySummaryText('ttl');
    await sendTelegramMessage(text539, { timeoutMs: 8000 });
    await sendTelegramMessage(textTtl, { timeoutMs: 8000 });
    res.json({ ok: true, sent: ['539', 'ttl'] });
  } catch (err) {
    res.status(400).json({ ok: false, message: err.message });
  }
});

app.listen(PORT, async () => {
  console.log(`API Server running http://localhost:${PORT}`);
  await updateAll();
  setInterval(updateAll, 120 * 1000);
});
