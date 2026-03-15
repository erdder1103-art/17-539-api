const fs = require('fs');
const path = require('path');
const { sendTelegramMessage } = require('./telegram');
const { updateWeeklyStats, buildWeeklySummaryText, getWeekKey } = require('./weekStats');
const { getActiveTrackings, settleTracking } = require('./trackingStore');
const { formatTaipeiDateTime } = require('./utils/time');

const RESULT_STATE_FILE = path.join(__dirname, 'data', 'result_state.json');
const RESULT_HISTORY_FILE = path.join(__dirname, 'data', 'result_history.json');
const LEARNING_FILE = path.join(__dirname, 'data', 'learning_state.json');

function readJson(file, fallback) {
  try {
    if (!fs.existsSync(file)) return fallback;
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    return fallback;
  }
}

function writeJson(file, data) {
  fs.writeFileSync(file, JSON.stringify(data, null, 2), 'utf8');
}

function pad2(n) {
  return String(parseInt(n, 10)).padStart(2, '0');
}

function hitCount(group, draw) {
  const set = new Set(draw);
  return group.filter(n => set.has(n)).length;
}

function evaluateResult(resultMap) {
  const mainHits = [resultMap.group1, resultMap.group2, resultMap.group3, resultMap.group4].filter(v => typeof v === 'number' && v > 0);
  if (mainHits.some(v => v >= 4)) return { label: '發財了各位', code: 'jackpot' };
  const hit2or3Count = mainHits.filter(v => v === 2 || v === 3).length;
  if (hit2or3Count >= 2) return { label: '靠3.3倍', code: 'x33' };
  if (hit2or3Count === 1) return { label: '再接再厲', code: 'retry' };
  return { label: '恭喜過關', code: 'pass' };
}

function nowFull() {
  return formatTaipeiDateTime();
}

function buildResultMap(groups) {
  return {
    group1: hitCount(groups.group1 || [], groups.__draw || []),
    group2: hitCount(groups.group2 || [], groups.__draw || []),
    group3: hitCount(groups.group3 || [], groups.__draw || []),
    group4: hitCount(groups.group4 || [], groups.__draw || []),
    full: hitCount(groups.full || [], groups.__draw || [])
  };
}

function learnFromOutcome(lotteryType, tracking, draw, resultMap, evaluation) {
  const store = readJson(LEARNING_FILE, { '539': { system: { total: 0, labels: {}, lessons: {} } }, 'ttl': { system: { total: 0, labels: {}, lessons: {} } } });
  const key = lotteryType === 'ttl' ? 'ttl' : '539';
  if (!store[key]) store[key] = { system: { total: 0, labels: {}, lessons: {} } };
  if (!store[key].system) store[key].system = { total: 0, labels: {}, lessons: {} };

  if (tracking.trackType === 'system') {
    const lessonKey = [
      `fullHits:${resultMap.full}`,
      `g1:${resultMap.group1}`,
      `g2:${resultMap.group2}`,
      `g3:${resultMap.group3}`,
      `g4:${resultMap.group4}`
    ].join('|');
    store[key].system.total += 1;
    store[key].system.labels[evaluation.label] = (store[key].system.labels[evaluation.label] || 0) + 1;
    if (!store[key].system.lessons[lessonKey]) {
      store[key].system.lessons[lessonKey] = { total: 0, labels: {} };
    }
    store[key].system.lessons[lessonKey].total += 1;
    store[key].system.lessons[lessonKey].labels[evaluation.label] = (store[key].system.lessons[lessonKey].labels[evaluation.label] || 0) + 1;
    store[key].system.lastUpdatedAt = nowFull();
    store[key].system.lastDraw = draw;
  }
  writeJson(LEARNING_FILE, store);
}

function buildResultMessage(lotteryTitle, draw, tracking, resultMap, finalLabel, weeklyText) {
  const lines = [
    `【拾柒追蹤系統｜${lotteryTitle} 開獎核對】`,
    '',
    `核對狀態：已完成`,
    `核對時間：${nowFull()}`,
    `追蹤類型：${tracking.trackType === 'manual' ? `手動追蹤${tracking.sourceName ? `（${tracking.sourceName}）` : ''}` : '系統追蹤'}`,
    '',
    `本期開獎號碼：`,
    draw.join('、'),
    ''
  ];

  lines.push('各組命中結果：');
  lines.push(`${tracking.labels?.group1 || '第一組'}：中 ${resultMap.group1} 顆`);
  lines.push(`${tracking.labels?.group2 || '第二組'}：中 ${resultMap.group2} 顆`);
  lines.push(`${tracking.labels?.group3 || '第三組'}：中 ${resultMap.group3} 顆`);
  lines.push(`${tracking.labels?.group4 || '第四組'}：中 ${resultMap.group4} 顆`);
  lines.push(`${tracking.labels?.full || '全車號碼'}：中 ${resultMap.full} 顆`);
  lines.push('');
  lines.push('本期結果：');
  lines.push(finalLabel);
  lines.push('');
  lines.push(weeklyText);
  return lines.join('\n');
}

async function processTrackingResult(lotteryType, lotteryTitle, latestDraw, issueKey) {
  const active = getActiveTrackings(lotteryType);
  if (!Array.isArray(active) || !active.length) {
    return { skipped: true, reason: 'no active tracking' };
  }

  const state = readJson(RESULT_STATE_FILE, { '539': { processedIssues: [] }, 'ttl': { processedIssues: [] } });
  const key = lotteryType === 'ttl' ? 'ttl' : '539';
  if (!state[key]) state[key] = { processedIssues: [] };
  state[key].processedIssues = Array.isArray(state[key].processedIssues) ? state[key].processedIssues : [];
  if (state[key].processedIssues.includes(issueKey)) {
    return { skipped: true, reason: 'already processed' };
  }

  const draw = latestDraw.map(pad2);
  const history = readJson(RESULT_HISTORY_FILE, []);
  const outcomes = [];

  for (const tracking of active) {
    const groups = { ...(tracking.groups || {}), __draw: draw };
    const resultMap = buildResultMap(groups);
    const evaluation = evaluateResult(resultMap);
    const weekly = tracking.trackType === 'system' ? updateWeeklyStats(key, evaluation.label) : null;
    const weeklyText = tracking.trackType === 'system' ? buildWeeklySummaryText(key, weekly) : '手動追蹤已完成核對';
    const message = buildResultMessage(lotteryTitle, draw, tracking, resultMap, evaluation.label, weeklyText);

    await sendTelegramMessage(message, { timeoutMs: 8000 });
    learnFromOutcome(key, tracking, draw, resultMap, evaluation);

    history.push({
      lotteryType: key,
      lotteryTitle,
      issueKey,
      checkedAt: nowFull(),
      draw,
      resultMap,
      finalLabel: evaluation.label,
      week: getWeekKey(),
      trackingId: tracking.id || null,
      trackType: tracking.trackType || 'system',
      sourceName: tracking.sourceName || ''
    });

    settleTracking(key, tracking.id, {
      issueKey,
      draw,
      resultMap,
      finalLabel: evaluation.label,
      checkedAt: nowFull()
    });

    outcomes.push({ trackingId: tracking.id, finalLabel: evaluation.label, resultMap, trackType: tracking.trackType || 'system' });
  }

  writeJson(RESULT_HISTORY_FILE, history);
  state[key].processedIssues.push(issueKey);
  state[key].processedIssues = state[key].processedIssues.slice(-30);
  state[key].lastIssue = issueKey;
  state[key].lastCheckedAt = nowFull();
  writeJson(RESULT_STATE_FILE, state);

  return { ok: true, outcomes };
}

function getResultHistory(lotteryType) {
  const key = lotteryType === 'ttl' ? 'ttl' : '539';
  return readJson(RESULT_HISTORY_FILE, []).filter(x => x.lotteryType === key);
}

function getLearningState(lotteryType) {
  const key = lotteryType === 'ttl' ? 'ttl' : '539';
  const store = readJson(LEARNING_FILE, { '539': { system: { total: 0, labels: {}, lessons: {} } }, 'ttl': { system: { total: 0, labels: {}, lessons: {} } } });
  return store[key] || { system: { total: 0, labels: {}, lessons: {} } };
}

module.exports = {
  processTrackingResult,
  getResultHistory,
  getLearningState
};
