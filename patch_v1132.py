from pathlib import Path
import re
base = Path('/mnt/data/v1132')

# 1) resultService helpers
p = base/'resultService.js'
text = p.read_text()
anchor = "function enrichAnalysisForTracking(tracking) {"
insert = r'''
function buildHistoryAnalysisFromRows(rows, analysisWindow = ANALYSIS_WINDOW) {
  const list = Array.isArray(rows) ? rows : [];
  const draws = list
    .map((row) => Array.isArray(row?.draw) ? row.draw.map(pad2).filter(Boolean) : [])
    .filter((arr) => arr.length >= 5)
    .slice(-analysisWindow)
    .reverse();
  const drawCount = draws.length;
  const counts = {};
  const pairCounts = {};
  const tripleCounts = {};
  const addCombo = (store, arr) => {
    const key = comboKeyLocal(arr);
    store[key] = Number(store[key] || 0) + 1;
  };
  draws.forEach((draw) => {
    draw.forEach((n) => { counts[n] = Number(counts[n] || 0) + 1; });
    getCombinationsLocal(draw, 2).forEach((pair) => addCombo(pairCounts, pair));
    getCombinationsLocal(draw, 3).forEach((triple) => addCombo(tripleCounts, triple));
  });
  const allNums = Array.from({ length: 39 }, (_, i) => String(i + 1).padStart(2, '0'));
  allNums.forEach((n) => { if (counts[n] === undefined) counts[n] = 0; });
  const sorted = allNums.slice().sort((a, b) => Number(counts[b] || 0) - Number(counts[a] || 0) || Number(a) - Number(b));
  const hotNumbers = sorted.slice(0, 10);
  const warmNumbers = sorted.slice(10, 20);
  const coldNumbers = sorted.slice(-10);
  const coldSet = new Set(coldNumbers);
  const hotSet = new Set(hotNumbers);
  const warmSet = new Set(warmNumbers);
  const midNumbers = sorted.filter((n) => !hotSet.has(n) && !warmSet.has(n) && !coldSet.has(n));

  const shortSize = Math.min(draws.length, 30);
  const mediumSize = Math.min(draws.length, 60);
  const shortCounts = {};
  const mediumCounts = {};
  draws.slice(0, shortSize).forEach((draw) => draw.forEach((n) => { shortCounts[n] = Number(shortCounts[n] || 0) + 1; }));
  draws.slice(0, mediumSize).forEach((draw) => draw.forEach((n) => { mediumCounts[n] = Number(mediumCounts[n] || 0) + 1; }));
  allNums.forEach((n) => {
    if (shortCounts[n] === undefined) shortCounts[n] = 0;
    if (mediumCounts[n] === undefined) mediumCounts[n] = 0;
  });
  const trendScoreMap = {};
  allNums.forEach((n) => {
    const shortRate = shortSize ? Number(shortCounts[n] || 0) / shortSize : 0;
    const mediumRate = mediumSize ? Number(mediumCounts[n] || 0) / mediumSize : 0;
    trendScoreMap[n] = Number(((shortRate - mediumRate) * 100).toFixed(2));
  });
  const trendUpNumbers = allNums.slice().sort((a, b) => Number(trendScoreMap[b] || 0) - Number(trendScoreMap[a] || 0) || Number(a) - Number(b)).filter((n) => Number(trendScoreMap[n] || 0) > 0).slice(0, 8);
  const trendDownNumbers = allNums.slice().sort((a, b) => Number(trendScoreMap[a] || 0) - Number(trendScoreMap[b] || 0) || Number(a) - Number(b)).filter((n) => Number(trendScoreMap[n] || 0) < 0).slice(0, 8);
  const pairThreshold = drawCount >= 100 ? 3 : (drawCount >= 40 ? 2 : 1);
  const tripleThreshold = drawCount >= 100 ? 2 : 1;
  const highRiskPairs = Object.entries(pairCounts).filter(([, v]) => Number(v || 0) >= pairThreshold).sort((a, b) => Number(b[1] || 0) - Number(a[1] || 0)).map(([k]) => k);
  const highRiskTriples = Object.entries(tripleCounts).filter(([, v]) => Number(v || 0) >= tripleThreshold).sort((a, b) => Number(b[1] || 0) - Number(a[1] || 0)).map(([k]) => k);
  const riskyNumbers = Array.from(new Set([...highRiskPairs, ...highRiskTriples].flatMap((key) => String(key).split('-').map(pad2))));

  return {
    drawCount,
    evaluatedWindow: drawCount,
    analysisWindow,
    shortWindow: shortSize,
    mediumWindow: mediumSize,
    counts,
    hotScoreMap: counts,
    warmNumbers,
    hotNumbers,
    coldNumbers,
    midNumbers,
    trendUpNumbers,
    trendDownNumbers,
    trendScoreMap,
    pairCounts,
    tripleCounts,
    pairWeightMap: pairCounts,
    tripleWeightMap: tripleCounts,
    highRiskPairs,
    highRiskTriples,
    riskyNumbers
  };
}

function rebuildTrackingAnalysis(tracking, lotteryType) {
  const type = lotteryType === 'ttl' ? 'ttl' : '539';
  const rows = getResultHistory(type);
  const base = buildHistoryAnalysisFromRows(rows, ANALYSIS_WINDOW);
  if (!base || Number(base.drawCount || 0) <= 0) return { ...tracking, analysis: { ...(tracking.analysis || {}), drawCount: 0, evaluatedWindow: 0 } };
  const enriched = enrichAnalysisForTracking({ ...tracking, analysis: base });
  return { ...tracking, analysis: enriched };
}

'''
text = text.replace(anchor, insert + anchor)
text = text.replace("  getRangeSummary,\n  compareActiveTrackings,\n  issueToNumber,\n  buildNextIssue\n};", "  getRangeSummary,\n  compareActiveTrackings,\n  issueToNumber,\n  buildNextIssue,\n  buildHistoryAnalysisFromRows,\n  rebuildTrackingAnalysis\n};")
p.write_text(text)

# 2) trackingStore add update function
p = base/'trackingStore.js'
text = p.read_text()
insert_anchor = "function settleTracking(lotteryType, trackingId, settlement) {"
insert = r'''
function updateTrackingById(lotteryType, trackingId, updater) {
  const key = normalizeLotteryType(lotteryType);
  const map = getTrackingMap();
  const state = map[key] || defaultTypeState();
  let updated = null;
  if (state.system && state.system.id === trackingId) {
    updated = typeof updater === 'function' ? updater(state.system) : { ...state.system, ...(updater || {}) };
    state.system = updated;
  } else {
    state.manuals = (state.manuals || []).map((row) => {
      if (row.id !== trackingId) return row;
      updated = typeof updater === 'function' ? updater(row) : { ...row, ...(updater || {}) };
      return updated;
    });
  }
  if (!updated) return null;
  map[key] = state;
  saveTrackingMap(map);
  appendHistory({ ...updated, event: 'analysis-rebuilt', updatedAt: formatTaipeiDateTime() });
  return updated;
}

'''
text = text.replace(insert_anchor, insert + insert_anchor)
text = text.replace("  settleTracking,\n  normalizeLotteryType\n};", "  settleTracking,\n  updateTrackingById,\n  normalizeLotteryType\n};")
p.write_text(text)

# 3) trackingService/server imports and functions
p = base/'trackingService.js'
text = p.read_text()
text = text.replace("  setActiveTracking,\n  normalizeLotteryType\n} = require('./trackingStore');", "  setActiveTracking,\n  updateTrackingById,\n  normalizeLotteryType\n} = require('./trackingStore');")
text = text.replace("const { buildNextIssue } = require('./resultService');", "const { buildNextIssue, rebuildTrackingAnalysis } = require('./resultService');")
add_funcs = r'''

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

'''
text = text.replace("async function cancelTracking(payload) {", add_funcs + "async function cancelTracking(payload) {")
text = text.replace("function getTrackingOverview(lotteryType) {\n  const active = getActiveTrackings(lotteryType);", "function getTrackingOverview(lotteryType) {\n  const active = getActiveTrackings(lotteryType).map((row) => maybeRebuildTrackingAnalysis(lotteryType, row));")
text = text.replace("module.exports = { confirmTracking, confirmManualTracking, cancelTracking, getTrackingOverview, FULL_GROUP_SIZE };", "module.exports = { confirmTracking, confirmManualTracking, cancelTracking, getTrackingOverview, recalculateTrackingAnalysis, FULL_GROUP_SIZE };")
p.write_text(text)

p = base/'server.js'
text = p.read_text()
text = text.replace("const { confirmTracking, confirmManualTracking, cancelTracking, getTrackingOverview } = require('./trackingService');", "const { confirmTracking, confirmManualTracking, cancelTracking, getTrackingOverview, recalculateTrackingAnalysis } = require('./trackingService');")
anchor = "app.get('/api/tracking/:type', (req, res) => res.json(getTrackingOverview(req.params.type)));"
text = text.replace(anchor, anchor + "\napp.post('/api/tracking/recalculate', (req, res) => {\n  try { res.json(recalculateTrackingAnalysis(req.body || {})); }\n  catch (err) { res.status(400).json({ ok: false, message: err.message || '重算分析失敗' }); }\n});")
p.write_text(text)

# 4) botInteraction add 分析 keyword
p = base/'botInteraction.js'
text = p.read_text()
text = text.replace("'學習狀態', '最近結果', '同步正常嗎', '同步狀態', '本週', '這週', '這周', '上週', '上周', '上上週', '上上周', '到', '～'", "'學習狀態', '最近結果', '分析', '同步正常嗎', '同步狀態', '本週', '這週', '這周', '上週', '上周', '上上週', '上上周', '到', '～'")
p.write_text(text)

# 5) front-end patches in script, _inline, index.html
for name in ['script.js', '_inline.js', 'index.html']:
    p = base/name
    text = p.read_text()
    text = text.replace("fab.textContent = 'v11.2 任務中心';", "fab.innerHTML = '<span aria-hidden=\"true\">⚙️</span><span>v11.3.2 任務中心</span>'; fab.setAttribute('aria-label','v11.3.2 任務中心');")
    text = text.replace("showMiniNotice(`${state.lotteries[id].cfg.title}：請先輸入通報名稱`, 'warn');", "showMiniNotice(`${state.lotteries[id].cfg.title}：請先輸入通報名稱`, 'warn');")
    text = text.replace("bestGroupText: analyzedDraws > 0 ? '請重建追蹤後再看逐組結果' : '尚未同步歷史資料',\n        riskGroupText: analyzedDraws > 0 ? '舊追蹤缺少細節' : '目前無法比較四組風險',\n        structureSummary: analyzedDraws > 0 ? 'analysis 欄位缺失' : 'drawCount=0，現在看到的 0 不是分析結果',\n        actionAdvice: analyzedDraws > 0 ? '刪除舊追蹤並用目前版本重建' : '先同步最新歷史，再重新送出追蹤',", "bestGroupText: analyzedDraws > 0 ? '可直接按「重算分析」補回逐組結果' : '尚未同步歷史資料',\n        riskGroupText: analyzedDraws > 0 ? '目前先以空分析顯示' : '目前無法比較四組風險',\n        structureSummary: analyzedDraws > 0 ? 'analysis 欄位缺失，可補算' : 'drawCount=0，現在看到的 0 不是分析結果',\n        actionAdvice: analyzedDraws > 0 ? '按下重算分析，系統會用最新歷史補回資料' : '先同步最新歷史，再按重算分析或重新送出追蹤',")
    # add recalc button and handler
    text = text.replace("return `<div class=\"groupRow\"><b>${title}</b><div class=\"small\">建立：${escapeHtml(row.confirmedAt || row.createdAt || '')}</div><div style=\"margin-top:6px;\">${nums}</div>${recHtml}<div class=\"btns\" style=\"margin-top:8px;\"><button class=\"secondary btnCancelTracking\" data-id=\"${escapeHtml(row.id || '')}\">取消這筆追蹤</button></div></div>`;", "return `<div class=\"groupRow\"><b>${title}</b><div class=\"small\">建立：${escapeHtml(row.confirmedAt || row.createdAt || '')}</div><div style=\"margin-top:6px;\">${nums}</div>${recHtml}<div class=\"btns\" style=\"margin-top:8px;\"><button class=\"secondary btnRecalcTracking\" data-id=\"${escapeHtml(row.id || '')}\">重算分析</button><button class=\"secondary btnCancelTracking\" data-id=\"${escapeHtml(row.id || '')}\">取消這筆追蹤</button></div></div>`;")
    text = text.replace("      Array.from(box.querySelectorAll('.btnCancelTracking')).forEach((btn)=>{\n        btn.addEventListener('click', ()=>cancelTrackingItem(id, btn.dataset.id || ''));\n      });", "      Array.from(box.querySelectorAll('.btnRecalcTracking')).forEach((btn)=>{\n        btn.addEventListener('click', ()=>recalculateTrackingItem(id, btn.dataset.id || ''));\n      });\n      Array.from(box.querySelectorAll('.btnCancelTracking')).forEach((btn)=>{\n        btn.addEventListener('click', ()=>cancelTrackingItem(id, btn.dataset.id || ''));\n      });")
    # insert recalc function before cancelTrackingItem
    text = text.replace("  async function cancelTrackingItem(id, trackingId){", "  async function recalculateTrackingItem(id, trackingId){\n    const title = state.lotteries[id].cfg.title;\n    try{\n      const result = await postJsonApi('/api/tracking/recalculate', { lotteryType: id === 'ttl' ? 'ttl' : '539', trackingId });\n      if(!result?.ok) throw new Error(result?.message || '重算分析失敗');\n      showMiniNotice(`${title}：${result.message || '已補上分析'}`, 'ok');\n      await refreshTrackingBoard(id, { silent: true });\n    }catch(err){\n      showMiniNotice(`${title}：重算分析失敗：${err.message || '未知錯誤'}`, 'warn');\n    }\n  }\n\n  async function cancelTrackingItem(id, trackingId){")
    # css tweak for compact button if present in html files
    text = text.replace("#taskCenterFab.fabCompact span:last-child{display:none}", "#taskCenterFab{display:flex;align-items:center;gap:8px}#taskCenterFab.fabCompact span:last-child{display:none}")
    p.write_text(text)

# 6) script and inline versions strings in modal
for name in ['script.js','_inline.js','index.html']:
    p = base/name
    text = p.read_text()
    text = text.replace('v11.2 任務中心', 'v11.3.2 任務中心')
    p.write_text(text)
