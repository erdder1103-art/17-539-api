const fs = require('fs');
const path = require('path');
const { getActiveTracking, normalizeLotteryType } = require('./trackingStore');
const { sendTelegramMessage } = require('./telegram');
const { updateWeeklyStats, buildWeeklyStatsMessage } = require('./weekStats');

const RESULT_STATE_FILE = path.join(__dirname, 'data', 'result_state.json');
const RESULT_HISTORY_FILE = path.join(__dirname, 'data', 'result_history.json');

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

function countHits(group, drawNumbers) {
  const set = new Set(drawNumbers);
  return group.filter((n) => set.has(n)).length;
}

function getWeekdayZh(dateStr) {
  const m = String(dateStr || '').match(/^(\d{4})\/(\d{1,2})\/(\d{1,2})$/);
  if (!m) return '';
  const dt = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  const days = ['星期日', '星期一', '星期二', '星期三', '星期四', '星期五', '星期六'];
  return days[dt.getDay()] || '';
}

function evaluateOutcome(hitMap) {
  const mainHits = [hitMap.group1, hitMap.group2, hitMap.group3, hitMap.group4];
  const maxMain = Math.max(...mainHits, 0);
  const fullHits = hitMap.full || 0;

  if (maxMain >= 3) {
    return { code: 'passed', label: '恭喜過關', reason: '任一主組命中 3 顆以上' };
  }
  if (fullHits >= 3) {
    return { code: 'x3', label: '靠3.3倍', reason: '全車號碼命中 3 顆以上' };
  }
  if (maxMain === 2 || fullHits === 2) {
    return { code: 'retry', label: '再接再厲', reason: '主組或全車命中 2 顆' };
  }
  return { code: 'fail', label: '沒過', reason: '未達追蹤門檻' };
}

function buildResultMessage(record, draw) {
  const lines = [
    `【${record.lotteryTitle}開獎核對】`,
    `期數：${draw.issue || '-'}`,
    `日期：${draw.date || '-'}`,
    `開獎號碼：${draw.numbers.join(' ')}`,
    ''
  ];

  lines.push(`${record.labels.group1}：命中 ${record.hitMap.group1} 顆`);
  lines.push(`${record.labels.group2}：命中 ${record.hitMap.group2} 顆`);
  lines.push(`${record.labels.group3}：命中 ${record.hitMap.group3} 顆`);
  lines.push(`${record.labels.group4}：命中 ${record.hitMap.group4} 顆`);
  lines.push(`${record.labels.full}：命中 ${record.hitMap.full} 顆`);
  lines.push('');
  lines.push(`結果：${record.outcome.label}`);
  lines.push(`說明：${record.outcome.reason}`);

  return lines.join('\n');
}

async function processLatestDraw(lotteryType, draw) {
  const type = normalizeLotteryType(lotteryType);
  if (!draw || !draw.issue || !Array.isArray(draw.numbers) || draw.numbers.length !== 5) {
    return { ok: false, skipped: true, reason: '無有效開獎資料' };
  }

  const state = readJson(RESULT_STATE_FILE, { '539': { lastIssue: null }, 'ttl': { lastIssue: null } });
  if (state[type] && state[type].lastIssue === draw.issue) {
    return { ok: true, skipped: true, reason: '本期已核對過' };
  }

  const active = getActiveTracking(type);
  state[type] = { lastIssue: draw.issue, checkedAt: new Date().toISOString() };
  writeJson(RESULT_STATE_FILE, state);

  if (!active || !active.groups) {
    return { ok: true, skipped: true, reason: '目前沒有有效追蹤' };
  }

  const hitMap = {
    group1: countHits(active.groups.group1 || [], draw.numbers),
    group2: countHits(active.groups.group2 || [], draw.numbers),
    group3: countHits(active.groups.group3 || [], draw.numbers),
    group4: countHits(active.groups.group4 || [], draw.numbers),
    full: countHits(active.groups.full || [], draw.numbers)
  };

  const outcome = evaluateOutcome(hitMap);
  const weekday = getWeekdayZh(draw.date);

  const resultRecord = {
    id: `${type}_${draw.issue}_${Date.now()}`,
    lotteryType: type,
    lotteryTitle: active.lotteryTitle || (type === 'ttl' ? '天天樂' : '539'),
    trackingId: active.id || null,
    drawIssue: draw.issue,
    drawDate: draw.date,
    weekday,
    drawNumbers: draw.numbers,
    labels: active.labels,
    groups: active.groups,
    hitMap,
    outcome,
    createdAt: new Date().toISOString()
  };

  const history = readJson(RESULT_HISTORY_FILE, []);
  history.push(resultRecord);
  writeJson(RESULT_HISTORY_FILE, history);

  await updateWeeklyStats(type, resultRecord);
  const resultMsg = buildResultMessage(resultRecord, draw);
  const weeklyMsg = buildWeeklyStatsMessage(type);
  await sendTelegramMessage(resultMsg + '\n\n' + weeklyMsg);

  return { ok: true, skipped: false, result: resultRecord };
}

function getResultHistory(lotteryType) {
  const type = normalizeLotteryType(lotteryType);
  const history = readJson(RESULT_HISTORY_FILE, []);
  return history.filter((x) => x.lotteryType === type);
}

module.exports = {
  processLatestDraw,
  getResultHistory
};
