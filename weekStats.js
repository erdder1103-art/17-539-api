const fs = require('fs');
const { getTaipeiDate, getTaipeiWeekday } = require('./utils/time');

const { getDataFile, getDataDir } = require('./dataPaths');

const FILE = getDataFile('weekly_stats.json');
const WEEK_539 = ['星期一', '星期二', '星期三', '星期四', '星期五', '星期六'];
const WEEK_TTL = ['星期一', '星期二', '星期三', '星期四', '星期五', '星期六', '星期日'];

function getWeekKey(date = getTaipeiDate()) {
  const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  const dayNum = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const weekNo = Math.ceil((((d - yearStart) / 86400000) + 1) / 7);
  return `${d.getUTCFullYear()}-W${String(weekNo).padStart(2, '0')}`;
}

function createEmpty(type) {
  return {
    week: getWeekKey(),
    summary: {
      passed: 0,
      retry: 0,
      x33: 0,
      jackpot: 0
    },
    daily: {},
    type
  };
}

function readStore() {
  try {
    if (!fs.existsSync(FILE)) {
      return { '539': createEmpty('539'), 'ttl': createEmpty('ttl') };
    }
    const parsed = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    ['539', 'ttl'].forEach((key) => {
      if (!parsed[key]) parsed[key] = createEmpty(key);
      if (parsed[key].summary && typeof parsed[key].summary.fail === 'number') {
        delete parsed[key].summary.fail;
      }
      parsed[key].summary = {
        passed: parsed[key].summary.passed || 0,
        retry: parsed[key].summary.retry || 0,
        x33: parsed[key].summary.x33 || 0,
        jackpot: parsed[key].summary.jackpot || 0
      };
    });
    return parsed;
  } catch (err) {
    return { '539': createEmpty('539'), 'ttl': createEmpty('ttl') };
  }
}

function writeStore(data) {
  fs.mkdirSync(getDataDir(), { recursive: true });
  fs.writeFileSync(FILE, JSON.stringify(data, null, 2), 'utf8');
}

function ensureWeek(record, type) {
  const nowKey = getWeekKey();
  if (!record || record.week !== nowKey) {
    return createEmpty(type);
  }
  return record;
}

function updateWeeklyStats(type, resultLabel) {
  const key = type === 'ttl' ? 'ttl' : '539';
  const store = readStore();
  store[key] = ensureWeek(store[key], key);
  store[key].daily[getTaipeiWeekday()] = resultLabel;

  if (resultLabel === '恭喜過關') store[key].summary.passed += 1;
  else if (resultLabel === '再接再厲') store[key].summary.retry += 1;
  else if (resultLabel === '靠3.3倍') store[key].summary.x33 += 1;
  else if (resultLabel === '發財了各位') store[key].summary.jackpot += 1;

  writeStore(store);
  return store[key];
}

function getWeeklyStats(type) {
  const key = type === 'ttl' ? 'ttl' : '539';
  const store = readStore();
  store[key] = ensureWeek(store[key], key);
  writeStore(store);
  return store[key];
}

function buildWeeklySummaryText(type, weekly) {
  const key = type === 'ttl' ? 'ttl' : '539';
  const title = key === 'ttl' ? '天天樂' : '539';
  const days = key === 'ttl' ? WEEK_TTL : WEEK_539;
  const data = weekly || getWeeklyStats(key);

  const lines = [
    `【${title} 本周成果】`,
    '',
    `恭喜過關：${data.summary.passed}次`,
    `再接再厲：${data.summary.retry}次`,
    `靠3.3倍：${data.summary.x33}次`,
    `發財了各位：${data.summary.jackpot}次`,
    ''
  ];

  days.forEach(day => {
    lines.push(`${day}：${data.daily[day] || ''}`);
  });

  return lines.join('\n');
}

module.exports = {
  getWeekKey,
  updateWeeklyStats,
  getWeeklyStats,
  buildWeeklySummaryText
};
