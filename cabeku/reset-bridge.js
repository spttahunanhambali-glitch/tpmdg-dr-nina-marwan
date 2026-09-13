(() => {
  'use strict';

  // Confidence guard: the AI runtime sometimes returns numeric 0 even when a
  // usable status/observation exists. Convert that invalid display state into
  // a conservative fallback without overriding non-zero model confidence.
  const originalFetch = window.fetch.bind(window);
  window.fetch = async (...args) => {
    const response = await originalFetch(...args);
    try {
      const requestUrl = typeof args[0] === 'string' ? args[0] : args[0]?.url || '';
      if (!String(requestUrl).includes('/api/cabeku-scan') || !response.headers.get('content-type')?.includes('application/json')) return response;
      const payload = await response.clone().json();
      const review = payload?.review;
      if (payload?.ok && review && Number(review.confidence) === 0 && review.status !== 'Data Belum Cukup') {
        const quality = review.photo_quality === 'good' ? 72 : review.photo_quality === 'fair' ? 52 : 25;
        const observationCount = Array.isArray(review.observations) ? review.observations.length : 0;
        review.confidence = Math.min(90, quality + Math.min(18, observationCount * 3));
        payload.review = review;
      }
      return new Response(JSON.stringify(payload), {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers,
      });
    } catch {
      return response;
    }
  };

  const STORAGE_KEY = 'cabeku.scanHistory.v3';
  const readHistory = () => {
    try {
      const value = JSON.parse(localStorage.getItem(STORAGE_KEY) || '[]');
      return Array.isArray(value) ? value : [];
    } catch { return []; }
  };
  const num = (value) => { if (value === null || value === undefined || value === '') return null; const n = Number(value); return Number.isFinite(n) ? n : null; };
  const formValue = (id) => document.getElementById(id)?.value ?? '';

  const injectStyles = () => {
    if (document.getElementById('cabeku-timeline-style')) return;
    const style = document.createElement('style');
    style.id = 'cabeku-timeline-style';
    style.textContent = `
      #cabekuTimeline{margin-top:18px;padding:17px;border:1px solid rgba(239,213,157,.16);border-radius:18px;background:rgba(255,255,255,.035)}
      #cabekuTimeline .tl-head{display:flex;justify-content:space-between;gap:10px;align-items:center}
      #cabekuTimeline .tl-head strong{color:#efd59d;font-size:.85rem}
      #cabekuTimeline .tl-head span{color:#9f968b;font-size:.68rem}
      #cabekuTimeline .tl-summary{margin:10px 0;color:#c1b8ad;font-size:.74rem}
      #cabekuTimeline .tl-grid{display:grid;gap:8px}
      #cabekuTimeline .tl-row{display:grid;grid-template-columns:1fr auto;gap:8px;padding:10px;border:1px solid rgba(239,213,157,.12);border-radius:12px}
      #cabekuTimeline .tl-row b{color:#ddd2c1;font-size:.74rem}
      #cabekuTimeline .tl-row span{color:#aaa197;font-size:.72rem;text-align:right}
      #cabekuTimeline .tl-note{margin-top:10px;color:#9e968b;font-size:.68rem;line-height:1.5}
    `;
    document.head.appendChild(style);
  };

  const ensureTimeline = () => {
    const history = document.querySelector('.history');
    if (!history || document.getElementById('cabekuTimeline')) return;
    injectStyles();
    const section = document.createElement('section');
    section.id = 'cabekuTimeline';
    section.innerHTML = `
      <div class="tl-head"><strong>📈 Growth Timeline</strong><span id="cabekuTimelineMeta">Belum ada baseline</span></div>
      <div class="tl-summary" id="cabekuTimelineSummary">Timeline akan membaca riwayat scan yang memiliki HST dan pengukuran morfologi.</div>
      <div class="tl-grid" id="cabekuTimelineRows"></div>
      <div class="tl-note">Tren dihitung dari selisih antar-scan pada tanaman yang sama di browser ini. Jangan menafsirkan satu scan sebagai bukti penyebab gangguan.</div>
    `;
    history.appendChild(section);
  };

  const enrichLatestHistory = (snapshot) => {
    try {
      const history = readHistory();
      if (!history.length) return;
      const latest = history[0];
      if (!latest || latest.date !== snapshot.date || latest.hst !== snapshot.hst) return;
      history[0] = { ...latest, variety: snapshot.variety, measurements: snapshot.measurements };
      localStorage.setItem(STORAGE_KEY, JSON.stringify(history.slice(0, 20)));
    } catch {}
  };

  const trend = (current, previous, hstDelta, leaf = false) => {
    if (current === null || previous === null || hstDelta <= 0) return null;
    const delta = current - previous;
    const per10 = (delta / hstDelta) * 10;
    const threshold = leaf ? 1 : 0.5;
    const state = per10 > threshold ? 'naik' : per10 < -threshold ? 'turun' : 'stabil';
    return { delta, per10, state };
  };

  const renderTimeline = () => {
    ensureTimeline();
    const meta = document.getElementById('cabekuTimelineMeta');
    const summary = document.getElementById('cabekuTimelineSummary');
    const rows = document.getElementById('cabekuTimelineRows');
    if (!meta || !summary || !rows) return;
    const history = readHistory().map((item) => ({ ...item, hst: num(item.hst), measurements: item.measurements && typeof item.measurements === 'object' ? item.measurements : null })).filter((item) => item.hst !== null).sort((a,b) => a.hst - b.hst);
    rows.replaceChildren();
    if (history.length < 2) { meta.textContent = history.length ? '1 baseline' : 'Belum ada baseline'; summary.textContent = 'Butuh minimal 2 scan pada HST berbeda untuk membaca tren pertumbuhan.'; return; }
    const latest = history[history.length - 1], previous = history[history.length - 2], hstDelta = latest.hst - previous.hst;
    const metrics = [['Tinggi','heightCm',false,'cm'],['Lebar tajuk','canopyCm',false,'cm'],['Jumlah daun','leafCount',true,'daun']];
    const available = metrics.map(([label,key,leaf,unit]) => ({label,key,leaf,unit,current:num(latest.measurements?.[key]),previous:num(previous.measurements?.[key])})).map((item) => ({...item,result:trend(item.current,item.previous,hstDelta,Boolean(item.leaf))})).filter((item)=>item.result!==null);
    meta.textContent = `${history.length} scan • HST ${history[0].hst} → ${latest.hst}`;
    summary.textContent = available.length ? `Perubahan terakhir dihitung dari HST ${previous.hst} ke ${latest.hst}.` : 'Riwayat sudah tersedia, tetapi belum ada dua scan dengan pengukuran morfologi yang sebanding.';
    available.forEach((item) => { const row=document.createElement('div'); row.className='tl-row'; const b=document.createElement('b'); b.textContent=`${item.label}: ${item.result.state}`; const s=document.createElement('span'); const sign=item.result.per10>0?'+':''; const decimals=item.leaf?1:2; s.textContent=`${sign}${item.result.per10.toFixed(decimals)} ${item.unit}/10 HST`; row.append(b,s); rows.append(row); });
  };

  const capturePending = () => ({
    hst: num(formValue('hst')),
    variety: formValue('variety') || 'unknown',
    measurements: { heightCm:num(formValue('height')), canopyCm:num(formValue('canopy')), leafCount:num(formValue('leafCount')), leafWidthCm:num(formValue('leafWidth')) },
    date: null,
  });

  const watchScan = () => {
    const scan = document.querySelector('#scanBtn');
    if (!scan) return;
    scan.addEventListener('click', () => {
      const snapshot = capturePending();
      const startedCount = readHistory().length;
      let attempts = 0;
      const timer = window.setInterval(() => {
        attempts += 1;
        const history = readHistory();
        if (history.length > startedCount) { snapshot.date = history[0]?.date || new Date().toISOString(); enrichLatestHistory(snapshot); renderTimeline(); window.clearInterval(timer); }
        else if (attempts >= 30) window.clearInterval(timer);
      }, 1000);
    });
  };

  const reset = document.querySelector('#resetBtn');
  if (reset) reset.addEventListener('click', () => window.setTimeout(() => window.location.reload(), 0), { once: true });
  ensureTimeline(); watchScan(); renderTimeline();
})();
