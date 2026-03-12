const fs = require('fs');
const path = require('path');
const { normalizeLotteryType } = require('./trackingStore');

const WEEKLY_FILE = path.join(__dirname, 'data', 'weekly_stats.json');

const DAYS_539 = ['星期一', '星期二', '星期三', '星期四', '星期五', '星期六'];
const DAYS_TTL = ['星期一', '星期二', '星期三', '星期四', '星期五', '星期六', '星期日'];

function ensureJson(file, fallback) {
  const dir = path.dirname(file);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  if (!fs.existsSync(file)) {
    fs.writeFileSync(file, JSON.stringify(fallback, null, 2), 'utf8');
  }
}

function readJson(file, fallback) {
  ensureJson(file, fallback);
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    return fallback;
  }
}

function writeJson(file, data) {
  ensureJson(file, data);
  fs.writeFileSync(file, JSON.stringify(data, null, 2), 'utf8');
}

function getWeekStart(dateLike) {
  const d = dateLike ? new Date(dateLike) : new Date();
  const copy = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  const day = copy.getDay();
  const diff = day === 0 ? -6 : 1 - day;
  copy.setDate(copy.getDate() + diff);
  return copy;
}

function fmtDate(d) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function getWeekKey(dateLike) {
  const start = getWeekStart(dateLike);
  return fmtDate(start);
}

function defaultTypeStats() {
  return {
    weekKey: getWeekKey(),
    summary: {
      passed: 0,
      fail: 0,
      retry: 0,
      x3: 0
    },
    daily: {}
  };
}

function getDefaultStats() {
  return {
    '539': defaultTypeStats(),
    'ttl': defaultTypeStats()
  };
}

function resetIfNewWeek(stats, type, dateLike) {
  const currentKey = getWeekKey(dateLike);
  if (!stats[type] || stats[type].weekKey !== currentKey) {
    stats[type] = defaultTypeStats();
    stats[type].weekKey = currentKey;
  }
}

async function updateWeeklyStats(lotteryType, resultRecord) {
  const type = normalizeLotteryType(lotteryType);
  const stats = readJson(WEEKLY_FILE, getDefaultStats());

  resetIfNewWeek(stats, type, resultRecord.drawDate);

  const code = resultRecord.outcome.code;
  if (code === 'passed') stats[type].summary.passed += 1;
  else if (code === 'fail') stats[type].summary.fail += 1;
  else if (code === 'retry') stats[type].summary.retry += 1;
  else if (code === 'x3') stats[type].summary.x3 += 1;

  if (resultRecord.weekday) {
    stats[type].daily[resultRecord.weekday] = resultRecord.outcome.label;
  }

  writeJson(WEEKLY_FILE, stats);
  return stats[type];
}

function getWeeklyStats(lotteryType, dateLike) {
  const type = normalizeLotteryType(lotteryType);
  const stats = readJson(WEEKLY_FILE, getDefaultStats());
  resetIfNewWeek(stats, type, dateLike);
  writeJson(WEEKLY_FILE, stats);
  return stats[type];
}

function buildWeeklyStatsMessage(lotteryType, dateLike) {
  const type = normalizeLotteryType(lotteryType);
  const title = type === 'ttl' ? '天天樂' : '539';
  const weekDays = type === 'ttl' ? DAYS_TTL : DAYS_539;
  const stats = getWeeklyStats(type, dateLike);

  const lines = [
    `【${title} 本周統計】`,
    '',
    `已過關：${stats.summary.passed}次`,
    `沒過：${stats.summary.fail}次`,
    `再接再厲：${stats.summary.retry}次`,
    `靠3.3倍：${stats.summary.x3}次`,
    ''
  ];

  weekDays.forEach((day) => {
    lines.push(`${day}：${stats.daily[day] || ''}`);
  });

  return lines.join('\n');
}

module.exports = {
  updateWeeklyStats,
  getWeeklyStats,
  buildWeeklyStatsMessage
};
