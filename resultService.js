const fs = require('fs');
const path = require('path');
const { sendTelegramMessage } = require('./telegram');
const { updateWeeklyStats, buildWeeklySummaryText, getWeekKey } = require('./weekStats');

const RESULT_STATE_FILE = path.join(__dirname, 'data', 'result_state.json');
const RESULT_HISTORY_FILE = path.join(__dirname, 'data', 'result_history.json');

function readJson(file, fallback) {
  try {
    if (!fs.existsSync(file)) return fallback;
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    return fallback;
  }
}

function writeJson(file, data) {
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
  const mainHits = [resultMap.group1, resultMap.group2, resultMap.group3, resultMap.group4];

  if (mainHits.some(v => v >= 4)) {
    return { label: '發財了各位', code: 'jackpot' };
  }

  const hit2or3Count = mainHits.filter(v => v === 2 || v === 3).length;
  if (hit2or3Count >= 2) {
    return { label: '靠3.3倍', code: 'x33' };
  }
  if (hit2or3Count === 1) {
    return { label: '再接再厲', code: 'retry' };
  }
  return { label: '恭喜過關', code: 'pass' };
}

function nowFull() {
  const d = new Date();
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth()+1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

function buildResultMessage(lotteryTitle, draw, resultMap, finalLabel, weeklyText) {
  return [
    `【拾柒追蹤系統｜${lotteryTitle} 開獎核對】`,
    '',
    `核對狀態：已完成`,
    `核對時間：${nowFull()}`,
    '',
    `本期開獎號碼：`,
    draw.join('、'),
    '',
    `各組命中結果：`,
    `第一組：中 ${resultMap.group1} 顆`,
    `第二組：中 ${resultMap.group2} 顆`,
    `第三組：中 ${resultMap.group3} 顆`,
    `第四組：中 ${resultMap.group4} 顆`,
    `全車號碼：中 ${resultMap.full} 顆`,
    '',
    `本期結果：`,
    finalLabel,
    '',
    weeklyText
  ].join('\n');
}

async function processTrackingResult(lotteryType, lotteryTitle, latestDraw, tracking, issueKey) {
  if (!tracking || !tracking.groups) {
    return { skipped: true, reason: 'no active tracking' };
  }

  const state = readJson(RESULT_STATE_FILE, { '539': { lastIssue: null }, 'ttl': { lastIssue: null } });
  const key = lotteryType === 'ttl' ? 'ttl' : '539';
  if (state[key] && state[key].lastIssue === issueKey) {
    return { skipped: true, reason: 'already processed' };
  }

  const draw = latestDraw.map(pad2);
  const groups = tracking.groups || {};
  const resultMap = {
    group1: hitCount(groups.group1 || [], draw),
    group2: hitCount(groups.group2 || [], draw),
    group3: hitCount(groups.group3 || [], draw),
    group4: hitCount(groups.group4 || [], draw),
    full: hitCount(groups.full || [], draw)
  };

  const evaluation = evaluateResult(resultMap);
  const weekly = updateWeeklyStats(key, evaluation.label);
  const weeklyText = buildWeeklySummaryText(key, weekly);
  const message = buildResultMessage(lotteryTitle, draw, resultMap, evaluation.label, weeklyText);

  await sendTelegramMessage(message, { timeoutMs: 8000 });

  const history = readJson(RESULT_HISTORY_FILE, []);
  history.push({
    lotteryType: key,
    lotteryTitle,
    issueKey,
    checkedAt: nowFull(),
    draw,
    resultMap,
    finalLabel: evaluation.label,
    week: getWeekKey(),
    trackingId: tracking.id || null
  });
  writeJson(RESULT_HISTORY_FILE, history);

  state[key] = {
    lastIssue: issueKey,
    lastCheckedAt: nowFull()
  };
  writeJson(RESULT_STATE_FILE, state);

  return { ok: true, finalLabel: evaluation.label, resultMap };
}

function getResultHistory(lotteryType) {
  const key = lotteryType === 'ttl' ? 'ttl' : '539';
  return readJson(RESULT_HISTORY_FILE, []).filter(x => x.lotteryType === key);
}

module.exports = {
  processTrackingResult,
  getResultHistory
};
