const fs = require('fs');
const { sendTelegramMessage } = require('./telegram');
const { updateWeeklyStats, buildWeeklySummaryText, getWeekKey } = require('./weekStats');
const { getActiveTrackings, settleTracking } = require('./trackingStore');
const { formatTaipeiDateTime } = require('./utils/time');
const { getDataFile, getDataDir } = require('./dataPaths');

const RESULT_STATE_FILE = getDataFile('result_state.json');
const RESULT_HISTORY_FILE = getDataFile('result_history.json');
const LEARNING_FILE = getDataFile('learning_state.json');

const DEFAULT_LEARNING_BUCKET = {
  total: 0,
  labels: {},
  lessons: {},
  featureStats: {},
  samples: [],
  lastUpdatedAt: '',
  lastDraw: []
};

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

function getLessonKey(resultMap) {
  return [
    `fullHits:${resultMap.full}`,
    `g1:${resultMap.group1}`,
    `g2:${resultMap.group2}`,
    `g3:${resultMap.group3}`,
    `g4:${resultMap.group4}`
  ].join('|');
}

function getMainGroups(groups) {
  return [groups.group1 || [], groups.group2 || [], groups.group3 || [], groups.group4 || []];
}

function getAllMainNumbers(groups) {
  return getMainGroups(groups).flat();
}

function countAdjacent(nums) {
  const sorted = [...nums].map(Number).sort((a, b) => a - b);
  let count = 0;
  for (let i = 1; i < sorted.length; i += 1) {
    if (sorted[i] - sorted[i - 1] === 1) count += 1;
  }
  return count;
}

function groupSpan(group) {
  if (!Array.isArray(group) || !group.length) return 0;
  const sorted = [...group].map(Number).sort((a, b) => a - b);
  return sorted[sorted.length - 1] - sorted[0];
}

function buildFeatureSnapshot(tracking) {
  const groups = tracking.groups || {};
  const mainNumbers = getAllMainNumbers(groups).map(Number);
  const fullNumbers = (groups.full || []).map(Number);
  const oddCount = mainNumbers.filter(n => n % 2 === 1).length;
  const evenCount = mainNumbers.length - oddCount;
  const lowCount = mainNumbers.filter(n => n >= 1 && n <= 13).length;
  const midCount = mainNumbers.filter(n => n >= 14 && n <= 26).length;
  const highCount = mainNumbers.filter(n => n >= 27 && n <= 39).length;
  const tailBuckets = {};
  const tensBuckets = {};
  for (const num of mainNumbers) {
    const tail = String(num % 10);
    const tens = String(Math.floor(num / 10));
    tailBuckets[tail] = (tailBuckets[tail] || 0) + 1;
    tensBuckets[tens] = (tensBuckets[tens] || 0) + 1;
  }
  const fullSet = new Set((groups.full || []).map(String));
  const groupOverlaps = getMainGroups(groups).map((g) => g.filter((n) => fullSet.has(String(n))).length);
  const spans = getMainGroups(groups).map(groupSpan);
  const duplicateTails = Object.values(tailBuckets).filter(v => v >= 3).length;
  const crowdedTens = Object.values(tensBuckets).filter(v => v >= 6).length;
  const adjacentPairs = countAdjacent(mainNumbers);

  return {
    oddEvenBalance: `${oddCount}:${evenCount}`,
    oddCount,
    evenCount,
    lowMidHigh: `${lowCount}:${midCount}:${highCount}`,
    lowCount,
    midCount,
    highCount,
    adjacentPairs,
    duplicateTails,
    crowdedTens,
    tailSpread: Object.keys(tailBuckets).length,
    tensSpread: Object.keys(tensBuckets).length,
    maxTailCount: Math.max(0, ...Object.values(tailBuckets)),
    maxTensCount: Math.max(0, ...Object.values(tensBuckets)),
    fullCoverage: fullNumbers.length,
    groupOverlapWithFull: groupOverlaps,
    spanSummary: spans,
    avgSpan: spans.length ? Number((spans.reduce((a, b) => a + b, 0) / spans.length).toFixed(2)) : 0,
    mainUniqueCount: new Set(mainNumbers).size,
    fullUniqueCount: new Set(fullNumbers).size
  };
}

function ensureLearningStore(raw) {
  const store = raw || {};
  for (const key of ['539', 'ttl']) {
    if (!store[key]) store[key] = {};
    if (!store[key].system) store[key].system = JSON.parse(JSON.stringify(DEFAULT_LEARNING_BUCKET));
    store[key].system.total = Number(store[key].system.total || 0);
    store[key].system.labels = store[key].system.labels || {};
    store[key].system.lessons = store[key].system.lessons || {};
    store[key].system.featureStats = store[key].system.featureStats || {};
    store[key].system.samples = Array.isArray(store[key].system.samples) ? store[key].system.samples : [];
  }
  return store;
}

function recordFeatureStats(bucket, features, label) {
  for (const [name, value] of Object.entries(features)) {
    const valueKey = Array.isArray(value) ? value.join(',') : String(value);
    if (!bucket.featureStats[name]) bucket.featureStats[name] = {};
    if (!bucket.featureStats[name][valueKey]) bucket.featureStats[name][valueKey] = { total: 0, labels: {} };
    const stat = bucket.featureStats[name][valueKey];
    stat.total += 1;
    stat.labels[label] = (stat.labels[label] || 0) + 1;
  }
}

function learnFromOutcome(lotteryType, tracking, draw, resultMap, evaluation) {
  const store = ensureLearningStore(readJson(LEARNING_FILE, {}));
  const key = lotteryType === 'ttl' ? 'ttl' : '539';
  if (tracking.trackType === 'system') {
    const bucket = store[key].system;
    const lessonKey = getLessonKey(resultMap);
    const features = buildFeatureSnapshot(tracking);
    bucket.total += 1;
    bucket.labels[evaluation.label] = (bucket.labels[evaluation.label] || 0) + 1;
    if (!bucket.lessons[lessonKey]) {
      bucket.lessons[lessonKey] = { total: 0, labels: {} };
    }
    bucket.lessons[lessonKey].total += 1;
    bucket.lessons[lessonKey].labels[evaluation.label] = (bucket.lessons[lessonKey].labels[evaluation.label] || 0) + 1;
    recordFeatureStats(bucket, features, evaluation.label);
    bucket.samples.push({
      checkedAt: nowFull(),
      label: evaluation.label,
      lessonKey,
      resultMap,
      features
    });
    bucket.samples = bucket.samples.slice(-200);
    bucket.lastUpdatedAt = nowFull();
    bucket.lastDraw = draw;
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

function estimateLabelRate(labels = {}, total = 0, label) {
  if (!total) return 0;
  return Number((((labels[label] || 0) / total) * 100).toFixed(1));
}

function buildRecommendationForTracking(lotteryType, tracking, learningState) {
  const bucket = (learningState && learningState.system) || DEFAULT_LEARNING_BUCKET;
  const total = Number(bucket.total || 0);
  const features = buildFeatureSnapshot(tracking);
  let score = 0;
  const positives = [];
  const negatives = [];

  if (features.adjacentPairs <= 2) {
    score += 6;
    positives.push('連號偏少');
  } else {
    score -= 8;
    negatives.push('連號偏多');
  }
  if (features.maxTailCount <= 3) {
    score += 6;
    positives.push('尾數分散');
  } else {
    score -= 10;
    negatives.push('尾數過度集中');
  }
  if (features.maxTensCount <= 6) {
    score += 5;
    positives.push('十位區分布較平均');
  } else {
    score -= 8;
    negatives.push('十位區過度集中');
  }
  if (Math.abs(features.oddCount - features.evenCount) <= 4) {
    score += 5;
    positives.push('奇偶平衡');
  } else {
    score -= 5;
    negatives.push('奇偶失衡');
  }
  if (features.fullCoverage === 19) {
    score += 5;
    positives.push('全車號碼完整');
  } else {
    score -= 12;
    negatives.push('全車號碼不是19顆');
  }

  for (const [name, value] of Object.entries(features)) {
    const valueKey = Array.isArray(value) ? value.join(',') : String(value);
    const stat = bucket.featureStats?.[name]?.[valueKey];
    if (!stat || !stat.total) continue;
    const passRate = (stat.labels['恭喜過關'] || 0) / stat.total;
    const failRate = ((stat.labels['再接再厲'] || 0) + (stat.labels['靠3.3倍'] || 0)) / stat.total;
    const impact = Math.round((passRate - failRate) * Math.min(stat.total, 8));
    score += impact;
    if (impact >= 2) positives.push(`${name}:${valueKey}`);
    if (impact <= -2) negatives.push(`${name}:${valueKey}`);
  }

  const basePass = total ? (bucket.labels['恭喜過關'] || 0) / total : 0.5;
  const predictedPass = Math.max(0.05, Math.min(0.95, basePass + score / 200));
  const predictedRisk = Math.max(0.02, Math.min(0.9, 1 - predictedPass));
  const severeRatio = total ? (bucket.labels['靠3.3倍'] || 0) / total : 0.18;
  const severeRisk = Math.max(0.01, Math.min(0.6, severeRatio + Math.max(0, -score) / 250));
  const retryRate = Math.max(0.01, Math.min(0.9, predictedRisk - severeRisk));
  const confidence = Math.max(35, Math.min(95, 40 + Math.min(total, 60) * 0.6 + Math.min(Math.abs(score), 20)));
  const riskLevel = severeRisk >= 0.28 || predictedPass < 0.48 ? '高' : severeRisk >= 0.16 || predictedPass < 0.6 ? '中' : '低';

  return {
    trackingId: tracking.id || '',
    trackType: tracking.trackType || 'system',
    sourceName: tracking.sourceName || '',
    predictedPassRate: Number((predictedPass * 100).toFixed(1)),
    predictedRetryRate: Number((retryRate * 100).toFixed(1)),
    predictedX33Rate: Number((severeRisk * 100).toFixed(1)),
    riskLevel,
    confidence: Number(confidence.toFixed(1)),
    score,
    positives: positives.slice(0, 4),
    negatives: negatives.slice(0, 4),
    features
  };
}

function getLearningState(lotteryType) {
  const key = lotteryType === 'ttl' ? 'ttl' : '539';
  const store = ensureLearningStore(readJson(LEARNING_FILE, {}));
  return store[key] || { system: JSON.parse(JSON.stringify(DEFAULT_LEARNING_BUCKET)) };
}

function getRecommendations(lotteryType) {
  const key = lotteryType === 'ttl' ? 'ttl' : '539';
  const active = getActiveTrackings(key);
  const learning = getLearningState(key);
  const recommendations = active.map((tracking) => buildRecommendationForTracking(key, tracking, learning));
  return {
    ok: true,
    lotteryType: key,
    activeCount: active.length,
    learningSamples: Number(learning.system?.total || 0),
    recommendations,
    summary: recommendations.length
      ? `目前共有 ${recommendations.length} 筆推薦分析`
      : '目前沒有可分析的待開獎追蹤'
  };
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

module.exports = {
  processTrackingResult,
  getResultHistory,
  getLearningState,
  getRecommendations
};
