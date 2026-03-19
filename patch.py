from pathlib import Path
import re
base = Path('/tmp/v1136b')

def patch_js(text):
    text = text.replace("const sourceName = ($(`${id}_manualSource`)?.value || '').trim();", "const manualSourceInput = $(`${id}_manualSource`);\n    const sourceName = String((manualSourceInput?.value ?? manualSourceInput?.getAttribute('value') ?? '')).trim() || '手動追蹤';")
    text = text.replace("if(!sourceName){\n      showMiniNotice(`${s.cfg.title}：請先輸入通報名稱`, 'warn');\n      return;\n    }\n", "")
    if "function rankPackCandidate(metrics)" not in text:
        text = text.replace("function buildCandidatePlanMetrics(mains, analysis){", "function rankPackCandidate(metrics){\n  const severePenalty = metrics.highCount * 1000 + Math.max(0, metrics.watchCount - 2) * 120 + metrics.totalScore;\n  return severePenalty;\n}\n\nfunction isCandidateBetter(metricsA, metricsB){\n  if(!metricsB) return true;\n  const rankA = rankPackCandidate(metricsA);\n  const rankB = rankPackCandidate(metricsB);\n  if(rankA !== rankB) return rankA < rankB;\n  if(metricsA.highCount !== metricsB.highCount) return metricsA.highCount < metricsB.highCount;\n  if(metricsA.watchCount !== metricsB.watchCount) return metricsA.watchCount < metricsB.watchCount;\n  return metricsA.totalScore < metricsB.totalScore;\n}\n\nfunction buildCandidatePlanMetrics(mains, analysis){")
    text = text.replace("    if (tripleHitCount > 0 || score >= 13.5 || riskyCount >= 3 || pairHitCount >= 2) {\n      status = '高風險';\n      reason = tripleHitCount > 0 ? '命中高風險三碰，整組淘汰' : pairHitCount >= 2 ? '高風險雙碰過多，建議重生' : '風險號過多或分布過擠';\n    } else if (pairHitCount === 1 || score >= 8.6 || riskyCount >= 2 || decadePenalty >= 1 || tailPenalty >= 1) {\n      status = '需留意';\n      reason = pairHitCount === 1 ? '有 1 組高風險雙碰，通報前建議再生' : '局部集中或風險略高';\n    } else if (hotCount >= 3 && trendCount === 0) {", "    if (tripleHitCount > 0 || pairHitCount >= 2 || score >= 17.5 || (riskyCount >= 4 && (tailPenalty + decadePenalty) >= 2)) {\n      status = '高風險';\n      reason = tripleHitCount > 0 ? '命中高風險三碰，整組淘汰' : pairHitCount >= 2 ? '高風險雙碰過多，建議重生' : '風險集中過高或分布過擠';\n    } else if (pairHitCount === 1 || score >= 10.8 || riskyCount >= 3 || decadePenalty >= 2 || tailPenalty >= 2) {\n      status = '需留意';\n      reason = pairHitCount === 1 ? '有 1 組高風險雙碰，建議再分散' : '局部集中或風險略高';\n    } else if (hotCount >= 3 && trendCount === 0) {")
    text = text.replace("  const packStatus = highCount > 0 ? '不可通報' : watchCount > 1 ? '勉強可用' : '可通報';\n  const canNotify = packStatus === '可通報';", "  const canNotify = highCount === 0 && watchCount <= 2;\n  const packStatus = canNotify ? (watchCount === 0 ? '可通報' : '勉強可用') : '不可通報';")
    text = text.replace("  const candidateCount = 1500;", "  const candidateCount = 2200;")
    text = text.replace("        if(detail.status === '可用' || detail.status === '偏熱') break;", "        if(detail.status === '可用' || detail.status === '偏熱' || (detail.status === '需留意' && detail.score < 9.4)) break;")
    marker = "  for(let candidateIndex=0; candidateIndex<candidateCount; candidateIndex++){"
    if "function optimizeCandidatePack(seedGroups)" not in text:
        inject = '''  function optimizeCandidatePack(seedGroups){
    let bestGroups = JSON.parse(JSON.stringify(seedGroups));
    let bestMetrics = buildCandidatePlanMetrics([bestGroups[groupNames[0]], bestGroups[groupNames[1]], bestGroups[groupNames[2]], bestGroups[groupNames[3]]], analysis);
    for(let round=0; round<12; round++){
      if(bestMetrics.canNotify) break;
      const ordered = bestMetrics.groupDetails.slice().sort((a,b)=>{
        const weight = { '高風險': 3, '需留意': 2, '偏熱': 1, '可用': 0 };
        const diff = (weight[b.status]||0) - (weight[a.status]||0);
        if(diff) return diff;
        return (b.score||0) - (a.score||0);
      });
      let mutated = false;
      for(const detail of ordered.slice(0, 2)){
        const targetName = groupNames[detail.index - 1];
        const fixedUsed = new Set();
        for(let gi=0; gi<4; gi++){
          const name = groupNames[gi];
          if(name === targetName) continue;
          (bestGroups[name] || []).forEach(n=>fixedUsed.add(n));
        }
        let bestLocalGroups = null;
        let bestLocalMetrics = null;
        for(let localTry=0; localTry<120; localTry++){
          const localUsed = new Set(Array.from(fixedUsed));
          const safeMid = shuffle((mid || []).filter(n=>!riskyNumbers.has(n) && !cold.includes(n)));
          const safeWarm = shuffle((warm || []).filter(n=>!riskyNumbers.has(n)));
          const safeTrend = shuffle((trendUp || []).filter(n=>!riskyNumbers.has(n)));
          const safeAll = shuffle(allNums.filter(n=>!localUsed.has(n) && !riskyNumbers.has(n) && !cold.includes(n)));
          const pools = [safeMid, safeWarm, safeTrend, shuffle(mid), shuffle(warm), safeAll, shuffle(hot).slice(0,3), shuffle(cold).slice(0,2)];
          const proposed = makeGroupFromPools(5, pools, localUsed, highRiskPairs, highRiskTriples, maxNum);
          if(proposed.length < 5) continue;
          const trialGroups = JSON.parse(JSON.stringify(bestGroups));
          trialGroups[targetName] = proposed;
          const trialMetrics = buildCandidatePlanMetrics([trialGroups[groupNames[0]], trialGroups[groupNames[1]], trialGroups[groupNames[2]], trialGroups[groupNames[3]]], analysis);
          if(isCandidateBetter(trialMetrics, bestLocalMetrics)){
            bestLocalMetrics = trialMetrics;
            bestLocalGroups = trialGroups;
            if(trialMetrics.canNotify) break;
          }
        }
        if(bestLocalGroups && isCandidateBetter(bestLocalMetrics, bestMetrics)){
          bestGroups = bestLocalGroups;
          bestMetrics = bestLocalMetrics;
          mutated = true;
        }
        if(bestMetrics.canNotify) break;
      }
      if(!mutated) break;
    }
    return { groups: bestGroups, metrics: bestMetrics };
  }

'''
        text = text.replace(marker, inject + marker)
    text = text.replace("    const candidate = {\n      groups,", "    const optimized = optimizeCandidatePack(groups);\n    const finalGroups = optimized.groups;\n    const finalMetrics = optimized.metrics;\n    groups[groupNames[0]] = finalGroups[groupNames[0]];\n    groups[groupNames[1]] = finalGroups[groupNames[1]];\n    groups[groupNames[2]] = finalGroups[groupNames[2]];\n    groups[groupNames[3]] = finalGroups[groupNames[3]];\n    const candidate = {\n      groups,")
    text = text.replace("      twoHitRisk: metrics.twoHitRisk,\n      threeHitRisk: metrics.threeHitRisk,\n      lowRiskGroups: metrics.groupDetails.filter(v => v.status === '可用' || v.status === '偏熱').length,\n      mediumRiskGroups: metrics.groupDetails.filter(v => v.status === '需留意').length,\n      rejectedGroups: metrics.groupDetails.filter(v => v.status === '高風險').length,", "      twoHitRisk: finalMetrics.twoHitRisk,\n      threeHitRisk: finalMetrics.threeHitRisk,\n      lowRiskGroups: finalMetrics.groupDetails.filter(v => v.status === '可用' || v.status === '偏熱').length,\n      mediumRiskGroups: finalMetrics.groupDetails.filter(v => v.status === '需留意').length,\n      rejectedGroups: finalMetrics.groupDetails.filter(v => v.status === '高風險').length,")
    text = text.replace("      hotCounts: metrics.hotCounts,\n      candidateTotalScore: metrics.totalScore,\n      detailScores: metrics.detailScores,\n      packStatus: metrics.packStatus,\n      canNotify: metrics.canNotify,\n      groupDetails: metrics.groupDetails,\n      noQualifiedResult: !metrics.canNotify,\n      score: Number(Math.max(46, (98 - metrics.totalScore)).toFixed(1)),\n      whyQualified: metrics.canNotify\n        ? `已從 ${candidateCount} 套候選中挑出四組都過線的方案；需留意 ${metrics.watchCount} 組，高風險 ${metrics.highCount} 組。`\n        : `已搜尋 ${candidateCount} 套候選，但本輪沒有找到四組都過線的方案；目前僅保留最低風險備選。`\n    };\n    if(metrics.canNotify){\n      if(!qualified || candidate.candidateTotalScore < qualified.candidateTotalScore) qualified = candidate;\n    } else if(!fallback || candidate.candidateTotalScore < fallback.candidateTotalScore) {", "      hotCounts: finalMetrics.hotCounts,\n      candidateTotalScore: finalMetrics.totalScore,\n      detailScores: finalMetrics.detailScores,\n      packStatus: finalMetrics.packStatus,\n      canNotify: finalMetrics.canNotify,\n      groupDetails: finalMetrics.groupDetails,\n      noQualifiedResult: !finalMetrics.canNotify,\n      score: Number(Math.max(52, (99 - finalMetrics.totalScore)).toFixed(1)),\n      whyQualified: finalMetrics.canNotify\n        ? `已從 ${candidateCount} 套候選中挑出四組可用且風險已分散的方案；需留意 ${finalMetrics.watchCount} 組，高風險 ${finalMetrics.highCount} 組。`\n        : `已搜尋 ${candidateCount} 套候選，但本輪沒有找到四組都過線的方案；系統已自動重整爆雷組後仍未過線。`\n    };\n    if(finalMetrics.canNotify){\n      if(!qualified || candidate.candidateTotalScore < qualified.candidateTotalScore) qualified = candidate;\n    } else if(!fallback || candidate.candidateTotalScore < fallback.candidateTotalScore) {")
    return text

for fname in ['script.js','_inline.js']:
    p = base/fname
    p.write_text(patch_js(p.read_text()))

p = base/'trackingService.js'
s = p.read_text()
s = s.replace("  const sourceName = String(payload.sourceName || '').trim();\n  if (!sourceName) throw new Error('請輸入通報名稱');", "  const sourceName = String(payload.sourceName || payload.source || '').trim() || '手動追蹤';")
p.write_text(s)

p = base/'index.html'
html = p.read_text()
html = html.replace(".toastWrap{\n      position:fixed;\n      left:18px;\n      right:auto;\n      bottom:18px;", ".toastWrap{\n      position:fixed;\n      left:auto;\n      right:18px;\n      top:18px;\n      bottom:auto;")
inline = (base/'_inline.js').read_text()
start = html.find('<script>')
end = html.rfind('</script>')
if start != -1 and end != -1 and end > start:
    html = html[:start+8] + '\n' + inline + '\n  ' + html[end:]
p.write_text(html)
