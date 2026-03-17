const fs = require('fs');
const { formatTaipeiDateTime, formatTaipeiCompact } = require('./utils/time');
const { getDataDir, getDataFile } = require('./dataPaths');

const DATA_DIR = getDataDir();
const TRACKING_FILE = getDataFile('tracking.json');
const HISTORY_FILE = getDataFile('tracking_history.json');

function ensureDir() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
}

function ensureFile(file, fallback) {
  ensureDir();
  if (!fs.existsSync(file)) {
    fs.writeFileSync(file, JSON.stringify(fallback, null, 2), 'utf8');
  }
}

function readJson(file, fallback) {
  ensureFile(file, fallback);
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    return fallback;
  }
}

function writeJson(file, data) {
  ensureDir();
  fs.writeFileSync(file, JSON.stringify(data, null, 2), 'utf8');
}

function normalizeLotteryType(lotteryType) {
  return lotteryType === 'ttl' ? 'ttl' : '539';
}

function defaultTypeState() {
  return { system: null, manuals: [] };
}

function normalizeLegacyMap(raw) {
  const out = { '539': defaultTypeState(), 'ttl': defaultTypeState() };
  ['539', 'ttl'].forEach((key) => {
    const value = raw && raw[key];
    if (!value) return;
    if (value.system !== undefined || Array.isArray(value.manuals)) {
      out[key] = {
        system: value.system || null,
        manuals: Array.isArray(value.manuals) ? value.manuals : []
      };
    } else {
      out[key] = { system: value, manuals: [] };
    }
  });
  return out;
}

function getTrackingMap() {
  return normalizeLegacyMap(readJson(TRACKING_FILE, { '539': null, 'ttl': null }));
}

function saveTrackingMap(map) {
  writeJson(TRACKING_FILE, normalizeLegacyMap(map));
}

function appendHistory(entry) {
  const history = readJson(HISTORY_FILE, []);
  history.push(entry);
  writeJson(HISTORY_FILE, history);
}

function getTypeState(lotteryType) {
  const map = getTrackingMap();
  return map[normalizeLotteryType(lotteryType)] || defaultTypeState();
}

function getTodayKey() {
  return formatTaipeiCompact().slice(0, 8);
}

function extractDateKey(value) {
  const str = String(value || '');
  return str.replace(/[^0-9]/g, '').slice(0, 8);
}

function isRecordActive(row) {
  if (!row || row.status !== 'pending') return false;
  const dateKey = extractDateKey(row.createdAt || row.confirmedAt);
  return !dateKey || dateKey === getTodayKey();
}

function getActiveTracking(lotteryType) {
  const state = getTypeState(lotteryType);
  return isRecordActive(state.system) ? state.system : null;
}

function getActiveTrackings(lotteryType) {
  const state = getTypeState(lotteryType);
  const list = [];
  if (isRecordActive(state.system)) list.push(state.system);
  for (const row of Array.isArray(state.manuals) ? state.manuals : []) {
    if (isRecordActive(row)) list.push(row);
  }
  return list;
}

function cancelTrackingById(lotteryType, trackingId, reason = 'replaced') {
  const key = normalizeLotteryType(lotteryType);
  const map = getTrackingMap();
  const state = map[key] || defaultTypeState();
  let current = null;

  if (state.system && state.system.id === trackingId) {
    current = state.system;
    state.system = null;
  } else {
    const idx = (state.manuals || []).findIndex((x) => x.id === trackingId);
    if (idx >= 0) current = state.manuals.splice(idx, 1)[0];
  }

  if (!current) return null;
  const cancelled = {
    ...current,
    status: 'cancelled',
    cancelReason: reason,
    cancelledAt: formatTaipeiDateTime()
  };
  appendHistory(cancelled);
  map[key] = state;
  saveTrackingMap(map);
  return cancelled;
}

function cancelActiveTracking(lotteryType, reason = 'replaced') {
  const current = getActiveTracking(lotteryType);
  if (!current) return null;
  return cancelTrackingById(lotteryType, current.id, reason);
}

function replaceSystemTracking(lotteryType, tracking, reason = 'replaced-before-draw') {
  const key = normalizeLotteryType(lotteryType);
  const map = getTrackingMap();
  const state = map[key] || defaultTypeState();
  let replaced = null;

  if (state.system && isRecordActive(state.system)) {
    replaced = {
      ...state.system,
      status: 'cancelled',
      cancelReason: reason,
      cancelledAt: formatTaipeiDateTime()
    };
    appendHistory(replaced);
  }

  state.system = tracking;
  map[key] = state;
  saveTrackingMap(map);
  appendHistory({ ...tracking, event: replaced ? 'updated' : 'created' });
  return { tracking, replaced };
}

function replaceManualTracking(lotteryType, tracking, reason = 'replaced-by-new-manual') {
  const key = normalizeLotteryType(lotteryType);
  const map = getTrackingMap();
  const state = map[key] || defaultTypeState();
  const manuals = Array.isArray(state.manuals) ? state.manuals : [];
  const replaced = [];
  const kept = [];

  for (const row of manuals) {
    if (isRecordActive(row) && String(row.sourceName || '') === String(tracking.sourceName || '')) {
      const cancelled = {
        ...row,
        status: 'cancelled',
        cancelReason: reason,
        cancelledAt: formatTaipeiDateTime()
      };
      replaced.push(cancelled);
      appendHistory(cancelled);
    } else {
      kept.push(row);
    }
  }

  kept.push(tracking);
  state.manuals = kept;
  map[key] = state;
  saveTrackingMap(map);
  appendHistory({ ...tracking, event: replaced.length ? 'updated' : 'created' });
  return { tracking, replaced };
}

function setActiveTracking(lotteryType, tracking) {
  const type = tracking.trackType || 'system';
  if (type === 'manual') {
    return replaceManualTracking(lotteryType, tracking);
  }
  return replaceSystemTracking(lotteryType, tracking);
}

function settleTracking(lotteryType, trackingId, settlement) {
  const key = normalizeLotteryType(lotteryType);
  const map = getTrackingMap();
  const state = map[key] || defaultTypeState();
  let current = null;

  if (state.system && state.system.id === trackingId) {
    current = state.system;
    state.system = null;
  } else {
    const idx = (state.manuals || []).findIndex((x) => x.id === trackingId);
    if (idx >= 0) current = state.manuals.splice(idx, 1)[0];
  }
  if (!current) return null;

  const settled = {
    ...current,
    status: 'completed',
    completedAt: formatTaipeiDateTime(),
    settlement: settlement || null
  };
  appendHistory(settled);
  map[key] = state;
  saveTrackingMap(map);
  return settled;
}

function getTrackingHistory(lotteryType, limit = 100) {
  const key = normalizeLotteryType(lotteryType);
  const history = readJson(HISTORY_FILE, []).filter((x) => x.lotteryType === key);
  return history.slice(-limit).reverse();
}

module.exports = {
  getActiveTracking,
  getActiveTrackings,
  getTrackingHistory,
  cancelActiveTracking,
  cancelTrackingById,
  replaceSystemTracking,
  replaceManualTracking,
  setActiveTracking,
  settleTracking,
  normalizeLotteryType
};
