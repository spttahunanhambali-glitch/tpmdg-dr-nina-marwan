interface Env {
  ASSETS: { fetch(request: Request): Promise<Response> };
  AI: { run(model: string, input: Record<string, unknown>): Promise<unknown> };
}

type ScanBody = { imageDataUrl?: unknown; context?: { hst?: unknown; soil?: unknown; fertilization?: unknown; symptoms?: unknown } };
const MODEL = "@cf/meta/llama-4-scout-17b-16e-instruct";
const MAX_BASE64_CHARS = 7_000_000;
const ALLOWED_MIME = new Set(["image/jpeg", "image/png", "image/webp"]);
const ALLOWED_STATUS = new Set(["Sehat", "Perlu Diamati", "Perlu Pemeriksaan", "Data Belum Cukup"]);

function json(data: unknown, status = 200) { return Response.json(data, { status, headers: { "Cache-Control": "no-store" } }); }
function validateImageDataUrl(value: unknown): value is string {
  if (typeof value !== "string" || value.length < 30 || value.length > MAX_BASE64_CHARS) return false;
  const m = /^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/=]+)$/.exec(value);
  return Boolean(m && ALLOWED_MIME.has(m[1]));
}
function clampConfidence(value: unknown) { const n = Number(value); return Number.isFinite(n) ? Math.max(0, Math.min(100, Math.round(n))) : 0; }
function list(value: unknown, max: number, len: number) { return Array.isArray(value) ? value.filter((x): x is string => typeof x === "string").map(x => x.trim().slice(0, len)).filter(Boolean).slice(0, max) : []; }
function sanitize(value: unknown) {
  const x = value && typeof value === "object" ? value as Record<string, unknown> : {};
  const status = typeof x.status === "string" && ALLOWED_STATUS.has(x.status) ? x.status : "Data Belum Cukup";
  const quality = x.photo_quality === "good" || x.photo_quality === "fair" || x.photo_quality === "poor" ? x.photo_quality : "poor";
  return { photo_quality: quality, status, confidence: clampConfidence(x.confidence), observations: list(x.observations, 6, 220), caution: typeof x.caution === "string" ? x.caution.trim().slice(0, 500) : "Hasil ini adalah pemeriksaan visual awal dan bukan diagnosis penyakit.", next_steps: list(x.next_steps, 5, 220) };
}
function prompt(body: ScanBody) {
  const c = body.context && typeof body.context === "object" ? body.context : {};
  const symptoms = Array.isArray(c.symptoms) ? c.symptoms.filter((x): x is string => typeof x === "string").slice(0, 10) : [];
  return [
    "Anda adalah Cabeku, modul pemeriksaan visual awal tanaman cabai untuk petani Indonesia.",
    "Amati foto secara konservatif dan hanya tuliskan hal yang benar-benar terlihat.",
    "Jangan mendiagnosis penyakit, jangan menyebut patogen sebagai kepastian, dan jangan memberi dosis pupuk atau pestisida.",
    "Gunakan tepat satu status: Sehat, Perlu Diamati, Perlu Pemeriksaan, Data Belum Cukup.",
    "Gunakan Data Belum Cukup bila foto buram, gelap, objek tidak jelas, atau bagian penting tanaman tidak terlihat.",
    "Kembalikan JSON saja dengan photo_quality, status, confidence, observations, caution, next_steps.",
    `Data pengguna: HST=${String(c.hst ?? "tidak diisi")}; tanah=${String(c.soil ?? "tidak diisi")}; pupuk=${String(c.fertilization ?? "tidak diisi")}; tanda=${symptoms.join(", ") || "tidak ada"}.`
  ].join("\n");
}
async function scan(request: Request, env: Env): Promise<Response> {
  if (request.method !== "POST") return json({ error: "Method not allowed" }, 405);
  let body: ScanBody; try { body = await request.json() as ScanBody; } catch { return json({ error: "Format data tidak valid." }, 400); }
  if (!validateImageDataUrl(body.imageDataUrl)) return json({ error: "Foto tidak valid. Gunakan JPG, PNG, atau WebP." }, 400);
  try {
    const result = await env.AI.run(MODEL, { prompt: prompt(body), image: body.imageDataUrl, max_tokens: 700, temperature: 0.1, response_format: { type: "json_object" } });
    const r = result && typeof result === "object" ? result as Record<string, unknown> : {};
    const raw = typeof result === "string" ? result : typeof r.response === "string" ? r.response : typeof r.result === "string" ? r.result : "";
    if (!raw) return json({ error: "Model tidak mengembalikan hasil." }, 502);
    let parsed: unknown; try { parsed = JSON.parse(raw); } catch { return json({ error: "Hasil AI tidak berbentuk JSON yang valid." }, 502); }
    const review = sanitize(parsed);
    if (review.photo_quality === "poor") { review.status = "Data Belum Cukup"; review.confidence = Math.min(review.confidence, 45); }
    return json({ ok: true, review });
  } catch (error) { console.error("Cabeku AI error", error); return json({ error: "Pemeriksaan foto gagal diproses. Coba lagi." }, 500); }
}

const BRIDGE = String.raw`<script>
(() => {
  const btn=document.querySelector('#scanBtn'), input=document.querySelector('#photo'); if(!btn||!input)return;
  const text=(sel,v)=>{const e=document.querySelector(sel);if(e)e.textContent=v};
  const item=(t,v)=>{const l=document.querySelector('#resultList');if(!l)return;const d=document.createElement('div');d.className='result-item';const b=document.createElement('b');b.textContent=t;const s=document.createElement('span');s.textContent=v;d.append(b,s);l.append(d)};
  const compress=f=>new Promise((res,rej)=>{const u=URL.createObjectURL(f),i=new Image();i.onload=()=>{URL.revokeObjectURL(u);const m=1400,s=Math.min(1,m/Math.max(i.naturalWidth,i.naturalHeight)),c=document.createElement('canvas');c.width=Math.max(1,Math.round(i.naturalWidth*s));c.height=Math.max(1,Math.round(i.naturalHeight*s));const x=c.getContext('2d');if(!x)return rej(new Error('Canvas tidak tersedia.'));x.drawImage(i,0,0,c.width,c.height);res(c.toDataURL('image/jpeg',.82))};i.onerror=()=>{URL.revokeObjectURL(u);rej(new Error('Foto tidak dapat dibaca.'))};i.src=u});
  btn.addEventListener('click',async e=>{e.preventDefault();e.stopImmediatePropagation();const f=input.files?.[0];if(!f){alert('Silakan pilih foto tanaman terlebih dahulu.');return}btn.disabled=true;btn.textContent='Menganalisis foto…';text('#result-heading','Sedang diperiksa');text('#summary','Cabeku sedang membaca kondisi visual foto.');try{const data=await compress(f),sym=[...document.querySelectorAll('.check input:checked')].map(x=>x.value),r=await fetch('/api/cabeku-scan',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({imageDataUrl:data,context:{hst:document.querySelector('#hst')?.value||null,soil:document.querySelector('#soil')?.value||null,fertilization:document.querySelector('#fert')?.value||null,symptoms:sym}})}),p=await r.json().catch(()=>({}));if(!r.ok||!p.ok)throw new Error(p.error||'Pemeriksaan gagal.');const v=p.review,l=document.querySelector('#resultList');if(l)l.replaceChildren();text('#result-heading',v.status);text('#summary',v.caution||'Hasil pemeriksaan visual awal.');const bar=document.querySelector('#scoreBar');if(bar)bar.style.width=(Number(v.confidence)||0)+'%';text('#completenessText','AI '+(Number(v.confidence)||0)+'%');item('Kualitas foto',v.photo_quality);(v.observations||[]).forEach(x=>item('Observasi visual',x));(v.next_steps||[]).forEach(x=>item('Langkah berikutnya',x));text('#nextStep',v.next_steps?.[0]||'Lanjutkan pemantauan dan cocokkan dengan SOP resmi.');btn.textContent='Periksa ulang foto'}catch(err){text('#result-heading','Pemeriksaan gagal');text('#summary',err instanceof Error?err.message:'Pemeriksaan foto gagal diproses.');text('#nextStep','Periksa koneksi lalu coba lagi.');btn.textContent='Periksa kondisi tanaman'}finally{btn.disabled=false}},true)
})();
</script>`;

async function serveCabeku(request: Request, env: Env) {
  const u = new URL('/serba-serbi/cabeku/index.html', request.url);
  const response = await env.ASSETS.fetch(new Request(u, request));
  if (!response.ok) return new Response('Cabeku page asset tidak ditemukan.', { status: 404, headers: { 'content-type': 'text/plain; charset=utf-8' } });
  return new HTMLRewriter().on('body', { end(el) { el.before(BRIDGE, { html: true }); } }).transform(response);
}

export default {
  async fetch(request: Request, env: Env) {
    const p = new URL(request.url).pathname;
    if (p === '/api/cabeku-scan') return scan(request, env);
    if (p.startsWith('/api/')) return json({ error: 'API endpoint tidak ditemukan.' }, 404);
    if (p === '/serba-serbi/cabeku' || p === '/serba-serbi/cabeku/' || p === '/serba-serbi/cabeku/index.html' || p === '/cabeku' || p === '/cabeku/') return serveCabeku(request, env);
    return env.ASSETS.fetch(request);
  }
} satisfies ExportedHandler<Env>;
