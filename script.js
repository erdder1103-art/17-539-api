
(() => {
  const $ = (id) => document.getElementById(id);
  const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

  const API_BASE = "https://17-539-api-production-9873.up.railway.app";
  const API_FALLBACK_BASE = window.location.origin;

  const CONFIG = {
    autoRefreshMs: 30 * 1000,
    fetchLimit: 50,
    storageKey: "lottery_dual_machine_v31_dual_tracking",
    urls: {
      ttl: [`${API_BASE}/api/ttl`, `${API_FALLBACK_BASE}/api/ttl`],
      l539: [`${API_BASE}/api/539`, `${API_FALLBACK_BASE}/api/539`]
    }
  };

  const state = {
    lotteries: {},
    settings: {
      autoSave: true,
      autoDownloadXlsx: false
    },
    trackingSubmitLocks: {
      ttl: false,
      l539: false
    }
  };

  function escapeHtml(str){
    return String(str)
      .replaceAll("&","&amp;")
      .replaceAll("<","&lt;")
      .replaceAll(">","&gt;")
      .replaceAll('"',"&quot;")
      .replaceAll("'","&#039;");
  }

  function getTaipeiParts(){
    const parts = new Intl.DateTimeFormat("zh-TW", {
      timeZone: "Asia/Taipei",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: false
    }).formatToParts(new Date());
    const pick = type => parts.find(x=>x.type===type)?.value || "";
    return {
      year: pick("year"),
      month: pick("month"),
      day: pick("day"),
      hour: pick("hour"),
      minute: pick("minute"),
      second: pick("second")
    };
  }

  function nowStr(){
    const t = getTaipeiParts();
    return `${t.hour}:${t.minute}:${t.second}`;
  }

  function nowFull(){
    const t = getTaipeiParts();
    return `${t.year}-${t.month}-${t.day} ${t.hour}:${t.minute}:${t.second}`;
  }

  function setTaipeiClock(){
    const el = $("clockText");
    if(!el) return;
    const render = () => {
      try{
        const parts = new Intl.DateTimeFormat("zh-TW", {
          timeZone: "Asia/Taipei",
          year: "numeric",
          month: "2-digit",
          day: "2-digit",
          hour: "2-digit",
          minute: "2-digit",
          second: "2-digit",
          hour12: false
        }).formatToParts(new Date());
        const pick = type => parts.find(x=>x.type===type)?.value || "";
        el.textContent = `${pick("year")}-${pick("month")}-${pick("day")} ${pick("hour")}:${pick("minute")}:${pick("second")}`;
      }catch(e){
        el.textContent = nowFull();
      }
    };
    render();
    setInterval(render, 1000);
  }

  let __winnerAudio = null;
  let __winnerMusicTimer = null;
  let __winnerMusicCtx = null;
  let __tickLastAt = 0;

  function ensureAudio(){
    try{
      const AudioCtx = window.AudioContext || window.webkitAudioContext;
      if(!AudioCtx) return null;
      const ctx = (window.__dingCtx ||= new AudioCtx());
      if (ctx.state === "suspended") ctx.resume?.();
      return ctx;
    }catch(e){ return null; }
  }

  function playDing(){
    ensureAudio();
    try{
      const AudioCtx = window.AudioContext || window.webkitAudioContext;
      if(!AudioCtx) return;
      const ctx = (window.__dingCtx ||= new AudioCtx());
      const now = ctx.currentTime;

      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = "triangle";
      osc.frequency.setValueAtTime(880, now);
      osc.frequency.exponentialRampToValueAtTime(1320, now + 0.06);

      gain.gain.setValueAtTime(0.0001, now);
      gain.gain.exponentialRampToValueAtTime(0.45, now + 0.01);
      gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.22);

      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start(now);
      osc.stop(now + 0.24);
    }catch(e){}
  }

  function playTick(){
    try{
      const ctx = ensureAudio();
      if(!ctx) return;
      const now = ctx.currentTime;
      if (now - __tickLastAt < 0.04) return;
      __tickLastAt = now;

      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      const filter = ctx.createBiquadFilter();

      osc.type = "square";
      const step = (window.__tickStep = (window.__tickStep||0) + 1);
      const seq = [180, 220, 196, 247];
      osc.frequency.setValueAtTime(seq[step % seq.length], now);

      filter.type = "bandpass";
      filter.frequency.setValueAtTime(900, now);
      filter.Q.setValueAtTime(10, now);

      gain.gain.setValueAtTime(0.0001, now);
      gain.gain.exponentialRampToValueAtTime(0.16, now + 0.003);
      gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.045);

      osc.connect(filter);
      filter.connect(gain);
      gain.connect(ctx.destination);
      osc.start(now);
      osc.stop(now + 0.05);
    }catch(e){}
  }

  function startWinnerMusic(){
    try{
      const dataUrl = localStorage.getItem("winner_bgm_dataurl_v1");
      if (dataUrl){
        if(!__winnerAudio){
          __winnerAudio = new Audio(dataUrl);
          __winnerAudio.loop = true;
          __winnerAudio.volume = 0.65;
        }
        __winnerAudio.currentTime = 0;
        __winnerAudio.play().catch(()=>{});
        return;
      }
    }catch(e){}

    if (__winnerMusicCtx) return;
    const AudioCtx = window.AudioContext || window.webkitAudioContext;
    if(!AudioCtx) return;
    __winnerMusicCtx = new AudioCtx();
    const ctx = __winnerMusicCtx;

    const master = ctx.createGain();
    master.gain.value = 0.25;
    master.connect(ctx.destination);

    const lp = ctx.createBiquadFilter();
    lp.type = "lowpass";
    lp.frequency.value = 1400;
    lp.Q.value = 0.5;
    lp.connect(master);

    const pluck = (freq, t, dur=0.18, vol=0.18)=>{
      const o = ctx.createOscillator();
      const g = ctx.createGain();
      o.type = "sine";
      o.frequency.setValueAtTime(freq, t);
      o.frequency.exponentialRampToValueAtTime(freq*0.995, t+dur);

      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(vol, t+0.01);
      g.gain.exponentialRampToValueAtTime(0.0001, t+dur);

      o.connect(g); g.connect(lp);
      o.start(t); o.stop(t+dur+0.02);
    };

    const chord = (root, t)=>{
      pluck(root, t, 0.22, 0.14);
      pluck(root*1.2599, t+0.02, 0.20, 0.11);
      pluck(root*1.4983, t+0.04, 0.22, 0.10);
      pluck(root*2, t+0.10, 0.12, 0.06);
    };

    const ROOT = { C4:261.63, G3:196.00, A3:220.00, F3:174.61 };
    const roots = [ROOT.C4, ROOT.G3, ROOT.A3, ROOT.F3];
    const N = { C5:523.25, D5:587.33, E5:659.25, F5:698.46, G5:783.99, A5:880.00 };
    const bpm = 112;
    const beat = 60 / bpm;
    const bar  = beat * 4;
    const base = ctx.currentTime + 0.08;
    const melody = [
      [N.E5,N.G5,N.E5,N.D5, N.C5,N.D5,N.E5,N.G5],
      [N.D5,N.E5,N.G5,N.A5, N.G5,N.E5,N.D5,N.E5],
      [N.E5,N.E5,N.D5,N.C5, N.D5,N.E5,N.G5,N.A5],
      [N.F5,N.G5,N.A5,N.G5, N.E5,N.D5,N.C5,N.D5],
    ];

    const scheduleOnce = (loopIndex)=>{
      const loopT = base + loopIndex*(bar*4);
      for(let b=0;b<4;b++){
        const tBar = loopT + b*bar;
        chord(roots[b], tBar);
        for(let i=0;i<8;i++){
          const t = tBar + i*(beat/2);
          pluck(melody[b][i], t, 0.16, 0.14);
        }
      }
    };

    let loop = 0;
    scheduleOnce(loop);
    __winnerMusicTimer = setInterval(()=>{
      if(!__winnerMusicCtx) return;
      loop++;
      scheduleOnce(loop);
    }, Math.max(200, (bar * 4 * 1000) - 80));
  }

  async function stopWinnerMusic(){
    if(__winnerAudio){ try{ __winnerAudio.pause(); }catch(e){} }
    if(__winnerMusicTimer){
      clearInterval(__winnerMusicTimer);
      __winnerMusicTimer = null;
    }
    if(__winnerMusicCtx){
      try{ await __winnerMusicCtx.close(); }catch(e){}
    }
    __winnerMusicCtx = null;
  }

  function showSummary(prizeLabel, prizeDesc, winners){
    const overlay = $("summaryOverlay");
    const prize = $("summaryPrize");
    const main = $("summaryMain");
    const sub = $("summarySub");
    const list = $("summaryList");
    prize.textContent = `👑 ${prizeLabel} 抽獎結果`;
    const finalWinner = winners[winners.length - 1] || "—";
    main.innerHTML = `<div class="summaryPrizeBar">${escapeHtml(prizeDesc || prizeLabel)}</div><div class="summaryWinnerId">${escapeHtml(finalWinner)}</div>`;
    sub.textContent = `已抽出 ${winners.length} 顆球（最後停在上方那顆）`;
    list.innerHTML = "";
    winners.forEach((w, i) => {
      const chip = document.createElement("div");
      chip.className = "summaryChip" + (i === winners.length - 1 ? " final" : "");
      chip.textContent = w;
      list.appendChild(chip);
    });
    startWinnerMusic();
    overlay.classList.add("show");
    overlay.setAttribute("aria-hidden", "false");
  }

  function hideSummary(){
    const overlay = $("summaryOverlay");
    overlay.classList.remove("show");
    overlay.setAttribute("aria-hidden", "true");
    stopWinnerMusic();
  }

  $("btnSummaryClose").addEventListener("click", hideSummary);
  $("summaryOverlay").addEventListener("click", (e)=>{ if(e.target.id === "summaryOverlay") hideSummary(); });


  
const searchAnimState = { visible:false, running:false, locked:false, lastStep:0, lastSpin:0, timers:[], currentLotteryId:null, cancelRequested:false };

function getSearchEls(){
  return {
    overlay: $("searchOverlay"), title: $("searchTitle"), sub: $("searchSub"), pill: $("searchStatusPill"), fill: $("searchBarFill"),
    searched: $("searchStatSearched"), target: $("searchStatTarget"), stage: $("searchStatStage"), elapsed: $("searchStatElapsed"), eta: $("searchStatEta"), grid: $("searchGrid"), footer: $("searchFooterText")
  };
}

function clearSearchTimers(){ while(searchAnimState.timers.length){ clearTimeout(searchAnimState.timers.pop()); } }

function makeSearchCard(name, idx){
  const wrap = document.createElement('div');
  wrap.className = 'searchGroupCard';
  wrap.id = `searchCard_${idx}`;
  wrap.innerHTML = `<div class="searchGroupTitle"><span>${escapeHtml(name)}</span><span class="searchGroupBadge" id="searchBadge_${idx}">待搜尋</span></div><div class="searchGroupNums spinPulse" id="searchNums_${idx}">--、--、--、--、--</div><div class="searchGroupHint" id="searchHint_${idx}">等待系統分配候選號碼</div>`;
  return wrap;
}

function openSearchOverlay(id){
  const els = getSearchEls();
  const names = [
    $(`${id}_prize1Desc`).value.trim() || '第一組',
    $(`${id}_prize2Desc`).value.trim() || '第二組',
    $(`${id}_prize3Desc`).value.trim() || '第三組',
    $(`${id}_prize4Desc`).value.trim() || '第四組',
    $(`${id}_prize5Desc`).value.trim() || '全車號碼'
  ];
  els.grid.innerHTML = '';
  names.forEach((name, idx)=> els.grid.appendChild(makeSearchCard(name, idx)));
  els.title.textContent = `${state.lotteries[id].cfg.title}｜自動生成中`;
  els.sub.textContent = '系統會依近50期高風險雙號 / 三連號與熱中冷分布，快速生成一組可用方案。';
  els.pill.textContent = '生成中';
  els.fill.style.width = '0%';
  els.searched.textContent = '0';
  els.target.textContent = '5';
  els.stage.textContent = '初始化';
  els.elapsed.textContent = '0.0 秒';
  els.eta.textContent = '約 1 秒';
  els.footer.textContent = '會依序鎖定第一組、第二組、第三組、第四組與全車號碼。';
  els.overlay.classList.add('show');
  els.overlay.setAttribute('aria-hidden','false');
  searchAnimState.visible = true;
  searchAnimState.running = true;
  searchAnimState.locked = false;
  searchAnimState.cancelRequested = false;
  searchAnimState.lastStep = Date.now();
}

function closeSearchOverlay(force=false){
  const els = getSearchEls();
  if(!force && searchAnimState.running){ searchAnimState.cancelRequested = true; }
  clearSearchTimers();
  els.overlay.classList.remove('show');
  els.overlay.setAttribute('aria-hidden','true');
  searchAnimState.visible = false;
  searchAnimState.running = false;
}

function updateSearchOverlay(id, progress){
  if(!searchAnimState.visible) openSearchOverlay(id);
  const els = getSearchEls();
  const searched = progress?.searched || 0;
  const target = progress?.target || 5;
  const elapsedMs = progress?.elapsedMs || 0;
  const percent = target > 0 ? Math.min(100, (searched / target) * 100) : 0;
  const rate = elapsedMs > 0 ? searched / (elapsedMs / 1000) : 0;
  const etaMs = rate > 0 ? ((target - searched) / rate) * 1000 : 1000;
  els.fill.style.width = `${percent}%`;
  els.searched.textContent = searched.toLocaleString();
  els.target.textContent = target.toLocaleString();
  els.stage.textContent = progress?.stageLabel || '生成中';
  els.elapsed.textContent = `${(elapsedMs / 1000).toFixed(1)} 秒`;
  els.eta.textContent = formatEta(etaMs);
  els.pill.textContent = progress?.statusText || '生成中';
  els.footer.textContent = progress?.footerText || '系統正在避開高風險雙號 / 三連號，並拆散熱號到不同組別。';
}

async function lockSearchResult(id, bestResult){
  const names = Object.keys(bestResult.groups || {});
  searchAnimState.locked = true;
  searchAnimState.running = false;
  const els = getSearchEls();
  els.pill.textContent = '已找到';
  for(let i=0;i<names.length;i++){
    const cardEl = $(`searchCard_${i}`); const numsEl = $(`searchNums_${i}`); const hintEl = $(`searchHint_${i}`); const badgeEl = $(`searchBadge_${i}`);
    const nums = bestResult.groups[names[i]] || [];
    if(cardEl){ cardEl.classList.remove('active'); cardEl.classList.add('locked'); }
    if(numsEl){ numsEl.classList.remove('spinPulse'); numsEl.textContent = nums.join('、'); }
    if(hintEl){ hintEl.textContent = i < 4 ? '已鎖定，可直接確認通報' : '全車號碼已鎖定'; }
    if(badgeEl){ badgeEl.textContent = '已鎖定'; }
    updateSearchOverlay(id, { searched: i+1, target: 5, elapsedMs: Date.now()-searchAnimState.lastStep, stageLabel: `已鎖定 ${names[i]}`, statusText: '生成完成', footerText: '全部組別已鎖定完成，現在可以直接按「確認通報」。' });
    await sleep(180);
  }
  els.pill.textContent = '可通報';
  els.stage.textContent = '全部鎖定完成';
}

$("searchCloseBtn").addEventListener("click", ()=>closeSearchOverlay());
$("searchOverlay").addEventListener("click", (e)=>{ if(e.target.id === "searchOverlay") closeSearchOverlay(); });

function cleanupNumbers(arr, maxNum){
    return [...new Set(
      arr.map(n => String(parseInt(n,10)).padStart(2,"0"))
         .filter(n => {
            const v = parseInt(n,10);
            return !isNaN(v) && v >= 1 && v <= maxNum;
         })
    )];
  }

  function comboKey(nums){
    return [...nums]
      .map(n => String(parseInt(n,10)).padStart(2,"0"))
      .sort((a,b)=>parseInt(a,10)-parseInt(b,10))
      .join("-");
  }

  function getCombinations(arr, k){
    const result = [];
    const n = arr.length;
    function backtrack(start, path){
      if(path.length === k){
        result.push([...path]);
        return;
      }
      for(let i=start;i<n;i++){
        path.push(arr[i]);
        backtrack(i+1, path);
        path.pop();
      }
    }
    backtrack(0, []);
    return result;
  }

  function intersectionCount(a, b){
    const setB = new Set(b);
    let count = 0;
    a.forEach(x=>{ if(setB.has(x)) count++; });
    return count;
  }

  function looksLikeValidHistoryText(text){
    const lines = String(text || "").split(/\r?\n/).map(x=>x.trim()).filter(Boolean);
    if(!lines.length) return false;
    let ok = 0;
    for(const line of lines.slice(0, 10)){
      if(/開獎號碼\s+(\d{2}\s+){4}\d{2}$/.test(line)) ok++;
    }
    return ok >= 1;
  }

  function createLotteryConfig(type){
    if(type === "ttl"){
      return {
        id: "ttl",
        title: "天天樂",
        maxNum: 39,
        drawSize: 5,
        syncUrl: CONFIG.urls.ttl,
        defaultList: Array.from({ length: 39 }, (_, i) => String(i + 1).padStart(2, "0")),
        prizeLabel: "天天樂"
      };
    }
    return {
      id: "l539",
      title: "539",
      maxNum: 39,
      drawSize: 5,
      syncUrl: CONFIG.urls.l539,
      defaultList: Array.from({ length: 39 }, (_, i) => String(i + 1).padStart(2, "0")),
      prizeLabel: "539"
    };
  }

  function createLotteryState(cfg){
    return {
      cfg,
      allList: [],
      pool: [],
      log: [],
      lastAction: null,
      historyAnalysis: null,
      generatedGroups: null,
      autoRefreshEnabled: true,
      rolling: false,
      lastSyncHash: "",
      timer: null,
      restoredHistoryText: ""
    };
  }

  function lotteryTemplate(cfg){
    const id = cfg.id;
    return `
      <div class="lotteryWrap" id="${id}_wrap">
        <div class="card">
          <div class="hd">
            <div class="title"><span class="dot"></span>${cfg.title}｜搖獎號碼</div>
            <div class="small">5 顆球模式</div>
          </div>
          <div class="bd">
            <textarea id="${id}_listInput" placeholder="例如：&#10;01&#10;02&#10;03"></textarea>
            <div class="row" style="margin-top:10px;">
              <div>
                <label class="small">去重／清洗</label>
                <select id="${id}_cleanupMode">
                  <option value="trim">去空白（預設）</option>
                  <option value="digits">只保留數字</option>
                  <option value="none">不處理</option>
                </select>
              </div>
              <div>
                <label class="small">抽獎模式</label>
                <select id="${id}_drawMode">
                  <option value="remove">抽中後移出名單（不重複中獎）</option>
                  <option value="keep">抽中後保留名單（可重複中獎）</option>
                </select>
              </div>
            </div>

            <div class="btns">
              <button id="${id}_btnLoad">載入名單</button>
              <button class="secondary" id="${id}_btnSample">塞入範例</button>
              <button class="secondary" id="${id}_btnShuffle">洗牌名單</button>
              <button class="danger" id="${id}_btnClearAll">清空全部</button>
            </div>

            <div class="stats">
              <div class="stat"><b>名單總數</b><span id="${id}_totalCount">0</span></div>
              <div class="stat"><b>去重後</b><span id="${id}_uniqueCount">0</span></div>
              <div class="stat"><b>目前池內</b><span id="${id}_poolCount">0</span></div>
            </div>

            <div class="footerTip">
              ✅ 手動模式：你也可以貼入 01～39 後用本區按鈕自己抽。<br>
              ✅ 智能模式：按「防 2/3 碰撞自動生成」。
            </div>
          </div>
        </div>

        <div class="card">
          <div class="hd">
            <div class="title"><span class="dot"></span>${cfg.title}｜歷史開獎分析（50期）</div>
            <div class="small">最新紀錄由上往下50期</div>
          </div>
          <div class="bd">
            <textarea id="${id}_historyInput" placeholder="同步後會顯示：&#10;2026/3/11(星期三) 開獎號碼 05 15 26 37 38"></textarea>

            <div class="btns">
              <button id="${id}_btnSync">同步最新 50 期</button>
              <button id="${id}_btnAnalyzeHistory">分析資料</button>
              <button id="${id}_btnGenerateSmart">防 2/3 碰撞自動生成</button>
              <button class="secondary" id="${id}_btnApply01to39">塞入 01-39 到搖獎號碼</button>
            </div>

            <div class="statusLine">
              <span class="statusTag" id="${id}_syncState">尚未同步</span>
              <span class="statusTag ok" id="${id}_autoState">自動更新：開啟</span>
              <button class="secondary" id="${id}_btnToggleAuto">切換自動更新</button>
            </div>

            <div class="small" id="${id}_syncNote" style="margin-top:8px;">
              資料來源：${escapeHtml(cfg.syncUrl)}
            </div>

            <div class="analysisWrap" style="margin-top:12px;">
              <div class="analysisPanel">
                <div class="analysisTitle">熱號（單號次數高）</div>
                <div id="${id}_hotNumbers" class="chips"></div>
              </div>
              <div class="analysisPanel">
                <div class="analysisTitle">冷號（單號次數低）</div>
                <div id="${id}_coldNumbers" class="chips"></div>
              </div>
            </div>

            <div class="analysisPanel" style="margin-top:12px;">
              <div class="analysisTitle">高風險雙號 / 三號</div>
              <div class="chips" id="${id}_riskPairs"></div>
              <div class="chips" id="${id}_riskTriples" style="margin-top:8px;"></div>
            </div>

            <div class="analysisPanel" style="margin-top:12px;">
              <div class="analysisTitle">自動分組預覽</div>
              <div id="${id}_groupPreview" class="groupPreview">
                <div class="small">尚未生成分組</div>
              </div>

              <div class="btns" style="margin-top:10px;">
                <button class="green" id="${id}_btnConfirmTracking">確定通報</button>
              </div>
            </div>

              <div class="analysisPanel" style="margin-top:12px;">
                <div class="analysisTitle">手動追蹤（第一組～第四組＋全車號碼）</div>
                <div class="row">
                  <div>
                    <label class="small">通報名稱</label>
                    <input id="${id}_manualSource" placeholder="例如：阿明通報 / VIP牌組">
                  </div>
                  <div>
                    <label class="small">全車號碼</label>
                    <input id="${id}_manualFull" placeholder="例如：01 02 03 04 05 06 07 08 09 10 11 12 13 14 15 16 17 18 19">
                  </div>
                </div>
                <div class="row" style="margin-top:8px;">
                  <div>
                    <label class="small">第一組（5顆）</label>
                    <input id="${id}_manualGroup1" placeholder="例如：01 09 18 27 39">
                  </div>
                  <div>
                    <label class="small">第二組（5顆）</label>
                    <input id="${id}_manualGroup2" placeholder="例如：02 10 19 28 38">
                  </div>
                </div>
                <div class="row" style="margin-top:8px;">
                  <div>
                    <label class="small">第三組（5顆）</label>
                    <input id="${id}_manualGroup3" placeholder="例如：03 11 20 29 37">
                  </div>
                  <div>
                    <label class="small">第四組（5顆）</label>
                    <input id="${id}_manualGroup4" placeholder="例如：04 12 21 30 36">
                  </div>
                </div>
                <div class="btns" style="margin-top:10px;">
                  <button class="secondary" id="${id}_btnManualTracking">新增手動追蹤</button>
                  <button class="secondary" id="${id}_btnRefreshTracking">刷新追蹤清單</button>
                  <button class="secondary" id="${id}_btnTelegramTest">測試 TG</button>
                </div>
                <div id="${id}_telegramStatus" class="small muted" style="margin-top:8px;line-height:1.7;">Telegram 狀態尚未檢查</div>
                <div class="row" style="margin-top:8px;">
                  <div>
                    <label class="small">BOT_TOKEN（可直接存到伺服器）</label>
                    <input id="${id}_botTokenInput" placeholder="貼上新的 BOT_TOKEN">
                  </div>
                  <div>
                    <label class="small">TG_CHAT_ID（可直接存到伺服器）</label>
                    <input id="${id}_chatIdInput" placeholder="例如：-5292559147">
                  </div>
                </div>
                <div class="btns" style="margin-top:8px;">
                  <button class="secondary" id="${id}_btnSaveTelegramConfig">儲存 TG 設定到伺服器</button>
                </div>
                <div id="${id}_trackingBoard" class="small" style="margin-top:10px;line-height:1.8;">尚未載入追蹤清單</div>
              </div>
          </div>
        </div>

        <div class="card">
          <div class="hd">
            <div class="title"><span class="dot"></span>${cfg.title}｜隨機號碼產生</div>
            <div class="small">第一組～第四組 全車隨機出號</div>
          </div>
          <div class="bd">
            <div class="prizeBox">
              ${[1,2,3,4,5].map(i => `
              <div class="prizeItem">
                <div class="left" style="width:100%; gap:12px;">
                  <div class="prizeGrid">
                    <input id="${id}_prize${i}Label" value="${cfg.prizeLabel}" placeholder="獎項名稱">
                    <input id="${id}_prize${i}Desc" value="${i === 1 ? "第一組" : i === 2 ? "第二組" : i === 3 ? "第三組" : i === 4 ? "第四組" : "全車號碼"}" placeholder="獎項內容">
                    <input id="${id}_prize${i}Count" type="number" min="1" step="1" value="${i === 5 ? 19 : 5}">
                  </div>
                </div>
                <button class="secondary" data-prize-index="${i}" id="${id}_btnPrize${i}">抽 ${i === 5 ? 19 : 5} 顆球</button>
              </div>`).join("")}
            </div>

            <div class="toggleRow">
              <label class="toggleChip">
                <input type="checkbox" id="${id}_autoDownloadXlsx">
                抽獎後自動下載 logs.xlsx
              </label>
            </div>

            <div class="btns" style="margin-top:10px;">
              <button id="${id}_btnUndo">↩ 撤銷上一筆中獎者</button>
              <button class="danger" id="${id}_btnClearLog">🧹 清空中獎紀錄</button>
            </div>
          </div>
        </div>

        <div class="card">
          <div class="hd">
            <div class="title"><span class="dot"></span>${cfg.title}｜抽獎畫面與中獎者名單</div>
          </div>
          <div class="bd">
            <div class="resultBox" id="${id}_resultBox">
              <div class="who" id="${id}_currentWinner">—</div>
              <div class="sub" id="${id}_currentMeta">等待抽獎…</div>
            </div>

            <div class="btns" style="margin-top:10px;">
              <button class="secondary" id="${id}_btnCopyWinner">複製目前中獎者</button>
              <button class="secondary" id="${id}_btnExport">匯出 CSV</button>
              <button class="green" id="${id}_btnExportXlsx">匯出 logs.xlsx</button>
            </div>

            <div class="log">
              <table>
                <thead>
                  <tr>
                    <th style="width:170px;">開獎時間</th>
                    <th style="width:90px;">獎項</th>
                    <th style="width:140px;">獎項內容</th>
                    <th>中獎號碼</th>
                  </tr>
                </thead>
                <tbody id="${id}_logBody">
                  <tr><td class="mono" colspan="4" style="color:rgba(255,220,163,.7)">暫無中獎紀錄</td></tr>
                </tbody>
              </table>
            </div>
          </div>
        </div>
      </div>
    `;
  }

  function mountLotteries(){
    const ttl = createLotteryConfig("ttl");
    const l539 = createLotteryConfig("l539");
    state.lotteries[ttl.id] = createLotteryState(ttl);
    state.lotteries[l539.id] = createLotteryState(l539);
    $("twoCols").innerHTML = lotteryTemplate(ttl) + lotteryTemplate(l539);
  }

  function getEls(id){
    return {
      listInput: $(`${id}_listInput`),
      cleanupMode: $(`${id}_cleanupMode`),
      drawMode: $(`${id}_drawMode`),
      totalCount: $(`${id}_totalCount`),
      uniqueCount: $(`${id}_uniqueCount`),
      poolCount: $(`${id}_poolCount`),
      historyInput: $(`${id}_historyInput`),
      syncState: $(`${id}_syncState`),
      autoState: $(`${id}_autoState`),
      syncNote: $(`${id}_syncNote`),
      hotNumbers: $(`${id}_hotNumbers`),
      coldNumbers: $(`${id}_coldNumbers`),
      riskPairs: $(`${id}_riskPairs`),
      riskTriples: $(`${id}_riskTriples`),
      groupPreview: $(`${id}_groupPreview`),
      resultBox: $(`${id}_resultBox`),
      currentWinner: $(`${id}_currentWinner`),
      currentMeta: $(`${id}_currentMeta`),
      logBody: $(`${id}_logBody`),
      autoDownloadXlsx: $(`${id}_autoDownloadXlsx`)
    };
  }

  function updateStats(id){
    const s = state.lotteries[id];
    const el = getEls(id);
    el.totalCount.textContent = s.allList.length;
    el.uniqueCount.textContent = new Set(s.allList).size;
    el.poolCount.textContent = s.pool.length;
  }

  function renderLog(id){
    const s = state.lotteries[id];
    const el = getEls(id);
    el.logBody.innerHTML = "";
    if (s.log.length === 0){
      const tr = document.createElement("tr");
      tr.innerHTML = `<td class="mono" colspan="4" style="color:rgba(255,220,163,.7)">暫無中獎紀錄</td>`;
      el.logBody.appendChild(tr);
      return;
    }
    [...s.log].reverse().forEach(item => {
      const tr = document.createElement("tr");
      tr.innerHTML =
        `<td class="mono">${escapeHtml(item.dt || "")}</td>` +
        `<td>${escapeHtml(item.prize || "")}</td>` +
        `<td>${escapeHtml(item.prizeDesc || "")}</td>` +
        `<td class="mono">${escapeHtml(item.who || "")}</td>`;
      el.logBody.appendChild(tr);
    });
  }

  function setWinner(id, who, prize){
    const el = getEls(id);
    el.currentWinner.textContent = who || "—";
    el.currentMeta.textContent = who ? `獎項：${prize}｜時間：${nowStr()}` : "等待抽獎…";
  }

  function flashOnce(id){
    const box = getEls(id).resultBox;
    box.classList.remove("flashOnce");
    void box.offsetWidth;
    box.classList.add("flashOnce");
  }

  function cleanupInput(items, mode){
    const cleaned = items
      .map(s => (mode === "none" ? s : s.trim()))
      .filter(s => s && s.length);

    if (mode === "digits"){
      return cleaned
        .map(s => {
          const m = s.match(/\d+/g);
          return m ? m.join("") : "";
        })
        .filter(Boolean);
    }
    return cleaned;
  }

  function setSyncState(id, text, type="normal"){
    const el = getEls(id).syncState;
    el.textContent = text;
    el.className = "statusTag" +
      (type === "ok" ? " ok" : type === "warn" ? " warn" : type === "info" ? " info" : "");
  }

  function setAutoState(id){
    const s = state.lotteries[id];
    const el = getEls(id).autoState;
    el.textContent = `自動更新：${s.autoRefreshEnabled ? "開啟" : "關閉"}`;
    el.className = "statusTag " + (s.autoRefreshEnabled ? "ok" : "warn");
  }

  async function fetchJson(url){
    const urls = Array.isArray(url) ? url : [url];
    let lastErr = null;
    for(const target of urls){
      if(!target) continue;
      try{
        const res = await fetch(target, { cache: "no-store" });
        const text = await res.text();
        if(!res.ok) throw new Error(`HTTP ${res.status}`);
        try{
          const json = JSON.parse(text);
          json.__fetchedUrl = target;
          return json;
        }catch(e){
          throw new Error("API 未正確回傳 JSON");
        }
      }catch(err){
        lastErr = err;
      }
    }
    throw lastErr || new Error('API 讀取失敗');
  }

  function getWeekdayText(dateStr){
    const m = String(dateStr || "").match(/^(\d{4})\/(\d{1,2})\/(\d{1,2})$/);
    if(!m) return "";
    const y = parseInt(m[1], 10);
    const mo = parseInt(m[2], 10) - 1;
    const d = parseInt(m[3], 10);
    const dt = new Date(y, mo, d);
    const weekdays = ["星期日","星期一","星期二","星期三","星期四","星期五","星期六"];
    return weekdays[dt.getDay()] || "";
  }

  function formatShortDate(dateStr){
    const m = String(dateStr || "").match(/^(\d{4})\/(\d{1,2})\/(\d{1,2})$/);
    if(!m) return String(dateStr || "");
    return `${parseInt(m[1],10)}/${parseInt(m[2],10)}/${parseInt(m[3],10)}`;
  }

  function historyRecordsToText(records){
    return records.map((r) => {
      const sortedNums = (Array.isArray(r.numbers) ? r.numbers : [])
        .map(n => parseInt(n, 10))
        .filter(n => !isNaN(n))
        .sort((a,b)=>a-b)
        .map(n => String(n).padStart(2,"0"))
        .join(" ");

      const shortDate = formatShortDate(r.date);
      const weekday = getWeekdayText(r.date);

      return `${shortDate}(${weekday}) 開獎號碼 ${sortedNums}`;
    }).join("\n");
  }

  function historyHash(text){
    let h = 0;
    for(let i=0;i<text.length;i++){
      h = ((h << 5) - h) + text.charCodeAt(i);
      h |= 0;
    }
    return String(h);
  }

  async function syncHistory(id, silent=false){
    const s = state.lotteries[id];
    const el = getEls(id);

    try{
      setSyncState(id, "同步中…", "warn");

      const data = await fetchJson(s.cfg.syncUrl);
      const records = Array.isArray(data.draws) ? data.draws : [];

      if(!records.length){
        throw new Error("API 沒有回傳有效開獎資料");
      }

      const validRecords = records
        .filter(r => Array.isArray(r.numbers) && r.numbers.length === 5)
        .map(r => ({
          date: r.date || "",
          numbers: r.numbers.map(n => String(parseInt(n, 10)).padStart(2, "0"))
        }));

      if(!validRecords.length){
        throw new Error("API 有回資料，但格式不正確");
      }

      const limited = validRecords.slice(0, CONFIG.fetchLimit);
      const text = historyRecordsToText(limited);
      const hash = historyHash(text);

      const changed = s.lastSyncHash && s.lastSyncHash !== hash;
      s.lastSyncHash = hash;
      s.restoredHistoryText = text;

      el.historyInput.value = text;
      setSyncState(id, changed ? "已更新新結果" : "同步完成", "ok");
      el.syncNote.textContent = `資料來源：${data.__fetchedUrl || (Array.isArray(s.cfg.syncUrl) ? s.cfg.syncUrl[0] : s.cfg.syncUrl)} ｜ 最新同步：${nowFull()} ｜ 共 ${limited.length} 期`;

      s.historyAnalysis = analyzeHistoryText(id, text);
      renderHistoryAnalysis(id, s.historyAnalysis);
      persistAll();

      if(changed && !silent){
        showMiniNotice(`${s.cfg.title} 已抓到新結果並更新 50 期資料`, "ok");
      }else if(!silent){
        showMiniNotice(`${s.cfg.title} 同步完成`, "info");
      }

      return true;
    }catch(err){
      setSyncState(id, "同步失敗", "warn");
      el.syncNote.textContent = `資料來源：${Array.isArray(s.cfg.syncUrl) ? s.cfg.syncUrl.join(' / ') : s.cfg.syncUrl} ｜ 同步失敗：${err.message}`;
      if(!silent) showMiniNotice(`${s.cfg.title} 同步失敗：${err.message}`, "warn");
      return false;
    }
  }

  function parseHistoryText(id, text){
    const maxNum = state.lotteries[id].cfg.maxNum;
    const counts = {};
    for(let i=1;i<=maxNum;i++){
      counts[String(i).padStart(2,"0")] = 0;
    }

    const lines = String(text || "").split(/\r?\n/).map(s=>s.trim()).filter(Boolean);
    let drawCount = 0;
    const draws = [];

    lines.forEach(line=>{
      const m = line.match(/開獎號碼\s+((?:\d{2}\s+){4}\d{2})$/);
      if(!m) return;

      const nums = m[1]
        .trim()
        .split(/\s+/)
        .map(n => String(parseInt(n,10)).padStart(2,"0"))
        .filter(Boolean);

      if(nums.length !== 5) return;

      drawCount++;
      draws.push(nums);
      nums.forEach(n => counts[n]++);
    });

    return { counts, drawCount, draws };
  }

  function analyzeHistoryText(id, text){
    const { counts, drawCount, draws } = parseHistoryText(id, text);
    const arr = Object.entries(counts).map(([num,count])=>({ num, count }));

    const hotRank = [...arr].sort((a,b)=>{
      if(b.count !== a.count) return b.count - a.count;
      return parseInt(a.num,10) - parseInt(b.num,10);
    });

    const coldRank = [...arr].sort((a,b)=>{
      if(a.count !== b.count) return a.count - b.count;
      return parseInt(a.num,10) - parseInt(b.num,10);
    });

    const recent50 = draws.slice(0, 50);
    const recent100 = draws.slice(0, 100);
    const counts50 = {};
    const counts100 = {};
    const pairCounts50 = {};
    const tripleCounts50 = {};
    const pairCounts100 = {};

    const maxNum = state.lotteries[id].cfg.maxNum;
    for(let i=1;i<=maxNum;i++){
      const n = String(i).padStart(2, '0');
      counts50[n] = 0;
      counts100[n] = 0;
    }

    recent50.forEach(draw=>{
      draw.forEach(n=> counts50[n] = (counts50[n] || 0) + 1);
      getCombinations(draw, 2).forEach(pair=>{
        const key = comboKey(pair);
        pairCounts50[key] = (pairCounts50[key] || 0) + 1;
      });
      getCombinations(draw, 3).forEach(triple=>{
        const key = comboKey(triple);
        tripleCounts50[key] = (tripleCounts50[key] || 0) + 1;
      });
    });

    recent100.forEach(draw=>{
      draw.forEach(n=> counts100[n] = (counts100[n] || 0) + 1);
      getCombinations(draw, 2).forEach(pair=>{
        const key = comboKey(pair);
        pairCounts100[key] = (pairCounts100[key] || 0) + 1;
      });
    });

    const hot = hotRank.slice(0, 10).map(x=>x.num);
    const cold = coldRank.slice(0, 10).map(x=>x.num);
    const mid = arr.map(x=>x.num).filter(n=>!hot.includes(n) && !cold.includes(n));

    const highRiskPairs = new Set(
      Object.entries(pairCounts50)
        .filter(([,count]) => count >= 2)
        .sort((a,b)=>b[1]-a[1] || a[0].localeCompare(b[0]))
        .slice(0, 24)
        .map(([key])=>key)
    );

    const highRiskTriples = new Set(
      Object.entries(tripleCounts50)
        .filter(([,count]) => count >= 1)
        .sort((a,b)=>b[1]-a[1] || a[0].localeCompare(b[0]))
        .slice(0, 12)
        .map(([key])=>key)
    );

    const riskyNumberSet = new Set();
    [...highRiskPairs].forEach(key=> key.split('-').forEach(n=> riskyNumberSet.add(n)));
    [...highRiskTriples].forEach(key=> key.split('-').forEach(n=> riskyNumberSet.add(n)));

    const topPairs = Object.entries(pairCounts50)
      .sort((a,b)=>b[1]-a[1] || a[0].localeCompare(b[0]))
      .slice(0, 8);

    const topTriples = Object.entries(tripleCounts50)
      .sort((a,b)=>b[1]-a[1] || a[0].localeCompare(b[0]))
      .slice(0, 8);

    return {
      counts,
      drawCount,
      draws,
      hot,
      cold,
      mid,
      hotRank,
      coldRank,
      counts50,
      counts100,
      pairCounts: pairCounts50,
      tripleCounts: tripleCounts50,
      pairCounts50,
      tripleCounts50,
      pairCounts100,
      highRiskPairs,
      highRiskTriples,
      riskyNumberSet,
      topPairs,
      topTriples
    };
  }

  function renderHistoryAnalysis(id, analysis){
    const el = getEls(id);
    el.hotNumbers.innerHTML = "";
    el.coldNumbers.innerHTML = "";
    el.riskPairs.innerHTML = "";
    el.riskTriples.innerHTML = "";

    analysis.hot.forEach(num=>{
      const chip = document.createElement("div");
      chip.className = "chip hot";
      chip.textContent = `${num}（${analysis.counts[num]}次）`;
      el.hotNumbers.appendChild(chip);
    });

    analysis.cold.forEach(num=>{
      const chip = document.createElement("div");
      chip.className = "chip cold";
      chip.textContent = `${num}（${analysis.counts[num]}次）`;
      el.coldNumbers.appendChild(chip);
    });

    if(analysis.topPairs.length === 0){
      const chip = document.createElement("div");
      chip.className = "chip warn";
      chip.textContent = "尚無高風險雙號";
      el.riskPairs.appendChild(chip);
    }else{
      analysis.topPairs.forEach(([key,count])=>{
        const chip = document.createElement("div");
        chip.className = "chip warn";
        chip.textContent = `${key.replaceAll("-", "・")}（${count}次）`;
        el.riskPairs.appendChild(chip);
      });
    }

    if(analysis.topTriples.length === 0){
      const chip = document.createElement("div");
      chip.className = "chip warn";
      chip.textContent = "尚無高風險三號";
      el.riskTriples.appendChild(chip);
    }else{
      analysis.topTriples.forEach(([key,count])=>{
        const chip = document.createElement("div");
        chip.className = "chip warn";
        chip.textContent = `${key.replaceAll("-", "・")}（${count}次）`;
        el.riskTriples.appendChild(chip);
      });
    }
  }

  function shuffle(arr){
    const copy = [...arr];
    for(let i=copy.length-1;i>0;i--){
      const j = Math.floor(Math.random()*(i+1));
      [copy[i], copy[j]] = [copy[j], copy[i]];
    }
    return copy;
  }

  function scoreSingleGroup(nums, analysis){
    let score = 0;

    nums.forEach(n=>{
      score += (analysis.counts[n] || 0) * 12;
    });

    getCombinations(nums, 2).forEach(pair=>{
      const key = comboKey(pair);
      score += (analysis.pairCounts[key] || 0) * 900;
    });

    getCombinations(nums, 3).forEach(triple=>{
      const key = comboKey(triple);
      score += (analysis.tripleCounts[key] || 0) * 4000;
    });

    analysis.draws.forEach(draw=>{
      const hit = intersectionCount(nums, draw);
      if(hit === 2) score += 80000;
      if(hit === 3) score += 200000;
      if(hit === 1) score -= 200;
      if(hit === 0) score += 30;
    });

    return score;
  }

  function buildGroupStructure(group){
    const nums = [...group].map(n => parseInt(n, 10)).sort((a,b)=>a-b);
    const odd = nums.filter(n => n % 2 === 1).length;
    const even = nums.length - odd;
    const adjacent = nums.slice(1).reduce((acc, n, idx)=> acc + (n - nums[idx] === 1 ? 1 : 0), 0);
    const tens = {};
    nums.forEach(n=>{
      const bucket = Math.floor(n / 10);
      tens[bucket] = (tens[bucket] || 0) + 1;
    });
    const maxTens = Math.max(...Object.values(tens), 0);
    const span = nums[nums.length - 1] - nums[0];
    const oddEvenGap = Math.abs(odd - even);
    return { odd, even, adjacent, oddEvenGap, maxTens, span };
  }

  function classifyHeat(num, analysis){
    if((analysis.hot || []).includes(num)) return 'hot';
    if((analysis.cold || []).includes(num)) return 'cold';
    return 'mid';
  }

  function countHeat(group, analysis, kind){
    return group.filter(n => classifyHeat(n, analysis) === kind).length;
  }

  function getGroupRiskSummary(group, analysis){
    const structure = buildGroupStructure(group);
    let riskyPairs = 0;
    let riskyTriples = 0;
    getCombinations(group, 2).forEach(pair=>{ if((analysis.highRiskPairs || new Set()).has(comboKey(pair))) riskyPairs += 1; });
    getCombinations(group, 3).forEach(triple=>{ if((analysis.highRiskTriples || new Set()).has(comboKey(triple))) riskyTriples += 1; });
    const hotCount = countHeat(group, analysis, 'hot');
    const riskyNums = group.filter(n => (analysis.riskyNumberSet || new Set()).has(n)).length;
    let score = riskyPairs * 120 + riskyTriples * 220 + Math.max(0, hotCount - 2) * 25 + Math.max(0, riskyNums - 2) * 18;
    score += Math.max(0, structure.adjacent - 2) * 12;
    score += Math.max(0, structure.maxTens - 3) * 10;
    score += Math.max(0, structure.oddEvenGap - 3) * 8;
    return { structure, riskyPairs, riskyTriples, hotCount, riskyNums, score };
  }

  function chooseAdaptiveTries(){
    return 100;
  }

  function getStageLabel(n){
    if(n < 30) return '建立第一階段候選';
    if(n < 60) return '建立第二階段候選';
    return '建立第三階段候選';
  }

  function pickBestNumberForGroup(candidates, group, analysis){
    let best = null;
    for(const num of shuffle(candidates).slice(0, Math.min(candidates.length, 12))){
      const test = [...group, num].sort((a,b)=>parseInt(a,10)-parseInt(b,10));
      const r = getGroupRiskSummary(test, analysis);
      let cost = r.score;
      const heat = classifyHeat(num, analysis);
      if(heat === 'hot' && r.hotCount > 2) cost += 40;
      if(heat === 'cold' && countHeat(test, analysis, 'cold') > 2) cost += 10;
      if((analysis.riskyNumberSet || new Set()).has(num) && group.length < 4) cost += 10;
      if(!best || cost < best.cost) best = { num, cost };
    }
    return best?.num || shuffle(candidates)[0];
  }

  function buildCandidateGroups(allNums, analysis){
    const available = new Set(allNums);
    const groups = [[], [], [], []];
    const hot = shuffle((analysis.hot || []).filter(n => available.has(n)));
    const mid = shuffle((analysis.mid || []).filter(n => available.has(n)));
    const cold = shuffle((analysis.cold || []).filter(n => available.has(n)));
    const queue = [
      ...hot,
      ...mid,
      ...cold,
      ...shuffle(allNums.filter(n => !hot.includes(n) && !mid.includes(n) && !cold.includes(n)))
    ];

    const consume = (num, gi) => {
      if(!num || !available.has(num) || groups[gi].length >= 5) return false;
      groups[gi].push(num);
      groups[gi].sort((a,b)=>parseInt(a,10)-parseInt(b,10));
      available.delete(num);
      return true;
    };

    // 每組先盡量放 1 顆熱號
    for(let gi=0; gi<4; gi++){
      const pick = pickBestNumberForGroup(hot.filter(n=>available.has(n)), groups[gi], analysis);
      if(pick) consume(pick, gi);
    }

    // 再依序補滿，每次都挑對該組風險最低的號碼
    for(let round=0; round<5; round++){
      for(let gi=0; gi<4; gi++){
        if(groups[gi].length >= 5) continue;
        const pool = queue.filter(n => available.has(n));
        const pick = pickBestNumberForGroup(pool, groups[gi], analysis);
        consume(pick, gi);
      }
    }

    const car = [...available].sort((a,b)=>parseInt(a,10)-parseInt(b,10));
    return { groups, car };
  }

  function evaluatePartition(groups, analysis){
    const summaries = groups.map(g => getGroupRiskSummary(g, analysis));
    const riskyPairs = summaries.reduce((a, s)=> a + s.riskyPairs, 0);
    const riskyTriples = summaries.reduce((a, s)=> a + s.riskyTriples, 0);
    const hotOverload = summaries.reduce((a, s)=> a + Math.max(0, s.hotCount - 2), 0);
    const score = riskyPairs * 120 + riskyTriples * 220 + hotOverload * 35 + summaries.reduce((a,s)=>a+s.score,0);
    return {
      score,
      lowRiskGroups: summaries.filter(s => s.riskyPairs === 0 && s.riskyTriples === 0 && s.hotCount <= 2).length,
      summaries,
      riskyPairs,
      riskyTriples
    };
  }

  async function buildSmartGroups(id, analysis, onProgress){
    const maxNum = state.lotteries[id].cfg.maxNum;
    const allNums = Array.from({ length: maxNum }, (_, i) => String(i + 1).padStart(2, "0"));

    const groupNames = [
      $(`${id}_prize1Desc`).value.trim() || "第一組",
      $(`${id}_prize2Desc`).value.trim() || "第二組",
      $(`${id}_prize3Desc`).value.trim() || "第三組",
      $(`${id}_prize4Desc`).value.trim() || "第四組",
      $(`${id}_prize5Desc`).value.trim() || "全車號碼"
    ];

    const target = chooseAdaptiveTries();
    const startedAt = Date.now();
    let bestResult = null;

    for(let t=1; t<=target; t++){
      const built = buildCandidateGroups(allNums, analysis);
      const evalResult = evaluatePartition(built.groups, analysis);
      const elapsedMs = Date.now() - startedAt;
      if (typeof onProgress === 'function') {
        onProgress({
          searched: t,
          target,
          elapsedMs,
          lowRiskFound: bestResult ? 1 : 0,
          stageLabel: getStageLabel(t),
          statusText: bestResult ? '已找到候選' : '搜尋中',
          footerText: '以近50期高風險雙號 / 三連號、熱中冷分配為主，盡量避開同組碰撞；全車可承接熱號與高風險號。'
        });
      }

      const groups = {
        [groupNames[0]]: built.groups[0],
        [groupNames[1]]: built.groups[1],
        [groupNames[2]]: built.groups[2],
        [groupNames[3]]: built.groups[3],
        [groupNames[4]]: built.car
      };

      const candidate = {
        score: evalResult.score,
        lowRiskGroups: evalResult.lowRiskGroups,
        analyzedDrawCount: analysis.drawCount || 0,
        generatedTryCount: t,
        searchedCandidates: t,
        selectedPool: 'balanced',
        downgraded: false,
        elapsedMs,
        groups,
        riskyPairs: evalResult.riskyPairs,
        riskyTriples: evalResult.riskyTriples
      };

      if(!bestResult || candidate.score < bestResult.score){
        bestResult = candidate;
      }

      if(evalResult.riskyTriples === 0 && evalResult.riskyPairs <= 1 && evalResult.lowRiskGroups >= 3){
        return candidate;
      }

      if(t % 10 === 0) await sleep(0);
    }

    return bestResult || {
      noQualifiedResult: true,
      analyzedDrawCount: analysis.drawCount || 0,
      generatedTryCount: target,
      searchedCandidates: target,
      lowRiskGroups: 0,
      selectedPool: 'none',
      elapsedMs: Date.now() - startedAt
    };
  }

  function formatEta(ms){
    if (!Number.isFinite(ms) || ms <= 0) return '估算中';
    if (ms < 1000) return `${Math.max(1, Math.round(ms))} ms`;
    return `${(ms / 1000).toFixed(1)} 秒`;
  }

  function renderSearchProgress(id, progress){
    const box = getEls(id).groupPreview;
    const searched = progress?.searched || 0;
    const target = progress?.target || 0;
    const elapsedMs = progress?.elapsedMs || 0;
    const percent = target > 0 ? Math.min(100, (searched / target) * 100) : 0;
    const rate = elapsedMs > 0 ? searched / (elapsedMs / 1000) : 0;
    const remaining = target > searched ? target - searched : 0;
    const etaMs = rate > 0 ? (remaining / rate) * 1000 : NaN;
    box.innerHTML = `
      <div class="groupRow"><b>搜尋中</b><span style="color:#ffe7a8;">系統正在自動搜尋合格低風險方案，找到第一組合格候選就會立即停止並開放通報。</span></div>
      <div class="groupRow"><b>已分析</b><span style="color:#ffe7a8;">${searched.toLocaleString()} / ${target.toLocaleString()} 候選（${percent.toFixed(1)}%）</span></div>
      <div class="groupRow"><b>目前檢查</b><span style="color:#ffe7a8;">連號、十位區、尾數、奇偶、跨度</span></div>
      <div class="groupRow"><b>已耗時</b><span style="color:#ffe7a8;">${(elapsedMs / 1000).toFixed(1)} 秒</span></div>
      <div class="groupRow"><b>預估剩餘</b><span style="color:#ffe7a8;">${formatEta(etaMs)}</span></div>
      <div style="margin-top:10px;border:1px solid rgba(255,255,255,.12);border-radius:999px;overflow:hidden;height:12px;background:rgba(255,255,255,.08);"><div style="width:${percent}%;height:100%;background:linear-gradient(90deg,#e0a83d,#f4d27a);"></div></div>
    `;
    updateSearchOverlay(id, { ...progress, stageLabel: progress?.stageLabel || "搜尋候選中", statusText: progress?.statusText || "搜尋中", footerText: progress?.footerText || "只要找到第一組合格低風險方案，就會立即停止並開始鎖定各組號碼。" });
  }

  function renderGroupPreview(id, bestResult){
    const box = getEls(id).groupPreview;
    box.innerHTML = "";

    const order = [
      $(`${id}_prize1Desc`).value.trim() || "第一組",
      $(`${id}_prize2Desc`).value.trim() || "第二組",
      $(`${id}_prize3Desc`).value.trim() || "第三組",
      $(`${id}_prize4Desc`).value.trim() || "第四組",
      $(`${id}_prize5Desc`).value.trim() || "全車號碼"
    ];

    order.forEach((name, idx)=>{
      const nums = bestResult.groups[name] || [];
      const row = document.createElement("div");
      row.className = "groupRow";
      row.innerHTML = `
        <b>${escapeHtml(name)}</b> ${escapeHtml(nums.join("、"))}
        ${idx < 4 ? `<div class="riskText">目標：盡可能避免 2 顆 / 3 顆碰撞</div>` : `<div class="riskText">剩餘號碼全部放入</div>`}
      `;
      box.appendChild(row);
    });

    const row = document.createElement("div");
    row.className = "groupRow";
    row.innerHTML = `<b>風險摘要</b><span style="color:#ffe7a8;">歷史 2 碰撞次數：${bestResult.twoHitRisk} ｜ 歷史 3 碰撞次數：${bestResult.threeHitRisk} ｜ 低風險組數：${bestResult.lowRiskGroups || 0}/4 ｜ 分析期數：${bestResult.analyzedDrawCount || 0} ｜ 搜索候選：${bestResult.searchedCandidates || bestResult.generatedTryCount || 0} ｜ 採用池：${bestResult.selectedPool === 'low' ? '低風險' : '未找到'}${bestResult.downgraded ? '（已降級）' : ''}</span>`;
    box.appendChild(row);
  }

  function applyGeneratedGroupsToLog(id, groups){
    const s = state.lotteries[id];
    s.log = [];
    s.lastAction = null;

    const order = [
      $(`${id}_prize1Desc`).value.trim() || "第一組",
      $(`${id}_prize2Desc`).value.trim() || "第二組",
      $(`${id}_prize3Desc`).value.trim() || "第三組",
      $(`${id}_prize4Desc`).value.trim() || "第四組",
      $(`${id}_prize5Desc`).value.trim() || "全車號碼"
    ];

    const prizeLabelMap = {
      [order[0]]: $(`${id}_prize1Label`).value.trim() || state.lotteries[id].cfg.prizeLabel,
      [order[1]]: $(`${id}_prize2Label`).value.trim() || state.lotteries[id].cfg.prizeLabel,
      [order[2]]: $(`${id}_prize3Label`).value.trim() || state.lotteries[id].cfg.prizeLabel,
      [order[3]]: $(`${id}_prize4Label`).value.trim() || state.lotteries[id].cfg.prizeLabel,
      [order[4]]: $(`${id}_prize5Label`).value.trim() || state.lotteries[id].cfg.prizeLabel
    };

    const dt = nowFull();
    order.forEach(groupName=>{
      (groups[groupName] || []).forEach(num=>{
        s.log.push({
          dt,
          prize: prizeLabelMap[groupName],
          prizeDesc: groupName,
          who: String(num).padStart(2, "0")
        });
      });
    });

    renderLog(id);
    updateStats(id);

    const finalGroup = order[order.length - 1];
    const finalNum = (groups[finalGroup] || []).slice(-1)[0] || "—";
    setWinner(id, finalNum, `${finalGroup}｜智能分組完成`);
    getEls(id).currentMeta.textContent = "已完成防 2 / 3 碰撞分組";
    flashOnce(id);
    playDing();
    persistAll();
    maybeAutoDownloadXlsx(id);
  }

  function analyzeHistoryAndRender(id){
    const text = getEls(id).historyInput.value.trim();
    if(!text){
      showMiniNotice(`${state.lotteries[id].cfg.title}：請先貼上歷史開獎資料`, "warn");
      return null;
    }
    const analysis = analyzeHistoryText(id, text);
    state.lotteries[id].historyAnalysis = analysis;
    renderHistoryAnalysis(id, analysis);
    persistAll();
    showMiniNotice(`${state.lotteries[id].cfg.title}：已分析 ${analysis.drawCount} 期資料`, "ok");
    return analysis;
  }

  function apply01to39List(id){
    const s = state.lotteries[id];
    const demo = s.cfg.defaultList.slice();
    getEls(id).listInput.value = demo.join("\n");
    s.allList = demo.slice();
    s.pool = demo.slice();
    updateStats(id);
    persistAll();
  }

  function loadList(id){
    const s = state.lotteries[id];
    const el = getEls(id);
    const raw = el.listInput.value.split(/\r?\n/);
    const mode = el.cleanupMode.value;
    const items = cleanupInput(raw, mode);

    const seen = new Set();
    const uniq = [];
    for (const x of items){
      if (!seen.has(x)){
        seen.add(x);
        uniq.push(x);
      }
    }
    s.allList = uniq.slice();
    s.pool = uniq.slice();
    setWinner(id, null, "");
    updateStats(id);
    renderLog(id);
    persistAll();
    showMiniNotice(`${s.cfg.title}：已載入名單 ${s.allList.length} 筆`, "ok");
  }

  function shufflePool(id){
    const s = state.lotteries[id];
    for(let i=s.pool.length-1;i>0;i--){
      const j = Math.floor(Math.random()*(i+1));
      [s.pool[i], s.pool[j]] = [s.pool[j], s.pool[i]];
    }
    updateStats(id);
    persistAll();
    showMiniNotice(`${s.cfg.title}：名單已洗牌`, "info");
  }

  async function clearAll(id){
    const s = state.lotteries[id];
    s.allList = [];
    s.pool = [];
    s.log = [];
    s.lastAction = null;
    s.generatedGroups = null;
    s.historyAnalysis = null;
    s.lastSyncHash = "";
    s.restoredHistoryText = "";

    const els = getEls(id);
    els.listInput.value = "";
    els.historyInput.value = "";
    setWinner(id, null, "");
    renderLog(id);
    updateStats(id);
    els.groupPreview.innerHTML = `<div class="small">尚未生成分組</div>`;
    els.hotNumbers.innerHTML = "";
    els.coldNumbers.innerHTML = "";
    els.riskPairs.innerHTML = "";
    els.riskTriples.innerHTML = "";
    setSyncState(id, "尚未同步", "normal");
    els.syncNote.textContent = `資料來源：${Array.isArray(s.cfg.syncUrl) ? s.cfg.syncUrl[0] : s.cfg.syncUrl}`;
    persistAll();
    showMiniNotice(`${s.cfg.title}：已清空全部資料`, "warn");
  }

  function clearLog(id){
    const s = state.lotteries[id];
    s.log = [];
    s.lastAction = null;
    setWinner(id, null, "");
    renderLog(id);
    updateStats(id);
    persistAll();
    showMiniNotice(`${s.cfg.title}：已清空中獎紀錄`, "warn");
  }

  function undo(id){
    const s = state.lotteries[id];
    if(!s.lastAction){
      showMiniNotice(`${s.cfg.title}：沒有可撤銷的動作`, "warn");
      return;
    }

    if (s.lastAction.multi){
      const count = s.lastAction.count || 0;
      for(let i = 0; i < count; i++) s.log.pop();

      if (s.lastAction.removedFromPool){
        [...s.lastAction.removedItems].reverse().forEach(item => {
          const idx = Math.min(Math.max(item.index, 0), s.pool.length);
          s.pool.splice(idx, 0, item.value);
        });
      }
    }else{
      s.log.pop();
      if (s.lastAction.removedFromPool){
        const idx = Math.min(Math.max(s.lastAction.removedIndex, 0), s.pool.length);
        s.pool.splice(idx, 0, s.lastAction.removedValue);
      }
    }

    s.lastAction = null;
    setWinner(id, null, "");
    renderLog(id);
    updateStats(id);
    persistAll();
    showMiniNotice(`${s.cfg.title}：已撤銷上一筆`, "info");
  }

  function buildHorizontalPrizeRows(log){
    if (!Array.isArray(log) || log.length === 0) return [];

    const order = ["第一組", "第二組", "第三組", "第四組", "全車號碼"];
    const grouped = new Map();

    log.forEach(item => {
      const key = item.prizeDesc || "未分類";
      if (!grouped.has(key)) grouped.set(key, []);
      grouped.get(key).push(String(item.who || "").padStart(2, "0"));
    });

    const rows = [];
    order.forEach(name => {
      if (grouped.has(name)) {
        rows.push([name, ...grouped.get(name)]);
        grouped.delete(name);
      }
    });

    for (const [name, nums] of grouped.entries()) {
      rows.push([name, ...nums]);
    }

    return rows;
  }

  function exportCsv(id){
    const s = state.lotteries[id];
    if (s.log.length === 0){
      showMiniNotice(`${s.cfg.title}：沒有紀錄可匯出`, "warn");
      return;
    }

    const rows = buildHorizontalPrizeRows(s.log);

    const escCsv = (v) => {
      const sv = String(v ?? "");
      if (/[",\n\r]/.test(sv)) return '"' + sv.replaceAll('"','""') + '"';
      return sv;
    };

    const csv = rows.map(r => r.map(escCsv).join(",")).join("\r\n");
    const bom = "﻿";
    const blob = new Blob([bom + csv], {type:"text/csv;charset=utf-8"});
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `${state.lotteries[id].cfg.title}_horizontal_${Date.now()}.csv`;
    a.click();
    URL.revokeObjectURL(a.href);
    showMiniNotice(`${s.cfg.title}：CSV 已匯出（橫向）`, "ok");
  }

  function exportXlsx(id, fileName = "logs.xlsx"){
    const s = state.lotteries[id];
    if (typeof XLSX === "undefined"){
      showMiniNotice(`${s.cfg.title}：XLSX 函式庫尚未載入`, "warn");
      return;
    }
    if (s.log.length === 0){
      showMiniNotice(`${s.cfg.title}：目前沒有本機紀錄可匯出`, "warn");
      return;
    }

    const wsData = buildHorizontalPrizeRows(s.log);
    const wb = XLSX.utils.book_new();
    const ws = XLSX.utils.aoa_to_sheet(wsData);

    const maxCols = Math.max(...wsData.map(r => r.length), 1);
    ws["!cols"] = Array.from({ length: maxCols }, (_, i) => ({
      wch: i === 0 ? 12 : 6
    }));

    XLSX.utils.book_append_sheet(wb, ws, s.cfg.title + "_groups");
    XLSX.writeFile(wb, fileName);
    showMiniNotice(`${s.cfg.title}：${fileName} 已匯出（橫向）`, "ok");
  }

  function maybeAutoDownloadXlsx(id){
    const els = getEls(id);
    if (els.autoDownloadXlsx?.checked){
      const prefix = state.lotteries[id].cfg.title;
      exportXlsx(id, `${prefix}_logs.xlsx`);
    }
  }

  async function copyWinner(id){
    const who = getEls(id).currentWinner.textContent;
    if (!who || who === "—"){
      showMiniNotice(`${state.lotteries[id].cfg.title}：目前沒有中獎者`, "warn");
      return;
    }
    try{
      await navigator.clipboard.writeText(who);
      showMiniNotice(`${state.lotteries[id].cfg.title}：已複製 ${who}`, "ok");
    }catch(e){
      showMiniNotice(`${state.lotteries[id].cfg.title}：複製失敗`, "warn");
    }
  }

  async function drawOne(id, prizeLabel="隨機", prizeDesc="", showSummaryAfter=false){
    const s = state.lotteries[id];
    const el = getEls(id);
    if (s.pool.length === 0){
      showMiniNotice(`${s.cfg.title}：目前沒有可抽名單`, "warn");
      return null;
    }
    if (s.rolling) return null;
    s.rolling = true;

    const drawModeSel = el.drawMode.value || "remove";

    try{
      el.currentWinner.classList.add("rolling");

      const rollMs = 90;
      const tickEvery = 16;
      const start = performance.now();

      while (performance.now() - start < rollMs){
        const tmp = s.pool[Math.floor(Math.random() * s.pool.length)];
        setWinner(id, tmp, prizeDesc ? `${prizeLabel}（${prizeDesc}）` : prizeLabel);
        playTick();
        await sleep(tickEvery);
      }

      const idx = Math.floor(Math.random() * s.pool.length);
      const realWinner = s.pool[idx];

      let removedFromPool = false;
      if (drawModeSel === "remove"){
        s.pool.splice(idx, 1);
        removedFromPool = true;
      }

      const logItem = {
        dt: nowFull(),
        prize: prizeLabel,
        prizeDesc: prizeDesc || "",
        who: String(realWinner).padStart(2, "0")
      };
      s.log.push(logItem);

      s.lastAction = { multi: false, removedFromPool, removedValue: realWinner, removedIndex: idx };

      setWinner(id, String(realWinner).padStart(2, "0"), prizeDesc ? `${prizeLabel}（${prizeDesc}）` : prizeLabel);
      renderLog(id);
      updateStats(id);
      playDing();
      flashOnce(id);

      el.currentWinner.classList.remove("rolling");
      s.rolling = false;

      persistAll();
      maybeAutoDownloadXlsx(id);

      if (showSummaryAfter){
        await sleep(60);
        showSummary(prizeLabel, prizeDesc, [String(realWinner).padStart(2, "0")]);
      }
      return String(realWinner).padStart(2, "0");
    }catch(e){
      try{ el.currentWinner.classList.remove("rolling"); }catch(_){}
      s.rolling = false;
      showMiniNotice(`${s.cfg.title}：抽獎發生錯誤`, "warn");
      return null;
    }
  }

  async function drawMany(id, n=5, prizeLabel="連抽", prizeDesc="", showSummaryAfter=false){
    const s = state.lotteries[id];
    const el = getEls(id);
    if (s.pool.length === 0){
      showMiniNotice(`${s.cfg.title}：目前沒有可抽名單`, "warn");
      return [];
    }
    if (s.rolling) return [];
    s.rolling = true;

    const drawModeSel = el.drawMode.value || "remove";

    try{
      el.currentWinner.classList.add("rolling");

      const rollMs = 120;
      const tickEvery = 14;
      const start = performance.now();

      while (performance.now() - start < rollMs){
        const tmp = s.pool[Math.floor(Math.random() * s.pool.length)];
        setWinner(id, tmp, prizeDesc ? `${prizeLabel}（${prizeDesc}）` : prizeLabel);
        playTick();
        await sleep(tickEvery);
      }

      const takeCount = Math.min(n, s.pool.length);
      const winners = [];
      const removedItems = [];

      if (drawModeSel === "remove"){
        for(let i = 0; i < takeCount; i++){
          const idx = Math.floor(Math.random() * s.pool.length);
          const realWinner = s.pool[idx];
          const padWinner = String(realWinner).padStart(2, "0");
          winners.push(padWinner);
          removedItems.push({ value: realWinner, index: idx });
          s.pool.splice(idx, 1);
        }
      }else{
        for(let i = 0; i < takeCount; i++){
          const idx = Math.floor(Math.random() * s.pool.length);
          winners.push(String(s.pool[idx]).padStart(2, "0"));
        }
      }

      const drawTime = nowFull();
      winners.forEach((winner) => {
        s.log.push({
          dt: drawTime,
          prize: prizeLabel,
          prizeDesc: prizeDesc || "",
          who: winner
        });
      });

      s.lastAction = {
        multi: true,
        removedFromPool: drawModeSel === "remove",
        removedItems,
        count: winners.length
      };

      const finalWinner = winners[winners.length - 1] || "—";
      setWinner(id, finalWinner, prizeDesc ? `${prizeLabel}（${prizeDesc}）` : prizeLabel);

      renderLog(id);
      updateStats(id);
      playDing();
      flashOnce(id);

      el.currentWinner.classList.remove("rolling");
      s.rolling = false;

      persistAll();
      maybeAutoDownloadXlsx(id);

      if (showSummaryAfter && winners.length){
        await sleep(60);
        showSummary(prizeLabel, prizeDesc, winners);
      }

      return winners;
    }catch(e){
      try{ el.currentWinner.classList.remove("rolling"); }catch(_){}
      s.rolling = false;
      showMiniNotice(`${s.cfg.title}：抽獎發生錯誤`, "warn");
      return [];
    }
  }

  function showMiniNotice(msg, type = "info"){
    const wrap = $("toastWrap");
    const item = document.createElement("div");
    item.className = `toast ${type}`;
    item.textContent = msg;
    wrap.appendChild(item);

    setTimeout(() => {
      item.style.animation = "toastOut .22s ease forwards";
      setTimeout(() => item.remove(), 220);
    }, 2200);
  }

  function syncPrizeButtons(id){
    [1,2,3,4,5].forEach(i=>{
      const countEl = $(`${id}_prize${i}Count`);
      const btnEl = $(`${id}_btnPrize${i}`);
      const n = Math.max(1, parseInt(countEl.value || "1", 10));
      btnEl.textContent = `抽 ${n} 顆球`;
    });
  }

  function serializeState(){
    const payload = {
      settings: state.settings,
      lotteries: {}
    };

    Object.keys(state.lotteries).forEach(id=>{
      const s = state.lotteries[id];
      const els = getEls(id);
      payload.lotteries[id] = {
        allList: s.allList,
        pool: s.pool,
        log: s.log,
        lastSyncHash: s.lastSyncHash,
        autoRefreshEnabled: s.autoRefreshEnabled,
        historyText: looksLikeValidHistoryText(els.historyInput.value) ? els.historyInput.value : "",
        listText: els.listInput.value,
        cleanupMode: els.cleanupMode.value,
        drawMode: els.drawMode.value,
        autoDownloadXlsx: els.autoDownloadXlsx.checked,
        prizes: [1,2,3,4,5].map(i => ({
          label: $(`${id}_prize${i}Label`).value,
          desc: $(`${id}_prize${i}Desc`).value,
          count: $(`${id}_prize${i}Count`).value
        }))
      };
    });

    return payload;
  }

  function persistAll(){
    if(!state.settings.autoSave) return;
    try{
      localStorage.setItem(CONFIG.storageKey, JSON.stringify(serializeState()));
    }catch(e){}
  }

  function restoreState(){
    try{
      const raw = localStorage.getItem(CONFIG.storageKey);
      if(!raw) return false;
      const data = JSON.parse(raw);

      if(data?.settings){
        state.settings = {
          ...state.settings,
          ...data.settings
        };
      }

      Object.keys(data?.lotteries || {}).forEach(id=>{
        const saved = data.lotteries[id];
        const s = state.lotteries[id];
        if(!s) return;
        const els = getEls(id);

        s.allList = Array.isArray(saved.allList) ? saved.allList : [];
        s.pool = Array.isArray(saved.pool) ? saved.pool : [];
        s.log = Array.isArray(saved.log) ? saved.log : [];
        s.lastSyncHash = saved.lastSyncHash || "";
        s.autoRefreshEnabled = saved.autoRefreshEnabled !== false;
        s.restoredHistoryText = saved.historyText || "";

        els.listInput.value = saved.listText || "";
        els.historyInput.value = saved.historyText || "";
        els.cleanupMode.value = saved.cleanupMode || "trim";
        els.drawMode.value = saved.drawMode || "remove";
        els.autoDownloadXlsx.checked = !!saved.autoDownloadXlsx;

        if(Array.isArray(saved.prizes)){
          saved.prizes.forEach((p, idx)=>{
            const i = idx + 1;
            if($(`${id}_prize${i}Label`)) $(`${id}_prize${i}Label`).value = p.label ?? "";
            if($(`${id}_prize${i}Desc`)) $(`${id}_prize${i}Desc`).value = p.desc ?? "";
            if($(`${id}_prize${i}Count`)) $(`${id}_prize${i}Count`).value = p.count ?? "1";
          });
        }

        if(saved.historyText){
          s.historyAnalysis = analyzeHistoryText(id, saved.historyText);
        }else{
          s.historyAnalysis = null;
        }
      });

      $("saveStateText").textContent = state.settings.autoSave ? "開啟" : "關閉";
      return true;
    }catch(e){
      return false;
    }
  }

  function renderRestoredState(id){
    const s = state.lotteries[id];
    updateStats(id);
    renderLog(id);
    setAutoState(id);
    syncPrizeButtons(id);
    refreshTrackingBoard(id);

    if(s.restoredHistoryText){
      getEls(id).historyInput.value = s.restoredHistoryText;
    }

    if(s.historyAnalysis){
      renderHistoryAnalysis(id, s.historyAnalysis);
      setSyncState(id, "已從本機恢復資料", "info");
      getEls(id).syncNote.textContent = `資料來源：${Array.isArray(s.cfg.syncUrl) ? s.cfg.syncUrl[0] : s.cfg.syncUrl} ｜ 已恢復本機保存資料`;
    }else{
      setSyncState(id, "尚未同步", "normal");
      getEls(id).syncNote.textContent = `資料來源：${Array.isArray(s.cfg.syncUrl) ? s.cfg.syncUrl[0] : s.cfg.syncUrl}`;
    }
  }


  function setConfirmAvailability(id, enabled, reason = ""){
    const btn = $(`${id}_btnConfirmTracking`);
    if(!btn) return;
    btn.disabled = !enabled;
    btn.title = enabled ? '' : reason;
    btn.style.opacity = enabled ? '1' : '0.55';
    btn.style.cursor = enabled ? 'pointer' : 'not-allowed';
  }

  async function confirmTracking(id){
    const s = state.lotteries[id];
    if(!s.generatedGroups || !s.generatedGroups.groups || s.generatedGroups.noQualifiedResult){
      showMiniNotice(`${s.cfg.title}：目前沒有合格低風險方案，請先執行自動生成搜尋`, "warn");
      return;
    }

    if(state.trackingSubmitLocks[id]){
      showMiniNotice(`${s.cfg.title}：通報處理中，請勿重複點擊`, "warn");
      return;
    }

    const btn = $(`${id}_btnConfirmTracking`);
    if(btn && btn.disabled){
      showMiniNotice(`${s.cfg.title}：通報處理中，請稍候`, "warn");
      return;
    }

    const oldText = btn ? btn.textContent : "";
    state.trackingSubmitLocks[id] = true;

    if(btn){
      btn.disabled = true;
      btn.textContent = "通報中...";
    }

    const order = [
      $(`${id}_prize1Desc`).value.trim() || "第一組",
      $(`${id}_prize2Desc`).value.trim() || "第二組",
      $(`${id}_prize3Desc`).value.trim() || "第三組",
      $(`${id}_prize4Desc`).value.trim() || "第四組",
      $(`${id}_prize5Desc`).value.trim() || "全車號碼"
    ];

    const groups = s.generatedGroups.groups || {};
    const payload = {
      lotteryType: id === "ttl" ? "ttl" : "539",
      lotteryTitle: s.cfg.title,
      confirmedAt: nowFull(),
      groups: {
        group1: cleanupNumbers(groups[order[0]] || [], s.cfg.maxNum),
        group2: cleanupNumbers(groups[order[1]] || [], s.cfg.maxNum),
        group3: cleanupNumbers(groups[order[2]] || [], s.cfg.maxNum),
        group4: cleanupNumbers(groups[order[3]] || [], s.cfg.maxNum),
        full: cleanupNumbers(groups[order[4]] || [], s.cfg.maxNum)
      },
      labels: {
        group1: order[0],
        group2: order[1],
        group3: order[2],
        group4: order[3],
        full: order[4]
      },
      analysis: s.generatedGroups.analysisMeta || null
    };

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 12000);

    try{
      const res = await fetch(`${API_BASE}/api/confirm-tracking`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
        signal: controller.signal
      });

      let result = null;
      try{
        result = await res.json();
      }catch(e){
        result = null;
      }

      if(!res.ok || !result?.ok){
        const msg = result?.message || `HTTP ${res.status}`;
        throw new Error(msg);
      }

      if(result?.busy){
        showMiniNotice(`${s.cfg.title}：${result.message || "通報處理中，請勿重複點擊"}`, "warn");
      }else{
        showMiniNotice(`${s.cfg.title}：${result.message || "通報已送出"}`, "ok");
        refreshTrackingBoard(id, { silent: true });
      }
    }catch(err){
      const msg = err?.name === "AbortError" ? "通報逾時，請稍後再試" : err.message;
      showMiniNotice(`${s.cfg.title}：通報失敗：${msg}`, "warn");
    }finally{
      clearTimeout(timer);
      state.trackingSubmitLocks[id] = false;
      if(btn){
        btn.disabled = false;
        btn.textContent = oldText || "確定通報";
      }
    }
  }


  function parseManualNumbers(text, maxNum){
    return String(text || "")
      .split(/[^\d]+/)
      .map(v => parseInt(v, 10))
      .filter(v => Number.isInteger(v) && v >= 1 && v <= maxNum)
      .map(v => String(v).padStart(2, "0"));
  }

  async function refreshTelegramStatus(id){
    const box = $(`${id}_telegramStatus`);
    if(!box) return;
    try{
      const data = await fetchJson(`${API_BASE}/api/telegram/config`);
      const tg = data.telegram || {};
      box.innerHTML = `TG 設定：BOT_TOKEN=${tg.hasBotToken ? '已讀到' : '未讀到'}（${escapeHtml(tg.tokenSource || 'unknown')}），TG_CHAT_ID=${tg.hasChatId ? '已讀到' : '未讀到'}（${escapeHtml(tg.chatIdSource || 'unknown')}）${tg.chatIdPreview ? `，Chat預覽=${escapeHtml(tg.chatIdPreview)}` : ''}`;
    }catch(err){
      box.innerHTML = `TG 設定檢查失敗：${escapeHtml(err.message || '未知錯誤')}`;
    }
  }


  async function saveTelegramConfig(id){
    const token = ($(`${id}_botTokenInput`)?.value || '').trim();
    const chatId = ($(`${id}_chatIdInput`)?.value || '').trim();
    const title = state.lotteries[id].cfg.title;
    try{
      const res = await fetch(`${API_BASE}/api/telegram/config`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ botToken: token, chatId })
      });
      const result = await res.json().catch(()=>null);
      if(!res.ok || !result?.ok) throw new Error(result?.message || `HTTP ${res.status}`);
      showMiniNotice(`${title}：Telegram 設定已儲存`, 'ok');
      await refreshTelegramStatus(id);
    }catch(err){
      showMiniNotice(`${title}：Telegram 設定儲存失敗：${err.message || '未知錯誤'}`, 'warn');
    }
  }

  async function testTelegram(id){
    const title = state.lotteries[id].cfg.title;
    try{
      const res = await fetch(`${API_BASE}/api/telegram/test`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: `【${title}】Telegram 測試成功` })
      });
      const result = await res.json().catch(()=>null);
      if(!res.ok || !result?.ok) throw new Error(result?.message || `HTTP ${res.status}`);
      showMiniNotice(`${title}：Telegram 測試成功`, 'ok');
    }catch(err){
      showMiniNotice(`${title}：Telegram 測試失敗：${err.message || '未知錯誤'}`, 'warn');
    }finally{
      await refreshTelegramStatus(id);
    }
  }

  async function cancelTrackingItem(id, trackingId){
    const title = state.lotteries[id].cfg.title;
    try{
      const res = await fetch(`${API_BASE}/api/tracking/cancel`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ lotteryType: id === 'ttl' ? 'ttl' : '539', trackingId, reason: 'manual-ui-cancel' })
      });
      const result = await res.json().catch(()=>null);
      if(!res.ok || !result?.ok) throw new Error(result?.message || `HTTP ${res.status}`);
      showMiniNotice(`${title}：${result.message || '已取消追蹤'}`, 'ok');
      await refreshTrackingBoard(id, { silent: true });
    }catch(err){
      showMiniNotice(`${title}：取消追蹤失敗：${err.message || '未知錯誤'}`, 'warn');
    }
  }

  async function refreshTrackingBoard(id, options = {}){
    const box = $(`${id}_trackingBoard`);
    if(!box) return;
    const { silent = false } = options || {};
    await refreshTelegramStatus(id);
    try{
      const type = id === "ttl" ? "ttl" : "539";
      const [data, recommendData] = await Promise.all([
        fetchJson(`${API_BASE}/api/tracking/${type}`),
        fetchJson(`${API_BASE}/api/recommend/${type}`).catch(()=>({ recommendations: [] }))
      ]);
      const active = Array.isArray(data.active) ? data.active : [];
      const recommendMap = new Map((recommendData.recommendations || []).map((row)=>[row.trackingId, row]));
      if(!active.length){
        box.innerHTML = '<span class="muted">目前沒有待開獎追蹤</span>';
        if(!silent){
          showMiniNotice(`${state.lotteries[id].cfg.title}：追蹤清單已刷新，目前沒有待開獎追蹤`, 'info');
        }
        return;
      }
      box.innerHTML = active.map((row)=>{
        const title = row.trackType === 'manual'
          ? `手動｜${escapeHtml(row.sourceName || '未命名通報')}`
          : '系統｜防2/3碰撞追蹤';
        const nums = [row.groups?.group1, row.groups?.group2, row.groups?.group3, row.groups?.group4]
          .filter(Boolean)
          .map((g,idx)=>`第${idx+1}組 ${g.join('、')}`)
          .concat([row.groups?.full?.length ? `全車 ${row.groups.full.join('、')}` : ''])
          .filter(Boolean)
          .join('<br>');
        const rec = recommendMap.get(row.id || '');
        const recHtml = rec ? `<div class="stats" style="margin-top:8px;">
          <div class="stat"><b>過關傾向</b><span>${escapeHtml(String(rec.passTendency ?? rec.predictedPassRate))}%</span></div>
          <div class="stat"><b>風險等級</b><span>${escapeHtml(rec.riskLevel || '-')}</span></div>
          <div class="stat"><b>分析可靠度</b><span>${escapeHtml(String(rec.reliability ?? rec.confidence ?? '-'))}</span></div>
        </div>
        <div class="small" style="margin-top:8px;">正向：${escapeHtml((rec.positives || []).join('、') || '—')}<br>風險：${escapeHtml((rec.negatives || []).join('、') || '—')}</div>` : '';
        return `<div class="groupRow"><b>${title}</b><div class="small">建立：${escapeHtml(row.confirmedAt || row.createdAt || '')}</div><div style="margin-top:6px;">${nums}</div>${recHtml}<div class="btns" style="margin-top:8px;"><button class="secondary btnCancelTracking" data-id="${escapeHtml(row.id || '')}">取消這筆追蹤</button></div></div>`;
      }).join('');
      Array.from(box.querySelectorAll('.btnCancelTracking')).forEach((btn)=>{
        btn.addEventListener('click', ()=>cancelTrackingItem(id, btn.dataset.id || ''));
      });
      if(!silent){
        showMiniNotice(`${state.lotteries[id].cfg.title}：追蹤清單已刷新，目前共有 ${active.length} 筆待開獎追蹤`, 'info');
      }
    }catch(err){
      box.innerHTML = `<span class="muted">追蹤清單載入失敗：${escapeHtml(err.message || '未知錯誤')}</span>`;
    }
  }

  async function submitManualTracking(id){
    const s = state.lotteries[id];
    const sourceName = ($(`${id}_manualSource`)?.value || '').trim();
    const group1 = parseManualGroupInput(($(`${id}_manualGroup1`)?.value || ''), s.cfg.maxNum);
    const group2 = parseManualGroupInput(($(`${id}_manualGroup2`)?.value || ''), s.cfg.maxNum);
    const group3 = parseManualGroupInput(($(`${id}_manualGroup3`)?.value || ''), s.cfg.maxNum);
    const group4 = parseManualGroupInput(($(`${id}_manualGroup4`)?.value || ''), s.cfg.maxNum);
    const full = parseManualGroupInput(($(`${id}_manualFull`)?.value || ''), s.cfg.maxNum);
    if(!sourceName){
      showMiniNotice(`${s.cfg.title}：請先輸入通報名稱`, 'warn');
      return;
    }
    const groups = [group1, group2, group3, group4];
    if(groups.some(g => g.length !== 5 || new Set(g).size !== 5)){
      showMiniNotice(`${s.cfg.title}：手動第一組到第四組都需輸入 5 顆不重複號碼`, 'warn');
      return;
    }
    const merged = groups.flat();
    if(new Set(merged).size !== merged.length){
      showMiniNotice(`${s.cfg.title}：手動第一組到第四組之間不可重複`, 'warn');
      return;
    }
    if(full.length !== 19 || new Set(full).size !== 19){
      showMiniNotice(`${s.cfg.title}：全車號碼需輸入 19 顆不重複號碼`, 'warn');
      return;
    }
    try{
      const manualGroupMap = {
        [($(`${id}_prize1Desc`).value.trim() || '第一組')]: group1,
        [($(`${id}_prize2Desc`).value.trim() || '第二組')]: group2,
        [($(`${id}_prize3Desc`).value.trim() || '第三組')]: group3,
        [($(`${id}_prize4Desc`).value.trim() || '第四組')]: group4,
        [($(`${id}_prize5Desc`).value.trim() || '全車號碼')]: full
      };
      const manualAnalysis = buildTrackingAnalysisMetaFromGroups(manualGroupMap, state.lotteries[id].historyAnalysis);
      const res = await fetch(`${API_BASE}/api/manual-tracking`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          lotteryType: id === 'ttl' ? 'ttl' : '539',
          lotteryTitle: s.cfg.title,
          confirmedAt: nowFull(),
          sourceName,
          groups: { group1, group2, group3, group4, full },
          analysis: manualAnalysis
        })
      });
      const result = await res.json().catch(()=>null);
      if(!res.ok || !result?.ok) throw new Error(result?.message || `HTTP ${res.status}`);
      const fullCount = result?.validation?.groupSizes?.full || full.length;
      showMiniNotice(`${s.cfg.title}：${result.message || '已新增手動追蹤'}（全車 ${fullCount} 顆）`, 'ok');
      ['manualGroup1','manualGroup2','manualGroup3','manualGroup4','manualFull'].forEach(key => {
        if($(`${id}_${key}`)) $(`${id}_${key}`).value = '';
      });
      await refreshTrackingBoard(id, { silent: true });
    }catch(err){
      showMiniNotice(`${s.cfg.title}：手動追蹤失敗：${err.message || '未知錯誤'}`, 'warn');
    }
  }

  
  function parseManualGroupInput(value, maxNum){
    return cleanupInput(String(value || '').split(/[^\d]+/), 'digits')
      .map(n => parseInt(n,10))
      .filter(n => Number.isInteger(n) && n >= 1 && n <= maxNum)
      .map(n => String(n).padStart(2,'0'));
  }


  const manualPickerState = {
    id: '',
    targetKey: '',
    maxCount: 0,
    mainKeys: ['manualGroup1','manualGroup2','manualGroup3','manualGroup4']
  };

  function ensureManualPickerModal(){
    if ($('manualPickerModal')) return;
    const wrap = document.createElement('div');
    wrap.id = 'manualPickerModal';
    wrap.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.55);display:none;align-items:center;justify-content:center;z-index:9999;padding:16px;';
    wrap.innerHTML = `
      <div style="width:min(820px,96vw);max-height:90vh;overflow:auto;background:#4d0808;border:1px solid rgba(255,210,140,.35);border-radius:18px;padding:18px;color:#ffe2b6;box-shadow:0 20px 50px rgba(0,0,0,.4);">
        <div style="display:flex;justify-content:space-between;align-items:center;gap:10px;">
          <div>
            <div id="manualPickerTitle" style="font-size:22px;font-weight:900;">選擇號碼</div>
            <div id="manualPickerSub" class="small muted" style="margin-top:4px;">點選 1-39 號碼，會自動排序帶入</div>
          </div>
          <button id="manualPickerClose" class="secondary">關閉</button>
        </div>
        <div id="manualPickerSummary" style="margin-top:10px;font-size:14px;"></div>
        <div id="manualPickerGrid" style="margin-top:14px;display:grid;grid-template-columns:repeat(6,minmax(0,1fr));gap:8px;"></div>
        <div style="display:flex;justify-content:space-between;align-items:center;gap:12px;margin-top:16px;flex-wrap:wrap;">
          <div id="manualPickerSelected" style="font-size:14px;line-height:1.8;"></div>
          <div class="btns"><button id="manualPickerClear" class="secondary">清空本欄</button><button id="manualPickerApply" class="green">帶入這一組</button></div>
        </div>
      </div>`;
    document.body.appendChild(wrap);
    $('manualPickerClose').addEventListener('click', closeManualPicker);
    $('manualPickerApply').addEventListener('click', applyManualPicker);
    $('manualPickerClear').addEventListener('click', ()=>{
      const input = $(`${manualPickerState.id}_${manualPickerState.targetKey}`);
      if (input) input.value = '';
      renderManualPicker();
    });
    wrap.addEventListener('click', (e)=>{ if (e.target === wrap) closeManualPicker(); });
  }

  function getManualFieldKeys(){
    return ['manualGroup1','manualGroup2','manualGroup3','manualGroup4','manualFull'];
  }

  function getManualSelectedMap(id){
    const map = {};
    getManualFieldKeys().forEach((key)=>{
      map[key] = parseManualGroupInput(($(`${id}_${key}`)?.value || ''), 39);
    });
    return map;
  }

  function getReservedNumbers(id, targetKey){
    const selected = getManualSelectedMap(id);
    const reserved = new Set();
    const mainKeys = manualPickerState.mainKeys;
    if (targetKey === 'manualFull') {
      mainKeys.forEach((key)=> selected[key].forEach((n)=> reserved.add(n)));
      return reserved;
    }
    mainKeys.forEach((key)=>{
      if (key === targetKey) return;
      selected[key].forEach((n)=> reserved.add(n));
    });
    (selected.manualFull || []).forEach((n)=> reserved.add(n));
    return reserved;
  }

  function openManualPicker(id, targetKey, maxCount){
    manualPickerState.id = id;
    manualPickerState.targetKey = targetKey;
    manualPickerState.maxCount = maxCount;
    ensureManualPickerModal();
    $('manualPickerModal').style.display = 'flex';
    const labelMap = {
      manualGroup1: '第一組', manualGroup2: '第二組', manualGroup3: '第三組', manualGroup4: '第四組', manualFull: '全車號碼'
    };
    $('manualPickerTitle').textContent = `選擇${labelMap[targetKey] || '號碼'}`;
    $('manualPickerSub').textContent = `可選 ${maxCount} 顆；主四組與全車不可重複，系統會自動排序。`;
    renderManualPicker();
  }

  function closeManualPicker(){
    if ($('manualPickerModal')) $('manualPickerModal').style.display = 'none';
  }

  function renderManualPicker(){
    const { id, targetKey, maxCount } = manualPickerState;
    const input = $(`${id}_${targetKey}`);
    if (!input) return;
    const selected = parseManualGroupInput(input.value || '', 39);
    const reserved = getReservedNumbers(id, targetKey);
    $('manualPickerSummary').textContent = `已選 ${selected.length}/${maxCount} 顆`;
    $('manualPickerSelected').textContent = selected.length ? `目前號碼：${selected.join('、')}` : '目前尚未選號';
    const grid = $('manualPickerGrid');
    grid.innerHTML = '';
    for (let i=1;i<=39;i++) {
      const n = String(i).padStart(2,'0');
      const active = selected.includes(n);
      const blocked = !active && reserved.has(n);
      const full = !active && selected.length >= maxCount;
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.textContent = n;
      btn.style.cssText = `padding:10px 6px;border-radius:12px;border:1px solid rgba(255,210,140,.28);background:${active ? '#f7c873' : blocked ? 'rgba(255,255,255,.12)' : '#5d1111'};color:${active ? '#4c1200' : blocked ? 'rgba(255,255,255,.45)' : '#ffe2b6'};font-weight:800;cursor:${blocked ? 'not-allowed' : 'pointer'};opacity:${full && !active ? .45 : 1};`;
      btn.disabled = blocked || full;
      btn.addEventListener('click', ()=>{
        let next = parseManualGroupInput(input.value || '', 39);
        if (next.includes(n)) next = next.filter(x => x !== n);
        else next.push(n);
        next = [...new Set(next)].sort((a,b)=>Number(a)-Number(b)).slice(0, maxCount);
        input.value = next.join(' ');
        renderManualPicker();
      });
      grid.appendChild(btn);
    }
  }

  function applyManualPicker(){
    closeManualPicker();
  }

  function attachManualPicker(id){
    ensureManualPickerModal();
    const config = [
      ['manualGroup1',5],['manualGroup2',5],['manualGroup3',5],['manualGroup4',5],['manualFull',19]
    ];
    config.forEach(([key, maxCount])=>{
      const input = $(`${id}_${key}`);
      if (!input || input.dataset.pickerBound === '1') return;
      input.readOnly = true;
      input.dataset.pickerBound = '1';
      input.style.cursor = 'pointer';
      input.addEventListener('click', ()=>openManualPicker(id, key, maxCount));
      input.addEventListener('focus', ()=>openManualPicker(id, key, maxCount));
    });
  }

  function fillManualRandomGroups(id){
    const s = state.lotteries[id];
    const analysis = s.historyAnalysis || analyzeHistoryText(id, getEls(id).historyInput.value.trim());
    if (analysis) {
      s.historyAnalysis = analysis;
      renderHistoryAnalysis(id, analysis);
    }
    const hot = (analysis?.hot || []).slice(0, 10);
    const cold = (analysis?.cold || []).slice(0, 10);
    const allNums = Array.from({length:s.cfg.maxNum}, (_,i)=>String(i+1).padStart(2,'0'));
    const mid = allNums.filter((n)=>!hot.includes(n) && !cold.includes(n));
    const pairCounts = analysis?.pairCounts || {};
    const tripleCounts = analysis?.tripleCounts || {};
    const highRiskPairs = new Set((analysis?.topPairs || []).filter(([key,count])=>Number(count||0)>=2).map(([key])=>key));
    const highRiskTriples = new Set((analysis?.topTriples || []).filter(([key,count])=>Number(count||0)>=2).map(([key])=>key));
    const used = new Set();
    const makePools = () => [shuffle(hot), shuffle(mid).slice(0, 15), shuffle(mid).slice(15), shuffle(cold), shuffle(cold)];
    const groups = {
      group1: makeGroupFromPools(5, makePools(), used, highRiskPairs, highRiskTriples, s.cfg.maxNum),
      group2: makeGroupFromPools(5, makePools(), used, highRiskPairs, highRiskTriples, s.cfg.maxNum),
      group3: makeGroupFromPools(5, makePools(), used, highRiskPairs, highRiskTriples, s.cfg.maxNum),
      group4: makeGroupFromPools(5, makePools(), used, highRiskPairs, highRiskTriples, s.cfg.maxNum)
    };
    const riskyNumberSet = new Set();
    highRiskPairs.forEach((key)=>key.split('-').forEach((n)=>riskyNumberSet.add(n)));
    highRiskTriples.forEach((key)=>key.split('-').forEach((n)=>riskyNumberSet.add(n)));
    const fullPool = [...shuffle(allNums.filter(n => !used.has(n) && riskyNumberSet.has(n))), ...shuffle(allNums.filter(n => !used.has(n) && !riskyNumberSet.has(n)))];
    groups.full = fullPool.slice(0,19).sort((a,b)=>Number(a)-Number(b));
    $(`${id}_manualGroup1`).value = groups.group1.join(' ');
    $(`${id}_manualGroup2`).value = groups.group2.join(' ');
    $(`${id}_manualGroup3`).value = groups.group3.join(' ');
    $(`${id}_manualGroup4`).value = groups.group4.join(' ');
    $(`${id}_manualFull`).value = groups.full.join(' ');
    showMiniNotice(`${state.lotteries[id].cfg.title}：已一鍵填入手動追蹤號碼`, 'ok');
  }



function pickRandom(list, used){
  const arr = list.filter(n => !used.has(n));
  if(!arr.length) return null;
  return arr[Math.floor(Math.random() * arr.length)];
}

function groupHasRisk(nextNum, group, highRiskPairs, highRiskTriples){
  const test = [...group, nextNum].sort((a,b)=>parseInt(a,10)-parseInt(b,10));
  for(const pair of getCombinations(test, 2)) if(highRiskPairs.has(comboKey(pair))) return true;
  for(const triple of getCombinations(test, 3)) if(highRiskTriples.has(comboKey(triple))) return true;
  return false;
}

function makeGroupFromPools(targetSize, pools, used, highRiskPairs, highRiskTriples, maxNum){
  const group = [];
  const fallback = Array.from({length:maxNum}, (_,i)=> String(i+1).padStart(2,'0'));
  for(const pool of pools){
    let guard = 0;
    while(group.length < targetSize && guard < 60){
      guard += 1;
      const pick = pickRandom(pool, used);
      if(!pick) break;
      if(groupHasRisk(pick, group, highRiskPairs, highRiskTriples)) continue;
      group.push(pick); used.add(pick); break;
    }
  }
  let guard = 0;
  while(group.length < targetSize && guard < 500){
    guard += 1;
    const pick = pickRandom(fallback, used);
    if(!pick) break;
    if(groupHasRisk(pick, group, highRiskPairs, highRiskTriples)) continue;
    group.push(pick); used.add(pick);
  }
  return group.sort((a,b)=>parseInt(a,10)-parseInt(b,10));
}


function buildTrackingAnalysisMetaFromGroups(groups, analysis){
  const allNums = Object.keys((analysis && analysis.counts) || {}).sort((a,b)=>parseInt(a,10)-parseInt(b,10));
  const hot = Array.isArray(analysis?.hot) ? analysis.hot.slice(0, 10) : [];
  const cold = Array.isArray(analysis?.cold) ? analysis.cold.slice(0, 10) : [];
  const mid = allNums.filter(n => !hot.includes(n) && !cold.includes(n));
  const pairCounts = analysis?.pairCounts || {};
  const tripleCounts = analysis?.tripleCounts || {};
  const topPairs = Array.isArray(analysis?.topPairs) ? analysis.topPairs : [];
  const topTriples = Array.isArray(analysis?.topTriples) ? analysis.topTriples : [];
  const highRiskPairs = topPairs.filter(([key,count]) => Number(count||0) >= 2).map(([key]) => key);
  const highRiskTriples = topTriples.filter(([key,count]) => Number(count||0) >= 2).map(([key]) => key);
  const riskyNumberSet = new Set();
  highRiskPairs.forEach(key => key.split('-').forEach(n => riskyNumberSet.add(n)));
  highRiskTriples.forEach(key => key.split('-').forEach(n => riskyNumberSet.add(n)));
  const mains = [
    groups[Object.keys(groups)[0]] || [],
    groups[Object.keys(groups)[1]] || [],
    groups[Object.keys(groups)[2]] || [],
    groups[Object.keys(groups)[3]] || []
  ].map(g => g.map(n => String(n).padStart(2,'0')));
  const riskGroupDetails = mains.map((g, idx) => {
    const riskyPairHits = getCombinations(g,2).filter(pair => highRiskPairs.includes(comboKey(pair))).map(pair => pair.join('、'));
    const riskyTripleHits = getCombinations(g,3).filter(triple => highRiskTriples.includes(comboKey(triple))).map(triple => triple.join('、'));
    return {
      groupIndex: idx + 1,
      groupNumbers: g,
      hotCount: g.filter(n => hot.includes(n)).length,
      midCount: g.filter(n => mid.includes(n)).length,
      coldCount: g.filter(n => cold.includes(n)).length,
      riskyNumbers: g.filter(n => riskyNumberSet.has(n)),
      riskyPairHits,
      riskyTripleHits
    };
  });
  return {
    drawCount: Number(analysis?.drawCount || 0),
    evaluatedWindow: Number(analysis?.drawCount || 0),
    counts: analysis?.counts || {},
    hotNumbers: hot,
    midNumbers: mid,
    coldNumbers: cold,
    pairCounts,
    tripleCounts,
    pairWeightMap: pairCounts,
    tripleWeightMap: tripleCounts,
    hotScoreMap: analysis?.counts || {},
    highRiskPairs,
    highRiskTriples,
    riskyNumbers: Array.from(riskyNumberSet),
    riskGroupDetails
  };
}

function buildSimpleGeneratedPlan(id, analysis){
  const hot = (analysis.hot || []).slice(0, 10);
  const cold = (analysis.cold || []).slice(0, 10);
  const mid = (analysis.mid || []).filter(n => !hot.includes(n) && !cold.includes(n));
  const highRiskPairs = new Set(analysis.highRiskPairs || []);
  const highRiskTriples = new Set(analysis.highRiskTriples || []);
  const riskyNumbers = new Set(analysis.riskyNumberSet ? Array.from(analysis.riskyNumberSet) : []);
  const used = new Set();
  const maxNum = state.lotteries[id].cfg.maxNum;
  const groupNames = [
    $(`${id}_prize1Desc`).value.trim() || '第一組',
    $(`${id}_prize2Desc`).value.trim() || '第二組',
    $(`${id}_prize3Desc`).value.trim() || '第三組',
    $(`${id}_prize4Desc`).value.trim() || '第四組',
    $(`${id}_prize5Desc`).value.trim() || '全車號碼'
  ];
  const groups = {};
  for(let gi=0; gi<4; gi++){
    const pools = [shuffle(hot), shuffle(mid).slice(0, 15), shuffle(mid).slice(15), shuffle(cold), shuffle(cold)];
    groups[groupNames[gi]] = makeGroupFromPools(5, pools, used, highRiskPairs, highRiskTriples, maxNum);
  }
  const allNums = Array.from({length:maxNum}, (_,i)=> String(i+1).padStart(2,'0'));
  const preferredFull = shuffle(allNums.filter(n => !used.has(n) && riskyNumbers.has(n)));
  const otherFull = shuffle(allNums.filter(n => !used.has(n) && !riskyNumbers.has(n)));
  const full = [];
  for(const n of [...preferredFull, ...otherFull]){ if(full.length >= 19) break; full.push(n); }
  groups[groupNames[4]] = full.sort((a,b)=>parseInt(a,10)-parseInt(b,10));
  const mains = [groups[groupNames[0]], groups[groupNames[1]], groups[groupNames[2]], groups[groupNames[3]]];
  const twoHitRisk = mains.reduce((acc, g)=> acc + getCombinations(g,2).filter(pair => highRiskPairs.has(comboKey(pair))).length, 0);
  const threeHitRisk = mains.reduce((acc, g)=> acc + getCombinations(g,3).filter(triple => highRiskTriples.has(comboKey(triple))).length, 0);
  const hotCounts = mains.map(g => g.filter(n => hot.includes(n)).length);
  const riskGroupDetails = mains.map((g, idx) => ({
    groupIndex: idx + 1,
    hotCount: g.filter(n => hot.includes(n)).length,
    riskyNumbers: g.filter(n => riskyNumbers.has(n)),
    riskyPairHits: getCombinations(g,2).filter(pair => highRiskPairs.has(comboKey(pair))).map(pair => pair.join('、')),
    riskyTripleHits: getCombinations(g,3).filter(triple => highRiskTriples.has(comboKey(triple))).map(triple => triple.join('、'))
  }));
  return {
    groups,
    score: Math.max(60, 90 - twoHitRisk * 10 - threeHitRisk * 15),
    searchedCandidates: 1,
    analyzedDrawCount: analysis.drawCount || 0,
    elapsedMs: 0,
    twoHitRisk,
    threeHitRisk,
    lowRiskGroups: Math.max(0, 4 - twoHitRisk - threeHitRisk),
    mediumRiskGroups: 0,
    rejectedGroups: 0,
    selectedPool: 'simple',
    downgraded: false,
    whyQualified: `已依近50期避開高風險雙號 / 三連號，並將熱號拆散配置；各組熱號數：${hotCounts.join(' / ')}。`,
    analysisMeta: (() => {
      const meta = buildTrackingAnalysisMetaFromGroups(groups, analysis) || {};
      meta.twoHitRisk = twoHitRisk;
      meta.threeHitRisk = threeHitRisk;
      meta.riskGroupDetails = riskGroupDetails;
      return meta;
    })()
  };
}

function bindEvents(id){
    $(`${id}_btnLoad`).addEventListener("click", ()=>loadList(id));
    $(`${id}_btnSample`).addEventListener("click", ()=>apply01to39List(id));
    $(`${id}_btnShuffle`).addEventListener("click", ()=>shufflePool(id));
    $(`${id}_btnClearAll`).addEventListener("click", ()=>clearAll(id));
    $(`${id}_btnUndo`).addEventListener("click", ()=>undo(id));
    $(`${id}_btnClearLog`).addEventListener("click", ()=>clearLog(id));
    $(`${id}_btnExport`).addEventListener("click", ()=>exportCsv(id));
    $(`${id}_btnExportXlsx`).addEventListener("click", ()=>exportXlsx(id, "logs.xlsx"));
    $(`${id}_btnCopyWinner`).addEventListener("click", ()=>copyWinner(id));
    $(`${id}_btnApply01to39`).addEventListener("click", ()=>apply01to39List(id));
    $(`${id}_btnAnalyzeHistory`).addEventListener("click", ()=>analyzeHistoryAndRender(id));
    $(`${id}_btnSync`).addEventListener("click", ()=>syncHistory(id));
    $(`${id}_btnToggleAuto`).addEventListener("click", ()=>{
      const s = state.lotteries[id];
      s.autoRefreshEnabled = !s.autoRefreshEnabled;
      setAutoState(id);
      persistAll();
      showMiniNotice(`${s.cfg.title}：自動更新已${s.autoRefreshEnabled ? "開啟" : "關閉"}`, "info");
    });

    getEls(id).autoDownloadXlsx.addEventListener("change", ()=>{
      persistAll();
      showMiniNotice(`${state.lotteries[id].cfg.title}：自動下載 logs.xlsx 已${getEls(id).autoDownloadXlsx.checked ? "開啟" : "關閉"}`, "info");
    });

    $(`${id}_btnConfirmTracking`).addEventListener("click", ()=>confirmTracking(id));
    setConfirmAvailability(id, false, '請先執行自動生成');
    $(`${id}_btnManualTracking`).addEventListener("click", ()=>submitManualTracking(id));
    if ($(`${id}_btnManualRandomFill`)) $(`${id}_btnManualRandomFill`).addEventListener("click", ()=>fillManualRandomGroups(id));
    if ($(`${id}_btnManualClear`)) $(`${id}_btnManualClear`).addEventListener("click", ()=>{ ['manualGroup1','manualGroup2','manualGroup3','manualGroup4','manualFull'].forEach(key=>{ if($(`${id}_${key}`)) $(`${id}_${key}`).value=''; }); });
    $(`${id}_btnRefreshTracking`).addEventListener("click", ()=>refreshTrackingBoard(id));
    $(`${id}_btnTelegramTest`).addEventListener("click", ()=>testTelegram(id));
    $(`${id}_btnSaveTelegramConfig`).addEventListener("click", ()=>saveTelegramConfig(id));

    
$(`${id}_btnGenerateSmart`).addEventListener("click", async ()=>{
  const text = getEls(id).historyInput.value.trim();
  if(!text){
    showMiniNotice(`${state.lotteries[id].cfg.title}：請先同步或貼上歷史資料`, "warn");
    return;
  }
  const analysis = state.lotteries[id].historyAnalysis || analyzeHistoryText(id, text);
  state.lotteries[id].historyAnalysis = analysis;
  renderHistoryAnalysis(id, analysis);

  const btn = $(`${id}_btnGenerateSmart`);
  btn.disabled = true;
  const originalText = btn.textContent;
  btn.textContent = '生成中...';
  setConfirmAvailability(id, false, "系統正在生成可用方案");
  openSearchOverlay(id);
  const startedAt = Date.now();
  updateSearchOverlay(id, { searched: 0, target: 5, elapsedMs: 0, stageLabel: '分析近50期', statusText: '生成中', footerText: '系統正在分析高風險雙號 / 三連號與熱中冷分布。' });
  await sleep(120);
  try {
    const bestResult = buildSimpleGeneratedPlan(id, analysis);
    state.lotteries[id].generatedGroups = bestResult;
    await lockSearchResult(id, bestResult);
    renderGroupPreview(id, bestResult);
    applyGeneratedGroupsToLog(id, bestResult.groups);
    setConfirmAvailability(id, true);
    showMiniNotice(`${state.lotteries[id].cfg.title}：已生成可直接通報的方案`, "ok");
  } catch (err) {
    console.error(err);
    state.lotteries[id].generatedGroups = null;
    getEls(id).groupPreview.innerHTML = `<div class="groupRow"><b>生成失敗</b><span style="color:#ffd8a8;">${escapeHtml(err.message || '系統生成失敗，請再試一次。')}</span></div>`;
    setConfirmAvailability(id, false, "生成失敗");
    showMiniNotice(`${state.lotteries[id].cfg.title}：生成失敗，請再試一次`, "warn");
  } finally {
    searchAnimState.running = false;
    btn.disabled = false;
    btn.textContent = originalText;
    persistAll();
  }
});

[1,2,3,4,5].forEach(i=>{
      $(`${id}_prize${i}Count`).addEventListener("input", ()=>{
        syncPrizeButtons(id);
        persistAll();
      });
      $(`${id}_prize${i}Label`).addEventListener("input", persistAll);
      $(`${id}_prize${i}Desc`).addEventListener("input", persistAll);

      $(`${id}_btnPrize${i}`).addEventListener("click", async ()=>{
        const label = ($(`${id}_prize${i}Label`).value || `獎項${i}`).trim() || `獎項${i}`;
        const desc = ($(`${id}_prize${i}Desc`).value || "").trim();
        const nRaw = parseInt($(`${id}_prize${i}Count`).value || "1", 10);
        const n = Math.max(1, isNaN(nRaw) ? 1 : nRaw);

        getEls(id).currentMeta.textContent = `獎項：${label}（${desc}）｜快速抽獎中...`;
        if (n > 1) await drawMany(id, n, label, desc, true);
        else await drawOne(id, label, desc, true);
      });
    });

    getEls(id).listInput.addEventListener("input", persistAll);
    getEls(id).historyInput.addEventListener("input", persistAll);
    getEls(id).cleanupMode.addEventListener("change", persistAll);
    getEls(id).drawMode.addEventListener("change", persistAll);

    syncPrizeButtons(id);
  }

  function startAutoTimer(id){
    const s = state.lotteries[id];
    if(s.timer) clearInterval(s.timer);
    s.timer = setInterval(async ()=>{
      if(!s.autoRefreshEnabled) return;
      await syncHistory(id, true);
    }, CONFIG.autoRefreshMs);
  }

  async function initLottery(id, restored){
    bindEvents(id);
    attachManualPicker(id);

    if(restored){
      renderRestoredState(id);
    }else{
      apply01to39List(id);
      renderLog(id);
      updateStats(id);
      setAutoState(id);
    }

    const ok = await syncHistory(id, true);
    if(!ok && restored){
      renderRestoredState(id);
    }
    startAutoTimer(id);
  }

  async function init(){
    mountLotteries();
    setTaipeiClock();
    $("globalAutoText").textContent = "開啟";
    $("saveStateText").textContent = state.settings.autoSave ? "開啟" : "關閉";

    const restored = restoreState();

    await initLottery("ttl", restored);
    await initLottery("l539", restored);

    if(restored){
      showMiniNotice("已恢復上次本機保存資料", "ok");
    }else{
      showMiniNotice("系統已初始化完成", "ok");
    }
  }

  init();
})();
