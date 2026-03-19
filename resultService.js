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
    const warmNumbers = Array.isArray(analysis.warmNumbers) ? analysis.warmNumbers.map(pad2) : [];
    const trendUpNumbers = Array.isArray(analysis.trendUpNumbers) ? analysis.trendUpNumbers.map(pad2) : [];
    const trendDownNumbers = Array.isArray(analysis.trendDownNumbers) ? analysis.trendDownNumbers.map(pad2) : [];
    const warmSet = new Set(warmNumbers);
    const trendUpSet = new Set(trendUpNumbers);
    const trendDownSet = new Set(trendDownNumbers);
    const hotCount = g.filter(n => hotSet.has(n)).length;
    const warmCount = g.filter(n => warmSet.has(n)).length;
    const midCount = g.filter(n => midSet.has(n)).length;
    const coldCount = g.filter(n => coldSet.has(n)).length;
    const trendUpCount = g.filter(n => trendUpSet.has(n)).length;
    const trendDownCount = g.filter(n => trendDownSet.has(n)).length;
    const riskyNumbers = g.filter(n => riskySet.has(n));
    const groupHeatScore = g.reduce((sum, n) => sum + Number(counts[n] || 0), 0);
    const groupTrendScore = g.reduce((sum, n) => sum + Number((analysis.trendScoreMap || {})[n] || 0), 0);
    const groupPairExposure = sumAllPairExposure(g, analysis.pairWeightMap || analysis.pairCounts || {});
    const groupTripleExposure = sumAllTripleExposure(g, analysis.tripleWeightMap || analysis.tripleCounts || {});
    const identityHeatScore = exactNumberIdentityScore(g, counts);
    const identityFingerprint = exactNumberFingerprint(g, counts);
    const tailBuckets = {};
    const decadeBuckets = {};
    const sortedNums = g.map(Number).sort((a,b)=>a-b);
    const adjacentPairs = [];
    sortedNums.forEach((num, pos) => {
      const tail = String(num % 10);
      const decade = String(Math.floor(num / 10));
      tailBuckets[tail] = (tailBuckets[tail] || 0) + 1;
      decadeBuckets[decade] = (decadeBuckets[decade] || 0) + 1;
      if (pos > 0 && sortedNums[pos] - sortedNums[pos - 1] === 1) {
        adjacentPairs.push(`${String(sortedNums[pos - 1]).padStart(2, '0')}-${String(sortedNums[pos]).padStart(2, '0')}`);
      }
    });
    const oddCount = g.filter(n => Number(n) % 2 === 1).length;
    const spanValue = sortedNums.length ? sortedNums[sortedNums.length - 1] - sortedNums[0] : 0;
    return {
      groupIndex: idx + 1,
      groupNumbers: g,
      hotCount,
      warmCount,
      midCount,
      coldCount,
      trendUpCount,
      trendDownCount,
      riskyNumbers,
      riskyPairHits,
      riskyTripleHits,
      groupHeatScore,
      groupTrendScore,
      groupPairExposure,
      groupTripleExposure,
      identityHeatScore,
      identityFingerprint,
      tailFocus: Math.max(0, ...Object.values(tailBuckets)),
      decadeFocus: Math.max(0, ...Object.values(decadeBuckets)),
      oddCount,
      evenCount: g.length - oddCount,
      spanValue,
      adjacentPairs,
      frequencyScores: g.map(n => Number(counts[n] || 0))
    };
  });

  return {
    ...analysis,
    counts,
    hotNumbers,
    warmNumbers: Array.isArray(analysis.warmNumbers) ? analysis.warmNumbers.map(pad2) : [],
    coldNumbers,
    midNumbers,
    trendUpNumbers: Array.isArray(analysis.trendUpNumbers) ? analysis.trendUpNumbers.map(pad2) : [],
    trendDownNumbers: Array.isArray(analysis.trendDownNumbers) ? analysis.trendDownNumbers.map(pad2) : [],
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



function buildGroupVisualMetrics(detail) {
  const pairExposure = Number(detail.groupPairExposure || 0);
  const tripleExposure = Number(detail.groupTripleExposure || 0);
  const riskyNums = Array.isArray(detail.riskyNumbers) ? detail.riskyNumbers.filter(Boolean) : [];
  const pairHits = Array.isArray(detail.riskyPairHits) ? detail.riskyPairHits.filter(Boolean) : [];
  const tripleHits = Array.isArray(detail.riskyTripleHits) ? detail.riskyTripleHits.filter(Boolean) : [];
  const hotCount = Number(detail.hotCount || 0);
  const warmCount = Number(detail.warmCount || 0);
  const midCount = Number(detail.midCount || 0);
  const coldCount = Number(detail.coldCount || 0);
  const trendUpCount = Number(detail.trendUpCount || 0);
  const trendDownCount = Number(detail.trendDownCount || 0);
  const fingerprint = Number(detail.identityFingerprint || 0);
  const heatScore = Number(detail.groupHeatScore || 0);
  const trendScore = Number(detail.groupTrendScore || 0);
  const tailFocus = Number(detail.tailFocus || 0);
  const decadeFocus = Number(detail.decadeFocus || 0);
  const adjacency = Array.isArray(detail.adjacentPairs) ? detail.adjacentPairs.length : 0;
  const oddCount = Number(detail.oddCount || 0);
  const spanValue = Number(detail.spanValue || 0);
  const fingerprintBucket = Math.abs(fingerprint % 7);
  const balanceGap = Math.abs(hotCount - 1.5) + Math.abs(pairExposure - 1.2) * 0.7 + Math.abs(tripleExposure - 0.4) * 1.2 + Math.max(0, tailFocus - 2) * 0.9 + Math.abs(oddCount - 2.5) * 0.7;
  const riskScore = pairExposure * 1.2 + tripleExposure * 2.8 + riskyNums.length * 1.45 + pairHits.length * 2.7 + tripleHits.length * 4.8 + Math.max(0, hotCount - 2) * 1.15 + Math.max(0, coldCount - 2) * 0.8 + Math.max(0, tailFocus - 2) * 1.4 + Math.max(0, decadeFocus - 2) * 1.1 + adjacency * 1.1 + balanceGap * 0.9 + fingerprintBucket * 0.18 - Math.min(2, trendUpCount) * 0.8;
  let structureType = '均衡控風';
  if (tripleHits.length || tripleExposure >= 2) structureType = '三碰撞暴露';
  else if (pairHits.length || pairExposure >= 8) structureType = '雙碰撞偏高';
  else if (tailFocus >= 3 || decadeFocus >= 3) structureType = '區段過度集中';
  else if (hotCount >= 3) structureType = '熱號集中';
  else if (coldCount >= 3 && trendUpCount === 0) structureType = '冷號保守';
  else if (trendUpCount >= 2 && hotCount <= 2) structureType = '轉熱承接';
  else if (riskyNums.length >= 3) structureType = '高風險號堆疊';
  const lineText = `第${detail.groupIndex}組【${structureType}】${detail.groupNumbers.join(' ')}｜熱/溫/中/冷 ${hotCount}/${warmCount}/${midCount}/${coldCount}｜轉熱 ${trendUpCount}｜雙連號 ${pairHits.length ? pairHits.join('、') : '無'}｜三連號 ${tripleHits.length ? tripleHits.join('、') : '無'}｜風險號 ${riskyNums.length ? riskyNums.join('、') : '無'}｜雙暴露 ${pairExposure}｜三暴露 ${tripleExposure}｜尾數集中 ${tailFocus}｜十位集中 ${decadeFocus}｜分數 ${riskScore.toFixed(1)}`;
  return {
    detail,
    pairExposure,
    tripleExposure,
    riskyNums,
    pairHits,
    tripleHits,
    hotCount,
    warmCount,
    midCount,
    coldCount,
    trendUpCount,
    trendDownCount,
    fingerprint,
    heatScore,
    trendScore,
    tailFocus,
    decadeFocus,
    adjacency,
    oddCount,
    spanValue,
    fingerprintBucket,
    balanceGap,
    riskScore,
    structureType,
    lineText
  };
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
  const { analysis, details, totalPairHits, totalTripleHits, hotCounts, pairExposure, tripleExposure, identityHeatScores, identityFingerprints } = useProfile;
  const positives = [];
  const negatives = [];
  if (Number(analysis.drawCount || 0) > 0) positives.push(`已依近${analysis.evaluatedWindow || ANALYSIS_WINDOW}期資料檢查主四組碰撞風險`);

  const safest = details.slice().sort((a, b) => {
    const aRisk = Number(a.groupPairExposure || 0) + Number(a.groupTripleExposure || 0) * 2 + (Array.isArray(a.riskyNumbers) ? a.riskyNumbers.length : 0);
    const bRisk = Number(b.groupPairExposure || 0) + Number(b.groupTripleExposure || 0) * 2 + (Array.isArray(b.riskyNumbers) ? b.riskyNumbers.length : 0);
    if (aRisk !== bRisk) return aRisk - bRisk;
    return Number(a.identityHeatScore || 0) - Number(b.identityHeatScore || 0);
  });
  const heatSpread = hotCounts.length ? `${hotCounts.join('/')}` : '-';
  if (totalTripleHits === 0) positives.push('主四組未落入高風險三連號同組');
  else positives.push(`主四組僅 ${totalTripleHits} 組命中高風險三連號`);
  if (totalPairHits === 0) positives.push('主四組未命中高風險雙號同組');
  else positives.push(`主四組共有 ${totalPairHits} 組碰到高風險雙號`);
  positives.push(`主四組熱號分布 ${heatSpread}`);
  if (safest[0]) positives.push(`第${safest[0].groupIndex}組碰撞密度最低（指紋 ${Number(safest[0].identityFingerprint || 0) % 1000}）`);
  if (features.fullCoverage === 19) positives.push('全車19顆完整承接補位號碼');

  details.forEach((detail) => {
    const tripleHits = Array.isArray(detail.riskyTripleHits) ? detail.riskyTripleHits : [];
    const pairHits = Array.isArray(detail.riskyPairHits) ? detail.riskyPairHits : [];
    const riskyNums = Array.isArray(detail.riskyNumbers) ? detail.riskyNumbers : [];
    if (tripleHits.length) negatives.push(`第${detail.groupIndex}組含高風險三連號 ${String(tripleHits[0]).split('-').join('、')}`);
    else if (pairHits.length) negatives.push(`第${detail.groupIndex}組含高風險雙號 ${String(pairHits[0]).split('-').join('、')}`);
    else if (riskyNums.length >= 2) negatives.push(`第${detail.groupIndex}組高風險號偏多（${riskyNums.slice(0, 3).join('、')}）`);
    else if (Number(detail.hotCount || 0) >= 3) negatives.push(`第${detail.groupIndex}組熱號集中 ${detail.hotCount} 顆`);
    else negatives.push(`第${detail.groupIndex}組暴露值 ${Number(detail.groupPairExposure || 0) + Number(detail.groupTripleExposure || 0) * 2}`);
  });

  const mostExposed = details.slice().sort((a, b) => {
    const aRisk = Number(a.groupPairExposure || 0) + Number(a.groupTripleExposure || 0) * 2 + (Array.isArray(a.riskyNumbers) ? a.riskyNumbers.length : 0) + Number(a.hotCount || 0) * 0.5;
    const bRisk = Number(b.groupPairExposure || 0) + Number(b.groupTripleExposure || 0) * 2 + (Array.isArray(b.riskyNumbers) ? b.riskyNumbers.length : 0) + Number(b.hotCount || 0) * 0.5;
    if (aRisk !== bRisk) return bRisk - aRisk;
    return Number(b.identityHeatScore || 0) - Number(a.identityHeatScore || 0);
  });
  if (mostExposed[0]) negatives.unshift(`第${mostExposed[0].groupIndex}組需優先留意（熱度 ${mostExposed[0].hotCount || 0}、雙號暴露 ${mostExposed[0].groupPairExposure || 0}、三號暴露 ${mostExposed[0].groupTripleExposure || 0}）`);
  if ((identityFingerprints || []).length) positives.push(`整體結構指紋 ${identityFingerprints.map(v => Number(v || 0) % 1000).join('/')}`);
  return { positives: dedupeLabels(positives), negatives: dedupeLabels(negatives) };
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

  const metrics = details.map(buildGroupVisualMetrics);
  const totalPairExposureVisual = metrics.reduce((sum, item) => sum + item.pairExposure, 0);
  const totalTripleExposureVisual = metrics.reduce((sum, item) => sum + item.tripleExposure, 0);
  const totalPairHitsVisual = metrics.reduce((sum, item) => sum + item.pairHits.length, 0);
  const totalTripleHitsVisual = metrics.reduce((sum, item) => sum + item.tripleHits.length, 0);
  const riskyGroupCount = metrics.filter((item) => item.riskScore >= 9).length;
  const hotSpread = hotCounts.length ? Math.max(...hotCounts) - Math.min(...hotCounts) : 0;
  const scoreSpread = metrics.length ? Math.max(...metrics.map((item) => item.riskScore)) - Math.min(...metrics.map((item) => item.riskScore)) : 0;
  const stableGroupCount = metrics.filter((item) => item.pairHits.length === 0 && item.tripleHits.length === 0 && item.riskScore < 8.5).length;
  const riskyNumberCoverage = metrics.reduce((sum, item) => sum + item.riskyNums.length, 0);
  const heatAverage = metrics.length ? metrics.reduce((sum, item) => sum + item.heatScore, 0) / metrics.length : 0;
  const trendAverage = metrics.length ? metrics.reduce((sum, item) => sum + item.trendScore, 0) / metrics.length : 0;
  const drawCount = Number(analysis.evaluatedWindow || analysis.drawCount || 0);
  const safest = metrics.slice().sort((a, b) => a.riskScore - b.riskScore || a.heatScore - b.heatScore || a.detail.groupIndex - b.detail.groupIndex)[0];
  const riskiest = metrics.slice().sort((a, b) => b.riskScore - a.riskScore || b.heatScore - a.heatScore || a.detail.groupIndex - b.detail.groupIndex)[0];
  const midRisk = metrics.slice().sort((a, b) => b.riskScore - a.riskScore || b.hotCount - a.hotCount)[1];

  let profileLabel = '平衡型';
  if (totalTripleHitsVisual >= 1 || totalTripleExposureVisual >= 20) profileLabel = '三碰撞警戒型';
  else if (totalPairHitsVisual >= 2 || totalPairExposureVisual >= 36) profileLabel = '雙碰撞偏高型';
  else if (hotSpread >= 3 || metrics.some((item) => item.hotCount >= 4)) profileLabel = '熱號偏斜型';
  else if (stableGroupCount >= 3 && riskyNumberCoverage <= 5) profileLabel = '均衡穩定型';
  else if (heatAverage < 28 && riskyNumberCoverage <= 4) profileLabel = '冷號保守型';
  else if (trendAverage >= 6) profileLabel = '轉熱承接型';

  const bestReasons = [];
  const worstReasons = [];
  if (safest) {
    if (safest.tripleHits.length === 0 && safest.pairHits.length === 0) bestReasons.push('未撞高風險雙/三碰');
    if (safest.hotCount <= 2) bestReasons.push(`熱號控制 ${safest.hotCount} 顆`);
    if (safest.trendUpCount >= 1) bestReasons.push(`帶轉熱 ${safest.trendUpCount} 顆`);
    if (safest.tailFocus <= 2 && safest.decadeFocus <= 2) bestReasons.push('尾數與十位分散');
    if (!bestReasons.length) bestReasons.push(`暴露值 ${safest.riskScore.toFixed(1)}`);
  }
  if (riskiest) {
    if (riskiest.tripleHits.length) worstReasons.push(`含三碰撞 ${String(riskiest.tripleHits[0]).replace(/-/g, '、')}`);
    if (!worstReasons.length && riskiest.pairHits.length) worstReasons.push(`含雙碰撞 ${String(riskiest.pairHits[0]).replace(/-/g, '、')}`);
    if (riskiest.tailFocus >= 3) worstReasons.push(`尾數集中 ${riskiest.tailFocus}`);
    if (riskiest.decadeFocus >= 3) worstReasons.push(`十位區集中 ${riskiest.decadeFocus}`);
    if (riskiest.riskyNums.length >= 2) worstReasons.push(`風險號 ${riskiest.riskyNums.slice(0, 3).join('、')}`);
    if (!worstReasons.length) worstReasons.push(`暴露值 ${riskiest.riskScore.toFixed(1)}`);
  }

  let structureSummary = `四組熱/溫/中/冷：${metrics.map((item) => `${item.hotCount}/${item.warmCount}/${item.midCount}/${item.coldCount}`).join('｜')}`;
  if (profileLabel === '均衡穩定型') structureSummary += '，大多數組別沒有撞到高風險雙/三碰。';
  else if (profileLabel === '熱號偏斜型') structureSummary += `，熱號落差 ${hotSpread}，熱區偏向少數組別。`;
  else if (profileLabel === '冷號保守型') structureSummary += '，冷號比例高，進攻性偏弱。';
  else if (profileLabel === '轉熱承接型') structureSummary += '，有帶近期升溫號，不是單純亂抽。';

  let actionAdvice = '建議維持目前四組與全車配置，可直接觀察開獎。';
  if (riskLevel === '高') actionAdvice = `建議優先替換第${riskiest?.detail?.groupIndex || '?'}組，再重新生成一次較安全。`;
  else if (riskLevel === '中') actionAdvice = `建議保留第${safest?.detail?.groupIndex || '?'}組，並檢查第${riskiest?.detail?.groupIndex || '?'}組是否要換號。`;
  else if (profileLabel === '冷號保守型') actionAdvice = '整體偏保守，可直接追蹤；若要提高進攻性，可補 1 碼轉熱號。';
  else if (profileLabel === '轉熱承接型') actionAdvice = '這套不是純隨機，已帶近期升溫號；可直接追或只微調高風險組。';

  const positives = [];
  const negatives = [];
  positives.push(`分析窗近 ${drawCount} 期，已同步熱號/雙連號/三連號/轉熱分布`);
  if (safest) positives.push(`最佳組是第${safest.detail.groupIndex}組：${bestReasons.slice(0, 4).join('、')}`);
  if (stableGroupCount >= 2) positives.push(`低風險組共有 ${stableGroupCount} 組`);
  positives.push(structureSummary);
  if (riskiest) negatives.push(`優先留意第${riskiest.detail.groupIndex}組：${worstReasons.slice(0, 4).join('、')}`);
  if (midRisk && riskiest && midRisk.detail.groupIndex !== riskiest.detail.groupIndex && midRisk.riskScore >= 8.5) negatives.push(`次風險組第${midRisk.detail.groupIndex}組也偏高（${midRisk.structureType}）`);
  negatives.push(`總雙號暴露 ${totalPairExposureVisual}、總三號暴露 ${totalTripleExposureVisual}`);
  negatives.push(actionAdvice);

  return {
    trackingId: tracking.id || '',
    trackType: tracking.trackType || 'system',
    sourceName: tracking.sourceName || '',
    passTendency: Number(tendency.toFixed(1)),
    predictedRetryRate: Number(retryRate.toFixed(1)),
    predictedX33Rate: Number(severeRisk.toFixed(1)),
    riskLevel: `${riskLevel}｜${profileLabel}`,
    reliability: Number(reliability.toFixed(1)),
    score,
    positives: dedupeLabels(positives).slice(0, 4),
    negatives: dedupeLabels(negatives).slice(0, 4),
    bestGroupText: safest ? `第${safest.detail.groupIndex}組較穩：${bestReasons.slice(0, 3).join('、')}` : '',
    riskGroupText: riskiest ? `第${riskiest.detail.groupIndex}組風險最高：${worstReasons.slice(0, 3).join('、')}` : '',
    structureSummary,
    actionAdvice,
    profile: profileLabel,
    groupLineTexts: metrics.map((item) => item.lineText),
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
      identityFingerprints,
      riskyGroupCount,
      hotSpread,
      scoreSpread
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
