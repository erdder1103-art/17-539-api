const { sendTelegramMessage } = require('./telegram');
const {
  getActiveTrackings,
  getTrackingHistory,
  cancelTrackingById,
  setActiveTracking,
  updateTrackingById,
  normalizeLotteryType
} = require('./trackingStore');
const { formatTaipeiCompact, formatTaipeiDateTime } = require('./utils/time');
const { buildNextIssue, rebuildTrackingAnalysis } = require('./resultService');

const inflightByKey = new Map();
const FULL_GROUP_SIZE = 19;
const TRACKING_HISTORY_LIMIT = 100;

function pad2(n) {
  return String(parseInt(n, 10)).padStart(2, '0');
}

function nowIsoId() {
  return formatTaipeiCompact();
}

function validateGroup(name, arr, expectedLen) {
  if (!Array.isArray(arr)) throw new Error(`${name} 格式錯誤`);
  const nums = arr.map((n) => Number(n));
  if (nums.some((n) => !Number.isInteger(n) || n < 1 || n > 39)) {
    throw new Error(`${name} 含有無效號碼`);
  }
  if (new Set(nums).size !== nums.length) {
    throw new Error(`${name} 有重複號碼`);
  }
  if (expectedLen && nums.length !== expectedLen) {
    throw new Error(`${name} 必須是 ${expectedLen} 顆`);
  }
  return nums.map(pad2);
}

function normalizeGroups(groups) {
  return {
    group1: validateGroup('第一組', groups.group1 || [], 5),
    group2: validateGroup('第二組', groups.group2 || [], 5),
    group3: validateGroup('第三組', groups.group3 || [], 5),
    group4: validateGroup('第四組', groups.group4 || [], 5),
    full: validateGroup('全車號碼', groups.full || [], FULL_GROUP_SIZE)
  };
}

function ensureMainGroupsUnique(parsed, labelPrefix = '') {
  const allMain = [...parsed.group1, ...parsed.group2, ...parsed.group3, ...parsed.group4];
  if (new Set(allMain).size !== allMain.length) {
    throw new Error(`${labelPrefix}第一組到第四組之間不可重複號碼`);
  }
}

function ensureFullDisjoint(parsed, labelPrefix = '') {
  const allMain = new Set([...parsed.group1, ...parsed.group2, ...parsed.group3, ...parsed.group4]);
  const overlaps = parsed.full.filter((n) => allMain.has(n));
  if (overlaps.length) {
    throw new Error(`${labelPrefix}全車號碼不可與第一組到第四組重複：${overlaps.join('、')}`);
  }
}

function buildValidationSummary(groups) {
  return {
    groupSizes: {
      group1: groups.group1.length,
      group2: groups.group2.length,
      group3: groups.group3.length,
      group4: groups.group4.length,
      full: groups.full.length
    },
    allMainUnique: new Set([...groups.group1, ...groups.group2, ...groups.group3, ...groups.group4]).size === 20,
    fullUnique: new Set(groups.full).size === groups.full.length
  };
}


function defaultSystemSource(payload) {
  return String(payload.sourceName || payload.source || '').trim() || '防2/3碰撞追蹤';
}

function validatePayload(payload) {
  const lotteryType = normalizeLotteryType(payload.lotteryType);
  const groups = normalizeGroups(payload.groups || {});
  ensureMainGroupsUnique(groups);
  ensureFullDisjoint(groups);

  const title = payload.lotteryTitle || (lotteryType === 'ttl' ? '天天樂' : '539');
  return {
    lotteryType,
    lotteryTitle: title,
    confirmedAt: formatTaipeiDateTime(),
    trackType: 'system',
    sourceName: defaultSystemSource(payload),
    labels: payload.labels || {
      group1: '第一組',
      group2: '第二組',
      group3: '第三組',
      group4: '第四組',
      full: '全車號碼'
    },
    groups,
    baseIssue: String(payload.baseIssue || payload.latestIssue || '').trim(),
    startFromIssue: String(payload.startFromIssue || '').trim(),
    analysis: payload.analysis || null
  };
}

function validateManualPayload(payload) {
  const lotteryType = normalizeLotteryType(payload.lotteryType);
  const sourceName = String(payload.sourceName || payload.source || '').trim() || '手動追蹤';
  const title = payload.lotteryTitle || (lotteryType === 'ttl' ? '天天樂' : '539');
  const groups = normalizeGroups(payload.groups || {});
  ensureMainGroupsUnique(groups, '手動');
  ensureFullDisjoint(groups, '手動');

  return {
    lotteryType,
    lotteryTitle: title,
    confirmedAt: formatTaipeiDateTime(),
    trackType: 'manual',
    sourceName,
    labels: {
      group1: '第一組',
      group2: '第二組',
      group3: '第三組',
      group4: '第四組',
      full: '全車號碼'
    },
    groups,
    baseIssue: String(payload.baseIssue || payload.latestIssue || '').trim(),
    startFromIssue: String(payload.startFromIssue || '').trim(),
    analysis: payload.analysis || null
  };
}

function buildTrackingRecord(input) {
  const now = formatTaipeiDateTime();
  const baseIssue = String(input.baseIssue || '').trim();
  const startFromIssue = String(input.startFromIssue || buildNextIssue(baseIssue) || '').trim();
  return {
    id: `${input.lotteryType}_${input.trackType}_${nowIsoId()}`,
    lotteryType: input.lotteryType,
    lotteryTitle: input.lotteryTitle,
    confirmedAt: now,
    createdAt: now,
    baseIssue,
    startFromIssue,
    status: 'pending',
    trackType: input.trackType || 'system',
    sourceName: input.sourceName || '',
    labels: input.labels,
    groups: input.groups,
    analysis: input.analysis || null
  };
}

function linesForGroups(record) {
  return [
    `${record.labels.group1}：${record.groups.group1.join('、')}`,
    `${record.labels.group2}：${record.groups.group2.join('、')}`,
    `${record.labels.group3}：${record.groups.group3.join('、')}`,
    `${record.labels.group4}：${record.groups.group4.join('、')}`,
    `${record.labels.full}：${record.groups.full.join('、')}`
  ];
}


function linesForAnalysis(record) {
  const analysis = record.analysis || {};
  const rec = analysis.recommendation || {};
  const lines = [];
  if (analysis.previewSummary) lines.push(`預覽結論：${analysis.previewSummary}`);
  if (analysis.packStatus) lines.push(`預覽狀態：${analysis.canNotify ? '可直接通報' : analysis.packStatus}`);
  if (typeof rec.passTendency !== 'undefined') lines.push(`通過傾向：${Number(rec.passTendency || 0).toFixed(1)}%`);
  if (rec.riskLevel) lines.push(`風險等級：${rec.riskLevel}`);
  if (typeof rec.reliability !== 'undefined') lines.push(`分析可信度：${Number(rec.reliability || 0).toFixed(1)}`);
  if (rec.bestGroupText) lines.push(`最佳組：${rec.bestGroupText}`);
  if (rec.riskGroupText) lines.push(`風險組：${rec.riskGroupText}`);
  if (rec.structureSummary) lines.push(`結構判讀：${rec.structureSummary}`);
  if (rec.actionAdvice) lines.push(`操作建議：${rec.actionAdvice}`);
  if (Array.isArray(rec.positives) && rec.positives.length) lines.push(`正向條件：${rec.positives.join('、')}`);
  if (Array.isArray(rec.negatives) && rec.negatives.length) lines.push(`風險提醒：${rec.negatives.join('、')}`);
  if (analysis.previewReport) {
    lines.push('', '完整分析：', String(analysis.previewReport));
  }
  return lines;
}

function buildCreatedMessage(record) {
  const title = record.trackType === 'manual' ? '手動追蹤' : '確定通報';
  const lines = [
    `【拾柒追蹤系統｜${record.lotteryTitle} ${title}】`,
    '',
    `${record.trackType === 'manual' ? '追蹤狀態' : '通報狀態'}：已建立`,
    ...(record.trackType === 'manual' ? [] : ['追蹤類型：系統生成']),
    `通報來源：${record.sourceName || '未命名通報'}`,
    `通報時間：${record.confirmedAt}`,
    ...(record.startFromIssue ? [`生效期數：${record.startFromIssue}`] : []),
    '',
    ...linesForGroups(record)
  ];
  return lines.join('\n');
}

function buildCancelledMessage(record) {
  const lines = [
    `【拾柒追蹤系統｜${record.lotteryTitle} 取消通報】`,
    '',
    '追蹤狀態：已取消',
    `追蹤類型：${record.trackType === 'manual' ? '手動追蹤' : '系統生成'}`,
    `通報來源：${record.sourceName || '未命名通報'}`,
    `取消時間：${record.cancelledAt || formatTaipeiDateTime()}`,
    '',
    ...linesForGroups(record)
  ];
  return lines.join('\n');
}

function buildUpdatedMessage(record) {
  const lines = [
    `【拾柒追蹤系統｜${record.lotteryTitle} 更新通報】`,
    '',
    '追蹤狀態：已更新',
    `追蹤類型：${record.trackType === 'manual' ? '手動追蹤' : '系統生成'}`,
    `通報來源：${record.sourceName || '未命名通報'}`,
    `更新時間：${record.confirmedAt}`,
    ...(record.startFromIssue ? [`生效期數：${record.startFromIssue}`] : []),
    '',
    ...linesForGroups(record),
    ...(linesForAnalysis(record).length ? ['', ...linesForAnalysis(record)] : [])
  ];
  return lines.join('\n');
}

function groupsFingerprint(record) {
  const g = record.groups || {};
  return [g.group1, g.group2, g.group3, g.group4, g.full]
    .map((arr) => (Array.isArray(arr) ? arr.join('-') : ''))
    .join('|');
}

function isDuplicateManualTracking(input) {
  const active = getActiveTrackings(input.lotteryType).filter((row) => row.trackType === 'manual' && row.status === 'pending');
  const targetFp = groupsFingerprint(input);
  return active.some((row) => {
    return String(row.sourceName || '') === String(input.sourceName || '') && groupsFingerprint(row) === targetFp;
  });
}

async function confirmTracking(payload) {
  const parsed = validatePayload(payload);
  const type = parsed.lotteryType;
  const lockKey = `system:${type}`;

  if (inflightByKey.get(lockKey)) {
    return {
      ok: true,
      busy: true,
      replacedOldTracking: false,
      message: `${parsed.lotteryTitle} 通報處理中，請勿重複點擊`
    };
  }

  inflightByKey.set(lockKey, true);
  try {
    const current = getActiveTrackings(type).find((row) => row.trackType === 'system' && row.status === 'pending');
    const replacedOldTracking = Boolean(current);
    const record = buildTrackingRecord(parsed);
    const messageText = replacedOldTracking ? buildUpdatedMessage(record) : buildCreatedMessage(record);

    await sendTelegramMessage(messageText, { timeoutMs: 8000 });
    const saveResult = setActiveTracking(type, record);

    return {
      ok: true,
      busy: false,
      replacedOldTracking,
      replacedCount: saveResult.replaced ? 1 : 0,
      telegramSent: true,
      tracking: record,
      validation: buildValidationSummary(record.groups),
      message: replacedOldTracking
        ? `${parsed.lotteryTitle} 已更新系統追蹤，舊追蹤已自動失效`
        : `${parsed.lotteryTitle} 已建立追蹤並送出通報`
    };
  } catch (err) {
    throw new Error(`Telegram 發送失敗：${err.message}`);
  } finally {
    inflightByKey.delete(lockKey);
  }
}

async function confirmManualTracking(payload) {
  const parsed = validateManualPayload(payload);
  const lockKey = `manual:${parsed.lotteryType}:${parsed.sourceName}`;

  if (inflightByKey.get(lockKey)) {
    return {
      ok: true,
      busy: true,
      telegramSent: false,
      message: `${parsed.lotteryTitle} 手動追蹤處理中，請勿重複點擊`
    };
  }

  if (isDuplicateManualTracking(parsed)) {
    return {
      ok: false,
      duplicate: true,
      telegramSent: false,
      message: `${parsed.lotteryTitle} 手動追蹤已存在，相同來源與分組不重複建立`
    };
  }

  inflightByKey.set(lockKey, true);
  try {
    const existing = getActiveTrackings(parsed.lotteryType).find((row) => row.trackType === 'manual' && row.status === 'pending' && String(row.sourceName || '') === parsed.sourceName);
    const record = buildTrackingRecord(parsed);
    const messageText = existing ? buildUpdatedMessage(record) : buildCreatedMessage(record);
    await sendTelegramMessage(messageText, { timeoutMs: 8000 });
    const saveResult = setActiveTracking(parsed.lotteryType, record);
    return {
      ok: true,
      busy: false,
      duplicate: false,
      telegramSent: true,
      replacedOldTracking: Boolean(existing),
      replacedCount: Array.isArray(saveResult.replaced) ? saveResult.replaced.length : 0,
      tracking: record,
      validation: buildValidationSummary(record.groups),
      message: existing
        ? `${parsed.lotteryTitle} 已更新手動追蹤：${record.sourceName}`
        : `${parsed.lotteryTitle} 已新增手動追蹤：${record.sourceName}`
    };
  } catch (err) {
    throw new Error(`Telegram 發送失敗：${err.message}`);
  } finally {
    inflightByKey.delete(lockKey);
  }
}



function analysisNeedsRebuild(row) {
  const analysis = row && row.analysis ? row.analysis : {};
  const drawCount = Number(analysis.evaluatedWindow || analysis.analysisWindow || analysis.drawCount || 0);
  const details = Array.isArray(analysis.riskGroupDetails) ? analysis.riskGroupDetails : [];
  return !details.length || drawCount <= 0;
}

function maybeRebuildTrackingAnalysis(lotteryType, row) {
  if (!row || !analysisNeedsRebuild(row)) return row;
  const rebuilt = rebuildTrackingAnalysis(row, lotteryType);
  const drawCount = Number(rebuilt?.analysis?.evaluatedWindow || rebuilt?.analysis?.drawCount || 0);
  if (drawCount > 0) {
    updateTrackingById(lotteryType, row.id, { analysis: rebuilt.analysis });
  }
  return rebuilt;
}

function recalculateTrackingAnalysis(payload) {
  const lotteryType = normalizeLotteryType(payload.lotteryType);
  const trackingId = String(payload.trackingId || '').trim();
  if (!trackingId) throw new Error('缺少 trackingId');
  const active = getActiveTrackings(lotteryType);
  const target = active.find((row) => String(row.id || '') === trackingId);
  if (!target) throw new Error('找不到可重算的追蹤');
  const rebuilt = rebuildTrackingAnalysis(target, lotteryType);
  const drawCount = Number(rebuilt?.analysis?.evaluatedWindow || rebuilt?.analysis?.drawCount || 0);
  if (drawCount <= 0) throw new Error('目前沒有可用歷史資料，請先同步開獎');
  const saved = updateTrackingById(lotteryType, trackingId, { analysis: rebuilt.analysis, updatedAt: formatTaipeiDateTime() });
  return { ok: true, tracking: saved || rebuilt, drawCount, message: `已補上近 ${drawCount} 期分析` };
}

async function cancelTracking(payload) {
  const lotteryType = normalizeLotteryType(payload.lotteryType);
  const trackingId = String(payload.trackingId || '').trim();
  const reason = String(payload.reason || 'manual-cancel').trim() || 'manual-cancel';
  if (!trackingId) throw new Error('缺少 trackingId');
  const cancelled = cancelTrackingById(lotteryType, trackingId, reason);
  if (!cancelled) throw new Error('找不到可取消的追蹤');
  try {
    await sendTelegramMessage(buildCancelledMessage(cancelled), { timeoutMs: 8000 });
  } catch (err) {
    throw new Error(`取消追蹤已完成，但 Telegram 取消通報失敗：${err.message}`);
  }
  return {
    ok: true,
    cancelled,
    message: `${cancelled.lotteryTitle} 已取消${cancelled.trackType === 'manual' ? '手動' : '系統'}追蹤並送出取消通報`
  };
}

function getTrackingOverview(lotteryType) {
  const active = getActiveTrackings(lotteryType).map((row) => maybeRebuildTrackingAnalysis(lotteryType, row));
  const history = getTrackingHistory(lotteryType, TRACKING_HISTORY_LIMIT);
  const completed = history.filter((row) => row.status === 'completed');
  const cancelled = history.filter((row) => row.status === 'cancelled');
  return {
    ok: true,
    active,
    completed,
    cancelled,
    history,
    message: active.length ? `目前共有 ${active.length} 筆待開獎追蹤` : '目前沒有待開獎追蹤'
  };
}

module.exports = { confirmTracking, confirmManualTracking, cancelTracking, getTrackingOverview, recalculateTrackingAnalysis, FULL_GROUP_SIZE };
