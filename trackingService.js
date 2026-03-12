const { sendTelegramMessage } = require('./telegram');
const {
  getActiveTracking,
  cancelActiveTracking,
  setActiveTracking,
  normalizeLotteryType
} = require('./trackingStore');

const inflightByType = new Map();

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
    `【拾柒追蹤系統｜${record.lotteryTitle} 確定通報】`,
    '',
    `通報狀態：已建立追蹤`,
    `通報時間：${record.confirmedAt}`,
    '',
    `本次追蹤分組：`,
    `${record.labels.group1}：${record.groups.group1.join('、')}`,
    `${record.labels.group2}：${record.groups.group2.join('、')}`,
    `${record.labels.group3}：${record.groups.group3.join('、')}`,
    `${record.labels.group4}：${record.groups.group4.join('、')}`,
    `${record.labels.full}：${record.groups.full.join('、')}`,
    '',
    `說明：若同彩種於開獎前重新通報，系統將自動取消前一次追蹤，並以最新通報為準。`
  ].join('\n');
}

function buildUpdatedMessage(record) {
  return [
    `【拾柒追蹤系統｜${record.lotteryTitle} 通報更新】`,
    '',
    `追蹤狀態：已更新`,
    `更新時間：${record.confirmedAt}`,
    '',
    `系統已取消上一筆 ${record.lotteryTitle} 追蹤資料，`,
    `目前改為追蹤以下最新分組：`,
    '',
    `${record.labels.group1}：${record.groups.group1.join('、')}`,
    `${record.labels.group2}：${record.groups.group2.join('、')}`,
    `${record.labels.group3}：${record.groups.group3.join('、')}`,
    `${record.labels.group4}：${record.groups.group4.join('、')}`,
    `${record.labels.full}：${record.groups.full.join('、')}`
  ].join('\n');
}

function fireAndForgetTelegram(text, type) {
  sendTelegramMessage(text, { timeoutMs: 8000 })
    .catch((err) => console.error(`[${type}] telegram failed:`, err.message))
    .finally(() => inflightByType.delete(type));
}

async function confirmTracking(payload) {
  const parsed = validatePayload(payload);
  const type = parsed.lotteryType;

  if (inflightByType.get(type)) {
    return {
      ok: true,
      busy: true,
      replacedOldTracking: false,
      message: `${parsed.lotteryTitle} 通報處理中，請勿重複點擊`
    };
  }

  const current = getActiveTracking(type);
  let replacedOldTracking = false;
  if (current) {
    cancelActiveTracking(type);
    replacedOldTracking = true;
  }

  const record = buildTrackingRecord(parsed);
  setActiveTracking(type, record);

  inflightByType.set(type, true);
  fireAndForgetTelegram(replacedOldTracking ? buildUpdatedMessage(record) : buildCreatedMessage(record), type);

  return {
    ok: true,
    busy: false,
    replacedOldTracking,
    tracking: record,
    message: replacedOldTracking
      ? `${parsed.lotteryTitle} 已取消前一組並更新追蹤`
      : `${parsed.lotteryTitle} 已建立追蹤並送出通報`
  };
}

module.exports = { confirmTracking };
