const { sendTelegramMessage } = require('./telegram');
const {
  getActiveTracking,
  cancelActiveTracking,
  setActiveTracking,
  normalizeLotteryType
} = require('./trackingStore');

function pad2(n) {
  return String(parseInt(n, 10)).padStart(2, '0');
}

function nowIsoId() {
  return new Date().toISOString().replace(/[-:TZ.]/g, '').slice(0, 14);
}

function validateGroup(name, arr) {
  if (!Array.isArray(arr)) throw new Error(`${name} 格式錯誤`);
  const nums = arr.map((n) => Number(n));
  if (nums.some((n) => !Number.isInteger(n) || n < 1 || n > 39)) {
    throw new Error(`${name} 含有無效號碼`);
  }
  if (new Set(nums).size !== nums.length) {
    throw new Error(`${name} 有重複號碼`);
  }
  return nums.map(pad2);
}

function validatePayload(payload) {
  const lotteryType = normalizeLotteryType(payload.lotteryType);
  const groups = payload.groups || {};
  const parsed = {
    group1: validateGroup('第一組', groups.group1 || []),
    group2: validateGroup('第二組', groups.group2 || []),
    group3: validateGroup('第三組', groups.group3 || []),
    group4: validateGroup('第四組', groups.group4 || []),
    full: validateGroup('全車號碼', groups.full || [])
  };

  if (parsed.group1.length !== 5 || parsed.group2.length !== 5 || parsed.group3.length !== 5 || parsed.group4.length !== 5) {
    throw new Error('第一組到第四組都必須是 5 顆');
  }

  const allMain = [...parsed.group1, ...parsed.group2, ...parsed.group3, ...parsed.group4];
  if (new Set(allMain).size !== allMain.length) {
    throw new Error('第一組到第四組之間不可重複號碼');
  }

  const title = payload.lotteryTitle || (lotteryType === 'ttl' ? '天天樂' : '539');
  return {
    lotteryType,
    lotteryTitle: title,
    confirmedAt: payload.confirmedAt || new Date().toISOString(),
    labels: payload.labels || {
      group1: '第一組',
      group2: '第二組',
      group3: '第三組',
      group4: '第四組',
      full: '全車號碼'
    },
    groups: parsed
  };
}

function buildTrackingRecord(input) {
  return {
    id: `${input.lotteryType}_${nowIsoId()}`,
    lotteryType: input.lotteryType,
    lotteryTitle: input.lotteryTitle,
    confirmedAt: input.confirmedAt,
    createdAt: new Date().toISOString(),
    status: 'tracking',
    labels: input.labels,
    groups: input.groups
  };
}

function buildCreatedMessage(record) {
  return [
    `【${record.lotteryTitle}確定通報】`,
    '',
    `${record.labels.group1}：${record.groups.group1.join('、')}`,
    `${record.labels.group2}：${record.groups.group2.join('、')}`,
    `${record.labels.group3}：${record.groups.group3.join('、')}`,
    `${record.labels.group4}：${record.groups.group4.join('、')}`,
    `${record.labels.full}：${record.groups.full.join('、')}`
  ].join('\n');
}

function buildUpdatedMessage(record) {
  return [
    `【${record.lotteryTitle}通報更新】`,
    '已取消前一組追蹤號碼',
    '改為追蹤最新生成號碼',
    '',
    `${record.labels.group1}：${record.groups.group1.join('、')}`,
    `${record.labels.group2}：${record.groups.group2.join('、')}`,
    `${record.labels.group3}：${record.groups.group3.join('、')}`,
    `${record.labels.group4}：${record.groups.group4.join('、')}`,
    `${record.labels.full}：${record.groups.full.join('、')}`
  ].join('\n');
}

async function confirmTracking(payload) {
  const parsed = validatePayload(payload);
  const current = getActiveTracking(parsed.lotteryType);
  let replacedOldTracking = false;

  if (current) {
    cancelActiveTracking(parsed.lotteryType);
    replacedOldTracking = true;
  }

  const record = buildTrackingRecord(parsed);
  setActiveTracking(parsed.lotteryType, record);

  const text = replacedOldTracking ? buildUpdatedMessage(record) : buildCreatedMessage(record);
  await sendTelegramMessage(text);

  return {
    ok: true,
    replacedOldTracking,
    tracking: record
  };
}

module.exports = { confirmTracking };
