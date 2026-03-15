const fs = require('fs');
const path = require('path');

const FILE = path.join(__dirname, 'data', 'weekly_stats.json');
const WEEK_539 = ['星期一', '星期二', '星期三', '星期四', '星期五', '星期六'];
const WEEK_TTL = ['星期一', '星期二', '星期三', '星期四', '星期五', '星期六', '星期日'];

function getWeekKey(date = new Date()) {
  const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  const dayNum = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const weekNo = Math.ceil((((d - yearStart) / 86400000) + 1) / 7);
  return `${d.getUTCFullYear()}-W${String(weekNo).padStart(2, '0')}`;
}

function baseSummary() {
  return { passed: 0, fail: 0, retry: 0, x33: 0, jackpot: 0 };
}

function createWeekRecord(type, week) {
  return { week: week || getWeekKey(), summary: baseSummary(), daily: {}, type };
}

function createTypeStore(type) {
  const current = createWeekRecord(type, getWeekKey());
  return { current, history: {} };
}

function readStore() {
  try {
    if (!fs.existsSync(FILE)) {
      return { '539': createTypeStore('539'), 'ttl': createTypeStore('ttl') };
    }
    const data = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    for (const key of ['539', 'ttl']) {
      if (!data[key]) data[key] = createTypeStore(key);
      if (!data[key].current) data[key].current = createWeekRecord(key, getWeekKey());
      if (!data[key].history) data[key].history = {};
      if (!data[key].current.summary) data[key].current.summary = baseSummary();
      if (!data[key].current.daily) data[key].current.daily = {};
    }
    return data;
  } catch (err) {
    return { '539': createTypeStore('539'), 'ttl': createTypeStore('ttl') };
  }
}

function writeStore(data) {
  fs.writeFileSync(FILE, JSON.stringify(data, null, 2), 'utf8');
}

function ensureWeek(typeStore, type) {
  const nowKey = getWeekKey();
  if (typeStore.current.week !== nowKey) {
    typeStore.history[typeStore.current.week] = typeStore.current;
    typeStore.current = createWeekRecord(type, nowKey);
  }
  return typeStore;
}

function weekdayText() {
  const map = ['星期日', '星期一', '星期二', '星期三', '星期四', '星期五', '星期六'];
  return map[new Date().getDay()];
}

function updateWeeklyStats(type, resultLabel) {
  const key = type === 'ttl' ? 'ttl' : '539';
  const store = readStore();
  store[key] = ensureWeek(store[key], key);
  store[key].current.daily[weekdayText()] = resultLabel;

  if (resultLabel === '恭喜過關') store[key].current.summary.passed += 1;
  else if (resultLabel === '沒過') store[key].current.summary.fail += 1;
  else if (resultLabel === '再接再厲') store[key].current.summary.retry += 1;
  else if (resultLabel === '靠3.3倍') store[key].current.summary.x33 += 1;
  else if (resultLabel === '發財了各位') store[key].current.summary.jackpot += 1;

  writeStore(store);
  return store[key].current;
}

function getWeeklyStats(type) {
  const key = type === 'ttl' ? 'ttl' : '539';
  const store = readStore();
  store[key] = ensureWeek(store[key], key);
  writeStore(store);
  return store[key].current;
}

function getWeeklyByWeek(type, week) {
  const key = type === 'ttl' ? 'ttl' : '539';
  const store = readStore();
  store[key] = ensureWeek(store[key], key);
  writeStore(store);
  if (!week || store[key].current.week === week) return store[key].current;
  return store[key].history[week] || null;
}

function listWeeklyHistory(type) {
  const key = type === 'ttl' ? 'ttl' : '539';
  const store = readStore();
  store[key] = ensureWeek(store[key], key);
  writeStore(store);
  const weeks = [store[key].current.week, ...Object.keys(store[key].history).sort().reverse()];
  return Array.from(new Set(weeks));
}

function buildWeeklySummaryText(type, weekly) {
  const key = type === 'ttl' ? 'ttl' : '539';
  const title = key === 'ttl' ? '天天樂' : '539';
  const days = key === 'ttl' ? WEEK_TTL : WEEK_539;
  const data = weekly || getWeeklyStats(key);

  const lines = [
    `【${title} 本周成果】`,
    `週別：${data.week}`,
    '',
    `恭喜過關：${data.summary.passed}次`,
    `再接再厲：${data.summary.retry}次`,
    `靠3.3倍：${data.summary.x33}次`,
    `發財了各位：${data.summary.jackpot}次`,
    ''
  ];
  days.forEach(day => lines.push(`${day}：${data.daily[day] || ''}`));
  return lines.join('\n');
}

module.exports = { getWeekKey, updateWeeklyStats, getWeeklyStats, getWeeklyByWeek, listWeeklyHistory, buildWeeklySummaryText };
