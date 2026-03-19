const fs = require('fs');
const { sendTelegramMessage } = require('./telegram');
const { getActiveTrackings, settleTracking } = require('./trackingStore');
const { formatTaipeiDateTime, getTaipeiDate } = require('./utils/time');
const { getDataFile, getDataDir } = require('./dataPaths');

const RESULT_STATE_FILE = getDataFile('result_state.json');
const RESULT_HISTORY_FILE = getDataFile('result_history.json');
const LEARNING_FILE = getDataFile('learning_state.json');

const ANALYSIS_WINDOW = 100;

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


function comboKeyLocal(nums) {
  return [...nums].map(n => String(n).padStart(2, '0')).sort().join('-');
}

function getCombinationsLocal(arr, k) {
  const out = [];
  const a = [...arr];
  const dfs = (start, path) => {
    if (path.length === k) { out.push([...path]); return; }
    for (let i = start; i < a.length; i += 1) {
      path.push(a[i]);
      dfs(i + 1, path);
      path.pop();
    }
  };
  dfs(0, []);
  return out;
}


function normalizeGroupNumbers(group) {
  return (Array.isArray(group) ? group : []).map(n => String(n).padStart(2, '0'));
}

function collectGroupKeysFromTracking(tracking) {
  const groups = tracking.groups || {};
  return [normalizeGroupNumbers(groups.group1), normalizeGroupNumbers(groups.group2), normalizeGroupNumbers(groups.group3), normalizeGroupNumbers(groups.group4)];
}

function buildRiskSets(analysis) {
  const pairCounts = analysis.pairCounts || analysis.pairWeightMap || {};
  const tripleCounts = analysis.tripleCounts || analysis.tripleWeightMap || {};
  const highRiskPairs = Array.isArray(analysis.highRiskPairs) && analysis.highRiskPairs.length
    ? analysis.highRiskPairs
    : Object.entries(pairCounts).filter(([,v]) => Number(v || 0) >= 3).map(([k]) => k);
  const highRiskTriples = Array.isArray(analysis.highRiskTriples) && analysis.highRiskTriples.length
    ? analysis.highRiskTriples
    : Object.entries(tripleCounts).filter(([,v]) => Number(v || 0) >= 2).map(([k]) => k);
  const riskyNumbers = new Set(Array.isArray(analysis.riskyNumbers) ? analysis.riskyNumbers : []);
  highRiskPairs.forEach(key => String(key).split('-').forEach(n => riskyNumbers.add(String(n).padStart(2, '0'))));
  highRiskTriples.forEach(key => String(key).split('-').forEach(n => riskyNumbers.add(String(n).padStart(2, '0'))));
  return {
    pairSet: new Set(highRiskPairs.map(String)),
    tripleSet: new Set(highRiskTriples.map(String)),
    riskySet: riskyNumbers
  };
}

function enrichAnalysisForTracking(tracking) {
  const analysis = tracking.analysis || {};
  const groups = collectGroupKeysFromTracking(tracking);
  const counts = analysis.counts || analysis.hotScoreMap || {};
  const hotNumbers = Array.isArray(analysis.hotNumbers) ? analysis.hotNumbers.map(pad2) : [];
  const coldNumbers = Array.isArray(analysis.coldNumbers) ? analysis.coldNumbers.map(pad2) : [];
  const midNumbers = Array.isArray(analysis.midNumbers) ? analysis.midNumbers.map(pad2) : [];
  const { pairSet, tripleSet, riskySet } = buildRiskSets(analysis);
  const hotSet = new Set(hotNumbers);
  const coldSet = new Set(coldNumbers);
  const midSet = new Set(midNumbers);

  const details = groups.map((g, idx) => {
    const riskyPairHits = getCombinationsLocal(g, 2)
      .map(pair => comboKeyLocal(pair))
      .filter(key => pairSet.has(key));
    const riskyTripleHits = getCombinationsLocal(g, 3)
      .map(triple => comboKeyLocal(triple))
      .filter(key => tripleSet.has(key));
    const hotCount = g.filter(n => hotSet.has(n)).length;
    const midCount = g.filter(n => midSet.has(n)).length;
    const coldCount = g.filter(n => coldSet.has(n)).length;
    const riskyNumbers = g.filter(n => riskySet.has(n));
    const groupHeatScore = g.reduce((sum, n) => sum + Number(counts[n] || 0), 0);
    const groupPairExposure = sumAllPairExposure(g, analysis.pairWeightMap || analysis.pairCounts || {});
    const groupTripleExposure = sumAllTripleExposure(g, analysis.tripleWeightMap || analysis.tripleCounts || {});
    const identityHeatScore = exactNumberIdentityScore(g, counts);
    const identityFingerprint = exactNumberFingerprint(g, counts);
    return {
      groupIndex: idx + 1,
      groupNumbers: g,
      hotCount,
      midCount,
      coldCount,
      riskyNumbers,
      riskyPairHits,
      riskyTripleHits,
      groupHeatScore,
      groupPairExposure,
      groupTripleExposure,
      identityHeatScore,
      identityFingerprint,
      frequencyScores: g.map(n => Number(counts[n] || 0))
    };
  });

  return {
    ...analysis,
    counts,
    hotNumbers,
    coldNumbers,
    midNumbers,
    riskGroupDetails: details,
    riskyNumbers: Array.from(riskySet)
  };
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


function sumWeights(keys, weightMap) {
  return (keys || []).reduce((sum, key) => sum + Number(weightMap[key] || 0), 0);
}

function countMatches(arr, setObj) {
  return (arr || []).reduce((sum, item) => sum + (setObj.has(item) ? 1 : 0), 0);
}

function sumAllPairExposure(group, weightMap) {
  return getCombinationsLocal(group || [], 2)
    .map(pair => comboKeyLocal(pair))
    .reduce((sum, key) => sum + Number(weightMap[key] || 0), 0);
}

function sumAllTripleExposure(group, weightMap) {
  return getCombinationsLocal(group || [], 3)
    .map(triple => comboKeyLocal(triple))
    .reduce((sum, key) => sum + Number(weightMap[key] || 0), 0);
}

function exactNumberIdentityScore(group, hotScoreMap) {
  const nums = (group || []).map(String);
  return nums.reduce((sum, n, idx) => {
    const base = Number(hotScoreMap[n] || 0);
    return sum + base * (idx + 1);
  }, 0);
}

function exactNumberFingerprint(group, hotScoreMap) {
  const nums = (group || []).map((n) => String(n).padStart(2, '0')).sort();
  return nums.reduce((sum, n, idx) => {
    const base = Number(hotScoreMap[n] || 0);
    const raw = Number(n);
    return sum + raw * (idx + 3) + base * (idx + 5);
  }, 0);
}

function normalizedGroupNumbers(groups) {
  return (Array.isArray(groups) ? groups : []).map((n) => String(n).padStart(2, '0')).sort((a, b) => Number(a) - Number(b));
}

function describeHeatDensity(detail) {
  if (Number(detail.hotCount || 0) >= 3) return `第${detail.groupIndex}組熱號集中 ${detail.hotCount} 顆`;
  if (Number(detail.hotCount || 0) === 2) return `第${detail.groupIndex}組含 2 顆熱號，仍在可控範圍`;
  return '';
}

function formatComboList(list, limit = 2) {
  return (Array.isArray(list) ? list : [])
    .slice(0, limit)
    .map((item) => String(item).split('-').join('、'))
    .join(' / ');
}

function groupRiskScore(detail) {
  return Number(detail.groupPairExposure || 0) * 1.35
    + Number(detail.groupTripleExposure || 0) * 3.1
    + (Array.isArray(detail.riskyNumbers) ? detail.riskyNumbers.length : 0) * 1.55
    + (Array.isArray(detail.riskyPairHits) ? detail.riskyPairHits.length : 0) * 2.7
    + (Array.isArray(detail.riskyTripleHits) ? detail.riskyTripleHits.length : 0) * 4.8
    + Math.max(0, Number(detail.hotCount || 0) - 2) * 1.35;
}

function summarizeGroupLine(detail) {
  const nums = (Array.isArray(detail.groupNumbers) ? detail.groupNumbers : []).join(' ');
  const hot = Number(detail.hotCount || 0);
  const mid = Number(detail.midCount || 0);
  const cold = Number(detail.coldCount || 0);
  const pairExposure = Number(detail.groupPairExposure || 0);
  const tripleExposure = Number(detail.groupTripleExposure || 0);
  const pairHits = Array.isArray(detail.riskyPairHits) ? detail.riskyPairHits : [];
  const tripleHits = Array.isArray(detail.riskyTripleHits) ? detail.riskyTripleHits : [];
  const riskyNums = Array.isArray(detail.riskyNumbers) ? detail.riskyNumbers : [];
  const score = groupRiskScore(detail);
  let tag = '穩';
  if (tripleHits.length || tripleExposure >= 2) tag = '高風險';
  else if (pairHits.length || pairExposure >= 3 || hot >= 3 || riskyNums.length >= 3) tag = '偏風險';
  else if (hot === 0 && riskyNums.length <= 1) tag = '保守';
  const reasons = [];
  reasons.push(`熱/中/冷 ${hot}/${mid}/${cold}`);
  reasons.push(`熱度分 ${Number(detail.groupHeatScore || 0)}`);
  if (tripleHits.length) reasons.push(`三連號 ${formatComboList(tripleHits, 1)}`);
  else reasons.push('三連號 無');
  if (pairHits.length) reasons.push(`雙連號 ${formatComboList(pairHits, 2)}`);
  else reasons.push('雙連號 無');
  reasons.push(`風險號 ${riskyNums.length ? riskyNums.join('、') : '無'}`);
  reasons.push(`雙暴露 ${pairExposure}`);
  reasons.push(`三暴露 ${tripleExposure}`);
  return `第${detail.groupIndex}組【${tag}】${nums}｜${reasons.join('｜')}｜分數 ${score.toFixed(1)}`;
}

function buildGroupBreakdown(details) {
  return (Array.isArray(details) ? details : []).slice(0, 4).map((detail) => summarizeGroupLine(detail));
}


function getAnalysisProfile(tracking) {
  const analysis = enrichAnalysisForTracking(tracking);
  const details = Array.isArray(analysis.riskGroupDetails) ? analysis.riskGroupDetails : [];
  const pairWeightMap = analysis.pairWeightMap || analysis.pairCounts || {};
  const tripleWeightMap = analysis.tripleWeightMap || analysis.tripleCounts || {};
  const hotScoreMap = analysis.hotScoreMap || analysis.counts || {};
  const riskySet = new Set(Array.isArray(analysis.riskyNumbers) ? analysis.riskyNumbers : []);
  const hotCounts = details.map(d => Number(d.hotCount || 0));
  const riskyNumberCounts = details.map(d => Array.isArray(d.riskyNumbers) ? d.riskyNumbers.length : 0);
  const riskyPairCounts = details.map(d => Array.isArray(d.riskyPairHits) ? d.riskyPairHits.length : 0);
  const riskyTripleCounts = details.map(d => Array.isArray(d.riskyTripleHits) ? d.riskyTripleHits.length : 0);
  const pairWeights = details.map(d => sumWeights(d.riskyPairHits, pairWeightMap));
  const tripleWeights = details.map(d => sumWeights(d.riskyTripleHits, tripleWeightMap));
  const pairExposure = details.map(d => Number(d.groupPairExposure || 0));
  const tripleExposure = details.map(d => Number(d.groupTripleExposure || 0));
  const identityHeatScores = details.map(d => Number(d.identityHeatScore || 0));
  const identityFingerprints = details.map(d => Number(d.identityFingerprint || 0));
  const hotWeights = details.map(d => (Array.isArray(d.groupNumbers) ? d.groupNumbers : []).reduce((sum, n) => sum + Number(hotScoreMap[n] || 0), 0));
  const riskyWeights = details.map(d => (Array.isArray(d.groupNumbers) ? d.groupNumbers : []).reduce((sum, n) => sum + (riskySet.has(n) ? Number(hotScoreMap[n] || 1) : 0), 0));
  const heatScores = details.map(d => Number(d.groupHeatScore || 0));
  const totalHeatScore = heatScores.reduce((a,b)=>a+b,0);
  const totalHot = hotCounts.reduce((a,b)=>a+b,0);
  const totalRiskyNumbers = riskyNumberCounts.reduce((a,b)=>a+b,0);
  const totalPairHits = riskyPairCounts.reduce((a,b)=>a+b,0);
  const totalTripleHits = riskyTripleCounts.reduce((a,b)=>a+b,0);
  const totalPairWeight = pairWeights.reduce((a,b)=>a+b,0);
  const totalTripleWeight = tripleWeights.reduce((a,b)=>a+b,0);
  const totalPairExposure = pairExposure.reduce((a,b)=>a+b,0);
  const totalTripleExposure = tripleExposure.reduce((a,b)=>a+b,0);
  const totalIdentityHeatScore = identityHeatScores.reduce((a,b)=>a+b,0);
  const totalIdentityFingerprint = identityFingerprints.reduce((a,b)=>a+b,0);
  const totalHotWeight = hotWeights.reduce((a,b)=>a+b,0);
  const totalRiskyWeight = riskyWeights.reduce((a,b)=>a+b,0);
  const hotSpreadPenalty = hotCounts.length ? Math.max(...hotCounts) - Math.min(...hotCounts) : 0;
  const heatSpreadPenalty = heatScores.length ? Math.max(...heatScores) - Math.min(...heatScores) : 0;
  const denseRiskGroups = riskyNumberCounts.filter(v => v >= 2).length;
  const anyGroupHotOver = hotCounts.length ? Math.max(...hotCounts) : 0;
  const anyGroupRiskyOver = riskyNumberCounts.length ? Math.max(...riskyNumberCounts) : 0;
  const maxPairHits = riskyPairCounts.length ? Math.max(...riskyPairCounts) : 0;
  const maxTripleHits = riskyTripleCounts.length ? Math.max(...riskyTripleCounts) : 0;
  return {
    analysis,
    details,
    hotCounts,
    riskyNumberCounts,
    riskyPairCounts,
    riskyTripleCounts,
    pairWeights,
    tripleWeights,
    pairExposure,
    tripleExposure,
    identityHeatScores,
    identityFingerprints,
    hotWeights,
    riskyWeights,
    heatScores,
    totalHeatScore,
    totalHot,
    totalRiskyNumbers,
    totalPairHits,
    totalTripleHits,
    totalPairWeight,
    totalTripleWeight,
    totalPairExposure,
    totalTripleExposure,
    totalIdentityHeatScore,
    totalIdentityFingerprint,
    totalHotWeight,
    totalRiskyWeight,
    hotSpreadPenalty,
    heatSpreadPenalty,
    denseRiskGroups,
    anyGroupHotOver,
    anyGroupRiskyOver,
    maxPairHits,
    maxTripleHits
  };
}

function formatRiskDetailGroup(detail) {
  const parts = [];
  const riskyNums = Array.isArray(detail.riskyNumbers) ? detail.riskyNumbers : [];
  if ((detail.riskyTripleHits || []).length) parts.push(`第${detail.groupIndex}組含高風險三連號 ${String(detail.riskyTripleHits[0]).split('-').join('、')}`);
  if ((detail.riskyPairHits || []).length) parts.push(`第${detail.groupIndex}組含高風險雙號 ${String(detail.riskyPairHits[0]).split('-').join('、')}`);
  if (riskyNums.length >= 2) parts.push(`第${detail.groupIndex}組高風險號偏多（${riskyNums.slice(0,3).join('、')}）`);
  else if (riskyNums.length === 1) parts.push(`第${detail.groupIndex}組含高風險號 ${riskyNums[0]}`);
  const heatText = describeHeatDensity(detail);
  if (heatText) parts.push(heatText);
  return parts;
}


function buildRiskNarrativeFromAnalysis(features, tracking, profile) {
  const useProfile = profile || getAnalysisProfile(tracking);
  const { analysis, details, totalPairHits, totalTripleHits, hotCounts, identityFingerprints } = useProfile;
  const positives = [];
  const negatives = [];
  const groupBreakdown = buildGroupBreakdown(details);
  const drawWindow = Number(analysis.evaluatedWindow || analysis.drawCount || 0) || ANALYSIS_WINDOW;
  if (drawWindow > 0) positives.push(`分析窗近${drawWindow}期，不是固定模板`);

  const sortedByRisk = details.slice().sort((a, b) => {
    const diff = groupRiskScore(a) - groupRiskScore(b);
    if (diff !== 0) return diff;
    return Number(a.identityHeatScore || 0) - Number(b.identityHeatScore || 0);
  });
  const safest = sortedByRisk[0] || null;
  const riskiest = sortedByRisk[sortedByRisk.length - 1] || null;
  const heatSpread = hotCounts.length ? hotCounts.map((count, idx) => `第${idx + 1}組${count}顆`).join('、') : '-';

  if (totalTripleHits === 0) positives.push('主四組沒有撞到高風險三連號');
  else positives.push(`主四組共有 ${totalTripleHits} 組撞到高風險三連號`);
  if (totalPairHits === 0) positives.push('主四組沒有撞到高風險雙連號');
  else positives.push(`主四組共有 ${totalPairHits} 組撞到高風險雙連號`);
  positives.push(`四組熱號顆數：${heatSpread}${hotCounts.every((v) => Number(v) === 0) ? '（0 代表這組沒有落在本期熱號名單，不是未分析）' : ''}`);
  if (safest) {
    const safeReason = [];
    if (!(safest.riskyTripleHits || []).length && !(safest.riskyPairHits || []).length) safeReason.push('未撞雙/三連號');
    safeReason.push(`熱/中/冷 ${Number(safest.hotCount || 0)}/${Number(safest.midCount || 0)}/${Number(safest.coldCount || 0)}`);
    safeReason.push(`暴露 ${Number(safest.groupPairExposure || 0)}/${Number(safest.groupTripleExposure || 0)}`);
    positives.push(`最佳組看第${safest.groupIndex}組：${safeReason.join('、')}`);
  }
  if (features.fullCoverage === 19) positives.push('全車19顆完整承接補位號碼');

  if (riskiest) {
    const riskReason = [];
    if ((riskiest.riskyTripleHits || []).length) riskReason.push(`三連號 ${formatComboList(riskiest.riskyTripleHits, 1)}`);
    if (!(riskiest.riskyTripleHits || []).length && (riskiest.riskyPairHits || []).length) riskReason.push(`雙連號 ${formatComboList(riskiest.riskyPairHits, 2)}`);
    if ((riskiest.riskyNumbers || []).length) riskReason.push(`風險號 ${riskiest.riskyNumbers.join('、')}`);
    riskReason.push(`熱/中/冷 ${Number(riskiest.hotCount || 0)}/${Number(riskiest.midCount || 0)}/${Number(riskiest.coldCount || 0)}`);
    riskReason.push(`雙暴露 ${Number(riskiest.groupPairExposure || 0)}`);
    riskReason.push(`三暴露 ${Number(riskiest.groupTripleExposure || 0)}`);
    negatives.push(`優先留意第${riskiest.groupIndex}組：${riskReason.join('、')}`);
  }

  details.forEach((detail) => {
    const line = summarizeGroupLine(detail);
    if (detail === riskiest) return;
    if ((detail.riskyTripleHits || []).length || (detail.riskyPairHits || []).length || Number(detail.hotCount || 0) >= 3 || (detail.riskyNumbers || []).length >= 2) {
      negatives.push(line);
    }
  });

  if (!negatives.length) {
    negatives.push('四組目前都沒有明顯的雙連號/三連號風險，差異主要只剩熱度配置');
  }
  if ((identityFingerprints || []).length) positives.push(`結構指紋 ${identityFingerprints.map(v => Number(v || 0) % 1000).join('/')}`);
  return { positives: dedupeLabels(positives), negatives: dedupeLabels(negatives), groupBreakdown, safest, riskiest };
}

function buildRecommendationForTracking(lotteryType, tracking, learningState) {
  const bucket = (learningState && learningState.system) || DEFAULT_LEARNING_BUCKET;
  const total = Number(bucket.total || 0);
  const features = buildFeatureSnapshot(tracking);
  const profile = getAnalysisProfile(tracking);
  const {
    analysis,
    details,
    hotCounts,
    riskyNumberCounts,
    riskyPairCounts,
    riskyTripleCounts,
    pairWeights,
    tripleWeights,
    pairExposure,
    tripleExposure,
    identityHeatScores,
    identityFingerprints,
    hotWeights,
    riskyWeights,
    heatScores,
    totalHeatScore,
    totalPairHits,
    totalTripleHits,
    totalRiskyNumbers,
    totalPairWeight,
    totalTripleWeight,
    totalPairExposure,
    totalTripleExposure,
    totalIdentityHeatScore,
    totalIdentityFingerprint,
    totalHotWeight,
    totalRiskyWeight,
    hotSpreadPenalty,
    heatSpreadPenalty,
    denseRiskGroups,
    anyGroupHotOver,
    anyGroupRiskyOver,
    maxPairHits,
    maxTripleHits
  } = profile;

  const basePass = total ? (bucket.labels['恭喜過關'] || 0) / total : 0.55;
  const groupIdentityRisk = details.map((d, idx) => {
    const hotPenalty = Math.max(0, hotCounts[idx] - 2) * 4.5;
    const pairPenalty = Number(pairWeights[idx] || 0) * 6.5 + Number(riskyPairCounts[idx] || 0) * 4.2;
    const triplePenalty = Number(tripleWeights[idx] || 0) * 12 + Number(riskyTripleCounts[idx] || 0) * 9.5;
    const riskyPenalty = Number(riskyWeights[idx] || 0) * 1.0 + Number(riskyNumberCounts[idx] || 0) * 3.2;
    const exposurePenalty = Number(pairExposure[idx] || 0) * 2.1 + Number(tripleExposure[idx] || 0) * 2.9;
    const identityPenalty = Number(identityHeatScores[idx] || 0) * 0.28;
    const fingerprintPenalty = (Number(identityFingerprints[idx] || 0) % 97) * 0.06;
    const heatPenalty = Math.max(0, Number(heatScores[idx] || 0) - 18) * 1.15;
    return hotPenalty + pairPenalty + triplePenalty + riskyPenalty + exposurePenalty + identityPenalty + fingerprintPenalty + heatPenalty;
  });
  const structuralRisk = groupIdentityRisk.reduce((a, b) => a + b, 0);
  const fingerprintDrift = ((totalIdentityFingerprint % 131) * 0.11) + ((totalHotWeight % 17) * 0.3) + ((totalRiskyWeight % 13) * 0.4);

  let tendency = basePass * 100;
  tendency += 15;
  tendency -= structuralRisk * 0.19;
  tendency -= Math.max(0, hotSpreadPenalty - 1) * 2.5;
  tendency -= Math.max(0, heatSpreadPenalty - 3) * 0.7;
  tendency -= Math.max(0, anyGroupHotOver - 2) * 4.0;
  tendency -= Math.max(0, anyGroupRiskyOver - 1) * 5.0;
  tendency -= maxPairHits * 3.0;
  tendency -= maxTripleHits * 5.0;
  tendency -= fingerprintDrift;
  tendency = Math.max(18, Math.min(93, tendency));

  let severeRisk = 4;
  severeRisk += totalPairWeight * 1.8;
  severeRisk += totalTripleWeight * 3.7;
  severeRisk += totalPairExposure * 0.55;
  severeRisk += totalTripleExposure * 0.85;
  severeRisk += Math.max(0, totalRiskyNumbers - 1) * 1.6;
  severeRisk += denseRiskGroups * 2.1;
  severeRisk += Math.max(0, anyGroupHotOver - 2) * 2.2;
  severeRisk += (totalIdentityFingerprint % 89) * 0.07;
  severeRisk = Math.max(3, Math.min(72, severeRisk));

  let retryRate = 100 - tendency - severeRisk;
  retryRate = Math.max(4, Math.min(58, retryRate));

  let reliability = 42 + Math.min(total, ANALYSIS_WINDOW) * 0.12 + Math.min(Number(analysis.evaluatedWindow || analysis.drawCount || 0), ANALYSIS_WINDOW) * 0.18;
  reliability -= severeRisk * 0.09;
  reliability += Math.max(0, 4 - denseRiskGroups) * 1.0;
  reliability += Math.max(0, 10 - hotSpreadPenalty) * 0.25;
  reliability += ((totalIdentityFingerprint % 29) * 0.09);
  reliability += ((totalPairExposure + totalTripleExposure * 2 + totalHeatScore) % 11) * 0.17;
  reliability = Math.max(28, Math.min(89, reliability));

  let riskLevel = '低';
  if (totalTripleWeight >= 4 || totalPairWeight >= 12 || totalTripleExposure >= 8 || totalPairExposure >= 18 || anyGroupRiskyOver >= 3 || maxTripleHits >= 1) riskLevel = '高';
  else if (totalTripleWeight >= 2 || totalPairWeight >= 5 || totalTripleExposure >= 3 || totalPairExposure >= 8 || anyGroupHotOver >= 3 || anyGroupRiskyOver >= 2 || maxPairHits >= 2) riskLevel = '中';

  const score = Math.round(tendency - severeRisk * 0.32 + reliability * 0.24);
  const narrative = buildRiskNarrativeFromAnalysis(features, tracking, profile);

  return {
    trackingId: tracking.id || '',
    trackType: tracking.trackType || 'system',
    sourceName: tracking.sourceName || '',
    passTendency: Number(tendency.toFixed(1)),
    predictedRetryRate: Number(retryRate.toFixed(1)),
    predictedX33Rate: Number(severeRisk.toFixed(1)),
    riskLevel,
    reliability: Number(reliability.toFixed(1)),
    score,
    positives: narrative.positives.slice(0, 4),
    negatives: narrative.negatives.slice(0, 4),
    groupBreakdown: (narrative.groupBreakdown || []).slice(0, 4),
    bestGroupText: narrative.safest ? `第${narrative.safest.groupIndex}組較穩` : '',
    riskGroupText: narrative.riskiest ? `第${narrative.riskiest.groupIndex}組需優先留意` : '',
    structureSummary: `四組熱號顆數：${hotCounts.map((count, idx) => `第${idx + 1}組${count}顆`).join('、')}${hotCounts.every((v) => Number(v) === 0) ? '（0 代表未落入熱號名單，不是沒有分析）' : ''}`,
    actionAdvice: narrative.riskiest ? `先檢查第${narrative.riskiest.groupIndex}組，再決定是否重生。` : '目前四組都可先保留觀察。',
    features,
    debug: {
      totalPairHits,
      totalTripleHits,
      totalPairWeight,
      totalTripleWeight,
      totalPairExposure,
      totalTripleExposure,
      totalIdentityHeatScore,
      totalIdentityFingerprint,
      totalHotWeight,
      totalRiskyWeight,
      totalHeatScore,
      hotCounts,
      riskyNumberCounts,
      heatScores,
      pairExposure,
      tripleExposure,
      identityHeatScores,
      identityFingerprints
    }
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
