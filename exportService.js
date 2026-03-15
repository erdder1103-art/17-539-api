const fs = require('fs');
const path = require('path');
const XLSX = require('xlsx');
const { formatTaipeiDateTime } = require('./utils/time');

const DATA_DIR = path.join(__dirname, 'data');
const EXPORT_DIR = path.join(DATA_DIR, 'exports');
const TRACKING_FILE = path.join(DATA_DIR, 'tracking.json');
const TRACKING_HISTORY_FILE = path.join(DATA_DIR, 'tracking_history.json');
const RESULT_HISTORY_FILE = path.join(DATA_DIR, 'result_history.json');

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function readJson(file, fallback) {
  try {
    if (!fs.existsSync(file)) return fallback;
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    return fallback;
  }
}

function normalizeTrackingMap(raw) {
  const base = { '539': { system: null, manuals: [] }, 'ttl': { system: null, manuals: [] } };
  ['539', 'ttl'].forEach((key) => {
    const value = raw && raw[key];
    if (!value) return;
    if (value.system !== undefined || Array.isArray(value.manuals)) {
      base[key] = {
        system: value.system || null,
        manuals: Array.isArray(value.manuals) ? value.manuals : []
      };
    } else {
      base[key] = { system: value, manuals: [] };
    }
  });
  return base;
}

function toLine(groups) {
  return [groups?.group1, groups?.group2, groups?.group3, groups?.group4, groups?.full]
    .filter((x) => Array.isArray(x) && x.length)
    .map((g, idx) => `${idx < 4 ? `第${idx + 1}組` : '全車'}:${g.join('、')}`)
    .join(' | ');
}

function buildActiveRows(trackingMap) {
  const rows = [];
  ['ttl', '539'].forEach((type) => {
    const state = trackingMap[type] || { system: null, manuals: [] };
    const list = [];
    if (state.system) list.push(state.system);
    if (Array.isArray(state.manuals)) list.push(...state.manuals);
    list.forEach((row) => {
      rows.push({
        彩種: row.lotteryTitle || (type === 'ttl' ? '天天樂' : '539'),
        類型: row.trackType === 'manual' ? '手動追蹤' : '系統追蹤',
        來源: row.sourceName || '',
        狀態: row.status || 'pending',
        建立時間: row.confirmedAt || row.createdAt || '',
        建檔時間: row.createdAt || '',
        第一組: (row.groups?.group1 || []).join('、'),
        第二組: (row.groups?.group2 || []).join('、'),
        第三組: (row.groups?.group3 || []).join('、'),
        第四組: (row.groups?.group4 || []).join('、'),
        全車號碼: (row.groups?.full || []).join('、')
      });
    });
  });
  return rows;
}

function buildTrackingHistoryRows(history) {
  return history.map((row) => ({
    彩種: row.lotteryTitle || (row.lotteryType === 'ttl' ? '天天樂' : '539'),
    事件: row.event || row.status || '',
    類型: row.trackType === 'manual' ? '手動追蹤' : '系統追蹤',
    來源: row.sourceName || '',
    建立時間: row.confirmedAt || row.createdAt || '',
    取消時間: row.cancelledAt || '',
    結算時間: row.settledAt || '',
    結果標記: row.settlement?.finalLabel || '',
    對獎時間: row.settlement?.checkedAt || '',
    開獎號碼: Array.isArray(row.settlement?.draw) ? row.settlement.draw.join('、') : '',
    分組內容: toLine(row.groups || {})
  }));
}

function buildResultRows(history) {
  return history.map((row) => ({
    彩種: row.lotteryTitle || (row.lotteryType === 'ttl' ? '天天樂' : '539'),
    追蹤類型: row.trackType === 'manual' ? '手動追蹤' : '系統追蹤',
    來源: row.sourceName || '',
    期別鍵值: row.issueKey || '',
    對獎時間: row.checkedAt || '',
    開獎號碼: Array.isArray(row.draw) ? row.draw.join('、') : '',
    第一組命中: row.resultMap?.group1 ?? '',
    第二組命中: row.resultMap?.group2 ?? '',
    第三組命中: row.resultMap?.group3 ?? '',
    第四組命中: row.resultMap?.group4 ?? '',
    全車命中: row.resultMap?.full ?? '',
    本期結果: row.finalLabel || ''
  }));
}

function writeSheet(wb, name, rows) {
  const safeRows = Array.isArray(rows) && rows.length ? rows : [{ 提示: '目前沒有資料' }];
  const ws = XLSX.utils.json_to_sheet(safeRows);
  const keys = Object.keys(safeRows[0] || {});
  ws['!cols'] = keys.map((key) => ({ wch: Math.max(12, String(key).length + 4) }));
  XLSX.utils.book_append_sheet(wb, ws, name);
}

function generateLogsWorkbook() {
  ensureDir(EXPORT_DIR);
  const trackingMap = normalizeTrackingMap(readJson(TRACKING_FILE, { '539': null, 'ttl': null }));
  const trackingHistory = readJson(TRACKING_HISTORY_FILE, []);
  const resultHistory = readJson(RESULT_HISTORY_FILE, []);

  const wb = XLSX.utils.book_new();
  writeSheet(wb, '目前追蹤', buildActiveRows(trackingMap));
  writeSheet(wb, '追蹤歷程', buildTrackingHistoryRows(trackingHistory));
  writeSheet(wb, '對獎結果', buildResultRows(resultHistory));
  writeSheet(wb, '匯出資訊', [{ 匯出時間: formatTaipeiDateTime(), 時區: 'Asia/Taipei', 檔名: 'logs.xlsx' }]);

  const filePath = path.join(EXPORT_DIR, 'logs.xlsx');
  XLSX.writeFile(wb, filePath);
  return filePath;
}

module.exports = { generateLogsWorkbook, EXPORT_DIR };
