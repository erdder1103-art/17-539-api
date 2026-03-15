const fs = require('fs');
const path = require('path');

const FILE = path.join(__dirname, 'data', 'learning_weights.json');

function emptyType(type) {
  return {
    type,
    updatedAt: '',
    sampleCount: 0,
    finalCounts: { pass: 0, retry: 0, x33: 0, jackpot: 0 },
    numberPenalty: {},
    pairPenalty: {},
    groupPenalty: { bucket: { '1': 0, '2': 0, '3': 0, '4': 0 }, tail: {}, adjacency: 0 },
    recentBadShots: []
  };
}

function readStore() {
  try {
    if (!fs.existsSync(FILE)) return { '539': emptyType('539'), 'ttl': emptyType('ttl') };
    const data = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    if (!data['539']) data['539'] = emptyType('539');
    if (!data['ttl']) data['ttl'] = emptyType('ttl');
    return data;
  } catch (err) {
    return { '539': emptyType('539'), 'ttl': emptyType('ttl') };
  }
}

function writeStore(data) {
  fs.writeFileSync(FILE, JSON.stringify(data, null, 2), 'utf8');
}

function numberBucket(n) {
  const v = parseInt(n, 10);
  if (v <= 10) return '1';
  if (v <= 20) return '2';
  if (v <= 30) return '3';
  return '4';
}

function tailDigit(n) {
  return String(parseInt(String(n).slice(-1), 10));
}

function comboKey(nums) {
  return [...nums].sort((a,b)=>parseInt(a,10)-parseInt(b,10)).join('-');
}

function getCombinations(arr, k) {
  const result = [];
  function walk(start, path) {
    if (path.length === k) {
      result.push([...path]);
      return;
    }
    for (let i = start; i < arr.length; i++) {
      path.push(arr[i]);
      walk(i + 1, path);
      path.pop();
    }
  }
  walk(0, []);
  return result;
}

function nowTaipei() {
  const parts = new Intl.DateTimeFormat('zh-TW', {
    timeZone: 'Asia/Taipei',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false
  }).formatToParts(new Date());
  const pick = (type) => parts.find(x => x.type === type)?.value || '';
  return `${pick('year')}-${pick('month')}-${pick('day')} ${pick('hour')}:${pick('minute')}:${pick('second')}`;
}

function severityByLabel(label) {
  if (label === '發財了各位') return 4;
  if (label === '靠3.3倍') return 3;
  if (label === '再接再厲') return 2;
  return 0;
}

function touch(obj, key, delta) {
  obj[key] = Number(obj[key] || 0) + delta;
}

function updateFromResult(type, tracking, draw, resultMap, finalLabel) {
  const key = type === 'ttl' ? 'ttl' : '539';
  const store = readStore();
  const w = store[key] || emptyType(key);

  w.updatedAt = nowTaipei();
  w.sampleCount += 1;
  if (finalLabel === '恭喜過關') w.finalCounts.pass += 1;
  else if (finalLabel === '再接再厲') w.finalCounts.retry += 1;
  else if (finalLabel === '靠3.3倍') w.finalCounts.x33 += 1;
  else if (finalLabel === '發財了各位') w.finalCounts.jackpot += 1;

  const severity = severityByLabel(finalLabel);
  const groups = tracking.groups || {};
  const allGroupEntries = [
    ['group1', groups.group1 || [], resultMap.group1 || 0],
    ['group2', groups.group2 || [], resultMap.group2 || 0],
    ['group3', groups.group3 || [], resultMap.group3 || 0],
    ['group4', groups.group4 || [], resultMap.group4 || 0]
  ];

  if (severity > 0) {
    const badGroups = allGroupEntries.filter(([, nums, hit]) => hit >= 2);
    badGroups.forEach(([name, nums, hit]) => {
      const localDelta = hit >= 4 ? 6 : hit === 3 ? 4 : 2;
      nums.forEach(n => {
        touch(w.numberPenalty, n, localDelta * severity);
        touch(w.groupPenalty.bucket, numberBucket(n), 0.4 * severity);
        touch(w.groupPenalty.tail, tailDigit(n), 0.5 * severity);
      });

      getCombinations(nums, 2).forEach(pair => {
        touch(w.pairPenalty, comboKey(pair), localDelta * severity * 1.5);
      });

      const sorted = [...nums].sort((a,b)=>parseInt(a,10)-parseInt(b,10));
      for (let i = 0; i < sorted.length - 1; i++) {
        const a = parseInt(sorted[i], 10);
        const b = parseInt(sorted[i + 1], 10);
        if (b - a === 1) w.groupPenalty.adjacency += 0.8 * severity;
        if (b - a === 2) w.groupPenalty.adjacency += 0.3 * severity;
      }

      w.recentBadShots.unshift({ at: nowTaipei(), group: name, hit, numbers: nums, draw });
    });
    w.recentBadShots = w.recentBadShots.slice(0, 30);
  } else {
    Object.keys(w.numberPenalty).forEach(k => { w.numberPenalty[k] = Math.max(0, Number(w.numberPenalty[k] || 0) * 0.995); });
    Object.keys(w.pairPenalty).forEach(k => { w.pairPenalty[k] = Math.max(0, Number(w.pairPenalty[k] || 0) * 0.992); });
    Object.keys(w.groupPenalty.bucket).forEach(k => { w.groupPenalty.bucket[k] = Math.max(0, Number(w.groupPenalty.bucket[k] || 0) * 0.99); });
    Object.keys(w.groupPenalty.tail).forEach(k => { w.groupPenalty.tail[k] = Math.max(0, Number(w.groupPenalty.tail[k] || 0) * 0.99); });
    w.groupPenalty.adjacency = Math.max(0, Number(w.groupPenalty.adjacency || 0) * 0.99);
  }

  store[key] = w;
  writeStore(store);
  return w;
}

function getWeights(type) {
  const key = type === 'ttl' ? 'ttl' : '539';
  return readStore()[key] || emptyType(key);
}

function summarizeWeights(type) {
  const w = getWeights(type);
  return {
    updatedAt: w.updatedAt,
    sampleCount: w.sampleCount,
    finalCounts: w.finalCounts,
    topNumbers: Object.entries(w.numberPenalty || {}).sort((a,b)=>b[1]-a[1]).slice(0,10),
    topPairs: Object.entries(w.pairPenalty || {}).sort((a,b)=>b[1]-a[1]).slice(0,10),
    groupPenalty: w.groupPenalty,
    recentBadShots: (w.recentBadShots || []).slice(0,8)
  };
}

module.exports = { updateFromResult, getWeights, summarizeWeights };
