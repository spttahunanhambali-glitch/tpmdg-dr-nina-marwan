(() => {
  'use strict';

  const MAX_PHOTOS = 5;
  const MAX_FILE_BYTES = 8 * 1024 * 1024;
  const ACCEPTED = new Set(['image/jpeg', 'image/png', 'image/webp']);
  const BLUR_THRESHOLD = 85;
  const FAIR_THRESHOLD = 150;
  const severity = { 'Sehat': 0, 'Perlu Diamati': 1, 'Perlu Pemeriksaan': 2, 'Data Belum Cukup': 3 };
  const $ = (selector) => document.querySelector(selector);

  const upload = $('#uploadBox');
  const oldInput = $('#photo');
  const scanButton = $('#scanBtn');
  const preview = $('#preview');
  if (!upload || !oldInput || !scanButton) return;

  const state = { files: [], reviews: [], scanning: false };

  const input = oldInput.cloneNode(true);
  input.id = 'photo';
  input.name = 'photos';
  input.multiple = true;
  input.removeAttribute('capture');
  input.accept = 'image/jpeg,image/png,image/webp';
  oldInput.replaceWith(input);

  const oldScanButton = scanButton;
  const scan = oldScanButton.cloneNode(true);
  scan.id = 'scanBtn';
  oldScanButton.replaceWith(scan);

  if (preview) preview.style.display = 'none';

  const gallery = document.createElement('div');
  gallery.id = 'multiPhotoGallery';
  gallery.setAttribute('aria-live', 'polite');
  gallery.style.cssText = 'display:grid;grid-template-columns:repeat(auto-fill,minmax(150px,1fr));gap:10px;margin-top:14px;';
  upload.insertAdjacentElement('afterend', gallery);

  const status = document.createElement('div');
  status.id = 'photoReviewStatus';
  status.setAttribute('role', 'status');
  status.style.cssText = 'margin-top:10px;color:#71695f;font-size:.78rem;';
  gallery.insertAdjacentElement('afterend', status);

  const style = document.createElement('style');
  style.textContent = `
    .cabeku-photo{position:relative;border:1px solid #e5ddce;border-radius:16px;background:#fff;padding:8px;overflow:hidden}
    .cabeku-photo img{display:block;width:100%;aspect-ratio:1/1;object-fit:cover;border-radius:11px;background:#eee7da}
    .cabeku-photo .meta{display:flex;justify-content:space-between;gap:6px;align-items:center;margin-top:7px;font-size:.68rem;color:#71695f}
    .cabeku-photo .quality{font-weight:900;padding:3px 7px;border-radius:999px;background:#eee9df;color:#625a50}
    .cabeku-photo.good .quality{background:#e5f2e9;color:#236247}
    .cabeku-photo.fair .quality{background:#fbf0d9;color:#805e1b}
    .cabeku-photo.poor .quality{background:#f8e4df;color:#8d4032}
    .cabeku-photo .remove{position:absolute;top:13px;right:13px;border:0;width:30px;height:30px;border-radius:50%;background:rgba(9,9,8,.78);color:#fff;cursor:pointer;font-weight:900;line-height:1}
    .cabeku-photo .scan-state{margin-top:6px;font-size:.66rem;color:#766f66;min-height:17px}
    .cabeku-photo .scan-state.error{color:#9b4a39}
    .cabeku-count{display:inline-flex;align-items:center;gap:7px;padding:7px 10px;border:1px solid #e5ddce;border-radius:999px;background:#fffdf9;font-weight:800}
    .cabeku-hint{margin:8px 0 0;color:#81786d;font-size:.72rem}
    @media(max-width:600px){#multiPhotoGallery{grid-template-columns:repeat(2,minmax(0,1fr)) !important}}
  `;
  document.head.appendChild(style);

  function setStatus(text) { status.textContent = text; }

  function syncInputFiles() {
    const dataTransfer = new DataTransfer();
    state.files.forEach(({ file }) => dataTransfer.items.add(file));
    input.files = dataTransfer.files;
  }

  function formatSize(bytes) {
    return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
  }

  function fileKey(file) { return `${file.name}::${file.size}::${file.lastModified}`; }

  function imageData(file) {
    const url = URL.createObjectURL(file);
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => {
        URL.revokeObjectURL(url);
        resolve(img);
      };
      img.onerror = () => {
        URL.revokeObjectURL(url);
        reject(new Error('Foto tidak dapat dibaca oleh browser.'));
      };
      img.src = url;
    });
  }

  async function qualityOf(file) {
    const img = await imageData(file);
    const max = 360;
    const scale = Math.min(1, max / Math.max(img.naturalWidth, img.naturalHeight));
    const width = Math.max(32, Math.round(img.naturalWidth * scale));
    const height = Math.max(32, Math.round(img.naturalHeight * scale));
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) throw new Error('Canvas tidak tersedia.');
    ctx.drawImage(img, 0, 0, width, height);
    const pixels = ctx.getImageData(0, 0, width, height).data;
    const gray = new Float32Array(width * height);
    let luminance = 0;
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        const i = (y * width + x) * 4;
        const value = pixels[i] * 0.299 + pixels[i + 1] * 0.587 + pixels[i + 2] * 0.114;
        gray[y * width + x] = value;
        luminance += value;
      }
    }
    const mean = luminance / gray.length;
    let variance = 0;
    for (const value of gray) variance += (value - mean) ** 2;
    variance /= gray.length;

    let lapSum = 0;
    let lapSqSum = 0;
    let count = 0;
    for (let y = 1; y < height - 1; y += 1) {
      for (let x = 1; x < width - 1; x += 1) {
        const center = gray[y * width + x];
        const lap = gray[(y - 1) * width + x] + gray[(y + 1) * width + x] + gray[y * width + x - 1] + gray[y * width + x + 1] - 4 * center;
        lapSum += lap;
        lapSqSum += lap * lap;
        count += 1;
      }
    }
    const lapMean = lapSum / Math.max(1, count);
    const lapVariance = lapSqSum / Math.max(1, count) - lapMean * lapMean;

    if (variance < 280) return { quality: 'poor', score: Math.round(lapVariance) };
    if (lapVariance < BLUR_THRESHOLD) return { quality: 'poor', score: Math.round(lapVariance) };
    if (lapVariance < FAIR_THRESHOLD) return { quality: 'fair', score: Math.round(lapVariance) };
    return { quality: 'good', score: Math.round(lapVariance) };
  }

  function createCard(entry, index) {
    const card = document.createElement('article');
    card.className = `cabeku-photo ${entry.quality}`;
    card.dataset.key = fileKey(entry.file);
    const img = document.createElement('img');
    img.alt = `Foto tanaman cabai ${index + 1}`;
    img.src = entry.url;
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'remove';
    remove.setAttribute('aria-label', `Hapus foto ${index + 1}`);
    remove.textContent = '×';
    remove.addEventListener('click', () => {
      const key = fileKey(entry.file);
      state.files = state.files.filter((item) => fileKey(item.file) !== key);
      URL.revokeObjectURL(entry.url);
      syncInputFiles();
      renderGallery();
    });
    const meta = document.createElement('div');
    meta.className = 'meta';
    const name = document.createElement('span');
    name.textContent = `${index + 1}. ${entry.file.name.length > 18 ? `${entry.file.name.slice(0, 15)}…` : entry.file.name}`;
    const quality = document.createElement('span');
    quality.className = 'quality';
    quality.textContent = entry.quality === 'good' ? 'Jelas' : entry.quality === 'fair' ? 'Cukup' : 'Blur';
    meta.append(name, quality);
    const scanState = document.createElement('div');
    scanState.className = `scan-state${entry.error ? ' error' : ''}`;
    scanState.textContent = entry.error || `${formatSize(entry.file.size)} • fokus ${entry.score}`;
    card.append(img, remove, meta, scanState);
    return card;
  }

  function renderGallery() {
    gallery.replaceChildren();
    state.files.forEach((entry, index) => gallery.append(createCard(entry, index)));
    const count = state.files.length;
    if (!count) {
      setStatus('Belum ada foto. Tambahkan 1–5 foto untuk pemeriksaan AI.');
      return;
    }
    const poor = state.files.filter((entry) => entry.quality === 'poor').length;
    setStatus(`${count}/5 foto dipilih${poor ? ` • ${poor} foto blur/kurang layak, sebaiknya dihapus` : ' • semua foto siap diperiksa'}.`);
  }

  async function addFiles(fileList) {
    const incoming = Array.from(fileList || []);
    if (!incoming.length) return;
    const known = new Set(state.files.map((entry) => fileKey(entry.file)));
    const candidates = [];
    for (const file of incoming) {
      if (!ACCEPTED.has(file.type)) { setStatus('Ada file yang ditolak: hanya JPG, PNG, atau WebP.'); continue; }
      if (file.size > MAX_FILE_BYTES) { setStatus('Ada foto lebih dari 8 MB dan tidak ditambahkan.'); continue; }
      if (known.has(fileKey(file))) continue;
      known.add(fileKey(file));
      candidates.push(file);
    }
    if (state.files.length + candidates.length > MAX_PHOTOS) {
      candidates.splice(MAX_PHOTOS - state.files.length);
      setStatus('Maksimal 5 foto per pemeriksaan.');
    }

    for (const file of candidates) {
      try {
        const quality = await qualityOf(file);
        state.files.push({ file, ...quality, url: URL.createObjectURL(file), error: '' });
      } catch (error) {
        state.files.push({ file, quality: 'poor', score: 0, url: URL.createObjectURL(file), error: error instanceof Error ? error.message : 'Foto gagal dianalisis.' });
      }
    }
    syncInputFiles();
    renderGallery();
  }

  function selectedContext() {
    const hstRaw = $('#hst')?.value.trim() || '';
    const hst = hstRaw === '' ? null : Number(hstRaw);
    return {
      hst: Number.isFinite(hst) ? hst : null,
      soil: $('#soil')?.value || '',
      fertilization: $('#fert')?.value || '',
      symptoms: [...document.querySelectorAll('.check input:checked')].map((node) => node.value),
    };
  }

  function showAIPlaceholder(text, note = '') {
    const card = $('#aiCard');
    const confidence = $('#aiConfidence');
    const observations = $('#aiObservations');
    const aiNote = $('#aiNote');
    if (!card || !confidence || !observations || !aiNote) return;
    card.hidden = false;
    confidence.textContent = text;
    observations.replaceChildren();
    const item = document.createElement('div');
    item.textContent = note || text;
    observations.append(item);
  }

  function renderOverall(reviews, skipped) {
    const heading = $('#result-heading');
    const summary = $('#summary');
    const list = $('#resultList');
    const badge = $('#badge');
    const bar = $('#scoreBar');
    const complete = $('#completenessText');
    const next = $('#nextStep');
    const aiConfidence = $('#aiConfidence');
    const aiObs = $('#aiObservations');
    const aiNote = $('#aiNote');
    const aiCard = $('#aiCard');
    if (!heading || !summary || !list || !badge || !bar || !complete || !next || !aiConfidence || !aiObs || !aiNote || !aiCard) return;

    const worst = reviews.reduce((current, item) => severity[item.status] > severity[current.status] ? item : current, { status: 'Sehat', confidence: 0 });
    const overallStatus = worst.status;
    const avgConfidence = reviews.length ? Math.round(reviews.reduce((sum, item) => sum + Number(item.confidence || 0), 0) / reviews.length) : 0;
    const goodCount = state.files.filter((entry) => entry.quality !== 'poor').length;
    const qualityPercent = state.files.length ? Math.round((goodCount / state.files.length) * 100) : 0;

    heading.textContent = overallStatus === 'Perlu Pemeriksaan' ? 'Perlu pemeriksaan' : overallStatus === 'Perlu Diamati' ? 'Perlu diamati' : overallStatus === 'Data Belum Cukup' ? 'Data belum cukup' : 'Sehat / relatif stabil';
    summary.textContent = `Kesimpulan digabung dari ${reviews.length} foto layak diperiksa${skipped ? `; ${skipped} foto blur tidak dikirim ke AI` : ''}.`;
    badge.style.display = 'inline-flex';
    badge.className = `badge ${overallStatus === 'Sehat' ? 'b-ok' : overallStatus === 'Perlu Diamati' ? 'b-warn' : overallStatus === 'Perlu Pemeriksaan' ? 'b-risk' : 'b-data'}`;
    badge.textContent = overallStatus.toUpperCase();
    bar.style.width = `${Math.max(0, Math.min(100, avgConfidence || qualityPercent))}%`;
    complete.textContent = `${qualityPercent}% foto layak + data`; 

    list.replaceChildren();
    reviews.forEach((review, index) => {
      const row = document.createElement('div');
      row.className = 'result-item';
      const title = document.createElement('b');
      title.textContent = `Foto ${index + 1} • ${review.status}`;
      const detail = document.createElement('span');
      detail.textContent = review.conclusion || 'Tidak ada kesimpulan tambahan.';
      row.append(title, detail);
      list.append(row);
    });

    aiCard.hidden = false;
    aiConfidence.textContent = `${reviews.length} foto • keyakinan rata-rata ${avgConfidence}%`;
    aiObs.replaceChildren();
    const observations = [...new Set(reviews.flatMap((review) => Array.isArray(review.observations) ? review.observations.map(String) : []))].slice(0, 8);
    if (!observations.length) {
      const item = document.createElement('div');
      item.textContent = 'AI tidak menemukan observasi visual tambahan yang cukup kuat.';
      aiObs.append(item);
    } else {
      observations.forEach((text) => { const item = document.createElement('div'); item.textContent = text; aiObs.append(item); });
    }
    aiNote.textContent = reviews.map((review) => review.caution).filter(Boolean).slice(0, 2).join(' ');
    next.textContent = overallStatus === 'Perlu Pemeriksaan'
      ? 'Ada foto yang menunjukkan pola visual yang perlu diperiksa di lapangan. Cocokkan dengan SOP resmi sebelum menentukan perlakuan.'
      : overallStatus === 'Data Belum Cukup'
        ? 'Tambah foto yang lebih dekat, terang, dan fokus; jangan gunakan hasil ini untuk menentukan dosis.'
        : overallStatus === 'Perlu Diamati'
          ? 'Pantau perubahan tanaman dan ulangi dokumentasi bila gejala berubah atau meluas.'
          : 'Simpan hasil ini sebagai baseline pemantauan berikutnya.';
  }

  function collectHistoryStatus(status) {
    try {
      const key = 'cabeku.scanHistory.v2';
      const current = JSON.parse(localStorage.getItem(key) || '[]');
      const hstRaw = $('#hst')?.value.trim() || '';
      current.unshift({ status, hst: hstRaw === '' ? null : Number(hstRaw), date: new Intl.DateTimeFormat('id-ID', { dateStyle: 'short', timeStyle: 'short' }).format(new Date()) });
      localStorage.setItem(key, JSON.stringify(current.slice(0, 12)));
    } catch {}
  }

  input.addEventListener('change', async () => {
    await addFiles(input.files);
  });

  upload.addEventListener('click', (event) => {
    if (event.target === upload || event.target.matches('strong,span')) input.click();
  });

  upload.addEventListener('dragover', (event) => {
    event.preventDefault();
    upload.classList.add('drag');
  });
  upload.addEventListener('dragleave', () => upload.classList.remove('drag'));
  upload.addEventListener('drop', async (event) => {
    event.preventDefault();
    upload.classList.remove('drag');
    await addFiles(event.dataTransfer.files);
  });

  scan.addEventListener('click', async () => {
    if (state.scanning) return;
    if (!state.files.length) {
      showAIPlaceholder('Foto belum tersedia', 'Tambahkan minimal 1 foto tanaman cabai.');
      return;
    }
    const usable = state.files.filter((entry) => entry.quality !== 'poor');
    const skipped = state.files.length - usable.length;
    if (!usable.length) {
      showAIPlaceholder('Semua foto blur', 'Hapus foto blur lalu tambahkan foto yang lebih fokus dan terang.');
      return;
    }

    state.scanning = true;
    scan.disabled = true;
    scan.innerHTML = '<span class="loading"><span class="dot"></span> Memeriksa foto…</span>';
    const reviews = [];
    const context = selectedContext();
    setStatus(`0/${usable.length} foto sedang dikirim ke AI…`);

    for (let i = 0; i < usable.length; i += 1) {
      const entry = usable[i];
      try {
        const form = await (async () => {
          const url = URL.createObjectURL(entry.file);
          try {
            const img = await new Promise((resolve, reject) => {
              const node = new Image();
              node.onload = () => resolve(node);
              node.onerror = () => reject(new Error('Foto tidak dapat dibaca.'));
              node.src = url;
            });
            const max = 1280;
            const scale = Math.min(1, max / Math.max(img.naturalWidth, img.naturalHeight));
            const canvas = document.createElement('canvas');
            canvas.width = Math.max(1, Math.round(img.naturalWidth * scale));
            canvas.height = Math.max(1, Math.round(img.naturalHeight * scale));
            const ctx = canvas.getContext('2d');
            if (!ctx) throw new Error('Canvas tidak tersedia.');
            ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
            return canvas.toDataURL('image/jpeg', 0.78);
          } finally { URL.revokeObjectURL(url); }
        })();

        const response = await fetch('/api/cabeku-scan', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ imageDataUrl: form, context }),
        });
        let data = null;
        try { data = await response.json(); } catch { throw new Error('Respons server tidak valid.'); }
        if (!response.ok || !data?.ok || !data.review) throw new Error(data?.error || 'Pemeriksaan foto gagal.');
        reviews.push(data.review);
        setStatus(`${i + 1}/${usable.length} foto selesai diperiksa…`);
      } catch (error) {
        entry.error = error instanceof Error ? error.message : 'Pemeriksaan foto gagal.';
        renderGallery();
        setStatus(`Foto ${i + 1} gagal diperiksa; proses foto lain dilanjutkan.`);
      }
    }

    if (reviews.length) {
      renderOverall(reviews, skipped);
      const worst = reviews.reduce((current, item) => severity[item.status] > severity[current.status] ? item : current, reviews[0]);
      collectHistoryStatus(worst.status);
      setStatus(`Selesai: ${reviews.length} foto diperiksa${skipped ? `, ${skipped} foto blur dilewati` : ''}.`);
    } else {
      showAIPlaceholder('Pemeriksaan gagal', 'Tidak ada foto yang berhasil diproses. Coba satu foto yang jelas terlebih dahulu.');
      setStatus('Tidak ada hasil AI yang berhasil.');
    }

    scan.disabled = false;
    scan.textContent = 'Periksa kondisi tanaman';
    state.scanning = false;
  });

  renderGallery();
})();
