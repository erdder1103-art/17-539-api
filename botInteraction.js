const { callTelegram, getBotRuntimeSummary, sendTelegramMessage } = require('./telegram');
const { getDataFile, readJsonSafe, writeJsonAtomic, initializeDataFiles } = require('./dataPaths');
const { formatTaipeiDateTime } = require('./utils/time');
const { getActiveTrackings } = require('./trackingStore');
const { getRecommendations, getLearningState, getResultHistory } = require('./resultService');

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

function formatTrackingLine(index, row, recommendMap) {
  const rec = recommendMap.get(row.id);
  const pass = rec ? `${rec.predictedPassRate}%` : '--';
  const risk = rec ? rec.riskLevel : '--';
  return `${index + 1}. ${row.sourceName || (row.trackType === 'manual' ? '手動追蹤' : '系統追蹤')}｜${row.trackType === 'manual' ? '手動' : '系統'}｜過關率 ${pass}｜風險 ${risk}`;
}

function buildRecommendationReply(type) {
  const recData = getRecommendations(type);
  const title = type === 'ttl' ? '天天樂' : '539';
  if (!recData.recommendations.length) {
    return `【${title} 群組分析】\n\n目前沒有待開獎追蹤，所以還不能判斷「這組會不會過」。\n先建立追蹤後再問我。`;
  }
  const sorted = [...recData.recommendations].sort((a, b) => b.predictedPassRate - a.predictedPassRate || a.predictedX33Rate - b.predictedX33Rate);
  const top = sorted[0];
  const lines = [
    `【${title} 群組分析】`,
    '',
    `最穩的一組：${top.sourceName || (top.trackType === 'manual' ? '手動追蹤' : '系統追蹤')}`,
    `預估過關率：${top.predictedPassRate}%`,
    `再接再厲率：${top.predictedRetryRate}%`,
    `靠3.3倍率：${top.predictedX33Rate}%`,
    `風險：${top.riskLevel}`,
    `信心：${top.confidence}%`,
    '',
    `優勢：${top.positives && top.positives.length ? top.positives.join('、') : '暫無'}`,
    `風險：${top.negatives && top.negatives.length ? top.negatives.join('、') : '暫無'}`
  ];
  if (sorted.length > 1) {
    lines.push('', '待開獎追蹤清單：');
    sorted.slice(0, 5).forEach((row, idx) => {
      lines.push(`${idx + 1}. ${row.sourceName || row.trackType}｜過關率 ${row.predictedPassRate}%｜風險 ${row.riskLevel}`);
    });
  }
  return lines.join('\n');
}

function buildTrackingReply(type) {
  const title = type === 'ttl' ? '天天樂' : '539';
  const active = getActiveTrackings(type);
  if (!active.length) {
    return `【${title} 追蹤清單】\n\n目前沒有待開獎追蹤。`;
  }
  const recData = getRecommendations(type);
  const recommendMap = new Map((recData.recommendations || []).map((row) => [row.trackingId, row]));
  const lines = [`【${title} 追蹤清單】`, '', ...active.map((row, idx) => formatTrackingLine(idx, row, recommendMap))];
  return lines.join('\n');
}

function buildLearningReply(type) {
  const title = type === 'ttl' ? '天天樂' : '539';
  const learning = getLearningState(type);
  const system = learning.system || {};
  const labels = system.labels || {};
  const total = Number(system.total || 0);
  if (!total) {
    return `【${title} 學習狀態】\n\n目前還沒有足夠樣本。先累積幾期開獎後再來看。`;
  }
  const passRate = Math.round(((labels['恭喜過關'] || 0) / total) * 1000) / 10;
  const retryRate = Math.round(((labels['再接再厲'] || 0) / total) * 1000) / 10;
  const x33Rate = Math.round(((labels['靠3.3倍'] || 0) / total) * 1000) / 10;
  const samples = Array.isArray(system.samples) ? system.samples.slice(-3).reverse() : [];
  const lines = [
    `【${title} 學習狀態】`,
    '',
    `樣本數：${total}`,
    `恭喜過關：${passRate}%`,
    `再接再厲：${retryRate}%`,
    `靠3.3倍：${x33Rate}%`
  ];
  if (samples.length) {
    lines.push('', '最近學習：');
    samples.forEach((sample, idx) => {
      lines.push(`${idx + 1}. ${sample.checkedAt || ''}｜${sample.label}｜連號 ${sample.features?.adjacentPairs ?? '-'}｜尾數集中 ${sample.features?.maxTailCount ?? '-'}`);
    });
  }
  return lines.join('\n');
}

function buildHistoryReply(type) {
  const title = type === 'ttl' ? '天天樂' : '539';
  const rows = getResultHistory(type).slice(-5).reverse();
  if (!rows.length) {
    return `【${title} 最近結果】\n\n目前還沒有歷史結果。`;
  }
  const lines = [`【${title} 最近結果】`, ''];
  rows.forEach((row, idx) => {
    lines.push(`${idx + 1}. ${row.issueKey || ''}`);
    lines.push(`號碼：${(row.draw || []).join('、')}｜結果：${row.finalLabel}`);
  });
  return lines.join('\n');
}

function buildSyncReply() {
  const health = deps && typeof deps.getHealth === 'function' ? deps.getHealth() : null;
  const sync = health && health.sync ? health.sync : null;
  if (!sync) {
    return '目前抓不到同步狀態。';
  }
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
    '你可以直接在群組問我：',
    '1. 這組會不會過？',
    '2. 539 這組會不會過？',
    '3. 天天樂這組穩不穩？',
    '4. 追蹤清單',
    '5. 學習狀態',
    '6. 最近結果',
    '7. 同步正常嗎？',
    '',
    '我會用目前待開獎追蹤 + learning + 推薦引擎直接回你。'
  ].join('\n');
}

function shouldHandleText(text) {
  const t = String(text || '').trim();
  if (!t) return false;
  if (t.startsWith('/start') || t.startsWith('/help')) return true;
  return [
    '這組會不會過', '會不會過', '穩不穩', '哪組比較穩', '推薦', '追蹤清單', '待追蹤',
    '學習狀態', 'learning', '最近結果', '同步正常嗎', '同步狀態', 'help', '幫助', '指令', '功能'
  ].some((keyword) => t.includes(keyword));
}

function createReplyForText(text) {
  const raw = String(text || '').trim();
  const lower = raw.toLowerCase();
  const type = detectLotteryType(raw);
  if (lower.startsWith('/start') || lower.startsWith('/help') || raw === 'help' || raw.includes('幫助') || raw.includes('指令') || raw.includes('功能')) {
    return buildHelpReply();
  }
  if (raw.includes('同步正常嗎') || raw.includes('同步狀態')) {
    return buildSyncReply();
  }
  if (raw.includes('追蹤清單') || raw.includes('待追蹤')) {
    return buildTrackingReply(type);
  }
  if (raw.includes('學習狀態') || lower.includes('learning')) {
    return buildLearningReply(type);
  }
  if (raw.includes('最近結果')) {
    return buildHistoryReply(type);
  }
  if (raw.includes('這組會不會過') || raw.includes('會不會過') || raw.includes('穩不穩') || raw.includes('哪組比較穩') || raw.includes('推薦')) {
    return buildRecommendationReply(type);
  }
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
    let handledCount = 0;
    let ignoredCount = 0;
    let offset = Number(runtime.offset || 0);
    for (const update of updates) {
      offset = Math.max(offset, Number(update.update_id || 0) + 1);
      const handled = await handleUpdate(update).catch((err) => {
        ignoredCount += 1;
        writeRuntime({ errorCount: readRuntime().errorCount + 1, lastError: truncate(err.message, 200) });
        return false;
      });
      if (handled) handledCount += 1;
      else ignoredCount += 1;
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
    writeRuntime({
      polling: false,
      errorCount: Number(runtime.errorCount || 0) + 1,
      lastError: truncate(err.message, 200)
    });
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
  return {
    runtime: readRuntime(),
    telegram: getBotRuntimeSummary()
  };
}

module.exports = {
  BOT_RUNTIME_FILE,
  startBotInteraction,
  stopBotInteraction,
  getBotInteractionState
};
