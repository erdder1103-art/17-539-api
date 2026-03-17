const fs = require('fs');
const { sendTelegramMessage } = require('./telegram');
const { getActiveTrackings, settleTracking } = require('./trackingStore');
const { formatTaipeiDateTime, getTaipeiDate } = require('./utils/time');
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

function issueToNumber(issue) {
  const n = Number(String(issue || '').replace(/\D/g, ''));
  return Number.isFinite(n) ? n : 0;
}

function buildNextIssue(issue) {
  const raw = String(issue || '').trim();
  const num = issueToNumber(raw);
  if (!num) return '';
  return raw && /^\d+$/.test(raw) ? String(num + 1).padStart(raw.length, '0') : String(num + 1);
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

function parseDrawDate(issueKey) {
  return String(issueKey || '').split('|')[1] || '';
}

function normalizeDateOnly(value) {
  const str = String(value || '').trim();
  if (!str) return '';
  const m = str.match(/(\d{4})[\/-](\d{1,2})[\/-](\d{1,2})/);
  if (!m) return '';
  return `${m[1]}-${String(m[2]).padStart(2, '0')}-${String(m[3]).padStart(2, '0')}`;
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

function buildSingleGroupRisk(group) {
  const nums = (group || []).map(Number).sort((a, b) => a - b);
  const odd = nums.filter(n => n % 2 === 1).length;
  const even = nums.length - odd;
  const tens = {};
  const tails = {};
  let adjacent = 0;
  for (let i = 0; i < nums.length; i += 1) {
    const n = nums[i];
    const tensBucket = Math.floor(n / 10);
    const tailBucket = n % 10;
    tens[tensBucket] = (tens[tensBucket] || 0) + 1;
    tails[tailBucket] = (tails[tailBucket] || 0) + 1;
    if (i > 0 && nums[i] - nums[i - 1] === 1) adjacent += 1;
  }
  const maxTens = Math.max(0, ...Object.values(tens));
  const maxTail = Math.max(0, ...Object.values(tails));
  const span = nums.length ? nums[nums.length - 1] - nums[0] : 0;
  const oddEvenGap = Math.abs(odd - even);
  const isLowRisk = adjacent <= 1 && maxTens <= 2 && maxTail <= 1 && oddEvenGap <= 1 && span >= 14;
  const isReject = adjacent >= 2 || maxTens >= 3 || maxTail >= 2 || oddEvenGap >= 3 || span <= 11;
  return { adjacent, maxTens, maxTail, span, oddEvenGap, isLowRisk, isReject };
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
  const groupRiskStats = getMainGroups(groups).map(buildSingleGroupRisk);
  const lowRiskGroupCount = groupRiskStats.filter(g => g.isLowRisk).length;
  const rejectedGroupCount = groupRiskStats.filter(g => g.isReject).length;
  const maxGroupAdjacent = Math.max(0, ...groupRiskStats.map(g => g.adjacent));
  const maxGroupTailCount = Math.max(0, ...groupRiskStats.map(g => g.maxTail));
  const maxGroupTensCount = Math.max(0, ...groupRiskStats.map(g => g.maxTens));

  return {
    oddEvenBalance: `${oddCount}:${evenCount}`,
    oddCount,
    evenCount,
    lowMidHigh: `${lowCount}:${midCount}:${highCount}`,
    lowCount,
    midCount,
    highCount,
    adjacentPairs: countAdjacent(mainNumbers),
    tailSpread: Object.keys(tailBuckets).length,
    tensSpread: Object.keys(tensBuckets).length,
    maxTailCount: Math.max(0, ...Object.values(tailBuckets)),
    maxTensCount: Math.max(0, ...Object.values(tensBuckets)),
    fullCoverage: fullNumbers.length,
    groupOverlapWithFull: groupOverlaps,
    spanSummary: spans,
    avgSpan: spans.length ? Number((spans.reduce((a, b) => a + b, 0) / spans.length).toFixed(2)) : 0,
    mainUniqueCount: new Set(mainNumbers).size,
    fullUniqueCount: new Set(fullNumbers).size,
    lowRiskGroupCount,
    rejectedGroupCount,
    maxGroupAdjacent,
    maxGroupTailCount,
    maxGroupTensCount
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

function featureLabel(name, valueKey) {
  const map = {
    adjacentPairs: (v) => Number(v) <= 2 ? '連號偏少' : '連號偏多',
    maxTailCount: (v) => Number(v) <= 3 ? '尾數分散' : '尾數過度集中',
    maxTensCount: (v) => Number(v) <= 6 ? '十位區分布較平均' : '十位區過度集中',
    fullCoverage: (v) => Number(v) === 19 ? '全車號碼完整' : '全車號碼不足19顆',
    oddEvenBalance: (v) => {
      const [odd, even] = String(v).split(':').map(Number);
      return Math.abs((odd || 0) - (even || 0)) <= 4 ? '奇偶平衡' : '奇偶失衡';
    }
  };
  return map[name] ? map[name](valueKey) : `${name}:${valueKey}`;
}

function dedupeLabels(arr) {
  const seen = new Set();
  const out = [];
  for (const item of arr) {
    const key = String(item || '');
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(key);
  }
  return out;
}


function formatRiskDetailGroup(detail) {
  const parts = [];
  if ((detail.riskyTripleHits || []).length) parts.push(`第${detail.groupIndex}組含高風險三連號 ${detail.riskyTripleHits[0]}`);
  if ((detail.riskyPairHits || []).length) parts.push(`第${detail.groupIndex}組含高風險雙號 ${detail.riskyPairHits[0]}`);
  if ((detail.riskyNumbers || []).length >= 2) parts.push(`第${detail.groupIndex}組高風險號偏多（${detail.riskyNumbers.slice(0,3).join('、')}）`);
  if (Number(detail.hotCount || 0) >= 3) parts.push(`第${detail.groupIndex}組熱號集中 ${detail.hotCount} 顆`);
  return parts;
}

function normalizeTrackingAnalysis(tracking) {
  const analysis = tracking.analysis || {};
  const groups = tracking.groups || {};
  const hotSet = new Set((analysis.hotNumbers || []).map(String));
  const riskySet = new Set((analysis.riskyNumbers || []).map(String));
  const pairSet = new Set((analysis.highRiskPairs || []).map(String));
  const tripleSet = new Set((analysis.highRiskTriples || []).map(String));
  const details = ['group1', 'group2', 'group3', 'group4'].map((key, idx) => {
    const nums = Array.isArray(groups[key]) ? groups[key].map(String) : [];
    const riskyPairHits = [];
    const riskyTripleHits = [];
    for (let i = 0; i < nums.length; i++) {
      for (let j = i + 1; j < nums.length; j++) {
        const pair = [nums[i], nums[j]].sort().join('・');
        if (pairSet.has(pair)) riskyPairHits.push(pair.replace(/・/g, '、'));
      }
    }
    for (let i = 0; i < nums.length; i++) {
      for (let j = i + 1; j < nums.length; j++) {
        for (let k = j + 1; k < nums.length; k++) {
          const triple = [nums[i], nums[j], nums[k]].sort().join('・');
          if (tripleSet.has(triple)) riskyTripleHits.push(triple.replace(/・/g, '、'));
        }
      }
    }
    return {
      groupIndex: idx + 1,
      hotCount: nums.filter((n) => hotSet.has(n)).length,
      riskyNumbers: nums.filter((n) => riskySet.has(n)),
      riskyPairHits,
      riskyTripleHits
    };
  });
  const twoHitRisk = details.reduce((acc, d) => acc + d.riskyPairHits.length, 0);
  const threeHitRisk = details.reduce((acc, d) => acc + d.riskyTripleHits.length, 0);
  return {
    ...analysis,
    riskGroupDetails: details,
    twoHitRisk,
    threeHitRisk,
    drawCount: Number(analysis.drawCount || 0),
    evaluatedWindow: Number(analysis.evaluatedWindow || 50)
  };
}

function buildRiskNarrativeFromAnalysis(features, tracking) {
  const analysis = normalizeTrackingAnalysis(tracking);
  const positives = [];
  const negatives = [];
  const details = Array.isArray(analysis.riskGroupDetails) ? analysis.riskGroupDetails : [];
  const hotCounts = details.map(d => Number(d.hotCount || 0));
  const pairGroups = details.filter(d => (d.riskyPairHits || []).length).map(d => d.groupIndex);
  const tripleGroups = details.filter(d => (d.riskyTripleHits || []).length).map(d => d.groupIndex);
  const heavyRiskGroups = details.filter(d => (d.riskyNumbers || []).length >= 2).map(d => d.groupIndex);

  if (analysis.drawCount > 0) positives.push(`依近${analysis.evaluatedWindow}期資料完成碰撞避讓`);
  if (!tripleGroups.length) positives.push('四組均未落入高風險三連號同組');
  else positives.push(`已將高風險三連號控制在第${tripleGroups.join('、')}組以外`);
  if (pairGroups.length <= 1) positives.push('高風險雙號同組控制在低水位');
  if (hotCounts.length && Math.max(...hotCounts) <= 2) positives.push('熱號已拆分配置於不同分組');
  else if (hotCounts.length) positives.push(`熱號主集中於第${hotCounts.indexOf(Math.max(...hotCounts)) + 1}組`);
  if (features.fullCoverage === 19) positives.push('全車19顆完整承接補位號碼');

  for (const detail of details) negatives.push(...formatRiskDetailGroup(detail));
  if (!negatives.length) negatives.push('主四組未見明顯高風險雙號或三連號同組');
  if (heavyRiskGroups.length) negatives.push(`第${heavyRiskGroups.join('、')}組高風險號密度偏高`);
  return { positives: dedupeLabels(positives).slice(0,4), negatives: dedupeLabels(negatives).slice(0,4), analysis };
}

function buildRecommendationForTracking(lotteryType, tracking, learningState) {
  const bucket = (learningState && learningState.system) || DEFAULT_LEARNING_BUCKET;
  const total = Number(bucket.total || 0);
  const features = buildFeatureSnapshot(tracking);
  const narrative = buildRiskNarrativeFromAnalysis(features, tracking);
  const analysis = narrative.analysis || normalizeTrackingAnalysis(tracking);
  const details = Array.isArray(analysis.riskGroupDetails) ? analysis.riskGroupDetails : [];
  const maxHot = details.length ? Math.max(...details.map(d => Number(d.hotCount || 0))) : 0;
  const riskyNumsTotal = details.reduce((acc, d) => acc + (d.riskyNumbers || []).length, 0);
  const pairGroups = details.filter(d => (d.riskyPairHits || []).length).length;
  const tripleGroups = details.filter(d => (d.riskyTripleHits || []).length).length;

  let score = 66;
  score -= Number(analysis.twoHitRisk || 0) * 9;
  score -= Number(analysis.threeHitRisk || 0) * 16;
  score -= Math.max(0, maxHot - 2) * 6;
  score -= riskyNumsTotal * 2.5;
  score -= pairGroups * 3;
  score -= tripleGroups * 6;
  if (features.fullCoverage === 19) score += 6;
  score = Math.max(18, Math.min(92, score));

  const basePass = total ? (bucket.labels['恭喜過關'] || 0) / total : 0.55;
  const tendency = Math.max(0.28, Math.min(0.88, basePass * 0.35 + score / 100 * 0.65));
  const severeRisk = Math.max(0.04, Math.min(0.55, 0.08 + Number(analysis.twoHitRisk || 0) * 0.05 + Number(analysis.threeHitRisk || 0) * 0.1 + Math.max(0, maxHot - 2) * 0.04));
  const retryRate = Math.max(0.06, Math.min(0.62, 1 - tendency - severeRisk));
  const reliability = Math.max(38, Math.min(86, 44 + Math.min(total, 40) * 0.25 + Math.max(0, 18 - Number(analysis.twoHitRisk || 0) * 3 - Number(analysis.threeHitRisk || 0) * 6) + Math.max(0, 8 - riskyNumsTotal)));

  let riskLevel = '中';
  if (Number(analysis.threeHitRisk || 0) === 0 && Number(analysis.twoHitRisk || 0) === 0 && maxHot <= 2 && riskyNumsTotal <= 4) riskLevel = '低';
  else if (Number(analysis.threeHitRisk || 0) >= 1 || Number(analysis.twoHitRisk || 0) >= 2 || maxHot >= 3 || riskyNumsTotal >= 7) riskLevel = '高';

  return {
    trackingId: tracking.id || '',
    trackType: tracking.trackType || 'system',
    sourceName: tracking.sourceName || '',
    passTendency: Number((tendency * 100).toFixed(1)),
    predictedRetryRate: Number((retryRate * 100).toFixed(1)),
    predictedX33Rate: Number((severeRisk * 100).toFixed(1)),
    riskLevel,
    reliability: Number(reliability.toFixed(1)),
    score,
    positives: narrative.positives,
    negatives: narrative.negatives,
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

function summarizeRows(rows) {
  const total = rows.length;
  const labels = { '恭喜過關': 0, '再接再厲': 0, '靠3.3倍': 0, '發財了各位': 0 };
  rows.forEach((row) => {
    labels[row.finalLabel] = (labels[row.finalLabel] || 0) + 1;
  });
  return {
    total,
    labels,
    passRate: total ? Number((((labels['恭喜過關'] || 0) / total) * 100).toFixed(1)) : 0
  };
}

function filterRowsByRange(rows, startDate, endDate) {
  const start = normalizeDateOnly(startDate);
  const end = normalizeDateOnly(endDate);
  return rows.filter((row) => {
    const date = normalizeDateOnly(row.drawDate || row.checkedAt);
    if (!date) return false;
    if (start && date < start) return false;
    if (end && date > end) return false;
    return true;
  });
}

function getDateRangePreset(preset) {
  const now = getTaipeiDate();
  now.setHours(0, 0, 0, 0);
  const day = now.getDay();
  const mondayOffset = day === 0 ? -6 : 1 - day;
  const monday = new Date(now);
  monday.setDate(now.getDate() + mondayOffset);
  const sunday = new Date(monday);
  sunday.setDate(monday.getDate() + 6);
  const fmt = (d) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
  if (preset === 'this_week') return { startDate: fmt(monday), endDate: fmt(sunday), label: `${fmt(monday)}～${fmt(sunday)}` };
  if (preset === 'last_week') {
    const s = new Date(monday); s.setDate(s.getDate() - 7);
    const e = new Date(sunday); e.setDate(e.getDate() - 7);
    return { startDate: fmt(s), endDate: fmt(e), label: `${fmt(s)}～${fmt(e)}` };
  }
  if (preset === 'two_weeks_ago') {
    const s = new Date(monday); s.setDate(s.getDate() - 14);
    const e = new Date(sunday); e.setDate(e.getDate() - 14);
    return { startDate: fmt(s), endDate: fmt(e), label: `${fmt(s)}～${fmt(e)}` };
  }
  return null;
}

function getRangeSummary({ startDate, endDate, preset } = {}) {
  const range = preset ? getDateRangePreset(preset) : null;
  const start = normalizeDateOnly(startDate || range?.startDate);
  const end = normalizeDateOnly(endDate || range?.endDate);
  const allRows = readJson(RESULT_HISTORY_FILE, []);
  const rows = filterRowsByRange(allRows, start, end);
  const makeBucket = (trackType, lotteryType) => summarizeRows(rows.filter((row) => row.trackType === trackType && row.lotteryType === lotteryType));
  const system539 = makeBucket('system', '539');
  const systemTtl = makeBucket('system', 'ttl');
  const manual539 = makeBucket('manual', '539');
  const manualTtl = makeBucket('manual', 'ttl');
  const systemTotal = summarizeRows(rows.filter((row) => row.trackType === 'system'));
  const manualTotal = summarizeRows(rows.filter((row) => row.trackType === 'manual'));
  const better = systemTotal.passRate === manualTotal.passRate
    ? '本區間系統與手動表現相近'
    : systemTotal.passRate > manualTotal.passRate
      ? '本區間系統策略表現較佳'
      : '本區間手動策略表現較佳';
  return {
    ok: true,
    period: { startDate: start, endDate: end, label: range?.label || (start && end ? `${start}～${end}` : '') },
    totalCount: rows.length,
    system: {
      totalCount: systemTotal.total,
      ttl: systemTtl,
      lotto539: system539,
      passRate: systemTotal.passRate
    },
    manual: {
      totalCount: manualTotal.total,
      ttl: manualTtl,
      lotto539: manual539,
      passRate: manualTotal.passRate
    },
    conclusion: better
  };
}

function compareActiveTrackings(lotteryType) {
  const recData = getRecommendations(lotteryType);
  const sorted = [...recData.recommendations].sort((a, b) => b.passTendency - a.passTendency || b.reliability - a.reliability || a.predictedX33Rate - b.predictedX33Rate);
  return {
    ok: true,
    lotteryType: lotteryType === 'ttl' ? 'ttl' : '539',
    total: sorted.length,
    recommendations: sorted,
    best: sorted[0] || null
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
  const currentIssue = parseIssue(issueKey);
  const currentIssueNum = issueToNumber(currentIssue);
  const drawDate = normalizeDateOnly(parseDrawDate(issueKey));

  for (const tracking of active) {
    const startFromIssue = String(tracking.startFromIssue || '');
    const startNum = issueToNumber(startFromIssue);
    if (startNum && currentIssueNum < startNum) {
      outcomes.push({ trackingId: tracking.id, skipped: true, reason: 'before_start_issue', startFromIssue, currentIssue });
      continue;
    }

    const groups = { ...(tracking.groups || {}), __draw: draw };
    const resultMap = buildResultMap(groups);
    const evaluation = evaluateResult(resultMap);
    const message = buildResultMessage(lotteryTitle, issueKey, draw, tracking, resultMap, evaluation.label);

    await sendTelegramMessage(message, { timeoutMs: 8000 });
    learnFromOutcome(key, tracking, draw, resultMap, evaluation);

    history.push({
      lotteryType: key,
      lotteryTitle,
      issue: currentIssue,
      drawDate,
      issueKey,
      checkedAt: nowFull(),
      draw,
      resultMap,
      finalLabel: evaluation.label,
      trackingId: tracking.id || null,
      trackType: tracking.trackType || 'system',
      sourceType: tracking.trackType || 'system',
      sourceName: tracking.sourceName || ''
    });

    settleTracking(key, tracking.id, {
      issueKey,
      issue: currentIssue,
      drawDate,
      draw,
      resultMap,
      finalLabel: evaluation.label,
      checkedAt: nowFull()
    });

    outcomes.push({ trackingId: tracking.id, finalLabel: evaluation.label, resultMap, trackType: tracking.trackType || 'system' });
  }

  writeJson(RESULT_HISTORY_FILE, history);
  state[key].processedIssues.push(issueKey);
  state[key].processedIssues = state[key].processedIssues.slice(-120);
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
  getRecommendations,
  getRangeSummary,
  compareActiveTrackings,
  issueToNumber,
  buildNextIssue
};
