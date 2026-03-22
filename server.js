try { require('dotenv').config(); } catch(e) { console.log('dotenv optional'); }

const express = require('express');
const fetch = require('node-fetch');
const cheerio = require('cheerio');
const fs = require('fs');
const path = require('path');
const { confirmTracking, confirmManualTracking, cancelTracking, getTrackingOverview, recalculateTrackingAnalysis } = require('./trackingService');
const { getActiveTrackings, getTrackingById } = require('./trackingStore');
const { processTrackingResult, processTrackingNow, getResultHistory, getLearningState, getRecommendations, getRangeSummary, compareActiveTrackings, buildNextIssue } = require('./resultService');
const { buildWeeklySummaryText, getWeeklyStats } = require('./weekStats');
const { formatTaipeiDateTime } = require('./utils/time');
const { getBotRuntimeSummary, testTelegramSend, callTelegram, broadcastTelegramMessage } = require('./telegram');
const { startBotInteraction, getBotInteractionState } = require('./botInteraction');
const { readBotConfig, writeBotConfig } = require('./botConfigStore');
const { ACTIVE_DATA_DIR, DEFAULT_VOLUME_DIR, LOCAL_DATA_DIR, initializeDataFiles, getStorageDebug, getDataFile, readJsonSafe, writeJsonAtomic } = require('./dataPaths');

const app = express();
const PORT = process.env.PORT || 3000;
const storageInit = initializeDataFiles();

app.use(express.json({ limit: '35mb' }));
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type');
  if (req.path.startsWith('/api/')) {
    res.header('Cache-Control', 'no-store');
  }
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

app.use('/assets', express.static(path.join(__dirname, 'assets')));
app.get('/', (req, res) => {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
  res.sendFile(path.join(__dirname, 'index.html'));
});
app.get('/index.html', (req, res) => {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
  res.sendFile(path.join(__dirname, 'index.html'));
});

let cache539 = [];
let cacheTTL = [];
let lastUpdate = null;
let isUpdating = false;
let updateTimer = null;
const UPDATE_INTERVAL_MS = 30 * 1000;
const DRAW_HISTORY_LIMIT = 100;
const syncState = {
  intervalMs: UPDATE_INTERVAL_MS,
  startedAt: formatTaipeiDateTime(),
  runCount: 0,
  successCount: 0,
  failureCount: 0,
  consecutiveFailures: 0,
  lastStartedAt: '',
  lastFinishedAt: '',
  lastSuccessAt: '',
  lastError: '',
  lastDurationMs: 0
};

function pad2(n) { return String(Number(n)).padStart(2, '0'); }
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
  return $('body').text().replace(/\r/g, '\n').replace(/\u00a0/g, ' ').replace(/[ \t]+/g, ' ').replace(/\n{2,}/g, '\n').trim();
}
function saveDebugFile(name, content) { fs.writeFileSync(path.join(__dirname, name), content, 'utf8'); }
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
  return dedupe(results).slice(0, DRAW_HISTORY_LIMIT);
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
  return dedupe(results).slice(0, DRAW_HISTORY_LIMIT);
}
async function handleAutoCheck(type, title, list) {
  if (!Array.isArray(list) || !list.length) return;
  const latest = list[0];
  const trackingList = getActiveTrackings(type);
  if (!trackingList.length) return;
  try {
    const issueKey = `${latest.issue}|${latest.date}|${latest.numbers.join('-')}`;
    await processTrackingResult(type, title, latest.numbers, issueKey);
    console.log(`${title} 自動核對完成：${issueKey}`);
  } catch (err) {
    console.error(`${title} 自動核對失敗：`, err.message);
  }
}
async function update539() {
  let lastErr = null;
  for (let i = 0; i < 3; i++) {
    try {
      const html = await fetchPage('https://sc888.net/index.php?s=/LotteryFtn/index');
      const list = parse539(html);
      if (!list.length) throw new Error('539 未解析到有效資料');
      const oldIssue = cache539[0] ? `${cache539[0].issue}|${cache539[0].date}|${cache539[0].numbers.join('-')}` : null;
      const newIssue = `${list[0].issue}|${list[0].date}|${list[0].numbers.join('-')}`;
      cache539 = list;
      if (oldIssue !== newIssue) await handleAutoCheck('539', '539', list);
      return true;
    } catch (e) { lastErr = e; console.log(`539 第 ${i + 1} 次更新失敗：`, e.message); }
  }
  throw lastErr || new Error('539 更新失敗');
}
async function updateTTL() {
  let lastErr = null;
  for (let i = 0; i < 3; i++) {
    try {
      const html = await fetchPage('https://sc888.net/index.php?s=/LotteryFan/index');
      const list = parseTTL(html);
      if (!list.length) throw new Error('天天樂 未解析到有效資料');
      const oldIssue = cacheTTL[0] ? `${cacheTTL[0].issue}|${cacheTTL[0].date}|${cacheTTL[0].numbers.join('-')}` : null;
      const newIssue = `${list[0].issue}|${list[0].date}|${list[0].numbers.join('-')}`;
      cacheTTL = list;
      if (oldIssue !== newIssue) await handleAutoCheck('ttl', '天天樂', list);
      return true;
    } catch (e) { lastErr = e; console.log(`TTL 第 ${i + 1} 次更新失敗：`, e.message); }
  }
  throw lastErr || new Error('天天樂 更新失敗');
}
async function updateAll() {
  if (isUpdating) return { skipped: true, reason: 'busy' };
  isUpdating = true;
  const startedAt = Date.now();
  syncState.runCount += 1;
  syncState.lastStartedAt = formatTaipeiDateTime();
  try {
    await Promise.all([update539(), updateTTL()]);
    lastUpdate = formatTaipeiDateTime();
    syncState.successCount += 1;
    syncState.consecutiveFailures = 0;
    syncState.lastSuccessAt = lastUpdate;
    syncState.lastError = '';
    return { ok: true, updated: lastUpdate };
  } catch (err) {
    syncState.failureCount += 1;
    syncState.consecutiveFailures += 1;
    syncState.lastError = err.message;
    throw err;
  } finally {
    syncState.lastFinishedAt = formatTaipeiDateTime();
    syncState.lastDurationMs = Date.now() - startedAt;
    isUpdating = false;
  }
}


function getLatestIssueByType(type) {
  const key = type === 'ttl' ? 'ttl' : '539';
  const list = key === 'ttl' ? cacheTTL : cache539;
  return list[0] ? String(list[0].issue || '') : '';
}
function getLatestDrawByType(type) {
  const key = type === 'ttl' ? 'ttl' : '539';
  const list = key === 'ttl' ? cacheTTL : cache539;
  return list[0] || null;
}

function withIssueContext(body = {}) {
  const lotteryType = body.lotteryType === 'ttl' ? 'ttl' : '539';
  const latestIssue = getLatestIssueByType(lotteryType);
  return {
    ...body,
    lotteryType,
    latestIssue,
    baseIssue: body.baseIssue || latestIssue,
    startFromIssue: body.startFromIssue || (body.baseIssue || latestIssue)
  };
}


function ensureSeedTrackingRecord() {
  try {
    const trackingFile = getDataFile('tracking.json');
    const trackingMap = readJsonSafe(trackingFile, { '539': { system: null, manuals: [] }, 'ttl': { system: null, manuals: [] } });
    trackingMap.ttl = trackingMap.ttl || { system: null, manuals: [] };
    if (trackingMap.ttl.system) return { restored: false, reason: 'ttl-system-exists' };
    trackingMap.ttl.system = {
      id: 'ttl_system_20260319212117_seed11821',
      lotteryType: 'ttl',
      lotteryTitle: '天天樂',
      confirmedAt: '2026-03-19 21:21:17',
      createdAt: '2026-03-19 21:21:17',
      baseIssue: '11820',
      startFromIssue: '11821',
      status: 'pending',
      trackType: 'system',
      sourceName: '防2/3碰撞追蹤',
      labels: { group1:'第一組', group2:'第二組', group3:'第三組', group4:'第四組', full:'全車號碼' },
      groups: {
        group1: ['04','06','08','20','31'],
        group2: ['02','12','21','28','38'],
        group3: ['05','14','17','30','36'],
        group4: ['07','10','16','23','24'],
        full: ['01','03','09','11','13','15','18','19','22','25','26','27','29','32','33','34','35','37','39']
      },
      analysis: null
    };
    writeJsonAtomic(trackingFile, trackingMap);
    return { restored: true, trackingId: trackingMap.ttl.system.id };
  } catch (err) {
    return { restored: false, error: err.message };
  }
}

function scheduleNextUpdate() {
  if (updateTimer) clearTimeout(updateTimer);
  updateTimer = setTimeout(async () => {
    try {
      await updateAll();
    } catch (err) {
      console.error('updateAll failed:', err.message);
    } finally {
      scheduleNextUpdate();
    }
  }, UPDATE_INTERVAL_MS);
}

app.get('/api/539', (req, res) => res.json({ game: '539', updated: lastUpdate, timezone: 'Asia/Taipei', count: cache539.length, draws: cache539 }));
app.get('/api/ttl', (req, res) => res.json({ game: 'ttl', updated: lastUpdate, timezone: 'Asia/Taipei', count: cacheTTL.length, draws: cacheTTL }));
app.get('/api/all', (req, res) => res.json({ updated: lastUpdate, timezone: 'Asia/Taipei', lotto539: { count: cache539.length, draws: cache539 }, ttl: { count: cacheTTL.length, draws: cacheTTL } }));
function getHealthSnapshot() {
  return {
    ok: true,
    updated: lastUpdate,
    timezone: 'Asia/Taipei',
    isUpdating,
    sync: syncState,
    telegram: getBotRuntimeSummary(),
    botInteraction: getBotInteractionState(),
    storage: {
      dataDir: ACTIVE_DATA_DIR,
      defaultVolumeDir: DEFAULT_VOLUME_DIR,
      localDataDir: LOCAL_DATA_DIR,
      volumeMounted: ACTIVE_DATA_DIR === DEFAULT_VOLUME_DIR,
      init: storageInit
    }
  };
}

app.get('/api/health', (req, res) => res.json(getHealthSnapshot()));
app.get('/api/bot/runtime', (req, res) => res.json({ ok: true, ...getBotInteractionState() }));
app.get('/api/debug/storage', (req, res) => res.json({ ok: true, storage: getStorageDebug() }));
app.get('/api/weekly/539', (req, res) => res.json(getRangeSummary({ preset: 'this_week' })));
app.get('/api/weekly/ttl', (req, res) => res.json(getRangeSummary({ preset: 'this_week' })));
app.get('/api/results/range', (req, res) => res.json(getRangeSummary({ startDate: req.query.start, endDate: req.query.end, preset: req.query.preset })));
app.get('/api/analysis/compare-active/:type', (req, res) => res.json(compareActiveTrackings(req.params.type)));
app.get('/api/history/539', (req, res) => res.json({ ok: true, rows: getResultHistory('539') }));
app.get('/api/history/ttl', (req, res) => res.json({ ok: true, rows: getResultHistory('ttl') }));
app.get('/api/tracking/:type', (req, res) => res.json(getTrackingOverview(req.params.type)));
app.post('/api/tracking/recalculate', (req, res) => {
  try { res.json(recalculateTrackingAnalysis(req.body || {})); }
  catch (err) { res.status(400).json({ ok: false, message: err.message || '重算分析失敗' }); }
});
app.post('/api/tracking/check-now', async (req, res) => {
  try {
    const lotteryType = req.body && req.body.lotteryType === 'ttl' ? 'ttl' : '539';
    const trackingId = String((req.body && req.body.trackingId) || '').trim();
    if (!trackingId) throw new Error('缺少 trackingId');
    const tracking = getActiveTrackings(lotteryType).find((row) => String(row.id || '') === trackingId);
    if (!tracking) throw new Error('找不到待開獎追蹤');
    const latest = getLatestDrawByType(lotteryType);
    if (!latest || !Array.isArray(latest.numbers) || latest.numbers.length !== 5) throw new Error('目前沒有可用開獎資料');
    const title = lotteryType === 'ttl' ? '天天樂' : '539';
    const issueKey = `${latest.issue}|${latest.date}|${latest.numbers.join('-')}`;
    const result = await processTrackingNow(tracking, lotteryType, title, latest.numbers, issueKey);
    res.json({ ok: true, trackingId, latestIssue: latest.issue, issueKey, result, message: `${title} 已立即核對本期 ${latest.issue}` });
  } catch (err) {
    res.status(400).json({ ok: false, message: err.message || '立即核對失敗' });
  }
});

app.get('/api/learning/:type', (req, res) => res.json({ ok: true, learning: getLearningState(req.params.type) }));
app.get('/api/recommend/:type', (req, res) => res.json(getRecommendations(req.params.type)));

app.get('/api/telegram/config', (req, res) => {
  const saved = readBotConfig();
  res.json({
    ok: true,
    telegram: getBotRuntimeSummary(),
    saved: {
      hasSavedBotToken: Boolean(saved.botToken),
      hasSavedChatId: Boolean(saved.chatId),
      updatedAt: saved.updatedAt || ''
    }
  });
});
app.post('/api/telegram/config', (req, res) => {
  try {
    const body = req.body || {};
    const botToken = String(body.botToken || '').trim();
    const chatId = String(body.chatId || '').trim();
    if (!botToken) throw new Error('請輸入 BOT_TOKEN');
    if (!chatId) throw new Error('請輸入 TG_CHAT_ID');
    const saved = writeBotConfig({ botToken, chatId });
    res.json({
      ok: true,
      message: 'Telegram 設定已儲存到伺服器',
      telegram: getBotRuntimeSummary(),
      saved: {
        hasSavedBotToken: Boolean(saved.botToken),
        hasSavedChatId: Boolean(saved.chatId),
        updatedAt: saved.updatedAt
      }
    });
  } catch (err) {
    res.status(400).json({ ok: false, message: err.message, telegram: getBotRuntimeSummary() });
  }
});

app.post('/api/telegram/broadcast', async (req, res) => {
  try {
    const body = req.body || {};
    const text = String(body.text || '').trim();
    const targetMode = String(body.targetMode || 'all').trim();
    const chatIds = String(body.chatIds || '').trim();
    const file = body.file && typeof body.file === 'object' ? body.file : null;
    if (!text && !(file && file.dataUrl)) throw new Error('請輸入文字內容或上傳附件');
    const result = await broadcastTelegramMessage({
      text,
      toAll: targetMode === 'all',
      chatIds,
      file
    });
    res.json({ ok: true, message: `已送出 ${result.count} 則 Telegram 訊息`, result, telegram: getBotRuntimeSummary() });
  } catch (err) {
    res.status(400).json({ ok: false, message: err.message || 'Telegram 發送失敗', telegram: getBotRuntimeSummary() });
  }
});

app.post('/api/telegram/test', async (req, res) => {
  try {
    const text = String((req.body && req.body.text) || '【拾柒追蹤系統】Telegram 測試成功').trim();
    const result = await testTelegramSend(text);
    res.json({ ok: true, result, telegram: getBotRuntimeSummary() });
  } catch (err) {
    res.status(400).json({ ok: false, message: err.message, telegram: getBotRuntimeSummary() });
  }
});
app.post('/api/confirm-tracking', async (req, res) => {
  try {
    const result = await confirmTracking(withIssueContext(req.body || {}));
    res.json(result);
  }
  catch (err) { res.status(400).json({ ok: false, message: err.message }); }
});
app.post('/api/manual-tracking', async (req, res) => {
  try {
    const result = await confirmManualTracking(withIssueContext(req.body || {}));
    res.json(result);
  }
  catch (err) { res.status(400).json({ ok: false, message: err.message }); }
});

app.post('/api/tracking/cancel', async (req, res) => {
  try {
    const result = await cancelTracking(req.body || {});
    res.json(result);
  }
  catch (err) { res.status(400).json({ ok: false, message: err.message }); }
});

process.on('unhandledRejection', (err) => console.error('unhandledRejection:', err));
process.on('uncaughtException', (err) => console.error('uncaughtException:', err));

app.listen(PORT, async () => {
  console.log(`API Server running http://localhost:${PORT}`);
  console.log('Storage data dir:', ACTIVE_DATA_DIR);
  console.log('Storage volume dir:', DEFAULT_VOLUME_DIR);
  console.log('Storage init:', JSON.stringify(storageInit));
  console.log('Sync interval ms:', UPDATE_INTERVAL_MS);
  try {
    await updateAll();
  } catch (err) {
    console.error('initial updateAll failed:', err.message);
  }
  try {
    startBotInteraction({ getHealth: getHealthSnapshot, callTelegram });
    console.log('Telegram group interaction polling started');
  } catch (err) {
    console.error('startBotInteraction failed:', err.message);
  }
  scheduleNextUpdate();
});
