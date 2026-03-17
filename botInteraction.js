const { callTelegram, getBotRuntimeSummary, sendTelegramMessage } = require('./telegram');
const { getDataFile, readJsonSafe, writeJsonAtomic, initializeDataFiles } = require('./dataPaths');
const { formatTaipeiDateTime, getTaipeiDate } = require('./utils/time');
const { getActiveTrackings } = require('./trackingStore');
const { getRecommendations, getLearningState, getResultHistory, getRangeSummary, compareActiveTrackings } = require('./resultService');

const BOT_RUNTIME_FILE = getDataFile('bot_runtime.json');

let pollTimer = null;
let isPolling = false;
let deps = null;

function defaultRuntime() {
  return {
    enabled: true,
    polling: false,
    offset: 0,
    lastPollAt: '',
    lastHandledAt: '',
    lastUpdateId: 0,
    lastChatId: '',
    lastChatTitle: '',
    lastMessageText: '',
    totalUpdates: 0,
    handledMessages: 0,
    ignoredMessages: 0,
    errorCount: 0,
    lastError: '',
    lastResponsePreview: ''
  };
}

function readRuntime() {
  initializeDataFiles();
  return { ...defaultRuntime(), ...(readJsonSafe(BOT_RUNTIME_FILE, defaultRuntime()) || {}) };
}

function writeRuntime(patch = {}) {
  const runtime = { ...readRuntime(), ...patch };
  writeJsonAtomic(BOT_RUNTIME_FILE, runtime);
  return runtime;
}

function truncate(text, max = 120) {
  const s = String(text || '').replace(/\s+/g, ' ').trim();
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

function detectLotteryType(text) {
  const t = String(text || '').toLowerCase();
  if (t.includes('天天樂') || t.includes('ttl')) return 'ttl';
  return '539';
}

function detectRangeQuery(text) {
  const raw = String(text || '').trim();
  if (raw.includes('上上週') || raw.includes('上上周')) return { preset: 'two_weeks_ago' };
  if (raw.includes('上週') || raw.includes('上周')) return { preset: 'last_week' };
  if (raw.includes('本週') || raw.includes('這週') || raw.includes('這周')) return { preset: 'this_week' };
  const m = raw.match(/(\d{1,2})[\/-](\d{1,2})\s*(?:到|至|~|～|-)\s*(\d{1,2})[\/-](\d{1,2})/);
  if (m) {
    const y = getTaipeiDate().getFullYear();
    return {
      startDate: `${y}-${String(m[1]).padStart(2, '0')}-${String(m[2]).padStart(2, '0')}`,
      endDate: `${y}-${String(m[3]).padStart(2, '0')}-${String(m[4]).padStart(2, '0')}`
    };
  }
  return null;
}

function formatLabels(summary) {
  const total = summary.total || 0;
  const rate = (n) => total ? `${n}（${((n / total) * 100).toFixed(1)}%）` : '0（0%）';
  return [
    `恭喜過關：${rate(summary.labels['恭喜過關'] || 0)}`,
    `再接再厲：${rate(summary.labels['再接再厲'] || 0)}`,
    `靠3.3倍：${rate(summary.labels['靠3.3倍'] || 0)}`
  ];
}

function buildRecommendationReply(type, compareMode = false) {
  const title = type === 'ttl' ? '天天樂' : '539';
  const compare = compareActiveTrackings(type);
  if (!compare.recommendations.length) {
    return `【${title} 群組分析】\n\n目前沒有待開獎追蹤，所以還不能判斷。\n先建立追蹤後再問我。`;
  }
  const lines = [`【${title} 群組決策分析】`, '', `共 ${compare.recommendations.length} 組`, ''];
  compare.recommendations.slice(0, 5).forEach((row, idx) => {
    lines.push(`【${row.trackType === 'manual' ? '手動' : '系統'}｜${row.sourceName || row.trackType}】`);
    lines.push(`過關傾向：${row.passTendency}%`);
    lines.push(`風險等級：${row.riskLevel}`);
    lines.push(`分析可靠度：${row.reliability}`);
    lines.push(`正向：${row.positives?.join('、') || '—'}`);
    lines.push(`風險：${row.negatives?.join('、') || '—'}`);
    if (idx < compare.recommendations.length - 1 && idx < 4) lines.push('', '--------------------', '');
  });
  if (compare.best) {
    lines.push('', `👉 綜合判斷：${compare.best.trackType === 'manual' ? '手動' : '系統'}｜${compare.best.sourceName || compare.best.trackType} 較穩，優先推薦`);
  }
  return lines.join('\n');
}

function buildTrackingReply(type) {
  const title = type === 'ttl' ? '天天樂' : '539';
  const active = getActiveTrackings(type);
  if (!active.length) return `【${title} 追蹤清單】\n\n目前沒有待開獎追蹤。`;
  const recData = getRecommendations(type);
  const recMap = new Map((recData.recommendations || []).map((r) => [r.trackingId, r]));
  const lines = [`【${title} 追蹤清單】`, ''];
  active.forEach((row, idx) => {
    const rec = recMap.get(row.id);
    lines.push(`${idx + 1}. ${row.sourceName || (row.trackType === 'manual' ? '手動追蹤' : '系統追蹤')}｜${row.trackType === 'manual' ? '手動' : '系統'}`);
    lines.push(`   生效期數：${row.startFromIssue || '未設定'}`);
    if (rec) lines.push(`   過關傾向 ${rec.passTendency}%｜風險 ${rec.riskLevel}｜可靠度 ${rec.reliability}`);
  });
  return lines.join('\n');
}

function buildLearningReply(type) {
  const title = type === 'ttl' ? '天天樂' : '539';
  const learning = getLearningState(type);
  const system = learning.system || {};
  const labels = system.labels || {};
  const total = Number(system.total || 0);
  if (!total) return `【${title} 學習狀態】\n\n目前還沒有足夠樣本。`;
  const passRate = (((labels['恭喜過關'] || 0) / total) * 100).toFixed(1);
  const retryRate = (((labels['再接再厲'] || 0) / total) * 100).toFixed(1);
  const x33Rate = (((labels['靠3.3倍'] || 0) / total) * 100).toFixed(1);
  return [`【${title} 學習狀態】`, '', `樣本數：${total}`, `恭喜過關：${passRate}%`, `再接再厲：${retryRate}%`, `靠3.3倍：${x33Rate}%`].join('\n');
}

function buildHistoryReply(type) {
  const title = type === 'ttl' ? '天天樂' : '539';
  const rows = getResultHistory(type).slice(-6).reverse();
  if (!rows.length) return `【${title} 最近結果】\n\n目前還沒有歷史結果。`;
  const lines = [`【${title} 最近結果】`, ''];
  rows.forEach((row, idx) => {
    lines.push(`${idx + 1}. ${row.issue || row.issueKey}｜${row.drawDate || ''}｜${row.trackType === 'manual' ? '手動' : '系統'}｜${row.sourceName || ''}`);
    lines.push(`號碼：${(row.draw || []).join('、')}｜結果：${row.finalLabel}`);
  });
  return lines.join('\n');
}

function buildRangeReply(rangeQuery) {
  const summary = getRangeSummary(rangeQuery || {});
  const period = summary.period?.label || `${summary.period?.startDate || ''}～${summary.period?.endDate || ''}`;
  return [
    '【區間結果統計】',
    '',
    `期間：${period}`,
    `本區間總場次：${summary.totalCount}`,
    `系統生成總場次：${summary.system.totalCount}`,
    `手動生成總場次：${summary.manual.totalCount}`,
    '',
    '【系統生成：天天樂】',
    ...formatLabels(summary.system.ttl),
    '',
    '【系統生成：539】',
    ...formatLabels(summary.system.lotto539),
    `系統生成總過關率：${summary.system.passRate}%`,
    '',
    '【手動生成：天天樂】',
    ...formatLabels(summary.manual.ttl),
    '',
    '【手動生成：539】',
    ...formatLabels(summary.manual.lotto539),
    `手動生成總過關率：${summary.manual.passRate}%`,
    '',
    `👉 ${summary.conclusion}`
  ].join('\n');
}

function buildSyncReply() {
  const health = deps && typeof deps.getHealth === 'function' ? deps.getHealth() : null;
  const sync = health && health.sync ? health.sync : null;
  if (!sync) return '目前抓不到同步狀態。';
  return [
    '【系統同步狀態】',
    '',
    `目前輪詢：${Math.round((sync.intervalMs || 0) / 1000)} 秒`,
    `成功次數：${sync.successCount || 0}`,
    `失敗次數：${sync.failureCount || 0}`,
    `連續失敗：${sync.consecutiveFailures || 0}`,
    `最後成功：${sync.lastSuccessAt || '尚無'}`,
    `最後錯誤：${sync.lastError || '無'}`
  ].join('\n');
}

function buildHelpReply() {
  return [
    '【拾柒追蹤系統｜群組互動版】',
    '',
    '可直接輸入：',
    '1. 這組會不會過',
    '2. 這兩組哪組會過',
    '3. 哪組比較穩',
    '4. 追蹤清單',
    '5. 學習狀態',
    '6. 最近結果',
    '7. 這週結果 / 上週結果 / 上上週結果',
    '8. 3/10到3/20結果',
    '9. 同步正常嗎'
  ].join('\n');
}

function shouldHandleText(text) {
  const t = String(text || '').trim();
  if (!t) return false;
  if (t.startsWith('/start') || t.startsWith('/help')) return true;
  return [
    '會不會過', '穩不穩', '哪組比較穩', '哪組會過', '追蹤清單', '待追蹤',
    '學習狀態', '最近結果', '同步正常嗎', '同步狀態', '本週', '這週', '這周', '上週', '上周', '上上週', '上上周', '到', '～'
  ].some((keyword) => t.includes(keyword));
}

function createReplyForText(text) {
  const raw = String(text || '').trim();
  const lower = raw.toLowerCase();
  const type = detectLotteryType(raw);
  if (lower.startsWith('/start') || lower.startsWith('/help') || raw.includes('幫助') || raw.includes('指令') || raw.includes('功能')) return buildHelpReply();
  if (raw.includes('同步正常嗎') || raw.includes('同步狀態')) return buildSyncReply();
  if (raw.includes('追蹤清單') || raw.includes('待追蹤')) return buildTrackingReply(type);
  if (raw.includes('學習狀態')) return buildLearningReply(type);
  if (raw.includes('最近結果')) return buildHistoryReply(type);
  const rangeQuery = detectRangeQuery(raw);
  if (rangeQuery && (raw.includes('結果') || raw.includes('統計') || raw.includes('表現'))) return buildRangeReply(rangeQuery);
  if (raw.includes('哪組會過') || raw.includes('哪組比較穩') || raw.includes('會不會過') || raw.includes('穩不穩') || raw.includes('分析')) return buildRecommendationReply(type, true);
  return null;
}

async function handleUpdate(update) {
  const message = update.message || update.edited_message;
  if (!message || !message.chat) return false;
  if (message.from && message.from.is_bot) return false;
  const text = String(message.text || '').trim();
  if (!shouldHandleText(text)) return false;
  const replyText = createReplyForText(text);
  if (!replyText) return false;
  await sendTelegramMessage(replyText, {
    chatId: String(message.chat.id),
    replyToMessageId: message.message_id,
    timeoutMs: 10000
  });
  writeRuntime({
    lastHandledAt: formatTaipeiDateTime(),
    lastChatId: String(message.chat.id),
    lastChatTitle: truncate(message.chat.title || [message.chat.first_name, message.chat.last_name].filter(Boolean).join(' '), 60),
    lastMessageText: truncate(text, 120),
    handledMessages: readRuntime().handledMessages + 1,
    lastResponsePreview: truncate(replyText, 160)
  });
  return true;
}

async function pollOnce() {
  if (isPolling) return;
  isPolling = true;
  let runtime = readRuntime();
  try {
    runtime = writeRuntime({ polling: true, lastPollAt: formatTaipeiDateTime() });
    const data = await callTelegram('getUpdates', {
      offset: Number(runtime.offset || 0),
      timeout: 20,
      allowed_updates: ['message', 'edited_message']
    }, { timeoutMs: 25000 });
    const updates = Array.isArray(data.result) ? data.result : [];
    let ignoredCount = 0;
    let offset = Number(runtime.offset || 0);
    for (const update of updates) {
      offset = Math.max(offset, Number(update.update_id || 0) + 1);
      const handled = await handleUpdate(update).catch((err) => {
        ignoredCount += 1;
        writeRuntime({ errorCount: readRuntime().errorCount + 1, lastError: truncate(err.message, 200) });
        return false;
      });
      if (!handled) ignoredCount += 1;
      writeRuntime({ lastUpdateId: Number(update.update_id || 0) });
    }
    writeRuntime({
      polling: false,
      offset,
      totalUpdates: Number(runtime.totalUpdates || 0) + updates.length,
      handledMessages: Number(readRuntime().handledMessages || 0),
      ignoredMessages: Number(runtime.ignoredMessages || 0) + ignoredCount,
      lastError: ''
    });
  } catch (err) {
    writeRuntime({ polling: false, errorCount: Number(runtime.errorCount || 0) + 1, lastError: truncate(err.message, 200) });
  } finally {
    isPolling = false;
  }
}

function scheduleNext(ms = 1500) {
  if (pollTimer) clearTimeout(pollTimer);
  pollTimer = setTimeout(async () => {
    await pollOnce();
    scheduleNext(1500);
  }, ms);
}

function startBotInteraction(options = {}) {
  deps = options;
  writeRuntime({ enabled: true, polling: false, lastError: '' });
  scheduleNext(1000);
  return getBotInteractionState();
}

function stopBotInteraction() {
  if (pollTimer) clearTimeout(pollTimer);
  pollTimer = null;
  writeRuntime({ polling: false, enabled: false });
}

function getBotInteractionState() {
  return { runtime: readRuntime(), telegram: getBotRuntimeSummary() };
}

module.exports = { BOT_RUNTIME_FILE, startBotInteraction, stopBotInteraction, getBotInteractionState };
