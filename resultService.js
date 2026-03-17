const { sendTelegramMessage } = require('./telegram');
const { updateWeeklyStats, buildWeeklySummaryText, getWeekKey } = require('./weekStats');
const { getActiveTrackings, settleTracking } = require('./trackingStore');
const { formatTaipeiDateTime } = require('./utils/time');

const { getDataFile, getDataDir, initializeDataFiles, readJsonSafe, writeJsonAtomic } = require('./dataPaths');

const RESULT_STATE_FILE = getDataFile('result_state.json');
const RESULT_HISTORY_FILE = getDataFile('result_history.json');
const LEARNING_FILE = getDataFile('learning_state.json');

function readJson(file, fallback) {
  try {
    if (!fs.existsSync(file)) return fallback;
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    return fallback;
  }
}

function writeJson(file, data) {
  fs.mkdirSync(getDataDir(), { recursive: true });
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
  const groups = [
    resultMap.group1 || 0,
    resultMap.group2 || 0,
    resultMap.group3 || 0,
    resultMap.group4 || 0
  ];
  const hit23 = groups.filter(v => v === 2 || v === 3).length;
  if (hit23 >= 2) return { label: '靠3.3倍', code: 'x33' };
  if (hit23 === 1) return { label: '再接再厲', code: 'retry' };
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

function hitNumbers(group, draw) {
  const set = new Set(draw);
  return (group || []).filter(n => set.has(n));
}

function parseIssue(issueKey) {
  return String(issueKey || '').split('|')[0] || '';
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

function buildResultLine(label, nums, hits, draw) {
  const hitNums = hitNumbers(nums, draw);
  return `${label}：${(nums || []).join('、')}　命中：${hits}顆　號碼：${hitNums.length ? hitNums.join('、') : '無'}`;
}

function buildResultMessage(lotteryTitle, issueKey, draw, tracking, resultMap, finalLabel) {
  const labels = tracking.labels || {
    group1: '第一組',
    group2: '第二組',
    group3: '第三組',
    group4: '第四組',
    full: '全車號碼'
  };
  const fullHitNums = hitNumbers(tracking.groups.full || [], draw);
  const lines = [
    `【拾柒追蹤系統｜${lotteryTitle} 開獎結果】`,
    '',
    `追蹤來源：${tracking.sourceName || (tracking.trackType === 'manual' ? '未命名通報' : '防2/3碰撞追蹤')}`,
    `開獎期數：${parseIssue(issueKey)}`,
    `開獎號碼：${draw.join('、')}`,
    buildResultLine(labels.group1 || '第一組', tracking.groups.group1 || [], resultMap.group1, draw),
    buildResultLine(labels.group2 || '第二組', tracking.groups.group2 || [], resultMap.group2, draw),
    buildResultLine(labels.group3 || '第三組', tracking.groups.group3 || [], resultMap.group3, draw),
    buildResultLine(labels.group4 || '第四組', tracking.groups.group4 || [], resultMap.group4, draw),
    `${labels.full || '全車號碼'}：${(tracking.groups.full || []).join('、')}`,
    `全車命中：${resultMap.full}顆　號碼：${fullHitNums.length ? fullHitNums.join('、') : '無'}`,
    '',
    `結果：${finalLabel}`
  ];
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
    if (tracking.trackType === 'system') {
      updateWeeklyStats(key, evaluation.label);
    }
    const message = buildResultMessage(lotteryTitle, issueKey, draw, tracking, resultMap, evaluation.label);

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
      checkedAt: nowFull(),
      weeklyText: tracking.trackType === 'system' ? buildWeeklySummaryText(key) : ''
    });

    outcomes.push({ trackingId: tracking.id, finalLabel: evaluation.label, resultMap, trackType: tracking.trackType || 'system' });
  }

  writeJson(RESULT_HISTORY_FILE, history);
  state[key].processedIssues.push(issueKey);
  state[key].processedIssues = state[key].processedIssues.slice(-60);
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
